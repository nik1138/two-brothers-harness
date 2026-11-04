/**
 * In-process run stream + NDJSON projection (`src/runstream.ts`, the
 * `HarnessOptions.onStreamEvent` channel behind `run --stream`).
 *
 * The stream is an ADDITIONAL channel: it never changes the envelopes, the
 * `RuntimeEvent` hook or the server SSE path. These tests pin the event
 * order, the repair/tool emission points, the fail-soft consumer contract,
 * and the two bounds from deepseek-harness §R3 (8 KiB fields, 32 KiB lines,
 * measured in characters — see the module doc).
 *
 * Run with: node tests/run-all.ts (or node --test tests/streaming.test.ts)
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveConfig } from "../src/config.ts";
import { main, type CliIO } from "../src/cli.ts";
import type { ChatMessage } from "../src/context.ts";
import { TwoBrothersHarness } from "../src/harness.ts";
import { REPAIR_REQUEST_PREFIX } from "../src/payloads.ts";
import { createHookRegistry } from "../src/plugins.ts";
import { createMessage } from "../src/protocol.ts";
import { MockProvider, type Tool } from "../src/provider.ts";
import {
  STREAM_FIELD_CHARS,
  STREAM_LINE_CHARS,
  toNdjsonLine,
  type EnvelopeStreamEvent,
  type ResultStreamEvent,
  type StreamEvent,
} from "../src/runstream.ts";

const cfg = (extra: Record<string, unknown> = {}) => resolveConfig({ provider: "mock", ...extra });

function fakeTool(name: string, execute?: (args: Record<string, unknown>) => string): Tool {
  return {
    name,
    description: `fake ${name}`,
    parameters: { type: "object", properties: {} },
    execute: execute ?? (() => "tool output"),
  };
}

const DELIVERABLE = JSON.stringify({
  result: "The delegated step ran.",
  artifacts: ["out.txt"],
  notes: "",
  confidence: 0.9,
});

/** Mock provider whose FIRST consult reply is prose (forces one repair pass). */
const PROSE = "I think we should proceed carefully, step by step.";

class ProseConsultMock extends MockProvider {
  private proseLeft = true;

  override async chat(messages: ChatMessage[], responseKind = "message"): Promise<string> {
    if (responseKind === "consult" && this.proseLeft) {
      this.proseLeft = false;
      return PROSE;
    }
    return super.chat(messages, responseKind);
  }
}

function collect(events: StreamEvent[]): (event: StreamEvent) => void {
  return (event) => events.push(event);
}

function labels(events: StreamEvent[]): string[] {
  return events.map((event) => {
    if (event.type === "envelope") return `envelope:${event.envelope.kind}`;
    if (event.type === "run_status") return `run_status:${event.status}`;
    return event.type;
  });
}

// ---------------------------------------------------------------------------
// (i) event order for a consult run
// ---------------------------------------------------------------------------

test("a consult run streams started → envelopes → completed → result", async () => {
  const events: StreamEvent[] = [];
  const harness = new TwoBrothersHarness(cfg({ mode: "consult" }), {
    onStreamEvent: collect(events),
  });
  const result = await harness.run("stream a consult run");

  assert.deepEqual(labels(events), [
    "run_status:started",
    "envelope:message",
    "envelope:consult",
    "envelope:proposal",
    "envelope:review",
    "envelope:decision",
    "run_status:completed",
    "result",
  ]);

  // the streamed envelopes are exactly the envelopes the result carries
  const streamed = events
    .filter((event): event is EnvelopeStreamEvent => event.type === "envelope")
    .map((event) => event.envelope.id);
  assert.deepEqual(streamed, result.messages.map((message) => message.id));

  const terminal = events[events.length - 1] as ResultStreamEvent;
  assert.deepEqual(terminal.result.decision, result.decision);
  assert.deepEqual(terminal.result.usage, result.usage);
  assert.equal(terminal.result.warnings, 0);
  assert.equal(terminal.result.sessionFile, null);
});

// ---------------------------------------------------------------------------
// (ii) the repair pass: one repair event + the repair envelope
// ---------------------------------------------------------------------------

test("a repair pass emits a repair event and the repair envelope", async () => {
  const events: StreamEvent[] = [];
  const harness = new TwoBrothersHarness(cfg({ mode: "consult" }), {
    senior: new ProseConsultMock(),
    junior: new MockProvider(),
    onStreamEvent: collect(events),
  });
  const result = await harness.run("repair my consult payload");

  const repairAt = events.findIndex((event) => event.type === "repair");
  assert.ok(repairAt >= 0, "a repair event was emitted");
  const repair = events[repairAt];
  assert.equal(repair.type, "repair");
  if (repair.type !== "repair") return;
  assert.equal(repair.role, "senior");
  assert.equal(repair.kind, "consult");

  // the repair envelope is the very next stream event (append order)
  const next = events[repairAt + 1];
  assert.equal(next.type, "envelope");
  if (next.type !== "envelope") return;
  assert.equal(next.envelope.kind, "message");
  assert.equal(next.envelope.from, "user");
  assert.ok(String(next.envelope.payload.text).startsWith(REPAIR_REQUEST_PREFIX));

  // exactly one repair for the whole run, and the run still completed
  assert.equal(events.filter((event) => event.type === "repair").length, 1);
  assert.equal(labels(events).at(-2), "run_status:completed");
  assert.equal(result.errors.length, 0);
  assert.equal(result.messages.filter((message) => message.from === "user").length, 2);
});

