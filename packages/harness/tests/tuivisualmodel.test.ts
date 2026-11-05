import assert from "node:assert/strict";
import { test } from "node:test";

import type { Message } from "../src/protocol.ts";
import type { StreamEvent } from "../src/runstream.ts";
import {
  addNotice,
  addToolCall,
  addToolResult,
  addUserBlock,
  appendEnvelopeDelta,
  blockText,
  commitEnvelope,
  createTuiModel,
  envelopeText,
  finalizeStreamingDrafts,
  reduceModelEvent,
  startEnvelopeDraft,
  type DecisionBlock,
  type EnvelopeBlock,
  type ToolBlock,
} from "../src/tui/model.ts";
import {
  boxContentWidth,
  composeScreen,
  renderBox,
  sanitizeDisplayText,
  styledWidth,
  wrapDisplay,
} from "../src/tui/screen.ts";
import { displayWidth } from "../src/tui/text.ts";
import {
  colorEnabled,
  createTheme,
  detectThemeMode,
  plainTheme,
  resolveTheme,
} from "../src/tui/theme.ts";
import {
  labelForBlock,
  renderTranscript,
} from "../src/tui/transcript.ts";

const AT = "2026-11-04T00:00:00Z";
const ESC = "\u001b";

function message(
  id: string,
  from: string,
  kind: string,
  payload: Record<string, unknown>,
  seq = 1,
): Message {
  return { v: 1, id, seq, ts: AT, from, to: from === "user" ? "senior" : "user", kind, payload };
}

test("model: constructors preserve full text and never mutate their input", () => {
  const original = createTuiModel();
  const long = "alpha\n".repeat(2_000) + "終😀";
  const withUser = addUserBlock(original, long, { messageId: "u1", at: AT });
  const withNotice = addNotice(withUser, "error", "failed", { details: long, retryable: true });
  assert.equal(original.blocks.length, 0);
  assert.equal(withUser.blocks[0]?.kind, "user");
  assert.equal(blockText(withUser.blocks[0]!), long);
  assert.equal(blockText(withNotice.blocks[1]!), `failed\n${long}`);
  assert.deepEqual(withNotice.blocks[0], withUser.blocks[0]);
  assert.equal(withNotice.nextId, 3);
});

test("model: streamed draft commits by identity in place with authoritative full text", () => {
  const empty = createTuiModel();
  let model = appendEnvelopeDelta(empty, { role: "senior", delta: "part", at: AT });
  model = addToolCall(model, { role: "senior", tool: "read_file", callId: "call-1", args: "{\"path\":\"a\"}" });
  model = appendEnvelopeDelta(model, { role: "senior", delta: "ial" });
  const draft = model.blocks[0] as EnvelopeBlock;
  assert.equal(draft.text, "partial");
  assert.equal(draft.streaming, true);

  const committed = commitEnvelope(model, message("m-final", "senior", "message", { text: "complete\n全部 😀" }));
  assert.equal(committed.blocks.length, 2);
  assert.equal(committed.blocks[0]?.id, draft.id, "block identity survives commit");
  assert.deepEqual(committed.blocks[0], {
    id: draft.id,
    kind: "envelope",
    messageId: "m-final",
    role: "senior",
    direction: "out",
    envelopeKind: "message",
    text: "complete\n全部 😀",
    streaming: false,
    committed: true,
    seq: 1,
    at: AT,
  });
  assert.equal(draft.text, "partial", "old draft was not mutated");
  assert.deepEqual(commitEnvelope(committed, message("m-final", "senior", "message", { text: "complete\n全部 😀" })), committed);
});

test("model: concurrent role drafts resolve to their own envelopes", () => {
  let model = appendEnvelopeDelta(createTuiModel(), { role: "senior", delta: "senior draft" });
  model = appendEnvelopeDelta(model, { role: "junior", delta: "junior draft" });
  model = commitEnvelope(model, message("j1", "junior", "deliverable", { result: "junior final" }));
  model = commitEnvelope(model, message("s1", "senior", "proposal", { title: "title", answer: "senior final" }));
  assert.equal(model.blocks.length, 2);
  assert.equal(model.blocks[0]?.kind, "envelope");
  assert.equal(blockText(model.blocks[0]!), "proposal: title\nsenior final");
  assert.equal(blockText(model.blocks[1]!), "deliverable: junior final");
});

test("model: late identified deltas cannot resurrect a committed draft", () => {
  let model = startEnvelopeDraft(createTuiModel(), { role: "junior", messageId: "m1" });
  model = appendEnvelopeDelta(model, { role: "junior", messageId: "m1", delta: "draft" });
  model = commitEnvelope(model, message("m1", "junior", "message", { text: "final" }));
  const after = appendEnvelopeDelta(model, { role: "junior", messageId: "m1", delta: "late" });
  assert.equal(after, model);
  assert.equal(startEnvelopeDraft(after, { role: "junior", messageId: "m1" }), after);
  assert.equal(after.blocks.length, 1);
  assert.equal(blockText(after.blocks[0]!), "final");
});

