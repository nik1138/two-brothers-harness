/**
 * Helper subagents in the TUI (pure model + list/detail views).
 *
 * The TUI spawns its own helpers in process (the same `HarnessOptions.subagents`
 * gate `serve` uses) and observes them from two sources: the durable child log
 * (`SubagentStore`, one append-only JSONL per child under
 * `<sessionsDir>/subagents/`) and the live `subagent_*` / child-tagged approval
 * runtime events. This module is the pure projection between those sources and
 * the modal `HELPERS` overlay: row model, event folding, the bounded list, the
 * child transcript and the key routing.
 *
 * The views are views only. They read a store separate from the brothers'
 * transcript, append no envelope and change no transcript byte; the parent's
 * usage/context numbers are never merged with a child's (a child has its own
 * isolated conversation and its own provider instance). Everything here is
 * deterministic and terminal-free: model text is sanitized and width-clipped by
 * the shared `renderBox`/`clipDisplay` primitives, and no view spells a
 * shortcut (footers come from `hintSegments`).
 *
 * Truth model: `subagent_started` creates a row, `subagent_activity` updates
 * its live label, and only `subagent_completed` changes its status. The store is
 * the authority when the overlay opens and after a completion; events are live
 * activity only. Selection is anchored by child id, so a helper starting while
 * the list is open never moves what Enter opens.
 */
import type { UsageTotals } from "../../provider.ts";
import type {
  ApprovalRequestedEvent,
  ApprovalResolvedEvent,
  RuntimeEvent,
  SubagentActivityEvent,
  SubagentCompletedEvent,
  SubagentStartedEvent,
} from "../../runevents.ts";
import type {
  SubagentActivity,
  SubagentApprovalEntry,
  SubagentDetail,
  SubagentMessageEntry,
  SubagentStatus,
  SubagentSummary,
  SubagentTranscriptEntry,
} from "../../subagent.ts";
import {
  hintSegments,
  resolveKey,
  TUI_COMMANDS,
  type KeyLike,
  type TuiCommand,
} from "../keymap.ts";
import {
  boxContentWidth,
  clipDisplay,
  renderBox,
  sanitizeDisplayText,
  wrapDisplay,
} from "../screen.ts";
import { displayWidth } from "../text.ts";
import { plainTheme, type Theme, type ThemeToken } from "../theme.ts";
import { formatCount } from "./statusbar.ts";

// --------------------------------------------------------------------------- //
// bounds (the design's single bounds table)
// --------------------------------------------------------------------------- //

/** List rows rendered before the honest `+N older (not shown)` tail. */
export const HELPERS_LIST_MAX_ROWS = 20;

/** Detail transcript rows kept, from the tail (the full content stays in the log). */
export const HELPERS_DETAIL_MAX_ROWS = 400;

/** Preview length for one tool call in the child transcript. */
export const HELPERS_TOOL_PREVIEW_CHARS = 200;

/** Rows one PgUp/PgDn press scrolls in the child transcript. */
export const HELPER_SCROLL_PAGE = 10;

/** Honest empty state for a session with no helpers yet. */
export const HELPERS_EMPTY_COPY =
  "No helpers yet — the Senior has not delegated in this session.";

/** Honest state for an in-memory session (its child logs are never listed). */
export const HELPERS_MEMORY_COPY =
  "This session has no file, so only live helpers are listed.";

/** Honest state for a stale/deleted selection. */
export const HELPER_UNKNOWN_COPY = "That helper is not in this session's log.";

// --------------------------------------------------------------------------- //
// row model
// --------------------------------------------------------------------------- //

