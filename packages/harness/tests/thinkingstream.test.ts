/**
 * Thinking/reasoning delta streaming: providers → harness → runstream `token`
 * events with `kind: "text" | "thinking"`.
 *
 * Hermetic: a tiny `node:http` SSE stub on an ephemeral port speaks the
 * OpenAI-compatible (`/chat/completions`), Anthropic (`/v1/messages`) and
 * Gemini (`:streamGenerateContent?alt=sse`) wire shapes, matched by URL.
 *
 * Cases pin: per-adapter split of reasoning vs visible text (including the
 * alternate OpenAI `reasoning` field, Anthropic `thinking_delta` + signature
 * ignoring and Google `thought` parts), that reasoning never reaches the
 * reply/content/usage, the deterministic MockProvider reasoning stream, the
 * harness token-event seam (both `kind`s, arrival order, tool-loop + repair
 * re-ask coverage, no consumer → no streaming), and the NDJSON bounds on a
 * huge thinking delta.
 *
 * Run with: node --test tests/thinkingstream.test.ts
 */
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { resolveConfig } from "../src/config.ts";
import type { ChatMessage } from "../src/context.ts";
import { TwoBrothersHarness } from "../src/harness.ts";
import {
  AnthropicProvider,
  GoogleProvider,
  MOCK_DELTA_CHARS,
  MOCK_REASONING,
  MockProvider,
  OpenAICompatibleProvider,
  emitMockDeltas,
  emitMockThinking,
  type ChatOptions,
  type MockScriptStep,
  type ModelProviderConfig,
  type Tool,
  type ToolChatResponse,
} from "../src/provider.ts";
import {
  STREAM_FIELD_CHARS,
  STREAM_LINE_CHARS,
  toNdjsonLine,
  type StreamEvent,
  type TokenStreamEvent,
} from "../src/runstream.ts";

// ---------------------------------------------------------------------------
// hermetic SSE stub
// ---------------------------------------------------------------------------

type StubHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
) => void | Promise<void>;

interface Stub {
  baseUrl: string;
  close(): Promise<void>;
}

async function startStub(handler: StubHandler): Promise<Stub> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    void Promise.resolve(handler(req, res, url)).catch(() => {
      res.destroy();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      raw += chunk;
    });
    req.on("end", () => resolve(raw));
  });
}

function startSse(res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
}

function sseData(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function sseEvent(name: string, payload: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
}

const TEXT_CHUNKS = ["Hel", "lo", " world"];
const FULL_TEXT = TEXT_CHUNKS.join("");
const REASONING_CHUNKS = ["Let me ", "look at ", "the task."];
const FULL_REASONING = REASONING_CHUNKS.join("");
const OPENAI_USAGE = { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 };

/** Reasoning deltas (`reasoningField`) then text deltas, then usage + [DONE]. */
function writeOpenAIReasoning(
  res: ServerResponse,
  reasoningField: "reasoning_content" | "reasoning" = "reasoning_content",
): void {
  startSse(res);
  for (const chunk of REASONING_CHUNKS) {
    res.write(
      sseData({
        choices: [{ index: 0, delta: { [reasoningField]: chunk }, finish_reason: null }],
      }),
    );
  }
  // An empty reasoning delta is ignored rather than delivered.
  res.write(sseData({ choices: [{ index: 0, delta: { [reasoningField]: "" } }] }));
  for (const chunk of TEXT_CHUNKS) {
    res.write(sseData({ choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }] }));
  }
  res.write(sseData({ choices: [], usage: OPENAI_USAGE }));
  res.write("data: [DONE]\n\n");
  res.end();
}

/** Anthropic thinking block (with a signature delta) then a text block. */
function writeAnthropicThinking(res: ServerResponse): void {
  startSse(res);
  res.write(
    sseEvent("message_start", {
      type: "message_start",
      message: {
        id: "msg_1",
        role: "assistant",
        usage: { input_tokens: 21, cache_read_input_tokens: 3, output_tokens: 1 },
      },
    }),
  );
  res.write(
    sseEvent("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "", signature: "" },
    }),
  );
  for (const chunk of REASONING_CHUNKS) {
    res.write(
      sseEvent("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: chunk },
      }),
    );
  }
  res.write(
    sseEvent("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature: "sig-abc" },
    }),
  );
  res.write(sseEvent("content_block_stop", { type: "content_block_stop", index: 0 }));
  res.write(
    sseEvent("content_block_start", {
      type: "content_block_start",
      index: 1,
      content_block: { type: "text", text: "" },
    }),
  );
  for (const chunk of TEXT_CHUNKS) {
    res.write(
      sseEvent("content_block_delta", {
        type: "content_block_delta",
        index: 1,
        delta: { type: "text_delta", text: chunk },
      }),
    );
  }
  res.write(sseEvent("content_block_stop", { type: "content_block_stop", index: 1 }));
  res.write(
    sseEvent("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 9 },
    }),
  );
  res.write(sseEvent("message_stop", { type: "message_stop" }));
  res.end();
}

