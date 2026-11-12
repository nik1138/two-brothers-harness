/**
 * Child-scoped interrupt (slice A1): one `AbortController` per child composed
 * with the parent run signal, withdrawable parked approvals, and the
 * `cancelled_by` fields on the event and the durable `end` row.
 *
 * Hermetic: in-process scripted providers, loopback only, temp dirs. The
 * dedicated `serve` route tests live in this file's second half and use the
 * same tiny scripted helper model pattern as `subagentapprovals.test.ts`.
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
  Action,
  ApprovalMode,
  Decision,
  PermissionManager,
  PermissionPolicy,
} from "../src/permissions.ts";
import {
  MockProvider,
  ProviderAbortError,
  type Provider,
  type ToolChatOptions,
  type ToolChatResponse,
  type Tool,
} from "../src/provider.ts";
import { RunApprovalBroker } from "../src/runevents.ts";
import {
  createServer,
  type ServerHandle,
  type ServerOptions,
} from "../src/server.ts";
import { SessionStore } from "../src/session.ts";
import {
  SUBAGENT_TOOL_NAME,
  SubagentStore,
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

/** Raw child-log rows (the durable truth, unread through the tolerant reader). */
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

  async chatWithTools(
    _messages: ChatMessage[],
    _tools: Tool[],
    options: ToolChatOptions = {},
  ): Promise<ToolChatResponse> {
    const signal = options.signal;
    return new Promise<ToolChatResponse>((_resolve, reject) => {
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

/** A child that parks on one workspace write and only then reports. */
class WriteThenTextProvider implements Provider {
  calls = 0;

  async chat(): Promise<string> {
    throw new Error("the writing child only supports tool calls");
  }

  async chatWithTools(): Promise<ToolChatResponse> {
    this.calls += 1;
    if (this.calls === 1) {
      return {
        content: "",
        toolCalls: [
          {
            id: "child-write-1",
            name: "workspace_write_file",
            args: { path: "controls-helper.txt", content: "hello from the helper\n" },
          },
        ],
      };
    }
    return { content: "Wrote the helper note.", toolCalls: [] };
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

function endRow(store: SubagentStore, id: string): AnyRecord | undefined {
  return logRows(store, id).find((row) => row.type === "end");
}

// ---------------------------------------------------------------------------
// one control per child: interrupt aborts only the child (R1)
// ---------------------------------------------------------------------------

test("interrupt aborts only the child: the parent run completes", async () => {
  const tmp = tmpdir("tb-subcontrols-r1-");
  try {
    const store = new SubagentStore(path.join(tmp.root, "subagents"));
    const events: AnyRecord[] = [];
    const senior = new RecordingSenior([
      { tool: SUBAGENT_TOOL_NAME, args: { task: "Inspect the notes file." } },
    ]);
    const sink = testSink((handle) => {
      // Let the spawn settle, then interrupt while the child's provider hangs.
      setTimeout(() => handle.interrupt("operator"), 5);
    });
    const parent = new AbortController();
    const harness = new TwoBrothersHarness(mockConfig(), {
      senior,
      junior: new MockProvider(),
      signal: parent.signal,
      subagents: {
        store,
        parentSession: "parent.jsonl",
        providerFactory: () => new HangingChildProvider(),
        controls: sink,
        runId: "run-r1",
      },
      onEvent: (event) => events.push(event as unknown as AnyRecord),
    });

    const result = await harness.run("Plan a migration", parentContext(tmp.root));

    // The parent run finished normally and its signal was never aborted.
    assert.equal(result.cancelled, false);
    assert.equal(parent.signal.aborted, false);
    assert.equal(sink.handles.length, 1);
    const handle = sink.handles[0]!;
    assert.equal(handle.runId, "run-r1");
    assert.equal(handle.background, false);
    assert.deepEqual(sink.released, [handle.id]);

    // The child settled cancelled with the honest cause.
    const detail = store.get(handle.id);
    assert.ok(detail);
    assert.equal(detail.status, "cancelled");
    assert.equal(detail.error, "interrupted by the operator");
    assert.ok(!detail.result);
    assert.equal(endRow(store, handle.id)?.cancelled_by, "operator");
    const completed = events.find((event) => event.type === "subagent_completed");
    assert.equal(completed?.status, "cancelled");
    assert.equal(completed?.cancelled_by, "operator");

    // The parent's next provider call received an honest cancelled tool result.
    const toolMessage = senior.seen
      .flat()
      .reverse()
      .find((message) => message.role === "tool");
    assert.ok(toolMessage);
    const payload = JSON.parse(String(toolMessage.content)) as AnyRecord;
    assert.equal(payload.status, "cancelled");
    assert.equal(payload.error, "interrupted by the operator");
    assert.equal(payload.tool, SUBAGENT_TOOL_NAME);
    // A second interrupt is a no-op.
    assert.equal(handle.interrupt("operator"), false);
  } finally {
    tmp.cleanup();
  }
});

// ---------------------------------------------------------------------------
// parked child approval withdrawal (R2)
// ---------------------------------------------------------------------------

async function parkedWriteHarness(tmp: { root: string }): Promise<{
  harness: TwoBrothersHarness;
  broker: RunApprovalBroker;
  parent: AbortController;
  handles: TestSink;
  workspaceRoot: string;
  events: AnyRecord[];
  poll: Promise<void>;
}> {
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
  const senior = new RecordingSenior([
    { tool: SUBAGENT_TOOL_NAME, args: { task: "Write the helper note." } },
  ]);
  const sink = testSink();
  const harness = new TwoBrothersHarness(mockConfig(), {
    senior,
    junior: new MockProvider(),
    workspace,
    signal: parent.signal,
    subagents: {
      store,
      parentSession: "parent.jsonl",
      providerFactory: () => new WriteThenTextProvider(),
      controls: sink,
      runId: "run-approval",
    },
    onEvent: (event) => events.push(event as unknown as AnyRecord),
  });
  const poll = waitFor(() => broker.pending().length === 1, "the parked child write");
  return { harness, broker, parent, handles: sink, workspaceRoot, events, poll };
}

test("interrupting a parked child write withdraws the approval and cancels the child", async () => {
  const tmp = tmpdir("tb-subcontrols-park-");
  try {
    const run = await parkedWriteHarness(tmp);
    const runPromise = run.harness.run("Plan a migration", parentContext(tmp.root));
    await run.poll;

    const parked = run.broker.pending()[0] as AnyRecord;
    assert.ok(!Object.prototype.hasOwnProperty.call(parked, "signal"));
    assert.equal(run.handles.handles.length, 1);
    const handle = run.handles.handles[0]!;
    assert.equal(handle.interrupt("operator"), true);
    const result = await runPromise;
    // The parent keeps going (R1) and the parked wait was withdrawn exactly once.
    assert.equal(result.cancelled, false);
    const resolved = run.events.filter(
      (event) => event.type === "approval_resolved" && event.approval_id === parked.approval_id,
    );
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0]?.decision, Decision.DENY);
    assert.equal(resolved[0]?.reason, "interrupted");
    assert.equal(resolved[0]?.subagent_id, handle.id);
    assert.deepEqual(run.broker.pending(), []);
    assert.equal(fs.existsSync(path.join(run.workspaceRoot, "controls-helper.txt")), false);

    // The child log says pending -> cancelled and the end row names the cause.
    const store = new SubagentStore(path.join(tmp.root, "subagents"));
    const child = store.get(handle.id);
    assert.ok(child);
    assert.equal(child.status, "cancelled");
    assert.equal(child.error, "interrupted by the operator");
    const approvals = child.transcript
      .filter((entry) => entry.type === "approval")
      .map((entry) => (entry.type === "approval" ? entry.status : ""));
    assert.deepEqual(approvals, ["pending", "cancelled"]);
    const end = endRow(store, handle.id);
    assert.equal(end?.status, "cancelled");
    assert.equal(end?.cancelled_by, "operator");

    // No signal ever leaks onto an event or a child row.
    for (const event of run.events) {
      assert.ok(!Object.prototype.hasOwnProperty.call(event, "signal"));
    }
    for (const entry of child.transcript) {
      assert.ok(!Object.prototype.hasOwnProperty.call(entry, "signal"));
    }

    // A second interrupt after settle is a no-op and emits nothing more.
    assert.equal(handle.interrupt("operator"), false);
    assert.equal(
      run.events.filter(
        (event) =>
          event.type === "approval_resolved" && event.approval_id === parked.approval_id,
      ).length,
      1,
    );
  } finally {
    tmp.cleanup();
  }
});

test("parent stop still cancels the child as parent_run and resolves the park once", async () => {
  const tmp = tmpdir("tb-subcontrols-stop-");
  try {
    const run = await parkedWriteHarness(tmp);
    const runPromise = run.harness.run("Plan a migration", parentContext(tmp.root));
    await run.poll;
    const parked = run.broker.pending()[0] as AnyRecord;
    const handle = run.handles.handles[0]!;
    // The RunManager.stop order: abort the run signal, then denyAll.
    run.parent.abort();
    run.broker.denyAll("cancelled");
    const result = await runPromise;
    assert.equal(result.cancelled, true);

    const resolved = run.events.filter(
      (event) => event.type === "approval_resolved" && event.approval_id === parked.approval_id,
    );
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0]?.reason, "cancelled");
    assert.equal(resolved[0]?.subagent_id, handle.id);

    const store = new SubagentStore(path.join(tmp.root, "subagents"));
    const end = endRow(store, handle.id);
    assert.equal(end?.status, "cancelled");
    assert.equal(end?.cancelled_by, "parent_run");
    const completed = run.events.find((event) => event.type === "subagent_completed");
    assert.equal(completed?.status, "cancelled");
    assert.equal(completed?.cancelled_by, "parent_run");
    assert.equal(run.broker.pending().length, 0);
  } finally {
    tmp.cleanup();
  }
});

/** A minimal signal stand-in that counts listeners and fires them on demand. */
class ManualSignal {
  aborted = false;
  private listeners: Array<() => void> = [];

  addEventListener(_type: string, listener: () => void): void {
    this.listeners.push(listener);
  }

  removeEventListener(_type: string, listener: () => void): void {
    this.listeners = this.listeners.filter((entry) => entry !== listener);
  }

  fire(): void {
    this.aborted = true;
    for (const listener of [...this.listeners]) listener();
  }

  listenerCount(): number {
    return this.listeners.length;
  }
}

test("broker: a child signal withdraws one parked wait, emits once and removes its listener", async () => {
  const events: AnyRecord[] = [];
  const broker = new RunApprovalBroker();
  broker.attach((event) => events.push(event as unknown as AnyRecord));
  const signal = new ManualSignal();
  const parked = broker.approve({
    action: Action.WRITE,
    target: "withdraw.txt",
    subagent_id: "sub-abcdef01",
    subagent_label: "Withdraw helper",
    signal: signal as unknown as AbortSignal,
  });
  assert.equal(broker.pending().length, 1);
  signal.fire();
  assert.equal(await parked, Decision.DENY);

  const resolved = events.filter((event) => event.type === "approval_resolved");
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0]?.reason, "interrupted");
  assert.equal(resolved[0]?.decision, Decision.DENY);
  assert.equal(resolved[0]?.subagent_id, "sub-abcdef01");
  assert.equal(broker.pending().length, 0);
  assert.equal(signal.listenerCount(), 0);
  // Firing again is safe and never emits a second resolution (R2).
  signal.fire();
  assert.equal(events.filter((event) => event.type === "approval_resolved").length, 1);
});

