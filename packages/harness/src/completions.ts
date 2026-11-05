/**
 * Shell completion script generator — pure, dependency-free, deterministic.
 *
 * The CLI owns the command surface (it builds a `CompletionSpec` from its
 * command table); this module only renders that spec into a script for one of
 * four shells. Nothing here touches the filesystem, env vars, or the network,
 * so the same input always produces byte-identical output.
 *
 * Per-shell behavior:
 *
 * - `bash` — a `COMPREPLY` function wired to the program with
 *   `complete -F`; `compgen -W` offers subcommand names and global flags until
 *   a subcommand is typed, then that subcommand's own flags plus the global
 *   flags. Bash has no portable per-match description mechanism, so
 *   descriptions are not rendered.
 * - `zsh` — a `#compdef` header (fpath-installable) plus an explicit
 *   `compdef` (sourceable/eval-able) and a function using `_describe` for the
 *   subcommands (with descriptions) and `compadd` for flags. It ends with the
 *   usual `funcstack` guard, so the same file works both sourced from
 *   `.zshrc`/`eval` and autoloaded from `$fpath`.
 * - `fish` — `complete -c` rules: `__fish_use_subcommand` gates the
 *   subcommand names, `__fish_seen_subcommand_from <cmd>` gates that
 *   subcommand's own flags, and global flags are unconditioned. Long flags
 *   become `-l name`, short flags `-s x`, old-style long flags `-o name`
 *   (anything else falls back to a literal `-a` candidate). A generated
 *   comment above each group lists the literal flag tokens for readability.
 * - `powershell` — `Register-ArgumentCompleter -Native` with a script block
 *   that reads the subcommand from the command AST and emits
 *   `System.Management.Automation.CompletionResult` objects (subcommands
 *   carry their description as the tooltip). The `-Native` parameter means
 *   PowerShell 7+.
 *
 * Contract (the CLI integration depends on these names):
 *
 * ```ts
 * COMPLETION_SHELLS: readonly CompletionShell[]   // bash, zsh, fish, powershell
 * generateCompletions(shell, spec): string
 * ```
 *
 * Escaping rules: the program name is quoted for the target shell whenever it
 * is not a plain word (`'…'` with `'\''` for bash/zsh, `\'` inside fish
 * single quotes, doubled `''` inside PowerShell single quotes); command
 * descriptions are single-quoted the same way, newlines/tabs are collapsed to
 * one space, and zsh `_describe` descriptions additionally escape backslashes
 * and colons. Command names and flags are the CLI's plain flag-like tokens
 * (`run`, `--verbose`) and are emitted as literal words — a spec carrying
 * whitespace inside a command/flag token degrades gracefully but is not a
 * supported token shape.
 *
 * Empty specs are valid: `{ program, commands: [] }` renders a script that
 * defines the shell's completion hook and completes nothing. Every script
 * ends with exactly one trailing newline and contains no `\r`.
 */

/** Shells `generateCompletions` can render, in stable order. */
export type CompletionShell = "bash" | "zsh" | "fish" | "powershell";

/** Every supported shell, in the order the CLI should list them. */
export const COMPLETION_SHELLS: readonly CompletionShell[] = [
  "bash",
  "zsh",
  "fish",
  "powershell",
];

/** One subcommand of the program. */
export interface CompletionCommand {
  /** Command name as typed on the command line, e.g. `run`. */
  name: string;
  /** One-line summary shown by shells that render descriptions. */
  description?: string;
  /** Flags this command accepts (global flags are supplied separately). */
  flags?: string[];
}

/** The command surface rendered into a completion script. */
export interface CompletionSpec {
  /** The executable name, e.g. `two-brothers`. */
  program: string;
  /** Subcommands, in display order. */
  commands: CompletionCommand[];
  /** Flags valid for every command (and before a command). */
  globalFlags?: string[];
}

/** A command after normalization (descriptions/tokens cleaned, flags deduped). */
interface NormalizedCommand {
  name: string;
  description: string;
  flags: string[];
}

/** A spec after normalization; the generators only ever see this shape. */
interface NormalizedSpec {
  program: string;
  commands: NormalizedCommand[];
  globalFlags: string[];
}

/** Characters safe to emit unquoted in bash/zsh/fish (not starting with `-`). */
const PLAIN_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** Collapse control characters/newlines to single spaces and trim. */
function oneLine(value: string | undefined): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/ {2,}/g, " ").trim();
}

/** Text safe to place after `#`: one line and no trailing line continuation. */
function commentText(value: string): string {
  return oneLine(value).replace(/\\+$/, "");
}

