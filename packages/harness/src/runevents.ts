/**
 * Runtime-event plumbing: evidence clipping, typed run events, sidecar
 * persistence, and the operator approval broker. Ports the original
 * prototype's runtime-events module (removed 2026-11-04; see git history).
 *
 * The protocol session file (`<name>.jsonl`) stays pure protocol envelopes.
 * Everything the *runtime* learns — tool calls, diffs, approvals, run status —
 * is persisted separately, one sidecar per session:
 *
 *     sessions/runtime/<name>.events.jsonl
 *
 * so a UI reload can recover tool/approval history without touching the
 * envelope log. Events are the typed runtime events (run_status / envelope /
 * tool_started / tool_completed / approval_requested / approval_resolved /
 * approval_auto_denied / approval_auto_allowed / todo_updated / prompt_audit /
 * reasoning / auto_route / subagent_started / subagent_activity /
 * subagent_completed / run_error / run_end) plus `run_id`
 * and `at` (epoch seconds). Event JSON keeps the Python field names
 * (`run_id`, `approval_id`) so sidecar files stay interchangeable with the
 * Python implementation; `prompt_audit` keeps its camelCase payload
 * (`systemChars`/`userChars`) to stay identical to `PromptAuditEntry`.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import type { SessionLayout } from "./sessionlayout.ts";
import { randomUUID } from "node:crypto";

import { sanitizeOutput } from "./output.ts";

import {
  Action,
  Decision,
  type ApprovalBroker,
  type ApprovalDetail,
  type ApprovalRequest,
} from "./permissions.ts";
import type { PromptAuditEntry } from "./harness.ts";
import type { TodoItem } from "./todos.ts";

export const CLIP_RESULT_CHARS = 800;
export const CLIP_ARG_CHARS = 200;
export const CLIP_EVIDENCE_CHARS = 240;
export const MAX_EVIDENCE_ENTRIES = 12;
/**
 * Hard cap on the additive `preview` one compacted workspace result carries.
 * Small enough that one tool_completed sidecar line stays bounded even with
 * the existing clipped fields alongside it.
 */
export const CLIP_PREVIEW_CHARS = 500;
/** Hard cap on directory entries / search matches summarised into a preview. */
export const MAX_PREVIEW_ENTRIES = 20;

/** Common envelope every run-manager-emitted event carries. */
export interface RuntimeEventMeta {
  /** Owning run (12-hex id); set by the RunManager on every event. */
  run_id?: string;
  /** Epoch seconds when the event was emitted. */
  at?: number;
}

/** Typed runtime event: a tool invocation started (args already clipped). */
export interface ToolStartedEvent extends RuntimeEventMeta {
  type: "tool_started";
  tool: string;
  args: Record<string, unknown>;
  actor: string;
}

/** Typed runtime event: a tool invocation finished (result already compacted). */
export interface ToolCompletedEvent extends RuntimeEventMeta {
  type: "tool_completed";
  tool: string;
  status: string;
  result: unknown;
  actor: string;
}

/** Run status transition (queued → running → waiting → terminal). */
export interface RunStatusEvent extends RuntimeEventMeta {
  type: "run_status";
  status: string;
}

/** A protocol envelope observed during the run, wrapped without alteration. */
export interface EnvelopeEvent extends RuntimeEventMeta {
  type: "envelope";
  seq: number;
  envelope: unknown;
}

/**
 * Additive tree event: the Senior started one isolated helper. The
 * task is bounded for the tree; the full task lives in the child transcript
 * store. Older consumers can ignore the type.
 */
export interface SubagentStartedEvent extends RuntimeEventMeta {
  type: "subagent_started";
  subagent_id: string;
  label: string;
  role: "senior" | "junior";
  /** Role model resolved at spawn time (display only). */
  model: string;
  /** Bounded task preview (the child log carries the full brief). */
  task: string;
  /** Epoch milliseconds, for a stable duration across reloads. */
  started_at: number;
  /**
   * Additive: true only for a `background:true` spawn (the parent continued
   * without waiting). Absent for every synchronous spawn, so existing event
   * bytes are unchanged.
   */
  background?: boolean;
}

/** Additive tree event: one child message/tool/status step completed. */
export interface SubagentActivityEvent extends RuntimeEventMeta {
  type: "subagent_activity";
  subagent_id: string;
  label: string;
  activity: "message" | "tool" | "status";
  /** Bounded message text or tool preview. */
  text?: string;
  tool?: string;
  status?: string;
  args?: Record<string, unknown>;
  result?: unknown;
}

/** Additive tree event: the child settled (terminal for this activation). */
export interface SubagentCompletedEvent extends RuntimeEventMeta {
  type: "subagent_completed";
  subagent_id: string;
  label: string;
  status: "completed" | "failed" | "cancelled";
  result?: string;
  error?: string;
  usage?: Record<string, unknown>;
  duration_ms: number;
  ended_at: number;
  /**
   * Additive: present only when `status:"cancelled"`, naming the cause
   * (operator interrupt, the Senior's interrupt, the parent run stopping, or
   * the startup reconciliation of an orphaned log). A completed child carries
   * no such key, so its event bytes are unchanged.
   */
  cancelled_by?: "operator" | "senior" | "parent_run" | "restart";
}

