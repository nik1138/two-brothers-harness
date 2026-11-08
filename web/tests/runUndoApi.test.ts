/**
 * Hermetic tests for the session-scoped run-undo api mapping
 * (`web/src/api.ts`): exact request method/path for preview/apply/discard and
 * the tolerant response normalization. `fetch` is stubbed — no network.
 *
 * The approved wave-23 contract is session-scoped:
 *   GET    /api/sessions/{name}/undo/{run_id}  → preview
 *   POST   /api/sessions/{name}/undo/{run_id}  → apply
 *   DELETE /api/sessions/{name}/undo/{run_id}  → discard
 * An older backend answers 404 for the GET; the app then hides the action
 * (fail-soft, tested here through the ApiError status).
 *
 * Run with: node --import ./tests/register-ts.mjs --test tests/runUndoApi.test.ts
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  ApiError,
  applyRunUndo,
  discardRunUndo,
  previewRunUndo,
} from '../src/api'

interface CapturedCall {
  url: string
  method: string
}

function stubFetch(responses: Array<{ status?: number; body: unknown }>): {
  calls: CapturedCall[]
  restore: () => void
} {
  const original = globalThis.fetch
  const calls: CapturedCall[] = []
  let index = 0
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    calls.push({ url, method: init?.method ?? 'GET' })
    const response = responses[Math.min(index, responses.length - 1)] ?? { body: {} }
    index += 1
    return new Response(JSON.stringify(response.body ?? {}), {
      status: response.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch
  return { calls, restore: () => (globalThis.fetch = original) }
}

test('preview uses the session-scoped GET path and maps the approved response', async () => {
  const stub = stubFetch([
    {
      body: {
        session: 'chat.jsonl',
        run_id: 'run-1',
        workspace_root: '/work',
        created_at: '2026-11-08T09:00:00.000Z',
        statuses: [
          { path: 'src/app.ts', action: 'edit', status: 'applicable', reversible: true },
          { path: 'gone.ts', action: 'delete', status: 'deleted', reversible: true },
          { path: 'moved.ts', action: 'edit', status: 'changed-since', reason: 'edited later', reversible: false },
        ],
        counts: { applicable: 1, deleted: 1, changed_since: 1, created: 0, skipped: 0, missing: 0 },
      },
    },
  ])
  try {
    const preview = await previewRunUndo('chat.jsonl', 'run-1')
    assert.deepEqual(stub.calls, [{ url: '/api/sessions/chat.jsonl/undo/run-1', method: 'GET' }])
    assert.equal(preview.session, 'chat.jsonl')
    assert.equal(preview.run_id, 'run-1')
    assert.equal(preview.workspace_root, '/work')
    assert.equal(preview.statuses!.length, 3)
    assert.equal(preview.statuses![2]!.reason, 'edited later')
    assert.equal(preview.statuses![2]!.reversible, false)
    assert.deepEqual(preview.counts, {
      applicable: 1,
      deleted: 1,
      changed_since: 1,
      created: 0,
      skipped: 0,
      missing: 0,
    })
  } finally {
    stub.restore()
  }
})

test('apply uses the session-scoped POST path and keeps refused files separate', async () => {
  const stub = stubFetch([
    {
      body: {
        session: 'chat.jsonl',
        run_id: 'run-1',
        workspace_root: '/work',
        applied: 1,
        refused: 1,
        failed: 0,
        files: [
          { path: 'src/app.ts', action: 'edit', status: 'applied', preview_status: 'applicable' },
          { path: 'moved.ts', action: 'edit', status: 'refused', preview_status: 'changed-since', reason: 'edited later' },
        ],
        counts: { applicable: 1, changed_since: 1 },
      },
    },
  ])
  try {
    const result = await applyRunUndo('chat.jsonl', 'run-1')
    assert.deepEqual(stub.calls, [{ url: '/api/sessions/chat.jsonl/undo/run-1', method: 'POST' }])
    assert.equal(result.applied, 1)
    assert.equal(result.refused, 1)
    assert.equal(result.failed, 0)
    assert.equal(result.files!.length, 2)
    assert.equal(result.files![1]!.status, 'refused')
    assert.equal(result.files![1]!.reason, 'edited later')
  } finally {
    stub.restore()
  }
})

test('discard uses DELETE and maps the acknowledgement', async () => {
  const stub = stubFetch([{ body: { discarded: true, session: 'chat.jsonl', run_id: 'run-1' } }])
  try {
    const result = await discardRunUndo('chat.jsonl', 'run-1')
    assert.deepEqual(stub.calls, [{ url: '/api/sessions/chat.jsonl/undo/run-1', method: 'DELETE' }])
    assert.deepEqual(result, { discarded: true, session: 'chat.jsonl', run_id: 'run-1' })
  } finally {
    stub.restore()
  }
})

test('an unknown session/record is a 404 the app can hide the action on', async () => {
  const stub = stubFetch([{ status: 404, body: { detail: 'not found' } }])
  try {
    await assert.rejects(previewRunUndo('chat.jsonl', 'missing'), (err: unknown) => {
      assert.ok(err instanceof ApiError)
      assert.equal(err.status, 404)
      return true
    })
    // The path is still the session-scoped one; a 404 is the honest old-backend
    // (or no-record) answer, never a fake empty preview.
    assert.deepEqual(stub.calls, [{ url: '/api/sessions/chat.jsonl/undo/missing', method: 'GET' }])
  } finally {
    stub.restore()
  }
})

test('a 409 record/workspace conflict surfaces its honest detail', async () => {
  const stub = stubFetch([{ status: 409, body: { detail: 'workspace root is not registered' } }])
  try {
    await assert.rejects(applyRunUndo('chat.jsonl', 'run-1'), (err: unknown) => {
      assert.ok(err instanceof ApiError)
      assert.equal(err.status, 409)
      assert.equal(err.message, 'workspace root is not registered')
      return true
    })
  } finally {
    stub.restore()
  }
})

test('a malformed success body degrades to an empty, non-crashing result', async () => {
  const stub = stubFetch([{ body: 'not an object' }])
  try {
    const preview = await previewRunUndo('chat.jsonl', 'run-1')
    assert.deepEqual(preview, { statuses: [] })
    const result = await applyRunUndo('chat.jsonl', 'run-1')
    assert.deepEqual(result, { applied: 0, refused: 0, failed: 0, files: [] })
  } finally {
    stub.restore()
  }
})
