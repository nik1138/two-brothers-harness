// Focused tests for src/uiPrefs.ts — the persisted transcript preferences.
// No DOM: every test injects a Storage-like backend.
//
//   node --import ./tests/register-ts.mjs --test tests/uiPrefs.test.ts

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  ACCENT_ATTRIBUTE,
  ACCENT_THEMES,
  DEFAULT_ACCENT,
  DEFAULT_ROLE_THEME,
  DEFAULT_UI_PREFS,
  PROMPT_AUDIT_ENTRY_TYPE,
  ROLE_ATTRIBUTE,
  ROLE_THEMES,
  UI_PREFS_STORAGE_KEY,
  applyAccentAttribute,
  applyRoleThemeAttribute,
  isAccentTheme,
  isRoleTheme,
  isTranscriptEntryVisible,
  normalizeAccentTheme,
  normalizeRoleTheme,
  readUiPrefs,
  saveUiPrefs,
} from '../src/uiPrefs.ts'
import type { AccentAttributeHost, RoleAttributeHost } from '../src/uiPrefs.ts'
import type { StorageLike } from '../src/drafts.ts'

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

/** Storage that behaves like a blocked store: reading and writing both throw. */
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

test('defaults: prompt audits are hidden, and the key is versioned', () => {
  assert.equal(UI_PREFS_STORAGE_KEY, 'two-brothers.ui-prefs.v1')
  assert.equal(DEFAULT_UI_PREFS.showPromptAudits, false)
  assert.equal(DEFAULT_UI_PREFS.accent, 'blue')
  assert.equal(DEFAULT_UI_PREFS.roleTheme, 'default')
  // no backend at all: defaults, no throw
  assert.deepEqual(readUiPrefs({ storage: null }), DEFAULT_UI_PREFS)
  assert.deepEqual(readUiPrefs({ storage: new MemoryStorage() }), DEFAULT_UI_PREFS)
  assert.notEqual(readUiPrefs({ storage: null }), DEFAULT_UI_PREFS, 'returns a copy, not the frozen default')
})

test('round-trip: the preference survives under the versioned key', () => {
  const storage = new MemoryStorage()
  const next = saveUiPrefs({ showPromptAudits: true }, { storage })
  assert.deepEqual(next, { showPromptAudits: true, accent: 'blue', roleTheme: 'default' })
  assert.ok(storage.getItem(UI_PREFS_STORAGE_KEY), 'stored under the versioned key')
  assert.deepEqual(readUiPrefs({ storage }), {
    showPromptAudits: true,
    accent: 'blue',
    roleTheme: 'default',
  })

  // falsy saves are persisted too (the toggle can be turned back off)
  saveUiPrefs({ showPromptAudits: false }, { storage })
  assert.deepEqual(readUiPrefs({ storage }), {
    showPromptAudits: false,
    accent: 'blue',
    roleTheme: 'default',
  })

  // a partial patch preserves the other fields
  saveUiPrefs({ showPromptAudits: true }, { storage })
  assert.deepEqual(saveUiPrefs({}, { storage }), {
    showPromptAudits: true,
    accent: 'blue',
    roleTheme: 'default',
  })
})

test('corrupted / unexpected stored values fail soft to the defaults', () => {
  const cases = ['not json', '[]', 'null', '"true"', '42', '{"showPromptAudits":"yes"}', '{}']
  for (const raw of cases) {
    const storage = new MemoryStorage()
    storage.setItem(UI_PREFS_STORAGE_KEY, raw)
    assert.deepEqual(readUiPrefs({ storage }), DEFAULT_UI_PREFS, `raw=${raw}`)
  }
  // an old shape with a non-boolean field falls back for that field
  const storage = new MemoryStorage()
  storage.setItem(UI_PREFS_STORAGE_KEY, JSON.stringify({ showPromptAudits: 1 }))
  assert.equal(readUiPrefs({ storage }).showPromptAudits, false)
})

