/**
 * Model-maintained plan/todo list: the shared value model for the `todo_write`
 * tool and every UI that renders it (TUI dock, web TodoPanel).
 *
 * Adapted from DeepSeek Harness's MIT `tool-todo` package (whole-list snapshot,
 * minimal `{content, status}` entries, last-write-wins) — the two-brothers
 * reporting contract is intentionally tolerant at the model boundary instead of
 * rejecting a malformed list: invalid entries are dropped, unknown statuses
 * default to `pending`, content is trimmed/collapsed to one line and bounded,
 * and the list is capped. The tool handler in `harness.ts` only reports an
 * error result when the argument is not an array at all (or nothing usable
 * remains), so one bad entry never loses a whole plan.
 *
 * This module is pure: no IO, no runtime events, no UI. It is also the single
 * home of the model-facing JSON Schema and the display summary both surfaces
 * use, so the tool and the UIs cannot disagree about the shape.
 */

/** How many entries one snapshot may carry (extra entries are clipped). */
export const TODO_MAX_ITEMS = 50;

/** Bound on one entry's content, in characters (code points). */
export const TODO_CONTENT_MAX_CHARS = 200;

/** The valid lifecycle states of one todo entry. */
export const TODO_STATUSES = ["pending", "in_progress", "completed"] as const;

/** Lifecycle state: not started, being worked on now, done. */
export type TodoStatus = (typeof TODO_STATUSES)[number];

/**
 * One entry in a todo list. Deliberately minimal: the list is replaced
 * wholesale on every write (last-write-wins), so entries need no id.
 */
export interface TodoItem {
  /** What the task is — a short imperative line shown in the UI. */
  content: string;
  status: TodoStatus;
}

/** Counts plus the currently active entry, for UI headers and tool results. */
export interface TodoSummary {
  total: number;
  pending: number;
  inProgress: number;
  completed: number;
  /** The first `in_progress` entry, or null when nothing is being worked. */
  current: TodoItem | null;
}

/** The built-in tool's model-facing name (one tool, one name, everywhere). */
export const TODO_TOOL_NAME = "todo_write";

/**
 * The model-facing description. Kept to one sentence so the `## Available
 * tools` prompt section stays one line, like every other tool.
 */
export const TODO_TOOL_DESCRIPTION =
  "Record or replace the task plan as a whole todo list (display-only; never touches the workspace). " +
  "Use it to plan multi-step work and keep progress visible; skip it for trivial single-step tasks.";

/**
 * The model-facing JSON Schema: one required `todos` array of
 * `{content, status}` objects. Whole-list replacement is stated in the
 * argument description because that is the only behavior no schema can say.
 */
export const TODO_TOOL_PARAMETERS: Record<string, unknown> = {
  type: "object",
  properties: {
    todos: {
      type: "array",
      description:
        "The COMPLETE task list, replacing any previous list. Keep each content line short and imperative.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          content: {
            type: "string",
            description: "What the task is — a short imperative line.",
          },
          status: {
            type: "string",
            enum: [...TODO_STATUSES],
            description: "pending (not started) | in_progress (now) | completed (done).",
          },
        },
        required: ["content", "status"],
      },
    },
  },
  required: ["todos"],
  additionalProperties: false,
};

/** True when `value` is one of the three valid statuses. */
export function isTodoStatus(value: unknown): value is TodoStatus {
  return value === "pending" || value === "in_progress" || value === "completed";
}

/**
 * Bound and normalize one content line: string values are whitespace-collapsed
 * to a single line, trimmed, and cut to `TODO_CONTENT_MAX_CHARS` code points.
 * Returns "" for anything unusable.
 */
function normalizeContent(value: unknown): string {
  if (typeof value !== "string") return "";
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed === "") return "";
  const points = [...collapsed];
  if (points.length <= TODO_CONTENT_MAX_CHARS) return collapsed;
  return `${points.slice(0, TODO_CONTENT_MAX_CHARS - 1).join("")}…`;
}

/**
 * Tolerant boundary parser for a model-supplied todo list.
 *
 * - non-arrays and non-object entries contribute nothing;
 * - `content` must be a non-empty string (trimmed, one line, bounded);
 * - an unknown/missing `status` becomes `pending` (never a displayed guess);
 * - at most `TODO_MAX_ITEMS` entries survive, in the model's order;
 * - duplicate content is kept (the model wrote it; display bounds it).
 *
 * Always returns fresh `{content, status}` objects, so callers may store the
 * result without aliasing the model's argument.
 */
export function sanitizeTodos(value: unknown): TodoItem[] {
  if (!Array.isArray(value)) return [];
  const todos: TodoItem[] = [];
  for (const entry of value) {
    if (todos.length >= TODO_MAX_ITEMS) break;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const content = normalizeContent(record.content);
    if (content === "") continue;
    todos.push({ content, status: isTodoStatus(record.status) ? record.status : "pending" });
  }
  return todos;
}

/**
 * Counts plus the first `in_progress` entry. Never throws: a malformed list
 * (an old sidecar, a hand-written event) is treated as empty by the callers
 * that pass `unknown` through `sanitizeTodos` first.
 */
export function summarizeTodos(todos: readonly TodoItem[]): TodoSummary {
  const summary: TodoSummary = {
    total: todos.length,
    pending: 0,
    inProgress: 0,
    completed: 0,
    current: null,
  };
  for (const todo of todos) {
    if (todo.status === "completed") summary.completed += 1;
    else if (todo.status === "in_progress") {
      summary.inProgress += 1;
      if (summary.current === null) summary.current = todo;
    } else summary.pending += 1;
  }
  return summary;
}

/**
 * The compact tool result text: item count and how many are in progress.
 * Grammar is honest at 1/0 so tests and humans read the real number.
 */
export function todoResultText(todos: readonly TodoItem[]): string {
  const summary = summarizeTodos(todos);
  const items = summary.total === 1 ? "item" : "items";
  return `todo list updated: ${summary.total} ${items} (${summary.inProgress} in progress)`;
}
