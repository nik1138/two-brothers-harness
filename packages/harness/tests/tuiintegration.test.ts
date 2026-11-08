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
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { resolveConfig } from "../src/config.ts";
import { MockProvider, type Provider } from "../src/provider.ts";
import { toNdjsonLine, type ToolCallStreamEvent } from "../src/runstream.ts";
import { CANCELLED_TURN_HINT, awaitTurnDrain, runTuiApp, type TuiIO } from "../src/tui/app.ts";
import {
  loadTuiKeyCommands,
  resolveTuiCommands,
  type TuiKeysSource,
} from "../src/tui/keyoverrides.ts";
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

test("Ctrl+N steers the running turn at the next boundary and never starts a task", async () => {
  // The gated senior provider holds its first call: the steer is queued while
  // that call is in flight, so it can only land at the NEXT node boundary.
  let held = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const mock = new MockProvider();
  const gatedSenior: Provider = {
    async chat(messages, responseKind, signal, options) {
      if (!held) {
        held = true;
        await gate;
      }
      return mock.chat(messages, responseKind, signal, options);
    },
  };

  const { app, input, output } = startApp({
    providerOverrides: { senior: gatedSenior, junior: mock },
  });
  assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));
  // A tall viewport keeps the whole short consultation in the final frame, so
  // the assertions below can count the steer envelope exactly.
  output.resize(140, 60);
  input.type("first task");
  input.enter();
  assert.ok(await waitFor(() => held), "the first senior call is held");

  // Typing while running fills the composer as usual; Ctrl+N queues that text
  // for the running turn (not a task), and only acceptance clears the draft.
  input.type("steer me now");
  input.key("n", { ctrl: true, raw: "\u000e" });
  assert.ok(
    await waitFor(() =>
      textOf(output).includes("Steer queued — applied at the turn's next step"),
    ),
    "the acceptance toast names the next step",
  );
  assert.ok(
    await waitFor(() => /1\s*pending/.test(textOf(output).replace(/[│\n]/g, " "))),
    "the acceptance toast reports the pending count",
  );
  assert.ok(
    !lastFrameText(output).includes("steer me now"),
    "the composer is cleared only after the steer is accepted",
  );
  assert.ok(!textOf(output).includes("YOU steer me now"), "steering never starts a task");
  assert.ok(
    !textOf(output).includes("[[OPERATOR STEER]] steer me now"),
    "the envelope appears only when the harness drains it",
  );

  release();
  assert.ok(
    await waitFor(() => textOf(output).includes("decision:"), 30_000),
    "the turn completed after the gate",
  );
  assert.ok(
    textOf(output).includes("[[OPERATOR STEER]] steer me now"),
    "the steer envelope landed at the next boundary",
  );
  const finalFrame = lastFrameText(output);
  assert.ok(finalFrame.includes("[[OPERATOR STEER]] steer me now"));
  assert.equal(
    finalFrame.match(/steer me now/g)?.length,
    1,
    "there is exactly one steer envelope and no second task",
  );
  assert.ok(!finalFrame.includes("YOU steer me now"), "steering never starts a task");
  assert.ok(!textOf(output).includes("queued steer"), "nothing was left unapplied");

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

test("awaitTurnDrain keeps terminal restore behind a 2500 ms turn (old 1500 ms cap)", async () => {
  let turnSettled = false;
  let restored = false;
  const turnDone = new Promise<void>((resolve) => {
    setTimeout(() => {
      turnSettled = true;
      resolve();
    }, 2_500);
  });
  const drained = awaitTurnDrain(turnDone).then(() => {
    restored = true;
  });

  // The old shutdown raced the turn against a fixed 1500 ms timer; by 1700 ms
  // that race had already restored the terminal.
  await new Promise((resolve) => setTimeout(resolve, 1_700));
  assert.equal(turnSettled, false, "the fake turn is still unwinding");
  assert.equal(restored, false, "terminal.restore() must wait for the turn");

  await drained;
  assert.equal(turnSettled, true);
  assert.equal(restored, true);
});

