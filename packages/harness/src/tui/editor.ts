/**
 * Pure multiline prompt editor for the TUI composer.
 *
 * Everything here is data in / data out: no terminal, no timers, no streams.
 * `app.ts` folds keypresses through {@link handleEditorKey}, renders the
 * resulting text, and calls {@link takeSubmission} when the user sends a turn.
 * The module is deliberately independent of `terminal.ts`: its `EditorKey`
 * shape is structurally compatible with the driver's `Key`, so a future
 * `input.ts` split can pass either.
 *
 * Cursor and editing math is **grapheme based** (`Intl.Segmenter` with a
 * compact fallback), so a CJK character, a combining accent or an emoji ZWJ
 * family is always inserted, deleted and stepped over as one unit. Positions
 * are grapheme indices; {@link codeUnitOffset} converts one for rendering.
 *
 * Newline vs submit is an action, not a side effect: Enter yields the
 * `"submit"` action and leaves the text alone (the app decides what to do),
 * while Shift+Enter / Alt+Enter / Ctrl+J insert a newline. Pasted text —
 * including bracketed-paste chunks, CRLF input and multi-character chunks
 * from the input parser — is normalized and inserted as one edit that can
 * never submit.
 *
 * Caps are deliberate: {@link DEFAULT_EDITOR_MAX_CHARS} per draft and
 * {@link DEFAULT_EDITOR_MAX_HISTORY} recalled entries. Insertions are clipped
 * on a grapheme boundary, never mid-character; history is newest-last,
 * deduplicates consecutive repeats, and preserves the live draft while the
 * user browses it.
 */

/** One keypress, structurally compatible with `terminal.ts`'s `Key`. */
export interface EditorKey {
  /** `readline` key name (`return`, `backspace`, `left`, …). */
  name: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  /** Raw escape sequence / character / paste chunk. */
  raw: string;
}

/** Immutable editor state; every exported operation returns a new object. */
export interface EditorState {
  /** The full draft, newlines included. */
  text: string;
  /** Cursor position as a grapheme index in `0..graphemeCount(text)`. */
  cursor: number;
  /** Submitted prompt history, oldest first, bounded. */
  history: readonly string[];
  /** Index into `history` while browsing; `null` means the live draft. */
  historyIndex: number | null;
  /** Live draft saved when history browsing started. */
  draft: string;
}

/** Caps for one editor instance. */
export interface EditorOptions {
  /** Maximum draft length in UTF-16 code units (default 16 384). */
  maxChars?: number;
  /** Maximum recalled history entries (default 100; 0 disables history). */
  maxHistory?: number;
}

/** Default draft cap: large enough for a long paste, small enough to bound RAM. */
export const DEFAULT_EDITOR_MAX_CHARS = 16_384;

/** Default history depth. */
export const DEFAULT_EDITOR_MAX_HISTORY = 100;

/** One editing step's non-editing effect, interpreted by the app. */
export type EditorAction =
  | "none"
  | "submit"
  | "newline"
  | "paste"
  | "history-prev"
  | "history-next"
  | "scroll-prev"
  | "scroll-next"
  | "cancel"
  | "complete"
  | "ignore";

/** Result of folding one keypress into the editor. */
export interface EditorKeyResult {
  state: EditorState;
  action: EditorAction;
}

/** The text a submission consumed plus the cleared editor. */
export interface EditorSubmission {
  text: string;
  state: EditorState;
}

/** A cursor position split into a logical line and grapheme column. */
export interface EditorCursorPosition {
  line: number;
  column: number;
}

// --------------------------------------------------------------------------- //
// grapheme segmentation
// --------------------------------------------------------------------------- //

interface GraphemeSegment {
  segment: string;
}

interface GraphemeSegmenter {
  segment(input: string): Iterable<GraphemeSegment>;
}

type SegmenterConstructor = new (
  locales?: string | string[],
  options?: { granularity?: "grapheme" },
) => GraphemeSegmenter;

let cachedSegmenter: GraphemeSegmenter | null | undefined;

function graphemeSegmenter(): GraphemeSegmenter | null {
  if (cachedSegmenter !== undefined) return cachedSegmenter;
  const ctor = (Intl as unknown as { Segmenter?: SegmenterConstructor }).Segmenter;
  cachedSegmenter =
    typeof ctor === "function" ? new ctor(undefined, { granularity: "grapheme" }) : null;
  return cachedSegmenter;
}

