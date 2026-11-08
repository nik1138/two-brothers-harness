/**
 * Wave 23: mid-run operator steering.
 *
 * A steer text is an operator aside delivered to a cooperation cycle that is
 * already working. The transport is deliberately boring: an ORDINARY protocol
 * `message` envelope from "user" to "senior" (payload `{text}`), prefixed with
 * `STEERING_PREFIX` so the model can tell it from the task — no new protocol
 * kind/field, no session-format change. The harness drains an injectable
 * callback at every state-machine node boundary and at every tool-loop
 * iteration; the runtime holds a bounded in-memory queue per run; the server
 * exposes it as `POST /api/runs/{run_id}/steer` with an honest 400/404/409
 * contract and never fakes an early event.
 *
 * Everything here is hermetic: scripted providers, in-process loopback HTTP,
 * temp session dirs. No network, no subprocesses.
 *
 * Run with: node tests/run-all.ts (or node --test tests/steering.test.ts)
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { resolveConfig } from "../src/config.ts";
import type { ChatMessage, ToolCall } from "../src/context.ts";
import {
  MAX_STEERING_ENVELOPES_PER_RUN,
  STEERING_PREFIX,
  TwoBrothersHarness,
} from "../src/harness.ts";
import {
  AnthropicProvider,
  GoogleProvider,
  MockProvider,
  type FetchLike,
  type ModelProviderConfig,
  type Provider,
  type Tool,
  type ToolChatOptions,
  type ToolChatResponse,
} from "../src/provider.ts";
import {
  RunManager,
  RunRecord,
  STEER_QUEUE_MAX,
  STEER_TEXT_MAX_CHARS,
  STEERABLE_STATES,
} from "../src/runtime.ts";
import { createServer, type ServerHandle, type ServerOptions } from "../src/server.ts";
import type { RuntimeEvent } from "../src/runevents.ts";
import { SessionStore } from "../src/session.ts";
import { SharedContext } from "../src/context.ts";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tmpdir(prefix: string): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const cfg = (extra: Record<string, unknown> = {}) =>
  resolveConfig({ provider: "mock", mode: "consult", ...extra });

/** The strict-valid baseline reply for every structured kind a node asks for. */
const VALID: Record<string, Record<string, unknown>> = {
  consult: { task: "t", ask: "a", expect: "proposal", deadline_hint: "today" },
  proposal: { title: "P", answer: "A", rationale: "R", risks: [], confidence: 0.7, asks: [] },
  delegation: { work: "W", acceptance: ["done"], return: "deliverable", notes: "" },
  deliverable: { result: "R", artifacts: [], notes: "", confidence: 0.8 },
  review: { verdict: "accept", notes: "", points: [] },
  decision: { decision: "D", rationale: "", confidence: 0.7, dissent: null, accepted_proposals: [] },
};

function validReply(kind: string): string {
  return JSON.stringify(VALID[kind]);
}

/** One scripted `chatWithTools` round: tool calls and/or final text. */
interface ToolRound {
  toolCalls?: ToolCall[];
  text?: string;
}

interface RecordedCall {
  channel: "chat" | "tools";
  kind: string;
  messages: ChatMessage[];
}

/**
 * A scripted provider recording every request. Empty queues answer with the
 * strict-valid payload for the kind, so a test only scripts what it cares
 * about. Same shape as the tool-calling suite helper, kept local because test
 * files do not share helpers.
 */
class ScriptedProvider implements Provider {
  readonly calls: RecordedCall[] = [];
  private readonly toolQueues: Record<string, ToolRound[]>;
  private readonly chatQueues: Record<string, string[]>;

  constructor(
    script: { tools?: Record<string, ToolRound[]>; chat?: Record<string, string[]> } = {},
  ) {
    this.toolQueues = Object.fromEntries(
      Object.entries(script.tools ?? {}).map(([key, value]) => [key, [...value]]),
    );
    this.chatQueues = Object.fromEntries(
      Object.entries(script.chat ?? {}).map(([key, value]) => [key, [...value]]),
    );
  }

  private record(channel: "chat" | "tools", kind: string, messages: ChatMessage[]): void {
    this.calls.push({
      channel,
      kind,
      messages: messages.map((message) => ({ ...message })),
    });
  }

  async chat(messages: ChatMessage[], responseKind = "message"): Promise<string> {
    this.record("chat", responseKind, messages);
    const queue = this.chatQueues[responseKind];
    if (queue !== undefined && queue.length > 0) return queue.shift()!;
    return validReply(responseKind);
  }

  async chatWithTools(
    messages: ChatMessage[],
    _tools: Tool[],
    options: ToolChatOptions = {},
  ): Promise<ToolChatResponse> {
    const kind = options.responseKind ?? "deliverable";
    this.record("tools", kind, messages);
    const queue = this.toolQueues[kind];
    const round = queue?.shift();
    if (round === undefined) return { content: validReply(kind), toolCalls: [] };
    return { content: round.text ?? "", toolCalls: round.toolCalls ?? [] };
  }

  chatCalls(kind?: string): RecordedCall[] {
    return this.calls.filter(
      (call) => call.channel === "chat" && (kind === undefined || call.kind === kind),
    );
  }

  toolsCalls(kind?: string): RecordedCall[] {
    return this.calls.filter(
      (call) => call.channel === "tools" && (kind === undefined || call.kind === kind),
    );
  }
}

function fakeTool(name: string): Tool {
  return {
    name,
    description: `fake ${name}`,
    parameters: { type: "object", properties: {} },
    execute: () => JSON.stringify({ tool: name, status: "ok" }),
  };
}

function toolCall(id: string, name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id, name, args };
}

/** User content of one recorded call (the rendered transcript / user turns). */
function userContents(call: RecordedCall): string[] {
  return call.messages.filter((message) => message.role === "user").map((message) => message.content);
}

/** Parse one JSONL session file into envelopes (dense `seq` order). */
function readSession(file: string): Array<Record<string, any>> {
  return fs
    .readFileSync(file, "utf-8")
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, any>);
}

// ---------------------------------------------------------------------------
// harness seam: drain at node boundaries + tool-loop iterations
// ---------------------------------------------------------------------------