test("model: decisions retain rationale, confidence and dissent as distinct data", () => {
  const streamed = appendEnvelopeDelta(createTuiModel(), { role: "senior", delta: "decision draft" });
  const model = commitEnvelope(streamed, message("d1", "senior", "decision", {
    decision: "Ship the focused fix.",
    rationale: "It addresses the cause.",
    confidence: "high",
    dissent: "Junior preferred a broader refactor.",
  }));
  const decision = model.blocks[0] as DecisionBlock;
  assert.equal(decision.kind, "decision");
  assert.equal(decision.text, "Ship the focused fix.");
  assert.equal(decision.dissent, "Junior preferred a broader refactor.");
  assert.equal(decision.streaming, false);
  assert.equal(blockText(decision), "Ship the focused fix.\nIt addresses the cause.\nJunior preferred a broader refactor.\nhigh");
});

test("model: user echo adoption does not merge distinct equal-text envelopes", () => {
  let model = addUserBlock(createTuiModel(), "same");
  model = commitEnvelope(model, message("u1", "user", "message", { text: "same" }, 1));
  assert.equal(model.blocks.length, 1);
  assert.equal(model.blocks[0]?.kind, "user");
  assert.equal(model.blocks[0]?.kind === "user" ? model.blocks[0].messageId : undefined, "u1");
  model = commitEnvelope(model, message("u2", "user", "message", { text: "same" }, 2));
  assert.equal(model.blocks.length, 2);
  assert.equal(model.blocks[1]?.kind === "user" ? model.blocks[1].messageId : undefined, "u2");
});

test("model: tool results pair by call id and retain unmatched results", () => {
  let model = addToolCall(createTuiModel(), { role: "junior", tool: "shell", callId: "a", args: "one" });
  model = addToolCall(model, { role: "junior", tool: "shell", callId: "b", args: "two" });
  model = addToolResult(model, { role: "junior", tool: "shell", callId: "a", status: "ok", result: "first done" });
  assert.equal(model.blocks.length, 2);
  assert.equal((model.blocks[0] as ToolBlock).status, "ok");
  assert.equal((model.blocks[0] as ToolBlock).result, "first done");
  assert.equal((model.blocks[1] as ToolBlock).status, "call");
  model = addToolResult(model, { role: "senior", tool: "other", status: "error", result: "no call" });
  assert.equal(model.blocks.length, 3);
  assert.equal((model.blocks[2] as ToolBlock).status, "error");
});

test("model: finalization drops empty drafts and marks every partial interrupted", () => {
  let model = startEnvelopeDraft(createTuiModel(), { role: "senior" });
  model = appendEnvelopeDelta(model, { role: "junior", delta: "unfinished" });
  const finalized = finalizeStreamingDrafts(model);
  assert.equal(finalized.blocks.length, 1);
  assert.deepEqual(finalized.blocks[0], {
    ...model.blocks[1],
    streaming: false,
    committed: false,
    interrupted: true,
  });
  assert.equal(model.blocks[1]?.kind === "envelope" ? model.blocks[1].streaming : undefined, true);
  assert.equal(finalizeStreamingDrafts(finalized), finalized);
});

test("model: stream reduction finalizes drafts on every terminal run state", () => {
  for (const status of ["completed", "failed", "cancelled"] as const) {
    const draft = appendEnvelopeDelta(createTuiModel(), { role: "senior", delta: "partial" });
    const event: StreamEvent = { type: "run_status", status, at: AT };
    const reduced = reduceModelEvent(draft, event);
    assert.equal(reduced.model.blocks[0]?.kind, "envelope");
    assert.equal((reduced.model.blocks[0] as EnvelopeBlock).interrupted, true);
    assert.ok(reduced.status !== undefined);
  }
});

test("model: payload projection is readable and does not impose a character cap", () => {
  const acceptance = ["one", "two"];
  assert.equal(envelopeText("delegation", { work: "implement", acceptance }), "delegation: implement\nacceptance:\n  - one\n  - two");
  assert.equal(envelopeText("unknown", { text: "x" }), "unknown: {\"text\":\"x\"}");
  const long = "x".repeat(10_000);
  assert.equal(blockText(commitEnvelope(createTuiModel(), message("m", "senior", "message", { text: long })).blocks[0]!), long);
});

