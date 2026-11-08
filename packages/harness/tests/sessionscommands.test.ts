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
import { SessionMetadataStore } from "../src/metadata.ts";
import { Decision, PermissionManager, StaticBroker } from "../src/permissions.ts";
import { Workspace, WorkspaceRegistry } from "../src/workspace.ts";
import { beginUndoCapture } from "../src/workspacehistory.ts";

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

interface UndoFixture {
  sessionsDir: string;
  workspaceDir: string;
  runId: string;
  workspaceId: string;
}

/**
 * One workspace-bound session (`chat.jsonl` + meta sidecar + registry) with a
 * persisted undo record: the run edits `existing.txt` and creates
 * `created.txt`. Exercises the CLI exactly as the server would persist it.
 */
async function writeUndoFixture(dir: string): Promise<UndoFixture> {
  const sessionsDir = path.join(dir, "sessions");
  const workspaceDir = path.join(dir, "workspace");
  fs.mkdirSync(sessionsDir);
  fs.mkdirSync(workspaceDir);
  fs.writeFileSync(path.join(workspaceDir, "existing.txt"), "original\n", "utf-8");
  fs.writeFileSync(
    path.join(sessionsDir, "chat.jsonl"),
    sessionEnvelope(1, "user", "senior", "message", { text: "Chat task" }) + "\n",
    "utf-8",
  );
  const linked = new WorkspaceRegistry(path.join(sessionsDir, "workspaces.json")).add(
    workspaceDir,
    "ws",
  );
  new SessionMetadataStore(sessionsDir).save("chat.jsonl", {
    title: "Chat",
    workspaceId: linked.id,
  });

  const runId = "run-1";
  const capture = beginUndoCapture(path.join(sessionsDir, "undo"), runId, workspaceDir, {
    session: "chat.jsonl",
    retention: false,
  });
  const ws = new Workspace(
    workspaceDir,
    new PermissionManager(null, new StaticBroker(Decision.ALLOW)),
    null,
    { mutationRecorder: capture.recorder },
  );
  await ws.edit_file("existing.txt", "original", "edited");
  await ws.write_file("created.txt", "made by the run\n");
  capture.close();
  return { sessionsDir, workspaceDir, runId, workspaceId: linked.id };
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
// sessions undo
// ---------------------------------------------------------------------------

test("sessions undo: default previews the newest record against the linked workspace", async () => {
  await withTempDir(async (dir) => {
    const fx = await writeUndoFixture(dir);
    const io = makeIO();
    const code = await main(["sessions", "undo", "chat", "--sessions-dir", fx.sessionsDir], io);
    assert.equal(code, 0, io.err.join("\n"));
    assert.deepEqual(io.err, []);
    const text = io.out.join("\n");
    assert.match(text, /session: chat\.jsonl/);
    assert.match(text, /run: run-1/);
    assert.match(text, /workspace: /);
    assert.match(text, /2 file\(s\): 1 applicable, 1 created, 0 deleted/);
    assert.match(text, /applicable\s+edit\s+existing\.txt/);
    assert.match(text, /created\s+write\s+created\.txt/);
    assert.match(text, /preview only; pass --apply/);
    // Preview is read-only.
    assert.equal(
      fs.readFileSync(path.join(fx.workspaceDir, "existing.txt"), "utf-8"),
      "edited\n",
    );
    assert.equal(fs.existsSync(path.join(fx.workspaceDir, "created.txt")), true);
  });
});

test("sessions undo --json: the preview object mirrors the HTTP route", async () => {
  await withTempDir(async (dir) => {
    const fx = await writeUndoFixture(dir);
    const io = makeIO();
    const code = await main(
      ["sessions", "undo", "chat", "--sessions-dir", fx.sessionsDir, "--json"],
      io,
    );
    assert.equal(code, 0, io.err.join("\n"));
    const body = JSON.parse(io.out[0]);
    assert.equal(body.session, "chat.jsonl");
    assert.equal(body.run_id, fx.runId);
    assert.equal(body.workspace_root, fs.realpathSync(fx.workspaceDir));
    assert.equal(body.counts.applicable, 1);
    assert.equal(body.counts.created, 1);
    assert.equal(body.counts.total, 2);
    assert.deepEqual(
      body.statuses
        .map((entry: Record<string, unknown>) => [entry.path, entry.status])
        .sort(),
      [["created.txt", "created"], ["existing.txt", "applicable"]],
    );
  });
});

test("sessions undo --apply restores reversible files and reports the counts", async () => {
  await withTempDir(async (dir) => {
    const fx = await writeUndoFixture(dir);
    const io = makeIO();
    const code = await main(
      [
        "sessions",
        "undo",
        "chat",
        "--run",
        fx.runId,
        "--apply",
        "--json",
        "--sessions-dir",
        fx.sessionsDir,
      ],
      io,
    );
    assert.equal(code, 0, io.err.join("\n"));
    const body = JSON.parse(io.out[0]);
    assert.equal(body.session, "chat.jsonl");
    assert.equal(body.run_id, fx.runId);
    assert.equal(body.applied, 2);
    assert.equal(body.refused, 0);
    assert.equal(body.failed, 0);
    assert.equal(body.counts.total, 2);
    for (const file of body.files) assert.equal(file.status, "applied");
    assert.equal(
      fs.readFileSync(path.join(fx.workspaceDir, "existing.txt"), "utf-8"),
      "original\n",
    );
    assert.equal(fs.existsSync(path.join(fx.workspaceDir, "created.txt")), false);

    // A second apply refuses everything (post-run content no longer matches).
    const again = makeIO();
    const againCode = await main(
      ["sessions", "undo", "chat", "--run", fx.runId, "--apply", "--json", "--sessions-dir", fx.sessionsDir],
      again,
    );
    assert.equal(againCode, 0, again.err.join("\n"));
    assert.equal(JSON.parse(again.out[0]).refused, 2);
  });
});

test("sessions undo --discard drops the record and collects its unreferenced blobs", async () => {
  await withTempDir(async (dir) => {
    const fx = await writeUndoFixture(dir);
    const io = makeIO();
    const code = await main(
      [
        "sessions",
        "undo",
        "chat",
        "--run",
        fx.runId,
        "--discard",
        "--json",
        "--sessions-dir",
        fx.sessionsDir,
      ],
      io,
    );
    assert.equal(code, 0, io.err.join("\n"));
    const body = JSON.parse(io.out[0]);
    assert.equal(body.discarded, true);
    assert.equal(body.session, "chat.jsonl");
    assert.equal(body.run_id, fx.runId);
    assert.ok(body.blobs_removed > 0);
    assert.equal(
      fs.existsSync(path.join(fx.sessionsDir, "undo", "runs", `${fx.runId}.json`)),
      false,
    );

    // The record is gone: a later preview is an honest unknown record.
    const after = makeIO();
    const afterCode = await main(
      ["sessions", "undo", "chat", "--run", fx.runId, "--sessions-dir", fx.sessionsDir],
      after,
    );
    assert.equal(afterCode, 1);
    assert.match(after.err.join("\n"), /no undo record/);
  });
});

test("sessions undo: unknown session/record and missing workspace link exit 1", async () => {
  await withTempDir(async (dir) => {
    const fx = await writeUndoFixture(dir);

    const noSession = makeIO();
    assert.equal(
      await main(["sessions", "undo", "nope", "--sessions-dir", fx.sessionsDir], noSession),
      1,
    );
    assert.match(noSession.err.join("\n"), /session not found/);

    const noRecord = makeIO();
    assert.equal(
      await main(
        ["sessions", "undo", "chat", "--run", "run-missing", "--sessions-dir", fx.sessionsDir],
        noRecord,
      ),
      1,
    );
    assert.match(noRecord.err.join("\n"), /no undo record/);

    // A real session with a linked workspace but no undo record of its own.
    fs.writeFileSync(
      path.join(fx.sessionsDir, "empty.jsonl"),
      sessionEnvelope(1, "user", "senior", "message", { text: "Empty" }) + "\n",
      "utf-8",
    );
    new SessionMetadataStore(fx.sessionsDir).save("empty.jsonl", {
      title: "Empty",
      workspaceId: fx.workspaceId,
    });
    const empty = makeIO();
    assert.equal(
      await main(["sessions", "undo", "empty", "--sessions-dir", fx.sessionsDir], empty),
      1,
    );
    assert.match(empty.err.join("\n"), /no undo record for empty\.jsonl/);

    // A session without any workspace link cannot undo into a guess: seed a
    // record for it first so the missing link (not a missing record) is hit.
    fs.writeFileSync(
      path.join(fx.sessionsDir, "plain.jsonl"),
      sessionEnvelope(1, "user", "senior", "message", { text: "Plain" }) + "\n",
      "utf-8",
    );
    const runsDir = path.join(fx.sessionsDir, "undo", "runs");
    const chatRecord = JSON.parse(fs.readFileSync(path.join(runsDir, `${fx.runId}.json`), "utf-8"));
    fs.writeFileSync(
      path.join(runsDir, "run-plain.json"),
      JSON.stringify({ ...chatRecord, session: "plain.jsonl" }),
      "utf-8",
    );
    const plain = makeIO();
    assert.equal(
      await main(["sessions", "undo", "plain", "--sessions-dir", fx.sessionsDir], plain),
      1,
    );
    assert.match(plain.err.join("\n"), /no linked workspace/);

    // Discard needs no workspace link: cleanup still works after the
    // workspace was removed or the session never had one.
    const plainDiscard = makeIO();
    assert.equal(
      await main(
        ["sessions", "undo", "plain", "--run", "run-plain", "--discard", "--sessions-dir", fx.sessionsDir],
        plainDiscard,
      ),
      0,
      plainDiscard.err.join("\n"),
    );
    assert.match(plainDiscard.out.join("\n"), /discarded the undo record for plain\.jsonl/);
  });
});

test("sessions undo: usage errors exit 2 (no name, extra args, conflicting flags, bad run id)", async () => {
  const noName = makeIO();
  assert.equal(await main(["sessions", "undo"], noName), 2);
  assert.match(noName.err.join("\n"), /no session name/);

  const extra = makeIO();
  assert.equal(await main(["sessions", "undo", "a", "b"], extra), 2);
  assert.match(extra.err.join("\n"), /unexpected argument/);

  const conflict = makeIO();
  assert.equal(
    await main(["sessions", "undo", "chat", "--apply", "--discard"], conflict),
    2,
  );
  assert.match(conflict.err.join("\n"), /mutually exclusive/);

  await withTempDir(async (dir) => {
    const fx = await writeUndoFixture(dir);
    const badRun = makeIO();
    assert.equal(
      await main(
        ["sessions", "undo", "chat", "--run", "../escape", "--sessions-dir", fx.sessionsDir],
        badRun,
      ),
      2,
    );
    assert.match(badRun.err.join("\n"), /invalid undo run id/);
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
  assert.match(helpText, /sessions undo <name> \[--run <id>\] \[--apply\] \[--discard\]/);
  assert.match(helpText, /--format <markdown\|json\|html>/);
  assert.match(helpText, /--output <path>/);
  assert.match(helpText, /--at <seq>/);
  assert.match(helpText, /--name <name>/);
  assert.match(helpText, /--turns <n>/);
  assert.match(helpText, /--run <id>/);
  assert.match(helpText, /--apply/);
  assert.match(helpText, /--discard/);

  const bash = makeIO();
  assert.equal(await main(["completions", "bash"], bash), 0, bash.err.join("\n"));
  const script = bash.out.join("\n");
  assert.match(script, /--format/);
  assert.match(script, /--output/);
  assert.match(script, /--at/);
  assert.match(script, /--turns/);
  assert.match(script, /--run/);
  assert.match(script, /--apply/);
  assert.match(script, /--discard/);
  assert.match(script, /sessions/);
});
