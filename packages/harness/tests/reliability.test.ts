/**
 * Hermetic reliability suite: the load / restart / race / compaction-stress
 * gaps recorded in docs/design-review.md (§9 "no load tests", §10 "the web
 * workspace is single-user, single-process" — pending approvals are in-memory
 * only, terminal run records are rebuilt from the runtime sidecar).
 *
 * Everything runs in-process: `createServer` on 127.0.0.1:0 with a temp
 * sessions dir and mock/scripted providers. No network, no subprocesses, no
 * fixed sleeps — every wait is a bounded event/poll predicate.
 *
 * Coverage:
 * 1. concurrent multi-session load — 12 runs across 4 sessions all reach a
 *    terminal state, each session JSONL keeps dense `seq` + valid envelopes,
 *    runtime sidecars stay per-session, and `/api/sessions` still answers;
 * 2. restart recovery — a completed run is rebuilt from the sidecar into the
 *    documented minimal terminal record (`task`/`mode` are ""), sessions load,
 *    pending approvals do not survive the restart (in-memory only), and a new
 *    run starts on the same dir;
 * 3. approval race — one run parks on an approval while a second run completes
 *    on another session, then the parked run resumes; the cause events
 *    (`approval_requested`/`approval_resolved`) precede the matching
 *    `run_status` transitions (`waiting`/`running`);
 * 4. compaction stress — a 200k+ char transcript compacts in char mode with
 *    exactly one summary event, the rewritten JSONL still loads, and a second
 *    compaction is incremental (`<previous-summary>` + pi's update prompt).
 *
 * Run with: node tests/reliability.test.ts (registered in tests/run-all.ts by
 * the Lead).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import {
  SUMMARIZATION_PROMPT,
  UPDATE_SUMMARIZATION_PROMPT,
  compactionSummaryText,
  compactionUnit,
  isCompactionSummary,
  type CompactionSettings,
} from "../src/compaction.ts";
import { resolveConfig, type Config } from "../src/config.ts";
import { SharedContext, type ChatMessage } from "../src/context.ts";
import type { Message } from "../src/protocol.ts";
import { createMessage, validateMessage } from "../src/protocol.ts";
import {
  MockProvider,
  type ChatOptions,
  type MockScriptStep,
  type Provider,
  type Tool,
  type ToolChatOptions,
  type ToolChatResponse,
} from "../src/provider.ts";
import { createServer, type ServerHandle, type ServerOptions } from "../src/server.ts";
import { SessionStore, restoreContext } from "../src/session.ts";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Windows can briefly hold handles on freshly written files: retry the rm. */
function cleanupDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
}

function mockConfig(): () => Config {
  return () => resolveConfig({ provider: "mock", mode: "consult" });
}

interface RunningServer {
  base: string;
  handle: ServerHandle;
  dir: string;
}

/**
 * Start the real HTTP server in-process on an ephemeral loopback port over
 * `sessionsDir`. Plugin/skill/command discovery is pinned to empty roots so
 * the suite is hermetic (no cwd or home-dir contribution).
 */
async function startServer(
  sessionsDir: string,
  options: ServerOptions = {},
): Promise<RunningServer> {
  const handle = createServer({
    configFactory: mockConfig(),
    webDist: null,
    pluginsDir: path.join(sessionsDir, "__no_plugins__"),
    skillsDirs: [],
    commandsDirs: [],
    ...options,
    sessionsDir,
  });
  const server = await handle.listen("127.0.0.1", 0);
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, handle, dir: sessionsDir };
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

const post = <T = unknown>(base: string, route: string, body?: unknown) =>
  api<T>(base, "POST", route, body);
const get = <T = unknown>(base: string, route: string) => api<T>(base, "GET", route);

/** Bounded predicate wait: polls until `check` returns non-null/undefined. */
async function waitFor<T>(
  label: string,
  check: () => T | null | undefined | Promise<T | null | undefined>,
  timeoutMs = 15000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== null && value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(25);
  }
}

