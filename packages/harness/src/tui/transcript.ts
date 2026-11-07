/**
 * Role-labeled transcript view.
 *
 * Each block gets a textual label — `YOU`, `SENIOR`, `JUNIOR`, `TOOL`,
 * `ERR`/`WARN`/`INFO` — so identity survives `NO_COLOR`, color blindness and
 * redirected output. Colors are decoration on top of that, never the only
 * carrier. A decision is rendered under its role label with `decision:`,
 * `rationale:` and a separate `dissent:` line; the dissent is also colored
 * differently when color is enabled.
 *
 * The view only wraps/windows; it never shortens the model's committed text.
 * Assistant/junior/senior bodies are Markdown, so their rows carry span-level
 * emphasis from `markdownstyle.ts` (`**bold**`, `*italic*`, `` `code` ``,
 * links, headings, fences, diff markers): the row keeps its role tone and the
 * spans layer a theme emphasis on top. Under `NO_COLOR` the emphasis is the
 * identity, so every row is exactly the plain label + Markdown text.
 *
 * Tool detail is progressive: a collapsed row shows the newest result's first
 * `maxToolRows` visual rows after wrapping (default 6), plus a
 * `… +N more lines` marker; an expanded row shows every line. Expansion state
 * is per tool row,
 * keyed by the call id when present ({@link toolExpansionKey}), so it is
 * independent of row position and survives streaming updates of other rows.
 * The model keeps every line either way.
 */
import type {
  DecisionBlock,
  EnvelopeBlock,
  LiveThinking,
  NoticeBlock,
  SummaryBlock,
  ToolBlock,
  TuiBlock,
  TuiModel,
  UserBlock,
} from "./model.ts";
import {
  renderMarkdownStyled,
  styledLineText,
  styledSpansText,
  type StyledLine,
  type StyledSpan,
} from "./markdownstyle.ts";
import { clipStyled, wrapDisplay } from "./screen.ts";
import { displayWidth, wrapRuns } from "./text.ts";
import { plainTheme, type Theme, type ThemeToken } from "./theme.ts";

/** Minimum label column for the inline transcript layout. */
export const TRANSCRIPT_LABEL_WIDTH = 8;

/** Default number of collapsed tool-result visual rows (and of bounded detail rows). */
export const DEFAULT_MAX_TOOL_ROWS = 6;

/** Label of the live reasoning block (exactly the 8-cell label gutter). */
export const THINKING_LABEL = "THINKING";

/** Default visible reasoning rows before the `… +N lines` marker. */
export const DEFAULT_THINKING_MAX_ROWS = 6;

/** Label of the compaction-summary marker block (never the operator). */
export const SUMMARY_LABEL = "SUMMARY";

/** Default visible preview rows of a compaction-summary block. */
export const DEFAULT_SUMMARY_MAX_ROWS = 3;

/** Options for {@link renderThinkingBlock}. */
export interface ThinkingRenderOptions {
  width: number;
  theme?: Theme;
  /** Visible reasoning rows (default {@link DEFAULT_THINKING_MAX_ROWS}). */
  maxRows?: number;
}

/** Label + semantic tone for one block. */
export interface BlockLabel {
  text: string;
  token: ThemeToken;
}

interface ContentRow {
  text: string;
  tone?: ThemeToken;
  /**
   * Inline emphasis runs (already wrapped to the content width); `text` is
   * exactly their concatenation, so the plain join is the NO_COLOR row.
   */
  spans?: readonly StyledSpan[];
}

/** The textual label for a block (always present, color-independent). */
export function labelForBlock(block: TuiBlock): BlockLabel {
  switch (block.kind) {
    case "user":
      return { text: "YOU", token: "user" };
    case "envelope":
      return {
        text: block.role === "junior" ? "JUNIOR" : "SENIOR",
        token: block.role === "junior" ? "junior" : "senior",
      };
    case "decision":
      return { text: "SENIOR", token: "decision" };
    case "tool":
      return { text: "TOOL", token: "tool" };
    case "notice":
      return block.level === "error"
        ? { text: "ERR", token: "error" }
        : block.level === "warn"
          ? { text: "WARN", token: "warning" }
          : { text: "INFO", token: "notice" };
    case "summary":
      // A compaction summary is machine context: dim system marker, never YOU.
      return { text: SUMMARY_LABEL, token: "dim" };
    default:
      return { text: "SYS", token: "text" };
  }
}

