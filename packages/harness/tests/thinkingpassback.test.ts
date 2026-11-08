/**
 * Anthropic extended thinking: request shape + signed-thinking passback
 * (wave 10, backlog "Reasoning passback part 2").
 *
 * The Messages API requires an assistant turn's signed thinking blocks to be
 * echoed back verbatim when a tool loop continues after the model used extended
 * thinking. This suite pins the additive, hermetic contract:
 *
 * - the option is explicit (`ProviderConfig.thinkingBudgetTokens`, CLI
 *   `--thinking-budget`, env `TWO_BROTHERS_THINKING_BUDGET`) and UNSET keeps the
 *   Anthropic request byte-identical to the pre-thinking adapter (no `thinking`
 *   field, same `max_tokens`);
 * - enabled requests carry `thinking: {type: "enabled", budget_tokens: N}` and
 *   a valid `max_tokens` (raised to `budget + headroom` with one honest warning
 *   when the configured cap does not leave room);
 * - streaming capture parses `content_block_start` thinking blocks +
 *   `thinking_delta` + `signature_delta` (+ redacted blocks) into
 *   `ToolChatResponse.thinkingBlocks`; the harness carries them on the internal
 *   assistant `ChatMessage` and the next tool-loop request echoes the SAME
 *   text+signature verbatim before the `tool_use` block;
 * - non-Anthropic adapters ignore the option and stay byte-identical;
 * - validation: a budget below the API minimum is a clear usage error (CLI exit
 *   2, provider constructor rejection), never silently raised;
 * - no protocol envelope / session-JSONL change: reasoning text and signatures
 *   never enter the shared context.
 *
 * Everything is hermetic: adapter-level requests go to a scripted `FetchLike`;
 * the per-role endpoint/provider-wiring cases use a loopback (127.0.0.1) stub
 * server only. No external network, no real model.
 *
 * Run with: node --test tests/thinkingpassback.test.ts
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { createServer } from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { main } from "../src/cli.ts";
import { resolveConfig } from "../src/config.ts";
import { SharedContext, type ChatMessage } from "../src/context.ts";
import { TwoBrothersHarness } from "../src/harness.ts";
import {
  ANTHROPIC_MIN_THINKING_BUDGET,
  ANTHROPIC_THINKING_MAX_TOKENS_HEADROOM,
  AnthropicProvider,
  buildProvider,
  DEFAULT_MAX_OUTPUT_TOKENS,
  GoogleProvider,
  OpenAICompatibleProvider,
  type FetchLike,
  type ModelProviderConfig,
  type ProviderConfig,
  type Tool,
} from "../src/provider.ts";
import type { RuntimeEvent } from "../src/runevents.ts";
import { SessionStore } from "../src/session.ts";
import type { StreamEvent } from "../src/runstream.ts";

// ---------------------------------------------------------------------------
// helpers: scripted fetch + Anthropic SSE frames
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

/** One SSE frame block (`event:` + one `data:` JSON line). */
function sseFrame(event: string, payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

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

/** A streamed Anthropic reply whose only block is a signed thinking block. */
function thinkingOnlySse(text: string, signature: string, usage: object = {}): Response {
  return sseResponse([
    sseFrame("message_start", {
      type: "message_start",
      message: { usage: { input_tokens: 5, output_tokens: 0 } },
    }),
    sseFrame("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "" },
    }),
    sseFrame("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: text },
    }),
    sseFrame("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature },
    }),
    sseFrame("content_block_stop", { type: "content_block_stop", index: 0 }),
    sseFrame("message_delta", { type: "message_delta", usage: { output_tokens: 7, ...usage } }),
    sseFrame("message_stop", { type: "message_stop" }),
  ]);
}

/** A streamed Anthropic reply: thinking block first, then a `tool_use` block. */
function thinkingThenToolUseSse(input: {
  thinking: string;
  signature: string;
  callId: string;
  toolName: string;
  args: Record<string, unknown>;
}): Response {
  return sseResponse([
    sseFrame("message_start", {
      type: "message_start",
      message: { usage: { input_tokens: 11, output_tokens: 0 } },
    }),
    sseFrame("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "" },
    }),
    sseFrame("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: input.thinking },
    }),
    sseFrame("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature: input.signature },
    }),
    sseFrame("content_block_stop", { type: "content_block_stop", index: 0 }),
    sseFrame("content_block_start", {
      type: "content_block_start",
      index: 1,
      content_block: {
        type: "tool_use",
        id: input.callId,
        name: input.toolName,
        input: {},
      },
    }),
    sseFrame("content_block_delta", {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(input.args) },
    }),
    sseFrame("content_block_stop", { type: "content_block_stop", index: 1 }),
    sseFrame("message_delta", { type: "message_delta", usage: { output_tokens: 9 } }),
    sseFrame("message_stop", { type: "message_stop" }),
  ]);
}

/**
 * A streamed Anthropic reply whose first block is a `redacted_thinking` block
 * (opaque `data`, no deltas) followed by a call to `toolName`.
 */
function redactedThenToolUseSse(input: {
  redacted: string;
  callId: string;
  toolName: string;
  args: Record<string, unknown>;
}): Response {
  return sseResponse([
    sseFrame("message_start", {
      type: "message_start",
      message: { usage: { input_tokens: 17, output_tokens: 0 } },
    }),
    sseFrame("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "redacted_thinking", data: input.redacted },
    }),
    sseFrame("content_block_stop", { type: "content_block_stop", index: 0 }),
    sseFrame("content_block_start", {
      type: "content_block_start",
      index: 1,
      content_block: {
        type: "tool_use",
        id: input.callId,
        name: input.toolName,
        input: {},
      },
    }),
    sseFrame("content_block_delta", {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(input.args) },
    }),
    sseFrame("content_block_stop", { type: "content_block_stop", index: 1 }),
    sseFrame("message_delta", { type: "message_delta", usage: { output_tokens: 8 } }),
    sseFrame("message_stop", { type: "message_stop" }),
  ]);
}

