/**
 * Server wiring for composer mentions: the workspace file-search endpoint and
 * run-submission preparation (slash-command expansion + `@skill:`/`@file`
 * context injection) on `POST /api/runs` and the legacy `POST /api/run`.
 *
 * Hermetic: `createServer` runs in-process against a temp sessions/workspace/
 * skills/commands layout and is exercised over real HTTP on an ephemeral port;
 * runs use the deterministic mock provider, so there is no network beyond
 * loopback and no sleeps beyond the run-completion poll.
 *
 * Run with: node --test tests/mentionswiring.test.ts
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { resolveConfig, type Config } from "../src/config.ts";
import { MENTION_MAX_FILES, MENTION_MAX_SKILLS, MENTION_MAX_TOTAL_CHARS } from "../src/mentions.ts";
import { createServer, type ServerHandle } from "../src/server.ts";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const CONSULT_KINDS = ["message", "consult", "proposal", "review", "decision"];

interface RunningServer {
  base: string;
  handle: ServerHandle;
  root: string;
  sessionsDir: string;
  workspaceDir: string;
  skillsDir: string;
  commandsDir: string;
  close(): Promise<void>;
}

async function startServer(): Promise<RunningServer> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-srv-mentions-"));
  const sessionsDir = path.join(root, "sessions");
  const workspaceDir = path.join(root, "workspace");
  const skillsDir = path.join(root, "skills");
  const commandsDir = path.join(root, "commands");
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(skillsDir, { recursive: true });
  fs.mkdirSync(commandsDir, { recursive: true });
  const handle = createServer({
    configFactory: () => resolveConfig({ provider: "mock", mode: "consult" }),
    webDist: null,
    sessionsDir,
    // Hermetic discovery roots: the repo's default skills/commands/plugins are
    // never touched.
    skillsDirs: [skillsDir],
    commandsDirs: [commandsDir],
    pluginsDir: path.join(root, "missing-plugins"),
  });
  const server = await handle.listen("127.0.0.1", 0);
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    handle,
    root,
    sessionsDir,
    workspaceDir,
    skillsDir,
    commandsDir,
    close: async () => {
      await handle.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

interface ApiResult<T = unknown> {
  status: number;
  body: T;
}

async function api<T = unknown>(
  base: string,
  method: string,
  route: string,
  body?: unknown,
): Promise<ApiResult<T>> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(base + route, init);
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed as T };
}

const get = <T = unknown>(base: string, route: string) => api<T>(base, "GET", route);
const post = <T = unknown>(base: string, route: string, body?: unknown) =>
  api<T>(base, "POST", route, body);

interface WorkspaceJson {
  id: string;
  name: string;
  path: string;
}

async function registerWorkspace(server: RunningServer, dir?: string): Promise<WorkspaceJson> {
  const res = await post<WorkspaceJson>(server.base, "/api/workspaces", {
    path: dir ?? server.workspaceDir,
    name: "mentions-ws",
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

function writeWorkspaceFile(server: RunningServer, rel: string, content: string | Buffer): string {
  const full = path.join(server.workspaceDir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

function writeSkill(
  server: RunningServer,
  name: string,
  body: string,
  scope: "shared" | "senior" | "junior" = "shared",
): void {
  const full = path.join(server.skillsDir, name, "SKILL.md");
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const frontmatter = [
    "---",
    `name: ${name}`,
    `description: ${name} skill`,
    `scope: ${scope}`,
    "---",
  ].join("\n");
  fs.writeFileSync(full, `${frontmatter}\n${body}`, "utf-8");
}

function writeCommand(
  server: RunningServer,
  name: string,
  body: string,
  options: { mode?: "consult" | "work"; argumentHint?: string } = {},
): void {
  const lines = ["---", `description: ${name} command`];
  if (options.argumentHint !== undefined) lines.push(`argument-hint: ${options.argumentHint}`);
  if (options.mode !== undefined) lines.push(`mode: ${options.mode}`);
  lines.push("---");
  fs.writeFileSync(
    path.join(server.commandsDir, `${name}.md`),
    `${lines.join("\n")}\n${body}`,
    "utf-8",
  );
}

function readSession(server: RunningServer, name: string): Array<Record<string, any>> {
  const text = fs.readFileSync(path.join(server.sessionsDir, name), "utf-8");
  return text
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, any>);
}

async function waitTerminal(
  base: string,
  runId: string,
  timeoutMs = 15000,
): Promise<Record<string, any>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const record = (await get<Record<string, any>>(base, `/api/runs/${runId}`)).body;
    if (["completed", "failed", "cancelled"].includes(String(record.status))) return record;
    if (Date.now() > deadline) throw new Error(`run ${runId} did not finish in time`);
    await sleep(25);
  }
}

interface FinishedRun {
  runId: string;
  session: string;
  record: Record<string, any>;
}

/** Submit one background run and wait for its terminal record. */
async function runToEnd(
  server: RunningServer,
  body: Record<string, unknown>,
): Promise<FinishedRun> {
  const started = await post<{ run_id: string; session: string; status: string }>(
    server.base,
    "/api/runs",
    body,
  );
  assert.equal(started.status, 202, JSON.stringify(started.body));
  assert.ok(started.body.run_id);
  const record = await waitTerminal(server.base, started.body.run_id);
  return { runId: started.body.run_id, session: started.body.session, record };
}