/** True for code points that extend the preceding grapheme. */
function isExtend(cp: number): boolean {
  return (
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x0483 && cp <= 0x0489) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    (cp >= 0xfe20 && cp <= 0xfe2f) ||
    (cp >= 0x1f3fb && cp <= 0x1f3ff) ||
    cp === 0x20e3 ||
    (cp >= 0xe0100 && cp <= 0xe01ef)
  );
}

function isRegionalIndicator(cp: number): boolean {
  return cp >= 0x1f1e6 && cp <= 0x1f1ff;
}

/**
 * Deterministic fallback segmentation for runtimes without `Intl.Segmenter`.
 * Covers combining marks, variation selectors, emoji modifiers, ZWJ
 * sequences and regional-indicator flag pairs.
 */
function fallbackGraphemes(text: string): string[] {
  const out: string[] = [];
  let current = "";
  let previous = -1;
  let regionalRun = 0;
  for (const char of text) {
    const cp = char.codePointAt(0) ?? 0;
    if (current === "") {
      current = char;
      previous = cp;
      regionalRun = isRegionalIndicator(cp) ? 1 : 0;
      continue;
    }
    const joins =
      isExtend(cp) ||
      cp === 0x200d ||
      previous === 0x200d ||
      (isRegionalIndicator(cp) && isRegionalIndicator(previous) && regionalRun % 2 === 1);
    if (joins) {
      current += char;
      if (isRegionalIndicator(cp)) regionalRun += 1;
    } else {
      out.push(current);
      current = char;
      regionalRun = isRegionalIndicator(cp) ? 1 : 0;
    }
    previous = cp;
  }
  if (current !== "") out.push(current);
  return out;
}

/** Split text into user-perceived characters (graphemes). */
export function graphemes(text: string): string[] {
  if (text === "") return [];
  const segmenter = graphemeSegmenter();
  if (segmenter !== null) return [...segmenter.segment(text)].map((part) => part.segment);
  return fallbackGraphemes(text);
}

/** Number of graphemes in `text`. */
export function graphemeCount(text: string): number {
  return graphemes(text).length;
}

/** Convert a grapheme index into a UTF-16 code-unit offset (for rendering). */
export function codeUnitOffset(text: string, cursor: number): number {
  const units = graphemes(text);
  const index = clamp(Math.floor(cursor), 0, units.length);
  return units.slice(0, index).join("").length;
}

// --------------------------------------------------------------------------- //
// state construction and small helpers
// --------------------------------------------------------------------------- //

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

function maxCharsOf(options: EditorOptions): number {
  const value = options.maxChars;
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_EDITOR_MAX_CHARS;
  }
  return Math.floor(value);
}

function maxHistoryOf(options: EditorOptions): number {
  const value = options.maxHistory;
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_EDITOR_MAX_HISTORY;
  return Math.max(0, Math.floor(value));
}

/** An empty editor, optionally seeded with draft text (cursor at the end). */
export function createEditor(text = "", options: EditorOptions = {}): EditorState {
  const state: EditorState = {
    text: "",
    cursor: 0,
    history: [],
    historyIndex: null,
    draft: "",
  };
  return setEditorText(state, text, options);
}

/** Reset the draft and cursor; submitted history is kept. */
export function clearEditor(state: EditorState): EditorState {
  return { ...state, text: "", cursor: 0, historyIndex: null, draft: "" };
}

/**
 * Replace the draft with `text`, clipped to the character cap on a grapheme
 * boundary. The cursor lands at the end and history browsing is left.
 */
export function setEditorText(
  state: EditorState,
  text: string,
  options: EditorOptions = {},
): EditorState {
  const normalized = normalizeNewlines(text);
  const limit = maxCharsOf(options);
  let accepted = "";
  let cursor = 0;
  for (const unit of graphemes(normalized)) {
    if (accepted.length + unit.length > limit) break;
    accepted += unit;
    cursor += 1;
  }
  return { ...state, text: accepted, cursor, historyIndex: null, draft: "" };
}

/**
 * Replace the grapheme range `[start, end)` with `inserted`, clipping the
 * insertion to the remaining character budget without splitting a grapheme.
 * Any real edit leaves history browsing and becomes the live draft.
 */
function replaceRange(
  state: EditorState,
  start: number,
  end: number,
  inserted: string,
  options: EditorOptions,
): EditorState {
  const units = graphemes(state.text);
  const from = clamp(Math.floor(start), 0, units.length);
  const to = clamp(Math.floor(end), from, units.length);
  const removed = units.slice(from, to).join("");
  const budget = maxCharsOf(options) - (state.text.length - removed.length);
  let accepted = "";
  if (budget > 0) {
    for (const unit of graphemes(normalizeNewlines(inserted))) {
      if (accepted.length + unit.length > budget) break;
      accepted += unit;
    }
  }
  if (from === to && accepted === "") return state;
  const text = units.slice(0, from).join("") + accepted + units.slice(to).join("");
  return {
    text,
    cursor: from + graphemeCount(accepted),
    history: state.history,
    historyIndex: null,
    draft: "",
  };
}

