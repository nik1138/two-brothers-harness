/**
 * Relaxed strict parse (BACKLOG "Structured-payload discipline", fix 2).
 *
 * A node reply that carries a JSON object validating against the strict zod
 * payload schema satisfies the strict check wherever the object sits in the
 * reply — bare, in a fenced block, wrapped in prose, after a non-JSON
 * thinking block, or surrounded by stray braces. No byte-stable reply markers
 * are required and no repair re-ask or "unstructured model reply" warning is
 * spent on such a reply. The validation bar itself is unchanged: candidates
 * must pass the same strict check (zod schema + protocol-required fields), so
 * malformed JSON, schema violations and required-field gaps still repair
 * exactly once and still degrade to sanitize + one warning.
 *
 * Run with: node tests/run-all.ts (or node --test tests/)
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveConfig } from "../src/config.ts";
import type { ChatMessage } from "../src/context.ts";
import { TwoBrothersHarness } from "../src/harness.ts";
import { REPAIR_REQUEST_PREFIX, relaxedStrictPayload } from "../src/payloads.ts";
import type { Provider } from "../src/provider.ts";

const cfg = (extra: Record<string, unknown> = {}) =>
  resolveConfig({ provider: "mock", ...extra });

const PROSE = "I looked at the task and I think we should proceed carefully step by step.";

/** One strict-valid payload per structured kind (the scripted baseline). */
const VALID: Record<string, Record<string, unknown>> = {
  consult: { task: "t", ask: "a", expect: "proposal" },
  proposal: { title: "P", answer: "A", rationale: "R", risks: [], confidence: 0.7, asks: [] },
  delegation: { work: "W", acceptance: ["done"], return: "deliverable", notes: "" },
  deliverable: { result: "R", artifacts: [], notes: "", confidence: 0.8 },
  review: { verdict: "accept", notes: "", points: [] },
  decision: { decision: "D", rationale: "", confidence: 0.7, dissent: null, accepted_proposals: [] },
};

function validReply(kind: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...VALID[kind], ...extra });
}

// ---------------------------------------------------------------------------
// relaxedStrictPayload: candidate extraction and validation (unit level)
// ---------------------------------------------------------------------------

test("bare JSON objects are accepted for every structured kind", () => {
  for (const [kind, payload] of Object.entries(VALID)) {
    const found = relaxedStrictPayload(kind, JSON.stringify(payload));
    assert.deepEqual(found, payload, `${kind}: bare JSON passes the strict check`);
  }
});

test("fenced json blocks are accepted, with or without a language tag", () => {
  const payload = VALID.decision;
  for (const fence of ["```json", "```JSON", "```"]) {
    const found = relaxedStrictPayload("decision", `${fence}\n${JSON.stringify(payload)}\n\`\`\``);
    assert.deepEqual(found, payload, `${fence}: fenced payload accepted`);
  }
});

test("JSON wrapped in surrounding prose is accepted, bare and fenced", () => {
  const payload = VALID.review;
  const bare = `Based on the junior's work I conclude ${JSON.stringify(payload)} as stated.`;
  assert.deepEqual(relaxedStrictPayload("review", bare), payload, "prose + bare JSON");
  const fenced = `Here is my verdict:\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\`\nThat is all.`;
  assert.deepEqual(relaxedStrictPayload("review", fenced), payload, "prose + fenced JSON");
});

test("a non-JSON thinking block before the payload fence does not shadow it", () => {
  const payload = VALID.consult;
  const reply = [
    "Let me think this through.",
    "```",
    "scratch { not json at all",
    "```",
    "```json",
    JSON.stringify(payload),
    "```",
  ].join("\n");
  assert.deepEqual(relaxedStrictPayload("consult", reply), payload);
});

test("stray braces in prose around a bare object do not break extraction", () => {
  const payload = VALID.proposal;
  const reply = `I considered {option A} and {option B}, then settled on ${JSON.stringify(payload)}.`;
  assert.deepEqual(relaxedStrictPayload("proposal", reply), payload);
});

test("braces inside JSON string values do not confuse the span scanner", () => {
  const payload = { ...VALID.deliverable, result: "moved {old} into {new}, then done" };
  const reply = `Result: ${JSON.stringify(payload)} — shipped.`;
  assert.deepEqual(relaxedStrictPayload("deliverable", reply), payload);
});

test("the first fully valid candidate wins; earlier invalid objects are skipped", () => {
  const payload = VALID.review;
  const reply = `Draft: {"verdict": "approve"} — corrected: ${JSON.stringify(payload)}`;
  assert.deepEqual(relaxedStrictPayload("review", reply), payload);
});

