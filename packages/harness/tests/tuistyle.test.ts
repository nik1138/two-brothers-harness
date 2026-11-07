/**
 * TUI span-level Markdown emphasis suite.
 *
 * Covers the per-span style model behind the transcript's Markdown bodies:
 * inline emphasis (`**bold**`, `*italic*`, `` `code` ``, `[text](url)`),
 * structural marker spans (headings/lists/quotes/fences/diffs), span-
 * preserving wrapping at grapheme/East-Asian-width boundaries, colour-theme
 * painting (ANSI only around spans, resets, no width change), and the
 * critical NO_COLOR guarantee: plain-theme rows are byte-identical to the
 * pre-span renderer.
 *
 * The frozen `PLAIN_BASELINE`/`TRANSCRIPT_BASELINE`/`BLOCK_BASELINE` literals
 * below were captured from the renderer BEFORE span styling was introduced
 * (same corpus, same widths); they are the regression evidence that the
 * styled model's plain projection did not change a single byte.
 *
 * Run with: node --test tests/tuistyle.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import type { Message } from "../src/protocol.ts";
import type { EnvelopeBlock } from "../src/tui/model.ts";
import {
  addNotice,
  addUserBlock,
  appendEnvelopeDelta,
  commitEnvelope,
  createTuiModel,
} from "../src/tui/model.ts";
import { renderMarkdown } from "../src/tui/markdown.ts";
import {
  renderMarkdownStyled,
  styledLineText,
  styledSpansText,
  type StyledLine,
} from "../src/tui/markdownstyle.ts";
import { clipStyled, fitStyled, stripAnsi, styledWidth } from "../src/tui/screen.ts";
import {
  displayWidth,
  truncateRuns,
  truncateToWidth,
  wrapRuns,
  wrapText,
} from "../src/tui/text.ts";
import { createTheme, plainTheme, resolveTheme } from "../src/tui/theme.ts";
import { markTopSliceRow, renderBlock, renderTranscript } from "../src/tui/transcript.ts";
import {
  TUI_COMMANDS,
  paletteEntries,
  type PaletteEntry,
} from "../src/tui/keymap.ts";
import { createPaletteState, paletteView } from "../src/tui/view/palette.ts";
import { createHelpState, helpEntries, helpView } from "../src/tui/view/help.ts";
import { latestTranscriptScroll, transcriptView } from "../src/tui/view/transcript.ts";

const ESC = "\u001b";
const AT = "2026-11-04T00:00:00Z";

function message(
  id: string,
  from: string,
  kind: string,
  payload: Record<string, unknown>,
  seq = 1,
): Message {
  return { v: 1, id, seq, ts: AT, from, to: from === "user" ? "senior" : "user", kind, payload };
}

/** One committed envelope block with `text` as its message body. */
function envelopeBlock(text: string, role: "senior" | "junior" = "senior"): EnvelopeBlock {
  const model = commitEnvelope(
    createTuiModel(),
    message(`m-${role}`, role, "message", { text }),
  );
  const block = model.blocks[0];
  assert.ok(block !== undefined && block.kind === "envelope");
  return block as EnvelopeBlock;
}

/** The model whose pre-span plain rows are frozen in TRANSCRIPT_BASELINE. */
function styleModel() {
  let model = addUserBlock(createTuiModel(), "please fix **the** bug");
  model = commitEnvelope(
    model,
    message(
      "m1",
      "senior",
      "message",
      {
        text: "## Plan\n\nUse **bold**, *italic*, `code` and [docs](https://example.com/a).\n\n```diff\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n```",
      },
      2,
    ),
  );
  model = commitEnvelope(
    model,
    message("m2", "junior", "message", { text: "- one\n- two with **bold** and 你好 😀" }, 3),
  );
  model = addNotice(model, "error", "provider failed", { details: "timeout", retryable: true });
  return model;
}

function styledRows(text: string, width = 80): StyledLine[] {
  return renderMarkdownStyled(text, width);
}

function rowsText(lines: readonly StyledLine[]): string[] {
  return lines.map(styledLineText);
}

// --------------------------------------------------------------------------- //
// frozen pre-span baselines (captured before the span model landed)
// --------------------------------------------------------------------------- //

