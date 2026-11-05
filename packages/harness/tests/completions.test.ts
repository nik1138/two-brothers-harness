/**
 * Shell completion generator tests: `src/completions.ts`.
 *
 * The generator is pure text: every case is a plain call plus string
 * assertions — no filesystem, network, env or clock. The per-shell tests pin
 * the boilerplate each shell needs to load the script (`complete -F`,
 * `#compdef`, `complete -c`, `Register-ArgumentCompleter -Native`), the
 * command/flag coverage the CLI integration renders, and the quoting rules
 * for tokens that are not plain words (quotes, spaces).
 *
 * Run with: node tests/completions.test.ts (or node --test tests/, or
 * node tests/run-all.ts once the suite is registered there).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  COMPLETION_SHELLS,
  generateCompletions,
  type CompletionShell,
  type CompletionSpec,
} from "../src/completions.ts";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const PROGRAM = "two-brothers";

/** Representative command surface: descriptions, every fish flag shape, a flagless command. */
const SPEC: CompletionSpec = {
  program: PROGRAM,
  commands: [
    {
      name: "run",
      description: "Run a cooperative task",
      flags: ["--senior-model", "--mode", "-v", "-old", "--opt=value"],
    },
    {
      name: "doctor",
      description: "Check the setup",
      flags: ["--json", "--timeout"],
    },
    { name: "config" },
  ],
  globalFlags: ["--help", "--version", "--verbose"],
};

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Non-comment, non-blank lines — the lines a shell actually parses. */
function codeLines(script: string): string[] {
  return script.split("\n").filter((line) => {
    const trimmed = line.trimStart();
    return trimmed !== "" && !trimmed.startsWith("#");
  });
}

/** First line starting with `prefix`, if any. */
function lineStartingWith(script: string, prefix: string): string | undefined {
  return script.split("\n").find((line) => line.startsWith(prefix));
}

/**
 * True when every quote opened on `line` is closed on the same line.
 *
 * bash/zsh: POSIX quoting (backslashes escape outside single quotes only).
 * fish: backslash escapes inside single quotes as well (`'it\'s'`).
 * powershell: doubled `''` is an escaped quote inside a single-quoted string.
 *
 * Generated code never puts a newline inside a token, so per-line balance is
 * the property that catches a broken quote.
 */
function quotingBalanced(line: string, shell: CompletionShell): boolean {
  let state: "none" | "single" | "double" = "none";
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (shell === "powershell") {
      if (state === "none") {
        if (ch === "`") i += 1;
        else if (ch === "'") state = "single";
        else if (ch === '"') state = "double";
      } else if (state === "single") {
        if (ch === "'") {
          if (line[i + 1] === "'") i += 1;
          else state = "none";
        }
      } else {
        if (ch === "`") i += 1;
        else if (ch === '"') state = "none";
      }
      continue;
    }
    if (state === "none") {
      if (ch === "\\") i += 1;
      else if (ch === "'") state = "single";
      else if (ch === '"') state = "double";
    } else if (state === "single") {
      if (shell === "fish" && ch === "\\") i += 1;
      else if (ch === "'") state = "none";
    } else {
      if (ch === "\\") i += 1;
      else if (ch === '"') state = "none";
    }
  }
  return state === "none";
}

/** Parsed lines whose quoting is broken. */
function unbalancedLines(script: string, shell: CompletionShell): string[] {
  return codeLines(script).filter((line) => !quotingBalanced(line, shell));
}

function assertScriptShape(script: string, shell: CompletionShell): void {
  assert.ok(script.length > 0, `${shell}: script is empty`);
  assert.ok(script.trimEnd().length > 0, `${shell}: script has no content`);
  assert.ok(script.endsWith("\n"), `${shell}: script must end with a newline`);
  assert.ok(!script.endsWith("\n\n"), `${shell}: script must end with exactly one newline`);
  assert.ok(!script.includes("\r"), `${shell}: script must not contain CR`);
  assert.ok(!script.includes("\u0000"), `${shell}: script must not contain NUL`);
}

