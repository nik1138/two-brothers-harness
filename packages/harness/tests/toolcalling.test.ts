/**
 * Wave 4 lane A: tool calling for both brothers in consult-mode nodes.
 *
 * The owner rule is "senior and junior must use tools": in consult mode the
 * senior opening question, the junior proposal and the senior review may each
 * call the role's READ-ONLY belt before emitting the structured reply, while
 * work-mode behavior (the junior's mutating deliverable loop, the senior's
 * approval-brokered verify slice, the plain delegation/review/decision calls)
 * stays byte-identical. The consult belt is the role's normal belt minus the
 * workspace mutations and the display-only plan tool, and it is only offered
 * when it is non-empty AND the role's provider implements `chatWithTools` —
 * tool-less configurations keep the exact pre-tools request path.
 *
 * Everything here is hermetic: scripted fake providers, in-memory harnesses
 * and temp workspace directories. No network, no subprocesses.
 *
 * Run with: node tests/run-all.ts (or node --test tests/)
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

function removeTempDirSync(root: string): void {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
      return;
    } catch (exc) {
      const code = (exc as NodeJS.ErrnoException).code;
      if (
        attempt === 49 ||
        (code !== "EPERM" && code !== "EBUSY" && code !== "ENOTEMPTY")
      ) {
        throw exc;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}

import { resolveConfig } from "../src/config.ts";
import type { ChatMessage, ToolCall } from "../src/context.ts";
import {
  MAX_CONSULT_TOOL_ITERATIONS,
  PROMPT_SECTION_BASE,
  PROMPT_SECTION_TOOLS,
  PROMPT_SECTION_USING_TOOLS,
  WORKSPACE_MUTATION_TOOL_NAMES,
  TwoBrothersHarness,
} from "../src/harness.ts";
import { REPAIR_REQUEST_PREFIX } from "../src/payloads.ts";
import {
  MockProvider,
  type Provider,
  type Tool,
  type ToolChatOptions,
  type ToolChatResponse,
} from "../src/provider.ts";
import type { RuntimeEvent, ToolStartedEvent } from "../src/runevents.ts";
import type {
  StreamEvent,
  ToolCallStreamEvent,
  ToolResultStreamEvent,
} from "../src/runstream.ts";
import { TODO_TOOL_NAME } from "../src/todos.ts";
import { Workspace } from "../src/workspace.ts";

const cfg = (extra: Record<string, unknown> = {}) =>
  resolveConfig({ provider: "mock", mode: "consult", ...extra });

/** The strict-valid baseline reply for every structured kind a node asks for. */
const VALID: Record<string, Record<string, unknown>> = {
  consult: { task: "t", ask: "a", expect: "proposal", deadline_hint: "today" },
  proposal: { title: "P", answer: "A", rationale: "R", risks: [], confidence: 0.7, asks: [] },
  delegation: { work: "W", acceptance: ["done"], return: "deliverable", notes: "" },
  deliverable: { result: "R", artifacts: [], notes: "", confidence: 0.8 },
  review: { verdict: "accept", notes: "", points: [] },
  decision: { decision: "D", rationale: "", confidence: 0.7, dissent: null, accepted_proposals: [] },
};

function validReply(kind: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...VALID[kind], ...extra });
}

const READ_RESULT = JSON.stringify({
  tool: "workspace_read_file",
  status: "ok",
  path: "notes.txt",
  content: "hello from the workspace",
});

const LIST_RESULT = JSON.stringify({
  tool: "workspace_list_dir",
  status: "ok",
  entries: ["notes.txt"],
});

const MUTATING_TOOLS = [
  "workspace_write_file",
  "workspace_edit_file",
  "workspace_delete_file",
  "workspace_run_shell",
].sort();

function fakeTool(name: string, description = `fake ${name}`, execute?: () => string): Tool {
  return {
    name,
    description,
    parameters: { type: "object", properties: {} },
    execute: execute ?? (() => JSON.stringify({ tool: name, status: "ok" })),
  };
}

