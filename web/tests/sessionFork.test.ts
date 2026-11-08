/**
 * Unit tests for the pure session-fork client model (`web/src/sessionFork.ts`):
 * availability (never fork an active session), the optional request body, and
 * the honest success/failure copy. No DOM, no backend.
 *
 * Run with: node --import ./tests/register-ts.mjs --test tests/sessionFork.test.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import {
  FORK_FROM_HERE_HINT,
  FORK_FROM_HERE_LABEL,
  FORK_MENU_HINT,
  FORK_MENU_LABEL,
  forkAvailability,
  forkFailureNotice,
  forkFromHereConfirmation,
  forkFromHerePoint,
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

test('fork-from-here selects only a valid operator message envelope', () => {
  assert.deepEqual(forkFromHerePoint({ kind: 'message', seq: 4 }), { seq: 4 })
  assert.deepEqual(forkFromHerePoint({ kind: 'message', seq: 1 }), { seq: 1 })

  // No bubble / no safe marker: nothing to fork at.
  assert.equal(forkFromHerePoint(null), null)
  assert.equal(forkFromHerePoint(undefined), null)
  assert.equal(forkFromHerePoint({ kind: 'message' }), null)
  assert.equal(forkFromHerePoint({ kind: 'consult', seq: 4 }), null)
  assert.equal(forkFromHerePoint({ kind: 'decision', seq: 4 }), null)
  assert.equal(forkFromHerePoint({ kind: 'message', seq: 0 }), null)
  assert.equal(forkFromHerePoint({ kind: 'message', seq: -1 }), null)
  assert.equal(forkFromHerePoint({ kind: 'message', seq: 1.5 }), null)
  assert.equal(forkFromHerePoint({ kind: 'message', seq: Number.NaN }), null)
})

test('fork-from-here request body always carries the clicked seq', () => {
  // The transcript action is a PREFIX fork: it never sends an empty body (that
  // would duplicate the session-row whole-session fork) and never invents a cut.
  const point = forkFromHerePoint({ kind: 'message', seq: 7 })
  assert.deepEqual(forkRequestBody({ seq: point?.seq }), { seq: 7 })
  assert.deepEqual(forkRequestBody({ seq: 7, name: '  ' }), { seq: 7 })
  assert.deepEqual(forkRequestBody({ seq: 7, name: ' branch ' }), { seq: 7, name: 'branch' })

  // A missing/invalid seq is omitted rather than guessed (the UI hides the
  // action for those bubbles, so this is a defensive boundary).
  assert.deepEqual(forkRequestBody({ seq: undefined }), {})
  assert.deepEqual(forkRequestBody({ seq: 0 }), {})
})

test('fork-from-here confirmation names the cut and the untouched source', () => {
  const copy = forkFromHereConfirmation({ seq: 12, session: 'chat.jsonl' })
  assert.match(copy, /^Copy chat\.jsonl through this message \(envelope 12\)/)
  assert.match(copy, /into a new session/)
  assert.match(copy, /the source is untouched/)

  // No session name still reads as "this session"; a bad seq never fabricates one.
  assert.match(forkFromHereConfirmation({ seq: 3 }), /^Copy this session through this message/)
  assert.match(forkFromHereConfirmation({ seq: 0 }), /through this message into a new session/)
  assert.doesNotMatch(forkFromHereConfirmation({ seq: 0 }), /envelope 0/)
})

test('the transcript action is wired source-level (no DOM harness in web tests)', () => {
  const chat = readFileSync(new URL('../src/components/ChatView.vue', import.meta.url), 'utf8')
  // Accessible action on operator message bubbles, with the pure resolver.
  assert.match(chat, /FORK_FROM_HERE_LABEL/)
  assert.match(chat, /forkFromHerePoint/)
  assert.match(chat, /class="bubble-copy bubble-fork"/)
  assert.match(chat, /props\.onForkFromHere\?\.\(m\.seq\)/)
  assert.match(chat, /forkFromHereFor\(point\.seq\)/)

  const app = readFileSync(new URL('../src/App.vue', import.meta.url), 'utf8')
  // The shell always asks for the clicked prefix and opens the named fork.
  assert.match(app, /forkSession\(target\.session, forkRequestBody\(\{ seq: target\.seq \}\)\)/)
  assert.match(app, /forkFromHereConfirmation\(forkFromHereTarget\)/)
  assert.match(app, /:on-fork-from-here="requestForkFromHere"/)

  // The existing session-row whole-session fork stays a separate, seq-less path.
  const row = readFileSync(new URL('../src/components/SessionRow.vue', import.meta.url), 'utf8')
  assert.match(row, /forkSession\(props\.session\.name, forkRequestBody\(\)\)/)
  assert.doesNotMatch(row, /forkRequestBody\(\{ seq:/)
})
