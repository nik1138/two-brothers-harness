import assert from "node:assert/strict";
import { test } from "node:test";

import type { Message } from "../src/protocol.ts";
import type { StreamEvent } from "../src/runstream.ts";
import {
  addNotice,
  addToolCall,
  addToolResult,
  addUserBlock,
  appendEnvelopeDelta,
  blockText,
  commitEnvelope,
  createTuiModel,
  envelopeText,
  finalizeStreamingDrafts,
  reduceModelEvent,
  startEnvelopeDraft,
  type DecisionBlock,
  type EnvelopeBlock,
  type ToolBlock,
} from "../src/tui/model.ts";
import { renderMarkdown } from "../src/tui/markdown.ts";
import {
  TUI_COMMANDS,
  documentEntries,
  findCommand,
  findSlashCommand,
  formatKeys,
  matchChord,
  paletteEntries,
  resolveKey,
  tuiHelpLines,
} from "../src/tui/keymap.ts";
import {
  boxContentWidth,
  composeScreen,
  renderBox,
  sanitizeDisplayText,
  stripAnsi,
  styledWidth,
  wrapDisplay,
} from "../src/tui/screen.ts";
import { displayWidth } from "../src/tui/text.ts";
import {
  colorEnabled,
  createTheme,
  detectThemeMode,
  plainTheme,
  resolveTheme,
} from "../src/tui/theme.ts";
import {
  labelForBlock,
  newestToolBlock,
  renderBlock,
  renderTranscript,
  toggleNewestToolExpansion,
  toolExpansionKey,
  withToolExpansion,
} from "../src/tui/transcript.ts";
import { statusBarSegments } from "../src/tui/view/statusbar.ts";

const AT = "2026-11-04T00:00:00Z";
const ESC = "\u001b";

function message(
  id: string,
  from: string,
  kind: string,
  payload: Record<string, unknown>,
  seq = 1,
): Message {
  return { v: 1, id, seq, ts: AT, from, to: from === "user" ? "senior" : "user", kind, payload };
}

test("model: constructors preserve full text and never mutate their input", () => {
  const original = createTuiModel();
  const long = "alpha\n".repeat(2_000) + "終😀";
  const withUser = addUserBlock(original, long, { messageId: "u1", at: AT });
  const withNotice = addNotice(withUser, "error", "failed", { details: long, retryable: true });
  assert.equal(original.blocks.length, 0);
  assert.equal(withUser.blocks[0]?.kind, "user");
  assert.equal(blockText(withUser.blocks[0]!), long);
  assert.equal(blockText(withNotice.blocks[1]!), `failed\n${long}`);
  assert.deepEqual(withNotice.blocks[0], withUser.blocks[0]);
  assert.equal(withNotice.nextId, 3);
});

test("model: streamed draft commits by identity in place with authoritative full text", () => {
  const empty = createTuiModel();
  let model = appendEnvelopeDelta(empty, { role: "senior", delta: "part", at: AT });
  model = addToolCall(model, { role: "senior", tool: "read_file", callId: "call-1", args: "{\"path\":\"a\"}" });
  model = appendEnvelopeDelta(model, { role: "senior", delta: "ial" });
  const draft = model.blocks[0] as EnvelopeBlock;
  assert.equal(draft.text, "partial");
  assert.equal(draft.streaming, true);

  const committed = commitEnvelope(model, message("m-final", "senior", "message", { text: "complete\n全部 😀" }));
  assert.equal(committed.blocks.length, 2);
  assert.equal(committed.blocks[0]?.id, draft.id, "block identity survives commit");
  assert.deepEqual(committed.blocks[0], {
    id: draft.id,
    kind: "envelope",
    messageId: "m-final",
    role: "senior",
    direction: "out",
    envelopeKind: "message",
    text: "complete\n全部 😀",
    streaming: false,
    committed: true,
    seq: 1,
    at: AT,
  });
  assert.equal(draft.text, "partial", "old draft was not mutated");
  assert.deepEqual(commitEnvelope(committed, message("m-final", "senior", "message", { text: "complete\n全部 😀" })), committed);
});

test("model: concurrent role drafts resolve to their own envelopes", () => {
  let model = appendEnvelopeDelta(createTuiModel(), { role: "senior", delta: "senior draft" });
  model = appendEnvelopeDelta(model, { role: "junior", delta: "junior draft" });
  model = commitEnvelope(model, message("j1", "junior", "deliverable", { result: "junior final" }));
  model = commitEnvelope(model, message("s1", "senior", "proposal", { title: "title", answer: "senior final" }));
  assert.equal(model.blocks.length, 2);
  assert.equal(model.blocks[0]?.kind, "envelope");
  assert.equal(blockText(model.blocks[0]!), "proposal: title\nsenior final");
  assert.equal(blockText(model.blocks[1]!), "deliverable: junior final");
});