test("broker: an already-aborted child signal denies immediately with one event", async () => {
  const events: AnyRecord[] = [];
  const broker = new RunApprovalBroker();
  broker.attach((event) => events.push(event as unknown as AnyRecord));
  const signal = new ManualSignal();
  signal.fire();
  const decision = await broker.approve({
    action: Action.WRITE,
    target: "late.txt",
    subagent_id: "sub-abcdef02",
    signal: signal as unknown as AbortSignal,
  });
  assert.equal(decision, Decision.DENY);
  assert.equal(broker.pending().length, 0);
  const resolved = events.filter((event) => event.type === "approval_resolved");
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0]?.reason, "interrupted");
});

// ---------------------------------------------------------------------------
// completion/interrupt ordering and the sync golden
// ---------------------------------------------------------------------------

test("a completed child ignores a late interrupt and keeps its report", async () => {
  const tmp = tmpdir("tb-subcontrols-late-");
  try {
    const store = new SubagentStore(path.join(tmp.root, "subagents"));
    const sink = testSink();
    const harness = new TwoBrothersHarness(mockConfig(), {
      senior: new RecordingSenior([
        { tool: SUBAGENT_TOOL_NAME, args: { task: "Answer with one line." } },
      ]),
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
    assert.equal(sink.handles.length, 1);
    const handle = sink.handles[0]!;
    const before = store.get(handle.id);
    assert.equal(before?.status, "completed");
    assert.equal(handle.interrupt("operator"), false);
    const after = store.get(handle.id);
    assert.equal(after?.status, "completed");
    assert.equal(after?.result, before?.result);
    assert.equal(endRow(store, handle.id)?.cancelled_by, undefined);
  } finally {
    tmp.cleanup();
  }
});

test("golden: a completed sync child's tool result and event sequence gain no key", async () => {
  const tmp = tmpdir("tb-subcontrols-golden-");
  try {
    const store = new SubagentStore(path.join(tmp.root, "subagents"));
    const events: AnyRecord[] = [];
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
      },
      onEvent: (event) => events.push(event as unknown as AnyRecord),
    });
    const result = await harness.run("Plan a migration", parentContext(tmp.root));
    assert.equal(result.cancelled, false);

    // The tool result keeps the exact pre-A1 shape: no `cancelled_by`, no key.
    const toolMessage = senior.seen
      .flat()
      .reverse()
      .find((message) => message.role === "tool");
    assert.ok(toolMessage);
    const payload = JSON.parse(String(toolMessage.content)) as AnyRecord;
    assert.deepEqual(Object.keys(payload).sort(), [
      "duration_ms",
      "label",
      "model",
      "report",
      "role",
      "status",
      "subagent_id",
      "tool",
      "tool_calls",
      "usage",
    ]);
    assert.equal(payload.status, "completed");

    // The subagent event type sequence is exactly the pre-A1 four.
    const seq = subagentEvents(events).map((event) => event.type);
    assert.deepEqual(seq, [
      "subagent_started",
      "subagent_activity",
      "subagent_activity",
      "subagent_completed",
    ]);
    const completed = events.find((event) => event.type === "subagent_completed") as AnyRecord;
    assert.deepEqual(Object.keys(completed).sort(), [
      "duration_ms",
      "ended_at",
      "label",
      "result",
      "status",
      "subagent_id",
      "type",
      "usage",
    ]);

    // The durable end row also stays key-identical for a normal completion.
    const id = String(payload.subagent_id);
    const end = endRow(store, id) as AnyRecord;
    assert.equal(end.status, "completed");
    assert.ok(!Object.prototype.hasOwnProperty.call(end, "cancelled_by"));
    assert.deepEqual(Object.keys(end).sort(), [
      "ended_at",
      "result",
      "status",
      "type",
      "usage",
    ]);
  } finally {
    tmp.cleanup();
  }
});

