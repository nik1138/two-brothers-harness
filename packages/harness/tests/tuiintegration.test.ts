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
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";

import { COMPACTION_SUMMARY_PREFIX } from "../src/compaction.ts";
import { resolveConfig } from "../src/config.ts";
import { RuntimeSettings } from "../src/runtime.ts";
import { SettingsStore } from "../src/settings_store.ts";
import { MockProvider, ProviderAbortError, type Provider, type Tool, type ToolChatOptions, type ToolChatResponse } from "../src/provider.ts";
import { toNdjsonLine, type ToolCallStreamEvent } from "../src/runstream.ts";
import { CANCELLED_TURN_HINT, awaitTurnDrain, runTuiApp, type TuiIO } from "../src/tui/app.ts";
import {
  SUBAGENT_CHILD_TOOL_NAMES,
  SUBAGENT_TOOL_NAME,
  SubagentStore,
} from "../src/subagent.ts";
import {
  HELPERS_MEMORY_COPY,
} from "../src/tui/view/helpers.ts";
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

// startApp's default sessionsDir names a deliberately nonexistent directory;
// the app's store writer lock (src/sessionlayout.ts) creates it on acquire
// and only the lock file is removed on release. Snapshot its absence at load
// and remove the artifact once every test in this file has run — never touch
// a directory that pre-existed.
const defaultSessionsDir = path.join(process.cwd(), "does-not-exist-tui-sessions");
const defaultSessionsDirPreExisting = fs.existsSync(defaultSessionsDir);
after(() => {
  if (!defaultSessionsDirPreExisting) {
    fs.rmSync(defaultSessionsDir, { recursive: true, force: true });
  }
});

/** A MockProvider that records the exact belt each tool-loop call offered. */
class RecordingMock extends MockProvider {
  seenToolNames: string[][] = [];

  override async chatWithTools(
    messages: Parameters<MockProvider["chatWithTools"]>[0],
    tools: Tool[],
    options: ToolChatOptions = {},
  ): Promise<ToolChatResponse> {
    this.seenToolNames.push(tools.map((tool) => tool.name));
    return super.chatWithTools(messages, tools, options);
  }
}

/** The newest fully rendered frame (rows joined with newlines). */
const lastFrameText = (output: FakeOutput): string =>
  stripAnsi(output.data.split(ANSI.cursorHome).at(-1) ?? "");

/** Non-empty JSONL lines of a session file ([] when the file is missing). */
function sessionLines(file: string): string[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter((line) => line.trim() !== "");
}

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
    await waitFor(() => textOf(output).includes("SETTINGS")),
    "settings dialog opens",
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

test("slash commands: /mode auto applies; the picker offers auto; bad modes warn", async () => {
  const { app, input, output } = startApp();
  assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));
  input.type("/mode auto");
  input.enter();
  assert.ok(await waitFor(() => textOf(output).includes("mode: auto")));
  // The status bar shows the REQUESTED mode; no fabricated route badge.
  assert.ok(textOf(output).includes("auto"));
  input.type("/mode solo");
  input.enter();
  assert.ok(
    await waitFor(() => textOf(output).includes("usage: /mode consult|work|auto")),
    "solo is not an operator mode (the enum stays consult|work|auto)",
  );
  // The chordless picker lists all three modes.
  input.type("/mode");
  input.enter();
  assert.ok(await waitFor(() => textOf(output).includes("COOPERATION MODE")));
  const pickerText = textOf(output);
  assert.ok(pickerText.includes("consult"));
  assert.ok(pickerText.includes("work"));
  assert.ok(pickerText.includes("auto"));
  input.key("escape");
  const code = await quit(input, app);
  assert.equal(code, 0);
});

test("Tab cycles the cooperation mode on an empty composer; a typed draft keeps slash completion", async () => {
  const { app, input, output } = startApp();
  assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));
  // consult → work → auto forward, Shift+Tab backwards, each applied to the
  // next turn only and reported through the same toast as /mode.
  input.key("tab");
  await waitFor(() => textOf(output).includes("mode: work"));
  input.key("tab");
  await waitFor(() => textOf(output).includes("mode: auto"));
  input.key("tab", { shift: true });
  await waitFor(() => textOf(output).includes("mode: work"));
  input.key("tab", { shift: true });
  await waitFor(() => textOf(output).includes("mode: consult"));
  // With text typed, Tab keeps completing the slash name and never cycles.
  input.type("/them");
  input.key("tab");
  await waitFor(() => textOf(output).includes("/theme "));
  const lastFrame = stripAnsi(output.data.split(ANSI.cursorHome).at(-1) ?? "");
  assert.ok(
    lastFrame.includes("/theme "),
    "a non-empty composer keeps Tab on slash completion (/them → /theme)",
  );
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

test("Ctrl+X copies the newest reply through the injected writer; the title tracks the run", async () => {
  const copied: string[] = [];
  const titles: string[] = [];
  const notifications: Array<{ title: string; body?: string }> = [];
  const { app, input, output } = startApp({
    clipboard: async (text) => {
      copied.push(text);
      return { ok: true, method: "osc52", chars: text.length };
    },
    attention: {
      setTitle: (title) => titles.push(title),
      notify: (event) => notifications.push(event),
    },
  });
  assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));
  assert.equal(titles[0], "Two Brothers", "session start sets the idle title");

  // Nothing committed yet: the honest empty state, and no writer call.
  input.key("x", { ctrl: true, raw: "\u0018" });
  assert.ok(await waitFor(() => textOf(output).includes("nothing to copy yet")));
  assert.equal(copied.length, 0);

  input.type("copy this");
  input.enter();
  assert.ok(
    await waitFor(() => titles.includes("Two Brothers · working")),
    "a run start sets the working title",
  );
  assert.ok(await waitFor(() => textOf(output).includes("decision:"), 30_000));
  assert.ok(
    await waitFor(() => titles.includes("Two Brothers · done")),
    "completion sets the done title",
  );
  assert.ok(
    titles.indexOf("Two Brothers · working") < titles.indexOf("Two Brothers · done"),
    "the title transitions in run order",
  );

  input.key("x", { ctrl: true, raw: "\u0018" });
  assert.ok(await waitFor(() => textOf(output).includes("copied last reply (")));
  assert.equal(copied.length, 1, "exactly one copy");
  assert.match(copied[0] ?? "", /Final decision on «copy this»/);
  assert.match(
    textOf(output),
    /copied last reply \(\d+ chars\) via OSC 52/,
    "the toast reports the real method",
  );
  assert.equal(notifications.length, 0, "completion is title-only, never a notification");

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
  const resolved = resolveTuiCommands({ palette: [{ name: "l", ctrl: true }] });
  assert.deepEqual(resolved.diagnostics, []);
  const { app, input, output } = startApp({ commands: resolved.commands });
  assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));
  input.key("p", { ctrl: true });
  assert.equal(
    await waitFor(() => textOf(output).includes("COMMANDS"), 300),
    false,
    "Ctrl+P no longer opens the palette",
  );
  input.key("l", { ctrl: true });
  assert.ok(await waitFor(() => textOf(output).includes("COMMANDS")), "Ctrl+L opens the palette");
  assert.match(textOf(output), /Command palette/);
  input.key("escape");
  assert.ok(await waitFor(() => !lastFrameText(output).includes("COMMANDS")));
  assert.equal(await quit(input, app), 0);
});

