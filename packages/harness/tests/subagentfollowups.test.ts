/**
 * Operator follow-ups to live children (slice A2): the bounded per-child queue,
 * the between-step delivery point (step >= 1 only), the 80 000-char child
 * context budget with counted drops, `origin` rows, `end.followups` and the
 * "queued, never delivered" honesty of the handle.
 *
 * Hermetic: in-process scripted providers, temp dirs, loopback only. The
 * dedicated `POST /api/subagents/{id}/messages` route tests live in the second
 * half of this file.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { resolveConfig, type Config } from "../src/config.ts";
import { SharedContext, type ChatMessage } from "../src/context.ts";
import { TwoBrothersHarness } from "../src/harness.ts";
import {
  ApprovalMode,
  Decision,
  PermissionManager,
  PermissionPolicy,
} from "../src/permissions.ts";
import {
  MockProvider,
  ProviderAbortError,
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
import { SessionStore } from "../src/session.ts";
import {
  SUBAGENT_CONTEXT_MAX_CHARS,
  SUBAGENT_FOLLOWUP_QUEUE_MAX,
  SUBAGENT_FOLLOWUP_TEXT_MAX_CHARS,
  SUBAGENT_TOOL_NAME,
  SubagentStore,
  isSubagentId,
  type SubagentControlHandle,
  type SubagentControlSink,
} from "../src/subagent.ts";
import { Workspace } from "../src/workspace.ts";

type AnyRecord = Record<string, any>;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function tmpdir(prefix: string): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function mockConfig() {
  return resolveConfig({ provider: "mock" });
}

function parentContext(root: string): SharedContext {
  return new SharedContext(new SessionStore(path.join(root, "parent.jsonl")));
}

async function waitFor(
  predicate: () => boolean,
  what: string,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function logRows(store: SubagentStore, id: string): AnyRecord[] {
  const raw = fs.readFileSync(path.join(store.directory, `${id}.jsonl`), "utf-8");
  const rows: AnyRecord[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    try {
      rows.push(JSON.parse(line) as AnyRecord);
    } catch {
      // torn tail / hand-edited junk: skipped like the store's tolerant read
    }
  }
  return rows;
}

function endRow(store: SubagentStore, id: string): AnyRecord | undefined {
  return logRows(store, id).find((row) => row.type === "end");
}

/** The senior's mock provider, recording the exact messages each call saw. */
class RecordingSenior extends MockProvider {
  seen: ChatMessage[][] = [];

  override async chatWithTools(
    messages: ChatMessage[],
    tools: Tool[],
    options: ToolChatOptions = {},
  ): Promise<ToolChatResponse> {
    this.seen.push(messages.map((message) => ({ ...message })));
    return super.chatWithTools(messages, tools, options);
  }
}

/** A child whose provider call never finishes until its signal aborts. */
class HangingChildProvider implements Provider {
  async chat(
    _messages: ChatMessage[],
    _responseKind?: string,
    signal?: AbortSignal,
  ): Promise<string> {
    return new Promise<string>((_resolve, reject) => {
      if (signal?.aborted) {
        reject(new ProviderAbortError());
        return;
      }
      signal?.addEventListener("abort", () => reject(new ProviderAbortError()), {
        once: true,
      });
    });
  }
}

/**
 * A senior provider that delegates once per task, however many nodes/runs share
 * the harness construction: before a tool result it spawns one helper, after it
 * reports. Used by the multi-run isolation test (a scripted MockProvider's step
 * counter is shared across runs, and a stateless spawner would delegate again
 * from a later node's tool loop).
 */
class DelegatingSeniorProvider extends MockProvider {
  private readonly delegated = new Set<string>();

  override async chatWithTools(
    messages: ChatMessage[],
    _tools: Tool[],
    _options: ToolChatOptions = {},
  ): Promise<ToolChatResponse> {
    const hasToolResult = messages.some((message) => message.role === "tool");
    // The rendered transcript always carries the initial task envelope, so its
    // text identifies the run even when a later node's transcript has grown.
    const rendered = String(messages.find((message) => message.role === "user")?.content ?? "");
    const task = /\[\[TASK\]\]([\s\S]*?)\[\[\/TASK\]\]/.exec(rendered)?.[1] ?? rendered;
    if (hasToolResult || this.delegated.has(task)) {
      return { content: "Verification complete.", toolCalls: [] };
    }
    this.delegated.add(task);
    return {
      content: "",
      toolCalls: [
        {
          id: `spawn-${messages.length}`,
          name: SUBAGENT_TOOL_NAME,
          args: { task: "Write the helper note." },
        },
      ],
    };
  }
}

