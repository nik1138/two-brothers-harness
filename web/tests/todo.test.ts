// Focused tests for the web plan/todo projection: latest `todo_updated`
// snapshot (last write wins), the bounded panel selection with hidden counts,
// malformed-payload tolerance, and per-session isolation. No DOM:
//   node --import ./tests/register-ts.mjs --test tests/todo.test.ts

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  TODO_PANEL_COLLAPSED_ROWS,
  selectTodoRows,
  todoHiddenLabel,
  todoPlanSummary,
  todosOf,
} from '../src/runtime.ts'
import type { RunEvent, TodoItem } from '../src/types.ts'

/** One `todo_updated` sidecar/live event. */
function update(todos: unknown, at = 1): RunEvent {
  return {
    type: 'todo_updated',
    todos,
    run_id: 'run-1',
    at,
  } as unknown as RunEvent
}

function plan(): TodoItem[] {
  return [
    { content: 'read the request', status: 'completed' },
    { content: 'plan the work', status: 'in_progress' },
    { content: 'write the code', status: 'pending' },
  ]
}

// ---------------------------------------------------------------------------
// latest snapshot (last write wins)
// ---------------------------------------------------------------------------

test('no todo_updated event means an empty plan (older backend → no dock)', () => {
  assert.deepEqual(todosOf([]), [])
  assert.deepEqual(
    todosOf([
      { type: 'run_status', status: 'running', run_id: 'r', at: 1 } as unknown as RunEvent,
      { type: 'tool_started', tool: 'workspace_read_file', args: {}, actor: 'junior', run_id: 'r', at: 2 } as unknown as RunEvent,
    ]),
    [],
  )
})

test('the last todo_updated wins, independent of event order in the list', () => {
  const first = [{ content: 'first plan', status: 'pending' }]
  const second = [
    { content: 'first plan', status: 'completed' },
    { content: 'second plan', status: 'in_progress' },
  ]
  assert.deepEqual(todosOf([update(first), update(second)]), second)

  // Sidecar replay: events load in write order, so the tail is the plan.
  const sidecar = [update(first, 10), update(second, 20)]
  assert.deepEqual(todosOf(sidecar), second)
})

test('a cleared plan (empty list) is the current plan, not a fallback', () => {
  assert.deepEqual(todosOf([update(plan()), update([])]), [])
})

// ---------------------------------------------------------------------------
// tolerant payloads
// ---------------------------------------------------------------------------

test('malformed snapshots are dropped/coerced instead of breaking the panel', () => {
  const raw = [
    update('nope'),
    update(plan()),
  ]
  assert.deepEqual(todosOf(raw), plan(), 'a malformed event earlier does not erase a valid one')

  const messy = todosOf([
    update([
      null,
      42,
      'junk',
      [],
      { content: 7, status: 'pending' },
      { content: '   ', status: 'pending' },
      { content: '  keep\n\tme  ', status: 'weird' },
      { content: 'done', status: 'completed' },
    ]),
  ])
  assert.deepEqual(messy, [
    { content: 'keep me', status: 'pending' },
    { content: 'done', status: 'completed' },
  ])
})

test('an oversized content line is bounded (never an unbounded DOM row)', () => {
  const huge = 'x'.repeat(400)
  const [item] = todosOf([update([{ content: huge, status: 'pending' }])])
  assert.equal([...item.content].length, 200)
  assert.ok(item.content.endsWith('…'))
})

// ---------------------------------------------------------------------------
// bounded selection
// ---------------------------------------------------------------------------

test('a plan that fits shows every row with no hidden tail', () => {
  const selection = selectTodoRows(plan(), TODO_PANEL_COLLAPSED_ROWS)
  assert.deepEqual(selection.rows, plan())
  assert.equal(selection.hidden, 0)
  assert.equal(todoHiddenLabel(selection), '')
  assert.equal(TODO_PANEL_COLLAPSED_ROWS, 4)
})

