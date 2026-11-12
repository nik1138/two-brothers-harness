/**
 * File-configured TUI key rebinding (`src/tui/keyoverrides.ts`): chord grammar,
 * the versioned document, the fail-soft file path, the allowlist/reserved/
 * duplicate/conflict validation, registry resolution, and the CLI/help
 * catalogue parity that keeps the flag/env documented.
 *
 * The app-level behavior (a rebound chord actually opens the palette/help and
 * the default chord no longer does) lives in `tuiintegration.test.ts`; this
 * suite stays pure and hermetic (temp files only).
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import {
  defaultTuiKeysPath,
  describeTuiKeys,
  describeTuiKeysWatch,
  loadTuiKeyCommands,
  parseTuiChord,
  parseTuiKeysDocument,
  readTuiKeysFile,
  REBINDABLE_TUI_COMMAND_IDS,
  reloadTuiCommands,
  resolveTuiCommands,
  resolveTuiCommandsFromFile,
  resolvedTuiKeysWatchState,
  TUI_KEYS_MAX_BYTES,
  TUI_KEYS_MAX_CHORDS_PER_COMMAND,
  TUI_KEYS_VERSION,
  TUI_KEYS_WATCH_DEBOUNCE_MS,
  TUI_KEYS_WATCH_INTERVAL_MS,
  watchTuiKeysFile,
  type TuiKeysLoadResult,
  type TuiKeysLoadState,
  type TuiKeysSource,
  type TuiKeysWatchState,
} from "../src/tui/keyoverrides.ts";
import {
  TUI_COMMANDS,
  documentEntries,
  formatKeys,
  paletteEntries,
  resolveKey,
  rotatingFooterTip,
  tuiHelpLines,
  type KeyChord,
  type TuiCommand,
} from "../src/tui/keymap.ts";
import { commandHelp, ENVIRONMENT, FLAGS } from "../src/clihelp.ts";
import {
  main,
  resolveTuiKeyCommandsForCli,
  tuiKeysFileForCli,
  tuiKeysWatchForCli,
} from "../src/cli.ts";

function chord(name: string, extras: Partial<KeyChord> = {}): KeyChord {
  return { name, ...extras };
}

function tempFile(name: string, content: string): { dir: string; file: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "tui-keys-test-"));
  const file = path.join(dir, name);
  writeFileSync(file, content, "utf8");
  return { dir, file };
}

function doc(bindings: Record<string, readonly string[]>): string {
  return JSON.stringify({ version: TUI_KEYS_VERSION, bindings });
}

/** Bounded polling wait for the watcher tests (never a fixed sleep assertion). */
async function waitUntil(predicate: () => boolean, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `fs.watchFile` establishes its stat baseline on the first asynchronous poll.
 * A write issued in the same tick as the install can land before that poll and
 * silently become the baseline (no change is ever reported), which is exactly
 * what happens under `node --test`'s parallel file load. Yield past a couple of
 * poll intervals so the baseline exists before the first test mutation.
 */
async function waitForWatchBaseline(intervalMs: number): Promise<void> {
  await sleep(Math.max(100, intervalMs * 4));
}

// --------------------------------------------------------------------------- //
// chord grammar
// --------------------------------------------------------------------------- //

test("chord grammar: modifiers are case-insensitive and order-independent", () => {
  const cases: Array<[string, KeyChord]> = [
    ["ctrl+p", chord("p", { ctrl: true })],
    ["Ctrl+P", chord("p", { ctrl: true })],
    ["control+p", chord("p", { ctrl: true })],
    ["CTRL+SHIFT+P", chord("p", { ctrl: true, shift: true })],
    ["shift+ctrl+p", chord("p", { ctrl: true, shift: true })],
    ["alt+f2", chord("f2", { alt: true })],
    ["meta+f2", chord("f2", { alt: true })],
    ["f1", chord("f1")],
    ["?", chord("?")],
    ["shift+/", chord("/", { shift: true })],
    ["pageup", chord("pageup")],
    [" pgdn ", chord("pagedown")],
    ["enter", chord("return")],
    ["esc", chord("escape")],
  ];
  for (const [spec, expected] of cases) {
    const parsed = parseTuiChord(spec);
    assert.equal(parsed.ok, true, `${spec} should parse`);
    if (parsed.ok) assert.deepEqual(parsed.chord, expected, spec);
  }
});

test("chord grammar: empty, modifier-only and multi-key specs are rejected", () => {
  for (const spec of ["", "   ", "+", "ctrl+", "+p", "ctrl++p", "ctrl", "shift", "ctrl+shift", "ab", "ctrl+ab", "hyper+p", "ctrl+hyper+p", "ctrl+ctrl+p"]) {
    const parsed = parseTuiChord(spec);
    assert.equal(parsed.ok, false, `${JSON.stringify(spec)} should be rejected`);
    if (!parsed.ok) assert.ok(parsed.error.length > 0);
  }
});

test("chord grammar: non-string specs are rejected instead of coerced", () => {
  for (const spec of [undefined, null, 42, ["ctrl+p"], { key: "p" }]) {
    assert.equal(parseTuiChord(spec).ok, false);
  }
});

// --------------------------------------------------------------------------- //
// versioned document
// --------------------------------------------------------------------------- //

test("document: valid versioned bindings parse into chord objects", () => {
  const parsed = parseTuiKeysDocument(
    doc({ palette: ["ctrl+y"], help: ["f2", "shift+f1"], stash: ["ctrl+u"] }),
    "tui-keys.json",
  );
  assert.deepEqual(parsed.diagnostics, []);
  assert.deepEqual(Object.keys(parsed.bindings).sort(), ["help", "palette", "stash"]);
  assert.deepEqual(parsed.bindings.help, [chord("f2"), chord("f1", { shift: true })]);
});

test("document: a versioned document without bindings is an empty configuration", () => {
  const parsed = parseTuiKeysDocument(JSON.stringify({ version: TUI_KEYS_VERSION }), "x.json");
  assert.deepEqual(parsed.diagnostics, []);
  assert.deepEqual(parsed.bindings, {});
});

test("document: corrupt JSON, wrong version and wrong shapes are rejected with a diagnostic", () => {
  const cases: string[] = [
    "{not json",
    "[]",
    "null",
    JSON.stringify({ version: 2, bindings: {} }),
    JSON.stringify({ version: "1", bindings: {} }),
    JSON.stringify({ bindings: {} }),
    JSON.stringify({ version: TUI_KEYS_VERSION, bindings: [] }),
    JSON.stringify({ version: TUI_KEYS_VERSION, bindings: "palette" }),
    JSON.stringify({ version: TUI_KEYS_VERSION, bindings: { palette: "ctrl+y" } }),
    JSON.stringify({ version: TUI_KEYS_VERSION, bindings: { palette: [] } }),
    JSON.stringify({ version: TUI_KEYS_VERSION, bindings: { palette: [42] } }),
    JSON.stringify({ version: TUI_KEYS_VERSION, bindings: { palette: ["ctrl++p"] } }),
  ];
  for (const text of cases) {
    const parsed = parseTuiKeysDocument(text, "x.json");
    assert.equal(parsed.diagnostics.length > 0, true, text);
    assert.deepEqual(parsed.bindings, {}, "a bad document falls back atomically");
  }
});

test("document: a UTF-8 BOM from a Windows editor is tolerated", () => {
  const parsed = parseTuiKeysDocument(
    `\uFEFF${doc({ palette: ["ctrl+y"] })}`,
    "keys.json",
  );
  assert.deepEqual(parsed.diagnostics, []);
  assert.deepEqual(parsed.bindings.palette, [chord("y", { ctrl: true })]);
});

test("document: too many chords for one command is rejected", () => {
  const tooMany = Array.from({ length: TUI_KEYS_MAX_CHORDS_PER_COMMAND + 1 }, (_, index) => `f${index + 1}`);
  const parsed = parseTuiKeysDocument(doc({ palette: tooMany }), "x.json");
  assert.equal(parsed.diagnostics.length, 1);
  assert.match(parsed.diagnostics[0] ?? "", /max/);
});

// --------------------------------------------------------------------------- //
// file loading (fail-soft, bounded)
// --------------------------------------------------------------------------- //

test("file: a missing default path means defaults silently; an explicit missing path is diagnosed", () => {
  const missing = path.join(mkdtempSync(path.join(tmpdir(), "tui-keys-missing-")), "nope.json");
  const silent = readTuiKeysFile(missing);
  assert.equal(silent.found, false);
  assert.deepEqual(silent.diagnostics, []);
  assert.deepEqual(silent.bindings, {});

  const explicit = readTuiKeysFile(missing, { missingIsDiagnostic: true });
  assert.equal(explicit.found, false);
  assert.equal(explicit.diagnostics.length, 1);
  assert.match(explicit.diagnostics[0] ?? "", /not found/);
});

test("file: valid, corrupt and oversized files read fail-soft", () => {
  const good = tempFile("keys.json", doc({ palette: ["ctrl+y"] }));
  const goodRead = readTuiKeysFile(good.file);
  assert.equal(goodRead.found, true);
  assert.deepEqual(goodRead.diagnostics, []);
  assert.deepEqual(goodRead.bindings.palette, [chord("y", { ctrl: true })]);

  const corrupt = tempFile("keys.json", "{oops");
  const corruptRead = readTuiKeysFile(corrupt.file);
  assert.equal(corruptRead.found, true);
  assert.deepEqual(corruptRead.bindings, {});
  assert.match(corruptRead.diagnostics[0] ?? "", /invalid JSON/);

  const oversized = tempFile("keys.json", " ".repeat(TUI_KEYS_MAX_BYTES + 1));
  const oversizedRead = readTuiKeysFile(oversized.file);
  assert.deepEqual(oversizedRead.bindings, {});
  assert.match(oversizedRead.diagnostics[0] ?? "", /max/);

  for (const temp of [good, corrupt, oversized]) rmSync(temp.dir, { recursive: true, force: true });
});

test("file: a directory path is diagnosed instead of crashing", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "tui-keys-dir-"));
  const result = readTuiKeysFile(dir);
  assert.deepEqual(result.bindings, {});
  assert.equal(result.diagnostics.length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test("file: the default path lives under ~/.two-brothers", () => {
  assert.equal(defaultTuiKeysPath("/home/operator"), path.join("/home/operator", ".two-brothers", "tui-keys.json"));
});

// --------------------------------------------------------------------------- //
// resolution (allowlist, reserved, duplicates, conflicts)
// --------------------------------------------------------------------------- //

test("resolve: no bindings returns the untouched registry", () => {
  const resolved = resolveTuiCommands();
  assert.equal(resolved.commands, TUI_COMMANDS);
  assert.deepEqual(resolved.diagnostics, []);
});

test("resolve: a valid override replaces only the allowlisted command's keys", () => {
  const before = formatKeys({ keys: TUI_COMMANDS.find((command) => command.id === "palette")?.keys });
  const resolved = resolveTuiCommands({
    palette: [chord("y", { ctrl: true })],
    help: [chord("f2")],
    stash: [chord("u", { ctrl: true })],
  });
  assert.deepEqual(resolved.diagnostics, []);
  assert.notEqual(resolved.commands, TUI_COMMANDS, "resolved commands are a fresh array");
  const byId = (commands: readonly TuiCommand[], id: string) => commands.find((command) => command.id === id);
  assert.equal(byId(resolved.commands, "palette")?.keys?.[0]?.name, "y");
  assert.equal(byId(resolved.commands, "help")?.keys?.[0]?.name, "f2");
  assert.equal(byId(resolved.commands, "stash")?.keys?.[0]?.name, "u");
  // Non-overridden commands (and their objects) are untouched.
  assert.equal(byId(resolved.commands, "find"), byId(TUI_COMMANDS, "find"));
  // The registry defaults were not mutated.
  assert.equal(formatKeys({ keys: TUI_COMMANDS.find((command) => command.id === "palette")?.keys }), before);
  assert.equal(before, "Ctrl+P");
});

test("resolve: labels, matching, hints, palette and help all derive the effective chord", () => {
  const resolved = resolveTuiCommands({ palette: [chord("y", { ctrl: true })], help: [chord("f2")] });
  assert.deepEqual(resolved.diagnostics, []);
  const commands = resolved.commands;
  assert.equal(formatKeys({ keys: commands.find((command) => command.id === "palette")?.keys }), "Ctrl+Y");
  assert.equal(resolveKey(commands, { name: "y", ctrl: true })?.command.id, "palette");
  assert.equal(resolveKey(commands, { name: "p", ctrl: true }), null, "the default chord is dead");
  const tipHints = Array.from({ length: 12 }, (_, step) => rotatingFooterTip(commands, step));
  assert.ok(tipHints.some((hint) => /Ctrl\+Y/.test(hint)), "some rotation step shows the effective palette chord");
  const palette = paletteEntries(commands).find((entry) => entry.id === "palette");
  assert.equal(palette?.keys, "Ctrl+Y");
  const helpRows = documentEntries(commands);
  assert.equal(helpRows.find((entry) => entry.id === "help")?.keys, "F2");
  const helpText = tuiHelpLines(commands).join("\n");
  assert.match(helpText, /Ctrl\+Y/);
  assert.match(helpText, /F2/);
  assert.doesNotMatch(helpText, /Ctrl\+P/, "the dead default chord is not advertised");
});

test("resolve: unknown and non-allowlisted command ids are diagnosed; defaults stay in force", () => {
  const unknown = resolveTuiCommands({ nope: [chord("y", { ctrl: true })] });
  assert.equal(unknown.commands, TUI_COMMANDS);
  assert.match(unknown.diagnostics[0] ?? "", /unknown TUI command/);

  for (const id of ["exit", "cancel", "find", "approval-allow"]) {
    const resolved = resolveTuiCommands({ [id]: [chord("y", { ctrl: true })] });
    assert.equal(resolved.commands, TUI_COMMANDS, id);
    assert.equal(resolved.diagnostics.length, 1, id);
    assert.match(resolved.diagnostics[0] ?? "", /not a rebindable/, id);
    assert.match(resolved.diagnostics[0] ?? "", new RegExp(REBINDABLE_TUI_COMMAND_IDS.join("|")), id);
  }
});

test("resolve: reserved structural and quit/terminal chords are refused", () => {
  for (const specChord of [
    chord("escape"),
    chord("return"),
    chord("pageup"),
    chord("c", { ctrl: true }),
    chord("z", { ctrl: true }),
    chord("q", { ctrl: true }),
    chord("s", { ctrl: true }),
  ]) {
    const resolved = resolveTuiCommands({ palette: [specChord] });
    assert.equal(resolved.commands, TUI_COMMANDS);
    assert.equal(resolved.diagnostics.length, 1, formatKeys({ keys: [specChord] }));
    assert.match(resolved.diagnostics[0] ?? "", /reserved/);
  }
});

test("resolve: unmodified typing keys are refused", () => {
  for (const key of ["a", "Z", "7"]) {
    const resolved = resolveTuiCommands({ palette: [chord(key)] });
    assert.equal(resolved.commands, TUI_COMMANDS);
    assert.match(resolved.diagnostics[0] ?? "", /typing/);
  }
});

test("resolve: duplicate chords within one command and across commands are refused", () => {
  const same = resolveTuiCommands({ palette: [chord("y", { ctrl: true }), chord("y", { ctrl: true })] });
  assert.equal(same.commands, TUI_COMMANDS);
  assert.match(same.diagnostics[0] ?? "", /duplicate/);

  const across = resolveTuiCommands({
    palette: [chord("y", { ctrl: true })],
    help: [chord("y", { ctrl: true })],
  });
  assert.equal(across.commands, TUI_COMMANDS);
  assert.match(across.diagnostics[0] ?? "", /already used by/);
});

test("resolve: a chord bound to a fixed registry command is refused", () => {
  for (const [id, chordSpec] of [
    ["palette", chord("f", { ctrl: true })],
    ["help", chord("t", { ctrl: true })],
    ["stash", chord("b", { ctrl: true })],
  ] as Array<[string, KeyChord]>) {
    const resolved = resolveTuiCommands({ [id]: [chordSpec] });
    assert.equal(resolved.commands, TUI_COMMANDS);
    assert.match(resolved.diagnostics[0] ?? "", /fixed command/);
  }
});

test("resolve: re-specifying the existing default chord is allowed", () => {
  const resolved = resolveTuiCommands({
    palette: [chord("p", { ctrl: true })],
    help: [chord("?")],
    stash: [chord("o", { ctrl: true })],
  });
  assert.deepEqual(resolved.diagnostics, []);
  assert.equal(formatKeys({ keys: resolved.commands.find((command) => command.id === "palette")?.keys }), "Ctrl+P");
});

test("resolve: multiple valid chords per command are kept in order", () => {
  const resolved = resolveTuiCommands({ help: [chord("f2"), chord("f1", { shift: true })] });
  assert.deepEqual(resolved.diagnostics, []);
  assert.equal(formatKeys({ keys: resolved.commands.find((command) => command.id === "help")?.keys }), "F2 / Shift+F1");
});

test("resolveTuiCommandsFromFile: valid file applies, missing file keeps defaults", () => {
  const valid = tempFile("keys.json", doc({ palette: ["ctrl+y"] }));
  const fromFile = resolveTuiCommandsFromFile(valid.file, { explicit: true });
  assert.deepEqual(fromFile.diagnostics, []);
  assert.equal(formatKeys({ keys: fromFile.commands.find((command) => command.id === "palette")?.keys }), "Ctrl+Y");

  const missing = path.join(valid.dir, "absent.json");
  const missingFile = resolveTuiCommandsFromFile(missing, { explicit: true });
  assert.equal(missingFile.commands, TUI_COMMANDS);
  assert.match(missingFile.diagnostics[0] ?? "", /not found/);

  const silent = resolveTuiCommandsFromFile(null);
  assert.equal(silent.commands, TUI_COMMANDS);
  assert.deepEqual(silent.diagnostics, []);

  rmSync(valid.dir, { recursive: true, force: true });
});

// --------------------------------------------------------------------------- //
// CLI/help catalogue parity (the docs↔CLI drift guard's other half)
// --------------------------------------------------------------------------- //

interface CliCapture {
  out: string[];
  err: string[];
  log(line: string): void;
  error(line: string): void;
}

function makeCliIO(): CliCapture {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, log: (line) => out.push(line), error: (line) => err.push(line) };
}