test('blocked storage never throws and keeps the in-memory value usable', () => {
  const blocked = new ThrowingStorage()
  assert.deepEqual(readUiPrefs({ storage: blocked }), DEFAULT_UI_PREFS)
  assert.deepEqual(saveUiPrefs({ showPromptAudits: true }, { storage: blocked }), {
    showPromptAudits: true,
    accent: 'blue',
    roleTheme: 'default',
  })
  assert.deepEqual(saveUiPrefs({ accent: 'violet' }, { storage: blocked }), {
    showPromptAudits: false,
    accent: 'violet',
    roleTheme: 'default',
  })
})

test('transcript visibility filter: only prompt audits are concealed', () => {
  assert.equal(PROMPT_AUDIT_ENTRY_TYPE, 'prompt_audit')
  assert.equal(isTranscriptEntryVisible('prompt_audit', false), false)
  assert.equal(isTranscriptEntryVisible('prompt_audit', true), true)
  for (const kind of ['group', 'system', 'tool', 'approval', 'divider']) {
    assert.equal(isTranscriptEntryVisible(kind, false), true, kind)
    assert.equal(isTranscriptEntryVisible(kind, true), true, kind)
  }
})

// -- accent theme preference --------------------------------------------------

/** Attribute host that records what the shell would write on <html>. */
class AttributeHost implements AccentAttributeHost, RoleAttributeHost {
  attrs = new Map<string, string>()

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value)
  }
}

test('accent: constants, default and strict normalization', () => {
  assert.equal(ACCENT_ATTRIBUTE, 'data-accent')
  assert.deepEqual([...ACCENT_THEMES], ['blue', 'violet', 'teal', 'amber'])
  assert.equal(DEFAULT_ACCENT, 'blue')
  assert.equal(DEFAULT_UI_PREFS.accent, 'blue')

  for (const value of ACCENT_THEMES) {
    assert.equal(isAccentTheme(value), true, value)
    assert.equal(normalizeAccentTheme(value), value)
  }
  for (const value of ['', 'BLUE', 'Violet', ' rose ', 'violet ', null, undefined, 1, {}, []]) {
    assert.equal(isAccentTheme(value), false, `rejects ${String(value)}`)
    assert.equal(normalizeAccentTheme(value), 'blue', `normalizes ${String(value)} to blue`)
  }
})

test('accent: round-trips through the versioned preference blob', () => {
  const storage = new MemoryStorage()
  assert.deepEqual(saveUiPrefs({ accent: 'violet' }, { storage }), {
    showPromptAudits: false,
    accent: 'violet',
    roleTheme: 'default',
  })
  assert.deepEqual(readUiPrefs({ storage }), {
    showPromptAudits: false,
    accent: 'violet',
    roleTheme: 'default',
  })

  // A partial patch preserves the other fields in both directions.
  saveUiPrefs({ showPromptAudits: true }, { storage })
  assert.deepEqual(readUiPrefs({ storage }), {
    showPromptAudits: true,
    accent: 'violet',
    roleTheme: 'default',
  })
  saveUiPrefs({ accent: 'teal' }, { storage })
  assert.deepEqual(readUiPrefs({ storage }), {
    showPromptAudits: true,
    accent: 'teal',
    roleTheme: 'default',
  })

  // Back to the default is persisted too.
  saveUiPrefs({ accent: 'blue' }, { storage })
  assert.deepEqual(readUiPrefs({ storage }), {
    showPromptAudits: true,
    accent: 'blue',
    roleTheme: 'default',
  })
})

test('accent: an invalid stored or saved accent falls back to blue', () => {
  const storage = new MemoryStorage()
  storage.setItem(
    UI_PREFS_STORAGE_KEY,
    JSON.stringify({ showPromptAudits: true, accent: 'magenta' }),
  )
  assert.deepEqual(readUiPrefs({ storage }), {
    showPromptAudits: true,
    accent: 'blue',
    roleTheme: 'default',
  })

  // An invalid patch is ignored rather than overwriting a valid stored accent.
  saveUiPrefs({ accent: 'amber' }, { storage })
  saveUiPrefs({ accent: 'magenta' as never }, { storage })
  assert.deepEqual(readUiPrefs({ storage }), {
    showPromptAudits: true,
    accent: 'amber',
    roleTheme: 'default',
  })
})

