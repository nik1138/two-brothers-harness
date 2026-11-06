/**
 * Pure find-in-transcript state, key reducer and one-line find bar.
 *
 * Ctrl+F opens a compact bar between the composer and the status bar; typing
 * filters the whole transcript live and case-insensitively, Enter/Down and
 * Shift+Enter/Up walk the matches with wrap-around, and Escape closes the bar.
 * The bar never touches the composer, the session or the transcript document:
 * it holds an immutable snapshot of the searchable block texts, and a pure
 * result says which block the active match belongs to so the app can scroll
 * that block into view. A streaming draft is searchable as its current text.
 *
 * Matching is literal (never a regular expression), case-insensitive by
 * lowercasing grapheme clusters — so a query made of emoji ZWJ sequences,
 * combining marks or CJK text can never be split mid-character — and the
 * matches are non-overlapping, left-to-right occurrences. `blockText` is the
 * canonical per-block text (`model.ts`), so a match offset always maps back to
 * one block even when that block is not currently visible on screen.
 *
 * The result list is capped ({@link DEFAULT_FIND_MAX_MATCHES}); the scan keeps
 * counting so the counter can honestly say `1/500 +312`. There is no I/O and
 * no raw escape sequence: the bar is deterministic plain text (defaulting to
 * `plainTheme`), exactly one row of exactly `width` cells, with the active
 * match marked `«like this»` — the NO_COLOR-safe carrier — and its cells
 * exposed as {@link FindBarView.activeSpan} for a theme-aware caller. A color
 * theme additionally inverts the marked span through `Theme`; the structural
 * marker is always there.
 */
import { graphemes } from "../editor.ts";
import {
  findCommand,
  formatChord,
  resolveKey,
  TUI_COMMANDS,
  type KeyLike,
  type TuiCommand,
} from "../keymap.ts";
import { blockText, type TuiModel } from "../model.ts";
import { sanitizeDisplayText } from "../screen.ts";
import { displayWidth, padToWidth, truncateToWidth } from "../text.ts";
import { plainTheme, type Theme, type ThemeToken } from "../theme.ts";
import { dropLastGrapheme, printableKeyText, viewPad, viewTruncate } from "./palette.ts";

/** Stored match list cap; the scan keeps counting past it. */
export const DEFAULT_FIND_MAX_MATCHES = 500;

/** Graphemes of block text kept on each side of the active match. */
const FIND_PREVIEW_CONTEXT = 24;

/** Below this many cells the preview is dropped (counter/hints win). */
const FIND_PREVIEW_MIN_WIDTH = 8;

/** Empty-query placeholder: the honest "nothing has been searched yet" text. */
export const FIND_EMPTY_STATUS = "type to search";

const PREVIEW_OPEN = "«";
const PREVIEW_CLOSE = "»";

/** One block's full, unclipped text as the find bar searches it. */
export interface FindBlockText {
  /** Stable block document id (survives streaming updates). */
  id: string;
  /** The block's full plain text (see `model.ts::blockText`). */
  text: string;
}

/** Literal occurrence of the query inside one block. */
export interface FindMatch {
  /** Document id of the containing block. */
  blockId: string;
  /** Index of the containing block in the corpus snapshot. */
  blockIndex: number;
  /** UTF-16 offset of the match start inside the block text. */
  start: number;
  /** UTF-16 offset one past the match end inside the block text. */
  end: number;
  /** Matched text exactly as written in the block (original case). */
  text: string;
}

/** Immutable find-bar state for one open bar. */
export interface FindState {
  /** False after `closeFind`; the app renders the bar only while open. */
  open: boolean;
  /** The corpus snapshot searched (refresh it when the model changes). */
  blocks: readonly FindBlockText[];
  /** Filter text typed after Ctrl+F (case preserved for display). */
  query: string;
  /** Matches for `query` in transcript order, capped at the default cap. */
  matches: readonly FindMatch[];
  /** Index into `matches`; always clamped to the list. */
  active: number;
  /** Total occurrences found, including those dropped by the cap. */
  total: number;
  /** True when `total` exceeds the stored match list. */
  capped: boolean;
  /** True when a non-empty query matched nothing. */
  noMatch: boolean;
}

/** Options for {@link searchFindMatches}. */
export interface FindSearchOptions {
  /** Maximum stored matches (default {@link DEFAULT_FIND_MAX_MATCHES}). */
  maxMatches?: number;
}

/** Result of one corpus scan. */
export interface FindSearchResult {
  matches: FindMatch[];
  total: number;
  capped: boolean;
}

