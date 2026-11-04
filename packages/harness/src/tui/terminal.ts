/**
 * Thin terminal driver for the TUI: alternate screen, cursor visibility,
 * size, and raw keypress events. No app logic lives here — the driver does
 * not know what Enter or Escape means, it only normalizes keys into
 * {@link Key} records for `app.ts`.
 *
 * Interactive-only by design: `createTerminal` refuses a non-TTY stdin with
 * {@link TuiTerminalError}, and the caller turns that into a clean exit 2
 * message (hermetic CI never has a terminal, and no escape byte may reach a
 * redirected stdout).
 */
import * as readline from "node:readline";

import { ANSI } from "./render.ts";

/** One keypress, normalized from Node's readline `keypress` event. */
export interface Key {
  /** `readline` key name (`return`, `backspace`, `pageup`, `escape`, …). */
  name: string;
  ctrl: boolean;
  shift: boolean;
  /** The raw escape sequence / character (`\r`, `q`, `\x1b[5~`, …). */
  raw: string;
}

/** Terminal columns/rows, with the conventional 80×24 fallback. */
export interface TerminalSize {
  columns: number;
  rows: number;
}

/** Raised when the driver is asked to drive something that is not a TTY. */
export class TuiTerminalError extends Error {}

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

/** One keypress wait, backed by a queue so no key is lost between reads. */
export class Terminal {
  private readonly input: NodeJS.ReadStream;
  private readonly output: NodeJS.WriteStream;
  private readonly waiters: Array<(key: Key) => void> = [];
  private readonly queue: Key[] = [];
  private readonly onKeypress: (raw: string, key: readline.Key | undefined) => void;
  private entered = false;
  private restored = false;

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
      const normalized: Key = {
        name: key?.name ?? raw ?? "",
        ctrl: key?.ctrl === true,
        shift: key?.shift === true,
        raw: typeof raw === "string" ? raw : "",
      };
      const waiter = this.waiters.shift();
      if (waiter !== undefined) waiter(normalized);
      else this.queue.push(normalized);
    };
    input.on("keypress", this.onKeypress);
  }

  /** Enter the alternate screen and clear it. */
  enterAltScreen(): void {
    this.output.write(ANSI.altScreenOn + ANSI.clearScreen);
  }

  /** Leave the alternate screen (the caller shows the cursor separately). */
  exitAltScreen(): void {
    this.output.write(ANSI.altScreenOff);
  }

  /** Clear the screen and home the cursor. */
  clear(): void {
    this.output.write(ANSI.clearScreen);
  }

  hideCursor(): void {
    this.output.write(ANSI.hideCursor);
  }

  showCursor(): void {
    this.output.write(ANSI.showCursor);
  }

  /** Enter the alternate screen, clear it, hide the cursor, enable raw keys. */
  enter(): void {
    if (this.entered) return;
    this.entered = true;
    this.restored = false;
    this.enterAltScreen();
    this.hideCursor();
    if (typeof this.input.setRawMode === "function") this.input.setRawMode(true);
    this.input.resume();
    this.input.setEncoding?.("utf8");
  }

  /** Write one full frame, homing the cursor and clearing stale rows below. */
  render(frame: string): void {
    this.output.write(ANSI.cursorHome + frame + ANSI.clearBelow);
  }

  /** Resolve with the next keypress (keys that arrived early are queued). */
  readKey(): Promise<Key> {
    const queued = this.queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise<Key>((resolve) => this.waiters.push(resolve));
  }

  size(): TerminalSize {
    return getSize(this.output);
  }

  /** Leave the alternate screen and restore the terminal. Idempotent. */
  restore(): void {
    if (this.restored) return;
    this.restored = true;
    try {
      if (typeof this.input.setRawMode === "function") this.input.setRawMode(false);
    } catch {
      // a closed/gone stdin still lets us restore the screen
    }
    this.input.off("keypress", this.onKeypress);
    try {
      this.input.pause();
    } catch {
      // pausing keeps a restored terminal from holding the event loop open
    }
    (this.input as { unref?: () => void }).unref?.();
    this.showCursor();
    this.exitAltScreen();
  }
}

/** Construct a driver, refusing a non-TTY stdin up front. */
export function createTerminal(
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stdout,
): Terminal {
  return new Terminal(input, output);
}