test("a steer envelope is an ordinary user→senior message and the next model call sees it", async () => {
  const dir = tmpdir("tb-steer-h-");
  try {
    const file = path.join(dir.root, "session.jsonl");
    const ctx = new SharedContext(new SessionStore(file));
    const senior = new ScriptedProvider();
    const junior = new ScriptedProvider();
    const queue = ["hold the constraint: use Postgres"];
    const harness = new TwoBrothersHarness(cfg(), {
      senior,
      junior,
      steering: () => queue.splice(0, queue.length),
    });
    const result = await harness.run("pick a database", ctx);

    // The envelope is the initial-task shape: user -> senior, kind message,
    // payload {text}; only the payload text carries the documented marker.
    const steer = result.messages[1]!;
    assert.equal(steer.from, "user");
    assert.equal(steer.to, "senior");
    assert.equal(steer.kind, "message");
    assert.deepEqual(Object.keys(steer.payload).sort(), ["text"]);
    assert.equal(steer.payload.text, `${STEERING_PREFIX}hold the constraint: use Postgres`);
    assert.deepEqual(Object.keys(steer).sort(), ["from", "id", "kind", "payload", "seq", "to", "ts", "v"]);

    // Dense seq: task (1), steer (2), then the four consult replies.
    assert.deepEqual(
      result.messages.map((message) => [message.seq, message.kind]),
      [
        [1, "message"],
        [2, "message"],
        [3, "consult"],
        [4, "proposal"],
        [5, "review"],
        [6, "decision"],
      ],
    );

    // Model-visible: the FIRST provider call (senior_open) already renders the
    // steer inside "Context events:" — it landed at the node boundary before.
    const firstPrompt = userContents(senior.calls[0]!)[0] ?? "";
    assert.ok(firstPrompt.includes("[[OPERATOR STEER]] hold the constraint: use Postgres"));
    assert.ok(firstPrompt.includes("[2] [user -> senior] message:"), "dense seq in the transcript");
    assert.ok(firstPrompt.startsWith("[[TASK]]\npick a database\n[[/TASK]]"), "task markers byte-stable");

    // Session JSONL: one ordinary envelope per line, same shape, dense seq.
    const persisted = readSession(file);
    assert.deepEqual(
      persisted.map((entry) => entry.seq),
      [1, 2, 3, 4, 5, 6],
    );
    assert.deepEqual(persisted[1], {
      seq: 2,
      v: 1,
      ts: steer.ts,
      id: steer.id,
      from: "user",
      to: "senior",
      kind: "message",
      payload: { text: steer.payload.text },
    });
    assert.equal(persisted.length, result.messages.length);
  } finally {
    dir.cleanup();
  }
});

test("the drain callback is read once per node boundary, in order, and every text lands", async () => {
  const senior = new ScriptedProvider();
  const junior = new ScriptedProvider();
  let calls = 0;
  const harness = new TwoBrothersHarness(cfg(), {
    senior,
    junior,
    steering: () => {
      calls += 1;
      if (calls === 1) return ["first steer"];
      if (calls === 2) return ["second steer"];
      return [];
    },
  });
  const result = await harness.run("order matters");

  // Four nodes in a consult cycle = four boundaries, one callback read each.
  assert.equal(calls, 4);
  assert.deepEqual(
    result.messages.map((message) => message.kind),
    ["message", "message", "consult", "message", "proposal", "review", "decision"],
  );
  assert.equal(result.messages[1]!.payload.text, `${STEERING_PREFIX}first steer`);
  assert.equal(result.messages[3]!.payload.text, `${STEERING_PREFIX}second steer`);
  // Drain-once ordering: the first steer precedes the consult reply, the second
  // precedes the proposal that could react to it.
  assert.ok(result.messages[1]!.seq! < result.messages[2]!.seq!);
  assert.ok(result.messages[3]!.seq! < result.messages[4]!.seq!);
  const proposalPrompt = userContents(junior.chatCalls("proposal")[0]!)[0] ?? "";
  assert.ok(proposalPrompt.includes("first steer"));
  assert.ok(proposalPrompt.includes("second steer"));
});

test("tool-loop iterations drain steering and the next tool request sees it", async () => {
  const senior = new ScriptedProvider();
  const junior = new ScriptedProvider({
    tools: {
      deliverable: [
        { toolCalls: [toolCall("call-1", "notes")] },
        { text: validReply("deliverable") },
      ],
    },
  });
  let calls = 0;
  const harness = new TwoBrothersHarness(cfg({ mode: "work" }), {
    senior,
    junior,
    toolScopes: { junior: [fakeTool("notes")] },
    steering: () => {
      calls += 1;
      // Boundary 1 (senior_open), boundary 2 (junior_answer), then tool-loop
      // iteration 1 and 2: the steer arrives on the SECOND loop iteration, so
      // only the NEXT request of the in-flight conversation can see it.
      if (calls === 4) return ["mid-tool steer: stop editing that file"];
      return [];
    },
  });
  const result = await harness.run("do the work");

  const rounds = junior.toolsCalls("deliverable");
  assert.equal(rounds.length, 2);
  // The first tool request predates the drained text...
  assert.ok(!JSON.stringify(rounds[0]!.messages).includes(STEERING_PREFIX));
  // ...the second re-renders the opening system+user pair from the shared
  // context, so the steer reaches the in-flight tool conversation inside the
  // canonical transcript (at its dense seq) — never as a second user turn,
  // which Anthropic and Google would reject.
  const second = rounds[1]!.messages;
  assert.deepEqual(
    second.map((message) => message.role),
    ["system", "user", "assistant", "tool"],
  );
  assert.equal(
    second.filter((message) => message.role === "user").length,
    1,
    "the steer never adds a second consecutive user turn",
  );
  assert.ok(
    second[1]!.content.includes(
      "[[OPERATOR STEER]] mid-tool steer: stop editing that file",
    ),
  );
  // The tool turns are preserved, pairing intact: the steer replaced nothing.
  assert.equal(second[2]!.toolCalls?.[0]?.name, "notes");
  assert.equal(second[3]!.toolCallId, "call-1");
  assert.ok(String(second[3]!.content).includes("notes"));
  // The context envelope exists exactly once (the re-render is not a second
  // append) and rides the dense seq.
  const steerEnvelopes = result.messages.filter(
    (message) => message.from === "user" && String(message.payload.text ?? "").startsWith(STEERING_PREFIX),
  );
  assert.equal(steerEnvelopes.length, 1);
  assert.equal(result.context.renderTranscript().split("[[OPERATOR STEER]]").length - 1, 1);
  assert.equal(result.messages.filter((message) => message.kind === "deliverable").length, 1);
});

test("a throwing steering callback is fail-soft: one warning, no envelope, the run completes", async () => {
  const senior = new ScriptedProvider();
  const junior = new ScriptedProvider();
  const harness = new TwoBrothersHarness(cfg(), {
    senior,
    junior,
    steering: () => {
      throw new Error("drain exploded");
    },
  });
  const result = await harness.run("survive a broken drain");
  assert.equal(result.cancelled, false);
  assert.equal(result.messages.length, 5);
  assert.equal(result.messages.filter((message) => message.from === "user").length, 1);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0]!, /operator steering failed .*drain exploded/);
  // The run itself is unaffected: the ordinary consult cycle still ran.
  assert.deepEqual(
    result.messages.map((message) => message.kind),
    ["message", "consult", "proposal", "review", "decision"],
  );
});

