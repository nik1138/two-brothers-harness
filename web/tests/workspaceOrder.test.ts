// Focused tests for src/workspaceOrder.ts (pure ordering/name helpers) and the
// matching api.ts wiring. No DOM; mocked fetch keeps the API checks offline:
//   node --import ./tests/register-ts.mjs --test tests/workspaceOrder.test.ts

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  WORKSPACE_NAME_MAX,
  dropReorderDelta,
  dropReorderIds,
  isSameOrder,
  moveWorkspaceId,
  moveWorkspaceTo,
  normalizeWorkspaceName,
  orderedWorkspaces,
  workspaceNameProblem,
} from '../src/workspaceOrder.ts'
import { ApiError, renameWorkspace, reorderWorkspaces } from '../src/api.ts'
import type { Workspace } from '../src/types.ts'

const ids = (...values: string[]): string[] => values

function workspace(id: string, name = id): Workspace {
  return { id, name, path: `/projects/${id}` }
}

// -- constants / naming -------------------------------------------------------

test('WORKSPACE_NAME_MAX is the documented input bound', () => {
  assert.equal(WORKSPACE_NAME_MAX, 120)
})

test('normalizeWorkspaceName trims, collapses whitespace and tolerates junk', () => {
  assert.equal(normalizeWorkspaceName('  Two  Brothers '), 'Two Brothers')
  assert.equal(normalizeWorkspaceName('a\n\tb'), 'a b')
  assert.equal(normalizeWorkspaceName('solo'), 'solo')
  assert.equal(normalizeWorkspaceName('   '), '')
  assert.equal(normalizeWorkspaceName(''), '')
  assert.equal(normalizeWorkspaceName(null), '')
  assert.equal(normalizeWorkspaceName(undefined), '')
  assert.equal(normalizeWorkspaceName(42), '')
})

test('workspaceNameProblem rejects blank and over-long names only', () => {
  assert.ok(workspaceNameProblem(''))
  assert.ok(workspaceNameProblem('   '))
  assert.ok(workspaceNameProblem('\n\t'))
  assert.ok(workspaceNameProblem(null))
  assert.ok(workspaceNameProblem(undefined))
  assert.ok(workspaceNameProblem(7))

  assert.equal(workspaceNameProblem('project'), null)
  assert.equal(workspaceNameProblem('  Two Brothers  '), null)
  assert.equal(workspaceNameProblem('x'.repeat(WORKSPACE_NAME_MAX)), null)
  assert.ok(workspaceNameProblem('x'.repeat(WORKSPACE_NAME_MAX + 1)))
})

// -- moveWorkspaceId ----------------------------------------------------------

test('moveWorkspaceId moves one slot up/down and returns a new array', () => {
  const original = ids('a', 'b', 'c', 'd')
  assert.deepEqual(moveWorkspaceId(original, 'c', -1), ids('a', 'c', 'b', 'd'))
  assert.deepEqual(moveWorkspaceId(original, 'b', 1), ids('a', 'c', 'b', 'd'))
  assert.deepEqual(original, ids('a', 'b', 'c', 'd'), 'input is never mutated')

  const moved = moveWorkspaceId(original, 'b', 1)
  assert.notEqual(moved, original)
  moved.push('e')
  assert.deepEqual(original, ids('a', 'b', 'c', 'd'), 'result is an independent copy')
})

test('moveWorkspaceId is a no-op at the boundaries and for unknown ids', () => {
  const original = ids('a', 'b', 'c')
  assert.deepEqual(moveWorkspaceId(original, 'a', -1), ids('a', 'b', 'c'))
  assert.deepEqual(moveWorkspaceId(original, 'c', 1), ids('a', 'b', 'c'))
  assert.deepEqual(moveWorkspaceId(original, 'nope', 1), ids('a', 'b', 'c'))
  assert.deepEqual(moveWorkspaceId(original, 'nope', -1), ids('a', 'b', 'c'))
  assert.deepEqual(moveWorkspaceId([], 'a', 1), [])
})