/** True when `value` can be emitted as a bare word for bash/zsh/fish. */
function isPlainWord(value: string): boolean {
  return value.length > 0 && PLAIN_WORD.test(value) && !value.startsWith("-");
}

/** POSIX single-quote (bash/zsh): `it's` → `'it'\''s'`. */
function posixQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Bare word when safe, POSIX single-quoted otherwise. */
function posixWord(value: string): string {
  return isPlainWord(value) ? value : posixQuote(value);
}

/** fish single-quote: only `\` and `'` need escaping inside single quotes. */
function fishQuote(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/** Bare word when safe, fish single-quoted otherwise. */
function fishWord(value: string): string {
  return isPlainWord(value) ? value : fishQuote(value);
}

/** PowerShell single-quote: `it's` → `'it''s'`. */
function powerShellQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Turn an arbitrary string into a safe shell identifier fragment. */
function identifier(value: string, fallback: string): string {
  let result = value.replace(/[^A-Za-z0-9_]/g, "_");
  if (result === "") result = fallback;
  if (!/^[A-Za-z_]/.test(result)) result = `_${result}`;
  return result;
}

/**
 * zsh completion functions conventionally match the `#compdef` file basename,
 * so keep hyphens (the fpath file is `_two-brothers`) and sanitize the rest.
 */
function zshFunctionName(program: string): string {
  const stem = program.replace(/[^A-Za-z0-9_-]/g, "_");
  return `_${stem === "" ? "program" : stem}`;
}

/** Deterministic, collision-free variable names (suffix `_2`, `_3`, …). */
function uniqueVariableNames(bases: readonly string[]): string[] {
  const used = new Set<string>();
  return bases.map((base) => {
    let candidate = base;
    let counter = 2;
    while (used.has(candidate)) {
      candidate = `${base}_${counter}`;
      counter += 1;
    }
    used.add(candidate);
    return candidate;
  });
}

/** Trim/reject empties, collapse to one line, and dedupe while keeping order. */
function cleanTokens(values: readonly string[] | undefined): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const value of values) {
    const token = oneLine(value);
    if (token === "" || seen.has(token)) continue;
    seen.add(token);
    tokens.push(token);
  }
  return tokens;
}

/** Normalize a caller-supplied spec; tolerant of empty/missing arrays. */
function normalizeSpec(spec: CompletionSpec): NormalizedSpec {
  const globalFlags = cleanTokens(spec.globalFlags);
  const globalSet = new Set(globalFlags);
  const seenCommands = new Set<string>();
  const commands: NormalizedCommand[] = [];
  for (const command of spec.commands ?? []) {
    const name = oneLine(command.name);
    if (name === "" || seenCommands.has(name)) continue;
    seenCommands.add(name);
    commands.push({
      name,
      description: oneLine(command.description),
      // Global flags are offered in every branch already; listing one again
      // under a command would just duplicate the candidate.
      flags: cleanTokens(command.flags).filter((flag) => !globalSet.has(flag)),
    });
  }
  return {
    program: typeof spec.program === "string" ? spec.program : "",
    commands,
    globalFlags,
  };
}

/** `# describe` entry for zsh's `_describe`: `word:description` with escapes. */
function zshDescribeItem(name: string, description: string): string {
  const item =
    description === ""
      ? escapeZshDescribe(name)
      : `${escapeZshDescribe(name)}:${escapeZshDescribe(description)}`;
  return posixQuote(item);
}

/** `_describe` treats `\` and `:` specially inside an item. */
function escapeZshDescribe(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/:/g, "\\:");
}

/** `_describe`'s user-visible label, e.g. `two-brothers commands`. */
function zshDescribeLabel(program: string): string {
  return posixQuote(`${oneLine(program) || "program"} commands`);
}

/** Join generated lines into the final script (exactly one trailing `\n`). */
function finish(lines: readonly string[]): string {
  return `${lines.join("\n")}\n`;
}

// ------------------------------------------------------------------------- //
// bash
// ------------------------------------------------------------------------- //