test("model: late identified deltas cannot resurrect a committed draft", () => {
  let model = startEnvelopeDraft(createTuiModel(), { role: "junior", messageId: "m1" });
  model = appendEnvelopeDelta(model, { role: "junior", messageId: "m1", delta: "draft" });
  model = commitEnvelope(model, message("m1", "junior", "message", { text: "final" }));
  const after = appendEnvelopeDelta(model, { role: "junior", messageId: "m1", delta: "late" });
  assert.equal(after, model);
  assert.equal(startEnvelopeDraft(after, { role: "junior", messageId: "m1" }), after);
  assert.equal(after.blocks.length, 1);
  assert.equal(blockText(after.blocks[0]!), "final");
});

test("model: decisions retain rationale, confidence and dissent as distinct data", () => {
  const streamed = appendEnvelopeDelta(createTuiModel(), { role: "senior", delta: "decision draft" });
  const model = commitEnvelope(streamed, message("d1", "senior", "decision", {
    decision: "Ship the focused fix.",
    rationale: "It addresses the cause.",
    confidence: "high",
    dissent: "Junior preferred a broader refactor.",
  }));
  const decision = model.blocks[0] as DecisionBlock;
  assert.equal(decision.kind, "decision");
  assert.equal(decision.text, "Ship the focused fix.");
  assert.equal(decision.dissent, "Junior preferred a broader refactor.");
  assert.equal(decision.streaming, false);
  assert.equal(blockText(decision), "Ship the focused fix.\nIt addresses the cause.\nJunior preferred a broader refactor.\nhigh");
});

test("model: user echo adoption does not merge distinct equal-text envelopes", () => {
  let model = addUserBlock(createTuiModel(), "same");
  model = commitEnvelope(model, message("u1", "user", "message", { text: "same" }, 1));
  assert.equal(model.blocks.length, 1);
  assert.equal(model.blocks[0]?.kind, "user");
  assert.equal(model.blocks[0]?.kind === "user" ? model.blocks[0].messageId : undefined, "u1");
  model = commitEnvelope(model, message("u2", "user", "message", { text: "same" }, 2));
  assert.equal(model.blocks.length, 2);
  assert.equal(model.blocks[1]?.kind === "user" ? model.blocks[1].messageId : undefined, "u2");
});

test("model: tool results pair by call id and retain unmatched results", () => {
  let model = addToolCall(createTuiModel(), { role: "junior", tool: "shell", callId: "a", args: "one" });
  model = addToolCall(model, { role: "junior", tool: "shell", callId: "b", args: "two" });
  model = addToolResult(model, { role: "junior", tool: "shell", callId: "a", status: "ok", result: "first done" });
  assert.equal(model.blocks.length, 2);
  assert.equal((model.blocks[0] as ToolBlock).status, "ok");
  assert.equal((model.blocks[0] as ToolBlock).result, "first done");
  assert.equal((model.blocks[1] as ToolBlock).status, "call");
  model = addToolResult(model, { role: "senior", tool: "other", status: "error", result: "no call" });
  assert.equal(model.blocks.length, 3);
  assert.equal((model.blocks[2] as ToolBlock).status, "error");
});

test("model: finalization drops empty drafts and marks every partial interrupted", () => {
  let model = startEnvelopeDraft(createTuiModel(), { role: "senior" });
  model = appendEnvelopeDelta(model, { role: "junior", delta: "unfinished" });
  const finalized = finalizeStreamingDrafts(model);
  assert.equal(finalized.blocks.length, 1);
  assert.deepEqual(finalized.blocks[0], {
    ...model.blocks[1],
    streaming: false,
    committed: false,
    interrupted: true,
  });
  assert.equal(model.blocks[1]?.kind === "envelope" ? model.blocks[1].streaming : undefined, true);
  assert.equal(finalizeStreamingDrafts(finalized), finalized);
});

test("model: stream reduction finalizes drafts on every terminal run state", () => {
  for (const status of ["completed", "failed", "cancelled"] as const) {
    const draft = appendEnvelopeDelta(createTuiModel(), { role: "senior", delta: "partial" });
    const event: StreamEvent = { type: "run_status", status, at: AT };
    const reduced = reduceModelEvent(draft, event);
    assert.equal(reduced.model.blocks[0]?.kind, "envelope");
    assert.equal((reduced.model.blocks[0] as EnvelopeBlock).interrupted, true);
    assert.ok(reduced.status !== undefined);
  }
});

test("model: payload projection is readable and does not impose a character cap", () => {
  const acceptance = ["one", "two"];
  assert.equal(envelopeText("delegation", { work: "implement", acceptance }), "delegation: implement\nacceptance:\n  - one\n  - two");
  assert.equal(envelopeText("unknown", { text: "x" }), "unknown: {\"text\":\"x\"}");
  const long = "x".repeat(10_000);
  assert.equal(blockText(commitEnvelope(createTuiModel(), message("m", "senior", "message", { text: long })).blocks[0]!), long);
});