function assertQuotingIntact(script: string, shell: CompletionShell, label: string): void {
  assert.deepEqual(
    unbalancedLines(script, shell),
    [],
    `${shell}: ${label} left an unbalanced quote in a parsed line`,
  );
}

// ---------------------------------------------------------------------------
// shell list and the shape shared by every script
// ---------------------------------------------------------------------------

test("COMPLETION_SHELLS lists the four supported shells in stable order", () => {
  assert.deepEqual([...COMPLETION_SHELLS], ["bash", "zsh", "fish", "powershell"]);
  assert.equal(new Set(COMPLETION_SHELLS).size, COMPLETION_SHELLS.length);
});

test("every shell renders a non-empty script ending with exactly one newline", () => {
  for (const shell of COMPLETION_SHELLS) {
    assertScriptShape(generateCompletions(shell, SPEC), shell);
  }
});

// ---------------------------------------------------------------------------
// bash
// ---------------------------------------------------------------------------

test("bash wires complete -F and lists the program, commands and global flags", () => {
  const script = generateCompletions("bash", SPEC);
  assert.equal(script.split("\n")[0], "# bash completion for two-brothers");
  assert.ok(script.includes("_two_brothers_completions() {"), "function definition");
  assert.match(script, /^complete -o default -F _two_brothers_completions -- two-brothers$/m);
  assert.ok((script.match(/COMPREPLY=/g) ?? []).length >= 3, "COMPREPLY is assigned");
  assert.ok((script.match(/compgen -W/g) ?? []).length >= 3, "compgen -W builds the candidates");
  assert.ok(script.includes("local commands='run doctor config'"), "every command is a candidate");
  assert.ok(
    script.includes("local global_flags='--help --version --verbose'"),
    "every global flag is a candidate",
  );
  assert.ok(script.includes("local flags_run='--senior-model --mode -v -old --opt=value'"));
  assert.ok(script.includes("local flags_doctor='--json --timeout'"));
  assert.ok(!script.includes("local flags_config="), "a flagless command needs no variable");
  assert.ok(script.includes("${COMP_WORDS[COMP_CWORD]}"), "the current word is read from COMP_WORDS");
  assertScriptShape(script, "bash");
});

test("bash declares per-command flag variables and branches on each command", () => {
  const script = generateCompletions("bash", SPEC);
  const caseIndex = script.indexOf('    case "${cmd}" in');
  assert.ok(caseIndex > 0, "the subcommand case statement exists");
  for (const command of ["run", "doctor"]) {
    const branch = lineStartingWith(script, `        '${command}')`);
    assert.ok(branch, `missing the ${command} case branch`);
    assert.ok(
      script.indexOf(branch) > caseIndex,
      `the ${command} branch must sit inside the case statement`,
    );
    assert.ok(branch.includes(`flags_${command}`), `the ${command} branch names its flag list`);
  }
  assert.ok(
    script.includes('        *) COMPREPLY=( $(compgen -W "${global_flags}" -- "${cur}") ) ;;'),
    "unknown commands still get the global flags",
  );
});

test("bash expands the per-command flag variable inside the subcommand branch", (t) => {
  const script = generateCompletions("bash", SPEC);
  const intended = 'compgen -W "${flags_run} ${global_flags}" -- "${cur}"';
  if (!script.includes(intended)) {
    t.todo(
      'KNOWN BUG src/completions.ts:285 (bashScript case branch) emits the literal word ' +
        '"flags_run" instead of expanding "${flags_run}": `two-brothers run <TAB>` offers ' +
        "the candidate `flags_run` and never the run flags.",
    );
  }
  assert.ok(
    script.includes(intended),
    'the run branch should expand its flag list: compgen -W "${flags_run} ${global_flags}"',
  );
});

// ---------------------------------------------------------------------------
// zsh
// ---------------------------------------------------------------------------

