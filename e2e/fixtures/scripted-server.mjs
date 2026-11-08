// Two Brothers — deterministic scripted OpenAI-compatible model server.
//
// Dependency-free node:http fixture so the browser E2E's scripted scenarios
// (approval-allow / approval-deny / stop) can run against the TypeScript
// backend (`packages/harness/dist/cli.js serve` with TWO_BROTHERS_PROVIDER=
// openai + TWO_BROTHERS_BASE_URL pointing here); this fixture is only the
// *model* side of the conversation.
//
// The harness never sends the response kind over the wire, so the scenario is
// inferred per request from the shared transcript the harness renders into
// the last user message (`[seq] [from -> to] kind: {payload}` lines, see
// packages/harness/src/context.ts):
//
//   - junior + tools + no tool results yet -> one scripted tool call
//                                            (workspace write, or a plan write)
//   - junior + tools + tool results       -> the next scripted tool call, or the
//                                            deliverable JSON once the script
//                                            for this scenario is done
//   - senior + tools (verify slice)       -> plain-text summary, no calls
//   - no envelopes yet / a new operator    -> senior opens (consult, or
//     task after the previous decision       delegation in work scenarios)
//   - last envelope consult  -> junior proposal
//   - last envelope proposal/deliverable -> senior review (accept)
//   - last envelope review (verdict accept) -> senior decision
//
// Scenarios (CLI contract relied on by ../run.mjs):
//
//   --port PORT            (required) TCP port to listen on
//   --scenario NAME        approval | slow | plan | folding | delete | reasoning
//                          | cooperation (default: approval)
//                          approval: one workspace_write_file call, then the
//                                    deliverable after the tool result; the first
//                                    senior opening reply is deliberately
//                                    malformed once so the harness' real
//                                    [[REPAIR_REQUEST]] retry path runs
//                          slow:     the senior's first answer lingers
//                          plan:     work-mode runs whose junior writes one
//                                    whole `todo_write` plan per run and then
//                                    the deliverable (first run: a 3-item plan;
//                                    second run: a 6-item plan; third+ run:
//                                    an empty list that clears the plan)
//                          folding:  work-mode runs whose junior writes TWO
//                                    `todo_write` plans (two tool cards) and then
//                                    the deliverable; the snapshots differ in
//                                    item count so the runtime events stay
//                                    distinct, and the second run lingers before
//                                    that deliverable so the browser can observe
//                                    its still-open rows
//                          delete:   one `workspace_delete_file` call instead of
//                                    the write, then the deliverable; the
//                                    approval request carries the documented
//                                    DELETE_APPROVAL_REASON (the browser scenario
//                                    asserts the card renders it verbatim)
//                          reasoning: a task whose text carries the
//                                    `e2e-reasoning` marker is answered with
//                                    real SSE chat-completion chunks that stream
//                                    `delta.reasoning_content` thinking before
//                                    the reply content, so the harness' real
//                                    streaming path persists bounded reasoning
//                                    runtime events; a task without the marker
//                                    keeps the historical non-streaming JSON
//                                    reply (and persists no reasoning record)
//                          cooperation: run 1 writes `e2e-undo-marker.txt` once
//                                    and then delivers; later runs only deliver,
//                                    so a session can collect a second operator
//                                    turn for fork/rewind. A task whose text
//                                    carries the `e2e-steer` marker gets an
//                                    abortable slow senior opening instead, so
//                                    the browser can steer a still-running run
//                                    without waiting for a model reply.
//   --senior-model NAME    default: e2e-senior
//   --junior-model NAME    default: e2e-junior
//   --linger-ms MS         slow: how long the senior's first answer takes
//                          (default 30000); folding: the second run's
//                          deliverable delay; cooperation: the senior's
//                          opening delay for an `e2e-steer` task (every
//                          request aborts the moment the harness stops the run)
//
// Every run a scenario drives is inferred from the transcript as a whole: a
// request with no envelope events starts a run, and a run appended after the
// previous run's decision envelope (an operator task message) starts the next
// one, so multi-run scenarios need no hidden server state.
//
// Endpoints: GET /v1/models, POST /v1/chat/completions (OpenAI wire shape,
// including tool_calls and usage; the `reasoning` scenario answers a streaming
// request (`stream: true`) with `text/event-stream` chunks and everything else
// with the non-streaming JSON completion). Everything is offline and
// deterministic.

