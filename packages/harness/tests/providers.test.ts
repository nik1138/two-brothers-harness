/**
 * Provider tests. Mirrors the original prototype's provider tests (retry and
 * timeout bounds; removed 2026-11-04, see git history) and its retry-policy +
 * usage tests.
 *
 * The transport is faked via the `fetchImpl` constructor option and time via
 * an injectable `sleeper` (mirrors Python's `_FakeSleeper`): backoff delays
 * are recorded, not slept, so no fake clock is needed and tests stay fast.
 * Per-attempt timeouts use short real timeouts against a fetch stub that
 * hangs. Run with: node tests/run-all.ts  (or node --test tests/)
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveConfig, DEFAULTS, type Config } from "../src/config.ts";
import {
  backoffDelays,
  buildProvider,
  emptyUsage,
  extractUsage,
  isOpenCodeEndpoint,
  listModels,
  MODELS_MAX_PAGES,
  mergeUsage,
  MockProvider,
  openCodeClientHeaders,
  OpenAICompatibleProvider,
  ProviderAbortError,
  ProviderHttpError,
  providerSessionIdFromFile,
  UsageTracker,
  type FetchLike,
  type ProviderConfig,
} from "../src/provider.ts";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Records slept intervals instead of sleeping. */
function fakeSleeper(onSleep?: () => void): { sleeper: (s: number) => Promise<void>; slept: number[] } {
  const slept: number[] = [];
  return {
    slept,
    sleeper: async (seconds: number) => {
      slept.push(seconds);
      onSleep?.();
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function usageBody(input: number, output: number, cached: number): unknown {
  return {
    choices: [{ message: { content: "ok" } }],
    usage: {
      prompt_tokens: input,
      completion_tokens: output,
      total_tokens: input + output,
      prompt_tokens_details: { cached_tokens: cached },
    },
  };
}

/** Fails with ConnectionError-like TypeErrors for the first `failures` calls. */
function flakyFetch(failures: number): { fetchImpl: FetchLike; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    fetchImpl: async () => {
      calls += 1;
      if (calls <= failures) throw new TypeError("fetch failed: connection refused");
      return jsonResponse(usageBody(7, 3, 2));
    },
  };
}

function makeProvider(overrides: Partial<ProviderConfig & {
  model: string;
  retries: number;
  backoffBase: number;
  signal: AbortSignal;
  fetchImpl: FetchLike;
  sleeper: (s: number) => Promise<void>;
  rng: () => number;
}> = {}) {
  return new OpenAICompatibleProvider({
    provider: "openai",
    baseUrl: "http://127.0.0.1:9/v1",
    apiKey: "",
    seniorModel: "m",
    juniorModel: "m",
    temperature: 0.4,
    timeout: 120,
    retries: 6,
    model: "m",
    // Pin the 0–25% backoff jitter to "no reduction" so the schedule these
    // tests assert stays exact (jitter itself is covered by retryjitter.test).
    rng: () => 0,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// backoff delays (BackoffDelaysTest)
// ---------------------------------------------------------------------------

test("OpenCode headers identify the client and route by conversation", () => {
  assert.equal(isOpenCodeEndpoint("https://opencode.ai/inference/go/openai/v1"), true);
  assert.equal(isOpenCodeEndpoint("https://opencode.ai.evil.example/v1"), false);
  assert.equal(isOpenCodeEndpoint("not a url"), false);
  assert.deepEqual(openCodeClientHeaders("https://api.openai.com/v1", "s"), {});
  assert.deepEqual(openCodeClientHeaders("https://opencode.ai/zen/v1", "conv-1"), {
    "User-Agent": "two-brothers-harness",
    "x-opencode-client": "two-brothers",
    "x-opencode-session": "conv-1",
  });
  // No session means no fabricated header, but the client still identifies itself.
  assert.deepEqual(openCodeClientHeaders("https://opencode.ai/zen/v1"), {
    "User-Agent": "two-brothers-harness",
    "x-opencode-client": "two-brothers",
  });
  assert.equal(providerSessionIdFromFile("C:\\sessions\\2026-11-12-demo.jsonl"), "2026-11-12-demo");
  assert.equal(providerSessionIdFromFile("/tmp/chat.jsonl"), "chat");
  assert.equal(providerSessionIdFromFile(""), undefined);
});

test("an OpenCode request carries x-opencode-session through the OpenAI adapter", async () => {
  let captured: Record<string, string> | undefined;
  const provider = makeProvider({
    baseUrl: "https://opencode.ai/inference/go/openai/v1",
    sessionId: "web-session-42",
    fetchImpl: async (_url, init) => {
      captured = init?.headers as Record<string, string>;
      return jsonResponse(usageBody(3, 1, 0));
    },
  });
  await provider.chat([{ role: "user", content: "hi" }], "message");
  assert.equal(captured?.["x-opencode-session"], "web-session-42");
  assert.equal(captured?.["x-opencode-client"], "two-brothers");
  assert.equal(captured?.["User-Agent"], "two-brothers-harness");
  assert.equal(captured?.Authorization, undefined);
});

test("an in-memory OpenCode provider still sends a generated session id", async () => {
  let captured: Record<string, string> | undefined;
  const provider = makeProvider({
    baseUrl: "https://opencode.ai/inference/go/openai/v1",
    fetchImpl: async (_url, init) => {
      captured = init?.headers as Record<string, string>;
      return jsonResponse(usageBody(1, 1, 0));
    },
  });
  await provider.chat([{ role: "user", content: "hi" }], "message");
  assert.match(captured?.["x-opencode-session"] ?? "", /^[0-9a-f]{8}-[0-9a-f]{4}-/);
});

test("a non-OpenCode request keeps its exact header set", async () => {
  let captured: Record<string, string> | undefined;
  const provider = makeProvider({
    baseUrl: "http://127.0.0.1:9/v1",
    sessionId: "web-session-42",
    fetchImpl: async (_url, init) => {
      captured = init?.headers as Record<string, string>;
      return jsonResponse(usageBody(1, 1, 0));
    },
  });
  await provider.chat([{ role: "user", content: "hi" }], "message");
  assert.equal(captured?.["x-opencode-session"], undefined);
  assert.equal(captured?.["x-opencode-client"], undefined);
  assert.equal(captured?.["User-Agent"], undefined);
});

test("a model-declared effort is sent as reasoning_effort, exactly as reported", async () => {
  let body: Record<string, unknown> | undefined;
  const provider = makeProvider({
    effort: "xhigh",
    fetchImpl: async (_url, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse(usageBody(1, 1, 0));
    },
  });
  await provider.chat([{ role: "user", content: "hi" }], "message");
  assert.equal(body?.reasoning_effort, "xhigh");
});

test("no effort leaves the OpenAI-compatible body byte-identical", async () => {
  let body: Record<string, unknown> | undefined;
  const provider = makeProvider({
    fetchImpl: async (_url, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse(usageBody(1, 1, 0));
    },
  });
  await provider.chat([{ role: "user", content: "hi" }], "message");
  assert.equal("reasoning_effort" in (body ?? {}), false);
});

test("default backoff table is capped exponential", () => {
  assert.deepEqual(backoffDelays(6), [2, 4, 8, 16, 30, 30]);
});

test("zero retries means a single attempt and no waits", () => {
  assert.deepEqual(backoffDelays(0), []);
});

test("backoff base scales and the cap holds", () => {
  const delays = backoffDelays(6, 0.001);
  assert.equal(delays.length, 6);
  for (const [got, want] of [
    [delays[0], 0.001],
    [delays[1], 0.002],
    [delays[2], 0.004],
    [delays[3], 0.008],
    [delays[4], 0.016],
    [delays[5], 0.032],
  ]) {
    assert.ok(Math.abs(got - want) < 1e-9);
  }
  assert.deepEqual(backoffDelays(6).slice(-2), [30, 30]);
});

// ---------------------------------------------------------------------------
// retry loop (RetryLoopTest)
// ---------------------------------------------------------------------------

test("flaky endpoint succeeds and counts attempts", async () => {
  const flaky = flakyFetch(3);
  const { sleeper, slept } = fakeSleeper();
  const provider = makeProvider({ fetchImpl: flaky.fetchImpl, sleeper });
  const text = await provider.chat([{ role: "user", content: "hi" }], "message");
  assert.equal(text, "ok");
  assert.equal(flaky.calls(), 4); // 3 failures + 1 success
  assert.ok(Math.abs(slept.reduce((a, b) => a + b, 0) - (2 + 4 + 8)) < 1e-9);
});

test("always-failing endpoint gives up after seven attempts", async () => {
  const flaky = flakyFetch(999);
  const { sleeper, slept } = fakeSleeper();
  const provider = makeProvider({ fetchImpl: flaky.fetchImpl, sleeper });
  await assert.rejects(provider.chat([{ role: "user", content: "hi" }], "message"), TypeError);
  assert.equal(flaky.calls(), 7);
  assert.ok(Math.abs(slept.reduce((a, b) => a + b, 0) - (2 + 4 + 8 + 16 + 30 + 30)) < 1e-9);
});

test("zero retries is a single attempt", async () => {
  const flaky = flakyFetch(1);
  const { sleeper, slept } = fakeSleeper();
  const provider = makeProvider({ fetchImpl: flaky.fetchImpl, sleeper, retries: 0 });
  await assert.rejects(provider.chat([{ role: "user", content: "hi" }], "message"), TypeError);
  assert.equal(flaky.calls(), 1);
  assert.deepEqual(slept, []);
});

test("no retry on non-retryable 4xx", async () => {
  let calls4xx = 0;
  const failing: FetchLike = async () => {
    calls4xx += 1;
    return jsonResponse({ error: "unauthorized" }, 401);
  };
  const { sleeper, slept } = fakeSleeper();
  const provider = makeProvider({ fetchImpl: failing, sleeper });
  let err: unknown;
  try {
    await provider.chat([{ role: "user", content: "hi" }], "message");
    assert.fail("expected the chat to reject");
  } catch (caught) {
    err = caught;
  }
  assert.ok(err instanceof ProviderHttpError);
  assert.equal(err.status, 401);
  assert.equal(calls4xx, 1); // failed fast, no retry
  assert.deepEqual(slept, []);
});

test("5xx and 429 are retried", async () => {
  let calls = 0;
  const flaky: FetchLike = async () => {
    calls += 1;
    if (calls === 1) return jsonResponse({ error: "busy" }, 500);
    if (calls === 2) return jsonResponse({ error: "rate" }, 429);
    return jsonResponse(usageBody(1, 1, 0));
  };
  const provider = makeProvider({ fetchImpl: flaky, sleeper: fakeSleeper().sleeper });
  const text = await provider.chat([{ role: "user", content: "hi" }], "message");
  assert.equal(text, "ok");
  assert.equal(calls, 3);
});

test("abort during backoff stops retrying", async () => {
  const controller = new AbortController();
  const flaky = flakyFetch(999);
  const { sleeper, slept } = fakeSleeper(() => controller.abort());
  const provider = makeProvider({
    fetchImpl: flaky.fetchImpl,
    sleeper,
    signal: controller.signal,
  });
  await assert.rejects(
    provider.chat([{ role: "user", content: "hi" }], "message"),
    ProviderAbortError,
  );
  assert.equal(flaky.calls(), 1); // never reached the second attempt
  assert.ok(slept.length > 0);
});

test("abort set before the first attempt raises immediately", async () => {
  const controller = new AbortController();
  controller.abort();
  const flaky = flakyFetch(0);
  const { sleeper, slept } = fakeSleeper();
  const provider = makeProvider({
    fetchImpl: flaky.fetchImpl,
    sleeper,
    signal: controller.signal,
  });
  await assert.rejects(
    provider.chat([{ role: "user", content: "hi" }], "message"),
    ProviderAbortError,
  );
  assert.equal(flaky.calls(), 0);
  assert.deepEqual(slept, []);
});

test("abort during the in-flight fetch rejects promptly and is not retried", async () => {
  const controller = new AbortController();
  let calls = 0;
  const hanging: FetchLike = async (_url, init) => {
    calls += 1;
    return await new Promise<Response>((_resolve, reject) => {
      const signal = init.signal;
      if (signal) {
        signal.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted", "AbortError"));
        });
      }
    });
  };
  const provider = makeProvider({
    fetchImpl: hanging,
    sleeper: fakeSleeper().sleeper,
    timeout: 60, // long enough that only the real abort can fire
    retries: 6,
    signal: controller.signal,
  });
  const pending = provider.chat([{ role: "user", content: "hi" }], "message");
  setTimeout(() => controller.abort(), 20);
  const start = Date.now();
  await assert.rejects(pending, ProviderAbortError);
  assert.ok(Date.now() - start < 1000, "abort must not wait out the backoff or the timeout");
  assert.equal(calls, 1); // not retried
});

test("per-attempt timeout bounds a hung endpoint and reports it", async () => {
  let calls = 0;
  const hanging: FetchLike = async (_url, init) => {
    calls += 1;
    return await new Promise<Response>((_resolve, reject) => {
      const signal = init.signal;
      if (signal) {
        signal.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted", "AbortError"));
        });
      }
    });
  };
  const provider = makeProvider({
    fetchImpl: hanging,
    sleeper: fakeSleeper().sleeper,
    timeout: 1, // 1 s per attempt
    retries: 1, // two attempts
  });
  const start = Date.now();
  let err: unknown;
  try {
    await provider.chat([{ role: "user", content: "hi" }], "message");
    assert.fail("expected the chat to reject");
  } catch (caught) {
    err = caught;
  }
  const elapsed = (Date.now() - start) / 1000;
  assert.ok(err instanceof Error);
  assert.match(err.message, /timed out/);
  assert.equal(calls, 2); // bounded: two attempts, not an unbounded hang
  assert.ok(elapsed < 15, `took ${elapsed}s`);
});

// ---------------------------------------------------------------------------
// usage (ExtractUsageTest / merge_usage / tracker)
// ---------------------------------------------------------------------------

test("extractUsage reads prompt/completion tokens and cached_tokens details", () => {
  assert.deepEqual(extractUsage(usageBody(7, 3, 2)), {
    input_tokens: 7,
    output_tokens: 3,
    cached_tokens: 2,
    cache_write_tokens: 0,
  });
});

test("extractUsage falls back to DeepSeek-style prompt_cache_hit_tokens", () => {
  assert.deepEqual(
    extractUsage({
      usage: { prompt_tokens: 11, completion_tokens: 4, prompt_cache_hit_tokens: 6 },
    }),
    { input_tokens: 11, output_tokens: 4, cached_tokens: 6, cache_write_tokens: 0 },
  );
});

test("extractUsage returns zeros when usage is absent", () => {
  assert.deepEqual(extractUsage({ choices: [] }), {
    input_tokens: 0,
    output_tokens: 0,
    cached_tokens: 0,
    cache_write_tokens: 0,
  });
  assert.deepEqual(extractUsage(null), {
    input_tokens: 0,
    output_tokens: 0,
    cached_tokens: 0,
    cache_write_tokens: 0,
  });
});

test("mergeUsage sums every key and does not mutate inputs", () => {
  const total = mergeUsage(
    { model_calls: 3, input_tokens: 30, output_tokens: 15, cached_tokens: 12 },
    { model_calls: 1, input_tokens: 10, output_tokens: 5, cached_tokens: 0 },
  );
  assert.deepEqual(total, {
    model_calls: 4,
    input_tokens: 40,
    output_tokens: 20,
    cached_tokens: 12,
    cache_write_tokens: 0,
  });
  assert.equal(emptyUsage().model_calls, 0);
});

test("usage tracker accumulates per call and snapshots a copy", () => {
  const tracker = new UsageTracker();
  tracker.record(7, 3, 2);
  tracker.recordResponse(usageBody(10, 5, 1));
  assert.deepEqual(tracker.snapshot(), {
    model_calls: 2,
    input_tokens: 17,
    output_tokens: 8,
    cached_tokens: 3,
    cache_write_tokens: 0,
  });
  tracker.snapshot().input_tokens = 999; // snapshot is a copy
  assert.equal(tracker.snapshot().input_tokens, 17);
});

test("successful call records usage exactly once (after retries)", async () => {
  const flaky = flakyFetch(2);
  const provider = makeProvider({ fetchImpl: flaky.fetchImpl, sleeper: fakeSleeper().sleeper });
  await provider.chat([{ role: "user", content: "hi" }], "message");
  assert.deepEqual(provider.usageSnapshot(), {
    model_calls: 1,
    input_tokens: 7,
    output_tokens: 3,
    cached_tokens: 2,
    cache_write_tokens: 0,
  });
});

// ---------------------------------------------------------------------------
// config wiring (RetriesConfigTest / TimeoutAndRetryTest)
// ---------------------------------------------------------------------------

test("retries default is six and wired through buildProvider", () => {
  assert.equal(DEFAULTS.retries, 6);
  const cfg: Config = resolveConfig({
    provider: "openai",
    baseUrl: "http://127.0.0.1:9/v1",
    seniorModel: "m",
    juniorModel: "m",
    retries: 3,
  });
  const provider = buildProvider(cfg, "senior");
  assert.ok(provider instanceof OpenAICompatibleProvider);
  assert.equal(provider.retries, 3);
});

test("buildProvider mock roles are unaffected and report deterministic usage", async () => {
  const cfg = resolveConfig({ provider: "mock" });
  const provider = buildProvider(cfg, "senior");
  assert.ok(provider instanceof MockProvider);
  const text = await provider.chat(
    [{ role: "user", content: "[[TASK]]\nCount the tokens\n[[/TASK]]" }],
    "proposal",
  );
  const payload = JSON.parse(text) as { title: string };
  assert.equal(payload.title, "Plan for «Count the tokens»");
  // the deterministic per-call usage Python's MockResponder reports (10/5/0)
  assert.deepEqual(provider.usage.snapshot(), {
    model_calls: 1,
    input_tokens: 10,
    output_tokens: 5,
    cached_tokens: 0,
    cache_write_tokens: 0,
  });
  await provider.chat([{ role: "user", content: "hi" }], "message");
  assert.equal(provider.usage.snapshot().model_calls, 2);
});

test("mock usage snapshots merge into a run-level aggregate", async () => {
  const senior = new MockProvider();
  const junior = new MockProvider();
  await senior.chat([{ role: "user", content: "a" }], "consult");
  await junior.chat([{ role: "user", content: "b" }], "proposal");
  assert.deepEqual(mergeUsage(senior.usage.snapshot(), junior.usage.snapshot()), {
    model_calls: 2,
    input_tokens: 20,
    output_tokens: 10,
    cached_tokens: 0,
    cache_write_tokens: 0,
  });
});

// ---------------------------------------------------------------------------
// listModels: kind-aware discovery (openai-compatible default, google listing)
// ---------------------------------------------------------------------------

interface RecordedRequest {
  url: string;
  headers: Record<string, string>;
}

/** Records requests and serves queued JSON payloads in order (last repeats). */
function fakeListingEndpoint(
  ...pages: unknown[]
): { fetchImpl: FetchLike; requests: RecordedRequest[] } {
  const payloads = pages.flatMap((page) => (Array.isArray(page) ? page : [page]));
  const requests: RecordedRequest[] = [];
  const fetchImpl: FetchLike = (async (input: unknown, init?: RequestInit) => {
    const raw = (init?.headers ?? {}) as Record<string, string>;
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw)) headers[key.toLowerCase()] = value;
    requests.push({ url: String(input), headers });
    const payload = payloads[Math.min(requests.length - 1, payloads.length - 1)];
    return jsonResponse(payload);
  }) as FetchLike;
  return { fetchImpl, requests };
}

