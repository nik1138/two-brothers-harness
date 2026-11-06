/**
 * Span-level Markdown model for the TUI transcript.
 *
 * `renderMarkdownStyled` renders model Markdown to width-wrapped lines of
 * styled spans. Block structure is a {@link StyledLineKind} (heading, list,
 * quote, rule, fence open/close, code, diff); inline emphasis is a
 * {@link StyledSpan} style (`bold`, `italic`, `code`, `link`, and the
 * structural `marker` used by list/quote/heading/diff prefixes).
 *
 * This is the single source of truth for Markdown rendering: `markdown.ts`'s
 * plain `renderMarkdown` is exactly `renderMarkdownStyled(...).map(styledLineText)`,
 * so the `NO_COLOR` output cannot drift from the styled model, and a span is
 * only a style annotation — joining its text always yields the plain row.
 *
 * The style vocabulary (`theme.ts::EmphasisStyle`) and all escape sequences
 * live in `theme.ts`; this module is pure width/layout code and never spells
 * an escape sequence. Wrapping delegates to `text.ts::wrapRuns`, which
 * preserves each span's style through line breaks with the same
 * grapheme/East-Asian-width rules as the plain `wrapText`, so no emphasis can
 * split a combining mark, an emoji ZWJ sequence or a wide cluster.
 *
 * Supported block syntax: `#`/`##`/`###` headings, `-`/`*`/`+` bullets and
 * `1.`/`1)` numbered lists (one nesting level), `>` blockquotes, `---` rules
 * and fenced code blocks with an optional language label. Supported inline
 * syntax: `` `code` ``, `**bold**`, `*italic*` and `[text](url)`, which is
 * rendered as `text (url)`.
 *
 * Diff-aware code: a fence labelled `diff` or `patch`, and a plain (unfenced)
 * unified diff (`--- a/x`, `+++ b/x`, `@@ -1,2 +1,2 @@`), renders with a
 * `marker` span in front of every marked row — `- ` for removed lines, `+ `
 * for added lines, `@@ ` for hunk headers — while the source row itself stays
 * intact (`-old` becomes `- -old`). The transcript colors the whole row from
 * that marker (`error`/`success`/`muted`), exactly as it did from the plain
 * leading marker pair.
 *
 * Streaming-safe: an unclosed fence renders as code, and an unclosed inline
 * marker is emitted literally — parsing never throws and never swallows text.
 * The parser walks the source once per line: line splitting, inline scanning
 * and wrapping are all linear in the input length, so multi-hundred-kilobyte
 * bodies stay fast.
 *
 * Rendering design follows pi's TUI markdown component (MIT, Copyright (c) 2025
 * Mario Zechner); implemented here without the marked dependency.
 */
import { displayWidth, sanitizeText, truncateRuns, wrapRuns } from "./text.ts";
import type { EmphasisStyle } from "./theme.ts";

/** Deepest heading rendered structurally; `####` and deeper stay plain text. */
const MAX_HEADING_LEVEL = 3;

/** Widest horizontal rule, matching the vendor renderer's 80-column cap. */
const MAX_RULE_WIDTH = 80;

/** Inline recursion cap: crafted nesting degrades to literal text. */
const MAX_INLINE_DEPTH = 4;

/** Blockquote gutter (`│` plus one space, two columns). */
const QUOTE_PREFIX = "│ ";

/** Opening code-block gutter; the sanitized language label follows it. */
const FENCE_OPEN = "┌─";

/** Closing code-block gutter. */
const FENCE_CLOSE = "└─";

/** Ellipsis used when a code row cannot fit the available columns. */
const CLIP_MARKER = "…";

/** Info-string languages rendered as a unified diff (marker-classified rows). */
const DIFF_LANGUAGES: ReadonlySet<string> = new Set(["diff", "patch"]);

/** `--- a/x` old-file header of a plain unified diff. */
const DIFF_OLD_HEADER = /^\s{0,3}---\s+\S/;

/** `+++ b/x` new-file header of a plain unified diff. */
const DIFF_NEW_HEADER = /^\s{0,3}\+\+\+\s+\S/;

/** `@@ -1,2 +1,2 @@` hunk header of a plain unified diff. */
const DIFF_HUNK_HEADER = /^\s{0,3}@@\s+-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@/;

/**
 * A row that belongs to a unified diff body: metadata (`diff --git`, `index`,
 * `---`/`+++`), a hunk header, a no-newline note, or a `+`/`-`/context row.
 * A blank line or ordinary prose ends the run.
 */