test("a malformed (non-list) steering return is fail-soft too", async () => {
  const harness = new TwoBrothersHarness(cfg(), {
    senior: new ScriptedProvider(),
    junior: new ScriptedProvider(),
    steering: () => "not a list" as unknown as string[],
  });
  const result = await harness.run("bad callback shape");
  assert.equal(result.cancelled, false);
  assert.equal(result.messages.length, 5);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0]!, /did not return a list/);
});

test("steering is capped per run and stops being read after the cap", async () => {
  let calls = 0;
  const events: RuntimeEvent[] = [];
  const harness = new TwoBrothersHarness(cfg(), {
    senior: new ScriptedProvider(),
    junior: new ScriptedProvider(),
    onEvent: (event) => events.push(event),
    steering: () => {
      calls += 1;
      return Array.from({ length: 20 }, (_, i) => `flood ${i}`);
    },
  });
  const result = await harness.run("flood me");
  assert.equal(
    result.messages.filter((message) => String(message.payload.text ?? "").startsWith(STEERING_PREFIX)).length,
    MAX_STEERING_ENVELOPES_PER_RUN,
  );
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0]!, new RegExp(`at most ${MAX_STEERING_ENVELOPES_PER_RUN}`));
  // The cap is run-lifetime: once reached the callback is not read again, so a
  // runaway producer can never grow the context.
  assert.equal(calls, 1);
  // A drop is never silent: the additive typed event names exactly how many
  // valid texts were discarded (20 offered, 16 applied) and the cap. The run
  // record's public view aggregates it as `steering_dropped`, so an HTTP
  // consumer that only polls the run learns a 200-accepted text was dropped.
  const dropped = events.filter((event) => event.type === "steering_dropped");
  assert.equal(dropped.length, 1);
  assert.deepEqual({ ...dropped[0] }, {
    type: "steering_dropped",
    dropped: 20 - MAX_STEERING_ENVELOPES_PER_RUN,
    applied: MAX_STEERING_ENVELOPES_PER_RUN,
    limit: MAX_STEERING_ENVELOPES_PER_RUN,
  });
});

test("a terminal record clears its steering queue and refuses late texts", () => {
  const record = new RunRecord("run-terminal", "s.jsonl", "task");
  assert.equal(record.steer("queued but never applied"), true);
  assert.equal(record.pendingSteering, 1);
  assert.equal(record.public().steering_pending, 1);
  record.finish();
  // finish() drops the queue: a terminal run can never apply it, and the
  // public view must not claim a pending text.
  assert.equal(record.pendingSteering, 0);
  assert.equal(record.public().steering_pending, undefined);
  assert.equal(record.steer("too late"), false);
  assert.equal(record.pendingSteering, 0);
  assert.deepEqual(record.drainSteering(), []);
});

test("a stopped run refuses steering and leaves nothing pending", async () => {
  const manager = new RunManager({ workers: 1 });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const record = manager.submit("task", "s.jsonl", async () => {
    await gate;
    return {};
  });
  await waitFor(() => record.status === "running");
  manager.stop(record.runId);
  assert.equal(record.signal.aborted, true);
  // stop() leaves the status `running` until the job unwinds; steering must
  // still be refused, otherwise the route would 200 text nothing will drain.
  assert.equal(record.status, "running");
  const rejected = manager.steer(record.runId, "too late");
  assert.deepEqual([rejected.accepted, rejected.reason, rejected.pending], [false, "not_active", 0]);
  assert.equal(record.pendingSteering, 0);
  release();
  await manager.wait(record.runId);
  assert.equal(record.status, "cancelled");
  assert.equal(record.pendingSteering, 0);
});

test("steering drops and pending texts are visible on the run record's public view", async () => {
  // The harness half is covered above (it emits the typed event); this is the
  // HTTP-facing half: a job's typed event lands in `record.events` and the
  // polling projection aggregates it, so a 200-accepted text dropped at the
  // cap is never invisible to a client that only polls GET /api/runs/{id}.
  const manager = new RunManager({ workers: 1 });
  const record = manager.submit("task", "s.jsonl", async (_signal, onEnvelope) => {
    onEnvelope({ type: "steering_dropped", dropped: 2, applied: 16, limit: 16 });
    return {};
  });
  await manager.wait(record.runId);
  assert.equal(record.status, "completed");
  assert.equal(record.public().steering_dropped, 2);
});

test("a stopped run drains nothing (no envelope after cancellation)", async () => {
  const controller = new AbortController();
  let calls = 0;
  const senior = new ScriptedProvider();
  const original = senior.chat.bind(senior);
  senior.chat = async (messages: ChatMessage[], responseKind = "message"): Promise<string> => {
    const reply = await original(messages, responseKind);
    controller.abort(); // the operator stops while the first model call finishes
    return reply;
  };
  const harness = new TwoBrothersHarness(cfg(), {
    senior,
    junior: new ScriptedProvider(),
    signal: controller.signal,
    steering: () => {
      calls += 1;
      // Only a later boundary would return text; after the abort the callback
      // must never be read again, so nothing is appended.
      return calls >= 2 ? ["too late"] : [];
    },
  });
  const result = await harness.run("stop mid-cycle");
  assert.equal(result.cancelled, true);
  assert.equal(calls, 1, "the boundary before the abort drained once; nothing after it");
  assert.ok(!result.messages.some((message) => String(message.payload.text ?? "").startsWith(STEERING_PREFIX)));
});

// ---------------------------------------------------------------------------
// wire shapes: a steer inside an in-flight tool loop never breaks the adapters
// ---------------------------------------------------------------------------

interface WireRequest {
  url: string;
  body: any;
}

