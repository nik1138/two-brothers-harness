/**
 * Mutating helper subagents: the child workspace/permission view (step 1), the
 * child tool belt and the spawn wiring (step 2). Hermetic: temp dirs and
 * scripted brokers/providers only, no network.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { resolveConfig } from "../src/config.ts";
import { SharedContext } from "../src/context.ts";
import { TwoBrothersHarness } from "../src/harness.ts";
import {
  CallbackBroker,
  Action,
  ApprovalMode,
  Decision,
  PermissionManager,
  PermissionPolicy,
  type ApprovalBroker,
  type ApprovalRequest,
} from "../src/permissions.ts";
import {
  MockProvider,
  type MockScriptStep,
  type Tool,
  type ToolChatOptions,
  type ToolChatResponse,
} from "../src/provider.ts";
import type { RuntimeEvent } from "../src/runevents.ts";
import {
  newSubagentId,
  SUBAGENT_SYSTEM_PROMPT,
  SUBAGENT_TOOL_DESCRIPTION,
  SUBAGENT_TOOL_NAME,
  SubagentStore,
} from "../src/subagent.ts";
import { applyUndo, beginUndoCapture } from "../src/workspacehistory.ts";
import { Workspace, type WorkspaceMutationRecorder } from "../src/workspace.ts";

function tmpdir(): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-subagent-mut-"));
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

interface ChildScenario {
  root: string;
  workspace: Workspace;
  store: SubagentStore;
  requests: ApprovalRequest[];
  events: RuntimeEvent[];
}

/**
 * Run one cooperation cycle in which the Senior delegates to `children[i]`
 * (one `subagent` call per child) with a workspace bound at `mode`.
 */
async function runChildScenario(options: {
  mode: ApprovalMode;
  children: RecordingMock[];
  decide?: (request: ApprovalRequest) => Decision;
  parentSteps?: MockScriptStep[];
  root?: string;
  recorder?: WorkspaceMutationRecorder;
  toolScopes?: { shared?: Tool[]; senior?: Tool[]; junior?: Tool[] };
  spillRoot?: string;
}): Promise<ChildScenario> {
  const fixture = options.root === undefined ? tmpdir() : null;
  const root = options.root ?? fixture!.root;
  const requests: ApprovalRequest[] = [];
  const events: RuntimeEvent[] = [];
  const broker = new CallbackBroker((request) => {
    requests.push(request);
    return options.decide?.(request) ?? Decision.ALLOW;
  });
  const workspace = new Workspace(
    root,
    new PermissionManager(new PermissionPolicy(options.mode), broker),
  );
  if (options.recorder !== undefined) workspace.setMutationRecorder(options.recorder);
  const store = new SubagentStore(path.join(root, "subagents"));
  const children = [...options.children];
  const parentSteps: MockScriptStep[] =
    options.parentSteps ??
    children.map((_child, index) => ({
      tool: SUBAGENT_TOOL_NAME,
      args: { task: `Do child task ${index + 1}.` },
    }));
  const parent = new RecordingMock(parentSteps);
  const harness = new TwoBrothersHarness(resolveConfig({ provider: "mock" }), {
    senior: parent,
    junior: new MockProvider(),
    workspace,
    ...(options.toolScopes !== undefined ? { toolScopes: options.toolScopes } : {}),
    ...(options.spillRoot !== undefined ? { spill: { root: options.spillRoot } } : {}),
    subagents: {
      store,
      parentSession: "parent.jsonl",
      providerFactory: () => children.shift() ?? new MockProvider([{ text: "no more children" }]),
    },
    onEvent: (event) => events.push(event),
  });
  await harness.run("Plan a migration", new SharedContext());
  return { root, workspace, store, requests, events };
}

function childLog(store: SubagentStore): NonNullable<ReturnType<SubagentStore["get"]>> {
  const rows = store.list("parent.jsonl");
  assert.equal(rows.length > 0, true);
  const detail = store.get(rows[0]!.id);
  assert.ok(detail);
  return detail;
}

