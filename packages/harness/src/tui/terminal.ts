/**
 * Thin terminal driver for the TUI: alternate screen, cursor visibility,
 * bracketed paste, size, resize notifications and normalized input events.
 * No app logic lives here — the driver does not know what Enter or Escape
 * means, it only turns readline keypresses into {@link InputEvent}s for
 * `app.ts`.
 *
 * Input is folded through `input.ts`, so a bracketed paste arrives as one
 * `paste` event (with CRLF normalized to LF) instead of a stream of keys
 * that would submit several tasks. {@link Terminal.readEvent} is the event
 * API new code should use; {@link Terminal.readKey} stays for the existing
 * key-only app loop and surfaces a paste as one `paste` key.
 *
 * Interactive-only by design: `createTerminal` refuses a non-TTY stdin with
 * {@link TuiTerminalError}, and the caller turns that into a clean exit 2
 * message (hermetic CI never has a terminal, and no escape byte may reach a
 * redirected stdout).
 */
import * as readline from "node:readline";

import { ANSI } from "./render.ts";
import {
  createInputParser,
  PASTE_KEY_NAME,
  type InputEvent,
  type Key,
} from "./input.ts";

export type { InputEvent, Key } from "./input.ts";

/** Terminal columns/rows, with the conventional 80×24 fallback. */
export interface TerminalSize {
  columns: number;
  rows: number;
}

/** Raised when the driver is asked to drive something that is not a TTY. */
export class TuiTerminalError extends Error {}

/** Bracketed-paste mode: the terminal wraps a paste in these markers. */
export const BRACKETED_PASTE_ON = `${ANSI.esc}[?2004h`;
export const BRACKETED_PASTE_OFF = `${ANSI.esc}[?2004l`;

/**
 * True when `stream` is an interactive TTY. Exported (and tiny) so the
 * non-TTY guard is testable without a terminal: `app.ts` keys its clean
 * "use chat for piped input" exit on this predicate.
 */
export function isTtyOk(stream: { isTTY?: boolean } | null | undefined): boolean {
  return stream !== null && stream !== undefined && stream.isTTY === true;
}

/** Terminal size from a writable stream, clamped to sane values. */
export function getSize(
  output: { columns?: number; rows?: number } = process.stdout,
): TerminalSize {
  const positive = (value: number | undefined, fallback: number): number =>
    typeof value === "number" && Number.isFinite(value) && value > 0
      ? Math.floor(value)
      : fallback;
  return {
    columns: positive(output.columns, 80),
    rows: positive(output.rows, 24),
  };
}

/** Minimal structural view of a stream that can emit `resize`. */
interface ResizeSource {
  on?(event: "resize", listener: () => void): unknown;
  off?(event: "resize", listener: () => void): unknown;
  removeListener?(event: "resize", listener: () => void): unknown;
}

/** One keypress wait, backed by a queue so no input is lost between reads. */
export class Terminal {
  private readonly input: NodeJS.ReadStream;
  private readonly output: NodeJS.WriteStream;
  private readonly parser = createInputParser();
  private readonly events: InputEvent[] = [];
  private readonly eventWaiters: Array<(event: InputEvent) => void> = [];
  private readonly resizeListeners = new Set<(size: TerminalSize) => void>();
  private readonly onKeypress: (raw: string, key: readline.Key | undefined) => void;
  private readonly onResizeEvent = (): void => {
    if (this.restored) return;
    const size = this.size();
    for (const listener of [...this.resizeListeners]) {
      try {
        listener(size);
      } catch {
        // One listener must never break the driver or the other listeners.
      }
    }
  };
  private entered = false;
  private restored = false;
  private resizeAttached = false;

