import { isStreamingBlock, type TuiModel } from "../model.ts";
import { fitStyled } from "../screen.ts";
import {
  TRANSCRIPT_LABEL_WIDTH,
  markTopSliceRow,
  renderBlock,
  renderThinkingBlock,
  type TranscriptOptions,
} from "../transcript.ts";
import { plainTheme } from "../theme.ts";
import {
  REPLAYED_REASONING_BLOCK_ID,
  renderReplayedReasoning,
  type ReplayedReasoningBlock,
} from "./reasoning.ts";

/** Stable pseudo block id of the live reasoning rows (never a document block). */
export const LIVE_THINKING_BLOCK_ID = "live-thinking";

/** A stable viewport position. `followLatest` pins the view to the newest row. */
export interface TranscriptScroll {
  followLatest: boolean;
  anchorId?: string;
  /** Wrapped row offset within the anchor block. */
  offset?: number;
}

export interface TranscriptViewOptions extends TranscriptOptions {
  height: number;
  scroll?: TranscriptScroll;
  /**
   * Read-only replayed reasoning records (session runtime sidecar), rendered as
   * a dim `THINKING (replayed)` section above the transcript blocks in sidecar
   * order. Omitted or empty renders the exact pre-replay frame.
   */
  replayedReasoning?: readonly ReplayedReasoningBlock[];
  /** Records the bounded loader left out (one honest leading marker row). */
  hiddenReplayedReasoning?: number;
}

export interface TranscriptView {
  lines: string[];
  scroll: TranscriptScroll;
  startRow: number;
  totalRows: number;
  atLatest: boolean;
  visibleBlockIds: string[];
}

interface PositionedRow {
  blockId: string;
  text: string;
  /** True for the blank row that separates a block from the one above it. */
  separator?: boolean;
}

/**
 * Position block rows in document order, splicing the live reasoning rows in
 * just above the active streaming response block (or at the very end when the
 * response has not started yet). Thinking is live-only, so it never changes
 * the block document: it is an extra row group anchored by
 * {@link LIVE_THINKING_BLOCK_ID}, separated by the usual blank row.
 *
 * Replayed reasoning (the session sidecar's persisted records) is a read-only
 * prefix section anchored by {@link REPLAYED_REASONING_BLOCK_ID}: those rows
 * come from the view option, never from the model, so an omitted/empty option
 * produces the exact pre-replay rows.
 */
function positionedRows(model: TuiModel, options: TranscriptViewOptions): PositionedRow[] {
  const rows: PositionedRow[] = [];
  const blocks = model.blocks;
  const thinking = model.liveThinking;
  const replayed = options.replayedReasoning ?? [];
  if (replayed.length > 0) {
    const rendered = renderReplayedReasoning(replayed, {
      width: options.width,
      ...(options.theme !== undefined ? { theme: options.theme } : {}),
      ...(options.hiddenReplayedReasoning !== undefined
        ? { hiddenRecords: options.hiddenReplayedReasoning }
        : {}),
    });
    for (const text of rendered) {
      // Blank rows between replayed records are separators, not content: the
      // top-slice marker must never treat one as a hidden continuation row.
      rows.push({
        blockId: REPLAYED_REASONING_BLOCK_ID,
        text,
        ...(text === "" ? { separator: true } : {}),
      });
    }
  }
  const last = blocks[blocks.length - 1];
  const streamingLastIndex =
    last !== undefined && thinking !== undefined && isStreamingBlock(last) ? blocks.length - 1 : -1;
  let thinkingInserted = false;
  const insertThinking = (): void => {
    thinkingInserted = true;
    if (thinking === undefined) return;
    const rendered = renderThinkingBlock(thinking, {
      width: options.width,
      ...(options.theme !== undefined ? { theme: options.theme } : {}),
    });
    if (rendered.length === 0) return;
    if (rows.length > 0) rows.push({ blockId: LIVE_THINKING_BLOCK_ID, text: "", separator: true });
    for (const text of rendered) rows.push({ blockId: LIVE_THINKING_BLOCK_ID, text });
  };
  blocks.forEach((block, index) => {
    if (index === streamingLastIndex) insertThinking();
    const rendered = renderBlock(block, options);
    if (rendered.length === 0) return;
    if (rows.length > 0) rows.push({ blockId: block.id, text: "", separator: true });
    for (const text of rendered) rows.push({ blockId: block.id, text });
  });
  if (!thinkingInserted) insertThinking();
  return rows;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.floor(value), min), max);
}

function startFor(rows: readonly PositionedRow[], height: number, scroll: TranscriptScroll): number {
  const latest = Math.max(0, rows.length - height);
  if (scroll.followLatest || scroll.anchorId === undefined) return latest;
  const anchor = rows.findIndex((row) => row.blockId === scroll.anchorId);
  if (anchor === -1) return latest;
  return clamp(anchor + (scroll.offset ?? 0), 0, latest);
}

