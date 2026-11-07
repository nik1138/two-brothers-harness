// Focused tests for src/recall.ts (the web composer's Up/Down prompt-history
// recall). Run directly:
//   node --import ./tests/register-ts.mjs --test tests/recall.test.ts
// The module has no DOM dependency: every store test injects a Storage-like
// backend and the key-decision tests pass a plain caret object.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { classifyComposerRecall } from '../src/composerKeys.ts'
import type { StorageLike } from '../src/drafts.ts'
import {
  MAX_RECALL_ENTRIES,
  MAX_RECALL_ENTRY_CHARS,
  RECALL_STORAGE_KEY,
  RECALL_VERSION,
  caretAtRecallEnd,
  caretAtRecallStart,
  classifyRecallKey,
  clearRecall,
  createRecallState,
  isSingleLine,
  loadRecall,
  normalizeRecallEntries,
  recordRecall,
  saveRecall,
  stepRecall,
} from '../src/recall.ts'

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

function stored(storage: MemoryStorage): { version: number; entries: string[] } | null {
  const raw = storage.getItem(RECALL_STORAGE_KEY)
  return raw ? (JSON.parse(raw) as { version: number; entries: string[] }) : null
}

// --------------------------------------------------------------------------- //
// bounded, fail-soft store
// --------------------------------------------------------------------------- //

test('the store is versioned, bounded and newest-first', () => {
  const storage = new MemoryStorage()
  saveRecall(['newest', 'older'], { storage })
  assert.deepEqual(stored(storage), { version: RECALL_VERSION, entries: ['newest', 'older'] })
  assert.equal(RECALL_STORAGE_KEY, 'two-brothers.composerHistory.v1')
  assert.deepEqual(loadRecall({ storage }), ['newest', 'older'])

  // A malformed entry sequence is normalized on write: non-strings and blanks
  // are dropped, adjacent duplicates collapse, and the count cap keeps the
  // newest entries.
  saveRecall(
    ['task', 'task', '', 42, null, 'next'],
    { storage },
  )
  assert.deepEqual(loadRecall({ storage }), ['task', 'next'])

  const many = Array.from({ length: MAX_RECALL_ENTRIES + 7 }, (_, index) => `task ${index}`)
  saveRecall(many, { storage })
  const loaded = loadRecall({ storage })
  assert.equal(loaded.length, MAX_RECALL_ENTRIES)
  assert.equal(loaded[0], 'task 0')
  assert.equal(loaded.at(-1), `task ${MAX_RECALL_ENTRIES - 1}`)

  // The per-entry cap clips without throwing.
  const long = 'x'.repeat(MAX_RECALL_ENTRY_CHARS + 100)
  saveRecall([long], { storage })
  assert.equal(loadRecall({ storage })[0]?.length, MAX_RECALL_ENTRY_CHARS)

  clearRecall({ storage })
  assert.equal(storage.getItem(RECALL_STORAGE_KEY), null)
  assert.deepEqual(loadRecall({ storage }), [])
})

test('normalizeRecallEntries and recordRecall are pure and newest-first', () => {
  assert.deepEqual(normalizeRecallEntries(['a', 'b', 'b', 'c']), ['a', 'b', 'c'])
  assert.deepEqual(normalizeRecallEntries(['', '   ', 3, null]), [])
  assert.deepEqual(normalizeRecallEntries(['x'.repeat(MAX_RECALL_ENTRY_CHARS + 1)])[0]?.length, MAX_RECALL_ENTRY_CHARS)

  // Consecutive dedupe checks the newest-first adjacency.
  assert.deepEqual(recordRecall([], 'first'), ['first'])
  assert.deepEqual(recordRecall(['first'], 'first'), ['first'], 'a repeated newest entry is not duplicated')
  assert.deepEqual(recordRecall(['first'], 'second'), ['second', 'first'])
  assert.deepEqual(recordRecall(['second', 'first'], 'first'), ['first', 'second', 'first'], 'non-adjacent repeats stay')
  assert.deepEqual(recordRecall(['first'], '  '), ['first'], 'blank entries are ignored')
  assert.deepEqual(recordRecall(['first'], ' first '), [' first ', 'first'], 'only submission text is compared')

  const capped = recordRecall(
    Array.from({ length: MAX_RECALL_ENTRIES }, (_, index) => `old ${index}`),
    'newest',
  )
  assert.equal(capped.length, MAX_RECALL_ENTRIES)
  assert.equal(capped[0], 'newest')
  assert.equal(capped.at(-1), `old ${MAX_RECALL_ENTRIES - 2}`, 'the oldest entry falls off')
})

