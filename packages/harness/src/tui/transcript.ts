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
 * Tool detail is progressive: a collapsed row shows the newest result's first
 * `maxToolRows` lines (default 6) plus a `… +N more lines` marker, and a row
 * expanded by the app shows every line. Expansion state is per tool row,
 * keyed by the call id when present ({@link toolExpansionKey}), so it is
 * independent of row position and survives streaming updates of other rows.
 * The model keeps every line either way.
 */
import type {
  DecisionBlock,
  EnvelopeBlock,
  NoticeBlock,
  ToolBlock,
  TuiBlock,
  TuiModel,
  UserBlock,
} from "./model.ts";
import { renderMarkdown } from "./markdown.ts";
import { clipStyled, wrapDisplay } from "./screen.ts";
import { plainTheme, type Theme, type ThemeToken } from "./theme.ts";

/** Minimum label column for the inline transcript layout. */
export const TRANSCRIPT_LABEL_WIDTH = 8;

/** Default number of collapsed tool-result lines (and of bounded detail rows). */
export const DEFAULT_MAX_TOOL_ROWS = 6;

/** Label + semantic tone for one block. */
export interface BlockLabel {
  text: string;
  token: ThemeToken;
}

interface ContentRow {
  text: string;
  tone?: ThemeToken;
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
  /** Maximum visual rows of expanded tool detail / preview source lines (default 6). */
  maxToolRows?: number;
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
  return expanded ? { blocks, nextId: model.nextId } : model;
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
 * Tool row detail mode: `preview` (collapsed, bounded source lines),
 * `detail` (legacy `expandedTools` view, bounded visual rows) and `full`
 * (a per-row expansion: every line).
 */
type ToolRowMode = "preview" | "detail" | "full";

function previewToolRows(block: ToolBlock, maxLines: number): ContentRow[] {
  const tone = toolTone(block);
  const rows: ContentRow[] = [{ text: toolSummary(block), tone }];
  const result = block.result ?? "";
  if (result === "") return rows;
  const lines = result.split("\n");
  const shown = lines.slice(0, maxLines);
  const resultTone = tone === "error" ? "error" : "muted";
  rows.push({ text: `result: ${shown.join("\n")}`, tone: resultTone });
  const hidden = lines.length - shown.length;
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
 * Theme tone for a Markdown row that carries a unified-diff marker, or
 * undefined for ordinary rows. A marked row always repeats its sign
 * (`- -old`, `+ +new`, `@@ @@ …`), so a Markdown bullet (`- item`) never
 * matches.
 */
function diffRowTone(text: string): ThemeToken | undefined {
  if (text.startsWith("@@ @@")) return "muted";
  if (text.startsWith("- -")) return "error";
  if (text.startsWith("+ +")) return "success";
  return undefined;
}

function envelopeRows(block: EnvelopeBlock, width: number): ContentRow[] {
  const tone: ThemeToken = block.role === "junior" ? "junior" : "senior";
  // Assistant message bodies are Markdown; every other block kind stays
  // literal so user intent and tool output are never reinterpreted.
  const rows: ContentRow[] = renderMarkdown(block.text, width).map((text) => ({
    text,
    tone: diffRowTone(text) ?? tone,
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

/** Collapsed tool rows keep this many source lines before the marker. */
function toolPreviewLines(options: TranscriptOptions): number {
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
        ? previewToolRows(block, toolPreviewLines(options))
        : detailedToolRows(block);
    case "notice":
      return noticeRows(block);
    default:
      return [];
  }
}

interface VisualRow {
  text: string;
  tone?: ThemeToken;
}

function visualRows(rows: readonly ContentRow[], width: number): VisualRow[] {
  const out: VisualRow[] = [];
  for (const row of rows) {
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

function paintRow(theme: Theme, row: VisualRow, width: number): string {
  const text = row.tone === undefined ? row.text : theme.paint(row.tone, row.text);
  return clipStyled(text, width);
}

/** Render one block to rows no wider than `options.width`. */
export function renderBlock(block: TuiBlock, options: TranscriptOptions): string[] {
  const width = Math.max(0, Math.floor(options.width));
  if (width === 0) return [];
  const theme = options.theme ?? plainTheme;
  const label = labelForBlock(block);
  const compact = width <= TRANSCRIPT_LABEL_WIDTH + 8;

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
  if (rows.length === 0) return [];

  if (compact) {
    const labelLine = clipStyled(theme.paint(label.token, label.text), width);
    const out = [labelLine];
    for (const row of rows) {
      out.push(row.text === "" ? "" : paintRow(theme, row, width));
    }
    return out;
  }

  const labelCell = label.text.padEnd(TRANSCRIPT_LABEL_WIDTH, " ");
  const styledLabel = theme.paint(label.token, labelCell);
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