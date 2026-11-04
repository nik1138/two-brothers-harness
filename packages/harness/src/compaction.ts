/**
 * Context compaction: summarize an old prefix of the shared context so long
 * sessions stay within a model's context window. Ports the compaction
 * algorithm of pi's coding agent (`packages/coding-agent/src/core/compaction/
 * compaction.ts`, earendil-works/pi, MIT — copyright (c) 2025 Mario Zechner)
 * onto our envelope format, per research/harnesses/pi-durable-mcp-chord.md and
 * research/pi-adoption.md (O3, compaction v2): cut-point selection that never
 * loses the task head (`selectCutPoint`), plain-text transcript serialization
 * with long entries capped (`serializeConversation`), the pinned structured
 * summary prompt, incremental `<previous-summary>` chaining, and a split-payload
 * cut for envelopes larger than the verbatim budget. The summary is produced by
 * the configured provider through the existing `Provider` abstraction — the
 * senior's endpoint by default — never a second HTTP client.
 *
 * Documented adaptations to our format (the Python implementation has no
 * compaction; this is a TS-first feature):
 * - Budgets are measured in one of two units, chosen per run
 *   ({@link compactionUnit}). CHARS is the back-compatible default: our
 *   renderer is plain text and a char budget is deterministic. TOKENS is the
 *   provider-honest mode: when the run knows its context window
 *   (`contextWindow`) or the caller sets `thresholdTokens`, the trigger is
 *   `contextWindow - reserveTokens` and the auto budgets derive in tokens,
 *   compared against {@link estimateTokens} of the rendered transcript — the
 *   quantity a provider actually exhausts. The estimator is a documented
 *   chars/token heuristic (see its docstring), not a tokenizer. Output
 *   shaping (serialization caps, split-payload head/tail cuts) stays
 *   char-based in both modes.
 * - pi's candidate rule ("never split tool calls / tool results") has no
 *   analogue: our protocol envelopes are atomic — tool evidence rides inside
 *   payload fields, never as separate envelopes — so every envelope boundary
 *   is a clean cut candidate. What pi protects with the head pointer we
 *   protect explicitly: the original task message is always kept and never
 *   compacted (`[[TASK]]` derives from it).
 * - pi's split-turn handling has no message-level analogue, so the split
 *   happens at the envelope level: when the boundary envelope alone exceeds
 *   the keep-recent budget (a single huge delegation, say), it is folded into
 *   the summary and the envelopes after it stay verbatim. Its serialization is
 *   split for the summarizer — head and tail survive, the omitted middle is
 *   replaced by an explicit truncation marker — so cut content is never
 *   silently dropped. This keeps a session compactable even when one payload
 *   would otherwise block every cut.
 * - When the summarized prefix already carries a compaction summary, its body
 *   is passed as `<previous-summary>` and pi's update prompt asks the model to
 *   preserve and update it, instead of summarizing the session cold. The old
 *   summary envelope itself is not repeated in `<conversation>`. The context
 *   still carries exactly one summary event after every compaction.
 * - The summary rides as a regular `message` envelope (from `user`, the
 *   harness-injected context role, marked by COMPACTION_SUMMARY_PREFIX), so
 *   the protocol contract is untouched: envelopes stay byte-valid per
 *   shared/protocol.schema.json and the session JSONL keeps one envelope per
 *   line with dense `seq` (the store is rewritten temp-file + rename, the
 *   technique pi's JSONL storage uses for sidecar reclaim).
 *
 * Fail-soft is the caller's contract (harness.ts): a summarization failure
 * propagates as an exception BEFORE anything is rewritten, so the caller can
 * log a warning and keep the un-compacted context.
 */
import type { SharedContext } from "./context.ts";
import type { Message } from "./protocol.ts";
import { createMessage, validateMessage } from "./protocol.ts";
import type { Provider } from "./provider.ts";

/** Longest envelope serialization a summary source keeps (pi's cap). */
const ENTRY_MAX_CHARS = 2000;
/** Default verbatim tail budget (chars) when the caller sets none. */
export const DEFAULT_KEEP_RECENT_CHARS = 40000;
/** Summary cap for manual compactions (no threshold given). */
const MAX_SUMMARY_CHARS = 20000;

