/**
 * TUI first-party base commands suite (`src/basecommands.ts` + the TUI adapter).
 *
 * Covers the TUI surface decisions (native keymap commands and discovered
 * templates shadow base entries), the exact prompt expansion + mode override,
 * the picker/help composition (badges, grouped order, priority sorting, alias
 * search, selected-row hint), the registry-driven key-repeat guard (Tab /
 * Shift+Tab and held-Enter protection), and fake-TTY app tests for the action
 * commands (`/compact`, `/export`, `/status`, `/permission`, `/new`) plus the
 * prompt commands (`/plan`), including the honest refusal paths.
 *
 * Run with: node --test tests/tuibasecommands.test.ts
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import {
  BASE_COMMANDS,
  baseCommandUsage,
  expandBaseCommand,
  findBaseCommand,
} from "../src/basecommands.ts";
import { COMPACTION_SUMMARY_PREFIX } from "../src/compaction.ts";
import { resolveConfig } from "../src/config.ts";
import { runTuiApp, type TuiAppOptions } from "../src/tui/app.ts";
import {
  BASE_COMMAND_ENTRY_PREFIX,
  planBaseCommandSubmission,
  tuiBaseCommands,
  tuiBasePaletteEntries,
} from "../src/tui/basecommands.ts";
import {
  guardComposerSubmit,
  keySignature,
  repeatSensitiveCommand,
  REPEAT_GUARD_MS,
  type RepeatGuardSnapshot,
} from "../src/tui/inputguard.ts";
import {
  TUI_COMMANDS,
  documentEntries,
  resolveKey,
  type KeyLike,
} from "../src/tui/keymap.ts";
import { ANSI } from "../src/tui/render.ts";
import { stripAnsi } from "../src/tui/screen.ts";
import { helpView } from "../src/tui/view/help.ts";
import {
  commandMentionItems,
  filterMentionPickerItems,
  mentionPickerKey,
  mentionPickerSelectionHint,
  mentionPickerView,
  openMentionPicker,
} from "../src/tui/view/mentionpicker.ts";

function key(name: string, raw = name, modifiers: Partial<KeyLike> = {}): KeyLike {
  return { name, raw, ...modifiers };
}

const TEMPLATES = [
  { name: "review", description: "Review the current changes", argumentHint: "[path]" },
  { name: "deploy", description: "Ship the current workspace" },
];

// --------------------------------------------------------------------------- //
// catalogue selection and expansion
// --------------------------------------------------------------------------- //

test("the TUI base set drops native- and template-shadowed names", () => {
  const names = tuiBaseCommands().map((command) => command.name);
  assert.deepEqual(names, [
    "plan",
    "compact",
    "goal",
    "status",
    "export",
    "permission",
    "new",
    "feedback",
  ]);
  // `help` and `mode` are native keymap commands and never duplicated.
  assert.ok(!names.includes("help"));
  assert.ok(!names.includes("mode"));

  // A discovered template shadows a same-named base command.
  const shadowed = tuiBaseCommands({ templates: TEMPLATES });
  assert.ok(!shadowed.some((command) => command.name === "review"), "template name wins");
  const withPlanTemplate = tuiBaseCommands({
    templates: [{ name: "plan", description: "Custom plan template" }],
  });
  assert.ok(
    !withPlanTemplate.some((command) => command.name === "plan"),
    "a discovered plan template shadows the base /plan",
  );
});

test("prompt commands expand to the exact template bytes with the mode override", () => {
  const plan = findBaseCommand("plan");
  assert.ok(plan?.template);
  const submission = planBaseCommandSubmission(plan, "ship the migration", "work");
  assert.equal(submission.kind, "run");
  if (submission.kind !== "run") return;
  assert.equal(submission.task, expandBaseCommand(plan, "ship the migration"));
  assert.ok(submission.task.startsWith("The operator wants a plan before any change."));
  assert.ok(submission.task.includes("Objective: ship the migration"));
  assert.ok(submission.task.includes("Do not start implementing in this turn."));
  assert.equal(submission.mode, "consult", "the command's own mode wins over the session mode");

  const feedback = findBaseCommand("feedback");
  assert.ok(feedback);
  const followup = planBaseCommandSubmission(feedback, "", "work");
  assert.equal(followup.kind, "run");
  if (followup.kind === "run") {
    assert.equal(followup.mode, "consult");
    assert.ok(followup.task.includes("The operator left feedback on the last turn:"));
  }

  const missing = planBaseCommandSubmission(plan, "   ", "consult");
  assert.deepEqual(missing, { kind: "usage", message: "usage: /plan <objective>" });

  // Aliases resolve to the same command (Chinese spelling included).
  assert.equal(findBaseCommand("计划")?.name, "plan");
  assert.equal(findBaseCommand("bug")?.name, "feedback");
  assert.equal(findBaseCommand("clear")?.name, "new");
  assert.equal(findBaseCommand("not-a-command"), undefined);
  assert.equal(baseCommandUsage(plan), "/plan <objective>");
  assert.equal(baseCommandUsage(findBaseCommand("compact")!), "/compact");

  // An action command is never planned as a task.
  const compact = findBaseCommand("compact");
  assert.ok(compact);
  assert.equal(planBaseCommandSubmission(compact, "", "work").kind, "usage");
  assert.equal(BASE_COMMANDS.length, 10);
});

test("help entries carry base commands in prompt/action groups with usage metadata", () => {
  const entries = tuiBasePaletteEntries(tuiBaseCommands());
  assert.deepEqual(
    [...new Set(entries.map((entry) => entry.group))],
    ["Built-in prompts", "Built-in actions"],
  );
  const plan = entries.find((entry) => entry.id === `${BASE_COMMAND_ENTRY_PREFIX}plan`);
  assert.ok(plan);
  assert.equal(plan.kind, "base-command");
  assert.equal(plan.title, "/plan");
  assert.equal(plan.argumentHint, "<objective>");
  assert.equal(plan.slash, "/plan");
  assert.equal(plan.description, "Agree an ordered, verifiable plan before changing anything");
  assert.ok(!entries.some((entry) => entry.title === "/help"), "native /help is not duplicated");

  // The help overlay renders both groups next to the existing key list.
  const merged = [...documentEntries(TUI_COMMANDS), ...entries];
  const view = helpView(TUI_COMMANDS, { query: "plan", selected: 0 }, merged, {
    width: 70,
    height: 12,
      });
  const text = view.lines.join("\n");
  assert.ok(text.includes("[Built-in prompts]"));
  assert.ok(text.includes("/plan"));
  assert.ok(text.includes("<objective>"));
  const compactView = helpView(TUI_COMMANDS, { query: "compact", selected: 0 }, merged, {
    width: 70,
    height: 12,
  });
  assert.ok(compactView.lines.join("\n").includes("[Built-in actions]"));
  assert.ok(compactView.lines.join("\n").includes("/compact"));
});

// --------------------------------------------------------------------------- //
// picker composition
// --------------------------------------------------------------------------- //

test("the / picker lists native, base and template rows with contiguous groups and badges", () => {
  const items = commandMentionItems(TUI_COMMANDS, TEMPLATES, tuiBaseCommands());
  const titleOf = (name: string): string | undefined =>
    items.find((item) => item.kind === "command" && item.name === name)?.title;

  // Native rows keep their badges and registry order.
  assert.equal(items[0]?.title, "/palette");
  assert.equal(items[0]?.badge, "builtin");
  assert.equal(titleOf("help"), "/help");
  // Base prompts and actions are appended after the native commands, grouped.
  const plan = items.find((item) => item.id === "base:plan");
  assert.ok(plan);
  assert.equal(plan.badge, "builtin");
  assert.equal(plan.group, "Built-in prompts");
  assert.equal(plan.usage, "/plan <objective>");
  assert.deepEqual([...(plan.aliases ?? [])], ["计划"]);
  const compact = items.find((item) => item.id === "base:compact");
  assert.ok(compact);
  assert.equal(compact.badge, "action");
  assert.equal(compact.group, "Built-in actions");
  // Contiguous groups: every "Built-in prompts" row comes before "Built-in actions".
  const groups = items.map((item) => item.group);
  const firstAction = groups.indexOf("Built-in actions");
  assert.ok(groups.lastIndexOf("Built-in prompts") < firstAction);
  // Templates are sorted alphabetically after the base rows.
  const templateTitles = items.filter((item) => item.badge === "template").map((item) => item.title);
  assert.deepEqual(templateTitles, ["/deploy", "/review"]);
  assert.equal(items.at(-1)?.title, "/review");

  // A same-named discovered template replaces the base row (no duplicate).
  const shadowed = commandMentionItems(
    TUI_COMMANDS,
    [{ name: "plan", description: "custom" }],
    tuiBaseCommands({ templates: [{ name: "plan", description: "custom" }] }),
  );
  assert.deepEqual(
    shadowed.filter((item) => item.name === "plan").map((item) => item.badge),
    ["template"],
  );
});

test("picker filtering searches base aliases and the selection footer shows usage", () => {
  const catalogs = { templates: TEMPLATES, baseCommands: tuiBaseCommands() };
  const items = commandMentionItems(TUI_COMMANDS, TEMPLATES, tuiBaseCommands());
  assert.deepEqual(
    filterMentionPickerItems(items, "bug").map((item) => item.name),
    ["feedback"],
  );
  assert.deepEqual(
    filterMentionPickerItems(items, "objective").map((item) => item.name).sort(),
    ["goal", "plan"],
  );

  const state = openMentionPicker("command", "", catalogs);
  const view = mentionPickerView(state, { width: 80 });
  const selected = filterMentionPickerItems(state.items, state.query)[0];
  assert.ok(selected);
  const hint = mentionPickerSelectionHint(selected);
  assert.ok(hint.includes("/palette"), hint);
  assert.ok(vizContains(view.lines, "/palette"), "the selected row is visible");

  const planState = openMentionPicker("command", "plan", catalogs);
  const planView = mentionPickerView(planState, { width: 80 });
  const planRow = planView.lines.find((line) => line.includes("/plan"));
  assert.ok(planRow);
  assert.ok(planRow.includes("[builtin]"), "the provenance badge is rendered");
  assert.ok(vizContains(planView.lines, "/plan <objective> — Agree an ordered"), "usage hint");

  const actionState = openMentionPicker("command", "compact", catalogs);
  const actionView = mentionPickerView(actionState, { width: 80 });
  const actionRow = actionView.lines.find((line) => line.includes("/compact"));
  assert.ok(actionRow);
  assert.ok(actionRow.includes("[action]"));
});

/** True when any rendered row contains `needle` (styled rows are stripped). */
function vizContains(lines: readonly string[], needle: string): boolean {
  return lines.some((line) => stripAnsi(line).includes(needle));
}