/** Poll `GET /api/runs/{id}` until a terminal status (bounded). */
async function waitTerminal(
  base: string,
  runId: string,
  timeoutMs = 20000,
): Promise<Record<string, any>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await get<Record<string, any>>(base, `/api/runs/${runId}`);
    assert.equal(res.status, 200, `GET /api/runs/${runId} -> ${res.status}`);
    if (["completed", "failed", "cancelled"].includes(String(res.body.status))) {
      return res.body;
    }
    if (Date.now() > deadline) {
      throw new Error(`run ${runId} did not finish in time (last: ${JSON.stringify(res.body)})`);
    }
    await sleep(25);
  }
}

/** SSE reader: collects `data:` frames until `stop` holds or the stream ends. */
function sseEvents(
  base: string,
  route: string,
  stop: (events: Array<Record<string, unknown>>) => boolean = () => false,
  timeoutMs = 20000,
): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    const events: Array<Record<string, unknown>> = [];
    const req = http.get(base + route, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`SSE GET ${route} -> HTTP ${res.statusCode}`));
        res.resume();
        return;
      }
      let buf = "";
      let done = false;
      const finish = (): void => {
        if (!done) {
          done = true;
          resolve(events);
        }
      };
      res.on("data", (chunk: Buffer) => {
        buf += chunk.toString("utf-8");
        let idx: number;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (line.startsWith("data: ")) {
            events.push(JSON.parse(line.slice(6)) as Record<string, unknown>);
            if (stop(events)) {
              res.destroy();
              finish();
              return;
            }
          }
        }
      });
      res.on("end", finish);
      res.on("error", finish);
    });
    req.on("error", (exc) => {
      if (events.length > 0 && stop(events)) resolve(events);
      else reject(exc);
    });
    setTimeout(() => {
      req.destroy();
      reject(new Error(`SSE ${route} timed out; last events: ${JSON.stringify(events.slice(-3))}`));
    }, timeoutMs).unref();
  });
}

/** Replay the run event stream until the terminal `run_end` frame. */
function runUntilEnd(
  base: string,
  runId: string,
  after = 0,
): Promise<Array<Record<string, unknown>>> {
  return sseEvents(base, `/api/runs/${runId}/events?after=${after}`, (events) =>
    events.some((event) => event.type === "run_end"),
  );
}

/** Parse a JSONL file line by line, failing loudly on a corrupt line. */
function readJsonl(file: string): Array<Record<string, any>> {
  const text = fs.readFileSync(file, "utf-8");
  const records: Array<Record<string, any>> = [];
  text.split(/\r?\n/).forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line) return;
    try {
      records.push(JSON.parse(line) as Record<string, any>);
    } catch (exc) {
      throw new Error(`${path.basename(file)} line ${index + 1} is not JSON: ${String(exc)}`);
    }
  });
  return records;
}

/** Load one session JSONL and assert dense `seq` + protocol-valid envelopes. */
function assertDenseEnvelopes(file: string): Message[] {
  const events = readJsonl(file) as unknown as Message[];
  assert.ok(events.length > 0, `${path.basename(file)} must not be empty`);
  assert.deepEqual(
    events.map((event) => event.seq),
    Array.from({ length: events.length }, (_, index) => index + 1),
    `${path.basename(file)} must keep dense seq`,
  );
  for (const [index, event] of events.entries()) {
    assert.deepEqual(
      validateMessage(event),
      [],
      `${path.basename(file)} line ${index + 1} is not a valid protocol envelope`,
    );
  }
  return events;
}

/** Scripted junior: call the mutation tool (park on approval), then deliver. */
function approvalScript(fileName: string): MockScriptStep[] {
  return [
    { tool: "workspace_write_file", args: { path: fileName, content: "ok" } },
    {
      text: JSON.stringify({
        result: `the ${fileName} file is written`,
        artifacts: [fileName],
        confidence: 0.8,
      }),
    },
  ];
}

