<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { NConfigProvider, NMessageProvider, darkTheme, lightTheme } from 'naive-ui'
import { darkThemeOverrides, themeOverrides } from './theme'
import {
  applyThemeAttribute,
  nextThemeMode,
  readThemeMode,
  resolveDark,
  saveThemeMode,
  themeModeGlyph,
  themeModeLabel,
} from './themeMode'
import type { ThemeMode } from './themeMode'
import {
  ApiError,
  answerRunApproval,
  createSession,
  getRun,
  getSession,
  getSessionRuntimeEvents,
  listSessions,
  listWorkspaces,
  startRun,
  stopRun,
} from './api'
import type {
  Envelope,
  RunEvent,
  RunMode,
  RunProvider,
  RunRecord,
  RunStatus,
  RunUsage,
  SessionInfo,
  Workspace,
} from './types'
import { projectEnvelopes, sessionTitle, taskOf } from './chat'
import {
  changedFilesOf,
  mergeTimeline,
  projectRuntimeEvents,
  runtimeDedupeKey,
} from './runtime'
import Sidebar from './components/Sidebar.vue'
import ChatView from './components/ChatView.vue'
import Composer from './components/Composer.vue'
import ErrorToast from './components/ErrorToast.vue'
import SettingsDialog from './components/SettingsDialog.vue'
import WorkspaceDialog from './components/WorkspaceDialog.vue'
import NewSessionDialog from './components/NewSessionDialog.vue'
import DiffReview from './components/DiffReview.vue'
import UsageFooter from './components/UsageFooter.vue'

const sessions = ref<SessionInfo[]>([])
const workspaces = ref<Workspace[]>([])
const workspaceFilter = ref<string>('all')
const selected = ref<string | null>(null)
const events = ref<Envelope[]>([])
/** Runtime sidecar events (tool calls, approvals) for the selected session. */
const runtimeEvents = ref<RunEvent[]>([])
const loading = ref(false)
interface LiveRun {
  run_id: string
  session: string
  status: RunStatus
}
/** Every live run known to this app, keyed by session — the backend pool may
 * run several sessions at once. */
const liveRuns = ref<Record<string, LiveRun>>({})
/** The run this app follows: the live run of the selected session, if any.
 * Footer, stop, and the event stream all target this run; runs on other
 * sessions keep running in the background and only appear in liveRuns. */
const activeRun = computed<LiveRun | null>(() =>
  selected.value ? (liveRuns.value[selected.value] ?? null) : null,
)
const stopping = ref(false)
const errors = ref<string[]>([])
/** One submitted run request, retained so a failure can be retried verbatim. */
interface RunRequestState {
  task: string
  mode: RunMode
  provider: RunProvider | null
  session: string | null
  workspace_id: string | null
}
/** Last submitted run, so a live failure can be retried with the exact request. */
const lastRequest = ref<RunRequestState | null>(null)
/** Retry action per session — survives session switches and reloads. */
const retryBySession = ref<Record<string, RunRequestState>>({})
/** Latest failure per session, rendered as an inline error card (G-5). */
const runErrorBySession = ref<Record<string, string | null>>({})
const sidebarCollapsed = ref(false)
/** Latest known per-run usage, keyed by session (from run_end events / run records). */
const runUsageBySession = ref<Record<string, RunUsage | null>>({})
/** When the followed run started working (epoch ms), driving the footer ticker. */
const runStartedAt = ref<number | null>(null)
/** Provider override actually used for sessions started from this app (only known truth). */
const providerBySession = ref<Record<string, RunProvider>>({})
const settingsOpen = ref(false)
/** Bumped on every settings save so mounted children (Composer hint) re-check. */
const settingsVersion = ref(0)

function onSettingsSaved() {
  settingsOpen.value = false
  settingsVersion.value++
}
const workspaceDialogOpen = ref(false)
const newSessionOpen = ref(false)

