/**
 * CLI `sessions search` / `sessions export` (the CLI side of
 * `src/sessionsearch.ts`). Hermetic: `main(argv, io)` is driven in-process
 * against session fixtures written to a temp directory, so no child process,
 * TTY or network is involved.
 *
 * Covers: human + `--json` search output and hit shape, no-match/short-query/
 * bad-flag exit codes, markdown/JSON export on stdout, `--output <path>` (and
 * `-`), sidecar titles, session-name resolution and the 404-style missing
 * session exit code. Also checks that the help catalog and generated
 * completions pick the new subcommands/flags up automatically.
 *
 * Run with: node --test tests/sessionscommands.test.ts
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { main, type CliIO } from "../src/cli.ts";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeIO(): CliIO & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, log: (line) => out.push(line), error: (line) => err.push(line) };
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-cli-sessions-"));
  try {
    await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** One protocol envelope line for the session fixtures. */
function sessionEnvelope(
  seq: number,
  from: string,
  to: string,
  kind: string,
  payload: Record<string, unknown>,
): string {
  return JSON.stringify({
    v: 1,
    id: `id-${seq}`,
    seq,
    ts: "2026-11-01T00:00:00Z",
    from,
    to,
    kind,
    payload,
  });
}

/**
 * Two session files: alpha has a consult asking about redis, beta a decision
 * choosing redis. mtimes are pinned so `loadSessionDocs` (newest first) is
 * deterministic: beta is newer than alpha.
 */
function writeSearchFixtures(dir: string): void {
  const now = Math.floor(Date.now() / 1000);
  const alpha = path.join(dir, "alpha.jsonl");
  fs.writeFileSync(
    alpha,
    [
      sessionEnvelope(1, "user", "senior", "message", { text: "Alpha migration task" }),
      sessionEnvelope(2, "senior", "junior", "consult", {
        task: "migrate",
        ask: "compare redis and valkey",
        expect: "proposal",
      }),
      sessionEnvelope(3, "junior", "senior", "proposal", { title: "Plan", answer: "Do it" }),
    ].join("\n") + "\n",
    "utf-8",
  );
  const beta = path.join(dir, "beta.jsonl");
  fs.writeFileSync(
    beta,
    [
      sessionEnvelope(1, "user", "senior", "message", { text: "Beta rollout task" }),
      sessionEnvelope(2, "senior", "user", "decision", { decision: "choose redis for now" }),
    ].join("\n") + "\n",
    "utf-8",
  );
  const older = new Date((now - 300) * 1000);
  const newer = new Date((now - 60) * 1000);
  fs.utimesSync(alpha, older, older);
  fs.utimesSync(beta, newer, newer);
  fs.writeFileSync(path.join(dir, "notes.txt"), "not a session\n", "utf-8");
}

/** One three-envelope session titled from its first operator message. */
function writeExportFixture(dir: string): string {
  const file = path.join(dir, "alpha.jsonl");
  fs.writeFileSync(
    file,
    [
      sessionEnvelope(1, "user", "senior", "message", { text: "Alpha task" }),
      sessionEnvelope(2, "senior", "junior", "consult", {
        task: "t",
        ask: "a",
        expect: "proposal",
      }),
      sessionEnvelope(3, "junior", "senior", "proposal", { title: "Plan", answer: "Do it" }),
    ].join("\n") + "\n",
    "utf-8",
  );
  fs.writeFileSync(path.join(dir, "notes.txt"), "not a session\n", "utf-8");
  return file;
}

// ---------------------------------------------------------------------------
// sessions search
// ---------------------------------------------------------------------------

test("sessions search: human header + one line per hit", async () => {
  await withTempDir(async (dir) => {
    writeSearchFixtures(dir);
    const io = makeIO();
    const code = await main(["sessions", "search", "redis", "--sessions-dir", dir], io);
    assert.equal(code, 0, io.err.join("\n"));
    assert.deepEqual(io.err, []);
    assert.equal(io.out[0], "2 matches in 2 sessions");
    const hitLines = io.out.slice(1);
    assert.equal(hitLines.length, 2, io.out.join("\n"));
    for (const line of hitLines) assert.match(line, /^(alpha|beta)\.jsonl  (title|message|decision)  \S/);
    assert.ok(
      hitLines.some((line) => line.startsWith("beta.jsonl  decision  choose redis")),
      io.out.join("\n"),
    );
    assert.ok(
      hitLines.some((line) => line.startsWith("alpha.jsonl  message  compare redis")),
      io.out.join("\n"),
    );
  });
});

