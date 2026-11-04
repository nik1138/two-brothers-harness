/**
 * Structured-payload discipline: the one-shot repair pass and the few-shot
 * payload exemplars (BACKLOG "Structured-payload discipline", fixes 1 + 3).
 *
 * A node whose reply fails the strict payload check gets exactly ONE repair
 * re-ask. The repair turn is appended to the shared context as a marked
 * `message` envelope (`[[REPAIR_REQUEST]]` … `[[/REPAIR_REQUEST]]`, from
 * "user", the harness-injected context role — the compaction-summary
 * convention), and the request re-sends the conversation OpenAI-style: the
 * bad reply as an assistant turn followed by the repair instruction as a
 * user turn. A reply that stays bad falls back to the tolerant pipeline
 * (sanitize + defaults + one warning) — never a throw.
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
  PROMPT_SECTION_BASE,
  PROMPT_SECTION_TOOLS,
  TwoBrothersHarness,
  assembleSystemPrompt,
} from "../src/harness.ts";
import {
  REPAIR_ISSUE_CHARS,
  REPAIR_REQUEST_PREFIX,
  REPAIR_REQUEST_SUFFIX,
  buildRepairRequest,
  parsePayload,
  strictPayloadIssues,
} from "../src/payloads.ts";
import {
  MockProvider,
  type Provider,
  type Tool,
  type ToolChatOptions,
  type ToolChatResponse,
} from "../src/provider.ts";
import { SessionStore } from "../src/session.ts";

const cfg = (extra: Record<string, unknown> = {}) =>
  resolveConfig({ provider: "mock", ...extra });

const PROSE = "I looked at the task and I think we should proceed carefully step by step.";

/** One strict-valid payload per structured kind (the scripted baseline). */
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

interface Call {
  kind: string;
  messages: ChatMessage[];
}

/**
 * Scripted text provider: one queue of replies per response kind. When a
 * queue is empty it answers with the strict-valid payload for that kind, so
 * tests only script the calls they care about. Every request is captured.
 */
class ScriptedProvider implements Provider {
  readonly calls: Call[] = [];
  private readonly replies: Record<string, string[]>;

  constructor(replies: Record<string, string[]> = {}) {
    this.replies = replies;
  }

  async chat(messages: ChatMessage[], responseKind = "message"): Promise<string> {
    this.calls.push({ kind: responseKind, messages: messages.map((message) => ({ ...message })) });
    const queue = this.replies[responseKind];
    if (queue !== undefined && queue.length > 0) return queue.shift()!;
    return validReply(responseKind);
  }

  callsOf(kind: string): Call[] {
    return this.calls.filter((call) => call.kind === kind);
  }
}

function repairEnvelopes(messages: Array<{ from: string; to: string; kind: string; payload: Record<string, unknown> }>) {
  return messages.filter(
    (message) =>
      message.from === "user" &&
      message.kind === "message" &&
      String(message.payload.text ?? "").startsWith(REPAIR_REQUEST_PREFIX),
  );
}

function userOf(call: Call): string {
  return call.messages.find((message) => message.role === "user")?.content ?? "";
}

// ---------------------------------------------------------------------------
// repair pass: the happy path
// ---------------------------------------------------------------------------

test("a prose reply is re-asked once and the strict payload is used", async () => {
  const senior = new ScriptedProvider({ consult: [PROSE, validReply("consult", { ask: "repaired" })] });
  const junior = new ScriptedProvider();
  const harness = new TwoBrothersHarness(cfg({ mode: "consult" }), { senior, junior });

  const result = await harness.run("build a catalog");

  const consultCalls = senior.callsOf("consult");
  assert.equal(consultCalls.length, 2, "exactly one repair re-ask");
  assert.deepEqual(result.errors, []);

  const consult = result.messages.find((message) => message.kind === "consult")!;
  assert.equal(consult.payload.ask, "repaired", "the repaired payload is what the run keeps");

  // the repaired request is OpenAI-shaped: bad reply as assistant, request as user
  const repairCall = consultCalls[1];
  const last = repairCall.messages[repairCall.messages.length - 1];
  const before = repairCall.messages[repairCall.messages.length - 2];
  assert.equal(last.role, "user");
  assert.ok(last.content.startsWith(REPAIR_REQUEST_PREFIX));
  assert.ok(last.content.includes("```json"));
  assert.equal(before.role, "assistant");
  assert.equal(before.content, PROSE);

  // one audit entry per provider request, the repair entry named for the node
  assert.deepEqual(
    result.promptAudits.map((entry) => `${entry.role}/${entry.kind}`),
    ["senior/consult", "senior/consult", "junior/proposal", "senior/review", "senior/decision"],
  );
});