function scrollFor(rows: readonly PositionedRow[], start: number, height: number): TranscriptScroll {
  if (rows.length === 0 || start >= Math.max(0, rows.length - height)) return { followLatest: true };
  const row = rows[start];
  if (row === undefined) return { followLatest: true };
  const anchor = rows.findIndex((candidate) => candidate.blockId === row.blockId);
  return { followLatest: false, anchorId: row.blockId, offset: Math.max(0, start - anchor) };
}

export function latestTranscriptScroll(): TranscriptScroll {
  return { followLatest: true };
}

/**
 * Anchor the viewport on one block: its first rendered row becomes the top row
 * when there is content after it, and the model clamps to the newest rows when
 * the block is near the end. Used by find navigation to bring the active
 * match's block on screen without leaving the block-anchored scroll model.
 */
export function scrollToBlock(blockId: string): TranscriptScroll {
  return { followLatest: false, anchorId: blockId, offset: 0 };
}

export function homeTranscriptScroll(
  model: TuiModel,
  replayedReasoning?: readonly ReplayedReasoningBlock[],
): TranscriptScroll {
  // A replayed-reasoning section is the document's first content when present.
  if (replayedReasoning !== undefined && replayedReasoning.length > 0) {
    return { followLatest: false, anchorId: REPLAYED_REASONING_BLOCK_ID, offset: 0 };
  }
  const first = model.blocks[0];
  return first === undefined
    ? { followLatest: true }
    : { followLatest: false, anchorId: first.id, offset: 0 };
}

/**
 * True when the viewport's top row continues a block whose label row is above
 * the window: the row shares its block with the row before it and neither is
 * the blank separator. A window that starts on a separator still shows the next
 * block's label row, so it does not count as a cut.
 */
function startsMidBlock(rows: readonly PositionedRow[], start: number): boolean {
  if (start <= 0 || start >= rows.length) return false;
  const row = rows[start];
  const previous = rows[start - 1];
  if (row === undefined || previous === undefined) return false;
  if (row.separator === true || previous.separator === true) return false;
  return row.blockId === previous.blockId;
}

/** Render a fixed-height window anchored by block identity across resize. */
export function transcriptView(model: TuiModel, options: TranscriptViewOptions): TranscriptView {
  const width = Math.max(0, Math.floor(options.width));
  const height = Math.max(0, Math.floor(options.height));
  const rows = width === 0 ? [] : positionedRows(model, options);
  const requested = options.scroll ?? latestTranscriptScroll();
  const start = height === 0 ? 0 : startFor(rows, height, requested);
  const visible = rows.slice(start, start + height);
  const lines = visible.map((row) => fitStyled(row.text, width));
  // A window that starts inside a block marks the hidden label row in the
  // gutter, so the top row is not mistaken for the start of the block. Compact
  // rows have no gutter, so the marker only exists in the inline layout.
  // Replayed reasoning rows do not use the transcript gutter (their header is
  // a full-width dim row), so a window starting inside that section is left
  // alone instead of replacing its content prefix.
  const topRow = rows[start];
  if (
    lines.length > 0 &&
    width > TRANSCRIPT_LABEL_WIDTH + 8 &&
    topRow !== undefined &&
    topRow.blockId !== REPLAYED_REASONING_BLOCK_ID &&
    startsMidBlock(rows, start)
  ) {
    lines[0] = markTopSliceRow(lines[0] ?? "", width, options.theme ?? plainTheme);
  }
  while (lines.length < height) lines.push(" ".repeat(width));
  const scroll = scrollFor(rows, start, height);
  return {
    lines,
    scroll,
    startRow: start,
    totalRows: rows.length,
    atLatest: scroll.followLatest,
    visibleBlockIds: [...new Set(visible.map((row) => row.blockId))],
  };
}

/** Move by visual rows and return a stable anchor for the next render. */
export function scrollTranscript(
  model: TuiModel,
  scroll: TranscriptScroll,
  delta: number,
  options: TranscriptViewOptions,
): TranscriptScroll {
  const current = transcriptView(model, { ...options, scroll });
  const target = clamp(current.startRow + (Number.isFinite(delta) ? delta : 0), 0, Math.max(0, current.totalRows - Math.max(0, Math.floor(options.height))));
  const rows = positionedRows(model, options);
  return scrollFor(rows, target, Math.max(0, Math.floor(options.height)));
}

export function renderTranscriptWindow(model: TuiModel, options: TranscriptViewOptions): string[] {
  return transcriptView(model, options).lines;
}
