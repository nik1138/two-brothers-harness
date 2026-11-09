/**
 * Advisory repeat-tool-call guard (`src/repeatguard.ts`) and its tool-loop
 * wiring (`src/harness.ts`).
 *
 * The guard counts consecutive identical calls (tool name + deep-key-sorted
 * arguments), reminds the model at 3 / 5 / 8 by default, and never blocks a
 * call. The reminder rides ONLY the model-facing tool result — runtime
 * `tool_completed`, stream `tool_result` and protocol envelopes stay the
 * tool's own output. Everything here is hermetic (mock/scripted providers).
 *
 * Run with: node tests/run-all.ts (or node --test tests/repeatguard.test.ts)
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveConfig } from "../src/config.ts";
import type { ChatMessage } from "../src/context.ts";
import { TwoBrothersHarness, type HarnessOptions } from "../src/harness.ts";
import { createHookRegistry, registerHook } from "../src/plugins.ts";
import {
  MockProvider,
  type Provider,
  type Tool,
  type ToolChatOptions,
  type ToolChatResponse,
} from "../src/provider.ts";
import {
  REPEAT_GUARD_DEFAULT_ARGUMENTS_PREVIEW_CHARS,
  REPEAT_GUARD_DEFAULT_THRESHOLDS,
  REPEAT_GUARD_ENV,
  RepeatToolGuard,
  canonicalToolArguments,
  repeatToolGuardFromEnv,
  validateRepeatThresholds,
  wildcardToolPattern,
} from "../src/repeatguard.ts";
import type { RuntimeEvent, ToolCompletedEvent } from "../src/runevents.ts";
import type { StreamEvent, ToolResultStreamEvent } from "../src/runstream.ts";

const GENTLE =
  "You are repeating the exact same tool call with identical arguments. " +
  "Carefully analyze the previous result before calling again: if the task is " +
  "not complete, try a different approach or different arguments instead of " +
  "repeating the call.";
const DETAILED_HEAD = "Repeated tool call detected:\n";
const REPEAT_MARKER = "repeating the exact same tool call";

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

test("defaults: thresholds [3, 5, 8] and a 500-character argument preview", () => {
  assert.deepEqual([...REPEAT_GUARD_DEFAULT_THRESHOLDS], [3, 5, 8]);
  assert.equal(REPEAT_GUARD_DEFAULT_ARGUMENTS_PREVIEW_CHARS, 500);
});

test("canonicalToolArguments: deep key sort, arrays keep order", () => {
  assert.equal(
    canonicalToolArguments({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: 2 } }),
    '{"a":{"c":2,"d":[3,{"y":2,"z":1}]},"b":1}',
  );
  assert.equal(
    canonicalToolArguments({ path: "notes.txt", limit: 5 }),
    canonicalToolArguments({ limit: 5, path: "notes.txt" }),
  );
  assert.equal(canonicalToolArguments([2, 1, { b: 1, a: 2 }]), '[2,1,{"a":2,"b":1}]');
  assert.equal(canonicalToolArguments(null), "null");
});

test("validateRepeatThresholds: sorted, non-empty, integers >= 2, no duplicates", () => {
  assert.deepEqual(validateRepeatThresholds([5, 2, 3]), [2, 3, 5]);
  assert.throws(() => validateRepeatThresholds([]), /must not be empty/);
  assert.throws(() => validateRepeatThresholds([1]), /integer >= 2/);
  assert.throws(() => validateRepeatThresholds([2.5]), /integer >= 2/);
  assert.throws(() => validateRepeatThresholds([3, 3]), /duplicates/);
});

test("wildcardToolPattern: only * is special, pattern is anchored", () => {
  assert.ok(wildcardToolPattern("mcp__*").test("mcp__server__tool"));
  assert.ok(!wildcardToolPattern("mcp__*").test("xmcp__server__tool"));
  assert.ok(wildcardToolPattern("a.b").test("a.b"));
  assert.ok(!wildcardToolPattern("a.b").test("axb"));
  assert.ok(wildcardToolPattern("read?").test("read?"));
  assert.ok(!wildcardToolPattern("read?").test("readx"));
});

test("guard: gentle reminder at 3, detailed at 5 and 8, silence elsewhere", () => {
  const guard = new RepeatToolGuard();
  const args = { path: "notes.txt" };
  assert.deepEqual(guard.observe("notes_read", args), { count: 1 });
  assert.deepEqual(guard.observe("notes_read", args), { count: 2 });
  const third = guard.observe("notes_read", args);
  assert.equal(third.count, 3);
  assert.equal(third.reminder, GENTLE);
  assert.equal(guard.observe("notes_read", args).reminder, undefined);
  const fifth = guard.observe("notes_read", args);
  assert.equal(fifth.count, 5);
  assert.ok(fifth.reminder!.startsWith(DETAILED_HEAD));
  assert.ok(fifth.reminder!.includes("- tool: notes_read\n"));
  assert.ok(fifth.reminder!.includes("- consecutive_calls: 5\n"));
  assert.ok(fifth.reminder!.includes('- arguments: {"path":"notes.txt"}\n'));
  assert.equal(guard.observe("notes_read", args).reminder, undefined);
  assert.equal(guard.observe("notes_read", args).reminder, undefined);
  const eighth = guard.observe("notes_read", args);
  assert.equal(eighth.count, 8);
  assert.ok(eighth.reminder!.includes("- consecutive_calls: 8\n"));
  // Past the highest threshold the chain is silent.
  assert.equal(guard.observe("notes_read", args).reminder, undefined);
});

test("guard: any different tracked call resets the chain", () => {
  const guard = new RepeatToolGuard({ thresholds: [2] });
  assert.deepEqual(guard.observe("notes_read", { path: "a" }), { count: 1 });
  assert.deepEqual(guard.observe("notes_read", { path: "b" }), { count: 1 });
  assert.equal(guard.observe("notes_write", { path: "b" }).reminder, undefined);
  const again = guard.observe("notes_write", { path: "b" });
  assert.equal(again.count, 2);
  assert.equal(again.reminder, GENTLE);
});

test("guard: argument preview is capped and marked", () => {
  const guard = new RepeatToolGuard({ thresholds: [2, 3], argumentsPreviewChars: 10 });
  const canonical = canonicalToolArguments({ text: "abcdefghijklmnop" });
  guard.observe("echo", { text: "abcdefghijklmnop" });
  guard.observe("echo", { text: "abcdefghijklmnop" });
  const detailed = guard.observe("echo", { text: "abcdefghijklmnop" }).reminder!;
  const omitted = canonical.length - 10;
  assert.ok(detailed.includes(`- arguments: ${canonical.slice(0, 10)}... (+${omitted} more chars)\n`));
  assert.ok(!detailed.includes(canonical));
});

test("guard: reminder text stays printable ASCII and single-line per field", () => {
  const guard = new RepeatToolGuard({ thresholds: [2, 3], argumentsPreviewChars: 500 });
  guard.observe("echo", { text: "héllo\nworld" });
  guard.observe("echo", { text: "héllo\nworld" });
  const detailed = guard.observe("echo", { text: "héllo\nworld" }).reminder!;
  assert.ok(detailed.includes("\\u00e9"), "non-ASCII characters are escaped");
  assert.ok(!detailed.includes("é"));
  assert.ok(detailed.includes("\\n"), "control newlines stay escaped JSON, not a broken line");
  assert.match(detailed, /^[\x20-\x7e\n]+$/);
});

test("guard: include tracks only matching tools; exclude is transparent", () => {
  const include = new RepeatToolGuard({ thresholds: [2, 3], include: ["workspace_*"] });
  assert.equal(include.observe("workspace_read", { path: "a" }).count, 1);
  assert.deepEqual(include.observe("other_tool", { path: "a" }), { count: 0 });
  const second = include.observe("workspace_read", { path: "a" });
  assert.equal(second.count, 2);
  assert.equal(second.reminder, GENTLE);
  assert.deepEqual(include.observe("other_tool", { path: "a" }), { count: 0 });
  const third = include.observe("workspace_read", { path: "a" });
  assert.equal(third.count, 3);
  assert.ok(third.reminder!.startsWith(DETAILED_HEAD));

  const exclude = new RepeatToolGuard({ thresholds: [2], exclude: ["todo_*"] });
  assert.equal(exclude.observe("workspace_read", { path: "a" }).count, 1);
  assert.deepEqual(exclude.observe("todo_write", { items: [] }), { count: 0 });
  const after = exclude.observe("workspace_read", { path: "a" });
  assert.equal(after.count, 2);
  assert.equal(after.reminder, GENTLE);
});

test("guard: reset starts a new chain", () => {
  const guard = new RepeatToolGuard({ thresholds: [2] });
  guard.observe("notes_read", { path: "a" });
  assert.equal(guard.observe("notes_read", { path: "a" }).count, 2);
  guard.reset();
  const fresh = guard.observe("notes_read", { path: "a" });
  assert.equal(fresh.count, 1);
  assert.equal(fresh.reminder, undefined);
});

test("guard: invalid constructor options fail loud", () => {
  assert.throws(() => new RepeatToolGuard({ thresholds: [] }), /must not be empty/);
  assert.throws(() => new RepeatToolGuard({ thresholds: [1] }), /integer >= 2/);
  assert.throws(() => new RepeatToolGuard({ thresholds: [3, 3] }), /duplicates/);
  assert.throws(
    () => new RepeatToolGuard({ argumentsPreviewChars: 0 }),
    /argumentsPreviewChars 0/,
  );
  assert.throws(
    () => new RepeatToolGuard({ argumentsPreviewChars: 1.5 }),
    /argumentsPreviewChars 1\.5/,
  );
});

test("repeatToolGuardFromEnv: off/0/false/no disable, unset/on keep defaults", () => {
  assert.equal(repeatToolGuardFromEnv({}), undefined);
  assert.equal(repeatToolGuardFromEnv({ [REPEAT_GUARD_ENV]: "on" }), undefined);
  assert.equal(repeatToolGuardFromEnv({ [REPEAT_GUARD_ENV]: "1" }), undefined);
  for (const value of ["off", "0", "false", "no", " OFF "]) {
    assert.equal(repeatToolGuardFromEnv({ [REPEAT_GUARD_ENV]: value }), false);
  }
});

// ---------------------------------------------------------------------------
// tool-loop wiring (scripted providers, no workspace, no network)
// ---------------------------------------------------------------------------

const cfg = (extra: Record<string, unknown> = {}) =>
  resolveConfig({ provider: "mock", mode: "consult", ...extra });

const VALID_CONSULT = JSON.stringify({
  task: "t",
  ask: "a",
  expect: "proposal",
  deadline_hint: "today",
});

const READ_RESULT = JSON.stringify({
  tool: "notes_read",
  status: "ok",
  path: "notes.txt",
  content: "unchanged result",
});

function notesReadTool(): Tool {
  return {
    name: "notes_read",
    description: "Read a notes file.",
    parameters: { type: "object", properties: { path: { type: "string" } } },
    execute: () => READ_RESULT,
  };
}

/** MockProvider that records every `chatWithTools` request's messages. */
class RecordingMockProvider extends MockProvider {
  readonly toolRequests: ChatMessage[][] = [];

