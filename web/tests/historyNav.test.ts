// Focused tests for src/historyNav.ts — the user-message navigator model
// (operator extraction, excerpts, stable ids, window-growth planning), no DOM:
//   node --import ./tests/register-ts.mjs --test tests/historyNav.test.ts

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  HISTORY_NAV_EXCERPT_MAX,
  excerptOf,
  operatorMessagesOf,
  planRevealGrowth,
} from '../src/historyNav.ts'
import type { ChatMessage, Speaker } from '../src/chat.ts'
import type { TimelineEntry } from '../src/runtime.ts'

function msg(seq: number, text: string | null, over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: `m-${seq}`,
    seq,
    ts: '2026-11-10T12:00:00Z',
    kind: 'message',
    title: null,
    body: text,
    details: [],
    lists: [],
    verdict: null,
    confidencePct: null,
    dissent: null,
    highlight: false,
    ...over,
  }
}

function groupRow(rowIndex: number, author: Speaker, messages: ChatMessage[]): TimelineEntry {
  return {
    time: rowIndex,
    order: rowIndex,
    entry: {
      type: 'group',
      group: {
        author,
        recipient: author === 'operator' ? 'senior' : 'user',
        startTs: messages[0]?.ts ?? '',
        messages,
      },
    },
  }
}

function systemRow(rowIndex: number): TimelineEntry {
  return {
    time: rowIndex,
    order: rowIndex,
    entry: {
      type: 'system',
      activity: { id: `s-${rowIndex}`, seq: rowIndex, ts: '', label: 'Context compacted', body: null },
    },
  }
}

test('excerptOf flattens to one bounded line', () => {
  assert.equal(excerptOf('hello\n  world \t again'), 'hello world again')
  assert.equal(excerptOf(null), '')
  assert.equal(excerptOf('   '), '')
  const long = 'x'.repeat(HISTORY_NAV_EXCERPT_MAX + 50)
  const clipped = excerptOf(long)
  assert.equal(clipped.length, HISTORY_NAV_EXCERPT_MAX)
  assert.ok(clipped.endsWith('…'))
  assert.ok(long.startsWith(clipped.slice(0, -1)))
  // a custom bound is honored
  assert.equal(excerptOf('abcdef', 4), 'abc…')
})

test('empty timeline yields no entries', () => {
  assert.deepEqual(operatorMessagesOf([]), [])
})

test('operator extraction: messages not groups, chronological, stable ids', () => {
  const timeline: TimelineEntry[] = [
    groupRow(0, 'operator', [msg(1, 'first task'), msg(2, 'second task')]),
    groupRow(1, 'senior', [msg(3, 'senior answer')]),
    systemRow(2),
    groupRow(3, 'operator', [msg(4, 'third task')]),
    groupRow(4, 'operator', [
      msg(5, 'kind bubble', { kind: 'decision', title: 'Decision', body: 'decided' }),
    ]),
  ]
  const entries = operatorMessagesOf(timeline)
  // the decision-kind bubble inside an operator group is not operator speech
  assert.deepEqual(
    entries.map((e) => e.id),
    ['op-1', 'op-2', 'op-4'],
  )
  assert.deepEqual(
    entries.map((e) => e.seq),
    [1, 2, 4],
  )
  assert.deepEqual(
    entries.map((e) => e.index),
    [0, 1, 2],
  )
  // two messages in one group are enumerated individually, with the group's row
  assert.deepEqual(
    entries.map((e) => e.rowIndex),
    [0, 0, 3],
  )
  assert.deepEqual(
    entries.map((e) => e.excerpt),
    ['first task', 'second task', 'third task'],
  )
  assert.ok(entries.every((e) => typeof e.time === 'string' && e.time.length > 0))
})

