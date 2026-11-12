import { chatProjectionGeneration } from './chat'
import type { ChatItem } from './chat'
import type { ApprovalDetail, RunEvent, TodoItem, TodoStatus, ToolResultCompact } from './types'

// Projection of typed runtime events (tool calls, approvals, prompt audits,
// replayed reasoning) into group-chat items. Components consume RuntimeItem /
// TimelineEntry and never touch raw runtime events. Envelope handling stays in
// chat.ts.

export interface ToolActivityItem {
  type: 'tool'
  id: string
  /** Who ran the tool; the backend rarely sets `actor` — tools belong to the junior. */
  actor: 'senior' | 'junior'
  tool: string
  args: Record<string, unknown>
  at: number
  runId: string
  /** 'running' until the matching tool_completed arrives. */
  status: string
  result: unknown
  /** Unix seconds of the matching tool_completed (contract: tool cards show elapsed time). */
  finishedAt?: number
}

export interface ApprovalItem {
  type: 'approval'
  approvalId: string
  action: string
  target: string
  command: string | null
  at: number
  runId: string
  /** 'allow' | 'deny' once the matching approval_resolved arrives. */
  decision?: string
  reason?: string
  /**
   * Additive bounded preview of the pending mutation (diff/command), when the
   * backend sent one. Plain strings only — the card renders them as text.
   */
  detail?: ApprovalDetail
  /**
   * Additive helper identity: set only when an isolated helper's tool call
   * parked this request. Old backends omit both fields.
   */
  subagentId?: string
  subagentLabel?: string
}

/**
 * One provider call's prompt/tool-belt audit row: role, node kind, section and
 * tool counts, prompt char lengths — plus the name lists for the expanded view.
 * Never carries prompt bodies (the backend does not send them).
 */
export interface PromptAuditItem {
  type: 'prompt_audit'
  id: string
  role: 'senior' | 'junior'
  kind: string
  sections: string[]
  tools: string[]
  systemChars: number
  userChars: number
  at: number
  runId: string
}

/**
 * One replayed reasoning (thinking) record from the runtime sidecar: the
 * bounded, sanitized reasoning one provider call produced. Display-only and
 * collapsed by default in the transcript; it never enters the shared context
 * (the backend deliberately keeps it out of the protocol envelopes).
 */
export interface ReasoningItem {
  type: 'reasoning'
  id: string
  role: 'senior' | 'junior'
  /** Node kind the call answered (consult / proposal / review / decision / …). */
  kind: string
  /** Sanitized, bounded plain reasoning text — rendered as text, never markup. */
  text: string
  /** True when the backend (or this projection) clipped the stream. */
  truncated: boolean
  at: number
  runId: string
}

export type RuntimeItem = ToolActivityItem | ApprovalItem | PromptAuditItem | ReasoningItem

export interface TimelineEntry {
  time: number
  order: number
  entry: ChatItem | RuntimeItem
}

export interface ChangedFile {
  path: string
  tool: string
  added: number
  removed: number
  unified: string
  at: number
}

/**
 * Exact dedupe key across the sidecar and the live stream. The backend
 * persists the very dict it emits, so a sidecar event and its live twin
 * stringify identically once parsed.
 */
export function runtimeDedupeKey(ev: RunEvent): string {
  return JSON.stringify(ev)
}

// -- replayed reasoning (additive, tolerant) ---------------------------------

/**
 * Bound on one replayed reasoning text kept in the DOM, in characters. Mirrors
 * the backend's `REASONING_EVENT_MAX_CHARS` (10k); a value from an old or
 * hand-written sidecar is clipped here too, so the browser never holds an
 * unbounded reasoning blob. Head+tail with the shared truncation marker.
 */
export const REASONING_REPLAY_MAX_CHARS = 10_000

/** Whole ANSI escape sequences (mirrors the backend output sanitizer). */
const REASONING_ESCAPE =
  /\x1b[\]PX^_][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]|\x1b[\x20-\x2f]*[\x30-\x7e]/g
/** Control bytes that break display; newlines and tabs are kept. */
const REASONING_CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/g

/**
 * Tolerant display copy of one replayed reasoning payload. Returns null when
 * there is no usable text (missing, non-string, blank after sanitizing);
 * otherwise the ANSI/control-sanitized text bounded head+tail at
 * {@link REASONING_REPLAY_MAX_CHARS}. Never throws, so a malformed or
 * hand-written sidecar row can never break the transcript.
 */
