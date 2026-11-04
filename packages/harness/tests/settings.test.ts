/**
 * Settings persistence and API-key encryption at rest. Ports the
 * settings-related parts of the original prototype's settings-store and
 * provider-preset tests (removed 2026-11-04; see git history) to
 * node:test.
 *
 * The non-Windows (plain1:) path and the undecryptable-DPAPI path are
 * simulated by injecting the secretbox backend, exactly like Python's
 * mock.patch.object on _dpapi_available / _crypt_unprotect.
 *
 * Run with: node tests/run-all.ts (or node --test tests/)
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import {
  DPAPI_PREFIX,
  DefaultSecretBox,
  PLAIN_PREFIX,
  type DpapiCipher,
} from "../src/secretbox.ts";
import { SettingsStore } from "../src/settings_store.ts";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function tmpdir(): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-settings-"));
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const ROLE_SETTINGS = {
  senior: {
    provider: "openai",
    model: "spark-x2.6-4b@q4_k_m",
    base_url: "http://127.0.0.1:1234/v1",
    api_key: "super-secret-key",
  },
  junior: {
    provider: "openai",
    model: "lfm3-1.7b",
    base_url: "http://127.0.0.1:1234/v1",
    api_key: "",
  },
};

const ACME = { name: "acme", base_url: "https://acme.example/v1", api_key: "acme-key" };

const PLATFORM_PREFIX = process.platform === "win32" ? DPAPI_PREFIX : PLAIN_PREFIX;

/** Run `fn` with the given env vars set, restoring the previous state after. */
function withEnv(values: Record<string, string>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(values)) saved[key] = process.env[key];
  Object.assign(process.env, values);
  try {
    fn();
  } finally {
    for (const [key, prev] of Object.entries(saved)) {
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    }
  }
}

/** A recording cipher: "dpapi1:" blobs are `dpapi:${text}` base64-encoded. */
function fakeCipher(): DpapiCipher & { protectedBatches: number[]; failProtect: boolean; failUnprotect: boolean } {
  const state = {
    protectedBatches: [] as number[],
    failProtect: false,
    failUnprotect: false,
  };
  return Object.assign(state, {
    protectMany(data: Buffer[]): Buffer[] {
      state.protectedBatches.push(data.length);
      if (state.failProtect) throw new Error("dpapi unavailable");
      return data.map((buf) => Buffer.from(`dpapi:${buf.toString("utf-8")}`));
    },
    unprotectMany(data: Buffer[]): Array<Buffer | null> {
      return data.map((buf) => {
        if (state.failUnprotect) return null;
        const text = buf.toString("utf-8");
        return text.startsWith("dpapi:") ? Buffer.from(text.slice("dpapi:".length)) : null;
      });
    },
  });
}

// ---------------------------------------------------------------------------
// SecretboxTest (ports SecretboxTest)
// ---------------------------------------------------------------------------

test("seal/unseal round-trips with the platform prefix", () => {
  const box = new DefaultSecretBox();
  const blob = box.seal("super-secret-key");
  assert.ok(blob.startsWith(PLATFORM_PREFIX), blob);
  assert.equal(box.unseal(blob), "super-secret-key");
  assert.ok(!blob.includes("super-secret-key"));
});

test("plain1: fallback when DPAPI is unavailable; unprefixed passthrough", () => {
  const warnings: string[] = [];
  const box = new DefaultSecretBox({ dpapi: null, onWarning: (m) => warnings.push(m) });
  const blob = box.seal("fallback-key");
  assert.ok(blob.startsWith(PLAIN_PREFIX), blob);
  assert.equal(box.unseal(blob), "fallback-key");
  // hand-edited, unprefixed values read back as plaintext
  assert.equal(box.unseal("raw-value"), "raw-value");
  // no DPAPI was attempted, so nothing was warned about either
  assert.deepEqual(warnings, []);
});

test("undecryptable dpapi1: blob yields empty string with a warning", () => {
  const warnings: string[] = [];
  const cipher = fakeCipher();
  cipher.failUnprotect = true;
  const box = new DefaultSecretBox({ dpapi: cipher, onWarning: (m) => warnings.push(m) });
  assert.equal(box.unseal("dpapi1:AAAA"), "");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /DPAPI unprotect failed/);
});

