// Focused tests for src/queueState.ts (the per-session FIFO queue projection
// feeding the composer's queue dock). No DOM:
//   node --import ./tests/register-ts.mjs --test tests/queueState.test.ts

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  ACTIVE_RUN_STATUSES,
  EMPTY_QUEUE_VIEW,
  QUEUE_DOCK_MAX_ROWS,
  QUEUE_TASK_PREVIEW_CHARS,
  activeQueueRows,
  isActiveRunStatus,
  queueViewForRows,
  sessionQueueViews,
  taskPreview,
  withQueuedRun,
  withoutRun,
} from '../src/queueState.ts'
import type { QueuedRunRow } from '../src/queueState.ts'

interface RecordOverrides {
  run_id: string
  session?: string
  task?: string
  status?: string
  created?: number
}

/** One backend run record; GET /api/runs order is newest first. */
function record(overrides: RecordOverrides): Record<string, unknown> {
  return {
    run_id: overrides.run_id,
    session: overrides.session ?? 's1',
    task: overrides.task ?? `task ${overrides.run_id}`,
    status: overrides.status ?? 'queued',
    created: overrides.created ?? 100,
  }
}

function row(run_id: string, position: number, session = 's1'): QueuedRunRow {
  return {
    run_id,
    session,
    task: `task ${run_id}`,
    status: 'queued',
    created: 100,
    position,
  }
}

// -- status guard -------------------------------------------------------------

test('isActiveRunStatus accepts exactly the three live statuses', () => {
  for (const status of ACTIVE_RUN_STATUSES) assert.equal(isActiveRunStatus(status), true)
  for (const status of ['completed', 'failed', 'cancelled', '', 'QUEUED', null, 0]) {
    assert.equal(isActiveRunStatus(status), false)
  }
})

// -- task preview -------------------------------------------------------------

test('taskPreview collapses whitespace/control characters into one bounded line', () => {
  assert.equal(taskPreview('  ship\n\nthe\tfix  '), 'ship the fix')
  assert.equal(taskPreview('a\u0000b\u0007c'), 'a b c')
  assert.equal(taskPreview('   '), '')
  assert.equal(taskPreview(undefined), '')
  assert.equal(taskPreview(42), '')
})

test('taskPreview clips over-long text on a code-point boundary with an ellipsis', () => {
  const long = 'x'.repeat(QUEUE_TASK_PREVIEW_CHARS + 20)
  const preview = taskPreview(long)
  assert.equal(Array.from(preview).length, QUEUE_TASK_PREVIEW_CHARS)
  assert.ok(preview.endsWith('…'))

  // emoji are multi-code-unit: clipping must never split a surrogate pair
  const emoji = '😀'.repeat(10)
  const clipped = taskPreview(emoji, 4)
  assert.equal(clipped, '😀😀😀…')
  assert.equal(taskPreview(emoji, 4).isWellFormed(), true)

  // a tiny cap still yields a single well-formed character
  assert.equal(taskPreview(emoji, 1), '…')
  assert.equal(taskPreview('short', 0), 'short') // invalid cap falls back to the default
})

// -- projection ordering ------------------------------------------------------

test('activeQueueRows restores FIFO order from the newest-first API list', () => {
  const runs = [
    record({ run_id: 'c', status: 'queued' }),
    record({ run_id: 'b', status: 'queued' }),
    record({ run_id: 'a', status: 'running' }),
  ]
  const rows = activeQueueRows(runs)
  assert.deepEqual(
    rows.map((item) => [item.run_id, item.position]),
    [
      ['a', 1],
      ['b', 2],
      ['c', 3],
    ],
  )
})

test('activeQueueRows drops terminal, unknown and malformed records', () => {
  const runs = [
    record({ run_id: 'done', status: 'completed' }),
    record({ run_id: 'bad', status: 'exploded' }),
    record({ run_id: 'fail', status: 'failed' }),
    null,
    'nope',
    42,
    { session: 's1', status: 'queued' }, // no run_id
    { run_id: 'no-session', status: 'queued' }, // no session
    record({ run_id: 'live', status: 'running' }),
  ]
  assert.deepEqual(activeQueueRows(runs).map((item) => item.run_id), ['live'])
})

