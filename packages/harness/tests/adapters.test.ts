/**
 * Native provider adapters (Wave 3): Anthropic Messages and Google Gemini
 * behind the existing `Provider` interface. Hermetic — every request goes to
 * a stub `FetchLike`, waits are recorded through the injectable sleeper, so
 * no endpoint or clock is touched.
 *
 * Covers each family's request mapping (system placement, message roles,
 * tool schemas), response parsing (text, tool calls, usage), error
 * classification through `PROVIDER_ERROR_REGISTRY` (429/Retry-After, fatal
 * 4xx, overloaded/5xx, context overflow) and `buildProvider`'s kind
 * dispatch. The final section pins the OpenAI-compatible request shape so
 * the shared retry-loop refactor stays byte-stable.
 *
 * Run with: node tests/run-all.ts  (or node --test tests/)
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { ChatMessage } from "../src/context.ts";
import { main } from "../src/cli.ts";
import { resolveConfig } from "../src/config.ts";
import { TwoBrothersHarness } from "../src/harness.ts";
import {
  AnthropicProvider,
  buildProvider,
  classifyProviderError,
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_PROVIDER_KIND,
  GoogleProvider,
  MAX_ERROR_BODY_BYTES,
  MAX_ERROR_DETAIL_CHARS,
  MAX_STREAM_BYTES,
  OpenAICompatibleProvider,
  ProviderBlockedError,
  ProviderContextOverflowError,
  ProviderHttpError,
  resolveProviderKind,
  type FetchLike,
  type ModelProviderConfig,
  type Tool,
} from "../src/provider.ts";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

interface RecordedRequest {
  url: string;
  headers: Record<string, string>;
  body: any;
  method: string;
}

/** Replays `handler` for every call and records the wire request. */
function stubFetch(
  handler: (request: RecordedRequest, index: number) => Response,
): { fetchImpl: FetchLike; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  return {
    requests,
    fetchImpl: async (url, init) => {
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries((init.headers ?? {}) as Record<string, string>)) {
        headers[name.toLowerCase()] = value;
      }
      const request: RecordedRequest = {
        url,
        headers,
        body: typeof init.body === "string" ? JSON.parse(init.body) : init.body,
        method: init.method ?? "",
      };
      requests.push(request);
      return handler(request, requests.length - 1);
    },
  };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function recordingSleeper(): { sleeper: (s: number) => Promise<void>; total: () => number } {
  let total = 0;
  return {
    total: () => total,
    sleeper: async (seconds) => {
      total += seconds;
    },
  };
}

/** One SSE frame block (`event:` + one `data:` JSON line). */
function sseFrame(event: string, payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

/** An SSE-streamed 200 response from raw frame blocks. */
function sseResponse(frames: readonly string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

/** One chunked body of `sizes` ASCII-byte chunks, for cap tests. */
function chunkedResponse(
  chunks: readonly number[],
  contentType: string,
  status = 200,
): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const size of chunks) controller.enqueue(new Uint8Array(size).fill(0x61));
      controller.close();
    },
  });
  return new Response(body, { status, headers: { "Content-Type": contentType } });
}

/** A minimal valid OpenAI-compatible SSE completion. */
function openAiTextSse(text: string): Response {
  return sseResponse([
    sseFrame("x", { choices: [{ delta: { content: text } }] }),
    sseFrame("x", {
      choices: [],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    }),
    "data: [DONE]\n\n",
  ]);
}

/** Await a rejection and return the thrown error (fails the test otherwise). */
async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected the promise to reject");
}

const MESSAGES: ChatMessage[] = [
  { role: "system", content: "SYS" },
  { role: "user", content: "hello" },
  {
    role: "assistant",
    content: "",
    toolCalls: [{ id: "call_1", name: "lookup", args: { q: "x" } }],
  },
  { role: "tool", content: "result text", toolCallId: "call_1" },
  { role: "tool", content: "result two", toolCallId: "call_1" },
];

const TOOLS: Tool[] = [
  {
    name: "lookup",
    description: "Look something up",
    parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
    execute: () => "unused",
  },
];

const BASE: Omit<ModelProviderConfig, "fetchImpl"> = {
  provider: "openai",
  baseUrl: "http://stub.example",
  apiKey: "secret-key",
  seniorModel: "senior-model",
  juniorModel: "junior-model",
  temperature: 0.2,
  timeout: 5,
  retries: 0,
  model: "native-model",
};

function anthropicProvider(
  fetchImpl: FetchLike,
  overrides: Partial<ModelProviderConfig> = {},
): AnthropicProvider {
  return new AnthropicProvider({ ...BASE, model: "claude-test", fetchImpl, ...overrides });
}

function googleProvider(
  fetchImpl: FetchLike,
  overrides: Partial<ModelProviderConfig> = {},
): GoogleProvider {
  return new GoogleProvider({ ...BASE, model: "gemini-test", fetchImpl, ...overrides });
}

// ---------------------------------------------------------------------------
// Anthropic request mapping
// ---------------------------------------------------------------------------

test("anthropic: cached top-level system, tool blocks map both ways, cache breakpoints", async () => {
  const stub = stubFetch(() =>
    jsonResponse({
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
  );
  const provider = anthropicProvider(stub.fetchImpl);
  await provider.chatWithTools(MESSAGES, TOOLS);

  assert.equal(stub.requests.length, 1);
  const request = stub.requests[0];
  assert.equal(request.url, "http://stub.example/v1/messages");
  assert.equal(request.method, "POST");
  assert.equal(request.headers["x-api-key"], "secret-key");
  assert.equal(request.headers["anthropic-version"], "2023-06-01");
  assert.equal(request.headers.authorization, undefined);

  const body = request.body;
  assert.equal(body.model, "claude-test");
  assert.equal(body.max_tokens, DEFAULT_MAX_OUTPUT_TOKENS);
  assert.equal(body.temperature, 0.2);
  // The system prompt is one cached text block, never a message.
  assert.deepEqual(body.system, [
    { type: "text", text: "SYS", cache_control: { type: "ephemeral" } },
  ]);
  assert.deepEqual(body.messages, [
    { role: "user", content: [{ type: "text", text: "hello" }] },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "call_1", name: "lookup", input: { q: "x" } }],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "call_1", content: "result text" },
        {
          type: "tool_result",
          tool_use_id: "call_1",
          content: "result two",
          // The newest turn carries the conversation cache breakpoint.
          cache_control: { type: "ephemeral" },
        },
      ],
    },
  ]);
  assert.deepEqual(body.tools, [
    {
      name: "lookup",
      description: "Look something up",
      input_schema: TOOLS[0].parameters,
      // The last (here: only) tool definition carries the tools breakpoint.
      cache_control: { type: "ephemeral" },
    },
  ]);
});