// ---------------------------------------------------------------------------
// (iii) tool_call / tool_result around a real tool execution
// ---------------------------------------------------------------------------

test("a work run emits tool_call/tool_result with ok status", async () => {
  const events: StreamEvent[] = [];
  let ran = 0;
  const junior = new MockProvider([{ tool: "echo", args: {} }, { text: DELIVERABLE }]);
  const harness = new TwoBrothersHarness(cfg({ mode: "work" }), {
    senior: new MockProvider(),
    junior,
    toolScopes: {
      junior: [
        fakeTool("echo", () => {
          ran += 1;
          return "tool output";
        }),
      ],
    },
    onStreamEvent: collect(events),
  });
  const result = await harness.run("delegated streaming work");

  assert.equal(ran, 1, "the tool executed once");
  const toolLabels = events
    .filter((event) => event.type === "tool_call" || event.type === "tool_result")
    .map((event) => {
      if (event.type !== "tool_call" && event.type !== "tool_result") return "";
      return `${event.type}:${event.role}:${event.tool}:${event.type === "tool_result" ? event.status : ""}`;
    });
  assert.deepEqual(toolLabels, ["tool_call:junior:echo:", "tool_result:junior:echo:ok"]);

  // the tool pair sits before the deliverable envelope it feeds
  const callAt = events.findIndex((event) => event.type === "tool_call");
  const deliverableAt = events.findIndex(
    (event) => event.type === "envelope" && event.envelope.kind === "deliverable",
  );
  assert.ok(callAt >= 0 && deliverableAt > callAt);
  assert.equal(labels(events).at(-2), "run_status:completed");
  assert.equal(result.errors.length, 0);
});

// ---------------------------------------------------------------------------
// (iv) a denying plugin hook reports tool_result status "blocked"
// ---------------------------------------------------------------------------

test("a before_tool_call deny streams tool_result status blocked", async () => {
  const events: StreamEvent[] = [];
  const hooks = createHookRegistry();
  hooks.before_tool_call.push({
    name: "before_tool_call",
    plugin: "test-policy",
    handler: () => ({ deny: "denied by stream test" }),
    diagnostics: [],
  });
  let ran = 0;
  const junior = new MockProvider([{ tool: "guarded", args: {} }, { text: DELIVERABLE }]);
  const harness = new TwoBrothersHarness(cfg({ mode: "work" }), {
    senior: new MockProvider(),
    junior,
    toolScopes: {
      junior: [
        fakeTool("guarded", () => {
          ran += 1;
          return "tool body ran";
        }),
      ],
    },
    hooks,
    onStreamEvent: collect(events),
  });
  const result = await harness.run("delegated guarded work");

  assert.equal(ran, 0, "the denied tool never executed");
  const results = events.filter(
    (event): event is Extract<StreamEvent, { type: "tool_result" }> =>
      event.type === "tool_result",
  );
  assert.equal(results.length, 1);
  assert.equal(results[0].tool, "guarded");
  assert.equal(results[0].status, "blocked");
  assert.equal(result.errors.length, 0);
});

// ---------------------------------------------------------------------------
// (v) a throwing consumer never breaks the run
// ---------------------------------------------------------------------------

test("an onStreamEvent that throws does not fail the run", async () => {
  const harness = new TwoBrothersHarness(cfg({ mode: "consult" }), {
    onStreamEvent: () => {
      throw new Error("consumer exploded");
    },
  });
  const result = await harness.run("throwing consumer");

  assert.equal(result.cancelled, false);
  assert.deepEqual(result.errors, []);
  assert.equal(typeof result.decision.decision, "string");
  assert.ok(String(result.decision.decision).length > 0);
  assert.equal(result.messages.length, 5);
});

// ---------------------------------------------------------------------------
// CLI: `run --stream` prints the same vocabulary as NDJSON on stdout
// ---------------------------------------------------------------------------

function makeIO(): CliIO & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    log: (line) => out.push(line),
    error: (line) => err.push(line),
  };
}