test('terminal-only lists project to no queue at all (older/quiet backend)', () => {
  const runs = [
    record({ run_id: 'one', status: 'completed' }),
    record({ run_id: 'two', status: 'cancelled' }),
  ]
  assert.deepEqual(activeQueueRows(runs), [])
  assert.deepEqual(sessionQueueViews(runs), {})
  assert.deepEqual(sessionQueueViews([]), {})
})

test('duplicate run ids keep only the oldest occurrence', () => {
  const runs = [
    record({ run_id: 'same', status: 'queued' }),
    record({ run_id: 'other', status: 'queued' }),
    record({ run_id: 'same', status: 'running' }),
  ]
  const rows = activeQueueRows(runs)
  assert.deepEqual(rows.map((item) => item.run_id), ['same', 'other'])
  // the oldest (running) record's fields win
  assert.equal(rows[0].status, 'running')
})

test('created is normalized to 0 when missing or not a finite number', () => {
  // newest first: a (bad), b (bad), c (oldest, real timestamp)
  const rows = activeQueueRows([
    record({ run_id: 'a', created: Number.NaN }),
    { run_id: 'b', session: 's1', status: 'queued', created: 'yesterday' },
    record({ run_id: 'c', created: 1700000000 }),
  ])
  assert.deepEqual(rows.map((item) => item.created), [1700000000, 0, 0])
})

// -- session isolation --------------------------------------------------------

test('sessionQueueViews groups by session and never leaks rows across sessions', () => {
  const runs = [
    record({ run_id: 'b2', session: 'beta', status: 'queued' }),
    record({ run_id: 'a2', session: 'alpha', status: 'queued' }),
    record({ run_id: 'b1', session: 'beta', status: 'running' }),
    record({ run_id: 'a1', session: 'alpha', status: 'running' }),
  ]
  const views = sessionQueueViews(runs)
  assert.deepEqual(Object.keys(views).sort(), ['alpha', 'beta'])
  assert.deepEqual(views.alpha.rows.map((item) => item.run_id), ['a1', 'a2'])
  assert.deepEqual(views.beta.rows.map((item) => item.run_id), ['b1', 'b2'])
  for (const view of Object.values(views)) {
    for (const item of view.rows) {
      assert.ok(item.session === 'alpha' || item.session === 'beta')
    }
  }
})

test('activeQueueRows can filter to one session without changing the FIFO order', () => {
  const runs = [
    record({ run_id: 'b2', session: 'beta' }),
    record({ run_id: 'a2', session: 'alpha' }),
    record({ run_id: 'b1', session: 'beta' }),
    record({ run_id: 'a1', session: 'alpha' }),
  ]
  assert.deepEqual(
    activeQueueRows(runs, 'beta').map((item) => [item.run_id, item.position]),
    [
      ['b1', 1],
      ['b2', 2],
    ],
  )
  assert.deepEqual(activeQueueRows(runs, 'missing'), [])
})

test('a pathological session name cannot pollute the projection prototype', () => {
  const runs = [record({ run_id: 'x', session: '__proto__' })]
  const views = sessionQueueViews(runs)
  assert.equal(Object.getPrototypeOf(views), Object.prototype)
  assert.equal(Object.prototype.hasOwnProperty.call(views, '__proto__'), true)
  assert.deepEqual(views['__proto__'].rows.map((item) => item.run_id), ['x'])
})

// -- bounded dock view --------------------------------------------------------

test('queueViewForRows marks the head current and bounds the waiting rows', () => {
  const runs = [
    record({ run_id: 'q8', status: 'queued' }),
    record({ run_id: 'q7', status: 'queued' }),
    record({ run_id: 'q6', status: 'queued' }),
    record({ run_id: 'q5', status: 'queued' }),
    record({ run_id: 'q4', status: 'queued' }),
    record({ run_id: 'q3', status: 'queued' }),
    record({ run_id: 'q2', status: 'queued' }),
    record({ run_id: 'q1', status: 'waiting' }),
    record({ run_id: 'q0', status: 'running' }),
  ]
  const view = sessionQueueViews(runs).s1
  assert.equal(view.current?.run_id, 'q0')
  assert.equal(view.current?.position, 1)
  assert.equal(view.waiting.length, QUEUE_DOCK_MAX_ROWS)
  assert.deepEqual(
    view.waiting.map((item) => [item.run_id, item.position]),
    [
      ['q1', 2],
      ['q2', 3],
      ['q3', 4],
      ['q4', 5],
      ['q5', 6],
    ],
  )
  // q6, q7, q8 do not fit and are counted honestly
  assert.equal(view.hidden, 3)
  assert.equal(view.queuedCount, 8)
  assert.equal(view.rows.length, 9)
})

