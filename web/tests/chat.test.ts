// Focused projection tests for src/chat.ts — run with:
//   node --test tests/chat.test.ts        (from web/, Node >= 22.6 type stripping)
// The module is dependency-free at runtime (type-only imports), so plain
// node:test works without the Vite toolchain.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  appendEnvelope,
  currentChatItems,
  isRepairRequestText,
  resetChatProjection,
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
