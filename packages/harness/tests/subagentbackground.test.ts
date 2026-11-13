/**
 * Optional background children and the model-facing control surface (slice B).
 *
 * Covers the eleven required cases from the approved design (§10 "Slice B"):
 * opt-in `subagent({background:true})` that returns `started` before the child
 * settles, the four Senior-only tools (`list_agents`, `send_message`,
 * `interrupt_agent`, `subagent_report`) with their exact shapes and bounds, the
 * run-end cancellation (cancelled + `cancelled_by:"parent_run"` BEFORE the run
 * settles, bounded by the shutdown grace), the `maxActive` and control-call
 * budgets, the child-belt exclusion, and the golden sync fixture captured on
 * `main` before this slice (the completed sync tool result and the `subagent_*`
 * event sequence must stay byte-identical).
 *
 * Hermetic: in-process scripted/deferred providers, temp dirs, no network.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { resolveConfig } from "../src/config.ts";
import { SharedContext, type ChatMessage } from "../src/context.ts";
import { TwoBrothersHarness } from "../src/harness.ts";
import {
  MockProvider,
  ProviderAbortError,
  type Provider,
  type Tool,
  type ToolChatOptions,
  type ToolChatResponse,
} from "../src/provider.ts";
import { RunManager, type RunJob } from "../src/runtime.ts";
import { SessionStore } from "../src/session.ts";
import {
  INTERRUPT_AGENT_TOOL_NAME,
  LIST_AGENTS_TOOL_NAME,
  SEND_MESSAGE_TOOL_NAME,
  SUBAGENT_BACKGROUND_NOTE,
  SUBAGENT_CONTROL_CALL_MAX_PER_RUN,
  SUBAGENT_DEFAULT_MAX_ACTIVE,
  SUBAGENT_FOLLOWUP_QUEUE_MAX,
  SUBAGENT_REPORT_TOOL_NAME,
  SUBAGENT_RESULT_MAX_CHARS,
  SUBAGENT_SHUTDOWN_GRACE_MS,
  SUBAGENT_TOOL_NAME,
  isSubagentId,
  SubagentStore,
  type SubagentControlHandle,
  type SubagentControlSink,
} from "../src/subagent.ts";

type AnyRecord = Record<string, any>;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function tmpdir(prefix: string): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** Work mode gives the Senior ONE tool window (the verify loop), so a scripted
 *  sequence is consumed in order and in one node. */
function workConfig() {
  return resolveConfig({ provider: "mock", mode: "work" });
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

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
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

function metaRow(store: SubagentStore, id: string): AnyRecord | undefined {
  return logRows(store, id).find((row) => row.type === "meta");
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

function subagentTypes(events: AnyRecord[]): string[] {
  return events
    .filter((event) => String(event.type).startsWith("subagent_"))
    .map((event) => String(event.type));
}

/**
 * The exact normalization used to capture the golden fixture (see
 * `.tmp/capture-golden.ts` on the pre-slice-B tree): the random child id and the
 * wall-clock duration are the only volatile fields.
 */
function normalizeToolResult(raw: string): string {
  return raw
    .replace(/("subagent_id":)"sub-[a-f0-9]+"/, '$1"sub-GOLDEN"')
    .replace(/("duration_ms":)\d+/, (_match, prefix: string) => `${prefix}0`);
}

let callSeq = 0;

function response(
  ...calls: Array<{ name: string; args: Record<string, unknown> }>
): ToolChatResponse {
  return {
    content: "",
    toolCalls: calls.map((call) => ({
      id: `senior-call-${(callSeq += 1)}`,
      name: call.name,
      args: call.args,
    })),
  };
}

type Step = (messages: ChatMessage[]) => ToolChatResponse | Promise<ToolChatResponse>;

/**
 * The Senior's provider: a handler queue drives the tool window, and once it is
 * empty the plain mock payload keeps the remaining nodes deterministic.
 */
class ScriptedSenior extends MockProvider {
  seen: ChatMessage[][] = [];
  private readonly script: Step[] = [];

  step(next: Step): void {
    this.script.push(next);
  }

  override async chatWithTools(
    messages: ChatMessage[],
    tools: Tool[],
    options: ToolChatOptions = {},
  ): Promise<ToolChatResponse> {
    this.seen.push(messages.map((message) => ({ ...message })));
    const next = this.script.shift();
    if (next !== undefined) return next(messages);
    return super.chatWithTools(messages, tools, options);
  }
}

/**
 * Parse one model-facing tool result. The advisory repeat guard may append its
 * reminder after a blank line once identical calls repeat; the JSON payload
 * before it is still the tool's own bytes.
 */
function parseToolPayload(content: string): AnyRecord | null {
  try {
    return JSON.parse(content) as AnyRecord;
  } catch {
    const split = content.indexOf("\n\n");
    if (split <= 0) return null;
    try {
      return JSON.parse(content.slice(0, split)) as AnyRecord;
    } catch {
      return null;
    }
  }
}

/** Every tool result the Senior's provider actually saw, in first-seen order. */
function toolResults(senior: ScriptedSenior): AnyRecord[] {
  const seen = new Map<string, AnyRecord>();
  for (const messages of senior.seen) {
    for (const message of messages) {
      if (message.role !== "tool") continue;
      const key = String(message.toolCallId ?? "");
      if (key === "" || seen.has(key)) continue;
      const payload = parseToolPayload(String(message.content));
      if (payload !== null) seen.set(key, payload);
    }
  }
  return [...seen.values()];
}

function byTool(senior: ScriptedSenior, tool: string): AnyRecord[] {
  return toolResults(senior).filter((payload) => payload.tool === tool);
}

/** A child with a fixed answer and no usage tracker (the golden scenario). */
class FixedChild implements Provider {
  async chat(): Promise<string> {
    return "The notes say hello.";
  }
}

/** A child that never answers until the test resolves it. */
class DeferredChild implements Provider {
  calls = 0;
  private readonly answer = deferred<string>();

  async chat(
    _messages: ChatMessage[],
    _kind?: string,
    signal?: AbortSignal,
  ): Promise<string> {
    this.calls += 1;
    if (signal?.aborted) throw new ProviderAbortError();
    const aborted = new Promise<never>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new ProviderAbortError()), {
        once: true,
      });
    });
    return await Promise.race([this.answer.promise, aborted]);
  }

  finish(text: string): void {
    this.answer.resolve(text);
  }
}

