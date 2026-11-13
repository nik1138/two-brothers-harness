/**
 * Operator helper controls in the web shell (slices A1 + A2): the interrupt and
 * follow-up request paths, the old-backend 404 capability latch and its inline
 * notice, the cancellation-reason fix that keeps an approval card's own reason,
 * and the follow-up composer's queued-only copy and origin labels.
 *
 * No DOM: pure modules + source assertions for the drawer template (vue-tsc
 * covers the template types in `npm run build`).
 *   node --import ./tests/register-ts.mjs --test tests/subagentControls.test.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { ApiError, interruptSubagent, sendSubagentMessage } from '../src/api.ts'
import { projectRuntimeEvents, resetRuntimeProjection } from '../src/runtime.ts'
import type { ApprovalItem } from '../src/runtime.ts'
import {
  SUBAGENT_CONTROLS_UNSUPPORTED_NOTICE,
  SUBAGENT_FOLLOWUP_MAX_CHARS,
  canSendSubagentFollowUp,
  isMissingSubagentControlRoute,
  markSubagentControlsUnavailable,
  resetSubagentControlsAvailability,
  subagentControlsUnavailable,
  subagentFollowUpNotice,
  subagentInterruptNotice,
} from '../src/subagentControls.ts'
import {
  applySubagentDetailEvent,
  applySubagentEvent,
  normalizeSubagentDetail,
  normalizeSubagentInfo,
  subagentBackgroundLabel,
  subagentMessageLabel,
} from '../src/subagents.ts'
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

// ---------------------------------------------------------------------------
// A2: follow-up request path, queued-only copy and origin labels
// ---------------------------------------------------------------------------

test('sendSubagentMessage POSTs the child-keyed messages route and reports pending', async () => {
  const capture: FetchCapture = {}
  const restore = stubFetch(200, { subagent_id: 'sub-abc12345', status: 'queued', pending: 2 }, capture)
  try {
    const result = await sendSubagentMessage('sub-abc12345', 'Prefer notes.txt.')
    assert.deepEqual(result, { subagent_id: 'sub-abc12345', status: 'queued', pending: 2 })
    assert.equal(capture.init?.method, 'POST')
    assert.match(String(capture.url), /\/api\/subagents\/sub-abc12345\/messages$/)
    assert.equal(String(capture.init?.body), JSON.stringify({ text: 'Prefer notes.txt.' }))
  } finally {
    restore()
  }
})

test('a full queue 409 surfaces the server detail; a 404 is the capability signal', async () => {
  const restore = stubFetch(409, { detail: 'follow-up queue is full (8 pending)' }, {})
  try {
    await assert.rejects(sendSubagentMessage('sub-abc12345', 'hi'), (error: unknown) => {
      assert.ok(error instanceof ApiError)
      assert.equal(error.status, 409)
      assert.equal(error.message, 'follow-up queue is full (8 pending)')
      // Only a 404 means "old backend", never an honest refusal.
      assert.equal(isMissingSubagentControlRoute(error.status), false)
      return true
    })
  } finally {
    restore()
  }
  const restoreOld = stubFetch(404, { detail: 'Not Found' }, {})
  try {
    await assert.rejects(sendSubagentMessage('sub-abc12345', 'hi'), (error: unknown) => {
      assert.ok(error instanceof ApiError)
      assert.equal(isMissingSubagentControlRoute(error.status), true)
      return true
    })
  } finally {
    restoreOld()
  }
})

test('the follow-up is queued, never delivered, and only a live helper can receive one', () => {
  assert.equal(
    subagentFollowUpNotice(2),
    'queued — delivered at the helper\'s next step (2 pending)',
  )
  assert.equal(SUBAGENT_FOLLOWUP_MAX_CHARS, 4_000)
  assert.equal(canSendSubagentFollowUp('running'), true)
  assert.equal(canSendSubagentFollowUp('completed'), false)
  assert.equal(canSendSubagentFollowUp('failed'), false)
  assert.equal(canSendSubagentFollowUp('cancelled'), false)
})

test('user rows are labeled Task / Follow-up · operator / Follow-up · Senior', () => {
  assert.equal(subagentMessageLabel({ role: 'user' }), 'Task')
  assert.equal(subagentMessageLabel({ role: 'user', origin: 'operator' }), 'Follow-up · operator')
  assert.equal(subagentMessageLabel({ role: 'user', origin: 'senior' }), 'Follow-up · Senior')
  assert.equal(subagentMessageLabel({ role: 'assistant' }), 'Helper')
})

test('the reader accepts the additive origin and tolerates unknown/missing values', () => {
  const detail = normalizeSubagentDetail({
    id: 'sub-12345678',
    parent_session: 'parent.jsonl',
    label: 'Helper',
    role: 'junior',
    model: 'm',
    task: 't',
    status: 'completed',
    started_at: 1,
    transcript: [
      { type: 'message', role: 'user', text: 'do it', at: 2 },
      { type: 'message', role: 'user', origin: 'operator', text: 'prefer x', at: 3 },
      { type: 'message', role: 'user', origin: 'someone', text: 'unknown sender', at: 4 },
      { type: 'message', role: 'assistant', text: 'done', at: 5 },
    ],
  })
  assert.ok(detail)
  assert.equal(detail.transcript[0]?.type === 'message' ? detail.transcript[0].origin : 'x', undefined)
  assert.equal(detail.transcript[1]?.type === 'message' ? detail.transcript[1].origin : '', 'operator')
  assert.equal(detail.transcript[2]?.type === 'message' ? detail.transcript[2].origin : 'x', undefined)
})

// ---------------------------------------------------------------------------
// A2 drawer template: composer exists, sends on Enter, keeps a typed draft
// ---------------------------------------------------------------------------

test('the drawer follow-up field is queued-only, live-only and Escape-safe', () => {
  const view = read('components/SubagentView.vue')
  assert.ok(view.includes('aria-label="Follow-up message"'))
  assert.ok(view.includes('sendSubagentMessage'))
  assert.ok(view.includes('subagentFollowUpNotice'))
  assert.ok(view.includes('hasFollowUpDraft'))
  assert.ok(view.includes('defineExpose'))
  // Enter sends; the textarea stays one line by default.
  assert.ok(view.includes('@keydown="onFollowUpKeydown"'))
  assert.ok(view.includes("event.key !== 'Enter'"))
  assert.ok(view.includes('event.shiftKey'))
  // Disabled while the local request is in flight, never for a settled child.
  assert.ok(view.includes('sendingFollowUp'))
  assert.ok(view.includes('canSendSubagentFollowUp'))
  // The same 404 latch hides the whole control family on an old backend.
  assert.ok(view.includes('markSubagentControlsUnavailable'))
  assert.equal(/v-html\s*=/.test(view), false)

  const app = read('App.vue')
  assert.ok(app.includes('subagentFollowUpDraftOpen'))
  assert.ok(app.includes('ref="subagentViewRef"'))
  assert.ok(app.includes('hasFollowUpDraft'))
  // A drawer-handled Escape never arms the double-Escape stop gesture.
  assert.match(app, /function onSubagentEscape[\s\S]{0,700}lastEscapeAt = null/)
  // Tree rows stay plain buttons (no nested interactive elements).
  assert.ok(/<button[\s\S]{0,400}class="subagent-tree-row"/.test(app))
})

// ---------------------------------------------------------------------------
// Slice B: the drawer Background badge is additive and optional
// ---------------------------------------------------------------------------

test('the background flag is additive: only an explicit true reaches the row', () => {
  const base = {
    id: 'sub-abc12345',
    parent_session: 's.jsonl',
    label: 'Notes',
    status: 'running',
    started_at: 1,
  }
  const sync = normalizeSubagentInfo({ ...base })
  assert.ok(sync)
  assert.equal('background' in sync, false, 'a sync row gains no key')
  assert.equal(subagentBackgroundLabel(sync), '')

  const background = normalizeSubagentInfo({ ...base, background: true })
  assert.ok(background)
  assert.equal(background.background, true)
  assert.equal(subagentBackgroundLabel(background), 'Background')

  // A non-boolean or false value never becomes a badge.
  for (const value of [false, 'true', 1, null, {}]) {
    const row = normalizeSubagentInfo({ ...base, background: value })
    assert.ok(row)
    assert.equal('background' in row, false, `background ${JSON.stringify(value)}`)
    assert.equal(subagentBackgroundLabel(row), '')
  }
  assert.equal(subagentBackgroundLabel(null), '')

  // The loaded detail carries it through (the badge reads the detail).
  const detail = normalizeSubagentDetail({
    ...base,
    background: true,
    transcript: [{ type: 'message', role: 'assistant', text: 'done', at: 2 }],
  })
  assert.equal(detail?.background, true)
  assert.equal(subagentBackgroundLabel(detail), 'Background')
})

test('a live background started event marks the row and the open drawer keeps it', () => {
  const legacy = applySubagentEvent([], {
    type: 'subagent_started',
    subagent_id: 'sub-abc12345',
    label: 'Notes',
    role: 'junior',
    model: 'junior',
    task: 'read',
    started_at: 1,
    run_id: 'run-1',
    at: 1,
  } as RunEvent)
  assert.equal(legacy.length, 1)
  assert.equal('background' in (legacy[0] ?? {}), false, 'an old event invents no flag')

  const bg = applySubagentEvent([], {
    type: 'subagent_started',
    subagent_id: 'sub-abc12346',
    label: 'Notes',
    role: 'junior',
    model: 'junior',
    task: 'read',
    started_at: 1,
    background: true,
    run_id: 'run-1',
    at: 1,
  } as RunEvent)
  assert.equal(bg[0]?.background, true)

  const detail = normalizeSubagentDetail({
    id: 'sub-abc12346',
    parent_session: 's.jsonl',
    label: 'Notes',
    status: 'running',
    started_at: 1,
    background: true,
    transcript: [],
  })
  assert.ok(detail)
  const next = applySubagentDetailEvent(detail, {
    type: 'subagent_activity',
    subagent_id: 'sub-abc12346',
    label: 'Notes',
    activity: 'status',
    status: 'running',
    run_id: 'run-1',
    at: 2,
  } as RunEvent)
  assert.equal(next.background, true)
})

test('the drawer header renders the Background badge from the loaded detail', () => {
  const view = read('components/SubagentView.vue')
  assert.ok(view.includes('subagentBackgroundLabel'))
  assert.ok(view.includes('subagent-background-badge'))
  assert.ok(view.includes('v-if="backgroundLabel"'))
  // The badge is a quiet marker next to the status, never a second status.
  assert.ok(view.includes('{{ backgroundLabel }}'))
  assert.equal(/v-html\s*=/.test(view), false)
})