test("injected key overrides: help moves chords and the overlay lists the effective ones", async () => {
  const resolved = resolveTuiCommands({
    help: [{ name: "f2" }],
    palette: [{ name: "l", ctrl: true }],
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
    `${JSON.stringify({ version: 1, bindings: { palette: ["ctrl+l"] } }, null, 2)}\n`,
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
    assert.ok(await waitFor(() => textOf(output).includes("keys: palette Ctrl+L")));
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
    input.key("l", { ctrl: true });
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
        { version: 1, bindings: { palette: ["ctrl+l"], help: ["f2"] } },
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
    input.key("l", { ctrl: true });
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
    `${JSON.stringify({ version: 1, bindings: { palette: ["ctrl+l"] } }, null, 2)}\n`,
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
    input.key("l", { ctrl: true });
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
    input.key("l", { ctrl: true });
    assert.equal(
      await waitFor(() => lastFrameText(output).includes("COMMANDS"), 300),
      false,
      "Ctrl+L is dead after the auto-reload",
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
    await waitFor(() => textOf(output).includes("usage: /keys [show|reload|edit]")),
    "/keys watch is not a command; the flag/env are captured at startup",
  );
  // `/keys edit` refuses honestly when no keys file was captured: no dialog
  // opens and nothing is written (the embedding injected the table directly).
  input.type("/keys edit");
  input.enter();
  assert.ok(
    await waitFor(() =>
      textOf(output).includes("no keys-file source was captured for this TUI session"),
    ),
    "the editor names the missing source and the guidance",
  );
  assert.match(textOf(output), /--keys-file <path>|TWO_BROTHERS_TUI_KEYS_FILE/);
  assert.equal(
    lastFrameText(output).includes("KEY BINDINGS"),
    false,
    "the editor stays closed when no source is configured",
  );
  assert.equal(await quit(input, app), 0);
});

test("/keys edit captures a chord, refuses fixed/other-global conflicts, and saves the file", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tui-keys-editor-app-"));
  const keysFile = path.join(root, "keys.json");
  const source: TuiKeysSource = { path: keysFile, origin: "env" };
  // Start absent: the editor creates the captured path (the default-location
  // behavior) and the app boots on the registry defaults.
  const initial = loadTuiKeyCommands(source);
  assert.equal(initial.state, "missing");
  const { app, input, output } = startApp({
    commands: initial.commands,
    keysSource: source,
    keysState: initial.state,
    keysDiagnostics: initial.diagnostics,
  });
  try {
    assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));

    // Open the editor, pick the palette slot, capture Ctrl+L.
    input.type("/keys edit");
    input.enter();
    assert.ok(await waitFor(() => lastFrameText(output).includes("KEY BINDINGS")));
    const opened = lastFrameText(output);
    assert.match(opened, /file: \S+/);
    assert.match(opened, /state: missing — saving creates it/);
    assert.match(opened, /Command palette\s+Ctrl\+P/);
    input.enter(); // palette row -> capture
    assert.ok(await waitFor(() => lastFrameText(output).includes("press keys…")));
    assert.match(lastFrameText(output), /Esc cancels the capture/);
    input.key("l", { ctrl: true });
    assert.ok(
      await waitFor(() => lastFrameText(output).includes("palette is now Ctrl+L — saved to")),
    );
    assert.ok(fs.existsSync(keysFile), "the editor wrote the captured path");
    const saved = JSON.parse(fs.readFileSync(keysFile, "utf8")) as {
      version: number;
      bindings: Record<string, string[]>;
    };
    assert.deepEqual(saved, { version: 1, bindings: { palette: ["ctrl+l"] } });

    // The active table swapped in place: the new chord opens the palette and
    // the default one is dead without a reload.
    input.key("escape"); // close the editor
    assert.ok(await waitFor(() => !lastFrameText(output).includes("KEY BINDINGS")));
    input.key("l", { ctrl: true });
    assert.ok(await waitFor(() => lastFrameText(output).includes("COMMANDS")));
    input.key("escape");
    assert.ok(await waitFor(() => !lastFrameText(output).includes("COMMANDS")));
    input.key("p", { ctrl: true });
    assert.equal(
      await waitFor(() => lastFrameText(output).includes("COMMANDS"), 300),
      false,
      "the previous palette chord is dead right after the save",
    );

    // A fixed native key is refused and the file is unchanged (readable).
    const before = fs.readFileSync(keysFile, "utf8");
    input.type("/keys edit");
    input.enter();
    assert.ok(await waitFor(() => lastFrameText(output).includes("KEY BINDINGS")));
    input.enter(); // palette row -> capture
    input.key("f", { ctrl: true });
    assert.ok(
      await waitFor(
        () =>
          lastFrameText(output).includes("already bound") &&
          lastFrameText(output).includes('"find"'),
      ),
      "the conflict is named with the fixed command",
    );
    assert.ok(lastFrameText(output).includes("press keys…"), "capture stays active for another try");
    assert.equal(fs.readFileSync(keysFile, "utf8"), before, "nothing on disk changed");
    // A chord another global chord still holds is refused the same way.
    input.key("o", { ctrl: true });
    assert.ok(
      await waitFor(
        () => lastFrameText(output).includes("another global chord") && lastFrameText(output).includes('"stash"'),
      ),
      "the other global chord is named as rebindable",
    );
    // Escape cancels only the capture, then closes the dialog.
    input.key("escape");
    assert.ok(await waitFor(() => !lastFrameText(output).includes("press keys…")));
    assert.ok(lastFrameText(output).includes("KEY BINDINGS"), "capture cancel keeps the editor open");
    assert.match(lastFrameText(output), /capture cancelled/);
    input.key("escape");
    assert.ok(await waitFor(() => !lastFrameText(output).includes("KEY BINDINGS")));

    // The trailing reset row returns all three chords to their defaults and
    // writes the documented empty binding set.
    input.type("/keys edit");
    input.enter();
    assert.ok(await waitFor(() => lastFrameText(output).includes("KEY BINDINGS")));
    for (let step = 0; step < 3; step += 1) input.key("down");
    input.enter();
    assert.ok(
      await waitFor(() => lastFrameText(output).includes("reset to their defaults")),
      "the reset is confirmed in the dialog",
    );
    const reset = JSON.parse(fs.readFileSync(keysFile, "utf8")) as {
      version: number;
      bindings: Record<string, string[]>;
    };
    assert.deepEqual(reset, { version: 1, bindings: {} });
    input.key("escape");
    assert.ok(await waitFor(() => !lastFrameText(output).includes("KEY BINDINGS")));
    input.key("p", { ctrl: true });
    assert.ok(await waitFor(() => lastFrameText(output).includes("COMMANDS")));
    input.key("escape");
    assert.ok(await waitFor(() => !lastFrameText(output).includes("COMMANDS")));
    input.key("l", { ctrl: true });
    assert.equal(
      await waitFor(() => lastFrameText(output).includes("COMMANDS"), 300),
      false,
      "the reset chord is dead again",
    );

    // `/keys show` confirms the defaults are active again after the reset.
    input.type("/keys show");
    input.enter();
    assert.ok(await waitFor(() => textOf(output).includes("keys: palette Ctrl+P")));
    assert.match(textOf(output), /defaults active \(no overrides\)/);
    assert.equal(await quit(input, app), 0);
  } finally {
    // A failed assertion must never leave the app running: every assembled app
    // shares the default session-store writer lock, and the next start would
    // fail before its first frame.
    try {
      await quit(input, app);
    } catch {
      // the app already exited (or its fake streams are gone)
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("/keys edit refuses an invalid existing keys file until /keys reload sees it fixed", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-keys-invalid-"));
  const keysFile = path.join(root, "keys.json");
  const source: TuiKeysSource = { path: keysFile, origin: "flag" };
  // Notices wrap at the 80-column test terminal, so compare the words, not the
  // physical rows.
  const flat = (text: string): string => text.replace(/\s+/g, " ").trim();
  const brokenJson = "{oops\n";
  fs.writeFileSync(keysFile, brokenJson, "utf8");
  // The loader is the startup seam the CLI passes to the app (`keysState` /
  // `keysDiagnostics`): it reports the real `invalid` state the guard reads and
  // the diagnostic the refusal quotes.
  const initial = loadTuiKeyCommands(source);
  assert.equal(initial.state, "invalid");
  assert.match(initial.diagnostics.join("; "), /keys\.json: invalid JSON/);
  const { app, input, output } = startApp({
    commands: initial.commands,
    keysSource: source,
    keysState: initial.state,
    keysDiagnostics: initial.diagnostics,
  });
  try {
    assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));

    // The refusal lands before any dialog: the honest diagnostic, the
    // fix/remove + `/keys reload` guidance, and the file left byte-identical.
    input.type("/keys edit");
    input.enter();
    assert.ok(await waitFor(() => textOf(output).includes("keys: cannot edit")));
    assert.ok(
      flat(lastFrameText(output)).includes(
        flat(
          `keys: cannot edit — ${keysFile} is invalid (${keysFile}: invalid JSON); ` +
            "fix or remove it, then /keys reload",
        ),
      ),
      "the refusal names the file, the real diagnostic and the fix/remove guidance",
    );
    const refused = lastFrameText(output);
    assert.equal(refused.includes("KEY BINDINGS"), false, "no editor dialog opens");
    assert.equal(
      refused.includes("The three global chords can be changed here."),
      false,
      "no overlay opens at all",
    );
    assert.equal(refused.includes("press keys…"), false, "no chord capture starts");
    assert.equal(fs.readFileSync(keysFile, "utf8"), brokenJson, "the invalid file is untouched");

    // `/keys show` agrees with the refusal instead of claiming a usable file.
    input.type("/keys show");
    input.enter();
    assert.ok(
      await waitFor(() =>
        flat(lastFrameText(output)).includes(
          `keys file: ${keysFile} (flag) — invalid; defaults active`,
        ),
      ),
      "the status reports the invalid file honestly",
    );

    // A reload of a still-broken file (now failing registry validation, not
    // JSON parsing) keeps the refusal and the bytes.
    const unknownId = `${JSON.stringify({ version: 1, bindings: { nope: ["ctrl+l"] } })}\n`;
    fs.writeFileSync(keysFile, unknownId, "utf8");
    input.type("/keys reload");
    input.enter();
    assert.ok(
      await waitFor(() =>
        flat(lastFrameText(output)).includes(
          `keys reload failed: ${keysFile}: "nope": unknown TUI command id — keeping the current chords`,
        ),
      ),
      "the failed reload names the validation error",
    );
    input.type("/keys edit");
    input.enter();
    assert.ok(
      await waitFor(() =>
        flat(lastFrameText(output)).includes(
          flat(
            `keys: cannot edit — ${keysFile} is invalid ` +
              `(${keysFile}: "nope": unknown TUI command id); ` +
              "fix or remove it, then /keys reload",
          ),
        ),
      ),
      "the reloaded invalid state re-arms the refusal",
    );
    assert.equal(lastFrameText(output).includes("KEY BINDINGS"), false);
    assert.equal(fs.readFileSync(keysFile, "utf8"), unknownId, "the rejected file is untouched");

    // Fixing the file and reloading re-enables the editor.
    const fixed = `${JSON.stringify({ version: 1, bindings: { palette: ["ctrl+l"] } }, null, 2)}\n`;
    fs.writeFileSync(keysFile, fixed, "utf8");
    input.type("/keys reload");
    input.enter();
    assert.ok(
      await waitFor(() => flat(lastFrameText(output)).includes("keys reloaded: palette Ctrl+L")),
      "the fixed file loads and swaps the active table",
    );
    input.type("/keys edit");
    input.enter();
    assert.ok(await waitFor(() => lastFrameText(output).includes("KEY BINDINGS")));
    const opened = flat(lastFrameText(output));
    assert.ok(opened.includes("state: loaded"), "the dialog reports the loaded state");
    assert.ok(opened.includes("Command palette Ctrl+L"), "the dialog shows the reloaded chord");
    input.key("escape");
    assert.ok(await waitFor(() => !lastFrameText(output).includes("KEY BINDINGS")));

    // Breaking the file again and reloading re-arms the guard, so the refusal
    // tracks the live load state, not just the startup one.
    const wrongVersion = `${JSON.stringify({ version: 2, bindings: {} })}\n`;
    fs.writeFileSync(keysFile, wrongVersion, "utf8");
    input.type("/keys reload");
    input.enter();
    assert.ok(
      await waitFor(() =>
        flat(lastFrameText(output)).includes(
          `keys reload failed: ${keysFile}: unsupported version (expected 1) — keeping the current chords`,
        ),
      ),
    );
    input.type("/keys edit");
    input.enter();
    assert.ok(
      await waitFor(() =>
        flat(lastFrameText(output)).includes(
          flat(
            `keys: cannot edit — ${keysFile} is invalid ` +
              `(${keysFile}: unsupported version (expected 1)); fix or remove it, then /keys reload`,
          ),
        ),
      ),
      "the live reload state re-arms the refusal",
    );
    assert.equal(lastFrameText(output).includes("KEY BINDINGS"), false);
    assert.equal(fs.readFileSync(keysFile, "utf8"), wrongVersion, "the rejected file is untouched");
    assert.equal(await quit(input, app), 0);
  } finally {
    // A failed assertion must never leave the app running: every assembled app
    // shares the default session-store writer lock, and the next start would
    // fail before its first frame.
    try {
      await quit(input, app);
    } catch {
      // the app already exited (or its fake streams are gone)
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
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

test("/sessions during /compact is refused: wait notice, no picker, no cross-session SUMMARY marker", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-tui-compact-resume-gate-"));
  const sessionsDir = path.join(root, "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });
  const line = (
    seq: number,
    id: string,
    from: "user" | "senior",
    to: string,
    text: string,
  ): string =>
    JSON.stringify({
      v: 1,
      id,
      seq,
      ts: "2026-11-14T09:00:00Z",
      from,
      to,
      kind: "message",
      payload: { text },
    });
  // alpha: enough envelopes for a real cut; beta: a clean second session.
  fs.writeFileSync(
    path.join(sessionsDir, "alpha.jsonl"),
    `${[
      line(1, "a1", "user", "senior", "alpha task"),
      line(2, "a2", "senior", "user", "alpha reply one"),
      line(3, "a3", "user", "senior", "alpha follow-up"),
      line(4, "a4", "senior", "user", "alpha reply two"),
      line(5, "a5", "user", "senior", "alpha last word"),
    ].join("\n")}\n`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(sessionsDir, "beta.jsonl"),
    `${line(1, "b1", "user", "senior", "beta standalone task")}\n`,
    "utf8",
  );

  // A loopback OpenAI-compatible endpoint that holds every chat completion
  // until the test releases it, so /compact stays pending for the whole
  // scenario (no model endpoint, no network beyond 127.0.0.1).
  const SUMMARY_TEXT = "ALPHA-UNIQUE-COMPACTION-SUMMARY";
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const server = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      void gate.then(() => {
        res.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
        res.end(JSON.stringify({ choices: [{ message: { content: SUMMARY_TEXT } }] }));
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  const { app, input, output } = startApp({
    sessionsDir,
    cfg: resolveConfig({
      provider: "openai",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: "test-key",
      seniorModel: "blocked-senior",
      juniorModel: "blocked-senior",
      sessionFile: path.join(sessionsDir, "alpha.jsonl"),
      resume: true,
      compactKeepRecent: 1,
      retries: 0,
    }),
  });
  try {
    assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));

    input.type("/compact");
    input.enter();
    assert.ok(
      await waitFor(() => lastFrameText(output).includes("compacting context…")),
      "compaction is pending on the held endpoint",
    );

    // Reach resume through the command palette: the typed-slash path is
    // already draft-refused while compaction runs, but the palette dispatch
    // (idleOnly keyed on `running` only) used to open the picker mid-compact,
    // letting the pending summary commit into the newly selected session.
    input.key("p", { ctrl: true });
    assert.ok(await waitFor(() => lastFrameText(output).includes("COMMANDS")));
    input.type("sessions");
    assert.ok(await waitFor(() => /Sessions/.test(lastFrameText(output))));
    input.enter();

    assert.ok(
      await waitFor(() =>
        textOf(output).includes("cannot resume a session while compaction is running"),
      ),
      "resume is refused with a clear wait notice",
    );
    assert.ok(
      !lastFrameText(output).includes("RESUME SESSION"),
      "the resume picker never opens during compaction",
    );

    // Let the held compaction finish: alpha's summary lands in alpha's own
    // transcript and on-disk session — behavior beyond the guard is unchanged.
    release();
    assert.ok(
      await waitFor(() => textOf(output).includes("context compacted"), 30_000),
      "compaction completes once the endpoint answers",
    );
    assert.ok(
      await waitFor(() => lastFrameText(output).includes(SUMMARY_TEXT), 5000),
      "the fresh summary marker belongs to alpha's transcript",
    );
    const alphaOnDisk = sessionLines(path.join(sessionsDir, "alpha.jsonl"));
    assert.ok(
      alphaOnDisk.some((line) => {
        try {
          const parsed = JSON.parse(line) as { payload?: { text?: unknown } };
          const text = String(parsed.payload?.text ?? "");
          return text.startsWith(COMPACTION_SUMMARY_PREFIX) && text.includes(SUMMARY_TEXT);
        } catch {
          return false;
        }
      }),
      "the on-disk rewrite still carries the summary envelope",
    );

    // After compaction the picker works again; resuming beta must not inherit
    // alpha's summary marker.
    input.type("/sessions");
    input.key("escape"); // dismiss the inline / picker, keep the draft
    input.enter();
    assert.ok(
      await waitFor(() => lastFrameText(output).includes("RESUME SESSION")),
      "the picker opens again once compaction has finished",
    );
    input.key("down"); // first item is alpha; move to beta
    input.enter();
    assert.ok(
      await waitFor(() => /Resume "beta/.test(lastFrameText(output))),
      "the confirmation names the beta session",
    );
    input.enter();
    assert.ok(
      await waitFor(() => textOf(output).includes("resumed beta standalone task")),
      "beta resumes after compaction",
    );
    // Wait out the resume toast so the transcript rows are visible again.
    assert.ok(
      await waitFor(
        () =>
          lastFrameText(output).includes("session beta.jsonl") &&
          !lastFrameText(output).includes("resumed beta"),
        5000,
      ),
      "the beta session settles without the resume toast",
    );
    assert.ok(
      !lastFrameText(output).includes(SUMMARY_TEXT),
      "the resumed session carries no cross-session SUMMARY marker",
    );

    const code = await quit(input, app);
    assert.equal(code, 0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Ctrl+G edits the draft in an external editor, restores the screen and cleans up", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-editor-script-"));
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tb-editor-tmp-"));
  const script = path.join(root, "fake-editor.mjs");
  fs.writeFileSync(
    script,
    [
      'import * as fs from "node:fs";',
      "const file = process.argv[2];",
      'const text = fs.readFileSync(file, "utf8");',
      'fs.writeFileSync(file, `edited: ${text.trim()}\\n`);',
      "",
    ].join("\n"),
  );
  const { app, input, output } = startApp({
    externalEditor: {
      // A real child process (Node itself) rewrites the temp file, so the whole
      // suspend -> spawn -> read-back -> resume path runs end to end.
      configured: `"${process.execPath}" "${script}"`,
      tmpdir: tempRoot,
    },
  });
  try {
    assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));
    input.type("draft words");
    assert.ok(
      await waitFor(() => lastFrameText(output).includes("draft words")),
      "the draft is in the composer before the editor opens",
    );
    const before = output.data.length;
    input.key("g", { ctrl: true, raw: "\u0007" });
    assert.ok(
      await waitFor(() => lastFrameText(output).includes("edited: draft words")),
      "the editor's saved text is read back into the composer",
    );
    const handoff = output.data.slice(before);
    assert.ok(handoff.includes(ANSI.altScreenOff), "the alternate screen is released");
    assert.ok(handoff.includes(ANSI.altScreenOn), "the alternate screen is restored");
    assert.ok(
      textOf(output).includes("external editor: draft updated"),
      "success is reported as a real update",
    );
    assert.ok(!textOf(output).includes("external editor: failed"), "no fabricated failure");
    assert.deepEqual(fs.readdirSync(tempRoot), [], "the temp edit directory is removed");
    assert.equal(await quit(input, app), 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("Ctrl+G refuses while a turn runs and while an overlay owns the keyboard", async () => {
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
  const spawns: string[] = [];
  const { app, input, output } = startApp({
    providerOverrides: { senior: gatedSenior, junior: mock },
    externalEditor: {
      configured: process.execPath,
      spawn: (file) => {
        spawns.push(file);
        const emitter = new EventEmitter();
        setImmediate(() => emitter.emit("close", 0, null));
        return emitter as never;
      },
    },
  });
  assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));
  input.type("first task");
  input.enter();
  assert.ok(await waitFor(() => held), "the first senior call is held");

  input.type("draft kept");
  input.key("g", { ctrl: true, raw: "\u0007" });
  assert.ok(
    await waitFor(() => textOf(output).includes("a turn is running")),
    "the refusal names the real reason",
  );
  assert.equal(spawns.length, 0, "no editor is launched while a turn runs");
  assert.ok(lastFrameText(output).includes("draft kept"), "the draft is untouched");

  release();
  assert.ok(await waitFor(() => textOf(output).includes("decision:"), 30_000));

  input.key("p", { ctrl: true });
  assert.ok(await waitFor(() => textOf(output).includes("Command palette")));
  input.key("g", { ctrl: true, raw: "\u0007" });
  assert.equal(spawns.length, 0, "an open overlay never hands the terminal away");
  input.key("escape");
  assert.equal(await quit(input, app), 0);
});

// --------------------------------------------------------------------------- //
// helper subagents (slice O1): observation parity over the assembled app
// --------------------------------------------------------------------------- //

/** A temp workspace + sessions directory for a helper-observing TUI turn. */
function helperRoot(): { root: string; sessionsDir: string; workspace: string; sessionFile: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-tui-helpers-"));
  const sessionsDir = path.join(root, "sessions");
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, "notes.txt"), "hello from the notes file\n", "utf8");
  return {
    root,
    sessionsDir,
    workspace,
    sessionFile: path.join(sessionsDir, "parent.jsonl"),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test("a TUI turn delegates: the helper appears, its transcript opens, and the parent transcript never changes a byte", async () => {
  const { sessionsDir, workspace, sessionFile, cleanup } = helperRoot();
  const child = new RecordingMock([
    { tool: "workspace_read_file", args: { path: "notes.txt" } },
    { text: "The notes file says hello." },
  ]);
  const senior = new RecordingMock([
    { tool: SUBAGENT_TOOL_NAME, args: { task: "Inspect the notes file.", label: "notes helper" } },
  ]);
  const { app, input, output } = startApp({
    cfg: resolveConfig({ provider: "mock", sessionFile }),
    sessionsDir,
    workspaceRoot: workspace,
    providerOverrides: { senior, junior: new MockProvider() },
    subagentProviderFactory: () => child,
  });
  try {
    assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));
    output.resize(140, 60);
    input.type("inspect the notes");
    input.enter();
    assert.ok(
      await waitFor(() => /helpers 1 (running|done)/.test(textOf(output)), 30_000),
      "the status bar shows the live helper",
    );
    assert.ok(await waitFor(() => textOf(output).includes("decision:"), 30_000), "the turn completed");

    // The child is a leaf: its belt carries workspace tools only, never the
    // spawn/control tools or the plan tool (depth stays 1).
    const belt = child.seenToolNames.at(-1) ?? [];
    assert.ok(belt.includes("workspace_read_file"), "the child got the workspace read");
    for (const name of SUBAGENT_CHILD_TOOL_NAMES) assert.ok(belt.includes(name) || name === "spill_read");
    for (const control of [SUBAGENT_TOOL_NAME, "list_agents", "send_message", "interrupt_agent", "subagent_report"]) {
      assert.equal(belt.includes(control), false, `a child belt never carries ${control}`);
    }
    assert.equal(belt.includes("todo_write"), false, "the plan tool is the brothers' belt only");

    // OBSERVATION PROOF: the parent transcript is a separate contract. Snapshot
    // it after the turn, then open/list/scroll/close the helper surfaces, and
    // compare bytes — viewing a child appends no envelope.
    const before = fs.readFileSync(sessionFile);
    assert.ok(before.length > 0, "the parent session file holds the turn's envelopes");
    const parentEnvelopes = before.toString("utf8").trim().split(/\r?\n/);
    assert.ok(parentEnvelopes.length >= 5, "the cooperation cycle was persisted");
    const childLogs = fs.readdirSync(path.join(sessionsDir, "subagents"));
    assert.equal(childLogs.length, 1, "the child log is durable, separate state");
    input.key("y", { ctrl: true, raw: "\u0019" });
    assert.ok(await waitFor(() => lastFrameText(output).includes("HELPERS · 1 total")), "Ctrl+Y opens the list");
    assert.match(lastFrameText(output), /notes helper/);
    assert.match(lastFrameText(output), /completed/);
    input.enter();
    assert.ok(
      await waitFor(() => lastFrameText(output).includes("HELPER · completed")),
      "Enter opens the child transcript",
    );
    const detail = lastFrameText(output);
    assert.match(detail, /Task · Inspect the notes file\./);
    assert.match(detail, /Tool · workspace_read_file · completed/);
    assert.match(detail, /notes file says hello/i);
    input.key("pageup", { raw: "\u001b[5~" });
    input.key("escape");
    assert.ok(await waitFor(() => !lastFrameText(output).includes("HELPER · completed")), "Esc returns to the list");
    assert.ok(lastFrameText(output).includes("HELPERS · 1 total"), "the list is back");
    input.key("escape");
    assert.ok(
      await waitFor(() => !lastFrameText(output).includes("HELPERS · 1 total")),
      "Esc closes the overlay (the side panel's own HELPERS row stays)",
    );
    const after = fs.readFileSync(sessionFile);
    assert.deepEqual(after, before, "the parent transcript is byte-identical after observing the helper");

    // The child report never entered the brothers' transcript (it arrived only
    // as the Senior's `subagent` tool result, which is not an envelope).
    assert.equal(before.toString("utf8").includes("The notes file says hello."), false);

    // No new timer/handle leaks: the app exits exactly as before.
    assert.equal(await quit(input, app), 0);
  } finally {
    cleanup();
  }
});

test("a settled helper rolls up into the status bar and side panel without touching the brothers' numbers", async () => {
  const { sessionsDir, workspace, sessionFile, cleanup } = helperRoot();
  // Two provider calls (one tool step + the report) at the mock's deterministic
  // 10-in/5-out per call: 20 input + 10 output = 30 settled tokens.
  const child = new RecordingMock([
    { tool: "workspace_read_file", args: { path: "notes.txt" } },
    { text: "The notes file says hello." },
  ]);
  const senior = new RecordingMock([
    { tool: SUBAGENT_TOOL_NAME, args: { task: "Inspect the notes file.", label: "notes helper" } },
  ]);
  const { app, input, output } = startApp({
    cfg: resolveConfig({ provider: "mock", sessionFile }),
    sessionsDir,
    workspaceRoot: workspace,
    providerOverrides: { senior, junior: new MockProvider() },
    subagentProviderFactory: () => child,
  });
  try {
    assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));
    // Wide enough that the responsive status bar keeps the helpers aggregate
    // after the brothers' metrics (it is designed to drop first when the row
    // is crowded) and the side panel has room for its roll-up rows.
    output.resize(220, 60);
    input.type("inspect the notes");
    input.enter();
    assert.ok(await waitFor(() => textOf(output).includes("decision:"), 30_000), "the turn completed");

    // Slice C: the helpers aggregate is a separate surface — its own status-bar
    // segment after `cost` and its own side-panel rows. The child model
    // ("junior" role literal) is unpriced, so the cost reads the honest
    // `unknown` instead of a made-up $0.
    assert.ok(
      await waitFor(() => /helpers 1 done · 30 tok · cost unknown/.test(lastFrameText(output)), 30_000),
      "the status bar carries the settled helpers aggregate",
    );
    const frame = lastFrameText(output);
    assert.match(frame, /HELPER TOK\s+30 tok/);
    assert.match(frame, /HELPER COST\s+cost unknown/);
    // The brothers' own rows keep their own numbers (no helper merge).
    assert.match(frame, /TOKENS\s+in /);
    assert.doesNotMatch(frame, /TOKENS\s+in 30/);

    // The aggregate reads from the refreshed store rows: the child log has no
    // provider_kind (providerFactory injection) and settles as completed.
    const childId = fs.readdirSync(path.join(sessionsDir, "subagents"))[0]!.replace(/\.jsonl$/, "");
    const store = new SubagentStore(path.join(sessionsDir, "subagents"));
    const detail = store.get(childId);
    assert.equal(detail?.status, "completed");
    assert.equal(detail?.usage?.input_tokens, 20);
    assert.equal(detail?.provider_kind, undefined);

    assert.equal(await quit(input, app), 0);
  } finally {
    cleanup();
  }
});

test("a helper write parks a child-tagged approval and the panel names the helper", async () => {
  const { sessionsDir, workspace, sessionFile, cleanup } = helperRoot();
  const child = new RecordingMock([
    { tool: "workspace_write_file", args: { path: "out.txt", content: "done" } },
    { text: "Wrote the file." },
  ]);
  const senior = new RecordingMock([
    { tool: SUBAGENT_TOOL_NAME, args: { task: "Write out.txt.", label: "writer helper" } },
  ]);
  const { app, input, output } = startApp({
    cfg: resolveConfig({ provider: "mock", sessionFile }),
    sessionsDir,
    workspaceRoot: workspace,
    providerOverrides: { senior, junior: new MockProvider() },
    subagentProviderFactory: () => child,
  });
  try {
    assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));
    output.resize(140, 60);
    input.type("write the file");
    input.enter();
    assert.ok(
      await waitFor(() => lastFrameText(output).includes("APPROVAL REQUIRED"), 30_000),
      "the child's write parked on the parent broker",
    );
    assert.match(lastFrameText(output), /helper: writer helper/, "the panel names who asked");
    assert.ok(
      lastFrameText(output).includes("Allow once") && lastFrameText(output).includes("Deny"),
      "the decision keys are unchanged",
    );
    input.key("n");
    assert.ok(
      await waitFor(() => !lastFrameText(output).includes("APPROVAL REQUIRED"), 30_000),
      "the deny answered the request",
    );
    assert.ok(await waitFor(() => textOf(output).includes("decision:"), 30_000), "the turn completed");
    assert.equal(await quit(input, app), 0);
  } finally {
    cleanup();
  }
});

