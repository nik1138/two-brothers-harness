// Session-scope operator approvals in the web client: the additive `scope`
// request field, the honest applied-scope resolution (an older backend that
// ignored the field must never be reported as a session allow), and the
// answer request/response contract. No DOM:
//   node --import ./tests/register-ts.mjs --test tests/approvalSession.test.ts

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  answerRunApproval,
  appliedApprovalScope,
  approvalOutcomeNotice,
} from '../src/api.ts'
import {
  APPROVAL_PREVIEW_MAX_CHARS,
  approvalDetailOf,
  approvalPreviewCounts,
  approvalPreviewOf,
  projectRuntimeEvents,
  resetRuntimeProjection,
} from '../src/runtime.ts'
import type { ApprovalItem } from '../src/runtime.ts'
import type { RunEvent } from '../src/types.ts'

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

interface FetchCapture {
  url?: string
  init?: RequestInit
}

/** Stub the global fetch with one JSON response; returns the restore fn. */
function stubFetch(responseBody: unknown, capture: FetchCapture): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    capture.url = String(input)
    capture.init = init
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch
  return () => {
    globalThis.fetch = original
  }
}

function sentBody(capture: FetchCapture): unknown {
  return JSON.parse(String(capture.init?.body))
}

// ---------------------------------------------------------------------------
// applied scope resolution: never guess a session allow
// ---------------------------------------------------------------------------

test('appliedApprovalScope only trusts an explicit session echo', () => {
  assert.equal(appliedApprovalScope({ scope: 'session' }), 'session')
  assert.equal(appliedApprovalScope({ scope: 'once' }), 'once')
})

test('a missing, unknown or malformed scope is honestly one-shot', () => {
  // The older backend ignores the additive field and answers once: its
  // response carries no `scope` at all.
  assert.equal(appliedApprovalScope({}), 'once')
  assert.equal(appliedApprovalScope(null), 'once')
  assert.equal(appliedApprovalScope(undefined), 'once')
  // Anything that is not the strict string is never upgraded to session scope.
  assert.equal(appliedApprovalScope({ scope: 'always' }), 'once')
  assert.equal(appliedApprovalScope({ scope: 'SESSION' }), 'once')
  assert.equal(appliedApprovalScope({ scope: 1 }), 'once')
  assert.equal(appliedApprovalScope({ scope: null }), 'once')
})

test('approvalOutcomeNotice stays silent for plain one-shot answers', () => {
  assert.equal(approvalOutcomeNotice('once', 'once'), null)
  // A one-shot request can never claim a session scope either.
  assert.equal(approvalOutcomeNotice('once', 'session'), null)
})

test('approvalOutcomeNotice is honest for a session request', () => {
  const applied = approvalOutcomeNotice('session', 'session')
  assert.ok(applied !== null)
  assert.match(applied, /allowed for this session/i)

  // The unsupported-backend fallback says exactly what happened: allowed once.
  const fallback = approvalOutcomeNotice('session', 'once')
  assert.equal(fallback, 'Allowed once — this backend does not support session scope.')
  assert.doesNotMatch(fallback ?? '', /for this session/i)
})

// ---------------------------------------------------------------------------
// request/response contract
// ---------------------------------------------------------------------------

test('answerRunApproval sends the additive scope and returns the applied one', async () => {
  const capture: FetchCapture = {}
  const restore = stubFetch(
    { approval_id: 'ap1', decision: 'allow', scope: 'session' },
    capture,
  )
  try {
    const res = await answerRunApproval('run1', 'ap1', { allow: true, scope: 'session' })
    assert.equal(res.approval_id, 'ap1')
    assert.equal(res.decision, 'allow')
    assert.equal(appliedApprovalScope(res), 'session')
    assert.deepEqual(sentBody(capture), { allow: true, scope: 'session' })
    assert.match(String(capture.url), /\/api\/runs\/run1\/approvals\/ap1$/)
    assert.equal(capture.init?.method, 'POST')
    const headers = capture.init?.headers as Record<string, string>
    assert.equal(headers['Content-Type'], 'application/json')
  } finally {
    restore()
  }
})

test('a plain allow sends no scope (old default behavior)', async () => {
  const capture: FetchCapture = {}
  const restore = stubFetch({ approval_id: 'ap2', decision: 'allow' }, capture)
  try {
    const res = await answerRunApproval('run1', 'ap2', { allow: true })
    assert.deepEqual(sentBody(capture), { allow: true })
    assert.equal(appliedApprovalScope(res), 'once')
    assert.equal(
      approvalOutcomeNotice('session', appliedApprovalScope(res)),
      'Allowed once — this backend does not support session scope.',
    )
  } finally {
    restore()
  }
})