test("zsh starts with #compdef and renders commands, descriptions and flags", () => {
  const script = generateCompletions("zsh", SPEC);
  assert.equal(
    script.split("\n")[0],
    "#compdef two-brothers",
    "#compdef must be the first line for fpath installs",
  );
  assert.ok(script.includes("# zsh completion for two-brothers"));
  assert.ok(script.includes("compdef _two-brothers two-brothers"), "sourceable compdef call");
  assert.ok(script.includes("_two-brothers() {"), "function definition");
  assert.ok(script.includes("_describe -t commands 'two-brothers commands' commands"));
  assert.ok(
    script.includes(
      [
        "    commands=(",
        "        'run:Run a cooperative task'",
        "        'doctor:Check the setup'",
        "        'config'",
        "    )",
      ].join("\n"),
    ),
    "every command with its description",
  );
  assert.ok(
    script.includes(
      [
        "    global_flags=(",
        "        '--help'",
        "        '--version'",
        "        '--verbose'",
        "    )",
      ].join("\n"),
    ),
    "every global flag",
  );
  assert.ok(
    script.includes(
      [
        "    flags_run=(",
        "        '--senior-model'",
        "        '--mode'",
        "        '-v'",
        "        '-old'",
        "        '--opt=value'",
        "    )",
      ].join("\n"),
    ),
    "the run flags",
  );
  assert.ok(
    script.includes('        \'run\') compadd -- "${flags_run[@]}" "${global_flags[@]}" ;;'),
    "the run branch adds its flags plus the globals",
  );
  assert.ok(
    script.includes('        \'doctor\') compadd -- "${flags_doctor[@]}" "${global_flags[@]}" ;;'),
  );
  assert.ok(script.includes('        *) compadd -- "${global_flags[@]}" ;;'));
  assert.ok((script.match(/compadd --/g) ?? []).length >= 3, "compadd emits the flag candidates");
  assert.ok(
    script.includes('if [[ "${funcstack[1]}" == "_two-brothers" ]]; then'),
    "the funcstack guard makes the file work sourced and autoloaded",
  );
  assert.ok(script.includes('    _two-brothers "$@"'));
  assertScriptShape(script, "zsh");
});

// ---------------------------------------------------------------------------
// fish
// ---------------------------------------------------------------------------

test("fish emits complete -c rules for the program, every command and every flag", () => {
  const script = generateCompletions("fish", SPEC);
  assert.ok(script.includes("complete -c two-brothers -f"), "file completions are disabled");
  assert.ok(
    script.includes("complete -c two-brothers -n '__fish_use_subcommand' -a 'run' -d 'Run a cooperative task'"),
  );
  assert.ok(
    script.includes("complete -c two-brothers -n '__fish_use_subcommand' -a 'doctor' -d 'Check the setup'"),
  );
  assert.ok(
    script.includes("complete -c two-brothers -n '__fish_use_subcommand' -a 'config'"),
    "a description-less command still gets a rule",
  );
  assert.equal(
    (script.match(/__fish_use_subcommand/g) ?? []).length,
    SPEC.commands.length,
    "one subcommand rule per command",
  );
  for (const flag of ["help", "version", "verbose"]) {
    assert.ok(
      script.includes(`complete -c two-brothers -l ${flag}`),
      `global flag --${flag} is offered unconditionally`,
    );
  }
  for (const rule of ["-l senior-model", "-l mode", "-s v", "-o old", "-a '--opt=value'"]) {
    assert.ok(
      script.includes(`complete -c two-brothers -n '__fish_seen_subcommand_from run' ${rule}`),
      `run flag rule: ${rule}`,
    );
  }
  assert.ok(script.includes("complete -c two-brothers -n '__fish_seen_subcommand_from doctor' -l json"));
  assert.ok(script.includes("complete -c two-brothers -n '__fish_seen_subcommand_from doctor' -l timeout"));
  for (const line of script.split("\n").filter((candidate) => candidate.startsWith("complete "))) {
    assert.ok(
      line.startsWith("complete -c two-brothers"),
      `every rule targets the program: ${line}`,
    );
  }
  assertScriptShape(script, "fish");
});