/** An approval wait was parked; the operator must answer (or the run stops). */
export interface ApprovalRequestedEvent extends RuntimeEventMeta {
  type: "approval_requested";
  approval_id: string;
  action: string;
  target?: string;
  command?: string;
  /** Why the action needs approval (e.g. a sensitive-path note). */
  reason?: string;
  /**
   * Additive bounded preview of the pending mutation (unified diff for
   * write/edit, the command for shell). Consumers that only understand the
   * action/target/command fields can ignore it safely; the field is omitted
   * when the request carries no detail.
   */
  detail?: ApprovalDetail;
  /**
   * Additive helper identity: present only when an isolated subagent's tool
   * call parked this request. Display/routing only — old consumers ignore it,
   * and it is never part of the session-allow `(action, target)` pair.
   */
  subagent_id?: string;
  subagent_label?: string;
}

/** An approval wait was resolved exactly once (allow/deny, or deny/cancelled). */
export interface ApprovalResolvedEvent extends RuntimeEventMeta {
  type: "approval_resolved";
  approval_id: string;
  decision: string;
  reason?: string;
  /** Additive; lets a live UI clear the helper's "waiting" row. */
  subagent_id?: string;
}

/**
 * Additive event: an identical approval request was auto-denied by the
 * broker's operator-denial cap, so it never parked and never emitted an
 * `approval_requested`. `action` + `target` identify the repeated pair (a
 * shell request's target is its command), `count` is the number of operator
 * denials already recorded for that pair when the cap tripped, `limit` is the
 * configured cap. Consumers that only understand `approval_requested` /
 * `approval_resolved` can ignore this event type safely.
 */
export interface ApprovalAutoDeniedEvent extends RuntimeEventMeta {
  type: "approval_auto_denied";
  action: string;
  target: string;
  count: number;
  limit: number;
}

/**
 * Additive event: an identical approval request was auto-allowed because the
 * operator answered "always allow for this session" for its `(action, target)`
 * pair (or the server seeded the pair from `sessions/settings.json`), so it
 * never parked and never emitted an `approval_requested`. Emitted exactly once
 * per auto-allowed call; `action` + `target` identify the pair (a shell
 * request's target is its command). Consumers that only understand
 * `approval_requested` / `approval_resolved` can ignore this event type safely.
 */
export interface ApprovalAutoAllowedEvent extends RuntimeEventMeta {
  type: "approval_auto_allowed";
  action: string;
  target: string;
}

/**
 * Additive event: the model replaced the whole plan/todo list through the
 * built-in `todo_write` tool. `todos` is the complete sanitized snapshot (the
 * latest write wins on replay); the event is display state only — it never
 * touches protocol envelopes, the session JSONL or the workspace. Persisted by
 * the run sidecar like every typed event, so a UI reload replays it.
 */
export interface TodoUpdatedEvent extends RuntimeEventMeta {
  type: "todo_updated";
  todos: TodoItem[];
}

/**
 * One provider call's prompt/tool-belt audit, streamed as it happens: the
 * payload is `PromptAuditEntry` field for field (names and lengths only,
 * never prompt bodies), so `HarnessResult.promptAudits` and this event stream
 * stay the same contract. Emitted immediately before the call, one per
 * request (overflow retries included; compaction summarizer calls excluded).
 */
export interface PromptAuditEvent extends RuntimeEventMeta, PromptAuditEntry {
  type: "prompt_audit";
}

/** Hard cap on one persisted reasoning record's text (chars, head+tail kept). */
export const REASONING_EVENT_MAX_CHARS = 10_000;

/**
 * Additive event: the bounded, sanitized reasoning (thinking) the model
 * streamed during ONE provider call, persisted by the run sidecar so a web
 * reload can replay it as a collapsed "Thinking · replayed" row. The record
 * covers one node call seam: an internal overflow-recovery retry inside that
 * seam merges both attempts' deltas into the single record, and a
 * failed/cancelled call keeps the reasoning it streamed so far.
 *
 * Capture is streaming-only: the harness receives reasoning text solely
 * through `ChatOptions.onThinkingDelta`, which it only builds when
 * `streamTokens` is on AND a stream consumer exists. A non-streaming call
 * therefore emits none (the provider contract returns no reasoning text there).
 * Unlike the live `token` stream events this event is bounded
 * ({@link REASONING_EVENT_MAX_CHARS}, head+tail with the shared truncation
 * marker), ANSI/control-sanitized, and never carries prompt bodies, usage or
 * secrets. Consumers that do not know the type can ignore it safely.
 */
export interface ReasoningEvent extends RuntimeEventMeta {
  type: "reasoning";
  role: "senior" | "junior";
  /** Node kind the call answered (consult / delegation / proposal / deliverable / verify / review / decision). */
  kind: string;
  /** Sanitized reasoning text the live thinking stream carried, bounded. */
  text: string;
  /** True when the bound clipped the stream (the text then ends with the marker form). */
  truncated: boolean;
}

/**
 * Additive event: operator steering texts were DISCARDED because the
 * per-run envelope cap (`MAX_STEERING_ENVELOPES_PER_RUN`, harness.ts) was
 * reached. `dropped` is how many valid texts the drain that hit the cap threw
 * away, `applied` the steer envelopes already appended this run and `limit`
 * the cap. Emitted once per drain that drops text; persisted by the run
 * sidecar like every typed event, and `RunRecord.public()` aggregates it as
 * `steering_dropped` so an HTTP client that only polls the run record still
 * learns a 200-accepted text was not applied (a drop is never silent).
 * Consumers that do not know the type can ignore it safely.
 */
export interface SteeringDroppedEvent extends RuntimeEventMeta {
  type: "steering_dropped";
  dropped: number;
  applied: number;
  limit: number;
}