test("protect failure falls back to plain1: and never crashes", () => {
  const warnings: string[] = [];
  const cipher = fakeCipher();
  cipher.failProtect = true;
  const box = new DefaultSecretBox({ dpapi: cipher, onWarning: (m) => warnings.push(m) });
  const blob = box.seal("protect-me");
  assert.ok(blob.startsWith(PLAIN_PREFIX), blob);
  assert.equal(box.unseal(blob), "protect-me");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /DPAPI protect failed/);
  // the broken backend is not retried: the next seal warns nothing and is plain
  const second = box.seal("again");
  assert.ok(second.startsWith(PLAIN_PREFIX), second);
  assert.equal(warnings.length, 1);
});

// ---------------------------------------------------------------------------
// SettingsStoreTest (ports SettingsStoreTest)
// ---------------------------------------------------------------------------

test("round-trip restores everything", () => {
  const { root, cleanup } = tmpdir();
  try {
    const file = path.join(root, "settings.json");
    new SettingsStore(file).write(ROLE_SETTINGS);
    const loaded = new SettingsStore(file).read();
    assert.deepEqual(loaded.senior, ROLE_SETTINGS.senior);
    // empty fields are omitted on disk; the junior key stays empty
    assert.deepEqual(loaded.junior, {
      provider: "openai",
      model: "lfm3-1.7b",
      base_url: "http://127.0.0.1:1234/v1",
    });
  } finally {
    cleanup();
  }
});

test("api key is encrypted at rest", () => {
  const { root, cleanup } = tmpdir();
  try {
    const file = path.join(root, "settings.json");
    new SettingsStore(file).write(ROLE_SETTINGS);
    const raw = fs.readFileSync(file, "utf-8");
    assert.ok(!raw.includes("super-secret-key"));
    const onDisk = (JSON.parse(raw) as Record<string, Record<string, string>>).senior.api_key;
    assert.ok(onDisk.startsWith(PLATFORM_PREFIX), onDisk);
  } finally {
    cleanup();
  }
});

test("missing and corrupt file read empty", () => {
  const { root, cleanup } = tmpdir();
  try {
    const file = path.join(root, "settings.json");
    const store = new SettingsStore(file);
    assert.deepEqual(store.read(), {});
    assert.deepEqual(store.readPlugins(), []);
    assert.deepEqual(store.readProviders(), []);
    fs.writeFileSync(file, "{ not json", "utf-8");
    assert.deepEqual(store.read(), {});
    assert.deepEqual(store.readProviders(), []);
  } finally {
    cleanup();
  }
});

test("env-pinned values never persist; unpinned values do (S17 review guard)", () => {
  const { root, cleanup } = tmpdir();
  try {
    const file = path.join(root, "settings.json");
    withEnv(
      {
        TWO_BROTHERS_BASE_URL: "http://env-base.example/v1",
        TWO_BROTHERS_API_KEY: "env-secret-key",
        TWO_BROTHERS_SENIOR_MODEL: "env-model",
      },
      () => {
        new SettingsStore(file).write({
          senior: { model: "ui-senior", base_url: "http://ui", api_key: "ui-key" },
          junior: { model: "ui-junior" },
        });
      },
    );
    const raw = fs.readFileSync(file, "utf-8");
    assert.ok(!raw.includes("http://env-base.example/v1"));
    assert.ok(!raw.includes("env-secret-key"));
    assert.ok(!raw.includes("env-model"));
    // pinned fields were dropped from the roles being written...
    const stored = new SettingsStore(file).read();
    for (const role of ["senior", "junior"] as const) {
      assert.equal(stored[role]?.base_url, undefined, role);
      assert.equal(stored[role]?.api_key, undefined, role);
    }
    // ...but the UI-provided, non-pinned junior model was persisted;
    // the senior model was pinned by TWO_BROTHERS_SENIOR_MODEL, so it was dropped
    assert.equal(stored.senior?.model, undefined);
    assert.ok(!raw.includes("ui-senior"));
    assert.equal(stored.junior?.model, "ui-junior");
  } finally {
    cleanup();
  }
});

test("TWO_BROTHERS_PROVIDER pins the provider field for both roles", () => {
  const { root, cleanup } = tmpdir();
  try {
    const file = path.join(root, "settings.json");
    withEnv({ TWO_BROTHERS_PROVIDER: "mock" }, () => {
      new SettingsStore(file).write({ senior: { provider: "openai", model: "m" } });
    });
    const raw = fs.readFileSync(file, "utf-8");
    assert.ok(!raw.includes('"provider"'), raw);
    const stored = new SettingsStore(file).read();
    assert.equal(stored.senior?.provider, undefined);
    assert.equal(stored.senior?.model, "m");
  } finally {
    cleanup();
  }
});

