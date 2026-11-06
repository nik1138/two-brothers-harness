/**
 * Display-width utilities for the TUI: ANSI-aware measuring, truncating,
 * wrapping and padding of text by terminal columns.
 *
 * Width model:
 *
 * - ANSI CSI/OSC/DCS/PM/APC escapes (and two-character escapes) are zero
 *   width. `truncateToWidth`/`padToWidth` preserve them; `wrapText` strips
 *   them, because a wrapped row is re-styled by the renderer.
 * - Text is segmented into grapheme clusters with `Intl.Segmenter`, so
 *   combining marks, emoji ZWJ sequences, regional-indicator flags and
 *   keycaps are measured as one unit and are never split by a width cut.
 * - East Asian Wide/Fullwidth code points take two columns; combining
 *   marks, format characters and controls take none; everything else takes
 *   one. Ambiguous-width characters follow the terminal default (one).
 * - Emoji presentation sequences (VS16, `Emoji_Presentation`, ZWJ
 *   pictographs, flags) take two columns so rows do not overflow on
 *   terminals that render them double-width.
 * - Tabs advance to the next tab stop (`tabWidth`, default 4 — the same
 *   expansion the existing renderer uses). `expandTabs` and `sanitizeText`
 *   turn them into spaces for predictable layout.
 *
 * `Intl.Segmenter` ships with Node 22, so this module adds no dependency.
 * The grapheme-based width rules are inspired by `string-width` v7 (MIT,
 * Sindre Sorhus); the Wide/Fullwidth interval table is adapted from
 * `is-fullwidth-code-point` v5 (MIT, Sindre Sorhus,
 * https://github.com/sindresorhus/is-fullwidth-code-point), which in turn
 * derives from Unicode's EastAsianWidth.txt (Unicode License v3). This is a
 * fresh implementation for this package; the lane report records the exact
 * attribution needed for NOTICE.
 *
 * Span-preserving layout: {@link wrapRuns} and {@link truncateRuns} run the
 * same width/grapheme rules as {@link wrapText}/{@link truncateToWidth} but
 * carry an opaque per-run style through the break, so a renderer can add
 * emphasis after the layout is final.
 */

/** Options shared by the width helpers. */
export interface WidthOptions {
  /** Columns between tab stops (default 4, matching the renderer). */
  tabWidth?: number;
}

/** Horizontal alignment accepted by {@link padToWidth}. */
export type PadAlign = "left" | "right" | "center";

const ESC = "\u001b";
const DEFAULT_TAB_WIDTH = 4;
const SGR_RESET = `${ESC}[0m`;

/**
 * East Asian Wide (W) and Fullwidth (F) ranges, inclusive, sorted. Ranges
 * adapted from `is-fullwidth-code-point` v5 (MIT); emoji are measured by
 * their presentation rules below rather than by this table.
 */
const WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f],
  [0x231a, 0x231b],
  [0x2329, 0x232a],
  [0x23e9, 0x23ec],
  [0x23f0, 0x23f0],
  [0x23f3, 0x23f3],
  [0x25fd, 0x25fe],
  [0x2614, 0x2615],
  [0x2648, 0x2653],
  [0x267f, 0x267f],
  [0x2693, 0x2693],
  [0x26a1, 0x26a1],
  [0x26aa, 0x26ab],
  [0x26bd, 0x26be],
  [0x26c4, 0x26c5],
  [0x26ce, 0x26ce],
  [0x26d4, 0x26d4],
  [0x26ea, 0x26ea],
  [0x26f2, 0x26f3],
  [0x26f5, 0x26f5],
  [0x26fa, 0x26fa],
  [0x26fd, 0x26fd],
  [0x2705, 0x2705],
  [0x270a, 0x270b],
  [0x2728, 0x2728],
  [0x274c, 0x274c],
  [0x274e, 0x274e],
  [0x2753, 0x2755],
  [0x2757, 0x2757],
  [0x2795, 0x2797],
  [0x27b0, 0x27b0],
  [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
  [0x2e80, 0x303e],
  [0x3040, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x16fe0, 0x16fe4],
  [0x16ff0, 0x16ff1],
  [0x17000, 0x187f7],
  [0x18800, 0x18cd5],
  [0x18d00, 0x18d08],
  [0x1aff0, 0x1aff3],
  [0x1aff5, 0x1affb],
  [0x1affd, 0x1affe],
  [0x1b000, 0x1b122],
  [0x1b132, 0x1b132],
  [0x1b150, 0x1b152],
  [0x1b155, 0x1b155],
  [0x1b164, 0x1b167],
  [0x1b170, 0x1b2fb],
  [0x1f004, 0x1f004],
  [0x1f0cf, 0x1f0cf],
  [0x1f18e, 0x1f18e],
  [0x1f191, 0x1f19a],
  [0x1f200, 0x1f320],
  [0x1f32d, 0x1f335],
  [0x1f337, 0x1f37c],
  [0x1f37e, 0x1f393],
  [0x1f3a0, 0x1f3ca],
  [0x1f3cf, 0x1f3d3],
  [0x1f3e0, 0x1f3f0],
  [0x1f3f4, 0x1f3f4],
  [0x1f3f8, 0x1f43e],
  [0x1f440, 0x1f440],
  [0x1f442, 0x1f4fc],
  [0x1f4ff, 0x1f53d],
  [0x1f54b, 0x1f54e],
  [0x1f550, 0x1f567],
  [0x1f57a, 0x1f57a],
  [0x1f595, 0x1f596],
  [0x1f5a4, 0x1f5a4],
  [0x1f5fb, 0x1f64f],
  [0x1f680, 0x1f6c5],
  [0x1f6cc, 0x1f6cc],
  [0x1f6d0, 0x1f6d2],
  [0x1f6d5, 0x1f6d7],
  [0x1f6dc, 0x1f6df],
  [0x1f6eb, 0x1f6ec],
  [0x1f6f4, 0x1f6fc],
  [0x1f7e0, 0x1f7eb],
  [0x1f7f0, 0x1f7f0],
  [0x1f90c, 0x1f93a],
  [0x1f93c, 0x1f945],
  [0x1f947, 0x1f9ff],
  [0x1fa70, 0x1faff],
  [0x20000, 0x2fffd],
  [0x30000, 0x3fffd],
];

const ZERO_WIDTH_RE = /^[\p{Cc}\p{Cf}\p{Mn}\p{Me}\u1160-\u11ff\u200b]$/u;
const EMOJI_PRESENTATION_RE = /\p{Emoji_Presentation}/u;
const EXTENDED_PICTOGRAPHIC_RE = /\p{Extended_Pictographic}/u;
const REGIONAL_INDICATOR_RE = /\p{Regional_Indicator}/u;

interface GraphemeSegmenter {
  segment(input: string): Iterable<{ segment: string }>;
}

let segmenter: GraphemeSegmenter | null | undefined;

/** Solar-sail guard: `Intl.Segmenter` is in Node 22, but never explode if absent. */
function graphemes(text: string): string[] {
  if (text === "") return [];
  if (segmenter === undefined) {
    try {
      segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    } catch {
      segmenter = null;
    }
  }
  if (segmenter === null) return Array.from(text);
  return Array.from(segmenter.segment(text), (entry) => entry.segment);
}

/**
 * End index (exclusive) of the ANSI escape starting at `index`, or -1 when
 * the text at `index` is not an escape. A malformed OSC/DCS consumes the
 * rest of the string so no control payload leaks into the display text.
 */
function ansiEnd(text: string, index: number): number {
  if (text.charCodeAt(index) !== 0x1b) return -1;
  const next = text[index + 1];
  if (next === undefined) return index + 1;
  if (next === "[") {
    for (let i = index + 2; i < text.length; i += 1) {
      const code = text.charCodeAt(i);
      if (code >= 0x40 && code <= 0x7e) return i + 1;
    }
    return text.length;
  }
  if (next === "]" || next === "P" || next === "X" || next === "^" || next === "_") {
    for (let i = index + 2; i < text.length; i += 1) {
      if (text.charCodeAt(i) === 0x07) return i + 1;
      if (text.charCodeAt(i) === 0x1b && text[i + 1] === "\\") return i + 2;
    }
    return text.length;
  }
  return Math.min(index + 2, text.length);
}

/** Remove ANSI escape sequences (CSI, OSC, DCS/PM/APC, two-char escapes). */
export function stripAnsi(text: string): string {
  const value = typeof text === "string" ? text : "";
  if (!value.includes(ESC)) return value;
  let out = "";
  for (let i = 0; i < value.length; ) {
    const end = ansiEnd(value, i);
    if (end > i) {
      i = end;
      continue;
    }
    out += value[i];
    i += 1;
  }
  return out;
}

interface AnsiPart {
  escape: boolean;
  value: string;
}

