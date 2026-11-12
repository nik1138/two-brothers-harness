/**
 * Slash commands: markdown prompt templates discovered from `commands/` roots.
 *
 * A command is a flat `<name>.md` file directly inside a commands root. Its
 * frontmatter carries `description`, `argument-hint` and an optional `mode`,
 * and its body is the prompt template. Typing `/name args` in a REPL expands
 * the template and submits the result as the user task — the template is a
 * normal user message, not a new control channel (kimi-code's plugin command
 * model; see `research/harnesses/plugins-kimi-code.md` §1.7 and opencode's
 * markdown command files with a `template` body in
 * `research/harnesses/plugins-opencode.md` §1.8).
 *
 * This module mirrors `skills.ts` deliberately, so both discovery layers read
 * the same way: sync fs, a hand-rolled zero-dependency frontmatter parser
 * (a `---` fence and simple `key: value` scalar lines only), fail-soft
 * discovery whose problems land in `diagnostics` instead of throwing, and
 * `name`-sorted output for deterministic prompt bytes/tests. Root order is
 * caller priority; the first root wins a name collision and later copies are
 * reported as shadowed, exactly like skills.
 *
 * Differences from skills, and why:
 * - Commands are **flat**: only `<root>/<name>.md` counts, nested files are
 *   ignored (opencode scans nested `command/` trees, but a flat catalogue is
 *   easier to list in `/help` and to keep collision-free).
 * - The **file stem is the command name**; there is no frontmatter `name`
 *   override. A stem that does not match `^[a-z0-9][a-z0-9_-]*$` is skipped
 *   with a diagnostic.
 * - There is no scope: a command is an operator-side input template, so it
 *   applies to both brothers alike. `mode` (optional) is the cooperation mode
 *   the expanded task runs in.
 * - `when-to-use` is accepted and ignored silently for forward compatibility
 *   (other markdown frontmatters in the ecosystem carry it); every other
 *   unknown *scalar* key is ignored the same way. Lines the hand-rolled parser
 *   cannot represent (indented YAML, sequences, flow/block collections) are
 *   skipped with a diagnostic, never a throw.
 *
 * Expansion is **literal text only**: `expandCommand` substitutes
 * placeholders once and never re-expands the substituted text, never runs a
 * shell, and never touches the filesystem. `$ARGUMENTS` is the whole input as
 * given, `$1`..`$9` are the whitespace-split input (missing positions become
 * the empty string), and `$$` yields a literal `$`. A lone `$`, `$0` and
 * `$10+` are left literal (`$10` reads as `$1` followed by `0`).
 *
 * Wiring (CLI chat REPL dispatch, `GET /api/commands`, default root discovery)
 * is a later lane; this module performs no root resolution of its own.
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** One discovered slash command. */
export interface Command {
  /** File stem, `[a-z0-9][a-z0-9_-]*` (validated at discovery). */
  name: string;
  /** Frontmatter `description`; `""` when missing (a diagnostic is recorded). */
  description: string;
  /** Frontmatter `argument-hint`, shown beside the name in `/help`; default `""`. */
  argumentHint: string;
  /**
   * Optional frontmatter `mode`: the cooperation mode the expanded command
   * runs in. Absent when the key is missing/empty or its value is invalid
   * (an invalid value is diagnosed and omitted).
   */
  mode?: "consult" | "work" | "auto";
  /** Absolute path of the `<name>.md` file. */
  file: string;
  /** Markdown after the frontmatter fence — the prompt template. */
  body: string;
}

/** Result of discovery: usable commands plus human-readable problems. */
export interface CommandCatalog {
  /** Sorted by `name` — deterministic for `/help` bytes and tests. */
  commands: Command[];
  /** Skips, duplicate-name shadows and parse problems; never thrown. */
  diagnostics: string[];
}

/** Parsed document (frontmatter + body) used by discovery. */
interface ParsedCommandDocument {
  /** Scalar `key: value` pairs, keys lowercased, values unquoted. */
  fields: Record<string, string>;
  body: string;
  diagnostics: string[];
}

const FENCE = "---";
const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;
const COMMAND_EXT = ".md";
const MODES: ReadonlySet<string> = new Set(["consult", "work", "auto"]);
const EXCLUDED_DIRS: ReadonlySet<string> = new Set(["node_modules"]);