function toolResults(log: NonNullable<ReturnType<SubagentStore["get"]>>): string[] {
  return log.transcript
    .filter((entry) => entry.type === "tool" && entry.status === "completed")
    .map((entry) => (entry.type === "tool" ? entry.result ?? "" : ""));
}

function approvalStatuses(log: NonNullable<ReturnType<SubagentStore["get"]>>): string[] {
  return log.transcript
    .filter((entry) => entry.type === "approval")
    .map((entry) => (entry.type === "approval" ? entry.status : ""));
}

/** A broker that records every request and answers with a fixed decision. */
class RecordingBroker implements ApprovalBroker {
  readonly requests: ApprovalRequest[] = [];
  decision: Decision;

  constructor(decision: Decision = Decision.ALLOW) {
    this.decision = decision;
  }

  approve(request: ApprovalRequest): Decision {
    this.requests.push(request);
    return this.decision;
  }
}

test("childView tags every parked request with the child identity", async () => {
  const broker = new RecordingBroker(Decision.ALLOW);
  const parent = new PermissionManager(
    new PermissionPolicy(ApprovalMode.ASK),
    broker,
  );
  const requested: ApprovalRequest[] = [];
  const resolved: Array<{ action: string; decision: Decision }> = [];
  const child = parent.childView(
    { id: "sub-0123456789abcdef", label: "Write the notes" },
    {
      onRequest: (request) => requested.push(request),
      onResolved: (request, decision) =>
        resolved.push({ action: request.action, decision }),
    },
  );

  const decision = await child.check({ action: Action.WRITE, target: "notes.txt" });
  assert.equal(decision, Decision.ALLOW);
  assert.equal(broker.requests.length, 1);
  assert.equal(broker.requests[0]?.subagent_id, "sub-0123456789abcdef");
  assert.equal(broker.requests[0]?.subagent_label, "Write the notes");
  assert.equal(requested.length, 1);
  assert.equal(requested[0]?.subagent_id, "sub-0123456789abcdef");
  assert.deepEqual(resolved, [{ action: "write", decision: Decision.ALLOW }]);

  // A parent request is never tagged.
  await parent.check({ action: Action.WRITE, target: "notes.txt" });
  assert.equal(broker.requests[1]?.subagent_id, undefined);
});

test("childView snapshots the policy: later parent widening never reaches the child", async () => {
  const broker = new RecordingBroker(Decision.ALLOW);
  const parent = new PermissionManager(
    new PermissionPolicy(ApprovalMode.READONLY),
    broker,
  );
  const child = parent.childView({ id: "sub-1", label: "Read only child" });

  // Test-only mutation of the parent's policy object: the child keeps its
  // snapshot (readonly), so the parked broker is never consulted.
  (parent.policy as unknown as { mode: ApprovalMode }).mode = ApprovalMode.ALLOW_ALL;
  const denied = await child.check({ action: Action.WRITE, target: "a.txt" });
  assert.equal(denied, Decision.DENY);
  assert.equal(broker.requests.length, 0);
  // The parent itself now allows (its policy was mutated, its own behaviour).
  const widened = await parent.check({ action: Action.WRITE, target: "a.txt" });
  assert.equal(widened, Decision.ALLOW);

  // A legacy boolean policy (autoAllowRead=false) keeps reads asking in the
  // snapshot as well.
  const legacy = new PermissionManager(new PermissionPolicy(false), broker);
  const legacyChild = legacy.childView({ id: "sub-2", label: "Legacy child" });
  const read = await legacyChild.check({ action: Action.READ, target: "a.txt" });
  assert.equal(read, Decision.ALLOW); // broker answers
  assert.equal(broker.requests.length, 1);
});