/** Split text into plain runs and ANSI escape tokens, preserving order. */
function ansiParts(text: string): AnsiPart[] {
  const parts: AnsiPart[] = [];
  let plainStart = 0;
  for (let i = 0; i < text.length; ) {
    const end = ansiEnd(text, i);
    if (end <= i) {
      i += 1;
      continue;
    }
    if (i > plainStart) parts.push({ escape: false, value: text.slice(plainStart, i) });
    parts.push({ escape: true, value: text.slice(i, end) });
    i = end;
    plainStart = end;
  }
  if (plainStart < text.length) parts.push({ escape: false, value: text.slice(plainStart) });
  return parts;
}

function normaliseWidth(value: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) return fallback;
  return Math.floor(value);
}

function isWideCodePoint(codePoint: number): boolean {
  let low = 0;
  let high = WIDE_RANGES.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const range = WIDE_RANGES[middle];
    if (codePoint < range[0]) high = middle - 1;
    else if (codePoint > range[1]) low = middle + 1;
    else return true;
  }
  return false;
}

function isZeroWidthCodePoint(codePoint: number): boolean {
  if (codePoint === 0 || (codePoint >= 0x00 && codePoint <= 0x1f) || codePoint === 0x7f) {
    return true;
  }
  if (codePoint >= 0x80 && codePoint <= 0x9f) return true;
  return ZERO_WIDTH_RE.test(String.fromCodePoint(codePoint));
}

/**
 * Width of one grapheme cluster. Control/combining-only clusters are zero;
 * emoji presentation and East Asian wide code points are two; the rest one.
 */
function graphemeWidth(segment: string): number {
  if (segment === "") return 0;
  if (segment === "\t") return 1;
  let allZero = true;
  let wide = false;
  for (const char of segment) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (!isZeroWidthCodePoint(codePoint)) allZero = false;
    if (isWideCodePoint(codePoint)) wide = true;
  }
  if (allZero) return 0;
  if (isEmojiPresentation(segment)) return 2;
  return wide ? 2 : 1;
}

function isEmojiPresentation(segment: string): boolean {
  // Text presentation selector wins over an emoji-default base.
  if (segment.includes("\uFE0E")) return false;
  if (segment.includes("\uFE0F")) return true;
  if (EMOJI_PRESENTATION_RE.test(segment)) return true;
  if (segment.includes("\u200D") && EXTENDED_PICTOGRAPHIC_RE.test(segment)) return true;
  let regionalIndicators = 0;
  for (const char of segment) {
    if (REGIONAL_INDICATOR_RE.test(char)) regionalIndicators += 1;
  }
  return regionalIndicators >= 2;
}

/** Expand tabs to spaces at tab stops, preserving ANSI escapes exactly. */
export function expandTabs(text: string, tabWidth: number = DEFAULT_TAB_WIDTH): string {
  const value = typeof text === "string" ? text : "";
  if (!value.includes("\t")) return value;
  const columns = normaliseWidth(tabWidth, DEFAULT_TAB_WIDTH);
  let out = "";
  let column = 0;
  for (const part of ansiParts(value)) {
    if (part.escape) {
      out += part.value;
      continue;
    }
    for (const segment of graphemes(part.value)) {
      if (segment === "\t") {
        const pad = columns - (column % columns);
        out += " ".repeat(pad);
        column += pad;
        continue;
      }
      out += segment;
      if (segment === "\n") column = 0;
      else column += graphemeWidth(segment);
    }
  }
  return out;
}

/**
 * Strip escape sequences and C0/C1 controls, normalize CRLF/CR to LF and
 * expand tabs. Model output must pass through here before it reaches a
 * width calculation or a frame: a control byte from a model must never
 * drive the terminal.
 */
export function sanitizeText(text: string, options: WidthOptions = {}): string {
  const plain = stripAnsi(typeof text === "string" ? text : "");
  return expandTabs(
    plain
      .replace(/\r\n?/g, "\n")
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, ""),
    normaliseWidth(options.tabWidth ?? DEFAULT_TAB_WIDTH, DEFAULT_TAB_WIDTH),
  );
}

/**
 * Terminal columns occupied by `text`. Escape sequences are ignored; a
 * newline/control character is zero width, so this measures one line's worth
 * of content (use {@link wrapText} for multi-line layout).
 */
export function displayWidth(text: string, options: WidthOptions = {}): number {
  const value = typeof text === "string" ? text : "";
  if (value === "") return 0;
  const columns = normaliseWidth(options.tabWidth ?? DEFAULT_TAB_WIDTH, DEFAULT_TAB_WIDTH);
  const plain = stripAnsi(value);
  let width = 0;
  for (const segment of graphemes(plain)) {
    if (segment === "\t") {
      width += columns - (width % columns);
      continue;
    }
    width += graphemeWidth(segment);
  }
  return width;
}