test("theme: semantic dark, light and ansi16 palettes differ and paint reset safely", () => {
  for (const mode of ["dark", "light", "ansi16"] as const) {
    const theme = createTheme(mode);
    assert.equal(theme.mode, mode);
    assert.equal(theme.color, true);
    assert.ok(theme.tokens.senior !== "");
    assert.equal(theme.paint("senior", "SENIOR"), `${theme.tokens.senior}SENIOR\u001b[0m`);
    assert.equal(theme.paint("senior", ""), "");
  }
  assert.notEqual(createTheme("dark").tokens.text, createTheme("light").tokens.text);
  assert.equal(plainTheme.paint("error", "x"), "x");
});

test("theme: NO_COLOR, TERM=dumb and explicit false are authoritative", () => {
  assert.equal(colorEnabled({ NO_COLOR: "1" }), false);
  assert.equal(colorEnabled({ NO_COLOR: "" }), true);
  assert.equal(colorEnabled({ TERM: "dumb" }), false);
  assert.equal(resolveTheme({ env: { NO_COLOR: "1" }, color: true }).color, false);
  assert.equal(resolveTheme({ env: {}, color: false }).paint("error", "x"), "x");
  assert.equal(detectThemeMode({ TWO_BROTHERS_THEME: "LIGHT" }), "light");
  assert.equal(detectThemeMode({ TWO_BROTHERS_THEME: "ansi16" }), "ansi16");
  assert.equal(detectThemeMode({ COLORFGBG: "0;15" }), "light");
  assert.equal(detectThemeMode({}), "dark");
});

test("screen: sanitization removes terminal controls before display and wrapping", () => {
  const hostile = `${ESC}[31mred${ESC}[0m ${ESC}]0;title\u0007ok\r\nnext\t${ESC}7value\u0000`;
  const clean = sanitizeDisplayText(hostile);
  assert.equal(clean, "red ok\nnext    value");
  for (const row of wrapDisplay(hostile, 5)) {
    assert.ok(!row.includes(ESC));
    assert.ok(displayWidth(row) <= 5);
  }
});

test("screen: boxes and composed frames obey exact dimensions", () => {
  const theme = createTheme("ansi16");
  const width = 24;
  const content = wrapDisplay("你好 😀 abcdef", boxContentWidth(width));
  const box = renderBox(content, { width, title: "TEST", theme });
  assert.ok(box.every((row) => styledWidth(row) === width));
  // A title longer than the inner-3 decoration budget must be clipped, not
  // widen the top border (the shared budget the provider view used to work
  // around caller-side).
  const longTitle = renderBox(["x"], { width: 20, title: "APPROVAL REQUIRED · WRITE", theme });
  assert.ok(
    longTitle.every((row) => styledWidth(row) === 20),
    `long title widened a row: ${JSON.stringify(longTitle.map((row) => styledWidth(row)))}`,
  );
  const frame = composeScreen({ width: 20, height: 8, header: ["head"], body, footer: ["foot"], overlay: ["overlay"] });
  assert.equal(frame.length, 8);
  assert.ok(frame.every((row) => styledWidth(row) === 20));
  assert.ok(frame.some((row) => row.includes("overlay")));
  assert.deepEqual(composeScreen({ width: 10, height: 0 }), []);
});

const body = ["one", "two"];

test("transcript: textual roles, decision/dissent and errors survive NO_COLOR", () => {
  let model = addUserBlock(createTuiModel(), "please fix");
  model = commitEnvelope(model, message("j", "junior", "message", { text: "junior answer" }));
  model = commitEnvelope(model, message("d", "senior", "decision", { decision: "done", dissent: "not convinced" }));
  model = addNotice(model, "error", "provider failed", { details: "timeout", retryable: true });
  const rows = renderTranscript(model, { width: 80, theme: plainTheme });
  const text = rows.join("\n");
  for (const label of ["YOU", "JUNIOR", "SENIOR", "ERR", "decision: done", "dissent: not convinced", "retry: available"]) {
    assert.ok(text.includes(label), label);
  }
  assert.deepEqual(labelForBlock(model.blocks[1]!), { text: "JUNIOR", token: "junior" });
  assert.ok(!text.includes(ESC));
});

test("transcript: wrapping is width-safe for Unicode, ANSI and interrupted drafts", () => {
  let model = appendEnvelopeDelta(createTuiModel(), { role: "senior", delta: `${ESC}[31m你好😀abcdef${ESC}[0m` });
  model = finalizeStreamingDrafts(model);
  for (const width of [1, 2, 4, 9, 16, 80]) {
    const rows = renderTranscript(model, { width });
    if (width === 80) assert.ok(rows.some((row) => row.includes("interrupted")));
    for (const row of rows) {
      assert.ok(styledWidth(row) <= width, `${JSON.stringify(row)} exceeds ${width}`);
      assert.ok(!row.includes(`${ESC}[31m`), "model-provided color was stripped");
    }
  }
});

