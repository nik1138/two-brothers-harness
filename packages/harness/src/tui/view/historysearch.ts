/**
 * Pure incremental reverse-history search for the TUI composer (Ctrl+R).
 *
 * Like a shell's reverse search, the overlay starts empty and narrows the
 * submitted history as the user types: matching is a case-insensitive
 * substring test and results are ranked newest first (the editor history is
 * oldest-first, so `searchHistory` walks it backwards). Up/Down and a
 * repeated Ctrl+R cycle the selection with wrap-around; Enter accepts the
 * selected prompt and Escape cancels.
 *
 * The state carries an immutable snapshot of the history it searches, so the
 * reducer is self-contained (no editor or app access) and the search can
 * never mutate the live or persisted history. Accepting only returns the
 * text — the app decides where it goes; re-recording happens later through
 * the normal submission path.
 *
 * Rendering is a compact plain-text cell (header, filter line, windowed list,
 * footer) that fits an exact `width × height`, degrades on narrow terminals,
 * and shows distinct empty ("no submitted prompts yet") and no-match states.
 * The selected row is marked with `› ` and never styled here, matching the
 * palette/help convention: the screen layer owns color and the box frame.
 *
 * No ANSI and no I/O; output is deterministic for the same state/options.
 */
import {
  findCommand,
  formatKeys,
  hintSegments,
  TUI_COMMANDS,
  type KeyLike,
  type TuiCommand,
} from "../keymap.ts";
import { sanitizeDisplayText } from "../screen.ts";
import {
  dropLastGrapheme,
  printableKeyText,
  viewPad,
  viewTruncate,
  windowStart,
} from "./palette.ts";

/** Incremental reverse-search state for one open overlay. */
export interface HistorySearchState {
  /** Immutable snapshot of the submitted prompts, oldest first. */
  entries: readonly string[];
  /** Filter text typed after Ctrl+R (case preserved for display). */
  query: string;
  /** Index into {@link matches}; 0 is the newest match. */
  selected: number;
  /** Case-insensitive substring matches for `query`, newest first. */
  matches: readonly string[];
}

/** Non-editing effect of one search keypress. */
export type HistorySearchAction =
  | "none"
  | "filter"
  | "move"
  | "accept"
  | "cancel"
  | "no-match";

/** Result of folding one keypress into the search state. */
export interface HistorySearchKeyResult {
  state: HistorySearchState;
  action: HistorySearchAction;
  /** The accepted prompt; only set when `action` is `"accept"`. */
  text?: string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Case-insensitive substring search over oldest-first history, returned
 * newest first. An empty query matches every entry (so Ctrl+R immediately
 * shows the newest prompt).
 */
export function searchHistory(entries: readonly string[], query: string): string[] {
  const needle = query.toLowerCase();
  const matches: string[] = [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry === undefined) continue;
    if (needle === "" || entry.toLowerCase().includes(needle)) matches.push(entry);
  }
  return matches;
}

/** Open a search over `entries` with an empty query, newest match selected. */
export function openHistorySearch(entries: readonly string[]): HistorySearchState {
  return {
    entries: [...entries],
    query: "",
    selected: 0,
    matches: searchHistory(entries, ""),
  };
}

/** Replace the filter text, then select the newest match again. */
export function setHistorySearchQuery(
  state: HistorySearchState,
  query: string,
): HistorySearchState {
  return {
    entries: state.entries,
    query,
    selected: 0,
    matches: searchHistory(state.entries, query),
  };
}

/** Move the selection by `delta`, wrapping around a non-empty match list. */
export function moveHistorySearchSelection(
  state: HistorySearchState,
  delta: number,
): HistorySearchState {
  const count = state.matches.length;
  if (count === 0) return { ...state, selected: 0 };
  const current = clamp(Math.floor(state.selected), 0, count - 1);
  const selected = (((current + Math.floor(delta)) % count) + count) % count;
  return { ...state, selected };
}

/** The prompt under the highlight, or `undefined` when nothing matches. */
export function selectedHistoryMatch(state: HistorySearchState): string | undefined {
  if (state.matches.length === 0) return undefined;
  return state.matches[clamp(Math.floor(state.selected), 0, state.matches.length - 1)];
}

/**
 * Fold one keypress into the search.
 *
 * Escape cancels, Enter accepts the selected match (`"no-match"` when there is
 * none), Up/Down and a repeated Ctrl+R cycle with wrap, Backspace edits the
 * filter one grapheme at a time, and printable text narrows the search. All
 * other keys are ignored, so the overlay never steals unrelated chords.
 */
