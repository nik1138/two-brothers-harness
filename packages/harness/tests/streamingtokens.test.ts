/**
 * Token-level provider streaming (`ChatOptions.onDelta`) + the `token` run
 * stream event (`HarnessOptions.streamTokens`).
 *
 * Hermetic: a tiny `node:http` stub on an ephemeral port speaks SSE for the
 * OpenAI-compatible (`/chat/completions`), Anthropic (`/v1/messages`) and
 * Gemini (`:streamGenerateContent?alt=sse`) wire shapes, matched by URL. The
 * cases pin: delta order + the complete reply, usage from the stream, a
 * mid-stream disconnect classified through the existing registry and retried,
 * the harness token-event seam (on/off), the whole-stream per-attempt
 * timeout, and the NDJSON field bound on a giant delta.
 *
 * Run with: node --test tests/streamingtokens.test.ts
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
  MockProvider,
  OpenAICompatibleProvider,
  type ChatOptions,
  type ModelProviderConfig,
  type Tool,
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

const OPENAI_USAGE = { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 };

function writeOpenAIText(res: ServerResponse, chunks: string[] = TEXT_CHUNKS): void {
  startSse(res);
  for (const chunk of chunks) {
    res.write(sseData({ choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }] }));
  }
  res.write(sseData({ choices: [], usage: OPENAI_USAGE }));
  res.write("data: [DONE]\n\n");
  res.end();
}

function writeAnthropicText(res: ServerResponse, chunks: string[] = TEXT_CHUNKS): void {
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
      content_block: { type: "text", text: "" },
    }),
  );
  for (const chunk of chunks) {
    res.write(
      sseEvent("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: chunk },
      }),
    );
  }
  res.write(sseEvent("content_block_stop", { type: "content_block_stop", index: 0 }));
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

function writeGeminiText(res: ServerResponse, chunks: string[] = TEXT_CHUNKS): void {
  startSse(res);
  for (const chunk of chunks) {
    res.write(
      sseData({
        candidates: [{ content: { role: "model", parts: [{ text: chunk }] }, index: 0 }],
      }),
    );
  }
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

const TOOLS: Tool[] = [
  {
    name: "lookup",
    description: "look something up",
    parameters: { type: "object", properties: { q: { type: "string" } } },
    execute: () => "ok",
  },
];

function baseConfig(baseUrl: string, overrides: Partial<ModelProviderConfig> = {}): ModelProviderConfig {
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

// ---------------------------------------------------------------------------
// (i)+(ii) every adapter: ordered deltas, complete reply, usage from the stream
// ---------------------------------------------------------------------------

test("openai-compatible: deltas arrive in order and the final chunk carries usage", async () => {
  const requests: Array<{ path: string; body: Record<string, unknown>; accept?: string }> = [];
  const stub = await startStub(async (req, res, url) => {
    const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    requests.push({ path: url.pathname, body, accept: req.headers.accept });
    writeOpenAIText(res);
  });
  try {
    const deltas: string[] = [];
    const provider = new OpenAICompatibleProvider(baseConfig(stub.baseUrl));
    const text = await provider.chat(MESSAGES, "message", undefined, {
      onDelta: (delta) => deltas.push(delta),
    });

    assert.equal(text, FULL_TEXT);
    assert.deepEqual(deltas, TEXT_CHUNKS, "deltas arrive in provider order");
    assert.equal(deltas.join(""), text, "deltas concatenate to the reply");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].path, "/chat/completions");
    assert.equal(requests[0].body.stream, true, "stream: true rides the wire");
    assert.deepEqual(requests[0].body.stream_options, { include_usage: true });
    assert.equal(requests[0].accept, "text/event-stream");
    assert.deepEqual(provider.usageSnapshot(), {
      model_calls: 1,
      input_tokens: OPENAI_USAGE.prompt_tokens,
      output_tokens: OPENAI_USAGE.completion_tokens,
      cached_tokens: 0,
    });
  } finally {
    await stub.close();
  }
});

test("anthropic: content_block_delta text + message_start/message_delta usage", async () => {
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const stub = await startStub(async (req, res, url) => {
    requests.push({ path: url.pathname, body: JSON.parse(await readBody(req)) as Record<string, unknown> });
    writeAnthropicText(res);
  });
  try {
    const deltas: string[] = [];
    const provider = new AnthropicProvider(baseConfig(stub.baseUrl));
    const text = await provider.chat(MESSAGES, "message", undefined, {
      onDelta: (delta) => deltas.push(delta),
    });

    assert.equal(text, FULL_TEXT);
    assert.deepEqual(deltas, TEXT_CHUNKS);
    assert.equal(requests[0].path, "/v1/messages");
    assert.equal(requests[0].body.stream, true);
    assert.deepEqual(provider.usageSnapshot(), {
      model_calls: 1,
      input_tokens: 21,
      output_tokens: 9,
      cached_tokens: 3,
    });
  } finally {
    await stub.close();
  }
});

test("gemini: :streamGenerateContent?alt=sse text parts + usageMetadata", async () => {
  const requests: Array<{ path: string; search: string; body: Record<string, unknown> }> = [];
  const stub = await startStub(async (req, res, url) => {
    requests.push({
      path: url.pathname,
      search: url.search,
      body: JSON.parse(await readBody(req)) as Record<string, unknown>,
    });
    writeGeminiText(res);
  });
  try {
    const deltas: string[] = [];
    const provider = new GoogleProvider(baseConfig(stub.baseUrl));
    const text = await provider.chat(MESSAGES, "message", undefined, {
      onDelta: (delta) => deltas.push(delta),
    });

    assert.equal(text, FULL_TEXT);
    assert.deepEqual(deltas, TEXT_CHUNKS);
    assert.equal(requests[0].path, "/v1beta/models/m:streamGenerateContent");
    assert.equal(requests[0].search, "?alt=sse");
    assert.equal(requests[0].body.stream, undefined, "Gemini streams by method, not a body flag");
    assert.deepEqual(provider.usageSnapshot(), {
      model_calls: 1,
      input_tokens: 10, // promptTokenCount - cachedContentTokenCount
      output_tokens: 10, // candidatesTokenCount + thoughtsTokenCount
      cached_tokens: 3,
    });
  } finally {
    await stub.close();
  }
});

test("without onDelta the request is the plain non-streaming one", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const stub = await startStub(async (req, res) => {
    bodies.push(JSON.parse(await readBody(req)) as Record<string, unknown>);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "plain" } }], usage: OPENAI_USAGE }));
  });
  try {
    const provider = new OpenAICompatibleProvider(baseConfig(stub.baseUrl));
    assert.equal(await provider.chat(MESSAGES, "message"), "plain");
    assert.equal(bodies[0].stream, undefined, "no stream flag without a delta sink");
    assert.equal(bodies[0].stream_options, undefined);
  } finally {
    await stub.close();
  }
});

// ---------------------------------------------------------------------------
// tool-call assembly from a stream (the harness threads onDelta into the loop)
// ---------------------------------------------------------------------------

test("openai-compatible: streamed tool-call fragments reassemble by index", async () => {
  const stub = await startStub((_req, res) => {
    startSse(res);
    res.write(
      sseData({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: "call_1", type: "function", function: { name: "lookup", arguments: "" } },
              ],
            },
          },
        ],
      }),
    );
    res.write(
      sseData({
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"q":' } }] } }],
      }),
    );
    res.write(
      sseData({
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] } }],
      }),
    );
    res.write(sseData({ choices: [], usage: OPENAI_USAGE }));
    res.write("data: [DONE]\n\n");
    res.end();
  });
  try {
    const deltas: string[] = [];
    const provider = new OpenAICompatibleProvider(baseConfig(stub.baseUrl));
    const response = await provider.chatWithTools(MESSAGES, TOOLS, {
      onDelta: (delta) => deltas.push(delta),
    });
    assert.equal(response.content, "");
    assert.deepEqual(response.toolCalls, [{ id: "call_1", name: "lookup", args: { q: "x" } }]);
    assert.deepEqual(deltas, [], "tool-call fragments are not text deltas");
  } finally {
    await stub.close();
  }
});

test("anthropic: tool_use input_json_delta fragments reassemble", async () => {
  const stub = await startStub((_req, res) => {
    startSse(res);
    res.write(
      sseEvent("message_start", {
        type: "message_start",
        message: { id: "msg_1", usage: { input_tokens: 4, output_tokens: 1 } },
      }),
    );
    res.write(
      sseEvent("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_1", name: "lookup", input: {} },
      }),
    );
    res.write(
      sseEvent("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"q":' },
      }),
    );
    res.write(
      sseEvent("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '"x"}' },
      }),
    );
    res.write(sseEvent("content_block_stop", { type: "content_block_stop", index: 0 }));
    res.write(
      sseEvent("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "tool_use" },
        usage: { output_tokens: 5 },
      }),
    );
    res.write(sseEvent("message_stop", { type: "message_stop" }));
    res.end();
  });
  try {
    const provider = new AnthropicProvider(baseConfig(stub.baseUrl));
    const response = await provider.chatWithTools(MESSAGES, TOOLS, { onDelta: () => undefined });
    assert.equal(response.content, "");
    assert.deepEqual(response.toolCalls, [{ id: "toolu_1", name: "lookup", args: { q: "x" } }]);
    assert.deepEqual(provider.usageSnapshot(), {
      model_calls: 1,
      input_tokens: 4,
      output_tokens: 5,
      cached_tokens: 0,
    });
  } finally {
    await stub.close();
  }
});

test("gemini: streamed functionCall parts become tool calls", async () => {
  const stub = await startStub((_req, res) => {
    startSse(res);
    res.write(
      sseData({
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ functionCall: { name: "lookup", args: { q: "x" } } }],
            },
            index: 0,
          },
        ],
      }),
    );
    res.write(
      sseData({
        candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP", index: 0 }],
        usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 },
      }),
    );
    res.end();
  });
  try {
    const provider = new GoogleProvider(baseConfig(stub.baseUrl));
    const response = await provider.chatWithTools(MESSAGES, TOOLS, { onDelta: () => undefined });
    assert.deepEqual(response.toolCalls, [{ id: "call-1", name: "lookup", args: { q: "x" } }]);
  } finally {
    await stub.close();
  }
});

// ---------------------------------------------------------------------------
// (iii) mid-stream disconnect: classified retryable, retry completes the reply
// ---------------------------------------------------------------------------

test("a mid-stream disconnect is retryable and the retry delivers the full text", async () => {
  let calls = 0;
  const stub = await startStub(async (req, res) => {
    await readBody(req);
    calls += 1;
    if (calls === 1) {
      startSse(res);
      res.write(
        sseData({ choices: [{ index: 0, delta: { content: "Hel" }, finish_reason: null }] }),
      );
      // Drop the socket mid-stream: the HTTP body never completes.
      setTimeout(() => res.socket?.destroy(), 25);
      return;
    }
    writeOpenAIText(res);
  });
  try {
    const deltas: string[] = [];
    const provider = new OpenAICompatibleProvider(baseConfig(stub.baseUrl, { retries: 1 }));
    const text = await provider.chat(MESSAGES, "message", undefined, {
      onDelta: (delta) => deltas.push(delta),
    });

    assert.equal(calls, 2, "the dropped stream was retried once");
    assert.equal(text, FULL_TEXT);
    assert.equal(deltas[0], "Hel", "the partial delta was already delivered");
    assert.deepEqual(deltas.slice(1), TEXT_CHUNKS, "the retry re-sent the whole reply");
    assert.equal(provider.usageSnapshot().model_calls, 1, "usage records the successful attempt only");
  } finally {
    await stub.close();
  }
});

// ---------------------------------------------------------------------------
// (v) the per-attempt timeout bounds the WHOLE stream and retries
// ---------------------------------------------------------------------------

test("a hung stream times out, warns, and the retry completes", async () => {
  let calls = 0;
  const stub = await startStub(async (req, res) => {
    await readBody(req);
    calls += 1;
    if (calls === 1) {
      startSse(res);
      res.write(
        sseData({ choices: [{ index: 0, delta: { content: "Hel" }, finish_reason: null }] }),
      );
      return; // never ends: the whole-stream timeout must abort it
    }
    writeOpenAIText(res);
  });
  try {
    const deltas: string[] = [];
    const warnings: string[] = [];
    const provider = new OpenAICompatibleProvider(
      baseConfig(stub.baseUrl, {
        retries: 1,
        timeout: 0.15,
        onWarning: (line) => warnings.push(line),
      }),
    );
    const text = await provider.chat(MESSAGES, "message", undefined, {
      onDelta: (delta) => deltas.push(delta),
    });

    assert.equal(calls, 2, "the hung attempt was aborted and retried");
    assert.equal(text, FULL_TEXT);
    assert.deepEqual(deltas.slice(1), TEXT_CHUNKS);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /timed out after 0\.15s; retrying \(attempt 2\/2\)/);
  } finally {
    await stub.close();
  }
});

// ---------------------------------------------------------------------------
// (iv) the harness seam: token events in call order, and none when off
// ---------------------------------------------------------------------------

const cfg = (extra: Record<string, unknown> = {}) => resolveConfig({ provider: "mock", ...extra });

interface StreamedCall {
  role: "senior" | "junior";
  text: string;
  chunks: string[];
}

/** A MockProvider that fakes a token stream and logs each call's reply. */
class StreamingMock extends MockProvider {
  private readonly role: "senior" | "junior";
  private readonly log: StreamedCall[];

