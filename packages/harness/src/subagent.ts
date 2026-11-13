/**
 * Helper subagents ("a third tier", not a second Junior).
 *
 * A subagent is a single-role worker with its own isolated conversation and
 * its own provider instance. It never sees the parent transcript, never emits
 * protocol envelopes, and never joins the brothers' shared context. The
 * model-facing `subagent` tool exists only on the Senior's belt in `serve`/web
 * runs. A workspace-bound child gets the seven workspace built-ins (three
 * reads plus write/edit/delete/shell); every mutation is an ordinary
 * operator approval on the parent run, tagged with the child's identity, so
 * the run's permission mode decides exactly what a helper may do.
 *
 * The child transcript is persisted under `<sessionsDir>/subagents/<id>.jsonl`
 * (one JSON object per line: `meta`, `message`/`tool`/`approval`, then `end`).
 * That directory is reserved and never appears in the session sidebar. The
 * parent's runtime sidecar carries live `subagent_started` /
 * `subagent_activity` / `subagent_completed` events, so a reload can rebuild
 * the tree without reading the child log.
 *
 * The runner is deliberately synchronous from the parent's point of view: the
 * parent's tool call waits for the child to settle and returns its bounded
 * report. An approval wait is inside that call and does not consume a child
 * step. Live progress still streams through the parent's event sink. An
 * asynchronous completion/wake loop is a later phase.
 */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import type { ChatMessage } from "./context.ts";
import type { Provider, Tool, UsageTotals } from "./provider.ts";
import {
  emptyUsage,
  ProviderAbortError,
  USAGE_KEYS,
} from "./provider.ts";
import { boundOutput, sanitizeOutput } from "./output.ts";
import { clipArgs, clipBlock, clipText } from "./runevents.ts";

/** Model-facing tool name on the Senior's read-only consult/verify belt. */
export const SUBAGENT_TOOL_NAME = "subagent";

/** One delegated task is bounded; the model gets a clear error over the cap. */
export const SUBAGENT_MAX_TASK_CHARS = 4_000;
/** Short display label retained in the parent tree and the child header. */
export const SUBAGENT_MAX_LABEL_CHARS = 80;
/** Per-run child budget (the parent can delegate repeatedly, but not forever). */
export const SUBAGENT_DEFAULT_MAX_PER_RUN = 8;
/** Read-only actions are checks; this guards a future parallel activation path. */
export const SUBAGENT_DEFAULT_MAX_ACTIVE = 4;
/** Bounded child tool loop: a report, not an unbounded investigation. */
export const SUBAGENT_MAX_ITERATIONS = 6;
/** The report the parent model receives is bounded (the child log keeps more). */
export const SUBAGENT_RESULT_MAX_CHARS = 12_000;
/** Per-line bound for stored tool results and activity events. */
export const SUBAGENT_TOOL_RESULT_MAX_CHARS = 4_000;
/** One queued follow-up is bounded (the steering vocabulary). */
export const SUBAGENT_FOLLOWUP_TEXT_MAX_CHARS = 4_000;
/** Pending follow-ups per child (the steering queue bound). */
export const SUBAGENT_FOLLOWUP_QUEUE_MAX = 8;
/**
 * Follow-ups applied to one child, however many arrive. Reaching the cap turns
 * the rest into counted drops: the queue never grows the child unboundedly.
 */
export const SUBAGENT_MAX_FOLLOWUPS_PER_CHILD = 8;
/**
 * Char heuristic for a child's isolated conversation (sum of message contents).
 * A child has no compaction (no summarizer role, shared context or session
 * store), so a follow-up that would push past this budget is refused/counted
 * instead of delivered. 80 000 fits a normal child (task + bounded tool results
 * + one answer) plus eight 4 000-char follow-ups.
 */
export const SUBAGENT_CONTEXT_MAX_CHARS = 80_000;

/**
 * Model-facing helper-control budget, shared by `list_agents`, `send_message`,
 * `interrupt_agent` and `subagent_report` for one run. Polling is the delivery
 * mechanism, so it needs room: 40 is 5× the per-run child cap and still bounded.
 * The 41st call returns one honest error and serves nothing further.
 */
export const SUBAGENT_CONTROL_CALL_MAX_PER_RUN = 40;
/**
 * Bounded settle grace at parent run end: after aborting every still-running
 * background child the harness waits at most this long for them to unwind (so
 * their terminal event can land before `run_end`). A child still unwinding keeps
 * settling in-process; its `end` row is still written.
 */
export const SUBAGENT_SHUTDOWN_GRACE_MS = 2_000;

/** Senior-only, model-facing helper-control tool names (never on a child). */
export const LIST_AGENTS_TOOL_NAME = "list_agents";
export const SEND_MESSAGE_TOOL_NAME = "send_message";
export const INTERRUPT_AGENT_TOOL_NAME = "interrupt_agent";
export const SUBAGENT_REPORT_TOOL_NAME = "subagent_report";

/** The three workspace reads a helper may always use. */
export const SUBAGENT_READ_TOOL_NAMES: ReadonlySet<string> = new Set([
  "workspace_read_file",
  "workspace_list_dir",
  "workspace_search_text",
]);

/**
 * A workspace-bound child's full built-in belt: the three reads plus the four
 * mutations. `spill_read` joins on top when the parent harness offers it.
 * Nothing else is offered — no recursion, no plan tool, no plugin/MCP/skills
 * tools.
 */
export const SUBAGENT_CHILD_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...SUBAGENT_READ_TOOL_NAMES,
  "workspace_write_file",
  "workspace_edit_file",
  "workspace_delete_file",
  "workspace_run_shell",
]);