/** Options for {@link renderTranscript} and {@link renderBlock}. */
export interface TranscriptOptions {
  width: number;
  theme?: Theme;
  /** Show tool args/result detail (default false: collapsed result preview). */
  expandedTools?: boolean;
  /** Maximum visual rows of expanded tool detail / collapsed result preview (default 6). */
  maxToolRows?: number;
  /** Maximum visual rows of a compaction-summary preview (default 3). */
  maxSummaryRows?: number;
  /**
   * Block id to mark in the label gutter with `▸` (find's active match). The
   * marker replaces the label's trailing padding cell, so every row keeps its
   * exact width and NO_COLOR output still carries the distinction.
   */
  activeBlockId?: string;
}

/**
 * Expansion keys of tool rows shown in full: `call:<callId>` when the row has
 * a call id, else `block:<blockId>`. See {@link toolExpansionKey}.
 */
export type ToolExpansionKeys = ReadonlySet<string>;

/** One Ctrl+T-equivalent toggle result, pure and order-independent. */
export interface ToolExpansionToggle {
  /** The next key set (the input set when there is no tool row). */
  keys: ToolExpansionKeys;
  /** The toggled row's key, or null when the model has no tool row. */
  key: string | null;
  /** True when the toggled row is now expanded. */
  expanded: boolean;
}

/**
 * Stable expansion key for one tool row. The call id is preferred because it
 * survives pairing the result into the call block; a row without one falls
 * back to its document id, which never changes either.
 */
export function toolExpansionKey(block: ToolBlock): string {
  return block.callId !== undefined && block.callId !== ""
    ? `call:${block.callId}`
    : `block:${block.id}`;
}

function blocksOf(input: TuiModel | readonly TuiBlock[]): readonly TuiBlock[] {
  return "blocks" in input ? input.blocks : input;
}

/** The newest tool row in the transcript, or undefined when there is none. */
export function newestToolBlock(input: TuiModel | readonly TuiBlock[]): ToolBlock | undefined {
  const blocks = blocksOf(input);
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (block !== undefined && block.kind === "tool") return block;
  }
  return undefined;
}

/**
 * Toggle full expansion of the newest tool row. Purely functional: the input
 * set is never mutated, and a keyed row stays expanded across unrelated model
 * updates because the key does not depend on row position or order.
 */
export function toggleNewestToolExpansion(
  input: TuiModel | readonly TuiBlock[],
  keys: ToolExpansionKeys,
): ToolExpansionToggle {
  const newest = newestToolBlock(input);
  if (newest === undefined) return { keys, key: null, expanded: false };
  const key = toolExpansionKey(newest);
  const next = new Set(keys);
  const expanded = !next.has(key);
  if (expanded) next.add(key);
  else next.delete(key);
  return { keys: next, key, expanded };
}

/**
 * Blocks registered here render their tool detail in full (no `maxToolRows`
 * bound). A weak side table keeps {@link withToolExpansion} from mutating the
 * model or widening {@link ToolBlock}: the derived blocks disappear with the
 * derived model and never leak into other renders.
 */
const expandedToolRows = new WeakSet<ToolBlock>();

/**
 * Derive a model whose expanded tool rows render in full. Only rows whose
 * {@link toolExpansionKey} is in `keys` are cloned; every other block is
 * shared with the input, and an empty/unmatched key set returns the input
 * model itself.
 */
