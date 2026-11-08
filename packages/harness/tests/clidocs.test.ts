/**
 * Docs ↔ CLI drift guard (wave 13; per-command coverage added in wave 14).
 *
 * `docs/cli-reference.md` is the user-facing contract for the command-line
 * surface. This hermetic test keeps it honest against the code-owned catalogue
 * in `src/clihelp.ts`, so a new flag/env var cannot ship undocumented and a
 * removed or wrongly-scoped one cannot linger in the docs.
 *
 * What is compared:
 * - ENV VARS: the two-way set between the docs' "Environment variables" table
 *   and `ENVIRONMENT` in `src/clihelp.ts`. The docs table's "Corresponding
 *   flag" column scopes the reverse direction: a row that maps to a flag is
 *   part of the help catalogue and must be listed there; a row whose mapping is
 *   "—" documents a runtime-only env var (legacy plugin aliases, the confined
 *   shell PATH override) that intentionally lives outside `help --all`. The
 *   catalogue-to-docs direction covers every catalogue variable.
 * - FLAG MAPPINGS: each catalogue env var's flag must still be the flag the
 *   docs row names, so the docs cannot point at the wrong option.
 * - FLAGS (global): the union of every markdown table whose header has a `Flag`
 *   column against the long flags accepted by `run` / `chat` / `tui` / `serve`
 *   (`acceptedFlags ?? flags` in `src/clihelp.ts`). `--help` is excluded from
 *   the required set because every command documents it once as a global
 *   invocation rather than in a table.
 * - FLAGS (per command, wave 14): a flag table sitting under a command heading
 *   is scoped to that command — every flag it documents must be in that
 *   command's `acceptedFlags ?? flags`, and (for run/chat/tui/serve) every
 *   accepted flag must be documented either in the command's own table or in
 *   the shared top-level `## Flags` table (the document's common pool). The
 *   only command-scoped flag table today is `### serve`'s options table; the
 *   other commands document their flags in the shared table. This catches a
 *   flag that exists in the global catalogue but is documented for a command
 *   that does not accept it, and a flag accepted by one command but documented
 *   only under a different command.
 * - COMMANDS (one direction, tolerant): every command in `COMMAND_ORDER` except
 *   `help` must appear as a heading (`#`–`####`) in the reference; `help`
 *   itself is described in the global prose.
 *
 * Explicitly NOT covered (kept accurate on purpose):
 * - flag mentions in prose or code examples outside `Flag` tables are not
 *   audited (examples are noisy and not normative);
 * - flags listed in a table without a `Flag` header, and env rows with a "—"
 *   mapping, are outside the per-command/catalogue comparisons;
 * - `--help` is covered once globally, not per command;
 * - per-command audits only run where a `Flag` table sits under a heading that
 *   names a command (the rest of the document uses usage lines, which are
 *   prose, not tables);
 * - the shared `## Flags` table is a common documentation pool for
 *   run/chat/tui/serve, not a claim that every flag in it applies to all four
 *   commands (the table itself carries per-row "(… only)" scoping notes that
 *   this test does not parse).
 *
 * Parsing is deliberately tolerant: headings and tables are recognized outside
 * fenced code blocks, table cells may be backticked or bare, row order and
 * whitespace are irrelevant, escaped pipes are handled, and non-flag prose is
 * ignored. Missing docs (a bare npm tarball) skip the suite with a clear
 * message instead of failing.
 *
 * Failure messages are sorted set diffs: "…documented in docs/cli-reference.md
 * but unknown to clihelp.ts::FLAGS: --bogus", and per command
 * "serve: documented-but-not-accepted: --workspace; accepted-but-undocumented:
 * --host". Set order is sorted, so the output is stable.
 *
 * Run with: node --test tests/clidocs.test.ts (or node tests/run-all.ts)
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  COMMAND_ORDER,
  ENVIRONMENT,
  FLAGS,
  allFlagNames,
  commandHelp,
} from "../src/clihelp.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
/** Repo root: `packages/harness/tests` is three levels below the checkout root. */
const repoRoot = path.resolve(here, "..", "..", "..");
const docsPath = path.join(repoRoot, "docs", "cli-reference.md");