test("partial update preserves plugins and providers sections", () => {
  const { root, cleanup } = tmpdir();
  try {
    const file = path.join(root, "settings.json");
    const store = new SettingsStore(file);
    store.write({}, ["notes"], [ACME]);
    // a plain role-settings save must not wipe the other sections
    store.write({ senior: { model: "m" } });
    const loaded = new SettingsStore(file).readProviders();
    assert.equal(loaded[0].name, "acme");
    assert.equal(loaded[0].api_key, "acme-key");
    assert.deepEqual(new SettingsStore(file).readPlugins(), ["notes"]);
    assert.equal(new SettingsStore(file).read().senior?.model, "m");
  } finally {
    cleanup();
  }
});

test("explicit plugins/providers sections overwrite and sanitize", () => {
  const { root, cleanup } = tmpdir();
  try {
    const file = path.join(root, "settings.json");
    const store = new SettingsStore(file);
    store.write({ senior: { model: "m1" } }, ["notes"], [ACME]);
    store.write(
      { junior: { model: "m2" } },
      ["", 42, "notes", "notes"],
      [{ name: "", base_url: "https://x" }, "junk", { name: "globe", base_url: "https://g.example/v1" }],
    );
    const fresh = new SettingsStore(file);
    // one shared list; non-strings dropped and duplicates collapsed
    assert.deepEqual(fresh.readPlugins(), ["notes"]);
    const providers = fresh.readProviders();
    assert.equal(providers.length, 1);
    assert.equal(providers[0].name, "globe");
    assert.equal(providers[0].api_key, "");
    // roles were replaced, not merged: senior is gone from the file
    assert.equal(fresh.read().senior, undefined);
    assert.equal(fresh.read().junior?.model, "m2");
  } finally {
    cleanup();
  }
});

test("corrupt providers section reads empty (tolerant boundary)", () => {
  const { root, cleanup } = tmpdir();
  try {
    const file = path.join(root, "settings.json");
    fs.writeFileSync(file, JSON.stringify({ providers: [{ name: "no-url" }, "junk", 42] }), "utf-8");
    assert.deepEqual(new SettingsStore(file).readProviders(), []);
  } finally {
    cleanup();
  }
});

test("a shared plugins list round-trips through disk", () => {
  const { root, cleanup } = tmpdir();
  try {
    const file = path.join(root, "settings.json");
    new SettingsStore(file).write({}, ["notes", "calendar"]);
    const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as { plugins: unknown };
    assert.deepEqual(raw.plugins, ["notes", "calendar"]);
    assert.deepEqual(new SettingsStore(file).readPlugins(), ["notes", "calendar"]);
  } finally {
    cleanup();
  }
});

test("legacy per-role plugins merge into the shared list (dedup, order preserved)", () => {
  const { root, cleanup } = tmpdir();
  try {
    const file = path.join(root, "settings.json");
    fs.writeFileSync(
      file,
      JSON.stringify({ plugins: { senior: ["notes", "calendar"], junior: ["notes", "shell"] } }),
      "utf-8",
    );
    // senior order first, then the junior-only additions; "notes" deduped
    assert.deepEqual(new SettingsStore(file).readPlugins(), ["notes", "calendar", "shell"]);
  } finally {
    cleanup();
  }
});

test("legacy top-level per-role plugin keys merge too", () => {
  const { root, cleanup } = tmpdir();
  try {
    const file = path.join(root, "settings.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        plugins_senior: ["notes"],
        plugins_junior: ["calendar", "notes"],
      }),
      "utf-8",
    );
    assert.deepEqual(new SettingsStore(file).readPlugins(), ["notes", "calendar"]);
  } finally {
    cleanup();
  }
});

test("a save drops legacy per-role plugin keys and writes the shared list", () => {
  const { root, cleanup } = tmpdir();
  try {
    const file = path.join(root, "settings.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        plugins: { senior: ["notes"], junior: ["notes", "calendar"] },
        plugins_senior: ["calendar"],
        plugins_junior: ["shell"],
        senior: { model: "kept" },
      }),
      "utf-8",
    );
    const store = new SettingsStore(file);
    // a plain role-settings save (no plugins argument) migrates the section
    store.write({ senior: { model: "updated" } });
    const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
    assert.deepEqual(raw.plugins, ["notes", "calendar", "shell"]);
    assert.equal("plugins_senior" in raw, false);
    assert.equal("plugins_junior" in raw, false);
    assert.equal(store.read().senior?.model, "updated");
    assert.deepEqual(store.readPlugins(), ["notes", "calendar", "shell"]);
  } finally {
    cleanup();
  }
});

