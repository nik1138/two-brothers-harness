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
import { displayWidth } from "../src/tui/text.ts";
import {
  historySearchHints,
  historySearchView,
  moveHistorySearchSelection,
  openHistorySearch,
  searchHistory,
  searchHistoryKey,
  selectedHistoryMatch,
} from "../src/tui/view/historysearch.ts";

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

  ctrlR(): void {
    this.key("r", { ctrl: true, raw: "\u0012" });
  }

  backspace(): void {
    this.key("backspace", { raw: "\u007f" });
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

// --------------------------------------------------------------------------- //
// reverse history search (Ctrl+R)
// --------------------------------------------------------------------------- //

function searchKey(
  name: string,
  raw = name,
  modifiers: { ctrl?: boolean; shift?: boolean; alt?: boolean } = {},
): { name: string; raw: string; ctrl?: boolean; shift?: boolean; alt?: boolean } {
  return { name, raw, ...modifiers };
}

test("history search filters case-insensitively, newest first", () => {
  const entries = ["Alpha one", "beta two", "Gamma three", "BETA four"];
  assert.deepEqual(searchHistory(entries, ""), [
    "BETA four",
    "Gamma three",
    "beta two",
    "Alpha one",
  ]);
  assert.deepEqual(searchHistory(entries, "beta"), ["BETA four", "beta two"]);
  assert.deepEqual(searchHistory(entries, "ALPHA"), ["Alpha one"]);
  assert.deepEqual(searchHistory(entries, "nope"), []);
});

test("openHistorySearch and searchHistoryKey filter incrementally and cycle", () => {
  let state = openHistorySearch(["first", "second", "third"]);
  assert.equal(state.query, "");
  assert.deepEqual(state.matches, ["third", "second", "first"]);
  assert.equal(state.selected, 0);
  assert.equal(selectedHistoryMatch(state), "third");

  const typed = searchHistoryKey(state, searchKey("s"));
  state = typed.state;
  assert.equal(typed.action, "filter");
  assert.equal(state.query, "s");
  assert.deepEqual(state.matches, ["second", "first"]);

  const erased = searchHistoryKey(state, searchKey("backspace", "\u007f"));
  assert.equal(erased.action, "filter");
  assert.equal(erased.state.query, "");
  assert.deepEqual(erased.state.matches, ["third", "second", "first"]);

  const wrappedUp = moveHistorySearchSelection(erased.state, -1);
  assert.equal(wrappedUp.selected, 2);
  const wrappedDown = moveHistorySearchSelection(wrappedUp, 1);
  assert.equal(wrappedDown.selected, 0);
  const repeated = searchHistoryKey(wrappedDown, searchKey("r", "\u0012", { ctrl: true }));
  assert.equal(repeated.action, "move");
  assert.equal(repeated.state.selected, 1);

  const empty = openHistorySearch([]);
  assert.equal(moveHistorySearchSelection(empty, 1).selected, 0);
});

test("Enter accepts the selected match, Esc cancels and no-match is a no-op", () => {
  const state = openHistorySearch(["one", "two", "three"]);
  const accepted = searchHistoryKey(state, searchKey("return", "\r"));
  assert.equal(accepted.action, "accept");
  assert.equal(accepted.text, "three", "the newest match is selected first");
  assert.equal(accepted.state, state);

  const moved = searchHistoryKey(state, searchKey("r", "\u0012", { ctrl: true })).state;
  const second = searchHistoryKey(moved, searchKey("return", "\r"));
  assert.equal(second.text, "two");

  const cancelled = searchHistoryKey(state, searchKey("escape", "\u001b"));
  assert.equal(cancelled.action, "cancel");
  assert.equal(cancelled.state, state);

  const noMatch = searchHistoryKey(state, searchKey("z"));
  assert.deepEqual(noMatch.state.matches, []);
  const refused = searchHistoryKey(noMatch.state, searchKey("return", "\r"));
  assert.equal(refused.action, "no-match");
  assert.equal(refused.text, undefined);
});

test("history search never mutates the submitted history", () => {
  const entries = ["older", "newest"];
  const snapshot = [...entries];
  let state = openHistorySearch(entries);
  state = searchHistoryKey(state, searchKey("o")).state;
  const accepted = searchHistoryKey(state, searchKey("return", "\r"));
  assert.equal(accepted.text, "older");
  assert.deepEqual(entries, snapshot);
  assert.deepEqual(state.entries, snapshot);
});

test("history search view is an exact cell with a highlighted match and clear empty/no-match rows", () => {
  const state = openHistorySearch(["alpha task", "beta task"]);
  const view = historySearchView(state, { width: 40, height: 6 });
  assert.equal(view.lines.length, 6);
  for (const row of view.lines) {
    assert.equal(displayWidth(row), 40);
    assert.ok(!row.includes("\u001b"));
  }
  assert.equal(view.noMatch, false);
  assert.equal(view.visible.length, 2);
  assert.equal(view.selectedRow, 2);
  assert.ok(view.lines[view.selectedRow]?.startsWith("› "));
  assert.ok(view.lines[view.selectedRow]?.includes("beta task"));
  assert.match(view.lines[0] ?? "", /History search \(2\) · 1\/2/);

  for (const width of [0, 1, 10, 26, 68]) {
    for (const height of [0, 1, 2, 3, 6, 14]) {
      const sized = historySearchView(state, { width, height });
      assert.equal(sized.lines.length, height, `height ${height}`);
      for (const row of sized.lines) assert.equal(displayWidth(row), width);
    }
  }

  const noMatch = historySearchView(searchHistoryKey(state, searchKey("z")).state, {
    width: 40,
    height: 6,
  });
  assert.equal(noMatch.noMatch, true);
  assert.equal(noMatch.selectedRow, -1);
  assert.match(noMatch.lines[2] ?? "", /No matches for "z"/);

  const empty = historySearchView(openHistorySearch([]), { width: 40, height: 6 });
  assert.equal(empty.noMatch, true);
  assert.match(empty.lines[2] ?? "", /No submitted prompts yet/);
  assert.match(historySearchHints(TUI_COMMANDS), /Ctrl\+R cycle$/);
});

test("history search is a conflict-free Ctrl+R command exposed in help and palette", () => {
  const command = findCommand(TUI_COMMANDS, "history-search");
  assert.ok(command);
  assert.equal(formatKeys(command), "Ctrl+R");
  assert.equal(command.when, "composer");
  assert.ok(paletteEntries(TUI_COMMANDS).some((entry) => entry.id === "history-search"));
  assert.ok(documentEntries(TUI_COMMANDS).some((entry) => entry.id === "history-search"));
  assert.match(
    tuiHelpLines(TUI_COMMANDS).join("\n"),
    /Ctrl\+R\s+Incrementally search earlier submitted tasks/,
  );

  const key = { name: "r", ctrl: true, raw: "\u0012" };
  assert.equal(resolveKey(TUI_COMMANDS, key)?.command.id, "history-search");
  const conflicts = TUI_COMMANDS.filter(
    (candidate) =>
      candidate.id !== "history-search" &&
      (candidate.keys ?? []).some((chord) => matchChord(chord, key)),
  );
  assert.deepEqual(conflicts.map((candidate) => candidate.id), []);
});

test("Ctrl+R accepts a match into the composer and submits it through the normal path", async () => {
  const { root } = tmpdir();
  const history = path.join(root, "tui-history.json");
  saveHistory(history, ["older task", "newer task"]);
  const harness = startApp(root, history);
  const { input, output } = harness;
  try {
    assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));
    input.ctrlR();
    assert.ok(await waitFor(() => lastFrameText(output).includes("HISTORY")));
    assert.ok(lastFrameText(output).includes("newer task"));

    // A repeated Ctrl+R cycles older matches, wrapping back to the newest.
    input.ctrlR();
    assert.ok(await waitFor(() => lastFrameText(output).includes("› older task")));
    input.ctrlR();
    assert.ok(await waitFor(() => lastFrameText(output).includes("› newer task")));

    input.type("OLDER");
    assert.ok(await waitFor(() => lastFrameText(output).includes("> OLDER")));
    assert.ok(await waitFor(() => lastFrameText(output).includes("› older task")));
    input.enter();
    assert.ok(await waitFor(() => !lastFrameText(output).includes("HISTORY")));
    assert.ok(lastFrameText(output).includes("older task"), "the accepted match lands in the composer");

    // The cursor sits at the end of the accepted match: typing appends.
    input.type("!");
    assert.ok(await waitFor(() => lastFrameText(output).includes("older task!")));
    input.backspace();
    assert.ok(await waitFor(() => !lastFrameText(output).includes("older task!")));
    assert.ok(lastFrameText(output).includes("older task"));

    assert.deepEqual(
      loadHistory(history),
      ["older task", "newer task"],
      "accepting must not re-append or mutate persisted history",
    );

    input.enter();
    assert.ok(await waitFor(() => textOf(output).includes("decision:"), 30_000));
    assert.ok(await waitIdle(output));
    assert.deepEqual(loadHistory(history), ["older task", "newer task", "older task"]);
  } finally {
    await stop(harness, root);
  }
});