test("anthropic: an explicit /v1 base is not prefixed twice; maxTokens is honored", async () => {
  const stub = stubFetch(() =>
    jsonResponse({ content: [{ type: "text", text: "ok" }], usage: {} }),
  );
  const provider = anthropicProvider(stub.fetchImpl, {
    baseUrl: "http://stub.example/v1",
    maxTokens: 1234,
  });
  await provider.chat([{ role: "system", content: "S" }, { role: "user", content: "u" }]);
  assert.equal(stub.requests[0].url, "http://stub.example/v1/messages");
  assert.equal(stub.requests[0].body.max_tokens, 1234);
});

test("anthropic: multiple system messages merge in order into one cached block", async () => {
  const stub = stubFetch(() => jsonResponse({ content: [], usage: {} }));
  const provider = anthropicProvider(stub.fetchImpl);
  await provider.chat([
    { role: "system", content: "first" },
    { role: "system", content: "second" },
    { role: "user", content: "u" },
  ]);
  assert.deepEqual(stub.requests[0].body.system, [
    { type: "text", text: "first\n\nsecond", cache_control: { type: "ephemeral" } },
  ]);
});

// ---------------------------------------------------------------------------
// Anthropic response + usage
// ---------------------------------------------------------------------------

test("anthropic: text and tool_use blocks round-trip with usage", async () => {
  const stub = stubFetch(() =>
    jsonResponse({
      content: [
        { type: "text", text: "Let me check." },
        { type: "tool_use", id: "toolu_1", name: "lookup", input: { q: "x" } },
      ],
      stop_reason: "tool_use",
      usage: {
        input_tokens: 120,
        output_tokens: 30,
        cache_read_input_tokens: 40,
        cache_creation_input_tokens: 10,
      },
    }),
  );
  const provider = anthropicProvider(stub.fetchImpl);
  const response = await provider.chatWithTools(MESSAGES, TOOLS);
  assert.deepEqual(response, {
    content: "Let me check.",
    toolCalls: [{ id: "toolu_1", name: "lookup", args: { q: "x" } }],
  });
  assert.deepEqual(provider.usageSnapshot(), {
    model_calls: 1,
    input_tokens: 120,
    output_tokens: 30,
    cached_tokens: 40,
    cache_write_tokens: 10,
    prompt_tokens: 170,
  });
});

test("anthropic: plain chat joins text blocks and rejects a shapeless body", async () => {
  const stub = stubFetch((_request, index) =>
    index === 0
      ? jsonResponse({
          content: [{ type: "text", text: "a" }, { type: "text", text: "b" }],
          usage: {},
        })
      : jsonResponse({ nope: true }),
  );
  const provider = anthropicProvider(stub.fetchImpl);
  assert.equal(await provider.chat([{ role: "user", content: "u" }]), "ab");
  await assert.rejects(
    provider.chat([{ role: "user", content: "u" }]),
    /unexpected response shape from http:\/\/stub\.example\/v1\/messages/,
  );
});

// ---------------------------------------------------------------------------
// Anthropic error classification
// ---------------------------------------------------------------------------

test("anthropic: 429 rate_limit_error is retryable and honors Retry-After", async () => {
  const sleep = recordingSleeper();
  const stub = stubFetch((_request, index) =>
    index === 0
      ? jsonResponse(
          {
            type: "error",
            error: { type: "rate_limit_error", message: "Number of requests exceeded." },
          },
          429,
          { "Retry-After": "0.1" },
        )
      : jsonResponse({ content: [{ type: "text", text: "ok" }], usage: {} }),
  );
  const provider = anthropicProvider(stub.fetchImpl, { retries: 1, sleeper: sleep.sleeper });
  assert.equal(await provider.chat([{ role: "user", content: "u" }]), "ok");
  assert.equal(stub.requests.length, 2);
  assert.ok(Math.abs(sleep.total() - 0.1) < 1e-9, `slept ${sleep.total()}s, not 0.1s`);
});

test("anthropic: authentication_error is fatal and carries the provider message", async () => {
  const stub = stubFetch(() =>
    jsonResponse(
      { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } },
      401,
    ),
  );
  const provider = anthropicProvider(stub.fetchImpl);
  await assert.rejects(provider.chat([{ role: "user", content: "u" }]), (err: unknown) => {
    assert.ok(err instanceof ProviderHttpError);
    assert.equal(err.status, 401);
    assert.equal(err.retryable, false);
    assert.equal(err.reason, "provider-rejected");
    assert.match(err.message, /Anthropic API error 401 \(authentication_error\)/);
    assert.match(err.message, /invalid x-api-key/);
    return true;
  });
  assert.equal(stub.requests.length, 1);
});

test("anthropic: overloaded_error (529) is retryable", async () => {
  const stub = stubFetch(() =>
    jsonResponse(
      { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
      529,
    ),
  );
  const provider = anthropicProvider(stub.fetchImpl);
  await assert.rejects(provider.chat([{ role: "user", content: "u" }]), (err: unknown) => {
    assert.ok(err instanceof ProviderHttpError);
    assert.equal(err.status, 529);
    assert.equal(err.retryable, true);
    assert.equal(err.reason, "provider-transient");
    assert.match(err.message, /overloaded_error/);
    return true;
  });
  assert.equal(stub.requests.length, 1); // retries=0: classified, not resent
});

test("anthropic: prompt-too-long is ProviderContextOverflowError, never retried", async () => {
  const stub = stubFetch(() =>
    jsonResponse(
      {
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "prompt is too long: 213462 tokens > 200000 maximum",
        },
      },
      400,
    ),
  );
  const sleep = recordingSleeper();
  const provider = anthropicProvider(stub.fetchImpl, { retries: 6, sleeper: sleep.sleeper });
  await assert.rejects(provider.chat([{ role: "user", content: "u" }]), (err: unknown) => {
    assert.ok(err instanceof ProviderContextOverflowError);
    assert.ok(err instanceof ProviderHttpError);
    assert.equal(err.status, 400);
    assert.equal(err.retryable, false);
    assert.equal(err.reason, "context-overflow");
    assert.match(err.message, /prompt is too long/);
    return true;
  });
  assert.equal(stub.requests.length, 1);
  assert.equal(sleep.total(), 0);
});