import http from 'node:http'

const HELLO_FILE = 'e2e-hello.txt'
const HELLO_CONTENT = 'Hello from the Two Brothers E2E harness.\n'
/** The file the `delete` scenario asks the junior to remove. */
const DELETE_TARGET_FILE = 'e2e-approval-reason.txt'
/** The created-then-undone file of the `cooperation` scenario. */
const COOPERATION_FILE = 'e2e-undo-marker.txt'
const COOPERATION_CONTENT = 'Created by the scripted cooperation run.\n'
/** Marker in a `cooperation` task that asks for the abortable slow opening. */
const STEER_MARKER = 'e2e-steer'

function parseArgs(argv) {
  const opts = {
    scenario: 'approval',
    seniorModel: 'e2e-senior',
    juniorModel: 'e2e-junior',
    lingerMs: 30000,
    port: null,
  }
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]
    const value = argv[i + 1]
    if (key === '--port') opts.port = Number.parseInt(value, 10)
    else if (key === '--scenario') opts.scenario = value
    else if (key === '--senior-model') opts.seniorModel = value
    else if (key === '--junior-model') opts.juniorModel = value
    else if (key === '--linger-ms') opts.lingerMs = Number.parseInt(value, 10)
    else {
      process.stderr.write(`unknown argument: ${key}\n`)
      process.exit(2)
    }
  }
  if (!Number.isFinite(opts.port) || opts.port <= 0) {
    process.stderr.write('--port PORT is required\n')
    process.exit(2)
  }
  return opts
}

const OPTS = parseArgs(process.argv.slice(2))

// -- deterministic payloads (strict-valid shapes for every protocol kind) --

function payloadFor(kind, deliverableFile = HELLO_FILE) {
  const task = 'the scripted E2E task'
  switch (kind) {
    case 'consult':
      return {
        task,
        ask: 'How should we approach it?',
        expect: 'proposal',
        deadline_hint: 'within the day',
      }
    case 'delegation':
      return {
        work: 'Do the delegated part of the task.',
        acceptance: ['deliverable produced'],
        return: 'deliverable',
        notes: '',
      }
    case 'proposal':
      return {
        title: 'Scripted plan',
        answer: 'A deterministic step-by-step plan.',
        rationale: 'Scripted rationale.',
        risks: ['none'],
        confidence: 0.9,
        asks: [],
      }
    case 'review':
      return {
        verdict: 'accept',
        notes: 'The scripted deliverable meets the criteria.',
        points: [],
      }
    case 'decision':
      return {
        decision: 'Proceed with the scripted plan.',
        rationale: 'Scripted decision rationale.',
        confidence: 0.95,
        dissent: null,
        accepted_proposals: ['Scripted plan'],
      }
    case 'deliverable':
      return {
        result: `Wrote ${deliverableFile} with the scripted greeting.`,
        artifacts: [deliverableFile],
        notes: 'The write went through the operator approval flow.',
        confidence: 0.99,
      }
    default:
      return { text: 'scripted reply' }
  }
}

// -- transcript parsing -------------------------------------------------------

