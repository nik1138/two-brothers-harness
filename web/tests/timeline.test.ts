// Focused projection tests for src/runtime.ts (timeline merge + tail helpers) —
// run with:
//   node --import ./tests/register-ts.mjs --test tests/chat.test.ts tests/timeline.test.ts
// (runtime.ts value-imports './chat' without an extension, which plain-node
// type stripping cannot resolve; register-ts.mjs installs the tiny resolver
// below. The modules are otherwise dependency-free at runtime.)

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  COMPACTION_SUMMARY_PREFIX,
  COMPACTION_SUMMARY_SUFFIX,
  projectEnvelopes,
  resetChatProjection,
} from '../src/chat.ts'
import {
  mergeTimeline,
  nextActorLabel,
  projectRuntimeEvents,
  reasoningTextOf,
  resetRuntimeProjection,
  timestampOf,
  REASONING_REPLAY_MAX_CHARS,
} from '../src/runtime.ts'
import type { RuntimeItem, TimelineEntry } from '../src/runtime.ts'
import type { RunEvent } from '../src/types.ts'

const VALID_TYPES = new Set([
  'group',
  'divider',
  'system',
  'tool',
  'approval',
  'prompt_audit',
  'reasoning',
  'auto_route',
])

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
      e.entry.type === 'tool' ||
      e.entry.type === 'approval' ||
      e.entry.type === 'prompt_audit' ||
      e.entry.type === 'reasoning' ||
      e.entry.type === 'auto_route'
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

test('mergeTimeline: a compaction-summary row merges as a neutral system activity', () => {
  resetChatProjection([])
  const events = [
    {
      v: 1,
      id: 'e1',
      seq: 1,
      ts: '2026-11-04T21:00:00Z',
      from: 'user',
      to: 'senior',
      kind: 'message',
      payload: { text: 'do the thing' },
    },
    {
      v: 1,
      id: 'e2',
      seq: 2,
      ts: '2026-11-04T21:05:00Z',
      from: 'user',
      to: 'senior',
      kind: 'message',
      payload: {
        text: `${COMPACTION_SUMMARY_PREFIX}Older context summarized.${COMPACTION_SUMMARY_SUFFIX}`,
      },
    },
  ] as never[]
  const merged = mergeTimeline(projectEnvelopes(events), [])
  assertTimelineWellFormed(merged, 'compaction summary merge')
  const systemRows = merged.filter((row) => row.entry.type === 'system')
  assert.equal(systemRows.length, 1)
  if (systemRows[0]?.entry.type === 'system') {
    assert.equal(systemRows[0].entry.activity.label, 'Context compacted')
    assert.equal(systemRows[0].entry.activity.quiet, true)
    assert.match(systemRows[0].entry.activity.body ?? '', /Older context summarized/)
  }
  // the summary never becomes an operator chat group
  assert.equal(
    merged.filter((row) => row.entry.type === 'group' && row.entry.group.author === 'operator')
      .length,
    1,
  )
})

// ---------------------------------------------------------------------------
// replayed reasoning rows (additive sidecar records; streaming-only backend)
// ---------------------------------------------------------------------------

function reasoningEvent(overrides: Record<string, unknown> = {}): RunEvent {
  return {
    type: 'reasoning',
    role: 'senior',
    kind: 'consult',
    text: 'Think about the task first.',
    truncated: false,
    run_id: 'r1',
    at: 1793823644,
    ...overrides,
  } as unknown as RunEvent
}

test('reasoning: a persisted record projects to one honest reasoning row', () => {
  resetRuntimeProjection([])
  const runtime = projectRuntimeEvents([reasoningEvent()])
  assert.equal(runtime.length, 1)
  const item = runtime[0]
  assert.equal(item?.type, 'reasoning')
  if (item?.type !== 'reasoning') return
  assert.equal(item.role, 'senior')
  assert.equal(item.kind, 'consult')
  assert.equal(item.text, 'Think about the task first.')
  assert.equal(item.truncated, false)
  assert.equal(item.at, 1793823644)
  assert.equal(item.runId, 'r1')
  assert.match(item.id, /^r1:reasoning:/)
  assert.equal(timestampOf(item), 1793823644 * 1000, 'reasoning carries a timeline time')
})