/** Gemini chunks mixing `thought: true` parts and visible parts. */
function writeGeminiThinking(res: ServerResponse): void {
  startSse(res);
  res.write(
    sseData({
      candidates: [
        {
          content: {
            role: "model",
            parts: [
              { text: "Plan: ", thought: true },
              { text: "Hel" },
            ],
          },
          index: 0,
        },
      ],
    }),
  );
  res.write(
    sseData({
      candidates: [
        {
          content: {
            role: "model",
            parts: [
              { text: "check the goal.", thought: true },
              { text: "lo" },
            ],
          },
          index: 0,
        },
      ],
    }),
  );
  res.write(
    sseData({
      candidates: [{ content: { role: "model", parts: [{ text: " world" }] }, index: 0 }],
    }),
  );
  res.write(
    sseData({
      candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP", index: 0 }],
      usageMetadata: {
        promptTokenCount: 13,
        cachedContentTokenCount: 3,
        candidatesTokenCount: 8,
        thoughtsTokenCount: 2,
        totalTokenCount: 26,
      },
    }),
  );
  res.end();
}

// ---------------------------------------------------------------------------
// provider fixtures
// ---------------------------------------------------------------------------

const MESSAGES: ChatMessage[] = [{ role: "user", content: "hi" }];

function baseConfig(
  baseUrl: string,
  overrides: Partial<ModelProviderConfig> = {},
): ModelProviderConfig {
  return {
    provider: "openai",
    baseUrl,
    apiKey: "",
    seniorModel: "m",
    juniorModel: "m",
    temperature: 0.2,
    timeout: 2,
    retries: 0,
    model: "m",
    backoffBase: 0,
    sleeper: async () => undefined,
    ...overrides,
  };
}

interface SinkCapture {
  text: string[];
  thinking: string[];
  options: ChatOptions;
}

function captures(): SinkCapture {
  const text: string[] = [];
  const thinking: string[] = [];
  return {
    text,
    thinking,
    options: {
      onDelta: (delta) => text.push(delta),
      onThinkingDelta: (delta) => thinking.push(delta),
    },
  };
}

// ---------------------------------------------------------------------------
// OpenAI-compatible: reasoning_content / reasoning
// ---------------------------------------------------------------------------

test("openai-compatible: reasoning_content deltas go to thinking, content to text", async () => {
  const requests: Array<{ path: string; body: Record<string, unknown>; accept?: string }> = [];
  const stub = await startStub(async (req, res, url) => {
    const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    requests.push({ path: url.pathname, body, accept: req.headers.accept });
    writeOpenAIReasoning(res);
  });
  try {
    const capture = captures();
    const provider = new OpenAICompatibleProvider(baseConfig(stub.baseUrl));
    const reply = await provider.chat(MESSAGES, "message", undefined, capture.options);

    assert.equal(reply, FULL_TEXT, "the resolved reply is the visible text only");
    assert.deepEqual(capture.text, TEXT_CHUNKS, "text deltas arrive in order");
    assert.deepEqual(capture.thinking, REASONING_CHUNKS, "reasoning deltas arrive in order");
    assert.equal(capture.thinking.join(""), FULL_REASONING);
    assert.ok(!reply.includes("Let me"), "reasoning never leaks into the reply");
    assert.equal(requests[0].body.stream, true, "both sinks opt into wire streaming");
    assert.equal(requests[0].accept, "text/event-stream");
    assert.deepEqual(provider.usageSnapshot(), {
      model_calls: 1,
      input_tokens: OPENAI_USAGE.prompt_tokens,
      output_tokens: OPENAI_USAGE.completion_tokens,
      cached_tokens: 0,
      cache_write_tokens: 0,
    });
  } finally {
    await stub.close();
  }
});

