/**
 * Model tests for the structured operator question surfaces:
 * `question.ts::normalizeQuestion` (tolerant boundary: coercion, clamps,
 * unusable-input rejection) and the runtime projection of the additive
 * `kind: "question"` approval event (valid payload → item.question, broken
 * payload → item.questionError, absent kind → byte-for-byte approval item).
 *
 * Run with: node --import ./tests/register-ts.mjs --test tests/question.test.ts
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  normalizeQuestion,
  QUESTION_HEADER_MAX,
  QUESTION_LABEL_MAX,
  QUESTION_OPTIONS_MAX,
  QUESTION_OPTIONS_MIN,
  QUESTION_TEXT_MAX,
} from '../src/question.ts'
import { projectRuntimeEvents } from '../src/runtime.ts'
import type { RunEvent } from '../src/types.ts'

// -- normalizeQuestion: the happy path ----------------------------------------

test('valid question: header/text/options preserved, multi_select only when true', () => {
  const question = normalizeQuestion({
    header: 'Pick a direction',
    text: 'Which migration target should the brothers plan for?',
    options: [
      { label: 'Valkey', description: 'Drop-in Redis replacement', intent: 'valkey' },
      { label: 'Stay on Redis', description: null, intent: '' },
    ],
    multi_select: true,
  })
  assert.deepEqual(question, {
    header: 'Pick a direction',
    text: 'Which migration target should the brothers plan for?',
    options: [
      { label: 'Valkey', description: 'Drop-in Redis replacement', intent: 'valkey' },
      { label: 'Stay on Redis' },
    ],
    multi_select: true,
  })
})

test('absent/optional fields stay absent; multi_select false is dropped', () => {
  const question = normalizeQuestion({
    text: 'Continue?',
    options: [{ label: 'Yes' }, { label: 'No' }],
    multi_select: false,
  })
  assert.deepEqual(question, {
    text: 'Continue?',
    options: [{ label: 'Yes' }, { label: 'No' }],
  })
})

// -- normalizeQuestion: unusable input returns null ----------------------------

test('unusable input: null / non-object / missing text / non-array options', () => {
  assert.equal(normalizeQuestion(null), null)
  assert.equal(normalizeQuestion('which one?'), null)
  assert.equal(normalizeQuestion([{ label: 'a' }]), null)
  assert.equal(normalizeQuestion({ text: '', options: [{ label: 'a' }, { label: 'b' }] }), null)
  assert.equal(normalizeQuestion({ text: 42, options: [{ label: 'a' }, { label: 'b' }] }), null)
  assert.equal(normalizeQuestion({ text: 'pick one' }), null)
  assert.equal(normalizeQuestion({ text: 'pick one', options: 'yes,no' }), null)
  assert.equal(normalizeQuestion({ text: 'pick one', options: null }), null)
})

test('fewer than two valid options is unusable (1 option, empty list, all-invalid)', () => {
  assert.equal(
    normalizeQuestion({ text: 'pick one', options: [{ label: 'only' }] }),
    null,
    'one option cannot be a choice',
  )
  assert.equal(normalizeQuestion({ text: 'pick one', options: [] }), null)
  assert.equal(
    normalizeQuestion({ text: 'pick one', options: [{ label: '' }, { label: 7 }] }),
    null,
    'options without a label do not count',
  )
  assert.equal(
    normalizeQuestion({ text: 'pick one', options: [{ label: 'ok' }, 'plain string'] }),
    null,
    'one valid option plus garbage is still one option',
  )
})

// -- normalizeQuestion: coercion and bounds ------------------------------------

test('oversized strings are hard-bounded with an ellipsis', () => {
  const question = normalizeQuestion({
    header: 'h'.repeat(QUESTION_HEADER_MAX * 2),
    text: 't'.repeat(QUESTION_TEXT_MAX * 2),
    options: [
      { label: 'l'.repeat(QUESTION_LABEL_MAX * 2), description: 'd'.repeat(600), intent: 'i'.repeat(300) },
      { label: 'ok' },
    ],
  })
  assert.ok(question)
  assert.equal(question.header.length, QUESTION_HEADER_MAX + 1)
  assert.ok(question.header.endsWith('…'))
  assert.equal(question.text.length, QUESTION_TEXT_MAX + 1)
  assert.ok(question.text.endsWith('…'))
  const [first] = question.options
  assert.equal(first.label.length, QUESTION_LABEL_MAX + 1)
  assert.ok(first.label.endsWith('…'))
  assert.equal(first.description?.length, 500 + 1)
  assert.ok(first.description?.endsWith('…'))
  assert.equal(first.intent?.length, 100 + 1)
  assert.ok(first.intent?.endsWith('…'))
})

test('the option list is clamped to QUESTION_OPTIONS_MAX entries', () => {
  const options = Array.from({ length: QUESTION_OPTIONS_MAX + 10 }, (_, i) => ({
    label: `option-${i}`,
  }))
  const question = normalizeQuestion({ text: 'pick', options })
  assert.ok(question)
  assert.equal(question.options.length, QUESTION_OPTIONS_MAX)
  // still unusable when the clamp drops it below the minimum
  assert.equal(
    normalizeQuestion({ text: 'pick', options: [{ label: 'only', description: 'x'.repeat(10_000) }] }),
    null,
  )
  assert.equal(QUESTION_OPTIONS_MIN, 2)
})

// -- runtime projection ----------------------------------------------------------

function requested(overrides: Record<string, unknown> = {}): RunEvent {
  return {
    type: 'approval_requested',
    approval_id: 'approval-1',
    action: 'ask_user',
    target: 'operator',
    run_id: 'run-1',
    at: 10,
    ...overrides,
  } as RunEvent
}

test('a question event projects item.kind "question" with the normalized payload', () => {
  const items = projectRuntimeEvents([
    requested({
      kind: 'question',
      question: {
        header: 'Direction',
        text: 'Which target?',
        options: [
          { label: 'Valkey', intent: 'valkey' },
          { label: 'Redis', description: 'keep it' },
        ],
      },
    }),
  ])
  const item = items[0]
  assert.ok(item?.type === 'approval')
  assert.equal(item.kind, 'question')
  assert.equal(item.question?.header, 'Direction')
  assert.equal(item.question?.options.length, 2)
  assert.equal(item.questionError, undefined)
})

test('a broken question payload projects questionError, never a crash', () => {
  for (const question of [null, { text: 'no options' }, { options: [{ label: 'a' }] }, 7]) {
    const items = projectRuntimeEvents([requested({ kind: 'question', question })])
    const item = items[0]
    assert.ok(item?.type === 'approval')
    assert.equal(item.kind, 'question')
    assert.equal(item.question, undefined)
    assert.equal(item.questionError, true)
  }
})

test('an absent kind projects the exact legacy approval item (no additive fields)', () => {
  const items = projectRuntimeEvents([requested()])
  const item = items[0]
  assert.ok(item?.type === 'approval')
  assert.equal(item.kind, undefined)
  assert.equal(item.question, undefined)
  assert.equal(item.questionError, undefined)
  assert.equal(item.action, 'ask_user')
})

test('resolving a question keeps its kind/question on the flipped item', () => {
  const items = projectRuntimeEvents([
    requested({
      kind: 'question',
      question: { text: 'Which target?', options: [{ label: 'A' }, { label: 'B' }] },
    }),
    {
      type: 'approval_resolved',
      approval_id: 'approval-1',
      decision: 'answer',
      run_id: 'run-1',
      at: 11,
    } as RunEvent,
  ])
  const item = items[0]
  assert.ok(item?.type === 'approval')
  assert.equal(item.decision, 'answer')
  assert.equal(item.kind, 'question')
  assert.equal(item.question?.text, 'Which target?')
})
