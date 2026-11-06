/**
 * TUI inline `/` command picker and `@skill:` mention picker suite.
 *
 * Pure trigger detection, catalog composition, filtering/selection, the
 * registry-driven key reducer, width-exact rendering, the submit-time
 * `@skill:` validation plan, and two fake-TTY app tests: the `/` picker
 * inserting a token (while an exactly typed command still submits) and a
 * `@skill:` submit injecting one `<skill-loaded>` envelope into the session
 * before the turn — plus the refusal path for unknown/role-scoped skills.
 *
 * Run with: node --test tests/tuipicker.test.ts
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { resolveConfig } from "../src/config.ts";
import { renderSkillLoadedBlock } from "../src/mentions.ts";
import type { Skill, SkillCatalog, SkillScope } from "../src/skills.ts";
import { runTuiApp, resolveSkillMentions, type TuiAppOptions } from "../src/tui/app.ts";
import { createEditor, replaceTextRange } from "../src/tui/editor.ts";
import {
  TUI_COMMANDS,
  type KeyLike,
  type SlashCommandInfo,
} from "../src/tui/keymap.ts";
import { ANSI } from "../src/tui/render.ts";
import { stripAnsi } from "../src/tui/screen.ts";
import { displayWidth } from "../src/tui/text.ts";
import { plainTheme } from "../src/tui/theme.ts";
import {
  commandMentionItems,
  detectMentionTrigger,
  filterMentionPickerItems,
  mentionPickerGroups,
  mentionPickerHints,
  mentionPickerKey,
  mentionPickerView,
  moveMentionPickerSelection,
  openMentionPicker,
  renderMentionPicker,
  selectMentionPicker,
  skillMentionItems,
  updateMentionPicker,
  type MentionPickerCatalogs,
  type MentionPickerState,
} from "../src/tui/view/mentionpicker.ts";

const TEMPLATES: SlashCommandInfo[] = [
  { name: "review", description: "Review the current changes", argumentHint: "[path]" },
  { name: "deploy", description: "Ship the current workspace" },
];

function skill(
  name: string,
  scope: SkillScope,
  description: string,
  body = `Body of ${name}.`,
): Skill {
  return { name, description, scope, tools: [], file: `/tmp/skills/${name}/SKILL.md`, body };
}

function catalog(...skills: Skill[]): SkillCatalog {
  return { skills, diagnostics: [] };
}

function key(name: string, raw = name, modifiers: Partial<KeyLike> = {}): KeyLike {
  return { name, raw, ...modifiers };
}

function typed(state: MentionPickerState, text: string, step: (current: MentionPickerState, char: string) => MentionPickerState): MentionPickerState {
  let next = state;
  for (const char of text) next = step(next, char);
  return next;
}

/** Fold one keypress: filter state from the reducer, trigger refreshed by hand. */
function typeInto(state: MentionPickerState, text: string): MentionPickerState {
  return typed(state, text, (current, char) => {
    const result = mentionPickerKey(TUI_COMMANDS, current, key(char));
    return updateMentionPicker(result.state, result.state.query);
  });
}

const COMMAND_CATALOGS: MentionPickerCatalogs = { templates: TEMPLATES };

// --------------------------------------------------------------------------- //
// trigger detection
// --------------------------------------------------------------------------- //

test("command trigger fires at the composer start and after line-leading whitespace only", () => {
  const start = detectMentionTrigger("/mo");
  assert.ok(start);
  assert.equal(start.kind, "command");
  assert.equal(start.start, 0);
  assert.equal(start.end, 3);
  assert.equal(start.query, "mo");
  assert.equal(start.token, "/mo");

  const indented = detectMentionTrigger("first line\n   /th", 17);
  assert.ok(indented);
  assert.equal(indented.start, 14);
  assert.equal(indented.end, 17);
  assert.equal(indented.query, "th");

  // `/` inside a word or a non-whitespace line prefix is ordinary text.
  assert.equal(detectMentionTrigger("path/to"), null);
  assert.equal(detectMentionTrigger("a/b"), null);
  assert.equal(detectMentionTrigger("x /mode"), null, "not at a line start");

  // Arguments close the picker: the token is no longer a bare slash name.
  const withArgs = detectMentionTrigger("/mode work", 10);
  assert.equal(withArgs, null);

  // A caret inside the token still reports the whole token for replacement.
  const interior = detectMentionTrigger("/theme x", 4);
  assert.ok(interior);
  assert.equal(interior.start, 0);
  assert.equal(interior.end, 6, "the suffix is replaced as one token");
  assert.equal(interior.query, "the");
});