/** A child provider that makes tool calls and records every request. */
class ScriptedChildProvider implements Provider {
  calls: ChatMessage[][] = [];
  toolNames: string[][] = [];
  private readonly script: Array<
    { tool: string; args: Record<string, unknown> } | { text: string }
  >;

  constructor(script: Array<{ tool: string; args: Record<string, unknown> } | { text: string }>) {
    this.script = script;
  }

  async chat(): Promise<string> {
    throw new Error("this child only supports tool calls");
  }

  async chatWithTools(messages: ChatMessage[], tools: Tool[]): Promise<ToolChatResponse> {
    this.calls.push(messages.map((message) => ({ ...message })));
    this.toolNames.push(tools.map((tool) => tool.name));
    const next = this.script[Math.min(this.calls.length - 1, this.script.length - 1)]!;
    if ("text" in next) return { content: next.text, toolCalls: [] };
    return {
      content: "",
      toolCalls: [{ id: `call-${this.calls.length}`, name: next.tool, args: next.args }],
    };
  }
}

interface TestSink extends SubagentControlSink {
  handles: SubagentControlHandle[];
  released: string[];
}

function testSink(onRegister?: (handle: SubagentControlHandle) => void): TestSink {
  const handles: SubagentControlHandle[] = [];
  const released: string[] = [];
  return {
    handles,
    released,
    register(handle) {
      handles.push(handle);
      onRegister?.(handle);
    },
    release(id) {
      released.push(id);
    },
  };
}

function subagentEvents(events: AnyRecord[]): AnyRecord[] {
  return events.filter((event) => String(event.type).startsWith("subagent_"));
}

function toolPayload(senior: RecordingSenior): AnyRecord {
  const toolMessage = senior.seen
    .flat()
    .reverse()
    .find((message) => message.role === "tool");
  assert.ok(toolMessage);
  return JSON.parse(String(toolMessage.content)) as AnyRecord;
}

/** A fake read-only child tool: its execute observes the live control. */
function fakeReadTool(execute: () => string): Tool {
  return {
    name: "workspace_read_file",
    description: "Read one workspace file.",
    parameters: { type: "object", properties: { path: { type: "string" } } },
    execute: () => execute(),
  };
}

// ---------------------------------------------------------------------------
// bounds: 8 pending, 4 000 chars each, honest refusals
// ---------------------------------------------------------------------------

test("the queue accepts 8 bounded follow-ups and refuses the 9th, empty and oversized texts", async () => {
  const tmp = tmpdir("tb-subfollow-bounds-");
  try {
    const store = new SubagentStore(path.join(tmp.root, "subagents"));
    const sink = testSink();
    const parent = new AbortController();
    const senior = new RecordingSenior([
      { tool: SUBAGENT_TOOL_NAME, args: { task: "Inspect the notes." } },
    ]);
    const harness = new TwoBrothersHarness(mockConfig(), {
      senior,
      junior: new MockProvider(),
      signal: parent.signal,
      subagents: {
        store,
        parentSession: "parent.jsonl",
        providerFactory: () => new HangingChildProvider(),
        controls: sink,
      },
    });
    const runPromise = harness.run("Plan a migration", parentContext(tmp.root));
    await waitFor(() => sink.handles.length === 1, "the child control to register");
    const handle = sink.handles[0]!;

    // Invalid texts never consume a queue slot.
    assert.deepEqual(handle.send("", "operator"), { ok: false, reason: "invalid_text" });
    assert.deepEqual(handle.send("   ", "operator"), { ok: false, reason: "invalid_text" });
    assert.deepEqual(handle.send(42, "operator"), { ok: false, reason: "invalid_text" });
    assert.deepEqual(
      handle.send("x".repeat(SUBAGENT_FOLLOWUP_TEXT_MAX_CHARS + 1), "operator"),
      { ok: false, reason: "invalid_text" },
    );
    assert.equal(handle.pendingFollowUps(), 0);

    // The exact bound is accepted (and reported back 1-based).
    assert.deepEqual(handle.send("y".repeat(SUBAGENT_FOLLOWUP_TEXT_MAX_CHARS), "operator"), {
      ok: true,
      pending: 1,
    });
    for (let index = 2; index <= SUBAGENT_FOLLOWUP_QUEUE_MAX; index += 1) {
      assert.deepEqual(handle.send(`Note ${index}`, "operator"), { ok: true, pending: index });
    }
    assert.equal(handle.pendingFollowUps(), SUBAGENT_FOLLOWUP_QUEUE_MAX);
    // A 9th is refused with the queue-full reason; the pending count is intact.
    assert.deepEqual(handle.send("one too many", "operator"), {
      ok: false,
      reason: "queue_full",
    });
    assert.equal(handle.pendingFollowUps(), SUBAGENT_FOLLOWUP_QUEUE_MAX);
    // An unknown sender is refused, never queued.
    assert.deepEqual(
      (handle.send as (text: unknown, from: string) => AnyRecord)("hello", "junior"),
      { ok: false, reason: "invalid_text" },
    );
    assert.equal(handle.pendingFollowUps(), SUBAGENT_FOLLOWUP_QUEUE_MAX);

    // An interrupted child drops every pending follow-up, counted honestly.
    assert.equal(handle.interrupt("operator"), true);
    const result = await runPromise;
    assert.equal(result.cancelled, false);
    const end = endRow(store, handle.id);
    assert.equal(end?.status, "cancelled");
    assert.deepEqual(end?.followups, { delivered: 0, dropped: SUBAGENT_FOLLOWUP_QUEUE_MAX });
    assert.equal(handle.pendingFollowUps(), 0);
    assert.deepEqual(handle.send("after settle", "operator"), {
      ok: false,
      reason: "not_running",
    });
    // The cancelled tool result carries the counts (a follow-up-free child would not).
    const payload = toolPayload(senior);
    assert.deepEqual(payload.followups, { delivered: 0, dropped: SUBAGENT_FOLLOWUP_QUEUE_MAX });
  } finally {
    tmp.cleanup();
  }
});