  constructor(input: NodeJS.ReadStream, output: NodeJS.WriteStream) {
    if (!isTtyOk(input)) {
      throw new TuiTerminalError(
        "stdin is not a TTY: the TUI needs an interactive terminal (use `two-brothers chat` for piped input)",
      );
    }
    this.input = input;
    this.output = output;
    readline.emitKeypressEvents(input);
    this.onKeypress = (raw, key) => {
      const events = this.parser.feed({
        raw: typeof raw === "string" ? raw : "",
        ...(key?.name !== undefined ? { name: key.name } : {}),
        ctrl: key?.ctrl === true,
        shift: key?.shift === true,
        alt: key?.meta === true,
        ...(key?.sequence !== undefined ? { sequence: key.sequence } : {}),
        // readline's public types do not declare a repeat flag, but some
        // terminals/drivers forward one; pass it through when present so the
        // composer submit guard can suppress a held Enter/Tab exactly.
        ...((key as { repeat?: unknown } | undefined)?.repeat === true ? { repeat: true } : {}),
      });
      for (const event of events) this.deliver(event);
    };
    input.on("keypress", this.onKeypress);
  }

  /** Enter the alternate screen and clear it. */
  enterAltScreen(): void {
    if (this.restored) return;
    this.output.write(ANSI.altScreenOn + ANSI.clearScreen);
  }

  /** Leave the alternate screen (the caller shows the cursor separately). */
  exitAltScreen(): void {
    if (this.restored) return;
    this.output.write(ANSI.altScreenOff);
  }

  /** Clear the screen and home the cursor. */
  clear(): void {
    if (this.restored) return;
    this.output.write(ANSI.clearScreen);
  }

  hideCursor(): void {
    if (this.restored) return;
    this.output.write(ANSI.hideCursor);
  }

  showCursor(): void {
    if (this.restored) return;
    this.output.write(ANSI.showCursor);
  }

  /** Ask the terminal to wrap pastes in `ESC[200~` / `ESC[201~`. */
  enableBracketedPaste(): void {
    if (this.restored) return;
    this.output.write(BRACKETED_PASTE_ON);
  }

  /** Disable bracketed paste. Safe to call when it was never enabled. */
  disableBracketedPaste(): void {
    if (this.restored) return;
    this.output.write(BRACKETED_PASTE_OFF);
  }

  /** Enter the alternate screen, hide the cursor, enable paste and raw keys. */
  enter(): void {
    if (this.entered) return;
    this.entered = true;
    this.restored = false;
    this.enterAltScreen();
    this.enableBracketedPaste();
    this.hideCursor();
    if (typeof this.input.setRawMode === "function") this.input.setRawMode(true);
    this.input.resume();
    this.input.setEncoding?.("utf8");
  }

  /** Write one full frame, homing the cursor and clearing stale rows below.
   *  Never writes once restore has begun — a late stream event after the
   *  turnDone race (or any other straggler) must not touch the terminal. */
  render(frame: string): void {
    if (this.restored) return;
    this.output.write(ANSI.cursorHome + frame + ANSI.clearBelow);
  }

  /** Resolve with the next normalized input event (events that arrived early are queued). */
  readEvent(): Promise<InputEvent> {
    const queued = this.events.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise<InputEvent>((resolve) => this.eventWaiters.push(resolve));
  }

  /**
   * Resolve with the next keypress (keys that arrived early are queued).
   * A paste is delivered as a single key named `paste` whose `raw` is the
   * whole normalized paste text; new code should prefer {@link readEvent}.
   */
  readKey(): Promise<Key> {
    return this.readEvent().then((event) =>
      event.type === "key"
        ? event.key
        : { name: PASTE_KEY_NAME, ctrl: false, shift: false, raw: event.text },
    );
  }

