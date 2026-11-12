/**
 * The Senior solo decision (auto+solo lane, design §2/§3/§7.1): the
 * `senior_route → senior_solo → END` branch. Solo is legal per PROTOCOL.md §5
 * ("decide on its own"); the decision envelope is senior → user and ends the
 * cycle. Solo gets the Senior's read-only CONSULT belt (helpers kept, owner
 * Q5); tool-less configurations keep the exact plain ask path. The solo
 * directive is code-only and rides the transcript user turn BEFORE the
 * reply-format block; prompts.json stays byte-identical.
 *
 * Everything here is hermetic: scripted fake providers, in-memory harnesses
 * and temp directories. No network, no subprocesses.
 *
 * Run with: node tests/run-all.ts (or node --test tests/)
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { resolveConfig } from "../src/config.ts";
import { SharedContext, type ChatMessage } from "../src/context.ts";
import {
  AUTO_ROUTE_PREFIX,
  MAX_CONSULT_TOOL_ITERATIONS,
  PROMPT_SECTION_BASE,
  PROMPT_SECTION_TOOLS,
  PROMPT_SECTION_USING_TOOLS,
  SOLO_DECISION_DIRECTIVE,
  WORKSPACE_MUTATION_TOOL_NAMES,
  replyFormatBlock,
  TwoBrothersHarness,
} from "../src/harness.ts";
import { REPAIR_REQUEST_PREFIX } from "../src/payloads.ts";
import {
  ProviderAbortError,
  type Provider,
  type Tool,
  type ToolChatOptions,
  type ToolChatResponse,
  type UsageTotals,
} from "../src/provider.ts";
import type { RuntimeEvent, UsageEvent } from "../src/runevents.ts";
import { SessionStore, restoreContext } from "../src/session.ts";
import { forkSession } from "../src/sessionfork.ts";
import { sessionToMarkdown, sessionToJsonString } from "../src/sessionsearch.ts";
import { SubagentStore } from "../src/subagent.ts";
import { TODO_TOOL_NAME } from "../src/todos.ts";
import { discoverSkills } from "../src/skills.ts";
import { Workspace } from "../src/workspace.ts";
import type { ToolCall } from "../src/context.ts";

const TASK = "Explain the trade-offs of dual-write migration.";

const cfg = (mode = "auto") => resolveConfig({ provider: "mock", mode });

const VALID: Record<string, Record<string, unknown>> = {
  route: { route: "solo", reason: "I can answer this from knowledge" },
  decision: { decision: "D", rationale: "R", confidence: 0.7, dissent: null, accepted_proposals: [] },
  consult: { task: "t", ask: "a", expect: "proposal", deadline_hint: "today" },
  proposal: { title: "P", answer: "A", rationale: "R", risks: [], confidence: 0.7, asks: [] },
  review: { verdict: "accept", notes: "", points: [] },
};

interface RecordedCall {
  role: "senior" | "junior";
  channel: "chat" | "tools";
  kind: string;
  messages: ChatMessage[];
  tools: string[];
}

interface ProviderSpec {
  scripts?: Record<string, string[]>;
  /** Scripted chatWithTools rounds (tool calls then final text). */
  toolRounds?: Array<{ toolCalls?: ToolCall[]; text?: string }>;
  withTools?: boolean;
  onCall?: (kind: string) => void;
}

function makeProvider(role: "senior" | "junior", spec: ProviderSpec = {}): {
  provider: Provider & { usageSnapshot(): UsageTotals };
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const queues: Record<string, string[]> = Object.fromEntries(
    Object.entries(spec.scripts ?? {}).map(([kind, replies]) => [kind, [...replies]]),
  );
  const rounds = [...(spec.toolRounds ?? [])];
  const replyFor = (kind: string): string => {
    const queue = queues[kind];
    if (queue !== undefined && queue.length > 0) return queue.shift()!;
    if (kind === "compaction") return "Summary of the earlier conversation.";
    return JSON.stringify(VALID[kind] ?? { text: "ok" });
  };
  const provider: Provider & { usageSnapshot(): UsageTotals } = {
    usageSnapshot: (): UsageTotals => ({
      model_calls: calls.length,
      input_tokens: 10 * calls.length,
      output_tokens: 5 * calls.length,
      cached_tokens: 0,
      cache_write_tokens: 0,
    }),
    chat: async (messages, responseKind = "message") => {
      calls.push({
        role,
        channel: "chat",
        kind: responseKind,
        messages: messages.map((message) => ({ ...message })),
        tools: [],
      });
      spec.onCall?.(responseKind);
      return replyFor(responseKind);
    },
  };
  if (spec.withTools === true) {
    provider.chatWithTools = async (
      messages: ChatMessage[],
      tools: Tool[],
      options: ToolChatOptions = {},
    ): Promise<ToolChatResponse> => {
      calls.push({
        role,
        channel: "tools",
        kind: options.responseKind ?? "",
        messages: messages.map((message) => ({ ...message })),
        tools: tools.map((tool) => tool.name),
      });
      const round = rounds.shift();
      if (round !== undefined) {
        return { content: round.text ?? "", toolCalls: round.toolCalls ?? [] };
      }
      return { content: replyFor(options.responseKind ?? ""), toolCalls: [] };
    };
  }
  return { provider, calls };
}

