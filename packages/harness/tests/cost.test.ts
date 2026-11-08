/**
 * Cost estimation (`src/cost.ts`): price-table shape, exact and prefix model
 * matching, arithmetic and the unknown-model contract (`null`, never a
 * made-up number). Pure — no network, no env.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  costUsageForFamily,
  estimateCost,
  estimateRunCostFromUsage,
  MODEL_PRICES,
  priceForModel,
} from "../src/cost.ts";

function close(actual: number, expected: number, label: string): void {
  assert.ok(Math.abs(actual - expected) < 1e-12, `${label}: expected ${expected}, got ${actual}`);
}

test("price table: ~15 rows, unique ids, USD-per-1M sanity", () => {
  assert.ok(MODEL_PRICES.length >= 15, `expected >= 15 rows, got ${MODEL_PRICES.length}`);
  const ids = new Set<string>();
  for (const price of MODEL_PRICES) {
    assert.ok(price.model.length > 0);
    assert.ok(!ids.has(price.model), `duplicate price row: ${price.model}`);
    ids.add(price.model);
    assert.ok(Number.isFinite(price.inputPer1M) && price.inputPer1M >= 0, price.model);
    assert.ok(Number.isFinite(price.outputPer1M) && price.outputPer1M >= 0, price.model);
    for (const [label, value] of [
      ["cachedInputPer1M", price.cachedInputPer1M],
      ["cacheWritePer1M", price.cacheWritePer1M],
    ] as const) {
      if (value === undefined) continue;
      assert.ok(Number.isFinite(value) && value >= 0, `${price.model}.${label}`);
    }
  }
});

test("price table: published cache prices cover the families that bill for caching", () => {
  // Cache reads: OpenAI, DeepSeek, Anthropic and Gemini all publish a
  // discounted cached-input rate for these rows.
  for (const model of [
    "gpt-4o",
    "gpt-4o-mini",
    "gpt-4.1",
    "gpt-4.1-mini",
    "gpt-4.1-nano",
    "deepseek-chat",
    "deepseek-reasoner",
    "claude-sonnet-4",
    "claude-opus-4",
    "claude-3-5-sonnet",
    "gemini-2.5-pro",
    "gemini-2.5-flash",
  ]) {
    assert.ok(priceForModel(model)?.cachedInputPer1M !== undefined, model);
  }
  // Only Anthropic publishes a per-token cache-write fee for these families;
  // OpenAI/DeepSeek/Gemini leave it unset (documented input-rate fallback).
  for (const model of ["claude-sonnet-4", "claude-opus-4", "claude-3-5-sonnet"]) {
    assert.ok(priceForModel(model)?.cacheWritePer1M !== undefined, model);
  }
  for (const model of ["gpt-4o", "deepseek-chat", "gemini-2.5-pro", "llama-3.3-70b"]) {
    assert.equal(priceForModel(model)?.cacheWritePer1M, undefined, model);
  }
});

test("price table: covers the documented families", () => {
  for (const model of [
    "gpt-4o",
    "gpt-4o-mini",
    "gpt-4.1",
    "gpt-4.1-mini",
    "gpt-4.1-nano",
    "deepseek-chat",
    "deepseek-reasoner",
    "claude-sonnet-4",
    "claude-opus-4",
    "gemini-2.5-pro",
    "gemini-2.5-flash",
    "llama-3.3-70b",
    "spark-x2.6",
    "lfm3-1.7b",
  ]) {
    assert.ok(priceForModel(model), `missing price row: ${model}`);
  }
});

test("estimateCost: exact model arithmetic (USD per 1M tokens)", () => {
  const cost = estimateCost("gpt-4o", { promptTokens: 1_000_000, completionTokens: 1_000_000 });
  assert.ok(cost);
  assert.equal(cost.currency, "USD");
  assert.equal(cost.model, "gpt-4o");
  assert.equal(cost.inputCost, 2.5);
  assert.equal(cost.outputCost, 10);
  assert.equal(cost.totalCost, 12.5);
});

test("estimateCost: small usage scales linearly", () => {
  const cost = estimateCost("gpt-4o", { promptTokens: 1000, completionTokens: 500 });
  assert.ok(cost);
  assert.equal(cost.inputCost, 0.0025);
  assert.equal(cost.outputCost, 0.005);
  assert.equal(cost.totalCost, 0.0075);
});

test("prefix matching: dated snapshots resolve, longest prefix wins", () => {
  assert.equal(priceForModel("gpt-4o-2024-08-06")?.model, "gpt-4o");
  // gpt-4o is a prefix of gpt-4o-mini; the longer row must win
  assert.equal(priceForModel("gpt-4o-mini-2024-07-18")?.model, "gpt-4o-mini");
  assert.equal(priceForModel("claude-sonnet-4-5")?.model, "claude-sonnet-4");
  assert.equal(priceForModel("claude-opus-4-1")?.model, "claude-opus-4");
  assert.equal(priceForModel("deepseek-reasoner")?.model, "deepseek-reasoner");
});

test("model ids: case-insensitive, `models/` prefix and provider path segments", () => {
  assert.equal(priceForModel("GPT-4O")?.model, "gpt-4o");
  assert.equal(priceForModel("models/gemini-2.5-pro")?.model, "gemini-2.5-pro");
  assert.equal(priceForModel("openai/gpt-4o")?.model, "gpt-4o");
  assert.equal(priceForModel("deepseek/deepseek-chat")?.model, "deepseek-chat");
  assert.equal(priceForModel("  gpt-4o-mini  ")?.model, "gpt-4o-mini");
});

test("unknown models: null estimate, never a fake number", () => {
  assert.equal(priceForModel("mystery-model-9000"), undefined);
  assert.equal(estimateCost("mystery-model-9000", { promptTokens: 10, completionTokens: 5 }), null);
  assert.equal(estimateCost("", { promptTokens: 10, completionTokens: 5 }), null);
});

test("local models: a zero estimate, not unknown", () => {
  for (const model of ["spark-x2.6-4b@q4_k_m", "lfm3-1.7b"]) {
    const cost = estimateCost(model, { promptTokens: 10_000, completionTokens: 5_000 });
    assert.ok(cost, model);
    assert.equal(cost.totalCost, 0, model);
    assert.equal(cost.currency, "USD");
  }
});

test("cached input: a fully cached prompt uses the published cache-read rate", () => {
  // gpt-4o cached input is $1.25/M vs $2.50/M uncached.
  const openai = estimateCost("gpt-4o", {
    promptTokens: 1_000_000,
    completionTokens: 0,
    cachedTokens: 1_000_000,
  });
  assert.ok(openai);
  close(openai.inputCost, 1.25, "gpt-4o cached input");
  // Claude Sonnet 4 cache reads are 0.1x its $3/M input.
  const anthropic = estimateCost("claude-sonnet-4", {
    promptTokens: 1_000_000,
    completionTokens: 0,
    cachedTokens: 1_000_000,
  });
  assert.ok(anthropic);
  close(anthropic.inputCost, 0.3, "claude-sonnet-4 cached input");
});

test("cache writes: Anthropic pays the 1.25x write premium; no write price falls back", () => {
  // Sonnet 4 5-minute ephemeral writes are $3.75/M.
  const writeOnly = estimateCost("claude-sonnet-4", {
    promptTokens: 1_000_000,
    completionTokens: 0,
    cacheWriteTokens: 1_000_000,
  });
  assert.ok(writeOnly);
  close(writeOnly.inputCost, 3.75, "claude-sonnet-4 cache write");
  // A row without a published per-token write fee prices writes at its input
  // rate (deepseek-chat $0.27/M); its usage payloads report no writes today.
  const fallback = estimateCost("deepseek-chat", {
    promptTokens: 1_000_000,
    completionTokens: 0,
    cacheWriteTokens: 1_000_000,
  });
  assert.ok(fallback);
  close(fallback.inputCost, 0.27, "deepseek-chat write fallback");
});

test("cache math: uncached input + cached reads + cache writes + output", () => {
  // 1M total prompt tokens = 200k uncached + 700k cache reads + 100k writes:
  // 200k × $3 + 700k × $0.30 + 100k × $3.75 = $1.185.
  const cost = estimateCost("claude-sonnet-4", {
    promptTokens: 1_000_000,
    completionTokens: 0,
    cachedTokens: 700_000,
    cacheWriteTokens: 100_000,
  });
  assert.ok(cost);
  close(cost.inputCost, 1.185, "mixed prompt cost");
  close(cost.totalCost, 1.185, "mixed total");

  const withOutput = estimateCost("claude-sonnet-4", {
    promptTokens: 1_000_000,
    completionTokens: 1_000_000,
    cachedTokens: 1_000_000,
  });
  assert.ok(withOutput);
  close(withOutput.inputCost, 0.3, "cached input share");
  close(withOutput.outputCost, 15, "output stays at the output rate");
  close(withOutput.totalCost, 15.3, "cached total");
});

test("cached input: a row without a cache-read price keeps the input rate", () => {
  const cost = estimateCost("llama-3.3-70b", {
    promptTokens: 1_000_000,
    completionTokens: 0,
    cachedTokens: 400_000,
  });
  assert.ok(cost);
  close(cost.inputCost, 0.23, "uncached + cached at the input rate");
});

test("cached input: backward-compatible when the cache fields are omitted", () => {
  const legacy = estimateCost("gpt-4o", { promptTokens: 1000, completionTokens: 500 });
  const explicitZero = estimateCost("gpt-4o", {
    promptTokens: 1000,
    completionTokens: 500,
    cachedTokens: 0,
    cacheWriteTokens: 0,
  });
  assert.ok(legacy);
  assert.deepEqual(explicitZero, legacy);
  assert.equal(legacy.inputCost, 0.0025);
  assert.equal(legacy.outputCost, 0.005);
});

test("cached input: cache counts above the prompt total are clamped, never negative", () => {
  const overCached = estimateCost("gpt-4o", {
    promptTokens: 1000,
    completionTokens: 0,
    cachedTokens: 5000,
  });
  assert.ok(overCached);
  close(overCached.inputCost, 0.00125, "all 1000 tokens at the cached rate");

  // 800 reads + at most 200 of the 500 claimed writes fit in 1000 tokens;
  // gpt-4o has no write price, so the write share is billed at input.
  const mixed = estimateCost("gpt-4o", {
    promptTokens: 1000,
    completionTokens: 0,
    cachedTokens: 800,
    cacheWriteTokens: 500,
  });
  assert.ok(mixed);
  close(mixed.inputCost, 0.0015, "clamped mixed cost");
  assert.ok(mixed.inputCost >= 0);
});

test("cached input: NaN / negative cache counts count as zero", () => {
  const cost = estimateCost("gpt-4o", {
    promptTokens: 1_000_000,
    completionTokens: 0,
    cachedTokens: Number.NaN,
    cacheWriteTokens: -5,
  });
  assert.ok(cost);
  close(cost.inputCost, 2.5, "everything uncached");
  assert.equal(
    estimateCost("mystery-model-9000", {
      promptTokens: 10,
      completionTokens: 5,
      cachedTokens: 4,
      cacheWriteTokens: 1,
    }),
    null,
  );
});

test("token inputs: negative / NaN / missing count as zero", () => {
  const cost = estimateCost("gpt-4o", {
    promptTokens: Number.NaN,
    completionTokens: -5,
  });
  assert.ok(cost);
  assert.equal(cost.totalCost, 0);
  const missing = estimateCost("gpt-4o", {
    promptTokens: undefined as unknown as number,
    completionTokens: null as unknown as number,
  });
  assert.ok(missing);
  assert.equal(missing.totalCost, 0);
});

// ---------------------------------------------------------------------------
// family-aware run estimates (shared by serve, the CLI and the TUI)
// ---------------------------------------------------------------------------

test("family mapping: anthropic counts uncached + reads + writes, google reads", () => {
  const usage = {
    input_tokens: 100,
    output_tokens: 50,
    cached_tokens: 30,
    cache_write_tokens: 20,
  };
  assert.deepEqual(costUsageForFamily("anthropic", usage), {
    promptTokens: 150,
    completionTokens: 50,
    cachedTokens: 30,
    cacheWriteTokens: 20,
  });
  assert.deepEqual(costUsageForFamily("google", usage), {
    promptTokens: 130,
    completionTokens: 50,
    cachedTokens: 30,
    cacheWriteTokens: 0,
  });
  assert.deepEqual(costUsageForFamily("openai-compatible", usage), {
    promptTokens: 100,
    completionTokens: 50,
    cachedTokens: 30,
    cacheWriteTokens: 0,
  });
});

test("run estimate: an anthropic run prices cache reads and writes at their rates", () => {
  const estimate = estimateRunCostFromUsage({
    seniorModel: "claude-sonnet-4",
    juniorModel: "claude-sonnet-4",
    seniorFamily: "anthropic",
    juniorFamily: "anthropic",
    usage: {
      input_tokens: 1_000_000,
      output_tokens: 0,
      cached_tokens: 1_000_000,
      cache_write_tokens: 1_000_000,
    },
  });
  assert.ok(estimate);
  // 1M uncached * $3 + 1M reads * $0.30 + 1M writes * $3.75
  close(estimate.totalCost, 3 + 0.3 + 3.75, "anthropic cache-aware total");
  assert.equal(estimate.model, "claude-sonnet-4");
});

test("run estimate: mixed families price exactly only without cache counters", () => {
  const models = { seniorModel: "gpt-4o", juniorModel: "gpt-4o" };
  const noCache = estimateRunCostFromUsage({
    ...models,
    seniorFamily: "anthropic",
    juniorFamily: "openai-compatible",
    usage: { input_tokens: 1_000_000, output_tokens: 0 },
  });
  assert.ok(noCache);
  close(noCache.totalCost, 2.5, "no cache counters: every mapping equals input");
  const ambiguous = estimateRunCostFromUsage({
    ...models,
    seniorFamily: "anthropic",
    juniorFamily: "openai-compatible",
    usage: { input_tokens: 1_000_000, cached_tokens: 10, output_tokens: 0 },
  });
  assert.equal(ambiguous, null, "mixed families with cache counters cannot be priced honestly");
});

test("run estimate: unknown model, blank ids and mixed models stay unknown", () => {
  const base = {
    seniorFamily: "openai-compatible" as const,
    juniorFamily: "openai-compatible" as const,
    usage: { input_tokens: 10, output_tokens: 10 },
  };
  assert.equal(estimateRunCostFromUsage({ ...base, seniorModel: "  ", juniorModel: "  " }), null);
  assert.equal(estimateRunCostFromUsage({ ...base, seniorModel: "a", juniorModel: "b" }), null);
  assert.equal(
    estimateRunCostFromUsage({ ...base, seniorModel: "mystery-model", juniorModel: "mystery-model" }),
    null,
  );
});

test("run estimate: an unresolved family falls back while no cache counters exist", () => {
  const estimate = estimateRunCostFromUsage({
    seniorModel: "gpt-4o",
    juniorModel: "gpt-4o",
    seniorFamily: null,
    juniorFamily: null,
    usage: { input_tokens: 1_000_000, output_tokens: 0 },
  });
  assert.ok(estimate);
  close(estimate.totalCost, 2.5, "unknown kind still prices uncached input");
});