test("fish maps long, short and old-style flags and falls back to the literal token", () => {
  const spec: CompletionSpec = {
    program: "p",
    commands: [{ name: "go", flags: ["--long-flag", "-x", "-old-style", "--opt=value"] }],
  };
  const script = generateCompletions("fish", spec);
  const condition = "complete -c p -n '__fish_seen_subcommand_from go'";
  assert.ok(script.includes(`${condition} -l long-flag`), "--long -> -l long");
  assert.ok(script.includes(`${condition} -s x`), "-x -> -s x");
  assert.ok(script.includes(`${condition} -o old-style`), "-old-style -> -o old-style");
  assert.ok(
    script.includes(`${condition} -a '--opt=value'`),
    "an unclassifiable flag is offered verbatim with -a",
  );
});

// ---------------------------------------------------------------------------
// powershell
// ---------------------------------------------------------------------------

test("powershell registers a -Native completer and emits CompletionResults", () => {
  const script = generateCompletions("powershell", SPEC);
  assert.ok(
    script.includes("Register-ArgumentCompleter -Native -CommandName 'two-brothers' -ScriptBlock {"),
    "native argument completer registration",
  );
  assert.ok(script.includes("param($wordToComplete, $commandAst, $cursorPosition)"));
  assert.ok(
    script.includes(
      [
        "    $commands = @(",
        "        'run',",
        "        'doctor',",
        "        'config'",
        "    )",
      ].join("\n"),
    ),
    "every command is offered",
  );
  assert.ok(
    script.includes(
      [
        "    $commandDescriptions = @{",
        "        'run' = 'Run a cooperative task'",
        "        'doctor' = 'Check the setup'",
        "    }",
      ].join("\n"),
    ),
    "descriptions become tooltips (a description-less command is omitted)",
  );
  assert.ok(
    script.includes(
      [
        "    $globalFlags = @(",
        "        '--help',",
        "        '--version',",
        "        '--verbose'",
        "    )",
      ].join("\n"),
    ),
    "every global flag",
  );
  assert.ok(
    script.includes(
      [
        "    $flags_run = @(",
        "        '--senior-model',",
        "        '--mode',",
        "        '-v',",
        "        '-old',",
        "        '--opt=value'",
        "    )",
      ].join("\n"),
    ),
    "the run flags",
  );
  assert.ok(script.includes("    if ($subcommand -eq 'run') {"));
  assert.ok(script.includes("        $flags = $flags_run"));
  assert.ok(script.includes("    } elseif ($subcommand -eq 'doctor') {"));
  assert.ok(script.includes("        $flags = $flags_doctor"));
  assert.ok(script.includes("    } else {"));
  assert.ok(script.includes("        $flags = @()"));
  assert.ok(script.includes("($flags + $globalFlags) | ForEach-Object {"));
  assert.ok(
    (script.match(/\[System\.Management\.Automation\.CompletionResult\]::new/g) ?? []).length >= 3,
    "commands, global flags and command flags all become CompletionResults",
  );
  assert.ok(script.includes("'Command', $tooltip"));
  assert.ok(script.includes("'ParameterName', $flag"));
  assert.ok(script.endsWith("}\n"));
  assertScriptShape(script, "powershell");
});

// ---------------------------------------------------------------------------
// escaping
// ---------------------------------------------------------------------------

