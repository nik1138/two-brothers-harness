/**
 * Real `auto` mode: the model-declared routing pre-decision (auto+solo lane,
 * design §1/§7.1). ONE plain senior `route` call, strict discipline with one
 * repair re-ask, fail-closed consult, guardrails G1–G4, and the additive
 * recording (marker envelope + auto_route event + HarnessResult.autoRoute).
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
import { resolveConfig } from "../src/config.ts";
import { SharedContext, type ChatMessage } from "../src/context.ts";
import {
  AUTO_ROUTE_PREFIX,
  PROMPT_SECTION_BASE,
  PROMPT_SECTION_TOOLS,
  ROUTE_REASON_CHARS,
  ROUTING_DIRECTIVE,
  ROUTING_WORK_AVAILABLE,
  ROUTING_WORK_UNAVAILABLE,
  replyFormatBlock,
  runFailureUsage,
  TwoBrothersHarness,
  type AutoRouteInfo,
} from "../src/harness.ts";
import { REPAIR_REQUEST_PREFIX } from "../src/payloads.ts";
import {
  MockProvider,
  ProviderAbortError,
  type Provider,
  type Tool,
  type ToolChatOptions,
  type ToolChatResponse,
  type UsageTotals,
} from "../src/provider.ts";
import type { AutoRouteEvent, RuntimeEvent } from "../src/runevents.ts";
import { COMPACTION_SUMMARY_PREFIX } from "../src/compaction.ts";
import { Workspace } from "../src/workspace.ts";

const TASK = "What is the best way to plan a small migration?";

const cfg = (mode: string) => resolveConfig({ provider: "mock", mode });

/** Strict-valid baseline replies (route defaults to consult). */
const VALID: Record<string, Record<string, unknown>> = {
  route: { route: "consult", reason: "the junior's advice would improve the answer" },
  consult: { task: "t", ask: "a", expect: "proposal", deadline_hint: "today" },
  proposal: { title: "P", answer: "A", rationale: "R", risks: [], confidence: 0.7, asks: [] },
  delegation: { work: "W", acceptance: ["done"], return: "deliverable", notes: "" },
  deliverable: { result: "R", artifacts: [], notes: "", confidence: 0.8 },
  review: { verdict: "accept", notes: "", points: [] },
  decision: { decision: "D", rationale: "", confidence: 0.7, dissent: null, accepted_proposals: [] },
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
  withTools?: boolean;
  /** Kinds whose chat call throws a plain provider failure. */
  failKinds?: string[];
  /** Invoked right before a chat reply for the kind (cancellation hooks). */
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
      if (spec.failKinds?.includes(responseKind)) {
        throw new Error(`provider failure on ${responseKind}`);
      }
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
      return { content: replyFor(options.responseKind ?? ""), toolCalls: [] };
    };
  }
  return { provider, calls };
}

function routeReply(route: string, reason: string): string {
  return JSON.stringify({ route, reason });
}

function fakeTool(name = "notes_lookup"): Tool {
  return {
    name,
    description: `fake ${name}`,
    parameters: { type: "object", properties: {} },
    execute: () => JSON.stringify({ tool: name, status: "ok" }),
  };
}

function userContent(call: RecordedCall): string {
  return call.messages.find((message) => message.role === "user")?.content ?? "";
}

function markerOf(result: { messages: Array<{ kind: string; payload: Record<string, unknown> }> }): string {
  const marker = result.messages.find(
    (message) => message.kind === "message" && String(message.payload.text ?? "").startsWith(AUTO_ROUTE_PREFIX),
  );
  return marker === undefined ? "" : String(marker.payload.text);
}

// ---------------------------------------------------------------------------
// the declared routes are honored
// ---------------------------------------------------------------------------

test("autoroute: solo is honored — task, marker, decision and END", async () => {
  const senior = makeProvider("senior", { scripts: { route: [routeReply("solo", "I can answer this from knowledge")] } });
  const junior = makeProvider("junior");
  const harness = new TwoBrothersHarness(cfg("auto"), { senior: senior.provider, junior: junior.provider });
  const result = await harness.run(TASK);
  assert.deepEqual(result.messages.map((message) => message.kind), ["message", "message", "decision"]);
  assert.deepEqual(result.messages.map((message) => [message.from, message.to]), [
    ["user", "senior"],
    ["user", "senior"],
    ["senior", "user"],
  ]);
  assert.deepEqual(result.messages.map((message) => message.seq), [1, 2, 3]);
  assert.equal(markerOf(result), `${AUTO_ROUTE_PREFIX}solo — I can answer this from knowledge`);
  assert.deepEqual(result.autoRoute, { route: "solo", reason: "I can answer this from knowledge" });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.rounds, 0);
  // The junior is never called on a solo run.
  assert.deepEqual(junior.calls, []);
});