test("openai-compatible: the alternate delta.reasoning field also reaches the thinking sink", async () => {
  const stub = await startStub((_req, res) => writeOpenAIReasoning(res, "reasoning"));
  try {
    const capture = captures();
    const provider = new OpenAICompatibleProvider(baseConfig(stub.baseUrl));
    const reply = await provider.chat(MESSAGES, "message", undefined, capture.options);
    assert.equal(reply, FULL_TEXT);
    assert.deepEqual(capture.text, TEXT_CHUNKS);
    assert.deepEqual(capture.thinking, REASONING_CHUNKS);
  } finally {
    await stub.close();
  }
});

test("openai-compatible: either sink alone opts into streaming and the other stays silent", async () => {
  const stub = await startStub((_req, res) => writeOpenAIReasoning(res));
  try {
    // Thinking-only sink: reasoning is delivered, the reply still assembles.
    const thinking: string[] = [];
    const provider = new OpenAICompatibleProvider(baseConfig(stub.baseUrl));
    const reply = await provider.chat(MESSAGES, "message", undefined, {
      onThinkingDelta: (delta) => thinking.push(delta),
    });
    assert.equal(reply, FULL_TEXT);
    assert.deepEqual(thinking, REASONING_CHUNKS);

    // Text-only sink: reasoning is NOT leaked into the text sink.
    const text: string[] = [];
    const reply2 = await provider.chat(MESSAGES, "message", undefined, {
      onDelta: (delta) => text.push(delta),
    });
    assert.equal(reply2, FULL_TEXT);
    assert.deepEqual(text, TEXT_CHUNKS);
  } finally {
    await stub.close();
  }
});

test("a throwing thinking sink is swallowed and the reply is unchanged", async () => {
  const stub = await startStub((_req, res) => writeOpenAIReasoning(res));
  try {
    const text: string[] = [];
    const provider = new OpenAICompatibleProvider(baseConfig(stub.baseUrl));
    const reply = await provider.chat(MESSAGES, "message", undefined, {
      onDelta: (delta) => text.push(delta),
      onThinkingDelta: () => {
        throw new Error("broken thinking consumer");
      },
    });
    assert.equal(reply, FULL_TEXT);
    assert.deepEqual(text, TEXT_CHUNKS);
  } finally {
    await stub.close();
  }
});

// ---------------------------------------------------------------------------
// Anthropic: thinking_delta vs text_delta
// ---------------------------------------------------------------------------

test("anthropic: thinking_delta goes to thinking, text_delta to text, signature ignored", async () => {
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const stub = await startStub(async (req, res, url) => {
    requests.push({
      path: url.pathname,
      body: JSON.parse(await readBody(req)) as Record<string, unknown>,
    });
    writeAnthropicThinking(res);
  });
  try {
    const capture = captures();
    const provider = new AnthropicProvider(baseConfig(stub.baseUrl));
    const reply = await provider.chat(MESSAGES, "message", undefined, capture.options);

    assert.equal(reply, FULL_TEXT, "thinking blocks never contribute reply text");
    assert.ok(!reply.includes("Let me"), "reasoning is not in the reply");
    assert.deepEqual(capture.text, TEXT_CHUNKS);
    assert.deepEqual(capture.thinking, REASONING_CHUNKS, "signature deltas are ignored");
    assert.equal(requests[0].body.stream, true);
    // Usage still comes from message_start + message_delta only.
    assert.deepEqual(provider.usageSnapshot(), {
      model_calls: 1,
      input_tokens: 21,
      output_tokens: 9,
      cached_tokens: 3,
      cache_write_tokens: 0,
    });
  } finally {
    await stub.close();
  }
});

// ---------------------------------------------------------------------------
// Google: thought parts
// ---------------------------------------------------------------------------

