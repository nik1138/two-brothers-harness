/**
 * `todo_write` plan/todo function: the pure value model, the built-in tool's
 * behavior inside a work-mode cooperation run, and the additive
 * `todo_updated` runtime event's persistence.
 *
 * Adapted from DeepSeek Harness's MIT `tool-todo` package: whole-list
 * snapshots, last-write-wins, minimal `{content, status}` entries. Our model
 * boundary is deliberately tolerant (drops/coerces bad entries) instead of
 * rejecting a whole list; only a non-array argument (or nothing usable at all)
 * is reported as an error result.
 *
 * Hermetic: mock providers only, no network, no workspace.
 * Run with: node tests/run-all.ts
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { resolveConfig } from "../src/config.ts";
import { TwoBrothersHarness, type HarnessResult } from "../src/harness.ts";
import {
  MockProvider,
  type MockScriptStep,
  type Tool,
} from "../src/provider.ts";
import { RuntimeEventStore, type RuntimeEvent } from "../src/runevents.ts";
import { RunManager, type RunJob } from "../src/runtime.ts";
import {
  TODO_CONTENT_MAX_CHARS,
  TODO_MAX_ITEMS,
  TODO_STATUSES,
  TODO_TOOL_DESCRIPTION,
  TODO_TOOL_NAME,
  TODO_TOOL_PARAMETERS,
  isTodoStatus,
  sanitizeTodos,
  summarizeTodos,
  todoResultText,
  type TodoItem,
} from "../src/todos.ts";

const cfg = (extra: Record<string, unknown> = {}) =>
  resolveConfig({ provider: "mock", ...extra });

// ---------------------------------------------------------------------------
// pure value model
// ---------------------------------------------------------------------------

test("sanitizeTodos tolerates anything the model can send", () => {
  assert.deepEqual(sanitizeTodos(undefined), []);
  assert.deepEqual(sanitizeTodos(null), []);
  assert.deepEqual(sanitizeTodos("nope"), []);
  assert.deepEqual(sanitizeTodos({ todos: [] }), []);
  // invalid entries are dropped, not fatal
  assert.deepEqual(
    sanitizeTodos([
      null,
      42,
      "junk",
      [],
      { content: 42, status: "pending" },
      { content: "   ", status: "pending" },
      { content: "real task", status: "in_progress" },
      {},
    ]),
    [{ content: "real task", status: "in_progress" }],
  );
});

test("sanitizeTodos trims, collapses to one line and defaults unknown statuses", () => {
  assert.deepEqual(
    sanitizeTodos([
      { content: "  plan\n\tthe   work  ", status: "weird" },
      { content: "done thing", status: "completed" },
      { content: "active thing", status: "in_progress" },
    ]),
    [
      { content: "plan the work", status: "pending" },
      { content: "done thing", status: "completed" },
      { content: "active thing", status: "in_progress" },
    ],
  );
  // a status that is not a string at all also falls back to pending
  assert.deepEqual(sanitizeTodos([{ content: "x", status: 3 }]), [
    { content: "x", status: "pending" },
  ]);
});

test("sanitizeTodos bounds the item count and one content line", () => {
  const many = Array.from({ length: TODO_MAX_ITEMS + 12 }, (_, index) => ({
    content: `task ${index}`,
    status: "pending",
  }));
  const capped = sanitizeTodos(many);
  assert.equal(capped.length, TODO_MAX_ITEMS);
  assert.equal(capped[0].content, "task 0");
  assert.equal(capped[capped.length - 1].content, `task ${TODO_MAX_ITEMS - 1}`);

  const long = sanitizeTodos([{ content: "a".repeat(TODO_CONTENT_MAX_CHARS + 80), status: "pending" }]);
  assert.equal([...long[0].content].length, TODO_CONTENT_MAX_CHARS);
  assert.ok(long[0].content.endsWith("…"));
});

test("sanitizeTodos returns fresh entries (no aliasing of the model's argument)", () => {
  const input = [{ content: "shared", status: "pending" }];
  const sanitized = sanitizeTodos(input);
  input[0].content = "mutated";
  input[0].status = "completed";
  assert.deepEqual(sanitized, [{ content: "shared", status: "pending" }]);
});

test("summarizeTodos counts statuses and names the first current item", () => {
  const todos: TodoItem[] = [
    { content: "a", status: "completed" },
    { content: "b", status: "pending" },
    { content: "c", status: "in_progress" },
    { content: "d", status: "in_progress" },
  ];
  const summary = summarizeTodos(todos);
  assert.deepEqual(
    {
      total: summary.total,
      pending: summary.pending,
      inProgress: summary.inProgress,
      completed: summary.completed,
    },
    { total: 4, pending: 1, inProgress: 2, completed: 1 },
  );
  assert.deepEqual(summary.current, { content: "c", status: "in_progress" });

  const empty = summarizeTodos([]);
  assert.equal(empty.total, 0);
  assert.equal(empty.current, null);
});

test("todoResultText is compact and grammatical at 0/1/N", () => {
  assert.equal(todoResultText([]), "todo list updated: 0 items (0 in progress)");
  assert.equal(
    todoResultText([{ content: "only", status: "pending" }]),
    "todo list updated: 1 item (0 in progress)",
  );
  assert.equal(
    todoResultText([
      { content: "a", status: "in_progress" },
      { content: "b", status: "pending" },
    ]),
    "todo list updated: 2 items (1 in progress)",
  );
});

test("the model-facing tool schema is one required todos array", () => {
  assert.equal(TODO_TOOL_NAME, "todo_write");
  assert.ok(TODO_TOOL_DESCRIPTION.length > 0);
  const parameters = TODO_TOOL_PARAMETERS as {
    type: string;
    required: string[];
    properties: Record<string, { type: string; items: Record<string, unknown> }>;
  };
  assert.equal(parameters.type, "object");
  assert.deepEqual(parameters.required, ["todos"]);
  assert.deepEqual(Object.keys(parameters.properties), ["todos"]);
  assert.equal(parameters.properties.todos.type, "array");
  const items = parameters.properties.todos.items as {
    additionalProperties: boolean;
    required: string[];
    properties: Record<string, { type: string; enum?: string[] }>;
  };
  assert.equal(items.additionalProperties, false);
  assert.deepEqual(items.required, ["content", "status"]);
  assert.equal(items.properties.content.type, "string");
  assert.deepEqual(items.properties.status.enum, [...TODO_STATUSES]);
  // the runtime status guard agrees with the schema enum
  for (const status of TODO_STATUSES) assert.equal(isTodoStatus(status), true);
  assert.equal(isTodoStatus("doing"), false);
});

// ---------------------------------------------------------------------------
// built-in tool inside a work-mode run
// ---------------------------------------------------------------------------

function todoStep(todos: unknown): MockScriptStep {
  return { tool: TODO_TOOL_NAME, args: { todos } };
}

/** One hermetic work-mode run; returns the typed runtime events and result. */
async function workRun(
  juniorSteps: MockScriptStep[],
  options: { tools?: Tool[] } = {},
): Promise<{ events: RuntimeEvent[]; result: HarnessResult }> {
  const events: RuntimeEvent[] = [];
  const harness = new TwoBrothersHarness(cfg({ mode: "work" }), {
    junior: new MockProvider(juniorSteps),
    ...(options.tools !== undefined ? { tools: options.tools } : {}),
    onEvent: (event) => events.push(event),
  });
  const result = await harness.run("plan the migration");
  return { events, result };
}