export function withToolExpansion(model: TuiModel, keys: ToolExpansionKeys): TuiModel {
  if (keys.size === 0) return model;
  let expanded = false;
  const blocks = model.blocks.map((block) => {
    if (block.kind !== "tool" || !keys.has(toolExpansionKey(block))) return block;
    const clone: ToolBlock = { ...block };
    expandedToolRows.add(clone);
    expanded = true;
    return clone;
  });
  return expanded ? { ...model, blocks } : model;
}

function toolSummary(block: ToolBlock): string {
  const status =
    block.status === "call"
      ? "running"
      : block.status === "ok"
        ? "ok"
        : block.status === "blocked"
          ? "blocked"
          : "error";
  return `${block.role} · ${block.tool} — ${status}`;
}

function toolTone(block: ToolBlock): ThemeToken {
  return block.status === "error" || block.status === "blocked" ? "error" : "tool";
}

/**
 * Tool row detail mode: `preview` (collapsed, bounded visual rows),
 * `detail` (legacy `expandedTools` view, bounded visual rows) and `full`
 * (a per-row expansion: every line).
 */
type ToolRowMode = "preview" | "detail" | "full";

function previewToolRows(block: ToolBlock, maxRows: number, width: number): ContentRow[] {
  const tone = toolTone(block);
  const rows: ContentRow[] = [{ text: toolSummary(block), tone }];
  const result = block.result ?? "";
  if (result === "") return rows;
  // As in pi's visual-truncate component, wrap first so one long logical line
  // cannot consume the whole screen and the marker counts actual hidden rows.
  const visual = wrapDisplay(`result: ${result}`, width);
  const shown = visual.slice(0, maxRows);
  const resultTone = tone === "error" ? "error" : "muted";
  for (const text of shown) rows.push({ text, tone: resultTone });
  const hidden = visual.length - shown.length;
  if (hidden > 0) rows.push({ text: `… +${hidden} more lines`, tone: "dim" });
  return rows;
}

function detailedToolRows(block: ToolBlock): ContentRow[] {
  const tone = toolTone(block);
  const rows: ContentRow[] = [{ text: toolSummary(block), tone }];
  if (block.callId !== undefined) rows.push({ text: `call: ${block.callId}`, tone: "muted" });
  if (block.args !== undefined && block.args !== "") {
    rows.push({ text: `args: ${block.args}`, tone: "dim" });
  }
  if (block.result !== undefined && block.result !== "") {
    rows.push({
      text: `result: ${block.result}`,
      tone: block.status === "error" || block.status === "blocked" ? "error" : "muted",
    });
  }
  return rows;
}

function decisionRows(block: DecisionBlock): ContentRow[] {
  const rows: ContentRow[] = [{ text: `decision: ${block.text}`, tone: "decision" }];
  if (block.rationale !== undefined && block.rationale.trim() !== "") {
    rows.push({ text: `rationale: ${block.rationale}`, tone: "muted" });
  }
  if (block.confidence !== undefined && block.confidence.trim() !== "") {
    rows.push({ text: `confidence: ${block.confidence}`, tone: "muted" });
  }
  if (block.dissent !== undefined && block.dissent.trim() !== "") {
    rows.push({ text: `dissent: ${block.dissent}`, tone: "dissent" });
  }
  return rows;
}

/**
 * Theme tone for one styled Markdown row. Fence labels and code rows get the
 * muted "code" treatment, rules the border tone, and a unified-diff row its
 * diff tone: a marked row's first span is the structural `marker` span (`- `,
 * `+ `, `@@ `), so the tone is read from structure instead of re-parsing the
 * flattened text. Every other row keeps the role's tone.
 */
function styledRowTone(line: StyledLine, base: ThemeToken): ThemeToken {
  switch (line.kind) {
    case "fenceOpen":
    case "fenceClose":
    case "code":
      return "muted";
    case "rule":
      return "border";
    case "diff": {
      const marker = line.spans[0];
      if (marker === undefined || marker.style !== "marker") return base;
      if (marker.text === "@@ ") return "muted";
      if (marker.text === "- ") return "error";
      if (marker.text === "+ ") return "success";
      return base;
    }
    default:
      return base;
  }
}