test("transcript: expanded tools bound only the view, not model detail", () => {
  let model = addToolCall(createTuiModel(), { role: "junior", tool: "read", args: "x".repeat(100) });
  model = addToolResult(model, { role: "junior", tool: "read", status: "ok", result: "line\n".repeat(30) });
  const rows = renderTranscript(model, { width: 40, expandedTools: true, maxToolRows: 4 });
  assert.ok(rows.join("\n").includes("more lines"));
  assert.ok((model.blocks[0] as ToolBlock).result!.length > 100);
});

test("markdown: headings carry one textual marker per supported level", () => {
  assert.deepEqual(renderMarkdown("# One\n## Two\n### Three", 40), ["# One", "## Two", "### Three"]);
  assert.deepEqual(renderMarkdown("#### Deep stays literal", 40), ["#### Deep stays literal"]);
  const wrapped = renderMarkdown("### " + "word ".repeat(20), 16);
  assert.ok(wrapped[0]!.startsWith("### "));
  assert.ok(wrapped.length > 1, "long headings wrap");
  for (const row of wrapped) assert.ok(displayWidth(row) <= 16, JSON.stringify(row));
});

test("markdown: bold, italic and inline code render without their markers", () => {
  assert.equal(
    renderMarkdown("Use **bold**, *italic* and `code` here.", 60).join("\n"),
    "Use bold, italic and code here.",
  );
  assert.equal(renderMarkdown("**bold *italic* bold**", 60).join("\n"), "bold italic bold");
  assert.equal(renderMarkdown("a `literal **star**` span", 60)[0], "a literal **star** span");
});

test("markdown: bullets and numbered items nest one level with a hanging indent", () => {
  assert.deepEqual(renderMarkdown("- one\n  - nested\n1. first\n  2. second", 40), [
    "- one",
    "  - nested",
    "1. first",
    "  2. second",
  ]);
  const wrapped = renderMarkdown("- " + "alpha ".repeat(20) + "\n  - " + "beta ".repeat(20), 20);
  assert.ok(wrapped[0]!.startsWith("- "));
  assert.ok(wrapped.some((row) => row.startsWith("  - ")));
  for (const row of wrapped) assert.ok(displayWidth(row) <= 20, JSON.stringify(row));
});

test("markdown: blockquotes get a two-column gutter and stay width-safe", () => {
  const rows = renderMarkdown("> quoted text that has to wrap", 16);
  assert.ok(rows[0]!.startsWith("│ "));
  for (const row of rows) {
    assert.ok(row.startsWith("│ ") || row.startsWith("  "), JSON.stringify(row));
    assert.ok(displayWidth(row) <= 16, JSON.stringify(row));
  }
  assert.doesNotThrow(() => renderMarkdown("> narrow", 2));
});

test("markdown: --- is a rule capped at the width", () => {
  assert.deepEqual(renderMarkdown("---", 10), ["──────────"]);
  assert.deepEqual(renderMarkdown("***", 4), ["────"]);
});

test("markdown: fenced code keeps its language label and code rows verbatim", () => {
  assert.deepEqual(renderMarkdown("```ts\nconst x = 1;\n```", 40), ["┌─ ts", "const x = 1;", "└─"]);
  assert.deepEqual(renderMarkdown("```\nplain code\n```", 40), ["┌─", "plain code", "└─"]);
});

test("markdown: an unclosed fence still renders its code (streaming drafts)", () => {
  assert.deepEqual(renderMarkdown("```js\nconst y = 2;", 40), ["┌─ js", "const y = 2;"]);
  assert.deepEqual(renderMarkdown("```", 20), ["┌─"]);
});

test("markdown: unclosed inline markers stay literal and never throw", () => {
  for (const source of ["**a", "*a", "`a", "[a](b", "unclosed **bold and `tick"]) {
    assert.doesNotThrow(() => renderMarkdown(source, 20));
  }
  assert.equal(
    renderMarkdown("unclosed **bold and `tick and *star", 80)[0],
    "unclosed **bold and `tick and *star",
  );
});

test("markdown: links render as text plus the URL", () => {
  assert.equal(
    renderMarkdown("See [docs](https://example.com/a) now.", 80)[0],
    "See docs (https://example.com/a) now.",
  );
  assert.equal(renderMarkdown("[only-label]()", 40)[0], "only-label");
});

test("markdown: long code rows clip with an explicit marker instead of wrapping", () => {
  const rows = renderMarkdown("```\nconst longLine = 'aaaaaaaaaaaaaaaaaaaa';\n```", 12);
  assert.deepEqual(rows, ["┌─", "const longL…", "└─"]);
  const long = renderMarkdown("word ".repeat(80), 12);
  for (const row of long) assert.ok(displayWidth(row) <= 12, JSON.stringify(row));
});

