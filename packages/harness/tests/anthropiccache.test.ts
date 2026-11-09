/**
 * Anthropic prompt caching (wave 23): explicit `cache_control` breakpoints on
 * the Anthropic wire body + honest cache accounting.
 *
 * Every Anthropic request now carries up to three `{type: "ephemeral"}`
 * breakpoints — the merged system prompt block, the last tool definition and
 * the last content block of the newest user turn — so the 2nd..Nth provider
 * call of a cooperation cycle can read the shared prefix from Anthropic's
 * prompt cache instead of resending it as fresh input. This suite pins:
 *
 * - the exact marker placement (only the last system block, the last tool and
 *   the newest-turn block are marked; earlier turns, assistant turns and
 *   earlier tool definitions are untouched) and the three-breakpoint budget
 *   (under the API's four-per-request cap);
 * - tool-loop requests re-mark the NEWEST turn on every call (the tool_result
 *   turn carries the marker, not the earlier task turn);
 * - streaming requests carry the identical markers (`requestBody` is shared by
 *   both wire paths);
 * - `cache_read_input_tokens` flows into the `UsageTracker`/run usage as
 *   `cached_tokens` and `cache_creation_input_tokens` as `cache_write_tokens`
 *   (a write is never a hit), and an absent server-side cache report stays 0
 *   (never fabricated);
 * - the usage display shows the cached portion only when a hit was reported;
 * - OpenAI-compatible and Google request bodies stay byte-identical and never
 *   see `cache_control` (the feature is Anthropic-wire-only).
 *
 * Hermetic: every request goes to a scripted `FetchLike`; no endpoint, clock
 * or filesystem. Run with: node --test tests/anthropiccache.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { ChatMessage } from "../src/context.ts";
import { humanFooter } from "../src/clilayout.ts";
import {
  AnthropicProvider,
  emptyUsage,
  GoogleProvider,
  mergeUsage,
  OpenAICompatibleProvider,
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** One Anthropic SSE frame (`event:` + one `data:` JSON line). */
function sseFrame(event: string, payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

/** A complete scripted Anthropic SSE body (text reply + usage). */
function anthropicTextSse(
  text: string,
  usage: Record<string, unknown> = {},
  outputTokens = 7,
): Response {
  const encoder = new TextEncoder();
  const frames = [
    sseFrame("message_start", {
      type: "message_start",
      message: { usage: { input_tokens: 50, output_tokens: 0, ...usage } },
    }),
    sseFrame("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
    sseFrame("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    }),
    sseFrame("content_block_stop", { type: "content_block_stop", index: 0 }),
    sseFrame("message_delta", {
      type: "message_delta",
      usage: { output_tokens: outputTokens },
    }),
    sseFrame("message_stop", { type: "message_stop" }),
  ];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

const CACHE = { type: "ephemeral" } as const;

/** Recursively count `cache_control` keys in a request body. */
function cacheMarkerCount(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((sum: number, item) => sum + cacheMarkerCount(item), 0);
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).reduce(
      (sum, [key, child]) => sum + (key === "cache_control" ? 1 : 0) + cacheMarkerCount(child),
      0,
    );
  }
  return 0;
}

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

const TOOLS: Tool[] = [
  {
    name: "lookup",
    description: "Look something up",
    parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
    execute: () => "unused",
  },
  {
    name: "notes",
    description: "Read notes",
    parameters: { type: "object", properties: {}, required: [] },
    execute: () => "unused",
  },
];

/** System prompt + the task turn: the plain-transcript shape. */
const PLAIN_MESSAGES: ChatMessage[] = [
  { role: "system", content: "SYS" },
  { role: "user", content: "hello" },
];

/** The same transcript grown by an assistant tool_use turn and its tool result. */
const TOOL_LOOP_MESSAGES: ChatMessage[] = [
  ...PLAIN_MESSAGES,
  {
    role: "assistant",
    content: "",
    toolCalls: [{ id: "call_1", name: "lookup", args: { q: "x" } }],
  },
  { role: "tool", content: "result text", toolCallId: "call_1" },
];

const MARKED_SYSTEM = [{ type: "text", text: "SYS", cache_control: CACHE }];

/** The two tool definitions with the tools breakpoint on the last one. */
const MARKED_TOOLS = [
  {
    name: "lookup",
    description: "Look something up",
    input_schema: TOOLS[0]!.parameters,
  },
  {
    name: "notes",
    description: "Read notes",
    input_schema: TOOLS[1]!.parameters,
    cache_control: CACHE,
  },
];

// ---------------------------------------------------------------------------
// marker placement
// ---------------------------------------------------------------------------

test("anthropic: the request marks the system block, the last tool and the newest turn", async () => {
  const stub = stubFetch(() =>
    jsonResponse({ content: [{ type: "text", text: "ok" }], usage: {} }),
  );
  const provider = anthropicProvider(stub.fetchImpl);
  const messagesBefore = JSON.stringify(TOOL_LOOP_MESSAGES);
  const toolsBefore = JSON.stringify(TOOLS);
  await provider.chatWithTools(TOOL_LOOP_MESSAGES, TOOLS);

  const body = stub.requests[0]!.body;
  // The merged system prompt is one cached text block (never a message).
  assert.deepEqual(body.system, MARKED_SYSTEM);
  // Only the LAST tool definition is marked; the earlier one is untouched.
  assert.deepEqual(body.tools, MARKED_TOOLS);
  assert.equal("cache_control" in body.tools[0], false);
  // The newest turn is the tool_result turn: its last block carries the marker.
  assert.deepEqual(body.messages, [
    { role: "user", content: [{ type: "text", text: "hello" }] },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "call_1", name: "lookup", input: { q: "x" } }],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call_1",
          content: "result text",
          cache_control: CACHE,
        },
      ],
    },
  ]);
  // Only the intended blocks are marked: earlier user text and the assistant
  // turn stay clean.
  assert.equal("cache_control" in body.messages[0].content[0], false);
  assert.equal(
    (body.messages[1].content as Array<Record<string, unknown>>).some(
      (block) => "cache_control" in block,
    ),
    false,
  );
  // Three breakpoints — the API cap is four per request.
  assert.equal(cacheMarkerCount(body), 3);
  // Marking is wire-only: the adapter never mutates the caller's messages/tools.
  assert.equal(JSON.stringify(TOOL_LOOP_MESSAGES), messagesBefore);
  assert.equal(JSON.stringify(TOOLS), toolsBefore);
});

