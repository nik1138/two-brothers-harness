import { chatProjectionGeneration } from './chat'
import type { ChatItem } from './chat'
import type { RunEvent, ToolResultCompact } from './types'

// Projection of typed runtime events (tool calls, approvals, prompt audits)
// into group-chat items. Components consume RuntimeItem / TimelineEntry and
// never touch raw runtime events. Envelope handling stays in chat.ts.

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

export type RuntimeItem = ToolActivityItem | ApprovalItem | PromptAuditItem

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
      const item: ApprovalItem = {
        type: 'approval',
        approvalId: ev.approval_id,
        action: ev.action,
        target: ev.target,
        command: ev.command ?? null,
        at: ev.at,
        runId: ev.run_id,
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
          reason: ev.reason ?? undefined,
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
  return entry.type === 'tool' || entry.type === 'approval' || entry.type === 'prompt_audit'
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
  if (entry.type === 'tool' || entry.type === 'approval' || entry.type === 'prompt_audit') {
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
