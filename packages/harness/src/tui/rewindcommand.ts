/**
 * The `/rewind` surface's pure model: argument parsing, the destructive
 * preview/confirmation copy and one bounded outcome notice.
 *
 * `/rewind [--turns <n>]` removes the last `n` operator turns (default one)
 * from the CURRENT session through `src/sessionrewind.ts` and reloads it. The
 * service owns the whole cut/floor/seq semantics; this module only:
 *
 * - parses the typed depth with the service's own `validateRewindTurns`
 *   (never a second range rule);
 * - asks the service's pure `computeRewindCut` what the cut WOULD remove, so
 *   the confirmation can name the real turn/envelope counts, the removed
 *   envelope `seq` range and the kept envelope count before anything is
 *   written (the service is the preview/dry-run capability);
 * - quotes the first operator task that would be removed (bounded), like the
 *   web `RewindDialog` quote;
 * - states honestly when the requested depth clamps at the session start or
 *   at the compaction-summary floor, and renders one bounded success/no-op
 *   notice from the outcome the service actually applied.
 *
 * Everything here is pure: no I/O, no mutation, no clock. An invalid depth is
 * a usage sentence (the caller shows it and touches nothing), never a throw.
 */
import type { Message } from "../protocol.ts";
import {
  computeRewindCut,
  findOperatorTurns,
  validateRewindTurns,
  type RewindCut,
} from "../sessionrewind.ts";

/** The exact accepted invocation, shown by every usage refusal. */
export const REWIND_USAGE = "/rewind [--turns <n>]";

/** Longest notice text (chars) before it is truncated with an ellipsis. */
export const REWIND_NOTICE_MAX_CHARS = 320;

/** Longest quoted task snippet in the confirmation (never a full transcript). */
export const REWIND_QUOTE_MAX_CHARS = 160;

/** One validated `/rewind` request; absent depth means one operator turn. */
export interface RewindCommandParse {
  /** Validated depth (`1..100`); `1` whenever `error` is set (never used then). */
  turns: number;
  /** Plain operator-facing usage refusal, or null when the request is valid. */
  error: string | null;
}

function usageError(problem: string): RewindCommandParse {
  return { turns: 1, error: `${problem} — usage: ${REWIND_USAGE}` };
}

/**
 * Parse the argument text after `/rewind`. Grammar: nothing (one operator
 * turn) or exactly one `--turns <n>` with an integer validated by the
 * service's own `validateRewindTurns` (1..100). Every rejection is an honest
 * usage sentence naming the problem and the accepted form.
 */
export function parseRewindCommandArgs(raw: string): RewindCommandParse {
  const tokens = (typeof raw === "string" ? raw : "").trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { turns: 1, error: null };
  const head = tokens[0]!;
  if (head !== "--turns") {
    return usageError(head.startsWith("--") ? `unknown option ${head}` : `unexpected argument ${head}`);
  }
  const rest = tokens.slice(1);
  if (rest.length === 0) return usageError("--turns needs a number");
  if (rest.length > 1) return usageError(`unexpected argument ${rest[1]}`);
  const text = rest[0]!;
  if (!/^[0-9]+$/.test(text)) return usageError("--turns must be a positive integer");
  const parsed = validateRewindTurns(Number.parseInt(text, 10));
  if (!parsed.ok) return usageError(parsed.error);
  return { turns: parsed.turns, error: null };
}

/** Bound one composed `/rewind` notice so a long error stays one row. */
export function boundRewindNotice(text: string): string {
  return text.length > REWIND_NOTICE_MAX_CHARS
    ? `${text.slice(0, REWIND_NOTICE_MAX_CHARS - 1)}…`
    : text;
}

/** One-line bounded task snippet for the confirmation. */
export function rewindQuote(text: string): string {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  if (clean.length <= REWIND_QUOTE_MAX_CHARS) return clean;
  return `${clean.slice(0, REWIND_QUOTE_MAX_CHARS - 1)}…`;
}

/** Envelope `seq` of a possibly-malformed record, or null. */
function eventSeq(event: unknown): number | null {
  if (typeof event !== "object" || event === null) return null;
  const seq = (event as { seq?: unknown }).seq;
  return typeof seq === "number" && Number.isFinite(seq) ? seq : null;
}

/** Human `seq a-b` range of the envelopes a cut removes ("" when unknown). */
function removedSeqRange(events: readonly Message[], cutIndex: number): string {
  if (cutIndex < 0 || cutIndex >= events.length) return "";
  const first = eventSeq(events[cutIndex]);
  const last = eventSeq(events[events.length - 1]);
  if (first === null || last === null) return "";
  return first === last ? `seq ${first}` : `seq ${first}-${last}`;
}

/** Seq of the last kept envelope, or null when the kept prefix is empty/unknown. */
function lastKeptSeq(events: readonly Message[], cutIndex: number): number | null {
  if (cutIndex <= 0 || cutIndex > events.length) return null;
  return eventSeq(events[cutIndex - 1]);
}