test('a lone queued run is the current run and nothing waits behind it', () => {
  const view = sessionQueueViews([record({ run_id: 'only', status: 'queued' })]).s1
  assert.equal(view.current?.run_id, 'only')
  assert.deepEqual(view.waiting, [])
  assert.equal(view.hidden, 0)
  assert.equal(view.queuedCount, 0)
})

test('queueViewForRows rebuilds positions and returns the shared empty view', () => {
  assert.equal(queueViewForRows([]), EMPTY_QUEUE_VIEW)
  const view = queueViewForRows([row('b', 9), row('a', 1)])
  assert.deepEqual(view.rows.map((item) => item.position), [1, 2])
  assert.equal(view.current?.run_id, 'b')
})

// -- optimistic mutations -----------------------------------------------------

test('withQueuedRun appends one confirmed run behind the current one', () => {
  const before = sessionQueueViews([
    record({ run_id: 'a', status: 'running' }),
  ])
  const next = withQueuedRun(before, {
    run_id: 'b',
    session: 's1',
    task: '  second\n task  ',
    status: 'queued',
    created: 1700000123,
  })
  assert.equal(next.s1.current?.run_id, 'a')
  assert.deepEqual(
    next.s1.waiting.map((item) => [item.run_id, item.position, item.task]),
    [['b', 2, 'second task']],
  )
  assert.equal(next.s1.queuedCount, 1)
  // the previous projection is untouched
  assert.deepEqual(before.s1.rows.map((item) => item.run_id), ['a'])
})

test('withQueuedRun is idempotent, defaults the status and can open a session', () => {
  const empty: Record<string, ReturnType<typeof sessionQueueViews>[string]> = {}
  const first = withQueuedRun(empty, { run_id: 'a', session: 's1', task: 'go' })
  assert.equal(first.s1.current?.run_id, 'a')
  assert.equal(first.s1.current?.status, 'queued')
  // a poll may already have delivered the row: adding it again changes nothing
  assert.equal(withQueuedRun(first, { run_id: 'a', session: 's1' }), first)
  // malformed input is ignored, never invented
  assert.equal(withQueuedRun(first, { run_id: '', session: 's1' }), first)
  assert.equal(withQueuedRun(first, { run_id: 'x', session: '' }), first)
  assert.equal(withQueuedRun(first, { run_id: 'y', session: 's1', status: 'bogus' }), first)
})

test('withQueuedRun keeps the session FIFO even when a poll re-sorts the list', () => {
  const before = sessionQueueViews([
    record({ run_id: 'c', status: 'queued' }),
    record({ run_id: 'a', status: 'running' }),
  ])
  assert.deepEqual(before.s1.rows.map((item) => item.run_id), ['a', 'c'])
  const next = withQueuedRun(before, { run_id: 'b', session: 's1', status: 'queued' })
  // optimistic append is the newest submission; the next poll re-sorts anyway
  assert.deepEqual(next.s1.rows.map((item) => item.run_id), ['a', 'c', 'b'])
})

test('withoutRun removes a row, repositions the rest and prunes empty sessions', () => {
  // newest first: c was submitted last, a is the running head
  const before = sessionQueueViews([
    record({ run_id: 'c', status: 'queued' }),
    record({ run_id: 'b', status: 'queued' }),
    record({ run_id: 'a', status: 'running' }),
  ])
  const next = withoutRun(before, 'b')
  assert.notEqual(next, before)
  assert.deepEqual(
    next.s1.rows.map((item) => [item.run_id, item.position]),
    [
      ['a', 1],
      ['c', 2],
    ],
  )
  // unknown id: unchanged by reference
  assert.equal(withoutRun(next, 'missing'), next)
  assert.equal(withoutRun(next, ''), next)
  // removing the last run drops the session entirely
  const oneLeft = withoutRun(withoutRun(next, 'c'), 'a')
  assert.deepEqual(oneLeft, {})
  assert.deepEqual(before.s1.rows.length, 3)
})

test('activeQueueRows tolerates a non-array list', () => {
  assert.deepEqual(activeQueueRows(null as unknown as unknown[]), [])
  assert.deepEqual(sessionQueueViews(undefined as unknown as unknown[]), {})
})