test("markdown: a 200 KB body renders in under two seconds and stays width-safe", () => {
  const section = [
    "## Build report",
    "",
    "The build **passed** with *one* warning and `npm test` green.",
    "",
    "- first item",
    "  - nested with [a link](https://example.com/path)",
    "1. numbered",
    "",
    "> quoted guidance that wraps in most widths",
    "",
    "```ts",
    "const answer = 42;",
    "```",
    "",
  ].join("\n");
  const source = section.repeat(Math.ceil(200_000 / section.length));
  assert.ok(source.length >= 200_000);
  const started = Date.now();
  const rows = renderMarkdown(source, 100);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2_000, `${source.length} chars took ${elapsed} ms`);
  assert.ok(rows.length > 1_000);
  for (const row of rows) assert.ok(displayWidth(row) <= 100, JSON.stringify(row));
});

test("transcript: assistant bodies are markdown while user and tool rows stay literal", () => {
  let model = addUserBlock(createTuiModel(), "# not a heading");
  model = commitEnvelope(
    model,
    message("m-md", "senior", "message", { text: "# Heading\n\n- **bold** item\n\n```ts\nx\n```" }),
  );
  model = addToolCall(model, { role: "junior", tool: "shell", args: "# not a heading" });
  model = addToolResult(model, { role: "junior", tool: "shell", status: "ok", result: "- not a list" });
  const rows = renderBlock(model.blocks[1]!, { width: 60, theme: plainTheme });
  assert.ok(rows[0]!.startsWith("SENIOR  # Heading"), rows[0]);
  assert.ok(rows.join("\n").includes("- bold item"));
  assert.ok(rows.join("\n").includes("┌─ ts"));
  const all = renderTranscript(model, { width: 60, theme: plainTheme, expandedTools: true }).join("\n");
  assert.ok(all.includes("# not a heading"), "user text is not reinterpreted");
  assert.ok(all.includes("- not a list"), "tool text is not reinterpreted");
  const raw = renderBlock(model.blocks[1]!, { width: 60, theme: plainTheme });
  for (const row of raw) assert.ok(!row.includes(ESC), "markdown output is plain text");
});

test("transcript: inline emphasis is theme-painted while NO_COLOR stays byte-identical", () => {
  const body = "Use **bold**, *italic*, `code` and [docs](https://example.com/a).";
  const model = commitEnvelope(
    createTuiModel(),
    message("m-emphasis", "senior", "message", { text: body }),
  );
  const block = model.blocks[0]!;
  const plainRows = renderBlock(block, { width: 80, theme: plainTheme });
  const expected = renderMarkdown(body, 72).map(
    (row, index) => (index === 0 ? "SENIOR  " : "        ") + row,
  );
  assert.deepEqual(plainRows, expected);
  for (const row of plainRows) assert.ok(!row.includes(ESC), "NO_COLOR rows carry no escapes");

  const themed = renderBlock(block, { width: 80, theme: createTheme("dark") });
  const text = themed.join("\n");
  for (const sgr of ["\u001b[1m", "\u001b[3m", "\u001b[2m", "\u001b[4m"]) {
    assert.ok(text.includes(sgr), `emphasis ${JSON.stringify(sgr)} is painted`);
  }
  assert.deepEqual(themed.map(stripAnsi), plainRows, "colour never changes the content");
  assert.deepEqual(
    renderBlock(block, { width: 80, theme: resolveTheme({ env: { NO_COLOR: "1" } }) }),
    plainRows,
  );
});

test("transcript: styled emphasis rows stay width-safe at every width", () => {
  const model = commitEnvelope(
    createTuiModel(),
    message("m-wide-style", "junior", "deliverable", {
      result:
        "## 标题\n\nUse **你好世界** and *👨‍👩‍👧‍👦* with `代码` and [docs](https://example.com/a).\n\n```diff\n-old\n+new\n```",
    }),
  );
  const block = model.blocks[0]!;
  const theme = createTheme("ansi16");
  for (const width of [1, 2, 4, 9, 16, 40, 80]) {
    const plainRows = renderBlock(block, { width, theme: plainTheme });
    const themedRows = renderBlock(block, { width, theme });
    assert.equal(themedRows.length, plainRows.length, `row count @${width}`);
    for (let index = 0; index < plainRows.length; index += 1) {
      assert.deepEqual(stripAnsi(themedRows[index] ?? ""), plainRows[index], `content @${width}`);
      assert.ok(
        styledWidth(themedRows[index] ?? "") <= width,
        `${JSON.stringify(themedRows[index])} exceeds ${width}`,
      );
    }
  }
});

// --------------------------------------------------------------------------- //
// diff styling
// --------------------------------------------------------------------------- //

function numberedLines(prefix: string, count: number): string {
  return Array.from({ length: count }, (_, index) => `${prefix}${index}`).join("\n");
}