/** One helper as the list renders it. */
export interface HelperRow {
  id: string;
  label: string;
  role: "senior" | "junior";
  model: string;
  status: SubagentStatus;
  background: boolean;
  startedAt: number;
  endedAt?: number;
  activity?: SubagentActivity | null;
  usage?: UsageTotals | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function intOf(value: unknown, fallback = 0): number {
  const num = Number(value);
  return Number.isFinite(num) ? Math.trunc(num) : fallback;
}

function statusOf(value: unknown): SubagentStatus {
  return value === "completed" || value === "failed" || value === "cancelled"
    ? value
    : "running";
}

function roleOf(value: unknown): "senior" | "junior" {
  return value === "senior" ? "senior" : "junior";
}

function usageOf(value: unknown): UsageTotals | null {
  if (!isRecord(value)) return null;
  return {
    model_calls: Math.max(0, intOf(value.model_calls)),
    input_tokens: Math.max(0, intOf(value.input_tokens)),
    output_tokens: Math.max(0, intOf(value.output_tokens)),
    cached_tokens: Math.max(0, intOf(value.cached_tokens)),
    cache_write_tokens: Math.max(0, intOf(value.cache_write_tokens)),
    ...(value.prompt_tokens !== undefined
      ? { prompt_tokens: Math.max(0, intOf(value.prompt_tokens)) }
      : {}),
  };
}

/** The live activity an event describes (absent for a status-less event). */
function activityOfEvent(
  event: SubagentActivityEvent | ApprovalRequestedEvent | ApprovalResolvedEvent,
): SubagentActivity {
  const at = intOf(event.at) * 1_000;
  if (event.type === "approval_requested") {
    return { kind: "status", status: "awaiting_approval", at };
  }
  if (event.type === "approval_resolved") {
    return { kind: "status", status: "running", at };
  }
  return {
    kind: event.activity,
    at,
    ...(event.text !== undefined ? { text: event.text.slice(0, 300) } : {}),
    ...(event.tool !== undefined ? { tool: event.tool.slice(0, 120) } : {}),
    ...(event.status !== undefined ? { status: event.status.slice(0, 80) } : {}),
  };
}

/** Store summaries → list rows, newest first. */
export function helperRowsFromSummaries(list: readonly SubagentSummary[]): HelperRow[] {
  const rows = list.map((summary) => ({
    id: summary.id,
    label: summary.label,
    role: roleOf(summary.role),
    model: summary.model,
    status: statusOf(summary.status),
    background: summary.background === true,
    startedAt: intOf(summary.started_at),
    ...(summary.ended_at !== undefined ? { endedAt: intOf(summary.ended_at) } : {}),
    activity: summary.last_activity ?? null,
    usage: summary.usage ?? null,
  }));
  return rows.sort((left, right) => right.startedAt - left.startedAt);
}

/** `{total, running}` for the status bar, side panel and list title. */
export function helperCounts(rows: readonly HelperRow[]): { total: number; running: number } {
  let running = 0;
  for (const row of rows) if (row.status === "running") running += 1;
  return { total: rows.length, running };
}

/**
 * Fold one live runtime event into the list. An event for an unknown id is a
 * no-op; a settled row keeps its terminal state (one `subagent_completed` per
 * child, so a late/duplicate approval event can never reopen it). The input
 * array is never mutated; an unchanged fold returns the same array.
 */
export function foldHelperEvent(rows: readonly HelperRow[], event: RuntimeEvent): HelperRow[] {
  if (event.type === "subagent_started") {
    const started = event as SubagentStartedEvent;
    const index = rows.findIndex((row) => row.id === started.subagent_id);
    const next: HelperRow = {
      id: started.subagent_id,
      label: started.label,
      role: roleOf(started.role),
      model: started.model,
      status: "running",
      background: started.background === true,
      startedAt: intOf(started.started_at),
      activity: null,
      usage: null,
    };
    if (index < 0) return [next, ...rows];
    const copy = [...rows];
    copy[index] = { ...rows[index]!, ...next };
    return copy;
  }
  if (event.type === "subagent_activity") {
    return withActivity(rows, (event as SubagentActivityEvent).subagent_id, () =>
      activityOfEvent(event as SubagentActivityEvent),
    );
  }
  if (event.type === "subagent_completed") {
    const completed = event as SubagentCompletedEvent;
    const index = rows.findIndex((row) => row.id === completed.subagent_id);
    if (index < 0) return unchangedRows(rows);
    const current = rows[index]!;
    if (current.status !== "running") return unchangedRows(rows);
    const copy = [...rows];
    copy[index] = {
      ...current,
      status: statusOf(completed.status),
      endedAt: intOf(completed.ended_at),
      usage: usageOf(completed.usage),
      activity: {
        kind: "status",
        status: completed.status,
        at: intOf(completed.at) * 1_000,
      },
    };
    return copy;
  }
  if (event.type === "approval_requested" || event.type === "approval_resolved") {
    const id = typeof event.subagent_id === "string" ? event.subagent_id : "";
    if (id === "") return unchangedRows(rows);
    const approval = event as ApprovalRequestedEvent | ApprovalResolvedEvent;
    return withActivity(rows, id, () => activityOfEvent(approval));
  }
  return unchangedRows(rows);
}

/** Identity return for an unchanged fold (the input array is never mutated). */
function unchangedRows(rows: readonly HelperRow[]): HelperRow[] {
  return rows as unknown as HelperRow[];
}

function withActivity(
  rows: readonly HelperRow[],
  id: string,
  make: () => SubagentActivity,
): HelperRow[] {
  const index = rows.findIndex((row) => row.id === id);
  if (index < 0) return unchangedRows(rows);
  const current = rows[index]!;
  // A settled child keeps its terminal state; a late approval/activity event
  // never reopens the row.
  if (current.status !== "running") return unchangedRows(rows);
  const activity = make();
  const previous = current.activity;
  if (
    previous !== null &&
    previous !== undefined &&
    previous.kind === activity.kind &&
    previous.status === activity.status &&
    previous.tool === activity.tool &&
    previous.text === activity.text
  ) {
    return unchangedRows(rows);
  }
  const copy = [...rows];
  copy[index] = { ...current, activity };
  return copy;
}

// --------------------------------------------------------------------------- //
// child transcript folding
// --------------------------------------------------------------------------- //

function childIdOf(event: RuntimeEvent): string | null {
  if (event.type !== "approval_requested" && event.type !== "approval_resolved") return null;
  const id = (event as { subagent_id?: unknown }).subagent_id;
  return typeof id === "string" && id !== "" ? id : null;
}

function transcriptEntryOf(value: unknown): SubagentTranscriptEntry | null {
  if (!isRecord(value)) return null;
  if (value.type === "approval") {
    const status =
      value.status === "pending" ||
      value.status === "allowed" ||
      value.status === "denied" ||
      value.status === "cancelled"
        ? value.status
        : null;
    if (status === null) return null;
    const action = typeof value.action === "string" ? value.action.slice(0, 40) : "";
    if (action === "") return null;
    const target = typeof value.target === "string" ? value.target.slice(0, 500) : "";
    const command = typeof value.command === "string" ? value.command.slice(0, 1_000) : "";
    const reason = typeof value.reason === "string" ? value.reason.slice(0, 500) : "";
    return {
      type: "approval",
      status,
      action,
      at: intOf(value.at),
      ...(target !== "" ? { target } : {}),
      ...(command !== "" ? { command } : {}),
      ...(reason !== "" ? { reason } : {}),
    };
  }
  if (value.type === "message") {
    const text = typeof value.text === "string" ? value.text.slice(0, 12_000) : "";
    if (text === "") return null;
    const origin =
      value.origin === "operator" || value.origin === "senior" ? value.origin : undefined;
    return {
      type: "message",
      role: value.role === "user" ? "user" : "assistant",
      ...(origin !== undefined ? { origin } : {}),
      text,
      at: intOf(value.at),
    };
  }
  if (value.type === "tool") {
    const tool = typeof value.tool === "string" ? value.tool.slice(0, 200) : "";
    if (tool === "") return null;
    const status =
      value.status === "completed" || value.status === "error" ? value.status : "started";
    return {
      type: "tool",
      tool,
      status,
      at: intOf(value.at),
      ...(isRecord(value.args) ? { args: value.args } : {}),
      ...(typeof value.result === "string" ? { result: value.result.slice(0, 4_000) } : {}),
    };
  }
  return null;
}

/**
 * Fold one live event into the open child transcript, mirroring the web
 * drawer's `applySubagentDetailEvent`/`applySubagentApprovalDetailEvent`: a
 * message row is skipped when the store already returned the same final text, a
 * tool start/completion pairs with the newest open row for that tool instead of
 * appending a duplicate, and a pending approval row flips on resolution. An
 * event for another child is a no-op.
 */
export function foldHelperDetail(detail: SubagentDetail, event: RuntimeEvent): SubagentDetail {
  const childId = childIdOf(event);
  if (childId !== null) {
    if (childId !== detail.id) return detail;
    if (event.type === "approval_requested") {
      const requested = event as ApprovalRequestedEvent;
      if (
        detail.transcript.some((entry) => entry.type === "approval" && entry.status === "pending")
      ) {
        return detail;
      }
      const action = (requested.action ?? "").slice(0, 40) || "action";
      const target = (requested.target ?? "").slice(0, 500);
      const command = (requested.command ?? "").slice(0, 1_000);
      const row: SubagentApprovalEntry = {
        type: "approval",
        status: "pending",
        action,
        at: intOf(event.at) * 1_000,
        ...(target !== "" ? { target } : {}),
        ...(command !== "" ? { command } : {}),
      };
      return {
        ...detail,
        last_activity: { kind: "status", status: "awaiting_approval", at: intOf(event.at) * 1_000 },
        transcript: [...detail.transcript, row],
      };
    }
    if (event.type !== "approval_resolved") return detail;
    const resolved = event as ApprovalResolvedEvent;
    const status =
      resolved.reason === "cancelled"
        ? "cancelled"
        : resolved.decision === "allow"
          ? "allowed"
          : "denied";
    const transcript = [...detail.transcript];
    for (let index = transcript.length - 1; index >= 0; index -= 1) {
      const entry = transcript[index]!;
      if (entry.type === "approval" && entry.status === "pending") {
        transcript[index] = { ...entry, status };
        break;
      }
    }
    return {
      ...detail,
      last_activity: {
        kind: "status",
        status: detail.status === "running" ? "running" : detail.status,
        at: intOf(event.at) * 1_000,
      },
      transcript,
    };
  }
  if (event.type === "subagent_started") {
    const started = event as SubagentStartedEvent;
    if (started.subagent_id !== detail.id) return detail;
    return {
      ...detail,
      label: started.label,
      role: roleOf(started.role),
      model: started.model,
      status: "running",
      started_at: intOf(started.started_at),
      ...(started.background === true ? { background: true } : {}),
    };
  }
  if (event.type === "subagent_activity") {
    const activity = event as SubagentActivityEvent;
    if (activity.subagent_id !== detail.id) return detail;
    const at = intOf(event.at) * 1_000;
    const lastActivity = activityOfEvent(activity);
    if (activity.activity === "message") {
      const text = (activity.text ?? "").slice(0, 12_000);
      if (text === "") return detail;
      const last = detail.transcript[detail.transcript.length - 1];
      if (last?.type === "message" && last.role === "assistant" && last.text === text) {
        return { ...detail, last_activity: lastActivity };
      }
      return {
        ...detail,
        last_activity: lastActivity,
        transcript: [
          ...detail.transcript,
          { type: "message", role: "assistant", text, at },
        ],
      };
    }
    if (activity.activity === "tool") {
      const tool = (activity.tool ?? "").slice(0, 200);
      if (tool === "") return detail;
      const status =
        activity.status === "completed" || activity.status === "error"
          ? activity.status
          : "started";
      const openIndex = findOpenTool(detail.transcript, tool);
      if (status === "started") {
        if (openIndex >= 0) return detail;
        return {
          ...detail,
          last_activity: lastActivity,
          transcript: [
            ...detail.transcript,
            {
              type: "tool",
              tool,
              status,
              ...(activity.args !== undefined ? { args: activity.args } : {}),
              at,
            },
          ],
        };
      }
      if (openIndex >= 0) {
        const openEntry = detail.transcript[openIndex];
        if (openEntry === undefined || openEntry.type !== "tool") return detail;
        const transcript = [...detail.transcript];
        transcript[openIndex] = {
          ...openEntry,
          status,
          ...(typeof activity.result === "string" ? { result: activity.result } : {}),
        };
        return { ...detail, last_activity: lastActivity, transcript };
      }
      return {
        ...detail,
        last_activity: lastActivity,
        transcript: [
          ...detail.transcript,
          {
            type: "tool",
            tool,
            status,
            ...(activity.args !== undefined ? { args: activity.args } : {}),
            ...(typeof activity.result === "string" ? { result: activity.result } : {}),
            at,
          },
        ],
      };
    }
    return { ...detail, last_activity: lastActivity };
  }
  if (event.type === "subagent_completed") {
    const completed = event as SubagentCompletedEvent;
    if (completed.subagent_id !== detail.id) return detail;
    return {
      ...detail,
      status: statusOf(completed.status),
      ...(completed.result !== undefined ? { result: completed.result } : {}),
      ...(completed.error !== undefined ? { error: completed.error } : {}),
      usage: usageOf(completed.usage),
      duration_ms: intOf(completed.duration_ms),
      ended_at: intOf(completed.ended_at),
      last_activity: {
        kind: "status",
        status: completed.status,
        at: intOf(event.at) * 1_000,
      },
    };
  }
  return detail;
}

function findOpenTool(transcript: readonly SubagentTranscriptEntry[], tool: string): number {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const entry = transcript[index]!;
    if (entry.type === "tool" && entry.tool === tool && entry.status === "started") return index;
  }
  return -1;
}

