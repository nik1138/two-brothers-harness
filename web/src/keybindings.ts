/**
 * Configurable global key bindings (first slice) and their per-device store.
 *
 * Three modifier chords can be rebound — the command palette, find in the
 * conversation, and this shortcut reference — while every other shortcut in the
 * web workspace stays fixed. This module is pure data plus string surgery: no
 * DOM, no Vue, an injectable `StorageLike`, versioned bounded persistence, and
 * fail-soft reads (a missing/blocked/corrupt blob resolves to the canonical
 * defaults).
 *
 * ## "Mod" is the platform-primary modifier
 * A binding carries one `mod` flag rather than separate Ctrl/Meta bits: it means
 * **Ctrl** on Windows/Linux and **⌘** on macOS. Labels render the detected
 * platform's own cap (`Ctrl` and `⌘` respectively) and the Settings copy says
 * "Ctrl/⌘", while matching accepts *either* physical modifier. That keeps a
 * persisted chord portably working across devices sharing a store (a synced
 * browser profile) and when the platform string is unavailable — the trade-off
 * is documented honestly: pressing either primary modifier is equivalent.
 *
 * ## Validation is strict
 * A chord the browser or OS owns can never reach the page, so a rebindable
 * chord requires `Mod`, exactly one printable ASCII key (letter, digit or
 * punctuation; no space and no named keys such as ArrowUp/F5), no Alt, must not
 * duplicate another rebindable action, and must not be one of the known
 * browser-reserved chords (Ctrl/⌘+L/W/T/N/R/Q and their Shift variants). This
 * list is a known set, not exhaustive: chords the browser or devtools own
 * beyond it may capture silently, which the UI documents. Shift is allowed
 * (e.g. Mod+Shift+P).
 *
 * ## Storage shape
 * `{ "version": 1, "bindings": { palette: {key, mod, shift, alt}, … } }` under
 * {@link KEYBINDINGS_STORAGE_KEY}; anything else — wrong version, wrong shape,
 * oversized blob, unknown/invalid entry, duplicate chord — falls back to the
 * defaults per the honest rules documented on {@link normalizeKeybindings}.
 */

import type { StorageLike } from './drafts'

/** The first-slice rebindable actions, in the order the UI lists them. */
export type KeybindingAction = 'palette' | 'find' | 'shortcut-help'

/** Ordered rebindable actions (also the deterministic normalization order). */
export const KEYBINDING_ACTIONS: readonly KeybindingAction[] = [
  'palette',
  'find',
  'shortcut-help',
]

/** One keyboard chord: one printable key plus exact modifiers. */
export interface KeyBinding {
  /** Canonical key: a single printable ASCII character, lowercase for letters. */
  key: string
  /** Platform-primary modifier ("Mod"): Ctrl outside macOS, ⌘ on macOS. */
  mod: boolean
  shift: boolean
  alt: boolean
}

/** The complete binding set. */
export interface Keybindings {
  palette: KeyBinding
  find: KeyBinding
  'shortcut-help': KeyBinding
}

/** Human copy for one action (Settings rows, help entries, tests). */
export interface KeybindingActionInfo {
  action: KeybindingAction
  label: string
  description: string
}

/** Settings/help copy per action; the single source for action names. */
export const KEYBINDING_ACTION_INFO: Readonly<
  Record<KeybindingAction, KeybindingActionInfo>
> = Object.freeze({
  palette: Object.freeze({
    action: 'palette' as const,
    label: 'Command palette',
    description: 'Search sessions, messages and actions.',
  }),
  find: Object.freeze({
    action: 'find' as const,
    label: 'Find in conversation',
    description: 'Search the open transcript, case-sensitively on request.',
  }),
  'shortcut-help': Object.freeze({
    action: 'shortcut-help' as const,
    label: 'Shortcut reference',
    description: 'Open this commands & shortcuts reference.',
  }),
})

/** Canonical defaults: Mod+K, Mod+F, Mod+/ (the pre-rebinding chords). */
export const DEFAULT_KEYBINDINGS: Readonly<Keybindings> = Object.freeze({
  palette: Object.freeze({ key: 'k', mod: true, shift: false, alt: false }),
  find: Object.freeze({ key: 'f', mod: true, shift: false, alt: false }),
  'shortcut-help': Object.freeze({ key: '/', mod: true, shift: false, alt: false }),
})

