// Focused tests for src/find.ts — pure matcher, no DOM, no dependencies:
//   node --import ./tests/register-ts.mjs --test tests/find.test.ts

import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { test } from 'node:test'

import { findInvalidationKey, findMatches, nextMatch, prevMatch } from '../src/find.ts'
import type { FindBlock, FindInvalidationInput } from '../src/find.ts'

const blocks = (...texts: string[]): FindBlock[] => texts.map((text) => ({ text }))

test('matches: document order across blocks, case-insensitive by default', () => {
  assert.deepEqual(findMatches(blocks('Alpha beta alpha', 'ALPHA'), 'alpha'), [
    { blockIndex: 0, start: 0, end: 5 },
    { blockIndex: 0, start: 11, end: 16 },
    { blockIndex: 1, start: 0, end: 5 },
  ])
})

test('empty and whitespace-only queries match nothing; blocks are searched literally', () => {
  assert.deepEqual(findMatches(blocks('anything'), ''), [])
  assert.deepEqual(findMatches(blocks('anything'), '   '), [])
  assert.deepEqual(findMatches(blocks('anything'), '\t\r\n'), [])
  assert.deepEqual(findMatches([], 'anything'), [])
  assert.deepEqual(findMatches(blocks('', '   '), 'x'), [])
  assert.deepEqual(findMatches(blocks('short'), 'shortness'), [])

  // only blank queries are rejected: meaningful spaces are searched literally
  assert.deepEqual(findMatches(blocks('a x b'), ' x '), [
    { blockIndex: 0, start: 1, end: 4 },
  ])
})

test('case: caseSensitive matches only exact case, including non-ASCII', () => {
  const text = blocks('CAFÉ café Straße STRASSE')

  assert.deepEqual(findMatches(text, 'café'), [
    { blockIndex: 0, start: 0, end: 4 },
    { blockIndex: 0, start: 5, end: 9 },
  ])
  assert.deepEqual(findMatches(text, 'CAFÉ', { caseSensitive: true }), [
    { blockIndex: 0, start: 0, end: 4 },
  ])
  // ß has no single-character upper-case form, so it folds to itself
  assert.equal(findMatches(blocks('Straße'), 'straße').length, 1)
  assert.equal(findMatches(blocks('Straße'), 'STRASSE').length, 0)
})

test('wholeWord: Unicode letters, numbers and underscore are word characters', () => {
  const found = findMatches(
    blocks('cat concatenate cat.', 'cat_1', 'a cat-like cat', 'кошка, кошка2', 'cat'),
    'cat',
    { wholeWord: true },
  )
  assert.deepEqual(found, [
    { blockIndex: 0, start: 0, end: 3 },
    { blockIndex: 0, start: 16, end: 19 },
    { blockIndex: 2, start: 2, end: 5 },
    { blockIndex: 2, start: 11, end: 14 },
    { blockIndex: 4, start: 0, end: 3 },
  ])

  // Cyrillic letters count as word characters at the boundary
  assert.deepEqual(findMatches(blocks('кошка, кошка2'), 'кошка', { wholeWord: true }), [
    { blockIndex: 0, start: 0, end: 5 },
  ])
  // case-insensitive remains the default with whole-word matching
  assert.equal(findMatches(blocks('CAT cat'), 'cat', { wholeWord: true }).length, 2)
  // astral neighbours are read as one code point at the boundary
  assert.deepEqual(findMatches(blocks('😀cat'), 'cat', { wholeWord: true }), [
    { blockIndex: 0, start: 2, end: 5 },
  ])
  assert.deepEqual(findMatches(blocks('𝐀cat'), 'cat', { wholeWord: true }), [])
})

test('overlapping candidates: scanning resumes at the previous match end', () => {
  assert.deepEqual(findMatches(blocks('aaaa'), 'aa'), [
    { blockIndex: 0, start: 0, end: 2 },
    { blockIndex: 0, start: 2, end: 4 },
  ])
  // "ana" occurs at 1 and at 3 in "banana", but the second starts inside the first
  assert.deepEqual(findMatches(blocks('banana'), 'ana'), [
    { blockIndex: 0, start: 1, end: 4 },
  ])
  assert.deepEqual(findMatches(blocks('ababab'), 'ab'), [
    { blockIndex: 0, start: 0, end: 2 },
    { blockIndex: 0, start: 2, end: 4 },
    { blockIndex: 0, start: 4, end: 6 },
  ])
})

