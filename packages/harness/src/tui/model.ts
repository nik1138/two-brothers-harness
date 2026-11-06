/**
 * Block-based transcript model for the TUI.
 *
 * This is the replacement seam for the old flat line buffer. It keeps full,
 * unclipped text for every committed message and models the display units the
 * views need: user messages, role envelopes (with protocol id, role,
 * direction and streaming state), tool activities, notices and final
 * decisions.
 *
 * The reducers are pure: every function returns a new {@link TuiModel} and
 * never mutates its input. Streaming drafts are finalized by envelope identity
 * (the protocol `message.id`), so a token stream can never leave an orphan
 * partial reply beside the authoritative envelope. Nothing here clips or
 * truncates content — windowing belongs to the views.
 */
import type { Message } from "../protocol.ts";
import type { StreamEvent, StreamRole, StreamToolStatus } from "../runstream.ts";
import {
  COMPACTION_SUMMARY_PREFIX,
  COMPACTION_SUMMARY_SUFFIX,
  compactionSummaryText,
  isCompactionSummary,
} from "../compaction.ts";

// Attribution: the two exported TUI marker constants below mirror
// `packages/harness/src/compaction.ts::COMPACTION_SUMMARY_PREFIX` /
// `COMPACTION_SUMMARY_SUFFIX` and are imported from that module, never
// re-spelled, so the TUI projection cannot drift from the harness marker. A
// `<summary>` envelope is a CONTEXT event, not an operator message.
/** Mirrors `compaction.ts::COMPACTION_SUMMARY_PREFIX` (exact harness marker). */
export const TUI_COMPACTION_SUMMARY_PREFIX = COMPACTION_SUMMARY_PREFIX;
/** Mirrors `compaction.ts::COMPACTION_SUMMARY_SUFFIX` (exact harness marker). */
export const TUI_COMPACTION_SUMMARY_SUFFIX = COMPACTION_SUMMARY_SUFFIX;

/** Maximum characters of summary text kept in a transcript preview. */
export const SUMMARY_PREVIEW_CHARS = 240;

/** Collapse a summary body to one bounded, whitespace-normalized paragraph. */
function summaryPreview(body: string): string {
  const collapsed = body.split(/\s+/).filter((part) => part !== "").join(" ").trim();
  if (collapsed.length <= SUMMARY_PREVIEW_CHARS) return collapsed;
  return `${collapsed.slice(0, SUMMARY_PREVIEW_CHARS - 1)}…`;
}

/** The two model roles (the operator is represented by `user` blocks). */
export type TuiRole = "senior" | "junior";

/** Direction relative to the operator: `in` = toward the brothers. */
export type BlockDirection = "in" | "out";

/** Severity for a notice block. */
export type NoticeLevel = "info" | "warn" | "error";

/** Tool activity lifecycle. */
export type ToolStatus = "call" | "ok" | "error" | "blocked";

interface BlockBase {
  readonly id: string;
  readonly at?: string;
}

/** A message typed by the operator. */
export interface UserBlock extends BlockBase {
  readonly kind: "user";
  readonly text: string;
  /** Protocol id when the block came from a user envelope. */
  readonly messageId?: string;
}

/**
 * One role reply. `streaming` is true while token deltas are being appended;
 * `committed` becomes true when the protocol envelope arrives. A finalized
 * draft that never received its envelope has `interrupted: true`.
 */
export interface EnvelopeBlock extends BlockBase {
  readonly kind: "envelope";
  readonly messageId: string;
  readonly role: TuiRole;
  readonly direction: BlockDirection;
  readonly envelopeKind: string;
  readonly text: string;
  readonly streaming: boolean;
  readonly committed: boolean;
  readonly interrupted?: boolean;
  readonly seq?: number;
}

