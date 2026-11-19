/**
 * In-TUI key-binding editor (`/keys edit`): the capture parser, the
 * validate-and-apply path (fixed-key and other-global conflicts included), the
 * atomic writer + loader round-trip, watcher pickup of an editor save, the
 * pure dialog state machine and its width-safe rendering.
 *
 * The assembled-app flow (the dialog over a fake TTY, conflict refusal with the
 * file unchanged, the no-source refusal) lives in `tuiintegration.test.ts`;
 * this suite stays pure and hermetic (temp files only).
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import {
  bindTuiCommandChord,
  captureTuiChord,
  formatTuiChordSpec,
  loadTuiKeyCommands,
  parseTuiChord,
  reloadTuiCommands,
  resetAllTuiCommandChords,
  resolveTuiCommands,
  saveTuiKeysBindings,
  serializeTuiKeysDocument,
  tuiKeyBindingsFromCommands,
  watchTuiKeysFile,
  type TuiKeysLoadResult,
  type TuiKeysSource,
} from "../src/tui/keyoverrides.ts";
import {
  formatKeys,
  TUI_COMMANDS,
  type KeyChord,
  type TuiCommand,
} from "../src/tui/keymap.ts";
import { styledWidth } from "../src/tui/screen.ts";
import { stripAnsi } from "../src/tui/render.ts";
import {
  KEYS_EDITOR_RESET_LABEL,
  createKeysEditorState,
  keysEditorKey,
  keysEditorRowCount,
  keysEditorRows,
  keysEditorView,
  setKeysEditorError,
  setKeysEditorSaved,
  type KeysEditorData,
  type KeysEditorState,
} from "../src/tui/view/keyseditor.ts";

function chord(name: string, extras: Partial<KeyChord> = {}): KeyChord {
  return { name, ...extras };
}

function commandKeys(commands: readonly TuiCommand[], id: string): string {
  return formatKeys({ keys: commands.find((command) => command.id === id)?.keys });
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(predicate: () => boolean, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

/** Let `fs.watchFile` establish its stat baseline before the first mutation. */
async function waitForWatchBaseline(intervalMs: number): Promise<void> {
  await sleep(Math.max(100, intervalMs * 4));
}

function assertWidthSafe(lines: readonly string[], width: number): void {
  for (const line of lines) {
    assert.ok(
      styledWidth(line) <= width,
      `row exceeds ${width} columns (${styledWidth(line)}): ${JSON.stringify(stripAnsi(line))}`,
    );
  }
}

const SOURCE: TuiKeysSource = { path: "/home/operator/.two-brothers/tui-keys.json", origin: "env" };

function editorData(
  overrides: Partial<KeysEditorData> = {},
  commands: readonly TuiCommand[] = TUI_COMMANDS,
): KeysEditorData {
  return {
    source: SOURCE,
    commands,
    state: "loaded",
    ...overrides,
  };
}

// --------------------------------------------------------------------------- //
// capture: keypress -> storable chord
// --------------------------------------------------------------------------- //

test("capture: modifier chords, named keys and symbols become storable chords", () => {
  const cases: Array<[Parameters<typeof captureTuiChord>[0], KeyChord]> = [
    [{ name: "p", ctrl: true, shift: false }, chord("p", { ctrl: true })],
    [{ name: "p", ctrl: true, shift: true }, chord("p", { ctrl: true, shift: true })],
    [{ name: "p", alt: true }, chord("p", { alt: true })],
    [{ name: "f2", ctrl: false, shift: false }, chord("f2")],
    [{ name: "f2", shift: true }, chord("f2", { shift: true })],
    // Readline reports an uppercase letter as its literal name; Shift is kept.
    [{ name: "P", ctrl: true }, chord("p", { ctrl: true })],
  ];
  for (const [key, expected] of cases) {
    const captured = captureTuiChord(key);
    assert.equal(captured.ok, true, JSON.stringify(key));
    if (captured.ok) assert.deepEqual(captured.chord, expected);
  }
});

test("capture: a literal symbol drops the terminal Shift flag (matching ignores it)", () => {
  const captured = captureTuiChord({ name: "?", shift: true, raw: "?" });
  assert.equal(captured.ok, true);
  if (captured.ok) {
    assert.deepEqual(captured.chord, chord("?"));
    // The captured chord round-trips through the file grammar.
    const parsed = parseTuiChord(formatTuiChordSpec(captured.chord));
    assert.equal(parsed.ok, true);
    if (parsed.ok) assert.deepEqual(parsed.chord, captured.chord);
  }
});