test("listModels google: v1beta/models URL, x-goog-api-key header, never Bearer, prefix stripped", async () => {
  const { fetchImpl, requests } = fakeListingEndpoint({
    models: [{ name: "models/gemini-2.5-pro" }, { name: "models/gemini-2.0-flash", ownedBy: "google" }],
  });
  const models = await listModels("https://generativelanguage.googleapis.com", {
    kind: "google",
    apiKey: "goog-secret",
    fetchImpl,
  });
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /\/v1beta\/models\?pageSize=\d+/);
  assert.equal(requests[0].headers["x-goog-api-key"], "goog-secret");
  assert.equal(requests[0].headers.authorization, undefined, "Gemini auth is never a Bearer");
  assert.equal(requests[0].headers.Authorization, undefined);
  assert.match(requests[0].url, /^https:\/\/generativelanguage\.googleapis\.com\//);
  assert.ok(!requests[0].url.includes("goog-secret"), "the key never rides in the URL");
  assert.deepEqual(models, [
    { id: "gemini-2.5-pro" },
    { id: "gemini-2.0-flash", owned_by: "google" },
  ]);
});

test("listModels google: a base already carrying a version segment is used as-is", async () => {
  const { fetchImpl, requests } = fakeListingEndpoint({ models: [] });
  await listModels("https://proxy.example.com/gemini/v1beta", {
    kind: "google",
    fetchImpl,
  });
  assert.match(requests[0].url, /^https:\/\/proxy\.example\.com\/gemini\/v1beta\/models\?/);
});