test("markdown: diff and patch fences mark removed, added and hunk rows", () => {
  const rows = renderMarkdown(
    "```diff\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-old\n+new\n context\n```",
    60,
  );
  assert.deepEqual(rows, [
    "┌─ diff",
    "- --- a/x",
    "+ +++ b/x",
    "@@ @@ -1,2 +1,2 @@",
    "- -old",
    "+ +new",
    " context",
    "└─",
  ]);
  assert.deepEqual(renderMarkdown("```patch\n@@ -1 +1 @@\n-a\n+b\n```", 40), [
    "┌─ patch",
    "@@ @@ -1 +1 @@",
    "- -a",
    "+ +b",
    "└─",
  ]);
  for (const width of [4, 8, 13, 40]) {
    for (const row of renderMarkdown(
      "```diff\n--- a/very/long/path\n+added line that is long\n```",
      width,
    )) {
      assert.ok(displayWidth(row) <= width, `${JSON.stringify(row)} exceeds ${width}`);
    }
  }
});

test("markdown: a plain unified diff renders as marked code, not Markdown", () => {
  const rows = renderMarkdown("--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-old\n+new", 60);
  assert.deepEqual(rows, [
    "┌─ diff",
    "- --- a/x",
    "+ +++ b/x",
    "@@ @@ -1,2 +1,2 @@",
    "- -old",
    "+ +new",
    "└─",
  ]);
  // A lone `---` rule followed by prose is still a rule, never a diff.
  const rule = renderMarkdown("---\ntitle: not a diff", 40);
  assert.ok(!rule.some((row) => row.startsWith("┌─")), rule.join("\n"));
  assert.ok(/^─+$/.test(rule[0]!), rule[0]);
  // The run ends at the blank line, so following Markdown is parsed again.
  const mixed = renderMarkdown(
    "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n\n- **bold** item",
    60,
  );
  assert.ok(mixed.includes("┌─ diff"));
  assert.ok(mixed.includes("- bold item"));
});

test("markdown: non-diff fences keep their rows verbatim", () => {
  assert.deepEqual(
    renderMarkdown("```ts\n- removed-looking\n+ added-looking\n@@ hunk?\n```", 40),
    ["┌─ ts", "- removed-looking", "+ added-looking", "@@ hunk?", "└─"],
  );
  assert.equal(renderMarkdown("```text\n--- a/x\n```", 40)[1], "--- a/x");
  assert.equal(renderMarkdown("```\n-old\n+new\n```", 40)[1], "-old");
});

// --------------------------------------------------------------------------- //
// tool-result expansion
// --------------------------------------------------------------------------- //

test("transcript: collapsed tool rows show six lines plus a marker, expanded rows all lines", () => {
  let model = addToolCall(createTuiModel(), { role: "junior", tool: "read", callId: "c1" });
  model = addToolResult(model, {
    role: "junior",
    tool: "read",
    callId: "c1",
    status: "ok",
    result: numberedLines("line ", 12),
  });
  const block = model.blocks[0]!;
  const rows = renderBlock(block, { width: 80, theme: plainTheme });
  assert.equal(rows.length, 8, rows.join("\n"));
  assert.ok(rows.at(-1)!.includes("… +6 more lines"), rows.at(-1));
  const joined = rows.join("\n");
  assert.ok(joined.includes("result: line 0"));
  assert.ok(joined.includes("line 5"));
  assert.ok(!joined.includes("line 6"));

  // The preview cap follows maxToolRows.
  const narrow = renderBlock(block, { width: 80, theme: plainTheme, maxToolRows: 2 });
  assert.ok(narrow.join("\n").includes("… +10 more lines"));

  // Expanding the row shows every line and the call detail.
  const keys = toggleNewestToolExpansion(model, new Set()).keys;
  const expanded = renderBlock(withToolExpansion(model, keys).blocks[0]!, {
    width: 80,
    theme: plainTheme,
  });
  const all = expanded.join("\n");
  assert.ok(all.includes("call: c1"));
  assert.ok(all.includes("line 11"));
  assert.ok(!all.includes("more lines"));
});

test("transcript: collapsed tool preview bounds wrapped visual rows and counts the hidden rows", () => {
  const result = "x".repeat(60);
  let model = addToolCall(createTuiModel(), { role: "junior", tool: "read", callId: "wrapped" });
  model = addToolResult(model, {
    role: "junior",
    tool: "read",
    callId: "wrapped",
    status: "ok",
    result,
  });
  const block = model.blocks[0]!;

  // At width 28 the content column is 20 cells. The 68-cell result row wraps
  // to four visual rows, so a two-row preview hides exactly two rows.
  assert.deepEqual(renderBlock(block, { width: 28, theme: plainTheme, maxToolRows: 2 }), [
    "TOOL    junior · read — ok",
    "        result:",
    `        ${"x".repeat(20)}`,
    "        … +2 more lines",
  ]);
  assert.equal((model.blocks[0] as ToolBlock).result, result, "the model retains the full result");

  // Per-call expansion still bypasses the preview cap and shows the full tail.
  const keys = toggleNewestToolExpansion(model, new Set()).keys;
  const expanded = withToolExpansion(model, keys).blocks[0]!;
  assert.deepEqual(renderBlock(expanded, { width: 28, theme: plainTheme, maxToolRows: 2 }), [
    "TOOL    junior · read — ok",
    "        call: wrapped",
    "        result:",
    `        ${"x".repeat(20)}`,
    `        ${"x".repeat(20)}`,
    `        ${"x".repeat(20)}`,
  ]);
});