function bashScript(spec: NormalizedSpec): string {
  const stem = identifier(spec.program, "program");
  const functionName = `_${stem}_completions`;
  const commandVariables = uniqueVariableNames(
    spec.commands.map((command) => `flags_${identifier(command.name, "command")}`),
  );
  const commandWords = posixQuote(spec.commands.map((command) => command.name).join(" "));
  const globalWords = posixQuote(spec.globalFlags.join(" "));

  const lines: string[] = [];
  lines.push(`# bash completion for ${commentText(spec.program) || "program"}`);
  lines.push("# Generated by @two-brothers/harness — do not edit.");
  lines.push("");
  lines.push(`${functionName}() {`);
  lines.push("    local cur cmd i");
  lines.push('    cur="${COMP_WORDS[COMP_CWORD]}"');
  lines.push("");
  lines.push(`    local commands=${commandWords}`);
  lines.push(`    local global_flags=${globalWords}`);
  spec.commands.forEach((command, index) => {
    if (command.flags.length === 0) return;
    lines.push(`    local ${commandVariables[index]}=${posixQuote(command.flags.join(" "))}`);
  });
  lines.push("");
  lines.push('    cmd=""');
  lines.push("    for (( i = 1; i < COMP_CWORD; i++ )); do");
  lines.push('        case "${COMP_WORDS[i]}" in');
  lines.push("            -*) ;;");
  lines.push('            *) cmd="${COMP_WORDS[i]}"; break ;;');
  lines.push("        esac");
  lines.push("    done");
  lines.push("");
  lines.push('    if [[ -z "${cmd}" ]]; then');
  lines.push('        COMPREPLY=( $(compgen -W "${commands} ${global_flags}" -- "${cur}") )');
  lines.push("        return 0");
  lines.push("    fi");
  lines.push("");
  lines.push('    case "${cmd}" in');
  spec.commands.forEach((command, index) => {
    if (command.flags.length === 0) return;
    lines.push(
      `        ${posixQuote(command.name)}) COMPREPLY=( $(compgen -W "\${` +
        `${commandVariables[index]}} \${global_flags}" -- "\${cur}") ) ;;`,
    );
  });
  lines.push('        *) COMPREPLY=( $(compgen -W "${global_flags}" -- "${cur}") ) ;;');
  lines.push("    esac");
  lines.push("    return 0");
  lines.push("}");
  lines.push("");
  lines.push(`complete -o default -F ${functionName} -- ${posixWord(spec.program)}`);
  return finish(lines);
}

// ------------------------------------------------------------------------- //
// zsh
// ------------------------------------------------------------------------- //

function zshScript(spec: NormalizedSpec): string {
  const functionName = zshFunctionName(spec.program);
  const commandVariables = uniqueVariableNames(
    spec.commands.map((command) => `flags_${identifier(command.name, "command")}`),
  );
  const described = spec.commands
    .map((command, index) => ({ command, variable: commandVariables[index] }))
    .filter((entry) => entry.command.flags.length > 0);

  const lines: string[] = [];
  lines.push(`#compdef ${posixWord(spec.program)}`);
  lines.push(`# zsh completion for ${commentText(spec.program) || "program"}`);
  lines.push("# Generated by @two-brothers/harness — do not edit.");
  lines.push(`# Install as '${functionName}' in a directory in $fpath, or source it after compinit.`);
  lines.push("");
  lines.push(`compdef ${functionName} ${posixWord(spec.program)}`);
  lines.push("");
  lines.push(`${functionName}() {`);
  lines.push("    local -a commands global_flags");
  if (described.length > 0) {
    lines.push(`    local -a ${described.map((entry) => entry.variable).join(" ")}`);
  }
  lines.push("    local i sub");
  lines.push("");
  lines.push("    commands=(");
  for (const command of spec.commands) {
    lines.push(`        ${zshDescribeItem(command.name, command.description)}`);
  }
  lines.push("    )");
  lines.push("    global_flags=(");
  for (const flag of spec.globalFlags) {
    lines.push(`        ${posixQuote(flag)}`);
  }
  lines.push("    )");
  for (const entry of described) {
    lines.push(`    ${entry.variable}=(`);
    for (const flag of entry.command.flags) {
      lines.push(`        ${posixQuote(flag)}`);
    }
    lines.push("    )");
  }
  lines.push("");
  lines.push('    sub=""');
  lines.push("    for (( i = 2; i < CURRENT; i++ )); do");
  lines.push('        if [[ "${words[i]}" != -* ]]; then');
  lines.push('            sub="${words[i]}"');
  lines.push("            break");
  lines.push("        fi");
  lines.push("    done");
  lines.push("");
  lines.push('    if [[ -z "${sub}" ]]; then');
  if (spec.commands.length > 0) {
    lines.push(`        _describe -t commands ${zshDescribeLabel(spec.program)} commands`);
  }
  if (spec.globalFlags.length > 0) {
    lines.push('        compadd -- "${global_flags[@]}"');
  }
  lines.push("        return");
  lines.push("    fi");
  if (described.length > 0 || spec.globalFlags.length > 0) {
    lines.push("");
    lines.push('    case "${sub}" in');
    for (const entry of described) {
      const expansion = `"\${${entry.variable}[@]}"`;
      const globalExpansion = spec.globalFlags.length > 0 ? ' "${global_flags[@]}"' : "";
      lines.push(`        ${posixQuote(entry.command.name)}) compadd -- ${expansion}${globalExpansion} ;;`);
    }
    if (spec.globalFlags.length > 0) {
      lines.push('        *) compadd -- "${global_flags[@]}" ;;');
    }
    lines.push("    esac");
  }
  lines.push("}");
  lines.push("");
  lines.push(`if [[ "\${funcstack[1]}" == "${functionName}" ]]; then`);
  lines.push(`    ${functionName} "$@"`);
  lines.push("fi");
  return finish(lines);
}