interface CutResult {
  text: string;
  width: number;
  truncated: boolean;
  sawAnsi: boolean;
}

/** Cut `text` to at most `limit` columns without splitting a grapheme. */
function cutToWidth(text: string, limit: number): CutResult {
  let out = "";
  let width = 0;
  let sawAnsi = false;
  for (const part of ansiParts(text)) {
    if (part.escape) {
      out += part.value;
      sawAnsi = true;
      continue;
    }
    for (const segment of graphemes(part.value)) {
      const segmentWidth = graphemeWidth(segment);
      if (width + segmentWidth > limit) {
        return { text: out, width, truncated: true, sawAnsi };
      }
      out += segment;
      width += segmentWidth;
    }
  }
  return { text: out, width, truncated: false, sawAnsi };
}

/**
 * Shorten `text` to at most `width` columns. When the text is too long, the
 * last `ellipsis` (default `…`) is reserved and appended; wide clusters are
 * never cut in half, so a CJK glyph or emoji is either kept whole or
 * dropped. ANSI escapes inside the kept prefix are preserved and a reset is
 * appended when styled text was cut. `width <= 0` yields `""`.
 */
export function truncateToWidth(
  text: string,
  width: number,
  ellipsis: string = "…",
  options: WidthOptions = {},
): string {
  const value = typeof text === "string" ? text : "";
  const limit = Number.isFinite(width) && width > 0 ? Math.floor(width) : 0;
  if (limit === 0) return "";
  const expanded = expandTabs(value, options.tabWidth ?? DEFAULT_TAB_WIDTH);
  if (displayWidth(expanded, options) <= limit) return expanded;

  const suffix = typeof ellipsis === "string" ? ellipsis : "";
  const suffixWidth = displayWidth(suffix, options);
  if (suffix === "") {
    const cut = cutToWidth(expanded, limit);
    return cut.sawAnsi && cut.text !== "" ? cut.text + SGR_RESET : cut.text;
  }
  if (suffixWidth >= limit) {
    // No room for content: clip the ellipsis itself.
    return cutToWidth(suffix, limit).text;
  }
  const cut = cutToWidth(expanded, limit - suffixWidth);
  return `${cut.text}${suffix}${cut.sawAnsi ? SGR_RESET : ""}`;
}

/**
 * Pad `text` to exactly `width` columns (truncating first when needed).
 * Alignment is applied with spaces; ANSI escapes in the text stay intact.
 */
export function padToWidth(
  text: string,
  width: number,
  align: PadAlign = "left",
  options: WidthOptions = {},
): string {
  const limit = Number.isFinite(width) && width > 0 ? Math.floor(width) : 0;
  if (limit === 0) return "";
  const base = truncateToWidth(text, limit, "", options);
  const gap = Math.max(0, limit - displayWidth(base, options));
  if (gap === 0) return base;
  if (align === "right") return `${" ".repeat(gap)}${base}`;
  if (align === "center") {
    const left = Math.floor(gap / 2);
    return `${" ".repeat(left)}${base}${" ".repeat(gap - left)}`;
  }
  return `${base}${" ".repeat(gap)}`;
}

function segmentsWidth(segments: string[]): number {
  let width = 0;
  for (const segment of segments) width += graphemeWidth(segment);
  return width;
}

function trimTrailingSpaces(segments: string[]): string {
  let end = segments.length;
  while (end > 0 && segments[end - 1] === " ") end -= 1;
  return segments.slice(0, end).join("");
}