test("transcript: collapsed tool preview counts narrow CJK and emoji visual rows", () => {
  const result = `終👨‍👩‍👧‍👦${ESC}[31m${"終".repeat(6)}${ESC}[0m${"😀".repeat(4)}`;
  let model = addToolCall(createTuiModel(), { role: "junior", tool: "read" });
  model = addToolResult(model, { role: "junior", tool: "read", status: "ok", result });
  const rows = renderBlock(model.blocks[0]!, { width: 16, theme: plainTheme, maxToolRows: 2 });

  assert.deepEqual(rows.slice(-3), [
    "result:",
    `終👨‍👩‍👧‍👦${"終".repeat(6)}`,
    "… +1 more lines",
  ]);
  assert.ok(rows.every((row) => styledWidth(row) <= 16), rows.join("\n"));
  assert.ok(rows.every((row) => !row.includes(ESC)), "plain output strips model-provided ANSI");
  assert.equal((model.blocks[0] as ToolBlock).result, result);
});

test("transcript: tool expansion is per call id, isolated and survives unrelated updates", () => {
  let model = addToolCall(createTuiModel(), { role: "junior", tool: "shell", callId: "a" });
  model = addToolCall(model, { role: "junior", tool: "shell", callId: "b" });
  model = addToolResult(model, {
    role: "junior",
    tool: "shell",
    callId: "a",
    status: "ok",
    result: numberedLines("a", 8),
  });
  model = addToolResult(model, {
    role: "junior",
    tool: "shell",
    callId: "b",
    status: "ok",
    result: numberedLines("b", 8),
  });

  const none = toggleNewestToolExpansion(createTuiModel(), new Set());
  assert.equal(none.key, null);
  assert.equal(none.expanded, false);

  assert.equal(toolExpansionKey(model.blocks[0] as ToolBlock), "call:a");
  assert.equal(newestToolBlock(model)?.callId, "b");
  assert.equal(withToolExpansion(model, new Set()), model, "empty keys keep model identity");

  const first = toggleNewestToolExpansion(model, new Set());
  assert.equal(first.key, "call:b");
  assert.equal(first.expanded, true);
  const keys = first.keys;

  const expanded = withToolExpansion(model, keys);
  const older = renderBlock(expanded.blocks[0]!, { width: 80, theme: plainTheme }).join("\n");
  const newest = renderBlock(expanded.blocks[1]!, { width: 80, theme: plainTheme }).join("\n");
  assert.ok(newest.includes("b7") && !newest.includes("more lines"), newest);
  assert.ok(older.includes("more lines") && !older.includes("a7"), older);

  // A streaming reply from another role must not reset the keyed row.
  const streamed = appendEnvelopeDelta(model, { role: "senior", delta: "working" });
  const after = withToolExpansion(streamed, keys);
  assert.ok(
    renderBlock(after.blocks[1]!, { width: 80, theme: plainTheme }).join("\n").includes("b7"),
  );

  const second = toggleNewestToolExpansion(model, keys);
  assert.equal(second.expanded, false);
  assert.equal(second.keys.has("call:b"), false);
  assert.equal(second.keys.has("call:a"), false);

  // A row without a call id falls back to its stable block id.
  let anonymous = addToolCall(createTuiModel(), { role: "senior", tool: "echo" });
  assert.equal(toolExpansionKey(anonymous.blocks[0] as ToolBlock), "block:b1");
  anonymous = addToolResult(anonymous, {
    role: "senior",
    tool: "echo",
    status: "ok",
    result: numberedLines("x", 8),
  });
  const fallback = toggleNewestToolExpansion(anonymous, new Set());
  assert.equal(fallback.key, "block:b1");
  assert.ok(
    renderBlock(withToolExpansion(anonymous, fallback.keys).blocks[0]!, { width: 80, theme: plainTheme })
      .join("\n")
      .includes("x7"),
  );
});

test("transcript: expanded tool detail stays width-safe at every width", () => {
  let model = addToolCall(createTuiModel(), {
    role: "senior",
    tool: "read",
    callId: "wide",
    args: "x".repeat(200),
  });
  model = addToolResult(model, {
    role: "senior",
    tool: "read",
    callId: "wide",
    status: "ok",
    result: "終".repeat(40) + "\n" + "word ".repeat(60),
  });
  const keys = toggleNewestToolExpansion(model, new Set()).keys;
  const expanded = withToolExpansion(model, keys);
  for (const width of [1, 2, 4, 9, 16, 40, 80]) {
    for (const row of renderTranscript(expanded, { width, theme: plainTheme })) {
      assert.ok(styledWidth(row) <= width, `${JSON.stringify(row)} exceeds ${width}`);
    }
  }
  assert.ok(
    renderTranscript(expanded, { width: 40, theme: plainTheme }).join("\n").includes("word word"),
  );
});

