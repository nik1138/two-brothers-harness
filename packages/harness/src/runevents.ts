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
 * prompt_audit / run_error / run_end) plus `run_id` and `at` (epoch
 * seconds). Event JSON keeps the Python field names (`run_id`,
 * `approval_id`) so sidecar files stay interchangeable with the Python
 * implementation; `prompt_audit` keeps its camelCase payload
 * (`systemChars`/`userChars`) to stay identical to `PromptAuditEntry`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

import { Decision, type ApprovalBroker, type ApprovalRequest } from "./permissions.ts";
import type { PromptAuditEntry } from "./harness.ts";

export const CLIP_RESULT_CHARS = 800;
export const CLIP_ARG_CHARS = 200;
export const CLIP_EVIDENCE_CHARS = 240;
export const MAX_EVIDENCE_ENTRIES = 12;

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

/** An approval wait was parked; the operator must answer (or the run stops). */
export interface ApprovalRequestedEvent extends RuntimeEventMeta {
  type: "approval_requested";
  approval_id: string;
  action: string;
  target?: string;
  command?: string;
}

/** An approval wait was resolved exactly once (allow/deny, or deny/cancelled). */
export interface ApprovalResolvedEvent extends RuntimeEventMeta {
  type: "approval_resolved";
  approval_id: string;
  decision: string;
  reason?: string;
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

/** The job raised; surfaced to the operator before run_end. */
export interface RunErrorEvent extends RuntimeEventMeta {
  type: "run_error";
  message: string;
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
  | PromptAuditEvent
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

  constructor(directory: string) {
    this.directory = directory;
  }

  /** `path.basename` flattening: never allow path traversal out of the dir. */
  private pathFor(sessionName: string): string {
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
    fs.mkdirSync(this.directory, { recursive: true });
    fs.appendFileSync(this.pathFor(sessionName), JSON.stringify(event) + "\n", "utf-8");
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

/** Events the broker emits into the run's event stream. */
type ApprovalEvent = ApprovalRequestedEvent | ApprovalResolvedEvent;

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
 * Approval broker for one run: emits `approval_requested` events, then parks
 * the awaiting tool coroutine until the operator answers via `respond()`, the
 * run is stopped (`denyAll()` / abort signal — a stopped run must never leave
 * a mutation parked mid-approval, so every pending wait resolves as DENY).
 *
 * Implements the `ApprovalBroker` interface from `permissions.ts`, so it plugs
 * straight into `PermissionManager` in place of `CallbackBroker`/`StaticBroker`.
 * Python parity: `approve()` polls a threading.Event; here the same semantics
 * ride on a promise plus an `AbortSignal` listener (no polling).
 */
export class RunApprovalBroker implements ApprovalBroker {
  private readonly _pending = new Map<string, PendingApproval>();
  private _emit: ((event: ApprovalEvent) => void) | null = null;
  private _signal: AbortSignal | null = null;

  /** Bind the per-run emit hook and abort signal (created by the worker). */
  attach(
    emit: ((event: ApprovalEvent) => void) | null = null,
    signal: AbortSignal | null = null,
  ): void {
    this._emit = emit;
    this._signal = signal;
  }

  // -- broker protocol -------------------------------------------------------

  /** Park until the operator answers, the run stops (deny), or denyAll(). */
  async approve(request: ApprovalRequest): Promise<Decision> {
    const approvalId = shortId();
    const entry: PendingApproval = {
      request,
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
      action: request.action,
      target: request.target,
      command: request.command,
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
          });
        }
        entry.resolve(Decision.DENY);
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }

    await settled;

    if (onAbort !== null && this._signal !== null) {
      this._signal.removeEventListener("abort", onAbort);
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
      });
    }
    return out;
  }

  /** Answer one pending request; `null` if unknown or already answered. */
  respond(requestId: string, decision: Decision): Decision | null {
    const entry = this._pending.get(requestId);
    if (entry === undefined || entry.answered) return null;
    entry.decision = decision;
    entry.answered = true;
    entry.resolve(decision);
    return decision;
  }

  /**
   * Resolve every pending wait as *deny* (run stopped / worker torn down).
   * Entries are removed here; a parked `approve()` then wakes to an
   * already-resolved entry and returns DENY without emitting again — the
   * resolution event is emitted exactly once, here.
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
      });
    }
    return entries.length;
  }

  private _event(event: ApprovalEvent): void {
    this._emit?.(event);
  }
}
