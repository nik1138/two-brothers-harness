/**
 * Session fork by copy: branch a cooperation session at an envelope boundary.
 *
 * The session format is a linear JSONL log with dense, protocol-owned `seq`
 * numbering, so a tree is deliberately not modelled. A fork is a plain copy of
 * the source's first `atSeq` envelopes into a NEW `<sessionsDir>/<name>.jsonl`
 * (the copied prefix keeps the source file's RAW BYTES through the last copied
 * envelope — CRLF terminators, spacing and blank lines included — and `seq` is
 * preserved, so the numbering stays dense) plus an additive local `.meta.json`
 * lineage link `{parent: {name, seq}}` and a derived title. The source file is
 * only ever read.
 *
 * One source read backs the whole fork: the same text yields both the copied
 * bytes and the envelope snapshot the cut/title/parent seq are derived from, so
 * the copied prefix can never disagree with the recorded lineage. A stat guard
 * around that read refuses a source replaced between the stat and the read
 * (including same-length replacements a size-only check would miss).
 *
 * Crash-torn sources are tolerated exactly like `SessionStore.load()`: an
 * UNTERMINATED final fragment with no parseable JSON object is a crash
 * mid-append, so it is dropped and the fork copies only the complete envelope
 * prefix (byte-exactly, source never rewritten). Interior corruption and a
 * newline-terminated bad record still fail as `source-unreadable`. A valid
 * final envelope without its trailing newline is not corruption and is copied
 * as-is.
 *
 * A full fork of an empty session is allowed (a valid empty session file and
 * `parent.seq: 0`); an explicit `atSeq` must name an existing envelope.
 *
 * Fork target names are single portable file names: no path separators, no
 * characters Windows rejects, no Windows reserved device names (`CON`, `NUL`,
 * `COM1`..`COM9`, `LPT1`..`LPT9`, with or without extension, case-insensitive)
 * and a bounded stem length (`SESSION_NAME_MAX_CHARS`). Validation fails with
 * the typed `invalid-name` code instead of a later write error.
 *
 * If the metadata sidecar cannot be written, the fork is rolled back: the
 * copied JSONL AND any partial sidecar are removed best-effort and the thrown
 * `write-failed` message states truthfully whether each removal succeeded, so a
 * failed fork neither leaves an orphan session nor permanently blocks the name.
 *
 * Consumers: `POST /api/sessions/{name}/fork` (server) and
 * `sessions fork` (CLI). Failures are typed via `SessionForkError.code` so the
 * surfaces can answer with honest 400/404/422 statuses instead of guessing.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import {
  deriveForkTitle,
  deriveTitle,
  isWindowsReservedDeviceName,
  SessionMetadataStore,
  SESSION_NAME_MAX_CHARS,
  type SessionParentLink,
} from "./metadata.ts";
import type { Message } from "./protocol.ts";
import { SessionStore } from "./session.ts";
import { GLOBAL_PROJECT_KEY, SessionLayout } from "./sessionlayout.ts";

/** Suffix of a session file (the only file the fork writes). */
const JSONL_SUFFIX = ".jsonl";
/** Suffix of the metadata sidecar next to a session file. */
const META_SUFFIX = ".meta.json";
/** Suffix of the runtime-event sidecar (`<sessionsDir>/runtime/`). */
const RUNTIME_EVENTS_SUFFIX = ".events.jsonl";
/** Infix of generated fork names: `<source stem>-fork-<k>`. */
const FORK_NAME_INFIX = "-fork-";
/** Upper bound on generated-name probes before giving up honestly. */
const MAX_FORK_NAME_ATTEMPTS = 10_000;
/** Characters that are not portable in a file name on every supported platform. */
const INVALID_NAME_CHARS = /[<>:"|?*\u0000-\u001f]/;

/** Failure kind, so route/CLI callers can map it to a status or exit code. */
export type SessionForkErrorCode =
  | "invalid-name"
  | "invalid-seq"
  | "name-taken"
  | "source-missing"
  | "source-unreadable"
  | "write-failed";

/** Typed fork failure: the message is operator-facing and path-honest. */
export class SessionForkError extends Error {
  readonly code: SessionForkErrorCode;

  constructor(code: SessionForkErrorCode, message: string) {
    super(message);
    this.name = "SessionForkError";
    this.code = code;
  }
}

/** Options for `forkSession`; every field is optional (defaults are safe). */
export interface ForkSessionOptions {
  /** Last envelope `seq` to copy; default: the whole session. */
  atSeq?: number;
  /** Explicit new session name (with or without `.jsonl`). */
  name?: string;
  /** Explicit title; default: `<source title> (fork)`, bounded. */
  title?: string;
  /**
   * Test seam: replace the metadata-sidecar write (default:
   * `SessionMetadataStore.save`). Used to prove the rollback path and its
   * honest message without touching the real store.
   */
  metadataWriter?: (
    fileName: string,
    metadata: { title: string; parent: SessionParentLink },
  ) => Record<string, unknown>;
  /**
   * Test seam: invoked once between the source stat and the single content
   * read. A hook that replaces the file makes the stat guard refuse the fork,
   * which is how the same-length-replacement race is covered hermetically.
   */
  beforeSourceRead?: () => void;
}

/** What a fork wrote; field names match the HTTP contract. */
export interface ForkSessionResult {
  /** New session file name, including `.jsonl`. */
  name: string;
  /** Sidecar title actually saved. */
  title: string;
  /** Number of envelopes copied. */
  events: number;
  /** Lineage link also recorded in the new session's sidecar. */
  forked_from: SessionParentLink;
}

function messageOf(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

function isAlreadyExists(exc: unknown): boolean {
  return (
    typeof exc === "object" &&
    exc !== null &&
    (exc as { code?: unknown }).code === "EEXIST"
  );
}

/** Flatten a caller-supplied name to one path component (both separators). */
function flattenName(raw: string): string {
  return path.basename(raw.replace(/\\/g, "/"));
}

/** Drop a trailing `.jsonl` (case-sensitive, like the rest of the package). */
function stripJsonlSuffix(name: string): string {
  return name.endsWith(JSONL_SUFFIX) ? name.slice(0, -JSONL_SUFFIX.length) : name;
}

/** Canonical `<stem>.jsonl` for a caller-supplied SOURCE name. */
function sourceFileName(raw: string): string {
  const base = flattenName(typeof raw === "string" ? raw.trim() : "");
  if (!base || base === "." || base === "..") {
    throw new SessionForkError("invalid-name", "invalid session name");
  }
  return base.endsWith(JSONL_SUFFIX) ? base : base + JSONL_SUFFIX;
}

/**
 * Validate an explicit NEW session name and return its canonical file name.
 *
 * A fork target must stay a single portable file name inside the sessions
 * directory: no path separators (traversal is rejected, not silently
 * flattened), no `.`/`..`, no characters that are illegal on Windows, no
 * Windows reserved device name (`CON`, `PRN`, `AUX`, `NUL`, `COM1`..`COM9`,
 * `LPT1`..`LPT9`, with or without extension, case-insensitive — Windows would
 * reject the write after validation passed), a bounded stem length, and an
 * optional `.jsonl` suffix that is never doubled.
 */
export function forkFileName(raw: string): string {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) {
    throw new SessionForkError("invalid-name", "session name must not be empty");
  }
  if (trimmed === "." || trimmed === "..") {
    throw new SessionForkError("invalid-name", `invalid session name: ${trimmed}`);
  }
  if (/[\\/]/.test(trimmed)) {
    throw new SessionForkError(
      "invalid-name",
      "session name must not contain a path separator",
    );
  }
  if (INVALID_NAME_CHARS.test(trimmed)) {
    throw new SessionForkError(
      "invalid-name",
      "session name contains characters that are not portable across platforms",
    );
  }
  const stem = stripJsonlSuffix(trimmed);
  if (!stem || stem === "." || stem === "..") {
    throw new SessionForkError("invalid-name", `invalid session name: ${trimmed}`);
  }
  if (isWindowsReservedDeviceName(stem)) {
    throw new SessionForkError(
      "invalid-name",
      `session name is a reserved device name on Windows: ${stem}`,
    );
  }
  if (stem.length > SESSION_NAME_MAX_CHARS) {
    throw new SessionForkError(
      "invalid-name",
      `session name is too long (max ${SESSION_NAME_MAX_CHARS} characters before the .jsonl suffix)`,
    );
  }
  return stem + JSONL_SUFFIX;
}

/**
 * True when a new session with this file name would collide with anything the
 * app reads: an existing session in either layout, a leftover flat metadata or
 * runtime-event sidecar, or the target directory itself (an interrupted fork
 * can leave an empty directory that would otherwise block a later write).
 */
function forkNameTaken(
  layout: SessionLayout,
  sessionsDir: string,
  fileName: string,
  targetProjectKey: string | null,
): boolean {
  if (layout.resolve(fileName) !== null) return true;
  if (fs.existsSync(path.join(sessionsDir, stripJsonlSuffix(fileName) + META_SUFFIX))) return true;
  if (
    fs.existsSync(path.join(sessionsDir, "runtime", fileName + RUNTIME_EVENTS_SUFFIX))
  ) {
    return true;
  }
  if (targetProjectKey !== null) {
    return fs.existsSync(
      path.join(sessionsDir, targetProjectKey, stripJsonlSuffix(fileName)),
    );
  }
  return false;
}

/**
 * The protocol keeps `seq` dense (`1..N`), so "envelopes up to `atSeq`" is a
 * prefix. A source that breaks that invariant is rejected instead of forking a
 * different subset than the requested `seq` names.
 */
function assertDenseSeq(events: Message[]): void {
  for (let index = 0; index < events.length; index += 1) {
    const seq = events[index].seq;
    if (typeof seq !== "number" || !Number.isInteger(seq) || seq !== index + 1) {
      throw new SessionForkError(
        "source-unreadable",
        "session envelopes are not densely numbered; refusing to fork an inconsistent log",
      );
    }
  }
}

/** Resolve and validate the cut point; the default copies the whole session. */
function resolveCut(events: Message[], atSeq: number | undefined): number {
  if (atSeq === undefined) return events.length;
  if (
    typeof atSeq !== "number" ||
    !Number.isInteger(atSeq) ||
    atSeq < 1 ||
    atSeq > events.length
  ) {
    throw new SessionForkError(
      "invalid-seq",
      events.length === 0
        ? "at seq is out of range: the source session has no envelopes"
        : `at seq must be an integer between 1 and ${events.length}`,
    );
  }
  return atSeq;
}

/** One read of the source: the raw text plus the envelopes derived from it. */
interface SourceSnapshot {
  /** Whole file text, read exactly once. */
  text: string;
  /** Exclusive end offset of each envelope line in `text` (terminator included). */
  envelopeEnds: number[];
  events: Message[];
}

/** True when two stats describe the same file version (size, mtime, identity). */
function sameFileVersion(before: fs.Stats, after: fs.Stats): boolean {
  return (
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ino === after.ino
  );
}

/**
 * Split the raw source text into its envelope lines WITHOUT re-serializing:
 * `envelopeEnds[i]` is the exclusive end offset of the i-th non-blank line
 * (including its terminator), so slicing `text` at the cut end copies the
 * source's raw bytes exactly — CRLF terminators, spacing and blank lines
 * included. Parsing matches `SessionStore.load()` (trim, skip blank lines,
 * JSON objects only), INCLUDING its torn-tail rule: an unterminated final
 * fragment whose text is not parseable JSON is a crash mid-append and is
 * dropped (no event, no packet end), so only the complete prefix is copied.
 * A newline-terminated bad line, interior corruption, or a parseable
 * non-object still fail `source-unreadable`.
 */
function parseSourceSnapshot(
  text: string,
  sourcePath: string,
  sourceName: string,
): SourceSnapshot {
  const events: Message[] = [];
  const envelopeEnds: number[] = [];
  const parts = text.split(/(\r?\n)/);
  let offset = 0;
  let lineNumber = 0;
  for (let index = 0; index < parts.length; index += 2) {
    const content = parts[index] ?? "";
    const terminator = index + 1 < parts.length ? (parts[index + 1] ?? "") : "";
    offset += content.length + terminator.length;
    lineNumber += 1;
    const line = content.trim();
    if (!line) continue;
    // Only the last split element can be missing its terminator: an
    // unterminated final fragment (a crash mid-append) is recoverable.
    const isTornTail = terminator === "" && index === parts.length - 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (exc) {
      if (isTornTail) continue;
      throw new SessionForkError(
        "source-unreadable",
        `cannot read session ${sourceName}: corrupt session file ${sourcePath}, ` +
          `line ${lineNumber}: ${messageOf(exc)}`,
      );
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new SessionForkError(
        "source-unreadable",
        `cannot read session ${sourceName}: corrupt session file ${sourcePath}, ` +
          `line ${lineNumber}: expected a JSON object`,
      );
    }
    events.push(parsed as Message);
    envelopeEnds.push(offset);
  }
  return { text, envelopeEnds, events };
}

/**
 * The single source snapshot every fork derives from: ONE content read, with a
 * stat before and after it. The copied bytes and the envelope snapshot (cut,
 * title, parent seq) come from the same text and can never disagree; the stat
 * guard additionally refuses a source replaced while it was being read — a
 * same-length replacement changes the mtime/inode, so unlike the old
 * size-shrink check it is detected too. `beforeRead` is the test seam that runs
 * between the stat and the read.
 */
function readSourceSnapshot(
  sourcePath: string,
  sourceName: string,
  beforeRead?: () => void,
): SourceSnapshot {
  try {
    const before = fs.statSync(sourcePath);
    beforeRead?.();
    const text = fs.readFileSync(sourcePath, "utf-8");
    const after = fs.statSync(sourcePath);
    if (!sameFileVersion(before, after)) {
      throw new SessionForkError(
        "source-unreadable",
        `session ${sourceName} changed while it was being forked; nothing was written`,
      );
    }
    return parseSourceSnapshot(text, sourcePath, sourceName);
  } catch (exc) {
    if (exc instanceof SessionForkError) throw exc;
    throw new SessionForkError(
      "source-unreadable",
      `cannot read session ${sourceName}: ${messageOf(exc)}`,
    );
  }
}

/** Source title for the derived fork title: sidecar title, else derived. */
function readSourceTitle(
  sessionsDir: string,
  layout: SessionLayout,
  sourceName: string,
  events: Message[],
): string {
  const meta = new SessionMetadataStore(sessionsDir, layout).get(sourceName);
  const metaTitle = meta !== null && typeof meta.title === "string" ? meta.title.trim() : "";
  if (metaTitle) return metaTitle;
  return deriveTitle(
    events as unknown as Array<Record<string, any>>,
    stripJsonlSuffix(sourceName),
  );
}

/** Create-only write: `wx` means an existing file is never truncated. */
function writeNewSession(targetPath: string, text: string, fileName: string): void {
  try {
    fs.writeFileSync(targetPath, text, { encoding: "utf-8", flag: "wx" });
  } catch (exc) {
    if (isAlreadyExists(exc)) throw exc; // caller decides: next slot / name-taken
    throw new SessionForkError(
      "write-failed",
      `cannot write session ${fileName}: ${messageOf(exc)}`,
    );
  }
}

/**
 * Best-effort removal used by the metadata rollback: `null` on success,
 * otherwise the failure reason. `force` keeps an already-absent target a
 * success, and the existence re-check keeps the report truthful even if a
 * platform ignores the removal.
 */
function removeForRollback(target: string): string | null {
  try {
    fs.rmSync(target, { force: true });
    return fs.existsSync(target) ? `still present at ${target}` : null;
  } catch (exc) {
    return messageOf(exc);
  }
}

/**
 * Write the fork's metadata sidecar; on failure roll the fork back. The
 * rollback removes the copied JSONL AND a partially written `.meta.json` (a
 * leftover sidecar would otherwise reserve the name forever), and the thrown
 * message states truthfully whether each removal succeeded — it never claims a
 * removal that failed. `options.metadataWriter` is the test seam for the
 * failure path.
 */
function saveForkMetadata(
  sessionsDir: string,
  layout: SessionLayout,
  fileName: string,
  targetPath: string,
  targetMetaPath: string,
  title: string,
  parent: SessionParentLink,
  options: ForkSessionOptions,
): string {
  const writer =
    options.metadataWriter ??
    ((name: string, metadata: { title: string; parent: SessionParentLink }) =>
      new SessionMetadataStore(sessionsDir, layout).save(name, metadata));
  try {
    const meta = writer(fileName, { title, parent });
    return typeof meta.title === "string" && meta.title ? meta.title : title;
  } catch (exc) {
    const copyProblem = removeForRollback(targetPath);
    const metaProblem = removeForRollback(targetMetaPath);
    // A directory created for this fork is removed when empty, so a failed
    // fork never reserves the name.
    if (targetPath !== targetMetaPath) {
      try {
        fs.rmdirSync(path.dirname(targetPath));
      } catch {
        // not empty or already gone
      }
    }
    let message = `cannot write session metadata for ${fileName}: ${messageOf(exc)}`;
    message +=
      copyProblem === null
        ? "; the copied session file was removed"
        : `; the copied session file could not be removed: ${copyProblem}`;
    if (metaProblem !== null) {
      message += `; its partial metadata sidecar could not be removed: ${metaProblem}`;
    }
    throw new SessionForkError("write-failed", message);
  }
}

/**
 * Copy a session (or its prefix) into a new session file and record the local
 * lineage link. Pure filesystem work: no config, no provider, no network.
 *
 * @param sessionsDir directory holding `<name>.jsonl` files and sidecars.
 * @param source      source session name (basename-flattened; `.jsonl` optional).
 * @param options     cut point, explicit new name, explicit title.
 * @throws SessionForkError with a typed `code`; the source is never modified.
 */
export function forkSession(
  sessionsDir: string,
  source: string,
  options: ForkSessionOptions = {},
): ForkSessionResult {
  const dir = typeof sessionsDir === "string" ? sessionsDir : "";
  if (!dir.trim()) {
    throw new SessionForkError("invalid-name", "sessions directory must not be empty");
  }

  const sourceName = sourceFileName(source);
  const layout = new SessionLayout(dir);
  const sourceLocation = layout.resolve(sourceName);
  if (sourceLocation === null) {
    throw new SessionForkError("source-missing", `session not found: ${sourceName}`);
  }
  const sourcePath = sourceLocation.sessionPath;
  const sourceStore = new SessionStore(sourcePath);
  if (!sourceStore.exists()) {
    throw new SessionForkError("source-missing", `session not found: ${sourceName}`);
  }

  // One snapshot backs the whole fork: the copied bytes, the cut/title/parent
  // seq and the dense-seq validation all come from this single read.
  const snapshot = readSourceSnapshot(sourcePath, sourceName, options.beforeSourceRead);
  const events = snapshot.events;
  assertDenseSeq(events);

  const cut = resolveCut(events, options.atSeq);
  const copied = events.slice(0, cut);
  const parentSeq = copied.length > 0 ? copied[copied.length - 1].seq : 0;
  // Raw-byte prefix through the cut envelope (offsets from the same snapshot).
  const text = cut === 0 ? "" : snapshot.text.slice(0, snapshot.envelopeEnds[cut - 1]!);

  fs.mkdirSync(dir, { recursive: true });

  const explicitName =
    options.name === undefined ? null : forkFileName(options.name);
  // A migrated store keeps new sessions in the source's project directory;
  // an unmigrated store keeps fork targets flat.
  const targetProjectKey =
    layout.mode() === "dirs"
      ? (sourceLocation.projectKey ?? GLOBAL_PROJECT_KEY)
      : GLOBAL_PROJECT_KEY;

  let fileName: string;
  let target: { sessionPath: string; metaPath: string; dir: string | null };
  if (explicitName !== null) {
    if (forkNameTaken(layout, dir, explicitName, layout.mode() === "dirs" ? targetProjectKey : null)) {
      throw new SessionForkError("name-taken", `session already exists: ${explicitName}`);
    }
    fileName = explicitName;
    target = layout.materializeIn(fileName, targetProjectKey);
    try {
      writeNewSession(target.sessionPath, text, fileName);
    } catch (exc) {
      if (isAlreadyExists(exc)) {
        throw new SessionForkError("name-taken", `session already exists: ${fileName}`);
      }
      if (target.dir !== null) {
        try {
          fs.rmdirSync(target.dir);
        } catch {
          // not empty or already gone
        }
      }
      throw exc;
    }
  } else {
    const stem = stripJsonlSuffix(sourceName);
    fileName = "";
    target = { sessionPath: "", metaPath: "", dir: null };
    for (let candidateIndex = 1; candidateIndex <= MAX_FORK_NAME_ATTEMPTS; candidateIndex += 1) {
      const candidateFile = `${stem}${FORK_NAME_INFIX}${candidateIndex}${JSONL_SUFFIX}`;
      if (forkNameTaken(layout, dir, candidateFile, layout.mode() === "dirs" ? targetProjectKey : null)) {
        continue;
      }
      try {
        target = layout.materializeIn(candidateFile, targetProjectKey);
        writeNewSession(target.sessionPath, text, candidateFile);
        fileName = candidateFile;
        break;
      } catch (exc) {
        // Another writer created the file between the probe and the write;
        // an exclusive create means probing the next free slot is safe.
        if (isAlreadyExists(exc)) continue;
        if (target.dir !== null) {
          try {
            fs.rmdirSync(target.dir);
          } catch {
            // not empty or already gone
          }
        }
        throw exc;
      }
    }
    if (!fileName) {
      throw new SessionForkError(
        "name-taken",
        `cannot find a free fork name for ${sourceName} after ${MAX_FORK_NAME_ATTEMPTS} attempts`,
      );
    }
  }

  const title =
    (typeof options.title === "string" ? options.title.trim() : "") ||
    deriveForkTitle(readSourceTitle(dir, layout, sourceName, events));
  const savedTitle = saveForkMetadata(
    dir,
    layout,
    fileName,
    target.sessionPath,
    target.metaPath,
    title,
    { name: sourceName, seq: parentSeq },
    options,
  );

  return {
    name: fileName,
    title: savedTitle,
    events: cut,
    forked_from: { name: sourceName, seq: parentSeq },
  };
}