// --------------------------------------------------------------------------- //
// labels
// --------------------------------------------------------------------------- //

/** Visual status marker per child lifecycle (the shared UI vocabulary). */
export function helperStatusGlyph(status: SubagentStatus): string {
  if (status === "completed") return "✓";
  if (status === "failed") return "✕";
  if (status === "cancelled") return "⊘";
  return "●";
}

function helperStatusTone(status: SubagentStatus): ThemeToken {
  if (status === "running") return "warning";
  if (status === "completed") return "success";
  if (status === "failed") return "error";
  return "dim";
}

/**
 * One-line live activity, mirroring the web tree's `subagentActivityText`
 * (`starting…`, `using read_file`, `read_file done`, `read_file failed`,
 * `waiting for approval`, `reported`, `failed`, `cancelled`, `writing report…`).
 */
export function helperActivityLabel(row: HelperRow): string {
  const activity = row.activity;
  if (activity === null || activity === undefined) {
    return row.status === "running" ? "starting…" : "";
  }
  if (activity.kind === "tool" && activity.tool) {
    return activity.status === "completed"
      ? `${activity.tool} done`
      : activity.status === "error"
        ? `${activity.tool} failed`
        : `using ${activity.tool}`;
  }
  if (activity.kind === "message") return activity.text || "writing report…";
  if (activity.kind === "status") {
    return activity.status === "completed"
      ? "reported"
      : activity.status === "failed"
        ? "failed"
        : activity.status === "cancelled"
          ? "cancelled"
          : activity.status === "awaiting_approval"
            ? "waiting for approval"
            : "working…";
  }
  return "";
}

