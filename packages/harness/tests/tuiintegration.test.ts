/**
 * TUI integration suite: the assembled interactive app over fake TTY streams
 * (no subprocess, no network — the mock provider drives the turns). Covers
 * the T0–T3 wiring that the per-lane suites cannot see: the welcome screen,
 * the real editor and bracketed paste, the non-blocking turn loop with
 * cancellation precedence, immediate resize repaint, the Ctrl+P palette,
 * the `?` help overlay, slash commands (mode/theme/settings/models/sessions),
 * status-bar honesty (unset models, unknown cost) and terminal restoration.
 *
 * Run with: node --test tests/tuiintegration.test.ts
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import { resolveConfig } from "../src/config.ts";
import { toNdjsonLine, type ToolCallStreamEvent } from "../src/runstream.ts";
import { CANCELLED_TURN_HINT, runTuiApp, type TuiIO } from "../src/tui/app.ts";
import { stripAnsi } from "../src/tui/render.ts";
import { ANSI } from "../src/tui/render.ts";
import { resolveTheme } from "../src/tui/theme.ts";

const ESC = "\x1b";

class FakeInput extends EventEmitter {
  isTTY = true;
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  setEncoding(): void {}
  unref(): void {}

  type(text: string): void {
    for (const char of text) {
      this.emit("keypress", char, { name: char, ctrl: false, shift: char !== char.toLowerCase() });
    }
  }

  key(name: string, modifiers: { ctrl?: boolean; shift?: boolean; raw?: string } = {}): void {
    this.emit("keypress", modifiers.raw ?? "", {
      name,
      ctrl: modifiers.ctrl === true,
      shift: modifiers.shift === true,
    });
  }

  paste(text: string): void {
    this.emit("keypress", "", { name: "paste-start" });
    this.emit("keypress", text, { name: undefined });
    this.emit("keypress", "", { name: "paste-end" });
  }

  enter(): void {
    this.key("return", { raw: "\r" });
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
  resize(columns: number, rows: number): void {
    this.columns = columns;
    this.rows = rows;
    this.emit("resize");
  }
}

function makeIO(): TuiIO & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, log: (line) => out.push(line), error: (line) => err.push(line) };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
}

interface Harness {
  app: Promise<number>;
  input: FakeInput;
  output: FakeOutput;
  io: ReturnType<typeof makeIO>;
}

function startApp(extra: Partial<Parameters<typeof runTuiApp>[0]> = {}): Harness {
  const input = new FakeInput();
  const output = new FakeOutput();
  const io = makeIO();
  const app = runTuiApp({
    cfg: resolveConfig({ provider: "mock" }),
    io,
    input: input as unknown as NodeJS.ReadStream,
    output: output as unknown as NodeJS.WriteStream,
    pluginsDir: `${process.cwd()}/does-not-exist-tui-plugins`,
    sessionsDir: `${process.cwd()}/does-not-exist-tui-sessions`,
    ...extra,
  });
  return { app, input, output, io };
}

const textOf = (output: FakeOutput): string => stripAnsi(output.data);

/** The newest fully rendered frame (rows joined with newlines). */
const lastFrameText = (output: FakeOutput): string =>
  stripAnsi(output.data.split(ANSI.cursorHome).at(-1) ?? "");

async function quit(input: FakeInput, app: Promise<number>): Promise<number> {
  // Esc precedence: close overlay → cancel a running turn → clear a draft →
  // arm quit → confirm. Send enough presses with settles between them.
  for (let press = 0; press < 5; press += 1) {
    input.key("escape");
    const settled = await Promise.race([
      app.then((code) => code as number | "exited"),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 250)),
    ]);
    if (settled !== "pending") return settled === "exited" ? 0 : settled;
  }
  const code = await Promise.race([
    app,
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 10_000)),
  ]);
  if (code === "timeout") throw new Error("the TUI did not exit after repeated Escape");
  return code;
}

test("welcome screen shows identity, both roles and honest unset markers", async () => {
  const { app, input, output } = startApp();
  assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")), "welcome renders");
  const text = textOf(output);
  assert.match(text, /Two models\. One shared context\. One final decision\./);
  assert.match(text, /SENIOR\s+\(not configured\)/);
  assert.match(text, /JUNIOR\s+\(not configured\)/);
  assert.match(text, /Configure both roles with \/settings/);
  const code = await quit(input, app);
  assert.equal(code, 0);
  assert.ok(output.data.includes(ANSI.altScreenOff));
  assert.ok(output.data.includes(ANSI.showCursor));
  assert.ok(output.data.includes(ANSI.esc + "[?2004l"), "bracketed paste is disabled on exit");
});

