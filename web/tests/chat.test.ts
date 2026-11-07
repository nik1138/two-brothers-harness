// Focused projection tests for src/chat.ts — run with:
//   node --test tests/chat.test.ts        (from web/, Node >= 22.6 type stripping)
// The module is dependency-free at runtime (type-only imports), so plain
// node:test works without the Vite toolchain.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  COMPACTION_SUMMARY_PREFIX,
  COMPACTION_SUMMARY_SUFFIX,
  SPEAKER_LABELS,
  appendEnvelope,
  compactionSummaryBody,
  currentChatItems,
  isCompactionSummaryText,
  isRepairRequestText,
  resetChatProjection,
  speakerActivityLabel,
  speakerInitial,
  speakerLabel,
  speakerOf,
  taskOf,
  type ChatItem,
} from '../src/chat.ts'
import type { Envelope } from '../src/types.ts'

const REPAIR_TEXT = [
  '[[REPAIR_REQUEST]]',
  'Your previous reply did not match the required consult payload schema.',
  'Issues: path/ask: Required',
  'Reply again with the complete consult payload as a single fenced ```json block and nothing else.',
  '[[/REPAIR_REQUEST]]',
].join('\n')

/** The envelope `compaction.ts` rewrites a compacted session with. */
const COMPACTION_TEXT = `${COMPACTION_SUMMARY_PREFIX}Goal: migrate Redis to Valkey.\nDecisions: keep the API stable; add tests first.${COMPACTION_SUMMARY_SUFFIX}`

function env(seq: number, text: string): Envelope {
  return {
    v: 1,
    id: `e${seq}`,
    seq,
    ts: '2026-11-04T00:00:00Z',
    from: 'user',
    to: 'senior',
    kind: 'message',
    payload: { text },
  } as unknown as Envelope
}

test('isRepairRequestText: anchored on the generated envelope structure', () => {
  assert.equal(isRepairRequestText(REPAIR_TEXT), true)
  assert.equal(isRepairRequestText(`  ${REPAIR_TEXT}\n`), true, 'surrounding whitespace tolerated')
  // operator speech merely mentioning the marker is NOT a repair envelope
  assert.equal(
    isRepairRequestText('please wrap it in [[REPAIR_REQUEST]] markers'),
    false,
  )
  assert.equal(
    isRepairRequestText('the log said [[REPAIR_REQUEST]] then failed'),
    false,
  )
  // half-anchored text is not an envelope either
  assert.equal(
    isRepairRequestText(`[[REPAIR_REQUEST]]\nno closing marker`),
    false,
  )
  assert.equal(isRepairRequestText(null), false)
  assert.equal(isRepairRequestText(42), false)
  assert.equal(isRepairRequestText(undefined), false)
})

test('projection: a generated repair envelope becomes a neutral system activity', () => {
  resetChatProjection([])
  appendEnvelope(env(1, 'do the thing'))
  appendEnvelope(env(2, REPAIR_TEXT))
  const items: ChatItem[] = currentChatItems()
  const repair = items.find((item) => item.type === 'system')
  assert.ok(repair, 'repair envelope projected as system activity')
  if (repair?.type === 'system') {
    assert.equal(repair.activity.label, 'Reply format repair')
    assert.match(repair.activity.body ?? '', /sent again/)
    assert.ok(!(repair.activity.body ?? '').includes('[[REPAIR_REQUEST]]'))
  }
  // an operator message containing the marker text stays operator speech
  resetChatProjection([])
  appendEnvelope(env(1, 'operator note about [[REPAIR_REQUEST]] markers'))
  const kept = currentChatItems()
  assert.ok(
    kept.some((item) => item.type === 'group' && item.group.author === 'operator'),
    'operator message with marker mention stays a chat group',
  )
  assert.ok(!kept.some((item) => item.type === 'system'), 'no system activity fabricated')
})

test('taskOf: skips repair envelopes but keeps the first real operator task', () => {
  assert.equal(taskOf([env(1, REPAIR_TEXT), env(2, 'real task here')]), 'real task here')
  assert.equal(taskOf([env(1, 'first task'), env(2, REPAIR_TEXT)]), 'first task')
})