test("skill trigger fires at token boundaries with an optional skill: prefix", () => {
  const bare = detectMentionTrigger("use @cod");
  assert.ok(bare);
  assert.equal(bare.kind, "skill");
  assert.equal(bare.start, 4);
  assert.equal(bare.end, 8);
  assert.equal(bare.query, "cod");

  const prefixed = detectMentionTrigger("@skill:check", 12);
  assert.ok(prefixed);
  assert.equal(prefixed.start, 0);
  assert.equal(prefixed.query, "check");
  assert.equal(prefixed.token, "@skill:check");

  const empty = detectMentionTrigger("@");
  assert.ok(empty);
  assert.equal(empty.kind, "skill");
  assert.equal(empty.query, "");

  // Emails/handles inside a word are not mentions; `@` alone at a boundary is.
  assert.equal(detectMentionTrigger("mail me@example.com"), null);
  assert.equal(detectMentionTrigger("see @rel/path"), null, "skill tokens have no slash");
  assert.equal(detectMentionTrigger("a @ b", 4), null, "the space after @ ends the token");

  // A caret in the middle still reports the whole token for replacement.
  const middle = detectMentionTrigger("@skill:checklist rest", 8);
  assert.ok(middle);
  assert.equal(middle.start, 0);
  assert.equal(middle.end, 16);
  assert.equal(middle.query, "c");

  // Never throws on hostile input and clamps the caret.
  assert.equal(detectMentionTrigger("", 99), null);
  assert.equal(detectMentionTrigger("@\u0000x", 99), null, "a control byte ends the token");
  assert.equal(detectMentionTrigger("plain text", -5), null);
});

// --------------------------------------------------------------------------- //
// catalog composition and filtering
// --------------------------------------------------------------------------- //

test("command rows merge registry slash names, aliases and discovered templates", () => {
  const items = commandMentionItems(TUI_COMMANDS, TEMPLATES);
  const byName = new Map(items.map((item) => [item.name, item]));
  for (const name of [
    "help",
    "commands",
    "mode",
    "models",
    "sessions",
    "theme",
    "settings",
    "retry",
    "find",
    "panel",
    "stash",
    "exit",
  ]) {
    const item = byName.get(name);
    assert.ok(item, `missing built-in /${name}`);
    assert.equal(item.title, `/${name}`);
    assert.equal(item.insert, `/${name} `, "insert always leaves a trailing space");
    assert.equal(item.kind, "command");
    assert.equal(item.group, "TUI commands");
  }
  // Aliases are separately selectable rows that point at their command.
  assert.equal(byName.get("q")?.insert, "/q ");
  assert.equal(byName.get("quit")?.aliasOf, "/exit");
  assert.equal(byName.get("h")?.aliasOf, "/help");

  // Discovered templates are merged with their argument hints.
  const review = byName.get("review");
  assert.ok(review);
  assert.equal(review.group, "Slash commands");
  assert.equal(review.argumentHint, "[path]");
  assert.equal(review.insert, "/review ");
  assert.ok(byName.has("deploy"));
});

test("skill rows are shared-first and role-scoped rows are visible but disabled", () => {
  const items = skillMentionItems([
    skill("alpha", "shared", "Shared alpha"),
    skill("beta", "junior", "Junior beta"),
    skill("gamma", "senior", "Senior gamma"),
  ]);
  assert.deepEqual(items.map((item) => item.name), ["alpha", "beta", "gamma"]);
  assert.equal(items[0]?.group, "Shared skills");
  assert.equal(items[0]?.disabled, undefined);
  assert.equal(items[0]?.insert, "@skill:alpha ");
  const beta = items[1];
  assert.ok(beta);
  assert.equal(beta.group, "Role-scoped skills");
  assert.equal(beta.disabled, true);
  assert.equal(beta.scope, "junior");
  assert.match(beta.disabledReason ?? "", /junior-scoped skill/);
  assert.ok(items.every((item) => item.insert.endsWith(" ")));
});

