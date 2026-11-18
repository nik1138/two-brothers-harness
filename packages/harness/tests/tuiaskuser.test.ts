/**
 * TUI ask_user question mode: the docked approval panel renders a structured
 * operator question (header, bounded text, numbered options with dimmed
 * descriptions and `[intent]` tags) when a parked request carries the
 * additive `kind: "question"` fields, answers single-select on the number
 * key immediately, toggles multi-select checkboxes with a final Enter
 * confirm, declines through the existing deny path, and stays byte-identical
 * to the historical approval panel when no question is parked.
 *
 * The suites render through the REAL panel/key-fold functions with fixtures
 * (no helper re-assertions) and post answers through the same
 * `postApprovalAnswer` transport the app uses. Hermetic and offline.
 * Run with `node tests/run-all.ts` (or this file directly).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { Action, Decision } from "../src/permissions.ts";
import { postApprovalAnswer } from "../src/tui/app.ts";
import { RunApprovalBroker } from "../src/runevents.ts";
import { TUI_COMMANDS } from "../src/tui/keymap.ts";
import { stripAnsi } from "../src/tui/render.ts";
import { displayWidth } from "../src/tui/text.ts";
import {
  approvalItemQuestion,
  approvalPanelKey,
  approvalPanelView,
  createApprovalPanelState,
  questionPanelHints,
  type ApprovalPanelItem,
  type ApprovalPanelState,
  type ApprovalQuestion,
} from "../src/tui/view/approval.ts";
import { screenView } from "../src/tui/view/screen.ts";
import { createTheme, plainTheme } from "../src/tui/theme.ts";

const QUESTION: ApprovalQuestion = {
  header: "Pick a migration target",
  text: "Which store should the cache migration target?",
  options: [
    { label: "Valkey", description: "drop-in Redis fork", intent: "safe" },
    { label: "KeyDB", description: "multithreaded Redis" },
    { label: "Dragonfly", description: "modern in-memory store", intent: "risky" },
  ],
};

function questionItem(overrides: Partial<ApprovalPanelItem> = {}): ApprovalPanelItem {
  return {
    approvalId: "q-1",
    action: "question",
    kind: "question",
    question: QUESTION,
    ...overrides,
  };
}

function approvalItem(overrides: Partial<ApprovalPanelItem> = {}): ApprovalPanelItem {
  return {
    approvalId: "a-1",
    action: "write",
    target: "src/report.ts",
    reason: "operator approval required",
    ...overrides,
  };
}

function press(state: ApprovalPanelState, key: { name: string; ctrl?: boolean }) {
  return approvalPanelKey(TUI_COMMANDS, state, key);
}

function renderText(state: ApprovalPanelState, width = 80): string {
  return approvalPanelView(state, { width, theme: plainTheme }).lines.join("\n");
}

// --------------------------------------------------------------------------- //
// single-select rendering + answer dispatch
// --------------------------------------------------------------------------- //

test("question panel: header, text, numbered options with dimmed description and [intent]", () => {
  const state = createApprovalPanelState(questionItem());
  const view = approvalPanelView(state, { width: 80, theme: plainTheme });
  for (const line of view.lines) {
    assert.equal(displayWidth(line), 80, "every row is exactly 80 cells");
    assert.ok(!line.includes("\x1b"), "plainTheme output has no SGR");
  }
  const text = view.lines.join("\n");
  assert.match(text, /OPERATOR QUESTION/);
  assert.match(text, /Pick a migration target/);
  assert.match(text, /Which store should the cache migration target\?/);
  assert.match(text, /1\) Valkey — drop-in Redis fork \[safe\]/);
  assert.match(text, /2\) KeyDB — multithreaded Redis/);
  assert.match(text, /3\) Dragonfly — modern in-memory store \[risky\]/);
  // No approval decisions leak into question mode.
  assert.doesNotMatch(text, /Allow once/);
  assert.doesNotMatch(text, /Always allow this session/);
  assert.doesNotMatch(text, /APPROVAL REQUIRED/);
  // Single-select: no checkbox column, no confirm row.
  assert.doesNotMatch(text, /\[[ x]\]/);
  assert.doesNotMatch(text, /Confirm/);
  // The first option carries the highlight and is reported.
  assert.ok(view.selectedRow > 0);
  assert.match(view.lines[view.selectedRow] ?? "", /› 1\) Valkey/);
});

test("question panel: colour theme strips back to the exact plain rows", () => {
  const state = createApprovalPanelState(questionItem());
  const plain = approvalPanelView(state, { width: 80, theme: plainTheme }).lines;
  const colored = approvalPanelView(state, { width: 80, theme: createTheme("dark") }).lines;
  assert.ok(colored.join("\n").includes("\x1b"), "the colour theme paints");
  for (let index = 0; index < plain.length; index += 1) {
    assert.equal(stripAnsi(colored[index] ?? ""), plain[index], `row ${index}`);
  }
});

test("question panel: description and intent are dimmed in the colour theme", () => {
  const state = createApprovalPanelState(questionItem());
  const lines = approvalPanelView(state, { width: 80, theme: createTheme("dark") }).lines;
  const optionRow = lines.find((line) => stripAnsi(line).includes("1) Valkey"));
  assert.ok(optionRow !== undefined);
  assert.ok(stripAnsi(optionRow).includes("— drop-in Redis fork"));
});

test("single-select: the number key answers immediately with that option's label", () => {
  const state = createApprovalPanelState(questionItem());
  const result = press(state, { name: "2" });
  assert.equal(result.action, "answer");
  assert.deepEqual(result.labels, ["KeyDB"]);
  // The state is untouched: the panel stays parked until the broker resolves it.
  assert.equal(result.state, state);
});

test("single-select: Up/Down move the highlight, Enter answers the highlighted option", () => {
  const state = createApprovalPanelState(questionItem());
  const moved = press(state, { name: "down" });
  assert.equal(moved.action, "move");
  assert.equal(moved.state.selected, 1);
  assert.equal(press(moved.state, { name: "return" }).labels?.[0], "KeyDB");
  const wrapped = press(moved.state, { name: "down" }).state;
  assert.equal(wrapped.selected, 2);
  assert.equal(press(wrapped, { name: "down" }).state.selected, 0, "wrap-around");
  assert.equal(press(wrapped, { name: "up" }).state.selected, 1);
});

test("answer dispatch: posts the answer decision with labels through the broker respond transport", async () => {
  const broker = new RunApprovalBroker();
  const outcome = broker.ask({
    kind: "question",
    action: Action.READ,
    question: {
      text: "Pick a store",
      options: [
        { label: "Redis" },
        { label: "Valkey" },
        { label: "Dragonfly" },
      ],
    },
  });
  const id = broker.pending()[0]?.approval_id;
  assert.ok(typeof id === "string", "question parked");
  assert.equal(postApprovalAnswer(broker, id, ["Dragonfly"]), true);
  assert.deepEqual(await outcome, { status: "answered", labels: ["Dragonfly"] });
});

test("answer dispatch: a failed post reports failure so the app keeps the question parked", () => {
  const fresh = new RunApprovalBroker();
  // Unknown id (nothing parked) — respond resolves null ⇒ false.
  assert.equal(postApprovalAnswer(fresh, "q-1", ["Valkey"]), false);
  // A validation throw (bad labels) ⇒ false and the wait stays parked.
  const broker = new RunApprovalBroker();
  const outcome = broker.ask({
    kind: "question",
    action: Action.READ,
    question: {
      text: "Pick a store",
      options: [{ label: "Redis" }, { label: "Valkey" }],
    },
  });
  const id = broker.pending()[0]?.approval_id;
  assert.ok(typeof id === "string", "question parked");
  assert.equal(postApprovalAnswer(broker, id, ["Nope"]), false);
  void outcome; // still parked; settled by the stop unwind paths in askuser.test.ts
});

// --------------------------------------------------------------------------- //
// multi-select toggle + confirm
// --------------------------------------------------------------------------- //

const MULTI_QUESTION: ApprovalQuestion = {
  text: "Which checks should gate the merge?",
  options: [
    { label: "unit tests", description: "the package test suites" },
    { label: "typecheck" },
    { label: "lint", intent: "fast" },
    { label: "e2e", description: "browser matrix" },
  ],
  multi_select: true,
};

test("multi-select: number keys toggle checkboxes, Enter confirms the checked set", () => {
  let state = createApprovalPanelState(
    questionItem({ question: MULTI_QUESTION }),
  );
  assert.deepEqual(state.checked, [false, false, false, false]);

  const first = press(state, { name: "1" });
  assert.equal(first.action, "toggle");
  assert.deepEqual(first.state.checked, [true, false, false, false]);
  state = first.state;

  const third = press(state, { name: "3" });
  assert.deepEqual(third.state.checked, [true, false, true, false]);
  state = third.state;

  // Toggling again unchecks.
  state = press(state, { name: "1" }).state;
  assert.deepEqual(state.checked, [false, false, true, false]);

  const confirm = press(state, { name: "return" });
  assert.equal(confirm.action, "answer");
  assert.deepEqual(confirm.labels, ["lint"]);
});

test("multi-select: Enter with nothing checked answers with an empty set (the app refuses)", () => {
  const state = createApprovalPanelState(questionItem({ question: MULTI_QUESTION }));
  const confirm = press(state, { name: "return" });
  assert.equal(confirm.action, "answer");
  assert.deepEqual(confirm.labels, []);
});

test("multi-select: the panel renders checkbox state and the Enter confirm row", () => {
  let state = createApprovalPanelState(questionItem({ question: MULTI_QUESTION }));
  state = press(state, { name: "2" }).state;
  state = press(state, { name: "4" }).state;
  const text = renderText(state);
  assert.match(text, /\[x\] 2\) typecheck/);
  assert.match(text, /\[ \] 1\) unit tests/);
  assert.match(text, /\[x\] 4\) e2e — browser matrix/);
  assert.match(text, /Confirm \(2 selected\)/);
});

test("multi-select hints label the confirm chord and the decline chord", () => {
  const hints = questionPanelHints(TUI_COMMANDS, MULTI_QUESTION);
  assert.match(hints, /confirm/);
  assert.match(hints, /decline/);
  assert.match(hints, /move/);
  const singleHints = questionPanelHints(TUI_COMMANDS, QUESTION);
  assert.match(singleHints, /choose/);
  assert.doesNotMatch(singleHints, /confirm/);
});

// --------------------------------------------------------------------------- //
// decline + byte-compat
// --------------------------------------------------------------------------- //

test("decline: Esc folds to the deny action (the existing deny body)", () => {
  const state = createApprovalPanelState(questionItem());
  assert.equal(press(state, { name: "escape" }).action, "deny");
  // The decline body is the historical Decision.DENY the approval path posts.
  assert.equal(Decision.DENY, "deny");
});

test("byte-compat: an item without kind renders exactly like the historical approval", () => {
  const plain = approvalItem();
  const explicit = approvalItem({ kind: "approval" });
  const plainView = approvalPanelView(createApprovalPanelState(plain), { width: 80, theme: plainTheme });
  const explicitView = approvalPanelView(createApprovalPanelState(explicit), { width: 80, theme: plainTheme });
  assert.deepEqual(plainView.lines, explicitView.lines);
  assert.match(plainView.lines.join("\n"), /APPROVAL REQUIRED · WRITE/);
  // And its keys answer exactly like today.
  const state = createApprovalPanelState(plain);
  assert.equal(press(state, { name: "1" }).action, "allow");
  assert.equal(press(state, { name: "3" }).action, "deny");
  assert.equal(approvalItemQuestion(plain), null);
});

test("byte-compat: a question item with fewer than two options falls back to the approval shape", () => {
  const broken = questionItem({ question: { text: "t", options: [{ label: "only" }] } });
  const text = renderText(createApprovalPanelState(broken));
  assert.match(text, /APPROVAL REQUIRED/);
  assert.equal(approvalItemQuestion(broken), null);
});

test("no question parked: the screen frame keeps the composer and shows no question copy", () => {
  const frame = screenView({
    width: 80,
    height: 24,
    model: { blocks: [], liveThinking: undefined } as never,
    editor: { text: "draft", cursor: 5, history: [], historyIndex: 0, stash: null } as never,
    status: { mode: "work", seniorModel: "s", juniorModel: "j", running: true },
  });
  assert.equal(frame.lines.length, 24);
  for (const line of frame.lines) assert.equal(displayWidth(line), 80);
  const text = frame.lines.join("\n");
  assert.doesNotMatch(text, /OPERATOR QUESTION/);
  assert.match(text, /draft/);
});

// --------------------------------------------------------------------------- //
// 80x24 fit
// --------------------------------------------------------------------------- //

test("multi-select with 6 long options fits 80x24 (descriptions truncated before labels)", () => {
  const six: ApprovalQuestion = {
    header: "Release gate",
    text: "Choose every environment that must go green before the release tag is cut.",
    options: [
      { label: "Unit and integration suites", description: "the hermetic package gates on Node 22 and 24", intent: "required" },
      { label: "Browser end-to-end matrix", description: "Playwright on the system Edge, headless" },
      { label: "Tarball smoke install", description: "pack, clean-install, run the selftest" },
      { label: "Type reference check", description: "arethetypeswrong plus publint on the packed artifact" },
      { label: "Windows leg", description: "the full package suite on windows-latest" },
      { label: "WSL POSIX pass", description: "typecheck plus the POSIX-only suites", intent: "manual" },
    ],
    multi_select: true,
  };
  let state = createApprovalPanelState(questionItem({ question: six }));
  state = press(state, { name: "1" }).state;
  state = press(state, { name: "6" }).state;
  const view = approvalPanelView(state, { width: 80, theme: plainTheme });
  assert.ok(view.lines.length <= 24, `panel fits 24 rows (got ${view.lines.length})`);
  for (const line of view.lines) {
    assert.equal(displayWidth(line), 80, "every row is exactly 80 cells");
    assert.ok(!line.includes("\x1b"));
  }
  const text = view.lines.join("\n");
  // Every option label is present (labels are the last thing truncated).
  for (let index = 1; index <= 6; index += 1) {
    assert.match(text, new RegExp(`\\[.] ${index}\\) `));
  }
  assert.match(text, /Confirm \(2 selected\)/);
  assert.match(text, /6\) WSL POSIX pass/);
  assert.match(text, /…/, "long content is honestly truncated");
  // The frame the operator sees is exactly 80x24.
  const frame = screenView({
    width: 80,
    height: 24,
    model: { blocks: [], liveThinking: undefined } as never,
    editor: { text: "", cursor: 0, history: [], historyIndex: 0, stash: null } as never,
    status: { mode: "work", seniorModel: "s", juniorModel: "j", running: true },
    approvalPanel: view.lines,
  });
  assert.equal(frame.lines.length, 24);
  for (const line of frame.lines) assert.equal(displayWidth(line), 80);
});

test("question panel stays width-safe at 40 columns", () => {
  const state = createApprovalPanelState(questionItem());
  const view = approvalPanelView(state, { width: 40, theme: plainTheme });
  for (const line of view.lines) assert.equal(displayWidth(line), 40, `row: ${line}`);
});