test("keymap: Ctrl+T toggles tool expansion and conflicts with no other binding", () => {
  const command = findCommand(TUI_COMMANDS, "tool-expand");
  assert.ok(command);
  assert.equal(command.group, "Transcript");
  assert.equal(formatKeys(command), "Ctrl+T");

  const key = { name: "t", ctrl: true, raw: "\u0014" };
  assert.equal(resolveKey(TUI_COMMANDS, key)?.command.id, "tool-expand");
  const conflicts = TUI_COMMANDS.filter(
    (candidate) =>
      candidate.id !== "tool-expand" &&
      (candidate.keys ?? []).some((chord) => matchChord(chord, key)),
  );
  assert.deepEqual(conflicts.map((candidate) => candidate.id), []);

  assert.ok(paletteEntries(TUI_COMMANDS).some((entry) => entry.id === "tool-expand"));
  assert.ok(documentEntries(TUI_COMMANDS).some((entry) => entry.id === "tool-expand"));
  assert.match(tuiHelpLines(TUI_COMMANDS).join("\n"), /Ctrl\+T\s+Show every line/);
  assert.ok(
    !TUI_COMMANDS.some((candidate) =>
      (candidate.keys ?? []).some(
        (chord) => chord.ctrl === true && /^[sq]$/i.test(chord.name),
      ),
    ),
    "Ctrl+S / Ctrl+Q (XON/XOFF) stay unbound",
  );
});

test("keymap: Ctrl+B toggles the status panel and conflicts with no other binding", () => {
  const command = findCommand(TUI_COMMANDS, "panel");
  assert.ok(command);
  assert.equal(command.title, "Status panel");
  assert.equal(command.group, "Settings");
  assert.equal(command.slash, "panel");
  assert.equal(findSlashCommand(TUI_COMMANDS, "panel")?.id, "panel");
  assert.equal(formatKeys(command), "Ctrl+B");

  const key = { name: "b", ctrl: true, raw: "\u0002" };
  assert.equal(resolveKey(TUI_COMMANDS, key)?.command.id, "panel");
  assert.equal(
    resolveKey(TUI_COMMANDS, key, "overlay"),
    null,
    "the panel chord is app-scope only; an overlay keeps its own keys",
  );
  const conflicts = TUI_COMMANDS.filter(
    (candidate) =>
      candidate.id !== "panel" &&
      (candidate.keys ?? []).some((chord) => matchChord(chord, key)),
  );
  assert.deepEqual(conflicts.map((candidate) => candidate.id), []);

  assert.ok(paletteEntries(TUI_COMMANDS).some((entry) => entry.id === "panel"));
  assert.ok(documentEntries(TUI_COMMANDS).some((entry) => entry.id === "panel"));
  assert.match(tuiHelpLines(TUI_COMMANDS).join("\n"), /Ctrl\+B\s+Show or hide the right-hand status panel/);
  assert.match(tuiHelpLines(TUI_COMMANDS).join("\n"), /\/panel\s+Show or hide/);
  assert.ok(
    !TUI_COMMANDS.some((candidate) =>
      (candidate.keys ?? []).some(
        (chord) => chord.ctrl === true && /^[sq]$/i.test(chord.name),
      ),
    ),
    "Ctrl+S / Ctrl+Q (XON/XOFF) stay unbound",
  );
});

test("status bar: the row-two priority order is activity, hints, metrics, settings warning", () => {
  // Hints outrank optional metrics and the duplicated settings warning so the
  // tool-fold hint can appear at ordinary widths; activity stays first because
  // it is live turn state.
  const [, populated] = statusBarSegments({
    mode: "consult",
    activity: "working",
    seniorModel: "s",
    juniorModel: "j",
    contextTokens: 1_000,
    contextWindow: 2_000,
    inputTokens: 3,
    outputTokens: 4,
    cachedTokens: 1,
    cost: 0.006,
    elapsedMs: 7_000,
    hints: "Ctrl+T expand tool",
  });
  assert.deepEqual(
    populated.map((segment) => segment.text),
    [
      "working",
      "Ctrl+T expand tool",
      "context 1.0k/2.0k",
      "tokens 3 in · 4 out",
      "cache 33%",
      "cost $0.0060",
      "7s",
    ],
  );

  // Without hints in the state the registry default takes the same early seat;
  // the settings warning is always last.
  const [, bare] = statusBarSegments({ mode: "consult" });
  assert.deepEqual(
    bare.map((segment) => segment.text),
    ["Ctrl+P commands · ? / F1 help", "/settings configures models"],
  );

  // The running marker stays on row one (live state), the hint stays first on
  // row two: the priority change never moves identity segments between rows.
  const [firstRow, secondRow] = statusBarSegments({ mode: "work", running: true, hints: "h" });
  assert.deepEqual(firstRow.slice(0, 2).map((segment) => segment.text), ["work", "RUNNING"]);
  assert.equal(secondRow[0]?.text, "h");
});