/**
 * Additive event: the auto-mode routing pre-decision (`senior_route` node).
 * `route` is the EFFECTIVE route after the harness guardrails, `reason` the
 * senior's one-sentence justification (flattened, clipped), `requested` the
 * mode the operator asked for (always "auto" today) and `downgraded_from`
 * present only when guardrail G1 downgraded work→consult because no workspace
 * is bound. Emitted once per auto run, before the `[[AUTO ROUTE]]` marker
 * envelope is published; persisted by the run sidecar like every typed event,
 * and `RunRecord.public()` derives `route`/`route_reason` from it so the
 * fields survive a sidecar-rebuilt terminal record. Consumers that do not
 * know the type can ignore it safely.
 */
export interface AutoRouteEvent extends RuntimeEventMeta {
  type: "auto_route";
  route: "solo" | "consult" | "work";
  reason: string;
  requested: "auto";
  downgraded_from?: "work";
}

/** The job raised; surfaced to the operator before run_end. */
export interface RunErrorEvent extends RuntimeEventMeta {
  type: "run_error";
  message: string;
}

/**
 * Additive live usage snapshot: emitted after a cooperation node finishes its
 * provider calls, before the next node starts. Mirrors `run_end.usage` so a
 * client can show tokens and the cache-hit percentage while the run works;
 * the RunManager also folds it into the live run record. Consumers that do not
 * know the type can ignore it safely.
 */
export interface UsageEvent extends RuntimeEventMeta {
  type: "usage";
  usage: Record<string, unknown>;
}

/** Terminal event: carries the final status and the per-run usage totals. */
export interface RunEndEvent extends RuntimeEventMeta {
  type: "run_end";
  status: string;
  usage: Record<string, unknown>;
  decision?: Record<string, unknown>;
}

/** Every typed runtime event the harness/manager/broker can emit. */
export type RuntimeEvent =
  | ToolStartedEvent
  | ToolCompletedEvent
  | RunStatusEvent
  | EnvelopeEvent
  | ApprovalRequestedEvent
  | ApprovalResolvedEvent
  | ApprovalAutoDeniedEvent
  | ApprovalAutoAllowedEvent
  | TodoUpdatedEvent
  | PromptAuditEvent
  | ReasoningEvent
  | SteeringDroppedEvent
  | AutoRouteEvent
  | UsageEvent
  | SubagentStartedEvent
  | SubagentActivityEvent
  | SubagentCompletedEvent
  | RunErrorEvent
  | RunEndEvent;

export function clipText(text: unknown, limit: number): string {
  const collapsed = String(text).replace(/\s+/g, " ").trim();
  return collapsed.length <= limit ? collapsed : collapsed.slice(0, limit - 1) + "…";
}

/** Block clip: no whitespace collapsing (used for stdout/stderr/diff bodies). */
export function clipBlock(text: unknown, limit: number): string {
  const value = String(text);
  return value.length <= limit ? value : value.slice(0, limit - 1) + "…";
}

/** Argument values clipped so tool_started events stay compact. */
export function clipArgs(args: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args ?? {})) {
    out[key] = clipText(value, CLIP_ARG_CHARS);
  }
  return out;
}

/** Character cap on one name/path line inside a preview. */
const CLIP_PREVIEW_NAME_CHARS = 120;

/** Workspace result kinds that get a bounded display preview. */
const PREVIEW_TOOL_NAMES = new Set(["read_file", "list_dir", "search_text"]);

/** `workspace_read_file` / `read_file` -> `read_file`; unsupported -> null. */
function previewToolKind(tool: unknown): string | null {
  if (typeof tool !== "string") return null;
  const name = tool.startsWith("workspace_") ? tool.slice("workspace_".length) : tool;
  return PREVIEW_TOOL_NAMES.has(name) ? name : null;
}

/** One sanitized, single-line name/path inside a preview. */
function previewValue(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return clipText(sanitizeOutput(text), CLIP_PREVIEW_NAME_CHARS);
}

/** Join up to the entry cap, keeping an honest count of what the preview omits. */
function previewLines(
  values: unknown[],
  lineOf: (value: unknown) => string,
  omittedBeyond: number,
): string {
  const shown = values.slice(0, MAX_PREVIEW_ENTRIES);
  const lines = shown.map(lineOf).filter((line) => line !== "");
  const omitted =
    values.length - shown.length + (Number.isFinite(omittedBeyond) && omittedBeyond > 0 ? omittedBeyond : 0);
  if (omitted > 0) lines.push(`... (${omitted} more)`);
  return clipBlock(sanitizeOutput(lines.join("\n")), CLIP_PREVIEW_CHARS);
}

/**
 * Additive bounded preview for the object results the web tool card cannot
 * otherwise show: a directory listing, a file's content head, or search match
 * paths. Returns null for anything unrecognised or empty, so small and
 * unsupported results keep their historical compact shape byte-for-byte.
 * Never carries a whole file: content is clipped to {@link CLIP_PREVIEW_CHARS}
 * and listings/matches to {@link MAX_PREVIEW_ENTRIES}.
 */