/** The senior's final decision, with dissent kept visually distinct. */
export interface DecisionBlock extends BlockBase {
  readonly kind: "decision";
  readonly messageId: string;
  readonly role: "senior";
  readonly direction: "out";
  readonly text: string;
  readonly rationale?: string;
  readonly dissent?: string;
  readonly confidence?: string;
  readonly streaming: boolean;
  readonly committed: boolean;
  readonly interrupted?: boolean;
  readonly seq?: number;
}

/** A tool call paired with its result when the result arrives. */
export interface ToolBlock extends BlockBase {
  readonly kind: "tool";
  readonly role: TuiRole;
  readonly tool: string;
  readonly status: ToolStatus;
  readonly callId?: string;
  readonly args?: string;
  readonly result?: string;
}

/** A system notice, warning or operator-facing error. */
export interface NoticeBlock extends BlockBase {
  readonly kind: "notice";
  readonly level: NoticeLevel;
  readonly text: string;
  readonly details?: string;
  /** Whether the app can offer a retry action for this notice. */
  readonly retryable?: boolean;
}

/**
 * A compaction-summary marker: the neutral "context compacted" block shown for
 * the harness's `<summary>…</summary>` context envelope. It is deliberately
 * NOT a {@link UserBlock} — the envelope is machine-generated context, never
 * something the operator typed — and it keeps only a bounded preview (the full
 * summary stays in the shared context, not in the transcript view).
 */
export interface SummaryBlock extends BlockBase {
  readonly kind: "summary";
  readonly messageId: string;
  /** Bounded one-paragraph preview of the summary body. */
  readonly preview: string;
  /** Character length of the full summary body (honest bound for the view). */
  readonly chars: number;
  readonly seq?: number;
}

/** Every display unit in the transcript. */
export type TuiBlock =
  | UserBlock
  | EnvelopeBlock
  | DecisionBlock
  | ToolBlock
  | NoticeBlock
  | SummaryBlock;

/** Kind of a live token delta for the active provider call. */
export type LiveTokenKind = "text" | "thinking";

/**
 * The active provider call's live reasoning buffer.
 *
 * This is deliberately NOT a transcript block: reasoning deltas are
 * observational and never part of the final reply, so the buffer is live-only
 * and dropped the moment the call settles (envelope, tool event, run end or
 * cancellation). `streaming` is true while reasoning deltas still arrive and
 * false once visible reply text has started (the reasoning is complete, the
 * call is not); a reasoning delta after that means a NEW call started and
 * replaces the buffer.
 */
export interface LiveThinking {
  readonly role: TuiRole;
  readonly text: string;
  /** True while reasoning deltas are still arriving for this call. */
  readonly streaming: boolean;
}

/** Immutable transcript document. */
export interface TuiModel {
  readonly blocks: readonly TuiBlock[];
  readonly nextId: number;
  /** Live reasoning for the active provider call, when one is streaming. */
  readonly liveThinking?: LiveThinking;
}

/** Options shared by block constructors. */
export interface BlockOptions {
  id?: string;
  at?: string;
}

/** Create an empty model, or seed it with already-built blocks. */
export function createTuiModel(blocks: readonly TuiBlock[] = []): TuiModel {
  let next = 1;
  for (const block of blocks) {
    const match = /^b(\d+)$/.exec(block.id);
    if (match !== null) next = Math.max(next, Number.parseInt(match[1] ?? "0", 10) + 1);
  }
  return { blocks: [...blocks], nextId: next };
}

/** The next generated block id (`b1`, `b2`, …), skipping used ids. */
export function nextBlockId(model: TuiModel): string {
  const used = new Set(model.blocks.map((block) => block.id));
  let index = model.nextId;
  while (used.has(`b${index}`)) index += 1;
  return `b${index}`;
}

function appendBlock(model: TuiModel, block: TuiBlock): TuiModel {
  return { ...model, blocks: [...model.blocks, block], nextId: model.nextId + 1 };
}

function makeBase(model: TuiModel, options: BlockOptions): { id: string; at?: string } {
  return {
    id: options.id ?? nextBlockId(model),
    ...(options.at !== undefined ? { at: options.at } : {}),
  };
}

