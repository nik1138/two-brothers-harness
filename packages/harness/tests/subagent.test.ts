/**
 * Read-only helper subagents: the child store, the bounded runner, and the
 * Senior's model-facing tool. No network: providers are scripted in-process.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { resolveConfig } from "../src/config.ts";
import { SharedContext } from "../src/context.ts";
import { TwoBrothersHarness } from "../src/harness.ts";
import { SessionStore } from "../src/session.ts";
import {
  MockProvider,
  UsageTracker,
  type Provider,
  type Tool,
  type ToolChatOptions,
  type ToolChatResponse,
} from "../src/provider.ts";
import {
  deriveSubagentLabel,
  isSubagentId,
  newSubagentId,
  runSubagent,
  SUBAGENT_MAX_TASK_CHARS,
  SUBAGENT_SYSTEM_PROMPT,
  SUBAGENT_TOOL_NAME,
  SubagentStore,
} from "../src/subagent.ts";
import type { RuntimeEvent } from "../src/runevents.ts";

function tmpdir(): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-subagent-"));
  return {
    root,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function fakeTool(
  name: string,
  execute: (args: Record<string, unknown>) => string | Promise<string> = () => "ok",
): Tool {
  return {
    name,
    description: `fake ${name}`,
    parameters: { type: "object", properties: {} },
    execute,
  };
}

/** A MockProvider that records the exact belt each tool-loop call offered. */
class RecordingMock extends MockProvider {
  seenToolNames: string[][] = [];

  override async chatWithTools(
    messages: Parameters<MockProvider["chatWithTools"]>[0],
    tools: Tool[],
    options: ToolChatOptions = {},
  ): Promise<ToolChatResponse> {
    this.seenToolNames.push(tools.map((tool) => tool.name));
    return super.chatWithTools(messages, tools, options);
  }
}

/** First call asks for a read; second call reports. */
class ToolThenTextProvider implements Provider {
  private readonly usage = new UsageTracker();
  calls = 0;

  usageSnapshot() {
    return this.usage.snapshot();
  }

  async chat(): Promise<string> {
    this.usage.record(1, 1);
    return "plain reply";
  }

  async chatWithTools(
    _messages: Parameters<NonNullable<Provider["chatWithTools"]>>[0],
    tools: Tool[],
  ): Promise<ToolChatResponse> {
    this.calls += 1;
    this.usage.record(10, 5, 3);
    if (this.calls === 1) {
      assert.ok(tools.some((tool) => tool.name === "workspace_read_file"));
      return {
        content: "",
        toolCalls: [
          {
            id: "call-1",
            name: "workspace_read_file",
            args: { path: "notes.txt" },
          },
        ],
      };
    }
    return { content: "The file says hello.", toolCalls: [] };
  }
}

test("subagent ids are safe tokens and labels stay one line", () => {
  const id = newSubagentId();
  assert.equal(isSubagentId(id), true);
  assert.equal(isSubagentId("../../etc/passwd"), false);
  assert.equal(isSubagentId("sub-XYZ"), false);
  assert.equal(deriveSubagentLabel("  Inspect   the auth flow\nand report "), "Inspect the auth flow and report");
  assert.equal(deriveSubagentLabel("x".repeat(100)).endsWith("…"), true);
});

test("the child store round-trips meta, transcript, usage and terminal state", () => {
  const { root, cleanup } = tmpdir();
  try {
    const store = new SubagentStore(path.join(root, "subagents"));
    const id = newSubagentId();
    store.begin({
      id,
      parent_session: "parent.jsonl",
      label: "Read auth",
      role: "junior",
      model: "lfm3-1.7b",
      task: "Inspect src/auth.ts and report the exported functions.",
      started_at: 1_000,
    });
    store.append(id, {
      type: "message",
      role: "user",
      text: "Inspect src/auth.ts and report the exported functions.",
      at: 1_000,
    });
    store.append(id, {
      type: "tool",
      tool: "workspace_read_file",
      status: "completed",
      args: { path: "src/auth.ts" },
      result: "export function login() {}",
      at: 1_010,
    });
    store.append(id, {
      type: "message",
      role: "assistant",
      text: "It exports login().",
      at: 1_020,
    });
    store.finish(id, {
      status: "completed",
      ended_at: 1_030,
      result: "It exports login().",
      usage: {
        model_calls: 1,
        input_tokens: 20,
        output_tokens: 8,
        cached_tokens: 4,
        cache_write_tokens: 0,
      },
    });

    const detail = store.get(id);
    assert.ok(detail);
    assert.equal(detail.status, "completed");
    assert.equal(detail.parent_session, "parent.jsonl");
    assert.equal(detail.label, "Read auth");
    assert.equal(detail.role, "junior");
    assert.equal(detail.model, "lfm3-1.7b");
    assert.equal(detail.duration_ms, 30);
    assert.equal(detail.transcript.length, 3);
    assert.equal(detail.transcript[1]?.tool, "workspace_read_file");
    assert.equal(detail.transcript[1]?.status, "completed");
    assert.equal(detail.usage?.cached_tokens, 4);
    assert.equal(detail.last_activity?.kind, "status");
    assert.equal(detail.last_activity?.status, "completed");

    const rows = store.list("parent.jsonl");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.id, id);
    assert.equal(rows[0]?.result, "It exports login().");

    assert.equal(store.list("other.jsonl").length, 0);
    assert.equal(store.deleteForSession("parent.jsonl"), 1);
    assert.equal(store.get(id), null);
  } finally {
    cleanup();
  }
});

