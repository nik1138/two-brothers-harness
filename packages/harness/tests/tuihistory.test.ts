/**
 * TUI prompt-history persistence and draft-stash suite.
 *
 * The store tests are pure file-IO tests in a temp directory (no real HOME).
 * The stash tests exercise the pure reducer and the registry binding, plus
 * the assembled app over fake TTY streams so persistence and Ctrl+O are
 * covered at the real seam.
 *
 * Run with: node --test tests/tuihistory.test.ts
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { resolveConfig } from "../src/config.ts";
import {
  seedEditorHistory,
  toggleDraftStash,
  runTuiApp,
  type TuiAppOptions,
} from "../src/tui/app.ts";
import { createEditor } from "../src/tui/editor.ts";
import {
  TUI_HISTORY_FILE_ENV,
  TUI_HISTORY_MAX_ENTRIES,
  TUI_HISTORY_MAX_ENTRY_CHARS,
  appendHistory,
  clipHistoryEntry,
  defaultTuiHistoryPath,
  loadHistory,
  normalizeHistory,
  saveHistory,
} from "../src/tui/historystore.ts";
import {
  TUI_COMMANDS,
  documentEntries,
  findCommand,
  formatKeys,
  matchChord,
  paletteEntries,
  resolveKey,
  tuiHelpLines,
} from "../src/tui/keymap.ts";
import { ANSI, stripAnsi } from "../src/tui/render.ts";

function tmpdir(): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-tui-history-"));
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

// --------------------------------------------------------------------------- //
// history store
// --------------------------------------------------------------------------- //

test("history path honors the env override and falls back to the local-state dir", () => {
  const custom = path.join(os.tmpdir(), "tb-custom-tui-history.json");
  assert.equal(defaultTuiHistoryPath({ [TUI_HISTORY_FILE_ENV]: custom }), custom);
  assert.equal(
    defaultTuiHistoryPath({ [TUI_HISTORY_FILE_ENV]: "   " }),
    path.join(os.homedir(), ".two-brothers", "tui-history.json"),
  );
});

test("roundtrip writes the versioned newest-last shape and replaces atomically", () => {
  const { root, cleanup } = tmpdir();
  try {
    const file = path.join(root, "nested", "tui-history.json");
    saveHistory(file, ["first task", "second\nline", "你好"]);
    assert.deepEqual(loadHistory(file), ["first task", "second\nline", "你好"]);
    const document = JSON.parse(fs.readFileSync(file, "utf8")) as {
      version?: unknown;
      entries?: unknown;
    };
    assert.equal(document.version, 1);
    assert.deepEqual(document.entries, ["first task", "second\nline", "你好"]);

    saveHistory(file, ["replacement"]);
    assert.deepEqual(loadHistory(file), ["replacement"]);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ["tui-history.json"]);
  } finally {
    cleanup();
  }
});

test("load applies the entry cap, consecutive dedupe and per-entry cap", () => {
  const { root, cleanup } = tmpdir();
  try {
    const file = path.join(root, "history.json");
    const many = Array.from({ length: TUI_HISTORY_MAX_ENTRIES + 7 }, (_, index) => `task ${index}`);
    saveHistory(file, many);
    const loaded = loadHistory(file);
    assert.equal(loaded.length, TUI_HISTORY_MAX_ENTRIES);
    assert.equal(loaded[0], "task 7");
    assert.equal(loaded.at(-1), `task ${TUI_HISTORY_MAX_ENTRIES + 6}`);

    saveHistory(file, ["a", "a", "b", "b", "a"]);
    assert.deepEqual(loadHistory(file), ["a", "b", "a"]);

    const long = "😀".repeat(10_000);
    saveHistory(file, ["ok", long]);
    assert.equal(loadHistory(file)[1]?.length, TUI_HISTORY_MAX_ENTRY_CHARS);
    assert.equal(clipHistoryEntry(long).length, TUI_HISTORY_MAX_ENTRY_CHARS);

    assert.deepEqual(appendHistory(["a"], "a"), ["a"]);
    assert.deepEqual(appendHistory(["a"], "b"), ["a", "b"]);
    assert.deepEqual(appendHistory(["a"], "  "), ["a"]);
    assert.deepEqual(normalizeHistory(["x", 1, " ", "x"]), ["x"]);
  } finally {
    cleanup();
  }
});

test("load and save fail soft on unreadable, malformed and failing paths", () => {
  const { root, cleanup } = tmpdir();
  try {
    const file = path.join(root, "history.json");
    assert.deepEqual(loadHistory(path.join(root, "missing.json")), []);

    const asDirectory = path.join(root, "as-directory");
    fs.mkdirSync(asDirectory);
    assert.deepEqual(loadHistory(asDirectory), []);

    fs.writeFileSync(file, "{not json");
    assert.deepEqual(loadHistory(file), []);
    fs.writeFileSync(file, JSON.stringify({ version: 2, entries: ["x"] }));
    assert.deepEqual(loadHistory(file), []);
    fs.writeFileSync(file, JSON.stringify(["bare"]));
    assert.deepEqual(loadHistory(file), []);
    fs.writeFileSync(file, JSON.stringify({ version: 1, entries: "nope" }));
    assert.deepEqual(loadHistory(file), []);

    const blocked = path.join(root, "blocked");
    fs.writeFileSync(blocked, "kept");
    assert.doesNotThrow(() => saveHistory(path.join(blocked, "nested", "history.json"), ["x"]));
    assert.equal(fs.readFileSync(blocked, "utf8"), "kept");

    // a rename that cannot succeed must not throw or leave a temp behind
    assert.doesNotThrow(() => saveHistory(asDirectory, ["x"]));
    assert.equal(fs.statSync(asDirectory).isDirectory(), true);
    assert.deepEqual(fs.readdirSync(root).filter((name) => name.endsWith(".tmp")), []);
  } finally {
    cleanup();
  }
});

// --------------------------------------------------------------------------- //
// draft stash
// --------------------------------------------------------------------------- //

test("stash transitions move one draft between the composer and the slot", () => {
  const draft = createEditor("first draft");
  const stashed = toggleDraftStash(draft, null);
  assert.equal(stashed.outcome, "stashed");
  assert.equal(stashed.stash, "first draft");
  assert.equal(stashed.editor.text, "");
  assert.deepEqual(stashed.editor.history, draft.history);

  const restored = toggleDraftStash(stashed.editor, stashed.stash);
  assert.equal(restored.outcome, "restored");
  assert.equal(restored.editor.text, "first draft");
  assert.equal(restored.stash, null);

  const overwritten = toggleDraftStash(createEditor("newer"), "older");
  assert.equal(overwritten.outcome, "stashed");
  assert.equal(overwritten.stash, "newer");

  const blank = createEditor("   ");
  const noop = toggleDraftStash(blank, null);
  assert.equal(noop.outcome, "empty");
  assert.equal(noop.editor, blank);
  assert.equal(noop.stash, null);

  const emptyWithStash = toggleDraftStash(createEditor(" \n"), "kept");
  assert.equal(emptyWithStash.outcome, "restored");
  assert.equal(emptyWithStash.editor.text, "kept");

  const clipped = toggleDraftStash(createEditor(""), "abcdef", { maxChars: 3 });
  assert.equal(clipped.editor.text, "abc");
});

test("seedEditorHistory keeps order and the editor's 100-entry cap", () => {
  const seeded = seedEditorHistory(createEditor(), ["a", "b", "b", "c"]);
  assert.deepEqual(seeded.history, ["a", "b", "c"]);
  const capped = seedEditorHistory(
    createEditor(),
    Array.from({ length: 105 }, (_, index) => String(index)),
  );
  assert.equal(capped.history.length, 100);
  assert.equal(capped.history[0], "5");
});

test("stash is a conflict-free Ctrl+O command in palette and help", () => {
  const stash = findCommand(TUI_COMMANDS, "stash");
  assert.ok(stash);
  assert.equal(formatKeys(stash), "Ctrl+O");
  assert.equal(stash.when, "composer");
  assert.ok(paletteEntries(TUI_COMMANDS).some((entry) => entry.id === "stash"));
  assert.ok(documentEntries(TUI_COMMANDS).some((entry) => entry.id === "stash"));
  assert.match(
    tuiHelpLines(TUI_COMMANDS).join("\n"),
    /Ctrl\+O\s+Stash the composer draft/,
  );

  const key = { name: "o", ctrl: true, raw: "\u000f" };
  assert.equal(resolveKey(TUI_COMMANDS, key)?.command.id, "stash");
  const conflicts = TUI_COMMANDS.filter(
    (command) =>
      command.id !== "stash" &&
      (command.keys ?? []).some((chord) => matchChord(chord, key)),
  );
  assert.deepEqual(conflicts.map((command) => command.id), []);
  assert.ok(
    !TUI_COMMANDS.some((command) =>
      (command.keys ?? []).some(
        (chord) => chord.name.toLowerCase() === "s" && chord.ctrl === true,
      ),
    ),
    "Ctrl+S (XOFF) must never be bound",
  );
});

// --------------------------------------------------------------------------- //
// assembled app
// --------------------------------------------------------------------------- //

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
    modifiers: { ctrl?: boolean; shift?: boolean; alt?: boolean; raw?: string } = {},
  ): void {
    this.emit("keypress", modifiers.raw ?? "", {
      name,
      ctrl: modifiers.ctrl === true,
      shift: modifiers.shift === true,
      meta: modifiers.alt === true,
    });
  }

  enter(): void {
    this.key("return", { raw: "\r" });
  }

  ctrlO(): void {
    this.key("o", { ctrl: true, raw: "\u000f" });
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

interface AppHarness {
  app: Promise<number>;
  input: FakeInput;
  output: FakeOutput;
}

function startApp(
  root: string,
  historyFile?: string,
  extra: Partial<TuiAppOptions> = {},
): AppHarness {
  const input = new FakeInput();
  const output = new FakeOutput();
  const app = runTuiApp({
    cfg: resolveConfig({ provider: "mock" }),
    io: { log: () => {}, error: () => {} },
    input: input as unknown as NodeJS.ReadStream,
    output: output as unknown as NodeJS.WriteStream,
    pluginsDir: path.join(root, "plugins"),
    sessionsDir: path.join(root, "sessions"),
    ...(historyFile !== undefined ? { historyFile } : {}),
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
  const frames = output.data.split(ANSI.cursorHome);
  return stripAnsi(frames.at(-1) ?? "");
}

/** The turn loop paints "ready …" only after the run's finally block. */
function waitIdle(output: FakeOutput, timeoutMs = 5_000): Promise<boolean> {
  return waitFor(
    () => /ready —|turn completed|turn failed|turn cancelled/.test(lastFrameText(output)),
    timeoutMs,
  );
}

