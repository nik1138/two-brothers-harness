/**
 * Stage 18 per-role endpoint tests. Ports the coverage of python
 * tests/test_s17_providers.py::ResolveEndpointTest and adds the TS-side
 * wiring checks:
 *
 * - `resolveRoleEndpoints` precedence: role env pair > shared env pair >
 *   named preset (provider_ref) > role manual fields; env pairs are
 *   all-or-nothing; a dangling provider_ref warns and falls back to the
 *   role manual fields (tolerant boundary, never fails).
 * - Harness provider construction: each role's provider is built from its
 *   own endpoint (distinct baseUrls/keys/models), empty endpoint fields
 *   fall back per field to the shared config.
 * - CLI flags: --senior-base-url/--senior-api-key/--junior-base-url/
 *   --junior-api-key parse like the other flags and pin like env vars
 *   (never persisted).
 *
 * Run with: node tests/run-all.ts (or node --test tests/)
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { resolveConfig, validateRunConfig, RunConfigError } from "../src/config.ts";
import { TwoBrothersHarness } from "../src/harness.ts";
import { AnthropicProvider, GoogleProvider, OpenAICompatibleProvider } from "../src/provider.ts";
import { resolveRoleEndpoints, type RuntimeSettingsSnapshot } from "../src/runtime.ts";
import { envPinnedPairs, SettingsStore } from "../src/settings_store.ts";
import { main, type CliIO } from "../src/cli.ts";

// ---------------------------------------------------------------------------
// resolver fixtures
// ---------------------------------------------------------------------------

const ACME = { name: "acme", base_url: "http://acme.example/v1", api_key: "acme-key" };

function snap(over: Partial<RuntimeSettingsSnapshot["senior"]> = {}): RuntimeSettingsSnapshot {
  return {
    senior: {
      provider: "",
      model: "",
      base_url: "http://manual-senior/v1",
      api_key: "manual-key",
      provider_ref: "",
      ...over,
    },
    junior: {
      provider: "",
      model: "",
      base_url: "http://manual-junior/v1",
      api_key: "manual-key",
      provider_ref: "",
    },
  };
}

const NO_ENV: NodeJS.ProcessEnv = {};

// ---------------------------------------------------------------------------
// resolveRoleEndpoints: precedence
// ---------------------------------------------------------------------------

test("resolver: preset beats manual fields", () => {
  const out = resolveRoleEndpoints(snap({ provider_ref: "acme" }), [ACME], NO_ENV);
  assert.equal(out.senior.baseUrl, ACME.base_url);
  assert.equal(out.senior.apiKey, ACME.api_key);
  assert.deepEqual(out.warnings, []);
});

test("resolver: manual fields when no provider_ref", () => {
  const out = resolveRoleEndpoints(snap(), [ACME], NO_ENV);
  assert.equal(out.junior.baseUrl, "http://manual-junior/v1");
  assert.equal(out.junior.apiKey, "manual-key");
});

test("resolver: dangling provider_ref warns and falls back to manual fields", () => {
  const out = resolveRoleEndpoints(snap({ provider_ref: "deleted" }), [ACME], NO_ENV);
  assert.equal(out.senior.baseUrl, "http://manual-senior/v1");
  assert.equal(out.senior.apiKey, "manual-key");
  assert.equal(out.warnings.length, 1);
  assert.match(out.warnings[0], /provider_ref "deleted"/);
  assert.match(out.warnings[0], /senior role/);
});

test("resolver: shared env pair beats preset and manual (all-or-nothing)", () => {
  const env = { TWO_BROTHERS_BASE_URL: "http://env/v1", TWO_BROTHERS_API_KEY: "env-key" };
  const out = resolveRoleEndpoints(snap({ provider_ref: "acme" }), [ACME], env);
  assert.equal(out.senior.baseUrl, "http://env/v1");
  assert.equal(out.senior.apiKey, "env-key");
  assert.equal(out.junior.baseUrl, "http://env/v1");
  assert.deepEqual(out.warnings, []);
  // only the key set: the pair still wins outright, with an empty base
  const keyOnly = { TWO_BROTHERS_API_KEY: "env-key" };
  const partial = resolveRoleEndpoints(snap({ provider_ref: "acme" }), [ACME], keyOnly);
  assert.deepEqual([partial.senior.baseUrl, partial.senior.apiKey], ["", "env-key"]);
});

test("resolver: role env pair beats shared env pair and preset", () => {
  const env = {
    TWO_BROTHERS_BASE_URL: "http://shared-env/v1",
    TWO_BROTHERS_API_KEY: "shared-env-key",
    TWO_BROTHERS_SENIOR_BASE_URL: "http://senior-env/v1",
    TWO_BROTHERS_SENIOR_API_KEY: "senior-env-key",
  };
  const out = resolveRoleEndpoints(snap({ provider_ref: "acme" }), [ACME], env);
  assert.deepEqual([out.senior.baseUrl, out.senior.apiKey], ["http://senior-env/v1", "senior-env-key"]);
  // junior has no role env pair: the shared pair wins over its preset/manual
  assert.deepEqual([out.junior.baseUrl, out.junior.apiKey], ["http://shared-env/v1", "shared-env-key"]);
});

test("resolver: provider/model fallbacks and the roleProviders switch", () => {
  const snapshot = snap({ provider: "mock", model: "role-model" });
  const out = resolveRoleEndpoints(snapshot, [], NO_ENV, {
    provider: "openai",
    seniorModel: "flag-senior",
    juniorModel: "flag-junior",
  });
  assert.equal(out.senior.provider, "mock"); // role settings win
  assert.equal(out.senior.model, "role-model");
  assert.equal(out.junior.provider, "openai"); // run-level fallback
  assert.equal(out.junior.model, "flag-junior");

  // a per-request provider override turns the role provider overlay off
  // (Python's apply(allow_provider=False))
  const forced = resolveRoleEndpoints(snapshot, [], NO_ENV, { provider: "mock" }, false);
  assert.equal(forced.senior.provider, "mock");
  assert.equal(forced.junior.provider, "mock");
});

test("resolver: connection fields gap-fill across roles, never provider/model", () => {
  // only the senior has a resolved URL: the junior inherits it (Python's
  // shared-config fallback), but never the senior's provider/model
  const snapshot = snap({ provider: "mock", model: "senior-m" });
  snapshot.junior = { provider: "", model: "", base_url: "", api_key: "", provider_ref: "" };
  const out = resolveRoleEndpoints(snapshot, [], NO_ENV, {
    provider: "openai",
    seniorModel: "",
    juniorModel: "",
  });
  assert.equal(out.senior.baseUrl, "http://manual-senior/v1");
  assert.equal(out.junior.baseUrl, "http://manual-senior/v1");
  assert.equal(out.junior.apiKey, "manual-key");
  assert.equal(out.senior.provider, "mock");
  assert.equal(out.junior.provider, "openai");
  assert.equal(out.junior.model, "");
});

// ---------------------------------------------------------------------------
// harness: per-role providers built from endpoints
// ---------------------------------------------------------------------------

interface RecordedRequest {
  url: string;
  authorization: string | null;
  body: Record<string, any>;
}

interface FakeEndpoint {
  baseUrl: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

/**
 * A recording OpenAI-compatible endpoint: answers chat/completions from a
 * canned script (one JSON payload per call; the last one repeats) and
 * records the request URL, Authorization header and parsed body.
 */
