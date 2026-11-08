import { graphemes } from "../editor.ts";
import {
  hintSegments,
  resolveKey,
  TUI_COMMANDS,
  type KeyLike,
  type TuiCommand,
} from "../keymap.ts";
import {
  boxContentWidth,
  clipDisplay,
  fitStyled,
  renderBox,
} from "../screen.ts";
import { plainTheme, type Theme } from "../theme.ts";

export interface PickerItem {
  id: string;
  label: string;
  description?: string;
  keywords?: readonly string[];
  disabled?: boolean;
  disabledReason?: string;
}

export interface PickerState {
  query: string;
  selected: number;
}

export interface PickerKeyResult {
  state: PickerState;
  action: "none" | "move" | "filter" | "close" | "accept" | "blocked";
  item?: PickerItem;
  reason?: string;
}

export interface PickerOptions {
  width: number;
  height: number;
  title?: string;
  emptyText?: string;
  hints?: string;
  theme?: Theme;
  /** Registry commands whose effective chords drive the footer (default `TUI_COMMANDS`). */
  commands?: readonly TuiCommand[];
}

export interface PickerView {
  lines: string[];
  visible: PickerItem[];
  selectedRow: number;
  noMatch: boolean;
}

export function createPickerState(query = ""): PickerState {
  return { query, selected: 0 };
}

export function setPickerQuery(state: PickerState, query: string): PickerState {
  return { query, selected: 0 };
}

/** Case-insensitive multi-token filtering with stable prefix ranking. */
export function filterPickerItems(items: readonly PickerItem[], query: string): PickerItem[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [...items];
  return items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => {
      const haystack = [item.label, item.description ?? "", ...(item.keywords ?? [])].join(" ").toLowerCase();
      return tokens.every((token) => haystack.includes(token));
    })
    .sort((left, right) => {
      const phrase = tokens.join(" ");
      const rank = (item: PickerItem): number => item.label.toLowerCase() === phrase ? 0 : item.label.toLowerCase().startsWith(phrase) ? 1 : 2;
      return rank(left.item) - rank(right.item) || left.index - right.index;
    })
    .map(({ item }) => item);
}

export function movePickerSelection(state: PickerState, delta: number, count: number): PickerState {
  if (count <= 0) return { ...state, selected: 0 };
  const current = Math.min(Math.max(0, Math.floor(state.selected)), count - 1);
  return { ...state, selected: ((current + Math.floor(delta)) % count + count) % count };
}

export function selectedPickerItem(state: PickerState, items: readonly PickerItem[]): PickerItem | undefined {
  if (items.length === 0) return undefined;
  return items[Math.min(Math.max(0, Math.floor(state.selected)), items.length - 1)];
}

function printableKey(key: KeyLike): string | null {
  const raw = key.raw ?? "";
  if (key.ctrl === true || key.alt === true || raw === "" || raw.startsWith("\u001b")) return null;
  return /[\u0000-\u001f\u007f]/.test(raw) ? null : raw;
}

/** Fold a registry-resolved overlay key into filtering, movement or acceptance. */
export function handlePickerKey(
  state: PickerState,
  key: KeyLike,
  items: readonly PickerItem[],
  commands: readonly TuiCommand[] = TUI_COMMANDS,
): PickerKeyResult {
  const filtered = filterPickerItems(items, state.query);
  const match = resolveKey(commands, key, "overlay");
  if (match?.command.id === "list-close" || match?.command.id === "palette") {
    return { state, action: "close" };
  }
  if (match?.command.id === "list-move") {
    const delta = match.chord.name.toLowerCase() === "up" ? -1 : 1;
    return { state: movePickerSelection(state, delta, filtered.length), action: "move" };
  }
  if (match?.command.id === "list-accept") {
    const item = selectedPickerItem(state, filtered);
    if (item === undefined) return { state, action: "none" };
    if (item.disabled === true) return { state, action: "blocked", item, ...(item.disabledReason !== undefined ? { reason: item.disabledReason } : {}) };
    return { state, action: "accept", item };
  }
  const name = key.name.toLowerCase();
  if (name === "backspace" || key.raw === "\u007f" || key.raw === "\b") {
    const units = graphemes(state.query);
    units.pop();
    return { state: setPickerQuery(state, units.join("")), action: "filter" };
  }
  const text = printableKey(key);
  return text === null
    ? { state, action: "none" }
    : { state: setPickerQuery(state, state.query + text), action: "filter" };
}

function windowStart(total: number, selected: number, height: number): number {
  if (height <= 0 || total <= height) return 0;
  return Math.min(Math.max(0, selected - Math.floor(height / 2)), total - height);
}

/** Render a scrollable picker into an exact width × height box. */
export function pickerView(
  state: PickerState,
  items: readonly PickerItem[],
  options: PickerOptions,
): PickerView {
  const width = Math.max(0, Math.floor(options.width));
  const height = Math.max(0, Math.floor(options.height));
  if (width === 0 || height === 0) return { lines: [], visible: [], selectedRow: -1, noMatch: filterPickerItems(items, state.query).length === 0 };
  const theme = options.theme ?? plainTheme;
  const contentWidth = Math.max(1, boxContentWidth(width));
  const filtered = filterPickerItems(items, state.query);
  const selected = filtered.length === 0 ? -1 : Math.min(Math.max(0, Math.floor(state.selected)), filtered.length - 1);
  const query = theme.paint("accent", clipDisplay(`> ${state.query}`, contentWidth));
  const defaultHints = hintSegments(options.commands ?? TUI_COMMANDS, [
    { id: "list-move", label: "move" },
    { id: "list-accept", label: "select" },
    { id: "list-close", label: "close" },
  ]);
  const footer = theme.paint("dim", clipDisplay(options.hints ?? defaultHints, contentWidth));
  const capacity = Math.max(0, height - 4);
  const rows: string[] = [];
  const visible: PickerItem[] = [];
  let selectedRow = -1;

  if (filtered.length === 0) {
    const message = items.length === 0 ? options.emptyText ?? "No items available." : `No matches for "${state.query}".`;
    rows.push(theme.paint("muted", clipDisplay(message, contentWidth)));
  } else if (capacity > 0) {
    const start = windowStart(filtered.length, selected, capacity);
    const slice = filtered.slice(start, start + capacity);
    slice.forEach((item, index) => {
      const isSelected = start + index === selected;
      const description = width >= 48 && item.description !== undefined ? ` — ${item.description}` : "";
      const disabled = item.disabled === true ? " [unavailable]" : "";
      const marker = isSelected ? "› " : "  ";
      const text = clipDisplay(`${marker}${item.label}${description}${disabled}`, contentWidth);
      rows.push(theme.paint(item.disabled === true ? "muted" : isSelected ? "focus" : "text", text));
      visible.push(item);
      if (isSelected) selectedRow = rows.length + 1;
    });
  }
  while (rows.length < capacity) rows.push("");
  const body = [query, ...rows.slice(0, capacity), footer];
  while (body.length < Math.max(0, height - 2)) body.push("");
  const lines = renderBox(body.slice(0, Math.max(0, height - 2)), {
    width,
    title: options.title ?? "SELECT",
    theme,
    tone: "border",
  }).slice(0, height);
  while (lines.length < height) lines.push("");
  return {
    lines: lines.map((row) => fitStyled(row, width)),
    visible,
    selectedRow,
    noMatch: filtered.length === 0,
  };
}

export function renderPicker(state: PickerState, items: readonly PickerItem[], options: PickerOptions): string[] {
  return pickerView(state, items, options).lines;
}