test("anthropic: request_too_large type is overflow even on 413", async () => {
  const stub = stubFetch(() =>
    jsonResponse(
      {
        type: "error",
        error: { type: "request_too_large", message: "Request exceeds the maximum size" },
      },
      413,
    ),
  );
  const provider = anthropicProvider(stub.fetchImpl);
  await assert.rejects(
    provider.chat([{ role: "user", content: "u" }]),
    ProviderContextOverflowError,
  );
});

test("anthropic: context_length_exceeded type is overflow even with a generic message", async () => {
  const stub = stubFetch(() =>
    jsonResponse(
      {
        type: "error",
        error: { type: "context_length_exceeded", message: "Request failed" },
      },
      400,
    ),
  );
  const provider = anthropicProvider(stub.fetchImpl);
  await assert.rejects(
    provider.chat([{ role: "user", content: "u" }]),
    ProviderContextOverflowError,
  );
});

// ---------------------------------------------------------------------------
// Google request mapping
// ---------------------------------------------------------------------------

test("google: systemInstruction, model/user contents and function parts", async () => {
  const stub = stubFetch(() =>
    jsonResponse({
      candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    }),
  );
  const provider = googleProvider(stub.fetchImpl);
  await provider.chatWithTools(MESSAGES, TOOLS);

  const request = stub.requests[0];
  assert.equal(
    request.url,
    "http://stub.example/v1beta/models/gemini-test:generateContent",
  );
  assert.equal(request.headers["x-goog-api-key"], "secret-key");
  assert.equal(request.headers.authorization, undefined);

  const body = request.body;
  assert.deepEqual(body.systemInstruction, { parts: [{ text: "SYS" }] });
  assert.deepEqual(body.contents, [
    { role: "user", parts: [{ text: "hello" }] },
    { role: "model", parts: [{ functionCall: { name: "lookup", args: { q: "x" } } }] },
    {
      role: "user",
      parts: [
        { functionResponse: { name: "lookup", response: { output: "result text" } } },
        { functionResponse: { name: "lookup", response: { output: "result two" } } },
      ],
    },
  ]);
  assert.deepEqual(body.tools, [
    {
      functionDeclarations: [
        { name: "lookup", description: "Look something up", parameters: TOOLS[0].parameters },
      ],
    },
  ]);
  assert.deepEqual(body.generationConfig, { temperature: 0.2 });
});

test("google: tool parameter schemas drop proto-unsupported keywords and keep proto-supported ones", async () => {
  // Gemini's function_declarations Schema proto rejects JSON-schema keywords
  // like `additionalProperties` with a 400; the adapter must whitelist the
  // schema recursively (top level and nested) while keeping valid structure.
  // Keywords the proto does support (pattern, minLength/minimum, …) survive.
  const mixedTools: Tool[] = [
    {
      name: "mutate",
      description: "Mutate something",
      parameters: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string", minLength: 1, pattern: "^[a-z]+$" },
          opts: {
            type: "object",
            additionalProperties: false,
            properties: { n: { type: "integer", minimum: 0, maximum: 10 } },
            required: ["n"],
          },
          tags: { type: "array", items: { type: "string", maxLength: 8 }, maxItems: 5 },
        },
        required: ["path"],
      },
      execute: () => "unused",
    },
  ];
  const stub = stubFetch(() =>
    jsonResponse({
      candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    }),
  );
  const provider = googleProvider(stub.fetchImpl);
  await provider.chatWithTools(MESSAGES, mixedTools);

  const wire = JSON.stringify(stub.requests[0].body);
  // Proto-unsupported keywords are still stripped, nested included.
  assert.equal(wire.includes("additionalProperties"), false);
  assert.equal(wire.includes("$schema"), false);
  // Proto-supported constraint keywords are kept.
  assert.equal(wire.includes("minLength"), true);
  assert.equal(wire.includes("maxLength"), true);
  assert.equal(wire.includes("pattern"), true);
  assert.equal(wire.includes("minimum"), true);
  assert.equal(wire.includes("maximum"), true);
  // Valid Schema structure is kept, never reshaped.
  assert.deepEqual(stub.requests[0].body.tools, [
    {
      functionDeclarations: [
        {
          name: "mutate",
          description: "Mutate something",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", minLength: 1, pattern: "^[a-z]+$" },
              opts: {
                type: "object",
                properties: { n: { type: "integer", minimum: 0, maximum: 10 } },
                required: ["n"],
              },
              tags: { type: "array", items: { type: "string", maxLength: 8 }, maxItems: 5 },
            },
            required: ["path"],
          },
        },
      ],
    },
  ]);
});

test("google: proto-supported constraint keywords survive at the top level verbatim", async () => {
  // `anyOf`, `pattern`, `minLength`/`maxLength` and `minimum`/`maximum` are
  // Schema proto fields: the whitelist keeps their values and their order
  // exactly as declared (pure key filtering, no reshaping/coercion).
  const parameters = {
    type: "object",
    anyOf: [{ type: "string" }, { type: "integer" }],
    pattern: "^[a-z]+$",
    minLength: 1,
    maxLength: 64,
    minimum: 2,
    maximum: 99,
    properties: { q: { type: "string" } },
    required: ["q"],
  };
  const tools: Tool[] = [
    { name: "constrained", description: "Constrained", parameters, execute: () => "unused" },
  ];
  const stub = stubFetch(() =>
    jsonResponse({
      candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    }),
  );
  await googleProvider(stub.fetchImpl).chatWithTools(MESSAGES, tools);

  const declaration = stub.requests[0].body.tools[0].functionDeclarations[0];
  assert.equal(JSON.stringify(declaration.parameters), JSON.stringify(parameters));
});

