/**
 * Server wiring for the first-party base command catalogue + manual session
 * compaction.
 *
 * Hermetic: `createServer` runs in-process over a temp sessions directory on an
 * ephemeral port with the deterministic mock provider. Covers:
 * - base `prompt` command expansion on run submission (`/plan`, aliases, mode
 *   override), discovered-template shadowing, usage 400s and the action-command
 *   defensive 400 (`/compact` submitted as a task), unknown slash verbatim;
 * - `POST /api/sessions/{name}/compact`: 404/400 name handling, 409 under a
 *   live run, honest `{compacted:false}` on a tiny session, in-place JSONL
 *   rewrite with a summary event + dense seq, and 502 provider failure leaving
 *   the session untouched.
 *
 * Run with: node --test tests/serverbase.test.ts
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import {
  baseCommandUsage,
  expandBaseCommand,
  findBaseCommand,
} from "../src/basecommands.ts";
import { COMPACTION_SUMMARY_PREFIX, isCompactionSummary } from "../src/compaction.ts";
import { resolveConfig } from "../src/config.ts";
import type { ChatMessage } from "../src/context.ts";
import type { Message } from "../src/protocol.ts";
import {
  MockProvider,
  type ChatOptions,
  type Provider,
} from "../src/provider.ts";
import {
  createServer,
  type ServerHandle,
  type ServerOptions,
} from "../src/server.ts";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tmpdir(prefix: string): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

interface RunningServer {
  base: string;
  handle: ServerHandle;
  /** Sessions directory (also `--sessions-dir`). */
  dir: string;
  close(): Promise<void>;
}

async function startServer(options: ServerOptions = {}): Promise<RunningServer> {
  const tmp = tmpdir("tb-srv-base-");
  const sessionsDir = options.sessionsDir ? path.resolve(options.sessionsDir) : tmp.root;
  const handle = createServer({
    configFactory: () => resolveConfig({ provider: "mock", mode: "consult" }),
    webDist: null,
    commandsDirs: [],
    pluginsDir: path.join(tmp.root, "missing-plugins"),
    ...options,
    sessionsDir,
  });
  const server = await handle.listen("127.0.0.1", 0);
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    handle,
    dir: sessionsDir,
    close: async () => {
      await handle.close();
      tmp.cleanup();
    },
  };
}

async function api<T = unknown>(
  base: string,
  method: string,
  route: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
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
    await sleep(20);
  }
}

async function runToEnd(
  server: RunningServer,
  body: Record<string, unknown>,
): Promise<Record<string, any>> {
  const started = await post<{ run_id: string; session: string; status: string }>(
    server.base,
    "/api/runs",
    body,
  );
  assert.equal(started.status, 202, JSON.stringify(started.body));
  return waitTerminal(server.base, started.body.run_id);
}

function readSession(server: RunningServer, name: string): Array<Record<string, any>> {
  const text = fs.readFileSync(path.join(server.dir, name), "utf-8");
  return text
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, any>);
}

/** One valid protocol envelope line for a seeded session file. */
function envelope(
  seq: number,
  from: string,
  to: string,
  text: string,
): Message {
  return {
    v: 1,
    id: `msg-${seq}`,
    seq,
    ts: "2026-11-07T00:00:00Z",
    from,
    to,
    kind: "message",
    payload: { text },
  };
}

/** Seed a session JSONL; the first event is the operator task (compaction head). */
function seedSession(
  server: RunningServer,
  name: string,
  texts: string[],
): string {
  const lines = texts.map((text, index) =>
    JSON.stringify(
      envelope(
        index + 1,
        index === 0 ? "user" : "senior",
        index === 0 ? "senior" : "junior",
        text,
      ),
    ),
  );
  const file = path.join(server.dir, name);
  fs.writeFileSync(file, lines.join("\n") + "\n", "utf-8");
  return file;
}

/** A provider whose first call parks on a gate (keeps a run live for the 409). */
function blockingMock(): { provider: Provider; release: () => void } {
  const inner = new MockProvider();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const provider: Provider = {
    async chat(
      messages: ChatMessage[],
      responseKind?: string,
      signal?: AbortSignal,
      options?: ChatOptions,
    ): Promise<string> {
      await gate;
      return inner.chat(messages, responseKind, signal, options);
    },
    async chatWithTools(messages, tools, options) {
      await gate;
      return inner.chatWithTools(messages, tools, options);
    },
  };
  return { provider, release: () => release() };
}

/** A summarizer that always fails (the 502 case). */
function failingMock(message: string): Provider {
  return {
    async chat(): Promise<string> {
      throw new Error(message);
    },
  };
}

async function waitActive(
  server: RunningServer,
  session: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const records = (
      await get<Array<Record<string, any>>>(
        server.base,
        `/api/runs?session=${encodeURIComponent(session)}`,
      )
    ).body;
    if (records.some((record) => ["queued", "running", "waiting"].includes(String(record.status)))) {
      return;
    }
    if (Date.now() > deadline) throw new Error(`run for ${session} never became active`);
    await sleep(10);
  }
}

