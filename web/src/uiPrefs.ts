/**
 * Small persisted UI preferences that are not layout-critical (currently only
 * `showPromptAudits`).
 *
 * Follows the density/drafts pattern: one versioned localStorage key, no DOM
 * or Vue dependency, an injectable storage backend, and fail-soft reads/writes.
 * A missing, unreadable or corrupt value resolves to the defaults, so a broken
 * blob can never leave the conversation without its usual clean transcript.
 */

import type { StorageLike } from './drafts'

/** Persisted UI preferences. */
export interface UiPrefs {
  /**
   * Render the per-model-call prompt-audit annotations in the transcript.
   * Off by default: they are developer information, not conversation.
   */
  showPromptAudits: boolean
}

/** Versioned key: bump the suffix when the stored shape changes incompatibly. */
export const UI_PREFS_STORAGE_KEY = 'two-brothers.ui-prefs.v1'

/** Used whenever nothing usable is stored. */
export const DEFAULT_UI_PREFS: UiPrefs = Object.freeze({ showPromptAudits: false })

/** Timeline entry type hidden by the transcript preference. */
export const PROMPT_AUDIT_ENTRY_TYPE = 'prompt_audit'

/** The minimal Storage surface this module needs (a `Storage` satisfies it). */
export interface UiPrefsStoreOptions {
  /**
   * Storage backend. Omitted = `window.localStorage` when it is reachable;
   * explicit `null` disables persistence (tests and non-DOM callers).
   */
  storage?: StorageLike | null
}

/** A browser `localStorage` if it exists and reading it does not throw. */
export function defaultUiPrefsStorage(): StorageLike | null {
  try {
    if (typeof window === 'undefined') return null
    return window.localStorage ?? null
  } catch {
    // even accessing the property can throw when storage is blocked
    return null
  }
}

function resolveStorage(options: UiPrefsStoreOptions): StorageLike | null {
  return options.storage === undefined ? defaultUiPrefsStorage() : options.storage
}

/**
 * Stored preferences, merged over the defaults. Only a stored `boolean` is
 * accepted for `showPromptAudits`; anything else falls back to the default.
 */
export function readUiPrefs(options: UiPrefsStoreOptions = {}): UiPrefs {
  const storage = resolveStorage(options)
  if (!storage) return { ...DEFAULT_UI_PREFS }
  try {
    const raw = storage.getItem(UI_PREFS_STORAGE_KEY)
    if (typeof raw !== 'string' || raw === '') return { ...DEFAULT_UI_PREFS }
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ...DEFAULT_UI_PREFS }
    }
    const record = parsed as Record<string, unknown>
    return {
      showPromptAudits:
        typeof record.showPromptAudits === 'boolean'
          ? record.showPromptAudits
          : DEFAULT_UI_PREFS.showPromptAudits,
    }
  } catch {
    return { ...DEFAULT_UI_PREFS }
  }
}

/**
 * Persist a partial preference update, preserving the other fields. Blocked
 * storage and quota errors are swallowed: the choice still applies for this
 * page view, only the next visit forgets it. Returns the resulting snapshot.
 */
export function saveUiPrefs(
  patch: Partial<UiPrefs>,
  options: UiPrefsStoreOptions = {},
): UiPrefs {
  const next: UiPrefs = {
    ...readUiPrefs(options),
    ...(typeof patch.showPromptAudits === 'boolean'
      ? { showPromptAudits: patch.showPromptAudits }
      : {}),
  }
  const storage = resolveStorage(options)
  if (!storage) return next
  try {
    storage.setItem(UI_PREFS_STORAGE_KEY, JSON.stringify(next))
  } catch {
    // storage blocked / quota exceeded: the in-memory preference survives
  }
  return next
}

/**
 * Pure transcript filter: prompt-audit annotations are the only rows the
 * preference conceals. Everything else always renders.
 */
export function isTranscriptEntryVisible(
  entryType: string,
  showPromptAudits: boolean,
): boolean {
  return entryType !== PROMPT_AUDIT_ENTRY_TYPE || showPromptAudits
}
