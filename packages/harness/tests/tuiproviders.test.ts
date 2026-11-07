/**
 * TUI provider connection suite: persisted-settings endpoint resolution, the
 * `/provider` connect flow, key redaction and the settings-store save path.
 *
 * Root cause covered here: the TUI used to build role endpoints from CLI
 * flags/env only, so a provider configured in the web Settings / `onboard` /
 * `serve` (persisted in `<sessionsDir>/settings.json`) was ignored and turns
 * hit the default endpoint. `app.ts` now resolves endpoints through the same
 * `SettingsStore`/`RuntimeSettings`/`resolveRoleEndpoints` stack the server
 * uses; these tests pin the precedence, the redaction and the save behavior,
 * plus one assembled-TUI turn against a loopback fake endpoint.
 *
 * Run with: node tests/run-all.ts (or node --test tests/)
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { resolveConfig } from "../src/config.ts";
import { mergeSeedPresets } from "../src/presets.ts";
import {
  SettingsStore,
  type ProviderPreset,
} from "../src/settings_store.ts";
import type { RuntimeSettingsSnapshot } from "../src/runtime.ts";
import {
  createProviderStore,
  emptyRuntimeSnapshot,
  loadTuiProviderState,
  providerFailureHint,
  providerModelChoices,
  providerPresetChoices,
  providerRoleSummaries,
  providerSummaryLines,
  resolveTuiProviderState,
  saveTuiProviderConnection,
} from "../src/tui/providers.ts";
import { runTuiApp, type TuiIO } from "../src/tui/app.ts";
import {
  createProviderConnectState,
  openManualProviderForm,
  openProviderPresets,
  providerConnectKey,
  providerConnectView,
} from "../src/tui/view/provider.ts";
import type { KeyLike } from "../src/tui/keymap.ts";
import { stripAnsi } from "../src/tui/render.ts";

// --------------------------------------------------------------------------- //
// helpers
// --------------------------------------------------------------------------- //

function tmpdir(prefix: string): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** Remove inherited TWO_BROTHERS_* provider pins for deterministic tests. */
async function withCleanProviderEnv<T>(run: () => T | Promise<T>): Promise<T> {
  const saved: Array<[string, string | undefined]> = [];
  for (const key of Object.keys(process.env)) {
    if (/^TWO_BROTHERS_(SENIOR|JUNIOR|BASE_URL|API_KEY|PROVIDER)/.test(key)) {
      saved.push([key, process.env[key]]);
      delete process.env[key];
    }
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function fullSnapshot(
  senior: Partial<RuntimeSettingsSnapshot["senior"]> = {},
  junior: Partial<RuntimeSettingsSnapshot["junior"]> = {},
): RuntimeSettingsSnapshot {
  const base = (over: Partial<RuntimeSettingsSnapshot["senior"]>): RuntimeSettingsSnapshot["senior"] => ({
    provider: "",
    model: "",
    base_url: "",
    api_key: "",
    provider_ref: "",
    ...over,
  });
  return { senior: base(senior), junior: base(junior) };
}

function storedPreset(over: Partial<ProviderPreset> = {}): ProviderPreset {
  return {
    name: "acme",
    base_url: "http://acme.example/v1",
    api_key: "acme-key",
    kind: "openai-compatible",
    models: ["acme-small", "acme-large"],
    ...over,
  };
}

const NO_ENV: NodeJS.ProcessEnv = {};

function mockConfig(): ReturnType<typeof resolveConfig> {
  return resolveConfig({ provider: "mock" });
}

/** One fake OpenAI-compatible endpoint for the assembled-TUI turn test. */
async function startFakeCooperationEndpoint(): Promise<{
  baseUrl: string;
  requests: Array<{ url: string; authorization: string | null; model: string }>;
  close(): Promise<void>;
}> {
  const requests: Array<{ url: string; authorization: string | null; model: string }> = [];
  const script = [
    JSON.stringify({ task: "t", ask: "a", expect: "proposal" }),
    JSON.stringify({ title: "P", answer: "A", confidence: 0.7 }),
    JSON.stringify({ verdict: "accept", notes: "ok" }),
    JSON.stringify({ decision: "done", confidence: 0.8 }),
  ];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk as Buffer));
    req.on("end", () => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as Record<string, unknown>;
      } catch {
        body = {};
      }
      requests.push({
        url: req.url ?? "",
        authorization: (req.headers.authorization as string | undefined) ?? null,
        model: typeof body.model === "string" ? body.model : "",
      });
      const content = script.length > 1 ? (script.shift() as string) : (script[0] as string);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { content } }],
          usage: { prompt_tokens: 2, completion_tokens: 2 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

// --------------------------------------------------------------------------- //
// resolution precedence
// --------------------------------------------------------------------------- //

test("provider resolution: no persisted settings keeps the flags/env config", () => {
  const state = resolveTuiProviderState({
    snapshot: emptyRuntimeSnapshot(),
    storedPresets: [],
    cfg: mockConfig(),
    env: NO_ENV,
  });
  const [senior, junior] = providerRoleSummaries(state, mockConfig(), NO_ENV);
  assert.equal(senior.provider, "mock");
  assert.equal(senior.model, "");
  assert.equal(senior.baseUrl, "");
  assert.equal(senior.apiKeySet, false);
  assert.equal(junior.provider, "mock");
  assert.deepEqual(state.warnings, []);
  assert.equal(state.loadError, undefined);
});

test("provider resolution: persisted manual fields drive the effective endpoints", () => {
  const state = resolveTuiProviderState({
    snapshot: fullSnapshot(
      { provider: "openai", model: "senior-m", base_url: "http://stored-senior/v1", api_key: "stored-key" },
      { provider: "openai", model: "junior-m", base_url: "http://stored-junior/v1", api_key: "stored-key" },
    ),
    storedPresets: [],
    cfg: resolveConfig({}),
    env: NO_ENV,
  });
  assert.deepEqual(
    [state.endpoints.senior.baseUrl, state.endpoints.senior.model],
    ["http://stored-senior/v1", "senior-m"],
  );
  assert.equal(state.endpoints.senior.apiKey, "stored-key");
  assert.equal(state.endpoints.junior.baseUrl, "http://stored-junior/v1");
  const [senior, junior] = providerRoleSummaries(state, resolveConfig({}), NO_ENV);
  assert.equal(senior.model, "senior-m");
  assert.equal(senior.apiKeySet, true);
  assert.equal(junior.model, "junior-m");
});

test("provider resolution: a provider_ref resolves through the stored preset (kind + key)", () => {
  const state = resolveTuiProviderState({
    snapshot: fullSnapshot({ provider_ref: "acme", model: "acme-small" }),
    storedPresets: [storedPreset({ kind: "anthropic" })],
    cfg: resolveConfig({}),
    env: NO_ENV,
  });
  assert.equal(state.endpoints.senior.baseUrl, "http://acme.example/v1");
  assert.equal(state.endpoints.senior.apiKey, "acme-key");
  assert.equal(state.endpoints.senior.kind, "anthropic");
  assert.equal(state.endpoints.senior.model, "acme-small");
  // The stored preset (not just the seeds) contributes its models to the picker.
  const models = providerModelChoices(state).map((choice) => choice.model);
  assert.ok(models.includes("acme-small"));
  assert.ok(models.includes("acme-large"));
  const presets = providerPresetChoices(state, NO_ENV);
  const acme = presets.find((preset) => preset.name === "acme");
  assert.ok(acme);
  assert.equal(acme.seed, false);
  assert.equal(acme.apiKeySet, true);
  assert.deepEqual(acme.models, ["acme-small", "acme-large"]);
  // Seed presets are still offered.
  assert.ok(presets.some((preset) => preset.name === "lmstudio" && preset.seed));
});

test("provider resolution: env pairs beat persisted settings all-or-nothing", () => {
  const env = {
    TWO_BROTHERS_SENIOR_BASE_URL: "http://env-senior/v1",
    TWO_BROTHERS_SENIOR_API_KEY: "env-senior-key",
    TWO_BROTHERS_BASE_URL: "http://shared-env/v1",
    TWO_BROTHERS_API_KEY: "shared-env-key",
  };
  const state = resolveTuiProviderState({
    snapshot: fullSnapshot({ provider_ref: "acme", base_url: "http://stored/v1", api_key: "stored-key" }),
    storedPresets: [storedPreset()],
    cfg: resolveConfig({}),
    env,
  });
  // Role env pair beats the preset/manual fields and clears the ref.
  assert.equal(state.endpoints.senior.baseUrl, "http://env-senior/v1");
  assert.equal(state.endpoints.senior.apiKey, "env-senior-key");
  assert.equal(state.snapshot.senior.provider_ref, "");
  // The other role takes the shared env pair, never the preset key/URL mix.
  assert.equal(state.endpoints.junior.baseUrl, "http://shared-env/v1");
  assert.equal(state.endpoints.junior.apiKey, "shared-env-key");
});

test("provider resolution: explicit CLI flags beat persisted settings per role", () => {
  const cfg = resolveConfig({
    seniorBaseUrl: "http://flag-senior/v1",
    seniorApiKey: "flag-senior-key",
    seniorModel: "flag-senior-model",
  });
  const state = resolveTuiProviderState({
    snapshot: fullSnapshot(
      { provider: "openai", model: "stored-senior-model", base_url: "http://stored-senior/v1", api_key: "stored-key" },
      { provider: "openai", model: "stored-junior-model", base_url: "http://stored-junior/v1", api_key: "stored-key" },
    ),
    storedPresets: [],
    cfg,
    env: NO_ENV,
  });
  assert.equal(state.endpoints.senior.baseUrl, "http://flag-senior/v1");
  assert.equal(state.endpoints.senior.apiKey, "flag-senior-key");
  assert.equal(state.endpoints.senior.model, "flag-senior-model");
  // The junior role has no flag: its persisted connection survives.
  assert.equal(state.endpoints.junior.baseUrl, "http://stored-junior/v1");
  assert.equal(state.endpoints.junior.model, "stored-junior-model");
});

test("provider resolution: an explicit --provider beats persisted role providers; the default does not", () => {
  const snapshot = fullSnapshot({ provider: "mock" }, { provider: "mock" });
  const explicit = resolveTuiProviderState({
    snapshot,
    storedPresets: [],
    cfg: resolveConfig({ provider: "openai" }),
    env: NO_ENV,
  });
  // "openai" is the run default, not an explicit request: persisted mock stays.
  assert.equal(explicit.endpoints.senior.provider, "mock");
  const forced = resolveTuiProviderState({
    snapshot: fullSnapshot({ provider: "openai" }, { provider: "openai" }),
    storedPresets: [],
    cfg: resolveConfig({ provider: "mock" }),
    env: NO_ENV,
  });
  assert.equal(forced.endpoints.senior.provider, "mock");
  assert.equal(forced.endpoints.junior.provider, "mock");
});

test("provider resolution: a session /models choice beats the persisted model (never persisted)", () => {
  const state = resolveTuiProviderState({
    snapshot: fullSnapshot({ model: "stored-model", base_url: "http://x/v1", api_key: "k" }),
    storedPresets: [],
    cfg: resolveConfig({}),
    env: NO_ENV,
    modelOverrides: { senior: "session-model" },
  });
  assert.equal(state.endpoints.senior.model, "session-model");
  assert.equal(state.snapshot.senior.model, "session-model"); // in-memory only
});

test("provider resolution: a dangling provider_ref warns and falls back to manual fields", () => {
  const state = resolveTuiProviderState({
    snapshot: fullSnapshot({
      provider_ref: "deleted-preset",
      base_url: "http://manual/v1",
      api_key: "manual-key",
    }),
    storedPresets: [],
    cfg: resolveConfig({}),
    env: NO_ENV,
  });
  assert.equal(state.endpoints.senior.baseUrl, "http://manual/v1");
  assert.equal(state.endpoints.senior.apiKey, "manual-key");
  assert.equal(state.warnings.length, 1);
  assert.match(state.warnings[0] ?? "", /provider_ref "deleted-preset"/);
  assert.match(state.warnings[0] ?? "", /senior role/);
});

test("provider resolution: an unreadable/corrupt settings document is fail-soft", () => {
  const tmp = tmpdir("tb-tui-provider-corrupt-");
  try {
    const store = createProviderStore(tmp.root);
    fs.mkdirSync(tmp.root, { recursive: true });
    fs.writeFileSync(path.join(tmp.root, "settings.json"), "{ this is not json", "utf-8");
    const state = loadTuiProviderState({ store, cfg: mockConfig(), env: NO_ENV });
    // Corrupt JSON reads as empty (the store's documented behavior) and the
    // flags/env layer still applies; nothing throws and no warning lies.
    assert.equal(state.endpoints.senior.provider, "mock");
    assert.deepEqual(state.warnings, []);
  } finally {
    tmp.cleanup();
  }
});

// --------------------------------------------------------------------------- //
// keys never leave the resolved state
// --------------------------------------------------------------------------- //

test("provider views never contain the API key value, only api_key_set", () => {
  const secret = "sk-super-secret-value";
  const state = resolveTuiProviderState({
    snapshot: fullSnapshot(
      { provider: "openai", model: "m", base_url: "http://x/v1", api_key: secret },
      { provider: "openai", model: "m2", base_url: "http://x/v1", api_key: secret },
    ),
    storedPresets: [storedPreset({ api_key: secret })],
    cfg: resolveConfig({}),
    env: NO_ENV,
  });
  const [senior, junior] = providerRoleSummaries(state, resolveConfig({}), NO_ENV);
  assert.equal(senior.apiKeySet, true);
  assert.equal(junior.apiKeySet, true);
  const rendered = JSON.stringify({
    summaries: [senior, junior],
    presets: providerPresetChoices(state, NO_ENV),
    lines: providerSummaryLines(state, resolveConfig({}), NO_ENV),
  });
  assert.ok(!rendered.includes(secret), "no key material in any display view");
  assert.ok(rendered.includes("API key: set"));
});

test("provider failure guidance keeps the real error and names /provider + flags", () => {
  const hint = providerFailureHint(
    "cannot reach http://127.0.0.1:9/v1/chat/completions: fetch failed (ECONNREFUSED)",
  );
  assert.ok(hint !== null);
  assert.match(hint, /\/provider/);
  assert.match(hint, /--base-url/);
  assert.match(hint, /--senior-base-url/);
  // A non-connection failure stays a generic turn failure.
  assert.equal(providerFailureHint("model returned an unparseable payload"), null);
});

// --------------------------------------------------------------------------- //
// /provider save path (atomic SettingsStore)
// --------------------------------------------------------------------------- //

test("provider save: manual connect writes the encrypted key through the store", () => {
  const tmp = tmpdir("tb-tui-provider-save-");
  try {
    const store = createProviderStore(tmp.root);
    store.write({}, undefined, [storedPreset()]);
    const result = saveTuiProviderConnection(
      store,
      {
        role: "senior",
        manual: {
          provider: "openai",
          baseUrl: "http://127.0.0.1:4321/v1",
          model: "manual-model",
          apiKey: "sk-typed-secret",
        },
      },
      { cfg: resolveConfig({}), env: NO_ENV },
    );
    assert.equal(result.ok, true, result.error);
    const raw = fs.readFileSync(path.join(tmp.root, "settings.json"), "utf-8");
    assert.ok(!raw.includes("sk-typed-secret"), "the key is encrypted at rest, not plaintext");
    const loaded = store.read();
    assert.equal(loaded.senior?.api_key, "sk-typed-secret");
    assert.equal(loaded.senior?.base_url, "http://127.0.0.1:4321/v1");
    assert.equal(loaded.senior?.model, "manual-model");
    assert.equal(loaded.senior?.provider_ref, undefined); // manual = no preset ref
    // The provider preset list is preserved by the same write.
    assert.deepEqual(
      store.readProviders().map((preset) => preset.name),
      ["acme"],
    );
    // The re-resolved state already reflects the new connection.
    assert.equal(result.state?.endpoints.senior.baseUrl, "http://127.0.0.1:4321/v1");
    assert.equal(result.state?.endpoints.senior.apiKey, "sk-typed-secret");
  } finally {
    tmp.cleanup();
  }
});

test("provider save: preset connect stores provider_ref + model, not a URL/key copy", () => {
  const tmp = tmpdir("tb-tui-provider-preset-");
  try {
    const store = createProviderStore(tmp.root);
    store.write({}, undefined, [storedPreset()]);
    const saved = saveTuiProviderConnection(
      store,
      { role: "junior", preset: { name: "acme", model: "acme-large" } },
      { cfg: resolveConfig({}), env: NO_ENV },
    );
    assert.equal(saved.ok, true, saved.error);
    const loaded = store.read();
    assert.equal(loaded.junior?.provider_ref, "acme");
    assert.equal(loaded.junior?.model, "acme-large");
    assert.equal(loaded.junior?.provider, "openai");
    assert.equal(loaded.junior?.base_url, undefined, "the preset owns the endpoint");
    assert.equal(loaded.junior?.api_key, undefined, "the preset owns the key");
    assert.equal(saved.state?.endpoints.junior.baseUrl, "http://acme.example/v1");
    assert.equal(saved.state?.endpoints.junior.apiKey, "acme-key");
    // Validation failures never touch the file.
    const unknown = saveTuiProviderConnection(
      store,
      { role: "junior", preset: { name: "ghost", model: "m" } },
      { cfg: resolveConfig({}), env: NO_ENV },
    );
    assert.equal(unknown.ok, false);
    assert.match(unknown.error ?? "", /unknown provider preset: ghost/);
  } finally {
    tmp.cleanup();
  }
});

test("provider save: env-pinned fields are stripped, never persisted", () => {
  const tmp = tmpdir("tb-tui-provider-pin-");
  const previous = process.env.TWO_BROTHERS_SENIOR_MODEL;
  process.env.TWO_BROTHERS_SENIOR_MODEL = "env-model";
  try {
    const store = createProviderStore(tmp.root);
    const result = saveTuiProviderConnection(
      store,
      {
        role: "senior",
        manual: { baseUrl: "http://127.0.0.1:4321/v1", model: "typed-model" },
      },
      { cfg: resolveConfig({}), env: process.env },
    );
    assert.equal(result.ok, true, result.error);
    const raw = JSON.parse(fs.readFileSync(path.join(tmp.root, "settings.json"), "utf-8")) as Record<
      string,
      Record<string, unknown>
    >;
    assert.equal(raw.senior?.model, undefined, "pinned model must not reach the file");
    assert.equal(raw.senior?.base_url, "http://127.0.0.1:4321/v1");
    // The effective model is still the env pin (env outranks the save).
    assert.equal(result.state?.endpoints.senior.model, "env-model");
  } finally {
    if (previous === undefined) delete process.env.TWO_BROTHERS_SENIOR_MODEL;
    else process.env.TWO_BROTHERS_SENIOR_MODEL = previous;
    tmp.cleanup();
  }
});

test("provider save: validation errors and write failures change nothing", () => {
  const tmp = tmpdir("tb-tui-provider-fail-");
  try {
    const file = path.join(tmp.root, "settings.json");
    const store = createProviderStore(tmp.root);
    const base = { cfg: resolveConfig({}), env: NO_ENV };
    for (const [manual, pattern] of [
      [{ baseUrl: "", model: "m" }, /Base URL must not be empty/],
      [{ baseUrl: "ftp://x", model: "m" }, /http:\/\/ or https:\/\//],
      [{ baseUrl: "http://x/v1", model: "" }, /Model must not be empty/],
      [{ baseUrl: "http://x/v1", model: "m", provider: "bogus" }, /invalid provider/],
    ] as const) {
      const result = saveTuiProviderConnection(store, { role: "senior", manual }, base);
      assert.equal(result.ok, false);
      assert.match(result.error ?? "", pattern);
      assert.ok(!fs.existsSync(file), "a rejected save writes no file");
    }

    // A failing atomic write (the temp path is a directory) refuses honestly
    // and leaves the previously persisted document byte-identical.
    store.write({ senior: { provider: "openai", base_url: "http://good/v1", model: "good-model" } });
    const before = fs.readFileSync(file, "utf-8");
    fs.mkdirSync(`${file}.tmp`);
    const failed = saveTuiProviderConnection(
      store,
      { role: "senior", manual: { baseUrl: "http://bad/v1", model: "bad-model" } },
      base,
    );
    assert.equal(failed.ok, false);
    assert.match(failed.error ?? "", /cannot save provider settings/);
    assert.equal(fs.readFileSync(file, "utf-8"), before, "a failed write changes nothing");
    assert.equal(new SettingsStore(file).read().senior?.base_url, "http://good/v1");
  } finally {
    tmp.cleanup();
  }
});

// --------------------------------------------------------------------------- //
// /provider view (pure)
// --------------------------------------------------------------------------- //

function connectData(): Parameters<typeof providerConnectView>[1] {
  const state = resolveTuiProviderState({
    snapshot: fullSnapshot(
      { provider: "openai", model: "current-model", base_url: "http://stored/v1", api_key: "k" },
    ),
    storedPresets: [storedPreset()],
    cfg: resolveConfig({}),
    env: NO_ENV,
  });
  return {
    roles: providerRoleSummaries(state, resolveConfig({}), NO_ENV),
    presets: providerPresetChoices(state, NO_ENV),
  };
}

const KEY = {
  up: { name: "up", raw: "" },
  down: { name: "down", raw: "" },
  enter: { name: "return", raw: "\r" },
  escape: { name: "escape", raw: "\u001b" },
  clear: { name: "u", ctrl: true, raw: "" },
} as const;

function press(state: ReturnType<typeof createProviderConnectState>, data: ReturnType<typeof connectData>, key: KeyLike) {
  return providerConnectKey(state, data, key).state;
}

function typeText(state: ReturnType<typeof createProviderConnectState>, data: ReturnType<typeof connectData>, text: string) {
  let next = state;
  for (const char of text) {
    next = providerConnectKey(next, data, { name: char, raw: char }).state;
  }
  return next;
}

test("provider view: role -> preset -> model returns a preset save request", () => {
  const data = connectData();
  let state = createProviderConnectState();
  state = press(state, data, KEY.enter); // Senior
  assert.equal(state.stage, "presets");
  // First row is the first seed preset (openai); its first model saves.
  state = press(state, data, KEY.enter);
  assert.equal(state.stage, "presetModel");
  assert.equal(state.presetName, data.presets[0]?.name);
  // The role already has a model, so row 0 is "keep current"; row 1 is the
  // preset's first advertised model.
  if ((data.roles[0]?.model ?? "").trim() !== "") state = press(state, data, KEY.down);
  const result = providerConnectKey(state, data, KEY.enter);
  assert.equal(result.action.type, "save");
  if (result.action.type === "save") {
    assert.deepEqual(result.action.request, {
      role: "senior",
      preset: { name: data.presets[0]?.name, model: data.presets[0]?.models[0] },
    });
  }
});

test("provider view: a stored preset's models are offered in the model stage", () => {
  const data = connectData();
  const index = data.presets.findIndex((preset) => preset.name === "acme");
  assert.ok(index >= 0);
  let state = openProviderPresets(createProviderConnectState(), "senior");
  for (let i = 0; i < index; i += 1) state = press(state, data, KEY.down);
  state = press(state, data, KEY.enter);
  assert.equal(state.stage, "presetModel");
  assert.equal(state.presetName, "acme");
  // keep current first, then acme's stored models.
  const kept = press(state, data, KEY.down);
  const result = providerConnectKey(kept, data, KEY.enter);
  assert.equal(result.action.type, "save");
  if (result.action.type === "save") {
    assert.deepEqual(result.action.request.preset, { name: "acme", model: "acme-small" });
  }
});

test("provider view: the manual form types fields and never renders the key", () => {
  const data = connectData();
  let state = openManualProviderForm(createProviderConnectState(), data);
  assert.equal(state.manual.baseUrl, "http://stored/v1");
  assert.equal(state.manual.model, "current-model");
  // Base URL: edit (ctrl+u clears the prefilled value) and commit.
  state = press(state, data, KEY.enter);
  assert.equal(state.editing, "baseUrl");
  state = press(state, data, KEY.clear);
  state = typeText(state, data, "http://edited/v1");
  state = press(state, data, KEY.enter);
  assert.equal(state.manual.baseUrl, "http://edited/v1");
  // Model field.
  state = press(state, data, KEY.down);
  state = press(state, data, KEY.enter);
  state = press(state, data, KEY.clear);
  state = typeText(state, data, "typed-model");
  state = press(state, data, KEY.enter);
  assert.equal(state.manual.model, "typed-model");
  // API key: typed into the hidden editor, committed to memory only.
  state = press(state, data, KEY.down);
  state = press(state, data, KEY.enter);
  assert.equal(state.editing, "apiKey");
  state = typeText(state, data, "sk-typed-secret");
  const whileEditing = providerConnectView(state, data, { width: 72 }).lines.join("\n");
  assert.ok(!whileEditing.includes("sk-typed-secret"), "the key is masked while typing");
  assert.match(whileEditing, /•/);
  state = press(state, data, KEY.enter);
  assert.equal(state.editing, null);
  assert.equal(state.manual.apiKey, "sk-typed-secret");
  const afterCommit = providerConnectView(state, data, { width: 72 }).lines.join("\n");
  assert.ok(!afterCommit.includes("sk-typed-secret"), "the key is masked after commit");
  // Connect row is selected right after the last field commit.
  const result = providerConnectKey(state, data, KEY.enter);
  assert.equal(result.action.type, "save");
  if (result.action.type === "save") {
    assert.deepEqual(result.action.request.manual, {
      provider: "openai",
      baseUrl: "http://edited/v1",
      model: "typed-model",
      apiKey: "sk-typed-secret",
    });
  }
});

test("provider view: rows are width-safe and plain at narrow widths", () => {
  const data = connectData();
  const state = openManualProviderForm(createProviderConnectState(), data);
  for (const width of [36, 48, 72]) {
    const lines = providerConnectView(state, data, { width, height: 20, theme: undefined }).lines;
    assert.equal(lines.length, 20);
    for (const line of lines) assert.equal(stripAnsi(line).length, width, `${width}: ${line}`);
  }
});

// --------------------------------------------------------------------------- //
// assembled TUI: persisted endpoint drives a real turn (root cause)
// --------------------------------------------------------------------------- //

class FakeInput extends EventEmitter {
  isTTY = true;
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  setEncoding(): void {}
  unref(): void {}
  type(text: string): void {
    for (const char of text) {
      this.emit("keypress", char, { name: char, ctrl: false, shift: char !== char.toLowerCase() });
    }
  }
  key(name: string, modifiers: { ctrl?: boolean; shift?: boolean; raw?: string } = {}): void {
    this.emit("keypress", modifiers.raw ?? "", {
      name,
      ctrl: modifiers.ctrl === true,
      shift: modifiers.shift === true,
    });
  }
  enter(): void {
    this.key("return", { raw: "\r" });
  }
}

class FakeOutput extends EventEmitter {
  isTTY = true;
  columns = 96;
  rows = 30;
  data = "";
  write(chunk: string): boolean {
    this.data += chunk;
    return true;
  }
}

function makeIO(): TuiIO & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, log: (line) => out.push(line), error: (line) => err.push(line) };
}