test("Ctrl+R Esc restores the exact draft and never mutates history", async () => {
  const { root } = tmpdir();
  const history = path.join(root, "tui-history.json");
  saveHistory(history, ["first task", "second task"]);
  const harness = startApp(root, history);
  const { input, output } = harness;
  try {
    assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));
    input.type("my draft survives");
    assert.ok(await waitFor(() => lastFrameText(output).includes("my draft survives")));

    input.ctrlR();
    assert.ok(await waitFor(() => lastFrameText(output).includes("HISTORY")));
    input.type("first");
    assert.ok(await waitFor(() => lastFrameText(output).includes("> first")));
    assert.ok(lastFrameText(output).includes("first task"));
    input.type("zz");
    assert.ok(await waitFor(() => lastFrameText(output).includes('No matches for "firstzz"')));
    input.backspace();
    input.backspace();
    assert.ok(await waitFor(() => lastFrameText(output).includes("first task")));
    assert.ok(!lastFrameText(output).includes("No matches"));

    input.key("escape");
    assert.ok(await waitFor(() => !lastFrameText(output).includes("HISTORY")));
    assert.ok(
      await waitFor(() => lastFrameText(output).includes("my draft survives")),
      "the pre-search draft is restored exactly",
    );
    assert.deepEqual(loadHistory(history), ["first task", "second task"]);
  } finally {
    await stop(harness, root);
  }
});
