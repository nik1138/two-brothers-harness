/**
 * Backoff-jitter tests: bounded 0–25% reduction of the exponential schedule
 * (never an increase), an injectable RNG so waits are deterministic, and the
 * rule that provider-supplied `retry-after-ms`/`Retry-After` delays are never
 * jittered. No test sleeps for real — every wait goes through the provider's
 * `sleeper` seam. Run with: node tests/run-all.ts (or node --test tests/).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { ChatMessage } from "../src/context.ts";
import {
  BACKOFF_JITTER_FRACTION,
  backoffDelays,
  type FetchLike,
  jitterBackoffSeconds,
  OpenAICompatibleProvider,
  ProviderAbortError,
  type Sleeper,
} from "../src/provider.ts";

const USER: ChatMessage[] = [{ role: "user", content: "hi" }];

interface StubStep {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/** Scripted `fetch` replaying `steps` (the last step repeats). */
function scriptedFetch(steps: StubStep[]): { fetchImpl: FetchLike; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    fetchImpl: async () => {
      calls += 1;
      const step = steps.length > 1 ? (steps.shift() as StubStep) : (steps[0] as StubStep);
      return new Response(JSON.stringify(step.body ?? {}), {
        status: step.status,
        headers: { "Content-Type": "application/json", ...(step.headers ?? {}) },
      });
    },
  };
}

/** Records slept seconds instead of sleeping. */
function recordingSleeper(): {
  sleeper: Sleeper;
  total: () => number;
  chunks: () => number[];
} {
  let total = 0;
  const chunks: number[] = [];
  return {
    total: () => total,
    chunks: () => chunks,
    sleeper: async (seconds) => {
      chunks.push(seconds);
      total += seconds;
    },
  };
}

function providerFor(
  fetchImpl: FetchLike,
  overrides: {
    retries?: number;
    sleeper?: Sleeper;
    signal?: AbortSignal;
    rng?: () => number;
  } = {},
): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    provider: "openai",
    baseUrl: "http://127.0.0.1:9/v1",
    apiKey: "",
    seniorModel: "m",
    juniorModel: "m",
    temperature: 0.4,
    timeout: 5,
    retries: overrides.retries ?? 6,
    model: "m",
    fetchImpl,
    sleeper: overrides.sleeper,
    signal: overrides.signal,
    rng: overrides.rng,
  });
}

function okBody(): unknown {
  return { choices: [{ message: { content: "ok" } }] };
}

// ---------------------------------------------------------------------------
// pure jitter helper
// ---------------------------------------------------------------------------

test("jitter removes 0–25% of a scheduled delay and never increases it", () => {
  const delay = 8;
  assert.equal(jitterBackoffSeconds(delay, () => 0), 8);
  assert.equal(jitterBackoffSeconds(delay, () => 0.5), 8 * (1 - 0.125));
  assert.equal(jitterBackoffSeconds(delay, () => 1), 8 * (1 - BACKOFF_JITTER_FRACTION));

  // An injected source outside [0, 1] is clamped, not trusted.
  assert.equal(jitterBackoffSeconds(delay, () => -5), 8);
  assert.equal(
    jitterBackoffSeconds(delay, () => 95),
    8 * (1 - BACKOFF_JITTER_FRACTION),
  );
  assert.equal(jitterBackoffSeconds(delay, () => Number.NaN), 8);

  // Degenerate delays pass through unchanged.
  assert.equal(jitterBackoffSeconds(0, () => 1), 0);
  assert.equal(jitterBackoffSeconds(-1, () => 1), -1);

  // The default source (Math.random) stays inside the documented bounds.
  for (let i = 0; i < 100; i += 1) {
    const jittered = jitterBackoffSeconds(2);
    assert.ok(jittered >= 1.5 && jittered <= 2, `jittered delay ${jittered} outside [1.5, 2]`);
  }

  // The exported schedule remains the unjittered contract.
  assert.deepEqual(backoffDelays(6), [2, 4, 8, 16, 30, 30]);
});

// ---------------------------------------------------------------------------
// retry loop: jitter applies to the schedule only
// ---------------------------------------------------------------------------

test("retry loop applies the injected jitter to exponential backoff", async () => {
  const cases: Array<[number, number]> = [
    [0, 2], // rng 0: no reduction
    [1, 1.5], // rng 1: the full 25% reduction
  ];
  for (const [random, expected] of cases) {
    const fetcher = scriptedFetch([
      { status: 500, body: { error: "busy" } },
      { status: 200, body: okBody() },
    ]);
    const sleep = recordingSleeper();
    const provider = providerFor(fetcher.fetchImpl, {
      retries: 1,
      sleeper: sleep.sleeper,
      rng: () => random,
    });
    assert.equal(await provider.chat(USER, "message"), "ok");
    assert.equal(fetcher.calls(), 2);
    assert.ok(
      Math.abs(sleep.total() - expected) < 1e-9,
      `rng ${random}: slept ${sleep.total()}s, not ${expected}s`,
    );
  }
});

test("Retry-After and retry-after-ms delays are not jittered", async () => {
  const cases: Array<Record<string, string>> = [
    { "Retry-After": "0.1" },
    { "retry-after-ms": "100", "Retry-After": "9" },
  ];
  for (const headers of cases) {
    const fetcher = scriptedFetch([
      { status: 429, body: { error: "slow down" }, headers },
      { status: 200, body: okBody() },
    ]);
    const sleep = recordingSleeper();
    const provider = providerFor(fetcher.fetchImpl, {
      retries: 1,
      sleeper: sleep.sleeper,
      rng: () => 1, // would remove 25% if jitter were applied
    });
    assert.equal(await provider.chat(USER, "message"), "ok");
    assert.equal(fetcher.calls(), 2);
    assert.ok(
      Math.abs(sleep.total() - 0.1) < 1e-9,
      `slept ${sleep.total()}s, not the honored 0.1s`,
    );
  }
});

test("abort during a jittered wait throws promptly", async () => {
  const controller = new AbortController();
  const fetcher = scriptedFetch([{ status: 500, body: { error: "busy" } }]);
  const chunks: number[] = [];
  const provider = providerFor(fetcher.fetchImpl, {
    retries: 6,
    signal: controller.signal,
    rng: () => 1, // first wait is jittered to 1.5 s
    sleeper: async (seconds) => {
      chunks.push(seconds);
      controller.abort();
    },
  });
  await assert.rejects(provider.chat(USER, "message"), ProviderAbortError);
  assert.equal(fetcher.calls(), 1);
  assert.equal(chunks.length, 1);
  assert.ok(chunks[0]! <= 1.5, `unexpected first wait chunk ${chunks[0]}`);
});