test("gemini: thought parts go to thinking, visible parts to text", async () => {
  const requests: Array<{ path: string; search: string }> = [];
  const stub = await startStub(async (req, res, url) => {
    await readBody(req);
    requests.push({ path: url.pathname, search: url.search });
    writeGeminiThinking(res);
  });
  try {
    const capture = captures();
    const provider = new GoogleProvider(baseConfig(stub.baseUrl));
    const reply = await provider.chat(MESSAGES, "message", undefined, capture.options);

    assert.equal(reply, FULL_TEXT);
    assert.ok(!reply.includes("Plan:"), "thought parts are never visible reply text");
    assert.deepEqual(capture.thinking, ["Plan: ", "check the goal."]);
    assert.deepEqual(capture.text, TEXT_CHUNKS);
    assert.equal(requests[0].path, "/v1beta/models/m:streamGenerateContent");
    assert.equal(requests[0].search, "?alt=sse");
    assert.deepEqual(provider.usageSnapshot(), {
      model_calls: 1,
      input_tokens: 10,
      output_tokens: 10, // candidatesTokenCount + thoughtsTokenCount
      cached_tokens: 3,
      cache_write_tokens: 0,
    });
  } finally {
    await stub.close();
  }
});

// ---------------------------------------------------------------------------
// MockProvider: deterministic reasoning stream
// ---------------------------------------------------------------------------

test("MockProvider: deterministic MOCK_REASONING first with a thinking sink; text unchanged", async () => {
  const payload = await new MockProvider().chat(MESSAGES, "proposal");
  const capture = captures();
  const reply = await new MockProvider().chat(MESSAGES, "proposal", undefined, capture.options);

  assert.equal(reply, payload, "the mock reply is unchanged by streaming");
  assert.equal(capture.thinking.join(""), MOCK_REASONING);
  assert.equal(capture.text.join(""), payload);
  assert.equal(capture.thinking.length, Math.ceil(MOCK_REASONING.length / MOCK_DELTA_CHARS));
  assert.equal(capture.text.length, Math.ceil(payload.length / MOCK_DELTA_CHARS));

  // Derive the interleaving from a fresh sink capture: all reasoning steps
  // precede the first visible text delta.
  const order: string[] = [];
  await new MockProvider().chat(MESSAGES, "proposal", undefined, {
    onDelta: () => order.push("text"),
    onThinkingDelta: () => order.push("thinking"),
  });
  const firstText = order.indexOf("text");
  assert.ok(firstText > 0, "reasoning streams before the reply");
  assert.ok(order.slice(0, firstText).every((kind) => kind === "thinking"));
  assert.ok(order.slice(firstText).every((kind) => kind === "text"));
});

test("MockProvider: no reasoning when only onDelta is set (existing behavior identical)", async () => {
  const provider = new MockProvider();
  const expected = await new MockProvider().chat(MESSAGES, "deliverable");
  const deltas: string[] = [];
  const reply = await provider.chat(MESSAGES, "deliverable", undefined, {
    onDelta: (delta) => deltas.push(delta),
  });
  assert.equal(reply, expected);
  assert.deepEqual(deltas, chunked(expected));
  // The helper itself is a no-op without a thinking sink.
  assert.equal(emitMockThinking(undefined), undefined);
});

test("MockProvider: the scripted tool loop reasons before a tool call and before text", async () => {
  const provider = new MockProvider([
    { tool: "lookup", args: { q: "x" } },
    { text: "plain answer" },
  ]);
  const first = captures();
  const response = await provider.chatWithTools(MESSAGES, TOOLS, first.options);
  assert.deepEqual(response.toolCalls, [{ id: "call-1", name: "lookup", args: { q: "x" } }]);
  assert.equal(response.content, "");
  assert.equal(first.thinking.join(""), MOCK_REASONING);
  assert.deepEqual(first.text, [], "a tool-call step streams no visible text");

  const second = captures();
  const response2 = await provider.chatWithTools(MESSAGES, TOOLS, second.options);
  assert.equal(response2.content, "plain answer");
  assert.equal(second.thinking.join(""), MOCK_REASONING);
  assert.equal(second.text.join(""), "plain answer");

  // Without a thinking sink the scripted steps are byte-identical.
  const silent = new MockProvider([{ text: "plain answer" }]);
  const response3 = await silent.chatWithTools(MESSAGES, TOOLS, {});
  assert.equal(response3.content, "plain answer");
});

/** Split `text` like `emitMockDeltas` does. */
function chunked(text: string): string[] {
  const out: string[] = [];
  for (let at = 0; at < text.length; at += MOCK_DELTA_CHARS) {
    out.push(text.slice(at, at + MOCK_DELTA_CHARS));
  }
  return out;
}

const TOOLS: Tool[] = [
  {
    name: "lookup",
    description: "look something up",
    parameters: { type: "object", properties: { q: { type: "string" } } },
    execute: () => "looked up",
  },
];