test("theme: semantic dark, light and ansi16 palettes differ and paint reset safely", () => {
  for (const mode of ["dark", "light", "ansi16"] as const) {
    const theme = createTheme(mode);
    assert.equal(theme.mode, mode);
    assert.equal(theme.color, true);
    assert.ok(theme.tokens.senior !== "");
    assert.equal(theme.paint("senior", "SENIOR"), `${theme.tokens.senior}SENIOR\u001b[0m`);
    assert.equal(theme.paint("senior", ""), "");
  }
  assert.notEqual(createTheme("dark").tokens.text, createTheme("light").tokens.text);
  assert.equal(plainTheme.paint("error", "x"), "x");
});

test("theme: NO_COLOR, TERM=dumb and explicit false are authoritative", () => {
  assert.equal(colorEnabled({ NO_COLOR: "1" }), false);
  assert.equal(colorEnabled({ NO_COLOR: "" }), true);
  assert.equal(colorEnabled({ TERM: "dumb" }), false);
  assert.equal(resolveTheme({ env: { NO_COLOR: "1" }, color: true }).color, false);
  assert.equal(resolveTheme({ env: {}, color: false }).paint("error", "x"), "x");
  assert.equal(detectThemeMode({ TWO_BROTHERS_THEME: "LIGHT" }), "light");
  assert.equal(detectThemeMode({ TWO_BROTHERS_THEME: "ansi16" }), "ansi16");
  assert.equal(detectThemeMode({ COLORFGBG: "0;15" }), "light");
  assert.equal(detectThemeMode({}), "dark");
});

test("screen: sanitization removes terminal controls before display and wrapping", () => {
  const hostile = `${ESC}[31mred${ESC}[0m ${ESC}]0;title\u0007ok\r\nnext\t${ESC}7value\u0000`;
  const clean = sanitizeDisplayText(hostile);
  assert.equal(clean, "red ok\nnext    value");
  for (const row of wrapDisplay(hostile, 5)) {
    assert.ok(!row.includes(ESC));
    assert.ok(displayWidth(row) <= 5);
  }
});

test("screen: boxes and composed frames obey exact dimensions", () => {
  const theme = createTheme("ansi16");
  const width = 24;
  const content = wrapDisplay("你好 😀 abcdef", boxContentWidth(width));
  const box = renderBox(content, { width, title: "TEST", theme });
  assert.ok(box.every((row) => styledWidth(row) === width));
  const frame = composeScreen({ width: 20, height: 8, header: ["head"], body, footer: ["foot"], overlay: ["overlay"] });
  assert.equal(frame.length, 8);
  assert.ok(frame.every((row) => styledWidth(row) === 20));
  assert.ok(frame.some((row) => row.includes("overlay")));
  assert.deepEqual(composeScreen({ width: 10, height: 0 }), []);
});

const body = ["one", "two"];

test("transcript: textual roles, decision/dissent and errors survive NO_COLOR", () => {
  let model = addUserBlock(createTuiModel(), "please fix");
  model = commitEnvelope(model, message("j", "junior", "message", { text: "junior answer" }));
  model = commitEnvelope(model, message("d", "senior", "decision", { decision: "done", dissent: "not convinced" }));
  model = addNotice(model, "error", "provider failed", { details: "timeout", retryable: true });
  const rows = renderTranscript(model, { width: 80, theme: plainTheme });
  const text = rows.join("\n");
  for (const label of ["YOU", "JUNIOR", "SENIOR", "ERR", "decision: done", "dissent: not convinced", "retry: available"]) {
    assert.ok(text.includes(label), label);
  }
  assert.deepEqual(labelForBlock(model.blocks[1]!), { text: "JUNIOR", token: "junior" });
  assert.ok(!text.includes(ESC));
});

test("transcript: wrapping is width-safe for Unicode, ANSI and interrupted drafts", () => {
  let model = appendEnvelopeDelta(createTuiModel(), { role: "senior", delta: `${ESC}[31m你好😀abcdef${ESC}[0m` });
  model = finalizeStreamingDrafts(model);
  for (const width of [1, 2, 4, 9, 16, 80]) {
    const rows = renderTranscript(model, { width });
    if (width === 80) assert.ok(rows.some((row) => row.includes("interrupted")));
    for (const row of rows) {
      assert.ok(styledWidth(row) <= width, `${JSON.stringify(row)} exceeds ${width}`);
      assert.ok(!row.includes(`${ESC}[31m`), "model-provided color was stripped");
    }
  }
});

test("transcript: expanded tools bound only the view, not model detail", () => {
  let model = addToolCall(createTuiModel(), { role: "junior", tool: "read", args: "x".repeat(100) });
  model = addToolResult(model, { role: "junior", tool: "read", status: "ok", result: "line\n".repeat(30) });
  const rows = renderTranscript(model, { width: 40, expandedTools: true, maxToolRows: 4 });
  assert.ok(rows.join("\n").includes("more lines"));
  assert.ok((model.blocks[0] as ToolBlock).result!.length > 100);
});