test("a torn child-log tail is skipped and an invalid id is never a path", () => {
  const { root, cleanup } = tmpdir();
  try {
    const directory = path.join(root, "subagents");
    const store = new SubagentStore(directory);
    const id = newSubagentId();
    store.begin({
      id,
      parent_session: "parent.jsonl",
      label: "Torn",
      role: "junior",
      model: "m",
      task: "Check the torn tail.",
      started_at: 5,
    });
    fs.appendFileSync(path.join(directory, `${id}.jsonl`), '{"type":"message"', "utf-8");
    const detail = store.get(id);
    assert.ok(detail);
    assert.equal(detail.status, "running");
    assert.equal(detail.transcript.length, 0);
    assert.equal(store.get("../../etc/passwd"), null);
  } finally {
    cleanup();
  }
});

test("the runner loops through a read-only tool and returns a bounded report", async () => {
  const { root, cleanup } = tmpdir();
  try {
    const directory = path.join(root, "subagents");
    const store = new SubagentStore(directory);
    const id = newSubagentId();
    store.begin({
      id,
      parent_session: "parent.jsonl",
      label: "Read notes",
      role: "junior",
      model: "m",
      task: "Read notes.txt.",
      started_at: 1,
    });
    const provider = new ToolThenTextProvider();
    const events: string[] = [];
    const result = await runSubagent({
      id,
      task: "Read notes.txt.",
      role: "junior",
      provider,
      tools: [fakeTool("workspace_read_file", () => "hello")],
      systemPrompt: SUBAGENT_SYSTEM_PROMPT,
      onEvent: (event) => events.push(event.kind),
      onTranscript: (entry) => store.append(id, entry),
    });
    store.finish(id, {
      status: result.status,
      ended_at: Date.now(),
      result: result.text,
      usage: result.usage,
    });
    assert.equal(result.status, "completed");
    assert.equal(result.text, "The file says hello.");
    assert.equal(result.toolCalls, 1);
    assert.equal(result.usage.model_calls, 2);
    assert.deepEqual(events, ["tool", "tool", "message", "status"]);
    const detail = store.get(id);
    assert.ok(detail);
    assert.equal(detail.status, "completed");
    assert.equal(detail.transcript.filter((entry) => entry.type === "tool").length, 2);
    assert.equal(
      detail.transcript.find((entry) => entry.type === "tool" && entry.status === "completed")
        ?.result,
      "hello",
    );
  } finally {
    cleanup();
  }
});

test("the runner reports a cancelled parent signal and a provider failure honestly", async () => {
  const abort = new AbortController();
  abort.abort();
  const cancelled = await runSubagent({
    id: newSubagentId(),
    task: "Do not start.",
    role: "junior",
    provider: new MockProvider([{ text: "never" }]),
    tools: [],
    systemPrompt: SUBAGENT_SYSTEM_PROMPT,
    signal: abort.signal,
  });
  assert.equal(cancelled.status, "cancelled");
  assert.match(cancelled.error ?? "", /stopped by operator/);

  const failing: Provider = {
    async chat() {
      throw new Error("upstream exploded");
    },
  };
  const failed = await runSubagent({
    id: newSubagentId(),
    task: "Read a file.",
    role: "junior",
    provider: failing,
    tools: [],
    systemPrompt: SUBAGENT_SYSTEM_PROMPT,
  });
  assert.equal(failed.status, "failed");
  assert.match(failed.error ?? "", /upstream exploded/);
});