test('speaker labels: the operator reads as "You"; live announcements stay grammatical', () => {
  assert.equal(speakerOf('user'), 'operator')
  assert.equal(SPEAKER_LABELS.operator, 'You')
  assert.equal(speakerLabel('operator'), 'You')
  assert.equal(speakerLabel('senior'), 'Senior')
  assert.equal(speakerLabel('junior'), 'Junior')
  assert.equal(speakerInitial('operator'), 'Y', 'avatar mark follows the visible label')
  assert.equal(speakerInitial('senior'), 'S')
  assert.equal(speakerInitial('junior'), 'J')
  // operator cannot stream today, but the phrase must still be grammatical
  assert.equal(speakerActivityLabel('operator', 'thinking'), 'You are thinking')
  assert.equal(speakerActivityLabel('operator', 'responding'), 'You are responding')
  assert.equal(speakerActivityLabel('senior', 'thinking'), 'Senior is thinking')
  assert.equal(speakerActivityLabel('junior', 'responding'), 'Junior is responding')
})

// -- compaction summary projection -------------------------------------------

test('compaction markers mirror the harness and are anchored, not operator speech', () => {
  // The constants are mirrored byte-for-byte from
  // packages/harness/src/compaction.ts (web cannot import package sources).
  assert.equal(
    COMPACTION_SUMMARY_PREFIX,
    'The conversation history before this point was compacted into the following summary:\n\n<summary>\n',
  )
  assert.equal(COMPACTION_SUMMARY_SUFFIX, '\n</summary>')

  assert.equal(isCompactionSummaryText(COMPACTION_TEXT), true)
  // operator speech merely mentioning the markers stays operator speech
  assert.equal(isCompactionSummaryText('please write a <summary> of it'), false)
  assert.equal(isCompactionSummaryText(`note: ${COMPACTION_SUMMARY_PREFIX}`), false)
  assert.equal(isCompactionSummaryText(null), false)
  assert.equal(isCompactionSummaryText(42), false)

  // body extraction strips the markers and trims
  assert.equal(
    compactionSummaryBody(COMPACTION_TEXT),
    'Goal: migrate Redis to Valkey.\nDecisions: keep the API stable; add tests first.',
  )
  assert.equal(compactionSummaryBody('not a summary'), '')
})

test('projection: a compaction summary becomes a neutral "Context compacted" activity', () => {
  resetChatProjection([])
  appendEnvelope(env(1, 'do the thing'))
  appendEnvelope(env(2, COMPACTION_TEXT))
  const items: ChatItem[] = currentChatItems()
  const system = items.find((item) => item.type === 'system')
  assert.ok(system, 'compaction envelope projected as a system activity')
  if (system?.type === 'system') {
    assert.equal(system.activity.label, 'Context compacted')
    assert.equal(system.activity.quiet, true, 'internal context row (excluded from find)')
    assert.match(system.activity.body ?? '', /migrate Redis to Valkey/)
    assert.ok(
      !(system.activity.body ?? '').includes('<summary>'),
      'raw markers never reach the transcript',
    )
  }
  // the summary is not operator speech: the earlier task is the only operator group
  const operatorGroups = items.filter(
    (item) => item.type === 'group' && item.group.author === 'operator',
  )
  assert.equal(operatorGroups.length, 1)
  if (operatorGroups[0]?.type === 'group') {
    assert.notEqual(operatorGroups[0].group.messages[0]?.body, COMPACTION_TEXT)
  }
  // the task line skips internal context envelopes
  assert.equal(taskOf([env(1, COMPACTION_TEXT), env(2, 'real task')]), 'real task')
  assert.equal(taskOf([env(1, 'real task'), env(2, COMPACTION_TEXT)]), 'real task')
})

test('projection: long compaction summaries are clipped, not rendered unbounded', () => {
  const long = 'x'.repeat(12_000)
  const text = `${COMPACTION_SUMMARY_PREFIX}${long}${COMPACTION_SUMMARY_SUFFIX}`
  const body = compactionSummaryBody(text)
  assert.ok(body.length < long.length)
  assert.match(body, /… \[summary clipped\]$/)
  assert.ok(body.startsWith('x'))
})