const DIFF_BODY_LINE = /^\s{0,3}(?:diff |index |--- |\+\+\+ |@@ |\\ |[ +\-])/;

/** Structural role of one rendered Markdown row. */
export type StyledLineKind =
  | "text"
  | "heading"
  | "quote"
  | "rule"
  | "list"
  | "fenceOpen"
  | "fenceClose"
  | "code"
  | "diff";

/** One run of same-style text inside a rendered row. */
export interface StyledSpan {
  text: string;
  /** Inline emphasis; undefined means the row's base tone only. */
  style?: EmphasisStyle;
}

/** One width-wrapped Markdown row: its block kind and its styled spans. */
export interface StyledLine {
  kind: StyledLineKind;
  spans: StyledSpan[];
}

interface LinkSpan {
  /** Index of the `]` closing the label. */
  labelEnd: number;
  /** Index of the `)` closing the URL. */
  urlEnd: number;
}

/** The plain text of one styled line (the NO_COLOR row, byte for byte). */
export function styledLineText(line: StyledLine): string {
  return styledSpansText(line.spans);
}

/**
 * The plain text of a span/run list (joining styles away). The parameter is
 * structural (`{ text }`) so the generic `text.ts::wrapRuns` rows can be
 * joined without knowing the style vocabulary.
 */
export function styledSpansText(spans: readonly { text: string }[]): string {
  let text = "";
  for (const span of spans) text += span.text;
  return text;
}

function columnLimit(width: number): number {
  return Number.isFinite(width) && width >= 1 ? Math.floor(width) : 0;
}

/** True when a fence info string names a unified-diff language. */
function isDiffLanguage(info: string): boolean {
  const language = (info.split(/\s+/)[0] ?? "").toLowerCase();
  return DIFF_LANGUAGES.has(language);
}

/**
 * The classification marker a unified-diff row wears (`- `, `+ `, `@@ `), or
 * null for a context row. The source row is kept intact after the marker, so
 * a removed `-old` renders as `- -old`, an added `+new` as `+ +new` and a
 * `@@ -1 +1 @@` hunk as `@@ @@ -1 +1 @@`. The doubled sign is the point: it
 * makes marked rows distinguishable from a Markdown bullet (`- item`) after
 * the rows have been flattened into plain text.
 */
function diffMarker(line: string): string | null {
  if (/^\s{0,3}@@/.test(line)) return "@@ ";
  if (/^\s{0,3}\+/.test(line)) return "+ ";
  if (/^\s{0,3}-/.test(line)) return "- ";
  return null;
}

/** True when `lines[index]` starts a plain (unfenced) unified diff. */
function startsPlainDiff(lines: readonly string[], index: number): boolean {
  const first = lines[index] ?? "";
  if (DIFF_OLD_HEADER.test(first) && DIFF_NEW_HEADER.test(lines[index + 1] ?? "")) {
    return true;
  }
  return DIFF_HUNK_HEADER.test(first);
}

/**
 * Rows of the plain diff that starts at `index`, or 0 when this is not one.
 * A run stops at a blank line or the first non-diff row, so following
 * Markdown prose is parsed normally.
 */
function plainDiffLength(lines: readonly string[], index: number): number {
  if (!startsPlainDiff(lines, index)) return 0;
  let end = index;
  while (end < lines.length && DIFF_BODY_LINE.test(lines[end] ?? "")) end += 1;
  return end - index;
}

/** Clip one fixed line (fence gutter, code row) explicitly, never wrapping. */
function clippedLine(text: string, kind: StyledLineKind, columns: number): StyledLine {
  return { kind, spans: truncateRuns([{ text }], columns, CLIP_MARKER) };
}

/** One unified-diff body row: an optional marker span plus the intact source. */
function diffLine(line: string, columns: number): StyledLine {
  const marker = diffMarker(line);
  const spans: StyledSpan[] =
    marker === null
      ? [{ text: line }]
      : [
          { text: marker, style: "marker" },
          { text: line },
        ];
  return { kind: "diff", spans: truncateRuns(spans, columns, CLIP_MARKER) };
}

/** Wrap plain span content to `columns`, tagging each row with `kind`. */
function wrapStyledSpans(
  spans: readonly StyledSpan[],
  columns: number,
  kind: StyledLineKind,
): StyledLine[] {
  return wrapRuns(spans, columns).map((row) => ({ kind, spans: row }));
}

