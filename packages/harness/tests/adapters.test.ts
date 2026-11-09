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
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_PROVIDER_KIND,
  GoogleProvider,
  OpenAICompatibleProvider,
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

test("google: a response without candidates is a shape error", async () => {
  const stub = stubFetch(() => jsonResponse({ promptFeedback: { blockReason: "SAFETY" } }));
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