// ---------------------------------------------------------------------------
// delivery: step >= 1 only, ordinary user turn, child log origin row
// ---------------------------------------------------------------------------

test("a follow-up is delivered at the child's next step, never at step 0, as one user turn", async () => {
  const tmp = tmpdir("tb-subfollow-delivery-");
  try {
    const store = new SubagentStore(path.join(tmp.root, "subagents"));
    const events: AnyRecord[] = [];
    const ctx = parentContext(tmp.root);
    const senior = new RecordingSenior([
      { tool: SUBAGENT_TOOL_NAME, args: { task: "Read the notes." } },
    ]);
    let live: SubagentControlHandle | null = null;
    const sink = testSink((handle) => {
      live = handle;
    });
    const child = new ScriptedChildProvider([
      { tool: "workspace_read_file", args: { path: "notes.txt" } },
      { text: "The notes say hello." },
    ]);
    const readTool = fakeReadTool(() => {
      // The operator's follow-up arrives while the child is between steps: its
      // queue must survive exactly one provider call.
      const sent = live!.send("Also read the second half.", "operator");
      assert.deepEqual(sent, { ok: true, pending: 1 });
      return "hello from notes.txt";
    });
    const harness = new TwoBrothersHarness(mockConfig(), {
      senior,
      junior: new MockProvider(),
      toolScopes: { junior: [readTool] },
      subagents: {
        store,
        parentSession: "parent.jsonl",
        providerFactory: () => child,
        controls: sink,
      },
      onEvent: (event) => events.push(event as unknown as AnyRecord),
    });

    const result = await harness.run("Plan a migration", ctx);
    assert.equal(result.cancelled, false);
    assert.equal(sink.handles.length, 1);
    const handle = sink.handles[0]!;
    assert.equal(child.calls.length, 2);

    // Step 0 never sees the follow-up; step 1 does, and the previous message is
    // the tool result (never two consecutive user turns).
    assert.equal(
      child.calls[0]!.some((message) => String(message.content).includes("Follow-up from the operator:")),
      false,
    );
    const stepTwo = child.calls[1]!;
    const last = stepTwo[stepTwo.length - 1]!;
    assert.equal(last.role, "user");
    assert.match(String(last.content), /^Follow-up from the operator:\nAlso read the second half\.$/);
    assert.equal(stepTwo[stepTwo.length - 2]?.role, "tool");

    // The durable child log keeps one user row with the additive origin.
    const detail = store.get(handle.id);
    assert.ok(detail);
    const followUpRow = detail.transcript.find(
      (entry) => entry.type === "message" && entry.origin === "operator",
    );
    assert.ok(followUpRow);
    assert.equal(followUpRow.type === "message" ? followUpRow.text : "", "Also read the second half.");
    assert.equal(
      detail.transcript.filter((entry) => entry.type === "message" && entry.role === "user").length,
      2,
      "the initial task row keeps no origin and the follow-up adds exactly one row",
    );

    // The end row and the tool payload carry the counts; the activity stream and
    // the brothers' envelopes never do.
    assert.deepEqual(endRow(store, handle.id)?.followups, { delivered: 1, dropped: 0 });
    const payload = toolPayload(senior);
    assert.deepEqual(payload.followups, { delivered: 1, dropped: 0 });
    assert.equal(
      subagentEvents(events).some((event) =>
        String(event.text ?? "").includes("Also read the second half."),
      ),
      false,
    );
    assert.equal(
      ctx.events.some((envelope) =>
        JSON.stringify(envelope.payload ?? {}).includes("Also read the second half."),
      ),
      false,
    );
    // A child never gets the control tools (and no follow-up is ever a tool).
    for (const names of child.toolNames) {
      for (const forbidden of [
        "subagent",
        "send_message",
        "interrupt_agent",
        "list_agents",
        "subagent_report",
      ]) {
        assert.equal(names.includes(forbidden), false);
      }
    }
    assert.equal(isSubagentId("send_message"), false);
  } finally {
    tmp.cleanup();
  }
});