test("run --stream: stdout is NDJSON, one bounded parseable object per line", async () => {
  const io = makeIO();
  const code = await main(["run", "pick an approach", "--provider", "mock", "--stream"], io);

  assert.equal(code, 0);
  assert.ok(io.out.length >= 8, `expected the whole stream, got ${io.out.length} lines`);
  const events = io.out.map((line) => {
    assert.ok(line.length <= STREAM_LINE_CHARS);
    assert.ok(!line.includes("\n") && !line.includes("\r"));
    return JSON.parse(line) as StreamEvent;
  });
  assert.deepEqual(labels(events), [
    "run_status:started",
    "envelope:message",
    "envelope:consult",
    "envelope:proposal",
    "envelope:review",
    "envelope:decision",
    "run_status:completed",
    "result",
  ]);
  const terminal = events.at(-1) as ResultStreamEvent;
  assert.equal(typeof terminal.result.usage.model_calls, "number");
  assert.ok(terminal.result.usage.model_calls >= 4);
  assert.equal(typeof terminal.result.decision.decision, "string");
  // the human summary/cost line and the warning/usage lines are suppressed
  assert.deepEqual(io.err, []);
});

test("run --stream conflicts with --json / --mode print|json", async () => {
  for (const conflicting of [
    ["--json"],
    ["--json-events"],
    ["--mode", "json"],
    ["--mode", "print"],
  ]) {
    const io = makeIO();
    const code = await main(
      ["run", "pick an approach", "--provider", "mock", "--stream", ...conflicting],
      io,
    );
    assert.equal(code, 2, `expected usage exit for ${conflicting.join(" ")}`);
    assert.deepEqual(io.out, [], "no stream lines on a usage error");
    assert.equal(io.err.length, 1);
    assert.match(io.err[0], /--stream/);
    assert.match(io.err[0], /pick one/);
  }
});

// ---------------------------------------------------------------------------
// (vi) bounds: 20k field clipped, multi-field line clipped under the cap
// ---------------------------------------------------------------------------

test("a 20_000-char payload field is clipped under the field bound", () => {
  const big = "x".repeat(20_000);
  const envelope = createMessage(1, "user", "senior", "message", { text: big });
  const line = toNdjsonLine({ type: "envelope", envelope, at: "2026-11-04T00:00:00Z" });

  assert.ok(line.length <= STREAM_LINE_CHARS, `line ${line.length} <= ${STREAM_LINE_CHARS}`);
  assert.ok(!line.includes("\n"), "no raw newline in the line");
  assert.ok(!line.includes("\r"), "no raw carriage return in the line");

  const parsed = JSON.parse(line) as { envelope: { payload: { text: string } } };
  assert.equal(parsed.envelope.payload.text, `<clipped ${big.length} chars>`);
  assert.ok(big.length > STREAM_FIELD_CHARS, "the fixture really exceeds the field cap");
});

test("a multi-field event is clipped under the line bound, largest first", () => {
  const decision: Record<string, unknown> = {};
  for (let i = 0; i < 12; i++) decision[`field_${i}`] = String(i).repeat(5000);
  const event: StreamEvent = {
    type: "result",
    result: { decision, usage: { model_calls: 1, input_tokens: 1, output_tokens: 1, cached_tokens: 0 }, warnings: 0, sessionFile: null },
    at: "2026-11-04T00:00:00Z",
  };

  // 12 * 5000 chars stays under the per-field cap, so the line pass must act
  assert.ok(JSON.stringify(event).length > STREAM_LINE_CHARS);
  const line = toNdjsonLine(event);
  assert.ok(line.length <= STREAM_LINE_CHARS, `line ${line.length} <= ${STREAM_LINE_CHARS}`);
  const parsed = JSON.parse(line) as { type: string; result: { decision: Record<string, string> } };
  assert.equal(parsed.type, "result");
  const clipped = Object.values(parsed.result.decision).filter((value) =>
    value.startsWith("<clipped "),
  );
  assert.ok(clipped.length > 0, "at least one field was clipped by the line pass");
  assert.ok(
    Object.values(parsed.result.decision).some((value) => !value.startsWith("<clipped ")),
    "only as many fields as needed were clipped",
  );
});

// ---------------------------------------------------------------------------
// (vii) every line is valid JSON, newline-free NDJSON
// ---------------------------------------------------------------------------

test("every streamed line parses back as one JSON object", async () => {
  const events: StreamEvent[] = [];
  const harness = new TwoBrothersHarness(cfg({ mode: "consult" }), {
    onStreamEvent: (event) => events.push(event),
  });
  await harness.run("line one\ntask with a newline");

  assert.ok(events.length > 0);
  for (const event of events) {
    const line = toNdjsonLine(event);
    assert.equal(typeof JSON.parse(line), "object");
    assert.ok(!line.includes("\n"), `${event.type} line has no raw newline`);
    assert.ok(!line.includes("\r"), `${event.type} line has no raw carriage return`);
    assert.ok(line.length <= STREAM_LINE_CHARS);
  }
  // a payload that legitimately contains newlines stays one line
  const envelopeEvent = events.find(
    (event) => event.type === "envelope" && event.envelope.kind === "message",
  );
  assert.ok(envelopeEvent !== undefined);
  const line = toNdjsonLine(envelopeEvent);
  const parsed = JSON.parse(line) as { envelope: { payload: { text: string } } };
  assert.ok(parsed.envelope.payload.text.includes("\n"), "the newline survived as data");
});