test("filtering is case-insensitive over name, description and hint, with prefix ranking", () => {
  const items = commandMentionItems(TUI_COMMANDS, TEMPLATES);
  assert.equal(filterMentionPickerItems(items, "").length, items.length);
  assert.deepEqual(filterMentionPickerItems(items, "THEME").map((item) => item.name), ["theme"]);
  assert.deepEqual(filterMentionPickerItems(items, "review path").map((item) => item.name), ["review"]);
  // Exact/prefix name matches rank before description-only matches.
  const ranked = filterMentionPickerItems(items, "retry");
  assert.equal(ranked[0]?.name, "retry");
  assert.deepEqual(filterMentionPickerItems(items, "no-such-thing"), []);
  // Disabled rows stay visible for an explicit blocked message.
  const skills = skillMentionItems([skill("secret", "senior", "senior only")]);
  assert.equal(filterMentionPickerItems(skills, "secret")[0]?.disabled, true);
});

test("picker state opens, updates, moves with wrap and reports its selection", () => {
  const state = openMentionPicker("command", "the", COMMAND_CATALOGS, { start: 0, end: 4 });
  assert.equal(state.open, true);
  assert.equal(state.kind, "command");
  assert.equal(state.query, "the");
  assert.deepEqual(state.trigger, { start: 0, end: 4 });
  assert.ok(state.items.length > 0);
  const filtered = filterMentionPickerItems(state.items, state.query);
  assert.equal(selectMentionPicker(state)?.name, filtered[0]?.name);

  const movedDown = moveMentionPickerSelection(state, 1, filtered.length);
  assert.equal(movedDown.active, 1);
  assert.equal(moveMentionPickerSelection(movedDown, -2, filtered.length).active, filtered.length - 1);
  assert.equal(moveMentionPickerSelection(state, 1, 0).active, 0);

  const updated = updateMentionPicker(state, "exit", { start: 2, end: 9 });
  assert.equal(updated.query, "exit");
  assert.equal(updated.active, 0);
  assert.equal(updated.trigger.start, 2);
  assert.equal(updated.items, state.items);
});

test("registry keys move, insert and close; disabled rows are blocked", () => {
  const rawSkills = [
    skill("alpha", "shared", "shared one"),
    skill("secret", "senior", "senior only"),
  ];
  const state = openMentionPicker("skill", "", { skills: rawSkills });
  const down = mentionPickerKey(TUI_COMMANDS, state, key("down", "\u001b[B"));
  assert.equal(down.action, "move");
  assert.equal(down.state.active, 1);
  const enter = mentionPickerKey(TUI_COMMANDS, down.state, key("return", "\r"));
  assert.equal(enter.action, "blocked");
  assert.match(enter.reason ?? "", /senior-scoped/);
  const tab = mentionPickerKey(TUI_COMMANDS, state, key("tab", "\t"));
  assert.equal(tab.action, "accept");
  assert.equal(tab.item?.name, "alpha");
  assert.equal(tab.chordName, "tab");

  const wrappedUp = mentionPickerKey(TUI_COMMANDS, state, key("up", "\u001b[A"));
  assert.equal(wrappedUp.action, "move");
  assert.equal(wrappedUp.state.active, 1, "wrap to the last row");

  assert.equal(
    mentionPickerKey(TUI_COMMANDS, state, key("escape", "\u001b")).action,
    "close",
  );
  assert.equal(
    mentionPickerKey(TUI_COMMANDS, state, key("p", "\u0010", { ctrl: true })).action,
    "none",
    "app chords are not routable from the picker scope",
  );

  const empty = openMentionPicker("command", "no-such-command", COMMAND_CATALOGS);
  assert.equal(mentionPickerKey(TUI_COMMANDS, empty, key("return", "\r")).action, "none");

  const filtering = mentionPickerKey(TUI_COMMANDS, state, key("a"));
  assert.equal(filtering.action, "filter");
  assert.equal(filtering.state.query, "a");
  const erased = mentionPickerKey(TUI_COMMANDS, filtering.state, key("backspace", "\u007f"));
  assert.equal(erased.action, "filter");
  assert.equal(erased.state.query, "");
  assert.equal(mentionPickerKey(TUI_COMMANDS, { ...state, open: false }, key("return", "\r")).action, "none");
});

// --------------------------------------------------------------------------- //
// rendering
// --------------------------------------------------------------------------- //