test('operator extraction: title wins over body; bad timestamps give no time', () => {
  const timeline: TimelineEntry[] = [
    groupRow(0, 'operator', [
      msg(7, 'body text', { title: 'titled task' }),
      msg(8, 'untimed', { ts: 'not a date' }),
    ]),
  ]
  const entries = operatorMessagesOf(timeline)
  assert.equal(entries[0].excerpt, 'titled task')
  assert.equal(entries[1].excerpt, 'untimed')
  assert.equal(entries[1].time, null)
})

test('planRevealGrowth: an already-rendered target plans nothing', () => {
  const plan = planRevealGrowth(240, 198, { loaded: 0 })
  assert.deepEqual(plan.state, { loaded: 0 })
  assert.equal(plan.activations, 0)
  assert.equal(plan.revealed, true)
  assert.equal(plan.clamped, false)
})

test('planRevealGrowth: hidden target grows the window in show-earlier chunks', () => {
  // 240 rows, default page 200: row 0 needs 40 rows loaded (one 100-chunk).
  const plan = planRevealGrowth(240, 0, { loaded: 0 })
  assert.equal(plan.activations, 1)
  assert.deepEqual(plan.state, { loaded: 40 })
  assert.equal(plan.revealed, true)
  assert.equal(plan.clamped, false)
  // rounding up to whole chunks: 500 rows to the top needs three chunks.
  const top = planRevealGrowth(500, 0, { loaded: 0 })
  assert.equal(top.activations, 3)
  assert.deepEqual(top.state, { loaded: 300 })
  assert.equal(top.revealed, true)
})

test('planRevealGrowth: honors custom page/chunk sizes', () => {
  const plan = planRevealGrowth(30, 0, { loaded: 0 }, { pageSize: 10, chunkSize: 5 })
  assert.equal(plan.activations, 4)
  assert.deepEqual(plan.state, { loaded: 20 })
  assert.equal(plan.revealed, true)
})

test('planRevealGrowth: live-session clamp stops runaway growth honestly', () => {
  // the target needs 3 chunks but only 2 are allowed: report the clamp and
  // leave the target unrevealed rather than pretending.
  const plan = planRevealGrowth(500, 0, { loaded: 0 }, { maxActivations: 2 })
  assert.equal(plan.activations, 2)
  assert.deepEqual(plan.state, { loaded: 200 })
  assert.equal(plan.revealed, false)
  assert.equal(plan.clamped, true)
})

test('planRevealGrowth: never shrinks what is already loaded', () => {
  // the target needs only 40 rows but the operator already loaded 50.
  const plan = planRevealGrowth(300, 60, { loaded: 50 })
  assert.equal(plan.activations, 0)
  assert.deepEqual(plan.state, { loaded: 50 })
  assert.equal(plan.revealed, true)
  // a larger existing load is preserved even when it exceeds the need.
  const plenty = planRevealGrowth(500, 100, { loaded: 300 })
  assert.equal(plenty.activations, 0)
  assert.deepEqual(plenty.state, { loaded: 300 })
  assert.equal(plenty.revealed, true)
})

test('planRevealGrowth: out-of-range targets plan nothing', () => {
  for (const target of [-1, 500, NaN]) {
    const plan = planRevealGrowth(500, target, { loaded: 25 })
    assert.deepEqual(plan.state, { loaded: 25 }, `target ${String(target)} keeps state`)
    assert.equal(plan.activations, 0)
    assert.equal(plan.revealed, false)
    assert.equal(plan.clamped, false)
  }
  const empty = planRevealGrowth(0, 0, { loaded: 0 })
  assert.equal(empty.revealed, false)
  assert.deepEqual(empty.state, { loaded: 0 })
})

test('planRevealGrowth: growth is capped at what the window can load', () => {
  // asking for row 0 of a 150-row window already loads everything; extra
  // activations would load nothing more.
  const plan = planRevealGrowth(150, 0, { loaded: 0 })
  assert.equal(plan.activations, 0)
  assert.equal(plan.revealed, true)
  assert.deepEqual(plan.state, { loaded: 0 })
})