/** Append an operator message. */
export function addUserBlock(
  model: TuiModel,
  text: string,
  options: BlockOptions & { messageId?: string } = {},
): TuiModel {
  const base = makeBase(model, options);
  return appendBlock(model, {
    kind: "user",
    ...base,
    text,
    ...(options.messageId !== undefined ? { messageId: options.messageId } : {}),
  });
}

/** Append a notice. `details` is kept in full for an expandable error view. */
export function addNotice(
  model: TuiModel,
  level: NoticeLevel,
  text: string,
  options: BlockOptions & { details?: string; retryable?: boolean } = {},
): TuiModel {
  const base = makeBase(model, options);
  return appendBlock(model, {
    kind: "notice",
    ...base,
    level,
    text,
    ...(options.details !== undefined ? { details: options.details } : {}),
    ...(options.retryable !== undefined ? { retryable: options.retryable } : {}),
  });
}

/** Append a tool call. */
export function addToolCall(
  model: TuiModel,
  input: {
    role: TuiRole;
    tool: string;
    callId?: string;
    args?: string;
    at?: string;
  },
): TuiModel {
  const base = makeBase(model, input.at !== undefined ? { at: input.at } : {});
  return appendBlock(model, {
    kind: "tool",
    ...base,
    role: input.role,
    tool: input.tool,
    status: "call",
    ...(input.callId !== undefined ? { callId: input.callId } : {}),
    ...(input.args !== undefined ? { args: input.args } : {}),
  });
}

/**
 * Pair a tool result with the matching open call. An explicit `callId` wins;
 * otherwise the most recent unresolved call for the same role and tool is
 * used. A result with no matching call becomes its own compact activity.
 */
export function addToolResult(
  model: TuiModel,
  input: {
    role: TuiRole;
    tool: string;
    status: Exclude<ToolStatus, "call">;
    callId?: string;
    result?: string;
    at?: string;
  },
): TuiModel {
  let match = -1;
  for (let index = model.blocks.length - 1; index >= 0; index -= 1) {
    const block = model.blocks[index];
    if (block === undefined || block.kind !== "tool" || block.status !== "call") continue;
    if (block.role !== input.role || block.tool !== input.tool) continue;
    if (input.callId !== undefined && block.callId !== input.callId) continue;
    match = index;
    break;
  }

  if (match !== -1) {
    const existing = model.blocks[match];
    if (existing === undefined || existing.kind !== "tool") return model;
    const blocks = model.blocks.slice();
    blocks[match] = {
      ...existing,
      status: input.status,
      ...(existing.callId === undefined && input.callId !== undefined
        ? { callId: input.callId }
        : {}),
      ...(input.result !== undefined ? { result: input.result } : {}),
      ...(input.at !== undefined && existing.at === undefined ? { at: input.at } : {}),
    };
    return { ...model, blocks };
  }

  const base = makeBase(model, input.at !== undefined ? { at: input.at } : {});
  return appendBlock(model, {
    kind: "tool",
    ...base,
    role: input.role,
    tool: input.tool,
    status: input.status,
    ...(input.callId !== undefined ? { callId: input.callId } : {}),
    ...(input.result !== undefined ? { result: input.result } : {}),
  });
}

// --------------------------------------------------------------------------- //
// envelope projection
// --------------------------------------------------------------------------- //