/** A 400 must leave no session file and no run record behind. */
async function assertNothingCreated(server: RunningServer): Promise<void> {
  assert.deepEqual((await get(server.base, "/api/sessions")).body, []);
  assert.deepEqual((await get(server.base, "/api/runs")).body, []);
  const files = fs.existsSync(server.sessionsDir)
    ? fs.readdirSync(server.sessionsDir).filter((file) => file.endsWith(".jsonl"))
    : [];
  assert.deepEqual(files, [], "a rejected submission must not create a session");
}

function expectDetail(res: ApiResult<{ detail?: string }>, status: number, detail: string): void {
  assert.equal(res.status, status, JSON.stringify(res.body));
  assert.equal(res.body.detail, detail);
}

const taskText = (event: Record<string, any>): string => String(event.payload?.text ?? "");

// ---------------------------------------------------------------------------
// GET /api/workspaces/{id}/files
// ---------------------------------------------------------------------------

interface FileEntryJson {
  path: string;
  size: number;
  mtime: number;
}

interface FilesBody {
  workspace_id: string;
  files: FileEntryJson[];
  truncated: boolean;
  total: number;
}

test("files endpoint: exact response shape and path order of the bounded index", async () => {
  const server = await startServer();
  try {
    const ws = await registerWorkspace(server);
    writeWorkspaceFile(server, "README.md", "# Read me\n");
    writeWorkspaceFile(server, "docs/guide.md", "guide body");
    writeWorkspaceFile(server, "src/main.ts", "export {};\n");

    const res = await get<FilesBody>(server.base, `/api/workspaces/${ws.id}/files`);
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.body), ["workspace_id", "files", "truncated", "total"]);
    assert.equal(res.body.workspace_id, ws.id);
    assert.equal(res.body.truncated, false);
    assert.equal(res.body.total, 3);
    assert.deepEqual(
      res.body.files.map((file) => file.path),
      ["README.md", "docs/guide.md", "src/main.ts"],
    );
    for (const file of res.body.files) {
      assert.deepEqual(Object.keys(file), ["path", "size", "mtime"]);
      assert.equal(typeof file.size, "number");
      assert.equal(typeof file.mtime, "number");
      assert.ok(file.mtime > 0);
    }
    assert.equal(res.body.files[0]?.size, Buffer.byteLength("# Read me\n", "utf-8"));
  } finally {
    await server.close();
  }
});