test("sessions search --json: the exact SessionSearchResult object", async () => {
  await withTempDir(async (dir) => {
    writeSearchFixtures(dir);
    const io = makeIO();
    const code = await main(["sessions", "search", "redis", "--sessions-dir", dir, "--json"], io);
    assert.equal(code, 0, io.err.join("\n"));
    assert.deepEqual(io.err, []);
    assert.equal(io.out.length, 1, "one JSON document on stdout");
    const parsed = JSON.parse(io.out[0]) as {
      query: string;
      scanned_sessions: number;
      truncated: boolean;
      hits: Array<Record<string, unknown>>;
    };
    assert.deepEqual(Object.keys(parsed), ["query", "scanned_sessions", "truncated", "hits"]);
    assert.equal(parsed.query, "redis");
    assert.equal(parsed.scanned_sessions, 2);
    assert.equal(parsed.truncated, false);
    assert.equal(parsed.hits.length, 2);
    assert.deepEqual(Object.keys(parsed.hits[0]), [
      "session",
      "title",
      "field",
      "seq",
      "role",
      "kind",
      "snippet",
      "ts",
    ]);
    assert.deepEqual(
      parsed.hits.map((hit) => hit.session).sort(),
      ["alpha.jsonl", "beta.jsonl"],
    );
  });
});

test("sessions search: whitespace-collapsed query and --limit cap", async () => {
  await withTempDir(async (dir) => {
    writeSearchFixtures(dir);
    const limited = makeIO();
    assert.equal(
      await main(
        ["sessions", "search", "  redis  ", "--sessions-dir", dir, "--json", "--limit", "1"],
        limited,
      ),
      0,
      limited.err.join("\n"),
    );
    const parsed = JSON.parse(limited.out[0]) as { query: string; hits: unknown[] };
    assert.equal(parsed.query, "redis");
    assert.equal(parsed.hits.length, 1);
  });
});

test("sessions search: no matches prints 'no matches', exit 0", async () => {
  await withTempDir(async (dir) => {
    writeSearchFixtures(dir);
    const io = makeIO();
    assert.equal(await main(["sessions", "search", "zebra", "--sessions-dir", dir], io), 0);
    assert.deepEqual(io.out, ["no matches"]);
    assert.deepEqual(io.err, []);
  });
});

test("sessions search: short/absent query and bad flags exit 2 with clear diagnostics", async () => {
  await withTempDir(async (dir) => {
    writeSearchFixtures(dir);

    const short = makeIO();
    assert.equal(await main(["sessions", "search", "r", "--sessions-dir", dir], short), 2);
    assert.match(short.err.join("\n"), /query must be at least 2 characters/);
    assert.deepEqual(short.out, []);

    const absent = makeIO();
    assert.equal(await main(["sessions", "search", "--sessions-dir", dir], absent), 2);
    assert.match(absent.err.join("\n"), /no search query/);
    assert.deepEqual(absent.out, []);

    const badLimit = makeIO();
    assert.equal(
      await main(["sessions", "search", "redis", "--sessions-dir", dir, "--limit", "nope"], badLimit),
      2,
    );
    assert.match(badLimit.err.join("\n"), /invalid --limit/);

    const unknownFlag = makeIO();
    assert.equal(
      await main(["sessions", "search", "redis", "--sessions-dir", dir, "--bogus"], unknownFlag),
      2,
    );
    assert.match(unknownFlag.err.join("\n"), /Unknown option '--bogus'/);
    assert.match(unknownFlag.err.join("\n"), /sessions --help/);
  });
});

// ---------------------------------------------------------------------------
// sessions export
// ---------------------------------------------------------------------------

