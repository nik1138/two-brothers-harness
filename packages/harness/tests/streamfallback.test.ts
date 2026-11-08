/**
 * Non-SSE completion fallback for streamed attempts.
 *
 * Some OpenAI-compatible endpoints (including the repo's scripted browser-E2E
 * server) ignore `stream: true` and answer with a normal JSON completion. A
 * streamed attempt must accept that body like the non-streaming path does (same
 * result shape, no deltas, same usage/retry behavior) instead of parsing JSON
 * as SSE and silently producing an empty reply.
 *
 * Hermetic: a tiny `node:http` stub on an ephemeral port speaks the three wire
 * families' normal (non-SSE) JSON responses plus the SSE edge cases.
 *
 * Run with: node --test tests/streamfallback.test.ts
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
  OpenAICompatibleProvider,
  ProviderHttpError,
  type ChatOptions,
  type ModelProviderConfig,
  type Tool,
} from "../src/provider.ts";
import type { StreamEvent } from "../src/runstream.ts";

// ---------------------------------------------------------------------------
// hermetic stub
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

function sendJson(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function sendSse(res: ServerResponse, body: string): void {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.end(body);
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const MESSAGES: ChatMessage[] = [{ role: "user", content: "hi" }];
const OPENAI_USAGE = { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 };

const TOOLS: Tool[] = [
  {
    name: "lookup",
    description: "look something up",
    parameters: { type: "object", properties: { q: { type: "string" } } },
    execute: () => "looked up",
  },
];

function openaiCompletion(content: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "chatcmpl-fallback",
    object: "chat.completion",
    model: "m",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: OPENAI_USAGE,
    ...extra,
  };
}

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

interface Capture {
  text: string[];
  thinking: string[];
  options: ChatOptions;
}

function capture(): Capture {
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
// OpenAI-compatible
// ---------------------------------------------------------------------------

test("openai-compatible: a streamed attempt accepts an application/json completion, no deltas", async () => {
  const requests: Array<{ body: Record<string, unknown>; accept?: string }> = [];
  const stub = await startStub(async (req, res) => {
    requests.push({
      body: JSON.parse(await readBody(req)) as Record<string, unknown>,
      accept: req.headers.accept,
    });
    sendJson(res, openaiCompletion("plain answer"));
  });
  try {
    const sinks = capture();
    const provider = new OpenAICompatibleProvider(baseConfig(stub.baseUrl));
    const reply = await provider.chat(MESSAGES, "message", undefined, sinks.options);

    assert.equal(reply, "plain answer", "the JSON completion is parsed like a non-streaming one");
    assert.deepEqual(sinks.text, [], "no text deltas on the fallback");
    assert.deepEqual(sinks.thinking, [], "no thinking deltas on the fallback");
    assert.equal(requests.length, 1, "a successful JSON fallback is not retried");
    assert.equal(requests[0].body.stream, true, "the attempt still requested streaming");
    assert.equal(requests[0].accept, "text/event-stream");
    // Usage recorded exactly once, like the non-streaming path.
    assert.deepEqual(provider.usageSnapshot(), {
      model_calls: 1,
      input_tokens: OPENAI_USAGE.prompt_tokens,
      output_tokens: OPENAI_USAGE.completion_tokens,
      cached_tokens: 0,
      cache_write_tokens: 0,
    });

    // A non-streaming request is byte-identical to before (no stream flag).
    const plain = await provider.chat(MESSAGES, "message");
    assert.equal(plain, "plain answer");
    assert.equal(requests.length, 2);
    assert.equal(requests[1].body.stream, undefined);
    assert.equal(requests[1].body.stream_options, undefined);
  } finally {
    await stub.close();
  }
});

test("openai-compatible: chatWithTools keeps tool calls from a JSON fallback", async () => {
  const stub = await startStub((_req, res) => {
    sendJson(res, {
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "lookup", arguments: '{"q":"x"}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: OPENAI_USAGE,
    });
  });
  try {
    const sinks = capture();
    const provider = new OpenAICompatibleProvider(baseConfig(stub.baseUrl));
    const response = await provider.chatWithTools(MESSAGES, TOOLS, sinks.options);
    assert.equal(response.content, "");
    assert.deepEqual(response.toolCalls, [{ id: "call_1", name: "lookup", args: { q: "x" } }]);
    assert.deepEqual(sinks.text, [], "tool-call fallback emits no deltas");
    assert.equal(provider.usageSnapshot().model_calls, 1);
  } finally {
    await stub.close();
  }
});

// ---------------------------------------------------------------------------
// Anthropic + Google normal JSON shapes
// ---------------------------------------------------------------------------

test("anthropic: a streamed request accepts the normal JSON messages shape", async () => {
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const stub = await startStub(async (req, res, url) => {
    requests.push({
      path: url.pathname,
      body: JSON.parse(await readBody(req)) as Record<string, unknown>,
    });
    sendJson(res, {
      id: "msg_fallback",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "plain answer" }],
      usage: { input_tokens: 4, output_tokens: 2, cache_read_input_tokens: 1 },
    });
  });
  try {
    const sinks = capture();
    const provider = new AnthropicProvider(baseConfig(stub.baseUrl));
    const reply = await provider.chat(MESSAGES, "message", undefined, sinks.options);
    assert.equal(reply, "plain answer");
    assert.deepEqual(sinks.text, []);
    assert.deepEqual(sinks.thinking, []);
    assert.equal(requests[0].path, "/v1/messages");
    assert.equal(requests[0].body.stream, true);
    assert.deepEqual(provider.usageSnapshot(), {
      model_calls: 1,
      input_tokens: 4,
      output_tokens: 2,
      cached_tokens: 1,
      cache_write_tokens: 0,
    });
  } finally {
    await stub.close();
  }
});

test("gemini: a streamed request accepts the normal JSON candidates shape", async () => {
  const requests: Array<{ path: string; search: string; body: Record<string, unknown> }> = [];
  const stub = await startStub(async (req, res, url) => {
    requests.push({
      path: url.pathname,
      search: url.search,
      body: JSON.parse(await readBody(req)) as Record<string, unknown>,
    });
    sendJson(res, {
      candidates: [{ content: { role: "model", parts: [{ text: "plain answer" }] } }],
      usageMetadata: {
        promptTokenCount: 7,
        cachedContentTokenCount: 2,
        candidatesTokenCount: 3,
        thoughtsTokenCount: 1,
      },
    });
  });
  try {
    const sinks = capture();
    const provider = new GoogleProvider(baseConfig(stub.baseUrl));
    const reply = await provider.chat(MESSAGES, "message", undefined, sinks.options);
    assert.equal(reply, "plain answer");
    assert.deepEqual(sinks.text, []);
    assert.deepEqual(sinks.thinking, []);
    assert.equal(requests[0].path, "/v1beta/models/m:streamGenerateContent");
    assert.equal(requests[0].search, "?alt=sse");
    assert.deepEqual(provider.usageSnapshot(), {
      model_calls: 1,
      input_tokens: 5, // promptTokenCount - cachedContentTokenCount
      output_tokens: 4, // candidatesTokenCount + thoughtsTokenCount
      cached_tokens: 2,
      cache_write_tokens: 0,
    });
  } finally {
    await stub.close();
  }
});

// ---------------------------------------------------------------------------
// error classification unchanged
// ---------------------------------------------------------------------------

test("a 500 JSON error body stays retryable with streaming requested", async () => {
  let calls = 0;
  const stub = await startStub((_req, res) => {
    calls += 1;
    sendJson(res, { error: { message: "server exploded" } }, 500);
  });
  try {
    const provider = new OpenAICompatibleProvider(baseConfig(stub.baseUrl, { retries: 1 }));
    const sinks = capture();
    await assert.rejects(
      provider.chat(MESSAGES, "message", undefined, sinks.options),
      (err: unknown) => {
        assert.ok(err instanceof ProviderHttpError, String(err));
        assert.equal(err.status, 500);
        assert.equal(err.retryable, true);
        assert.match(err.message, /HTTP 500/);
        return true;
      },
    );
    assert.equal(calls, 2, "a retryable 5xx is retried exactly as before");
  } finally {
    await stub.close();
  }
});

test("a 400 JSON error body stays fatal with streaming requested", async () => {
  let calls = 0;
  const stub = await startStub((_req, res) => {
    calls += 1;
    sendJson(res, { error: { message: "bad request" } }, 400);
  });
  try {
    const provider = new OpenAICompatibleProvider(baseConfig(stub.baseUrl, { retries: 3 }));
    const sinks = capture();
    await assert.rejects(
      provider.chat(MESSAGES, "message", undefined, sinks.options),
      (err: unknown) => {
        assert.ok(err instanceof ProviderHttpError, String(err));
        assert.equal(err.status, 400);
        assert.equal(err.retryable, false);
        return true;
      },
    );
    assert.equal(calls, 1, "a fatal 4xx is never retried");
  } finally {
    await stub.close();
  }
});

test("a non-JSON body on a JSON response fails loudly instead of an empty reply", async () => {
  const stub = await startStub((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("definitely not json");
  });
  try {
    const provider = new OpenAICompatibleProvider(baseConfig(stub.baseUrl, { retries: 0 }));
    const sinks = capture();
    await assert.rejects(
      provider.chat(MESSAGES, "message", undefined, sinks.options),
      /not a JSON completion/,
    );
    assert.deepEqual(sinks.text, []);
  } finally {
    await stub.close();
  }
});

// ---------------------------------------------------------------------------
// SSE edge cases: unchanged behavior / mislabelled JSON recovery
// ---------------------------------------------------------------------------

test("an SSE-advertised empty or comment-only stream keeps the current empty result", async () => {
  const bodies = [": keepalive\n\n", "data: [DONE]\n\n", ""];
  for (const body of bodies) {
    const stub = await startStub((_req, res) => sendSse(res, body));
    try {
      const sinks = capture();
      const provider = new OpenAICompatibleProvider(baseConfig(stub.baseUrl));
      const reply = await provider.chat(MESSAGES, "message", undefined, sinks.options);
      assert.equal(reply, "", `no frames in ${JSON.stringify(body)} -> empty content as today`);
      assert.deepEqual(sinks.text, []);
    } finally {
      await stub.close();
    }
  }
});

test("an SSE-advertised plain JSON body is recovered as a JSON completion", async () => {
  const stub = await startStub((_req, res) => {
    // Mislabelled gateway: advertises SSE but sends the normal JSON body.
    sendSse(res, JSON.stringify(openaiCompletion("recovered answer")));
  });
  try {
    const sinks = capture();
    const provider = new OpenAICompatibleProvider(baseConfig(stub.baseUrl));
    const reply = await provider.chat(MESSAGES, "message", undefined, sinks.options);
    assert.equal(reply, "recovered answer");
    assert.deepEqual(sinks.text, [], "no deltas are emitted for the recovery");
    assert.equal(provider.usageSnapshot().model_calls, 1);
  } finally {
    await stub.close();
  }
});

// ---------------------------------------------------------------------------
// harness: streamTokens against a JSON-only endpoint still completes
// ---------------------------------------------------------------------------

const UNION_PAYLOAD = {
  text: "ok",
  task: "pick an approach",
  ask: "what is best?",
  expect: "proposal",
  title: "Plan",
  answer: "Do it",
  rationale: "because",
  risks: [],
  asks: [],
  confidence: 0.7,
  work: "do part",
  acceptance: ["done"],
  return: "deliverable",
  result: "done",
  artifacts: [],
  notes: "ok",
  verdict: "accept",
  points: [],
  decision: "ok",
  dissent: null,
  accepted_proposals: ["Plan"],
};

test("a run with streamTokens against a JSON-only endpoint reaches the terminal result", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const stub = await startStub(async (req, res) => {
    requests.push(JSON.parse(await readBody(req)) as Record<string, unknown>);
    sendJson(res, openaiCompletion(JSON.stringify(UNION_PAYLOAD)));
  });
  try {
    const events: StreamEvent[] = [];
    const harness = new TwoBrothersHarness(
      resolveConfig({
        provider: "openai",
        baseUrl: stub.baseUrl,
        apiKey: "k",
        seniorModel: "m",
        juniorModel: "m",
        retries: 0,
        timeout: 5,
        mode: "consult",
      }),
      { streamTokens: true, onStreamEvent: (event) => events.push(event) },
    );
    const result = await harness.run("pick an approach");

    assert.deepEqual(result.errors, [], "the run completed without streaming degradation");
    assert.equal(String(result.decision.decision), "ok", "a terminal decision was produced");
    assert.equal(result.messages.length, 5, "the normal consult transcript was assembled");
    assert.equal(
      events.filter((event) => event.type === "token").length,
      0,
      "JSON fallbacks emit no token deltas",
    );
    assert.ok(events.some((event) => event.type === "result"), "the terminal result record arrived");
    assert.ok(result.usage.model_calls >= 4, "usage was recorded for every call");
    assert.ok(result.usage.input_tokens > 0);
    assert.ok(
      requests.length > 0 && requests.every((body) => body.stream === true),
      "every attempt requested streaming before falling back",
    );
  } finally {
    await stub.close();
  }
});