test("bracketed paste is one composer edit: newlines never submit", async () => {
  const { app, input, output } = startApp();
  assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));
  input.paste("line one\r\nline two");
  await waitFor(() => textOf(output).includes("line one"));
  // nothing was submitted: no YOU block yet, the draft sits in the composer
  assert.ok(!textOf(output).includes("YOU"));
  input.enter();
  assert.ok(
    await waitFor(() => textOf(output).includes("decision:"), 30_000),
    "the pasted task ran as one turn",
  );
  const code = await quit(input, app);
  assert.equal(code, 0);
});

test("typing ? inside a task inserts the character instead of opening help", async () => {
  const { app, input, output } = startApp();
  assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));
  input.type("what is 2+2?");
  assert.ok(await waitFor(() => textOf(output).includes("what is 2+2?")));
  assert.ok(!textOf(output).includes("Help ("), "? must not open the help overlay");
  const code = await quit(input, app);
  assert.equal(code, 0);
});

test("a typed task runs a mock turn: decision, usage and honest cost unknown", async () => {
  const { app, input, output } = startApp();
  assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));
  input.type("say hello");
  input.enter();
  assert.ok(await waitFor(() => textOf(output).includes("decision:"), 30_000));
  const text = textOf(output);
  assert.match(text, /YOU\s+say hello/);
  assert.match(text, /SENIOR/);
  // mock models are unset/mixed, so the cost is an honest unknown, not $0
  assert.match(text, /cost unknown/);
  const code = await quit(input, app);
  assert.equal(code, 0);
});

test("/exit quits cleanly with code 0 (TuiExit is control flow, not an error)", async () => {
  const { app, input, output } = startApp();
  assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));
  input.type("/exit");
  input.enter();
  const code = await Promise.race([
    app,
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 10_000)),
  ]);
  assert.notEqual(code, "timeout", "the TUI did not exit after /exit");
  assert.equal(code, 0);
  assert.ok(output.data.includes(ANSI.altScreenOff), "alternate screen is restored");
});

test("Ctrl+P opens the palette, filtering narrows, Esc closes it", async () => {
  const { app, input, output } = startApp();
  assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));
  input.key("p", { ctrl: true });
  assert.ok(await waitFor(() => textOf(output).includes("COMMANDS")));
  assert.match(textOf(output), /Command palette/);
  input.type("theme");
  await waitFor(() => /theme/i.test(textOf(output)));
  input.key("escape");
  await waitFor(() => !textOf(output).slice(-2000).includes("COMMANDS"));
  const code = await quit(input, app);
  assert.equal(code, 0);
});

test("? opens the help overlay and Esc restores the composer", async () => {
  const { app, input, output } = startApp();
  assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));
  input.key("?", { shift: true });
  assert.ok(await waitFor(() => textOf(output).includes("HELP")));
  assert.match(textOf(output), /Ctrl\+P/);
  input.key("escape");
  input.type("after help");
  await waitFor(() => textOf(output).includes("after help"));
  const code = await quit(input, app);
  assert.equal(code, 0);
});

test("slash commands: /mode, /theme, /settings dialog and retry guard", async () => {
  const { app, input, output } = startApp();
  assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));
  input.type("/mode work");
  input.enter();
  await waitFor(() => textOf(output).includes("mode: work"));
  input.type("/theme light");
  input.enter();
  await waitFor(() => textOf(output).toLowerCase().includes("theme: light"));
  input.type("/settings");
  input.enter();
  assert.ok(
    await waitFor(() => textOf(output).includes("PROVIDER SETTINGS")),
    "provider settings dialog opens",
  );
  assert.ok(
    textOf(output).includes("API key: not set"),
    "settings shows the effective, key-free connection state",
  );
  input.key("escape");
  input.type("/retry");
  input.enter();
  await waitFor(() => textOf(output).includes("nothing to retry"));
  const code = await quit(input, app);
  assert.equal(code, 0);
});

test("safe key precedence: Esc arms quit, typing disarms, Esc Esc quits; Esc clears a draft", async () => {
  const { app, input, output } = startApp();
  assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));
  input.key("escape");
  await waitFor(() => textOf(output).includes("quit? press Ctrl+C or Esc again"));
  input.type("x");
  await waitFor(() => textOf(output).includes("quit?") === false || textOf(output).includes("x"));
  assert.ok(
    await waitFor(() => textOf(output).includes("quit cancelled"), 2000),
    "disarming replaces the armed quit text instead of leaving it stale",
  );
  // a draft is present: one Esc clears it instead of arming quit
  input.key("escape");
  await waitFor(() => textOf(output).includes("composer cleared"));
  input.key("escape");
  input.key("escape");
  const code = await Promise.race([
    app,
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 10_000)),
  ]);
  assert.equal(code, 0);
});

