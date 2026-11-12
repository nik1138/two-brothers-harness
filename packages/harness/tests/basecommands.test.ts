/**
 * Base-command catalogue tests (`src/basecommands.ts`): catalogue invariants,
 * alias resolution, literal `$ARGUMENTS` expansion byte-equality with
 * `commands.ts::expandCommand`, the serializable metadata form and the usage
 * line. Pure — no filesystem, no environment, no timers.
 *
 * Run with: node --test tests/basecommands.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BASE_COMMANDS,
  baseCommandMetadata,
  baseCommandTokens,
  baseCommandUsage,
  expandBaseCommand,
  findBaseCommand,
  sortBaseCommands,
  type BaseCommand,
  type BaseCommandAction,
  type BaseCommandKind,
  type BaseCommandMetadata,
} from "../src/basecommands.ts";
import { expandCommand, type Command } from "../src/commands.ts";

const PROMPT_NAMES = ["plan", "goal", "feedback"];
const ACTION_NAMES = ["compact", "status", "export", "mode", "permission", "new", "help"];
const EXPECTED_ACTIONS: BaseCommandAction[] = [
  "compact",
  "export",
  "permission",
  "help",
  "status",
  "mode",
  "new",
];

function byName(name: string): BaseCommand {
  const command = BASE_COMMANDS.find((entry) => entry.name === name);
  assert.ok(command !== undefined, `missing base command: ${name}`);
  return command;
}

/** A synthetic prompt command for cases the shipped catalogue does not cover. */
function promptCommand(overrides: Partial<BaseCommand> = {}): BaseCommand {
  return {
    name: "demo",
    aliases: [],
    description: "Demo prompt command.",
    argumentHint: "[args]",
    kind: "prompt",
    template: "Body: $ARGUMENTS",
    mode: "consult",
    requiresArguments: false,
    priority: 1,
    ...overrides,
  };
}

/** The same template as a discovered command, for byte-equality checks. */
function asDiscovered(command: BaseCommand): Command {
  return {
    name: command.name,
    description: command.description,
    argumentHint: command.argumentHint,
    ...(command.mode === undefined ? {} : { mode: command.mode }),
    file: `/base-commands/${command.name}.md`,
    body: command.template ?? "",
  };
}

test("catalogue: ten unique canonical names, `[a-z][a-z0-9-]*`, priority order", () => {
  assert.equal(BASE_COMMANDS.length, 10);
  const names = BASE_COMMANDS.map((command) => command.name);
  assert.equal(new Set(names).size, names.length, "duplicate canonical name");
  for (const command of BASE_COMMANDS) {
    assert.match(command.name, /^[a-z][a-z0-9-]*$/, command.name);
  }
  // Order is not part of the contract; every consumer sorts through
  // sortBaseCommands. Priorities are unique, so the rendered order is fixed.
  assert.deepEqual(sortBaseCommands().map((command) => command.name), [
    "plan",
    "compact",
    "goal",
    "status",
    "export",
    "mode",
    "permission",
    "new",
    "feedback",
    "help",
  ]);
  const priorities = sortBaseCommands().map((command) => command.priority);
  assert.deepEqual(priorities, [...priorities].sort((a, b) => b - a));
});

test("catalogue: kinds partition into three prompt and seven action commands", () => {
  const counts: Record<BaseCommandKind, number> = { prompt: 0, action: 0 };
  for (const command of BASE_COMMANDS) counts[command.kind] += 1;
  assert.deepEqual(counts, { prompt: 3, action: 7 });

  assert.deepEqual(
    sortBaseCommands(BASE_COMMANDS.filter((command) => command.kind === "prompt")).map(
      (command) => command.name,
    ),
    PROMPT_NAMES,
  );
  assert.deepEqual(
    sortBaseCommands(BASE_COMMANDS.filter((command) => command.kind === "action")).map(
      (command) => command.name,
    ),
    ACTION_NAMES,
  );
});

test("catalogue: prompt commands carry a template and a mode, never an action", () => {
  for (const command of BASE_COMMANDS.filter((entry) => entry.kind === "prompt")) {
    assert.equal(command.action, undefined, command.name);
    assert.equal(typeof command.template, "string", command.name);
    assert.ok((command.template ?? "").length > 0, command.name);
    assert.equal(
      (command.template ?? "").split("$ARGUMENTS").length - 1,
      1,
      `${command.name}: expected exactly one $ARGUMENTS placeholder`,
    );
    assert.ok(command.mode === "consult" || command.mode === "work", command.name);
    assert.equal(typeof command.requiresArguments, "boolean", command.name);
    assert.ok(command.description.length > 0, command.name);
  }
});

