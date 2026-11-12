/**
 * Operator helper controls in the web shell (slice A1): the interrupt request
 * path, the old-backend 404 capability latch and its inline notice, and the
 * cancellation-reason fix that keeps an approval card's own reason.
 *
 * No DOM: pure modules + source assertions for the drawer template (vue-tsc
 * covers the template types in `npm run build`).
 *   node --import ./tests/register-ts.mjs --test tests/subagentControls.test.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { ApiError, interruptSubagent } from '../src/api.ts'
import { projectRuntimeEvents, resetRuntimeProjection } from '../src/runtime.ts'
import type { ApprovalItem } from '../src/runtime.ts'
import {
  SUBAGENT_CONTROLS_UNSUPPORTED_NOTICE,
  isMissingSubagentControlRoute,
  markSubagentControlsUnavailable,
  resetSubagentControlsAvailability,
  subagentControlsUnavailable,
  subagentInterruptNotice,
} from '../src/subagentControls.ts'
import { applySubagentEvent } from '../src/subagents.ts'
import type { RunEvent, SubagentInfo } from '../src/types.ts'

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/${relative}`, import.meta.url)), 'utf8')

interface FetchCapture {
  url?: string
  init?: RequestInit
}

function stubFetch(
  status: number,
  responseBody: unknown,
  capture: FetchCapture,
): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    capture.url = String(input)
    capture.init = init
    return new Response(JSON.stringify(responseBody), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch
  return () => {
    globalThis.fetch = original
  }
}

function approvalItem(reason: string | undefined, resolution: Record<string, unknown>): ApprovalItem {
  resetRuntimeProjection([])
  const items = projectRuntimeEvents([
    {
      type: 'approval_requested',
      approval_id: 'ap-1',
      action: 'write',
      target: '.env',
      ...(reason !== undefined ? { reason } : {}),
      run_id: 'run-1',
      at: 1,
    } as unknown as RunEvent,
    {
      type: 'approval_resolved',
      approval_id: 'ap-1',
      decision: 'deny',
      run_id: 'run-1',
      at: 2,
      ...resolution,
    } as unknown as RunEvent,
  ])
  const item = items.find((entry): entry is ApprovalItem => entry.type === 'approval')
  assert.ok(item)
  return item
}

function childRow(): SubagentInfo {
  return {
    id: 'sub-12345678',
    parent_session: 'parent.jsonl',
    label: 'Write the helper file',
    role: 'junior',
    model: 'e2e-helper',
    task: 'Write it.',
    status: 'running',
    started_at: 1_000,
    last_activity: null,
    usage: null,
    result: null,
    error: null,
  }
}

// ---------------------------------------------------------------------------
// request path
// ---------------------------------------------------------------------------

test('interruptSubagent POSTs the child-keyed route and returns its honest status', async () => {
  const capture: FetchCapture = {}
  const restore = stubFetch(200, { subagent_id: 'sub-abc12345', status: 'interrupting' }, capture)
  try {
    const result = await interruptSubagent('sub-abc12345')
    assert.equal(result.status, 'interrupting')
    assert.equal(result.subagent_id, 'sub-abc12345')
    assert.equal(capture.init?.method, 'POST')
    assert.match(String(capture.url), /\/api\/subagents\/sub-abc12345\/interrupt$/)
    // The id is encoded, never interpolated as a path.
    assert.equal(capture.url?.includes('sub-abc12345'), true)
  } finally {
    restore()
  }
})

test('the interrupt id is URL-encoded and an already-finished child is a 200', async () => {
  const capture: FetchCapture = {}
  const restore = stubFetch(200, { subagent_id: 'sub-abc12345', status: 'already_finished' }, capture)
  try {
    const result = await interruptSubagent('sub/abc')
    assert.equal(result.status, 'already_finished')
    assert.ok(String(capture.url).includes(encodeURIComponent('sub/abc')))
  } finally {
    restore()
  }
})

test('an old backend 404 surfaces as an ApiError with the capability status', async () => {
  const capture: FetchCapture = {}
  const restore = stubFetch(404, { detail: 'Not Found' }, capture)
  try {
    await assert.rejects(interruptSubagent('sub-abc12345'), (error: unknown) => {
      assert.ok(error instanceof ApiError)
      assert.equal(error.status, 404)
      assert.equal(isMissingSubagentControlRoute(error.status), true)
      return true
    })
  } finally {
    restore()
  }
})

// ---------------------------------------------------------------------------
// session capability latch + exact copy
// ---------------------------------------------------------------------------

test('the unsupported notice is one sentence and the latch is session-scoped', () => {
  resetSubagentControlsAvailability()
  assert.equal(subagentControlsUnavailable(), false)
  assert.equal(isMissingSubagentControlRoute(undefined), false)
  assert.equal(isMissingSubagentControlRoute(500), false)
  assert.equal(isMissingSubagentControlRoute(404), true)
  markSubagentControlsUnavailable()
  assert.equal(subagentControlsUnavailable(), true)
  // The exact sentence the drawer shows instead of crashing the transcript.
  assert.equal(
    SUBAGENT_CONTROLS_UNSUPPORTED_NOTICE,
    'This backend does not support helper controls.',
  )
  resetSubagentControlsAvailability()
  assert.equal(subagentControlsUnavailable(), false)
})

test('an accepted interrupt shows no notice; an already-finished helper says so', () => {
  assert.equal(subagentInterruptNotice('interrupting'), null)
  assert.equal(subagentInterruptNotice('already_finished'), 'The helper had already finished.')
})

// ---------------------------------------------------------------------------
// approval card: a cancellation reason never hides the real reason (R11)
// ---------------------------------------------------------------------------

test('an interrupted resolution keeps the request reason on the card', () => {
  const item = approvalItem('matches sensitive file pattern .env', {
    decision: 'deny',
    reason: 'interrupted',
  })
  assert.equal(item.decision, 'deny')
  assert.equal(item.reason, 'matches sensitive file pattern .env')
})

test('a run-stop resolution also keeps the request reason', () => {
  const item = approvalItem('matches sensitive file pattern .env', {
    decision: 'deny',
    reason: 'cancelled',
  })
  assert.equal(item.reason, 'matches sensitive file pattern .env')
})

test('a non-cancellation explicit reason still wins, and a bare deny keeps the request reason', () => {
  assert.equal(
    approvalItem('sensitive path', { decision: 'deny', reason: 'denied by policy' }).reason,
    'denied by policy',
  )
  assert.equal(approvalItem('sensitive path', { decision: 'deny' }).reason, 'sensitive path')
  assert.equal(approvalItem(undefined, { decision: 'deny', reason: 'interrupted' }).reason, undefined)
})

// ---------------------------------------------------------------------------
// tree fold + drawable status from the existing event
// ---------------------------------------------------------------------------

test('a cancelled subagent_completed with cancelled_by folds like any terminal event', () => {
  const cancelled = applySubagentEvent([childRow()], {
    type: 'subagent_completed',
    subagent_id: 'sub-12345678',
    label: 'Write the helper file',
    status: 'cancelled',
    error: 'interrupted by the operator',
    duration_ms: 12,
    ended_at: 1_012,
    cancelled_by: 'operator',
    run_id: 'run-1',
    at: 1_012,
  })
  assert.equal(cancelled[0]?.status, 'cancelled')
  assert.equal(cancelled[0]?.error, 'interrupted by the operator')
  assert.equal(cancelled[0]?.ended_at, 1_012)
  // An old backend's cancelled event (no cancelled_by) folds identically.
  const legacy = applySubagentEvent([childRow()], {
    type: 'subagent_completed',
    subagent_id: 'sub-12345678',
    label: 'Write the helper file',
    status: 'cancelled',
    duration_ms: 12,
    ended_at: 1_012,
    run_id: 'run-1',
    at: 1_012,
  })
  assert.equal(legacy[0]?.status, 'cancelled')
})

// ---------------------------------------------------------------------------
// drawer template: one quiet Stop button, no nested tree buttons (R9)
// ---------------------------------------------------------------------------

test('the Stop control lives only in the drawer header', () => {
  const view = read('components/SubagentView.vue')
  assert.ok(view.includes('Stop helper'))
  assert.ok(view.includes('Stopping…'))
  assert.ok(view.includes('aria-label="Stop this helper"'))
  assert.ok(view.includes("from 'naive-ui'"))
  assert.ok(view.includes('interruptSubagent'))
  assert.equal(/v-html\s*=/.test(view), false, 'the drawer renders plain text only')
  // The control is gated on a live child and hidden once the backend lacks it.
  assert.ok(view.includes("props.detail?.status === 'running'"))
  assert.ok(view.includes('controlsUnavailable'))
  // Tree rows in App.vue stay simple buttons; no nested interactive element.
  const app = read('App.vue')
  assert.ok(app.includes('class="subagent-tree-row"'))
  assert.ok(/<button[\s\S]{0,400}class="subagent-tree-row"/.test(app))
  assert.ok(/<NButton|class="subagent-view-actions"/.test(view))
})