// ------------------------------------------------------------------------- //
// fish
// ------------------------------------------------------------------------- //

/** One `complete -c` rule for a flag, using fish's native switch syntax. */
function fishFlagRule(program: string, flag: string, condition?: string): string {
  const prefix =
    condition === undefined
      ? `complete -c ${program}`
      : `complete -c ${program} -n ${fishQuote(condition)}`;
  const long = /^--([A-Za-z0-9][A-Za-z0-9_-]*)$/.exec(flag);
  if (long !== null) return `${prefix} -l ${long[1]}`;
  const short = /^-([A-Za-z0-9])$/.exec(flag);
  if (short !== null) return `${prefix} -s ${short[1]}`;
  const oldStyle = /^-([A-Za-z0-9][A-Za-z0-9_-]*)$/.exec(flag);
  if (oldStyle !== null) return `${prefix} -o ${oldStyle[1]}`;
  // Not a recognizable switch shape (e.g. `--opt=value`): offer it verbatim.
  return `${prefix} -a ${fishQuote(flag)}`;
}

function fishScript(spec: NormalizedSpec): string {
  const program = fishWord(spec.program);
  const lines: string[] = [];
  lines.push(`# fish completion for ${commentText(spec.program) || "program"}`);
  lines.push("# Generated by @two-brothers/harness — do not edit.");
  lines.push("");
  lines.push(`complete -c ${program} -f`);
  if (spec.commands.length > 0) {
    lines.push("");
    lines.push("# Commands (offered until a subcommand is typed).");
    for (const command of spec.commands) {
      let line = `complete -c ${program} -n '__fish_use_subcommand' -a ${fishQuote(command.name)}`;
      if (command.description !== "") {
        line += ` -d ${fishQuote(command.description)}`;
      }
      lines.push(line);
    }
  }
  if (spec.globalFlags.length > 0) {
    lines.push("");
    lines.push(`# Global flags: ${commentText(spec.globalFlags.join(" "))}`);
    for (const flag of spec.globalFlags) {
      lines.push(fishFlagRule(program, flag));
    }
  }
  for (const command of spec.commands) {
    if (command.flags.length === 0) continue;
    lines.push("");
    lines.push(`# ${commentText(command.name)} flags: ${commentText(command.flags.join(" "))}`);
    const condition = `__fish_seen_subcommand_from ${command.name}`;
    for (const flag of command.flags) {
      lines.push(fishFlagRule(program, flag, condition));
    }
  }
  return finish(lines);
}

// ------------------------------------------------------------------------- //
// powershell
// ------------------------------------------------------------------------- //

/** Append a PowerShell array assignment; `@()` for an empty list. */
function pushPowerShellArray(lines: string[], variable: string, values: readonly string[]): void {
  if (values.length === 0) {
    lines.push(`    ${variable} = @()`);
    return;
  }
  lines.push(`    ${variable} = @(`);
  values.forEach((value, index) => {
    const comma = index < values.length - 1 ? "," : "";
    lines.push(`        ${powerShellQuote(value)}${comma}`);
  });
  lines.push("    )");
}