async function startFakeEndpoint(script: string[]): Promise<FakeEndpoint> {
  const requests: RecordedRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as Record<string, any>;
      requests.push({
        url: req.url ?? "",
        authorization: (req.headers.authorization as string | undefined) ?? null,
        body,
      });
      const content = script.length > 1 ? (script.shift() as string) : script[0];
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { content } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    requests,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

const PAYLOADS = {
  consult: JSON.stringify({ task: "t", ask: "a", expect: "proposal" }),
  proposal: JSON.stringify({ title: "P", answer: "A", confidence: 0.7 }),
  review: JSON.stringify({ verdict: "accept", notes: "ok" }),
  decision: JSON.stringify({ decision: "done", confidence: 0.8 }),
};

test("harness: senior and junior providers use their own endpoints", async () => {
  const seniorEp = await startFakeEndpoint([PAYLOADS.consult, PAYLOADS.review, PAYLOADS.decision]);
  const juniorEp = await startFakeEndpoint([PAYLOADS.proposal]);
  try {
    const cfg = resolveConfig({
      provider: "openai",
      baseUrl: "http://127.0.0.1:1/v1", // shared fallback, must NOT be contacted
      apiKey: "shared-key",
      seniorModel: "ignored-senior",
      juniorModel: "ignored-junior",
      retries: 0,
    });
    const harness = new TwoBrothersHarness(cfg, {
      endpoints: {
        senior: { provider: "openai", baseUrl: seniorEp.baseUrl, apiKey: "senior-key", model: "senior-model" },
        junior: { provider: "openai", baseUrl: juniorEp.baseUrl, apiKey: "junior-key", model: "junior-model" },
      },
    });
    assert.ok(harness.providers.senior instanceof OpenAICompatibleProvider);
    assert.ok(harness.providers.junior instanceof OpenAICompatibleProvider);
    assert.equal(
      (harness.providers.senior as OpenAICompatibleProvider).baseUrl,
      seniorEp.baseUrl.replace(/\/+$/, ""),
    );
    assert.equal(
      (harness.providers.junior as OpenAICompatibleProvider).baseUrl,
      juniorEp.baseUrl.replace(/\/+$/, ""),
    );

    const result = await harness.run("cooperate");
    assert.equal(result.errors.length, 0);
    assert.equal(String(result.decision.decision), "done");

    // each role talked to its own endpoint with its own key/model
    assert.equal(seniorEp.requests.length, 3); // consult, review, decision
    assert.equal(juniorEp.requests.length, 1); // proposal
    for (const req of seniorEp.requests) {
      assert.equal(req.body.model, "senior-model");
      assert.equal(req.authorization, "Bearer senior-key");
    }
    for (const req of juniorEp.requests) {
      assert.equal(req.body.model, "junior-model");
      assert.equal(req.authorization, "Bearer junior-key");
    }
  } finally {
    await seniorEp.close();
    await juniorEp.close();
  }
});

test("harness: endpoint fields fall back per field to the shared config", async () => {
  const seniorEp = await startFakeEndpoint([PAYLOADS.consult, PAYLOADS.review, PAYLOADS.decision]);
  const juniorEp = await startFakeEndpoint([PAYLOADS.proposal]);
  try {
    // junior endpoint leaves apiKey/model empty: the shared apiKey and the
    // role's shared juniorModel kick in (Python's per-field `or cfg` fallback)
    const cfg = resolveConfig({
      provider: "openai",
      baseUrl: juniorEp.baseUrl,
      apiKey: "shared-key",
      seniorModel: "senior-model",
      juniorModel: "junior-model",
      retries: 0,
    });
    const harness = new TwoBrothersHarness(cfg, {
      endpoints: {
        senior: { provider: "openai", baseUrl: seniorEp.baseUrl, apiKey: "", model: "" },
        junior: { provider: "openai", baseUrl: "", apiKey: "", model: "" },
      },
    });
    const result = await harness.run("cooperate");
    assert.equal(result.errors.length, 0);
    assert.equal(seniorEp.requests[0].authorization, "Bearer shared-key");
    assert.equal(seniorEp.requests[0].body.model, "senior-model");
    assert.equal(juniorEp.requests[0].authorization, "Bearer shared-key");
    assert.equal(juniorEp.requests[0].body.model, "junior-model");
  } finally {
    await seniorEp.close();
    await juniorEp.close();
  }
});

test("harness: no endpoints keeps the shared-config path", () => {
  const cfg = resolveConfig({ provider: "mock" });
  const harness = new TwoBrothersHarness(cfg, {});
  assert.ok(!(harness.providers.senior instanceof OpenAICompatibleProvider));
});

// ---------------------------------------------------------------------------
// validation with endpoints names the misconfigured role
// ---------------------------------------------------------------------------

test("validateRunConfig with endpoints names the misconfigured role", () => {
  const cfg = resolveConfig({ provider: "openai", baseUrl: "http://x/v1", seniorModel: "m" });
  const endpoints = resolveRoleEndpoints(snap(), [], NO_ENV, {
    provider: "openai",
    seniorModel: "m",
    juniorModel: "",
  });
  // junior: openai, URL gap-filled from senior, but no model anywhere
  try {
    validateRunConfig(cfg, endpoints);
    assert.fail("expected RunConfigError");
  } catch (exc) {
    assert.ok(exc instanceof RunConfigError);
    assert.match(exc.message, /no model configured for the junior role/);
    assert.doesNotMatch(exc.message, /senior role/);
  }
});

// ---------------------------------------------------------------------------
// CLI flags (parse + env-pin parity)
// ---------------------------------------------------------------------------

function makeIO(): CliIO & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, log: (line) => out.push(line), error: (line) => err.push(line) };
}

