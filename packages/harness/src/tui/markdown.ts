/**
 * Dependency-free Markdown renderer for TUI message bodies.
 *
 * The renderer turns model Markdown into plain, already width-safe text rows.
 * It never emits escape sequences and never lets model-supplied ANSI through:
 * the input is sanitized with `text.ts::sanitizeText` first, so a reply can
 * never drive the terminal. Color and emphasis are the transcript's job — it
 * paints every row with the role's theme token, which keeps identity and
 * heading/list structure readable under `NO_COLOR`.
 *
 * Supported block syntax: `#`/`##`/`###` headings, `-`/`*`/`+` bullets and
 * `1.`/`1)` numbered lists (one nesting level), `>` blockquotes, `---` rules
 * and fenced code blocks with an optional language label. Supported inline
 * syntax: `` `code` ``, `**bold**`, `*italic*` and `[text](url)`, which is
 * rendered as `text (url)`. Everything else passes through as text.
 *
 * Diff-aware code: a fence labelled `diff` or `patch`, and a plain (unfenced)
 * unified diff (`--- a/x`, `+++ b/x`, `@@ -1,2 +1,2 @@`), renders with a
 * classification marker in front of every row — `- ` for removed lines, `+ `
 * for added lines, `@@ ` for hunk headers — while the source row itself stays
 * intact (`-old` becomes `- -old`). A marked row therefore always repeats its
 * sign, which no ordinary Markdown row does, so the transcript can color
 * added/removed rows from the leading marker pair alone. A plain diff is
 * rendered like a `diff` fenced block (`┌─ diff` … `└─`) and its rows are
 * clipped, never Markdown-parsed or wrapped.
 *
 * Streaming-safe: an unclosed fence renders as code, and an unclosed inline
 * marker is emitted literally — parsing never throws. The parser walks the
 * source once per line: line splitting, inline scanning and wrapping are all
 * linear in the input length, so multi-hundred-kilobyte bodies stay fast.
 *
 * Rendering design follows pi's TUI markdown component (MIT, Copyright (c) 2025 Mario Zechner); implemented here without the marked dependency.
 */
import { displayWidth, sanitizeText, truncateToWidth, wrapText } from "./text.ts";

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

