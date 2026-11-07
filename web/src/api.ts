import type {
  ApprovalAnswerRequest,
  ApprovalDecisionView,
  ApprovalMode,
  ApprovalPolicyView,
  CommandInfo,
  CommandListResponse,
  Envelope,
  FsBrowseResult,
  ProviderPreset,
  RunApprovalsView,
  RunEvent,
  RunRecord,
  RunRequest,
  RunStart,
  SearchResult,
  SessionCreateRequest,
  SessionCompactResult,
  SessionDetail,
  SessionExportFormat,
  SessionInfo,
  SessionRuntimeEvents,
  SettingsView,
  SkillInfo,
  SkillListResponse,
  TokenEvent,
  Workspace,
  WorkspaceCreateRequest,
  WorkspaceFileEntry,
  WorkspaceFileSearchResponse,
} from './types'
import { clampSearchLimit } from './search'
import { clampFileQueryLimit } from './mentions'
import { isTokenEvent } from './streaming'

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
  /** Omit to leave the persisted plugin selection untouched. */
  plugins?: PluginSelection
  /**
   * Additive operator approval mode (`approval_policy` section). Omit on an
   * older backend: an unknown key is ignored at best, and the section is
   * brand new, so the app only sends it when GET reported support.
   */
  approval_policy?: { mode: ApprovalMode }
}

/**
 * `GET/PUT /api/settings` response: role views, the plugin selection and the
 * additive `approval_policy` section (older backends omit the latter).
 */
export type SettingsResponse = SettingsView & {
  plugins?: PluginSelectionPayload
  approval_policy?: ApprovalPolicyView
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
}

export interface ProviderPatchRequest {
  base_url?: string
  /** Omitted or empty keeps the stored key. */
  api_key?: string
  kind?: string
  models?: string[]
}

export async function listProviders(): Promise<ProviderPreset[]> {
  const res = await request<{ providers: ProviderPreset[] }>('/api/providers')
  return res.providers
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