// ---------------------------------------------------------------------------
// base prompt commands on run submission
// ---------------------------------------------------------------------------

test("base /plan expands into the submitted task and applies its mode override", async () => {
  const server = await startServer();
  try {
    // `/plan` is a consult-mode base prompt command; ask for `work` explicitly:
    // the command mode must win for this run only.
    const record = await runToEnd(
      server,
      { task: "/plan improve the cache", mode: "work" },
    );
    assert.equal(record.status, "completed");
    assert.equal(record.mode, "consult", "the base command's mode overrides the request");
    const expanded = expandBaseCommand(findBaseCommand("plan")!, "improve the cache");
    assert.equal(record.task, expanded);
    assert.ok(expanded.includes("Objective: improve the cache"));

    // The session transcript + derived title: expanded task, raw operator title.
    const sessionName = String(record.session);
    const events = readSession(server, sessionName);
    assert.equal(events[0]?.from, "user");
    assert.equal(events[0]?.kind, "message");
    assert.equal(events[0]?.payload?.text, expanded);
    const listed = (await get<Array<Record<string, any>>>(server.base, "/api/sessions")).body;
    assert.equal(
      listed.find((item) => item.name === sessionName)?.title,
      "/plan improve the cache",
      "the metadata title keeps the raw operator line",
    );

    // Aliases resolve too (`objective` is a `goal` alias); `/goal` is also a
    // consult-mode prompt.
    const alias = await runToEnd(server, { task: "/objective ship v2" });
    assert.equal(alias.mode, "consult");
    assert.equal(
      alias.task,
      expandBaseCommand(findBaseCommand("objective")!, "ship v2"),
    );
    assert.equal(readSession(server, String(alias.session))[0]?.payload?.text, alias.task);
  } finally {
    await server.close();
  }
});

test("a discovered plan.md shadows the base plan command", async () => {
  const commands = tmpdir("tb-srv-base-commands-");
  const planFile = path.join(commands.root, "plan.md");
  fs.writeFileSync(
    planFile,
    ["---", "description: Operator plan template", "---", "CUSTOM PLAN FOR: $ARGUMENTS", ""].join(
      "\n",
    ),
    "utf-8",
  );
  const server = await startServer({ commandsDirs: [commands.root] });
  try {
    // No base mode override from the discovered template, so the request mode
    // survives: proof the discovered command handled the line, not the base one.
    const record = await runToEnd(server, { task: "/plan x", mode: "work" });
    assert.equal(record.task, "CUSTOM PLAN FOR: x");
    assert.equal(record.mode, "work");
    assert.equal(readSession(server, String(record.session))[0]?.payload?.text, "CUSTOM PLAN FOR: x");
  } finally {
    await server.close();
    commands.cleanup();
  }
});