test("a step-0 completion with a queued follow-up drops it, counted, without any key on a follow-up-free child", async () => {
  const tmp = tmpdir("tb-subfollow-step0-");
  try {
    const store = new SubagentStore(path.join(tmp.root, "subagents"));
    const sink = testSink((handle) => {
      assert.deepEqual(handle.send("too late for step 0", "operator"), { ok: true, pending: 1 });
    });
    const senior = new RecordingSenior([
      { tool: SUBAGENT_TOOL_NAME, args: { task: "Answer with one line." } },
    ]);
    const harness = new TwoBrothersHarness(mockConfig(), {
      senior,
      junior: new MockProvider(),
      subagents: {
        store,
        parentSession: "parent.jsonl",
        providerFactory: () => new MockProvider(),
        controls: sink,
      },
    });
    const result = await harness.run("Plan a migration", parentContext(tmp.root));
    assert.equal(result.cancelled, false);
    const handle = sink.handles[0]!;
    assert.deepEqual(endRow(store, handle.id)?.followups, { delivered: 0, dropped: 1 });
    assert.equal(
      store.get(handle.id)?.transcript.some((entry) => entry.type === "message" && entry.origin),
      false,
    );

    // The golden shape: a child nobody messaged gains no followups key anywhere.
    const tmp2 = tmpdir("tb-subfollow-golden-");
    try {
      const store2 = new SubagentStore(path.join(tmp2.root, "subagents"));
      const senior2 = new RecordingSenior([
        { tool: SUBAGENT_TOOL_NAME, args: { task: "Answer with one line." } },
      ]);
      const harness2 = new TwoBrothersHarness(mockConfig(), {
        senior: senior2,
        junior: new MockProvider(),
        subagents: {
          store: store2,
          parentSession: "parent.jsonl",
          providerFactory: () => new MockProvider(),
        },
      });
      await harness2.run("Plan a migration", parentContext(tmp2.root));
      const payload2 = toolPayload(senior2);
      assert.equal(Object.prototype.hasOwnProperty.call(payload2, "followups"), false);
      const id = String(payload2.subagent_id);
      assert.equal(Object.prototype.hasOwnProperty.call(endRow(store2, id), "followups"), false);
    } finally {
      tmp2.cleanup();
    }
  } finally {
    tmp.cleanup();
  }
});

// ---------------------------------------------------------------------------
// parked approval: a follow-up waits, never answers the card (5.4)
// ---------------------------------------------------------------------------