test("Ctrl+Y is an honest empty state in memory; a seeded child log lists in a file-backed session", async () => {
  // 1) In-memory session: only live helpers exist and the note says so.
  const memory = startApp();
  assert.ok(await waitFor(() => textOf(memory.output).includes("Two Brothers")));
  memory.input.key("y", { ctrl: true, raw: "\u0019" });
  assert.ok(
    await waitFor(() => lastFrameText(memory.output).includes("HELPERS · 0 total")),
    "Ctrl+Y opens even with no helpers",
  );
  assert.ok(lastFrameText(memory.output).includes(HELPERS_MEMORY_COPY));
  memory.input.key("y", { ctrl: true, raw: "\u0019" });
  assert.ok(
    await waitFor(() => !lastFrameText(memory.output).includes("HELPERS ·")),
    "Ctrl+Y toggles the overlay closed",
  );
  assert.equal(await quit(memory.input, memory.app), 0);

  // 2) File-backed session: a child log the previous run wrote is listed.
  const { sessionsDir, sessionFile, cleanup } = helperRoot();
  try {
    const store = new SubagentStore(path.join(sessionsDir, "subagents"));
    const id = "sub-0123456789abcdef";
    store.begin({
      id,
      parent_session: path.basename(sessionFile),
      label: "seeded helper",
      role: "junior",
      model: "child-model",
      task: "A seeded child log.",
      started_at: 1_000,
    });
    store.finish(id, { status: "completed", ended_at: 2_000, result: "done" });
    const { app, input, output } = startApp({
      cfg: resolveConfig({ provider: "mock", sessionFile }),
      sessionsDir,
    });
    try {
      assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));
      input.key("y", { ctrl: true, raw: "\u0019" });
      assert.ok(
        await waitFor(() => lastFrameText(output).includes("HELPERS · 1 total")),
        "the store-backed helper is listed",
      );
      assert.match(lastFrameText(output), /seeded helper/);
      assert.equal(await quit(input, app), 0);
    } finally {
      // app already exited; rm below
    }
  } finally {
    cleanup();
  }
});