test("listModels google: keyless probe sends no credential header at all", async () => {
  const { fetchImpl, requests } = fakeListingEndpoint({ models: [{ name: "models/gemini-pro" }] });
  const models = await listModels("http://127.0.0.1:9", { kind: "google", fetchImpl });
  assert.deepEqual(models, [{ id: "gemini-pro" }]);
  assert.equal(requests[0].headers["x-goog-api-key"], undefined);
  assert.equal(requests[0].headers.authorization, undefined);
});

test("listModels google: nextPageToken is followed until the list is complete", async () => {
  const { fetchImpl, requests } = fakeListingEndpoint(
    { models: [{ name: "models/a" }], nextPageToken: "tok-2" },
    { models: [{ name: "models/b" }], nextPageToken: "tok-3" },
    { models: [{ name: "models/c" }] },
  );
  const models = await listModels("https://generativelanguage.googleapis.com", {
    kind: "google",
    fetchImpl,
  });
  assert.equal(requests.length, 3);
  assert.ok(!requests[0].url.includes("pageToken"), "the first page starts without a token");
  assert.match(requests[1].url, /pageToken=tok-2/);
  assert.match(requests[2].url, /pageToken=tok-3/);
  assert.deepEqual(models.map((model) => model.id), ["a", "b", "c"]);
});