  /**
   * Subscribe to terminal resizes (the output stream's `resize` event).
   * Returns an idempotent unsubscribe; {@link restore} removes every
   * listener as well. Subscribing after restore is a no-op.
   */
  onResize(listener: (size: TerminalSize) => void): () => void {
    if (this.restored) return () => {};
    this.resizeListeners.add(listener);
    this.attachResize();
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.resizeListeners.delete(listener);
      if (this.resizeListeners.size === 0) this.detachResize();
    };
  }

  size(): TerminalSize {
    return getSize(this.output);
  }

  /**
   * Leave the alternate screen and restore the terminal: raw mode off,
   * bracketed paste off, cursor shown, listeners removed. Idempotent — the
   * escape sequences are written at most once even on overlapping exits.
   */
  restore(): void {
    if (this.restored) return;
    this.restored = true;
    this.resizeListeners.clear();
    this.detachResize();
    this.parser.flush();
    this.input.off("keypress", this.onKeypress);
    try {
      if (typeof this.input.setRawMode === "function") this.input.setRawMode(false);
    } catch {
      // a closed/gone stdin still lets us restore the screen
    }
    // Direct writes: `restored` is already true, so the guarded public methods
    // above would no-op — restore is the one path that must still emit.
    try {
      this.output.write(BRACKETED_PASTE_OFF);
    } catch {
      // the output may already be closed
    }
    try {
      this.output.write(ANSI.showCursor);
    } catch {
      // the output may already be closed
    }
    try {
      this.output.write(ANSI.altScreenOff);
    } catch {
      // the output may already be closed
    }
    try {
      this.input.pause();
    } catch {
      // pausing keeps a restored terminal from holding the event loop open
    }
    (this.input as { unref?: () => void }).unref?.();
  }

  private deliver(event: InputEvent): void {
    const waiter = this.eventWaiters.shift();
    if (waiter !== undefined) waiter(event);
    else this.events.push(event);
  }

  private attachResize(): void {
    if (this.resizeAttached) return;
    const source = this.output as unknown as ResizeSource;
    if (typeof source.on !== "function") return;
    source.on("resize", this.onResizeEvent);
    this.resizeAttached = true;
  }

  private detachResize(): void {
    if (!this.resizeAttached) return;
    const source = this.output as unknown as ResizeSource;
    if (typeof source.off === "function") source.off("resize", this.onResizeEvent);
    else source.removeListener?.("resize", this.onResizeEvent);
    this.resizeAttached = false;
  }
}

/**
 * Windows console race guard for Node's internal SIGWINCH size refresh.
 *
 * On a real Windows console a `WINDOW_BUFFER_SIZE_EVENT` (a window resize,
 * or a buffer size change from any process sharing the console) makes Node
 * synchronously call `_refreshSize()` on its TTY `WriteStream`s from an
 * internal process-level handler. While the console screen buffer is being
 * swapped that query can transiently fail with `EPIPE` ("getWindowSize
 * EPIPE"); the throw escapes Node's internal listener, becomes an
 * uncaughtException *after* the app's main() already resolved 0, and the
 * default handler exits the process with code 1 — with no visible output,
 * because the dying stream is stderr itself. This is a platform/Node
 * runtime race, not an app error; the refreshed size has no bearing on the
 * exit path, so an `EPIPE` there is swallowed. Every other error code is
 * rethrown unchanged.
 *
 * Idempotent: safe to call for both process streams on every TUI start.
 * Only `EPIPE` is swallowed — this never touches the app's exit-code
 * contract or any other exception.
 */
export function guardTtyResizeRefresh(stream: unknown): void {
  const candidate = stream as
    | { _refreshSize?: unknown; __tbResizeGuarded?: boolean }
    | null
    | undefined;
  if (
    candidate === null ||
    candidate === undefined ||
    typeof candidate._refreshSize !== "function" ||
    candidate.__tbResizeGuarded === true
  ) {
    return;
  }
  candidate.__tbResizeGuarded = true;
  const original = candidate._refreshSize as (this: unknown) => void;
  candidate._refreshSize = function (this: unknown) {
    try {
      return original.call(this);
    } catch (exc) {
      if ((exc as NodeJS.ErrnoException | null | undefined)?.code === "EPIPE") {
        return;
      }
      throw exc;
    }
  };
}

/** Construct a driver, refusing a non-TTY stdin up front. */
export function createTerminal(
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stdout,
): Terminal {
  return new Terminal(input, output);
}