const EVENT_LINE = /^\[(\d+)\] \[(\S+) -> (\S+)\] (\w+): (\{.*)$/

/** Envelope lines `[seq] [from -> to] kind: {json}` from the rendered transcript. */
function parseEvents(messages) {
  const events = []
  for (const message of messages) {
    if (message.role !== 'user' || typeof message.content !== 'string') continue
    for (const line of message.content.split('\n')) {
      const match = EVENT_LINE.exec(line.trim())
      if (!match) continue
      let payload = null
      try {
        payload = JSON.parse(match[5])
      } catch {
        payload = null
      }
      events.push({ from: match[2], to: match[3], kind: match[4], payload })
    }
  }
  return events
}

// -- scripted reply selection --------------------------------------------------

let callCounter = 0

/** Scenarios whose runs are started in work mode (the senior delegates). */
const WORK_SCENARIOS = new Set(['approval', 'plan', 'folding', 'delete', 'cooperation'])

/**
 * Plan snapshots the `plan` scenario writes, one whole-list snapshot per run:
 * run 1 = a 3-item plan (one of each status), run 2 = a 6-item plan that needs
 * the bounded panel + "+N more" expand control, run 3+ = an empty list (the
 * model cleared the plan).
 */
const PLAN_RUNS = [
  [
    { content: 'Inspect the workspace', status: 'completed' },
    { content: 'Draft the migration plan', status: 'in_progress' },
    { content: 'Verify the plan', status: 'pending' },
  ],
  [
    { content: 'Step one', status: 'completed' },
    { content: 'Step two', status: 'completed' },
    { content: 'Active step', status: 'in_progress' },
    { content: 'Pending step A', status: 'pending' },
    { content: 'Pending step B', status: 'pending' },
    { content: 'Pending step C', status: 'pending' },
  ],
  [],
]

/** The plan snapshot for the `plan` scenario's `runIndex`-th run (0-based). */
function planForRun(runIndex) {
  return runIndex >= 0 && runIndex < PLAN_RUNS.length ? PLAN_RUNS[runIndex] : []
}

/**
 * The two plan snapshots the `folding` scenario writes per tool iteration: two
 * `todo_write` calls leave two tool cards in the transcript, enough for the
 * browser fold summary (a completed run folds two tool cards into one line).
 *
 * The snapshots deliberately differ in item COUNT (2 vs 3) as well as statuses.
 * The runtime event payload clips object arguments to strings (`[object Object]`)
 * and the event timestamp is whole seconds, so two calls with the same item
 * count and the same result text would produce byte-identical `tool_started` /
 * `tool_completed` events. The web app de-duplicates runtime events by exact
 * JSON, so such identical calls would collapse into ONE tool card and no fold
 * group would ever form.
 */
function foldingPlan(written) {
  if (written === 0) {
    return [
      { content: 'First folding step', status: 'in_progress' },
      { content: 'Second folding step', status: 'pending' },
    ]
  }
  return [
    { content: 'First folding step', status: 'completed' },
    { content: 'Second folding step', status: 'completed' },
    { content: 'Third folding step', status: 'in_progress' },
  ]
}

/**
 * The `approval` scenario seeds exactly one payload-repair cycle: its first
 * senior opening reply is a deliberately malformed delegation, so the harness
 * runs its REAL repair path once (a `[[REPAIR_REQUEST]]` message envelope, one
 * re-ask, then a valid delegation). The browser scenario asserts the neutral
 * "Reply format repair" system activity and that no raw marker ever renders —
 * without relying on an accidental schema failure.
 */
let approvalRepairSeeded = false
const MALFORMED_DELEGATION_REPLY = JSON.stringify({
  work: 42,
  acceptance: 'not-a-list',
  return: false,
})

/** True when the last transcript event is the harness' payload-repair re-ask. */
function isRepairRequest(last) {
  if (!last || last.from !== 'user' || last.kind !== 'message') return false
  const text = last.payload && typeof last.payload === 'object' ? last.payload.text : ''
  return String(text ?? '').includes('[[REPAIR_REQUEST]]')
}

/**
 * Wait until just after the next wall-clock second boundary.
 *
 * Envelope timestamps are whole seconds and the web client breaks equal-time
 * ties message-group-first, so a run whose tool loop straddles a second
 * boundary can get a chat envelope ordered between its two tool cards — which
 * splits the fold group. Aligning each `folding` run's first reply to a fresh
 * second keeps the whole (fast) tool loop inside one second, making the fold
 * grouping deterministic without touching product code.
 */
function foldingAlignMs() {
  return 1000 - (Date.now() % 1000) + 50
}

// -- reasoning-replay scenario -------------------------------------------------
//
// The browser scenario drives the real streaming path: the web app always asks
// the backend for live token streaming (`stream_tokens: true`), the backend
// therefore calls the provider with its thinking/text sinks, the provider sends
// `stream: true`, and this fixture answers that request with genuine SSE
// chunks. `delta.reasoning_content` is the OpenAI-compatible thinking side
// channel the harness forwards to `ChatOptions.onThinkingDelta` and persists as
// one bounded `reasoning` runtime event per provider call.
//
// The reasoning session is marked by a task containing `e2e-reasoning`; every
// provider call in that run streams thinking (one distinct scripted text per
// node kind). A task without the marker keeps the historical JSON reply, so the
// same fixture process also proves that a non-streaming reply persists NO
// reasoning record. Keep the prose markers in sync with ../run.mjs.

const REASONING_MARKER = 'e2e-reasoning'

/** SSE frames are small so the browser backend really consumes a delta stream. */
const REASONING_CHUNK_CHARS = 256

/**
 * The senior consult call's thinking: includes an ANSI escape and a BEL control
 * byte (both must be sanitized away by the backend) plus a literal HTML-looking
 * string (which must survive only as text in the replayed row).
 */
const REASONING_HTML =
  'Scripted consult reasoning: \u001b[31mANSI red\u001b[0m\u0007 and ' +
  '<img src=x onerror="window.__e2e_reasoning_pwned=1"> stay literal text.'

/**
 * The junior proposal call's thinking: deliberately longer than the backend's
 * 10 000-character cap, so the persisted record must be head+tail bounded and
 * flagged truncated (the browser asserts the documented clipping marker).
 * LONG_REASONING_HEAD/LONG_REASONING_TAIL are asserted by ../run.mjs.
 */
const REASONING_LONG = 'LONG_REASONING_HEAD ' + 'x'.repeat(12_000) + ' LONG_REASONING_TAIL'

/** Review/decision nodes stream a short, clean thinking record. */
const REASONING_SHORT = 'Weighing the scripted proposal before the senior decision.'

/**
 * The reasoning text this call should stream, by the node kind the reply
 * answers (the same inference `decide()` already makes for the payload).
 */
function reasoningForKind(kind) {
  if (kind === 'consult') return REASONING_HTML
  if (kind === 'proposal') return REASONING_LONG
  if (kind === 'review' || kind === 'decision') return REASONING_SHORT
  return undefined
}

/** True when the rendered transcript carries an operator message with `marker`. */
function transcriptHasMarker(messages, marker) {
  for (const message of messages) {
    if (message.role !== 'user' || typeof message.content !== 'string') continue
    if (message.content.includes(marker)) return true
  }
  return false
}

/** True when the rendered transcript carries an operator task with the marker. */
function transcriptHasReasoning(messages) {
  return transcriptHasMarker(messages, REASONING_MARKER)
}

/** One assistant reply carrying a single tool call. */
function toolCall(name, args) {
  callCounter += 1
  return {
    content: '',
    toolCalls: [
      {
        id: `e2e-tool-call-${callCounter}`,
        type: 'function',
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  }
}

/** Final tool-loop reply: the structured deliverable, optionally lingered. */
function deliverableReply(linger = 0, file = HELLO_FILE) {
  const reply = { content: JSON.stringify(payloadFor('deliverable', file)), toolCalls: [] }
  if (linger > 0) reply.linger = linger
  return reply
}

/** A fresh operator task appended after a finished run (not a repair re-ask). */
function isNewTask(last) {
  if (last === null) return true
  if (last.from !== 'user' || last.kind !== 'message') return false
  const text = last.payload && typeof last.payload === 'object' ? last.payload.text : ''
  return !String(text ?? '').includes('[[REPAIR_REQUEST]]')
}

function decide(body) {
  const messages = Array.isArray(body.messages) ? body.messages : []
  const role = body.model === OPTS.seniorModel ? 'senior' : 'junior'
  const wantsTools = Array.isArray(body.tools) && body.tools.length > 0
  const toolResults = messages.filter((m) => m.role === 'tool').length

  if (wantsTools) {
    const events = parseEvents(messages)
    // finished cooperation cycles so far: each completed run ends with a
    // senior decision envelope, so this is the 0-based index of the own run
    const completedRuns = events.filter(
      (e) => e.from === 'senior' && e.kind === 'decision',
    ).length
    if (role === 'junior') {
      if (OPTS.scenario === 'plan') {
        // one whole-plan snapshot per run, then the deliverable
        if (toolResults === 0) return toolCall('todo_write', { todos: planForRun(completedRuns) })
        return deliverableReply()
      }
      if (OPTS.scenario === 'folding') {
        // two plan writes per run => two tool rows for the fold assertions; on
        // the second run the deliverable lingers so the browser sees the
        // followed run's still-open rows before they finish
        if (toolResults < 2) {
          return toolCall('todo_write', { todos: foldingPlan(toolResults) })
        }
        const linger = completedRuns >= 1 ? OPTS.lingerMs : 0
        return deliverableReply(linger)
      }
      if (OPTS.scenario === 'delete') {
        // one delete call: its approval carries DELETE_APPROVAL_REASON, then the
        // deliverable after the operator decision (the tool result)
        if (toolResults > 0) return deliverableReply()
        return toolCall('workspace_delete_file', { path: DELETE_TARGET_FILE })
      }
      if (OPTS.scenario === 'cooperation') {
        // run 1 writes the marker file once (the undo record to apply); later
        // runs only deliver, so the session can grow a second operator turn
        // without parking on another approval
        if (completedRuns === 0 && toolResults === 0) {
          return toolCall('workspace_write_file', {
            path: COOPERATION_FILE,
            content: COOPERATION_CONTENT,
          })
        }
        return deliverableReply(0, COOPERATION_FILE)
      }
      // approval scenario (unchanged): one workspace write, then the deliverable
      // once its tool result (approval outcome included) is in the conversation
      if (toolResults > 0) return deliverableReply()
      return toolCall('workspace_write_file', { path: HELLO_FILE, content: HELLO_CONTENT })
    }
    // senior verify slice: claim verification in plain text, call nothing,
    // so the harness' tool loop ends and the review step begins
    const verifiedFile = OPTS.scenario === 'cooperation' ? COOPERATION_FILE : HELLO_FILE
    return {
      content:
        `Verification: read ${verifiedFile} back from the workspace and it ` +
        'matches the requested content. No further checks needed.',
      toolCalls: [],
    }
  }

  const events = parseEvents(messages)
  const last = events[events.length - 1] ?? null

  // slow scenario: only the senior's opening answer lingers; the abortable
  // delay (not a truthy flag) is what makes a run stop unwind in ~1 s.
  // cooperation: a task carrying the `e2e-steer` marker gets the same
  // abortable slow opening, so the browser has a deterministic steering
  // window on a genuinely running run.
  const slowLinger =
    OPTS.scenario === 'slow' && role === 'senior' && !events.some((e) => e.from === 'senior')
      ? OPTS.lingerMs
      : 0
  const steerLinger =
    OPTS.scenario === 'cooperation' &&
    role === 'senior' &&
    !events.some((e) => e.from === 'senior') &&
    transcriptHasMarker(messages, STEER_MARKER)
      ? OPTS.lingerMs
      : 0
  const linger = Math.max(slowLinger, steerLinger)

  const newTask = isNewTask(last)
  let kind
  if (OPTS.scenario === 'approval' && role === 'senior' && isRepairRequest(last)) {
    // retry of the deliberately malformed opening: answer with a valid
    // delegation so the run can proceed to the real approval flow
    kind = 'delegation'
  } else if (newTask) {
    if (OPTS.scenario === 'approval' && role === 'senior' && !approvalRepairSeeded) {
      approvalRepairSeeded = true
      return { content: MALFORMED_DELEGATION_REPLY, toolCalls: [] }
    }
    // no transcript yet, or an operator task appended after the previous run's
    // decision: the senior opens the new cycle
    kind = role === 'senior' ? (WORK_SCENARIOS.has(OPTS.scenario) ? 'delegation' : 'consult') : 'proposal'
  } else if (last.from === 'senior' && (last.kind === 'consult' || last.kind === 'delegation')) {
    kind = last.kind === 'delegation' ? 'deliverable' : 'proposal'
  } else if (last.from === 'junior') {
    kind = 'review'
  } else if (last.kind === 'review') {
    const verdict = last.payload && typeof last.payload === 'object'
      ? String(last.payload.verdict ?? 'accept')
      : 'accept'
    kind = verdict === 'accept' ? 'decision' : 'proposal'
  } else {
    kind = role === 'senior' ? 'decision' : 'proposal'
  }

  // the junior's deliverable answer after a delegation rides the tool loop
  // (wantsTools branch above); a plain-chat fallback is a proposal shape
  if (kind === 'deliverable') kind = 'proposal'
  const reply = { content: JSON.stringify(payloadFor(kind)), toolCalls: [] }
  if (linger > 0) reply.linger = linger
  // folding determinism: open each run on a fresh second so its tool loop (and
  // therefore its fold group) cannot straddle an envelope timestamp boundary
  if (OPTS.scenario === 'folding' && role === 'senior' && newTask) {
    reply.linger = Math.max(reply.linger ?? 0, foldingAlignMs())
  }
  // reasoning-replay: attach the scripted thinking for this node kind. The HTTP
  // layer streams replies that carry it as SSE `delta.reasoning_content`
  // chunks; a task without the marker never gets one.
  if (OPTS.scenario === 'reasoning' && transcriptHasReasoning(messages)) {
    const reasoning = reasoningForKind(kind)
    if (reasoning !== undefined) reply.reasoning = reasoning
  }
  return reply
}

// -- OpenAI-compatible HTTP surface --------------------------------------------

function completionJson(model, decision) {
  return {
    id: `chatcmpl-e2e-${(++callCounter).toString(36)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: decision.content, tool_calls: decision.toolCalls },
        finish_reason: decision.toolCalls.length > 0 ? 'tool_calls' : 'stop',
      },
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      prompt_tokens_details: { cached_tokens: 0 },
    },
  }
}

// -- streaming (reasoning-replay scenario) -------------------------------------

/** One SSE frame in the OpenAI chat-completion chunk shape. */
function streamFrame(model, delta, finishReason = null) {
  return (
    'data: ' +
    JSON.stringify({
      id: 'chatcmpl-e2e-stream',
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    }) +
    '\n\n'
  )
}

/** Split text into deterministic SSE-sized chunks (UTF-16 code units). */
function chunksOf(text, size) {
  const chunks = []
  for (let at = 0; at < text.length; at += size) chunks.push(text.slice(at, at + size))
  return chunks
}

/**
 * Answer a streaming chat completion with real SSE: the scripted thinking as
 * `delta.reasoning_content` chunks first, then the reply content (and tool
 * calls), one usage chunk and `[DONE]`. The harness' OpenAI adapter reassembles
 * exactly the JSON it would have received from the non-streaming endpoint, so
 * the run behaves identically while the thinking side channel is populated.
 */
function sendStreamedCompletion(res, body, decision) {
  const model = String(body.model ?? '')
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
  for (const chunk of chunksOf(String(decision.reasoning), REASONING_CHUNK_CHARS)) {
    res.write(streamFrame(model, { reasoning_content: chunk }))
  }
  for (const chunk of chunksOf(String(decision.content ?? ''), REASONING_CHUNK_CHARS)) {
    res.write(streamFrame(model, { content: chunk }))
  }
  decision.toolCalls.forEach((call, index) => {
    res.write(
      streamFrame(model, {
        tool_calls: [{ index, id: call.id, type: 'function', function: call.function }],
      }),
    )
  })
  res.write(streamFrame(model, {}, decision.toolCalls.length > 0 ? 'tool_calls' : 'stop'))
  // A final usage-only chunk mirrors OpenAI's include_usage stream shape.
  res.write(
    'data: ' +
      JSON.stringify({
        id: 'chatcmpl-e2e-stream',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
          prompt_tokens_details: { cached_tokens: 0 },
        },
      }) +
      '\n\n',
  )
  res.write('data: [DONE]\n\n')
  res.end()
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')))
      } catch {
        reject(new Error('invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  try {
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          object: 'list',
          data: [OPTS.seniorModel, OPTS.juniorModel].map((id) => ({
            id,
            object: 'model',
            created: 0,
            owned_by: 'two-brothers-e2e',
          })),
        }),
      )
      return
    }
    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      const body = await readJson(req)
      const decision = decide(body)
      // reasoning-replay: a streaming request whose scripted reply carries
      // thinking text is answered with real SSE (thinking chunks first, then the
      // content), so the harness' streaming path persists bounded reasoning
      // runtime events. Everything else keeps the JSON reply.
      if (body.stream === true && typeof decision.reasoning === 'string') {
        sendStreamedCompletion(res, body, decision)
        return
      }
      const send = () => {
        if (res.writableEnded) return
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(completionJson(String(body.model ?? ''), decision)))
      }
      if (decision.linger && decision.linger > 0) {
        // a stopped run aborts the fetch: drop the reply and end quietly so
        // the harness' cancellation unwinds immediately
        const timer = setTimeout(send, decision.linger)
        req.on('close', () => {
          clearTimeout(timer)
          res.end()
        })
      } else {
        send()
      }
      return
    }
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: `unknown path: ${url.pathname}` } }))
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: err.message } }))
  }
})

server.listen(OPTS.port, '127.0.0.1', () => {
  process.stdout.write(
    `scripted model server on 127.0.0.1:${OPTS.port} ` +
      `(scenario: ${OPTS.scenario}, senior: ${OPTS.seniorModel}, junior: ${OPTS.juniorModel})\n`,
  )
})