export function reasoningTextOf(value: unknown): { text: string; truncated: boolean } | null {
  if (typeof value !== 'string' || value === '') return null
  const cleaned = value.replace(REASONING_ESCAPE, '').replace(REASONING_CONTROL, '')
  if (cleaned.trim() === '') return null
  if (cleaned.length <= REASONING_REPLAY_MAX_CHARS) return { text: cleaned, truncated: false }
  const head = Math.ceil(REASONING_REPLAY_MAX_CHARS / 2)
  const tail = Math.floor(REASONING_REPLAY_MAX_CHARS / 2)
  return {
    text:
      cleaned.slice(0, head) +
      `\n...[truncated ${cleaned.length - REASONING_REPLAY_MAX_CHARS} chars]...\n` +
      cleaned.slice(cleaned.length - tail),
    truncated: true,
  }
}

// Incremental projection state: runtime events only ever append, and pairing is
// stateful (a per-tool FIFO of open call indexes plus the approval map), so the
// same state that produced the full array can feed new events in O(1).
//
// `items` is index-stable: rows are appended or replaced, never removed.
// Resolving a pair replaces the item with a fresh object (the pairing maps keep
// indexes, not object references) instead of mutating it, because
// ToolActivity/ApprovalCard receive these objects as props and Vue skips a
// child update whose prop reference is unchanged.
interface RuntimeProjectionState {
  seen: RunEvent[]
  items: RuntimeItem[]
  /** Per-tool FIFO of indexes into `items` for calls awaiting a completion. */
  openTools: Map<string, number[]>
  /** approval_id -> index into `items`. */
  approvals: Map<string, number>
  n: number
  snapshot: RuntimeItem[] | null
}

function freshRuntimeState(): RuntimeProjectionState {
  return {
    seen: [],
    items: [],
    openTools: new Map(),
    approvals: new Map(),
    n: 0,
    snapshot: null,
  }
}

let runtimeState = freshRuntimeState()
let runtimeGeneration = 0

/**
 * Bumped on every full rebuild (session load / cleared sidecar). mergeTimeline
 * uses it to distinguish "same projection, appended or replaced rows" from "a
 * different transcript".
 */
export function runtimeProjectionGeneration(): number {
  return runtimeGeneration
}

