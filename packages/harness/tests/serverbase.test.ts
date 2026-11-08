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
 *   the session untouched;
 * - the maintenance guard: a run submitted (either run route) while a
 *   compaction is inside the summarizer is a 409 and its envelopes are never
 *   dropped by the rewrite; two concurrent compactions are one 200 + one 409;
 * - the compact P2s: budgets from the resolved config when
 *   `ServerOptions.compaction` is unset, a corrupt JSONL as a stable 422
 *   without paths, and a client disconnect aborting the summarizer while
 *   releasing the guard.
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
import {
  compactionFieldsFromConfig,
  compactionSettingsFromConfig,
  resolveConfig,
} from "../src/config.ts";
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

/**
 * A mock provider whose first call parks on a gate and honours the abort
 * signal: the P1/P2 concurrency tests use it to hold a compaction inside the
 * summarizer while they probe run admission, and to release it on command.
 */
interface ControllableMock {
  provider: Provider;
  /** Resolves when a provider call reaches the gate. */
  started: Promise<void>;
  /** Resolves when the in-flight call observes an abort. */
  aborted: Promise<void>;
  release(): void;
}

function controllableMock(): ControllableMock {
  const inner = new MockProvider();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let markAborted!: () => void;
  const aborted = new Promise<void>((resolve) => {
    markAborted = resolve;
  });
  const provider: Provider = {
    async chat(
      messages: ChatMessage[],
      responseKind?: string,
      signal?: AbortSignal,
      options?: ChatOptions,
    ): Promise<string> {
      markStarted();
      await new Promise<void>((resolve, reject) => {
        const onAbort = (): void => {
          signal?.removeEventListener("abort", onAbort);
          markAborted();
          reject(new Error("summarizer aborted"));
        };
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener("abort", onAbort, { once: true });
        void gate.then(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        });
      });
      return inner.chat(messages, responseKind, signal, options);
    },
  };
  return { provider, started, aborted, release: () => release() };
}

