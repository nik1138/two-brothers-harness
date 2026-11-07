/**
 * Pure help-overlay state and view for the TUI.
 *
 * The help screen is the registry rendered as a grouped, filterable list:
 * every key binding, built-in slash command and discovered `<name>.md`
 * template is an entry, and all key labels come from `keymap.ts` (no string
 * in this file spells a shortcut). Rows are grouped in `COMMAND_GROUPS`
 * order with "Slash commands" last.
 *
 * Behavior mirrors the palette: a case-insensitive multi-token filter,
 * wrap-around selection, a scrolling window that keeps the selection visible,
 * empty/no-match states, Escape/palette-key close, and an exact `width ×
 * height` cell. Narrow terminals drop group headers, then the key column, then
 * descriptions, instead of truncating mid-glyph. Rows are painted through the
 * semantic {@link Theme} (group headers, chords, descriptions, selected row);
 * the default plain theme keeps the exact pre-theme bytes.
 *
 * No ANSI literals, no I/O; output is deterministic for the same inputs.
 */
import {
  COMMAND_GROUPS,
  TUI_COMMANDS,
  documentEntries,
  hintSegments,
  resolveKey,
  type CommandGroup,
  type EntryOptions,
  type KeyLike,
  type PaletteEntry,
  type TuiCommand,
} from "../keymap.ts";
import { plainTheme, type Theme } from "../theme.ts";
import {
  dropLastGrapheme,
  entryKeyColumnWidth,
  entryRow,
  filterPaletteEntries,
  movePaletteSelection,
  overlayRow,
  printableKeyText,
  viewPad,
  windowStart,
  type ListAction,
  type PaletteState,
} from "./palette.ts";

/** Help shares the palette's query/selection shape. */
export type HelpState = PaletteState;

/** A group of help entries in display order. */
export interface HelpGroup {
  group: CommandGroup;
  entries: PaletteEntry[];
}

/** A fresh help state, optionally seeded with a filter query. */
export function createHelpState(query = ""): HelpState {
  return { query, selected: 0 };
}

/** Entries documented by help (commands plus discovered templates). */
export function helpEntries(
  commands: readonly TuiCommand[] = TUI_COMMANDS,
  options: EntryOptions = {},
): PaletteEntry[] {
  return documentEntries(commands, options);
}

/** Filter help entries (same semantics as the palette filter). */
export function filterHelpEntries(
  entries: readonly PaletteEntry[],
  query: string,
): PaletteEntry[] {
  return filterPaletteEntries(entries, query);
}

/**
 * Group filtered entries in `COMMAND_GROUPS` order; unknown groups are
 * appended in first-seen order. Empty groups are omitted.
 */
export function groupHelpEntries(entries: readonly PaletteEntry[]): HelpGroup[] {
  const byGroup = new Map<CommandGroup, PaletteEntry[]>();
  for (const entry of entries) {
    const bucket = byGroup.get(entry.group);
    if (bucket === undefined) byGroup.set(entry.group, [entry]);
    else bucket.push(entry);
  }
  const order: CommandGroup[] = [...COMMAND_GROUPS];
  for (const group of byGroup.keys()) {
    if (!order.includes(group)) order.push(group);
  }
  const groups: HelpGroup[] = [];
  for (const group of order) {
    const bucket = byGroup.get(group);
    if (bucket !== undefined && bucket.length > 0) groups.push({ group, entries: bucket });
  }
  return groups;
}

/** Flatten grouped entries into the selection order. */
export function orderedHelpEntries(entries: readonly PaletteEntry[]): PaletteEntry[] {
  return groupHelpEntries(entries).flatMap((group) => group.entries);
}

/** Reset the filter and select the first row. */
export function setHelpQuery(state: HelpState, query: string): HelpState {
  return { query, selected: 0 };
}

/** Move the highlight by `delta`, wrapping around a non-empty list. */
export function moveHelpSelection(state: HelpState, delta: number, count: number): HelpState {
  return movePaletteSelection(state, delta, count);
}

