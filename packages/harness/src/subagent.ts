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
    },
  ): void {
    this.appendLine(id, {
      type: "end",
      status: result.status,
      ended_at: intOf(result.ended_at),
      ...(result.result !== undefined
        ? { result: textOf(result.result, SUBAGENT_RESULT_MAX_CHARS) }
        : {}),
      ...(result.error !== undefined ? { error: textOf(result.error, 2_000) } : {}),
      ...(result.usage !== undefined ? { usage: result.usage } : {}),
    });
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
      return { type: "message", role, text, at: intOf(raw.at) };
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
}

export interface SubagentRunResult {
  status: Exclude<SubagentStatus, "running">;
  /** Sanitized, bounded final report ("" when the child produced none). */
  text: string;
  error?: string;
  usage: UsageTotals;
  durationMs: number;
  toolCalls: number;
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
  },
  required: ["task"],
  additionalProperties: false,
};

/** One tree-row-friendly report line for a tool call (kept in tests/docs). */
export function subagentToolActivityLabel(tool: string, status?: string): string {
  const suffix = status === "error" ? " (error)" : "";
  return `${tool}${suffix}`;
}
