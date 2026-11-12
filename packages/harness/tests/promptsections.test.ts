/**
 * Assembled system-prompt sections + per-call prompt/tool-belt audit tests.
 *
 * The sections live in code — `shared/prompts.json` (both copies) must stay
 * byte-identical, so the base prompt is the untouched file text and the tool
 * sections ride after it. Run with: node tests/run-all.ts (or node --test tests/)
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { resolveConfig } from "../src/config.ts";
import type { ChatMessage } from "../src/context.ts";
import {
  DELEGATION_DIRECTIVE,
  PROMPT_SECTION_BASE,
  PROMPT_SECTION_INSTRUCTIONS,
  PROMPT_SECTION_TOOLS,
  PROMPT_SECTION_USING_TOOLS,
  REPLY_FORMAT_MARKER,
  TwoBrothersHarness,
  assembleSystemPrompt,
  type ToolScopes,
} from "../src/harness.ts";
import {
  loadWorkspaceInstructions,
  renderWorkspaceInstructions,
} from "../src/instructions.ts";
import { createMcpToolName } from "../src/mcp.ts";
import {
  MockProvider,
  type Provider,
  type Tool,
  type ToolChatOptions,
  type ToolChatResponse,
} from "../src/provider.ts";
import { loadPrompts } from "../src/prompts.ts";
import type { PromptAuditEvent, RuntimeEvent } from "../src/runevents.ts";
import { TODO_TOOL_NAME } from "../src/todos.ts";
import { Workspace } from "../src/workspace.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const packagePromptsPath = path.resolve(here, "..", "shared", "prompts.json");
const repoRootPromptsPath = path.resolve(here, "..", "..", "..", "shared", "prompts.json");

const cfg = (extra: Record<string, unknown> = {}) =>
  resolveConfig({ provider: "mock", ...extra });

function tool(name: string, description = `fake ${name}`): Tool {
  return {
    name,
    description,
    parameters: { type: "object", properties: {} },
    execute: () => "ok",
  };
}

interface CapturedCall {
  role: "senior" | "junior";
  kind: string;
  /** Snapshot of the messages as sent (the tool loop mutates its array). */
  messages: ChatMessage[];
  tools: Tool[];
}

/**
 * A provider that records every request (role, kind, messages, belt) into a
 * shared log and answers deterministically through a MockProvider. `trace`
 * (when given) gets one `call:<role>` line per request, so a test can prove a
 * runtime event was emitted immediately before the request it describes.
 */
class CapturingProvider implements Provider {
  private readonly role: "senior" | "junior";
  private readonly log: CapturedCall[];
  private readonly delegate: Provider;
  private readonly trace: string[];

  constructor(
    role: "senior" | "junior",
    log: CapturedCall[],
    delegate: Provider = new MockProvider(),
    trace: string[] = [],
  ) {
    this.role = role;
    this.log = log;
    this.delegate = delegate;
    this.trace = trace;
  }

  private snapshot(kind: string, messages: ChatMessage[], tools: Tool[]): void {
    this.trace.push(`call:${this.role}`);
    this.log.push({
      role: this.role,
      kind,
      messages: messages.map((message) => ({ ...message })),
      tools: [...tools],
    });
  }

  async chat(messages: ChatMessage[], responseKind = "message"): Promise<string> {
    this.snapshot(responseKind, messages, []);
    return this.delegate.chat(messages, responseKind);
  }

  async chatWithTools(
    messages: ChatMessage[],
    tools: Tool[],
    options: ToolChatOptions = {},
  ): Promise<ToolChatResponse> {
    this.snapshot(options.responseKind ?? "deliverable", messages, tools);
    if (this.delegate.chatWithTools === undefined) {
      return { content: "", toolCalls: [] };
    }
    return this.delegate.chatWithTools(messages, tools, options);
  }
}

function systemOf(call: CapturedCall): string {
  return call.messages.find((message) => message.role === "system")?.content ?? "";
}