async function waitFor(predicate: () => boolean, timeoutMs = 8_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
}

function startApp(
  sessionsDir: string,
  extra: Partial<Parameters<typeof runTuiApp>[0]> = {},
): { app: Promise<number>; input: FakeInput; output: FakeOutput } {
  const input = new FakeInput();
  const output = new FakeOutput();
  const app = runTuiApp({
    cfg: mockConfig(),
    io: makeIO(),
    input: input as unknown as NodeJS.ReadStream,
    output: output as unknown as NodeJS.WriteStream,
    pluginsDir: `${process.cwd()}/does-not-exist-tui-plugins`,
    sessionsDir,
    ...extra,
  });
  return { app, input, output };
}

async function quit(input: FakeInput, app: Promise<number>): Promise<number> {
  for (let press = 0; press < 6; press += 1) {
    input.key("escape");
    const settled = await Promise.race([
      app.then((code) => code as number | "exited"),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 200)),
    ]);
    if (settled !== "pending") return settled === "exited" ? 0 : settled;
  }
  const code = await Promise.race([
    app,
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 10_000)),
  ]);
  if (code === "timeout") throw new Error("the TUI did not exit after repeated Escape");
  return code;
}

const textOf = (output: FakeOutput): string => stripAnsi(output.data);

test("TUI turn uses the endpoints persisted by the web Settings/onboard (root cause)", async () => {
  await withCleanProviderEnv(async () => {
    const tmp = tmpdir("tb-tui-endpoint-");
    const endpoint = await startFakeCooperationEndpoint();
    try {
      const store = new SettingsStore(path.join(tmp.root, "settings.json"));
      store.write({
        senior: {
          provider: "openai",
          base_url: endpoint.baseUrl,
          api_key: "sk-persisted-secret",
          model: "senior-model",
        },
        junior: {
          provider: "openai",
          base_url: endpoint.baseUrl,
          api_key: "sk-persisted-secret",
          model: "junior-model",
        },
      });
      const { app, input, output } = startApp(tmp.root, {
        cfg: resolveConfig({ provider: "openai", retries: 0, timeout: 10 }),
      });
      try {
        assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));
        // The welcome/status surface is honest about the persisted models
        // without any --senior-model flag.
        assert.ok(await waitFor(() => textOf(output).includes("senior-model")));
        input.type("cooperate");
        input.enter();
        assert.ok(
          await waitFor(() => endpoint.requests.length > 0),
          "the persisted endpoint was contacted",
        );
        assert.ok(
          await waitFor(() => textOf(output).includes("decision:")),
          "the turn completed against the persisted endpoint",
        );
        for (const request of endpoint.requests) {
          assert.equal(request.authorization, "Bearer sk-persisted-secret");
          assert.ok(["senior-model", "junior-model"].includes(request.model));
        }
        assert.ok(!textOf(output).includes("sk-persisted-secret"), "no key in the transcript");
        const code = await quit(input, app);
        assert.equal(code, 0);
      } finally {
        await quit(input, app);
      }
    } finally {
      await endpoint.close();
      tmp.cleanup();
    }
  });
});