function toolResultPreview(record: Record<string, unknown>): string | null {
  const kind = previewToolKind(record.tool);
  if (kind === null) return null;
  if (kind === "read_file") {
    const content = record.content;
    if (typeof content !== "string" || content === "") return null;
    return clipBlock(sanitizeOutput(content), CLIP_PREVIEW_CHARS);
  }
  if (kind === "list_dir") {
    const entries = record.entries;
    if (!Array.isArray(entries) || entries.length === 0) return null;
    const omitted = typeof record.omitted_entries === "number" ? record.omitted_entries : 0;
    const preview = previewLines(
      entries,
      (entry) => {
        if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
          const item = entry as Record<string, unknown>;
          const name = previewValue(item.name);
          const type = previewValue(item.type);
          return type ? `${type} ${name}` : name;
        }
        return previewValue(entry);
      },
      omitted,
    );
    return preview === "" ? null : preview;
  }
  const matches = record.matches;
  if (!Array.isArray(matches) || matches.length === 0) return null;
  const omitted = typeof record.omitted_matches === "number" ? record.omitted_matches : 0;
  const preview = previewLines(
    matches,
    (match) => {
      if (match !== null && typeof match === "object" && !Array.isArray(match)) {
        const item = match as Record<string, unknown>;
        const path = previewValue(item.path);
        const line =
          typeof item.line === "number" && Number.isFinite(item.line) ? `:${item.line}` : "";
        return path ? `${path}${line}` : "";
      }
      return previewValue(match);
    },
    omitted,
  );
  return preview === "" ? null : preview;
}

/**
 * Compact a tool result for runtime events and deliverable evidence.
 * Workspace tools (Stage 5) return JSON objects with a `tool` key; those are
 * summarised field-by-field. Anything else is clipped to one string.
 */
export function compactToolResult(raw: unknown, limit = CLIP_RESULT_CHARS): unknown {
  let data: unknown = raw;
  if (typeof raw === "string") {
    try {
      data = JSON.parse(raw);
    } catch {
      return clipText(raw, limit);
    }
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return clipText(JSON.stringify(data), limit);
  }
  const record = data as Record<string, unknown>;
  if (!("tool" in record)) {
    return clipText(JSON.stringify(data), limit);
  }
  const compact: Record<string, unknown> = { status: record.status ?? "?" };
  for (const key of [
    "path",
    "command",
    "exit_code",
    "error",
    "bytes_written",
    "replaced",
    "deleted",
    "truncated",
    "duration_ms",
    "timed_out",
    "cancelled",
  ]) {
    const value = record[key];
    if (value !== undefined && value !== null && value !== "") {
      compact[key] = typeof value === "string" ? clipText(value, CLIP_ARG_CHARS) : value;
    }
  }
  for (const key of ["stdout", "stderr"]) {
    const value = record[key];
    if (value) compact[key] = clipBlock(value, limit);
  }
  const diff = record.diff;
  if (diff !== null && typeof diff === "object" && !Array.isArray(diff)) {
    const diffRecord = diff as Record<string, unknown>;
    if (diffRecord.unified) {
      compact.diff = {
        added_lines: diffRecord.added_lines ?? 0,
        removed_lines: diffRecord.removed_lines ?? 0,
        unified: clipBlock(diffRecord.unified, limit),
      };
    }
  }
  const preview = toolResultPreview(record);
  if (preview !== null) compact.preview = preview;
  return compact;
}

/** One clipped evidence line about a completed tool call. */
export function toolEvidenceLine(compact: unknown, tool: string): string {
  if (compact === null || typeof compact !== "object" || Array.isArray(compact)) {
    return clipText(`${tool}: ${String(compact)}`, CLIP_EVIDENCE_CHARS);
  }
  const record = compact as Record<string, unknown>;
  const parts: string[] = [tool];
  if (record.path) parts.push(String(record.path));
  if (record.command) parts.push(`$ ${clipText(record.command, 80)}`);
  parts.push(`[${String(record.status ?? "?")}]`);
  const diff = record.diff;
  if (diff !== null && typeof diff === "object" && !Array.isArray(diff)) {
    const diffRecord = diff as Record<string, unknown>;
    parts.push(`+${String(diffRecord.added_lines ?? 0)}/-${String(diffRecord.removed_lines ?? 0)}`);
  }
  if (record.exit_code !== undefined && record.exit_code !== null) {
    parts.push(`exit=${String(record.exit_code)}`);
  }
  if (record.error) parts.push(String(record.error));
  return clipText(parts.join(" "), CLIP_EVIDENCE_CHARS);
}

// ---------------------------------------------------------------------------
// RuntimeEventStore: append-only JSONL sidecar, one per session
// ---------------------------------------------------------------------------

/**
 * Append-only JSONL sidecar of runtime events, keyed by session name.
 * Mirrors the original prototype's event store (removed 2026-11-04; see git
 * history). Writes are
 * synchronous and flushed by the kernel on close, so a torn *last* line is
 * the only crash artifact — `load()` tolerates it. `findRun()` rebuilds one
 * run's events from the sidecars, the durable half of a run record after a
 * backend restart (run records themselves are in-memory).
 */
export class RuntimeEventStore {
  readonly directory: string;
  private readonly layout: SessionLayout | null;

  constructor(directory: string, layout?: SessionLayout | null) {
    this.directory = directory;
    this.layout = layout ?? null;
  }

  /** `path.basename` flattening: never allow path traversal out of the dir. */
  private pathFor(sessionName: string): string {
    if (this.layout !== null) {
      const resolved = this.layout.resolveForWrite(sessionName);
      if (resolved !== null) return resolved.eventsPath;
    }
    return path.join(this.directory, `${path.basename(sessionName)}.events.jsonl`);
  }

  exists(sessionName: string): boolean {
    return fs.existsSync(this.pathFor(sessionName));
  }

  /** Remove the sidecar if present; `false` when there was none. */
  delete(sessionName: string): boolean {
    const target = this.pathFor(sessionName);
    if (!fs.existsSync(target)) return false;
    fs.unlinkSync(target);
    return true;
  }