// ---------------------------------------------------------------------------
// Harness seam: token events carry role + kind in arrival order
// ---------------------------------------------------------------------------

const cfg = (mode = "consult") => resolveConfig({ provider: "mock", mode });

interface CallLogEntry {
  role: "senior" | "junior";
  sink: "chat" | "tools";
  thinkingChunks: string[];
  textChunks: string[];
  reply: string;
  optionsSeen: ChatOptions | undefined;
}

/**
 * MockProvider that records the deltas the mock itself streams on every call
 * (both `chat` and `chatWithTools`) and the `ChatOptions` the harness passed.
 */
class ThinkingMock extends MockProvider {
  private readonly role: "senior" | "junior";
  private readonly log: CallLogEntry[];

  constructor(
    role: "senior" | "junior",
    log: CallLogEntry[],
    steps: MockScriptStep[] = [],
  ) {
    super(steps);
    this.role = role;
    this.log = log;
  }

  private wrap(options: ChatOptions | undefined): {
    wrapped: ChatOptions;
    thinkingChunks: string[];
    textChunks: string[];
  } {
    const thinkingChunks: string[] = [];
    const textChunks: string[] = [];
    return {
      thinkingChunks,
      textChunks,
      wrapped: {
        onDelta: (delta) => {
          textChunks.push(delta);
          options?.onDelta?.(delta);
        },
        onThinkingDelta: (delta) => {
          thinkingChunks.push(delta);
          options?.onThinkingDelta?.(delta);
        },
      },
    };
  }

  override async chat(
    messages: ChatMessage[],
    responseKind = "message",
    signal?: AbortSignal,
    options?: ChatOptions,
  ): Promise<string> {
    const { wrapped, thinkingChunks, textChunks } = this.wrap(options);
    // With no ChatOptions the call must be the plain non-streaming one: no
    // sink is handed to the mock, so it emits nothing.
    const reply = await super.chat(messages, responseKind, signal, options ? wrapped : undefined);
    this.log.push({
      role: this.role,
      sink: "chat",
      thinkingChunks,
      textChunks,
      reply,
      optionsSeen: options,
    });
    return reply;
  }

  override async chatWithTools(
    messages: ChatMessage[],
    tools: Tool[],
    options: ChatOptions = {},
  ): Promise<ToolChatResponse> {
    const { wrapped, thinkingChunks, textChunks } = this.wrap(options);
    const streaming = options.onDelta !== undefined || options.onThinkingDelta !== undefined;
    const response = await super.chatWithTools(messages, tools, streaming ? wrapped : {});
    this.log.push({
      role: this.role,
      sink: "tools",
      thinkingChunks,
      textChunks,
      reply: response.content,
      optionsSeen: options.onDelta !== undefined || options.onThinkingDelta !== undefined ? options : undefined,
    });
    return response;
  }
}

/** Expected token events, derived from the mock's own recorded delta order. */
function expectedTokens(log: CallLogEntry[]): Array<{
  role: string;
  kind: "text" | "thinking";
  delta: string;
}> {
  return log.flatMap((call) => [
    ...call.thinkingChunks.map((delta) => ({
      role: call.role as string,
      kind: "thinking" as const,
      delta,
    })),
    ...call.textChunks.map((delta) => ({
      role: call.role as string,
      kind: "text" as const,
      delta,
    })),
  ]);
}

function tokenEvents(events: StreamEvent[]): TokenStreamEvent[] {
  return events.filter((event): event is TokenStreamEvent => event.type === "token");
}

function nonTokenLabels(events: StreamEvent[]): string[] {
  return events
    .filter((event) => event.type !== "token")
    .map((event) => {
      if (event.type === "envelope") return `envelope:${event.envelope.kind}`;
      if (event.type === "run_status") return `run_status:${event.status}`;
      return event.type;
    });
}

async function runConsultWithThinking(streamTokens: boolean) {
  const log: CallLogEntry[] = [];
  const events: StreamEvent[] = [];
  const harness = new TwoBrothersHarness(cfg("consult"), {
    senior: new ThinkingMock("senior", log),
    junior: new ThinkingMock("junior", log),
    ...(streamTokens ? { streamTokens: true } : {}),
    onStreamEvent: (event) => events.push(event),
  });
  const result = await harness.run("reason about this task");
  return { log, events, result };
}

