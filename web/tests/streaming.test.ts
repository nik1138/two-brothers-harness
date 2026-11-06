// Focused tests for src/streaming.ts (the live SSE token draft) and the
// matching api.ts wiring. No DOM and no real EventSource: a fake constructor is
// injected so the named `token` handler can be exercised offline:
//   node --import ./tests/register-ts.mjs --test tests/streaming.test.ts

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  STREAMING_MAX_CHARS,
  applyRuntimeEvent,
  applyToken,
  createStreamingState,
  hasStreamingDraft,
  isTokenEvent,
  resetStreaming,
  streamingBlocks,
} from '../src/streaming.ts'
import type { StreamingState } from '../src/streaming.ts'
import { openRunEventStream, startRun } from '../src/api.ts'
import type { Envelope, RunEvent, TokenEvent } from '../src/types.ts'

function token(overrides: Partial<TokenEvent> = {}): TokenEvent {
  return {
    type: 'token',
    run_id: 'run-1',
    role: 'senior',
    kind: 'text',
    delta: 'hello',
    at: 1_700_000_000,
    ...overrides,
  }
}

function envelope(from: Envelope['from'] = 'senior', runId = 'run-1'): RunEvent {
  const payload: Envelope = {
    v: 1,
    id: `e-${from}`,
    seq: 1,
    ts: '2026-01-01T00:00:00.000Z',
    from,
    to: 'user',
    kind: 'message',
    payload: { text: 'done' },
  }
  return { type: 'envelope', seq: 1, envelope: payload, run_id: runId, at: 1_700_000_000 }
}

function stateWith(overrides: Partial<StreamingState> = {}): StreamingState {
  return { ...createStreamingState(), ...overrides }
}

const applyDeltas = (
  state: StreamingState,
  deltas: Array<Partial<TokenEvent>>,
): StreamingState => deltas.reduce((next, delta) => applyToken(next, token(delta)), state)

// -- state basics -------------------------------------------------------------

test('create/reset: empty state shape and hasStreamingDraft', () => {
  const empty = createStreamingState()
  assert.deepEqual(empty, {
    runId: null,
    role: null,
    thinking: '',
    text: '',
    phase: null,
    thinkingTruncated: false,
    textTruncated: false,
  })
  assert.equal(hasStreamingDraft(empty), false)
  assert.equal(hasStreamingDraft(null), false)
  assert.equal(hasStreamingDraft(undefined), false)
  assert.equal(hasStreamingDraft(stateWith({ text: 'x' })), true)
  assert.equal(hasStreamingDraft(stateWith({ thinking: 'x' })), true)
  assert.equal(hasStreamingDraft(stateWith({ runId: 'r' })), true)

  assert.deepEqual(resetStreaming(stateWith({ text: 'abc', runId: 'r' })), createStreamingState())
  assert.notEqual(resetStreaming(empty), empty)
})

test('isTokenEvent narrows the SSE payload shape tolerantly', () => {
  assert.equal(isTokenEvent(token()), true)
  assert.equal(isTokenEvent({ ...token(), kind: 'weird' }), true, 'kind is tolerated downstream')
  assert.equal(isTokenEvent({ type: 'token', run_id: 'r', delta: '' }), true)
  for (const invalid of [
    null,
    undefined,
    7,
    'token',
    {},
    { type: 'envelope', run_id: 'r', delta: 'x' },
    { type: 'token', run_id: '', delta: 'x' },
    { type: 'token', run_id: 'r' },
    { type: 'token', run_id: 'r', delta: 3 },
  ]) {
    assert.equal(isTokenEvent(invalid), false, JSON.stringify(invalid))
  }
})

// -- applyToken ---------------------------------------------------------------

test('applyToken appends text deltas in order and never mutates the input', () => {
  const start = createStreamingState()
  const first = applyToken(start, token({ delta: 'Hel' }))
  const second = applyToken(first, token({ delta: 'lo' }))
  assert.equal(first.text, 'Hel')
  assert.equal(second.text, 'Hello')
  assert.equal(second.runId, 'run-1')
  assert.equal(second.role, 'senior')
  assert.equal(second.phase, 'text')
  assert.equal(start.text, '', 'the input state is untouched')
  assert.notEqual(second, first)
})