const PLAIN_BASELINE: readonly { text: string; width: number; rows: readonly string[] }[] = [
  { text: "# One\n## Two\n### Three\n#### Deep stays literal", width: 12, rows: ["# One","## Two","### Three","#### Deep","stays","literal"] },
  { text: "# One\n## Two\n### Three\n#### Deep stays literal", width: 16, rows: ["# One","## Two","### Three","#### Deep stays","literal"] },
  { text: "# One\n## Two\n### Three\n#### Deep stays literal", width: 40, rows: ["# One","## Two","### Three","#### Deep stays literal"] },
  { text: "# **Bold** and `code` and [link](https://example.com/x)", width: 40, rows: ["# Bold and code and link","  (https://example.com/x)"] },
  { text: "Use **bold**, *italic* and `code` here.", width: 12, rows: ["Use bold,","italic and","code here."] },
  { text: "Use **bold**, *italic* and `code` here.", width: 40, rows: ["Use bold, italic and code here."] },
  { text: "**bold *italic* bold**", width: 40, rows: ["bold italic bold"] },
  { text: "a `literal **star**` span", width: 40, rows: ["a literal **star** span"] },
  { text: "See [docs](https://example.com/a) now.\n[only-label]()", width: 12, rows: ["See docs","(https://exa","mple.com/a)","now.","only-label"] },
  { text: "See [docs](https://example.com/a) now.\n[only-label]()", width: 40, rows: ["See docs (https://example.com/a) now.","only-label"] },
  { text: "- one\n  - nested\n1. first\n  2. second", width: 20, rows: ["- one","  - nested","1. first","  2. second"] },
  { text: "- one\n  - nested\n1. first\n  2. second", width: 40, rows: ["- one","  - nested","1. first","  2. second"] },
  { text: "- alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha \n  - beta beta beta beta beta beta beta beta beta beta beta beta beta beta beta beta beta beta beta beta ", width: 20, rows: ["- alpha alpha alpha","  alpha alpha alpha","  alpha alpha alpha","  alpha alpha alpha","  alpha alpha alpha","  alpha alpha alpha","  alpha alpha","  - beta beta beta","    beta beta beta","    beta beta beta","    beta beta beta","    beta beta beta","    beta beta beta","    beta beta"] },
  { text: "> quoted text that has to wrap", width: 16, rows: ["│ quoted text","  that has to","  wrap"] },
  { text: "> **quoted** `code` [link](u)", width: 20, rows: ["│ quoted code link","  (u)"] },
  { text: "---\n***\n___", width: 12, rows: ["────────────","────────────","────────────"] },
  { text: "```ts\nconst x = 1;\n```", width: 40, rows: ["┌─ ts","const x = 1;","└─"] },
  { text: "```js\nconst y = 2;", width: 40, rows: ["┌─ js","const y = 2;"] },
  { text: "````ts\ncode\n````", width: 40, rows: ["┌─ `ts","code","└─"] },
  { text: "```diff\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-old\n+new\n context\n```", width: 16, rows: ["┌─ diff","- --- a/x","+ +++ b/x","@@ @@ -1,2 +1,2…","- -old","+ +new"," context","└─"] },
  { text: "```diff\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-old\n+new\n context\n```", width: 40, rows: ["┌─ diff","- --- a/x","+ +++ b/x","@@ @@ -1,2 +1,2 @@","- -old","+ +new"," context","└─"] },
  { text: "```patch\n@@ -1 +1 @@\n-a\n+b\n```", width: 40, rows: ["┌─ patch","@@ @@ -1 +1 @@","- -a","+ +b","└─"] },
  { text: "--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-old\n+new", width: 16, rows: ["┌─ diff","- --- a/x","+ +++ b/x","@@ @@ -1,2 +1,2…","- -old","+ +new","└─"] },
  { text: "--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-old\n+new", width: 40, rows: ["┌─ diff","- --- a/x","+ +++ b/x","@@ @@ -1,2 +1,2 @@","- -old","+ +new","└─"] },
  { text: "```diff\n--- a/very/long/path\n+added line that is long\n```", width: 12, rows: ["┌─ diff","- --- a/ver…","+ +added li…","└─"] },
  { text: "---\ntitle: not a diff", width: 40, rows: ["────────────────────────────────────────","title: not a diff"] },
  { text: "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n\n- **bold** item", width: 40, rows: ["┌─ diff","- --- a/x","+ +++ b/x","@@ @@ -1 +1 @@","- -a","+ +b","└─","","- bold item"] },
  { text: "```ts\n- removed-looking\n+ added-looking\n@@ hunk?\n```", width: 40, rows: ["┌─ ts","- removed-looking","+ added-looking","@@ hunk?","└─"] },
  { text: "```\n-old\n+new\n```", width: 40, rows: ["┌─","-old","+new","└─"] },
  { text: "unclosed **bold and `tick and *star", width: 80, rows: ["unclosed **bold and `tick and *star"] },
  { text: "```\nconst longLine = 'aaaaaaaaaaaaaaaaaaaa';\n```", width: 12, rows: ["┌─","const longL…","└─"] },
  { text: "你好 **世界** 😀 `代码` *斜体*", width: 12, rows: ["你好 世界 😀","代码 斜体"] },
  { text: "你好 **世界** 😀 `代码` *斜体*", width: 40, rows: ["你好 世界 😀 代码 斜体"] },
  { text: "family 👨‍👩‍👧‍👦 flag 🇺🇸 keycap 1️⃣ combining é", width: 16, rows: ["family 👨‍👩‍👧‍👦 flag","🇺🇸 keycap 1️⃣","combining é"] },
  { text: "family 👨‍👩‍👧‍👦 flag 🇺🇸 keycap 1️⃣ combining é", width: 40, rows: ["family 👨‍👩‍👧‍👦 flag 🇺🇸 keycap 1️⃣ combining é"] },
  { text: "## Build report\n\nThe build **passed** with *one* warning and `npm test` green.\n\n- first item\n  - nested with [a link](https://example.com/path)\n1. numbered\n\n> quoted guidance that wraps in most widths\n\n```ts\nconst answer = 42;\n```", width: 40, rows: ["## Build report","","The build passed with one warning and","npm test green.","","- first item","  - nested with a link","    (https://example.com/path)","1. numbered","","│ quoted guidance that wraps in most","  widths","","┌─ ts","const answer = 42;","└─"] },
  { text: "a\tb\r\nc\r\n**b\told**", width: 40, rows: ["a   b","c","b old"] },
  { text: "\u0007bell\u001b[31mred\u001b[0m", width: 40, rows: ["bellred"] },
  { text: "****a****", width: 40, rows: ["a"] },
  { text: "**[bold](https://x.test)**", width: 40, rows: ["bold (https://x.test)"] },
  { text: "- \n- \n>\n# ", width: 16, rows: ["- ","- ","│ ","# "] },
  { text: "", width: 12, rows: [""] },
  { text: "\n", width: 12, rows: ["",""] },
  { text: "   ", width: 12, rows: [""] },
  { text: "\n\n", width: 12, rows: ["","",""] },
];

