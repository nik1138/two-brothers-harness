/**
 * Session layout v2 (`src/sessionlayout.ts`).
 *
 * Hermetic filesystem tests over temp dirs: the legacy flat store, the
 * project/session directory store, mixed reads, migration (including dry-run,
 * interrupted-copy adoption and conflicts), sidecar placement, fork targets and
 * search over both layouts. No network, no sleeps.
 * Run with: node --test tests/sessionlayout.test.ts
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { SessionMetadataStore } from "../src/metadata.ts";
import { RuntimeEventStore } from "../src/runevents.ts";
import { loadSessionDocs } from "../src/sessionsearch.ts";
import { forkSession } from "../src/sessionfork.ts";
import { sessionSidecarKey } from "../src/tui/view/todo.ts";
import {
  GLOBAL_PROJECT_KEY,
  SESSION_LAYOUT_FILE,
  SESSION_LAYOUT_VERSION,
  SESSION_LOCK_FILE,
  SESSION_LOCK_MALFORMED_GRACE_MS,
  SessionLayout,
  canonicalSessionName,
  migrateFlatSessions,
  projectKeyFor,
} from "../src/sessionlayout.ts";

const LINES = [
  '{"v": 1, "id": "a", "seq": 1, "ts": "2026-11-08T12:00:00Z", "from": "user", "to": "senior", "kind": "message", "payload": { "text": "Plan the migration" }}',
  '{"v":1,"id":"b","seq":2,"ts":"2026-11-08T12:01:00Z","from":"senior","to":"junior","kind":"delegation","payload":{"work":"check the plan"}}',
];
const RAW = LINES.join("\n") + "\n";

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "two-brothers-layout-"));
}

function cleanup(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}

function writeFlat(root: string, name: string, raw = RAW): string {
  const file = path.join(root, name);
  fs.writeFileSync(file, raw, "utf-8");
  return file;
}

function writeMeta(root: string, name: string, meta: Record<string, unknown>): string {
  const stem = name.replace(/\.jsonl$/, "");
  const file = path.join(root, `${stem}.meta.json`);
  fs.writeFileSync(file, JSON.stringify(meta, null, 2), "utf-8");
  return file;
}

test("projectKeyFor: empty path is _global", () => {
  assert.equal(projectKeyFor(null), GLOBAL_PROJECT_KEY);
  assert.equal(projectKeyFor(""), GLOBAL_PROJECT_KEY);
  assert.equal(projectKeyFor("   "), GLOBAL_PROJECT_KEY);
});

test("projectKeyFor: readable, stable and path-sensitive", () => {
  const one = projectKeyFor(path.join(os.tmpdir(), "alpha"));
  const again = projectKeyFor(path.join(os.tmpdir(), "alpha"));
  const other = projectKeyFor(path.join(os.tmpdir(), "beta"));
  assert.equal(one, again);
  assert.notEqual(one, other);
  assert.match(one, /^alpha-[0-9a-f]{8}$/);
});

test("canonicalSessionName accepts names and flattens paths", () => {
  assert.equal(canonicalSessionName("a.jsonl"), "a.jsonl");
  assert.equal(canonicalSessionName("a"), "a.jsonl");
  assert.equal(canonicalSessionName("nested/a.jsonl"), "a.jsonl");
  assert.equal(canonicalSessionName("a\\b.jsonl"), "b.jsonl");
  assert.equal(canonicalSessionName(".."), null);
  assert.equal(canonicalSessionName(".hidden"), null);
  assert.equal(canonicalSessionName(""), null);
});

test("flat store: default mode resolves legacy artifacts", () => {
  const root = tmpdir();
  try {
    writeFlat(root, "one.jsonl");
    writeMeta(root, "one.jsonl", { title: "One" });
    const layout = new SessionLayout(root);
    assert.equal(layout.mode(), "flat");
    const location = layout.resolve("one");
    assert.ok(location);
    assert.equal(location.legacy, true);
    assert.equal(location.sessionPath, path.join(root, "one.jsonl"));
    assert.equal(location.metaPath, path.join(root, "one.meta.json"));
    assert.equal(
      location.eventsPath,
      path.join(root, "runtime", "one.jsonl.events.jsonl"),
    );
    assert.deepEqual(layout.list().map((entry) => entry.name), ["one.jsonl"]);
  } finally {
    cleanup(root);
  }
});

test("dirs mode: materialize creates project/session directories", () => {
  const root = tmpdir();
  try {
    const layout = new SessionLayout(root);
    layout.setMode("dirs");
    const project = path.join(os.tmpdir(), "workspace-alpha");
    const location = layout.materialize("run.jsonl", project);
    assert.ok(location.dir);
    assert.equal(location.projectKey, projectKeyFor(project));
    assert.equal(location.sessionPath, path.join(location.dir!, "session.jsonl"));
    assert.equal(location.metaPath, path.join(location.dir!, "meta.json"));
    assert.equal(location.eventsPath, path.join(location.dir!, "events.jsonl"));
    assert.equal(fs.existsSync(location.dir!), true);
    assert.equal(fs.existsSync(location.sessionPath), false);
  } finally {
    cleanup(root);
  }
});

test("dirs mode: metadata and runtime sidecars live in the session directory", () => {
  const root = tmpdir();
  try {
    const layout = new SessionLayout(root);
    layout.setMode("dirs");
    const location = layout.materialize("side.jsonl", path.join(os.tmpdir(), "ws"));
    fs.writeFileSync(location.sessionPath, RAW, "utf-8");

    const meta = new SessionMetadataStore(root, layout).save("side", { title: "Side" });
    assert.equal(meta.title, "Side");
    assert.equal(fs.existsSync(location.metaPath), true);

    const events = new RuntimeEventStore(path.join(root, "runtime"), layout);
    events.append("side", { type: "run_status", status: "started", run_id: "r1" });
    assert.equal(fs.existsSync(location.eventsPath), true);
    assert.equal(fs.existsSync(path.join(root, "runtime")), false);
    assert.equal(events.load("side").length, 1);
  } finally {
    cleanup(root);
  }
});

test("list: both layouts are visible and a directory session wins a clash", () => {
  const root = tmpdir();
  try {
    const layout = new SessionLayout(root);
    layout.setMode("dirs");
    const location = layout.materialize("same.jsonl", path.join(os.tmpdir(), "ws"));
    fs.writeFileSync(location.sessionPath, RAW + "\n", "utf-8");
    writeFlat(root, "same.jsonl", RAW);
    writeFlat(root, "flat-only.jsonl", RAW);

    const names = layout.list().map((entry) => entry.name);
    assert.deepEqual(names, ["flat-only.jsonl", "same.jsonl"]);
    assert.equal(layout.resolve("same")?.legacy, false);
    assert.equal(layout.resolve("flat-only")?.legacy, true);
  } finally {
    cleanup(root);
  }
});

test("migration dry run writes nothing", () => {
  const root = tmpdir();
  try {
    writeFlat(root, "dry.jsonl");
    const result = migrateFlatSessions(root, { dryRun: true });
    assert.equal(result.dryRun, true);
    assert.equal(result.layout, "dirs");
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0]!.status, "migrated");
    assert.equal(fs.existsSync(path.join(root, "dry.jsonl")), true);
    assert.equal(fs.existsSync(path.join(root, SESSION_LAYOUT_FILE)), false);
  } finally {
    cleanup(root);
  }
});

test("migration moves session, metadata and events byte-exactly", () => {
  const root = tmpdir();
  try {
    const workspace = path.join(os.tmpdir(), "migrated-workspace");
    writeFlat(root, "move.jsonl");
    const metaFile = writeMeta(root, "move.jsonl", { title: "Move", workspace_id: "ws-1" });
    const metaText = fs.readFileSync(metaFile, "utf-8");
    fs.mkdirSync(path.join(root, "runtime"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "runtime", "move.jsonl.events.jsonl"),
      JSON.stringify({ type: "run_status", run_id: "r1" }) + "\n",
      "utf-8",
    );

    const result = migrateFlatSessions(root, {
      workspacePathFor: (id) => (id === "ws-1" ? workspace : null),
    });
    assert.equal(result.layout, "dirs");
    assert.equal(result.entries[0]!.status, "migrated");

    const key = projectKeyFor(workspace);
    const dir = path.join(root, key, "move");
    assert.equal(fs.readFileSync(path.join(dir, "session.jsonl"), "utf-8"), RAW);
    assert.equal(fs.readFileSync(path.join(dir, "meta.json"), "utf-8"), metaText);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf-8")).title,
      "Move",
    );
    assert.equal(fs.existsSync(path.join(dir, "events.jsonl")), true);
    assert.equal(fs.existsSync(path.join(root, "move.jsonl")), false);
    assert.equal(fs.existsSync(path.join(root, "move.meta.json")), false);
    assert.equal(fs.existsSync(path.join(root, "runtime", "move.jsonl.events.jsonl")), false);

    const marker = JSON.parse(fs.readFileSync(path.join(root, SESSION_LAYOUT_FILE), "utf-8"));
    assert.deepEqual(marker, { version: SESSION_LAYOUT_VERSION, layout: "dirs" });
    assert.equal(new SessionLayout(root).resolve("move")?.projectKey, key);
  } finally {
    cleanup(root);
  }
});

test("migration adopts an interrupted copy and is idempotent", () => {
  const root = tmpdir();
  try {
    writeFlat(root, "adopt.jsonl");
    writeMeta(root, "adopt.jsonl", { title: "Adopt" });
    const key = GLOBAL_PROJECT_KEY;
    const dir = path.join(root, key, "adopt");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "session.jsonl"), RAW, "utf-8");

    const first = migrateFlatSessions(root);
    assert.equal(first.entries[0]!.status, "already");
    assert.equal(fs.existsSync(path.join(root, "adopt.jsonl")), false);
    assert.equal(fs.existsSync(path.join(dir, "meta.json")), true);

    const second = migrateFlatSessions(root);
    assert.equal(second.entries.length, 0);
    assert.equal(new SessionLayout(root).mode(), "dirs");
  } finally {
    cleanup(root);
  }
});

test("migration removes an empty interrupted target directory", () => {
  const root = tmpdir();
  try {
    writeFlat(root, "empty-target.jsonl");
    const dir = path.join(root, GLOBAL_PROJECT_KEY, "empty-target");
    fs.mkdirSync(dir, { recursive: true });
    const dry = migrateFlatSessions(root, { dryRun: true });
    assert.equal(dry.entries[0]!.status, "migrated");
    assert.equal(fs.existsSync(dir), true, "dry run touches nothing");
    const result = migrateFlatSessions(root);
    assert.equal(result.entries[0]!.status, "migrated");
    assert.equal(fs.existsSync(path.join(dir, "session.jsonl")), true);
    assert.equal(fs.existsSync(path.join(root, "empty-target.jsonl")), false);
  } finally {
    cleanup(root);
  }
});

test("migration refuses a conflicting target and keeps the source", () => {
  const root = tmpdir();
  try {
    writeFlat(root, "clash.jsonl", RAW);
    const dir = path.join(root, GLOBAL_PROJECT_KEY, "clash");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "session.jsonl"), RAW + "different\n", "utf-8");

    const result = migrateFlatSessions(root);
    assert.equal(result.entries[0]!.status, "conflict");
    assert.equal(fs.existsSync(path.join(root, "clash.jsonl")), true);
    assert.equal(new SessionLayout(root).mode(), "flat");
  } finally {
    cleanup(root);
  }
});

test("materializeIn rejects an unsafe project key", () => {
  const root = tmpdir();
  try {
    const layout = new SessionLayout(root);
    layout.setMode("dirs");
    assert.throws(() => layout.materializeIn("x.jsonl", "../escape"), /invalid project key/);
    assert.throws(() => layout.materializeIn("x.jsonl", "a/b"), /invalid project key/);
    assert.throws(() => layout.materializeIn("x.jsonl", ".."), /invalid project key/);
  } finally {
    cleanup(root);
  }
});

test("duplicate names across projects resolve deterministically (first sorted)", () => {
  const root = tmpdir();
  try {
    for (const project of ["b-project", "a-project"]) {
      const dir = path.join(root, project, "same");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "session.jsonl"), RAW, "utf-8");
    }
    const layout = new SessionLayout(root);
    assert.equal(layout.list().find((item) => item.name === "same.jsonl")?.projectKey, "a-project");
    assert.equal(layout.resolve("same")?.projectKey, "a-project");
  } finally {
    cleanup(root);
  }
});

test("a stale malformed writer lock is reclaimed after the grace", () => {
  const root = tmpdir();
  try {
    const file = path.join(root, SESSION_LOCK_FILE);
    fs.writeFileSync(file, "{not json", "utf-8");
    const old = new Date(Date.now() - SESSION_LOCK_MALFORMED_GRACE_MS - 1_000);
    fs.utimesSync(file, old, old);
    const layout = new SessionLayout(root);
    const release = layout.acquireWriterLock("recovered");
    try {
      assert.equal(layout.writerLock()?.owner, "recovered");
      assert.equal(fs.existsSync(file), true);
    } finally {
      release();
    }
    assert.equal(fs.existsSync(file), false, "release removes the reclaimed lock");
  } finally {
    cleanup(root);
  }
});

test("a fresh malformed writer lock still refuses (a concurrent writer may be mid-write)", () => {
  const root = tmpdir();
  try {
    const file = path.join(root, SESSION_LOCK_FILE);
    fs.writeFileSync(file, "", "utf-8");
    const layout = new SessionLayout(root);
    assert.throws(
      () => layout.acquireWriterLock("late"),
      /locked by an unknown writer/,
    );
    assert.equal(fs.existsSync(file), true, "the fresh lock is left alone");
    assert.equal(fs.readFileSync(file, "utf-8"), "");
  } finally {
    cleanup(root);
  }
});

test("a writer-lock record write failure removes the just-created lock", () => {
  const root = tmpdir();
  try {
    const file = path.join(root, SESSION_LOCK_FILE);
    const failing = new SessionLayout(root, {
      lockWriteHook: () => {
        throw new Error("simulated disk full");
      },
    });
    assert.throws(() => failing.acquireWriterLock("test"), /simulated disk full/);
    assert.equal(fs.existsSync(file), false, "no empty lock is left behind");
    // The next acquisition is not wedged by the failed attempt.
    const release = new SessionLayout(root).acquireWriterLock("test");
    release();
    assert.equal(fs.existsSync(file), false);
  } finally {
    cleanup(root);
  }
});

test("migration refuses a live writer lock", () => {
  const root = tmpdir();
  try {
    writeFlat(root, "locked.jsonl");
    const layout = new SessionLayout(root);
    const release = layout.acquireWriterLock("test");
    assert.throws(
      () => migrateFlatSessions(root),
      /in use by test|locked by an unknown writer/,
    );
    release();
    const result = migrateFlatSessions(root);
    assert.equal(result.entries[0]!.status, "migrated");
  } finally {
    cleanup(root);
  }
});

test("migration refuses divergent flat sidecars on an adopted target", () => {
  const root = tmpdir();
  try {
    writeFlat(root, "divergent.jsonl");
    writeMeta(root, "divergent.jsonl", { title: "flat" });
    const dir = path.join(root, GLOBAL_PROJECT_KEY, "divergent");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "session.jsonl"), RAW, "utf-8");
    fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ title: "target" }), "utf-8");

    const result = migrateFlatSessions(root);
    assert.equal(result.entries[0]!.status, "conflict");
    assert.match(result.entries[0]!.detail ?? "", /meta\.json/);
    assert.equal(fs.existsSync(path.join(root, "divergent.jsonl")), true);
    assert.equal(new SessionLayout(root).mode(), "flat");
  } finally {
    cleanup(root);
  }
});

test("dry-run reports a non-empty target directory as a conflict", () => {
  const root = tmpdir();
  try {
    writeFlat(root, "blocked.jsonl");
    const dir = path.join(root, GLOBAL_PROJECT_KEY, "blocked");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "events.jsonl"), '{"run_id":"x"}\n', "utf-8");

    const dry = migrateFlatSessions(root, { dryRun: true });
    assert.equal(dry.entries[0]!.status, "conflict");
    const real = migrateFlatSessions(root);
    assert.equal(real.entries[0]!.status, "conflict");
    assert.equal(fs.existsSync(path.join(root, "blocked.jsonl")), true);
  } finally {
    cleanup(root);
  }
});

test("migration refuses a missing sessions directory", () => {
  const root = tmpdir();
  const missing = path.join(root, "no-such-store");
  try {
    assert.throws(() => migrateFlatSessions(missing), /not found/);
    assert.equal(fs.existsSync(missing), false);
  } finally {
    cleanup(root);
  }
});

test("fork in dirs mode stays in the source project directory", () => {
  const root = tmpdir();
  try {
    const layout = new SessionLayout(root);
    layout.setMode("dirs");
    const project = path.join(os.tmpdir(), "fork-project");
    const source = layout.materialize("source.jsonl", project);
    fs.writeFileSync(source.sessionPath, RAW, "utf-8");

    const result = forkSession(root, "source");
    assert.equal(result.name, "source-fork-1.jsonl");
    const target = layout.resolve(result.name);
    assert.ok(target);
    assert.equal(target.projectKey, source.projectKey);
    assert.equal(fs.readFileSync(target.sessionPath, "utf-8"), RAW);
    const meta = JSON.parse(fs.readFileSync(target.metaPath, "utf-8"));
    assert.deepEqual(meta.parent, { name: "source.jsonl", seq: 2 });
    assert.equal(fs.readFileSync(source.sessionPath, "utf-8"), RAW);
  } finally {
    cleanup(root);
  }
});

test("fork of a flat source in dirs mode lands under _global", () => {
  const root = tmpdir();
  try {
    const layout = new SessionLayout(root);
    layout.setMode("dirs");
    writeFlat(root, "flat-source.jsonl");

    const result = forkSession(root, "flat-source", { name: "flat-fork" });
    const target = layout.resolve(result.name);
    assert.ok(target);
    assert.equal(target.projectKey, GLOBAL_PROJECT_KEY);
    assert.equal(fs.existsSync(target.sessionPath), true);
  } finally {
    cleanup(root);
  }
});

test("event-only session directories are recoverable by findRun", () => {
  const root = tmpdir();
  try {
    const layout = new SessionLayout(root);
    layout.setMode("dirs");
    const location = layout.materialize("failed.jsonl", path.join(os.tmpdir(), "ws"));
    const events = new RuntimeEventStore(path.join(root, "runtime"), layout);
    events.append("failed", { type: "run_error", run_id: "run-failed", message: "boom" });
    assert.equal(fs.existsSync(location.sessionPath), false);
    assert.equal(layout.list().length, 0, "no transcript yet");
    const found = events.findRun("run-failed");
    assert.ok(found);
    assert.equal(found.session, "failed.jsonl");
    assert.equal(found.events[0]!.message, "boom");
  } finally {
    cleanup(root);
  }
});

test("sessionSidecarKey uses the directory stem only with a sessions root", () => {
  const dirsPath = path.join("root", "project", "alpha", "session.jsonl");
  assert.equal(sessionSidecarKey(dirsPath), "session.jsonl");
  assert.equal(sessionSidecarKey(dirsPath, "root"), "alpha.jsonl");
  assert.equal(sessionSidecarKey(path.join("root", "flat.jsonl"), "root"), "flat.jsonl");
  assert.equal(sessionSidecarKey(""), "");
});

test("the root-level spill directory is never treated as a project", () => {
  const root = tmpdir();
  try {
    const spill = path.join(root, "spill");
    fs.mkdirSync(spill, { recursive: true });
    fs.writeFileSync(path.join(spill, "abc.txt"), "tool output", "utf-8");
    const layout = new SessionLayout(root);
    assert.deepEqual(layout.list(), []);
    assert.equal(layout.resolve("abc"), null);
    assert.deepEqual(layout.listEventSessions(), []);
  } finally {
    cleanup(root);
  }
});

test("loadSessionDocs with an empty sessions dir is empty, not cwd", () => {
  assert.deepEqual(loadSessionDocs(""), { docs: [], skipped: 0, truncated: false });
});

test("loadSessionDocs reads directory sessions", () => {
  const root = tmpdir();
  try {
    const layout = new SessionLayout(root);
    layout.setMode("dirs");
    const location = layout.materialize("searchable.jsonl", path.join(os.tmpdir(), "ws"));
    fs.writeFileSync(location.sessionPath, RAW, "utf-8");
    new SessionMetadataStore(root, layout).save("searchable", { title: "Searchable" });

    const loaded = loadSessionDocs(root);
    assert.equal(loaded.docs.length, 1);
    assert.equal(loaded.docs[0]!.name, "searchable.jsonl");
    assert.equal(loaded.docs[0]!.title, "Searchable");
    assert.equal(loaded.docs[0]!.events.length, 2);
  } finally {
    cleanup(root);
  }
});