test("unknown fields do not block acceptance (the zod check strips them)", () => {
  const found = relaxedStrictPayload("decision", '{"decision": "D", "note": "extra"}');
  assert.deepEqual(found, { decision: "D", note: "extra" }, "the candidate keeps its keys; sanitize drops them later");
  assert.equal(relaxedStrictPayload("consult", '{"task": "t", "ask": "a", "mood": "calm"}') !== null, true);
});

test("malformed JSON yields null", () => {
  assert.equal(relaxedStrictPayload("decision", "```json\n{\"decision\": \"D\",\n```"), null);
  assert.equal(relaxedStrictPayload("decision", "the answer is {not json} at all"), null);
  assert.equal(relaxedStrictPayload("decision", ""), null);
});

test("schema-invalid candidates yield null (wrong enum, wrong type)", () => {
  assert.equal(relaxedStrictPayload("review", '{"verdict": "approve"}'), null, "out-of-enum verdict");
  assert.equal(relaxedStrictPayload("review", '{"verdict": "accept", "points": "not-a-list"}'), null);
  assert.equal(
    relaxedStrictPayload("proposal", '{"title": "P", "answer": "A", "confidence": 9}'),
    null,
    "out-of-range confidence fails the strict schema",
  );
});

test("a zod-defaultable but protocol-required gap still yields null", () => {
  assert.equal(relaxedStrictPayload("consult", '{"ask": "only ask"}'), null, "task is required");
  assert.equal(relaxedStrictPayload("proposal", '{"title": "only title"}'), null, "answer is required");
});

test("arrays and non-structured kinds yield null", () => {
  assert.equal(relaxedStrictPayload("decision", '[{"decision": "D"}]'), null);
  assert.equal(relaxedStrictPayload("message", '{"text": "hi"}'), null, "message is free-text");
  assert.equal(relaxedStrictPayload("verify", '{"decision": "D"}'), null, "verify is not a payload kind");
});

// ---------------------------------------------------------------------------
// harness runs: no needless repair or warning for relaxed-valid replies
// ---------------------------------------------------------------------------

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

function repairEnvelopes(
  messages: Array<{ from: string; kind: string; payload: Record<string, unknown> }>,
) {
  return messages.filter(
    (message) =>
      message.from === "user" &&
      message.kind === "message" &&
      String(message.payload.text ?? "").startsWith(REPAIR_REQUEST_PREFIX),
  );
}

test("a fenced thinking block before the payload fence needs no repair", async () => {
  const consult = VALID.consult;
  const reply = [
    "Let me think this through first.",
    "```",
    "scratch { not json",
    "```",
    "Now the payload:",
    "```json",
    JSON.stringify(consult),
    "```",
  ].join("\n");
  const senior = new ScriptedProvider({ consult: [reply] });
  const harness = new TwoBrothersHarness(cfg({ mode: "consult" }), {
    senior,
    junior: new ScriptedProvider(),
  });

  const result = await harness.run("build a catalog");

  assert.equal(senior.callsOf("consult").length, 1, "no repair re-ask");
  assert.deepEqual(result.errors, [], "no unstructured-reply warning");
  assert.equal(repairEnvelopes(result.messages).length, 0);
  const envelope = result.messages.find((message) => message.kind === "consult")!;
  assert.equal(envelope.payload.task, consult.task);
  assert.equal(envelope.payload.ask, consult.ask);
});

test("a bare object in prose with stray braces needs no repair", async () => {
  const reply = `I weighed {dual-write} and {shadow-read}, and the call is ${JSON.stringify(VALID.consult)}.`;
  const senior = new ScriptedProvider({ consult: [reply] });
  const harness = new TwoBrothersHarness(cfg({ mode: "consult" }), {
    senior,
    junior: new ScriptedProvider(),
  });

  const result = await harness.run("build a catalog");

  assert.equal(senior.callsOf("consult").length, 1, "no repair re-ask");
  assert.deepEqual(result.errors, []);
  const envelope = result.messages.find((message) => message.kind === "consult")!;
  assert.equal(envelope.payload.ask, VALID.consult.ask);
});

test("an existing marked reply (one fenced json block, the exemplar form) stays accepted", async () => {
  // the exact shape the kind-specific prompt exemplar asks for
  const reply = `\`\`\`json\n${validReply("consult")}\n\`\`\``;
  const senior = new ScriptedProvider({ consult: [reply] });
  const harness = new TwoBrothersHarness(cfg({ mode: "consult" }), {
    senior,
    junior: new ScriptedProvider(),
  });

  const result = await harness.run("build a catalog");

  assert.equal(senior.callsOf("consult").length, 1);
  assert.deepEqual(result.errors, []);
  const envelope = result.messages.find((message) => message.kind === "consult")!;
  assert.equal(envelope.payload.task, "t");
  assert.equal(envelope.payload.ask, "a");
  // the transcript render stays byte-stable
  assert.ok(
    result.context.renderTranscript().startsWith("[[TASK]]\nbuild a catalog\n[[/TASK]]\n\nContext events:"),
  );
});

