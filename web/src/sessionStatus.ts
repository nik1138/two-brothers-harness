/**
 * Session status semantics for the sidebar (P1).
 *
 * A row shows at most one state, in this precedence order:
 *
 *   waiting  — the session's live run is parked on an operator approval;
 *   live     — the session's live run is queued or working;
 *   failed   — the newest known run ended with an error;
 *   unread   — a run completed after the operator last opened the session;
 *   read     — nothing to flag (the row keeps its timestamp).
 *
 * The derivation in `deriveSessionStatus` is pure: App.vue feeds it the maps
 * the shell already maintains (`liveRuns`, the 5 s run-record poll, the
 * in-memory run error) plus the persisted `lastSeen` map. There is no extra
 * polling here — this module only interprets state that already exists.
 *
 * `lastSeen` is a bounded `session id -> epoch ms` map in one versioned
 * localStorage entry. Like `drafts.ts`, every storage access is best-effort
 * (injectable `StorageLike`, corrupted/blocked storage tolerated), so a
 * broken localStorage only costs the unread dots.
 */

import type { StorageLike } from './drafts'
import type { RunRecord, RunStatus } from './types'

export type SessionStatusKind = 'live' | 'waiting' | 'failed' | 'unread' | 'read'

/** Palette token name a consumer maps to CSS (ok / warning / danger / accent / muted). */
export type SessionStatusTone = 'ok' | 'warning' | 'danger' | 'accent' | 'muted'

export interface SessionStatusView {
  kind: SessionStatusKind
  /** Short visible label for the compact row indicator ('' for read). */
  label: string
  /** Detailed tooltip text — always accurate for this state. */
  title: string
  /** Screen-reader text for the indicator. */
  ariaLabel: string
  tone: SessionStatusTone
}

export interface SessionStatusInput {
  /** Status of this session's live run (queued/running/waiting), if any. */
  liveStatus?: RunStatus | null
  /** Newest known run record for the session (any terminal state), if any. */
  lastRun?: Pick<RunRecord, 'status' | 'finished' | 'error'> | null
  /** Epoch ms when the operator last opened the session; absent = never. */
  lastSeen?: number | null
  /** The session is currently on screen (never flagged as unread). */
  active?: boolean
  /** In-memory failure text from this app (may be newer than the run record). */
  error?: string | null
}

const MAX_ERROR_CHARS = 160
const MAX_SESSION_ID_CHARS = 256

/** Versioned key: bump the suffix when the stored shape changes incompatibly. */
export const SESSION_SEEN_STORAGE_KEY = 'two-brothers.sessionSeen.v1'

/** Most sessions remembered; the oldest `lastSeen` stamps fall off first. */
export const MAX_LAST_SEEN = 200

export type LastSeenMap = Record<string, number>

export interface LastSeenOptions {
  /**
   * Storage backend. Omitted = `window.localStorage` when it is reachable;
   * explicit `null` disables persistence (tests and non-DOM callers).
   */
  storage?: StorageLike | null
}