/** Replays `handler` for every call and records the wire request. */
function stubFetch(
  handler: (request: WireRequest, index: number) => Response,
): { fetchImpl: FetchLike; requests: WireRequest[] } {
  const requests: WireRequest[] = [];
  return {
    requests,
    fetchImpl: async (url, init) => {
      const request: WireRequest = {
        url,
        body: typeof init.body === "string" ? JSON.parse(init.body) : init.body,
      };
      requests.push(request);
      return handler(request, requests.length - 1);
    },
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function adapterTextBody(kind: "anthropic" | "google", text: string): unknown {
  if (kind === "anthropic") {
    return { content: [{ type: "text", text }], usage: { input_tokens: 1, output_tokens: 1 } };
  }
  return {
    candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
  };
}

function adapterToolCallBody(kind: "anthropic" | "google", name: string): unknown {
  if (kind === "anthropic") {
    return {
      content: [{ type: "tool_use", id: "tu_1", name, input: {} }],
      stop_reason: "tool_use",
      usage: { input_tokens: 1, output_tokens: 1 },
    };
  }
  return {
    candidates: [
      {
        content: {
          role: "model",
          parts: [{ functionCall: { id: "fc_1", name, args: {} } }],
        },
        finishReason: "STOP",
      },
    ],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
  };
}

const ADAPTER_BASE: Omit<ModelProviderConfig, "fetchImpl" | "model"> = {
  provider: "openai",
  baseUrl: "http://stub.example",
  apiKey: "secret-key",
  seniorModel: "senior-model",
  juniorModel: "junior-model",
  temperature: 0.2,
  timeout: 5,
  retries: 0,
};

interface AdapterRun {
  /** Every wire request with parsed body, in call order. */
  requests: WireRequest[];
  /** True when the request is a junior / tool-loop call. */
  isJunior: (request: WireRequest) => boolean;
  /** The wire turns (`messages` for Anthropic, `contents` for Google). */
  turns: (request: WireRequest) => Array<Record<string, any>>;
  /** Concatenated visible text of one wire turn. */
  textOf: (turn: Record<string, any>) => string;
}

/**
 * Run one full work-mode cooperation cycle through a REAL adapter with a
 * scripted fetch, draining one steer during the junior's tool loop (between
 * the tool round and the final deliverable round). Returns the recorded wire
 * requests so the test can assert provider-legal shapes.
 */
async function runWorkLoopWithSteer(kind: "anthropic" | "google"): Promise<AdapterRun> {
  let seniorCalls = 0;
  let juniorCalls = 0;
  const stub = stubFetch((request) => {
    const isJunior =
      kind === "anthropic"
        ? String(request.body.model ?? "").endsWith("-junior")
        : request.url.includes("-junior");
    if (isJunior) {
      juniorCalls += 1;
      // Round 1: one tool call; round 2 (after the steer): the deliverable.
      return juniorCalls === 1
        ? jsonResponse(adapterToolCallBody(kind, "notes"))
        : jsonResponse(adapterTextBody(kind, JSON.stringify(VALID.deliverable)));
    }
    seniorCalls += 1;
    const payloads = [VALID.delegation!, VALID.review!, VALID.decision!];
    return jsonResponse(
      adapterTextBody(kind, JSON.stringify(payloads[Math.min(seniorCalls, 3) - 1])),
    );
  });
  const senior =
    kind === "anthropic"
      ? new AnthropicProvider({ ...ADAPTER_BASE, model: "claude-senior", fetchImpl: stub.fetchImpl })
      : new GoogleProvider({ ...ADAPTER_BASE, model: "gemini-senior", fetchImpl: stub.fetchImpl });
  const junior =
    kind === "anthropic"
      ? new AnthropicProvider({ ...ADAPTER_BASE, model: "claude-junior", fetchImpl: stub.fetchImpl })
      : new GoogleProvider({ ...ADAPTER_BASE, model: "gemini-junior", fetchImpl: stub.fetchImpl });
  let drains = 0;
  const harness = new TwoBrothersHarness(cfg({ mode: "work" }), {
    senior,
    junior,
    toolScopes: { junior: [fakeTool("notes")] },
    steering: () => {
      drains += 1;
      // Boundaries: senior_open (1), junior_answer (2), tool iteration 0 (3),
      // tool iteration 1 (4) — only the second tool request must see it.
      return drains === 4 ? ["mid-loop steer: use the smaller fixture"] : [];
    },
  });
  const result = await harness.run("do the work");
  assert.equal(result.cancelled, false);
  return {
    requests: stub.requests,
    isJunior: (request) =>
      kind === "anthropic"
        ? String(request.body.model ?? "").endsWith("-junior")
        : request.url.includes("-junior"),
    turns: (request) =>
      kind === "anthropic"
        ? (request.body.messages as Array<Record<string, any>>)
        : (request.body.contents as Array<Record<string, any>>),
    textOf: (turn) =>
      kind === "anthropic"
        ? ((turn.content as Array<Record<string, any>>) ?? [])
            .filter((block) => block.type === "text")
            .map((block) => String(block.text ?? ""))
            .join("")
        : ((turn.parts as Array<Record<string, any>>) ?? [])
            .filter((part) => typeof part.text === "string")
            .map((part) => String(part.text))
            .join(""),
  };
}

test("a steer drained in a tool loop keeps the Anthropic and Google wire shapes legal", async () => {
  for (const kind of ["anthropic", "google"] as const) {
    const run = await runWorkLoopWithSteer(kind);
    const expectedReplyRole = kind === "anthropic" ? "assistant" : "model";

    // Every request: turns alternate user/<reply> starting with user — the
    // provider-legal shape. A second consecutive user turn would be a 400.
    for (const request of run.requests) {
      const turns = run.turns(request);
      assert.ok(turns.length > 0);
      assert.deepEqual(
        turns.map((turn) => turn.role),
        turns.map((_, index) => (index % 2 === 0 ? "user" : expectedReplyRole)),
        `${kind}: turns must alternate (no consecutive user turns)`,
      );
    }

    // The junior tool loop made two requests; only the second (after the
    // drain) carries the steer, inside its opening user turn.
    const juniorRequests = run.requests.filter((request) => run.isJunior(request));
    assert.equal(juniorRequests.length, 2, `${kind}: two junior tool rounds`);
    const first = run.turns(juniorRequests[0]!);
    assert.ok(!run.textOf(first[0]!).includes(STEERING_PREFIX));
    const second = run.turns(juniorRequests[1]!);
    assert.equal(second.length, 3, `${kind}: user + tool-call reply + tool result`);
    assert.ok(
      run.textOf(second[0]!).includes(
        "[[OPERATOR STEER]] mid-loop steer: use the smaller fixture",
      ),
      `${kind}: the next tool request carries the steer in the transcript`,
    );

    // The tool call/result pairing survived the re-render (the steer replaced
    // no tool turn): Anthropic tool_use/tool_result ids match; Google names do.
    if (kind === "anthropic") {
      assert.equal((second[1]!.content as any[])[0]!.type, "tool_use");
      assert.equal((second[1]!.content as any[])[0]!.id, "tu_1");
      assert.equal((second[2]!.content as any[])[0]!.type, "tool_result");
      assert.equal((second[2]!.content as any[])[0]!.tool_use_id, "tu_1");
    } else {
      assert.equal((second[1]!.parts as any[])[0]!.functionCall.name, "notes");
      assert.equal((second[2]!.parts as any[])[0]!.functionResponse.name, "notes");
    }
  }
});

test("an Anthropic signed-thinking block survives a steer-rebuilt tool round", async () => {
  // Anthropic rejects a tool loop whose assistant turn dropped the signed
  // thinking block. A steer drained mid-loop re-renders the opening user turn
  // (messages.slice(2) keeps the tool turns), so the next request must still
  // carry the block FIRST and verbatim, followed by the matching tool_use.
  const THINKING = {
    type: "thinking",
    thinking: "use the smaller fixture",
    signature: "sig-abc-123",
  };
  let seniorCalls = 0;
  let juniorCalls = 0;
  const stub = stubFetch((request) => {
    const isJunior = String(request.body.model ?? "").endsWith("-junior");
    if (isJunior) {
      juniorCalls += 1;
      if (juniorCalls === 1) {
        return jsonResponse({
          content: [THINKING, { type: "tool_use", id: "tu_signed", name: "notes", input: {} }],
          stop_reason: "tool_use",
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      }
      return jsonResponse(adapterTextBody("anthropic", JSON.stringify(VALID.deliverable)));
    }
    seniorCalls += 1;
    const payloads = [VALID.delegation!, VALID.review!, VALID.decision!];
    return jsonResponse(
      adapterTextBody("anthropic", JSON.stringify(payloads[Math.min(seniorCalls, 3) - 1])),
    );
  });
  const senior = new AnthropicProvider({
    ...ADAPTER_BASE,
    model: "claude-senior",
    fetchImpl: stub.fetchImpl,
  });
  const junior = new AnthropicProvider({
    ...ADAPTER_BASE,
    model: "claude-junior",
    fetchImpl: stub.fetchImpl,
  });
  let drains = 0;
  const harness = new TwoBrothersHarness(cfg({ mode: "work" }), {
    senior,
    junior,
    toolScopes: { junior: [fakeTool("notes")] },
    steering: () => {
      drains += 1;
      return drains === 4 ? ["mid-loop steer: keep the fixture small"] : [];
    },
  });
  const result = await harness.run("do the work");
  assert.equal(result.cancelled, false);

  const juniorRequests = stub.requests.filter((request) =>
    String(request.body.model ?? "").endsWith("-junior"),
  );
  assert.equal(juniorRequests.length, 2);
  const second = juniorRequests[1]!.body.messages as Array<Record<string, any>>;
  // Opening user turn re-rendered with the steer, assistant turn preserved.
  assert.equal(second[0]!.role, "user");
  const userText = (second[0]!.content as any[]).map((block) => String(block.text ?? "")).join("");
  assert.ok(userText.includes(`[[OPERATOR STEER]] mid-loop steer: keep the fixture small`));
  assert.equal(second[1]!.role, "assistant");
  const blocks = second[1]!.content as Array<Record<string, any>>;
  // The signed thinking block is echoed FIRST, byte for byte (signature
  // included), then the tool_use it preceded.
  assert.deepEqual(blocks[0], THINKING);
  assert.equal(blocks[1]!.type, "tool_use");
  assert.equal(blocks[1]!.id, "tu_signed");
  assert.equal(second[2]!.role, "user");
  assert.equal((second[2]!.content as any[])[0]!.type, "tool_result");
  assert.equal((second[2]!.content as any[])[0]!.tool_use_id, "tu_signed");
});

// ---------------------------------------------------------------------------
// runtime: bounded per-run queue
// ---------------------------------------------------------------------------

test("RunRecord.steer trims, bounds and drains in submission order", () => {
  const record = new RunRecord("run-1", "s.jsonl", "task");
  assert.equal(record.pendingSteering, 0);
  assert.equal(record.steer("  first thought  "), true);
  assert.equal(record.steer("second thought"), true);
  assert.equal(record.pendingSteering, 2);

  // Empty/whitespace and oversized texts are refused (the HTTP route 400s).
  assert.equal(record.steer("   "), false);
  assert.equal(record.steer(""), false);
  assert.equal(record.steer(42 as unknown as string), false);
  assert.equal(record.steer("x".repeat(STEER_TEXT_MAX_CHARS + 1)), false);
  assert.equal(record.steer("x".repeat(STEER_TEXT_MAX_CHARS)), true);
  assert.equal(record.pendingSteering, 3);

  // The queue is bounded: overflow returns false until a drain makes room.
  for (let i = 0; i < STEER_QUEUE_MAX; i += 1) {
    if (record.pendingSteering < STEER_QUEUE_MAX) assert.equal(record.steer(`fill ${i}`), true);
  }
  assert.equal(record.pendingSteering, STEER_QUEUE_MAX);
  assert.equal(record.steer("one too many"), false);

  // Drain-once, oldest first, cleared afterwards — with the trimmed text.
  assert.deepEqual(record.drainSteering().slice(0, 2), ["first thought", "second thought"]);
  assert.equal(record.pendingSteering, 0);
  assert.deepEqual(record.drainSteering(), []);

  // Terminal/cancelled runs drain to empty and drop what was queued.
  assert.equal(record.steer("salvage?"), true);
  record.finish();
  assert.deepEqual(record.drainSteering(), []);
  assert.equal(record.pendingSteering, 0);
});

test("RunManager.steer maps the run lifecycle onto honest outcomes", async () => {
  const manager = new RunManager({ workers: 1 });
  // A gated job: the run parks inside its only model call until we release it.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const job = async () => {
    await gate;
    return {};
  };
  const record = manager.submit("task", "s.jsonl", job);
  await waitFor(() => record.status === "running");
  assert.equal(STEERABLE_STATES.has(record.status), true);

  // Unknown run: no record at all.
  const unknown = manager.steer("nope", "hi");
  assert.deepEqual([unknown.accepted, unknown.record, unknown.reason], [false, null, "unknown_run"]);

  // Running: accepted, pending echoed; the queue is capped.
  const first = manager.steer(record.runId, "  steer 1  ");
  assert.equal(first.accepted, true);
  assert.equal(first.pending, 1);
  for (let i = 2; i <= STEER_QUEUE_MAX; i += 1) {
    assert.equal(manager.steer(record.runId, `steer ${i}`).accepted, true);
  }
  const full = manager.steer(record.runId, "steer overflow");
  assert.deepEqual([full.accepted, full.reason], [false, "queue_full"]);
  assert.equal(full.pending, STEER_QUEUE_MAX);
  // Invalid text is the defensive reason (the route rejects it as a 400 first).
  assert.equal(record.drainSteering().length, STEER_QUEUE_MAX);
  const invalid = manager.steer(record.runId, "   ");
  assert.deepEqual([invalid.accepted, invalid.reason], [false, "invalid_text"]);

  // Waiting (parked on an approval) is honestly steerable: the text applies at
  // the next boundary after the approval resolves.
  record.status = "waiting";
  const waiting = manager.steer(record.runId, "after the approval");
  assert.deepEqual([waiting.accepted, waiting.pending], [true, 1]);
  record.status = "running";
  assert.deepEqual(record.drainSteering(), ["after the approval"]);

  release();
  await manager.wait(record.runId);
  assert.equal(record.status, "completed");
  const terminal = manager.steer(record.runId, "too late");
  assert.deepEqual([terminal.accepted, terminal.reason, terminal.record?.status], [
    false,
    "not_active",
    "completed",
  ]);
});

test("a queued run is not steerable (409 not_active) until it starts", async () => {
  const manager = new RunManager({ workers: 1 });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = manager.submit("first", "same.jsonl", async () => {
    await gate;
    return {};
  });
  await waitFor(() => first.status === "running");
  // Same session + saturated pool: the second run waits in `queued`.
  const second = manager.submit("second", "same.jsonl", async () => ({}));
  assert.equal(second.status, "queued");
  const rejected = manager.steer(second.runId, "pre-seed?");
  assert.deepEqual([rejected.accepted, rejected.reason, rejected.record?.status], [
    false,
    "not_active",
    "queued",
  ]);
  release();
  await manager.wait(first.runId);
  await manager.wait(second.runId);
});

// ---------------------------------------------------------------------------
// HTTP API: POST /api/runs/{run_id}/steer
// ---------------------------------------------------------------------------

interface RunningServer {
  base: string;
  handle: ServerHandle;
  dir: string;
  close(): Promise<void>;
}

async function startServer(options: ServerOptions = {}): Promise<RunningServer> {
  const tmp = tmpdir("tb-steer-srv-");
  const handle = createServer({
    configFactory: () => resolveConfig({ provider: "mock", mode: "consult" }),
    webDist: null,
    workers: 1,
    ...options,
    sessionsDir: options.sessionsDir ? path.resolve(options.sessionsDir) : tmp.root,
  });
  const server = await handle.listen("127.0.0.1", 0);
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    handle,
    dir: options.sessionsDir ? path.resolve(options.sessionsDir) : tmp.root,
    close: async () => {
      await handle.close();
      tmp.cleanup();
    },
  };
}

async function api<T = unknown>(
  base: string,
  method: string,
  route: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(base + route, init);
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed as T };
}

const post = <T = unknown>(base: string, route: string, body?: unknown) =>
  api<T>(base, "POST", route, body);
const get = <T = unknown>(base: string, route: string) => api<T>(base, "GET", route);

async function waitFor(condition: () => boolean, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition did not become true in time");
    await sleep(10);
  }
}