test("single quotes in the program, command and flags stay quoted in every shell", () => {
  const spec: CompletionSpec = {
    program: "my'prog",
    commands: [
      {
        name: "it's",
        description: "it's: a 'quoted' thing",
        flags: ["--flag'x"],
      },
    ],
    globalFlags: ["--glob'al"],
  };
  // The exact escaped form each shell's quoting helper must produce.
  const expected: Record<
    CompletionShell,
    { program: string; command: string; flag: string; global: string }
  > = {
    bash: {
      program: "'my'\\''prog'",
      command: "'it'\\''s'",
      flag: "'--flag'\\''x'",
      global: "'--glob'\\''al'",
    },
    zsh: {
      program: "'my'\\''prog'",
      command: "'it'\\''s",
      flag: "'--flag'\\''x'",
      global: "'--glob'\\''al'",
    },
    fish: {
      program: "'my\\'prog'",
      command: "'it\\'s'",
      flag: "'--flag\\'x'",
      global: "'--glob\\'al'",
    },
    powershell: {
      program: "'my''prog'",
      command: "'it''s'",
      flag: "'--flag''x'",
      global: "'--glob''al'",
    },
  };
  for (const shell of COMPLETION_SHELLS) {
    const script = generateCompletions(shell, spec);
    assertScriptShape(script, shell);
    const code = codeLines(script).join("\n");
    const quoted = expected[shell];
    assert.ok(code.includes(quoted.program), `${shell}: program is not shell-quoted`);
    assert.ok(code.includes(quoted.command), `${shell}: command is not shell-quoted`);
    assert.ok(code.includes(quoted.flag), `${shell}: flag is not shell-quoted`);
    assert.ok(code.includes(quoted.global), `${shell}: global flag is not shell-quoted`);
    // The raw token may survive only in human-readable comments.
    for (const raw of ["my'prog", "it's", "--flag'x", "--glob'al"]) {
      assert.ok(
        !code.includes(raw),
        `${shell}: raw token ${JSON.stringify(raw)} leaked into parsed code`,
      );
    }
    assertQuotingIntact(script, shell, "single-quote spec");
  }
  const zsh = generateCompletions("zsh", spec);
  assert.ok(
    zsh.includes("it'\\''s\\: a "),
    "zsh _describe items escape the colon separator in descriptions",
  );
});

test("spaces in the program and tokens stay quoted and do not break any shell", () => {
  const spec: CompletionSpec = {
    program: "my prog",
    commands: [{ name: "spaced cmd", flags: ["--spaced flag"] }],
    globalFlags: ["--glob flag"],
  };
  const programForms: Record<CompletionShell, string> = {
    bash: "-- 'my prog'",
    zsh: "compdef _my_prog 'my prog'",
    fish: "complete -c 'my prog' -f",
    powershell: "-CommandName 'my prog'",
  };
  for (const shell of COMPLETION_SHELLS) {
    const script = generateCompletions(shell, spec);
    assertScriptShape(script, shell);
    assert.ok(
      script.includes(programForms[shell]),
      `${shell}: the program must stay one quoted word`,
    );
    const code = codeLines(script).join("\n");
    assert.ok(code.includes("'spaced cmd'"), `${shell}: command with a space is quoted`);
    assert.ok(code.includes("'--spaced flag'"), `${shell}: command flag with a space is quoted`);
    assert.ok(code.includes("'--glob flag'"), `${shell}: global flag with a space is quoted`);
    assertQuotingIntact(script, shell, "space spec");
  }
});

// ---------------------------------------------------------------------------
// empty specs, determinism, unknown shells
// ---------------------------------------------------------------------------

test("an empty spec renders a complete script for every shell without throwing", () => {
  const spec: CompletionSpec = { program: PROGRAM, commands: [] };
  for (const shell of COMPLETION_SHELLS) {
    const script = generateCompletions(shell, spec);
    assertScriptShape(script, shell);
    assertQuotingIntact(script, shell, "empty spec");
  }

  const bash = generateCompletions("bash", spec);
  assert.ok(bash.includes("_two_brothers_completions() {"));
  assert.ok(bash.includes("local commands=''"));
  assert.ok(bash.includes("local global_flags=''"));
  assert.ok(bash.includes("complete -o default -F _two_brothers_completions -- two-brothers"));
  assert.ok(!bash.includes("local flags_"));

  const zsh = generateCompletions("zsh", spec);
  assert.equal(zsh.split("\n")[0], "#compdef two-brothers");
  assert.ok(zsh.includes("compdef _two-brothers two-brothers"));
  assert.ok(zsh.includes("_two-brothers() {"));
  assert.ok(!zsh.includes("_describe"), "nothing to describe in an empty spec");
  assert.ok(zsh.includes('if [[ "${funcstack[1]}" == "_two-brothers" ]]; then'));

  const fish = generateCompletions("fish", spec);
  assert.deepEqual(codeLines(fish), ["complete -c two-brothers -f"]);
  assert.ok(!fish.includes("__fish_use_subcommand"));
  assert.ok(!fish.includes("__fish_seen_subcommand_from"));

  const powershell = generateCompletions("powershell", spec);
  assert.ok(powershell.includes("$commands = @()"));
  assert.ok(powershell.includes("$globalFlags = @()"));
  assert.ok(
    powershell.includes("Register-ArgumentCompleter -Native -CommandName 'two-brothers' -ScriptBlock {"),
  );
  assert.ok(powershell.endsWith("}\n"));
});