/** The highlighted entry of the ordered (grouped) list. */
export function selectedHelpEntry(
  state: HelpState,
  entries: readonly PaletteEntry[],
): PaletteEntry | undefined {
  const ordered = orderedHelpEntries(entries);
  if (ordered.length === 0) return undefined;
  const index = Math.min(Math.max(Math.floor(state.selected), 0), ordered.length - 1);
  return ordered[index];
}

/** Result of folding one keypress into help. */
export interface HelpKeyResult {
  state: HelpState;
  action: ListAction;
  entry?: PaletteEntry;
  reason?: string;
}

/**
 * Fold an overlay keypress into help. Movement/accept/close come from the
 * registry's overlay scope; printable input edits the filter, Backspace
 * removes one grapheme, and a disabled row cannot be accepted.
 */
export function handleHelpKey(
  commands: readonly TuiCommand[],
  state: HelpState,
  key: KeyLike,
  entries: readonly PaletteEntry[],
): HelpKeyResult {
  const ordered = orderedHelpEntries(filterHelpEntries(entries, state.query));
  const match = resolveKey(commands, key, "overlay");
  if (match !== null) {
    switch (match.command.id) {
      case "palette":
      case "list-close":
        return { state, action: "close" };
      case "list-accept": {
        if (ordered.length === 0) return { state, action: "none" };
        const index = Math.min(Math.max(Math.floor(state.selected), 0), ordered.length - 1);
        const entry = ordered[index];
        if (entry.disabled) {
          return { state, action: "blocked", entry, reason: entry.disabledReason };
        }
        return { state, action: "accept", entry };
      }
      case "list-move": {
        const delta = match.chord.name.toLowerCase() === "up" ? -1 : 1;
        return { state: movePaletteSelection(state, delta, ordered.length), action: "move" };
      }
      default:
        break;
    }
  }
  if (key.name.toLowerCase() === "backspace" || key.raw === "\u007f" || key.raw === "\b") {
    return { state: setHelpQuery(state, dropLastGrapheme(state.query)), action: "filter" };
  }
  const text = printableKeyText(key);
  if (text !== null) return { state: setHelpQuery(state, state.query + text), action: "filter" };
  return { state, action: "none" };
}

/** Footer hints for help, derived from the registry. */
export function helpHints(commands: readonly TuiCommand[]): string {
  const derived = hintSegments(commands, [
    { id: "list-move", label: "move" },
    { id: "list-accept", label: "run" },
    { id: "list-close", label: "close" },
  ]);
  return derived === "" ? "type to filter" : `${derived} · type to filter`;
}

/** Render options for the help overlay. */
export interface HelpRenderOptions {
  width: number;
  height: number;
  title?: string;
  /** Override the registry-derived footer (tests/embedding). */
  hints?: string;
  /** Theme for the overlay rows (default `plainTheme`). */
  theme?: Theme;
}

/** The rendered help overlay plus its geometry. */
export interface HelpView {
  /** Exactly `height` plain-text rows, each exactly `width` cells. */
  lines: string[];
  visible: PaletteEntry[];
  noMatch: boolean;
  /** Line index of the selected row, or -1 when nothing is selected. */
  selectedRow: number;
  groups: HelpGroup[];
}

interface HelpRow {
  kind: "group" | "entry";
  label: string;
  entry: PaletteEntry | null;
}

function buildHelpRows(groups: readonly HelpGroup[], showGroups: boolean): HelpRow[] {
  const rows: HelpRow[] = [];
  for (const group of groups) {
    if (showGroups) rows.push({ kind: "group", label: `[${group.group}]`, entry: null });
    for (const entry of group.entries) {
      rows.push({ kind: "entry", label: entry.title, entry });
    }
  }
  return rows;
}

/**
 * Render the help overlay into an exact `width × height` cell. Descriptions
 * appear from 64 cells, the slash form from 40, the key column from 30 and
 * group headers from 24; below that rows degrade to a truncated title.
 */