async function waitTerminal(
  base: string,
  runId: string,
  timeoutMs = 15000,
): Promise<Record<string, any>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await get<Record<string, any>>(base, `/api/runs/${runId}`);
    if (["completed", "failed", "cancelled"].includes(String(body.status))) return body;
    if (Date.now() > deadline) throw new Error(`run ${runId} did not finish in time`);
    await sleep(20);
  }
}

/** SSE reader: collects `data:` events until `stop` holds (or the stream ends). */
function sseEvents(
  base: string,
  route: string,
  stop: (events: Array<Record<string, any>>) => boolean = () => false,
  timeoutMs = 20000,
): Promise<Array<Record<string, any>>> {
  return new Promise((resolve, reject) => {
    const events: Array<Record<string, any>> = [];
    const req = http.get(base + route, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`SSE GET ${route} -> HTTP ${res.statusCode}`));
        res.resume();
        return;
      }
      let buffer = "";
      const finish = (): void => {
        clearTimeout(timer);
        resolve(events);
      };
      const timer = setTimeout(() => {
        req.destroy();
        reject(new Error(`SSE ${route} timed out`));
      }, timeoutMs);
      timer.unref();
      res.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf-8");
        let index = buffer.indexOf("\n\n");
        while (index !== -1) {
          const frame = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const dataLines = frame
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart());
          if (dataLines.length > 0) {
            let parsed: Record<string, any>;
            try {
              parsed = JSON.parse(dataLines.join("\n")) as Record<string, any>;
            } catch {
              parsed = {};
            }
            events.push(parsed);
          }
          index = buffer.indexOf("\n\n");
        }
        if (stop(events)) {
          req.destroy();
          finish();
        }
      });
      res.on("end", () => {
        if (!stop(events)) finish();
      });
    });
    req.on("error", (err) => {
      if (stop(events)) return;
      reject(err);
    });
  });
}

