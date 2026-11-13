/**
 * Registry and overlay suite: one command/keymap source, safe chord matching,
 * slash/template metadata, filtering, selection and narrow help/palette views.
 *
 * Run with: node --test tests/tuikeymap.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { displayWidth } from "../src/tui/text.ts";
import {
  COMMAND_GROUPS,
  TUI_COMMANDS,
  documentEntries,
  findCommand,
  findSlashCommand,
  formatChord,
  formatKeys,
  hintSegments,
  isCommandEnabled,
  matchChord,
  paletteEntries,
  resolveKey,
  tuiHelpLines,
  type KeyLike,
  type PaletteEntry,
} from "../src/tui/keymap.ts";
import {
  createPaletteState,
  dropLastGrapheme,
  filterPaletteEntries,
  handlePaletteKey,
  movePaletteSelection,
  paletteHints,
  paletteView,
  printableKeyText,
  renderPalette,
  selectedPaletteEntry,
  setPaletteQuery,
  viewPad,
  viewTextWidth,
  viewTruncate,
  windowStart,
} from "../src/tui/view/palette.ts";
import {
  createHelpState,
  filterHelpEntries,
  groupHelpEntries,
  handleHelpKey,
  helpEntries,
  helpHints,
  helpView,
  moveHelpSelection,
  orderedHelpEntries,
  renderHelp,
  selectedHelpEntry,
  setHelpQuery,
} from "../src/tui/view/help.ts";

function key(name: string, raw = name, modifiers: Partial<KeyLike> = {}): KeyLike {
  return { name, raw, ...modifiers };
}

const templates = [
  {
    name: "review",
    description: "Review the current changes",
    argumentHint: "[path]",
    mode: "work" as const,
  },
];

function entries(running = false): PaletteEntry[] {
  return paletteEntries(TUI_COMMANDS, { commands: templates, running });
}

function documented(running = false): PaletteEntry[] {
  return documentEntries(TUI_COMMANDS, { commands: templates, running });
}

test("registry ids and slash names/aliases are unique", () => {
  const ids = TUI_COMMANDS.map((command) => command.id);
  assert.equal(new Set(ids).size, ids.length);
  const slashNames = TUI_COMMANDS.flatMap((command) => [
    ...(command.slash === undefined ? [] : [command.slash]),
    ...(command.slashAliases ?? []),
  ]);
  assert.equal(new Set(slashNames).size, slashNames.length);
  assert.deepEqual(COMMAND_GROUPS.at(-1), "Slash commands");
});

test("formatChord and formatKeys derive canonical labels", () => {
  assert.equal(formatChord({ name: "p", ctrl: true }), "Ctrl+P");
  assert.equal(formatChord({ name: "return", shift: true }), "Shift+Enter");
  assert.equal(formatChord({ name: "c", ctrl: true, double: true }), "Ctrl+C ×2");
  assert.equal(formatChord({ name: "pageup" }), "PgUp");
  assert.equal(formatChord({ name: "x", alt: true, shift: true }), "Alt+Shift+X");
  assert.equal(formatKeys(findCommand(TUI_COMMANDS, "newline")!), "Shift+Enter / Ctrl+J");
});

test("matchChord makes modifiers exact without breaking shifted symbol keys", () => {
  assert.equal(matchChord({ name: "p", ctrl: true }, key("p", "\u0010", { ctrl: true })), true);
  assert.equal(matchChord({ name: "p", ctrl: true }, key("p")), false);
  assert.equal(matchChord({ name: "return" }, key("return", "\r", { shift: true })), false);
  assert.equal(matchChord({ name: "return", shift: true }, key("return", "\r")), false);
  assert.equal(matchChord({ name: "esc" }, key("escape", "\u001b")), true);
  assert.equal(matchChord({ name: "?" }, key("/", "?", { shift: true })), true);
  assert.equal(matchChord({ name: "c", ctrl: true, double: true }, key("c", "\u0003", { ctrl: true })), true);
});

test("resolveKey honors registry priority and app/overlay scopes", () => {
  assert.equal(resolveKey(TUI_COMMANDS, key("return", "\r"))?.command.id, "submit");
  assert.equal(
    resolveKey(TUI_COMMANDS, key("return", "\r", { shift: true }))?.command.id,
    "newline",
    "Shift+Enter must not be captured by plain Enter",
  );
  assert.equal(resolveKey(TUI_COMMANDS, key("p", "\u0010", { ctrl: true }))?.command.id, "palette");
  assert.equal(resolveKey(TUI_COMMANDS, key("up", "\u001b[A"))?.command.id, "history");
  assert.equal(resolveKey(TUI_COMMANDS, key("up", "\u001b[A"), "overlay")?.command.id, "list-move");
  assert.equal(resolveKey(TUI_COMMANDS, key("return", "\r"), "overlay")?.command.id, "list-accept");
  assert.equal(resolveKey(TUI_COMMANDS, key("escape", "\u001b"), "overlay")?.command.id, "list-close");
});

test("steer is one composer chord, documented once and unavailable in exclusive scopes", () => {
  const steer = findCommand(TUI_COMMANDS, "steer");
  assert.ok(steer, "the registry has a steer command");
  assert.equal(steer.when, "composer");
  assert.equal(formatKeys(steer), "Ctrl+N");
  assert.match(steer.description, /not a new task/);
  assert.equal(
    TUI_COMMANDS.filter((command) => formatKeys(command) === "Ctrl+N").length,
    1,
    "the chord is registered exactly once",
  );

  const paletteRows = entries().filter((entry) => entry.id === "steer");
  const helpRows = documented().filter((entry) => entry.id === "steer");
  assert.equal(paletteRows.length, 1, "the palette lists steer once");
  assert.equal(helpRows.length, 1, "help lists steer once");
  assert.equal(paletteRows[0]?.keys, "Ctrl+N");
  const helpText = tuiHelpLines(TUI_COMMANDS, { commands: templates }).join("\n");
  assert.equal(helpText.match(/Ctrl\+N/g)?.length, 1, "the CLI key guide spells it once");

  assert.equal(resolveKey(TUI_COMMANDS, key("n", "\u000e", { ctrl: true }))?.command.id, "steer");
  for (const context of ["overlay", "find", "mention", "approval"] as const) {
    assert.equal(
      resolveKey(TUI_COMMANDS, key("n", "\u000e", { ctrl: true }), context),
      null,
      `steer is not offered in the ${context} scope`,
    );
  }
});

test("external-edit is Ctrl+G in the composer scope, documented once and idle-only", () => {
  const command = findCommand(TUI_COMMANDS, "external-edit");
  assert.ok(command, "the registry has an external-edit command");
  assert.equal(command.group, "Composer");
  assert.equal(command.when, "composer");
  assert.equal(command.idleOnly, true);
  assert.equal(formatKeys(command), "Ctrl+G");
  assert.equal(
    TUI_COMMANDS.filter((entry) => formatKeys(entry) === "Ctrl+G").length,
    1,
    "the chord is registered exactly once",
  );

  assert.equal(
    resolveKey(TUI_COMMANDS, key("g", "\u0007", { ctrl: true }))?.command.id,
    "external-edit",
  );
  for (const context of ["overlay", "find", "mention", "approval"] as const) {
    assert.equal(
      resolveKey(TUI_COMMANDS, key("g", "\u0007", { ctrl: true }), context),
      null,
      `external-edit is not offered in the ${context} scope`,
    );
  }

  const paletteRows = entries().filter((entry) => entry.id === "external-edit");
  const helpRows = documented().filter((entry) => entry.id === "external-edit");
  assert.equal(paletteRows.length, 1, "the palette lists external-edit once");
  assert.equal(helpRows.length, 1, "help lists external-edit once");
  assert.equal(paletteRows[0]?.keys, "Ctrl+G");
  assert.equal(paletteRows[0]?.disabled, false);
  assert.equal(
    entries(true).find((entry) => entry.id === "external-edit")?.disabled,
    true,
    "the palette disables it while a turn runs",
  );
  const helpText = tuiHelpLines(TUI_COMMANDS, { commands: templates }).join("\n");
  assert.equal(helpText.match(/Ctrl\+G/g)?.length, 1, "the CLI key guide spells it once");
});

test("command lookup, slash aliases and running guards use registry metadata", () => {
  assert.equal(findCommand(TUI_COMMANDS, "help")?.title, "Keyboard help");
  assert.equal(findCommand(TUI_COMMANDS, "missing"), undefined);
  assert.equal(findSlashCommand(TUI_COMMANDS, "HELP")?.id, "help");
  assert.equal(findSlashCommand(TUI_COMMANDS, "h")?.id, "help");
  assert.equal(findSlashCommand(TUI_COMMANDS, "q")?.id, "exit");
  assert.equal(findSlashCommand(TUI_COMMANDS, "unknown"), null);

  const models = findCommand(TUI_COMMANDS, "models")!;
  assert.equal(isCommandEnabled(models), true);
  assert.equal(isCommandEnabled(models, { running: true }), false);
  assert.equal(isCommandEnabled(findCommand(TUI_COMMANDS, "help")!, { running: true }), true);
});

test("palette/help entries merge templates and disable idle-only actions", () => {
  const running = entries(true);
  const models = running.find((entry) => entry.id === "models")!;
  const help = running.find((entry) => entry.id === "help")!;
  const template = running.find((entry) => entry.id === "template:review")!;
  assert.equal(models.disabled, true);
  assert.match(models.disabledReason, /while a turn is running/);
  assert.equal(help.disabled, false);
  assert.equal(template.kind, "slash-template");
  assert.equal(template.slash, "/review");
  assert.equal(template.argumentHint, "[path]");
  assert.equal(template.mode, "work");
  assert.equal(template.group, "Slash commands");
  assert.ok(documented().some((entry) => entry.id === "submit"));
  assert.ok(!entries().some((entry) => entry.id === "submit"));
});

test("CLI help and list hints are generated from the same registry", () => {
  const text = tuiHelpLines(TUI_COMMANDS, { commands: templates }).join("\n");
  assert.match(text, /Ctrl\+P\s+Search every command/);
  assert.match(text, /Shift\+Enter \/ Ctrl\+J/);
  assert.match(text, /\/mode consult\|work/);
  assert.match(text, /\/review \[path\]\s+Review the current changes/);
  assert.equal(
    hintSegments(TUI_COMMANDS, [
      { id: "list-move", label: "move" },
      { id: "list-accept", label: "select" },
      { id: "list-close", label: "close" },
      { id: "missing", label: "skip" },
    ]),
    "Up / Down move · Enter select · Esc close",
  );
  assert.equal(paletteHints(TUI_COMMANDS), "Up / Down move · Enter select · Esc close");
  assert.match(helpHints(TUI_COMMANDS), /type to filter$/);
});

test("filtering is case-insensitive, multi-token and exact/prefix ranked", () => {
  const all = entries();
  assert.deepEqual(filterPaletteEntries(all, "  "), all);
  assert.ok(filterPaletteEntries(all, "MODELS SENIOR").some((entry) => entry.id === "models"));
  assert.equal(filterPaletteEntries(all, "definitely-no-match").length, 0);
  const filtered = filterPaletteEntries(all, "mode");
  assert.equal(filtered[0]?.id, "mode");
  assert.ok(filtered.every((entry) =>
    [entry.title, entry.description, entry.group, entry.keys, entry.slash, entry.argumentHint, entry.mode]
      .join(" ").toLowerCase().includes("mode"),
  ));
});

test("selection state clamps, wraps and identifies the highlighted entry", () => {
  const empty = createPaletteState();
  assert.deepEqual(empty, { query: "", selected: 0 });
  assert.deepEqual(setPaletteQuery(empty, "mode"), { query: "mode", selected: 0 });
  assert.equal(movePaletteSelection({ query: "", selected: 0 }, -1, 3).selected, 2);
  assert.equal(movePaletteSelection({ query: "", selected: 2 }, 1, 3).selected, 0);
  assert.equal(movePaletteSelection({ query: "", selected: 100 }, 0, 3).selected, 2);
  assert.equal(movePaletteSelection({ query: "", selected: 1 }, 1, 0).selected, 0);
  assert.equal(selectedPaletteEntry({ query: "", selected: 1 }, entries())?.id, "help");
  assert.equal(selectedPaletteEntry(empty, []), undefined);
  assert.equal(windowStart(20, 10, 5), 8);
  assert.equal(windowStart(20, 0, 5), 0);
  assert.equal(windowStart(20, 19, 5), 15);
  assert.equal(windowStart(3, 1, 5), 0);
});

test("printable filtering and Backspace operate on graphemes", () => {
  assert.equal(printableKeyText(key("x")), "x");
  assert.equal(printableKeyText(key("return", "\r")), null);
  assert.equal(printableKeyText(key("up", "\u001b[A")), null);
  assert.equal(printableKeyText(key("c", "\u0003", { ctrl: true })), null);
  assert.equal(printableKeyText(key("x", "x", { alt: true })), null);
  assert.equal(printableKeyText(key("paste", "a\nb")), null);
  assert.equal(dropLastGrapheme("ab👨‍👩‍👧‍👦"), "ab");
});

test("palette key handling filters, moves within filtered rows and accepts the visible entry", () => {
  const all = entries();
  const typed = handlePaletteKey(TUI_COMMANDS, createPaletteState(), key("m"), all);
  assert.equal(typed.action, "filter");
  assert.equal(typed.state.query, "m");

  const state = { query: "models", selected: 0 };
  const accepted = handlePaletteKey(TUI_COMMANDS, state, key("return", "\r"), all);
  assert.equal(accepted.action, "accept");
  assert.equal(accepted.entry?.id, "models", "selection must index the filtered list");

  const query = "e";
  const count = filterPaletteEntries(all, query).length;
  const moved = handlePaletteKey(TUI_COMMANDS, { query, selected: 0 }, key("up", "\u001b[A"), all);
  assert.equal(moved.action, "move");
  assert.equal(moved.state.selected, count - 1);

  const erased = handlePaletteKey(
    TUI_COMMANDS,
    { query: "e\u0301", selected: 4 },
    key("backspace", "\u007f"),
    all,
  );
  assert.deepEqual(erased.state, { query: "", selected: 0 });
});

test("palette refuses disabled commands and closes through registry chords", () => {
  const blocked = handlePaletteKey(
    TUI_COMMANDS,
    { query: "models", selected: 0 },
    key("return", "\r"),
    entries(true),
  );
  assert.equal(blocked.action, "blocked");
  assert.equal(blocked.entry?.id, "models");
  assert.match(blocked.reason ?? "", /running/);
  assert.equal(
    handlePaletteKey(TUI_COMMANDS, createPaletteState(), key("escape", "\u001b"), entries()).action,
    "close",
  );
  assert.equal(
    handlePaletteKey(TUI_COMMANDS, createPaletteState(), key("p", "\u0010", { ctrl: true }), entries()).action,
    "close",
  );
});

test("palette renders exact geometry at wide, narrow and degenerate sizes", () => {
  for (const width of [0, 1, 2, 10, 20, 30, 60, 100]) {
    for (const height of [0, 1, 2, 3, 6, 12]) {
      const view = paletteView(TUI_COMMANDS, createPaletteState(), entries(), { width, height });
      assert.equal(view.lines.length, height, `height ${height}`);
      for (const row of view.lines) {
        assert.equal(displayWidth(row), width, `width ${width}: ${JSON.stringify(row)}`);
        assert.ok(!row.includes("\u001b"));
      }
      assert.deepEqual(renderPalette(TUI_COMMANDS, createPaletteState(), entries(), { width, height }), view.lines);
    }
  }
});

test("palette viewport keeps selection visible and exposes no-match/empty states", () => {
  const state = { query: "", selected: 8 };
  const view = paletteView(TUI_COMMANDS, state, entries(), { width: 80, height: 6 });
  assert.equal(view.visible.length, 3);
  assert.equal(view.visible.some((entry) => entry.id === entries()[8]?.id), true);
  assert.equal(view.selectedRow, 3);
  assert.equal(view.lines[view.selectedRow]?.startsWith("› "), true);

  const noMatch = paletteView(TUI_COMMANDS, { query: "no such command", selected: 0 }, entries(), {
    width: 40,
    height: 6,
  });
  assert.equal(noMatch.noMatch, true);
  assert.equal(noMatch.selectedRow, -1);
  assert.match(noMatch.lines[2], /No matches/);

  const empty = paletteView(TUI_COMMANDS, createPaletteState(), [], { width: 40, height: 5 });
  assert.match(empty.lines[2], /No commands available/);
});

test("shared view measurement is grapheme/EAW aware", () => {
  assert.equal(viewTextWidth("你e\u0301😀"), 5);
  assert.equal(viewTruncate("你好世界", 5), "你好…");
  assert.equal(viewTextWidth(viewPad("你😀", 7)), 7);
});

test("help groups entries in registry order and supports filtered selection", () => {
  const all = documented();
  const groups = groupHelpEntries(all);
  assert.deepEqual(groups.map((group) => group.group), COMMAND_GROUPS.filter((group) =>
    all.some((entry) => entry.group === group),
  ));
  const ordered = orderedHelpEntries(all);
  assert.equal(ordered[0]?.group, "General");
  assert.equal(ordered.at(-1)?.id, "template:review");
  assert.equal(selectedHelpEntry({ query: "", selected: 0 }, ordered)?.id, "palette");
  assert.equal(setHelpQuery(createHelpState(), "mode").selected, 0);
  assert.equal(moveHelpSelection({ query: "", selected: 0 }, -1, 2).selected, 1);
  assert.deepEqual(filterHelpEntries(all, "models"), filterPaletteEntries(all, "models"));
  assert.equal(helpEntries(TUI_COMMANDS, { commands: templates }).length, documented().length);
});

test("help key handling accepts only the filtered, enabled row", () => {
  const all = documented();
  const accepted = handleHelpKey(
    TUI_COMMANDS,
    { query: "models", selected: 0 },
    key("return", "\r"),
    all,
  );
  assert.equal(accepted.action, "accept");
  assert.equal(accepted.entry?.id, "models");

  const blocked = handleHelpKey(
    TUI_COMMANDS,
    { query: "models", selected: 0 },
    key("return", "\r"),
    documented(true),
  );
  assert.equal(blocked.action, "blocked");
  assert.equal(blocked.entry?.id, "models");

  const moved = handleHelpKey(
    TUI_COMMANDS,
    { query: "models", selected: 0 },
    key("up", "\u001b[A"),
    all,
  );
  assert.equal(moved.action, "move");
  assert.equal(moved.state.selected, 0);
  assert.equal(
    handleHelpKey(TUI_COMMANDS, createHelpState(), key("escape", "\u001b"), all).action,
    "close",
  );
});

test("help renders exact geometry, grouped rows and empty/no-match views", () => {
  for (const width of [0, 1, 12, 24, 40, 64, 100]) {
    for (const height of [0, 1, 2, 3, 8, 16]) {
      const view = helpView(TUI_COMMANDS, createHelpState(), documented(), { width, height });
      assert.equal(view.lines.length, height);
      for (const row of view.lines) assert.equal(displayWidth(row), width);
      assert.deepEqual(renderHelp(TUI_COMMANDS, createHelpState(), documented(), { width, height }), view.lines);
    }
  }

  const grouped = helpView(TUI_COMMANDS, createHelpState(), documented(), { width: 80, height: 16 });
  assert.ok(grouped.lines.some((row) => row.includes("[General]")));
  assert.ok(grouped.selectedRow >= 2);

  const noMatch = helpView(TUI_COMMANDS, { query: "nothing-here", selected: 0 }, documented(), {
    width: 50,
    height: 7,
  });
  assert.equal(noMatch.noMatch, true);
  assert.match(noMatch.lines[2], /No matches/);
  const empty = helpView(TUI_COMMANDS, createHelpState(), [], { width: 50, height: 5 });
  assert.match(empty.lines[2], /No commands registered/);
});

test("agents is an app-scope Ctrl+Y command, listed once and resolvable as /agents", () => {
  const command = findCommand(TUI_COMMANDS, "agents");
  assert.ok(command, "the registry has an agents command");
  assert.equal(command.group, "Cooperation");
  assert.equal(command.when, "app");
  assert.equal(command.idleOnly, undefined, "the helper list opens while a turn runs");
  assert.equal(formatKeys(command), "Ctrl+Y");
  assert.equal(
    TUI_COMMANDS.filter((entry) => formatKeys(entry) === "Ctrl+Y").length,
    1,
    "the chord is registered exactly once",
  );
  assert.equal(
    isCommandEnabled(command, { running: true }),
    true,
    "idle-only commands are refused mid-turn; agents is not one",
  );
  assert.equal(findSlashCommand(TUI_COMMANDS, "agents")?.id, "agents");
  assert.equal(resolveKey(TUI_COMMANDS, key("y", "\u0019", { ctrl: true }))?.command.id, "agents");
  for (const context of ["overlay", "find", "mention", "approval"] as const) {
    assert.equal(
      resolveKey(TUI_COMMANDS, key("y", "\u0019", { ctrl: true }), context),
      null,
      `agents is not offered in the ${context} scope`,
    );
  }

  const paletteRows = entries().filter((entry) => entry.id === "agents");
  const helpRows = documented().filter((entry) => entry.id === "agents");
  assert.equal(paletteRows.length, 1, "the palette lists helpers once");
  assert.equal(helpRows.length, 1, "help lists helpers once");
  assert.equal(paletteRows[0]?.keys, "Ctrl+Y");
  assert.equal(paletteRows[0]?.slash, "/agents");
  assert.equal(entries(true).find((entry) => entry.id === "agents")?.disabled, false);
  const helpText = tuiHelpLines(TUI_COMMANDS, { commands: templates }).join("\n");
  assert.equal(helpText.match(/Ctrl\+Y/g)?.length, 1, "the CLI key guide spells it once");
});

test("helper-scroll is overlay-scope PgUp/PgDn and never shadows transcript scrolling", () => {
  const command = findCommand(TUI_COMMANDS, "helper-scroll");
  assert.ok(command, "the registry has a helper-scroll command");
  assert.equal(command.group, "Lists");
  assert.equal(command.when, "overlay");
  assert.equal(formatKeys(command), "PgUp / PgDn");
  assert.equal(paletteEntries(TUI_COMMANDS).some((entry) => entry.id === "helper-scroll"), false);
  assert.ok(documentEntries(TUI_COMMANDS).some((entry) => entry.id === "helper-scroll"));

  assert.equal(
    resolveKey(TUI_COMMANDS, key("pageup", "\u001b[5~"), "overlay")?.command.id,
    "helper-scroll",
  );
  assert.equal(
    resolveKey(TUI_COMMANDS, key("pagedown", "\u001b[6~"), "overlay")?.command.id,
    "helper-scroll",
  );
  // In the app scope the page keys keep paging the transcript.
  assert.equal(resolveKey(TUI_COMMANDS, key("pageup", "\u001b[5~"))?.command.id, "scroll");
  // No other overlay command claims the page keys.
  const overlayChords = TUI_COMMANDS.filter((entry) => (entry.when ?? "always") === "overlay")
    .flatMap((entry) => formatKeys(entry) === "PgUp / PgDn" ? [entry.id] : []);
  assert.deepEqual(overlayChords, ["helper-scroll"]);
});