function userOf(call: CapturedCall): string {
  return call.messages.find((message) => message.role === "user")?.content ?? "";
}

/**
 * A work-mode run whose belts carry one tool per scope (MCP-namespaced).
 * `events` collects the runtime event stream; `trace` records the
 * audit→call interleaving (see `CapturingProvider`).
 */
function workRunWithScopes(events: RuntimeEvent[] = [], trace: string[] = []) {
  const log: CapturedCall[] = [];
  const sharedName = createMcpToolName("memory", "read_note");
  const juniorName = createMcpToolName("memory", "remember_note");
  const seniorName = createMcpToolName("memory", "audit_note");
  const unscopedName = createMcpToolName("other server", "do-it");
  const toolScopes: ToolScopes = {
    shared: [tool(sharedName, "Read a note from shared memory.")],
    junior: [
      tool(juniorName, "Remember a note in shared memory."),
      tool(unscopedName, "Do the other thing."),
    ],
    senior: [tool(seniorName, "Audit a note in shared memory.")],
  };
  const harness = new TwoBrothersHarness(cfg({ mode: "work" }), {
    senior: new CapturingProvider("senior", log, new MockProvider(), trace),
    junior: new CapturingProvider("junior", log, new MockProvider(), trace),
    toolScopes,
    onEvent: (event) => {
      events.push(event);
      if (event.type === "prompt_audit") trace.push(`audit:${event.role}`);
    },
  });
  return { harness, log, sharedName, juniorName, seniorName, unscopedName };
}

// ---------------------------------------------------------------------------
// assembly
// ---------------------------------------------------------------------------

test("available-tools section lists the actual belt with one-line descriptions", () => {
  const base = "SYSTEM BASE";
  const assembled = assembleSystemPrompt(base, [
    tool("workspace_read_file", "Read a file from the workspace."),
    tool(createMcpToolName("memory", "remember_note"), "Remember a note\nin shared memory."),
  ]);
  assert.ok(assembled.text.startsWith(base), "the base prompt stays untouched");
  assert.deepEqual(assembled.sections, [
    PROMPT_SECTION_BASE,
    PROMPT_SECTION_TOOLS,
    PROMPT_SECTION_USING_TOOLS,
  ]);
  assert.ok(assembled.text.includes("## Available tools"));
  assert.ok(
    assembled.text.includes("- workspace_read_file — Read a file from the workspace."),
    "names are exact and descriptions collapsed to one line",
  );
  assert.ok(
    assembled.text.includes("- mcp__memory__remember_note — Remember a note in shared memory."),
    "MCP namespaced names are listed as-is",
  );
  assert.ok(assembled.text.includes("## Using tools"));
  assert.ok(assembled.text.includes("Results must come from tool calls"));
  assert.ok(!assembled.text.includes("You have no tools"));
});

test("an empty belt says so explicitly and omits the use-these-tools section", () => {
  const assembled = assembleSystemPrompt("SYSTEM BASE", []);
  assert.deepEqual(assembled.sections, [PROMPT_SECTION_BASE, PROMPT_SECTION_TOOLS]);
  assert.ok(assembled.text.includes("You have no tools; answer from the transcript."));
  assert.ok(!assembled.text.includes("## Using tools"));
});

test("duplicate tool definitions are listed once", () => {
  const assembled = assembleSystemPrompt("", [tool("dup"), tool("dup"), tool("other")]);
  const occurrences = assembled.text.split("- dup —").length - 1;
  assert.equal(occurrences, 1);
  assert.ok(assembled.text.includes("- other —"));
});

// ---------------------------------------------------------------------------
// role belts as the tool loop actually offers them
// ---------------------------------------------------------------------------