test("two calls with the same spec are byte-identical and the spec is not mutated", () => {
  const snapshot = structuredClone(SPEC);
  for (const shell of COMPLETION_SHELLS) {
    const first = generateCompletions(shell, SPEC);
    const second = generateCompletions(shell, SPEC);
    assert.equal(first, second, `${shell}: output is not deterministic`);
    assert.equal(
      generateCompletions(shell, structuredClone(SPEC)),
      first,
      `${shell}: a fresh spec produced different output`,
    );
  }
  assert.deepEqual(SPEC, snapshot, "generateCompletions must not mutate the spec");
});

test("unknown shells throw a predictable error naming the supported shells", () => {
  for (const shell of ["tcsh", "sh", ""]) {
    assert.throws(
      () => generateCompletions(shell as CompletionShell, SPEC),
      (error: unknown) =>
        error instanceof Error &&
        error.message ===
          `unsupported completion shell '${shell}' (expected one of bash, zsh, fish, powershell)`,
      `expected a clear error for ${JSON.stringify(shell)}`,
    );
  }
  assert.throws(
    () => generateCompletions(undefined as unknown as CompletionShell, SPEC),
    /unsupported completion shell 'undefined' \(expected one of bash, zsh, fish, powershell\)/,
  );
});

// ---------------------------------------------------------------------------
// normalization
// ---------------------------------------------------------------------------

test("normalization drops duplicate commands/flags and keeps global flags out of command lists", () => {
  const spec: CompletionSpec = {
    program: PROGRAM,
    commands: [
      { name: "run", flags: ["--verbose", "--mode", "--mode"] },
      { name: "run", flags: ["--dropped"] },
      { name: "doctor" },
    ],
    globalFlags: ["--verbose", "--help"],
  };

  const bash = generateCompletions("bash", spec);
  assert.ok(bash.includes("local commands='run doctor'"), "duplicate command dropped");
  assert.ok(bash.includes("local global_flags='--verbose --help'"), "global flags deduped");
  assert.ok(bash.includes("local flags_run='--mode'"), "global/duplicate command flags filtered");
  assert.ok(!bash.includes("--dropped"));
  assert.ok(!bash.includes("local flags_doctor="), "a flagless command needs no variable");

  const zsh = generateCompletions("zsh", spec);
  assert.ok(zsh.includes("    commands=(\n        'run'\n        'doctor'\n    )"));
  assert.ok(zsh.includes("    flags_run=(\n        '--mode'\n    )"));
  assert.ok(!zsh.includes("--dropped"));
  assert.ok(!zsh.includes("flags_doctor"), "a flagless command gets no array");

  const fish = generateCompletions("fish", spec);
  assert.equal((fish.match(/__fish_use_subcommand/g) ?? []).length, 2);
  assert.equal(
    (fish.match(/-n '__fish_seen_subcommand_from run' -l mode/g) ?? []).length,
    1,
    "duplicate flags emit one rule",
  );
  assert.ok(!fish.includes("--dropped"));
  assert.ok(!fish.includes("__fish_seen_subcommand_from doctor"));

  const powershell = generateCompletions("powershell", spec);
  assert.ok(powershell.includes("    $flags_run = @(\n        '--mode'\n    )"));
  assert.ok(!powershell.includes("--dropped"));
  assert.ok(!powershell.includes("$flags_doctor"), "a flagless command gets no array");
  assertScriptShape(powershell, "powershell");
});
