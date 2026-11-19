/**
 * TUI copy-honesty suite: the default Ctrl+X writer's strict OSC 52 sink.
 *
 * The driver deliberately suppresses attention output on a plain (`TERM=dumb`)
 * terminal, a non-TTY stream, or while it is restored/suspended. The copy path
 * must treat that suppression as a FAILURE: `copyToClipboard` converts a
 * throwing sink into an honest `{ok:false}`, so the toast says `copy failed`
 * instead of claiming `via OSC 52` when zero escape bytes were emitted. The
 * suppression policy itself is unchanged (`writeAttention` stays a no-op).
 *
 * Hermetic: fake TTY streams and an injected platform/env, so no native
 * clipboard helper is spawned and no real clipboard is touched.
 *
 * Run with: node --test tests/tuicopyhonesty.test.ts
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import { osc52Sequence } from "../src/tui/clipboard.ts";
import { createTerminalClipboardWriter } from "../src/tui/app.ts";
import { createTerminal } from "../src/tui/terminal.ts";

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
  /** Throw on any chunk containing this text (a dead/gone output). */
  failOn: string | null = null;
  write(chunk: string): boolean {
    if (this.failOn !== null && chunk.includes(this.failOn)) {
      throw new Error("write EPIPE");
    }
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

/** The app's real Ctrl+X writer, with native helpers disabled (no display env). */
function writerFor(terminal: ReturnType<typeof createTerminal>) {
  return createTerminalClipboardWriter(terminal, { platform: "linux", env: {} });
}

async function withTerm<T>(term: string | undefined, body: () => Promise<T>): Promise<T> {
  const previous = process.env.TERM;
  try {
    if (term === undefined) delete process.env.TERM;
    else process.env.TERM = term;
    return await body();
  } finally {
    if (previous === undefined) delete process.env.TERM;
    else process.env.TERM = previous;
  }
}

test("a dumb terminal with no native writer fails the copy honestly (zero escape bytes)", async () => {
  await withTerm("dumb", async () => {
    const { output, terminal } = terminalWith();
    terminal.enter();
    const before = output.data.length;

    const result = await writerFor(terminal)("hello");

    assert.deepEqual(
      { ok: result.ok, method: result.method, chars: result.chars },
      { ok: false, method: null, chars: 5 },
      "the copy must not be reported as a success",
    );
    assert.match(result.error ?? "", /OSC 52: attention output is suppressed/);
    assert.match(result.error ?? "", /TERM=dumb|non-TTY/);
    assert.equal(output.data.length, before, "the suppressed sink wrote nothing");
    assert.ok(!output.data.includes("\u001b]52;"), "no OSC 52 sequence reached the terminal");
  });
});

test("a normal terminal writes exactly one OSC 52 sequence and reports it", async () => {
  await withTerm("xterm-256color", async () => {
    const { output, terminal } = terminalWith();
    terminal.enter();

    const result = await writerFor(terminal)("hello");

    assert.deepEqual(
      { ok: result.ok, method: result.method, chars: result.chars },
      { ok: true, method: "osc52", chars: 5 },
    );
    const occurrences = output.data.split("\u001b]52;c;").length - 1;
    assert.equal(occurrences, 1, "one sequence, not zero and not two");
    assert.ok(output.data.includes(osc52Sequence("hello") ?? "\u0000"));
  });
});

test("an output that refuses the sequence is a copy failure, not a silent success", async () => {
  await withTerm("xterm-256color", async () => {
    const { output, terminal } = terminalWith();
    terminal.enter();
    output.failOn = "\u001b]52;";

    const result = await writerFor(terminal)("hello");

    assert.equal(result.ok, false);
    assert.equal(result.method, null);
    assert.match(result.error ?? "", /OSC 52: write EPIPE/);
    assert.ok(!output.data.includes("\u001b]52;"));
  });
});

test("a restored or suspended driver reports an honest copy failure", async () => {
  await withTerm("xterm-256color", async () => {
    const suspended = terminalWith();
    suspended.terminal.enter();
    suspended.terminal.suspend();
    const whileSuspended = await writerFor(suspended.terminal)("hello");
    assert.equal(whileSuspended.ok, false);
    assert.match(whileSuspended.error ?? "", /OSC 52: the terminal is not available/);
    assert.ok(
      !suspended.output.data.includes("\u001b]52;"),
      "a suspended driver must not write into a child process's screen",
    );
    suspended.terminal.resume();
    suspended.terminal.restore();

    const restored = terminalWith();
    restored.terminal.enter();
    restored.terminal.restore();
    const afterRestore = await writerFor(restored.terminal)("hello");
    assert.equal(afterRestore.ok, false);
    assert.match(afterRestore.error ?? "", /OSC 52: the terminal is not available/);
    assert.ok(!restored.output.data.includes("\u001b]52;"));
  });
});

test("the attention policy is unchanged: writeAttention still no-ops on a dumb terminal", async () => {
  await withTerm("dumb", async () => {
    const { output, terminal } = terminalWith();
    terminal.enter();
    const before = output.data.length;

    assert.doesNotThrow(() => terminal.writeAttention("\u001b]52;c;aGVsbG8=\u0007"));

    assert.equal(output.data.length, before, "the non-strict sink stays a silent no-op");
  });
});