test("the configured helper route reaches the TUI turn harness (R15)", async () => {
  const { sessionsDir, workspace, sessionFile, cleanup } = helperRoot();
  try {
    // Persist the operator's dedicated helper route through the same store the
    // provider layer reads; provider "mock" keeps the whole check hermetic.
    const store = new SettingsStore(path.join(sessionsDir, "settings.json"));
    new RuntimeSettings(store).updateSubagent({
      provider: "mock",
      model: "helper-route-model",
      base_url: "",
      api_key: "",
      provider_ref: "",
    });
    const senior = new RecordingMock([
      { tool: SUBAGENT_TOOL_NAME, args: { task: "Inspect the notes file.", label: "routed helper" } },
    ]);
    // No subagentProviderFactory: the child provider must be built from the
    // resolved route, exactly like a serve child.
    const { app, input, output } = startApp({
      cfg: resolveConfig({ provider: "mock", sessionFile }),
      sessionsDir,
      workspaceRoot: workspace,
      providerOverrides: { senior, junior: new MockProvider() },
    });
    assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));
    output.resize(140, 60);
    input.type("inspect the notes");
    input.enter();
    assert.ok(await waitFor(() => textOf(output).includes("decision:"), 30_000), "the turn completed");
    input.key("y", { ctrl: true, raw: "\u0019" });
    assert.ok(await waitFor(() => lastFrameText(output).includes("HELPERS · 1 total")));
    assert.match(lastFrameText(output), /routed helper/);
    input.enter();
    assert.ok(await waitFor(() => lastFrameText(output).includes("HELPER · completed")));
    assert.match(
      lastFrameText(output),
      /helper-route-model · junior/,
      "the child ran on the operator's configured helper route model",
    );
    input.key("escape");
    input.key("escape");
    assert.equal(await quit(input, app), 0);
  } finally {
    cleanup();
  }
});