test("work mode: junior deliverable lists shared+junior, not senior; senior verify the converse", async () => {
  const { harness, log, sharedName, juniorName, seniorName, unscopedName } = workRunWithScopes();
  const result = await harness.run("do part of the work");
  assert.deepEqual(
    result.messages.map((message) => message.kind),
    ["message", "delegation", "deliverable", "review", "decision"],
  );

  const deliverable = log.find((call) => call.role === "junior" && call.kind === "deliverable");
  assert.ok(deliverable, "the junior ran the tool loop");
  const juniorSystem = systemOf(deliverable);
  assert.ok(juniorSystem.includes(`- ${sharedName} —`), "shared scope joins the junior belt");
  assert.ok(juniorSystem.includes(`- ${juniorName} —`), "junior scope joins the junior belt");
  assert.ok(juniorSystem.includes(`- ${unscopedName} —`), "MCP-sanitized names stay exact");
  assert.ok(!juniorSystem.includes(seniorName), "the senior scope stays off the junior belt");
  assert.deepEqual(
    deliverable.tools.map((t) => t.name).sort(),
    [sharedName, juniorName, unscopedName, TODO_TOOL_NAME].sort(),
    "the built-in plan tool joins the junior belt last",
  );

  const verify = log.find((call) => call.role === "senior" && call.tools.length > 0);
  assert.ok(verify, "the senior verified with the read-only slice");
  const seniorSystem = systemOf(verify);
  assert.ok(seniorSystem.includes(`- ${sharedName} —`), "shared scope joins the verify slice");
  assert.ok(seniorSystem.includes(`- ${seniorName} —`), "senior scope joins the verify slice");
  assert.ok(!seniorSystem.includes(juniorName), "the junior scope stays off the senior belt");
  assert.deepEqual(
    verify.tools.map((t) => t.name).sort(),
    [sharedName, seniorName, TODO_TOOL_NAME].sort(),
    "the built-in plan tool also joins the verify slice",
  );

  // plain senior calls (delegation, review, decision) carry no tools and say so
  const plainSenior = log.filter((call) => call.role === "senior" && call.tools.length === 0);
  assert.ok(plainSenior.length > 0);
  for (const call of plainSenior) {
    assert.ok(systemOf(call).includes("You have no tools; answer from the transcript."));
  }
});

test("work mode: the junior deliverable message carries the delegation directive", async () => {
  const { harness, log } = workRunWithScopes();
  await harness.run("write the notes file");
  const deliverable = log.find((call) => call.role === "junior" && call.kind === "deliverable");
  assert.ok(deliverable);
  const user = userOf(deliverable);
  assert.ok(user.includes(DELEGATION_DIRECTIVE), "the directive is appended after the transcript");
  assert.ok(user.includes("Perform it now with your tools"));
  assert.ok(user.endsWith(DELEGATION_DIRECTIVE), "the byte-stable transcript stays the prefix");
});

test("work mode: the deliverable exemplar sits before the directive, never in the system prompt", async () => {
  const { harness, log } = workRunWithScopes();
  await harness.run("write the notes file");
  const deliverable = log.find((call) => call.role === "junior" && call.kind === "deliverable");
  assert.ok(deliverable);
  const system = systemOf(deliverable);
  const user = userOf(deliverable);
  const marker = `${REPLY_FORMAT_MARKER} deliverable`;
  assert.ok(!system.includes("```json"), "the system prompt carries no payload example");
  assert.ok(user.includes(marker), "the deliverable block rides on the transcript turn");
  assert.ok(
    user.indexOf(marker) < user.indexOf(DELEGATION_DIRECTIVE),
    "the format block comes before the directive",
  );
  assert.ok(user.endsWith(DELEGATION_DIRECTIVE), "the directive stays the final suffix");
});

test("work mode: the senior verify request carries no payload example", async () => {
  const { harness, log } = workRunWithScopes();
  await harness.run("verify the deliverable");
  const verify = log.find((call) => call.role === "senior" && call.tools.length > 0);
  assert.ok(verify, "the senior verified with the read-only slice");
  assert.ok(!systemOf(verify).includes("```json"), "no fence in the verify system prompt");
  assert.ok(
    !userOf(verify).includes(REPLY_FORMAT_MARKER),
    "no reply-format marker on the verify request tail",
  );
  assert.ok(
    userOf(verify).includes("Before reviewing, verify the junior's deliverable yourself"),
    "the verify instruction still rides the request",
  );
});