function systemOf(messages: ChatMessage[]): string {
  return messages.find((message) => message.role === "system")?.content ?? "";
}

// ---------------------------------------------------------------------------
// scripted providers (one per role; queues keyed by response kind)
// ---------------------------------------------------------------------------

/** One scripted `chatWithTools` round: tool calls and/or final text. */
interface ToolRound {
  toolCalls?: ToolCall[];
  text?: string;
}

interface RecordedCall {
  role: "senior" | "junior";
  channel: "chat" | "tools";
  kind: string;
  messages: ChatMessage[];
  tools: string[];
  system: string;
}

function copyQueues<T>(queues: Record<string, T[]> | undefined): Record<string, T[]> {
  return Object.fromEntries(
    Object.entries(queues ?? {}).map(([key, value]) => [key, [...value]]),
  );
}

/**
 * A provider that records every request and answers from per-kind scripts.
 * An empty queue answers with the strict-valid payload for the kind, so a
 * test only scripts the rounds it cares about. `chat` and `chatWithTools`
 * carry separate queues, which is what lets a test script "one tool round,
 * then a prose answer" and still see the repair re-ask's `chat` reply.
 */
class ScriptedProvider implements Provider {
  readonly role: "senior" | "junior";
  readonly calls: RecordedCall[] = [];
  private readonly toolQueues: Record<string, ToolRound[]>;
  private readonly chatQueues: Record<string, string[]>;

  constructor(
    role: "senior" | "junior",
    script: { tools?: Record<string, ToolRound[]>; chat?: Record<string, string[]> } = {},
  ) {
    this.role = role;
    this.toolQueues = copyQueues(script.tools);
    this.chatQueues = copyQueues(script.chat);
  }

  private record(
    channel: "chat" | "tools",
    kind: string,
    messages: ChatMessage[],
    tools: string[],
  ): void {
    this.calls.push({
      role: this.role,
      channel,
      kind,
      messages: messages.map((message) => ({ ...message })),
      tools,
      system: systemOf(messages),
    });
  }

  async chat(messages: ChatMessage[], responseKind = "message"): Promise<string> {
    this.record("chat", responseKind, messages, []);
    const queue = this.chatQueues[responseKind];
    if (queue !== undefined && queue.length > 0) return queue.shift()!;
    return validReply(responseKind);
  }

  async chatWithTools(
    messages: ChatMessage[],
    tools: Tool[],
    options: ToolChatOptions = {},
  ): Promise<ToolChatResponse> {
    const kind = options.responseKind ?? "deliverable";
    this.record(
      "tools",
      kind,
      messages,
      tools.map((tool) => tool.name),
    );
    const queue = this.toolQueues[kind];
    const round = queue?.shift();
    if (round === undefined) return { content: validReply(kind), toolCalls: [] };
    return { content: round.text ?? "", toolCalls: round.toolCalls ?? [] };
  }

  chatCalls(kind?: string): RecordedCall[] {
    return this.calls.filter(
      (call) => call.channel === "chat" && (kind === undefined || call.kind === kind),
    );
  }

  toolsCalls(kind?: string): RecordedCall[] {
    return this.calls.filter(
      (call) => call.channel === "tools" && (kind === undefined || call.kind === kind),
    );
  }
}

/** A text-only provider: the harness must never run a tool loop on it. */
class ChatOnlyProvider implements Provider {
  readonly calls: RecordedCall[] = [];

  async chat(messages: ChatMessage[], responseKind = "message"): Promise<string> {
    this.calls.push({
      role: "senior",
      channel: "chat",
      kind: responseKind,
      messages: messages.map((message) => ({ ...message })),
      tools: [],
      system: systemOf(messages),
    });
    return validReply(responseKind);
  }
}

/** A MockProvider that records the exact belt of every `chatWithTools` call. */
class RecordingMock extends MockProvider {
  readonly belts: string[][] = [];

