/**
 * Unsent composer drafts, persisted per session.
 *
 * The textarea holds one session's unsent text at a time; this module is the
 * only place that stores it. Everything is keyed by session id under a single
 * versioned localStorage entry, and every operation is best-effort:
 *
 * - storage may be missing (`window` unavailable, private mode) or throw on
 *   access/quota — drafts then simply do not persist;
 * - the stored JSON may be corrupted or written by an older version — bad
 *   entries are dropped, never thrown;
 * - the blob is bounded (one draft length cap, a session count cap pruned by
 *   oldest `updatedAt`) so a stray paste cannot fill the origin's quota.
 *
 * No DOM or Vue dependency: the backend is injected (`StorageLike`), so the
 * node:test suite drives it with a plain object.
 */

/** One saved draft: the exact text and when it was last edited. */
export interface DraftEntry {
  text: string
  updatedAt: number
}

/** sessionId -> draft. A null-prototype record, so a stored `__proto__` key
 * cannot mutate the map's prototype while it is rebuilt. */
export type DraftMap = Record<string, DraftEntry>

/** The minimal Storage surface this module needs (a `Storage` satisfies it). */
export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** Versioned key: bump the suffix when the stored shape changes incompatibly. */
export const DRAFTS_STORAGE_KEY = 'two-brothers.drafts.v1'

/** Longest draft kept, in UTF-16 code units; longer text is truncated. */
export const MAX_DRAFT_CHARS = 16_384

/** Most sessions remembered; the drafts with the oldest `updatedAt` go first. */
export const MAX_DRAFTS = 50

export interface DraftStoreOptions {
  /**
   * Storage backend. Omitted = `window.localStorage` when it is reachable;
   * explicit `null` disables persistence (used by tests and non-DOM callers).
   */
  storage?: StorageLike | null
  /** Clock injection for deterministic pruning tests; defaults to `Date.now()`. */
  now?: number
}

/** A browser `localStorage` if it exists and reading it does not throw. */
export function defaultDraftStorage(): StorageLike | null {
  try {
    if (typeof window === 'undefined') return null
    return window.localStorage ?? null
  } catch {
    // even accessing the property can throw when storage is blocked
    return null
  }
}

function resolveStorage(options: DraftStoreOptions): StorageLike | null {
  return options.storage === undefined ? defaultDraftStorage() : options.storage
}

/** Normalize a session id; null/undefined/empty all mean "no session". */
function normalizeId(sessionId: string | null | undefined): string | null {
  return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null
}

function emptyMap(): DraftMap {
  return Object.create(null) as DraftMap
}

/** Keep at most `MAX_DRAFTS`, dropping the oldest `updatedAt` (ties by id). */
function pruneMap(map: DraftMap): DraftMap {
  const keys = Object.keys(map)
  if (keys.length <= MAX_DRAFTS) return map
  keys.sort((a, b) => {
    const delta = map[a].updatedAt - map[b].updatedAt
    if (delta !== 0) return delta
    // locale-independent tie-break so pruning is deterministic everywhere
    return a < b ? -1 : a > b ? 1 : 0
  })
  const pruned = emptyMap()
  for (const key of keys.slice(keys.length - MAX_DRAFTS)) pruned[key] = map[key]
  return pruned
}

/** Parse stored JSON tolerantly: anything unusable becomes `{}`. */
function parseMap(raw: string | null): DraftMap {
  if (!raw) return emptyMap()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return emptyMap()
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyMap()
  const map = emptyMap()
  for (const [sessionId, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!sessionId || value === null || typeof value !== 'object' || Array.isArray(value)) continue
    const record = value as Record<string, unknown>
    if (typeof record.text !== 'string') continue
    const updatedAt =
      typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt)
        ? record.updatedAt
        : 0
    // reading is bounded too, so an oversized blob cannot reach the composer
    map[sessionId] = { text: record.text.slice(0, MAX_DRAFT_CHARS), updatedAt }
  }
  return pruneMap(map)
}

/** Load the map; blocked storage and corrupted JSON both yield an empty map. */
function loadMap(storage: StorageLike | null): DraftMap {
  if (!storage) return emptyMap()
  try {
    return parseMap(storage.getItem(DRAFTS_STORAGE_KEY))
  } catch {
    return emptyMap()
  }
}

/** Persist the map; quota errors and blocked storage are swallowed. */
function saveMap(storage: StorageLike | null, map: DraftMap): void {
  if (!storage) return
  try {
    if (Object.keys(map).length === 0) storage.removeItem(DRAFTS_STORAGE_KEY)
    else storage.setItem(DRAFTS_STORAGE_KEY, JSON.stringify(map))
  } catch {
    // quota exceeded / blocked storage: the draft survives in the textarea
  }
}

/** Saved text for a session, or `''` when there is none (or storage failed). */
export function getDraft(
  sessionId: string | null | undefined,
  options: DraftStoreOptions = {},
): string {
  const id = normalizeId(sessionId)
  if (!id) return ''
  return loadMap(resolveStorage(options))[id]?.text ?? ''
}

/**
 * Save (or, for empty text, clear) one session's draft. Existing sessions keep
 * their `updatedAt` fresh so they prune last. Safe to call on every keystroke —
 * the composer debounces it, this function itself does not.
 */
export function setDraft(
  sessionId: string | null | undefined,
  text: string,
  options: DraftStoreOptions = {},
): void {
  const id = normalizeId(sessionId)
  if (!id) return
  const storage = resolveStorage(options)
  const map = loadMap(storage)
  if (text.length === 0) {
    delete map[id]
    saveMap(storage, map)
    return
  }
  const bounded = text.length > MAX_DRAFT_CHARS ? text.slice(0, MAX_DRAFT_CHARS) : text
  map[id] = { text: bounded, updatedAt: options.now ?? Date.now() }
  saveMap(storage, pruneMap(map))
}

/** Drop one session's saved draft (the composer calls this only on submit). */
export function clearDraft(
  sessionId: string | null | undefined,
  options: DraftStoreOptions = {},
): void {
  const id = normalizeId(sessionId)
  if (!id) return
  const storage = resolveStorage(options)
  const map = loadMap(storage)
  if (!(id in map)) return
  delete map[id]
  saveMap(storage, map)
}