/** A child that rejects only when its composed signal aborts. */
class AbortAwareChild implements Provider {
  calls = 0;

  async chat(
    _messages: ChatMessage[],
    _kind?: string,
    signal?: AbortSignal,
  ): Promise<string> {
    this.calls += 1;
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

/** A child that ignores the abort entirely (the bounded-grace case). */
class StuckChild implements Provider {
  calls = 0;

  async chat(): Promise<string> {
    this.calls += 1;
    return new Promise<string>(() => {
      // never settles: the reap must still emit one terminal event in time
    });
  }
}

/** A child that records every tool belt it was offered. */
class RecordingChild extends MockProvider {
  belts: string[][] = [];

  override async chatWithTools(
    messages: ChatMessage[],
    tools: Tool[],
    options: ToolChatOptions = {},
  ): Promise<ToolChatResponse> {
    this.belts.push(tools.map((tool) => tool.name));
    return super.chatWithTools(messages, tools, options);
  }
}

/** A child scripted to call one tool then answer (the follow-up delivery case). */
class GatedChild extends MockProvider {
  calls: ChatMessage[][] = [];
  private readonly script: Array<
    { tool: string; args: Record<string, unknown> } | { text: string }
  >;

  constructor(
    script: Array<{ tool: string; args: Record<string, unknown> } | { text: string }>,
  ) {
    super();
    this.script = script;
  }

  override async chatWithTools(
    messages: ChatMessage[],
    _tools: Tool[],
  ): Promise<ToolChatResponse> {
    this.calls.push(messages.map((message) => ({ ...message })));
    const next = this.script[Math.min(this.calls.length - 1, this.script.length - 1)]!;
    if ("text" in next) return { content: next.text, toolCalls: [] };
    return {
      content: "",
      toolCalls: [{ id: `child-call-${this.calls.length}`, name: next.tool, args: next.args }],
    };
  }
}

function fakeReadTool(execute: () => string | Promise<string>): Tool {
  return {
    name: "workspace_read_file",
    description: "Read one workspace file.",
    parameters: { type: "object", properties: { path: { type: "string" } } },
    execute: () => execute(),
  };
}

const FORBIDDEN_CHILD_TOOLS = [
  SUBAGENT_TOOL_NAME,
  LIST_AGENTS_TOOL_NAME,
  SEND_MESSAGE_TOOL_NAME,
  INTERRUPT_AGENT_TOOL_NAME,
  SUBAGENT_REPORT_TOOL_NAME,
];

// ---------------------------------------------------------------------------
// 1. background returns started before the child settles; the parent proceeds
// ---------------------------------------------------------------------------

test("background:true returns started before the child settles and the parent's next step runs while it works", async () => {
  const tmp = tmpdir("tb-subbackground-started-");
  try {
    const store = new SubagentStore(path.join(tmp.root, "subagents"));
    const child = new DeferredChild();
    const senior = new ScriptedSenior();
    let childId = "";
    const sink = testSink((handle) => {
      childId = handle.id;
    });
    senior.step(() =>
      response({
        name: SUBAGENT_TOOL_NAME,
        args: { task: "Inspect the notes.", label: "Notes", background: true },
      }),
    );
    // The next provider call happens while the child is still waiting: its
    // list_agents result must show a running helper.
    senior.step(() => response({ name: LIST_AGENTS_TOOL_NAME, args: {} }));
    senior.step(async () => {
      child.finish("The notes say hello.");
      await waitFor(() => sink.handles[0]!.status() !== "running", "the child to settle");
      return response({ name: SUBAGENT_REPORT_TOOL_NAME, args: { agent_id: childId } });
    });

    const harness = new TwoBrothersHarness(workConfig(), {
      senior,
      junior: new MockProvider(),
      subagents: {
        store,
        parentSession: "parent.jsonl",
        providerFactory: () => child,
        controls: sink,
      },
    });
    const result = await harness.run("Background work", parentContext(tmp.root));
    assert.equal(result.cancelled, false);
    assert.equal(sink.handles.length, 1);
    const handle = sink.handles[0]!;
    assert.equal(childId, handle.id);
    assert.equal(handle.background, true);

    // The spawn answered BEFORE the child settled, with the honest note.
    const spawn = byTool(senior, SUBAGENT_TOOL_NAME)[0]!;
    assert.equal(spawn.status, "started");
    assert.equal(spawn.background, true);
    assert.equal(spawn.note, SUBAGENT_BACKGROUND_NOTE);
    assert.match(String(spawn.subagent_id), /^sub-[a-f0-9]+$/);
    assert.equal("report" in spawn, false, "a background spawn never carries a report");

    // The parent really continued while the child ran.
    const listed = byTool(senior, LIST_AGENTS_TOOL_NAME)[0]!;
    assert.equal(listed.total, 1);
    assert.equal(listed.running, 1);
    assert.equal(listed.agents[0].status, "running");
    assert.equal(listed.agents[0].background, true);
    assert.equal(child.calls, 1, "the deferred child had not answered yet");

    // After the child settled, subagent_report carries the full report.
    const report = byTool(senior, SUBAGENT_REPORT_TOOL_NAME)[0]!;
    assert.equal(report.status, "completed");
    assert.equal(report.report, "The notes say hello.");
    assert.equal(report.background, true);
    assert.equal(report.subagent_id, handle.id);
    // The report never reached the parent by itself: only this tool result holds it.
    assert.equal(
      result.messages.some((event) => JSON.stringify(event).includes("The notes say hello.")),
      false,
    );
  } finally {
    tmp.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 2. list_agents: shape, bounds, no task text, reported flag
// ---------------------------------------------------------------------------

test("list_agents returns the bounded helper rows without task text and tracks the reported flag", async () => {
  const tmp = tmpdir("tb-subbackground-list-");
  try {
    const store = new SubagentStore(path.join(tmp.root, "subagents"));
    const sink = testSink();
    const quick = new MockProvider([{ text: "Quick helper done." }]);
    const slow = new DeferredChild();
    const providers = [quick, slow];
    const senior = new ScriptedSenior();
    let quickId = "";
    let slowId = "";

    senior.step(() =>
      response(
        {
          name: SUBAGENT_TOOL_NAME,
          args: {
            task: "TASK-SECRET-MARKER quick",
            label: "Quick",
            background: true,
          },
        },
        {
          name: SUBAGENT_TOOL_NAME,
          args: { task: "TASK-SECRET-MARKER slow", label: "Slow", background: true },
        },
      ),
    );
    senior.step(async () => {
      quickId = sink.handles[0]!.id;
      slowId = sink.handles[1]!.id;
      await waitFor(() => sink.handles[0]!.status() !== "running", "the quick child to settle");
      return response({ name: LIST_AGENTS_TOOL_NAME, args: {} });
    });
    senior.step(() =>
      response({ name: SUBAGENT_REPORT_TOOL_NAME, args: { agent_id: quickId } }),
    );
    senior.step(() => response({ name: LIST_AGENTS_TOOL_NAME, args: {} }));

    const harness = new TwoBrothersHarness(workConfig(), {
      senior,
      junior: new MockProvider(),
      subagents: {
        store,
        parentSession: "parent.jsonl",
        providerFactory: (role: "senior" | "junior") => providers.shift() ?? new DeferredChild(),
        controls: sink,
      },
    });
    const result = await harness.run("List helpers", parentContext(tmp.root));
    assert.equal(result.cancelled, false);

    const lists = byTool(senior, LIST_AGENTS_TOOL_NAME);
    assert.equal(lists.length, 2);
    const first = lists[0]!;
    assert.equal(first.scope, "helpers");
    assert.equal(first.total, 2);
    assert.equal(first.running, 1);
    assert.deepEqual(first.limits, {
      max_per_run: 8,
      max_active: SUBAGENT_DEFAULT_MAX_ACTIVE,
    });
    assert.equal(
      first.note,
      "A helper's report is only available through subagent_report.",
    );
    assert.ok(Array.isArray(first.agents) && first.agents.length <= first.limits.max_per_run);
    for (const agent of first.agents) {
      assert.ok(isSubagentId(agent.id));
      assert.ok(typeof agent.label === "string" && agent.label.length <= 80);
      assert.ok(["running", "completed", "failed", "cancelled"].includes(agent.status));
      assert.equal(agent.background, true);
      assert.ok(["senior", "junior"].includes(agent.role));
      assert.equal(typeof agent.model, "string");
      assert.ok(Number.isFinite(agent.elapsed_ms) && agent.elapsed_ms >= 0);
      assert.ok(agent.last_activity === null || typeof agent.last_activity === "string");
      assert.ok(agent.last_activity === null || agent.last_activity.length <= 120);
      assert.equal(typeof agent.pending_followups, "number");
      assert.equal(typeof agent.reported, "boolean");
      // No task text and no task key: the brief stays in the child log/tree.
      assert.equal("task" in agent, false);
    }
    // The bounded list carries no brief text anywhere (no leak, no duplication).
    assert.equal(JSON.stringify(first).includes("TASK-SECRET-MARKER"), false);

    const quickRow = (payload: AnyRecord) =>
      payload.agents.find((agent: AnyRecord) => agent.id === quickId) as AnyRecord;
    assert.equal(quickRow(first).status, "completed");
    assert.equal(quickRow(first).reported, false, "not read yet");
    assert.equal(
      first.agents.find((agent: AnyRecord) => agent.id === slowId).status,
      "running",
    );

    // Reading the report flips `reported` for that helper only.
    const report = byTool(senior, SUBAGENT_REPORT_TOOL_NAME)[0]!;
    assert.equal(report.status, "completed");
    const second = lists[1]!;
    assert.equal(quickRow(second).reported, true);
    assert.equal(
      second.agents.find((agent: AnyRecord) => agent.id === slowId).reported,
      false,
    );
  } finally {
    tmp.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 3. send_message: queued -> delivered next step, finished, unknown, queue full
// ---------------------------------------------------------------------------

test("send_message queues for the next step, reports the pending count and refuses honestly", async () => {
  const tmp = tmpdir("tb-subbackground-send-");
  try {
    const store = new SubagentStore(path.join(tmp.root, "subagents"));
    const sink = testSink();
    const parked = deferred();
    const release = deferred();
    const child = new GatedChild([
      { tool: "workspace_read_file", args: { path: "notes.txt" } },
      { text: "Read the notes." },
    ]);
    const readTool = fakeReadTool(async () => {
      parked.resolve();
      await release.promise;
      return "note content";
    });
    const senior = new ScriptedSenior();
    let childId = "";
    const texts = Array.from({ length: SUBAGENT_FOLLOWUP_QUEUE_MAX }, (_, i) => `Note ${i + 1}`);

    senior.step(() =>
      response({
        name: SUBAGENT_TOOL_NAME,
        args: { task: "Read the notes.", label: "Reader", background: true },
      }),
    );
    senior.step(async () => {
      childId = sink.handles[0]!.id;
      await parked.promise;
      return response(
        ...texts.map((text) => ({
          name: SEND_MESSAGE_TOOL_NAME,
          args: { agent_id: childId, text },
        })),
        {
          name: SEND_MESSAGE_TOOL_NAME,
          args: { agent_id: childId, text: "one too many" },
        },
        {
          name: SEND_MESSAGE_TOOL_NAME,
          args: { agent_id: "sub-0000000000000000", text: "who?" },
        },
      );
    });
    senior.step(async () => {
      release.resolve();
      await waitFor(() => sink.handles[0]!.status() !== "running", "the child to settle");
      return response({
        name: SEND_MESSAGE_TOOL_NAME,
        args: { agent_id: childId, text: "after the fact" },
      });
    });

    const harness = new TwoBrothersHarness(workConfig(), {
      senior,
      junior: new MockProvider(),
      toolScopes: { shared: [readTool] },
      subagents: {
        store,
        parentSession: "parent.jsonl",
        providerFactory: () => child,
        controls: sink,
      },
    });
    const result = await harness.run("Message the helper", parentContext(tmp.root));
    assert.equal(result.cancelled, false);

    const sends = byTool(senior, SEND_MESSAGE_TOOL_NAME);
    assert.equal(sends.length, SUBAGENT_FOLLOWUP_QUEUE_MAX + 3);
    // Accepted = queued with the pending count; never "delivered".
    for (let index = 0; index < SUBAGENT_FOLLOWUP_QUEUE_MAX; index += 1) {
      assert.deepEqual(sends[index], {
        tool: SEND_MESSAGE_TOOL_NAME,
        agent_id: childId,
        status: "queued",
        pending: index + 1,
        delivered_at: "the helper's next step",
      });
    }
    const overflow = sends[SUBAGENT_FOLLOWUP_QUEUE_MAX]!;
    assert.equal(overflow.status, "error");
    assert.equal(
      overflow.error,
      `send_message: helper ${childId} has ${SUBAGENT_FOLLOWUP_QUEUE_MAX} follow-ups queued; wait for a step or interrupt it`,
    );
    const unknown = sends[SUBAGENT_FOLLOWUP_QUEUE_MAX + 1]!;
    assert.equal(unknown.status, "error");
    assert.equal(
      unknown.error,
      "send_message: unknown helper sub-0000000000000000; this run has 1 helper — call list_agents",
    );
    const settled = sends[SUBAGENT_FOLLOWUP_QUEUE_MAX + 2]!;
    assert.equal(settled.status, "error");
    assert.equal(
      settled.error,
      `send_message: helper ${childId} already completed; its report is final — call subagent_report`,
    );

    // Delivered at the child's NEXT step, as one ordinary user turn.
    assert.equal(child.calls.length, 2);
    const secondStep = child.calls[1]!;
    const last = secondStep[secondStep.length - 1]!;
    assert.equal(last.role, "user");
    assert.match(String(last.content), /^Follow-up from the Senior:\nNote 1/);
    for (const text of texts) assert.ok(String(last.content).includes(text));
    assert.equal(secondStep[secondStep.length - 2]?.role, "tool");
    // The delivery is counted on the durable end row.
    assert.deepEqual(endRow(store, childId)?.followups, {
      delivered: SUBAGENT_FOLLOWUP_QUEUE_MAX,
      dropped: 0,
    });
    // A follow-up never rides a subagent_* event or the parent's envelopes.
    assert.equal(
      result.messages.some((event) => JSON.stringify(event).includes("Note 1")),
      false,
    );
  } finally {
    tmp.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 4. interrupt_agent aborts; subagent_report afterwards is cancelled
// ---------------------------------------------------------------------------

test("interrupt_agent cancels only the helper and subagent_report shows the honest cause", async () => {
  const tmp = tmpdir("tb-subbackground-interrupt-");
  try {
    const store = new SubagentStore(path.join(tmp.root, "subagents"));
    const sink = testSink();
    const child = new AbortAwareChild();
    const senior = new ScriptedSenior();
    let childId = "";
    senior.step(() =>
      response({
        name: SUBAGENT_TOOL_NAME,
        args: { task: "Wait forever.", label: "Waiter", background: true },
      }),
    );
    senior.step(async () => {
      childId = sink.handles[0]!.id;
      await waitFor(() => child.calls > 0, "the child to start");
      return response(
        {
          name: INTERRUPT_AGENT_TOOL_NAME,
          args: { agent_id: childId, reason: "no longer needed" },
        },
        { name: INTERRUPT_AGENT_TOOL_NAME, args: { agent_id: childId } },
      );
    });
    senior.step(async () => {
      await waitFor(() => sink.handles[0]!.status() !== "running", "the child to settle");
      return response({ name: SUBAGENT_REPORT_TOOL_NAME, args: { agent_id: childId } });
    });

    const events: AnyRecord[] = [];
    const harness = new TwoBrothersHarness(workConfig(), {
      senior,
      junior: new MockProvider(),
      onEvent: (event) => events.push(event as unknown as AnyRecord),
      subagents: {
        store,
        parentSession: "parent.jsonl",
        providerFactory: () => child,
        controls: sink,
      },
    });
    const result = await harness.run("Interrupt the helper", parentContext(tmp.root));
    assert.equal(result.cancelled, false, "a child interrupt never cancels the parent");

    const interrupts = byTool(senior, INTERRUPT_AGENT_TOOL_NAME);
    assert.deepEqual(interrupts[0], {
      tool: INTERRUPT_AGENT_TOOL_NAME,
      agent_id: childId,
      from: "senior",
      status: "interrupted",
      reason: "no longer needed",
    });
    assert.deepEqual(interrupts[1], {
      tool: INTERRUPT_AGENT_TOOL_NAME,
      agent_id: childId,
      from: "senior",
      status: "already_finished",
    });

    const report = byTool(senior, SUBAGENT_REPORT_TOOL_NAME)[0]!;
    assert.equal(report.status, "cancelled");
    assert.equal(report.error, "interrupted by the Senior");
    assert.equal(report.subagent_id, childId);

    const end = endRow(store, childId);
    assert.equal(end?.status, "cancelled");
    assert.equal(end?.cancelled_by, "senior");
    assert.equal(end?.error, "interrupted by the Senior");

    const completed = events.filter(
      (event) => event.type === "subagent_completed" && event.subagent_id === childId,
    );
    assert.equal(completed.length, 1, "exactly one terminal event");
    assert.equal(completed[0]!.status, "cancelled");
    assert.equal(completed[0]!.cancelled_by, "senior");
  } finally {
    tmp.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 5. subagent_report: running is a status, completed is the full payload
// ---------------------------------------------------------------------------

test("subagent_report on a running helper is an honest status and the completed report is full and idempotent", async () => {
  const tmp = tmpdir("tb-subbackground-report-");
  try {
    const store = new SubagentStore(path.join(tmp.root, "subagents"));
    const sink = testSink();
    const release = deferred();
    const child = new DeferredChild();
    const senior = new ScriptedSenior();
    let childId = "";
    senior.step(() =>
      response({
        name: SUBAGENT_TOOL_NAME,
        args: { task: "Answer the question.", label: "Answerer", background: true },
      }),
    );
    senior.step(() => {
      childId = sink.handles[0]!.id;
      return response({ name: SUBAGENT_REPORT_TOOL_NAME, args: { agent_id: childId } });
    });
    senior.step(async () => {
      child.finish("x".repeat(SUBAGENT_RESULT_MAX_CHARS + 500));
      await waitFor(() => sink.handles[0]!.status() !== "running", "the child to settle");
      return response(
        { name: SUBAGENT_REPORT_TOOL_NAME, args: { agent_id: childId } },
        { name: SUBAGENT_REPORT_TOOL_NAME, args: { agent_id: childId } },
      );
    });

    const harness = new TwoBrothersHarness(workConfig(), {
      senior,
      junior: new MockProvider(),
      subagents: {
        store,
        parentSession: "parent.jsonl",
        providerFactory: () => child,
        controls: sink,
      },
    });
    const result = await harness.run("Report please", parentContext(tmp.root));
    assert.equal(result.cancelled, false);

    const reports = byTool(senior, SUBAGENT_REPORT_TOOL_NAME);
    assert.equal(reports.length, 3);
    const running = reports[0]!;
    assert.equal(running.tool, SUBAGENT_REPORT_TOOL_NAME);
    assert.equal(running.agent_id, childId);
    assert.equal(running.status, "running");
    assert.equal("error" in running, false, "a running helper is a status, not an error");
    assert.ok(Number.isFinite(running.elapsed_ms) && running.elapsed_ms >= 0);
    assert.equal(running.pending_followups, 0);
    assert.equal(
      running.note,
      "Not ready. Do not poll in a loop; do other work and ask again.",
    );

    const done = reports[1]!;
    assert.equal(done.tool, SUBAGENT_REPORT_TOOL_NAME);
    assert.equal(done.subagent_id, childId);
    assert.equal(done.status, "completed");
    assert.equal(done.label, "Answerer");
    assert.equal(done.role, "junior");
    assert.equal(done.background, true);
    assert.equal(typeof done.report, "string");
    assert.equal(done.report.length, SUBAGENT_RESULT_MAX_CHARS);
    assert.equal(typeof done.usage, "object");
    assert.equal(typeof done.duration_ms, "number");
    assert.equal(typeof done.tool_calls, "number");
    // Idempotent: the second terminal read returns the same payload bytes.
    assert.equal(JSON.stringify(reports[2]), JSON.stringify(done));
  } finally {
    tmp.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 6. run end reaps a running background child before the run settles
// ---------------------------------------------------------------------------

test("run end cancels a running background child, emits before the run settles, writes the end row and is grace-bounded", async () => {
  const tmp = tmpdir("tb-subbackground-reap-");
  try {
    const store = new SubagentStore(path.join(tmp.root, "subagents"));
    const sink = testSink();
    const child = new AbortAwareChild();
    const senior = new ScriptedSenior();
    let childId = "";
    senior.step(() =>
      response({
        name: SUBAGENT_TOOL_NAME,
        args: { task: "Long job.", label: "Long", background: true },
      }),
    );
    senior.step(() => {
      childId = sink.handles[0]!.id;
      return { content: "Enough for now.", toolCalls: [] };
    });

    const events: AnyRecord[] = [];
    const harness = new TwoBrothersHarness(workConfig(), {
      senior,
      junior: new MockProvider(),
      onEvent: (event) => events.push(event as unknown as AnyRecord),
      subagents: {
        store,
        parentSession: "parent.jsonl",
        providerFactory: () => child,
        controls: sink,
      },
    });
    const startedAt = Date.now();
    const result = await harness.run("Reap the helper", parentContext(tmp.root));
    const elapsed = Date.now() - startedAt;
    // The run_end emitted by the caller always follows this marker.
    events.push({ type: "run:settled", at: Date.now() });
    assert.equal(result.cancelled, false);

    const terminalIndex = events.findIndex(
      (event) => event.type === "subagent_completed" && event.subagent_id === childId,
    );
    const settledIndex = events.findIndex((event) => event.type === "run:settled");
    assert.ok(terminalIndex >= 0, "one terminal child event");
    assert.ok(terminalIndex < settledIndex, "the terminal child event precedes run_end");
    const completed = events.filter(
      (event) => event.type === "subagent_completed" && event.subagent_id === childId,
    );
    assert.equal(completed.length, 1, "exactly one terminal event (no double emit)");
    assert.equal(completed[0]!.status, "cancelled");
    assert.equal(completed[0]!.cancelled_by, "parent_run");
    assert.equal(completed[0]!.error, "cancelled when the parent run ended");
    // A child that unwinds inside the grace writes its own durable end row.
    const end = endRow(store, childId);
    assert.equal(end?.status, "cancelled");
    assert.equal(end?.cancelled_by, "parent_run");
    assert.equal(end?.error, "cancelled when the parent run ended");
    assert.ok(elapsed < SUBAGENT_SHUTDOWN_GRACE_MS + 2500, "the reap is grace-bounded");
  } finally {
    tmp.cleanup();
  }
});

test("a child that ignores the abort still gets its terminal event before the run settles, bounded by the grace", async () => {
  const tmp = tmpdir("tb-subbackground-stuck-");
  try {
    const store = new SubagentStore(path.join(tmp.root, "subagents"));
    const sink = testSink();
    const child = new StuckChild();
    const senior = new ScriptedSenior();
    let childId = "";
    senior.step(() =>
      response({
        name: SUBAGENT_TOOL_NAME,
        args: { task: "Never returns.", label: "Stuck", background: true },
      }),
    );
    senior.step(() => {
      childId = sink.handles[0]!.id;
      return { content: "Wrapping up.", toolCalls: [] };
    });

    const events: AnyRecord[] = [];
    const harness = new TwoBrothersHarness(workConfig(), {
      senior,
      junior: new MockProvider(),
      onEvent: (event) => events.push(event as unknown as AnyRecord),
      subagents: {
        store,
        parentSession: "parent.jsonl",
        providerFactory: () => child,
        controls: sink,
      },
    });
    const startedAt = Date.now();
    const result = await harness.run("Stuck helper", parentContext(tmp.root));
    const elapsed = Date.now() - startedAt;
    events.push({ type: "run:settled", at: Date.now() });
    assert.equal(result.cancelled, false);

    const terminalIndex = events.findIndex(
      (event) => event.type === "subagent_completed" && event.subagent_id === childId,
    );
    assert.ok(terminalIndex >= 0);
    assert.ok(terminalIndex < events.findIndex((event) => event.type === "run:settled"));
    const completed = events[terminalIndex]!;
    assert.equal(completed.status, "cancelled");
    assert.equal(completed.cancelled_by, "parent_run");
    // Bounded: the reap waited the grace, not the child.
    assert.ok(
      elapsed >= SUBAGENT_SHUTDOWN_GRACE_MS - 200,
      `reap waited at least the grace (${elapsed}ms)`,
    );
    assert.ok(elapsed < SUBAGENT_SHUTDOWN_GRACE_MS + 3000, `bounded (${elapsed}ms)`);
  } finally {
    tmp.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 7. RunManager.stop does the same
// ---------------------------------------------------------------------------

test("RunManager.stop cancels a running background child before run_end", async () => {
  const tmp = tmpdir("tb-subbackground-stop-");
  try {
    const store = new SubagentStore(path.join(tmp.root, "subagents"));
    const sink = testSink();
    const senior = new ScriptedSenior();
    const child = new AbortAwareChild();
    const stopGate = deferred();
    const events: AnyRecord[] = [];
    let settledMarker = -1;

    senior.step(() =>
      response({
        name: SUBAGENT_TOOL_NAME,
        args: { task: "Background job.", label: "Bg", background: true },
      }),
    );
    // Hold the Senior inside its tool window until the operator stops the run.
    senior.step(async () => {
      await stopGate.promise;
      return { content: "Stopping.", toolCalls: [] };
    });

    const job: RunJob = async (signal) => {
      const harness = new TwoBrothersHarness(workConfig(), {
        senior,
        junior: new MockProvider(),
        signal,
        onEvent: (event) => events.push(event as unknown as AnyRecord),
        subagents: {
          store,
          parentSession: "parent.jsonl",
          providerFactory: () => child,
          controls: sink,
        },
      });
      await harness.run("Stop the run.", parentContext(tmp.root));
      settledMarker = events.length;
      return { cancelled: signal.aborted, decision: {}, errors: [] };
    };

    const manager = new RunManager({ workers: 1 });
    const record = manager.submit("Stop the run.", "parent.jsonl", job);
    await waitFor(() => sink.handles.length === 1, "the child control to register");
    const childId = sink.handles[0]!.id;
    await waitFor(() => child.calls > 0, "the child to start");
    manager.stop(record.runId);
    stopGate.resolve();
    assert.equal(await manager.wait(record.runId), true);

    const completedIndex = events.findIndex(
      (event) => event.type === "subagent_completed" && event.subagent_id === childId,
    );
    assert.ok(completedIndex >= 0, "the child settled with a terminal event");
    assert.ok(completedIndex < settledMarker, "the child terminal event precedes run_end");
    const completed = events[completedIndex]!;
    assert.equal(completed.status, "cancelled");
    assert.equal(completed.cancelled_by, "parent_run");
    const end = endRow(store, childId);
    assert.equal(end?.status, "cancelled");
    assert.equal(end?.cancelled_by, "parent_run");
    // The manager's own stream ends with run_end after the child settled.
    assert.equal(record.events.at(-1)?.type, "run_end");
    assert.equal(record.status, "cancelled");
  } finally {
    tmp.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 8. maxActive across background children, 5th refuses, no cross-run leakage
// ---------------------------------------------------------------------------

test("maxActive bounds background children, the 5th spawn refuses and a later run cannot see them", async () => {
  const tmp = tmpdir("tb-subbackground-maxactive-");
  try {
    const store = new SubagentStore(path.join(tmp.root, "subagents"));
    const sink = testSink();
    const senior = new ScriptedSenior();
    const children: AbortAwareChild[] = [];
    senior.step(() =>
      response(
        ...Array.from({ length: SUBAGENT_DEFAULT_MAX_ACTIVE + 1 }, (_, index) => ({
          name: SUBAGENT_TOOL_NAME,
          args: { task: `Job ${index + 1}`, label: `Job ${index + 1}`, background: true },
        })),
      ),
    );
    senior.step(() => response({ name: LIST_AGENTS_TOOL_NAME, args: {} }));

    const harness = new TwoBrothersHarness(workConfig(), {
      senior,
      junior: new MockProvider(),
      subagents: {
        store,
        parentSession: "parent.jsonl",
        providerFactory: () => {
          const child = new AbortAwareChild();
          children.push(child);
          return child;
        },
        controls: sink,
      },
    });
    const result = await harness.run("Many helpers", parentContext(tmp.root));
    assert.equal(result.cancelled, false);

    const spawns = byTool(senior, SUBAGENT_TOOL_NAME);
    assert.equal(spawns.length, SUBAGENT_DEFAULT_MAX_ACTIVE + 1);
    for (let index = 0; index < SUBAGENT_DEFAULT_MAX_ACTIVE; index += 1) {
      assert.equal(spawns[index]!.status, "started");
    }
    const refused = spawns[SUBAGENT_DEFAULT_MAX_ACTIVE]!;
    assert.equal(refused.status, "error");
    assert.match(String(refused.error), /too many active helpers \(4\)/);
    assert.match(String(refused.error), /list_agents/);
    assert.equal(children.length, SUBAGENT_DEFAULT_MAX_ACTIVE);

    const listed = byTool(senior, LIST_AGENTS_TOOL_NAME)[0]!;
    assert.equal(listed.total, SUBAGENT_DEFAULT_MAX_ACTIVE);
    assert.equal(listed.running, SUBAGENT_DEFAULT_MAX_ACTIVE);
    // Every one of them was reaped at run end, honestly.
    for (const handle of sink.handles) {
      assert.equal(handle.status(), "cancelled");
      assert.equal(endRow(store, handle.id)?.cancelled_by, "parent_run");
    }

    // Run 2 on the same harness: the registry is per run, so it lists nothing.
    senior.step(() => response({ name: LIST_AGENTS_TOOL_NAME, args: {} }));
    const second = await harness.run("A second run", parentContext(tmp.root));
    assert.equal(second.cancelled, false);
    const lists = byTool(senior, LIST_AGENTS_TOOL_NAME);
    assert.equal(lists.length, 2);
    assert.equal(lists[1]!.total, 0);
    assert.deepEqual(lists[1]!.agents, []);
  } finally {
    tmp.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 9. control-call budget: the 41st call returns the budget error
// ---------------------------------------------------------------------------

test("the 41st helper-control call returns the budget error and no further call is served", async () => {
  const tmp = tmpdir("tb-subbackground-budget-");
  try {
    const store = new SubagentStore(path.join(tmp.root, "subagents"));
    const senior = new ScriptedSenior();
    const budget = SUBAGENT_CONTROL_CALL_MAX_PER_RUN;
    senior.step(() =>
      response(
        ...Array.from({ length: budget + 1 }, () => ({
          name: LIST_AGENTS_TOOL_NAME,
          args: {},
        })),
      ),
    );
    senior.step(() => response({ name: LIST_AGENTS_TOOL_NAME, args: {} }));

    const harness = new TwoBrothersHarness(workConfig(), {
      senior,
      junior: new MockProvider(),
      // The advisory repeat guard would append a reminder to identical calls;
      // this test asserts the exact tool result bytes instead.
      repeatToolGuard: false,
      subagents: { store, parentSession: "parent.jsonl", controls: testSink() },
    });
    const result = await harness.run("Burn the budget", parentContext(tmp.root));
    assert.equal(result.cancelled, false);

    const calls = byTool(senior, LIST_AGENTS_TOOL_NAME);
    assert.equal(calls.length, budget + 2);
    for (let index = 0; index < budget; index += 1) {
      assert.equal(calls[index]!.status, undefined, "served calls are list payloads");
      assert.equal(calls[index]!.scope, "helpers");
    }
    assert.deepEqual(calls[budget], {
      tool: LIST_AGENTS_TOOL_NAME,
      status: "error",
      error: `helper control budget reached (${budget} calls this run)`,
    });
    // The next call is still refused: the budget never resets mid-run.
    assert.deepEqual(calls[budget + 1], {
      tool: LIST_AGENTS_TOOL_NAME,
      status: "error",
      error: `helper control budget reached (${budget} calls this run)`,
    });
  } finally {
    tmp.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 10. children never get the four tools (both roles); the Junior never does
// ---------------------------------------------------------------------------

test("neither a child (either role) nor the Junior ever gets the control tools", async () => {
  const tmp = tmpdir("tb-subbackground-belt-");
  try {
    const store = new SubagentStore(path.join(tmp.root, "subagents"));
    const juniorChildren: RecordingChild[] = [];
    const seniorChildren: RecordingChild[] = [];
    const junior = new RecordingChild();
    const senior = new ScriptedSenior();
    senior.step(() =>
      response(
        {
          name: SUBAGENT_TOOL_NAME,
          args: { task: "Child as junior.", label: "J", role: "junior" },
        },
        {
          name: SUBAGENT_TOOL_NAME,
          args: { task: "Child as senior.", label: "S", role: "senior" },
        },
      ),
    );

    const harness = new TwoBrothersHarness(workConfig(), {
      senior,
      junior,
      toolScopes: { shared: [fakeReadTool(() => "content")] },
      subagents: {
        store,
        parentSession: "parent.jsonl",
        providerFactory: (role: "senior" | "junior") => {
          const child = new RecordingChild([{ text: `${role} child done.` }]);
          (role === "senior" ? seniorChildren : juniorChildren).push(child);
          return child;
        },
        controls: testSink(),
      },
    });
    const result = await harness.run("Check the belts", parentContext(tmp.root));
    assert.equal(result.cancelled, false);

    assert.equal(juniorChildren.length, 1);
    assert.equal(seniorChildren.length, 1);
    for (const child of [juniorChildren[0]!, seniorChildren[0]!]) {
      assert.equal(child.belts.length, 1);
      const belt = child.belts[0]!;
      assert.deepEqual(belt, ["workspace_read_file"], "a child gets reads only");
      for (const forbidden of FORBIDDEN_CHILD_TOOLS) {
        assert.equal(belt.includes(forbidden), false);
      }
    }
    // The Junior's own belts never carry them either.
    assert.ok(junior.belts.length > 0, "the Junior ran a tool loop");
    for (const belt of junior.belts) {
      for (const forbidden of FORBIDDEN_CHILD_TOOLS) {
        assert.equal(belt.includes(forbidden), false, `${forbidden} on the Junior belt`);
      }
    }
    // Sanity: the Senior's belt really does carry the whole helper surface.
    const seniorBelt = senior.seen
      .map((messages) => messages.find((message) => message.role === "system"))
      .map((message) => String(message?.content ?? ""))
      .join("\n");
    for (const name of FORBIDDEN_CHILD_TOOLS) {
      assert.ok(seniorBelt.includes(name), `${name} missing from the Senior prompt`);
    }
    // A control tool cannot be addressed as a child id.
    assert.equal(isSubagentId(SEND_MESSAGE_TOOL_NAME), false);
  } finally {
    tmp.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 11. GOLDEN: the completed sync tool result and event sequence are unchanged
// ---------------------------------------------------------------------------

test("GOLDEN: a completed sync child's tool result and event sequence match the pre-slice-B fixture", async () => {
  const fixture = JSON.parse(
    fs.readFileSync(new URL("./fixtures/subagent-golden-sync.json", import.meta.url), "utf-8"),
  ) as { tool_result: string; subagent_event_types: string[] };
  const tmp = tmpdir("tb-subbackground-golden-");
  try {
    const store = new SubagentStore(path.join(tmp.root, "subagents"));
    const events: AnyRecord[] = [];
    const senior = new ScriptedSenior();
    senior.step(() =>
      response({
        name: SUBAGENT_TOOL_NAME,
        args: { task: "Check the notes.", label: "Notes check" },
      }),
    );
    const harness = new TwoBrothersHarness(resolveConfig({ provider: "mock" }), {
      senior,
      junior: new MockProvider(),
      onEvent: (event) => events.push(event as unknown as AnyRecord),
      subagents: {
        store,
        parentSession: "parent.jsonl",
        providerFactory: () => new FixedChild(),
      },
    });
    // The fixture was captured on the DEFAULT mode with this exact scenario.
    const result = await harness.run("Check the notes.", parentContext(tmp.root));
    assert.equal(result.cancelled, false);

    const spawn = byTool(senior, SUBAGENT_TOOL_NAME)[0]!;
    const raw = JSON.stringify(spawn);
    assert.equal(
      normalizeToolResult(raw),
      fixture.tool_result,
      "the completed sync tool result gained/lost a key or changed a value",
    );
    assert.deepEqual(
      subagentTypes(events),
      fixture.subagent_event_types,
      "the subagent_* event sequence changed",
    );
    // No new key on the sync result (the normalizer only rewrites id/duration).
    assert.deepEqual(Object.keys(spawn), [
      "tool",
      "subagent_id",
      "label",
      "role",
      "model",
      "status",
      "report",
      "usage",
      "duration_ms",
      "tool_calls",
    ]);
    // And the durable meta row of a sync child carries no background flag.
    assert.equal("background" in (metaRow(store, String(spawn.subagent_id)) ?? {}), false);
  } finally {
    tmp.cleanup();
  }
});