test("with tools, one belt means one system prefix; another belt means another", async () => {
  const { harness, log } = workRunWithScopes();
  await harness.run("pin the cache prefixes");
  const emptyBelt = log.filter((call) => call.role === "senior" && call.tools.length === 0);
  const verifyBelt = log.filter((call) => call.role === "senior" && call.tools.length > 0);
  assert.ok(emptyBelt.length >= 2, "delegation, review and decision run without a belt");
  assert.equal(verifyBelt.length, 1, "one senior verify call");
  const emptySystems = new Set(emptyBelt.map(systemOf));
  assert.equal(emptySystems.size, 1, "the same empty belt sends one system prompt");
  assert.notEqual(systemOf(verifyBelt[0]!), [...emptySystems][0]!, "the verify slice differs");
  for (const call of log) {
    assert.ok(!systemOf(call).includes("```json"), `${call.role}/${call.kind}: no example in system`);
  }
});

// ---------------------------------------------------------------------------
// byte-stable transcript markers
// ---------------------------------------------------------------------------

test("transcript markers stay byte-stable in every rendered user message", async () => {
  const { harness, log } = workRunWithScopes();
  const result = await harness.run("keep the markers stable");
  // the render contract: task block first, then the event log header
  const expected = "[[TASK]]\nkeep the markers stable\n[[/TASK]]\n\nContext events:";
  assert.ok(result.context.renderTranscript().startsWith(expected));
  for (const call of log) {
    // appended directives/instructions ride after the byte-stable render
    assert.ok(userOf(call).startsWith(expected), `${call.role}/${call.kind}: markers`);
  }
});

// ---------------------------------------------------------------------------
// per-call audit trail
// ---------------------------------------------------------------------------

test("audit trail has one truthful entry per provider call", async () => {
  const { harness, log } = workRunWithScopes();
  const result = await harness.run("audit the calls");
  const audits = result.promptAudits;

  assert.equal(audits.length, log.length, "one entry per provider request");
  assert.deepEqual(
    audits.map((entry) => `${entry.role}/${entry.kind}`),
    [
      "senior/delegation",
      "junior/deliverable",
      "senior/verify",
      "senior/review",
      "senior/decision",
    ],
  );

  for (let i = 0; i < audits.length; i++) {
    const audit = audits[i];
    const call = log[i];
    assert.equal(audit.role, call.role);
    assert.deepEqual(audit.tools, call.tools.map((t) => t.name));
    assert.equal(audit.systemChars, systemOf(call).length);
    assert.equal(audit.userChars, userOf(call).length);
    assert.ok(audit.systemChars > 0);
    assert.ok(audit.userChars > 0);
    assert.equal(audit.sections[0], PROMPT_SECTION_BASE);
    assert.ok(audit.sections.includes(PROMPT_SECTION_TOOLS));
    assert.equal(
      audit.sections.includes(PROMPT_SECTION_USING_TOOLS),
      call.tools.length > 0,
      "the Using tools section tracks the belt",
    );
  }
  // the belt is recorded per call, names only (never prompt bodies)
  assert.deepEqual(audits[0].tools, []);
  assert.ok(
    audits[1].tools.every((name) => name.startsWith("mcp__") || name === TODO_TOOL_NAME),
    "the junior belt is MCP tools plus the built-in plan tool",
  );
  assert.deepEqual(Object.keys(audits[1]).sort(), [
    "kind",
    "role",
    "sections",
    "systemChars",
    "tools",
    "userChars",
  ]);
});

