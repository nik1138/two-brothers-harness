/**
 * In-process run stream: the NDJSON vocabulary behind `run --stream`.
 *
 * Ported in shape from deepseek-harness's `--json` NDJSON projection
 * (`research/harnesses/plugins-deepseek-harness.md` §R3): commit-point-only
 * emission, bounded records, a terminal `result` record, and no invented
 * vocabulary — every record is a projection of a state the harness already
 * reached. Unlike dsh this is an ADDITIONAL channel: `HarnessResult`,
 * the protocol envelopes, the `RuntimeEvent` hook and the server's SSE
 * `RuntimeEventStore` are untouched.
 *
 * Emission points (all in `harness.ts`, `TwoBrothersHarness`):
 *   run_status started    `run()` before the state machine starts
 *   envelope              `publishEnvelope()` — every appended envelope,
 *                         including the initial user task, repair turns and
 *                         the compaction summary
 *   repair                `repairReply()` — one per repair pass, before the
 *                         repair envelope it appends
 *   token                 the provider's delta sinks, when
 *                         `HarnessOptions.streamTokens` is on — one per text
 *                         OR thinking delta, in arrival order, tagged
 *                         `kind: "text" | "thinking"` (only with a stream
 *                         consumer; additive to the envelope records)
 *   tool_call/tool_result `invokeTool()` (and the unknown-tool branch of
 *                         `toolLoop()`)
 *   run_status completed  `run()` after `END` (failed/cancelled on the
 *                         matching exit paths)
 *   result                `run()` on completion only
 *
 * Bounds (dsh §R3): every string field is capped at
 * {@link STREAM_FIELD_CHARS} (an over-long field becomes
 * `<clipped N chars>`), and every serialized line is capped at
 * {@link STREAM_LINE_CHARS}. dsh measures bytes; these bounds are measured
 * in JS string characters — documented divergence, ours are char-based like
 * the rest of the harness (`runevents.ts` clip constants).
 *
 * The `result` record is *not* exempt from the caps (dsh exempts its
 * `final`): an NDJSON consumer must be able to assume every line is bounded,
 * and a decision large enough to blow the line cap is itself the anomaly.
 * The summary still carries the decision — clipped, with the marker showing
 * what was cut.
 */
import type { Message } from "./protocol.ts";
import type { UsageTotals } from "./provider.ts";

/** The three roles an envelope or actor can carry (user = harness-injected). */
export type StreamRole = "senior" | "junior" | "user";

/** Terminal/transient states of one in-process run. */
export type StreamRunStatus = "started" | "completed" | "failed" | "cancelled";

/** Tool outcome as a stream consumer sees it (no per-tool status strings). */
export type StreamToolStatus = "ok" | "error" | "blocked";

/**
 * The terminal `result` payload. A deliberately minimal projection of
 * `HarnessResult` (defined here, not imported, so `harness.ts` → here stays
 * one-way): JSON-serializable, and enough for a consumer to print usage or
 * compute cost with `estimateCost` — which is why `run --stream` suppresses
 * the human cost line.
 */
export interface HarnessResultSummary {
  /** The senior's final decision payload. */
  decision: Record<string, unknown>;
  /** Merged token usage over both roles. */
  usage: UsageTotals;
  /** Count of fail-soft warnings (compaction failures); never errors. */
  warnings: number;
  /** The session JSONL the run persisted to, or null for an in-memory run. */
  sessionFile: string | null;
  /**
   * Additive auto-mode routing decision (mirrors `HarnessResult.autoRoute`),
   * present only when the run routed. Structural duplicate of the harness
   * type so this module stays dependency-free of harness.ts.
   */
  autoRoute?: { route: "solo" | "consult" | "work"; reason: string; downgradedFrom?: "work" };
}

export interface RunStatusStreamEvent {
  type: "run_status";
  status: StreamRunStatus;
  at: string;
}

export interface EnvelopeStreamEvent {
  type: "envelope";
  envelope: Message;
  at: string;
}

export interface RepairStreamEvent {
  type: "repair";
  role: StreamRole;
  /** The structured node kind whose reply failed the strict check. */
  kind: string;
  at: string;
}

/**
 * One provider delta from a streamed call (`HarnessOptions.streamTokens`).
 * Deltas arrive in provider order; `kind` says whether the delta is visible
 * reply text (`"text"`) or the model's reasoning (`"thinking"`). Text deltas
 * concatenate to the reply text; thinking deltas are observational and never
 * appear in the reply, protocol envelopes or usage counters. New producers
 * (the harness) always set `kind`; a consumer should treat a missing or
 * unknown `kind` (older/hand-built records) as `"text"`. A delta longer than
 * {@link STREAM_FIELD_CHARS} is clipped by `toNdjsonLine` like any other
 * string field (the `kind` tag survives). Token records are additive to the
 * envelope records.
 */
export interface TokenStreamEvent {
  type: "token";
  role: StreamRole;
  /** `"text"` = visible reply text, `"thinking"` = model reasoning. */
  kind: "text" | "thinking";
  delta: string;
  at: string;
}

