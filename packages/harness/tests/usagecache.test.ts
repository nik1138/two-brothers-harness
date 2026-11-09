/**
 * Prompt-cache accounting (wave 24): `cache_write_tokens` joins the usage
 * aggregate and is mapped from Anthropic's `cache_creation_input_tokens`;
 * cache reads keep their existing `cached_tokens` mapping. OpenAI-compatible
 * and Gemini payloads report no per-token cache-write counter, so they stay 0
 * (never guessed — see `extractUsage`/`googleUsage`).
 *
 * Hermetic: every request goes to a stub `FetchLike`.
 * Run with: node tests/run-all.ts (or node --test tests/usagecache.test.ts)
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { ChatMessage } from "../src/context.ts";
import {
  AnthropicProvider,
  GoogleProvider,
  USAGE_KEYS,
  UsageTracker,
  emptyUsage,
  extractUsage,
  mergeUsage,
  type FetchLike,
  type ModelProviderConfig,
} from "../src/provider.ts";

const PLAIN_MESSAGES: ChatMessage[] = [{ role: "user", content: "hello" }];

const BASE: Omit<ModelProviderConfig, "model" | "fetchImpl"> = {
  provider: "openai",
  baseUrl: "http://stub.example",
  apiKey: "secret-key",
  seniorModel: "senior-model",
  juniorModel: "junior-model",
  temperature: 0.2,
  timeout: 5,
  retries: 0,
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function sseFrame(event: string, payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function sseResponse(frames: string[]): Response {
  return new Response(frames.join(""), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function anthropicProvider(fetchImpl: FetchLike): AnthropicProvider {
  return new AnthropicProvider({ ...BASE, model: "claude-test", fetchImpl });
}

function googleProvider(fetchImpl: FetchLike): GoogleProvider {
  return new GoogleProvider({ ...BASE, model: "gemini-test", fetchImpl });
}

// ---------------------------------------------------------------------------
// aggregate shape and OpenAI-compatible extraction
// ---------------------------------------------------------------------------

test("usage aggregate: cache_write_tokens is a zeroed key and merge sums it", () => {
  assert.ok((USAGE_KEYS as readonly string[]).includes("cache_write_tokens"));
  assert.deepEqual(emptyUsage(), {
    model_calls: 0,
    input_tokens: 0,
    output_tokens: 0,
    cached_tokens: 0,
    cache_write_tokens: 0,
  });

  const total = mergeUsage(
    {
      model_calls: 1,
      input_tokens: 120,
      output_tokens: 30,
      cached_tokens: 40,
      cache_write_tokens: 10,
    },
    // A provider that reports no write counter contributes 0, not undefined.
    { model_calls: 1, input_tokens: 10, output_tokens: 5, cached_tokens: 2 },
  );
  assert.deepEqual(total, {
    model_calls: 2,
    input_tokens: 130,
    output_tokens: 35,
    cached_tokens: 42,
    cache_write_tokens: 10,
  });
  // mergeUsage never mutates its inputs.
  assert.equal(
    mergeUsage({ model_calls: 1, input_tokens: 1, output_tokens: 1 }, null).cache_write_tokens,
    0,
  );
});

test("mixed families: an OpenAI half contributes its input to the prompt total", () => {
  const merged = mergeUsage(
    {
      model_calls: 1,
      input_tokens: 4_000,
      prompt_tokens: 7_600,
      output_tokens: 100,
      cached_tokens: 3_200,
      cache_write_tokens: 400,
    },
    // OpenAI-compatible: input_tokens already includes cache reads; no
    // prompt_tokens field is emitted.
    { model_calls: 1, input_tokens: 100, output_tokens: 10, cached_tokens: 20 },
  );
  assert.deepEqual(merged, {
    model_calls: 2,
    input_tokens: 4_100,
    output_tokens: 110,
    cached_tokens: 3_220,
    cache_write_tokens: 400,
    prompt_tokens: 7_700,
  });
  // The display denominator covers both roles instead of dropping the OpenAI
  // input and clamping the percentage to 100%.
  assert.equal(Math.round((merged.cached_tokens * 100) / merged.prompt_tokens!), 42);
});

test("extractUsage: OpenAI cache reads map, cache writes stay 0 (no guessed equivalent)", () => {
  assert.deepEqual(
    extractUsage({
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 40 },
      },
    }),
    {
      input_tokens: 100,
      output_tokens: 20,
      cached_tokens: 40,
      cache_write_tokens: 0,
    },
  );
  // DeepSeek-style cache hits keep their fallback; DeepSeek reports no writes.
  const deepseek = extractUsage({
    usage: {
      prompt_tokens: 11,
      completion_tokens: 4,
      prompt_cache_hit_tokens: 6,
      prompt_cache_miss_tokens: 5,
    },
  });
  assert.equal(deepseek.cached_tokens, 6);
  assert.equal(deepseek.cache_write_tokens, 0);
  // The generic extractor deliberately does not read Anthropic's field names,
  // even when a gateway echoes them: each family's adapter owns its mapping,
  // and mapping a foreign shape here would be a guess.
  assert.equal(
    extractUsage({
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        cache_creation_input_tokens: 7,
      },
    }).cache_write_tokens,
    0,
  );
});

// ---------------------------------------------------------------------------
// family adapters
// ---------------------------------------------------------------------------

test("anthropic: cache_creation_input_tokens maps to cache_write_tokens", async () => {
  const fetchImpl: FetchLike = async () =>
    jsonResponse({
      content: [{ type: "text", text: "ok" }],
      usage: {
        input_tokens: 120,
        output_tokens: 30,
        cache_read_input_tokens: 40,
        cache_creation_input_tokens: 10,
      },
    });
  const provider = anthropicProvider(fetchImpl);
  assert.equal(await provider.chat(PLAIN_MESSAGES), "ok");
  assert.deepEqual(provider.usageSnapshot(), {
    model_calls: 1,
    input_tokens: 120,
    output_tokens: 30,
    cached_tokens: 40,
    cache_write_tokens: 10,
    prompt_tokens: 170,
  });
});

test("anthropic: streamed cache reads and writes reach the same counters", async () => {
  const fetchImpl: FetchLike = async () =>
    sseResponse([
      sseFrame("message_start", {
        type: "message_start",
        message: {
          usage: {
            input_tokens: 50,
            output_tokens: 0,
            cache_read_input_tokens: 25,
            cache_creation_input_tokens: 7,
          },
        },
      }),
      sseFrame("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
      sseFrame("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "ok" },
      }),
      sseFrame("message_delta", { type: "message_delta", usage: { output_tokens: 7 } }),
      sseFrame("message_stop", { type: "message_stop" }),
    ]);
  const provider = anthropicProvider(fetchImpl);
  const deltas: string[] = [];
  const text = await provider.chat(PLAIN_MESSAGES, "message", undefined, {
    onDelta: (delta) => deltas.push(delta),
  });
  assert.equal(text, "ok");
  assert.equal(deltas.join(""), "ok");
  assert.deepEqual(provider.usageSnapshot(), {
    model_calls: 1,
    input_tokens: 50,
    output_tokens: 7,
    cached_tokens: 25,
    cache_write_tokens: 7,
    prompt_tokens: 82,
  });
});

test("google: cached reads are unchanged and cache writes stay 0", async () => {
  const fetchImpl: FetchLike = async () =>
    jsonResponse({
      candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
      usageMetadata: {
        promptTokenCount: 120,
        cachedContentTokenCount: 40,
        candidatesTokenCount: 25,
        thoughtsTokenCount: 5,
      },
    });
  const provider = googleProvider(fetchImpl);
  assert.equal(await provider.chat(PLAIN_MESSAGES), "ok");
  // input_tokens stays uncached (120 - 40) and cached reads keep their
  // existing mapping; Gemini has no write counter to map.
  assert.deepEqual(provider.usageSnapshot(), {
    model_calls: 1,
    input_tokens: 80,
    output_tokens: 30,
    cached_tokens: 40,
    cache_write_tokens: 0,
    prompt_tokens: 120,
  });
});

// ---------------------------------------------------------------------------
// tracker
// ---------------------------------------------------------------------------

test("usage tracker: the write counter accumulates and snapshots a copy", () => {
  const tracker = new UsageTracker();
  tracker.record(120, 30, 40, 10);
  tracker.recordResponse({
    usage: {
      prompt_tokens: 10,
      completion_tokens: 5,
      prompt_tokens_details: { cached_tokens: 2 },
    },
  });
  tracker.record(1, 1); // cache parameters default to 0
  assert.deepEqual(tracker.snapshot(), {
    model_calls: 3,
    input_tokens: 131,
    output_tokens: 36,
    cached_tokens: 42,
    cache_write_tokens: 10,
  });
  tracker.snapshot().cache_write_tokens = 999;
  assert.equal(tracker.snapshot().cache_write_tokens, 10);
});