/**
 * Why this suite must skip (packaged tarball without the repo docs), or `false`
 * when the reference is present. Extracted so the skip path itself is testable
 * without moving the real file.
 */
function docsSkipReason(file: string): string | false {
  return fs.existsSync(file)
    ? false
    : `docs/cli-reference.md not found at ${file} (skipping outside a checkout)`;
}

const docsMissingReason = docsSkipReason(docsPath);

// ---------------------------------------------------------------------------
// tolerant markdown parsing
// ---------------------------------------------------------------------------

/** One markdown heading outside code fences. */
interface MarkdownHeading {
  level: number;
  text: string;
}

/** One markdown table plus the nearest heading that precedes it. */
interface MarkdownTable {
  /** 1-based line of the header row, for actionable failure messages. */
  line: number;
  headers: string[];
  rows: string[][];
  /** Nearest non-fenced heading text (null before the first heading). */
  section: string | null;
}

/** Split one table row into trimmed cells, tolerating `\|` escapes. */
function splitTableRow(line: string): string[] {
  const text = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return text.split(/(?<!\\)\|/).map((cell) => cell.replace(/\\\|/g, "|").trim());
}

/** True for a markdown table separator row (`|---|---|`, `|:--:|---|`, …). */
function isSeparatorRow(cells: readonly string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

/** Ping-pong toggle for fenced code blocks (``` or ~~~); returns the new state. */
function toggleFence(line: string, inFence: boolean): boolean {
  return line.trimStart().startsWith("```") || line.trimStart().startsWith("~~~")
    ? !inFence
    : inFence;
}

/**
 * Parse every markdown table in the document, each tagged with the nearest
 * heading outside fenced code blocks. Tables are contiguous runs of
 * `|`-prefixed lines; the first row is the header, the second (a separator) is
 * dropped, the rest are body rows. Anything that does not start with `|` ends
 * the table, so prose and code fences are naturally ignored (a `#` comment
 * inside a shell example is NOT a heading).
 */
function parseMarkdownTables(markdown: string): MarkdownTable[] {
  const lines = markdown.split(/\r?\n/);
  const tables: MarkdownTable[] = [];
  let nearestHeading: string | null = null;
  let inFence = false;
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    const wasInFence = inFence;
    inFence = toggleFence(line, inFence);
    if (!wasInFence && !inFence) {
      const heading = /^(#{1,6})\s+(.+)$/.exec(line);
      if (heading !== null) nearestHeading = heading[2]!.trim();
      if (!line.trimStart().startsWith("|")) {
        index += 1;
        continue;
      }
      const start = index;
      const linesOfTable: Array<{ line: number; text: string }> = [];
      while (
        index < lines.length &&
        !inFence &&
        (lines[index] ?? "").trimStart().startsWith("|")
      ) {
        linesOfTable.push({ line: index + 1, text: lines[index] ?? "" });
        index += 1;
      }
      if (linesOfTable.length >= 2) {
        const headers = splitTableRow(linesOfTable[0]!.text);
        const body = linesOfTable
          .slice(1)
          .map((entry) => ({ line: entry.line, cells: splitTableRow(entry.text) }))
          .filter((entry) => !isSeparatorRow(entry.cells));
        tables.push({
          line: start + 1,
          headers,
          rows: body.map((entry) => entry.cells),
          section: nearestHeading,
        });
      }
      continue;
    }
    index += 1;
  }
  return tables;
}

/** Every heading outside fenced code blocks, in document order. */
function parseMarkdownHeadings(markdown: string): MarkdownHeading[] {
  const headings: MarkdownHeading[] = [];
  let inFence = false;
  for (const line of markdown.split(/\r?\n/)) {
    const wasInFence = inFence;
    inFence = toggleFence(line, inFence);
    if (wasInFence || inFence) continue;
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading !== null) headings.push({ level: heading[1]!.length, text: heading[2]!.trim() });
  }
  return headings;
}

