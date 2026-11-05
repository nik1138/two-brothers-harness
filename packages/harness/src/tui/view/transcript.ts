import type { TuiModel } from "../model.ts";
import { fitStyled } from "../screen.ts";
import { renderBlock, type TranscriptOptions } from "../transcript.ts";

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
}

function positionedRows(model: TuiModel, options: TranscriptOptions): PositionedRow[] {
  const rows: PositionedRow[] = [];
  for (const block of model.blocks) {
    const rendered = renderBlock(block, options);
    if (rendered.length === 0) continue;
    if (rows.length > 0) rows.push({ blockId: block.id, text: "" });
    for (const text of rendered) rows.push({ blockId: block.id, text });
  }
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

export function homeTranscriptScroll(model: TuiModel): TranscriptScroll {
  const first = model.blocks[0];
  return first === undefined
    ? { followLatest: true }
    : { followLatest: false, anchorId: first.id, offset: 0 };
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
