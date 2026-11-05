/**
 * Terminal driver suite over fake TTY streams: bracketed paste, chunked
 * input, resize notifications, listener/teardown cleanup, idempotent restore
 * and the non-TTY guard. Also covers the pure input parser's paste rules.
 * Hermetic — a fake `EventEmitter` input/output pair is enough.
 *
 * Run with: node --test tests/tuiterminal.test.ts
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import { ANSI } from "../src/tui/render.ts";
import {
  createInputParser,
  normalizePastedText,
} from "../src/tui/input.ts";
import {
  BRACKETED_PASTE_OFF,
  BRACKETED_PASTE_ON,
  createTerminal,
  getSize,
  guardTtyResizeRefresh,
  isTtyOk,
  TuiTerminalError,
  type TerminalSize,
} from "../src/tui/terminal.ts";

class FakeInput extends EventEmitter {
  isTTY = true;
  rawMode = false;
  resumed = false;
  encoding: string | null = null;

  setRawMode(value: boolean): void {
    this.rawMode = value;
  }

  resume(): void {
    this.resumed = true;
  }

  setEncoding(encoding: string): void {
    this.encoding = encoding;
  }
}

class FakeOutput extends EventEmitter {
  isTTY = true;
  columns = 80;
  rows = 24;
  data = "";

  write(chunk: string): boolean {
    this.data += chunk;
    return true;
  }
}

function streams(): { input: FakeInput; output: FakeOutput } {
  return { input: new FakeInput(), output: new FakeOutput() };
}

function terminalFor(): {
  input: FakeInput;
  output: FakeOutput;
  terminal: ReturnType<typeof createTerminal>;
} {
  const { input, output } = streams();
  const terminal = createTerminal(
    input as unknown as NodeJS.ReadStream,
    output as unknown as NodeJS.WriteStream,
  );
  return { input, output, terminal };
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

// ---------------------------------------------------------------------------
// input parser (pure)
// ---------------------------------------------------------------------------

test("InputParser: bracketed paste collapses to one paste event with LF newlines", () => {
  const parser = createInputParser();
  const events = [
    ...parser.feed({ name: "paste-start" }),
    ...parser.feed({ raw: "h", name: "h" }),
    ...parser.feed({ raw: "i", name: "i" }),
    ...parser.feed({ raw: "\r", name: "return" }),
    ...parser.feed({ raw: "\n", name: "enter" }),
    ...parser.feed({ raw: "b", name: "b" }),
    ...parser.feed({ name: "paste-end" }),
  ];
  assert.deepEqual(events, [{ type: "paste", text: "hi\nb" }]);
  assert.equal(parser.pasting, false);
});

test("InputParser: keys outside a paste keep their readline names", () => {
  const parser = createInputParser();
  assert.deepEqual(parser.feed({ raw: "a", name: "a" }), [
    { type: "key", key: { name: "a", ctrl: false, shift: false, raw: "a" } },
  ]);
  assert.deepEqual(parser.feed({ name: "up", sequence: "\u001b[A" }), [
    { type: "key", key: { name: "up", ctrl: false, shift: false, raw: "\u001b[A" } },
  ]);
});

test("InputParser: a lone Windows-console Escape drops the spurious meta flag", () => {
  // Real Windows consoles hand Node a lone ESC as { name: "escape", meta: true }
  // (libuv/readline quirk). normalizeKey must strip it — otherwise matchChord's
  // exact alt check rejects every Esc binding (overlay close, cancel, quit).
  const parser = createInputParser();
  assert.deepEqual(parser.feed({ name: "escape", meta: true, sequence: "\u001b" }), [
    { type: "key", key: { name: "escape", ctrl: false, shift: false, raw: "\u001b" } },
  ]);
});

test("InputParser: paste chunks accumulate and flush recovers an unterminated paste", () => {
  const parser = createInputParser();
  parser.feed({ name: "paste-start" });
  parser.feed({ raw: "one\r" });
  parser.feed({ raw: "two", sequence: "two" });
  assert.equal(parser.pasting, true);
  assert.deepEqual(parser.flush(), [{ type: "paste", text: "one\ntwo" }]);
  assert.equal(parser.pasting, false);
  assert.deepEqual(parser.flush(), []);
});

test("InputParser: empty pastes are dropped, a new paste-start flushes the stale one", () => {
  const parser = createInputParser();
  assert.deepEqual(parser.feed({ name: "paste-start" }), []);
  assert.deepEqual(parser.feed({ name: "paste-end" }), []);
  parser.feed({ name: "paste-start" });
  parser.feed({ raw: "stale" });
  assert.deepEqual(parser.feed({ name: "paste-start" }), [
    { type: "paste", text: "stale" },
  ]);
  assert.equal(parser.pasting, true);
});

test("normalizePastedText: CRLF/CR, NUL and stray paste markers", () => {
  assert.equal(normalizePastedText("a\r\nb\rc"), "a\nb\nc");
  assert.equal(normalizePastedText("a\u0000b"), "ab");
  assert.equal(normalizePastedText("\u001b[200~x\u001b[201~"), "x");
});

// ---------------------------------------------------------------------------
// enter / restore
// ---------------------------------------------------------------------------

test("enter enables alternate screen, bracketed paste, hidden cursor and raw mode", () => {
  const { input, output, terminal } = terminalFor();
  terminal.enter();
  assert.ok(output.data.includes(ANSI.altScreenOn));
  assert.ok(output.data.includes(BRACKETED_PASTE_ON));
  assert.ok(output.data.includes(ANSI.hideCursor));
  assert.equal(input.rawMode, true);
  assert.equal(input.resumed, true);
  assert.equal(input.encoding, "utf8");
  terminal.restore();
});

test("restore disables paste, shows the cursor, leaves the alt screen and is idempotent", () => {
  const { input, output, terminal } = terminalFor();
  terminal.enter();
  terminal.restore();

  assert.equal(input.rawMode, false);
  assert.ok(output.data.includes(BRACKETED_PASTE_OFF));
  assert.ok(output.data.includes(ANSI.showCursor));
  assert.ok(output.data.includes(ANSI.altScreenOff));
  assert.equal(input.listenerCount("keypress"), 0, "our keypress listener is removed");
  assert.equal(occurrences(output.data, BRACKETED_PASTE_OFF), 1);
  assert.equal(occurrences(output.data, ANSI.altScreenOff), 1);

  const written = output.data.length;
  terminal.restore();
  assert.equal(output.data.length, written, "a second restore writes nothing");
});

test("restore is safe without enter and leaves no keypress listener", () => {
  const { input, output, terminal } = terminalFor();
  terminal.restore();
  assert.equal(input.listenerCount("keypress"), 0);
  assert.equal(input.rawMode, false);
  assert.equal(occurrences(output.data, BRACKETED_PASTE_OFF), 1);
  assert.equal(occurrences(output.data, ANSI.altScreenOff), 1);
});

test("no output method writes after restore — late frames stay silent", () => {
  const { output, terminal } = terminalFor();
  terminal.enter();
  terminal.restore();
  const written = output.data.length;

  // the stragglers: a late frame (stream event after the turnDone race) and
  // every other escape-emitting path
  terminal.render("late frame");
  terminal.clear();
  terminal.enterAltScreen();
  terminal.exitAltScreen();
  terminal.hideCursor();
  terminal.showCursor();
  terminal.enableBracketedPaste();
  terminal.disableBracketedPaste();

  assert.equal(output.data.length, written, "nothing may be written after restore");
  assert.ok(!output.data.slice(written).includes("\u001b"));
  assert.equal(occurrences(output.data, BRACKETED_PASTE_OFF), 1);
  assert.equal(occurrences(output.data, ANSI.altScreenOff), 1);
});

// ---------------------------------------------------------------------------
// paste over fake streams
// ---------------------------------------------------------------------------

test("a multiline bracketed paste becomes one paste event, not return keys", async () => {
  const { input, terminal } = terminalFor();
  terminal.enter();
  input.emit("data", "\u001b[200~first\r\nsecond\rthird\n\u001b[201~");

  assert.deepEqual(await terminal.readEvent(), {
    type: "paste",
    text: "first\nsecond\nthird\n",
  });

  input.emit("data", "x");
  const next = await terminal.readEvent();
  assert.equal(next.type, "key");
  if (next.type === "key") {
    assert.equal(next.key.name, "x");
    assert.equal(next.key.raw, "x");
  }
  terminal.restore();
});

test("a paste split across stream chunks still produces a single event", async () => {
  const { input, terminal } = terminalFor();
  terminal.enter();
  input.emit("data", "\u001b[20");
  input.emit("data", "0~hel");
  input.emit("data", "lo\r\nwor");
  input.emit("data", "ld\u001b[201");
  input.emit("data", "~");

  assert.deepEqual(await terminal.readEvent(), {
    type: "paste",
    text: "hello\nworld",
  });
  terminal.restore();
});

test("legacy readKey surfaces a paste as one paste key, never as return keys", async () => {
  const { input, terminal } = terminalFor();
  terminal.enter();
  input.emit("data", "\u001b[200~a\rb\u001b[201~");
  assert.deepEqual(await terminal.readKey(), {
    name: "paste",
    ctrl: false,
    shift: false,
    raw: "a\nb",
  });
  terminal.restore();
});

test("input events keep their order across keys and pastes", async () => {
  const { input, terminal } = terminalFor();
  terminal.enter();
  input.emit("data", "\u001b[200~one\u001b[201~");
  input.emit("data", "a");
  input.emit("data", "\u001b[200~two\u001b[201~");

  assert.deepEqual(await terminal.readEvent(), { type: "paste", text: "one" });
  const key = await terminal.readEvent();
  assert.equal(key.type, "key");
  if (key.type === "key") assert.equal(key.key.name, "a");
  assert.deepEqual(await terminal.readEvent(), { type: "paste", text: "two" });
  terminal.restore();
});

test("readline key names and modifiers survive normalization", async () => {
  const { input, terminal } = terminalFor();
  terminal.enter();

  input.emit("data", "\u001b[5~");
  const pageUp = await terminal.readKey();
  assert.equal(pageUp.name, "pageup");

  input.emit("data", "\r");
  assert.equal((await terminal.readKey()).name, "return");

  input.emit("data", "\u0003");
  const ctrlC = await terminal.readKey();
  assert.equal(ctrlC.name, "c");
  assert.equal(ctrlC.ctrl, true);
  assert.equal(ctrlC.raw, "\u0003");

  input.emit("data", "\u007f");
  assert.equal((await terminal.readKey()).name, "backspace");

  input.emit("data", "\u001bx");
  const altX = await terminal.readKey();
  assert.equal(altX.name, "x");
  assert.equal(altX.alt, true);

  terminal.restore();
});

// ---------------------------------------------------------------------------
// resize
// ---------------------------------------------------------------------------

test("onResize reports the new size and unsubscribe detaches the listener", () => {
  const { output, terminal } = terminalFor();
  const seen: TerminalSize[] = [];
  const unsubscribe = terminal.onResize((size) => seen.push(size));
  assert.equal(output.listenerCount("resize"), 1);

  output.columns = 120;
  output.rows = 40;
  output.emit("resize");
  assert.deepEqual(seen, [{ columns: 120, rows: 40 }]);

  output.columns = 90;
  output.emit("resize");
  assert.equal(seen.length, 2);

  unsubscribe();
  unsubscribe();
  assert.equal(output.listenerCount("resize"), 0);
  output.emit("resize");
  assert.equal(seen.length, 2);
  terminal.restore();
});

test("a throwing resize listener does not starve the others", () => {
  const { output, terminal } = terminalFor();
  const seen: TerminalSize[] = [];
  terminal.onResize(() => {
    throw new Error("boom");
  });
  terminal.onResize((size) => seen.push(size));
  output.columns = 100;
  output.emit("resize");
  assert.deepEqual(seen, [{ columns: 100, rows: 24 }]);
  terminal.restore();
});

test("restore removes resize listeners and later subscriptions are no-ops", () => {
  const { output, terminal } = terminalFor();
  let calls = 0;
  terminal.onResize(() => {
    calls += 1;
  });
  terminal.enter();
  terminal.restore();

  assert.equal(output.listenerCount("resize"), 0);
  output.emit("resize");
  assert.equal(calls, 0);

  const unsubscribe = terminal.onResize(() => {
    calls += 1;
  });
  assert.equal(output.listenerCount("resize"), 0);
  output.emit("resize");
  unsubscribe();
  assert.equal(calls, 0);
});

// ---------------------------------------------------------------------------
// non-TTY guard + size
// ---------------------------------------------------------------------------

test("createTerminal refuses a non-TTY stdin without writing an escape byte", () => {
  const input = new FakeInput();
  input.isTTY = false;
  const output = new FakeOutput();
  assert.throws(
    () =>
      createTerminal(
        input as unknown as NodeJS.ReadStream,
        output as unknown as NodeJS.WriteStream,
      ),
    TuiTerminalError,
  );
  assert.equal(output.data, "");
  assert.ok(!output.data.includes("\u001b"));
});

test("isTtyOk only accepts a stream that reports isTTY", () => {
  assert.equal(isTtyOk({ isTTY: true }), true);
  assert.equal(isTtyOk({ isTTY: false }), false);
  assert.equal(isTtyOk({}), false);
  assert.equal(isTtyOk(null), false);
  assert.equal(isTtyOk(undefined), false);
});

test("getSize clamps fake stream dimensions and falls back to 80x24", () => {
  assert.deepEqual(getSize({}), { columns: 80, rows: 24 });
  assert.deepEqual(getSize({ columns: 132, rows: 43 }), { columns: 132, rows: 43 });
  assert.deepEqual(getSize({ columns: 0, rows: -1 }), { columns: 80, rows: 24 });
  assert.deepEqual(getSize({ columns: Number.NaN, rows: 2.9 }), {
    columns: 80,
    rows: 2,
  });
});
// ---------------------------------------------------------------------------
// SIGWINCH EPIPE race guard (Windows console teardown)
// ---------------------------------------------------------------------------

function fakeTtyWriteStream(refresh: () => void) {
  const stream = new FakeOutput() as FakeOutput & {
    _refreshSize: () => void;
    __tbResizeGuarded?: boolean;
  };
  stream._refreshSize = refresh;
  return stream;
}

test("guardTtyResizeRefresh swallows only an EPIPE from the size refresh", () => {
  let calls = 0;
  const stream = fakeTtyWriteStream(() => {
    calls += 1;
    const err = new Error("getWindowSize EPIPE") as NodeJS.ErrnoException;
    err.code = "EPIPE";
    throw err;
  });
  guardTtyResizeRefresh(stream);
  assert.doesNotThrow(() => stream._refreshSize());
  assert.equal(calls, 1, "the wrapped refresh still ran");
});

test("guardTtyResizeRefresh rethrows any non-EPIPE error", () => {
  const stream = fakeTtyWriteStream(() => {
    const err = new Error("getWindowSize EINVAL") as NodeJS.ErrnoException;
    err.code = "EINVAL";
    throw err;
  });
  guardTtyResizeRefresh(stream);
  assert.throws(() => stream._refreshSize(), /EINVAL/);
});

test("guardTtyResizeRefresh is idempotent and a no-op without _refreshSize", () => {
  let calls = 0;
  const stream = fakeTtyWriteStream(() => {
    calls += 1;
  });
  guardTtyResizeRefresh(stream);
  guardTtyResizeRefresh(stream);
  stream._refreshSize();
  assert.equal(calls, 1, "second guard must not wrap twice");
  assert.doesNotThrow(() => guardTtyResizeRefresh(new FakeOutput()));
  assert.doesNotThrow(() => guardTtyResizeRefresh(null));
  assert.doesNotThrow(() => guardTtyResizeRefresh(undefined));
});