/** A provider that records requests and parks its first call until released. */
interface GatedProvider {
  provider: Provider;
  calls: ChatMessage[][];
  entered: () => boolean;
  release(): void;
}

function gatedProvider(inner: Provider = new MockProvider()): GatedProvider {
  const calls: ChatMessage[][] = [];
  let entered = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const provider: Provider = {
    async chat(messages: ChatMessage[], responseKind?: string): Promise<string> {
      calls.push(messages.map((message) => ({ ...message })));
      if (!entered) {
        entered = true;
        await gate;
      }
      return inner.chat(messages, responseKind);
    },
  };
  return { provider, calls, entered: () => entered, release };
}

/** A MockProvider that records every request's messages (model-visible context). */
class RecordingProvider implements Provider {
  readonly calls: ChatMessage[][] = [];
  private readonly inner = new MockProvider();
  async chat(messages: ChatMessage[], responseKind?: string): Promise<string> {
    this.calls.push(messages.map((message) => ({ ...message })));
    return this.inner.chat(messages, responseKind);
  }
  async chatWithTools(
    messages: ChatMessage[],
    tools: Tool[],
    options?: ToolChatOptions,
  ): Promise<ToolChatResponse> {
    this.calls.push(messages.map((message) => ({ ...message })));
    return this.inner.chatWithTools(messages, tools, options);
  }
}

function userTexts(messages: ChatMessage[]): string[] {
  return messages.filter((message) => message.role === "user").map((message) => message.content);
}