test('reasoning: runtime rows sort after chat rows on equal timestamps', () => {
  resetChatProjection([])
  resetRuntimeProjection([])
  const ts = '2026-11-04T20:20:44Z'
  const events = [
    {
      v: 1,
      id: 'e1',
      seq: 1,
      ts,
      from: 'senior',
      to: 'junior',
      kind: 'consult',
      payload: { task: 't', ask: 'a', expect: 'proposal' },
    },
  ] as never[]
  const runtime = projectRuntimeEvents([reasoningEvent({ at: 1793823644, text: 'same second' })])
  const merged = mergeTimeline(projectEnvelopes(events), runtime)
  assertTimelineWellFormed(merged, 'reasoning tie-break')
  const groupAt = merged.findIndex((row) => row.entry.type === 'group')
  const reasoningAt = merged.findIndex((row) => row.entry.type === 'reasoning')
  assert.ok(groupAt >= 0)
  assert.ok(reasoningAt > groupAt, 'the runtime row is ordered after the chat row')
  assert.equal(timestampOf(merged[reasoningAt]?.entry), 1793823644 * 1000)
})

test('reasoning: malformed rows are dropped and oversized text is bounded', () => {
  resetRuntimeProjection([])
  const oversized = 'x'.repeat(REASONING_REPLAY_MAX_CHARS * 2 + 37)
  const runtime = projectRuntimeEvents([
    reasoningEvent({ text: 42 }),
    reasoningEvent({ text: '   \n\t ' }),
    reasoningEvent({ text: '\x1b[31mred\x1b[0m \x07plan\x00' }),
    reasoningEvent({ text: oversized }),
    reasoningEvent({ text: 'ok', role: 'someone-else', kind: 7, truncated: 'yes' }),
  ])
  assert.equal(runtime.length, 3, 'two unusable sidecar rows are dropped, never rendered')
  const [sanitized, bounded, tolerant] = runtime
  assert.equal(sanitized?.type, 'reasoning')
  if (sanitized?.type === 'reasoning') {
    assert.equal(sanitized.text, 'red plan', 'ANSI escapes and control bytes are stripped here too')
    assert.equal(sanitized.truncated, false)
  }
  if (bounded?.type === 'reasoning') {
    assert.equal(bounded.truncated, true, 'a hostile/oversized sidecar row is clipped in the browser')
    assert.ok(bounded.text.length <= REASONING_REPLAY_MAX_CHARS + 64)
    assert.match(bounded.text, /\.\.\.\[truncated \d+ chars\]\.\.\./)
  }
  if (tolerant?.type === 'reasoning') {
    // Old/hand-written rows: unknown role falls back to junior, a non-string
    // kind becomes the empty string, a non-boolean `truncated` never claims a
    // clip that did not happen.
    assert.equal(tolerant.role, 'junior')
    assert.equal(tolerant.kind, '')
    assert.equal(tolerant.truncated, false)
  }
  // An older backend (no reasoning events at all) simply projects no rows.
  assert.equal(projectRuntimeEvents([]).length, 0)
})

test('reasoningTextOf: tolerant sanitize + head/tail bound', () => {
  assert.equal(reasoningTextOf(undefined), null)
  assert.equal(reasoningTextOf(null), null)
  assert.equal(reasoningTextOf(7), null)
  assert.equal(reasoningTextOf(''), null)
  assert.equal(reasoningTextOf('  \n\t '), null)
  assert.deepEqual(reasoningTextOf('\x1b[1mbold\x1b[0m\x07'), { text: 'bold', truncated: false })
  const huge = 'y'.repeat(REASONING_REPLAY_MAX_CHARS + 100)
  const bounded = reasoningTextOf(huge)
  assert.ok(bounded !== null)
  assert.equal(bounded?.truncated, true)
  assert.ok((bounded?.text.length ?? 0) <= REASONING_REPLAY_MAX_CHARS + 64)
  assert.match(bounded?.text ?? '', /\.\.\.\[truncated 100 chars\]\.\.\./)
  assert.ok(bounded?.text.startsWith('y'.repeat(100)))
  assert.ok(bounded?.text.endsWith('y'.repeat(100)))
})