function fakeTool(name: string, execute?: () => string): Tool {
  return {
    name,
    description: `fake ${name}`,
    parameters: { type: "object", properties: {} },
    execute: execute ?? (() => JSON.stringify({ tool: name, status: "ok", content: "grounded evidence" })),
  };
}

function soloHarness(
  seniorSpec: ProviderSpec = {},
  options: Record<string, unknown> = {},
): { harness: TwoBrothersHarness; senior: ReturnType<typeof makeProvider>; junior: ReturnType<typeof makeProvider> } {
  const senior = makeProvider("senior", {
    ...seniorSpec,
    scripts: { route: [JSON.stringify(VALID.route)], ...seniorSpec.scripts },
  });
  const junior = makeProvider("junior");
  const harness = new TwoBrothersHarness(cfg(), {
    senior: senior.provider,
    junior: junior.provider,
    ...options,
  });
  return { harness, senior, junior };
}

function userContent(call: RecordedCall): string {
  return call.messages.find((message) => message.role === "user")?.content ?? "";
}

function systemContent(call: RecordedCall): string {
  return call.messages.find((message) => message.role === "system")?.content ?? "";
}

// ---------------------------------------------------------------------------
// the solo cycle shape
// ---------------------------------------------------------------------------

test("solo: envelope sequence is task, marker, decision — dense seq 1-3", async () => {
  const { harness, junior } = soloHarness();
  const result = await harness.run(TASK);
  assert.deepEqual(result.messages.map((message) => message.kind), ["message", "message", "decision"]);
  assert.deepEqual(result.messages.map((message) => [message.from, message.to]), [
    ["user", "senior"],
    ["user", "senior"],
    ["senior", "user"],
  ]);
  assert.deepEqual(result.messages.map((message) => message.seq), [1, 2, 3]);
  assert.equal(result.messages[1]!.payload.text, `${AUTO_ROUTE_PREFIX}solo — I can answer this from knowledge`);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.rounds, 0);
  assert.deepEqual(junior.calls, [], "the junior is never called on a solo run");
});

test("solo: decision payload keeps the unchanged contract (sanitize defaults)", async () => {
  const { harness } = soloHarness({
    scripts: { decision: [JSON.stringify({ decision: "Use dual-write with a rollback path." })] },
  });
  const result = await harness.run(TASK);
  assert.deepEqual(result.decision, {
    decision: "Use dual-write with a rollback path.",
    rationale: "",
    confidence: 0.5,
    dissent: null,
    accepted_proposals: [],
  });
});