/** Insert text at the cursor as one edit. */
export function insertText(
  state: EditorState,
  text: string,
  options: EditorOptions = {},
): EditorState {
  if (text === "") return state;
  return replaceRange(state, state.cursor, state.cursor, text, options);
}

const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~";
// C0 controls except tab and newline; CR is normalized before this runs.
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

/**
 * Insert pasted text as a single edit. Bracketed-paste markers are dropped,
 * CRLF/CR become `\n`, and other control bytes are removed so pasted content
 * can never submit a turn or inject terminal escapes.
 */
export function pasteText(
  state: EditorState,
  text: string,
  options: EditorOptions = {},
): EditorState {
  const withoutMarkers = text.split(PASTE_START).join("").split(PASTE_END).join("");
  const normalized = normalizeNewlines(withoutMarkers).replace(CONTROL_CHARS, "");
  if (normalized === "") return state;
  return insertText(state, normalized, options);
}

// --------------------------------------------------------------------------- //
// deletion
// --------------------------------------------------------------------------- //

function isWordGrapheme(unit: string): boolean {
  return /[\p{L}\p{N}_]/u.test(unit);
}

function wordLeftIndex(units: readonly string[], cursor: number): number {
  let index = clamp(cursor, 0, units.length);
  while (index > 0 && !isWordGrapheme(units[index - 1])) index -= 1;
  while (index > 0 && isWordGrapheme(units[index - 1])) index -= 1;
  return index;
}

function wordRightIndex(units: readonly string[], cursor: number): number {
  let index = clamp(cursor, 0, units.length);
  while (index < units.length && !isWordGrapheme(units[index])) index += 1;
  while (index < units.length && isWordGrapheme(units[index])) index += 1;
  return index;
}

function lineStartIndex(units: readonly string[], cursor: number): number {
  let index = clamp(cursor, 0, units.length);
  while (index > 0 && units[index - 1] !== "\n") index -= 1;
  return index;
}

function lineEndIndex(units: readonly string[], cursor: number): number {
  let index = clamp(cursor, 0, units.length);
  while (index < units.length && units[index] !== "\n") index += 1;
  return index;
}

/** Delete the grapheme before the cursor. */
export function deleteBackward(state: EditorState, options: EditorOptions = {}): EditorState {
  if (state.cursor <= 0) return state;
  return replaceRange(state, state.cursor - 1, state.cursor, "", options);
}

/** Delete the grapheme after the cursor. */
export function deleteForward(state: EditorState, options: EditorOptions = {}): EditorState {
  const units = graphemes(state.text);
  if (state.cursor >= units.length) return state;
  return replaceRange(state, state.cursor, state.cursor + 1, "", options);
}

/** Delete to the start of the previous word. */
export function deleteWordBackward(state: EditorState, options: EditorOptions = {}): EditorState {
  const units = graphemes(state.text);
  const start = wordLeftIndex(units, state.cursor);
  if (start === state.cursor) return state;
  return replaceRange(state, start, state.cursor, "", options);
}

/** Delete to the start of the next word. */
export function deleteWordForward(state: EditorState, options: EditorOptions = {}): EditorState {
  const units = graphemes(state.text);
  const end = wordRightIndex(units, state.cursor);
  if (end === state.cursor) return state;
  return replaceRange(state, state.cursor, end, "", options);
}

/** Delete from the cursor to the start of its logical line (Ctrl+U). */
export function deleteToLineStart(state: EditorState, options: EditorOptions = {}): EditorState {
  const units = graphemes(state.text);
  const start = lineStartIndex(units, state.cursor);
  if (start === state.cursor) return state;
  return replaceRange(state, start, state.cursor, "", options);
}

/** Delete from the cursor to the end of its logical line (Ctrl+K). */
export function deleteToLineEnd(state: EditorState, options: EditorOptions = {}): EditorState {
  const units = graphemes(state.text);
  const end = lineEndIndex(units, state.cursor);
  if (end === state.cursor) return state;
  return replaceRange(state, state.cursor, end, "", options);
}

// --------------------------------------------------------------------------- //
// cursor movement
// --------------------------------------------------------------------------- //

/** Every cursor movement the editor understands. */
export type MoveKind =
  | "left"
  | "right"
  | "wordLeft"
  | "wordRight"
  | "lineStart"
  | "lineEnd"
  | "docStart"
  | "docEnd"
  | "lineUp"
  | "lineDown";

