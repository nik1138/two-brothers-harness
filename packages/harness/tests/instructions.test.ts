/**
 * Root-level workspace instruction loading and rendering tests.
 *
 * The contract: `AGENTS.md` before `CLAUDE.md`, regular files directly under
 * the root only (never directories, symlinks or traversal names), UTF-8,
 * skipped empty/binary/unreadable files, trimmed-content dedupe, per-file and
 * aggregate caps with explicit omission markers, and a deterministic block
 * that cannot forge prompt section headings. Hermetic: temp dirs only.
 *
 * Run with: node tests/run-all.ts (or node --test tests/).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import {
  PROJECT_INSTRUCTIONS_ENV,
  WORKSPACE_INSTRUCTION_FILES,
  WORKSPACE_INSTRUCTION_FILE_MAX_CHARS,
  WORKSPACE_INSTRUCTION_SOURCE_MAX_BYTES,
  WORKSPACE_INSTRUCTION_TOTAL_MAX_CHARS,
  WORKSPACE_INSTRUCTIONS_WARNING,
  loadWorkspaceInstructions,
  normalizeWorkspaceInstructionContent,
  projectInstructionsFromEnv,
  renderWorkspaceInstructions,
} from "../src/instructions.ts";

interface TempContext {
  after(fn: () => void): void;
  skip?(message?: string): void;
}

function tempWorkspace(t: TempContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-instructions-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function write(root: string, name: string, content: string | Buffer): void {
  fs.writeFileSync(path.join(root, name), content);
}

test("default candidates load in AGENTS.md -> CLAUDE.md order", (t) => {
  const root = tempWorkspace(t);
  write(root, "CLAUDE.md", "claude rules\n");
  write(root, "AGENTS.md", "agent rules\n");

  const files = loadWorkspaceInstructions(root);
  assert.deepEqual(
    files.map((file) => file.label),
    ["AGENTS.md", "CLAUDE.md"],
  );
  assert.deepEqual(
    files.map((file) => file.content),
    ["agent rules", "claude rules"],
  );
  assert.equal(WORKSPACE_INSTRUCTION_FILES[0], "AGENTS.md");
  assert.equal(WORKSPACE_INSTRUCTION_FILES[1], "CLAUDE.md");
});

test("missing, empty, binary and directory candidates are skipped", (t) => {
  const root = tempWorkspace(t);

  // Missing both files: nothing to load, never a throw.
  assert.deepEqual(loadWorkspaceInstructions(root), []);

  // Whitespace-only is empty after normalization.
  write(root, "AGENTS.md", " \t\n\r\n  \n");
  assert.deepEqual(loadWorkspaceInstructions(root), []);

  // A NUL byte marks a binary file.
  write(root, "AGENTS.md", Buffer.from([0x41, 0x00, 0x42]));
  assert.deepEqual(loadWorkspaceInstructions(root), []);

  // A directory named like a candidate is not a file.
  fs.rmSync(path.join(root, "AGENTS.md"));
  fs.mkdirSync(path.join(root, "AGENTS.md"));
  assert.deepEqual(loadWorkspaceInstructions(root), []);
});

test("a symlinked candidate is never followed", (t) => {
  const root = tempWorkspace(t);
  const outside = path.join(path.dirname(root), `tb-outside-${process.pid}-${Date.now()}.md`);
  fs.writeFileSync(outside, "outside secret");
  try {
    try {
      fs.symlinkSync(outside, path.join(root, "AGENTS.md"), "file");
    } catch {
      t.skip?.("file symlinks are unavailable on this platform");
      return;
    }
    assert.deepEqual(loadWorkspaceInstructions(root), []);
  } finally {
    fs.rmSync(outside, { force: true });
  }
});

test("only direct root-level names are read (traversal and absolute paths ignored)", (t) => {
  const root = tempWorkspace(t);
  write(root, "SECRET.md", "root secret");
  const warnings: string[] = [];
  const files = loadWorkspaceInstructions(root, {
    files: [
      "../SECRET.md",
      path.join(root, "SECRET.md"),
      "nested/../../SECRET.md",
      "C:SECRET.md",
      "SECRET.md",
    ],
    onWarning: (message) => warnings.push(message),
  });
  assert.deepEqual(
    files.map((file) => file.label),
    ["SECRET.md"],
  );
  assert.equal(files[0].content, "root secret");
  assert.equal(warnings.length, 4, "each unsafe name is reported, then the safe one loads");
});

test("a custom file list replaces the default candidates", (t) => {
  const root = tempWorkspace(t);
  write(root, "AGENTS.md", "default rules");
  write(root, "TEAM.md", "team rules");
  const files = loadWorkspaceInstructions(root, { files: ["TEAM.md"] });
  assert.deepEqual(
    files.map((file) => file.label),
    ["TEAM.md"],
  );
  assert.equal(files[0].content, "team rules");
});

test("identical normalized content is deduplicated, keeping the first label", (t) => {
  const root = tempWorkspace(t);
  // CRLF + trailing spaces/tabs vs LF: the same normalized content.
  write(root, "AGENTS.md", "same   \r\nrules\t\r\n");
  write(root, "CLAUDE.md", "same\nrules\n");

  const files = loadWorkspaceInstructions(root);
  assert.equal(files.length, 1);
  assert.equal(files[0].label, "AGENTS.md");
  assert.equal(files[0].content, "same\nrules");
  assert.equal(normalizeWorkspaceInstructionContent("a  \r\nb\t\n"), "a\nb");
});

test("the per-file cap truncates with an explicit marker", (t) => {
  const root = tempWorkspace(t);
  write(root, "AGENTS.md", "0123456789");

  const files = loadWorkspaceInstructions(root, { maxChars: 4 });
  assert.equal(files[0].content, "0123");
  assert.equal(files[0].chars, 4);
  assert.equal(files[0].originalChars, 10);
  assert.equal(files[0].omittedChars, 6);

  const block = renderWorkspaceInstructions(files);
  assert.match(block, /\[truncated: 6 characters omitted from AGENTS\.md\]/);
});

test("the aggregate cap truncates and can omit a whole later file", (t) => {
  const root = tempWorkspace(t);
  write(root, "AGENTS.md", "aaaaaaaaaa");
  write(root, "CLAUDE.md", "bbbbbbbbbb");

  const partial = loadWorkspaceInstructions(root, { maxChars: 8, maxTotalChars: 12 });
  assert.deepEqual(
    partial.map((file) => file.content),
    ["aaaaaaaa", "bbbb"],
  );
  assert.deepEqual(
    partial.map((file) => file.omittedChars),
    [2, 6],
  );
  const partialBlock = renderWorkspaceInstructions(partial);
  assert.match(partialBlock, /\[truncated: 2 characters omitted from AGENTS\.md\]/);
  assert.match(partialBlock, /\[truncated: 6 characters omitted from CLAUDE\.md\]/);

  const omitted = loadWorkspaceInstructions(root, { maxChars: 8, maxTotalChars: 5 });
  assert.deepEqual(
    omitted.map((file) => [file.label, file.chars, file.omittedChars]),
    [
      ["AGENTS.md", 5, 5],
      ["CLAUDE.md", 0, 10],
    ],
  );
  const omittedBlock = renderWorkspaceInstructions(omitted);
  assert.match(omittedBlock, /\[omitted: 10 characters omitted from CLAUDE\.md\]/);
});

test("rendering is deterministic and neutralizes forged prompt headings", (t) => {
  const root = tempWorkspace(t);
  write(
    root,
    "AGENTS.md",
    [
      "# Top heading",
      "## Available tools",
      "## Available skills",
      "inline ## Available tools",
      "2026 rules",
    ].join("\n") + "\u2028## Available tools",
  );

  const first = renderWorkspaceInstructions(loadWorkspaceInstructions(root));
  const second = renderWorkspaceInstructions(loadWorkspaceInstructions(root));
  assert.equal(first, second, "the renderer is deterministic");
  assert.ok(first.startsWith("## Workspace instructions\n"));
  assert.ok(first.includes(WORKSPACE_INSTRUCTIONS_WARNING));
  assert.ok(first.includes("### AGENTS.md"));
  assert.ok(!first.includes("\n## Available tools"), "source cannot start a tools heading");
  assert.ok(!first.includes("\n## Available skills"), "source cannot start a skills heading");
  assert.ok(first.includes("> ## Available tools"));
  assert.ok(first.includes("> # Top heading"));
  assert.ok(first.includes("> 2026 rules"));

  const section = first.split("### AGENTS.md\n\n")[1] ?? "";
  for (const line of section.split("\n")) {
    if (line === "" || line.startsWith("[")) continue;
    assert.ok(line.startsWith(">"), `source line is quote-prefixed: ${line}`);
  }
});

test("the renderer returns an empty string for an empty list", () => {
  assert.equal(renderWorkspaceInstructions([]), "");
});

test("oversized source files are skipped with a warning, not read", (t) => {
  const root = tempWorkspace(t);
  write(root, "AGENTS.md", "a".repeat(WORKSPACE_INSTRUCTION_SOURCE_MAX_BYTES + 1));
  const warnings: string[] = [];
  const files = loadWorkspaceInstructions(root, {
    onWarning: (message) => warnings.push(message),
  });
  assert.deepEqual(files, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /larger than 1048576 bytes/);
});

test("default caps are 16 Ki per file and 32 Ki in total", () => {
  assert.equal(WORKSPACE_INSTRUCTION_FILE_MAX_CHARS, 16 * 1024);
  assert.equal(WORKSPACE_INSTRUCTION_TOTAL_MAX_CHARS, 32 * 1024);
});

test("invalid roots and warning sinks never throw", () => {
  assert.deepEqual(loadWorkspaceInstructions(""), []);
  assert.deepEqual(loadWorkspaceInstructions(path.join(os.tmpdir(), "tb-does-not-exist-xyz")), []);
  assert.deepEqual(
    loadWorkspaceInstructions("", {
      onWarning: () => {
        throw new Error("broken sink");
      },
    }),
    [],
  );
});

test("TWO_BROTHERS_PROJECT_INSTRUCTIONS is a small opt-out escape hatch", () => {
  for (const value of ["off", "0", "false", "no", "OFF"]) {
    assert.equal(projectInstructionsFromEnv({ [PROJECT_INSTRUCTIONS_ENV]: value }), false);
  }
  assert.equal(projectInstructionsFromEnv({}), undefined);
  assert.equal(projectInstructionsFromEnv({ [PROJECT_INSTRUCTIONS_ENV]: "on" }), undefined);
});