const TRANSCRIPT_BASELINE: readonly { width: number; rows: readonly string[] }[] = [
  { width: 12, rows: ["YOU","please fix","**the** bug","","SENIOR","## Plan","","Use bold,","italic, code","and docs","(https://exa","mple.com/a).","","┌─ diff","- --- a/x","+ +++ b/x","@@ @@ -1 +1…","- -old","+ +new","└─","","JUNIOR","- one","- two with","  bold and","  你好 😀","","ERR","provider","failed","details:","timeout","retry:","available"] },
  { width: 24, rows: ["YOU     please fix","        **the** bug","","SENIOR  ## Plan","        ","        Use bold,","        italic, code and","        docs","        (https://example","        .com/a).","        ","        ┌─ diff","        - --- a/x","        + +++ b/x","        @@ @@ -1 +1 @@","        - -old","        + +new","        └─","","JUNIOR  - one","        - two with bold","          and 你好 😀","","ERR     provider failed","        details: timeout","        retry: available"] },
  { width: 40, rows: ["YOU     please fix **the** bug","","SENIOR  ## Plan","        ","        Use bold, italic, code and docs","        (https://example.com/a).","        ","        ┌─ diff","        - --- a/x","        + +++ b/x","        @@ @@ -1 +1 @@","        - -old","        + +new","        └─","","JUNIOR  - one","        - two with bold and 你好 😀","","ERR     provider failed","        details: timeout","        retry: available"] },
  { width: 80, rows: ["YOU     please fix **the** bug","","SENIOR  ## Plan","        ","        Use bold, italic, code and docs (https://example.com/a).","        ","        ┌─ diff","        - --- a/x","        + +++ b/x","        @@ @@ -1 +1 @@","        - -old","        + +new","        └─","","JUNIOR  - one","        - two with bold and 你好 😀","","ERR     provider failed","        details: timeout","        retry: available"] },
];

const BLOCK_BASELINE: readonly { width: number; rows: readonly string[] }[] = [
  { width: 12, rows: ["SENIOR","## Plan","","Use bold,","italic, code","and docs","(https://exa","mple.com/a).","","┌─ diff","- --- a/x","+ +++ b/x","@@ @@ -1 +1…","- -old","+ +new","└─"] },
  { width: 40, rows: ["SENIOR  ## Plan","        ","        Use bold, italic, code and docs","        (https://example.com/a).","        ","        ┌─ diff","        - --- a/x","        + +++ b/x","        @@ @@ -1 +1 @@","        - -old","        + +new","        └─"] },
  { width: 80, rows: ["SENIOR  ## Plan","        ","        Use bold, italic, code and docs (https://example.com/a).","        ","        ┌─ diff","        - --- a/x","        + +++ b/x","        @@ @@ -1 +1 @@","        - -old","        + +new","        └─"] },
];

// --------------------------------------------------------------------------- //
// inline emphasis spans
// --------------------------------------------------------------------------- //

test("styles: inline emphasis becomes spans without changing the text", () => {
  const [emphasis] = styledRows("Use **bold**, *italic* and `code` here.");
  assert.ok(emphasis !== undefined);
  assert.deepEqual(emphasis.spans, [
    { text: "Use " },
    { text: "bold", style: "bold" },
    { text: ", " },
    { text: "italic", style: "italic" },
    { text: " and " },
    { text: "code", style: "code" },
    { text: " here." },
  ]);
  assert.equal(styledLineText(emphasis), "Use bold, italic and code here.");

  const [link] = styledRows("See [docs](https://example.com/a) now.");
  assert.ok(link !== undefined);
  assert.deepEqual(link.spans, [
    { text: "See " },
    { text: "docs", style: "link" },
    { text: " (https://example.com/a) now." },
  ]);

  const [nested] = styledRows("**bold *italic* bold**");
  assert.ok(nested !== undefined);
  assert.deepEqual(nested.spans, [
    { text: "bold ", style: "bold" },
    { text: "italic", style: "italic" },
    { text: " bold", style: "bold" },
  ]);

  const [literal] = styledRows("a `literal **star**` span");
  assert.ok(literal !== undefined);
  assert.deepEqual(literal.spans, [
    { text: "a " },
    { text: "literal **star**", style: "code" },
    { text: " span" },
  ]);

  // Mixed nesting: the inner code span keeps its own style, the rest is bold.
  const [mixed] = styledRows("**bold with `code`**");
  assert.ok(mixed !== undefined);
  assert.deepEqual(mixed.spans, [
    { text: "bold with ", style: "bold" },
    { text: "code", style: "code" },
  ]);

  const [emptyLabel] = styledRows("[docs](https://example.com)");
  assert.ok(emptyLabel !== undefined);
  assert.deepEqual(emptyLabel.spans, [
    { text: "docs", style: "link" },
    { text: " (https://example.com)" },
  ]);

  // An emphasis pairing that never closes stays literal and unstyled.
  const [unclosed] = styledRows("**left open");
  assert.ok(unclosed !== undefined);
  assert.deepEqual(unclosed.spans, [{ text: "**left open" }]);
});