function wrapParagraph(text: string, width: number): string[] {
  if (text === "") return [""];
  const rows: string[] = [];
  let line: string[] = [];
  let lineWidth = 0;

  for (const segment of graphemes(text)) {
    const segmentWidth = segment === " " ? 1 : graphemeWidth(segment);

    if (lineWidth + segmentWidth <= width) {
      line.push(segment);
      lineWidth += segmentWidth;
      continue;
    }

    // A space at the break point is consumed instead of starting a row.
    if (segment === " ") {
      if (line.length > 0) rows.push(trimTrailingSpaces(line));
      line = [];
      lineWidth = 0;
      continue;
    }

    // Prefer breaking at the last space in the current row.
    let breakAt = -1;
    for (let i = line.length - 1; i >= 0; i -= 1) {
      if (line[i] === " ") {
        breakAt = i;
        break;
      }
    }
    if (breakAt > 0) {
      rows.push(trimTrailingSpaces(line.slice(0, breakAt)));
      line = line.slice(breakAt + 1);
      while (line.length > 0 && line[0] === " ") line.shift();
      lineWidth = segmentsWidth(line);
    }

    if (lineWidth + segmentWidth > width) {
      if (line.length > 0) {
        rows.push(trimTrailingSpaces(line));
        line = [];
        lineWidth = 0;
      }
      if (segmentWidth > width) {
        // An indivisible wide cluster cannot fit a one-cell row. Keep the row
        // within the terminal and make the substitution visible.
        rows.push("…");
        continue;
      }
    }

    line.push(segment);
    lineWidth += segmentWidth;
  }

  if (line.length > 0) rows.push(trimTrailingSpaces(line));
  return rows.length > 0 ? rows : [""];
}

/**
 * Greedy word-wrap of `text` to `width` columns. Explicit newlines start a
 * new paragraph (a blank line stays a blank row); words longer than the
 * width are hard-split at grapheme boundaries; ANSI escapes are stripped
 * before wrapping. The width is clamped to at least 1.
 */
export function wrapText(text: string, width: number, options: WidthOptions = {}): string[] {
  const columns = Number.isFinite(width) && width >= 1 ? Math.floor(width) : 1;
  const normalised = sanitizeText(typeof text === "string" ? text : "", options);
  const rows: string[] = [];
  for (const paragraph of normalised.split("\n")) {
    rows.push(...wrapParagraph(paragraph, columns));
  }
  return rows;
}

// --------------------------------------------------------------------------- //
// span-preserving layout
// --------------------------------------------------------------------------- //

/**
 * One styled run of text for the span-preserving layout helpers. The style is
 * opaque here: {@link wrapRuns} and {@link truncateRuns} only carry it through
 * segmenting/cutting, so the same display-width rules serve Markdown emphasis
 * or any future styling model.
 *
 * The input contract matches the plain helpers: runs must be one already
 * sanitized line (ANSI escapes, tabs, CRLF and C0/C1 controls removed with
 * {@link sanitizeText}). The Markdown span renderer sanitizes its source
 * before it builds runs, so no styling marker can smuggle a control byte past
 * the width math.
 */
export interface StyledRun<Style = string> {
  text: string;
  style?: Style;
}

interface StyledGrapheme<Style> {
  grapheme: string;
  style?: Style;
  width: number;
}

/**
 * Segment styled runs into graphemes, remembering each grapheme's style.
 * The runs are joined first and segmented once, exactly like the plain
 * helpers segment the flattened text, so a grapheme cluster that happens to
 * span a run boundary (e.g. a combining mark after a styled run) is still one
 * width unit and is never split; it inherits the style of its first code unit.
 */
function styledGraphemes<Style>(runs: readonly StyledRun<Style>[]): StyledGrapheme<Style>[] {
  const texts: string[] = [];
  const ranges: { start: number; end: number; style?: Style }[] = [];
  let offset = 0;
  for (const run of runs) {
    const text = typeof run.text === "string" ? run.text : "";
    texts.push(text);
    ranges.push({ start: offset, end: offset + text.length, style: run.style });
    offset += text.length;
  }
  const out: StyledGrapheme<Style>[] = [];
  let rangeIndex = 0;
  let position = 0;
  for (const grapheme of graphemes(texts.join(""))) {
    while (rangeIndex < ranges.length && (ranges[rangeIndex]?.end ?? 0) <= position) {
      rangeIndex += 1;
    }
    out.push({ grapheme, style: ranges[rangeIndex]?.style, width: graphemeWidth(grapheme) });
    position += grapheme.length;
  }
  return out;
}

/** Rebuild runs from styled graphemes, merging adjacent same-style runs. */
function styledRuns<Style>(records: readonly StyledGrapheme<Style>[]): StyledRun<Style>[] {
  const out: StyledRun<Style>[] = [];
  for (const record of records) {
    if (record.grapheme === "") continue;
    const last = out[out.length - 1];
    if (last !== undefined && last.style === record.style) {
      last.text += record.grapheme;
      continue;
    }
    const run: StyledRun<Style> = { text: record.grapheme };
    if (record.style !== undefined) run.style = record.style;
    out.push(run);
  }
  return out;
}

function styledWidth<Style>(records: readonly StyledGrapheme<Style>[]): number {
  let width = 0;
  for (const record of records) width += record.width;
  return width;
}

