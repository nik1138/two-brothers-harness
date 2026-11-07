/**
 * Composer prompt-history recall (pure).
 *
 * Up/Down at the draft edges walk the operator's earlier accepted tasks — the
 * same contract as the TUI composer (`packages/harness/src/tui/editor.ts`):
 *
 * - the remembered entries are only *accepted submissions* (App reports their
 *   outcome through `submitResult`), never unsent drafts;
 * - the store is persisted in a versioned, bounded localStorage blob keyed by
 *   {@link RECALL_STORAGE_KEY}, newest first, with consecutive duplicates
 *   dropped and a hard entry count/char cap;
 * - every storage or JSON failure is swallowed: recall simply has no entries,
 *   the composer keeps working;
 * - browsing is a pure state machine ({@link RecallState}); the live draft is
 *   stashed byte-exactly and restored when the operator steps past the newest
 *   entry, and the store is only written on acceptance — navigation never
 *   appends.
 *
 * No DOM or Vue dependency: the storage backend is injected (`StorageLike`),
 * so `node:test` drives the whole module with a plain object, and the key
 * decision reads only a small structural subset of a `KeyboardEvent` plus the
 * textarea caret.
 */

import type { StorageLike } from './drafts'

/** Versioned storage key: bump the suffix when the persisted shape changes. */
export const RECALL_STORAGE_KEY = 'two-brothers.composerHistory.v1'

/** On-disk schema version; any other version loads as empty. */
export const RECALL_VERSION = 1

/** Maximum remembered entries (newest are kept). */
export const MAX_RECALL_ENTRIES = 100

/** Maximum UTF-16 code units per remembered entry (longer text is clipped). */
export const MAX_RECALL_ENTRY_CHARS = 16_384

/** The versioned JSON document written by {@link saveRecall}. */
export interface RecallFile {
  version: typeof RECALL_VERSION
  /** Newest first; the composer's Up recalls `entries[0]`. */
  entries: string[]
}

/** One browsing step's outcome: the state to keep and the text to show. */
export interface RecallStep {
  state: RecallState
  /** Text to place in the composer, or `null` when nothing changes. */
  text: string | null
}

/** Immutable recall-browsing state. */
export interface RecallState {
  /** True while the composer shows a recalled entry. */
  active: boolean
  /** Newest-first index of the shown entry; `-1` while inactive. */
  index: number
  /** Exact live draft stashed when browsing started. */
  draft: string
}

/** Direction of one recall step. */
export type RecallDirection = 'previous' | 'next'

/** A fresh, inactive recall state. */
export function createRecallState(): RecallState {
  return { active: false, index: -1, draft: '' }
}

// --------------------------------------------------------------------------- //
// store (bounded, fail-soft)
// --------------------------------------------------------------------------- //

/** Clip one entry to the character cap (no grapheme splitting concerns: the
 * cap is a storage guard, and pasted text is plain text; a surrogate pair can
 * at worst be clipped, never rendered as a dangling escape). */
function clipEntry(text: string): string {
  return text.length > MAX_RECALL_ENTRY_CHARS ? text.slice(0, MAX_RECALL_ENTRY_CHARS) : text
}

/**
 * Sanitize an entry sequence: drop non-strings and blank entries, clip each to
 * the cap, collapse consecutive duplicates (newest-first adjacency), and keep
 * at most {@link MAX_RECALL_ENTRIES}. Always returns a fresh array.
 */
export function normalizeRecallEntries(entries: readonly unknown[]): string[] {
  const normalized: string[] = []
  for (const value of entries) {
    if (typeof value !== 'string' || value.trim() === '') continue
    const entry = clipEntry(value)
    if (normalized.length > 0 && normalized[normalized.length - 1] === entry) continue
    normalized.push(entry)
    if (normalized.length >= MAX_RECALL_ENTRIES) break
  }
  return normalized
}

/** A browser `localStorage` if it exists and reading it does not throw. */
export function defaultRecallStorage(): StorageLike | null {
  try {
    if (typeof window === 'undefined') return null
    return window.localStorage ?? null
  } catch {
    // even accessing the property can throw when storage is blocked
    return null
  }
}

/** Options for the store helpers; omitted storage means the browser store. */
export interface RecallStoreOptions {
  storage?: StorageLike | null
}

function resolveStorage(options: RecallStoreOptions): StorageLike | null {
  return options.storage === undefined ? defaultRecallStorage() : options.storage
}

function parseDocument(raw: string | null): string[] {
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return []
  const document = parsed as { version?: unknown; entries?: unknown }
  if (document.version !== RECALL_VERSION) return []
  if (!Array.isArray(document.entries)) return []
  return normalizeRecallEntries(document.entries)
}

/**
 * Read the persisted history (newest first). Every failure — missing storage,
 * blocked access, corrupt JSON, wrong version or shape — yields `[]` silently.
 */
export function loadRecall(options: RecallStoreOptions = {}): string[] {
  const storage = resolveStorage(options)
  if (!storage) return []
  try {
    return parseDocument(storage.getItem(RECALL_STORAGE_KEY))
  } catch {
    return []
  }
}

/**
 * Persist the history (newest first) after normalizing it. Quota errors and
 * blocked storage are swallowed: recall then simply does not survive the
 * reload, and the composer keeps working.
 */
export function saveRecall(entries: readonly string[], options: RecallStoreOptions = {}): void {
  const storage = resolveStorage(options)
  if (!storage) return
  const normalized = normalizeRecallEntries(entries)
  try {
    if (normalized.length === 0) storage.removeItem(RECALL_STORAGE_KEY)
    else {
      const document: RecallFile = { version: RECALL_VERSION, entries: normalized }
      storage.setItem(RECALL_STORAGE_KEY, JSON.stringify(document))
    }
  } catch {
    // blocked storage / quota exceeded: the session's history stays in memory
  }
}