test("styles: block kinds carry structural marker spans", () => {
  const heading = styledRows("# Heading")[0];
  assert.ok(heading !== undefined);
  assert.equal(heading.kind, "heading");
  assert.deepEqual(heading.spans, [{ text: "# ", style: "marker" }, { text: "Heading" }]);

  const list = styledRows("- item")[0];
  assert.ok(list !== undefined);
  assert.equal(list.kind, "list");
  assert.deepEqual(list.spans, [{ text: "- ", style: "marker" }, { text: "item" }]);

  const quote = styledRows("> quoted")[0];
  assert.ok(quote !== undefined);
  assert.equal(quote.kind, "quote");
  assert.deepEqual(quote.spans, [{ text: "│ ", style: "marker" }, { text: "quoted" }]);

  const rule = styledRows("---", 10)[0];
  assert.ok(rule !== undefined);
  assert.equal(rule.kind, "rule");
  assert.deepEqual(rule.spans, [{ text: "──────────" }]);

  const fence = styledRows("```ts\nconst x = 1;\n```", 40);
  assert.deepEqual(fence.map((line) => line.kind), ["fenceOpen", "code", "fenceClose"]);
  assert.deepEqual(fence[0]?.spans, [{ text: "┌─ ts" }]);
  assert.deepEqual(fence[1]?.spans, [{ text: "const x = 1;" }]);
  assert.deepEqual(fence[2]?.spans, [{ text: "└─" }]);

  const diff = styledRows("```diff\n-old\n+new\n context\n```", 40);
  assert.deepEqual(diff.map((line) => line.kind), [
    "fenceOpen",
    "diff",
    "diff",
    "diff",
    "fenceClose",
  ]);
  assert.deepEqual(diff[1]?.spans, [{ text: "- ", style: "marker" }, { text: "-old" }]);
  assert.deepEqual(diff[2]?.spans, [{ text: "+ ", style: "marker" }, { text: "+new" }]);
  assert.deepEqual(diff[3]?.spans, [{ text: " context" }]);

  const plainDiff = styledRows("--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b", 40);
  assert.deepEqual(plainDiff.map((line) => line.kind), [
    "fenceOpen",
    "diff",
    "diff",
    "diff",
    "diff",
    "diff",
    "fenceClose",
  ]);
  assert.deepEqual(plainDiff[3]?.spans, [
    { text: "@@ ", style: "marker" },
    { text: "@@ -1 +1 @@" },
  ]);

  // A wrap continuation keeps the marker off the continuation rows.
  const wrappedList = styledRows("- " + "alpha ".repeat(8), 12);
  assert.ok(wrappedList.length > 1);
  assert.deepEqual(wrappedList[0]?.spans[0], { text: "- ", style: "marker" });
  assert.deepEqual(wrappedList[1]?.spans[0], { text: "  " });
  for (const line of wrappedList) assert.equal(line.kind, "list");
});

// --------------------------------------------------------------------------- //
// span-preserving wrapping
// --------------------------------------------------------------------------- //

test("wrap: styles stay on their own characters through line breaks", () => {
  const lines = styledRows("aa **bb** cc", 5);
  assert.deepEqual(rowsText(lines), ["aa bb", "cc"]);
  assert.deepEqual(lines[0]?.spans, [{ text: "aa " }, { text: "bb", style: "bold" }]);
  assert.deepEqual(lines[1]?.spans, [{ text: "cc" }]);

  const bold = styledRows("**" + "word ".repeat(8) + "**", 12);
  assert.ok(bold.length > 1);
  for (const line of bold) {
    assert.ok(displayWidth(styledLineText(line)) <= 12);
    assert.ok(!styledLineText(line).includes("*"));
    for (const span of line.spans) assert.equal(span.style, "bold", JSON.stringify(span));
  }

  const cjk = styledRows("**你好世界**", 4);
  assert.deepEqual(rowsText(cjk), ["你好", "世界"]);
  for (const line of cjk) {
    assert.equal(line.spans.length, 1);
    assert.equal(line.spans[0]?.style, "bold");
    assert.equal(displayWidth(styledLineText(line)), 4);
  }

  // A ZWJ emoji sequence stays one grapheme in one span (never split).
  const emoji = styledRows("*👨‍👩‍👧‍👦 ok*", 3);
  assert.deepEqual(rowsText(emoji), ["👨‍👩‍👧‍👦", "ok"]);
  assert.deepEqual(emoji[0]?.spans, [{ text: "👨‍👩‍👧‍👦", style: "italic" }]);
  assert.deepEqual(emoji[1]?.spans, [{ text: "ok", style: "italic" }]);

  // Combining marks wrap as one column and are never split from the base.
  const combining = styledRows("*e\u0301e\u0301e\u0301*", 1);
  assert.deepEqual(rowsText(combining), ["e\u0301", "e\u0301", "e\u0301"]);
  for (const line of combining) assert.equal(displayWidth(styledLineText(line)), 1);

  // An indivisible wide cluster in a one-column row becomes the visible `…`.
  const tooWide = styledRows("*😀你*", 1);
  assert.deepEqual(rowsText(tooWide), ["…", "…"]);
  for (const line of tooWide) assert.deepEqual(line.spans, [{ text: "…" }]);
});