test("autoroute: consult is honored — the existing cycle after the marker", async () => {
  const senior = makeProvider("senior", { scripts: { route: [routeReply("consult", "the junior adds risk analysis")] } });
  const junior = makeProvider("junior");
  const harness = new TwoBrothersHarness(cfg("auto"), { senior: senior.provider, junior: junior.provider });
  const result = await harness.run(TASK);
  assert.deepEqual(result.messages.map((message) => message.kind), [
    "message", "message", "consult", "proposal", "review", "decision",
  ]);
  assert.equal(markerOf(result), `${AUTO_ROUTE_PREFIX}consult — the junior adds risk analysis`);
  assert.deepEqual(result.autoRoute, { route: "consult", reason: "the junior adds risk analysis" });
  assert.deepEqual(result.errors, []);
  assert.equal(result.rounds, 0);
});

test("autoroute: the routing call happens exactly once per run (G3, no rounds consumed)", async () => {
  const senior = makeProvider("senior", { scripts: { route: [routeReply("consult", "advice helps")] } });
  const harness = new TwoBrothersHarness(cfg("auto"), { senior: senior.provider, junior: makeProvider("junior").provider });
  const result = await harness.run(TASK);
  assert.equal(senior.calls.filter((call) => call.kind === "route").length, 1);
  assert.equal(result.rounds, 0);
  assert.equal(result.messages.filter((message) => String(message.payload.text ?? "").startsWith(AUTO_ROUTE_PREFIX)).length, 1);
});

// ---------------------------------------------------------------------------
// marker bytes
// ---------------------------------------------------------------------------

test("autoroute: marker envelope is a user→senior message right after the task", async () => {
  const senior = makeProvider("senior", { scripts: { route: [routeReply("solo", "knowledge is enough")] } });
  const harness = new TwoBrothersHarness(cfg("auto"), { senior: senior.provider, junior: makeProvider("junior").provider });
  const result = await harness.run(TASK);
  const [task, marker] = result.messages;
  assert.equal(task!.payload.text, TASK);
  assert.equal(marker!.from, "user");
  assert.equal(marker!.to, "senior");
  assert.equal(marker!.kind, "message");
  assert.equal(marker!.seq, 2);
  assert.deepEqual(Object.keys(marker!.payload), ["text"]);
});

test("autoroute: reason is clipped at ROUTE_REASON_CHARS with the shared ellipsis", async () => {
  const long = "x".repeat(ROUTE_REASON_CHARS + 100);
  const senior = makeProvider("senior", { scripts: { route: [routeReply("solo", long)] } });
  const harness = new TwoBrothersHarness(cfg("auto"), { senior: senior.provider, junior: makeProvider("junior").provider });
  const result = await harness.run(TASK);
  const reason = result.autoRoute!.reason;
  assert.equal(reason.length, ROUTE_REASON_CHARS);
  assert.ok(reason.endsWith("…"));
  assert.equal(markerOf(result), `${AUTO_ROUTE_PREFIX}solo — ${reason}`);
});

test("autoroute: reason is flattened to one line for the marker", async () => {
  const senior = makeProvider("senior", { scripts: { route: [routeReply("solo", "first line\nsecond\tline  end")] } });
  const harness = new TwoBrothersHarness(cfg("auto"), { senior: senior.provider, junior: makeProvider("junior").provider });
  const result = await harness.run(TASK);
  assert.equal(result.autoRoute!.reason, "first line second line end");
  assert.ok(!markerOf(result).slice(AUTO_ROUTE_PREFIX.length).includes("\n"));
});

test("autoroute: marker precedes the first cycle envelope on consult too", async () => {
  const senior = makeProvider("senior", { scripts: { route: [routeReply("consult", "advice helps")] } });
  const harness = new TwoBrothersHarness(cfg("auto"), { senior: senior.provider, junior: makeProvider("junior").provider });
  const result = await harness.run(TASK);
  assert.equal(result.messages[1]!.payload.text, `${AUTO_ROUTE_PREFIX}consult — advice helps`);
  assert.equal(result.messages[2]!.kind, "consult");
});

