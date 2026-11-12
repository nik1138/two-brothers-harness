/**
 * Child-tagged approvals end to end: the run broker's additive child fields
 * (session allows, denial cap, cancellation, cross-run isolation) and the
 * `serve` HTTP flow (parked helper write, resolve, reload, stop).
 *
 * Hermetic: loopback only. The brothers are scripted in-process providers; the
 * helper route points at a tiny scripted OpenAI-compatible server started by
 * the test, so a real child provider call really parks a real approval.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { resolveConfig, type Config } from "../src/config.ts";
import type { ChatMessage } from "../src/context.ts";
import {
  Action,
  Decision,
  PermissionManager,
  PermissionPolicy,
  ApprovalMode,
  type ApprovalRequest,
} from "../src/permissions.ts";import {
  MockProvider,
  type ChatOptions,
  type Provider,
  type Tool,
  type ToolChatOptions,
  type ToolChatResponse,
} from "../src/provider.ts";
import { RunApprovalBroker } from "../src/runevents.ts";
import {
  createServer,
  type ServerHandle,
  type ServerOptions,
} from "../src/server.ts";
import { SUBAGENT_TOOL_NAME } from "../src/subagent.ts";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function tmpdir(prefix: string): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function mockConfig(extra: Record<string, unknown> = {}): () => Config {
  return () => resolveConfig({ provider: "mock", mode: "consult", ...extra });
}

interface RunningServer {
  base: string;
  handle: ServerHandle;
  dir: string;
  sessionsDir: string;
  options: ServerOptions;
  close(): Promise<void>;
}

async function startServer(options: ServerOptions = {}): Promise<RunningServer> {
  const tmp = tmpdir("tb-subapproval-");
  const sessionsDir = options.sessionsDir ? path.resolve(options.sessionsDir) : tmp.root;
  const effective: ServerOptions = {
    configFactory: mockConfig(),
    webDist: null,
    ...options,
    sessionsDir,
  };
  const handle = createServer(effective);
  const server = await handle.listen("127.0.0.1", 0);
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    handle,
    dir: sessionsDir,
    sessionsDir,
    options: effective,
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

const post = <T = unknown>(base: string, route: string, body?: unknown) =>
  api<T>(base, "POST", route, body);
const get = <T = unknown>(base: string, route: string) => api<T>(base, "GET", route);

/** SSE reader: collects `data:` events until `stop` holds or the stream ends. */
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
      reject(
        new Error(`SSE ${route} timed out; last events: ${JSON.stringify(events.slice(-3))}`),
      );
    }, timeoutMs).unref();
  });
}

function runUntilEnd(
  base: string,
  runId: string,
  after = 0,
): Promise<Array<Record<string, unknown>>> {
  return sseEvents(base, `/api/runs/${runId}/events?after=${after}`, (events) =>
    events.some((event) => event.type === "run_end"),
  );
}

/**
 * The senior script: on its consult tool loop issue up to `remaining` real
 * `subagent` delegations (one per loop round), then behave like the plain mock
 * provider so the cooperation cycle still settles.
 */
class DelegatingSenior implements Provider {
  private readonly inner = new MockProvider();
  private remaining: number;
  private counter = 0;

  constructor(remaining: number) {
    this.remaining = remaining;
  }

  async chat(
    messages: ChatMessage[],
    responseKind = "message",
    signal?: AbortSignal,
    options?: ChatOptions,
  ): Promise<string> {
    return this.inner.chat(messages, responseKind, signal, options);
  }

  async chatWithTools(
    messages: ChatMessage[],
    tools: Tool[],
    options: ToolChatOptions = {},
  ): Promise<ToolChatResponse> {
    if (
      options.responseKind === "consult" &&
      this.remaining > 0 &&
      tools.some((tool) => tool.name === SUBAGENT_TOOL_NAME)
    ) {
      this.remaining -= 1;
      this.counter += 1;
      return {
        content: "",
        toolCalls: [
          {
            id: `senior-helper-${this.counter}`,
            name: SUBAGENT_TOOL_NAME,
            args: { task: "Write e2e-helper.txt with the scripted greeting." },
          },
        ],
      };
    }
    return this.inner.chatWithTools(messages, tools, options);
  }
}

/** Junior script for the plain (brother) approval run: one write, then deliver. */
function writeDeliverableScript(target: string): Array<
  { tool: string; args: Record<string, unknown> } | { text: string }
