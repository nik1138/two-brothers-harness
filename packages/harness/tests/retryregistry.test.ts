/**
 * Provider retry-registry tests (Wave-2 Lane B): pi-ai's error classification,
 * retry-after-ms/Retry-After honoring and context-overflow detection ported
 * onto the owned OpenAI-compatible retry loop.
 *
 * Responses come from a real `node:http` stub on an ephemeral port; waits are
 * recorded through the injectable sleeper, so only the one deliberate
 * real-clock test spends wall time. Run with: node tests/run-all.ts
 * (or node --test tests/).
 */
import assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import type { ChatMessage } from "../src/context.ts";
import {
  classifyProviderError,
  classifyProviderErrorContext,
  isContextOverflowError,
  isContextOverflowMessage,
  OpenAICompatibleProvider,
  parseRetryAfterMs,
  parseRetryAfterSeconds,
  ProviderAbortError,
  ProviderContextOverflowError,
  ProviderHttpError,
  RETRY_AFTER_CAP_SECONDS,
  retryAfterSecondsFromHeaders,
  type Sleeper,
} from "../src/provider.ts";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const USER: ChatMessage[] = [{ role: "user", content: "hi" }];

interface StubStep {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

interface StubEndpoint {
  baseUrl: string;
  calls: () => number;
  close: () => Promise<void>;
}

/** Local OpenAI-compatible endpoint replaying `steps` (the last step repeats). */
async function startStub(steps: StubStep[]): Promise<StubEndpoint> {
  let calls = 0;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk as Buffer));
    req.on("end", () => {
      calls += 1;
      const step = steps.length > 1 ? (steps.shift() as StubStep) : (steps[0] as StubStep);
      res.writeHead(step.status, {
        "Content-Type": "application/json",
        ...(step.headers ?? {}),
      });
      res.end(typeof step.body === "string" ? step.body : JSON.stringify(step.body ?? {}));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    calls: () => calls,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
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
  baseUrl: string,
  overrides: {
    retries?: number;
    sleeper?: Sleeper;
    signal?: AbortSignal;
    rng?: () => number;
  } = {},
): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    provider: "openai",
    baseUrl,
    apiKey: "",
    seniorModel: "m",
    juniorModel: "m",
    temperature: 0.4,
    timeout: 5,
    retries: overrides.retries ?? 6,
    model: "m",
    sleeper: overrides.sleeper,
    signal: overrides.signal,
    rng: overrides.rng,
  });
}

function okBody(content = "ok"): unknown {
  return { choices: [{ message: { content } }] };
}

// ---------------------------------------------------------------------------
// classification registry
// ---------------------------------------------------------------------------

test("registry classifies HTTP statuses into retryable and fatal", () => {
  const cases: Array<[number, boolean, string]> = [
    [400, false, "client-error"],
    [401, false, "client-error"],
    [403, false, "client-error"],
    [404, false, "client-error"],
    [408, true, "request-timeout"],
    [409, true, "conflict"],
    [413, false, "context-overflow"],
    [422, false, "client-error"],
    [429, true, "rate-limit"],
    [500, true, "server-error"],
    [502, true, "server-error"],
    [503, true, "server-error"],
    [504, true, "server-error"],
  ];
  for (const [status, retryable, reason] of cases) {
    const verdict = classifyProviderErrorContext({
      status,
      message: `HTTP ${status} from http://127.0.0.1:9/v1/chat/completions`,
    });
    assert.equal(verdict.retryable, retryable, `status ${status}`);
    assert.equal(verdict.reason, reason, `status ${status}`);
  }
});

test("registry retries transport wording and fails fast on quota and overflow", () => {
  for (const message of [
    "fetch failed",
    "connect ECONNREFUSED 127.0.0.1:9",
    "socket hang up",
    "request timed out",
    "terminated",
    "upstream connect error",
    "429 Too Many Requests",
  ]) {
    const verdict = classifyProviderError(new TypeError(message));
    assert.equal(verdict.retryable, true, message);
    assert.equal(verdict.reason, "transport", message);
  }

  for (const message of [
    "insufficient_quota",
    "Monthly usage limit reached",
    "quota exceeded",
    '{"code":"1308"}',
    "Your billing account is suspended",
  ]) {
    const verdict = classifyProviderError(new Error(message));
    assert.equal(verdict.retryable, false, message);
    assert.equal(verdict.reason, "provider-limit", message);
  }

  const overflow = classifyProviderError(
    new Error("This model's maximum context length is 8192 tokens"),
  );
  assert.deepEqual(overflow, { retryable: false, reason: "context-overflow" });

  assert.deepEqual(classifyProviderError(new Error("something unexpected")), {
    retryable: false,
    reason: "unclassified",
  });
});