test('moveWorkspaceId clamps large/odd deltas and ignores non-finite ones', () => {
  const original = ids('a', 'b', 'c', 'd')
  assert.deepEqual(moveWorkspaceId(original, 'b', 99), ids('a', 'c', 'd', 'b'))
  assert.deepEqual(moveWorkspaceId(original, 'c', -99), ids('c', 'a', 'b', 'd'))
  assert.deepEqual(moveWorkspaceId(original, 'b', 0), original)
  assert.deepEqual(moveWorkspaceId(original, 'b', Number.NaN), original)
  assert.deepEqual(moveWorkspaceId(original, 'b', Number.POSITIVE_INFINITY), original)
  assert.deepEqual(moveWorkspaceId(original, 'b', 1.9), ids('a', 'c', 'b', 'd'), 'floors delta')
  assert.deepEqual(moveWorkspaceId(original, 'c', -0.9), original, 'trunc(0) is a no-op')
})

test('moveWorkspaceId: single-item and missing-array inputs are safe', () => {
  assert.deepEqual(moveWorkspaceId(['a'], 'a', 1), ['a'])
  assert.deepEqual(moveWorkspaceId(['a'], 'a', -1), ['a'])
  assert.deepEqual(moveWorkspaceId(null, 'a', 1), [])
  assert.deepEqual(moveWorkspaceId(undefined, 'a', -1), [])
})

// -- moveWorkspaceTo ----------------------------------------------------------

test('moveWorkspaceTo moves to an exact index and clamps out-of-range targets', () => {
  const original = ids('a', 'b', 'c', 'd')
  assert.deepEqual(moveWorkspaceTo(original, 'd', 0), ids('d', 'a', 'b', 'c'))
  assert.deepEqual(moveWorkspaceTo(original, 'a', 3), ids('b', 'c', 'd', 'a'))
  assert.deepEqual(moveWorkspaceTo(original, 'b', 2), ids('a', 'c', 'b', 'd'))
  assert.deepEqual(moveWorkspaceTo(original, 'a', 99), ids('b', 'c', 'd', 'a'))
  assert.deepEqual(moveWorkspaceTo(original, 'd', -99), ids('d', 'a', 'b', 'c'))
  assert.deepEqual(moveWorkspaceTo(original, 'b', 1.9), original, 'same clamped index')
})

test('moveWorkspaceTo: unknown ids and bad targets are a no-op copy', () => {
  const original = ids('a', 'b', 'c')
  assert.deepEqual(moveWorkspaceTo(original, 'nope', 0), original)
  assert.deepEqual(moveWorkspaceTo(original, 'b', Number.NaN), original)
  assert.deepEqual(moveWorkspaceTo(original, 'b', Number.NEGATIVE_INFINITY), original)
  assert.deepEqual(original, ids('a', 'b', 'c'), 'input is never mutated')
  assert.deepEqual(moveWorkspaceTo(null, 'b', 0), [])
})

// -- dropReorderDelta / dropReorderIds (drag-and-drop) -------------------------

test('dropReorderDelta: before/after drops map to the menu-move delta', () => {
  const original = ids('a', 'b', 'c', 'd')
  // down: a dropped after c is two slots down
  assert.equal(dropReorderDelta(original, 'a', 'c', 'after'), 2)
  assert.equal(dropReorderDelta(original, 'b', 'd', 'after'), 2)
  // up: d dropped before b is two slots up
  assert.equal(dropReorderDelta(original, 'd', 'b', 'before'), -2)
  assert.equal(dropReorderDelta(original, 'c', 'a', 'before'), -2)
  // one step in each direction
  assert.equal(dropReorderDelta(original, 'b', 'c', 'after'), 1)
  assert.equal(dropReorderDelta(original, 'c', 'b', 'before'), -1)
  // boundaries: first after last / last before first
  assert.equal(dropReorderDelta(original, 'a', 'd', 'after'), 3)
  assert.equal(dropReorderDelta(original, 'd', 'a', 'before'), -3)
  // default position is "before"
  assert.equal(dropReorderDelta(original, 'd', 'a'), -3)
})

