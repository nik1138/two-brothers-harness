import assert from "node:assert/strict";
import { test } from "node:test";

import { createEditor } from "../src/tui/editor.ts";
import {
  addNotice,
  addUserBlock,
  appendEnvelopeDelta,
  commitEnvelope,
  createTuiModel,
} from "../src/tui/model.ts";
import type { Message } from "../src/protocol.ts";
import { styledWidth } from "../src/tui/screen.ts";
import { createTheme, plainTheme, resolveTheme } from "../src/tui/theme.ts";
import { composerView, renderComposer } from "../src/tui/view/composer.ts";
import {
  createDialog,
  dialogView,
  handleDialogKey,
  moveDialogSelection,
  renderErrorDialog,
} from "../src/tui/view/dialog.ts";
import {
  createPickerState,
  filterPickerItems,
  handlePickerKey,
  movePickerSelection,
  pickerView,
  renderPicker,
  selectedPickerItem,
  setPickerQuery,
} from "../src/tui/view/picker.ts";
import { renderScreen, screenView } from "../src/tui/view/screen.ts";
import { spinnerFrame, renderSpinner, SPINNER_FRAMES } from "../src/tui/view/spinner.ts";
import {
  fitStatusSegments,
  formatElapsed,
  renderStatusBar,
  statusBarSegments,
} from "../src/tui/view/statusbar.ts";
import { renderToast, renderToasts } from "../src/tui/view/toast.ts";
import {
  homeTranscriptScroll,
  latestTranscriptScroll,
  scrollTranscript,
  transcriptView,
} from "../src/tui/view/transcript.ts";
import { renderWelcome } from "../src/tui/view/welcome.ts";

function assertRows(rows: readonly string[], width: number, height?: number): void {
  if (height !== undefined) assert.equal(rows.length, height);
  for (const row of rows) assert.ok(styledWidth(row) <= width, `${JSON.stringify(row)} exceeds ${width}`);
}

function message(id: string, from: string, text: string, seq: number): Message {
  return {
    v: 1,
    id,
    seq,
    ts: "2026-11-04T00:00:00Z",
    from,
    to: from === "user" ? "senior" : "user",
    kind: "message",
    payload: { text },
  };
}

test("welcome: identity, workspace, role configuration, hints and examples", () => {
  const rows = renderWelcome({
    width: 80,
    cwd: "C:/code/project",
    sessionName: "session-1",
    mode: "work",
    seniorModel: "senior-x",
    juniorModel: "junior-y",
    examples: ["Try this task"],
  });
  const text = rows.join("\n");
  for (const expected of ["Two Brothers", "C:/code/project", "session-1", "MODE", "work", "SENIOR", "senior-x", "JUNIOR", "junior-y", "Try this task", "Enter send"]) {
    assert.ok(text.includes(expected), expected);
  }
  assertRows(rows, 80);
});

test("welcome: unset roles lead to settings and narrow layouts remain safe", () => {
  const text = renderWelcome({ width: 36, cwd: "/tmp/x" }).join("\n");
  assert.ok(text.includes("not configured"));
  assert.ok(text.includes("/settings"));
  for (const width of [1, 2, 4, 12, 36]) assertRows(renderWelcome({ width, cwd: "你😀" }), width);
});

test("status bar: exactly two semantic lines with usage, cache, cost and elapsed", () => {
  const rows = renderStatusBar({
    mode: "consult",
    seniorModel: "s",
    juniorModel: "j",
    sessionName: "one",
    cwd: "/work",
    contextTokens: 12_500,
    contextWindow: 200_000,
    inputTokens: 1_200,
    outputTokens: 300,
    cachedTokens: 50,
    cost: 0.0123,
    elapsedMs: 65_000,
    hints: "keys",
  }, { width: 300 });
  assert.equal(rows.length, 2);
  assertRows(rows, 300);
  const text = rows.join("\n");
  for (const expected of ["consult", "SENIOR s", "JUNIOR j", "context 12.5k/200k", "tokens 1.2k in · 300 out", "cache 50", "cost $0.0123", "1m 5s", "keys"]) {
    assert.ok(text.includes(expected), expected);
  }
});

test("status bar: unknown cost and missing models are honest and actionable", () => {
  const [first, second] = statusBarSegments({ mode: "work", cost: null });
  assert.ok(first.some((segment) => segment.text === "SENIOR unset"));
  assert.ok(first.some((segment) => segment.text === "JUNIOR unset"));
  assert.ok(second.some((segment) => segment.text === "cost unknown"));
  assert.ok(second.some((segment) => segment.text === "/settings configures models"));
  assert.equal(formatElapsed(Number.NaN), "0s");
});

test("status bar: narrow fitting drops whole segments instead of cutting words", () => {
  const row = fitStatusSegments([
    { text: "consult", tone: "accent" },
    { text: "a-very-long-model-name", tone: "senior" },
    { text: "ok", tone: "success" },
  ], 12);
  assert.equal(row, "consult · ok");
  assert.ok(!row.includes("very-long"));
  for (const width of [1, 4, 8, 20, 50]) {
    assertRows(renderStatusBar({ mode: "consult", seniorModel: "long-model-name", juniorModel: "j" }, { width }), width, 2);
  }
});