  override async chatWithTools(
    messages: ChatMessage[],
    tools: Tool[],
    options: ToolChatOptions = {},
  ): Promise<ToolChatResponse> {
    this.belts.push(tools.map((tool) => tool.name));
    return super.chatWithTools(messages, tools, options);
  }
}

function toolCall(id: string, name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id, name, args };
}

function streamLabels(events: StreamEvent[]): string[] {
  return events
    .filter(
      (event): event is ToolCallStreamEvent | ToolResultStreamEvent =>
        event.type === "tool_call" || event.type === "tool_result",
    )
    .map(
      (event) =>
        `${event.type}:${event.role}:${event.tool}:${event.type === "tool_result" ? event.status : ""}`,
    );
}

function auditLabels(result: { promptAudits: Array<{ role: string; kind: string }> }): string[] {
  return result.promptAudits.map((audit) => `${audit.role}/${audit.kind}`);
}

// ---------------------------------------------------------------------------
// senior_open / junior proposal / senior review all get their read-only belts
// ---------------------------------------------------------------------------

test("consult mode: senior_open calls a read tool before its consult reply", async () => {
  const events: RuntimeEvent[] = [];
  const stream: StreamEvent[] = [];
  const read = fakeTool(
    "workspace_read_file",
    "Read a file from the workspace.",
    () => READ_RESULT,
  );
  const senior = new ScriptedProvider("senior", {
    tools: {
      consult: [
        { toolCalls: [toolCall("s-1", "workspace_read_file", { path: "notes.txt" })] },
        { text: validReply("consult", { ask: "grounded question" }) },
      ],
    },
  });
  const junior = new ScriptedProvider("junior");
  const harness = new TwoBrothersHarness(cfg(), {
    senior,
    junior,
    toolScopes: { senior: [read] },
    onEvent: (event) => events.push(event),
    onStreamEvent: (event) => stream.push(event),
  });

  const result = await harness.run("ask a grounded question");

  // the senior actually executed the read tool, with paired stream evidence
  const started = events.filter((event): event is ToolStartedEvent => event.type === "tool_started");
  assert.equal(started.length, 1);
  assert.equal(started[0].actor, "senior");
  assert.equal(started[0].tool, "workspace_read_file");
  assert.deepEqual(streamLabels(stream), [
    "tool_call:senior:workspace_read_file:",
    "tool_result:senior:workspace_read_file:ok",
  ]);

  // the belt rode the system prompt, the audit trail and the second round
  const consultCalls = senior.toolsCalls("consult");
  assert.equal(consultCalls.length, 2, "tool round, then the answer round");
  assert.deepEqual(consultCalls[0].tools, ["workspace_read_file"]);
  assert.ok(consultCalls[0].system.includes("## Available tools"));
  assert.ok(consultCalls[0].system.includes("- workspace_read_file — Read a file"));
  assert.ok(consultCalls[1].system.includes("## Using tools"));
  const toolResultMessage = consultCalls[1].messages[consultCalls[1].messages.length - 1]!;
  assert.equal(toolResultMessage.role, "tool");
  assert.equal(toolResultMessage.content, READ_RESULT, "the model sees the real result");

  const consultAudits = result.promptAudits.filter(
    (audit) => audit.role === "senior" && audit.kind === "consult",
  );
  assert.deepEqual(
    consultAudits.map((audit) => audit.tools),
    [["workspace_read_file"], ["workspace_read_file"]],
  );
  assert.deepEqual(consultAudits[0].sections, [
    PROMPT_SECTION_BASE,
    PROMPT_SECTION_TOOLS,
    PROMPT_SECTION_USING_TOOLS,
  ]);
  assert.equal(
    result.messages.find((message) => message.kind === "consult")?.payload.ask,
    "grounded question",
    "the post-tool structured reply is what the node keeps",
  );

  // the arbiter's final call stays lean by design
  const decisionAudit = result.promptAudits.find(
    (audit) => audit.role === "senior" && audit.kind === "decision",
  );
  assert.ok(decisionAudit);
  assert.deepEqual(decisionAudit.tools, []);
  assert.ok(!decisionAudit.sections.includes(PROMPT_SECTION_USING_TOOLS));
});