/** Versioned key: bump the suffix when the stored shape changes incompatibly. */
export const KEYBINDINGS_STORAGE_KEY = 'two-brothers.keybindings.v1'

/** On-disk schema version; any other version reads as the defaults. */
export const KEYBINDINGS_VERSION = 1

/** Stored blob cap: a hand-written or corrupt blob larger than this is ignored. */
export const KEYBINDINGS_MAX_STORED_CHARS = 4096

/** The versioned JSON document written by {@link saveKeybindings}. */
export interface KeybindingsFile {
  version: typeof KEYBINDINGS_VERSION
  bindings: Keybindings
}

// --------------------------------------------------------------------------- //
// platform + label formatting
// --------------------------------------------------------------------------- //

/** The two label conventions the app renders. */
export type BindingPlatform = 'mac' | 'other'

/** The structural subset of `navigator` used for platform detection. */
export interface NavigatorLike {
  platform?: string
  userAgent?: string
}

const MAC_PATTERN = /Mac|iPhone|iPad|iPod/i

/**
 * Detect the label platform. Only labels differ: matching treats Ctrl and ⌘ as
 * the same "Mod". Accepts an injected navigator-like object so tests stay
 * deterministic; a missing/unreadable environment looks like non-mac.
 */
export function detectBindingPlatform(navigatorLike?: NavigatorLike | null): BindingPlatform {
  const nav =
    navigatorLike === undefined
      ? typeof navigator === 'undefined'
        ? null
        : navigator
      : navigatorLike
  if (!nav) return 'other'
  const probe = `${nav.platform ?? ''} ${nav.userAgent ?? ''}`
  return MAC_PATTERN.test(probe) ? 'mac' : 'other'
}

const MOD_CAP: Readonly<Record<BindingPlatform, string>> = { mac: '⌘', other: 'Ctrl' }
const ALT_CAP: Readonly<Record<BindingPlatform, string>> = { mac: '⌥', other: 'Alt' }
const SHIFT_CAP: Readonly<Record<BindingPlatform, string>> = { mac: '⇧', other: 'Shift' }

/** Display cap for the chord's key (letters are uppercased, punctuation kept). */
export function displayKeyCap(binding: KeyBinding): string {
  return /^[a-z]$/.test(binding.key) ? binding.key.toUpperCase() : binding.key
}

/** Ordered key caps for `<kbd>` rendering (mod, alt, shift, key). */
export function bindingKeyCaps(
  binding: KeyBinding,
  platform: BindingPlatform = detectBindingPlatform(),
): string[] {
  const caps: string[] = []
  if (binding.mod) caps.push(MOD_CAP[platform])
  if (binding.alt) caps.push(ALT_CAP[platform])
  if (binding.shift) caps.push(SHIFT_CAP[platform])
  caps.push(displayKeyCap(binding))
  return caps
}

/** One-line label, e.g. `Ctrl+K`, `Ctrl+Shift+P`, `⌘+/`. */
export function bindingLabel(
  binding: KeyBinding,
  platform: BindingPlatform = detectBindingPlatform(),
): string {
  return bindingKeyCaps(binding, platform).join('+')
}

// --------------------------------------------------------------------------- //
// key + chord validation
// --------------------------------------------------------------------------- //

const MODIFIER_EVENT_KEYS = new Set([
  'Alt',
  'AltGraph',
  'CapsLock',
  'Control',
  'Dead',
  'Fn',
  'FnLock',
  'Hyper',
  'Meta',
  'NumLock',
  'OS',
  'Process',
  'ScrollLock',
  'Shift',
  'Super',
  'Symbol',
  'SymbolLock',
  'Unidentified',
])

/** One printable ASCII key; space (0x20) and named keys are not bindable. */
const PRINTABLE_SINGLE_KEY = /^[\x21-\x7e]$/

/** Canonical form of an event/programmatic key (`K` → `k`, punctuation as-is). */
export function canonicalKey(key: unknown): string {
  if (typeof key !== 'string') return ''
  if (key.length === 1 && /[a-z]/i.test(key)) return key.toLowerCase()
  return key
}