test("the repair turn is a marked shared-context envelope and later nodes see it", async () => {
  const senior = new ScriptedProvider({ consult: [PROSE, validReply("consult")] });
  const junior = new ScriptedProvider();
  const harness = new TwoBrothersHarness(cfg({ mode: "consult" }), { senior, junior });

  const result = await harness.run("build a catalog");

  const repairs = repairEnvelopes(result.messages);
  assert.equal(repairs.length, 1);
  assert.equal(repairs[0].to, "senior");
  assert.equal(repairs[0].kind, "message");
  assert.deepEqual(Object.keys(repairs[0].payload), ["text"]);
  const text = String(repairs[0].payload.text);
  assert.ok(text.startsWith(REPAIR_REQUEST_PREFIX));
  assert.ok(text.endsWith(REPAIR_REQUEST_SUFFIX));
  assert.ok(text.includes("consult"), "the request names the payload kind");
  assert.ok(text.includes("task") && text.includes("ask"), "the missing required fields are listed");

  // the envelope sits between the task message and the repaired answer
  assert.deepEqual(
    result.messages.map((message) => message.kind),
    ["message", "message", "consult", "proposal", "review", "decision"],
  );

  // the next node's request carries the repair event in the shared transcript
  const proposalCall = junior.callsOf("proposal")[0];
  assert.ok(userOf(proposalCall).includes(REPAIR_REQUEST_PREFIX));
  // the byte-stable transcript contract is untouched
  assert.ok(userOf(proposalCall).startsWith("[[TASK]]\nbuild a catalog\n[[/TASK]]\n\nContext events:"));
});

// ---------------------------------------------------------------------------
// repair pass: bounded and fail-soft
// ---------------------------------------------------------------------------

test("only one repair attempt per node; a second bad reply sanitizes with a warning", async () => {
  const senior = new ScriptedProvider({ consult: [PROSE, `${PROSE} Still prose.`] });
  const junior = new ScriptedProvider();
  const harness = new TwoBrothersHarness(cfg({ mode: "consult" }), { senior, junior });

  const result = await harness.run("build a catalog");

  assert.equal(senior.callsOf("consult").length, 2, "never a third call for the same node");
  assert.deepEqual(
    result.errors.filter((error) => error === "unstructured model reply for consult"),
    ["unstructured model reply for consult"],
    "exactly one warning for the node",
  );
  // the tolerant boundary still produced a protocol-valid envelope
  const consult = result.messages.find((message) => message.kind === "consult")!;
  assert.equal(consult.payload.task, "build a catalog");
  assert.equal(consult.payload.ask, `${PROSE} Still prose.`);
  assert.ok(result.decision.decision);
});

test("a tolerant-parseable but schema-invalid reply also repairs (strict check, not just fences)", async () => {
  const senior = new ScriptedProvider({
    review: ['{"verdict": "approve", "notes": "looks fine", "points": []}', validReply("review")],
  });
  const harness = new TwoBrothersHarness(cfg({ mode: "consult" }), {
    senior,
    junior: new ScriptedProvider(),
  });

  const result = await harness.run("build a catalog");

  const reviewCalls = senior.callsOf("review");
  assert.equal(reviewCalls.length, 2);
  const repairRequest = reviewCalls[1].messages[reviewCalls[1].messages.length - 1].content;
  assert.ok(repairRequest.includes("verdict"), "the zod issue path is fed back");
  const review = result.messages.find((message) => message.kind === "review")!;
  assert.equal(review.payload.verdict, "accept");
  assert.deepEqual(result.errors, []);
});

test("a strict-valid reply triggers no repair and no extra call", async () => {
  const senior = new ScriptedProvider();
  const junior = new ScriptedProvider();
  const harness = new TwoBrothersHarness(cfg({ mode: "consult" }), { senior, junior });

  const result = await harness.run("build a catalog");

  assert.equal(senior.callsOf("consult").length, 1);
  assert.equal(senior.callsOf("review").length, 1);
  assert.equal(junior.callsOf("proposal").length, 1);
  assert.equal(repairEnvelopes(result.messages).length, 0);
  assert.deepEqual(
    result.messages.map((message) => message.kind),
    ["message", "consult", "proposal", "review", "decision"],
  );
});

