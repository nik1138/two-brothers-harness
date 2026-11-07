import assert from "node:assert/strict";
import { test } from "node:test";

import { createEditor } from "../src/tui/editor.ts";
import { findCommand, formatKeys, hintSegments, TUI_COMMANDS } from "../src/tui/keymap.ts";
import {
  addNotice,
  addToolCall,
  addToolResult,
  addUserBlock,
  appendEnvelopeDelta,
  commitEnvelope,
  createTuiModel,
  type ToolBlock,
  type TuiModel,
} from "../src/tui/model.ts";
import type { Message } from "../src/protocol.ts";
import { styledWidth, stripAnsi } from "../src/tui/screen.ts";
import { createTheme, plainTheme, resolveTheme } from "../src/tui/theme.ts";
import {
  toggleNewestToolExpansion,
  toolExpansionKey,
  toolFoldHint,
} from "../src/tui/transcript.ts";
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
import {
  SIDE_PANEL_MAX_PANEL_WIDTH,
  SIDE_PANEL_MIN_HEIGHT,
  SIDE_PANEL_MIN_PANEL_WIDTH,
  SIDE_PANEL_MIN_WIDTH,
  sidePanelEntries,
  sidePanelKeyTips,
  sidePanelLayout,
  sidePanelRows,
  sidePanelView,
  toggleSidePanelEnabled,
  type SidePanelState,
} from "../src/tui/view/sidepanel.ts";
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
  scrollToBlock,
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

// --------------------------------------------------------------------------- //
// tool-detail folding: footer hint
// --------------------------------------------------------------------------- //

/** A chord label resolved from the registry, never spelled by a view. */
function chord(id: string): string {
  const command = findCommand(TUI_COMMANDS, id);
  assert.ok(command, `the registry has ${id}`);
  return formatKeys(command);
}

/** One tool row with a result, optionally keyed by a call id. */
function toolModel(callId?: string): TuiModel {
  let model = addToolCall(createTuiModel(), {
    role: "junior",
    tool: "read",
    ...(callId !== undefined ? { callId } : {}),
  });
  model = addToolResult(model, {
    role: "junior",
    tool: "read",
    status: "ok",
    ...(callId !== undefined ? { callId } : {}),
    result: "line one\nline two",
  });
  return model;
}

/** The composition `statusState` performs when a tool row is on screen. */
function composedStatusHints(
  model: TuiModel,
  keys: ReadonlySet<string>,
): string | undefined {
  const fold = toolFoldHint(model, keys);
  if (fold === null) return undefined;
  return hintSegments(TUI_COMMANDS, [
    { id: fold.commandId, label: fold.label },
    { id: "palette", label: "commands" },
    { id: "help", label: "help" },
  ]);
}

test("tool fold hint: null without a tool row, then the newest row's state decides", () => {
  assert.equal(toolFoldHint(createTuiModel(), new Set()), null);
  assert.equal(toolFoldHint(addUserBlock(createTuiModel(), "hello"), new Set()), null);

  const model = toolModel("call-1");
  assert.deepEqual(toolFoldHint(model, new Set()), {
    action: "expand",
    commandId: "tool-expand",
    label: "expand tool",
  });

  const expanded = toggleNewestToolExpansion(model, new Set()).keys;
  assert.deepEqual(toolFoldHint(model, expanded), {
    action: "collapse",
    commandId: "tool-expand",
    label: "collapse tool",
  });

  // A newer row that is still collapsed flips the footer back to "expand": the
  // hint tracks the row the fold press will actually toggle, not any old key.
  const withNewer = addToolCall(model, { role: "senior", tool: "echo", callId: "call-2" });
  assert.equal(toolFoldHint(withNewer, expanded)?.action, "expand");
});