// --------------------------------------------------------------------------- //
// key handling: Tab / Shift+Tab, arrows, repeat guard
// --------------------------------------------------------------------------- //

test("Tab accepts, Shift+Tab dismisses, arrows move and Left/Right fall through", () => {
  const state = openMentionPicker("command", "", { baseCommands: tuiBaseCommands() });
  const tab = mentionPickerKey(TUI_COMMANDS, state, key("tab", "\t"));
  assert.equal(tab.action, "accept");
  assert.equal(tab.chordName, "tab");
  assert.equal(mentionPickerKey(TUI_COMMANDS, state, key("tab", "\t", { shift: true })).action, "close");
  assert.equal(mentionPickerKey(TUI_COMMANDS, state, key("up", "\u001b[A")).action, "move");
  assert.equal(mentionPickerKey(TUI_COMMANDS, state, key("down", "\u001b[B")).action, "move");
  assert.equal(mentionPickerKey(TUI_COMMANDS, state, key("left", "\u001b[D")).action, "none");
  assert.equal(mentionPickerKey(TUI_COMMANDS, state, key("right", "\u001b[C")).action, "none");
  assert.equal(
    resolveKey(TUI_COMMANDS, key("tab", "\t", { shift: true }), "mention")?.command.id,
    "mention-dismiss",
    "Shift+Tab is a registry chord, not a hard-coded key",
  );
});