test("wrap: every styled row matches the plain renderer and the width", () => {
  const corpus = [
    "# **Bold** and `code` and [link](https://example.com/x)",
    "The build **passed** with *one* warning and `npm test` green.",
    "**" + "word ".repeat(20) + "**",
    "- **item** with a [link](https://example.com/a)\n1. `code` item",
    "> **quoted** `code` [link](u)",
    "```diff\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n```",
    "你好 **世界** 😀 `代码` *斜体*",
    "family 👨‍👩‍👧‍👦 flag 🇺🇸 keycap 1️⃣ combining e\u0301",
    "**bold *italic* `code`**",
    "unclosed **bold and `tick",
  ];
  for (const text of corpus) {
    for (const width of [1, 2, 3, 4, 5, 7, 9, 12, 16, 20, 40, 80]) {
      const lines = renderMarkdownStyled(text, width);
      assert.deepEqual(rowsText(lines), renderMarkdown(text, width), `${JSON.stringify(text)} @${width}`);
      for (const line of lines) {
        assert.ok(displayWidth(styledLineText(line)) <= width, `${JSON.stringify(styledLineText(line))} @${width}`);
      }
    }
  }
});

test("layout: span-preserving wrap/truncate mirror the plain helpers", () => {
  const samples = [
    "one two three four",
    "你好世界 and words",
    "family 👨‍👩‍👧‍👦 and 🇺🇸 flag",
    "e\u0301e\u0301 combining",
    "prefix supercalifragilisticexpialidocious end",
    "  leading and trailing  ",
    "",
  ];
  for (const sample of samples) {
    for (const width of [1, 2, 3, 4, 5, 7, 12, 40]) {
      const wrapped = wrapRuns([{ text: sample }], width);
      assert.deepEqual(wrapped.map(styledSpansText), wrapText(sample, width), `${JSON.stringify(sample)} @${width}`);
      for (const row of wrapped) assert.ok(displayWidth(styledSpansText(row)) <= width);
    }
    for (const width of [0, 1, 2, 3, 5, 9, 40]) {
      assert.equal(
        styledSpansText(truncateRuns([{ text: sample }], width)),
        truncateToWidth(sample, width),
        `${JSON.stringify(sample)} truncate @${width}`,
      );
    }
  }

  // The style survives the break on every grapheme it covers.
  const bold = wrapRuns([{ text: "abcdef", style: "bold" as const }], 2);
  assert.deepEqual(bold.map(styledSpansText), ["ab", "cd", "ef"]);
  for (const row of bold) for (const run of row) assert.equal(run.style, "bold");

  // A run boundary never splits a grapheme cluster.
  const combining = wrapRuns([{ text: "e", style: "bold" as const }, { text: "\u0301" }], 5);
  assert.deepEqual(combining.map(styledSpansText), ["e\u0301"]);
  assert.equal(combining[0]?.[0]?.style, "bold", "the cluster takes its first code unit's style");
});

// --------------------------------------------------------------------------- //
// NO_COLOR byte-identity (the critical regression)
// --------------------------------------------------------------------------- //

test("plain: renderMarkdown is byte-identical to the pre-span baseline", () => {
  assert.ok(PLAIN_BASELINE.length > 30);
  for (const item of PLAIN_BASELINE) {
    const rows = renderMarkdown(item.text, item.width);
    assert.deepEqual(rows, item.rows, `${JSON.stringify(item.text)} @${item.width}`);
    // The styled model is the same parser: joining its spans is the plain row.
    const lines = renderMarkdownStyled(item.text, item.width);
    assert.deepEqual(rowsText(lines), item.rows, `span join @${item.width}`);
    assert.equal(lines.length, item.rows.length);
  }
});

test("plain: the transcript is byte-identical to the pre-span baseline", () => {
  const model = styleModel();
  const block = model.blocks[1];
  assert.ok(block !== undefined);
  for (const { width, rows } of TRANSCRIPT_BASELINE) {
    const plain = renderTranscript(model, { width, theme: plainTheme });
    assert.deepEqual(plain, rows, `plainTheme @${width}`);
    assert.deepEqual(renderTranscript(model, { width, theme: resolveTheme({ env: { NO_COLOR: "1" } }) }), rows, `NO_COLOR @${width}`);
    assert.deepEqual(renderTranscript(model, { width }), rows, `default theme @${width}`);
    assert.deepEqual(
      renderTranscript(model, { width, theme: createTheme("dark") }).map(stripAnsi),
      rows,
      `a colour theme never changes the content @${width}`,
    );
    for (const row of plain) assert.ok(!row.includes(ESC), "NO_COLOR rows carry no escapes");
  }
  for (const { width, rows } of BLOCK_BASELINE) {
    assert.deepEqual(renderBlock(block, { width, theme: plainTheme }), rows, `renderBlock @${width}`);
  }
});

test("plain: the transcript composes exactly the label gutter plus plain rows", () => {
  const block = envelopeBlock(
    "Use **bold**, *italic*, `code` and [docs](https://example.com/a) here.",
  );
  const text = block.text;
  for (const width of [24, 40, 80]) {
    const contentWidth = width - 8;
    const markdown = renderMarkdown(text, contentWidth);
    const expected = markdown.map(
      (row, index) => (index === 0 ? "SENIOR  " : "        ") + row,
    );
    assert.deepEqual(renderBlock(block, { width, theme: plainTheme }), expected, `@${width}`);
  }
});

// --------------------------------------------------------------------------- //
// colour-theme painting
// --------------------------------------------------------------------------- //

