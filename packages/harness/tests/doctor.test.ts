/**
 * Doctor diagnostics tests: `src/doctor.ts`.
 *
 * Pure and hermetic — every test roots the options in a temp directory, the
 * transport is a fake `fetchImpl` (no endpoint is ever contacted) and the
 * clock is injected where latency is asserted. Run with:
 * node tests/run-all.ts  (or node --test tests/, or node tests/doctor.test.ts)
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { DEFAULTS, type Config } from "../src/config.ts";
import {
  DEFAULT_DOCTOR_TIMEOUT_MS,
  formatDoctorReport,
  NODE_ENGINE_FLOOR,
  nodeEngineProblem,
  runDoctor,
  type DoctorCheck,
  type DoctorOptions,
  type DoctorReport,
} from "../src/doctor.ts";
import type { FetchLike } from "../src/provider.ts";
import {
  TUI_KEYS_DIAGNOSTIC_MAX_CHARS,
  TUI_KEYS_MAX_BYTES,
} from "../src/tui/keyoverrides.ts";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** A complete `Config` literal (never `resolveConfig`: env must not leak in). */
function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    ...DEFAULTS,
    seniorSystem: "senior prompt",
    juniorSystem: "junior prompt",
    ...overrides,
  };
}

async function withTempDir(fn: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-doctor-"));
  try {
    await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeFileAt(filePath: string, text: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, "utf-8");
}

/**
 * Options rooted in `dir`. Defaults are the "empty environment" case: no
 * sessions dir, no settings file, no web build, no plugins — and the mock
 * provider, so no endpoint is contacted. The TUI keys default resolves under
 * the temp `home` and the history override points at a temp path, so the real
 * home directory is never read.
 */
function baseOptions(dir: string, overrides: Partial<DoctorOptions> = {}): DoctorOptions {
  return {
    config: makeConfig({ provider: "mock" }),
    cwd: dir,
    sessionsDir: path.join(dir, "sessions"),
    settingsPath: path.join(dir, "settings.json"),
    webRoots: [path.join(dir, "web")],
    home: path.join(dir, "home"),
    env: envFor(dir),
    ...overrides,
  };
}

/** Hermetic env for the TUI file checks: a temp history path, plus overrides. */
function envFor(dir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    TWO_BROTHERS_TUI_HISTORY_FILE: path.join(dir, "tui-history.json"),
    ...extra,
  };
}

function requireCheck(report: DoctorReport, id: string): DoctorCheck {
  const found = report.checks.find((check) => check.id === id);
  if (!found) throw new Error(`missing "${id}" check: ${report.checks.map((c) => c.id).join(",")}`);
  return found;
}

interface FetchCall {
  url: string;
  init: RequestInit;
}