/**
 * Give a row's structural kinds their emphasis: headings and fence labels are
 * bold, while an explicit inline style (code, link, marker) keeps its own
 * treatment. Rows are already wrapped, so this never changes the text width.
 */
function emphasizedSpans(line: StyledLine): readonly StyledSpan[] {
  const emphasis =
    line.kind === "heading" || line.kind === "fenceOpen" || line.kind === "fenceClose"
      ? "bold"
      : undefined;
  if (emphasis === undefined) return line.spans;
  return line.spans.map((span) =>
    span.style === undefined ? { text: span.text, style: emphasis } : span,
  );
}

function envelopeRows(block: EnvelopeBlock, width: number): ContentRow[] {
  const tone: ThemeToken = block.role === "junior" ? "junior" : "senior";
  // Assistant message bodies are Markdown; every other block kind stays
  // literal so user intent and tool output are never reinterpreted.
  const rows: ContentRow[] = renderMarkdownStyled(block.text, width).map((line) => ({
    text: styledLineText(line),
    tone: styledRowTone(line, tone),
    spans: emphasizedSpans(line),
  }));
  if (block.interrupted === true) {
    rows.push({ text: "[interrupted — partial reply]", tone: "warning" });
  }
  return rows;
}

function noticeRows(block: NoticeBlock): ContentRow[] {
  const tone: ThemeToken =
    block.level === "error" ? "error" : block.level === "warn" ? "warning" : "notice";
  const rows: ContentRow[] = [{ text: block.text, tone }];
  if (block.details !== undefined && block.details.trim() !== "") {
    rows.push({ text: `details: ${block.details}`, tone: "dim" });
  }
  if (block.retryable === true) rows.push({ text: "retry: available", tone: "muted" });
  return rows;
}

function userRows(block: UserBlock): ContentRow[] {
  return [{ text: block.text, tone: "user" }];
}

/**
 * A compaction-summary marker: the neutral "context compacted" row plus the
 * bounded preview. Dim/muted only; it can never render as an operator block.
 */
function summaryRows(block: SummaryBlock): ContentRow[] {
  const rows: ContentRow[] = [{ text: "context compacted", tone: "dim" }];
  if (block.preview !== "") rows.push({ text: block.preview, tone: "muted" });
  return rows;
}

/** Visible preview rows of a summary block (default 3). */
function summaryRowLimit(options: TranscriptOptions): number {
  return Math.max(1, Math.floor(options.maxSummaryRows ?? DEFAULT_SUMMARY_MAX_ROWS));
}

/** Collapsed tool results keep this many visual rows before the marker. */
function toolPreviewRows(options: TranscriptOptions): number {
  return Math.max(1, Math.floor(options.maxToolRows ?? DEFAULT_MAX_TOOL_ROWS));
}

function contentRows(
  block: TuiBlock,
  options: TranscriptOptions,
  width: number,
  toolMode: ToolRowMode | null,
): ContentRow[] {
  switch (block.kind) {
    case "user":
      return userRows(block);
    case "envelope":
      return envelopeRows(block, width);
    case "decision":
      return decisionRows(block);
    case "tool":
      return toolMode === "preview"
        ? previewToolRows(block, toolPreviewRows(options), width)
        : detailedToolRows(block);
    case "notice":
      return noticeRows(block);
    case "summary":
      return summaryRows(block);
    default:
      return [];
  }
}

interface VisualRow {
  text: string;
  tone?: ThemeToken;
  spans?: readonly StyledSpan[];
}

function visualRows(rows: readonly ContentRow[], width: number): VisualRow[] {
  const out: VisualRow[] = [];
  for (const row of rows) {
    if (row.spans !== undefined) {
      // Markdown rows arrive already wrapped to `width`; only re-wrap an
      // over-wide styled row so styling is never lost to a plain wrap.
      if (displayWidth(row.text) <= width) {
        out.push({ text: row.text, tone: row.tone, spans: row.spans });
        continue;
      }
      for (const spans of wrapRuns(row.spans, width)) {
        out.push({ text: styledSpansText(spans), tone: row.tone, spans });
      }
      continue;
    }
    const wrapped = wrapDisplay(row.text, width);
    for (const line of wrapped) {
      out.push(row.tone === undefined ? { text: line } : { text: line, tone: row.tone });
    }
  }
  return out;
}