test("google: the whitelist recurses into properties, items and anyOf branches", async () => {
  const parameters = {
    type: "object",
    properties: {
      slug: { type: "string", pattern: "^[a-z0-9-]+$", minLength: 2, maxLength: 32 },
      score: { type: "integer", minimum: 0, maximum: 5, additionalProperties: false },
      choice: {
        anyOf: [
          { type: "string", pattern: "^(on|off)$" },
          { type: "integer", minimum: 1, maximum: 3 },
        ],
      },
      tags: { type: "array", items: { type: "string", minLength: 1 }, maxItems: 4 },
    },
    required: ["slug"],
  };
  const tools: Tool[] = [
    { name: "nested", description: "Nested", parameters, execute: () => "unused" },
  ];
  const stub = stubFetch(() =>
    jsonResponse({
      candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    }),
  );
  await googleProvider(stub.fetchImpl).chatWithTools(MESSAGES, tools);

  assert.deepEqual(stub.requests[0].body.tools[0].functionDeclarations[0].parameters, {
    type: "object",
    properties: {
      slug: { type: "string", pattern: "^[a-z0-9-]+$", minLength: 2, maxLength: 32 },
      score: { type: "integer", minimum: 0, maximum: 5 },
      choice: {
        anyOf: [
          { type: "string", pattern: "^(on|off)$" },
          { type: "integer", minimum: 1, maximum: 3 },
        ],
      },
      tags: { type: "array", items: { type: "string", minLength: 1 }, maxItems: 4 },
    },
    required: ["slug"],
  });
});

test("google: mixed schemas keep supported keywords and drop unsupported ones at every depth", async () => {
  // Same whitelist per level: inside an `anyOf` branch and inside `items`,
  // `$schema`/`$ref`/`title`/`default`/`additionalProperties` are dropped
  // while every proto-supported key survives in place.
  const parameters = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    properties: {
      mode: {
        anyOf: [
          { type: "string", pattern: "^a$", $ref: "#/x" },
          { type: "integer", minimum: 1, title: "n" },
        ],
      },
      list: {
        type: "array",
        items: { type: "string", maxLength: 3, default: "x" },
        maxItems: 2,
      },
    },
    required: ["mode"],
  };
  const tools: Tool[] = [
    { name: "mixed", description: "Mixed", parameters, execute: () => "unused" },
  ];
  const stub = stubFetch(() =>
    jsonResponse({
      candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    }),
  );
  await googleProvider(stub.fetchImpl).chatWithTools(MESSAGES, tools);

  const body = stub.requests[0].body;
  assert.deepEqual(body.tools[0].functionDeclarations[0].parameters, {
    type: "object",
    properties: {
      mode: {
        anyOf: [{ type: "string", pattern: "^a$" }, { type: "integer", minimum: 1 }],
      },
      list: { type: "array", items: { type: "string", maxLength: 3 }, maxItems: 2 },
    },
    required: ["mode"],
  });
  for (const unsupported of ["$schema", "$ref", "title", "default", "additionalProperties"]) {
    assert.equal(
      JSON.stringify(body).includes(unsupported),
      false,
      `${unsupported} must not reach the Gemini wire`,
    );
  }
});

test("openai-compatible: dirty tool parameter schema is forwarded byte-identically", async () => {
  // The Gemini normalization must not leak into the OpenAI path: the tool
  // schema reaches the wire exactly as declared.
  const dirty: Tool[] = [
    {
      name: "mutate",
      description: "Mutate something",
      parameters: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: false,
        properties: { path: { type: "string", minLength: 1 } },
        required: ["path"],
      },
      execute: () => "unused",
    },
  ];
  const stub = stubFetch(() =>
    jsonResponse({
      choices: [{ message: { content: "ok" } }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    }),
  );
  const provider = new OpenAICompatibleProvider({
    ...BASE,
    model: "openai-test",
    fetchImpl: stub.fetchImpl,
  });
  await provider.chatWithTools(MESSAGES, dirty);

  assert.deepEqual(stub.requests[0].body.tools, [
    {
      type: "function",
      function: {
        name: "mutate",
        description: "Mutate something",
        parameters: dirty[0].parameters,
      },
    },
  ]);
});

test("google: an explicit /v1beta base is used as-is; models/ prefix is normalized", async () => {
  const stub = stubFetch(() => jsonResponse({ candidates: [{ content: { parts: [] } }] }));
  const provider = googleProvider(stub.fetchImpl, {
    baseUrl: "http://stub.example/v1beta",
    model: "models/gemini-test",
  });
  await provider.chat([{ role: "user", content: "u" }]);
  assert.equal(
    stub.requests[0].url,
    "http://stub.example/v1beta/models/gemini-test:generateContent",
  );
});

test("google: non-finite maxTokens is rejected, never serialized as null", async () => {
  // `JSON.stringify(Infinity)` is `null`: a non-finite cap must not reach the
  // wire as `"maxOutputTokens": null`. The Anthropic adapter already guards
  // with `Number.isFinite`; Google must behave the same way.
  const stub = stubFetch(() =>
    jsonResponse({
      candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    }),
  );
  for (const bad of [Infinity, -Infinity, NaN]) {
    const provider = googleProvider(stub.fetchImpl, { maxTokens: bad });
    assert.equal(provider.maxTokens, undefined, `${String(bad)} must not become a wire cap`);
    await provider.chat([{ role: "user", content: "u" }]);
    assert.equal(
      stub.requests.at(-1)!.body.generationConfig.maxOutputTokens,
      undefined,
      `${String(bad)} must not serialize onto the wire`,
    );
  }
  // Finite caps are still honored (truncated like the other adapters).
  const finite = googleProvider(stub.fetchImpl, { maxTokens: 777.9 });
  assert.equal(finite.maxTokens, 777);
  await finite.chat([{ role: "user", content: "u" }]);
  assert.equal(stub.requests.at(-1)!.body.generationConfig.maxOutputTokens, 777);
});

// ---------------------------------------------------------------------------
// Google response + usage
// ---------------------------------------------------------------------------

