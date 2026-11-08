/**
 * Bounded tool-output spill storage.
 *
 * Inspired by DeepSeek Harness's MIT `spill` package (see
 * `research/vendor/deepseek-harness/packages/spill` in a local checkout), but
 * implemented locally without its plugin/service architecture: one private
 * directory of one file per spill, an opaque random id, and a chunked reader.
 *
 * The contract is deliberately small:
 * - `save` persists the FULL text verbatim under `<root>/<id>.txt` (temp file
 *   then rename, best-effort fsync) and returns the id and character count.
 * - `read` validates the id against `[a-f0-9]{16,64}`, resolves it under the
 *   root, and returns at most `SPILL_READ_MAX_CHARS` (16 KiB) per call. A
 *   caller can never turn an id into an arbitrary path.
 * - The model-facing preview is a bounded head+tail window plus one
 *   `[[SPILL id=… chars=…]]` marker and one `spill_read` instruction line.
 *
 * Spill files are local trusted data (they are tool output, not secrets), but
 * the marker never carries a filesystem path. Retention is the operator's:
 * files persist until `<root>` is deleted. This module does not scan, follow
 * links or read anything except a validated `<root>/<id>.txt`.
 *
 * Everything here is dependency-free (Node built-ins only) and fail-soft at
 * the call site: `save` rejects on a real storage failure and the harness falls
 * back to its existing clipped result.
 */
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/** Default inline budget for a plain-text tool result (characters). */
export const SPILL_DEFAULT_MAX_INLINE_CHARS = 20_000;

/** Hard cap on one `read` chunk (16 KiB), matching the MCP output budget. */
export const SPILL_READ_MAX_CHARS = 16 * 1024;

/** A spill id is random lowercase hex; anything else is rejected before use. */
export const SPILL_ID_PATTERN = /^[a-f0-9]{16,64}$/;

/** Marker that replaces an oversized result's body in the model context. */
export const SPILL_MARKER_PREFIX = "[[SPILL id=";

/** The built-in retrieval tool's model-facing name. */
export const SPILL_READ_TOOL_NAME = "spill_read";

/**
 * One sentence for the tool catalogue. Deliberately one line so the
 * `## Available tools` prompt section stays compact.
 */
export const SPILL_READ_TOOL_DESCRIPTION =
  "Read a chunk of a spilled tool result by id (offset and max_chars are characters; chunks are capped at 16 KiB).";

/**
 * Model-facing JSON Schema for `spill_read`. The id is the only required
 * field; offset defaults to 0 and max_chars to the configured read budget.
 */
export const SPILL_READ_TOOL_PARAMETERS: Record<string, unknown> = {
  type: "object",
  properties: {
    id: {
      type: "string",
      description: "Spill id from a [[SPILL id=... chars=...]] marker.",
    },
    offset: {
      type: "integer",
      minimum: 0,
      default: 0,
      description: "Character offset to start reading from.",
    },
    max_chars: {
      type: "integer",
      minimum: 1,
      maximum: SPILL_READ_MAX_CHARS,
      default: SPILL_READ_MAX_CHARS,
      description: "Maximum characters to return (hard-capped at 16 KiB).",
    },
  },
  required: ["id"],
  additionalProperties: false,
};

/**
 * Descriptive save context. It is not part of the file name or access model
 * (the random id is the only handle); it exists so callers can describe a
 * spill for diagnostics and future retention policies without changing the
 * storage contract.
 */
export interface SpillContext {
  /** Session that produced the result. */
  session?: string;
  /** Tool whose result was spilled. */
  tool?: string;
  /** Model-issued tool call id, when known. */
  callId?: string;
  /** Short label such as `result`. */
  label?: string;
}

/** The harness-facing spill configuration. */
export interface SpillOptions {
  /** Private spill directory, created lazily on the first save. */
  root: string;
  /** Inline budget; results at or under it are returned unchanged. Default 20,000. */
  maxInlineChars?: number;
  /** Requested read chunk size; capped by {@link SPILL_READ_MAX_CHARS}. Default 16 KiB. */
  maxReadChars?: number;
}

