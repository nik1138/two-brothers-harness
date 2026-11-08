/**
 * Small persisted UI preferences that are not layout-critical (prompt audits,
 * the accent theme and the role-colour palette).
 *
 * Follows the density/drafts pattern: one versioned localStorage key, no DOM
 * or Vue dependency, an injectable storage backend, and fail-soft reads/writes.
 * A missing, unreadable or corrupt value resolves to the defaults, so a broken
 * blob can never leave the conversation without its usual clean transcript or
 * with an unknown accent/role palette.
 */

import type { StorageLike } from './drafts'

/** Operator-selectable accent theme; `blue` is the product default. */
export type AccentTheme = 'blue' | 'violet' | 'teal' | 'amber'

/** Every supported accent, default first (the order the chooser renders). */
export const ACCENT_THEMES: readonly AccentTheme[] = ['blue', 'violet', 'teal', 'amber']

/** Used whenever nothing usable is stored; the `:root` token palette is it. */
export const DEFAULT_ACCENT: AccentTheme = 'blue'

/** Attribute written on <html>; tokens.css keys the variant blocks off it. */
export const ACCENT_ATTRIBUTE = 'data-accent'

/** Operator-selectable role-colour palette; `default` is the product default. */
export type RoleTheme = 'default' | 'contrast' | 'neutral'

/** Every supported role palette, default first (the order the chooser renders). */
export const ROLE_THEMES: readonly RoleTheme[] = ['default', 'contrast', 'neutral']

/** Used whenever nothing usable is stored; the base role tokens are it. */
export const DEFAULT_ROLE_THEME: RoleTheme = 'default'

/** Attribute written on <html>; tokens.css keys the role palette blocks off it. */
export const ROLE_ATTRIBUTE = 'data-roles'

/** Persisted UI preferences. */
export interface UiPrefs {
  /**
   * Render the per-model-call prompt-audit annotations in the transcript.
   * Off by default: they are developer information, not conversation.
   */
  showPromptAudits: boolean
  /**
   * Accent theme (blue default, violet/teal/amber variants). Applied as
   * `data-accent` on <html> and persisted beside the other preferences; a
   * missing/unknown stored value reads as the default.
   */
  accent: AccentTheme
  /**
   * Role-colour palette (`default`, `contrast`, `neutral`). Applied as
   * `data-roles` on <html> and persisted beside the other preferences; a
   * missing/unknown stored value reads as the default palette.
   */
  roleTheme: RoleTheme
}

/** Versioned key: bump the suffix when the stored shape changes incompatibly. */
export const UI_PREFS_STORAGE_KEY = 'two-brothers.ui-prefs.v1'

/** Used whenever nothing usable is stored. */
export const DEFAULT_UI_PREFS: UiPrefs = Object.freeze({
  showPromptAudits: false,
  accent: DEFAULT_ACCENT,
  roleTheme: DEFAULT_ROLE_THEME,
})

/** Timeline entry type hidden by the transcript preference. */
export const PROMPT_AUDIT_ENTRY_TYPE = 'prompt_audit'

/** Runtime guard for values that crossed a storage or type boundary. */
export function isAccentTheme(value: unknown): value is AccentTheme {
  return typeof value === 'string' && (ACCENT_THEMES as readonly string[]).includes(value)
}

/** Strict normalization: an unknown/absent accent reads as the default blue. */
export function normalizeAccentTheme(value: unknown): AccentTheme {
  return isAccentTheme(value) ? value : DEFAULT_ACCENT
}

/** Runtime guard for values that crossed a storage or type boundary. */
export function isRoleTheme(value: unknown): value is RoleTheme {
  return typeof value === 'string' && (ROLE_THEMES as readonly string[]).includes(value)
}

/** Strict normalization: an unknown/absent role palette reads as the default. */
export function normalizeRoleTheme(value: unknown): RoleTheme {
  return isRoleTheme(value) ? value : DEFAULT_ROLE_THEME
}

/** Anything that can carry the attribute — an Element satisfies it. */
export interface AccentAttributeHost {
  setAttribute(name: string, value: string): void
}

/**
 * Write the accent attribute tokens.css reads. Blue is written explicitly (it
 * is the value the chooser shows as selected); the sheet defines no block for
 * it, so the base `:root` palette stays authoritative. An invalid accent falls
 * back to blue rather than writing junk onto the root.
 */
export function applyAccentAttribute(
  accent: AccentTheme,
  host?: AccentAttributeHost | null,
): void {
  const target =
    host === undefined
      ? typeof document === 'undefined'
        ? null
        : document.documentElement
      : host
  if (!target) return
  target.setAttribute(ACCENT_ATTRIBUTE, normalizeAccentTheme(accent))
}

/** Anything that can carry the attribute — an Element satisfies it. */
export interface RoleAttributeHost {
  setAttribute(name: string, value: string): void
}

/**
 * Write the role-palette attribute tokens.css reads. The default palette is
 * written explicitly (`data-roles="default"`, what the chooser shows selected);
 * the sheet defines no block for it, so the base `:root` role tokens stay
 * authoritative. An invalid value falls back to the default rather than writing
 * junk onto the root.
 */
export function applyRoleThemeAttribute(
  roleTheme: RoleTheme,
  host?: RoleAttributeHost | null,
): void {
  const target =
    host === undefined
      ? typeof document === 'undefined'
        ? null
        : document.documentElement
      : host
  if (!target) return
  target.setAttribute(ROLE_ATTRIBUTE, normalizeRoleTheme(roleTheme))
}

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
 * accepted for `showPromptAudits`, only a known accent name for `accent` and
 * only a known role palette for `roleTheme`; anything else falls back to that
 * field's default.
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
      accent: normalizeAccentTheme(record.accent),
      roleTheme: normalizeRoleTheme(record.roleTheme),
    }
  } catch {
    return { ...DEFAULT_UI_PREFS }
  }
}

/**
 * Persist a partial preference update, preserving the other fields. A patch
 * field outside its valid domain is ignored rather than persisted. Blocked
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
    ...(isAccentTheme(patch.accent) ? { accent: patch.accent } : {}),
    ...(isRoleTheme(patch.roleTheme) ? { roleTheme: patch.roleTheme } : {}),
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