  /** All parseable events; blank lines and a torn last line are skipped. */
  load(sessionName: string): Array<Record<string, unknown>> {
    const target = this.pathFor(sessionName);
    if (!fs.existsSync(target)) return [];
    const events: Array<Record<string, unknown>> = [];
    for (const rawLine of fs.readFileSync(target, "utf-8").split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        continue; // tolerate a torn last line (mid-write crash)
      }
      if (event !== null && typeof event === "object" && !Array.isArray(event)) {
        events.push(event as Record<string, unknown>);
      }
    }
    return events;
  }

  /**
   * Find one run across the sidecars (restart survival). Run ids are unique
   * per run, so at most one file carries it; files are scanned in sorted
   * order to stay deterministic. Returns the owning session (the file stem)
   * and that run's events, or null when no sidecar has the run.
   */
  findRun(runId: string): { session: string; events: Array<Record<string, unknown>> } | null {
    if (this.layout !== null) {
      const seen = new Set<string>();
      for (const location of [
        ...this.layout.list(),
        ...this.layout.listEventSessions(),
      ]) {
        if (seen.has(location.name)) continue;
        seen.add(location.name);
        const events = this.load(location.name).filter((event) => event.run_id === runId);
        if (events.length > 0) return { session: location.name, events };
      }
      // A failed run may never have materialized its session file; its flat
      // runtime sidecar still survives a backend restart.
    }
    const suffix = ".events.jsonl";
    let files: string[];
    try {
      files = fs.readdirSync(this.directory);
    } catch {
      return null; // no runtime directory yet
    }
    files.sort();
    for (const file of files) {
      if (!file.endsWith(suffix)) continue;
      const session = file.slice(0, -suffix.length);
      const events = this.load(session).filter((event) => event.run_id === runId);
      if (events.length > 0) return { session, events };
    }
    return null;
  }

  append(sessionName: string, event: unknown): void {
    const target = this.pathFor(sessionName);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.appendFileSync(target, JSON.stringify(event) + "\n", "utf-8");
  }

  /**
   * A `RunManager` persist hook writing every event into this store
   * (mirrors the Python wiring `RunManager(persist=store.append)`).
   */
  asPersist(): (session: string, event: RuntimeEvent) => void {
    return (session, event) => this.append(session, event);
  }
}

// ---------------------------------------------------------------------------
// RunApprovalBroker: parks tool coroutines until the operator answers
// ---------------------------------------------------------------------------

/**
 * How many operator denials of one identical `(action, target)` approval
 * request are allowed before identical repeats are auto-denied. Two denials
 * means the third identical request resolves immediately instead of parking
 * the run again. The harness-level workspace-tool cap (`harness.ts`) uses the
 * same value; this constant is the canonical one because the broker is the
 * layer every approval consumer shares (the harness re-exports it for
 * compatibility).
 */
export const APPROVAL_DENY_LIMIT = 2;

/** Constructor options for `RunApprovalBroker`. */
export interface RunApprovalBrokerOptions {
  /**
   * Operator denials of one identical `(action, target)` pair allowed before
   * identical repeats are auto-denied. Defaults to `APPROVAL_DENY_LIMIT`;
   * non-positive or non-finite values fall back to that default.
   */
  denyLimit?: number;
}

/**
 * Normalize an approval target the way the harness' workspace-tool cap does:
 * trim, POSIX separators and no leading `./`, so `./a.txt`, `.\\a.txt` and
 * `a.txt` are one pair.
 */
export function normalizeApprovalTarget(raw: string): string {
  return raw.trim().replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
}

/**
 * The comparison target of one approval request: a shell request's command
 * (its `target` is typically unset), any other request's target. The harness
 * `approvalPair` maps workspace tool args onto the same shape.
 */
export function approvalMatchTarget(request: ApprovalRequest): string {
  const action = String(request.action ?? "");
  const raw =
    action === Action.SHELL
      ? String(request.command ?? request.target ?? "")
      : String(request.target ?? "");
  return normalizeApprovalTarget(raw);
}

/**
 * The broker cap's pairing key: `action\0normalized-target`, case-folded on
 * Windows (the same convention as the harness' built-in approval pairs).
 */
export function approvalPairKey(request: ApprovalRequest): string {
  const target = approvalMatchTarget(request);
  const normalized = process.platform === "win32" ? target.toLowerCase() : target;
  return `${String(request.action ?? "")}\u0000${normalized}`;
}

/**
 * One bounded caution appended to a parked shell approval's existing additive
 * `reason` when the operator already denied a file mutation (write/edit/delete)
 * earlier in the same run. `workspace_run_shell` is a separate approval: the
 * denied mutation does not restrict it, and a model can retry the same effect
 * through a command with no diff preview. Display-only: it never changes a
 * decision, the pair key, the denial cap or the event shape.
 */
export const SHELL_DENIED_MUTATION_CAUTION =
  "a file change was denied earlier in this run — review this command closely";

/** Actions whose operator denial arms {@link SHELL_DENIED_MUTATION_CAUTION}. */
function isMutationAction(action: string): boolean {
  return action === Action.WRITE || action === Action.EDIT || action === Action.DELETE;
}

/**
 * The reason one parked approval is presented with: the request's own reason,
 * plus the shell caution when a mutation was already denied. The base reason
 * (including "no reason at all") is returned byte-identically when nothing was
 * denied, and the caution is appended at most once even for a reused request.
 */