test("resize repaints immediately at the new width", async () => {
  const { app, input, output } = startApp();
  assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));
  output.resize(60, 20);
  const repainted = await waitFor(() => {
    const frames = output.data.split(ANSI.cursorHome).slice(1);
    const last = frames.at(-1) ?? "";
    const rows = last.split("\n");
    return rows.length > 0 && rows.every((row) => stripAnsi(row).length <= 60);
  });
  assert.ok(repainted, "a frame at the new width was rendered");
  const code = await quit(input, app);
  assert.equal(code, 0);
});

test("welcome frame: the rotating status tip fits at 80 columns and the composer has no mode/models meta row", async () => {
  const { app, input, output } = startApp();
  assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));
  const text = textOf(output);
  // The hint slot now carries a registry-derived rotating tip (the fold action
  // first, since no turn has run yet) instead of the old static pair; the tip
  // outranks optional metrics on the 80-column row.
  assert.ok(
    text.includes("ready — type a task and press Enter · Ctrl+T fold tool output"),
    "the first rotating tip is visible on the second status row",
  );
  const frame = lastFrameText(output);
  const lines = frame.split("\n");
  const composerTop = lines.findIndex((line) => line.includes("MESSAGE"));
  assert.ok(composerTop >= 0, "the composer box is rendered");
  const composerBottom = lines.findIndex(
    (line, index) => index > composerTop && line.includes("╰"),
  );
  assert.ok(composerBottom > composerTop, "the composer box is closed");
  const composer = lines.slice(composerTop, composerBottom + 1).join("\n");
  assert.ok(composer.includes("Type a task"), "the composer placeholder is rendered");
  assert.ok(!composer.includes("MODE"), "the composer does not repeat the status bar's mode");
  assert.ok(!composer.includes("SENIOR"), "the composer does not repeat the status bar's models");
  const code = await quit(input, app);
  assert.equal(code, 0);
});

test("overlay frames paint their inner rows through the app theme", async () => {
  // Force a color theme deterministically: the host environment of the test
  // runner may set NO_COLOR (as this agent's shell does), and the app resolves
  // its theme from the environment at startup.
  const previousNoColor = process.env.NO_COLOR;
  const previousTerm = process.env.TERM;
  delete process.env.NO_COLOR;
  if (previousTerm === "dumb") delete process.env.TERM;
  try {
    const { app, input, output } = startApp();
    assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));
    const theme = resolveTheme({ mode: null });
    assert.equal(theme.color, true, "color is forced for this test");

    input.key("p", { ctrl: true });
    assert.ok(await waitFor(() => textOf(output).includes("COMMANDS")));
    const paletteFrame = output.data.split(ANSI.cursorHome).at(-1) ?? "";
    assert.ok(stripAnsi(paletteFrame).includes("Command palette"), "the palette list is intact");
    assert.ok(
      paletteFrame.includes(theme.tokens.strong),
      "the palette header is painted through the app theme",
    );
    assert.ok(paletteFrame.includes(theme.tokens.inverse), "the selected row is inverse-painted");
    input.key("escape");
    await waitFor(() => !textOf(output).slice(-2000).includes("COMMANDS"));

    input.key("?", { shift: true });
    assert.ok(await waitFor(() => textOf(output).includes("HELP")));
    const helpFrame = output.data.split(ANSI.cursorHome).at(-1) ?? "";
    assert.ok(stripAnsi(helpFrame).includes("[General]"), "the grouped help list is intact");
    assert.ok(
      helpFrame.includes(theme.tokens.accent),
      "help group headers are painted through the app theme",
    );
    const code = await quit(input, app);
    assert.equal(code, 0);
  } finally {
    if (previousNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = previousNoColor;
    if (previousTerm === undefined) delete process.env.TERM;
    else process.env.TERM = previousTerm;
  }
});

test("tool stream events carry additive callId/args/result and stay NDJSON-compatible", () => {
  const event: ToolCallStreamEvent = {
    type: "tool_call",
    role: "junior",
    tool: "echo",
    at: "2026-11-04T00:00:00Z",
    callId: "call-1",
    args: '{"text":"hi"}',
  };
  const line = toNdjsonLine(event);
  assert.ok(!line.includes("\n"), "one line, no raw newline");
  const parsed = JSON.parse(line) as Record<string, unknown>;
  assert.equal(parsed.callId, "call-1");
  assert.equal(parsed.args, '{"text":"hi"}');
  // a consumer that ignores the additive fields still sees the core shape
  assert.equal(parsed.type, "tool_call");
  assert.equal(parsed.role, "junior");
  assert.equal(parsed.tool, "echo");
});