test("files endpoint: q ranks basename tiers and limit clamps with total/truncated", async () => {
  const server = await startServer();
  try {
    const ws = await registerWorkspace(server);
    // 4 matches for "notes" across the three ranking tiers, plus one non-match.
    writeWorkspaceFile(server, "docs/deep/notes", "exact basename");
    writeWorkspaceFile(server, "docs/notes.md", "basename prefix");
    writeWorkspaceFile(server, "notes.txt", "basename prefix at root");
    writeWorkspaceFile(server, "src/notes.ts", "basename prefix nested");
    writeWorkspaceFile(server, "other.txt", "no match");

    const ranked = await get<FilesBody>(
      server.base,
      `/api/workspaces/${ws.id}/files?q=${encodeURIComponent("notes")}`,
    );
    assert.equal(ranked.status, 200);
    // exact basename first, then prefix ties sorted by path
    assert.deepEqual(
      ranked.body.files.map((file) => file.path),
      ["docs/deep/notes", "docs/notes.md", "notes.txt", "src/notes.ts"],
    );
    assert.equal(ranked.body.total, 4);
    assert.equal(ranked.body.truncated, false);

    const trimmed = await get<FilesBody>(
      server.base,
      `/api/workspaces/${ws.id}/files?q=${encodeURIComponent("  notes  ")}`,
    );
    assert.deepEqual(
      trimmed.body.files.map((file) => file.path),
      ["docs/deep/notes", "docs/notes.md", "notes.txt", "src/notes.ts"],
      "the query is trimmed",
    );

    const one = await get<FilesBody>(server.base, `/api/workspaces/${ws.id}/files?q=notes&limit=1`);
    assert.equal(one.body.files.length, 1);
    assert.equal(one.body.files[0]?.path, "docs/deep/notes");
    assert.equal(one.body.total, 4, "total counts matches before the page limit");
    assert.equal(one.body.truncated, true, "the page limit clipped the result");

    const zero = await get<FilesBody>(server.base, `/api/workspaces/${ws.id}/files?q=notes&limit=0`);
    assert.equal(zero.status, 200);
    assert.equal(zero.body.files.length, 1, "limit=0 clamps up to 1");

    const clampedHigh = await get<FilesBody>(
      server.base,
      `/api/workspaces/${ws.id}/files?q=notes&limit=999`,
    );
    assert.equal(clampedHigh.body.files.length, 4, "limit=999 clamps to 200 (all matches here)");
    assert.equal(clampedHigh.body.truncated, false);

    const defaulted = await get<FilesBody>(
      server.base,
      `/api/workspaces/${ws.id}/files?q=notes&limit=abc`,
    );
    assert.equal(defaulted.body.files.length, 4, "non-numeric limit uses the 50 default");

    const none = await get<FilesBody>(server.base, `/api/workspaces/${ws.id}/files?q=zzz`);
    assert.deepEqual(none.body.files, []);
    assert.equal(none.body.total, 0);
    assert.equal(none.body.truncated, false);

    // blank query returns the whole index in path order (page-limited)
    const all = await get<FilesBody>(server.base, `/api/workspaces/${ws.id}/files?q=`);
    assert.deepEqual(
      all.body.files.map((file) => file.path),
      ["docs/deep/notes", "docs/notes.md", "notes.txt", "other.txt", "src/notes.ts"],
    );
    assert.equal(all.body.total, 5);
  } finally {
    await server.close();
  }
});

