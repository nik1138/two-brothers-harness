// Focused tests for src/drafts.ts — run directly (the sandbox blocks spawned
// `node --test` runners, and the DSH instruction is to run test files one by
// one):
//   node --import ./tests/register-ts.mjs tests/drafts.test.ts
// The module has no DOM dependency: every test injects a Storage-like backend.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  DRAFTS_STORAGE_KEY,
  MAX_DRAFT_CHARS,
  MAX_DRAFTS,
  clearDraft,
  getDraft,
  setDraft,
} from '../src/drafts.ts'
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

interface StoredDraft {
  text: string
  updatedAt: number
}

/** Decode the whole persisted blob (test-only view of the stored shape). */
function storedMap(storage: MemoryStorage): Record<string, StoredDraft> {
  const raw = storage.getItem(DRAFTS_STORAGE_KEY)
  return raw ? (JSON.parse(raw) as Record<string, StoredDraft>) : {}
}

test('bounds: the exported key and caps match the storage contract', () => {
  assert.equal(DRAFTS_STORAGE_KEY, 'two-brothers.drafts.v1')
  assert.equal(MAX_DRAFT_CHARS, 16_384)
  assert.equal(MAX_DRAFTS, 50)
})

test('roundtrip: text survives verbatim under the versioned key; empty text clears', () => {
  const storage = new MemoryStorage()
  const text = 'line one\n  line two — keep trailing spaces   '
  setDraft('session-a', text, { storage, now: 1_000 })

  assert.equal(getDraft('session-a', { storage }), text)
  assert.deepEqual(storedMap(storage)['session-a'], { text, updatedAt: 1_000 })
  assert.ok(storage.getItem(DRAFTS_STORAGE_KEY), 'drafts live under the versioned key')

  setDraft('session-a', '', { storage, now: 1_100 })
  assert.equal(getDraft('session-a', { storage }), '')
  assert.equal(storage.getItem(DRAFTS_STORAGE_KEY), null, 'clearing the last draft drops the key')
})

test('per-session isolation: editing or clearing one draft never touches another', () => {
  const storage = new MemoryStorage()
  setDraft('s1', 'alpha', { storage, now: 1 })
  setDraft('s2', 'beta', { storage, now: 2 })

  setDraft('s1', 'alpha edited', { storage, now: 3 })
  assert.equal(getDraft('s1', { storage }), 'alpha edited')
  assert.equal(getDraft('s2', { storage }), 'beta')
  assert.notEqual(getDraft('s1', { storage }), getDraft('s2', { storage }))

  clearDraft('s1', { storage })
  assert.equal(getDraft('s1', { storage }), '')
  assert.equal(getDraft('s2', { storage }), 'beta')

  clearDraft('missing', { storage })
  assert.equal(getDraft('s2', { storage }), 'beta')
})

test('pruning: at most MAX_DRAFTS sessions, oldest updatedAt dropped first', () => {
  const storage = new MemoryStorage()
  for (let i = 0; i < MAX_DRAFTS + 5; i += 1) {
    setDraft(`s${i}`, `draft-${i}`, { storage, now: i })
  }

  const map = storedMap(storage)
  assert.equal(Object.keys(map).length, MAX_DRAFTS)
  for (let i = 0; i < 5; i += 1) {
    assert.equal(getDraft(`s${i}`, { storage }), '', `oldest s${i} was pruned`)
  }
  assert.equal(getDraft(`s${MAX_DRAFTS + 4}`, { storage }), `draft-${MAX_DRAFTS + 4}`)

  // refreshing an old session keeps it alive; the next-oldest is pruned instead
  setDraft('s5', 'bumped', { storage, now: 1_000 })
  setDraft('s-new', 'newest', { storage, now: 1_001 })
  assert.equal(Object.keys(storedMap(storage)).length, MAX_DRAFTS)
  assert.equal(getDraft('s5', { storage }), 'bumped', 'recent activity rescues a draft')
  assert.equal(getDraft('s6', { storage }), '', 'the actual oldest entry goes next')
  assert.equal(getDraft('s-new', { storage }), 'newest')
})