test("the Senior's subagent tool runs one isolated read-only child and reports it", async () => {
  const { root, cleanup } = tmpdir();
  try {
    const store = new SubagentStore(path.join(root, "subagents"));
    const events: RuntimeEvent[] = [];
    const senior = new RecordingMock([
      { tool: SUBAGENT_TOOL_NAME, args: { task: "Inspect the notes file." } },
    ]);
    const junior = new MockProvider();
    const child = new RecordingMock([
      { tool: "workspace_read_file", args: { path: "notes.txt" } },
      { text: "The notes file says hello." },
    ]);
    const readTool = fakeTool("workspace_read_file", () => "hello");
    const writeTool = fakeTool("workspace_write_file", () => "should not be offered");
    const shellTool = fakeTool("workspace_run_shell", () => "should not be offered");
    const harness = new TwoBrothersHarness(resolveConfig({ provider: "mock" }), {
      senior,
      junior,
      toolScopes: {
        shared: [readTool, writeTool, shellTool],
      },
      subagents: {
        store,
        parentSession: "parent.jsonl",
        providerFactory: () => child,
      },
      onEvent: (event) => events.push(event),
    });
    const parentStore = new SessionStore(path.join(root, "parent.jsonl"));
    const result = await harness.run("Plan a migration", new SharedContext(parentStore));

    assert.equal(result.cancelled, false);
    const started = events.filter((event) => event.type === "subagent_started");
    assert.equal(started.length, 1);
    assert.equal((started[0] as { role?: string }).role, "junior");
    assert.ok(events.some((event) => event.type === "subagent_activity"));
    const completed = events.filter((event) => event.type === "subagent_completed");
    assert.equal(completed.length, 1);
    assert.equal((completed[0] as { status?: string }).status, "completed");

    const rows = store.list("parent.jsonl");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.status, "completed");
    assert.match(rows[0]?.result ?? "", /notes file says hello/);
    assert.equal(rows[0]?.usage?.model_calls, 2);
    const childDetail = store.get(rows[0]!.id);
    assert.ok(childDetail);
    assert.ok(
      childDetail.transcript.some(
        (entry) => entry.type === "tool" && entry.tool === "workspace_read_file",
      ),
    );

    // The child belt is read-only and cannot recurse.
    const childBelt = child.seenToolNames.at(-1) ?? [];
    assert.ok(childBelt.includes("workspace_read_file"));
    assert.equal(childBelt.includes("workspace_write_file"), false);
    assert.equal(childBelt.includes("workspace_run_shell"), false);
    assert.equal(childBelt.includes(SUBAGENT_TOOL_NAME), false);
    // The parent total stays the brothers' total; the child provider is fresh.
    assert.ok(result.usage.model_calls > rows[0]!.usage!.model_calls);
  } finally {
    cleanup();
  }
});

test("the subagent tool validates the task and enforces the per-run budget", async () => {
  const { root, cleanup } = tmpdir();
  try {
    const store = new SubagentStore(path.join(root, "subagents"));
    const harness = new TwoBrothersHarness(resolveConfig({ provider: "mock" }), {
      subagents: {
        store,
        parentSession: "parent.jsonl",
        maxPerRun: 1,
        providerFactory: () => new MockProvider([{ text: "ok" }]),
      },
    });
    const tool = (harness as unknown as {
      subagentTool: (state: Record<string, unknown>) => Tool;
    }).subagentTool({
      task: "x",
      mode: "consult",
      maxRounds: 1,
      ctx: new SharedContext(),
      runEvents: [],
      rounds: 0,
      lastVerdict: "accept",
      decision: {},
      errors: [],
      verifyEvidence: [],
      verifySummary: "",
      compactNow: false,
      promptAudits: [],
      approvalDenials: new Map(),
      injectedSkills: new Set(),
      todos: [],
    });
    const empty = JSON.parse(await tool.execute({ task: "   " })) as { status: string };
    assert.equal(empty.status, "error");
    const tooLong = JSON.parse(
      await tool.execute({ task: "x".repeat(SUBAGENT_MAX_TASK_CHARS + 1) }),
    ) as { status: string };
    assert.equal(tooLong.status, "error");
    const first = JSON.parse(await tool.execute({ task: "Inspect one file." })) as {
      status: string;
    };
    assert.equal(first.status, "completed");
    const second = JSON.parse(await tool.execute({ task: "Inspect another file." })) as {
      status: string;
      error: string;
    };
    assert.equal(second.status, "error");
    assert.match(second.error, /per-run limit/);
  } finally {
    cleanup();
  }
});

test("a failing child provider becomes a failed tool result, not a parent crash", async () => {
  const { root, cleanup } = tmpdir();
  try {
    const store = new SubagentStore(path.join(root, "subagents"));
    const parent = new MockProvider([
      { tool: SUBAGENT_TOOL_NAME, args: { task: "Try an impossible read." } },
    ]);
    const harness = new TwoBrothersHarness(resolveConfig({ provider: "mock" }), {
      senior: parent,
      junior: new MockProvider(),
      subagents: {
        store,
        parentSession: "parent.jsonl",
        providerFactory: () => ({
          async chat() {
            throw new Error("child endpoint unavailable");
          },
        }),
      },
    });
    const result = await harness.run("Plan a migration", new SharedContext());
    assert.equal(result.cancelled, false);
    const rows = store.list("parent.jsonl");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.status, "failed");
    assert.match(rows[0]?.error ?? "", /child endpoint unavailable/);
  } finally {
    cleanup();
  }
});