test('applyToken keeps thinking and text in separate buffers with phase transitions', () => {
  const thinking = applyDeltas(createStreamingState(), [
    { kind: 'thinking', delta: 'Let me ' },
    { kind: 'thinking', delta: 'think.' },
  ])
  assert.equal(thinking.thinking, 'Let me think.')
  assert.equal(thinking.text, '')
  assert.equal(thinking.phase, 'thinking')

  const withText = applyToken(thinking, token({ kind: 'text', delta: 'Answer: 42' }))
  assert.equal(withText.thinking, 'Let me think.', 'reasoning stays separate from the reply')
  assert.equal(withText.text, 'Answer: 42')
  assert.equal(withText.phase, 'text')

  // interleaved deltas keep both buffers intact
  const mixed = applyDeltas(createStreamingState(), [
    { kind: 'thinking', delta: 'a' },
    { kind: 'text', delta: 'b' },
    { kind: 'thinking', delta: 'c' },
  ])
  assert.equal(mixed.thinking, 'ac')
  assert.equal(mixed.text, 'b')
  assert.equal(mixed.phase, 'thinking')
})

test('applyToken tolerates missing/unknown kinds as reply text', () => {
  for (const kind of [undefined, 'text', 'weird', 7]) {
    const state = applyToken(createStreamingState(), {
      ...token({ delta: 'x' }),
      kind: kind as TokenEvent['kind'],
    })
    assert.equal(state.text, 'x', `kind ${String(kind)} should be text`)
    assert.equal(state.thinking, '')
  }
})

test('applyToken resets the draft when the run or the role changes', () => {
  const senior = applyDeltas(createStreamingState(), [
    { kind: 'thinking', delta: 'secret' },
    { kind: 'text', delta: 'senior reply' },
  ])
  const junior = applyToken(senior, token({ role: 'junior', delta: 'junior reply' }))
  assert.equal(junior.role, 'junior')
  assert.equal(junior.text, 'junior reply')
  assert.equal(junior.thinking, '', 'the previous role draft is dropped')
  assert.equal(junior.runId, 'run-1')

  const otherRun = applyToken(junior, token({ run_id: 'run-2', delta: 'fresh' }))
  assert.equal(otherRun.runId, 'run-2')
  assert.equal(otherRun.text, 'fresh')
  assert.equal(otherRun.thinking, '')
})

test('applyToken ignores malformed tokens (same state back, never throws)', () => {
  const state = applyDeltas(createStreamingState(), [{ delta: 'keep' }])
  for (const invalid of [
    null,
    undefined,
    7,
    {},
    { type: 'token', run_id: 'run-1', delta: 'x' }, // missing role
    { type: 'token', run_id: 'run-1', role: 'root', delta: 'x' }, // unknown role
    { type: 'token', run_id: 'run-1', role: 'senior' }, // missing delta
  ]) {
    assert.equal(applyToken(state, invalid), state, JSON.stringify(invalid))
  }
  // an empty delta on the same role is a no-op too
  assert.equal(applyToken(state, token({ delta: '' })), state)
})

test('applyToken bounds each buffer to its tail and marks it truncated', () => {
  const big = 'x'.repeat(STREAMING_MAX_CHARS + 100)
  const clipped = applyToken(createStreamingState(), token({ delta: big }))
  assert.equal(clipped.text.length, STREAMING_MAX_CHARS)
  assert.equal(clipped.textTruncated, true)
  assert.equal(clipped.text, big.slice(-STREAMING_MAX_CHARS))

  // streaming in chunks keeps the newest characters and the truncated flag sticky
  let state = applyDeltas(createStreamingState(), [
    { delta: 'a'.repeat(STREAMING_MAX_CHARS) },
    { delta: 'bcd' },
  ])
  assert.equal(state.text.length, STREAMING_MAX_CHARS)
  assert.equal(state.text.endsWith('bcd'), true)
  assert.equal(state.textTruncated, true)
  state = applyToken(state, token({ delta: 'tail' }))
  assert.equal(state.text.endsWith('tail'), true)
  assert.equal(state.textTruncated, true)
  assert.ok(state.text.length <= STREAMING_MAX_CHARS)
})