test("picker rows are width-exact, plain by default and carry the active marker", () => {
  const state = openMentionPicker("command", "th", COMMAND_CATALOGS);
  for (const width of [0, 1, 10, 20, 40, 60, 80, 120]) {
    const view = mentionPickerView(state, { width });
    for (const line of view.lines) {
      assert.equal(displayWidth(line), width, `width ${width}: ${JSON.stringify(line)}`);
      assert.ok(!line.includes("\u001b"), "NO_COLOR output leaks no ANSI");
    }
    if (width === 0) {
      assert.deepEqual(view.lines, []);
      continue;
    }
    assert.ok(view.lines.length > 0);
    assert.ok(view.lines.length <= 8, "row budget is bounded");
    if (width >= 30) {
      assert.match(view.lines[0] ?? "", /COMMANDS \(\d+\)/);
      assert.match(view.lines[0] ?? "", /filter: th/);
    }
    if (width >= 40) {
      assert.ok(view.lines.join("\n").includes("Enter / Tab insert"));
    }
    if (width >= 60) {
      assert.ok(view.lines.join("\n").includes("Esc close"));
    }
  }

  const view = mentionPickerView(state, { width: 80 });
  assert.ok(view.selectedRow > 0);
  assert.ok((view.lines[view.selectedRow] ?? "").startsWith("› "));
  assert.ok(view.lines.join("\n").includes("/theme"));
  assert.ok(view.lines.join("\n").includes("— "), "wide rows carry the description");

  const narrow = mentionPickerView(state, { width: 30 });
  const narrowItemRows = narrow.lines.filter(
    (line) => line.startsWith("› ") || /^ {2}\/[a-z]/.test(line),
  );
  for (const row of narrowItemRows) {
    assert.ok(!row.includes("— "), `narrow item rows drop descriptions: ${JSON.stringify(row)}`);
  }
  assert.equal(renderMentionPicker(state, 40).length, mentionPickerView(state, { width: 40 }).lines.length);
  assert.equal(renderMentionPicker({ ...state, open: false }, 40).length, 0);
  assert.equal(
    mentionPickerHints(TUI_COMMANDS),
    "Up / Down move · Enter / Tab insert · Esc close · Shift+Tab dismiss · type to filter",
  );
});

test("skill picker renders scope-disabled rows and the shared-only note", () => {
  const state = openMentionPicker("skill", "", {
    skills: [
      skill("checklist", "shared", "Check tests first"),
      skill("secret", "senior", "Senior only"),
    ],
  });
  const view = mentionPickerView(state, { width: 80 });
  const text = view.lines.join("\n");
  assert.match(text, /SKILLS \(2\)/);
  assert.ok(text.includes("@skill:checklist"));
  assert.ok(text.includes("[senior]"), "the role scope is shown");
  assert.ok(text.includes("[unavailable]"));
  assert.ok(text.includes("Only shared skills can be @mentioned by the operator."));
  assert.ok(text.includes("[Shared skills]"));
  assert.ok(text.includes("[Role-scoped skills]"));
  for (const line of view.lines) assert.equal(displayWidth(line), 80);
});

test("no-match, empty and windowed picker states stay honest and width-safe", () => {
  const noMatch = mentionPickerView(openMentionPicker("command", "zzz", COMMAND_CATALOGS), {
    width: 50,
  });
  assert.equal(noMatch.noMatch, true);
  assert.equal(noMatch.selectedRow, -1);
  assert.match(noMatch.lines.join("\n"), /No commands match "zzz"/);

  const empty = mentionPickerView(openMentionPicker("skill", "", { skills: [] }), { width: 50 });
  assert.equal(empty.noMatch, true);
  assert.match(empty.lines.join("\n"), /No skills discovered/);

  const emptyCommands = mentionPickerView(openMentionPicker("command", "", { commands: [] }), {
    width: 50,
  });
  assert.match(emptyCommands.lines.join("\n"), /No slash commands registered/);

  // A long template list is windowed around the selection instead of flooding.
  const templates: SlashCommandInfo[] = Array.from({ length: 30 }, (_, index) => ({
    name: `cmd-${index}`,
    description: `Template ${index}`,
  }));
  const state = moveMentionPickerSelection(
    openMentionPicker("command", "", { templates }),
    25,
    filterMentionPickerItems(commandMentionItems(TUI_COMMANDS, templates), "").length,
  );
  const view = mentionPickerView(state, { width: 60, maxRows: 8 });
  assert.ok(view.lines.length <= 8);
  assert.ok(view.selectedRow > 0);
  assert.ok((view.lines[view.selectedRow] ?? "").includes("›"), "the selection stays visible");
  const selected = filterMentionPickerItems(state.items, state.query)[state.active];
  assert.ok(view.lines.join("\n").includes(selected?.title ?? ""));
  assert.deepEqual(mentionPickerGroups(view.visible), ["Slash commands"]);
});