/**
 * Wrap `bodySpans` under a structural `marker` prefix with a hanging indent,
 * mirroring the plain renderer's prefix wrapper: the first row carries the
 * marker, continuation rows carry `prefixWidth` spaces, and a prefix too wide
 * for the view clips the whole line with the explicit marker.
 */
function wrapWithMarker(
  prefixText: string,
  bodySpans: readonly StyledSpan[],
  columns: number,
  kind: StyledLineKind,
): StyledLine[] {
  const prefixWidth = displayWidth(prefixText);
  const available = columns - prefixWidth;
  const markerSpan: StyledSpan = { text: prefixText, style: "marker" };
  if (available < 1) {
    return [
      {
        kind,
        spans: truncateRuns([markerSpan, ...bodySpans], columns, CLIP_MARKER),
      },
    ];
  }
  const indent = " ".repeat(prefixWidth);
  return wrapRuns(bodySpans, available).map((row, index) => ({
    kind,
    spans: index === 0 ? [markerSpan, ...row] : [{ text: indent }, ...row],
  }));
}

/**
 * One linear pass over `text` collecting `[label](url)` spans. The most
 * recent unmatched `[` owns a span, so brackets inside the URL never rebind
 * it. Returns an empty map when the text cannot contain a link.
 */
function findLinks(text: string): Map<number, LinkSpan> {
  const spans = new Map<number, LinkSpan>();
  if (!text.includes("](")) return spans;
  let open = -1;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "[") {
      open = index;
      continue;
    }
    if (char !== "]" || open < 0 || text[index + 1] !== "(") continue;
    const urlEnd = text.indexOf(")", index + 2);
    // No `)` remains, so no later link can close either: stop scanning.
    if (urlEnd === -1) break;
    spans.set(open, { labelEnd: index, urlEnd });
    open = -1;
    index = urlEnd;
  }
  return spans;
}

/**
 * Strip inline Markdown markers to styled spans. Unclosed markers are emitted
 * literally, and recursion is depth-capped so hostile nesting is harmless.
 *
 * Styles nest by specificity: an inner emphasis keeps its own style, and the
 * enclosing emphasis applies to the runs that were left unstyled (so
 * `**bold *italic* bold**` keeps the italic run italic instead of flattening
 * it, while the row stays visually bold around it). Joining the returned span
 * text is exactly the old `renderInline` plain output.
 */
function renderInlineSpans(text: string, depth = 0): StyledSpan[] {
  if (depth >= MAX_INLINE_DEPTH) return text === "" ? [] : [{ text }];
  const links = findLinks(text);
  const spans: StyledSpan[] = [];
  let index = 0;
  // Once a closing marker is proven absent it cannot reappear later, so the
  // failed scan is remembered and the rest of the line is literal. That keeps
  // pathological marker runs linear instead of rescanning on every character.
  let noCode = false;
  let noBold = false;
  let noStar = false;

  // Literal text is buffered so a style boundary never splits a grapheme
  // cluster: an emoji ZWJ/flag/keycap sequence stays one span, and adjacent
  // plain runs merge instead of exploding per code unit.
  let literal = "";
  const flushLiteral = (): void => {
    if (literal === "") return;
    spans.push({ text: literal });
    literal = "";
  };
  const push = (value: string, style: EmphasisStyle): void => {
    if (value === "") return;
    flushLiteral();
    spans.push({ text: value, style });
  };
  const pushStyled = (inner: readonly StyledSpan[], style: EmphasisStyle): void => {
    if (inner.length === 0) return;
    flushLiteral();
    for (const span of inner) {
      spans.push(span.style === undefined ? { text: span.text, style } : span);
    }
  };

  while (index < text.length) {
    const char = text[index] as string;

    if (char === "[") {
      const link = links.get(index);
      if (link !== undefined) {
        const label = renderInlineSpans(text.slice(index + 1, link.labelEnd), depth + 1);
        const url = text.slice(link.labelEnd + 2, link.urlEnd).trim();
        pushStyled(label, "link");
        if (url !== "") literal += ` (${url})`;
        index = link.urlEnd + 1;
        continue;
      }
    }

    if (char === "`" && !noCode) {
      const end = text.indexOf("`", index + 1);
      if (end === -1) {
        noCode = true;
      } else {
        // Code spans are literal: no nested inline parsing inside them.
        push(text.slice(index + 1, end), "code");
        index = end + 1;
        continue;
      }
    }

    if (char === "*" && text[index + 1] === "*") {
      if (!noBold) {
        const end = text.indexOf("**", index + 2);
        if (end !== -1) {
          pushStyled(renderInlineSpans(text.slice(index + 2, end), depth + 1), "bold");
          index = end + 2;
          continue;
        }
        noBold = true;
      }
      // Unclosed bold: keep the markers literally so nothing is swallowed.
      literal += "**";
      index += 2;
      continue;
    }

    if (char === "*" && !noStar) {
      const end = text.indexOf("*", index + 1);
      if (end === -1) {
        noStar = true;
      } else {
        pushStyled(renderInlineSpans(text.slice(index + 1, end), depth + 1), "italic");
        index = end + 1;
        continue;
      }
    }

    literal += char;
    index += 1;
  }
  flushLiteral();
  return spans;
}