/** Everything the destructive confirmation names, derived before the write. */
export interface RewindPreview {
  /** The service's own planned cut (the dry run). */
  cut: RewindCut;
  /** Text of the first operator task the cut removes ("" when none). */
  taskText: string;
  /** Human `seq a-b` range of the removed envelopes ("" when unknown). */
  removedSeq: string;
  /** Seq of the last kept envelope (null when empty/unknown). */
  keptSeq: number | null;
}

/**
 * Compute the honest preview for `turns` from the loaded envelope log. The cut
 * is the service's `computeRewindCut`, so counts, clamp flags and the reason
 * are exactly what `rewindSession` would apply.
 */
export function previewRewind(events: readonly Message[], turns: number): RewindPreview {
  const cut = computeRewindCut(events, turns);
  const removedTask =
    cut.removedCount === 0
      ? undefined
      : findOperatorTurns(events).find((turn) => turn.index >= cut.cutIndex);
  return {
    cut,
    taskText: removedTask?.text ?? "",
    removedSeq: removedSeqRange(events, cut.cutIndex),
    keptSeq: lastKeptSeq(events, cut.cutIndex),
  };
}

/** The clamp boundary in operator words (`""` when the cut is exact). */
function clampSentence(cut: RewindCut): string {
  if (cut.requestedTurns <= cut.turns) return "";
  if (cut.stopsBefore === "compaction-summary") {
    return (
      ` Requested ${cut.requestedTurns} turn(s); the cut stops at the compaction summary ` +
      "(tasks folded into it stay)."
    );
  }
  if (cut.stopsBefore === "session-start") {
    return ` Requested ${cut.requestedTurns} turn(s); the cut stops at the session start.`;
  }
  return "";
}

/** One plural helper (`1 turn` / `2 turns`). */
function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/**
 * The destructive confirmation body: what is removed (turn and envelope
 * counts plus the removed `seq` range), what stays (kept envelopes with their
 * dense `seq`), the sidecar/transcript consequence, that the file is rewritten
 * in place and that this cannot be undone. The selected task is quoted at the
 * end, bounded exactly like the web dialog.
 */
export function rewindConfirmation(input: { name: string; preview: RewindPreview }): string {
  const { cut, taskText, removedSeq, keptSeq } = input.preview;
  const name = input.name.trim() || "this session";
  const removed = `${plural(cut.removedCount, "envelope", "envelopes")}${
    removedSeq === "" ? "" : ` (${removedSeq})`
  }`;
  const kept = `${plural(cut.keptCount, "envelope", "envelopes")} stay${
    keptSeq === null ? "" : ` (dense seq through ${keptSeq})`
  }`;
  const quote = rewindQuote(taskText);
  return (
    `Remove the last ${plural(cut.turns, "operator turn", "operator turns")} and everything after: ` +
    `${removed} will be deleted from ${name}, which is rewritten in place. ${kept}; the ` +
    "tool/approval history sidecar is cleared and the transcript is kept. This cannot be undone." +
    clampSentence(cut) +
    (quote === "" ? "" : ` Selected task: “${quote}”`)
  );
}

/** The outcome the app applied, for the one bounded success notice. */
export interface RewindOutcome {
  /** The session name (as the store lists it). */
  name: string;
  /** The cut the service actually applied. */
  cut: RewindCut;
  /** Whether the runtime-event sidecar was removed. */
  sidecarCleared: boolean;
  /** Why the sidecar clear failed, or null/undefined when it did not. */
  sidecarError?: string | null;
}

/**
 * One bounded success/no-op notice: the applied cut's own reason (removed
 * turns/envelopes, kept count, clamp wording), the kept dense `seq`, the
 * sidecar outcome and that the transcript is kept and the session reloaded.
 * Never claims more than the result reports; a failed sidecar clear is
 * disclosed instead of hidden.
 */
export function rewindOutcomeNotice(outcome: RewindOutcome): string {
  const name = outcome.name.trim() || "the session";
  const { cut } = outcome;
  if (cut.removedCount === 0) {
    return `nothing to rewind in ${name}: ${cut.reason}; the session file is unchanged`;
  }
  const sidecarError =
    typeof outcome.sidecarError === "string" && outcome.sidecarError.trim() !== ""
      ? outcome.sidecarError.trim()
      : "";
  const sidecar =
    sidecarError !== ""
      ? `could not clear the tool/approval history sidecar: ${sidecarError}`
      : outcome.sidecarCleared
        ? "cleared the tool/approval history sidecar"
        : "the tool/approval history sidecar was already empty";
  return (
    `rewound ${name}: ${cut.reason}; the kept prefix keeps its dense seq; ${sidecar}; ` +
    "the transcript is kept — reloaded the session"
  );
}