test('accent: applying the root attribute is normalized and fail-soft', () => {
  const host = new AttributeHost()
  applyAccentAttribute('teal', host)
  assert.equal(host.attrs.get(ACCENT_ATTRIBUTE), 'teal')
  applyAccentAttribute('magenta' as never, host)
  assert.equal(host.attrs.get(ACCENT_ATTRIBUTE), 'blue')
  applyAccentAttribute('blue', host)
  assert.equal(host.attrs.get(ACCENT_ATTRIBUTE), 'blue')
  assert.doesNotThrow(() => applyAccentAttribute('violet', null))
})

// -- role colour palette preference -------------------------------------------

test('roles: constants, default and strict normalization', () => {
  assert.equal(ROLE_ATTRIBUTE, 'data-roles')
  assert.deepEqual([...ROLE_THEMES], ['default', 'contrast', 'neutral'])
  assert.equal(DEFAULT_ROLE_THEME, 'default')
  assert.equal(DEFAULT_UI_PREFS.roleTheme, 'default')

  for (const value of ROLE_THEMES) {
    assert.equal(isRoleTheme(value), true, value)
    assert.equal(normalizeRoleTheme(value), value)
  }
  for (const value of ['', 'DEFAULT', 'Contrast', ' contrast ', 'sepia', null, undefined, 1, {}, []]) {
    assert.equal(isRoleTheme(value), false, `rejects ${String(value)}`)
    assert.equal(
      normalizeRoleTheme(value),
      'default',
      `normalizes ${String(value)} to default`,
    )
  }
})

test('roles: round-trips independently of the accent through the preference blob', () => {
  const storage = new MemoryStorage()
  assert.deepEqual(saveUiPrefs({ roleTheme: 'contrast' }, { storage }), {
    showPromptAudits: false,
    accent: 'blue',
    roleTheme: 'contrast',
  })
  assert.deepEqual(readUiPrefs({ storage }), {
    showPromptAudits: false,
    accent: 'blue',
    roleTheme: 'contrast',
  })

  // Both additive fields coexist and partial patches preserve each other.
  saveUiPrefs({ accent: 'teal', showPromptAudits: true }, { storage })
  assert.deepEqual(readUiPrefs({ storage }), {
    showPromptAudits: true,
    accent: 'teal',
    roleTheme: 'contrast',
  })
  saveUiPrefs({ roleTheme: 'neutral' }, { storage })
  assert.deepEqual(readUiPrefs({ storage }), {
    showPromptAudits: true,
    accent: 'teal',
    roleTheme: 'neutral',
  })

  // Back to the default palette is persisted too.
  saveUiPrefs({ roleTheme: 'default' }, { storage })
  assert.deepEqual(readUiPrefs({ storage }), {
    showPromptAudits: true,
    accent: 'teal',
    roleTheme: 'default',
  })
})

test('roles: an invalid stored or saved palette falls back to the default', () => {
  const storage = new MemoryStorage()
  storage.setItem(
    UI_PREFS_STORAGE_KEY,
    JSON.stringify({ showPromptAudits: true, accent: 'violet', roleTheme: 'sepia' }),
  )
  assert.deepEqual(readUiPrefs({ storage }), {
    showPromptAudits: true,
    accent: 'violet',
    roleTheme: 'default',
  })

  // An invalid patch is ignored rather than overwriting a valid stored palette.
  saveUiPrefs({ roleTheme: 'neutral' }, { storage })
  saveUiPrefs({ roleTheme: 'sepia' as never }, { storage })
  assert.deepEqual(readUiPrefs({ storage }), {
    showPromptAudits: true,
    accent: 'violet',
    roleTheme: 'neutral',
  })
})

test('roles: applying the root attribute is normalized and fail-soft', () => {
  const host = new AttributeHost()
  applyRoleThemeAttribute('contrast', host)
  assert.equal(host.attrs.get(ROLE_ATTRIBUTE), 'contrast')
  applyRoleThemeAttribute('neutral', host)
  assert.equal(host.attrs.get(ROLE_ATTRIBUTE), 'neutral')
  applyRoleThemeAttribute('sepia' as never, host)
  assert.equal(host.attrs.get(ROLE_ATTRIBUTE), 'default')
  applyRoleThemeAttribute('default', host)
  assert.equal(host.attrs.get(ROLE_ATTRIBUTE), 'default')
  assert.doesNotThrow(() => applyRoleThemeAttribute('contrast', null))
})