// ---------------------------------------------------------------------------
// startup reconciliation of orphaned logs (R8)
// ---------------------------------------------------------------------------

function writeChildLog(directory: string, id: string, rows: AnyRecord[]): string {
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${id}.jsonl`);
  fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf-8");
  return file;
}

test("reconcileOrphans appends one cancelled/restart row to a header-only log, once", () => {
  const tmp = tmpdir("tb-subcontrols-orphan-");
  try {
    const store = new SubagentStore(path.join(tmp.root, "subagents"));
    const id = "sub-aaaaaaaaaaaaaaaa";
    const file = writeChildLog(store.directory, id, [
      { type: "meta", id, parent_session: "parent.jsonl", label: "Orphan", role: "junior", model: "m", task: "t", started_at: 1 },
      { type: "message", role: "user", text: "do it", at: 2 },
    ]);
    const before = fs.readFileSync(file, "utf-8");
    assert.equal(store.reconcileOrphans(1_000, "backend restarted"), 1);
    const rows = logRows(store, id);
    const ends = rows.filter((row) => row.type === "end");
    assert.equal(ends.length, 1);
    assert.equal(ends[0]?.status, "cancelled");
    assert.equal(ends[0]?.cancelled_by, "restart");
    assert.equal(ends[0]?.error, "backend restarted");
    assert.equal(ends[0]?.ended_at, 1_000);
    assert.ok(fs.readFileSync(file, "utf-8").startsWith(before));
    // Idempotent: the second sweep appends nothing.
    assert.equal(store.reconcileOrphans(2_000), 0);
    assert.equal(logRows(store, id).filter((row) => row.type === "end").length, 1);
  } finally {
    tmp.cleanup();
  }
});

test("reconcileOrphans leaves logs with an end row and headerless logs untouched", () => {
  const tmp = tmpdir("tb-subcontrols-orphan2-");
  try {
    const store = new SubagentStore(path.join(tmp.root, "subagents"));
    const finished = "sub-bbbbbbbbbbbbbbbb";
    writeChildLog(store.directory, finished, [
      { type: "meta", id: finished, parent_session: "p.jsonl", label: "Done", role: "junior", model: "m", task: "t", started_at: 1 },
      { type: "end", status: "completed", ended_at: 2, result: "ok" },
    ]);
    const headerless = "sub-cccccccccccccccc";
    writeChildLog(store.directory, headerless, [{ type: "message", role: "user", text: "torn", at: 1 }]);
    const finishedBefore = fs.readFileSync(path.join(store.directory, `${finished}.jsonl`), "utf-8");
    const headerlessBefore = fs.readFileSync(path.join(store.directory, `${headerless}.jsonl`), "utf-8");
    assert.equal(store.reconcileOrphans(), 0);
    assert.equal(fs.readFileSync(path.join(store.directory, `${finished}.jsonl`), "utf-8"), finishedBefore);
    assert.equal(fs.readFileSync(path.join(store.directory, `${headerless}.jsonl`), "utf-8"), headerlessBefore);
  } finally {
    tmp.cleanup();
  }
});

test("reconcileOrphans tolerates a torn tail and skips an unreadable entry fail-soft", () => {
  const tmp = tmpdir("tb-subcontrols-orphan3-");
  try {
    const store = new SubagentStore(path.join(tmp.root, "subagents"));
    const torn = "sub-dddddddddddddddd";
    const file = writeChildLog(store.directory, torn, [
      { type: "meta", id: torn, parent_session: "p.jsonl", label: "Torn", role: "junior", model: "m", task: "t", started_at: 1 },
    ]);
    fs.appendFileSync(file, '{"type":"message","role":"us', "utf-8");
    // A directory with a log-like name is unreadable: it is skipped, not fatal.
    fs.mkdirSync(path.join(store.directory, "sub-eeeeeeeeeeeeeeee.jsonl"));
    const valid = "sub-ffffffffffffffff";
    writeChildLog(store.directory, valid, [
      { type: "meta", id: valid, parent_session: "p.jsonl", label: "Valid", role: "junior", model: "m", task: "t", started_at: 1 },
    ]);
    assert.equal(store.reconcileOrphans(), 2);
    assert.equal(logRows(store, torn).filter((row) => row.type === "end").length, 1);
    assert.equal(logRows(store, valid).filter((row) => row.type === "end").length, 1);
  } finally {
    tmp.cleanup();
  }
});

// ---------------------------------------------------------------------------
// serve: operator interrupt route + startup reconciliation
// ---------------------------------------------------------------------------

interface RunningServer {
  base: string;
  handle: ServerHandle;
  dir: string;
  sessionsDir: string;
  close(): Promise<void>;
}

async function startServer(options: ServerOptions = {}): Promise<RunningServer> {
  const tmp = tmpdir("tb-subcontrols-serve-");
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
    sessionsDir,
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

/**
 * A scripted OpenAI-compatible helper route: the first call asks for one
 * workspace write (which parks), the call after its tool result reports. The
 * interrupt test stops the child at the parked write, so the second call never
 * happens there.
 */
async function startHelperModel(): Promise<{ baseUrl: string; close(): Promise<void> }> {
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
      const content = hasToolResult ? "Wrote e2e-helper.txt." : "";
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

async function configureHelper(
  srv: RunningServer,
  model: { baseUrl: string },
): Promise<void> {
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
  const ws = await post(srv.base, "/api/workspaces", { path: root, name: "e2e-helper" });
  assert.equal(ws.status, 201);
  return String(ws.body.id);
}

async function startRun(
  srv: RunningServer,
  workspaceId: string,
  session: string,
): Promise<string> {
  const started = await post(srv.base, "/api/runs", {
    task: "Do the scripted E2E task",
    mode: "consult",
    provider: "mock",
    workspace_id: workspaceId,
    session,
  });
  assert.equal(started.status, 202);
  return String(started.body.run_id);
}

test("serve: interrupt cancels only the helper, the parent run still completes", async () => {
  const model = await startHelperModel();
  const srv = await startServer({
    providerOverrides: {
      senior: new RecordingSenior([
        { tool: SUBAGENT_TOOL_NAME, args: { task: "Write the helper note." } },
      ]),
      junior: new MockProvider(),
    },
  });
  const wsDir = tmpdir("tb-subcontrols-serve-ws-");
  try {
    await configureHelper(srv, model);
    const wsId = await registerWorkspace(srv, wsDir.root);
    const runId = await startRun(srv, wsId, "controls-interrupt");
    const events = await sseEvents(
      srv.base,
      `/api/runs/${runId}/events?after=0`,
      (all) => all.some((event) => event.type === "approval_requested"),
      15000,
    );
    const requested = events.find((event) => event.type === "approval_requested") as AnyRecord;
    assert.ok(requested);
    const childId = String(requested.subagent_id);
    assert.match(childId, /^sub-[a-f0-9]{8,32}$/);

    const first = await post(srv.base, `/api/subagents/${childId}/interrupt`);
    assert.equal(first.status, 200);
    assert.equal(first.body.status, "interrupting");

    const rest = await runUntilEnd(srv.base, runId, events.length);
    const all = [...events, ...rest];
    assert.equal(rest.at(-1)?.type, "run_end");
    // R1 over HTTP: stopping the helper never stops the parent run.
    assert.equal(rest.at(-1)?.status, "completed");
    const completedIndex = all.findIndex((event) => event.type === "subagent_completed");
    assert.ok(completedIndex >= 0);
    const completed = all[completedIndex] as AnyRecord;
    assert.equal(completed.status, "cancelled");
    assert.equal(completed.cancelled_by, "operator");
    assert.ok(completedIndex < all.findIndex((event) => event.type === "run_end"));
    const resolved = all.find(
      (event) =>
        event.type === "approval_resolved" && event.approval_id === requested.approval_id,
    ) as AnyRecord;
    assert.equal(resolved.reason, "interrupted");
    assert.equal(resolved.subagent_id, childId);
    assert.equal(fs.existsSync(path.join(wsDir.root, "e2e-helper.txt")), false);

    // The drawer's reload reflects the durable terminal row.
    const detail = await get(srv.base, `/api/subagents/${childId}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.subagent.status, "cancelled");
    assert.equal(detail.body.subagent.error, "interrupted by the operator");

    // Idempotent for a settled child; 404 for an unknown or malformed id.
    const second = await post(srv.base, `/api/subagents/${childId}/interrupt`);
    assert.equal(second.status, 200);
    assert.equal(second.body.status, "already_finished");
    const unknown = await post(srv.base, "/api/subagents/sub-0000000000000000/interrupt");
    assert.equal(unknown.status, 404);
    const malformed = await post(srv.base, "/api/subagents/not-an-id/interrupt");
    assert.equal(malformed.status, 404);

    const pending = await get(srv.base, `/api/runs/${runId}/approvals`);
    assert.deepEqual(pending.body.pending, []);

    // The sidecar (what a reload replays) carries the cause too.
    const sidecar = path.join(srv.dir, "runtime", "controls-interrupt.jsonl.events.jsonl");
    const persisted = fs
      .readFileSync(sidecar, "utf-8")
      .split(/\r?\n/)
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as AnyRecord);
    assert.equal(
      persisted.find((event) => event.type === "subagent_completed")?.cancelled_by,
      "operator",
    );
  } finally {
    await srv.close();
    await model.close();
    wsDir.cleanup();
  }
});