// ---------------------------------------------------------------------------
// G1 — work requires a bound workspace
// ---------------------------------------------------------------------------

test("autoroute G1: work without a workspace downgrades to consult (marker/event/warning)", async () => {
  const senior = makeProvider("senior", { scripts: { route: [routeReply("work", "files must change")] } });
  const events: RuntimeEvent[] = [];
  const harness = new TwoBrothersHarness(cfg("auto"), {
    senior: senior.provider,
    junior: makeProvider("junior").provider,
    onEvent: (event) => events.push(event),
  });
  const result = await harness.run(TASK);
  assert.deepEqual(result.messages.map((message) => message.kind), [
    "message", "message", "consult", "proposal", "review", "decision",
  ]);
  assert.equal(
    markerOf(result),
    `${AUTO_ROUTE_PREFIX}consult — downgraded from work (no workspace bound): files must change`,
  );
  assert.deepEqual(result.autoRoute, {
    route: "consult",
    reason: "downgraded from work (no workspace bound): files must change",
    downgradedFrom: "work",
  });
  assert.deepEqual(result.warnings, ["auto routing downgraded work to consult: no workspace is bound"]);
  assert.deepEqual(result.errors, []);
  const routeEvent = events.find((event) => event.type === "auto_route") as AutoRouteEvent;
  assert.equal(routeEvent.route, "consult");
  assert.equal(routeEvent.downgraded_from, "work");
  assert.equal(routeEvent.requested, "auto");
});

