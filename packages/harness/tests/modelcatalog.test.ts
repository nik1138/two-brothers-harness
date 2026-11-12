/**
 * models.dev effort metadata: per-model extraction, provider aliases, cache
 * and fail-soft behavior. No network: the fetch implementation is injected.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildModelEffortIndex,
  ModelEffortCatalog,
  type ModelEffortCatalogOptions,
} from "../src/modelcatalog.ts";

const FIXTURE = {
  "opencode-go": {
    models: {
      "deepseek-v4.1-flash": {
        reasoning: true,
        reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
      },
      "glm-5.2": { reasoning: true, reasoning_options: [{ type: "effort", values: ["high", "max"] }] },
      "toggle-only": { reasoning: true, reasoning_options: [{ type: "toggle" }] },
      "budget-only": { reasoning: true, reasoning_options: [{ type: "budget_tokens", min: 1024 }] },
      "plain-model": { reasoning: false },
    },
  },
  "kimi-code-plan-global": {
    models: {
      "k3.1-pro": { reasoning: true, reasoning_options: [{ type: "effort", values: ["low", "high"] }] },
    },
  },
};

function catalog(options: ModelEffortCatalogOptions = {}): ModelEffortCatalog {
  return new ModelEffortCatalog({
    fetchImpl: (async () =>
      new Response(JSON.stringify(FIXTURE), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch,
    now: () => 1_000,
    ...options,
  });
}

test("builds a compact index of model-declared effort values", () => {
  const index = buildModelEffortIndex(FIXTURE);
  assert.deepEqual(
    [...(index.get("opencode-go")?.get("deepseek-v4.1-flash")?.efforts ?? [])],
    ["low", "high", "max"],
  );
  assert.deepEqual(
    [...(index.get("opencode-go")?.get("glm-5.2")?.efforts ?? [])],
    ["high", "max"],
  );
  // toggle/budget-only entries are reasoning models with no selectable levels
  assert.deepEqual(index.get("opencode-go")?.get("toggle-only")?.efforts, []);
  assert.deepEqual(index.get("opencode-go")?.get("budget-only")?.efforts, []);
  // a non-reasoning model is not in the index at all
  assert.equal(index.get("opencode-go")?.has("plain-model"), false);
});

test("provider aliases resolve our preset names to models.dev ids", async () => {
  const info = await catalog().efforts("kimi-coding", "k3.1-pro");
  assert.deepEqual(info.efforts, ["low", "high"]);
  assert.equal(info.source, "models.dev");
});

test("unknown provider/model is an honest empty lookup", async () => {
  const info = await catalog().efforts("no-such-provider", "no-such-model");
  assert.deepEqual(info, { reasoning: false, efforts: [], source: "unavailable" });
});

test("one fetch is shared, then the index is cached", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response(JSON.stringify(FIXTURE), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  const cat = new ModelEffortCatalog({ fetchImpl, now: () => 1_000 });
  await cat.efforts("opencode-go", "deepseek-v4.1-flash");
  await cat.efforts("opencode-go", "glm-5.2");
  assert.equal(calls, 1);
});

test("a failed fetch is fail-soft and backs off before retrying", async () => {
  let now = 1_000;
  let calls = 0;
  const cat = new ModelEffortCatalog({
    fetchImpl: (async () => {
      calls += 1;
      throw new TypeError("network down");
    }) as typeof fetch,
    now: () => now,
    failureTtlMs: 5_000,
  });
  assert.deepEqual((await cat.efforts("opencode-go", "glm-5.2")).efforts, []);
  await cat.efforts("opencode-go", "glm-5.2");
  assert.equal(calls, 1, "the failure TTL suppresses a retry storm");
  now += 6_000;
  await cat.efforts("opencode-go", "glm-5.2");
  assert.equal(calls, 2, "a later lookup retries");
});