function cleanError(value: unknown): string {
  if (typeof value !== 'string') return ''
  const text = value.replace(/\s+/g, ' ').trim()
  if (!text) return ''
  return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS - 1)}…` : text
}

const LIVE_VIEW: SessionStatusView = {
  kind: 'live',
  label: 'live',
  title: 'A run is live in this session — Senior and Junior are working.',
  ariaLabel: 'Live run in this session',
  tone: 'ok',
}

const WAITING_VIEW: SessionStatusView = {
  kind: 'waiting',
  label: 'waiting',
  title: 'Waiting for your approval — the run is paused until you allow or deny.',
  ariaLabel: 'Waiting for your approval in this session',
  tone: 'warning',
}

const UNREAD_VIEW: SessionStatusView = {
  kind: 'unread',
  label: 'new',
  title: 'A run finished since you last opened this session.',
  ariaLabel: 'Unread run result in this session',
  tone: 'accent',
}

const READ_VIEW: SessionStatusView = {
  kind: 'read',
  label: '',
  title: 'No new activity.',
  ariaLabel: 'No new activity',
  tone: 'muted',
}

function failedView(error: string): SessionStatusView {
  return {
    kind: 'failed',
    label: 'failed',
    title: error ? `Last run failed: ${error}` : 'The last run ended with an error.',
    ariaLabel: 'Last run failed in this session',
    tone: 'danger',
  }
}

/** Epoch ms a run record finished at, or 0 when the backend did not report it. */
export function runFinishedAtMs(run: Pick<RunRecord, 'finished'> | null | undefined): number {
  const finished = run?.finished
  if (typeof finished !== 'number' || !Number.isFinite(finished) || finished <= 0) return 0
  return finished * 1000
}

/** True when a finished run postdates the operator's last open of the session. */
export function isRunUnread(finishedMs: number, lastSeenMs: number | null | undefined): boolean {
  if (!(finishedMs > 0)) return false
  const seen =
    typeof lastSeenMs === 'number' && Number.isFinite(lastSeenMs) && lastSeenMs > 0
      ? lastSeenMs
      : 0
  return finishedMs > seen
}

/**
 * Derive the one row state from state the shell already has. Precedence:
 * waiting > live > failed > unread > read. A live run hides an older failure
 * (the retry superseded it); the on-screen session is never "unread".
 */
export function deriveSessionStatus(input: SessionStatusInput = {}): SessionStatusView {
  const liveStatus = input.liveStatus ?? null
  if (liveStatus === 'waiting') return WAITING_VIEW
  if (liveStatus === 'queued' || liveStatus === 'running') return LIVE_VIEW

  const lastRun = input.lastRun ?? null
  const error =
    cleanError(input.error) || (lastRun?.status === 'failed' ? cleanError(lastRun.error) : '')
  if (lastRun?.status === 'failed' || error) return failedView(error)

  // Only a completed run is interesting enough to flag; a cancelled run is the
  // operator's own stop and a failed one already shows the failure state.
  if (!input.active && lastRun?.status === 'completed') {
    if (isRunUnread(runFinishedAtMs(lastRun), input.lastSeen)) return UNREAD_VIEW
  }
  return READ_VIEW
}

// -- lastSeen persistence --------------------------------------------------------

/** A browser `localStorage` if it exists and reading it does not throw. */
export function defaultSeenStorage(): StorageLike | null {
  try {
    if (typeof window === 'undefined') return null
    return window.localStorage ?? null
  } catch {
    return null
  }
}

function resolveStorage(options: LastSeenOptions): StorageLike | null {
  return options.storage === undefined ? defaultSeenStorage() : options.storage
}

/** Normalize a session id; null/undefined/empty all mean "no session". */
function normalizeSession(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const id = value.trim()
  if (!id) return null
  return id.slice(0, MAX_SESSION_ID_CHARS)
}

function emptyMap(): LastSeenMap {
  return Object.create(null) as LastSeenMap
}

/** Keep the newest `MAX_LAST_SEEN` stamps (deterministic tie-break by id). */
function boundSeen(map: LastSeenMap): LastSeenMap {
  const keys = Object.keys(map)
  if (keys.length <= MAX_LAST_SEEN) return map
  keys.sort((a, b) => {
    const delta = map[a] - map[b]
    if (delta !== 0) return delta
    return a < b ? -1 : a > b ? 1 : 0
  })
  const pruned = emptyMap()
  for (const key of keys.slice(keys.length - MAX_LAST_SEEN)) pruned[key] = map[key]
  return pruned
}

/** Parse a stored lastSeen blob tolerantly; unusable entries are dropped. */
export function parseLastSeen(raw: string | null): LastSeenMap {
  if (!raw) return emptyMap()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return emptyMap()
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyMap()
  const map = emptyMap()
  for (const [session, value] of Object.entries(parsed as Record<string, unknown>)) {
    const id = normalizeSession(session)
    if (!id) continue
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue
    map[id] = Math.floor(value)
  }
  return boundSeen(map)
}

/** Load the map; blocked storage and corrupted JSON both yield an empty map. */
export function loadLastSeen(options: LastSeenOptions = {}): LastSeenMap {
  const storage = resolveStorage(options)
  if (!storage) return emptyMap()
  try {
    return parseLastSeen(storage.getItem(SESSION_SEEN_STORAGE_KEY))
  } catch {
    return emptyMap()
  }
}

/** Persist the map; quota errors and blocked storage are swallowed. */
export function saveLastSeen(map: LastSeenMap, options: LastSeenOptions = {}): void {
  const storage = resolveStorage(options)
  if (!storage) return
  try {
    if (Object.keys(map).length === 0) storage.removeItem(SESSION_SEEN_STORAGE_KEY)
    else storage.setItem(SESSION_SEEN_STORAGE_KEY, JSON.stringify(map))
  } catch {
    // quota exceeded / blocked storage: the in-memory map still works
  }
}

/**
 * Mark one session read at `now` (epoch ms). Pure aside from the clock default
 * (`Date.now()`); returns a new map, bounded like the stored one.
 */
export function markSessionSeen(
  session: string | null | undefined,
  map: LastSeenMap,
  now: number = Date.now(),
): LastSeenMap {
  const id = normalizeSession(session)
  if (!id) return map
  const stamp =
    typeof now === 'number' && Number.isFinite(now) && now > 0 ? Math.floor(now) : Date.now()
  const next = emptyMap()
  for (const [key, value] of Object.entries(map ?? {})) next[key] = value
  next[id] = stamp
  return boundSeen(next)
}

/**
 * Drop stamps for sessions that no longer exist. Returns the same map instance
 * when nothing was removed, so callers can skip a write.
 */
export function pruneLastSeen(
  map: LastSeenMap,
  validSessions: Iterable<string>,
): LastSeenMap {
  const valid = new Set<string>()
  for (const session of validSessions) {
    const id = normalizeSession(session)
    if (id) valid.add(id)
  }
  let changed = false
  for (const key of Object.keys(map ?? {})) {
    if (!valid.has(key)) {
      changed = true
      break
    }
  }
  if (!changed) return map
  const next = emptyMap()
  for (const [key, value] of Object.entries(map)) {
    if (valid.has(key)) next[key] = value
  }
  return next
}