test("awaitTurnDrain still restores once the budget expires for a never-settling turn", async () => {
  let restored = false;
  const never = new Promise<void>(() => {});
  const started = Date.now();
  await awaitTurnDrain(never, 100).then(() => {
    restored = true;
  });
  const elapsed = Date.now() - started;

  assert.equal(restored, true, "the exit path must never hang");
  assert.ok(elapsed >= 80, `drain returned too early (${elapsed}ms)`);
  assert.ok(elapsed < 2_000, `drain did not honour the budget (${elapsed}ms)`);
});

test("awaitTurnDrain does not wait when there is no turn or the turn already failed", async () => {
  const started = Date.now();
  await awaitTurnDrain(null);
  assert.ok(Date.now() - started < 200, "the no-turn shutdown fast path stays fast");
  await assert.doesNotReject(awaitTurnDrain(Promise.reject(new Error("turn failed")), 100));
});

test("a discovered provider.md can never shadow the native /provider connect surface", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-tui-provider-shadow-"));
  const commandsRoot = path.join(root, "commands");
  fs.mkdirSync(commandsRoot, { recursive: true });
  fs.writeFileSync(
    path.join(commandsRoot, "provider.md"),
    "---\ndescription: Operator template that tries to replace the native surface\n---\n" +
      "SHADOWED-PROVIDER-TASK $ARGUMENTS\n",
    "utf8",
  );
  try {
    const { app, input, output } = startApp({
      commandsRoots: [commandsRoot],
      sessionsDir: path.join(root, "sessions"),
    });
    try {
      assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));

      // Typed `/provider`: the native registry command wins its own name and
      // opens the real connect form; the discovered template is never expanded
      // into a task.
      input.type("/provider");
      input.key("escape"); // dismiss the inline picker, keep the draft
      input.enter();
      assert.ok(
        await waitFor(() => lastFrameText(output).includes("PROVIDER SETTINGS")),
        "the native connect surface opened",
      );
      assert.ok(!textOf(output).includes("SHADOWED-PROVIDER-TASK"), "no template expansion");
      assert.ok(!textOf(output).includes("decision:"), "no turn started");
      input.key("escape");
      assert.ok(await waitFor(() => !lastFrameText(output).includes("PROVIDER SETTINGS")));

      // The Ctrl+P palette offers the native row (the shadowed template is
      // dropped from the catalog) and accepting it opens the same surface.
      input.key("p", { ctrl: true });
      assert.ok(await waitFor(() => textOf(output).includes("COMMANDS")));
      input.type("provider");
      assert.ok(await waitFor(() => lastFrameText(output).includes("provider")));
      input.enter();
      assert.ok(
        await waitFor(() => lastFrameText(output).includes("PROVIDER SETTINGS")),
        "the palette row dispatches the native surface",
      );
      assert.ok(!textOf(output).includes("SHADOWED-PROVIDER-TASK"), "still no template expansion");
      assert.ok(!textOf(output).includes("decision:"), "still no turn started");
    } finally {
      assert.equal(await quit(input, app), 0);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("injected key overrides: a rebound palette chord opens it and the default chord is dead", async () => {
  const resolved = resolveTuiCommands({ palette: [{ name: "g", ctrl: true }] });
  assert.deepEqual(resolved.diagnostics, []);
  const { app, input, output } = startApp({ commands: resolved.commands });
  assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));
  input.key("p", { ctrl: true });
  assert.equal(
    await waitFor(() => textOf(output).includes("COMMANDS"), 300),
    false,
    "Ctrl+P no longer opens the palette",
  );
  input.key("g", { ctrl: true });
  assert.ok(await waitFor(() => textOf(output).includes("COMMANDS")), "Ctrl+G opens the palette");
  assert.match(textOf(output), /Command palette/);
  input.key("escape");
  assert.ok(await waitFor(() => !lastFrameText(output).includes("COMMANDS")));
  assert.equal(await quit(input, app), 0);
});