// --------------------------------------------------------------------------- //
// editor range replacement
// --------------------------------------------------------------------------- //

test("replaceTextRange swaps the trigger token and leaves the caret after it", () => {
  const editor = createEditor("  /th");
  assert.equal(editor.cursor, 5);
  const replaced = replaceTextRange(editor, 2, 5, "/theme ");
  assert.equal(replaced.text, "  /theme ");
  assert.equal(replaced.cursor, 9, "caret sits after the trailing space");

  const suffixed = replaceTextRange(
    { ...createEditor("/theme now"), cursor: 3 },
    0,
    6,
    "/theme ",
  );
  assert.equal(suffixed.text, "/theme  now", "the token is replaced, the rest is kept");

  const clamped = replaceTextRange(createEditor("@"), -4, 99, "@skill:x ");
  assert.equal(clamped.text, "@skill:x ");
  assert.equal(clamped.cursor, 9);
});

// --------------------------------------------------------------------------- //
// submit-time @skill validation plan
// --------------------------------------------------------------------------- //

test("a valid shared mention yields the exact <skill-loaded> message bytes", () => {
  const skills = catalog(
    skill("checklist", "shared", "Check tests", "Always check the tests first."),
    skill("notes", "shared", "Take notes", "Write short notes."),
  );
  const task = "@skill:checklist @skill:notes please do the work @rel/path stays literal";
  const resolution = resolveSkillMentions(task, skills);
  assert.equal(resolution.ok, true);
  if (!resolution.ok) return;
  assert.deepEqual(resolution.plan.names, ["checklist", "notes"]);
  assert.equal(resolution.plan.blocks.length, 2);
  assert.equal(
    resolution.plan.blocks[0],
    `<skill-loaded name="checklist">\nAlways check the tests first.\n</skill-loaded>`,
  );
  assert.equal(resolution.plan.blocks[1], renderSkillLoadedBlock("notes", "Write short notes."));
  assert.equal(
    resolution.plan.totalChars,
    resolution.plan.blocks.reduce((total, block) => total + block.length, 0),
  );

  // Duplicate mentions attach once; file mentions never become blocks.
  const deduped = resolveSkillMentions("@skill:checklist again @skill:checklist", skills);
  assert.equal(deduped.ok, true);
  if (deduped.ok) assert.deepEqual(deduped.plan.names, ["checklist"]);

  const filesOnly = resolveSkillMentions("look at @src/a.ts and @notes/b.md", skills);
  assert.equal(filesOnly.ok, true);
  if (filesOnly.ok) assert.deepEqual(filesOnly.plan, { names: [], blocks: [], totalChars: 0 });

  const noMentions = resolveSkillMentions("just a task", skills);
  assert.equal(noMentions.ok, true);
  if (noMentions.ok) assert.deepEqual(noMentions.plan.blocks, []);
});

test("unknown, role-scoped and oversized mention sets are refused with reasons", () => {
  const skills = catalog(
    skill("checklist", "shared", "Check tests"),
    skill("secret", "senior", "Senior only"),
    skill("junior-only", "junior", "Junior only"),
    skill("alpha", "shared", "A"),
    skill("beta", "shared", "B"),
    skill("gamma", "shared", "C"),
  );

  const unknown = resolveSkillMentions("@skill:nope do it", skills);
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.match(unknown.errors.join("\n"), /unknown skill: @skill:nope/);

  const scoped = resolveSkillMentions("@skill:secret do it", skills);
  assert.equal(scoped.ok, false);
  if (!scoped.ok) assert.match(scoped.errors.join("\n"), /senior-scoped; only shared skills/);

  const tooMany = resolveSkillMentions(
    "@skill:alpha @skill:beta @skill:gamma @skill:checklist",
    skills,
  );
  assert.equal(tooMany.ok, false);
  if (!tooMany.ok) assert.match(tooMany.errors.join("\n"), /too many skill mentions \(4\)/);

  // The total attached-content cap is enforced even for at most three skills.
  const huge = catalog(
    skill("h1", "shared", "h1", "x".repeat(40_000)),
    skill("h2", "shared", "h2", "y".repeat(40_000)),
    skill("h3", "shared", "h3", "z".repeat(40_000)),
  );
  const oversized = resolveSkillMentions("@skill:h1 @skill:h2 @skill:h3", huge);
  assert.equal(oversized.ok, false);
  if (!oversized.ok) assert.match(oversized.errors.join("\n"), /too large/);
});