/** A protocol envelope projected onto the model's display units. */
export type ProjectedMessage =
  | {
      readonly kind: "user";
      readonly messageId: string;
      readonly direction: "in";
      readonly text: string;
      readonly seq?: number;
      readonly at?: string;
    }
  | {
      readonly kind: "summary";
      readonly messageId: string;
      readonly direction: "in";
      readonly preview: string;
      readonly chars: number;
      readonly seq?: number;
      readonly at?: string;
    }
  | {
      readonly kind: "envelope";
      readonly messageId: string;
      readonly role: TuiRole;
      readonly direction: "out";
      readonly envelopeKind: string;
      readonly text: string;
      readonly seq?: number;
      readonly at?: string;
    }
  | {
      readonly kind: "decision";
      readonly messageId: string;
      readonly role: "senior";
      readonly direction: "out";
      readonly envelopeKind: "decision";
      readonly text: string;
      readonly rationale?: string;
      readonly dissent?: string;
      readonly confidence?: string;
      readonly seq?: number;
      readonly at?: string;
    };

function textField(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  return value === undefined || value === null ? "" : String(value);
}

function optionalLine(label: string, value: string): string {
  return value.trim() === "" ? "" : `${label}: ${value}`;
}

function joinSections(sections: string[]): string {
  return sections.filter((section) => section.trim() !== "").join("\n");
}

function msgList(value: unknown, label: string): string {
  if (!Array.isArray(value) || value.length === 0) return "";
  return joinSections([`${label}:`, ...value.map((item) => `  - ${String(item)}`)]);
}

function jsonFallback(payload: Record<string, unknown>): string {
  try {
    return JSON.stringify(payload);
  } catch {
    return String(payload);
  }
}

/** Render one role envelope payload as readable full text. */
export function envelopeText(kind: string, payload: Record<string, unknown>): string {
  switch (kind) {
    case "message": {
      const text = textField(payload, "text");
      return text === "" ? jsonFallback(payload) : text;
    }
    case "consult":
      return joinSections([
        `consult: ${textField(payload, "ask")}`,
        optionalLine("expect", textField(payload, "expect")),
      ]);
    case "proposal":
      return joinSections([
        `proposal: ${textField(payload, "title")}`,
        textField(payload, "answer"),
        optionalLine("rationale", textField(payload, "rationale")),
        optionalLine("confidence", textField(payload, "confidence")),
      ]);
    case "delegation":
      return joinSections([
        `delegation: ${textField(payload, "work")}`,
        msgList(payload.acceptance, "acceptance"),
      ]);
    case "deliverable":
      return joinSections([
        `deliverable: ${textField(payload, "result")}`,
        optionalLine("confidence", textField(payload, "confidence")),
      ]);
    case "review":
      return joinSections([
        `review: ${textField(payload, "verdict")}`,
        textField(payload, "notes"),
      ]);
    case "decision":
      return textField(payload, "decision") || jsonFallback(payload);
    default:
      return `${kind}: ${jsonFallback(payload)}`;
  }
}

/**
 * Project a protocol message onto user/envelope/decision data. The payload is
 * not clipped and is never interpreted as terminal control input; the views
 * sanitize it before display.
 */
export function projectEnvelope(message: Message): ProjectedMessage {
  const payload = message.payload ?? {};
  const common = {
    messageId: message.id,
    ...(message.seq !== undefined ? { seq: message.seq } : {}),
    ...(message.ts !== undefined ? { at: message.ts } : {}),
  };

  if (message.from === "user") {
    // A compaction-summary envelope is machine-generated context, not an
    // operator message: project it as a neutral, bounded summary block.
    if (isCompactionSummary(message)) {
      const body = compactionSummaryText(message) ?? "";
      return {
        kind: "summary",
        direction: "in",
        preview: summaryPreview(body),
        chars: body.length,
        ...common,
      };
    }
    const text = textField(payload, "text");
    return {
      kind: "user",
      direction: "in",
      text: text === "" ? jsonFallback(payload) : text,
      ...common,
    };
  }

  const role: TuiRole = message.from === "junior" ? "junior" : "senior";
  if (message.kind === "decision") {
    return {
      kind: "decision",
      role: "senior",
      direction: "out",
      envelopeKind: "decision",
      text: textField(payload, "decision") || jsonFallback(payload),
      ...(textField(payload, "rationale") !== ""
        ? { rationale: textField(payload, "rationale") }
        : {}),
      ...(textField(payload, "dissent") !== "" ? { dissent: textField(payload, "dissent") } : {}),
      ...(textField(payload, "confidence") !== ""
        ? { confidence: textField(payload, "confidence") }
        : {}),
      ...common,
    };
  }
  return {
    kind: "envelope",
    role,
    direction: "out",
    envelopeKind: message.kind,
    text: envelopeText(message.kind, payload),
    ...common,
  };
}