const items = computed(() => projectEnvelopes(events.value))
const runtimeItems = computed(() => projectRuntimeEvents(runtimeEvents.value))
/** Envelopes and runtime activity interleaved chronologically for the chat view. */
const timeline = computed(() => mergeTimeline(items.value, runtimeItems.value))
/** Files written/edited by tools, feeding the diff review area. */
const changedFiles = computed(() => changedFilesOf(runtimeItems.value))
const title = computed(() => {
  if (!selected.value) return ''
  const info = sessions.value.find((s) => s.name === selected.value)
  return info?.title || sessionTitle(selected.value)
})
const task = computed(() => taskOf(events.value))
/** Operator turns in the selected session: envelopes authored by the user. */
const turns = computed(() => events.value.filter((e) => e.from === 'user').length)
/** Latest known usage for the selected session, if any. */
const usageForSelected = computed(() =>
  selected.value ? (runUsageBySession.value[selected.value] ?? null) : null,
)
/** The followed run is actually working — queued or running, not parked. */
const live = computed(
  () =>
    activeRun.value !== null &&
    (activeRun.value.status === 'running' || activeRun.value.status === 'queued'),
)
/** The followed run is alive (queued, running, or parked on an approval). */
const runActive = computed(
  () =>
    activeRun.value !== null &&
    (activeRun.value.status === 'queued' ||
      activeRun.value.status === 'running' ||
      activeRun.value.status === 'waiting'),
)
/** The followed run is parked on an operator approval (G-1). */
const waiting = computed(() => activeRun.value?.status === 'waiting')
/** True while the followed run is working on the session currently on screen. */
const liveHere = computed(
  () => live.value && activeRun.value !== null && activeRun.value.session === selected.value,
)
/** True while the followed run waits for approval on the session on screen. */
const waitingHere = computed(
  () => waiting.value && activeRun.value !== null && activeRun.value.session === selected.value,
)
const activeProvider = computed(() =>
  selected.value ? providerBySession.value[selected.value] : undefined,
)
/**
 * Short status line for the chat stream while the run works. When the run is
 * parked (`waiting`) this stays null: nothing is working, and the header badge
 * plus the approval banner carry the wait state instead.
 */
const activity = computed(() => {
  if (!live.value) return null
  if (stopping.value) return 'Stopping the run…'
  return activeRun.value?.status === 'queued'
    ? 'Run queued — waiting for the previous run to finish…'
    : 'Senior and Junior are working…'
})
/** Failure text for the selected session's newest run, if it failed (G-5). */
const runError = computed(() =>
  selected.value ? (runErrorBySession.value[selected.value] ?? null) : null,
)
/** Retry action for the selected session, when this app knows the request. */
const retryRequest = computed(() =>
  selected.value ? (retryBySession.value[selected.value] ?? null) : null,
)

const visibleSessions = computed(() =>
  workspaceFilter.value === 'all'
    ? sessions.value
    : sessions.value.filter((s) => s.workspace_id === workspaceFilter.value),
)

// -- run event stream ---------------------------------------------------------
// The backend buffers typed runtime events per run; we resume with ?after=N
// (N = the SSE Last-Event-ID) after a dropped connection.

let es: EventSource | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let sidebarTimer: ReturnType<typeof setInterval> | null = null
/** SSE resume cursor per run, so switching sessions and back resumes where
 * that run's stream left off (`?after=N`). */
let lastEventIdByRun = new Map<string, number>()
let reconnectAttemptsByRun = new Map<string, number>()
/** Highest protocol seq appended to events, per loaded session (dedup on replay). */
let maxSeq = 0
/** Exact runtime-event keys already shown, so sidecar history and live events merge without duplicates. */
let runtimeSeen = new Set<string>()

const MAX_RECONNECTS = 6

function getLastEventId(runId: string): number {
  return lastEventIdByRun.get(runId) ?? 0
}

function setLastEventId(runId: string, n: number) {
  lastEventIdByRun.set(runId, n)
}

function getReconnectAttempts(runId: string): number {
  return reconnectAttemptsByRun.get(runId) ?? 0
}

function setReconnectAttempts(runId: string, n: number) {
  reconnectAttemptsByRun.set(runId, n)
}

function forgetRunStream(runId: string) {
  lastEventIdByRun.delete(runId)
  reconnectAttemptsByRun.delete(runId)
}

function closeStream() {
  es?.close()
  es = null
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
}

