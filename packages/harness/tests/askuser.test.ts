/**
 * `ask_user` structured operator questions: the built-in tool parks a
 * structured question on the run's approval broker (the same park machinery
 * as a workspace approval — no new protocol envelope), the operator answers
 * over the existing approvals route/SSE surface, and the tool result string
 * reaches the model.
 *
 * Hermetic: in-process broker tests, mock-provider harness runs with a real
 * `RunApprovalBroker`, and a loopback server run. Run with: `node tests/run-all.ts`.
 */
import assert from "node:assert/strict";
import * as net from "node:net";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { test } from "node:test";

import { resolveConfig } from "../src/config.ts";
import { createServer, type ServerHandle, type ServerOptions } from "../src/server.ts";
import { TwoBrothersHarness, ASK_USER_TOOL_NAME } from "../src/harness.ts";
import { MockProvider } from "../src/provider.ts";
import { Action, Decision, type OperatorQuestion } from "../src/permissions.ts";
import { RunApprovalBroker } from "../src/runevents.ts";

const QUESTION: OperatorQuestion = {
  header: "Storage engine",
  text: "Which storage engine should the migration target?",
  options: [
    { label: "Redis", description: "keep the current engine" },
    { label: "Valkey", description: "the open fork", intent: "valkey" },
    { label: "Both", description: "dual-write during the cutover" },
  ],
};

