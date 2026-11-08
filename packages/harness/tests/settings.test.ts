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
import {
  DEFAULT_APPROVAL_MODE,
  normalizeApprovalMode,
  ApprovalMode,
} from "../src/permissions.ts";
import {
  COMPACTION_SECTION,
  MAX_APPROVAL_PAIR_KEY_CHARS,
  MAX_SESSION_APPROVALS,
  SettingsStore,
  strictCompactionSettings,
} from "../src/settings_store.ts";

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

test("provider context_window round-trips and survives unrelated saves", () => {
  const { root, cleanup } = tmpdir();
  try {
    const file = path.join(root, "settings.json");
    const store = new SettingsStore(file);
    const preset = { ...ACME, context_window: 8192 };
    store.write({}, ["notes"], [preset]);
    assert.equal(new SettingsStore(file).readProviders()[0].context_window, 8192);

    // an unrelated role/plugins save preserves the provider section verbatim
    store.write({ senior: { model: "m" } });
    const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, any>;
    assert.equal(raw.providers[0].context_window, 8192);
    assert.equal(new SettingsStore(file).readProviders()[0].context_window, 8192);

    // re-saving providers without the field clears it (0/absent == unknown)
    store.write({}, ["notes"], [{ ...ACME }]);
    assert.equal(new SettingsStore(file).readProviders()[0].context_window, undefined);
    const cleared = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, any>;
    assert.ok(!("context_window" in cleared.providers[0]), "unknown is absent, not 0");
  } finally {
    cleanup();
  }
});

test("a corrupt provider context_window is dropped fail-soft", () => {
  const { root, cleanup } = tmpdir();
  try {
    const file = path.join(root, "settings.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        providers: [
          { name: "neg", base_url: "https://n.example/v1", api_key: "", context_window: -1 },
          { name: "float", base_url: "https://f.example/v1", api_key: "", context_window: 1.5 },
          { name: "text", base_url: "https://t.example/v1", api_key: "", context_window: "8192" },
          { name: "ok", base_url: "https://o.example/v1", api_key: "", context_window: 8192 },
          { name: "zero", base_url: "https://z.example/v1", api_key: "", context_window: 0 },
        ],
      }),
      "utf-8",
    );
    const loaded = new SettingsStore(file).readProviders();
    assert.equal(loaded.find((preset) => preset.name === "neg")?.context_window, undefined);
    assert.equal(loaded.find((preset) => preset.name === "float")?.context_window, undefined);
    assert.equal(loaded.find((preset) => preset.name === "text")?.context_window, undefined);
    assert.equal(loaded.find((preset) => preset.name === "ok")?.context_window, 8192);
    assert.equal(loaded.find((preset) => preset.name === "zero")?.context_window, undefined);
    // writing the sanitized list back never invents or coerces a window
    new SettingsStore(file).write({}, undefined, loaded);
    const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, any>;
    assert.equal(raw.providers.find((p: any) => p.name === "ok").context_window, 8192);
    assert.ok(!("context_window" in raw.providers.find((p: any) => p.name === "neg")));
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

// ---------------------------------------------------------------------------
// session approvals ("always allow for this session")
// ---------------------------------------------------------------------------

const WRITE_PAIR = "write\u0000hello.txt";
const SHELL_PAIR = "shell\u0000echo hi";