test("files endpoint: unknown workspace is 404 and a missing directory is empty", async () => {
  const server = await startServer();
  try {
    expectDetail(
      await get<{ detail?: string }>(server.base, "/api/workspaces/nope/files"),
      404,
      "not found",
    );

    // A registered workspace whose directory vanished later: empty, no throw.
    const goneDir = path.join(server.root, "gone-workspace");
    fs.mkdirSync(goneDir, { recursive: true });
    const gone = await registerWorkspace(server, goneDir);
    fs.rmSync(goneDir, { recursive: true, force: true });
    const res = await get<FilesBody>(server.base, `/api/workspaces/${gone.id}/files`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {
      workspace_id: gone.id,
      files: [],
      truncated: false,
      total: 0,
    });
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// slash-command expansion
// ---------------------------------------------------------------------------

test("slash command: known name expands with $1, overrides the mode, keeps the raw title", async () => {
  const server = await startServer();
  try {
    // The command's mode must beat an explicit request mode for this run only.
    writeCommand(server, "review", "Review the change to $1 carefully.", { mode: "work" });

    const run = await runToEnd(server, { task: "/review widget", mode: "consult" });
    assert.equal(run.record.status, "completed");
    assert.equal(run.record.mode, "work", "the command mode overrides the request mode");
    assert.equal(run.record.task, "Review the change to widget carefully.");

    const events = readSession(server, run.session);
    assert.equal(taskText(events[0] ?? {}), "Review the change to widget carefully.");
    assert.equal(events[0]?.from, "user");
    assert.equal(events[0]?.kind, "message");

    // The sidecar title keeps the RAW operator line (the slash invocation).
    const sessions = await get<Array<Record<string, any>>>(server.base, "/api/sessions");
    const summary = sessions.body.find((item) => item.name === run.session);
    assert.equal(summary?.title, "/review widget");

    // The session detail (the transcript view) starts with the expanded task.
    const detail = await get<Record<string, any>>(
      server.base,
      `/api/sessions/${encodeURIComponent(run.session)}`,
    );
    assert.equal(detail.status, 200);
    assert.equal(taskText(detail.body.events[0]), "Review the change to widget carefully.");
  } finally {
    await server.close();
  }
});

test("slash command: unknown and path-like slash lines are submitted verbatim", async () => {
  const server = await startServer();
  try {
    writeCommand(server, "known", "Expanded: $ARGUMENTS");

    const unknown = await runToEnd(server, { task: "/notacommand hello there" });
    assert.equal(unknown.record.status, "completed");
    assert.equal(taskText(readSession(server, unknown.session)[0] ?? {}), "/notacommand hello there");

    // `/usr/bin/env` is not a command line at all (the name token is "usr/bin").
    const pathLike = await runToEnd(server, { task: "/usr/bin/env node --version" });
    assert.equal(taskText(readSession(server, pathLike.session)[0] ?? {}), "/usr/bin/env node --version");

    // A catalog command still expands, proving the catalog is consulted.
    const known = await runToEnd(server, { task: "/known with args" });
    assert.equal(taskText(readSession(server, known.session)[0] ?? {}), "Expanded: with args");

    // A known command with an empty template must not submit an empty task.
    writeCommand(server, "empty", "");
    const sessionsBefore = (await get<Array<Record<string, any>>>(server.base, "/api/sessions"))
      .body.length;
    expectDetail(
      await post<{ detail?: string }>(server.base, "/api/runs", { task: "/empty nothing" }),
      400,
      "task must not be empty",
    );
    assert.equal(
      (await get<Array<Record<string, any>>>(server.base, "/api/sessions")).body.length,
      sessionsBefore,
      "the rejected empty expansion created no session",
    );
  } finally {
    await server.close();
  }
});

test("legacy POST /api/run: expansion and skill injection are prepared the same way", async () => {
  const server = await startServer();
  try {
    writeSkill(server, "notes", "# Notes\nUse short notes.");
    writeCommand(server, "summarize", "Summarize: $ARGUMENTS");
    const raw = "/summarize @skill:notes the changelog";

    const res = await post<Record<string, any>>(server.base, "/api/run", { task: raw });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((res.body.events as unknown[]).length, CONSULT_KINDS.length);

    const name = String(res.body.session);
    const events = readSession(server, name);
    // Injected block first, then the expanded task, then the consult cycle.
    assert.equal(
      taskText(events[0] ?? {}),
      '<skill-loaded name="notes">\n# Notes\nUse short notes.\n</skill-loaded>',
    );
    assert.equal(taskText(events[1] ?? {}), "Summarize: @skill:notes the changelog");
    assert.deepEqual(events.slice(1).map((event) => event.kind), CONSULT_KINDS);

    const sessions = await get<Array<Record<string, any>>>(server.base, "/api/sessions");
    assert.equal(sessions.body.find((item) => item.name === name)?.title, raw);
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// @skill: injection
// ---------------------------------------------------------------------------

test("skill mention: a shared skill body is injected before the task and deduped", async () => {
  const server = await startServer();
  try {
    writeSkill(server, "notes", "# Notes\nUse short notes.");

    const run = await runToEnd(server, {
      task: "Apply @skill:notes to the change (also @skill:notes)",
    });
    assert.equal(run.record.status, "completed");

    const events = readSession(server, run.session);
    assert.equal(events.length, CONSULT_KINDS.length + 1);
    assert.deepEqual(
      events.map((event) => event.seq),
      Array.from({ length: events.length }, (_, index) => index + 1),
      "injections take a dense seq like every other envelope",
    );
    assert.equal(events[0]?.from, "user");
    assert.equal(events[0]?.to, "senior");
    assert.equal(events[0]?.kind, "message");
    assert.equal(
      taskText(events[0] ?? {}),
      '<skill-loaded name="notes">\n# Notes\nUse short notes.\n</skill-loaded>',
      "the exact renderSkillLoadedBlock bytes",
    );
    assert.equal(
      taskText(events[1] ?? {}),
      "Apply @skill:notes to the change (also @skill:notes)",
      "the task envelope is unchanged and keeps the tokens for traceability",
    );
    assert.equal(events[1]?.kind, "message");

    // The transcript view (session detail) renders the same order.
    const detail = await get<Record<string, any>>(
      server.base,
      `/api/sessions/${encodeURIComponent(run.session)}`,
    );
    assert.equal(taskText(detail.body.events[0]), taskText(events[0] ?? {}));
    assert.equal(taskText(detail.body.events[1]), taskText(events[1] ?? {}));
  } finally {
    await server.close();
  }
});

test("skill mention errors: role-scoped, unknown and over the count cap are 400s", async () => {
  const server = await startServer();
  try {
    writeSkill(server, "audit", "# Audit", "senior");
    for (let index = 1; index <= MENTION_MAX_SKILLS + 1; index += 1) {
      writeSkill(server, `s${index}`, `# S${index}`);
    }

    expectDetail(
      await post<{ detail?: string }>(server.base, "/api/runs", { task: "Use @skill:audit" }),
      400,
      "role-scoped skills cannot be operator mentions: audit (scope: senior)",
    );
    expectDetail(
      await post<{ detail?: string }>(server.base, "/api/runs", { task: "Use @skill:nope" }),
      400,
      "unknown skill: nope",
    );
    const tooMany = `@skill:s1 ${Array.from(
      { length: MENTION_MAX_SKILLS + 1 },
      (_, index) => `@skill:s${index + 1}`,
    ).join(" ")}`;
    expectDetail(
      await post<{ detail?: string }>(server.base, "/api/runs", { task: tooMany }),
      400,
      `too many skill mentions: ${MENTION_MAX_SKILLS + 1} (max ${MENTION_MAX_SKILLS})`,
    );
    await assertNothingCreated(server);
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// @file injection
// ---------------------------------------------------------------------------

test("file mention: content is injected as a <file> block before the task and deduped", async () => {
  const server = await startServer();
  try {
    const ws = await registerWorkspace(server);
    writeWorkspaceFile(server, "docs/note.md", "# Note\nhello");

    // Two spellings of the same file: normalized to one attachment.
    const run = await runToEnd(server, {
      task: "Use @docs/note.md and @./docs/note.md",
      workspace_id: ws.id,
    });
    assert.equal(run.record.status, "completed");

    const events = readSession(server, run.session);
    assert.equal(events.length, CONSULT_KINDS.length + 1);
    assert.equal(
      taskText(events[0] ?? {}),
      '<file path="docs/note.md">\n# Note\nhello\n</file>',
      "the exact renderFileBlock bytes (normalized path, content verbatim)",
    );
    assert.equal(taskText(events[1] ?? {}), "Use @docs/note.md and @./docs/note.md");

    const detail = await get<Record<string, any>>(
      server.base,
      `/api/sessions/${encodeURIComponent(run.session)}`,
    );
    assert.equal(taskText(detail.body.events[0]), taskText(events[0] ?? {}));
  } finally {
    await server.close();
  }
});

test("injection order: skills come before files regardless of mention order", async () => {
  const server = await startServer();
  try {
    const ws = await registerWorkspace(server);
    writeSkill(server, "notes", "# Notes");
    writeWorkspaceFile(server, "docs/note.md", "hello");

    const run = await runToEnd(server, {
      task: "@docs/note.md then @skill:notes",
      workspace_id: ws.id,
    });
    const events = readSession(server, run.session);
    assert.equal(taskText(events[0] ?? {}), '<skill-loaded name="notes">\n# Notes\n</skill-loaded>');
    assert.equal(taskText(events[1] ?? {}), '<file path="docs/note.md">\nhello\n</file>');
    assert.equal(taskText(events[2] ?? {}), "@docs/note.md then @skill:notes");
  } finally {
    await server.close();
  }
});

test("file mention: an over-long file is attached truncated with the standard marker", async () => {
  const server = await startServer();
  try {
    const ws = await registerWorkspace(server);
    writeWorkspaceFile(server, "big/one.txt", "word ".repeat(8000)); // 40000 chars

    const run = await runToEnd(server, { task: "Read @big/one.txt", workspace_id: ws.id });
    const block = taskText(readSession(server, run.session)[0] ?? {});
    assert.ok(block.startsWith('<file path="big/one.txt">\n'), block.slice(0, 60));
    assert.ok(block.endsWith("\n</file>"), block.slice(-30));
    assert.ok(block.includes("truncated"), "the per-file cap is reported inside the block");
    assert.ok(block.includes("… [file truncated]"));
  } finally {
    await server.close();
  }
});

test("file mention errors: workspace requirement, missing/sensitive/absolute/traversal/binary", async () => {
  const server = await startServer();
  try {
    const ws = await registerWorkspace(server);
    writeWorkspaceFile(server, "docs/note.md", "# Note\nhello");
    writeWorkspaceFile(server, "secrets/.env", "TOKEN=secret");
    writeWorkspaceFile(server, "assets/blob.bin", Buffer.from([0x61, 0x00, 0x62]));

    expectDetail(
      await post<{ detail?: string }>(server.base, "/api/runs", { task: "Read @docs/note.md" }),
      400,
      "file mentions require a workspace",
    );
    // ensureWorkspace runs first on /api/runs, same detail as the other routes.
    expectDetail(
      await post<{ detail?: string }>(server.base, "/api/runs", {
        task: "Read @docs/note.md",
        workspace_id: "nope",
      }),
      400,
      "unknown workspace_id",
    );
    expectDetail(
      await post<{ detail?: string }>(server.base, "/api/runs", {
        task: "Read @docs/missing.md",
        workspace_id: ws.id,
      }),
      400,
      'cannot attach file "@docs/missing.md": no such file or directory: docs/missing.md',
    );
    expectDetail(
      await post<{ detail?: string }>(server.base, "/api/runs", {
        task: "Read @secrets/.env",
        workspace_id: ws.id,
      }),
      400,
      'cannot attach file "@secrets/.env": sensitive file refused (.env): secrets/.env',
    );
    expectDetail(
      await post<{ detail?: string }>(server.base, "/api/runs", {
        task: "Read @/etc/passwd",
        workspace_id: ws.id,
      }),
      400,
      'cannot attach file "@/etc/passwd": absolute paths are not allowed: /etc/passwd',
    );
    expectDetail(
      await post<{ detail?: string }>(server.base, "/api/runs", {
        task: "Read @../outside.txt",
        workspace_id: ws.id,
      }),
      400,
      'cannot attach file "@../outside.txt": path escapes the workspace: ../outside.txt',
    );
    expectDetail(
      await post<{ detail?: string }>(server.base, "/api/runs", {
        task: "Read @assets/blob.bin",
        workspace_id: ws.id,
      }),
      400,
      'cannot attach file "@assets/blob.bin": not a text file',
    );
    await assertNothingCreated(server);
  } finally {
    await server.close();
  }
});

test("file mention errors: the per-task count cap and the total-content cap are 400s", async () => {
  const server = await startServer();
  try {
    const ws = await registerWorkspace(server);
    const tooMany = Array.from({ length: MENTION_MAX_FILES + 1 }, (_, index) => `f/${index}.txt`);
    for (const rel of tooMany) writeWorkspaceFile(server, rel, "x");
    expectDetail(
      await post<{ detail?: string }>(
        server.base,
        "/api/runs",
        { task: tooMany.map((rel) => `@${rel}`).join(" "), workspace_id: ws.id },
      ),
      400,
      `too many file mentions: ${MENTION_MAX_FILES + 1} (max ${MENTION_MAX_FILES})`,
    );

    // 5 files at the per-file cap: boundOutput's marker makes the attached
    // content exceed the 100 000-char total, so the request is refused.
    const big = Array.from({ length: MENTION_MAX_FILES }, (_, index) => `big/${index}.txt`);
    for (const rel of big) writeWorkspaceFile(server, rel, "a".repeat(30_000));
    const total = await post<{ detail?: string }>(server.base, "/api/runs", {
      task: big.map((rel) => `@${rel}`).join(" "),
      workspace_id: ws.id,
    });
    assert.equal(total.status, 400, JSON.stringify(total.body));
    assert.match(
      String(total.body.detail),
      new RegExp(
        `^attached mention content exceeds the ${MENTION_MAX_TOTAL_CHARS}-character limit: \\d+ characters$`,
      ),
    );
    await assertNothingCreated(server);
  } finally {
    await server.close();
  }
});
