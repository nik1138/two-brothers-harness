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
//   - junior + tools + no tool results yet -> one workspace_write_file call
//   - junior + tools + tool results       -> the deliverable JSON
//   - senior + tools (verify slice)       -> plain-text summary, no calls
//   - no envelopes yet                    -> senior opens (consult, or
//                                            delegation in the approval
//                                            scenario = work mode)
//   - last envelope consult  -> junior proposal
//   - last envelope proposal/deliverable -> senior review (accept)
//   - last envelope review (verdict accept) -> senior decision
//
// Scenarios (CLI contract relied on by ../run.mjs):
//
//   --port PORT            (required) TCP port to listen on
//   --scenario NAME        approval | slow   (default: approval)
//   --senior-model NAME    default: e2e-senior
//   --junior-model NAME    default: e2e-junior
//   --linger-ms MS         slow scenario: how long the senior's first answer
//                          takes (default 30000); the request aborts the
//                          moment the harness stops the run, so a stop
//                          unwinds immediately instead of after the linger
//
// Endpoints: GET /v1/models, POST /v1/chat/completions (OpenAI wire shape,
// including tool_calls and usage). Everything is offline and deterministic.

import http from 'node:http'

const HELLO_FILE = 'e2e-hello.txt'
const HELLO_CONTENT = 'Hello from the Two Brothers E2E harness.\n'

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

function decide(body) {
  const messages = Array.isArray(body.messages) ? body.messages : []
  const role = body.model === OPTS.seniorModel ? 'senior' : 'junior'
  const wantsTools = Array.isArray(body.tools) && body.tools.length > 0
  const hasToolResults = messages.some((m) => m.role === 'tool')

  if (wantsTools) {
    if (role === 'junior') {
      if (hasToolResults) {
        // the tool result (approval outcome included) is in the conversation:
        // answer with the plain deliverable JSON, like a real tool model
        return { content: JSON.stringify(payloadFor('deliverable')), toolCalls: [] }
      }
      callCounter += 1
      return {
        content: '',
        toolCalls: [
          {
            id: `e2e-tool-call-${callCounter}`,
            type: 'function',
            function: {
              name: 'workspace_write_file',
              arguments: JSON.stringify({ path: HELLO_FILE, content: HELLO_CONTENT }),
            },
          },
        ],
      }
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

  let kind
  if (last === null) {
    kind = role === 'senior' ? (OPTS.scenario === 'approval' ? 'delegation' : 'consult') : 'proposal'
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
  return { content: JSON.stringify(payloadFor(kind)), toolCalls: [], linger }
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