/** Result of folding one keypress into the find bar. */
export type FindAction = "none" | "filter" | "move" | "close" | "no-match";

/** Result of {@link findKey}. */
export interface FindKeyResult {
  state: FindState;
  action: FindAction;
}

/** The block texts the find bar searches, in transcript order. */
export function findCorpus(model: TuiModel): FindBlockText[] {
  return model.blocks.map((block) => ({ id: block.id, text: blockText(block) }));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Normalize a query: no escape sequences, no tabs, one line. */
function normalizeQuery(text: string): string {
  return sanitizeDisplayText(typeof text === "string" ? text : "").replace(/\n/g, " ");
}

/** Collapse every whitespace run to one space (for match previews). */
function collapseWhitespace(text: string): string {
  return sanitizeDisplayText(text).replace(/\s+/g, " ");
}

/** Sanitized, whitespace-collapsed, trimmed single line. */
function oneLine(text: string): string {
  return collapseWhitespace(text).trim();
}

/** Cumulative UTF-16 offset of every grapheme boundary (`units.length + 1`). */
function graphemeOffsets(units: readonly string[]): number[] {
  const offsets = new Array<number>(units.length + 1);
  let at = 0;
  for (let index = 0; index < units.length; index += 1) {
    offsets[index] = at;
    at += units[index]?.length ?? 0;
  }
  offsets[units.length] = at;
  return offsets;
}

/** Grapheme index for a UTF-16 offset on a grapheme boundary, or -1. */
function graphemeIndexOf(offsets: readonly number[], offset: number): number {
  for (let index = 0; index < offsets.length; index += 1) {
    if (offsets[index] === offset) return index;
    if ((offsets[index] ?? 0) > offset) return -1;
  }
  return -1;
}

/**
 * Search one corpus literally and case-insensitively.
 *
 * Graphemes are lowercased one cluster at a time and compared as whole
 * clusters, so the search is Unicode-safe without a separate offset map: the
 * recorded `start`/`end` are UTF-16 offsets into the original block text.
 * Matches never overlap (after a hit the cursor advances by the match width),
 * and the stored list is capped while `total` keeps counting.
 */
export function searchFindMatches(
  blocks: readonly FindBlockText[],
  query: string,
  options: FindSearchOptions = {},
): FindSearchResult {
  const capValue = options.maxMatches;
  const cap = Math.max(
    1,
    Math.floor(capValue !== undefined && Number.isFinite(capValue) ? capValue : DEFAULT_FIND_MAX_MATCHES),
  );
  const needle = graphemes(query).map((unit) => unit.toLowerCase());
  if (needle.length === 0) return { matches: [], total: 0, capped: false };

  const matches: FindMatch[] = [];
  let total = 0;
  blocks.forEach((block, blockIndex) => {
    const units = graphemes(block.text);
    if (units.length < needle.length) return;
    const lower = units.map((unit) => unit.toLowerCase());
    const offsets = graphemeOffsets(units);
    let index = 0;
    while (index + needle.length <= lower.length) {
      let hit = true;
      for (let step = 0; step < needle.length; step += 1) {
        if (lower[index + step] !== needle[step]) {
          hit = false;
          break;
        }
      }
      if (!hit) {
        index += 1;
        continue;
      }
      total += 1;
      if (matches.length < cap) {
        const end = index + needle.length;
        matches.push({
          blockId: block.id,
          blockIndex,
          start: offsets[index] ?? 0,
          end: offsets[end] ?? 0,
          text: units.slice(index, end).join(""),
        });
      }
      index += needle.length;
    }
  });
  return { matches, total, capped: total > matches.length };
}

/** Build state from a search result; `active` is clamped to the match list. */
function withSearch(
  state: FindState,
  blocks: readonly FindBlockText[],
  query: string,
  active: number,
): FindState {
  const result = searchFindMatches(blocks, query);
  const count = result.matches.length;
  const next = {
    ...state,
    blocks,
    query,
    matches: result.matches,
    active: count === 0 ? 0 : clamp(Math.floor(active), 0, count - 1),
    total: result.total,
    capped: result.capped,
    noMatch: query !== "" && result.total === 0,
  };
  return next;
}

/** Open the find bar over a corpus snapshot; the empty query searches nothing. */
export function openFind(blocks: readonly FindBlockText[] = []): FindState {
  const state: FindState = {
    open: true,
    blocks: [],
    query: "",
    matches: [],
    active: 0,
    total: 0,
    capped: false,
    noMatch: false,
  };
  return withSearch(state, [...blocks], "", 0);
}

/** Close the bar; the state is otherwise preserved (Esc never mutates it). */
export function closeFind(state: FindState): FindState {
  return { ...state, open: false };
}

/** Replace the query and select the first match. */
export function setFindQuery(state: FindState, query: string): FindState {
  return withSearch(state, state.blocks, normalizeQuery(query), 0);
}

/** Alias for {@link setFindQuery} — the "update the query" step of the reducer. */
export const updateFindQuery: (state: FindState, query: string) => FindState = setFindQuery;

/** Append typed or pasted text to the query (single line, control-free). */
export function appendFindText(state: FindState, text: string): FindState {
  const addition = normalizeQuery(text);
  if (addition === "") return state;
  return setFindQuery(state, state.query + addition);
}

/**
 * Replace the corpus snapshot (e.g. after a stream event) while keeping the
 * query and clamping the active index to the new match list.
 */
export function refreshFind(state: FindState, blocks: readonly FindBlockText[]): FindState {
  return withSearch(state, [...blocks], state.query, state.active);
}

/** Move the active match by `delta`, wrapping around a non-empty list. */
export function moveFindSelection(state: FindState, delta: number): FindState {
  const count = state.matches.length;
  if (count === 0) return { ...state, active: 0 };
  const current = clamp(Math.floor(state.active), 0, count - 1);
  const active = (((current + Math.floor(delta)) % count) + count) % count;
  return { ...state, active };
}

/** The active match plus the block snapshot it points into. */
export function activeFindMatch(
  state: FindState,
): { match: FindMatch; block: FindBlockText } | undefined {
  if (state.matches.length === 0) return undefined;
  const active = clamp(Math.floor(state.active), 0, state.matches.length - 1);
  const match = state.matches[active];
  if (match === undefined) return undefined;
  const block = state.blocks[match.blockIndex];
  if (block === undefined || block.id !== match.blockId) return undefined;
  return { match, block };
}

function stepFind(state: FindState, delta: number): FindKeyResult {
  if (state.matches.length === 0) return { state, action: "no-match" };
  return { state: moveFindSelection(state, delta), action: "move" };
}

/**
 * Fold one keypress into the open find bar.
 *
 * Navigation comes from the registry's `"find"` scope (Enter/Down next,
 * Shift+Enter/Up previous, Esc close), so the hints and the behavior cannot
 * disagree. The app-scope `find` chord (Ctrl+F) closes the bar again. Backspace
 * drops one grapheme; printable text appends to the query; every other key is
 * ignored, so an unrelated chord can never edit the composer while the bar is
 * open.
 */
export function findKey(
  commands: readonly TuiCommand[],
  state: FindState,
  key: KeyLike,
): FindKeyResult {
  if (!state.open) return { state, action: "none" };
  const navigation = resolveKey(commands, key, "find");
  if (navigation !== null) {
    switch (navigation.command.id) {
      case "find-close":
        return { state, action: "close" };
      case "find-next":
        return stepFind(state, 1);
      case "find-prev":
        return stepFind(state, -1);
      default:
        break;
    }
  }
  const appKey = resolveKey(commands, key, "app");
  if (appKey !== null && appKey.command.id === "find") return { state, action: "close" };
  const name = (key.name || "").toLowerCase();
  if (name === "backspace" || key.raw === "\u007f" || key.raw === "\b") {
    return { state: setFindQuery(state, dropLastGrapheme(state.query)), action: "filter" };
  }
  const text = printableKeyText(key);
  if (text !== null) return { state: appendFindText(state, text), action: "filter" };
  return { state, action: "none" };
}

/** The counter/empty/no-match text the bar shows for the current query. */
export function findStatusText(state: FindState): string {
  if (state.query === "") return FIND_EMPTY_STATUS;
  if (state.total === 0) return "no matches";
  const active = clamp(Math.floor(state.active), 0, Math.max(0, state.matches.length - 1)) + 1;
  if (!state.capped) return `${active}/${state.total}`;
  return `${active}/${state.matches.length} +${state.total - state.matches.length}`;
}

/** Footer hints derived from the registry (full and narrow variants). */
export function findBarHints(
  commands: readonly TuiCommand[] = TUI_COMMANDS,
  options: { compact?: boolean } = {},
): string {
  const parts: string[] = [];
  const append = (id: string, label: string): void => {
    const chord = findCommand(commands, id)?.keys?.[0];
    if (chord !== undefined) parts.push(`${formatChord(chord)} ${label}`);
  };
  append("find-next", "next");
  if (options.compact !== true) append("find-prev", "prev");
  append("find-close", "close");
  return parts.join(" · ");
}

/** Render options for the find bar. */
export interface FindBarRenderOptions {
  /** Terminal width in cells; the row is padded/truncated to exactly it. */
  width: number;
  /** Theme for the label/status/hint tones and the inverted match span. */
  theme?: Theme;
  /** Override the registry-derived hints (tests/embedding). */
  hints?: string;
}

/** The rendered find bar plus the active-match cells. */
export interface FindBarView {
  /** Exactly one row while open (none when closed), each exactly `width` cells. */
  lines: string[];
  /** Cells of the active match inside `lines[0]`, when fully visible. */
  activeSpan?: { line: number; start: number; end: number };
}

interface PreviewParts {
  lead: string;
  match: string;
  tail: string;
}

/** Context around the active match in its block, as `…before«match»after…`. */
function buildPreview(state: FindState): PreviewParts | undefined {
  const active = activeFindMatch(state);
  if (active === undefined) return undefined;
  const units = graphemes(active.block.text);
  const offsets = graphemeOffsets(units);
  const startIndex = graphemeIndexOf(offsets, active.match.start);
  const endIndex = graphemeIndexOf(offsets, active.match.end);
  if (startIndex < 0 || endIndex < startIndex) return undefined;
  const from = Math.max(0, startIndex - FIND_PREVIEW_CONTEXT);
  const to = Math.min(units.length, endIndex + FIND_PREVIEW_CONTEXT);
  const before = collapseWhitespace(units.slice(from, startIndex).join("")).replace(/^\s+/, "");
  const after = collapseWhitespace(units.slice(endIndex, to).join("")).replace(/\s+$/, "");
  return {
    lead: `${startIndex > FIND_PREVIEW_CONTEXT ? "…" : ""}${before}`,
    // Collapse (never trim) the matched text: a whitespace-only match still
    // shows a visible marked cell instead of an empty «».
    match: collapseWhitespace(active.match.text) === ""
      ? " "
      : collapseWhitespace(active.match.text),
    tail: `${after}${endIndex + FIND_PREVIEW_CONTEXT < units.length ? "…" : ""}`,
  };
}

interface Segment {
  text: string;
  tone?: ThemeToken;
}

/** Keep the last `maxCells` cells of `text`, marking a left cut with `…`. */
function tailFit(text: string, maxCells: number): string {
  if (maxCells <= 0 || text === "") return "";
  if (displayWidth(text) <= maxCells) return text;
  if (maxCells === 1) return "…";
  const units = graphemes(text);
  const kept: string[] = [];
  let width = 0;
  for (let index = units.length - 1; index >= 0; index -= 1) {
    const unit = units[index] ?? "";
    const unitWidth = displayWidth(unit);
    if (width + unitWidth > maxCells - 1) break;
    kept.unshift(unit);
    width += unitWidth;
  }
  return `…${kept.join("")}`;
}

/**
 * Render the open find bar as one exact `width`-cell plain/styled row.
 *
 * Layout priority is the prompt and query, then the `current/total` counter
 * (with `+N` past the cap) or the honest `no matches` / `type to search`
 * state, then the registry hints (right-aligned, full then compact), and
 * finally the active-match preview with the `«»` marker in the remaining
 * space. A too-long query truncates with `…`; a too-narrow terminal drops
 * whole groups instead of tearing the row.
 */
export function findBarView(state: FindState, options: FindBarRenderOptions): FindBarView {
  if (!state.open) return { lines: [] };
  const columns = Number.isFinite(options.width) ? Math.max(0, Math.floor(options.width)) : 0;
  const theme = options.theme ?? plainTheme;
  if (columns === 0) return { lines: [""] };

  const queryText = oneLine(state.query);
  // "Empty" means literally no query: a whitespace-only query is searched
  // (and counted) even though its characters are invisible in the prompt.
  const empty = state.query === "";
  const prompt = "FIND > ";
  const queryDisplay = empty
    ? ""
    : viewTruncate(queryText, Math.max(0, columns - displayWidth(prompt)));
  const segments: Segment[] = [
    { text: "FIND", tone: "accent" },
    { text: empty ? ` > ${FIND_EMPTY_STATUS}` : ` > ${queryDisplay}`, ...(empty ? { tone: "dim" } : {}) },
  ];
  let headWidth = segments.reduce((total, segment) => total + displayWidth(segment.text), 0);
  if (headWidth > columns) {
    // Degenerate width: the prompt alone must still be width-safe.
    const clipped = viewTruncate(segments.map((segment) => segment.text).join(""), columns);
    return { lines: [viewPad(theme.paint("accent", clipped), columns)] };
  }
  const statusText = empty ? "" : findStatusText(state);
  if (statusText !== "" && headWidth + 2 + displayWidth(statusText) <= columns) {
    segments.push({ text: `  ${statusText}`, tone: "muted" });
    headWidth += 2 + displayWidth(statusText);
  }

  const wantsPreview = activeFindMatch(state) !== undefined;
  const candidates = options.hints !== undefined
    ? [options.hints]
    : [findBarHints(TUI_COMMANDS), findBarHints(TUI_COMMANDS, { compact: true })];
  const chooseHint = (requirePreview: boolean): { text: string; width: number } => {
    for (const candidate of candidates) {
      if (candidate === "") continue;
      const width = displayWidth(candidate);
      if (headWidth + 2 + width > columns) continue;
      if (requirePreview && headWidth + 2 + width + 2 + FIND_PREVIEW_MIN_WIDTH > columns) continue;
      return { text: candidate, width };
    }
    return { text: "", width: 0 };
  };
  let hint = chooseHint(wantsPreview);
  if (hint.text === "" && wantsPreview && columns - headWidth - 2 < FIND_PREVIEW_MIN_WIDTH) {
    // No hint tier leaves room for the preview, but there is still room for a
    // hint on its own: show the hint when the match cannot be previewed.
    hint = chooseHint(false);
  }

  let preview: { styled: string; visibleWidth: number; span?: { start: number; end: number } } | undefined;
  const parts = buildPreview(state);
  if (wantsPreview && parts !== undefined) {
    const budget = columns - headWidth - 2 - (hint.text === "" ? 0 : hint.width + 2);
    if (budget >= FIND_PREVIEW_MIN_WIDTH) {
      const marker = `${PREVIEW_OPEN}${parts.match}${PREVIEW_CLOSE}`;
      const markerWidth = displayWidth(marker);
      let leadPart = "";
      let tailPart = "";
      let plainPreview: string;
      let styled: string;
      if (markerWidth >= budget) {
        // Extremely narrow: the marker itself wins over any context.
        plainPreview = truncateToWidth(marker, budget);
        styled = truncateToWidth(theme.inverse(marker), budget);
      } else {
        // Keep the marked match visible: the lead keeps only its closest tail
        // cells, and a few cells are reserved for the following context.
        const tailReserve = Math.min(6, budget - markerWidth - 1);
        const leadAllow = Math.max(
          0,
          Math.min(displayWidth(parts.lead), budget - markerWidth - tailReserve),
        );
        leadPart = tailFit(parts.lead, leadAllow);
        const tailAllow = budget - displayWidth(leadPart) - markerWidth;
        tailPart = tailAllow > 0 ? truncateToWidth(parts.tail, tailAllow) : "";
        plainPreview = `${leadPart}${marker}${tailPart}`;
        styled = `${leadPart}${theme.inverse(marker)}${tailPart}`;
      }
      const visibleWidth = Math.min(displayWidth(plainPreview), budget);
      const spanStart = displayWidth(leadPart) + displayWidth(PREVIEW_OPEN);
      const spanEnd = spanStart + displayWidth(parts.match);
      const span =
        spanStart < visibleWidth
          ? { start: spanStart, end: Math.min(spanEnd, visibleWidth) }
          : undefined;
      preview = { styled, visibleWidth, ...(span !== undefined ? { span } : {}) };
    }
  }

  let row = segments
    .map((segment) => (segment.tone === undefined ? segment.text : theme.paint(segment.tone, segment.text)))
    .join("");
  let rowWidth = headWidth;
  let activeSpan: FindBarView["activeSpan"];
  if (preview !== undefined) {
    row += `  ${preview.styled}`;
    rowWidth += 2 + preview.visibleWidth;
    if (preview.span !== undefined) {
      activeSpan = {
        line: 0,
        start: headWidth + 2 + preview.span.start,
        end: headWidth + 2 + preview.span.end,
      };
    }
  }
  if (hint.text !== "") {
    const gap = columns - rowWidth - hint.width;
    if (gap >= 2) {
      row += `${" ".repeat(gap)}${theme.paint("dim", hint.text)}`;
      rowWidth += gap + hint.width;
    }
  }
  row = padToWidth(row, columns);
  return { lines: [row], ...(activeSpan !== undefined ? { activeSpan } : {}) };
}

/**
 * Convenience wrapper returning only the rendered row(s). Accepts a bare
 * `width` (the compact call shape) or the full render options.
 */
export function renderFindBar(
  state: FindState,
  widthOrOptions: number | FindBarRenderOptions,
): string[] {
  const options = typeof widthOrOptions === "number" ? { width: widthOrOptions } : widthOrOptions;
  return findBarView(state, options).lines;
}