function reportError(message: string) {
  errors.value = [...errors.value.filter((e) => e !== message), message].slice(-3)
  window.setTimeout(() => {
    errors.value = errors.value.filter((e) => e !== message)
  }, 12000)
}

function errText(e: unknown): string {
  return e instanceof ApiError ? e.message : String(e)
}

// api.ts has no listRuns yet (backend-owned); same wire format as the rest of
// /api, tolerant of either a bare array or an object wrapping one.
async function listRunsForSession(session: string): Promise<RunRecord[]> {
  const res = await fetch(
    session ? `/api/runs?session=${encodeURIComponent(session)}` : '/api/runs',
  )
  if (!res.ok) return []
  const body = (await res.json()) as RunRecord[] | { runs?: RunRecord[] }
  return Array.isArray(body) ? body : (body.runs ?? [])
}

/** Remember the usage of the session's newest completed run, if the backend
 * reports one; clears a stale entry when the newest run predates usage tracking. */
async function refreshUsageForSession(session: string) {
  if (activeRun.value?.session === session) return
  try {
    const runs = await listRunsForSession(session)
    const completed = runs
      .filter((r) => r.status === 'completed')
      .sort((a, b) => (b.finished || b.created || 0) - (a.finished || a.created || 0))
    const latest = completed[0]
    if (!latest) return
    runUsageBySession.value = { ...runUsageBySession.value, [session]: latest.usage ?? null }
  } catch {
    // usage stats are best-effort; never block session loading on them
  }
}

function setRunError(session: string, message: string) {
  runErrorBySession.value = { ...runErrorBySession.value, [session]: message }
}

function clearRunError(session: string) {
  if (runErrorBySession.value[session] == null) return
  runErrorBySession.value = { ...runErrorBySession.value, [session]: null }
}

function clearRetryAction(session: string) {
  if (!retryBySession.value[session]) return
  const next = { ...retryBySession.value }
  delete next[session]
  retryBySession.value = next
}

/**
 * Surface the selected session's newest run outcome (G-5). The runtime sidecar
 * has no error entry, so the run record is the only source that survives a
 * page reload. Also seeds the Retry action from the failed record's task and
 * mode, so a reloaded failure is retried with its original request; a record
 * without a mode (rebuilt from the sidecar after a backend restart) falls back
 * to `consult`, which performs no workspace mutations.
 */
async function syncRunOutcome(session: string) {
  try {
    const runs = await listRunsForSession(session)
    const latest = [...runs].sort(
      (a, b) => (b.finished || b.created || 0) - (a.finished || a.created || 0),
    )[0]
    if (!latest) return
    if (latest.status === 'failed') {
      setRunError(session, latest.error || runErrorBySession.value[session] || 'Run failed')
      if (!retryBySession.value[session]) {
        retryBySession.value = {
          ...retryBySession.value,
          [session]: {
            task: latest.task,
            // a record rebuilt from the sidecar carries mode "" — never guess
            mode: latest.mode || 'consult',
            provider: providerBySession.value[session] ?? null,
            session,
            workspace_id: null,
          },
        }
      }
    } else if (latest.status === 'completed' || latest.status === 'cancelled') {
      clearRunError(session)
      clearRetryAction(session)
    }
  } catch {
    // the inline error card is best-effort — never block session loading on it
  }
}

function onEnvelope(env: Envelope) {
  if (!activeRun.value || selected.value !== activeRun.value.session) return
  if (env.seq <= maxSeq) return
  maxSeq = env.seq
  events.value = [...events.value, env]
}

/** Append one runtime event, skipping exact duplicates (sidecar vs live replay). */
function ingestRuntimeEvent(ev: RunEvent) {
  const key = runtimeDedupeKey(ev)
  if (runtimeSeen.has(key)) return
  runtimeSeen.add(key)
  runtimeEvents.value = [...runtimeEvents.value, ev]
}

/** Replace the runtime history (session load); later live events merge via dedupe. */
function setRuntimeHistory(list: RunEvent[]) {
  runtimeSeen = new Set(list.map(runtimeDedupeKey))
  runtimeEvents.value = list
}