test("capture: auto-repeat, modifier-only presses and pastes never become a chord", () => {
  const ignored: Array<[Parameters<typeof captureTuiChord>[0], string]> = [
    [{ name: "p", ctrl: true, repeat: true }, "repeat"],
    [{ name: "", raw: "" }, "modifier-only"],
    [{ name: "shift" }, "modifier-only"],
    [{ name: "paste", raw: "ctrl+p" }, "paste"],
  ];
  for (const [key, reason] of ignored) {
    const captured = captureTuiChord(key);
    assert.equal(captured.ok, false, JSON.stringify(key));
    if (!captured.ok) assert.equal(captured.reason, reason);
  }
});

test("capture: a key the file grammar cannot express reports why", () => {
  const captured = captureTuiChord({ name: "printscreen" });
  assert.equal(captured.ok, false);
  if (!captured.ok) {
    assert.equal(captured.reason, "unrepresentable");
    assert.match(captured.detail ?? "", /named key or one printable character/);
  }
});

// --------------------------------------------------------------------------- //
// validate-and-apply: fixed keys, other globals, reserved and typing keys
// --------------------------------------------------------------------------- //

test("bind: a free chord applies and returns the fresh command table", () => {
  const applied = bindTuiCommandChord({}, "palette", chord("l", { ctrl: true }));
  assert.equal(applied.ok, true);
  if (applied.ok) {
    assert.equal(commandKeys(applied.commands, "palette"), "Ctrl+L");
    assert.equal(commandKeys(applied.commands, "help"), "? / F1");
    assert.deepEqual(applied.bindings, { palette: [chord("l", { ctrl: true })] });
  }
});

test("bind: a chord bound to a fixed native key is refused, honestly", () => {
  // Fixed keys from every surface the allowlist deliberately excludes: find,
  // the transcript fold, the helpers overlay, the composer's newline and the
  // approval panel's deny key.
  const cases: Array<[KeyChord, string]> = [
    [chord("f", { ctrl: true }), "find"],
    [chord("t", { ctrl: true }), "tool-expand"],
    [chord("y", { ctrl: true }), "agents"],
    [chord("j", { ctrl: true }), "newline"],
    [chord("n", { ctrl: true }), "steer"],
    [chord("e", { ctrl: true }), "approval-preview"],
  ];
  for (const [candidate, id] of cases) {
    const applied = bindTuiCommandChord({}, "palette", candidate);
    assert.equal(applied.ok, false, formatTuiChordSpec(candidate));
    if (!applied.ok) {
      assert.match(
        applied.diagnostics.join("; "),
        new RegExp(`is already bound to the fixed command "${id}"`),
      );
    }
  }
});

test("bind: a chord held by another global chord is refused", () => {
  // Stash keeps its default Ctrl+O, so palette can never take it silently.
  const applied = bindTuiCommandChord({}, "palette", chord("o", { ctrl: true }));
  assert.equal(applied.ok, false);
  if (!applied.ok) {
    assert.match(
      applied.diagnostics.join("; "),
      /already bound to another global chord \("stash"\) — change or reset that one first/,
    );
  }
  // Moving stash away first frees the chord for palette (same validated set).
  const moved = bindTuiCommandChord({}, "stash", chord("u", { ctrl: true }));
  assert.equal(moved.ok, true);
  if (moved.ok) {
    const second = bindTuiCommandChord(moved.bindings, "palette", chord("o", { ctrl: true }));
    assert.equal(second.ok, true);
  }
});

test("bind: reserved, structural and typing keys are refused by the same rules", () => {
  const cases: Array<[KeyChord, RegExp]> = [
    [chord("escape"), /reserved for typing, navigation or the Escape\/quit\/picker layering/],
    [chord("return"), /reserved for typing, navigation or the Escape\/quit\/picker layering/],
    [chord("c", { ctrl: true }), /reserved for quit\/terminal control/],
    [chord("p"), /would swallow typing; add ctrl, shift or alt/],
  ];
  for (const [candidate, expected] of cases) {
    const applied = bindTuiCommandChord({}, "help", candidate);
    assert.equal(applied.ok, false, formatTuiChordSpec(candidate));
    if (!applied.ok) assert.match(applied.diagnostics.join("; "), expected);
  }
});

test("bind: one command cannot take the chord another override already owns", () => {
  const first = bindTuiCommandChord({}, "palette", chord("f2"));
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const second = bindTuiCommandChord(first.bindings, "help", chord("f2"));
  assert.equal(second.ok, false);
  if (!second.ok) assert.match(second.diagnostics.join("; "), /already used by "palette"/);
});