test("solo: session JSONL round-trip persists every envelope with dense seq", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-solo-"));
  try {
    const file = path.join(root, "solo.jsonl");
    const store = new SessionStore(file);
    const { harness } = soloHarness();
    const result = await harness.run(TASK, new SharedContext(store));
    const loaded = store.loadStrict();
    assert.equal(loaded.length, 3);
    assert.deepEqual(loaded.map((message) => message.seq), [1, 2, 3]);
    assert.deepEqual(loaded.map((message) => message.kind), ["message", "message", "decision"]);
    assert.equal(loaded[1]!.payload.text, `${AUTO_ROUTE_PREFIX}solo — I can answer this from knowledge`);
    assert.deepEqual(
      loaded.map((message) => message.payload),
      result.messages.map((message) => message.payload),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// transcript + request bytes
// ---------------------------------------------------------------------------

test("solo: transcript keeps the byte-stable markers and the exact marker line", async () => {
  const { harness } = soloHarness();
  const result = await harness.run(TASK);
  const transcript = result.context.renderTranscript();
  const markerLine = `[2] [user -> senior] message: ${JSON.stringify({ text: `${AUTO_ROUTE_PREFIX}solo — I can answer this from knowledge` })}`;
  assert.equal(
    transcript,
    [
      "[[TASK]]",
      TASK,
      "[[/TASK]]",
      "",
      "Context events:",
      `[1] [user -> senior] message: ${JSON.stringify({ text: TASK })}`,
      markerLine,
      `[3] [senior -> user] decision: ${JSON.stringify(result.decision)}`,
    ].join("\n"),
  );
});

test("solo: the decision request carries the directive BEFORE the reply-format block", async () => {
  const { harness, senior } = soloHarness();
  await harness.run(TASK);
  const decisionCall = senior.calls.find((call) => call.kind === "decision")!;
  const content = userContent(decisionCall);
  const block = replyFormatBlock("decision");
  assert.ok(content.endsWith(block), "the request ends with the decision reply-format block");
  const directiveAt = content.indexOf(SOLO_DECISION_DIRECTIVE.trim());
  const blockAt = content.indexOf("Requested payload: decision");
  assert.ok(directiveAt >= 0 && directiveAt < blockAt);
  assert.ok(content.includes("do not claim performed work"));
  assert.ok(content.includes("execution needs work mode"));
  // The transcript part stays byte-stable: the marker line rides inside it.
  assert.ok(content.includes(`${AUTO_ROUTE_PREFIX}solo — I can answer this from knowledge`));
});

test("solo: tool-less system prompt is the empty-belt assembly", async () => {
  const { harness, senior } = soloHarness();
  const result = await harness.run(TASK);
  const decisionCall = senior.calls.find((call) => call.kind === "decision")!;
  assert.equal(decisionCall.channel, "chat");
  assert.deepEqual(decisionCall.tools, []);
  assert.ok(systemContent(decisionCall).includes("You have no tools; answer from the transcript."));
  assert.deepEqual(result.promptAudits.map((entry) => entry.kind), ["route", "decision"]);
  assert.deepEqual(result.promptAudits[1]!.sections, [PROMPT_SECTION_BASE, PROMPT_SECTION_TOOLS]);
  assert.deepEqual(result.promptAudits[1]!.tools, []);
});

// ---------------------------------------------------------------------------
// the solo belt: read-only consult belt, helpers kept
// ---------------------------------------------------------------------------

test("solo: the consult belt grounds the decision (scripted tool round)", async () => {
  const readTool = fakeTool("workspace_read_file");
  const senior = makeProvider("senior", {
    withTools: true,
    scripts: { route: [JSON.stringify(VALID.route)] },
    toolRounds: [
      { toolCalls: [{ id: "call-1", name: "workspace_read_file", args: { path: "notes.txt" } }] },
      { text: JSON.stringify(VALID.decision) },
    ],
  });
  const events: RuntimeEvent[] = [];
  const grounded = new TwoBrothersHarness(cfg(), {
    senior: senior.provider,
    junior: makeProvider("junior").provider,
    toolScopes: { shared: [readTool] },
    onEvent: (event) => events.push(event),
  });
  const result = await grounded.run(TASK);
  assert.deepEqual(result.messages.map((message) => message.kind), ["message", "message", "decision"]);
  const toolCalls = senior.calls.filter((call) => call.channel === "tools");
  assert.equal(toolCalls.length, 2, "one tool round plus the final answer");
  assert.ok(toolCalls.every((call) => call.tools.includes("workspace_read_file")));
  assert.ok(events.some((event) => event.type === "tool_completed"));
  // Tool activity never becomes an envelope.
  assert.equal(result.messages.length, 3);
  assert.deepEqual(result.errors, []);
});

test("solo: mutation tools and todo_write are NEVER offered", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-solo-"));
  try {
    const workspace = new Workspace(root);
    const { senior } = soloHarness({ withTools: true });
    const harness = new TwoBrothersHarness(cfg(), {
      senior: senior.provider,
      junior: makeProvider("junior").provider,
      workspace,
    });
    await harness.run(TASK);
    const decisionCalls = senior.calls.filter((call) => call.kind === "decision");
    assert.ok(decisionCalls.length > 0);
    for (const call of decisionCalls) {
      for (const name of call.tools) {
        assert.ok(!WORKSPACE_MUTATION_TOOL_NAMES.has(name), `mutation tool offered: ${name}`);
        assert.notEqual(name, TODO_TOOL_NAME);
      }
      // The real workspace read tools ARE offered (grounding).
      assert.ok(call.tools.includes("workspace_read_file"));
      assert.ok(call.tools.includes("workspace_list_dir"));
      assert.ok(call.tools.includes("workspace_search_text"));
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("solo: the read-only subagent helper stays on the belt when configured (owner Q5)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-solo-"));
  try {
    const store = new SubagentStore(path.join(root, "subagents"));
    const { senior } = soloHarness({ withTools: true });
    const harness = new TwoBrothersHarness(cfg(), {
      senior: senior.provider,
      junior: makeProvider("junior").provider,
      toolScopes: { shared: [fakeTool("workspace_read_file")] },
      subagents: { store, parentSession: "solo.jsonl" },
    });
    await harness.run(TASK);
    const decisionCall = senior.calls.find((call) => call.kind === "decision")!;
    assert.equal(decisionCall.channel, "tools");
    assert.ok(decisionCall.tools.includes("subagent"), "solo means without the Junior, not without helpers");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("solo: a provider without chatWithTools keeps the exact plain ask path", async () => {
  const { harness, senior } = soloHarness({}, { toolScopes: { shared: [fakeTool("workspace_read_file")] } });
  const result = await harness.run(TASK);
  const decisionCalls = senior.calls.filter((call) => call.kind === "decision");
  assert.equal(decisionCalls.length, 1);
  assert.equal(decisionCalls[0]!.channel, "chat");
  assert.deepEqual(decisionCalls[0]!.messages.map((message) => message.role), ["system", "user"]);
  assert.deepEqual(result.errors, []);
});

test("solo: spill_read/todo-only belts keep the plain path (no task tools)", async () => {
  const { harness, senior } = soloHarness({ withTools: true }, { toolScopes: { shared: [] } });
  const result = await harness.run(TASK);
  const decisionCall = senior.calls.find((call) => call.kind === "decision")!;
  assert.equal(decisionCall.channel, "chat", "todo_write alone never opens a tool loop");
  assert.deepEqual(result.errors, []);
});

test("solo: the tool loop is bounded by MAX_CONSULT_TOOL_ITERATIONS", async () => {
  const readTool = fakeTool("workspace_read_file");
  const rounds = Array.from({ length: MAX_CONSULT_TOOL_ITERATIONS + 2 }, (_, index) => ({
    toolCalls: [{ id: `call-${index}`, name: "workspace_read_file", args: { path: `f${index}.txt` } }],
  }));
  const { senior } = soloHarness({ withTools: true, toolRounds: rounds });
  const harness = new TwoBrothersHarness(cfg(), {
    senior: senior.provider,
    junior: makeProvider("junior").provider,
    toolScopes: { shared: [readTool] },
  });
  const result = await harness.run(TASK);
  const toolCalls = senior.calls.filter((call) => call.channel === "tools");
  assert.equal(toolCalls.length, MAX_CONSULT_TOOL_ITERATIONS);
  // An exhausted loop still produces a decision (tolerant fallback), never a throw.
  assert.equal(result.messages[result.messages.length - 1]!.kind, "decision");
});

// ---------------------------------------------------------------------------
// repair + skills on the solo decision
// ---------------------------------------------------------------------------

test("solo: a bad decision reply takes exactly one repair re-ask", async () => {
  const { harness, senior } = soloHarness({
    scripts: { decision: ["prose instead of JSON", JSON.stringify(VALID.decision)] },
  });
  const result = await harness.run(TASK);
  const decisionCalls = senior.calls.filter((call) => call.kind === "decision");
  assert.equal(decisionCalls.length, 2);
  const repairs = result.messages.filter((message) =>
    String(message.payload.text ?? "").startsWith(REPAIR_REQUEST_PREFIX),
  );
  assert.equal(repairs.length, 1);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.decision.decision, "D");
});

test("solo: an unstructured decision after repair degrades with the decision error (exit-1 semantics)", async () => {
  const { harness } = soloHarness({
    scripts: { decision: ["first prose", "second prose"] },
  });
  const result = await harness.run(TASK);
  assert.deepEqual(result.errors, ["unstructured model reply for decision"]);
  // The tolerant fallback still emits a decision envelope (text as decision).
  assert.equal(result.messages[result.messages.length - 1]!.kind, "decision");
  assert.equal(typeof result.decision.decision, "string");
});

test("solo: a skill request in the decision reply delivers the body (existing convention)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-solo-"));
  try {
    const skillDir = path.join(root, "skills", "checklist");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: checklist\ndescription: d\n---\nCheck the rollback path.", "utf8");
    const catalog = discoverSkills([path.join(root, "skills")]);
    const { harness } = soloHarness({
      scripts: {
        decision: [
          `<skill name="checklist">\n${JSON.stringify(VALID.decision)}`,
        ],
      },
    }, { skills: catalog });
    const result = await harness.run(TASK);
    const loaded = result.messages.filter((message) =>
      String(message.payload.text ?? "").startsWith("<skill-loaded"),
    );
    assert.equal(loaded.length, 1);
    assert.ok(String(loaded[0]!.payload.text).includes("Check the rollback path."));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// resume / fork / export over a solo session
// ---------------------------------------------------------------------------

test("solo: resume routes again for the new task without re-appending the old one", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-solo-"));
  try {
    const file = path.join(root, "solo.jsonl");
    const store = new SessionStore(file);
    const first = soloHarness();
    await first.harness.run(TASK, new SharedContext(store));

    const restored = restoreContext(store);
    const second = soloHarness({
      scripts: { route: [JSON.stringify({ route: "solo", reason: "the follow-up is also knowledge-only" })] },
    });
    const result = await second.harness.run("A follow-up question about rollback.", restored);
    // The old task is not re-appended; the new task + marker + decision continue dense.
    assert.deepEqual(result.messages.map((message) => message.seq), [4, 5, 6]);
    assert.equal(result.messages[0]!.payload.text, "A follow-up question about rollback.");
    assert.equal(
      result.messages[1]!.payload.text,
      `${AUTO_ROUTE_PREFIX}solo — the follow-up is also knowledge-only`,
    );
    assert.equal(result.context.events.length, 6);
    // Both route markers stay in view (the router saw the earlier one).
    const routeCall = second.senior.calls.find((call) => call.kind === "route")!;
    assert.ok(userContent(routeCall).includes(`${AUTO_ROUTE_PREFIX}solo — I can answer this from knowledge`));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("solo: fork copies the marker envelope verbatim", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-solo-"));
  try {
    const store = new SessionStore(path.join(root, "solo.jsonl"));
    const { harness } = soloHarness();
    await harness.run(TASK, new SharedContext(store));
    const fork = forkSession(root, "solo", { name: "solo-fork" });
    const forked = new SessionStore(path.join(root, fork.name)).loadStrict();
    const source = store.loadStrict();
    assert.deepEqual(forked.map((message) => message.payload), source.map((message) => message.payload));
    assert.equal(forked[1]!.payload.text, `${AUTO_ROUTE_PREFIX}solo — I can answer this from knowledge`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("solo: export renders the marker as a user message (markdown + JSON)", async () => {
  const { harness } = soloHarness();
  const result = await harness.run(TASK);
  const doc = {
    title: "Solo session",
    name: "solo",
    events: result.context.events,
  };
  const markdown = sessionToMarkdown(doc, { exportedAt: "2026-11-12T00:00:00Z" });
  assert.ok(markdown.includes(`${AUTO_ROUTE_PREFIX}solo — I can answer this from knowledge`));
  const json = JSON.parse(sessionToJsonString(doc, { exportedAt: "2026-11-12T00:00:00Z" }));
  const texts = (json.envelopes as Array<{ payload: { text?: string } }>).map((event) => event.payload.text ?? "");
  assert.ok(texts.some((text) => text.startsWith(AUTO_ROUTE_PREFIX)));
});

// ---------------------------------------------------------------------------
// steering / compaction compose with solo
// ---------------------------------------------------------------------------

test("solo: steering drained inside the tool loop reaches the next request", async () => {
  const readTool = fakeTool("workspace_read_file");
  let drained = false;
  const { senior } = soloHarness({
    withTools: true,
    toolRounds: [
      { toolCalls: [{ id: "call-1", name: "workspace_read_file", args: {} }] },
      { text: JSON.stringify(VALID.decision) },
    ],
  });
  const harness = new TwoBrothersHarness(cfg(), {
    senior: senior.provider,
    junior: makeProvider("junior").provider,
    toolScopes: { shared: [readTool] },
    steering: () => {
      if (drained) return [];
      drained = true;
      return ["focus on the rollback path"];
    },
  });
  const result = await harness.run(TASK);
  const toolCalls = senior.calls.filter((call) => call.channel === "tools");
  assert.equal(toolCalls.length, 2);
  assert.ok(
    userContent(toolCalls[1]!).includes("[[OPERATOR STEER]] focus on the rollback path"),
    "the second loop request re-renders the transcript with the steer",
  );
  assert.deepEqual(result.errors, []);
});

test("solo: a solo context is compactable (the marker is an ordinary envelope)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-solo-"));
  try {
    const store = new SessionStore(path.join(root, "solo.jsonl"));
    const first = soloHarness();
    await first.harness.run(TASK, new SharedContext(store));
    const restored = restoreContext(store);
    const second = soloHarness({
      scripts: { route: [JSON.stringify({ route: "solo", reason: "still knowledge-only" })] },
    }, { compaction: { force: true, thresholdChars: 100_000, keepRecentChars: 50 } });
    const result = await second.harness.run("Another question.", restored);
    const summary = result.context.events.find((message) =>
      String(message.payload.text ?? "").startsWith("The conversation history before this point was compacted"),
    );
    assert.ok(summary !== undefined, "the forced compaction summarized the solo history incl. the marker");
    assert.deepEqual(result.errors, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// usage / audits / cancellation
// ---------------------------------------------------------------------------

test("solo: routing + decision usage merge; live usage events follow each node", async () => {
  const events: RuntimeEvent[] = [];
  const { harness, senior } = soloHarness({}, { onEvent: (event: RuntimeEvent) => events.push(event) });
  const result = await harness.run(TASK);
  // Two senior calls (route + decision), zero junior calls.
  assert.equal(senior.calls.length, 2);
  assert.equal(result.usage.model_calls, 2);
  assert.equal(result.usage.input_tokens, 20);
  assert.equal(result.usage.output_tokens, 10);
  const usageEvents = events.filter((event) => event.type === "usage") as UsageEvent[];
  assert.equal(usageEvents.length, 2, "one live snapshot after each node");
  assert.equal((usageEvents[0]!.usage as { model_calls: number }).model_calls, 1);
  assert.equal((usageEvents[1]!.usage as { model_calls: number }).model_calls, 2);
});

test("solo: prompt audits are [route, decision] with the expected belts", async () => {
  const readTool = fakeTool("workspace_read_file");
  const { harness } = soloHarness({ withTools: true }, { toolScopes: { shared: [readTool] } });
  const result = await harness.run(TASK);
  assert.deepEqual(result.promptAudits.map((entry) => entry.kind), ["route", "decision"]);
  assert.deepEqual(result.promptAudits[0]!.tools, []);
  assert.deepEqual(result.promptAudits[1]!.tools, ["workspace_read_file"]);
  assert.deepEqual(result.promptAudits[1]!.sections, [
    PROMPT_SECTION_BASE,
    PROMPT_SECTION_TOOLS,
    PROMPT_SECTION_USING_TOOLS,
  ]);
});

test("solo: cancelled during the decision call appends nothing after the marker", async () => {
  const controller = new AbortController();
  const senior = makeProvider("senior", {
    scripts: { route: [JSON.stringify(VALID.route)] },
    onCall: (kind) => {
      if (kind === "decision") controller.abort();
    },
  });
  const aborting: Provider = {
    chat: async (messages, kind) => {
      if (kind === "decision") {
        controller.abort();
        throw new ProviderAbortError();
      }
      return senior.provider.chat(messages, kind);
    },
  };
  const harness = new TwoBrothersHarness(cfg(), {
    senior: aborting,
    junior: makeProvider("junior").provider,
    signal: controller.signal,
  });
  const result = await harness.run(TASK);
  assert.equal(result.cancelled, true);
  assert.deepEqual(result.messages.map((message) => message.kind), ["message", "message"]);
  assert.deepEqual(result.decision, {});
});

test("solo: the solo decision is advice — no workspace mutation path exists", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-solo-"));
  try {
    fs.writeFileSync(path.join(root, "keep.txt"), "untouched", "utf8");
    const workspace = new Workspace(root);
    const { harness } = soloHarness({ withTools: true }, { workspace });
    const result = await harness.run(TASK);
    assert.deepEqual(result.errors, []);
    assert.equal(fs.readFileSync(path.join(root, "keep.txt"), "utf8"), "untouched");
    assert.deepEqual(fs.readdirSync(root).sort(), ["keep.txt"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