  constructor(role: "senior" | "junior", log: StreamedCall[]) {
    super();
    this.role = role;
    this.log = log;
  }

  override async chat(
    messages: ChatMessage[],
    responseKind = "message",
    _signal?: AbortSignal,
    options?: ChatOptions,
  ): Promise<string> {
    const text = await super.chat(messages, responseKind);
    const chunks: string[] = [];
    for (let at = 0; at < text.length; at += 17) chunks.push(text.slice(at, at + 17));
    for (const chunk of chunks) options?.onDelta?.(chunk);
    this.log.push({ role: this.role, text, chunks });
    return text;
  }
}

function labels(events: StreamEvent[]): string[] {
  return events
    .filter((event) => event.type !== "token")
    .map((event) => {
      if (event.type === "envelope") return `envelope:${event.envelope.kind}`;
      if (event.type === "run_status") return `run_status:${event.status}`;
      return event.type;
    });
}

async function runConsult(log: StreamedCall[], streamTokens: boolean) {
  const events: StreamEvent[] = [];
  const harness = new TwoBrothersHarness(cfg({ mode: "consult" }), {
    senior: new StreamingMock("senior", log),
    junior: new StreamingMock("junior", log),
    ...(streamTokens ? { streamTokens: true } : {}),
    onStreamEvent: (event) => events.push(event),
  });
  const result = await harness.run("stream token events");
  return { events, result };
}