test('a deny answer carries no session scope', async () => {
  const capture: FetchCapture = {}
  const restore = stubFetch({ approval_id: 'ap3', decision: 'deny', scope: 'once' }, capture)
  try {
    const res = await answerRunApproval('run1', 'ap3', { allow: false })
    assert.equal(res.decision, 'deny')
    assert.deepEqual(sentBody(capture), { allow: false })
    assert.equal(appliedApprovalScope(res), 'once')
  } finally {
    restore()
  }
})

test('an HTTP failure still rejects as an ApiError (no false success)', async () => {
  const original = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ detail: 'scope session requires allow' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch
  try {
    await assert.rejects(
      () => answerRunApproval('run1', 'ap4', { allow: false, scope: 'session' }),
      (err: unknown) =>
        err instanceof Error &&
        err.name === 'ApiError' &&
        /scope session requires allow/.test(err.message),
    )
  } finally {
    globalThis.fetch = original
  }
})

// ---------------------------------------------------------------------------
// additive approval detail: tolerant projection + plain-text preview
// ---------------------------------------------------------------------------

/** One `approval_requested` runtime event; `detail` omitted when undefined. */
function requested(detail?: unknown, overrides: Record<string, unknown> = {}): RunEvent {
  const event: Record<string, unknown> = {
    type: 'approval_requested',
    approval_id: 'ap-detail-1',
    action: 'write',
    target: 'src/app.ts',
    run_id: 'run-1',
    at: 10,
    ...overrides,
  }
  if (detail !== undefined) event.detail = detail
  return event as unknown as RunEvent
}

/** One `approval_resolved` runtime event; `reason` omitted when undefined. */
function resolved(overrides: Record<string, unknown> = {}): RunEvent {
  return {
    type: 'approval_resolved',
    approval_id: 'ap-detail-1',
    decision: 'allow',
    run_id: 'run-1',
    at: 11,
    ...overrides,
  } as unknown as RunEvent
}

/** Project a fresh event list and return the approval items. */
function approvalsOf(events: RunEvent[]): ApprovalItem[] {
  resetRuntimeProjection([])
  return projectRuntimeEvents(events).filter(
    (item): item is ApprovalItem => item.type === 'approval',
  )
}

const WRITE_DETAIL = {
  kind: 'write',
  diff: '--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old line\n+new line',
  addedLines: 3,
  removedLines: 1,
}

test('approvalDetailOf keeps the additive preview and drops unknown fields', () => {
  assert.deepEqual(approvalDetailOf({ ...WRITE_DETAIL, extra: 'nope' }), WRITE_DETAIL)
  assert.deepEqual(approvalDetailOf({ kind: 'shell', command: 'git status --short' }), {
    kind: 'shell',
    command: 'git status --short',
  })
  assert.deepEqual(approvalDetailOf({ ...WRITE_DETAIL, truncated: true }), {
    ...WRITE_DETAIL,
    truncated: true,
  })
})

test('approvalDetailOf is tolerant: absent and malformed details become undefined', () => {
  for (const missing of [undefined, null, [], 'detail', 42, {}, { kind: '' }, { kind: 7 }]) {
    assert.equal(approvalDetailOf(missing), undefined, JSON.stringify(missing))
  }
  // Valid fields survive; invalid ones are dropped instead of failing the card.
  assert.deepEqual(
    approvalDetailOf({
      kind: ' write ',
      diff: 42,
      command: null,
      addedLines: '3',
      removedLines: -2,
      truncated: 'yes',
    }),
    { kind: 'write' },
  )
  // An out-of-range count is dropped, a valid zero is kept.
  assert.deepEqual(approvalDetailOf({ kind: 'edit', addedLines: 0, removedLines: 1.9 }), {
    kind: 'edit',
    addedLines: 0,
    removedLines: 1,
  })
})

test('approvalDetailOf bounds a huge diff/command so the DOM stays bounded', () => {
  const huge = approvalDetailOf({
    kind: 'write',
    diff: 'a'.repeat(APPROVAL_PREVIEW_MAX_CHARS + 50),
    command: 'b'.repeat(APPROVAL_PREVIEW_MAX_CHARS + 50),
  })
  assert.ok(huge !== undefined)
  assert.equal(huge.diff?.length, APPROVAL_PREVIEW_MAX_CHARS)
  assert.equal(huge.command?.length, APPROVAL_PREVIEW_MAX_CHARS)
  assert.equal(huge.truncated, true)
})

test('approvalPreviewOf renders a command for shell and a diff/counts for changes', () => {
  assert.deepEqual(approvalPreviewOf({ kind: 'shell', command: 'rm -rf build' }), {
    kind: 'shell',
    text: 'rm -rf build',
    truncated: false,
    noun: 'command',
  })
  assert.equal(approvalPreviewCounts(approvalPreviewOf({ kind: 'shell', command: 'x' })!), '')

  const change = approvalPreviewOf(WRITE_DETAIL)
  assert.ok(change !== null)
  assert.equal(change.noun, 'change')
  assert.equal(change.text, WRITE_DETAIL.diff)
  assert.equal(change.added, 3)
  assert.equal(change.removed, 1)
  assert.equal(change.truncated, false)
  assert.equal(approvalPreviewCounts(change), '+3 -1')

  // Nothing renderable: no detail, unknown shape, or a detail without text.
  for (const empty of [undefined, null, {}, { kind: 'write' }, { kind: 'write', diff: '   ' }]) {
    assert.equal(approvalPreviewOf(empty), null, JSON.stringify(empty))
  }
})