/** A streamed Anthropic reply of plain text, split into two deltas. */
function textSse(text: string): Response {
  const middle = Math.max(1, Math.floor(text.length / 2));
  return sseResponse([
    sseFrame("message_start", {
      type: "message_start",
      message: { usage: { input_tokens: 13, output_tokens: 0 } },
    }),
    sseFrame("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
    sseFrame("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: text.slice(0, middle) },
    }),
    sseFrame("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: text.slice(middle) },
    }),
    sseFrame("content_block_stop", { type: "content_block_stop", index: 0 }),
    sseFrame("message_delta", { type: "message_delta", usage: { output_tokens: 21 } }),
    sseFrame("message_stop", { type: "message_stop" }),
  ]);
}

const MESSAGES: ChatMessage[] = [
  { role: "system", content: "SYS" },
  { role: "user", content: "hello" },
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
  model: "claude-test",
};

function anthropic(
  fetchImpl: FetchLike,
  overrides: Partial<ModelProviderConfig> = {},
): AnthropicProvider {
  return new AnthropicProvider({ ...BASE, fetchImpl, ...overrides });
}

/** Run `fn` with every TWO_BROTHERS_* env var cleared, then restore them. */
async function withCleanCliEnv<T>(fn: () => Promise<T>): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const key of Object.keys(process.env)) {
    if (!key.startsWith("TWO_BROTHERS_")) continue;
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function cliIO(): { out: string[]; err: string[]; log: (l: string) => void; error: (l: string) => void } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, log: (line) => out.push(line), error: (line) => err.push(line) };
}

// ---------------------------------------------------------------------------
// (a) disabled: the Anthropic request is byte-identical to today
// ---------------------------------------------------------------------------

test("thinking unset: the Anthropic request carries no thinking field (byte-identical)", async () => {
  const plain = stubFetch(() => jsonResponse({ content: [{ type: "text", text: "ok" }] }));
  const withUndefined = stubFetch(() =>
    jsonResponse({ content: [{ type: "text", text: "ok" }] }),
  );
  const plainProvider = anthropic(plain.fetchImpl);
  const undefinedProvider = anthropic(withUndefined.fetchImpl, { thinkingBudgetTokens: undefined });
  await plainProvider.chatWithTools(MESSAGES, TOOLS);
  await undefinedProvider.chatWithTools(MESSAGES, TOOLS);

  const body = plain.requests[0]!.body;
  assert.equal("thinking" in body, false, "default request has no thinking field");
  assert.equal(body.max_tokens, DEFAULT_MAX_OUTPUT_TOKENS);
  assert.equal(
    JSON.stringify(plain.requests[0]!.body),
    JSON.stringify(withUndefined.requests[0]!.body),
    "an explicitly undefined budget is the same request bytes",
  );
  // plain chat() without the option is the same: no thinking, no extra keys.
  await plainProvider.chat(MESSAGES);
  assert.equal("thinking" in plain.requests[1]!.body, false);
});

// ---------------------------------------------------------------------------
// (b) enabled: request shape + a valid max_tokens
// ---------------------------------------------------------------------------

test("thinking enabled: request adds thinking and keeps a valid max_tokens", async () => {
  const stub = stubFetch(() => jsonResponse({ content: [{ type: "text", text: "ok" }] }));
  const provider = anthropic(stub.fetchImpl, { thinkingBudgetTokens: 2048 });
  await provider.chatWithTools(MESSAGES, TOOLS);
  const body = stub.requests[0]!.body;
  assert.deepEqual(body.thinking, { type: "enabled", budget_tokens: 2048 });
  assert.equal(body.max_tokens, DEFAULT_MAX_OUTPUT_TOKENS);
  assert.ok(body.max_tokens > body.thinking.budget_tokens, "max_tokens exceeds the budget");
  assert.equal(
    "temperature" in body,
    false,
    "the Messages API rejects temperature while thinking is enabled (its default 1 applies)",
  );

  // Streaming tool call (a thinking sink) sends the same thinking field.
  const streaming = stubFetch(() => thinkingOnlySse("plan", "sig"));
  const streamingProvider = anthropic(streaming.fetchImpl, { thinkingBudgetTokens: 2048 });
  await streamingProvider.chatWithTools(MESSAGES, TOOLS, { onThinkingDelta: () => undefined });
  assert.deepEqual(streaming.requests[0]!.body.thinking, {
    type: "enabled",
    budget_tokens: 2048,
  });
});

test("thinking enabled: a too-small max_tokens is raised with one honest warning", async () => {
  const warnings: string[] = [];
  const stub = stubFetch(() => jsonResponse({ content: [{ type: "text", text: "ok" }] }));
  const provider = anthropic(stub.fetchImpl, {
    thinkingBudgetTokens: 3000,
    maxTokens: 2000,
    onWarning: (line) => warnings.push(line),
  });
  await provider.chatWithTools(MESSAGES, TOOLS);
  await provider.chatWithTools(MESSAGES, TOOLS);
  const expected = 3000 + ANTHROPIC_THINKING_MAX_TOKENS_HEADROOM;
  assert.equal(stub.requests[0]!.body.max_tokens, expected);
  assert.ok(
    (stub.requests[0]!.body.max_tokens as number) > 3000,
    "the request is valid per the Messages API",
  );
  assert.equal(stub.requests[1]!.body.max_tokens, expected);
  assert.equal(warnings.length, 1, "the raised cap is reported exactly once per provider");
  assert.match(warnings[0]!, /thinking budget 3000 needs max_tokens greater than it/);
  assert.match(warnings[0]!, new RegExp(`sending max_tokens ${expected}`));

  // A max_tokens that already leaves room is sent untouched (no warning).
  const roomy = stubFetch(() => jsonResponse({ content: [{ type: "text", text: "ok" }] }));
  const roomyWarnings: string[] = [];
  const roomyProvider = anthropic(roomy.fetchImpl, {
    thinkingBudgetTokens: 2048,
    maxTokens: 5000,
    onWarning: (line) => roomyWarnings.push(line),
  });
  await roomyProvider.chatWithTools(MESSAGES, TOOLS);
  assert.equal(roomy.requests[0]!.body.max_tokens, 5000);
  assert.deepEqual(roomyWarnings, []);
});