  override async chatWithTools(
    messages: ChatMessage[],
    tools: Tool[],
    options: ToolChatOptions = {},
  ): Promise<ToolChatResponse> {
    this.toolRequests.push(messages.map((message) => ({ ...message })));
    return super.chatWithTools(messages, tools, options);
  }
}

interface ScenarioResult {
  senior: RecordingMockProvider;
  result: Awaited<ReturnType<TwoBrothersHarness["run"]>>;
  events: RuntimeEvent[];
  stream: StreamEvent[];
}

async function runScriptedScenario(
  steps: Array<{ tool: string; args: Record<string, unknown> } | { text: string }>,
  extraOptions: { repeatToolGuard?: false; hooks?: ReturnType<typeof createHookRegistry> } = {},
): Promise<ScenarioResult> {
  const senior = new RecordingMockProvider(steps);
  const junior: Provider = new MockProvider();
  const events: RuntimeEvent[] = [];
  const stream: StreamEvent[] = [];
  const options: HarnessOptions = {
    senior,
    junior,
    toolScopes: { senior: [notesReadTool()] },
    onEvent: (event) => events.push(event),
    onStreamEvent: (event) => stream.push(event),
  };
  if (extraOptions.repeatToolGuard === false) options.repeatToolGuard = false;
  if (extraOptions.hooks !== undefined) options.hooks = extraOptions.hooks;
  const harness = new TwoBrothersHarness(cfg(), options);
  const result = await harness.run("repeat the same read");
  return { senior, result, events, stream };
}

function toolMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((message) => message.role === "tool");
}

function completedReads(events: RuntimeEvent[]): ToolCompletedEvent[] {
  return events.filter(
    (event): event is ToolCompletedEvent =>
      event.type === "tool_completed" && event.tool === "notes_read",
  );
}

function streamedReads(stream: StreamEvent[]): ToolResultStreamEvent[] {
  return stream.filter(
    (event): event is ToolResultStreamEvent =>
      event.type === "tool_result" && event.tool === "notes_read",
  );
}

test("wiring: the third identical call gets the gentle reminder on the model-facing result only", async () => {
  const { senior, events, stream } = await runScriptedScenario([
    { tool: "notes_read", args: { path: "notes.txt", limit: 5 } },
    { tool: "notes_read", args: { limit: 5, path: "notes.txt" } },
    { tool: "notes_read", args: { path: "notes.txt", limit: 5 } },
    { text: VALID_CONSULT },
  ]);

  // The fourth request carries the whole tool conversation: the third tool
  // message is where the guard's reminder appears (key order did not matter).
  const answerRequest = senior.toolRequests[3]!;
  const tools = toolMessages(answerRequest);
  assert.equal(tools.length, 3);
  assert.equal(tools[0]!.content, READ_RESULT);
  assert.equal(tools[1]!.content, READ_RESULT);
  assert.equal(tools[2]!.content, `${READ_RESULT}\n\n${GENTLE}`);

  // Earlier requests never carry it.
  assert.equal(toolMessages(senior.toolRequests[0]!).length, 0);
  assert.equal(toolMessages(senior.toolRequests[1]!).length, 1);
  assert.equal(toolMessages(senior.toolRequests[2]!).length, 2);
  for (const request of senior.toolRequests.slice(0, 3)) {
    for (const message of toolMessages(request)) {
      assert.ok(!String(message.content).includes(REPEAT_MARKER));
    }
  }

  // The runtime and stream copies keep the tool's own compact result.
  const completed = completedReads(events);
  assert.equal(completed.length, 3);
  for (const event of completed) {
    assert.ok(!JSON.stringify(event.result).includes(REPEAT_MARKER));
  }
  const streamed = streamedReads(stream);
  assert.equal(streamed.length, 3);
  for (const event of streamed) {
    assert.ok(!(event.result ?? "").includes(REPEAT_MARKER));
  }
});

