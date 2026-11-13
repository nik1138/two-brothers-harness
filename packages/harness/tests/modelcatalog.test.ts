/**
 * models.dev catalog: effort metadata, provider/model wire-family inference,
 * the compact index, cache semantics (TTL, single-flight, stale-on-error,
 * failure back-off, timeout, disabled) and the curated seed fallback.
 *
 * No network: every catalog injects a fixture `fetchImpl`; the shared document
 * is `tests/fixtures/models-dev.json`.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";

import {
  CACHE_TTL_MS,
  CATALOG_PROVIDER_ID_RE,
  MAX_ENV_ENTRIES,
  MAX_ID_CHARS,
  MAX_MODELS_PER_PROVIDER,
  MAX_NAME_CHARS,
  MAX_PROVIDERS,
  ModelEffortCatalog,
  ModelsDevCatalog,
  buildCatalogIndex,
  buildModelEffortIndex,
  catalogDetail,
  catalogSummaries,
  curatedDetail,
  curatedSummaries,
  inferModelKind,
  inferProviderKind,
  usableBaseUrl,
  type ModelEffortCatalogOptions,
} from "../src/modelcatalog.ts";
import { seedPresets } from "../src/presets.ts";

const FIXTURE = JSON.parse(
  fs.readFileSync(new URL("./fixtures/models-dev.json", import.meta.url), "utf-8"),
) as Record<string, unknown>;

function jsonResponse(
  payload: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(payload), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

function rawResponse(text: string, status = 200): Response {
  return new Response(text, {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A catalog serving the shared fixture (fixed clock unless overridden). */
function fixtureCatalog(options: ModelEffortCatalogOptions = {}): ModelEffortCatalog {
  return new ModelEffortCatalog({
    fetchImpl: (async () => jsonResponse(FIXTURE)) as typeof fetch,
    now: () => 1_000,
    ...options,
  });
}

// -- legacy effort behavior (kept green) --------------------------------------

const EFFORT_FIXTURE = {
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
    fetchImpl: (async () => jsonResponse(EFFORT_FIXTURE)) as typeof fetch,
    now: () => 1_000,
    ...options,
  });
}