test('nextMatch/prevMatch: wrap-around, -1 means "no active match", empty sets are safe', () => {
  assert.equal(nextMatch(-1, 3), 0)
  assert.equal(nextMatch(0, 3), 1)
  assert.equal(nextMatch(2, 3), 0)
  assert.equal(prevMatch(-1, 3), 2)
  assert.equal(prevMatch(0, 3), 2)
  assert.equal(prevMatch(2, 3), 1)

  assert.equal(nextMatch(-1, 1), 0)
  assert.equal(nextMatch(0, 1), 0)
  assert.equal(prevMatch(0, 1), 0)

  assert.equal(nextMatch(0, 0), -1)
  assert.equal(prevMatch(-1, 0), -1)
  assert.equal(nextMatch(0, -3), -1)
  assert.equal(prevMatch(0, Number.NaN), -1)

  // non-finite and fractional indices are normalized, never thrown
  assert.equal(nextMatch(Number.NaN, 3), 0)
  assert.equal(prevMatch(Number.NaN, 3), 2)
  assert.equal(nextMatch(1.7, 3), 2)
  assert.equal(prevMatch(1.7, 3), 0)
  assert.equal(nextMatch(7, 3), 2)
})

test('Unicode: astral characters use two UTF-16 units but are never split', () => {
  assert.deepEqual(findMatches(blocks('😀 alpha 😀', 'x😀y'), '😀'), [
    { blockIndex: 0, start: 0, end: 2 },
    { blockIndex: 0, start: 9, end: 11 },
    { blockIndex: 1, start: 1, end: 3 },
  ])
  assert.deepEqual(findMatches(blocks('😀 alpha 😀'), 'alpha'), [
    { blockIndex: 0, start: 3, end: 8 },
  ])
  assert.deepEqual(findMatches(blocks('x😀y'), 'y'), [
    { blockIndex: 0, start: 3, end: 4 },
  ])
  // a lone surrogate cannot match half of a pair
  assert.deepEqual(findMatches(blocks('😀'), '\ud83d'), [])
  assert.deepEqual(findMatches(blocks('😀'), '😀'[0] as string), [])
})

test('Unicode case folding maps a match back to whole original characters', () => {
  // U+0130 folds to "i" + combining dot, so a match on "i" covers the whole
  // original code point instead of ending inside the fold expansion.
  assert.deepEqual(findMatches(blocks('İ'), 'i'), [{ blockIndex: 0, start: 0, end: 1 }])

  // Offsets after that expansion stay in original text coordinates.
  assert.deepEqual(findMatches(blocks('İstanbul 😀 İstanbul'), 'stan'), [
    { blockIndex: 0, start: 1, end: 5 },
    { blockIndex: 0, start: 13, end: 17 },
  ])

  assert.deepEqual(findMatches(blocks('😀 ÉCOLE 😀'), 'école'), [
    { blockIndex: 0, start: 3, end: 8 },
  ])
})

test('large input: the scan stays linear in total text size', () => {
  const make = (count: number): FindBlock[] =>
    Array.from({ length: count }, (_, i) => ({
      text: `block ${i} ` + 'lorem ipsum dolor sit amet '.repeat(450) + 'needle',
    }))
  const scanMs = (data: FindBlock[]): number => {
    const started = performance.now()
    const found = findMatches(data, 'needle')
    const elapsed = performance.now() - started
    assert.equal(found.length, data.length, 'one match per block')
    return elapsed
  }

  // ~1.4M characters vs ~5.6M characters (4x). Quadratic scanning would be
  // ~16x slower; allow generous noise but reject that growth.
  const small = make(120)
  const large = make(480)
  scanMs(make(8)) // warm the fold/indexOf paths before timing
  const smallMs = scanMs(small)
  const largeMs = scanMs(large)

  assert.ok(
    largeMs <= smallMs * 8 + 150,
    `4x text took ${(largeMs / Math.max(smallMs, 0.01)).toFixed(1)}x the time ` +
      `(small=${smallMs.toFixed(1)}ms, large=${largeMs.toFixed(1)}ms)`,
  )
  assert.ok(largeMs < 5000, `5.6M-character scan took ${largeMs.toFixed(1)}ms`)
})

// -- findInvalidationKey (the find cache's freshness key) ---------------------
// ChatView's single find-cache watcher fires when this key changes, so the
// fold-affecting reactive inputs (visibleTimeline, auditVisible, expandedFolds,
// liveRunId, dockedApprovalId) cannot be omitted silently: every input is a
// required property of FindInvalidationInput at the component's call site.

function invalidationBase(): FindInvalidationInput {
  return {
    timeline: [],
    auditVisible: false,
    expandedFolds: new Set(),
    liveRunId: null,
    dockedApprovalId: null,
  }
}

test('invalidation key: identical inputs produce an identical key', () => {
  const first = findInvalidationKey(invalidationBase())
  assert.equal(findInvalidationKey(invalidationBase()), first, 'repeat call')
  assert.equal(
    findInvalidationKey({ ...invalidationBase(), timeline: [], liveRunId: undefined }),
    first,
    'null and undefined liveRunId normalize the same',
  )
})