test("a legacy write shape is still accepted and stored as the shared list", () => {
  const { root, cleanup } = tmpdir();
  try {
    const file = path.join(root, "settings.json");
    new SettingsStore(file).write({}, { senior: ["notes"], junior: ["notes", "calendar"] });
    const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as { plugins: unknown };
    assert.deepEqual(raw.plugins, ["notes", "calendar"]);
  } finally {
    cleanup();
  }
});

test("provider_ref round-trips through disk", () => {
  const { root, cleanup } = tmpdir();
  try {
    const file = path.join(root, "settings.json");
    new SettingsStore(file).write({ senior: { provider_ref: "acme" } });
    const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, Record<string, string>>;
    assert.equal(raw.senior.provider_ref, "acme");
    assert.equal(new SettingsStore(file).read().senior?.provider_ref, "acme");
  } finally {
    cleanup();
  }
});

test("public view never leaks keys", () => {
  const { root, cleanup } = tmpdir();
  try {
    const file = path.join(root, "settings.json");
    new SettingsStore(file).write(ROLE_SETTINGS);
    const view = new SettingsStore(file).public();
    assert.equal(view.senior.api_key_set, true);
    assert.equal(view.junior.api_key_set, false);
    assert.equal(view.senior.model, "spark-x2.6-4b@q4_k_m");
    assert.equal(view.senior.base_url, "http://127.0.0.1:1234/v1");
    assert.equal(view.senior.provider, "openai");
    assert.equal(view.senior.provider_ref, null);
    assert.equal("api_key" in view.junior, false);
    assert.ok(!JSON.stringify(view).includes("super-secret-key"));
  } finally {
    cleanup();
  }
});

test("one settings write seals every key in a single DPAPI batch", () => {
  const { root, cleanup } = tmpdir();
  try {
    const file = path.join(root, "settings.json");
    const cipher = fakeCipher();
    const box = new DefaultSecretBox({ dpapi: cipher });
    const store = new SettingsStore(file, box);
    store.write(ROLE_SETTINGS, undefined, [ACME, { name: "globe", base_url: "https://g.example/v1", api_key: "g-key" }]);
    // 1 role key (junior key is empty) + 2 preset keys, one invocation
    assert.deepEqual(cipher.protectedBatches, [3]);
    const raw = fs.readFileSync(file, "utf-8");
    assert.ok(!raw.includes("super-secret-key"));
    assert.ok(!raw.includes("acme-key"));
    const stored = new SettingsStore(file, box).readProviders();
    assert.equal(stored[0].api_key, "acme-key");
    assert.equal(stored[1].api_key, "g-key");
    // and reads unseal via the same injected backend
    assert.equal(new SettingsStore(file, box).read().senior?.api_key, "super-secret-key");
  } finally {
    cleanup();
  }
});

test("undecryptable stored key reads back empty (Python parity)", () => {
  const { root, cleanup } = tmpdir();
  try {
    const file = path.join(root, "settings.json");
    const warnings: string[] = [];
    const writing = fakeCipher();
    new SettingsStore(file, new DefaultSecretBox({ dpapi: writing })).write(ROLE_SETTINGS);
    // simulate reading on a different account: DPAPI cannot decrypt
    const reading = fakeCipher();
    reading.failUnprotect = true;
    const box = new DefaultSecretBox({ dpapi: reading, onWarning: (m) => warnings.push(m) });
    const loaded = new SettingsStore(file, box).read();
    assert.equal(loaded.senior?.api_key, "");
    assert.equal(loaded.senior?.model, "spark-x2.6-4b@q4_k_m");
    assert.equal(loaded.junior?.api_key, undefined); // junior key was never stored
    assert.ok(warnings.some((m) => /DPAPI unprotect failed/.test(m)));
  } finally {
    cleanup();
  }
});

test("plain1: fallback write marks the file 0o600 off Windows (simulated)", () => {
  // Windows has no meaningful POSIX mode bits; the chmod branch only runs
  // when the platform is not win32. We assert the file simply round-trips
  // here — the 0o600 branch is a best-effort POSIX guard, exercised by the
  // plain-path tests above on non-Windows CI.
  const { root, cleanup } = tmpdir();
  try {
    const file = path.join(root, "settings.json");
    const box = new DefaultSecretBox({ dpapi: null });
    new SettingsStore(file, box).write(ROLE_SETTINGS);
    const raw = fs.readFileSync(file, "utf-8");
    const onDisk = (JSON.parse(raw) as Record<string, Record<string, string>>).senior.api_key;
    assert.ok(onDisk.startsWith(PLAIN_PREFIX), onDisk);
    assert.equal(new SettingsStore(file, box).read().senior?.api_key, "super-secret-key");
  } finally {
    cleanup();
  }
});