// ---------------------------------------------------------------------------
// (c) capture: streaming + non-streaming responses expose the signed blocks
// ---------------------------------------------------------------------------

test("streaming capture: thinking text + signature become thinkingBlocks (not reply text)", async () => {
  const stub = stubFetch(() =>
    thinkingThenToolUseSse({
      thinking: "Look the value up first.",
      signature: "sig-stream-1",
      callId: "call_1",
      toolName: "lookup",
      args: { q: "x" },
    }),
  );
  const provider = anthropic(stub.fetchImpl, { thinkingBudgetTokens: 2048 });
  const deltas: string[] = [];
  const response = await provider.chatWithTools(MESSAGES, TOOLS, {
    onThinkingDelta: (delta) => deltas.push(delta),
  });

  assert.deepEqual(response.thinkingBlocks, [
    { text: "Look the value up first.", signature: "sig-stream-1" },
  ]);
  assert.deepEqual(response.toolCalls, [{ id: "call_1", name: "lookup", args: { q: "x" } }]);
  assert.equal(response.content, "", "thinking never becomes reply content");
  assert.deepEqual(deltas, ["Look the value up first."], "the live thinking sink still streams");
  assert.equal(
    JSON.stringify(response).includes("sig-stream-1"),
    true,
    "the signature is replay metadata on the response (never reply text)",
  );
});

test("non-streaming response: thinking blocks with signatures are captured too", async () => {
  const stub = stubFetch(() =>
    jsonResponse({
      content: [
        { type: "thinking", thinking: "Reason it through.", signature: "sig-json-1" },
        { type: "text", text: "done" },
        { type: "tool_use", id: "call_9", name: "lookup", input: { q: "y" } },
      ],
    }),
  );
  const provider = anthropic(stub.fetchImpl, { thinkingBudgetTokens: 2048 });
  const response = await provider.chatWithTools(MESSAGES, TOOLS);
  assert.equal(response.content, "done");
  assert.deepEqual(response.thinkingBlocks, [
    { text: "Reason it through.", signature: "sig-json-1" },
  ]);
  // A redacted thinking block is captured as its opaque payload, in order.
  const redacted = stubFetch(() =>
    jsonResponse({
      content: [
        { type: "redacted_thinking", data: "enc-payload" },
        { type: "text", text: "fine" },
      ],
    }),
  );
  const redactedProvider = anthropic(redacted.fetchImpl, { thinkingBudgetTokens: 2048 });
  const redactedResponse = await redactedProvider.chatWithTools(MESSAGES, TOOLS);
  assert.deepEqual(redactedResponse.thinkingBlocks, [
    { text: "", signature: "", redacted: "enc-payload" },
  ]);
});

// ---------------------------------------------------------------------------
// (d) the harness carries the blocks and echoes them verbatim (two rounds)
// ---------------------------------------------------------------------------

const READ_TOOL: Tool = {
  name: "read_note",
  description: "Read a note.",
  parameters: { type: "object", properties: { path: { type: "string" } } },
  execute: () => JSON.stringify({ tool: "read_note", status: "ok", path: "a.txt", content: "hi" }),
};

const VALID_CONSULT = JSON.stringify({ task: "t", ask: "after tools", expect: "proposal" });
const VALID_REVIEW = JSON.stringify({ verdict: "accept", notes: "ok", points: [] });
const VALID_DECISION = JSON.stringify({ decision: "done", confidence: 0.8 });