test('applyToken never splits a surrogate pair at the truncation point', () => {
  const emoji = '🚀'
  const delta = emoji + 'a'.repeat(STREAMING_MAX_CHARS - 1) // cut lands inside the emoji
  const state = applyToken(createStreamingState(), token({ delta }))
  assert.ok(state.text.length <= STREAMING_MAX_CHARS)
  const first = state.text.codePointAt(0) ?? 0
  assert.ok(first < 0xdc00 || first > 0xdfff, 'the clipped buffer does not start on a low surrogate')
  assert.equal(state.text.startsWith(emoji), false, 'the half-emoji is dropped, not split')
})

// -- applyRuntimeEvent --------------------------------------------------------

test('applyRuntimeEvent: the completed envelope clears the streaming role draft', () => {
  const state = applyDeltas(createStreamingState(), [
    { kind: 'thinking', delta: 'hmm' },
    { kind: 'text', delta: 'reply' },
  ])
  assert.deepEqual(applyRuntimeEvent(state, envelope('senior')), createStreamingState())

  // another role's message does not replace the live draft
  assert.equal(applyRuntimeEvent(state, envelope('junior')), state)
  // and an envelope for another run is unrelated
  assert.equal(applyRuntimeEvent(state, envelope('senior', 'run-2')), state)
})

test('applyRuntimeEvent: run_end and run_error clear everything', () => {
  const state = applyDeltas(createStreamingState(), [{ kind: 'thinking', delta: 'x' }])
  const runEnd: RunEvent = {
    type: 'run_end',
    status: 'completed',
    run_id: 'run-1',
    at: 1_700_000_000,
  }
  const runError: RunEvent = { type: 'run_error', message: 'boom', run_id: 'run-1', at: 1 }
  assert.deepEqual(applyRuntimeEvent(state, runEnd), createStreamingState())
  assert.deepEqual(applyRuntimeEvent(state, runError), createStreamingState())
  assert.equal(applyRuntimeEvent(state, { ...runEnd, run_id: 'run-other' }), state)
})

test('applyRuntimeEvent: unrelated events are no-ops; token events are folded in', () => {
  const state = applyDeltas(createStreamingState(), [{ delta: 'a' }])
  const toolEvent = {
    type: 'tool_started',
    tool: 'read_file',
    args: {},
    run_id: 'run-1',
    at: 1,
  } as unknown as RunEvent
  assert.equal(applyRuntimeEvent(state, toolEvent), state)
  assert.equal(applyRuntimeEvent(state, null), state)
  assert.equal(applyRuntimeEvent(state, {} as RunEvent), state)

  const withToken = applyRuntimeEvent(createStreamingState(), token({ delta: 'live' }))
  assert.equal(withToken.text, 'live')
})

// -- streamingBlocks ----------------------------------------------------------

test('streamingBlocks: empty state renders no blocks', () => {
  assert.deepEqual(streamingBlocks(createStreamingState()), {
    role: null,
    thinking: null,
    text: null,
  })
  assert.deepEqual(streamingBlocks(null), { role: null, thinking: null, text: null })
})

test('streamingBlocks: streaming flags follow the latest kind and surface truncation', () => {
  const thinking = applyDeltas(createStreamingState(), [
    { kind: 'thinking', delta: 'reasoning' },
  ])
  const onlyThinking = streamingBlocks(thinking)
  assert.equal(onlyThinking.role, 'senior')
  assert.deepEqual(onlyThinking.thinking, {
    text: 'reasoning',
    streaming: true,
    truncated: false,
  })
  assert.equal(onlyThinking.text, null)

  const withText = applyToken(thinking, token({ kind: 'text', delta: 'answer' }))
  const both = streamingBlocks(withText)
  assert.equal(both.thinking?.streaming, false, 'thinking completes once visible text starts')
  assert.equal(both.text?.streaming, true)
  assert.equal(both.text?.text, 'answer')

  const clipped = streamingBlocks(
    stateWith({ runId: 'run-1', role: 'junior', text: 't', textTruncated: true, phase: 'text' }),
  )
  assert.equal(clipped.text?.truncated, true)
  assert.equal(clipped.role, 'junior')
})

// -- api.ts wiring: named `token` frames --------------------------------------

