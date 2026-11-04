/**
 * Slash-command tests: flat `<name>.md` discovery with root priority, the
 * hand-rolled frontmatter parser, literal-template expansion and the REPL
 * line matcher. Fixtures are written to temp directories at runtime.
 *
 * Run with: node --test tests/commands.test.ts (or node tests/run-all.ts)
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import {
  discoverCommands,
  expandCommand,
  matchCommand,
  type Command,
  type CommandCatalog,
} from "../src/commands.ts";

interface TempRoot {
  root: string;
  cleanup: () => void;
}

function tmpdir(): TempRoot {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-commands-"));
  return {
    root,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/** Write `<root>/<rel>` (creating parents) and return the absolute path. */
function writeFile(root: string, rel: string, content: string): string {
  const target = path.join(root, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
  return target;
}

/** `---` fence around the given frontmatter lines, then an optional body. */
function commandDoc(frontmatter: string, body = ""): string {
  return `---\n${frontmatter}\n---\n\n${body}`;
}

function names(catalog: CommandCatalog): string[] {
  return catalog.commands.map((command) => command.name);
}

test("discovers flat markdown commands only, sorted by name", (t) => {
  const { root, cleanup } = tmpdir();
  t.after(cleanup);

  const zeta = writeFile(
    root,
    "zeta.md",
    commandDoc("description: The last command.", "# Zeta\n\nDo the thing."),
  );
  writeFile(
    root,
    "alpha.md",
    commandDoc("description: The first command.\nargument-hint: <path>", "Review $ARGUMENTS"),
  );
  writeFile(root, "notes.txt", "not a command");
  writeFile(root, "nested/inner.md", commandDoc("description: Nested, not discovered."));
  writeFile(root, "group/deeper/deep.md", commandDoc("description: Also nested."));

  const catalog = discoverCommands([root]);

  assert.deepEqual(names(catalog), ["alpha", "zeta"]);
  assert.deepEqual(catalog.diagnostics, []);

  const [alpha, zetaCommand] = catalog.commands;
  assert.equal(alpha.description, "The first command.");
  assert.equal(alpha.argumentHint, "<path>");
  assert.equal(alpha.mode, undefined);
  assert.equal(alpha.body, "Review $ARGUMENTS");
  assert.ok(path.isAbsolute(alpha.file));
  assert.equal(alpha.file, path.join(root, "alpha.md"));

  assert.equal(zetaCommand.file, zeta);
  assert.equal(zetaCommand.body, "# Zeta\n\nDo the thing.");
  assert.equal(zetaCommand.argumentHint, "");
});

test("root order is priority: duplicates are shadowed with a diagnostic", (t) => {
  const { root, cleanup } = tmpdir();
  t.after(cleanup);

  const projectRoot = path.join(root, "project");
  const userRoot = path.join(root, "user");
  const winner = writeFile(
    projectRoot,
    "dup.md",
    commandDoc("description: Project version."),
  );
  const loser = writeFile(userRoot, "dup.md", commandDoc("description: User version."));

  const catalog = discoverCommands([projectRoot, userRoot]);

  assert.deepEqual(names(catalog), ["dup"]);
  assert.equal(catalog.commands[0].description, "Project version.");
  assert.equal(catalog.commands[0].file, winner);
  assert.equal(catalog.diagnostics.length, 1);
  const shadow = catalog.diagnostics[0];
  assert.ok(shadow.includes("duplicate command"), shadow);
  assert.ok(shadow.includes('"dup"'), shadow);
  assert.ok(shadow.includes(path.resolve(loser)), shadow);
  assert.ok(shadow.includes(path.resolve(winner)), shadow);

  // Reversing the roots reverses the winner — nothing is merged silently.
  const reversed = discoverCommands([userRoot, projectRoot]);
  assert.equal(reversed.commands[0].description, "User version.");
});

test("invalid file stems are skipped with a diagnostic; dotfiles are ignored", (t) => {
  const { root, cleanup } = tmpdir();

  t.after(cleanup);

  writeFile(root, "BadName.md", commandDoc("description: Uppercase."));
  writeFile(root, "bad name.md", commandDoc("description: Space."));
  writeFile(root, "-leading.md", commandDoc("description: Leading dash."));
  writeFile(root, "_under.md", commandDoc("description: Leading underscore."));
  writeFile(root, "README.md", commandDoc("description: Upper-case stem."));
  writeFile(root, ".hidden.md", commandDoc("description: Dotfile."));
  writeFile(root, "ok-name.md", commandDoc("description: Hyphen."));
  writeFile(root, "ok_name.md", commandDoc("description: Underscore."));
  writeFile(root, "1st.md", commandDoc("description: Digit first."));

  const catalog = discoverCommands([root]);

  assert.deepEqual(names(catalog), ["1st", "ok-name", "ok_name"]);
  const invalid = catalog.diagnostics.filter((line) => line.includes("invalid command name"));
  assert.equal(invalid.length, 5, catalog.diagnostics.join("\n"));
  assert.ok(invalid.some((line) => line.includes('"BadName"')));
  assert.ok(invalid.some((line) => line.includes('"bad name"')));
  assert.ok(invalid.some((line) => line.includes('"-leading"')));
  assert.ok(invalid.some((line) => line.includes('"_under"')));
  assert.ok(invalid.some((line) => line.includes('"README"')));
  assert.ok(
    catalog.diagnostics.every((line) => line.startsWith(path.resolve(root))),
    catalog.diagnostics.join("\n"),
  );
});

test("frontmatter: quotes, comments, CRLF, unknown scalar keys and argument-hint", (t) => {
  const { root, cleanup } = tmpdir();
  t.after(cleanup);

  const raw = [
    "---",
    "description: 'Single quoted description' # trailing comment",
    'argument-hint: "<file> [--flag]"',
    "mode: WORK",
    "when-to-use: Ignored but harmless.",
    "owner: someone",
    "---",
    "",
    "Body.",
  ].join("\r\n");
  writeFile(root, "quoted.md", raw);

  const catalog = discoverCommands([root]);
  assert.deepEqual(names(catalog), ["quoted"]);
  assert.deepEqual(catalog.diagnostics, []);

  const [command] = catalog.commands;
  assert.equal(command.description, "Single quoted description");
  assert.equal(command.argumentHint, "<file> [--flag]");
  assert.equal(command.mode, "work");
  assert.equal(command.body, "Body.");
});

test("mode is optional; an invalid value is diagnosed and omitted", (t) => {
  const { root, cleanup } = tmpdir();
  t.after(cleanup);

  writeFile(root, "consult.md", commandDoc("description: Consult.\nmode: consult"));
  writeFile(
    root,
    "bad-mode.md",
    commandDoc("description: Bad mode.\nmode: everything"),
  );
  writeFile(root, "empty-mode.md", commandDoc("description: Empty.\nmode:"));

  const catalog = discoverCommands([root]);
  const byName = new Map(catalog.commands.map((command) => [command.name, command]));

  assert.equal(byName.get("consult")?.mode, "consult");
  assert.equal(byName.get("bad-mode")?.mode, undefined);
  assert.equal(byName.get("empty-mode")?.mode, undefined);

  const invalid = catalog.diagnostics.filter((line) => line.includes("invalid mode"));
  assert.equal(invalid.length, 1, catalog.diagnostics.join("\n"));
  assert.ok(invalid[0].includes('"everything"'), invalid[0]);
  assert.ok(invalid[0].includes("mode omitted"), invalid[0]);
});

test("nested and flow YAML lines are skipped with a diagnostic", (t) => {
  const { root, cleanup } = tmpdir();
  t.after(cleanup);

  const raw = [
    "---",
    "description: Has nested metadata.",
    "metadata:",
    "  owner: someone",
    "tags:",
    "  - one",
    "  - two",
    "extra: [a, b]",
    "block: |",
    "  line",
    "---",
    "",
    "Body.",
  ].join("\n");
  const file = writeFile(root, "nested.md", raw);

  const catalog = discoverCommands([root]);

  assert.deepEqual(names(catalog), ["nested"]);
  assert.equal(catalog.commands[0].description, "Has nested metadata.");
  assert.equal(catalog.commands[0].body, "Body.");

  const unsupported = catalog.diagnostics.filter((line) =>
    line.includes("unsupported frontmatter line skipped"),
  );
  assert.equal(unsupported.length, 6, catalog.diagnostics.join("\n"));
  assert.ok(unsupported.every((line) => line.startsWith(file)), catalog.diagnostics.join("\n"));
  assert.ok(unsupported.some((line) => line.includes("owner: someone")));
  assert.ok(unsupported.some((line) => line.includes("extra: [a, b]")));
  assert.ok(unsupported.some((line) => line.includes("block: |")));
});

test("missing description and missing frontmatter are diagnosed, not fatal", (t) => {
  const { root, cleanup } = tmpdir();
  t.after(cleanup);

  writeFile(root, "no-desc.md", commandDoc("argument-hint: <x>", "Body only."));
  writeFile(root, "bare.md", "# Only a body\n\nNo frontmatter here.");

  const catalog = discoverCommands([root]);

  assert.deepEqual(names(catalog), ["bare", "no-desc"]);
  const byName = new Map(catalog.commands.map((command) => [command.name, command]));
  assert.equal(byName.get("no-desc")?.description, "");
  assert.equal(byName.get("no-desc")?.body, "Body only.");
  assert.equal(byName.get("bare")?.description, "");
  assert.equal(byName.get("bare")?.body, "# Only a body\n\nNo frontmatter here.");
  assert.equal(
    catalog.diagnostics.filter((line) => line.includes("missing description")).length,
    2,
    catalog.diagnostics.join("\n"),
  );
  assert.equal(
    catalog.diagnostics.filter((line) => line.includes("missing frontmatter block")).length,
    1,
  );
});

test("unterminated fences and garbage never throw", (t) => {
  const { root, cleanup } = tmpdir();
  t.after(cleanup);

  writeFile(root, "half.md", "---\ndescription: No closing fence");
  writeFile(root, "garbage.md", "---\n\u0000\u0001\nno colon here\n---\nbody");

  const catalog = discoverCommands([root]);

  assert.deepEqual(names(catalog), ["garbage", "half"]);
  const byName = new Map(catalog.commands.map((command) => [command.name, command]));
  assert.equal(byName.get("half")?.description, "No closing fence");
  assert.equal(byName.get("half")?.body, "");
  assert.equal(byName.get("garbage")?.body, "body");
  assert.ok(catalog.diagnostics.some((line) => line.includes("half.md: unterminated frontmatter block")));
  assert.ok(
    catalog.diagnostics.some((line) =>
      line.includes("garbage.md: unsupported frontmatter line skipped"),
    ),
  );
});

test("expandCommand substitutes $ARGUMENTS, $1..$9 and $$ once, literally", () => {
  const command: Command = {
    name: "review",
    description: "Review.",
    argumentHint: "<paths>",
    file: "/tmp/review.md",
    body: "Review $ARGUMENTS\nfirst=$1 third=$3 ninth=$9 missing=$5 literal=$$HOME",
  };

  assert.equal(
    expandCommand(command, "a b c"),
    "Review a b c\nfirst=a third=c ninth= missing= literal=$HOME",
  );
  assert.equal(
    expandCommand(command, "1 2 3 4 5 6 7 8 9"),
    "Review 1 2 3 4 5 6 7 8 9\nfirst=1 third=3 ninth=9 missing=5 literal=$HOME",
  );

  // The whole remainder, verbatim, including extra whitespace.
  const argsOnly: Command = { ...command, body: "[$ARGUMENTS]" };
  assert.equal(expandCommand(argsOnly, "  padded   words  "), "[  padded   words  ]");
  assert.equal(expandCommand(argsOnly, ""), "[]");

  // No placeholders: the body is returned unchanged.
  const plain: Command = { ...command, body: "Nothing to expand." };
  assert.equal(expandCommand(plain, "ignored"), "Nothing to expand.");

  // Empty body.
  assert.equal(expandCommand({ ...command, body: "" }, "args"), "");
});

test("expandCommand does not re-expand substituted text or touch shell syntax", () => {
  const command: Command = {
    name: "echo",
    description: "",
    argumentHint: "",
    file: "/tmp/echo.md",
    body: "$ARGUMENTS",
  };

  assert.equal(expandCommand(command, "$1 $(rm -rf /) $$"), "$1 $(rm -rf /) $$");

  const positional: Command = { ...command, body: "$1/$2" };
  assert.equal(expandCommand(positional, "$2 x"), "$2/x");
});

test("expandCommand leaves $0, lone $ and $10+ literal; $$ARGUMENTS splits", () => {
  const command: Command = {
    name: "edge",
    description: "",
    argumentHint: "",
    file: "/tmp/edge.md",
    body: "[$10][$0][$][$$$ARGUMENTS]",
  };

  assert.equal(expandCommand(command, "a"), "[a0][$0][$][$a]");
});

test("matchCommand parses `/name rest...` and rejects non-commands", () => {
  assert.deepEqual(matchCommand("/review src/a.ts src/b.ts"), {
    name: "review",
    args: "src/a.ts src/b.ts",
  });
  assert.deepEqual(matchCommand("   /REVIEW  x  "), { name: "review", args: "x" });
  assert.deepEqual(matchCommand("/help"), { name: "help", args: "" });
  assert.deepEqual(matchCommand("/help   "), { name: "help", args: "" });
  assert.deepEqual(matchCommand("\t/review\ttabbed\targs\t"), {
    name: "review",
    args: "tabbed\targs",
  });
  assert.deepEqual(matchCommand("/multi line\ninput"), {
    name: "multi",
    args: "line\ninput",
  });
  assert.deepEqual(matchCommand("/keep  inner   spacing"), {
    name: "keep",
    args: "inner   spacing",
  });
  assert.deepEqual(matchCommand("/plan --flag=a:b"), { name: "plan", args: "--flag=a:b" });

  assert.equal(matchCommand(""), null);
  assert.equal(matchCommand("   "), null);
  assert.equal(matchCommand("/"), null);
  assert.equal(matchCommand("//comment"), null);
  assert.equal(matchCommand("/ cmd"), null);
  assert.equal(matchCommand("/usr/bin/env"), null);
  assert.equal(matchCommand("/-dash"), null);
  assert.equal(matchCommand("/_under"), null);
  assert.equal(matchCommand("/name!"), null);
  assert.equal(matchCommand("hello /review"), null);
  assert.equal(matchCommand("review args"), null);
});

test("missing roots are quiet, a non-directory root is diagnosed, duplicate roots collapse", (t) => {
  const { root, cleanup } = tmpdir();
  t.after(cleanup);

  writeFile(root, "one.md", commandDoc("description: One."));
  const strayFile = writeFile(root, "not-a-root.txt", "x");

  const catalog = discoverCommands([
    path.join(root, "does-not-exist"),
    root,
    root,
    path.join(root, ".", ""),
    strayFile,
  ]);

  assert.deepEqual(names(catalog), ["one"]);
  assert.equal(catalog.diagnostics.length, 1, catalog.diagnostics.join("\n"));
  assert.ok(catalog.diagnostics[0].includes("commands root is not a directory"));

  assert.deepEqual(discoverCommands([]), { commands: [], diagnostics: [] });
});

test("discovery is deterministic across repeated runs", (t) => {
  const { root, cleanup } = tmpdir();
  t.after(cleanup);

  const second = path.join(root, "second");
  writeFile(root, "a.md", commandDoc("description: A."));
  writeFile(root, "m.md", commandDoc("description: M."));
  writeFile(second, "a.md", commandDoc("description: Shadow."));
  writeFile(second, "README.md", commandDoc("description: Bad name."));
  writeFile(second, "z.md", "---\ndescription: Z.\nbad line\n---\nBody.");

  const first = discoverCommands([root, second]);
  const again = discoverCommands([root, second]);

  assert.deepEqual(first, again);
  assert.deepEqual(names(first), ["a", "m", "z"]);
  assert.equal(first.commands[0].description, "A.");

  // Diagnostics are stable in order, too.
  assert.deepEqual(first.diagnostics, again.diagnostics);
  assert.ok(first.diagnostics.some((line) => line.includes('duplicate command "a"')));
  assert.ok(first.diagnostics.some((line) => line.includes("unsupported frontmatter line skipped")));
});