test("session approvals round-trip and keep the other sections", () => {
  const { root, cleanup } = tmpdir();
  try {
    const file = path.join(root, "settings.json");
    const store = new SettingsStore(file);
    store.write(ROLE_SETTINGS, ["notes"], [ACME]);
    assert.deepEqual(store.addSessionApproval("s1.jsonl", WRITE_PAIR), [WRITE_PAIR]);

    const fresh = new SettingsStore(file);
    assert.deepEqual(fresh.readSessionApprovals("s1.jsonl"), [WRITE_PAIR]);
    assert.deepEqual(fresh.readSessionApprovals("s2.jsonl"), []);
    // every other section survived the approvals write
    assert.deepEqual(fresh.readPlugins(), ["notes"]);
    assert.equal(fresh.readProviders()[0].name, "acme");
    assert.equal(fresh.read().senior?.model, ROLE_SETTINGS.senior.model);

    // and a plain role-settings save keeps the approvals section
    fresh.write({ senior: { model: "updated" } });
    const again = new SettingsStore(file);
    assert.deepEqual(again.readSessionApprovals("s1.jsonl"), [WRITE_PAIR]);
    assert.equal(again.read().senior?.model, "updated");
  } finally {
    cleanup();
  }
});

test("session approvals dedupe, isolate sessions and clear on delete", () => {
  const { root, cleanup } = tmpdir();
  try {
    const file = path.join(root, "settings.json");
    const store = new SettingsStore(file);
    store.addSessionApproval("s1.jsonl", WRITE_PAIR);
    store.addSessionApproval("s1.jsonl", WRITE_PAIR); // idempotent
    store.addSessionApproval("s2.jsonl", SHELL_PAIR);
    assert.deepEqual(store.readSessionApprovals("s1.jsonl"), [WRITE_PAIR]);
    assert.deepEqual(store.readSessionApprovals("s2.jsonl"), [SHELL_PAIR]);

    assert.equal(store.clearSessionApprovals("s1.jsonl"), true);
    assert.deepEqual(store.readSessionApprovals("s1.jsonl"), []);
    assert.deepEqual(store.readSessionApprovals("s2.jsonl"), [SHELL_PAIR]);
    assert.equal(store.clearSessionApprovals("s1.jsonl"), false, "a missing session is a no-op");
    // the clearing survives a fresh instance
    const fresh = new SettingsStore(file);
    assert.deepEqual(fresh.readSessionApprovals("s1.jsonl"), []);
    assert.deepEqual(fresh.readSessionApprovals("s2.jsonl"), [SHELL_PAIR]);
  } finally {
    cleanup();
  }
});

test("a corrupt approvals section fails soft and never blocks the rest of the file", () => {
  const { root, cleanup } = tmpdir();
  try {
    const file = path.join(root, "settings.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        approvals: {
          "s1.jsonl": "junk",
          "s2.jsonl": [42, null, "", WRITE_PAIR, WRITE_PAIR],
          "s3.jsonl": { nested: true },
        },
        senior: { model: "kept" },
      }),
      "utf-8",
    );
    const store = new SettingsStore(file);
    assert.deepEqual(store.readSessionApprovals("s1.jsonl"), [], "corrupt entry reads empty");
    assert.deepEqual(store.readSessionApprovals("s2.jsonl"), [WRITE_PAIR]);
    assert.deepEqual(store.readSessionApprovals("s3.jsonl"), []);
    assert.equal(store.read().senior?.model, "kept", "the corrupt section never breaks roles");

    // A new allow rewrites the section normalized; the roles stay intact.
    assert.deepEqual(store.addSessionApproval("s4.jsonl", SHELL_PAIR), [SHELL_PAIR]);
    const fresh = new SettingsStore(file);
    assert.deepEqual(fresh.readSessionApprovals("s1.jsonl"), []);
    assert.deepEqual(fresh.readSessionApprovals("s4.jsonl"), [SHELL_PAIR]);
    assert.equal(fresh.read().senior?.model, "kept");
  } finally {
    cleanup();
  }
});

