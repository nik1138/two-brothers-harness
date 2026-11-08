/**
 * CLI `sessions migrate` (flat store -> project/session directories).
 *
 * Hermetic: `main(argv, io)` in-process against temp fixtures; no child
 * process, TTY or network. Covers the dry run, the real move (with workspace
 * grouping, metadata and runtime sidecars), JSON output, idempotence and
 * conflicts.
 *
 * Run with: node --test tests/sessionsmigrate.test.ts
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { main, type CliIO } from "../src/cli.ts";
import {
  GLOBAL_PROJECT_KEY,
  SESSION_LAYOUT_FILE,
  SessionLayout,
  projectKeyFor,
} from "../src/sessionlayout.ts";

const RAW =
  JSON.stringify({
    v: 1,
    id: "a",
    seq: 1,
    ts: "2026-11-09T00:00:00Z",
    from: "user",
    to: "senior",
    kind: "message",
    payload: { text: "hello" },
  }) + "\n";

function makeIO(): CliIO & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, log: (line) => out.push(line), error: (line) => err.push(line) };
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-sessions-migrate-"));
  try {
    await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function seedFlat(dir: string, name: string, workspaceId?: string): void {
  fs.writeFileSync(path.join(dir, name), RAW, "utf-8");
  if (workspaceId !== undefined) {
    const stem = name.replace(/\.jsonl$/, "");
    fs.writeFileSync(
      path.join(dir, `${stem}.meta.json`),
      JSON.stringify({ title: "Seeded", workspace_id: workspaceId }, null, 2),
      "utf-8",
    );
  }
}

test("sessions migrate --dry-run writes nothing", async () => {
  await withTempDir(async (dir) => {
    seedFlat(dir, "dry.jsonl");
    const io = makeIO();
    assert.equal(
      await main(["sessions", "migrate", "--sessions-dir", dir, "--dry-run"], io),
      0,
      io.err.join("\n"),
    );
    assert.ok(io.out.some((line) => line.includes("would migrate dry.jsonl")));
    assert.equal(fs.existsSync(path.join(dir, "dry.jsonl")), true);
    assert.equal(fs.existsSync(path.join(dir, SESSION_LAYOUT_FILE)), false);
  });
});

test("sessions migrate groups by workspace and moves sidecars", async () => {
  await withTempDir(async (dir) => {
    const workspace = path.join(dir, "workspace");
    fs.mkdirSync(workspace);
    fs.writeFileSync(
      path.join(dir, "workspaces.json"),
      JSON.stringify({
        workspaces: [{ id: "ws-1", name: "Workspace", path: workspace }],
      }),
      "utf-8",
    );
    seedFlat(dir, "move.jsonl", "ws-1");
    fs.mkdirSync(path.join(dir, "runtime"));
    fs.writeFileSync(
      path.join(dir, "runtime", "move.jsonl.events.jsonl"),
      '{"type":"run_status","run_id":"r1"}\n',
      "utf-8",
    );

    const io = makeIO();
    assert.equal(
      await main(["sessions", "migrate", "--sessions-dir", dir], io),
      0,
      io.err.join("\n"),
    );
    const key = projectKeyFor(workspace);
    const target = path.join(dir, key, "move");
    assert.equal(fs.readFileSync(path.join(target, "session.jsonl"), "utf-8"), RAW);
    assert.equal(fs.existsSync(path.join(target, "meta.json")), true);
    assert.equal(fs.existsSync(path.join(target, "events.jsonl")), true);
    assert.equal(fs.existsSync(path.join(dir, "move.jsonl")), false);
    assert.equal(new SessionLayout(dir).mode(), "dirs");
  });
});

test("sessions migrate --json reports entries and the new layout", async () => {
  await withTempDir(async (dir) => {
    seedFlat(dir, "plain.jsonl");
    const io = makeIO();
    assert.equal(
      await main(["sessions", "migrate", "--sessions-dir", dir, "--json"], io),
      0,
      io.err.join("\n"),
    );
    const result = JSON.parse(io.out.at(-1)!);
    assert.equal(result.layout, "dirs");
    assert.equal(result.dryRun, false);
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].name, "plain.jsonl");
    assert.equal(result.entries[0].status, "migrated");
    assert.equal(
      result.entries[0].targetPath,
      path.join(dir, GLOBAL_PROJECT_KEY, "plain", "session.jsonl"),
    );
  });
});

test("sessions migrate is idempotent on an empty flat store", async () => {
  await withTempDir(async (dir) => {
    const first = makeIO();
    assert.equal(await main(["sessions", "migrate", "--sessions-dir", dir], first), 0);
    assert.equal(fs.existsSync(path.join(dir, SESSION_LAYOUT_FILE)), true);

    const second = makeIO();
    assert.equal(await main(["sessions", "migrate", "--sessions-dir", dir], second), 0);
    assert.ok(second.out.some((line) => line.includes("no flat sessions")));
  });
});

test("sessions migrate exits 1 on a conflicting target", async () => {
  await withTempDir(async (dir) => {
    seedFlat(dir, "clash.jsonl");
    const targetDir = path.join(dir, GLOBAL_PROJECT_KEY, "clash");
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(path.join(targetDir, "session.jsonl"), RAW + "different\n", "utf-8");

    const io = makeIO();
    assert.equal(
      await main(["sessions", "migrate", "--sessions-dir", dir], io),
      1,
    );
    assert.ok(io.err.some((line) => line.includes("conflict")));
    assert.equal(fs.existsSync(path.join(dir, "clash.jsonl")), true);
    assert.equal(new SessionLayout(dir).mode(), "flat");
  });
});
