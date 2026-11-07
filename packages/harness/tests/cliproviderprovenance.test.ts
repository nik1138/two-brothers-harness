/**
 * Explicit `--provider` / `TWO_BROTHERS_PROVIDER` provenance (wave-3 follow-up).
 *
 * Root cause covered here: `resolveConfig` merged flags > env > defaults, so a
 * flag that repeated the built-in default (`--provider openai`) was
 * indistinguishable from an absent flag and a persisted non-default provider
 * silently won. `Config.providerExplicit` now records whether the provider came
 * from the flag or the env var; the TUI's `resolveTuiProviderState` lets that
 * explicit request (even default-valued) beat persisted role providers, while
 * an absent flag keeps the old behavior. Env counts as explicit because the
 * env overlay has always pinned the provider (any valid value) over settings,
 * and env-pinned fields are still never persisted.
 *
 * Run with: node tests/run-all.ts (or node --test tests/)
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { resolveConfig, type Config } from "../src/config.ts";
import { SettingsStore } from "../src/settings_store.ts";
import type { RuntimeSettingsSnapshot } from "../src/runtime.ts";
import {
  emptyRuntimeSnapshot,
  loadTuiProviderState,
  providerRoleSummaries,
  resolveTuiProviderState,
  saveTuiProviderConnection,
} from "../src/tui/providers.ts";

// --------------------------------------------------------------------------- //
// helpers
// --------------------------------------------------------------------------- //

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

/** Run `fn` with exactly one env var set, restoring the environment after. */
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

function tmpdir(prefix: string): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function fullSnapshot(
  senior: Partial<RuntimeSettingsSnapshot["senior"]> = {},
  junior: Partial<RuntimeSettingsSnapshot["junior"]> = {},
): RuntimeSettingsSnapshot {
  const base = (
    over: Partial<RuntimeSettingsSnapshot["senior"]>,
  ): RuntimeSettingsSnapshot["senior"] => ({
    provider: "",
    model: "",
    base_url: "",
    api_key: "",
    provider_ref: "",
    ...over,
  });
  return { senior: base(senior), junior: base(junior) };
}

const NO_ENV: NodeJS.ProcessEnv = {};

function resolvedProviders(
  snapshot: RuntimeSettingsSnapshot,
  cfg: Config,
  env: NodeJS.ProcessEnv = NO_ENV,
): [string, string] {
  const state = resolveTuiProviderState({ snapshot, storedPresets: [], cfg, env });
  const [senior, junior] = providerRoleSummaries(state, cfg, env);
  return [senior.provider, junior.provider];
}

// --------------------------------------------------------------------------- //
// provenance recording
// --------------------------------------------------------------------------- //

test("provider provenance: an absent flag and env record providerExplicit=false", async () => {
  await withCleanProviderEnv(async () => {
    for (const args of [{}, { mode: "consult" }] as const) {
      const cfg = resolveConfig(args);
      assert.equal(cfg.provider, "openai", "the built-in default still applies");
      assert.equal(cfg.providerExplicit, false);
    }
  });
});

test("provider provenance: --provider is explicit even when it repeats the default", async () => {
  await withCleanProviderEnv(async () => {
    const explicitDefault = resolveConfig({ provider: "openai" });
    assert.equal(explicitDefault.provider, "openai");
    assert.equal(explicitDefault.providerExplicit, true);
    const explicitMock = resolveConfig({ provider: "mock" });
    assert.equal(explicitMock.provider, "mock");
    assert.equal(explicitMock.providerExplicit, true);
  });
});

test("provider provenance: TWO_BROTHERS_PROVIDER is explicit, including the default value", async () => {
  await withCleanProviderEnv(async () => {
    for (const value of ["openai", "mock"]) {
      const cfg = withEnv("TWO_BROTHERS_PROVIDER", value, () => resolveConfig({}));
      assert.equal(cfg.provider, value);
      assert.equal(cfg.providerExplicit, true, `${value}: env must be explicit provenance`);
    }
  });
});

// --------------------------------------------------------------------------- //
// TUI resolution precedence
// --------------------------------------------------------------------------- //

test("TUI resolution: an explicit default-valued --provider beats a persisted non-default provider", async () => {
  await withCleanProviderEnv(async () => {
    const snapshot = fullSnapshot({ provider: "mock" }, { provider: "mock" });
    // Wave-3 follow-up: `--provider openai` repeats the default but is an
    // explicit operator request, so the persisted mock must not win.
    assert.deepEqual(resolvedProviders(snapshot, resolveConfig({ provider: "openai" })), [
      "openai",
      "openai",
    ]);
  });
});

test("TUI resolution: an absent --provider keeps the persisted provider (no behavior change)", async () => {
  await withCleanProviderEnv(async () => {
    const persistedMock = fullSnapshot({ provider: "mock" }, { provider: "mock" });
    assert.deepEqual(resolvedProviders(persistedMock, resolveConfig({})), ["mock", "mock"]);
    // A persisted default is a no-op either way: absent and explicit flags both
    // resolve to openai, so persisted-default cases are untouched.
    const persistedDefault = fullSnapshot({ provider: "openai" }, { provider: "openai" });
    for (const cfg of [resolveConfig({}), resolveConfig({ provider: "openai" })]) {
      assert.deepEqual(resolvedProviders(persistedDefault, cfg), ["openai", "openai"]);
    }
    // No persisted provider at all: the run config's provider applies as before.
    assert.deepEqual(resolvedProviders(emptyRuntimeSnapshot(), resolveConfig({})), [
      "openai",
      "openai",
    ]);
    assert.deepEqual(
      resolvedProviders(emptyRuntimeSnapshot(), resolveConfig({ provider: "mock" })),
      ["mock", "mock"],
    );
  });
});