test("reset: all three return to the registry defaults", () => {
  const all = resetAllTuiCommandChords();
  assert.equal(all.ok, true);
  if (all.ok) {
    assert.deepEqual(all.bindings, {});
    assert.equal(commandKeys(all.commands, "palette"), "Ctrl+P");
    assert.equal(commandKeys(all.commands, "help"), "? / F1");
    assert.equal(commandKeys(all.commands, "stash"), "Ctrl+O");
  }
});

test("bindings from commands: defaults are omitted, overrides (with every chord) are kept", () => {
  assert.deepEqual(tuiKeyBindingsFromCommands(TUI_COMMANDS), {});
  const applied = bindTuiCommandChord({}, "palette", chord("l", { ctrl: true }));
  assert.equal(applied.ok, true);
  if (!applied.ok) return;
  assert.deepEqual(tuiKeyBindingsFromCommands(applied.commands), {
    palette: [chord("l", { ctrl: true })],
  });
  // A hand-written multi-chord entry survives the derivation unchanged.
  const multi = {
    help: [chord("f2"), chord("h", { ctrl: true })],
  } satisfies Record<string, KeyChord[]>;
  const resolved = resolveTuiCommands(multi);
  assert.deepEqual(resolved.diagnostics, []);
  assert.deepEqual(tuiKeyBindingsFromCommands(resolved.commands), multi);
});

// --------------------------------------------------------------------------- //
// document + atomic save, then the loader round-trip
// --------------------------------------------------------------------------- //

test("serialize: canonical specs in allowlist order, versioned and parseable", () => {
  const text = serializeTuiKeysDocument({
    palette: [chord("l", { ctrl: true })],
    help: [chord("f2")],
    stash: [chord("u", { ctrl: true })],
  });
  assert.match(text, /"version": 1/);
  assert.equal(
    text,
    `{\n  "version": 1,\n  "bindings": {\n    "palette": [\n      "ctrl+l"\n    ],\n` +
      `    "help": [\n      "f2"\n    ],\n    "stash": [\n      "ctrl+u"\n    ]\n  }\n}\n`,
  );
  for (const spec of ["ctrl+l", "f2", "ctrl+u"]) {
    assert.equal(parseTuiChord(spec).ok, true);
  }
});