test("wiring: repeatToolGuard false leaves every tool result byte-identical", async () => {
  const steps = [
    { tool: "notes_read", args: { path: "notes.txt" } },
    { tool: "notes_read", args: { path: "notes.txt" } },
    { tool: "notes_read", args: { path: "notes.txt" } },
    { text: VALID_CONSULT },
  ] as const;
  const enabled = await runScriptedScenario([...steps]);
  const disabled = await runScriptedScenario([...steps], { repeatToolGuard: false });

  const disabledTools = toolMessages(disabled.senior.toolRequests[3]!);
  assert.deepEqual(
    disabledTools.map((message) => message.content),
    [READ_RESULT, READ_RESULT, READ_RESULT],
  );
  // Non-model-facing records are identical with the guard on and off.
  assert.deepEqual(
    completedReads(disabled.events).map((event) => event.result),
    completedReads(enabled.events).map((event) => event.result),
  );
  assert.deepEqual(
    streamedReads(disabled.stream).map((event) => event.result),
    streamedReads(enabled.stream).map((event) => event.result),
  );
});

test("wiring: unknown tool attempts count and still get the reminder", async () => {
  const { senior, events } = await runScriptedScenario([
    { tool: "notes_missing", args: { path: "notes.txt" } },
    { tool: "notes_missing", args: { path: "notes.txt" } },
    { tool: "notes_missing", args: { path: "notes.txt" } },
    { text: VALID_CONSULT },
  ]);
  const tools = toolMessages(senior.toolRequests[3]!);
  assert.equal(tools.length, 3);
  assert.equal(tools[2]!.content, `unknown tool: notes_missing\n\n${GENTLE}`);
  for (const event of events) {
    if (event.type === "tool_completed" && event.tool === "notes_missing") {
      assert.equal(event.result, "unknown tool: notes_missing");
    }
  }
});

test("wiring: denied calls count and still get the reminder", async () => {
  const hooks = createHookRegistry();
  registerHook(hooks, {
    name: "before_tool_call",
    plugin: "repeat-guard-test",
    handler: () => ({ deny: "not allowed" }),
    diagnostics: [],
  });
  const { senior, events } = await runScriptedScenario(
    [
      { tool: "notes_read", args: { path: "notes.txt" } },
      { tool: "notes_read", args: { path: "notes.txt" } },
      { tool: "notes_read", args: { path: "notes.txt" } },
      { text: VALID_CONSULT },
    ],
    { hooks },
  );
  const tools = toolMessages(senior.toolRequests[3]!);
  assert.equal(tools.length, 3);
  assert.equal(tools[2]!.content, `not allowed\n\n${GENTLE}`);
  const blocked = events.filter(
    (event): event is ToolCompletedEvent =>
      event.type === "tool_completed" && event.tool === "notes_read",
  );
  assert.equal(blocked.length, 3);
  for (const event of blocked) assert.equal(event.status, "blocked");
});