test("empty-belt calls audit with the no-tools section and no belt", async () => {
  const log: CapturedCall[] = [];
  const harness = new TwoBrothersHarness(cfg({ mode: "consult" }), {
    senior: new CapturingProvider("senior", log),
    junior: new CapturingProvider("junior", log),
  });
  const result = await harness.run("consult without tools");
  assert.ok(result.promptAudits.length > 0);
  for (const audit of result.promptAudits) {
    assert.deepEqual(audit.tools, []);
    assert.deepEqual(audit.sections, [PROMPT_SECTION_BASE, PROMPT_SECTION_TOOLS]);
  }
  const seniorConsult = log.find((call) => call.role === "senior" && call.kind === "consult");
  assert.ok(seniorConsult);
  assert.ok(systemOf(seniorConsult).includes("You have no tools; answer from the transcript."));
});

// ---------------------------------------------------------------------------
// prompt_audit runtime event (the wire half of the audit trail)
// ---------------------------------------------------------------------------

test("every provider call emits one prompt_audit event, immediately before the call", async () => {
  const events: RuntimeEvent[] = [];
  const trace: string[] = [];
  const { harness, log } = workRunWithScopes(events, trace);
  const result = await harness.run("audit over the wire");

  const emitted = events.filter(
    (event): event is PromptAuditEvent => event.type === "prompt_audit",
  );
  assert.equal(emitted.length, result.promptAudits.length, "one event per audit entry");
  assert.equal(emitted.length, log.length, "one event per provider request");
  assert.deepEqual(
    emitted.map((audit) => ({
      role: audit.role,
      kind: audit.kind,
      sections: audit.sections,
      tools: audit.tools,
      systemChars: audit.systemChars,
      userChars: audit.userChars,
    })),
    result.promptAudits,
    "the event payload is the audit entry field for field",
  );

  // exactly the audit -> call pairs, in order and role-aligned
  const expectedTrace: string[] = [];
  for (const audit of result.promptAudits) expectedTrace.push(`audit:${audit.role}`, `call:${audit.role}`);
  assert.deepEqual(trace, expectedTrace, "each audit is emitted right before its provider call");

  // names and lengths only — never prompt bodies or transport metadata
  for (const event of emitted) {
    assert.deepEqual(Object.keys(event).sort(), [
      "kind",
      "role",
      "sections",
      "systemChars",
      "tools",
      "type",
      "userChars",
    ]);
  }
});

// ---------------------------------------------------------------------------
// prompts.json parity: the sections live in code, not in the file
// ---------------------------------------------------------------------------

test("both shared/prompts.json copies stay byte-identical and carry no tool sections", () => {
  const packaged = fs.readFileSync(packagePromptsPath);
  if (fs.existsSync(repoRootPromptsPath)) {
    assert.ok(
      packaged.equals(fs.readFileSync(repoRootPromptsPath)),
      `${packagePromptsPath} drifted from ${repoRootPromptsPath}`,
    );
  }
  const raw = packaged.toString("utf8");
  for (const forbidden of ["Available tools", "Using tools", "mcp__", "workspace_"]) {
    assert.ok(!raw.includes(forbidden), `prompts.json must not contain ${forbidden}`);
  }
  const prompts = loadPrompts();
  const harness = new TwoBrothersHarness(cfg());
  for (const role of ["senior", "junior"] as const) {
    const assembled = harness.systemPrompt(role);
    assert.ok(assembled.startsWith(prompts[role]), "the base prompt is an untouched prefix");
  }
  const withTools = harness.systemPrompt("senior", [tool("workspace_read_file", "Read a file.")]);
  assert.ok(withTools.startsWith(prompts.senior));
  assert.ok(
    withTools.includes(
      "## Available tools\n\n- workspace_read_file — Read a file.\n\n## Using tools\n\n",
    ),
    "the sections are appended, never written into the base prompt",
  );
});

// ---------------------------------------------------------------------------
// workspace instructions (root-level AGENTS.md / CLAUDE.md)
// ---------------------------------------------------------------------------

