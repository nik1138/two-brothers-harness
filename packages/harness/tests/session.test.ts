/**
 * Session persistence tests. Mirrors the original prototype's suite (removed
 * 2026-11-04; see git history).
 * Run with: node tests/run-all.ts  (or node --test tests/)
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { resolveConfig } from "../src/config.ts";
import { SharedContext } from "../src/context.ts";
import { TwoBrothersHarness } from "../src/harness.ts";
import { restoreContext, SessionError, SessionStore } from "../src/session.ts";
import { createMessage } from "../src/protocol.ts";

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "two-brothers-session-"));
}

function mockHarness() {
  return new TwoBrothersHarness(resolveConfig({ provider: "mock", mode: "consult" }));
}

test("session file is created and holds every envelope as JSONL", async () => {
  const dir = tmpdir();
  try {
    const file = path.join(dir, "s.jsonl");
    const store = new SessionStore(file);
    assert.equal(store.exists(), false);

    const ctx = new SharedContext(store);
    const harness = mockHarness();
    await harness.run("First task", ctx);

    assert.equal(store.exists(), true);
    const events = store.load();
    assert.equal(events.length, 5);
    assert.deepEqual(events.map((e) => e.seq), [1, 2, 3, 4, 5]);
    assert.equal(events[0].kind, "message");
    assert.equal(events[0].payload.text, "First task");
    assert.equal(events[4].kind, "decision");
    for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
      if (line.trim()) assert.ok(JSON.parse(line));
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("restore_context rebuilds a validated context without duplicating lines", async () => {
  const dir = tmpdir();
  try {
    const store = new SessionStore(path.join(dir, "s.jsonl"));
    const ctx = new SharedContext(store);
    ctx.makeAndAppend("user", "senior", "message", { text: "task" });
    ctx.makeAndAppend("senior", "user", "decision", { decision: "final" });

    const restored = restoreContext(store);
    assert.equal(restored.events.length, 2);
    assert.deepEqual(restored.events, ctx.events);
    // resuming must not write the loaded events back
    assert.equal(store.load().length, 2);
    restored.makeAndAppend("user", "senior", "message", { text: "more" });
    assert.equal(store.load().length, 3);
    assert.deepEqual(restored.events.map((e) => e.seq), [1, 2, 3]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resume continues the cooperation loop with dense seq numbering", async () => {
  const dir = tmpdir();
  try {
    const store = new SessionStore(path.join(dir, "s.jsonl"));
    const first = mockHarness();
    await first.run("task one", new SharedContext(store));

    const restored = restoreContext(store);
    const second = mockHarness();
    const result = await second.run("task two", restored);

    // first session: 5 events, second run appends its own 5 (message included)
    assert.equal(restored.events.length, 10);
    assert.deepEqual(
      restored.events.map((e) => e.seq),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    );
    assert.deepEqual(
      result.messages.map((m) => m.kind),
      ["message", "consult", "proposal", "review", "decision"],
    );
    assert.equal(store.load().length, 10);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("load on a missing file returns empty; corrupt file raises SessionError", () => {
  const dir = tmpdir();
  try {
    const missing = new SessionStore(path.join(dir, "nope.jsonl"));
    assert.deepEqual(missing.load(), []);

    const file = path.join(dir, "bad.jsonl");
    fs.writeFileSync(file, '{"v": 1}\nnot json\n', "utf-8");
    assert.throws(() => new SessionStore(file).load(), SessionError);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("restore rejects a structurally invalid envelope", () => {
  const dir = tmpdir();
  try {
    const file = path.join(dir, "invalid.jsonl");
    const bad = createMessage(1, "senior", "junior", "nope", { task: "t", ask: "a" });
    fs.writeFileSync(file, JSON.stringify(bad) + "\n", "utf-8");
    assert.throws(() => restoreContext(new SessionStore(file)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a torn final line raises SessionError (crashed mid-append)", () => {
  const dir = tmpdir();
  try {
    const file = path.join(dir, "torn.jsonl");
    const good = createMessage(1, "user", "senior", "message", { text: "task" });
    fs.writeFileSync(
      file,
      JSON.stringify(good) + "\n" + '{"v":1,"id":"msg-torn","seq":2,"ts":"2026-',
      "utf-8",
    );
    assert.throws(() => new SessionStore(file).load(), SessionError);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("session config defaults to no session file and no resume", () => {
  const prevFile = process.env.TWO_BROTHERS_SESSION_FILE;
  const prevResume = process.env.TWO_BROTHERS_RESUME;
  delete process.env.TWO_BROTHERS_SESSION_FILE;
  delete process.env.TWO_BROTHERS_RESUME;
  try {
    const cfg = resolveConfig();
    assert.equal(cfg.sessionFile, "");
    assert.equal(cfg.resume, false);
  } finally {
    if (prevFile === undefined) delete process.env.TWO_BROTHERS_SESSION_FILE;
    else process.env.TWO_BROTHERS_SESSION_FILE = prevFile;
    if (prevResume === undefined) delete process.env.TWO_BROTHERS_RESUME;
    else process.env.TWO_BROTHERS_RESUME = prevResume;
  }
});

test("session config env override", () => {
  const prevFile = process.env.TWO_BROTHERS_SESSION_FILE;
  const prevResume = process.env.TWO_BROTHERS_RESUME;
  process.env.TWO_BROTHERS_SESSION_FILE = "x.jsonl";
  process.env.TWO_BROTHERS_RESUME = "true";
  try {
    const cfg = resolveConfig();
    assert.equal(cfg.sessionFile, "x.jsonl");
    assert.equal(cfg.resume, true);
  } finally {
    if (prevFile === undefined) delete process.env.TWO_BROTHERS_SESSION_FILE;
    else process.env.TWO_BROTHERS_SESSION_FILE = prevFile;
    if (prevResume === undefined) delete process.env.TWO_BROTHERS_RESUME;
    else process.env.TWO_BROTHERS_RESUME = prevResume;
  }
});