/** Tables carrying one of the named columns (case-insensitive). */
function tablesWithColumn(tables: readonly MarkdownTable[], column: string): MarkdownTable[] {
  const wanted = column.toLowerCase();
  return tables.filter((table) => table.headers.some((header) => header.toLowerCase() === wanted));
}

/** Long flags (`--lower-case-with-dashes`) inside one cell / cell list. */
const LONG_FLAG = /(?<![\w-])--[a-z0-9][a-z0-9-]*/g;

function flagsIn(text: string): string[] {
  return [...text.matchAll(LONG_FLAG)].map((match) => match[0]);
}

/** `TWO_BROTHERS_*` variable names inside one cell / cell list. */
const ENV_VARIABLE = /TWO_BROTHERS_[A-Z0-9_]+/g;

function envVarsIn(text: string): string[] {
  return [...text.matchAll(ENV_VARIABLE)].map((match) => match[0]);
}

/** One documented environment-variable row. */
interface DocumentedEnv {
  variable: string;
  /** Flags named in the row's "Corresponding flag" column (empty = runtime-only). */
  flags: string[];
}

/** Parse the docs' environment-variable table (header has a `Variable` column). */
function documentedEnvVars(markdown: string): DocumentedEnv[] {
  const tables = tablesWithColumn(parseMarkdownTables(markdown), "variable");
  const documented: DocumentedEnv[] = [];
  for (const table of tables) {
    for (const row of table.rows) {
      // First cell carries the variable name(s); the remaining cells are the
      // mapping note. Combined rows (`A` / `B`) stay intact.
      const variableText = row[0] ?? "";
      const rest = row.slice(1).join(" | ");
      for (const variable of envVarsIn(variableText)) {
        documented.push({ variable, flags: flagsIn(rest) });
      }
    }
  }
  return documented;
}

/** Every long flag documented in a table whose header has a `Flag` column. */
function documentedFlags(markdown: string): string[] {
  const tables = tablesWithColumn(parseMarkdownTables(markdown), "flag");
  const flags: string[] = [];
  for (const table of tables) {
    for (const row of table.rows) {
      for (const cell of row) flags.push(...flagsIn(cell));
    }
  }
  return flags;
}

/** Command names documented as headings, tolerant of formatting. */
function documentedCommands(markdown: string): string[] {
  const names: string[] = [];
  for (const heading of parseMarkdownHeadings(markdown)) {
    // ``` `run "<task>"` ``` → `run`; `sessions search <query>` → `sessions`.
    const text = heading.text.replace(/^`+/, "").replace(/`+$/, "");
    const name = /^[a-z][a-z0-9-]*/.exec(text);
    if (name !== null) names.push(name[0]);
  }
  return names;
}

// ---------------------------------------------------------------------------
// per-command flag scoping
// ---------------------------------------------------------------------------

/** Documented flags split by the table's scope. */
interface DocumentedFlagScopes {
  /** Flags in the shared top-level `## Flags` table (common documentation pool). */
  shared: string[];
  /** Flags documented in a table under a heading that names a command. */
  byCommand: Map<string, string[]>;
  /** Flags documented in a `Flag` table with no command or "Flags" heading. */
  unscoped: string[];
}

/** Commands the shared `## Flags` table documents for (per the doc structure). */
const FLAG_COMMANDS = ["run", "chat", "tui", "serve"] as const;

