/**
 * Pure in-TUI key-binding editor (`/keys edit`).
 *
 * One small dialog lists the three rebindable global chords — the command
 * palette, the shortcut reference and the draft stash — with their effective
 * keys. Enter on a row enters capture mode; the next complete chord is handed
 * to the app as an intent, and the app validates/persists it through the same
 * keys-file schema the loader reads. Escape cancels a capture without closing
 * the dialog (the web Settings → Keyboard rule) and closes the dialog while
 * browsing.
 *
 * Capture is terminal-honest and repeat-safe: a held key (terminal repeat flag),
 * a bare modifier press, a bracketed paste and an unrepresentable key never
 * become a binding; a chord the terminal reports is parsed by the keys-file
 * grammar, so whatever the dialog accepts the file can store. Everything else —
 * typing, Escape/quit layering, pickers, the approval panel, find — stays fixed
 * by design and is never editable here.
 *
 * This module is deterministic and terminal-free: it returns intents and never
 * writes a file. `keyoverrides.ts` owns capture parsing, validation and the
 * atomic save; the app wires the dialog into the overlay stack.
 */
import {
  formatKeys,
  hintSegments,
  TUI_COMMANDS,
  type KeyChord,
  type KeyLike,
  type TuiCommand,
} from "../keymap.ts";
import {
  captureTuiChord,
  REBINDABLE_TUI_COMMAND_IDS,
  type RebindableTuiCommandId,
  type TuiKeysLoadState,
  type TuiKeysSource,
} from "../keyoverrides.ts";
import {
  boxContentWidth,
  clipDisplay,
  fitStyled,
  padDisplay,
  renderBox,
  textWidth,
  wrapDisplay,
} from "../screen.ts";
import { plainTheme, type Theme, type ThemeToken } from "../theme.ts";

/** One editor row: a rebindable command, or the trailing reset action. */
export type KeysEditorRow =
  | { kind: "command"; id: RebindableTuiCommandId; title: string; keys: string }
  | { kind: "reset" };

/** The fixed trailing row that returns all three chords to their defaults. */
export const KEYS_EDITOR_RESET_LABEL = "[ Reset all three to defaults ]";

/** Every row in registry order (three commands, then reset). */
export function keysEditorRows(commands: readonly TuiCommand[] = TUI_COMMANDS): KeysEditorRow[] {
  const rows: KeysEditorRow[] = REBINDABLE_TUI_COMMAND_IDS.map((id) => {
    const command = commands.find((candidate) => candidate.id === id);
    const keys = command === undefined ? "(unbound)" : formatKeys(command) || "(unbound)";
    return { kind: "command" as const, id, title: command?.title ?? id, keys };
  });
  rows.push({ kind: "reset" });
  return rows;
}

/** Rows callers can select (used for Up/Down wrapping and bounds). */
export function keysEditorRowCount(): number {
  return REBINDABLE_TUI_COMMAND_IDS.length + 1;
}

/** Which stage the dialog is in. */
export type KeysEditorPhase = "slots" | "capture";

/** Immutable editor state (no callbacks, no I/O). */
export interface KeysEditorState {
  phase: KeysEditorPhase;
  /** Selected row index (0..2 command slots, 3 reset). */
  selected: number;
  /** Command awaiting a chord while `phase === "capture"`. */
  capturing: RebindableTuiCommandId | null;
  /** Real rejection/save error shown verbatim (cleared by the next action). */
  error: string | null;
  /** Last successful action, shown as an informational status line. */
  notice: string | null;
}

/** Everything the dialog reports about the configured keys file. */
export interface KeysEditorData {
  /** The startup-captured source (the app refuses to open the dialog without one). */
  source: TuiKeysSource;
  /** Effective command table: fills each row's current chord and the hints. */
  commands: readonly TuiCommand[];
  /** Load state at open/save time (`loaded`, `missing`; never `invalid`). */
  state: TuiKeysLoadState;
}

/** Intents the app acts on; the view never persists anything. */
export type KeysEditorAction =
  | { type: "none" }
  | { type: "close" }
  | { type: "cancel-capture" }
  | { type: "capture-start"; command: RebindableTuiCommandId }
  | { type: "accept"; command: RebindableTuiCommandId; chord: KeyChord }
  | { type: "reset-all" };

/** A fresh editor on the first slot, showing its current chords. */
export function createKeysEditorState(): KeysEditorState {
  return { phase: "slots", selected: 0, capturing: null, error: null, notice: null };
}

