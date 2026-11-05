// Focused tests for src/sessionStatus.ts — run directly:
//   node --import ./tests/register-ts.mjs tests/sessionStatus.test.ts
// The derivation is pure; the lastSeen persistence takes an injected
// Storage-like backend, so nothing here touches a DOM.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  MAX_LAST_SEEN,
  SESSION_SEEN_STORAGE_KEY,
  deriveSessionStatus,
  isRunUnread,
  loadLastSeen,
  markSessionSeen,
  parseLastSeen,
  pruneLastSeen,
  runFinishedAtMs,
  saveLastSeen,
} from '../src/sessionStatus.ts'
import type { LastSeenMap } from '../src/sessionStatus.ts'
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

/** Epoch-seconds finished stamp with an epoch-ms view of the same instant. */
const FINISHED_SEC = 1_700_000_000
const FINISHED_MS = FINISHED_SEC * 1000

const COMPLETED = { status: 'completed' as const, finished: FINISHED_SEC, error: undefined }
const FAILED = { status: 'failed' as const, finished: FINISHED_SEC, error: 'provider exploded' }

test('bounds: exported key and cap match the storage contract', () => {
  assert.equal(SESSION_SEEN_STORAGE_KEY, 'two-brothers.sessionSeen.v1')
  assert.equal(MAX_LAST_SEEN, 200)
})

test('precedence: waiting beats live, live beats a stale failure', () => {
  const waiting = deriveSessionStatus({
    liveStatus: 'waiting',
    lastRun: FAILED,
    lastSeen: 0,
  })
  assert.equal(waiting.kind, 'waiting')
  assert.equal(waiting.label, 'waiting')
  assert.equal(waiting.tone, 'warning')
  assert.match(waiting.title, /approval/i)
  assert.ok(waiting.ariaLabel.length > 0)

  for (const liveStatus of ['queued', 'running'] as const) {
    const live = deriveSessionStatus({ liveStatus, lastRun: FAILED, lastSeen: 0 })
    assert.equal(live.kind, 'live')
    assert.equal(live.label, 'live')
    assert.equal(live.tone, 'ok')
    assert.match(live.title, /live/i)
  }

  // when the run ends, the recorded failure becomes visible again
  assert.equal(deriveSessionStatus({ lastRun: FAILED, lastSeen: FINISHED_MS }).kind, 'failed')
})

test('failed: last run ended in error; the tooltip carries a bounded message', () => {
  const failed = deriveSessionStatus({ lastRun: FAILED, active: true })
  assert.equal(failed.kind, 'failed')
  assert.equal(failed.label, 'failed')
  assert.equal(failed.tone, 'danger')
  assert.match(failed.title, /provider exploded/)
  assert.match(failed.ariaLabel, /failed/i)

  // in-memory error text alone is enough (the run record may not be refreshed yet)
  assert.equal(deriveSessionStatus({ error: 'boom' }).kind, 'failed')
  assert.match(deriveSessionStatus({ error: 'boom' }).title, /boom/)

  // a whitespace-heavy / oversized message is cleaned and clamped
  const noisy = deriveSessionStatus({ error: `${'x'.repeat(500)}\n\ny` })
  assert.equal(noisy.kind, 'failed')
  assert.ok(noisy.title.length <= 200)
  assert.ok(!noisy.title.includes('\n'))

  // a successful run after the failure clears the state
  assert.equal(deriveSessionStatus({ lastRun: COMPLETED, lastSeen: FINISHED_MS }).kind, 'read')
})

test('unread: a completed run finished after the last open; active suppresses it', () => {
  const unread = deriveSessionStatus({ lastRun: COMPLETED, lastSeen: FINISHED_MS - 5_000 })
  assert.equal(unread.kind, 'unread')
  assert.equal(unread.label, 'new')
  assert.equal(unread.tone, 'accent')
  assert.match(unread.title, /since you last opened/i)

  // never opened (absent lastSeen) counts as unread for a finished result
  assert.equal(deriveSessionStatus({ lastRun: COMPLETED, lastSeen: null }).kind, 'unread')
  assert.equal(deriveSessionStatus({ lastRun: COMPLETED }).kind, 'unread')

  // seen at/after the finish: read
  assert.equal(deriveSessionStatus({ lastRun: COMPLETED, lastSeen: FINISHED_MS }).kind, 'read')
  assert.equal(deriveSessionStatus({ lastRun: COMPLETED, lastSeen: FINISHED_MS + 1 }).kind, 'read')

  // the session on screen is never flagged unread
  assert.equal(deriveSessionStatus({ lastRun: COMPLETED, active: true }).kind, 'read')

  // a cancelled run is the operator's own stop, and an old record without a
  // finished stamp cannot prove anything new
  assert.equal(
    deriveSessionStatus({
      lastRun: { status: 'cancelled', finished: FINISHED_SEC },
      lastSeen: 0,
    }).kind,
    'read',
  )
  assert.equal(
    deriveSessionStatus({ lastRun: { status: 'completed', finished: 0 }, lastSeen: 0 }).kind,
    'read',
  )

  // live status keeps precedence over an older unread completion
  assert.equal(
    deriveSessionStatus({ liveStatus: 'running', lastRun: COMPLETED, lastSeen: 0 }).kind,
    'live',
  )
})

