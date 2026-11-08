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
import { restoreContext, restoreContextResult, SessionError, SessionStore } from "../src/session.ts";
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

test("a torn final line is dropped and reported, never fatal", () => {
  const dir = tmpdir();
  try {
    const file = path.join(dir, "torn.jsonl");
    const good = createMessage(1, "user", "senior", "message", { text: "task" });
    const torn = '{"v":1,"id":"msg-torn","seq":2,"ts":"2026-';
    const raw = JSON.stringify(good) + "\n" + torn;
    fs.writeFileSync(file, raw, "utf-8");
    const store = new SessionStore(file);

    // Read-only load recovers the complete prefix and reports the drop.
    const loaded = store.loadDetailed();
    assert.equal(loaded.events.length, 1);
    assert.deepEqual(loaded.events[0], good);
    assert.equal(loaded.recovered, true);
    assert.equal(loaded.droppedLine, 2);
    assert.equal(loaded.droppedBytes, Buffer.byteLength(torn, "utf-8"));
    // The compatibility form stays a Message[].
    assert.deepEqual(store.load(), [good]);
    // Destructive callers (rewind) opt into the strict read.
    assert.throws(() => store.loadStrict(), SessionError);
    // A read-only load never rewrites the file.
    assert.equal(fs.readFileSync(file, "utf-8"), raw);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resume repairs a torn tail atomically and the next append stays dense", () => {
  const dir = tmpdir();
  try {
    const file = path.join(dir, "torn.jsonl");
    const first = createMessage(1, "user", "senior", "message", { text: "task" });
    const second = createMessage(2, "senior", "user", "decision", { decision: "done" });
    // BOM + CRLF + a torn third line: the repair keeps the existing bytes.
    const prefix = "\uFEFF" + JSON.stringify(first) + "\r\n" + JSON.stringify(second) + "\r\n";
    const torn = '{"v":1,"id":"msg-torn","seq":3';
    fs.writeFileSync(file, prefix + torn, "utf-8");
    const store = new SessionStore(file);

    const before = fs.statSync(file);
    store.loadDetailed(); // read-only probe
    const afterProbe = fs.statSync(file);
    assert.equal(afterProbe.size, before.size);
    assert.equal(afterProbe.mtimeMs, before.mtimeMs);

    const restored = restoreContextResult(store);
    assert.equal(restored.recovered, true);
    assert.equal(restored.droppedLine, 3);
    assert.equal(restored.droppedBytes, Buffer.byteLength(torn, "utf-8"));
    assert.deepEqual(
      restored.context.events.map((event) => event.seq),
      [1, 2],
    );
    // The file is truncated exactly to the last complete newline; BOM/CRLF
    // and the complete envelopes are byte-identical.
    assert.equal(fs.readFileSync(file, "utf-8"), prefix);
    assert.deepEqual(
      fs.readdirSync(dir).filter((name) => name.includes(".tmp-")),
      [],
      "no temp file may survive the atomic repair",
    );

    restored.context.makeAndAppend("user", "senior", "message", { text: "more" });
    const events = store.load();
    assert.deepEqual(
      events.map((event) => event.seq),
      [1, 2, 3],
    );
    const lines = fs.readFileSync(file, "utf-8").split(/\r?\n/).filter((line) => line.trim());
    assert.equal(lines.length, 3);
    for (const line of lines) assert.ok(JSON.parse(line.replace(/^\uFEFF/, "")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("repair refuses a file that changed before the rename (retryable CAS)", () => {
  const dir = tmpdir();
  try {
    const file = path.join(dir, "torn.jsonl");
    const first = createMessage(1, "user", "senior", "message", { text: "task" });
    const torn = '{"v":1,"id":"msg-torn","seq":2';
    const original = JSON.stringify(first) + "\n" + torn;
    fs.writeFileSync(file, original, "utf-8");

    // Simulate another process appending in the window between the scan and
    // the rename. The append keeps the tail unterminated, so a retry is still
    // a recoverable repair.
    const concurrent = ',"late":true';
    const store = new SessionStore(file, {
      beforeRename: () => {
        fs.appendFileSync(file, concurrent, "utf-8");
      },
    });

    let error: unknown;
    try {
      restoreContextResult(store);
    } catch (exc) {
      error = exc;
    }
    assert.ok(error instanceof SessionError, `expected SessionError, got ${String(error)}`);
    assert.equal(error.retryable, true, "a lost CAS race must be retryable");
    assert.match(error.message, /changed while repairing the torn tail/);
    assert.match(error.message, /retry/);

    // The original file is untouched - including the concurrent append that
    // caused the abort - and no temp file survives.
    assert.equal(fs.readFileSync(file, "utf-8"), original + concurrent);
    assert.deepEqual(
      fs.readdirSync(dir).filter((name) => name.includes(".tmp-")),
      [],
      "the aborted repair must clean up its temp file",
    );

    // Once nobody races, the same repair succeeds on the current bytes.
    const retried = restoreContextResult(new SessionStore(file));
    assert.equal(retried.recovered, true);
    assert.deepEqual(
      retried.context.events.map((event) => event.seq),
      [1],
    );
    assert.equal(fs.readFileSync(file, "utf-8"), JSON.stringify(first) + "\n");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("repair CAS also refuses an in-place same-size rewrite before the rename", () => {
  const dir = tmpdir();
  try {
    const file = path.join(dir, "torn.jsonl");
    const first = createMessage(1, "user", "senior", "message", { text: "task" });
    const torn = '{"v":1,"id":"msg-torn","seq":2';
    const original = JSON.stringify(first) + "\n" + torn;
    fs.writeFileSync(file, original, "utf-8");
    const sameSize = original.replace("task", "TASK");
    assert.equal(sameSize.length, original.length);
    assert.notEqual(sameSize, original);

    const store = new SessionStore(file, {
      beforeRename: () => {
        fs.writeFileSync(file, sameSize, "utf-8");
        // Guarantee a visible mtime change even on coarse filesystems.
        const future = new Date(Date.now() + 60_000);
        fs.utimesSync(file, future, future);
      },
    });

    assert.throws(
      () => restoreContextResult(store),
      (exc: unknown) => exc instanceof SessionError && exc.retryable,
    );
    assert.equal(fs.readFileSync(file, "utf-8"), sameSize);
    assert.deepEqual(
      fs.readdirSync(dir).filter((name) => name.includes(".tmp-")),
      [],
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a valid final envelope without a trailing newline is not corruption", () => {
  const dir = tmpdir();
  try {
    const file = path.join(dir, "nonewline.jsonl");
    const first = createMessage(1, "user", "senior", "message", { text: "task" });
    const second = createMessage(2, "senior", "user", "decision", { decision: "done" });
    const raw = JSON.stringify(first) + "\n" + JSON.stringify(second); // no final \n
    fs.writeFileSync(file, raw, "utf-8");
    const store = new SessionStore(file);

    const loaded = store.loadDetailed();
    assert.equal(loaded.recovered, false);
    assert.deepEqual(
      loaded.events.map((event) => event.seq),
      [1, 2],
    );
    assert.equal(fs.readFileSync(file, "utf-8"), raw, "read-only load must not rewrite");

    // Resume-for-append normalizes the missing terminator so the next
    // envelope cannot merge onto the last line.
    const restored = restoreContextResult(store);
    assert.equal(restored.recovered, false);
    assert.equal(restored.context.events.length, 2);
    assert.equal(fs.readFileSync(file, "utf-8"), raw + "\n");
    restored.context.makeAndAppend("user", "senior", "message", { text: "more" });
    assert.deepEqual(
      store.load().map((event) => event.seq),
      [1, 2, 3],
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("interior corruption still raises a line-numbered SessionError", () => {
  const dir = tmpdir();
  try {
    const file = path.join(dir, "interior.jsonl");
    const good = createMessage(1, "user", "senior", "message", { text: "task" });
    fs.writeFileSync(file, JSON.stringify(good) + "\nnot json\n" + JSON.stringify(good) + "\n", "utf-8");
    const store = new SessionStore(file);
    assert.throws(
      () => store.load(),
      (exc: unknown) =>
        exc instanceof SessionError && /line 2/.test(exc.message),
    );
    // A malformed but newline-terminated LAST line is not a torn fragment.
    const lastComplete = path.join(dir, "lastcomplete.jsonl");
    fs.writeFileSync(lastComplete, JSON.stringify(good) + "\nnot json\n", "utf-8");
    assert.throws(
      () => new SessionStore(lastComplete).load(),
      (exc: unknown) => exc instanceof SessionError && /line 2/.test(exc.message),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("empty and whitespace-only files stay valid and are not rewritten", () => {
  const dir = tmpdir();
  try {
    for (const [name, content] of [
      ["empty.jsonl", ""],
      ["newlines.jsonl", "\n"],
      ["blank.jsonl", "\n \n\t\n"],
      ["blank-no-newline.jsonl", " \n  "],
    ] as const) {
      const file = path.join(dir, name);
      fs.writeFileSync(file, content, "utf-8");
      const store = new SessionStore(file);
      const loaded = store.loadDetailed();
      assert.deepEqual(loaded.events, [], name);
      assert.equal(loaded.recovered, false, name);
      assert.equal(loaded.droppedBytes, 0, name);
      const restored = restoreContextResult(store);
      assert.deepEqual(restored.context.events, [], name);
      assert.equal(restored.recovered, false, name);
      assert.equal(fs.readFileSync(file, "utf-8"), content, `${name} must stay byte-identical`);
    }
    const missing = new SessionStore(path.join(dir, "missing.jsonl"));
    assert.deepEqual(missing.loadDetailed(), {
      events: [],
      recovered: false,
      droppedBytes: 0,
      droppedLine: 0,
    });
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
