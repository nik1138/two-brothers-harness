/**
 * Docs в†” CLI drift guard (wave 13, release readiness).
 *
 * `docs/cli-reference.md` is the user-facing contract for the command-line
 * surface. This hermetic test keeps it honest against the code-owned catalogue
 * in `src/clihelp.ts`, so a new flag/env var cannot ship undocumented and a
 * removed one cannot linger in the docs.
 *
 * What is compared (and what is deliberately out of scope):
 * - ENV VARS: the two-way set between the docs' "Environment variables" table
 *   and `ENVIRONMENT` in `src/clihelp.ts`. The docs table's "Corresponding
 *   flag" column scopes the reverse direction: a row that maps to a flag is
 *   part of the help catalogue and must be listed there; a row whose mapping is
 *   "вЂ”" documents a runtime-only env var (legacy plugin aliases, the confined
 *   shell PATH override) that intentionally lives outside `help --all`. The
 *   catalogue-to-docs direction covers every catalogue variable.
 * - FLAG MAPPINGS: each catalogue env var's flag must still be the flag the
 *   docs row names, so the docs cannot point at the wrong option.
 * - FLAGS: the union of every markdown table whose header has a `Flag` column
 *   (the `## Flags` table and the `serve` option table вЂ” the actual shape of
 *   this document) against the long flags accepted by `run` / `chat` / `tui` /
 *   `serve` (`acceptedFlags ?? flags` in `src/clihelp.ts`). `--help` is
 *   excluded from the required set because every command documents it once as
 *   a global invocation rather than in a table.
 * - COMMANDS (one direction, tolerant): every command in `COMMAND_ORDER` except
 *   `help` must appear as a heading (`#`вЂ“`####`) in the reference; `help`
 *   itself is described in the global prose.
 *
 * Parsing is deliberately tolerant: tables are recognized by their header row,
 * cells may be backticked or bare, row order and whitespace are irrelevant,
 * escaped pipes are handled, and non-flag prose is ignored. Missing docs (a
 * bare npm tarball) skip the suite with a clear message instead of failing.
 *
 * Failure messages are set diffs: "вЂ¦documented in docs/cli-reference.md but
 * unknown to clihelp.ts::FLAGS: --bogus" / "вЂ¦in clihelp.ts but missing from the
 * docs: TWO_BROTHERS_NEW_THING". Set order is sorted, so the output is stable.
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

/** One markdown table: its header cells and body rows (separator row skipped). */
interface MarkdownTable {
  /** 1-based line of the header row, for actionable failure messages. */
  line: number;
  headers: string[];
  rows: string[][];
}

/** Split one table row into trimmed cells, tolerating `\|` escapes. */
function splitTableRow(line: string): string[] {
  const text = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return text.split(/(?<!\\)\|/).map((cell) => cell.replace(/\\\|/g, "|").trim());
}

/** True for a markdown table separator row (`|---|---|`, `|:--:|---|`, вЂ¦). */
function isSeparatorRow(cells: readonly string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

/**
 * Parse every markdown table in the document. Tables are contiguous runs of
 * `|`-prefixed lines; the first row is the header, the second (a separator) is
 * dropped, the rest are body rows. Anything that does not start with `|` ends
 * the table, so prose and code fences are naturally ignored.
 */
function parseMarkdownTables(markdown: string): MarkdownTable[] {
  const lines = markdown.split(/\r?\n/);
  const tables: MarkdownTable[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trimStart().startsWith("|")) {
      index += 1;
      continue;
    }
    const start = index;
    const linesOfTable: Array<{ line: number; text: string }> = [];
    while (index < lines.length && (lines[index] ?? "").trimStart().startsWith("|")) {
      linesOfTable.push({ line: index + 1, text: lines[index] ?? "" });
      index += 1;
    }
    if (linesOfTable.length < 2) continue;
    const headers = splitTableRow(linesOfTable[0]!.text);
    const body = linesOfTable
      .slice(1)
      .map((entry) => ({ line: entry.line, cells: splitTableRow(entry.text) }))
      .filter((entry) => !isSeparatorRow(entry.cells));
    tables.push({ line: start + 1, headers, rows: body.map((entry) => entry.cells) });
  }
  return tables;
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
      // mapping note. Combined rows (`A` / `B`) and escaped pipes stay intact.
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

/** Command names documented as headings (`#`вЂ“`####`), tolerant of formatting. */
function documentedCommands(markdown: string): string[] {
  const names: string[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^#{1,4}\s+(.+)$/.exec(line);
    if (heading === null) continue;
    // ``` `run "<task>"` ``` в†’ `run`; `sessions search <query>` в†’ `sessions`.
    const text = heading[1]!.trim().replace(/^`+/, "").replace(/`+$/, "");
    const name = /^[a-z][a-z0-9-]*/.exec(text);
    if (name !== null) names.push(name[0]);
  }
  return names;
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

/** The commands whose accepted flags must be documented. */
const FLAG_COMMANDS = ["run", "chat", "tui", "serve"] as const;

/** Long flags accepted by run/chat/tui/serve (the docs contract). */
function requiredLongFlags(): string[] {
  const required = new Set<string>();
  for (const command of FLAG_COMMANDS) {
    const spec = commandHelp(command);
    assert.ok(spec, `clihelp.ts has no command spec for ${command}`);
    for (const name of spec.acceptedFlags ?? spec.flags) {
      // `--help` is universal and documented once as a global invocation; every
      // other accepted flag must be in the docs flag tables.
      if (name === "help") continue;
      required.add(`--${name}`);
    }
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

    // Catalogue в†’ docs: every help-catalogue env var must have a docs row.
    // (Extra documented rows are allowed here: runtime-only env vars live in
    // the docs table without a `help --all` entry вЂ” see the reverse check.)
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

    // Docs в†’ catalogue: only rows bound to a flag (the help catalogue's scope).
    // A row whose "Corresponding flag" column is "вЂ”" documents a runtime env var
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

    // Catalogue в†’ docs: every accepted run/chat/tui/serve flag is documented.
    const required = requiredLongFlags();
    const diff = compareSets(required, documented);
    assertNoDiff(
      "accepted run/chat/tui/serve flags",
      "clihelp.ts command specs (acceptedFlags/flags)",
      "docs/cli-reference.md flag tables",
      diff,
    );

    // Docs в†’ catalogue: a documented long flag must exist in FLAGS.
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
  "docs/cli-reference.md documents every CLI command",
  { skip: docsMissingReason },
  () => {
    const markdown = fs.readFileSync(docsPath, "utf-8");
    const documented = documentedCommands(markdown);
    // `help` is described in the global prose ("two-brothers help вЂ¦"), not as a
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
  assert.match(message, /in clihelp\.ts::ENVIRONMENT but missing from docs\/cli-reference\.md env table \(1\): A/);
  assert.match(message, /in docs\/cli-reference\.md env table but unknown to clihelp\.ts::ENVIRONMENT \(1\): C/);
});

test("missing docs yield a skip reason instead of a failure (packaged tarball)", () => {
  assert.equal(docsSkipReason(docsPath), false, "the checkout ships the reference");
  const missing = path.join(repoRoot, "docs", "does-not-exist.md");
  const reason = docsSkipReason(missing);
  assert.equal(typeof reason, "string");
  assert.match(String(reason), /cli-reference\.md not found at/);
  assert.match(String(reason), /skipping outside a checkout/);
});