test("harness: token events carry role + kind, in arrival order, across every call", async () => {
  const streamed = await runConsultWithThinking(true);
  const tokens = tokenEvents(streamed.events);
  assert.ok(tokens.length > 0, "token events were emitted");
  assert.deepEqual(
    streamed.log.map((call) => call.sink),
    ["chat", "chat", "chat", "chat"],
    "consult run: senior consult, junior proposal, senior review, senior decision",
  );
  assert.deepEqual(
    tokens.map((event) => ({ role: event.role, kind: event.kind, delta: event.delta })),
    expectedTokens(streamed.log),
    "thinking then text deltas per call, calls in order",
  );
  assert.deepEqual(
    [...new Set(tokens.map((event) => event.kind))].sort(),
    ["text", "thinking"],
    "both kinds are present",
  );
  for (const event of tokens) assert.equal(typeof event.at, "string");

  // Observational: the protocol transcript, decision and usage are identical
  // with streaming on and off (envelope ids/timestamps are random per run, so
  // compare the transcript projection).
  const transcript = (result: {
    messages: Array<{ from: string; to: string; kind: string; payload: Record<string, unknown> }>;
  }) =>
    result.messages.map((message) => ({
      from: message.from,
      to: message.to,
      kind: message.kind,
      payload: message.payload,
    }));
  const plain = await runConsultWithThinking(false);
  assert.deepEqual(nonTokenLabels(streamed.events), nonTokenLabels(plain.events));
  assert.deepEqual(transcript(streamed.result), transcript(plain.result));
  assert.deepEqual(streamed.result.decision, plain.result.decision);
  assert.deepEqual(streamed.result.usage, plain.result.usage);
  assert.deepEqual(streamed.result.errors, []);
  assert.equal(plain.events.filter((event) => event.type === "token").length, 0);
});

test("harness: no stream consumer means no ChatOptions and no token events", async () => {
  const log: CallLogEntry[] = [];
  const harness = new TwoBrothersHarness(cfg("consult"), {
    senior: new ThinkingMock("senior", log),
    junior: new ThinkingMock("junior", log),
    streamTokens: true, // requested, but no onStreamEvent consumer
  });
  const result = await harness.run("no consumer");
  assert.deepEqual(result.errors, []);
  assert.equal(log.length, 4);
  assert.ok(
    log.every((call) => call.optionsSeen === undefined),
    "without a consumer the provider gets the plain (non-streaming) call",
  );
  // The mock only streams when a sink is handed to it.
  assert.ok(log.every((call) => call.thinkingChunks.length === 0 && call.textChunks.length === 0));
});

test("harness: a repair re-ask streams its own thinking then text after the repair event", async () => {
  class RepairingSenior extends MockProvider {
    private calls = 0;
    readonly tokens: Array<{ thinking: string[]; text: string[] }> = [];

    override async chat(
      messages: ChatMessage[],
      responseKind = "message",
      signal?: AbortSignal,
      options?: ChatOptions,
    ): Promise<string> {
      // No options into super: the class emits its own observable stream.
      const real = await super.chat(messages, responseKind, signal);
      const reply = this.calls++ === 0 ? "this is not json" : real;
      const thinking: string[] = [];
      const text: string[] = [];
      emitMockThinking((delta) => {
        thinking.push(delta);
        options?.onThinkingDelta?.(delta);
      });
      emitMockDeltas(reply, (delta) => {
        text.push(delta);
        options?.onDelta?.(delta);
      });
      this.tokens.push({ thinking, text });
      return reply;
    }
  }

  const senior = new RepairingSenior();
  const events: StreamEvent[] = [];
  const harness = new TwoBrothersHarness(cfg("consult"), {
    senior,
    junior: new MockProvider(),
    streamTokens: true,
    onStreamEvent: (event) => events.push(event),
  });
  const result = await harness.run("stream the repair");
  assert.deepEqual(result.errors, []);

  const repairIndex = events.findIndex((event) => event.type === "repair");
  assert.ok(repairIndex >= 0, "the first invalid reply triggered a repair re-ask");
  // `repairReply` emits the `repair` record, appends the marked repair turn
  // (an `envelope`), and only then issues the re-ask — so the re-ask tokens
  // start after that repair envelope.
  const repairEnvelopeIndex = events.findIndex(
    (event, index) => index > repairIndex && event.type === "envelope",
  );
  assert.ok(repairEnvelopeIndex > repairIndex, "the repair turn was appended");
  const repairedEnvelope = events[repairEnvelopeIndex];
  assert.equal(repairedEnvelope.type, "envelope");
  if (repairedEnvelope.type === "envelope") {
    assert.match(String(repairedEnvelope.envelope.payload.text), /\[\[REPAIR_REQUEST\]\]/);
  }

  const afterRepair = events.slice(repairEnvelopeIndex + 1);
  const reAskTokens: TokenStreamEvent[] = [];
  for (const event of afterRepair) {
    if (event.type === "token") reAskTokens.push(event);
    else break;
  }
  assert.ok(reAskTokens.length > 0, "the repair re-ask was streamed");
  assert.ok(reAskTokens.every((event) => event.role === "senior"), "the re-ask is the senior call");
  const kinds = reAskTokens.map((event) => event.kind ?? "text");
  const firstText = kinds.indexOf("text");
  assert.ok(firstText > 0, "the re-ask streams thinking before text");
  assert.ok(kinds.slice(0, firstText).every((kind) => kind === "thinking"));
  assert.ok(kinds.slice(firstText).every((kind) => kind === "text"));
  // And the reply itself came from the repair: an envelope follows the tokens.
  assert.equal(afterRepair[reAskTokens.length]?.type, "envelope");
});