test("injected key overrides: help moves chords and the overlay lists the effective ones", async () => {
  const resolved = resolveTuiCommands({
    help: [{ name: "f2" }],
    palette: [{ name: "g", ctrl: true }],
  });
  assert.deepEqual(resolved.diagnostics, []);
  const { app, input, output } = startApp({ commands: resolved.commands });
  assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));
  // "?" is no longer the help chord: it types into the composer instead.
  input.type("?");
  assert.equal(
    await waitFor(() => textOf(output).includes("HELP"), 300),
    false,
    "the default help chord no longer opens help",
  );
  input.key("f2");
  assert.ok(await waitFor(() => textOf(output).includes("HELP")), "F2 opens help");
  const text = textOf(output);
  assert.match(text, /F2/, "the help listing shows the effective help chord");
  assert.match(text, /Ctrl\+G/, "the help listing shows the effective palette chord");
  assert.doesNotMatch(text, /Ctrl\+P/, "the dead default chord is not advertised");
  input.key("escape");
  assert.equal(await quit(input, app), 0);
});

test("injected key overrides: a printable help chord opens help only on an empty composer", async () => {
  const resolved = resolveTuiCommands({ help: [{ name: "!" }] });
  assert.deepEqual(resolved.diagnostics, []);
  const { app, input, output } = startApp({ commands: resolved.commands });
  assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));

  // Empty composer: the printable rebound chord opens the help overlay.
  input.type("!");
  assert.ok(await waitFor(() => textOf(output).includes("HELP")), "! opens help when the draft is empty");
  assert.match(textOf(output), /!\s+Keyboard help/, "the help overlay lists the effective printable chord");
  input.key("escape");
  assert.ok(await waitFor(() => !lastFrameText(output).includes("HELP")));

  // Non-empty composer: the same keypress is typing, not the help chord.
  input.type("wow");
  assert.ok(await waitFor(() => textOf(output).includes("wow")));
  input.type("!");
  assert.ok(await waitFor(() => textOf(output).includes("wow!")), "! reaches the editor with text present");
  assert.equal(
    await waitFor(() => lastFrameText(output).includes("HELP"), 300),
    false,
    "a non-empty composer never opens help from the printable chord",
  );
  assert.equal(await quit(input, app), 0);
});

