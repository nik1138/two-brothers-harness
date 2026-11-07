/**
 * Layout for the human (non-TUI) CLI transcript.
 *
 * The `run`/`chat` text mode separates envelopes into blocks, rules off the
 * final decision and renders model-provided Markdown bodies. This module owns
 * that layout as pure code: width and {@link CliStyle} are arguments, never
 * process state, so a pipe, a test and a TTY all take the same path and
 * `stripAnsi(colored)` always reproduces the plain bytes.
 *
 * Markdown is not re-implemented here: {@link renderMarkdownStyled} in
 * `tui/markdownstyle.ts` is the single parser (the TUI transcript's own
 * renderer), and its source sanitizer strips model-supplied ANSI and control
 * bytes before any width math. Every span is then painted with
 * {@link CliStyle.paintEmphasis}, whose escape sequences live in
 * `tui/theme.ts` — this module spells no escape sequence of its own.
 *
 * The layout is also the only place that caps a rule to the terminal width:
 * a rule is never wider than {@link RULE_MAX_WIDTH} columns and never wider
 * than the caller's width, so a narrow terminal never overflows a block.
 */
import { FALLBACK_TERMINAL_WIDTH, plainCliStyle, type CliStyle } from "./clistyle.ts";
import {
  renderMarkdownStyled,
  type StyledLine,
} from "./tui/markdownstyle.ts";
import { displayWidth, sanitizeText, truncateToWidth, wrapText } from "./tui/text.ts";
import type { ThemeToken } from "./tui/theme.ts";

/** Indent of one payload line under its envelope header (`    key: value`). */
export const BODY_INDENT = 4;

/** Indent of one list item render (`      - item`). */
export const LIST_INDENT = 6;

/** A rule line is never rendered wider than this many columns. */
export const RULE_MAX_WIDTH = 80;

/** A rule line never renders narrower than this when the width allows it. */
export const RULE_MIN_WIDTH = 20;

/** The `[user]` transcript prefix, including its six alignment spaces. */
export const USER_PREFIX = "[user]      ";

/** Columns a `[user]` continuation row hangs under (the prefix's width). */
export const USER_INDENT = USER_PREFIX.length;

/** Widest separator the footer uses between its segments. */
const FOOTER_SEPARATOR = " · ";

/**
 * The string form of one model payload field. `null`/`undefined` render as a
 * missing value (empty string) exactly like the interpolated template the
 * transcript used before.
 */