test("builds a compact index of model-declared effort values", () => {
  const index = buildModelEffortIndex(EFFORT_FIXTURE);
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
  // a non-reasoning model is not in the effort index at all
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
    return jsonResponse(EFFORT_FIXTURE);
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

test("the deprecated class name is an alias of ModelsDevCatalog", () => {
  assert.equal(ModelEffortCatalog, ModelsDevCatalog);
});

// -- index, summaries, inference ----------------------------------------------

test("buildCatalogIndex: provider summaries, families and display sorting", () => {
  const index = buildCatalogIndex(FIXTURE);
  const { providers, truncated } = catalogSummaries(index);
  assert.equal(truncated, false);
  assert.deepEqual(
    providers.map((provider) => provider.id),
    [
      "amazon-bedrock",
      "anthropic",
      "google",
      "no-models",
      "openai",
      "opencode-go",
      "placeholder-api",
      "some-anthropic-clone",
      "typed-anthropic",
      "unknown-npm",
      "weird-protocol",
      "zai-coding-plan",
    ],
  );

  const go = providers.find((provider) => provider.id === "opencode-go");
  assert.ok(go);
  assert.equal(go.name, "OpenCode Go");
  assert.equal(go.kind, "openai-compatible");
  assert.equal(go.kind_source, "npm");
  assert.equal(go.rejected, false);
  assert.equal(go.needs_base_url, false);
  assert.equal(go.model_count, 7);
  assert.deepEqual(go.families, {
    "openai-compatible": 3,
    anthropic: 2,
    google: 1,
    unsupported: 1,
  });
  // env names are display-only, deduped and capped
  assert.deepEqual(go.env, ["OPENCODE_API_KEY", "OPENCODE_ZEN_KEY", "IGNORED_FOURTH_KEY"]);
  assert.equal(go.env.length, MAX_ENV_ENTRIES);
  // the summary never carries a model array
  assert.equal("models" in go, false);

  const openai = providers.find((provider) => provider.id === "openai");
  assert.ok(openai);
  assert.equal(openai.model_count, 2, "embedding, deprecated and image-only models are filtered");
  assert.deepEqual(openai.families, {
    "openai-compatible": 2,
    anthropic: 0,
    google: 0,
    unsupported: 0,
  });

  const noModels = providers.find((provider) => provider.id === "no-models");
  assert.ok(noModels);
  assert.equal(noModels.model_count, 0);
  assert.deepEqual(noModels.families, {
    "openai-compatible": 0,
    anthropic: 0,
    google: 0,
    unsupported: 0,
  });
});

test("inference matrix: type, npm order, id fallback and rejection", () => {
  // explicit type always wins and an unknown type is never guessed
  assert.deepEqual(inferProviderKind({ type: "openai" }), {
    kind: "openai-compatible",
    kind_source: "type",
    rejected: false,
    reject_reason: null,
  });
  assert.equal(inferProviderKind({ type: "google-genai" }).kind, "google");
  assert.equal(inferProviderKind({ type: "anthropic" }).kind, "anthropic");
  assert.deepEqual(inferProviderKind({ type: "weird-protocol" }), {
    kind: null,
    kind_source: null,
    rejected: true,
    reject_reason: "unknown-type",
  });

  // proprietary npm markers reject before any family marker matches
  for (const npm of [
    "@ai-sdk/google-vertex",
    "@ai-sdk/amazon-bedrock",
    "@ai-sdk/azure",
    "@ai-sdk/cohere",
    "@ai-sdk/cloudflare",
    "@ai-sdk/watsonx",
    "@ai-sdk/sap-ai",
  ]) {
    const inference = inferProviderKind({ npm });
    assert.equal(inference.rejected, true, npm);
    assert.equal(inference.reject_reason, "proprietary-protocol", npm);
    assert.equal(inference.kind, null, npm);
  }

  // known npm families
  assert.equal(inferProviderKind({ npm: "@ai-sdk/anthropic" }).kind, "anthropic");
  assert.equal(inferProviderKind({ npm: "@ai-sdk/claude-sdk" }).kind, "anthropic");
  assert.equal(inferProviderKind({ npm: "@ai-sdk/google" }).kind, "google");
  assert.equal(inferProviderKind({ npm: "@ai-sdk/gemini" }).kind, "google");
  assert.equal(inferProviderKind({ npm: "@ai-sdk/openai" }).kind, "openai-compatible");
  assert.equal(inferProviderKind({ npm: "@ai-sdk/deepseek" }).kind, "openai-compatible");
  assert.equal(inferProviderKind({ npm: "@ai-sdk/openai-compatible" }).kind_source, "npm");

  // unknown npm is guessed openai-compatible with the visible warning source
  assert.deepEqual(inferProviderKind({ npm: "@ai-sdk/mystery" }), {
    kind: "openai-compatible",
    kind_source: "guessed",
    rejected: false,
    reject_reason: null,
  });

  // no npm: derive from the id with the same markers
  assert.equal(inferProviderKind({ id: "some-anthropic-clone" }).kind, "anthropic");
  assert.equal(inferProviderKind({ id: "some-anthropic-clone" }).kind_source, "id");
  assert.equal(inferProviderKind({ id: "google-vertex" }).rejected, true);
  assert.equal(inferProviderKind({ id: "openai-proxy" }).kind, "openai-compatible");
  assert.equal(inferProviderKind({ id: "kimi-code-plan-global" }).kind_source, "guessed");
  assert.equal(inferProviderKind({}).kind, "openai-compatible");
});

test("model overrides: per-model npm family, mixed flag and base URL", () => {
  const providerApi = "https://provider.example/v1";
  const anthropicUrl = "https://provider.example/anthropic/v1";

  const mixed = inferModelKind({
    model: { provider: { npm: "@ai-sdk/anthropic", api: anthropicUrl } },
    providerKind: "openai-compatible",
    providerApi,
  });
  assert.equal(mixed.kind, "anthropic");
  assert.equal(mixed.mixed_family, true);
  assert.equal(mixed.base_url, anthropicUrl);

  const google = inferModelKind({
    model: { provider: { npm: "@ai-sdk/google", api: "https://provider.example/google/v1beta" } },
    providerKind: "openai-compatible",
    providerApi,
  });
  assert.equal(google.kind, "google");
  assert.equal(google.mixed_family, true);

  const sameBase = inferModelKind({
    model: { provider: { npm: "@ai-sdk/openai", api: providerApi } },
    providerKind: "openai-compatible",
    providerApi,
  });
  assert.equal(sameBase.base_url, null, "no override when the URL equals the provider api");

  const apiOnly = inferModelKind({
    model: { provider: { api: anthropicUrl } },
    providerKind: "openai-compatible",
    providerApi,
  });
  assert.equal(apiOnly.kind, "openai-compatible", "api alone keeps the provider family");
  assert.equal(apiOnly.base_url, anthropicUrl);

  const placeholder = inferModelKind({
    model: { provider: { api: "https://${HOST}/v1" } },
    providerKind: "openai-compatible",
    providerApi,
  });
  assert.equal(placeholder.base_url, null);

  const rejected = inferModelKind({
    model: { provider: { npm: "@ai-sdk/amazon-bedrock" } },
    providerKind: "openai-compatible",
    providerApi,
  });
  assert.equal(rejected.kind, null);
  assert.equal(rejected.rejected, true);
  assert.equal(rejected.reject_reason, "proprietary-protocol");

  const plain = inferModelKind({ model: {}, providerKind: "anthropic", providerApi: null });
  assert.equal(plain.kind, "anthropic");
  assert.equal(plain.base_url, null);
  assert.equal(plain.mixed_family, false);
});

test("detail: models sorted by id, kinds resolved, context and efforts", () => {
  const index = buildCatalogIndex(FIXTURE);
  const detail = catalogDetail(index, "opencode-go");
  assert.ok(detail);
  assert.equal(detail.truncated, false);
  assert.deepEqual(
    detail.models.map((model) => model.id),
    [
      "bedrock-model",
      "claude-haiku-5-5",
      "claude-opus-5",
      "deepseek-v4.1-flash",
      "gemini-3-pro",
      "glm-5.2",
      "unknown-npm-model",
    ],
  );
  const byId = new Map(detail.models.map((model) => [model.id, model]));
  const haiku = byId.get("claude-haiku-5-5");
  assert.ok(haiku);
  assert.equal(haiku.kind, "anthropic");
  assert.equal(haiku.mixed_family, true);
  assert.equal(haiku.base_url, "https://opencode.ai/inference/go/anthropic/v1");
  assert.equal(haiku.context_window, 1000000);
  assert.equal(haiku.reasoning, true);
  assert.deepEqual(haiku.efforts, []);
  const opus = byId.get("claude-opus-5");
  assert.deepEqual(opus?.efforts, ["low", "medium", "high", "xhigh", "max"]);
  const glm = byId.get("glm-5.2");
  assert.equal(glm?.kind, "openai-compatible");
  assert.equal(glm?.mixed_family, false);
  assert.equal(glm?.base_url, null);
  assert.deepEqual(glm?.efforts, ["high", "max"]);
  const gemini = byId.get("gemini-3-pro");
  assert.equal(gemini?.kind, "google");
  assert.equal(gemini?.base_url, "https://opencode.ai/inference/go/google/v1beta");
  // a proprietary per-model override is listed as unsupported
  assert.equal(byId.get("bedrock-model")?.kind, null);
  assert.equal(byId.get("bedrock-model")?.mixed_family, false);
  // unknown npm is a guessed openai-compatible model
  assert.equal(byId.get("unknown-npm-model")?.kind, "openai-compatible");
  // the embedding-marker model is filtered out entirely
  assert.equal(byId.has("opencode-embed"), false);

  // case-insensitive lookup; unknown id is null
  assert.ok(catalogDetail(index, "OpenCode-Go"));
  assert.equal(catalogDetail(index, "no-such-provider"), null);
});

test("filtering keeps unknown windows and drops non-text/alpha/deprecated/embedding", () => {
  const index = buildCatalogIndex(FIXTURE);
  const clone = catalogDetail(index, "some-anthropic-clone");
  assert.ok(clone);
  assert.deepEqual(
    clone.models.map((model) => model.id),
    ["clone-model", "clone-model-lite"],
  );
  assert.equal(clone.models.find((model) => model.id === "clone-model-lite")?.context_window, 0);

  const openai = catalogDetail(index, "openai");
  assert.ok(openai);
  assert.deepEqual(
    openai.models.map((model) => model.id),
    ["gpt-4o", "o3"],
  );
  // the preview/alpha model of the placeholder provider is dropped
  const placeholder = catalogDetail(index, "placeholder-api");
  assert.ok(placeholder);
  assert.deepEqual(
    placeholder.models.map((model) => model.id),
    ["gateway-chat-1"],
  );
  assert.equal(placeholder.needs_base_url, true);
  assert.equal(placeholder.api, null);
});

test("clipping and defensive caps: provider/models truncation", () => {
  const long = "x".repeat(600);
  const clipped = buildCatalogIndex({
    ["p".repeat(300)]: {
      name: long,
      api: `https://example.com/${long}`,
      env: [`e1${long}`, `e2${long}`, `e3${long}`, `e4${long}`],
      models: { [long]: { name: long } },
    },
  });
  const summary = catalogSummaries(clipped).providers[0];
  assert.ok(summary);
  assert.equal(summary.id.length, MAX_ID_CHARS);
  assert.equal(summary.name.length, MAX_NAME_CHARS);
  assert.equal(summary.api, null, "an over-long URL is unusable");
  assert.equal(summary.env.length, MAX_ENV_ENTRIES);
  assert.equal(summary.env[0]?.length, MAX_ID_CHARS);
  const detail = catalogDetail(clipped, summary.id);
  assert.ok(detail);
  assert.equal(detail.models[0]?.id.length, MAX_ID_CHARS);
  assert.equal(detail.models[0]?.name.length, MAX_NAME_CHARS);

  const manyProviders: Record<string, unknown> = {};
  for (let i = 0; i < MAX_PROVIDERS + 1; i += 1) {
    manyProviders[`provider-${String(i).padStart(3, "0")}`] = { models: {} };
  }
  const capped = catalogSummaries(buildCatalogIndex(manyProviders));
  assert.equal(capped.truncated, true);
  assert.equal(capped.providers.length, MAX_PROVIDERS);

  const models: Record<string, unknown> = {};
  for (let i = 0; i < MAX_MODELS_PER_PROVIDER + 1; i += 1) {
    models[`model-${String(i).padStart(3, "0")}`] = { name: `Model ${i}` };
  }
  const big = catalogDetail(buildCatalogIndex({ big: { api: "https://big.example/v1", models } }), "big");
  assert.ok(big);
  assert.equal(big.truncated, true);
  assert.equal(big.models.length, MAX_MODELS_PER_PROVIDER);
});

test("usableBaseUrl rejects placeholders, non-http(s) and over-long URLs", () => {
  assert.equal(usableBaseUrl("https://api.example.com/v1"), "https://api.example.com/v1");
  assert.equal(usableBaseUrl("  http://localhost:1234/v1  "), "http://localhost:1234/v1");
  assert.equal(usableBaseUrl("https://${HOST}/v1"), null);
  assert.equal(usableBaseUrl("ftp://example.com/v1"), null);
  assert.equal(usableBaseUrl("not a url"), null);
  assert.equal(usableBaseUrl(""), null);
  assert.equal(usableBaseUrl(42), null);
  assert.equal(usableBaseUrl(`https://example.com/${"a".repeat(600)}`), null);
});

test("the catalog id grammar is shared with the persisted catalog_id", () => {
  assert.equal(CATALOG_PROVIDER_ID_RE.test("opencode-go"), true);
  assert.equal(CATALOG_PROVIDER_ID_RE.test("302ai"), true);
  assert.equal(CATALOG_PROVIDER_ID_RE.test("wafer.ai"), true);
  assert.equal(CATALOG_PROVIDER_ID_RE.test("Bad Id"), false);
  assert.equal(CATALOG_PROVIDER_ID_RE.test(`a${"b".repeat(100)}`), false);
  assert.equal(CATALOG_PROVIDER_ID_RE.test("-leading"), false);
});

// -- cache, sources and fail-soft -------------------------------------------------

test("cache: network -> cache within the TTL -> network after it", async () => {
  let now = 10_000;
  let calls = 0;
  const cat = new ModelEffortCatalog({
    fetchImpl: (async () => {
      calls += 1;
      return jsonResponse(FIXTURE);
    }) as typeof fetch,
    now: () => now,
  });
  const first = await cat.providers();
  assert.equal(first.source, "network");
  assert.equal(first.fetched_at, 10_000);
  assert.equal(first.upstream_error, undefined);
  assert.equal(first.disabled, undefined);

  const cached = await cat.providers();
  assert.equal(cached.source, "cache");
  assert.equal(cached.fetched_at, 10_000);
  assert.equal(calls, 1);

  now += CACHE_TTL_MS;
  const refreshed = await cat.providers();
  assert.equal(refreshed.source, "network");
  assert.equal(refreshed.fetched_at, now);
  assert.equal(calls, 2);
});

test("single-flight: concurrent reads share one download", async () => {
  let calls = 0;
  const cat = new ModelEffortCatalog({
    fetchImpl: (async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return jsonResponse(FIXTURE);
    }) as typeof fetch,
    now: () => 1_000,
  });
  const [summary, detail, effort] = await Promise.all([
    cat.providers(),
    cat.provider("opencode-go"),
    cat.efforts("opencode-go", "glm-5.2"),
  ]);
  assert.equal(calls, 1);
  assert.equal(summary.source, "network");
  assert.equal(detail?.source, "network");
  assert.deepEqual(effort.efforts, ["high", "max"]);
});

test("stale-on-error: an expired snapshot is served after a failed refresh", async () => {
  let now = 1_000;
  let fail = false;
  const cat = new ModelEffortCatalog({
    fetchImpl: (async () => {
      if (fail) throw new Error("HTTP 503");
      return jsonResponse(FIXTURE);
    }) as typeof fetch,
    now: () => now,
  });
  const first = await cat.providers();
  assert.equal(first.source, "network");
  assert.equal(first.fetched_at, 1_000);

  now += CACHE_TTL_MS + 1;
  fail = true;
  const stale = await cat.providers();
  assert.equal(stale.source, "stale");
  assert.equal(stale.fetched_at, 1_000);
  assert.equal(stale.upstream_error, "HTTP 503");
  assert.equal(stale.providers.length, first.providers.length, "the old snapshot is still served");

  // the stale detail is still browsable
  const staleDetail = await cat.provider("opencode-go");
  assert.equal(staleDetail?.source, "stale");
  assert.equal(staleDetail?.provider.model_count, 7);

  // a later success replaces it and clears the error
  now += 60_001;
  fail = false;
  const recovered = await cat.providers();
  assert.equal(recovered.source, "network");
  assert.equal(recovered.upstream_error, undefined);
});

test("first-fetch failure: curated view, failure back-off, then a retry", async () => {
  let now = 1_000;
  let calls = 0;
  let fail = true;
  const cat = new ModelEffortCatalog({
    fetchImpl: (async () => {
      calls += 1;
      if (fail) throw new TypeError("network down");
      return jsonResponse(FIXTURE);
    }) as typeof fetch,
    now: () => now,
    failureTtlMs: 5_000,
  });
  const curated = await cat.providers();
  assert.equal(curated.source, "curated");
  assert.equal(curated.fetched_at, null);
  assert.equal(curated.upstream_error, "network down");
  assert.equal(curated.disabled, undefined);
  assert.deepEqual(
    curated.providers.map((provider) => provider.id),
    seedPresets().map((preset) => preset.name),
  );
  assert.equal(calls, 1);
  // the curated detail works offline for seed ids...
  const seedDetail = await cat.provider("lmstudio");
  assert.equal(seedDetail?.source, "curated");
  assert.deepEqual(
    seedDetail?.provider.models.map((model) => model.id),
    seedPresets().find((preset) => preset.name === "lmstudio")?.models,
  );
  // ...and an id that exists only in the live catalog is honestly null
  assert.equal(await cat.provider("zai-coding-plan"), null);
  // the failure TTL suppresses the next attempt
  await cat.providers();
  assert.equal(calls, 1);
  now += 6_000;
  fail = false;
  const recovered = await cat.providers();
  assert.equal(recovered.source, "network");
  assert.equal(calls, 2);
});

test("malformed payloads are fail-soft and never replace a good snapshot", async () => {
  for (const payload of [[], {}, { p: null }, { p: [] }, "not-an-object", 42, null]) {
    const cat = new ModelEffortCatalog({
      fetchImpl: (async () => jsonResponse(payload)) as typeof fetch,
      now: () => 1_000,
    });
    const snapshot = await cat.providers();
    assert.equal(snapshot.source, "curated", JSON.stringify(payload));
    assert.equal(snapshot.providers.length, seedPresets().length);
  }

  // a non-JSON body and a non-2xx response are failures too
  const nonJson = new ModelEffortCatalog({
    fetchImpl: (async () => rawResponse("{{{ not json")) as typeof fetch,
    now: () => 1_000,
  });
  assert.equal((await nonJson.providers()).source, "curated");

  const emptyJson = new ModelEffortCatalog({
    fetchImpl: (async () => jsonResponse({})) as typeof fetch,
    now: () => 1_000,
  });
  assert.equal((await emptyJson.providers()).source, "curated");

  // a malformed refresh never replaces a good snapshot
  let now = 1_000;
  let calls = 0;
  const cat = new ModelEffortCatalog({
    fetchImpl: (async () => {
      calls += 1;
      if (calls === 1) return jsonResponse(FIXTURE);
      return jsonResponse([]);
    }) as typeof fetch,
    now: () => now,
  });
  const good = await cat.providers();
  assert.equal(good.source, "network");
  now += CACHE_TTL_MS + 1;
  const stale = await cat.providers();
  assert.equal(stale.source, "stale");
  assert.equal(stale.providers.length, good.providers.length);
  assert.equal(stale.upstream_error, "the catalog payload is not a JSON object");
});

test("payload guards: an over-32 MiB response is a fail-soft failure", async () => {
  const cat = new ModelEffortCatalog({
    fetchImpl: (async () =>
      jsonResponse(FIXTURE, {
        headers: { "Content-Length": String(32 * 1024 * 1024 + 1) },
      })) as typeof fetch,
    now: () => 1_000,
  });
  const snapshot = await cat.providers();
  assert.equal(snapshot.source, "curated");
  assert.match(snapshot.upstream_error ?? "", /too large/);
});

test("timeout: an aborted fetch takes the failure path (no hang)", async () => {
  const cat = new ModelEffortCatalog({
    fetchImpl: ((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        // Ref'd keep-alive: an abort-signal-only pending promise lets Node 22's
        // runner settle it as "still pending" when the event loop empties
        // before the product's AbortSignal.timeout timer fires (that timer is
        // unref'd; see the cited hazard in src/tui/clipboard.ts). The abort
        // below clears this handle, so it cannot outlive the bounded wait.
        const keepAlive = setTimeout(() => undefined, 1_000);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(keepAlive);
          reject(new Error("aborted by timeout"));
        });
      })) as typeof fetch,
    now: () => 1_000,
    timeoutMs: 20,
  });
  const snapshot = await cat.providers();
  assert.equal(snapshot.source, "curated");
  assert.equal(snapshot.upstream_error, "aborted by timeout");
});

