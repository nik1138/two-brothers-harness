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
import { SessionLayout } from "../src/sessionlayout.ts";
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
import { persistTodoSnapshot, todoSnapshotEvent } from "../src/tui/todoPersist.ts";

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

// ---------------------------------------------------------------------------
// TUI plan durability (TUI turns write plan snapshots to the runtime sidecar)
// ---------------------------------------------------------------------------

/** The session file name a TUI turn would write for (`.jsonl` included). */
const SESSION_FILE = "2026-11-07-1-abc.jsonl";

function todoPersistDir(): { root: string; store: RuntimeEventStore; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-tui-todo-persist-"));
  const store = new RuntimeEventStore(path.join(root, "runtime"));
  return { root, store, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("a TUI plan snapshot round-trips through a real runtime sidecar", () => {
  const dir = todoPersistDir();
  try {
    const sessionFile = path.join(dir.root, "sessions", SESSION_FILE);
    const plan: TodoItem[] = [
      { content: "plan the work", status: "in_progress" },
      { content: "write the code", status: "pending" },
    ];
    assert.equal(
      persistTodoSnapshot(dir.store, sessionFile, plan, { runId: "tui-turn-1", at: 1_760_000_000 }),
      true,
    );

    // On-disk convention: the session name unchanged plus `.events.jsonl`.
    const onDisk = path.join(dir.root, "runtime", `${SESSION_FILE}.events.jsonl`);
    assert.ok(fs.existsSync(onDisk), "TUI plan sidecar uses the session file name");

    // A fresh store instance (a TUI restart) replays the same snapshot.
    const restarted = new RuntimeEventStore(path.join(dir.root, "runtime"));
    const events = restarted.load(sessionSidecarKey(sessionFile));
    assert.equal(events.length, 1);
    assert.deepEqual(Object.keys(events[0]).sort(), ["at", "run_id", "todos", "type"]);
    assert.equal(events[0].type, "todo_updated");
    assert.equal(events[0].run_id, "tui-turn-1");
    assert.equal(events[0].at, 1_760_000_000);
    assert.deepEqual(todosFromRuntimeEvents(events), plan);
  } finally {
    dir.cleanup();
  }
});

test("directory sessions keep distinct plan sidecars", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-tui-todo-dirs-"));
  try {
    const layout = new SessionLayout(root);
    layout.setMode("dirs");
    const project = path.join(root, "workspace");
    const alpha = layout.materialize("alpha.jsonl", project);
    const beta = layout.materialize("beta.jsonl", project);
    fs.writeFileSync(alpha.sessionPath, "", "utf-8");
    fs.writeFileSync(beta.sessionPath, "", "utf-8");
    const store = new RuntimeEventStore(path.join(root, "runtime"), layout);

    persistTodoSnapshot(store, alpha.sessionPath, [{ content: "alpha", status: "pending" }], {
      runId: "a",
      at: 1,
      sessionsDir: root,
    });
    persistTodoSnapshot(store, beta.sessionPath, [{ content: "beta", status: "completed" }], {
      runId: "b",
      at: 2,
      sessionsDir: root,
    });

    assert.equal(fs.existsSync(alpha.eventsPath), true);
    assert.equal(fs.existsSync(beta.eventsPath), true);
    assert.equal(fs.existsSync(path.join(root, "runtime")), false);
    assert.deepEqual(
      todosFromRuntimeEvents(store.load(sessionSidecarKey(alpha.sessionPath, root))),
      [{ content: "alpha", status: "pending" }],
    );
    assert.deepEqual(
      todosFromRuntimeEvents(store.load(sessionSidecarKey(beta.sessionPath, root))),
      [{ content: "beta", status: "completed" }],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("restart semantics: empty sidecar -> [], two writes -> last wins, a clear is durable", () => {
  const dir = todoPersistDir();
  try {
    const sessionFile = path.join(dir.root, SESSION_FILE);
    const key = sessionSidecarKey(sessionFile);

    // No sidecar yet (first restart of a TUI-only session with no plan write).
    assert.deepEqual(todosFromRuntimeEvents(new RuntimeEventStore(path.join(dir.root, "runtime")).load(key)), []);

    const first: TodoItem[] = [{ content: "plan", status: "in_progress" }];
    const second: TodoItem[] = [
      { content: "plan", status: "completed" },
      { content: "ship", status: "pending" },
    ];
    persistTodoSnapshot(dir.store, sessionFile, first, { runId: "tui-a", at: 10 });
    persistTodoSnapshot(dir.store, sessionFile, second, { runId: "tui-a", at: 11 });

    // A restart (fresh store) replays the LAST write only.
    const restarted = new RuntimeEventStore(path.join(dir.root, "runtime"));
    assert.deepEqual(todosFromRuntimeEvents(restarted.load(key)), second);

    // A cleared plan is a snapshot too: it persists and wins on replay.
    persistTodoSnapshot(dir.store, sessionFile, [], { runId: "tui-a", at: 12 });
    const cleared = new RuntimeEventStore(path.join(dir.root, "runtime"));
    assert.deepEqual(todosFromRuntimeEvents(cleared.load(key)), []);
  } finally {
    dir.cleanup();
  }
});

test("one sidecar line per plan write and nothing else is persisted", () => {
  const dir = todoPersistDir();
  try {
    const sessionFile = path.join(dir.root, SESSION_FILE);
    persistTodoSnapshot(dir.store, sessionFile, [{ content: "a", status: "pending" }], {
      runId: "tui-1",
      at: 1,
    });
    persistTodoSnapshot(dir.store, sessionFile, [{ content: "a", status: "completed" }], {
      runId: "tui-1",
      at: 2,
    });
    const raw = fs.readFileSync(
      path.join(dir.root, "runtime", `${SESSION_FILE}.events.jsonl`),
      "utf-8",
    );
    const lines = raw.split(/\r?\n/).filter((line) => line.trim() !== "");
    assert.equal(lines.length, 2, "one JSON line per todo write");
    const events = dir.store.load(sessionSidecarKey(sessionFile));
    assert.ok(events.every((event) => event.type === "todo_updated"));
  } finally {
    dir.cleanup();
  }
});

test("a torn sidecar line is tolerated and the last valid snapshot still wins", () => {
  const dir = todoPersistDir();
  try {
    const sessionFile = path.join(dir.root, SESSION_FILE);
    const plan: TodoItem[] = [{ content: "kept plan", status: "in_progress" }];
    persistTodoSnapshot(dir.store, sessionFile, plan, { runId: "tui-1", at: 1 });
    // Simulate a crash mid-append: a torn last line with no closing brace.
    fs.appendFileSync(
      path.join(dir.root, "runtime", `${SESSION_FILE}.events.jsonl`),
      '{"type":"todo_updated","todos":[{"content":"torn',
      "utf-8",
    );
    const restarted = new RuntimeEventStore(path.join(dir.root, "runtime"));
    assert.deepEqual(todosFromRuntimeEvents(restarted.load(sessionSidecarKey(sessionFile))), plan);
  } finally {
    dir.cleanup();
  }
});

test("plan persistence is fail-soft: an uncreatable store path never throws", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-tui-todo-failsoft-"));
  try {
    // A regular file where the sidecar directory must be: mkdir/append must
    // fail, and the helper must swallow it with one warning.
    const blocked = path.join(root, "blocked");
    fs.writeFileSync(blocked, "not a directory", "utf-8");
    const store = new RuntimeEventStore(path.join(blocked, "runtime"));
    const warnings: string[] = [];
    const sessionFile = path.join(root, SESSION_FILE);
    assert.equal(
      persistTodoSnapshot(store, sessionFile, [{ content: "x", status: "pending" }], {
        runId: "tui-1",
        at: 1,
        onWarning: (line) => warnings.push(line),
      }),
      false,
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /plan persistence failed/);
    assert.match(warnings[0], new RegExp(SESSION_FILE.replace(/\./g, "\\.")));

    // An in-memory session (no file name) has nothing durable to write to and
    // is not an error: no write, no warning.
    const silent: string[] = [];
    assert.equal(
      persistTodoSnapshot(store, "", [{ content: "x", status: "pending" }], {
        runId: "tui-2",
        at: 2,
        onWarning: (line) => silent.push(line),
      }),
      false,
    );
    assert.deepEqual(silent, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the persisted event is the compact sanitized shape (no other event types)", () => {
  const event = todoSnapshotEvent(
    [
      { content: "  keep   me  ", status: "weird" },
      { content: 42, status: "pending" },
      null,
    ] as unknown as TodoItem[],
    { runId: "tui-9", at: 99 },
  );
  assert.deepEqual(event, {
    type: "todo_updated",
    todos: [{ content: "keep me", status: "pending" }],
    run_id: "tui-9",
    at: 99,
  });
});