/** Submit a work-mode background run that will park on the write approval. */
async function startApprovalRun(
  srv: RunningServer,
  workspaceId: string,
  session: string,
  task = "write the approval file",
): Promise<string> {
  const started = await post<Record<string, any>>(srv.base, "/api/runs", {
    task,
    mode: "work",
    provider: "mock",
    workspace_id: workspaceId,
    session,
  });
  assert.equal(started.status, 202);
  return String(started.body.run_id);
}

/** Wait until the run exposes a pending approval (bounded, no polling loop). */
async function waitPendingApproval(
  srv: RunningServer,
  runId: string,
): Promise<Array<Record<string, any>>> {
  return waitFor(`pending approval for ${runId}`, async () => {
    const res = await get<Record<string, any>>(srv.base, `/api/runs/${runId}/approvals`);
    if (res.status !== 200) return null;
    const pending = res.body.pending as Array<Record<string, any>>;
    return pending.length > 0 ? pending : null;
  });
}

async function waitRunStatus(
  srv: RunningServer,
  runId: string,
  status: string,
): Promise<void> {
  await waitFor(`run ${runId} status ${status}`, async () => {
    const res = await get<Record<string, any>>(srv.base, `/api/runs/${runId}`);
    if (res.status !== 200) return null;
    return res.body.status === status ? true : null;
  });
}

/**
 * A provider that scripts the compaction reply and records every request, so
 * a test can assert which summarization prompt was used.
 */
class ScriptedSummarizer implements Provider {
  readonly requests: ChatMessage[][] = [];
  private readonly inner = new MockProvider();
  private readonly summaryText: string;

  constructor(summaryText: string) {
    this.summaryText = summaryText;
  }

  async chat(
    messages: ChatMessage[],
    responseKind = "message",
    signal?: AbortSignal,
    options?: ChatOptions,
  ): Promise<string> {
    this.requests.push(messages);
    if (responseKind === "compaction") return this.summaryText;
    return this.inner.chat(messages, responseKind, signal, options);
  }

  async chatWithTools(
    messages: ChatMessage[],
    tools: Tool[],
    options?: ToolChatOptions,
  ): Promise<ToolChatResponse> {
    return this.inner.chatWithTools(messages, tools, options);
  }
}

/** The summarization requests among a recording provider's calls. */
function compactionRequests(provider: ScriptedSummarizer): ChatMessage[][] {
  return provider.requests.filter((messages) =>
    messages.some((message) => message.content.includes("<conversation>")),
  );
}

// ---------------------------------------------------------------------------
// 1. Concurrent multi-session load
// ---------------------------------------------------------------------------