// --------------------------------------------------------------------------- //
// O2: operator controls over the assembled app (fake TTY, hermetic children)
// --------------------------------------------------------------------------- //

/** A child provider whose first tool-loop step reads a file and whose second
 * step waits on a test-controlled gate — so the operator can queue a follow-up
 * and watch it delivered only at the child's next step. */
class GatedChildProvider implements Provider {
  calls: unknown[][] = [];
  private release: () => void = () => {};
  readonly gate: Promise<void> = new Promise((resolve) => {
    this.release = resolve;
  });
  openGate(): void {
    this.release();
  }

  async chat(): Promise<string> {
    return "done";
  }

  async chatWithTools(
    messages: unknown[],
    _tools: Tool[],
    _options: ToolChatOptions = {},
  ): Promise<ToolChatResponse> {
    this.calls.push(messages);
    if (this.calls.length === 1) {
      // Hang on the FIRST step: the operator queues the follow-up while the
      // child is live, then the gate releases the step; delivery happens at
      // the child's next provider step (step 1, after the tool result).
      await this.gate;
      return {
        content: "",
        toolCalls: [{ id: "call-1", name: "workspace_read_file", args: { path: "notes.txt" } }],
      };
    }
    return { content: "Noted — follow-up received.", toolCalls: [] };
  }
}