interface LineBounds {
  start: number;
  end: number;
}

function lineBounds(units: readonly string[]): LineBounds[] {
  const bounds: LineBounds[] = [{ start: 0, end: 0 }];
  for (let index = 0; index < units.length; index += 1) {
    if (units[index] === "\n") {
      bounds[bounds.length - 1].end = index;
      bounds.push({ start: index + 1, end: index + 1 });
    }
  }
  bounds[bounds.length - 1].end = units.length;
  return bounds;
}

/** The cursor's logical line and grapheme column. */
export function cursorPosition(state: EditorState): EditorCursorPosition {
  const units = graphemes(state.text);
  const bounds = lineBounds(units);
  const cursor = clamp(state.cursor, 0, units.length);
  for (let line = 0; line < bounds.length; line += 1) {
    const bound = bounds[line];
    if (cursor <= bound.end) return { line, column: cursor - bound.start };
  }
  const last = bounds.length - 1;
  return { line: last, column: bounds[last].end - bounds[last].start };
}

function moveVertical(units: readonly string[], cursor: number, delta: number): number {
  const bounds = lineBounds(units);
  const clamped = clamp(cursor, 0, units.length);
  let line = 0;
  for (let index = 0; index < bounds.length; index += 1) {
    if (clamped <= bounds[index].end) {
      line = index;
      break;
    }
    line = index;
  }
  const column = clamped - bounds[line].start;
  const target = clamp(line + delta, 0, bounds.length - 1);
  if (target === line) return clamped;
  const bound = bounds[target];
  return bound.start + Math.min(column, bound.end - bound.start);
}

/** Move the cursor; never changes the text. */
export function moveCursor(state: EditorState, kind: MoveKind): EditorState {
  const units = graphemes(state.text);
  const length = units.length;
  const cursor = clamp(state.cursor, 0, length);
  let next = cursor;
  switch (kind) {
    case "left":
      next = Math.max(0, cursor - 1);
      break;
    case "right":
      next = Math.min(length, cursor + 1);
      break;
    case "wordLeft":
      next = wordLeftIndex(units, cursor);
      break;
    case "wordRight":
      next = wordRightIndex(units, cursor);
      break;
    case "lineStart":
      next = lineStartIndex(units, cursor);
      break;
    case "lineEnd":
      next = lineEndIndex(units, cursor);
      break;
    case "docStart":
      next = 0;
      break;
    case "docEnd":
      next = length;
      break;
    case "lineUp":
      next = moveVertical(units, cursor, -1);
      break;
    case "lineDown":
      next = moveVertical(units, cursor, 1);
      break;
  }
  if (next === state.cursor) return state;
  return { ...state, cursor: next };
}

// --------------------------------------------------------------------------- //
// history and submission
// --------------------------------------------------------------------------- //

/**
 * Append one submitted entry to the bounded history. Blank entries and an
 * exact repeat of the newest entry are ignored. The draft is untouched.
 */
export function recordHistory(
  state: EditorState,
  entry: string,
  options: EditorOptions = {},
): EditorState {
  const limit = maxHistoryOf(options);
  if (limit === 0 || entry.trim() === "") return state;
  if (state.history.length > 0 && state.history[state.history.length - 1] === entry) {
    return state;
  }
  const history = [...state.history, entry].slice(-limit);
  return { ...state, history };
}

/**
 * Recall the previous history entry. From the live draft the newest entry is
 * recalled and the draft is stashed; at the oldest entry the state is
 * unchanged.
 */
export function historyPrevious(state: EditorState): EditorState {
  if (state.history.length === 0) return state;
  const index =
    state.historyIndex === null
      ? state.history.length - 1
      : Math.max(0, state.historyIndex - 1);
  if (state.historyIndex !== null && index === state.historyIndex) return state;
  const text = state.history[index];
  return {
    ...state,
    text,
    cursor: graphemeCount(text),
    historyIndex: index,
    draft: state.historyIndex === null ? state.text : state.draft,
  };
}

/**
 * Recall the next history entry; past the newest entry the stashed live
 * draft is restored and history browsing ends.
 */
export function historyNext(state: EditorState): EditorState {
  if (state.historyIndex === null) return state;
  if (state.historyIndex < state.history.length - 1) {
    const index = state.historyIndex + 1;
    const text = state.history[index];
    return { ...state, text, cursor: graphemeCount(text), historyIndex: index };
  }
  return {
    ...state,
    text: state.draft,
    cursor: graphemeCount(state.draft),
    historyIndex: null,
    draft: "",
  };
}