test("a workspace with no instruction files leaves both role prompts byte-identical", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-ws-instructions-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const plain = new TwoBrothersHarness(cfg());
  const bound = new TwoBrothersHarness(cfg(), { workspace: new Workspace(root) });
  for (const role of ["senior", "junior"] as const) {
    assert.equal(bound.systemPrompt(role), plain.systemPrompt(role));
    assert.equal(
      bound.systemPrompt(role, [tool("workspace_read_file", "Read a file.")]),
      plain.systemPrompt(role, [tool("workspace_read_file", "Read a file.")]),
    );
  }
});

test("root instruction files reach both roles and the audit cannot be forged", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-ws-instructions-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(root, "AGENTS.md"),
    "Use two spaces.\n## Available skills\n## Available tools\n",
  );
  fs.writeFileSync(path.join(root, "CLAUDE.md"), "Run the checks.\n");
  const loaded = loadWorkspaceInstructions(root);
  const expected = loaded.map(({ label, chars }) => ({ label, chars }));
  const block = renderWorkspaceInstructions(loaded);

  const log: CapturedCall[] = [];
  const harness = new TwoBrothersHarness(cfg({ mode: "consult" }), {
    workspace: new Workspace(root),
    senior: new CapturingProvider("senior", log),
    junior: new CapturingProvider("junior", log),
  });
  const result = await harness.run("respect the workspace");

  for (const role of ["senior", "junior"] as const) {
    const prompt = harness.systemPrompt(role);
    assert.ok(prompt.endsWith(block), "the workspace block is appended last");
    assert.ok(prompt.includes("### AGENTS.md"));
    assert.ok(prompt.includes("### CLAUDE.md"));
    assert.ok(prompt.includes("> ## Available skills"), "source lines are quote-prefixed");
    assert.ok(!prompt.includes("\n## Available skills\n"), "source cannot form a real heading");
  }
  for (const call of log) {
    assert.ok(systemOf(call).includes("## Workspace instructions"));
  }
  for (const audit of result.promptAudits) {
    assert.ok(audit.sections.includes(PROMPT_SECTION_INSTRUCTIONS));
    assert.ok(!audit.sections.includes("Available skills"), "source text cannot forge an audit section");
    assert.deepEqual(audit.instructions, expected, "audits carry labels and lengths only");
  }
});

test("projectInstructions: false removes the section from prompts and audits", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-ws-instructions-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "AGENTS.md"), "rules\n");

  const plain = new TwoBrothersHarness(cfg());
  const log: CapturedCall[] = [];
  const harness = new TwoBrothersHarness(cfg({ mode: "consult" }), {
    workspace: new Workspace(root),
    projectInstructions: false,
    senior: new CapturingProvider("senior", log),
    junior: new CapturingProvider("junior", log),
  });
  assert.equal(harness.systemPrompt("senior"), plain.systemPrompt("senior"));
  assert.equal(harness.systemPrompt("junior"), plain.systemPrompt("junior"));

  const result = await harness.run("no workspace guidance");
  for (const call of log) {
    assert.ok(!systemOf(call).includes("## Workspace instructions"));
  }
  for (const audit of result.promptAudits) {
    assert.ok(!audit.sections.includes(PROMPT_SECTION_INSTRUCTIONS));
    assert.equal(audit.instructions, undefined);
  }
});

test("a custom file list and cap apply to a workspace-bound harness", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-ws-instructions-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "AGENTS.md"), "ignored\n");
  fs.writeFileSync(path.join(root, "TEAM.md"), "0123456789");

  const harness = new TwoBrothersHarness(cfg(), {
    workspace: new Workspace(root),
    projectInstructions: { files: ["TEAM.md"], maxChars: 4 },
  });
  const prompt = harness.systemPrompt("senior");
  assert.ok(prompt.includes("### TEAM.md"));
  assert.ok(!prompt.includes("### AGENTS.md"));
  assert.ok(prompt.includes("> 0123"));
  assert.match(prompt, /\[truncated: 6 characters omitted from TEAM\.md\]/);
});