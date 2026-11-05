/**
 * Pure input-event normalization for the TUI driver.
 *
 * `terminal.ts` feeds Node's readline `keypress` records in here. The parser
 * turns them into {@link InputEvent}s and, most importantly, folds a
 * bracketed paste into one `paste` event:
 *
 *   paste-start  h  e  l  l  o  \r  \n  w  o  r  l  d  paste-end
 *   ─► { type: "paste", text: "hello\nworld" }
 *
 * Without this, a multiline paste would arrive as individual `return` keys
 * and submit several tasks. Paste content may be split across any number of
 * chunks; the parser keeps its state between `feed` calls, so a marker or a
 * surrogate pair split over reads still becomes a single event.
 *
 * The parser is deliberately stream-agnostic (no Node types, no I/O) so the
 * paste rules are testable with plain records. Node's readline emits the
 * `paste-start` / `paste-end` key names for `ESC[200~` / `ESC[201~` even
 * when the terminal has not enabled bracketed paste; the driver enables it
 * on entry.
 */

/** One keypress, normalized from Node's readline `keypress` event. */
export interface Key {
  /** `readline` key name (`return`, `backspace`, `pageup`, `escape`, …). */
  name: string;
  ctrl: boolean;
  shift: boolean;
  /** Readline calls the Alt modifier `meta`; omitted when not pressed. */
  alt?: boolean;
  /** The raw escape sequence / character (`\r`, `q`, `\x1b[5~`, …). */
  raw: string;
}

/** One normalized input event. */
export type InputEvent =
  | { type: "key"; key: Key }
  | { type: "paste"; text: string };

/** The subset of readline's `keypress` arguments the parser needs. */
export interface KeypressInput {
  raw?: string;
  name?: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
  sequence?: string;
}

/** `Key.name` used when the legacy {@link InputParser} key view sees a paste. */
export const PASTE_KEY_NAME = "paste";

export const PASTE_START_KEY = "paste-start";
export const PASTE_END_KEY = "paste-end";

/**
 * Normalize pasted text: CRLF and lone CR become LF (so a paste is one
 * composer edit), NUL bytes are dropped, and any bracketed-paste markers
 * that survived as content are removed. ANSI is intentionally preserved —
 * width helpers sanitize it at layout time.
 */
export function normalizePastedText(text: string): string {
  return text
    .replace(/\u001b\[20[01]~/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\u0000/g, "");
}

/** Normalize a raw readline key record into the public {@link Key} shape. */
export function normalizeKey(input: KeypressInput): Key {
  const raw =
    typeof input.raw === "string"
      ? input.raw
      : typeof input.sequence === "string"
        ? input.sequence
        : "";
  const name = typeof input.name === "string" ? input.name : raw;
  // Real Windows consoles deliver a lone ESC as `{ name: "escape", meta: true }`
  // (libuv/readline quirk); a bare Escape must stay bare or every Esc binding
  // (close overlay, cancel, quit confirm) silently stops matching on Windows.
  const alt = (input.alt === true || input.meta === true) && name !== "escape";
  return {
    name,
    ctrl: input.ctrl === true,
    shift: input.shift === true,
    ...(alt ? { alt: true } : {}),
    raw,
  };
}

/**
 * Incremental keypress-to-event state machine. Call {@link feed} once per
 * readline keypress record and dispatch the returned events in order.
 */
export class InputParser {
  private inPaste = false;
  private chunks: string[] = [];

  /** True while a bracketed paste has started but not ended. */
  get pasting(): boolean {
    return this.inPaste;
  }

  /** Consume one keypress record; returns zero or more normalized events. */
  feed(input: KeypressInput): InputEvent[] {
    if (input.name === PASTE_START_KEY) {
      const stale = this.finishPaste();
      this.inPaste = true;
      return stale === null || stale === "" ? [] : [{ type: "paste", text: stale }];
    }
    if (input.name === PASTE_END_KEY) {
      const text = this.finishPaste();
      return text === null || text === "" ? [] : [{ type: "paste", text }];
    }
    if (this.inPaste) {
      this.chunks.push(
        typeof input.raw === "string"
          ? input.raw
          : typeof input.sequence === "string"
            ? input.sequence
            : "",
      );
      return [];
    }
    return [{ type: "key", key: normalizeKey(input) }];
  }

  /**
   * Emit a pending paste when the input ends without a paste-end marker
   * (stream closed, teardown). Returns `[]` when no paste is open.
   */
  flush(): InputEvent[] {
    const text = this.finishPaste();
    return text === null || text === "" ? [] : [{ type: "paste", text }];
  }

  private finishPaste(): string | null {
    if (!this.inPaste) return null;
    const text = normalizePastedText(this.chunks.join(""));
    this.inPaste = false;
    this.chunks = [];
    return text;
  }
}

/** Create an {@link InputParser}. */
export function createInputParser(): InputParser {
  return new InputParser();
}