function approvalReasonFor(request: ApprovalRequest, mutationDenied: boolean): string | undefined {
  const base =
    request.reason !== undefined && request.reason !== "" ? request.reason : undefined;
  if (!mutationDenied || String(request.action ?? "") !== Action.SHELL) return base;
  if (base === undefined) return SHELL_DENIED_MUTATION_CAUTION;
  if (base.includes(SHELL_DENIED_MUTATION_CAUTION)) return base;
  return `${base}; ${SHELL_DENIED_MUTATION_CAUTION}`;
}

/** Events the broker emits into the run's event stream. */
type ApprovalEvent =
  | ApprovalRequestedEvent
  | ApprovalResolvedEvent
  | ApprovalAutoDeniedEvent
  | ApprovalAutoAllowedEvent;

interface PendingApproval {
  request: ApprovalRequest;
  decision: Decision | null;
  answered: boolean;
  resolve: (decision: Decision) => void;
}

function shortId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 12);
}

/**
 * Additive helper-identity fields of one approval request, omitted when the
 * request is a brother's (or the fields are empty/malformed).
 */
function childApprovalFields(request: ApprovalRequest): {
  subagent_id?: string;
  subagent_label?: string;
} {
  const fields: { subagent_id?: string; subagent_label?: string } = {};
  if (typeof request.subagent_id === "string" && request.subagent_id !== "") {
    fields.subagent_id = request.subagent_id;
  }
  if (typeof request.subagent_label === "string" && request.subagent_label !== "") {
    fields.subagent_label = request.subagent_label;
  }
  return fields;
}

/** The `subagent_id` one resolved event carries (absent for a brother's). */
function childIdField(request: ApprovalRequest): { subagent_id?: string } {
  return typeof request.subagent_id === "string" && request.subagent_id !== ""
    ? { subagent_id: request.subagent_id }
    : {};
}

/**
 * Approval broker for one run: emits `approval_requested` events, then parks
 * the awaiting tool coroutine until the operator answers via `respond()`, the
 * run is stopped (`denyAll()` / abort signal — a stopped run must never leave
 * a mutation parked mid-approval, so every pending wait resolves as DENY).
 *
 * Operator-denial repeat cap: the broker records *operator* denials per
 * identical `(action, target)` pair (a shell request's command is its target).
 * Once a pair reaches `denyLimit` denials, the next identical `approve()` call
 * resolves DENY immediately — no pending entry, no `approval_requested` — and
 * emits one additive `approval_auto_denied` event. Only `respond()` denials
 * by the operator count: `denyAll()` (stop/cancel/abort) and aborted waits are
 * cancellations, not operator answers, and never increment the counter. Allow
 * answers neither count nor reset a pair. This is the broker-level counterpart
 * of the harness' workspace-tool cap (`APPROVAL_DENY_LIMIT`); the two layers
 * cannot double-count one request because the harness auto-denies before the
 * workspace `PermissionManager` reaches this broker.
 *
 * Session allows ("always allow for this session") are an in-memory set of
 * `approvalPairKey` pairs for this run: an operator `allowForSession()` answer
 * records the pending request's pair and resolves it ALLOW, and a request whose
 * pair is set resolves ALLOW immediately — before the denial cap, without a
 * pending entry and without an `approval_requested` — emitting exactly one
 * additive `approval_auto_allowed` event per call. `seedSessionAllows()` loads
 * pairs the server persisted for the session (additive, never guessed from the
 * request); like an allow answer, a session allow neither counts nor resets a
 * pair's operator-denial count. A stopped/aborted run still denies: the
 * session-allow shortcut never bypasses the cancellation path below.
 *
 * Shell caution: a parked shell approval whose run already denied a file
 * mutation (write/edit/delete) by the operator carries one bounded caution
 * sentence appended to its existing additive `reason`
 * ({@link SHELL_DENIED_MUTATION_CAUTION}). Shell is a separate approval, so the
 * denied mutation does not restrict it; the sentence is display-only and
 * changes no decision, pair key, denial count or event field. A cancellation
 * (`denyAll()`/abort) is not an operator denial and never arms it.
 *
 * Implements the `ApprovalBroker` interface from `permissions.ts`, so it plugs
 * straight into `PermissionManager` in place of `CallbackBroker`/`StaticBroker`.
 * Python parity: `approve()` polls a threading.Event; here the same semantics
 * ride on a promise plus an `AbortSignal` listener (no polling).
 */
export class RunApprovalBroker implements ApprovalBroker {
  /**
   * Operator denials of one identical pair allowed before repeats are
   * auto-denied (validated constructor option; default
   * `APPROVAL_DENY_LIMIT`).
   */
  readonly denyLimit: number;
  private readonly _pending = new Map<string, PendingApproval>();
  /** Operator-denial counts per `action\0target` pair (see `autoDenials()`). */
  private readonly _denials = new Map<string, number>();
  /**
   * True once the operator denied a file mutation (write/edit/delete) in this
   * run: a following parked shell approval carries the bounded caution. Never
   * consulted by a decision or the pair key; a cancellation never arms it.
   */
  private _mutationDenied = false;
  /**
   * `approvalPairKey` pairs the operator allowed for this session; a matching
   * request resolves ALLOW without parking (see `seedSessionAllows`).
   */
  private readonly _sessionAllows = new Set<string>();
  private _emit: ((event: ApprovalEvent) => void) | null = null;
  private _signal: AbortSignal | null = null;

  /**
   * `denyLimit`: non-positive/non-finite values fall back to the default
   * `APPROVAL_DENY_LIMIT`; a positive number is floored.
   */
  constructor(options: RunApprovalBrokerOptions = {}) {
    const requested = options.denyLimit;
    this.denyLimit =
      typeof requested === "number" && Number.isFinite(requested) && requested >= 1
        ? Math.floor(requested)
        : APPROVAL_DENY_LIMIT;
  }