export function helpView(
  commands: readonly TuiCommand[],
  state: HelpState,
  entries: readonly PaletteEntry[],
  options: HelpRenderOptions,
): HelpView {
  const width = Number.isFinite(options.width) ? Math.max(0, Math.floor(options.width)) : 0;
  const height = Number.isFinite(options.height) ? Math.max(0, Math.floor(options.height)) : 0;
  const theme = options.theme ?? plainTheme;
  const filtered = filterHelpEntries(entries, state.query);
  const groups = groupHelpEntries(filtered);
  const ordered = groups.flatMap((group) => group.entries);
  const noMatch = ordered.length === 0;
  const selected = noMatch
    ? -1
    : Math.min(Math.max(Math.floor(state.selected), 0), ordered.length - 1);
  const header = overlayRow(
    theme,
    [{ text: `${options.title ?? "Help"} (${ordered.length})`, tone: "strong" }],
    width,
  );
  const filterLine = overlayRow(
    theme,
    [{ text: "> ", tone: "accent" }, { text: state.query, tone: "text" }],
    width,
  );
  const footer = overlayRow(
    theme,
    [{ text: options.hints ?? helpHints(commands), tone: "dim" }],
    width,
  );
  if (height === 0) {
    return { lines: [], visible: [], noMatch, selectedRow: -1, groups };
  }
  if (height < 3) {
    return {
      lines: [header, filterLine, footer].slice(0, height),
      visible: [],
      noMatch,
      selectedRow: -1,
      groups,
    };
  }

  const listRows = height - 3;
  const showGroups = width >= 24;
  const rows = buildHelpRows(groups, showGroups);
  const selectedEntry = selected >= 0 ? ordered[selected] : undefined;
  let selectedRowInRows = -1;
  if (selectedEntry !== undefined) {
    selectedRowInRows = rows.findIndex(
      (row) => row.kind === "entry" && row.entry === selectedEntry,
    );
  }

  const rendered: string[] = [];
  const visible: PaletteEntry[] = [];
  let selectedRow = -1;
  if (noMatch) {
    const message =
      entries.length === 0
        ? "No commands registered."
        : `No matches for "${state.query}".`;
    const hint = entries.length === 0 ? "" : "Backspace edits the filter · Esc closes.";
    rendered.push(overlayRow(theme, [{ text: message, tone: "muted" }], width));
    if (listRows > 1 && hint !== "") {
      rendered.push(overlayRow(theme, [{ text: hint, tone: "dim" }], width));
    }
    while (rendered.length < listRows) rendered.push(viewPad("", width));
  } else {
    const start = windowStart(rows.length, Math.max(0, selectedRowInRows), listRows);
    const slice = rows.slice(start, start + listRows);
    const entrySlice = slice
      .filter((row): row is HelpRow & { entry: PaletteEntry } => row.entry !== null)
      .map((row) => row.entry);
    const keyWidth = width >= 30 ? entryKeyColumnWidth(entrySlice) : 0;
    const showDescription = width >= 64;
    const showSlash = width >= 40;
    slice.forEach((row, index) => {
      if (row.kind === "group") {
        rendered.push(overlayRow(theme, [{ text: row.label, tone: "accent" }], width));
        return;
      }
      const entry = row.entry;
      if (entry === null) return;
      const isSelected = entry === selectedEntry;
      if (isSelected) selectedRow = 2 + index;
      visible.push(entry);
      rendered.push(
        entryRow(entry, {
          width,
          selected: isSelected,
          keyWidth,
          showDescription,
          showSlash,
          theme,
        }),
      );
    });
    while (rendered.length < listRows) rendered.push(viewPad("", width));
  }

  return {
    lines: [header, filterLine, ...rendered, footer],
    visible,
    noMatch,
    selectedRow,
    groups,
  };
}

/** Convenience wrapper returning only the rendered lines. */
export function renderHelp(
  commands: readonly TuiCommand[],
  state: HelpState,
  entries: readonly PaletteEntry[],
  options: HelpRenderOptions,
): string[] {
  return helpView(commands, state, entries, options).lines;
}