interface FakeListener {
  (event: unknown): void
}

/** Minimal EventSource stand-in that can dispatch named events synchronously. */
class FakeEventSource {
  static instances: FakeEventSource[] = []
  url: string
  closed = false
  onmessage: ((ev: unknown) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  private listeners = new Map<string, Set<FakeListener>>()

  constructor(url: string) {
    this.url = url
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, listener: FakeListener): void {
    let bucket = this.listeners.get(type)
    if (!bucket) {
      bucket = new Set()
      this.listeners.set(type, bucket)
    }
    bucket.add(listener)
  }

  removeEventListener(type: string, listener: FakeListener): void {
    this.listeners.get(type)?.delete(listener)
  }

  close(): void {
    this.closed = true
  }

  dispatch(type: string, event: unknown): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event)
  }

  emitMessage(data: string, lastEventId = ''): void {
    this.onmessage?.({ data, lastEventId })
  }
}

/** Run `body` with a fake global EventSource; restores the previous value. */
function withFakeEventSource(body: () => void): void {
  const globals = globalThis as unknown as { EventSource?: unknown }
  const original = globals.EventSource
  FakeEventSource.instances = []
  globals.EventSource = FakeEventSource
  try {
    body()
  } finally {
    globals.EventSource = original
  }
}

test('openRunEventStream: named token frames reach onToken and never move the cursor', () => {
  withFakeEventSource(() => {
    const events: RunEvent[] = []
    const tokens: TokenEvent[] = []
    const stream = openRunEventStream('run/1', {
      after: 4,
      onEvent: (event) => events.push(event),
      onToken: (event) => tokens.push(event),
    })
    const source = FakeEventSource.instances[0]!
    assert.equal(source.url, '/api/runs/run%2F1/events?after=4')

    source.dispatch('token', { data: JSON.stringify(token({ delta: 'a' })) })
    source.dispatch('token', { data: '{not json' })
    source.dispatch('token', { data: JSON.stringify({ type: 'envelope' }) })
    source.dispatch('token', { data: JSON.stringify('nope') })
    assert.equal(tokens.length, 1)
    assert.equal(tokens[0]?.delta, 'a')
    assert.equal(stream.lastEventId(), 4, 'token frames carry no id and do not advance the cursor')

    source.emitMessage(
      JSON.stringify({ type: 'run_status', status: 'running', run_id: 'run/1', at: 1 }),
      '7',
    )
    assert.equal(events.length, 1)
    assert.equal(events[0]?.type, 'run_status')
    assert.equal(stream.lastEventId(), 7)

    stream.close()
    assert.equal(source.closed, true)
    source.dispatch('token', { data: JSON.stringify(token({ delta: 'late' })) })
    assert.equal(tokens.length, 1, 'close() removes the named listener')
  })
})

test('openRunEventStream: token frames are ignored when no onToken is given', () => {
  withFakeEventSource(() => {
    const events: RunEvent[] = []
    const stream = openRunEventStream('r1', { onEvent: (event) => events.push(event) })
    const source = FakeEventSource.instances[0]!
    assert.doesNotThrow(() => source.dispatch('token', { data: JSON.stringify(token()) }))
    assert.deepEqual(events, [])
    stream.close()
  })
})

// -- api.ts wiring: run start opts into token streaming ----------------------

interface FakeResponse {
  ok: boolean
  status: number
  json: () => Promise<unknown>
}

test('startRun sends stream_tokens so the server emits live token frames', async () => {
  const calls: { url: string; init?: RequestInit }[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: typeof input === 'string' ? input : String(input), init })
    return {
      ok: true,
      status: 200,
      json: async () => ({ run_id: 'r1', session: 's1', status: 'running' }),
    } satisfies FakeResponse
  }) as typeof fetch
  try {
    const result = await startRun({ task: 'ship it', stream_tokens: true })
    assert.equal(result.run_id, 'r1')
    assert.equal(calls[0]?.url, '/api/runs')
    assert.equal(calls[0]?.init?.method, 'POST')
    assert.equal(calls[0]?.init?.body, JSON.stringify({ task: 'ship it', stream_tokens: true }))
  } finally {
    globalThis.fetch = original
  }
})
