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
 * Long tool detail is bounded by `maxToolRows` and says how many lines were
 * hidden, while the model keeps every line.
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
  /** Show tool args/result detail (default false: compact activity rows). */
  expandedTools?: boolean;
  /** Maximum visual rows of expanded tool detail (default 6). */
  maxToolRows?: number;
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

function toolRows(block: ToolBlock, expanded: boolean): ContentRow[] {
  const tone: ThemeToken =
    block.status === "error" || block.status === "blocked" ? "error" : "tool";
  const rows: ContentRow[] = [{ text: toolSummary(block), tone }];
  if (!expanded) return rows;
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

function envelopeRows(block: EnvelopeBlock, width: number): ContentRow[] {
  const tone: ThemeToken = block.role === "junior" ? "junior" : "senior";
  // Assistant message bodies are Markdown; every other block kind stays
  // literal so user intent and tool output are never reinterpreted.
  const rows: ContentRow[] = renderMarkdown(block.text, width).map((text) => ({ text, tone }));
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

function contentRows(block: TuiBlock, options: TranscriptOptions, width: number): ContentRow[] {
  switch (block.kind) {
    case "user":
      return userRows(block);
    case "envelope":
      return envelopeRows(block, width);
    case "decision":
      return decisionRows(block);
    case "tool":
      return toolRows(block, options.expandedTools === true);
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

function boundToolRows(rows: VisualRow[], options: TranscriptOptions): VisualRow[] {
  const max = Math.max(1, Math.floor(options.maxToolRows ?? 6));
  if (rows.length <= max) return rows;
  const hidden = rows.length - (max - 1);
  return [...rows.slice(0, max - 1), { text: `… +${hidden} more lines`, tone: "dim" }];
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

  const contentWidth = compact ? width : Math.max(1, width - TRANSCRIPT_LABEL_WIDTH);
  let rows = visualRows(contentRows(block, options, contentWidth), contentWidth);
  if (block.kind === "tool" && options.expandedTools === true) {
    rows = boundToolRows(rows, options);
  }
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

function blocksOf(input: TuiModel | readonly TuiBlock[]): readonly TuiBlock[] {
  return "blocks" in input ? input.blocks : input;
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