function ofType(events: RuntimeEvent[], type: string): Array<Record<string, any>> {
  return events.filter((event) => event.type === type) as unknown as Array<Record<string, any>>;
}

function fakeTool(name: string): Tool {
  return {
    name,
    description: `fake ${name}`,
    parameters: { type: "object", properties: {} },
    execute: () => "ok",
  };
}

test("a valid call replaces the plan, emits exactly one todo_updated and returns compact text", async () => {
  const todos = [
    { content: "plan the migration", status: "in_progress" },
    { content: "write the script", status: "pending" },
    { content: "verify the result", status: "pending" },
  ];
  const { events, result } = await workRun([todoStep(todos)]);

  // The run still produces the normal work-mode exchange.
  assert.deepEqual(
    result.messages.map((message) => message.kind),
    ["message", "delegation", "deliverable", "review", "decision"],
  );

  // Exactly one additive event, emitted between the tool's started/completed
  // events (the `tool_started` emission pattern) and carrying the snapshot.
  const todoEvents = ofType(events, "todo_updated");
  assert.equal(todoEvents.length, 1);
  assert.deepEqual(todoEvents[0].todos, todos);
  const startedAt = events.findIndex((event) => event.type === "tool_started");
  const updatedAt = events.findIndex((event) => event.type === "todo_updated");
  const completedAt = events.findIndex((event) => event.type === "tool_completed");
  assert.ok(startedAt >= 0 && startedAt < updatedAt && updatedAt < completedAt);

  // The tool result is the compact human line (not a JSON payload).
  const completed = ofType(events, "tool_completed").find((event) => event.tool === TODO_TOOL_NAME);
  assert.equal(completed?.status, "ok");
  assert.equal(completed?.result, "todo list updated: 3 items (1 in progress)");
  assert.equal(completed?.actor, "junior");

  // The run keeps the latest snapshot for consumers that do not read events.
  assert.deepEqual(result.todos, todos);
});