test("sessions export: markdown on stdout by default, name with or without .jsonl", async () => {
  await withTempDir(async (dir) => {
    writeExportFixture(dir);
    for (const name of ["alpha", "alpha.jsonl"]) {
      const io = makeIO();
      assert.equal(await main(["sessions", "export", name, "--sessions-dir", dir], io), 0, name);
      assert.deepEqual(io.err, []);
      const text = io.out.join("\n");
      assert.match(text, /^# Alpha task$/m);
      assert.match(text, /^- session: alpha\.jsonl$/m);
      assert.match(text, /^- envelopes: 3$/m);
      assert.match(text, /^## 1\. user → senior · message$/m);
      assert.match(text, /^## 3\. junior → senior · proposal$/m);
      assert.match(text, /Do it/);
    }
  });
});

test("sessions export --format json: the documented JSON document", async () => {
  await withTempDir(async (dir) => {
    writeExportFixture(dir);
    const io = makeIO();
    assert.equal(
      await main(["sessions", "export", "alpha", "--sessions-dir", dir, "--format", "json"], io),
      0,
      io.err.join("\n"),
    );
    const parsed = JSON.parse(io.out.join("\n")) as {
      name: string;
      title: string;
      workspace_id: string | null;
      updated: number | null;
      exported_at: string;
      envelopes: Array<{ seq: number; kind: string }>;
    };
    assert.equal(parsed.name, "alpha.jsonl");
    assert.equal(parsed.title, "Alpha task");
    assert.equal(parsed.workspace_id, null);
    assert.equal(typeof parsed.updated, "number");
    assert.match(parsed.exported_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(
      parsed.envelopes.map((event) => event.kind),
      ["message", "consult", "proposal"],
    );

    // Format is trimmed and case-insensitive.
    const upper = makeIO();
    assert.equal(
      await main(["sessions", "export", "alpha", "--sessions-dir", dir, "--format", " JSON "], upper),
      0,
      upper.err.join("\n"),
    );
    assert.equal((JSON.parse(upper.out.join("\n")) as { name: string }).name, "alpha.jsonl");
  });
});

test("sessions export --output writes the file and confirms on stderr", async () => {
  await withTempDir(async (dir) => {
    const sessionFile = writeExportFixture(dir);
    const outputFile = path.join(dir, "export.md");
    const io = makeIO();
    const code = await main(
      ["sessions", "export", "alpha", "--sessions-dir", dir, "--output", outputFile],
      io,
    );
    assert.equal(code, 0, io.err.join("\n"));
    assert.deepEqual(io.out, [], "the document goes to the file, not stdout");
    assert.match(io.err.join("\n"), new RegExp(`^wrote .*export\\.md$`, "m"));
    const written = fs.readFileSync(outputFile, "utf-8");
    assert.match(written, /^# Alpha task$/m);
    assert.ok(written.endsWith("\n"), "exactly one trailing newline");
    assert.ok(!written.endsWith("\n\n"));

    // `--output -` means stdout again. The `exported` header carries the
    // current timestamp, so compare everything else against the file export.
    const stripExported = (text: string): string =>
      text.replace(/^- exported: .*$/m, "- exported: <timestamp>");
    const dash = makeIO();
    assert.equal(
      await main(["sessions", "export", "alpha", "--sessions-dir", dir, "--output", "-"], dash),
      0,
      dash.err.join("\n"),
    );
    assert.deepEqual(dash.err, []);
    assert.equal(stripExported(dash.out.join("\n") + "\n"), stripExported(written));
    assert.ok(fs.existsSync(sessionFile));
  });
});

test("sessions export: the metadata sidecar title wins", async () => {
  await withTempDir(async (dir) => {
    writeExportFixture(dir);
    fs.writeFileSync(
      path.join(dir, "alpha.meta.json"),
      JSON.stringify({ title: "Renamed by the operator" }),
      "utf-8",
    );
    const io = makeIO();
    assert.equal(await main(["sessions", "export", "alpha", "--sessions-dir", dir], io), 0);
    assert.match(io.out.join("\n"), /^# Renamed by the operator$/m);
  });
});

test("sessions export: missing session exits 1; bad format/name/flags exit 2", async () => {
  await withTempDir(async (dir) => {
    writeExportFixture(dir);

    const missing = makeIO();
    assert.equal(await main(["sessions", "export", "nope", "--sessions-dir", dir], missing), 1);
    assert.match(missing.err.join("\n"), /session not found: nope/);
    assert.deepEqual(missing.out, []);

    const badFormat = makeIO();
    assert.equal(
      await main(["sessions", "export", "alpha", "--sessions-dir", dir, "--format", "pdf"], badFormat),
      2,
    );
    assert.match(badFormat.err.join("\n"), /unknown export format: pdf/);

    const noName = makeIO();
    assert.equal(await main(["sessions", "export", "--sessions-dir", dir], noName), 2);
    assert.match(noName.err.join("\n"), /no session name/);

    const extra = makeIO();
    assert.equal(
      await main(["sessions", "export", "alpha", "beta", "--sessions-dir", dir], extra),
      2,
    );
    assert.match(extra.err.join("\n"), /unexpected argument: beta/);

    const unknownFlag = makeIO();
    assert.equal(
      await main(["sessions", "export", "alpha", "--sessions-dir", dir, "--nope"], unknownFlag),
      2,
    );
    assert.match(unknownFlag.err.join("\n"), /Unknown option '--nope'/);
  });
});

test("sessions export: an unwritable --output path exits 1 with a clear message", async () => {
  await withTempDir(async (dir) => {
    writeExportFixture(dir);
    const io = makeIO();
    const code = await main(
      [
        "sessions",
        "export",
        "alpha",
        "--sessions-dir",
        dir,
        "--output",
        path.join(dir, "missing-dir", "out.md"),
      ],
      io,
    );
    assert.equal(code, 1);
    assert.match(io.err.join("\n"), /cannot write/);
    assert.deepEqual(io.out, []);
  });
});

// ---------------------------------------------------------------------------
// help catalog / completions stay derived from the same source
// ---------------------------------------------------------------------------

test("help and completions pick up the new sessions subcommands and flags", async () => {
  const help = makeIO();
  assert.equal(await main(["sessions", "--help"], help), 0);
  const helpText = help.out.join("\n");
  assert.match(helpText, /sessions search <query>/);
  assert.match(helpText, /sessions export <name>/);
  assert.match(helpText, /sessions fork <name>/);
  assert.match(helpText, /sessions rewind <name> --turns <n>/);
  assert.match(helpText, /--format <markdown\|json\|html>/);
  assert.match(helpText, /--output <path>/);
  assert.match(helpText, /--at <seq>/);
  assert.match(helpText, /--name <name>/);
  assert.match(helpText, /--turns <n>/);

  const bash = makeIO();
  assert.equal(await main(["completions", "bash"], bash), 0, bash.err.join("\n"));
  const script = bash.out.join("\n");
  assert.match(script, /--format/);
  assert.match(script, /--output/);
  assert.match(script, /--at/);
  assert.match(script, /--turns/);
  assert.match(script, /sessions/);
});