test(
  "concurrent multi-session load: 12 runs over 4 sessions stay isolated and dense",
  { timeout: 45000 },
  async () => {
    const dir = tmpdir("tb-reliability-load-");
    const srv = await startServer(dir, { workers: 4 });
    try {
      const sessionNames = ["load-alpha", "load-bravo", "load-charlie", "load-delta"];
      const startedAt = Date.now();
      const responses = await Promise.all(
        sessionNames.flatMap((session) =>
          [1, 2, 3].map(async (index) => {
            const task = `${session} task ${index}`;
            const res = await post<Record<string, any>>(srv.base, "/api/runs", {
              task,
              session,
            });
            return { bareSession: session, task, res };
          }),
        ),
      );

      interface Submission {
        runId: string;
        session: string;
        task: string;
      }
      const submissions: Submission[] = [];
      for (const { bareSession, task, res } of responses) {
        assert.equal(res.status, 202, `submit ${task}`);
        assert.equal(res.body.session, `${bareSession}.jsonl`);
        submissions.push({
          runId: String(res.body.run_id),
          session: String(res.body.session),
          task,
        });
      }
      assert.equal(submissions.length, 12);
      assert.equal(new Set(submissions.map((submission) => submission.runId)).size, 12);

      const records = await Promise.all(
        submissions.map((submission) => waitTerminal(srv.base, submission.runId)),
      );
      for (const [index, record] of records.entries()) {
        assert.equal(
          record.status,
          "completed",
          `run ${submissions[index]!.runId}: ${JSON.stringify(record)}`,
        );
        assert.equal(record.session, submissions[index]!.session);
        assert.ok((record.decision as Record<string, unknown>).decision);
      }
      assert.ok(
        Date.now() - startedAt < 30000,
        "12 mock runs must settle well inside the suite budget",
      );

      // Every submitted run is listed, and ?session= filters correctly.
      const allRuns = (await get<Array<Record<string, any>>>(srv.base, "/api/runs")).body;
      assert.equal(allRuns.length, 12);
      for (const session of sessionNames) {
        const filtered = (
          await get<Array<Record<string, any>>>(
            srv.base,
            `/api/runs?session=${session}.jsonl`,
          )
        ).body;
        assert.equal(filtered.length, 3, `runs for ${session}`);
        assert.ok(filtered.every((record) => record.session === `${session}.jsonl`));
      }

      // Per-session JSONL: dense seq, valid envelopes, own tasks only.
      const seenRunIds = new Set<string>();
      for (const bareSession of sessionNames) {
        const session = `${bareSession}.jsonl`;
        const events = assertDenseEnvelopes(path.join(dir, session));
        assert.equal(events.length, 15, `${session} must hold three consult cycles`);

        const ownTasks = new Set(
          submissions.filter((submission) => submission.session === session).map((s) => s.task),
        );
        const userTexts = events
          .filter((event) => event.from === "user" && event.kind === "message")
          .map((event) => String(event.payload.text));
        assert.deepEqual([...userTexts].sort(), [...ownTasks].sort());
        for (const text of userTexts) {
          assert.ok(ownTasks.has(text), `${session} leaked another session's task: ${text}`);
        }

        // Runtime sidecar: only this session's run ids, one run_end each.
        const sidecar = readJsonl(path.join(dir, "runtime", `${session}.events.jsonl`));
        const sidecarRunIds = new Set(
          sidecar
            .filter((event) => event.type === "envelope")
            .map((event) => String(event.run_id)),
        );
        const expectedRunIds = submissions
          .filter((submission) => submission.session === session)
          .map((submission) => submission.runId)
          .sort();
        assert.deepEqual([...sidecarRunIds].sort(), expectedRunIds);
        assert.equal(
          sidecar.filter((event) => event.type === "run_end").length,
          3,
          `${session} sidecar must end three runs`,
        );
        for (const runId of sidecarRunIds) {
          assert.ok(!seenRunIds.has(runId), `run ${runId} appears in two session sidecars`);
          seenRunIds.add(runId);
        }
      }
      assert.equal(seenRunIds.size, 12, "every run belongs to exactly one sidecar");

      // The session list endpoint still answers after the load burst.
      const listed = await get<Array<Record<string, any>>>(srv.base, "/api/sessions");
      assert.equal(listed.status, 200);
      assert.deepEqual(
        listed.body.map((entry) => String(entry.name)).sort(),
        sessionNames.map((session) => `${session}.jsonl`).sort(),
      );
      for (const bareSession of sessionNames) {
        const detail = await get<Record<string, any>>(
          srv.base,
          `/api/sessions/${bareSession}.jsonl`,
        );
        assert.equal(detail.status, 200);
        assert.equal((detail.body.events as unknown[]).length, 15);
      }
    } finally {
      await srv.handle.close();
      cleanupDir(dir);
    }
  },
);

// ---------------------------------------------------------------------------
// 2. Restart recovery
// ---------------------------------------------------------------------------