test('invalidation key: A -> B -> A returns to the same key as the first A', () => {
  const a = invalidationBase()
  const b = { ...invalidationBase(), liveRunId: 'run-1' }
  const keyA = findInvalidationKey(a)
  assert.notEqual(findInvalidationKey(b), keyA)
  assert.equal(findInvalidationKey(a), keyA, 'no history: the second A matches the first')
})

test('invalidation key: a new visible timeline identity changes the key', () => {
  const first = findInvalidationKey(invalidationBase())
  assert.notEqual(findInvalidationKey({ ...invalidationBase(), timeline: [{ text: 'a' }] }), first)
})

test('invalidation key: the same timeline identity re-read keeps the key', () => {
  const timeline = [{ text: 'a' }]
  const first = findInvalidationKey({ ...invalidationBase(), timeline })
  assert.equal(findInvalidationKey({ ...invalidationBase(), timeline }), first)
  // identity-based on purpose (same contract as the former direct
  // `watch(visibleTimeline, ...)`): in-place content edits of the same array
  // do not invalidate
  timeline.push({ text: 'b' })
  assert.equal(findInvalidationKey({ ...invalidationBase(), timeline }), first)
})

test('invalidation key: auditVisible toggle changes the key', () => {
  const first = findInvalidationKey(invalidationBase())
  assert.notEqual(findInvalidationKey({ ...invalidationBase(), auditVisible: true }), first)
})

test('invalidation key: expandedFolds are content-compared', () => {
  const first = findInvalidationKey({ ...invalidationBase(), expandedFolds: new Set(['a', 'b']) })
  assert.equal(
    findInvalidationKey({ ...invalidationBase(), expandedFolds: new Set(['a', 'b']) }),
    first,
    'a fresh Set with the same ids must not invalidate',
  )
  assert.equal(
    findInvalidationKey({ ...invalidationBase(), expandedFolds: new Set(['b', 'a']) }),
    first,
    'order-insensitive',
  )
  assert.notEqual(
    findInvalidationKey({ ...invalidationBase(), expandedFolds: new Set(['a', 'c']) }),
    first,
    'a different id set changes the key',
  )
})

test('invalidation key: liveRunId changes change the key', () => {
  const first = findInvalidationKey(invalidationBase())
  const followed = findInvalidationKey({ ...invalidationBase(), liveRunId: 'run-1' })
  assert.notEqual(followed, first)
  assert.notEqual(
    findInvalidationKey({ ...invalidationBase(), liveRunId: 'run-2' }),
    followed,
  )
})

test('invalidation key: dockedApprovalId changes change the key', () => {
  const first = findInvalidationKey(invalidationBase())
  const docked = findInvalidationKey({ ...invalidationBase(), dockedApprovalId: 'ap-1' })
  assert.notEqual(docked, first)
  assert.notEqual(
    findInvalidationKey({ ...invalidationBase(), dockedApprovalId: 'ap-2' }),
    docked,
  )
})

test('invalidation key: id contents cannot collide across segments', () => {
  // fold ids that concatenate to the same string must still separate
  assert.notEqual(
    findInvalidationKey({ ...invalidationBase(), expandedFolds: new Set(['ab']) }),
    findInvalidationKey({ ...invalidationBase(), expandedFolds: new Set(['a', 'b']) }),
  )
  // a liveRunId must not be able to pose as a dockedApprovalId (or vice versa)
  assert.notEqual(
    findInvalidationKey({ ...invalidationBase(), liveRunId: 'x' }),
    findInvalidationKey({ ...invalidationBase(), dockedApprovalId: 'x' }),
  )
  // ids resembling the JSON framing must not break the key
  assert.notEqual(
    findInvalidationKey({ ...invalidationBase(), liveRunId: '","' }),
    findInvalidationKey({ ...invalidationBase(), liveRunId: '","' , dockedApprovalId: 'z' }),
  )
})

test('invalidation key: changing one input leaves the other inputs independent', () => {
  const first = findInvalidationKey({
    ...invalidationBase(),
    liveRunId: 'run-1',
    dockedApprovalId: 'ap-1',
  })
  assert.equal(
    findInvalidationKey({
      ...invalidationBase(),
      liveRunId: 'run-1',
      dockedApprovalId: 'ap-1',
      auditVisible: false,
    }),
    first,
  )
  assert.notEqual(
    findInvalidationKey({
      ...invalidationBase(),
      liveRunId: 'run-1',
      dockedApprovalId: 'ap-1',
      expandedFolds: new Set(['fold-9']),
    }),
    first,
  )
})