test("serve: startup reconciliation turns an orphaned child log into cancelled/restart", async () => {
  const srv = await startServer();
  const srvDir = srv.sessionsDir;
  try {
    const id = "sub-1234567890abcdef";
    const subdir = path.join(srvDir, "subagents");
    fs.mkdirSync(subdir, { recursive: true });
    const logFile = path.join(subdir, `${id}.jsonl`);
    fs.writeFileSync(
      logFile,
      [
        {
          type: "meta",
          id,
          parent_session: "orphan-parent.jsonl",
          label: "Orphaned helper",
          role: "junior",
          model: "m",
          task: "finish before the crash",
          started_at: 1,
        },
        { type: "message", role: "user", text: "finish before the crash", at: 2 },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n") + "\n",
      "utf-8",
    );
    await srv.handle.close();

    const second = await startServer({ sessionsDir: srvDir, webDist: null });
    try {
      const detail = await get(second.base, `/api/subagents/${id}`);
      assert.equal(detail.status, 200);
      assert.equal(detail.body.subagent.status, "cancelled");
      assert.equal(
        detail.body.subagent.error,
        "backend restarted before the helper finished",
      );
      const rows = logRows(new SubagentStore(subdir), id);
      const ends = rows.filter((row) => row.type === "end");
      assert.equal(ends.length, 1);
      assert.equal(ends[0]?.cancelled_by, "restart");
    } finally {
      await second.handle.close();
    }

    // Idempotent: a third start appends nothing to the already-reconciled log.
    const third = await startServer({ sessionsDir: srvDir, webDist: null });
    try {
      const rows = logRows(new SubagentStore(subdir), id);
      assert.equal(rows.filter((row) => row.type === "end").length, 1);
    } finally {
      await third.close();
    }
  } finally {
    try {
      await srv.close();
    } catch {
      // the handle was already closed above; cleanup is still owed
    }
  }
});
