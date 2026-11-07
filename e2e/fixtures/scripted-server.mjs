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
//   --scenario NAME        approval | slow | plan | folding | delete
//                          (default: approval)
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
//   --senior-model NAME    default: e2e-senior
//   --junior-model NAME    default: e2e-junior
//   --linger-ms MS         slow: how long the senior's first answer takes
//                          (default 30000); folding: the second run's
//                          deliverable delay (the request aborts the moment the
//                          harness stops the run)
//
// Every run a scenario drives is inferred from the transcript as a whole: a
// request with no envelope events starts a run, and a run appended after the
// previous run's decision envelope (an operator task message) starts the next
// one, so multi-run scenarios need no hidden server state.
//
// Endpoints: GET /v1/models, POST /v1/chat/completions (OpenAI wire shape,
// including tool_calls and usage). Everything is offline and deterministic.

import http from 'node:http'

const HELLO_FILE = 'e2e-hello.txt'
const HELLO_CONTENT = 'Hello from the Two Brothers E2E harness.\n'
/** The file the `delete` scenario asks the junior to remove. */
const DELETE_TARGET_FILE = 'e2e-approval-reason.txt'

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

function payloadFor(kind) {
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
        result: `Wrote ${HELLO_FILE} with the scripted greeting.`,
        artifacts: [HELLO_FILE],
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
const WORK_SCENARIOS = new Set(['approval', 'plan', 'folding', 'delete'])

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
function deliverableReply(linger = 0) {
  const reply = { content: JSON.stringify(payloadFor('deliverable')), toolCalls: [] }
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
      // approval scenario (unchanged): one workspace write, then the deliverable
      // once its tool result (approval outcome included) is in the conversation
      if (toolResults > 0) return deliverableReply()
      return toolCall('workspace_write_file', { path: HELLO_FILE, content: HELLO_CONTENT })
    }
    // senior verify slice: claim verification in plain text, call nothing,
    // so the harness' tool loop ends and the review step begins
    return {
      content:
        `Verification: read ${HELLO_FILE} back from the workspace and it ` +
        'matches the requested content. No further checks needed.',
      toolCalls: [],
    }
  }

  const events = parseEvents(messages)
  const last = events[events.length - 1] ?? null

  // slow scenario: only the senior's opening answer lingers; the abortable
  // delay (not a truthy flag) is what makes a run stop unwind in ~1 s
  const linger =
    OPTS.scenario === 'slow' && role === 'senior' && !events.some((e) => e.from === 'senior')
      ? OPTS.lingerMs
      : 0

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