test("theme: paintEmphasis is identity under NO_COLOR and token+attribute otherwise", () => {
  assert.equal(plainTheme.paintEmphasis("senior", "bold", "x"), "x");
  assert.equal(plainTheme.paintEmphasis("senior", undefined, "x"), "x");
  for (const mode of ["dark", "light", "ansi16"] as const) {
    const theme = createTheme(mode);
    assert.equal(theme.paintEmphasis("text", undefined, "x"), theme.paint("text", "x"));
    assert.equal(theme.paintEmphasis("text", "bold", "x"), `${ESC}[1m${theme.tokens.text}x${ESC}[0m`);
    assert.equal(theme.paintEmphasis("text", "italic", "x"), `${ESC}[3m${theme.tokens.text}x${ESC}[0m`);
    assert.equal(theme.paintEmphasis("text", "code", "x"), `${ESC}[2m${theme.tokens.text}x${ESC}[0m`);
    assert.equal(theme.paintEmphasis("text", "link", "x"), `${ESC}[4m${theme.tokens.text}x${ESC}[0m`);
    assert.equal(theme.paintEmphasis("text", "marker", "x"), `${ESC}[2m${theme.tokens.text}x${ESC}[0m`);
    assert.equal(theme.paintEmphasis("text", "bold", ""), "");
  }
  assert.equal(resolveTheme({ env: { NO_COLOR: "1" } }).paintEmphasis("error", "bold", "x"), "x");
});

test("color: emphasis paints ANSI only around spans and keeps the width", () => {
  const theme = createTheme("dark");
  const block = envelopeBlock(
    "Use **bold**, *italic*, `code` and [docs](https://example.com/a) here.",
  );
  const rows = renderBlock(block, { width: 80, theme });
  const text = rows.join("\n");
  assert.ok(text.includes(`${ESC}[1m${theme.tokens.senior}bold${ESC}[0m`), "bold span");
  assert.ok(text.includes(`${ESC}[3m${theme.tokens.senior}italic${ESC}[0m`), "italic span");
  assert.ok(text.includes(`${ESC}[2m${theme.tokens.senior}code${ESC}[0m`), "inline code span");
  assert.ok(text.includes(`${ESC}[4m${theme.tokens.senior}docs${ESC}[0m`), "link label");
  assert.ok(
    text.includes(`${theme.tokens.senior} (https://example.com/a) here.${ESC}[0m`),
    "link URL stays plain-span text",
  );
  for (const row of rows) {
    assert.ok(styledWidth(row) <= 80, JSON.stringify(row));
    assert.ok(row.endsWith(ESC) || !row.includes(ESC) || row.includes(`${ESC}[0m`), "spans reset");
  }
  // THE invariant: stripping colour reproduces the plain rows exactly.
  assert.deepEqual(rows.map(stripAnsi), renderBlock(block, { width: 80, theme: plainTheme }));

  const structural = renderBlock(
    envelopeBlock("## Heading\n\n```ts\nx\n```\n\n```diff\n-old\n+new\n```\n\n---"),
    { width: 60, theme },
  ).join("\n");
  assert.ok(structural.includes(`${ESC}[1m${theme.tokens.senior}Heading${ESC}[0m`), "heading is bold");
  assert.ok(structural.includes(`${ESC}[2m${theme.tokens.senior}## ${ESC}[0m`), "heading marker is dim");
  assert.ok(structural.includes(`${ESC}[1m${theme.tokens.muted}┌─ ts${ESC}[0m`), "fence label is muted+bold");
  assert.ok(structural.includes(`${theme.tokens.muted}x${ESC}[0m`), "code row is muted");
  assert.ok(structural.includes(`${theme.tokens.error}-old${ESC}[0m`), "removed diff row is error-toned");
  assert.ok(structural.includes(`${theme.tokens.success}+new${ESC}[0m`), "added diff row is success-toned");
  assert.ok(structural.includes(`${theme.tokens.border}────`), "rule is border-toned");
});

test("color: styled rows clip and fit to exact width without tearing escapes", () => {
  const theme = createTheme("ansi16");
  const model = commitEnvelope(
    createTuiModel(),
    message("m-long", "junior", "message", {
      text: "**" + "long bold text ".repeat(12) + "** and `code`",
    }),
  );
  for (const width of [13, 20, 40, 81]) {
    const view = transcriptView(model, {
      width,
      height: 6,
      scroll: latestTranscriptScroll(),
      theme,
    });
    assert.equal(view.lines.length, 6);
    for (const line of view.lines) {
      assert.equal(styledWidth(line), width, JSON.stringify(line));
      assert.ok(!line.includes("\ufffd"));
    }
  }

  const row = renderBlock(model.blocks[0]!, { width: 400, theme }).find((candidate) =>
    stripAnsi(candidate).includes("long bold text"),
  );
  assert.ok(row !== undefined);
  for (const width of [1, 3, 9, 17]) {
    const clipped = clipStyled(row, width);
    assert.equal(styledWidth(clipped), width);
    assert.ok(!stripAnsi(clipped).includes(ESC));
    const fitted = fitStyled(row, width);
    assert.equal(styledWidth(fitted), width);
  }
});

test("styling: only theme.ts spells an escape sequence", () => {
  const source = (file: string): string =>
    readFileSync(new URL(`../src/tui/${file}`, import.meta.url), "utf8");
  for (const file of ["markdown.ts", "markdownstyle.ts", "transcript.ts"]) {
    const text = source(file);
    assert.ok(!/\\x1b|\\u001b|\\u001B/.test(text), `${file} must not spell ANSI`);
  }
  assert.ok(/\\x1b/.test(source("theme.ts")), "the theme owns the escape sequences");
});

