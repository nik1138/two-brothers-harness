/**
 * resolveConfig: central validation of the provider retry/timeout knobs
 * (`--timeout` / `--retries` and their `TWO_BROTHERS_*` env counterparts).
 *
 * Background: a bare parseInt let "abc" become NaN — silently zero retries,
 * or an unclassifiable timeout — and an enormous retries value could
 * allocate a huge backoff array before the first request. These tests pin
 * the bounded validation: finite integer >= 0 for timeout (0 stays legal
 * for existing test seams), finite integer 0..MAX_CONFIG_RETRIES for
 * retries, with clear errors naming the flag and the env var.
 *
 * Hermetic and offline: env vars are set and restored per case; no network.
 * Run with: node --test tests/config.test.ts (or node tests/run-all.ts).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { MAX_CONFIG_RETRIES, resolveConfig } from "../src/config.ts";

/** Run `fn` with one env var set, restoring the previous value after. */
function withEnv<T>(name: string, value: string, fn: () => T): T {
  const previous = process.env[name];
  process.env[name] = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

test("defaults are unchanged (timeout 120, retries 6)", () => {
  const cfg = resolveConfig();
  assert.equal(cfg.timeout, 120);
  assert.equal(cfg.retries, 6);
  assert.equal(MAX_CONFIG_RETRIES, 32);
});

test("valid timeout values are accepted, including 0", () => {
  assert.equal(resolveConfig({ timeout: 0 }).timeout, 0);
  assert.equal(resolveConfig({ timeout: 1 }).timeout, 1);
  assert.equal(resolveConfig({ timeout: "900" }).timeout, 900);
  assert.equal(resolveConfig({ timeout: 3600 }).timeout, 3600);
  assert.equal(withEnv("TWO_BROTHERS_TIMEOUT", "0", () => resolveConfig().timeout), 0);
  assert.equal(withEnv("TWO_BROTHERS_TIMEOUT", "45", () => resolveConfig().timeout), 45);
});

test("valid retries values are accepted: 0, 1 and the cap", () => {
  assert.equal(resolveConfig({ retries: 0 }).retries, 0);
  assert.equal(resolveConfig({ retries: 1 }).retries, 1);
  assert.equal(resolveConfig({ retries: "2" }).retries, 2);
  assert.equal(resolveConfig({ retries: MAX_CONFIG_RETRIES }).retries, MAX_CONFIG_RETRIES);
  assert.equal(withEnv("TWO_BROTHERS_RETRIES", "0", () => resolveConfig().retries), 0);
  assert.equal(withEnv("TWO_BROTHERS_RETRIES", "6", () => resolveConfig().retries), 6);
  assert.equal(
    withEnv("TWO_BROTHERS_RETRIES", String(MAX_CONFIG_RETRIES), () => resolveConfig().retries),
    MAX_CONFIG_RETRIES,
  );
});

test("timeout rejects negative, NaN, fractional and non-finite values", () => {
  for (const bad of [-1, "abc", "1.5", "Infinity", ""]) {
    assert.throws(
      () => resolveConfig({ timeout: bad }),
      /invalid timeout: .*--timeout <s> \/ TWO_BROTHERS_TIMEOUT/,
      `timeout=${JSON.stringify(bad)} must be rejected naming the flag and env var`,
    );
  }
  assert.throws(
    () => withEnv("TWO_BROTHERS_TIMEOUT", "abc", () => resolveConfig()),
    /invalid timeout: abc \(use a non-negative integer of seconds; --timeout <s> \/ TWO_BROTHERS_TIMEOUT\)/,
  );
  assert.throws(
    () => withEnv("TWO_BROTHERS_TIMEOUT", "-3", () => resolveConfig()),
    /invalid timeout: -3 /,
  );
});

test("retries rejects negative, NaN, fractional and huge values", () => {
  for (const bad of [-1, "abc", "2.5", "Infinity"]) {
    assert.throws(
      () => resolveConfig({ retries: bad }),
      new RegExp(
        `invalid retries: .*integer from 0 to ${MAX_CONFIG_RETRIES}; ` +
          "--retries <n> / TWO_BROTHERS_RETRIES\\)",
      ),
      `retries=${JSON.stringify(bad)} must be rejected naming the flag and env var`,
    );
  }
  // Over the cap, as a flag and as an env var.
  assert.throws(
    () => resolveConfig({ retries: MAX_CONFIG_RETRIES + 1 }),
    new RegExp(`invalid retries: ${MAX_CONFIG_RETRIES + 1} `),
  );
  assert.throws(
    () => withEnv("TWO_BROTHERS_RETRIES", "1000000000", () => resolveConfig()),
    /invalid retries: 1000000000 /,
  );
  assert.throws(
    () => withEnv("TWO_BROTHERS_RETRIES", "abc", () => resolveConfig()),
    /invalid retries: abc /,
  );
});

test("a huge rejected env value renders a bounded error message", () => {
  const huge = "9".repeat(100) + "x"; // invalid spelling, 101 chars
  let message = "";
  try {
    withEnv("TWO_BROTHERS_RETRIES", huge, () => resolveConfig());
    assert.fail("expected resolveConfig to reject a huge retries value");
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert.match(message, /invalid retries: 9{48}…<clipped 101 chars>/);
  assert.ok(message.length < 200, `error message must stay bounded, got ${message.length} chars`);
});
