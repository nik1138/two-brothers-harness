/**
 * Display-width suite: grapheme segmentation, East Asian width, emoji,
 * combining marks, tabs, ANSI safety and all four layout helpers.
 * Hermetic — no terminal, no clock, no I/O.
 *
 * Run with: node --test tests/tuiwidth.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  displayWidth,
  expandTabs,
  padToWidth,
  sanitizeText,
  stripAnsi,
  truncateToWidth,
  wrapText,
} from "../src/tui/text.ts";

const ESC = "\u001b";

function rowWidths(rows: string[]): number[] {
  return rows.map((row) => displayWidth(row));
}

// ---------------------------------------------------------------------------
// displayWidth
// ---------------------------------------------------------------------------

test("displayWidth: ASCII, CJK, fullwidth and combining marks", () => {
  assert.equal(displayWidth(""), 0);
  assert.equal(displayWidth("hello"), 5);
  assert.equal(displayWidth("你好"), 4);
  assert.equal(displayWidth("你好world"), 9);
  assert.equal(displayWidth("ｆｕｌｌ"), 8);
  assert.equal(displayWidth("e\u0301"), 1, "base + combining acute is one column");
  assert.equal(displayWidth("\u0301"), 0, "a lone combining mark takes no column");
  assert.equal(displayWidth("\u200d"), 0, "a lone ZWJ takes no column");
  assert.equal(displayWidth("\u0007"), 0, "control characters are invisible");
  assert.equal(displayWidth("a\nb"), 2, "newline is zero width");
});

test("displayWidth: emoji presentation sequences count two, text forms one", () => {
  assert.equal(displayWidth("😀"), 2);
  assert.equal(displayWidth("👨‍👩‍👧‍👦"), 2, "a ZWJ family is one grapheme");
  assert.equal(displayWidth("🇺🇸"), 2, "a flag is one grapheme");
  assert.equal(displayWidth("1️⃣"), 2, "a keycap sequence is one grapheme");
  assert.equal(displayWidth("❤️"), 2, "VS16 makes the heart emoji-presenting");
  assert.equal(displayWidth("❤"), 1, "the default text heart is narrow");
  assert.equal(displayWidth("❤\uFE0E"), 1, "VS15 forces text presentation");
  assert.equal(displayWidth("e\u0301😀"), 3);
});

test("displayWidth: ANSI escapes are zero width and tabs use tab stops", () => {
  assert.equal(displayWidth(`${ESC}[31mred${ESC}[0m`), 3);
  assert.equal(displayWidth(`${ESC}]8;;https://example.test${ESC}\\link${ESC}]8;;${ESC}\\`), 4);
  assert.equal(displayWidth("a\tb"), 5, "a at col 1, tab to 4, b at 5");
  assert.equal(displayWidth("\txy"), 6, "leading tab fills the first stop");
  assert.equal(displayWidth("abc\tx"), 5, "tab from col 3 to col 4");
  assert.equal(displayWidth("a\tb", { tabWidth: 8 }), 9);
});

test("stripAnsi removes CSI, OSC and two-character escapes", () => {
  assert.equal(stripAnsi(`${ESC}[1;31mbold${ESC}[0m`), "bold");
  assert.equal(stripAnsi(`${ESC}]0;title\u0007text`), "text");
  assert.equal(stripAnsi(`${ESC}7saved${ESC}8`), "saved");
  assert.equal(stripAnsi("plain"), "plain");
});

test("sanitizeText strips ANSI, normalizes CRLF and expands tabs", () => {
  assert.equal(sanitizeText(`${ESC}[31ma\r\nb\rc\tx${ESC}[0m`), "a\nb\nc   x");
  assert.equal(expandTabs("a\tb\tc", 4), "a   b   c");
  assert.equal(expandTabs("你\tb", 4), "你  b", "tab stops use display columns");
  assert.equal(expandTabs(`${ESC}[31ma\tb${ESC}[0m`), `${ESC}[31ma   b${ESC}[0m`);
});

// ---------------------------------------------------------------------------
// truncateToWidth
// ---------------------------------------------------------------------------

test("truncateToWidth: exact fits, cuts and bounds", () => {
  assert.equal(truncateToWidth("abcd", 4), "abcd");
  assert.equal(truncateToWidth("abcdef", 4), "abc…");
  assert.equal(truncateToWidth("abcdef", 5, ".."), "abc..");
  assert.equal(truncateToWidth("abc", 0), "");
  assert.equal(truncateToWidth("abc", -2), "");
  assert.equal(truncateToWidth("abc", Number.NaN), "");
  assert.ok(displayWidth(truncateToWidth("abcdef", 4)) <= 4);
});

test("truncateToWidth: wide clusters are kept whole, never split", () => {
  assert.equal(truncateToWidth("你好世界", 5), "你好…");
  const four = truncateToWidth("你好世界", 4);
  assert.equal(four, "你…");
  assert.ok(displayWidth(four) <= 4);

  const emoji = truncateToWidth("😀😀😀", 5);
  assert.equal(emoji, "😀😀…");
  assert.ok(displayWidth(emoji) <= 5);

  const combining = truncateToWidth("e\u0301e\u0301e\u0301", 2);
  assert.equal(combining, "e\u0301…");
  assert.ok(displayWidth(combining) <= 2);
});

test("truncateToWidth: ellipsis wider than the budget is clipped", () => {
  assert.equal(truncateToWidth("abcdef", 1, "..."), ".");
  assert.equal(truncateToWidth("你好", 1, "..."), ".");
});

test("truncateToWidth: ANSI is preserved in the kept prefix and reset", () => {
  const cut = truncateToWidth(`${ESC}[31mabcdef${ESC}[0m`, 4);
  assert.equal(stripAnsi(cut), "abc…");
  assert.ok(cut.startsWith(`${ESC}[31m`));
  assert.ok(cut.endsWith(`${ESC}[0m`), "a reset closes the cut style");
  assert.equal(displayWidth(cut), 4);

  const fitting = `${ESC}[31mabc${ESC}[0m`;
  assert.equal(truncateToWidth(fitting, 4), fitting);
});

test("truncateToWidth: tabs are expanded before measuring", () => {
  assert.equal(truncateToWidth("a\tb", 5), "a   b");
  const cut = truncateToWidth("a\tbcdef", 4);
  assert.ok(displayWidth(cut) <= 4);
  assert.ok(!cut.includes("\t"));
});

// ---------------------------------------------------------------------------
// wrapText
// ---------------------------------------------------------------------------

test("wrapText: greedy word wrap and hard splits", () => {
  assert.deepEqual(wrapText("one two three", 7), ["one two", "three"]);
  assert.deepEqual(wrapText("abcd", 4), ["abcd"]);
  assert.deepEqual(wrapText("abcdefghij", 4), ["abcd", "efgh", "ij"]);
  const longWord = wrapText("prefix supercalifragilistic end", 10);
  assert.ok(longWord.join("").includes("supercalifragilistic"));
  assert.ok(longWord.every((row) => displayWidth(row) <= 10));
});

test("wrapText: paragraphs, blank lines and empty text", () => {
  assert.deepEqual(wrapText("", 10), [""]);
  assert.deepEqual(wrapText("a\n\nb", 10), ["a", "", "b"]);
  assert.deepEqual(wrapText("a\r\nb\rc", 10), ["a", "b", "c"]);
  assert.deepEqual(wrapText("   ", 10), [""], "whitespace-only collapses at a break");
});

test("wrapText: CJK, emoji and combining marks stay whole and fit the width", () => {
  assert.deepEqual(wrapText("你好世界", 4), ["你好", "世界"]);
  assert.deepEqual(wrapText("hello 世界", 6), ["hello", "世界"]);
  const emoji = wrapText("a😀b", 3);
  assert.deepEqual(emoji, ["a😀", "b"]);
  assert.deepEqual(wrapText("e\u0301e\u0301", 1), ["e\u0301", "e\u0301"]);
  assert.deepEqual(wrapText("😀你", 1), ["…", "…"]);

  const mixed = "the quick 你好 😀 jumps over 世界 and lands";
  for (const width of [1, 2, 3, 7, 11, 16]) {
    for (const row of wrapText(mixed, width)) {
      assert.ok(
        displayWidth(row) <= width,
        `row ${JSON.stringify(row)} (${displayWidth(row)}) exceeds ${width}`,
      );
    }
  }
});

test("wrapText: width clamps to one and ANSI/tabs are sanitized", () => {
  assert.deepEqual(wrapText("ab", 0), ["a", "b"]);
  assert.deepEqual(wrapText("ab", -4), ["a", "b"]);
  assert.deepEqual(wrapText(`${ESC}[31mred blue${ESC}[0m`, 3), ["red", "blu", "e"]);
  assert.deepEqual(wrapText("a\tb", 4), ["a", "b"]);
  for (const row of wrapText("a\tb", 4)) assert.ok(!row.includes("\t"));
});

test("wrapText: every row of a long mixed paragraph fits", () => {
  const text =
    "Two Brothers is a harness for cooperation between two sibling agents. " +
    "The senior consults the junior, delegates work, and decides. 兄弟 合作。😀";
  for (const width of [4, 8, 13, 24, 40, 80]) {
    const rows = wrapText(text, width);
    for (const row of rows) assert.ok(displayWidth(row) <= width);
    assert.equal(rows.join("").replace(/ /g, ""), text.replace(/\s/g, ""));
  }
});

// ---------------------------------------------------------------------------
// padToWidth
// ---------------------------------------------------------------------------

test("padToWidth: left, right and center alignment", () => {
  assert.equal(padToWidth("abc", 5), "abc  ");
  assert.equal(padToWidth("abc", 5, "right"), "  abc");
  assert.equal(padToWidth("abc", 5, "center"), " abc ");
  assert.equal(padToWidth("a", 4, "center"), " a  ", "odd gaps go to the right");
  assert.equal(padToWidth("a", 1), "a");
  assert.equal(padToWidth("abc", 0), "");
});

test("padToWidth: wide and ANSI-aware padding and truncation", () => {
  assert.equal(padToWidth("你好", 5), "你好 ");
  assert.equal(padToWidth("你好", 3), "你 ", "a wide glyph is not split");
  assert.equal(padToWidth("abcdef", 3, "right"), "abc");

  const colored = `${ESC}[32mred${ESC}[0m`;
  const padded = padToWidth(colored, 5);
  assert.equal(displayWidth(padded), 5);
  assert.ok(padded.startsWith(colored));

  for (const align of ["left", "right", "center"] as const) {
    assert.equal(displayWidth(padToWidth("你好😀", 9, align)), 9);
  }
});

test("displayWidth on every helper result never exceeds the requested width", () => {
  const samples = ["ascii words", "你好世界", "😀👨‍👩‍👧‍👦🇺🇸", "e\u0301e\u0301", "a\tb"];
  for (const sample of samples) {
    for (const width of [1, 2, 3, 5, 8]) {
      assert.ok(displayWidth(truncateToWidth(sample, width)) <= width);
      assert.ok(displayWidth(padToWidth(sample, width, "center")) <= width);
    }
  }
});

test("rows from wrapText never contain ANSI or control bytes", () => {
  const rows = wrapText(`${ESC}[31mred${ESC}[0m\u0007 text`, 4);
  assert.ok(rows.every((row) => !row.includes(ESC)));
  assert.ok(rows.every((row) => !row.includes("\u0007")));
  assert.deepEqual(rowWidths(rows).map((width) => width <= 4), rows.map(() => true));
});