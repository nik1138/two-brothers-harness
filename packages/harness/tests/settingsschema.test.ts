/**
 * Settings document schema versioning and downgrade safety.
 *
 * A legacy file without `version` reads exactly like before and normalizes to
 * v1 on the next write; every write path stamps `version: 1`; a document from
 * a newer release reads its known sections but refuses every write with
 * `SettingsSchemaVersionError` (never a partial downgrade); invalid versions
 * read fail-soft. Unknown top-level sections survive a v0/v1 write.
 *
 * Run with: node tests/run-all.ts (or node --test tests/)
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import {
  APPROVAL_POLICY_SECTION,
  COMPACTION_SECTION,
  SETTINGS_SCHEMA_VERSION,
  SettingsReadOnlyError,
  SettingsSchemaVersionError,
  SettingsStore,
} from "../src/settings_store.ts";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function tmpdir(): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-settings-schema-"));
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function readRaw(file: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, any>;
}

const PAIR = "write\u0000hello.txt";
const SHELL_PAIR = "shell\u0000echo hi";

const ACME = {
  name: "acme",
  base_url: "https://acme.example/v1",
  api_key: "acme-key",
  kind: "openai-compatible",
  models: ["acme-model"],
};

const ROLE_SETTINGS = {
  senior: {
    provider: "openai",
    model: "senior-model",
    base_url: "http://127.0.0.1:1234/v1",
    api_key: "senior-key",
  },
  junior: { provider: "openai", model: "junior-model" },
};

// ---------------------------------------------------------------------------
// legacy (v0) and current (v1)
// ---------------------------------------------------------------------------

test("legacy v0 reads exactly as before; the next write adds version 1", () => {
  const { root, cleanup } = tmpdir();
  try {
    const file = path.join(root, "settings.json");
    const legacy = {
      senior: {
        provider: "openai",
        model: "legacy-senior",
        base_url: "http://127.0.0.1:1234/v1",
        api_key: "legacy-key",
        provider_ref: "acme",
      },
      junior: { model: "legacy-junior" },
      plugins: [{ path: "notes", options: { topic: "legacy" } }, "calendar"],
      providers: [{ ...ACME }],
      approvals: { "s1.jsonl": [PAIR] },
      approval_policy: { mode: "readonly" },
      compaction: { threshold_chars: 12000, context_window: 8000 },
      future_extension: { keep: [1, 2, 3] },
    };
    fs.writeFileSync(file, JSON.stringify(legacy), "utf-8");

    const store = new SettingsStore(file);
    assert.deepEqual(store.read(), {
      senior: {
        provider: "openai",
        model: "legacy-senior",
        base_url: "http://127.0.0.1:1234/v1",
        api_key: "legacy-key",
        provider_ref: "acme",
      },
      junior: { model: "legacy-junior" },
    });
    assert.deepEqual(store.readPlugins(), legacy.plugins);
    assert.deepEqual(store.readProviders(), [{ ...ACME }]);
    assert.deepEqual(store.readSessionApprovals("s1.jsonl"), [PAIR]);
    assert.equal(store.readApprovalPolicy(), "readonly");
    assert.deepEqual(store.readCompaction(), { threshold_chars: 12000, context_window: 8000 });
    assert.deepEqual(store.schemaState(), {
      version: null,
      supported: SETTINGS_SCHEMA_VERSION,
      writable: true,
    });

    // The first save stamps v1 and keeps every section (including the
    // same-version extension this release does not know).
    store.write(ROLE_SETTINGS);
    const raw = readRaw(file);
    assert.equal(raw.version, SETTINGS_SCHEMA_VERSION);
    assert.deepEqual(raw.approvals, legacy.approvals);
    assert.deepEqual(raw.approval_policy, legacy.approval_policy);
    assert.deepEqual(raw.compaction, legacy.compaction);
    assert.deepEqual(raw.plugins, legacy.plugins);
    assert.deepEqual(raw.future_extension, legacy.future_extension);
    assert.equal(new SettingsStore(file).read().senior?.api_key, "senior-key");
    assert.deepEqual(new SettingsStore(file).schemaState(), {
      version: 1,
      supported: 1,
      writable: true,
    });
  } finally {
    cleanup();
  }
});

test("v1 round-trips and every write path keeps version 1", () => {
  const { root, cleanup } = tmpdir();
  try {
    const file = path.join(root, "settings.json");
    const store = new SettingsStore(file);

    store.write(ROLE_SETTINGS, ["notes"], [ACME]);
    assert.equal(readRaw(file).version, 1);

    store.writeApprovalPolicy("edits");
    assert.equal(readRaw(file).version, 1);

    store.writeCompaction({ threshold_chars: 12000, context_window: 8000 });
    assert.equal(readRaw(file).version, 1);

    assert.deepEqual(store.addSessionApproval("s1.jsonl", PAIR), [PAIR]);
    assert.equal(readRaw(file).version, 1);

    assert.equal(store.clearSessionApprovals("s1.jsonl"), true);
    assert.equal(readRaw(file).version, 1);

    const fresh = new SettingsStore(file);
    assert.deepEqual(fresh.schemaState(), { version: 1, supported: 1, writable: true });
    assert.equal(fresh.read().senior?.model, "senior-model");
    assert.deepEqual(fresh.readPlugins(), ["notes"]);
    assert.equal(fresh.readProviders()[0].api_key, "acme-key");
    assert.equal(fresh.readApprovalPolicy(), "edits");
    assert.deepEqual(fresh.readCompaction(), { threshold_chars: 12000, context_window: 8000 });
    assert.deepEqual(fresh.readSessionApprovals("s1.jsonl"), []);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// future version (downgrade safety)
// ---------------------------------------------------------------------------

test("future version reads known sections but every write refuses and leaves bytes unchanged", () => {
  const { root, cleanup } = tmpdir();
  try {
    const file = path.join(root, "settings.json");
    const future = {
      version: 2,
      senior: {
        provider: "openai",
        model: "future-senior",
        base_url: "http://127.0.0.1:4321/v1",
        api_key: "future-key",
        provider_ref: "acme",
      },
      junior: { model: "future-junior" },
      plugins: ["notes"],
      providers: [{ ...ACME }],
      approvals: { "s1.jsonl": [PAIR, SHELL_PAIR] },
      approval_policy: { mode: "readonly" },
      compaction: { threshold_chars: 12000, context_window: 8000 },
      future_extension: { from: "newer-release" },
    };
    fs.writeFileSync(file, JSON.stringify(future), "utf-8");

    const store = new SettingsStore(file);
    // Known sections still read tolerantly...
    assert.equal(store.read().senior?.model, "future-senior");
    assert.equal(store.read().senior?.api_key, "future-key");
    assert.equal(store.read().junior?.model, "future-junior");
    assert.deepEqual(store.readPlugins(), ["notes"]);
    assert.equal(store.readProviders()[0].api_key, "acme-key");
    assert.deepEqual(store.readSessionApprovals("s1.jsonl"), [PAIR, SHELL_PAIR]);
    assert.equal(store.readApprovalPolicy(), "readonly");
    assert.deepEqual(store.readCompaction(), { threshold_chars: 12000, context_window: 8000 });
    assert.deepEqual(store.schemaState(), { version: 2, supported: 1, writable: false });

    const before = fs.readFileSync(file, "utf-8");
    const attempts: Array<[string, () => unknown]> = [
      ["write", () => store.write({ senior: { model: "downgraded" } })],
      ["write with plugins", () => store.write({}, ["other"])],
      ["writeApprovalPolicy", () => store.writeApprovalPolicy("allow-all")],
      ["writeCompaction", () => store.writeCompaction({ threshold_chars: 1 })],
      ["addSessionApproval", () => store.addSessionApproval("s2.jsonl", PAIR)],
      ["clearSessionApprovals", () => store.clearSessionApprovals("s1.jsonl")],
    ];
    for (const [label, attempt] of attempts) {
      assert.throws(
        attempt,
        (exc: unknown) => {
          assert.ok(exc instanceof SettingsSchemaVersionError, `${label}: ${String(exc)}`);
          assert.equal(exc.name, "SettingsSchemaVersionError");
          assert.equal(exc.version, 2);
          assert.equal(exc.supported, 1);
          assert.match(exc.message, /newer release/);
          assert.match(exc.message, /version 2/);
          assert.match(exc.message, /refusing to overwrite/);
          return true;
        },
        `${label} must refuse a future-version document`,
      );
      assert.equal(
        fs.readFileSync(file, "utf-8"),
        before,
        `${label} must not modify the newer document`,
      );
    }
    assert.equal(fs.existsSync(file + ".tmp"), false, "a refused write leaves no temp artifact");
    assert.deepEqual(store.schemaState(), { version: 2, supported: 1, writable: false });
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// invalid versions and corrupt files
// ---------------------------------------------------------------------------

test("invalid/negative/string versions read fail-soft and normalize to 1 on write", () => {
  const { root, cleanup } = tmpdir();
  try {
    const file = path.join(root, "settings.json");
    for (const version of ["2", "1", 2.5, -1, -2, null, true, [], {}, Number.NaN]) {
      fs.writeFileSync(
        file,
        JSON.stringify({ version, senior: { model: "kept" }, future_extension: "kept" }),
        "utf-8",
      );
      const store = new SettingsStore(file);
      assert.equal(store.read().senior?.model, "kept", JSON.stringify(version));
      assert.deepEqual(
        store.schemaState(),
        { version: null, supported: 1, writable: true },
        `invalid version ${JSON.stringify(version)} is legacy`,
      );
      store.write({ junior: { model: "written" } });
      const raw = readRaw(file);
      assert.equal(raw.version, 1, JSON.stringify(version));
      assert.equal(raw.future_extension, "kept");
      assert.equal(new SettingsStore(file).read().junior?.model, "written");
    }

    // Corrupt JSON is the same fail-soft legacy path (never throws); the next
    // write produces a valid v1 document.
    fs.writeFileSync(file, "{not json", "utf-8");
    const store = new SettingsStore(file);
    assert.deepEqual(store.read(), {});
    assert.deepEqual(store.readPlugins(), []);
    assert.deepEqual(store.readProviders(), []);
    assert.deepEqual(store.schemaState(), { version: null, supported: 1, writable: true });
    store.write({ senior: { model: "recovered" } });
    const raw = readRaw(file);
    assert.equal(raw.version, 1);
    assert.equal(new SettingsStore(file).read().senior?.model, "recovered");
  } finally {
    cleanup();
  }
});

test("an existing-but-unreadable document reads fail-soft but every write refuses", () => {
  const { root, cleanup } = tmpdir();
  try {
    const file = path.join(root, "settings.json");
    // Cross-platform simulation of an existing path that cannot be read as a
    // file: a directory at the settings path. The write paths must refuse
    // before touching it rather than replacing it with a v1 document.
    fs.mkdirSync(file);
    const sentinel = path.join(file, "keep.txt");
    fs.writeFileSync(sentinel, "untouched", "utf-8");

    const store = new SettingsStore(file);
    assert.deepEqual(store.read(), {}, "role reads stay fail-soft");
    assert.deepEqual(store.readPlugins(), []);
    assert.deepEqual(store.readProviders(), []);
    assert.deepEqual(store.readCompaction(), {});
    assert.deepEqual(store.readSessionApprovals("s1.jsonl"), []);
    assert.equal(store.readApprovalPolicy(), "ask");
    const state = store.schemaState();
    assert.equal(state.writable, false);
    assert.equal(state.version, null);
    assert.equal(state.supported, SETTINGS_SCHEMA_VERSION);
    assert.equal(state.readable, false);
    assert.ok((state.reason ?? "").length > 0);

    const attempts: Array<[string, () => unknown]> = [
      ["write", () => store.write({ senior: { model: "replacement" } })],
      ["writeApprovalPolicy", () => store.writeApprovalPolicy("allow-all")],
      ["writeCompaction", () => store.writeCompaction({ threshold_chars: 1 })],
      ["addSessionApproval", () => store.addSessionApproval("s1.jsonl", PAIR)],
      ["clearSessionApprovals", () => store.clearSessionApprovals("s1.jsonl")],
    ];
    for (const [label, attempt] of attempts) {
      assert.throws(
        attempt,
        (exc: unknown) => {
          assert.ok(exc instanceof SettingsReadOnlyError, `${label}: ${String(exc)}`);
          assert.equal(exc.name, "SettingsReadOnlyError");
          assert.match(exc.message, /cannot be read/);
          assert.match(exc.message, /refusing to overwrite/);
          return true;
        },
        `${label} must refuse an unreadable document`,
      );
      assert.equal(fs.existsSync(file), true, `${label} leaves the path in place`);
      assert.equal(fs.statSync(file).isDirectory(), true, `${label} must not replace it`);
      assert.equal(fs.readFileSync(sentinel, "utf-8"), "untouched");
    }

    // Missing and syntactically corrupt documents keep their existing
    // fail-soft behavior (missing is writable; corrupt recovers on write).
    const missingFile = path.join(root, "missing-settings.json");
    const missing = new SettingsStore(missingFile);
    assert.deepEqual(missing.schemaState(), { version: null, supported: 1, writable: true });
    missing.write({ junior: { model: "created" } });
    assert.equal(new SettingsStore(missingFile).read().junior?.model, "created");

    const corruptFile = path.join(root, "corrupt-settings.json");
    fs.writeFileSync(corruptFile, "{not json", "utf-8");
    const corrupt = new SettingsStore(corruptFile);
    assert.deepEqual(corrupt.schemaState(), { version: null, supported: 1, writable: true });
    corrupt.write({ junior: { model: "recovered" } });
    assert.equal(new SettingsStore(corruptFile).read().junior?.model, "recovered");
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// same-version extensions and section preservation
// ---------------------------------------------------------------------------

test("unknown top-level sections survive v0 and v1 writes", () => {
  const { root, cleanup } = tmpdir();
  try {
    const file = path.join(root, "settings.json");
    for (const version of [undefined, 1]) {
      const document: Record<string, unknown> = {
        senior: { model: "kept" },
        future_section: { nested: ["a", 1, true] },
        another_extension: "value",
      };
      if (version !== undefined) document.version = version;
      fs.writeFileSync(file, JSON.stringify(document), "utf-8");

      const store = new SettingsStore(file);
      store.write({ junior: { model: "written" } });
      let raw = readRaw(file);
      assert.equal(raw.version, 1);
      assert.deepEqual(raw.future_section, { nested: ["a", 1, true] });
      assert.equal(raw.another_extension, "value");

      // Every other write path reads/mutates the whole document, so unknown
      // sections survive those too.
      store.writeApprovalPolicy("edits");
      store.writeCompaction({ threshold_chars: 100 });
      store.addSessionApproval("s1.jsonl", PAIR);
      raw = readRaw(file);
      assert.equal(raw.version, 1);
      assert.deepEqual(raw.future_section, { nested: ["a", 1, true] });
      assert.equal(raw.another_extension, "value");
    }
  } finally {
    cleanup();
  }
});

test("v1 saves still preserve approvals, policy, compaction, plugins and providers", () => {
  const { root, cleanup } = tmpdir();
  try {
    const file = path.join(root, "settings.json");
    const store = new SettingsStore(file);
    store.write(ROLE_SETTINGS, ["notes"], [ACME]);
    store.addSessionApproval("s1.jsonl", PAIR);
    store.writeApprovalPolicy("readonly");
    store.writeCompaction({ threshold_chars: 12000, context_window: 8000 });

    // A plain role-settings save must not wipe any sibling section.
    store.write({ senior: { model: "updated" } });
    const fresh = new SettingsStore(file);
    assert.equal(fresh.read().senior?.model, "updated");
    assert.deepEqual(fresh.readPlugins(), ["notes"]);
    assert.equal(fresh.readProviders()[0].api_key, "acme-key");
    assert.deepEqual(fresh.readSessionApprovals("s1.jsonl"), [PAIR]);
    assert.equal(fresh.readApprovalPolicy(), "readonly");
    assert.deepEqual(fresh.readCompaction(), { threshold_chars: 12000, context_window: 8000 });

    // And the section-specific writes keep the roles/plugins/providers too.
    store.writeApprovalPolicy("allow-all");
    store.writeCompaction({ threshold_tokens: 4000 });
    store.clearSessionApprovals("s1.jsonl");
    const again = new SettingsStore(file);
    assert.equal(again.read().senior?.model, "updated");
    assert.deepEqual(again.readPlugins(), ["notes"]);
    assert.equal(again.readProviders()[0].name, "acme");
    assert.equal(again.readApprovalPolicy(), "allow-all");
    assert.deepEqual(again.readCompaction(), { threshold_tokens: 4000 });
    const raw = readRaw(file);
    assert.equal(raw.version, 1);
    assert.equal(Object.hasOwn(raw, "approvals"), false, "an empty approvals section is removed");
    assert.deepEqual(Object.keys(raw).sort(), [
      APPROVAL_POLICY_SECTION,
      COMPACTION_SECTION,
      "plugins",
      "providers",
      "senior",
      "version",
    ]);
  } finally {
    cleanup();
  }
});