test('read: no runs, or malformed run input, yields the inert state', () => {
  const read = deriveSessionStatus({})
  assert.equal(read.kind, 'read')
  assert.equal(read.label, '')
  assert.equal(deriveSessionStatus({ lastRun: null, lastSeen: 5 }).kind, 'read')
})

test('helpers: finishedAtMs and isRunUnread agree with the derivation', () => {
  assert.equal(runFinishedAtMs(COMPLETED), FINISHED_MS)
  assert.equal(runFinishedAtMs({ finished: 0 }), 0)
  assert.equal(runFinishedAtMs(null), 0)
  assert.equal(isRunUnread(FINISHED_MS, FINISHED_MS - 1), true)
  assert.equal(isRunUnread(FINISHED_MS, FINISHED_MS), false)
  assert.equal(isRunUnread(FINISHED_MS, null), true)
  assert.equal(isRunUnread(0, 0), false)
})

test('markSessionSeen: immutable update, clock stamped, bounded to MAX_LAST_SEEN', () => {
  const base: LastSeenMap = parseLastSeen(JSON.stringify({ a: 10 }))
  const next = markSessionSeen('a', base, 20)
  assert.notEqual(next, base)
  assert.equal(next.a, 20)
  assert.equal(base.a, 10, 'the input map was not mutated')
  assert.equal(markSessionSeen('b', next, 30).b, 30)

  // missing ids are a no-op that returns the same map
  for (const missing of [null, undefined, '', '   ']) {
    assert.equal(markSessionSeen(missing, next, 40), next)
  }

  const map: LastSeenMap = Object.create(null) as LastSeenMap
  for (let i = 0; i < MAX_LAST_SEEN; i += 1) map[`s${i}`] = i + 1
  const full = markSessionSeen('new', map, 10_000)
  assert.equal(Object.keys(full).length, MAX_LAST_SEEN)
  assert.equal(full.new, 10_000)
  assert.ok(full['s0'] === undefined, 'the oldest stamp was evicted')

  const floatNow = markSessionSeen('x', Object.create(null) as LastSeenMap, 123.9)
  assert.equal(floatNow.x, 123)
})

test('parseLastSeen: tolerant shapes, bounded entries and values', () => {
  for (const raw of [null, '', '{bad json', 'null', '[]', '"seen"', '42']) {
    assert.deepEqual({ ...parseLastSeen(raw) }, {}, `payload ${raw}`)
  }

  const parsed = parseLastSeen(
    JSON.stringify({
      ok: 12,
      zero: 0,
      negative: -1,
      text: 'not a number',
      nan: Number.NaN,
      nil: null,
      '': 5,
    }),
  )
  assert.deepEqual({ ...parsed }, { ok: 12 })

  // oversized stored maps are bounded on read too
  const stored: Record<string, number> = {}
  for (let i = 0; i < MAX_LAST_SEEN + 10; i += 1) stored[`s${i}`] = i + 1
  const bounded = parseLastSeen(JSON.stringify(stored))
  assert.equal(Object.keys(bounded).length, MAX_LAST_SEEN)
  assert.ok(bounded['s0'] === undefined, 'the oldest entries are outside the cap')
  assert.ok(bounded[`s${MAX_LAST_SEEN + 9}`] !== undefined)
})

test('pruneLastSeen: drops departed sessions, keeps the same map when unchanged', () => {
  const map = parseLastSeen(JSON.stringify({ a: 1, b: 2 }))
  assert.equal(pruneLastSeen(map, ['a', 'b', 'c']), map, 'no write when nothing is pruned')

  const pruned = pruneLastSeen(map, ['b'])
  assert.deepEqual({ ...pruned }, { b: 2 })
  assert.deepEqual({ ...map }, { a: 1, b: 2 }, 'the input map was not mutated')
})

test('persistence: roundtrip under the versioned key, bounded, fail-soft', () => {
  const storage = new MemoryStorage()
  const map = markSessionSeen('session-a', Object.create(null) as LastSeenMap, 1_000)
  saveLastSeen(map, { storage })
  assert.equal(storage.getItem(SESSION_SEEN_STORAGE_KEY) !== null, true)
  assert.equal(loadLastSeen({ storage })['session-a'], 1_000)

  saveLastSeen(Object.create(null) as LastSeenMap, { storage })
  assert.equal(storage.getItem(SESSION_SEEN_STORAGE_KEY), null, 'an empty map drops the key')

  // blocked storage never throws and yields nothing
  const blocked = new ThrowingStorage()
  assert.doesNotThrow(() => saveLastSeen(map, { storage: blocked }))
  assert.deepEqual({ ...loadLastSeen({ storage: blocked }) }, {})
  assert.deepEqual({ ...loadLastSeen({ storage: null }) }, {})

  // no window under plain node: the default backend is simply absent
  assert.doesNotThrow(() => saveLastSeen(map))
  assert.deepEqual({ ...loadLastSeen() }, {})

  storage.setItem(SESSION_SEEN_STORAGE_KEY, '{"broken":')
  assert.deepEqual({ ...loadLastSeen({ storage }) }, {})
})