test("the repeat guard is registry-driven and protects submit / picker accept only", () => {
  const now = 1_000;
  assert.equal(
    repeatSensitiveCommand(TUI_COMMANDS, key("return", "\r")),
    "submit",
  );
  assert.equal(
    repeatSensitiveCommand(TUI_COMMANDS, key("return", "\r"), { mentionOpen: true }),
    "mention-accept",
  );
  assert.equal(repeatSensitiveCommand(TUI_COMMANDS, key("left", "\u001b[D")), null);
  assert.equal(repeatSensitiveCommand(TUI_COMMANDS, key("a", "a")), null);
  assert.equal(
    repeatSensitiveCommand(TUI_COMMANDS, key("tab", "\t", { shift: true }), { mentionOpen: true }),
    null,
    "Shift+Tab dismiss is repeat-safe",
  );

  const enter = key("return", "\r");
  const first = guardComposerSubmit(null, enter, "say hello", { now });
  assert.equal(first.suppress, false);
  const snapshot: RepeatGuardSnapshot = first.snapshot!;
  assert.equal(snapshot.commandId, "submit");
  assert.equal(snapshot.signature, keySignature(enter));

  const repeated = guardComposerSubmit(snapshot, enter, "say hello", { now: now + 10 });
  assert.equal(repeated.suppress, true, "identical key + unchanged text is a key repeat");
  const sliding = guardComposerSubmit(repeated.snapshot, enter, "say hello", {
    now: now + REPEAT_GUARD_MS - 1,
  });
  assert.equal(sliding.suppress, true, "the window slides while the key is held");

  const afterDraft = guardComposerSubmit(snapshot, enter, "say hello, then more", { now: now + 10 });
  assert.equal(afterDraft.suppress, false, "typing between presses is a new submit");
  const afterWindow = guardComposerSubmit(repeated.snapshot, enter, "say hello", {
    now: now + REPEAT_GUARD_MS * 2,
  });
  assert.equal(afterWindow.suppress, false, "a deliberate later Enter is allowed");
  const mentionFirst = guardComposerSubmit(null, enter, "say hello", {
    now,
    mentionOpen: true,
  });
  assert.equal(mentionFirst.suppress, false);
  assert.equal(mentionFirst.snapshot?.commandId, "mention-accept");
  assert.equal(
    guardComposerSubmit(mentionFirst.snapshot, enter, "say hello", {
      now: now + 10,
      mentionOpen: true,
    }).suppress,
    true,
    "picker acceptance uses the same guard",
  );

  const explicit = guardComposerSubmit(snapshot, key("return", "\r", { repeat: true }), "draft", {
    now: now + 10,
  });
  assert.equal(explicit.suppress, true, "an explicit terminal repeat flag is always suppressed");
  assert.equal(
    guardComposerSubmit(snapshot, key("up", "\u001b[A"), "draft", { now: now + 10 }).suppress,
    false,
    "non-submit keys are never guarded",
  );
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

  key(
    name: string,
    modifiers: { ctrl?: boolean; shift?: boolean; raw?: string; repeat?: boolean } = {},
  ): void {
    this.emit("keypress", modifiers.raw ?? "", {
      name,
      ctrl: modifiers.ctrl === true,
      shift: modifiers.shift === true,
      ...(modifiers.repeat === true ? { repeat: true } : {}),
    });
  }

  enter(repeat = false): void {
    this.key("return", { raw: "\r", ...(repeat ? { repeat: true } : {}) });
  }

  tab(shift = false): void {
    this.key("tab", { raw: shift ? "\u001b[Z" : "\t", shift });
  }

  escape(): void {
    this.key("escape", { raw: "\u001b" });
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-tui-base-"));
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
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
    cwd: root,
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

function framesOf(output: FakeOutput): string[] {
  return output.data.split(ANSI.cursorHome).slice(1).map((frame) => stripAnsi(frame));
}

const lastFrameText = (output: FakeOutput): string => framesOf(output).at(-1) ?? "";

function waitIdle(output: FakeOutput, timeoutMs = 5_000): Promise<boolean> {
  return waitFor(
    () => /ready —|turn completed|turn failed|turn cancelled/.test(lastFrameText(output)),
    timeoutMs,
  );
}

async function quit(input: FakeInput, app: Promise<number>): Promise<number> {
  for (let press = 0; press < 8; press += 1) {
    input.escape();
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

function sessionLines(file: string): string[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter((line) => line.trim() !== "");
}

test("/plan expands the exact template, runs it and applies the consult override", async () => {
  const { root } = tmpdir();
  const harness = startApp(root);
  const { input, output } = harness;
  try {
    assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));

    // The native /mode command still wins and switches the session to work.
    input.type("/mode work");
    input.enter();
    assert.ok(await waitFor(() => lastFrameText(output).includes("mode: work")));

    input.type("/plan ship the migration");
    input.enter();
    assert.ok(await waitFor(() => textOf(output).includes("decision:"), 30_000));
    assert.ok(await waitIdle(output));

    const transcript = textOf(output);
    assert.ok(
      transcript.includes("The operator wants a plan before any change."),
      "the base template header was submitted, not the literal /plan text",
    );
    assert.ok(transcript.includes("Objective: ship the migration"));
    assert.ok(transcript.includes("Do not start implementing in this turn."));
    assert.ok(
      transcript.includes("running (consult)"),
      "the /plan mode override (consult) is used while the session mode stays work",
    );
    assert.ok(lastFrameText(output).includes("work"), "the session mode was not changed");
  } finally {
    await stop(harness, root);
  }
});

test("/compact compacts the context in place and never submits a task", async () => {
  const { root } = tmpdir();
  const sessionFile = path.join(root, "session.jsonl");
  const harness = startApp(root, {
    cfg: resolveConfig({ provider: "mock", sessionFile, compactKeepRecent: 1 }),
  });
  const { input, output } = harness;
  try {
    assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));

    // Empty context: an honest no-op, never a turn.
    input.type("/compact");
    input.enter();
    assert.ok(await waitFor(() => lastFrameText(output).includes("nothing to compact")));
    assert.ok(!textOf(output).includes("decision:"), "an action command never starts a turn");

    // Give it a real turn, then compact: the session file is rewritten.
    input.type("say hello");
    input.enter();
    assert.ok(await waitFor(() => textOf(output).includes("decision:"), 30_000));
    assert.ok(await waitIdle(output));
    const before = sessionLines(sessionFile);
    assert.ok(before.length > 1);

    input.type("/compact");
    input.enter();
    assert.ok(
      await waitFor(() => lastFrameText(output).includes("context compacted")),
      `frame after /compact:\n${lastFrameText(output)}`,
    );
    const after = sessionLines(sessionFile);
    assert.ok(after.length < before.length, `${after.length} < ${before.length}`);
    assert.ok(
      after.some((line) => {
        try {
          const parsed = JSON.parse(line) as { payload?: { text?: unknown } };
          return String(parsed.payload?.text ?? "").startsWith(COMPACTION_SUMMARY_PREFIX);
        } catch {
          return false;
        }
      }),
      "a compaction-summary envelope replaced the older events",
    );
    assert.ok(
      lastFrameText(output).includes("unchanged"),
      "the notice is honest about the display record",
    );
  } finally {
    await stop(harness, root);
  }
});

test("/export refuses in-memory sessions honestly and writes Markdown for file sessions", async () => {
  const { root } = tmpdir();
  const memory = startApp(root);
  try {
    assert.ok(await waitFor(() => textOf(memory.output).includes("Two Brothers")));
    memory.input.type("/export");
    memory.input.enter();
    assert.ok(
      await waitFor(() => lastFrameText(memory.output).includes("in memory only")),
      "a missing prerequisite is reported, not silently ignored",
    );
    assert.ok(!textOf(memory.output).includes("decision:"), "no task was submitted");
  } finally {
    await stop(memory, root);
  }

  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tb-tui-base-export-"));
  const sessionFile = path.join(sessionRoot, "session.jsonl");
  const harness = startApp(sessionRoot, {
    cfg: resolveConfig({ provider: "mock", sessionFile }),
  });
  const { input, output } = harness;
  try {
    assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));
    input.type("say hello");
    input.enter();
    assert.ok(await waitFor(() => textOf(output).includes("decision:"), 30_000));
    assert.ok(await waitIdle(output));

    input.type("/export");
    input.enter();
    assert.ok(await waitFor(() => lastFrameText(output).includes("exported")));
    const exported = path.join(sessionRoot, "session.md");
    assert.ok(fs.existsSync(exported), "the default export path was written");
    const body = fs.readFileSync(exported, "utf8");
    assert.match(body, /^# say hello/);
    assert.match(body, /- envelopes: \d+/);
    assert.ok(body.includes("## 1. user → senior · message"));
  } finally {
    await stop(harness, sessionRoot);
  }
});