test("registry honors x-should-retry over the HTTP status", () => {
  const override = (value: string, status: number) =>
    classifyProviderErrorContext({
      status,
      message: `HTTP ${status} from http://127.0.0.1:9/v1/chat/completions`,
      headers: new Headers({ "x-should-retry": value }),
    });
  assert.deepEqual(override("false", 503), {
    retryable: false,
    reason: "provider-requested-fail",
  });
  assert.deepEqual(override("true", 401), {
    retryable: true,
    reason: "provider-requested-retry",
  });
});

// ---------------------------------------------------------------------------
// context overflow detection
// ---------------------------------------------------------------------------

test("overflow detection matches OpenAI-style payloads and ignores throttling", () => {
  for (const text of [
    "This model's maximum context length is 8192 tokens. However, your messages resulted in 9000 tokens.",
    '{"error":{"message":"too big","code":"context_length_exceeded"}}',
    "prompt is too long: 213462 tokens > 200000 maximum",
    "Your input exceeds the context window of this model",
    "Please reduce the length of the messages or completion",
  ]) {
    assert.equal(isContextOverflowMessage(text), true, text);
  }

  for (const text of [
    "Throttling error: Too many tokens, please wait before trying again.",
    "429 rate limit: too many tokens",
    "something else entirely",
  ]) {
    assert.equal(isContextOverflowMessage(text), false, text);
  }

  assert.equal(isContextOverflowError(413, ""), true);
  assert.equal(isContextOverflowError(400, "invalid request"), false);
});

// ---------------------------------------------------------------------------
// Retry-After parsing
// ---------------------------------------------------------------------------

test("Retry-After parses seconds and HTTP-dates, clamps and caps", () => {
  assert.equal(parseRetryAfterSeconds("2"), 2);
  assert.equal(parseRetryAfterSeconds("0.1"), 0.1);
  assert.equal(parseRetryAfterSeconds("600"), RETRY_AFTER_CAP_SECONDS);
  assert.equal(parseRetryAfterSeconds("-3"), 0);

  const now = Date.parse("2026-11-02T10:00:00Z");
  assert.equal(parseRetryAfterSeconds("Mon, 02 Nov 2026 10:00:05 GMT", now), 5);
  assert.equal(parseRetryAfterSeconds("Mon, 02 Nov 2026 09:59:00 GMT", now), 0);

  assert.equal(parseRetryAfterSeconds("soon"), undefined);
  assert.equal(parseRetryAfterSeconds(""), undefined);
  assert.equal(parseRetryAfterSeconds(null), undefined);
  assert.equal(parseRetryAfterSeconds(undefined), undefined);
});

test("retry-after-ms parses milliseconds, wins over Retry-After and falls through when malformed", () => {
  assert.equal(parseRetryAfterMs("250"), 0.25);
  assert.equal(parseRetryAfterMs("0"), 0);
  assert.equal(parseRetryAfterMs("150000"), RETRY_AFTER_CAP_SECONDS);
  assert.equal(parseRetryAfterMs("-250"), 0);
  for (const bad of ["soon", "250ms", "", " ", null, undefined]) {
    assert.equal(parseRetryAfterMs(bad), undefined, `value ${JSON.stringify(bad)}`);
  }

  const now = Date.parse("2026-11-02T10:00:00Z");
  const headers = (values: Record<string, string>): Headers => new Headers(values);
  assert.equal(
    retryAfterSecondsFromHeaders(headers({ "retry-after-ms": "250", "retry-after": "10" })),
    0.25,
  );
  assert.equal(
    retryAfterSecondsFromHeaders(headers({ "retry-after-ms": "soon", "retry-after": "2" })),
    2,
  );
  assert.equal(
    retryAfterSecondsFromHeaders(
      headers({ "retry-after-ms": "soon", "retry-after": "Mon, 02 Nov 2026 10:00:05 GMT" }),
      now,
    ),
    5,
  );
  assert.equal(
    retryAfterSecondsFromHeaders(headers({ "retry-after-ms": "150000" })),
    RETRY_AFTER_CAP_SECONDS,
  );
  assert.equal(retryAfterSecondsFromHeaders(headers({})), undefined);
  assert.equal(retryAfterSecondsFromHeaders(undefined), undefined);
});