test('the runtime projection carries the detail (and old backends keep no field)', () => {
  const [withDetail] = approvalsOf([requested(WRITE_DETAIL)])
  assert.equal(withDetail.approvalId, 'ap-detail-1')
  assert.deepEqual(withDetail.detail, WRITE_DETAIL)

  const [withoutDetail] = approvalsOf([requested()])
  assert.equal(withoutDetail.detail, undefined, 'no detail field when the backend omits it')

  const [malformed] = approvalsOf([requested({ kind: 7, diff: 'x' })])
  assert.equal(malformed.detail, undefined, 'an invalid detail never breaks the card')
})

test('last-writer semantics are unchanged: resolution keeps the pending detail', () => {
  const resolved: RunEvent = {
    type: 'approval_resolved',
    approval_id: 'ap-detail-1',
    decision: 'allow',
    run_id: 'run-1',
    at: 11,
  } as unknown as RunEvent
  const approvals = approvalsOf([requested(WRITE_DETAIL), resolved])
  assert.equal(approvals.length, 1)
  assert.equal(approvals[0].decision, 'allow')
  assert.deepEqual(approvals[0].detail, WRITE_DETAIL)
})

test('preview text is plain data: HTML-looking content round-trips verbatim (no HTML built)', () => {
  const hostile = '<img src=x onerror="alert(1)">\n<script>alert(2)</script>'
  const [item] = approvalsOf([
    requested({ kind: 'write', diff: hostile, addedLines: 2, removedLines: 0 }),
  ])
  // The projection never escapes or wraps the text: it stays the exact string
  // the backend sent, so rendering it via Vue's text interpolation (never
  // v-html) is the only consumer and no HTML sink receives it.
  assert.equal(item.detail?.diff, hostile)
  assert.ok(!item.detail?.diff?.includes('&lt;'))

  const preview = approvalPreviewOf(item.detail)
  assert.ok(preview !== null)
  assert.equal(preview.text, hostile)
  assert.ok(!preview.text.includes('&lt;'))
  assert.ok(!preview.text.includes('<pre'))
  assert.equal(approvalPreviewCounts(preview), '+2 -0')
})

// ---------------------------------------------------------------------------
// resolution keeps the request reason (the resolved card's honest note)
// ---------------------------------------------------------------------------

const REQUEST_REASON = 'matches sensitive file pattern .env'

test('Allow/Deny keeps the request reason on the resolved card', () => {
  for (const decision of ['allow', 'deny']) {
    const approvals = approvalsOf([
      requested(undefined, { reason: REQUEST_REASON }),
      resolved({ decision }),
    ])
    assert.equal(approvals.length, 1)
    assert.equal(approvals[0].decision, decision)
    assert.equal(
      approvals[0].reason,
      REQUEST_REASON,
      `${decision} resolution carries no reason and must keep the request's`,
    )
  }
})

test('a cancellation-class resolution keeps the request reason (the card stays honest)', () => {
  // Stopping the run (or interrupting the helper) resolves the wait, but the
  // cancellation is not WHY the action was requested: the card must keep
  // "matches sensitive file pattern .env" instead of the literal "cancelled".
  for (const reason of ['cancelled', 'interrupted']) {
    const approvals = approvalsOf([
      requested(undefined, { reason: REQUEST_REASON }),
      resolved({ decision: 'deny', reason }),
    ])
    assert.equal(approvals[0].decision, 'deny')
    assert.equal(approvals[0].reason, REQUEST_REASON)
  }
})

test('a non-cancellation resolution reason still wins when present', () => {
  const approvals = approvalsOf([
    requested(undefined, { reason: REQUEST_REASON }),
    resolved({ decision: 'deny', reason: 'denied by policy' }),
  ])
  assert.equal(approvals[0].reason, 'denied by policy')
})

test('no reason on either event stays undefined (nothing is invented)', () => {
  const approvals = approvalsOf([requested(), resolved({ decision: 'allow' })])
  assert.equal(approvals[0].reason, undefined)
})

test('the no-entry fallback only shows a reason the resolution actually carried', () => {
  // A resolved event without a prior request (partial/replayed sidecar) has no
  // request reason to preserve, so only the event's own reason can appear.
  const [withReason] = approvalsOf([resolved({ decision: 'deny', reason: 'cancelled' })])
  assert.equal(withReason.reason, 'cancelled')
  const [withoutReason] = approvalsOf([resolved({ decision: 'allow' })])
  assert.equal(withoutReason.reason, undefined)
})