/** True for a block that is still receiving token deltas. */
export function isStreamingBlock(block: TuiBlock): block is EnvelopeBlock | DecisionBlock {
  return (block.kind === "envelope" || block.kind === "decision") && block.streaming;
}

/** Drop the live reasoning buffer (a settled call, run end or cancellation). */
export function clearLiveThinking(model: TuiModel): TuiModel {
  return model.liveThinking === undefined ? model : { ...model, liveThinking: undefined };
}

/**
 * Fold one reasoning delta into the live-thinking buffer.
 *
 * A same-role reasoning delta while the previous delta was also reasoning
 * appends. Anything else means a new provider call started: a reasoning delta
 * after visible reply text (`text → thinking`), or a role switch, replaces the
 * buffer instead of concatenating. The completed transcript is always the
 * envelope; the buffer never enters `blocks`.
 */
function appendThinkingDelta(
  model: TuiModel,
  input: { role: TuiRole; delta: string },
): TuiModel {
  if (input.delta === "") return model;
  const current = model.liveThinking;
  if (current !== undefined && current.role === input.role && current.streaming) {
    return {
      ...model,
      liveThinking: { role: current.role, text: current.text + input.delta, streaming: true },
    };
  }
  return {
    ...model,
    liveThinking: { role: input.role, text: input.delta, streaming: true },
  };
}

/** Visible reply text started: the active call's reasoning is complete. */
function markThinkingComplete(model: TuiModel): TuiModel {
  const current = model.liveThinking;
  if (current === undefined || !current.streaming) return model;
  return { ...model, liveThinking: { ...current, streaming: false } };
}

function findDraftIndex(
  blocks: readonly TuiBlock[],
  role: TuiRole,
  direction: BlockDirection,
  messageId?: string,
): number {
  if (messageId !== undefined) {
    const byId = blocks.findIndex(
      (block) =>
        (block.kind === "envelope" || block.kind === "decision") &&
        block.streaming &&
        block.messageId === messageId,
    );
    if (byId !== -1) return byId;
  }
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (
      block !== undefined &&
      block.kind === "envelope" &&
      block.streaming &&
      block.role === role &&
      block.direction === direction
    ) {
      return index;
    }
  }
  return -1;
}

/** Start an empty streaming draft if one does not already exist. */
export function startEnvelopeDraft(
  model: TuiModel,
  input: { role: TuiRole; direction?: BlockDirection; messageId?: string; at?: string },
): TuiModel {
  const direction = input.direction ?? "out";
  if (findDraftIndex(model.blocks, input.role, direction, input.messageId) !== -1) return model;
  if (
    input.messageId !== undefined &&
    model.blocks.some(
      (block) =>
        (block.kind === "envelope" || block.kind === "decision") &&
        block.messageId === input.messageId,
    )
  ) {
    return model;
  }
  const id = nextBlockId(model);
  return appendBlock(model, {
    kind: "envelope",
    id,
    messageId: input.messageId ?? `draft:${id}`,
    role: input.role,
    direction,
    envelopeKind: "streaming",
    text: "",
    streaming: true,
    committed: false,
    ...(input.at !== undefined ? { at: input.at } : {}),
  });
}

/**
 * Append a text delta to the matching streaming draft. Identity matching uses
 * an explicit `messageId` first, then the newest draft for the same role and
 * direction. Committed content is never modified and is never clipped.
 */