test('load is fail-soft: corrupt JSON, wrong version/shape and blocked storage', () => {
  const storage = new MemoryStorage()
  storage.setItem(RECALL_STORAGE_KEY, '{not json')
  assert.deepEqual(loadRecall({ storage }), [])

  storage.setItem(RECALL_STORAGE_KEY, JSON.stringify({ version: RECALL_VERSION + 1, entries: ['nope'] }))
  assert.deepEqual(loadRecall({ storage }), [])

  storage.setItem(RECALL_STORAGE_KEY, JSON.stringify({ version: RECALL_VERSION, entries: 'nope' }))
  assert.deepEqual(loadRecall({ storage }), [])

  storage.setItem(RECALL_STORAGE_KEY, JSON.stringify(['bare', 'array']))
  assert.deepEqual(loadRecall({ storage }), [])

  const blocked = new ThrowingStorage()
  assert.deepEqual(loadRecall({ storage: blocked }), [])
  assert.doesNotThrow(() => saveRecall(['kept'], { storage: blocked }))
  assert.doesNotThrow(() => clearRecall({ storage: blocked }))

  // No storage at all (explicit null or a missing injected backend) is a valid
  // in-memory-only state, not an error.
  assert.deepEqual(loadRecall({ storage: null }), [])
  assert.doesNotThrow(() => saveRecall(['kept'], { storage: null }))
  // In node there is no window, so the default backend resolves to null too.
  assert.deepEqual(loadRecall(), [])
  assert.doesNotThrow(() => saveRecall(['kept']))
})

// --------------------------------------------------------------------------- //
// browsing state machine
// --------------------------------------------------------------------------- //

test('stepRecall walks newest-first and restores the stashed draft exactly', () => {
  const entries = ['newest task', 'middle task', 'oldest task']
  const start = createRecallState()
  assert.deepEqual(start, { active: false, index: -1, draft: '' })

  const first = stepRecall(start, 'previous', entries, 'live draft\nwith a second line')
  assert.equal(first.text, 'newest task')
  assert.deepEqual(first.state, {
    active: true,
    index: 0,
    draft: 'live draft\nwith a second line',
  })

  const second = stepRecall(first.state, 'previous', entries, 'ignored')
  assert.equal(second.text, 'middle task')
  assert.equal(second.state.index, 1)
  const third = stepRecall(second.state, 'previous', entries, 'ignored')
  assert.equal(third.text, 'oldest task')
  assert.equal(third.state.index, 2)

  // At the oldest entry another Up is an honest no-op.
  const boundary = stepRecall(third.state, 'previous', entries, 'ignored')
  assert.equal(boundary.text, null)
  assert.equal(boundary.state, third.state)

  // Down walks newer, then restores the pre-recall draft byte-exactly.
  const back = stepRecall(third.state, 'next', entries, 'ignored')
  assert.equal(back.text, 'middle task')
  const newest = stepRecall(back.state, 'next', entries, 'ignored')
  assert.equal(newest.text, 'newest task')
  const restored = stepRecall(newest.state, 'next', entries, 'ignored')
  assert.equal(restored.text, 'live draft\nwith a second line')
  assert.deepEqual(restored.state, createRecallState())

  // Down on the live draft is a no-op; so is any step with no history.
  assert.deepEqual(stepRecall(createRecallState(), 'next', entries, 'draft'), {
    state: createRecallState(),
    text: null,
  })
  assert.deepEqual(stepRecall(createRecallState(), 'previous', [], 'draft').text, null)
})

// --------------------------------------------------------------------------- //
// key decision
// --------------------------------------------------------------------------- //

const single = (text = 'draft', at = text.length) => ({
  text,
  selectionStart: at,
  selectionEnd: at,
})
const multi = (text = 'first\nsecond', at = text.length) => ({
  text,
  selectionStart: at,
  selectionEnd: at,
})

