/**
 * Output bounding and sanitizing tests: boundOutput head/tail windows,
 * sanitizeOutput ANSI/control-char stripping, and the workspace/shell
 * integration points (read_file bounding, shell ANSI sanitizing).
 *
 * Run with: node tests/run-all.ts (or node --test tests/)
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { boundOutput, sanitizeOutput, resultSize } from "../src/output.ts";
import {
  DEFAULT_MAX_CHARS,
  MAX_LIST_ENTRIES,
  MAX_SEARCH_RESULT_CHARS,
  Workspace,
} from "../src/workspace.ts";
import {
  Decision,
  PermissionManager,
  StaticBroker,
} from "../src/permissions.ts";

function removeTempDirSync(root: string): void {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
      return;
    } catch (exc) {
      const code = (exc as NodeJS.ErrnoException).code;
      if (
        attempt === 49 ||
        (code !== "EPERM" && code !== "EBUSY" && code !== "ENOTEMPTY")
      ) {
        throw exc;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}

function tmpdir(): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-out-"));
  return { root, cleanup: () => removeTempDirSync(root) };
}

const approved = (root: string): Workspace =>
  new Workspace(root, new PermissionManager(null, new StaticBroker(Decision.ALLOW)));

// ---------------------------------------------------------------------------
// boundOutput
// ---------------------------------------------------------------------------

test("boundOutput keeps head and tail with a middle marker", () => {
  const text = "a".repeat(50) + "MIDDLE" + "z".repeat(50);
  const result = boundOutput(text, 40);
  assert.equal(result.truncated, true);
  assert.equal(result.omittedChars, 66);
  assert.ok(result.text.startsWith("a".repeat(20)));
  assert.ok(result.text.endsWith("z".repeat(20)));
  assert.ok(result.text.includes("\n...[truncated 66 chars]...\n"));
  // marker carries the omitted count
  assert.ok(result.text.indexOf("MIDDLE") === -1);
});

test("boundOutput passes exact-cap and under-cap text through untouched", () => {
  const exact = "x".repeat(100);
  const atCap = boundOutput(exact, 100);
  assert.equal(atCap.truncated, false);
  assert.equal(atCap.text, exact);
  assert.equal(atCap.omittedChars, 0);

  const short = boundOutput("hello\nworld\n", 12);
  assert.equal(short.truncated, false);
  assert.equal(short.text, "hello\nworld\n");
});

test("boundOutput marker matches the shell truncation style", () => {
  const result = boundOutput("q".repeat(10_000), 100);
  assert.match(result.text, /\n\.\.\.\[truncated 9900 chars\]\.\.\.\n/);
});

test("boundOutput splits the cap evenly between head and tail", () => {
  const text = "h".repeat(30) + "t".repeat(30);
  const result = boundOutput(text, 20);
  const [head, tail] = result.text.split("\n...[truncated 40 chars]...\n");
  assert.equal(head, "h".repeat(10));
  assert.equal(tail, "t".repeat(10));
});

// ---------------------------------------------------------------------------
// sanitizeOutput
// ---------------------------------------------------------------------------

test("sanitizeOutput strips ANSI CSI color sequences", () => {
  assert.equal(sanitizeOutput("\x1b[31mred\x1b[0m plain\n"), "red plain\n");
  assert.equal(sanitizeOutput("\x1b[1;42mbold\x1b[m\n"), "bold\n");
});

test("sanitizeOutput strips OSC title sequences", () => {
  assert.equal(sanitizeOutput("\x1b]0;window title\x07after\n"), "after\n");
  assert.equal(sanitizeOutput("\x1b]8;;http://x\x1b\\link\n"), "link\n");
});

test("sanitizeOutput removes control characters but keeps tab and newline", () => {
  const junk = "a\x00b\x07c\x0bd\re\x7ff\tg\n";
  const cleaned = sanitizeOutput(junk);
  assert.equal(cleaned.includes("\x00"), false);
  assert.equal(cleaned.includes("\x07"), false);
  assert.equal(cleaned.includes("\x0b"), false);
  assert.ok(cleaned.includes("\t"));
  assert.ok(cleaned.includes("\n"));
  assert.ok(cleaned.startsWith("a"));
  assert.ok(cleaned.includes("f"));
});

test("sanitizeOutput leaves clean text untouched", () => {
  const clean = "hello world\nline two\n\ttabbed\n";
  assert.equal(sanitizeOutput(clean), clean);
});

// ---------------------------------------------------------------------------
// resultSize
// ---------------------------------------------------------------------------

test("resultSize measures the serialized form", () => {
  assert.equal(resultSize({ a: 1 }), JSON.stringify({ a: 1 }).length);
  assert.equal(resultSize("x"), 3);
});

// ---------------------------------------------------------------------------
// workspace integration
// ---------------------------------------------------------------------------

test("read_file of a 100k file returns bounded content and a truncated marker", async () => {
  const { root, cleanup } = tmpdir();
  try {
    fs.writeFileSync(path.join(root, "big.txt"), "0123456789".repeat(10_000), "utf-8");
    const ws = new Workspace(root);
    const result = await ws.read_file("big.txt");
    assert.equal(result.status, "ok");
    assert.equal(result.truncated, true);
    const content = String(result.content);
    assert.ok(content.includes(`\n...[truncated ${100_000 - DEFAULT_MAX_CHARS} chars]...\n`));
    assert.ok(content.length < DEFAULT_MAX_CHARS + 100);
    // head and tail of the file survive
    assert.ok(content.startsWith("0123456789"));
    assert.ok(content.endsWith("0123456789"));
  } finally {
    cleanup();
  }
});

test("read_file of a small file stays exact (cap does not bite)", async () => {
  const { root, cleanup } = tmpdir();
  try {
    fs.writeFileSync(path.join(root, "small.txt"), "exact content\n", "utf-8");
    const ws = new Workspace(root);
    const result = await ws.read_file("small.txt");
    assert.equal(result.truncated, false);
    assert.equal(result.content, "exact content\n");
  } finally {
    cleanup();
  }
});

test("list_dir caps entries at MAX_LIST_ENTRIES with a truncated marker", async () => {
  const { root, cleanup } = tmpdir();
  try {
    for (let i = 0; i < MAX_LIST_ENTRIES + 25; i++) {
      fs.writeFileSync(path.join(root, `f${String(i).padStart(4, "0")}.txt`), "x", "utf-8");
    }
    const ws = new Workspace(root);
    const result = await ws.list_dir(".");
    assert.equal(result.status, "ok");
    assert.equal(result.truncated, true);
    assert.equal(result.omitted_entries, 25);
    assert.equal((result.entries as unknown[]).length, MAX_LIST_ENTRIES);
    // entries stay structured
    const first = (result.entries as Array<Record<string, unknown>>)[0];
    assert.equal(typeof first.name, "string");
    assert.equal(first.type, "file");
  } finally {
    cleanup();
  }
});

test("list_dir under the entry cap has no truncated marker", async () => {
  const { root, cleanup } = tmpdir();
  try {
    fs.writeFileSync(path.join(root, "a.txt"), "x", "utf-8");
    const ws = new Workspace(root);
    const result = await ws.list_dir(".");
    assert.equal(result.truncated, undefined);
    assert.equal(result.omitted_entries, undefined);
  } finally {
    cleanup();
  }
});

test("search_text aggregate result is bounded at MAX_SEARCH_RESULT_CHARS", async () => {
  const { root, cleanup } = tmpdir();
  try {
    // 400 matches of ~120 chars each blow past a 20k aggregate cap well
    // before the default 50-match limit would
    const lines: string[] = [];
    for (let i = 0; i < 400; i++) lines.push(`hit ${i} ${"y".repeat(120)}`);
    fs.writeFileSync(path.join(root, "hay.txt"), lines.join("\n"), "utf-8");
    const ws = new Workspace(root);
    const result = await ws.search_text("hit", ".", 400);
    assert.equal(result.status, "ok");
    assert.equal(result.truncated, true);
    const matches = result.matches as Array<Record<string, unknown>>;
    assert.ok(matches.length < 400);
    assert.ok(Number(result.omitted_matches) > 0);
    // the kept matches still fit the aggregate cap
    assert.ok(resultSize({ matches }) <= MAX_SEARCH_RESULT_CHARS + 500);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// shell integration
// ---------------------------------------------------------------------------

test("shell output with ANSI codes is sanitized", async () => {
  const { root, cleanup } = tmpdir();
  try {
    const ws = approved(root);
    const cmd = `"${process.execPath}" -e "process.stdout.write('\\x1b[31mred\\x1b[0m\\x07\\n')"`;
    const result = await ws.run_shell(cmd);
    assert.equal(result.status, "ok");
    const stdout = String(result.stdout);
    assert.ok(stdout.includes("red"));
    assert.equal(stdout.includes("\x1b"), false);
    assert.equal(stdout.includes("\x07"), false);
  } finally {
    cleanup();
  }
});

test("shell output stays truncated-and-sanitized under the 20k cap", async () => {
  const { root, cleanup } = tmpdir();
  try {
    const ws = approved(root);
    const cmd = `"${process.execPath}" -e "console.log(('\\x1b[32m' + 'x'.repeat(50000) + '\\x1b[0m'))"`;
    const result = await ws.run_shell(cmd);
    assert.equal(result.truncated, true);
    const stdout = String(result.stdout);
    assert.ok(stdout.includes("[truncated"));
    assert.ok(stdout.length < 20_500);
    assert.equal(stdout.includes("\x1b"), false);
  } finally {
    cleanup();
  }
});
