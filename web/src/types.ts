export type Role = 'senior' | 'junior' | 'user'

export type EnvelopeKind =
  | 'message'
  | 'consult'
  | 'proposal'
  | 'delegation'
  | 'deliverable'
  | 'review'
  | 'decision'

export interface Envelope {
  v: number
  id: string
  seq: number
  ts: string
  from: Role
  to: Role
  kind: EnvelopeKind
  payload: Record<string, unknown>
}

export interface SessionInfo {
  name: string
  size: number
  mtime: number
  /** Readable title from the metadata sidecar (may be absent for legacy files). */
  title?: string
  /** Linked workspace, if any. */
  workspace_id?: string
}

export interface SessionDetail {
  name: string
  events: Envelope[]
  title?: string
  workspace_id?: string
}

export interface Workspace {
  id: string
  name: string
  path: string
}

export type RunMode = 'consult' | 'work' | 'auto'
export type RunProvider = 'mock' | 'openai'

export interface RunRequest {
  task: string
  mode?: RunMode | null
  /** Omit (null) to use the per-role providers from /api/settings. */
  provider?: RunProvider | null
  /** Existing session for a follow-up; omit to start a new session. */
  session?: string | null
  workspace_id?: string | null
}

/**
 * Run lifecycle as reported by `/api/runs`. `waiting` means the run is parked
 * on an operator approval: it is alive, but neither working nor finished. The
 * backend (`packages/harness`) streams `run_status: waiting` when a
 * run parks and `running` again once the approval resolves, so the followed
 * run needs no polling; the 5 s pool poll now only reconciles runs this app
 * does not stream.
 */
export type RunStatus = 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled'

/** Per-run model usage counters; null/absent while running or for pre-upgrade runs. */
export interface RunUsage {
  model_calls: number
  input_tokens: number
  output_tokens: number
  cached_tokens: number
}

export interface RunStart {
  run_id: string
  session: string
  status: RunStatus
}

export interface RunRecord {
  run_id: string
  session: string
  task: string
  status: RunStatus
  /**
   * Effective mode the run was started with, so a reloaded failure can be
   * retried as submitted. Empty when the backend rebuilt the record from the
   * runtime sidecar (`mode` is not an event field).
   */
  mode?: RunMode | ''
  created: number
  started: number
  finished: number
  error?: string
  decision?: Record<string, unknown>
  usage?: RunUsage | null
}

/** Operator-facing role settings — never contains API key material. */
export interface RoleSettingsView {
  provider: string | null
  model: string | null
  base_url: string | null
  api_key_set: boolean
  /** Provider preset name driving this role's base_url/api_key; null/"" = manual. */
  provider_ref?: string | null
}

export type SettingsView = Record<'senior' | 'junior', RoleSettingsView>

/** Compact diff summary inside a workspace tool result. */
export interface ToolDiffSummary {
  added_lines: number
  removed_lines: number
  unified: string
}

/** Field-by-field summary of a workspace tool result (runevents.compact_tool_result). */
export interface ToolResultCompact {
  status?: string
  path?: string
  command?: string
  exit_code?: number | null
  error?: string
  bytes_written?: number
  replaced?: boolean
  deleted?: boolean
  truncated?: boolean
  duration_ms?: number
  timed_out?: boolean
  cancelled?: boolean
  stdout?: string
  stderr?: string
  diff?: ToolDiffSummary
  [key: string]: unknown
}

export interface ToolStartedEvent {
  type: 'tool_started'
  tool: string
  args: Record<string, unknown>
  actor?: Role
  run_id: string
  at: number
}

export interface ToolCompletedEvent {
  type: 'tool_completed'
  tool: string
  status: string
  result: unknown
  actor?: Role
  run_id: string
  at: number
}

export interface ApprovalRequestedEvent {
  type: 'approval_requested'
  approval_id: string
  action: string
  target: string
  command?: string | null
  reason?: string | null
  run_id: string
  at: number
}

export interface ApprovalResolvedEvent {
  type: 'approval_resolved'
  approval_id: string
  decision: string
  reason?: string | null
  run_id: string
  at: number
}

/**
 * One provider call's prompt/tool-belt audit — the runtime mirror of
 * `HarnessResult.promptAudits` in `packages/harness`: names and lengths only,
 * never prompt bodies. Emitted immediately before the call, so it precedes
 * that call's tool events and the envelope it produces.
 */
export interface PromptAuditEvent {
  type: 'prompt_audit'
  role: 'senior' | 'junior'
  /** Node kind the call answers (consult / delegation / deliverable / verify / review / decision). */
  kind: string
  /** Assembled system-prompt section names, in order. */
  sections: string[]
  /** Model-facing tool names offered on this call. */
  tools: string[]
  /** Characters in the assembled system prompt. */
  systemChars: number
  /** Characters in the rendered user message (the shared context). */
  userChars: number
  run_id: string
  at: number
}

/** Typed runtime events streamed from GET /api/runs/{id}/events. */
export type RunEvent =
  | { type: 'run_status'; status: 'queued' | 'running' | 'waiting'; run_id: string; at: number }
  | { type: 'envelope'; seq: number; envelope: Envelope; run_id: string; at: number }
  | { type: 'run_error'; message: string; run_id: string; at: number }
  | {
      type: 'run_end'
      status: 'completed' | 'failed' | 'cancelled'
      decision?: Record<string, unknown>
      usage?: RunUsage | null
      run_id: string
      at: number
    }
  | ToolStartedEvent
  | ToolCompletedEvent
  | ApprovalRequestedEvent
  | ApprovalResolvedEvent
  | PromptAuditEvent

/** Response of GET /api/sessions/{name}/events — the runtime sidecar. */
export interface SessionRuntimeEvents {
  name: string
  events: RunEvent[]
}

/** One unanswered approval request from GET /api/runs/{id}/approvals. */
export interface PendingApproval {
  approval_id: string
  action: string
  target: string
  command?: string | null
  reason?: string | null
}

export interface RunApprovalsView {
  run_id: string
  pending: PendingApproval[]
}

export interface ApprovalAnswerRequest {
  allow: boolean
}

export interface ApprovalDecisionView {
  approval_id: string
  decision: string
}

export interface SessionCreateRequest {
  title?: string
  workspace_id?: string
}

export interface WorkspaceCreateRequest {
  path: string
  name?: string
}

export type ReviewVerdict = 'accept' | 'revise' | 'reject'

/** One directory entry from GET /api/fs/browse (directories only). */
export interface FsEntry {
  name: string
  path: string
}

/** Response of GET /api/fs/browse. */
export interface FsBrowseResult {
  path: string
  parent: string | null
  entries: FsEntry[]
  truncated: boolean
}

/** Operator-facing provider preset — never contains API key material. */
export interface ProviderPreset {
  name: string
  base_url: string
  api_key_set: boolean
  /** Preset flavor; only "openai-compatible" exists today. */
  kind: string
  /** Manual model list (model discovery is deferred). */
  models: string[]
}