test("anthropic: a plain chat marks the system block and the single task turn", async () => {
  const stub = stubFetch(() =>
    jsonResponse({ content: [{ type: "text", text: "ok" }], usage: {} }),
  );
  const provider = anthropicProvider(stub.fetchImpl);
  await provider.chat(PLAIN_MESSAGES);

  const body = stub.requests[0]!.body;
  assert.deepEqual(body.system, MARKED_SYSTEM);
  assert.deepEqual(body.messages, [
    { role: "user", content: [{ type: "text", text: "hello", cache_control: CACHE }] },
  ]);
  assert.equal("tools" in body, false);
  assert.equal(cacheMarkerCount(body), 2);
});

test("anthropic: no empty system block is sent when the system prompt is absent", async () => {
  const stub = stubFetch(() =>
    jsonResponse({ content: [{ type: "text", text: "ok" }], usage: {} }),
  );
  const provider = anthropicProvider(stub.fetchImpl);
  await provider.chat([
    { role: "system", content: "" },
    { role: "user", content: "u" },
  ]);

  const body = stub.requests[0]!.body;
  // Never an empty text block: the field is simply absent.
  assert.equal("system" in body, false);
  assert.deepEqual(body.messages, [
    { role: "user", content: [{ type: "text", text: "u", cache_control: CACHE }] },
  ]);
  assert.equal(cacheMarkerCount(body), 1);
});

test("anthropic: a tool-loop request re-marks the newest turn on every call", async () => {
  const stub = stubFetch(() =>
    jsonResponse({ content: [{ type: "text", text: "ok" }], usage: {} }),
  );
  const provider = anthropicProvider(stub.fetchImpl);
  // Call 1: the first task turn carries the conversation breakpoint.
  await provider.chatWithTools(PLAIN_MESSAGES, TOOLS);
  // Call 2: the transcript now ends with the tool_result turn; the marker must
  // move forward with the newest turn so the prefix grows monotonically.
  await provider.chatWithTools(TOOL_LOOP_MESSAGES, TOOLS);

  const first = stub.requests[0]!.body;
  const second = stub.requests[1]!.body;
  assert.deepEqual(first.messages, [
    { role: "user", content: [{ type: "text", text: "hello", cache_control: CACHE }] },
  ]);
  assert.deepEqual(second.messages, [
    { role: "user", content: [{ type: "text", text: "hello" }] },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "call_1", name: "lookup", input: { q: "x" } }],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call_1",
          content: "result text",
          cache_control: CACHE,
        },
      ],
    },
  ]);
  // The marker set is stable: system + last tool + newest turn on both calls,
  // always under the four-breakpoint cap.
  for (const body of [first, second]) {
    assert.deepEqual(body.system, MARKED_SYSTEM);
    assert.deepEqual(body.tools, MARKED_TOOLS);
    assert.equal(cacheMarkerCount(body), 3);
  }
});