test("a follow-up queued while the child is parked is delivered after the approval resolves", async () => {
  const tmp = tmpdir("tb-subfollow-park-");
  try {
    const workspaceRoot = path.join(tmp.root, "ws");
    fs.mkdirSync(workspaceRoot, { recursive: true });
    const store = new SubagentStore(path.join(tmp.root, "subagents"));
    const events: AnyRecord[] = [];
    const parent = new AbortController();
    const broker = new RunApprovalBroker();
    broker.attach((event) => events.push(event as unknown as AnyRecord), parent.signal);
    const workspace = new Workspace(
      workspaceRoot,
      new PermissionManager(new PermissionPolicy(ApprovalMode.ASK), broker),
    );
    const child = new ScriptedChildProvider([
      { tool: "workspace_write_file", args: { path: "followup.txt", content: "hello\n" } },
      { text: "Wrote the file after reading the follow-up." },
    ]);
    const sink = testSink();
    const harness = new TwoBrothersHarness(mockConfig(), {
      senior: new RecordingSenior([
        { tool: SUBAGENT_TOOL_NAME, args: { task: "Write the helper note." } },
      ]),
      junior: new MockProvider(),
      workspace,
      signal: parent.signal,
      subagents: {
        store,
        parentSession: "parent.jsonl",
        providerFactory: () => child,
        controls: sink,
      },
      onEvent: (event) => events.push(event as unknown as AnyRecord),
    });

    const runPromise = harness.run("Plan a migration", parentContext(tmp.root));
    await waitFor(() => broker.pending().length === 1, "the parked child write");
    const handle = sink.handles[0]!;
    const parked = broker.pending()[0] as AnyRecord;
    // While parked, the follow-up is queued, not delivered, and the card stays.
    assert.deepEqual(handle.send("Prefer the second file.", "operator"), {
      ok: true,
      pending: 1,
    });
    assert.equal(child.calls.length, 1);
    assert.equal(handle.pendingFollowUps(), 1);
    assert.equal(broker.pending().length, 1);
    assert.equal(fs.existsSync(path.join(workspaceRoot, "followup.txt")), false);

    // Only the operator's card answer resolves the wait; delivery is at step 1.
    assert.equal(broker.respond(parked.approval_id, Decision.ALLOW), Decision.ALLOW);
    const result = await runPromise;
    assert.equal(result.cancelled, false);
    assert.equal(fs.existsSync(path.join(workspaceRoot, "followup.txt")), true);
    assert.equal(child.calls.length, 2);
    const stepTwo = child.calls[1]!;
    assert.match(String(stepTwo[stepTwo.length - 1]?.content), /Prefer the second file\./);
    assert.deepEqual(endRow(store, handle.id)?.followups, { delivered: 1, dropped: 0 });
  } finally {
    tmp.cleanup();
  }
});

// ---------------------------------------------------------------------------
// context budget: no compaction inside a child, counted drops, honest 409 data
// ---------------------------------------------------------------------------

test("a follow-up that would overflow the child context is dropped and counted; the child completes", async () => {
  const tmp = tmpdir("tb-subfollow-context-");
  try {
    const store = new SubagentStore(path.join(tmp.root, "subagents"));
    const senior = new RecordingSenior([
      { tool: SUBAGENT_TOOL_NAME, args: { task: "Summarize the big note." } },
    ]);
    let live: SubagentControlHandle | null = null;
    const sink = testSink((handle) => {
      live = handle;
    });
    const huge = "y".repeat(SUBAGENT_CONTEXT_MAX_CHARS + 10_000);
    let sendResults: AnyRecord[] = [];
    const readTool = fakeReadTool(() => {
      const sent = live!.send("A follow-up that cannot fit.", "operator");
      sendResults.push(sent as unknown as AnyRecord);
      return huge;
    });
    const child = new ScriptedChildProvider([
      { tool: "workspace_read_file", args: { path: "big.txt" } },
      { tool: "workspace_read_file", args: { path: "big.txt" } },
      { text: "The big note is unreadable; the report is bounded." },
    ]);
    const harness = new TwoBrothersHarness(mockConfig(), {
      senior,
      junior: new MockProvider(),
      toolScopes: { junior: [readTool] },
      subagents: {
        store,
        parentSession: "parent.jsonl",
        providerFactory: () => child,
        controls: sink,
      },
    });

    const result = await harness.run("Plan a migration", parentContext(tmp.root));
    assert.equal(result.cancelled, false);
    const handle = sink.handles[0]!;
    // First send was accepted (the estimate predated the huge tool result) and
    // then dropped at the delivery point; the second send was refused at once.
    assert.equal(sendResults[0]?.ok, true);
    assert.equal(sendResults[1]?.ok, false);
    assert.equal(sendResults[1]?.reason, "context_full");
    assert.ok(Number(sendResults[1]?.chars) >= SUBAGENT_CONTEXT_MAX_CHARS);

    assert.equal(
      child.calls.some((messages) =>
        messages.some((message) => String(message.content).includes("A follow-up that cannot fit.")),
      ),
      false,
    );
    assert.deepEqual(endRow(store, handle.id)?.followups, { delivered: 0, dropped: 1 });
    const payload = toolPayload(senior);
    assert.equal(payload.status, "completed");
    assert.deepEqual(payload.followups, { delivered: 0, dropped: 1 });
  } finally {
    tmp.cleanup();
  }
});


// ---------------------------------------------------------------------------
// serve: POST /api/subagents/{id}/messages
// ---------------------------------------------------------------------------

interface RunningServer {
  base: string;
  handle: ServerHandle;
  dir: string;
  close(): Promise<void>;
}

async function startServer(options: ServerOptions = {}): Promise<RunningServer> {
  const tmp = tmpdir("tb-subfollow-serve-");
  const sessionsDir = options.sessionsDir ? path.resolve(options.sessionsDir) : tmp.root;
  const effective: ServerOptions = {
    configFactory: (): Config => mockConfig(),
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
    close: async () => {
      await handle.close();
      tmp.cleanup();
    },
  };
}

