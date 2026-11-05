// Focused tests for src/density.ts — run directly (the sandbox blocks spawned
// `node --test` runners, and the DSH instruction is to run test files one by
// one):
//   node --import ./tests/register-ts.mjs tests/density.test.ts
// The module has no DOM dependency: every test injects a Storage-like backend
// and a bare attribute host, so no browser is needed.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  DEFAULT_DENSITY,
  DENSITY_ATTRIBUTE,
  DENSITY_STORAGE_KEY,
  applyDensityAttribute,
  isDensity,
  otherDensity,
  readDensity,
  saveDensity,
} from '../src/density.ts'
import type { DensityAttributeHost } from '../src/density.ts'
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

class AttributeHost implements DensityAttributeHost {
  attrs = new Map<string, string>()

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value)
  }
}

test('contract: versioned key, attribute name and default mode', () => {
  assert.equal(DENSITY_STORAGE_KEY, 'two-brothers.density.v1')
  assert.equal(DENSITY_ATTRIBUTE, 'data-density')
  assert.equal(DEFAULT_DENSITY, 'comfortable')
})

test('isDensity accepts exactly the two supported modes', () => {
  assert.equal(isDensity('comfortable'), true)
  assert.equal(isDensity('compact'), true)
  for (const value of ['', 'COMPACT', 'Comfortable', ' cozy ', null, undefined, 1, {}, []]) {
    assert.equal(isDensity(value), false, `rejects ${String(value)}`)
  }
})

test('read: missing or empty storage resolves to Comfortable', () => {
  assert.equal(readDensity({ storage: new MemoryStorage() }), 'comfortable')
  assert.equal(readDensity({ storage: null }), 'comfortable')
})

test('roundtrip: each mode persists and reads back under the versioned key', () => {
  const storage = new MemoryStorage()
  saveDensity('compact', { storage })
  assert.equal(storage.getItem(DENSITY_STORAGE_KEY), 'compact')
  assert.equal(readDensity({ storage }), 'compact')

  saveDensity('comfortable', { storage })
  assert.equal(storage.getItem(DENSITY_STORAGE_KEY), 'comfortable')
  assert.equal(readDensity({ storage }), 'comfortable')
})

test('fail-soft: unknown stored values fall back to Comfortable', () => {
  const storage = new MemoryStorage()
  for (const stored of ['dense', 'Compact', 'compact ', '{"mode":"compact"}']) {
    storage.setItem(DENSITY_STORAGE_KEY, stored)
    assert.equal(readDensity({ storage }), 'comfortable', `unknown value ${JSON.stringify(stored)}`)
  }
})

test('fail-soft: blocked storage neither throws nor loses the default', () => {
  const storage = new ThrowingStorage()
  assert.equal(readDensity({ storage }), 'comfortable')
  assert.doesNotThrow(() => saveDensity('compact', { storage }))
  assert.doesNotThrow(() => saveDensity('compact', { storage: null }))
})

test('save: a runtime-invalid value is ignored rather than persisted', () => {
  const storage = new MemoryStorage()
  saveDensity('dense' as never, { storage })
  assert.equal(storage.getItem(DENSITY_STORAGE_KEY), null)
})

test('attribute: apply writes data-density on the injected host', () => {
  const host = new AttributeHost()
  applyDensityAttribute('compact', host)
  assert.equal(host.attrs.get('data-density'), 'compact')

  applyDensityAttribute('comfortable', host)
  assert.equal(host.attrs.get('data-density'), 'comfortable')
})

test('attribute: an invalid mode is normalized to Comfortable, never a third state', () => {
  const host = new AttributeHost()
  applyDensityAttribute('tiny' as never, host)
  assert.equal(host.attrs.get('data-density'), 'comfortable')
})

test('attribute: a null host is a no-op (no DOM in node tests)', () => {
  assert.doesNotThrow(() => applyDensityAttribute('compact', null))
})

test('toggle: otherDensity flips between the two modes', () => {
  assert.equal(otherDensity('compact'), 'comfortable')
  assert.equal(otherDensity('comfortable'), 'compact')
})
