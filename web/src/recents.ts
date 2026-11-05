/**
 * Recent workspaces (P1): a bounded most-recently-used list of workspace ids.
 *
 * The sidebar filter, the command palette and a run start all select a
 * workspace; the workspace finder and the new-session dialog offer that
 * history back as quick picks. Everything is best-effort, mirroring
 * `drafts.ts`:
 *
 * - one versioned localStorage entry, MRU order (newest first), de-duped and
 *   capped at `MAX_RECENT_WORKSPACES`;
 * - workspace ids are trimmed and length-capped, so a hand-written blob cannot
 *   grow the entry without bound;
 * - storage may be missing (`window` unavailable, private mode) or throw on
 *   access/quota — recents then simply do not persist;
 * - corrupted JSON or shapes from another version parse to `[]`.
 *
 * No DOM or Vue dependency: the backend is injected (`StorageLike`), so the
 * node:test suite drives it with a plain object.
 */

import type { StorageLike } from './drafts'

/** Versioned key: bump the suffix when the stored shape changes incompatibly. */
export const RECENTS_STORAGE_KEY = 'two-brothers.recentWorkspaces.v1'

/** Most workspaces remembered; older entries fall off the tail. */
export const MAX_RECENT_WORKSPACES = 8

/** Longest workspace id kept, in UTF-16 code units. */
export const MAX_WORKSPACE_ID_CHARS = 256

export interface RecentsOptions {
  /**
   * Storage backend. Omitted = `window.localStorage` when it is reachable;
   * explicit `null` disables persistence (used by tests and non-DOM callers).
   */
  storage?: StorageLike | null
}

/** A browser `localStorage` if it exists and reading it does not throw. */
export function defaultRecentsStorage(): StorageLike | null {
  try {
    if (typeof window === 'undefined') return null
    return window.localStorage ?? null
  } catch {
    // even accessing the property can throw when storage is blocked
    return null
  }
}

function resolveStorage(options: RecentsOptions): StorageLike | null {
  return options.storage === undefined ? defaultRecentsStorage() : options.storage
}

/** Normalize one workspace id; null/empty/oversized input is handled, not trusted. */
function normalizeId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.slice(0, MAX_WORKSPACE_ID_CHARS)
}

/**
 * Parse a stored blob tolerantly: any unusable entry is dropped, order kept,
 * duplicates collapse to their first (most recent) occurrence, and the result
 * is capped. Corrupted JSON or a non-array payload yields `[]`.
 */
export function parseRecentWorkspaces(raw: string | null): string[] {
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out: string[] = []
  for (const entry of parsed) {
    const id = normalizeId(entry)
    if (!id || out.includes(id)) continue
    out.push(id)
    if (out.length >= MAX_RECENT_WORKSPACES) break
  }
  return out
}

/** Pure MRU insert: the id moves to the front, duplicates collapse, cap applied. */
export function pushRecentWorkspace(ids: readonly string[], id: string): string[] {
  const normalized = normalizeId(id)
  if (!normalized) return [...ids]
  const out: string[] = [normalized]
  for (const entry of ids) {
    const candidate = normalizeId(entry)
    if (!candidate || out.includes(candidate)) continue
    out.push(candidate)
    if (out.length >= MAX_RECENT_WORKSPACES) break
  }
  return out
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((entry, index) => entry === b[index])
}

function saveList(storage: StorageLike | null, ids: string[]): void {
  if (!storage) return
  try {
    if (ids.length === 0) storage.removeItem(RECENTS_STORAGE_KEY)
    else storage.setItem(RECENTS_STORAGE_KEY, JSON.stringify(ids))
  } catch {
    // quota exceeded / blocked storage: the in-memory list still works
  }
}

/** Current list, newest first; blocked storage and corrupted JSON yield `[]`. */
export function readRecentWorkspaces(options: RecentsOptions = {}): string[] {
  const storage = resolveStorage(options)
  if (!storage) return []
  try {
    return parseRecentWorkspaces(storage.getItem(RECENTS_STORAGE_KEY))
  } catch {
    return []
  }
}

/**
 * Record one workspace selection and persist the new MRU list. Returns the
 * resulting list either way, so callers can keep an in-memory copy when
 * storage is unavailable. A no-op (already newest) does not rewrite storage.
 */
export function recordRecentWorkspace(
  id: string | null | undefined,
  options: RecentsOptions = {},
): string[] {
  const current = readRecentWorkspaces(options)
  if (typeof id !== 'string') return current
  const normalized = normalizeId(id)
  if (!normalized) return current
  const next = pushRecentWorkspace(current, normalized)
  if (!sameList(next, current)) saveList(resolveStorage(options), next)
  return next
}

/**
 * Drop ids that no longer exist (deleted workspaces) and persist when the list
 * changed. Order is preserved, so pruning never reshuffles the MRU history.
 */
export function pruneRecentWorkspaces(
  ids: readonly string[],
  validIds: Iterable<string>,
  options: RecentsOptions = {},
): string[] {
  const valid = new Set<string>()
  for (const id of validIds) {
    const normalized = normalizeId(id)
    if (normalized) valid.add(normalized)
  }
  const seen = new Set<string>()
  const next: string[] = []
  for (const id of ids) {
    const normalized = normalizeId(id)
    if (!normalized || seen.has(normalized) || !valid.has(normalized)) continue
    seen.add(normalized)
    next.push(normalized)
    if (next.length >= MAX_RECENT_WORKSPACES) break
  }
  const before: string[] = []
  for (const id of ids) {
    const normalized = normalizeId(id)
    if (normalized) before.push(normalized)
  }
  if (!sameList(next, before)) saveList(resolveStorage(options), next)
  return next
}