/**
 * Bound the bounded (`expandedTools`) detail view: keep `maxToolRows` content
 * rows and append the `… +N more lines` marker as an extra row. A per-row
 * expanded view never reaches this function, so it keeps every line.
 */
function boundToolRows(rows: VisualRow[], options: TranscriptOptions): VisualRow[] {
  const max = Math.max(1, Math.floor(options.maxToolRows ?? DEFAULT_MAX_TOOL_ROWS));
  if (rows.length <= max) return rows;
  const hidden = rows.length - max;
  return [...rows.slice(0, max), { text: `… +${hidden} more lines`, tone: "dim" }];
}

/**
 * Bound the compaction-summary preview: keep the marker row plus at most
 * `maxSummaryRows` preview rows and collapse the rest into one dim
 * `… +N lines` row, so a long summary can never flood the live transcript.
 */
function boundSummaryRows(rows: VisualRow[], options: TranscriptOptions): VisualRow[] {
  const max = Math.max(1, Math.floor(options.maxSummaryRows ?? DEFAULT_SUMMARY_MAX_ROWS));
  if (rows.length <= max) return rows;
  const hidden = rows.length - max;
  return [...rows.slice(0, max), { text: `… +${hidden} lines`, tone: "dim" }];
}

/**
 * Paint the row's base tone under the spans' inline emphasis. With
 * `plainTheme` every call is the identity, so the joined text is exactly the
 * plain row; a color theme emits one open/reset pair per span and no escape
 * ever escapes the theme layer.
 */
function paintSpans(theme: Theme, token: ThemeToken, spans: readonly StyledSpan[]): string {
  let text = "";
  for (const span of spans) text += theme.paintEmphasis(token, span.style, span.text);
  return text;
}

function paintRow(theme: Theme, row: VisualRow, width: number): string {
  const text =
    row.spans === undefined
      ? row.tone === undefined
        ? row.text
        : theme.paint(row.tone, row.text)
      : paintSpans(theme, row.tone ?? "text", row.spans);
  return clipStyled(text, width);
}

/**
 * Render the live reasoning (thinking) block shown above the streaming
 * response while a provider call runs.
 *
 * The block reuses the transcript's label gutter (`THINKING` is exactly the
 * 8-cell label), wraps with the same grapheme/width helpers as every other
 * row, and is deliberately compact: only the last `maxRows` content rows are
 * visible, older ones collapse into one explicit `… +N lines` marker, and a
 * trailing `…` row marks reasoning that is still arriving (`streaming`). The
 * text is painted through the theme only (dim label/markers, muted body), so
 * `NO_COLOR` output is the same readable rows without a single escape byte.
 * Rows are guaranteed no wider than `options.width` and never padded.
 */