test("POST steer: accepted mid-run, applied before the next model call, visible in context/JSONL/SSE", async () => {
  const gated = gatedProvider();
  const junior = new RecordingProvider();
  const srv = await startServer({
    providerOverrides: { senior: gated.provider, junior },
  });
  try {
    const started = await post<Record<string, any>>(srv.base, "/api/runs", { task: "pick a database" });
    assert.equal(started.status, 202);
    const runId = String(started.body.run_id);

    // Wait until the senior's first model call is genuinely in flight.
    await waitFor(gated.entered);
    const running = await get<Record<string, any>>(srv.base, `/api/runs/${runId}`);
    assert.equal(running.body.status, "running");

    const steered = await post<Record<string, any>>(srv.base, `/api/runs/${runId}/steer`, {
      text: "  prefer SQLite for the prototype  ",
    });
    assert.equal(steered.status, 200);
    assert.equal(steered.body.run_id, runId);
    assert.equal(steered.body.status, "running");
    assert.equal(steered.body.pending, 1);

    // No event is faked on acceptance: the run event log holds only the
    // initial-task envelope so far, no steering envelope.
    const recordNow = srv.handle.state.runs.get(runId)!;
    const steerEventsBefore = recordNow.events.filter(
      (event) =>
        event.type === "envelope" &&
        String((event.envelope as Record<string, any>).payload?.text ?? "").startsWith(STEERING_PREFIX),
    );
    assert.equal(steerEventsBefore.length, 0);

    gated.release();
    const terminal = await waitTerminal(srv.base, runId);
    assert.equal(terminal.status, "completed");

    // Model-visible: the call in flight at steer time could not see it, every
    // later call (senior review/decision and the junior) renders it in the
    // transcript.
    assert.equal(gated.calls.length, 3, "three senior calls in a consult cycle");
    assert.ok(!userTexts(gated.calls[0]!).some((content) => content.includes("prefer SQLite")));
    assert.ok(
      gated.calls.slice(1).some((call) =>
        userTexts(call).some((content) => content.includes("prefer SQLite for the prototype")),
      ),
      "the next model call sees the trimmed steer text",
    );
    assert.ok(junior.calls.length >= 1);
    assert.ok(
      userTexts(junior.calls[0]!).some((content) => content.includes(`[[OPERATOR STEER]] prefer SQLite for the prototype`)),
      "the next model call sees the trimmed steer text with the documented marker",
    );

    // Session JSONL + session detail: an ordinary envelope with a dense seq.
    const sessionName = String(terminal.session);
    const persisted = readSession(path.join(srv.dir, sessionName));
    assert.deepEqual(
      persisted.map((entry) => entry.seq),
      Array.from({ length: persisted.length }, (_, i) => i + 1),
    );
    const steerEnvelope = persisted.find(
      (entry) => String(entry.payload?.text ?? "").startsWith(STEERING_PREFIX),
    );
    assert.ok(steerEnvelope !== undefined);
    assert.equal(steerEnvelope.from, "user");
    assert.equal(steerEnvelope.to, "senior");
    assert.equal(steerEnvelope.kind, "message");
    assert.equal(steerEnvelope.payload.text, `${STEERING_PREFIX}prefer SQLite for the prototype`);
    const detail = await get<Record<string, any>>(srv.base, `/api/sessions/${sessionName}`);
    assert.deepEqual(
      (detail.body.events as Array<Record<string, any>>).map((event) => event.seq),
      persisted.map((entry) => entry.seq),
    );

    // SSE consumers see exactly one familiar `envelope` frame for the steer.
    const data = await sseEvents(srv.base, `/api/runs/${runId}/events?after=0`, (events) =>
      events.some((event) => event.type === "run_end"),
    );
    const steerFrames = data.filter(
      (event) =>
        event.type === "envelope" &&
        String((event.envelope as Record<string, any>).payload?.text ?? "").startsWith(STEERING_PREFIX),
    );
    assert.equal(steerFrames.length, 1);
    assert.equal((steerFrames[0]!.envelope as Record<string, any>).seq, steerEnvelope.seq);
    assert.equal(data.filter((event) => event.type === "run_end").length, 1);
  } finally {
    await srv.close();
  }
});

test("POST steer: 404 unknown run, 400 invalid/empty/oversized text", async () => {
  const srv = await startServer();
  try {
    const missing = await post<Record<string, any>>(srv.base, "/api/runs/nope/steer", { text: "hi" });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.detail, "not found");

    const noText = await post(srv.base, "/api/runs/nope/steer", {});
    assert.equal(noText.status, 400);
    assert.equal((noText.body as Record<string, any>).detail, "invalid request body");
    assert.equal((await post(srv.base, "/api/runs/nope/steer", { text: 5 })).status, 400);
    assert.equal((await post(srv.base, "/api/runs/nope/steer")).status, 400);

    const empty = await post<Record<string, any>>(srv.base, "/api/runs/nope/steer", { text: "   " });
    assert.equal(empty.status, 400);
    assert.equal(empty.body.detail, "text must not be empty");

    const oversized = await post<Record<string, any>>(srv.base, "/api/runs/nope/steer", {
      text: "x".repeat(STEER_TEXT_MAX_CHARS + 1),
    });
    assert.equal(oversized.status, 400);
    assert.match(oversized.body.detail, /text is too long \(max 4000 chars\)/);

    // The body is validated BEFORE the run lookup: a bad body on an unknown run
    // is a 400, never a misleading 404.
    assert.equal(
      (await post(srv.base, "/api/runs/nope/steer", { text: "   " })).status,
      400,
    );
  } finally {
    await srv.close();
  }
});

test("POST steer: honest 409 for a queued run, a terminal run and a full queue", async () => {
  const gated = gatedProvider();
  const srv = await startServer({ providerOverrides: { senior: gated.provider } });
  try {
    const first = await post<Record<string, any>>(srv.base, "/api/runs", {
      task: "first",
      session: "chat",
    });
    await waitFor(gated.entered);
    const runId = String(first.body.run_id);

    // A queued run behind the active one: nothing is working on it yet.
    const second = await post<Record<string, any>>(srv.base, "/api/runs", {
      task: "second",
      session: "chat",
    });
    await waitFor(() => {
      const record = srv.handle.state.runs.get(String(second.body.run_id));
      return record?.status === "queued";
    });
    const queued = await post<Record<string, any>>(
      srv.base,
      `/api/runs/${second.body.run_id}/steer`,
      { text: "early" },
    );
    assert.equal(queued.status, 409);
    assert.match(queued.body.detail, /run is queued; steering applies only to a running or approval-parked run/);

    // The active run accepts a bounded queue, then honestly reports a full one.
    for (let i = 0; i < STEER_QUEUE_MAX; i += 1) {
      const ok = await post<Record<string, any>>(srv.base, `/api/runs/${runId}/steer`, {
        text: `steer ${i + 1}`,
      });
      assert.equal(ok.status, 200);
      assert.equal(ok.body.pending, i + 1);
    }
    const full = await post<Record<string, any>>(srv.base, `/api/runs/${runId}/steer`, {
      text: "one too many",
    });
    assert.equal(full.status, 409);
    assert.match(full.body.detail, /steering queue is full \(8 pending\)/);

    gated.release();
    await waitTerminal(srv.base, runId);
    await waitTerminal(srv.base, String(second.body.run_id));

    // Terminal runs are not steerable: the 409 names the real status.
    const terminal = await post<Record<string, any>>(srv.base, `/api/runs/${runId}/steer`, {
      text: "too late",
    });
    assert.equal(terminal.status, 409);
    assert.match(terminal.body.detail, /run is completed/);

    // All 8 accepted texts were actually applied (bounded, in order) once the
    // in-flight call finished — the cap queue does not silently drop them.
    const record = srv.handle.state.runs.get(runId)!;
    const applied = record.events.filter(
      (event) =>
        event.type === "envelope" &&
        String((event.envelope as Record<string, any>).payload?.text ?? "").startsWith(STEERING_PREFIX),
    );
    assert.equal(applied.length, STEER_QUEUE_MAX);
  } finally {
    await srv.close();
  }
});

