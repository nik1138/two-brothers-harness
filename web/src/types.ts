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

/** Where a `/api/search` hit matched: the session title or an envelope body. */
export type SearchHitField = 'title' | 'message' | 'decision'

/** One content-search hit over all session documents (`GET /api/search`). */
export interface SearchHit {
  /** Session file name, e.g. "20260101-120000.jsonl". */
  session: string
  /** Readable session title; may be empty for legacy sessions. */
  title: string
  field: SearchHitField
  /** Envelope seq for message/decision hits; null for title hits. */
  seq: number | null
  /** Envelope author (`from`) for message hits; null for title hits. */
  role: string | null
  /** Envelope kind (`message`, `decision`, …); null for title hits. */
  kind: string | null
  /** Bounded single-line context around the match. */
  snippet: string
  /** Envelope timestamp, when present. */
  ts: string | null
}

/** Response of `GET /api/search?q=<query>&limit=<n>`. */
export interface SearchResult {
  /** Trimmed query the backend actually searched. */
  query: string
  /** Number of session files scanned (may be capped by the backend). */
  scanned_sessions: number
  /** True when a cap clipped the scan or the hit list. */
  truncated: boolean
  hits: SearchHit[]
}

/** Download format of `GET /api/sessions/{name}/export?format=…`. */
/** Download formats the session export endpoint renders (wave 23 adds HTML). */
export type SessionExportFormat = 'markdown' | 'json' | 'html'

/**
 * `POST /api/sessions/{name}/fork` result (wave 23, fork-by-copy): the new
 * session file name, its sidecar title, the number of envelopes copied and the
 * local lineage link recorded in the new session's `.meta.json`.
 */
export interface SessionForkResult {
  /** New session file name, including `.jsonl`. */
  name: string
  /** Sidecar title actually saved (`<source title> (fork)` by default). */
  title: string
  /** Number of envelopes copied (the source prefix length). */
  events: number
  forked_from: { name: string; seq: number }
}

/**
 * `POST /api/sessions/{name}/rewind` result (wave 23 session rewind): the
 * applied cut. `seq` stays dense because only a suffix of the JSONL is dropped;
 * `stopped_at_compaction`/`reason` carry the backend's honest clamp wording.
 */
export interface SessionRewindResult {
  /** The session name the rewrite targeted (canonical `.jsonl` file name). */
  name: string
  /** True when the session file was rewritten; false for a no-op cut. */
  rewritten: boolean
  /** Envelopes kept by the rewrite. */
  kept: number
  /** Envelopes removed by the rewrite. */
  removed: number
  /** Operator turns actually removed (the clamped depth). */
  turns: number
  /** The depth the client asked for, before clamping. */
  requested_turns: number
  /** True when the compaction floor, not the requested depth, limited the cut. */
  stopped_at_compaction: boolean
  /** Which boundary determined the cut. */
  stops_before: 'operator-turn' | 'compaction-summary' | 'session-start' | string
  /** One honest, bounded human sentence describing the outcome. */
  reason: string
  /** Whether the runtime-event sidecar for the session was cleared too. */
  runtime_events_cleared?: boolean
  /** Why the sidecar clear failed, when it did (disclosed, never hidden). */
  runtime_events_clear_error?: string | null
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
  /**
   * Ask the server to emit ephemeral live `token` SSE frames for this run
   * (named event, not replayed on reconnect). The web client always opts in.
   */
  stream_tokens?: boolean
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
  /**
   * Prompt tokens written to a provider cache (wave 24, Anthropic's
   * `cache_creation_input_tokens`). Optional: pre-wave-24 records omit it —
   * render/read code must treat a missing value as 0.
   */
  cache_write_tokens?: number
}

/**
 * Estimated USD cost of one run (wave 24). Present on a run record only when
 * both roles resolved to the same priced model; `null` means unknown, never
 * `$0`. `model` is the price-table row the id matched.
 */
export interface RunCost {
  currency: 'USD'
  total: number
  model: string
}

export interface RunStart {
  run_id: string
  session: string
  status: RunStatus
}

/**
 * `POST /api/runs/{run_id}/steer` acceptance (wave 23): the run id, the
 * status the steer was accepted against (`running`, or `waiting` for a run
 * parked on an approval) and how many steering texts are now waiting for the
 * run's next step. The transcript entry itself arrives later over the run SSE
 * stream — this response never fakes it.
 */
