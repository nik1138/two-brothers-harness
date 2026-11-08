// Focused tests for src/transcriptWindow.ts — pure pagination model, no DOM,
// no dependencies:
//   node --import ./tests/register-ts.mjs --test tests/transcriptWindow.test.ts

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildFoldRows } from '../src/folding.ts'
import type { TimelineEntry } from '../src/runtime.ts'
import {
  TRANSCRIPT_CHUNK_SIZE,
  TRANSCRIPT_PAGE_SIZE,
  createTranscriptSliceMemo,
  initialTranscriptWindow,
  showEarlierTranscriptWindow,
  transcriptWindow,
} from '../src/transcriptWindow.ts'

test('defaults: newest 200 blocks, 100-block backfill chunks', () => {
  assert.equal(TRANSCRIPT_PAGE_SIZE, 200)
  assert.equal(TRANSCRIPT_CHUNK_SIZE, 100)
})

test('empty transcript: no window, no control, no slice', () => {
  const state = initialTranscriptWindow(0)
  assert.deepEqual(state, { loaded: 0 })
  assert.deepEqual(transcriptWindow(0, state), {
    total: 0,
    start: 0,
    visible: 0,
    hidden: 0,
    chunk: 0,
    hasEarlier: false,
    controlLabel: '',
  })
  assert.deepEqual(showEarlierTranscriptWindow(0, state), {
    state: { loaded: 0 },
    window: {
      total: 0,
      start: 0,
      visible: 0,
      hidden: 0,
      chunk: 0,
      hasEarlier: false,
      controlLabel: '',
    },
    loaded: 0,
    remaining: 0,
    announcement: '',
  })
})

test('at or below the default page: everything renders, no control', () => {
  for (const total of [1, 37, 199, 200]) {
    const view = transcriptWindow(total, initialTranscriptWindow(total))
    assert.equal(view.total, total)
    assert.equal(view.start, 0, `total ${total} starts at the top`)
    assert.equal(view.visible, total)
    assert.equal(view.hidden, 0)
    assert.equal(view.chunk, 0)
    assert.equal(view.hasEarlier, false)
    assert.equal(view.controlLabel, '')
  }
})

test('one block over the page: the control names the single hidden row', () => {
  const state = initialTranscriptWindow(TRANSCRIPT_PAGE_SIZE + 1)
  const view = transcriptWindow(TRANSCRIPT_PAGE_SIZE + 1, state)
  assert.equal(view.start, 1)
  assert.equal(view.visible, TRANSCRIPT_PAGE_SIZE)
  assert.equal(view.hidden, 1)
  assert.equal(view.chunk, 1)
  assert.equal(view.hasEarlier, true)
  assert.equal(view.controlLabel, 'Show earlier messages (1 more)')
})

test('a long transcript keeps one bounded default page', () => {
  const total = TRANSCRIPT_PAGE_SIZE + 250
  const view = transcriptWindow(total, initialTranscriptWindow(total))
  assert.equal(view.start, 250)
  assert.equal(view.hidden, 250)
  assert.equal(view.visible, TRANSCRIPT_PAGE_SIZE)
  assert.equal(view.chunk, TRANSCRIPT_CHUNK_SIZE)
  assert.equal(view.controlLabel, 'Show earlier messages (250 more)')
})

test('chunking: 100 at a time, a clamped last chunk, then a truthful no-op', () => {
  const total = 450 // 250 hidden under the 200-row page
  let state = initialTranscriptWindow(total)
  assert.deepEqual(state, { loaded: 0 })
  assert.equal(transcriptWindow(total, state).start, 250)

  const first = showEarlierTranscriptWindow(total, state)
  assert.deepEqual(first.state, { loaded: 100 })
  assert.equal(first.window.start, 150)
  assert.equal(first.loaded, 100)
  assert.equal(first.remaining, 150)
  assert.equal(first.window.hidden, 150)
  assert.equal(first.window.chunk, 100)
  assert.equal(
    first.announcement,
    'Loaded 100 earlier messages. 150 older messages remain hidden.',
  )

  state = first.state
  const second = showEarlierTranscriptWindow(total, state)
  assert.deepEqual(second.state, { loaded: 200 })
  assert.equal(second.window.start, 50)
  assert.equal(second.loaded, 100)
  assert.equal(second.remaining, 50)
  assert.equal(
    second.announcement,
    'Loaded 100 earlier messages. 50 older messages remain hidden.',
  )

  state = second.state
  const last = showEarlierTranscriptWindow(total, state)
  assert.deepEqual(last.state, { loaded: 250 })
  assert.equal(last.window.start, 0)
  assert.equal(last.loaded, 50, 'the last chunk is clamped to what is hidden')
  assert.equal(last.remaining, 0)
  assert.equal(last.window.hasEarlier, false)
  assert.equal(last.window.controlLabel, '')
  assert.equal(last.announcement, 'Loaded 50 earlier messages. All messages are now loaded.')

  state = last.state
  const noop = showEarlierTranscriptWindow(total, state)
  assert.deepEqual(noop.state, { loaded: 250 })
  assert.equal(noop.loaded, 0)
  assert.equal(noop.remaining, 0)
  assert.equal(noop.announcement, '')
})

