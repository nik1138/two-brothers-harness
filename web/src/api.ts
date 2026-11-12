import type {
  ApprovalAnswerRequest,
  ApprovalDecisionView,
  ApprovalMode,
  ApprovalPolicyView,
  CommandInfo,
  CommandListResponse,
  CompactionSettingsView,
  Envelope,
  FsBrowseResult,
  ModelEffortInfo,
  ProviderPreset,
  RunApprovalsView,
  RunEvent,
  RunRecord,
  RunRequest,
  RunStart,
  RunSteerResult,
  SearchResult,
  SessionCreateRequest,
  SessionCompactResult,
  SessionDetail,
  SessionExportFormat,
  SessionForkResult,
  SessionInfo,
  SessionRewindResult,
  SessionRuntimeEvents,
  SettingsView,
  SkillInfo,
  SkillListResponse,
  SubagentDetail,
  SubagentInfo,
  TokenEvent,
  Workspace,
  WorkspaceCreateRequest,
  WorkspaceFileEntry,
  WorkspaceFileSearchResponse,
} from './types'
import { clampSearchLimit } from './search'
import { clampFileQueryLimit } from './mentions'
import { isTokenEvent } from './streaming'
import { normalizeSubagentDetail, normalizeSubagentList } from './subagents'
import { normalizeUndoApplyResult, normalizeUndoPreview } from './runUndo'
import type {
  RunUndoApplyResult,
  RunUndoDiscardResult,
  RunUndoPreview,
} from './runUndo'

export class ApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

/**
 * Perform one API request and map transport/HTTP failures onto `ApiError`.
 * Resolves to the raw `Response` for callers that do not want JSON (exports).
 */
async function requestRaw(url: string, init?: RequestInit): Promise<Response> {
  let res: Response
  try {
    res = await fetch(url, init)
  } catch {
    throw new ApiError('API is unreachable — is the backend running on port 8600?', 0)
  }
  if (!res.ok) {
    let detail = `HTTP ${res.status}`
    try {
      const body = await res.json()
      if (body && typeof body.detail === 'string') detail = body.detail
    } catch {
      // keep default message
    }
    throw new ApiError(detail, res.status)
  }
  return res
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await requestRaw(url, init)
  return (await res.json()) as T
}

function json(method: string, body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}

// -- sessions ---------------------------------------------------------------

export async function listSessions(workspaceId?: string | null): Promise<SessionInfo[]> {
  const q = workspaceId ? `?workspace_id=${encodeURIComponent(workspaceId)}` : ''
  return request<SessionInfo[]>(`/api/sessions${q}`)
}

export async function getSession(name: string): Promise<SessionDetail> {
  return request<SessionDetail>(`/api/sessions/${encodeURIComponent(name)}`)
}

/** Runtime sidecar (tool/approval/run events) for a session; empty for legacy sessions. */
export async function getSessionRuntimeEvents(name: string): Promise<SessionRuntimeEvents> {
  return request<SessionRuntimeEvents>(`/api/sessions/${encodeURIComponent(name)}/events`)
}

/** Helper children recorded for one parent session, newest first. */
export async function listSessionSubagents(name: string): Promise<SubagentInfo[]> {
  const body = await request<unknown>(
    `/api/sessions/${encodeURIComponent(name)}/subagents`,
  )
  return normalizeSubagentList(body)
}

/** One child's bounded transcript; null for an unknown/invalid id. */
export async function getSubagent(id: string): Promise<SubagentDetail | null> {
  const body = await request<{ subagent?: unknown }>(
    `/api/subagents/${encodeURIComponent(id)}`,
  )
  return normalizeSubagentDetail(body?.subagent)
}

export async function createSession(body: SessionCreateRequest): Promise<SessionInfo> {
  return request<SessionInfo>('/api/sessions', json('POST', body))
}

/** Result of `PATCH /api/sessions/{name}` — the saved metadata sidecar. */
export interface SessionRenameResult {
  name: string
  title?: string
  workspace_id?: string
  created?: number
  updated?: number
}

/** Set a session's readable title (the session file itself is untouched). */
export async function renameSession(name: string, title: string): Promise<SessionRenameResult> {
  return request<SessionRenameResult>(
    `/api/sessions/${encodeURIComponent(name)}`,
    json('PATCH', { title }),
  )
}

