/**
 * TUI unit suite: the pure render layer, the stream-event reducer, the input
 * resolver and the non-TTY guard. Hermetic — no terminal, no subprocess, no
 * network; a fake `{isTTY: false}` stream is enough to cover the CI path.
 *
 * Run with: node --test tests/tui.test.ts
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import { resolveConfig } from "../src/config.ts";
import type { Message } from "../src/protocol.ts";
import type { StreamEvent } from "../src/runstream.ts";
import type { CommandCatalog } from "../src/commands.ts";
import {
  createLineBuffer,
  envelopeToLine,
  loadTuiResources,
  printableChar,
  pushLineToBuffer,
  reduceStreamEvent,
  resolveTuiInput,
  runTuiApp,
  type TuiIO,
  type TuiLineBuffer,
} from "../src/tui/app.ts";
import {
  ANSI,
  CURSOR,
  KIND_STYLE,
  RESET,
  appendText,
  pushLine,
  renderFrame,
  stripAnsi,
  wrapLine,
  type TuiLine,
  type TuiState,
} from "../src/tui/render.ts";
import {
  createTerminal,
  getSize,
  isTtyOk,
  TuiTerminalError,
} from "../src/tui/terminal.ts";
import { main, type CliIO } from "../src/cli.ts";

const ESC = "\x1b";

function makeState(overrides: Partial<TuiState> = {}): TuiState {
  return {
    header: {
      mode: "consult",
      seniorModel: "senior-model",
      juniorModel: "junior-model",
      sessionName: "session-1",
    },
    lines: [],
    input: "",
    status: "ready",
    scrollOffset: 0,
    height: 12,
    width: 40,
    ...overrides,
  };
}

function plainRows(frame: string): string[] {
  return frame.split("\n").map((row) => stripAnsi(row));
}

function bodyRows(frame: string): string[] {
  const rows = plainRows(frame);
  return rows.slice(2, rows.length - 3);
}

function makeIO(): TuiIO & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, log: (line) => out.push(line), error: (line) => err.push(line) };
}

function message(
  from: string,
  kind: string,
  payload: Record<string, unknown>,
): Message {
  return {
    v: 1,
    id: `id-${from}-${kind}`,
    seq: 1,
    ts: "2026-11-04T00:00:00Z",
    from,
    to: from === "user" ? "senior" : "user",
    kind,
    payload,
  };
}

function tokenEvent(role: "senior" | "junior", delta: string): StreamEvent {
  return { type: "token", role, delta, at: "2026-11-04T00:00:00Z" };
}

function envelopeEvent(from: string, kind: string, payload: Record<string, unknown>): StreamEvent {
  return {
    type: "envelope",
    envelope: message(from, kind, payload),
    at: "2026-11-04T00:00:00Z",
  };
}

const EMPTY_COMMANDS: CommandCatalog = { commands: [], diagnostics: [] };

// ---------------------------------------------------------------------------
// wrapLine
// ---------------------------------------------------------------------------

test("wrapLine: greedy word wrap at the width boundary", () => {
  assert.deepEqual(wrapLine({ kind: "system", text: "one two three" }, 7, { plain: true }), [
    "one two",
    "three",
  ]);
  assert.deepEqual(wrapLine({ kind: "system", text: "abcd" }, 4, { plain: true }), ["abcd"]);
  assert.deepEqual(wrapLine({ kind: "system", text: "abcde" }, 4, { plain: true }), [
    "abcd",
    "e",
  ]);
});

test("wrapLine: words longer than the width are hard-split, never dropped", () => {
  assert.deepEqual(wrapLine({ kind: "tool", text: "abcdefghij" }, 4, { plain: true }), [
    "abcd",
    "efgh",
    "ij",
  ]);
  const joined = wrapLine({ kind: "tool", text: "prefix supercalifragilistic end" }, 10, {
    plain: true,
  }).join("");
  assert.ok(joined.includes("supercalifragilistic"));
});

test("wrapLine: explicit newlines and blank paragraphs become rows", () => {
  assert.deepEqual(
    wrapLine({ kind: "senior", text: "a\n\nb" }, 10, { plain: true }),
    ["a", "", "b"],
  );
  assert.deepEqual(wrapLine({ kind: "senior", text: "" }, 10, { plain: true }), [""]);
});

test("wrapLine: ANSI color prefixes do not count toward width", () => {
  const wrapped = wrapLine({ kind: "user", text: "alpha beta gamma" }, 10);
  assert.ok(wrapped.length > 1);
  for (const row of wrapped) {
    assert.ok(row.startsWith(KIND_STYLE.user), "row carries the kind color");
    assert.ok(row.endsWith(RESET), "row resets the color");
    const width = stripAnsi(row).length;
    assert.ok(width <= 10, `plain width ${width} exceeds 10`);
    assert.ok(!stripAnsi(row).startsWith(" "), "no leading space after a break");
  }
  assert.equal(
    wrapped.map((row) => stripAnsi(row)).join(" "),
    "alpha beta gamma",
    "wrapping preserves the words",
  );
});

test("wrapLine: plain mode strips colors, including escapes embedded in the text", () => {
  const rows = wrapLine(
    { kind: "error", text: `${ESC}[31mred${ESC}[0m text` },
    40,
    { plain: true },
  );
  assert.deepEqual(rows, ["red text"]);
  assert.ok(!rows[0].includes(ESC));
  // non-plain still colors the row, but the embedded escape is removed first
  const colored = wrapLine({ kind: "error", text: `${ESC}[32mok${ESC}[0m` }, 40);
  assert.ok(colored[0].startsWith(KIND_STYLE.error));
  assert.ok(colored[0].includes("ok"));
});

test("wrapLine: width and tabs are sane", () => {
  assert.deepEqual(wrapLine({ kind: "system", text: "ab" }, 0, { plain: true }), ["a", "b"]);
  const tabbed = wrapLine({ kind: "system", text: "a\tb" }, 10, { plain: true });
  assert.deepEqual(tabbed, ["a    b"]);
});

// ---------------------------------------------------------------------------
// renderFrame
// ---------------------------------------------------------------------------

test("renderFrame: exactly `height` rows across terminal sizes", () => {
  for (const height of [10, 12, 18, 24, 40]) {
    for (const width of [20, 40, 80]) {
      const frame = renderFrame(makeState({ height, width }));
      assert.equal(frame.split("\n").length, height, `height ${height} width ${width}`);
      for (const row of frame.split("\n")) {
        assert.ok(stripAnsi(row).length <= width, `row wider than ${width}: ${stripAnsi(row)}`);
      }
    }
  }
});

test("renderFrame: header carries the mode, both models and the session", () => {
  const rows = plainRows(renderFrame(makeState({ width: 120 })));
  const header = rows[0];
  assert.ok(header.startsWith("two-brothers"));
  assert.match(header, /mode=consult/);
  assert.match(header, /senior=senior-model/);
  assert.match(header, /junior=junior-model/);
  assert.match(header, /session=session-1/);
  assert.match(rows[1], /^─+$/);
  assert.ok(rows[rows.length - 2].startsWith("> "), "input line is above the status bar");
  assert.equal(rows[rows.length - 1].trimEnd(), "ready");
});

test("renderFrame: determinism — the same state renders the same bytes", () => {
  const state = makeState({
    lines: [
      { kind: "user", text: "hello brothers, please review this change" },
      { kind: "senior", text: "consult: what do you think?" },
    ],
    input: "next question",
    status: "running…",
    scrollOffset: 1,
  });
  assert.equal(renderFrame(state), renderFrame(state));
  assert.equal(renderFrame(state, { plain: true }), renderFrame(state, { plain: true }));
});

test("renderFrame: the visible window is bottom-anchored and scrollOffset moves up", () => {
  const lines: TuiLine[] = [];
  for (let i = 0; i < 30; i += 1) {
    lines.push({ kind: "system", text: `line-${String(i).padStart(2, "0")}` });
  }
  const height = 10; // 5 body rows
  const pinned = bodyRows(renderFrame(makeState({ lines, height, width: 40 })));
  assert.equal(pinned.length, 5);
  assert.deepEqual(pinned, ["line-25", "line-26", "line-27", "line-28", "line-29"]);

  const scrolled = bodyRows(
    renderFrame(makeState({ lines, height, width: 40, scrollOffset: 5 })),
  );
  assert.deepEqual(scrolled, ["line-20", "line-21", "line-22", "line-23", "line-24"]);

  const clamped = bodyRows(
    renderFrame(makeState({ lines, height, width: 40, scrollOffset: 10_000 })),
  );
  assert.deepEqual(clamped, ["line-00", "line-01", "line-02", "line-03", "line-04"]);
  const status = plainRows(
    renderFrame(makeState({ lines, height, width: 40, scrollOffset: 5 })),
  ).at(-1);
  assert.match(status ?? "", /\[scroll ↑5\]/);
});

test("renderFrame: short transcripts fill from the bottom, wrapping is respected", () => {
  const state = makeState({
    height: 10,
    width: 20,
    lines: [
      { kind: "user", text: "this sentence is long enough to wrap over several rows" },
      { kind: "junior", text: "short" },
    ],
  });
  const body = bodyRows(renderFrame(state));
  assert.equal(body.length, 5);
  assert.deepEqual(body, [
    "",
    "this sentence is",
    "long enough to wrap",
    "over several rows",
    "short",
  ]);
  assert.ok(body.every((row) => row.length <= 20));
  // newest line is the last non-blank body row
  const nonBlank = body.filter((row) => row.trim() !== "");
  assert.equal(nonBlank.at(-1), "short");
});

test("renderFrame: empty lines give a blank body and keep the input line", () => {
  const rows = plainRows(renderFrame(makeState({ height: 12 })));
  assert.equal(bodyRows(renderFrame(makeState({ height: 12 }))).join("").trim(), "");
  assert.ok(rows.at(-2)?.startsWith("> "));
  assert.ok(rows.at(-2)?.includes(CURSOR));
});

test("renderFrame: the input line keeps the tail visible and always shows the cursor", () => {
  const state = makeState({ width: 20, input: "abcdefghijklmnopqrstuvwxyz" });
  const inputRow = plainRows(renderFrame(state)).at(-2) ?? "";
  assert.ok(inputRow.includes(CURSOR));
  assert.ok(inputRow.length <= 20);
  assert.ok(inputRow.startsWith("> "));
  assert.ok(inputRow.includes("wxyz"), "the newest characters stay visible");
});

test("renderFrame: plain mode emits no escape bytes", () => {
  const frame = renderFrame(
    makeState({
      lines: [
        { kind: "user", text: "hi" },
        { kind: "error", text: "boom" },
      ],
      input: "x",
    }),
    { plain: true },
  );
  assert.ok(!frame.includes(ESC));
  assert.ok(!frame.includes(ANSI.reset));
});

test("renderFrame: a too-short terminal degrades to header/input/status", () => {
  assert.equal(renderFrame(makeState({ height: 0 })), "");
  const rows = plainRows(renderFrame(makeState({ height: 3 })));
  assert.equal(rows.length, 3);
  assert.ok(rows[0].startsWith("two-brothers"));
  assert.ok(rows[1].startsWith("> "));
  assert.equal(rows[2].trimEnd(), "ready");
});

// ---------------------------------------------------------------------------
// pushLine / appendText
// ---------------------------------------------------------------------------

test("pushLine and appendText are immutable and append in place", () => {
  const base = makeState({ lines: [{ kind: "senior", text: "hello" }] });
  const pushed = pushLine(base, { kind: "tool", text: "call" });
  assert.equal(base.lines.length, 1, "the original state is untouched");
  assert.equal(pushed.lines.length, 2);
  assert.deepEqual(pushed.lines[1], { kind: "tool", text: "call" });

  const appended = appendText(pushed, "tool", " result");
  assert.equal(pushed.lines[1].text, "call", "the input state is untouched");
  assert.deepEqual(appended.lines[1], { kind: "tool", text: "call result" });

  const different = appendText(appended, "junior", "hi");
  assert.equal(different.lines.length, 3);
  assert.deepEqual(different.lines[2], { kind: "junior", text: "hi" });
});

// ---------------------------------------------------------------------------
// reduceStreamEvent
// ---------------------------------------------------------------------------

test("reduceStreamEvent: token deltas accumulate into one draft line", () => {
  const first = reduceStreamEvent(createLineBuffer(), tokenEvent("senior", "Hel"));
  const second = reduceStreamEvent(first.buffer, tokenEvent("senior", "lo"));
  assert.deepEqual(second.buffer.lines, [{ kind: "senior", text: "Hello" }]);
  assert.equal(second.buffer.pending, 0);
});

test("reduceStreamEvent: a different role starts a new draft line", () => {
  let buffer = reduceStreamEvent(createLineBuffer(), tokenEvent("senior", "a")).buffer;
  buffer = reduceStreamEvent(buffer, tokenEvent("junior", "b")).buffer;
  assert.deepEqual(buffer.lines, [
    { kind: "senior", text: "a" },
    { kind: "junior", text: "b" },
  ]);
  assert.equal(buffer.pending, 1);
});

test("reduceStreamEvent: the committed envelope replaces the token draft in place", () => {
  let buffer = reduceStreamEvent(createLineBuffer(), tokenEvent("senior", "draft")).buffer;
  const result = reduceStreamEvent(
    buffer,
    envelopeEvent("senior", "proposal", {
      title: "Plan",
      answer: "Do the thing",
      confidence: "high",
    }),
  );
  assert.equal(result.buffer.lines.length, 1, "no duplicated reply");
  assert.equal(result.buffer.lines[0].kind, "senior");
  assert.match(result.buffer.lines[0].text, /^proposal: Plan/);
  assert.match(result.buffer.lines[0].text, /Do the thing/);
  assert.equal(result.buffer.pending, null);
});

test("reduceStreamEvent: tool events append without losing the token draft", () => {
  let buffer = reduceStreamEvent(createLineBuffer(), tokenEvent("junior", "working")).buffer;
  buffer = reduceStreamEvent(buffer, {
    type: "tool_call",
    role: "junior",
    tool: "workspace_read_file",
    at: "t",
  }).buffer;
  buffer = reduceStreamEvent(buffer, {
    type: "tool_result",
    role: "junior",
    tool: "workspace_read_file",
    status: "ok",
    at: "t",
  }).buffer;
  assert.deepEqual(buffer.lines.map((line) => line.kind), ["junior", "tool", "tool"]);
  buffer = reduceStreamEvent(
    buffer,
    envelopeEvent("junior", "deliverable", { result: "done" }),
  ).buffer;
  assert.equal(buffer.lines[0].kind, "junior");
  assert.match(buffer.lines[0].text, /deliverable: done/);
  assert.equal(buffer.lines.length, 3);
  assert.equal(buffer.pending, null);
});

test("reduceStreamEvent: run lifecycle and result drive the status bar", () => {
  const started = reduceStreamEvent(createLineBuffer(), {
    type: "run_status",
    status: "started",
    at: "t",
  });
  assert.equal(started.status, "running…");
  const completed = reduceStreamEvent(createLineBuffer(), {
    type: "run_status",
    status: "completed",
    at: "t",
  });
  assert.match(completed.status ?? "", /completed/);
  const failed = reduceStreamEvent(createLineBuffer(), {
    type: "run_status",
    status: "failed",
    at: "t",
  });
  assert.match(failed.status ?? "", /failed/);
  const cancelled = reduceStreamEvent(createLineBuffer(), {
    type: "run_status",
    status: "cancelled",
    at: "t",
  });
  assert.match(cancelled.status ?? "", /cancelled/);
  const result = reduceStreamEvent(createLineBuffer(), {
    type: "result",
    result: {
      decision: {},
      usage: { model_calls: 3, input_tokens: 10, output_tokens: 5, cached_tokens: 0 },
      warnings: 0,
      sessionFile: null,
    },
    at: "t",
  });
  assert.match(result.status ?? "", /10\/5 tokens/);
});

test("reduceStreamEvent: pure — the input buffer is never mutated", () => {
  const original = createLineBuffer([{ kind: "system", text: "seed" }]);
  const snapshot: TuiLineBuffer = { lines: original.lines.map((line) => ({ ...line })), pending: null };
  reduceStreamEvent(original, tokenEvent("senior", "x"));
  reduceStreamEvent(original, envelopeEvent("senior", "decision", { decision: "yes" }));
  assert.deepEqual(original, snapshot);
});

test("reduceStreamEvent: long token drafts are clipped with a marker", () => {
  const result = reduceStreamEvent(createLineBuffer(), tokenEvent("senior", "abcdef"), {
    maxTextChars: 4,
  });
  assert.match(result.buffer.lines[0].text, /^abcd.+\(\+2 chars\)/);
});

test("envelopeToLine: kinds render readable text, user messages as the user", () => {
  assert.deepEqual(envelopeToLine(message("user", "message", { text: "hello" })), {
    kind: "user",
    text: "hello",
  });
  assert.match(
    envelopeToLine(message("senior", "consult", { ask: "why?", expect: "proposal" })).text,
    /consult: why\?/,
  );
  assert.match(
    envelopeToLine(message("senior", "review", { verdict: "accept", notes: "looks good" })).text,
    /review: accept[\s\S]*looks good/,
  );
  const decision = envelopeToLine(
    message("senior", "decision", {
      decision: "ship it",
      rationale: "tests pass",
      confidence: "high",
      dissent: "none",
    }),
  );
  assert.equal(decision.kind, "senior");
  assert.match(decision.text, /decision: ship it/);
  assert.match(decision.text, /rationale: tests pass/);
  assert.equal(envelopeToLine(message("junior", "deliverable", { result: "r" })).kind, "junior");
  assert.match(
    envelopeToLine(message("junior", "weird-kind", { x: 1 })).text,
    /^weird-kind: \{/,
  );
});

// ---------------------------------------------------------------------------
// resolveTuiInput
// ---------------------------------------------------------------------------

test("resolveTuiInput: plain tasks, empty input and builtins", () => {
  assert.deepEqual(resolveTuiInput("", EMPTY_COMMANDS), { type: "none" });
  assert.deepEqual(resolveTuiInput("   ", EMPTY_COMMANDS), { type: "none" });
  assert.deepEqual(resolveTuiInput("please review", EMPTY_COMMANDS), {
    type: "run",
    task: "please review",
  });
  assert.deepEqual(resolveTuiInput("/exit", EMPTY_COMMANDS), { type: "exit" });
  assert.deepEqual(resolveTuiInput("/quit", EMPTY_COMMANDS), { type: "exit" });
  assert.deepEqual(resolveTuiInput("/mode work", EMPTY_COMMANDS), {
    type: "mode",
    mode: "work",
  });
  const badMode = resolveTuiInput("/mode turbo", EMPTY_COMMANDS);
  assert.equal(badMode.type, "lines");
  if (badMode.type === "lines") assert.match(badMode.lines[0].text, /\/mode consult\|work/);
});

test("resolveTuiInput: /help and /commands list discovered commands", () => {
  const catalog: CommandCatalog = {
    commands: [
      {
        name: "summarize",
        description: "Summarize a document",
        argumentHint: "<path>",
        file: "/tmp/summarize.md",
        body: "Summarize $ARGUMENTS",
        mode: "work",
      },
    ],
    diagnostics: [],
  };
  const help = resolveTuiInput("/help", catalog);
  assert.equal(help.type, "lines");
  if (help.type === "lines") {
    const text = help.lines.map((line) => line.text).join("\n");
    assert.match(text, /\/mode consult\|work/);
    assert.match(text, /summarize — Summarize a document \(<path>\)/);
  }
  const list = resolveTuiInput("/commands", catalog);
  assert.equal(list.type, "lines");
  if (list.type === "lines") {
    assert.deepEqual(list.lines, [
      { kind: "system", text: "/summarize — Summarize a document (<path>)" },
    ]);
  }
  const bare = resolveTuiInput("/commands", EMPTY_COMMANDS);
  assert.equal(bare.type, "lines");
  if (bare.type === "lines") assert.match(bare.lines[0].text, /no slash commands/);
});

test("resolveTuiInput: known commands expand, unknown names are errors not tasks", () => {
  const catalog: CommandCatalog = {
    commands: [
      {
        name: "summarize",
        description: "d",
        argumentHint: "",
        file: "/tmp/summarize.md",
        body: "Summarize $1; context: $ARGUMENTS",
        mode: "work",
      },
    ],
    diagnostics: [],
  };
  assert.deepEqual(resolveTuiInput("/summarize docs/readme.md", catalog), {
    type: "run",
    task: "Summarize docs/readme.md; context: docs/readme.md",
    mode: "work",
  });
  const unknown = resolveTuiInput("/nope now", catalog);
  assert.equal(unknown.type, "lines");
  if (unknown.type === "lines") {
    assert.equal(unknown.lines[0].kind, "error");
    assert.match(unknown.lines[0].text, /unknown command: nope/);
  }
  // a path-like slash input is not a command and is submitted verbatim
  assert.deepEqual(resolveTuiInput("/usr/bin is a path", catalog), {
    type: "run",
    task: "/usr/bin is a path",
  });
});

// ---------------------------------------------------------------------------
// terminal guard + size
// ---------------------------------------------------------------------------

test("isTtyOk: only a real isTTY stream passes", () => {
  assert.equal(isTtyOk({ isTTY: true }), true);
  assert.equal(isTtyOk({ isTTY: false }), false);
  assert.equal(isTtyOk({}), false);
  assert.equal(isTtyOk(null), false);
  assert.equal(isTtyOk(undefined), false);
});

test("createTerminal refuses a non-TTY stdin with a clean error", () => {
  const input = { isTTY: false } as unknown as NodeJS.ReadStream;
  const output = { isTTY: false } as unknown as NodeJS.WriteStream;
  assert.throws(() => createTerminal(input, output), TuiTerminalError);
});

test("getSize falls back to 80x24", () => {
  assert.deepEqual(getSize({}), { columns: 80, rows: 24 });
  assert.deepEqual(getSize({ columns: 120, rows: 40 }), { columns: 120, rows: 40 });
  assert.deepEqual(getSize({ columns: 0, rows: -1 }), { columns: 80, rows: 24 });
});

test("printableChar accepts text and rejects control/modified keys", () => {
  assert.equal(printableChar({ name: "a", ctrl: false, shift: false, raw: "a" }), "a");
  assert.equal(printableChar({ name: "A", ctrl: false, shift: true, raw: "A" }), "A");
  assert.equal(printableChar({ name: "c", ctrl: true, shift: false, raw: "\u0003" }), null);
  assert.equal(printableChar({ name: "return", ctrl: false, shift: false, raw: "\r" }), null);
  assert.equal(printableChar({ name: "escape", ctrl: false, shift: false, raw: ESC }), null);
  assert.equal(printableChar({ name: "up", ctrl: false, shift: false, raw: `${ESC}[A` }), null);
});

// ---------------------------------------------------------------------------
// non-TTY app guard + CLI registration
// ---------------------------------------------------------------------------

test("runTuiApp: non-TTY stdin exits 2 with a clean message and no escape codes", async () => {
  const io = makeIO();
  const cfg = resolveConfig({ provider: "mock" });
  const code = await runTuiApp({
    cfg,
    io,
    input: { isTTY: false } as unknown as NodeJS.ReadStream,
    output: { isTTY: false } as unknown as NodeJS.WriteStream,
  });
  assert.equal(code, 2);
  assert.equal(io.out.join(""), "", "nothing is rendered to stdout");
  const stderr = io.err.join("\n");
  assert.match(stderr, /needs an interactive terminal/);
  assert.ok(!stderr.includes(ESC), "no escape byte in the error path");
  assert.ok(!stderr.includes(ANSI.altScreenOn));
});

test("main: --help lists tui and tui --help prints the key guide", async () => {
  const help = makeIO();
  assert.equal(await main(["--help"], help as CliIO), 0);
  assert.match(help.out.join("\n"), /two-brothers tui \[task\]/);
  assert.match(help.out.join("\n"), /--stream-tokens/);

  const tuiHelp = makeIO();
  assert.equal(await main(["tui", "--help"], tuiHelp as CliIO), 0);
  const text = tuiHelp.out.join("\n");
  assert.match(text, /Usage: two-brothers tui/);
  assert.match(text, /PgUp \/ PgDn/);
  assert.match(text, /--stream-tokens/);
});

test("main: tui rejects run output modes before touching the terminal", async () => {
  const io = makeIO();
  assert.equal(await main(["tui", "--provider", "mock", "--mode", "print"], io as CliIO), 2);
  assert.match(io.err.join("\n"), /tui is interactive/);
  assert.equal(io.out.join(""), "");
});

test("loadTuiResources is fail-soft and discovers commands from a temp root", async () => {
  const io = makeIO();
  const resources = await loadTuiResources({
    cfg: resolveConfig({ provider: "mock" }),
    io,
    pluginsDir: `${process.cwd()}/does-not-exist-tui-plugins`,
    skillsRoots: [],
    commandsRoots: [],
  });
  assert.ok(
    resources.plugins === null || resources.plugins.plugins.size === 0,
    "a missing plugins directory is fail-soft and empty",
  );
  assert.ok(Array.isArray(resources.commands.commands));
  assert.ok(Array.isArray(resources.skills.skills));
});

test("pushLineToBuffer keeps the pending token index and is immutable", () => {
  const buffer = reduceStreamEvent(createLineBuffer(), tokenEvent("senior", "draft")).buffer;
  const pushed = pushLineToBuffer(buffer, { kind: "tool", text: "call" });
  assert.equal(pushed.pending, 0);
  assert.equal(buffer.lines.length, 1);
  assert.equal(pushed.lines.length, 2);
});

// ---------------------------------------------------------------------------
// end-to-end loop over fake TTY streams (mock provider, no subprocess)
// ---------------------------------------------------------------------------

class FakeInput extends EventEmitter {
  isTTY = true;
  setRawMode(): void {}
  resume(): void {}
  setEncoding(): void {}
}

class FakeOutput {
  isTTY = true;
  columns = 80;
  rows = 24;
  data = "";
  write(chunk: string): boolean {
    this.data += chunk;
    return true;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
}

test("runTuiApp: a typed task runs a mock turn, renders a decision and restores the screen", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const io = makeIO();
  const app = runTuiApp({
    cfg: resolveConfig({ provider: "mock" }),
    io,
    input: input as unknown as NodeJS.ReadStream,
    output: output as unknown as NodeJS.WriteStream,
    pluginsDir: `${process.cwd()}/does-not-exist-tui-plugins`,
  });

  assert.ok(await waitFor(() => output.data.includes("two-brothers"), 5_000), "first frame");
  for (const char of "hello") input.emit("keypress", char, { name: char, ctrl: false });
  input.emit("keypress", "\r", { name: "return", ctrl: false });
  assert.ok(
    await waitFor(() => output.data.includes("decision:"), 30_000),
    "the mock turn rendered a decision",
  );
  input.emit("keypress", "\u0003", { name: "c", ctrl: true });
  input.emit("keypress", "\u0003", { name: "c", ctrl: true });

  const code = await new Promise<number | "timeout">((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), 10_000);
    app.then((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
  assert.equal(code, 0);
  assert.ok(output.data.includes(ANSI.altScreenOff), "the alternate screen is left");
  assert.ok(output.data.includes(ANSI.showCursor), "the cursor is restored");
  const text = stripAnsi(output.data);
  assert.ok(text.includes("hello"), "the submitted task is in the transcript");
  assert.ok(text.includes("senior"), "a senior line is in the transcript");
});