/** Pair one runtime event into the projection (the body of the full-pass loop). */
function appendToRuntimeProjection(state: RuntimeProjectionState, ev: RunEvent) {
  switch (ev.type) {
    case 'tool_started': {
      const item: ToolActivityItem = {
        type: 'tool',
        id: `${ev.run_id}:tool:${state.n++}`,
        actor: ev.actor === 'senior' ? 'senior' : 'junior',
        tool: ev.tool,
        args: ev.args ?? {},
        at: ev.at,
        runId: ev.run_id,
        status: 'running',
        result: null,
      }
      const index = state.items.length
      state.items.push(item)
      const queue = state.openTools.get(ev.tool)
      if (queue) queue.push(index)
      else state.openTools.set(ev.tool, [index])
      break
    }
    case 'tool_completed': {
      const queue = state.openTools.get(ev.tool)
      const index = queue && queue.length ? queue.shift()! : undefined
      if (index !== undefined) {
        const open = state.items[index] as ToolActivityItem
        state.items[index] = {
          ...open,
          status: ev.status,
          result: ev.result,
          finishedAt: ev.at,
        }
      } else {
        state.items.push({
          type: 'tool',
          id: `${ev.run_id}:tool:${state.n++}`,
          actor: ev.actor === 'senior' ? 'senior' : 'junior',
          tool: ev.tool,
          args: {},
          at: ev.at,
          runId: ev.run_id,
          status: ev.status,
          result: ev.result,
          finishedAt: ev.at,
        })
      }
      break
    }
    case 'approval_requested': {
      const detail = approvalDetailOf(ev.detail)
      const subagentId = childFieldOf(ev.subagent_id)
      const subagentLabel = childFieldOf(ev.subagent_label)
      const item: ApprovalItem = {
        type: 'approval',
        approvalId: ev.approval_id,
        action: ev.action,
        target: ev.target,
        command: ev.command ?? null,
        reason: ev.reason ?? undefined,
        at: ev.at,
        runId: ev.run_id,
        ...(detail !== undefined ? { detail } : {}),
        ...(subagentId !== undefined ? { subagentId } : {}),
        ...(subagentLabel !== undefined ? { subagentLabel } : {}),
      }
      state.approvals.set(ev.approval_id, state.items.length)
      state.items.push(item)
      break
    }
    case 'approval_resolved': {
      const index = state.approvals.get(ev.approval_id)
      if (index !== undefined) {
        const open = state.items[index] as ApprovalItem
        state.items[index] = {
          ...open,
          decision: ev.decision,
          // Keep the request's honest reason when the resolution carries none
          // (normal allow/deny); a cancellation reason wins when present.
          reason: ev.reason ?? open.reason,
        }
      } else {
        state.items.push({
          type: 'approval',
          approvalId: ev.approval_id,
          action: '',
          target: '',
          command: null,
          at: ev.at,
          runId: ev.run_id,
          decision: ev.decision,
          reason: ev.reason ?? undefined,
        })
      }
      break
    }
    case 'prompt_audit': {
      state.items.push({
        type: 'prompt_audit',
        id: `${ev.run_id}:audit:${state.n++}`,
        role: ev.role === 'senior' ? 'senior' : 'junior',
        kind: ev.kind,
        sections: Array.isArray(ev.sections) ? ev.sections.map(String) : [],
        tools: Array.isArray(ev.tools) ? ev.tools.map(String) : [],
        systemChars: Number(ev.systemChars) || 0,
        userChars: Number(ev.userChars) || 0,
        at: ev.at,
        runId: ev.run_id,
      })
      break
    }
    case 'reasoning': {
      // Streaming-only records; an old backend simply never sends them, and a
      // malformed row (no usable text) is dropped instead of rendering a lie.
      const text = reasoningTextOf(ev.text)
      if (text === null) break
      state.items.push({
        type: 'reasoning',
        id: `${ev.run_id}:reasoning:${state.n++}`,
        role: ev.role === 'senior' ? 'senior' : 'junior',
        kind: typeof ev.kind === 'string' ? ev.kind : '',
        text: text.text,
        truncated: ev.truncated === true || text.truncated,
        at: ev.at,
        runId: ev.run_id,
      })
      break
    }
  }
}

function runtimeSnapshot(): RuntimeItem[] {
  if (!runtimeState.snapshot) runtimeState.snapshot = runtimeState.items.slice()
  return runtimeState.snapshot
}

function looksAppended(prev: RunEvent[], next: RunEvent[]): boolean {
  if (next.length < prev.length) return false
  if (prev.length === 0) return true
  return next[0] === prev[0] && next[prev.length - 1] === prev[prev.length - 1]
}

function isPrefix(short: RunEvent[], long: RunEvent[]): boolean {
  if (short.length > long.length) return false
  for (let i = 0; i < short.length; i += 1) {
    if (short[i] !== long[i]) return false
  }
  return true
}

/** Reset the incremental runtime projection (session load / cleared history). */
export function resetRuntimeProjection(events: RunEvent[] = []): void {
  runtimeGeneration += 1
  runtimeState = freshRuntimeState()
  runtimeState.seen = events.slice()
  for (const ev of events) appendToRuntimeProjection(runtimeState, ev)
  runtimeState.snapshot = null
}

function syncRuntimeProjection(events: RunEvent[]): void {
  if (events === runtimeState.seen) return
  if (events.length === 0) {
    if (runtimeState.seen.length > 0) resetRuntimeProjection([])
    return
  }
  if (looksAppended(runtimeState.seen, events)) {
    const start = runtimeState.seen.length
    if (start < events.length) {
      for (let i = start; i < events.length; i += 1) {
        const ev = events[i]
        appendToRuntimeProjection(runtimeState, ev)
        runtimeState.seen.push(ev)
      }
      runtimeState.snapshot = null
    }
    return
  }
  if (events.length < runtimeState.seen.length && isPrefix(events, runtimeState.seen)) return
  resetRuntimeProjection(events)
}

/**
 * Pair tool_started/tool_completed and approval_requested/approval_resolved
 * events. Append-only input is paired incrementally; a replaced event list
 * (session load) rebuilds from scratch.
 */
export function projectRuntimeEvents(events: RunEvent[]): RuntimeItem[] {
  syncRuntimeProjection(events)
  return runtimeSnapshot()
}

/**
 * Incremental feed for live runtime events (contract with App.vue): pair one
 * event into the cached projection. Prime with projectRuntimeEvents() first,
 * then read the result through currentRuntimeItems().
 */