// ---------------------------------------------------------------------------
// streaming: the same breakpoints, plus streamed cache accounting
// ---------------------------------------------------------------------------

test("anthropic: streaming requests carry the same breakpoints and read cache usage", async () => {
  const stub = stubFetch(() => anthropicTextSse("ok", { cache_read_input_tokens: 25 }));
  const provider = anthropicProvider(stub.fetchImpl);
  const deltas: string[] = [];
  const response = await provider.chatWithTools(TOOL_LOOP_MESSAGES, TOOLS, {
    onDelta: (delta) => deltas.push(delta),
  });

  assert.equal(response.content, "ok");
  assert.equal(deltas.join(""), "ok");

  const body = stub.requests[0]!.body;
  assert.equal(body.stream, true);
  assert.deepEqual(body.system, MARKED_SYSTEM);
  assert.deepEqual(body.tools, MARKED_TOOLS);
  assert.deepEqual(body.messages, [
    { role: "user", content: [{ type: "text", text: "hello" }] },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "call_1", name: "lookup", input: { q: "x" } }],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call_1",
          content: "result text",
          cache_control: CACHE,
        },
      ],
    },
  ]);
  assert.equal(cacheMarkerCount(body), 3);
  // message_start's cache_read_input_tokens reaches the same counters the
  // non-streaming path fills.
  assert.deepEqual(provider.usageSnapshot(), {
    model_calls: 1,
    input_tokens: 50,
    output_tokens: 7,
    cached_tokens: 25,
    cache_write_tokens: 0,
    prompt_tokens: 75,
  });
});

// ---------------------------------------------------------------------------
// honest cache accounting
// ---------------------------------------------------------------------------

test("anthropic: cache reads map to cached_tokens and cache writes to cache_write_tokens", async () => {
  const stub = stubFetch((_request, index) => {
    const usage = [
      // First call: a cache read (40) plus a cache write (10).
      { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 40, cache_creation_input_tokens: 10 },
      // Second call: no cache report at all.
      { input_tokens: 11, output_tokens: 2 },
      // Third call: a cache write only — a write is not a hit.
      { input_tokens: 5, output_tokens: 1, cache_creation_input_tokens: 100 },
    ][index]!;
    return jsonResponse({ content: [{ type: "text", text: "ok" }], usage });
  });
  const provider = anthropicProvider(stub.fetchImpl);

  await provider.chat(PLAIN_MESSAGES);
  assert.deepEqual(provider.usageSnapshot(), {
    model_calls: 1,
    input_tokens: 120,
    output_tokens: 30,
    cached_tokens: 40,
    cache_write_tokens: 10,
    prompt_tokens: 170,
  });

  await provider.chat(PLAIN_MESSAGES);
  // No fabricated cache hit: the counter keeps the reported 40, and the write
  // counter keeps the 10 written by the first call.
  assert.deepEqual(provider.usageSnapshot(), {
    model_calls: 2,
    input_tokens: 131,
    output_tokens: 32,
    cached_tokens: 40,
    cache_write_tokens: 10,
    prompt_tokens: 181,
  });

  await provider.chat(PLAIN_MESSAGES);
  // Cache creation (a cache WRITE) is mapped to `cache_write_tokens`: the
  // +100 written by this call joins the 10 from the first, so the run reports
  // 110 written prompt tokens. A write is never a hit, so `cached_tokens`
  // stays 40.
  assert.deepEqual(provider.usageSnapshot(), {
    model_calls: 3,
    input_tokens: 136,
    output_tokens: 33,
    cached_tokens: 40,
    cache_write_tokens: 110,
    prompt_tokens: 286,
  });
});