test("consult mode: the junior proposal may read before answering", async () => {
  const list = fakeTool("workspace_list_dir", "List a workspace directory.", () => LIST_RESULT);
  const senior = new ScriptedProvider("senior");
  const junior = new ScriptedProvider("junior", {
    tools: {
      proposal: [
        { toolCalls: [toolCall("j-1", "workspace_list_dir", { path: "." })] },
        { text: validReply("proposal", { title: "Grounded plan" }) },
      ],
    },
  });
  const harness = new TwoBrothersHarness(cfg(), {
    senior,
    junior,
    toolScopes: { junior: [list] },
  });

  const result = await harness.run("look before proposing");

  const proposalCalls = junior.toolsCalls("proposal");
  assert.equal(proposalCalls.length, 2, "tool round, then the proposal");
  assert.deepEqual(proposalCalls[0].tools, ["workspace_list_dir"]);
  assert.equal(proposalCalls[1].messages[proposalCalls[1].messages.length - 1]!.role, "tool");
  assert.deepEqual(
    result.promptAudits.filter((audit) => audit.role === "junior").map((audit) => audit.kind),
    ["proposal", "proposal"],
  );
  assert.equal(
    result.messages.find((message) => message.kind === "proposal")?.payload.title,
    "Grounded plan",
  );
  // the junior-only scope never leaks onto the senior's (empty) belt
  assert.equal(senior.toolsCalls().length, 0);
  assert.deepEqual(
    result.promptAudits.filter((audit) => audit.role === "senior").map((audit) => audit.tools),
    [[], [], []],
    "senior consult/review/decision stay tool-less when only junior tools are configured",
  );
});

test("consult mode: senior review grounds itself with the read-only belt", async () => {
  const read = fakeTool("workspace_read_file", "Read a file from the workspace.", () => READ_RESULT);
  const senior = new ScriptedProvider("senior", {
    tools: {
      review: [
        { toolCalls: [toolCall("r-1", "workspace_read_file", { path: "notes.txt" })] },
        {
          text: validReply("review", {
            verdict: "accept",
            notes: "checked the notes",
            points: ["scope is clear"],
          }),
        },
      ],
    },
  });
  const harness = new TwoBrothersHarness(cfg(), {
    senior,
    junior: new ScriptedProvider("junior"),
    toolScopes: { senior: [read] },
  });

  const result = await harness.run("review with checks");

  assert.equal(senior.toolsCalls("review").length, 2);
  const review = result.messages.find((message) => message.kind === "review")!;
  assert.equal(review.payload.verdict, "accept");
  assert.deepEqual(review.payload.points, [
    "scope is clear",
    "verify: workspace_read_file notes.txt [ok]",
  ]);
  assert.match(String(review.payload.notes), /read-only tool checks/);
});

// ---------------------------------------------------------------------------
// the senior's belt never carries a workspace mutation in a consult node
// ---------------------------------------------------------------------------