test("harness: signed thinking blocks are echoed verbatim on the next tool-loop request", async () => {
  const THINKING = "Plan the lookup.";
  const SIGNATURE = "sig-round-1";
  const requests: RecordedRequest[] = [];
  const handler: FetchLike = async (url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, any>;
    requests.push({ url, headers: {}, body, method: init?.method ?? "POST" });
    switch (requests.length - 1) {
      case 0:
        return thinkingThenToolUseSse({
          thinking: THINKING,
          signature: SIGNATURE,
          callId: "call_1",
          toolName: "read_note",
          args: { path: "a.txt" },
        });
      case 1:
        return textSse(VALID_CONSULT);
      case 2:
        return textSse(VALID_REVIEW);
      default:
        return textSse(VALID_DECISION);
    }
  };
  const streamEvents: StreamEvent[] = [];
  const runtimeEvents: RuntimeEvent[] = [];
  const harness = new TwoBrothersHarness(resolveConfig({ provider: "mock", mode: "consult" }), {
    senior: anthropic(handler, { thinkingBudgetTokens: 2048 }),
    // Junior stays the config's deterministic mock: the consult cycle needs no
    // tool loop there, only the senior tool loop exercises the passback.
    toolScopes: { senior: [READ_TOOL] },
    streamTokens: true,
    onStreamEvent: (event) => streamEvents.push(event),
    onEvent: (event) => runtimeEvents.push(event),
  });

  const result = await harness.run("ground the consult with a read");

  // Round 1: the request asked for extended thinking with a valid max_tokens.
  assert.equal(requests.length >= 2, true);
  assert.deepEqual(requests[0]!.body.thinking, { type: "enabled", budget_tokens: 2048 });
  assert.ok((requests[0]!.body.max_tokens as number) > 2048);

  // Round 2 (after the tool result): the assistant turn echoes the SAME signed
  // block, first, verbatim — before the tool_use block.
  const roundTwo = requests[1]!;
  const assistant = (roundTwo.body.messages as Array<Record<string, any>>).find(
    (message) => message.role === "assistant",
  );
  assert.ok(assistant, "the tool-loop request carries the assistant turn");
  assert.deepEqual(assistant.content, [
    { type: "thinking", thinking: THINKING, signature: SIGNATURE },
    { type: "tool_use", id: "call_1", name: "read_note", input: { path: "a.txt" } },
  ]);
  assert.equal(assistant.content[0].thinking, THINKING, "thinking text is verbatim");
  assert.equal(assistant.content[0].signature, SIGNATURE, "signature is verbatim");
  // The tool result follows the tool_use turn as the API expects.
  const toolResult = (roundTwo.body.messages as Array<Record<string, any>>).find(
    (message) => message.role === "user" && Array.isArray(message.content) &&
      message.content.some((block: Record<string, unknown>) => block.type === "tool_result"),
  );
  assert.ok(toolResult);

  // The final reply drives the structured node exactly like any other call.
  assert.equal(result.messages.find((message) => message.kind === "consult")?.payload.ask, "after tools");

  // The live thinking stream still carries the reasoning text, never the
  // signature as visible text.
  const thinkingTokens = streamEvents.filter(
    (event): event is Extract<StreamEvent, { type: "token" }> =>
      event.type === "token" && event.role === "senior" && event.kind === "thinking",
  );
  assert.equal(thinkingTokens.map((event) => event.delta).join(""), THINKING);
  assert.equal(
    streamEvents.some(
      (event) => event.type === "token" && String(event.delta).includes(SIGNATURE),
    ),
    false,
  );

  // No protocol/envelope change: reasoning text and signature never leak into
  // the shared transcript, and the persisted reasoning record is the only
  // place the text appears (it never carries the signature).
  assert.equal(JSON.stringify(result.messages).includes(SIGNATURE), false);
  assert.equal(JSON.stringify(result.messages).includes(THINKING), false);
  const reasoning = runtimeEvents.filter(
    (event): event is Extract<RuntimeEvent, { type: "reasoning" }> =>
      event.type === "reasoning",
  );
  assert.ok(reasoning.some((event) => event.text.includes(THINKING)));
  assert.equal(reasoning.some((event) => event.text.includes(SIGNATURE)), false);
});

test("harness: a redacted_thinking block is echoed verbatim before the tool_use", async () => {
  // Deliberately awkward opaque payload: base64-ish characters plus control
  // bytes and an ANSI sequence. A sanitizer/trimmer anywhere on the path would
  // change it, so byte equality here proves the replay is verbatim.
  const REDACTED = "opaque+Redacted/Data==\u0000\u001b[31mXYZ\u0007";
  const requests: RecordedRequest[] = [];
  const handler: FetchLike = async (url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, any>;
    requests.push({ url, headers: {}, body, method: init?.method ?? "POST" });
    switch (requests.length - 1) {
      case 0:
        return redactedThenToolUseSse({
          redacted: REDACTED,
          callId: "call_redacted",
          toolName: "read_note",
          args: { path: "b.txt" },
        });
      case 1:
        return textSse(VALID_CONSULT);
      case 2:
        return textSse(VALID_REVIEW);
      default:
        return textSse(VALID_DECISION);
    }
  };
  const streamEvents: StreamEvent[] = [];
  const runtimeEvents: RuntimeEvent[] = [];
  const harness = new TwoBrothersHarness(resolveConfig({ provider: "mock", mode: "consult" }), {
    senior: anthropic(handler, { thinkingBudgetTokens: 2048 }),
    toolScopes: { senior: [READ_TOOL] },
    streamTokens: true,
    onStreamEvent: (event) => streamEvents.push(event),
    onEvent: (event) => runtimeEvents.push(event),
  });

  const result = await harness.run("continue after a redacted thinking block");

  // Round 1 asked for thinking; its reply captured the opaque redacted block.
  assert.deepEqual(requests[0]!.body.thinking, { type: "enabled", budget_tokens: 2048 });
  assert.equal(requests.length >= 2, true);

  // Round 2: the assistant turn starts with the SAME opaque redacted block
  // (exactly as received — no sanitizing, no trimming), then the tool_use.
  const roundTwo = requests[1]!;
  const assistant = (roundTwo.body.messages as Array<Record<string, any>>).find(
    (message) => message.role === "assistant",
  );
  assert.ok(assistant, "the tool-loop request carries the assistant turn");
  assert.deepEqual(assistant.content, [
    { type: "redacted_thinking", data: REDACTED },
    { type: "tool_use", id: "call_redacted", name: "read_note", input: { path: "b.txt" } },
  ]);
  assert.equal(assistant.content[0].data, REDACTED, "the opaque payload is byte-verbatim");
  assert.equal(assistant.content[0].data.length, REDACTED.length);

  // The loop completed and drove the structured node from the final reply.
  assert.deepEqual(result.errors, []);
  assert.equal(
    result.messages.find((message) => message.kind === "consult")?.payload.ask,
    "after tools",
  );

  // The opaque payload never leaks into the protocol transcript, and it is not
  // surfaced as live reasoning text either (a redacted block carries no text).
  assert.equal(JSON.stringify(result.messages).includes("opaque+Redacted"), false);
  assert.equal(JSON.stringify(result.messages).includes("\u0000"), false);
  assert.equal(
    streamEvents.some(
      (event) => event.type === "token" && String(event.delta).includes("opaque"),
    ),
    false,
  );
  // A redacted block produces no SENIOR persisted reasoning record (there is no
  // displayable text), so only the junior mock's own thinking records exist.
  assert.equal(
    runtimeEvents.some(
      (event) => event.type === "reasoning" && event.role === "senior",
    ),
    false,
  );
});