test("/status and /permission open honest dialogs; /new resets memory but refuses files", async () => {
  const { root } = tmpdir();
  const harness = startApp(root);
  const { input, output } = harness;
  try {
    assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));

    input.type("/status");
    input.enter();
    assert.ok(await waitFor(() => lastFrameText(output).includes("(idle)")), "the status dialog opened");
    input.type("d"); // show the status details
    assert.ok(await waitFor(() => lastFrameText(output).includes("MODE: consult")));
    input.escape();
    assert.ok(await waitFor(() => !lastFrameText(output).includes("(idle)")));

    input.type("/permission");
    input.enter();
    assert.ok(await waitFor(() => lastFrameText(output).includes("PERMISSIONS")));
    assert.ok(lastFrameText(output).includes("Approval policy"));
    input.type("d"); // show details
    assert.ok(
      await waitFor(() => lastFrameText(output).includes("approvals: none in the TUI")),
    );
    assert.ok(lastFrameText(output).includes("workspace_*"));
    input.escape();
    assert.ok(await waitFor(() => !lastFrameText(output).includes("PERMISSIONS")));

    // /new on an in-memory session starts fresh (the old transcript is gone).
    input.type("say hello");
    input.enter();
    assert.ok(await waitFor(() => textOf(output).includes("decision:"), 30_000));
    assert.ok(await waitIdle(output));
    input.type("/new");
    input.enter();
    assert.ok(await waitFor(() => lastFrameText(output).includes("new in-memory session")));
    assert.ok(!lastFrameText(output).includes("decision:"), "the transcript was reset");
  } finally {
    await stop(harness, root);
  }

  const fileRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tb-tui-base-new-"));
  const fileHarness = startApp(fileRoot, {
    cfg: resolveConfig({ provider: "mock", sessionFile: path.join(fileRoot, "session.jsonl") }),
  });
  try {
    assert.ok(await waitFor(() => textOf(fileHarness.output).includes("Two Brothers")));
    fileHarness.input.type("/new");
    fileHarness.input.enter();
    assert.ok(
      await waitFor(() => lastFrameText(fileHarness.output).includes("cannot rotate an on-disk session")),
      "a file-backed session is refused honestly",
    );
  } finally {
    await stop(fileHarness, fileRoot);
  }
});