/** A child provider that never answers its first tool-loop step, so the
 * operator can interrupt a genuinely live child. */
class HangingChildProvider implements Provider {
  async chat(): Promise<string> {
    return new Promise<string>(() => {});
  }

  async chatWithTools(
    _messages: unknown[],
    _tools: Tool[],
    options: ToolChatOptions = {},
  ): Promise<ToolChatResponse> {
    const signal = options.signal;
    return new Promise<ToolChatResponse>((_resolve, reject) => {
      if (signal?.aborted) {
        reject(new ProviderAbortError());
        return;
      }
      signal?.addEventListener("abort", () => reject(new ProviderAbortError()), { once: true });
    });
  }
}

test("O2: i on a live helper cancels only the child — the parent run completes and the parent transcript never changes a byte", async () => {
  const { sessionsDir, workspace, sessionFile, cleanup } = helperRoot();
  try {
    const senior = new RecordingMock([
      { tool: SUBAGENT_TOOL_NAME, args: { task: "Inspect the notes file.", label: "slow helper" } },
    ]);
    const { app, input, output } = startApp({
      cfg: resolveConfig({ provider: "mock", sessionFile }),
      sessionsDir,
      workspaceRoot: workspace,
      providerOverrides: { senior, junior: new MockProvider() },
      subagentProviderFactory: () => new HangingChildProvider(),
    });
    assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));
    output.resize(140, 60);
    input.type("inspect the notes");
    input.enter();
    assert.ok(
      await waitFor(() => /helpers 1 running/.test(textOf(output)), 30_000),
      "the live helper shows in the status bar",
    );

    // Open the helper and interrupt it while its provider hangs.
    input.key("y", { ctrl: true, raw: "" });
    assert.ok(
      await waitFor(() => lastFrameText(output).includes("HELPERS · 1 total")),
      "Ctrl+Y opens the list mid-turn",
    );
    input.enter();
    assert.ok(
      await waitFor(() => lastFrameText(output).includes("HELPER · running")),
      "Enter opens the live child's transcript",
    );
    const beforeInterrupt = fs.readFileSync(sessionFile);
    input.key("i", { raw: "i" });
    assert.ok(
      await waitFor(() =>
        textOf(output).includes("interrupting — the helper's terminal event is the truth")
      ),
      "the interrupt toast names the request, not an outcome",
    );

    // The child settles cancelled; the parent run still completes.
    assert.ok(
      await waitFor(() => textOf(output).includes("decision:"), 30_000),
      "the parent turn completes after the child was interrupted",
    );
    const childId = fs.readdirSync(path.join(sessionsDir, "subagents"))[0]!;
    const store = new SubagentStore(path.join(sessionsDir, "subagents"));
    const detail = store.get(childId.replace(/\.jsonl$/, ""));
    assert.ok(detail, "the child log exists");
    assert.equal(detail.status, "cancelled");
    assert.equal(detail.error, "interrupted by the operator");

    // Settled-phase controls: interrupt and follow-up both refuse honestly,
    // Esc still layers detail → list → closed, and the parent transcript is
    // byte-identical across every control interaction.
    const settled = fs.readFileSync(sessionFile);
    assert.ok(settled.length > beforeInterrupt.length, "the turn finished persisting its envelopes");
    input.key("i", { raw: "i" });
    assert.ok(
      await waitFor(() => textOf(output).includes("helper already finished")),
      "a settled child refuses the interrupt with the honest copy",
    );
    input.key("m", { raw: "m" });
    assert.ok(
      await waitFor(() => lastFrameText(output).includes("Enter send · Esc cancel")),
      "m opens the one-line draft on the settled child",
    );
    input.type("are you there");
    input.enter();
    assert.ok(
      await waitFor(() =>
        lastFrameText(output).includes("helper already finished") ||
        textOf(output).includes("helper already finished")
      ),
      "a settled child refuses the follow-up with the honest copy",
    );
    assert.deepEqual(
      fs.readFileSync(sessionFile),
      settled,
      "no control interaction appended a parent envelope",
    );
    input.key("escape");
    assert.ok(
      await waitFor(() => !lastFrameText(output).includes("message: are you there")),
      "Esc cancels only the draft / the settled refusal closed it",
    );
    assert.equal(await quit(input, app), 0);
  } finally {
    cleanup();
  }
});