test("google: text skips thought parts, functionCall parses, usage subtracts cache", async () => {
  const stub = stubFetch(() =>
    jsonResponse({
      candidates: [
        {
          content: {
            role: "model",
            parts: [
              { text: "thinking...", thought: true },
              { text: "Visible answer" },
              { functionCall: { id: "fc_1", name: "lookup", args: { q: "x" } } },
            ],
          },
          finishReason: "STOP",
        },
      ],
      usageMetadata: {
        promptTokenCount: 120,
        cachedContentTokenCount: 40,
        candidatesTokenCount: 25,
        thoughtsTokenCount: 5,
        totalTokenCount: 150,
      },
    }),
  );
  const provider = googleProvider(stub.fetchImpl);
  const response = await provider.chatWithTools(MESSAGES, TOOLS);
  assert.deepEqual(response, {
    content: "Visible answer",
    toolCalls: [{ id: "fc_1", name: "lookup", args: { q: "x" } }],
  });
  assert.deepEqual(provider.usageSnapshot(), {
    model_calls: 1,
    input_tokens: 80,
    output_tokens: 30,
    cached_tokens: 40,
    cache_write_tokens: 0,
    prompt_tokens: 120,
  });
});

test("google: promptFeedback.blockReason yields a dedicated blocked error naming the reason", async () => {
  for (const blockReason of ["SAFETY", "OTHER"]) {
    const stub = stubFetch(() => jsonResponse({ promptFeedback: { blockReason } }));
    const provider = googleProvider(stub.fetchImpl);
    await assert.rejects(provider.chat([{ role: "user", content: "u" }]), (err: unknown) => {
      assert.ok(err instanceof ProviderBlockedError, String(err));
      assert.equal(err.reason, blockReason);
      assert.match(err.message, new RegExp(`Google blocked the prompt \\(${blockReason}\\)`));
      assert.match(err.message, /generateContent/);
      return true;
    });
    assert.equal(stub.requests.length, 1);
  }
});

test("google: a malformed payload without candidates or blockReason is still a shape error", async () => {
  const stub = stubFetch(() => jsonResponse({ nope: true }));
  const provider = googleProvider(stub.fetchImpl);
  await assert.rejects(
    provider.chat([{ role: "user", content: "u" }]),
    /unexpected response shape from .*generateContent/,
  );
});

// ---------------------------------------------------------------------------
// Google error classification
// ---------------------------------------------------------------------------

test("google: 429 RESOURCE_EXHAUSTED is retryable and honors Retry-After", async () => {
  const sleep = recordingSleeper();
  const stub = stubFetch((_request, index) =>
    index === 0
      ? jsonResponse(
          {
            error: {
              code: 429,
              message: "Resource has been exhausted (e.g. check quota).",
              status: "RESOURCE_EXHAUSTED",
            },
          },
          429,
          { "Retry-After": "0.2" },
        )
      : jsonResponse({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }),
  );
  const provider = googleProvider(stub.fetchImpl, { retries: 1, sleeper: sleep.sleeper });
  assert.equal(await provider.chat([{ role: "user", content: "u" }]), "ok");
  assert.equal(stub.requests.length, 2);
  assert.ok(Math.abs(sleep.total() - 0.2) < 1e-9, `slept ${sleep.total()}s, not 0.2s`);
});

test("google: PERMISSION_DENIED is fatal with the provider message", async () => {
  const stub = stubFetch(() =>
    jsonResponse(
      {
        error: {
          code: 403,
          message: "API key not valid. Please pass a valid API key.",
          status: "PERMISSION_DENIED",
        },
      },
      403,
    ),
  );
  const provider = googleProvider(stub.fetchImpl);
  await assert.rejects(provider.chat([{ role: "user", content: "u" }]), (err: unknown) => {
    assert.ok(err instanceof ProviderHttpError);
    assert.equal(err.status, 403);
    assert.equal(err.retryable, false);
    assert.equal(err.reason, "provider-rejected");
    assert.match(err.message, /Google API error 403 \(PERMISSION_DENIED\)/);
    assert.match(err.message, /API key not valid/);
    return true;
  });
  assert.equal(stub.requests.length, 1);
});

test("google: UNAVAILABLE (503) is retryable", async () => {
  const stub = stubFetch((_request, index) =>
    index === 0
      ? jsonResponse(
          { error: { code: 503, message: "The model is overloaded.", status: "UNAVAILABLE" } },
          503,
        )
      : jsonResponse({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }),
  );
  const provider = googleProvider(stub.fetchImpl, { retries: 1, sleeper: recordingSleeper().sleeper });
  assert.equal(await provider.chat([{ role: "user", content: "u" }]), "ok");
  assert.equal(stub.requests.length, 2);
});

test("google: token-count overflow is ProviderContextOverflowError", async () => {
  const stub = stubFetch(() =>
    jsonResponse(
      {
        error: {
          code: 400,
          message:
            "The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).",
          status: "INVALID_ARGUMENT",
        },
      },
      400,
    ),
  );
  const provider = googleProvider(stub.fetchImpl);
  await assert.rejects(provider.chat([{ role: "user", content: "u" }]), (err: unknown) => {
    assert.ok(err instanceof ProviderContextOverflowError);
    assert.equal(err.reason, "context-overflow");
    assert.match(err.message, /exceeds the maximum number of tokens/);
    return true;
  });
  assert.equal(stub.requests.length, 1);
});

test("google: a MAX_TOKENS error body is treated as context overflow", async () => {
  const stub = stubFetch(() =>
    jsonResponse(
      {
        error: {
          code: 400,
          message: "Request failed.",
          status: "INVALID_ARGUMENT",
          details: [{ reason: "MAX_TOKENS" }],
        },
      },
      400,
    ),
  );
  const provider = googleProvider(stub.fetchImpl);
  await assert.rejects(
    provider.chat([{ role: "user", content: "u" }]),
    ProviderContextOverflowError,
  );
});

// ---------------------------------------------------------------------------
// buildProvider dispatch
// ---------------------------------------------------------------------------

function providerConfig(overrides: Record<string, unknown> = {}) {
  return resolveConfig({
    provider: "openai",
    baseUrl: "http://stub.example",
    seniorModel: "senior-model",
    juniorModel: "junior-model",
    ...overrides,
  });
}