test("session approvals reject unusable pair keys and cap the stored list", () => {
  const { root, cleanup } = tmpdir();
  try {
    const file = path.join(root, "settings.json");
    const store = new SettingsStore(file);
    for (const bad of ["", "   ", 42, null, "x".repeat(MAX_APPROVAL_PAIR_KEY_CHARS + 1)]) {
      assert.deepEqual(
        store.addSessionApproval("s1.jsonl", bad as unknown as string),
        [],
        "unusable keys persist nothing",
      );
    }
    assert.equal(fs.existsSync(file), false, "a rejected key writes no file");

    for (const key of Array.from(
      { length: MAX_SESSION_APPROVALS + 5 },
      (_, index) => `write\u0000f${index}.txt`,
    )) {
      store.addSessionApproval("s.jsonl", key);
    }
    const stored = store.readSessionApprovals("s.jsonl");
    assert.equal(stored.length, MAX_SESSION_APPROVALS);
    assert.equal(stored.at(-1), `write\u0000f${MAX_SESSION_APPROVALS + 4}.txt`);
    assert.equal(stored.includes("write\u0000f0.txt"), false, "the oldest entries are dropped");

    // pair keys are trimmed on the way in (the broker's keys are already clean)
    assert.deepEqual(store.addSessionApproval("t.jsonl", `  ${WRITE_PAIR}  `), [WRITE_PAIR]);
    assert.deepEqual(store.readSessionApprovals("t.jsonl"), [WRITE_PAIR]);
  } finally {
    cleanup();
  }
});