test("unknown fields in a relaxed reply repair nothing and are sanitized away", async () => {
  const reply = `Sure — ${JSON.stringify({ ...VALID.consult, mood: "calm", leftover: true })}`;
  const senior = new ScriptedProvider({ consult: [reply] });
  const harness = new TwoBrothersHarness(cfg({ mode: "consult" }), {
    senior,
    junior: new ScriptedProvider(),
  });

  const result = await harness.run("build a catalog");

  assert.equal(senior.callsOf("consult").length, 1, "no repair re-ask");
  assert.deepEqual(result.errors, []);
  const envelope = result.messages.find((message) => message.kind === "consult")!;
  assert.equal("mood" in envelope.payload, false, "sanitize dropped the unknown field");
  assert.equal("leftover" in envelope.payload, false);
  assert.equal(envelope.payload.task, "t");
});

test("a malformed reply still repairs exactly once and a still-bad repair warns once", async () => {
  const senior = new ScriptedProvider({
    consult: ['```json\n{"task": "t", "ask":\n```', `${PROSE} Still broken.`],
  });
  const harness = new TwoBrothersHarness(cfg({ mode: "consult" }), {
    senior,
    junior: new ScriptedProvider(),
  });

  const result = await harness.run("build a catalog");

  assert.equal(senior.callsOf("consult").length, 2, "exactly one repair re-ask, never a third call");
  assert.equal(repairEnvelopes(result.messages).length, 1);
  assert.deepEqual(
    result.errors.filter((error) => error === "unstructured model reply for consult"),
    ["unstructured model reply for consult"],
    "exactly one warning",
  );
  // the tolerant boundary still produced a protocol-valid envelope
  const envelope = result.messages.find((message) => message.kind === "consult")!;
  assert.equal(envelope.payload.task, "build a catalog");
  assert.ok(result.decision.decision);
});

test("a schema-invalid object still repairs exactly once", async () => {
  const senior = new ScriptedProvider({
    consult: [JSON.stringify({ ...VALID.consult, expect: "whatever" }), validReply("consult")],
  });
  const harness = new TwoBrothersHarness(cfg({ mode: "consult" }), {
    senior,
    junior: new ScriptedProvider(),
  });

  const result = await harness.run("build a catalog");

  assert.equal(senior.callsOf("consult").length, 2, "relaxed parse does not bypass the schema bar");
  assert.deepEqual(
    result.errors.filter((error) => error === "unstructured model reply for consult"),
    [],
    "the repaired reply is strict-valid, so no warning",
  );
  const envelope = result.messages.find((message) => message.kind === "consult")!;
  assert.equal(envelope.payload.task, "t");
});

test("a relaxed repair reply is accepted without a warning", async () => {
  // the first reply is prose; the repair answer wraps the payload in prose too
  const senior = new ScriptedProvider({
    consult: [PROSE, `Fine — ${JSON.stringify({ ...VALID.consult, ask: "repaired" })} done.`],
  });
  const harness = new TwoBrothersHarness(cfg({ mode: "consult" }), {
    senior,
    junior: new ScriptedProvider(),
  });

  const result = await harness.run("build a catalog");

  assert.equal(senior.callsOf("consult").length, 2, "one repair for the prose reply");
  assert.deepEqual(result.errors, [], "the relaxed repair reply needs no warning");
  const envelope = result.messages.find((message) => message.kind === "consult")!;
  assert.equal(envelope.payload.ask, "repaired");
});

test("a reply whose only object lacks a required field still repairs and warns", async () => {
  const scripted = new ScriptedProvider({
    consult: ['{"ask": "only the ask"}', '{"ask": "still only the ask"}'],
  });
  const harness = new TwoBrothersHarness(cfg({ mode: "consult" }), {
    senior: scripted,
    junior: new ScriptedProvider(),
  });

  const result = await harness.run("build a catalog");

  assert.equal(scripted.callsOf("consult").length, 2, "one repair, never a third call");
  assert.deepEqual(
    result.errors.filter((error) => error === "unstructured model reply for consult"),
    ["unstructured model reply for consult"],
    "the required-field gap is not silently default-filled",
  );
  const envelope = result.messages.find((message) => message.kind === "consult")!;
  assert.equal(envelope.payload.task, "build a catalog", "sanitize backfilled the task");
  assert.equal(envelope.payload.ask, "still only the ask");
});