/** Update one live run in place (immutable write-through to the map). */
function patchLiveRun(runId: string, patch: Partial<LiveRun>) {
  for (const [session, run] of Object.entries(liveRuns.value)) {
    if (run.run_id === runId) {
      liveRuns.value = { ...liveRuns.value, [session]: { ...run, ...patch } }
      return
    }
  }
}

function finalizeRun(runId: string, status: RunStatus, error: string | null) {
  const entry = Object.values(liveRuns.value).find((r) => r.run_id === runId)
  if (!entry) return
  const wasFollowed = entry.session === selected.value
  if (wasFollowed) closeStream()
  const rest = { ...liveRuns.value }
  delete rest[entry.session]
  liveRuns.value = rest
  forgetRunStream(runId)
  if (status === 'failed') {
    // G-5: keep the failure visible after the toast expires (and after reload,
    // via syncRunOutcome); a later successful run clears it again.
    const message = error ?? runErrorBySession.value[entry.session] ?? 'Run failed'
    setRunError(entry.session, message)
    const request = lastRequest.value?.session === entry.session ? lastRequest.value : null
    if (request) {
      retryBySession.value = { ...retryBySession.value, [entry.session]: request }
    }
  } else {
    clearRunError(entry.session)
    clearRetryAction(entry.session)
  }
  if (!wasFollowed) {
    // a background run finished without us watching it: refresh the sidebar
    refreshSessions()
    return
  }
  stopping.value = false
  runStartedAt.value = null
  if (status === 'failed') reportError(error ?? 'Run failed')
  else if (status === 'cancelled') reportError('Run stopped')
  // pick up the persisted usage counters and the run record's error when the
  // stream did not deliver them (reconnect fallback, stop) — best-effort
  getRun(runId)
    .then((rec) => {
      if (rec.usage) {
        runUsageBySession.value = { ...runUsageBySession.value, [entry.session]: rec.usage }
      }
      if (rec.status === 'failed' && rec.error && !runErrorBySession.value[entry.session]) {
        setRunError(entry.session, rec.error)
      }
    })
    .catch(() => undefined)
  // make sure the view holds everything the run persisted (also covers a
  // stream we gave up on) and pick up the derived metadata title
  if (selected.value === entry.session) {
    getSession(entry.session)
      .then((d) => {
        events.value = d.events
        maxSeq = d.events.reduce((m, e) => Math.max(m, e.seq), 0)
      })
      .catch(() => undefined)
    // merge the persisted runtime sidecar; dedupe skips events we already saw live
    getSessionRuntimeEvents(entry.session)
      .then((r) => {
        for (const ev of r.events) ingestRuntimeEvent(ev)
      })
      .catch(() => undefined)
  }
  refreshSessions()
}

function handleRunEvent(runId: string, raw: string, eventId: string) {
  const run = activeRun.value
  if (!run || run.run_id !== runId) return
  setReconnectAttempts(runId, 0)
  if (eventId) setLastEventId(runId, Number(eventId))
  let data: RunEvent
  try {
    data = JSON.parse(raw) as RunEvent
  } catch {
    return
  }
  switch (data.type) {
    case 'run_status':
      if (data.status === 'queued' || data.status === 'running' || data.status === 'waiting') {
        if (data.status === 'running' && run.status === 'queued') {
          // the run actually started working now — restart the elapsed clock
          runStartedAt.value = Date.now()
        }
        patchLiveRun(runId, { status: data.status })
      }
      break
    case 'envelope':
      onEnvelope(data.envelope)
      break
    case 'tool_started':
    case 'tool_completed':
      ingestRuntimeEvent(data)
      break
    case 'prompt_audit':
      // per-call audit row; cheap, and it pairs with nothing
      ingestRuntimeEvent(data)
      break
    case 'approval_requested':
    case 'approval_resolved':
      // the stream mirrors the park and its resolution on run_status
      ingestRuntimeEvent(data)
      break
    case 'run_error':
      setRunError(run.session, String(data.message ?? 'run error'))
      reportError(String(data.message ?? 'run error'))
      break
    case 'run_end':
      if (data.usage) {
        runUsageBySession.value = { ...runUsageBySession.value, [run.session]: data.usage }
      }
      finalizeRun(runId, data.status, runErrorBySession.value[run.session] ?? null)
      break
  }
}