test("save: creates the file (and its directory) and the loader reads it back", () => {
  const root = mkdtempSync(path.join(tmpdir(), "tui-keys-editor-"));
  try {
    const file = path.join(root, "nested", "keys.json");
    const applied = bindTuiCommandChord({}, "palette", chord("l", { ctrl: true }));
    assert.equal(applied.ok, true);
    if (!applied.ok) return;
    const saved = saveTuiKeysBindings(file, applied.bindings);
    assert.deepEqual(saved, { ok: true });
    assert.equal(existsSync(file), true);
    const raw = JSON.parse(readFileSync(file, "utf8")) as { version: number; bindings: unknown };
    assert.deepEqual(raw, { version: 1, bindings: { palette: ["ctrl+l"] } });

    const source: TuiKeysSource = { path: file, origin: "env" };
    const loaded = loadTuiKeyCommands(source);
    assert.equal(loaded.state, "loaded");
    assert.deepEqual(loaded.diagnostics, []);
    assert.equal(commandKeys(loaded.commands, "palette"), "Ctrl+L");
    // The same file through the on-demand reload path used by `/keys reload`.
    const reloaded = reloadTuiCommands(source, TUI_COMMANDS);
    assert.equal(reloaded.state, "loaded");
    assert.equal(commandKeys(reloaded.commands, "palette"), "Ctrl+L");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("save: an invalid set is refused before anything is written", () => {
  const root = mkdtempSync(path.join(tmpdir(), "tui-keys-editor-bad-"));
  try {
    const file = path.join(root, "keys.json");
    // `cancel` is a known command but not rebindable (simulating a caller bug).
    const saved = saveTuiKeysBindings(file, {
      cancel: [chord("escape")],
    } as unknown as Parameters<typeof saveTuiKeysBindings>[1]);
    assert.equal(saved.ok, false);
    if (!saved.ok) assert.match(saved.error, /not a rebindable command/);
    assert.equal(existsSync(file), false, "the writer never creates an invalid file");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("save: an IO failure is returned, never thrown, and keeps the previous file", () => {
  const root = mkdtempSync(path.join(tmpdir(), "tui-keys-editor-io-"));
  try {
    const file = path.join(root, "keys.json");
    assert.deepEqual(saveTuiKeysBindings(file, { palette: [chord("l", { ctrl: true })] }), {
      ok: true,
    });
    const before = readFileSync(file, "utf8");
    // A directory cannot be replaced by a file: the rename fails.
    const target = path.join(root, "blocked");
    mkdirSync(target);
    const failed = saveTuiKeysBindings(target, { help: [chord("f2")] });
    assert.equal(failed.ok, false);
    if (!failed.ok) assert.match(failed.error, /cannot write/);
    assert.equal(readFileSync(file, "utf8"), before, "the unrelated file is untouched");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("watch: an editor save is picked up through the same validated reload path", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "tui-keys-editor-watch-"));
  const file = path.join(root, "keys.json");
  const source: TuiKeysSource = { path: file, origin: "env" };
  try {
    const initial = bindTuiCommandChord({}, "palette", chord("l", { ctrl: true }));
    assert.equal(initial.ok, true);
    if (!initial.ok) return;
    assert.deepEqual(saveTuiKeysBindings(file, initial.bindings), { ok: true });
    let commands = loadTuiKeyCommands(source).commands;
    const results: TuiKeysLoadResult[] = [];
    const watcher = watchTuiKeysFile(source, {
      current: () => commands,
      onChange: (result) => {
        results.push(result);
        if (result.state === "loaded") commands = result.commands;
      },
      intervalMs: 20,
      debounceMs: 20,
    });
    assert.notEqual(watcher, null);
    try {
      await waitForWatchBaseline(20);
      const next = bindTuiCommandChord(initial.bindings, "help", chord("f2"));
      assert.equal(next.ok, true);
      if (!next.ok) return;
      assert.deepEqual(saveTuiKeysBindings(file, next.bindings), { ok: true });
      assert.ok(await waitUntil(() => results.length > 0), "the editor save is detected");
      const last = results.at(-1);
      assert.equal(last?.state, "loaded");
      assert.equal(commandKeys(last?.commands ?? TUI_COMMANDS, "help"), "F2");
      assert.equal(commandKeys(last?.commands ?? TUI_COMMANDS, "palette"), "Ctrl+L");
    } finally {
      watcher?.stop();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------------------- //
// dialog state machine
// --------------------------------------------------------------------------- //

test("editor: rows list the three global chords plus the reset action", () => {
  const rows = keysEditorRows();
  assert.equal(rows.length, keysEditorRowCount());
  assert.deepEqual(
    rows.map((row) => (row.kind === "command" ? row.id : "reset")),
    ["palette", "help", "stash", "reset"],
  );
  assert.equal(rows.at(-1)?.kind, "reset");
  for (const row of rows) {
    if (row.kind === "command") assert.ok(row.title.length > 0);
  }
  assert.match(KEYS_EDITOR_RESET_LABEL, /Reset all three/);
});

test("editor: Up/Down wrap, Enter opens a slot's capture, Escape closes", () => {
  let state = createKeysEditorState();
  assert.equal(state.selected, 0);
  const down = keysEditorKey(state, { name: "down" });
  state = down.state;
  assert.equal(down.action.type, "none");
  assert.equal(state.selected, 1);
  state = keysEditorKey(state, { name: "up" }).state;
  assert.equal(state.selected, 0);
  // Up from the first row wraps to the reset row.
  state = keysEditorKey(state, { name: "up" }).state;
  assert.equal(state.selected, keysEditorRowCount() - 1);
  const close = keysEditorKey(state, { name: "escape" });
  assert.equal(close.action.type, "close");
  assert.equal(close.state.selected, keysEditorRowCount() - 1);
});

test("editor: Enter captures the selected slot; the reset row resets all", () => {
  const start = keysEditorKey(createKeysEditorState(), { name: "return" });
  assert.deepEqual(start.action, { type: "capture-start", command: "palette" });
  assert.equal(start.state.phase, "capture");
  assert.equal(start.state.capturing, "palette");

  let state = createKeysEditorState();
  for (let index = 0; index < keysEditorRowCount() - 1; index += 1) {
    state = keysEditorKey(state, { name: "down" }).state;
  }
  const reset = keysEditorKey(state, { name: "space" });
  assert.equal(reset.action.type, "reset-all");
  assert.equal(reset.state.phase, "slots");
});

test("editor: a captured chord becomes an accept intent; Escape cancels only the capture", () => {
  const capture = keysEditorKey(createKeysEditorState(), { name: "return" }).state;
  const accepted = keysEditorKey(capture, { name: "l", ctrl: true });
  assert.deepEqual(accepted.action, {
    type: "accept",
    command: "palette",
    chord: chord("l", { ctrl: true }),
  });
  assert.equal(accepted.state.phase, "slots");

  const cancelled = keysEditorKey(capture, { name: "escape" });
  assert.equal(cancelled.action.type, "cancel-capture");
  assert.equal(cancelled.state.phase, "slots");
  assert.match(cancelled.state.notice ?? "", /capture cancelled/);
  // Ctrl+C cancels the capture too (it never quits while the dialog is open).
  assert.equal(keysEditorKey(capture, { name: "c", ctrl: true }).action.type, "cancel-capture");
});

test("editor: repeats, modifier-only presses and pastes keep the capture waiting", () => {
  const capture = keysEditorKey(createKeysEditorState(), { name: "return" }).state;
  for (const key of [
    { name: "l", ctrl: true, repeat: true },
    { name: "" },
    { name: "shift" },
    { name: "paste", raw: "ctrl+l" },
  ]) {
    const result = keysEditorKey(capture, key);
    assert.equal(result.action.type, "none", JSON.stringify(key));
    assert.equal(result.state.phase, "capture");
    assert.equal(result.state.error, null);
  }
});

test("editor: an unstorable key keeps capture active with the real reason", () => {
  const capture = keysEditorKey(createKeysEditorState(), { name: "return" }).state;
  const result = keysEditorKey(capture, { name: "printscreen" });
  assert.equal(result.action.type, "none");
  assert.equal(result.state.phase, "capture");
  assert.match(result.state.error ?? "", /named key or one printable character/);
});

test("editor: a refused chord re-enters capture with the app's message; a save reports it", () => {
  const state = createKeysEditorState();
  const rejected = setKeysEditorError(state, "help", 'Ctrl+F is already bound to the fixed command "find"');
  assert.equal(rejected.phase, "capture");
  assert.equal(rejected.capturing, "help");
  assert.equal(rejected.selected, 1);
  assert.match(rejected.error ?? "", /already bound/);
  const saved = setKeysEditorSaved(rejected, "help is now F2 — saved to /tmp/keys.json (env)");
  assert.equal(saved.phase, "slots");
  assert.equal(saved.capturing, null);
  assert.equal(saved.error, null);
  assert.match(saved.notice ?? "", /saved to/);
});

// --------------------------------------------------------------------------- //
// rendering: width-safe, honest copy
// --------------------------------------------------------------------------- //

test("view: renders the slots, the captured file and the footer width-safely", () => {
  const view = keysEditorView(createKeysEditorState(), editorData(), {
    width: 72,
    height: 16,
  });
  const text = stripAnsi(view.lines.join("\n"));
  assert.match(text, /KEY BINDINGS/);
  assert.match(text, /Command palette\s+Ctrl\+P/);
  assert.match(text, /Keyboard help\s+\? \/ F1/);
  assert.match(text, /Stash or restore draft\s+Ctrl\+O/);
  assert.match(text, /Reset all three to defaults/);
  assert.match(text, /file: .*tui-keys\.json \(env\)/);
  assert.match(text, /state: loaded/);
  assert.match(text, /Up \/ Down move · Enter change · Esc close/);
  assert.equal(view.lines.length, 16);
  assertWidthSafe(view.lines, 72);
});

test("view: narrow columns clip honestly instead of overflowing", () => {
  for (const width of [20, 25, 30, 41]) {
    const view = keysEditorView(createKeysEditorState(), editorData(), { width, height: 12 });
    assert.equal(view.lines.length, 12);
    assertWidthSafe(view.lines, width);
    assert.ok(stripAnsi(view.lines.join("\n")).length > 0);
  }
});

test("view: the missing-file state says saving creates it; a capture shows its prompt", () => {
  const missing = stripAnsi(
    keysEditorView(createKeysEditorState(), editorData({ state: "missing" }), {
      width: 72,
      height: 16,
    }).lines.join("\n"),
  );
  assert.match(missing, /state: missing — saving creates it/);

  const capturing = keysEditorKey(createKeysEditorState(), { name: "return" }).state;
  const captureText = stripAnsi(
    keysEditorView(capturing, editorData(), { width: 72, height: 16 }).lines.join("\n"),
  );
  assert.match(captureText, /Command palette\s+press keys…/);
  assert.match(captureText, /press the new chord · Esc cancels the capture/);

  const failed: KeysEditorState = setKeysEditorError(
    createKeysEditorState(),
    "palette",
    'Ctrl+F is already bound to the fixed command "find"',
  );
  const errorText = stripAnsi(
    keysEditorView(failed, editorData(), { width: 72, height: 16 }).lines.join("\n"),
  );
  assert.match(errorText, /error: .*already bound to the fixed command/);
});