test("childView fails closed without a parent broker and observes a throwing broker", async () => {
  const noBrokerParent = new PermissionManager(
    new PermissionPolicy(ApprovalMode.ASK),
    null,
  );
  let requests = 0;
  const orphan = noBrokerParent.childView(
    { id: "sub-3", label: "No broker" },
    {
      onRequest: () => {
        requests += 1;
      },
    },
  );
  assert.equal(
    await orphan.check({ action: Action.WRITE, target: "a.txt" }),
    Decision.DENY,
  );
  assert.equal(requests, 0);
  // Reads are still free (the policy snapshot is ask).
  assert.equal(
    await orphan.check({ action: Action.READ, target: "a.txt" }),
    Decision.ALLOW,
  );

  const resolved: Decision[] = [];
  const throwing: ApprovalBroker = {
    approve() {
      throw new Error("broker exploded");
    },
  };
  const child = new PermissionManager(
    new PermissionPolicy(ApprovalMode.ASK),
    throwing,
  ).childView(
    { id: "sub-4", label: "Throwing broker" },
    { onResolved: (_request, decision) => resolved.push(decision) },
  );
  await assert.rejects(
    child.check({ action: Action.WRITE, target: "a.txt" }),
    /broker exploded/,
  );
  assert.deepEqual(resolved, [Decision.DENY]);
});

test("Workspace.childView shares confinement, shell and the late-installed undo seam", async () => {
  const { root, cleanup } = tmpdir();
  try {
    const records: Array<{ action: string; path: string; preExists: boolean }> = [];
    const parent = new Workspace(
      root,
      new PermissionManager(new PermissionPolicy(ApprovalMode.ALLOW_ALL)),
    );
    const child = parent.childView({ id: "sub-5", label: "Writer" });
    // The recorder is installed AFTER the view exists: the shared seam must
    // still capture the child's mutation.
    parent.setMutationRecorder((record) =>
      records.push({
        action: record.action,
        path: record.path,
        preExists: record.pre.exists,
      }),
    );

    const wrote = await child.write_file("a.txt", "hello\n");
    assert.equal(wrote.status, "ok");
    assert.equal(fs.readFileSync(path.join(root, "a.txt"), "utf-8"), "hello\n");
    assert.deepEqual(records, [{ action: "write", path: "a.txt", preExists: false }]);

    assert.equal(child.root, parent.root);
    assert.equal(child.shell, parent.shell);
    const escaped = await child.write_file("../escape.txt", "nope");
    assert.equal(escaped.status, "error");
    assert.match(String(escaped.error), /escapes the workspace/);
    const sensitive = await child.write_file(".env", "secret");
    assert.equal(sensitive.status, "error");
    assert.match(String(sensitive.error), /sensitive file refused/);
    // The child view's policy is distinct from the parent's manager.
    assert.notEqual(child.permissions, parent.permissions);
    assert.notEqual(child.permissions.policy, parent.permissions.policy);
  } finally {
    cleanup();
  }
});