test('dropReorderDelta: identity and already-ordered drops are no-ops', () => {
  const original = ids('a', 'b', 'c', 'd')
  // dropping a group on itself in either half
  assert.equal(dropReorderDelta(original, 'b', 'b', 'before'), 0)
  assert.equal(dropReorderDelta(original, 'b', 'b', 'after'), 0)
  // neighbour drops that already describe the current order
  assert.equal(dropReorderDelta(original, 'b', 'c', 'before'), 0)
  assert.equal(dropReorderDelta(original, 'b', 'a', 'after'), 0)
  assert.equal(dropReorderDelta(original, 'a', 'b', 'before'), 0)
  assert.equal(dropReorderDelta(original, 'd', 'c', 'after'), 0)
})

test('dropReorderDelta: unknown ids and unusable lists are no-ops', () => {
  const original = ids('a', 'b', 'c')
  assert.equal(dropReorderDelta(original, 'nope', 'a', 'before'), 0)
  assert.equal(dropReorderDelta(original, 'a', 'nope', 'after'), 0)
  assert.equal(dropReorderDelta([], 'a', 'b', 'before'), 0)
  assert.equal(dropReorderDelta(null, 'a', 'b', 'after'), 0)
  assert.equal(dropReorderDelta(undefined, 'a', 'b', 'before'), 0)
  assert.equal(dropReorderDelta(ids('a'), 'a', 'a', 'after'), 0)
})

test('dropReorderIds: returns the full new order and never mutates the input', () => {
  const original = ids('a', 'b', 'c', 'd')
  assert.deepEqual(dropReorderIds(original, 'a', 'c', 'after'), ids('b', 'c', 'a', 'd'))
  assert.deepEqual(dropReorderIds(original, 'd', 'b', 'before'), ids('a', 'd', 'b', 'c'))
  assert.deepEqual(dropReorderIds(original, 'a', 'd', 'after'), ids('b', 'c', 'd', 'a'))
  assert.deepEqual(dropReorderIds(original, 'd', 'a', 'before'), ids('d', 'a', 'b', 'c'))
  assert.deepEqual(original, ids('a', 'b', 'c', 'd'), 'input is never mutated')

  const moved = dropReorderIds(original, 'b', 'd', 'after')
  assert.notEqual(moved, original)
  moved.push('e')
  assert.deepEqual(original, ids('a', 'b', 'c', 'd'), 'result is an independent copy')
})

test('dropReorderIds: boundary and identity drops are a no-op copy of the order', () => {
  const original = ids('a', 'b', 'c')
  for (const [from, to, position] of [
    ['a', 'b', 'before'],
    ['c', 'b', 'after'],
    ['b', 'b', 'before'],
    ['nope', 'a', 'before'],
  ] as const) {
    const result = dropReorderIds(original, from, to, position)
    assert.deepEqual(result, original, `${from} ${position} ${to}`)
    assert.notEqual(result, original, 'still a fresh copy')
  }
  assert.deepEqual(dropReorderIds(['a'], 'a', 'a', 'after'), ['a'])
  assert.deepEqual(dropReorderIds([], 'a', 'b', 'before'), [])
  assert.deepEqual(dropReorderIds(null, 'a', 'b', 'before'), [])
})

test('dropReorderIds agrees with moveWorkspaceTo for the same destination', () => {
  const original = ids('a', 'b', 'c', 'd')
  // dropping a after c lands it at index 2; dropping d before b lands at index 1
  assert.deepEqual(dropReorderIds(original, 'a', 'c', 'after'), moveWorkspaceTo(original, 'a', 2))
  assert.deepEqual(dropReorderIds(original, 'd', 'b', 'before'), moveWorkspaceTo(original, 'd', 1))
  assert.deepEqual(dropReorderIds(original, 'c', 'a', 'before'), moveWorkspaceTo(original, 'c', 0))
  assert.deepEqual(dropReorderIds(original, 'b', 'd', 'after'), moveWorkspaceTo(original, 'b', 3))
})

// -- isSameOrder --------------------------------------------------------------

test('isSameOrder compares ids in order and tolerates missing arrays', () => {
  assert.equal(isSameOrder(ids('a', 'b'), ids('a', 'b')), true)
  assert.equal(isSameOrder([], []), true)
  assert.equal(isSameOrder(ids('a', 'b'), ids('b', 'a')), false)
  assert.equal(isSameOrder(ids('a', 'b'), ids('a', 'b', 'c')), false)
  assert.equal(isSameOrder(ids('a', 'b'), null), false)
  assert.equal(isSameOrder(undefined, []), false)
})