/** Bound on one stored approval row's action string. */
export const SUBAGENT_APPROVAL_ACTION_MAX_CHARS = 40;
/** Bound on one stored approval row's target. */
export const SUBAGENT_APPROVAL_TARGET_MAX_CHARS = 500;
/** Bound on one stored approval row's command. */
export const SUBAGENT_APPROVAL_COMMAND_MAX_CHARS = 1_000;
/** Bound on one stored approval row's reason. */
export const SUBAGENT_APPROVAL_REASON_MAX_CHARS = 500;

/**
 * The child's base prompt. It is assembled with the same tool sections as a
 * brother prompt, but it is deliberately not a brother persona: the child is a
 * helper with a fixed scope and no memory of the parent conversation. Its
 * workspace mutations are ordinary approvals on the parent run, so the prompt
 * must describe them honestly instead of claiming the child is read-only.
 */
export const SUBAGENT_SYSTEM_PROMPT = [
  "You are a helper subagent spawned by the Senior in a Two Brothers run.",
  "Your context is isolated: you do not see the parent conversation or its other agents.",
  "Work only on the task you were given. Use the tools you are given when facts are needed; if no tools are available, answer from the task and say what is missing.",
  "Workspace changes (write, edit, delete, shell) are allowed only when the operator's run policy approves them. A `status:\"denied\"` result means the change did not run; an approval wait is the operator deciding, not an error.",
  "Never claim a file, command, or result you did not observe. If the task cannot be answered with the available tools, state exactly what is missing.",
  "Do not spawn subagents. Do not ask the operator questions; the Senior reads your report.",
  "Answer with a concise factual report: findings, evidence (paths and line numbers), and any uncertainty. No preamble.",
].join("\n");

export type SubagentRole = "senior" | "junior";
export type SubagentStatus = "running" | "completed" | "failed" | "cancelled";
export type SubagentActivityKind = "message" | "tool" | "status";
/**
 * Who caused a `cancelled` child: the operator's interrupt, the Senior's
 * (model-facing, a later slice), the parent run's stop/reap, or the startup
 * reconciliation of a log the crashed backend left without an `end` row.
 * Additive and present only on a cancelled child.
 */
export type SubagentCancelledBy = "operator" | "senior" | "parent_run" | "restart";

/**
 * Who sent a follow-up: the operator (web drawer, any live child) or the
 * Senior (the model-facing tools, a later slice). Never the child itself.
 */
export type SubagentFollowUpFrom = "operator" | "senior";

/**
 * One queued follow-up, delivered as an ordinary user turn in the child's own
 * conversation at its next provider step (never into the brothers' transcript).
 */
export interface SubagentFollowUp {
  text: string;
  from: SubagentFollowUpFrom;
  at: number;
}

/** The bounded queue result for a send attempt. */
export type SubagentFollowUpSendResult =
  | { ok: true; pending: number }
  | {
      ok: false;
      reason: "invalid_text" | "queue_full" | "not_running" | "context_full";
      /** Present for `context_full`: the child's estimated conversation size. */
      chars?: number;
    };

/** One display-only activity row in the parent tree and child header. */
export interface SubagentActivity {
  kind: SubagentActivityKind;
  /** Message text, or a bounded tool/status preview. */
  text?: string;
  tool?: string;
  status?: string;
  at: number;
}

/** One bounded message/tool transcript row in the child log. */
export interface SubagentMessageEntry {
  type: "message" | "tool";
  /** Message role; tool rows omit it. */
  role?: "user" | "assistant";
  /**
   * Additive: on a delivered follow-up's user row, who sent it. Absent on the
   * initial task row, so phase-1/2 logs stay byte-identical.
   */
  origin?: SubagentFollowUpFrom;
  text?: string;
  tool?: string;
  status?: "started" | "completed" | "error";
  args?: Record<string, unknown>;
  result?: string;
  at: number;
}

/** Lifecycle of one child approval request, as persisted in the child log. */
export type SubagentApprovalStatus = "pending" | "allowed" | "denied" | "cancelled";

/**
 * One approval-lifecycle row: written as `pending` before the parent broker is
 * consulted and once more with the outcome. Display-only, bounded, and ignored
 * by an older reader (`type:"approval"` normalizes to nothing there).
 */
export interface SubagentApprovalEntry {
  type: "approval";
  status: SubagentApprovalStatus;
  /** `write` / `edit` / `delete` / `shell`. */
  action: string;
  /** Workspace-relative path (bounded). */
  target?: string;
  /** Shell command (bounded); absent for file mutations. */
  command?: string;
  /** Existing approval reason (bounded). */
  reason?: string;
  at: number;
}

/** One bounded row in the child log: a message/tool step or an approval. */
export type SubagentTranscriptEntry = SubagentMessageEntry | SubagentApprovalEntry;

/** Header fields shared by the list and detail views. */
export interface SubagentInfo {
  id: string;
  parent_session: string;
  label: string;
  role: SubagentRole;
  /** Role model id resolved at spawn time (display only). */
  model: string;
  task: string;
  status: SubagentStatus;
  started_at: number;
  ended_at?: number;
  duration_ms?: number;
  last_activity?: SubagentActivity | null;
  usage?: UsageTotals | null;
  result?: string | null;
  error?: string | null;
  /**
   * Additive: true when this child was spawned with `background:true` (the
   * parent did not wait for it). Absent for every synchronous child, so
   * existing rows and event bytes are unchanged.
   */
  background?: boolean;
}