// ---------------------------------------------------------------------------
// retry loop over a real stub endpoint
// ---------------------------------------------------------------------------

test("fatal 4xx fails fast without burning retries", async () => {
  const stub = await startStub([{ status: 401, body: { error: { message: "invalid api key" } } }]);
  const sleep = recordingSleeper();
  try {
    const provider = providerFor(stub.baseUrl, { sleeper: sleep.sleeper });
    await assert.rejects(provider.chat(USER, "message"), (err: unknown) => {
      assert.ok(err instanceof ProviderHttpError);
      assert.equal(err.status, 401);
      assert.equal(err.retryable, false);
      assert.equal(err.reason, "client-error");
      assert.match(err.message, /invalid api key/);
      return true;
    });
    assert.equal(stub.calls(), 1);
    assert.equal(sleep.total(), 0);
  } finally {
    await stub.close();
  }
});

test("429 quota exhaustion is fatal and not retried", async () => {
  const stub = await startStub([
    {
      status: 429,
      body: {
        error: {
          message: "You exceeded your current quota, please check your plan and billing details.",
          code: "insufficient_quota",
        },
      },
    },
  ]);
  const sleep = recordingSleeper();
  try {
    const provider = providerFor(stub.baseUrl, { sleeper: sleep.sleeper });
    await assert.rejects(provider.chat(USER, "message"), (err: unknown) => {
      assert.ok(err instanceof ProviderHttpError);
      assert.equal(err.status, 429);
      assert.equal(err.retryable, false);
      assert.equal(err.reason, "provider-limit");
      return true;
    });
    assert.equal(stub.calls(), 1);
    assert.equal(sleep.total(), 0);
  } finally {
    await stub.close();
  }
});

test("429 Retry-After waits per header instead of the fixed backoff", async () => {
  const stub = await startStub([
    { status: 429, body: { error: "slow down" }, headers: { "Retry-After": "0.1" } },
    { status: 200, body: okBody() },
  ]);
  const sleep = recordingSleeper();
  try {
    const provider = providerFor(stub.baseUrl, { sleeper: sleep.sleeper });
    assert.equal(await provider.chat(USER, "message"), "ok");
    assert.equal(stub.calls(), 2);
    assert.ok(Math.abs(sleep.total() - 0.1) < 1e-9, `slept ${sleep.total()}s, not 0.1s`);
  } finally {
    await stub.close();
  }
});

test("5xx Retry-After is honored too", async () => {
  const stub = await startStub([
    { status: 503, body: { error: "busy" }, headers: { "Retry-After": "0.1" } },
    { status: 200, body: okBody() },
  ]);
  const sleep = recordingSleeper();
  try {
    const provider = providerFor(stub.baseUrl, { sleeper: sleep.sleeper });
    assert.equal(await provider.chat(USER, "message"), "ok");
    assert.equal(stub.calls(), 2);
    assert.ok(Math.abs(sleep.total() - 0.1) < 1e-9, `slept ${sleep.total()}s, not 0.1s`);
  } finally {
    await stub.close();
  }
});

test("retry-after-ms wins over Retry-After", async () => {
  const stub = await startStub([
    {
      status: 429,
      body: { error: "slow down" },
      headers: { "retry-after-ms": "25", "Retry-After": "9" },
    },
    { status: 200, body: okBody() },
  ]);
  const sleep = recordingSleeper();
  try {
    const provider = providerFor(stub.baseUrl, { sleeper: sleep.sleeper });
    assert.equal(await provider.chat(USER, "message"), "ok");
    assert.equal(stub.calls(), 2);
    assert.ok(Math.abs(sleep.total() - 0.025) < 1e-9, `slept ${sleep.total()}s, not 0.025s`);
  } finally {
    await stub.close();
  }
});