test("disabled: no fetch at all, curated view marked disabled", async () => {
  let calls = 0;
  const cat = new ModelEffortCatalog({
    fetchImpl: (async () => {
      calls += 1;
      return jsonResponse(FIXTURE);
    }) as typeof fetch,
    now: () => 1_000,
    enabled: false,
  });
  const snapshot = await cat.providers();
  assert.equal(snapshot.source, "curated");
  assert.equal(snapshot.disabled, true);
  assert.equal(snapshot.fetched_at, null);
  assert.equal(calls, 0);
  const detail = await cat.provider("lmstudio");
  assert.equal(detail?.source, "curated");
  assert.equal(detail?.disabled, true);
  assert.deepEqual((await cat.efforts("opencode-go", "glm-5.2")).efforts, []);
  assert.equal(calls, 0);
});

test("curated view: seeds only, seed model mirrors, stored overrides ignored", () => {
  const summaries = curatedSummaries();
  assert.deepEqual(
    summaries.map((provider) => provider.id),
    seedPresets().map((preset) => preset.name),
  );
  const openai = summaries.find((provider) => provider.id === "openai");
  assert.ok(openai);
  assert.equal(openai.kind, "openai-compatible");
  assert.equal(openai.kind_source, "id");
  assert.deepEqual(openai.env, ["OPENAI_API_KEY"]);
  assert.equal(openai.model_count, seedPresets().find((p) => p.name === "openai")?.models.length);
  const anthropic = summaries.find((provider) => provider.id === "anthropic");
  assert.equal(anthropic?.kind, "anthropic");
  const lmstudio = summaries.find((provider) => provider.id === "lmstudio");
  assert.deepEqual(lmstudio?.env, []);
  assert.equal(lmstudio?.needs_base_url, false);

  const detail = curatedDetail("LMStudio");
  assert.ok(detail);
  assert.equal(detail.id, "lmstudio");
  assert.deepEqual(
    detail.models.map((model) => model.id),
    seedPresets().find((preset) => preset.name === "lmstudio")?.models,
  );
  for (const model of detail.models) {
    assert.equal(model.kind, "openai-compatible");
    assert.equal(model.reasoning, false);
    assert.deepEqual(model.efforts, []);
    assert.equal(model.base_url, null);
  }
  assert.equal(curatedDetail("no-such-seed"), null);
});