test("native commands keep winning: /help lists base commands, the picker has no duplicate", async () => {
  const { root } = tmpdir();
  const harness = startApp(root);
  const { input, output } = harness;
  try {
    assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));

    // `/` picker: exactly one /help row (the native one), plus base rows.
    input.type("/");
    assert.ok(await waitFor(() => lastFrameText(output).includes("COMMANDS (")));
    assert.ok(lastFrameText(output).includes("[builtin]"), "native rows carry the badge");
    input.type("plan");
    assert.ok(await waitFor(() => lastFrameText(output).includes("/plan")));
    assert.ok(lastFrameText(output).includes("Built-in prompts"));
    input.escape();
    assert.ok(await waitFor(() => !lastFrameText(output).includes("COMMANDS (")));
    input.escape(); // drop the leftover "/" draft before the next command
    assert.ok(await waitFor(() => lastFrameText(output).includes("composer cleared")));

    // The native /help still opens the help overlay, now including base rows.
    input.type("/help");
    input.enter();
    assert.ok(await waitFor(() => lastFrameText(output).includes("HELP")));
    input.type("plan");
    assert.ok(await waitFor(() => lastFrameText(output).includes("/plan")));
    assert.ok(lastFrameText(output).includes("[Built-in prompts]"));
    for (let press = 0; press < 4; press += 1) input.key("backspace", { raw: "\u007f" });
    input.type("compact");
    assert.ok(await waitFor(() => lastFrameText(output).includes("[Built-in actions]")));
    input.escape();
    assert.ok(await waitFor(() => !lastFrameText(output).includes("HELP")));

    // Tab inserts the highlighted picker row; Shift+Tab dismisses and keeps
    // the typed draft (the text input keeps focus).
    input.type("/th");
    assert.ok(await waitFor(() => lastFrameText(output).includes("COMMANDS (")));
    input.tab();
    assert.ok(await waitFor(() => !lastFrameText(output).includes("COMMANDS (")));
    assert.ok(lastFrameText(output).includes("/theme"), "Tab accepted the selected command");

    input.escape(); // clear the inserted draft
    assert.ok(await waitFor(() => lastFrameText(output).includes("composer cleared")));
    input.type("/th");
    assert.ok(await waitFor(() => lastFrameText(output).includes("COMMANDS (")));
    input.tab(true);
    assert.ok(await waitFor(() => !lastFrameText(output).includes("COMMANDS (")));
    assert.ok(lastFrameText(output).includes("/th"), "Shift+Tab dismisses, draft untouched");
  } finally {
    await stop(harness, root);
  }
});