test("buildProvider dispatches on kind and keeps the OpenAI path the default", () => {
  assert.ok(
    buildProvider(providerConfig(), "senior") instanceof OpenAICompatibleProvider,
  );
  assert.ok(
    buildProvider(providerConfig({ kind: "anthropic" }), "senior") instanceof AnthropicProvider,
  );
  assert.ok(
    buildProvider(providerConfig({ kind: "google" }), "junior") instanceof GoogleProvider,
  );

  const senior = buildProvider(providerConfig({ seniorKind: "anthropic" }), "senior");
  const junior = buildProvider(providerConfig({ seniorKind: "anthropic" }), "junior");
  assert.ok(senior instanceof AnthropicProvider);
  assert.ok(junior instanceof OpenAICompatibleProvider);

  const perRole = buildProvider(
    providerConfig({ kind: "openai-compatible", seniorKind: "google", juniorKind: "anthropic" }),
    "junior",
  );
  assert.ok(perRole instanceof AnthropicProvider);
});

test("buildProvider picks each role's model for the adapter", () => {
  const cfg = providerConfig({ kind: "anthropic", seniorModel: "claude-senior" });
  const senior = buildProvider(cfg, "senior") as AnthropicProvider;
  assert.equal(senior.model, "claude-senior");
  const viaOverride = buildProvider(
    { ...cfg, model: "explicit-model" },
    "junior",
  ) as AnthropicProvider;
  assert.equal(viaOverride.model, "explicit-model");
});

test("buildProvider rejects an unknown kind with a clear error", () => {
  // bypass resolveConfig on purpose: the dispatch itself must fail fast too
  const raw = {
    provider: "openai",
    kind: "bedrock",
    baseUrl: "http://stub.example",
    apiKey: "",
    seniorModel: "m",
    juniorModel: "m",
    temperature: 0.2,
    timeout: 5,
  };
  assert.throws(
    () => buildProvider(raw, "senior"),
    /unknown provider kind: bedrock \(use openai-compatible\|anthropic\|google\)/,
  );
  assert.throws(
    () => buildProvider({ ...raw, kind: undefined, juniorKind: "gemini" }, "junior"),
    /unknown provider kind: gemini/,
  );
});

test("resolveProviderKind precedence and defaults", () => {
  assert.equal(resolveProviderKind({}, "senior"), DEFAULT_PROVIDER_KIND);
  assert.equal(resolveProviderKind({ kind: "google" }, "senior"), "google");
  assert.equal(
    resolveProviderKind({ kind: "google", seniorKind: "anthropic" }, "senior"),
    "anthropic",
  );
  assert.equal(
    resolveProviderKind({ kind: "google", seniorKind: "anthropic" }, "junior"),
    "google",
  );
});

test("resolveConfig accepts per-role kinds and rejects unknown ones", () => {
  const cfg = resolveConfig({ seniorKind: "anthropic", juniorKind: "google" });
  assert.equal(cfg.seniorKind, "anthropic");
  assert.equal(cfg.juniorKind, "google");
  assert.equal(cfg.kind, DEFAULT_PROVIDER_KIND);
  assert.throws(
    () => resolveConfig({ seniorKind: "claude" }),
    /invalid senior provider kind: claude \(use openai-compatible\|anthropic\|google\)/,
  );
});

test("CLI/env kind flags resolve into the config", async () => {
  const saved = {
    TWO_BROTHERS_SENIOR_KIND: process.env.TWO_BROTHERS_SENIOR_KIND,
    TWO_BROTHERS_JUNIOR_KIND: process.env.TWO_BROTHERS_JUNIOR_KIND,
    TWO_BROTHERS_PROVIDER_KIND: process.env.TWO_BROTHERS_PROVIDER_KIND,
  };
  process.env.TWO_BROTHERS_SENIOR_KIND = "anthropic";
  process.env.TWO_BROTHERS_JUNIOR_KIND = "google";
  process.env.TWO_BROTHERS_PROVIDER_KIND = "google";
  try {
    const cfg = resolveConfig({});
    assert.equal(cfg.seniorKind, "anthropic");
    assert.equal(cfg.juniorKind, "google");
    assert.equal(cfg.kind, "google");
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

// ---------------------------------------------------------------------------
// OpenAI-compatible byte-stability
// ---------------------------------------------------------------------------

test("openai-compatible: request shape is unchanged by the adapter refactor", async () => {
  const stub = stubFetch(() =>
    jsonResponse({ choices: [{ message: { content: "ok" } }], usage: {} }),
  );
  const provider = new OpenAICompatibleProvider({ ...BASE, model: "openai-model", fetchImpl: stub.fetchImpl });
  await provider.chatWithTools(MESSAGES, TOOLS);

  const request = stub.requests[0];
  assert.equal(request.url, "http://stub.example/chat/completions");
  assert.equal(request.headers.authorization, "Bearer secret-key");
  assert.equal(request.headers["x-api-key"], undefined);
  assert.deepEqual(request.body, {
    model: "openai-model",
    temperature: 0.2,
    messages: [
      { role: "system", content: "SYS" },
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "lookup", arguments: '{"q":"x"}' } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "result text" },
      { role: "tool", tool_call_id: "call_1", content: "result two" },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "lookup",
          description: "Look something up",
          parameters: TOOLS[0].parameters,
        },
      },
    ],
  });
});

// ---------------------------------------------------------------------------
// OpenAI-compatible chat() null-content parity + bounded shape errors
// ---------------------------------------------------------------------------