test("catalogue: action commands declare a known action, never a template or mode", () => {
  for (const command of BASE_COMMANDS.filter((entry) => entry.kind === "action")) {
    assert.ok(command.action !== undefined, command.name);
    assert.ok(EXPECTED_ACTIONS.includes(command.action), command.name);
    assert.equal(command.template, undefined, command.name);
    assert.equal(command.mode, undefined, command.name);
    assert.equal(typeof command.requiresArguments, "boolean", command.name);
  }
});

test("catalogue: aliases are non-empty, unique, and never shadow a canonical name", () => {
  const canonical = new Set(BASE_COMMANDS.map((command) => command.name));
  const owners = new Map<string, string>();
  for (const command of BASE_COMMANDS) owners.set(command.name, command.name);
  for (const command of BASE_COMMANDS) {
    for (const alias of command.aliases) {
      assert.equal(typeof alias, "string", command.name);
      assert.ok(alias.trim() !== "", `${command.name}: empty alias`);
      assert.notEqual(alias, command.name, `${command.name}: alias repeats the canonical name`);
      const lower = alias.toLowerCase();
      assert.ok(
        !canonical.has(lower) || lower === command.name,
        `${command.name}: alias "${alias}" shadows a canonical name`,
      );
      assert.equal(owners.get(lower), undefined, `duplicate command token "${alias}"`);
      owners.set(lower, command.name);
    }
  }
});

test("catalogue: the array and every entry object are frozen", () => {
  assert.ok(Object.isFrozen(BASE_COMMANDS));
  for (const command of BASE_COMMANDS) {
    assert.ok(Object.isFrozen(command), `${command.name} is not frozen`);
    assert.throws(() => {
      (command as unknown as { priority: number }).priority = 0;
    }, TypeError);
    assert.throws(() => {
      (command as unknown as { name: string }).name = "renamed";
    }, TypeError);
  }
});

test("findBaseCommand: canonical names, case-insensitive and trimmed", () => {
  for (const command of BASE_COMMANDS) {
    assert.equal(findBaseCommand(command.name), command, command.name);
    assert.equal(findBaseCommand(command.name.toUpperCase()), command, command.name);
    assert.equal(findBaseCommand(`  ${command.name}\t\n`), command, command.name);
  }
});

test("findBaseCommand: English aliases resolve to their canonical command", () => {
  const english: Array<[alias: string, name: string]> = [
    ["objective", "goal"],
    ["export-md", "export"],
    ["clear", "new"],
    ["reset", "new"],
    ["bug", "feedback"],
    ["review", "feedback"],
    ["h", "help"],
    ["?", "help"],
  ];
  for (const [alias, name] of english) {
    assert.equal(findBaseCommand(alias)?.name, name, alias);
  }
  assert.equal(findBaseCommand("OBJECTIVE")?.name, "goal");
  assert.equal(findBaseCommand("Export-MD")?.name, "export");
});

test("findBaseCommand: the reference Chinese aliases resolve", () => {
  const chinese: Array<[alias: string, name: string]> = [
    ["计划", "plan"],
    ["目标", "goal"],
    ["压缩", "compact"],
    ["导出", "export"],
    ["权限", "permission"],
    ["反馈", "feedback"],
  ];
  for (const [alias, name] of chinese) {
    assert.equal(findBaseCommand(alias)?.name, name, alias);
  }
});

test("findBaseCommand: every catalogue token resolves; unknown and empty are undefined", () => {
  for (const command of BASE_COMMANDS) {
    for (const token of baseCommandTokens(command)) {
      assert.equal(findBaseCommand(token), command, token);
    }
  }
  for (const unknown of [
    "deploy",
    "models",
    "theme",
    "sessions",
    "/plan",
    "plan!",
    "planx",
    "",
    "   ",
    "\t\n",
  ]) {
    assert.equal(findBaseCommand(unknown), undefined, JSON.stringify(unknown));
  }
});

test("sortBaseCommands: priority desc then name, fresh array, input untouched", () => {
  const snapshot = [...BASE_COMMANDS];
  const sorted = sortBaseCommands();
  assert.notEqual(sorted, BASE_COMMANDS);
  assert.deepEqual(sorted.map((command) => command.name), [
    "plan",
    "compact",
    "goal",
    "status",
    "export",
    "mode",
    "permission",
    "new",
    "feedback",
    "help",
  ]);
  assert.deepEqual([...BASE_COMMANDS], snapshot, "sortBaseCommands must not mutate its input");

  // Equal priorities break on name (deterministic, locale-independent).
  const custom: BaseCommand[] = [
    promptCommand({ name: "beta", priority: 5 }),
    promptCommand({ name: "gamma", priority: 9 }),
    promptCommand({ name: "alpha", priority: 5 }),
  ];
  assert.deepEqual(
    sortBaseCommands(custom).map((command) => command.name),
    ["gamma", "alpha", "beta"],
  );
  assert.deepEqual(
    custom.map((command) => command.name),
    ["beta", "gamma", "alpha"],
    "sortBaseCommands must not mutate a custom list",
  );
});

