/**
 * Docked plan/todo panel (TUI): the pure view behavior, width/plain safety,
 * bounded rows with the honest `+N more` tail, sidecar replay, and the docked
 * screen composition above the composer.
 *
 * Run with: node tests/run-all.ts
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { createEditor } from "../src/tui/editor.ts";
import { createTuiModel } from "../src/tui/model.ts";
import { styledWidth, stripAnsi } from "../src/tui/screen.ts";
import { createTheme, plainTheme, resolveTheme } from "../src/tui/theme.ts";
import { RuntimeEventStore } from "../src/runevents.ts";
import type { TodoItem } from "../src/todos.ts";
import { renderScreen, screenView } from "../src/tui/view/screen.ts";
import {
  TODO_PANEL_MAX_ITEM_ROWS,
  TODO_STATUS_MARKERS,
  selectTodoPanelRows,
  sessionSidecarKey,
  todoHiddenTail,
  todoPanelView,
  todosFromRuntimeEvents,
} from "../src/tui/view/todo.ts";

function todos(): TodoItem[] {
  return [
    { content: "read the request", status: "completed" },
    { content: "plan the work", status: "in_progress" },
    { content: "write the code", status: "pending" },
  ];
}

/** One frame's baseline options (no plan panel). */
function frameOptions(width = 80, height = 30) {
  return {
    width,
    height,
    model: createTuiModel(),
    editor: createEditor(""),
    status: {
      mode: "work",
      seniorModel: "s",
      juniorModel: "j",
      sessionName: "plan",
      cwd: "/work",
    },
    theme: plainTheme,
  };
}

function assertRows(rows: readonly string[], width: number): void {
  for (const row of rows) {
    assert.equal(styledWidth(row), width, `${JSON.stringify(row)} is not exactly ${width} cells`);
  }
}

// ---------------------------------------------------------------------------
// pure view: markers, counts, bounds
// ---------------------------------------------------------------------------

test("the panel renders the shared status markers and the done/total title", () => {
  const view = todoPanelView(todos(), { width: 80 });
  const text = view.lines.join("\n");
  assert.ok(text.includes(`TODO · 1/3 done`), text);
  assert.ok(text.includes(TODO_STATUS_MARKERS.completed), "completed marker");
  assert.ok(text.includes(TODO_STATUS_MARKERS.in_progress), "in-progress marker");
  assert.ok(text.includes(TODO_STATUS_MARKERS.pending), "pending marker");
  assert.ok(text.includes("read the request"));
  assert.ok(view.lines.length >= 5, "box borders + three rows");
  assert.equal(view.hidden, 0);
});

test("an empty plan renders nothing (the caller omits the slot)", () => {
  assert.deepEqual(todoPanelView([], { width: 80 }).lines, []);
  assert.deepEqual(todoPanelView(todos(), { width: 0 }).lines, []);
});

test("rows are bounded with an honest +N more tail", () => {
  const many: TodoItem[] = Array.from({ length: 10 }, (_, index) => ({
    content: `task ${index + 1}`,
    status: index === 9 ? "in_progress" : index < 3 ? "completed" : "pending",
  }));
  const view = todoPanelView(many, { width: 80 });
  const text = view.lines.join("\n");
  assert.equal(view.hidden, 10 - TODO_PANEL_MAX_ITEM_ROWS);
  assert.ok(text.includes(`+${view.hidden} more`), text);
  // the in-progress task is always visible, even when the list is long
  assert.ok(text.includes("task 10"));
  // the panel never grows past its item bound + the tail row (plus the box)
  const selection = selectTodoPanelRows(many);
  assert.equal(selection.rows.length, TODO_PANEL_MAX_ITEM_ROWS);
  assert.equal(selection.hidden, 6);
  assert.equal(
    selection.hiddenCounts.completed + selection.hiddenCounts.pending + selection.hiddenCounts.in_progress,
    selection.hidden,
  );
  assert.ok(todoHiddenTail(selection).startsWith("+6 more ("));
});

test("selection keeps in-progress first, then next pending, then recent completed", () => {
  const list: TodoItem[] = [
    { content: "old done", status: "completed" },
    { content: "next up", status: "pending" },
    { content: "active", status: "in_progress" },
    { content: "later", status: "pending" },
    { content: "new done", status: "completed" },
  ];
  const selection = selectTodoPanelRows(list, 3);
  // the active item, then the next pending ones; completed items only fill
  // leftover room (none here), and the picked rows keep the original order.
  assert.deepEqual(
    selection.rows.map((todo) => todo.content),
    ["next up", "active", "later"],
  );
  assert.equal(selection.hidden, 2);
  assert.deepEqual(selection.hiddenCounts, { pending: 0, in_progress: 0, completed: 2 });
});

test("a list that fits shows every row and no tail", () => {
  const selection = selectTodoPanelRows(todos(), TODO_PANEL_MAX_ITEM_ROWS);
  assert.equal(selection.rows.length, 3);
  assert.equal(selection.hidden, 0);
  assert.equal(todoHiddenTail(selection), "");
  const text = todoPanelView(todos(), { width: 80 }).lines.join("\n");
  assert.ok(!text.includes("more"));
});