/**
 * Default reply headroom below `thresholdChars` before an auto compaction
 * fires — pi's `reserveTokens` idea, expressed in chars (a TS-first divergence:
 * chars, not tokens). ~2000 tokens at pi's chars/4 heuristic. Clamped to half
 * the threshold on use, so a small offline threshold still triggers.
 */
export const DEFAULT_RESERVE_CHARS = 8000;

/**
 * Default token-mode reply headroom below `contextWindow`/`thresholdTokens`:
 * the same ~8000-char intent expressed in tokens (pi's chars/4 benchmark).
 * Clamped to half the threshold on use, like {@link DEFAULT_RESERVE_CHARS}.
 */
export const DEFAULT_RESERVE_TOKENS = 2000;

/**
 * Default token-mode verbatim tail: {@link DEFAULT_KEEP_RECENT_CHARS} at the
 * estimator's ~4 chars/token ASCII benchmark.
 */
export const DEFAULT_KEEP_RECENT_TOKENS = 10000;

/**
 * Crude, deterministic token estimate for budgeting: no tokenizer dependency,
 * no fake precision. Calibrated against the usual provider averages:
 *
 * - ASCII (letters, digits, whitespace, punctuation): 4 chars per token,
 * - CJK ideographs/kana/Hangul/full-width forms and emoji: 1 token per
 *   character (tokenizers split these far more finely than ASCII),
 * - any other non-ASCII (accented Latin, Cyrillic, …): 2 chars per token.
 *
 * The sum is rounded UP, so an empty string is 0 and every non-empty string is
 * at least 1. Expect ±30 % against a real tokenizer; this is a budget gauge
 * (like pi's chars/4 reserve), not a billing estimate.
 */
export function estimateTokens(text: string): number {
  let cost = 0;
  for (const char of text) {
    cost += charTokenCost(char.codePointAt(0)!);
  }
  return Math.ceil(cost);
}

function isWideCodePoint(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x9fff) || // CJK radicals … unified ideographs, kana
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility ideographs
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK compatibility forms
    (cp >= 0xff00 && cp <= 0xffef) || // full-width forms
    (cp >= 0x1f000 && cp <= 0x1faff) || // emoji / pictographs
    cp >= 0x20000 // CJK extension planes
  );
}

function charTokenCost(cp: number): number {
  if (cp < 0x80) return 1 / 4;
  return isWideCodePoint(cp) ? 1 : 1 / 2;
}

/** `text` cut to at most `maxTokens` estimated tokens (used for the summary cap). */
function truncateToTokens(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text;
  let cost = 0;
  let end = 0;
  for (const char of text) {
    const next = cost + charTokenCost(char.codePointAt(0)!);
    if (Math.ceil(next) > maxTokens) break;
    cost = next;
    end += char.length;
  }
  return text.slice(0, end);
}

/**
 * The clearly-marked context event wrapping a compaction summary. Kept
 * byte-stable: it is a user-visible string sent to models (inside the
 * "Context events:" transcript section), like the `[[TASK]]` markers.
 */
export const COMPACTION_SUMMARY_PREFIX =
  "The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
export const COMPACTION_SUMMARY_SUFFIX = "\n</summary>";

/**
 * The pinned summarization prompts, ported verbatim from pi's compaction task
 * (MIT, earendil-works/pi). `SUMMARIZATION_PROMPT` is the cold-start prompt;
 * `UPDATE_SUMMARIZATION_PROMPT` is used only when a previous summary is fed
 * back through `<previous-summary>` (pi's incremental chaining).
 */
export const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

export const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work. If the conversation starts with an earlier summary, preserve its information and fold the newer messages into it.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

/** pi's update prompt, verbatim: preserve and update the previous summary. */
export const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