/** Drop the persisted history (empty list after a reload). Fail-soft. */
export function clearRecall(options: RecallStoreOptions = {}): void {
  const storage = resolveStorage(options)
  if (!storage) return
  try {
    storage.removeItem(RECALL_STORAGE_KEY)
  } catch {
    // blocked storage: nothing to clear
  }
}

/**
 * Append one accepted submission (newest first): blank entries are ignored, an
 * exact repeat of the newest entry is not duplicated, the per-entry cap clips,
 * and the oldest entries fall off the count cap. Pure — the caller persists.
 */
export function recordRecall(entries: readonly string[], entry: string): string[] {
  const current = normalizeRecallEntries(entries)
  if (typeof entry !== 'string' || entry.trim() === '') return current
  const clipped = clipEntry(entry)
  if (current.length > 0 && current[0] === clipped) return current
  return [clipped, ...current].slice(0, MAX_RECALL_ENTRIES)
}

// --------------------------------------------------------------------------- //
// browsing state machine
// --------------------------------------------------------------------------- //

/**
 * One Up/Down step over the newest-first entries.
 *
 * `previous` (Up) starts at the newest entry with `liveText` stashed as the
 * draft and walks older; at the oldest entry it is a no-op. `next` (Down)
 * walks newer; stepping past the newest restores the stashed draft exactly and
 * ends browsing. With no entries, or when the requested step is a boundary,
 * `text` is `null` and the state is returned unchanged.
 */
export function stepRecall(
  state: RecallState,
  direction: RecallDirection,
  entries: readonly string[],
  liveText: string,
): RecallStep {
  const history = normalizeRecallEntries(entries)
  if (history.length === 0) return { state, text: null }
  if (direction === 'previous') {
    if (!state.active) {
      return {
        state: { active: true, index: 0, draft: typeof liveText === 'string' ? liveText : '' },
        text: history[0] ?? null,
      }
    }
    const index = state.index + 1
    if (index >= history.length) return { state, text: null }
    return { state: { ...state, index }, text: history[index] ?? null }
  }
  if (!state.active) return { state, text: null }
  if (state.index > 0) {
    const index = state.index - 1
    return { state: { ...state, index }, text: history[index] ?? null }
  }
  return { state: createRecallState(), text: state.draft }
}

// --------------------------------------------------------------------------- //
// key decision (pure)
// --------------------------------------------------------------------------- //

/** The subset of `KeyboardEvent` the recall classifier reads. */
export interface RecallKeyInput {
  key: string
  shiftKey?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  isComposing?: boolean
  keyCode?: number
  repeat?: boolean
}

/** The caret/textarea facts the boundary rule needs. */
export interface RecallCaret {
  text: string
  selectionStart: number
  selectionEnd: number
}

/** What one keystroke means for recall. */
export type RecallKeyIntent = 'previous' | 'next' | 'none'

/** True when the text holds no newline (the composer is one logical line). */
export function isSingleLine(text: string): boolean {
  return typeof text === 'string' && !text.includes('\n')
}

/**
 * True when Up may recall: the draft is single-line (there is no vertical
 * movement to preserve) or the collapsed caret sits at the very start of the
 * first line of a multiline draft.
 */
export function caretAtRecallStart(caret: RecallCaret | null | undefined): boolean {
  if (!caret || typeof caret.text !== 'string') return false
  const start = Math.floor(Number(caret.selectionStart))
  const end = Math.floor(Number(caret.selectionEnd))
  if (!Number.isFinite(start) || !Number.isFinite(end) || start !== end) return false
  if (start < 0 || start > caret.text.length) return false
  if (isSingleLine(caret.text)) return true
  return start === 0
}

/**
 * True when Down may step forward: the draft is single-line, or the collapsed
 * caret sits at the very end of the last line of a multiline draft.
 */
export function caretAtRecallEnd(caret: RecallCaret | null | undefined): boolean {
  if (!caret || typeof caret.text !== 'string') return false
  const start = Math.floor(Number(caret.selectionStart))
  const end = Math.floor(Number(caret.selectionEnd))
  if (!Number.isFinite(start) || !Number.isFinite(end) || start !== end) return false
  if (start < 0 || start > caret.text.length) return false
  if (isSingleLine(caret.text)) return true
  return start === caret.text.length
}

/**
 * Classify one ArrowUp/ArrowDown press for recall.
 *
 * Returns `'none'` (leave the keystroke to the textarea) for anything else:
 * other keys, IME composition, held-key auto-repeat, any modifier (Shift+
 * Arrow selects text, Ctrl/Alt/⌘+Arrow is a word/document jump) and any
 * non-collapsed selection. Up only recalls at the draft start, Down only at the
 * draft end, so ordinary vertical caret movement inside a multiline draft is
 * never intercepted.
 */
export function classifyRecallKey(
  input: RecallKeyInput | null | undefined,
  caret: RecallCaret | null | undefined,
): RecallKeyIntent {
  if (!input || typeof input.key !== 'string') return 'none'
  if (input.isComposing === true || input.keyCode === 229) return 'none'
  if (input.repeat === true) return 'none'
  if (input.shiftKey === true || input.ctrlKey === true || input.metaKey === true) return 'none'
  if (input.altKey === true) return 'none'
  if (input.key === 'ArrowUp') return caretAtRecallStart(caret) ? 'previous' : 'none'
  if (input.key === 'ArrowDown') return caretAtRecallEnd(caret) ? 'next' : 'none'
  return 'none'
}