export function renderThinkingBlock(
  thinking: LiveThinking,
  options: ThinkingRenderOptions,
): string[] {
  const width = Math.max(0, Math.floor(options.width));
  if (width === 0) return [];
  const theme = options.theme ?? plainTheme;
  const compact = width <= TRANSCRIPT_LABEL_WIDTH + 8;
  // The label fills the whole 8-cell gutter, so the live block keeps one
  // separator cell before its content to stay readable in NO_COLOR output.
  const gutters = compact ? 0 : 1;
  const contentWidth = compact ? width : Math.max(1, width - TRANSCRIPT_LABEL_WIDTH - gutters);
  const maxRows = Math.max(1, Math.floor(options.maxRows ?? DEFAULT_THINKING_MAX_ROWS));
  const allRows = wrapDisplay(thinking.text, contentWidth);
  const hidden = Math.max(0, allRows.length - maxRows);
  const visible = hidden > 0 ? allRows.slice(allRows.length - maxRows) : allRows;

  const rows: ContentRow[] = [];
  if (hidden > 0) rows.push({ text: `… +${hidden} lines`, tone: "dim" });
  for (const row of visible) rows.push({ text: row, tone: "muted" });
  if (thinking.streaming) rows.push({ text: "…", tone: "dim" });
  if (rows.length === 0) return [];

  if (compact) {
    const out = [clipStyled(theme.paint("dim", THINKING_LABEL), width)];
    for (const row of rows) {
      out.push(row.text === "" ? "" : clipStyled(theme.paint(row.tone ?? "text", row.text), width));
    }
    return out;
  }
  const out: string[] = [];
  const continuation = " ".repeat(TRANSCRIPT_LABEL_WIDTH + gutters);
  rows.forEach((row, index) => {
    const prefix =
      index === 0
        ? theme.paint("dim", THINKING_LABEL) + " ".repeat(gutters)
        : continuation;
    const text = row.text === "" ? "" : clipStyled(theme.paint(row.tone ?? "text", row.text), contentWidth);
    out.push(prefix + text);
  });
  return out;
}

/** Render one block to rows no wider than `options.width`. */
export function renderBlock(block: TuiBlock, options: TranscriptOptions): string[] {
  const width = Math.max(0, Math.floor(options.width));
  if (width === 0) return [];
  const theme = options.theme ?? plainTheme;
  const label = labelForBlock(block);
  const compact = width <= TRANSCRIPT_LABEL_WIDTH + 8;
  const active = options.activeBlockId !== undefined && options.activeBlockId === block.id;

  // A per-row expanded tool row wins over the legacy `expandedTools` detail
  // view; without either, the row renders a collapsed result preview.
  const toolMode: ToolRowMode | null =
    block.kind === "tool"
      ? expandedToolRows.has(block)
        ? "full"
        : options.expandedTools === true
          ? "detail"
          : "preview"
      : null;

  const contentWidth = compact ? width : Math.max(1, width - TRANSCRIPT_LABEL_WIDTH);
  let rows = visualRows(contentRows(block, options, contentWidth, toolMode), contentWidth);
  if (toolMode === "detail") rows = boundToolRows(rows, options);
  if (block.kind === "summary") rows = boundSummaryRows(rows, options);
  if (rows.length === 0) return [];

  if (compact) {
    const labelText = active ? `▸${label.text}` : label.text;
    const labelLine = clipStyled(theme.paint(label.token, labelText), width);
    const out = [labelLine];
    for (const row of rows) {
      out.push(row.text === "" ? "" : paintRow(theme, row, width));
    }
    return out;
  }

  const labelCell = active
    ? label.text.padEnd(Math.max(0, TRANSCRIPT_LABEL_WIDTH - 1), " ")
    : label.text.padEnd(TRANSCRIPT_LABEL_WIDTH, " ");
  const styledLabel = active
    ? theme.paint("focus", "▸") + theme.paint(label.token, labelCell)
    : theme.paint(label.token, labelCell);
  const continuation = " ".repeat(TRANSCRIPT_LABEL_WIDTH);
  const out: string[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row === undefined) continue;
    const prefix = index === 0 ? styledLabel : continuation;
    out.push(prefix + paintRow(theme, row, contentWidth));
  }
  return out;
}

/**
 * Render the whole transcript. Blocks are separated by one blank row; the
 * result has no trailing blank row. All rows are within `options.width`.
 */
export function renderTranscript(
  input: TuiModel | readonly TuiBlock[],
  options: TranscriptOptions,
): string[] {
  const width = Math.max(0, Math.floor(options.width));
  if (width === 0) return [];
  const out: string[] = [];
  for (const block of blocksOf(input)) {
    const rows = renderBlock(block, { ...options, width });
    if (rows.length === 0) continue;
    if (out.length > 0) out.push("");
    out.push(...rows);
  }
  return out;
}