test("spinner: frame selection is deterministic, bounded and reduced-motion aware", () => {
  assert.equal(spinnerFrame(0), SPINNER_FRAMES[0]);
  assert.equal(spinnerFrame(1), SPINNER_FRAMES[1]);
  assert.equal(spinnerFrame(-1), SPINNER_FRAMES[SPINNER_FRAMES.length - 1]);
  assert.equal(spinnerFrame(100), SPINNER_FRAMES[0]);
  assert.equal(spinnerFrame(3, false), SPINNER_FRAMES[0]);
  const themed = renderSpinner(1, "working", { theme: createTheme("dark") });
  assert.ok(themed.includes("\u001b["));
  assert.ok(styledWidth(themed) <= 9);
  assert.equal(renderSpinner(0, "工作中"), `${SPINNER_FRAMES[0]} 工作中`);
});

test("toasts: textual levels, details and stacks wrap without truncation", () => {
  const toasts = [
    { id: "t1", level: "success" as const, text: "Saved" },
    { id: "t2", level: "error" as const, text: "Failed 你好😀", details: "line one\nline two" },
  ];
  const rows = renderToasts(toasts, { width: 30 });
  const text = rows.join("\n");
  assert.ok(text.includes("SUCCESS  Saved"));
  assert.ok(text.includes("ERROR  Failed"));
  assert.ok(text.includes("line one"));
  assertRows(rows, 30);
  assert.deepEqual(renderToast(toasts[0]!, { width: 0 }), []);
});

test("composer: contained multiline draft shows mode, both models and key hints", () => {
  const rows = renderComposer({
    width: 64,
    editor: createEditor("first line\nsecond line"),
    mode: "work",
    seniorModel: "s-model",
    juniorModel: "j-model",
  });
  const text = rows.join("\n");
  for (const expected of ["MESSAGE", "MODE work", "SENIOR s-model", "JUNIOR j-model", "first line", "second line", "Enter send", "Shift+Enter", "newline"]) {
    assert.ok(text.includes(expected), expected);
  }
  assertRows(rows, 64);
});

test("composer: bounded internal scrolling keeps a Unicode cursor visible", () => {
  const editor = { ...createEditor("你😀\n二\n三\n四\n五\n六"), cursor: 12 };
  const view = composerView({ width: 30, editor, maxRows: 2 });
  assert.equal(view.inputRows, 2);
  assert.equal(view.cursorRow, 1);
  assert.ok(view.hiddenBefore > 0);
  assert.equal(view.hiddenAfter, 0);
  assertRows(view.lines, 30);
  assert.ok(view.lines.join("\n").includes("六"));
});

test("composer: running and disabled states hide the cursor and retain draft state", () => {
  const editor = createEditor("draft");
  const running = composerView({ width: 40, editor, running: true });
  assert.equal(running.cursorRow, -1);
  assert.ok(running.lines.join("\n").includes("Esc cancel"));
  assert.equal(editor.text, "draft");
  assert.equal(editor.cursor, 5);
});

test("picker: multi-token filtering, stable ranking and selection wrap", () => {
  const items = [
    { id: "s", label: "Senior model", description: "Choose arbiter", keywords: ["settings"] },
    { id: "j", label: "Junior model", description: "Choose collaborator" },
    { id: "x", label: "Exit", description: "Leave" },
  ];
  assert.deepEqual(filterPickerItems(items, "model choose").map((item) => item.id), ["s", "j"]);
  assert.deepEqual(filterPickerItems(items, "sen").map((item) => item.id), ["s"]);
  const state = createPickerState();
  assert.equal(movePickerSelection(state, -1, 3).selected, 2);
  assert.equal(selectedPickerItem({ query: "", selected: 99 }, items)?.id, "x");
  assert.equal(setPickerQuery({ query: "x", selected: 2 }, "").selected, 0);
});

test("picker: keyboard filtering, acceptance, disabled rows and close", () => {
  const items = [
    { id: "one", label: "one" },
    { id: "two", label: "two", disabled: true, disabledReason: "running" },
  ];
  let state = createPickerState();
  const typed = handlePickerKey(state, { name: "t", raw: "t" }, items);
  assert.equal(typed.action, "filter");
  assert.equal(typed.state.query, "t");
  state = typed.state;
  const accepted = handlePickerKey(state, { name: "return", raw: "\r" }, items);
  assert.equal(accepted.action, "blocked");
  assert.equal(accepted.reason, "running");
  assert.equal(handlePickerKey(state, { name: "escape", raw: "\u001b" }, items).action, "close");
  const empty = handlePickerKey(createPickerState("zzz"), { name: "return", raw: "\r" }, items);
  assert.equal(empty.action, "none");
});