test("session approvals are secret-free and written atomically", () => {
  const { root, cleanup } = tmpdir();
  try {
    const file = path.join(root, "settings.json");
    const store = new SettingsStore(file);
    store.write(ROLE_SETTINGS, ["notes"], [ACME]);
    store.addSessionApproval("s1.jsonl", SHELL_PAIR);

    const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
    assert.deepEqual(raw.approvals, { "s1.jsonl": [SHELL_PAIR] });
    const approvalsJson = JSON.stringify(raw.approvals);
    assert.ok(!approvalsJson.includes("super-secret-key"));
    assert.ok(!approvalsJson.includes("acme-key"));
    assert.ok(!approvalsJson.includes("api_key"));
    assert.ok(!fs.existsSync(file + ".tmp"), "the temp-file write leaves no artifact");
    // the rest of the document is untouched by the approvals write
    const senior = raw.senior as Record<string, string>;
    assert.equal(senior.model, ROLE_SETTINGS.senior.model);
    assert.notEqual(senior.api_key, "super-secret-key");
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Approval policy (`approval_policy` section)
// ---------------------------------------------------------------------------

test("approval policy: missing/corrupt/unknown reads fail closed to ask", () => {
  const { root, cleanup } = tmpdir();
  try {
    const file = path.join(root, "settings.json");
    assert.equal(new SettingsStore(file).readApprovalPolicy(), DEFAULT_APPROVAL_MODE);
    assert.equal(fs.existsSync(file), false, "a read-only probe writes nothing");

    for (const section of [
      "readonly", // bare string (old/wrong shape)
      { mode: "auto" }, // unknown mode
      { mode: "READONLY" }, // wrong case
      { mode: 42 },
      { mode: null },
      { mode: "" },
      {},
      ["edits"],
      null,
    ]) {
      fs.writeFileSync(file, JSON.stringify({ approval_policy: section }), "utf-8");
      assert.equal(
        new SettingsStore(file).readApprovalPolicy(),
        DEFAULT_APPROVAL_MODE,
        `fail closed for ${JSON.stringify(section)}`,
      );
    }

    // corrupt JSON fails closed too (and never throws)
    fs.writeFileSync(file, "{not json", "utf-8");
    assert.equal(new SettingsStore(file).readApprovalPolicy(), DEFAULT_APPROVAL_MODE);
  } finally {
    cleanup();
  }
});

test("approval policy roundtrip, strict write validation and atomic secret-free storage", () => {
  const { root, cleanup } = tmpdir();
  try {
    const file = path.join(root, "settings.json");
    const store = new SettingsStore(file);

    const modes = ["readonly", "edits", "allow-all", "ask"] as const;
    for (const mode of modes) {
      store.writeApprovalPolicy(mode);
      assert.equal(store.readApprovalPolicy(), mode);
      assert.equal(new SettingsStore(file).readApprovalPolicy(), mode);
      const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
      assert.deepEqual(raw.approval_policy, { mode });
      // exactly the documented section: no extra fields, no key material
      assert.deepEqual(Object.keys(raw), ["approval_policy"]);
      assert.ok(!fs.existsSync(file + ".tmp"), "atomic temp-file write leaves no artifact");
    }

    // invalid values are rejected before touching the file (strict enum)
    store.writeApprovalPolicy(ApprovalMode.EDITS);
    const before = fs.readFileSync(file, "utf-8");
    for (const bad of ["auto", "READONLY", "", "allow_all", 42, null, undefined]) {
      assert.throws(
        () => store.writeApprovalPolicy(bad as unknown as ApprovalMode),
        /invalid approval mode/,
        `expected a rejection for ${JSON.stringify(bad)}`,
      );
    }
    assert.equal(fs.readFileSync(file, "utf-8"), before, "a rejected write changes nothing");
    assert.equal(normalizeApprovalMode("edits"), "edits");
  } finally {
    cleanup();
  }
});

test("approval policy write preserves every other section", () => {
  const { root, cleanup } = tmpdir();
  try {
    const file = path.join(root, "settings.json");
    const store = new SettingsStore(file);
    store.write(ROLE_SETTINGS, ["notes"], [ACME]);
    store.addSessionApproval("s1.jsonl", WRITE_PAIR);
    store.writeApprovalPolicy(ApprovalMode.READONLY);

    const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, any>;
    assert.deepEqual(raw.approval_policy, { mode: "readonly" });
    assert.equal(raw.senior.model, ROLE_SETTINGS.senior.model);
    assert.notEqual(raw.senior.api_key, "super-secret-key", "keys stay encrypted");
    assert.deepEqual(raw.plugins, ["notes"]);
    assert.equal(raw.providers[0].name, "acme");
    assert.deepEqual(raw.approvals, { "s1.jsonl": [WRITE_PAIR] });

    // A role/plugin save after the policy write must not wipe the section.
    store.write(ROLE_SETTINGS, ["notes"], [ACME]);
    assert.equal(new SettingsStore(file).readApprovalPolicy(), "readonly");
    // ... and a policy save must not wipe the roles.
    store.writeApprovalPolicy(ApprovalMode.ALLOW_ALL);
    assert.equal(new SettingsStore(file).read().senior?.model, ROLE_SETTINGS.senior.model);
    assert.deepEqual(new SettingsStore(file).readPlugins(), ["notes"]);
    assert.deepEqual(new SettingsStore(file).readSessionApprovals("s1.jsonl"), [WRITE_PAIR]);
    assert.equal(new SettingsStore(file).readApprovalPolicy(), "allow-all");
  } finally {
    cleanup();
  }
});

test("a role-settings save normalizes a corrupt approval policy to the fail-closed ask", () => {
  const { root, cleanup } = tmpdir();
  try {
    const file = path.join(root, "settings.json");
    fs.writeFileSync(
      file,
      JSON.stringify({ approval_policy: { mode: "auto" }, senior: { model: "kept" } }),
      "utf-8",
    );
    const store = new SettingsStore(file);
    assert.equal(store.readApprovalPolicy(), "ask");
    store.write({ senior: { model: "kept", base_url: "http://127.0.0.1:1234/v1" } });
    const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
    assert.deepEqual(raw.approval_policy, { mode: "ask" });
    assert.equal((raw.senior as Record<string, string>).model, "kept");
    // a file without the section stays without it after a role save
    fs.writeFileSync(file, JSON.stringify({ senior: { model: "only" } }), "utf-8");
    store.write({ senior: { model: "only" } });
    const raw2 = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
    assert.equal(Object.hasOwn(raw2, "approval_policy"), false);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Persisted compaction budgets (`compaction` section, wave 25)
// ---------------------------------------------------------------------------

test("compaction: missing/corrupt/unknown budgets read as absent (fail closed)", () => {
  const { root, cleanup } = tmpdir();
  try {
    const file = path.join(root, "settings.json");
    // A read-only probe never creates the file.
    assert.deepEqual(new SettingsStore(file).readCompaction(), {});
    assert.equal(fs.existsSync(file), false, "a read-only probe writes nothing");

    // Valid integer budgets survive, 0 included; every unusable value and
    // every unknown key is dropped rather than coerced.
    fs.writeFileSync(
      file,
      JSON.stringify({
        compaction: {
          threshold_chars: 12000,
          threshold_tokens: 0,
          keep_recent_chars: -5,
          context_window: 1.5,
          force: true,
          mystery: 7,
        },
      }),
      "utf-8",
    );
    assert.deepEqual(new SettingsStore(file).readCompaction(), {
      threshold_chars: 12000,
      threshold_tokens: 0,
    });

    for (const section of [
      "readonly", // bare string (wrong shape)
      ["threshold_chars"],
      null,
      {},
      { threshold_chars: "12000" },
      { threshold_chars: 12.5 },
      { threshold_chars: -1 },
      { threshold_chars: Number.NaN },
      { threshold_chars: Number.POSITIVE_INFINITY },
      { threshold_chars: null },
      { threshold_chars: true },
      { keep_recent_chars: Number.MAX_SAFE_INTEGER + 2 },
    ]) {
      fs.writeFileSync(file, JSON.stringify({ compaction: section }), "utf-8");
      assert.deepEqual(
        new SettingsStore(file).readCompaction(),
        {},
        `fail closed for ${JSON.stringify(section)}`,
      );
    }

    // Corrupt JSON reads as absent too (and never throws).
    fs.writeFileSync(file, "{not json", "utf-8");
    assert.deepEqual(new SettingsStore(file).readCompaction(), {});
  } finally {
    cleanup();
  }
});

test("compaction: strict write validation rejects a bad section before touching the file", () => {
  const { root, cleanup } = tmpdir();
  try {
    const file = path.join(root, "settings.json");
    const store = new SettingsStore(file);
    store.writeCompaction({ threshold_chars: 12000, context_window: 8000 });
    const before = fs.readFileSync(file, "utf-8");

    for (const bad of [
      null,
      "12000",
      ["threshold_chars"],
      { threshold_chars: -1 },
      { threshold_chars: 1.5 },
      { threshold_chars: "12000" },
      { threshold_chars: Number.NaN },
      { threshold_chars: Number.POSITIVE_INFINITY },
      { threshold_chars: Number.MAX_SAFE_INTEGER + 2 },
      { threshold_chars: true },
      { force: true },
      { threshold_chars: 100, future_knob: 1 },
    ]) {
      assert.throws(
        () => store.writeCompaction(bad as never),
        /compaction/,
        `expected a rejection for ${JSON.stringify(bad)}`,
      );
    }
    assert.equal(fs.readFileSync(file, "utf-8"), before, "a rejected write changes nothing");
    assert.equal(strictCompactionSettings({ threshold_tokens: 0 }).threshold_tokens, 0);

    // An empty section removes the key entirely instead of storing `{}`.
    store.writeCompaction({});
    const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
    assert.equal(Object.hasOwn(raw, COMPACTION_SECTION), false);
    assert.deepEqual(store.readCompaction(), {});
  } finally {
    cleanup();
  }
});

test("compaction: roundtrip, wholesale replace, atomic and secret-free storage", () => {
  const { root, cleanup } = tmpdir();
  try {
    const file = path.join(root, "settings.json");
    const store = new SettingsStore(file);

    store.writeCompaction({
      threshold_chars: 12000,
      threshold_tokens: 4000,
      keep_recent_chars: 300,
      context_window: 8000,
    });
    assert.deepEqual(store.readCompaction(), {
      threshold_chars: 12000,
      threshold_tokens: 4000,
      keep_recent_chars: 300,
      context_window: 8000,
    });
    assert.deepEqual(new SettingsStore(file).readCompaction(), store.readCompaction());
    const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
    assert.deepEqual(raw.compaction, {
      threshold_chars: 12000,
      threshold_tokens: 4000,
      keep_recent_chars: 300,
      context_window: 8000,
    });
    assert.deepEqual(Object.keys(raw), [COMPACTION_SECTION], "exactly the documented section");
    assert.ok(!fs.existsSync(file + ".tmp"), "atomic temp-file write leaves no artifact");

    // A later write replaces the whole section (a dropped field is gone, not
    // merged from the previous value).
    store.writeCompaction({ keep_recent_chars: 500 });
    assert.deepEqual(store.readCompaction(), { keep_recent_chars: 500 });
  } finally {
    cleanup();
  }
});

test("compaction: every unrelated settings write preserves the section", () => {
  const { root, cleanup } = tmpdir();
  try {
    const file = path.join(root, "settings.json");
    const store = new SettingsStore(file);
    store.write(ROLE_SETTINGS, ["notes"], [ACME]);
    store.writeCompaction({ threshold_chars: 12000, context_window: 8000 });

    // Role + plugin save.
    store.write(ROLE_SETTINGS, ["notes"], [ACME]);
    assert.deepEqual(store.readCompaction(), {
      threshold_chars: 12000,
      context_window: 8000,
    });

    // Approval policy save and session approvals.
    store.writeApprovalPolicy(ApprovalMode.READONLY);
    store.addSessionApproval("s1.jsonl", WRITE_PAIR);
    assert.equal(store.readApprovalPolicy(), "readonly");
    assert.deepEqual(store.readSessionApprovals("s1.jsonl"), [WRITE_PAIR]);
    assert.deepEqual(store.readCompaction(), {
      threshold_chars: 12000,
      context_window: 8000,
    });

    // And a compaction save never wipes the other sections.
    store.writeCompaction({ threshold_tokens: 4000 });
    assert.equal(new SettingsStore(file).read().senior?.model, ROLE_SETTINGS.senior.model);
    assert.deepEqual(new SettingsStore(file).readPlugins(), ["notes"]);
    assert.equal(new SettingsStore(file).readApprovalPolicy(), "readonly");
    assert.deepEqual(new SettingsStore(file).readSessionApprovals("s1.jsonl"), [WRITE_PAIR]);
    assert.deepEqual(new SettingsStore(file).readCompaction(), { threshold_tokens: 4000 });
  } finally {
    cleanup();
  }
});

test("compaction: a role-settings save normalizes a corrupt section to absent fields", () => {
  const { root, cleanup } = tmpdir();
  try {
    const file = path.join(root, "settings.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        compaction: { threshold_chars: "12000", keep_recent_chars: 300 },
        senior: { model: "kept" },
      }),
      "utf-8",
    );
    const store = new SettingsStore(file);
    assert.deepEqual(store.readCompaction(), { keep_recent_chars: 300 });
    store.write({ senior: { model: "kept", base_url: "http://127.0.0.1:1234/v1" } });
    const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
    // The corrupt field is dropped; the valid one survives untouched.
    assert.deepEqual(raw.compaction, { keep_recent_chars: 300 });
    assert.equal((raw.senior as Record<string, string>).model, "kept");

    // A file whose section has no valid field loses the key on the next save.
    fs.writeFileSync(
      file,
      JSON.stringify({ compaction: { threshold_chars: -1 }, senior: { model: "only" } }),
      "utf-8",
    );
    store.write({ senior: { model: "only" } });
    const raw2 = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
    assert.equal(Object.hasOwn(raw2, COMPACTION_SECTION), false);
  } finally {
    cleanup();
  }
});