/** One child with its full bounded transcript (`GET /api/subagents/{id}`). */
export interface SubagentDetail extends SubagentInfo {
  transcript: SubagentTranscriptEntry[];
}

/** A child row without its transcript (`GET /api/sessions/{name}/subagents`). */
export type SubagentSummary = Omit<SubagentDetail, "transcript">;

/** A resolved dedicated helper route (same fields as a role endpoint). */
export interface SubagentEndpoint {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  kind?: string;
  contextWindow?: number;
  effort?: string;
}

/**
 * The public handle the server keeps so the web can reach one live child.
 *
 * It exposes the child-scoped interrupt and the bounded follow-up queue; every
 * member describes the child honestly (no transient "interrupting" status — the
 * terminal event and the `end` row are the truth).
 */
export interface SubagentControlHandle {
  readonly id: string;
  /** The parent run that spawned this child, when a run is attached. */
  readonly runId: string | null;
  readonly label: string;
  /** False for every synchronous child; the background slice flips it. */
  readonly background: boolean;
  readonly startedAt: number;
  /**
   * Abort this child only — never its parent run. Idempotent: false when the
   * child already settled or was already interrupted.
   */
  interrupt(by: "operator" | "senior"): boolean;
  /**
   * Queue one bounded follow-up for the child's next step. Never reports
   * `delivered`: an accepted text is queued, and the child's next provider step
   * (step >= 1, never inside a parked approval wait) is the delivery point.
   */
  send(text: unknown, from: SubagentFollowUpFrom): SubagentFollowUpSendResult;
  /** Follow-ups still queued (never negative; 0 once the child settled). */
  pendingFollowUps(): number;
  status(): SubagentStatus;
}

/** The server's registry seam; the harness registers on spawn, releases on settle. */
export interface SubagentControlSink {
  register(handle: SubagentControlHandle): void;
  release(id: string): void;
}

/** Settings the parent harness needs to offer the tool. */
export interface SubagentSettings {
  store: SubagentStore;
  /** Parent session public name (the `.jsonl` file name). */
  parentSession: string;
  maxPerRun?: number;
  maxActive?: number;
  /** Configured in Settings; when present it wins over the tool's role. */
  endpoint?: SubagentEndpoint;
  /** Tests/integrations can inject a fresh provider per child. */
  providerFactory?: (role: SubagentRole) => Provider;
  /**
   * Additive: the server's live-child registry (absent on the CLI, where no
   * operator can reach a child). Registration happens at spawn, release at
   * settle, so an unknown id can never poke a dead control.
   */
  controls?: SubagentControlSink;
  /** Additive: the parent run id the handle reports (`null` when unknown). */
  runId?: string | null;
}

/** A child id is a filesystem-safe token, never a path. */
export const SUBAGENT_ID_PATTERN = /^sub-[a-f0-9]{8,32}$/;

export function newSubagentId(): string {
  return `sub-${randomBytes(8).toString("hex")}`;
}

export function isSubagentId(value: unknown): value is string {
  return typeof value === "string" && SUBAGENT_ID_PATTERN.test(value);
}