function connectEvents(runId: string) {
  es?.close()
  const source = new EventSource(`/api/runs/${runId}/events?after=${getLastEventId(runId)}`)
  es = source
  source.onmessage = (ev) => handleRunEvent(runId, ev.data, ev.lastEventId)
  source.onerror = () => {
    source.close()
    if (es !== source) return
    es = null
    scheduleReconnect(runId)
  }
}

function scheduleReconnect(runId: string) {
  if (activeRun.value?.run_id !== runId) return
  const attempts = getReconnectAttempts(runId) + 1
  setReconnectAttempts(runId, attempts)
  if (attempts > MAX_RECONNECTS) {
    reportError('Lost the live event stream for this run')
    finalizeRun(runId, 'completed', null)
    return
  }
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    // probe the run state first so we never reconnect to a finished stream
    getRun(runId)
      .then((rec) => {
        // 'waiting' = parked on an operator approval; the stream must go on
        if (rec.status === 'queued' || rec.status === 'running' || rec.status === 'waiting')
          connectEvents(runId)
        else finalizeRun(runId, rec.status, rec.error ?? null)
      })
      .catch(() => connectEvents(runId))
  }, 1200)
}

// -- adopted-run clock ------------------------------------------------------
// A run adopted from the backend (a reload, or a run started in another tab)
// has no local start time; the footer ticker needs one. One record fetch per
// adoption seeds it — the stream only restarts the clock on queued -> running.

/** Seed `runStartedAt` from the run record, once, for the followed run. */
function seedRunStartedAt(runId: string) {
  getRun(runId)
    .then((rec) => {
      const current = activeRun.value
      if (!current || current.run_id !== runId) return
      if (runStartedAt.value === null && rec.started > 0) runStartedAt.value = rec.started * 1000
    })
    .catch(() => undefined)
}

// Follow the run of the selected session: exactly one event stream at a time,
// opened when the followed run appears (started here or discovered live) and
// closed when it ends or the selection moves to another session. Runs on
// other sessions are not streamed; their liveness is tracked by the pool poll
// below, and selecting their session starts following them.
watch(
  () => activeRun.value?.run_id ?? null,
  (runId, prev) => {
    if (prev && prev !== runId) closeStream()
    if (!runId) {
      closeStream()
      return
    }
    setReconnectAttempts(runId, 0)
    connectEvents(runId)
    // a reload can land on a run that is already working — its record is the
    // only place the original start time survives
    seedRunStartedAt(runId)
  },
)

/** Reconcile the live-run map with the backend pool: adopt runs that are
 * active without us following them (another session, or a reload) and drop
 * runs that reached a terminal state while unattended. */
async function refreshLiveRuns() {
  let runs: RunRecord[]
  try {
    runs = await listRunsForSession('')
  } catch {
    return
  }
  const activeBySession = new Map(
    runs
      // 'waiting' = parked on an operator approval; still alive
      .filter((r) => r.status === 'queued' || r.status === 'running' || r.status === 'waiting')
      .map((r) => [r.session, r] as const),
  )
  for (const [session, run] of Object.entries(liveRuns.value)) {
    const known = activeBySession.get(session)
    if (known && known.run_id === run.run_id) {
      // the stream carries the parked state for the run we follow; this poll
      // reconciles runs we are not streaming (other sessions, adopted runs)
      if (known.status !== run.status) patchLiveRun(run.run_id, { status: known.status })
    } else {
      // finished (or replaced) while unattended — fetch the terminal state
      getRun(run.run_id)
        .then((rec) => finalizeRun(run.run_id, rec.status, rec.error ?? null))
        .catch(() => undefined)
    }
  }
  for (const [session, rec] of activeBySession) {
    if (!liveRuns.value[session]) {
      liveRuns.value = {
        ...liveRuns.value,
        [session]: { run_id: rec.run_id, session, status: rec.status },
      }
    }
  }
}

// -- data loading ---------------------------------------------------------

async function refreshSessions(silent = true) {
  try {
    sessions.value = await listSessions()
  } catch (e) {
    if (!silent || errors.value.length === 0) reportError(errText(e))
  }
}