test("TUI resolution: TWO_BROTHERS_PROVIDER is explicit and beats a persisted provider", async () => {
  await withCleanProviderEnv(async () => {
    const snapshot = fullSnapshot({ provider: "openai" }, { provider: "openai" });
    const cfg = withEnv("TWO_BROTHERS_PROVIDER", "mock", () => resolveConfig({}));
    assert.equal(cfg.providerExplicit, true);
    assert.deepEqual(
      resolvedProviders(snapshot, cfg, { TWO_BROTHERS_PROVIDER: "mock" }),
      ["mock", "mock"],
    );
  });
});

test("TUI resolution: an explicit flag still beats env (flags > env provenance)", async () => {
  await withCleanProviderEnv(async () => {
    const snapshot = fullSnapshot({ provider: "mock" }, { provider: "mock" });
    const cfg = withEnv("TWO_BROTHERS_PROVIDER", "mock", () =>
      resolveConfig({ provider: "openai" }),
    );
    assert.equal(cfg.provider, "openai");
    assert.equal(cfg.providerExplicit, true);
    assert.deepEqual(
      resolvedProviders(snapshot, cfg, { TWO_BROTHERS_PROVIDER: "mock" }),
      ["openai", "openai"],
    );
  });
});

test("TUI resolution: a hand-built config without provenance keeps the non-default heuristic", async () => {
  await withCleanProviderEnv(async () => {
    const persistedOpenai = fullSnapshot({ provider: "openai" }, { provider: "openai" });
    const persistedMock = fullSnapshot({ provider: "mock" }, { provider: "mock" });
    // Back-compat for callers that build a Config by hand: a non-default
    // provider still looks like an explicit request...
    const handMock = { ...resolveConfig({}), provider: "mock" } as Config;
    delete handMock.providerExplicit;
    assert.deepEqual(resolvedProviders(persistedOpenai, handMock), ["mock", "mock"]);
    // ...and a default-looking one still does not.
    const handDefault = { ...resolveConfig({}), provider: "openai" } as Config;
    delete handDefault.providerExplicit;
    assert.deepEqual(resolvedProviders(persistedMock, handDefault), ["mock", "mock"]);
  });
});

// --------------------------------------------------------------------------- //
// real store + save path (env pinning stays intact)
// --------------------------------------------------------------------------- //

test("TUI load: persisted settings resolve through the real store with explicit provenance", async () => {
  await withCleanProviderEnv(async () => {
    const tmp = tmpdir("tb-tui-provenance-");
    try {
      const store = new SettingsStore(path.join(tmp.root, "settings.json"));
      store.write({
        senior: { provider: "mock", model: "stored-senior" },
        junior: { provider: "mock", model: "stored-junior" },
      });
      const explicit = loadTuiProviderState({
        store,
        cfg: resolveConfig({ provider: "openai" }),
        env: NO_ENV,
      });
      assert.equal(explicit.endpoints.senior.provider, "openai");
      assert.equal(explicit.endpoints.junior.provider, "openai");
      // The explicit flag does not touch roles' other persisted fields.
      assert.equal(explicit.endpoints.senior.model, "stored-senior");
      // Absent flag: the persisted mock providers survive.
      const absent = loadTuiProviderState({ store, cfg: resolveConfig({}), env: NO_ENV });
      assert.equal(absent.endpoints.senior.provider, "mock");
      assert.equal(absent.endpoints.junior.provider, "mock");
    } finally {
      tmp.cleanup();
    }
  });
});

test("provider save: an env-pinned provider is never persisted and still wins at resolution", async () => {
  await withCleanProviderEnv(async () => {
    const tmp = tmpdir("tb-tui-provenance-pin-");
    const previous = process.env.TWO_BROTHERS_PROVIDER;
    process.env.TWO_BROTHERS_PROVIDER = "mock";
    try {
      const store = new SettingsStore(path.join(tmp.root, "settings.json"));
      const saved = saveTuiProviderConnection(
        store,
        {
          role: "senior",
          manual: { provider: "openai", baseUrl: "http://127.0.0.1:4321/v1", model: "m" },
        },
        { cfg: resolveConfig({}), env: process.env },
      );
      assert.equal(saved.ok, true, saved.error);
      const raw = JSON.parse(
        fs.readFileSync(path.join(tmp.root, "settings.json"), "utf-8"),
      ) as Record<string, Record<string, unknown>>;
      assert.equal(raw.senior?.provider, undefined, "env-pinned provider must not reach the file");
      assert.equal(raw.senior?.base_url, "http://127.0.0.1:4321/v1");
      // The env pin owns the effective provider for both roles.
      assert.equal(saved.state?.endpoints.senior.provider, "mock");
      assert.equal(saved.state?.endpoints.junior.provider, "mock");
    } finally {
      if (previous === undefined) delete process.env.TWO_BROTHERS_PROVIDER;
      else process.env.TWO_BROTHERS_PROVIDER = previous;
      tmp.cleanup();
    }
  });
});