// --------------------------------------------------------------------------- //
// assembled app (fake TTY streams)
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

  key(name: string, modifiers: { ctrl?: boolean; shift?: boolean; raw?: string } = {}): void {
    this.emit("keypress", modifiers.raw ?? "", {
      name,
      ctrl: modifiers.ctrl === true,
      shift: modifiers.shift === true,
    });
  }

  enter(): void {
    this.key("return", { raw: "\r" });
  }

  navigate(name: "up" | "down"): void {
    this.key(name, { raw: name === "up" ? "\u001b[A" : "\u001b[B" });
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

function tmpdir(): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-tui-picker-"));
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** Write one discovered skill (`<root>/<name>/SKILL.md`) and return the root. */
function writeSkills(root: string, skills: Skill[]): string {
  const skillsRoot = path.join(root, "skills");
  for (const entry of skills) {
    const dir = path.join(skillsRoot, entry.name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "SKILL.md"),
      [
        "---",
        `name: ${entry.name}`,
        `description: ${entry.description}`,
        `scope: ${entry.scope}`,
        "---",
        "",
        entry.body,
        "",
      ].join("\n"),
      "utf8",
    );
  }
  return skillsRoot;
}

function startApp(root: string, extra: Partial<TuiAppOptions> = {}): AppHarness {
  const input = new FakeInput();
  const output = new FakeOutput();
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
  const frames = output.data.split(ANSI.cursorHome);
  return stripAnsi(frames.at(-1) ?? "");
}

function waitIdle(output: FakeOutput, timeoutMs = 5_000): Promise<boolean> {
  return waitFor(
    () => /ready —|turn completed|turn failed|turn cancelled/.test(lastFrameText(output)),
    timeoutMs,
  );
}

interface SessionEnvelope {
  seq?: number;
  from?: string;
  to?: string;
  kind?: string;
  payload?: { text?: unknown };
}

function sessionEvents(file: string): SessionEnvelope[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as SessionEnvelope);
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

test("typing / opens the picker, Enter inserts the token and Esc keeps the draft", async () => {
  const { root } = tmpdir();
  const harness = startApp(root);
  const { input, output } = harness;
  try {
    assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));

    input.type("/");
    assert.ok(await waitFor(() => lastFrameText(output).includes("COMMANDS (")));
    assert.ok(lastFrameText(output).includes("[TUI commands]"));
    assert.ok(lastFrameText(output).includes("Enter / Tab insert"));

    input.type("th");
    assert.ok(await waitFor(() => lastFrameText(output).includes("filter: th")));
    assert.ok(lastFrameText(output).includes("/theme"));

    input.enter();
    assert.ok(await waitFor(() => !lastFrameText(output).includes("COMMANDS (")));
    assert.ok(lastFrameText(output).includes("/theme"), "the token landed in the composer");
    assert.ok(!textOf(output).includes("decision:"), "the picker never starts a turn");

    // Esc closes the picker and keeps whatever was typed as the draft.
    input.key("escape");
    assert.ok(await waitFor(() => lastFrameText(output).includes("composer cleared")));
    input.type("/th");
    assert.ok(await waitFor(() => lastFrameText(output).includes("COMMANDS (")));
    input.key("escape");
    assert.ok(await waitFor(() => !lastFrameText(output).includes("COMMANDS (")));
    assert.ok(lastFrameText(output).includes("/th"), "Esc leaves the typed draft untouched");

    // Exactly typed commands keep the pre-picker Enter behavior (submit).
    input.key("escape");
    assert.ok(await waitFor(() => lastFrameText(output).includes("composer cleared")));
    input.type("/retry");
    assert.ok(await waitFor(() => lastFrameText(output).includes("COMMANDS (")));
    input.enter();
    assert.ok(await waitFor(() => lastFrameText(output).includes("nothing to retry")));
    assert.ok(!lastFrameText(output).includes("COMMANDS ("));
  } finally {
    await stop(harness, root);
  }
});