test("TUI /provider connect persists a preset through the same settings store", async () => {
  await withCleanProviderEnv(async () => {
    const tmp = tmpdir("tb-tui-connect-");
    try {
      const { app, input, output } = startApp(tmp.root);
      try {
        assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));
        // `/provider` opens the real connect surface (no "run onboard" dead end).
        // The inline slash picker opens while typing; Escape dismisses it and
        // keeps the draft, then Enter submits the command.
        input.type("/provider");
        input.key("escape");
        input.enter();
        assert.ok(await waitFor(() => textOf(output).includes("PROVIDER SETTINGS")));
        input.enter(); // Connect Senior…
        assert.ok(await waitFor(() => textOf(output).includes("PROVIDER")));
        input.enter(); // first preset (openai seed)
        assert.ok(await waitFor(() => textOf(output).includes("MODEL")));
        input.enter(); // first model of that preset
        assert.ok(
          await waitFor(() => textOf(output).includes("connected")),
          "the connect action reports success",
        );
        const raw = JSON.parse(
          fs.readFileSync(path.join(tmp.root, "settings.json"), "utf-8"),
        ) as Record<string, Record<string, unknown>>;
        assert.equal(raw.senior?.provider, "openai");
        assert.equal(raw.senior?.provider_ref, "openai");
        assert.equal(typeof raw.senior?.model, "string");
        const code = await quit(input, app);
        assert.equal(code, 0);
      } finally {
        await quit(input, app);
      }
    } finally {
      tmp.cleanup();
    }
  });
});