async function api(
  base: string,
  method: string,
  route: string,
  body?: unknown,
): Promise<{ status: number; body: AnyRecord }> {
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
  return { status: res.status, body: parsed as AnyRecord };
}

const post = (base: string, route: string, body?: unknown) =>
  api(base, "POST", route, body);
const get = (base: string, route: string) => api(base, "GET", route);

/** SSE reader: collects `data:` events until `stop` holds or the stream ends. */
function sseEvents(
  base: string,
  route: string,
  stop: (events: AnyRecord[]) => boolean = () => false,
  timeoutMs = 20000,
): Promise<AnyRecord[]> {
  return new Promise((resolve, reject) => {
    const events: AnyRecord[] = [];
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
            events.push(JSON.parse(line.slice(6)) as AnyRecord);
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

function runUntilEnd(base: string, runId: string, after = 0): Promise<AnyRecord[]> {
  return sseEvents(base, `/api/runs/${runId}/events?after=${after}`, (events) =>
    events.some((event) => event.type === "run_end"),
  );
}

interface HelperModel {
  baseUrl: string;
  /** Every request body the child provider received, in order. */
  requests: AnyRecord[];
  close(): Promise<void>;
}

/**
 * A scripted OpenAI-compatible helper route: the first call asks for one
 * workspace write (which parks on the parent run), the call after its tool
 * result reports. Requests are recorded so a test can prove WHEN a follow-up
 * reached the child conversation.
 */
async function startHelperModel(report = "Wrote e2e-helper.txt."): Promise<HelperModel> {
  const requests: AnyRecord[] = [];
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
      requests.push(body);
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
      const content = hasToolResult ? report : "";
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
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function configureHelper(srv: RunningServer, model: { baseUrl: string }): Promise<void> {
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

async function registerWorkspace(
  srv: RunningServer,
  root: string,
  name = "e2e-helper",
): Promise<string> {
  const ws = await post(srv.base, "/api/workspaces", { path: root, name });
  assert.equal(ws.status, 201);
  return String(ws.body.id);
}

async function startRun(
  srv: RunningServer,
  workspaceId: string,
  session: string,
  task = "Do the scripted E2E task",
): Promise<string> {
  const started = await post(srv.base, "/api/runs", {
    task,
    mode: "consult",
    provider: "mock",
    workspace_id: workspaceId,
    session,
  });
  assert.equal(started.status, 202);
  return String(started.body.run_id);
}

/** One configured server + workspace + a run that parks its helper on a write. */
async function parkedChildServer(model: HelperModel): Promise<{
  srv: RunningServer;
  ws: { root: string; cleanup: () => void };
  runId: string;
  childId: string;
  approvalId: string;
  events: AnyRecord[];
}> {
  const srv = await startServer({
    providerOverrides: {
      senior: new RecordingSenior([
        { tool: SUBAGENT_TOOL_NAME, args: { task: "Write the helper note." } },
      ]),
      junior: new MockProvider(),
    },
  });
  const ws = tmpdir("tb-subfollow-serve-ws-");
  try {
    await configureHelper(srv, model);
    const wsId = await registerWorkspace(srv, ws.root);
    const runId = await startRun(srv, wsId, "followup-route");
    const events = await sseEvents(
      srv.base,
      `/api/runs/${runId}/events?after=0`,
      (all) => all.some((event) => event.type === "approval_requested"),
      15000,
    );
    const requested = events.find((event) => event.type === "approval_requested") as AnyRecord;
    assert.ok(requested);
    return {
      srv,
      ws,
      runId,
      childId: String(requested.subagent_id),
      approvalId: String(requested.approval_id),
      events,
    };
  } catch (exc) {
    await srv.close();
    ws.cleanup();
    throw exc;
  }
}

test("messages route: queued 200, bounded 400s, honest 404/409s, and released after settle", async () => {
  const model = await startHelperModel();
  const run = await parkedChildServer(model);
  try {
    const { srv, childId } = run;
    // A parked child is exactly the case the composer is enabled for; the
    // follow-up is queued and never reported as delivered.
    for (let index = 1; index <= SUBAGENT_FOLLOWUP_QUEUE_MAX; index += 1) {
      const accepted = await post(srv.base, `/api/subagents/${childId}/messages`, {
        text: `Follow-up ${index}`,
      });
      assert.equal(accepted.status, 200);
      assert.deepEqual(accepted.body, {
        subagent_id: childId,
        status: "queued",
        pending: index,
      });
    }
    const full = await post(srv.base, `/api/subagents/${childId}/messages`, {
      text: "one too many",
    });
    assert.equal(full.status, 409);
    assert.equal(full.body.detail, "follow-up queue is full (8 pending)");

    // Bounded body validation with exact details.
    const nonString = await post(srv.base, `/api/subagents/${childId}/messages`, { text: 42 });
    assert.equal(nonString.status, 400);
    assert.equal(nonString.body.detail, "text must be a string");
    const empty = await post(srv.base, `/api/subagents/${childId}/messages`, { text: "   " });
    assert.equal(empty.status, 400);
    assert.equal(empty.body.detail, "text must be a non-empty string");
    const tooLong = await post(srv.base, `/api/subagents/${childId}/messages`, {
      text: "x".repeat(SUBAGENT_FOLLOWUP_TEXT_MAX_CHARS + 1),
    });
    assert.equal(tooLong.status, 400);
    assert.equal(tooLong.body.detail, "text is too long (max 4000 chars)");

    // Honest 404s: invalid and never-seen ids (never a path).
    const malformed = await post(srv.base, "/api/subagents/not-an-id/messages", { text: "hi" });
    assert.equal(malformed.status, 404);
    const unknown = await post(
      srv.base,
      "/api/subagents/sub-0000000000000000/messages",
      { text: "hi" },
    );
    assert.equal(unknown.status, 404);

    // The queued texts are not in the transcript yet (the child is parked).
    const whileParked = await get(srv.base, `/api/subagents/${childId}`);
    assert.equal(whileParked.status, 200);
    assert.equal(
      whileParked.body.subagent.transcript.some(
        (entry: AnyRecord) => entry.type === "message" && entry.origin,
      ),
      false,
    );

    // Interrupt: the queue is dropped and counted; a settled child is a 409.
    assert.equal((await post(srv.base, `/api/subagents/${childId}/interrupt`)).status, 200);
    const rest = await runUntilEnd(srv.base, run.runId, run.events.length);
    assert.equal(rest.at(-1)?.type, "run_end");
    assert.equal(rest.at(-1)?.status, "completed");
    const settled = await post(srv.base, `/api/subagents/${childId}/messages`, { text: "late" });
    assert.equal(settled.status, 409);
    assert.equal(settled.body.detail, "helper already finished");

    const log = logRows(new SubagentStore(path.join(srv.dir, "subagents")), childId);
    assert.deepEqual(log.find((row) => row.type === "end")?.followups, {
      delivered: 0,
      dropped: SUBAGENT_FOLLOWUP_QUEUE_MAX,
    });
    // A second run never resurrects a settled child.
    const reopened = await post(srv.base, `/api/subagents/${childId}/messages`, { text: "again" });
    assert.equal(reopened.status, 409);
  } finally {
    await run.srv.close();
    await model.close();
    run.ws.cleanup();
  }
});

test("messages route: a queued follow-up reaches the child after the approval, one origin row", async () => {
  const report = "Wrote e2e-helper.txt; read the follow-up.";
  const model = await startHelperModel(report);
  const run = await parkedChildServer(model);
  try {
    const { srv, childId } = run;
    assert.equal(model.requests.length, 1, "the child is parked on its first step");
    const queued = await post(srv.base, `/api/subagents/${childId}/messages`, {
      text: "Prefer notes.txt.",
    });
    assert.equal(queued.status, 200);
    assert.deepEqual(queued.body, { subagent_id: childId, status: "queued", pending: 1 });
    // Not delivered while parked: no second child provider request.
    assert.equal(model.requests.length, 1);

    const allowed = await post(
      srv.base,
      `/api/runs/${run.runId}/approvals/${run.approvalId}`,
      { allow: true },
    );
    assert.equal(allowed.status, 200);
    const rest = await runUntilEnd(srv.base, run.runId, run.events.length);
    assert.equal(rest.at(-1)?.type, "run_end");
    assert.equal(rest.at(-1)?.status, "completed");

    // The follow-up arrived at the child's next step, after the tool result.
    assert.equal(model.requests.length, 2);
    const stepTwo = model.requests[1]!;
    const messages = stepTwo.messages as AnyRecord[];
    const last = messages[messages.length - 1]!;
    assert.equal(last.role, "user");
    assert.match(String(last.content), /^Follow-up from the operator:\nPrefer notes\.txt\.$/);
    assert.equal(messages[messages.length - 2]?.role, "tool");

    // Drawer data: the durable user row carries the additive origin, and the
    // end row reports the delivery.
    const detail = await get(srv.base, `/api/subagents/${childId}`);
    assert.equal(detail.status, 200);
    const originRow = detail.body.subagent.transcript.find(
      (entry: AnyRecord) => entry.type === "message" && entry.origin === "operator",
    );
    assert.ok(originRow);
    assert.equal(originRow.text, "Prefer notes.txt.");
    assert.equal(detail.body.subagent.status, "completed");
    const log = logRows(new SubagentStore(path.join(srv.dir, "subagents")), childId);
    assert.deepEqual(log.find((row) => row.type === "end")?.followups, {
      delivered: 1,
      dropped: 0,
    });
    // No new subagent event type or field: the stream keeps
    // started/activity/completed, and `followups` stays a durable-row fact.
    const types = new Set(
      [...run.events, ...rest]
        .filter((event) => String(event.type).startsWith("subagent_"))
        .map((event) => event.type),
    );
    assert.deepEqual([...types].sort(), [
      "subagent_activity",
      "subagent_completed",
      "subagent_started",
    ]);
    const completedEvent = [...run.events, ...rest].find(
      (event) => event.type === "subagent_completed",
    ) as AnyRecord;
    assert.equal(Object.prototype.hasOwnProperty.call(completedEvent, "followups"), false);
  } finally {
    await run.srv.close();
    await model.close();
    run.ws.cleanup();
  }
});

test("messages route: two live runs never reach each other's children", async () => {
  const model = await startHelperModel();
  const srv = await startServer({
    providerOverrides: {
      senior: new DelegatingSeniorProvider(),
      junior: new MockProvider(),
    },
  });
  const wsA = tmpdir("tb-subfollow-isolation-ws-a-");
  const wsB = tmpdir("tb-subfollow-isolation-ws-b-");
  try {
    await configureHelper(srv, model);
    // Two independent runs with their own workspace (the per-file mutation
    // queue is keyed by realpath, so a shared target would serialize the
    // children instead of parking both).
    const wsIdA = await registerWorkspace(srv, wsA.root, "e2e-helper-a");
    const wsIdB = await registerWorkspace(srv, wsB.root, "e2e-helper-b");
    const runA = await startRun(srv, wsIdA, "followup-isolation-a", "Isolation task A");
    const eventsA = await sseEvents(
      srv.base,
      `/api/runs/${runA}/events?after=0`,
      (events) => events.some((event) => event.type === "approval_requested"),
      15000,
    );
    const parkedA = eventsA.find((event) => event.type === "approval_requested") as AnyRecord;
    const runB = await startRun(srv, wsIdB, "followup-isolation-b", "Isolation task B");
    const eventsB = await sseEvents(
      srv.base,
      `/api/runs/${runB}/events?after=0`,
      (events) => events.some((event) => event.type === "approval_requested"),
      15000,
    );
    const parkedB = eventsB.find((event) => event.type === "approval_requested") as AnyRecord;
    const childA = String(parkedA.subagent_id);
    const childB = String(parkedB.subagent_id);
    assert.notEqual(childA, childB);

    // Each queue is keyed by its own child id: neither text reaches the other.
    const sentA = await post(srv.base, `/api/subagents/${childA}/messages`, {
      text: "only for A",
    });
    const sentB = await post(srv.base, `/api/subagents/${childB}/messages`, {
      text: "only for B",
    });
    assert.deepEqual(sentA.body, { subagent_id: childA, status: "queued", pending: 1 });
    assert.deepEqual(sentB.body, { subagent_id: childB, status: "queued", pending: 1 });

    // Each run's own card resolves its own helper.
    assert.equal(
      (
        await post(srv.base, `/api/runs/${runA}/approvals/${String(parkedA.approval_id)}`, {
          allow: true,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await post(srv.base, `/api/runs/${runB}/approvals/${String(parkedB.approval_id)}`, {
          allow: true,
        })
      ).status,
      200,
    );
    const restA = await runUntilEnd(srv.base, runA, eventsA.length);
    const restB = await runUntilEnd(srv.base, runB, eventsB.length);
    assert.equal(restA.at(-1)?.status, "completed");
    assert.equal(restB.at(-1)?.status, "completed");

    const store = new SubagentStore(path.join(srv.dir, "subagents"));
    const originText = (id: string): string[] =>
      logRows(store, id)
        .filter((row) => row.type === "message" && row.origin === "operator")
        .map((row) => String(row.text));
    assert.deepEqual(originText(childA), ["only for A"]);
    assert.deepEqual(originText(childB), ["only for B"]);
    assert.deepEqual(endRow(store, childA)?.followups, { delivered: 1, dropped: 0 });
    assert.deepEqual(endRow(store, childB)?.followups, { delivered: 1, dropped: 0 });
  } finally {
    await srv.close();
    await model.close();
    wsA.cleanup();
    wsB.cleanup();
  }
});
