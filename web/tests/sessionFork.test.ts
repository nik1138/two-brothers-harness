/**
 * Unit tests for the pure session-fork client model (`web/src/sessionFork.ts`):
 * availability (never fork an active session), the optional request body, and
 * the honest success/failure copy. No DOM, no backend.
 *
 * Run with: node --import ./tests/register-ts.mjs --test tests/sessionFork.test.ts
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  FORK_MENU_HINT,
  FORK_MENU_LABEL,
  forkAvailability,
  forkFailureNotice,
  forkRequestBody,
  forkSuccessNotice,
} from '../src/sessionFork'

test('fork availability: available only for a quiescent, idle row', () => {
  assert.deepEqual(forkAvailability(null), { available: true, reason: null })
  assert.deepEqual(forkAvailability(undefined), { available: true, reason: null })
  assert.deepEqual(forkAvailability({ live: false }), { available: true, reason: null })

  // A run active on the session blocks the fork with an actionable reason.
  const live = forkAvailability({ live: true })
  assert.equal(live.available, false)
  assert.match(live.reason ?? '', /while a run is active/)
  assert.match(live.reason ?? '', /Stop the run first/)

  // A row with another action in flight defers rather than double-submitting.
  const busy = forkAvailability({ busy: true })
  assert.equal(busy.available, false)
  assert.match(busy.reason ?? '', /still running/)
  assert.equal(forkAvailability({ busy: true, live: true }).available, false)
})

test('the menu action forks at the end: an empty body, no fake seq/name', () => {
  assert.deepEqual(forkRequestBody(), {})
  assert.deepEqual(forkRequestBody({ seq: null, name: null }), {})
  assert.deepEqual(forkRequestBody({ seq: undefined, name: '   ' }), {})
  // invalid depths are omitted (the server owns the 400; the menu never sends one)
  assert.deepEqual(forkRequestBody({ seq: 0 }), {})
  assert.deepEqual(forkRequestBody({ seq: -1 }), {})
  assert.deepEqual(forkRequestBody({ seq: 1.5 }), {})
  // explicit caller options pass through trimmed/validated
  assert.deepEqual(forkRequestBody({ seq: 7 }), { seq: 7 })
  assert.deepEqual(forkRequestBody({ name: ' my-fork ' }), { name: 'my-fork' })
  assert.deepEqual(forkRequestBody({ seq: 3, name: 'x' }), { seq: 3, name: 'x' })
})

test('success copy names the new session, the count and the untouched original', () => {
  const notice = forkSuccessNotice({ name: 'chat-fork-1.jsonl', events: 5 }, 'chat.jsonl')
  assert.match(notice, /Forked from chat\.jsonl to chat-fork-1\.jsonl/)
  assert.match(notice, /5 envelopes copied/)
  assert.match(notice, /the original session is untouched/)

  assert.match(forkSuccessNotice({ name: 'a.jsonl', events: 1 }), /1 envelope copied/)
  // defensive: a malformed result never fabricates a count
  assert.match(forkSuccessNotice({ name: '', events: Number.NaN }), /the new session/)
  assert.match(forkSuccessNotice(null), /0 envelopes copied/)
})

test('failure copy maps the documented route contract honestly', () => {
  assert.match(forkFailureNotice({ status: 0 }), /unreachable/)
  assert.equal(
    forkFailureNotice({ status: 400, detail: 'invalid session name: ../x' }),
    'invalid session name: ../x',
  )
  assert.match(forkFailureNotice({ status: 400 }), /fork request was rejected/)
  assert.match(forkFailureNotice({ status: 404 }), /no longer known/)
  assert.equal(
    forkFailureNotice({ status: 409, detail: 'session already exists: chat-fork-1.jsonl' }),
    'session already exists: chat-fork-1.jsonl',
  )
  assert.match(forkFailureNotice({ status: 409 }), /already exists/)
  assert.match(forkFailureNotice({ status: 422 }), /corrupt/)
  assert.match(forkFailureNotice({ status: 500 }), /HTTP 500/)
})

test('the menu copy is honest and stable', () => {
  assert.equal(FORK_MENU_LABEL, 'Fork session…')
  assert.match(FORK_MENU_HINT, /copies the conversation into a new session/i)
  assert.match(FORK_MENU_HINT, /original is untouched/)
})