test("openai-compatible: plain chat tolerates spec-valid content:null like chatWithTools", async () => {
  const stub = stubFetch((_request, index) =>
    index === 0
      ? jsonResponse({
          choices: [{ index: 0, message: { role: "assistant", content: null }, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 0 },
        })
      : jsonResponse({ choices: [{ message: { content: "normal answer" } }], usage: {} }),
  );
  const provider = new OpenAICompatibleProvider({
    ...BASE,
    model: "openai-model",
    fetchImpl: stub.fetchImpl,
  });
  // content:null (a refusal or tool-only reply) is empty content, not an error.
  assert.equal(await provider.chat([{ role: "user", content: "u" }]), "");
  // Usage is still recorded exactly as before.
  assert.deepEqual(provider.usageSnapshot(), {
    model_calls: 1,
    input_tokens: 3,
    output_tokens: 0,
    cached_tokens: 0,
    cache_write_tokens: 0,
  });
  // chatWithTools on the same body agrees, and a normal string is unchanged.
  assert.equal(
    (
      await provider.chatWithTools([{ role: "user", content: "u" }], [])
    ).content,
    "normal answer",
  );
  assert.equal(await provider.chat([{ role: "user", content: "u" }]), "normal answer");
});

test("openai-compatible: a malformed chat body is still a shape error, without the whole body", async () => {
  const huge = { choices: [], usage: {}, flooded: "x".repeat(5000) };
  const stub = stubFetch(() => jsonResponse(huge));
  const provider = new OpenAICompatibleProvider({
    ...BASE,
    model: "openai-model",
    fetchImpl: stub.fetchImpl,
  });
  await assert.rejects(provider.chat([{ role: "user", content: "u" }]), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, /unexpected response shape from .*\/chat\/completions/);
    assert.ok(!err.message.includes("flooded"), "the error must not dump the response body");
    assert.ok(err.message.length < 200, `shape error must stay bounded, got ${err.message.length}`);
    return true;
  });
});

// ---------------------------------------------------------------------------
// cooperation loop with the adapters (hermetic)
// ---------------------------------------------------------------------------

/** Every payload kind's required fields; `sanitizePayload` picks per node. */
const UNIVERSAL_PAYLOAD = {
  task: "t",
  ask: "a",
  expect: "proposal",
  title: "T",
  answer: "A",
  rationale: "R",
  risks: [],
  confidence: 0.7,
  asks: [],
  work: "W",
  acceptance: ["x"],
  return: "deliverable",
  notes: "",
  result: "D",
  artifacts: [],
  verdict: "accept",
  points: [],
  decision: "DEC",
  dissent: null,
  accepted_proposals: [],
};

test("adapters drive the cooperation loop end-to-end (Google senior, Anthropic junior)", async () => {
  const urls: string[] = [];
  const text = JSON.stringify(UNIVERSAL_PAYLOAD);
  const anthropicFetch: FetchLike = async (url) => {
    urls.push(url);
    return jsonResponse({
      content: [{ type: "text", text }],
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3 },
    });
  };
  const googleFetch: FetchLike = async (url) => {
    urls.push(url);
    return jsonResponse({
      candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 12, cachedContentTokenCount: 2, candidatesTokenCount: 4 },
    });
  };
  const cfg = providerConfig({ baseUrl: "http://stub.example" });
  const harness = new TwoBrothersHarness(cfg, {
    senior: new GoogleProvider({ ...BASE, model: "gemini-test", fetchImpl: googleFetch }),
    junior: new AnthropicProvider({ ...BASE, model: "claude-test", fetchImpl: anthropicFetch }),
  });
  const result = await harness.run("cooperate");

  assert.deepEqual(result.errors, []);
  assert.equal(result.decision?.decision, "DEC");
  assert.equal(result.usage?.model_calls, 4);
  // Cached prompt tokens from both families reach the run total: 3 Google calls
  // × 2 cached + 1 Anthropic call × 3 cached (the Anthropic adapter's
  // cache_read_input_tokens mapping). The run usage is what `--json`/the web
  // footer report, so this pins the honest end-to-end accounting.
  assert.equal(result.usage?.cached_tokens, 9);
  assert.ok(urls.some((url) => url.includes("/v1beta/models/gemini-test:generateContent")));
  assert.ok(urls.some((url) => url.endsWith("/v1/messages")));
});

test("OpenCode identity headers reach the Anthropic and Google adapters", async () => {
  const anthropic = stubFetch(() => jsonResponse({ content: [], usage: {} }));
  await anthropicProvider(anthropic.fetchImpl, {
    baseUrl: "https://opencode.ai/inference/go/anthropic",
    sessionId: "conv-anthropic",
  }).chat([{ role: "user", content: "hi" }]);
  assert.equal(anthropic.requests[0]?.headers["x-opencode-session"], "conv-anthropic");
  assert.equal(anthropic.requests[0]?.headers["x-opencode-client"], "two-brothers");
  assert.equal(anthropic.requests[0]?.headers["user-agent"], "two-brothers-harness");

  const google = stubFetch(() =>
    jsonResponse({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }),
  );
  await googleProvider(google.fetchImpl, {
    baseUrl: "https://opencode.ai/inference/go/google",
    sessionId: "conv-google",
  }).chat([{ role: "user", content: "hi" }]);
  assert.equal(google.requests[0]?.headers["x-opencode-session"], "conv-google");
});

test("Anthropic maps a model effort level to its thinking budget", async () => {
  const stub = stubFetch(() => jsonResponse({ content: [], usage: {} }));
  await anthropicProvider(stub.fetchImpl, { effort: "high" }).chat([
    { role: "user", content: "hi" },
  ]);
  assert.deepEqual(stub.requests[0]?.body.thinking, {
    type: "enabled",
    budget_tokens: 16384,
  });
});

test("an explicit thinking budget wins over a model effort", async () => {
  const stub = stubFetch(() => jsonResponse({ content: [], usage: {} }));
  await anthropicProvider(stub.fetchImpl, {
    effort: "high",
    thinkingBudgetTokens: 2048,
  }).chat([{ role: "user", content: "hi" }]);
  assert.equal(stub.requests[0]?.body.thinking.budget_tokens, 2048);
});

test("Google maps a model effort level to thinkingConfig.thinkingBudget", async () => {
  const stub = stubFetch(() =>
    jsonResponse({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }),
  );
  await googleProvider(stub.fetchImpl, { effort: "medium" }).chat([
    { role: "user", content: "hi" },
  ]);
  assert.deepEqual(stub.requests[0]?.body.generationConfig.thinkingConfig, {
    thinkingBudget: 4096,
  });
});

test("CLI: kind flags parse (mock run stays offline)", async () => {
  const out: string[] = [];
  const code = await main(
    [
      "run",
      "kind flags",
      "--provider",
      "mock",
      "--provider-kind",
      "google",
      "--senior-kind",
      "anthropic",
      "--junior-kind",
      "google",
    ],
    { log: (line) => out.push(line), error: () => {} },
  );
  assert.equal(code, 0);
  assert.match(out.join("\n"), /decision/);
});