/** The first line of the task, clipped for a tree row. */
export function deriveSubagentLabel(task: string): string {
  const oneLine = task.replace(/\s+/g, " ").trim();
  if (oneLine === "") return "Subagent task";
  if (oneLine.length <= 60) return oneLine;
  return oneLine.slice(0, 59) + "…";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function intOf(value: unknown, fallback = 0): number {
  const num = Number(value);
  return Number.isFinite(num) ? Math.trunc(num) : fallback;
}

function textOf(value: unknown, limit: number): string {
  return typeof value === "string" ? clipBlock(sanitizeOutput(value), limit) : "";
}

function roleOf(value: unknown): SubagentRole {
  return value === "senior" ? "senior" : "junior";
}

function statusOf(value: unknown): SubagentStatus {
  return value === "completed" || value === "failed" || value === "cancelled"
    ? value
    : "running";
}

function usageOf(value: unknown): UsageTotals | null {
  if (!isRecord(value)) return null;
  const usage = emptyUsage();
  for (const key of USAGE_KEYS) usage[key] = Math.max(0, intOf(value[key]));
  if (value.prompt_tokens !== undefined) {
    usage.prompt_tokens = Math.max(0, intOf(value.prompt_tokens));
  }
  return usage;
}

function activityOf(entry: SubagentTranscriptEntry): SubagentActivity {
  if (entry.type === "approval") {
    // A pending row is the durable "parked on the operator" signal; an
    // outcome row means the child continued (an end row still wins).
    return {
      kind: "status",
      status: entry.status === "pending" ? "awaiting_approval" : "running",
      at: entry.at,
    };
  }
  if (entry.type === "tool") {
    return {
      kind: "tool",
      tool: entry.tool,
      status: entry.status,
      ...(entry.result !== undefined
        ? { text: clipText(entry.result, 200) }
        : entry.args !== undefined
          ? { text: clipText(JSON.stringify(entry.args), 120) }
          : {}),
      at: entry.at,
    };
  }
  if (entry.role === "assistant") {
    return { kind: "message", text: clipText(entry.text ?? "", 200), at: entry.at };
  }
  return { kind: "message", text: clipText(entry.text ?? "", 120), at: entry.at };
}

/**
 * Append-only child-transcript store. Reads are tolerant: a torn final line
 * (crash mid-write) is skipped, interior malformed lines are ignored, and an
 * unknown id is a 404 rather than a path traversal.
 */
export class SubagentStore {
  readonly directory: string;

  constructor(directory: string) {
    this.directory = path.resolve(directory);
  }

  private fileFor(id: string): string {
    if (!isSubagentId(id)) throw new Error(`invalid subagent id: ${String(id)}`);
    return path.join(this.directory, `${id}.jsonl`);
  }

  private appendLine(id: string, line: Record<string, unknown>): void {
    fs.mkdirSync(this.directory, { recursive: true });
    fs.appendFileSync(this.fileFor(id), JSON.stringify(line) + "\n", "utf-8");
  }

  /** Write the durable header. Called once, before the first model call. */
  begin(record: {
    id: string;
    parent_session: string;
    label: string;
    role: SubagentRole;
    model: string;
    task: string;
    started_at: number;
    /** Additive: set only for a background child (omitted otherwise). */
    background?: boolean;
  }): void {
    this.appendLine(record.id, {
      type: "meta",
      id: record.id,
      parent_session: path.basename(record.parent_session),
      label: textOf(record.label, SUBAGENT_MAX_LABEL_CHARS),
      role: roleOf(record.role),
      model: textOf(record.model, 200),
      task: textOf(record.task, SUBAGENT_MAX_TASK_CHARS),
      started_at: intOf(record.started_at),
      ...(record.background === true ? { background: true } : {}),
    });
  }

  /** Append one message/tool transcript row. */
  append(id: string, entry: SubagentTranscriptEntry): void {
    this.appendLine(id, { ...entry });
  }

  /** Write the terminal row. Missing/never-called means the child is running. */
  finish(
    id: string,
    result: {
      status: Exclude<SubagentStatus, "running">;
      ended_at: number;
      result?: string;
      error?: string;
      usage?: UsageTotals;
      /** Additive: set only for a cancelled child (omitted otherwise). */
      cancelled_by?: SubagentCancelledBy;
      /**
       * Additive: written only when at least one follow-up was queued for this
       * child. A follow-up-free child's `end` row keeps its exact old shape.
       */
      followups?: { delivered: number; dropped: number };
    },
  ): void {
    const followups =
      result.followups !== undefined
        ? {
            delivered: Math.max(0, intOf(result.followups.delivered)),
            dropped: Math.max(0, intOf(result.followups.dropped)),
          }
        : undefined;
    this.appendLine(id, {
      type: "end",
      status: result.status,
      ended_at: intOf(result.ended_at),
      ...(result.result !== undefined
        ? { result: textOf(result.result, SUBAGENT_RESULT_MAX_CHARS) }
        : {}),
      ...(result.error !== undefined ? { error: textOf(result.error, 2_000) } : {}),
      ...(result.cancelled_by !== undefined ? { cancelled_by: result.cancelled_by } : {}),
      ...(followups !== undefined &&
      followups.delivered + followups.dropped > 0
        ? { followups }
        : {}),
      ...(result.usage !== undefined ? { usage: result.usage } : {}),
    });
  }

  /**
   * Startup reconciliation for logs a crashed backend left without an `end`
   * row: append exactly one `cancelled` / `cancelled_by:"restart"` row to
   * every child log that has a header and no terminal row. `serve` calls this
   * once, after the single-writer lock, so a graceful shutdown (which writes
   * every `end` row) makes the sweep a no-op.
   *
   * Bounded by the same 200-file scan as `list`, idempotent (a second run
   * finds an `end` row and appends nothing), and fail-soft per file: an
   * unreadable or unwritable log is skipped and never fails startup.
   */
  reconcileOrphans(
    at = Date.now(),
    reason = "backend restarted before the helper finished",
  ): number {
    let files: string[];
    try {
      files = fs.readdirSync(this.directory).filter((name) => name.endsWith(".jsonl"));
    } catch {
      return 0; // no child directory yet: nothing to reconcile
    }
    let reconciled = 0;
    for (const file of files.slice(0, 200)) {
      const id = file.slice(0, -".jsonl".length);
      if (!isSubagentId(id)) continue;
      let raw: string;
      try {
        raw = fs.readFileSync(this.fileFor(id), "utf-8");
      } catch {
        continue; // unreadable (or a directory with that name): skip it
      }
      let hasMeta = false;
      let hasEnd = false;
      for (const line of raw.split(/\r?\n/)) {
        if (line.trim() === "") continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue; // torn final line or hand-edited junk
        }
        if (!isRecord(parsed)) continue;
        if (parsed.type === "meta") hasMeta = true;
        else if (parsed.type === "end") {
          hasEnd = true;
          break;
        }
      }
      if (!hasMeta || hasEnd) continue;
      try {
        // A crash can tear the final line mid-write. Terminate it before the
        // new row, otherwise the two would concatenate and neither would parse;
        // the torn fragment itself stays as the tolerant reader already skips it.
        if (raw !== "" && !raw.endsWith("\n")) {
          fs.appendFileSync(this.fileFor(id), "\n", "utf-8");
        }
        this.appendLine(id, {
          type: "end",
          status: "cancelled",
          ended_at: intOf(at),
          error: textOf(reason, 2_000),
          cancelled_by: "restart",
        });
        reconciled += 1;
      } catch {
        // read-only/unwritable log: skip it and keep the sweep going
      }
    }
    return reconciled;
  }

  /** Read one child; null for a missing/invalid id or a headerless file. */
  get(id: string): SubagentDetail | null {
    if (!isSubagentId(id)) return null;
    const file = this.fileFor(id);
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf-8");
    } catch {
      return null;
    }
    let meta: Record<string, unknown> | null = null;
    let end: Record<string, unknown> | null = null;
    const transcript: SubagentTranscriptEntry[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (line.trim() === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue; // torn final line or hand-edited junk
      }
      if (!isRecord(parsed)) continue;
      if (parsed.type === "meta" && meta === null) {
        meta = parsed;
      } else if (parsed.type === "end") {
        end = parsed;
      } else if (
        parsed.type === "message" ||
        parsed.type === "tool" ||
        parsed.type === "approval"
      ) {
        const entry = this.normalizeEntry(parsed);
        if (entry !== null) transcript.push(entry);
      }
    }
    if (meta === null) return null;
    const startedAt = intOf(meta.started_at);
    const endedAt = end === null ? undefined : intOf(end.ended_at);
    const status = end === null ? "running" : statusOf(end.status);
    const last =
      end !== null
        ? { kind: "status" as const, status, at: endedAt ?? startedAt }
        : transcript.length > 0
          ? activityOf(transcript[transcript.length - 1]!)
          : null;
    return {
      id,
      parent_session: path.basename(String(meta.parent_session ?? "")),
      label: textOf(meta.label, SUBAGENT_MAX_LABEL_CHARS) || "Subagent",
      role: roleOf(meta.role),
      model: textOf(meta.model, 200),
      task: textOf(meta.task, SUBAGENT_MAX_TASK_CHARS),
      status,
      started_at: startedAt,
      ...(endedAt !== undefined ? { ended_at: endedAt } : {}),
      ...(endedAt !== undefined
        ? { duration_ms: Math.max(0, endedAt - startedAt) }
        : {}),
      last_activity: last,
      usage: end === null ? null : usageOf(end.usage),
      result: end === null ? null : textOf(end.result, SUBAGENT_RESULT_MAX_CHARS),
      error: end === null ? null : textOf(end.error, 2_000),
      // Additive and tolerant: a pre-slice-B log has no such key, so it reads
      // exactly as before (and never gains a false `background:false`).
      ...(meta.background === true ? { background: true } : {}),
      transcript,
    };
  }

  private normalizeEntry(raw: Record<string, unknown>): SubagentTranscriptEntry | null {
    if (raw.type === "approval") {
      const action = textOf(raw.action, SUBAGENT_APPROVAL_ACTION_MAX_CHARS);
      if (action === "") return null;
      const status =
        raw.status === "pending" ||
        raw.status === "allowed" ||
        raw.status === "denied" ||
        raw.status === "cancelled"
          ? raw.status
          : null;
      if (status === null) return null;
      const target = textOf(raw.target, SUBAGENT_APPROVAL_TARGET_MAX_CHARS);
      const command = textOf(raw.command, SUBAGENT_APPROVAL_COMMAND_MAX_CHARS);
      const reason = textOf(raw.reason, SUBAGENT_APPROVAL_REASON_MAX_CHARS);
      return {
        type: "approval",
        status,
        action,
        at: intOf(raw.at),
        ...(target !== "" ? { target } : {}),
        ...(command !== "" ? { command } : {}),
        ...(reason !== "" ? { reason } : {}),
      };
    }
    if (raw.type === "message") {
      const role = raw.role === "user" ? "user" : "assistant";
      const text = textOf(raw.text, SUBAGENT_RESULT_MAX_CHARS);
      if (text === "") return null;
      // Additive and tolerant: an unknown/absent origin is simply absent, so
      // old logs read exactly as before.
      const origin =
        raw.origin === "operator" || raw.origin === "senior" ? raw.origin : undefined;
      return {
        type: "message",
        role,
        ...(origin !== undefined ? { origin } : {}),
        text,
        at: intOf(raw.at),
      };
    }
    if (raw.type === "tool") {
      const tool = textOf(raw.tool, 200);
      if (tool === "") return null;
      const status =
        raw.status === "completed" || raw.status === "error" ? raw.status : "started";
      return {
        type: "tool",
        tool,
        status,
        at: intOf(raw.at),
        ...(isRecord(raw.args) ? { args: clipArgs(raw.args) } : {}),
        ...(typeof raw.result === "string"
          ? { result: textOf(raw.result, SUBAGENT_TOOL_RESULT_MAX_CHARS) }
          : {}),
      };
    }
    return null;
  }

  /**
   * Child rows for one parent session, newest first. A directory scan is
   * bounded; a corrupt/missing file is skipped rather than failing the tree.
   */
  list(parentSession: string): SubagentSummary[] {
    let files: string[];
    try {
      files = fs.readdirSync(this.directory).filter((name) => name.endsWith(".jsonl"));
    } catch {
      return [];
    }
    const parent = path.basename(parentSession);
    const rows: SubagentSummary[] = [];
    for (const file of files.slice(0, 200)) {
      const id = file.slice(0, -".jsonl".length);
      if (!isSubagentId(id)) continue;
      const detail = this.get(id);
      if (detail === null || detail.parent_session !== parent) continue;
      const { transcript: _transcript, ...summary } = detail;
      rows.push(summary);
    }
    rows.sort((a, b) => b.started_at - a.started_at);
    return rows;
  }

  /** Remove every child log belonging to a deleted parent session. */
  deleteForSession(parentSession: string): number {
    let removed = 0;
    for (const row of this.list(parentSession)) {
      try {
        fs.unlinkSync(this.fileFor(row.id));
        removed += 1;
      } catch {
        // a missing/racing file is already gone; keep the sweep fail-soft
      }
    }
    return removed;
  }

  /** Remove one child log (tests/operator cleanup). */
  delete(id: string): boolean {
    if (!isSubagentId(id)) return false;
    try {
      fs.unlinkSync(this.fileFor(id));
      return true;
    } catch {
      return false;
    }
  }
}