/** Heading text normalized for comparison: strip backticks and trailing markup. */
function normalizeHeading(text: string): string {
  return text
    .replace(/`/g, "")
    .replace(/^\s+|\s+$/g, "")
    .replace(/["'<>]/g, "")
    .toLowerCase();
}

/** The command a section heading names, if any (`### \`serve\`` → serve). */
function commandNamedByHeading(heading: string | null): string | null {
  if (heading === null) return null;
  const normalized = normalizeHeading(heading);
  for (const command of COMMAND_ORDER) {
    if (new RegExp(`^${command}(?:\\b|$)`).test(normalized)) return command;
  }
  return null;
}

/**
 * Split documented `Flag`-table flags by scope: the shared top-level `## Flags`
 * table, a table under a command heading, or unscoped. Command scoping is what
 * the per-command audit uses; the shared table is the common pool consulted for
 * run/chat/tui/serve (see the test header for the exact contract).
 */
function documentedFlagScopes(markdown: string): DocumentedFlagScopes {
  const scopes: DocumentedFlagScopes = { shared: [], byCommand: new Map(), unscoped: [] };
  for (const table of tablesWithColumn(parseMarkdownTables(markdown), "flag")) {
    const flags: string[] = [];
    for (const row of table.rows) {
      for (const cell of row) flags.push(...flagsIn(cell));
    }
    const heading = table.section;
    const command = commandNamedByHeading(heading);
    if (command !== null) {
      scopes.byCommand.set(command, [...(scopes.byCommand.get(command) ?? []), ...flags]);
    } else if (heading !== null && /^flags\b/.test(normalizeHeading(heading))) {
      scopes.shared.push(...flags);
    } else {
      scopes.unscoped.push(...flags);
    }
  }
  return scopes;
}

/** Sorted, de-duplicated view of the flags a command's table documents. */
function scopedFlagsFor(scopes: DocumentedFlagScopes, command: string): string[] {
  return [...new Set(scopes.byCommand.get(command) ?? [])].sort();
}

/** The long flags (`--name`, `--help` excluded) a command's parser accepts. */
function acceptedFlagsFor(command: string): string[] {
  const spec = commandHelp(command);
  assert.ok(spec, `clihelp.ts has no command spec for ${command}`);
  return [...new Set(spec.acceptedFlags ?? spec.flags)]
    .filter((name) => name !== "help")
    .map((name) => `--${name}`)
    .sort();
}

/** The two failure directions for one command's flags. */
interface CommandFlagProblem {
  command: string;
  /** Flags in the command's own table that its parser does not accept. */
  documentedButNotAccepted: string[];
  /** Accepted flags documented in neither the command's table nor the shared pool. */
  acceptedButUndocumented: string[];
}

/**
 * Compare one command's accepted flags with what the docs document for it: its
 * own command-scoped table (authoritative — every flag there must be accepted)
 * plus the shared `## Flags` pool (accepted flags may be documented there).
 */
function analyzeCommandFlags(
  command: string,
  accepted: readonly string[],
  scopes: DocumentedFlagScopes,
): CommandFlagProblem {
  const acceptedSet = new Set(accepted);
  const scoped = new Set(scopedFlagsFor(scopes, command));
  const shared = new Set(scopes.shared);
  return {
    command,
    documentedButNotAccepted: [...scoped].filter((flag) => !acceptedSet.has(flag)).sort(),
    acceptedButUndocumented: [...acceptedSet]
      .filter((flag) => !scoped.has(flag) && !shared.has(flag))
      .sort(),
  };
}

/** Render one command's problem as one actionable line (empty when in sync). */
function describeCommandFlagProblem(problem: CommandFlagProblem): string {
  const parts: string[] = [];
  if (problem.documentedButNotAccepted.length > 0) {
    parts.push(`documented-but-not-accepted: ${problem.documentedButNotAccepted.join(", ")}`);
  }
  if (problem.acceptedButUndocumented.length > 0) {
    parts.push(`accepted-but-undocumented: ${problem.acceptedButUndocumented.join(", ")}`);
  }
  if (parts.length === 0) return "";
  return `${problem.command}: ${parts.join("; ")}`;
}

// ---------------------------------------------------------------------------
// set comparison helpers (shared by the assertions and the self-check)
// ---------------------------------------------------------------------------

interface SetDiff {
  /** In the expected set, missing from the actual set. */
  missing: string[];
  /** In the actual set, absent from the expected set. */
  extra: string[];
}

/** Sorted two-way difference; sorted so failure output is stable. */
function compareSets(expected: Iterable<string>, actual: Iterable<string>): SetDiff {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  return {
    missing: [...expectedSet].filter((item) => !actualSet.has(item)).sort(),
    extra: [...actualSet].filter((item) => !expectedSet.has(item)).sort(),
  };
}

/** Render both directions of a diff with where each side comes from. */
function describeDiff(
  label: string,
  expectedSource: string,
  actualSource: string,
  diff: SetDiff,
): string {
  const parts = [`${label}: ${diff.missing.length + diff.extra.length} mismatch(es)`];
  if (diff.missing.length > 0) {
    parts.push(
      `  in ${expectedSource} but missing from ${actualSource} (${diff.missing.length}): ` +
        diff.missing.join(", "),
    );
  }
  if (diff.extra.length > 0) {
    parts.push(
      `  in ${actualSource} but unknown to ${expectedSource} (${diff.extra.length}): ` +
        diff.extra.join(", "),
    );
  }
  return parts.join("\n");
}

/** Assert one direction of a diff is empty, with an actionable message. */
function assertNoDiff(
  label: string,
  expectedSource: string,
  actualSource: string,
  diff: SetDiff,
): void {
  assert.deepEqual(
    { missing: diff.missing, extra: diff.extra },
    { missing: [], extra: [] },
    describeDiff(label, expectedSource, actualSource, diff),
  );
}

// ---------------------------------------------------------------------------
// catalogue projections (what the CLI help advertises)
// ---------------------------------------------------------------------------

/** Long flags accepted by run/chat/tui/serve (the global docs contract). */
function requiredLongFlags(): string[] {
  const required = new Set<string>();
  for (const command of FLAG_COMMANDS) {
    for (const flag of acceptedFlagsFor(command)) required.add(flag);
  }
  return [...required].sort();
}

/** Long flags the CLI help catalogue knows (`FLAGS`). */
function knownLongFlags(): string[] {
  return allFlagNames();
}

/** Assert the catalogue itself is coherent (every accepted flag has a spec). */
function assertCatalogueCoherent(): void {
  for (const command of COMMAND_ORDER) {
    const spec = commandHelp(command);
    assert.ok(spec, `clihelp.ts has no command spec for ${command}`);
    for (const name of [...spec.flags, ...(spec.acceptedFlags ?? [])]) {
      assert.ok(
        FLAGS[name] !== undefined,
        `clihelp.ts command ${command} references unknown flag --${name}`,
      );
    }
  }
  for (const entry of ENVIRONMENT) {
    assert.ok(
      FLAGS[entry.flag.replace(/^--/, "")] !== undefined,
      `clihelp.ts ENVIRONMENT ${entry.variable} maps to unknown flag ${entry.flag}`,
    );
  }
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

test(
  "docs env-var table and clihelp.ts ENVIRONMENT stay in sync (bidirectional)",
  { skip: docsMissingReason },
  () => {
    const markdown = fs.readFileSync(docsPath, "utf-8");
    const documented = documentedEnvVars(markdown);
    assert.ok(
      documented.length > 0,
      "docs/cli-reference.md has no environment-variable table (a `Variable` column is required)",
    );

    // Catalogue → docs: every help-catalogue env var must have a docs row.
    // (Extra documented rows are allowed here: runtime-only env vars live in
    // the docs table without a `help --all` entry — see the reverse check.)
    const catalogue = ENVIRONMENT.map((entry) => entry.variable);
    const diff = compareSets(
      catalogue,
      documented.map((entry) => entry.variable),
    );
    assert.deepEqual(
      diff.missing,
      [],
      "environment variables in clihelp.ts::ENVIRONMENT but missing from " +
        "docs/cli-reference.md env table: " +
        diff.missing.join(", "),
    );

    // Docs → catalogue: only rows bound to a flag (the help catalogue's scope).
    // A row whose "Corresponding flag" column is "—" documents a runtime env var
    // that intentionally has no `help --all` entry (legacy plugin aliases, the
    // confined-shell PATH override).
    const flagBoundDocs = documented.filter((entry) => entry.flags.length > 0);
    const reverse = compareSets(
      catalogue,
      flagBoundDocs.map((entry) => entry.variable),
    );
    assertNoDiff(
      "flag-bound documented environment variables",
      "clihelp.ts::ENVIRONMENT",
      "docs/cli-reference.md env table rows with a corresponding flag",
      reverse,
    );
  },
);

test(
  "docs env-var table flag mappings match clihelp.ts ENVIRONMENT",
  { skip: docsMissingReason },
  () => {
    const markdown = fs.readFileSync(docsPath, "utf-8");
    const documented = documentedEnvVars(markdown);
    const byVariable = new Map(documented.map((entry) => [entry.variable, entry]));
    const mismatches: string[] = [];
    for (const entry of ENVIRONMENT) {
      const row = byVariable.get(entry.variable);
      if (row === undefined) continue; // reported by the coverage test
      if (!row.flags.includes(entry.flag)) {
        mismatches.push(
          `${entry.variable}: catalogue maps ${entry.flag}, docs row names ` +
            (row.flags.length > 0 ? row.flags.join("/") : "(no flag)"),
        );
      }
    }
    assert.deepEqual(
      mismatches.sort(),
      [],
      "docs/cli-reference.md env table maps an environment variable to the wrong flag:\n" +
        mismatches.sort().join("\n"),
    );
  },
);

test(
  "documented long flags and the run/chat/tui/serve flag catalogues stay in sync",
  { skip: docsMissingReason },
  () => {
    assertCatalogueCoherent();
    const markdown = fs.readFileSync(docsPath, "utf-8");
    const documented = documentedFlags(markdown);
    assert.ok(
      documented.length > 0,
      "docs/cli-reference.md has no flag table (a `Flag` column is required)",
    );

    // Catalogue → docs: every accepted run/chat/tui/serve flag is documented.
    const required = requiredLongFlags();
    const diff = compareSets(required, documented);
    assertNoDiff(
      "accepted run/chat/tui/serve flags",
      "clihelp.ts command specs (acceptedFlags/flags)",
      "docs/cli-reference.md flag tables",
      diff,
    );

    // Docs → catalogue: a documented long flag must exist in FLAGS.
    const unknown = compareSets(knownLongFlags(), documented).extra;
    assert.deepEqual(
      unknown,
      [],
      "docs/cli-reference.md flag tables document flags unknown to clihelp.ts::FLAGS: " +
        unknown.join(", "),
    );
  },
);

test(
  "per-command flag tables scope to the commands that accept their flags",
  { skip: docsMissingReason },
  () => {
    const markdown = fs.readFileSync(docsPath, "utf-8");
    const scopes = documentedFlagScopes(markdown);
    assert.ok(
      scopes.shared.length > 0,
      "docs/cli-reference.md has no shared `## Flags` table with a `Flag` header",
    );
    assert.ok(
      scopes.byCommand.size > 0,
      "docs/cli-reference.md has no command-scoped flag table (expected at least one " +
        "`Flag` table under a command heading, e.g. `### serve`)",
    );

    // Command-scoped tables are authoritative: every documented flag there must
    // be accepted by that command (this is the reviewer's P3 direction).
    for (const [command, flags] of scopes.byCommand) {
      const accepted = new Set(acceptedFlagsFor(command));
      const notAccepted = [...new Set(flags)].filter((flag) => !accepted.has(flag)).sort();
      assert.deepEqual(
        notAccepted,
        [],
        `${command}: documented-but-not-accepted: ${notAccepted.join(", ")} ` +
          `(docs/cli-reference.md \`${command}\` flag table vs clihelp.ts acceptedFlags)`,
      );
    }

    // Accepted flags must be documented in the command's own table or the
    // shared table (per-command sorted diff for run/chat/tui/serve).
    const problems = FLAG_COMMANDS.map((command) =>
      describeCommandFlagProblem(analyzeCommandFlags(command, acceptedFlagsFor(command), scopes)),
    ).filter((line) => line !== "");
    assert.deepEqual(
      problems,
      [],
      "per-command docs/CLI flag drift:\n" + problems.join("\n"),
    );

    // Unscoped flag tables are allowed (prose sections may keep tables), but
    // they must at least name catalogued flags — reported by the global test.
  },
);

test("per-command flag analysis is testable on a synthetic document (self-check)", () => {
  const synthetic = [
    "## Flags",
    "",
    "| Flag | Description |",
    "|---|---|",
    "| `--shared-flag` | shared option |",
    "",
    "### `serve`",
    "",
    "| Flag | Default | Description |",
    "|---|---|---|",
    "| `--host` | `127.0.0.1` | bind address |",
    "",
  ].join("\n");
  const scopes = documentedFlagScopes(synthetic);
  assert.deepEqual(scopes.shared, ["--shared-flag"]);
  assert.deepEqual(scopes.byCommand.get("serve"), ["--host"]);
  assert.deepEqual(scopes.unscoped, []);

  // A correctly scoped command passes both directions.
  assert.deepEqual(analyzeCommandFlags("serve", ["--shared-flag", "--host"], scopes), {
    command: "serve",
    documentedButNotAccepted: [],
    acceptedButUndocumented: [],
  });

  // A flag documented for the wrong command is reported per command, sorted.
  const misScoped = documentedFlagScopes(
    synthetic.replace("| `--host` |", "| `--workspace` | `--aardvark` |"),
  );
  const problem = analyzeCommandFlags("serve", ["--shared-flag", "--host"], misScoped);
  assert.deepEqual(problem.documentedButNotAccepted, ["--aardvark", "--workspace"]);
  assert.deepEqual(problem.acceptedButUndocumented, ["--host"]);
  assert.equal(
    describeCommandFlagProblem(problem),
    "serve: documented-but-not-accepted: --aardvark, --workspace; " +
      "accepted-but-undocumented: --host",
  );

  // An accepted flag documented nowhere for the command is also reported.
  const missing = documentedFlagScopes("## Flags\n\n| Flag | Description |\n|---|---|\n| `--shared-flag` | s |\n");
  const missingProblem = analyzeCommandFlags("serve", ["--shared-flag", "--host"], missing);
  assert.deepEqual(missingProblem.acceptedButUndocumented, ["--host"]);
  assert.equal(
    describeCommandFlagProblem(missingProblem),
    "serve: accepted-but-undocumented: --host",
  );
});

test(
  "docs/cli-reference.md documents every CLI command",
  { skip: docsMissingReason },
  () => {
    const markdown = fs.readFileSync(docsPath, "utf-8");
    const documented = documentedCommands(markdown);
    // `help` is described in the global prose ("two-brothers help …"), not as a
    // command section, so only the executable commands are required.
    const required = COMMAND_ORDER.filter((command) => command !== "help");
    const missing = required.filter((command) => !documented.includes(command));
    assert.deepEqual(
      missing,
      [],
      "commands missing from docs/cli-reference.md: " + missing.join(", "),
    );
  },
);

test("the parity helpers report actionable sorted set diffs (self-check)", () => {
  const diff = compareSets(["A", "B"], ["B", "C"]);
  assert.deepEqual(diff, { missing: ["A"], extra: ["C"] });
  const message = describeDiff(
    "documented environment variables",
    "clihelp.ts::ENVIRONMENT",
    "docs/cli-reference.md env table",
    diff,
  );
  assert.match(message, /2 mismatch\(es\)/);
  assert.match(
    message,
    /in clihelp\.ts::ENVIRONMENT but missing from docs\/cli-reference\.md env table \(1\): A/,
  );
  assert.match(
    message,
    /in docs\/cli-reference\.md env table but unknown to clihelp\.ts::ENVIRONMENT \(1\): C/,
  );
});

test("missing docs yield a skip reason instead of a failure (packaged tarball)", () => {
  assert.equal(docsSkipReason(docsPath), false, "the checkout ships the reference");
  const missing = path.join(repoRoot, "docs", "does-not-exist.md");
  const reason = docsSkipReason(missing);
  assert.equal(typeof reason, "string");
  assert.match(String(reason), /cli-reference\.md not found at/);
  assert.match(String(reason), /skipping outside a checkout/);
});