export function searchHistoryKey(
  state: HistorySearchState,
  key: KeyLike,
): HistorySearchKeyResult {
  const name = (key.name || "").toLowerCase();
  if (name === "escape" || name === "esc") return { state, action: "cancel" };
  if (key.ctrl === true && name === "r") {
    return { state: moveHistorySearchSelection(state, 1), action: "move" };
  }
  if (name === "return" || name === "enter") {
    const match = selectedHistoryMatch(state);
    if (match === undefined) return { state, action: "no-match" };
    return { state, action: "accept", text: match };
  }
  if (name === "up") return { state: moveHistorySearchSelection(state, -1), action: "move" };
  if (name === "down") return { state: moveHistorySearchSelection(state, 1), action: "move" };
  if (name === "backspace" || key.raw === "\u007f" || key.raw === "\b") {
    return {
      state: setHistorySearchQuery(state, dropLastGrapheme(state.query)),
      action: "filter",
    };
  }
  const text = printableKeyText(key);
  if (text !== null) {
    return { state: setHistorySearchQuery(state, state.query + text), action: "filter" };
  }
  return { state, action: "none" };
}

/** Footer hints derived from the registry, including the repeat chord. */
export function historySearchHints(commands: readonly TuiCommand[] = TUI_COMMANDS): string {
  const parts: string[] = [];
  const list = hintSegments(commands, [
    { id: "list-move", label: "move" },
    { id: "list-accept", label: "accept" },
    { id: "list-close", label: "cancel" },
  ]);
  if (list !== "") parts.push(list);
  const command = findCommand(commands, "history-search");
  const repeat = command === undefined ? "" : formatKeys(command);
  if (repeat !== "") parts.push(`${repeat} cycle`);
  return parts.join(" · ");
}

/** Render options for the search overlay. */
export interface HistorySearchRenderOptions {
  width: number;
  height: number;
  title?: string;
  /** Override the registry-derived footer (tests/embedding). */
  hints?: string;
}

/** The rendered search overlay plus its geometry. */
export interface HistorySearchView {
  /** Exactly `height` plain-text rows, each exactly `width` cells. */
  lines: string[];
  /** The match rows currently visible, newest first. */
  visible: string[];
  noMatch: boolean;
  /** Line index of the highlighted row, or -1 when nothing is selected. */
  selectedRow: number;
}

/** One match row: selection marker plus a sanitized, single-line entry. */
function searchEntryRow(entry: string, width: number, selected: boolean): string {
  const marker = selected ? "› " : "  ";
  const flat = sanitizeDisplayText(entry).replace(/\n/g, " ↵ ").trim();
  return viewPad(viewTruncate(`${marker}${flat}`, width), width);
}

/**
 * Render the overlay into an exact `width × height` cell.
 *
 * Rows are the header, the `> query` line, the windowed newest-first matches
 * and a footer; a long history scrolls to keep the selection visible. An
 * empty history and a filter with no matches render different messages.
 */
export function historySearchView(
  state: HistorySearchState,
  options: HistorySearchRenderOptions,
): HistorySearchView {
  const width = Number.isFinite(options.width) ? Math.max(0, Math.floor(options.width)) : 0;
  const height = Number.isFinite(options.height) ? Math.max(0, Math.floor(options.height)) : 0;
  const count = state.matches.length;
  const noMatch = count === 0;
  const selected = noMatch ? -1 : clamp(Math.floor(state.selected), 0, count - 1);
  const title = options.title ?? "History search";
  const position = noMatch ? "" : ` · ${selected + 1}/${count}`;
  const header = viewPad(viewTruncate(`${title} (${count})${position}`, width), width);
  const filterLine = viewPad(
    viewTruncate(`> ${sanitizeDisplayText(state.query)}`, width),
    width,
  );
  const footer = viewPad(options.hints ?? historySearchHints(), width);
  if (height === 0) {
    return { lines: [], visible: [], noMatch, selectedRow: -1 };
  }
  if (height < 3) {
    return {
      lines: [header, filterLine, footer].slice(0, height),
      visible: [],
      noMatch,
      selectedRow: -1,
    };
  }

  const listRows = height - 3;
  const rendered: string[] = [];
  const visible: string[] = [];
  let selectedRow = -1;
  if (noMatch) {
    const message =
      state.entries.length === 0
        ? "No submitted prompts yet."
        : `No matches for "${sanitizeDisplayText(state.query)}".`;
    rendered.push(viewPad(viewTruncate(message, width), width));
    if (listRows > 1) {
      const hint =
        state.entries.length === 0
          ? "Submit a task, then search it here."
          : "Backspace edits the filter.";
      rendered.push(viewPad(viewTruncate(hint, width), width));
    }
    while (rendered.length < listRows) rendered.push(viewPad("", width));
  } else {
    const start = windowStart(count, selected, listRows);
    const slice = state.matches.slice(start, start + listRows);
    slice.forEach((entry, index) => {
      const isSelected = start + index === selected;
      if (isSelected) selectedRow = 2 + index;
      visible.push(entry);
      rendered.push(searchEntryRow(entry, width, isSelected));
    });
    while (rendered.length < listRows) rendered.push(viewPad("", width));
  }

  return {
    lines: [header, filterLine, ...rendered, footer],
    visible,
    noMatch,
    selectedRow,
  };
}

/** Convenience wrapper returning only the rendered lines. */
export function renderHistorySearch(
  state: HistorySearchState,
  options: HistorySearchRenderOptions,
): string[] {
  return historySearchView(state, options).lines;
}