export function appendEnvelopeDelta(
  model: TuiModel,
  input: {
    role: TuiRole;
    delta: string;
    messageId?: string;
    direction?: BlockDirection;
    at?: string;
  },
): TuiModel {
  if (input.delta === "") return model;
  const direction = input.direction ?? "out";
  const index = findDraftIndex(model.blocks, input.role, direction, input.messageId);
  if (index !== -1) {
    const block = model.blocks[index];
    if (block === undefined || block.kind !== "envelope") return model;
    const blocks = model.blocks.slice();
    blocks[index] = { ...block, text: block.text + input.delta, streaming: true };
    return { ...model, blocks };
  }

  if (
    input.messageId !== undefined &&
    model.blocks.some(
      (block) =>
        (block.kind === "envelope" || block.kind === "decision") &&
        block.messageId === input.messageId,
    )
  ) {
    // A late delta for an already-committed envelope must not create an
    // orphan draft beside the authoritative reply.
    return model;
  }

  const id = nextBlockId(model);
  return appendBlock(model, {
    kind: "envelope",
    id,
    messageId: input.messageId ?? `draft:${id}`,
    role: input.role,
    direction,
    envelopeKind: "streaming",
    text: input.delta,
    streaming: true,
    committed: false,
    ...(input.at !== undefined ? { at: input.at } : {}),
  });
}

function replaceOrAppend(
  model: TuiModel,
  index: number,
  block: TuiBlock,
): TuiModel {
  if (index === -1) return appendBlock(model, block);
  const previous = model.blocks[index];
  const id = previous?.id ?? block.id;
  const blocks = model.blocks.slice();
  blocks[index] = { ...block, id };
  return { ...model, blocks };
}

/**
 * Commit a protocol envelope. A matching streaming draft is replaced in place
 * (by message id, then by role/direction), so the committed text is exact and
 * no partial prefix survives. Duplicate commits are idempotent, and the
 * harness's echo of the operator task does not duplicate the local user block.
 */
export function commitEnvelope(model: TuiModel, message: Message): TuiModel {
  const projected = projectEnvelope(message);

  if (projected.kind === "summary") {
    // Idempotent by message id; a summary never merges into a user block.
    const index = model.blocks.findIndex(
      (block) => block.kind === "summary" && block.messageId === projected.messageId,
    );
    const id = index === -1 ? nextBlockId(model) : model.blocks[index]?.id ?? nextBlockId(model);
    const block: SummaryBlock = {
      kind: "summary",
      id,
      messageId: projected.messageId,
      preview: projected.preview,
      chars: projected.chars,
      ...(projected.seq !== undefined ? { seq: projected.seq } : {}),
      ...(projected.at !== undefined ? { at: projected.at } : {}),
    };
    return replaceOrAppend(model, index, block);
  }

  if (projected.kind === "user") {
    const last = model.blocks[model.blocks.length - 1];
    if (
      last !== undefined &&
      last.kind === "user" &&
      (last.messageId === projected.messageId ||
        (last.messageId === undefined && last.text === projected.text))
    ) {
      if (last.messageId === projected.messageId) return model;
      const blocks = model.blocks.slice();
      blocks[blocks.length - 1] = {
        ...last,
        messageId: projected.messageId,
        ...(projected.at !== undefined && last.at === undefined ? { at: projected.at } : {}),
      };
      return { ...model, blocks };
    }
    const existingUser = model.blocks.findIndex(
      (block) => block.kind === "user" && block.messageId === projected.messageId,
    );
    if (existingUser !== -1) return model;
    const base = makeBase(model, {
      ...(projected.at !== undefined ? { at: projected.at } : {}),
    });
    return appendBlock(model, {
      kind: "user",
      ...base,
      text: projected.text,
      messageId: projected.messageId,
    });
  }

  let index = model.blocks.findIndex(
    (block) =>
      (block.kind === "envelope" || block.kind === "decision") &&
      block.messageId === projected.messageId,
  );
  if (index === -1) {
    index = findDraftIndex(model.blocks, projected.role, "out");
  }
  const id = index === -1 ? nextBlockId(model) : model.blocks[index]?.id ?? nextBlockId(model);

  if (projected.kind === "decision") {
    const block: DecisionBlock = {
      kind: "decision",
      id,
      messageId: projected.messageId,
      role: "senior",
      direction: "out",
      text: projected.text,
      streaming: false,
      committed: true,
      ...(projected.rationale !== undefined ? { rationale: projected.rationale } : {}),
      ...(projected.dissent !== undefined ? { dissent: projected.dissent } : {}),
      ...(projected.confidence !== undefined ? { confidence: projected.confidence } : {}),
      ...(projected.seq !== undefined ? { seq: projected.seq } : {}),
      ...(projected.at !== undefined ? { at: projected.at } : {}),
    };
    return replaceOrAppend(model, index, block);
  }

  const block: EnvelopeBlock = {
    kind: "envelope",
    id,
    messageId: projected.messageId,
    role: projected.role,
    direction: projected.direction,
    envelopeKind: projected.envelopeKind,
    text: projected.text,
    streaming: false,
    committed: true,
    ...(projected.seq !== undefined ? { seq: projected.seq } : {}),
    ...(projected.at !== undefined ? { at: projected.at } : {}),
  };
  return replaceOrAppend(model, index, block);
}