/** One saved spill artifact. */
export interface SavedSpill {
  /** Opaque random id (`[a-f0-9]{16,64}`). */
  id: string;
  /** Absolute path of the saved text file (never exposed in a model marker). */
  path: string;
  /** Length of the saved text in UTF-16 code units (the same unit `read` slices). */
  chars: number;
}

/** Options for one `SpillStore.read` call. */
export interface SpillReadOptions {
  /** Character offset; negative/non-finite values clamp to 0. */
  offset?: number;
  /** Requested chunk size; clamped to 1..{@link SPILL_READ_MAX_CHARS}. */
  maxChars?: number;
}

/** One bounded read chunk plus enough metadata to continue. */
export interface SpillChunk {
  id: string;
  /** The requested slice (at most {@link SPILL_READ_MAX_CHARS} characters). */
  text: string;
  /** Effective character offset of `text` in the full artifact. */
  offset: number;
  /** Offset to pass to the next `read` call; equals `offset + text.length`. */
  nextOffset: number;
  /** Total characters in the full artifact. */
  totalChars: number;
  /** True when `nextOffset >= totalChars`. */
  eof: boolean;
}

/** Result of {@link spillPreview}. */
export interface SpillPreview {
  /** The bounded model-facing text (the original text when nothing spilled). */
  text: string;
  /** True when a spill file was written and the marker appended. */
  spilled: boolean;
  /** The saved artifact, or null when the text stayed inline. */
  saved: SavedSpill | null;
}

/** Options for {@link spillPreview}; `root` belongs to the store, not here. */
export interface SpillPreviewOptions {
  maxInlineChars?: number;
  maxReadChars?: number;
}