test("baseCommandTokens: canonical name first, then aliases, as a fresh array", () => {
  assert.deepEqual(baseCommandTokens(byName("goal")), ["goal", "objective", "目标"]);
  assert.deepEqual(baseCommandTokens(byName("status")), ["status"]);
  assert.deepEqual(baseCommandTokens(byName("help")), ["help", "h", "?"]);

  const tokens = baseCommandTokens(byName("plan"));
  tokens.push("hacked");
  assert.deepEqual(baseCommandTokens(byName("plan")), ["plan", "计划"]);
});

test("expandBaseCommand: $ARGUMENTS is the whole trimmed input", () => {
  const plan = byName("plan");
  const template = plan.template ?? "";
  assert.equal(
    expandBaseCommand(plan, "migrate Redis to Valkey"),
    template.replace("$ARGUMENTS", "migrate Redis to Valkey"),
  );
  // Outer whitespace is trimmed; inner whitespace and newlines are kept.
  assert.equal(
    expandBaseCommand(plan, "  padded   inner  "),
    template.replace("$ARGUMENTS", "padded   inner"),
  );
  const multiline = expandBaseCommand(plan, "line one\nline two");
  assert.ok(multiline.includes("Objective: line one\nline two"), multiline);
  assert.ok(!multiline.includes("$ARGUMENTS"));

  // Optional-argument prompt: blank input expands with an empty $ARGUMENTS.
  const feedback = byName("feedback");
  assert.equal(expandBaseCommand(feedback, "   "), (feedback.template ?? "").replace("$ARGUMENTS", ""));
  assert.ok(!expandBaseCommand(feedback, "").includes("$ARGUMENTS"));
});

test("expandBaseCommand: $1..$9, $$, literal $/$0/$10+ once, never re-expanded", () => {
  const command = promptCommand({
    template: "args=$ARGUMENTS one=$1 three=$3 nine=$9 five=$5 dollars=$$HOME edge=[$10][$0][$x]",
  });
  assert.equal(
    expandBaseCommand(command, "alpha beta"),
    "args=alpha beta one=alpha three= nine= five= dollars=$HOME edge=[alpha0][$0][$x]",
  );

  const nine = promptCommand({ template: "$1|$2|$3|$4|$5|$6|$7|$8|$9" });
  assert.equal(expandBaseCommand(nine, "1 2 3 4 5 6 7 8 9"), "1|2|3|4|5|6|7|8|9");
  assert.equal(expandBaseCommand(nine, "1 2"), "1|2|||||||");

  // Single pass: substituted argument text is never rescanned.
  assert.equal(expandBaseCommand(promptCommand({ template: "$ARGUMENTS" }), "$1 $$"), "$1 $$");
  assert.equal(expandBaseCommand(promptCommand({ template: "$1/$2" }), "$2 x"), "$2/x");
});

test("expandBaseCommand: required arguments throw RangeError naming the command and hint", () => {
  const plan = byName("plan");
  for (const blank of ["", "   ", "\t\n"]) {
    assert.throws(
      () => expandBaseCommand(plan, blank),
      (error: unknown) => {
        assert.ok(error instanceof RangeError, `expected RangeError for ${JSON.stringify(blank)}`);
        assert.ok(error.message.includes('"/plan"'), error.message);
        assert.ok(error.message.includes("<objective>"), error.message);
        return true;
      },
    );
  }
  assert.equal(expandBaseCommand(plan, "ship the release"), (plan.template ?? "").replace("$ARGUMENTS", "ship the release"));

  // A hint-less required command reports no empty "()" suffix.
  const hintless = promptCommand({ name: "demo", argumentHint: "", requiresArguments: true });
  assert.throws(
    () => expandBaseCommand(hintless, "  "),
    (error: unknown) => {
      assert.ok(error instanceof RangeError);
      assert.ok(error.message.includes('"/demo"'), error.message);
      assert.ok(!error.message.includes("()"), error.message);
      return true;
    },
  );

  // The joined usage line is rendered by baseCommandUsage, not the error text.
  assert.equal(baseCommandUsage(plan), "/plan <objective>");
});

