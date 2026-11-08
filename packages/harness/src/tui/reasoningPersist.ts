/**
 * Read-only replay of persisted reasoning records for the TUI.
 *
 * The web app replays the reasoning a streaming provider call produced
 * (`{type: "reasoning", role, kind, text, truncated}` runtime events written by
 * `RunManager` to the session runtime sidecar). The TUI shows those records too
 * on load/resume/session switch: it READS the same sidecar
 * (`sessions/runtime/<session file>.events.jsonl` — the store directory and key
 * convention `todoPersist.ts` uses for plan snapshots) and never writes a
 * reasoning event. Live thinking stays exactly as it was: the sidecar copy is
 * replay-only and the live `THINKING` block is not affected (see
 * `src/tui/transcript.ts`).
 *
 * Honest limitation (shared with the harness capture): reasoning is only
 * persisted when the run had token streaming active, so a non-streaming run has
 * no records to replay — a missing/empty sidecar is the normal case, not an
 * error.
 *
 * Extraction is pure and fail-soft: unrelated, malformed or unattributable
 * records are dropped instead of guessed, oversized text is bounded
 * ({@link REPLAYED_REASONING_MAX_CHARS}, mirroring the backend cap) and only the
 * most recent {@link REPLAYED_REASONING_MAX_BLOCKS} records are kept — the
 * caller renders the honest `… +N earlier reasoning records` marker for the
 * rest. IO failures (missing/unreadable sidecar) yield an empty replay.
 */
import { REASONING_EVENT_MAX_CHARS, RuntimeEventStore } from "../runevents.ts";
import type { TuiRole } from "./model.ts";
import { sanitizeDisplayText } from "./screen.ts";
import { sessionSidecarKey } from "./view/todo.ts";

/**
 * Bound on one replayed reasoning text kept for the TUI, in characters.
 * Mirrors the harness' persisted `REASONING_EVENT_MAX_CHARS`: a record the
 * backend already bounded passes through untouched, while a hand-written or
 * hostile sidecar row cannot blow up the block model.
 */
export const REPLAYED_REASONING_MAX_CHARS = REASONING_EVENT_MAX_CHARS;

/** How many persisted reasoning records replay on load (newest kept). */
export const REPLAYED_REASONING_MAX_BLOCKS = 24;

/** One replayed reasoning record, ready for the transcript view. */
export interface ReplayedReasoning {
  /** The brother whose provider call produced the reasoning. */
  role: TuiRole;
  /** Node kind the call answered (consult / proposal / review / decision / …). */
  kind: string;
  /** Sanitized, bounded reasoning text. */
  text: string;
  /** True when the backend clipped the record or this loader had to. */
  truncated: boolean;
}

/** What one session's sidecar contributes to the transcript. */
export interface ReplayedReasoningSet {
  /** The (bounded) records to render, oldest first. */
  blocks: ReplayedReasoning[];
  /** Records the block bound left out (rendered as an honest marker). */
  hidden: number;
}

/** An empty replay; shared so an absent sidecar allocates nothing. */
const EMPTY_REPLAY: ReplayedReasoningSet = { blocks: [], hidden: 0 };

/** Bounded, sanitized text for one record (null when nothing is displayable). */
function boundedReasoningText(raw: unknown): { text: string; truncated: boolean } | null {
  if (typeof raw !== "string" || raw === "") return null;
  const clean = sanitizeDisplayText(raw);
  if (clean.trim() === "") return null;
  if (clean.length <= REPLAYED_REASONING_MAX_CHARS) return { text: clean, truncated: false };
  // Keep the head: the TUI renders a bounded preview of the beginning, and the
  // view adds the honest "clipped for length" marker from `truncated`.
  return { text: clean.slice(0, REPLAYED_REASONING_MAX_CHARS), truncated: true };
}

function maxBlocksOf(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    return REPLAYED_REASONING_MAX_BLOCKS;
  }
  return Math.floor(value);
}

/**
 * Extract the replayed reasoning records from one sidecar event list, in
 * append order (the order the provider calls ran). Pure and tolerant:
 * - only `{type: "reasoning"}` objects with a known `senior`/`junior` role and
 *   displayable `text` contribute; everything else is dropped;
 * - a non-string `kind` becomes `""`; a non-boolean `truncated` never claims a
 *   clip that did not happen (but text this loader had to clip sets it);
 * - only the newest `maxBlocks` records are kept, with `hidden` counting the
 *   earlier ones so the caller can say so honestly.
 */
export function reasoningFromRuntimeEvents(
  events: readonly unknown[],
  options: { maxBlocks?: number } = {},
): ReplayedReasoningSet {
  const maxBlocks = maxBlocksOf(options.maxBlocks);
  const all: ReplayedReasoning[] = [];
  for (const event of events) {
    if (event === null || typeof event !== "object" || Array.isArray(event)) continue;
    const record = event as Record<string, unknown>;
    if (record.type !== "reasoning") continue;
    const role: TuiRole | null =
      record.role === "senior" || record.role === "junior" ? record.role : null;
    if (role === null) continue;
    const text = boundedReasoningText(record.text);
    if (text === null) continue;
    all.push({
      role,
      kind: typeof record.kind === "string" ? record.kind.trim() : "",
      text: text.text,
      truncated: record.truncated === true || text.truncated,
    });
  }
  if (all.length === 0) return EMPTY_REPLAY;
  const hidden = Math.max(0, all.length - maxBlocks);
  return { blocks: hidden > 0 ? all.slice(all.length - maxBlocks) : all, hidden };
}

/**
 * Load the replay for one session file from its runtime sidecar. Fail-soft: an
 * in-memory session (no file name), a missing sidecar, an unreadable directory
 * or a torn line all yield no records instead of an error.
 */
export function loadSessionReasoning(
  store: RuntimeEventStore,
  sessionFile: string,
  options: { maxBlocks?: number } = {},
): ReplayedReasoningSet {
  const key = sessionSidecarKey(sessionFile);
  if (key === "") return EMPTY_REPLAY;
  try {
    return reasoningFromRuntimeEvents(store.load(key), options);
  } catch {
    return EMPTY_REPLAY;
  }
}