> {
  return [
    { tool: "workspace_write_file", args: { path: target, content: "brother content" } },
    {
      text: JSON.stringify({
        result: `Wrote ${target}.`,
        artifacts: [target],
        confidence: 0.9,
      }),
    },
  ];
}

interface HelperModel {
  baseUrl: string;
  close(): Promise<void>;
}

/**
 * A scripted OpenAI-compatible model for the helper route: the first call of
 * each child conversation asks for one `workspace_write_file`; the call after
 * its tool result returns the child's final report.
 */
async function startHelperModel(): Promise<HelperModel> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      let body: Record<string, any> = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as Record<string, any>;
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "invalid JSON" } }));
        return;
      }
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const hasToolResult = messages.some(
        (message: Record<string, unknown>) => message.role === "tool",
      );
      const toolCalls = hasToolResult
        ? []
        : [
            {
              id: "helper-call-1",
              type: "function",
              function: {
                name: "workspace_write_file",
                arguments: JSON.stringify({
                  path: "e2e-helper.txt",
                  content: "hello from the helper\n",
                }),
              },
            },
          ];
      const content = hasToolResult
        ? "Wrote e2e-helper.txt as the operator approved."
        : "";
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-helper",
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: String(body.model ?? "e2e-helper"),
          choices: [
            {
              index: 0,
              message: { role: "assistant", content, tool_calls: toolCalls },
              finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Point the persisted Subagent route at the loopback scripted model. */
async function configureHelper(srv: RunningServer, model: HelperModel): Promise<void> {
  const put = await api(srv.base, "PUT", "/api/settings", {
    subagent: {
      provider: "openai",
      base_url: model.baseUrl,
      api_key: "helper-test-key",
      model: "e2e-helper",
    },
  });
  assert.equal(put.status, 200);
}

async function registerWorkspace(srv: RunningServer, root: string): Promise<string> {
  const ws = await post<Record<string, any>>(srv.base, "/api/workspaces", {
    path: root,
    name: "e2e-helper",
  });
  assert.equal(ws.status, 201);
  return String(ws.body.id);
}

async function startRun(
  srv: RunningServer,
  workspaceId: string,
  session: string,
  mode = "consult",
): Promise<string> {
  const started = await post<Record<string, any>>(srv.base, "/api/runs", {
    task: "Do the scripted E2E task",
    mode,
    provider: "mock",
    workspace_id: workspaceId,
    session,
  });
  assert.equal(started.status, 202);
  return String(started.body.run_id);
}

async function awaitApproval(
  srv: RunningServer,
  runId: string,
): Promise<{ events: Array<Record<string, unknown>>; approval: Record<string, any> }> {
  const events = await sseEvents(
    srv.base,
    `/api/runs/${runId}/events?after=0`,
    (all) => all.some((event) => event.type === "approval_requested"),
    15000,
  );
  const requested = events.filter((event) => event.type === "approval_requested");
  assert.equal(requested.length, 1);
  return { events, approval: requested[0] as Record<string, any> };
}

async function sessionSubagents(
  srv: RunningServer,
  session: string,
): Promise<Array<Record<string, any>>> {
  const name = session.endsWith(".jsonl") ? session : `${session}.jsonl`;
  const list = await get<Record<string, any>>(
    srv.base,
    `/api/sessions/${encodeURIComponent(name)}/subagents`,
  );
  assert.equal(list.status, 200);
  return (list.body.subagents ?? []) as Array<Record<string, any>>;
}

async function childDetail(
  srv: RunningServer,
  id: string,
): Promise<Record<string, any>> {
  const detail = await get<Record<string, any>>(srv.base, `/api/subagents/${id}`);
  assert.equal(detail.status, 200);
  return detail.body.subagent as Record<string, any>;
}

function approvalStatuses(detail: Record<string, any>): string[] {
  return ((detail.transcript ?? []) as Array<Record<string, any>>)
    .filter((entry) => entry.type === "approval")
    .map((entry) => String(entry.status));
}

// ---------------------------------------------------------------------------
// RunApprovalBroker: additive child fields on the existing approval surface
// ---------------------------------------------------------------------------

test("broker: a child request parks with its identity and resolves by approval id", async () => {
  const events: Array<Record<string, any>> = [];
  const broker = new RunApprovalBroker();
  broker.attach((event) => events.push(event as unknown as Record<string, any>));
  const child = new PermissionManager(
    new PermissionPolicy(ApprovalMode.ASK),
    broker,
  ).childView({ id: "sub-child-1", label: "Write helper" });
  const parked = child.check({ action: Action.WRITE, target: "notes.txt" });
  const pending = broker.pending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.subagent_id, "sub-child-1");
  assert.equal(pending[0]?.subagent_label, "Write helper");
  assert.equal(pending[0]?.action, "write");
  const requested = events.find((event) => event.type === "approval_requested");
  assert.equal(requested?.subagent_id, "sub-child-1");
  assert.equal(requested?.subagent_label, "Write helper");
  assert.equal(broker.respond(String(pending[0]?.approval_id), Decision.ALLOW), Decision.ALLOW);
  assert.equal(await parked, Decision.ALLOW);
  const resolved = events.find((event) => event.type === "approval_resolved");
  assert.equal(resolved?.subagent_id, "sub-child-1");
  assert.equal(broker.pending().length, 0);
});

test("broker: a brother's request keeps the old shape (no child fields)", async () => {
  const events: Array<Record<string, any>> = [];
  const broker = new RunApprovalBroker();
  broker.attach((event) => events.push(event as unknown as Record<string, any>));
  const parked = broker.approve({ action: Action.WRITE, target: "notes.txt" });
  const requested = events.find((event) => event.type === "approval_requested");
  assert.equal(requested?.subagent_id, undefined);
  assert.equal(requested?.subagent_label, undefined);
  assert.equal(broker.pending()[0]?.subagent_id, undefined);
  broker.denyAll();
  await parked;
  assert.equal(events.find((event) => event.type === "approval_resolved")?.subagent_id, undefined);
});

test("broker: a session allow on a child pairs with the parent and auto-allows once", async () => {
  const events: Array<Record<string, any>> = [];
  const broker = new RunApprovalBroker();
  broker.attach((event) => events.push(event as unknown as Record<string, any>));
  const manager = new PermissionManager(new PermissionPolicy(ApprovalMode.ASK), broker);
  const child = manager.childView({ id: "sub-child-2", label: "Session child" });

  const first = child.check({ action: Action.WRITE, target: "shared.txt" });
  const approvalId = String(broker.pending()[0]?.approval_id);
  assert.equal(broker.allowForSession(approvalId), Decision.ALLOW);
  assert.equal(await first, Decision.ALLOW);
  // The pair is the parent's pair space: the child's own second request AND a
  // parent request for the same action/target auto-allow without parking.
  assert.equal(await child.check({ action: Action.WRITE, target: "shared.txt" }), Decision.ALLOW);
  assert.equal(await manager.check({ action: Action.WRITE, target: "shared.txt" }), Decision.ALLOW);
  const auto = events.filter((event) => event.type === "approval_auto_allowed");
  assert.equal(auto.length, 2);
  assert.equal(broker.pending().length, 0);
});

test("broker: the shared denial cap auto-denies the third identical child request", async () => {
  const events: Array<Record<string, any>> = [];
  const broker = new RunApprovalBroker();
  broker.attach((event) => events.push(event as unknown as Record<string, any>));
  const child = new PermissionManager(
    new PermissionPolicy(ApprovalMode.ASK),
    broker,
  ).childView({ id: "sub-child-3", label: "Denied child" });

  for (let round = 0; round < 2; round += 1) {
    const parked = child.check({ action: Action.WRITE, target: "retry.txt" });
    assert.equal(broker.pending().length, 1);
    broker.respond(String(broker.pending()[0]?.approval_id), Decision.DENY);
    assert.equal(await parked, Decision.DENY);
  }
  const third = await child.check({ action: Action.WRITE, target: "retry.txt" });
  assert.equal(third, Decision.DENY);
  assert.equal(broker.pending().length, 0);
  assert.equal(events.filter((event) => event.type === "approval_auto_denied").length, 1);
  // A different target still parks (the cap is per pair).
  const other = child.check({ action: Action.WRITE, target: "fresh.txt" });
  assert.equal(broker.pending().length, 1);
  broker.denyAll();
  assert.equal(await other, Decision.DENY);
});

test("broker: cancelling the run resolves a parked child wait with its identity", async () => {
  const controller = new AbortController();
  const events: Array<Record<string, any>> = [];
  const broker = new RunApprovalBroker();
  broker.attach(
    (event) => events.push(event as unknown as Record<string, any>),
    controller.signal,
  );
  const child = new PermissionManager(
    new PermissionPolicy(ApprovalMode.ASK),
    broker,
  ).childView({ id: "sub-child-4", label: "Stopped child" });
  const parked = child.check({ action: Action.WRITE, target: "stopped.txt" });
  assert.equal(broker.pending().length, 1);
  controller.abort();
  assert.equal(await parked, Decision.DENY);
  const resolved = events.find((event) => event.type === "approval_resolved");
  assert.equal(resolved?.decision, "deny");
  assert.equal(resolved?.reason, "cancelled");
  assert.equal(resolved?.subagent_id, "sub-child-4");
  assert.equal(broker.pending().length, 0);
});

test("broker: two runs never share child approvals", async () => {
  const eventsA: Array<Record<string, any>> = [];
  const eventsB: Array<Record<string, any>> = [];
  const brokerA = new RunApprovalBroker();
  const brokerB = new RunApprovalBroker();
  brokerA.attach((event) => eventsA.push(event as unknown as Record<string, any>));
  brokerB.attach((event) => eventsB.push(event as unknown as Record<string, any>));
  const childA = new PermissionManager(
    new PermissionPolicy(ApprovalMode.ASK),
    brokerA,
  ).childView({ id: "sub-run-a", label: "Run A child" });
  const childB = new PermissionManager(
    new PermissionPolicy(ApprovalMode.ASK),
    brokerB,
  ).childView({ id: "sub-run-b", label: "Run B child" });
  const parkedA = childA.check({ action: Action.WRITE, target: "a.txt" });
  const parkedB = childB.check({ action: Action.WRITE, target: "a.txt" });
  assert.equal(brokerA.pending()[0]?.subagent_id, "sub-run-a");
  assert.equal(brokerB.pending()[0]?.subagent_id, "sub-run-b");
  brokerA.respond(String(brokerA.pending()[0]?.approval_id), Decision.ALLOW);
  assert.equal(await parkedA, Decision.ALLOW);
  // Run B is untouched: still pending, no resolution event, and its wait is
  // still parked on its own broker.
  assert.equal(brokerB.pending().length, 1);
  assert.equal(
    eventsB.filter((event) => event.type === "approval_resolved").length,
    0,
  );
  brokerB.denyAll();
  assert.equal(await parkedB, Decision.DENY);
});

// ---------------------------------------------------------------------------
// serve: a real helper request parks, resolves, reloads and stops over HTTP
// ---------------------------------------------------------------------------

test("serve: a child write parks with its identity, resolves over HTTP, survives reload", async () => {
  const model = await startHelperModel();
  const srv = await startServer({
    providerOverrides: {
      senior: new DelegatingSenior(1),
      junior: new MockProvider(writeDeliverableScript("brother-note.txt")),
    },
  });
  const wsDir = tmpdir("tb-subapproval-ws-");
  try {
    await configureHelper(srv, model);
    const wsId = await registerWorkspace(srv, wsDir.root);
    const helperFile = path.join(wsDir.root, "e2e-helper.txt");

    // -- a brother's request keeps the old pending/event shape
    const parentRun = await startRun(srv, wsId, "child-approval-parent", "work");
    let { events, approval } = await awaitApproval(srv, parentRun);
    assert.equal(approval.action, "write");
    assert.equal(approval.target, "brother-note.txt");
    assert.equal(approval.subagent_id, undefined);
    assert.equal(approval.subagent_label, undefined);
    const parentPending = await get<Record<string, any>>(
      srv.base,
      `/api/runs/${parentRun}/approvals`,
    );
    assert.equal(parentPending.body.pending[0]?.subagent_id, undefined);
    await post(srv.base, `/api/runs/${parentRun}/approvals/${approval.approval_id}`, {
      allow: false,
    });
    const parentRest = await runUntilEnd(srv.base, parentRun, events.length);
    assert.equal(parentRest.at(-1)?.status, "completed");

    // -- the helper's write parks with child fields
    const childRun = await startRun(srv, wsId, "child-approval-helper");
    ({ events, approval } = await awaitApproval(srv, childRun));
    assert.equal(approval.action, "write");
    assert.equal(approval.target, "e2e-helper.txt");
    assert.match(String(approval.subagent_id), /^sub-[a-f0-9]{8,32}$/);
    assert.equal(approval.subagent_label, "Write e2e-helper.txt with the scripted greeting.");
    const childPending = await get<Record<string, any>>(
      srv.base,
      `/api/runs/${childRun}/approvals`,
    );
    assert.equal(childPending.body.pending.length, 1);
    assert.equal(childPending.body.pending[0]?.subagent_id, approval.subagent_id);
    assert.equal(childPending.body.pending[0]?.subagent_label, approval.subagent_label);

    // The durable child log already carries the pending row, so a reloaded
    // tree shows "waiting for approval".
    const parkedRows = await sessionSubagents(srv, "child-approval-helper");
    assert.equal(parkedRows.length, 1);
    assert.equal(parkedRows[0]?.id, approval.subagent_id);
    assert.equal(parkedRows[0]?.last_activity?.status, "awaiting_approval");
    const parkedDetail = await childDetail(srv, String(approval.subagent_id));
    assert.deepEqual(approvalStatuses(parkedDetail), ["pending"]);

    const answer = await post<Record<string, any>>(
      srv.base,
      `/api/runs/${childRun}/approvals/${approval.approval_id}`,
      { allow: true },
    );
    assert.equal(answer.status, 200);
    assert.equal(answer.body.decision, "allow");
    const rest = await runUntilEnd(srv.base, childRun, events.length);
    assert.equal(rest.at(-1)?.type, "run_end");
    assert.equal(rest.at(-1)?.status, "completed");
    assert.equal(fs.readFileSync(helperFile, "utf-8"), "hello from the helper\n");

    // The child log kept both the pending and the outcome row, and its tool
    // row is the real workspace_write_file call.
    const detail = await childDetail(srv, String(approval.subagent_id));
    assert.deepEqual(approvalStatuses(detail), ["pending", "allowed"]);
    assert.ok(
      (detail.transcript as Array<Record<string, any>>).some(
        (entry) => entry.type === "tool" && entry.tool === "workspace_write_file",
      ),
    );

    // 404: the approval id belongs to the child run, not to the other run, and
    // an unknown approval id is refused.
    assert.equal(
      (
        await post(
          srv.base,
          `/api/runs/${parentRun}/approvals/${approval.approval_id}`,
          { allow: true },
        )
      ).status,
      404,
    );
    assert.equal(
      (await post(srv.base, `/api/runs/${childRun}/approvals/no-such-approval`, { allow: true }))
        .status,
      404,
    );
    assert.equal(
      (
        await post(srv.base, `/api/runs/${childRun}/approvals/${approval.approval_id}`, {
          allow: true,
        })
      ).status,
      404,
    );

    // The runtime sidecar persisted the child fields.
    const sidecar = path.join(
      srv.dir,
      "runtime",
      "child-approval-helper.jsonl.events.jsonl",
    );
    const persisted = fs
      .readFileSync(sidecar, "utf-8")
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as Record<string, any>);
    assert.equal(
      persisted.find((event) => event.type === "approval_requested")?.subagent_id,
      approval.subagent_id,
    );
    assert.equal(
      persisted.find((event) => event.type === "approval_resolved")?.subagent_id,
      approval.subagent_id,
    );

    // A restart replays the same events from the sidecar and the append-only
    // child log still shows the approval rows.
    await srv.handle.close();
    const second = await startServer({ sessionsDir: srv.sessionsDir, webDist: null });
    try {
      // The tolerant sidecar reader replays the child-tagged approval events.
      const replay = await get<Record<string, any>>(
        second.base,
        "/api/sessions/child-approval-helper.jsonl/events",
      );
      assert.equal(replay.status, 200);
      const events = (replay.body.events ?? []) as Array<Record<string, any>>;
      assert.equal(
        events.find((event) => event.type === "approval_requested")?.subagent_id,
        approval.subagent_id,
      );
      assert.equal(
        events.find((event) => event.type === "approval_resolved")?.subagent_id,
        approval.subagent_id,
      );
      const reloaded = await sessionSubagents(second, "child-approval-helper");
      assert.equal(reloaded.length, 1);
      assert.equal(reloaded[0]?.status, "completed");
      const reloadedDetail = await childDetail(second, String(approval.subagent_id));
      assert.deepEqual(approvalStatuses(reloadedDetail), ["pending", "allowed"]);
    } finally {
      await second.close();
    }
  } finally {
    await model.close();
    wsDir.cleanup();
    // srv.close() already ran in the reload block; closing twice is safe for tmp cleanup
    try {
      await srv.close();
    } catch {
      // already closed
    }
  }
});