test('size cap: oversized text is truncated to MAX_DRAFT_CHARS', () => {
  const storage = new MemoryStorage()
  const oversized = 'x'.repeat(MAX_DRAFT_CHARS + 500)
  setDraft('big', oversized, { storage })

  assert.equal(getDraft('big', { storage }), oversized.slice(0, MAX_DRAFT_CHARS))
  assert.equal(getDraft('big', { storage }).length, MAX_DRAFT_CHARS)

  const exact = 'y'.repeat(MAX_DRAFT_CHARS)
  setDraft('exact', exact, { storage })
  assert.equal(getDraft('exact', { storage }), exact, 'text at the cap is untouched')

  // the cap also applies to a hand-written oversized blob on read
  storage.setItem(
    DRAFTS_STORAGE_KEY,
    JSON.stringify({ huge: { text: 'z'.repeat(MAX_DRAFT_CHARS + 10), updatedAt: 1 } }),
  )
  assert.equal(getDraft('huge', { storage }).length, MAX_DRAFT_CHARS)
})

test('read side is bounded: an oversized stored map cannot exceed the session cap', () => {
  const storage = new MemoryStorage()
  const stored: Record<string, StoredDraft> = {}
  for (let i = 0; i < MAX_DRAFTS + 10; i += 1) {
    stored[`s${i}`] = { text: `t${i}`, updatedAt: i }
  }
  storage.setItem(DRAFTS_STORAGE_KEY, JSON.stringify(stored))

  assert.equal(getDraft('s0', { storage }), '', 'oldest entry is outside the in-memory cap')
  assert.equal(getDraft(`s${MAX_DRAFTS + 9}`, { storage }), `t${MAX_DRAFTS + 9}`)
})

test('blocked storage degrades to no persistence and never throws', () => {
  const storage = new ThrowingStorage()

  assert.doesNotThrow(() => setDraft('s', 'text', { storage }))
  assert.equal(getDraft('s', { storage }), '')
  assert.doesNotThrow(() => clearDraft('s', { storage }))

  // explicit null backend (tests / non-DOM callers)
  assert.doesNotThrow(() => setDraft('s', 'text', { storage: null }))
  assert.equal(getDraft('s', { storage: null }), '')
  assert.doesNotThrow(() => clearDraft('s', { storage: null }))

  // no window under plain node: the default backend is simply absent
  assert.doesNotThrow(() => setDraft('s', 'text'))
  assert.equal(getDraft('s'), '')
})

test('corrupted JSON is tolerated and repaired by the next save', () => {
  const storage = new MemoryStorage()

  storage.setItem(DRAFTS_STORAGE_KEY, '{"s": {text:')
  assert.equal(getDraft('s', { storage }), '')
  setDraft('recovered', 'fine', { storage, now: 5 })
  assert.equal(getDraft('recovered', { storage }), 'fine')

  // malformed entries are dropped individually, valid ones survive
  storage.setItem(
    DRAFTS_STORAGE_KEY,
    JSON.stringify({
      ok: { text: 'kept', updatedAt: 2 },
      noText: { updatedAt: 2 },
      wrongText: { text: 7, updatedAt: 2 },
      notObject: 42,
      nil: null,
    }),
  )
  assert.equal(getDraft('ok', { storage }), 'kept')
  for (const bad of ['noText', 'wrongText', 'notObject', 'nil']) {
    assert.equal(getDraft(bad, { storage }), '')
  }

  // non-object top-level payloads are treated as empty
  for (const payload of ['[1,2,3]', 'null', '"drafts"', '42']) {
    storage.setItem(DRAFTS_STORAGE_KEY, payload)
    assert.equal(getDraft('ok', { storage }), '')
  }
})

test('missing session id: no read, write or clear side effects', () => {
  const storage = new MemoryStorage()

  for (const sessionId of [null, undefined, '']) {
    assert.equal(getDraft(sessionId, { storage }), '')
    assert.doesNotThrow(() => setDraft(sessionId, 'ignored', { storage }))
    assert.doesNotThrow(() => clearDraft(sessionId, { storage }))
  }
  assert.equal(storage.getItem(DRAFTS_STORAGE_KEY), null, 'no entry was created')

  setDraft('real', 'kept', { storage, now: 1 })
  setDraft(null, 'ignored', { storage })
  clearDraft(null, { storage })
  assert.equal(getDraft('real', { storage }), 'kept', 'existing drafts are untouched')
})