test(
  "restart recovery: sidecar rebuild, no pending approvals, new run starts",
  { timeout: 45000 },
  async () => {
    const dir = tmpdir("tb-reliability-restart-");
    const workspaceDir = tmpdir("tb-reliability-restart-ws-");
    const srvA = await startServer(dir, {
      workers: 2,
      providerOverrides: { junior: new MockProvider(approvalScript("survive.txt")) },
    });
    let srvB: RunningServer | null = null;
    let parkedRunId: string | null = null;
    try {
      // -- a completed run whose record must be rebuildable after restart ----
      const started = await post<Record<string, any>>(srvA.base, "/api/runs", {
        task: "survive restart",
        session: "restart-alive",
      });
      assert.equal(started.status, 202);
      const completedRunId = String(started.body.run_id);
      const completed = await waitTerminal(srvA.base, completedRunId);
      assert.equal(completed.status, "completed");
      const completedSession = String(completed.session);

      // -- a live run parked on an approval (memory-only state) --------------
      const ws = await post<Record<string, any>>(srvA.base, "/api/workspaces", {
        path: workspaceDir,
        name: "restart-ws",
      });
      assert.equal(ws.status, 201);
      parkedRunId = await startApprovalRun(srvA, String(ws.body.id), "restart-parked");
      const pending = await waitPendingApproval(srvA, parkedRunId);
      assert.equal(pending.length, 1);
      await waitRunStatus(srvA, parkedRunId, "waiting");

      // The sidecar proves the park happened and that the run never ended.
      const parkedSidecarPath = path.join(
        dir,
        "runtime",
        "restart-parked.jsonl.events.jsonl",
      );
      const parkedSidecar = readJsonl(parkedSidecarPath);
      assert.ok(
        parkedSidecar.some((event) => event.type === "approval_requested"),
        "the parked approval must be on the durable sidecar",
      );
      assert.ok(
        !parkedSidecar.some((event) => event.type === "run_end"),
        "the parked run has no terminal event",
      );

      // -- simulate a backend restart: close, then a fresh server over dir ---
      await srvA.handle.close();
      srvB = await startServer(dir, { workers: 2 });
      assert.equal(srvB.handle.state.runs.get(completedRunId), null);
      assert.equal(srvB.handle.state.runs.get(parkedRunId), null);

      // Sessions list survives with file stats + intact envelopes.
      const listed = await get<Array<Record<string, any>>>(srvB.base, "/api/sessions");
      assert.equal(listed.status, 200);
      const byName = new Map(
        listed.body.map((entry) => [String(entry.name), entry] as const),
      );
      for (const name of [completedSession, "restart-parked.jsonl"]) {
        const entry = byName.get(name);
        assert.ok(entry !== undefined, `sessions list must contain ${name}`);
        assert.ok(Number(entry.size) > 0, `${name} must have bytes`);
        assert.equal(typeof entry.mtime, "number");
      }
      const alive = assertDenseEnvelopes(path.join(dir, completedSession));
      assert.equal(alive.length, 5);
      const parkedEnvelopes = assertDenseEnvelopes(
        path.join(dir, "restart-parked.jsonl"),
      );
      assert.ok(
        parkedEnvelopes.length >= 2,
        "the parked session keeps the task + delegation envelopes it flushed",
      );

      // The completed run record is rebuilt from run_end (minimal shape).
      const recovered = await get<Record<string, any>>(
        srvB.base,
        `/api/runs/${completedRunId}`,
      );
      assert.equal(recovered.status, 200);
      assert.equal(recovered.body.status, "completed");
      assert.equal(recovered.body.rebuilt, true);
      assert.equal(recovered.body.task, "");
      assert.equal(recovered.body.mode, "");
      assert.equal(recovered.body.session, completedSession);
      assert.deepEqual(recovered.body.decision, completed.decision);
      assert.deepEqual(recovered.body.usage, completed.usage);
      assert.ok(Number(recovered.body.finished) >= Number(completed.finished));
      // ... while live records omit the rebuild marker.
      assert.equal("rebuilt" in completed, false);

      // Pending approvals do not survive: the run has no terminal sidecar
      // event, so it is unknown to the fresh process (approval API 404s too).
      assert.equal((await get(srvB.base, `/api/runs/${parkedRunId}`)).status, 404);
      assert.equal(
        (await get(srvB.base, `/api/runs/${parkedRunId}/approvals`)).status,
        404,
      );
      // ... but the park remains visible as history on the session endpoint.
      const history = (
        await get<Record<string, any>>(
          srvB.base,
          "/api/sessions/restart-parked.jsonl/events",
        )
      ).body.events as Array<Record<string, any>>;
      assert.ok(history.some((event) => event.type === "approval_requested"));
      assert.ok(!history.some((event) => event.type === "run_end"));

      // A new run starts on the recovered dir and appends with dense seq.
      const again = await post<Record<string, any>>(srvB.base, "/api/runs", {
        task: "after restart",
        session: completedSession,
      });
      assert.equal(again.status, 202);
      const record = await waitTerminal(srvB.base, String(again.body.run_id));
      assert.equal(record.status, "completed");
      const events = assertDenseEnvelopes(path.join(dir, completedSession));
      assert.equal(events.length, 10, "the recovered session appends a full cycle");
      const detail = await get<Record<string, any>>(
        srvB.base,
        `/api/sessions/${completedSession}`,
      );
      assert.equal((detail.body.events as unknown[]).length, 10);
    } finally {
      if (srvB !== null) await srvB.handle.close();
      // Unwind the orphaned parked run from server A's still-live manager so
      // the temp dir is not written to after cleanup.
      if (parkedRunId !== null) {
        srvA.handle.state.runs.stop(parkedRunId);
        await srvA.handle.state.runs.wait(parkedRunId, 5000);
      }
      await srvA.handle.close();
      cleanupDir(dir);
      cleanupDir(workspaceDir);
    }
  },
);