test("serve: a session allow on a child persists the pair and auto-allows the next child", async () => {
  const model = await startHelperModel();
  const srv = await startServer({
    providerOverrides: { senior: new DelegatingSenior(2) },
  });
  const wsDir = tmpdir("tb-subapproval-session-");
  try {
    await configureHelper(srv, model);
    const wsId = await registerWorkspace(srv, wsDir.root);
    const runId = await startRun(srv, wsId, "child-approval-session");
    const { events, approval } = await awaitApproval(srv, runId);
    const answer = await post<Record<string, any>>(
      srv.base,
      `/api/runs/${runId}/approvals/${approval.approval_id}`,
      { allow: true, scope: "session" },
    );
    assert.equal(answer.status, 200);
    assert.equal(answer.body.scope, "session");
    // The pair is persisted before the request is resolved.
    const settingsRaw = fs.readFileSync(path.join(srv.dir, "settings.json"), "utf-8");
    assert.ok(settingsRaw.includes("write\\u0000e2e-helper.txt"));
    const rest = await runUntilEnd(srv.base, runId, events.length);
    const all = [...events, ...rest];
    assert.equal(all.at(-1)?.status, "completed");
    // The second child's identical write never parked: exactly one card and
    // exactly one auto-allow event.
    assert.equal(all.filter((event) => event.type === "approval_requested").length, 1);
    assert.equal(all.filter((event) => event.type === "approval_auto_allowed").length, 1);
    assert.equal(fs.readFileSync(path.join(wsDir.root, "e2e-helper.txt"), "utf-8"), "hello from the helper\n");
    const rows = await sessionSubagents(srv, "child-approval-session");
    assert.equal(rows.length, 2);
  } finally {
    await srv.close();
    await model.close();
    wsDir.cleanup();
  }
});