/** Clamp a positive integer setting to its default when absent/invalid. */
function positiveInt(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number.NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

/** Effective inline budget. */
export function spillInlineBudget(options: SpillPreviewOptions = {}): number {
  return positiveInt(options.maxInlineChars, SPILL_DEFAULT_MAX_INLINE_CHARS);
}

/** Effective read chunk size, hard-capped at {@link SPILL_READ_MAX_CHARS}. */
export function spillReadBudget(options: SpillPreviewOptions = {}): number {
  return Math.min(positiveInt(options.maxReadChars, SPILL_READ_MAX_CHARS), SPILL_READ_MAX_CHARS);
}

/** Validate an id and return it; throws on anything that is not random hex. */
export function assertSpillId(id: unknown): string {
  if (typeof id !== "string" || !SPILL_ID_PATTERN.test(id)) {
    throw new Error("invalid spill id (expected 16-64 lowercase hex characters)");
  }
  return id;
}

/** True when a string already carries a spill marker (avoid double spill). */
export function isSpilledText(text: string): boolean {
  return text.includes(SPILL_MARKER_PREFIX);
}

/** The model-facing marker for one saved artifact. Carries no path. */
export function spillMarker(id: string, chars: number): string {
  return `[[SPILL id=${id} chars=${chars}]]`;
}

/** The single instruction line that follows a spill preview. */
export function spillInstruction(id: string, maxReadChars: number): string {
  return `Full output saved; read it in chunks with spill_read {"id":"${id}","offset":0,"max_chars":${maxReadChars}}.`;
}

/**
 * Save an oversized text and return a bounded preview plus the marker and one
 * instruction line. Text at or under the budget is returned untouched (no
 * file, no marker), so small results stay byte-identical. Storage failures
 * reject; the caller decides how to fall back.
 */
export async function spillPreview(
  text: string,
  store: SpillStore,
  context: SpillContext = {},
  options: SpillPreviewOptions = {},
): Promise<SpillPreview> {
  const maxInline = spillInlineBudget(options);
  if (text.length <= maxInline) return { text, spilled: false, saved: null };
  const saved = await store.save(text, context);
  const marker = spillMarker(saved.id, saved.chars);
  const instruction = spillInstruction(saved.id, spillReadBudget(options));
  // Reserve room for the marker + instruction so the model-facing result stays
  // near the configured budget instead of budget + metadata.
  const overhead = marker.length + instruction.length + 5; // joins + gap newline
  const previewBudget = Math.max(1, maxInline - overhead);
  const headLen = Math.ceil(previewBudget / 2);
  const tailLen = Math.floor(previewBudget / 2);
  // Head then tail; the marker below is the explicit sign that the middle was
  // omitted and the full text is on disk.
  const preview = text.slice(0, headLen) + "\n" + text.slice(text.length - tailLen);
  return {
    text: `${preview}\n\n${marker}\n${instruction}`,
    spilled: true,
    saved,
  };
}

/**
 * Render one `spill_read` chunk. A full (non-truncated) read is returned as
 * the artifact text alone so callers can inspect it byte-for-byte; a partial
 * read gets a header and, when more remains, one continuation line.
 */
export function formatSpillRead(chunk: SpillChunk, maxReadChars: number = SPILL_READ_MAX_CHARS): string {
  if (chunk.totalChars === 0) return "(empty spill)";
  if (chunk.offset === 0 && chunk.eof) return chunk.text;
  const header =
    `[[SPILL_READ id=${chunk.id} offset=${chunk.offset} ` +
    `next=${chunk.nextOffset} total=${chunk.totalChars}]]`;
  if (chunk.eof) return `${header}\n${chunk.text}`;
  return (
    `${header}\n${chunk.text}\n\n` +
    `Continue with spill_read {"id":"${chunk.id}","offset":${chunk.nextOffset},"max_chars":${maxReadChars}}.`
  );
}

/**
 * One private directory of spill files. The store is intentionally stateless:
 * every read validates the id and resolves it under the configured root, so a
 * model can never supply a path.
 */
export class SpillStore {
  /** Absolute private root. Files are created lazily on the first save. */
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  /** Resolve a validated id to its file path, refusing anything outside the root. */
  private filePath(id: string): string {
    const valid = assertSpillId(id);
    const file = path.resolve(this.root, `${valid}.txt`);
    const prefix = this.root.endsWith(path.sep) ? this.root : `${this.root}${path.sep}`;
    if (!file.startsWith(prefix)) {
      throw new Error("invalid spill path");
    }
    return file;
  }

  /**
   * Persist `text` verbatim under a fresh random id. Writes a temp file with
   * owner-only permissions, best-effort fsyncs it, then renames it into place.
   * Rejects on a real storage failure (the harness then clips as before).
   */
  async save(text: string, context: SpillContext = {}): Promise<SavedSpill> {
    void context; // descriptive only; the random id is the storage handle
    const content = String(text);
    await fs.promises.mkdir(this.root, { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const id = randomBytes(16).toString("hex");
      const target = this.filePath(id);
      const temp = path.join(this.root, `.tmp-${id}`);
      try {
        if (fs.existsSync(target)) continue;
        const handle = await fs.promises.open(temp, "wx", 0o600);
        try {
          await handle.writeFile(content, "utf8");
          // The rename below is the durability point for the file's name; the
          // fsync is best-effort because some filesystems reject it.
          await handle.sync().catch(() => undefined);
        } finally {
          await handle.close();
        }
        await fs.promises.rename(temp, target);
        return { id, path: target, chars: content.length };
      } catch (exc) {
        await fs.promises.rm(temp, { force: true }).catch(() => undefined);
        if ((exc as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw exc;
      }
    }
    throw new Error("could not allocate a unique spill id");
  }

  /**
   * Read one bounded chunk from a saved artifact. Validates the id, clamps the
   * offset and chunk size, and returns the total/next offsets for continuation.
   */
  async read(id: string, options: SpillReadOptions = {}): Promise<SpillChunk> {
    const valid = assertSpillId(id);
    const file = this.filePath(valid);
    const full = await fs.promises.readFile(file, "utf8");
    const totalChars = full.length;
    const rawOffset = Number(options.offset ?? 0);
    const offset = Math.min(
      totalChars,
      Number.isFinite(rawOffset) ? Math.max(0, Math.trunc(rawOffset)) : 0,
    );
    const requested = options.maxChars === undefined ? SPILL_READ_MAX_CHARS : options.maxChars;
    const maxChars = Math.min(
      SPILL_READ_MAX_CHARS,
      Math.max(1, Number.isFinite(Number(requested)) ? Math.trunc(Number(requested)) : SPILL_READ_MAX_CHARS),
    );
    const end = Math.min(totalChars, offset + maxChars);
    const text = full.slice(offset, end);
    return {
      id: valid,
      text,
      offset,
      nextOffset: end,
      totalChars,
      eof: end >= totalChars,
    };
  }
}