/** True for one printable ASCII key (letters case-insensitively include digits). */
export function isBindableKey(key: unknown): key is string {
  return typeof key === 'string' && PRINTABLE_SINGLE_KEY.test(key)
}

/**
 * Chords the browser/OS consumes ahead of the page (address bar, tab/window
 * management, reload, quit) — a page cannot reliably prevent them, so capture
 * refuses them with an honest inline message.
 */
export const RESERVED_CHORDS: readonly string[] = [
  'mod+l',
  'mod+w',
  'mod+t',
  'mod+n',
  'mod+r',
  'mod+q',
  'mod+shift+w',
  'mod+shift+t',
  'mod+shift+n',
  'mod+shift+q',
  'mod+shift+l',
  'mod+shift+r',
]

/** Canonical chord signature used for conflict detection and reserved checks. */
export function chordSignature(binding: KeyBinding): string {
  return (
    `${binding.mod ? 'mod+' : ''}${binding.alt ? 'alt+' : ''}` +
    `${binding.shift ? 'shift+' : ''}${binding.key}`
  )
}

/** True when the chord is one the browser/OS may handle before the page. */
export function isReservedBinding(binding: KeyBinding): boolean {
  return RESERVED_CHORDS.includes(chordSignature(binding))
}

/** Why a candidate chord is not bindable (null = it is). */
export type BindingIssue =
  | 'modifier-required'
  | 'unsupported-key'
  | 'alt-unsupported'
  | 'reserved'

/** Why a rebind attempt failed (an issue, or a duplicate used by another action). */
export type BindingChangeError = BindingIssue | 'conflict'

function coerceBinding(value: unknown): KeyBinding | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (typeof record.key !== 'string') return null
  return {
    key: canonicalKey(record.key),
    mod: record.mod === true,
    shift: record.shift === true,
    alt: record.alt === true,
  }
}

/** Validate one candidate binding; null means it may be persisted. */
export function validateBinding(value: unknown): BindingIssue | null {
  const binding = coerceBinding(value)
  if (binding === null) return 'unsupported-key'
  if (!binding.mod) return 'modifier-required'
  if (binding.alt) return 'alt-unsupported'
  if (!isBindableKey(binding.key)) return 'unsupported-key'
  if (isReservedBinding(binding)) return 'reserved'
  return null
}

/** Coerce a valid stored value into its canonical form, or null when invalid. */
export function normalizeBinding(value: unknown): KeyBinding | null {
  if (validateBinding(value) !== null) return null
  return coerceBinding(value)
}

/** Honest inline copy for a rejected rebind attempt. */
export function bindingErrorCopy(
  reason: BindingChangeError,
  conflict?: KeybindingAction,
): string {
  switch (reason) {
    case 'modifier-required':
      return 'Include Ctrl or ⌘ in the combination.'
    case 'unsupported-key':
      return 'Use one printable key — a letter, digit or punctuation mark. Named keys and spaces are not bindable.'
    case 'alt-unsupported':
      return 'Alt combinations are reserved by the operating system; use Ctrl/⌘ instead.'
    case 'reserved':
      return 'That chord is reserved by the browser or the operating system and cannot be captured.'
    case 'conflict':
      return conflict === undefined
        ? 'That chord is already used by another rebindable shortcut.'
        : `That chord is already used by ${KEYBINDING_ACTION_INFO[conflict].label}.`
  }
}

// --------------------------------------------------------------------------- //
// full-set normalization, rebinding and conflict detection
// --------------------------------------------------------------------------- //

function defaultBindingFor(action: KeybindingAction): KeyBinding {
  return { ...DEFAULT_KEYBINDINGS[action] }
}

/** A fresh, canonical defaults set (safe to mutate by callers). */
export function defaultKeybindings(): Keybindings {
  return {
    palette: defaultBindingFor('palette'),
    find: defaultBindingFor('find'),
    'shortcut-help': defaultBindingFor('shortcut-help'),
  }
}