test("fixture catalog helper serves providers for the route tests", async () => {
  const snapshot = await fixtureCatalog().providers();
  assert.equal(snapshot.source, "network");
  assert.ok(snapshot.providers.some((provider) => provider.id === "opencode-go"));
});

test("summary/detail copies never share mutable state with the index", () => {
  const index = buildCatalogIndex(FIXTURE);
  const first = catalogSummaries(index).providers.find((provider) => provider.id === "opencode-go");
  assert.ok(first);
  first.env.push("MUTATED");
  first.families.anthropic = 999;
  const second = catalogSummaries(index).providers.find(
    (provider) => provider.id === "opencode-go",
  );
  assert.deepEqual(second?.env, ["OPENCODE_API_KEY", "OPENCODE_ZEN_KEY", "IGNORED_FOURTH_KEY"]);
  assert.equal(second?.families.anthropic, 2);

  const detail = catalogDetail(index, "opencode-go");
  assert.ok(detail);
  detail.models[0]?.efforts.push("mutated");
  const again = catalogDetail(index, "opencode-go");
  assert.ok(!(again?.models[0]?.efforts ?? []).includes("mutated"));
});

test("efforts resolve a catalog id directly; filtered models have none", async () => {
  const cat = fixtureCatalog();
  assert.deepEqual((await cat.efforts("opencode-go", "glm-5.2")).efforts, ["high", "max"]);
  assert.equal((await cat.efforts("opencode-go", "opencode-embed")).source, "unavailable");
  // model ids are exact (a differently cased id invents nothing)
  assert.deepEqual((await cat.efforts("OpenCode-Go", "GLM-5.2")).efforts, []);
});

test("a rejected provider's detail is honest (kind null + reason + unsupported models)", () => {
  const detail = catalogDetail(buildCatalogIndex(FIXTURE), "amazon-bedrock");
  assert.ok(detail);
  assert.equal(detail.rejected, true);
  assert.equal(detail.kind, null);
  assert.equal(detail.kind_source, null);
  assert.equal(detail.reject_reason, "proprietary-protocol");
  assert.equal(detail.needs_base_url, true);
  assert.equal(detail.models[0]?.kind, null);
});