function trimStyledTrailingSpaces<Style>(
  records: readonly StyledGrapheme<Style>[],
): StyledGrapheme<Style>[] {
  let end = records.length;
  while (end > 0 && records[end - 1]?.grapheme === " ") end -= 1;
  return records.slice(0, end);
}

/** Cut styled graphemes to at most `limit` columns (never split a grapheme). */
function cutStyled<Style>(
  records: readonly StyledGrapheme<Style>[],
  limit: number,
): StyledRun<Style>[] {
  const kept: StyledGrapheme<Style>[] = [];
  let width = 0;
  for (const record of records) {
    if (width + record.width > limit) break;
    kept.push(record);
    width += record.width;
  }
  return styledRuns(kept);
}

/**
 * Greedy word-wrap of styled runs to `width` columns, mirroring
 * {@link wrapText}'s paragraph algorithm exactly: the space at a break is
 * consumed, words longer than the width are hard-split at grapheme
 * boundaries, and a wide cluster that cannot fit a one-cell row becomes `…`.
 *
 * Every returned row keeps each run's style only on its own graphemes, so a
 * colour theme can paint emphasis after wrapping. `rows.map(join)` equals
 * `wrapText(plainText, width)` for the same sanitized input — the property
 * test in `tests/tuistyle.test.ts` pins that equivalence.
 */
export function wrapRuns<Style>(
  runs: readonly StyledRun<Style>[],
  width: number,
): StyledRun<Style>[][] {
  const columns = Number.isFinite(width) && width >= 1 ? Math.floor(width) : 1;
  const all = styledGraphemes(runs);
  const rows: StyledGrapheme<Style>[][] = [];
  let line: StyledGrapheme<Style>[] = [];
  let lineWidth = 0;

  for (const record of all) {
    if (lineWidth + record.width <= columns) {
      line.push(record);
      lineWidth += record.width;
      continue;
    }

    // A space at the break point is consumed instead of starting a row.
    if (record.grapheme === " ") {
      if (line.length > 0) rows.push(trimStyledTrailingSpaces(line));
      line = [];
      lineWidth = 0;
      continue;
    }

    // Prefer breaking at the last space in the current row.
    let breakAt = -1;
    for (let index = line.length - 1; index >= 0; index -= 1) {
      if (line[index]?.grapheme === " ") {
        breakAt = index;
        break;
      }
    }
    if (breakAt > 0) {
      rows.push(trimStyledTrailingSpaces(line.slice(0, breakAt)));
      line = line.slice(breakAt + 1);
      while (line.length > 0 && line[0]?.grapheme === " ") line.shift();
      lineWidth = styledWidth(line);
    }

    if (lineWidth + record.width > columns) {
      if (line.length > 0) {
        rows.push(trimStyledTrailingSpaces(line));
        line = [];
        lineWidth = 0;
      }
      if (record.width > columns) {
        // An indivisible wide cluster cannot fit a one-cell row: keep the row
        // within the terminal and make the substitution visible, as wrapText does.
        rows.push([{ grapheme: "…", width: 1 }]);
        continue;
      }
    }

    line.push(record);
    lineWidth += record.width;
  }

  if (line.length > 0) rows.push(trimStyledTrailingSpaces(line));
  return (rows.length > 0 ? rows : [[]]).map(styledRuns);
}

/**
 * Shorten styled runs to at most `width` columns, mirroring
 * {@link truncateToWidth}'s cut: the last `ellipsis` (default `…`) is reserved
 * and appended when content is dropped, whole graphemes are kept or dropped
 * (never split), and the cut keeps each surviving run's style. `width <= 0`
 * yields no runs.
 */
export function truncateRuns<Style>(
  runs: readonly StyledRun<Style>[],
  width: number,
  ellipsis: string = "…",
): StyledRun<Style>[] {
  const limit = Number.isFinite(width) && width > 0 ? Math.floor(width) : 0;
  if (limit === 0) return [];
  const records = styledGraphemes(runs);
  if (styledWidth(records) <= limit) return runs.map((run) => ({ ...run }));

  const suffix = typeof ellipsis === "string" ? ellipsis : "";
  if (suffix === "") return cutStyled(records, limit);
  const suffixRecords = styledGraphemes<Style>([{ text: suffix }]);
  const suffixWidth = styledWidth(suffixRecords);
  if (suffixWidth >= limit) return cutStyled(suffixRecords, limit);
  return [...cutStyled(records, limit - suffixWidth), { text: suffix }];
}