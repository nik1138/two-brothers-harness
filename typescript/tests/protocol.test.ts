/** Protocol tests. Mirrors the original prototype's suite (removed
 * 2026-11-04; see git history). */
import { test } from "node:test";
import assert from "node:assert/strict";

import { sanitizePayload } from "../src/harness.ts";
import {
  createMessage,
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
  delete (msg as Record<string, unknown>).ts;
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