test("a @skill: submit injects one <skill-loaded> envelope before the turn", async () => {
  const { root } = tmpdir();
  const sessionFile = path.join(root, "session.jsonl");
  const skillsRoot = writeSkills(root, [
    skill("checklist", "shared", "Check the tests first", "Always check the tests first."),
    skill("secret", "senior", "Senior only", "Never shared."),
  ]);
  const harness = startApp(root, {
    cfg: resolveConfig({ provider: "mock", sessionFile }),
    skillsRoots: [skillsRoot],
  });
  const { input, output } = harness;
  try {
    assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));

    input.type("@");
    assert.ok(await waitFor(() => lastFrameText(output).includes("SKILLS (")));
    assert.ok(lastFrameText(output).includes("Only shared skills can be @mentioned"));
    assert.ok(lastFrameText(output).includes("@skill:checklist"));
    input.type("skill:check");
    assert.ok(await waitFor(() => lastFrameText(output).includes("filter: check")));
    input.enter();
    assert.ok(await waitFor(() => !lastFrameText(output).includes("SKILLS (")));
    assert.ok(lastFrameText(output).includes("@skill:checklist"));

    input.type("please verify @rel/path now");
    input.enter();
    assert.ok(await waitFor(() => textOf(output).includes("decision:"), 30_000));
    assert.ok(await waitIdle(output));
    assert.ok(textOf(output).includes("skill attached: checklist"), "the attachment is reported");

    const events = sessionEvents(sessionFile);
    const userTexts = events
      .filter((event) => event.from === "user" && event.kind === "message")
      .map((event) => String(event.payload?.text ?? ""));
    const task = "@skill:checklist please verify @rel/path now";
    assert.equal(userTexts[0], task, "the operator task stays the first user message");
    const skillBlocks = userTexts.filter((text) => text.includes("<skill-loaded"));
    assert.equal(skillBlocks.length, 1, "exactly one skill block is injected");
    assert.equal(
      skillBlocks[0],
      renderSkillLoadedBlock("checklist", "Always check the tests first."),
      "the injected bytes are the canonical <skill-loaded> block",
    );
    assert.ok(!userTexts.some((text) => text.includes("<file")), "file mentions stay literal");

    const taskEvent = events.find(
      (event) => event.from === "user" && String(event.payload?.text ?? "") === task,
    );
    const skillEvent = events.find(
      (event) => event.from === "user" && String(event.payload?.text ?? "").includes("<skill-loaded"),
    );
    assert.ok(taskEvent?.seq !== undefined && skillEvent?.seq !== undefined);
    assert.ok(taskEvent.seq < skillEvent.seq, "task envelope precedes the skill block");
    const firstNode = events.find((event) => event.from === "senior" || event.from === "junior");
    assert.ok(firstNode?.seq !== undefined);
    assert.ok(skillEvent.seq < firstNode.seq, "the skill block precedes every cooperation node");
  } finally {
    await stop(harness, root);
  }
});

test("unknown and role-scoped skill mentions are refused without submitting", async () => {
  const { root } = tmpdir();
  const sessionFile = path.join(root, "session.jsonl");
  const skillsRoot = writeSkills(root, [
    skill("checklist", "shared", "Check the tests first"),
    skill("secret", "senior", "Senior only"),
  ]);
  const harness = startApp(root, {
    cfg: resolveConfig({ provider: "mock", sessionFile }),
    skillsRoots: [skillsRoot],
  });
  const { input, output } = harness;
  try {
    assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));

    // The space after the mention closes the picker, so Enter submits the task
    // and validation refuses it.
    input.type("@skill:nope fix it");
    input.enter();
    assert.ok(await waitFor(() => lastFrameText(output).includes("unknown skill: @skill:nope")));
    assert.ok(!textOf(output).includes("decision:"), "no turn started for an unknown skill");
    assert.ok(
      lastFrameText(output).includes("@skill:nope fix it"),
      "the refused draft is restored for editing",
    );
    assert.deepEqual(sessionEvents(sessionFile), [], "nothing was appended to the session");

    input.key("escape");
    assert.ok(await waitFor(() => lastFrameText(output).includes("composer cleared")));
    input.type("@skill:secret do it");
    input.enter();
    assert.ok(await waitFor(() => lastFrameText(output).includes("senior-scoped")));
    assert.ok(!textOf(output).includes("decision:"));
    assert.deepEqual(sessionEvents(sessionFile), []);
  } finally {
    await stop(harness, root);
  }
});