function setBindingOn(
  bindings: Keybindings,
  action: KeybindingAction,
  binding: KeyBinding,
): Keybindings {
  return {
    palette: action === 'palette' ? binding : bindings.palette,
    find: action === 'find' ? binding : bindings.find,
    'shortcut-help': action === 'shortcut-help' ? binding : bindings['shortcut-help'],
  }
}

/**
 * Normalize a stored binding map into a valid conflict-free set.
 *
 * Per action: a valid stored entry wins; anything unknown/invalid falls back to
 * that action's default. If a resulting chord duplicates an earlier action's
 * chord, the later action falls back to its default; if even that default is
 * still taken (a contradictory hand-written blob), the whole set reads as the
 * canonical defaults. Unknown action names are ignored.
 */
export function normalizeKeybindings(value: unknown): Keybindings {
  const record =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  const accepted = defaultKeybindings()
  const used = new Set<string>()
  const fallback = defaultKeybindings()
  for (const action of KEYBINDING_ACTIONS) {
    const stored = normalizeBinding(record[action])
    let candidate = stored ?? fallback[action]
    if (used.has(chordSignature(candidate))) {
      const ownDefault = fallback[action]
      if (used.has(chordSignature(ownDefault))) return defaultKeybindings()
      candidate = ownDefault
    }
    accepted[action] = candidate
    used.add(chordSignature(candidate))
  }
  return accepted
}

/** The action already using `binding`, if any (the action itself excluded). */
export function findConflict(
  bindings: Keybindings,
  action: KeybindingAction,
  binding: KeyBinding,
): KeybindingAction | null {
  const signature = chordSignature(binding)
  for (const other of KEYBINDING_ACTIONS) {
    if (other === action) continue
    const current = bindings[other]
    if (current !== undefined && chordSignature(current) === signature) return other
  }
  return null
}

/** Successful rebind; the returned set is a fresh object. */
export interface BindingChangeSuccess {
  ok: true
  bindings: Keybindings
}

/** Rejected rebind: an inline-renderable reason plus the conflicting action. */
export interface BindingChangeFailure {
  ok: false
  reason: BindingChangeError
  conflict?: KeybindingAction
}

/** Result of one rebind/reset attempt. */
export type BindingChangeResult = BindingChangeSuccess | BindingChangeFailure

/** Validate + conflict-check one candidate chord for `action`. */
export function withBinding(
  bindings: Keybindings,
  action: KeybindingAction,
  binding: KeyBinding,
): BindingChangeResult {
  const issue = validateBinding(binding)
  if (issue !== null) return { ok: false, reason: issue }
  const conflict = findConflict(bindings, action, binding)
  if (conflict !== null) return { ok: false, reason: 'conflict', conflict }
  const normalized = coerceBinding(binding) ?? defaultBindingFor(action)
  return { ok: true, bindings: setBindingOn(bindings, action, normalized) }
}

/**
 * Reset one action to its default. A conflicting custom chord on another action
 * makes this fail honestly (the operator must reset/change that one first); a
 * global reset is always conflict-free.
 */
export function resetBinding(
  bindings: Keybindings,
  action: KeybindingAction,
): BindingChangeResult {
  return withBinding(bindings, action, defaultBindingFor(action))
}

// --------------------------------------------------------------------------- //
// keyboard events: capture parsing + matching
// --------------------------------------------------------------------------- //

/** The structural subset of `KeyboardEvent` the binding code reads. */
export interface KeybindingEventLike {
  key: string
  ctrlKey?: boolean
  metaKey?: boolean
  shiftKey?: boolean
  altKey?: boolean
  isComposing?: boolean
  keyCode?: number
}

/** True for a pure modifier press (capture keeps waiting for the real key). */
export function isModifierOnlyKey(key: unknown): boolean {
  return typeof key !== 'string' || key === '' || MODIFIER_EVENT_KEYS.has(key)
}

/**
 * Parse one keydown into a candidate binding for the capture UI. Returns null
 * while an IME is composing and for modifier-only presses; otherwise the
 * modifiers are read exactly as pressed (validation happens afterwards, so an
 * invalid candidate can produce a specific inline message).
 */
