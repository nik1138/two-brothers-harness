/**
 * Pure command-palette state and view for the TUI.
 *
 * The palette is a keyboard-first filtered list over {@link PaletteEntry}
 * rows produced by `keymap.ts`. This module owns:
 *
 * - filtering (case-insensitive, multi-token, title/description/key/slash),
 * - selection movement with wrap-around and a scrolling viewport,
 * - key handling for the overlay scope (arrows, Enter, Esc, typing,
 *   Backspace) driven by the shared registry — no key name is spelled here,
 * - a renderer that fits an exact `width × height` cell, degrades at narrow
 *   widths (description, then the key column, dropped) and always shows an
 *   empty / no-match state. Rows are painted through the semantic {@link Theme}
 *   (headings, chords, descriptions, the selected row) without ever changing
 *   the plain text, so `plainTheme`/`NO_COLOR` output is byte-identical to the
 *   pre-theme renderer.
 *
 * It also exports the small text-measure helpers the help view shares, so the
 * two overlays cannot disagree about truncation. All measurement delegates to
 * the grapheme- and East Asian-width-aware helpers in `text.ts`.
 *
 * No ANSI literals and no I/O: the screen layer owns the palette, the dialog
 * frame and the cursor; this module only asks the theme to paint. Output is
 * deterministic for the same state/entries/options/theme.
 */
import { graphemes } from "../editor.ts";
import {
  hintSegments,
  resolveKey,
  type KeyLike,
  type PaletteEntry,
  type TuiCommand,
} from "../keymap.ts";
import { displayWidth, padToWidth, truncateToWidth } from "../text.ts";
import { plainTheme, type Theme, type ThemeToken } from "../theme.ts";

/** Display width in terminal cells (East Asian wide and emoji count as 2). */
export function viewTextWidth(text: string): number {
  return displayWidth(text);
}

/** Cut to at most `width` cells, appending `…` when anything was dropped. */
export function viewTruncate(text: string, width: number): string {
  return truncateToWidth(text, width);
}

/** Truncate or pad to exactly `width` cells. */
export function viewPad(text: string, width: number): string {
  return padToWidth(text, width);
}

/** One semantic part of an overlay row; `tone` undefined leaves it unstyled. */
export interface OverlayPart {
  text: string;
  tone?: ThemeToken;
}

/**
 * Fit one overlay row to exactly `width` cells.
 *
 * A color-less theme (the default, `plainTheme`, `NO_COLOR`) returns exactly
 * the pre-theme `viewPad` bytes. A color theme paints each part with its
 * semantic token and pads the same visible text, so stripping SGR always
 * reproduces the plain row; an over-wide row is cut at the same cell with no
 * extra ellipsis, never mid-grapheme (the cut goes through `padToWidth`).
 */
export function overlayRow(
  theme: Theme,
  parts: readonly OverlayPart[],
  width: number,
): string {
  const plain = parts.map((part) => part.text).join("");
  if (!theme.color) return viewPad(plain, width);
  let styled = "";
  for (const part of parts) {
    if (part.text === "") continue;
    styled += part.tone === undefined ? part.text : theme.paint(part.tone, part.text);
  }
  return padToWidth(styled, width);
}

/** Drop the final user-perceived character of a filter query. */
export function dropLastGrapheme(text: string): string {
  const units = graphemes(text);
  units.pop();
  return units.join("");
}

/**
 * Printable text contributed by a key event, or `null` for control keys,
 * modified keys, escape sequences and pasted multi-line chunks.
 */
export function printableKeyText(key: KeyLike): string | null {
  if (key.ctrl === true || key.alt === true) return null;
  if (key.name.toLowerCase() === "paste") return null;
  const raw = key.raw ?? "";
  if (raw === "" || raw.startsWith("\u001b")) return null;
  if (raw === "\t" || raw === "\r" || raw === "\n") return null;
  if (/[\u0000-\u001f\u007f]/.test(raw)) return null;
  return raw;
}

// --------------------------------------------------------------------------- //
// filtering and selection
// --------------------------------------------------------------------------- //