test("tool fold hint: a row without a call id uses its stable block key", () => {
  const model = toolModel();
  const block = model.blocks[0] as ToolBlock;
  assert.equal(toolExpansionKey(block), "block:b1");
  assert.equal(toolFoldHint(model, new Set())?.action, "expand");
  assert.equal(toolFoldHint(model, new Set(["block:b1"]))?.label, "collapse tool");
  // A call-id key never expands a row that has no call id.
  assert.equal(toolFoldHint(model, new Set(["call:b1"]))?.action, "expand");
});

test("status bar: a tool row adds the fold hint and keeps the default commands/help hints", () => {
  assert.equal(chord("tool-expand"), "Ctrl+T");
  const defaultHints = hintSegments(TUI_COMMANDS, [
    { id: "palette", label: "commands" },
    { id: "help", label: "help" },
  ]);
  assert.equal(defaultHints, "Ctrl+P commands · ? / F1 help");

  // No tool row: the app passes no hints at all, so the default helper text is
  // used. The hint now has priority over metrics and the duplicate settings
  // warning, so it is the first segment of row two, not the last.
  assert.equal(composedStatusHints(createTuiModel(), new Set()), undefined);
  const defaultSecond = statusBarSegments({ mode: "consult" })[1];
  assert.equal(defaultSecond[0]?.text, defaultHints);
  assert.equal(defaultSecond.at(-1)?.text, "/settings configures models");
  assert.ok(
    defaultSecond.findIndex((segment) => segment.text === defaultHints) <
      defaultSecond.findIndex((segment) => segment.text === "/settings configures models"),
    "hints are fitted before the duplicated settings warning",
  );

  const model = toolModel("call-1");
  const collapsed = composedStatusHints(model, new Set());
  assert.equal(collapsed, `${chord("tool-expand")} expand tool · ${defaultHints}`);
  const expanded = composedStatusHints(model, toggleNewestToolExpansion(model, new Set()).keys);
  assert.equal(expanded, `${chord("tool-expand")} collapse tool · ${defaultHints}`);
  assert.ok(!expanded?.includes("expand tool"), "the two labels never appear together");

  // The hint is one dim row-two segment, fitted whole like every other segment.
  const [, second] = statusBarSegments({ mode: "consult", hints: collapsed });
  assert.deepEqual(
    second.find((segment) => segment.text === collapsed),
    { text: collapsed, tone: "dim" },
  );
  assert.equal(second[0]?.text, collapsed, "the hint leads row two once activity is absent");
  for (const width of [8, 20, 32, 40, 60, 100, 160]) {
    assertRows(renderStatusBar({ mode: "consult", hints: collapsed }, { width }), width, 2);
  }
  const wide = renderStatusBar({ mode: "consult", hints: collapsed }, { width: 120 });
  assert.ok(wide[1]?.includes(`${chord("tool-expand")} expand tool`));
  assert.ok(!wide.join("").includes("\u001b"), "NO_COLOR output carries no escape byte");

  // Too narrow for the whole hint: it is dropped, never cut into a false label.
  const narrow = renderStatusBar({ mode: "consult", hints: collapsed }, { width: 40 })[1] ?? "";
  assert.equal(narrow.trimEnd(), "/settings configures models");
  assert.ok(!narrow.includes(chord("tool-expand")));
});

