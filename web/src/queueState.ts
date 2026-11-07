/**
 * Queue visibility projection (pure).
 *
 * The backend `RunManager` stays truthful about its per-session FIFO: one run
 * is `running` (or parked `waiting` on an operator approval) and every further
 * submission for that session stays `queued` until the one before it finishes.
 * `GET /api/runs` exposes those records (newest first); this module restores
 * submission order, drops everything that is not live and assigns 1-based FIFO
 * positions so the shell can render the queue without inventing anything.
 *
 * Rules:
 * - only `queued` / `running` / `waiting` records are part of a queue;
 * - the first active run of a session is its current run (position 1), the
 *   rest wait behind it (positions 2, 3, ...);
 * - a missing / malformed / unknown record produces no row, so an older
 *   backend that returns no active records simply shows no dock;
 * - rows never cross sessions: grouping is always by the record's own session.
 *
 * No DOM or Vue dependency: the projection is unit-tested directly.
 */

import type { RunStatus } from './types'

/** Statuses that mean the run is still part of its session's live queue. */
export const ACTIVE_RUN_STATUSES: readonly RunStatus[] = ['queued', 'running', 'waiting']

/** Queue-dock rows rendered before the honest "+N more" tail. */
export const QUEUE_DOCK_MAX_ROWS = 5

/** Longest single-line task preview in a dock row, in code points (ellipsis included). */
export const QUEUE_TASK_PREVIEW_CHARS = 120

/** One active run as the queue UI shows it. */
export interface QueuedRunRow {
  /** Run id — the stable key for a row (stop/list reconciliation). */
  run_id: string
  /** Session the run belongs to (the backend filters by it, we group by it). */
  session: string
  /** Bounded single-line task preview; never HTML (Vue interpolates as text). */
  task: string
  status: RunStatus
  /** Submission time from the run record, epoch seconds (0 when unknown). */
  created: number
  /** 1-based FIFO position in the session's active queue (1 = the current run). */
  position: number
}

/** Active runs of one session, projected for the composer's queue dock. */
export interface SessionQueueView {
  /** Every active run of the session, FIFO (position 1 = current). */
  rows: QueuedRunRow[]
  /** The run the session is on right now (or the head queued run, if no worker). */
  current: QueuedRunRow | null
  /** Rows behind `current`, FIFO, bounded to {@link QUEUE_DOCK_MAX_ROWS}. */
  waiting: QueuedRunRow[]
  /** Waiting runs beyond the bound (0 when everything fits). */
  hidden: number
  /** Total runs queued behind `current` (`waiting.length + hidden`). */
  queuedCount: number
}

/** Empty projection; shared read-only fallback, never mutated. */
export const EMPTY_QUEUE_VIEW: SessionQueueView = {
  rows: [],
  current: null,
  waiting: [],
  hidden: 0,
  queuedCount: 0,
}

/** Tolerant guard: a run is part of a live queue only in an active status. */
export function isActiveRunStatus(status: unknown): status is RunStatus {
  return (
    status === 'queued' || status === 'running' || status === 'waiting'
  )
}

/**
 * Collapse arbitrary task text into one bounded line: control characters and
 * whitespace runs become single spaces, and an over-long string is clipped on
 * a code-point boundary with a trailing ellipsis.
 */
export function taskPreview(
  task: unknown,
  max: number = QUEUE_TASK_PREVIEW_CHARS,
): string {
  if (typeof task !== 'string') return ''
  const collapsed = task
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (collapsed.length === 0) return ''
  const limit =
    Number.isFinite(max) && max > 0 ? Math.floor(max) : QUEUE_TASK_PREVIEW_CHARS
  const chars = Array.from(collapsed)
  if (chars.length <= limit) return collapsed
  return `${chars.slice(0, Math.max(0, limit - 1)).join('')}…`
}

/** A well-formed active run record, normalized; null for anything else. */
interface ActiveRecord {
  run_id: string
  session: string
  task: string
  status: RunStatus
  created: number
}