test("O2: a follow-up is queued with 1 pending and delivered only at the child's next step; the parent transcript never changes a byte", async () => {
  const { sessionsDir, workspace, sessionFile, cleanup } = helperRoot();
  try {
    const child = new GatedChildProvider();
    const senior = new RecordingMock([
      { tool: SUBAGENT_TOOL_NAME, args: { task: "Inspect the notes file.", label: "gated helper" } },
    ]);
    const { app, input, output } = startApp({
      cfg: resolveConfig({ provider: "mock", sessionFile }),
      sessionsDir,
      workspaceRoot: workspace,
      providerOverrides: { senior, junior: new MockProvider() },
      subagentProviderFactory: () => child,
    });
    assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));
    output.resize(140, 60);
    input.type("inspect the notes");
    input.enter();
    assert.ok(
      await waitFor(() => /helpers 1 running/.test(textOf(output)), 30_000),
      "the live helper shows in the status bar",
    );

    // Wait until the child is inside its gated second step, then open it.
    assert.ok(
      await waitFor(() => child.calls.length >= 1, 30_000),
      "the child is inside its gated first step",
    );
    const childId = fs.readdirSync(path.join(sessionsDir, "subagents"))[0]!.replace(/\.jsonl$/, "");
    const store = new SubagentStore(path.join(sessionsDir, "subagents"));
    const rowsBefore = store.get(childId)!.transcript.length;

    input.key("y", { ctrl: true, raw: "" });
    assert.ok(await waitFor(() => lastFrameText(output).includes("HELPERS · 1 total")));
    input.enter();
    assert.ok(
      await waitFor(() => lastFrameText(output).includes("HELPER · running")),
      "Enter opens the live child's transcript",
    );
    const before = fs.readFileSync(sessionFile);

    // Draft a follow-up and submit it: accepted means queued, never delivered.
    input.key("m", { raw: "m" });
    assert.ok(
      await waitFor(() => lastFrameText(output).includes("Enter send · Esc cancel")),
      "m opens the one-line draft",
    );
    input.type("also check the config");
    input.enter();
    assert.ok(
      await waitFor(() => textOf(output).includes("queued · 1 pending")),
      "the send toast reports the queue honestly",
    );
    assert.ok(
      lastFrameText(output).includes("1 pending"),
      "the detail header carries the live pending badge",
    );
    assert.equal(
      store.get(childId)!.transcript.length,
      rowsBefore,
      "no delivered row exists before the child's next step consumes the queue",
    );
    assert.deepEqual(fs.readFileSync(sessionFile), before, "queuing wrote no parent envelope");

    // The child's next step delivers the queue; only now does the row exist.
    child.openGate();
    assert.ok(
      await waitFor(() => textOf(output).includes("decision:"), 30_000),
      "the parent turn completes after the child consumed the follow-up",
    );
    const delivered = store.get(childId)!.transcript.slice(rowsBefore);
    assert.ok(
      delivered.some(
        (entry) =>
          entry.type === "message" &&
          entry.role === "user" &&
          entry.origin === "operator" &&
          entry.text === "also check the config",
      ),
      "the delivered follow-up row appears in the child log with its operator origin",
    );
    // The child's next step actually saw the follow-up as a user turn.
    const secondCall = child.calls[1] as { role: string; content: string }[];
    assert.ok(
      secondCall.some(
        (message) => message.role === "user" && String(message.content).includes("also check the config"),
      ),
      "the child's gated step received the delivered follow-up",
    );

    // CONTROL-SURFACE INVARIANCE: the detail is still open (now settled);
    // drafting again and cancelling with Esc changes no parent byte.
    const settled = fs.readFileSync(sessionFile);
    assert.ok(
      await waitFor(() => lastFrameText(output).includes("HELPER · completed")),
      "the open detail settles to completed through the terminal event",
    );
    input.key("m", { raw: "m" });
    input.type("too late");
    input.key("escape");
    assert.ok(
      await waitFor(() => !lastFrameText(output).includes("message: too late")),
      "Esc cancels only the draft",
    );
    assert.ok(lastFrameText(output).includes("HELPER ·"), "the detail stays open after Esc");
    assert.deepEqual(
      fs.readFileSync(sessionFile),
      settled,
      "the parent transcript is byte-identical across the control interactions",
    );
    assert.equal(await quit(input, app), 0);
  } finally {
    cleanup();
  }
});

test("two concurrent parent and child approvals stay answerable: the queue keeps both and promotes by approval_id", async () => {
  const { sessionsDir, workspace, sessionFile, cleanup } = helperRoot();
  try {
    // Work mode: the junior executes nothing; the SENIOR VERIFY loop then
    // spawns a BACKGROUND helper (its write parks a child-tagged request) and
    // immediately parks its own shell request — two approvals are live at
    // once, in either arrival order.
    const child = new RecordingMock([
      { tool: "workspace_write_file", args: { path: "child.txt", content: "from child" } },
      { text: "child done" },
    ]);
    const senior = new RecordingMock([
      {
        tool: SUBAGENT_TOOL_NAME,
        args: { task: "Write child.txt.", label: "writer helper", background: true },
      },
      { tool: "workspace_run_shell", args: { command: "echo from-parent" } },
      { text: "verify done" },
    ]);
    const { app, input, output } = startApp({
      cfg: resolveConfig({ provider: "mock", sessionFile }),
      sessionsDir,
      workspaceRoot: workspace,
      providerOverrides: { senior, junior: new MockProvider() },
      subagentProviderFactory: () => child,
    });
    assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));
    output.resize(140, 60);
    input.type("/mode work");
    input.enter();
    assert.ok(await waitFor(() => textOf(output).includes("mode: work")));
    input.type("verify the notes");
    input.enter();
    assert.ok(
      await waitFor(() => lastFrameText(output).includes("(2 pending)"), 30_000),
      "both requests are parked and the status bar reports the pending count",
    );
    const first = lastFrameText(output);
    const firstIsChild = first.includes("child.txt");
    const firstIsShell = first.includes("from-parent");
    assert.ok(
      firstIsChild !== firstIsShell,
      "the visible panel names exactly one of the two requests",
    );
    if (firstIsChild) assert.match(first, /helper: writer helper/);
    assert.ok(first.includes("APPROVAL REQUIRED"));

    // Deny the visible head: the other request must be promoted untouched.
    input.key("n");
    assert.ok(
      await waitFor(
        () =>
          lastFrameText(output).includes("APPROVAL REQUIRED") &&
          lastFrameText(output).includes(firstIsChild ? "from-parent" : "child.txt"),
        30_000,
      ),
      `the queued ${firstIsChild ? "shell" : "child write"} request is promoted by approval_id, never clobbered`,
    );
    if (!firstIsChild) assert.match(lastFrameText(output), /helper: writer helper/);

    // Deny the promoted request too: both answers reached the right ids and
    // the turn unwinds.
    input.key("n");
    assert.ok(
      await waitFor(() => textOf(output).includes("decision:"), 30_000),
      "both denied requests resolved and the turn completed",
    );
    assert.ok(!lastFrameText(output).includes("APPROVAL REQUIRED"));
    assert.equal(await quit(input, app), 0);
  } finally {
    cleanup();
  }
});