/** A typed progress event the parent harness maps onto `subagent_activity`. */
export type SubagentRunnerEvent =
  | { kind: "message"; text: string; at: number }
  | {
      kind: "tool";
      tool: string;
      status: "started" | "completed" | "error";
      args?: Record<string, unknown>;
      result?: string;
      at: number;
    }
  | { kind: "status"; status: SubagentStatus; at: number };

/**
 * The exact text a follow-up adds to the child's conversation. It is not a
 * protocol marker: the child context is isolated and is never rendered into the
 * brothers' transcript.
 */
export function subagentFollowUpMessage(
  followup: Pick<SubagentFollowUp, "text" | "from">,
): string {
  const who = followup.from === "operator" ? "the operator" : "the Senior";
  return `Follow-up from ${who}:\n${followup.text}`;
}

export interface SubagentRunOptions {
  id: string;
  task: string;
  role: SubagentRole;
  provider: Provider;
  tools: Tool[];
  systemPrompt: string;
  signal?: AbortSignal;
  maxIterations?: number;
  onEvent?: (event: SubagentRunnerEvent) => void;
  onTranscript?: (entry: SubagentTranscriptEntry) => void;
  /**
   * Return-and-clear drain of queued follow-ups. Called at most once per
   * provider step, and only for step >= 1: the previous message is then a tool
   * result, so the appended user turn never makes two consecutive user turns
   * (R5). The queue itself lives in the harness, so the runner stays pure.
   */
  takeFollowUps?: () => SubagentFollowUp[];
  /**
   * Live estimate of the child conversation size in chars (the sum of message
   * contents). The harness keeps it on the child control so a send can be
   * refused honestly while the runner owns the conversation.
   */
  onContextChars?: (chars: number) => void;
}

