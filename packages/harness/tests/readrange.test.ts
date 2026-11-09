/**
 * `read_file` line-range paging (`src/workspace.ts`).
 *
 * Hermetic: temp dirs under `os.tmpdir()`, cleaned up in `finally`. The
 * no-range cases pin the historical head+tail output byte-for-byte; the range
 * cases pin 1-based line windows, honest clipping and the model-facing tool
 * schema. No network, no sleeps.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import {
  DEFAULT_MAX_CHARS,
  DEFAULT_READ_LINES,
  MAX_READ_LINES,
  Workspace,
} from "../src/workspace.ts";
import { boundOutput } from "../src/output.ts";

function tmpdir(): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "two-brothers-readrange-"));
  return {
    root,
    cleanup: () => {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {
        // best-effort temp cleanup
      }
    },
  };
}

function write(root: string, relPath: string, content: string): string {
  const file = path.join(root, ...relPath.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf-8");
  return file;
}

const PAGE_FIELDS = ["offset", "lines", "total_lines", "eof", "next_offset"] as const;

function pageOf(result: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(PAGE_FIELDS.map((field) => [field, result[field]]));
}

test("no-range read is byte-identical for a small file", async () => {
  const { root, cleanup } = tmpdir();
  try {
    write(root, "small.txt", "hello\nworld\n");
    const ws = new Workspace(root);
    assert.deepEqual(await ws.read_file("small.txt"), {
      tool: "read_file",
      status: "ok",
      path: "small.txt",
      content: "hello\nworld\n",
      truncated: false,
    });
    // The old positional maxChars shape is untouched too.
    assert.deepEqual(await ws.read_file("small.txt", 500), {
      tool: "read_file",
      status: "ok",
      path: "small.txt",
      content: "hello\nworld\n",
      truncated: false,
    });
    // ...including when the positional cap actually bites.
    assert.deepEqual(await ws.read_file("small.txt", 5), {
      tool: "read_file",
      status: "ok",
      path: "small.txt",
      content: "hel\n...[truncated 7 chars]...\nd\n",
      truncated: true,
    });
  } finally {
    cleanup();
  }
});

test("no-range read is byte-identical for large/truncated and CJK files", async () => {
  const { root, cleanup } = tmpdir();
  try {
    const ascii = "0123456789".repeat(10_000);
    const cjk = "漢字かな交じり文、絵文字なし。\n".repeat(2_000);
    write(root, "large.txt", ascii);
    write(root, "cjk.txt", cjk);
    const ws = new Workspace(root);

    const large = await ws.read_file("large.txt");
    assert.deepEqual(large, {
      tool: "read_file",
      status: "ok",
      path: "large.txt",
      content: boundOutput(ascii, DEFAULT_MAX_CHARS).text,
      truncated: true,
    });
    assert.ok(String(large.content).includes(`...[truncated ${ascii.length - DEFAULT_MAX_CHARS} chars]...`));

    const cjkResult = await ws.read_file("cjk.txt");
    assert.deepEqual(cjkResult, {
      tool: "read_file",
      status: "ok",
      path: "cjk.txt",
      content: boundOutput(cjk, DEFAULT_MAX_CHARS).text,
      truncated: true,
    });
    // A maxChars-only options object keeps the same whole-file path.
    assert.deepEqual(await ws.read_file("large.txt", { maxChars: 100 }), {
      tool: "read_file",
      status: "ok",
      path: "large.txt",
      content: boundOutput(ascii, 100).text,
      truncated: true,
    });
  } finally {
    cleanup();
  }
});

test("offset/limit returns exactly the requested lines with page bookkeeping", async () => {
  const { root, cleanup } = tmpdir();
  try {
    write(root, "lines.txt", "one\ntwo\nthree\nfour\nfive\n");
    const ws = new Workspace(root);

    const middle = await ws.read_file("lines.txt", { offset: 2, limit: 2 });
    assert.equal(middle.content, "two\nthree");
    assert.deepEqual(pageOf(middle), {
      offset: 2,
      lines: 2,
      total_lines: 5,
      eof: false,
      next_offset: 4,
    });
    assert.equal(middle.truncated, false);

    const tail = await ws.read_file("lines.txt", { offset: 4, limit: 10 });
    assert.equal(tail.content, "four\nfive");
    assert.deepEqual(pageOf(tail), {
      offset: 4,
      lines: 2,
      total_lines: 5,
      eof: true,
      next_offset: undefined,
    });
    assert.ok(!("next_offset" in tail));

    // limit alone starts at line 1; offset alone takes the default page size.
    const first = await ws.read_file("lines.txt", { limit: 1 });
    assert.deepEqual(pageOf(first), {
      offset: 1,
      lines: 1,
      total_lines: 5,
      eof: false,
      next_offset: 2,
    });
    assert.equal(first.content, "one");
    const fromThree = await ws.read_file("lines.txt", { offset: 3 });
    assert.equal(fromThree.content, "three\nfour\nfive");
    assert.equal(fromThree.eof, true);
  } finally {
    cleanup();
  }
});

test("line endings: CRLF and CR split lines without a phantom trailing line", async () => {
  const { root, cleanup } = tmpdir();
  try {
    write(root, "crlf.txt", "alpha\r\nbeta\r\n");
    write(root, "cr.txt", "alpha\rbeta\rgamma");
    write(root, "empty.txt", "");
    write(root, "one-empty.txt", "\n");
    const ws = new Workspace(root);

    assert.equal((await ws.read_file("crlf.txt", { offset: 2, limit: 1 })).content, "beta");
    const crlf = await ws.read_file("crlf.txt", { offset: 1, limit: 10 });
    assert.deepEqual(pageOf(crlf), {
      offset: 1,
      lines: 2,
      total_lines: 2,
      eof: true,
      next_offset: undefined,
    });

    const cr = await ws.read_file("cr.txt", { offset: 2, limit: 2 });
    assert.equal(cr.content, "beta\ngamma");
    assert.equal(cr.total_lines, 3);
    assert.equal(cr.eof, true);

    const empty = await ws.read_file("empty.txt", { offset: 1, limit: 5 });
    assert.deepEqual(pageOf(empty), {
      offset: 1,
      lines: 0,
      total_lines: 0,
      eof: true,
      next_offset: undefined,
    });
    assert.equal(empty.content, "");

    const oneEmpty = await ws.read_file("one-empty.txt", { offset: 1, limit: 5 });
    assert.deepEqual(pageOf(oneEmpty), {
      offset: 1,
      lines: 1,
      total_lines: 1,
      eof: true,
      next_offset: undefined,
    });
    assert.equal(oneEmpty.content, "");
  } finally {
    cleanup();
  }
});

test("offset past EOF is an honest empty page", async () => {
  const { root, cleanup } = tmpdir();
  try {
    write(root, "lines.txt", "one\ntwo\nthree\n");
    const ws = new Workspace(root);
    const result = await ws.read_file("lines.txt", { offset: 50, limit: 10 });
    assert.equal(result.content, "");
    assert.deepEqual(pageOf(result), {
      offset: 50,
      lines: 0,
      total_lines: 3,
      eof: true,
      next_offset: undefined,
    });
    assert.equal(result.truncated, false);
  } finally {
    cleanup();
  }
});

test("limit 0/negative/NaN/large values clamp and never throw", async () => {
  const { root, cleanup } = tmpdir();
  try {
    const lines = Array.from({ length: 6_000 }, (_, index) => `line ${index + 1}`);
    write(root, "many.txt", lines.join("\n") + "\n");
    const ws = new Workspace(root);

    for (const limit of [0, -5, -Infinity]) {
      const result = await ws.read_file("many.txt", { offset: 2, limit });
      assert.equal(result.status, "ok", String(limit));
      assert.equal(result.content, "line 2", String(limit));
      assert.equal(result.lines, 1, String(limit));
      assert.equal(result.next_offset, 3, String(limit));
    }
    // Junk (NaN) is not a request: it takes the default page size.
    const nanLimit = await ws.read_file("many.txt", { offset: 2, limit: Number.NaN });
    assert.equal(nanLimit.lines, DEFAULT_READ_LINES);
    assert.equal(nanLimit.content, lines.slice(1, 1 + DEFAULT_READ_LINES).join("\n"));

    // The line cap is 5 000, independent of the character budget; a large
    // maxChars keeps this page from being character-clipped first.
    const huge = await ws.read_file("many.txt", {
      offset: 1,
      limit: 99_999_999,
      maxChars: 200_000,
    });
    assert.equal(huge.status, "ok");
    assert.equal(huge.lines, MAX_READ_LINES);
    assert.equal(huge.total_lines, 6_000);
    assert.equal(huge.eof, false);
    assert.equal(huge.next_offset, MAX_READ_LINES + 1);
    assert.equal(String(huge.content).split("\n").length, MAX_READ_LINES);

    // Infinity clamps to the cap rather than throwing; junk offsets clamp to 1.
    const infinite = await ws.read_file("many.txt", {
      offset: 1,
      limit: Infinity,
      maxChars: 200_000,
    });
    assert.equal(infinite.lines, MAX_READ_LINES);
    const offsetZero = await ws.read_file("many.txt", { offset: 0, limit: 1 });
    assert.equal(offsetZero.content, "line 1");
    const offsetNaN = await ws.read_file("many.txt", { offset: Number.NaN, limit: 1 });
    assert.equal(offsetNaN.content, "line 1");
    const offsetHuge = await ws.read_file("many.txt", { offset: Infinity, limit: 1 });
    assert.deepEqual(pageOf(offsetHuge), {
      offset: Number.MAX_SAFE_INTEGER,
      lines: 0,
      total_lines: 6_000,
      eof: true,
      next_offset: undefined,
    });
    assert.equal(DEFAULT_READ_LINES, 2_000);
  } finally {
    cleanup();
  }
});

test("a character-clipped page is honest and points at the first undelivered line", async () => {
  const { root, cleanup } = tmpdir();
  try {
    write(root, "page.txt", "1234567890\nabcdefghij\nABCDEFGHIJ\nlast\n");
    const ws = new Workspace(root);

    const clipped = await ws.read_file("page.txt", { offset: 1, limit: 4, maxChars: 26 });
    // Two 10-char lines plus the joining newline is 21 chars; the third would
    // need 32, so it starts the next page rather than being cut mid-line.
    assert.equal(clipped.content, "1234567890\nabcdefghij");
    assert.deepEqual(pageOf(clipped), {
      offset: 1,
      lines: 2,
      total_lines: 4,
      eof: false,
      next_offset: 3,
    });
    assert.equal(clipped.truncated, true);
    assert.notEqual(clipped.eof, true);
  } finally {
    cleanup();
  }
});

test("a giant first line is safely head-clipped and never splits a surrogate pair", async () => {
  const { root, cleanup } = tmpdir();
  try {
    const emoji = "😀";
    write(root, "emoji.txt", emoji.repeat(50) + "\nsecond\n");
    const ws = new Workspace(root);

    const clipped = await ws.read_file("emoji.txt", { offset: 1, limit: 1, maxChars: 5 });
    assert.equal(clipped.content, emoji + emoji);
    assert.equal(String(clipped.content).length, 4);
    assert.deepEqual(pageOf(clipped), {
      offset: 1,
      lines: 1,
      total_lines: 2,
      eof: false,
      next_offset: 2,
    });
    assert.equal(clipped.truncated, true);
    const content = String(clipped.content);
    for (let i = 0; i < content.length; i++) {
      const code = content.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = content.charCodeAt(i + 1);
        assert.ok(next >= 0xdc00 && next <= 0xdfff, "no lone high surrogate");
        i += 1;
      } else {
        assert.ok(!(code >= 0xdc00 && code <= 0xdfff), "no lone low surrogate");
      }
    }
  } finally {
    cleanup();
  }
});

test("a very large generated file pages by line with bounded work", async () => {
  const { root, cleanup } = tmpdir();
  try {
    const total = 120_000;
    const lines = Array.from({ length: total }, (_, index) => `row ${String(index + 1).padStart(6, "0")} ${"x".repeat(24)}`);
    write(root, "big.log", lines.join("\n") + "\n");
    const ws = new Workspace(root);

    const page = await ws.read_file("big.log", { offset: 60_000, limit: 3 });
    assert.equal(page.content, lines.slice(59_999, 60_002).join("\n"));
    assert.deepEqual(pageOf(page), {
      offset: 60_000,
      lines: 3,
      total_lines: total,
      eof: false,
      next_offset: 60_003,
    });

    const tail = await ws.read_file("big.log", { offset: total - 1, limit: 10 });
    assert.equal(tail.content, lines.slice(total - 2).join("\n"));
    assert.equal(tail.eof, true);
    assert.equal(tail.next_offset, undefined);
  } finally {
    cleanup();
  }
});

test("missing, directory, traversal and sensitive errors keep their typed shapes", async () => {
  const { root, cleanup } = tmpdir();
  try {
    write(root, "sub/inside.txt", "x");
    write(root, ".env", "TOKEN=x");
    const ws = new Workspace(root);

    const missing = await ws.read_file("missing.txt", { offset: 1, limit: 2 });
    assert.deepEqual(missing, {
      tool: "read_file",
      status: "error",
      error: "no such file or directory: missing.txt",
    });
    const directory = await ws.read_file("sub", { offset: 1, limit: 2 });
    assert.deepEqual(directory, { tool: "read_file", status: "error", error: "not a file: sub" });
    assert.deepEqual(await ws.read_file("sub"), {
      tool: "read_file",
      status: "error",
      error: "not a file: sub",
    });
    const escape = await ws.read_file("../outside.txt", { offset: 1, limit: 2 });
    assert.equal(escape.status, "error");
    assert.match(String(escape.error), /escapes the workspace/);
    const sensitive = await ws.read_file(".env", { offset: 1, limit: 2 });
    assert.equal(sensitive.status, "error");
    assert.match(String(sensitive.error), /sensitive file refused/);
  } finally {
    cleanup();
  }
});

test("workspace_read_file tool schema and JSON result carry the range fields", async () => {
  const { root, cleanup } = tmpdir();
  try {
    write(root, "tool.txt", "one\ntwo\nthree\n");
    const ws = new Workspace(root);
    const tool = ws.asTools().find((candidate) => candidate.name === "workspace_read_file");
    assert.ok(tool, "workspace_read_file is registered");

    const properties = (tool.parameters as { properties: Record<string, Record<string, unknown>> }).properties;
    assert.equal(properties.offset.type, "integer");
    assert.equal(properties.offset.minimum, 1);
    assert.equal(properties.offset.default, 1);
    assert.equal(properties.limit.type, "integer");
    assert.equal(properties.limit.minimum, 1);
    assert.equal(properties.limit.maximum, MAX_READ_LINES);
    assert.equal(properties.limit.default, DEFAULT_READ_LINES);
    assert.equal(properties.max_chars.default, DEFAULT_MAX_CHARS);
    assert.match(String(properties.offset.description), /1-based/);
    assert.match(String(properties.limit.description), new RegExp(String(MAX_READ_LINES)));

    const raw = await tool.execute({ path: "tool.txt", offset: 2, limit: 1 });
    assert.equal(typeof raw, "string");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    assert.equal(parsed.tool, "read_file");
    assert.equal(parsed.status, "ok");
    assert.equal(parsed.path, "tool.txt");
    assert.equal(parsed.content, "two");
    assert.deepEqual(pageOf(parsed), {
      offset: 2,
      lines: 1,
      total_lines: 3,
      eof: false,
      next_offset: 3,
    });
    assert.equal(parsed.truncated, false);

    // A call without offset/limit is exactly the historical tool result.
    const plain = await tool.execute({ path: "tool.txt" });
    assert.deepEqual(JSON.parse(plain), await ws.read_file("tool.txt"));
    assert.ok(!("offset" in JSON.parse(plain)));
  } finally {
    cleanup();
  }
});