/** Settings for one compaction run (harness `HarnessOptions.compaction`). */
export interface CompactionSettings {
  /**
   * Auto trigger: compact when the rendered transcript reaches
   * `thresholdChars - reserveChars` (0 or unset = no char trigger). To land
   * the compacted context under that trigger, an auto trigger caps its
   * budgets: the verbatim tail is at most half the trigger and the summary at
   * most a quarter (at least 200), so repeated compactions converge instead
   * of re-firing every turn.
   */
  thresholdChars?: number;
  /**
   * Reply headroom (chars) subtracted from `thresholdChars` for the auto
   * trigger, so a post-compaction model reply still fits. Default
   * {@link DEFAULT_RESERVE_CHARS}, clamped to half the threshold.
   */
  reserveChars?: number;
  /**
   * Verbatim tail budget in chars — the cut keeps at least this much recent
   * context (pi's `keepRecentTokens`). Default
   * {@link DEFAULT_KEEP_RECENT_CHARS}; under an auto trigger it is further
   * capped to half the threshold.
   */
  keepRecentChars?: number;
  /**
   * The provider's context window in tokens. When known (with
   * `thresholdTokens`, either one is enough), token mode is active: the auto
   * trigger is `contextWindow - reserveTokens` (or `thresholdTokens -
   * reserveTokens` when that is set) in estimated tokens, and the auto
   * budgets derive in tokens. Without a window or `thresholdTokens`, the char
   * fields above apply unchanged.
   */
  contextWindow?: number;
  /**
   * Explicit token trigger, overriding the window-derived one. Setting it
   * (even without `contextWindow`) switches compaction to token mode.
   */
  thresholdTokens?: number;
  /**
   * Token-mode reply headroom below the trigger. Default
   * {@link DEFAULT_RESERVE_TOKENS}, clamped to half the threshold.
   */
  reserveTokens?: number;
  /**
   * Token-mode verbatim tail. Default {@link DEFAULT_KEEP_RECENT_TOKENS},
   * capped to half the trigger like the char tail.
   */
  keepRecentTokens?: number;
  /** Compact once at the first opportunity even when under the trigger (the `--compact` flag). */
  force?: boolean;
  /** Which role's provider writes the summary (default `"senior"`). */
  summarizerRole?: "senior" | "junior";
  /** Fail-soft notification: called when summarization failed and the full context is kept. */
  onWarning?: (message: string) => void;
}

/** True when `event` is a compaction-summary context event (the marker prefix). */
export function isCompactionSummary(event: Message): boolean {
  return (
    event.from === "user" &&
    event.kind === "message" &&
    typeof event.payload?.text === "string" &&
    event.payload.text.startsWith(COMPACTION_SUMMARY_PREFIX)
  );
}

/** The summary body of a compaction-summary envelope, or undefined for any other event. */
export function compactionSummaryText(event: Message): string | undefined {
  if (!isCompactionSummary(event)) return undefined;
  const text = String(event.payload.text);
  const body = text.slice(COMPACTION_SUMMARY_PREFIX.length);
  return (body.endsWith(COMPACTION_SUMMARY_SUFFIX)
    ? body.slice(0, body.length - COMPACTION_SUMMARY_SUFFIX.length)
    : body
  ).trim();
}

function capitalizeRole(role: string): string {
  return role.length === 0 ? role : role[0]!.toUpperCase() + role.slice(1);
}

/**
 * One envelope as a plain-text line for the summarizer (pi's
 * `serializeConversation` applied to envelopes instead of chat messages).
 * User messages render as `[User]: …`, brother exchanges as
 * `[Senior -> Junior] (kind) {payload}`; payloads are JSON — the same shape
 * the brothers themselves read in the transcript.
 */
export function serializeEnvelope(event: Message): string {
  if (event.from === "user" && event.kind === "message") {
    return `[User]: ${String(event.payload?.text ?? "")}`;
  }
  const from = capitalizeRole(event.from);
  const to = capitalizeRole(event.to);
  return `[${from} -> ${to}] (${event.kind}) ${JSON.stringify(event.payload ?? {})}`;
}

function truncationMarker(omitted: number): string {
  return `[... ${omitted} more characters truncated]`;
}

function splitMarker(omitted: number): string {
  return `[... ${omitted} characters truncated from the middle of this envelope]`;
}

function truncateEntry(text: string): string {
  if (text.length <= ENTRY_MAX_CHARS) return text;
  return `${text.slice(0, ENTRY_MAX_CHARS)}\n\n${truncationMarker(text.length - ENTRY_MAX_CHARS)}`;
}

