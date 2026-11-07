/**
 * Layout for the human (non-TUI) CLI transcript.
 *
 * The `run`/`chat` text mode separates envelopes into blocks, rules off the
 * final decision and renders model-provided Markdown bodies. This module owns
 * that layout as pure code: width and {@link CliStyle} are arguments, never
 * process state, so a pipe, a test and a TTY all take the same path and
 * `stripAnsi(colored)` always reproduces the plain bytes.
 *
 * The same per-envelope renderer feeds two projections:
 *
 * - {@link renderMessages} — the whole finished transcript as one string
 *   (piped/non-TTY output, byte-identical to the pre-live behavior);
 * - {@link createLiveTranscript} — the incremental TTY projection: each
 *   envelope block and each dim activity line is written to a sink as soon as
 *   the harness produces it, with the final footer reserved for the end.
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
import {
  FALLBACK_TERMINAL_WIDTH,
  plainCliStyle,
  terminalWidth,
  type CliStyle,
} from "./clistyle.ts";
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

// --------------------------------------------------------------------------- //
// envelope blocks (one renderer for the final and the live projection)
// --------------------------------------------------------------------------- //

/** Paint a transcript role name with its semantic token (`muted` otherwise). */
export function paintRole(style: CliStyle, role: string): string {
  const token: ThemeToken =
    role === "user" ? "user" : role === "senior" ? "senior" : role === "junior" ? "junior" : "muted";
  return style.paint(token, role);
}