// ---------------------------------------------------------------------------
// transport bounds: stream byte cap, error-body cap, clipped detail
// ---------------------------------------------------------------------------

test("streaming: a stream past MAX_STREAM_BYTES fails as a retryable transport error", async () => {
  const stub = stubFetch(() =>
    chunkedResponse([MAX_STREAM_BYTES + 1], "text/event-stream"),
  );
  const provider = new OpenAICompatibleProvider({
    ...BASE,
    fetchImpl: stub.fetchImpl,
    retries: 0,
  });
  const err = await rejectionOf(
    provider.chat([{ role: "user", content: "u" }], "message", undefined, {
      onDelta: () => undefined,
    }),
  );
  assert.match(
    err.message,
    new RegExp(`failed: stream from \\S+ exceeded the ${MAX_STREAM_BYTES}-byte cap`),
  );
  const classification = classifyProviderError(err);
  assert.equal(classification.retryable, true, "over-cap is a retryable transport failure");
  assert.equal(classification.reason, "transport");
  assert.equal(stub.requests.length, 1, "retries: 0 means a single attempt");
});

test("streaming: an over-cap stream is retried and a healthy stream completes", async () => {
  const sleep = recordingSleeper();
  const stub = stubFetch((_request, index) =>
    index === 0
      ? chunkedResponse([MAX_STREAM_BYTES + 1], "text/event-stream")
      : openAiTextSse("ok"),
  );
  const provider = new OpenAICompatibleProvider({
    ...BASE,
    fetchImpl: stub.fetchImpl,
    retries: 1,
    sleeper: sleep.sleeper,
    rng: () => 0,
  });
  const reply = await provider.chat([{ role: "user", content: "u" }], "message", undefined, {
    onDelta: () => undefined,
  });
  assert.equal(reply, "ok");
  assert.equal(stub.requests.length, 2, "the over-cap attempt was retried");
});

test("error body: a non-OK body read is capped and still classifies", async () => {
  const tailNeedle = "TAIL-OF-THE-ERROR-BODY";
  // First chunk is kept; the second pushes the read past the cap.
  const stub = stubFetch(() =>
    chunkedResponse([2048, MAX_ERROR_BODY_BYTES], "application/json", 429),
  );
  const provider = new OpenAICompatibleProvider({ ...BASE, fetchImpl: stub.fetchImpl });
  const err = await rejectionOf(provider.chat([{ role: "user", content: "u" }]));
  assert.equal(err instanceof ProviderHttpError, true);
  const httpErr = err as ProviderHttpError;
  assert.equal(httpErr.status, 429);
  assert.equal(httpErr.retryable, true, "classification survives the capped read");
  assert.equal(httpErr.reason, "rate-limit");
  assert.match(
    httpErr.message,
    /^HTTP 429 from \S+: a{100}[\s\S]*<clipped \d+ chars>$/s,
    "the kept prefix classifies and the message stays clipped",
  );
  assert.ok(
    httpErr.message.length <= MAX_ERROR_DETAIL_CHARS + 80,
    `the thrown message stays clipped, got ${httpErr.message.length} chars`,
  );
  assert.equal(
    httpErr.message.includes(tailNeedle),
    false,
    "the unread tail never rides the message",
  );
});

test("error detail: the embedded provider detail is clipped with classification intact", async () => {
  const huge =
    "rate-limited: ".repeat(Math.ceil(MAX_ERROR_DETAIL_CHARS / 14) + 400) +
    "UNIQUE-TAIL-NEEDLE-THAT-MUST-NOT-RIDE-THE-MESSAGE";
  const stub = stubFetch(() =>
    jsonResponse(
      { type: "error", error: { type: "rate_limit_error", message: huge } },
      429,
    ),
  );
  const provider = anthropicProvider(stub.fetchImpl);
  const err = await rejectionOf(provider.chat([{ role: "user", content: "u" }]));
  assert.equal(err instanceof ProviderHttpError, true);
  const httpErr = err as ProviderHttpError;
  assert.equal(httpErr.retryable, true);
  assert.equal(httpErr.reason, "provider-transient", "the parsed error type still classifies");
  assert.match(httpErr.message, /Anthropic API error 429 \(rate_limit_error\):/);
  assert.match(err.message, /<clipped \d+ chars>/);
  assert.ok(
    err.message.length <= MAX_ERROR_DETAIL_CHARS + 60,
    `the message stays a few KB, got ${err.message.length} chars`,
  );
  assert.equal(
    err.message.includes(huge.slice(-40)),
    false,
    "the clipped tail never rides the message",
  );
});

test("anthropic: a mid-stream api_error event is retryable (registry wording)", async () => {
  const sleep = recordingSleeper();
  const stub = stubFetch((_request, index) =>
    index === 0
      ? sseResponse([
          sseFrame("error", {
            type: "error",
            error: { type: "api_error", message: "Internal server error" },
          }),
        ])
      : jsonResponse({ content: [{ type: "text", text: "ok" }], usage: {} }),
  );
  const provider = anthropicProvider(stub.fetchImpl, { retries: 1, sleeper: sleep.sleeper });
  const reply = await provider.chat([{ role: "user", content: "u" }], "message", undefined, {
    onDelta: () => undefined,
  });
  assert.equal(reply, "ok");
  assert.equal(stub.requests.length, 2, "the api_error stream was retried, not failed fast");
});

test("anthropic: a mid-stream overloaded_error event stays retryable", async () => {
  const stub = stubFetch(() =>
    sseResponse([
      sseFrame("error", {
        type: "error",
        error: { type: "overloaded_error", message: "Overloaded" },
      }),
    ]),
  );
  const provider = anthropicProvider(stub.fetchImpl, { retries: 0 });
  const err = await rejectionOf(
    provider.chat([{ role: "user", content: "u" }], "message", undefined, {
      onDelta: () => undefined,
    }),
  );
  assert.match(err.message, /Anthropic API error \(overloaded_error\): Overloaded/);
  assert.equal(classifyProviderError(err).retryable, true);
});