/**
 * Split an oversized envelope's serialization for the summarizer: keep its
 * head and tail, mark the omitted middle. The tail matters because payload
 * endings (a result, acceptance notes, a closing decision) are often what the
 * next summary needs; head-only truncation would drop them.
 */
function splitEntry(text: string): string {
  if (text.length <= ENTRY_MAX_CHARS) return text;
  const head = Math.floor(ENTRY_MAX_CHARS / 2);
  const tail = ENTRY_MAX_CHARS - head;
  return `${text.slice(0, head)}\n\n${splitMarker(text.length - ENTRY_MAX_CHARS)}\n\n${text.slice(text.length - tail)}`;
}

/** Options for {@link serializeConversation}. */
export interface SerializeOptions {
  /** Index of the envelope cut by a split-payload cut (head+tail + marker). */
  splitIndex?: number;
}

/**
 * The events before `cut` as plain text for the summarizer: one entry per
 * envelope, separated by blank lines, long entries capped at 2000 chars
 * (pi's `TOOL_RESULT_MAX_CHARS` shape, including the truncation note). A
 * split-payload cut marks one envelope for head+tail serialization instead.
 */
export function serializeConversation(events: readonly Message[], options: SerializeOptions = {}): string {
  const parts: string[] = [];
  for (let index = 0; index < events.length; index++) {
    const text = serializeEnvelope(events[index]!);
    parts.push(index === options.splitIndex ? splitEntry(text) : truncateEntry(text));
  }
  return parts.join("\n\n");
}

/**
 * Number of leading events a compaction never cuts: the original task (the
 * first user message — `renderTranscript` derives `[[TASK]]` from it). A
 * prior compaction summary is an ordinary event here: re-compaction folds it
 * into the new summary (see the module header), it is not kept verbatim.
 */
function headCount(events: readonly Message[]): number {
  return events.length > 0 && events[0]!.from === "user" && events[0]!.kind === "message" ? 1 : 0;
}

/** Where a compaction cuts, and whether it splits one oversized envelope. */
export interface CompactionCut {
  /** Index of the first event kept verbatim; `events.length` when none is. */
  firstKeptIndex: number;
  /**
   * Index of the oversized envelope folded into the summary by a split-payload
   * cut: its serialization keeps head and tail with an explicit truncation
   * marker. Undefined for an ordinary envelope-boundary cut.
   */
  splitIndex?: number;
}

/**
 * Cut point selection. Port of pi's `selectCut` with pi's split handling
 * adapted to atomic envelopes: walk back from the tail until the keep-recent
 * budget stays verbatim, cut at that boundary (every envelope boundary is a
 * candidate). When the boundary envelope alone exceeds the budget —
 * including the first non-head envelope, where an envelope-boundary cut would
 * have nothing older to summarize — the cut moves past it and the envelope is
 * folded into the summary (split serialization), so the kept tail always fits
 * and the session stays compactable. Returns `undefined` when the tail already
 * fits or the task head is the only context. Measured in chars; token mode
 * uses {@link selectCutPointTokens}.
 */
export function selectCutPoint(events: readonly Message[], keepRecentChars: number): CompactionCut | undefined {
  return selectCutMeasured(events, keepRecentChars, (text) => text.length);
}

/**
 * Token-mode cut point selection: the same walk as {@link selectCutPoint},
 * accumulating {@link estimateTokens} of each envelope's serialization
 * against a keep-recent budget in estimated tokens.
 */
export function selectCutPointTokens(
  events: readonly Message[],
  keepRecentTokens: number,
): CompactionCut | undefined {
  return selectCutMeasured(events, keepRecentTokens, estimateTokens);
}

function selectCutMeasured(
  events: readonly Message[],
  budget: number,
  measure: (text: string) => number,
): CompactionCut | undefined {
  const start = headCount(events);
  let kept = 0;
  let cut: number | undefined;
  for (let index = events.length - 1; index >= start; index--) {
    kept += measure(serializeEnvelope(events[index]!));
    if (kept < budget) continue;
    cut = index;
    break;
  }
  if (cut === undefined) return undefined;
  const boundary = measure(serializeEnvelope(events[cut]!));
  const hasRecentAfter = cut < events.length - 1;
  if (cut === start || (boundary > budget && hasRecentAfter)) {
    return { firstKeptIndex: cut + 1, splitIndex: cut };
  }
  return { firstKeptIndex: cut };
}