export function appendRuntimeEvent(ev: RunEvent): void {
  runtimeState.seen.push(ev)
  appendToRuntimeProjection(runtimeState, ev)
  runtimeState.snapshot = null
}

/** Current projected runtime items after appendRuntimeEvent() calls. */
export function currentRuntimeItems(): RuntimeItem[] {
  return runtimeSnapshot()
}

function chatItemTime(item: ChatItem): number {
  if (item.type === 'divider') return 0
  if (item.type === 'system') {
    const t = Date.parse(item.activity.ts)
    return Number.isNaN(t) ? 0 : t
  }
  const t = Date.parse(item.group.startTs)
  return Number.isNaN(t) ? 0 : t
}

/**
 * Interleave projected envelopes and runtime items chronologically. The sort
 * key is (time, source, source-local index): chat rows always precede runtime
 * rows on equal timestamps, which is exactly the ordering the previous
 * concatenate-then-sort produced.
 *
 * Within one projection generation the source rows are index-stable: a live
 * update appends rows or replaces one at its index (a paired tool completion, a
 * message joined to the open group). The merged array is therefore updated by
 * swapping the affected TimelineEntry and inserting only new rows — no re-sort
 * and no re-projection. A generation change (session load) rebuilds.
 */
interface MergeState {
  chatGeneration: number
  runtimeGeneration: number
  items: ChatItem[]
  runtime: RuntimeItem[]
  merged: TimelineEntry[]
}

let mergeState: MergeState | null = null

/** 0 = chat projection row, 1 = runtime row (the old tie-break order). */
function entrySource(entry: TimelineEntry['entry']): 0 | 1 {
  return entry.type === 'tool' ||
    entry.type === 'approval' ||
    entry.type === 'prompt_audit' ||
    entry.type === 'reasoning'
    ? 1
    : 0
}

function compareEntries(a: TimelineEntry, b: TimelineEntry): number {
  return a.time - b.time || entrySource(a.entry) - entrySource(b.entry) || a.order - b.order
}

function insertEntry(merged: TimelineEntry[], entry: TimelineEntry): void {
  // Live events almost always land at the tail; a divider (time 0) does not.
  if (merged.length === 0 || compareEntries(merged[merged.length - 1], entry) < 0) {
    merged.push(entry)
    return
  }
  let lo = 0
  let hi = merged.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (compareEntries(merged[mid], entry) < 0) lo = mid + 1
    else hi = mid
  }
  merged.splice(lo, 0, entry)
}

function rebuildTimeline(items: ChatItem[], runtime: RuntimeItem[]): TimelineEntry[] {
  const merged: TimelineEntry[] = []
  items.forEach((entry, i) => merged.push({ time: chatItemTime(entry), order: i, entry }))
  runtime.forEach((entry, j) => merged.push({ time: entry.at * 1000, order: j, entry }))
  merged.sort(compareEntries)
  return merged
}

/** Interleave projected envelopes and runtime items chronologically. */
export function mergeTimeline(items: ChatItem[], runtime: RuntimeItem[]): TimelineEntry[] {
  const prev = mergeState
  const chatGen = chatProjectionGeneration()
  const runtimeGen = runtimeProjectionGeneration()
  if (
    prev &&
    prev.chatGeneration === chatGen &&
    prev.runtimeGeneration === runtimeGen &&
    prev.items === items &&
    prev.runtime === runtime
  ) {
    return prev.merged
  }

  let merged: TimelineEntry[]
  if (
    prev &&
    prev.chatGeneration === chatGen &&
    prev.runtimeGeneration === runtimeGen &&
    items.length >= prev.items.length &&
    runtime.length >= prev.runtime.length
  ) {
    merged = prev.merged.slice()
    // Updated source rows carry fresh objects at their old index; swap the
    // matching TimelineEntry so the row's item prop gets a new reference.
    // Updated rows keep their timestamp, so the sorted position is unchanged.
    const positions = new Map<TimelineEntry['entry'], number>()
    prev.merged.forEach((row, i) => positions.set(row.entry, i))
    for (let i = 0; i < prev.items.length; i += 1) {
      const item = items[i]
      if (prev.items[i] === item) continue
      const at = positions.get(prev.items[i])
      if (at === undefined) continue
      merged[at] = { time: chatItemTime(item), order: i, entry: item }
    }
    for (let j = 0; j < prev.runtime.length; j += 1) {
      const item = runtime[j]
      if (prev.runtime[j] === item) continue
      const at = positions.get(prev.runtime[j])
      if (at === undefined) continue
      merged[at] = { time: item.at * 1000, order: j, entry: item }
    }
    // Only rows past the previous lengths are genuinely new.
    for (let i = prev.items.length; i < items.length; i += 1) {
      insertEntry(merged, { time: chatItemTime(items[i]), order: i, entry: items[i] })
    }
    for (let j = prev.runtime.length; j < runtime.length; j += 1) {
      insertEntry(merged, { time: runtime[j].at * 1000, order: j, entry: runtime[j] })
    }
  } else {
    merged = rebuildTimeline(items, runtime)
  }

  mergeState = {
    chatGeneration: chatGen,
    runtimeGeneration: runtimeGen,
    items,
    runtime,
    merged,
  }
  return merged
}

