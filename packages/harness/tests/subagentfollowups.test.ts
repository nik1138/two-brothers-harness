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
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { resolveConfig } from "../src/config.ts";
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

