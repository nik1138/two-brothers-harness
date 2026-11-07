import {
  codeUnitOffset,
  graphemes,
  type EditorState,
} from "../editor.ts";
import { hintSegments, TUI_COMMANDS } from "../keymap.ts";
import {
  boxContentWidth,
  renderBox,
  sanitizeDisplayText,
  styledWidth,
  wrapDisplay,
} from "../screen.ts";
import { truncateToWidth } from "../text.ts";
import { plainTheme, type Theme } from "../theme.ts";

export interface ComposerOptions {
  width: number;
  editor: EditorState;
  /**
   * Accepted for embedding compatibility; deliberately not rendered. The
   * two-line status bar already carries mode and both role models, and a second
   * copy inside the composer only cost two message rows at every width.
   */
  mode?: string;
  seniorModel?: string;
  juniorModel?: string;
  running?: boolean;
  disabled?: boolean;
  placeholder?: string;
  /** Maximum visible input rows, excluding model/help chrome. Default 5. */
  maxRows?: number;
  showCursor?: boolean;
  theme?: Theme;
}

export interface ComposerView {
  lines: string[];
  /** Cursor row within the visible input rows, or -1 when hidden. */
  cursorRow: number;
  cursorColumn: number;
  inputStart: number;
  inputRows: number;
  hiddenBefore: number;
  hiddenAfter: number;
}

function paintInputRow(row: string, column: number | null, theme: Theme): string {
  if (column === null) return theme.paint("text", row);
  const prefix = truncateToWidth(row, Math.max(0, column), "");
  const units = graphemes(row.slice(prefix.length));
  const head = units.shift() ?? " ";
  return theme.paint("text", prefix) + theme.inverse(head) + theme.paint("text", units.join(""));
}

/** Render a contained editor while leaving its full draft and history intact. */
export function composerView(options: ComposerOptions): ComposerView {
  const width = Math.max(0, Math.floor(options.width));
  if (width === 0) {
    return { lines: [], cursorRow: -1, cursorColumn: 0, inputStart: 0, inputRows: 0, hiddenBefore: 0, hiddenAfter: 0 };
  }
  const theme = options.theme ?? plainTheme;
  const contentWidth = Math.max(1, boxContentWidth(width));
  const clean = sanitizeDisplayText(options.editor.text);
  const cursorOffset = codeUnitOffset(options.editor.text, options.editor.cursor);
  const before = sanitizeDisplayText(options.editor.text.slice(0, cursorOffset));
  const cursorVisible = options.showCursor !== false && options.disabled !== true && options.running !== true;

  const allRows = wrapDisplay(clean, contentWidth);
  const beforeRows = wrapDisplay(before, contentWidth);
  let cursorRow = beforeRows.length - 1;
  let cursorColumn = styledWidth(beforeRows[cursorRow] ?? "");
  if (cursorVisible && cursorColumn >= contentWidth) {
    cursorRow += 1;
    cursorColumn = 0;
    if (cursorRow >= allRows.length) allRows.push("");
  }

  const maxRows = Math.max(1, Math.floor(options.maxRows ?? 5));
  const maxStart = Math.max(0, allRows.length - maxRows);
  const inputStart = cursorVisible
    ? Math.min(Math.max(0, cursorRow - maxRows + 1), maxStart)
    : 0;
  const visible = allRows.slice(inputStart, inputStart + maxRows);
  const visibleCursor = cursorRow - inputStart;
  const inputRows = visible.map((row, index) => {
    if (clean === "" && index === 0) {
      const placeholder = options.placeholder ?? "Type a task…";
      return paintInputRow(placeholder, cursorVisible ? 0 : null, theme);
    }
    return paintInputRow(row, cursorVisible && index === visibleCursor ? cursorColumn : null, theme);
  });

  const hint = options.running === true
    ? `Turn running · ${hintSegments(TUI_COMMANDS, [{ id: "cancel", label: "cancel" }])}`
    : options.disabled === true
      ? "Composer unavailable"
      : hintSegments(TUI_COMMANDS, [
          { id: "submit", label: "send" },
          { id: "newline", label: "newline" },
        ]);
  const hintRows = wrapDisplay(hint, contentWidth).map((row) => theme.paint("dim", row));
  // The message box is input plus the turn-state hint; mode/models live in the
  // status bar only, so no row here repeats them.
  const body = [...inputRows, "", ...hintRows];
  const title = `MESSAGE${options.running === true ? " · RUNNING" : ""}`;

  return {
    lines: renderBox(body, { width, title, theme, tone: options.running === true ? "warning" : "border" }),
    cursorRow: cursorVisible && visibleCursor >= 0 && visibleCursor < visible.length ? visibleCursor : -1,
    cursorColumn: cursorVisible ? cursorColumn : 0,
    inputStart,
    inputRows: visible.length,
    hiddenBefore: inputStart,
    hiddenAfter: Math.max(0, allRows.length - inputStart - visible.length),
  };
}

export function renderComposer(options: ComposerOptions): string[] {
  return composerView(options).lines;
}