test('the boundary rule: single-line anywhere, multiline only at the very edges', () => {
  assert.equal(isSingleLine('one line'), true)
  assert.equal(isSingleLine(''), true)
  assert.equal(isSingleLine('one\ntwo'), false)

  assert.equal(caretAtRecallStart(single('draft', 2)), true, 'single-line: any caret column')
  assert.equal(caretAtRecallStart(multi('first\nsecond', 0)), true, 'multiline: very start only')
  assert.equal(caretAtRecallStart(multi('first\nsecond', 3)), false)
  assert.equal(caretAtRecallEnd(single('draft', 0)), true, 'single-line: any caret column')
  assert.equal(caretAtRecallEnd(multi('first\nsecond', 12)), true, 'multiline: very end only')
  assert.equal(caretAtRecallEnd(multi('first\nsecond', 6)), false)
  // A selection is not a recall boundary (Shift+Arrow keeps selecting).
  assert.equal(caretAtRecallStart({ text: 'draft', selectionStart: 0, selectionEnd: 2 }), false)
  assert.equal(caretAtRecallEnd({ text: 'one\ntwo', selectionStart: 3, selectionEnd: 7 }), false)
  assert.equal(caretAtRecallStart(null), false)
  assert.equal(caretAtRecallEnd(null), false)
})

test('classifyRecallKey is IME/modifier/repeat/selection safe and never a submit', () => {
  const up = { key: 'ArrowUp' }
  const down = { key: 'ArrowDown' }

  assert.equal(classifyRecallKey(up, single('draft', 2)), 'previous')
  assert.equal(classifyRecallKey(down, single('draft', 2)), 'next')
  assert.equal(classifyRecallKey(up, multi('a\nb', 0)), 'previous')
  assert.equal(classifyRecallKey(up, multi('a\nb', 2)), 'none')
  assert.equal(classifyRecallKey(down, multi('a\nb', 3)), 'next')
  assert.equal(classifyRecallKey(down, multi('a\nb', 1)), 'none')
  assert.equal(classifyRecallKey({ key: 'ArrowLeft' }, single()), 'none')
  assert.equal(classifyRecallKey({ key: 'Enter' }, single()), 'none')
  assert.equal(classifyRecallKey(null, single()), 'none')

  // IME composition and held-key auto-repeat leave the keystroke to the input.
  assert.equal(classifyRecallKey({ ...up, isComposing: true }, single('', 0)), 'none')
  assert.equal(classifyRecallKey({ ...up, keyCode: 229 }, single('', 0)), 'none')
  assert.equal(classifyRecallKey({ ...up, repeat: true }, single('', 0)), 'none')
  // Every modifier means a different gesture (selection, word/document jump).
  for (const modifier of ['shiftKey', 'ctrlKey', 'metaKey', 'altKey'] as const) {
    assert.equal(classifyRecallKey({ ...up, [modifier]: true }, single('', 0)), 'none', modifier)
  }
})

test('the composer bridge defers to an open picker and maps both directions', () => {
  const up = { key: 'ArrowUp' }
  const down = { key: 'ArrowDown' }
  const idle = { pickerOpen: false, recallActive: false, historyCount: 2 }
  const browsing = { ...idle, recallActive: true }

  assert.equal(classifyComposerRecall(up, single('draft', 2), idle), 'recall-previous')
  // The inactive-Down fix: no recall step to take -> pass the key through to
  // the textarea instead of consuming it as a no-op.
  assert.equal(classifyComposerRecall(down, single('draft', 2), idle), null)
  assert.equal(
    classifyComposerRecall(down, single('draft', 2), browsing),
    'recall-next',
    'browsing keeps stepping toward the stashed draft',
  )
  assert.equal(classifyComposerRecall(up, multi('a\nb', 2), idle), null)
  assert.equal(
    classifyComposerRecall(up, single('draft', 2), { ...idle, pickerOpen: true }),
    null,
    'the picker owns the arrows',
  )
  assert.equal(
    classifyComposerRecall(up, single('', 0), { ...idle, historyCount: 0 }),
    null,
    'nothing to recall: Up is native caret movement',
  )
  assert.equal(classifyComposerRecall({ key: 'ArrowUp', isComposing: true }, single('', 0), idle), null)
  // The composer key shape is structurally compatible with the recall reader.
  assert.equal(
    classifyComposerRecall(
      { key: 'ArrowUp', shiftKey: false, ctrlKey: false, metaKey: false, altKey: false },
      single('', 0),
      idle,
    ),
    'recall-previous',
  )
})