/**
 * Render Markdown to width-wrapped styled rows. `width <= 0` yields no rows;
 * blank source lines stay blank rows; an empty body renders as one empty row
 * so the transcript keeps its label row.
 *
 * `renderMarkdown(text, width)` in `markdown.ts` is the plain-text projection
 * of this function (`styledLineText` per line) — the two can never disagree.
 */
export function renderMarkdownStyled(text: string, width: number): StyledLine[] {
  const columns = columnLimit(width);
  if (columns === 0) return [];
  const source = sanitizeText(typeof text === "string" ? text : "");
  const lines = source.split("\n");
  const out: StyledLine[] = [];
  // The info string of the open fence, or null outside a code block. A fence
  // that never closes is still rendered as code (streaming drafts).
  let fenceInfo: string | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (fenceInfo !== null) {
      if (/^\s{0,3}```+\s*$/.test(line)) {
        out.push(clippedLine(FENCE_CLOSE, "fenceClose", columns));
        fenceInfo = null;
        continue;
      }
      out.push(
        isDiffLanguage(fenceInfo)
          ? diffLine(line, columns)
          : { kind: "code", spans: truncateRuns([{ text: line }], columns, CLIP_MARKER) },
      );
      continue;
    }

    if (line.trim() === "") {
      out.push({ kind: "text", spans: [] });
      continue;
    }

    const fence = /^\s{0,3}```(.*)$/.exec(line);
    if (fence !== null) {
      const info = (fence[1] ?? "").trim();
      out.push(clippedLine(info === "" ? FENCE_OPEN : `${FENCE_OPEN} ${info}`, "fenceOpen", columns));
      fenceInfo = info;
      continue;
    }

    const diffLength = plainDiffLength(lines, index);
    if (diffLength > 0) {
      out.push(clippedLine(`${FENCE_OPEN} diff`, "fenceOpen", columns));
      for (let offset = 0; offset < diffLength; offset += 1) {
        out.push(diffLine(lines[index + offset] ?? "", columns));
      }
      out.push(clippedLine(FENCE_CLOSE, "fenceClose", columns));
      index += diffLength - 1;
      continue;
    }

    if (/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push({
        kind: "rule",
        spans: [{ text: "─".repeat(Math.min(columns, MAX_RULE_WIDTH)) }],
      });
      continue;
    }

    const heading = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line);
    if (heading !== null) {
      const level = (heading[1] ?? "").length;
      const body = renderInlineSpans((heading[2] ?? "").trim());
      const prefix = `${"#".repeat(level)} `;
      if (level <= MAX_HEADING_LEVEL) {
        out.push(...wrapWithMarker(prefix, body, columns, "heading"));
      } else {
        out.push(...wrapStyledSpans([{ text: prefix }, ...body], columns, "text"));
      }
      continue;
    }

    const quote = /^\s{0,3}>\s?(.*)$/.exec(line);
    if (quote !== null) {
      out.push(...wrapWithMarker(QUOTE_PREFIX, renderInlineSpans((quote[1] ?? "").trim()), columns, "quote"));
      continue;
    }

    const item = /^(\s*)([-+*]|\d{1,9}[.)])(?:[ \t]+(.*))?$/.exec(line);
    if (item !== null) {
      const indent = (item[1] ?? "").length;
      const marker = item[2] ?? "-";
      const body = renderInlineSpans((item[3] ?? "").trim());
      const prefix = `${"  ".repeat(Math.min(1, Math.floor(indent / 2)))}${marker} `;
      out.push(...wrapWithMarker(prefix, body, columns, "list"));
      continue;
    }

    out.push(...wrapStyledSpans(renderInlineSpans(line), columns, "text"));
  }

  return out;
}
