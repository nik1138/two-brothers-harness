/**
 * Unit tests for the pure session-rewind client model (`web/src/sessionRewind.ts`):
 * the operator-turn boundary rule (mirrored from the backend), the depth
 * derived from a clicked message, the destructive confirmation counts, and the
 * honest outcome/failure/clamp copy. No DOM, no backend.
 *
 * Run with: node --import ./tests/register-ts.mjs --test tests/sessionRewind.test.ts
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  ATTACHED_FILE_TAG,
  ATTACHED_SKILL_TAG,
  COMPACTION_SUMMARY_PREFIX,
  MAX_REWIND_TURNS,
  MIN_REWIND_TURNS,
  REPAIR_REQUEST_PREFIX,
  REWIND_QUOTE_MAX_CHARS,
  STEERING_PREFIX,
  isAttachedContextEnvelope,
  isCompactionSummaryEnvelope,
  isOperatorTurn,
  lastCompactionSummaryIndex,
  operatorTurnIndexes,
  rewindActionFor,
  rewindBlockedReason,
  rewindConfirmation,
  rewindFailureNotice,
  rewindOutcomeMatchesPreview,
  rewindOutcomeNotice,
  rewindPreview,
  rewindQuote,
  rewindTurnsForIndex,
  validateRewindTurns,
} from '../src/sessionRewind'
import type { Envelope } from '../src/types'

let nextSeq = 1
function event(partial: {
  from?: Envelope['from']
  to?: Envelope['to']
  kind?: Envelope['kind']
  text?: string | null
  seq?: number
}): Envelope {
  const payload: Record<string, unknown> = {}
  if (partial.text !== undefined && partial.text !== null) payload.text = partial.text
  const seq = partial.seq ?? nextSeq++
  return {
    v: 1,
    id: `id-${seq}`,
    seq,
    ts: '2026-11-08T00:00:00Z',
    from: partial.from ?? 'user',
    to: partial.to ?? 'senior',
    kind: partial.kind ?? 'message',
    payload,
  }
}

const task = (text: string) => event({ text })
const reply = (kind: Envelope['kind'], seq?: number) =>
  event({ from: 'senior', to: 'junior', kind, text: undefined, seq })

// ---------------------------------------------------------------------------
// boundary rule
// ---------------------------------------------------------------------------

test('the mirrored marker constants match the backend literals', () => {
  // packages/harness/src/compaction.ts::COMPACTION_SUMMARY_PREFIX
  assert.equal(
    COMPACTION_SUMMARY_PREFIX,
    'The conversation history before this point was compacted into the following summary:\n\n<summary>\n',
  )
  // packages/harness/src/payloads.ts / harness.ts / mentions.ts
  assert.equal(REPAIR_REQUEST_PREFIX, '[[REPAIR_REQUEST]]')
  assert.equal(STEERING_PREFIX, '[[OPERATOR STEER]] ')
  assert.equal(ATTACHED_SKILL_TAG, '<skill-loaded')
  assert.equal(ATTACHED_FILE_TAG, '<file ')
})

test('only real operator tasks are turn boundaries', () => {
  assert.equal(isOperatorTurn(task('build a catalog')), true)
  // harness-generated context is never a task boundary
  assert.equal(isOperatorTurn(task(`${COMPACTION_SUMMARY_PREFIX}sum</summary>`)), false)
  assert.equal(isOperatorTurn(task(`${REPAIR_REQUEST_PREFIX} fix the JSON`)), false)
  assert.equal(isOperatorTurn(task(`${STEERING_PREFIX}use Postgres`)), false)
  assert.equal(isOperatorTurn(task(`${ATTACHED_SKILL_TAG} name="x">body</skill-loaded>`)), false)
  assert.equal(isOperatorTurn(task('<file path="a.ts">\nbody\n</file>')), false)
  // not addressed to the senior / not a message / blank text / malformed
  assert.equal(isOperatorTurn(event({ to: 'junior', text: 'hi' })), false)
  assert.equal(isOperatorTurn(event({ kind: 'consult', text: 'hi' })), false)
  assert.equal(isOperatorTurn(task('   ')), false)
  assert.equal(isOperatorTurn(task(null)), false)
  assert.equal(isOperatorTurn(null), false)
  assert.equal(isOperatorTurn({}), false)
  assert.equal(isOperatorTurn({ from: 'user', kind: 'message', to: 'senior', payload: null }), false)
})

test('attached context and compaction summaries are classified for the cut rules', () => {
  assert.equal(isAttachedContextEnvelope(task(`${ATTACHED_SKILL_TAG} name="a">x</skill-loaded>`)), true)
  assert.equal(isAttachedContextEnvelope(task('<file path="a">x</file>')), true)
  assert.equal(isAttachedContextEnvelope(task('a real task')), false)
  assert.equal(isCompactionSummaryEnvelope(task(`${COMPACTION_SUMMARY_PREFIX}s</summary>`)), true)
  assert.equal(isCompactionSummaryEnvelope(task('a real task')), false)
  assert.equal(isCompactionSummaryEnvelope(null), false)
})

// ---------------------------------------------------------------------------
// index → depth
// ---------------------------------------------------------------------------

function consultSession(): { events: Envelope[]; operatorIndexes: number[] } {
  // 0 task1, 1 consult, 2 task2, 3 proposal, 4 task3, 5 review, 6 decision
  const events = [
    task('task one'),
    reply('consult'),
    task('task two'),
    reply('proposal'),
    task('task three'),
    reply('review'),
    reply('decision'),
  ]
  return { events, operatorIndexes: operatorTurnIndexes(events) }
}

test('operatorTurnIndexes finds the real tasks in file order', () => {
  const { events, operatorIndexes } = consultSession()
  assert.deepEqual(operatorIndexes, [0, 2, 4])
  assert.equal(lastCompactionSummaryIndex(events), -1)
  // generated context between tasks does not become a turn
  events.splice(2, 0, task(`${STEERING_PREFIX}prefer SQLite`))
  assert.deepEqual(operatorTurnIndexes(events), [0, 3, 5])
})

test('rewindTurnsForIndex derives the depth the backend expects', () => {
  const { events } = consultSession()
  assert.equal(rewindTurnsForIndex(events, 0), 3)
  assert.equal(rewindTurnsForIndex(events, 2), 2)
  assert.equal(rewindTurnsForIndex(events, 4), 1)
  // non-boundary indexes and out-of-range indexes have no depth
  assert.equal(rewindTurnsForIndex(events, 1), 0)
  assert.equal(rewindTurnsForIndex(events, -1), 0)
  assert.equal(rewindTurnsForIndex(events, events.length), 0)
})

// ---------------------------------------------------------------------------
// action / preview / confirmation
// ---------------------------------------------------------------------------

test('rewindActionFor offers the action only on removable operator turns', () => {
  const { events } = consultSession()
  const action = rewindActionFor(events, 2)
  assert.deepEqual(action, {
    index: 2,
    text: 'task two',
    turns: 2,
    removable: true,
    reason: null,
    blockedBy: null,
  })
  // non-operator envelopes have no action at all (the UI renders nothing)
  assert.equal(rewindActionFor(events, 1), null)
  assert.equal(rewindActionFor(events, 99), null)
})

test('rewindActionFor is honest about blocked states and the compaction floor', () => {
  const { events } = consultSession()
  const blocked = rewindActionFor(events, 4, { live: true })
  assert.match(blocked?.reason ?? '', /while a run is active/)
  assert.equal(blocked?.blockedBy, 'run-active')
  const compacting = rewindActionFor(events, 4, { compacting: true })
  assert.match(compacting?.reason ?? '', /being compacted/)
  assert.equal(compacting?.blockedBy, 'compacting')

  // A task at/before the last compaction summary is already folded into it.
  const compacted = [
    task('old task'),
    reply('consult'),
    task(`${COMPACTION_SUMMARY_PREFIX}summary</summary>`),
    task('new task'),
    reply('proposal'),
  ]
  assert.equal(lastCompactionSummaryIndex(compacted), 2)
  const old = rewindActionFor(compacted, 0)
  assert.equal(old?.removable, false)
  assert.equal(old?.blockedBy, 'compaction-floor')
  assert.match(old?.reason ?? '', /folded into the context compaction summary/)
  const fresh = rewindActionFor(compacted, 3)
  assert.equal(fresh?.removable, true)
  assert.equal(fresh?.turns, 1)
  assert.equal(fresh?.blockedBy, null)
})

test('rewindPreview states exactly what the confirmation will remove', () => {
  const { events } = consultSession()
  assert.deepEqual(rewindPreview(events, 0), {
    operatorIndex: 0,
    turns: 3,
    removedMessages: 7,
    keptMessages: 0,
    taskText: 'task one',
  })
  assert.deepEqual(rewindPreview(events, 4), {
    operatorIndex: 4,
    turns: 1,
    removedMessages: 3,
    keptMessages: 4,
    taskText: 'task three',
  })
  // blocked / non-operator / non-removable messages have no preview
  assert.equal(rewindPreview(events, 1), null)
  assert.equal(rewindPreview(events, 4, { live: true }), null)
})

test('the destructive confirmation names the counts, the rewrite and the irreversibility', () => {
  const { events } = consultSession()
  const preview = rewindPreview(events, 2)!
  const body = rewindConfirmation(preview)
  assert.match(body, /Remove this task and everything after it/)
  assert.match(body, /5 messages \(2 operator tasks\)/)
  assert.match(body, /rewritten in place/)
  assert.match(body, /cannot be undone/)
  assert.match(body, /task two/)
  assert.equal(rewindConfirmation(null), 'This task cannot be rewound.')
})

test('rewindQuote collapses whitespace and stays bounded', () => {
  assert.equal(rewindQuote('  a   task\nwith lines  '), 'a task with lines')
  const long = 'x'.repeat(REWIND_QUOTE_MAX_CHARS + 40)
  const quoted = rewindQuote(long)
  assert.equal(quoted.length, REWIND_QUOTE_MAX_CHARS)
  assert.ok(quoted.endsWith('…'))
})

// ---------------------------------------------------------------------------
// outcome / failure copy
// ---------------------------------------------------------------------------

test('the outcome copy reports the applied cut and the backend clamp honestly', () => {
  const base = {
    name: 'chat.jsonl',
    rewritten: true,
    requested_turns: 1,
    stops_before: 'operator-turn' as const,
  }
  assert.equal(
    rewindOutcomeNotice({
      ...base,
      turns: 1,
      kept: 4,
      removed: 3,
      stopped_at_compaction: false,
      reason: 'removed the last operator turn',
    }),
    'Rewound: 3 messages removed (1 task), 4 kept.',
  )
  const clamped = rewindOutcomeNotice({
    ...base,
    turns: 2,
    kept: 5,
    removed: 4,
    stopped_at_compaction: true,
    stops_before: 'compaction-summary',
    reason: 'stopped at the context compaction summary; older tasks are folded into it',
  })
  assert.match(clamped, /stopped at a context boundary/)
  assert.match(clamped, /4 messages removed \(2 tasks\), 5 kept/)
  assert.match(clamped, /folded into it/)
  // a no-op response says so instead of claiming a rewrite
  assert.equal(
    rewindOutcomeNotice({ ...base, rewritten: false, turns: 0, kept: 7, removed: 0, stopped_at_compaction: false, reason: '' }),
    'Nothing was rewound — the session file is unchanged.',
  )
  // a failed runtime-sidecar clear is disclosed, never hidden
  const sidecar = rewindOutcomeNotice({
    ...base,
    turns: 1,
    kept: 4,
    removed: 3,
    stopped_at_compaction: false,
    reason: '',
    runtime_events_cleared: false,
    runtime_events_clear_error: 'EACCES',
  })
  assert.match(sidecar, /could not be cleared: EACCES/)
  assert.equal(rewindOutcomeNotice(null), 'Rewind finished.')

  // the applied cut matches the preview only when nothing clamped it
  const preview = { operatorIndex: 4, turns: 1, removedMessages: 3, keptMessages: 4, taskText: 't' }
  assert.equal(
    rewindOutcomeMatchesPreview(
      { ...base, turns: 1, kept: 4, removed: 3, stopped_at_compaction: false, reason: '' },
      preview,
    ),
    true,
  )
  assert.equal(
    rewindOutcomeMatchesPreview(
      {
        ...base,
        turns: 2,
        kept: 5,
        removed: 4,
        stopped_at_compaction: true,
        stops_before: 'compaction-summary',
        reason: '',
      },
      preview,
    ),
    false,
  )
  assert.equal(rewindOutcomeMatchesPreview(null, preview), false)
})

test('failure copy maps the documented route contract honestly', () => {
  assert.match(rewindFailureNotice({ status: 0 }), /unreachable/)
  assert.equal(
    rewindFailureNotice({ status: 409, detail: 'a run is active for this session; stop it before rewinding' }),
    'a run is active for this session; stop it before rewinding',
  )
  assert.match(rewindFailureNotice({ status: 400 }), /depth was rejected/)
  assert.match(rewindFailureNotice({ status: 404 }), /no longer known/)
  assert.match(rewindFailureNotice({ status: 409 }), /changed under the request/)
  assert.match(rewindFailureNotice({ status: 500 }), /session was not changed/)
})

test('depth validation mirrors the backend bounds', () => {
  assert.equal(MIN_REWIND_TURNS, 1)
  assert.equal(MAX_REWIND_TURNS, 100)
  assert.deepEqual(validateRewindTurns(3), { ok: true, turns: 3 })
  assert.equal(validateRewindTurns(1).ok, true)
  assert.equal(validateRewindTurns(100).ok, true)
  for (const bad of [0, 101, -1, 1.5, '3', null, undefined, Number.NaN]) {
    const parsed = validateRewindTurns(bad)
    assert.equal(parsed.ok, false, String(bad))
  }
})

test('blocked reasons are actionable sentences, or null when available', () => {
  assert.equal(rewindBlockedReason(null), null)
  assert.equal(rewindBlockedReason({}), null)
  assert.match(rewindBlockedReason({ live: true }) ?? '', /Stop the run first/)
  assert.match(rewindBlockedReason({ compacting: true }) ?? '', /being compacted/)
})