async function waitFor(cond: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (cond()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// ---------------------------------------------------------------------------
// broker: park / answer / decline / cancel
// ---------------------------------------------------------------------------

test("broker: park-and-answer round trip with events and the pending view", async () => {
  const broker = new RunApprovalBroker();
  const events: Array<Record<string, unknown>> = [];
  broker.attach((event) => events.push(event as unknown as Record<string, unknown>), null);

  const parked = broker.ask({ kind: "question", question: QUESTION, action: Action.READ });
  await waitFor(() => broker.pending().length === 1, "the question to park");

  const view = broker.pending()[0] as Record<string, any>;
  assert.equal(view.kind, "question");
  assert.equal(view.question.text, QUESTION.text);
  assert.deepEqual(
    view.question.options.map((o: { label: string }) => o.label),
    ["Redis", "Valkey", "Both"],
  );

  const requested = events.find((e) => e.type === "approval_requested") as Record<string, any>;
  assert.equal(requested.kind, "question");
  assert.equal(requested.question.header, "Storage engine");
  assert.equal(requested.question.multi_select, undefined);

  assert.equal(broker.respond(String(view.approval_id), "answer", ["Valkey"]), "answer");
  const outcome = await parked;
  assert.deepEqual(outcome, { status: "answered", labels: ["Valkey"] });

  const resolved = events.find((e) => e.type === "approval_resolved") as Record<string, any>;
  assert.equal(resolved.decision, "answer");
  assert.deepEqual(broker.pending(), []);
});

test("broker: approvals stay byte-compatible — no kind/question on plain requests", async () => {
  const broker = new RunApprovalBroker();
  const events: Array<Record<string, unknown>> = [];
  broker.attach((event) => events.push(event as unknown as Record<string, unknown>), null);
  const parked = broker.approve({ action: Action.WRITE, target: "a.txt" });
  await waitFor(() => broker.pending().length === 1, "the approval to park");
  const view = broker.pending()[0] as Record<string, any>;
  assert.equal(view.kind, undefined);
  assert.equal(view.question, undefined);
  const requested = events.find((e) => e.type === "approval_requested") as Record<string, any>;
  assert.equal(requested.kind, undefined);
  assert.equal(requested.question, undefined);
  broker.respond(String(view.approval_id), Decision.ALLOW);
  assert.equal(await parked, Decision.ALLOW);
});

test("broker: answer validation matrix is fail-closed and the wait stays parked", async () => {
  const broker = new RunApprovalBroker();
  const parked = broker.ask({ kind: "question", question: QUESTION, action: Action.READ });
  await waitFor(() => broker.pending().length === 1, "the question to park");
  const id = String(broker.pending()[0].approval_id);

  // unknown label
  assert.throws(() => broker.respond(id, "answer", ["Postgres"]), /option labels/);
  // wrong count for a single-select question
  assert.throws(() => broker.respond(id, "answer", ["Redis", "Valkey"]), /exactly one label/);
  // no labels at all
  assert.throws(() => broker.respond(id, "answer", []), /exactly one label/);
  // allow on a question is an error
  assert.throws(() => broker.respond(id, Decision.ALLOW), /answer with decision answer/);
  // nothing settled: still pending, still answerable
  assert.equal(broker.pending().length, 1);
  assert.equal(broker.respond(id, "answer", ["Both"]), "answer");
  assert.deepEqual(await parked, { status: "answered", labels: ["Both"] });
});

test("broker: multi_select answers accept several labels", async () => {
  const broker = new RunApprovalBroker();
  const multi: OperatorQuestion = { ...QUESTION, multi_select: true };
  const parked = broker.ask({ kind: "question", question: multi, action: Action.READ });
  await waitFor(() => broker.pending().length === 1, "the question to park");
  const id = String(broker.pending()[0].approval_id);
  assert.equal(broker.respond(id, "answer", ["Redis", "Valkey"]), "answer");
  assert.deepEqual(await parked, { status: "answered", labels: ["Redis", "Valkey"] });
});

test("broker: answer on a workspace approval throws", async () => {
  const broker = new RunApprovalBroker();
  const parked = broker.approve({ action: Action.WRITE, target: "a.txt" });
  await waitFor(() => broker.pending().length === 1, "the approval to park");
  const id = String(broker.pending()[0].approval_id);
  assert.throws(() => broker.respond(id, "answer", ["a.txt"]), /workspace approval/);
  broker.respond(id, Decision.ALLOW);
  assert.equal(await parked, Decision.ALLOW);
});

test("broker: an operator deny settles a question as declined (no denial-cap count)", async () => {
  const broker = new RunApprovalBroker();
  const parked = broker.ask({ kind: "question", question: QUESTION, action: Action.READ });
  await waitFor(() => broker.pending().length === 1, "the question to park");
  const id = String(broker.pending()[0].approval_id);
  assert.equal(broker.respond(id, Decision.DENY), Decision.DENY);
  assert.deepEqual(await parked, { status: "declined" });
  assert.deepEqual(broker.autoDenials(), {}, "a declined question is not a workspace denial");
});

test("broker: cancel on stop resolves the parked question as cancelled", async () => {
  const broker = new RunApprovalBroker();
  const controller = new AbortController();
  broker.attach(null, controller.signal);
  const parked = broker.ask({ kind: "question", question: QUESTION, action: Action.READ });
  await waitFor(() => broker.pending().length === 1, "the question to park");
  controller.abort();
  assert.deepEqual(await parked, { status: "cancelled" });
});

test("broker: denyAll cancels every parked question", async () => {
  const broker = new RunApprovalBroker();
  const parked = broker.ask({ kind: "question", question: QUESTION, action: Action.READ });
  await waitFor(() => broker.pending().length === 1, "the question to park");
  assert.equal(broker.denyAll("cancelled"), 1);
  assert.deepEqual(await parked, { status: "cancelled" });
});

test("broker: session scope does not apply to questions", async () => {
  const broker = new RunApprovalBroker();
  const parked = broker.ask({ kind: "question", question: QUESTION, action: Action.READ });
  await waitFor(() => broker.pending().length === 1, "the question to park");
  const id = String(broker.pending()[0].approval_id);
  assert.throws(() => broker.allowForSession(id), /session scope/);
  assert.equal(broker.sessionAllows().length, 0);
  broker.respond(id, "answer", ["Redis"]);
  await parked;
});

// ---------------------------------------------------------------------------
// harness: the built-in tool parks, answers reach the transcript
// ---------------------------------------------------------------------------

function askArgs(question: OperatorQuestion = QUESTION): Record<string, unknown> {
  return {
    question: question.text,
    header: question.header,
    options: question.options,
    ...(question.multi_select !== undefined ? { multi_select: question.multi_select } : {}),
  };
}

function makeHarness(
  junior: MockProvider,
  broker: RunApprovalBroker,
  extra: Record<string, unknown> = {},
): { harness: TwoBrothersHarness; events: Array<Record<string, any>> } {
  const events: Array<Record<string, any>> = [];
  // The server's worker normally binds the emit hook and the run signal; a
  // bare harness run must do it explicitly (like the TUI does).
  broker.attach(
    (event) => events.push(event as Record<string, any>),
    (extra.signal as AbortSignal | undefined) ?? null,
  );
  const harness = new TwoBrothersHarness(resolveConfig({ provider: "mock", mode: "work" }), {
    junior,
    senior: new MockProvider(),
    approvals: broker,
    onEvent: (event) => events.push(event as Record<string, any>),
    ...extra,
  });
  return { harness, events };
}

test("harness: ask_user parks; the operator answer reaches the transcript and the run completes", async () => {
  const broker = new RunApprovalBroker();
  const { harness, events } = makeHarness(
    new MockProvider([
      { tool: ASK_USER_TOOL_NAME, args: askArgs() },
      {
        text: JSON.stringify({
          result: "migration targets Valkey",
          artifacts: [],
          confidence: 0.8,
        }),
      },
    ]),
    broker,
  );
  const run = harness.run("Plan a migration from Redis to Valkey");
  await waitFor(() => broker.pending().length === 1, "the question to park");
  broker.respond(String(broker.pending()[0].approval_id), "answer", ["Valkey"]);
  const result = await run;

  assert.equal(result.cancelled, false);
  assert.ok(result.decision !== undefined);
  const completed = events.find(
    (e) => e.type === "tool_completed" && e.tool === ASK_USER_TOOL_NAME,
  ) as Record<string, any>;
  assert.equal(completed.status, "ok");
  assert.equal(completed.result, "operator answer: Valkey (valkey)");
  // the answer is visible in the deliverable's evidence
  const deliverable = result.messages.find((m: { kind: string }) => m.kind === "deliverable") as
    | { payload: { artifacts?: string[] } }
    | undefined;
  assert.ok(
    (deliverable?.payload.artifacts ?? []).some((line: string) =>
      line.includes("operator answer: Valkey (valkey)"),
    ),
    "expected the answer in the deliverable evidence",
  );
});

test("harness: a declined question yields the declined result string", async () => {
  const broker = new RunApprovalBroker();
  const { harness, events } = makeHarness(
    new MockProvider([
      { tool: ASK_USER_TOOL_NAME, args: askArgs() },
      {
        text: JSON.stringify({ result: "the operator declined", artifacts: [], confidence: 0.5 }),
      },
    ]),
    broker,
  );
  const run = harness.run("ask the operator");
  await waitFor(() => broker.pending().length === 1, "the question to park");
  broker.respond(String(broker.pending()[0].approval_id), Decision.DENY);
  const result = await run;

  assert.equal(result.cancelled, false);
  const completed = events.find(
    (e) => e.type === "tool_completed" && e.tool === ASK_USER_TOOL_NAME,
  ) as Record<string, any>;
  assert.equal(completed.result, "operator declined to answer");
});

test("harness: operator stop while parked yields the cancelled result string", async () => {
  const broker = new RunApprovalBroker();
  const controller = new AbortController();
  const { harness, events } = makeHarness(
    new MockProvider([{ tool: ASK_USER_TOOL_NAME, args: askArgs() }]),
    broker,
    { signal: controller.signal },
  );
  const run = harness.run("ask the operator");
  await waitFor(() => broker.pending().length === 1, "the question to park");
  controller.abort();
  const result = await run;

  assert.equal(result.cancelled, true);
  const completed = events.find(
    (e) => e.type === "tool_completed" && e.tool === ASK_USER_TOOL_NAME,
  ) as Record<string, any>;
  assert.equal(completed.result, "question cancelled by operator stop");
});

test("harness: multi_select answers join labels; intents ride parenthetically", async () => {
  const broker = new RunApprovalBroker();
  const { harness, events } = makeHarness(
    new MockProvider([
      { tool: ASK_USER_TOOL_NAME, args: askArgs({ ...QUESTION, multi_select: true }) },
      { text: JSON.stringify({ result: "done", artifacts: [], confidence: 0.8 }) },
    ]),
    broker,
  );
  const run = harness.run("ask the operator");
  await waitFor(() => broker.pending().length === 1, "the question to park");
  broker.respond(String(broker.pending()[0].approval_id), "answer", ["Redis", "Valkey"]);
  await run;
  const completed = events.find(
    (e) => e.type === "tool_completed" && e.tool === ASK_USER_TOOL_NAME,
  ) as Record<string, any>;
  assert.equal(completed.result, "operator answer: Redis, Valkey (valkey)");
});

test("harness: invalid tool args fail soft as an ask_user error result", async () => {
  const broker = new RunApprovalBroker();
  const { harness, events } = makeHarness(
    new MockProvider([
      { tool: ASK_USER_TOOL_NAME, args: { question: "only one option", options: [{ label: "A" }] } },
      { text: JSON.stringify({ result: "done", artifacts: [], confidence: 0.8 }) },
    ]),
    broker,
  );
  const result = await harness.run("ask the operator");

  assert.equal(result.cancelled, false);
  assert.deepEqual(broker.pending(), [], "an invalid question never parks");
  const completed = events.find(
    (e) => e.type === "tool_completed" && e.tool === ASK_USER_TOOL_NAME,
  ) as Record<string, any>;
  assert.match(String(completed.result), /^ask_user error: /);
});

test("harness: without a broker the tool is not offered on either belt", async () => {
  const events: Array<Record<string, any>> = [];
  const harness = new TwoBrothersHarness(resolveConfig({ provider: "mock", mode: "work" }), {
    junior: new MockProvider(),
    senior: new MockProvider(),
    onEvent: (event) => events.push(event as Record<string, any>),
  });
  await harness.run("a plain run");
  assert.ok(
    events.every((e) => !(e.type === "tool_started" && e.tool === ASK_USER_TOOL_NAME)),
    "ask_user must not be offered without a broker",
  );
});

// ---------------------------------------------------------------------------
// server: the approvals route answers questions; SSE carries kind/question
// ---------------------------------------------------------------------------

interface RunningServer {
  base: string;
  handle: ServerHandle;
  close(): Promise<void>;
}

async function startServer(options: ServerOptions = {}): Promise<RunningServer> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-askuser-srv-"));
  const handle = createServer({
    configFactory: () => resolveConfig({ provider: "mock", mode: "work" }),
    webDist: null,
    ...options,
    sessionsDir: root,
  });
  const server = await handle.listen("127.0.0.1", 0);
  const port = (server.address() as net.AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    handle,
    close: async () => {
      await handle.close();
      fs.rmSync(root, { recursive: true, force: true });
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

const post = <T = unknown>(base: string, route: string, body?: unknown) =>
  api<T>(base, "POST", route, body);
const get = <T = unknown>(base: string, route: string) => api<T>(base, "GET", route);

function sseUntil(
  base: string,
  route: string,
  stop: (events: Array<Record<string, unknown>>) => boolean,
  timeoutMs = 15000,
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
      reject(new Error(`SSE ${route} timed out; last: ${JSON.stringify(events.slice(-3))}`));
    }, timeoutMs);
  });
}