test("serve: stopping a run cancels a parked child write and marks the child log", async () => {
  const model = await startHelperModel();
  const srv = await startServer({
    providerOverrides: { senior: new DelegatingSenior(1) },
  });
  const wsDir = tmpdir("tb-subapproval-stop-");
  try {
    await configureHelper(srv, model);
    const wsId = await registerWorkspace(srv, wsDir.root);
    const runId = await startRun(srv, wsId, "child-approval-stop");
    const { events, approval } = await awaitApproval(srv, runId);
    const stopped = await post<Record<string, any>>(srv.base, `/api/runs/${runId}/stop`);
    assert.equal(stopped.status, 200);
    const rest = await runUntilEnd(srv.base, runId, events.length);
    const all = [...events, ...rest];
    assert.equal(rest.at(-1)?.type, "run_end");
    assert.equal(rest.at(-1)?.status, "cancelled");
    const resolved = all.find(
      (event) =>
        event.type === "approval_resolved" &&
        event.approval_id === approval.approval_id,
    );
    assert.equal(resolved?.decision, "deny");
    assert.equal(resolved?.reason, "cancelled");
    assert.equal(resolved?.subagent_id, approval.subagent_id);
    assert.equal(fs.existsSync(path.join(wsDir.root, "e2e-helper.txt")), false);
    const pending = await get<Record<string, any>>(srv.base, `/api/runs/${runId}/approvals`);
    assert.deepEqual(pending.body.pending, []);
    const detail = await childDetail(srv, String(approval.subagent_id));
    assert.equal(detail.status, "cancelled");
    const statuses = approvalStatuses(detail);
    assert.equal(statuses[0], "pending");
    assert.equal(statuses.at(-1), "cancelled");
  } finally {
    await srv.close();
    await model.close();
    wsDir.cleanup();
  }
});

test("broker: the tagging broker never mutates the caller's request object", async () => {
  const broker = new RunApprovalBroker();
  broker.attach(() => undefined);
  const child = new PermissionManager(
    new PermissionPolicy(ApprovalMode.ASK),
    broker,
  ).childView({ id: "sub-child-5", label: "Tagger" });
  const request: ApprovalRequest = { action: Action.WRITE, target: "x.txt" };
  const parked = child.check(request);
  assert.equal(request.subagent_id, undefined);
  assert.equal(request.subagent_label, undefined);
  broker.denyAll();
  assert.equal(await parked, Decision.DENY);
  assert.equal(request.subagent_id, undefined);
});
