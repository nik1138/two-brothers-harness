// Focused projection tests for src/runtime.ts (timeline merge + tail helpers) —
// run with:
//   node --import ./tests/register-ts.mjs --test tests/chat.test.ts tests/timeline.test.ts
// (runtime.ts value-imports './chat' without an extension, which plain-node
// type stripping cannot resolve; register-ts.mjs installs the tiny resolver
// below. The modules are otherwise dependency-free at runtime.)

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { projectEnvelopes, resetChatProjection } from '../src/chat.ts'
import {
  mergeTimeline,
  nextActorLabel,
  projectRuntimeEvents,
  timestampOf,
} from '../src/runtime.ts'
import type { RuntimeItem, TimelineEntry } from '../src/runtime.ts'
import type { RunEvent } from '../src/types.ts'

const VALID_TYPES = new Set(['group', 'divider', 'system', 'tool', 'approval', 'prompt_audit'])

/** Assert the contract every consumer relies on: no undefined rows, no
 *  undefined entries, valid types, (time, source, order) ordering. */
function assertTimelineWellFormed(merged: TimelineEntry[], where: string) {
  for (let i = 0; i < merged.length; i += 1) {
    const row = merged[i]
    assert.ok(row, `${where}: timeline row ${i} is undefined`)
    assert.ok(row.entry, `${where}: timeline row ${i} has an undefined entry`)
    assert.ok(
      VALID_TYPES.has(row.entry.type),
      `${where}: timeline row ${i} has bogus type ${String(row.entry.type)}`,
    )
    assert.equal(typeof row.time, 'number', `${where}: timeline row ${i} has non-numeric time`)
  }
  for (let i = 1; i < merged.length; i += 1) {
    const a = merged[i - 1]
    const b = merged[i]
    const src = (e: TimelineEntry) =>
      e.entry.type === 'tool' || e.entry.type === 'approval' || e.entry.type === 'prompt_audit'
        ? 1
        : 0
    const cmp = a.time - b.time || src(a) - src(b) || a.order - b.order
    assert.ok(cmp <= 0, `${where}: timeline not sorted at row ${i}`)
  }
}

test('timestampOf: an absent tail entry (empty live timeline) carries no time', () => {
  // Regression for the real-run console error
  //   TypeError: Cannot read properties of undefined (reading 'type')
  // ChatView's statusLine derives the tail as
  //   props.timeline[props.timeline.length - 1]?.entry
  // which is undefined while a live run has produced no rows yet (a fresh
  // session goes queued/running before the first envelope lands). The helper
  // must tolerate the absent entry — exactly the contract nextActorLabel
  // already documents for the same call site.
  const timeline: TimelineEntry[] = []
  const tail = timeline[timeline.length - 1]?.entry
  assert.equal(tail, undefined)
  assert.equal(timestampOf(tail), null)
  assert.equal(nextActorLabel(tail), null)
  assert.equal(timestampOf(undefined), null)
  assert.equal(nextActorLabel(undefined), null)
})

test('mergeTimeline: empty projections merge to an empty, stable timeline', () => {
  const items: never[] = []
  const runtime: never[] = []
  const merged = mergeTimeline(items, runtime)
  assert.deepEqual(merged, [])
  // repeated calls with the same source arrays hit the fast path and return
  // the identical cached array
  assert.equal(mergeTimeline(items, runtime), merged)
  assertTimelineWellFormed(merged, 'empty merge')
})

test('mergeTimeline: incremental fresh-object replacement never yields undefined rows', () => {
  // The real-run shape: operator task, a payload-repair system activity, then
  // role envelopes interleaved with prompt_audit runtime rows, with a
  // wholesale (fresh-object) envelope reload mid-stream and live appends
  // afterwards — fed through the projections exactly the way App.vue feeds
  // them (immutable array replacement per event).
  resetChatProjection([])
  let events = [
    {
      v: 1, id: 'e1', seq: 1, ts: '2026-11-04T20:19:28Z',
      from: 'user', to: 'senior', kind: 'message', payload: { text: 'task' },
    },
  ] as never[]
  let runtime: RunEvent[] = []

  const feed = () => {
    const items = projectEnvelopes(events)
    const rt: RuntimeItem[] = projectRuntimeEvents(runtime)
    const merged = mergeTimeline(items, rt)
    assertTimelineWellFormed(merged, 'incremental feed')
    return merged
  }

  feed()
  // repair re-ask (system activity) + a prompt_audit at the same second
  events = [
    ...events,
    {
      v: 1, id: 'e2', seq: 2, ts: '2026-11-04T20:20:44Z',
      from: 'user', to: 'senior', kind: 'message',
      payload: {
        text: '[[REPAIR_REQUEST]]\nrequired consult payload schema\n[[/REPAIR_REQUEST]]',
      },
    },
  ] as never[]
  runtime = [
    ...runtime,
    {
      type: 'prompt_audit', run_id: 'r', role: 'senior', kind: 'consult',
      sections: [], tools: [], systemChars: 1, userChars: 2, at: 1793823644,
    } as unknown as RunEvent,
  ]
  feed()
  // wholesale reload with fresh objects (finalizeRun-style), superset
  events = [
    ...(JSON.parse(JSON.stringify(events)) as never[]),
    {
      v: 1, id: 'e3', seq: 3, ts: '2026-11-04T20:22:02Z',
      from: 'senior', to: 'junior', kind: 'consult', payload: { task: 't', ask: 'a' },
    },
  ] as never[]
  const before = feed()
  // live appends after the reload
  events = [
    ...events,
    {
      v: 1, id: 'e4', seq: 4, ts: '2026-11-04T20:23:20Z',
      from: 'junior', to: 'senior', kind: 'proposal', payload: { title: 'p', answer: 'a' },
    },
  ] as never[]
  runtime = [
    ...runtime,
    {
      type: 'tool_started', run_id: 'r', tool: 'write_file', actor: 'junior',
      args: {}, at: 1793823800,
    } as unknown as RunEvent,
  ]
  const after = feed()
  assert.ok(after.length > before.length, 'live appends extend the timeline')
  const tail = after[after.length - 1]?.entry
  assert.ok(tail, 'tail entry defined after appends')
  assert.ok(timestampOf(tail) !== undefined)
})