test("a child workspace parks on the parent broker and reports a denial as a tool result", async () => {
  const { root, cleanup } = tmpdir();
  try {
    const broker = new RecordingBroker(Decision.DENY);
    const parent = new Workspace(
      root,
      new PermissionManager(new PermissionPolicy(ApprovalMode.ASK), broker),
    );
    const child = parent.childView({ id: "sub-6", label: "Denied writer" });
    const denied = await child.write_file("blocked.txt", "nope");
    assert.equal(denied.status, "denied");
    assert.match(String(denied.error), /permission denied for write on blocked.txt/);
    assert.equal(fs.existsSync(path.join(root, "blocked.txt")), false);
    assert.equal(broker.requests.length, 1);
    assert.equal(broker.requests[0]?.subagent_id, "sub-6");
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Step 2: the workspace-bound child belt and the spawn wiring
// ---------------------------------------------------------------------------

test("a workspace-bound child gets the seven built-ins (same for both roles), never recursion/todo/plugins", async () => {
  const { root, cleanup } = tmpdir();
  try {
    const juniorChild = new RecordingMock([
      { tool: "workspace_list_dir", args: { path: "." } },
      { text: "listed" },
    ]);
    const seniorChild = new RecordingMock([
      { tool: "workspace_list_dir", args: { path: "." } },
      { text: "listed" },
    ]);
    const scenario = await runChildScenario({
      mode: ApprovalMode.ASK,
      children: [juniorChild, seniorChild],
      root,
      parentSteps: [
        { tool: SUBAGENT_TOOL_NAME, args: { task: "List the workspace.", role: "junior" } },
        { tool: SUBAGENT_TOOL_NAME, args: { task: "List the workspace.", role: "senior" } },
      ],
      toolScopes: { shared: [fakeTool("plugin_notes")] },
      spillRoot: path.join(root, "spill"),
    });
    const expected = [
      "workspace_delete_file",
      "workspace_edit_file",
      "workspace_list_dir",
      "workspace_read_file",
      "workspace_run_shell",
      "workspace_search_text",
      "workspace_write_file",
      "spill_read",
    ].sort();
    const belts = [juniorChild, seniorChild].map((child) => {
      const belt = (child.seenToolNames.at(-1) ?? []).slice().sort();
      assert.deepEqual(belt, expected);
      assert.equal(belt.includes(SUBAGENT_TOOL_NAME), false);
      assert.equal(belt.includes("todo_write"), false);
      assert.equal(belt.includes("plugin_notes"), false);
      return belt;
    });
    assert.deepEqual(belts[0], belts[1]);
  } finally {
    cleanup();
  }
});

test("ask mode: an allowed child write runs and the child log records pending + allowed", async () => {
  const { root, cleanup } = tmpdir();
  try {
    const child = new RecordingMock([
      { tool: "workspace_write_file", args: { path: "e2e.txt", content: "hello" } },
      { text: "Wrote e2e.txt." },
    ]);
    const scenario = await runChildScenario({ mode: ApprovalMode.ASK, children: [child], root });
    assert.equal(fs.readFileSync(path.join(root, "e2e.txt"), "utf-8"), "hello");
    assert.equal(scenario.requests.length, 1);
    assert.equal(scenario.requests[0]?.action, "write");
    assert.equal(scenario.requests[0]?.target, "e2e.txt");
    assert.match(String(scenario.requests[0]?.subagent_id), /^sub-[a-f0-9]{8,32}$/);
    const log = childLog(scenario.store);
    assert.deepEqual(approvalStatuses(log), ["pending", "allowed"]);
    const results = toolResults(log).map((result) => JSON.parse(result) as { status?: string });
    assert.equal(results[0]?.status, "ok");
  } finally {
    cleanup();
  }
});

test("ask mode: a denied child write leaves no file and records pending + denied", async () => {
  const { root, cleanup } = tmpdir();
  try {
    const child = new RecordingMock([
      { tool: "workspace_write_file", args: { path: "blocked.txt", content: "nope" } },
      { text: "The operator denied the write." },
    ]);
    const scenario = await runChildScenario({
      mode: ApprovalMode.ASK,
      children: [child],
      root,
      decide: () => Decision.DENY,
    });
    assert.equal(fs.existsSync(path.join(root, "blocked.txt")), false);
    const log = childLog(scenario.store);
    assert.deepEqual(approvalStatuses(log), ["pending", "denied"]);
    const results = toolResults(log).map((result) => JSON.parse(result) as { status?: string });
    assert.equal(results[0]?.status, "denied");
    assert.equal(log.status, "completed");
  } finally {
    cleanup();
  }
});

test("readonly mode denies all four child mutations without asking; reads still work", async () => {
  const { root, cleanup } = tmpdir();
  try {
    fs.writeFileSync(path.join(root, "notes.txt"), "hello notes\n", "utf-8");
    const child = new RecordingMock([
      { tool: "workspace_read_file", args: { path: "notes.txt" } },
      { tool: "workspace_write_file", args: { path: "new.txt", content: "x" } },
      { tool: "workspace_edit_file", args: { path: "notes.txt", old: "hello", new: "bye" } },
      { tool: "workspace_delete_file", args: { path: "notes.txt" } },
      { tool: "workspace_run_shell", args: { command: "echo denied" } },
      { text: "The run is read-only." },
    ]);
    const scenario = await runChildScenario({ mode: ApprovalMode.READONLY, children: [child], root });
    assert.equal(scenario.requests.length, 0);
    assert.equal(fs.existsSync(path.join(root, "new.txt")), false);
    assert.equal(fs.readFileSync(path.join(root, "notes.txt"), "utf-8"), "hello notes\n");
    const log = childLog(scenario.store);
    assert.deepEqual(approvalStatuses(log), []);
    const results = toolResults(log).map((result) => JSON.parse(result) as { status?: string });
    assert.deepEqual(
      results.map((result) => result.status),
      ["ok", "denied", "denied", "denied", "denied"],
    );
  } finally {
    cleanup();
  }
});

test("edits mode auto-allows child write/edit and parks delete/shell", async () => {
  const { root, cleanup } = tmpdir();
  try {
    const child = new RecordingMock([
      { tool: "workspace_write_file", args: { path: "e2e.txt", content: "one" } },
      { tool: "workspace_edit_file", args: { path: "e2e.txt", old: "one", new: "two" } },
      { tool: "workspace_delete_file", args: { path: "e2e.txt" } },
      { tool: "workspace_run_shell", args: { command: "echo child-shell" } },
      { text: "Done." },
    ]);
    const scenario = await runChildScenario({ mode: ApprovalMode.EDITS, children: [child], root });
    // Only delete and shell asked; write/edit were auto-allowed by the mode.
    assert.deepEqual(
      scenario.requests.map((request) => request.action),
      ["delete", "shell"],
    );
    assert.equal(fs.existsSync(path.join(root, "e2e.txt")), false);
    const log = childLog(scenario.store);
    assert.deepEqual(approvalStatuses(log), ["pending", "allowed", "pending", "allowed"]);
    const results = toolResults(log).map((result) => JSON.parse(result) as { status?: string });
    assert.deepEqual(
      results.map((result) => result.status),
      ["ok", "ok", "ok", "ok"],
    );
  } finally {
    cleanup();
  }
});

test("allow-all mode runs all four child mutations without consulting the broker", async () => {
  const { root, cleanup } = tmpdir();
  try {
    const child = new RecordingMock([
      { tool: "workspace_write_file", args: { path: "e2e.txt", content: "one" } },
      { tool: "workspace_edit_file", args: { path: "e2e.txt", old: "one", new: "two" } },
      { tool: "workspace_delete_file", args: { path: "e2e.txt" } },
      { tool: "workspace_run_shell", args: { command: "echo child-shell" } },
      { text: "Done." },
    ]);
    const scenario = await runChildScenario({ mode: ApprovalMode.ALLOW_ALL, children: [child], root });
    assert.equal(scenario.requests.length, 0);
    assert.equal(fs.existsSync(path.join(root, "e2e.txt")), false);
    const log = childLog(scenario.store);
    assert.deepEqual(approvalStatuses(log), []);
    const results = toolResults(log);
    assert.equal((JSON.parse(results[0]!) as { status?: string }).status, "ok");
    assert.equal((JSON.parse(results[3]!) as { status?: string }).status, "ok");
    assert.match(results[3]!, /child-shell/);
  } finally {
    cleanup();
  }
});

test("child mutations land in the parent run's one-net-entry undo record", async () => {
  const { root, cleanup } = tmpdir();
  try {
    const storeRoot = path.join(root, "undo");
    const capture = beginUndoCapture(storeRoot, "run-child-undo", root, { retention: false });
    const firstChild = new RecordingMock([
      { tool: "workspace_write_file", args: { path: "a.txt", content: "one\n" } },
      { tool: "workspace_write_file", args: { path: "b.txt", content: "child b" } },
      { tool: "workspace_edit_file", args: { path: "a.txt", old: "one", new: "one two" } },
      { text: "Created a.txt and b.txt." },
    ]);
    const secondChild = new RecordingMock([
      // denied: no undo entry may be recorded for it
      { tool: "workspace_write_file", args: { path: "c.txt", content: "denied" } },
      { tool: "workspace_edit_file", args: { path: "a.txt", old: "two", new: "two three" } },
      { text: "Done." },
    ]);
    const scenario = await runChildScenario({
      mode: ApprovalMode.ASK,
      children: [firstChild, secondChild],
      root,
      recorder: capture.recorder,
      decide: (request) => (request.target === "c.txt" ? Decision.DENY : Decision.ALLOW),
    });
    // A parent mutation on the same file later in the run's capture window:
    // the record still keeps ONE net entry for a.txt (earliest pre-image,
    // latest post-image).
    await scenario.workspace.write_file("a.txt", "one two three!\n");
    capture.close();
    assert.equal(capture.entryCount, 2); // a.txt (net) + b.txt; no c.txt
    assert.equal(fs.existsSync(path.join(root, "c.txt")), false);
    const undone = applyUndo(storeRoot, "run-child-undo", root);
    assert.equal(undone.applied, 2);
    // Both files were created inside the run, so undo removes them.
    assert.equal(fs.existsSync(path.join(root, "a.txt")), false);
    assert.equal(fs.existsSync(path.join(root, "b.txt")), false);
  } finally {
    cleanup();
  }
});

test("the child prompt and tool description no longer claim a read-only helper", () => {
  assert.equal(/read-only/i.test(SUBAGENT_SYSTEM_PROMPT), false);
  assert.equal(/read-only/i.test(SUBAGENT_TOOL_DESCRIPTION), false);
  assert.match(SUBAGENT_SYSTEM_PROMPT, /approv/i);
  assert.match(SUBAGENT_TOOL_DESCRIPTION, /approval/i);
});

test("the child store tolerates approval rows, unknown rows and a torn tail", () => {
  const { root, cleanup } = tmpdir();
  try {
    const directory = path.join(root, "subagents");
    const store = new SubagentStore(directory);
    const id = newSubagentId();
    store.begin({
      id,
      parent_session: "parent.jsonl",
      label: "Approver",
      role: "junior",
      model: "m",
      task: "Write a file.",
      started_at: 1,
    });
    store.append(id, {
      type: "approval",
      status: "pending",
      action: "write",
      target: "a.txt",
      at: 10,
    });
    let detail = store.get(id);
    assert.ok(detail);
    assert.equal(detail.last_activity?.status, "awaiting_approval");
    assert.equal(detail.transcript.length, 1);
    const row = detail.transcript[0];
    assert.ok(row?.type === "approval");
    assert.equal(row.target, "a.txt");
    store.append(id, {
      type: "approval",
      status: "allowed",
      action: "write",
      target: "a.txt",
      at: 20,
    });
    detail = store.get(id);
    assert.equal(detail?.last_activity?.status, "running");
    // Unknown row type and a malformed approval row are ignored; a phase-1
    // message row still parses; a torn tail is skipped.
    const file = path.join(directory, `${id}.jsonl`);
    fs.appendFileSync(file, `${JSON.stringify({ type: "future_row", x: 1 })}\n`, "utf-8");
    fs.appendFileSync(
      file,
      `${JSON.stringify({ type: "approval", status: "bogus", action: "write" })}\n`,
      "utf-8",
    );
    store.append(id, { type: "message", role: "assistant", text: "done", at: 30 });
    store.finish(id, { status: "completed", ended_at: 40, result: "done" });
    // A torn final line is skipped; the earlier complete rows (and the end row
    // written before it) still read back.
    fs.appendFileSync(file, '{"type":"message"', "utf-8");
    detail = store.get(id);
    assert.ok(detail);
    assert.equal(detail.transcript.length, 3);
    assert.equal(detail.transcript[2]?.type, "message");
    assert.equal(detail.status, "completed");
  } finally {
    cleanup();
  }
});