function asCompact(result: unknown): ToolResultCompact | null {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null
  return result as ToolResultCompact
}

/** Files written/edited by workspace tools, in chronological order. */
export function changedFilesOf(runtime: RuntimeItem[]): ChangedFile[] {
  const files: ChangedFile[] = []
  for (const item of runtime) {
    if (item.type !== 'tool') continue
    const compact = asCompact(item.result)
    if (!compact?.diff?.unified) continue
    files.push({
      path: compact.path ?? String(item.args.path ?? 'changes'),
      tool: item.tool,
      added: compact.diff.added_lines ?? 0,
      removed: compact.diff.removed_lines ?? 0,
      unified: compact.diff.unified,
      at: item.at,
    })
  }
  return files
}

// -- approval detail preview (pure, additive) --------------------------------

/**
 * Bound on one preview text kept in the DOM, in characters. Mirrors the
 * package's `APPROVAL_DETAIL_MAX_CHARS`; a value from an old/hostile backend is
 * clipped here so the browser never holds an unbounded diff.
 */
export const APPROVAL_PREVIEW_MAX_CHARS = 20_000

/** One plain-text preview group for the approval card. */
export interface ApprovalPreview {
  /** Action kind the detail described (`write`/`edit`/`delete`/`shell`). */
  kind: string
  /** Plain text for a `<pre>` — a unified diff or a shell command, never markup. */
  text: string
  /** Diff line counts, when the backend reported them. */
  added?: number
  removed?: number
  /** True when the backend clipped the detail or this projection clipped it. */
  truncated: boolean
  /** What the preview shows, for the honest toggle label. */
  noun: 'change' | 'command'
}

/** Bound one preview text; returns the clipped text and whether it clipped. */
function previewText(text: string): { text: string; clipped: boolean } {
  if (text.length <= APPROVAL_PREVIEW_MAX_CHARS) return { text, clipped: false }
  return { text: `${text.slice(0, APPROVAL_PREVIEW_MAX_CHARS - 1)}…`, clipped: true }
}

function nonNegativeInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined
}

/**
 * Tolerant copy of one additive approval detail. A value that does not match
 * the typed shape becomes `undefined`; invalid individual fields are dropped
 * while the valid ones survive; diff/command text is bounded. Never throws, so
 * an old backend (no `detail`) or a malformed payload never breaks a card.
 */
export function approvalDetailOf(value: unknown): ApprovalDetail | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const kind = typeof record.kind === 'string' ? record.kind.trim() : ''
  if (kind === '') return undefined
  const detail: ApprovalDetail = { kind }
  let truncated = record.truncated === true
  if (typeof record.diff === 'string' && record.diff !== '') {
    const clipped = previewText(record.diff)
    detail.diff = clipped.text
    if (clipped.clipped) truncated = true
  }
  if (typeof record.command === 'string' && record.command !== '') {
    const clipped = previewText(record.command)
    detail.command = clipped.text
    if (clipped.clipped) truncated = true
  }
  const added = nonNegativeInt(record.addedLines)
  if (added !== undefined) detail.addedLines = added
  const removed = nonNegativeInt(record.removedLines)
  if (removed !== undefined) detail.removedLines = removed
  if (truncated) detail.truncated = true
  return detail
}

/**
 * Tolerant display copy of one additive helper-identity field. Old backends
 * omit the field and a malformed one renders nothing (the card stays exactly
 * as it was). Bounded so a hand-written event cannot grow the row.
 */
function childFieldOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed.slice(0, 200)
}

/**
 * The render-ready preview of one approval detail, or null when there is
 * nothing to show (no detail, unknown shape, or a detail without diff/command
 * text). Shell details preview the command; diff-bearing actions preview the
 * change. Pure: the returned text is data, never markup.
 */
export function approvalPreviewOf(value: unknown): ApprovalPreview | null {
  const detail = approvalDetailOf(value)
  if (detail === undefined) return null
  const diff = detail.diff !== undefined && detail.diff.trim() !== '' ? detail.diff : undefined
  const command =
    detail.command !== undefined && detail.command.trim() !== '' ? detail.command : undefined
  const commandPreview: ApprovalPreview | null =
    command === undefined
      ? null
      : {
          kind: detail.kind,
          text: command,
          truncated: detail.truncated === true,
          noun: 'command',
        }
  const diffPreview: ApprovalPreview | null =
    diff === undefined
      ? null
      : {
          kind: detail.kind,
          text: diff,
          ...(detail.addedLines !== undefined ? { added: detail.addedLines } : {}),
          ...(detail.removedLines !== undefined ? { removed: detail.removedLines } : {}),
          truncated: detail.truncated === true,
          noun: 'change',
        }
  return detail.kind === 'shell'
    ? commandPreview ?? diffPreview
    : diffPreview ?? commandPreview
}

/**
 * `+N -M` for a diff preview with known line counts, or "" when there is
 * nothing truthful to print (a command preview, or unknown counts).
 */
export function approvalPreviewCounts(preview: ApprovalPreview): string {
  if (preview.noun !== 'change') return ''
  const parts: string[] = []
  if (preview.added !== undefined) parts.push(`+${preview.added}`)
  if (preview.removed !== undefined) parts.push(`-${preview.removed}`)
  return parts.join(' ')
}

// -- live "who is acting" tail state (additive) ------------------------------

/** Wall-clock ms for a timeline entry, or null when it carries no usable time. */
export function timestampOf(entry: TimelineEntry['entry'] | undefined): number | null {
  // Callers derive the entry from a timeline position (e.g. the tail of the
  // merged stream), which is undefined while a live run has produced no rows
  // yet — an absent entry carries no time, exactly like an unusable one.
  if (!entry) return null
  if (entry.type === 'group') {
    const t = Date.parse(entry.group.startTs)
    return Number.isNaN(t) ? null : t
  }
  if (entry.type === 'system') {
    const t = Date.parse(entry.activity.ts)
    return Number.isNaN(t) ? null : t
  }
  if (
    entry.type === 'tool' ||
    entry.type === 'approval' ||
    entry.type === 'prompt_audit' ||
    entry.type === 'reasoning'
  ) {
    return Number.isFinite(entry.at) ? entry.at * 1000 : null
  }
  return null
}

/**
 * Best guess of who is acting right now, derived only from the timeline tail.
 * Returns null when the tail gives no specific guess (tool/approval/divider
 * tails, senior decisions, other envelope kinds) — callers show a generic
 * "Working…" line instead. Revisions are proposals after a revise verdict, so
 * kind 'proposal' covers both.
 */
export function nextActorLabel(entry: TimelineEntry['entry'] | undefined): string | null {
  if (!entry || entry.type !== 'group') return null
  const g = entry.group
  const last = g.messages[g.messages.length - 1]
  if (!last) return null
  if (g.author === 'operator') return 'Senior is thinking'
  if (g.author === 'senior' && last.kind === 'consult') return 'Junior is working'
  if (g.author === 'junior' && last.kind === 'proposal') return 'Senior is reviewing'
  return null
}

// -- plan/todo projection (pure) ---------------------------------------------

/** Item rows the collapsed TodoPanel shows before the "+N more" tail. */
export const TODO_PANEL_COLLAPSED_ROWS = 4

/** Reinforcement internal bound mirrors the package model (never display 500). */
const TODO_ITEM_CONTENT_MAX = 200
const TODO_ITEM_COUNT_MAX = 50

/** The panel's bounded selection: visible rows, hidden count, hidden counts. */
export interface TodoPanelSelection {
  rows: TodoItem[]
  hidden: number
  hiddenCounts: Record<TodoStatus, number>
}

function emptyTodoCounts(): Record<TodoStatus, number> {
  return { pending: 0, in_progress: 0, completed: 0 }
}

