/**
 * Slow-model observability: a per-attempt provider timeout that will be
 * retried emits ONE `[warn]` line on stderr — visible without `--verbose`,
 * never on stdout (machine-readable modes stay parseable) — at most three
 * times per provider instance/run. `serve --help` documents `--timeout`.
 *
 * Config validation seams: an invalid `--retries` (over the cap) or
 * `TWO_BROTHERS_TIMEOUT` value is rejected by `resolveConfig` before any
 * provider request leaves the process — asserted against a request-counting
 * loopback server.
 *
 * Hermetic: a hanging fetch stub with an injected sleeper for the provider
 * cases, and a local HTTP server that answers slower than the CLI timeout
 * for the wiring case. Run with: `node tests/run-all.ts`.
 */
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { main, type CliIO } from "../src/cli.ts";
import {
  MAX_PROVIDER_TIMEOUT_SECONDS,
  MAX_TIMEOUT_WARNINGS,
  OpenAICompatibleProvider,
  type FetchLike,
} from "../src/provider.ts";

function makeIO(): CliIO & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, log: (line) => out.push(line), error: (line) => err.push(line) };
}

/** A fetch that never answers until its signal aborts (a hung endpoint). */
const hangingFetch: FetchLike = async (_url, init) =>
  await new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => {
      reject(new DOMException("The operation was aborted", "AbortError"));
    });
  });

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function makeProvider(overrides: Record<string, unknown> = {}) {
  return new OpenAICompatibleProvider({
    provider: "openai",
    baseUrl: "http://127.0.0.1:9/v1",
    apiKey: "",
    seniorModel: "m",
    juniorModel: "m",
    temperature: 0.4,
    timeout: 0.02,
    retries: 2,
    model: "m",
    fetchImpl: hangingFetch,
    sleeper: async () => undefined,
    ...overrides,
  });
}

const WARNING_SHAPE =
  /^\[warn\] provider attempt timed out after [\d.]+s; retrying \(attempt \d+\/\d+\) — consider --timeout for slow models$/;

test("a timed-out attempt that retries warns on stderr — capped per provider", async () => {
  const captured: string[] = [];
  const originalError = console.error;
  console.error = (line?: unknown) => {
    captured.push(String(line ?? ""));
  };
  try {
    const provider = makeProvider({ retries: 6 });
    await assert.rejects(
      provider.chat([{ role: "user", content: "hi" }], "message"),
      /timed out after 0\.02s/,
    );
  } finally {
    console.error = originalError;
  }
  assert.equal(captured.length, MAX_TIMEOUT_WARNINGS);
  for (const line of captured) assert.match(line, WARNING_SHAPE);
  assert.match(captured[0], /\(attempt 2\/7\)/, "first retry is attempt 2 of 7");
  assert.match(captured[2], /\(attempt 4\/7\)/);
});

test("an explicit onWarning sink replaces the stderr default", async () => {
  const lines: string[] = [];
  const originalError = console.error;
  console.error = () => {
    assert.fail("the console default must not fire when onWarning is set");
  };
  try {
    const provider = makeProvider({ retries: 1, onWarning: (line: string) => lines.push(line) });
    await assert.rejects(
      provider.chat([{ role: "user", content: "hi" }], "message"),
      /timed out/,
    );
  } finally {
    console.error = originalError;
  }
  assert.equal(lines.length, 1);
  assert.match(lines[0], WARNING_SHAPE);
});

test("a retry that succeeds still warns once about the timeout", async () => {
  let calls = 0;
  const flaky: FetchLike = async (url, init) => {
    calls += 1;
    if (calls === 1) return hangingFetch(url, init);
    return jsonResponse({ choices: [{ message: { content: "ok" } }] });
  };
  const lines: string[] = [];
  const provider = makeProvider({
    retries: 1,
    fetchImpl: flaky,
    onWarning: (line: string) => lines.push(line),
  });
  const text = await provider.chat([{ role: "user", content: "hi" }], "message");
  assert.equal(text, "ok");
  assert.equal(calls, 2);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /\(attempt 2\/2\)/);
});