function clampSelection(selected: number): number {
  const max = keysEditorRowCount() - 1;
  return Math.min(Math.max(0, Math.floor(selected)), max);
}

/**
 * Re-enter capture on `command` with the real rejection message. Used when the
 * app refuses a captured chord (fixed-key/other-global conflict, save error):
 * the dialog stays open, the capture stays active for another attempt and
 * nothing on disk changed.
 */
export function setKeysEditorError(
  state: KeysEditorState,
  command: RebindableTuiCommandId,
  error: string,
): KeysEditorState {
  return {
    ...state,
    phase: "capture",
    capturing: command,
    selected: Math.max(0, REBINDABLE_TUI_COMMAND_IDS.indexOf(command)),
    error,
    notice: null,
  };
}

/** Show a save/refresh error while browsing (used when there is no capture). */
export function setKeysEditorSaveError(state: KeysEditorState, error: string): KeysEditorState {
  return { ...state, phase: "slots", capturing: null, error, notice: null };
}

/** Report one applied change; the app has already written and re-read the file. */
export function setKeysEditorSaved(state: KeysEditorState, notice: string): KeysEditorState {
  return { ...state, phase: "slots", capturing: null, error: null, notice };
}

/**
 * Fold one keypress into the dialog.
 *
 * Capturing claims every key: Escape (or Ctrl+C) cancels only the capture,
 * auto-repeats/modifier-only presses/pastes keep waiting, and the first
 * complete chord becomes an `accept` intent. Browsing: Escape closes, Up/Down
 * move (wrapping), Enter/Space opens a slot's capture or performs the reset.
 */
export function keysEditorKey(
  state: KeysEditorState,
  key: KeyLike,
): { state: KeysEditorState; action: KeysEditorAction } {
  const name = (key.name ?? "").toLowerCase();
  if (state.phase === "capture") {
    const command = state.capturing;
    if (command === null) {
      return { state: { ...state, phase: "slots" }, action: { type: "none" } };
    }
    if (name === "escape" || name === "esc" || (key.ctrl === true && name === "c")) {
      return {
        state: {
          ...state,
          phase: "slots",
          capturing: null,
          error: null,
          notice: "capture cancelled — the chord was not changed",
        },
        action: { type: "cancel-capture" },
      };
    }
    const captured = captureTuiChord(key);
    if (!captured.ok) {
      if (
        captured.reason === "repeat" ||
        captured.reason === "modifier-only" ||
        captured.reason === "paste"
      ) {
        return { state, action: { type: "none" } };
      }
      return {
        state: {
          ...state,
          error: captured.detail ?? "that key cannot be stored in the keys file",
        },
        action: { type: "none" },
      };
    }
    return {
      state: { ...state, phase: "slots", capturing: null, error: null, notice: null },
      action: { type: "accept", command, chord: captured.chord },
    };
  }

  if (name === "escape" || name === "esc") return { state, action: { type: "close" } };
  if (name === "up" || name === "down") {
    const count = keysEditorRowCount();
    const selected = ((state.selected + (name === "up" ? -1 : 1)) % count + count) % count;
    return { state: { ...state, selected }, action: { type: "none" } };
  }
  if (name === "return" || name === "enter" || name === "space" || name === " ") {
    const selected = clampSelection(state.selected);
    if (selected < REBINDABLE_TUI_COMMAND_IDS.length) {
      const command = REBINDABLE_TUI_COMMAND_IDS[selected];
      if (command === undefined) return { state, action: { type: "none" } };
      return {
        state: {
          ...state,
          phase: "capture",
          capturing: command,
          selected,
          error: null,
          notice: null,
        },
        action: { type: "capture-start", command },
      };
    }
    return { state: { ...state, error: null, notice: null }, action: { type: "reset-all" } };
  }
  return { state, action: { type: "none" } };
}

/** Options for {@link keysEditorView}. */
export interface KeysEditorViewOptions {
  width: number;
  height?: number;
  theme?: Theme;
}

/** One rendered frame. */
export interface KeysEditorView {
  lines: string[];
  selectedRow: number;
}

const COPY =
  "The three global chords can be changed here. Typing, Escape/quit, pickers, " +
  "the approval panel and find keep their fixed keys.";

function sourceLines(data: KeysEditorData): [string, string] {
  const file = `file: ${data.source.path} (${data.source.origin})`;
  const state =
    data.state === "missing"
      ? "state: missing — saving creates it"
      : data.state === "invalid"
        ? "state: invalid — fix or remove it, then /keys reload"
        : "state: loaded";
  return [file, state];
}