/** Remove a session plus its metadata/runtime sidecars (stops a live run first). */
export async function deleteSession(name: string): Promise<{ deleted: string }> {
  return request<{ deleted: string }>(`/api/sessions/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  })
}

/**
 * Optional body of `POST /api/sessions/{name}/fork` (wave 23, fork-by-copy):
 * both fields are optional — omit both to copy the whole session under a
 * generated `<stem>-fork-<k>` name. `seq` is the last source envelope to copy;
 * `name` is the explicit new session name.
 */
export interface SessionForkOptions {
  seq?: number
  name?: string
}

/**
 * Fork a session by copy (`POST /api/sessions/{name}/fork`). The source file and
 * its sidecar are left byte-identical; the response names the new session, its
 * title, the copied envelope count and the recorded lineage link.
 */
export async function forkSession(
  name: string,
  options: SessionForkOptions = {},
): Promise<SessionForkResult> {
  return request<SessionForkResult>(
    `/api/sessions/${encodeURIComponent(name)}/fork`,
    json('POST', options),
  )
}

/**
 * Rewind a session in place (`POST /api/sessions/{name}/rewind`): remove the
 * last `turns` operator tasks and everything after them from the JSONL. The
 * backend validates the depth (1..100), refuses while the session has an
 * active run, and returns the applied cut with an honest clamp reason.
 */
export async function rewindSession(
  name: string,
  turns: number,
): Promise<SessionRewindResult> {
  return request<SessionRewindResult>(
    `/api/sessions/${encodeURIComponent(name)}/rewind`,
    json('POST', { turns }),
  )
}

// -- session content search & export -------------------------------------------

/**
 * Full-text search across all session documents (`GET /api/search`).
 *
 * The backend rejects queries shorter than two characters with a 400, so
 * callers must gate on `shouldSearchContent` (in `./search`) before calling;
 * `limit` is clamped here so a bad caller cannot ask for an absurd page.
 */
export async function searchSessions(query: string, limit?: number): Promise<SearchResult> {
  const q = encodeURIComponent(query)
  return request<SearchResult>(`/api/search?q=${q}&limit=${clampSearchLimit(limit)}`)
}

/**
 * Download one session as Markdown or JSON (`GET /api/sessions/{name}/export`).
 * Resolves to the raw body text; the browser needs the caller to save it as a
 * file (the server also sends `Content-Disposition`).
 */
export async function exportSession(
  name: string,
  format: SessionExportFormat,
): Promise<string> {
  const res = await requestRaw(
    `/api/sessions/${encodeURIComponent(name)}/export?format=${format}`,
  )
  return res.text()
}

// -- workspaces ---------------------------------------------------------------

export async function listWorkspaces(): Promise<Workspace[]> {
  return request<Workspace[]>('/api/workspaces')
}

export async function addWorkspace(body: WorkspaceCreateRequest): Promise<Workspace> {
  return request<Workspace>('/api/workspaces', json('POST', body))
}

export async function removeWorkspace(id: string): Promise<{ removed: string }> {
  return request<{ removed: string }>(`/api/workspaces/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
}

/** Rename a registered workspace (`PATCH /api/workspaces/{id}`). */
export async function renameWorkspace(id: string, name: string): Promise<Workspace> {
  return request<Workspace>(
    `/api/workspaces/${encodeURIComponent(id)}`,
    json('PATCH', { name }),
  )
}

/**
 * Persist the workspace order (`PUT /api/workspaces/order`). `ids` must be an
 * exact permutation of the registered workspace ids; the response carries the
 * workspaces in the new order.
 */
export async function reorderWorkspaces(ids: string[]): Promise<Workspace[]> {
  const body = await request<{ workspaces?: Workspace[] }>(
    '/api/workspaces/order',
    json('PUT', { ids: [...ids] }),
  )
  return Array.isArray(body?.workspaces) ? body.workspaces : []
}

// -- skills, slash commands & workspace files ---------------------------------

/**
 * Discovered skills (`GET /api/skills`). Metadata only — bodies are injected by
 * the server into a run, never served here.
 */
export async function listSkills(): Promise<SkillListResponse> {
  const body = await request<SkillListResponse | SkillInfo[]>('/api/skills')
  if (Array.isArray(body)) return { skills: body, diagnostics: [] }
  return {
    skills: Array.isArray(body?.skills) ? body.skills : [],
    diagnostics: Array.isArray(body?.diagnostics) ? body.diagnostics : [],
  }
}

/** Discovered slash commands and first-party base commands (`GET /api/commands`). */
export async function listCommands(): Promise<CommandListResponse> {
  const body = await request<CommandListResponse | CommandInfo[]>('/api/commands')
  if (Array.isArray(body)) return { commands: body, baseCommands: [], diagnostics: [] }
  const record = (body ?? {}) as Partial<CommandListResponse>
  return {
    commands: Array.isArray(record.commands) ? record.commands : [],
    // additive: an older backend simply does not send base commands
    baseCommands: Array.isArray(record.baseCommands) ? record.baseCommands : [],
    diagnostics: Array.isArray(record.diagnostics) ? record.diagnostics : [],
  }
}

/**
 * Compact one session's context in place (`POST /api/sessions/{name}/compact`).
 * A live run rejects with 409; the response reports whether anything changed.
 */
export async function compactSession(name: string): Promise<SessionCompactResult> {
  const body = await request<Partial<SessionCompactResult>>(
    `/api/sessions/${encodeURIComponent(name)}/compact`,
    { method: 'POST' },
  )
  const record = (body ?? {}) as Partial<SessionCompactResult>
  const result: SessionCompactResult = { compacted: record.compacted === true }
  if (typeof record.before_events === 'number') result.before_events = record.before_events
  if (typeof record.after_events === 'number') result.after_events = record.after_events
  if (typeof record.reason === 'string' && record.reason) result.reason = record.reason
  return result
}

/**
 * Search the files of one registered workspace (`GET /api/workspaces/{id}/files`).
 * `query` is ranked server-side; a missing endpoint (older backend) rejects with
 * an `ApiError` whose status lets callers hide the Files group gracefully.
 */
export async function listWorkspaceFiles(
  workspaceId: string,
  query?: string,
  limit?: number,
): Promise<WorkspaceFileSearchResponse> {
  const q = typeof query === 'string' ? query.trim() : ''
  const suffix = `?limit=${clampFileQueryLimit(limit)}${q ? `&q=${encodeURIComponent(q)}` : ''}`
  const body = await request<Partial<WorkspaceFileSearchResponse> | WorkspaceFileEntry[]>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/files${suffix}`,
  )
  if (Array.isArray(body)) {
    return { workspace_id: workspaceId, files: body, truncated: false, total: body.length }
  }
  return {
    workspace_id: typeof body?.workspace_id === 'string' ? body.workspace_id : workspaceId,
    files: Array.isArray(body?.files) ? body.files : [],
    truncated: body?.truncated === true,
    total:
      typeof body?.total === 'number' && Number.isFinite(body.total) ? body.total : 0,
  }
}

// -- settings ---------------------------------------------------------------

/** Per-role settings patch accepted by `PUT /api/settings`. */
export interface RoleSettingsPatch {
  provider?: string
  model?: string
  base_url?: string
  /** Write-only: the backend stores it and never echoes it back. */
  api_key?: string
  /** Provider preset name supplying base_url/api_key; "" clears it. */
  provider_ref?: string
  /** Model-declared effort token; "" clears it to the provider default. */
  effort?: string
}

/**
 * The shared plugin selection (`plugins` section of GET/PUT /api/settings).
 * One list: every enabled plugin is available to both Senior and Junior
 * (owner decision 2026-11-03).
 */
export type PluginSelection = string[]

/** Legacy per-role plugin selection; read fail-soft and merged. */
export interface LegacyPluginSelection {
  senior?: string[]
  junior?: string[]
}

/** Either selection shape the backend may return (old builds: per-role). */
export type PluginSelectionPayload = PluginSelection | LegacyPluginSelection

/**
 * Normalize either selection shape into the shared list (dedup, order
 * preserved: list order, or senior then junior for the legacy object).
 */
export function normalizePluginSelection(value: unknown): PluginSelection {
  const out: string[] = []
  const add = (item: unknown): void => {
    if (typeof item !== 'string') return
    const name = item.trim()
    if (name && !out.includes(name)) out.push(name)
  }
  if (Array.isArray(value)) {
    value.forEach(add)
  } else if (value !== null && typeof value === 'object') {
    const legacy = value as Record<string, unknown>
    for (const role of ['senior', 'junior'] as const) {
      const list = legacy[role]
      if (Array.isArray(list)) list.forEach(add)
    }
  }
  return out
}

export interface SettingsPatch {
  senior?: RoleSettingsPatch
  junior?: RoleSettingsPatch
  /**
   * Additive dedicated helper route (`subagent` section). Omit on an older
   * backend: the app only sends it when GET reported the section.
   */
  subagent?: RoleSettingsPatch
  /** Omit to leave the persisted plugin selection untouched. */
  plugins?: PluginSelection
  /**
   * Additive operator approval mode (`approval_policy` section). Omit on an
   * older backend: an unknown key is ignored at best, and the section is
   * brand new, so the app only sends it when GET reported support.
   */
  approval_policy?: { mode: ApprovalMode }
  /**
   * Additive run-level compaction budgets (`compaction` section). Omit on an
   * older backend: the app only sends it when GET reported support.
   */
  compaction?: {
    threshold_chars?: number
    threshold_tokens?: number
    keep_recent_chars?: number
    context_window?: number
  }
}

/**
 * `GET/PUT /api/settings` response: role views, the plugin selection and the
 * additive `approval_policy` / `compaction` sections (older backends omit the
 * latter).
 */
export type SettingsResponse = SettingsView & {
  plugins?: PluginSelectionPayload
  approval_policy?: ApprovalPolicyView
  compaction?: CompactionSettingsView
}

export async function getSettings(): Promise<SettingsResponse> {
  return request<SettingsResponse>('/api/settings')
}

export async function updateSettings(patch: SettingsPatch): Promise<SettingsResponse> {
  return request<SettingsResponse>('/api/settings', json('PUT', patch))
}

/**
 * Save role settings together with the shared plugin selection in one PUT.
 * The plugin list is read back after the backend reloads the plugin set.
 */
export async function updateSettingsWithPlugins(
  patch: SettingsPatch & { plugins: PluginSelection },
): Promise<SettingsResponse> {
  return request<SettingsResponse>('/api/settings', json('PUT', patch))
}

// -- plugins ------------------------------------------------------------------

/** One discovered plugin (`GET /api/plugins`); names and descriptions only. */
export interface PluginDescriptor {
  name: string
  description: string
  roles: string[]
}

/** A plugin that failed to load; fail-soft, the rest keep working. */
export interface PluginLoadError {
  plugin: string
  error: string
}

export interface PluginsView {
  plugins: PluginDescriptor[]
  errors: PluginLoadError[]
}

export async function listPlugins(): Promise<PluginsView> {
  const body = await request<Partial<PluginsView>>('/api/plugins')
  return { plugins: body.plugins ?? [], errors: body.errors ?? [] }
}

// -- background runs ----------------------------------------------------------

export async function startRun(body: RunRequest): Promise<RunStart> {
  return request<RunStart>('/api/runs', json('POST', body))
}

/**
 * Lists run records, newest first. Without a session the whole pool is
 * returned; with one, only that session's runs (the backend filters).
 */
export async function listRuns(session?: string | null): Promise<RunRecord[]> {
  const q = session ? `?session=${encodeURIComponent(session)}` : ''
  // tolerate either a bare array or an object wrapping one
  const body = await request<RunRecord[] | { runs?: RunRecord[] }>(`/api/runs${q}`)
  return Array.isArray(body) ? body : (body.runs ?? [])
}

export async function getRun(runId: string): Promise<RunRecord> {
  return request<RunRecord>(`/api/runs/${encodeURIComponent(runId)}`)
}

export async function stopRun(runId: string): Promise<{ run_id: string; status: string }> {
  return request<{ run_id: string; status: string }>(
    `/api/runs/${encodeURIComponent(runId)}/stop`,
    { method: 'POST' },
  )
}

/**
 * Queue one operator steering text on an ACTIVE run (wave 23,
 * `POST /api/runs/{run_id}/steer`).
 *
 * Resolves when the backend accepted the text into the run's bounded pending
 * queue — it is applied at the run's next step, not immediately, and the
 * transcript entry arrives later over the run SSE stream. An empty/oversized
 * text is a 400, an unknown run a 404 and a queued/terminal run or a full
 * pending queue a 409; those reject with an `ApiError` whose `status` and
 * `message` (the backend's detail) are honest.
 */
export async function steerRun(runId: string, text: string): Promise<RunSteerResult> {
  return request<RunSteerResult>(
    `/api/runs/${encodeURIComponent(runId)}/steer`,
    json('POST', { text }),
  )
}

/**
 * Preview the run-scoped workspace undo (wave 23, session-scoped contract:
 * `GET /api/sessions/{name}/undo/{run_id}`): how each file the run mutated
 * would fare if undone now. Read-only — nothing in the workspace changes.
 *
 * A 404 means the session/run has no undo record (or an older backend has no
 * such route at all): the caller hides the action with an honest reason, it
 * never pretends the feature exists. 409 = the record's workspace is not
 * registered / the record is corrupt / an in-memory run owns it; 422 = store
 * error.
 */
export async function previewRunUndo(
  session: string,
  runId: string,
): Promise<RunUndoPreview> {
  const body = await request<unknown>(
    `/api/sessions/${encodeURIComponent(session)}/undo/${encodeURIComponent(runId)}`,
  )
  return normalizeUndoPreview(body) ?? { statuses: [] }
}

/**
 * Apply the run-scoped workspace undo (`POST /api/sessions/{name}/undo/{run_id}`):
 * restores write/edit pre-images, deletes files the run created, and refuses any
 * file whose live content changed since the run. The returned rows carry every
 * file's applied / refused / failed outcome — refused files are never reported
 * as undone (see `runUndo.ts::undoApplyNotice`).
 */
export async function applyRunUndo(
  session: string,
  runId: string,
): Promise<RunUndoApplyResult> {
  const body = await request<unknown>(
    `/api/sessions/${encodeURIComponent(session)}/undo/${encodeURIComponent(runId)}`,
    { method: 'POST' },
  )
  return normalizeUndoApplyResult(body) ?? { applied: 0, refused: 0, failed: 0, files: [] }
}

/**
 * Discard a run's undo record (`DELETE /api/sessions/{name}/undo/{run_id}`):
 * the explicit cleanup step after an apply (or when the operator does not want
 * the recorded history kept). Content-addressed blobs stay for sharing across
 * runs; garbage collection is a later phase.
 */
export async function discardRunUndo(
  session: string,
  runId: string,
): Promise<RunUndoDiscardResult> {
  const body = await request<Partial<RunUndoDiscardResult> | null>(
    `/api/sessions/${encodeURIComponent(session)}/undo/${encodeURIComponent(runId)}`,
    { method: 'DELETE' },
  )
  return {
    discarded: body?.discarded === true,
    session,
    run_id: runId,
  }
}

/** Result of the legacy synchronous `POST /api/run` (replays the whole run). */
export interface RunSyncResult {
  session: string
  events: Envelope[]
  decision?: Record<string, unknown> | null
  errors: string[]
}

/** Legacy synchronous run; prefer `startRun` + the event stream. */
export async function runSync(body: RunRequest): Promise<RunSyncResult> {
  return request<RunSyncResult>('/api/run', json('POST', body))
}

// -- operator approvals -------------------------------------------------------

/**
 * Scope of one operator approval answer: `once` resolves this request only,
 * `session` also remembers its `(action, target)` pair for the rest of the
 * session. Older backends ignore the additive field and answer once.
 */
export type ApprovalScope = 'once' | 'session'

/** The scope a backend actually applied (a missing/unknown field is `once`). */
export type AppliedApprovalScope = 'once' | 'session'

export interface ApprovalAnswerRequestWithScope extends ApprovalAnswerRequest {
  scope?: ApprovalScope
}

export interface ApprovalDecisionResponse extends ApprovalDecisionView {
  /** Additive echo of the applied scope; absent on older backends. */
  scope?: string
}

/**
 * The scope a backend actually applied: only an explicit `scope: "session"`
 * echo counts, so a backend that ignored the field is honestly reported as
 * one-shot. Never infers session scope from a successful response.
 */
export function appliedApprovalScope(
  response: { scope?: unknown } | null | undefined,
): AppliedApprovalScope {
  return response?.scope === 'session' ? 'session' : 'once'
}

/**
 * The honest operator-facing outcome line for one answer, or null when the
 * plain one-shot outcome needs no extra copy. A session request the backend
 * answered one-shot is reported as such instead of pretending it stuck.
 */
export function approvalOutcomeNotice(
  requested: ApprovalScope,
  applied: AppliedApprovalScope,
): string | null {
  if (requested !== 'session') return null
  return applied === 'session'
    ? 'Allowed for this session — identical requests will not ask again.'
    : 'Allowed once — this backend does not support session scope.'
}

export async function getRunApprovals(runId: string): Promise<RunApprovalsView> {
  return request<RunApprovalsView>(`/api/runs/${encodeURIComponent(runId)}/approvals`)
}

export async function answerRunApproval(
  runId: string,
  approvalId: string,
  body: ApprovalAnswerRequestWithScope,
): Promise<ApprovalDecisionResponse> {
  return request<ApprovalDecisionResponse>(
    `/api/runs/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(approvalId)}`,
    json('POST', body),
  )
}

// -- run event stream (SSE) -----------------------------------------------------

/** SSE URL for a run; `after` is the last SSE event id already seen. */
export function runEventsUrl(runId: string, after = 0): string {
  const cursor = Number.isFinite(after) ? Math.max(0, Math.floor(after)) : 0
  return `/api/runs/${encodeURIComponent(runId)}/events?after=${cursor}`
}

export interface RunEventMeta {
  /** SSE event id of this frame (`0` when the frame carried none). */
  eventId: number
  /** Raw JSON text, for callers that log or debug the wire format. */
  raw: string
}

export interface RunEventStreamOptions {
  /** Resume cursor; the server replays every event after it. */
  after?: number
  onEvent: (event: RunEvent, meta: RunEventMeta) => void
  /**
   * Ephemeral live token deltas (named SSE `token` frames). They carry no event
   * id and are not replayed on reconnect, so they never move the cursor.
   */
  onToken?: (event: TokenEvent) => void
  /** Fired when the connection drops or the server closes the stream. */
  onError?: (cause: Event) => void
}

export interface RunEventStream {
  /** Stop the stream and cancel EventSource's own auto-reconnect. */
  close: () => void
  /** Highest SSE event id observed so far (the `?after=N` resume cursor). */
  lastEventId: () => number
}

/**
 * Opens the typed event stream for one run. The server closes the stream
 * after `run_end`, so callers should `close()` in `onError`/on completion and
 * reconnect with a fresh `after` cursor if the run is still active.
 *
 * Live `token` frames arrive as a separate NAMED event (`event: token`), so
 * they are handed to `onToken` without touching the default `message` handler,
 * the `lastEventId` cursor or the reconnect behaviour.
 */
export function openRunEventStream(
  runId: string,
  options: RunEventStreamOptions,
): RunEventStream {
  let last = Number.isFinite(options.after) ? Math.max(0, Math.floor(options.after ?? 0)) : 0
  const source = new EventSource(runEventsUrl(runId, last))
  source.onmessage = (ev: MessageEvent<string>) => {
    const parsed = Number.parseInt(ev.lastEventId, 10)
    if (Number.isFinite(parsed)) last = parsed
    let data: RunEvent
    try {
      data = JSON.parse(ev.data) as RunEvent
    } catch {
      return
    }
    options.onEvent(data, { eventId: Number.isFinite(parsed) ? parsed : last, raw: ev.data })
  }
  /** `event: token` frames are ephemeral; malformed payloads are dropped. */
  const handleToken = (ev: Event): void => {
    if (!options.onToken) return
    let data: unknown
    try {
      data = JSON.parse((ev as MessageEvent<string>).data)
    } catch {
      return
    }
    if (!data || typeof data !== 'object') return
    if (!isTokenEvent(data)) return
    options.onToken(data)
  }
  source.addEventListener('token', handleToken)
  source.onerror = (ev) => options.onError?.(ev)
  return {
    close: () => {
      source.removeEventListener('token', handleToken)
      source.close()
    },
    lastEventId: () => last,
  }
}

/**
 * Legacy session-file envelope stream (`GET /api/stream?session=`) — replays
 * every persisted envelope and then follows the JSONL file. Prefer the run
 * event stream for live runs.
 */
export interface EnvelopeStream {
  close: () => void
}

export function openSessionEnvelopeStream(
  session: string,
  onEnvelope: (envelope: Envelope) => void,
  onError?: (cause: Event) => void,
): EnvelopeStream {
  const source = new EventSource(`/api/stream?session=${encodeURIComponent(session)}`)
  source.onmessage = (ev: MessageEvent<string>) => {
    let envelope: Envelope
    try {
      envelope = JSON.parse(ev.data) as Envelope
    } catch {
      return
    }
    onEnvelope(envelope)
  }
  source.onerror = (ev) => onError?.(ev)
  return { close: () => source.close() }
}

// -- filesystem browsing --------------------------------------------------------

/** List directories at `path` (server cwd when omitted; drive roots on Windows when empty). */
export async function browseFs(path?: string): Promise<FsBrowseResult> {
  const q = path ? `?path=${encodeURIComponent(path)}` : ''
  return request<FsBrowseResult>(`/api/fs/browse${q}`)
}

// -- provider presets -----------------------------------------------------------

export interface ProviderCreateRequest {
  name: string
  base_url: string
  /** Write-only; responses only report `api_key_set`. */
  api_key?: string
  /** Preset flavor; only "openai-compatible" exists today. */
  kind?: string
  models?: string[]
  /** Context window in tokens; 0/absent = unknown. */
  context_window?: number
}

export interface ProviderPatchRequest {
  base_url?: string
  /** Omitted or empty keeps the stored key. */
  api_key?: string
  kind?: string
  models?: string[]
  /** Context window in tokens; 0 clears it (unknown). */
  context_window?: number
}

export async function listProviders(): Promise<ProviderPreset[]> {
  const res = await request<{ providers: ProviderPreset[] }>('/api/providers')
  return res.providers
}

/**
 * The model's own reasoning-effort levels, fetched from the backend catalog
 * (models.dev, cached). A failed/offline lookup returns no efforts — the UI
 * then offers no effort control instead of inventing levels.
 */
export async function getModelEfforts(
  provider: string,
  model: string,
): Promise<ModelEffortInfo> {
  const query = new URLSearchParams({ provider, model }).toString()
  const body = await request<Partial<ModelEffortInfo>>(`/api/model-efforts?${query}`)
  return {
    provider: typeof body?.provider === 'string' ? body.provider : provider,
    model: typeof body?.model === 'string' ? body.model : model,
    reasoning: body?.reasoning === true,
    efforts: Array.isArray(body?.efforts)
      ? body.efforts.filter((value): value is string => typeof value === 'string' && value !== '')
      : [],
    source: typeof body?.source === 'string' ? body.source : 'unavailable',
  }
}

export async function createProvider(body: ProviderCreateRequest): Promise<ProviderPreset> {
  const res = await request<{ provider: ProviderPreset }>('/api/providers', json('POST', body))
  return res.provider
}

export async function updateProvider(
  name: string,
  patch: ProviderPatchRequest,
): Promise<ProviderPreset> {
  const res = await request<{ provider: ProviderPreset }>(
    `/api/providers/${encodeURIComponent(name)}`,
    json('PUT', patch),
  )
  return res.provider
}

/** Restore a customized built-in seed without changing any role provider_ref. */
export async function resetProvider(name: string): Promise<ProviderPreset> {
  const res = await request<{ provider: ProviderPreset }>(
    `/api/providers/${encodeURIComponent(name)}/reset`,
    { method: 'POST' },
  )
  return res.provider
}

export async function deleteProvider(name: string): Promise<{ removed: string }> {
  return request<{ removed: string }>(`/api/providers/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  })
}

