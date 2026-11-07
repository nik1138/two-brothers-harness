/**
 * TUI composer recall suite: Up/Down previous-message recall over the assembled
 * app (fake TTY streams, mock provider only — no subprocess, no network).
 *
 * Covers the owner request "get previous messages in the TUI by pressing Up and
 * Down": the live draft is stashed and restored byte-exactly, only submitted
 * tasks are recallable (an unsent draft never enters history), persisted
 * history loaded at startup is available immediately, recall navigation never
 * appends to the persisted history file, and the multiline boundary rule (a
 * multiline draft only leaves the composer at its very edges) holds through the
 * real key path.
 *
 * Run with: node --test tests/tuirecall.test.ts
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { resolveConfig } from "../src/config.ts";
import { runTuiApp, type TuiAppOptions } from "../src/tui/app.ts";
import { loadHistory, saveHistory } from "../src/tui/historystore.ts";
import { ANSI } from "../src/tui/render.ts";
import { stripAnsi } from "../src/tui/screen.ts";

class FakeInput extends EventEmitter {
  isTTY = true;
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  setEncoding(): void {}
  unref(): void {}

  type(text: string): void {
    for (const char of text) {
      this.emit("keypress", char, {
        name: char,
        ctrl: false,
        shift: char !== char.toLowerCase(),
      });
    }
  }

  key(
    name: string,
    modifiers: { ctrl?: boolean; shift?: boolean; raw?: string } = {},
  ): void {
    this.emit("keypress", modifiers.raw ?? "", {
      name,
      ctrl: modifiers.ctrl === true,
      shift: modifiers.shift === true,
    });
  }

  up(): void {
    this.key("up", { raw: "\u001b[A" });
  }

  down(): void {
    this.key("down", { raw: "\u001b[B" });
  }

  enter(): void {
    this.key("return", { raw: "\r" });
  }

  newline(): void {
    this.key("return", { raw: "\r", shift: true });
  }

  documentStart(): void {
    this.key("home", { ctrl: true });
  }
}

class FakeOutput extends EventEmitter {
  isTTY = true;
  columns = 100;
  rows = 30;
  data = "";
  write(chunk: string): boolean {
    this.data += chunk;
    return true;
  }
}

interface AppHarness {
  app: Promise<number>;
  input: FakeInput;
  output: FakeOutput;
}

function tmpdir(): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-tui-recall-"));
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function startApp(root: string, historyFile: string): AppHarness {
  const input = new FakeInput();
  const output = new FakeOutput();
  const extra: Partial<TuiAppOptions> = { historyFile };
  const app = runTuiApp({
    cfg: resolveConfig({ provider: "mock" }),
    io: { log: () => {}, error: () => {} },
    input: input as unknown as NodeJS.ReadStream,
    output: output as unknown as NodeJS.WriteStream,
    pluginsDir: path.join(root, "plugins"),
    sessionsDir: path.join(root, "sessions"),
    ...extra,
  });
  return { app, input, output };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
}

const textOf = (output: FakeOutput): string => stripAnsi(output.data);

function lastFrameText(output: FakeOutput): string {
  return stripAnsi(output.data.split(ANSI.cursorHome).at(-1) ?? "");
}

/** The turn loop paints "ready …" only after the run's finally block. */
function waitIdle(output: FakeOutput, timeoutMs = 15_000): Promise<boolean> {
  return waitFor(
    () => /ready —|turn completed|turn failed|turn cancelled/.test(lastFrameText(output)),
    timeoutMs,
  );
}

async function quit(input: FakeInput, app: Promise<number>): Promise<number> {
  for (let press = 0; press < 8; press += 1) {
    input.key("escape");
    const settled = await Promise.race([
      app.then((code) => code as number | "pending"),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 200)),
    ]);
    if (settled !== "pending") return settled;
  }
  const code = await Promise.race([
    app,
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 10_000)),
  ]);
  if (code === "timeout") throw new Error("the TUI did not exit after repeated Escape");
  return code;
}

