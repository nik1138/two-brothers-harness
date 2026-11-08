/**
 * Display-only plan persistence for TUI turns.
 *
 * A TUI turn that produces a plan snapshot appends exactly ONE typed runtime
 * event (`todo_updated`) to the session's runtime sidecar — the same
 * `RuntimeEventStore` directory and key convention a `two-brothers serve`
 * backend uses (`sessions/runtime/<session file>.events.jsonl`, the session
 * file name unchanged, `.jsonl` included). That makes a TUI-written plan
 * durable: restarting the TUI with the same `--session-file` replays the last
 * snapshot, exactly like a serve-written one. Last write wins on replay, so a
 * later snapshot (including a cleared list) replaces the earlier plan.
 *
 * Only plan snapshots are persisted. Tool, approval and envelope events stay
 * out of a TUI-written sidecar; this module never touches the protocol session
 * JSONL or the settings file, and a plan carries no secrets (content lines the
 * model wrote are already sanitized/bounded by `sanitizeTodos`).
 *
 * IO is fail-soft: a sidecar problem is reported through the optional warning
 * sink (the TUI wires it only in verbose mode) and never breaks a turn.
 */
import { RuntimeEventStore, type TodoUpdatedEvent } from "../runevents.ts";
import { sanitizeTodos, type TodoItem } from "../todos.ts";
import { sessionSidecarKey } from "./view/todo.ts";

/** Identity and fail-soft sink for one plan-snapshot write. */
export interface TodoSnapshotOptions {
  /** Run id for the event: the TUI uses one `tui-<unique>` per turn. */
  runId: string;
  /** Epoch seconds, the unit every typed runtime event carries. */
  at: number;
  /** Fail-soft warning sink; the TUI passes it only in verbose mode. */
  onWarning?: (line: string) => void;
  /** Sessions root, so a directory-layout file maps to its public name. */
  sessionsDir?: string;
}

/**
 * The exact sidecar event one plan snapshot becomes: a `todo_updated` event
 * with the sanitized whole list, the turn's run id and the write time.
 */
export function todoSnapshotEvent(
  todos: readonly TodoItem[],
  options: TodoSnapshotOptions,
): TodoUpdatedEvent {
  return {
    type: "todo_updated",
    todos: sanitizeTodos(todos),
    run_id: options.runId,
    at: options.at,
  };
}

/**
 * Append one whole-list plan snapshot to `sessionFile`'s runtime sidecar.
 *
 * @returns `true` when the event was written; `false` when the session has no
 *   file name (in-memory session — nothing durable to write to) or the IO
 *   failed. A failure is reported through `options.onWarning` and never throws.
 */
export function persistTodoSnapshot(
  store: RuntimeEventStore,
  sessionFile: string,
  todos: readonly TodoItem[],
  options: TodoSnapshotOptions,
): boolean {
  const key = sessionSidecarKey(sessionFile, options.sessionsDir);
  if (key === "") return false;
  try {
    store.append(key, todoSnapshotEvent(todos, options));
    return true;
  } catch (exc) {
    const message = exc instanceof Error ? exc.message : String(exc);
    options.onWarning?.(`plan persistence failed for ${key}: ${message}`);
    return false;
  }
}