test("consult belts exclude workspace mutations; work mode keeps its documented belts", async () => {
  assert.deepEqual(
    [...WORKSPACE_MUTATION_TOOL_NAMES].sort(),
    MUTATING_TOOLS,
    "the mutation set is the four workspace built-ins",
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-toolcalling-"));
  fs.writeFileSync(path.join(root, "notes.txt"), "hello\n");
  try {
    const workspace = new Workspace(root);
    const sharedRead = fakeTool("shared_note_read", "Read a shared note.");
    const seniorOnly = fakeTool("senior_audit", "Audit a note.");
    const juniorOnly = fakeTool("junior_note", "Write a junior note.");
    const scopes = {
      shared: [sharedRead],
      senior: [seniorOnly],
      junior: [juniorOnly],
    };

    // -- consult mode: both brothers get the read-only belt ---------------
    const seniorConsult = new RecordingMock();
    const juniorConsult = new RecordingMock();
    const consult = new TwoBrothersHarness(cfg(), {
      senior: seniorConsult,
      junior: juniorConsult,
      workspace,
      toolScopes: scopes,
    });
    const consultResult = await consult.run("consult over the workspace");

    assert.equal(seniorConsult.belts.length, 2, "senior consult + review tool calls");
    for (const belt of seniorConsult.belts) {
      assert.deepEqual(
        belt,
        ["workspace_read_file", "workspace_list_dir", "workspace_search_text", "shared_note_read", "senior_audit"],
        "the consult belt is the read-only slice plus the senior's scopes",
      );
      for (const mutation of MUTATING_TOOLS) {
        assert.ok(!belt.includes(mutation), `senior consult belt must not offer ${mutation}`);
      }
      assert.ok(!belt.includes(juniorOnly.name), "the junior scope never leaks to the senior");
      assert.ok(!belt.includes(TODO_TOOL_NAME), "the display-only plan tool stays off consult belts");
    }
    assert.equal(juniorConsult.belts.length, 1, "junior proposal tool call");
    const juniorBelt = juniorConsult.belts[0]!;
    assert.deepEqual(
      juniorBelt,
      ["workspace_read_file", "workspace_list_dir", "workspace_search_text", "shared_note_read", "junior_note"],
      "the consult belt is the read-only slice plus the junior's scopes",
    );
    for (const mutation of MUTATING_TOOLS) {
      assert.ok(!juniorBelt.includes(mutation), `junior consult belt must not offer ${mutation}`);
    }
    assert.ok(!juniorBelt.includes(seniorOnly.name), "the senior scope never leaks to the junior");
    // the decision node stays plain: no belt, no Using tools section
    const decisionAudit = consultResult.promptAudits.find(
      (audit) => audit.role === "senior" && audit.kind === "decision",
    );
    assert.deepEqual(decisionAudit?.tools, []);

    // -- work mode: unchanged (junior mutations + approval-brokered run_shell)
    const seniorWork = new RecordingMock();
    const juniorWork = new RecordingMock();
    const work = new TwoBrothersHarness(
      resolveConfig({ provider: "mock", mode: "work" }),
      { senior: seniorWork, junior: juniorWork, workspace, toolScopes: scopes },
    );
    await work.run("do the workspace work");

    assert.equal(seniorWork.belts.length, 1, "the senior's verify slice");
    const verifyBelt = seniorWork.belts[0]!;
    for (const mutation of ["workspace_write_file", "workspace_edit_file", "workspace_delete_file"]) {
      assert.ok(!verifyBelt.includes(mutation), `the verify slice never offers ${mutation}`);
    }
    assert.ok(
      verifyBelt.includes("workspace_run_shell"),
      "work-mode verify keeps its documented approval-brokered run_shell carve-out",
    );
    assert.ok(verifyBelt.includes(TODO_TOOL_NAME), "the plan tool joins the work verify belt");
    const deliverableBelt = juniorWork.belts[0]!;
    for (const mutation of MUTATING_TOOLS) {
      assert.ok(
        deliverableBelt.includes(mutation),
        `the mutating work-mode deliverable belt is unchanged (${mutation})`,
      );
    }
    assert.ok(deliverableBelt.includes(TODO_TOOL_NAME));
  } finally {
    removeTempDirSync(root);
  }
});

// ---------------------------------------------------------------------------
// tool-less configurations: byte-identical requests, no extra calls
// ---------------------------------------------------------------------------

test("no tools configured: the consult nodes keep the plain request path", async () => {
  const senior = new ScriptedProvider("senior");
  const junior = new ScriptedProvider("junior");
  const harness = new TwoBrothersHarness(cfg(), { senior, junior });

  const result = await harness.run("a tool-less consult run");

  assert.deepEqual(auditLabels(result), [
    "senior/consult",
    "junior/proposal",
    "senior/review",
    "senior/decision",
  ]);
  assert.equal(senior.toolsCalls().length, 0, "no tool-loop calls");
  assert.equal(junior.toolsCalls().length, 0, "no tool-loop calls");
  assert.equal(senior.chatCalls().length + junior.chatCalls().length, 4, "no extra calls");
  for (const audit of result.promptAudits) {
    assert.deepEqual(audit.tools, []);
    assert.deepEqual(audit.sections, [PROMPT_SECTION_BASE, PROMPT_SECTION_TOOLS]);
  }
  // the assembled system prompt is exactly the pre-tools assembly (no belt)
  for (const call of [...senior.calls, ...junior.calls]) {
    assert.equal(
      call.system,
      harness.systemPrompt(call.role, [], call.kind),
      `${call.role}/${call.kind}: byte-identical system prompt`,
    );
  }
});

test("a non-empty belt on a provider without chatWithTools is never offered", async () => {
  const read = fakeTool("workspace_read_file", "Read a file from the workspace.");
  const senior = new ChatOnlyProvider();
  const junior = new ScriptedProvider("junior");
  const harness = new TwoBrothersHarness(cfg(), {
    senior,
    junior,
    toolScopes: { senior: [read] },
  });

  const result = await harness.run("the senior provider has no tools");

  assert.deepEqual(
    senior.calls.map((call) => call.kind),
    ["consult", "review", "decision"],
    "plain calls only",
  );
  for (const call of senior.calls) {
    assert.equal(
      call.system,
      harness.systemPrompt("senior", [], call.kind),
      "no belt in the prompt either",
    );
  }
  for (const audit of result.promptAudits.filter((entry) => entry.role === "senior")) {
    assert.deepEqual(audit.tools, []);
    assert.deepEqual(audit.sections, [PROMPT_SECTION_BASE, PROMPT_SECTION_TOOLS]);
  }
  assert.equal(auditLabels(result).length, 4, "no extra provider calls");
});

// ---------------------------------------------------------------------------
// bounded loop, cancel, unknown tool, repair-after-loop
// ---------------------------------------------------------------------------

test("the consult tool loop is bounded and an exhausted loop still repairs once", async () => {
  let executions = 0;
  const read = fakeTool("workspace_read_file", "Read a file from the workspace.", () => {
    executions += 1;
    return READ_RESULT;
  });
  const rounds: ToolRound[] = Array.from({ length: 10 }, (_, index) => ({
    toolCalls: [toolCall(`loop-${index}`, "workspace_read_file", { path: `f${index}.txt` })],
  }));
  const senior = new ScriptedProvider("senior", {
    tools: { consult: rounds },
    chat: { consult: [validReply("consult", { ask: "repaired after the loop" })] },
  });
  const harness = new TwoBrothersHarness(cfg(), {
    senior,
    junior: new ScriptedProvider("junior"),
    toolScopes: { senior: [read] },
  });

  const result = await harness.run("loop forever");

  assert.equal(executions, MAX_CONSULT_TOOL_ITERATIONS);
  assert.equal(senior.toolsCalls("consult").length, MAX_CONSULT_TOOL_ITERATIONS);
  assert.equal(senior.chatCalls("consult").length, 1, "one repair re-ask after the loop");
  assert.equal(
    result.messages.find((message) => message.kind === "consult")?.payload.ask,
    "repaired after the loop",
  );
  assert.deepEqual(result.errors, []);
});

test("cancel during a consult tool round stops the run without a node envelope", async () => {
  const controller = new AbortController();
  const read = fakeTool("workspace_read_file", "Read a file from the workspace.", () => {
    controller.abort();
    return READ_RESULT;
  });
  const senior = new ScriptedProvider("senior", {
    tools: {
      consult: [
        { toolCalls: [toolCall("c-1", "workspace_read_file", { path: "a.txt" })] },
        { toolCalls: [toolCall("c-2", "workspace_read_file", { path: "b.txt" })] },
      ],
    },
  });
  const harness = new TwoBrothersHarness(cfg(), {
    senior,
    junior: new ScriptedProvider("junior"),
    toolScopes: { senior: [read] },
    signal: controller.signal,
  });

  const result = await harness.run("stop during the tool round");

  assert.equal(result.cancelled, true);
  assert.deepEqual(
    result.messages.map((message) => message.kind),
    ["message"],
    "no consult envelope after the stop",
  );
  assert.ok(result.errors.includes("stopped by operator"));
  assert.equal(senior.toolsCalls("consult").length, 1, "the second round was never requested");
});

test("an invented mutating call in consult mode is an unknown tool the loop recovers from", async () => {
  const events: RuntimeEvent[] = [];
  const stream: StreamEvent[] = [];
  const senior = new ScriptedProvider("senior", {
    tools: {
      consult: [
        { toolCalls: [toolCall("x-1", "workspace_write_file", { path: "bad.txt", content: "x" })] },
        { text: validReply("consult", { ask: "answered after the unknown tool" }) },
      ],
    },
  });
  const harness = new TwoBrothersHarness(cfg(), {
    senior,
    junior: new ScriptedProvider("junior"),
    toolScopes: { senior: [fakeTool("workspace_read_file", "Read a file from the workspace.")] },
    onEvent: (event) => events.push(event),
    onStreamEvent: (event) => stream.push(event),
  });

  const result = await harness.run("try to mutate from a consult node");

  const completed = events.filter(
    (event): event is Extract<RuntimeEvent, { type: "tool_completed" }> =>
      event.type === "tool_completed",
  );
  assert.equal(completed.length, 1);
  assert.equal(completed[0].tool, "workspace_write_file");
  assert.equal(completed[0].status, "error");
  assert.equal(completed[0].result, "unknown tool: workspace_write_file");
  assert.deepEqual(streamLabels(stream), ["tool_call:senior:workspace_write_file:", "tool_result:senior:workspace_write_file:error"]);
  // no mutation was ever offered on the wire
  for (const call of senior.toolsCalls()) {
    for (const mutation of MUTATING_TOOLS) assert.ok(!call.tools.includes(mutation));
  }
  assert.equal(
    result.messages.find((message) => message.kind === "consult")?.payload.ask,
    "answered after the unknown tool",
  );
  assert.deepEqual(result.errors, []);
});

test("a prose reply after a tool round repairs once against the tool conversation", async () => {
  const read = fakeTool("workspace_read_file", "Read a file from the workspace.", () => READ_RESULT);
  const senior = new ScriptedProvider("senior", {
    tools: {
      consult: [
        { toolCalls: [toolCall("p-1", "workspace_read_file", { path: "notes.txt" })] },
        { text: "I read the file; it looks fine, proceed." },
      ],
    },
    chat: { consult: [validReply("consult", { ask: "repaired with grounding" })] },
  });
  const harness = new TwoBrothersHarness(cfg(), {
    senior,
    junior: new ScriptedProvider("junior"),
    toolScopes: { senior: [read] },
  });

  const result = await harness.run("repair after the tool round");

  const repairCall = senior.chatCalls("consult")[0]!;
  assert.equal(senior.chatCalls("consult").length, 1, "exactly one repair re-ask");
  const last = repairCall.messages[repairCall.messages.length - 1]!;
  const before = repairCall.messages[repairCall.messages.length - 2]!;
  assert.equal(last.role, "user");
  assert.ok(last.content.startsWith(REPAIR_REQUEST_PREFIX));
  assert.equal(before.role, "assistant");
  assert.equal(before.content, "I read the file; it looks fine, proceed.");
  assert.ok(
    repairCall.messages.some(
      (message) => message.role === "tool" && String(message.content).includes("hello from the workspace"),
    ),
    "the repair request resends the tool conversation, evidence included",
  );
  assert.equal(
    result.messages.find((message) => message.kind === "consult")?.payload.ask,
    "repaired with grounding",
  );
  assert.deepEqual(result.errors, []);
});