interface LinkSpan {
  /** Index of the `]` closing the label. */
  labelEnd: number;
  /** Index of the `)` closing the URL. */
  urlEnd: number;
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
 * Prefix one unified-diff row with its classification marker. The source row
 * is kept intact, so a removed `-old` renders as `- -old`, an added `+new` as
 * `+ +new` and a `@@ -1 +1 @@` hunk as `@@ @@ -1 +1 @@`. The doubled sign is
 * the point: it makes marked rows distinguishable from a Markdown bullet
 * (`- item`) after the rows have been flattened into plain text.
 */
function markDiffRow(line: string): string {
  if (/^\s{0,3}@@/.test(line)) return `@@ ${line}`;
  if (/^\s{0,3}\+/.test(line)) return `+ ${line}`;
  if (/^\s{0,3}-/.test(line)) return `- ${line}`;
  return line;
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

/**
 * Render Markdown to plain text rows no wider than `width` columns.
 * `width <= 0` yields no rows; blank source lines stay blank rows; an empty
 * body renders as one empty row so the transcript keeps its label row.
 */
export function renderMarkdown(text: string, width: number): string[] {
  const columns = columnLimit(width);
  if (columns === 0) return [];
  const source = sanitizeText(typeof text === "string" ? text : "");
  const lines = source.split("\n");
  const out: string[] = [];
  // The info string of the open fence, or null outside a code block. A fence
  // that never closes is still rendered as code (streaming drafts).
  let fenceInfo: string | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (fenceInfo !== null) {
      if (/^\s{0,3}```+\s*$/.test(line)) {
        out.push(clipLine(FENCE_CLOSE, columns));
        fenceInfo = null;
        continue;
      }
      out.push(clipLine(isDiffLanguage(fenceInfo) ? markDiffRow(line) : line, columns));
      continue;
    }

    if (line.trim() === "") {
      out.push("");
      continue;
    }

    const fence = /^\s{0,3}```(.*)$/.exec(line);
    if (fence !== null) {
      const info = (fence[1] ?? "").trim();
      out.push(clipLine(info === "" ? FENCE_OPEN : `${FENCE_OPEN} ${info}`, columns));
      fenceInfo = info;
      continue;
    }

    const diffLength = plainDiffLength(lines, index);
    if (diffLength > 0) {
      out.push(clipLine(`${FENCE_OPEN} diff`, columns));
      for (let offset = 0; offset < diffLength; offset += 1) {
        out.push(clipLine(markDiffRow(lines[index + offset] ?? ""), columns));
      }
      out.push(clipLine(FENCE_CLOSE, columns));
      index += diffLength - 1;
      continue;
    }

    if (/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push("─".repeat(Math.min(columns, MAX_RULE_WIDTH)));
      continue;
    }

    const heading = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line);
    if (heading !== null) {
      const level = (heading[1] ?? "").length;
      const body = renderInline((heading[2] ?? "").trim());
      if (level <= MAX_HEADING_LEVEL) {
        out.push(...wrapWithPrefix(body, `${"#".repeat(level)} `, columns));
      } else {
        out.push(...wrapText(`${heading[1]} ${body}`, columns));
      }
      continue;
    }

    const quote = /^\s{0,3}>\s?(.*)$/.exec(line);
    if (quote !== null) {
      out.push(...wrapWithPrefix(renderInline((quote[1] ?? "").trim()), QUOTE_PREFIX, columns));
      continue;
    }

    const item = /^(\s*)([-+*]|\d{1,9}[.)])(?:[ \t]+(.*))?$/.exec(line);
    if (item !== null) {
      const indent = (item[1] ?? "").length;
      const marker = item[2] ?? "-";
      const body = renderInline((item[3] ?? "").trim());
      const prefix = `${"  ".repeat(Math.min(1, Math.floor(indent / 2)))}${marker} `;
      out.push(...wrapWithPrefix(body, prefix, columns));
      continue;
    }

    out.push(...wrapText(renderInline(line), columns));
  }

  return out;
}

/** Clip one code row, marking the cut explicitly (never wraps). */
function clipLine(text: string, columns: number): string {
  return truncateToWidth(text, columns, CLIP_MARKER);
}

/** Wrap `text` under a hanging prefix; the prefix stays within `columns`. */
function wrapWithPrefix(text: string, prefix: string, columns: number): string[] {
  const prefixWidth = displayWidth(prefix);
  const available = columns - prefixWidth;
  if (available < 1) return [clipLine(`${prefix}${text}`, columns)];
  const rows = text === "" ? [""] : wrapText(text, available);
  return rows.map((row, index) =>
    index === 0 ? prefix + row : " ".repeat(prefixWidth) + row,
  );
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
 * Strip inline Markdown markers to plain text. Unclosed markers are emitted
 * literally, and recursion is depth-capped so hostile nesting is harmless.
 */
function renderInline(text: string, depth = 0): string {
  if (depth >= MAX_INLINE_DEPTH) return text;
  const links = findLinks(text);
  let out = "";
  let index = 0;
  // Once a closing marker is proven absent it cannot reappear later, so the
  // failed scan is remembered and the rest of the line is literal. That keeps
  // pathological marker runs linear instead of rescanning on every character.
  let noCode = false;
  let noBold = false;
  let noStar = false;

  while (index < text.length) {
    const char = text[index];

    if (char === "[") {
      const link = links.get(index);
      if (link !== undefined) {
        const label = renderInline(text.slice(index + 1, link.labelEnd), depth + 1);
        const url = text.slice(link.labelEnd + 2, link.urlEnd).trim();
        out += url === "" ? label : `${label} (${url})`;
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
        out += text.slice(index + 1, end);
        index = end + 1;
        continue;
      }
    }

    if (char === "*" && text[index + 1] === "*") {
      if (!noBold) {
        const end = text.indexOf("**", index + 2);
        if (end !== -1) {
          out += renderInline(text.slice(index + 2, end), depth + 1);
          index = end + 2;
          continue;
        }
        noBold = true;
      }
      // Unclosed bold: keep the markers literally so nothing is swallowed.
      out += "**";
      index += 2;
      continue;
    }

    if (char === "*" && !noStar) {
      const end = text.indexOf("*", index + 1);
      if (end === -1) {
        noStar = true;
      } else {
        out += renderInline(text.slice(index + 1, end), depth + 1);
        index = end + 1;
        continue;
      }
    }

    out += char;
    index += 1;
  }
  return out;
}