/**
 * Index of the first event a compaction keeps verbatim, or `undefined` when
 * there is nothing worth compacting — the envelope-boundary preview of
 * {@link selectCutPoint}. A split-payload cut reports the index after the
 * split envelope.
 */
export function selectCut(events: readonly Message[], keepRecentChars: number): number | undefined {
  return selectCutPoint(events, keepRecentChars)?.firstKeptIndex;
}

/** The unit a compaction setting measures budgets in. */
export type CompactionUnit = "tokens" | "chars";

/**
 * The active budget unit, deterministic: TOKENS when `contextWindow` or
 * `thresholdTokens` is set (> 0), CHARS otherwise. In token mode the char
 * budgets are ignored; in char mode the token fields are ignored.
 */
export function compactionUnit(settings: CompactionSettings): CompactionUnit {
  const window = settings.contextWindow ?? 0;
  const threshold = settings.thresholdTokens ?? 0;
  return window > 0 || threshold > 0 ? "tokens" : "chars";
}

/** The auto-trigger and summary/tail budgets, in the active unit. */
export interface CompactionBudgets {
  unit: CompactionUnit;
  /** Verbatim tail budget (tokens or chars, per `unit`). */
  keepRecent: number;
  /** Summary cap (tokens or chars, per `unit`). */
  summaryCap: number;
}

/**
 * Auto-trigger budgets: verbatim tail and summary cap derived from the
 * trigger (threshold minus the reserve), so the compacted context — tail plus
 * summary — lands below the trigger and repeated compactions converge instead
 * of re-firing on every node. Derived in whichever unit is active (the char
 * derivation is unchanged from compaction v2).
 */
export function compactionBudgets(settings: CompactionSettings): CompactionBudgets {
  if (compactionUnit(settings) === "tokens") {
    const trigger = compactionTriggerTokens(settings);
    return {
      unit: "tokens",
      keepRecent: Math.min(
        settings.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS,
        Math.max(1, Math.floor(trigger / 2)),
      ),
      summaryCap: Math.max(200, Math.floor(trigger / 4)),
    };
  }
  const trigger = compactionTriggerChars(settings);
  if (trigger > 0) {
    return {
      unit: "chars",
      keepRecent: Math.min(
        settings.keepRecentChars ?? DEFAULT_KEEP_RECENT_CHARS,
        Math.max(1, Math.floor(trigger / 2)),
      ),
      summaryCap: Math.max(200, Math.floor(trigger / 4)),
    };
  }
  return {
    unit: "chars",
    keepRecent: settings.keepRecentChars ?? DEFAULT_KEEP_RECENT_CHARS,
    summaryCap: MAX_SUMMARY_CHARS,
  };
}

/**
 * The rendered-transcript size (chars) at which an auto compaction fires:
 * `thresholdChars - reserveChars`, with the reserve clamped to half the
 * threshold. 0 means "no char trigger" (unset/zero threshold, or token mode).
 */
export function compactionTriggerChars(settings: CompactionSettings): number {
  const threshold = settings.thresholdChars ?? 0;
  if (threshold <= 0) return 0;
  const requested = Math.max(0, settings.reserveChars ?? DEFAULT_RESERVE_CHARS);
  const reserve = Math.min(requested, Math.floor(threshold / 2));
  return Math.max(1, threshold - reserve);
}

/**
 * The estimated-token size at which an auto compaction fires. The threshold
 * is `thresholdTokens` when set explicitly, else `contextWindow`; the reserve
 * is `reserveTokens` (default {@link DEFAULT_RESERVE_TOKENS}) clamped to half
 * the threshold. 0 means "no token trigger" (neither field set).
 */