test("color: every baseline corpus row stays exact under every palette", () => {
  let checked = 0;
  for (const mode of ["dark", "light", "ansi16"] as const) {
    const theme = createTheme(mode);
    for (const item of PLAIN_BASELINE) {
      const block = envelopeBlock(item.text);
      for (const width of [item.width, 1, 4, 9, 16, 40]) {
        const plain = renderBlock(block, { width, theme: plainTheme });
        const themed = renderBlock(block, { width, theme });
        assert.equal(themed.length, plain.length, `${mode} ${item.width}@${width}`);
        for (let index = 0; index < plain.length; index += 1) {
          assert.equal(
            stripAnsi(themed[index] ?? ""),
            plain[index],
            `${mode} @${width}: ${JSON.stringify(item.text)}`,
          );
          assert.ok(styledWidth(themed[index] ?? "") <= width);
        }
        checked += 1;
      }
    }
  }
  assert.ok(checked > 500, `checked ${checked} palette/width combinations`);
});

// --------------------------------------------------------------------------- //
// streaming partials
// --------------------------------------------------------------------------- //

test("streaming: partial Markdown never throws, leaks markers or swallows text", () => {
  const partials = [
    "**bold",
    "*italic",
    "`code",
    "[label](url",
    "```js\nconst x = 1;",
    "```",
    "text **with `two",
    "*a **b* c",
    "#",
    "> ",
    "-",
    "**",
    "[",
    "****",
  ];
  for (const partial of partials) {
    assert.doesNotThrow(() => renderMarkdownStyled(partial, 20), partial);
    const lines = renderMarkdownStyled(partial, 20);
    assert.deepEqual(rowsText(lines), renderMarkdown(partial, 20), partial);
    for (const line of lines) assert.ok(displayWidth(styledLineText(line)) <= 20);
  }
  assert.equal(renderMarkdown("**bold and `tick", 80)[0], "**bold and `tick");
  const unclosedFence = renderMarkdownStyled("```ts\nconst x = 1;", 40);
  assert.deepEqual(unclosedFence.map((line) => line.kind), ["fenceOpen", "code"]);
  assert.equal(styledLineText(unclosedFence[1]!), "const x = 1;");
  assert.equal(renderMarkdownStyled("", 40).length, 1, "an empty body keeps one row");
  assert.deepEqual(renderMarkdownStyled("", 40).map(styledLineText), [""]);
  assert.deepEqual(renderMarkdownStyled("anything", 0), [], "zero width renders nothing");
});

test("streaming: a partially streamed reply renders emphasis and closes safely", () => {
  const theme = createTheme("dark");
  let model = appendEnvelopeDelta(createTuiModel(), { role: "senior", delta: "Use **bo" });
  assert.doesNotThrow(() => renderTranscript(model, { width: 40, theme }));
  let text = renderTranscript(model, { width: 40, theme: plainTheme }).join("\n");
  assert.ok(text.includes("Use **bo"), "unclosed bold stays literal, not swallowed");

  model = appendEnvelopeDelta(model, { role: "senior", delta: "ld** and `co" });
  text = renderTranscript(model, { width: 40, theme: plainTheme }).join("\n");
  assert.ok(text.includes("Use bold and `co"), "closed bold styles, open code stays literal");

  model = appendEnvelopeDelta(model, { role: "senior", delta: "de` now" });
  text = renderTranscript(model, { width: 40, theme: plainTheme }).join("\n");
  assert.ok(text.includes("Use bold and code now"), "every marker resolved");
  const painted = renderTranscript(model, { width: 40, theme }).join("\n");
  assert.ok(painted.includes(`${ESC}[1m`), "the streamed reply gains span emphasis");
  assert.deepEqual(stripAnsi(painted), text);
});

// --------------------------------------------------------------------------- //
// themed overlays (palette + help inner rows)
// --------------------------------------------------------------------------- //