test("malformed retry-after-ms falls through to Retry-After", async () => {
  const stub = await startStub([
    {
      status: 429,
      body: { error: "slow down" },
      headers: { "retry-after-ms": "soon", "Retry-After": "0.1" },
    },
    { status: 200, body: okBody() },
  ]);
  const sleep = recordingSleeper();
  try {
    const provider = providerFor(stub.baseUrl, { sleeper: sleep.sleeper });
    assert.equal(await provider.chat(USER, "message"), "ok");
    assert.equal(stub.calls(), 2);
    assert.ok(Math.abs(sleep.total() - 0.1) < 1e-9, `slept ${sleep.total()}s, not 0.1s`);
  } finally {
    await stub.close();
  }
});

test("malformed or absent retry headers fall back to the scheduled backoff", async () => {
  const stub = await startStub([
    {
      status: 503,
      body: { error: "busy" },
      headers: { "retry-after-ms": "soon" },
    },
    { status: 200, body: okBody() },
  ]);
  const sleep = recordingSleeper();
  try {
    // rng 0 pins the jitter to no reduction, so the scheduled 2 s is exact.
    const provider = providerFor(stub.baseUrl, { sleeper: sleep.sleeper, rng: () => 0 });
    assert.equal(await provider.chat(USER, "message"), "ok");
    assert.equal(stub.calls(), 2);
    assert.ok(Math.abs(sleep.total() - 2) < 1e-9, `slept ${sleep.total()}s, not 2s`);
  } finally {
    await stub.close();
  }
});

test("5xx without Retry-After keeps the exponential backoff", async () => {
  const stub = await startStub([
    { status: 500, body: { error: "busy" } },
    { status: 502, body: { error: "bad gateway" } },
    { status: 200, body: okBody() },
  ]);
  const sleep = recordingSleeper();
  try {
    // rng 0 pins the jitter to no reduction, so the schedule is exact.
    const provider = providerFor(stub.baseUrl, { sleeper: sleep.sleeper, rng: () => 0 });
    assert.equal(await provider.chat(USER, "message"), "ok");
    assert.equal(stub.calls(), 3);
    assert.ok(Math.abs(sleep.total() - (2 + 4)) < 1e-9, `slept ${sleep.total()}s, not 6s`);
  } finally {
    await stub.close();
  }
});

test("context-overflow payload throws ProviderContextOverflowError on the first attempt", async () => {
  const stub = await startStub([
    {
      status: 400,
      body: {
        error: {
          message:
            "This model's maximum context length is 8192 tokens. However, your messages resulted in 9000 tokens.",
          type: "invalid_request_error",
          code: "context_length_exceeded",
        },
      },
    },
  ]);
  const sleep = recordingSleeper();
  try {
    const provider = providerFor(stub.baseUrl, { sleeper: sleep.sleeper });
    await assert.rejects(provider.chat(USER, "message"), (err: unknown) => {
      assert.ok(err instanceof ProviderContextOverflowError);
      assert.ok(err instanceof ProviderHttpError);
      assert.equal(err.status, 400);
      assert.equal(err.retryable, false);
      assert.equal(err.reason, "context-overflow");
      assert.match(err.message, /maximum context length/);
      return true;
    });
    assert.equal(stub.calls(), 1);
    assert.equal(sleep.total(), 0);
  } finally {
    await stub.close();
  }
});

test("abort during a retry wait unwinds without another attempt", async () => {
  const stub = await startStub([{ status: 500, body: { error: "busy" } }]);
  const controller = new AbortController();
  const chunks: number[] = [];
  try {
    const provider = providerFor(stub.baseUrl, {
      signal: controller.signal,
      sleeper: async (seconds) => {
        chunks.push(seconds);
        controller.abort();
      },
    });
    await assert.rejects(provider.chat(USER, "message"), ProviderAbortError);
    assert.equal(stub.calls(), 1);
    assert.equal(chunks.length, 1);
  } finally {
    await stub.close();
  }
});

test("Retry-After really delays the next request (real clock)", async () => {
  const stub = await startStub([
    { status: 429, body: { error: "slow down" }, headers: { "Retry-After": "0.1" } },
    { status: 200, body: okBody() },
  ]);
  try {
    const provider = providerFor(stub.baseUrl);
    const start = Date.now();
    assert.equal(await provider.chat(USER, "message"), "ok");
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 80, `waited only ${elapsed}ms`);
    assert.ok(elapsed < 5000, `waited ${elapsed}ms`);
    assert.equal(stub.calls(), 2);
  } finally {
    await stub.close();
  }
});