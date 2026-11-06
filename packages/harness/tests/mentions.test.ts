/**
 * Composer mentions (`src/mentions.ts`): conservative `@skill:` / `@path`
 * scanning, path normalization, canonical tokens and the exact injection block
 * bytes. Pure and hermetic — no filesystem, no network, no timers.
 * Run with: node --test tests/mentions.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MENTION_MAX_FILE_CHARS,
  MENTION_MAX_FILES,
  MENTION_MAX_SKILL_CHARS,
  MENTION_MAX_SKILLS,
  MENTION_MAX_TOTAL_CHARS,
  MENTION_SKILL_PREFIX,
  fileMentionToken,
  normalizeMentionPath,
  parseMentions,
  renderFileBlock,
  renderSkillLoadedBlock,
  scanMentions,
  skillMentionToken,
} from "../src/mentions.ts";

test("mention constants match the published contract", () => {
  assert.equal(MENTION_SKILL_PREFIX, "@skill:");
  assert.equal(MENTION_MAX_SKILLS, 3);
  assert.equal(MENTION_MAX_FILES, 5);
  assert.equal(MENTION_MAX_FILE_CHARS, 20_000);
  assert.equal(MENTION_MAX_SKILL_CHARS, 60_000);
  assert.equal(MENTION_MAX_TOTAL_CHARS, 100_000);
});

test("a path mention at index 0 and after ASCII whitespace carries exact offsets", () => {
  const atStart = scanMentions("@src/a.ts");
  assert.deepEqual(atStart, [{ kind: "file", value: "src/a.ts", start: 0, end: 9 }]);

  const spaced = scanMentions("see @src/a.ts please");
  assert.deepEqual(spaced, [{ kind: "file", value: "src/a.ts", start: 4, end: 13 }]);
  assert.equal("see @src/a.ts please".slice(4, 13), "@src/a.ts");

  for (const [prefix, expectedStart] of [
    ["\t", 1],
    ["\n", 1],
    ["\r\n", 2],
    ["\f", 1],
    ["\v", 1],
  ] as const) {
    const tokens = scanMentions(`${prefix}@src/a.ts`);
    assert.deepEqual(tokens, [{ kind: "file", value: "src/a.ts", start: expectedStart, end: expectedStart + 9 }]);
  }
});

test("mentions inside words, emails and handles are not tokens", () => {
  for (const text of [
    "foo@src/a.ts",
    "user@host.com",
    "mail me at a@b/c",
    "(@src/a.ts)",
    "-@src/a.ts",
    "😀@src/a.ts", // the char before `@` is not ASCII whitespace
  ]) {
    assert.deepEqual(scanMentions(text), [], text);
  }
});

test("@media and other slashless handles are not file tokens", () => {
  for (const text of ["@media", "@handle", "@skillx", "@a", "@.", "@."]) {
    assert.deepEqual(scanMentions(text), [], text);
  }
});

test("skill tokens are validated and end at the first non-name char", () => {
  assert.deepEqual(scanMentions("@skill:deploy"), [
    { kind: "skill", value: "deploy", start: 0, end: 13 },
  ]);
  assert.deepEqual(scanMentions("@skill:check-2_x"), [
    { kind: "skill", value: "check-2_x", start: 0, end: 16 },
  ]);
  // trailing punctuation ends the name, not the token value
  const punctuated = scanMentions("@skill:deploy.");
  assert.deepEqual(punctuated, [{ kind: "skill", value: "deploy", start: 0, end: 13 }]);
  // invalid names are not skill mentions (and have no slash, so not files)
  for (const text of ["@skill:", "@skill:Deploy", "@skill:_x", "@skill:-x"]) {
    assert.deepEqual(scanMentions(text), [], text);
  }
  // a space ends the name: the first word is a valid skill, the rest is prose
  assert.deepEqual(scanMentions("@skill:de ploy"), [
    { kind: "skill", value: "de", start: 0, end: 9 },
  ]);
});

test("a skill token wins over the file grammar; the rest of the run is not rescanned", () => {
  const tokens = scanMentions("@skill:foo/bar");
  assert.deepEqual(tokens, [{ kind: "skill", value: "foo", start: 0, end: 10 }]);
});

test("trailing sentence punctuation is trimmed from file tokens", () => {
  assert.deepEqual(scanMentions("@src/a.ts."), [
    { kind: "file", value: "src/a.ts", start: 0, end: 9 },
  ]);
  assert.deepEqual(scanMentions("@src/a.ts,"), [
    { kind: "file", value: "src/a.ts", start: 0, end: 9 },
  ]);
  // the full punctuation set trims in one pass
  const all = scanMentions('@src/a.ts.,;:!?)]}"\'');
  assert.deepEqual(all, [{ kind: "file", value: "src/a.ts", start: 0, end: 9 }]);
  // dots that belong to the filename are kept
  assert.deepEqual(scanMentions("@src/a.test.ts"), [
    { kind: "file", value: "src/a.test.ts", start: 0, end: 14 },
  ]);
  // a bare trailing dot is punctuation, not a filename
  assert.deepEqual(scanMentions("@dir/."), [{ kind: "file", value: "dir/", start: 0, end: 5 }]);
});

test("windows-style and mixed-separator paths are file tokens", () => {
  const backslash = scanMentions("@src\\a.ts");
  assert.deepEqual(backslash, [{ kind: "file", value: "src\\a.ts", start: 0, end: 9 }]);
  const mixed = scanMentions("read @src\\lib/b.ts now");
  assert.deepEqual(mixed, [{ kind: "file", value: "src\\lib/b.ts", start: 5, end: 18 }]);
});

test("the file token is the whole non-whitespace run, so punctuation inside it joins the run", () => {
  // No whitespace between the two `@`: the run is one path-like token.
  assert.deepEqual(scanMentions("@src/a.ts,@src/b.ts"), [
    { kind: "file", value: "src/a.ts,@src/b.ts", start: 0, end: 19 },
  ]);
  // With whitespace (or after a boundary) they are two mentions.
  assert.deepEqual(scanMentions("@src/a.ts, @src/b.ts").map((token) => token.value), [
    "src/a.ts",
    "src/b.ts",
  ]);
});

test("tokens are deduped by value; first occurrence wins and order is preserved", () => {
  const text = "@skill:alpha @skill:alpha @src/a.ts @src/a.ts @other/b.ts";
  const tokens = scanMentions(text);
  assert.deepEqual(
    tokens.map((token) => `${token.kind}:${token.value}`),
    ["skill:alpha", "file:src/a.ts", "file:other/b.ts"],
  );
  assert.deepEqual(tokens.map((token) => token.start), [0, 26, 46]);
  assert.deepEqual(tokens.map((token) => token.end), [12, 35, 57]);
  for (const token of tokens) {
    assert.equal(text.slice(token.start, token.end), token.kind === "skill" ? `@skill:${token.value}` : `@${token.value}`);
  }
});

test("scanning is Unicode-safe (offsets are code-unit based, slices round-trip)", () => {
  const text = "😀 please read @src/a.ts";
  const tokens = scanMentions(text);
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].start, 15);
  assert.equal(text.slice(tokens[0].start, tokens[0].end), "@src/a.ts");

  const cjk = "проверь файл @src\\a.ts\u00a0";
  const cjkTokens = scanMentions(cjk);
  assert.equal(cjkTokens.length, 1);
  assert.equal(cjk.slice(cjkTokens[0].start, cjkTokens[0].end), "@src\\a.ts");
});

test("parseMentions returns skills, files and the token list in order", () => {
  const parsed = parseMentions("Use @skill:review then open @src/a.ts and @skill:check with @docs/x.md.");
  assert.deepEqual(parsed.skills, ["review", "check"]);
  assert.deepEqual(parsed.files, ["src/a.ts", "docs/x.md"]);
  assert.deepEqual(parsed.tokens.map((token) => token.kind), ["skill", "file", "skill", "file"]);
  assert.deepEqual(parseMentions(""), { skills: [], files: [], tokens: [] });
  assert.deepEqual(parseMentions("no mentions here"), { skills: [], files: [], tokens: [] });
});

test("normalizeMentionPath trims, unquotes, converts separators and leading ./", () => {
  assert.equal(normalizeMentionPath("  src/a.ts  "), "src/a.ts");
  assert.equal(normalizeMentionPath('"src/a.ts"'), "src/a.ts");
  assert.equal(normalizeMentionPath("'./src/a.ts'"), "src/a.ts");
  assert.equal(normalizeMentionPath('" src/a.ts "'), "src/a.ts");
  assert.equal(normalizeMentionPath(".\\src\\a.ts"), "src/a.ts");
  assert.equal(normalizeMentionPath("src//a.ts"), "src/a.ts");
  // no path resolution: `..` is preserved verbatim
  assert.equal(normalizeMentionPath("../a/../b"), "../a/../b");
  assert.equal(normalizeMentionPath("./"), "");
  assert.equal(normalizeMentionPath("   "), "");
  assert.equal(normalizeMentionPath('""'), "");
  // a lone dot is not collapsed (callers decide what it means)
  assert.equal(normalizeMentionPath("."), ".");
});

test("mention token builders round-trip through parseMentions", () => {
  assert.equal(fileMentionToken("src\\a.ts"), "@src/a.ts");
  assert.equal(fileMentionToken("./src/a.ts"), "@src/a.ts");
  assert.equal(fileMentionToken(""), "@");
  assert.equal(skillMentionToken("deploy"), "@skill:deploy");
  assert.deepEqual(parseMentions(fileMentionToken("src/a.ts")).files, ["src/a.ts"]);
  assert.deepEqual(parseMentions(skillMentionToken("review")).skills, ["review"]);
});

test("fileMentionToken emits a path-like token for root-level files", () => {
  // The scanner only sees path-like runs, so root-level files need "./".
  assert.equal(fileMentionToken("README.md"), "@./README.md");
  assert.equal(fileMentionToken("LICENSE"), "@./LICENSE");
  assert.equal(fileMentionToken(".\\README.md"), "@./README.md");
  // Nested paths are unchanged.
  assert.equal(fileMentionToken("src/a.ts"), "@src/a.ts");
  assert.equal(fileMentionToken("src\\a.ts"), "@src/a.ts");
  assert.equal(fileMentionToken("src/"), "@src/");
  // Idempotent: an already-normalised "./x" and a bare "x" emit the same token.
  assert.equal(fileMentionToken("./x"), "@./x");
  assert.equal(fileMentionToken("x"), "@./x");
  assert.equal(fileMentionToken(fileMentionToken("x").slice(1)), "@./x");
  // Empty input stays the degenerate non-mention "@".
  assert.equal(fileMentionToken(""), "@");
  assert.equal(fileMentionToken("   "), "@");
});

test("root-level fileMentionToken round-trips through scanMentions as a file mention", () => {
  const token = fileMentionToken("README.md");
  const tokens = scanMentions(token);
  assert.deepEqual(tokens, [{ kind: "file", value: "./README.md", start: 0, end: 12 }]);
  assert.equal(token.slice(tokens[0].start, tokens[0].end), token);
  // Consumers normalize the raw token value back to the workspace-relative path.
  assert.equal(normalizeMentionPath(tokens[0].value), "README.md");
  assert.deepEqual(parseMentions(token).files, ["./README.md"]);
  assert.deepEqual(parseMentions(fileMentionToken("src/a.ts")).files, ["src/a.ts"]);
});

test("@README.md stays a non-mention; only the path-like @./README.md attaches", () => {
  assert.deepEqual(scanMentions("@README.md"), []);
  assert.deepEqual(parseMentions("@README.md"), { skills: [], files: [], tokens: [] });
  assert.deepEqual(scanMentions("@./README.md").map((token) => token.value), ["./README.md"]);
  assert.deepEqual(
    scanMentions("read @./README.md").map((token) => token.value),
    ["./README.md"],
  );
});

test("renderSkillLoadedBlock matches the harness convention byte for byte", () => {
  assert.equal(
    renderSkillLoadedBlock("deploy", "Do it."),
    '<skill-loaded name="deploy">\nDo it.\n</skill-loaded>',
  );
  assert.equal(
    renderSkillLoadedBlock("deploy", ""),
    '<skill-loaded name="deploy">\n\n</skill-loaded>',
  );
  // body bytes are kept verbatim (including a trailing newline)
  assert.equal(
    renderSkillLoadedBlock("x", "line\n"),
    '<skill-loaded name="x">\nline\n\n</skill-loaded>',
  );
  // skill bodies may contain markdown/html-looking text untouched
  assert.equal(
    renderSkillLoadedBlock("x", "<b>bold</b>"),
    '<skill-loaded name="x">\n<b>bold</b>\n</skill-loaded>',
  );
});

test("renderSkillLoadedBlock bounds a huge body with the explicit marker", () => {
  const marker = "\n… [skill truncated]";
  const body = "a".repeat(MENTION_MAX_SKILL_CHARS + 10);
  const block = renderSkillLoadedBlock("deploy", body);
  const expected =
    `<skill-loaded name="deploy">\n` +
    "a".repeat(MENTION_MAX_SKILL_CHARS - marker.length) +
    marker +
    `\n</skill-loaded>`;
  assert.equal(block, expected);
  assert.ok(block.includes("… [skill truncated]"));
  assert.ok(!block.includes("a".repeat(MENTION_MAX_SKILL_CHARS)));

  // at the cap exactly: verbatim, no marker
  const atCap = renderSkillLoadedBlock("x", "a".repeat(MENTION_MAX_SKILL_CHARS));
  assert.ok(!atCap.includes("skill truncated"));
  assert.equal(
    atCap.length,
    '<skill-loaded name="x">\n'.length + MENTION_MAX_SKILL_CHARS + "\n</skill-loaded>".length,
  );
});

test("renderSkillLoadedBlock sanitizes a hostile name so the opening tag stays stable", () => {
  const block = renderSkillLoadedBlock('x" onclick="y', "b");
  assert.equal(block, '<skill-loaded name="x\' onclick=\'y">\nb\n</skill-loaded>');
  const newlineName = renderSkillLoadedBlock("a\nb", "c");
  assert.ok(newlineName.startsWith('<skill-loaded name="a b">'));
  assert.equal(newlineName.split("\n").length, 3);
});

test("renderFileBlock matches the composer convention byte for byte", () => {
  assert.equal(renderFileBlock("src/a.ts", "hello"), '<file path="src/a.ts">\nhello\n</file>');
  assert.equal(renderFileBlock("src/a.ts", ""), '<file path="src/a.ts">\n\n</file>');
  assert.equal(
    renderFileBlock("src/a.ts", "line 1\nline 2"),
    '<file path="src/a.ts">\nline 1\nline 2\n</file>',
  );
  // no HTML escaping and no ANSI: file content is verbatim
  assert.equal(
    renderFileBlock("p", "<b>hi</b>"),
    '<file path="p">\n<b>hi</b>\n</file>',
  );
  assert.ok(!renderFileBlock("p", "x").includes("\u001b["));
});

test("renderFileBlock marks truncated content with a final marker line", () => {
  assert.equal(
    renderFileBlock("src/a.ts", "hello", { truncated: true }),
    '<file path="src/a.ts">\nhello\n… [file truncated]\n</file>',
  );
  assert.equal(renderFileBlock("p", "hello", { truncated: false }), '<file path="p">\nhello\n</file>');
  assert.equal(renderFileBlock("p", "hello", {}), '<file path="p">\nhello\n</file>');
});

test("renderFileBlock normalizes and sanitizes the path for the opening tag", () => {
  assert.equal(renderFileBlock("src\\a.ts", "x"), '<file path="src/a.ts">\nx\n</file>');
  assert.equal(renderFileBlock("./src/a.ts", "x"), '<file path="src/a.ts">\nx\n</file>');
  assert.equal(renderFileBlock('src/a"b.ts', "x"), '<file path="src/a\'b.ts">\nx\n</file>');
  const newlinePath = renderFileBlock("a\nb.ts", "x");
  assert.ok(newlinePath.startsWith('<file path="a b.ts">'));
});

test("renderFileBlock does not clip content (callers pass bounded content)", () => {
  const content = "x".repeat(MENTION_MAX_FILE_CHARS + 500);
  const block = renderFileBlock("big.txt", content);
  assert.ok(block.includes(content));
  assert.equal(block, `<file path="big.txt">\n${content}\n</file>`);
});

test("hostile non-string inputs never throw", () => {
  const hostile = [null, undefined, 42, true, {}, [], Symbol("x")];
  for (const value of hostile) {
    assert.doesNotThrow(() => {
      scanMentions(value as unknown as string);
      parseMentions(value as unknown as string);
      normalizeMentionPath(value as unknown as string);
      skillMentionToken(value as unknown as string);
      fileMentionToken(value as unknown as string);
      renderSkillLoadedBlock(value as unknown as string, value as unknown as string);
      renderFileBlock(value as unknown as string, value as unknown as string);
    });
  }
  assert.deepEqual(scanMentions(null as unknown as string), []);
  assert.deepEqual(parseMentions(42 as unknown as string), { skills: [], files: [], tokens: [] });
  assert.equal(normalizeMentionPath(null as unknown as string), "");
  assert.equal(skillMentionToken(null as unknown as string), "@skill:");
  assert.equal(fileMentionToken(null as unknown as string), "@");
  assert.equal(
    renderSkillLoadedBlock(null as unknown as string, null as unknown as string),
    '<skill-loaded name="">\n\n</skill-loaded>',
  );
  assert.equal(
    renderFileBlock(null as unknown as string, null as unknown as string),
    '<file path="">\n\n</file>',
  );
  // a null options bag degrades to the defaults instead of throwing
  assert.equal(
    renderFileBlock("p", "x", null as unknown as { truncated?: boolean }),
    '<file path="p">\nx\n</file>',
  );
});

test("hostile mention-shaped fragments never throw and never produce bad tags", () => {
  const fragments = [
    "@@",
    "@/",
    "@skill:",
    "@skill:\u0000",
    "@...",
    '@src/a.ts"])<script>',
    "@src/" + "a".repeat(10_000),
    "@src/a.ts @skill:a @src/a.ts",
    "\uFEFF@src/a.ts",
  ];
  for (const text of fragments) {
    // A throw would fail this test; the offsets must stay inside the text.
    const parsed = parseMentions(text);
    for (const token of parsed.tokens) {
      assert.ok(token.start >= 0 && token.end > token.start && token.end <= text.length);
    }
  }
});