async function refreshWorkspaces(silent = true) {
  try {
    workspaces.value = await listWorkspaces()
  } catch (e) {
    if (!silent || errors.value.length === 0) reportError(errText(e))
  }
}

async function loadSession(name: string) {
  loading.value = true
  try {
    const [detail, runtime] = await Promise.all([
      getSession(name),
      getSessionRuntimeEvents(name).catch(() => ({ name, events: [] as RunEvent[] })),
    ])
    events.value = detail.events
    maxSeq = detail.events.reduce((m, e) => Math.max(m, e.seq), 0)
    setRuntimeHistory(runtime.events)
    selected.value = name
    errors.value = []
    refreshUsageForSession(name)
    // the run record is the only place a failure survives a reload (G-5)
    syncRunOutcome(name)
  } catch (e) {
    reportError(errText(e))
  } finally {
    loading.value = false
  }
}

// -- actions ---------------------------------------------------------------

async function startNewRun(payload: {
  task: string
  mode: RunMode
  provider: RunProvider | null
}) {
  if (activeRun.value) return // the target session already has a live run
  errors.value = []
  const request: RunRequestState = {
    ...payload,
    session: selected.value,
    workspace_id: workspaceFilter.value === 'all' ? null : workspaceFilter.value,
  }
  lastRequest.value = request
  try {
    const res = await startRun({
      task: request.task,
      mode: request.mode,
      provider: request.provider,
      session: request.session,
      workspace_id: request.workspace_id,
    })
    liveRuns.value = {
      ...liveRuns.value,
      [res.session]: { run_id: res.run_id, session: res.session, status: res.status },
    }
    setLastEventId(res.run_id, 0)
    setReconnectAttempts(res.run_id, 0)
    stopping.value = false
    runStartedAt.value = Date.now()
    // a new attempt supersedes the previous failure and its error card
    clearRunError(res.session)
    clearRetryAction(res.session)
    if (res.session !== selected.value) {
      // a fresh session: the stream will replay everything from the start
      selected.value = res.session
      events.value = []
      maxSeq = 0
      setRuntimeHistory([])
    }
    if (payload.provider) {
      providerBySession.value = { ...providerBySession.value, [res.session]: payload.provider }
    }
    // the activeRun watcher opens the event stream for the new run
    refreshSessions()
  } catch (e) {
    reportError(errText(e))
  }
}

/** Retry the selected session's failed run (the inline error card's action). */
async function retryLastRun() {
  const request = retryRequest.value
  if (!request || runActive.value) return
  if (request.session && request.session !== selected.value) selected.value = request.session
  if (request.workspace_id) workspaceFilter.value = request.workspace_id
  await startNewRun({ task: request.task, mode: request.mode, provider: request.provider })
}

/** Answer a pending approval; the card flips when the approval_resolved event
 * arrives on the run stream (or is recorded locally when we are not following
 * that run — e.g. answering from a reopened session). */
async function resolveApproval(
  runId: string,
  approvalId: string,
  allow: boolean,
): Promise<boolean> {
  try {
    await answerRunApproval(runId, approvalId, { allow })
  } catch (e) {
    reportError(errText(e))
    return false
  }
  const followed = activeRun.value
  if (!followed || followed.run_id !== runId) {
    // not following that run (e.g. answering from a reopened session): record
    // the resolution locally so the card flips
    ingestRuntimeEvent({
      type: 'approval_resolved',
      approval_id: approvalId,
      decision: allow ? 'allow' : 'deny',
      run_id: runId,
      at: Math.floor(Date.now() / 1000),
    })
  } else if (followed.status === 'waiting') {
    // optimistic: the run resumes as soon as the backend accepts the decision;
    // the stream's next run_status re-parks it if another approval shows up
    patchLiveRun(runId, { status: 'running' })
  }
  return true
}

async function requestStop() {
  const run = activeRun.value
  if (!run || stopping.value) return
  stopping.value = true
  try {
    const res = await stopRun(run.run_id)
    // a queued run is cancelled immediately; a running run unwinds and the
    // run_end event finishes the flow
    if (res.status === 'cancelled') finalizeRun(run.run_id, 'cancelled', null)
  } catch (e) {
    stopping.value = false
    reportError(errText(e))
  }
}