test("O2: a bracketed paste into the open follow-up draft is one sanitized line and writes no parent envelope", async () => {  const { sessionsDir, workspace, sessionFile, cleanup } = helperRoot();
  try {
    const child = new GatedChildProvider();
    const senior = new RecordingMock([
      { tool: SUBAGENT_TOOL_NAME, args: { task: "Inspect the notes file.", label: "gated helper" } },
    ]);
    const { app, input, output } = startApp({
      cfg: resolveConfig({ provider: "mock", sessionFile }),
      sessionsDir,
      workspaceRoot: workspace,
      providerOverrides: { senior, junior: new MockProvider() },
      subagentProviderFactory: () => child,
    });
    assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));
    output.resize(140, 60);
    input.type("inspect the notes");
    input.enter();
    assert.ok(
      await waitFor(() => /helpers 1 running/.test(textOf(output)), 30_000),
      "the live helper shows in the status bar",
    );
    input.key("y", { ctrl: true, raw: "" });
    assert.ok(await waitFor(() => lastFrameText(output).includes("HELPERS · 1 total")));
    input.enter();
    assert.ok(
      await waitFor(() => lastFrameText(output).includes("HELPER · running")),
      "Enter opens the live child's transcript",
    );
    const before = fs.readFileSync(sessionFile);

    input.key("m", { raw: "m" });
    assert.ok(
      await waitFor(() => lastFrameText(output).includes("Enter send · Esc cancel")),
      "m opens the one-line draft",
    );
    // A multi-line paste lands in the draft with every line break as a space.
    input.paste("also check\nthe config\r\nplease");
    assert.ok(
      await waitFor(() => lastFrameText(output).includes("message: also check the config please")),
      "the draft shows the pasted text as one line",
    );
    const frame = lastFrameText(output);
    assert.ok(!frame.includes("also check\nthe config"), "no newline reaches the frame");
    assert.deepEqual(
      fs.readFileSync(sessionFile),
      before,
      "pasting into the draft wrote no parent envelope",
    );

    // Esc cancels only the draft; the run is still live behind the gate.
    input.key("escape");
    assert.ok(
      await waitFor(() => !lastFrameText(output).includes("message: also check the config please")),
      "Esc cancels the pasted draft",
    );
    assert.ok(lastFrameText(output).includes("HELPER ·"), "the detail stays open after Esc");
    assert.deepEqual(
      fs.readFileSync(sessionFile),
      before,
      "the parent transcript is byte-identical across the paste interaction",
    );
    child.openGate();
    assert.ok(
      await waitFor(() => textOf(output).includes("decision:"), 30_000),
      "the parent turn completes once the gate opens",
    );
    assert.equal(await quit(input, app), 0);
  } finally {
    cleanup();
  }
});

test("a model-supplied multiline helper label is normalized to one line at the source and in the UI", async () => {
  const { sessionsDir, workspace, sessionFile, cleanup } = helperRoot();
  try {
    const child = new RecordingMock([{ text: "The notes file says hello." }]);
    const senior = new RecordingMock([
      {
        tool: SUBAGENT_TOOL_NAME,
        args: { task: "Inspect the notes file.", label: "line one\nline two" },
      },
    ]);
    const { app, input, output } = startApp({
      cfg: resolveConfig({ provider: "mock", sessionFile }),
      sessionsDir,
      workspaceRoot: workspace,
      providerOverrides: { senior, junior: new MockProvider() },
      subagentProviderFactory: () => child,
    });
    assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));
    output.resize(140, 60);
    input.type("inspect the notes");
    input.enter();
    assert.ok(
      await waitFor(() => textOf(output).includes("decision:"), 30_000),
      "the turn completed",
    );
    // Source proof: the durable child log recorded the collapsed label.
    const logName = fs.readdirSync(path.join(sessionsDir, "subagents"))[0]!;
    const meta = JSON.parse(
      fs.readFileSync(path.join(sessionsDir, "subagents", logName), "utf8").split("\n")[0]!,
    ) as { label: string };
    assert.equal(meta.label, "line one line two");
    // UI proof: the list shows the collapsed label; the frame has no stray row.
    input.key("y", { ctrl: true, raw: "" });
    assert.ok(await waitFor(() => lastFrameText(output).includes("HELPERS · 1 total")));
    assert.match(lastFrameText(output), /line one line two/);
    assert.equal(await quit(input, app), 0);
  } finally {
    cleanup();
  }
});


test("a TUI turn executes only persisted-selected plugins (strict opt-in, unselected code never runs)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-tui-pluginparity-"));
  try {
    const sessionsDir = path.join(root, "sessions");
    const pluginsDir = path.join(root, "plugins");
    const alphaMarker = path.join(root, "alpha.log");
    const betaMarker = path.join(root, "beta.log");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.mkdirSync(pluginsDir, { recursive: true });
    fs.writeFileSync(path.join(pluginsDir, "alpha.mts"), [
      'import * as fs from "node:fs";',
      "export function register(ctx) {",
      '  ctx.set_description("alpha parity plugin");',
      '  fs.appendFileSync(ctx.options.marker, "register\\n");',
      '  ctx.on_hook("session_start", () => {',
      '    fs.appendFileSync(ctx.options.marker, "hook:session_start\\n");',
      "  });",
      '  ctx.add_tool("alpha_ping", () => "pong", "Ping");',
      "}",
      "export const configSchema = {",
      "  type: 'object',",
      "  properties: { marker: { type: 'string' } },",
      "  required: ['marker'],",
      "};",
      "",
    ].join("\n"));
    fs.writeFileSync(path.join(pluginsDir, "beta.mts"), [
      'import * as fs from "node:fs";',
      "export function register(ctx) {",
      `  fs.writeFileSync(${JSON.stringify(betaMarker)}, "beta executed\\n");`,
      "}",
      "",
    ].join("\n"));
    fs.writeFileSync(path.join(pluginsDir, "package.json"), JSON.stringify({ type: "module" }));
    fs.writeFileSync(
      path.join(sessionsDir, "settings.json"),
      JSON.stringify({
        version: 1,
        plugins: [{ path: "alpha", options: { marker: alphaMarker } }],
      }),
    );
    const { app, input, output } = startApp({
      cfg: resolveConfig({ provider: "mock" }),
      sessionsDir,
      pluginsDir,
    });
    assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));
    input.type("run a turn");
    input.enter();
    assert.ok(
      await waitFor(() => textOf(output).includes("decision:"), 30_000),
      "the turn completed",
    );
    const text = fs.readFileSync(alphaMarker, "utf-8");
    assert.match(text, /^register$/m, "the selected plugin registered at discovery");
    assert.match(
      text,
      /hook:session_start/,
      "the selected plugin's session_start hook fired in the turn",
    );
    assert.equal(
      fs.existsSync(betaMarker),
      false,
      "the unselected plugin's register never ran — its code was never imported",
    );
    assert.equal(await quit(input, app), 0);
  } finally {
    for (let attempt = 0; ; attempt += 1) {
      try {
        fs.rmSync(root, { recursive: true, force: true });
        break;
      } catch (exc) {
        if (attempt >= 4) throw exc;
        await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
      }
    }
  }
});