test("server: ask_user round trip over the approvals route with SSE kind/question", async () => {
  const srv = await startServer({
    providerOverrides: {
      junior: new MockProvider([
        { tool: ASK_USER_TOOL_NAME, args: askArgs() },
        {
          text: JSON.stringify({ result: "migration targets Valkey", artifacts: [], confidence: 0.8 }),
        },
      ]),
    },
  });
  try {
    const started = await post<Record<string, any>>(srv.base, "/api/runs", {
      task: "Plan a migration from Redis to Valkey",
      mode: "work",
      provider: "mock",
      session: "ask-user-route",
    });
    assert.equal(started.status, 202);
    const runId = started.body.run_id;

    const events = await sseUntil(srv.base, `/api/runs/${runId}/events?after=0`, (all) =>
      all.some((e) => e.type === "approval_requested"),
    );
    const requested = events.find((e) => e.type === "approval_requested") as Record<string, any>;
    assert.equal(requested.kind, "question");
    assert.equal(requested.question.text, QUESTION.text);
    assert.equal(requested.question.header, "Storage engine");

    const pending = await get<Record<string, any>>(srv.base, `/api/runs/${runId}/approvals`);
    const row = (pending.body.pending as Array<Record<string, any>>)[0];
    assert.equal(row.kind, "question");
    assert.equal(row.question.options.length, 3);

    // 400 cases: the wait stays parked after each rejection
    const badLabel = await post<Record<string, any>>(
      srv.base,
      `/api/runs/${runId}/approvals/${row.approval_id}`,
      { decision: "answer", labels: ["Postgres"] },
    );
    assert.equal(badLabel.status, 400);
    const badCount = await post<Record<string, any>>(
      srv.base,
      `/api/runs/${runId}/approvals/${row.approval_id}`,
      { decision: "answer", labels: ["Redis", "Valkey"] },
    );
    assert.equal(badCount.status, 400);
    const allowOnQuestion = await post<Record<string, any>>(
      srv.base,
      `/api/runs/${runId}/approvals/${row.approval_id}`,
      { allow: true },
    );
    assert.equal(allowOnQuestion.status, 400);
    const stillPending = await get<Record<string, any>>(srv.base, `/api/runs/${runId}/approvals`);
    assert.equal((stillPending.body.pending as unknown[]).length, 1);

    const answered = await post<Record<string, any>>(
      srv.base,
      `/api/runs/${runId}/approvals/${row.approval_id}`,
      { decision: "answer", labels: ["Valkey"] },
    );
    assert.equal(answered.status, 200);
    assert.equal(answered.body.decision, "answer");
    assert.deepEqual(answered.body.labels, ["Valkey"]);

    const rest = await sseUntil(srv.base, `/api/runs/${runId}/events?after=0`, (all) =>
      all.some((e) => e.type === "run_end"),
    );
    assert.equal(rest.at(-1)?.status, "completed");
    const resolved = rest.find(
      (e) => e.type === "approval_resolved" && e.approval_id === row.approval_id,
    ) as Record<string, any>;
    assert.equal(resolved.decision, "answer");
    const completed = rest.find(
      (e) => e.type === "tool_completed" && e.tool === ASK_USER_TOOL_NAME,
    ) as Record<string, any>;
    assert.equal(completed.result, "operator answer: Valkey (valkey)");
  } finally {
    await srv.close();
  }
});