test("streamTokens emits token events in call order, additive to envelopes", async () => {
  const log: StreamedCall[] = [];
  const { events, result } = await runConsult(log, true);

  const tokens = events.filter((event): event is TokenStreamEvent => event.type === "token");
  assert.ok(tokens.length > 0, "token events were emitted");
  assert.ok(log.length > 0);

  const expected = log.flatMap((call) =>
    call.chunks.map((delta) => ({ role: call.role, kind: "text" as const, delta })),
  );
  assert.deepEqual(
    tokens.map((event) => ({ role: event.role, kind: event.kind, delta: event.delta })),
    expected,
    "every delta arrives once, in provider order, tagged as visible text",
  );
  for (const event of tokens) assert.equal(event.kind, "text", "the fake streams only text deltas");
  assert.equal(
    tokens.map((event) => event.delta).join(""),
    log.map((call) => call.text).join(""),
    "the deltas concatenate to the replies",
  );
  for (const event of tokens) assert.equal(typeof event.at, "string");

  const withoutTokens = await runConsult([], false);
  assert.deepEqual(
    labels(events),
    labels(withoutTokens.events),
    "token events are additive: the envelope/lifecycle records are unchanged",
  );
  const offTokens = withoutTokens.events.filter((event) => event.type === "token");
  assert.equal(offTokens.length, 0, "streamTokens off emits no token events");
  assert.deepEqual(result.errors, []);
  assert.deepEqual(withoutTokens.result.errors, []);
});