/** Stable, locale-independent ordering. */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function messageOf(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

/**
 * Parse a command file's frontmatter and body. Never throws: anything the
 * hand-rolled parser cannot understand becomes a diagnostic.
 *
 * Supported: a leading `---` line, simple `key: value` scalar lines, an
 * optional trailing `# comment`, single- or double-quoted values, a closing
 * `---` fence. Not supported (diagnosed and skipped): indented lines, `-`
 * list items, flow/block collections (`[...]`, `{...}`, `|`, `>`).
 */
function parseCommandDocument(raw: string): ParsedCommandDocument {
  const text = raw.startsWith("\uFEFF") ? raw.slice(1) : raw;
  const lines = text.split(/\r?\n/);
  const diagnostics: string[] = [];
  const fields: Record<string, string> = {};

  if (lines.length === 0 || lines[0].trim() !== FENCE) {
    diagnostics.push("missing frontmatter block");
    return { fields, diagnostics, body: text.replace(/^\n+/, "").trimEnd() };
  }

  let close = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === FENCE) {
      close = i;
      break;
    }
  }
  if (close === -1) diagnostics.push("unterminated frontmatter block");

  const frontmatter = close === -1 ? lines.slice(1) : lines.slice(1, close);
  for (const line of frontmatter) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    // Indented lines are YAML nesting; `-` lines are YAML sequences.
    if (line !== line.trimStart() || trimmed.startsWith("-")) {
      diagnostics.push(`unsupported frontmatter line skipped: ${trimmed}`);
      continue;
    }
    const colon = trimmed.indexOf(":");
    if (colon <= 0) {
      diagnostics.push(`unsupported frontmatter line skipped: ${trimmed}`);
      continue;
    }
    const key = trimmed.slice(0, colon).trim().toLowerCase();
    const rawValue = trimmed.slice(colon + 1).trim();
    if (key === "") {
      diagnostics.push(`unsupported frontmatter line skipped: ${trimmed}`);
      continue;
    }
    if (/^[|>\[\{]/.test(rawValue)) {
      diagnostics.push(`unsupported frontmatter line skipped: ${trimmed}`);
      continue;
    }
    fields[key] = unquoteValue(rawValue);
  }

  const body = (close === -1 ? [] : lines.slice(close + 1))
    .join("\n")
    .replace(/^\n+/, "")
    .trimEnd();
  return { fields, diagnostics, body };
}

/** Strip matching quotes (ignoring trailing text) or a trailing comment. */
function unquoteValue(raw: string): string {
  if (raw.startsWith('"') || raw.startsWith("'")) {
    const quote = raw[0];
    const end = raw.indexOf(quote, 1);
    return end === -1 ? raw.slice(1) : raw.slice(1, end);
  }
  const comment = raw.search(/\s#/);
  return (comment === -1 ? raw : raw.slice(0, comment)).trim();
}

/** Directory/file kind of a dirent, following symlinks when needed. */
function entryKind(entry: fs.Dirent, fullPath: string): "dir" | "file" | null {
  if (entry.isDirectory()) return "dir";
  if (entry.isFile()) return "file";
  try {
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) return "dir";
    if (stat.isFile()) return "file";
  } catch {
    return null;
  }
  return null;
}

interface DiscoveryState {
  byName: Map<string, Command>;
  diagnostics: string[];
}

/**
 * Load one command file into the catalog. Every failure path records a
 * diagnostic instead of throwing. `name` is the file stem and is validated
 * before the file is read.
 */
function loadCommandFile(file: string, name: string, state: DiscoveryState): void {
  const resolved = path.resolve(file);
  if (!NAME_RE.test(name)) {
    state.diagnostics.push(`${resolved}: invalid command name "${name}"; command skipped`);
    return;
  }

  let raw: string;
  try {
    raw = fs.readFileSync(resolved, "utf8");
  } catch (exc) {
    state.diagnostics.push(`${resolved}: cannot read command file: ${messageOf(exc)}`);
    return;
  }

  const parsed = parseCommandDocument(raw);
  for (const diagnostic of parsed.diagnostics) {
    state.diagnostics.push(`${resolved}: ${diagnostic}`);
  }

  const description = parsed.fields.description ?? "";
  if (description === "") {
    state.diagnostics.push(`${resolved}: missing description in frontmatter`);
  }

  let mode: Command["mode"];
  const rawMode = (parsed.fields.mode ?? "").trim().toLowerCase();
  if (rawMode !== "") {
    if (MODES.has(rawMode)) {
      mode = rawMode as Command["mode"];
    } else {
      state.diagnostics.push(
        `${resolved}: invalid mode "${parsed.fields.mode}"; mode omitted`,
      );
    }
  }

  const command: Command = {
    name,
    description,
    argumentHint: parsed.fields["argument-hint"] ?? "",
    file: resolved,
    body: parsed.body,
  };
  if (mode !== undefined) command.mode = mode;

  const winner = state.byName.get(name);
  if (winner !== undefined) {
    state.diagnostics.push(
      `${resolved}: duplicate command "${name}"; shadowed by ${winner.file}`,
    );
    return;
  }
  state.byName.set(name, command);
}