  /**
   * Read-only snapshot of the operator-denial counts per
   * `action\0normalized-target` pair (the `approvalPairKey` form). Exposed for
   * tests and runtime telemetry; callers cannot mutate the broker through it.
   */
  autoDenials(): Record<string, number> {
    return Object.fromEntries(this._denials);
  }

  /**
   * Read-only snapshot of the session-allowed `approvalPairKey` pairs, sorted
   * for deterministic tests/telemetry. Callers cannot mutate the set.
   */
  sessionAllows(): string[] {
    return [...this._sessionAllows].sort();
  }

  /**
   * Add `approvalPairKey`-shaped pairs the operator already allowed for this
   * session (the server loads them from `sessions/settings.json` when a run
   * starts). Additive and idempotent: existing pairs are kept, non-string and
   * empty entries are ignored, and nothing here is inferred from a request.
   */
  seedSessionAllows(pairKeys: Iterable<unknown> | null | undefined): void {
    if (pairKeys === null || pairKeys === undefined) return;
    for (const key of pairKeys) {
      if (typeof key === "string" && key.length > 0) this._sessionAllows.add(key);
    }
  }

  /** Bind the per-run emit hook and abort signal (created by the worker). */
  attach(
    emit: ((event: ApprovalEvent) => void) | null = null,
    signal: AbortSignal | null = null,
  ): void {
    this._emit = emit;
    this._signal = signal;
  }

  // -- broker protocol -------------------------------------------------------

  /**
   * Park until the operator answers, the run stops (deny), or denyAll().
   *
   * Operator-denial cap: when this exact `(action, target)` pair has already
   * been denied by the operator `denyLimit` times, resolve DENY immediately
   * (no pending entry, no `approval_requested`) and emit one
   * `approval_auto_denied` event. A cancelled run keeps the cancellation path
   * below — cancellation is not an operator denial and must never trip the
   * cap.
   *
   * Session allow: when the pair was allowed for this session
   * (`allowForSession()`/`seedSessionAllows()`), resolve ALLOW immediately with
   * exactly one additive `approval_auto_allowed` event — checked before the
   * denial cap. An aborted run skips the shortcut and takes the cancellation
   * path, so a stop can never be turned into a mutation.
   */
  async approve(request: ApprovalRequest): Promise<Decision> {
    const key = approvalPairKey(request);
    if (this._sessionAllows.has(key) && this._signal?.aborted !== true) {
      this._event({
        type: "approval_auto_allowed",
        action: String(request.action ?? ""),
        target: approvalMatchTarget(request),
      });
      return Decision.ALLOW;
    }
    const denials = this._denials.get(key) ?? 0;
    if (denials >= this.denyLimit && this._signal?.aborted !== true) {
      // An auto-denied mutation is still an operator-driven denial (the cap is
      // built from operator answers): arm the shell caution if it is a file
      // mutation. The prior `respond()` denials have usually armed it already.
      if (isMutationAction(String(request.action ?? ""))) this._mutationDenied = true;
      this._event({
        type: "approval_auto_denied",
        action: String(request.action ?? ""),
        target: approvalMatchTarget(request),
        count: denials,
        limit: this.denyLimit,
      });
      return Decision.DENY;
    }
    const approvalId = shortId();
    // Display-only shell caution: a separate shell approval parked after an
    // operator-denied file mutation names that earlier denial. The caller's
    // request object is never mutated (idempotent re-parks cannot duplicate it).
    const cautious =
      this._mutationDenied && String(request.action ?? "") === Action.SHELL;
    const effectiveRequest: ApprovalRequest = cautious
      ? { ...request, reason: approvalReasonFor(request, true) }
      : request;
    const entry: PendingApproval = {
      request: effectiveRequest,
      decision: null,
      answered: false,
      resolve: () => undefined,
    };
    const settled = new Promise<Decision>((resolve) => {
      entry.resolve = resolve;
    });
    this._pending.set(approvalId, entry);
    this._event({
      type: "approval_requested",
      approval_id: approvalId,
      action: effectiveRequest.action,
      target: effectiveRequest.target,
      command: effectiveRequest.command,
      ...(effectiveRequest.reason !== undefined && effectiveRequest.reason !== ""
        ? { reason: effectiveRequest.reason }
        : {}),
      ...(effectiveRequest.detail !== undefined ? { detail: effectiveRequest.detail } : {}),
      ...childApprovalFields(effectiveRequest),
    });

    let onAbort: (() => void) | null = null;
    const signal = this._signal;
    if (signal !== null) {
      if (signal.aborted) {
        // stop landed before the wait even started
        this._pending.delete(approvalId);
        this._event({
          type: "approval_resolved",
          approval_id: approvalId,
          decision: Decision.DENY,
          reason: "cancelled",
          ...childIdField(effectiveRequest),
        });
        return Decision.DENY;
      }
      onAbort = () => {
        if (this._pending.delete(approvalId)) {
          this._event({
            type: "approval_resolved",
            approval_id: approvalId,
            decision: Decision.DENY,
            reason: "cancelled",
            ...childIdField(effectiveRequest),
          });
        }
        entry.resolve(Decision.DENY);
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }

    // A helper's own control can withdraw its parked wait: the child signal
    // aborts on interrupt, resolving DENY `reason:"interrupted"` exactly like
    // the run-signal path (the `_pending.delete` guard keeps it to one event).
    // A run stop aborts both signals; the run-signal listener owns that case,
    // so this one stays silent while `this._signal` is aborted — the run
    // reason ("cancelled"/denyAll) must keep winning.
    let onChildAbort: (() => void) | null = null;
    const childSignal = effectiveRequest.signal;
    if (childSignal !== undefined) {
      if (childSignal.aborted) {
        if (onAbort !== null && signal !== null) {
          signal.removeEventListener("abort", onAbort);
        }
        if (this._pending.delete(approvalId)) {
          this._event({
            type: "approval_resolved",
            approval_id: approvalId,
            decision: Decision.DENY,
            reason: "interrupted",
            ...childIdField(effectiveRequest),
          });
        }
        return Decision.DENY;
      }
      onChildAbort = () => {
        if (this._signal?.aborted === true) return; // the run-signal path owns it
        if (this._pending.delete(approvalId)) {
          this._event({
            type: "approval_resolved",
            approval_id: approvalId,
            decision: Decision.DENY,
            reason: "interrupted",
            ...childIdField(effectiveRequest),
          });
        }
        entry.resolve(Decision.DENY);
      };
      childSignal.addEventListener("abort", onChildAbort, { once: true });
    }

    await settled;

    if (onAbort !== null && this._signal !== null) {
      this._signal.removeEventListener("abort", onAbort);
    }
    if (onChildAbort !== null && childSignal !== undefined) {
      childSignal.removeEventListener("abort", onChildAbort);
    }
    if (!this._pending.delete(approvalId)) {
      // denyAll() already resolved and emitted for this request
      return Decision.DENY;
    }
    const decision = entry.decision ?? Decision.DENY;
    this._event({
      type: "approval_resolved",
      approval_id: approvalId,
      decision,
      ...childIdField(entry.request),
    });
    return decision;
  }

  // -- operator API ----------------------------------------------------------

  /** Operator-facing view of unanswered approval requests. */
  pending(): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    for (const [approvalId, entry] of this._pending) {
      out.push({
        approval_id: approvalId,
        action: entry.request.action,
        target: entry.request.target ?? null,
        command: entry.request.command ?? null,
        reason: entry.request.reason ?? null,
        ...(entry.request.detail !== undefined ? { detail: entry.request.detail } : {}),
        ...childApprovalFields(entry.request),
      });
    }
    return out;
  }