export function displayText(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

/** Display width floor of one renderer: a block always has at least 1 column. */
function columns(width: number): number {
  return Number.isFinite(width) && width >= 1 ? Math.floor(width) : 1;
}

/**
 * Sanitize a model-provided block: ANSI escapes and C0/C1 control bytes are
 * stripped, CRLF/CR are normalized to LF and tabs expand to the terminal tab
 * stops. A model reply can therefore never drive the terminal through a body.
 */
export function sanitizeBlock(value: unknown): string {
  return sanitizeText(displayText(value));
}

/** A single-line payload value: sanitized and joined at any hard line break. */
export function sanitizeOneLine(value: unknown): string {
  return sanitizeBlock(value).replace(/\s*\n\s*/g, " ").trim();
}

/**
 * Plain wrapped rows of one text block (the user task and list items): text is
 * sanitized before wrapping, so the returned rows are display-safe plain text.
 */
export function renderPlainBlock(value: unknown, width: number): string[] {
  return wrapText(sanitizeBlock(value), columns(width));
}

/** Theme tone for one styled Markdown row, given the block's base token. */
function rowTone(line: StyledLine, base: ThemeToken): ThemeToken {
  switch (line.kind) {
    case "fenceOpen":
    case "fenceClose":
    case "code":
    case "quote":
      return "muted";
    case "rule":
      return "border";
    case "heading":
      return "strong";
    case "diff": {
      // A marked row's first span is the structural `marker` span; read the
      // tone from structure instead of re-parsing the flattened text.
      const marker = line.spans[0];
      if (marker !== undefined && marker.style === "marker") {
        if (marker.text === "- ") return "error";
        if (marker.text === "+ ") return "success";
        if (marker.text === "@@ ") return "muted";
      }
      return base;
    }
    default:
      return base;
  }
}

/** Paint one rendered Markdown row: structural tone plus per-span emphasis. */
function paintMarkdownLine(line: StyledLine, style: CliStyle, base: ThemeToken): string {
  const tone = rowTone(line, base);
  let out = "";
  for (const span of line.spans) {
    out += style.paintEmphasis(tone, span.style, span.text);
  }
  return out;
}

/**
 * Render one model-provided Markdown body to width-safe, style-painted rows.
 * `width` is the full width available to the body (the caller subtracts the
 * key label and indentation first). Source text is sanitized by the Markdown
 * renderer; under {@link plainCliStyle} the rows are exactly the plain
 * projection `markdown.ts::renderMarkdown` would produce.
 */
export function renderBody(
  value: unknown,
  width: number,
  style: CliStyle = plainCliStyle,
  base: ThemeToken = "text",
): string[] {
  return renderMarkdownStyled(sanitizeBlock(value), columns(width)).map((line) =>
    paintMarkdownLine(line, style, base),
  );
}

/**
 * Render a `key: <Markdown body>` payload field: the first row carries the dim
 * key label, continuation rows hang under the body column, and the body wraps
 * to the remaining width. Returns one string per display row.
 */
export function renderKeyedBody(
  key: string,
  value: unknown,
  width: number,
  style: CliStyle = plainCliStyle,
  base: ThemeToken = "text",
): string[] {
  const label = `${key}:`;
  const indent = " ".repeat(BODY_INDENT);
  const hanging = indent + " ".repeat(displayWidth(label) + 1);
  const available = Math.max(1, columns(width) - BODY_INDENT - displayWidth(label) - 1);
  const rows = renderBody(value, available, style, base);
  return rows.map((row, index) => {
    if (index === 0) return `${indent}${style.dim(label)} ${row}`;
    return row === "" ? "" : `${hanging}${row}`;
  });
}

/**
 * Render a `key: <single-line value>` payload field. The value is sanitized,
 * wrapped to the remaining width and painted with `base` when one is given
 * (the decision value and dissent use it; titles and numbers stay plain).
 */
export function renderKeyedLine(
  key: string,
  value: unknown,
  width: number,
  style: CliStyle = plainCliStyle,
  base: ThemeToken | null = null,
): string[] {
  const label = `${key}:`;
  const indent = " ".repeat(BODY_INDENT);
  const hanging = indent + " ".repeat(displayWidth(label) + 1);
  const available = Math.max(1, columns(width) - BODY_INDENT - displayWidth(label) - 1);
  const rows = wrapText(sanitizeOneLine(value), available);
  return rows.map((row, index) => {
    const text = row === "" || base === null ? row : style.paint(base, row);
    return index === 0 ? `${indent}${style.dim(label)} ${text}` : `${hanging}${text}`;
  });
}

/**
 * Render a labelled list of model-provided values under its `key:` heading:
 * one hyphenated item per source entry, wrapped with a hanging indent and
 * painted with `tone` when one is given (risk items use the warning tone).
 */
export function renderBullets(
  key: string,
  items: readonly unknown[],
  width: number,
  style: CliStyle = plainCliStyle,
  tone: ThemeToken | null = null,
): string[] {
  const out: string[] = [`${" ".repeat(BODY_INDENT)}${style.dim(`${key}:`)}`];
  const available = Math.max(1, columns(width) - LIST_INDENT - 2);
  for (const item of items) {
    const rows = wrapText(sanitizeBlock(item).trim(), available);
    rows.forEach((row, index) => {
      const painted = row === "" || tone === null ? row : style.paint(tone, row);
      out.push(`${index === 0 ? `${" ".repeat(LIST_INDENT)}- ` : " ".repeat(LIST_INDENT + 2)}${painted}`);
    });
  }
  return out;
}

/** The width a rule for `width` columns may occupy (never overflows it). */
export function ruleWidth(width: number): number {
  return Math.min(columns(width), RULE_MAX_WIDTH);
}

/**
 * A width-capped labelled rule, e.g. `── decision ──────────`. The rule is
 * capped to {@link RULE_MAX_WIDTH} and to the caller's width, so it never
 * overflows the transcript; a width too narrow for the label degrades to a
 * plain rule. Only drawn when the width can carry at least the minimum rule.
 */
export function renderLabeledRule(
  label: string,
  width: number,
  style: CliStyle = plainCliStyle,
  token: ThemeToken = "decision",
): string {
  const size = ruleWidth(width);
  const text = sanitizeOneLine(label);
  const prefix = `── ${text} `;
  const rest = size - displayWidth(prefix);
  if (rest < 1 || size < RULE_MIN_WIDTH) {
    return style.paint("border", "─".repeat(size));
  }
  return (
    style.paint("border", "── ") +
    style.paint(token, text) +
    style.paint("border", ` ${"─".repeat(rest)}`)
  );
}

/** The usage counters the human footer renders (a loose `UsageTotals` view). */
export interface FooterUsage {
  input_tokens?: unknown;
  output_tokens?: unknown;
  cached_tokens?: unknown;
  model_calls?: unknown;
}

function usageInt(value: unknown): number {
  const num = Number(value ?? 0) || 0;
  return Number.isFinite(num) ? num : 0;
}

/**
 * The compact human run footer:
 * `tokens 40 in / 20 out · cache 25% · 4 calls · cost $0.0300`.
 *
 * Only the segments the run actually has are rendered — cache only when a
 * cache hit was recorded, cost only when the run's usage attributes to one
 * priced model. `null` means the run reported no usage at all, so the caller
 * prints no footer (a zero-usage provider should not claim `tokens 0 in`).
 * The line is width-capped: it is shortened with the shared ellipsis rather
 * than overflowing a narrow terminal.
 */
export function humanFooter(
  usage: FooterUsage,
  cost: number | null,
  style: CliStyle = plainCliStyle,
  width: number = FALLBACK_TERMINAL_WIDTH,
): string | null {
  const input = usageInt(usage.input_tokens);
  const output = usageInt(usage.output_tokens);
  const cached = usageInt(usage.cached_tokens);
  const calls = usageInt(usage.model_calls);
  if (input === 0 && output === 0 && cached === 0 && calls === 0) return null;
  const percent = input > 0 ? Math.min(100, Math.round((cached * 100) / input)) : 0;
  const parts: string[] = [
    `${style.paint("muted", "tokens")} ${input} in / ${output} out`,
  ];
  if (cached > 0) parts.push(`${style.paint("muted", "cache")} ${percent}%`);
  parts.push(`${calls} ${calls === 1 ? "call" : "calls"}`);
  if (cost !== null) {
    parts.push(`${style.paint("muted", "cost")} ${style.paint("strong", `$${cost.toFixed(4)}`)}`);
  }
  const line = parts.join(style.paint("dim", FOOTER_SEPARATOR));
  return truncateToWidth(line, columns(width));
}
