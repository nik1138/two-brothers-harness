/** Protocol tests. Mirrors the original prototype's suite (removed
 * 2026-11-04; see git history). */
import { test } from "node:test";
import assert from "node:assert/strict";

import { sanitizePayload } from "../src/harness.ts";
import { PAYLOAD_SCHEMAS, parsePayload } from "../src/payloads.ts";
import {
  createMessage,
  KINDS,
  parseModelOutput,
  payloadIsValid,
  validateMessage,
} from "../src/protocol.ts";

test("valid message passes validation", () => {
  const msg = createMessage(1, "senior", "junior", "consult", { task: "t", ask: "a" });
  assert.deepEqual(validateMessage(msg), []);
});

test("missing field is rejected", () => {
  const msg = createMessage(2, "senior", "junior", "proposal", { title: "x", answer: "y" });
  delete (msg as unknown as Record<string, unknown>).ts;
  assert.ok(validateMessage(msg).some((e) => e.includes("missing required field: ts")));
});

test("invalid kind is rejected", () => {
  const msg = createMessage(3, "senior", "junior", "nonsense", { x: 1 });
  assert.ok(validateMessage(msg).some((e) => e.includes("invalid 'kind'")));
});

test("invalid role is rejected", () => {
  const msg = createMessage(4, "robot", "junior", "consult", { task: "t", ask: "a" });
  assert.ok(validateMessage(msg).some((e) => e.includes("invalid 'from'")));
});

test("payload must be an object", () => {
  const msg = createMessage(5, "senior", "junior", "message", { text: "hi" });
  msg.payload = "not-an-object" as unknown as Record<string, unknown>;
  assert.ok(validateMessage(msg).some((e) => e.includes("payload must be an object")));
});

test("required payload keys are enforced", () => {
  const msg = createMessage(1, "senior", "junior", "proposal", { title: "x" });
  assert.ok(validateMessage(msg).some((e) => e.includes("answer")));
});

test("unknown payload key is rejected", () => {
  const msg = createMessage(1, "senior", "junior", "proposal", {
    title: "x",
    answer: "y",
    bogus: 1,
  });
  assert.ok(validateMessage(msg).some((e) => e.includes("not allowed")));
});

test("enum values are enforced", () => {
  const review = createMessage(1, "senior", "junior", "review", { verdict: "maybe" });
  assert.ok(validateMessage(review).some((e) => e.includes("verdict")));
  const consult = createMessage(1, "senior", "junior", "consult", {
    task: "t",
    ask: "a",
    expect: "bad",
  });
  assert.ok(validateMessage(consult).some((e) => e.includes("expect")));
});

test("payloadIsValid", () => {
  assert.equal(payloadIsValid("decision", { decision: "d" }), true);
  assert.equal(payloadIsValid("decision", { decision: "" }), false);
  assert.equal(payloadIsValid("decision", "not-a-dict"), false);
});

test("fenced JSON is parsed", () => {
  const res = parseModelOutput('```json\n{"title": "Plan", "answer": "answer"}\n```', "proposal");
  assert.equal(res.parseFailed, false);
  assert.equal(res.payload.title, "Plan");
});

test("bare JSON is parsed", () => {
  const res = parseModelOutput('{"decision": "d"}', "decision");
  assert.equal(res.parseFailed, false);
  assert.equal(res.payload.decision, "d");
});

test("JSON embedded in text is parsed", () => {
  const res = parseModelOutput('Answer: {"result": "done"} and that is all.', "deliverable");
  assert.equal(res.parseFailed, false);
  assert.equal(res.payload.result, "done");
});

test("plain text falls back", () => {
  const res = parseModelOutput("plain text", "proposal");
  assert.equal(res.parseFailed, true);
  assert.equal(res.payload.text, "plain text");
});

test("confidence is coerced", () => {
  const out = sanitizePayload("proposal", { title: "x", answer: "y", confidence: "9" }, "t");
  assert.equal(out.confidence, 1.0);
});

test("lists are coerced", () => {
  const out = sanitizePayload(
    "proposal",
    { title: "x", answer: "y", risks: "one risk", asks: null },
    "t",
  );
  assert.deepEqual(out.risks, ["one risk"]);
  assert.deepEqual(out.asks, []);
});

test("bad review verdict becomes accept", () => {
  const out = sanitizePayload("review", { verdict: "whatever" }, "t");
  assert.equal(out.verdict, "accept");
});

test("unknown keys are dropped", () => {
  const out = sanitizePayload("message", { text: "hi", bogus: 1 }, "t");
  assert.deepEqual(Object.keys(out).sort(), ["text"]);
});

test("PAYLOAD_SCHEMAS covers every protocol kind (plus the code-only route kind)", () => {
  for (const kind of KINDS) {
    assert.ok(PAYLOAD_SCHEMAS[kind], `missing schema for kind: ${kind}`);
  }
  // `route` is the auto-mode routing pre-decision: a code-only zod kind that
  // is NEVER a protocol envelope (KINDS stays frozen), so it is the one
  // deliberate addition beyond the protocol kinds.
  assert.deepEqual(
    Object.keys(PAYLOAD_SCHEMAS).filter((kind) => !(KINDS as readonly string[]).includes(kind)),
    ["route"],
  );
  assert.equal(Object.keys(PAYLOAD_SCHEMAS).length, KINDS.length + 1);
});

test("parsePayload fills pydantic-mirroring defaults", () => {
  const res = parsePayload("proposal", { title: "x", answer: "y" });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.data.title, "x");
  assert.equal(res.data.rationale, "");
  assert.deepEqual(res.data.risks, []);
  assert.deepEqual(res.data.asks, []);
  assert.equal(res.data.confidence, 0.5);
});

test("parsePayload strips unknown keys (extra=ignore parity)", () => {
  const res = parsePayload("message", { text: "hi", bogus: 1 });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.deepEqual(Object.keys(res.data), ["text"]);
});

test("parsePayload rejects out-of-range confidence (strict, unlike sanitize)", () => {
  const res = parsePayload("proposal", {
    title: "x",
    answer: "y",
    confidence: 9,
  });
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.ok(res.issues.some((i) => i.path.join(".") === "confidence"));
});

test("parsePayload accepts in-range confidence and null deadline_hint", () => {
  const res = parsePayload("consult", { task: "t", ask: "a", deadline_hint: null });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.data.expect, "proposal");
  assert.equal(res.data.deadline_hint, null);
});

test("delegation schema uses the wire key 'return'", () => {
  const okRes = parsePayload("delegation", {
    work: "w",
    acceptance: ["done"],
    return: "proposal",
  });
  assert.equal(okRes.ok, true);
  if (okRes.ok) assert.equal(okRes.data.return, "proposal");

  const badRes = parsePayload("delegation", { work: "w", return: "nonsense" });
  assert.equal(badRes.ok, false);
});

test("review verdict is required and enum-restricted", () => {
  const missing = parsePayload("review", {});
  assert.equal(missing.ok, false);
  const bad = parsePayload("review", { verdict: "maybe" });
  assert.equal(bad.ok, false);
  if (bad.ok) return;
  assert.ok(bad.issues.some((i) => i.path.join(".") === "verdict"));
  const good = parsePayload("review", { verdict: "revise" });
  assert.equal(good.ok, true);
});

test("parsePayload on an unknown kind fails with issues", () => {
  const res = parsePayload("nonsense", { x: 1 });
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.ok(res.issues.length >= 1);
});