export function bindingFromEvent(
  event: KeybindingEventLike | null | undefined,
): KeyBinding | null {
  if (!event || typeof event.key !== 'string') return null
  if (event.isComposing === true || event.keyCode === 229) return null
  if (isModifierOnlyKey(event.key)) return null
  return {
    key: canonicalKey(event.key),
    mod: event.ctrlKey === true || event.metaKey === true,
    shift: event.shiftKey === true,
    alt: event.altKey === true,
  }
}

/**
 * True when the event is exactly the binding: Ctrl and ⌘ are the same "Mod"
 * (either may be pressed), Shift and Alt must match exactly, letter case is
 * canonical. Composing keystrokes never match.
 */
export function matchesBinding(
  event: KeybindingEventLike | null | undefined,
  binding: KeyBinding | null | undefined,
): boolean {
  if (!event || !binding || typeof event.key !== 'string') return false
  if (event.isComposing === true || event.keyCode === 229) return false
  const mod = event.ctrlKey === true || event.metaKey === true
  if (mod !== binding.mod) return false
  if ((event.shiftKey === true) !== binding.shift) return false
  if ((event.altKey === true) !== binding.alt) return false
  return canonicalKey(event.key) === binding.key
}

// --------------------------------------------------------------------------- //
// persisted store (fail-soft, versioned, injectable storage)
// --------------------------------------------------------------------------- //

/** Options shared by the store helpers; omitted storage = browser localStorage. */
export interface KeybindingsStoreOptions {
  /**
   * Storage backend. Omitted = `window.localStorage` when it is reachable;
   * explicit `null` disables persistence (tests and non-DOM callers).
   */
  storage?: StorageLike | null
}

/** A browser `localStorage` if it exists and reading it does not throw. */
export function defaultKeybindingsStorage(): StorageLike | null {
  try {
    if (typeof window === 'undefined') return null
    return window.localStorage ?? null
  } catch {
    // even accessing the property can throw when storage is blocked
    return null
  }
}

function resolveStorage(options: KeybindingsStoreOptions): StorageLike | null {
  return options.storage === undefined ? defaultKeybindingsStorage() : options.storage
}

/**
 * Read the persisted bindings. Every failure — missing/blocked storage, an
 * oversized or corrupt blob, a wrong version, unknown/invalid entries or
 * duplicate chords — resolves to a valid canonical set (never throws).
 */
export function readKeybindings(options: KeybindingsStoreOptions = {}): Keybindings {
  const storage = resolveStorage(options)
  if (!storage) return defaultKeybindings()
  try {
    const raw = storage.getItem(KEYBINDINGS_STORAGE_KEY)
    if (typeof raw !== 'string' || raw === '' || raw.length > KEYBINDINGS_MAX_STORED_CHARS) {
      return defaultKeybindings()
    }
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return defaultKeybindings()
    }
    const document = parsed as { version?: unknown; bindings?: unknown }
    if (document.version !== KEYBINDINGS_VERSION) return defaultKeybindings()
    return normalizeKeybindings(document.bindings)
  } catch {
    return defaultKeybindings()
  }
}

/**
 * Persist a binding set (normalized first) and return the stored snapshot.
 * Blocked storage and quota errors are swallowed: the choice still applies for
 * the rest of the page view, only the next visit forgets it.
 */
export function saveKeybindings(
  bindings: unknown,
  options: KeybindingsStoreOptions = {},
): Keybindings {
  const normalized = normalizeKeybindings(bindings)
  const storage = resolveStorage(options)
  if (!storage) return normalized
  try {
    const document: KeybindingsFile = {
      version: KEYBINDINGS_VERSION,
      bindings: normalized,
    }
    storage.setItem(KEYBINDINGS_STORAGE_KEY, JSON.stringify(document))
  } catch {
    // storage blocked / quota exceeded: the in-memory bindings survive
  }
  return normalized
}

/** Drop the persisted bindings (the next read is the defaults). Fail-soft. */
export function clearKeybindings(options: KeybindingsStoreOptions = {}): void {
  const storage = resolveStorage(options)
  if (!storage) return
  try {
    storage.removeItem(KEYBINDINGS_STORAGE_KEY)
  } catch {
    // blocked storage: nothing to clear
  }
}
