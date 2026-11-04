/**
 * Pure render layer for the full-screen TUI.
 *
 * No I/O happens here: every function takes plain data and returns a string,
 * so the whole layout — wrapping, scroll windowing, the header/status bars —
 * is unit-testable without a terminal. `terminal.ts` writes these frames and
 * owns the escape sequences' timing; `app.ts` owns the state machine.
 *
 * The frame contract (`renderFrame`):
 *
 *   header bar        inverse video: mode, both models, session name
 *   separator
 *   body              the wrapped lines, newest at the bottom; `scrollOffset`
 *                     scrolls UP from that bottom anchor (0 = pinned)
 *   separator
 *   input line        `> ` + the typed text + a block cursor
 *   status bar        the app's one-line status
 *
 * Given the same `TuiState` the output is byte-identical (no clocks, no
 * randomness, no environment reads), which is what `tests/tui.test.ts`
 * asserts.
 *
 * ANSI escape bytes appear only in the exported {@link ANSI} constants; the
 * rest of the module (and `terminal.ts`, which imports them) never spells an
 * escape sequence inline, and a `plain` render option drops them entirely so
 * redirected output stays readable.
 */

/** Who produced a chat line (drives the color and the tests). */
export type TuiLineKind = "user" | "senior" | "junior" | "tool" | "system" | "error";

/** One logical chat line; `renderFrame` wraps it to the terminal width. */
export interface TuiLine {
  kind: TuiLineKind;
  text: string;
}

/** The one-line header's fields. */
export interface TuiHeader {
  mode: string;
  seniorModel: string;
  juniorModel: string;
  sessionName: string;
}

/** Everything `renderFrame` needs. Pure data — no streams, no timers. */
export interface TuiState {
  header: TuiHeader;
  lines: TuiLine[];
  /** The text being typed on the input line (without the `> ` prompt). */
  input: string;
  /** One-line status message shown in the bottom bar. */
  status: string;
  /** Rows scrolled up from the newest line: 0 = newest at the bottom. */
  scrollOffset: number;
  height: number;
  width: number;
}

/** Options for the render/wrap helpers. */
export interface RenderOptions {
  /** Strip every ANSI escape (tests, redirects, log capture). Default false. */
  plain?: boolean;
}

const ESC = "\x1b";

/**
 * Every escape sequence the TUI writes. Declared once here so a grep for
 * `\x1b` in the tree finds this block and nothing else.
 */
export const ANSI = {
  esc: ESC,
  reset: `${ESC}[0m`,
  bold: `${ESC}[1m`,
  dim: `${ESC}[2m`,
  inverse: `${ESC}[7m`,
  red: `${ESC}[31m`,
  green: `${ESC}[32m`,
  yellow: `${ESC}[33m`,
  magenta: `${ESC}[35m`,
  cyan: `${ESC}[36m`,
  cursorHome: `${ESC}[H`,
  clearScreen: `${ESC}[2J${ESC}[H`,
  clearBelow: `${ESC}[J`,
  altScreenOn: `${ESC}[?1049h`,
  altScreenOff: `${ESC}[?1049l`,
  hideCursor: `${ESC}[?25l`,
  showCursor: `${ESC}[?25h`,
} as const;

/** Reset code exported separately: the frame builder appends it per line. */
export const RESET = ANSI.reset;

/** Block glyph marking the cursor position on the input line. */
export const CURSOR = "▏";

/** Color per line kind (u=user, senior, junior, tools, system, errors). */
export const KIND_STYLE: Record<TuiLineKind, string> = {
  user: ANSI.cyan,
  senior: ANSI.green,
  junior: ANSI.yellow,
  tool: ANSI.magenta,
  system: ANSI.dim,
  error: ANSI.red,
};

/** Every kind in display order (used by tests and future legends). */
export const LINE_KINDS: readonly TuiLineKind[] = [
  "user",
  "senior",
  "junior",
  "tool",
  "system",
  "error",
];

const ANSI_RE = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, "g");

/** Remove every CSI escape sequence from `text`. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

/**
 * Model output may carry escapes (or CRLF); the renderer speaks plain text
 * only. Tabs expand to four spaces so width math stays predictable.
 */
function sanitizeText(text: string): string {
  return stripAnsi(text).replace(/\r\n?/g, "\n").replace(/\t/g, "    ");
}

/**
 * Greedy word wrap of one plain paragraph. Words longer than `width` are
 * hard-split (a URL never disappears), and the space at a break is consumed.
 */
function wrapParagraph(text: string, width: number): string[] {
  if (text === "") return [""];
  const out: string[] = [];
  let rest = text;
  while (rest.length > width) {
    const breakAt = rest.lastIndexOf(" ", width);
    if (breakAt <= 0) {
      out.push(rest.slice(0, width));
      rest = rest.slice(width);
    } else {
      out.push(rest.slice(0, breakAt));
      rest = rest.slice(breakAt + 1);
    }
    rest = rest.replace(/^ +/, "");
  }
  out.push(rest);
  return out;
}

