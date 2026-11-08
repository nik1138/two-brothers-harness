/**
 * TUI attention suite: the pure title/notification builders (OSC 9 allow-list,
 * tmux DCS passthrough, BEL fallback, sanitize/cap, title matrix) plus the
 * guarded terminal writes (`setTitle`/`notify`, reset on restore, non-TTY and
 * `TERM=dumb` no-ops). Hermetic — fake TTY streams, no terminal attached.
 *
 * Run with: node --test tests/tuiattention.test.ts
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import {
  MAX_NOTIFICATION_CHARS,
  MAX_TITLE_CHARS,
  PRODUCT_NAME,
  sanitizeAttentionText,
  terminalNotification,
  terminalTitle,
  terminalTitleSequence,
} from "../src/tui/attention.ts";
import { createTerminal } from "../src/tui/terminal.ts";

// ---------------------------------------------------------------------------
// title matrix
// ---------------------------------------------------------------------------

test("terminalTitle builds the product/session/status matrix", () => {
  assert.equal(terminalTitle(), "Two Brothers");
  assert.equal(terminalTitle({ session: null }), "Two Brothers");
  assert.equal(terminalTitle({ session: "   " }), "Two Brothers");
  assert.equal(terminalTitle({ session: "s.jsonl" }), "Two Brothers — s.jsonl");
  for (const status of ["working", "approval", "done", "failed"] as const) {
    assert.equal(
      terminalTitle({ session: "s.jsonl", status }),
      `Two Brothers — s.jsonl · ${status}`,
    );
  }
  assert.equal(terminalTitle({ status: "working" }), "Two Brothers · working");
  assert.equal(
    terminalTitle({ product: "Custom", session: "s" }),
    "Custom — s",
  );
});

test("terminalTitle ignores unknown statuses and strips control bytes", () => {
  assert.equal(terminalTitle({ session: "s", status: "celebrating" }), "Two Brothers — s");
  assert.equal(
    terminalTitle({ session: "bad\u001b]0;own\u0007title" }),
    "Two Brothers — bad ]0;own title",
  );
  assert.equal(sanitizeAttentionText("a\u0000b\u001b]9;x\u0007c\n d"), "a b ]9;x c d");
});

test("terminalTitle caps at 120 chars and keeps the status visible", () => {
  const title = terminalTitle({ session: "s".repeat(400), status: "working" });
  assert.ok(title.length <= MAX_TITLE_CHARS, `length ${title.length}`);
  assert.ok(title.endsWith(" · working"), title);
  assert.ok(title.includes("…"), "the cut is marked");
});

// ---------------------------------------------------------------------------
// notification bytes
// ---------------------------------------------------------------------------

test("terminalNotification emits one OSC 9 for each allow-listed terminal", () => {
  const expected = "\u001b]9;Approval: write a.ts\u0007";
  for (const program of ["iTerm.app", "WezTerm", "ghostty", "WarpTerminal"]) {
    assert.equal(
      terminalNotification(
        { title: "Approval", body: "write a.ts" },
        { TERM_PROGRAM: program },
      ),
      expected,
      program,
    );
  }
  for (const term of ["xterm-kitty", "ghostty", "xterm-ghostty"]) {
    assert.equal(
      terminalNotification({ title: "Approval", body: "write a.ts" }, { TERM: term }),
      expected,
      term,
    );
  }
});

test("terminalNotification falls back to exactly one BEL elsewhere", () => {
  assert.equal(terminalNotification({ title: "Done" }, {}), "\u0007");
  assert.equal(
    terminalNotification({ title: "Done" }, { TERM_PROGRAM: "Apple_Terminal", TERM: "xterm-256color" }),
    "\u0007",
  );
  assert.equal(terminalNotification({ title: "", body: "x" }, {}), "\u0007");
});

test("terminalNotification wraps OSC 9 in a tmux DCS passthrough", () => {
  const expected =
    "\u001bPtmux;\u001b\u001b]9;Approval: write a.ts\u0007\u001b\\";
  assert.equal(
    terminalNotification(
      { title: "Approval", body: "write a.ts" },
      { TMUX: "/tmp/tmux-1000/default,123,0", TERM_PROGRAM: "iTerm.app" },
    ),
    expected,
  );
  // tmux wins even when the terminal itself is not on the OSC 9 allow-list
  assert.equal(
    terminalNotification({ title: "Done" }, { TMUX: "1" }),
    "\u001bPtmux;\u001b\u001b]9;Done\u0007\u001b\\",
  );
});

test("terminalNotification strips controls and caps the message", () => {
  const sequence = terminalNotification(
    {
      title: "Title\u0007\u001b]0;evil",
      body: `${"b".repeat(400)}\u001b\\more`,
    },
    { TERM_PROGRAM: "WezTerm" },
  );
  assert.ok(sequence.startsWith("\u001b]9;"));
  assert.ok(sequence.endsWith("\u0007"));
  assert.equal(
    sequence.slice(0, -1).split("\u0007").length - 1,
    0,
    "no embedded BEL can terminate the OSC early",
  );
  const message = sequence.slice("\u001b]9;".length, -1);
  assert.equal(message.length, MAX_NOTIFICATION_CHARS);
  assert.ok(!message.includes("\u001b"));
});

// ---------------------------------------------------------------------------
// terminal guard (setTitle / notify / restore)
// ---------------------------------------------------------------------------

class FakeInput extends EventEmitter {
  isTTY = true;
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  setEncoding(): void {}
  unref(): void {}
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

function terminalWith(outputTTY = true): {
  output: FakeOutput;
  terminal: ReturnType<typeof createTerminal>;
} {
  const input = new FakeInput();
  const output = new FakeOutput();
  output.isTTY = outputTTY;
  const terminal = createTerminal(
    input as unknown as NodeJS.ReadStream,
    output as unknown as NodeJS.WriteStream,
  );
  return { output, terminal };
}

test("terminal.setTitle writes one OSC 0 and restore resets the product title", () => {
  const { output, terminal } = terminalWith();
  terminal.enter();
  terminal.setTitle("Two Brothers — s.jsonl · working");
  terminal.restore();
  assert.ok(output.data.includes(terminalTitleSequence("Two Brothers — s.jsonl · working")));
  assert.ok(
    output.data.includes(terminalTitleSequence(PRODUCT_NAME)),
    "the shell prompt does not inherit a stale run status",
  );
  const written = output.data.length;
  terminal.setTitle("after restore");
  assert.equal(output.data.length, written, "post-restore title writes are silent");
});

test("terminal.setTitle/notify are no-ops on a non-TTY output and TERM=dumb", () => {
  const nonTty = terminalWith(false);
  nonTty.terminal.setTitle("nope");
  nonTty.terminal.notify({ title: "nope" });
  nonTty.terminal.restore();
  assert.ok(!nonTty.output.data.includes("\u001b]0;"));
  assert.ok(!nonTty.output.data.includes("\u001b]9;"));

  const previous = process.env.TERM;
  try {
    process.env.TERM = "dumb";
    const plain = terminalWith();
    plain.terminal.enter();
    plain.terminal.setTitle("nope");
    plain.terminal.notify({ title: "nope" });
    plain.terminal.restore();
    assert.ok(!plain.output.data.includes("\u001b]0;"), "plain terminal gets no title");
    assert.ok(!plain.output.data.includes("\u001b]9;"), "plain terminal gets no OSC 9");
  } finally {
    if (previous === undefined) delete process.env.TERM;
    else process.env.TERM = previous;
  }
});

test("terminal.notify writes the allow-listed OSC 9 through the driver", () => {
  const previousProgram = process.env.TERM_PROGRAM;
  const previousTerm = process.env.TERM;
  try {
    process.env.TERM_PROGRAM = "iTerm.app";
    delete process.env.TERM;
    const { output, terminal } = terminalWith();
    terminal.enter();
    terminal.notify({ title: "Approval", body: "write a.ts" });
    terminal.restore();
    assert.ok(output.data.includes("\u001b]9;Approval: write a.ts\u0007"));
  } finally {
    if (previousProgram === undefined) delete process.env.TERM_PROGRAM;
    else process.env.TERM_PROGRAM = previousProgram;
    if (previousTerm === undefined) delete process.env.TERM;
    else process.env.TERM = previousTerm;
  }
});

test("terminal.restore writes no title reset when no title was set", () => {
  const { output, terminal } = terminalWith();
  terminal.enter();
  terminal.restore();
  assert.ok(!output.data.includes("\u001b]0;"));
});