test("listModels google: pagination is bounded by maxPages (no unbounded loop)", async () => {
  const { fetchImpl, requests } = fakeListingEndpoint({
    models: [{ name: "models/m" }],
    nextPageToken: "forever",
  });
  const models = await listModels("https://generativelanguage.googleapis.com", {
    kind: "google",
    maxPages: 2,
    fetchImpl,
  });
  assert.equal(requests.length, 2, "an endlessly-paging endpoint is capped");
  assert.equal(models.length, 2, "the fetched prefix is returned, not an error");
  assert.ok(MODELS_MAX_PAGES >= 2);
});

test("listModels: anthropic and unknown kinds fail honestly before any request", async () => {
  const { fetchImpl, requests } = fakeListingEndpoint({ data: [] });
  await assert.rejects(
    listModels("https://api.anthropic.com", { kind: "anthropic", fetchImpl }),
    /not supported for the anthropic provider kind/,
  );
  await assert.rejects(
    listModels("https://x.example.com", { kind: "wat", fetchImpl }),
    /unknown provider kind: wat/,
  );
  assert.equal(requests.length, 0, "no request is attempted for unsupported kinds");
});

test("listModels google: upstream errors are clean and never carry the key", async () => {
  const calls: string[] = [];
  const failing: FetchLike = (async (input: unknown) => {
    calls.push(String(input));
    return new Response("boom", { status: 500, statusText: "Server Error" });
  }) as FetchLike;
  await assert.rejects(
    listModels("https://generativelanguage.googleapis.com", {
      kind: "google",
      apiKey: "goog-secret",
      fetchImpl: failing,
    }),
    (exc: Error) => {
      assert.match(exc.message, /HTTP 500/);
      assert.ok(!exc.message.includes("goog-secret"), "the key is never in an error message");
      return true;
    },
  );
  const notJson: FetchLike = (async () =>
    new Response("definitely not json", { status: 200 })) as FetchLike;
  await assert.rejects(
    listModels("https://generativelanguage.googleapis.com", { kind: "google", fetchImpl: notJson }),
    /not JSON/,
  );
  const badShape: FetchLike = (async () =>
    jsonResponse({ unexpected: true })) as FetchLike;
  await assert.rejects(
    listModels("https://generativelanguage.googleapis.com", { kind: "google", fetchImpl: badShape }),
    /expected an array or a \{models: \[\.\.\.\]\} object/,
  );
});

test("listModels: the default kind stays OpenAI-compatible (Bearer, one request)", async () => {
  const { fetchImpl, requests } = fakeListingEndpoint({
    data: [{ id: "gpt-4o", owned_by: "openai" }],
  });
  const models = await listModels("https://api.openai.com/v1", {
    apiKey: "sk-secret",
    fetchImpl,
  });
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /\/v1\/models$/);
  assert.equal(requests[0].headers.authorization, "Bearer sk-secret");
  assert.equal(requests[0].headers["x-goog-api-key"], undefined);
  assert.deepEqual(models, [{ id: "gpt-4o", owned_by: "openai" }]);
});