async function waitFor(cond: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

/** A long-enough session fixture for the deterministic keepRecent=300 budget. */
function seedLongSession(server: RunningServer, name: string): string {
  const texts = ["Do the long task."];
  for (let index = 1; index <= 11; index += 1) {
    texts.push(`Turn ${index}: ${"detail ".repeat(12)}`);
  }
  return seedSession(server, name, texts);
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

// ---------------------------------------------------------------------------
// P1: compaction is serialized against run submission
// ---------------------------------------------------------------------------

test("compact: a run submitted during a compaction is rejected and the rewrite drops nothing", async () => {
  const gate = controllableMock();
  const server = await startServer({
    compaction: { keepRecentChars: 300 },
    providerOverrides: { senior: gate.provider, junior: gate.provider },
  });
  try {
    const file = seedLongSession(server, "race.jsonl");
    const beforeBytes = fs.readFileSync(file, "utf-8");

    const pendingCompact = post<{ compacted: boolean; before_events: number; after_events: number }>(
      server.base,
      "/api/sessions/race.jsonl/compact",
    );
    await gate.started;

    // Run admission must refuse while the session is reserved — for both run
    // routes, before any session file or run record exists.
    const background = await post<{ detail?: string }>(server.base, "/api/runs", {
      task: "intruder task",
      session: "race.jsonl",
    });
    assert.equal(background.status, 409);
    assert.equal(
      background.body.detail,
      "a compaction is in progress for this session; retry in a moment",
    );
    const legacy = await post<{ detail?: string }>(server.base, "/api/run", {
      task: "legacy intruder task",
      session: "race.jsonl",
    });
    assert.equal(legacy.status, 409);
    assert.equal(legacy.body.detail, background.body.detail);
    assert.deepEqual((await get(server.base, "/api/runs")).body, []);
    assert.equal(fs.readFileSync(file, "utf-8"), beforeBytes, "no run touched the session");

    // Release the summarizer: exactly one compaction completes, rewriting the
    // original snapshot (which never saw the rejected submissions).
    gate.release();
    const compacted = await pendingCompact;
    assert.equal(compacted.status, 200, JSON.stringify(compacted.body));
    assert.equal(compacted.body.compacted, true);
    const afterCompact = readSession(server, "race.jsonl");
    assert.equal(afterCompact.length, compacted.body.after_events);
    assert.deepEqual(
      afterCompact.map((event) => event.seq),
      Array.from({ length: afterCompact.length }, (_, index) => index + 1),
    );
    assert.equal(
      afterCompact.filter((event) => isCompactionSummary(event as unknown as Message)).length,
      1,
    );
    assert.ok(!JSON.stringify(afterCompact).includes("intruder"));
    assert.ok(!JSON.stringify(afterCompact).includes("legacy intruder"));

    // A run submitted after the release is accepted and appends to the
    // compacted session with dense seq (the P1 corruption is gone).
    const record = await runToEnd(server, { task: "after compaction", session: "race.jsonl" });
    assert.equal(record.status, "completed");
    const finalEvents = readSession(server, "race.jsonl");
    assert.deepEqual(
      finalEvents.map((event) => event.seq),
      Array.from({ length: finalEvents.length }, (_, index) => index + 1),
      "resume after compaction keeps dense seq",
    );
    assert.ok(
      finalEvents.some((event) => event.payload?.text === "after compaction"),
      "the post-compaction run's task is persisted",
    );
  } finally {
    await server.close();
  }
});

test("compact: a second concurrent compaction is a 409 and one summary is written", async () => {
  const gate = controllableMock();
  const server = await startServer({
    compaction: { keepRecentChars: 300 },
    providerOverrides: { senior: gate.provider, junior: gate.provider },
  });
  try {
    const file = seedLongSession(server, "twice.jsonl");

    const first = post<{ compacted: boolean }>(
      server.base,
      "/api/sessions/twice.jsonl/compact",
    );
    await gate.started;

    const second = await post<{ detail?: string }>(
      server.base,
      "/api/sessions/twice.jsonl/compact",
    );
    assert.equal(second.status, 409);
    assert.equal(second.body.detail, "another compaction is already running for this session");

    gate.release();
    const firstResult = await first;
    assert.equal(firstResult.status, 200);
    assert.equal(firstResult.body.compacted, true);

    const events = readSession(server, "twice.jsonl");
    assert.equal(
      events.filter((event) => isCompactionSummary(event as unknown as Message)).length,
      1,
      "the rejected compaction never ran",
    );
    assert.deepEqual(
      events.map((event) => event.seq),
      Array.from({ length: events.length }, (_, index) => index + 1),
    );
    assert.equal(server.handle.state.compactions.size, 0, "guard released");
    assert.equal(fs.readFileSync(file, "utf-8").length > 0, true);
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// P2s: config-derived budgets, corrupt files, client abort
// ---------------------------------------------------------------------------

test("compact: the config field mapping is ungated; the auto-compaction helper is gated", () => {
  // A keep-recent budget alone shapes a manual compaction but never enables
  // auto compaction, so the two helpers must differ only in that gate.
  const keepRecentOnly = resolveConfig({ provider: "mock", compactKeepRecent: 300 });
  assert.deepEqual(compactionFieldsFromConfig(keepRecentOnly), { keepRecentChars: 300 });
  assert.equal(compactionSettingsFromConfig(keepRecentOnly), undefined);

  const triggered = resolveConfig({
    provider: "mock",
    compactThreshold: "12000",
    compactKeepRecent: "300",
    contextWindow: "8000",
  });
  assert.deepEqual(compactionFieldsFromConfig(triggered), {
    thresholdChars: 12000,
    keepRecentChars: 300,
    contextWindow: 8000,
  });
  assert.deepEqual(compactionSettingsFromConfig(triggered), {
    thresholdChars: 12000,
    keepRecentChars: 300,
    contextWindow: 8000,
  });

  const forced = resolveConfig({ provider: "mock", compact: true, compactKeepRecent: "300" });
  assert.deepEqual(compactionFieldsFromConfig(forced), { force: true, keepRecentChars: 300 });
  assert.deepEqual(compactionSettingsFromConfig(forced), { force: true, keepRecentChars: 300 });
});

test("compact: budgets come from the resolved config when ServerOptions.compaction is unset", async () => {
  // A serve-level `--compact-keep-recent 300` equivalent: resolved through the
  // config factory only, no ServerOptions.compaction. The default budget
  // (40 000 chars) would never cut this 6-event fixture.
  const server = await startServer({
    configFactory: () =>
      resolveConfig({ provider: "mock", mode: "consult", compactKeepRecent: 300 }),
  });
  try {
    const texts = ["Small task."];
    for (let index = 1; index <= 5; index += 1) {
      texts.push(`Turn ${index}: ${"detail ".repeat(12)}`);
    }
    seedSession(server, "config-budget.jsonl", texts);

    const res = await post<{
      compacted: boolean;
      before_events: number;
      after_events: number;
    }>(server.base, "/api/sessions/config-budget.jsonl/compact");
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.compacted, true, "the resolved config's keep-recent budget applied");
    assert.ok(res.body.after_events < res.body.before_events);
    assert.equal(
      readSession(server, "config-budget.jsonl").filter((event) =>
        isCompactionSummary(event as unknown as Message),
      ).length,
      1,
    );
  } finally {
    await server.close();
  }
});

test("compact: a corrupt session file is a stable 4xx without paths and releases the guard", async () => {
  const server = await startServer();
  try {
    const file = path.join(server.dir, "corrupt.jsonl");
    fs.writeFileSync(file, "{not json\n{\"also\": \n", "utf-8");

    const res = await post<{ detail?: string }>(
      server.base,
      "/api/sessions/corrupt.jsonl/compact",
    );
    assert.equal(res.status, 422);
    assert.equal(res.body.detail, "session file cannot be read; it may be corrupt");
    assert.ok(!String(res.body.detail).includes(server.dir), "no absolute path leaks");
    assert.ok(!String(res.body.detail).includes("corrupt.jsonl"));
    assert.equal(server.handle.state.compactions.size, 0, "the reservation was released");
    assert.equal(fs.readFileSync(file, "utf-8"), "{not json\n{\"also\": \n", "not rewritten");

    // The server stays healthy and a normal session still compacts (honestly).
    seedSession(server, "healthy.jsonl", ["Small task.", "A short reply."]);
    const healthy = await post<Record<string, unknown>>(
      server.base,
      "/api/sessions/healthy.jsonl/compact",
    );
    assert.equal(healthy.status, 200);
    assert.deepEqual(healthy.body, { compacted: false, reason: "nothing to compact" });
  } finally {
    await server.close();
  }
});

test("compact: a client disconnect aborts the summarizer and releases the guard", async () => {
  const gate = controllableMock();
  const server = await startServer({
    compaction: { keepRecentChars: 300 },
    providerOverrides: { senior: gate.provider, junior: gate.provider },
  });
  try {
    const file = seedLongSession(server, "abort.jsonl");
    const beforeBytes = fs.readFileSync(file, "utf-8");

    const controller = new AbortController();
    const pending = fetch(
      `${server.base}/api/sessions/abort.jsonl/compact`,
      { method: "POST", signal: controller.signal },
    )
      .then((res) => res.text())
      .catch((exc: unknown) => exc);

    await gate.started;
    controller.abort();
    await gate.aborted;
    await waitFor(
      () => !server.handle.state.compactions.has("abort.jsonl"),
      "compaction guard release after abort",
    );
    assert.deepEqual([...server.handle.state.compactions], []);
    assert.equal(
      fs.readFileSync(file, "utf-8"),
      beforeBytes,
      "an aborted compaction writes nothing",
    );
    const outcome = await pending;
    assert.ok(outcome instanceof Error, "the client request was aborted");

    // The session is usable again: a run submitted afterwards is accepted and
    // appends dense seq to the untouched file.
    gate.release();
    const record = await runToEnd(server, { task: "after abort", session: "abort.jsonl" });
    assert.equal(record.status, "completed");
    const events = readSession(server, "abort.jsonl");
    assert.deepEqual(
      events.map((event) => event.seq),
      Array.from({ length: events.length }, (_, index) => index + 1),
    );
    assert.ok(events.some((event) => event.payload?.text === "after abort"));
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// run path: config-derived auto compaction (wave 24, A1)
// ---------------------------------------------------------------------------

const AUTO_COMPACT_TASK =
  "Trace the cache regression, explain the cause, and propose a concrete fix.";

test("run: serve auto-compacts from the resolved config and a control run does not", async () => {
  // The serve-parser accepts `--compact-threshold` / `--compact-keep-recent`
  // and their env equivalents; the resolved config reaches the run harness.
  // The control server has zero compaction config, so its options object must
  // stay byte-identical (no summary).
  const compactedServer = await startServer({
    configFactory: () =>
      resolveConfig({
        provider: "mock",
        mode: "consult",
        compactThreshold: 200,
        compactKeepRecent: 100,
      }),
  });
  const controlServer = await startServer();
  try {
    const compacted = await runToEnd(compactedServer, {
      task: AUTO_COMPACT_TASK,
      session: "config-auto.jsonl",
    });
    assert.equal(compacted.status, "completed");
    const events = readSession(compactedServer, "config-auto.jsonl");
    assert.equal(
      events.filter((event) => isCompactionSummary(event as unknown as Message)).length,
      1,
      "the config-derived auto trigger wrote exactly one summary",
    );
    assert.ok(
      events.some(
        (event) =>
          typeof event.payload?.text === "string" &&
          event.payload.text.includes(COMPACTION_SUMMARY_PREFIX),
      ),
      "the summary carries the shared COMPACTION_SUMMARY_PREFIX marker",
    );

    const control = await runToEnd(controlServer, {
      task: AUTO_COMPACT_TASK,
      session: "control.jsonl",
    });
    assert.equal(control.status, "completed");
    const controlEvents = readSession(controlServer, "control.jsonl");
    assert.equal(
      controlEvents.filter((event) => isCompactionSummary(event as unknown as Message)).length,
      0,
      "zero compaction config must not compact",
    );
    assert.ok(
      !controlEvents.some(
        (event) =>
          typeof event.payload?.text === "string" &&
          event.payload.text.includes(COMPACTION_SUMMARY_PREFIX),
      ),
      "the control transcript carries no summary marker",
    );
  } finally {
    await compactedServer.close();
    await controlServer.close();
  }
});

test("run: explicit ServerOptions.compaction wins over the resolved config", async () => {
  // The config factory says "never compact in this short run" (100k chars);
  // the explicit options say "compact early". Only the latter can produce a
  // summary, so its presence proves explicit options take precedence.
  const server = await startServer({
    configFactory: () =>
      resolveConfig({
        provider: "mock",
        mode: "consult",
        compactThreshold: 100000,
        compactKeepRecent: 40000,
      }),
    compaction: { thresholdChars: 200, keepRecentChars: 100 },
  });
  try {
    const record = await runToEnd(server, {
      task: AUTO_COMPACT_TASK,
      session: "explicit.jsonl",
    });
    assert.equal(record.status, "completed");
    const events = readSession(server, "explicit.jsonl");
    assert.equal(
      events.filter((event) => isCompactionSummary(event as unknown as Message)).length,
      1,
      "the explicit threshold/keep-recent applied instead of the config's 100k threshold",
    );
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// persisted compaction settings (wave 25)
// ---------------------------------------------------------------------------

/** Persist one `compaction` section through the real settings API. */
async function putCompaction(
  server: RunningServer,
  section: Record<string, number>,
): Promise<Record<string, any>> {
  const res = await api<Record<string, any>>(server.base, "PUT", "/api/settings", {
    compaction: section,
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
}

/** Count the compaction summaries one session file carries. */
function summaryCount(server: RunningServer, name: string): number {
  return readSession(server, name).filter((event) =>
    isCompactionSummary(event as unknown as Message),
  ).length;
}

test("settings: compaction reports stored/effective/source, roundtrips and drives runs", async () => {
  const tmp = tmpdir("tb-compaction-settings-");
  try {
    const server = await startServer({ sessionsDir: tmp.root });
    try {
      const initial = await get<Record<string, any>>(server.base, "/api/settings");
      assert.equal(initial.status, 200);
      const absent = { persisted: 0, effective: 0, source: "absent" };
      assert.deepEqual(initial.body.compaction, {
        threshold_chars: absent,
        threshold_tokens: absent,
        keep_recent_chars: absent,
        context_window: absent,
        force: false,
        pinned: false,
      });
      // reading never writes a settings file
      assert.equal(fs.existsSync(path.join(tmp.root, "settings.json")), false);

      const saved = await putCompaction(server, {
        threshold_chars: 200,
        keep_recent_chars: 100,
      });
      assert.deepEqual(saved.compaction, {
        threshold_chars: { persisted: 200, effective: 200, source: "persisted" },
        threshold_tokens: { persisted: 0, effective: 0, source: "absent" },
        keep_recent_chars: { persisted: 100, effective: 100, source: "persisted" },
        context_window: { persisted: 0, effective: 0, source: "absent" },
        force: false,
        pinned: false,
      });
      const onDisk = JSON.parse(
        fs.readFileSync(path.join(tmp.root, "settings.json"), "utf-8"),
      ) as Record<string, unknown>;
      assert.deepEqual(onDisk.compaction, { threshold_chars: 200, keep_recent_chars: 100 });
      assert.ok(!JSON.stringify(onDisk).includes("secret"), "the section is secret-free");

      // An unrelated role save preserves the section.
      assert.equal(
        (await api(server.base, "PUT", "/api/settings", { senior: { model: "m-model" } })).status,
        200,
      );
      const afterRoleSave = await get<Record<string, any>>(server.base, "/api/settings");
      assert.deepEqual(afterRoleSave.body.compaction, saved.compaction);

      // The persisted trigger reaches the run path (no flags configured).
      const record = await runToEnd(server, {
        task: AUTO_COMPACT_TASK,
        session: "persisted-auto.jsonl",
      });
      assert.equal(record.status, "completed");
      assert.equal(
        summaryCount(server, "persisted-auto.jsonl"),
        1,
        "the persisted threshold/keep-recent drove exactly one compaction",
      );

      // A restart keeps the section and reports the same effective values.
      await server.close();
      const restarted = await startServer({ sessionsDir: tmp.root });
      try {
        const view = await get<Record<string, any>>(restarted.base, "/api/settings");
        assert.deepEqual(view.body.compaction, saved.compaction);
      } finally {
        await restarted.close();
      }
    } finally {
      await server.close();
    }
  } finally {
    tmp.cleanup();
  }
});

test("settings: invalid compaction bodies are 400s and change nothing", async () => {
  const tmp = tmpdir("tb-compaction-settings-bad-");
  try {
    const server = await startServer({ sessionsDir: tmp.root });
    try {
      await putCompaction(server, { threshold_chars: 500 });
      const file = path.join(tmp.root, "settings.json");
      const before = fs.readFileSync(file, "utf-8");

      for (const bad of [
        { compaction: null },
        { compaction: "500" },
        { compaction: [500] },
        { compaction: { threshold_chars: -1 } },
        { compaction: { threshold_chars: 1.5 } },
        { compaction: { threshold_chars: "500" } },
        { compaction: { threshold_chars: true } },
        { compaction: { threshold_chars: null } },
        { compaction: { context_window: 8000, future_knob: 1 } },
      ]) {
        const res = await api<Record<string, any>>(server.base, "PUT", "/api/settings", bad);
        assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(bad)}`);
      }
      assert.equal(fs.readFileSync(file, "utf-8"), before, "no rejected body touched the file");

      // Neither a bad body nor a body without the section changes the stored
      // budgets; the last good value still reads back.
      assert.equal(
        (await api(server.base, "PUT", "/api/settings", { senior: { model: "m-model" } })).status,
        200,
      );
      const after = await get<Record<string, any>>(server.base, "/api/settings");
      assert.equal(after.body.compaction.threshold_chars.persisted, 500);
      assert.equal(after.body.compaction.threshold_chars.effective, 500);
    } finally {
      await server.close();
    }
  } finally {
    tmp.cleanup();
  }
});

test("run: a non-zero serve flag wins per field over the persisted section", async () => {
  const controls: RunningServer[] = [];
  try {
    // Control: only the persisted section, so its trigger applies.
    const control = await startServer();
    controls.push(control);
    await putCompaction(control, { threshold_chars: 200, keep_recent_chars: 100 });
    const controlRun = await runToEnd(control, {
      task: AUTO_COMPACT_TASK,
      session: "persisted-control.jsonl",
    });
    assert.equal(controlRun.status, "completed");
    assert.equal(summaryCount(control, "persisted-control.jsonl"), 1);

    // Pinned: the resolved config's non-zero `--compact-threshold` (100k)
    // shadows the persisted 200-char trigger, so this run never compacts.
    // The persisted keep-recent field still merges in, but cannot trigger.
    const pinned = await startServer({
      configFactory: () =>
        resolveConfig({
          provider: "mock",
          mode: "consult",
          compactThreshold: 100000,
        }),
    });
    controls.push(pinned);
    await putCompaction(pinned, { threshold_chars: 200, keep_recent_chars: 100 });
    const view = await get<Record<string, any>>(pinned.base, "/api/settings");
    assert.deepEqual(view.body.compaction.threshold_chars, {
      persisted: 200,
      effective: 100000,
      source: "flag",
    });
    assert.deepEqual(view.body.compaction.keep_recent_chars, {
      persisted: 100,
      effective: 100,
      source: "persisted",
    });
    assert.equal(view.body.compaction.pinned, true);

    const pinnedRun = await runToEnd(pinned, {
      task: AUTO_COMPACT_TASK,
      session: "persisted-pinned.jsonl",
    });
    assert.equal(pinnedRun.status, "completed");
    assert.equal(summaryCount(pinned, "persisted-pinned.jsonl"), 0);
  } finally {
    for (const server of controls) await server.close();
  }
});

test("run: explicit ServerOptions.compaction wins wholesale over the persisted section", async () => {
  const server = await startServer({
    compaction: { thresholdChars: 100000 },
  });
  try {
    // The stored section says "compact early"; the explicit options say
    // "never in this short run". Only the explicit options can act, so no
    // summary proves they won wholesale.
    await putCompaction(server, { threshold_chars: 200, keep_recent_chars: 100 });
    const view = await get<Record<string, any>>(server.base, "/api/settings");
    assert.deepEqual(view.body.compaction.threshold_chars, {
      persisted: 200,
      effective: 100000,
      source: "options",
    });
    assert.deepEqual(view.body.compaction.keep_recent_chars, {
      persisted: 100,
      effective: 0,
      source: "absent",
    });
    assert.equal(view.body.compaction.pinned, true);

    const record = await runToEnd(server, {
      task: AUTO_COMPACT_TASK,
      session: "persisted-options.jsonl",
    });
    assert.equal(record.status, "completed");
    assert.equal(summaryCount(server, "persisted-options.jsonl"), 0);
  } finally {
    await server.close();
  }
});

test("compact: the manual route merges config > persisted", async () => {
  const servers: RunningServer[] = [];
  try {
    // Persisted only: the saved 300-char keep-recent budget cuts the long
    // fixture (the 40 000-char default would not).
    const persisted = await startServer();
    servers.push(persisted);
    await putCompaction(persisted, { keep_recent_chars: 300 });
    seedLongSession(persisted, "manual-persisted.jsonl");
    const merged = await post<{ compacted: boolean; before_events: number; after_events: number }>(
      persisted.base,
      "/api/sessions/manual-persisted.jsonl/compact",
    );
    assert.equal(merged.status, 200, JSON.stringify(merged.body));
    assert.equal(merged.body.compacted, true);
    assert.ok(merged.body.after_events < merged.body.before_events);

    // A pinned `--compact-keep-recent 40000` (explicit, even though it equals
    // the built-in default) shadows the persisted 300: nothing to compact.
    const pinned = await startServer({
      configFactory: () =>
        resolveConfig({
          provider: "mock",
          mode: "consult",
          compactKeepRecent: 40000,
        }),
    });
    servers.push(pinned);
    await putCompaction(pinned, { keep_recent_chars: 300 });
    seedLongSession(pinned, "manual-pinned.jsonl");
    const unmerged = await post<Record<string, unknown>>(
      pinned.base,
      "/api/sessions/manual-pinned.jsonl/compact",
    );
    assert.equal(unmerged.status, 200);
    assert.deepEqual(unmerged.body, { compacted: false, reason: "nothing to compact" });
  } finally {
    for (const server of servers) await server.close();
  }
});