function powerShellScript(spec: NormalizedSpec): string {
  const commandVariables = uniqueVariableNames(
    spec.commands.map((command) => `flags_${identifier(command.name, "command")}`),
  );
  const flagged = spec.commands
    .map((command, index) => ({ command, variable: commandVariables[index] }))
    .filter((entry) => entry.command.flags.length > 0);
  const described = spec.commands.filter((command) => command.description !== "");

  const lines: string[] = [];
  lines.push(`# PowerShell completion for ${commentText(spec.program) || "program"}`);
  lines.push("# Generated by @two-brothers/harness — do not edit.");
  lines.push("# Requires PowerShell 7+ (Register-ArgumentCompleter -Native).");
  lines.push("");
  lines.push(
    `Register-ArgumentCompleter -Native -CommandName ${powerShellQuote(spec.program)} -ScriptBlock {`,
  );
  lines.push("    param($wordToComplete, $commandAst, $cursorPosition)");
  lines.push("");
  pushPowerShellArray(
    lines,
    "$commands",
    spec.commands.map((command) => command.name),
  );
  if (described.length > 0) {
    lines.push("    $commandDescriptions = @{");
    for (const command of described) {
      lines.push(
        `        ${powerShellQuote(command.name)} = ${powerShellQuote(command.description)}`,
      );
    }
    lines.push("    }");
  }
  pushPowerShellArray(lines, "$globalFlags", spec.globalFlags);
  for (const entry of flagged) {
    pushPowerShellArray(
      lines,
      `$${entry.variable}`,
      entry.command.flags,
    );
  }
  lines.push("");
  lines.push("    $subcommand = $null");
  lines.push("    $elements = @($commandAst.CommandElements)");
  lines.push("    for ($i = 1; $i -lt $elements.Count; $i++) {");
  lines.push("        $text = $elements[$i].Extent.Text");
  lines.push("        if (-not $text.StartsWith('-')) {");
  lines.push("            $subcommand = $text.Replace(\"'\", '').Replace('\"', '')");
  lines.push("            break");
  lines.push("        }");
  lines.push("    }");
  lines.push("");
  lines.push("    if ($null -eq $subcommand) {");
  if (spec.commands.length > 0) {
    lines.push("        foreach ($command in $commands) {");
    lines.push('            if ($command -like "$wordToComplete*") {');
    if (described.length > 0) {
      lines.push("                $tooltip = $command");
      lines.push("                if ($commandDescriptions.ContainsKey($command)) {");
      lines.push("                    $tooltip = $commandDescriptions[$command]");
      lines.push("                }");
      lines.push(
        "                [System.Management.Automation.CompletionResult]::new($command, $command, 'Command', $tooltip)",
      );
    } else {
      lines.push(
        "                [System.Management.Automation.CompletionResult]::new($command, $command, 'Command', $command)",
      );
    }
    lines.push("            }");
    lines.push("        }");
  }
  if (spec.globalFlags.length > 0) {
    lines.push("        foreach ($flag in $globalFlags) {");
    lines.push('            if ($flag -like "$wordToComplete*") {');
    lines.push(
      "                [System.Management.Automation.CompletionResult]::new($flag, $flag, 'ParameterName', $flag)",
    );
    lines.push("            }");
    lines.push("        }");
  }
  lines.push("        return");
  lines.push("    }");
  lines.push("");
  if (flagged.length === 0) {
    lines.push("    $flags = @()");
  } else {
    flagged.forEach((entry, index) => {
      const keyword = index === 0 ? "if" : "} elseif";
      lines.push(`    ${keyword} ($subcommand -eq ${powerShellQuote(entry.command.name)}) {`);
      lines.push(`        $flags = $${entry.variable}`);
    });
    lines.push("    } else {");
    lines.push("        $flags = @()");
    lines.push("    }");
  }
  lines.push("");
  lines.push("    ($flags + $globalFlags) | ForEach-Object {");
  lines.push('        if ($_ -like "$wordToComplete*") {');
  lines.push(
    "            [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterName', $_)",
  );
  lines.push("        }");
  lines.push("    }");
  lines.push("}");
  return finish(lines);
}

// ------------------------------------------------------------------------- //
// public API
// ------------------------------------------------------------------------- //

/**
 * Render a completion script for `shell` from `spec`.
 *
 * Pure and deterministic: the same `(shell, spec)` pair always returns the
 * same string. The result is a complete, sourceable script ending with
 * exactly one newline.
 *
 * @throws {Error} when `shell` is not one of `COMPLETION_SHELLS`.
 */
export function generateCompletions(shell: CompletionShell, spec: CompletionSpec): string {
  const normalized = normalizeSpec(spec);
  switch (shell) {
    case "bash":
      return bashScript(normalized);
    case "zsh":
      return zshScript(normalized);
    case "fish":
      return fishScript(normalized);
    case "powershell":
      return powerShellScript(normalized);
    default:
      throw new Error(
        `unsupported completion shell '${String(shell)}' (expected one of ${COMPLETION_SHELLS.join(", ")})`,
      );
  }
}