// ---------------------------------------------------------------------------
// 3. Approval race
// ---------------------------------------------------------------------------

test(
  "approval race: parked run resumes while a concurrent run completes",
  { timeout: 45000 },
  async () => {
    const dir = tmpdir("tb-reliability-race-");
    const workspaceDir = tmpdir("tb-reliability-race-ws-");
    const srv = await startServer(dir, {
      workers: 2,
      providerOverrides: { junior: new MockProvider(approvalScript("race.txt")) },
    });
    try {
      const ws = await post<Record<string, any>>(srv.base, "/api/workspaces", {
        path: workspaceDir,
        name: "race-ws",
      });
      assert.equal(ws.status, 201);

      const parkedRunId = await startApprovalRun(
        srv,
        String(ws.body.id),
        "race-parked",
        "park for the race",
      );
      const pending = await waitPendingApproval(srv, parkedRunId);
      assert.equal(pending.length, 1);
      const approvalId = String(pending[0]!.approval_id);
      await waitRunStatus(srv, parkedRunId, "waiting");

      // A second run on another session completes while the first is parked.
      const other = await post<Record<string, any>>(srv.base, "/api/runs", {
        task: "complete during the park",
        session: "race-other",
      });
      assert.equal(other.status, 202);
      const otherRunId = String(other.body.run_id);
      const otherRecord = await waitTerminal(srv.base, otherRunId);
      assert.equal(otherRecord.status, "completed");
      await waitRunStatus(srv, parkedRunId, "waiting");
      assert.equal(
        (await get<Record<string, any>>(srv.base, `/api/runs/${parkedRunId}`)).body.status,
        "waiting",
        "the park must survive the concurrent completion",
      );

      // Answer the approval: the parked run resumes and completes.
      const answer = await post<Record<string, unknown>>(
        srv.base,
        `/api/runs/${parkedRunId}/approvals/${approvalId}`,
        { allow: true },
      );
      assert.equal(answer.status, 200);
      assert.equal(answer.body.decision, "allow");
      const final = await waitTerminal(srv.base, parkedRunId);
      assert.equal(final.status, "completed");

      const parkedEvents = await runUntilEnd(srv.base, parkedRunId);
      const statuses = parkedEvents
        .filter((event) => event.type === "run_status")
        .map((event) => event.status);
      assert.deepEqual(statuses, ["queued", "running", "waiting", "running"]);

      const requested = parkedEvents.findIndex(
        (event) => event.type === "approval_requested",
      );
      const parkedStatus = parkedEvents.findIndex(
        (event) => event.type === "run_status" && event.status === "waiting",
      );
      const resolved = parkedEvents.findIndex(
        (event) => event.type === "approval_resolved",
      );
      const resumed = parkedEvents.findIndex(
        (event, index) =>
          index > parkedStatus && event.type === "run_status" && event.status === "running",
      );
      assert.ok(requested >= 0, "expected an approval_requested event");
      assert.ok(
        requested < parkedStatus,
        "approval_requested must precede the waiting run_status",
      );
      assert.ok(
        parkedStatus < resolved,
        "the approval is resolved only after the park was reported",
      );
      assert.ok(
        resolved < resumed,
        "approval_resolved must precede the return to running",
      );
      assert.ok(resumed < parkedEvents.length - 1, "resume happens before run_end");
      assert.equal(parkedEvents.at(-1)?.type, "run_end");
      assert.equal(parkedEvents.at(-1)?.status, "completed");
      assert.ok(parkedEvents.every((event) => event.run_id === parkedRunId));

      // The concurrent run's stream carries no approval events (isolation).
      const otherEvents = await runUntilEnd(srv.base, otherRunId);
      assert.ok(
        !otherEvents.some((event) => String(event.type).startsWith("approval_")),
        "approval events must not leak into another run's stream",
      );
      assert.equal(otherEvents.at(-1)?.status, "completed");

      // The approval is answerable exactly once.
      assert.equal(
        (
          await post(srv.base, `/api/runs/${parkedRunId}/approvals/${approvalId}`, {
            allow: true,
          })
        ).status,
        404,
      );
    } finally {
      await srv.handle.close();
      cleanupDir(dir);
      cleanupDir(workspaceDir);
    }
  },
);