function keyRows(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => /^ {2}(Ctrl\+[A-Z]|F[0-9]+|!|PgUp|PgDn)/u.test(line))
    .map((line) => line.trimEnd());
}

test("catalogue: --keys-file is a documented tui flag with the env mirror", () => {
  assert.ok("keys-file" in FLAGS, "FLAGS has keys-file");
  const tui = commandHelp("tui");
  assert.ok(tui !== undefined, "tui command spec exists");
  const accepted = tui?.acceptedFlags ?? tui?.flags ?? [];
  assert.ok(accepted.includes("keys-file"), "tui accepts --keys-file");
  assert.ok((tui?.flags ?? []).includes("keys-file"), "tui help lists --keys-file");
  const env = ENVIRONMENT.find((entry) => entry.variable === "TWO_BROTHERS_TUI_KEYS_FILE");
  assert.ok(env !== undefined, "environment table has the keys-file env");
  assert.equal(env?.flag, "--keys-file");
  assert.equal(REBINDABLE_TUI_COMMAND_IDS.join(","), "palette,help,stash");
});

test("catalogue: --keys-watch is a documented tui-only flag with its env mirror", () => {
  assert.ok("keys-watch" in FLAGS, "FLAGS has keys-watch");
  const tui = commandHelp("tui");
  assert.ok(tui !== undefined, "tui command spec exists");
  const accepted = tui?.acceptedFlags ?? tui?.flags ?? [];
  assert.ok(accepted.includes("keys-watch"), "tui accepts --keys-watch");
  assert.ok((tui?.flags ?? []).includes("keys-watch"), "tui help lists --keys-watch");
  const env = ENVIRONMENT.find((entry) => entry.variable === "TWO_BROTHERS_TUI_KEYS_WATCH");
  assert.ok(env !== undefined, "environment table has the keys-watch env");
  assert.equal(env?.flag, "--keys-watch");
  // Off by default: a bare tui never enables the watcher.
  assert.equal(tuiKeysWatchForCli({}, {}), false);
});