test("picker: scroll window, no-match and exact narrow geometry", () => {
  const items = Array.from({ length: 20 }, (_, index) => ({ id: String(index), label: `Item ${index}`, description: "description" }));
  const view = pickerView({ query: "", selected: 19 }, items, { width: 50, height: 8 });
  assert.equal(view.visible.length, 4);
  assert.equal(view.visible.at(-1)?.id, "19");
  assert.ok(view.selectedRow >= 0);
  assertRows(view.lines, 50, 8);
  const noMatch = renderPicker(createPickerState("nothing"), items, { width: 20, height: 5 });
  assert.ok(noMatch.join("\n").includes("No matches"));
  assertRows(noMatch, 20, 5);
  assertRows(renderPicker(createPickerState(), [], { width: 2, height: 3 }), 2, 3);
});

test("dialog: movement, acceptance, disabled action, details and Escape", () => {
  const initial = createDialog({
    title: "Confirm",
    message: "Apply this change?",
    details: "full details",
    actions: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }],
  });
  assert.equal(moveDialogSelection(initial, -1).selected, 1);
  assert.equal(handleDialogKey(initial, { name: "right" }).state.selected, 1);
  assert.equal(handleDialogKey(initial, { name: "d" }).state.showDetails, true);
  assert.equal(handleDialogKey(initial, { name: "return" }).actionId, "yes");
  assert.equal(handleDialogKey(initial, { name: "escape" }).action, "close");
  const disabled = createDialog({ title: "x", message: "x", actions: [{ id: "x", label: "X", disabled: true }] });
  assert.equal(handleDialogKey(disabled, { name: "enter" }).action, "blocked");
});

test("dialog: errors expose full details on demand and offer a real retry action id", () => {
  const error = new Error("provider timed out");
  const rows = renderErrorDialog(error, { width: 50, height: 10, retryable: true });
  const text = rows.join("\n");
  assert.ok(text.includes("ERROR"));
  assert.ok(text.includes("provider timed out"));
  assert.ok(text.includes("Retry"));
  assert.ok(text.includes("Press d for details"));
  assertRows(rows, 50, 10);
  const expanded = dialogView(createDialog({
    title: "Error",
    message: "failed",
    details: "first\nsecond",
    showDetails: true,
    actions: [{ id: "close", label: "Close" }],
  }), { width: 30, height: 8 });
  assert.ok(expanded.lines.join("\n").includes("second"));
  assert.ok(expanded.selectedRow > 0);
});

test("transcript window: stable block anchors survive resize and support home/latest", () => {
  let model = createTuiModel();
  for (let index = 0; index < 5; index += 1) {
    model = commitEnvelope(model, message(`m${index}`, index % 2 === 0 ? "senior" : "junior", `block ${index} ${"long text ".repeat(12)}`, index + 1));
  }
  const home = homeTranscriptScroll(model);
  const wide = transcriptView(model, { width: 50, height: 5, scroll: home });
  assert.equal(wide.visibleBlockIds[0], model.blocks[0]?.id);
  const narrow = transcriptView(model, { width: 24, height: 5, scroll: wide.scroll });
  assert.equal(narrow.visibleBlockIds[0], model.blocks[0]?.id);
  assertRows(narrow.lines, 24, 5);
  const moved = scrollTranscript(model, home, 4, { width: 50, height: 5 });
  assert.equal(moved.followLatest, false);
  const latest = transcriptView(model, { width: 50, height: 5, scroll: latestTranscriptScroll() });
  assert.equal(latest.atLatest, true);
  assert.ok(latest.visibleBlockIds.includes(model.blocks[4]!.id));
});

test("screen: empty and populated frames are exact, themed and overlay-safe", () => {
  const emptyModel = createTuiModel();
  const options = {
    width: 80,
    height: 30,
    model: emptyModel,
    editor: createEditor(""),
    status: {
      mode: "consult",
      seniorModel: "s",
      juniorModel: "j",
      sessionName: "new",
      cwd: "/work",
    },
    theme: plainTheme,
  };
  const empty = screenView(options);
  assert.equal(empty.transcript, null);
  assertRows(empty.lines, 80, 30);
  assert.ok(empty.lines.join("\n").includes("Two Brothers"));
  assert.equal(empty.statusLines.length, 2);

  const model = addNotice(addUserBlock(emptyModel, "hello"), "info", "ready");
  const populated = renderScreen({ ...options, model });
  assertRows(populated, 80, 30);
  assert.ok(populated.join("\n").includes("YOU"));
  const withToast = renderScreen({ ...options, model, toasts: [{ id: "t", level: "success", text: "saved" }] });
  assert.ok(withToast.join("\n").includes("saved"));
  const overlaid = renderScreen({ ...options, model, overlay: ["DIALOG"] });
  assert.ok(overlaid.join("\n").includes("DIALOG"));
  const noColor = renderScreen({ ...options, theme: resolveTheme({ env: { NO_COLOR: "1" } }) });
  assert.ok(!noColor.join("\n").includes("\u001b"));
});