/**
 * Scan one commands root. Flat only: `.md` files directly in the root are
 * candidates; subdirectories, `node_modules`, dotfiles and non-`.md` files
 * are ignored. Entries are visited in sorted order so diagnostics are
 * deterministic.
 */
function scanRoot(root: string, state: DiscoveryState): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (exc) {
    state.diagnostics.push(`${root}: cannot read commands root: ${messageOf(exc)}`);
    return;
  }
  entries.sort((a, b) => compareStrings(a.name, b.name));

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (EXCLUDED_DIRS.has(entry.name)) continue;
    if (!entry.name.endsWith(COMMAND_EXT)) continue;
    const fullPath = path.join(root, entry.name);
    if (entryKind(entry, fullPath) !== "file") continue;
    loadCommandFile(fullPath, entry.name.slice(0, -COMMAND_EXT.length), state);
  }
}

/**
 * Discover commands under every root, in priority order. Roots may be
 * relative; duplicates (by resolved path) are collapsed, a missing root is
 * not an error, and a root that exists but is not a directory is reported.
 * Duplicate command names resolve to the first discovered command; later ones
 * are shadowed with a diagnostic. The returned list is sorted by name.
 */
export function discoverCommands(roots: string[]): CommandCatalog {
  const byName = new Map<string, Command>();
  const diagnostics: string[] = [];
  const state: DiscoveryState = { byName, diagnostics };
  const seenRoots = new Set<string>();

  for (const root of roots) {
    const rootPath = path.resolve(root);
    const dedupeKey = process.platform === "win32" ? rootPath.toLowerCase() : rootPath;
    if (seenRoots.has(dedupeKey)) continue;
    seenRoots.add(dedupeKey);

    let stat: fs.Stats;
    try {
      stat = fs.statSync(rootPath);
    } catch (exc) {
      const code = (exc as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        diagnostics.push(`${rootPath}: cannot read commands root: ${messageOf(exc)}`);
      }
      continue;
    }
    if (!stat.isDirectory()) {
      diagnostics.push(`${rootPath}: commands root is not a directory`);
      continue;
    }
    scanRoot(rootPath, state);
  }

  const commands = [...byName.values()].sort((a, b) => compareStrings(a.name, b.name));
  return { commands, diagnostics };
}

/**
 * Expand a prompt-template body for one invocation.
 *
 * Substitution is literal text, in a single pass:
 * - `$ARGUMENTS` → `input` exactly as given (the whole remainder),
 * - `$1`..`$9` → the whitespace-split `input` (missing positions → `""`),
 * - `$$` → a literal `$`.
 *
 * A lone `$`, `$0`, and `$10`+ are left as written (`$10` is `$1` + `0`).
 * Substituted argument text is never rescanned, so an argument containing
 * `$1` stays literal, and no shell or nested command expansion happens.
 *
 * Shared by discovered commands ({@link expandCommand}) and first-party base
 * commands (`basecommands.ts::expandBaseCommand`): both kinds are plain
 * operator input templates, so the same body and the same input must produce
 * exactly the same task bytes on every surface.
 */
export function expandTemplate(body: string, input: string): string {
  const positional = input.trim().split(/\s+/).filter((token) => token !== "");
  return body.replace(/\$(\$|ARGUMENTS|[1-9])/g, (_match, token: string) => {
    if (token === "$") return "$";
    if (token === "ARGUMENTS") return input;
    return positional[Number(token) - 1] ?? "";
  });
}

/**
 * Expand a discovered command body for one invocation
 * ({@link expandTemplate}'s rules).
 */
export function expandCommand(command: Command, input: string): string {
  return expandTemplate(command.body, input);
}

/**
 * Parse a REPL input line of the form `/name rest...` into a command name and
 * its argument string, or `null` when the line is not a slash command.
 *
 * Leading whitespace is allowed; the name is lowercased for catalogue lookup.
 * The name must be the first token and follow the same charset as discovery
 * (`[A-Za-z0-9][A-Za-z0-9_-]*`), so `/usr/bin` or `/-x` is not a command.
 * `args` is the remainder with leading/trailing whitespace removed; inner
 * whitespace is preserved. `/name` with no arguments yields `args: ""`.
 * No root resolution or catalogue lookup happens here — the wiring lane
 * resolves the name against its `CommandCatalog` (an unknown name is its
 * problem to report).
 */
export function matchCommand(input: string): { name: string; args: string } | null {
  const line = input.replace(/^\s+/, "");
  if (!line.startsWith("/")) return null;
  const match = /^([A-Za-z0-9][A-Za-z0-9_-]*)(?:\s+([\s\S]*))?$/.exec(line.slice(1));
  if (match === null) return null;
  return { name: match[1].toLowerCase(), args: (match[2] ?? "").trim() };
}