test("usage: the run aggregate keeps the cached portion and display shows it only when reported", () => {
  assert.deepEqual(emptyUsage(), {
    model_calls: 0,
    input_tokens: 0,
    output_tokens: 0,
    cached_tokens: 0,
    cache_write_tokens: 0,
  });
  // The run total is the merge of the roles' snapshots (the real run path).
  const merged = mergeUsage(
    { model_calls: 1, input_tokens: 120, output_tokens: 30, cached_tokens: 40 },
    { model_calls: 1, input_tokens: 10, output_tokens: 5 },
  );
  assert.deepEqual(merged, {
    model_calls: 2,
    input_tokens: 130,
    output_tokens: 35,
    cached_tokens: 40,
    cache_write_tokens: 0,
  });

  const withCache = humanFooter(merged, null);
  assert.ok(withCache, "a run with usage renders a footer");
  // OpenAI-compatible records omit prompt_tokens (input is already the total);
  // the fallback keeps the historical cached/input convention.
  assert.ok(withCache.includes("cache 31%"), `footer must show the cached hit: ${withCache}`);

  // Anthropic/Gemini carry the normalized prompt total: cached / prompt, not
  // cached / uncached-input (which would inflate 42% into 80%).
  const anthropic = humanFooter(
    {
      model_calls: 1,
      input_tokens: 4_000,
      prompt_tokens: 7_600,
      output_tokens: 100,
      cached_tokens: 3_200,
      cache_write_tokens: 400,
    },
    null,
  );
  assert.ok(anthropic?.includes("cache 42%"), `normalized prompt denominator: ${anthropic}`);
  assert.ok(anthropic?.includes("tokens 7600 in"), `prompt total is the in count: ${anthropic}`);
  assert.ok(anthropic?.includes("write 400"), `cache writes are visible: ${anthropic}`);

  const withoutCache = humanFooter(
    { model_calls: 1, input_tokens: 100, output_tokens: 10, cached_tokens: 0 },
    null,
  );
  assert.ok(withoutCache);
  assert.equal(
    withoutCache.includes("cache"),
    false,
    `no cache segment without a reported hit: ${withoutCache}`,
  );
  // A provider that reports nothing at all still renders no footer (never a
  // fabricated zero-usage line).
  assert.equal(humanFooter(emptyUsage(), null), null);
});

// ---------------------------------------------------------------------------
// other wire families stay byte-identical
// ---------------------------------------------------------------------------

/** The shared fixture the OpenAI/Google byte-identity checks reuse. */
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

test("openai-compatible: the request body is untouched and carries no cache_control", async () => {
  const stub = stubFetch(() =>
    jsonResponse({ choices: [{ message: { content: "ok" } }], usage: {} }),
  );
  const provider = new OpenAICompatibleProvider({
    ...BASE,
    model: "openai-model",
    fetchImpl: stub.fetchImpl,
  });
  await provider.chatWithTools(MESSAGES, [TOOLS[0]!]);

  const body = stub.requests[0]!.body;
  assert.deepEqual(body, {
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
          parameters: TOOLS[0]!.parameters,
        },
      },
    ],
  });
  assert.equal(JSON.stringify(body).includes("cache_control"), false);
});

test("google: the request body is untouched and carries no cache_control", async () => {
  const stub = stubFetch(() =>
    jsonResponse({
      candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
      usageMetadata: {},
    }),
  );
  const provider = new GoogleProvider({
    ...BASE,
    model: "gemini-test",
    fetchImpl: stub.fetchImpl,
  });
  await provider.chatWithTools(MESSAGES, [TOOLS[0]!]);

  const body = stub.requests[0]!.body;
  assert.deepEqual(body, {
    contents: [
      { role: "user", parts: [{ text: "hello" }] },
      { role: "model", parts: [{ functionCall: { name: "lookup", args: { q: "x" } } }] },
      {
        role: "user",
        parts: [
          {
            functionResponse: {
              name: "lookup",
              response: { output: "result text" },
            },
          },
          {
            functionResponse: {
              name: "lookup",
              response: { output: "result two" },
            },
          },
        ],
      },
    ],
    systemInstruction: { parts: [{ text: "SYS" }] },
    generationConfig: { temperature: 0.2 },
    tools: [
      {
        functionDeclarations: [
          {
            name: "lookup",
            description: "Look something up",
            parameters: TOOLS[0]!.parameters,
          },
        ],
      },
    ],
  });
  assert.equal(JSON.stringify(body).includes("cache_control"), false);
});