test("CLI resolution: --keys-watch flag or the boolean env enables watching (pinned)", () => {
  assert.equal(tuiKeysWatchForCli({ "keys-watch": true }, {}), true);
  for (const raw of ["1", "true", "TRUE", "yes", "on"]) {
    assert.equal(
      tuiKeysWatchForCli({}, { TWO_BROTHERS_TUI_KEYS_WATCH: raw }),
      true,
      `env ${raw} enables watching`,
    );
  }
  for (const raw of ["", "0", "false", "off", "no"]) {
    assert.equal(
      tuiKeysWatchForCli({}, { TWO_BROTHERS_TUI_KEYS_WATCH: raw }),
      false,
      `env ${JSON.stringify(raw)} leaves watching off`,
    );
  }
  // The flag wins; an absent flag means the env decides (never written anywhere).
  assert.equal(
    tuiKeysWatchForCli({ "keys-watch": false }, { TWO_BROTHERS_TUI_KEYS_WATCH: "1" }),
    true,
  );
});

test("CLI resolution: flag beats env beats the default path; explicit problems are diagnosed", () => {
  const home = mkdtempSync(path.join(tmpdir(), "tui-keys-home-"));
  const flagFile = tempFile("flag.json", doc({ palette: ["ctrl+y"] }));
  const envFile = tempFile("env.json", doc({ palette: ["ctrl+h"] }));

  assert.deepEqual(tuiKeysFileForCli({}, {}, home), {
    path: defaultTuiKeysPath(home),
    origin: "default",
    explicit: false,
  });
  assert.deepEqual(tuiKeysFileForCli({}, { TWO_BROTHERS_TUI_KEYS_FILE: envFile.file }, home), {
    path: path.resolve(envFile.file),
    origin: "env",
    explicit: true,
  });
  assert.deepEqual(
    tuiKeysFileForCli(
      { "keys-file": flagFile.file },
      { TWO_BROTHERS_TUI_KEYS_FILE: envFile.file },
      home,
    ),
    { path: path.resolve(flagFile.file), origin: "flag", explicit: true },
  );

  // Missing default file: defaults, no diagnostics.
  const silent = resolveTuiKeyCommandsForCli({}, {}, home);
  assert.equal(silent.commands, TUI_COMMANDS);
  assert.deepEqual(silent.diagnostics, []);
  assert.equal(silent.state, "missing");
  assert.equal(silent.file.origin, "default");

  // Explicit invalid file: defaults plus one honest diagnostic.
  const corrupt = tempFile("bad.json", "{nope");
  const diagnosed = resolveTuiKeyCommandsForCli(
    {},
    { TWO_BROTHERS_TUI_KEYS_FILE: corrupt.file },
    home,
  );
  assert.equal(diagnosed.commands, TUI_COMMANDS);
  assert.match(diagnosed.diagnostics[0] ?? "", /invalid JSON/);

  // Flag wins over the env path.
  const resolved = resolveTuiKeyCommandsForCli(
    { "keys-file": flagFile.file },
    { TWO_BROTHERS_TUI_KEYS_FILE: corrupt.file },
    home,
  );
  assert.deepEqual(resolved.diagnostics, []);
  assert.equal(formatKeys({ keys: resolved.commands.find((command) => command.id === "palette")?.keys }), "Ctrl+Y");

  for (const temp of [flagFile, envFile, corrupt]) rmSync(temp.dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

test("CLI: help tui resolves the env/default keys file and matches tui --help", async () => {
  const good = tempFile("good.json", doc({ palette: ["ctrl+y"], help: ["f2"], stash: ["ctrl+u"] }));
  const bad = tempFile("bad.json", "{oops");
  const previous = process.env.TWO_BROTHERS_TUI_KEYS_FILE;
  try {
    process.env.TWO_BROTHERS_TUI_KEYS_FILE = good.file;

    const helpIo = makeCliIO();
    assert.equal(await main(["help", "tui"], helpIo), 0);
    assert.deepEqual(helpIo.err, [], "help tui keeps stderr clean for a valid file");
    const helpText = helpIo.out.join("\n");
    assert.match(helpText, /Ctrl\+Y/, "help tui shows the effective palette chord");
    assert.match(helpText, /F2/, "help tui shows the effective help chord");
    assert.doesNotMatch(helpText, /Ctrl\+P/, "the dead default chord is not advertised");
    assert.match(helpText, /--keys-file/, "the footer explains the flag context");

    const tuiIo = makeCliIO();
    assert.equal(await main(["tui", "--help"], tuiIo), 0);
    assert.deepEqual(tuiIo.err, [], "tui --help keeps stderr clean for a valid file");
    assert.deepEqual(
      keyRows(helpText),
      keyRows(tuiIo.out.join("\n")),
      "help tui and tui --help print the same effective key rows",
    );

    process.env.TWO_BROTHERS_TUI_KEYS_FILE = bad.file;
    const badHelpIo = makeCliIO();
    assert.equal(await main(["help", "tui"], badHelpIo), 0);
    assert.equal(badHelpIo.err.length, 1, "one honest diagnostic");
    assert.match(badHelpIo.err[0] ?? "", /^\[tui keys\] .*invalid JSON/);
    assert.match(badHelpIo.out.join("\n"), /Ctrl\+P/, "help tui falls back to the defaults");

    const badTuiIo = makeCliIO();
    assert.equal(await main(["tui", "--help"], badTuiIo), 0);
    assert.equal(badTuiIo.err.length, 1, "tui --help prints the same one-line diagnostic");
    assert.match(badTuiIo.err[0] ?? "", /^\[tui keys\] .*invalid JSON/);
  } finally {
    if (previous === undefined) delete process.env.TWO_BROTHERS_TUI_KEYS_FILE;
    else process.env.TWO_BROTHERS_TUI_KEYS_FILE = previous;
    for (const temp of [good, bad]) rmSync(temp.dir, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------------------- //
// `/keys` command: registry entry, status description, reload semantics
// --------------------------------------------------------------------------- //

test("registry: /keys is a chordless, non-rebindable, discoverable Settings command", () => {
  const matches = TUI_COMMANDS.filter((command) => command.id === "keys");
  assert.equal(matches.length, 1, "one /keys command");
  const command = matches[0]!;
  assert.equal(command.slash, "keys");
  assert.equal(command.group, "Settings");
  assert.deepEqual(command.keys ?? [], [], "chordless by design");
  assert.equal(command.when, "always");
  assert.ok(
    !(REBINDABLE_TUI_COMMAND_IDS as readonly string[]).includes("keys"),
    "keys is a command, not a chord target",
  );

  const palette = paletteEntries(TUI_COMMANDS).filter((entry) => entry.id === "keys");
  assert.equal(palette.length, 1, "the palette lists /keys once");
  assert.equal(palette[0]?.slash, "/keys");
  assert.equal(palette[0]?.keys, "", "no chord column");
  const helpRows = documentEntries(TUI_COMMANDS).filter((entry) => entry.id === "keys");
  assert.equal(helpRows.length, 1, "the ? overlay lists /keys once");
  const helpText = tuiHelpLines(TUI_COMMANDS).join("\n");
  assert.match(helpText, /\/keys \[show\|reload\]/, "tui --help lists the slash form");
  assert.equal(
    TUI_COMMANDS.filter((candidate) => candidate.slash === "keys").length,
    1,
    "the slash spelling is unique",
  );
});

test("describeTuiKeys: effective chords, source origin and last diagnostics, never overclaiming", () => {
  const source: TuiKeysSource = {
    path: "/home/operator/.two-brothers/tui-keys.json",
    origin: "default",
  };
  const defaults = describeTuiKeys(TUI_COMMANDS, { source, state: "missing", diagnostics: [] });
  assert.equal(defaults[0], "keys: palette Ctrl+P · help ? / F1 · stash Ctrl+O");
  assert.match(defaults[1] ?? "", /\(default\) — absent; defaults active/);
  assert.match(defaults[2] ?? "", /^keys watch: off /, "watch is off by default");
  assert.equal(defaults.length, 3, "no diagnostics line when the load was clean");

  const overridden = resolveTuiCommands({ palette: [chord("y", { ctrl: true })] }).commands;
  const loaded = describeTuiKeys(overridden, {
    source: { path: "/etc/two-brothers/keys.json", origin: "env" },
    state: "loaded",
    diagnostics: [],
  });
  assert.match(loaded[0] ?? "", /palette Ctrl\+Y/);
  assert.match(loaded[1] ?? "", /\(env\) — loaded$/);

  const failed = describeTuiKeys(overridden, {
    source: { path: "/etc/two-brothers/keys.json", origin: "flag" },
    state: "invalid",
    diagnostics: [`x`.repeat(500)],
  });
  assert.match(failed[1] ?? "", /\(flag\) — invalid; previous chords kept/);
  assert.ok(failed[3]?.startsWith("keys diagnostics: "), "the last diagnostics are reported");
  assert.ok((failed[3]?.length ?? 0) < 300, "the diagnostic line is bounded");

  const embedded = describeTuiKeys(TUI_COMMANDS, { source: null, state: "none", diagnostics: [] });
  assert.match(embedded[1] ?? "", /none/);
  assert.match(
    embedded[2] ?? "",
    /^keys watch: unavailable /,
    "an embedded session with no source reports honest unavailability",
  );
});

test("describeTuiKeys: all six load-state/override combinations are covered and honest", () => {
  const source: TuiKeysSource = { path: "/tmp/tui-keys.json", origin: "flag" };
  const overridden = resolveTuiCommands({ palette: [chord("y", { ctrl: true })] }).commands;
  const matrix: Array<{
    state: TuiKeysLoadState;
    commands: readonly TuiCommand[];
    expected: string;
  }> = [
    { state: "loaded", commands: overridden, expected: "loaded" },
    {
      state: "loaded",
      commands: TUI_COMMANDS,
      expected: "loaded; defaults active (no overrides)",
    },
    { state: "missing", commands: overridden, expected: "absent; previous chords kept" },
    { state: "missing", commands: TUI_COMMANDS, expected: "absent; defaults active" },
    { state: "invalid", commands: overridden, expected: "invalid; previous chords kept" },
    { state: "invalid", commands: TUI_COMMANDS, expected: "invalid; defaults active" },
  ];
  assert.equal(matrix.length, 6, "3 load states × overrides on/off");
  for (const entry of matrix) {
    const lines = describeTuiKeys(entry.commands, {
      source,
      state: entry.state,
      diagnostics: [],
      watch: "off",
    });
    assert.equal(
      lines[1],
      `keys file: ${source.path} (flag) — ${entry.expected}`,
      `${entry.state}/${entry.expected}`,
    );
    assert.match(lines[2] ?? "", /^keys watch: off /);
    assert.equal(lines.length, 3);
  }

  // An override is only claimed when it is actually active: the same loaded
  // file with the default table in force reports "defaults active".
  const overriddenLines = describeTuiKeys(overridden, { source, state: "loaded", diagnostics: [] });
  assert.match(overriddenLines[1] ?? "", /loaded$/);
  const plainLines = describeTuiKeys(TUI_COMMANDS, { source, state: "loaded", diagnostics: [] });
  assert.match(plainLines[1] ?? "", /defaults active \(no overrides\)/);
});

test("describeTuiKeys: watch state is reported as on / off / unavailable", () => {
  const source: TuiKeysSource = { path: "/tmp/keys.json", origin: "env" };
  const cases: Array<[TuiKeysWatchState, RegExp]> = [
    ["on", /^keys watch: on /],
    ["off", /^keys watch: off /],
    ["unavailable", /^keys watch: unavailable /],
  ];
  for (const [watch, pattern] of cases) {
    const lines = describeTuiKeys(TUI_COMMANDS, { source, state: "loaded", diagnostics: [], watch });
    assert.match(lines[2] ?? "", pattern, watch);
  }
  // The line never runs away: an unwatchable embedded session says why once.
  assert.match(describeTuiKeysWatch("unavailable"), /no keys-file source captured/);
  assert.equal(resolvedTuiKeysWatchState(null, "on"), "unavailable");
  assert.equal(resolvedTuiKeysWatchState(source, undefined), "off");
  assert.equal(resolvedTuiKeysWatchState(source, "on"), "on");
});

test("reloadTuiCommands: success swaps the table; failure or absence keeps the last good one", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "tui-reload-"));
  const file = path.join(dir, "keys.json");
  const source: TuiKeysSource = { path: file, origin: "env" };
  const previous = resolveTuiCommands({ palette: [chord("y", { ctrl: true })] }).commands;
  try {
    // Absent explicit file: keep the previous table, one honest diagnostic.
    const absent = reloadTuiCommands(source, previous);
    assert.equal(absent.commands, previous);
    assert.equal(absent.state, "missing");
    assert.match(absent.diagnostics[0] ?? "", /file not found.*previous chords were kept/);

    // The file appears: a reload applies it (the absent-at-startup case).
    const first = loadTuiKeyCommands({ path: file, origin: "default" });
    assert.equal(first.state, "missing");
    assert.deepEqual(first.diagnostics, [], "a missing default file is silent");
    writeFileSync(file, doc({ help: ["f2"] }), "utf8");
    const loaded = reloadTuiCommands(source, previous);
    assert.equal(loaded.state, "loaded");
    assert.deepEqual(loaded.diagnostics, []);
    assert.notEqual(loaded.commands, previous, "a fresh table on success");
    assert.equal(
      formatKeys({ keys: loaded.commands.find((command) => command.id === "help")?.keys }),
      "F2",
    );
    // Only the allowlisted ids are replaced; unrelated commands keep identity.
    assert.equal(
      loaded.commands.find((command) => command.id === "find"),
      previous.find((command) => command.id === "find"),
    );

    // A corrupt file keeps the last good table and reports diagnostics.
    writeFileSync(file, "{oops", "utf8");
    const failed = reloadTuiCommands(source, loaded.commands);
    assert.equal(failed.commands, loaded.commands);
    assert.equal(failed.state, "invalid");
    assert.match(failed.diagnostics[0] ?? "", /invalid JSON/);

    // Absence on the optional default path is silent.
    const missingDefault = reloadTuiCommands(
      { path: path.join(dir, "default.json"), origin: "default" },
      previous,
    );
    assert.equal(missingDefault.commands, previous);
    assert.equal(missingDefault.state, "missing");
    assert.deepEqual(missingDefault.diagnostics, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------------------- //
// opt-in file watcher (`tui --keys-watch` / `TWO_BROTHERS_TUI_KEYS_WATCH`)
// --------------------------------------------------------------------------- //

test("watch defaults: bounded polling, debounce below the interval ceiling, honest copy", () => {
  assert.ok(
    TUI_KEYS_WATCH_INTERVAL_MS >= 100 && TUI_KEYS_WATCH_INTERVAL_MS <= 5_000,
    "the production poll interval stays polite",
  );
  assert.ok(
    TUI_KEYS_WATCH_DEBOUNCE_MS >= 0 &&
      TUI_KEYS_WATCH_DEBOUNCE_MS <= TUI_KEYS_WATCH_INTERVAL_MS * 2,
    "the debounce window coalesces a burst without hiding a real edit",
  );
  assert.match(describeTuiKeysWatch("off"), /--keys-watch/);
  assert.match(describeTuiKeysWatch("on"), /automatically/);
});

test("watch: a valid change live-loads through the reload path and reports exactly once", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "tui-watch-"));
  const file = path.join(dir, "keys.json");
  const source: TuiKeysSource = { path: file, origin: "env" };
  writeFileSync(file, doc({ palette: ["ctrl+y"] }), "utf8");
  let commands: readonly TuiCommand[] = loadTuiKeyCommands(source).commands;
  const results: TuiKeysLoadResult[] = [];
  const watcher = watchTuiKeysFile(source, {
    current: () => commands,
    onChange: (result) => {
      results.push(result);
      if (result.state === "loaded") commands = result.commands;
    },
    intervalMs: 20,
    debounceMs: 30,
  });
  assert.notEqual(watcher, null, "the watcher installs for a temp keys file");
  try {
    assert.equal(watcher?.active, true);
    await waitForWatchBaseline(20);
    writeFileSync(file, doc({ palette: ["ctrl+u"], help: ["f2"] }), "utf8");
    assert.ok(await waitUntil(() => results.length > 0), "the change is detected");
    const first = results[0];
    assert.equal(first?.state, "loaded");
    assert.equal(first?.diagnostics.length, 0);
    assert.equal(
      formatKeys({ keys: first?.commands.find((command) => command.id === "palette")?.keys }),
      "Ctrl+U",
    );
    assert.equal(
      formatKeys({ keys: first?.commands.find((command) => command.id === "help")?.keys }),
      "F2",
    );
    await sleep(150);
    assert.equal(results.length, 1, "one reload per detected change");
  } finally {
    watcher?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("watch: an invalid change keeps the last good table, warns once, and recovers", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "tui-watch-bad-"));
  const file = path.join(dir, "keys.json");
  const source: TuiKeysSource = { path: file, origin: "flag" };
  writeFileSync(file, doc({ palette: ["ctrl+y"] }), "utf8");
  let commands: readonly TuiCommand[] = loadTuiKeyCommands(source).commands;
  const results: TuiKeysLoadResult[] = [];
  const watcher = watchTuiKeysFile(source, {
    current: () => commands,
    onChange: (result) => {
      results.push(result);
      if (result.state === "loaded") commands = result.commands;
    },
    intervalMs: 20,
    debounceMs: 30,
  });
  assert.notEqual(watcher, null);
  try {
    await waitForWatchBaseline(20);
    writeFileSync(file, "{oops\n", "utf8");
    assert.ok(await waitUntil(() => results.length > 0), "the corrupt file is detected");
    assert.equal(results[0]?.state, "invalid");
    assert.equal(results[0]?.commands, commands, "the last good table is kept by identity");
    assert.match(results[0]?.diagnostics.join("; ") ?? "", /invalid JSON/);
    await sleep(150);
    assert.equal(results.length, 1, "no warning spam while the file stays corrupt");

    // A later valid write applies and keeps the same validated path.
    writeFileSync(file, doc({ help: ["f2"] }), "utf8");
    assert.ok(
      await waitUntil(() => results.length === 2),
      "a repaired file reloads",
    );
    assert.equal(results[1]?.state, "loaded");
    assert.equal(
      formatKeys({ keys: commands.find((command) => command.id === "help")?.keys }),
      "F2",
    );
  } finally {
    watcher?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("watch: an absent path loads when created and reports absence when deleted", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "tui-watch-absent-"));
  const file = path.join(dir, "keys.json");
  const source: TuiKeysSource = { path: file, origin: "default" };
  // The session's last good table (e.g. defaults loaded before the file existed).
  let commands: readonly TuiCommand[] = resolveTuiCommands({
    palette: [chord("y", { ctrl: true })],
  }).commands;
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
    await sleep(100);
    assert.equal(results.length, 0, "absence at start is not a change");

    writeFileSync(file, doc({ help: ["f2"] }), "utf8");
    assert.ok(await waitUntil(() => results.length === 1), "the created file loads");
    assert.equal(results[0]?.state, "loaded");
    assert.equal(
      formatKeys({ keys: results[0]?.commands.find((command) => command.id === "help")?.keys }),
      "F2",
    );

    unlinkSync(file);
    assert.ok(await waitUntil(() => results.length === 2), "the deletion is reported");
    assert.equal(results[1]?.state, "missing");
    assert.equal(results[1]?.commands, commands, "the last good table survives absence");
  } finally {
    watcher?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("watch: stop() unwatches, drops a pending reload and is idempotent", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "tui-watch-stop-"));
  const file = path.join(dir, "keys.json");
  const source: TuiKeysSource = { path: file, origin: "env" };
  writeFileSync(file, doc({ palette: ["ctrl+y"] }), "utf8");
  const results: TuiKeysLoadResult[] = [];
  const watcher = watchTuiKeysFile(source, {
    current: () => TUI_COMMANDS,
    onChange: (result) => results.push(result),
    intervalMs: 20,
    debounceMs: 30,
  });
  assert.notEqual(watcher, null);
  try {
    writeFileSync(file, doc({ palette: ["ctrl+u"] }), "utf8");
    watcher?.stop();
    assert.equal(watcher?.active, false);
    watcher?.stop(); // idempotent: no throw, no second unwatch side effect
    assert.equal(watcher?.active, false);
    await sleep(150);
    assert.equal(results.length, 0, "no reload fires after stop (the timer is cleared)");

    // A later edit is invisible: the poll is gone.
    writeFileSync(file, doc({ palette: ["ctrl+j"] }), "utf8");
    await sleep(120);
    assert.equal(results.length, 0);
  } finally {
    watcher?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("watch: rapid writes inside the debounce window coalesce into one reload", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "tui-watch-coalesce-"));
  const file = path.join(dir, "keys.json");
  const source: TuiKeysSource = { path: file, origin: "env" };
  writeFileSync(file, doc({ palette: ["ctrl+y"] }), "utf8");
  const results: TuiKeysLoadResult[] = [];
  const watcher = watchTuiKeysFile(source, {
    current: () => TUI_COMMANDS,
    onChange: (result) => results.push(result),
    intervalMs: 10,
    debounceMs: 200,
  });
  assert.notEqual(watcher, null);
  try {
    await waitForWatchBaseline(10);
    writeFileSync(file, doc({ palette: ["ctrl+u"] }), "utf8");
    await sleep(60);
    writeFileSync(file, doc({ palette: ["ctrl+y"] }), "utf8");
    assert.ok(await waitUntil(() => results.length > 0), "the burst reloads");
    await sleep(350);
    assert.equal(results.length, 1, "one coalesced reload, not one per write");
    assert.equal(
      formatKeys({ keys: results[0]?.commands.find((command) => command.id === "palette")?.keys }),
      "Ctrl+Y",
      "the reload sees the final file content",
    );
  } finally {
    watcher?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("watch: an uninstallable path reports null instead of throwing", () => {
  const watcher = watchTuiKeysFile(
    { path: "bad\u0000path", origin: "env" },
    { current: () => TUI_COMMANDS, onChange: () => {} },
  );
  assert.equal(watcher, null);
});