test("autoroute G1: work WITH a bound workspace takes the delegation path", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-autoroute-"));
  try {
    const senior = makeProvider("senior", { scripts: { route: [routeReply("work", "files must change")] } });
    const harness = new TwoBrothersHarness(cfg("auto"), {
      senior: senior.provider,
      junior: new MockProvider(),
      workspace: new Workspace(root),
    });
    const result = await harness.run(TASK);
    assert.equal(markerOf(result), `${AUTO_ROUTE_PREFIX}work — files must change`);
    assert.deepEqual(result.autoRoute, { route: "work", reason: "files must change" });
    assert.ok(result.messages.some((message) => message.kind === "delegation"));
    assert.ok(result.messages.some((message) => message.kind === "deliverable"));
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(result.errors, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("autoroute: routing directive tells the truth about work availability", async () => {
  const withoutWorkspace = makeProvider("senior", { scripts: { route: [routeReply("consult", "advice helps")] } });
  const plain = new TwoBrothersHarness(cfg("auto"), {
    senior: withoutWorkspace.provider,
    junior: makeProvider("junior").provider,
  });
  await plain.run(TASK);
  const plainRoute = withoutWorkspace.calls.find((call) => call.kind === "route")!;
  assert.ok(userContent(plainRoute).includes(ROUTING_WORK_UNAVAILABLE));
  assert.ok(!userContent(plainRoute).includes(ROUTING_WORK_AVAILABLE));

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-autoroute-"));
  try {
    const withWorkspace = makeProvider("senior", { scripts: { route: [routeReply("consult", "advice helps")] } });
    const bound = new TwoBrothersHarness(cfg("auto"), {
      senior: withWorkspace.provider,
      junior: makeProvider("junior").provider,
      workspace: new Workspace(root),
    });
    await bound.run(TASK);
    const boundRoute = withWorkspace.calls.find((call) => call.kind === "route")!;
    assert.ok(userContent(boundRoute).includes(ROUTING_WORK_AVAILABLE));
    assert.ok(!userContent(boundRoute).includes(ROUTING_WORK_UNAVAILABLE));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// fail-closed degradation
// ---------------------------------------------------------------------------

const DEGRADED_WARNING = "auto routing degraded to consult: unstructured model reply for route";

for (const [label, badReply] of [
  ["prose", "I think we should just consult the junior on this one."],
  ["missing route field", JSON.stringify({ reason: "no route declared" })],
  ["unknown enum value", routeReply("delegate", "not a real route")],
  ["empty reason", routeReply("solo", "")],
] as const) {
  test(`autoroute fail-closed: ${label} → one repair → consult + ONE warning`, async () => {
    // Both the original reply AND the repair re-ask are bad: the degradation
    // path is the one under test (a good repair reply would simply route).
    const senior = makeProvider("senior", { scripts: { route: [badReply, badReply] } });
    const harness = new TwoBrothersHarness(cfg("auto"), { senior: senior.provider, junior: makeProvider("junior").provider });
    const result = await harness.run(TASK);
    assert.deepEqual(result.errors, [], "degradation is fail-soft, never a run error");
    assert.deepEqual(result.warnings, [DEGRADED_WARNING]);
    assert.deepEqual(result.autoRoute, { route: "consult", reason: "unstructured model reply for route" });
    assert.deepEqual(result.messages.map((message) => message.kind), [
      "message", "message", "message", "consult", "proposal", "review", "decision",
    ]);
    assert.equal(markerOf(result), `${AUTO_ROUTE_PREFIX}consult — unstructured model reply for route`);
    // Exactly one repair re-ask: the original route call plus the repair.
    assert.equal(senior.calls.filter((call) => call.kind === "route").length, 2);
    const repairs = result.messages.filter((message) =>
      String(message.payload.text ?? "").startsWith(REPAIR_REQUEST_PREFIX),
    );
    assert.equal(repairs.length, 1);
  });
}

test("autoroute fail-closed: a still-bad repair reply degrades once, never loops", async () => {
  const senior = makeProvider("senior", {
    scripts: { route: ["first prose reply", "second prose reply"] },
  });
  const harness = new TwoBrothersHarness(cfg("auto"), { senior: senior.provider, junior: makeProvider("junior").provider });
  const result = await harness.run(TASK);
  assert.equal(senior.calls.filter((call) => call.kind === "route").length, 2);
  assert.deepEqual(result.warnings, [DEGRADED_WARNING]);
  assert.deepEqual(result.errors, []);
  assert.equal(result.autoRoute!.route, "consult");
});

// ---------------------------------------------------------------------------
// relaxed strict parse — valid shapes never repair
// ---------------------------------------------------------------------------

test("autoroute: a bare valid route JSON is accepted without repair", async () => {
  const senior = makeProvider("senior", { scripts: { route: [routeReply("solo", "bare json is fine")] } });
  const harness = new TwoBrothersHarness(cfg("auto"), { senior: senior.provider, junior: makeProvider("junior").provider });
  const result = await harness.run(TASK);
  assert.equal(senior.calls.filter((call) => call.kind === "route").length, 1);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.autoRoute!.route, "solo");
  assert.ok(!result.messages.some((message) => String(message.payload.text ?? "").startsWith(REPAIR_REQUEST_PREFIX)));
});

test("autoroute: a fenced route JSON wrapped in prose is accepted without repair", async () => {
  const fenced = `Here is my routing decision:\n\`\`\`json\n${routeReply("solo", "fenced json is fine")}\n\`\`\`\nThat is all.`;
  const senior = makeProvider("senior", { scripts: { route: [fenced] } });
  const harness = new TwoBrothersHarness(cfg("auto"), { senior: senior.provider, junior: makeProvider("junior").provider });
  const result = await harness.run(TASK);
  assert.equal(senior.calls.filter((call) => call.kind === "route").length, 1);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.autoRoute!.route, "solo");
});

// ---------------------------------------------------------------------------
// explicit modes never route (byte-stability; goldens pin the bytes)
// ---------------------------------------------------------------------------

test("autoroute: explicit consult never enters routing", async () => {
  const senior = makeProvider("senior");
  const junior = makeProvider("junior");
  const harness = new TwoBrothersHarness(cfg("consult"), { senior: senior.provider, junior: junior.provider });
  const result = await harness.run(TASK);
  assert.ok(senior.calls.every((call) => call.kind !== "route"));
  assert.deepEqual(result.messages.map((message) => message.kind), ["message", "consult", "proposal", "review", "decision"]);
  assert.equal(result.autoRoute, undefined);
  assert.equal(markerOf(result), "");
});

test("autoroute: explicit work never enters routing", async () => {
  const senior = makeProvider("senior");
  const junior = makeProvider("junior");
  const harness = new TwoBrothersHarness(cfg("work"), { senior: senior.provider, junior: junior.provider });
  const result = await harness.run(TASK);
  assert.ok(senior.calls.every((call) => call.kind !== "route"));
  assert.deepEqual(result.messages.map((message) => message.kind), ["message", "delegation", "deliverable", "review", "decision"]);
  assert.equal(result.autoRoute, undefined);
  assert.equal(markerOf(result), "");
});

// ---------------------------------------------------------------------------
// the routing call is plain (no belt on the wire)
// ---------------------------------------------------------------------------

test("autoroute: routing call carries no tools even when a belt is configured", async () => {
  const senior = makeProvider("senior", {
    scripts: { route: [routeReply("consult", "advice helps")] },
    withTools: true,
  });
  const harness = new TwoBrothersHarness(cfg("auto"), {
    senior: senior.provider,
    junior: makeProvider("junior", { withTools: true }).provider,
    toolScopes: { shared: [fakeTool()] },
  });
  const result = await harness.run(TASK);
  const routeCall = senior.calls.find((call) => call.kind === "route")!;
  assert.equal(routeCall.channel, "chat");
  assert.deepEqual(routeCall.tools, []);
  const audit = result.promptAudits.find((entry) => entry.kind === "route")!;
  assert.deepEqual(audit.tools, []);
  assert.equal(audit.role, "senior");
  assert.deepEqual(audit.sections, [PROMPT_SECTION_BASE, PROMPT_SECTION_TOOLS]);
  const system = routeCall.messages.find((message) => message.role === "system")!.content;
  assert.ok(system.includes("You have no tools; answer from the transcript."));
});

test("autoroute: the routing directive rides BEFORE the reply-format block", async () => {
  const senior = makeProvider("senior", { scripts: { route: [routeReply("solo", "order matters")] } });
  const harness = new TwoBrothersHarness(cfg("auto"), { senior: senior.provider, junior: makeProvider("junior").provider });
  await harness.run(TASK);
  const content = userContent(senior.calls.find((call) => call.kind === "route")!);
  const block = replyFormatBlock("route");
  assert.ok(content.endsWith(block), "the request ends with the route reply-format block");
  const directiveAt = content.indexOf(ROUTING_DIRECTIVE.trim());
  const blockAt = content.indexOf("Requested payload: route");
  assert.ok(directiveAt >= 0 && directiveAt < blockAt);
  assert.ok(content.includes("Give a one-sentence reason."));
});

// ---------------------------------------------------------------------------
// recording: runtime event + result field
// ---------------------------------------------------------------------------

test("autoroute: auto_route event shape and order (event before the marker envelope)", async () => {
  const senior = makeProvider("senior", { scripts: { route: [routeReply("solo", "recorded why")] } });
  // The harness emits typed events through onEvent and envelopes through
  // onEnvelope (the server bridge turns the latter into `envelope` runtime
  // events); one unified log captures the true publication order.
  const log: Array<{ channel: "event" | "envelope"; type: string; text?: string }> = [];
  const harness = new TwoBrothersHarness(cfg("auto"), {
    senior: senior.provider,
    junior: makeProvider("junior").provider,
    onEvent: (event) => log.push({ channel: "event", type: event.type }),
    onEnvelope: (message) =>
      log.push({ channel: "envelope", type: message.kind, text: String(message.payload.text ?? "") }),
  });
  await harness.run(TASK);
  const routeIndex = log.findIndex((entry) => entry.channel === "event" && entry.type === "auto_route");
  assert.ok(routeIndex >= 0);
  const markerIndex = log.findIndex(
    (entry) => entry.channel === "envelope" && (entry.text ?? "").startsWith(AUTO_ROUTE_PREFIX),
  );
  assert.ok(markerIndex > routeIndex, "the event precedes the marker envelope publication");
  // Shape: re-emit through a typed capture for the field assertion.
  const events: RuntimeEvent[] = [];
  const shaped = new TwoBrothersHarness(cfg("auto"), {
    senior: makeProvider("senior", { scripts: { route: [routeReply("solo", "recorded why")] } }).provider,
    junior: makeProvider("junior").provider,
    onEvent: (event) => events.push(event),
  });
  await shaped.run(TASK);
  const routeEvent = events.find((event) => event.type === "auto_route") as AutoRouteEvent;
  assert.deepEqual(
    { type: routeEvent.type, route: routeEvent.route, reason: routeEvent.reason, requested: routeEvent.requested },
    { type: "auto_route", route: "solo", reason: "recorded why", requested: "auto" },
  );
  assert.equal(routeEvent.downgraded_from, undefined);
});

test("autoroute: no auto_route event and no autoRoute on explicit runs", async () => {
  const events: RuntimeEvent[] = [];
  const harness = new TwoBrothersHarness(cfg("consult"), {
    senior: makeProvider("senior").provider,
    junior: makeProvider("junior").provider,
    onEvent: (event) => events.push(event),
  });
  const result = await harness.run(TASK);
  assert.ok(!events.some((event) => event.type === "auto_route"));
  assert.equal(result.autoRoute, undefined);
});

// ---------------------------------------------------------------------------
// the mock offline demo anchor (PROTOCOL.md §11 contract — mock unchanged)
// ---------------------------------------------------------------------------

test("autoroute: mock auto run is the fail-closed consult demo (one warning, exit-0 semantics)", async () => {
  const harness = new TwoBrothersHarness(cfg("auto"), { senior: new MockProvider(), junior: new MockProvider() });
  const result = await harness.run(TASK);
  assert.deepEqual(result.messages.map((message) => message.kind), [
    "message", "message", "message", "consult", "proposal", "review", "decision",
  ]);
  assert.deepEqual(result.warnings, [DEGRADED_WARNING]);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.autoRoute, { route: "consult", reason: "unstructured model reply for route" });
  assert.equal(markerOf(result), `${AUTO_ROUTE_PREFIX}consult — unstructured model reply for route`);
  assert.equal(result.rounds, 0);
});

// ---------------------------------------------------------------------------
// steering / compaction compose at the routing boundary
// ---------------------------------------------------------------------------

test("autoroute: steering drained before routing is visible to the router", async () => {
  const senior = makeProvider("senior", { scripts: { route: [routeReply("solo", "the operator prefers solo")] } });
  let drained = false;
  const harness = new TwoBrothersHarness(cfg("auto"), {
    senior: senior.provider,
    junior: makeProvider("junior").provider,
    steering: () => {
      if (drained) return [];
      drained = true;
      return ["please answer solo if you can"];
    },
  });
  const result = await harness.run(TASK);
  const routeCall = senior.calls.find((call) => call.kind === "route")!;
  assert.ok(userContent(routeCall).includes("[[OPERATOR STEER]] please answer solo if you can"));
  // The steer envelope precedes the marker (drained at the pre-route boundary).
  const steerIndex = result.messages.findIndex((message) =>
    String(message.payload.text ?? "").startsWith("[[OPERATOR STEER]]"),
  );
  const markerIndex = result.messages.findIndex((message) =>
    String(message.payload.text ?? "").startsWith(AUTO_ROUTE_PREFIX),
  );
  assert.ok(steerIndex >= 0 && steerIndex < markerIndex);
});

test("autoroute: --compact force is consumed at the first boundary, before routing", async () => {
  // A prior cycle gives the forced compaction something to summarize (a lone
  // task head is never cut). The new task then routes against the compacted
  // context at the pre-senior_route boundary.
  const ctx = new SharedContext();
  ctx.makeAndAppend("user", "senior", "message", { text: "Earlier task about caching layers" });
  ctx.makeAndAppend("senior", "junior", "consult", VALID.consult);
  ctx.makeAndAppend("junior", "senior", "proposal", VALID.proposal);
  ctx.makeAndAppend("senior", "junior", "review", VALID.review);
  ctx.makeAndAppend("senior", "user", "decision", VALID.decision);
  const senior = makeProvider("senior", { scripts: { route: [routeReply("solo", "compacted first")] } });
  const harness = new TwoBrothersHarness(cfg("auto"), {
    senior: senior.provider,
    junior: makeProvider("junior").provider,
    compaction: { force: true, thresholdChars: 100_000, keepRecentChars: 50 },
  });
  const result = await harness.run(TASK, ctx);
  const summaryIndex = result.messages.findIndex((message) =>
    String(message.payload.text ?? "").startsWith(COMPACTION_SUMMARY_PREFIX),
  );
  const markerIndex = result.messages.findIndex((message) =>
    String(message.payload.text ?? "").startsWith(AUTO_ROUTE_PREFIX),
  );
  assert.ok(summaryIndex >= 0, "the forced compaction produced a summary");
  assert.ok(summaryIndex < markerIndex, "compaction ran before the routing decision");
  const routeCall = senior.calls.find((call) => call.kind === "route")!;
  // The transcript JSON-escapes the payload, so assert on the prefix's first
  // line (the full prefix carries newlines that render as \n escapes).
  assert.ok(
    userContent(routeCall).includes("The conversation history before this point was compacted into the following summary:"),
  );
  assert.ok(userContent(routeCall).includes("<summary>"));
});

// ---------------------------------------------------------------------------
// failure honesty
// ---------------------------------------------------------------------------

test("autoroute: a provider failure on the routing call fails the run with usage attached", async () => {
  const senior = makeProvider("senior", { failKinds: ["route"] });
  const harness = new TwoBrothersHarness(cfg("auto"), { senior: senior.provider, junior: makeProvider("junior").provider });
  await assert.rejects(
    () => harness.run(TASK),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /provider failure on route/);
      const usage = runFailureUsage(err);
      assert.ok(usage !== undefined, "the routing call's spend stays attached");
      assert.equal(usage!.model_calls, 1);
      assert.equal(usage!.input_tokens, 10);
      return true;
    },
  );
});

test("autoroute: cancelled during the routing call appends nothing after the task", async () => {
  const controller = new AbortController();
  const senior = makeProvider("senior", {
    onCall: (kind) => {
      if (kind === "route") controller.abort();
    },
  });
  // The abort alone does not throw inside the fake provider; emulate the
  // adapter contract: an aborted signal surfaces as ProviderAbortError.
  const aborting: Provider = {
    chat: async (messages, kind) => {
      if (kind === "route") {
        controller.abort();
        throw new ProviderAbortError();
      }
      return senior.provider.chat(messages, kind);
    },
  };
  const events: RuntimeEvent[] = [];
  const harness = new TwoBrothersHarness(cfg("auto"), {
    senior: aborting,
    junior: makeProvider("junior").provider,
    signal: controller.signal,
    onEvent: (event) => events.push(event),
  });
  const result = await harness.run(TASK);
  assert.equal(result.cancelled, true);
  assert.deepEqual(result.messages.map((message) => message.kind), ["message"]);
  assert.equal(result.messages[0]!.payload.text, TASK);
  assert.equal(result.autoRoute, undefined);
  assert.ok(!events.some((event) => event.type === "auto_route"));
});

test("autoroute: cancelled before the run starts writes nothing", async () => {
  const controller = new AbortController();
  controller.abort();
  const harness = new TwoBrothersHarness(cfg("auto"), {
    senior: makeProvider("senior").provider,
    junior: makeProvider("junior").provider,
    signal: controller.signal,
  });
  await assert.rejects(() => harness.run(TASK), ProviderAbortError);
});

// ---------------------------------------------------------------------------
// the route payload kind is code-only (never an envelope)
// ---------------------------------------------------------------------------

test("autoroute: no envelope ever carries the route kind", async () => {
  const roots: string[] = [];
  try {
    for (const route of ["solo", "consult", "work"] as const) {
      const senior = makeProvider("senior", { scripts: { route: [routeReply(route, "kind check")] } });
      let workspace: Workspace | undefined;
      if (route === "work") {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-autoroute-"));
        roots.push(root);
        workspace = new Workspace(root);
      }
      const harness = new TwoBrothersHarness(cfg("auto"), {
        senior: senior.provider,
        junior: makeProvider("junior").provider,
        ...(workspace !== undefined ? { workspace } : {}),
      });
      const result = await harness.run(TASK);
      assert.ok(result.messages.every((message) => message.kind !== "route"));
      assert.ok(result.context.events.every((message) => message.kind !== "route"));
    }
  } finally {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  }
});

test("autoroute: AutoRouteInfo is a plain additive projection (no context leakage)", async () => {
  const senior = makeProvider("senior", { scripts: { route: [routeReply("solo", "projection")] } });
  const harness = new TwoBrothersHarness(cfg("auto"), { senior: senior.provider, junior: makeProvider("junior").provider });
  const result = await harness.run(TASK);
  const info: AutoRouteInfo = result.autoRoute!;
  assert.deepEqual(Object.keys(info).sort(), ["reason", "route"]);
  assert.equal(JSON.parse(JSON.stringify(info)).route, "solo");
});