function activeRecord(value: unknown): ActiveRecord | null {
  if (value === null || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const runId = typeof record.run_id === 'string' ? record.run_id.trim() : ''
  const session = typeof record.session === 'string' ? record.session.trim() : ''
  if (runId.length === 0 || session.length === 0) return null
  if (!isActiveRunStatus(record.status)) return null
  const created =
    typeof record.created === 'number' && Number.isFinite(record.created)
      ? record.created
      : 0
  return {
    run_id: runId,
    session,
    task: typeof record.task === 'string' ? record.task : '',
    status: record.status,
    created,
  }
}

/**
 * Active runs from one backend list, in FIFO submission order with positions
 * assigned. `runs` must be the `GET /api/runs` array (documented newest first);
 * walking it backwards restores the server's submission order even when
 * several runs share a `created` second. Duplicate run ids keep the first
 * (oldest) occurrence; terminal and malformed records are dropped.
 */
export function activeQueueRows(
  runs: readonly unknown[],
  session?: string,
): QueuedRunRow[] {
  if (!Array.isArray(runs) || runs.length === 0) return []
  const rows: QueuedRunRow[] = []
  const seen = new Set<string>()
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const record = activeRecord(runs[index])
    if (record === null) continue
    if (session !== undefined && record.session !== session) continue
    if (seen.has(record.run_id)) continue
    seen.add(record.run_id)
    rows.push({
      run_id: record.run_id,
      session: record.session,
      task: taskPreview(record.task),
      status: record.status,
      created: record.created,
      position: rows.length + 1,
    })
  }
  return rows
}

/**
 * Project one session's FIFO rows (position 1 = current) into the bounded
 * dock view. Recomputes positions, so it is also the rebuild step after an
 * optimistic insert/remove. An empty list yields {@link EMPTY_QUEUE_VIEW}.
 */
export function queueViewForRows(rows: readonly QueuedRunRow[]): SessionQueueView {
  if (!Array.isArray(rows) || rows.length === 0) return EMPTY_QUEUE_VIEW
  const ordered = rows.map((row, index) => ({ ...row, position: index + 1 }))
  const waiting = ordered.slice(1, 1 + QUEUE_DOCK_MAX_ROWS)
  const queuedCount = ordered.length - 1
  return {
    rows: ordered,
    current: ordered[0],
    waiting,
    hidden: queuedCount - waiting.length,
    queuedCount,
  }
}

/**
 * Group a backend run list into per-session queue views. Only sessions with at
 * least one active run get an entry — no active records means no dock.
 */
export function sessionQueueViews(
  runs: readonly unknown[],
): Record<string, SessionQueueView> {
  const grouped = new Map<string, QueuedRunRow[]>()
  for (const row of activeQueueRows(runs)) {
    const list = grouped.get(row.session)
    if (list) list.push(row)
    else grouped.set(row.session, [row])
  }
  // Object.fromEntries creates own data properties, so a pathological session
  // name (e.g. "__proto__") can never mutate the result's prototype.
  return Object.fromEntries(
    [...grouped].map(([session, rows]) => [session, queueViewForRows(rows)]),
  ) as Record<string, SessionQueueView>
}

/** One run a surface knows was just accepted by the backend (optimistic row). */
export interface QueuedRunInput {
  run_id: string
  session: string
  task?: unknown
  status?: unknown
  created?: unknown
}

/**
 * Add one accepted run to the projection. This is only for a submission the
 * server already confirmed (HTTP 202) behind a live run; the next pool poll
 * replaces the whole projection with the authoritative snapshot. Idempotent by
 * `run_id` (a poll may already have delivered it) and never mutates `views`.
 */
export function withQueuedRun(
  views: Record<string, SessionQueueView>,
  input: QueuedRunInput,
): Record<string, SessionQueueView> {
  const record = activeRecord({
    run_id: input.run_id,
    session: input.session,
    task: input.task,
    status: input.status ?? 'queued',
    created: input.created,
  })
  if (record === null) return views
  for (const view of Object.values(views)) {
    if (view.rows.some((row) => row.run_id === record.run_id)) return views
  }
  const existing = views[record.session]
  const rows = existing ? [...existing.rows] : []
  rows.push({
    run_id: record.run_id,
    session: record.session,
    task: taskPreview(record.task),
    status: record.status,
    created: record.created,
    position: rows.length + 1,
  })
  return { ...views, [record.session]: queueViewForRows(rows) }
}

/**
 * Drop one run from the projection (a confirmed cancel). Removes the session
 * entry when nothing is left, repositions the rest and is idempotent; `views`
 * is never mutated and an unchanged projection is returned by reference.
 */
export function withoutRun(
  views: Record<string, SessionQueueView>,
  runId: string,
): Record<string, SessionQueueView> {
  if (typeof runId !== 'string' || runId.length === 0) return views
  let changed = false
  const next: Record<string, SessionQueueView> = {}
  for (const [session, view] of Object.entries(views)) {
    const rows = view.rows.filter((row) => row.run_id !== runId)
    if (rows.length === view.rows.length) {
      next[session] = view
      continue
    }
    changed = true
    if (rows.length > 0) next[session] = queueViewForRows(rows)
  }
  return changed ? next : views
}