// ---------------------------------------------------------------------------
// 4. Compaction stress
// ---------------------------------------------------------------------------

const COMPACTION_TASK = "hold the line under compaction stress";
const STRESS_ASK_CHARS = 55_000;
const STRESS_SUMMARY = "## Goal\nKeep the session compactable.\n\n## Next Steps\n1. Continue";

/** Seed a >200k-char transcript (task head + four huge consults) as JSONL. */
function seedLargeSession(file: string): { events: Message[]; rendered: number } {
  const store = new SessionStore(file);
  const ctx = new SharedContext(store);
  ctx.makeAndAppend("user", "senior", "message", { text: COMPACTION_TASK });
  for (let index = 1; index <= 4; index += 1) {
    ctx.makeAndAppend("senior", "junior", "consult", {
      task: COMPACTION_TASK,
      ask: `stress ${index}: ${"y".repeat(STRESS_ASK_CHARS)}`,
      expect: "proposal",
    });
  }
  return { events: ctx.events, rendered: ctx.renderTranscript().length };
}

/** The whole chat request as one string (prompt assertions). */
function requestText(messages: ChatMessage[]): string {
  return messages.map((message) => message.content).join("\n");
}

test(
  "compaction stress: 200k+ chars compact once, second pass is incremental",
  { timeout: 45000 },
  async () => {
    const dir = tmpdir("tb-reliability-compact-");
    const session = "compaction-stress.jsonl";
    const file = path.join(dir, session);
    try {
      const seeded = seedLargeSession(file);
      assert.ok(
        seeded.rendered > 200_000,
        `seeded transcript must exceed 200k chars (got ${seeded.rendered})`,
      );
      assert.equal(seeded.events.length, 5);

      // -- pass 1: threshold char-mode compaction ---------------------------
      const firstProvider = new ScriptedSummarizer(STRESS_SUMMARY);
      const compaction: CompactionSettings = { thresholdChars: 120_000 };
      assert.equal(compactionUnit(compaction), "chars");
      const srvA = await startServer(dir, {
        compaction,
        providerOverrides: { senior: firstProvider },
      });
      try {
        const started = await post<Record<string, any>>(srvA.base, "/api/runs", {
          task: "continue after stress",
          session,
        });
        assert.equal(started.status, 202);
        const record = await waitTerminal(srvA.base, String(started.body.run_id));
        assert.equal(record.status, "completed");

        const requests = compactionRequests(firstProvider);
        assert.equal(requests.length, 1, "exactly one threshold compaction");
        const coldRequest = requestText(requests[0]!);
        assert.ok(coldRequest.includes("<conversation>"));
        assert.ok(
          !coldRequest.includes("<previous-summary>"),
          "a first compaction must not chain a previous summary",
        );
        assert.ok(coldRequest.includes(SUMMARIZATION_PROMPT));

        // Exactly one summary event survives; the rewritten file loads.
        const events = assertDenseEnvelopes(file);
        const summaries = events.filter(isCompactionSummary);
        assert.equal(summaries.length, 1);
        assert.equal(events[0]!.payload.text, COMPACTION_TASK);
        assert.equal(events[1]!.seq, 2, "the summary sits right after the kept task head");
        assert.equal(compactionSummaryText(summaries[0]!), STRESS_SUMMARY);
        assert.ok(
          !JSON.stringify(events).includes("y".repeat(100)),
          "the oversized prefix was folded into the summary",
        );
        const restored = restoreContext(new SessionStore(file));
        assert.equal(restored.events.length, events.length);
        assert.deepEqual(
          new SessionStore(file).load().map((event) => event.seq),
          events.map((event) => event.seq),
        );
        const detail = await get<Record<string, any>>(
          srvA.base,
          `/api/sessions/${session}`,
        );
        assert.equal(detail.status, 200);
        assert.equal((detail.body.events as unknown[]).length, events.length);
        assert.ok(
          !fs.readdirSync(dir).some((name) => name.includes(".tmp-")),
          "SessionStore.rewrite must not leave a temp file",
        );
      } finally {
        await srvA.handle.close();
      }

      // -- pass 2: forced compaction on the compacted session ---------------
      const secondProvider = new ScriptedSummarizer(STRESS_SUMMARY);
      const srvB = await startServer(dir, {
        compaction: { force: true, keepRecentChars: 100 },
        providerOverrides: { senior: secondProvider },
      });
      try {
        const again = await post<Record<string, any>>(srvB.base, "/api/runs", {
          task: "second compaction pass",
          session,
        });
        assert.equal(again.status, 202);
        const record = await waitTerminal(srvB.base, String(again.body.run_id));
        assert.equal(record.status, "completed");

        const folds = compactionRequests(secondProvider);
        assert.equal(folds.length, 1, "the forced pass compacts exactly once");
        const updateRequest = requestText(folds[0]!);
        assert.ok(
          updateRequest.includes("<previous-summary>"),
          "the previous summary must be passed along",
        );
        assert.ok(updateRequest.includes(STRESS_SUMMARY));
        assert.ok(updateRequest.includes(UPDATE_SUMMARIZATION_PROMPT));
        assert.ok(
          !updateRequest.includes(SUMMARIZATION_PROMPT),
          "an incremental compaction uses pi's update prompt, not the cold one",
        );

        const events = assertDenseEnvelopes(file);
        assert.equal(
          events.filter(isCompactionSummary).length,
          1,
          "exactly one summary event survives the second compaction",
        );
        assert.equal(events[0]!.payload.text, COMPACTION_TASK);
        assert.equal(
          compactionSummaryText(events.filter(isCompactionSummary)[0]!),
          STRESS_SUMMARY,
        );
        assert.equal(restoreContext(new SessionStore(file)).events.length, events.length);
      } finally {
        await srvB.handle.close();
      }
    } finally {
      cleanupDir(dir);
    }
  },
);