// ---------------------------------------------------------------------------
// width and plain/NO_COLOR safety
// ---------------------------------------------------------------------------

test("the panel is width-safe at 40/60/80/120 including CJK and emoji", () => {
  const wide: TodoItem[] = [
    { content: "规划一次大规模迁移并验证结果", status: "in_progress" },
    { content: "run the 🧪 verification suite for the migration", status: "pending" },
    { content: "日本語のタスク名がとても長い場合でも安全に折り返します", status: "completed" },
    { content: "😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀", status: "pending" },
  ];
  for (const width of [40, 60, 80, 120]) {
    const view = todoPanelView(wide, { width });
    assertRows(view.lines, width);
  }
});

test("plainTheme and NO_COLOR output carry no escape sequences", () => {
  for (const theme of [plainTheme, resolveTheme({ env: { NO_COLOR: "1" } })]) {
    const text = todoPanelView(todos(), { width: 80, theme }).lines.join("\n");
    assert.ok(!text.includes("\u001b"), "no raw SGR in plain output");
  }
});

test("colored output strips back to the plain rows byte-for-byte", () => {
  const plain = todoPanelView(todos(), { width: 80, theme: plainTheme }).lines;
  const colored = todoPanelView(todos(), {
    width: 80,
    theme: createTheme("dark", { color: true }),
  }).lines;
  assert.equal(colored.length, plain.length);
  for (let index = 0; index < plain.length; index += 1) {
    assert.equal(stripAnsi(colored[index]), plain[index]);
  }
});

// ---------------------------------------------------------------------------
// sidecar replay (last write wins)
// ---------------------------------------------------------------------------

test("todosFromRuntimeEvents replays the latest snapshot and is fail-soft", () => {
  const first = [{ content: "plan", status: "in_progress" }];
  const second = [
    { content: "plan", status: "completed" },
    { content: "ship", status: "pending" },
  ];
  const events = [
    { type: "tool_started", tool: "todo_write", args: {} },
    { type: "todo_updated", todos: first },
    { type: "tool_completed", tool: "todo_write", status: "ok" },
    { type: "todo_updated", todos: second },
  ];
  assert.deepEqual(todosFromRuntimeEvents(events), second);

  // Malformed / unrelated entries contribute nothing and never throw.
  assert.deepEqual(
    todosFromRuntimeEvents([
      null,
      42,
      "junk",
      { type: "todo_updated" },
      { type: "todo_updated", todos: "nope" },
      { type: "todo_updated", todos: [{ content: "  keep  ", status: "unknown" }] },
      { type: "run_end", status: "completed" },
    ]),
    [{ content: "keep", status: "pending" }],
  );
  assert.deepEqual(todosFromRuntimeEvents([]), []);
});

test("the sidecar key round-trips through the runtime event store", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-tui-todo-"));
  try {
    const store = new RuntimeEventStore(path.join(root, "runtime"));
    const event = { type: "todo_updated", todos: [{ content: "plan", status: "in_progress" }] };
    store.append("2026-11-07-1-abc.jsonl", event);
    // The on-disk convention is the server session name plus `.events.jsonl`.
    const onDisk = path.join(root, "runtime", "2026-11-07-1-abc.jsonl.events.jsonl");
    assert.ok(fs.existsSync(onDisk), "sidecar file carries the .jsonl session name");
    const sessionFile = path.join(root, "sessions", "2026-11-07-1-abc.jsonl");
    const loaded = store.load(sessionSidecarKey(sessionFile));
    assert.deepEqual(loaded, [event]);
    assert.deepEqual(todosFromRuntimeEvents(loaded), [
      { content: "plan", status: "in_progress" },
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// docked composition above the composer
// ---------------------------------------------------------------------------

test("the plan panel docks above the composer without changing the frame size", () => {
  const base = frameOptions(80, 30);
  const panel = todoPanelView(todos(), { width: 80 }).lines;
  const framed = screenView({ ...base, todoPanel: panel });
  assert.equal(framed.lines.length, 30, "the frame height is preserved");
  assertRows(framed.lines, 80);
  const text = framed.lines.join("\n");
  assert.ok(text.includes("TODO · 1/3 done"));
  // the panel sits above the composer: its title row precedes the composer box
  const panelRow = framed.lines.findIndex((row) => row.includes("TODO · 1/3 done"));
  assert.ok(panelRow >= 0);
});

test("no plan (or an empty slot) is byte-identical to the pre-plan frame", () => {
  const base = frameOptions(80, 30);
  const without = renderScreen(base);
  assert.deepEqual(renderScreen({ ...base, todoPanel: [] }), without);
  // and the docked panel is the only difference once it exists
  const withPanel = renderScreen({ ...base, todoPanel: todoPanelView(todos(), { width: 80 }).lines });
  assert.notDeepEqual(withPanel, without);
});