test("base command usage/action errors are 400s; unknown slash lines stay verbatim", async () => {
  const server = await startServer();
  try {
    // `/plan` requires an argument: honest usage 400, nothing created.
    const usage = await post<{ detail?: string }>(server.base, "/api/runs", { task: "/plan" });
    assert.equal(usage.status, 400);
    assert.equal(usage.body.detail, `usage: ${baseCommandUsage(findBaseCommand("plan")!)}`);
    assert.equal(usage.body.detail, "usage: /plan <objective>");

    // An action command is never a task: the defensive 400 points at the
    // surface and, for /compact, at the route that performs it.
    const action = await post<{ detail?: string }>(server.base, "/api/runs", { task: "/compact" });
    assert.equal(action.status, 400);
    assert.match(String(action.body.detail), /^\/compact is a built-in action, not a task:/);
    assert.ok(String(action.body.detail).includes("POST /api/sessions/{name}/compact"));
    // The legacy sync route shares the same preparation.
    const legacyAction = await post<{ detail?: string }>(server.base, "/api/run", {
      task: "/compact",
    });
    assert.equal(legacyAction.status, 400);
    assert.equal(legacyAction.body.detail, action.body.detail);
    // Rejected submissions created no session or run.
    assert.deepEqual((await get(server.base, "/api/sessions")).body, []);
    assert.deepEqual((await get(server.base, "/api/runs")).body, []);

    // Unknown slash lines are not base commands and stay verbatim.
    const verbatim = await post<Record<string, any>>(server.base, "/api/run", {
      task: "/usr/bin/x foo",
    });
    assert.equal(verbatim.status, 200, JSON.stringify(verbatim.body));
    const events = readSession(server, String(verbatim.body.session));
    assert.equal(events[0]?.payload?.text, "/usr/bin/x foo");
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// POST /api/sessions/{name}/compact
// ---------------------------------------------------------------------------

test("compact: 404 for an unknown session and 400 for an unsafe session name", async () => {
  const server = await startServer();
  try {
    const missing = await post<{ detail?: string }>(
      server.base,
      "/api/sessions/nope.jsonl/compact",
    );
    assert.equal(missing.status, 404);
    assert.equal(missing.body.detail, "not found");

    // Same name parsing as the sibling session routes: `.jsonl` required.
    const badName = await post<{ detail?: string }>(server.base, "/api/sessions/nope/compact");
    assert.equal(badName.status, 400);
    assert.equal(badName.body.detail, "invalid session name");
  } finally {
    await server.close();
  }
});

test("compact: a tiny session is honestly 'nothing to compact' and stays untouched", async () => {
  const server = await startServer();
  try {
    const file = seedSession(server, "tiny.jsonl", ["Small task.", "A short reply."]);
    const beforeBytes = fs.readFileSync(file, "utf-8");

    const res = await post<Record<string, unknown>>(
      server.base,
      "/api/sessions/tiny.jsonl/compact",
    );
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body, { compacted: false, reason: "nothing to compact" });
    assert.equal(fs.readFileSync(file, "utf-8"), beforeBytes, "no rewrite happened");
  } finally {
    await server.close();
  }
});

test("compact: a long session is rewritten in place with a dense-seq summary", async () => {
  // A small keep-recent budget makes the cut deterministic for the fixture.
  const server = await startServer({ compaction: { keepRecentChars: 300 } });
  try {
    const texts = ["Do the long task."];
    for (let index = 1; index <= 11; index += 1) {
      texts.push(`Turn ${index}: ${"detail ".repeat(12)}`);
    }
    const file = seedSession(server, "long.jsonl", texts);
    const before = readSession(server, "long.jsonl");
    assert.equal(before.length, 12);

    const res = await post<{
      compacted: boolean;
      before_events: number;
      after_events: number;
    }>(server.base, "/api/sessions/long.jsonl/compact");
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(Object.keys(res.body), ["compacted", "before_events", "after_events"]);
    assert.equal(res.body.compacted, true);
    assert.equal(res.body.before_events, 12);
    assert.ok(res.body.after_events < res.body.before_events);

    // The file on disk was rewritten the harness way: dense `seq`, one JSONL
    // envelope per line, first task head kept, exactly one summary envelope.
    const after = readSession(server, "long.jsonl");
    assert.equal(after.length, res.body.after_events);
    assert.deepEqual(
      after.map((event) => event.seq),
      Array.from({ length: after.length }, (_, index) => index + 1),
      "compaction renumbers to dense seq",
    );
    assert.equal(after[0]?.payload?.text, "Do the long task.", "the task head stays first");
    const summaries = after.filter((event) => isCompactionSummary(event as unknown as Message));
    assert.equal(summaries.length, 1);
    assert.ok(
      String(summaries[0]?.payload?.text).startsWith(COMPACTION_SUMMARY_PREFIX),
      "the summary envelope carries the context-summary marker",
    );

    // A page reload sees the compacted transcript.
    const detail = await get<Record<string, any>>(
      server.base,
      "/api/sessions/long.jsonl",
    );
    assert.equal(detail.status, 200);
    assert.equal((detail.body.events as unknown[]).length, res.body.after_events);
    assert.ok(
      (detail.body.events as Array<Record<string, any>>).some((event) =>
        String(event.payload?.text ?? "").startsWith(COMPACTION_SUMMARY_PREFIX),
      ),
    );
    assert.equal(fs.statSync(file).isFile(), true);
  } finally {
    await server.close();
  }
});

test("compact: 409 while a run for the session is live", async () => {
  const gate = blockingMock();
  const server = await startServer({
    providerOverrides: { senior: gate.provider, junior: gate.provider },
  });
  try {
    const created = await post<Record<string, any>>(server.base, "/api/sessions", {
      title: "busy session",
    });
    assert.equal(created.status, 201);
    const sessionName = String(created.body.name);
    const started = await post<{ run_id: string }>(server.base, "/api/runs", {
      task: "do some work",
      session: sessionName,
    });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    await waitActive(server, sessionName);

    const res = await post<{ detail?: string }>(
      server.base,
      `/api/sessions/${encodeURIComponent(sessionName)}/compact`,
    );
    assert.equal(res.status, 409);
    assert.equal(res.body.detail, "a run is active for this session; stop it before compacting");

    gate.release();
    assert.equal(await server.handle.state.runs.wait(started.body.run_id), true);
  } finally {
    await server.close();
  }
});

test("compact: a summarizer failure is a 502 and leaves the session byte-identical", async () => {
  const server = await startServer({
    compaction: { keepRecentChars: 300 },
    providerOverrides: { senior: failingMock("summarizer exploded") },
  });
  try {
    const texts = ["Do the long task."];
    for (let index = 1; index <= 11; index += 1) {
      texts.push(`Turn ${index}: ${"detail ".repeat(12)}`);
    }
    const file = seedSession(server, "broken.jsonl", texts);
    const beforeBytes = fs.readFileSync(file, "utf-8");

    const res = await post<{ detail?: string }>(
      server.base,
      "/api/sessions/broken.jsonl/compact",
    );
    assert.equal(res.status, 502);
    assert.equal(res.body.detail, "summarizer exploded");
    assert.equal(
      fs.readFileSync(file, "utf-8"),
      beforeBytes,
      "a failed compaction writes nothing",
    );
  } finally {
    await server.close();
  }
});