test("streamTokens without a stream consumer stays on the non-streaming path", async () => {
  const log: StreamedCall[] = [];
  const harness = new TwoBrothersHarness(cfg({ mode: "consult" }), {
    senior: new StreamingMock("senior", log),
    junior: new StreamingMock("junior", log),
    streamTokens: true,
  });
  const result = await harness.run("no consumer");
  assert.deepEqual(result.errors, []);
  // the fake only streams when it receives a delta sink; none was requested
  assert.equal(log.length, 4);
  assert.ok(log.every((call) => call.chunks.length > 0));
});

// ---------------------------------------------------------------------------
// (vi) a giant delta is clipped by the ordinary field bound
// ---------------------------------------------------------------------------

test("toNdjsonLine clips a giant token delta under the field bound", () => {
  const huge = "x".repeat(20_000);
  assert.ok(huge.length > STREAM_FIELD_CHARS);
  const line = toNdjsonLine({
    type: "token",
    role: "senior",
    kind: "text",
    delta: huge,
    at: "2026-11-04T00:00:00Z",
  });

  assert.ok(line.length <= STREAM_LINE_CHARS, `line ${line.length} <= ${STREAM_LINE_CHARS}`);
  assert.ok(!line.includes("\n") && !line.includes("\r"));
  const parsed = JSON.parse(line) as TokenStreamEvent;
  assert.equal(parsed.type, "token");
  assert.equal(parsed.role, "senior");
  assert.equal(parsed.kind, "text");
  assert.equal(parsed.delta, `<clipped ${huge.length} chars>`);
});