function isTodoStatus(value: unknown): value is TodoStatus {
  return value === 'pending' || value === 'in_progress' || value === 'completed'
}

/**
 * Tolerant display copy of one backend snapshot: a malformed sidecar row is
 * dropped instead of breaking the panel, content is one trimmed line (the
 * backend already bounds it; this keeps an old/hand-written event safe too).
 */
function todoItems(value: unknown): TodoItem[] {
  if (!Array.isArray(value)) return []
  const todos: TodoItem[] = []
  for (const entry of value) {
    if (todos.length >= TODO_ITEM_COUNT_MAX) break
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>
    if (typeof record.content !== 'string') continue
    const content = record.content.replace(/\s+/g, ' ').trim()
    if (content === '') continue
    const bounded =
      [...content].length <= TODO_ITEM_CONTENT_MAX
        ? content
        : `${[...content].slice(0, TODO_ITEM_CONTENT_MAX - 1).join('')}…`
    todos.push({ content: bounded, status: isTodoStatus(record.status) ? record.status : 'pending' })
  }
  return todos
}

/**
 * The current plan of one session projection: the LAST `todo_updated` snapshot
 * in the event list (whole-list replacement, last-write-wins), or [] when no
 * write exists yet (an older backend never emits the event → no panel).
 */
export function todosOf(events: readonly RunEvent[]): TodoItem[] {
  let latest: TodoItem[] = []
  for (const event of events) {
    if (event.type !== 'todo_updated') continue
    latest = todoItems(event.todos)
  }
  return latest
}

/**
 * Pick which plan rows the bounded panel shows. A list that fits is shown
 * whole; otherwise in-progress items come first (what the run is doing now),
 * then the earliest pending ones (what comes next), then the latest completed
 * ones (what just finished), returned in the plan's original order. Mirrors
 * the TUI dock's selection so both surfaces read the same.
 */
export function selectTodoRows(
  todos: readonly TodoItem[],
  maxRows: number = TODO_PANEL_COLLAPSED_ROWS,
): TodoPanelSelection {
  const max = Math.max(1, Math.min(TODO_ITEM_COUNT_MAX, Math.floor(maxRows)))
  if (todos.length <= max) {
    return { rows: [...todos], hidden: 0, hiddenCounts: emptyTodoCounts() }
  }
  const priority: number[] = []
  for (let index = 0; index < todos.length; index += 1) {
    if (todos[index].status === 'in_progress') priority.push(index)
  }
  for (let index = 0; index < todos.length; index += 1) {
    if (todos[index].status === 'pending') priority.push(index)
  }
  for (let index = todos.length - 1; index >= 0; index -= 1) {
    if (todos[index].status === 'completed') priority.push(index)
  }
  const picked = new Set(priority.slice(0, max))
  const rows = todos.filter((_todo, index) => picked.has(index))
  const hiddenCounts = emptyTodoCounts()
  for (let index = 0; index < todos.length; index += 1) {
    if (!picked.has(index)) hiddenCounts[todos[index].status] += 1
  }
  return { rows, hidden: todos.length - rows.length, hiddenCounts }
}

/** The honest expand control copy: `+N more` plus a non-zero distribution. */
export function todoHiddenLabel(selection: TodoPanelSelection): string {
  if (selection.hidden <= 0) return ''
  const parts: string[] = []
  const { in_progress: active, pending, completed } = selection.hiddenCounts
  if (active > 0) parts.push(`${active} in progress`)
  if (pending > 0) parts.push(`${pending} pending`)
  if (completed > 0) parts.push(`${completed} completed`)
  return `+${selection.hidden} more${parts.length > 0 ? ` (${parts.join(' · ')})` : ''}`
}

/** Counts plus the first active entry — the panel header's truthful line. */
export interface TodoPlanSummary {
  total: number
  pending: number
  inProgress: number
  completed: number
  current: TodoItem | null
}

/** Count the plan's statuses and name the first in-progress entry. */
export function todoPlanSummary(todos: readonly TodoItem[]): TodoPlanSummary {
  const summary: TodoPlanSummary = {
    total: todos.length,
    pending: 0,
    inProgress: 0,
    completed: 0,
    current: null,
  }
  for (const todo of todos) {
    if (todo.status === 'completed') summary.completed += 1
    else if (todo.status === 'in_progress') {
      summary.inProgress += 1
      if (summary.current === null) summary.current = todo
    } else summary.pending += 1
  }
  return summary
}
