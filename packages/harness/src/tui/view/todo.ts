/**
 * Pure docked plan/todo panel for the TUI.
 *
 * When the current conversation has a plan (the model wrote one through the
 * built-in `todo_write` tool), this compact box docks above the composer and
 * mirrors the latest whole-list snapshot: one row per visible item with a
 * status marker — `✓` completed, `▸` in progress, `○` pending — plus an honest
 * `+N more` tail for the entries that did not fit. It is display-only: no key
 * answers anything, and the composer keeps its normal keys.
 *
 * Rendering is width-safe (every row is exactly `width` cells at 40/60/80/120
 * including CJK/emoji content), theme-token only (no raw SGR; `plainTheme`
 * output is plain text), and bounded: at most `TODO_PANEL_MAX_ITEM_ROWS` item
 * rows plus the hidden-count tail, so a long plan never owns the screen. The
 * model keeps the full text; the panel is the glanceable projection.
 */
import * as path from "node:path";

import { TODO_MAX_ITEMS, sanitizeTodos, summarizeTodos, type TodoItem, type TodoStatus } from "../../todos.ts";
import { boxContentWidth, clipDisplay, renderBox } from "../screen.ts";
import { plainTheme, type Theme, type ThemeToken } from "../theme.ts";

/**
 * The runtime-sidecar key for one session file. `RuntimeEventStore` appends
 * `.events.jsonl` to the key, and server session names already carry their
 * `.jsonl` extension, so the key is the session file's basename unchanged:
 * `2026-11-07-1-abc.jsonl` -> `sessions/runtime/2026-11-07-1-abc.jsonl.events.jsonl`.
 */
export function sessionSidecarKey(sessionFile: string): string {
  return path.basename(sessionFile);
}

/** Item rows the docked panel shows before the `+N more` tail. */
export const TODO_PANEL_MAX_ITEM_ROWS = 4;

/** Visual status marker per lifecycle state (the shared UI vocabulary). */
export const TODO_STATUS_MARKERS: Readonly<Record<TodoStatus, string>> = {
  completed: "✓",
  in_progress: "▸",
  pending: "○",
};

/** The rows a bounded panel shows, plus the counts hidden behind the tail. */
export interface TodoPanelSelection {
  /** Visible items, in the model's original order. */
  rows: TodoItem[];
  /** Items left out of `rows` (rendered as the `+N more` tail). */
  hidden: number;
  /** Hidden items by status, for the honest distribution in the tail. */
  hiddenCounts: Record<TodoStatus, number>;
}

function emptyCounts(): Record<TodoStatus, number> {
  return { pending: 0, in_progress: 0, completed: 0 };
}

/**
 * Pick which todos the bounded panel shows. A list that fits is shown whole.
 * Otherwise every `in_progress` item goes first (they are what the run is
 * doing now), then the earliest `pending` items (what comes next), then the
 * latest `completed` items (what just finished); the picked entries are
 * returned in their original order so the plan reads top-to-bottom.
 */
export function selectTodoPanelRows(
  todos: readonly TodoItem[],
  maxRows: number = TODO_PANEL_MAX_ITEM_ROWS,
): TodoPanelSelection {
  const max = Math.max(1, Math.min(TODO_MAX_ITEMS, Math.floor(maxRows)));
  if (todos.length <= max) {
    return { rows: [...todos], hidden: 0, hiddenCounts: emptyCounts() };
  }
  const priority: number[] = [];
  for (let index = 0; index < todos.length; index += 1) {
    if (todos[index].status === "in_progress") priority.push(index);
  }
  for (let index = 0; index < todos.length; index += 1) {
    if (todos[index].status === "pending") priority.push(index);
  }
  for (let index = todos.length - 1; index >= 0; index -= 1) {
    if (todos[index].status === "completed") priority.push(index);
  }
  const picked = new Set(priority.slice(0, max));
  const rows = todos.filter((_todo, index) => picked.has(index));
  const hiddenCounts = emptyCounts();
  for (let index = 0; index < todos.length; index += 1) {
    if (!picked.has(index)) hiddenCounts[todos[index].status] += 1;
  }
  return { rows, hidden: todos.length - rows.length, hiddenCounts };
}