test("CLI: a slow endpoint warns on stderr without --verbose, stdout stays empty", async () => {
  const slow = createHttpServer((_req, res) => {
    // answer well after the configured timeout
    setTimeout(() => {
      res.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
      res.end(JSON.stringify({ choices: [{ message: { content: "late" } }] }));
    }, 300);
  });
  await new Promise<void>((resolve) => slow.listen(0, "127.0.0.1", resolve));
  const port = (slow.address() as AddressInfo).port;
  const previousRetries = process.env.TWO_BROTHERS_RETRIES;
  const previousTimeout = process.env.TWO_BROTHERS_TIMEOUT;
  try {
    // one retry keeps the test's real 2 s backoff to a single wait
    process.env.TWO_BROTHERS_RETRIES = "1";
    process.env.TWO_BROTHERS_TIMEOUT = "0";
    const io = makeIO();
    await assert.rejects(
      main(
        [
          "run",
          "warn about the slow model",
          "--provider",
          "openai",
          "--base-url",
          `http://127.0.0.1:${port}/v1`,
          "--senior-model",
          "m",
          "--junior-model",
          "m",
          "--mode",
          "json",
        ],
        io,
      ),
      /timed out/,
    );
    assert.deepEqual(io.out, [], "no diagnostic may leak onto stdout");
    assert.equal(io.err.length, 1, io.err.join("\n"));
    assert.match(
      io.err[0],
      /^\[warn\] provider attempt timed out after 0s; retrying \(attempt 2\/2\) — consider --timeout for slow models$/,
    );
  } finally {
    if (previousRetries === undefined) delete process.env.TWO_BROTHERS_RETRIES;
    else process.env.TWO_BROTHERS_RETRIES = previousRetries;
    if (previousTimeout === undefined) delete process.env.TWO_BROTHERS_TIMEOUT;
    else process.env.TWO_BROTHERS_TIMEOUT = previousTimeout;
    slow.closeAllConnections();
    await new Promise<void>((resolve) => slow.close(() => resolve()));
  }
});

test("serve --help mentions --timeout", async () => {
  const io = makeIO();
  assert.equal(await main(["serve", "--help"], io), 0);
  const help = io.out.join("\n");
  assert.match(help, /two-brothers serve/);
  assert.match(help, /--timeout <s>/);
  assert.match(help, /slow local models/);
});

/** Largest delay Node's 32-bit timers accept (the value an overflow collapses past). */
const INT32_TIMER_MAX_MS = 2_147_483_647;

/**
 * Record every `setTimeout` delay armed while `body` runs (the provider's
 * per-attempt timer is the only timer it owns). The wrapper still delegates to
 * the real timer, so abort semantics — including the deliberate `timeout: 0`
 * immediate abort — keep working.
 */
async function recordTimerDelays(body: (delays: number[]) => Promise<void>): Promise<number[]> {
  const delays: number[] = [];
  const original = globalThis.setTimeout;
  globalThis.setTimeout = ((
    callback: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ) => {
    delays.push(Number(delay));
    return original(callback as never, delay, ...(args as never[]));
  }) as unknown as typeof setTimeout;
  try {
    await body(delays);
  } finally {
    globalThis.setTimeout = original;
  }
  return delays;
}

test("an over-ceiling --timeout is clamped to the 24 h ceiling, never a 1 ms timer", async () => {
  const lines: string[] = [];
  const delays = await recordTimerDelays(async () => {
    const provider = makeProvider({
      timeout: 3_000_000_000,
      retries: 0,
      fetchImpl: async () => jsonResponse({ choices: [{ message: { content: "ok" } }] }),
      onWarning: (line: string) => lines.push(line),
    });
    assert.equal(await provider.chat([{ role: "user", content: "hi" }], "message"), "ok");
  });
  assert.equal(delays[0], MAX_PROVIDER_TIMEOUT_SECONDS * 1000, delays.join(", "));
  // The clamp is the whole point: no armed delay may overflow Node's timer.
  assert.ok(delays.every((ms) => ms <= INT32_TIMER_MAX_MS), delays.join(", "));
  assert.ok(!delays.includes(1), `an overflowing delay armed a 1 ms timer: ${delays.join(", ")}`);
  assert.equal(lines.length, 1);
  assert.match(
    lines[0],
    /^\[warn\] timeout 3000000000s exceeds the 86400s \(24 h\) ceiling; using 86400s \(--timeout <s> \/ TWO_BROTHERS_TIMEOUT\)$/,
  );
});