test("server: answering an approval with decision answer is a 400", async () => {
  const srv = await startServer({
    providerOverrides: {
      junior: new MockProvider([
        { tool: "workspace_write_file", args: { path: "hello.txt", content: "hello\n" } },
        { text: JSON.stringify({ result: "written", artifacts: [], confidence: 0.8 }) },
      ]),
    },
  });
  const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-askuser-ws-"));
  try {
    const ws = await post<Record<string, any>>(srv.base, "/api/workspaces", {
      path: wsDir,
      name: "askuser-ws",
    });
    const started = await post<Record<string, any>>(srv.base, "/api/runs", {
      task: "write the hello file",
      mode: "work",
      provider: "mock",
      workspace_id: ws.body.id,
      session: "ask-user-approval-400",
    });
    assert.equal(started.status, 202);
    const runId = started.body.run_id;
    const events = await sseUntil(srv.base, `/api/runs/${runId}/events?after=0`, (all) =>
      all.some((e) => e.type === "approval_requested"),
    );
    const approval = events.find((e) => e.type === "approval_requested") as Record<string, any>;
    assert.equal(approval.kind, undefined, "a workspace approval carries no kind");
    const res = await post<Record<string, any>>(
      srv.base,
      `/api/runs/${runId}/approvals/${approval.approval_id}`,
      { decision: "answer", labels: ["yes"] },
    );
    assert.equal(res.status, 400);
    // the approval is still pending and answerable with the legacy shape
    const pending = await get<Record<string, any>>(srv.base, `/api/runs/${runId}/approvals`);
    assert.equal((pending.body.pending as unknown[]).length, 1);
  } finally {
    await srv.close();
    fs.rmSync(wsDir, { recursive: true, force: true });
  }
});