export interface RunSteerResult {
  run_id: string
  status: RunStatus
  /** Steering texts pending for the next step (1..8 on acceptance). */
  pending: number
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
  /** Additive run cost estimate; `null`/absent = unknown (omit the segment). */
  cost?: RunCost | null
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

/**
 * Operator approval mode for workspace mutations and shell commands
 * (`approval_policy` section of `GET/PUT /api/settings`). Mirrors the backend
 * `ApprovalMode` enum in `packages/harness/src/permissions.ts`.
 */
export type ApprovalMode = 'ask' | 'readonly' | 'edits' | 'allow-all'

/**
 * Additive `approval_policy` section. Older backends omit it (the web app
 * then shows the fail-closed `ask` and never sends an approval patch).
 */
export interface ApprovalPolicyView {
  mode: ApprovalMode
  /** True when a serve flag/env pin overrides the persisted mode. */
  pinned?: boolean
}

/**
 * Where one effective compaction budget came from (`compaction` section of
 * `GET/PUT /api/settings`). Mirrors `CompactionFieldSource` in
 * `packages/harness/src/config.ts`: `flag` = serve CLI flag/env pin,
 * `options` = an explicit server option, `persisted` = the saved section,
 * `preset` = the smaller context window declared by the roles' provider
 * presets (a fallback that only applies when nothing run-level is set),
 * `absent` = not configured (the harness default, if any, applies).
 */
export type CompactionFieldSource = 'options' | 'flag' | 'persisted' | 'preset' | 'absent'

/** One compaction budget: stored value, effective value and its source. */
export interface CompactionFieldView {
  /** The stored `compaction` section value (0 = not stored). */
  persisted: number
  /** The merged value a serve run receives (0 = not configured). */
  effective: number
  source: CompactionFieldSource
}

/**
 * Additive `compaction` section on `GET/PUT /api/settings`. Older backends
 * omit it (the web app then disables the card and never sends the section).
 */
export interface CompactionSettingsView {
  threshold_chars: CompactionFieldView
  threshold_tokens: CompactionFieldView
  keep_recent_chars: CompactionFieldView
  context_window: CompactionFieldView
  /** `--compact` on the server: compact once before a run starts. */
  force: boolean
  /** True when a serve flag/env pin (or server option) owns a field. */
  pinned: boolean
}

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
  /**
   * Additive bounded plain-text display preview for workspace read/list/search
   * results (file-content head, directory entries, match paths). Older
   * backends omit it; the card then keeps its historical collapsed shape.
   */
  preview?: string
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

/**
 * Additive bounded preview of a pending mutation, mirroring the harness's
 * `ApprovalDetail` (`packages/harness/src/permissions.ts`). Every field except
 * `kind` is optional; the backend clips `diff` to its own cap before sending
 * it. Old backends and broker-only requests simply omit the whole object.
 */
export interface ApprovalDetail {
  /** `write` / `edit` / `delete` / `shell` (the requested action). */
  kind: string
  /** Unified diff of the change for write/edit/delete (bounded by the backend). */
  diff?: string
  /** Diff line counts, when the backend knows them. */
  addedLines?: number
  removedLines?: number
  /** Shell command to run (shell detail). */
  command?: string
  /** True when the backend clipped the diff to its size cap. */
  truncated?: boolean
}

export interface ApprovalRequestedEvent {
  type: 'approval_requested'
  approval_id: string
  action: string
  target: string
  command?: string | null
  reason?: string | null
  /** Additive bounded preview; omitted by old backends and broker-only events. */
  detail?: ApprovalDetail
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

/**
 * A repeat approval request for an `(action, target)` pair the operator has
 * already denied `count` times: the broker auto-denies it without waking the
 * operator (the run cannot park on the same question forever).
 */
export interface ApprovalAutoDeniedEvent {
  type: 'approval_auto_denied'
  action: string
  target: string
  /** Operator denials recorded for the pair when the cap tripped. */
  count: number
  /** Configured deny limit (default 2). */
  limit: number
  run_id: string
  at: number
}

/**
 * An identical approval request auto-allowed because the operator answered
 * "Always allow this session" for its `(action, target)` pair (or the server
 * seeded the pair from persisted session approvals): it never parked and no
 * `approval_requested` was emitted for it.
 */
export interface ApprovalAutoAllowedEvent {
  type: 'approval_auto_allowed'
  action: string
  target: string
  run_id: string
  at: number
}

/**
 * Lifecycle state of one plan/todo entry (the package's `TodoStatus`).
 */
export type TodoStatus = 'pending' | 'in_progress' | 'completed'

/**
 * One entry in the model-maintained plan. The backend sends the complete
 * sanitized list on every write, so entries need no id (last write wins).
 */
export interface TodoItem {
  /** Short imperative task line (already trimmed/bounded by the backend). */
  content: string
  status: TodoStatus
}

/**
 * Additive runtime event: the model replaced its whole plan through the
 * built-in `todo_write` tool. Display state only — never a protocol envelope —
 * and the latest snapshot on replay is the current plan. Older backends never
 * emit it, which is why the TodoPanel simply stays absent for them.
 */
export interface TodoUpdatedEvent {
  type: 'todo_updated'
  todos: TodoItem[]
  run_id: string
  at: number
}

/**
 * One live token delta from the run's named SSE `token` frame. Ephemeral:
 * never persisted to the run record/sidecar and never replayed by `?after`.
 * `thinking` deltas are observational reasoning; the reply arrives as the
 * normal `envelope` event (a missing/unknown `kind` is treated as `text`).
 */
export interface TokenEvent {
  type: 'token'
  run_id: string
  role: 'senior' | 'junior' | 'user'
  kind: 'text' | 'thinking'
  delta: string
  at: number
}

/**
 * Additive runtime event: one provider call's bounded, sanitized reasoning
 * (thinking) text, persisted in the session's runtime sidecar. Capture is
 * streaming-only (the backend only receives reasoning through its token
 * stream), so non-streaming runs simply have none, exactly like an older
 * backend. `text` is already ANSI/control-sanitized and bounded by the
 * backend; `truncated` marks a clipped record. Never a protocol envelope.
 */
export interface ReasoningEvent {
  type: 'reasoning'
  role: 'senior' | 'junior'
  /** Node kind the call answered (consult / proposal / review / decision / …). */
  kind: string
  /** Sanitized, bounded reasoning text (plain text — never markup). */
  text: string
  /** True when the backend clipped the stream to its size cap. */
  truncated?: boolean
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
  | TokenEvent
  | ToolStartedEvent
  | ToolCompletedEvent
  | ApprovalRequestedEvent
  | ApprovalResolvedEvent
  | ApprovalAutoDeniedEvent
  | ApprovalAutoAllowedEvent
  | TodoUpdatedEvent
  | PromptAuditEvent
  | ReasoningEvent

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

/** Scope a discovered skill is offered under (`shared` = both roles). */
export type SkillScope = 'shared' | 'senior' | 'junior'

/** One discovered skill from GET /api/skills (metadata only, no body). */
export interface SkillInfo {
  name: string
  description: string
  scope: SkillScope
  tools: string[]
  file: string
}

/** Response of GET /api/skills. */
export interface SkillListResponse {
  skills: SkillInfo[]
  diagnostics: string[]
}

/** Cooperation mode a slash command can pin for its turn. */
export type CommandMode = 'consult' | 'work'

/** One discovered slash command from GET /api/commands (metadata only). */
export interface CommandInfo {
  name: string
  description: string
  /** Frontmatter `argument-hint`, shown beside the name; `""` when absent. */
  argumentHint: string
  /** Optional frontmatter `mode` the expanded command runs in. */
  mode?: CommandMode
  file: string
}

/**
 * What a surface does for a first-party base command. `prompt` commands just
 * submit their expanded text; `action` commands are performed locally.
 */
export type BaseCommandAction =
  | 'compact'
  | 'export'
  | 'permission'
  | 'help'
  | 'status'
  | 'mode'
  | 'new'

/** `prompt` commands expand to a task; `action` commands are local effects. */
export type BaseCommandKind = 'prompt' | 'action'

/**
 * One first-party slash command (`GET /api/commands` → `baseCommands`,
 * metadata only — never template bodies).
 */
export interface BaseCommand {
  name: string
  /** Extra typed spellings (English synonyms + the reference Chinese names). */
  aliases: string[]
  description: string
  /** Argument placeholder, e.g. `"<objective>"`; `""` when none. */
  argumentHint: string
  kind: BaseCommandKind
  /** Present for `kind: "action"`: what a surface performs. */
  action?: BaseCommandAction
  /** Empty arguments are a usage error when true. */
  requiresArguments: boolean
  /** Higher sorts first; ties break on name. */
  priority: number
}

/** Response of GET /api/commands (base commands are additive). */
export interface CommandListResponse {
  commands: CommandInfo[]
  baseCommands: BaseCommand[]
  diagnostics: string[]
}

/** Response of POST /api/sessions/{name}/compact. */
export interface SessionCompactResult {
  compacted: boolean
  /** Envelope counts around a successful compaction. */
  before_events?: number
  after_events?: number
  /** Why nothing was compacted (`compacted: false`). */
  reason?: string
}

/** One workspace file from GET /api/workspaces/{id}/files. */
export interface WorkspaceFileEntry {
  /** Path relative to the workspace root, forward slashes. */
  path: string
  size: number
  mtime: number
}

/** Response of GET /api/workspaces/{id}/files. */
export interface WorkspaceFileSearchResponse {
  workspace_id: string
  files: WorkspaceFileEntry[]
  truncated: boolean
  total: number
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
  /**
   * Additive (`GET/PUT /api/providers`): context window in tokens for the
   * models this preset serves. Positive; `0`/absent means unknown. Older
   * backends omit it (treat as 0).
   */
  context_window?: number
  /**
   * Additive (`GET /api/providers`): the name comes from the built-in seed
   * table. Older backends omit it — treat a missing flag as `false`.
   */
  seed?: boolean
  /**
   * Additive: a stored entry exists for this name (a PUT-created override of a
   * seed, or a POST-created custom provider). Older backends omit it — treat a
   * missing flag as `true` so an old backend still renders.
   */
  customized?: boolean
}