export interface SubagentRunResult {
  status: Exclude<SubagentStatus, "running">;
  /** Sanitized, bounded final report ("" when the child produced none). */
  text: string;
  error?: string;
  usage: UsageTotals;
  durationMs: number;
  toolCalls: number;
  /**
   * Additive: present only when at least one follow-up was queued for this
   * child, so a follow-up-free child keeps the exact pre-A2 result shape.
   */
  followups?: { delivered: number; dropped: number };
}

function providerUsage(provider: Provider): UsageTotals {
  const tracked = provider as Provider & { usageSnapshot?: () => UsageTotals };
  return typeof tracked.usageSnapshot === "function"
    ? tracked.usageSnapshot()
    : emptyUsage();
}

/** Child-only usage when a caller supplies a shared provider (tests/integrations). */
function usageDelta(after: UsageTotals, before: UsageTotals): UsageTotals {
  const out = emptyUsage();
  for (const key of USAGE_KEYS) {
    out[key] = Math.max(0, (after[key] ?? 0) - (before[key] ?? 0));
  }
  if (after.prompt_tokens !== undefined || before.prompt_tokens !== undefined) {
    out.prompt_tokens = Math.max(
      0,
      (after.prompt_tokens ?? 0) - (before.prompt_tokens ?? 0),
    );
  }
  return out;
}

function emit(options: SubagentRunOptions, event: SubagentRunnerEvent): void {
  try {
    options.onEvent?.(event);
  } catch {
    // a broken live consumer never changes the child's outcome
  }
}

function transcript(
  options: SubagentRunOptions,
  entry: SubagentTranscriptEntry,
): void {
  try {
    options.onTranscript?.(entry);
  } catch {
    // persistence is fail-soft: the child still reports to the parent
  }
}

function toolResultText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value ?? "");
}

/**
 * Run one isolated child. Every expected failure becomes a
 * `failed`/`cancelled` result; only an aborted parent signal is re-thrown so
 * the parent cooperates with the shared cancellation path.
 */