// -- orderedWorkspaces --------------------------------------------------------

test('orderedWorkspaces preserves order, drops invalid entries and dedupes ids', () => {
  const a = workspace('a', 'Alpha')
  const b = workspace('b', 'Beta')
  const c = workspace('c', 'Gamma')
  const ordered = orderedWorkspaces([
    b,
    null as unknown as Workspace,
    a,
    { id: '', name: 'blank', path: '' },
    { id: '   ', name: 'spaces', path: '' },
    c,
    b,
  ])
  assert.deepEqual(ordered, [b, a, c])
  assert.equal(ordered[0], b, 'entries keep their identity')

  assert.deepEqual(orderedWorkspaces([]), [])
  assert.deepEqual(orderedWorkspaces(null), [])
  assert.deepEqual(orderedWorkspaces(undefined), [])
})

// -- api.ts wiring (mocked fetch; still fully offline) ------------------------

interface FakeResponse {
  ok: boolean
  status: number
  json: () => Promise<unknown>
}

function fakeResponse(status: number, body: unknown): FakeResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }
}

/** Run `run` with a stubbed global fetch, restoring the real one afterwards. */
async function withFetch(
  impl: (url: string, init?: RequestInit) => Promise<FakeResponse>,
  run: (calls: { url: string; init?: RequestInit }[]) => Promise<void>,
): Promise<void> {
  const calls: { url: string; init?: RequestInit }[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input)
    calls.push({ url, init })
    return impl(url, init)
  }) as typeof fetch
  try {
    await run(calls)
  } finally {
    globalThis.fetch = original
  }
}

test('renameWorkspace: PATCH /api/workspaces/{id} with a JSON name body', async () => {
  const saved = workspace('id with space', 'New Name')
  await withFetch(
    async () => fakeResponse(200, saved),
    async (calls) => {
      const result = await renameWorkspace('id with space', 'New Name')
      assert.deepEqual(result, saved)
      assert.equal(calls.length, 1)
      const call = calls[0]!
      assert.equal(call.url, '/api/workspaces/id%20with%20space')
      assert.equal(call.init?.method, 'PATCH')
      assert.equal((call.init?.headers as Record<string, string>)['Content-Type'], 'application/json')
      assert.equal(call.init?.body, JSON.stringify({ name: 'New Name' }))
    },
  )
})

test('reorderWorkspaces: PUT /api/workspaces/order with the id permutation', async () => {
  const ordered = [workspace('b'), workspace('a')]
  await withFetch(
    async () => fakeResponse(200, { workspaces: ordered }),
    async (calls) => {
      const result = await reorderWorkspaces(['b', 'a'])
      assert.deepEqual(result, ordered)
      const call = calls[0]!
      assert.equal(call.url, '/api/workspaces/order')
      assert.equal(call.init?.method, 'PUT')
      assert.equal((call.init?.headers as Record<string, string>)['Content-Type'], 'application/json')
      assert.equal(call.init?.body, JSON.stringify({ ids: ['b', 'a'] }))
    },
  )
})

test('reorderWorkspaces: a malformed success body degrades to an empty list', async () => {
  await withFetch(
    async () => fakeResponse(200, { nope: true }),
    async () => {
      assert.deepEqual(await reorderWorkspaces(['a']), [])
    },
  )
})

test('workspace mutations surface ApiError with status and detail', async () => {
  await withFetch(
    async () => fakeResponse(404, { detail: 'not found' }),
    async () => {
      await assert.rejects(
        () => renameWorkspace('gone', 'Name'),
        (error: unknown) =>
          error instanceof ApiError && error.status === 404 && error.message === 'not found',
      )
    },
  )

  await withFetch(
    () => Promise.reject(new Error('offline')),
    async () => {
      await assert.rejects(
        () => reorderWorkspaces(['a', 'b']),
        (error: unknown) => error instanceof ApiError && error.status === 0,
      )
    },
  )
})