test("CLI: the four per-role flags parse and reach the config", async () => {
  const io = makeIO();
  // mock provider: the run completes offline; the flags are accepted and
  // carried into the per-role endpoints (they change nothing for mock)
  const code = await main(
    ["run", "flags smoke", "--provider", "mock", "--senior-base-url", "http://senior/v1", "--senior-api-key", "sk-s", "--junior-base-url", "http://junior/v1", "--junior-api-key", "sk-j"],
    io,
  );
  assert.equal(code, 0);
  assert.match(io.out.join("\n"), /decision/);
});

test("CLI: per-role flags drive validation — the 400 names the junior role", async () => {
  const io = makeIO();
  // junior gets its own endpoint but no model; validation must name junior
  await assert.rejects(
    main(
      ["run", "t", "--provider", "openai", "--base-url", "http://127.0.0.1:9/v1", "--senior-model", "m-s", "--junior-base-url", "http://127.0.0.1:8/v1"],
      io,
    ),
    /no model configured for the junior role/,
  );
});

test("CLI: per-role env vars resolve into the config and pin (never persisted)", () => {
  const saved = {
    TWO_BROTHERS_SENIOR_BASE_URL: process.env.TWO_BROTHERS_SENIOR_BASE_URL,
    TWO_BROTHERS_JUNIOR_API_KEY: process.env.TWO_BROTHERS_JUNIOR_API_KEY,
  };
  process.env.TWO_BROTHERS_SENIOR_BASE_URL = "http://env-senior/v1";
  process.env.TWO_BROTHERS_JUNIOR_API_KEY = "env-junior-key";
  try {
    const cfg = resolveConfig({});
    assert.equal(cfg.seniorBaseUrl, "http://env-senior/v1");
    assert.equal(cfg.juniorApiKey, "env-junior-key");
    assert.equal(cfg.juniorBaseUrl, ""); // untouched
    const pinned = envPinnedPairs();
    assert.ok(pinned.has("senior:base_url"));
    assert.ok(pinned.has("junior:api_key"));
    assert.ok(!pinned.has("junior:base_url"));
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("settings store: per-role env-pinned fields are stripped on write", () => {
  const saved = process.env.TWO_BROTHERS_SENIOR_BASE_URL;
  process.env.TWO_BROTHERS_SENIOR_BASE_URL = "http://env-senior/v1";
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-rolepin-"));
  try {
    const file = path.join(root, "settings.json");
    new SettingsStore(file).write({
      senior: { model: "m", base_url: "http://env-senior/v1", api_key: "k" },
    });
    const onDisk = fs.readFileSync(file, "utf-8");
    assert.ok(!onDisk.includes("http://env-senior/v1"), onDisk);
    const loaded = new SettingsStore(file).read();
    assert.equal(loaded.senior?.model, "m"); // unpinned fields persist
  } finally {
    if (saved === undefined) delete process.env.TWO_BROTHERS_SENIOR_BASE_URL;
    else process.env.TWO_BROTHERS_SENIOR_BASE_URL = saved;
    fs.rmSync(root, { recursive: true, force: true });
  }
});


// ---------------------------------------------------------------------------
// preset kind -> endpoint -> adapter (Wave 3 W3-2 follow-up)
// ---------------------------------------------------------------------------

const ACME_ANTHROPIC = {
  name: "acme",
  base_url: "http://acme.example/v1",
  api_key: "acme-key",
  kind: "anthropic",
};

test("resolver: preset kind rides the endpoint; manual/env sources leave it unset", () => {
  const viaPreset = resolveRoleEndpoints(
    snap({ provider_ref: "acme" }),
    [ACME_ANTHROPIC],
    NO_ENV,
  );
  assert.equal(viaPreset.senior.kind, "anthropic");
  assert.equal(viaPreset.junior.kind, undefined); // manual fields, no preset

  const viaEnv = resolveRoleEndpoints(snap({ provider_ref: "acme" }), [ACME_ANTHROPIC], {
    TWO_BROTHERS_BASE_URL: "http://env.example/v1",
    TWO_BROTHERS_API_KEY: "env-key",
  });
  assert.equal(viaEnv.senior.kind, undefined); // env pair wins over the preset
  assert.equal(viaEnv.senior.baseUrl, "http://env.example/v1");
});

test("resolver: a kind follows a borrowed connection (role without URL inherits the flavor)", () => {
  const out = resolveRoleEndpoints(
    {
      senior: { provider: "", model: "", base_url: "", api_key: "", provider_ref: "" },
      junior: {
        provider: "",
        model: "",
        base_url: "",
        api_key: "",
        provider_ref: "acme",
      },
    },
    [ACME_ANTHROPIC],
    NO_ENV,
  );
  assert.equal(out.junior.kind, "anthropic");
  assert.equal(out.senior.baseUrl, out.junior.baseUrl);
  assert.equal(out.senior.kind, "anthropic"); // paired with the borrowed URL
});

test("harness: endpoint kind selects the adapter; cfg kinds apply when unset", () => {
  const cfg = resolveConfig({
    provider: "openai",
    baseUrl: "http://127.0.0.1:1/v1",
    apiKey: "k",
    seniorModel: "s",
    juniorModel: "j",
    retries: 0,
  });
  const viaPreset = new TwoBrothersHarness(cfg, {
    endpoints: {
      senior: { provider: "openai", baseUrl: "http://a.example", apiKey: "k", model: "s", kind: "anthropic" },
      junior: { provider: "openai", baseUrl: "http://g.example", apiKey: "k", model: "j", kind: "google" },
    },
  });
  assert.ok(viaPreset.providers.senior instanceof AnthropicProvider);
  assert.ok(viaPreset.providers.junior instanceof GoogleProvider);

  const viaConfig = new TwoBrothersHarness(
    resolveConfig({
      provider: "openai",
      baseUrl: "http://127.0.0.1:1/v1",
      apiKey: "k",
      seniorModel: "s",
      juniorModel: "j",
      seniorKind: "google",
      retries: 0,
    }),
    {
      endpoints: {
        senior: { provider: "openai", baseUrl: "http://a.example", apiKey: "k", model: "s" },
      },
    },
  );
  assert.ok(viaConfig.providers.senior instanceof GoogleProvider);
  assert.ok(viaConfig.providers.junior instanceof OpenAICompatibleProvider);

  assert.throws(
    () =>
      new TwoBrothersHarness(cfg, {
        endpoints: {
          senior: {
            provider: "openai",
            baseUrl: "http://a.example",
            apiKey: "k",
            model: "s",
            kind: "not-a-kind",
          },
        },
      }),
    /unknown provider kind: not-a-kind/,
  );
});