async function quit(input: FakeInput, app: Promise<number>): Promise<number> {
  // Esc precedence: cancel a running turn → clear a draft → arm quit →
  // confirm. Send enough presses with a settle between them.
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

test("the app seeds history, persists accepted tasks and dedupes the newest loaded entry", async () => {
  const { root } = tmpdir();
  const history = path.join(root, "tui-history.json");
  saveHistory(history, ["loaded task"]);
  const harness = startApp(root, history);
  const { input, output } = harness;
  try {
    assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));
    assert.ok(await waitIdle(output));

    input.type("loaded task");
    input.enter();
    assert.ok(await waitFor(() => textOf(output).includes("decision:"), 30_000));
    assert.ok(await waitIdle(output));
    assert.deepEqual(
      loadHistory(history),
      ["loaded task"],
      "submitting the newest loaded entry must not duplicate it",
    );

    input.type("fresh task");
    input.enter();
    assert.ok(await waitFor(() => /YOU\s+fresh task/.test(textOf(output))));
    assert.ok(await waitIdle(output));
    assert.deepEqual(loadHistory(history), ["loaded task", "fresh task"]);

    input.type("draft that never ran");
    assert.ok(await waitFor(() => lastFrameText(output).includes("draft that never ran")));
    assert.deepEqual(loadHistory(history), ["loaded task", "fresh task"]);
  } finally {
    await stop(harness, root);
  }
});