/** A payload list field (the protocol sanitizer guarantees arrays; bail soft). */
function payloadItems(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Theme tone for a review verdict: `accept` reads as success, rework warns. */
function verdictTone(value: unknown): ThemeToken | null {
  const verdict = sanitizeOneLine(value).toLowerCase();
  if (verdict === "accept") return "success";
  if (verdict === "revise" || verdict === "reject") return "warning";
  return null;
}

/**
 * One envelope block: the `[from -> to] kind` header plus one row per rendered
 * payload field. Model-provided text is sanitized before layout; prose fields
 * render as width-safe Markdown bodies (the TUI's parser), while titles,
 * numbers and verdicts stay single-line values.
 *
 * This is the single per-envelope renderer: {@link renderMessages} joins its
 * blocks for the finished transcript and {@link createLiveTranscript} writes
 * them as they arrive. Both therefore produce identical bytes per envelope.
 */
export function renderEnvelopeBlock(
  msg: Record<string, any>,
  verbose: boolean,
  style: CliStyle,
  width: number,
): string[] {
  const from = sanitizeOneLine(msg.from);
  const to = sanitizeOneLine(msg.to);
  const kind = sanitizeOneLine(msg.kind);
  const payload: Record<string, unknown> =
    msg.payload !== null && typeof msg.payload === "object"
      ? (msg.payload as Record<string, unknown>)
      : {};

  if (kind === "message" && from === "user") {
    // Keep text on the historical `[user]      <task>` line: scripts and the
    // E2E anchors read the task from that line; only long text wraps.
    const prefix = `[${paintRole(style, "user")}]${" ".repeat(USER_INDENT - "[user]".length)}`;
    const rows = renderPlainBlock(payload.text, width - USER_INDENT);
    return rows.map((row, index) =>
      index === 0 ? `${prefix}${row}` : `${" ".repeat(USER_INDENT)}${row}`,
    );
  }

  const block: string[] = [];
  // The final verdict is the run's product: rule it off so it reads as the
  // conclusion rather than one more envelope in the pile.
  if (kind === "decision") block.push(renderLabeledRule("decision", width, style));
  block.push(`[${paintRole(style, from)} -> ${paintRole(style, to)}] ${style.dim(kind)}`);
  if (verbose) block.push("    " + JSON.stringify(payload));

  const roleTone: ThemeToken = from === "junior" ? "junior" : "senior";

  if (kind === "consult") {
    block.push(...renderKeyedBody("ask", payload.ask, width, style, roleTone));
    block.push(...renderKeyedLine("expect", payload.expect ?? "proposal", width, style));
  } else if (kind === "proposal") {
    block.push(...renderKeyedLine("title", payload.title, width, style));
    block.push(...renderKeyedBody("answer", payload.answer, width, style, roleTone));
    if (payload.rationale) {
      block.push(...renderKeyedBody("rationale", payload.rationale, width, style, "muted"));
    }
    if (payload.risks) {
      block.push(...renderBullets("risks", payloadItems(payload.risks), width, style, "warning"));
    }
    block.push(...renderKeyedLine("confidence", payload.confidence, width, style));
    if (payload.asks) {
      block.push(...renderBullets("asks", payloadItems(payload.asks), width, style));
    }
  } else if (kind === "delegation") {
    block.push(...renderKeyedBody("work", payload.work, width, style, roleTone));
    block.push(...renderBullets("acceptance", payloadItems(payload.acceptance), width, style));
  } else if (kind === "deliverable") {
    block.push(...renderKeyedBody("result", payload.result, width, style, roleTone));
    if (payload.artifacts) {
      block.push(...renderBullets("artifacts", payloadItems(payload.artifacts), width, style));
    }
    block.push(...renderKeyedLine("confidence", payload.confidence, width, style));
  } else if (kind === "review") {
    block.push(
      ...renderKeyedLine("verdict", payload.verdict, width, style, verdictTone(payload.verdict)),
    );
    block.push(...renderKeyedBody("notes", payload.notes, width, style, roleTone));
  } else if (kind === "decision") {
    block.push(...renderKeyedBody("decision", payload.decision, width, style, "decision"));
    block.push(...renderKeyedBody("rationale", payload.rationale, width, style, "muted"));
    block.push(...renderKeyedLine("confidence", payload.confidence, width, style));
    block.push(
      ...renderKeyedLine(
        "dissent",
        payload.dissent ?? "(none)",
        width,
        style,
        payload.dissent === undefined || payload.dissent === null ? null : "dissent",
      ),
    );
    if (payload.accepted_proposals) {
      block.push(
        ...renderBullets(
          "accepted_proposals",
          payloadItems(payload.accepted_proposals),
          width,
          style,
        ),
      );
    }
  }
  return block;
}

/**
 * The human transcript for a `run` (and every chat REPL turn).
 *
 * Envelopes render as separate blocks (one blank line between them) with a
 * stable `[from -> to] kind` header, a width-capped rule in front of the
 * decision block, and model prose as width-safe Markdown. `[role -> role]`
 * headers are painted by role token, the envelope kind is `dim`, the labelled
 * payload keys are `dim`, a decision value uses the bold `decision` token and
 * a dissent value the `dissent` token. `width` defaults to
 * {@link terminalWidth}, so piped output keeps the 96-column plain layout and
 * a TTY wraps to its own size; the plain default keeps machine-safe text.
 */
export function renderMessages(
  messages: Array<Record<string, any>>,
  verbose: boolean,
  style: CliStyle = plainCliStyle,
  width: number = terminalWidth(),
): string {
  return messages
    .map((msg) => renderEnvelopeBlock(msg, verbose, style, width).join("\n"))
    .join("\n\n");
}

// --------------------------------------------------------------------------- //
// live transcript (TTY-only projection)
// --------------------------------------------------------------------------- //

/** The minimal sink a live transcript writes to (`CliIO` is structurally one). */
export interface TranscriptSink {
  log(line: string): void;
}

/**
 * One dim activity/progress row: `· <text>`. The text is sanitized and the
 * whole row is capped to the caller's width, so a model/tool name can never
 * break the terminal or overflow the line. Empty text renders nothing.
 */
export function renderActivityLine(
  text: string,
  style: CliStyle = plainCliStyle,
  width: number = FALLBACK_TERMINAL_WIDTH,
): string {
  const body = sanitizeOneLine(text);
  if (body === "") return "";
  return truncateToWidth(style.dim(`· ${body}`), columns(width));
}

/** Options for {@link createLiveTranscript} (all injectable for tests). */
export interface LiveTranscriptOptions {
  /** Terminal style for the TTY projection (plain for a color-free terminal). */
  style?: CliStyle;
  /** Include the per-envelope payload JSON (the `--verbose` transcript form). */
  verbose?: boolean;
  /** Wrap/rule width; defaults to the caller's terminal width. */
  width?: number;
}

/**
 * The incremental TTY transcript: envelope blocks and activity lines are
 * written to the sink as the harness produces them, and the final footer is
 * written exactly once by {@link LiveTranscript.foot}.
 *
 * Byte layout contract (what makes TTY output the same transcript as a pipe):
 * an envelope block is preceded by one blank row except for the first block;
 * activity rows are standalone lines with no leading blank; so dropping the
 * `· ` activity rows from the live output leaves exactly
 * {@link renderMessages}'s bytes followed by the footer block. No footer is
 * printed when the run reported no usage (`null`).
 */
export interface LiveTranscript {
  /** Render one appended envelope block immediately. */
  envelope(msg: Record<string, any>): void;
  /** Render one activity/progress row immediately (empty text is a no-op). */
  activity(text: string): void;
  /** Write the final footer once (a second call is a no-op; `null` is a no-op). */
  foot(footer: string | null): void;
  /** Envelope blocks written so far. */
  readonly envelopes: number;
  /** Activity rows written so far. */
  readonly activities: number;
}

/** Create the incremental TTY transcript writer for one run/turn. */
export function createLiveTranscript(
  sink: TranscriptSink,
  options: LiveTranscriptOptions = {},
): LiveTranscript {
  const style = options.style ?? plainCliStyle;
  const verbose = options.verbose === true;
  const width = options.width ?? terminalWidth();
  let envelopes = 0;
  let activities = 0;
  let footerPrinted = false;
  return {
    get envelopes(): number {
      return envelopes;
    },
    get activities(): number {
      return activities;
    },
    envelope(msg: Record<string, any>): void {
      const block = renderEnvelopeBlock(msg, verbose, style, width).join("\n");
      if (envelopes > 0) sink.log("");
      sink.log(block);
      envelopes += 1;
    },
    activity(text: string): void {
      const line = renderActivityLine(text, style, width);
      if (line === "") return;
      sink.log(line);
      activities += 1;
    },
    foot(footer: string | null): void {
      if (footer === null || footerPrinted) return;
      footerPrinted = true;
      sink.log("");
      sink.log(footer);
    },
  };
}
