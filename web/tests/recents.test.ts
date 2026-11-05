// Focused tests for src/recents.ts — run directly (the sandbox blocks spawned
// `node --test` runners):
//   node --import ./tests/register-ts.mjs tests/recents.test.ts
// The module has no DOM dependency: every test injects a Storage-like backend.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  MAX_RECENT_WORKSPACES,
  RECENTS_STORAGE_KEY,
  parseRecentWorkspaces,
  pruneRecentWorkspaces,
  pushRecentWorkspace,
  readRecentWorkspaces,
  recordRecentWorkspace,
} from '../src/recents.ts'
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

function storedIds(storage: MemoryStorage): string[] {
  const raw = storage.getItem(RECENTS_STORAGE_KEY)
  return raw ? (JSON.parse(raw) as string[]) : []
}

test('bounds: exported key and cap match the storage contract', () => {
  assert.equal(RECENTS_STORAGE_KEY, 'two-brothers.recentWorkspaces.v1')
  assert.equal(MAX_RECENT_WORKSPACES, 8)
})

test('MRU order: the newest selection is first; re-selecting moves it to the front', () => {
  const storage = new MemoryStorage()
  assert.deepEqual(recordRecentWorkspace('ws-a', { storage }), ['ws-a'])
  assert.deepEqual(recordRecentWorkspace('ws-b', { storage }), ['ws-b', 'ws-a'])
  assert.deepEqual(recordRecentWorkspace('ws-c', { storage }), ['ws-c', 'ws-b', 'ws-a'])
  assert.deepEqual(readRecentWorkspaces({ storage }), ['ws-c', 'ws-b', 'ws-a'])

  // selecting an older entry promotes it instead of duplicating it
  assert.deepEqual(recordRecentWorkspace('ws-a', { storage }), ['ws-a', 'ws-c', 'ws-b'])
  assert.deepEqual(storedIds(storage), ['ws-a', 'ws-c', 'ws-b'])
  assert.equal(new Set(storedIds(storage)).size, 3)
})

test('cap: at most MAX_RECENT_WORKSPACES entries survive, newest first', () => {
  const storage = new MemoryStorage()
  for (let i = 0; i < MAX_RECENT_WORKSPACES + 4; i += 1) {
    recordRecentWorkspace(`ws-${i}`, { storage })
  }
  const ids = readRecentWorkspaces({ storage })
  assert.equal(ids.length, MAX_RECENT_WORKSPACES)
  assert.equal(ids[0], `ws-${MAX_RECENT_WORKSPACES + 3}`)
  assert.equal(ids.at(-1), 'ws-4', 'the oldest four fell off the tail')
  assert.ok(!ids.includes('ws-0'))

  // a hand-written oversized blob is capped on read, first entries win
  storage.setItem(
    RECENTS_STORAGE_KEY,
    JSON.stringify(Array.from({ length: 20 }, (_, i) => `stored-${i}`)),
  )
  assert.equal(readRecentWorkspaces({ storage }).length, MAX_RECENT_WORKSPACES)
  assert.equal(readRecentWorkspaces({ storage })[0], 'stored-0')
})

test('dedupe and normalization: duplicates collapse, blank ids are ignored', () => {
  assert.deepEqual(pushRecentWorkspace(['a', 'b', 'a'], 'c'), ['c', 'a', 'b'])
  assert.deepEqual(pushRecentWorkspace([], '  spaced  '), ['spaced'])
  assert.deepEqual(pushRecentWorkspace(['x'], ''), ['x'])
  assert.deepEqual(pushRecentWorkspace(['x'], '   '), ['x'])

  const storage = new MemoryStorage()
  for (const id of [null, undefined, '', '   ']) {
    assert.doesNotThrow(() => recordRecentWorkspace(id, { storage }))
  }
  assert.equal(storage.getItem(RECENTS_STORAGE_KEY), null, 'no entry was created')
  recordRecentWorkspace('ws-a', { storage })
  recordRecentWorkspace(null, { storage })
  assert.deepEqual(readRecentWorkspaces({ storage }), ['ws-a'])
})

test('prune: ids that no longer exist are dropped, order is preserved', () => {
  const storage = new MemoryStorage()
  for (const id of ['a', 'b', 'c', 'd']) recordRecentWorkspace(id, { storage })
  assert.deepEqual(readRecentWorkspaces({ storage }), ['d', 'c', 'b', 'a'])

  const pruned = pruneRecentWorkspaces(['d', 'c', 'b', 'a'], new Set(['a', 'c']), { storage })
  assert.deepEqual(pruned, ['c', 'a'])
  assert.deepEqual(readRecentWorkspaces({ storage }), ['c', 'a'])

  // pruning everything removes the storage entry entirely
  assert.deepEqual(pruneRecentWorkspaces(['c', 'a'], new Set(), { storage }), [])
  assert.equal(storage.getItem(RECENTS_STORAGE_KEY), null)

  // unknown ids in the input are dropped too, and duplicates collapse
  assert.deepEqual(pruneRecentWorkspaces(['x', 'b', 'b', 'y'], ['b']), ['b'])
})

test('blocked storage degrades to no persistence and never throws', () => {
  const storage = new ThrowingStorage()

  assert.doesNotThrow(() => recordRecentWorkspace('ws-a', { storage }))
  assert.deepEqual(recordRecentWorkspace('ws-a', { storage }), ['ws-a'])
  assert.deepEqual(readRecentWorkspaces({ storage }), [])
  assert.doesNotThrow(() => pruneRecentWorkspaces(['ws-a'], [], { storage }))
  assert.deepEqual(readRecentWorkspaces({ storage: null }), [])

  // no window under plain node: the default backend is simply absent
  assert.doesNotThrow(() => recordRecentWorkspace('ws-a'))
  assert.deepEqual(readRecentWorkspaces(), [])
})

test('corrupted JSON is tolerated and repaired by the next save', () => {
  const storage = new MemoryStorage()

  for (const payload of ['{"ids":', 'null', '42', '"workspaces"', '{"a":1}']) {
    storage.setItem(RECENTS_STORAGE_KEY, payload)
    assert.deepEqual(readRecentWorkspaces({ storage }), [], `payload ${payload}`)
  }

  // a malformed array drops individual entries, keeps the usable ones
  storage.setItem(RECENTS_STORAGE_KEY, JSON.stringify(['ok', null, 7, '', ['nested'], 'ok']))
  assert.deepEqual(readRecentWorkspaces({ storage }), ['ok'])

  storage.setItem(RECENTS_STORAGE_KEY, '{not json')
  assert.deepEqual(recordRecentWorkspace('recovered', { storage }), ['recovered'])
  assert.deepEqual(readRecentWorkspaces({ storage }), ['recovered'])
})

test('parse is bounded: entry ids are length-capped before storage', () => {
  const long = 'w'.repeat(400)
  const parsed = parseRecentWorkspaces(JSON.stringify([long]))
  assert.equal(parsed.length, 1)
  assert.ok(parsed[0].length <= 256)
  assert.equal(parseRecentWorkspaces(JSON.stringify(['a', 'a', 'b'])).length, 2)
})
