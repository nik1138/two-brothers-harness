/**
 * Cost estimation (`src/cost.ts`): price-table shape, exact and prefix model
 * matching, arithmetic and the unknown-model contract (`null`, never a
 * made-up number). Pure — no network, no env.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { estimateCost, MODEL_PRICES, priceForModel } from "../src/cost.ts";

test("price table: ~15 rows, unique ids, USD-per-1M sanity", () => {
  assert.ok(MODEL_PRICES.length >= 15, `expected >= 15 rows, got ${MODEL_PRICES.length}`);
  const ids = new Set<string>();
  for (const price of MODEL_PRICES) {
    assert.ok(price.model.length > 0);
    assert.ok(!ids.has(price.model), `duplicate price row: ${price.model}`);
    ids.add(price.model);
    assert.ok(Number.isFinite(price.inputPer1M) && price.inputPer1M >= 0, price.model);
    assert.ok(Number.isFinite(price.outputPer1M) && price.outputPer1M >= 0, price.model);
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