/** Workspace dialog closed (created or cancelled): re-list so the sidebar filter and
 * the New Session dialog see the latest workspaces without a page reload. */
function onWorkspaceDialogClose() {
  workspaceDialogOpen.value = false
  refreshWorkspaces()
}

/** Sidebar deleted a session: drop the selection/view state if it was open, then re-list. */
function onSessionDeleted(name: string) {
  if (selected.value === name) {
    selected.value = null
    events.value = []
    setRuntimeHistory([])
  }
  const rest = { ...runUsageBySession.value }
  delete rest[name]
  runUsageBySession.value = rest
  clearRunError(name)
  clearRetryAction(name)
  refreshSessions()
}

async function onCreateSession(payload: { title: string; workspace_id: string | null }) {
  try {
    const created = await createSession({
      title: payload.title || undefined,
      workspace_id: payload.workspace_id ?? undefined,
    })
    newSessionOpen.value = false
    await refreshSessions()
    await loadSession(created.name)
  } catch (e) {
    reportError(errText(e))
  }
}

/** Bring the pending approval card into view and focus it (banner action). */
function focusApproval() {
  const pending = runtimeItems.value.find(
    (item) => item.type === 'approval' && item.decision === undefined,
  )
  if (!pending || pending.type !== 'approval') return
  const el = document.querySelector<HTMLElement>(
    `[data-approval-id="${CSS.escape(pending.approvalId)}"]`,
  )
  if (!el) return
  el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  el.focus({ preventScroll: true })
}

// -- theme mode ---------------------------------------------------------------
// The OS scheme drives the design tokens in style.css by default. The header
// toggle pins light/dark by writing `data-theme` on <html>, or returns to
// 'system' (attribute removed, media query authoritative); the choice is
// persisted in localStorage, and naive-ui's theme follows `isDark`.
const schemeQuery = window.matchMedia('(prefers-color-scheme: dark)')
const systemDark = ref(schemeQuery.matches)
const themeMode = ref<ThemeMode>(readThemeMode())
const isDark = computed(() => resolveDark(themeMode.value, systemDark.value))
const themeModeText = computed(
  () => `Theme: ${themeModeLabel(themeMode.value)} — click to switch`,
)
const themeModeIcon = computed(() => themeModeGlyph(themeMode.value))

function syncTheme() {
  applyThemeAttribute(themeMode.value, isDark.value)
}

function onSchemeChange(e: MediaQueryListEvent) {
  systemDark.value = e.matches
}

function cycleTheme() {
  themeMode.value = nextThemeMode(themeMode.value)
  saveThemeMode(themeMode.value)
}

// apply before the first paint so a pinned scheme does not flash the OS one
syncTheme()
watch([themeMode, isDark], syncTheme)

onMounted(() => {
  schemeQuery.addEventListener('change', onSchemeChange)
  refreshSessions(false)
  refreshWorkspaces(false)
  refreshLiveRuns()
  sidebarTimer = setInterval(() => {
    refreshSessions()
    refreshLiveRuns()
  }, 5000)
})

onUnmounted(() => {
  schemeQuery.removeEventListener('change', onSchemeChange)
  if (sidebarTimer) clearInterval(sidebarTimer)
  if (reconnectTimer) clearTimeout(reconnectTimer)
  es?.close()
})
</script>