  /**
   * Answer one pending request; `null` if unknown or already answered.
   *
   * Only an operator *deny* counts toward the repeat cap (per identical
   * `(action, target)` pair). Allows neither count nor reset a pair; an
   * already-answered/unknown id is a no-op and never changes any count. An
   * operator deny of a file mutation additionally arms the display-only shell
   * caution for later parked shell approvals in this run.
   */
  respond(requestId: string, decision: Decision): Decision | null {
    const entry = this._pending.get(requestId);
    if (entry === undefined || entry.answered) return null;
    if (decision === Decision.DENY) {
      const key = approvalPairKey(entry.request);
      this._denials.set(key, (this._denials.get(key) ?? 0) + 1);
      // An operator denial of a file mutation arms the display-only shell
      // caution; a shell denial never does (it cannot be replayed as a file
      // mutation the operator already refused).
      if (isMutationAction(String(entry.request.action ?? ""))) this._mutationDenied = true;
    }
    entry.decision = decision;
    entry.answered = true;
    entry.resolve(decision);
    return decision;
  }

  /**
   * The `approvalPairKey` of one pending, unanswered request — what the server
   * persists before resolving a session-scope answer. `null` for an unknown or
   * already-answered id (nothing to persist, nothing to resolve).
   */
  sessionPairKey(requestId: string): string | null {
    const entry = this._pending.get(requestId);
    if (entry === undefined || entry.answered) return null;
    return approvalPairKey(entry.request);
  }

  /**
   * Answer one pending request as "allow for this session": record its
   * `(action, target)` pair for the rest of the run, resolve the wait ALLOW and
   * return ALLOW. `null` for an unknown or already-answered id — that is a
   * no-op for the session-allow set and for every denial counter.
   *
   * The pair is in-memory only; the caller persists it (the server writes
   * `sessions/settings.json` *before* calling this, so a failed write never
   * leaves an auto-allow behind).
   */
  allowForSession(requestId: string): Decision | null {
    const entry = this._pending.get(requestId);
    if (entry === undefined || entry.answered) return null;
    this._sessionAllows.add(approvalPairKey(entry.request));
    entry.decision = Decision.ALLOW;
    entry.answered = true;
    entry.resolve(Decision.ALLOW);
    return Decision.ALLOW;
  }

  /**
   * Resolve every pending wait as *deny* (run stopped / worker torn down).
   * Entries are removed here; a parked `approve()` then wakes to an
   * already-resolved entry and returns DENY without emitting again — the
   * resolution event is emitted exactly once, here.
   *
   * These are cancellation denials, not operator answers: they never
   * increment the repeat-cap counters (a stop must not consume the operator's
   * deny budget for a pair) and never arm the shell caution.
   */
  denyAll(reason = "cancelled"): number {
    const entries = [...this._pending.entries()];
    for (const [approvalId] of entries) this._pending.delete(approvalId);
    for (const [approvalId, entry] of entries) {
      entry.decision = Decision.DENY;
      entry.answered = true;
      entry.resolve(Decision.DENY);
      this._event({
        type: "approval_resolved",
        approval_id: approvalId,
        decision: Decision.DENY,
        reason,
        ...childIdField(entry.request),
      });
    }
    return entries.length;
  }

  private _event(event: ApprovalEvent): void {
    this._emit?.(event);
  }
}