test('singular copy: one loaded row and one remaining row read grammatically', () => {
  const total = 202 // 2 hidden under the default page
  const options = { chunkSize: 1 }
  const first = showEarlierTranscriptWindow(
    total,
    initialTranscriptWindow(total, options),
    options,
  )
  assert.equal(first.loaded, 1)
  assert.equal(first.remaining, 1)
  assert.equal(
    first.announcement,
    'Loaded 1 earlier message. 1 older message remains hidden.',
  )
})

test('custom window options: page and chunk sizes are independent', () => {
  const total = 12
  let state = initialTranscriptWindow(total, { pageSize: 5, chunkSize: 3 })
  assert.deepEqual(state, { loaded: 0 })
  const view = transcriptWindow(total, state, { pageSize: 5, chunkSize: 3 })
  assert.equal(view.visible, 5)
  assert.equal(view.hidden, 7)
  assert.equal(view.chunk, 3)

  const steps: Array<[number, number, number]> = []
  for (;;) {
    const step = showEarlierTranscriptWindow(total, state, { pageSize: 5, chunkSize: 3 })
    if (step.loaded === 0) break
    steps.push([step.window.start, step.loaded, step.remaining])
    state = step.state
  }
  assert.deepEqual(steps, [
    [4, 3, 4],
    [1, 3, 1],
    [0, 1, 0],
  ])
})

test('growth keeps the rendered count bounded at page + loaded', () => {
  const mounted = initialTranscriptWindow(300)
  const first = transcriptWindow(300, mounted)
  assert.equal(first.start, 100)
  assert.equal(first.visible, 200)
  // Live output appends at the bottom: the window slides instead of letting
  // every appended row grow the DOM, and the hidden count follows honestly.
  const grown = transcriptWindow(340, mounted)
  assert.equal(grown.start, 140)
  assert.equal(grown.hidden, 140)
  assert.equal(grown.visible, 200)
  assert.equal(grown.controlLabel, 'Show earlier messages (140 more)')
  // A session that started tiny and grew past the page also stays bounded and
  // gains the control instead of rendering everything.
  const tinyThenBig = transcriptWindow(500, initialTranscriptWindow(120))
  assert.equal(tinyThenBig.visible, 200)
  assert.equal(tinyThenBig.hidden, 300)
  assert.equal(tinyThenBig.hasEarlier, true)
})

test('loaded history survives growth without undoing the operator’s chunks', () => {
  let state = initialTranscriptWindow(450)
  state = showEarlierTranscriptWindow(450, state).state
  state = showEarlierTranscriptWindow(450, state).state
  assert.deepEqual(state, { loaded: 200 })
  // 450 rows with 200 loaded: 50 still hidden. Two more rows arrive.
  const grown = transcriptWindow(452, state)
  assert.equal(grown.start, 52)
  assert.equal(grown.hidden, 52)
  assert.equal(grown.visible, 400, 'page + loaded rows stay rendered')
  const step = showEarlierTranscriptWindow(452, state)
  assert.equal(step.loaded, 52, 'the whole remaining run is the last chunk')
  assert.equal(step.remaining, 0)
})

test('a shrinking timeline shows what remains instead of an empty window', () => {
  const recovered = transcriptWindow(150, { loaded: 220 })
  assert.equal(recovered.start, 0, '150 rows fit the default page')
  assert.equal(recovered.visible, 150)

  const exact = transcriptWindow(250, { loaded: 250 })
  assert.equal(exact.start, 0)
  assert.equal(exact.visible, 250)

  const partial = transcriptWindow(260, { loaded: 200 })
  assert.equal(partial.start, 0, 'nothing stays hidden when loaded covers the rest')
  assert.equal(partial.visible, 260)

  const paged = transcriptWindow(260, { loaded: 40 })
  assert.equal(paged.start, 20)
  assert.equal(paged.visible, 240)
})

test('invalid counts/options fail soft to defaults, never throw', () => {
  assert.deepEqual(initialTranscriptWindow(-4), { loaded: 0 })
  assert.deepEqual(initialTranscriptWindow(Number.NaN), { loaded: 0 })
  assert.deepEqual(initialTranscriptWindow(1000, { pageSize: 0 }), { loaded: 0 })

  const total = 1000
  const view = transcriptWindow(total, { loaded: Number.NaN }, { chunkSize: 0 })
  assert.equal(view.start, 800, 'the default page still applies')
  assert.equal(view.chunk, 100, 'an invalid chunk size falls back to the default')
  assert.equal(
    transcriptWindow(150, { loaded: 0 }, { chunkSize: 0 }).chunk,
    0,
    'nothing hidden means nothing to prepend',
  )
  const fromFraction = transcriptWindow(total, { loaded: 3.9 }, { chunkSize: 2.9 })
  assert.equal(fromFraction.start, 797)
  assert.equal(fromFraction.chunk, 2)

  // an activation with a tiny custom chunk still reports truthful counts
  const step = showEarlierTranscriptWindow(10, { loaded: 0 }, { pageSize: 2, chunkSize: 1 })
  assert.deepEqual(step.state, { loaded: 1 })
  assert.equal(step.window.start, 7)
  assert.equal(step.loaded, 1)
  assert.equal(step.remaining, 7)
})