export function compactionTriggerTokens(settings: CompactionSettings): number {
  const explicit = settings.thresholdTokens ?? 0;
  const threshold = explicit > 0 ? explicit : (settings.contextWindow ?? 0);
  if (threshold <= 0) return 0;
  const requested = Math.max(0, settings.reserveTokens ?? DEFAULT_RESERVE_TOKENS);
  const reserve = Math.min(requested, Math.floor(threshold / 2));
  return Math.max(1, threshold - reserve);
}

/**
 * Compact `ctx` in place: summarize `events[head..cut)` through `provider`
 * and replace the context with `[task head, summary event, kept tail]`,
 * renumbered to dense `seq`; when a previous summary is part of the summarized
 * prefix it is passed as `<previous-summary>` and pi's update prompt is used.
 * The session store (when the context has one) is rewritten to the same
 * envelopes, so a compacted session file still loads and resumes like any
 * other. Returns false when there is nothing to compact. Throws on a
 * summarization failure BEFORE any state or store change — the caller keeps
 * the un-compacted context (fail-soft) — and re-throws `ProviderAbortError` so
 * a stopped run unwinds.
 */
export async function compactContext(
  ctx: SharedContext,
  provider: Provider,
  settings: CompactionSettings = {},
  signal?: AbortSignal,
): Promise<boolean> {
  const events = ctx.events;
  if (events.length === 0) return false;
  const budgets = compactionBudgets(settings);
  const cut =
    budgets.unit === "tokens"
      ? selectCutPointTokens(events, budgets.keepRecent)
      : selectCutPoint(events, budgets.keepRecent);
  if (cut === undefined) return false;

  const prefix = events.slice(0, cut.firstKeptIndex);
  // A summary envelope in the summarized prefix becomes <previous-summary>;
  // it is not repeated inside <conversation>. When the split envelope itself
  // is that summary, feeding it as <previous-summary> is the whole content —
  // no split marker is needed.
  const previousIndex = prefix.findIndex(isCompactionSummary);
  const previousSummary =
    previousIndex >= 0 ? compactionSummaryText(prefix[previousIndex]!) : undefined;
  const sourceEvents =
    previousIndex >= 0 ? prefix.filter((_, index) => index !== previousIndex) : prefix;
  const splitIndex =
    cut.splitIndex === undefined || cut.splitIndex === previousIndex
      ? undefined
      : previousIndex >= 0 && cut.splitIndex > previousIndex
        ? cut.splitIndex - 1
        : cut.splitIndex;
  const source = serializeConversation(sourceEvents, { splitIndex });

  const basePrompt = previousSummary === undefined ? SUMMARIZATION_PROMPT : UPDATE_SUMMARIZATION_PROMPT;
  let request = `<conversation>\n${source}\n</conversation>\n\n`;
  if (previousSummary !== undefined) {
    request += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
  }
  request += basePrompt;
  const raw = await provider.chat(
    [
      { role: "system", content: SUMMARIZATION_SYSTEM_PROMPT },
      { role: "user", content: request },
    ],
    "compaction",
    signal,
  );
  const trimmed = String(raw ?? "").trim();
  const summary = (
    budgets.unit === "tokens"
      ? truncateToTokens(trimmed, budgets.summaryCap)
      : trimmed.slice(0, budgets.summaryCap)
  ).trim();
  if (summary.length === 0) {
    throw new Error("summarization produced no text");
  }

  const heads = events.slice(0, headCount(events)).map((event) => ({ ...event }));
  const summaryEvent = createMessage(null, "user", "senior", "message", {
    text: `${COMPACTION_SUMMARY_PREFIX}${summary}${COMPACTION_SUMMARY_SUFFIX}`,
  });
  const kept = events.slice(cut.firstKeptIndex).map((event) => ({ ...event }));
  const rebuilt = [...heads, summaryEvent, ...kept];
  rebuilt.forEach((event, index) => {
    event.seq = index + 1;
  });
  for (const event of rebuilt) {
    const errors = validateMessage(event);
    if (errors.length > 0) {
      throw new Error(`compaction produced an invalid envelope: ${errors.join("; ")}`);
    }
  }
  if (ctx.store !== null) ctx.store.rewrite(rebuilt);
  ctx.events = rebuilt;
  return true;
}