test("last write wins: a second call replaces the run's snapshot", async () => {
  const first = [{ content: "a", status: "pending" }];
  const second = [
    { content: "a", status: "completed" },
    { content: "b", status: "in_progress" },
  ];
  const { events, result } = await workRun([todoStep(first), todoStep(second)]);

  const updates = ofType(events, "todo_updated");
  assert.equal(updates.length, 2);
  assert.deepEqual(updates[0].todos, first);
  assert.deepEqual(updates[1].todos, second, "the replay projection takes the latest write");
  assert.deepEqual(result.todos, second);
});

test("invalid arguments become a JSON error result and emit no event", async () => {
  for (const badArgs of ["nope", 42, null, [{ content: "   " }]]) {
    const { events, result } = await workRun([
      { tool: TODO_TOOL_NAME, args: { todos: badArgs } },
    ]);
    assert.equal(ofType(events, "todo_updated").length, 0, `no event for ${JSON.stringify(badArgs)}`);
    const completed = ofType(events, "tool_completed").find(
      (event) => event.tool === TODO_TOOL_NAME,
    );
    assert.equal(completed?.status, "error");
    const compact = completed?.result as Record<string, unknown>;
    assert.match(String(compact.error), /todo_write:/);
    assert.equal(result.todos, undefined, "no snapshot survives an invalid call");
    // The cooperation cycle still completes: the tool never throws.
    assert.deepEqual(
      result.messages.map((message) => message.kind),
      ["message", "delegation", "deliverable", "review", "decision"],
    );
  }
});

test("invalid entries are dropped tolerantly; valid ones still persist", async () => {
  const { events, result } = await workRun([
    todoStep([
      { content: "keep me", status: "pending" },
      { content: 7, status: "pending" },
      { content: "unknown status", status: "later" },
      null,
    ]),
  ]);
  const updates = ofType(events, "todo_updated");
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].todos, [
    { content: "keep me", status: "pending" },
    { content: "unknown status", status: "pending" },
  ]);
  assert.deepEqual(result.todos, [
    { content: "keep me", status: "pending" },
    { content: "unknown status", status: "pending" },
  ]);
});

test("an empty list is a valid clear (event with no entries, no error)", async () => {
  const { events, result } = await workRun([todoStep([])]);
  const updates = ofType(events, "todo_updated");
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].todos, []);
  const completed = ofType(events, "tool_completed").find((event) => event.tool === TODO_TOOL_NAME);
  assert.equal(completed?.status, "ok");
  assert.equal(result.todos, undefined, "an empty plan is not a snapshot");
});

test("the plan is offered to the junior belt and listed in the prompt tool section", async () => {
  const { result } = await workRun([todoStep([{ content: "x", status: "pending" }])]);
  const deliverable = result.promptAudits.find(
    (audit) => audit.role === "junior" && audit.kind === "deliverable",
  );
  assert.ok(deliverable);
  assert.ok(deliverable.tools.includes(TODO_TOOL_NAME));
});

