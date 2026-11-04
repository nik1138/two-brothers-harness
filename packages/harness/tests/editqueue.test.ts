/**
 * Fuzzy edit matching + per-file mutation queue tests.
 *
 * The edit semantics are ported from pi's coding-agent (`edit-diff.ts` /
 * `file-mutation-queue.ts`, MIT): exact match first, then a normalized view
 * (line endings, trailing whitespace, Unicode punctuation), then an
 * indentation-insensitive line block. Mutations of one file serialize; reads
 * stay lock-free.
 *
 * Run with: node tests/run-all.ts (or node --test tests/)
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import {
  CallbackBroker,
  Decision,
  PermissionManager,
} from "../src/permissions.ts";
import { Workspace } from "../src/workspace.ts";

function tmpdir(): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-editq-"));
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const approved = (root: string): Workspace =>
  new Workspace(root, new PermissionManager(null, new CallbackBroker(() => Decision.ALLOW)));

// ---------------------------------------------------------------------------
// fuzzy matching
// ---------------------------------------------------------------------------

test("fuzzy edit tolerates CRLF and trailing-whitespace drift", async () => {
  const { root, cleanup } = tmpdir();
  try {
    const file = path.join(root, "crlf.txt");
    fs.writeFileSync(file, "line one   \r\nline two\r\nline three\r\n", "utf-8");
    const ws = approved(root);

    const result = await ws.edit_file("crlf.txt", "line two\nline three\n", "line 2\nline 3\n");

    assert.equal(result.status, "ok");
    assert.equal(fs.readFileSync(file, "utf-8"), "line one   \r\nline 2\r\nline 3\r\n");
    const diff = result.diff as { unified: string; added_lines: number; removed_lines: number };
    assert.ok(diff.unified.startsWith("--- a/crlf.txt\n+++ b/crlf.txt\n@@ "));
    assert.equal(diff.added_lines, 2);
    assert.equal(diff.removed_lines, 2);
    assert.ok(diff.unified.includes("-line two\r\n"));
  } finally {
    cleanup();
  }
});

test("fuzzy edit tolerates trailing whitespace on a partial-line snippet", async () => {
  const { root, cleanup } = tmpdir();
  try {
    const file = path.join(root, "value.txt");
    fs.writeFileSync(file, "x = 1\nkeep\n", "utf-8");
    const ws = approved(root);

    const result = await ws.edit_file("value.txt", "x = 1  ", "x = 2");

    assert.equal(result.status, "ok");
    assert.equal(fs.readFileSync(file, "utf-8"), "x = 2\nkeep\n");
  } finally {
    cleanup();
  }
});

test("indentation drift is anchored and the replacement is re-indented", async () => {
  const { root, cleanup } = tmpdir();
  try {
    const file = path.join(root, "nested.txt");
    fs.writeFileSync(file, "def f():\n    if ready:\n        return 1\n    return 0\n", "utf-8");
    const ws = approved(root);

    const result = await ws.edit_file("nested.txt", "if ready:\n    return 1\n", "if ready:\n    return 2\n");

    assert.equal(result.status, "ok");
    assert.equal(
      fs.readFileSync(file, "utf-8"),
      "def f():\n    if ready:\n        return 2\n    return 0\n",
    );
  } finally {
    cleanup();
  }
});

test("ambiguous fuzzy match names the ambiguity", async () => {
  const { root, cleanup } = tmpdir();
  try {
    const file = path.join(root, "dup.txt");
    fs.writeFileSync(file, "x = 1   \nkeep\nx = 1   \n", "utf-8");
    const ws = approved(root);

    const result = await ws.edit_file("dup.txt", "x = 1    ", "x = 2");

    assert.equal(result.status, "error");
    const message = String(result.error);
    assert.match(message, /ambiguous/);
    assert.match(message, /2 matches/);
    assert.match(message, /lines 1, 3/);
    assert.match(message, /replace_all=true/);
    assert.equal(fs.readFileSync(file, "utf-8"), "x = 1   \nkeep\nx = 1   \n");
  } finally {
    cleanup();
  }
});

test("non-unique exact old text is rejected with a clear message", async () => {
  const { root, cleanup } = tmpdir();
  try {
    const file = path.join(root, "same.txt");
    fs.writeFileSync(file, "same\nsame\n", "utf-8");
    const ws = approved(root);

    const result = await ws.edit_file("same.txt", "same", "other");

    assert.equal(result.status, "error");
    const message = String(result.error);
    assert.match(message, /ambiguous/);
    assert.match(message, /2 matches/);
    assert.match(message, /lines 1, 2/);
    assert.equal(fs.readFileSync(file, "utf-8"), "same\nsame\n");
  } finally {
    cleanup();
  }
});

test("replace_all applies every fuzzy match", async () => {
  const { root, cleanup } = tmpdir();
  try {
    const file = path.join(root, "all.txt");
    fs.writeFileSync(file, "x = 1   \nkeep\nx = 1  \n", "utf-8");
    const ws = approved(root);

    const result = await ws.edit_file("all.txt", "x = 1    ", "y = 2", true);

    assert.equal(result.status, "ok");
    assert.equal(result.replaced, 2);
    assert.equal(fs.readFileSync(file, "utf-8"), "y = 2\nkeep\ny = 2\n");
  } finally {
    cleanup();
  }
});

test("a BOM is stripped for matching and preserved on write", async () => {
  const { root, cleanup } = tmpdir();
  try {
    const file = path.join(root, "bom.txt");
    fs.writeFileSync(file, "\uFEFFhello  \n", "utf-8");
    const ws = approved(root);

    const result = await ws.edit_file("bom.txt", "hello\n", "world\n");

    assert.equal(result.status, "ok");
    assert.equal(fs.readFileSync(file, "utf-8"), "\uFEFFworld\n");
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// per-file mutation queue
// ---------------------------------------------------------------------------

test("concurrent same-file edits apply sequentially in call order", async () => {
  const { root, cleanup } = tmpdir();
  try {
    const ws = approved(root);
    await ws.write_file("counter.txt", "0\n");

    const steps = 25;
    const edits = Array.from({ length: steps }, (_, i) =>
      ws.edit_file("counter.txt", `${i}\n`, `${i + 1}\n`),
    );
    const results = await Promise.all(edits);

    for (const result of results) assert.equal(result.status, "ok", JSON.stringify(result));
    assert.equal(fs.readFileSync(path.join(root, "counter.txt"), "utf-8"), `${steps}\n`);
  } finally {
    cleanup();
  }
});

test("write, edit, and delete on one file serialize in call order", async () => {
  const { root, cleanup } = tmpdir();
  try {
    const ws = approved(root);
    await ws.write_file("mixed.txt", "0");

    const edit = ws.edit_file("mixed.txt", "0", "1");
    const write = ws.write_file("mixed.txt", "2");
    const remove = ws.delete_file("mixed.txt");
    const results = await Promise.all([edit, write, remove]);

    assert.equal(results[0].status, "ok");
    assert.equal(results[1].status, "ok");
    assert.equal(results[2].status, "ok");
    assert.equal(fs.existsSync(path.join(root, "mixed.txt")), false);
  } finally {
    cleanup();
  }
});

test("a second same-file edit waits for the parked approval of the first", async () => {
  const { root, cleanup } = tmpdir();
  try {
    fs.writeFileSync(path.join(root, "gate.txt"), "old\n", "utf-8");
    let release: () => void = () => {};
    const gate = new Promise<Decision>((resolveGate) => {
      release = () => resolveGate(Decision.ALLOW);
    });
    let requests = 0;
    const ws = new Workspace(
      root,
      new PermissionManager(
        null,
        new CallbackBroker(() => {
          requests += 1;
          return gate;
        }),
      ),
    );

    const first = ws.edit_file("gate.txt", "old", "new");
    // Reads never take the queue: this resolves while the edit waits for approval.
    const during = await ws.read_file("gate.txt");
    assert.equal(during.content, "old\n");
    assert.equal(requests, 1);

    const second = ws.edit_file("gate.txt", "new", "newer");
    assert.equal(requests, 1, "the queued edit has not started while the first is parked");

    release();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.equal(firstResult.status, "ok");
    assert.equal(secondResult.status, "ok");
    assert.equal(fs.readFileSync(path.join(root, "gate.txt"), "utf-8"), "newer\n");
  } finally {
    cleanup();
  }
});

test("reads during concurrent edits only observe complete states", async () => {
  const { root, cleanup } = tmpdir();
  try {
    const ws = approved(root);
    await ws.write_file("states.txt", "0\n");

    const edits: Array<Promise<Record<string, unknown>>> = [];
    for (let i = 0; i < 20; i++) {
      edits.push(ws.edit_file("states.txt", `${i}\n`, `${i + 1}\n`));
      const observed = await ws.read_file("states.txt");
      assert.equal(observed.status, "ok");
      assert.match(String(observed.content), /^\d+\n$/, "a read never sees a partial write");
    }
    const results = await Promise.all(edits);
    for (const result of results) assert.equal(result.status, "ok", JSON.stringify(result));
    assert.equal(fs.readFileSync(path.join(root, "states.txt"), "utf-8"), "20\n");
  } finally {
    cleanup();
  }
});

test("the mutation queue does not weaken confinement", async () => {
  const { root, cleanup } = tmpdir();
  const outside = path.join(path.dirname(root), `tb-outside-${process.pid}.txt`);
  try {
    fs.writeFileSync(outside, "secret", "utf-8");
    fs.writeFileSync(path.join(root, ".env"), "TOKEN=x", "utf-8");
    const ws = approved(root);

    const results = await Promise.all([
      ws.edit_file("../" + path.basename(outside), "secret", "hacked"),
      ws.write_file("../" + path.basename(outside), "hacked"),
      ws.delete_file("../" + path.basename(outside)),
      ws.edit_file(".env", "TOKEN=x", "TOKEN=y"),
    ]);

    for (const result of results) assert.equal(result.status, "error", JSON.stringify(result));
    assert.equal(fs.readFileSync(outside, "utf-8"), "secret");
    assert.equal(fs.readFileSync(path.join(root, ".env"), "utf-8"), "TOKEN=x");
  } finally {
    fs.rmSync(outside, { force: true });
    cleanup();
  }
});