/** Palette/list state: the query and the highlighted index. */
export interface PaletteState {
  query: string;
  selected: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** A fresh palette state, optionally seeded with a query. */
export function createPaletteState(query = ""): PaletteState {
  return { query, selected: 0 };
}

/** A fresh state for a new query, resetting the selection to the first row. */
export function setPaletteQuery(state: PaletteState, query: string): PaletteState {
  return { query, selected: 0 };
}

function rankEntry(entry: PaletteEntry, query: string): number {
  const title = entry.title.toLowerCase();
  const slash = entry.slash.toLowerCase();
  if (title === query || slash === `/${query}`) return 0;
  if (title.startsWith(query) || slash.startsWith(`/${query}`)) return 1;
  return 2;
}

/**
 * Filter entries by a case-insensitive multi-token query. Every token must
 * appear somewhere in the title, description, group, key label, slash form,
 * argument hint or mode. With a query, exact/prefix title matches rank first;
 * ties keep registry order.
 */
export function filterPaletteEntries(
  entries: readonly PaletteEntry[],
  query: string,
): PaletteEntry[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter((token) => token !== "");
  if (tokens.length === 0) return [...entries];
  const matches: { entry: PaletteEntry; index: number }[] = [];
  entries.forEach((entry, index) => {
    const haystack = [
      entry.title,
      entry.description,
      entry.group,
      entry.keys,
      entry.slash,
      entry.argumentHint,
      entry.mode,
    ]
      .join(" ")
      .toLowerCase();
    if (tokens.every((token) => haystack.includes(token))) matches.push({ entry, index });
  });
  const phrase = tokens.join(" ");
  matches.sort(
    (left, right) =>
      rankEntry(left.entry, phrase) - rankEntry(right.entry, phrase) || left.index - right.index,
  );
  return matches.map((match) => match.entry);
}

/** Move the highlight by `delta`, wrapping around a non-empty list. */
export function movePaletteSelection(
  state: PaletteState,
  delta: number,
  count: number,
): PaletteState {
  if (count <= 0) return { ...state, selected: 0 };
  const base = clamp(Math.floor(state.selected), 0, count - 1);
  const selected = (((base + delta) % count) + count) % count;
  return { ...state, selected };
}

/** The highlighted entry of an already-filtered list. */
export function selectedPaletteEntry(
  state: PaletteState,
  entries: readonly PaletteEntry[],
): PaletteEntry | undefined {
  if (entries.length === 0) return undefined;
  return entries[clamp(Math.floor(state.selected), 0, entries.length - 1)];
}

// --------------------------------------------------------------------------- //
// keyboard
// --------------------------------------------------------------------------- //

/** Effect of one overlay keypress. */
export type ListAction = "none" | "move" | "accept" | "blocked" | "close" | "filter";

/** Result of folding one keypress into a palette/help state. */
export interface ListKeyResult {
  state: PaletteState;
  action: ListAction;
  entry?: PaletteEntry;
  reason?: string;
}

/**
 * Fold an overlay keypress into the palette. Movement, accept and close come
 * from the registry's overlay scope; printable input edits the query and
 * Backspace removes one grapheme. A disabled row cannot be accepted.
 */
export function handlePaletteKey(
  commands: readonly TuiCommand[],
  state: PaletteState,
  key: KeyLike,
  entries: readonly PaletteEntry[],
): ListKeyResult {
  const filtered = filterPaletteEntries(entries, state.query);
  const match = resolveKey(commands, key, "overlay");
  if (match !== null) {
    switch (match.command.id) {
      case "palette":
      case "list-close":
        return { state, action: "close" };
      case "list-accept": {
        const entry = selectedPaletteEntry(state, filtered);
        if (entry === undefined) return { state, action: "none" };
        if (entry.disabled) {
          return { state, action: "blocked", entry, reason: entry.disabledReason };
        }
        return { state, action: "accept", entry };
      }
      case "list-move": {
        const delta = match.chord.name.toLowerCase() === "up" ? -1 : 1;
        return {
          state: movePaletteSelection(state, delta, filtered.length),
          action: "move",
        };
      }
      default:
        break;
    }
  }
  if (key.name.toLowerCase() === "backspace" || key.raw === "\u007f" || key.raw === "\b") {
    return { state: setPaletteQuery(state, dropLastGrapheme(state.query)), action: "filter" };
  }
  const text = printableKeyText(key);
  if (text !== null) return { state: setPaletteQuery(state, state.query + text), action: "filter" };
  return { state, action: "none" };
}

// --------------------------------------------------------------------------- //
// rendering
// --------------------------------------------------------------------------- //

/** Where the visible window starts for a selected row. */
export function windowStart(total: number, selected: number, rows: number): number {
  if (rows <= 0 || total <= rows) return 0;
  const half = Math.floor(rows / 2);
  return clamp(selected - half, 0, total - rows);
}

/** Width of the key column for a set of visible rows (capped at 16 cells). */
export function entryKeyColumnWidth(entries: readonly PaletteEntry[]): number {
  let width = 0;
  for (const entry of entries) width = Math.max(width, viewTextWidth(entry.keys));
  return Math.min(width, 16);
}

/** One list row: marker, key label, title, hint, optional slash/description. */
export interface EntryRowOptions {
  width: number;
  selected: boolean;
  keyWidth: number;
  showDescription?: boolean;
  showSlash?: boolean;
  /** Theme for the row (default `plainTheme`: the pre-theme bytes). */
  theme?: Theme;
}

/**
 * Render one list row. The plain text (and its width cut) is exactly the
 * pre-theme row; a color theme layers the semantic tokens — accent chords,
 * muted descriptions, a warning for unavailable rows and an inverse selected
 * row — on top of that same text.
 */
export function entryRow(entry: PaletteEntry, options: EntryRowOptions): string {
  const theme = options.theme ?? plainTheme;
  const marker = options.selected ? "› " : "  ";
  const keyCell = options.keyWidth > 0 ? `${viewPad(entry.keys, options.keyWidth)}  ` : "";
  const argumentHint = entry.argumentHint !== "" ? ` ${entry.argumentHint}` : "";
  const slash =
    options.showSlash === true && entry.kind === "command" && entry.slash !== ""
      ? ` (${entry.slash})`
      : "";
  const description =
    options.showDescription === true && entry.description !== ""
      ? ` — ${entry.description}`
      : "";
  const unavailable = entry.disabled ? " [unavailable]" : "";
  if (options.selected) {
    // The inverse run covers the padded row, so the selection reads as one
    // full-width bar; the padding stays outside the plain text either way.
    const plainRow = viewPad(
      `${marker}${keyCell}${entry.title}${argumentHint}${slash}${description}${unavailable}`,
      options.width,
    );
    return theme.color ? theme.paint("inverse", plainRow) : plainRow;
  }
  return overlayRow(
    theme,
    [
      { text: marker },
      { text: keyCell, tone: entry.keys === "" ? undefined : "accent" },
      { text: entry.title, tone: entry.disabled ? "muted" : "text" },
      { text: argumentHint, tone: "dim" },
      { text: slash, tone: "dim" },
      { text: description, tone: "muted" },
      { text: unavailable, tone: "warning" },
    ],
    options.width,
  );
}

/** Footer hints for a list overlay, derived from the registry. */
export function paletteHints(commands: readonly TuiCommand[]): string {
  return hintSegments(commands, [
    { id: "list-move", label: "move" },
    { id: "list-accept", label: "select" },
    { id: "list-close", label: "close" },
  ]);
}

/** Render options for the palette. */
export interface PaletteRenderOptions {
  width: number;
  height: number;
  title?: string;
  /** Override the registry-derived footer (tests/embedding). */
  hints?: string;
  /** Theme for the overlay rows (default `plainTheme`). */
  theme?: Theme;
}

/** The rendered palette plus the visible slice and selection geometry. */
export interface PaletteView {
  /** Exactly `height` plain-text rows, each exactly `width` cells. */
  lines: string[];
  visible: PaletteEntry[];
  noMatch: boolean;
  /** Line index of the selected row, or -1 when nothing is selected. */
  selectedRow: number;
}

/**
 * Render the palette into an exact `width × height` cell. Descriptions are
 * dropped below 60 cells, the key column below 30, and every row is
 * truncated (never exceeding the terminal width) at the extremes. Rows are
 * painted through `options.theme`; the default plain theme keeps the exact
 * pre-theme bytes.
 */
export function paletteView(
  commands: readonly TuiCommand[],
  state: PaletteState,
  entries: readonly PaletteEntry[],
  options: PaletteRenderOptions,
): PaletteView {
  const width = Number.isFinite(options.width) ? Math.max(0, Math.floor(options.width)) : 0;
  const height = Number.isFinite(options.height) ? Math.max(0, Math.floor(options.height)) : 0;
  const theme = options.theme ?? plainTheme;
  const filtered = filterPaletteEntries(entries, state.query);
  const noMatch = filtered.length === 0;
  const selected = noMatch ? -1 : clamp(Math.floor(state.selected), 0, filtered.length - 1);
  const header = overlayRow(
    theme,
    [{ text: `${options.title ?? "Commands"} (${filtered.length})`, tone: "strong" }],
    width,
  );
  const filterLine = overlayRow(
    theme,
    [{ text: "> ", tone: "accent" }, { text: state.query, tone: "text" }],
    width,
  );
  const footer = overlayRow(
    theme,
    [{ text: options.hints ?? paletteHints(commands), tone: "dim" }],
    width,
  );
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
  const visible: PaletteEntry[] = [];
  let selectedRow = -1;
  if (noMatch) {
    const message =
      entries.length === 0 ? "No commands available." : `No matches for "${state.query}".`;
    const hint = entries.length === 0 ? "" : "Backspace edits the filter · Esc closes.";
    rendered.push(overlayRow(theme, [{ text: message, tone: "muted" }], width));
    if (listRows > 1 && hint !== "") {
      rendered.push(overlayRow(theme, [{ text: hint, tone: "dim" }], width));
    }
    while (rendered.length < listRows) rendered.push(viewPad("", width));
  } else {
    const start = windowStart(filtered.length, selected, listRows);
    const slice = filtered.slice(start, start + listRows);
    const keyWidth = width >= 30 ? entryKeyColumnWidth(slice) : 0;
    const showDescription = width >= 60;
    slice.forEach((entry, index) => {
      const isSelected = start + index === selected;
      if (isSelected) selectedRow = 2 + index;
      visible.push(entry);
      rendered.push(
        entryRow(entry, { width, selected: isSelected, keyWidth, showDescription, theme }),
      );
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
export function renderPalette(
  commands: readonly TuiCommand[],
  state: PaletteState,
  entries: readonly PaletteEntry[],
  options: PaletteRenderOptions,
): string[] {
  return paletteView(commands, state, entries, options).lines;
}