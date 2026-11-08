/**
 * `compactToolResult`'s additive workspace preview: the bounded plain-text
 * summary the web tool card needs for directory listings, file reads and
 * search results. Hermetic and pure — no filesystem, network or providers.
 *
 * Run with: node tests/run-all.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CLIP_PREVIEW_CHARS,
  MAX_PREVIEW_ENTRIES,
  compactToolResult,
} from "../src/runevents.ts";

/** Compact one result and assert the object shape these tests cover. */
function compact(raw: unknown): Record<string, unknown> {
  const result = compactToolResult(raw);
  assert.ok(result !== null && typeof result === "object" && !Array.isArray(result));
  return result as Record<string, unknown>;
}

test("compactToolResult adds a capped list_dir preview", () => {
  const entries = Array.from({ length: MAX_PREVIEW_ENTRIES + 10 }, (_, index) => ({
    name: `file-${index}.txt`,
    type: index % 2 === 0 ? "file" : "dir",
    size: index,
  }));
  const result = compact({ tool: "list_dir", status: "ok", path: ".", entries });
  assert.equal(result.status, "ok");
  assert.equal(result.path, ".");
  assert.equal(result.entries, undefined, "the raw entries array stays omitted");
  const preview = String(result.preview);
  const rows = preview.split("\n").filter((line) => !line.startsWith("..."));
  assert.equal(
    rows.length,
    MAX_PREVIEW_ENTRIES,
    "only the first entry-cap rows are shown",
  );
  assert.match(preview, /^file file-0\.txt/m);
  assert.match(preview, /^dir file-1\.txt/m);
  assert.match(preview, /\.\.\. \(10 more\)$/);
  assert.ok(preview.length <= CLIP_PREVIEW_CHARS);
});

test("compactToolResult counts workspace-truncated entries honestly", () => {
  const result = compact({
    tool: "workspace_list_dir",
    status: "ok",
    entries: [{ name: "kept.txt", type: "file" }],
    omitted_entries: 400,
  });
  assert.equal(result.preview, "file kept.txt\n... (400 more)");
});

test("read_file preview is only the sanitized content head", () => {
  const content = "\x1b[31mfirst\x1b[0m line\n" + "middle\n".repeat(2_000) + "TAIL-MARKER";
  const result = compact({ tool: "read_file", status: "ok", path: "notes.txt", content });
  const preview = String(result.preview);
  assert.ok(preview.startsWith("first line\n"), "ANSI escapes are stripped from the head");
  assert.ok(!preview.includes("TAIL-MARKER"), "the end of a large file is never included");
  assert.ok(!preview.includes("\x1b"), "no escape sequences survive");
  assert.ok(preview.length <= CLIP_PREVIEW_CHARS);
});

test("search_text preview lists capped match paths, not match bodies", () => {
  const matches = Array.from({ length: MAX_PREVIEW_ENTRIES + 2 }, (_, index) => ({
    path: `src/file-${index}.ts`,
    line: index + 1,
    text: "needle",
  }));
  const result = compact(
    JSON.stringify({ tool: "workspace_search_text", status: "ok", path: ".", matches }),
  );
  const preview = String(result.preview);
  assert.equal(preview.split("\n").length, MAX_PREVIEW_ENTRIES + 1);
  assert.match(preview, /^src\/file-0\.ts:1/m);
  assert.match(preview, /\.\.\. \(2 more\)$/);
  assert.ok(!preview.includes("needle"), "the preview summarises paths only");
});

test("small and unsupported results keep their historical compact shape", () => {
  // A small plain string is still clipped to one string, never wrapped.
  assert.equal(compactToolResult("hello"), "hello");
  // A write result has no preview: the exact old field set stays in place.
  assert.deepEqual(
    compact({
      tool: "write_file",
      status: "ok",
      path: "a.txt",
      bytes_written: 6,
      content: "secret",
    }),
    { status: "ok", path: "a.txt", bytes_written: 6 },
  );
  // A small supported listing does gain exactly one additive field.
  const small = compact({
    tool: "list_dir",
    status: "ok",
    path: ".",
    entries: [{ name: "a.ts", type: "file", size: 3 }],
  });
  assert.deepEqual(Object.keys(small), ["status", "path", "preview"]);
  assert.equal(small.preview, "file a.ts");
  // Empty content / listings / matches have nothing useful to show.
  assert.equal(compact({ tool: "read_file", status: "ok", content: "" }).preview, undefined);
  assert.equal(compact({ tool: "list_dir", status: "ok", entries: [] }).preview, undefined);
  assert.equal(compact({ tool: "search_text", status: "ok", matches: [] }).preview, undefined);
  // Unusable entry rows produce no empty preview field either.
  assert.equal(compact({ tool: "list_dir", status: "ok", entries: [{}] }).preview, undefined);
  assert.equal(compact({ tool: "search_text", status: "ok", matches: [{}] }).preview, undefined);
  // Objects without a recognized `tool` key are not given a preview.
  assert.equal(
    compactToolResult({ status: "ok", content: "not a workspace result" }),
    '{"status":"ok","content":"not a workspace result"}',
  );
});

test("a preview keeps one tool_completed JSON line bounded", () => {
  const result = compact({
    tool: "read_file",
    status: "ok",
    path: "a.txt",
    content: "x".repeat(100_000),
  });
  const line = JSON.stringify(result);
  assert.ok(line.length <= CLIP_PREVIEW_CHARS + 200, `bounded line (${line.length})`);
  assert.ok(!line.includes("x".repeat(CLIP_PREVIEW_CHARS + 1)), "the whole file never rides along");
});