test("expandBaseCommand: action commands and template-less prompts throw RangeError", () => {
  const compact = byName("compact");
  assert.throws(
    () => expandBaseCommand(compact, "anything"),
    (error: unknown) => {
      assert.ok(error instanceof RangeError);
      assert.ok(error.message.includes('"/compact"'), error.message);
      assert.ok(error.message.includes("no prompt template"), error.message);
      return true;
    },
  );

  const templateLess = promptCommand({ name: "broken", template: undefined });
  assert.throws(() => expandBaseCommand(templateLess, "x"), RangeError);
});

test("prompt catalogue and discovered commands expand to identical bytes", () => {
  const prompts = BASE_COMMANDS.filter((command) => command.kind === "prompt");
  assert.equal(prompts.length, 3);
  const inputs = ["ship the release", "修复 登录 页面", "a\nb c"];
  for (const command of prompts) {
    for (const input of inputs) {
      // Discovered commands receive matchCommand's already-trimmed args, and
      // expandBaseCommand trims too, so the same argument string is compared.
      assert.equal(
        expandBaseCommand(command, input),
        expandCommand(asDiscovered(command), input.trim()),
        `${command.name}: ${JSON.stringify(input)}`,
      );
    }
    if (!command.requiresArguments) {
      assert.equal(expandBaseCommand(command, ""), expandCommand(asDiscovered(command), ""));
    }
  }
});

test("baseCommandMetadata: sorted, action only for actions, no template bodies", () => {
  const metadata: BaseCommandMetadata[] = baseCommandMetadata();
  const sorted = sortBaseCommands();
  assert.deepEqual(metadata.map((item) => item.name), sorted.map((command) => command.name));
  for (let index = 1; index < metadata.length; index += 1) {
    assert.ok(metadata[index - 1].priority >= metadata[index].priority, "priority order broken");
  }

  for (const item of metadata) {
    const source = byName(item.name);
    assert.equal(item.kind, source.kind);
    assert.equal(item.description, source.description);
    assert.equal(item.argumentHint, source.argumentHint);
    assert.equal(item.requiresArguments, source.requiresArguments);
    assert.equal(item.priority, source.priority);
    assert.deepEqual(item.aliases, [...source.aliases]);
    if (source.kind === "action") assert.equal(item.action, source.action);
    else assert.equal(item.action, undefined);

    const expectedKeys = [
      "aliases",
      "argumentHint",
      "description",
      "kind",
      "name",
      "priority",
      "requiresArguments",
      ...(source.kind === "action" ? ["action"] : []),
    ].sort();
    assert.deepEqual(Object.keys(item).sort(), expectedKeys, item.name);
    assert.ok(!("template" in item), `${item.name}: metadata leaked a template`);
    assert.ok(!("body" in item), `${item.name}: metadata leaked a body`);
    assert.ok(!("mode" in item), `${item.name}: metadata leaked a mode`);
  }

  // JSON is the GET /api/commands wire form; no prompt bodies may appear in it.
  const wire = JSON.stringify(metadata);
  assert.deepEqual(JSON.parse(wire), metadata);
  for (const command of BASE_COMMANDS) {
    if (command.template !== undefined) {
      assert.ok(!wire.includes(command.template), `${command.name}: template leaked into JSON`);
    }
  }
  assert.ok(!wire.includes("$ARGUMENTS"));
});

test("baseCommandMetadata: alias arrays are copies, mutating them cannot corrupt the catalogue", () => {
  const first = baseCommandMetadata();
  const snapshot = JSON.parse(JSON.stringify(first)) as BaseCommandMetadata[];
  const planMetadata = first.find((item) => item.name === "plan");
  assert.ok(planMetadata !== undefined);
  planMetadata.aliases.push("hacked");
  planMetadata.name = "plan-hacked";
  first.reverse();

  const second = baseCommandMetadata();
  assert.deepEqual(second, snapshot);
  assert.deepEqual([...byName("plan").aliases], ["计划"]);
  assert.equal(byName("plan").name, "plan");
});

test("baseCommandUsage renders both the hint and the no-hint form", () => {
  for (const command of BASE_COMMANDS) {
    const usage = baseCommandUsage(command);
    assert.equal(
      usage,
      command.argumentHint === ""
        ? `/${command.name}`
        : `/${command.name} ${command.argumentHint}`,
      command.name,
    );
    assert.ok(!usage.includes("  "), usage);
  }
  assert.equal(baseCommandUsage(byName("plan")), "/plan <objective>");
  assert.equal(baseCommandUsage(byName("goal")), "/goal <objective>");
  assert.equal(baseCommandUsage(byName("feedback")), "/feedback [notes]");
  assert.equal(baseCommandUsage(byName("export")), "/export [path]");
  assert.equal(baseCommandUsage(byName("mode")), "/mode [consult|work|auto]");
  assert.equal(baseCommandUsage(byName("status")), "/status");
  assert.equal(baseCommandUsage(byName("help")), "/help");
});