test("loaded history recall is not persisted until it is submitted", async () => {
  const { root } = tmpdir();
  const history = path.join(root, "tui-history.json");
  saveHistory(history, ["loaded only"]);
  const harness = startApp(root, history);
  const { input, output } = harness;
  try {
    assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));
    input.key("up", { raw: "\u001b[A" });
    assert.ok(await waitFor(() => lastFrameText(output).includes("loaded only")));
    assert.deepEqual(loadHistory(history), ["loaded only"]);

    input.type(" and a draft");
    assert.ok(await waitFor(() => lastFrameText(output).includes("and a draft")));
    assert.deepEqual(loadHistory(history), ["loaded only"]);
  } finally {
    await stop(harness, root);
  }
});

test("a CLI-supplied initial task is recorded like a normal submission", async () => {
  const { root } = tmpdir();
  const history = path.join(root, "tui-history.json");
  const harness = startApp(root, history, { initialTask: "cli supplied task" });
  const { input, output } = harness;
  try {
    assert.ok(await waitFor(() => textOf(output).includes("decision:"), 30_000));
    assert.ok(await waitIdle(output));
    assert.deepEqual(loadHistory(history), ["cli supplied task"]);
  } finally {
    await stop(harness, root);
  }
});

test("the env override still enables persistence for injected streams", async () => {
  const { root } = tmpdir();
  const history = path.join(root, "env-history.json");
  const previous = process.env[TUI_HISTORY_FILE_ENV];
  process.env[TUI_HISTORY_FILE_ENV] = history;
  const harness = startApp(root);
  const { input, output } = harness;
  try {
    assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));
    input.type("env task");
    input.enter();
    assert.ok(await waitFor(() => textOf(output).includes("decision:"), 30_000));
    assert.ok(await waitIdle(output));
    assert.deepEqual(loadHistory(history), ["env task"]);
  } finally {
    if (previous === undefined) delete process.env[TUI_HISTORY_FILE_ENV];
    else process.env[TUI_HISTORY_FILE_ENV] = previous;
    await stop(harness, root);
  }
});