test("/keys show and /keys reload reflect and live-apply keys-file edits", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tui-keys-app-"));
  const keysFile = path.join(root, "keys.json");
  const source: TuiKeysSource = { path: keysFile, origin: "env" };
  fs.writeFileSync(
    keysFile,
    `${JSON.stringify({ version: 1, bindings: { palette: ["ctrl+g"] } }, null, 2)}\n`,
    "utf8",
  );
  const initial = loadTuiKeyCommands(source);
  assert.equal(initial.state, "loaded");
  const { app, input, output } = startApp({
    commands: initial.commands,
    keysSource: source,
    keysState: initial.state,
    keysDiagnostics: initial.diagnostics,
  });
  try {
    assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));

    // `/keys show` reports the captured source and the effective chords.
    input.type("/keys show");
    input.enter();
    assert.ok(await waitFor(() => textOf(output).includes("keys: palette Ctrl+G")));
    assert.ok(
      await waitFor(() => /keys file:[\s\S]{0,400}\(env\)[\s\S]{0,60}loaded/.test(textOf(output))),
      "the source is reported honestly",
    );
    assert.ok(
      await waitFor(() => textOf(output).includes("keys watch: off ")),
      "the watch state is reported honestly (off without --keys-watch)",
    );
    assert.ok(
      await waitFor(() => textOf(output).includes("help ? / F1")),
      "the untouched global chords are reported too",
    );

    // The startup override works and the default palette chord is dead.
    input.key("g", { ctrl: true });
    assert.ok(await waitFor(() => lastFrameText(output).includes("COMMANDS")));
    input.key("escape");
    assert.ok(await waitFor(() => !lastFrameText(output).includes("COMMANDS")));
    input.key("p", { ctrl: true });
    assert.equal(
      await waitFor(() => lastFrameText(output).includes("COMMANDS"), 300),
      false,
      "Ctrl+P is still dead before the reload",
    );

    // Edit the file externally, then reload: help moves from ?/F1 to F2.
    fs.writeFileSync(
      keysFile,
      `${JSON.stringify(
        { version: 1, bindings: { palette: ["ctrl+g"], help: ["f2"] } },
        null,
        2,
      )}\n`,
      "utf8",
    );
    input.type("/keys reload");
    input.enter();
    assert.ok(await waitFor(() => textOf(output).includes("keys reloaded:")), "success notice");
    assert.match(textOf(output), /help F2/);
    assert.match(textOf(output), /keys reloaded:[\s\S]{0,300}\(env\)/);

    // The new chord opens help; the previous default help chord is dead.
    input.key("f2");
    assert.ok(await waitFor(() => lastFrameText(output).includes("HELP")), "F2 opens help after reload");
    input.key("escape");
    assert.ok(await waitFor(() => !lastFrameText(output).includes("HELP")));
    input.key("f1");
    assert.equal(
      await waitFor(() => lastFrameText(output).includes("HELP"), 300),
      false,
      "the previous help chord is dead after reload",
    );

    // The palette listing uses the effective help chord too.
    input.key("g", { ctrl: true });
    assert.ok(await waitFor(() => lastFrameText(output).includes("COMMANDS")));
    assert.ok(await waitFor(() => lastFrameText(output).includes("F2")), "palette lists F2");
    input.key("escape");
    assert.ok(await waitFor(() => !lastFrameText(output).includes("COMMANDS")));

    // A corrupt file fails one bounded notice and keeps the last good table.
    fs.writeFileSync(keysFile, "{oops\n", "utf8");
    input.type("/keys reload");
    input.enter();
    assert.ok(await waitFor(() => textOf(output).includes("keys reload failed:")));
    assert.match(textOf(output), /keeping the current chords/);
    assert.equal(
      lastFrameText(output).split("keys reload failed:").length - 1,
      1,
      "exactly one diagnostic notice in the current frame",
    );
    input.key("f2");
    assert.ok(
      await waitFor(() => lastFrameText(output).includes("HELP")),
      "the last good table stays active after a failed reload",
    );
    input.key("escape");
    assert.ok(await waitFor(() => !lastFrameText(output).includes("HELP")));
    assert.equal(await quit(input, app), 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("--keys-watch: valid edits live-reload; invalid and absent changes keep the last good table", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tui-keys-watch-app-"));
  const keysFile = path.join(root, "keys.json");
  const source: TuiKeysSource = { path: keysFile, origin: "env" };
  fs.writeFileSync(
    keysFile,
    `${JSON.stringify({ version: 1, bindings: { palette: ["ctrl+g"] } }, null, 2)}\n`,
    "utf8",
  );
  const initial = loadTuiKeyCommands(source);
  assert.equal(initial.state, "loaded");
  const { app, input, output } = startApp({
    commands: initial.commands,
    keysSource: source,
    keysState: initial.state,
    keysDiagnostics: initial.diagnostics,
    keysWatch: true,
  });
  try {
    assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));

    // The startup override is active and /keys show reports the watcher state.
    input.key("g", { ctrl: true });
    assert.ok(await waitFor(() => lastFrameText(output).includes("COMMANDS")));
    input.key("escape");
    assert.ok(await waitFor(() => !lastFrameText(output).includes("COMMANDS")));
    input.type("/keys show");
    input.enter();
    assert.ok(await waitFor(() => textOf(output).includes("keys watch: on ")));
    assert.match(textOf(output), /keys watch: on \(valid file changes apply automatically/);

    // A valid external edit is applied automatically through the same validated
    // path as `/keys reload`, with exactly one bounded notice naming the chords.
    fs.writeFileSync(
      keysFile,
      `${JSON.stringify(
        { version: 1, bindings: { palette: ["ctrl+u"], help: ["f2"] } },
        null,
        2,
      )}\n`,
      "utf8",
    );
    assert.ok(await waitFor(() => textOf(output).includes("keys auto-reloaded:")), "the edit is noticed");
    assert.match(textOf(output), /keys auto-reloaded:[\s\S]{0,200}palette Ctrl\+U/);
    assert.match(textOf(output), /keys auto-reloaded:[\s\S]{0,200}help F2/);
    assert.match(textOf(output), /keys auto-reloaded:[\s\S]{0,300}\(env\)/);

    // The live table swapped: the new chord works and the old one is dead.
    input.key("u", { ctrl: true });
    assert.ok(await waitFor(() => lastFrameText(output).includes("COMMANDS")), "Ctrl+U opens the palette");
    assert.match(lastFrameText(output), /Ctrl\+U/, "the palette lists the effective palette chord");
    assert.match(lastFrameText(output), /F2/, "the palette lists the effective help chord");
    input.key("escape");
    assert.ok(await waitFor(() => !lastFrameText(output).includes("COMMANDS")));
    input.key("g", { ctrl: true });
    assert.equal(
      await waitFor(() => lastFrameText(output).includes("COMMANDS"), 300),
      false,
      "Ctrl+G is dead after the auto-reload",
    );
    input.key("f2");
    assert.ok(await waitFor(() => lastFrameText(output).includes("HELP")), "F2 opens help");
    assert.match(lastFrameText(output), /Ctrl\+U/, "the help overlay lists the effective palette chord");
    assert.doesNotMatch(lastFrameText(output), /Ctrl\+P/, "the dead default chord is not advertised");
    input.key("escape");
    assert.ok(await waitFor(() => !lastFrameText(output).includes("HELP")));

    // Status hints derive from the live table: two accepted turns rotate the
    // footer to the palette tip, which must advertise Ctrl+U, never Ctrl+P.
    input.type("first task");
    input.enter();
    assert.ok(await waitFor(() => textOf(output).includes("decision:"), 30_000));
    input.type("second task");
    input.enter();
    assert.ok(
      await waitFor(() => textOf(output).split("decision:").length - 1 >= 2, 30_000),
      "both mock turns completed",
    );
    assert.ok(
      await waitFor(() => lastFrameText(output).includes("Ctrl+U commands")),
      "the status hint uses the reloaded palette chord",
    );
    assert.doesNotMatch(lastFrameText(output), /Ctrl\+P commands/);

    // An invalid edit keeps the last good table with one bounded warning.
    fs.writeFileSync(keysFile, "{oops\n", "utf8");
    assert.ok(
      await waitFor(() => textOf(output).includes("keeping the current chords")),
      "the invalid edit is noticed",
    );
    assert.match(textOf(output), /keys watch:[\s\S]{0,400}keeping the current chords/);
    assert.equal(
      lastFrameText(output).split("keeping the current chords").length - 1,
      1,
      "exactly one bounded warning in the current frame",
    );
    input.key("u", { ctrl: true });
    assert.ok(
      await waitFor(() => lastFrameText(output).includes("COMMANDS")),
      "the last good table stays active after an invalid auto-reload",
    );
    input.key("escape");
    assert.ok(await waitFor(() => !lastFrameText(output).includes("COMMANDS")));

    // Absence is informational and also keeps the last good table.
    fs.unlinkSync(keysFile);
    assert.ok(
      await waitFor(() => textOf(output).includes("keys watch: no file at")),
      "absence is reported informationally",
    );
    input.key("f2");
    assert.ok(
      await waitFor(() => lastFrameText(output).includes("HELP")),
      "the last good table stays active after deletion",
    );
    input.key("escape");
    assert.ok(await waitFor(() => !lastFrameText(output).includes("HELP")));
    assert.equal(await quit(input, app), 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("/keys show reports an unwatchable embedded session honestly", async () => {
  // No keysSource/keysWatch: the embedding injected the table directly.
  const { app, input, output } = startApp();
  assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));
  input.type("/keys show");
  input.enter();
  assert.ok(
    await waitFor(() => textOf(output).includes("keys file: none (no keys-file source captured")),
  );
  assert.ok(
    await waitFor(() => textOf(output).includes("keys watch: unavailable ")),
    "no captured source means no possible watcher",
  );
  // The watcher is opt-in at startup only: there is no runtime toggle command.
  input.type("/keys watch on");
  input.enter();
  assert.ok(
    await waitFor(() => textOf(output).includes("usage: /keys [show|reload]")),
    "/keys watch is not a command; the flag/env are captured at startup",
  );
  assert.equal(await quit(input, app), 0);
});

test("/sessions picker: sidecar and derived titles with human ages, resume unchanged", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-tui-sessions-picker-"));
  const sessionsDir = path.join(root, "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });
  const metaName = "2026-11-08T11-58-46-279-aaaaaa.jsonl";
  const plainName = "2026-11-08T12-00-00-000-bbbbbb.jsonl";
  const userLine = (text: string): string =>
    JSON.stringify({
      v: 1,
      id: `id-${text.length}`,
      seq: 1,
      ts: "2026-11-08T11:58:46Z",
      from: "user",
      to: "senior",
      kind: "message",
      payload: { text },
    });
  fs.writeFileSync(path.join(sessionsDir, metaName), `${userLine("raw first message")}\n`, "utf8");
  fs.writeFileSync(
    path.join(sessionsDir, plainName),
    `${userLine("Derived title from the first message")}\n`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(sessionsDir, metaName.replace(/\.jsonl$/, ".meta.json")),
    JSON.stringify({ title: "Sidecar title for resume", created: 1, updated: 2 }, null, 2),
    "utf8",
  );
  const { app, input, output } = startApp({ sessionsDir });
  try {
    assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));

    input.type("/sessions");
    input.key("escape"); // dismiss the inline / picker, keep the draft
    input.enter();
    assert.ok(
      await waitFor(() => lastFrameText(output).includes("RESUME SESSION")),
      "the resume picker opened",
    );
    const frame = lastFrameText(output);
    assert.ok(frame.includes("Sidecar title for resume"), "the metadata sidecar title is the label");
    assert.ok(
      !frame.includes("raw first message"),
      "the sidecar title wins over the message-derived title",
    );
    assert.ok(
      !frame.includes(metaName.slice(0, -".jsonl".length)),
      "the raw .jsonl stem is not shown as a label",
    );
    assert.ok(
      frame.includes("Derived title from the first message"),
      "a metadata-less session falls back to the first operator message",
    );
    assert.ok(
      !frame.includes(plainName.slice(0, -".jsonl".length)),
      "the metadata-less raw stem is not shown either",
    );
    assert.match(frame, /— just now/, "the description is a short human age");
    assert.ok(
      frame.split("\n").every((row) => stripAnsi(row).length <= 80),
      "the title-bearing picker stays width-safe at 80 columns",
    );

    // Resume behavior is unchanged: accept the first session (alphabetical
    // file order), confirm, and land in the restored context.
    input.enter();
    assert.ok(
      await waitFor(() => lastFrameText(output).includes('Resume "Sidecar title for resume"?')),
      "the confirmation names the readable title",
    );
    input.enter();
    assert.ok(
      await waitFor(() => textOf(output).includes("resumed Sidecar title for resume")),
      "the session resumes and the success toast names the title",
    );
    assert.equal(await quit(input, app), 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