/**
 * The latest plan snapshot replayed from a session's runtime events (typed
 * event objects: only `type: "todo_updated"` entries with a `todos` field
 * contribute, and the last one wins). Pure and fail-soft — a malformed entry
 * is treated like an empty snapshot, never an error.
 */
export function todosFromRuntimeEvents(events: readonly unknown[]): TodoItem[] {
  let latest: TodoItem[] = [];
  for (const event of events) {
    if (event === null || typeof event !== "object" || Array.isArray(event)) continue;
    const record = event as Record<string, unknown>;
    if (record.type !== "todo_updated") continue;
    latest = sanitizeTodos(record.todos);
  }
  return latest;
}

function markerTone(status: TodoStatus): ThemeToken {
  if (status === "completed") return "success";
  if (status === "in_progress") return "accent";
  return "dim";
}

function contentTone(status: TodoStatus): ThemeToken {
  if (status === "completed") return "dim";
  if (status === "in_progress") return "strong";
  return "text";
}

/** The honest `+N more (…)` tail: the count plus a non-zero distribution. */
export function todoHiddenTail(selection: TodoPanelSelection): string {
  if (selection.hidden <= 0) return "";
  const parts: string[] = [];
  const { in_progress: active, pending, completed } = selection.hiddenCounts;
  if (active > 0) parts.push(`${active} in progress`);
  if (pending > 0) parts.push(`${pending} pending`);
  if (completed > 0) parts.push(`${completed} completed`);
  return `+${selection.hidden} more${parts.length > 0 ? ` (${parts.join(" · ")})` : ""}`;
}

/** Render options for the docked panel. */
export interface TodoPanelRenderOptions {
  /** Terminal width; every row is exactly this many cells. */
  width: number;
  theme?: Theme;
  /** Visible item rows (defaults to `TODO_PANEL_MAX_ITEM_ROWS`). */
  maxItemRows?: number;
}

/** The rendered docked panel. */
export interface TodoPanelView {
  lines: string[];
  /** Items left behind the `+N more` tail (0 when everything is visible). */
  hidden: number;
}

/**
 * Render the docked plan panel as a full-width box. A zero width or an empty
 * plan renders nothing (callers omit the slot entirely then).
 */
export function todoPanelView(
  todos: readonly TodoItem[],
  options: TodoPanelRenderOptions,
): TodoPanelView {
  const width = Number.isFinite(options.width) ? Math.max(0, Math.floor(options.width)) : 0;
  const theme = options.theme ?? plainTheme;
  if (width === 0 || todos.length === 0) return { lines: [], hidden: 0 };
  const contentWidth = Math.max(1, boxContentWidth(width));
  const selection = selectTodoPanelRows(todos, options.maxItemRows);
  const rows: string[] = [];
  for (const todo of selection.rows) {
    const marker = theme.paint(markerTone(todo.status), TODO_STATUS_MARKERS[todo.status]);
    const text = clipDisplay(todo.content, Math.max(1, contentWidth - 2));
    rows.push(`${marker} ${theme.paint(contentTone(todo.status), text)}`);
  }
  const tail = todoHiddenTail(selection);
  if (tail !== "") rows.push(theme.paint("muted", clipDisplay(tail, contentWidth)));
  const summary = summarizeTodos(todos);
  const title = `TODO · ${summary.completed}/${summary.total} done`;
  return { lines: renderBox(rows, { width, title, tone: "border", theme }), hidden: selection.hidden };
}

/** Convenience wrapper returning only the rendered rows. */
export function renderTodoPanel(
  todos: readonly TodoItem[],
  options: TodoPanelRenderOptions,
): string[] {
  return todoPanelView(todos, options).lines;
}