test("harness: the assistant turn with thinking survives JSONL-free context (no session write)", async () => {
  // Same two-round shape, but the private assistant message must not appear in
  // a persisted protocol session: the harness writes only envelopes.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tb-thinking-passback-"));
  try {
    const store = new SessionStore(path.join(tmp, "session.jsonl"));
    const ctx = new SharedContext(store);
    let requestIndex = 0;
    const handler: FetchLike = async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, any>;
      requestIndex += 1;
      if (requestIndex === 1) {
        void body;
        return textSse(VALID_CONSULT);
      }
      return textSse(requestIndex === 2 ? VALID_REVIEW : VALID_DECISION);
    };
    const harness = new TwoBrothersHarness(resolveConfig({ provider: "mock", mode: "consult" }), {
      senior: anthropic(handler, { thinkingBudgetTokens: 2048 }),
      streamTokens: true,
      onStreamEvent: () => undefined,
    });
    const result = await harness.run("no tool round needed", ctx);
    assert.deepEqual(result.errors, []);
    const raw = fs.readFileSync(store.path, "utf-8");
    assert.equal(raw.includes("thinking"), false);
    assert.equal(raw.includes("signature"), false);
    assert.equal(result.context.events.length, 5);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (e) non-Anthropic adapters ignore the option and stay byte-identical
// ---------------------------------------------------------------------------

test("OpenAI-compatible and Google adapters ignore thinkingBudgetTokens byte-for-byte", async () => {
  const FAMILIES = [
    {
      name: "openai-compatible",
      make: (fetchImpl: FetchLike, overrides: Partial<ModelProviderConfig>) =>
        new OpenAICompatibleProvider({ ...BASE, model: "gpt-test", fetchImpl, ...overrides }),
      response: () => jsonResponse({ choices: [{ message: { content: "ok" } }] }),
    },
    {
      name: "google",
      make: (fetchImpl: FetchLike, overrides: Partial<ModelProviderConfig>) =>
        new GoogleProvider({ ...BASE, model: "gemini-test", fetchImpl, ...overrides }),
      response: () =>
        jsonResponse({
          candidates: [{ content: { role: "model", parts: [{ text: "ok" }] } }],
        }),
    },
  ];
  for (const family of FAMILIES) {
    const off = stubFetch(family.response);
    const on = stubFetch(family.response);
    await family.make(off.fetchImpl, {}).chatWithTools(MESSAGES, TOOLS);
    await family.make(on.fetchImpl, { thinkingBudgetTokens: 2048 }).chatWithTools(MESSAGES, TOOLS);
    assert.equal(
      JSON.stringify(on.requests[0]!.body),
      JSON.stringify(off.requests[0]!.body),
      `${family.name}: requests differ only by the ignored option`,
    );
    assert.equal("thinking" in on.requests[0]!.body, false);
  }
});

test("buildProvider threads the budget only into the Anthropic adapter", async () => {
  const anthropicStub = stubFetch(() => jsonResponse({ content: [{ type: "text", text: "ok" }] }));
  const built = buildProvider(
    {
      ...BASE,
      provider: "openai",
      kind: "anthropic",
      fetchImpl: anthropicStub.fetchImpl,
      thinkingBudgetTokens: 2048,
    } as ProviderConfig,
    "senior",
  );
  assert.ok(built instanceof AnthropicProvider);
  await built.chatWithTools?.(MESSAGES, TOOLS);
  assert.deepEqual(anthropicStub.requests[0]!.body.thinking, {
    type: "enabled",
    budget_tokens: 2048,
  });

  const googleStub = stubFetch(() =>
    jsonResponse({
      candidates: [{ content: { role: "model", parts: [{ text: "ok" }] } }],
    }),
  );
  const google = buildProvider(
    {
      ...BASE,
      provider: "openai",
      kind: "google",
      fetchImpl: googleStub.fetchImpl,
      thinkingBudgetTokens: 2048,
    } as ProviderConfig,
    "senior",
  );
  assert.ok(google instanceof GoogleProvider);
  await google.chatWithTools?.(MESSAGES, TOOLS);
  assert.equal("thinking" in googleStub.requests[0]!.body, false);
});

// ---------------------------------------------------------------------------
// (f) validation: below the API minimum is a clear error, not a silent clamp
// ---------------------------------------------------------------------------

test("config validation: the budget must be an integer at least the API minimum", () => {
  assert.equal(resolveConfig({ provider: "mock" }).thinkingBudget, 0, "unset by default");
  assert.equal(resolveConfig({ provider: "mock", thinkingBudget: 2048 }).thinkingBudget, 2048);
  assert.throws(
    () => resolveConfig({ provider: "mock", thinkingBudget: ANTHROPIC_MIN_THINKING_BUDGET - 1 }),
    new RegExp(
      `invalid thinking budget: ${ANTHROPIC_MIN_THINKING_BUDGET - 1} \\(Anthropic requires at least ${ANTHROPIC_MIN_THINKING_BUDGET}`,
    ),
  );
  assert.throws(
    () => resolveConfig({ provider: "mock", thinkingBudget: -5 }),
    /invalid thinking budget: -5/,
  );
  assert.throws(
    () => resolveConfig({ provider: "mock", thinkingBudget: "abc" as unknown as number }),
    /invalid thinking budget/,
  );
  assert.throws(
    () => new AnthropicProvider({ ...BASE, thinkingBudgetTokens: 1000 }),
    /below the Anthropic minimum 1024/,
  );
});

test("CLI: --thinking-budget validation is a usage error (exit 2) and a valid flag passes", async () => {
  await withCleanCliEnv(async () => {
    const bad = cliIO();
    assert.equal(
      await main(["run", "task", "--provider", "mock", "--thinking-budget", "999"], bad),
      2,
    );
    assert.match(bad.err[0]!, /^\[error\] invalid thinking budget: 999/);
    assert.match(bad.err[0]!, /at least 1024/);
    assert.match(bad.err[1]!, /^Usage: two-brothers run/);
    assert.match(bad.err[2]!, /--help/);

    const nonNumeric = cliIO();
    assert.equal(
      await main(["run", "task", "--provider", "mock", "--thinking-budget", "lots"], nonNumeric),
      2,
    );
    assert.match(nonNumeric.err[0]!, /invalid thinking budget: lots/);

    // The env counterpart is validated exactly like the flag.
    process.env.TWO_BROTHERS_THINKING_BUDGET = "512";
    const fromEnv = cliIO();
    assert.equal(await main(["run", "task", "--provider", "mock"], fromEnv), 2);
    assert.match(fromEnv.err[0]!, /invalid thinking budget: 512/);

    // A valid flag is accepted (the mock provider ignores it; the run runs).
    delete process.env.TWO_BROTHERS_THINKING_BUDGET;
    const ok = cliIO();
    assert.equal(
      await main(["run", "task", "--provider", "mock", "--thinking-budget", "2048"], ok),
      0,
    );
    assert.ok(ok.out.length > 0, "the run produced its transcript");
  });
});

// ---------------------------------------------------------------------------
// (f) serve/TUI endpoint path: providerFromEndpoint forwards the budget
// ---------------------------------------------------------------------------

test("serve/TUI endpoint path: both role endpoints carry the thinking option", async () => {
  await withCleanCliEnv(async () => {
    const bodies: Array<Record<string, any>> = [];
    const replies = [
      JSON.stringify({ task: "t", ask: "a", expect: "proposal" }),
      JSON.stringify({ title: "P", answer: "A", confidence: 0.7 }),
      JSON.stringify({ verdict: "accept", notes: "ok", points: [] }),
      JSON.stringify({ decision: "done", confidence: 0.8 }),
    ];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
        const text = replies[Math.min(bodies.length - 1, replies.length - 1)]!;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            content: [{ type: "text", text }],
            usage: { input_tokens: 2, output_tokens: 1 },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const baseUrl = `http://127.0.0.1:${port}/v1`;
    try {
      // Mirrors the serve/TUI construction: per-role endpoints resolved from
      // preset/role settings, the run-level budget from flags/env.
      const cfg = resolveConfig({
        provider: "openai",
        kind: "anthropic",
        baseUrl,
        apiKey: "k",
        seniorModel: "m-senior",
        juniorModel: "m-junior",
        retries: 0,
        timeout: 10,
        thinkingBudget: 2048,
      });
      const harness = new TwoBrothersHarness(cfg, {
        endpoints: {
          senior: { provider: "openai", baseUrl, apiKey: "k", model: "m-senior", kind: "anthropic" },
          junior: { provider: "openai", baseUrl, apiKey: "k", model: "m-junior", kind: "anthropic" },
        },
      });
      const result = await harness.run("ground via the endpoint path");
      assert.deepEqual(result.errors, []);
      assert.equal(bodies.length, 4, "consult -> proposal -> review -> decision");
      for (const body of bodies) {
        assert.deepEqual(body.thinking, { type: "enabled", budget_tokens: 2048 });
        assert.equal("temperature" in body, false);
        assert.ok((body.max_tokens as number) > 2048);
      }
      assert.equal(bodies[0]!.model, "m-senior");
      assert.equal(bodies[1]!.model, "m-junior");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

// ---------------------------------------------------------------------------
// (f2) mixed per-role wire kinds: only the Anthropic role sends thinking
// ---------------------------------------------------------------------------

interface MixedCapture {
  role: "senior" | "junior";
  family: "anthropic" | "openai-compatible";
  /** The exact request-body bytes the provider sent. */
  raw: string;
  body: Record<string, any>;
}

interface MixedKindServer {
  baseUrl: string;
  captures: MixedCapture[];
  reset(): void;
  close(): Promise<void>;
}

/** The strict-valid node reply a mixed-kind run needs, derived from the transcript. */
function mixedReplyText(body: Record<string, any>): string {
  const transcript = JSON.stringify(body.messages ?? []);
  if (transcript.includes("review:")) return JSON.stringify({ decision: "done", confidence: 0.8 });
  if (transcript.includes("proposal:")) {
    return JSON.stringify({ verdict: "accept", notes: "ok", points: [] });
  }
  if (transcript.includes("consult:")) {
    return JSON.stringify({ title: "P", answer: "A", confidence: 0.7 });
  }
  return JSON.stringify({ task: "t", ask: "a", expect: "proposal" });
}

/** A loopback stub serving both wire families for one mixed-kind run at a time. */
async function startMixedKindServer(): Promise<MixedKindServer> {
  const captures: MixedCapture[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      const body = JSON.parse(raw) as Record<string, any>;
      const url = req.url ?? "";
      const family = url.endsWith("/v1/messages") ? "anthropic" : "openai-compatible";
      const role = url.includes("/senior") ? "senior" : "junior";
      captures.push({ role, family, raw, body });
      const reply = mixedReplyText(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      if (family === "anthropic") {
        res.end(
          JSON.stringify({
            content: [{ type: "text", text: reply }],
            usage: { input_tokens: 2, output_tokens: 1 },
          }),
        );
      } else {
        res.end(
          JSON.stringify({
            choices: [{ message: { content: reply } }],
            usage: { prompt_tokens: 2, completion_tokens: 1 },
          }),
        );
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    captures,
    reset: () => {
      captures.length = 0;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** A serve/TUI-style harness over one mixed-kind endpoint pair. */
function mixedKindHarness(
  server: MixedKindServer,
  kinds: { senior: "anthropic" | "openai-compatible"; junior: "anthropic" | "openai-compatible" },
  budget: number,
): TwoBrothersHarness {
  const cfg = resolveConfig({
    provider: "openai",
    baseUrl: server.baseUrl,
    apiKey: "k",
    seniorModel: "m-senior",
    juniorModel: "m-junior",
    temperature: 0.2,
    retries: 0,
    timeout: 10,
    thinkingBudget: budget,
  });
  return new TwoBrothersHarness(cfg, {
    endpoints: {
      senior: {
        provider: "openai",
        baseUrl: `${server.baseUrl}/senior`,
        apiKey: "k",
        model: "m-senior",
        kind: kinds.senior,
      },
      junior: {
        provider: "openai",
        baseUrl: `${server.baseUrl}/junior`,
        apiKey: "k",
        model: "m-junior",
        kind: kinds.junior,
      },
    },
  });
}

test("per-role forwarding: each role's provider config receives the run-level budget", async () => {
  const server = await startMixedKindServer();
  try {
    const bothAnthropic = mixedKindHarness(
      server,
      { senior: "anthropic", junior: "anthropic" },
      2048,
    );
    const bothSenior = bothAnthropic.providers.senior;
    const bothJunior = bothAnthropic.providers.junior;
    assert.ok(bothSenior instanceof AnthropicProvider);
    assert.ok(bothJunior instanceof AnthropicProvider);
    assert.equal(bothSenior.thinkingBudgetTokens, 2048, "senior ProviderConfig got the option");
    assert.equal(bothJunior.thinkingBudgetTokens, 2048, "junior ProviderConfig got the option");

    // Either mixed arrangement: the Anthropic role's provider (whichever role
    // it is) received the option, so a later kind switch cannot drop it.
    const seniorAnthropic = mixedKindHarness(
      server,
      { senior: "anthropic", junior: "openai-compatible" },
      2048,
    );
    assert.ok(seniorAnthropic.providers.senior instanceof AnthropicProvider);
    assert.equal(seniorAnthropic.providers.senior.thinkingBudgetTokens, 2048);
    assert.ok(seniorAnthropic.providers.junior instanceof OpenAICompatibleProvider);

    const juniorAnthropic = mixedKindHarness(
      server,
      { senior: "openai-compatible", junior: "anthropic" },
      2048,
    );
    assert.ok(juniorAnthropic.providers.junior instanceof AnthropicProvider);
    assert.equal(juniorAnthropic.providers.junior.thinkingBudgetTokens, 2048);
    assert.ok(juniorAnthropic.providers.senior instanceof OpenAICompatibleProvider);
  } finally {
    await server.close();
  }
});

test("mixed per-role kinds: only the senior Anthropic role sends thinking; the junior OpenAI body is byte-identical", async () => {
  await withCleanCliEnv(async () => {
    const server = await startMixedKindServer();
    try {
      const kinds = {
        senior: "anthropic",
        junior: "openai-compatible",
      } as const;
      // Run 1: run-level budget enabled.
      const withBudget = mixedKindHarness(server, kinds, 2048);
      const first = await withBudget.run("mixed kinds: senior anthropic");
      assert.deepEqual(first.errors, []);
      const enabledCaptures = [...server.captures];
      server.reset();
      // Run 2 (control): same task, same scripted replies, no budget.
      const withoutBudget = mixedKindHarness(server, kinds, 0);
      const second = await withoutBudget.run("mixed kinds: senior anthropic");
      assert.deepEqual(second.errors, []);
      const controlCaptures = [...server.captures];

      const seniorEnabled = enabledCaptures.filter((capture) => capture.role === "senior");
      const juniorEnabled = enabledCaptures.filter((capture) => capture.role === "junior");
      const seniorControl = controlCaptures.filter((capture) => capture.role === "senior");
      const juniorControl = controlCaptures.filter((capture) => capture.role === "junior");
      assert.equal(seniorEnabled.length, 3, "senior consult -> review -> decision");
      assert.equal(juniorEnabled.length, 1, "junior proposal");
      assert.deepEqual(
        juniorEnabled.map((capture) => capture.family),
        ["openai-compatible"],
      );
      for (const capture of seniorEnabled) {
        assert.equal(capture.family, "anthropic");
        assert.deepEqual(capture.body.thinking, { type: "enabled", budget_tokens: 2048 });
        assert.equal("temperature" in capture.body, false);
        assert.ok((capture.body.max_tokens as number) > 2048);
        assert.equal(capture.body.model, "m-senior");
      }
      for (const capture of juniorEnabled) {
        assert.equal("thinking" in capture.body, false, "the OpenAI-compatible body never gets thinking");
        assert.equal(capture.body.temperature, 0.2);
        assert.equal(capture.body.model, "m-junior");
      }
      // The non-Anthropic role's request bytes are identical with and without
      // the run-level option (only the transcript-derived content, which is the
      // same scripted flow in both runs).
      assert.deepEqual(
        juniorEnabled.map((capture) => capture.raw),
        juniorControl.map((capture) => capture.raw),
        "the junior OpenAI-compatible body is byte-identical to the no-budget run",
      );
      // The Anthropic role's body is the one that changed: thinking added and
      // temperature dropped.
      for (const capture of seniorControl) {
        assert.equal("thinking" in capture.body, false);
        assert.equal(capture.body.temperature, 0.2);
      }
      assert.notEqual(
        JSON.stringify(seniorEnabled.map((capture) => capture.raw)),
        JSON.stringify(seniorControl.map((capture) => capture.raw)),
      );
    } finally {
      await server.close();
    }
  });
});

test("mixed per-role kinds: only the junior Anthropic role sends thinking; the senior OpenAI body is byte-identical", async () => {
  await withCleanCliEnv(async () => {
    const server = await startMixedKindServer();
    try {
      const kinds = {
        senior: "openai-compatible",
        junior: "anthropic",
      } as const;
      const withBudget = mixedKindHarness(server, kinds, 2048);
      const first = await withBudget.run("mixed kinds: junior anthropic");
      assert.deepEqual(first.errors, []);
      const enabledCaptures = [...server.captures];
      server.reset();
      const withoutBudget = mixedKindHarness(server, kinds, 0);
      const second = await withoutBudget.run("mixed kinds: junior anthropic");
      assert.deepEqual(second.errors, []);
      const controlCaptures = [...server.captures];

      const seniorEnabled = enabledCaptures.filter((capture) => capture.role === "senior");
      const juniorEnabled = enabledCaptures.filter((capture) => capture.role === "junior");
      const seniorControl = controlCaptures.filter((capture) => capture.role === "senior");
      const juniorControl = controlCaptures.filter((capture) => capture.role === "junior");
      assert.equal(seniorEnabled.length, 3, "senior consult -> review -> decision");
      assert.equal(juniorEnabled.length, 1, "junior proposal");
      assert.deepEqual(
        [...new Set(seniorEnabled.map((capture) => capture.family))],
        ["openai-compatible"],
      );
      for (const capture of juniorEnabled) {
        assert.equal(capture.family, "anthropic");
        assert.deepEqual(capture.body.thinking, { type: "enabled", budget_tokens: 2048 });
        assert.equal("temperature" in capture.body, false);
        assert.ok((capture.body.max_tokens as number) > 2048);
        assert.equal(capture.body.model, "m-junior");
      }
      for (const capture of seniorEnabled) {
        assert.equal("thinking" in capture.body, false);
        assert.equal(capture.body.temperature, 0.2);
        assert.equal(capture.body.model, "m-senior");
      }
      assert.deepEqual(
        seniorEnabled.map((capture) => capture.raw),
        seniorControl.map((capture) => capture.raw),
        "the senior OpenAI-compatible body is byte-identical to the no-budget run",
      );
      for (const capture of juniorControl) {
        assert.equal("thinking" in capture.body, false);
        assert.equal(capture.body.temperature, 0.2);
      }
    } finally {
      await server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// (g) the request-shape evidence, pinned as one exact body
// ---------------------------------------------------------------------------

test("request-shape evidence: the exact Anthropic body with and without the option", async () => {
  // Since wave 23 every Anthropic request carries the prompt-cache breakpoints
  // (see tests/anthropiccache.test.ts); thinking stays the only difference the
  // option itself adds.
  const CACHE_CONTROL = { type: "ephemeral" } as const;
  const off = stubFetch(() => jsonResponse({ content: [{ type: "text", text: "ok" }] }));
  await anthropic(off.fetchImpl).chat(MESSAGES);
  assert.equal(
    JSON.stringify(off.requests[0]!.body),
    JSON.stringify({
      model: "claude-test",
      max_tokens: DEFAULT_MAX_OUTPUT_TOKENS,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "hello", cache_control: CACHE_CONTROL }],
        },
      ],
      system: [{ type: "text", text: "SYS", cache_control: CACHE_CONTROL }],
      temperature: 0.2,
    }),
    "the disabled request is exactly the pre-thinking body plus the cache breakpoints",
  );

  const on = stubFetch(() => jsonResponse({ content: [{ type: "text", text: "ok" }] }));
  await anthropic(on.fetchImpl, { thinkingBudgetTokens: 2048 }).chat(MESSAGES);
  assert.equal(
    JSON.stringify(on.requests[0]!.body),
    JSON.stringify({
      model: "claude-test",
      max_tokens: DEFAULT_MAX_OUTPUT_TOKENS,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "hello", cache_control: CACHE_CONTROL }],
        },
      ],
      system: [{ type: "text", text: "SYS", cache_control: CACHE_CONTROL }],
      // temperature is intentionally absent: the API rejects it while thinking
      // is enabled (its default 1 applies).
      thinking: { type: "enabled", budget_tokens: 2048 },
    }),
    "the enabled request adds exactly the thinking field (temperature omitted per the API)",
  );

  // The pinning evidence for the passback assistant turn (two-round shape).
  const toolLoop = stubFetch((_request, index) =>
    index === 0
      ? thinkingThenToolUseSse({
          thinking: "Plan the lookup.",
          signature: "sig-evidence",
          callId: "call_1",
          toolName: "lookup",
          args: { q: "x" },
        })
      : jsonResponse({ content: [{ type: "text", text: "done" }] }),
  );
  const provider = anthropic(toolLoop.fetchImpl, { thinkingBudgetTokens: 2048 });
  const first = await provider.chatWithTools(MESSAGES, TOOLS, {
    onThinkingDelta: () => undefined,
  });
  assert.ok(first.thinkingBlocks !== undefined);
  const assistant: ChatMessage = {
    role: "assistant",
    content: first.content,
    toolCalls: first.toolCalls,
    thinkingBlocks: first.thinkingBlocks,
  };
  await provider.chatWithTools(
    [
      { role: "system", content: "SYS" },
      { role: "user", content: "hello" },
      assistant,
      { role: "tool", content: "tool output", toolCallId: "call_1" },
    ],
    TOOLS,
  );
  const secondAssistant = (toolLoop.requests[1]!.body.messages as Array<Record<string, any>>).find(
    (message) => message.role === "assistant",
  );
  assert.equal(
    JSON.stringify(secondAssistant!.content),
    JSON.stringify([
      { type: "thinking", thinking: "Plan the lookup.", signature: "sig-evidence" },
      { type: "tool_use", id: "call_1", name: "lookup", input: { q: "x" } },
    ]),
    "the echoed assistant turn is the recorded evidence",
  );
});
