/**
 * Unit tests for the pure mid-run steering model (`web/src/steering.ts`).
 *
 * The web composer offers an explicit "Steer run" action only while the
 * followed run is active (running, or parked on an approval); the text is
 * applied at the run's next step, never queued as a task, and the confirmation
 * never pretends it was delivered immediately. These tests pin the decision
 * logic and the operator-facing copy — no DOM, no backend.
 *
 * Run with: node --import ./tests/register-ts.mjs --test tests/steering.test.ts
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  STEER_MAX_CHARS,
  STEERABLE_RUN_STATUSES,
  canSteerText,
  clampSteerPending,
  isSteerableStatus,
  steerAvailability,
  steerFailureNotice,
  steerHelp,
  steeredNotice,
  steerTextError,
} from '../src/steering'

test('only running and waiting runs can take a steer (queued/terminal cannot)', () => {
  assert.deepEqual([...STEERABLE_RUN_STATUSES], ['running', 'waiting'])
  for (const status of ['running', 'waiting']) {
    assert.equal(isSteerableStatus(status), true, status)
  }
  // A queued run has no cooperation cycle yet; terminal runs are over. The
  // backend honestly answers 409 for these, so the web must not offer them.
  for (const status of ['queued', 'completed', 'failed', 'cancelled', '', 'nope']) {
    assert.equal(isSteerableStatus(status), false, status)
  }
  assert.equal(isSteerableStatus(null), false)
  assert.equal(isSteerableStatus(undefined), false)
})

test('steerAvailability hides the control without a steerable run', () => {
  for (const run of [null, undefined, { run_id: 'r1', status: 'queued' }, { run_id: 'r1', status: 'completed' }]) {
    const view = steerAvailability(run)
    assert.equal(view.visible, false)
    assert.equal(view.status, null)
    assert.match(view.help, /working or waiting on an approval/)
  }

  const running = steerAvailability({ run_id: 'r1', status: 'running' })
  assert.deepEqual(
    { visible: running.visible, status: running.status },
    { visible: true, status: 'running' },
  )
  // The help text says where the text lands — the run's next step, not "now".
  assert.match(running.help, /next step/)
  assert.match(running.help, /does not start a new task/)

  const waiting = steerAvailability({ run_id: 'r1', status: 'waiting' })
  assert.deepEqual({ visible: waiting.visible, status: waiting.status }, { visible: true, status: 'waiting' })
  assert.match(waiting.help, /after the pending approval resolves/)
  assert.match(waiting.help, /does not start a new task/)

  assert.match(steerHelp('running'), /running run at its next step/)
  assert.match(steerHelp('waiting'), /approval resolves/)
})

test('steerTextError mirrors the backend 400s (empty and over the limit)', () => {
  assert.equal(STEER_MAX_CHARS, 4000)
  assert.equal(steerTextError(''), 'Type a message to steer the run with.')
  assert.equal(steerTextError('   \n\t '), 'Type a message to steer the run with.')
  assert.equal(steerTextError(null), 'Type a message to steer the run with.')
  assert.equal(steerTextError(undefined), 'Type a message to steer the run with.')
  assert.equal(steerTextError('  focus on the tests  '), null)
  assert.equal(steerTextError('x'.repeat(STEER_MAX_CHARS)), null, 'the limit itself is accepted')
  assert.match(
    steerTextError('x'.repeat(STEER_MAX_CHARS + 1)) ?? '',
    /limited to 4000 characters/,
  )

  assert.equal(canSteerText('  keep going  '), true)
  assert.equal(canSteerText('   '), false)
  assert.equal(canSteerText(null), false)
  assert.equal(canSteerText('x'.repeat(STEER_MAX_CHARS + 1)), false)
})

test('clampSteerPending keeps the echoed pending count honest and bounded', () => {
  assert.equal(clampSteerPending(undefined), 0)
  assert.equal(clampSteerPending(null), 0)
  assert.equal(clampSteerPending('3'), 0)
  assert.equal(clampSteerPending(Number.NaN), 0)
  assert.equal(clampSteerPending(-2), 0)
  assert.equal(clampSteerPending(3.9), 3)
  assert.equal(clampSteerPending(8), 8)
  assert.equal(clampSteerPending(99), 8, 'never claims more than the backend queue cap')
})

test('the accepted confirmation says queued for the next step, never "delivered"', () => {
  const one = steeredNotice({ pending: 1 })
  assert.equal(one, "Steer queued — it is applied at the run's next step.")
  assert.match(one, /next step/)
  assert.doesNotMatch(one, /delivered|sent/i)

  const many = steeredNotice({ pending: 3 })
  assert.match(many, /\(3 steering messages pending\)/)
  assert.match(many, /next step/)
  // Missing/unknown pending info still produces an honest sentence.
  assert.equal(steeredNotice(null), "Steer queued — it is applied at the run's next step.")
})

test('rejected steers are reported honestly (backend detail wins)', () => {
  assert.match(steerFailureNotice({ status: 0 }), /unreachable/)
  assert.match(steerFailureNotice(null), /unreachable/)
  assert.equal(
    steerFailureNotice({ status: 400, detail: 'text is too long (max 4000 chars)' }),
    'text is too long (max 4000 chars)',
  )
  assert.match(steerFailureNotice({ status: 400 }), /rejected/)
  assert.match(steerFailureNotice({ status: 404 }), /no longer known/)
  assert.equal(
    steerFailureNotice({ status: 409, detail: 'run is completed; steering applies only…' }),
    'run is completed; steering applies only…',
  )
  assert.match(steerFailureNotice({ status: 409 }), /cannot take steering right now/)
  assert.equal(steerFailureNotice({ status: 500, detail: 'boom' }), 'boom')
  assert.match(steerFailureNotice({ status: 500 }), /HTTP 500/)
})