test('slice memo: stable identity per (array, start), input reused at start 0', () => {
  const blocks = [1, 2, 3, 4]
  const memo = createTranscriptSliceMemo<number>()

  assert.equal(memo(blocks, 0), blocks, 'all loaded: no allocation')
  assert.equal(memo(blocks, 0), blocks)
  assert.deepEqual(memo(blocks, 2), [3, 4])
  const tail = memo(blocks, 2)
  assert.equal(memo(blocks, 2), tail)
  assert.deepEqual(memo(blocks, 1), [2, 3, 4])
  assert.notEqual(memo(blocks, 1), tail)

  // a new array for the same values must not be served from the old cache
  const copy = [...blocks]
  assert.deepEqual(memo(copy, 2), [3, 4])
  assert.notEqual(memo(copy, 2), tail)

  // out-of-range starts are clamped; no undefined access or throw
  assert.deepEqual(memo(blocks, 99), [])
  assert.equal(memo(blocks, -4), blocks)
})

test('windowed slices keep the absolute fold/run keys of the full render', () => {
  const timeline: TimelineEntry[] = Array.from({ length: 10 }, (_, i) => ({
    time: i,
    order: i,
    entry: {
      type: 'system',
      activity: { id: `a${i}`, seq: i, ts: '2026-11-04T00:00:00Z', label: `note ${i}` },
    },
  }))

  const state = initialTranscriptWindow(timeline.length, { pageSize: 4 })
  const view = transcriptWindow(timeline.length, state, { pageSize: 4 })
  assert.equal(view.start, 6)
  const memo = createTranscriptSliceMemo<TimelineEntry>()
  const visible = memo(timeline, view.start)
  const windowRows = buildFoldRows(visible, {}, view.start)
  const fullRows = buildFoldRows(timeline)

  assert.deepEqual(
    windowRows.map((row) => row.key),
    fullRows.slice(view.start).map((row) => row.key),
    'prepending a chunk cannot re-key the rows that stayed rendered',
  )

  // Foldable rows: nine tools from one completed run, then non-foldable
  // separators. A window that starts in the middle of the run must key the
  // fold by the run's last member, exactly like the full render does.
  const toolRow = (n: number): TimelineEntry => ({
    time: n,
    order: n,
    entry: {
      type: 'tool',
      id: `old:tool:${n}`,
      actor: 'junior',
      tool: 'read_file',
      args: {},
      at: n,
      runId: 'old',
      status: 'ok',
      result: null,
    },
  })
  const foldTimeline: TimelineEntry[] = [
    ...Array.from({ length: 9 }, (_, i) => toolRow(i)),
    ...Array.from({ length: 3 }, (_, i) => ({
      time: 9 + i,
      order: 9 + i,
      entry: {
        type: 'system' as const,
        activity: {
          id: `s${9 + i}`,
          seq: 9 + i,
          ts: '2026-11-04T00:00:00Z',
          label: `note ${9 + i}`,
        },
      },
    })),
  ]

  const midState = initialTranscriptWindow(foldTimeline.length, { pageSize: 5 })
  const midView = transcriptWindow(foldTimeline.length, midState, { pageSize: 5 })
  assert.equal(midView.start, 7)
  const foldMemo = createTranscriptSliceMemo<TimelineEntry>()
  const midRows = buildFoldRows(foldMemo(foldTimeline, midView.start), {}, midView.start)
  const midFold = midRows.find((row) => row.type === 'fold')
  if (!midFold || midFold.type !== 'fold') assert.fail('expected a fold row starting mid-run')

  const fullFoldRows = buildFoldRows(foldTimeline)
  const fullFold = fullFoldRows.find((row) => row.type === 'fold')
  if (!fullFold || fullFold.type !== 'fold') assert.fail('expected a fold row in the full render')
  assert.equal(midFold.key, 'fold:old:tool:8')
  assert.equal(midFold.key, fullFold.key, 'a mid-run window keeps the full render fold key')

  // Expanding that key survives prepending an earlier chunk (start moves from
  // 7 back to 4, still inside the same run).
  const prependedRows = buildFoldRows(foldMemo(foldTimeline, 4), {
    expanded: new Set([midFold.key]),
  }, 4)
  const prependedFold = prependedRows.find((row) => row.type === 'fold')
  if (!prependedFold || prependedFold.type !== 'fold') assert.fail('expected the fold row after a prepend')
  assert.equal(prependedFold.key, midFold.key)
  assert.equal(prependedFold.expanded, true, 'expansion state keyed by the fold key survives the prepend')
})