/** Alias used by stream-projection callers. */
export const addEnvelope = commitEnvelope;

/**
 * Finalize every active draft. Empty drafts are dropped; non-empty partials
 * keep their full text and are marked `interrupted` so the view can say so
 * instead of pretending the reply completed.
 */
export function finalizeStreamingDrafts(
  model: TuiModel,
  options: { dropEmpty?: boolean } = {},
): TuiModel {
  const dropEmpty = options.dropEmpty ?? true;
  let changed = false;
  const blocks: TuiBlock[] = [];
  for (const block of model.blocks) {
    if (!isStreamingBlock(block)) {
      blocks.push(block);
      continue;
    }
    changed = true;
    if (dropEmpty && block.text.trim() === "") continue;
    blocks.push({
      ...block,
      streaming: false,
      committed: false,
      interrupted: true,
    });
  }
  return changed ? { ...model, blocks } : model;
}

/** Result of folding one stream event into the model. */
export interface ModelReduceResult {
  model: TuiModel;
  /** Status-bar text implied by the event, when there is one. */
  status?: string;
}

/** Additive event detail not carried by the current `StreamEvent` shape. */
export interface ModelReduceOptions {
  /** Optional additive tool call id (T3's forward-compatible field). */
  callId?: string;
  /** Optional tool arguments, already rendered as text. */
  args?: string;
  /** Optional tool result detail, already rendered as text. */
  resultText?: string;
  /** Override the event timestamp. */
  at?: string;
}

function roleOf(role: StreamRole): TuiRole {
  return role === "junior" ? "junior" : "senior";
}

function toolStatus(status: StreamToolStatus): Exclude<ToolStatus, "call"> {
  return status;
}

/**
 * Fold one run stream event into the block model. Pure and deterministic:
 * token deltas extend drafts by kind (text → the response draft, thinking → a
 * live-only reasoning buffer), envelopes commit drafts and settle the live
 * buffers, tool events pair, and a terminal run state finalizes any draft that
 * never received its envelope. Missing/unknown token kinds are treated as
 * `"text"` for forward/backward compatibility.
 */