export async function runSubagent(options: SubagentRunOptions): Promise<SubagentRunResult> {
  const startedAt = Date.now();
  const before = providerUsage(options.provider);
  const maxIterations = Math.max(1, options.maxIterations ?? SUBAGENT_MAX_ITERATIONS);
  const messages: ChatMessage[] = [
    { role: "system", content: options.systemPrompt },
    { role: "user", content: `Task from the Senior:\n${options.task}` },
  ];
  transcript(options, {
    type: "message",
    role: "user",
    text: options.task,
    at: startedAt,
  });

  // The child conversation's own char estimate (the budget heuristic). It
  // includes the system prompt; the harness mirrors it onto the control so a
  // queued send can be refused before it would ever overflow the child.
  const contextChars = (): number =>
    messages.reduce((total, message) => total + message.content.length, 0);
  options.onContextChars?.(contextChars());
  let followUpsDelivered = 0;
  let followUpsDropped = 0;
  /** One broken drain callback disables further drains (fail-soft, like steering). */
  let followUpsFailed = false;

  /**
   * Deliver the queued follow-ups for this step. One drain per step,
   * return-and-clear; never called for step 0 (the previous message would be
   * the task, making two consecutive user turns — malformed for Anthropic and
   * Google). Multiple texts join one user turn for the same reason, while each
   * keeps its own durable child-log row. A text that would push the conversation
   * past {@link SUBAGENT_CONTEXT_MAX_CHARS} is counted as dropped; since the
   * context only grows, the rest of that drain is dropped with it.
   */
  const drainFollowUps = (): void => {
    const take = options.takeFollowUps;
    if (take === undefined || followUpsFailed) return;
    let drained: SubagentFollowUp[];
    try {
      drained = take();
    } catch {
      followUpsFailed = true;
      return;
    }
    if (!Array.isArray(drained) || drained.length === 0) return;
    // Defensive: only a valid queued entry is deliverable. Anything else was
    // drained, so it is counted as dropped rather than silently lost.
    const entries = drained.filter(
      (entry): entry is SubagentFollowUp =>
        entry !== null &&
        typeof entry === "object" &&
        typeof (entry as SubagentFollowUp).text === "string" &&
        ((entry as SubagentFollowUp).from === "operator" ||
          (entry as SubagentFollowUp).from === "senior"),
    );
    followUpsDropped += drained.length - entries.length;
    const blocks: string[] = [];
    let estimate = contextChars();
    for (let index = 0; index < entries.length; index += 1) {
      if (followUpsDelivered >= SUBAGENT_MAX_FOLLOWUPS_PER_CHILD) {
        followUpsDropped += entries.length - index;
        break;
      }
      const followup = entries[index]!;
      const text = subagentFollowUpMessage(followup);
      const cost = text.length + (blocks.length > 0 ? 2 : 0);
      if (estimate + cost > SUBAGENT_CONTEXT_MAX_CHARS) {
        followUpsDropped += entries.length - index;
        break;
      }
      blocks.push(text);
      estimate += cost;
      followUpsDelivered += 1;
      transcript(options, {
        type: "message",
        role: "user",
        origin: followup.from,
        text: followup.text,
        at: followup.at,
      });
    }
    if (blocks.length === 0) return;
    messages.push({ role: "user", content: blocks.join("\n\n") });
    options.onContextChars?.(contextChars());
  };

  let text = "";
  let status: Exclude<SubagentStatus, "running"> = "completed";
  let error: string | undefined;
  let toolCalls = 0;
  try {
    if (options.signal?.aborted) throw new ProviderAbortError();
    const chatWithTools =
      options.tools.length > 0
        ? options.provider.chatWithTools?.bind(options.provider)
        : undefined;
    if (chatWithTools === undefined) {
      if (options.signal?.aborted) throw new ProviderAbortError();
      text = sanitizeOutput(
        await options.provider.chat(messages, "subagent", options.signal),
      );
      if (text.trim() !== "") {
        transcript(options, {
          type: "message",
          role: "assistant",
          text,
          at: Date.now(),
        });
        emit(options, { kind: "message", text, at: Date.now() });
      } else {
        status = "failed";
        error = "subagent produced no answer";
      }
    } else {
      const toolMap = new Map(options.tools.map((tool) => [tool.name, tool]));
      let finished = false;
      for (let step = 0; step < maxIterations && !finished; step += 1) {
        if (options.signal?.aborted) throw new ProviderAbortError();
        // Keep the send-time estimate honest: the previous step's tool results
        // are already in the conversation at this point.
        options.onContextChars?.(contextChars());
        // Between-step delivery point (R5): step >= 1 means the previous
        // message is a tool result, never the task.
        if (step >= 1) drainFollowUps();
        const response = await chatWithTools(messages, options.tools, {
          signal: options.signal,
          responseKind: "subagent",
        });
        messages.push({
          role: "assistant",
          content: response.content,
          toolCalls: response.toolCalls,
          ...(response.thinkingBlocks !== undefined && response.thinkingBlocks.length > 0
            ? { thinkingBlocks: response.thinkingBlocks }
            : {}),
        });
        if (response.content.trim() !== "") {
          const visible = sanitizeOutput(response.content);
          transcript(options, {
            type: "message",
            role: "assistant",
            text: visible,
            at: Date.now(),
          });
          emit(options, { kind: "message", text: visible, at: Date.now() });
        }
        if (response.toolCalls.length === 0) {
          text = sanitizeOutput(response.content);
          finished = true;
          break;
        }
        for (const call of response.toolCalls) {
          toolCalls += 1;
          const tool = toolMap.get(call.name);
          emit(options, {
            kind: "tool",
            tool: call.name,
            status: "started",
            args: clipArgs(call.args),
            at: Date.now(),
          });
          transcript(options, {
            type: "tool",
            tool: call.name,
            status: "started",
            args: clipArgs(call.args),
            at: Date.now(),
          });
          let result: string;
          let resultStatus: "completed" | "error" = "completed";
          if (tool === undefined) {
            result = `unknown tool: ${call.name}`;
            resultStatus = "error";
          } else {
            try {
              result = toolResultText(await tool.execute(call.args, options.signal));
            } catch (exc) {
              if (exc instanceof ProviderAbortError) throw exc;
              result = `tool error: ${exc instanceof Error ? exc.message : String(exc)}`;
              resultStatus = "error";
            }
          }
          messages.push({ role: "tool", content: result, toolCallId: call.id });
          const bounded = clipBlock(result, SUBAGENT_TOOL_RESULT_MAX_CHARS);
          emit(options, {
            kind: "tool",
            tool: call.name,
            status: resultStatus,
            result: bounded,
            at: Date.now(),
          });
          transcript(options, {
            type: "tool",
            tool: call.name,
            status: resultStatus,
            result: bounded,
            at: Date.now(),
          });
        }
      }
      if (!finished) {
        status = "failed";
        error = `subagent stopped after ${maxIterations} steps without a final answer`;
      } else if (text.trim() === "") {
        status = "failed";
        error = "subagent produced no final answer";
      }
    }
  } catch (exc) {
    if (exc instanceof ProviderAbortError) {
      status = "cancelled";
      error = "stopped by operator";
    } else {
      status = "failed";
      error = exc instanceof Error ? exc.message : String(exc);
    }
  }

  if (text.length > SUBAGENT_RESULT_MAX_CHARS) {
    text = boundOutput(text, SUBAGENT_RESULT_MAX_CHARS).text;
  }
  const usage = usageDelta(providerUsage(options.provider), before);
  emit(options, { kind: "status", status, at: Date.now() });
  return {
    status,
    text: status === "completed" ? text : "",
    ...(error !== undefined ? { error } : {}),
    usage,
    durationMs: Math.max(0, Date.now() - startedAt),
    toolCalls,
    ...(followUpsDelivered + followUpsDropped > 0
      ? { followups: { delivered: followUpsDelivered, dropped: followUpsDropped } }
      : {}),
  };
}