test("Ctrl+O stashes and restores one draft with toasts; submitting it persists it", async () => {
  const { root } = tmpdir();
  const history = path.join(root, "tui-history.json");
  const harness = startApp(root, history);
  const { input, output } = harness;
  try {
    assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));

    input.ctrlO();
    assert.ok(
      await waitFor(() => lastFrameText(output).includes("nothing to stash or restore")),
    );

    input.type("stashed draft");
    assert.ok(await waitFor(() => lastFrameText(output).includes("stashed draft")));
    input.ctrlO();
    assert.ok(await waitFor(() => !lastFrameText(output).includes("stashed draft")));
    assert.ok(await waitFor(() => lastFrameText(output).includes("draft stashed")));
    assert.deepEqual(loadHistory(history), []);

    input.ctrlO();
    assert.ok(await waitFor(() => lastFrameText(output).includes("draft restored")));
    assert.ok(lastFrameText(output).includes("stashed draft"));

    // Stash and restore again to prove the single slot survives a full cycle.
    input.ctrlO();
    assert.ok(await waitFor(() => !lastFrameText(output).includes("stashed draft")));
    input.ctrlO();
    assert.ok(await waitFor(() => lastFrameText(output).includes("stashed draft")));

    input.enter();
    assert.ok(await waitFor(() => textOf(output).includes("decision:"), 30_000));
    assert.ok(await waitIdle(output));
    assert.deepEqual(loadHistory(history), ["stashed draft"]);
  } finally {
    await stop(harness, root);
  }
});