// ---------------------------------------------------------------------------
// auto_route: the routing pre-decision projects as the same neutral activity
// the marker envelope produces, and is shadowed once the envelope lands.
// ---------------------------------------------------------------------------

function autoRouteEvent(overrides: Record<string, unknown> = {}): RunEvent {
  return {
    type: 'auto_route',
    route: 'solo',
    reason: 'I can answer this from knowledge',
    requested: 'auto',
    run_id: 'r1',
    at: 1793823644,
    ...overrides,
  } as unknown as RunEvent
}

test('auto_route: the event projects to one honest "Senior chose …" row', () => {
  resetRuntimeProjection([])
  const runtime = projectRuntimeEvents([autoRouteEvent()])
  assert.equal(runtime.length, 1)
  const item = runtime[0]
  assert.equal(item?.type, 'auto_route')
  if (item?.type !== 'auto_route') return
  assert.equal(item.route, 'solo')
  assert.equal(item.label, 'Auto · Senior chose solo')
  assert.equal(item.body, 'I can answer this from knowledge')
  assert.equal(item.runId, 'r1')
  assert.match(item.id, /^r1:auto_route:/)
})

test('auto_route: the G1 downgrade renders the work-unavailable wording', () => {
  resetRuntimeProjection([])
  const runtime = projectRuntimeEvents([
    autoRouteEvent({
      route: 'consult',
      reason: 'files must change',
      downgraded_from: 'work',
    }),
  ])
  const item = runtime[0]
  assert.equal(item?.type, 'auto_route')
  if (item?.type !== 'auto_route') return
  assert.equal(
    item.label,
    'Auto · Senior chose consult (work unavailable: no workspace bound)',
  )
  assert.equal(item.body, 'files must change')
})

test('auto_route: malformed rows are dropped, never a fabricated route', () => {
  resetRuntimeProjection([])
  const runtime = projectRuntimeEvents([
    autoRouteEvent({ route: 'bogus' }),
    autoRouteEvent({ route: undefined }),
  ])
  assert.equal(runtime.length, 0)
})

test('auto_route: the live row shows before the envelope, then is shadowed by it', () => {
  resetChatProjection([])
  resetRuntimeProjection([])
  const runtime = projectRuntimeEvents([autoRouteEvent()])
  // Live window: only the task envelope has landed; the runtime row carries
  // the decision until the marker envelope arrives.
  const taskOnly = projectEnvelopes([
    {
      v: 1, id: 'e1', seq: 1, ts: '2026-11-04T20:19:28Z',
      from: 'user', to: 'senior', kind: 'message', payload: { text: 'task' },
    },
  ] as never[])
  const live = mergeTimeline(taskOnly, runtime)
  assertTimelineWellFormed(live, 'auto_route live window')
  assert.ok(live.some((row) => row.entry.type === 'auto_route'))

  // The marker envelope lands: the chat activity owns the decision and the
  // runtime row is dropped (exactly one route row in the timeline).
  const withMarker = projectEnvelopes([
    {
      v: 1, id: 'e1', seq: 1, ts: '2026-11-04T20:19:28Z',
      from: 'user', to: 'senior', kind: 'message', payload: { text: 'task' },
    },
    {
      v: 1, id: 'e2', seq: 2, ts: '2026-11-04T20:19:29Z',
      from: 'user', to: 'senior', kind: 'message',
      payload: { text: '[[AUTO ROUTE]] solo — I can answer this from knowledge' },
    },
  ] as never[])
  const settled = mergeTimeline(withMarker, runtime)
  assertTimelineWellFormed(settled, 'auto_route shadowed')
  assert.ok(!settled.some((row) => row.entry.type === 'auto_route'))
  const activities = settled.filter(
    (row) => row.entry.type === 'system' && row.entry.activity.label.startsWith('Auto ·'),
  )
  assert.equal(activities.length, 1, 'the decision renders exactly once')
})