/**
 * Wrap one logical line to `width` terminal columns, returning display rows.
 *
 * Each row carries the kind's color prefix and a reset, so colors never count
 * toward the width (the prefix is zero columns). Explicit `\n` in the text
 * starts a new paragraph; a blank paragraph is one blank row. `plain` drops
 * the color codes and returns the bare text rows.
 */
export function wrapLine(
  line: TuiLine,
  width: number,
  options: RenderOptions = {},
): string[] {
  const columns = Math.max(1, Math.floor(width));
  const text = sanitizeText(line.text ?? "");
  const paragraphs = text.split("\n");
  const rows: string[] = [];
  for (const paragraph of paragraphs) {
    for (const row of wrapParagraph(paragraph, columns)) rows.push(row);
  }
  if (options.plain === true) return rows;
  const prefix = KIND_STYLE[line.kind];
  return rows.map((row) => `${prefix}${row}${RESET}`);
}

/** Cut or pad a plain string to exactly `width` columns. */
function fit(text: string, width: number): string {
  if (text.length > width) return text.slice(0, width);
  return text.padEnd(width, " ");
}

function nonEmpty(value: string | undefined, fallback: string): string {
  const text = (value ?? "").trim();
  return text === "" ? fallback : text;
}

/**
 * Render one full frame. The frame is deterministic for a given state and
 * has exactly `height` rows for terminals of five rows or more; a shorter
 * terminal gets a degraded header/input/status frame.
 *
 * `scrollOffset` is measured in wrapped rows from the bottom: 0 keeps the
 * newest output pinned to the bottom, a positive value scrolls into history.
 * The offset is clamped, so an over-scroll simply shows the oldest rows.
 */
export function renderFrame(state: TuiState, options: RenderOptions = {}): string {
  const width = Math.max(1, Math.floor(state.width));
  const height = Math.max(0, Math.floor(state.height));
  if (height === 0) return "";
  const plain = options.plain === true;
  const style = (code: string, text: string): string =>
    plain ? text : `${code}${text}${RESET}`;

  const headerText =
    `two-brothers  mode=${nonEmpty(state.header.mode, "consult")}  ` +
    `senior=${nonEmpty(state.header.seniorModel, "(unset)")}  ` +
    `junior=${nonEmpty(state.header.juniorModel, "(unset)")}  ` +
    `session=${nonEmpty(state.header.sessionName, "in-memory")}`;
  const headerLine = style(ANSI.inverse, fit(headerText, width));
  const separator = style(ANSI.dim, "─".repeat(width));

  const pool: string[] = [];
  for (const line of state.lines) {
    for (const row of wrapLine(line, width, options)) pool.push(row);
  }
  const bodyRows = Math.max(0, height - 5);
  const maxOffset = Math.max(0, pool.length - bodyRows);
  const offset = Math.min(Math.max(0, Math.floor(state.scrollOffset)), maxOffset);
  const end = Math.max(0, pool.length - offset);
  const start = Math.max(0, end - bodyRows);
  const visible = pool.slice(start, end);
  const body: string[] = [];
  for (let i = visible.length; i < bodyRows; i += 1) body.push("");
  body.push(...visible);

  const prompt = "> ";
  const available = Math.max(1, width - prompt.length - CURSOR.length);
  const input = sanitizeText(state.input ?? "").replace(/\n/g, " ");
  const visibleInput = input.length > available ? input.slice(input.length - available) : input;
  const inputText = `${prompt}${visibleInput}${CURSOR}`.slice(0, width);
  const inputLine = plain
    ? inputText
    : `${KIND_STYLE.user}${prompt}${visibleInput}${ANSI.inverse}${CURSOR}${ANSI.reset}${RESET}`;

  const scrollNote = offset > 0 ? `[scroll ↑${offset}] ` : "";
  const statusText = fit(`${scrollNote}${sanitizeText(state.status ?? "")}`, width);
  const statusLine = style(ANSI.dim, statusText);

  const rows = [headerLine, separator, ...body, separator, inputLine, statusLine];
  if (rows.length > height) {
    // A terminal too short for the full chrome (height < 5): header, input
    // and status are the rows an operator must keep.
    return [headerLine, inputLine, statusLine].slice(0, height).join("\n");
  }
  return rows.join("\n");
}

/**
 * Return a new state with `line` appended. Immutable: the input state is
 * never modified, which keeps the reducer-style app code easy to test.
 */
export function pushLine(state: TuiState, line: TuiLine): TuiState {
  return { ...state, lines: [...state.lines, line] };
}

/**
 * Append streamed text to the last line when it has the same kind, else
 * start a new line. Immutable like {@link pushLine}; used for token deltas
 * (and any other in-place accumulation).
 */
export function appendText(state: TuiState, kind: TuiLineKind, text: string): TuiState {
  const lines = state.lines.slice();
  const last = lines[lines.length - 1];
  if (last !== undefined && last.kind === kind) {
    lines[lines.length - 1] = { kind, text: last.text + text };
  } else {
    lines.push({ kind, text });
  }
  return { ...state, lines };
}