test("status bar: hint priority fits the fold hint at ordinary widths, before optional metrics", () => {
  // A realistic populated row two: the old last-place hint was squeezed out by
  // these metrics on an ordinary 120-column terminal.
  const metrics = {
    mode: "consult",
    seniorModel: "s",
    juniorModel: "j",
    contextTokens: 12_500,
    contextWindow: 200_000,
    inputTokens: 1_200,
    outputTokens: 300,
    cachedTokens: 50,
    cost: 0.0123,
    elapsedMs: 65_000,
  };
  const collapsed = `${chord("tool-expand")} expand tool · Ctrl+P commands · ? / F1 help`;
  assert.equal(
    (renderStatusBar({ ...metrics, hints: collapsed }, { width: 120 })[1] ?? "").trimEnd(),
    `${collapsed} · context 12.5k/200k · tokens 1.2k in · 300 out · cache 50 · 1m 5s`,
    "at 120 columns the fold hint wins a seat; cost is the first low-value metric dropped",
  );
  assert.equal(
    (renderStatusBar({ ...metrics, hints: collapsed }, { width: 80 })[1] ?? "").trimEnd(),
    `${collapsed} · context 12.5k/200k · 1m 5s`,
    "at 80 the hint still wins; tokens/cache/cost give way before it",
  );
  assert.equal(
    (renderStatusBar({ ...metrics, hints: collapsed }, { width: 60 })[1] ?? "").trimEnd(),
    `${collapsed} · 1m 5s`,
  );
  // An over-wide segment is skipped whole, so the smaller metrics after it can
  // still appear — the hint itself is never cut into a false label.
  assert.equal(
    (renderStatusBar({ ...metrics, hints: collapsed }, { width: 40 })[1] ?? "").trimEnd(),
    "context 12.5k/200k · cache 50 · 1m 5s",
  );

  // A long activity line is the highest-priority segment; the hint yields only
  // when it genuinely cannot fit, and never becomes a truncated key label.
  const activity = { mode: "consult", activity: "ready — 1200/300 tokens (in/out)" };
  const withTool = renderStatusBar({ ...activity, hints: collapsed }, { width: 120 })[1] ?? "";
  assert.ok(withTool.includes(collapsed), "activity does not evict the hint at 120");
  const narrowActivity = renderStatusBar({ ...activity, hints: collapsed }, { width: 80 })[1] ?? "";
  assert.ok(!narrowActivity.includes(chord("tool-expand")), "an over-wide hint is omitted whole");
  assert.ok(narrowActivity.includes("/settings configures models"), "the warning still fits");

  // No-tool-row behavior: the default hints now appear at 60/80 columns where
  // the old last-place segment was dropped. This is the deliberate priority
  // trade: discoverability outranks optional metrics on row two.
  assert.equal(
    (renderStatusBar({ mode: "consult" }, { width: 80 })[1] ?? "").trimEnd(),
    "Ctrl+P commands · ? / F1 help · /settings configures models",
  );
  assert.equal(
    (renderStatusBar({ mode: "consult" }, { width: 60 })[1] ?? "").trimEnd(),
    "Ctrl+P commands · ? / F1 help · /settings configures models",
  );
  assert.equal(
    (renderStatusBar({ mode: "consult" }, { width: 40 })[1] ?? "").trimEnd(),
    "Ctrl+P commands · ? / F1 help",
    "the default hint fits alone even at 40 columns",
  );

  // No width ever overflows, and every row stays exactly two lines.
  for (const width of [1, 4, 8, 20, 40, 60, 80, 100, 120, 160, 300]) {
    assertRows(renderStatusBar({ ...metrics, hints: collapsed }, { width }), width, 2);
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

test("composer: contained multiline draft shows only input and key hints", () => {
  const rows = renderComposer({
    width: 64,
    editor: createEditor("first line\nsecond line"),
    mode: "work",
    seniorModel: "s-model",
    juniorModel: "j-model",
  });
  const text = rows.join("\n");
  for (const expected of ["MESSAGE", "first line", "second line", "Enter send", "Shift+Enter", "newline"]) {
    assert.ok(text.includes(expected), expected);
  }
  // The two-line status bar owns mode/models; the composer no longer repeats
  // them in a meta row (the duplicated row cost two message rows at every
  // width and said nothing the status bar does not).
  for (const gone of ["MODE work", "SENIOR s-model", "JUNIOR j-model", "MODE "]) {
    assert.ok(!text.includes(gone), `composer must not repeat ${gone}`);
  }
  assertRows(rows, 64);

  // The compact layout stays width-safe at every narrow width, with the input
  // and hint rows still present.
  for (const width of [1, 4, 20, 28, 40]) {
    const narrow = composerView({ width, editor: createEditor("draft"), mode: "consult" });
    assertRows(narrow.lines, width);
  }
  const at28 = renderComposer({ width: 28, editor: createEditor("draft") }).join("\n");
  assert.ok(at28.includes("draft"), "the input survives the narrow layout");
  assert.ok(at28.includes("send"), "the key hint survives the narrow layout");
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

test("transcript window: a window that starts mid-block marks the cut in the label gutter", () => {
  // One long reply: the bottom-anchored window necessarily starts inside it.
  let model = createTuiModel();
  model = commitEnvelope(
    model,
    message("m0", "senior", "long reply " + "word ".repeat(200), 1),
  );
  for (const width of [40, 60, 80, 120]) {
    const latest = transcriptView(model, { width, height: 5, scroll: latestTranscriptScroll() });
    assertRows(latest.lines, width, 5);
    assert.ok(latest.startRow > 0, `${width}: the window starts inside the block`);
    const top = latest.lines[0] ?? "";
    assert.ok(stripAnsi(top).includes("⋯"), `${width}: the mid-block cut is marked`);
    assert.equal(styledWidth(top), width, "the marker swaps gutter cells, never adds width");
    assert.ok(stripAnsi(top).startsWith("       ⋯"), "the marker sits in the label gutter");
    assert.ok(!top.includes("\u001b"), "NO_COLOR output carries no escape byte");
    assert.ok(
      !stripAnsi(latest.lines.join("\n")).includes("SENIOR"),
      "the hidden label row is not re-invented at the top",
    );
  }

  // A window that starts at a block boundary shows no marker: the blank
  // separator and the next block's label row are both honest starts.
  let two = createTuiModel();
  two = commitEnvelope(two, message("a", "senior", "first block " + "text ".repeat(40), 1));
  two = commitEnvelope(two, message("b", "junior", "second block " + "text ".repeat(40), 2));
  const target = two.blocks[1];
  assert.ok(target !== undefined);
  const anchored = transcriptView(two, {
    width: 60,
    height: 6,
    scroll: scrollToBlock(target.id),
  });
  assertRows(anchored.lines, 60, 6);
  assert.equal(anchored.visibleBlockIds[0], target.id);
  assert.equal(stripAnsi(anchored.lines[0] ?? "").trim(), "", "the separator row starts the window");
  assert.ok(!(anchored.lines[0] ?? "").includes("⋯"), "a separator start is not a mid-block cut");
  assert.ok(
    stripAnsi(anchored.lines[1] ?? "").startsWith("JUNIOR"),
    "the next row is the block label, so the top is not cut",
  );

  // Home is the first label row and is never marked.
  const home = transcriptView(two, { width: 60, height: 6, scroll: homeTranscriptScroll(two) });
  assert.ok(stripAnsi(home.lines[0] ?? "").startsWith("SENIOR"));
  assert.ok(!(home.lines[0] ?? "").includes("⋯"));

  // Compact rows have no label gutter, so the marker is not drawn there and
  // the exact-width contract is untouched.
  const compact = transcriptView(model, {
    width: 12,
    height: 4,
    scroll: latestTranscriptScroll(),
  });
  assertRows(compact.lines, 12, 4);
  assert.ok(!compact.lines.join("\n").includes("⋯"));
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

// --------------------------------------------------------------------------- //
// responsive status side panel (P1)
// --------------------------------------------------------------------------- //

const PANEL_STATE: SidePanelState = {
  mode: "consult",
  seniorModel: "senior-x",
  juniorModel: "junior-y",
  seniorKind: "openai-compatible",
  juniorKind: "openai-compatible",
  provider: "openai",
  sessionName: "session-1.jsonl",
  resume: true,
  cwd: "C:/code/project",
  contextTokens: 12_500,
  contextWindow: 200_000,
  inputTokens: 1_200,
  outputTokens: 300,
  cachedTokens: 50,
  cost: 0.0123,
  elapsedMs: 65_000,
  compaction: { mode: "tokens", threshold: 120_000, keepRecent: 10_000 },
  discovery: {
    plugins: { loaded: 2, errors: 1 },
    skills: { shared: 3, senior: 1, junior: 0 },
    commands: 4,
    mcp: { configPath: "C:/code/mcp.json", pluginServers: 1 },
  },
};

function panelValues(state: SidePanelState): Map<string, string> {
  return new Map(sidePanelEntries(state).map((cell) => [cell.label, cell.value]));
}

test("side panel: visible only at 100x30 and up, and widths always add up", () => {
  const narrow = sidePanelLayout(80, 24);
  assert.equal(narrow.visible, false);
  assert.equal(narrow.reason, "narrow");
  assert.equal(narrow.panelWidth, 0);
  assert.equal(narrow.transcriptWidth, 80, "80x24 keeps the full transcript width");

  const short = sidePanelLayout(120, SIDE_PANEL_MIN_HEIGHT - 1);
  assert.equal(short.visible, false);
  assert.equal(short.reason, "short");
  assert.equal(short.transcriptWidth, 120);

  for (const [width, height] of [[100, 30], [140, 40], [220, 60]] as const) {
    const layout = sidePanelLayout(width, height);
    assert.equal(layout.visible, true, `${width}x${height}`);
    assert.equal(layout.reason, "visible");
    assert.equal(layout.transcriptWidth + layout.panelWidth, width);
    assert.ok(layout.panelWidth >= SIDE_PANEL_MIN_PANEL_WIDTH);
    assert.ok(layout.panelWidth <= SIDE_PANEL_MAX_PANEL_WIDTH);
    assert.ok(layout.transcriptWidth >= 60, "the transcript is never starved");
  }
  assert.equal(sidePanelLayout(SIDE_PANEL_MIN_WIDTH, 20).visible, true);
  assert.equal(sidePanelLayout(SIDE_PANEL_MIN_WIDTH - 1, 40).visible, false);

  const disabled = sidePanelLayout(120, 40, { enabled: false });
  assert.equal(disabled.visible, false);
  assert.equal(disabled.reason, "disabled");
  assert.equal(disabled.transcriptWidth, 120);
  assert.equal(sidePanelLayout(120, 40, { overlayOpen: true }).reason, "overlay");

  for (const [width, height] of [[0, 0], [1, 1], [99, 19], [100, 19]] as const) {
    const layout = sidePanelLayout(width, height);
    assert.equal(layout.transcriptWidth, width);
    assert.equal(layout.panelWidth, 0);
  }
});

test("side panel: exact box geometry, width-safe rows and ellipsis truncation", () => {
  for (const width of [SIDE_PANEL_MIN_PANEL_WIDTH, 34, SIDE_PANEL_MAX_PANEL_WIDTH]) {
    const rows = sidePanelView(PANEL_STATE, { width, height: 21 });
    assert.equal(rows.length, 21);
    for (const row of rows) {
      assert.equal(styledWidth(row), width, JSON.stringify(row));
      assert.ok(!row.includes("\u001b"), "plain rendering leaks no ANSI");
    }
  }
  const text = sidePanelView(PANEL_STATE, { width: 34, height: 21 }).join("\n");
  assert.ok(text.includes("STATUS"), "box title");
  assert.ok(text.includes("╭") && text.includes("╯"), "box drawing matches the other views");

  const long = sidePanelView(
    { ...PANEL_STATE, cwd: `C:/code/${"x".repeat(120)}` },
    { width: 34, height: 21 },
  ).join("\n");
  assert.ok(long.includes("…"), "long values truncate with an ellipsis");
  for (const row of long.split("\n")) assert.ok(styledWidth(row) <= 34);

  // A hostile value never reaches the terminal as a control sequence.
  const hostile = sidePanelRows(
    { ...PANEL_STATE, cwd: `\u001b[31mred\u0007/${"y".repeat(40)}` },
    26,
  );
  for (const row of hostile) {
    assert.ok(!row.includes("\u001b"), "no ANSI leakage");
    assert.ok(styledWidth(row) <= 26);
  }

  // Degenerate sizes stay exact so a resize can never emit a torn frame.
  for (const [width, height] of [[0, 0], [1, 1], [2, 3], [3, 2], [4, 4], [10, 2]] as const) {
    const rows = sidePanelView(PANEL_STATE, { width, height });
    assert.equal(rows.length, height, `${width}x${height}`);
    for (const row of rows) assert.ok(styledWidth(row) <= width);
  }
});

test("side panel: known values reuse the status formatters", () => {
  const values = panelValues(PANEL_STATE);
  assert.equal(values.get("MODE"), "consult");
  assert.equal(values.get("SENIOR"), "senior-x · openai-compatible");
  assert.equal(values.get("JUNIOR"), "junior-y · openai-compatible");
  assert.equal(values.get("PROVIDER"), "openai");
  assert.equal(values.get("SESSION"), "session-1.jsonl · resume");
  assert.equal(values.get("CWD"), "C:/code/project");
  assert.equal(values.get("CONTEXT"), "12.5k / 200k");
  assert.equal(values.get("TOKENS"), "in 1.2k · out 300");
  assert.equal(values.get("CACHE"), "50");
  assert.equal(values.get("COST"), "$0.0123");
  assert.equal(values.get("ELAPSED"), "1m 5s");
  assert.equal(values.get("COMPACT"), "auto 120k tok · keep 10.0k");
  assert.equal(values.get("PLUGINS"), "2 loaded · 1 error");
  assert.equal(values.get("SKILLS"), "shared 3 · senior 1 · junior 0");
  assert.equal(values.get("COMMANDS"), "4");
  assert.equal(values.get("MCP"), "mcp.json · 1 plugin");

  const running = panelValues({ ...PANEL_STATE, running: true });
  assert.equal(running.get("MODE"), "consult · running");

  assert.deepEqual(sidePanelKeyTips(), ["Ctrl+P commands · ? help", "Ctrl+T tools · Ctrl+B panel"]);
});

test("side panel: unknown values stay honest and never invent numbers", () => {
  const values = panelValues({ mode: "work", cost: null });
  assert.equal(values.get("SENIOR"), "(unset)");
  assert.equal(values.get("JUNIOR"), "(unset)");
  assert.equal(values.get("PROVIDER"), "unknown");
  assert.equal(values.get("SESSION"), "in-memory");
  assert.equal(values.get("CWD"), "unknown");
  assert.equal(values.get("CONTEXT"), "unknown / unknown");
  assert.equal(values.get("TOKENS"), "unknown");
  assert.equal(values.get("CACHE"), "unknown");
  assert.equal(values.get("COST"), "cost unknown");
  assert.equal(values.get("ELAPSED"), "unknown");
  assert.equal(values.get("COMPACT"), "unknown");
  assert.equal(values.get("PLUGINS"), "unknown");
  assert.equal(values.get("SKILLS"), "unknown");
  assert.equal(values.get("COMMANDS"), "unknown");
  assert.equal(values.get("MCP"), "unknown");
  for (const cell of sidePanelEntries({ mode: "work", cost: null })) {
    assert.ok(!/\$\d/.test(cell.value), "an unknown price is never fabricated");
  }

  // A configured "off" and an empty MCP set are facts, not unknowns.
  const off = panelValues({ mode: "work", compaction: { mode: "off" }, discovery: { mcp: {} } });
  assert.equal(off.get("COMPACT"), "off");
  assert.equal(off.get("MCP"), "none configured");
});

test("screen: 80x24 is byte-identical, 100x30 and 140x40 gain the right-hand panel", () => {
  const model = addUserBlock(createTuiModel(), "hello");
  const base = {
    model,
    editor: createEditor("draft"),
    status: { mode: "consult", seniorModel: "s", juniorModel: "j", sessionName: "s1", cwd: "/work" },
    theme: plainTheme,
  } as const;
  const compact = screenView({ ...base, width: 80, height: 24 });
  const withState = screenView({ ...base, width: 80, height: 24, sidePanel: PANEL_STATE });
  assert.deepEqual(withState.lines, compact.lines, "a hidden panel changes nothing");
  assert.equal(withState.sidePanel?.layout.visible, false);
  assert.equal(compact.sidePanel, null);

  for (const [width, height] of [[100, 30], [140, 40]] as const) {
    const frame = screenView({ ...base, width, height, sidePanel: PANEL_STATE });
    const panel = frame.sidePanel;
    assert.ok(panel !== null, `${width}x${height} reports a panel layout`);
    assert.equal(panel.layout.visible, true, `${width}x${height}`);
    assert.equal(panel.layout.transcriptWidth + panel.layout.panelWidth, width);
    assertRows(frame.lines, width, height);
    assert.ok(frame.lines.join("\n").includes("STATUS"), `${width}x${height} shows the panel`);
    const bodyTop = stripAnsi(frame.lines[0] ?? "");
    assert.equal(
      bodyTop[panel.layout.transcriptWidth],
      "╭",
      "the panel box starts right after the transcript",
    );
  }

  // Composer and status bar keep the full width and never move.
  const wide = screenView({ ...base, width: 100, height: 30, sidePanel: PANEL_STATE });
  const plainWide = screenView({ ...base, width: 100, height: 30 });
  const footerRows = wide.composer.lines.length + wide.statusLines.length;
  assert.deepEqual(
    wide.lines.slice(-footerRows),
    plainWide.lines.slice(-footerRows),
    "the footer is identical with and without the panel",
  );
  assert.ok(!wide.lines.slice(-footerRows).join("\n").includes("STATUS"));
});

test("screen: a full-screen overlay hides the panel without moving the composer", () => {
  const model = addUserBlock(createTuiModel(), "hello");
  const base = {
    model,
    editor: createEditor("draft"),
    status: { mode: "consult", seniorModel: "s", juniorModel: "j" },
    theme: plainTheme,
    width: 120,
    height: 30,
    sidePanel: PANEL_STATE,
  } as const;
  const open = screenView(base);
  const overlaid = screenView({ ...base, overlay: ["DIALOG"] });
  assert.equal(overlaid.sidePanel?.layout.reason, "overlay");
  assert.ok(!overlaid.lines.join("\n").includes("STATUS"));
  const footerRows = overlaid.composer.lines.length + overlaid.statusLines.length;
  assert.deepEqual(
    overlaid.lines.slice(-footerRows),
    open.lines.slice(-footerRows),
    "an overlay does not move the composer or the status bar",
  );
  assert.ok(overlaid.lines.join("\n").includes("DIALOG"));
});

test("side panel: resize recomputes immediately and the toggle choice sticks", () => {
  const model = createTuiModel();
  const base = {
    model,
    editor: createEditor(""),
    status: { mode: "consult", seniorModel: "s", juniorModel: "j", cwd: "/work" },
    theme: plainTheme,
    sidePanel: PANEL_STATE,
  } as const;
  const small = screenView({ ...base, width: 90, height: 24 });
  const large = screenView({ ...base, width: 120, height: 30 });
  const back = screenView({ ...base, width: 90, height: 24 });
  assert.ok(!small.lines.join("\n").includes("STATUS"), "narrow frames have no panel");
  assert.ok(large.lines.join("\n").includes("STATUS"), "a wider frame gains the panel");
  assert.deepEqual(back.lines, small.lines, "shrinking restores the exact earlier frame");

  assert.equal(toggleSidePanelEnabled(null), false, "the first press hides a size-driven panel");
  assert.equal(toggleSidePanelEnabled(true), false);
  assert.equal(toggleSidePanelEnabled(false), true);

  const off = screenView({ ...base, width: 120, height: 30, sidePanelEnabled: false });
  assert.equal(off.sidePanel?.layout.reason, "disabled");
  assert.ok(!off.lines.join("\n").includes("STATUS"));
  const on = screenView({ ...base, width: 120, height: 30, sidePanelEnabled: true });
  assert.ok(on.lines.join("\n").includes("STATUS"));
});