/**
 * The model-facing tool schema/description. Exposed here so the harness and
 * tests use the exact same text; the model-facing result is built by the
 * harness (it owns the settings/store/events).
 */
export const SUBAGENT_TOOL_DESCRIPTION = [
  "Spawn one isolated helper for a focused side task.",
  "The helper does not see this conversation; it gets only your task brief and workspace tools, then returns a bounded report.",
  "Use it for parallel discovery, a second opinion on a file, or reading a large area without polluting this context.",
  "The operator may configure a dedicated helper route in Settings; when set, it wins over the `role` argument.",
  "Workspace changes the helper makes are ordinary operator approvals in this run, under the same permission mode; a helper cannot widen the run's policy.",
  "It cannot spawn more subagents. Do not use it as a replacement for the Junior.",
  "Set `background:true` to keep working while it runs: the result is then `status:\"started\"` and the report is only readable through `subagent_report`. A background helper is cancelled when this run ends, so read its report before then.",
].join(" ");

export const SUBAGENT_TOOL_PARAMETERS: Record<string, unknown> = {
  type: "object",
  properties: {
    task: {
      type: "string",
      description:
        "A self-contained brief: what to inspect, what question to answer, and what evidence to return.",
    },
    label: {
      type: "string",
      description: "Short display label (defaults to the first line of the task).",
    },
    role: {
      type: "string",
      enum: ["senior", "junior"],
      description:
        "Fallback model when no dedicated helper route is configured in Settings. A configured route always wins.",
    },
    background: {
      type: "boolean",
      description:
        "Run the helper in the background and return `status:\"started\"` instead of waiting for the report. The report is then only readable through `subagent_report`; the helper is cancelled when this run ends. Default false (wait for the bounded report).",
    },
  },
  required: ["task"],
  additionalProperties: false,
};

/**
 * The exact honest note a background spawn returns: the report was not read
 * and never arrives by itself, and the child does not outlive the run.
 */
export const SUBAGENT_BACKGROUND_NOTE =
  "The helper runs in the background. Call subagent_report with this id to read its report; it is cancelled when this run ends.";

export const LIST_AGENTS_TOOL_DESCRIPTION = [
  "List the helpers this run spawned — not the Junior, not helpers of other runs.",
  "One bounded row per helper: id, label, status, background flag, role, model, elapsed time, last activity, queued follow-ups and whether its report has been read. Never the task text.",
  "Use it to find the id for send_message, interrupt_agent or subagent_report. At most 8 rows.",
].join(" ");

export const LIST_AGENTS_TOOL_PARAMETERS: Record<string, unknown> = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

export const SEND_MESSAGE_TOOL_DESCRIPTION = [
  "Queue one short follow-up for a live helper.",
  "The helper reads it as an ordinary turn at its next step (never inside a parked approval wait, never as a second consecutive task), and the text never enters this conversation.",
  "The result says `queued` with the pending count — never `delivered`: it does not mean the helper has read or answered it. A helper that already settled refuses honestly.",
  "Use subagent_report for the answer.",
].join(" ");

export const SEND_MESSAGE_TOOL_PARAMETERS: Record<string, unknown> = {
  type: "object",
  properties: {
    agent_id: {
      type: "string",
      description: "The helper id from list_agents (sub-…).",
    },
    text: {
      type: "string",
      description: "The follow-up text (at most 4000 chars).",
    },
  },
  required: ["agent_id", "text"],
  additionalProperties: false,
};

export const INTERRUPT_AGENT_TOOL_DESCRIPTION = [
  "Stop one live helper without touching this run.",
  "The helper settles `cancelled`; its queued follow-ups are dropped and counted, and a parked approval is withdrawn.",
  "Returns immediately — read the outcome with subagent_report. This never cancels the parent run.",
].join(" ");

export const INTERRUPT_AGENT_TOOL_PARAMETERS: Record<string, unknown> = {
  type: "object",
  properties: {
    agent_id: {
      type: "string",
      description: "The helper id from list_agents (sub-…).",
    },
    reason: {
      type: "string",
      description: "Optional display-only reason (at most 200 chars).",
    },
  },
  required: ["agent_id"],
  additionalProperties: false,
};

export const SUBAGENT_REPORT_TOOL_DESCRIPTION = [
  "Read one helper's report.",
  "On a running helper this is an honest status (elapsed, last activity, pending follow-ups) — not an error and not the report: do other work and ask again instead of polling in a loop.",
  "On a settled helper it is the full bounded report, and asking twice returns the same report.",
  "A helper's report never arrives by itself: this call is the only way it enters this conversation.",
].join(" ");

export const SUBAGENT_REPORT_TOOL_PARAMETERS: Record<string, unknown> = {
  type: "object",
  properties: {
    agent_id: {
      type: "string",
      description: "The helper id from list_agents (sub-…).",
    },
  },
  required: ["agent_id"],
  additionalProperties: false,
};

/** One tree-row-friendly report line for a tool call (kept in tests/docs). */
export function subagentToolActivityLabel(tool: string, status?: string): string {
  const suffix = status === "error" ? " (error)" : "";
  return `${tool}${suffix}`;
}
