// Focused tests for src/keybindings.ts (configurable global chords: defaults,
// validation, conflict detection, matching/labels, the versioned fail-soft
// store) and the dynamic shortcut table entries it feeds into /help.
//   node --import ./tests/register-ts.mjs --test tests/keybindings.test.ts
// The module has no DOM or Vue dependency: every environment is injected.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { StorageLike } from '../src/drafts.ts'
import {
  DEFAULT_KEYBINDINGS,
  KEYBINDINGS_MAX_STORED_CHARS,
  KEYBINDINGS_STORAGE_KEY,
  KEYBINDINGS_VERSION,
  RESERVED_CHORDS,
  bindingErrorCopy,
  bindingFromEvent,
  bindingKeyCaps,
  bindingLabel,
  canonicalKey,
  chordSignature,
  clearKeybindings,
  defaultKeybindings,
  detectBindingPlatform,
  findConflict,
  isBindableKey,
  isModifierOnlyKey,
  isReservedBinding,
  matchesBinding,
  normalizeBinding,
  normalizeKeybindings,
  readKeybindings,
  resetBinding,
  saveKeybindings,
  validateBinding,
  withBinding,
} from '../src/keybindings.ts'
import type { KeyBinding, Keybindings } from '../src/keybindings.ts'
import { SHORTCUTS, shortcutEntries, shortcutGroupViews } from '../src/shortcuts.ts'

class MemoryStorage implements StorageLike {
  data = new Map<string, string>()

  getItem(key: string): string | null {
    return this.data.has(key) ? (this.data.get(key) ?? null) : null
  }

  setItem(key: string, value: string): void {
    this.data.set(key, value)
  }

  removeItem(key: string): void {
    this.data.delete(key)
  }
}

/** Storage that behaves like a blocked store: every operation throws. */
class ThrowingStorage implements StorageLike {
  getItem(): string | null {
    throw new Error('storage blocked')
  }

  setItem(): void {
    throw new Error('quota exceeded')
  }

  removeItem(): void {
    throw new Error('storage blocked')
  }
}

function bind(key: string, mod = true, shift = false, alt = false): KeyBinding {
  return { key, mod, shift, alt }
}

/** A valid binding set with one custom replacement (the rest are defaults). */
function customBindings(patch: Partial<Keybindings>): Keybindings {
  return { ...defaultKeybindings(), ...patch }
}

function byId(entries: ReturnType<typeof shortcutEntries>, id: string) {
  return entries.find((entry) => entry.id === id)
}

// --------------------------------------------------------------------------- //
// defaults, labels and platform detection
// --------------------------------------------------------------------------- //

test('canonical defaults are Mod+K, Mod+F and Mod+/ with platform-aware labels', () => {
  assert.deepEqual(DEFAULT_KEYBINDINGS.palette, bind('k'))
  assert.deepEqual(DEFAULT_KEYBINDINGS.find, bind('f'))
  assert.deepEqual(DEFAULT_KEYBINDINGS['shortcut-help'], bind('/'))

  assert.equal(bindingLabel(DEFAULT_KEYBINDINGS.palette, 'other'), 'Ctrl+K')
  assert.equal(bindingLabel(DEFAULT_KEYBINDINGS.palette, 'mac'), '⌘+K')
  assert.equal(bindingLabel(DEFAULT_KEYBINDINGS.find, 'other'), 'Ctrl+F')
  assert.equal(bindingLabel(DEFAULT_KEYBINDINGS['shortcut-help'], 'mac'), '⌘+/')
  assert.deepEqual(bindingKeyCaps(bind('p', true, true), 'other'), ['Ctrl', 'Shift', 'P'])
  assert.deepEqual(bindingKeyCaps(bind('p', true, true), 'mac'), ['⌘', '⇧', 'P'])
  assert.deepEqual(bindingKeyCaps(bind('?', true, true), 'other'), ['Ctrl', 'Shift', '?'])

  // A fresh set is mutable and never aliases the frozen defaults.
  const fresh = defaultKeybindings()
  fresh.palette.key = 'p'
  assert.equal(DEFAULT_KEYBINDINGS.palette.key, 'k')
  assert.deepEqual(normalizeKeybindings(undefined), defaultKeybindings())
})

