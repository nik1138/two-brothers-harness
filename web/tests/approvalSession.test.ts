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