test("timeout 0 keeps its deliberate immediate-timeout meaning", async () => {
  const delays = await recordTimerDelays(async () => {
    const provider = makeProvider({ timeout: 0, retries: 0 });
    await assert.rejects(
      provider.chat([{ role: "user", content: "hi" }], "message"),
      /timed out after 0s/,
    );
  });
  assert.equal(delays[0], 0, delays.join(", "));
});

test("a normal timeout is left unchanged", async () => {
  const lines: string[] = [];
  const delays = await recordTimerDelays(async () => {
    const provider = makeProvider({
      timeout: 120,
      retries: 0,
      fetchImpl: async () => jsonResponse({ choices: [{ message: { content: "ok" } }] }),
      onWarning: (line: string) => lines.push(line),
    });
    assert.equal(await provider.chat([{ role: "user", content: "hi" }], "message"), "ok");
  });
  assert.equal(delays[0], 120_000, delays.join(", "));
  assert.deepEqual(lines, []);
});

/**
 * A request-counting loopback server: proof that an invalid timeout/retries
 * config is rejected by `resolveConfig` before any provider attempt is made.
 */
async function startRequestRecorder(): Promise<{
  server: ReturnType<typeof createHttpServer>;
  port: number;
  requests: () => number;
}> {
  let count = 0;
  const server = createHttpServer((_req, res) => {
    count += 1;
    res.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
    res.end(JSON.stringify({ choices: [{ message: { content: "unreachable" } }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as AddressInfo).port, requests: () => count };
}

const OPENAI_ARGS = (port: number): string[] => [
  "run",
  "probe the endpoint",
  "--provider",
  "openai",
  "--base-url",
  `http://127.0.0.1:${port}/v1`,
  "--senior-model",
  "m",
  "--junior-model",
  "m",
];

test("CLI: --retries over the cap fails before any provider request", async () => {
  const recorder = await startRequestRecorder();
  try {
    const io = makeIO();
    await assert.rejects(
      main([...OPENAI_ARGS(recorder.port), "--retries", "99"], io),
      /invalid retries: 99 \(use an integer from 0 to 32; --retries <n> \/ TWO_BROTHERS_RETRIES\)/,
    );
    assert.equal(recorder.requests(), 0, "no provider attempt may occur on invalid config");
    assert.deepEqual(io.out, [], "no diagnostic may leak onto stdout");
  } finally {
    recorder.server.closeAllConnections();
    await new Promise<void>((resolve) => recorder.server.close(() => resolve()));
  }
});

test("CLI: invalid TWO_BROTHERS_TIMEOUT env fails before any provider request", async () => {
  const recorder = await startRequestRecorder();
  const previousTimeout = process.env.TWO_BROTHERS_TIMEOUT;
  try {
    process.env.TWO_BROTHERS_TIMEOUT = "abc";
    const io = makeIO();
    await assert.rejects(
      main(OPENAI_ARGS(recorder.port), io),
      /invalid timeout: abc \(use a non-negative integer of seconds; --timeout <s> \/ TWO_BROTHERS_TIMEOUT\)/,
    );
    assert.equal(recorder.requests(), 0, "no provider attempt may occur on invalid config");
    assert.deepEqual(io.out, [], "no diagnostic may leak onto stdout");
  } finally {
    if (previousTimeout === undefined) delete process.env.TWO_BROTHERS_TIMEOUT;
    else process.env.TWO_BROTHERS_TIMEOUT = previousTimeout;
    recorder.server.closeAllConnections();
    await new Promise<void>((resolve) => recorder.server.close(() => resolve()));
  }
});