test("TUI /provider manual connect encrypts the key and never renders it", async () => {
  await withCleanProviderEnv(async () => {
    const tmp = tmpdir("tb-tui-manual-");
    const secret = "sk-tui-manual-secret";
    try {
      const { app, input, output } = startApp(tmp.root);
      try {
        assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));
        input.type("/provider");
        input.key("escape");
        input.enter();
        assert.ok(await waitFor(() => textOf(output).includes("PROVIDER SETTINGS")));
        input.enter(); // senior
        assert.ok(await waitFor(() => textOf(output).includes("PROVIDER")));
        // Walk to "Manual connection…" (after every preset row).
        const presetCount = mergeSeedPresets().length;
        for (let i = 0; i < presetCount; i += 1) input.key("down");
        input.enter();
        assert.ok(await waitFor(() => textOf(output).includes("MANUAL CONNECTION")));
        // Base URL field: prefilled from the (mock) effective role, i.e. empty.
        input.enter();
        input.type("http://127.0.0.1:9/v1");
        input.enter();
        input.key("down"); // model
        input.enter();
        input.type("manual-model");
        input.enter();
        input.key("down"); // API key
        input.enter();
        input.type(secret);
        assert.ok(!textOf(output).includes(secret), "the typed key is masked while typing");
        input.enter(); // commit hidden key
        input.enter(); // Connect
        assert.ok(await waitFor(() => textOf(output).includes("connected")));
        const rawText = fs.readFileSync(path.join(tmp.root, "settings.json"), "utf-8");
        assert.ok(!rawText.includes(secret), "the key is encrypted at rest");
        const loaded = new SettingsStore(path.join(tmp.root, "settings.json")).read();
        assert.equal(loaded.senior?.api_key, secret);
        assert.equal(loaded.senior?.base_url, "http://127.0.0.1:9/v1");
        assert.equal(loaded.senior?.model, "manual-model");
        assert.ok(!textOf(output).includes(secret), "the key never reaches the transcript");
        const code = await quit(input, app);
        assert.equal(code, 0);
      } finally {
        await quit(input, app);
      }
    } finally {
      tmp.cleanup();
    }
  });
});

test("TUI startup warns honestly about a dangling provider_ref", async () => {
  await withCleanProviderEnv(async () => {
    const tmp = tmpdir("tb-tui-dangling-");
    try {
      const store = new SettingsStore(path.join(tmp.root, "settings.json"));
      store.write({
        senior: { provider: "openai", provider_ref: "ghost-preset", model: "m" },
      });
      const { app, input, output } = startApp(tmp.root);
      try {
        // The dangling ref is reported honestly at startup (as a notice, so the
        // welcome block is replaced by the warning).
        assert.ok(
          await waitFor(() => textOf(output).includes('provider_ref "ghost-preset"')),
          "the dangling ref is reported at startup",
        );
        const code = await quit(input, app);
        assert.equal(code, 0);
      } finally {
        await quit(input, app);
      }
    } finally {
      tmp.cleanup();
    }
  });
});