/**
 * Consume the current draft: return the exact text, record it in history
 * (unless blank) and clear the editor for the next prompt.
 */
export function takeSubmission(
  state: EditorState,
  options: EditorOptions = {},
): EditorSubmission {
  const text = state.text;
  const cleared = clearEditor(state);
  return { text, state: recordHistory(cleared, text, options) };
}

// --------------------------------------------------------------------------- //
// keypress folding
// --------------------------------------------------------------------------- //

function typedTextOf(key: EditorKey): string | null {
  if (key.ctrl === true || key.alt === true) return null;
  const raw = key.raw;
  if (raw === "" || raw.startsWith("\u001b")) return null;
  if (raw === "\t" || raw === "\r" || raw === "\n") return null;
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(raw)) return null;
  return raw;
}

/**
 * Fold one keypress into the editor.
 *
 * Precedence: cancel (Ctrl+C / Esc) → paste → newline/submit → deletion →
 * movement → history → page scroll → completion → printable text. Unmapped
 * modified keys return `"ignore"` so the app can route them elsewhere; plain
 * text (including a multi-character input chunk) is inserted as one edit.
 */
export function handleEditorKey(
  state: EditorState,
  key: EditorKey,
  options: EditorOptions = {},
): EditorKeyResult {
  const name = (key.name || "").toLowerCase();
  const untouched = (action: EditorAction): EditorKeyResult => ({ state, action });

  if (key.ctrl === true && (name === "c" || key.raw === "\u0003")) {
    return untouched("cancel");
  }
  if (name === "escape" || key.raw === "\u001b") return untouched("cancel");
  if (name === "paste") {
    return { state: pasteText(state, key.raw, options), action: "paste" };
  }
  if (key.ctrl === true && name === "j") {
    return { state: insertText(state, "\n", options), action: "newline" };
  }
  if (name === "return" || name === "enter") {
    if (key.shift === true || key.alt === true) {
      return { state: insertText(state, "\n", options), action: "newline" };
    }
    return untouched("submit");
  }
  if (name === "backspace" || key.raw === "\u007f" || key.raw === "\b") {
    const modified = key.ctrl === true || key.alt === true;
    return {
      state: modified ? deleteWordBackward(state, options) : deleteBackward(state, options),
      action: "none",
    };
  }
  if (name === "delete") {
    const modified = key.ctrl === true || key.alt === true;
    return {
      state: modified ? deleteWordForward(state, options) : deleteForward(state, options),
      action: "none",
    };
  }
  if (name === "left") {
    return {
      state: moveCursor(state, key.ctrl === true || key.alt === true ? "wordLeft" : "left"),
      action: "none",
    };
  }
  if (name === "right") {
    return {
      state: moveCursor(state, key.ctrl === true || key.alt === true ? "wordRight" : "right"),
      action: "none",
    };
  }
  if (name === "home") {
    return { state: moveCursor(state, key.ctrl === true ? "docStart" : "lineStart"), action: "none" };
  }
  if (name === "end") {
    return { state: moveCursor(state, key.ctrl === true ? "docEnd" : "lineEnd"), action: "none" };
  }
  if (name === "up") {
    if (cursorPosition(state).line > 0) {
      return { state: moveCursor(state, "lineUp"), action: "none" };
    }
    return { state: historyPrevious(state), action: "history-prev" };
  }
  if (name === "down") {
    const units = graphemes(state.text);
    if (cursorPosition(state).line < lineBounds(units).length - 1) {
      return { state: moveCursor(state, "lineDown"), action: "none" };
    }
    return { state: historyNext(state), action: "history-next" };
  }
  if (name === "pageup") return untouched("scroll-prev");
  if (name === "pagedown") return untouched("scroll-next");
  if (name === "tab") return untouched("complete");
  if (key.ctrl === true) {
    if (name === "a") return { state: moveCursor(state, "lineStart"), action: "none" };
    if (name === "e") return { state: moveCursor(state, "lineEnd"), action: "none" };
    if (name === "w") return { state: deleteWordBackward(state, options), action: "none" };
    if (name === "u") return { state: deleteToLineStart(state, options), action: "none" };
    if (name === "k") return { state: deleteToLineEnd(state, options), action: "none" };
    return untouched("ignore");
  }
  const text = typedTextOf(key);
  if (text !== null) {
    if (graphemeCount(text) > 1 || text.includes("\n")) {
      return { state: pasteText(state, text, options), action: "paste" };
    }
    return { state: insertText(state, text, options), action: "none" };
  }
  return untouched("ignore");
}