test('a long plan is bounded with truthful hidden counts', () => {
  const many: TodoItem[] = Array.from({ length: 10 }, (_, index) => ({
    content: `task ${index + 1}`,
    status: index === 9 ? 'in_progress' : index < 3 ? 'completed' : 'pending',
  }))
  const selection = selectTodoRows(many)
  assert.equal(selection.rows.length, TODO_PANEL_COLLAPSED_ROWS)
  assert.equal(selection.hidden, 10 - TODO_PANEL_COLLAPSED_ROWS)
  assert.equal(
    selection.hiddenCounts.completed +
      selection.hiddenCounts.pending +
      selection.hiddenCounts.in_progress,
    selection.hidden,
  )
  // the active item is always visible even when the plan is long
  assert.ok(selection.rows.some((todo) => todo.content === 'task 10'))
  assert.match(todoHiddenLabel(selection), /^\+6 more \(/)
})

test('selection keeps in-progress first, then next pending, then recent completed', () => {
  const list: TodoItem[] = [
    { content: 'old done', status: 'completed' },
    { content: 'next up', status: 'pending' },
    { content: 'active', status: 'in_progress' },
    { content: 'later', status: 'pending' },
    { content: 'new done', status: 'completed' },
  ]
  const selection = selectTodoRows(list, 3)
  // active + the earliest pending entries; completed items only fill room.
  assert.deepEqual(
    selection.rows.map((todo) => todo.content),
    ['next up', 'active', 'later'],
  )
  assert.equal(selection.hidden, 2)
  assert.deepEqual(selection.hiddenCounts, { pending: 0, in_progress: 0, completed: 2 })
  // the selection never mutates the projection's array
  assert.deepEqual(list.map((todo) => todo.content), [
    'old done',
    'next up',
    'active',
    'later',
    'new done',
  ])
})

test('completed entries fill leftover room after active/pending ones', () => {
  const list: TodoItem[] = [
    { content: 'done one', status: 'completed' },
    { content: 'active', status: 'in_progress' },
    { content: 'done two', status: 'completed' },
  ]
  const selection = selectTodoRows(list, 2)
  assert.deepEqual(
    selection.rows.map((todo) => todo.content),
    ['active', 'done two'],
    'the latest completed entry takes the leftover slot',
  )
  assert.deepEqual(selection.hiddenCounts, { pending: 0, in_progress: 0, completed: 1 })
  assert.match(todoHiddenLabel(selection), /1 completed/)
})

// ---------------------------------------------------------------------------
// summary + per-session isolation
// ---------------------------------------------------------------------------

test('the summary counts statuses and names the first active entry', () => {
  const summary = todoPlanSummary(plan())
  assert.deepEqual(
    {
      total: summary.total,
      pending: summary.pending,
      inProgress: summary.inProgress,
      completed: summary.completed,
    },
    { total: 3, pending: 1, inProgress: 1, completed: 1 },
  )
  assert.deepEqual(summary.current, { content: 'plan the work', status: 'in_progress' })
  assert.equal(todoPlanSummary([]).current, null)
})

test('two sessions project independently: no plan leaks across sessions', () => {
  const sessionA = [update([{ content: 'A task', status: 'pending' }])]
  const sessionB = [
    update([
      { content: 'B task', status: 'completed' },
      { content: 'B next', status: 'in_progress' },
    ]),
  ]
  const a = todosOf(sessionA)
  const b = todosOf(sessionB)
  assert.deepEqual(a, [{ content: 'A task', status: 'pending' }])
  assert.deepEqual(b, [
    { content: 'B task', status: 'completed' },
    { content: 'B next', status: 'in_progress' },
  ])
  // projecting one session again cannot change the other's result
  assert.deepEqual(todosOf(sessionA), a)
  // a session without any plan (older backend, or before the first write)
  // stays empty and must never borrow another session's list
  assert.deepEqual(todosOf([]), [])
})