test("POST steer after stop is an honest 409, never a 200 for lost text", async () => {
  const gated = gatedProvider();
  const srv = await startServer({ providerOverrides: { senior: gated.provider } });
  try {
    const started = await post<Record<string, any>>(srv.base, "/api/runs", { task: "stop me" });
    assert.equal(started.status, 202);
    const runId = String(started.body.run_id);
    await waitFor(gated.entered);

    const stopped = await post<Record<string, any>>(srv.base, `/api/runs/${runId}/stop`);
    assert.equal(stopped.status, 200);
    // stop() aborts the job but leaves the status `running` until it unwinds;
    // the route must still refuse honestly instead of accepting text the
    // harness will never drain.
    const rejected = await post<Record<string, any>>(srv.base, `/api/runs/${runId}/steer`, {
      text: "too late",
    });
    assert.equal(rejected.status, 409);
    assert.match(String(rejected.body.detail), /steering applies only to a running or approval-parked run/);
    const record = srv.handle.state.runs.get(runId)!;
    assert.equal(record.pendingSteering, 0);

    gated.release();
    const terminal = await waitTerminal(srv.base, runId);
    assert.equal(terminal.status, "cancelled");
    assert.equal(record.pendingSteering, 0);
  } finally {
    await srv.close();
  }
});

test("a steer accepted while a run is approval-parked lands after the approval resolves", async () => {
  const sessions = tmpdir("tb-steer-park-");
  const workspaceDir = path.join(sessions.root, "ws");
  fs.mkdirSync(workspaceDir);
  // The junior's first tool round parks on a workspace write approval; the
  // second round runs after the operator answers and must see the steer.
  const senior = new ScriptedProvider();
  const junior = new ScriptedProvider({
    tools: {
      deliverable: [
        {
          toolCalls: [
            toolCall("call-write", "workspace_write_file", {
              path: "approved.txt",
              content: "written after approval\n",
            }),
          ],
        },
        { text: validReply("deliverable") },
      ],
    },
  });
  const srv = await startServer({
    approvalPolicy: "ask",
    providerOverrides: { senior, junior },
  });
  try {
    const workspace = await post<Record<string, any>>(srv.base, "/api/workspaces", {
      path: workspaceDir,
      name: "steer-park",
    });
    assert.equal(workspace.status, 201);
    const started = await post<Record<string, any>>(srv.base, "/api/runs", {
      task: "do the work",
      mode: "work",
      session: "chat",
      workspace_id: workspace.body.id,
    });
    assert.equal(started.status, 202);
    const runId = String(started.body.run_id);

    // The run really parks on the approval — the waiting status comes from the
    // runtime's own approval events, not a test-set field.
    let status = "";
    for (let i = 0; i < 500; i += 1) {
      const current = await get<Record<string, any>>(srv.base, `/api/runs/${runId}`);
      status = String(current.body.status);
      if (status === "waiting" || ["completed", "failed", "cancelled"].includes(status)) break;
      await sleep(20);
    }
    assert.equal(status, "waiting");

    const steered = await post<Record<string, any>>(srv.base, `/api/runs/${runId}/steer`, {
      text: "after the approval, keep the small fixture",
    });
    assert.equal(steered.status, 200);
    assert.equal(steered.body.status, "waiting");
    assert.equal(steered.body.pending, 1);

    // No faked envelope while parked: acceptance is only the queue entry.
    const record = srv.handle.state.runs.get(runId)!;
    const steerEnvelopes = (): Array<Record<string, any>> =>
      record.events.filter(
        (event) =>
          event.type === "envelope" &&
          String((event.envelope as Record<string, any>).payload?.text ?? "").startsWith(STEERING_PREFIX),
      );
    assert.equal(steerEnvelopes().length, 0);
    assert.equal(record.pendingSteering, 1);

    const approvals = await get<Record<string, any>>(srv.base, `/api/runs/${runId}/approvals`);
    const pending = approvals.body.pending as Array<Record<string, any>>;
    assert.equal(pending.length, 1);
    const approved = await post<Record<string, any>>(
      srv.base,
      `/api/runs/${runId}/approvals/${String(pending[0]!.approval_id)}`,
      { allow: true },
    );
    assert.equal(approved.status, 200);

    const terminal = await waitTerminal(srv.base, runId);
    assert.equal(terminal.status, "completed");
    assert.equal(
      fs.readFileSync(path.join(workspaceDir, "approved.txt"), "utf-8"),
      "written after approval\n",
    );

    // Applied exactly once, AFTER the approval resolved (its next boundary).
    const resolvedIndex = record.events.findIndex((event) => event.type === "approval_resolved");
    const applied = steerEnvelopes();
    assert.equal(applied.length, 1);
    const appliedIndex = record.events.findIndex(
      (event) => event.type === "envelope" && event.envelope === applied[0]!.envelope,
    );
    assert.ok(resolvedIndex >= 0);
    assert.ok(appliedIndex > resolvedIndex, "the steer lands after the approval, not before");

    // And the live model conversation after the park carries it inside the
    // canonical transcript (the in-flight tool round is re-rendered once).
    const rounds = junior.toolsCalls("deliverable");
    assert.equal(rounds.length, 2);
    assert.ok(!userContents(rounds[0]!).some((content) => content.includes("keep the small fixture")));
    assert.ok(
      userContents(rounds[1]!).some((content) =>
        content.includes(`[[OPERATOR STEER]] after the approval, keep the small fixture`),
      ),
    );
  } finally {
    await srv.close();
    sessions.cleanup();
  }
});