// ---------------------------------------------------------------------------
// repair pass: session JSONL
// ---------------------------------------------------------------------------

test("the repair envelope persists in the session JSONL with dense seq", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-repair-"));
  try {
    const store = new SessionStore(path.join(dir, "session.jsonl"));
    const ctx = new SharedContext(store);
    const senior = new ScriptedProvider({ consult: [PROSE, validReply("consult")] });
    const harness = new TwoBrothersHarness(cfg({ mode: "consult" }), {
      senior,
      junior: new ScriptedProvider(),
    });
    const result = await harness.run("build a catalog", ctx);

    const lines = fs
      .readFileSync(store.path, "utf-8")
      .split(/\r?\n/)
      .filter((line) => line.trim());
    assert.equal(lines.length, ctx.events.length, "one envelope per line");
    lines.forEach((line, index) => {
      const parsed = JSON.parse(line) as { seq: number };
      assert.equal(parsed.seq, index + 1, "dense seq");
    });

    const repair = lines
      .map((line) => JSON.parse(line) as { from: string; to: string; kind: string; payload: Record<string, unknown> })
      .find((message) => String(message.payload.text ?? "").startsWith(REPAIR_REQUEST_PREFIX));
    assert.ok(repair, "the repair turn is durable");
    assert.equal(repair.from, "user");
    assert.equal(repair.to, "senior");
    assert.equal(repair.kind, "message");

    const rendered = result.context.renderTranscript();
    assert.ok(rendered.startsWith("[[TASK]]\nbuild a catalog\n[[/TASK]]\n\nContext events:"));
    assert.ok(rendered.includes(REPAIR_REQUEST_PREFIX));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// repair pass: work-mode deliverable (tool loop)
// ---------------------------------------------------------------------------

/**
 * A junior that calls one tool, then answers in prose; its repair turn (a
 * plain text completion after the tool loop) returns the deliverable JSON.
 */
class ToolThenProseProvider implements Provider {
  toolRounds = 0;
  readonly repairCalls: Call[] = [];

  async chat(messages: ChatMessage[], responseKind = "message"): Promise<string> {
    this.repairCalls.push({ kind: responseKind, messages: messages.map((message) => ({ ...message })) });
    return validReply("deliverable", { result: "Done: read the file.", artifacts: ["out.txt"] });
  }

  async chatWithTools(
    _messages: ChatMessage[],
    _tools: Tool[],
    _options: ToolChatOptions = {},
  ): Promise<ToolChatResponse> {
    this.toolRounds += 1;
    if (this.toolRounds === 1) {
      return {
        content: "",
        toolCalls: [{ id: "call-1", name: "workspace_read_file", args: { path: "out.txt" } }],
      };
    }
    return { content: PROSE, toolCalls: [] };
  }
}

test("a prose deliverable after a tool loop repairs once and keeps the tool evidence", async () => {
  const junior = new ToolThenProseProvider();
  const tool: Tool = {
    name: "workspace_read_file",
    description: "Read a file.",
    parameters: { type: "object", properties: {} },
    execute: () => JSON.stringify({ status: "ok", path: "out.txt", content: "hi" }),
  };
  const harness = new TwoBrothersHarness(cfg({ mode: "work" }), {
    senior: new MockProvider(),
    junior,
    tools: [tool],
  });

  const result = await harness.run("read the file");

  assert.equal(junior.repairCalls.length, 1, "one repair completion for the deliverable");
  const repairCall = junior.repairCalls[0];
  const last = repairCall.messages[repairCall.messages.length - 1];
  const before = repairCall.messages[repairCall.messages.length - 2];
  assert.ok(last.content.startsWith(REPAIR_REQUEST_PREFIX));
  assert.equal(before.role, "assistant");
  assert.equal(before.content, PROSE, "the model's own final reply is what gets repaired");

  const deliverable = result.messages.find((message) => message.kind === "deliverable")!;
  assert.equal(deliverable.payload.result, "Done: read the file.");
  const artifacts = deliverable.payload.artifacts as string[];
  assert.ok(artifacts.includes("out.txt"));
  assert.ok(artifacts.some((line) => line.startsWith("tool: workspace_read_file")));
  assert.deepEqual(result.errors, []);
});

// ---------------------------------------------------------------------------
// few-shot exemplars
// ---------------------------------------------------------------------------

function fencedJson(text: string): string {
  const match = /```json\n([\s\S]*?)\n```/.exec(text);
  assert.ok(match, "an exemplar fenced json block is present");
  return match[1];
}

test("every structured kind's assembly carries one strict-valid fenced example", () => {
  const cases: Array<[string, string]> = [
    ["consult", "expect"],
    ["proposal", "title"],
    ["delegation", "acceptance"],
    ["deliverable", "artifacts"],
    ["review", "verdict"],
    ["decision", "decision"],
  ];
  for (const [kind, field] of cases) {
    const assembled = assembleSystemPrompt("SYSTEM BASE", [], kind);
    assert.ok(assembled.text.startsWith("SYSTEM BASE"), "the base prompt stays the prefix");
    assert.ok(assembled.text.includes(`"${field}"`), `${kind}: example names the field`);
    const parsed = parsePayload(kind, JSON.parse(fencedJson(assembled.text)));
    assert.equal(parsed.ok, true, `${kind}: the exemplar must pass the strict schema`);
    assert.equal(
      assembled.text.split("```json").length - 1,
      1,
      `${kind}: exactly one example`,
    );
    // the audit's stable section names are untouched by the exemplar
    assert.deepEqual(assembled.sections, [PROMPT_SECTION_BASE, PROMPT_SECTION_TOOLS]);
  }
  assert.ok(!assembleSystemPrompt("BASE", [], "message").text.includes("```json"));
  assert.ok(!assembleSystemPrompt("BASE", []).text.includes("```json"));
});

test("node calls assemble the role prompt with that node's exemplar", async () => {
  const seen: Array<{ role: string; kind: string; system: string }> = [];
  class CapturingScripted extends ScriptedProvider {
    private readonly role: string;

    constructor(role: string) {
      super();
      this.role = role;
    }
    override async chat(messages: ChatMessage[], responseKind = "message"): Promise<string> {
      seen.push({
        role: this.role,
        kind: responseKind,
        system: messages.find((message) => message.role === "system")?.content ?? "",
      });
      return super.chat(messages, responseKind);
    }
  }
  const harness = new TwoBrothersHarness(cfg({ mode: "consult" }), {
    senior: new CapturingScripted("senior"),
    junior: new CapturingScripted("junior"),
  });
  await harness.run("build a catalog");

  const byNode = new Map(seen.map((call) => [`${call.role}/${call.kind}`, call.system]));
  for (const node of ["senior/consult", "junior/proposal", "senior/review", "senior/decision"]) {
    const system = byNode.get(node);
    assert.ok(system, `${node} was called`);
    assert.ok(system.includes("```json"), `${node}: carries its kind's exemplar`);
  }
});

// ---------------------------------------------------------------------------
// repair request formatting
// ---------------------------------------------------------------------------

test("repair issues are path-labelled and the list is clipped", () => {
  const issues = Array.from({ length: 60 }, (_, index) => ({
    code: "custom",
    path: ["field" + index],
    message: "Required",
  }));
  const text = buildRepairRequest("consult", issues);
  assert.ok(text.startsWith(REPAIR_REQUEST_PREFIX));
  assert.ok(text.endsWith(REPAIR_REQUEST_SUFFIX));
  assert.ok(text.includes("field0: Required"));
  const issuesLine = text.split("\n").find((line) => line.startsWith("Issues: "))!;
  assert.ok(
    issuesLine.length <= "Issues: ".length + REPAIR_ISSUE_CHARS + 2,
    `issue list clipped (~${REPAIR_ISSUE_CHARS} chars), got ${issuesLine.length}`,
  );
  assert.ok(issuesLine.includes("…"), "clipping is explicit");
});

test("strictPayloadIssues treats missing required fields as a strict failure", () => {
  assert.equal(strictPayloadIssues("consult", VALID.consult, false), null);
  const prose = strictPayloadIssues("consult", { text: "hello" }, true);
  assert.ok(prose, "prose has no structured payload");
  assert.deepEqual(prose.map((issue) => issue.path?.[0]), ["task", "ask"]);
  const badVerdict = strictPayloadIssues("review", { verdict: "approve" }, false);
  assert.ok(badVerdict);
  assert.deepEqual(badVerdict[0].path, ["verdict"]);
});