/** Compact duration (`0:42`, `12:03`, `1:02:03`); `""` when the start is unknown. */
export function helperDuration(milliseconds: number): string {
  const total = Math.max(0, Math.floor((Number.isFinite(milliseconds) ? milliseconds : 0) / 1_000));
  const hours = Math.floor(total / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
}

/**
 * Elapsed time for one row: the settled duration when known, else `now`. The
 * caller supplies no clock here (the app's existing spinner repaint is the only
 * periodic caller), so a test can pin both ends deterministically.
 */
export function helperElapsed(
  startedAt: number,
  endedAt?: number | null,
  now: number = Date.now(),
): string {
  if (!Number.isFinite(startedAt) || startedAt <= 0) return "";
  const end = Number.isFinite(endedAt) && (endedAt ?? 0) > 0 ? Number(endedAt) : now;
  return helperDuration(end - startedAt);
}

/** `1.2k tok` / `14.2k tok` / `""` when the usage is unknown or empty. */
export function helperTokenLabel(usage: UsageTotals | null | undefined): string {
  if (!usage) return "";
  const total = Number(usage.input_tokens) + Number(usage.output_tokens);
  if (!Number.isFinite(total) || total <= 0) return "";
  if (total >= 1_000_000) return `${(total / 1_000_000).toFixed(1)}m tok`;
  if (total >= 100_000) return `${Math.round(total / 1_000)}k tok`;
  if (total >= 1_000) return `${(total / 1_000).toFixed(1)}k tok`;
  return `${formatCount(total)} tok`;
}

/** The box title: `HELPERS · 2 total · 1 running`. */
export function helpersListTitle(rows: readonly HelperRow[]): string {
  const counts = helperCounts(rows);
  return `HELPERS · ${counts.total} total · ${counts.running} running`;
}

// --------------------------------------------------------------------------- //
// overlay state + key routing
// --------------------------------------------------------------------------- //

/** The modal overlay's state: an id-anchored selection and the open child. */
export interface HelperOverlayState {
  /** Selected row, anchored by child id (never by index). */
  selectedId: string | null;
  /** The open child transcript, or null in list mode. */
  detail: SubagentDetail | null;
  /** Detail scroll offset from the bottom; `0` = follow the tail. */
  scroll: number;
}

/** A fresh overlay state in list mode. */
export function createHelperOverlayState(selectedId: string | null = null): HelperOverlayState {
  return { selectedId, detail: null, scroll: 0 };
}

/** The selected row's index, clamped into `rows` (0 when nothing is selected). */
export function helperSelectionIndex(
  rows: readonly HelperRow[],
  selectedId: string | null,
): number {
  if (rows.length === 0) return 0;
  const index = selectedId === null ? -1 : rows.findIndex((row) => row.id === selectedId);
  return index < 0 ? 0 : index;
}

/** The row a list-mode Enter opens, or null for an empty list. */
export function selectedHelperRow(
  rows: readonly HelperRow[],
  selectedId: string | null,
): HelperRow | null {
  if (rows.length === 0) return null;
  return rows[helperSelectionIndex(rows, selectedId)] ?? null;
}

/** What one overlay keypress asked the app to do. */
export type HelperOverlayAction =
  | "none"
  | "move"
  | "open"
  | "back"
  | "close"
  | "scroll";

export interface HelperOverlayKeyResult {
  state: HelperOverlayState;
  action: HelperOverlayAction;
}

/** Options for {@link helperOverlayKey}. */
export interface HelperOverlayKeyOptions {
  /** Rows one PgUp/PgDn press moves in the detail view. */
  page?: number;
  /** Total detail rows, so the scroll offset can be clamped. */
  detailRows?: number;
}

/**
 * Fold one keypress into the HELPERS overlay.
 *
 * Detail mode: `Enter` and `Esc` return to the list, PgUp/PgDn scroll the
 * transcript (offset from the bottom; `0` follows the tail). List mode:
 * `Ctrl+Y` (the `agents` command, app scope) closes the overlay, `Esc` closes
 * it, Up/Down move the id-anchored selection and `Enter` opens the selected
 * child. The app performs the actual store read on `"open"`, so a stale id is
 * reported honestly instead of rendering a fabricated row.
 */
export function helperOverlayKey(
  commands: readonly TuiCommand[],
  rows: readonly HelperRow[],
  state: HelperOverlayState,
  key: KeyLike,
  options: HelperOverlayKeyOptions = {},
): HelperOverlayKeyResult {
  const page = Math.max(1, Math.floor(options.page ?? HELPER_SCROLL_PAGE));
  const match = resolveKey(commands, key, "overlay");
  if (state.detail !== null) {
    if (match?.command.id === "list-close" || match?.command.id === "list-accept") {
      return { state: { ...state, detail: null, scroll: 0 }, action: "back" };
    }
    if (match?.command.id === "helper-scroll") {
      const total = Math.max(
        0,
        Math.floor(options.detailRows ?? helperDetailRows(state.detail).length),
      );
      const delta = match.chord.name.toLowerCase() === "pageup" ? page : -page;
      const scroll = Math.min(total, Math.max(0, state.scroll + delta));
      return { state: { ...state, scroll }, action: "scroll" };
    }
    return { state, action: "none" };
  }
  // List mode: the opener chord toggles the overlay closed (it is app scope, so
  // it is not part of the overlay resolution above).
  if (resolveKey(commands, key, "app")?.command.id === "agents") {
    return { state, action: "close" };
  }
  if (match?.command.id === "list-close") return { state, action: "close" };
  if (match?.command.id === "list-move") {
    if (rows.length === 0) return { state, action: "none" };
    const delta = match.chord.name.toLowerCase() === "up" ? -1 : 1;
    const current = helperSelectionIndex(rows, state.selectedId);
    const index = ((current + delta) % rows.length + rows.length) % rows.length;
    return { state: { ...state, selectedId: rows[index]!.id }, action: "move" };
  }
  if (match?.command.id === "list-accept") {
    const row = selectedHelperRow(rows, state.selectedId);
    if (row === null) return { state, action: "none" };
    return { state: { ...state, selectedId: row.id }, action: "open" };
  }
  return { state, action: "none" };
}

// --------------------------------------------------------------------------- //
// list view
// --------------------------------------------------------------------------- //

/** Render options for the list overlay. */
export interface HelpersListOptions {
  /** Box width (including the border). */
  width: number;
  /** Box height (including the border). */
  height: number;
  theme?: Theme;
  /** Registry commands whose effective chords drive the footer. */
  commands?: readonly TuiCommand[];
  /** True for an in-memory session (its child logs are never listed). */
  inMemory?: boolean;
  /** Clock for the elapsed labels (tests pin it; the app leaves it out). */
  now?: number;
}

export interface HelpersListView {
  lines: string[];
  /** Rows visible this frame (excludes the `+N older` tail). */
  visible: HelperRow[];
  selectedRow: number;
  empty: boolean;
  /** Rows hidden behind the tail. */
  hidden: number;
}

function helperRowLine(
  row: HelperRow,
  selected: boolean,
  contentWidth: number,
  theme: Theme,
  now: number,
): string {
  const marker = selected ? "› " : "  ";
  const glyph = helperStatusGlyph(row.status);
  const elapsed = helperElapsed(row.startedAt, row.endedAt, now);
  const activity = helperActivityLabel(row);
  const tokens = helperTokenLabel(row.usage);
  const right = [elapsed, activity, tokens].filter((part) => part !== "").join("  ");
  // Keep at least six cells for the label; cap the right column so it can
  // never crowd out the identity of the row.
  const rightBudget = Math.max(0, Math.min(30, contentWidth - 8));
  const rightText = clipDisplay(right, rightBudget);
  const rightWidth = rightText === "" ? 0 : displayWidth(rightText) + 2;
  const labelBudget = Math.max(1, contentWidth - 4 - rightWidth);
  const labelText = clipDisplay(row.label, labelBudget);
  let text = `${marker}${glyph} ${labelText}`;
  if (rightText !== "") {
    const gap = Math.max(1, contentWidth - displayWidth(text) - displayWidth(rightText));
    text += `${" ".repeat(gap)}${rightText}`;
  }
  text = clipDisplay(text, contentWidth);
  const tone: ThemeToken = selected ? "focus" : helperStatusTone(row.status);
  return theme.paint(tone, text);
}

/**
 * Render the HELPERS list into an exact `width × height` box.
 *
 * Geometry follows the help/picker pattern: the title carries the counts, the
 * body keeps `height - 4` rows (rows, a spacer and the registry-derived footer)
 * and a list longer than {@link HELPERS_LIST_MAX_ROWS} (or the box) ends with
 * an honest `+N older (not shown)` tail. An empty list states whether the
 * session has no file (live-only) or simply has not delegated yet.
 */
export function helpersListView(
  rows: readonly HelperRow[],
  state: HelperOverlayState,
  options: HelpersListOptions,
): HelpersListView {
  const width = Math.max(0, Math.floor(options.width));
  const height = Math.max(0, Math.floor(options.height));
  if (width === 0 || height === 0) {
    return { lines: [], visible: [], selectedRow: -1, empty: rows.length === 0, hidden: 0 };
  }
  const theme = options.theme ?? plainTheme;
  const commands = options.commands ?? TUI_COMMANDS;
  const now = options.now ?? Date.now();
  const contentWidth = Math.max(1, boxContentWidth(width));
  const capacity = Math.max(0, height - 4);
  const footer = hintSegments(commands, [
    { id: "list-move", label: "move" },
    { id: "list-accept", label: "open" },
    { id: "list-close", label: "close" },
  ]);

  const lines: string[] = [];
  const visible: HelperRow[] = [];
  let selectedRow = -1;
  let hidden = 0;

  if (rows.length === 0) {
    lines.push(
      theme.paint(
        "muted",
        clipDisplay(
          options.inMemory === true ? HELPERS_MEMORY_COPY : HELPERS_EMPTY_COPY,
          contentWidth,
        ),
      ),
    );
  } else if (capacity > 0) {
    const cap = Math.min(HELPERS_LIST_MAX_ROWS, capacity);
    const tailNeeded = rows.length > cap;
    const rowSlots = tailNeeded ? Math.max(0, cap - 1) : cap;
    hidden = rows.length - rowSlots;
    const selected = helperSelectionIndex(rows, state.selectedId);
    const start =
      rows.length <= rowSlots
        ? 0
        : Math.min(Math.max(0, selected - Math.floor(rowSlots / 2)), rows.length - rowSlots);
    const slice = rows.slice(start, start + rowSlots);
    slice.forEach((row, index) => {
      const isSelected = start + index === selected;
      lines.push(helperRowLine(row, isSelected, contentWidth, theme, now));
      visible.push(row);
      if (isSelected) selectedRow = lines.length;
    });
    if (tailNeeded) {
      lines.push(theme.paint("dim", clipDisplay(`+${hidden} older (not shown)`, contentWidth)));
    }
  }
  while (lines.length < capacity) lines.push("");
  const body = [...lines.slice(0, capacity)];
  while (body.length < capacity) body.push("");
  body.push("", theme.paint("dim", clipDisplay(footer, contentWidth)));
  while (body.length < Math.max(0, height - 2)) body.push("");
  const boxed = renderBox(body.slice(0, Math.max(0, height - 2)), {
    width,
    title: helpersListTitle(rows),
    theme,
    tone: helperCounts(rows).running > 0 ? "warning" : "border",
  }).slice(0, height);
  while (boxed.length < height) boxed.push("");
  return { lines: boxed, visible, selectedRow, empty: rows.length === 0, hidden };
}

// --------------------------------------------------------------------------- //
// detail view
// --------------------------------------------------------------------------- //

/** One logical row of the child transcript (before width wrapping). */
export interface HelperDetailRow {
  kind: "task" | "helper" | "followup" | "tool" | "approval" | "error" | "report" | "empty";
  /** Short row label (`Task`, `Helper`, `Tool · read_file`, …). */
  label: string;
  /** Bounded row body. */
  text: string;
  at: number;
}

function toolPreview(entry: SubagentMessageEntry): string {
  const source = entry.status === "started" ? entry.args : entry.result ?? entry.args;
  if (source === undefined) return "";
  const text = typeof source === "string" ? source : JSON.stringify(source);
  return clipDisplay(text, HELPERS_TOOL_PREVIEW_CHARS);
}

function messageLabel(entry: SubagentMessageEntry): string {
  if (entry.role !== "user") return "Helper";
  if (entry.origin === "operator") return "Follow-up · operator";
  if (entry.origin === "senior") return "Follow-up · Senior";
  return "Task";
}

function approvalText(entry: SubagentApprovalEntry): string {
  const subject = entry.command !== undefined && entry.command !== ""
    ? `$ ${entry.command}`
    : entry.target ?? "";
  return subject === "" ? entry.status : `${subject} — ${entry.status}`;
}

/**
 * Build the child transcript's logical rows, newest-capped at
 * {@link HELPERS_DETAIL_MAX_ROWS} FROM THE TAIL (the oldest rows drop first).
 * The full content stays in the child log; this is the bounded view.
 */
export function helperDetailRows(detail: SubagentDetail): HelperDetailRow[] {
  const transcript = detail.transcript;
  const kept = transcript.slice(-HELPERS_DETAIL_MAX_ROWS);
  const rows: HelperDetailRow[] = [];
  for (const entry of kept) {
    if (entry.type === "approval") {
      rows.push({
        kind: "approval",
        label: `Approval · ${entry.action}`,
        text: approvalText(entry),
        at: entry.at,
      });
      continue;
    }
    if (entry.type === "tool") {
      rows.push({
        kind: "tool",
        label: `Tool · ${entry.tool ?? "(tool)"} · ${entry.status ?? "started"}`,
        text: toolPreview(entry),
        at: entry.at,
      });
      continue;
    }
    rows.push({
      kind: entry.role === "user"
        ? entry.origin === undefined
          ? "task"
          : "followup"
        : "helper",
      label: messageLabel(entry),
      text: clipDisplay(entry.text ?? "", 12_000),
      at: entry.at,
    });
  }
  if (detail.status !== "completed" && detail.error !== undefined && detail.error !== null && detail.error !== "") {
    rows.push({
      kind: "error",
      label: "Error",
      text: detail.error,
      at: detail.ended_at ?? 0,
    });
  }
  const report = detail.result ?? "";
  if (
    report !== "" &&
    !kept.some(
      (entry) =>
        entry.type === "message" && entry.role === "assistant" && entry.text === report,
    )
  ) {
    rows.push({ kind: "report", label: "Report", text: report, at: detail.ended_at ?? 0 });
  }
  if (rows.length === 0) {
    rows.push({ kind: "empty", label: "", text: "No transcript rows yet.", at: 0 });
  }
  return rows;
}

/** Render options for the child transcript overlay. */
export interface HelperDetailOptions {
  /** Box width (including the border). */
  width: number;
  /** Box height (including the border). */
  height: number;
  theme?: Theme;
  /** Registry commands whose effective chords drive the footer. */
  commands?: readonly TuiCommand[];
  /** Clock for the elapsed label (tests pin it; the app leaves it out). */
  now?: number;
}

export interface HelperDetailView {
  lines: string[];
  /** Every logical row (unwindowed), for tests and scroll bounds. */
  rows: HelperDetailRow[];
  /** Rows visible this frame. */
  visible: HelperDetailRow[];
  /** Offset of `visible[0]` in `rows`. */
  start: number;
}

/** The four fixed header rows (label, connection, status, tokens). */
export function helperDetailHeader(
  detail: SubagentDetail,
  options: { now?: number } = {},
): string[] {
  const elapsed = helperElapsed(detail.started_at, detail.ended_at, options.now ?? Date.now());
  const tokens = helperTokenLabel(detail.usage);
  const statusParts = [detail.status, elapsed].filter((part) => part !== "");
  if (detail.background === true) statusParts.push("background");
  const connection = `${detail.model || "(model unknown)"} · ${detail.role}`;
  return [
    detail.label || "Subagent",
    connection,
    statusParts.join(" · "),
    tokens === "" ? "tokens unknown" : `tokens ${tokens}`,
  ];
}

/**
 * Render one child's transcript into an exact `width × height` box: a four-row
 * header (label, model · role, status · elapsed, tokens), a spacer, the
 * follow-tail window of {@link helperDetailRows} and the registry-derived
 * footer. `state.scroll` is an offset from the bottom (`0` follows the tail), so
 * a live child keeps painting its newest rows without any timer.
 */
export function helperDetailView(
  detail: SubagentDetail,
  state: HelperOverlayState,
  options: HelperDetailOptions,
): HelperDetailView {
  const width = Math.max(0, Math.floor(options.width));
  const height = Math.max(0, Math.floor(options.height));
  if (width === 0 || height === 0) {
    return { lines: [], rows: [], visible: [], start: 0 };
  }
  const theme = options.theme ?? plainTheme;
  const commands = options.commands ?? TUI_COMMANDS;
  const contentWidth = Math.max(1, boxContentWidth(width));
  const rows = helperDetailRows(detail);
  const capacity = Math.max(0, height - 8); // border(2) + header(4) + spacer + footer
  const offset = Math.min(Math.max(0, Math.floor(state.scroll)), rows.length);
  const end = Math.max(0, rows.length - offset);
  const start = Math.max(0, end - capacity);
  const visible = rows.slice(start, end);

  const header = helperDetailHeader(detail, options.now !== undefined ? { now: options.now } : {});
  const headerRows = [
    theme.paint("strong", clipDisplay(header[0] ?? "", contentWidth)),
    theme.paint("muted", clipDisplay(header[1] ?? "", contentWidth)),
    theme.paint(
      helperStatusTone(detail.status),
      clipDisplay(header[2] ?? "", contentWidth) +
        (offset > 0 ? `  · scrolled ${offset} from the tail` : ""),
    ),
    theme.paint("muted", clipDisplay(header[3] ?? "", contentWidth)),
  ];

  const body: string[] = [...headerRows, ""];
  for (const row of visible) {
    const prefix = row.label === "" ? "" : `${row.label} · `;
    const wrapped = wrapDisplay(`${prefix}${row.text}`, contentWidth);
    const tone: ThemeToken =
      row.kind === "error"
        ? "error"
        : row.kind === "tool"
          ? "accent"
          : row.kind === "approval"
            ? "muted"
            : row.kind === "task" || row.kind === "report"
              ? "strong"
              : row.kind === "empty"
                ? "dim"
                : "text";
    for (const rowText of wrapped) {
      body.push(rowText === "" ? "" : theme.paint(tone, rowText));
    }
  }
  while (body.length < Math.max(0, height - 3)) body.push("");
  const footer = hintSegments(commands, [
    { id: "helper-scroll", label: "scroll" },
    { id: "list-close", label: "back" },
  ]);
  const boxed = renderBox(
    [...body.slice(0, Math.max(0, height - 3)), theme.paint("dim", clipDisplay(footer, contentWidth))],
    { width, title: `HELPER · ${detail.status}`, theme, tone: helperStatusTone(detail.status) },
  ).slice(0, height);
  while (boxed.length < height) boxed.push("");
  return { lines: boxed, rows, visible, start };
}

/** Convenience wrapper returning only the rendered rows. */
export function renderHelpersList(
  rows: readonly HelperRow[],
  state: HelperOverlayState,
  options: HelpersListOptions,
): string[] {
  return helpersListView(rows, state, options).lines;
}

/** Convenience wrapper returning only the rendered rows. */
export function renderHelperDetail(
  detail: SubagentDetail,
  state: HelperOverlayState,
  options: HelperDetailOptions,
): string[] {
  return helperDetailView(detail, state, options).lines;
}

/** True for the runtime events this module folds (used by the app's sink). */
export function isHelperRuntimeEvent(event: RuntimeEvent): boolean {
  return (
    event.type === "subagent_started" ||
    event.type === "subagent_activity" ||
    event.type === "subagent_completed" ||
    (event.type === "approval_requested" &&
      typeof (event as { subagent_id?: unknown }).subagent_id === "string") ||
    (event.type === "approval_resolved" &&
      typeof (event as { subagent_id?: unknown }).subagent_id === "string")
  );
}

/** Sanitize one model-provided label/text before it reaches a view (shared). */
export function helperDisplayText(text: string): string {
  return sanitizeDisplayText(text);
}

/** Bounded copy for a tool row (used by the view and available to tests). */
export function helperToolPreview(entry: SubagentMessageEntry): string {
  return entry.type === "tool" ? toolPreview(entry) : "";
}