test("the plan joins the senior verify belt when verification runs for real tools", async () => {
  const verifyTools: Tool[] = [fakeTool("workspace_read_file")];
  const { result } = await workRun([todoStep([{ content: "x", status: "pending" }])], {
    tools: verifyTools,
  });
  const verify = result.promptAudits.find(
    (audit) => audit.role === "senior" && audit.kind === "verify",
  );
  assert.ok(verify, "a read-only workspace tool still enables the verify pass");
  assert.deepEqual(verify.tools, ["workspace_read_file", TODO_TOOL_NAME]);
});

test("the plan tool alone never enables the senior verify pass (old tool-less behavior)", async () => {
  const { result } = await workRun([todoStep([{ content: "x", status: "pending" }])]);
  assert.equal(
    result.promptAudits.some((audit) => audit.role === "senior" && audit.kind === "verify"),
    false,
  );
  // delegation + junior tool-loop opening + the tool's answer turn + review +
  // decision = 5 calls: the one extra call over the old 4 is the model's own
  // tool round-trip, not a verification pass.
  assert.equal(result.usage.model_calls, 5);

  // A tool-less work run that never calls the plan tool keeps the exact old
  // budget: delegation + deliverable + review + decision = 4.
  const plain = await workRun([]);
  assert.equal(plain.result.usage.model_calls, 4);
  assert.equal(plain.result.todos, undefined);
});

test("the plan never needs an approval and never touches the workspace", async () => {
  // No workspace/broker is configured: a todo write still succeeds, because it
  // mutates only display state. (Workspace tools without a broker would deny.)
  const { events, result } = await workRun([todoStep([{ content: "no approval", status: "pending" }])]);
  assert.equal(result.errors.length, 0);
  assert.equal(ofType(events, "approval_requested").length, 0);
  const started = ofType(events, "tool_started").find((event) => event.tool === TODO_TOOL_NAME);
  assert.equal(started?.actor, "junior");
});

// ---------------------------------------------------------------------------
// additive event persistence (RunManager + sidecar, the server reload path)
// ---------------------------------------------------------------------------

test("todo_updated reaches the run sidecar with run_id/at and replays last-write-wins", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tb-todos-sidecar-"));
  try {
    const store = new RuntimeEventStore(path.join(tmp, "runtime"));
    const manager = new RunManager({ persist: store.asPersist() });
    const first = [{ content: "plan", status: "in_progress" }];
    const second = [
      { content: "plan", status: "completed" },
      { content: "ship", status: "pending" },
    ];
    const job: RunJob = async (signal, onEnvelope) => {
      const harness = new TwoBrothersHarness(cfg({ mode: "work" }), {
        junior: new MockProvider([todoStep(first), todoStep(second)]),
        signal,
        onEvent: (event) => onEnvelope(event),
      });
      const result = await harness.run("sidecar the plan");
      return {
        cancelled: result.cancelled,
        decision: result.decision,
        errors: result.errors,
        usage: result.usage,
      };
    };
    const record = manager.submit("sidecar the plan", "todo-session.jsonl", job, "work");
    assert.equal(await manager.wait(record.runId), true);
    assert.equal(record.status, "completed");

    const persisted = store
      .load("todo-session.jsonl")
      .filter((event) => event.type === "todo_updated");
    assert.equal(persisted.length, 2, "both snapshots are durable");
    for (const event of persisted) {
      assert.equal(event.run_id, record.runId);
      assert.equal(typeof event.at, "number");
    }
    // Replay rule: the last persisted snapshot is the current plan.
    assert.deepEqual(sanitizeTodos(persisted[persisted.length - 1].todos), second);
    // And the same event reached the in-memory run record verbatim.
    const inMemory = record.events.filter((event) => event.type === "todo_updated");
    assert.equal(inMemory.length, 2);
    assert.deepEqual((inMemory[1] as unknown as { todos: TodoItem[] }).todos, second);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