test("harness: a tool-loop call streams thinking (tool step) then thinking+text", async () => {
  const log: CallLogEntry[] = [];
  const events: StreamEvent[] = [];
  const deliverable = JSON.stringify({
    result: "looked up the value",
    artifacts: ["looked up"],
    notes: "ok",
    confidence: 0.9,
  });
  const harness = new TwoBrothersHarness(cfg("work"), {
    senior: new MockProvider(),
    junior: new ThinkingMock("junior", log, [
      { tool: "lookup", args: { q: "x" } },
      { text: deliverable },
    ]),
    tools: [TOOLS[0]],
    streamTokens: true,
    onStreamEvent: (event) => events.push(event),
  });
  const result = await harness.run("use the lookup tool");
  assert.deepEqual(result.errors, []);

  const juniorTokens = tokenEvents(events).filter((event) => event.role === "junior");
  const expected = expectedTokens(log.filter((call) => call.role === "junior"));
  assert.deepEqual(
    juniorTokens.map((event) => ({ role: event.role, kind: event.kind, delta: event.delta })),
    expected,
    "the tool-call step's reasoning then the text step's reasoning+text, in order",
  );
  // Tool loop reached both scripted steps: reasoning-only for the call, then
  // reasoning followed by the deliverable JSON text.
  assert.deepEqual(log.map((call) => call.sink), ["tools", "tools"]);
  assert.deepEqual(log.map((call) => call.textChunks.length > 0), [false, true]);
  assert.equal(log[0].thinkingChunks.join(""), MOCK_REASONING);
  assert.equal(log[1].thinkingChunks.join(""), MOCK_REASONING);
  assert.equal(log[1].textChunks.join(""), deliverable);
  assert.ok(
    events.some((event) => event.type === "tool_call" && event.tool === "lookup"),
    "the tool call is on the stream",
  );
  assert.ok(
    events.some((event) => event.type === "tool_result" && event.status === "ok"),
    "the tool result is on the stream",
  );
});

// ---------------------------------------------------------------------------
// NDJSON bounds: a huge thinking delta is clipped like any string field
// ---------------------------------------------------------------------------

test("toNdjsonLine clips a giant thinking delta under the field bound, kind survives", () => {
  const huge = "r".repeat(20_000);
  assert.ok(huge.length > STREAM_FIELD_CHARS);
  const line = toNdjsonLine({
    type: "token",
    role: "junior",
    kind: "thinking",
    delta: huge,
    at: "2026-11-06T00:00:00Z",
  });
  assert.ok(line.length <= STREAM_LINE_CHARS, `line ${line.length} <= ${STREAM_LINE_CHARS}`);
  assert.ok(!line.includes("\n") && !line.includes("\r"));
  const parsed = JSON.parse(line) as TokenStreamEvent;
  assert.equal(parsed.type, "token");
  assert.equal(parsed.role, "junior");
  assert.equal(parsed.kind, "thinking");
  assert.equal(parsed.delta, `<clipped ${huge.length} chars>`);
});