/** Records every call; the handler's return value (or throw) becomes the response. */
function fakeFetch(handler: (call: FetchCall) => Response | Promise<Response>): {
  fetchImpl: FetchLike;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  return {
    calls,
    fetchImpl: (url, init) => {
      const call = { url, init };
      calls.push(call);
      return Promise.resolve().then(() => handler(call));
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function modelsResponse(...ids: string[]): Response {
  return jsonResponse({ data: ids.map((id) => ({ id, owned_by: "test" })) });
}

/** A deterministic latency clock (epoch-ms reads in order). */
function fakeClock(...values: number[]): () => number {
  const queue = [...values];
  return () => (queue.length > 0 ? (queue.shift() as number) : Date.now());
}

/** A configured OpenAI-compatible config that the endpoint probe can reach. */
function openaiConfig(overrides: Partial<Config> = {}): Config {
  return makeConfig({
    provider: "openai",
    baseUrl: "http://127.0.0.1:9/v1",
    seniorModel: "senior-model",
    juniorModel: "junior-model",
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// engine
// ---------------------------------------------------------------------------

test("engine check passes on the running Node and renders the documented line", async () => {
  await withTempDir(async (dir) => {
    const report = await runDoctor(baseOptions(dir));
    const engine = requireCheck(report, "engine");
    assert.equal(engine.label, "Node engine");
    assert.equal(engine.status, "pass");
    assert.equal(engine.detail, `v${process.versions.node}`);
    const lines = formatDoctorReport(report);
    const index = report.checks.findIndex((check) => check.id === "engine");
    assert.equal(lines[index], `[pass] Node engine — v${process.versions.node}`);
    assert.equal(report.ok, true, "the empty mock environment has no fail check");
  });
});

test("nodeEngineProblem enforces the >= 22.19 engines floor", () => {
  assert.equal(NODE_ENGINE_FLOOR, "22.19");
  assert.equal(nodeEngineProblem("22.19.0"), null);
  assert.equal(nodeEngineProblem("v22.19.0"), null);
  assert.equal(nodeEngineProblem("23.0.0"), null);
  assert.equal(nodeEngineProblem("24.1.0"), null);
  assert.match(nodeEngineProblem("22.18.9") ?? "", /below the required >= 22\.19/);
  assert.match(nodeEngineProblem("20.11.0") ?? "", /below the required >= 22\.19/);
  assert.match(nodeEngineProblem("nonsense") ?? "", /cannot parse/);
  assert.equal(DEFAULT_DOCTOR_TIMEOUT_MS, 5000);
});

// ---------------------------------------------------------------------------
// report shape: deterministic order and ok semantics
// ---------------------------------------------------------------------------

test("report lists every check in deterministic order and is stable across runs", async () => {
  await withTempDir(async (dir) => {
    const options = baseOptions(dir);
    const first = await runDoctor(options);
    assert.deepEqual(
      first.checks.map((check) => check.id),
      [
        "engine",
        "settings",
        "sessions-dir",
        "roles",
        "endpoint",
        "web-assets",
        "plugins",
        "tui-keys",
        "tui-history",
      ],
    );
    for (const check of first.checks) {
      assert.ok(
        ["pass", "warn", "fail", "skip"].includes(check.status),
        `unexpected status ${check.status}`,
      );
      assert.ok(check.label.length > 0, "every check has a label");
    }
    const second = await runDoctor(options);
    assert.deepEqual(second, first, "same inputs -> identical report");
    assert.equal(first.ok, !first.checks.some((check) => check.status === "fail"));
  });
});

test("ok is false exactly when a check fails", async () => {
  await withTempDir(async (dir) => {
    const missingModels = await runDoctor(
      baseOptions(dir, {
        config: openaiConfig({ seniorModel: "", juniorModel: "" }),
        fetchImpl: fakeFetch(() => modelsResponse("other-model")).fetchImpl,
      }),
    );
    // Both role models missing -> roles warns (not fails), endpoint warns.
    assert.equal(missingModels.ok, true);

    const failed = await runDoctor(
      baseOptions(dir, {
        config: openaiConfig({ seniorModel: "wanted", juniorModel: "wanted-2" }),
        fetchImpl: fakeFetch(() => modelsResponse("other-model")).fetchImpl,
      }),
    );
    assert.equal(requireCheck(failed, "endpoint").status, "fail");
    assert.equal(failed.ok, false);
  });
});

// ---------------------------------------------------------------------------
// mock provider
// ---------------------------------------------------------------------------

test("mock provider passes roles and skips the endpoint", async () => {
  await withTempDir(async (dir) => {
    const fetchImpl = fakeFetch(() => modelsResponse("never-called"));
    const report = await runDoctor(baseOptions(dir, { fetchImpl: fetchImpl.fetchImpl }));
    const roles = requireCheck(report, "roles");
    assert.equal(roles.status, "pass");
    assert.match(roles.detail ?? "", /provider mock/);
    const endpoint = requireCheck(report, "endpoint");
    assert.equal(endpoint.status, "skip");
    assert.match(endpoint.detail ?? "", /no endpoint is contacted/);
    assert.equal(fetchImpl.calls.length, 0, "mock must not touch the network");
    assert.equal(report.ok, true);
  });
});

// ---------------------------------------------------------------------------
// roles
// ---------------------------------------------------------------------------

test("roles check fails on a missing base URL and warns on a missing model", async () => {
  await withTempDir(async (dir) => {
    const noBase = await runDoctor(
      baseOptions(dir, {
        config: makeConfig({ provider: "openai", baseUrl: "", seniorModel: "a", juniorModel: "b" }),
      }),
    );
    const roles = requireCheck(noBase, "roles");
    assert.equal(roles.status, "fail");
    assert.match(roles.detail ?? "", /no senior base URL/);
    assert.match(roles.detail ?? "", /--base-url/);
    assert.equal(requireCheck(noBase, "endpoint").status, "skip");

    const noModels = await runDoctor(
      baseOptions(dir, {
        config: openaiConfig({ seniorModel: "", juniorModel: "" }),
        fetchImpl: fakeFetch(() => modelsResponse("some-model")).fetchImpl,
      }),
    );
    const warnRoles = requireCheck(noModels, "roles");
    assert.equal(warnRoles.status, "warn");
    assert.match(warnRoles.detail ?? "", /no senior model/);
    assert.match(warnRoles.detail ?? "", /no junior model/);
    // The models are missing, so no model can be verified against the endpoint.
    assert.equal(requireCheck(noModels, "endpoint").status, "warn");
  });
});

test("roles check reports unknown provider kinds and providers", async () => {
  await withTempDir(async (dir) => {
    const badKind = await runDoctor(
      baseOptions(dir, {
        config: openaiConfig({ seniorKind: "not-a-kind" }),
        fetchImpl: fakeFetch(() => modelsResponse("senior-model", "junior-model")).fetchImpl,
      }),
    );
    const kindCheck = requireCheck(badKind, "roles");
    assert.equal(kindCheck.status, "fail");
    assert.match(kindCheck.detail ?? "", /unknown senior provider kind/);

    const badProvider = await runDoctor(
      baseOptions(dir, { config: makeConfig({ provider: "bogus" }) }),
    );
    assert.match(requireCheck(badProvider, "roles").detail ?? "", /unknown provider "bogus"/);
    assert.equal(requireCheck(badProvider, "endpoint").status, "skip");
  });
});

// ---------------------------------------------------------------------------
// endpoint: success, auth, shapes
// ---------------------------------------------------------------------------

test("endpoint probes GET {baseUrl}/models and matches models case-insensitively", async () => {
  await withTempDir(async (dir) => {
    const stub = fakeFetch(() =>
      jsonResponse({ data: [{ id: "GPT-4O" }, { id: "gpt-4o-mini", owned_by: "test" }] }),
    );
    const report = await runDoctor(
      baseOptions(dir, {
        config: openaiConfig({
          baseUrl: "http://127.0.0.1:9/v1/",
          seniorModel: "gpt-4o",
          juniorModel: "GPT-4O-MINI",
        }),
        fetchImpl: stub.fetchImpl,
        now: fakeClock(1000, 1042),
      }),
    );
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].url, "http://127.0.0.1:9/v1/models", "trailing slash trimmed");
    assert.equal(stub.calls[0].init.method, "GET");
    const headers = stub.calls[0].init.headers as Record<string, string>;
    assert.equal(headers.Accept, "application/json");
    assert.equal(headers.Authorization, undefined, "no key -> no Authorization header");

    const endpoint = requireCheck(report, "endpoint");
    assert.equal(endpoint.status, "pass");
    assert.match(endpoint.detail ?? "", /2 models, 42 ms/);
    assert.match(endpoint.detail ?? "", /senior "gpt-4o"/);
    assert.match(endpoint.detail ?? "", /junior "GPT-4O-MINI"/);
    assert.equal(report.ok, true);
  });
});

test("tolerant payload shapes: bare array, {data} and {models}", async () => {
  await withTempDir(async (dir) => {
    const payloads: unknown[] = [
      [{ id: "m1" }, { id: "m2" }],
      { data: [{ id: "m1" }, { id: "m2" }] },
      { models: [{ id: "m1" }, { id: "m2" }] },
      { data: ["m1", "m2"] },
    ];
    for (const payload of payloads) {
      const report = await runDoctor(
        baseOptions(dir, {
          config: openaiConfig({ seniorModel: "m1", juniorModel: "m2" }),
          fetchImpl: fakeFetch(() => jsonResponse(payload)).fetchImpl,
        }),
      );
      assert.equal(
        requireCheck(report, "endpoint").status,
        "pass",
        `payload shape ${JSON.stringify(payload)}`,
      );
    }
  });
});

test("endpoint sends Bearer auth only when a key is set and never renders it", async () => {
  await withTempDir(async (dir) => {
    const secret = "sk-doctor-super-secret";
    const stub = fakeFetch(() => modelsResponse("senior-model", "junior-model"));
    const report = await runDoctor(
      baseOptions(dir, {
        config: openaiConfig({ apiKey: secret }),
        fetchImpl: stub.fetchImpl,
      }),
    );
    const headers = stub.calls[0].init.headers as Record<string, string>;
    assert.equal(headers.Authorization, `Bearer ${secret}`);

    const roles = requireCheck(report, "roles");
    assert.equal(roles.status, "pass");
    assert.match(roles.detail ?? "", /key set/);
    const rendered = JSON.stringify(report) + "\n" + formatDoctorReport(report).join("\n");
    assert.ok(!rendered.includes(secret), "the API key must never appear in the report");
  });
});

test("per-role keys report set/not-set state without printing them", async () => {
  await withTempDir(async (dir) => {
    const seniorKey = "sk-senior-only";
    const stub = fakeFetch(() => modelsResponse("senior-model", "junior-model"));
    const report = await runDoctor(
      baseOptions(dir, {
        config: openaiConfig({ seniorApiKey: seniorKey }),
        fetchImpl: stub.fetchImpl,
      }),
    );
    const detail = requireCheck(report, "roles").detail ?? "";
    assert.match(detail, /senior: .*key set/);
    assert.match(detail, /junior: .*key not set/);
    assert.ok(!JSON.stringify(report).includes(seniorKey));
  });
});

test("endpoint falls back to a role base URL when the shared one is empty", async () => {
  await withTempDir(async (dir) => {
    const stub = fakeFetch(() => modelsResponse("senior-model", "junior-model"));
    const baseUrl = "http://127.0.0.1:9/v1";
    const report = await runDoctor(
      baseOptions(dir, {
        config: openaiConfig({
          baseUrl: "",
          seniorBaseUrl: baseUrl,
          seniorApiKey: "sk-role-key",
          juniorBaseUrl: baseUrl,
        }),
        fetchImpl: stub.fetchImpl,
      }),
    );
    assert.equal(stub.calls[0].url, `${baseUrl}/models`);
    const headers = stub.calls[0].init.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer sk-role-key");
    assert.equal(requireCheck(report, "endpoint").status, "pass");
  });
});

// ---------------------------------------------------------------------------
// endpoint: failures and degradations
// ---------------------------------------------------------------------------

test("unreachable endpoint fails with an actionable hint and no transport message", async () => {
  await withTempDir(async (dir) => {
    const secret = "sk-should-not-surface";
    const stub = fakeFetch(() => {
      throw new TypeError(`fetch failed with ${secret}`);
    });
    const report = await runDoctor(
      baseOptions(dir, { config: openaiConfig(), fetchImpl: stub.fetchImpl }),
    );
    const endpoint = requireCheck(report, "endpoint");
    assert.equal(endpoint.status, "fail");
    assert.match(endpoint.detail ?? "", /cannot reach .*\/models/);
    assert.match(endpoint.detail ?? "", /check the base URL/);
    assert.ok(!JSON.stringify(report).includes(secret), "transport text is not echoed");
    assert.equal(report.ok, false);
  });
});

test("hung endpoint is bounded by timeoutMs", async () => {
  await withTempDir(async (dir) => {
    const hanging: FetchLike = async (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init.signal;
        if (signal) {
          signal.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted", "AbortError")),
          );
        }
      });
    const started = Date.now();
    const report = await runDoctor(
      baseOptions(dir, { config: openaiConfig(), fetchImpl: hanging, timeoutMs: 20 }),
    );
    const elapsed = Date.now() - started;
    const endpoint = requireCheck(report, "endpoint");
    assert.equal(endpoint.status, "fail");
    assert.match(endpoint.detail ?? "", /timed out after 20 ms/);
    assert.ok(elapsed < 2000, `probe took ${elapsed} ms`);
    assert.equal(report.ok, false);
  });
});

test("a stalled response body is still bounded by timeoutMs", async () => {
  await withTempDir(async (dir) => {
    const stalled: FetchLike = async () =>
      new Response(new ReadableStream({ start: () => undefined }), { status: 200 });
    const report = await runDoctor(
      baseOptions(dir, { config: openaiConfig(), fetchImpl: stalled, timeoutMs: 20 }),
    );
    const endpoint = requireCheck(report, "endpoint");
    assert.equal(endpoint.status, "fail");
    assert.match(endpoint.detail ?? "", /timed out after 20 ms/);
    assert.equal(report.ok, false);
  });
});

test("HTTP errors fail with a status-specific hint", async () => {
  await withTempDir(async (dir) => {
    const cases: Array<[number, RegExp]> = [
      [401, /check the API key/],
      [403, /check the API key/],
      [404, /check the base URL path/],
      [429, /rate limited/],
      [503, /provider is unavailable/],
    ];
    for (const [status, hint] of cases) {
      const report = await runDoctor(
        baseOptions(dir, {
          config: openaiConfig(),
          fetchImpl: fakeFetch(() => new Response("nope", { status })).fetchImpl,
        }),
      );
      const endpoint = requireCheck(report, "endpoint");
      assert.equal(endpoint.status, "fail", `HTTP ${status}`);
      assert.match(endpoint.detail ?? "", new RegExp(`HTTP ${status}`));
      assert.match(endpoint.detail ?? "", hint);
    }
  });
});

test("non-JSON and unexpected payloads degrade to a warn (endpoint reachable)", async () => {
  await withTempDir(async (dir) => {
    const nonJson = await runDoctor(
      baseOptions(dir, {
        config: openaiConfig(),
        fetchImpl: fakeFetch(() => new Response("not json", { status: 200 })).fetchImpl,
      }),
    );
    const nonJsonCheck = requireCheck(nonJson, "endpoint");
    assert.equal(nonJsonCheck.status, "warn");
    assert.match(nonJsonCheck.detail ?? "", /non-JSON/);
    assert.equal(nonJson.ok, true);

    const unexpected = await runDoctor(
      baseOptions(dir, {
        config: openaiConfig(),
        fetchImpl: fakeFetch(() => jsonResponse({ foo: "bar" })).fetchImpl,
      }),
    );
    assert.match(requireCheck(unexpected, "endpoint").detail ?? "", /unexpected shape/);
  });
});

test("model presence: one missing warns, all missing fails, empty list warns", async () => {
  await withTempDir(async (dir) => {
    const oneMissing = await runDoctor(
      baseOptions(dir, {
        config: openaiConfig({ seniorModel: "senior-model", juniorModel: "absent-model" }),
        fetchImpl: fakeFetch(() => modelsResponse("senior-model")).fetchImpl,
      }),
    );
    const warnEndpoint = requireCheck(oneMissing, "endpoint");
    assert.equal(warnEndpoint.status, "warn");
    assert.match(warnEndpoint.detail ?? "", /junior "absent-model" not reported/);
    assert.match(warnEndpoint.detail ?? "", /two-brothers models --base-url/);
    assert.equal(oneMissing.ok, true);

    const allMissing = await runDoctor(
      baseOptions(dir, {
        config: openaiConfig({ seniorModel: "a", juniorModel: "b" }),
        fetchImpl: fakeFetch(() => modelsResponse("c")).fetchImpl,
      }),
    );
    const failEndpoint = requireCheck(allMissing, "endpoint");
    assert.equal(failEndpoint.status, "fail");
    assert.match(failEndpoint.detail ?? "", /none of the configured models reported/);
    assert.equal(allMissing.ok, false);

    const empty = await runDoctor(
      baseOptions(dir, {
        config: openaiConfig(),
        fetchImpl: fakeFetch(() => modelsResponse()).fetchImpl,
      }),
    );
    assert.match(requireCheck(empty, "endpoint").detail ?? "", /reported no models/);
  });
});

// ---------------------------------------------------------------------------
// settings file
// ---------------------------------------------------------------------------

test("settings check: missing warns, valid JSON passes, unparseable fails", async () => {
  await withTempDir(async (dir) => {
    const missing = await runDoctor(baseOptions(dir));
    const missingCheck = requireCheck(missing, "settings");
    assert.equal(missingCheck.status, "warn");
    assert.match(missingCheck.detail ?? "", /not found/);
    assert.match(missingCheck.detail ?? "", /created/);

    const settingsPath = path.join(dir, "sessions", "settings.json");
    writeFileAt(settingsPath, JSON.stringify({ senior: { provider: "openai" }, plugins: [] }));
    const valid = await runDoctor(baseOptions(dir, { settingsPath }));
    const validCheck = requireCheck(valid, "settings");
    assert.equal(validCheck.status, "pass");
    assert.match(validCheck.detail ?? "", /valid JSON/);

    const secretFragment = '{"api_key": "sk-leaky-fragment';
    writeFileAt(settingsPath, secretFragment);
    const invalid = await runDoctor(baseOptions(dir, { settingsPath }));
    const invalidCheck = requireCheck(invalid, "settings");
    assert.equal(invalidCheck.status, "fail");
    assert.match(invalidCheck.detail ?? "", /not valid JSON/);
    assert.ok(
      !JSON.stringify(invalid).includes("sk-leaky-fragment"),
      "the parser message (which can quote file bytes) is never rendered",
    );
    assert.equal(invalid.ok, false);

    writeFileAt(settingsPath, "[1,2,3]");
    const nonObject = await runDoctor(baseOptions(dir, { settingsPath }));
    const nonObjectCheck = requireCheck(nonObject, "settings");
    assert.equal(nonObjectCheck.status, "warn");
    assert.match(nonObjectCheck.detail ?? "", /not a JSON object/);
  });
});

// ---------------------------------------------------------------------------
// sessions directory
// ---------------------------------------------------------------------------

test("sessions dir check: missing warns without creating it, existing dir passes cleanly", async () => {
  await withTempDir(async (dir) => {
    const sessionsDir = path.join(dir, "sessions");
    const missing = await runDoctor(baseOptions(dir, { sessionsDir }));
    const missingCheck = requireCheck(missing, "sessions-dir");
    assert.equal(missingCheck.status, "warn");
    assert.match(missingCheck.detail ?? "", /not found/);
    assert.match(missingCheck.detail ?? "", /will be created/);
    assert.equal(fs.existsSync(sessionsDir), false, "doctor must not create the sessions dir");

    fs.mkdirSync(sessionsDir, { recursive: true });
    const writable = await runDoctor(baseOptions(dir, { sessionsDir }));
    const writableCheck = requireCheck(writable, "sessions-dir");
    assert.equal(writableCheck.status, "pass");
    assert.match(writableCheck.detail ?? "", /writable/);
    assert.deepEqual(
      fs.readdirSync(sessionsDir).filter((name) => name.startsWith(".doctor-")),
      [],
      "the write probe is removed",
    );

    const notADir = path.join(dir, "sessions-file");
    writeFileAt(notADir, "not a directory");
    const failed = await runDoctor(baseOptions(dir, { sessionsDir: notADir }));
    const failedCheck = requireCheck(failed, "sessions-dir");
    assert.equal(failedCheck.status, "fail");
    assert.match(failedCheck.detail ?? "", /not a directory/);
    assert.equal(failed.ok, false);
  });
});

// ---------------------------------------------------------------------------
// web assets
// ---------------------------------------------------------------------------

test("web assets: any candidate index.html passes, none warns", async () => {
  await withTempDir(async (dir) => {
    const empty = await runDoctor(baseOptions(dir));
    const emptyCheck = requireCheck(empty, "web-assets");
    assert.equal(emptyCheck.status, "warn");
    assert.match(emptyCheck.detail ?? "", /no index.html/);
    assert.equal(empty.ok, true, "a missing optional web build does not fail the report");

    const webRoot = path.join(dir, "dist-web");
    writeFileAt(path.join(webRoot, "index.html"), "<!doctype html>");
    const found = await runDoctor(baseOptions(dir, { webRoots: [path.join(dir, "nope"), webRoot] }));
    const foundCheck = requireCheck(found, "web-assets");
    assert.equal(foundCheck.status, "pass");
    assert.match(foundCheck.detail ?? "", /found:/);
    assert.ok((foundCheck.detail ?? "").includes(webRoot), "the matching root is named");

    const noRoots = await runDoctor(baseOptions(dir, { webRoots: [] }));
    assert.match(requireCheck(noRoots, "web-assets").detail ?? "", /no web asset roots/);
  });
});

test("web assets default to the packaged/repo candidates without throwing", async () => {
  await withTempDir(async (dir) => {
    const report = await runDoctor({
      config: makeConfig({ provider: "mock" }),
      cwd: dir,
      sessionsDir: path.join(dir, "sessions"),
      settingsPath: path.join(dir, "settings.json"),
      // no webRoots: the default candidates are resolved from the module location
    });
    const web = requireCheck(report, "web-assets");
    assert.ok(["pass", "warn"].includes(web.status));
    assert.equal(report.checks.length, 9);
  });
});

// ---------------------------------------------------------------------------
// plugins
// ---------------------------------------------------------------------------

test("plugins dir: existing passes, missing warns (optional)", async () => {
  await withTempDir(async (dir) => {
    const missing = await runDoctor(baseOptions(dir));
    const missingCheck = requireCheck(missing, "plugins");
    assert.equal(missingCheck.status, "warn");
    assert.match(missingCheck.detail ?? "", /not found/);
    assert.match(missingCheck.detail ?? "", /optional/);

    const pluginsDir = path.join(dir, "plugins");
    fs.mkdirSync(pluginsDir, { recursive: true });
    const found = await runDoctor(baseOptions(dir));
    const foundCheck = requireCheck(found, "plugins");
    assert.equal(foundCheck.status, "pass");
    assert.match(foundCheck.detail ?? "", /found:/);
  });
});

// ---------------------------------------------------------------------------
// TUI keys file
// ---------------------------------------------------------------------------

test("tui-keys: a missing default file passes with 'defaults active' (no warn)", async () => {
  await withTempDir(async (dir) => {
    const report = await runDoctor(baseOptions(dir));
    const check = requireCheck(report, "tui-keys");
    assert.equal(check.label, "TUI keys file");
    assert.equal(check.status, "pass");
    assert.match(check.detail ?? "", /defaults active/);
    assert.ok(
      (check.detail ?? "").includes(path.join(dir, "home", ".two-brothers", "tui-keys.json")),
      "the default path is the TUI default under the injected home",
    );
    assert.equal(report.ok, true);
  });
});

test("tui-keys: an env-named missing file warns (a typo is not silent)", async () => {
  await withTempDir(async (dir) => {
    const keysPath = path.join(dir, "chosen-keys.json");
    const report = await runDoctor(
      baseOptions(dir, { env: envFor(dir, { TWO_BROTHERS_TUI_KEYS_FILE: keysPath }) }),
    );
    const check = requireCheck(report, "tui-keys");
    assert.equal(check.status, "warn");
    assert.match(check.detail ?? "", /file not found/);
    assert.ok((check.detail ?? "").includes(keysPath), "the explicitly named path is reported");
    assert.equal(report.ok, true, "a warn does not fail the report");
  });
});

test("tui-keys: a valid file passes with the effective chord summary", async () => {
  await withTempDir(async (dir) => {
    const keysPath = path.join(dir, "keys.json");
    writeFileAt(
      keysPath,
      JSON.stringify({
        version: 1,
        bindings: { palette: ["ctrl+g"], help: ["f2"], stash: ["ctrl+u"] },
      }),
    );
    const report = await runDoctor(
      baseOptions(dir, { env: envFor(dir, { TWO_BROTHERS_TUI_KEYS_FILE: keysPath }) }),
    );
    const check = requireCheck(report, "tui-keys");
    assert.equal(check.status, "pass");
    assert.ok((check.detail ?? "").includes(keysPath));
    assert.match(check.detail ?? "", /palette Ctrl\+G/);
    assert.match(check.detail ?? "", /help F2/);
    assert.match(check.detail ?? "", /stash Ctrl\+U/);
    const line = formatDoctorReport(report).find((text) => text.startsWith("[pass] TUI keys file"));
    assert.match(line ?? "", / — .*palette Ctrl\+G/);
  });
});

test("tui-keys: invalid JSON warns with only one bounded diagnostic and no file body", async () => {
  await withTempDir(async (dir) => {
    // A bare token is a syntax error V8's own message would quote back
    // (`Unexpected token … "MARKER-NOT-FOR-OUTPUT" is not valid JSON`).
    const keysPath = path.join(dir, "broken-keys.json");
    writeFileAt(keysPath, "MARKER-NOT-FOR-OUTPUT sk-never-render");
    const report = await runDoctor(
      baseOptions(dir, { env: envFor(dir, { TWO_BROTHERS_TUI_KEYS_FILE: keysPath }) }),
    );
    const check = requireCheck(report, "tui-keys");
    assert.equal(check.status, "warn");
    assert.match(check.detail ?? "", /invalid JSON/);
    assert.ok(
      (check.detail ?? "").length <= TUI_KEYS_DIAGNOSTIC_MAX_CHARS,
      `diagnostic is bounded (${(check.detail ?? "").length} chars)`,
    );
    assert.ok(!(check.detail ?? "").includes("MARKER-NOT-FOR-OUTPUT"), "file contents are not echoed");
    assert.ok(!(check.detail ?? "").includes("Unexpected token"), "the parser message is not echoed");
    assert.equal(report.ok, true);
  });
});

test("tui-keys: a wrong version and an oversized file warn", async () => {
  await withTempDir(async (dir) => {
    const keysPath = path.join(dir, "wrong-version.json");
    const secret = "sk-never-render-this-value";
    writeFileAt(keysPath, JSON.stringify({ version: 2, note: secret, bindings: {} }));
    const wrongVersion = await runDoctor(
      baseOptions(dir, { env: envFor(dir, { TWO_BROTHERS_TUI_KEYS_FILE: keysPath }) }),
    );
    const versionCheck = requireCheck(wrongVersion, "tui-keys");
    assert.equal(versionCheck.status, "warn");
    assert.match(versionCheck.detail ?? "", /unsupported version \(expected 1\)/);
    assert.ok(!(versionCheck.detail ?? "").includes("version 2"), "the file's version value is not echoed");
    assert.ok(!(versionCheck.detail ?? "").includes(secret), "unrelated file fields are not echoed");

    const oversizedPath = path.join(dir, "oversized-keys.json");
    writeFileAt(oversizedPath, "x".repeat(TUI_KEYS_MAX_BYTES + 1));
    const oversized = await runDoctor(
      baseOptions(dir, { env: envFor(dir, { TWO_BROTHERS_TUI_KEYS_FILE: oversizedPath }) }),
    );
    const sizeCheck = requireCheck(oversized, "tui-keys");
    assert.equal(sizeCheck.status, "warn");
    assert.match(sizeCheck.detail ?? "", /max 16384/);
    assert.ok(!(sizeCheck.detail ?? "").includes("xxxxxxxxxx"), "the body is never printed");
    assert.ok((sizeCheck.detail ?? "").length <= TUI_KEYS_DIAGNOSTIC_MAX_CHARS);
  });
});

// ---------------------------------------------------------------------------
// TUI history file
// ---------------------------------------------------------------------------

test("tui-history: a missing file passes informationally (history is optional)", async () => {
  await withTempDir(async (dir) => {
    const report = await runDoctor(baseOptions(dir));
    const check = requireCheck(report, "tui-history");
    assert.equal(check.label, "TUI history file");
    assert.equal(check.status, "pass");
    assert.match(check.detail ?? "", /not found/);
    assert.match(check.detail ?? "", /optional/);
    assert.ok((check.detail ?? "").includes(path.join(dir, "tui-history.json")));
    assert.equal(report.ok, true);
  });
});

test("tui-history: a readable file passes with its effective entry count", async () => {
  await withTempDir(async (dir) => {
    const historyPath = path.join(dir, "tui-history.json");
    writeFileAt(
      historyPath,
      JSON.stringify({ version: 1, entries: ["first task", "second task", "second task"] }),
    );
    const report = await runDoctor(baseOptions(dir));
    const check = requireCheck(report, "tui-history");
    assert.equal(check.status, "pass");
    assert.match(check.detail ?? "", /2 entries/, "consecutive duplicates collapse like the store");
    assert.ok((check.detail ?? "").includes(historyPath));

    writeFileAt(historyPath, JSON.stringify({ version: 1, entries: ["only task"] }));
    const single = requireCheck(await runDoctor(baseOptions(dir)), "tui-history");
    assert.match(single.detail ?? "", /1 entry\b/, "singular wording for one entry");
  });
});

test("tui-history: the injected home supplies the default path when no env override is set", async () => {
  await withTempDir(async (dir) => {
    const defaultPath = path.join(dir, "home", ".two-brothers", "tui-history.json");
    writeFileAt(defaultPath, JSON.stringify({ version: 1, entries: ["home task", "home task 2"] }));
    // No TWO_BROTHERS_TUI_HISTORY_FILE: the default must come from `home`,
    // never from the real user home.
    const report = await runDoctor(baseOptions(dir, { env: {} }));
    const check = requireCheck(report, "tui-history");
    assert.equal(check.status, "pass");
    assert.ok((check.detail ?? "").includes(defaultPath), check.detail ?? "");
    assert.match(check.detail ?? "", /2 entries/);
  });
});

test("tui-history: corrupt, wrong-version and unreadable files warn without contents", async () => {
  await withTempDir(async (dir) => {
    const historyPath = path.join(dir, "tui-history.json");
    const secret = "sk-history-never-render";

    writeFileAt(historyPath, '{"version":1,"entries":["MARKER-HISTORY-CONTENT');
    const corrupt = requireCheck(await runDoctor(baseOptions(dir)), "tui-history");
    assert.equal(corrupt.status, "warn");
    assert.match(corrupt.detail ?? "", /not valid JSON/);
    assert.ok(!(corrupt.detail ?? "").includes("MARKER-HISTORY-CONTENT"));

    writeFileAt(historyPath, JSON.stringify({ version: 9, note: secret, entries: [] }));
    const wrongVersion = requireCheck(await runDoctor(baseOptions(dir)), "tui-history");
    assert.equal(wrongVersion.status, "warn");
    assert.match(wrongVersion.detail ?? "", /unsupported version \(expected 1\)/);
    assert.ok(!(wrongVersion.detail ?? "").includes(secret));

    writeFileAt(historyPath, JSON.stringify({ version: 1, entries: "not-an-array" }));
    const malformed = requireCheck(await runDoctor(baseOptions(dir)), "tui-history");
    assert.equal(malformed.status, "warn");
    assert.match(malformed.detail ?? "", /"entries" must be an array/);

    const directoryPath = path.join(dir, "history-dir");
    fs.mkdirSync(directoryPath, { recursive: true });
    const notAFile = requireCheck(
      await runDoctor(
        baseOptions(dir, { env: envFor(dir, { TWO_BROTHERS_TUI_HISTORY_FILE: directoryPath }) }),
      ),
      "tui-history",
    );
    assert.equal(notAFile.status, "warn");
    assert.match(notAFile.detail ?? "", /is not a file/);

    const stillOk = await runDoctor(baseOptions(dir));
    assert.equal(stillOk.ok, true, "warn never fails the report");
  });
});

// ---------------------------------------------------------------------------
// formatting and never-throw guarantees
// ---------------------------------------------------------------------------

test("formatDoctorReport renders stable [status] Label — detail lines", () => {
  const report: DoctorReport = {
    ok: false,
    checks: [
      { id: "engine", label: "Node engine", status: "pass", detail: "v22.19.0" },
      { id: "settings", label: "Settings file", status: "warn" },
      { id: "endpoint", label: "Provider endpoint", status: "fail", detail: "HTTP 401" },
      { id: "web-assets", label: "Web assets", status: "skip", detail: "not configured" },
    ],
  };
  assert.deepEqual(formatDoctorReport(report), [
    "[pass] Node engine — v22.19.0",
    "[warn] Settings file",
    "[fail] Provider endpoint — HTTP 401",
    "[skip] Web assets — not configured",
  ]);
  assert.deepEqual(formatDoctorReport({ ok: true, checks: [] }), []);
  assert.equal(formatDoctorReport(report).length, report.checks.length);
});

test("runDoctor never throws on partial or hostile input and still reports every check", async () => {
  await withTempDir(async (dir) => {
    const partial = await runDoctor({
      config: {} as Config,
      cwd: dir,
      sessionsDir: path.join(dir, "sessions"),
      settingsPath: path.join(dir, "settings.json"),
      webRoots: [],
    } as DoctorOptions);
    assert.equal(partial.checks.length, 9);
    assert.equal(partial.ok, false, "openai roles without a base URL fail");
    assert.match(requireCheck(partial, "roles").detail ?? "", /no senior base URL/);

    const noOptions = await runDoctor({ cwd: dir } as unknown as DoctorOptions);
    assert.equal(typeof noOptions.ok, "boolean");
    assert.equal(noOptions.checks.length, 9);

    const hostile = await runDoctor({
      config: makeConfig({ provider: "mock" }),
      cwd: dir,
      sessionsDir: path.join(dir, "sessions"),
      settingsPath: path.join(dir, "settings.json"),
      webRoots: ["", 42 as unknown as string, path.join(dir, "web")],
      timeoutMs: Number.NaN,
    } as unknown as DoctorOptions);
    assert.equal(hostile.checks.length, 9);
    assert.ok(hostile.checks.every((check) => typeof check.label === "string"));
  });
});

test("a throwing clock is contained and the endpoint check still completes", async () => {
  await withTempDir(async (dir) => {
    const report = await runDoctor(
      baseOptions(dir, {
        config: openaiConfig(),
        fetchImpl: fakeFetch(() => modelsResponse("senior-model", "junior-model")).fetchImpl,
        now: () => {
          throw new Error("clock exploded");
        },
      }),
    );
    assert.equal(requireCheck(report, "endpoint").status, "pass");
    assert.equal(report.ok, true);
  });
});