async function stop(harness: AppHarness, root: string): Promise<void> {
  try {
    assert.equal(await quit(harness.input, harness.app), 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("Up/Down recall loaded tasks, restore the draft byte-exactly and never append", async () => {
  const { root, cleanup } = tmpdir();
  const history = path.join(root, "tui-history.json");
  saveHistory(history, ["older task", "newest task"]);
  const harness = startApp(root, history);
  const { input, output } = harness;
  try {
    assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));

    // An unsent draft is stashed verbatim, not recorded: the history file stays
    // byte-identical across the whole navigation below.
    input.type("keep this draft");
    assert.ok(await waitFor(() => lastFrameText(output).includes("keep this draft")));

    input.up();
    assert.ok(
      await waitFor(() => lastFrameText(output).includes("newest task")),
      "the first Up recalls the newest submitted task",
    );
    assert.equal(lastFrameText(output).includes("keep this draft"), false);
    assert.deepEqual(loadHistory(history), ["older task", "newest task"], "recall never writes");

    input.up();
    assert.ok(await waitFor(() => lastFrameText(output).includes("older task")));
    input.up();
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.ok(lastFrameText(output).includes("older task"), "the oldest entry stops recall");
    assert.deepEqual(loadHistory(history), ["older task", "newest task"]);

    input.down();
    assert.ok(await waitFor(() => lastFrameText(output).includes("newest task")));
    input.down();
    assert.ok(
      await waitFor(() => lastFrameText(output).includes("keep this draft")),
      "stepping past the newest task restores the preserved live draft",
    );
    input.down();
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.ok(
      lastFrameText(output).includes("keep this draft"),
      "Down on the live draft is a no-op, never a loss",
    );
    assert.deepEqual(loadHistory(history), ["older task", "newest task"]);
  } finally {
    await stop(harness, root);
    cleanup();
  }
});

test("only accepted submissions join history; recalled tasks stay recallable", async () => {
  const { root, cleanup } = tmpdir();
  const history = path.join(root, "tui-history.json");
  const harness = startApp(root, history);
  const { input, output } = harness;
  try {
    assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));

    // Nothing submitted yet: an unsent draft cannot be recalled.
    input.type("unsent one");
    input.up();
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.ok(lastFrameText(output).includes("unsent one"), "no task in history to recall");

    input.enter();
    assert.ok(await waitFor(() => textOf(output).includes("decision:"), 30_000));
    assert.ok(await waitIdle(output));
    input.type("second task");
    input.enter();
    assert.ok(await waitFor(() => /YOU\s+second task/.test(textOf(output)), 30_000));
    assert.ok(await waitIdle(output));
    assert.deepEqual(loadHistory(history), ["unsent one", "second task"]);

    // Recall navigation walks the accepted tasks newest-first and never appends.
    input.up();
    assert.ok(await waitFor(() => lastFrameText(output).includes("second task")));
    input.up();
    assert.ok(await waitFor(() => lastFrameText(output).includes("unsent one")));
    assert.deepEqual(loadHistory(history), ["unsent one", "second task"]);

    // Down past the newest restores the empty pre-recall composer.
    input.down();
    input.down();
    assert.ok(
      await waitFor(() => lastFrameText(output).includes("Type a task")),
      "the empty draft was preserved and restored",
    );
    assert.deepEqual(loadHistory(history), ["unsent one", "second task"]);
  } finally {
    await stop(harness, root);
    cleanup();
  }
});

test("multiline draft: Up/Down recall only at the very edges, never mid-draft", async () => {
  const { root, cleanup } = tmpdir();
  const history = path.join(root, "tui-history.json");
  saveHistory(history, ["recalled task"]);
  const harness = startApp(root, history);
  const { input, output } = harness;
  try {
    assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));

    input.type("line one");
    input.newline();
    input.type("line two");
    assert.ok(await waitFor(() => lastFrameText(output).includes("line two")));

    // The caret is at the end of the last line, so Up is ordinary vertical
    // movement: the draft stays exactly as typed and nothing is recalled.
    input.up();
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.ok(lastFrameText(output).includes("line one"), "the first line is still the draft");
    assert.equal(lastFrameText(output).includes("recalled task"), false, "no recall mid-draft");

    // Ctrl+Home puts the caret at the very start of the first line; there Up
    // recalls and stashes the whole multiline draft.
    input.documentStart();
    input.up();
    assert.ok(
      await waitFor(() => lastFrameText(output).includes("recalled task")),
      "Up at the draft start recalls",
    );
    input.down();
    assert.ok(
      await waitFor(() => lastFrameText(output).includes("line one")),
      "Down at the end restores the multiline draft",
    );
    assert.ok(lastFrameText(output).includes("line two"));
    assert.deepEqual(loadHistory(history), ["recalled task"]);
  } finally {
    await stop(harness, root);
    cleanup();
  }
});