<template>
  <n-config-provider
    :theme="isDark ? darkTheme : lightTheme"
    :theme-overrides="isDark ? darkThemeOverrides : themeOverrides"
  >
    <n-message-provider>
    <div class="workspace" :class="{ 'sidebar-collapsed': sidebarCollapsed }">
    <Sidebar
      v-if="!sidebarCollapsed"
      :sessions="visibleSessions"
      :workspaces="workspaces"
      :workspace-filter="workspaceFilter"
      :selected="selected"
      :live="runActive && activeRun ? activeRun.session : null"
      :live-sessions="Object.keys(liveRuns)"
      @select="loadSession"
      @refresh="refreshSessions(false)"
      @collapse="sidebarCollapsed = true"
      @add-workspace="workspaceDialogOpen = true"
      @new-session="newSessionOpen = true"
      @filter-workspace="workspaceFilter = $event"
      @deleted="onSessionDeleted"
    />
    <button
      v-else
      class="icon-btn sidebar-expand"
      title="Expand sidebar"
      aria-label="Expand sidebar"
      @click="sidebarCollapsed = false"
    >
      <span aria-hidden="true">⇥</span>
    </button>

    <button
      v-if="!sidebarCollapsed"
      class="sidebar-backdrop"
      aria-label="Hide sessions"
      tabindex="-1"
      @click="sidebarCollapsed = true"
    ></button>

    <div class="chat-shell">
      <header class="chat-header">
        <div class="chat-title-block">
          <h1 v-if="selected" class="chat-title">{{ title }}</h1>
          <h1 v-else class="chat-title muted">Two Brothers</h1>
          <p v-if="task" class="chat-task muted">{{ task }}</p>
        </div>
        <div class="chat-header-side">
          <div class="participants" aria-label="Participants">
            <span class="participant"><span class="dot dot-senior" aria-hidden="true"></span>Senior</span>
            <span class="participant-sep" aria-hidden="true">×</span>
            <span class="participant"><span class="dot dot-junior" aria-hidden="true"></span>Junior</span>
          </div>
          <span v-if="activeProvider" class="provider-chip">{{ activeProvider }}</span>
          <span v-if="live && activeRun?.status === 'queued'" class="provider-chip">queued</span>
          <span v-if="live && activeRun?.status === 'running'" class="live-badge">live</span>
          <span v-if="waiting" class="approval-badge" role="status">awaiting approval</span>
          <button
            class="icon-btn"
            :title="themeModeText"
            :aria-label="themeModeText"
            @click="cycleTheme"
          >
            <span aria-hidden="true">{{ themeModeIcon }}</span>
          </button>
          <button
            class="icon-btn"
            title="Model settings"
            aria-label="Model settings"
            @click="settingsOpen = true"
          >
            <span aria-hidden="true">⚙</span>
          </button>
        </div>
      </header>

      <div v-if="waiting" class="approval-banner" role="alert">
        <span class="approval-banner-dot" aria-hidden="true"></span>
        <p class="approval-banner-text">
          <strong>Waiting for your approval.</strong>
          The run is paused until you allow or deny the request in the conversation.
        </p>
        <button type="button" class="approval-banner-action" @click="focusApproval">
          Review request
        </button>
      </div>

      <ChatView
        v-if="selected"
        :key="selected"
        :timeline="timeline"
        :loading="loading"
        :activity="activity"
        :resolve-approval="resolveApproval"
        :run-error="runError"
        :on-retry="retryLastRun"
      />
      <div v-else class="chat-scroll welcome">
        <div class="welcome-card">
          <h2>Two Brothers workspace</h2>
          <p class="muted">
            A group chat between you (the operator), the Senior and the Junior. Pick a session on
            the left, start a new one, or send a task below to begin a run.
          </p>
        </div>
      </div>

      <DiffReview v-if="selected && changedFiles.length" :files="changedFiles" />

      <UsageFooter
        :live="liveHere"
        :waiting="waitingHere"
        :started-at="runStartedAt"
        :turns="turns"
        :usage="usageForSelected"
      />
      <Composer
        :busy="live"
        :waiting="waiting"
        :stopping="stopping"
        :settings-version="settingsVersion"
        @submit="startNewRun"
        @stop="requestStop"
        @open-settings="settingsOpen = true"
      />
    </div>

    <ErrorToast :messages="errors" @dismiss="(i) => errors.splice(i, 1)" />

    <SettingsDialog
      v-if="settingsOpen"
      @close="settingsOpen = false"
      @saved="onSettingsSaved"
    />
    <WorkspaceDialog v-if="workspaceDialogOpen" @close="onWorkspaceDialogClose" />
    <NewSessionDialog
      v-if="newSessionOpen"
      :workspaces="workspaces"
      :default-workspace="workspaceFilter !== 'all' ? workspaceFilter : null"
      @close="newSessionOpen = false"
      @create="onCreateSession"
    />
    </div>
    </n-message-provider>
  </n-config-provider>
</template>
