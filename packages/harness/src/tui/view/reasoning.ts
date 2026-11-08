/**
 * Replayed reasoning rows for the TUI transcript (read-only, bounded).
 *
 * The web replays persisted reasoning as a collapsed "Thinking · replayed" row;
 * the TUI shows the same session-sidecar records as one small block per record
 * on load/resume/switch: a dim `THINKING (replayed)` header naming the brother
 * and the node kind, then a bounded preview of the sanitized text. The records
 * come from `reasoningPersist.ts` (never written by the TUI), in the sidecar's
 * append order, and the loader keeps only the newest bounded set.
 *
 * Shape (each row no wider than `width` cells):
 *
 *     THINKING (replayed) · SENIOR · consult
 *       <first wrapped preview row>
 *       …
 *       … +N lines
 *
 * Choices, documented: the preview shows the BEGINNING of the reasoning (the
 * replay reads in its natural direction and the block is a bounded glance, not
 * the full text — there is no expansion affordance for replay), the first
 * {@link REPLAYED_REASONING_MAX_ROWS} visual rows are kept and the rest collapse
 * into one dim `… +N lines` marker, and a record the backend (or the loader)
 * clipped ends with an honest `… clipped for length` marker. Every byte goes
 * through the theme (`dim` header/markers, `muted` body): `plainTheme` /
 * `NO_COLOR` output is the same readable rows with no escape byte.
 */
import type { TuiRole } from "../model.ts";
import { clipDisplay, wrapDisplay } from "../screen.ts";
import { plainTheme, type Theme } from "../theme.ts";

/** Synthetic transcript block id of the whole replayed reasoning section. */
export const REPLAYED_REASONING_BLOCK_ID = "replayed-reasoning";

/** Header label; the exact, honest wording of the replayed block. */
export const REPLAYED_REASONING_LABEL = "THINKING (replayed)";

/** Visible preview rows per replayed record before the `… +N lines` marker. */
export const REPLAYED_REASONING_MAX_ROWS = 4;

/** Left indent (cells) of the preview rows under the header. */
export const REPLAYED_REASONING_INDENT = 2;

/** One replayed record the view renders (see `reasoningPersist.ts`). */
export interface ReplayedReasoningBlock {
  role: TuiRole;
  kind: string;
  text: string;
  truncated: boolean;
}

/** Render options for one replayed block or the whole section. */
export interface ReplayedReasoningRenderOptions {
  /** Terminal width; every row is at most this many cells. */
  width: number;
  theme?: Theme;
  /** Visible preview rows (default {@link REPLAYED_REASONING_MAX_ROWS}). */
  maxRows?: number;
}

/** The section-level marker count: records the loader's bound left out. */
export interface ReplayedReasoningSectionOptions extends ReplayedReasoningRenderOptions {
  /** Records hidden before the rendered ones (rendered as one honest marker). */
  hiddenRecords?: number;
}

/** `THINKING (replayed) · SENIOR · consult` — always names the speaker. */
export function replayedReasoningHeader(block: ReplayedReasoningBlock): string {
  const role = block.role === "junior" ? "JUNIOR" : "SENIOR";
  const kind = block.kind.trim();
  return kind === ""
    ? `${REPLAYED_REASONING_LABEL} · ${role}`
    : `${REPLAYED_REASONING_LABEL} · ${role} · ${kind}`;
}

/**
 * Render one replayed reasoning record: the dim header, the bounded preview and
 * the honest markers. A zero width renders nothing, and every returned row is
 * no wider than `width` (the caller pads/fits the frame), so a CJK/emoji-heavy
 * record cannot break the layout.
 */
export function renderReplayedReasoningBlock(
  block: ReplayedReasoningBlock,
  options: ReplayedReasoningRenderOptions,
): string[] {
  const width = Number.isFinite(options.width) ? Math.max(0, Math.floor(options.width)) : 0;
  if (width === 0) return [];
  const theme = options.theme ?? plainTheme;
  const maxRows = Math.max(
    1,
    Math.floor(Number.isFinite(options.maxRows) ? (options.maxRows as number) : REPLAYED_REASONING_MAX_ROWS),
  );
  const rows: string[] = [theme.paint("dim", clipDisplay(replayedReasoningHeader(block), width))];
  const indent = " ".repeat(Math.min(REPLAYED_REASONING_INDENT, width));
  const textWidth = Math.max(1, width - indent.length);
  const visual = wrapDisplay(block.text, textWidth);
  const shown = visual.slice(0, maxRows);
  for (const row of shown) {
    rows.push(theme.paint("muted", indent + row));
  }
  const hidden = visual.length - shown.length;
  if (hidden > 0) rows.push(theme.paint("dim", clipDisplay(`… +${hidden} lines`, width)));
  if (block.truncated) {
    rows.push(theme.paint("dim", clipDisplay("… clipped for length", width)));
  }
  return rows;
}

/**
 * Render the replayed reasoning section: one block per record in sidecar order,
 * separated by one blank row, with a leading honest marker when the loader's
 * block bound hid earlier records. Returns [] for an empty replay, so callers
 * (and frames) stay byte-identical when a session has no persisted reasoning.
 */
export function renderReplayedReasoning(
  blocks: readonly ReplayedReasoningBlock[],
  options: ReplayedReasoningSectionOptions,
): string[] {
  const width = Number.isFinite(options.width) ? Math.max(0, Math.floor(options.width)) : 0;
  if (width === 0 || blocks.length === 0) return [];
  const theme = options.theme ?? plainTheme;
  const hiddenRecords = Number.isFinite(options.hiddenRecords)
    ? Math.max(0, Math.floor(options.hiddenRecords as number))
    : 0;
  const rows: string[] = [];
  if (hiddenRecords > 0) {
    rows.push(
      theme.paint(
        "dim",
        clipDisplay(`… +${hiddenRecords} earlier reasoning records`, width),
      ),
    );
  }
  blocks.forEach((block, index) => {
    if (rows.length > 0) rows.push("");
    rows.push(...renderReplayedReasoningBlock(block, options));
    if (index === blocks.length - 1 && rows[rows.length - 1] === "") rows.pop();
  });
  return rows;
}