test("overlay theme: palette and help rows paint through the theme and strip back to plain", () => {
  const theme = createTheme("dark");
  const entries: PaletteEntry[] = [
    {
      id: "one",
      title: "One",
      description: "First action",
      group: "General",
      keys: "Ctrl+O",
      slash: "/one",
      argumentHint: "",
      kind: "command",
      disabled: false,
      disabledReason: "",
      mode: "",
    },
    {
      id: "two",
      title: "Two",
      description: "Second action",
      group: "General",
      keys: "",
      slash: "",
      argumentHint: "",
      kind: "command",
      disabled: true,
      disabledReason: "unavailable while a turn is running",
      mode: "",
    },
    {
      id: "cjk",
      title: "你好😀 command",
      description: "描述文本",
      group: "General",
      keys: "Ctrl+你",
      slash: "/cjk",
      argumentHint: "<参数>",
      kind: "command",
      disabled: false,
      disabledReason: "",
      mode: "",
    },
  ];

  // Every palette row keeps the exact plain bytes and width once stripped,
  // including CJK/emoji titles, at wide and narrow cells.
  for (const width of [20, 40, 60, 100]) {
    for (const height of [4, 8]) {
      const plain = paletteView(TUI_COMMANDS, createPaletteState(), entries, { width, height });
      const themed = paletteView(TUI_COMMANDS, createPaletteState(), entries, { width, height, theme });
      assert.equal(themed.lines.length, plain.lines.length);
      for (let index = 0; index < plain.lines.length; index += 1) {
        assert.equal(
          stripAnsi(themed.lines[index] ?? ""),
          plain.lines[index],
          `palette @${width}x${height} row ${index}`,
        );
        assert.equal(displayWidth(plain.lines[index] ?? ""), width, "exact width");
      }
      assert.ok(themed.lines.some((row) => row.includes(ESC)), "the palette paints when color is on");
    }
  }

  const palette = paletteView(TUI_COMMANDS, createPaletteState(), entries, {
    width: 60,
    height: 8,
    theme,
  });
  assert.ok((palette.lines[0] ?? "").startsWith(theme.tokens.strong), "the header is strong");
  assert.ok(
    (palette.lines[1] ?? "").includes(`${theme.tokens.accent}> ${ESC}[0m`),
    "the filter caret is accent",
  );
  assert.ok(
    (palette.lines[2] ?? "").startsWith(theme.tokens.inverse),
    "the selected row is one inverse run",
  );
  assert.ok((palette.lines[2] ?? "").endsWith(`${ESC}[0m`), "the selected row closes its run");
  assert.ok(
    palette.lines.join("\n").includes(`${theme.tokens.accent}Ctrl+你`),
    "key chords are accent-painted",
  );
  assert.ok(
    palette.lines.join("\n").includes(`${theme.tokens.muted} — Second action${ESC}[0m`),
    "descriptions are muted",
  );
  const disabledRow = palette.lines.find((row) => stripAnsi(row).includes("Two"));
  assert.ok(
    disabledRow?.includes(`${theme.tokens.warning} [unavailable]${ESC}[0m`),
    "the unavailable marker is warning-toned",
  );

  // The help overlay shares the row painter: headers accent, selected inverse,
  // and every themed row strips back to the plain bytes at exact width.
  const documented = helpEntries();
  for (const width of [24, 40, 64, 100]) {
    const plain = helpView(TUI_COMMANDS, createHelpState(), documented, { width, height: 10 });
    const themed = helpView(TUI_COMMANDS, createHelpState(), documented, {
      width,
      height: 10,
      theme,
    });
    assert.equal(themed.lines.length, plain.lines.length);
    for (let index = 0; index < plain.lines.length; index += 1) {
      assert.equal(
        stripAnsi(themed.lines[index] ?? ""),
        plain.lines[index],
        `help @${width} row ${index}`,
      );
      assert.equal(displayWidth(plain.lines[index] ?? ""), width);
    }
    assert.ok(themed.lines.some((row) => row.includes(ESC)));
  }
  const help = helpView(TUI_COMMANDS, createHelpState(), documented, {
    width: 100,
    height: 12,
    theme,
  });
  assert.ok(
    help.lines.join("\n").includes(`${theme.tokens.accent}[General]${ESC}[0m`),
    "group headers are accent-painted",
  );
  assert.ok(
    (help.lines[3] ?? "").startsWith(theme.tokens.inverse),
    "the selected help row is inverse",
  );

  // NO_COLOR and plainTheme are the identity: byte-identical to no theme at all.
  const noColorTheme = resolveTheme({ env: { NO_COLOR: "1" } });
  assert.deepEqual(
    paletteView(TUI_COMMANDS, createPaletteState(), entries, { width: 60, height: 8, theme: noColorTheme }).lines,
    paletteView(TUI_COMMANDS, createPaletteState(), entries, { width: 60, height: 8 }).lines,
  );
  assert.deepEqual(
    helpView(TUI_COMMANDS, createHelpState(), documented, { width: 80, height: 10, theme: plainTheme }).lines,
    helpView(TUI_COMMANDS, createHelpState(), documented, { width: 80, height: 10 }).lines,
  );
});

// --------------------------------------------------------------------------- //
// transcript top-slice marker
// --------------------------------------------------------------------------- //

test("top slice: the mid-block gutter marker is width-safe and theme-painted only", () => {
  const theme = createTheme("dark");
  const row = fitStyled("        continuation", 24);
  assert.equal(styledWidth(row), 24);
  const plain = markTopSliceRow(row, 24, plainTheme);
  assert.equal(styledWidth(plain), 24, "swapping gutter cells never changes the width");
  assert.equal(stripAnsi(plain), "       ⋯continuation".padEnd(24));
  assert.ok(!plain.includes(ESC), "the plain marker is one glyph, no escape");

  const themed = markTopSliceRow(row, 24, theme);
  assert.equal(styledWidth(themed), 24);
  assert.equal(stripAnsi(themed), stripAnsi(plain), "the theme only paints the marker");
  assert.ok(themed.startsWith(theme.tokens.dim), "the marker is dim-painted");

  // Grapheme/EAW safety: CJK and emoji in the continuation body are preserved.
  const cjk = fitStyled("        你好 😀 tail", 30);
  const markedCjk = markTopSliceRow(cjk, 30, plainTheme);
  assert.equal(styledWidth(markedCjk), 30);
  assert.ok(stripAnsi(markedCjk).includes("你好 😀 tail"));

  // The view applies the marker at the contiguous top of a mid-block window and
  // paints it through the theme, so a color row strips back to the plain row.
  const model = commitEnvelope(
    createTuiModel(),
    message("m-top", "senior", "message", { text: "reply " + "word ".repeat(80) }),
  );
  const plainView = transcriptView(model, {
    width: 60,
    height: 6,
    theme: plainTheme,
    scroll: latestTranscriptScroll(),
  });
  const themedView = transcriptView(model, {
    width: 60,
    height: 6,
    theme,
    scroll: latestTranscriptScroll(),
  });
  assert.ok(plainView.lines[0]?.includes("⋯"), "the mid-block cut is marked");
  assert.ok(themedView.lines[0]?.includes(theme.tokens.dim), "the marker uses the dim token");
  for (let index = 0; index < plainView.lines.length; index += 1) {
    assert.equal(
      stripAnsi(themedView.lines[index] ?? ""),
      plainView.lines[index] ?? "",
      `row ${index}`,
    );
  }
});