/**
 * Draft values for a discovery probe. Every field is optional: omitted values
 * fall back server-side to the stored preset (the key only when `api_key` is
 * empty). The typed key is write-only — this app never sees it again.
 */
export interface ProviderDiscoverRequest {
  base_url?: string
  kind?: string
  api_key?: string
}

/** Raw `POST /api/providers/{name}/discover` body; model entries are normalized by the caller. */
export interface ProviderDiscoverResponse {
  /** Endpoint-reported models (`{id, owned_by?}` objects or bare id strings). */
  models: unknown[]
  /** Additive echo of the endpoint that was actually probed. */
  base_url?: string
  kind?: string
}

/**
 * Probe the CURRENT DRAFT of one provider without saving anything
 * (`POST /api/providers/{name}/discover`). Explicit operator action only: the
 * response is informational, and an empty `models` list is a valid answer.
 */
export async function discoverProviderModels(
  name: string,
  draft: ProviderDiscoverRequest = {},
): Promise<ProviderDiscoverResponse> {
  const body = await request<Partial<ProviderDiscoverResponse> | null>(
    `/api/providers/${encodeURIComponent(name)}/discover`,
    json('POST', draft),
  )
  return {
    models: Array.isArray(body?.models) ? body.models : [],
    ...(typeof body?.base_url === 'string' ? { base_url: body.base_url } : {}),
    ...(typeof body?.kind === 'string' ? { kind: body.kind } : {}),
  }
}