test('platform detection is injected and fail-soft (labels only, never matching)', () => {
  assert.equal(detectBindingPlatform({ platform: 'MacIntel' }), 'mac')
  assert.equal(detectBindingPlatform({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)' }), 'mac')
  assert.equal(detectBindingPlatform({ platform: 'Win32', userAgent: 'Windows NT 10.0' }), 'other')
  assert.equal(detectBindingPlatform({ platform: 'Linux x86_64' }), 'other')
  assert.equal(detectBindingPlatform(null), 'other')
  // node has no navigator: the label platform simply defaults to non-mac
  assert.equal(detectBindingPlatform(), 'other')
})

// --------------------------------------------------------------------------- //
// key/chord validation and canonicalization
// --------------------------------------------------------------------------- //

test('keys canonicalize and only one printable ASCII key is bindable', () => {
  assert.equal(canonicalKey('K'), 'k')
  assert.equal(canonicalKey('P'), 'p')
  assert.equal(canonicalKey('?'), '?')
  assert.equal(canonicalKey('/'), '/')
  assert.equal(canonicalKey('ArrowUp'), 'ArrowUp')
  assert.equal(canonicalKey(undefined), '')

  assert.equal(isBindableKey('a'), true)
  assert.equal(isBindableKey('Z'), true)
  assert.equal(isBindableKey('5'), true)
  assert.equal(isBindableKey('/'), true)
  assert.equal(isBindableKey('?'), true)
  assert.equal(isBindableKey(' '), false)
  assert.equal(isBindableKey('ArrowUp'), false)
  assert.equal(isBindableKey('F5'), false)
  assert.equal(isBindableKey(''), false)

  assert.equal(isModifierOnlyKey('Control'), true)
  assert.equal(isModifierOnlyKey('Meta'), true)
  assert.equal(isModifierOnlyKey('Shift'), true)
  assert.equal(isModifierOnlyKey('CapsLock'), true)
  assert.equal(isModifierOnlyKey('k'), false)
  assert.equal(isModifierOnlyKey(''), true)
})

test('validateBinding requires Mod, a printable key, no Alt and no reserved chord', () => {
  assert.equal(validateBinding(bind('k')), null)
  assert.equal(validateBinding(bind('K')), null, 'letters canonicalize')
  assert.equal(validateBinding(bind('p', true, true)), null, 'Shift is allowed')
  assert.equal(validateBinding(bind('/', true)), null)
  assert.equal(validateBinding({ key: 'k', mod: true }), null, 'absent booleans mean false')

  assert.equal(validateBinding(bind('k', false)), 'modifier-required')
  assert.equal(validateBinding(bind('p', false, true)), 'modifier-required', 'plain chords are rejected')
  assert.equal(validateBinding(bind('k', true, false, true)), 'alt-unsupported')
  assert.equal(validateBinding(bind('ArrowUp')), 'unsupported-key')
  assert.equal(validateBinding(bind(' ')), 'unsupported-key')
  assert.equal(validateBinding(null), 'unsupported-key')
  assert.equal(validateBinding('k'), 'unsupported-key')

  // browser/OS-reserved chords are refused honestly
  assert.ok(RESERVED_CHORDS.includes('mod+l'))
  assert.equal(isReservedBinding(bind('l')), true)
  assert.equal(isReservedBinding(bind('w', true, true)), true)
  assert.equal(validateBinding(bind('w')), 'reserved')
  assert.equal(validateBinding(bind('w', true, true)), 'reserved')
  assert.equal(validateBinding(bind('k', true, true)), null)

  assert.ok(normalizeBinding({ key: 'K', mod: true, shift: true, alt: false }))
  assert.equal(normalizeBinding({ key: 'K', mod: true })?.key, 'k')
  assert.equal(normalizeBinding({ key: 'k', mod: false }), null)
  assert.equal(normalizeBinding(null), null)
  assert.equal(chordSignature(bind('p', true, true)), 'mod+shift+p')
  assert.equal(chordSignature(bind('/', true)), 'mod+/')
})

test('every documented browser-reserved chord (Shift variants included) is refused', () => {
  // Keep the module's known set and the docs/keyboard.md claim in lockstep:
  // L/W/T/N/R/Q with and without Shift. Parse each signature back into a
  // binding so the table is the single source of truth.
  assert.equal(RESERVED_CHORDS.length, 12)
  for (const signature of RESERVED_CHORDS) {
    const parts = signature.split('+')
    const binding = {
      key: parts[parts.length - 1] ?? '',
      mod: parts.includes('mod'),
      shift: parts.includes('shift'),
      alt: parts.includes('alt'),
    }
    assert.equal(isReservedBinding(binding), true, `${signature} must be reserved`)
    assert.equal(validateBinding(binding), 'reserved', `${signature} must be rejected`)
  }
  // Shift variants of R and L are browser hard-reload/reload-blocked chords and
  // were the documented-but-unimplemented gap this test pins shut.
  assert.equal(validateBinding(bind('r', true, true)), 'reserved')
  assert.equal(validateBinding(bind('l', true, true)), 'reserved')
})

test('rejection copy is honest and names the conflicting action', () => {
  assert.match(bindingErrorCopy('modifier-required'), /Ctrl or ⌘/)
  assert.match(bindingErrorCopy('unsupported-key'), /printable key/)
  assert.match(bindingErrorCopy('alt-unsupported'), /Alt/)
  assert.match(bindingErrorCopy('reserved'), /reserved/)
  assert.match(bindingErrorCopy('conflict', 'find'), /Find in conversation/)
  assert.match(bindingErrorCopy('conflict'), /already used/)
})

// --------------------------------------------------------------------------- //
// full-set normalization (fail-soft reads)
// --------------------------------------------------------------------------- //

test('normalizeKeybindings repairs invalid/duplicate stored maps deterministically', () => {
  // valid custom map (letters canonicalized, unknown actions ignored)
  const custom = normalizeKeybindings({
    palette: bind('P', true, true),
    find: bind('G'),
    'shortcut-help': bind('/', true),
    unknownAction: bind('x'),
  })
  assert.deepEqual(custom.palette, bind('p', true, true))
  assert.deepEqual(custom.find, bind('g'))
  assert.deepEqual(custom['shortcut-help'], bind('/', true))

  // every invalid entry falls back to its own action's default
  const repaired = normalizeKeybindings({
    palette: bind('k', false),
    find: 'not-a-binding',
    'shortcut-help': bind('ArrowUp'),
  })
  assert.deepEqual(repaired, defaultKeybindings())

  // a duplicate later action falls back to its default (palette keeps its custom)
  const duplicate = normalizeKeybindings({
    palette: bind('g'),
    find: bind('g'),
    'shortcut-help': bind('/', true),
  })
  assert.deepEqual(duplicate.palette, bind('g'))
  assert.deepEqual(duplicate.find, DEFAULT_KEYBINDINGS.find)

  // a contradictory map (even the fallback default is taken) reads as the defaults
  const contradictory = normalizeKeybindings({
    palette: bind('f'),
    find: bind('f'),
    'shortcut-help': bind('f'),
  })
  assert.deepEqual(contradictory, defaultKeybindings())
  assert.deepEqual(normalizeKeybindings('nope'), defaultKeybindings())
})

// --------------------------------------------------------------------------- //
// rebinding + conflict detection
// --------------------------------------------------------------------------- //

test('withBinding validates, rejects duplicate chords and never mutates its input', () => {
  const base = defaultKeybindings()
  const ok = withBinding(base, 'palette', bind('p', true, true))
  assert.equal(ok.ok, true)
  if (ok.ok) {
    assert.deepEqual(ok.bindings.palette, bind('p', true, true))
    assert.notEqual(ok.bindings, base)
    assert.deepEqual(base, defaultKeybindings(), 'the previous set is untouched')
    assert.deepEqual(ok.bindings.find, DEFAULT_KEYBINDINGS.find, 'other actions keep their chords')
  }

  const duplicate = withBinding(base, 'find', bind('k'))
  assert.deepEqual(duplicate, { ok: false, reason: 'conflict', conflict: 'palette' })
  assert.equal(findConflict(base, 'find', bind('k')), 'palette')
  assert.equal(findConflict(base, 'palette', bind('k')), null, 'the action itself is not a conflict')

  const plain = withBinding(base, 'palette', bind('p', false))
  assert.equal(plain.ok, false)
  if (!plain.ok) assert.equal(plain.reason, 'modifier-required')
  const reserved = withBinding(base, 'palette', bind('l'))
  assert.equal(reserved.ok, false)
  if (!reserved.ok) assert.equal(reserved.reason, 'reserved')

  // assigning the current chord again is a successful no-op
  const same = withBinding(base, 'palette', bind('k'))
  assert.equal(same.ok, true)
})

test('resetting one action to its default is conflict-aware', () => {
  const custom = customBindings({ palette: bind('p', true, true) })
  const reset = resetBinding(custom, 'palette')
  assert.equal(reset.ok, true)
  if (reset.ok) assert.deepEqual(reset.bindings.palette, DEFAULT_KEYBINDINGS.palette)

  // an inconsistent hand-written set can block a single-row reset honestly
  const inconsistent = customBindings({ find: bind('k') })
  const blocked = resetBinding(inconsistent, 'palette')
  assert.deepEqual(blocked, { ok: false, reason: 'conflict', conflict: 'find' })
})

// --------------------------------------------------------------------------- //
// event parsing + matching
// --------------------------------------------------------------------------- //

test('bindingFromEvent parses the capture keydown and ignores unusable presses', () => {
  assert.deepEqual(bindingFromEvent({ key: 'P', ctrlKey: true, shiftKey: true }), bind('p', true, true))
  assert.deepEqual(bindingFromEvent({ key: 'K', metaKey: true }), bind('k'))
  assert.deepEqual(bindingFromEvent({ key: '/', ctrlKey: true }), bind('/', true))
  assert.deepEqual(bindingFromEvent({ key: 'k', ctrlKey: true, altKey: true }), bind('k', true, false, true))

  // modifier-only presses keep the capture waiting for the real key
  assert.equal(bindingFromEvent({ key: 'Control', ctrlKey: true }), null)
  assert.equal(bindingFromEvent({ key: 'Meta', metaKey: true }), null)
  assert.equal(bindingFromEvent({ key: 'Shift', shiftKey: true }), null)
  // IME composition is never a capture
  assert.equal(bindingFromEvent({ key: 'k', ctrlKey: true, isComposing: true }), null)
  assert.equal(bindingFromEvent({ key: 'k', ctrlKey: true, keyCode: 229 }), null)
  assert.equal(bindingFromEvent(null), null)
})

test('matching treats Ctrl and ⌘ as the same Mod and keeps the other modifiers exact', () => {
  const palette = DEFAULT_KEYBINDINGS.palette
  assert.equal(matchesBinding({ key: 'k', ctrlKey: true }, palette), true)
  assert.equal(matchesBinding({ key: 'K', metaKey: true }, palette), true, 'mac ⌘ + uppercase event key')
  assert.equal(matchesBinding({ key: 'k' }, palette), false, 'a plain key never matches a Mod chord')
  assert.equal(matchesBinding({ key: 'k', ctrlKey: true, shiftKey: true }, palette), false)
  assert.equal(matchesBinding({ key: 'k', metaKey: true, altKey: true }, palette), false)
  assert.equal(matchesBinding({ key: 'f', ctrlKey: true }, palette), false)
  assert.equal(matchesBinding({ key: 'k', ctrlKey: true, isComposing: true }, palette), false)
  assert.equal(matchesBinding(null, palette), false)
  assert.equal(matchesBinding({ key: 'k', ctrlKey: true }, null), false)

  // a shifted binding needs Shift; a missing Shift fails
  const shifted = bind('p', true, true)
  assert.equal(matchesBinding({ key: 'P', ctrlKey: true, shiftKey: true }, shifted), true)
  assert.equal(matchesBinding({ key: 'p', ctrlKey: true }, shifted), false)
  // Ctrl and ⌘ are interchangeable in both directions
  assert.equal(matchesBinding({ key: 'k', metaKey: true }, bind('k')), true)
  assert.equal(matchesBinding({ key: 'k', ctrlKey: true }, bind('k')), true)
})

// --------------------------------------------------------------------------- //
// persisted store
// --------------------------------------------------------------------------- //

test('the store is versioned, injectable and fail-soft on every bad document', () => {
  const storage = new MemoryStorage()
  assert.deepEqual(readKeybindings({ storage }), defaultKeybindings(), 'missing key = defaults')
  assert.deepEqual(readKeybindings({ storage: null }), defaultKeybindings(), 'no storage = defaults')
  assert.deepEqual(readKeybindings(), defaultKeybindings(), 'node default storage = defaults')

  // round trip: custom set + the documented versioned document shape
  const custom = customBindings({ palette: bind('p', true, true), find: bind('g') })
  const saved = saveKeybindings(custom, { storage })
  assert.deepEqual(saved, custom)
  assert.deepEqual(readKeybindings({ storage }), custom)
  const parsed = JSON.parse(storage.getItem(KEYBINDINGS_STORAGE_KEY) ?? '{}') as {
    version?: number
    bindings?: Keybindings
  }
  assert.equal(parsed.version, KEYBINDINGS_VERSION)
  assert.equal(KEYBINDINGS_STORAGE_KEY, 'two-brothers.keybindings.v1')
  assert.deepEqual(parsed.bindings, custom)

  // wrong version / corrupt JSON / wrong shape / oversized blob -> defaults
  storage.setItem(KEYBINDINGS_STORAGE_KEY, JSON.stringify({ version: 2, bindings: custom }))
  assert.deepEqual(readKeybindings({ storage }), defaultKeybindings())
  storage.setItem(KEYBINDINGS_STORAGE_KEY, '{not json')
  assert.deepEqual(readKeybindings({ storage }), defaultKeybindings())
  storage.setItem(KEYBINDINGS_STORAGE_KEY, JSON.stringify({ version: 1, bindings: 'nope' }))
  assert.deepEqual(readKeybindings({ storage }), defaultKeybindings())
  storage.setItem(KEYBINDINGS_STORAGE_KEY, '"' + 'x'.repeat(KEYBINDINGS_MAX_STORED_CHARS) + '"')
  assert.deepEqual(readKeybindings({ storage }), defaultKeybindings())
  storage.setItem(KEYBINDINGS_STORAGE_KEY, JSON.stringify({ version: 1, bindings: { palette: bind('k', false) } }))
  assert.deepEqual(readKeybindings({ storage }), defaultKeybindings(), 'invalid entry -> its default')

  // clearing restores the defaults
  saveKeybindings(custom, { storage })
  clearKeybindings({ storage })
  assert.deepEqual(readKeybindings({ storage }), defaultKeybindings())

  // blocked storage: reads degrade, writes/clear never throw
  const blocked = new ThrowingStorage()
  assert.deepEqual(readKeybindings({ storage: blocked }), defaultKeybindings())
  assert.doesNotThrow(() => saveKeybindings(custom, { storage: blocked }))
  assert.doesNotThrow(() => clearKeybindings({ storage: blocked }))
})

// --------------------------------------------------------------------------- //
// dynamic /help table
// --------------------------------------------------------------------------- //

test('shortcutEntries renders the current bindings and keeps the fixed keys intact', () => {
  const bindings = customBindings({
    palette: bind('p', true, true),
    find: bind('g'),
    'shortcut-help': bind('/', true),
  })
  const entries = shortcutEntries({ bindings, platform: 'other' })
  assert.deepEqual(byId(entries, 'palette')?.keys, ['Ctrl', 'Shift', 'P'])
  assert.equal(byId(entries, 'palette')?.rebindable, true)
  assert.deepEqual(byId(entries, 'find')?.keys, ['Ctrl', 'G'])
  assert.equal(byId(entries, 'find')?.rebindable, true)
  // the plain ? alias stays fixed in front of the rebindable chord
  assert.deepEqual(byId(entries, 'shortcut-help')?.keys, ['?', 'Ctrl', '/'])
  assert.equal(byId(entries, 'shortcut-help')?.rebindable, true)
  assert.match(byId(entries, 'shortcut-help')?.description ?? '', /\? is a fixed alias/)

  // palette-derived rows follow the palette binding
  for (const id of ['new-session', 'search-sessions', 'theme', 'settings']) {
    assert.deepEqual(byId(entries, id)?.keys, ['Ctrl', 'Shift', 'P'], id)
  }
  // fixed entries keep their declared keys and are not marked rebindable
  assert.deepEqual(byId(entries, 'newline')?.keys, ['Shift', 'Enter'])
  assert.deepEqual(byId(entries, 'stop')?.keys, ['Esc', 'Esc'])
  assert.notEqual(byId(entries, 'newline')?.rebindable, true)

  // labels follow the platform convention (matching does not)
  const macEntries = shortcutEntries({ bindings, platform: 'mac' })
  assert.deepEqual(byId(macEntries, 'palette')?.keys, ['⌘', '⇧', 'P'])
  assert.deepEqual(byId(macEntries, 'shortcut-help')?.keys, ['?', '⌘', '/'])

  // omitted bindings render the canonical defaults; the static table is unchanged
  const defaults = shortcutEntries({ platform: 'other' })
  assert.deepEqual(byId(defaults, 'palette')?.keys, ['Ctrl', 'K'])
  assert.deepEqual(SHORTCUTS.find((entry) => entry.id === 'palette')?.keys, ['Ctrl/⌘', 'K'])

  // the grouped view keeps the declared group order and drops empty groups
  assert.deepEqual(
    shortcutGroupViews(entries).map((view) => view.group),
    ['Composer', 'Pickers', 'Navigation', 'Session', 'Appearance', 'Layers'],
  )
})