export function reduceModelEvent(
  model: TuiModel,
  event: StreamEvent,
  options: ModelReduceOptions = {},
): ModelReduceResult {
  const at = options.at ?? event.at;
  switch (event.type) {
    case "token": {
      const kind: LiveTokenKind = event.kind === "thinking" ? "thinking" : "text";
      if (kind === "thinking") {
        return {
          model: appendThinkingDelta(model, {
            role: roleOf(event.role),
            delta: event.delta,
          }),
        };
      }
      return {
        model: markThinkingComplete(
          appendEnvelopeDelta(model, {
            role: roleOf(event.role),
            delta: event.delta,
            ...(at !== undefined ? { at } : {}),
          }),
        ),
      };
    }
    case "envelope":
      return { model: commitEnvelope(clearLiveThinking(model), event.envelope) };
    case "tool_call":
      if (event.role === "user") return { model: clearLiveThinking(model) };
      return {
        model: addToolCall(clearLiveThinking(model), {
          role: roleOf(event.role),
          tool: event.tool,
          ...(event.callId ?? options.callId) !== undefined
            ? { callId: event.callId ?? options.callId }
            : {},
          ...(event.args ?? options.args) !== undefined
            ? { args: event.args ?? options.args }
            : {},
          ...(at !== undefined ? { at } : {}),
        }),
      };
    case "tool_result":
      if (event.role === "user") return { model: clearLiveThinking(model) };
      return {
        model: addToolResult(clearLiveThinking(model), {
          role: roleOf(event.role),
          tool: event.tool,
          status: toolStatus(event.status),
          ...(event.callId ?? options.callId) !== undefined
            ? { callId: event.callId ?? options.callId }
            : {},
          ...(event.result ?? options.resultText) !== undefined
            ? { result: event.result ?? options.resultText }
            : {},
          ...(at !== undefined ? { at } : {}),
        }),
      };
    case "repair":
      return {
        model: addNotice(
          clearLiveThinking(model),
          "warn",
          `repair: ${event.role} ${event.kind} reply re-asked (strict payload check)`,
          at !== undefined ? { at } : {},
        ),
      };
    case "run_status": {
      if (
        event.status === "completed" ||
        event.status === "failed" ||
        event.status === "cancelled"
      ) {
        return {
          model: finalizeStreamingDrafts(clearLiveThinking(model)),
          status:
            event.status === "completed"
              ? "ready — turn completed"
              : event.status === "cancelled"
                ? "turn cancelled"
                : "turn failed — the session is still open",
        };
      }
      return { model: clearLiveThinking(model), status: "running…" };
    }
    case "result": {
      const usage = event.result.usage ?? {};
      const input = Number(usage.input_tokens ?? 0) || 0;
      const output = Number(usage.output_tokens ?? 0) || 0;
      return {
        model: finalizeStreamingDrafts(clearLiveThinking(model)),
        status: `ready — ${input}/${output} tokens (in/out)`,
      };
    }
    default:
      return { model };
  }
}

/** Find a block by its document id. */
export function findBlock(model: TuiModel, id: string): TuiBlock | undefined {
  return model.blocks.find((block) => block.id === id);
}

/** The full plain text represented by a block (used by tests and exports). */
export function blockText(block: TuiBlock): string {
  switch (block.kind) {
    case "user":
      return block.text;
    case "envelope":
      return block.text;
    case "decision":
      return joinSections([
        block.text,
        block.rationale ?? "",
        block.dissent ?? "",
        block.confidence ?? "",
      ]);
    case "tool":
      return [block.args ?? "", block.result ?? ""].filter((part) => part !== "").join("\n");
    case "notice":
      return [block.text, block.details ?? ""].filter((part) => part !== "").join("\n");
    case "summary":
      return block.preview;
    default:
      return "";
  }
}

/**
 * Seed a model with the compaction-summary markers of a restored context.
 *
 * A resumed compacted session always contains exactly the harness marker
 * envelope(s); they must render as neutral system blocks (never as an operator
 * message), so the app seeds the transcript view with them instead of replaying
 * the whole context. An uncompacted context yields the empty model (byte-
 * identical to the pre-summary behavior).
 */
export function createCompactionSummaryModel(events: readonly Message[]): TuiModel {
  let model = createTuiModel();
  for (const event of events) {
    if (isCompactionSummary(event)) model = commitEnvelope(model, event);
  }
  return model;
}