test("Enter mid-run keeps the whole draft and shows a refuse notice", async () => {
  const { app, input, output } = startApp();
  assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));
  input.type("say hello");
  input.enter();

  // The mock turn advances on microtasks queued behind these already-emitted
  // keypresses, so the turn is still running when the draft's Enter lands.
  input.type("queued draft stays");
  input.enter();
  assert.ok(
    await waitFor(() => textOf(output).includes("a turn is still running — your draft is kept")),
    "a refuse notice is shown",
  );
  // the draft itself is still in the composer line of the latest frame
  const frames = output.data.split(ANSI.cursorHome);
  const lastFrame = stripAnsi(frames.at(-1) ?? "");
  assert.ok(lastFrame.includes("queued draft stays"), "draft preserved in the composer");

  // the turn still completes; the refused draft was never submitted
  assert.ok(await waitFor(() => textOf(output).includes("decision:"), 30_000));
  assert.ok(!textOf(output).includes("YOU queued draft stays"), "draft must not be sent");

  const code = await quit(input, app);
  assert.equal(code, 0);
});

test("/models senior <name> refuses when a TWO_BROTHERS_* env var pins the model", async () => {
  const previous = process.env.TWO_BROTHERS_SENIOR_MODEL;
  process.env.TWO_BROTHERS_SENIOR_MODEL = "env-pinned-model";
  try {
    const { app, input, output } = startApp();
    assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));
    input.type("/models senior some-other-model");
    input.enter();
    await waitFor(() =>
      textOf(output).includes("pinned by a TWO_BROTHERS_* env var"),
    );
    assert.match(
      textOf(output),
      /senior model is pinned by a TWO_BROTHERS_\* env var/,
    );
    const code = await quit(input, app);
    assert.equal(code, 0);
  } finally {
    if (previous === undefined) delete process.env.TWO_BROTHERS_SENIOR_MODEL;
    else process.env.TWO_BROTHERS_SENIOR_MODEL = previous;
  }
});

test("/models senior <name> applies the model when nothing pins it", async () => {
  const { app, input, output } = startApp();
  assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));
  input.type("/models senior my-picked-model");
  input.enter();
  await waitFor(() => textOf(output).includes("senior model set to my-picked-model"));
  const code = await quit(input, app);
  assert.equal(code, 0);
});

test("each accepted turn advances the registry-derived status tip", async () => {
  const { app, input, output } = startApp();
  assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));
  assert.ok(
    textOf(output).includes("ready — type a task and press Enter · Ctrl+T fold tool output"),
    "turn zero shows the first tip",
  );

  input.type("say one");
  input.enter();
  // Wait for the completed turn, not just the streamed decision: the tip
  // advances when the turn is accepted, but the next submission needs idle.
  assert.ok(
    await waitFor(() => /ready — \d+\/\d+ tokens/.test(lastFrameText(output)), 30_000),
    "the first turn completed",
  );
  assert.ok(
    lastFrameText(output).includes("Ctrl+F find in transcript"),
    "turn one advances to the find tip",
  );
  assert.ok(!lastFrameText(output).includes("fold tool output"), "no stale tip repeats");

  input.type("say two");
  input.enter();
  assert.ok(
    await waitFor(
      () =>
        /ready — \d+\/\d+ tokens/.test(lastFrameText(output)) &&
        lastFrameText(output).includes("Ctrl+P commands"),
      30_000,
    ),
    "turn two advances to the palette tip",
  );
  // No tool row is on screen, so the projection hint is the tip alone.
  assert.ok(!lastFrameText(output).includes("expand tool"));
  const code = await quit(input, app);
  assert.equal(code, 0);
});

test("a stopped turn shows a bounded transient hint, then the rotation returns", async () => {
  const { app, input, output } = startApp();
  assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));
  input.type("say hello");
  input.enter();
  // The mock turn advances on microtasks queued behind these keypresses, so the
  // abort lands while the turn is still running (the same seam the mid-run test
  // uses); the copy must explain the way out, never change the key handling.
  input.key("c", { ctrl: true });
  assert.ok(await waitFor(() => textOf(output).includes("turn cancelled")), "the turn is stopped");
  assert.ok(
    await waitFor(() => lastFrameText(output).includes(CANCELLED_TURN_HINT)),
    "the quit-path copy owns the hint slot once",
  );

  // The slot has a render budget, not a clock: explicit repaints exhaust it and
  // the rotating tip (one accepted turn ⇒ the find tip) returns.
  for (let index = 0; index < 8; index += 1) output.resize(80, 24);
  assert.ok(
    await waitFor(() => !lastFrameText(output).includes(CANCELLED_TURN_HINT)),
    "the transient hint expired",
  );
  assert.ok(
    lastFrameText(output).includes("Ctrl+F find in transcript"),
    "the rotation returned after the transient slot",
  );
  assert.equal(lastFrameText(output).split("\n").length, 24, "the frame geometry is unchanged");
  const code = await quit(input, app);
  assert.equal(code, 0);
});