function footerHints(state: KeysEditorState, commands: readonly TuiCommand[]): string {
  if (state.phase === "capture") {
    return `press the new chord · ${hintSegments(commands, [
      { id: "list-close", label: "cancels the capture" },
    ])}`;
  }
  return hintSegments(commands, [
    { id: "list-move", label: "move" },
    { id: "list-accept", label: "change" },
    { id: "list-close", label: "close" },
  ]);
}

function windowStart(total: number, selected: number, capacity: number): number {
  if (capacity <= 0 || total <= capacity) return 0;
  return Math.min(Math.max(0, selected - Math.floor(capacity / 2)), total - capacity);
}

function rowLabel(state: KeysEditorState, row: KeysEditorRow, titleWidth: number): string {
  if (row.kind === "reset") return KEYS_EDITOR_RESET_LABEL;
  const capturing = state.phase === "capture" && state.capturing === row.id;
  const keys = capturing ? "press keys…" : row.keys;
  const title = padDisplay(clipDisplay(row.title, titleWidth), titleWidth);
  return `${title}  ${keys}`;
}

/**
 * Render one frame into a bordered box. The box is bounded by the caller's
 * terminal width, the body is windowed to the requested height, and every row
 * is clipped to the box's content width (so narrow columns stay width-safe).
 */
export function keysEditorView(
  state: KeysEditorState,
  data: KeysEditorData,
  options: KeysEditorViewOptions,
): KeysEditorView {
  const width = Math.max(0, Math.floor(options.width));
  if (width === 0) return { lines: [], selectedRow: -1 };
  const theme = options.theme ?? plainTheme;
  const height = options.height === undefined ? undefined : Math.max(0, Math.floor(options.height));
  const contentWidth = Math.max(1, boxContentWidth(width));
  const paint = (token: ThemeToken, text: string): string => theme.paint(token, text);

  const [fileLine, stateLine] = sourceLines(data);
  const header = [
    ...wrapDisplay(COPY, contentWidth).map((row) => paint("text", row)),
    paint("dim", clipDisplay(fileLine, contentWidth)),
    paint("dim", clipDisplay(stateLine, contentWidth)),
    "",
  ];

  const rows = keysEditorRows(data.commands);
  const titles = rows.flatMap((row) => (row.kind === "command" ? [textWidth(row.title)] : []));
  const titleWidth = Math.min(26, Math.max(4, ...titles));
  const statusRows: string[] = [];
  if (state.error !== null) {
    for (const row of wrapDisplay(`error: ${state.error}`, contentWidth)) {
      statusRows.push(paint("warning", row));
    }
  } else if (state.notice !== null) {
    for (const row of wrapDisplay(state.notice, contentWidth)) {
      statusRows.push(paint("dim", row));
    }
  }
  const footer = paint("dim", clipDisplay(footerHints(state, data.commands), contentWidth));
  const reserved = header.length + statusRows.length + 3;
  const capacity = Math.max(1, (height ?? 20) - reserved);
  const start = windowStart(rows.length, state.selected, capacity);
  const body: string[] = [];
  for (let index = start; index < Math.min(rows.length, start + capacity); index += 1) {
    const row = rows[index];
    if (row === undefined) continue;
    const isSelected = index === state.selected;
    const marker = isSelected ? "› " : "  ";
    const label = rowLabel(state, row, titleWidth);
    body.push(
      paint(isSelected ? "focus" : "text", clipDisplay(`${marker}${label}`, contentWidth)),
    );
  }

  const content = [...header, ...body, ...statusRows, "", footer];
  while (height !== undefined && content.length < Math.max(0, height - 2)) content.push("");
  const lines = renderBox(content, { width, title: "KEY BINDINGS", theme });
  if (height !== undefined) {
    lines.splice(height);
    while (lines.length < height) lines.push(fitStyled("", width));
  }
  const selectedRow = body.length === 0 ? -1 : header.length + (state.selected - start) + 1;
  return { lines, selectedRow: Math.min(selectedRow, lines.length - 1) };
}

/** Convenience wrapper for callers that only need the rows. */
export function keysEditorLines(
  state: KeysEditorState,
  data: KeysEditorData,
  options: KeysEditorViewOptions,
): string[] {
  return keysEditorView(state, data, options).lines;
}