export interface ToolCallStreamEvent {
  type: "tool_call";
  role: StreamRole;
  tool: string;
  at: string;
  /**
   * Additive pairing id (`tc1`, `tc2`, … within one run), present so a
   * consumer can match a result to its call without relying on ordering.
   * Optional: older producers omit it and pairing falls back to role+tool.
   */
  callId?: string;
  /** Additive, already-bounded JSON rendering of the call arguments. */
  args?: string;
}

export interface ToolResultStreamEvent {
  type: "tool_result";
  role: StreamRole;
  tool: string;
  status: StreamToolStatus;
  at: string;
  /** Additive pairing id matching the {@link ToolCallStreamEvent} when set. */
  callId?: string;
  /** Additive, already-compacted result text (bounded like any string field). */
  result?: string;
}

export interface ResultStreamEvent {
  type: "result";
  result: HarnessResultSummary;
  at: string;
}

/**
 * Additive live usage snapshot: emitted after a cooperation node finishes its
 * provider calls, before the next node starts. It carries the same counters as
 * `result.usage`/`run_end.usage`, so a TUI or web consumer can show tokens and
 * the cache-hit percentage while the run is still working. Consumers that do
 * not know the type can ignore it safely.
 */
export interface UsageStreamEvent {
  type: "usage";
  usage: Record<string, unknown>;
  at: string;
}

/** One record of the in-process run stream (`run --stream` = these as NDJSON). */
export type StreamEvent =
  | RunStatusStreamEvent
  | EnvelopeStreamEvent
  | RepairStreamEvent
  | TokenStreamEvent
  | ToolCallStreamEvent
  | ToolResultStreamEvent
  | UsageStreamEvent
  | ResultStreamEvent;

/** Cap for one string field, in characters (dsh: 8 KiB). */
export const STREAM_FIELD_CHARS = 8192;
/** Cap for one serialized NDJSON line, in characters (dsh: 32 KiB). */
export const STREAM_LINE_CHARS = 32768;

/** The replacement text for an over-long string field. */
export function clippedMarker(length: number): string {
  return `<clipped ${length} chars>`;
}

/**
 * Deep-clip every string in `value` to {@link STREAM_FIELD_CHARS}. Returns a
 * fresh JSON-shaped structure — the caller's event is never mutated, so an
 * `onStreamEvent` consumer that keeps the original object keeps it intact.
 */
function clipFields(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > STREAM_FIELD_CHARS ? clippedMarker(value.length) : value;
  }
  if (Array.isArray(value)) return value.map(clipFields);
  if (value !== null && typeof value === "object") {
    const copy: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      copy[key] = clipFields(inner);
    }
    return copy;
  }
  return value;
}

/** A mutable string position inside the clipped event copy. */
interface StringSlot {
  parent: Record<string, unknown> | unknown[];
  key: string | number;
  length: number;
}

/** Every string leaf, with the handle needed to replace it, in walk order. */
function collectStringSlots(value: unknown, out: StringSlot[] = []): StringSlot[] {
  if (typeof value === "string") {
    return out; // the root is never a string in a StreamEvent
  }
  if (Array.isArray(value)) {
    value.forEach((inner, index) => {
      if (typeof inner === "string") {
        out.push({ parent: value, key: index, length: inner.length });
      } else {
        collectStringSlots(inner, out);
      }
    });
    return out;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const [key, inner] of Object.entries(record)) {
      if (typeof inner === "string") {
        out.push({ parent: record, key, length: inner.length });
      } else {
        collectStringSlots(inner, out);
      }
    }
  }
  return out;
}

/**
 * Serialize one stream event as exactly one NDJSON line.
 *
 * Algorithm, in two passes:
 * 1. Field pass: every string in the event is deep-clipped to
 *    {@link STREAM_FIELD_CHARS} (marker `<clipped N chars>`, N = the
 *    original length). Nested payload/decision strings are covered.
 * 2. Line pass: if `JSON.stringify` of the clipped event still exceeds
 *    {@link STREAM_LINE_CHARS}, the longest remaining string field is
 *    replaced with its marker and the line is re-measured; repeat until it
 *    fits. A pathological event with thousands of fields that cannot fit
 *    even when every string is a marker degrades to
 *    `{type, at, truncated: true}` — the shape of the record type survives,
 *    which is what a consumer's switch needs.
 *
 * The line never contains a raw newline: `JSON.stringify` escapes `\n`,
 * `\r` and `\u2028`/`\u2029` (the latter since ES2019), so the result is true
 * by construction — the tests assert it.
 */
export function toNdjsonLine(event: StreamEvent): string {
  const working = clipFields(event) as StreamEvent;
  let line = JSON.stringify(working);
  if (line.length <= STREAM_LINE_CHARS) return line;

  const slots = collectStringSlots(working).sort((a, b) => b.length - a.length);
  for (const slot of slots) {
    (slot.parent as Record<string | number, unknown>)[slot.key] = clippedMarker(slot.length);
    line = JSON.stringify(working);
    if (line.length <= STREAM_LINE_CHARS) return line;
  }
  return JSON.stringify({ type: event.type, at: event.at, truncated: true });
}