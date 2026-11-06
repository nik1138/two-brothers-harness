<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { NConfigProvider, NMessageProvider, darkTheme, lightTheme } from 'naive-ui'
import { darkThemeOverrides, themeOverrides } from './theme'
import {
  applyThemeAttribute,
  readThemeMode,
  resolveDark,
  saveThemeMode,
} from './themeMode'
import type { ThemeMode } from './themeMode'
import { applyDensityAttribute, readDensity, saveDensity } from './density'
import type { Density } from './density'
import {
  ApiError,
  answerRunApproval,
  createSession,
  getRun,
  getSession,
  getSessionRuntimeEvents,
  getSettings,
  listSessions,
  listWorkspaces,
  reorderWorkspaces,
  startRun,
  stopRun,
} from './api'
import type {
  Envelope,
  RoleSettingsView,
  RunEvent,
  RunMode,
  RunProvider,
  RunRecord,
  RunStatus,
  RunUsage,
  SessionInfo,
  SettingsView,
  Workspace,
} from './types'
import { projectEnvelopes, sessionTitle, taskOf } from './chat'
import { buildPaletteItems, PALETTE_SESSION_PREFIX, PALETTE_WORKSPACE_PREFIX } from './palette'
import type { PaletteItem } from './palette'
import { contentItemSession } from './search'
import { isSameOrder, moveWorkspaceId } from './workspaceOrder'
import {
  changedFilesOf,
  mergeTimeline,
  projectRuntimeEvents,
  runtimeDedupeKey,
} from './runtime'
import type { ApprovalItem } from './runtime'
import {
  deriveSessionStatus,
  loadLastSeen,
  markSessionSeen,
  pruneLastSeen,
  saveLastSeen,
} from './sessionStatus'
import type { LastSeenMap, SessionStatusView } from './sessionStatus'
import {
  pruneRecentWorkspaces,
  pushRecentWorkspace,
  readRecentWorkspaces,
  recordRecentWorkspace,
} from './recents'
import Sidebar from './components/Sidebar.vue'
import ChatView from './components/ChatView.vue'
import Composer from './components/Composer.vue'
import ErrorToast from './components/ErrorToast.vue'
import SettingsDialog from './components/SettingsDialog.vue'
import WorkspaceDialog from './components/WorkspaceDialog.vue'
import WorkspaceRenameDialog from './components/WorkspaceRenameDialog.vue'
import NewSessionDialog from './components/NewSessionDialog.vue'
import DiffReview from './components/DiffReview.vue'
import ApprovalCard from './components/ApprovalCard.vue'
import UsageFooter from './components/UsageFooter.vue'
import CommandPalette from './components/CommandPalette.vue'
import AppIcon from './components/AppIcon.vue'

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
/** Task text of a start request that never became a run; the composer puts it
 * back (the token makes every failure a distinct restore trigger). */
const draftRestore = ref<{ token: number; text: string } | null>(null)
/** Retry action per session — survives session switches and reloads. */
const retryBySession = ref<Record<string, RunRequestState>>({})
/** Latest failure per session, rendered as an inline error card (G-5). */
const runErrorBySession = ref<Record<string, string | null>>({})
/** Below the drawer breakpoint the sidebar starts closed; it opens as an
 * accessible drawer (backdrop, Escape, focus/inert handling) over the chat. */
const MOBILE_DRAWER_QUERY = '(max-width: 768px)'
const drawerQuery =
  typeof window === 'undefined' ? null : window.matchMedia(MOBILE_DRAWER_QUERY)
const sidebarCollapsed = ref<boolean>(drawerQuery?.matches ?? false)
/** Latest known per-run usage, keyed by session (from run_end events / run records). */
const runUsageBySession = ref<Record<string, RunUsage | null>>({})
/** Newest known run record per session; terminal state survives a reload via the 5 s pool poll. */
interface LastRunInfo {
  status: RunStatus
  created: number
  finished: number
  error?: string
}
const lastRunBySession = ref<Record<string, LastRunInfo>>({})
/** Operator's last-open stamps, persisted so unread dots survive a reload. */
const lastSeen = ref<LastSeenMap>(loadLastSeen())
/** MRU workspace ids (persisted); `recentWorkspaces` resolves them against the live list. */
const recentWorkspaceIds = ref<string[]>(readRecentWorkspaces())
/** When the followed run started working (epoch ms), driving the footer ticker. */
const runStartedAt = ref<number | null>(null)
/** Provider override actually used for sessions started from this app (only known truth). */
const providerBySession = ref<Record<string, RunProvider>>({})
const settingsOpen = ref(false)
/** Bumped on every settings save so mounted children (Composer hint) re-check. */
const settingsVersion = ref(0)
/**
 * Settings snapshot for the first-run onboarding hint. One probe on mount plus
 * one after a save — no polling. `unknown` means the probe failed, so the hint
 * stays hidden rather than guessing.
 */
const settings = ref<SettingsView | null>(null)
const settingsState = ref<'loading' | 'ready' | 'unknown'>('loading')
let settingsRequest = 0
/** Dismissal is intentionally in-memory only: it lasts for this page session. */
const onboardingDismissed = ref(false)

function onSettingsSaved() {
  settingsOpen.value = false
  settingsVersion.value++
}
const workspaceDialogOpen = ref(false)
const newSessionOpen = ref(false)
/** Workspace whose rename dialog is open (null = closed). */
const renameWorkspaceTarget = ref<Workspace | null>(null)
/** A workspace reorder is in flight; blocks a second optimistic order change. */
const workspaceMoving = ref(false)

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
/** The selected session's unanswered approval, if any — docked above the
 * composer so Allow/Deny stay visible and clickable without scrolling. */
const pendingApproval = computed<ApprovalItem | null>(() => {
  for (const item of runtimeItems.value) {
    if (item.type === 'approval' && item.decision === undefined) return item
  }
  return null
})
/** Retry action for the selected session, when this app knows the request. */
const retryRequest = computed(() =>
  selected.value ? (retryBySession.value[selected.value] ?? null) : null,
)

const visibleSessions = computed(() =>
  workspaceFilter.value === 'all'
    ? sessions.value
    : sessions.value.filter((s) => s.workspace_id === workspaceFilter.value),
)

/** Recent workspaces that still exist, newest first (the finder/dialog quick picks). */
const recentWorkspaces = computed<Workspace[]>(() => {
  const byId = new Map(workspaces.value.map((workspace) => [workspace.id, workspace]))
  const out: Workspace[] = []
  for (const id of recentWorkspaceIds.value) {
    const workspace = byId.get(id)
    if (workspace) out.push(workspace)
  }
  return out
})

/**
 * One row state per session, derived from state the shell already owns: the
 * live-run pool, the newest run record, in-memory errors/retries, and the
 * persisted last-open stamps. Pure — `deriveSessionStatus` owns the precedence.
 */
const sessionStatuses = computed<Record<string, SessionStatusView>>(() => {
  const out: Record<string, SessionStatusView> = {}
  for (const session of sessions.value) {
    const live = liveRuns.value[session.name] ?? null
    const record = lastRunBySession.value[session.name] ?? null
    // a retry seeded from a reloaded failure is itself evidence the last run failed
    const retryPending = Boolean(retryBySession.value[session.name])
    out[session.name] = deriveSessionStatus({
      liveStatus: live?.status ?? null,
      lastRun: record ?? (retryPending ? { status: 'failed', finished: 0 } : null),
      lastSeen: lastSeen.value[session.name] ?? null,
      active: session.name === selected.value,
      error: runErrorBySession.value[session.name] ?? null,
    })
  }
  return out
})

/** A saved role route that can actually start a run — the Composer's rule. */
function roleConfigured(view: RoleSettingsView | undefined): boolean {
  if (!view) return false
  const provider = view.provider?.trim() || null
  const model = view.model?.trim() || null
  const baseUrl = view.base_url?.trim() || null
  return provider === 'mock' || Boolean(model && baseUrl)
}

const modelsUsable = computed(() => {
  const view = settings.value
  return Boolean(view && roleConfigured(view.senior) && roleConfigured(view.junior))
})

/** One inline first-run hint: settings loaded and at least one role unusable. */
const showOnboardingHint = computed(
  () => settingsState.value === 'ready' && !modelsUsable.value && !onboardingDismissed.value,
)

// -- command palette (Ctrl+K / Cmd+K) ------------------------------------------
// Keyboard-first navigation: sessions, workspaces and app actions in one
// scored list. Items are rebuilt reactively from the current lists;
// CommandPalette.vue owns filtering, highlighting and the aria wiring.

/** Static app actions offered by the palette; the id is the dispatch key. */
const PALETTE_ACTIONS: PaletteItem[] = [
  {
    id: 'action:new-session',
    kind: 'action',
    label: 'New session',
    hint: 'Start a new chat',
    keywords: ['create', 'start', 'chat', 'session'],
  },
  {
    id: 'action:new-workspace',
    kind: 'action',
    label: 'New workspace',
    hint: 'Link a folder',
    keywords: ['create', 'add', 'folder', 'link', 'workspace'],
  },
  {
    id: 'action:settings',
    kind: 'action',
    label: 'Settings',
    hint: 'Roles, providers, appearance',
    keywords: ['preferences', 'config', 'provider', 'model', 'roles'],
  },
  {
    id: 'action:focus-composer',
    kind: 'action',
    label: 'Focus composer',
    hint: 'Skip straight to the task box',
    keywords: ['skip', 'composer', 'task', 'type', 'message', 'jump'],
  },
  {
    id: 'action:theme-light',
    kind: 'action',
    label: 'Theme: Light',
    hint: 'Appearance',
    keywords: ['appearance', 'color', 'scheme', 'light theme', 'day'],
  },
  {
    id: 'action:theme-dark',
    kind: 'action',
    label: 'Theme: Dark',
    hint: 'Appearance',
    keywords: ['appearance', 'color', 'scheme', 'dark theme', 'night'],
  },
  {
    id: 'action:theme-system',
    kind: 'action',
    label: 'Theme: System',
    hint: 'Appearance',
    keywords: ['appearance', 'color', 'scheme', 'auto', 'os'],
  },
  {
    id: 'action:toggle-sidebar',
    kind: 'action',
    label: 'Toggle sidebar',
    hint: 'Layout',
    keywords: ['hide', 'show', 'sessions', 'drawer', 'collapse', 'panel'],
  },
  {
    id: 'action:refresh-sessions',
    kind: 'action',
    label: 'Refresh sessions',
    hint: 'Reload the sidebar list',
    keywords: ['reload', 'update', 'list', 'sessions'],
  },
]

const paletteOpen = ref(false)
/** Shortcut label for the header affordance; the chord itself always works. */
const paletteShortcut = /Mac|iPhone|iPad|iPod/i.test(navigator.platform) ? '⌘ K' : 'Ctrl K'
/** Persisted spacing preference (Comfortable by default); applied as data-density. */
const density = ref<Density>(readDensity())

/** Density is exposed from the palette and from Settings → Appearance; the
 * hint marks the active mode. */
const densityPaletteActions = computed<PaletteItem[]>(() =>
  (['compact', 'comfortable'] as const).map((value) => ({
    id: `action:density-${value}`,
    kind: 'action' as const,
    label: `Density: ${value === 'compact' ? 'Compact' : 'Comfortable'}`,
    hint:
      density.value === value
        ? 'Current density'
        : value === 'compact'
          ? 'Tighter rows'
          : 'Default spacing',
    keywords:
      value === 'compact'
        ? ['density', 'spacing', 'rows', 'appearance', 'compact', 'tight', 'dense']
        : ['density', 'spacing', 'rows', 'appearance', 'comfortable', 'default', 'roomy'],
  })),
)

/** Rebuilt whenever sessions/workspaces change; cheap (pure array building). */
const paletteItems = computed(() =>
  buildPaletteItems({
    sessions: sessions.value,
    workspaces: workspaces.value,
    actions: [...PALETTE_ACTIONS, ...densityPaletteActions.value],
  }),
)

/** Global shortcut: toggle the palette, but never from inside it (double-toggle). */
function onPaletteShortcut(e: KeyboardEvent) {
  if (e.defaultPrevented || e.isComposing || e.repeat) return
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return
  if (e.key.toLowerCase() !== 'k') return
  const target = e.target instanceof Element ? e.target : null
  if (target?.closest('[data-command-palette]')) return
  e.preventDefault()
  paletteOpen.value = !paletteOpen.value
}

/** Dispatch one palette selection; the palette is already closed by then. */
function onPaletteSelect(item: PaletteItem) {
  paletteOpen.value = false
  switch (item.kind) {
    case 'session': {
      const name = item.id.startsWith(PALETTE_SESSION_PREFIX)
        ? item.id.slice(PALETTE_SESSION_PREFIX.length)
        : ''
      // loadSession closes the mobile drawer exactly like a sidebar pick
      if (name) void loadSession(name)
      return
    }
    case 'content': {
      // a message hit opens the session it belongs to (exact-message scroll is
      // intentionally out of scope — one clean jump is enough)
      const name = contentItemSession(item)
      if (name) void loadSession(name)
      return
    }
    case 'workspace': {
      const id = item.id.startsWith(PALETTE_WORKSPACE_PREFIX)
        ? item.id.slice(PALETTE_WORKSPACE_PREFIX.length)
        : ''
      if (!id) return
      onFilterWorkspace(id)
      // a workspace pick dismisses the drawer, like a session pick
      if (drawerQuery?.matches && !sidebarCollapsed.value) sidebarCollapsed.value = true
      return
    }
    case 'action':
      runPaletteAction(item.id)
      return
  }
}

function runPaletteAction(id: string) {
  switch (id) {
    case 'action:new-session':
      newSessionOpen.value = true
      break
    case 'action:new-workspace':
      workspaceDialogOpen.value = true
      break
    case 'action:settings':
      settingsOpen.value = true
      break
    case 'action:focus-composer':
      skipToComposer()
      break
    case 'action:density-compact':
      setDensity('compact')
      break
    case 'action:density-comfortable':
      setDensity('comfortable')
      break
    case 'action:theme-light':
      onThemeChange('light')
      break
    case 'action:theme-dark':
      onThemeChange('dark')
      break
    case 'action:theme-system':
      onThemeChange('system')
      break
    case 'action:toggle-sidebar':
      sidebarCollapsed.value = !sidebarCollapsed.value
      break
    case 'action:refresh-sessions':
      void refreshSessions(false)
      break
  }
}

/**
 * Skip-to-composer, shared by the skip link (first focusable element) and the
 * palette action. The focus move waits one tick so the palette's modal has
 * deactivated its focus trap — otherwise the trap would pull focus back.
 */
function focusComposer() {
  const el = document.getElementById('composer-input')
  if (!(el instanceof HTMLTextAreaElement)) return
  el.scrollIntoView({ block: 'nearest' })
  el.focus({ preventScroll: true })
}

function skipToComposer() {
  if (paletteOpen.value) paletteOpen.value = false
  void nextTick(focusComposer)
}

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
    recordLastRun(latest)
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
  // the operator watched this run end — it is read, not "unread" on the next switch
  markSeen(entry.session)
  stopping.value = false
  runStartedAt.value = null
  if (status === 'failed') reportError(error ?? 'Run failed')
  else if (status === 'cancelled') reportError('Run stopped')
  // pick up the persisted usage counters and the run record's error when the
  // stream did not deliver them (reconnect fallback, stop) — best-effort
  getRun(runId)
    .then((rec) => {
      // the record carries the authoritative finished timestamp for unread
      recordLastRun(rec)
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
        // the terminal record is also the source of the unread timestamp
        recordLastRun(rec)
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
  // keep the per-session newest-record map current for the sidebar statuses
  for (const rec of runs) recordLastRun(rec)
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
        .then((rec) => {
          recordLastRun(rec)
          finalizeRun(run.run_id, rec.status, rec.error ?? null)
        })
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

/** Probe settings once (mount) and after each save; no polling is involved. */
async function probeSettings() {
  const request = ++settingsRequest
  try {
    const next = await getSettings()
    if (request !== settingsRequest) return
    settings.value = next
    settingsState.value = 'ready'
  } catch {
    if (request !== settingsRequest) return
    settings.value = null
    settingsState.value = 'unknown'
  }
}

/** Mark one session read at `now`, persisting the bounded stamp map. */
function markSeen(name: string | null) {
  if (!name) return
  const next = markSessionSeen(name, lastSeen.value)
  if (next === lastSeen.value) return
  lastSeen.value = next
  saveLastSeen(next)
}

/** Drop stamps for sessions the backend no longer lists (deleted sessions). */
function pruneSeen(validNames: string[]) {
  const next = pruneLastSeen(lastSeen.value, validNames)
  if (next === lastSeen.value) return
  lastSeen.value = next
  saveLastSeen(next)
}

/** Track the newest run record per session, ignoring out-of-order responses. */
function recordLastRun(run: RunRecord) {
  const stamp = run.finished || run.created || 0
  const prev = lastRunBySession.value[run.session]
  const prevStamp = prev ? prev.finished || prev.created || 0 : -1
  if (prev && stamp < prevStamp) return
  lastRunBySession.value = {
    ...lastRunBySession.value,
    [run.session]: {
      status: run.status,
      created: run.created,
      finished: run.finished,
      error: run.error,
    },
  }
}

/** Drop cached run outcomes for sessions that no longer exist. */
function pruneLastRuns(validNames: string[]) {
  const valid = new Set(validNames)
  const keys = Object.keys(lastRunBySession.value)
  if (keys.every((key) => valid.has(key))) return
  const next: Record<string, LastRunInfo> = {}
  for (const key of keys) {
    if (valid.has(key)) next[key] = lastRunBySession.value[key]
  }
  lastRunBySession.value = next
}

/** Record a workspace selection in the persisted MRU list (memory survives blocked storage). */
function noteRecentWorkspace(id: string | null | undefined) {
  const value = typeof id === 'string' ? id.trim() : ''
  if (!value) return
  const stored = recordRecentWorkspace(value)
  recentWorkspaceIds.value = stored.length
    ? stored
    : pushRecentWorkspace(recentWorkspaceIds.value, value)
}

/** Drop recent ids the backend no longer lists, preserving MRU order. */
function pruneRecents(validIds: string[]) {
  recentWorkspaceIds.value = pruneRecentWorkspaces(recentWorkspaceIds.value, validIds)
}

/** Sidebar/palette workspace filter: a real workspace pick becomes recent. */
function onFilterWorkspace(id: string) {
  workspaceFilter.value = id
  if (id !== 'all') noteRecentWorkspace(id)
}

async function refreshSessions(silent = true) {
  try {
    const next = await listSessions()
    sessions.value = next
    const names = next.map((session) => session.name)
    pruneSeen(names)
    pruneLastRuns(names)
  } catch (e) {
    if (!silent || errors.value.length === 0) reportError(errText(e))
  }
}

async function refreshWorkspaces(silent = true) {
  try {
    const next = await listWorkspaces()
    workspaces.value = next
    pruneRecents(next.map((workspace) => workspace.id))
    // a simultaneously running rename could otherwise point at a deleted workspace
    const renaming = renameWorkspaceTarget.value
    if (renaming && !next.some((workspace) => workspace.id === renaming.id)) {
      renameWorkspaceTarget.value = null
    }
  } catch (e) {
    if (!silent || errors.value.length === 0) reportError(errText(e))
  }
}

/** Session pick or create: close the mobile drawer, then load. */
async function loadSession(name: string) {
  // a session choice (row click or create) dismisses the mobile drawer
  if (drawerQuery?.matches && !sidebarCollapsed.value) sidebarCollapsed.value = true
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
    // opening a session consumes its unread dot (persisted for the next reload)
    markSeen(name)
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
    // a run started under a workspace is a strong recency signal
    if (request.workspace_id) noteRecentWorkspace(request.workspace_id)
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
    // The request never became a run, so the submit-time clear must not be the
    // last word: hand the exact task back to the composer (it refuses to
    // overwrite text the operator has typed since).
    draftRestore.value = {
      token: (draftRestore.value?.token ?? 0) + 1,
      text: request.task,
    }
    reportError(errText(e))
  }
}

/** Retry the selected session's failed run (the inline error card's action). */
async function retryLastRun() {
  const request = retryRequest.value
  if (!request || runActive.value) return
  if (request.session && request.session !== selected.value) selected.value = request.session
  if (request.workspace_id) onFilterWorkspace(request.workspace_id)
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

// -- workspace rename & reorder ----------------------------------------------
// The sidebar group header menu targets one registered workspace at a time;
// the shell owns the API calls, the optimistic list state and the toasts.

/** Open the rename dialog for a registered workspace. */
function openWorkspaceRename(workspace: Workspace) {
  renameWorkspaceTarget.value = workspace
}

function closeWorkspaceRename() {
  renameWorkspaceTarget.value = null
}

/** The dialog saved a new name: swap it into the list in place (order intact). */
function onWorkspaceRenamed(workspace: Workspace) {
  workspaces.value = workspaces.value.map((item) =>
    item.id === workspace.id ? { ...item, ...workspace } : item,
  )
  renameWorkspaceTarget.value = null
}

/** Rename failed: the dialog shows it inline; the shell also raises the toast. */
function onWorkspaceRenameError(message: string) {
  reportError(`Rename failed: ${message}`)
}

/**
 * Move one workspace up/down in the persisted order. The local list reorders
 * immediately; the server response (or a background reload) is the truth. On
 * failure the previous order is restored and the standard toast reports it, so
 * an older backend without the endpoint degrades to "action offered, nothing
 * changes".
 */
async function onMoveWorkspace(id: string, delta: number) {
  if (workspaceMoving.value) return
  const previous = workspaces.value
  const current = previous.map((workspace) => workspace.id)
  const next = moveWorkspaceId(current, id, delta)
  if (isSameOrder(current, next)) return

  const byId = new Map(previous.map((workspace) => [workspace.id, workspace] as const))
  const optimistic: Workspace[] = []
  for (const workspaceId of next) {
    const workspace = byId.get(workspaceId)
    if (workspace) optimistic.push(workspace)
  }
  workspaces.value = optimistic
  workspaceMoving.value = true
  try {
    const saved = await reorderWorkspaces(next)
    // a well-formed response is the persisted order; keep the optimistic one if
    // the backend returned an empty/unexpected body
    if (saved.length) workspaces.value = saved
  } catch (e) {
    workspaces.value = previous
    reportError(`Reorder failed: ${errText(e)}`)
  } finally {
    workspaceMoving.value = false
  }
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
  if (lastSeen.value[name] !== undefined) {
    const seen = { ...lastSeen.value }
    delete seen[name]
    lastSeen.value = seen
    saveLastSeen(seen)
  }
  if (lastRunBySession.value[name]) {
    const runs = { ...lastRunBySession.value }
    delete runs[name]
    lastRunBySession.value = runs
  }
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
    if (payload.workspace_id) noteRecentWorkspace(payload.workspace_id)
    newSessionOpen.value = false
    await refreshSessions()
    await loadSession(created.name)
  } catch (e) {
    reportError(errText(e))
  }
}

// -- mobile drawer --------------------------------------------------------------
// Below 768px the sidebar overlays the transcript (style.css). Opening it is
// only possible via the expand button, so it can take focus; while open the
// chat shell is inert, Escape or the backdrop closes it, and choosing a
// session closes it too. Selecting a session closes the drawer (see
// onSelectSession).

const chatShellEl = ref<HTMLElement | null>(null)

function syncShellInert() {
  const el = chatShellEl.value
  if (!el) return
  if (!sidebarCollapsed.value && drawerQuery?.matches) el.setAttribute('inert', '')
  else el.removeAttribute('inert')
}

watch([sidebarCollapsed, () => drawerQuery?.matches], syncShellInert)

function expandSidebar() {
  sidebarCollapsed.value = false
  // move focus into the drawer so keyboard users land on its controls
  nextTick(() => {
    document.querySelector<HTMLElement>('.sidebar button[aria-label="Collapse sidebar"]')?.focus()
  })
}

function collapseDrawer() {
  if (sidebarCollapsed.value) return
  sidebarCollapsed.value = true
  if (drawerQuery?.matches) {
    // the expand button is re-created by v-if — focus the fresh element
    nextTick(() => {
      document.querySelector<HTMLElement>('button.sidebar-expand')?.focus()
    })
  }
}

/**
 * Escape dismisses exactly one layer, topmost first: palette → dialogs →
 * mobile drawer. The palette and dialogs dismiss themselves — their focus
 * traps only let the topmost one react — so this handler is the drawer's last
 * resort and only acts while the drawer is the layer on top. An Escape already
 * handled elsewhere (`defaultPrevented`, e.g. clearing the sidebar search) is
 * left alone rather than also closing the drawer.
 */
function topmostEscapeLayer(): 'palette' | 'dialog' | 'drawer' | null {
  if (paletteOpen.value) return 'palette'
  if (document.querySelector('[role="dialog"]')) return 'dialog'
  if (!sidebarCollapsed.value && drawerQuery?.matches) return 'drawer'
  return null
}

function onDrawerEscape(e: KeyboardEvent) {
  if (e.key !== 'Escape' || e.defaultPrevented) return
  if (topmostEscapeLayer() !== 'drawer') return
  e.stopPropagation()
  collapseDrawer()
}

// -- theme mode ---------------------------------------------------------------
// The OS scheme drives the design tokens in style.css by default. The footer
// selector and the Settings → Appearance radio group pin light/dark by writing
// `data-theme` on <html>, or return to 'system' (attribute removed, media query
// authoritative); the choice is persisted in localStorage, and naive-ui's theme
// follows `isDark`.
const schemeQuery = window.matchMedia('(prefers-color-scheme: dark)')
const systemDark = ref(schemeQuery.matches)
const themeMode = ref<ThemeMode>(readThemeMode())
const isDark = computed(() => resolveDark(themeMode.value, systemDark.value))

function syncTheme() {
  applyThemeAttribute(themeMode.value, isDark.value)
}

function onSchemeChange(e: MediaQueryListEvent) {
  systemDark.value = e.matches
}

/** Footer selector or Settings Appearance changed the theme; keep shell + naive-ui in sync. */
function onThemeChange(mode: ThemeMode) {
  themeMode.value = mode
  saveThemeMode(mode)
}

// apply before the first paint so a pinned scheme does not flash the OS one
syncTheme()
watch([themeMode, isDark], syncTheme)
// settings saves can turn the onboarding hint on or off; no interval, only a save
watch(settingsVersion, () => {
  void probeSettings()
})

// -- density ------------------------------------------------------------------
// Comfortable (default) or Compact: a persisted, spacing-only preference written
// as `data-density` on <html>; style.css owns every rule, the shell only keeps
// the attribute and the stored value in step. Exposed from the palette.
// (`density` itself is declared with the palette actions above.)

function syncDensity() {
  applyDensityAttribute(density.value)
}

function setDensity(next: Density) {
  if (density.value !== next) {
    density.value = next
    saveDensity(next)
  }
  // always re-apply: a stale attribute (e.g. another tab) self-heals on use
  syncDensity()
}

// apply before the first paint, like the theme attribute above
syncDensity()

onMounted(() => {
  schemeQuery.addEventListener('change', onSchemeChange)
  window.addEventListener('keydown', onDrawerEscape)
  window.addEventListener('keydown', onPaletteShortcut)
  refreshSessions(false)
  refreshWorkspaces(false)
  refreshLiveRuns()
  void probeSettings()
  syncShellInert()
  sidebarTimer = setInterval(() => {
    refreshSessions()
    refreshLiveRuns()
  }, 5000)
})

onUnmounted(() => {
  schemeQuery.removeEventListener('change', onSchemeChange)
  window.removeEventListener('keydown', onDrawerEscape)
  window.removeEventListener('keydown', onPaletteShortcut)
  if (sidebarTimer) clearInterval(sidebarTimer)
  if (reconnectTimer) clearTimeout(reconnectTimer)
  settingsRequest++
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
    <!-- First focusable element: Tab reveals it, Enter jumps to the composer. -->
    <a class="skip-link" href="#composer-input" @click.prevent="skipToComposer">
      Skip to composer
    </a>
    <Sidebar
      v-if="!sidebarCollapsed"
      :sessions="visibleSessions"
      :workspaces="workspaces"
      :workspace-filter="workspaceFilter"
      :selected="selected"
      :live="runActive && activeRun ? activeRun.session : null"
      :live-sessions="Object.keys(liveRuns)"
      :statuses="sessionStatuses"
      @select="loadSession"
      @refresh="refreshSessions(false)"
      @collapse="sidebarCollapsed = true"
      @add-workspace="workspaceDialogOpen = true"
      @new-session="newSessionOpen = true"
      @filter-workspace="onFilterWorkspace"
      @deleted="onSessionDeleted"
      @rename-workspace="openWorkspaceRename"
      @move-workspace="onMoveWorkspace"
      :theme-mode="themeMode"
      @open-settings="settingsOpen = true"
      @theme-change="onThemeChange"
    />
    <button
      v-else
      class="icon-btn sidebar-expand"
      title="Show sessions"
      aria-label="Show sessions"
      @click="expandSidebar"
    >
      <span aria-hidden="true">⇥</span>
    </button>

    <button
      v-if="!sidebarCollapsed"
      class="sidebar-backdrop"
      aria-label="Hide sessions"
      tabindex="-1"
      @click="collapseDrawer"
    ></button>

    <div ref="chatShellEl" class="chat-shell">
      <header class="chat-header">
        <div class="chat-title-block">
          <h1 v-if="selected" class="chat-title">{{ title }}</h1>
          <h1 v-else class="chat-title muted">Two Brothers</h1>
          <p v-if="task" class="chat-task muted">{{ task }}</p>
        </div>
        <div class="chat-header-side">
          <button
            type="button"
            class="palette-chip"
            title="Search sessions, workspaces and actions"
            :aria-label="`Open command palette (${paletteShortcut})`"
            @click="paletteOpen = true"
          >
            <AppIcon name="search" class="palette-chip-icon" />
            <span class="palette-chip-label">Search</span>
            <kbd class="palette-chip-keys">{{ paletteShortcut }}</kbd>
          </button>
          <div class="participants" aria-label="Participants">
            <span class="participant"><span class="dot dot-senior" aria-hidden="true"></span>Senior</span>
            <span class="participant-sep" aria-hidden="true">×</span>
            <span class="participant"><span class="dot dot-junior" aria-hidden="true"></span>Junior</span>
          </div>
          <span v-if="activeProvider" class="provider-chip">{{ activeProvider }}</span>
          <span v-if="live && activeRun?.status === 'queued'" class="provider-chip">queued</span>
          <span v-if="live && activeRun?.status === 'running'" class="live-badge">live</span>
          <span v-if="waiting" class="approval-badge" role="status">awaiting approval</span>
        </div>
      </header>

      <aside
        v-if="showOnboardingHint"
        class="onboarding-hint"
        role="status"
        aria-label="Model setup needed"
      >
        <span class="onboarding-hint-text">
          <strong>No model route yet.</strong>
          Set a provider and model for Senior and Junior to start a run.
        </span>
        <button
          type="button"
          class="onboarding-hint-action"
          @click="settingsOpen = true"
        >
          Open Models &amp; roles
        </button>
        <button
          type="button"
          class="onboarding-hint-dismiss"
          title="Dismiss"
          aria-label="Dismiss model setup hint"
          @click="onboardingDismissed = true"
        >
          <AppIcon name="x" class="onboarding-hint-icon" />
        </button>
      </aside>

      <ChatView
        v-if="selected"
        :key="selected"
        :timeline="timeline"
        :loading="loading"
        :activity="activity"
        :resolve-approval="resolveApproval"
        :docked-approval-id="pendingApproval?.approvalId ?? null"
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

      <div v-if="pendingApproval" class="approval-dock">
        <p class="approval-dock-label" role="status">
          <span class="approval-dock-dot" aria-hidden="true"></span>
          Waiting for your approval — the run stays paused until you allow or deny.
        </p>
        <ApprovalCard :item="pendingApproval" :resolve="resolveApproval" />
      </div>

      <UsageFooter
        :live="liveHere"
        :waiting="waitingHere"
        :started-at="runStartedAt"
        :turns="turns"
        :usage="usageForSelected"
      />
      <Composer
        :session-id="selected"
        :draft-restore="draftRestore"
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
      :theme-mode="themeMode"
      :density="density"
      @close="settingsOpen = false"
      @saved="onSettingsSaved"
      @theme-change="onThemeChange"
      @density-change="setDensity"
    />
    <WorkspaceDialog v-if="workspaceDialogOpen" @close="onWorkspaceDialogClose" />
    <WorkspaceRenameDialog
      v-if="renameWorkspaceTarget"
      :workspace="renameWorkspaceTarget"
      @close="closeWorkspaceRename"
      @renamed="onWorkspaceRenamed"
      @error="onWorkspaceRenameError"
    />
    <NewSessionDialog
      v-if="newSessionOpen"
      :workspaces="workspaces"
      :recent-workspaces="recentWorkspaces"
      :default-workspace="workspaceFilter !== 'all' ? workspaceFilter : null"
      @close="newSessionOpen = false"
      @create="onCreateSession"
      @workspace-created="refreshWorkspaces()"
    />
    <CommandPalette
      :visible="paletteOpen"
      :items="paletteItems"
      @close="paletteOpen = false"
      @select="onPaletteSelect"
    />
    </div>
    </n-message-provider>
  </n-config-provider>
</template>

<style scoped>
/* Skip link: the first focusable element in the app, kept off-screen until it
   is keyboard-focused. It is fixed, so it never takes part in the shell layout,
   and it appears instantly — a skip affordance should never animate. */
.skip-link {
  position: fixed;
  top: 8px;
  left: 8px;
  z-index: 4000;
  padding: 0.4rem 0.7rem;
  font-size: var(--text-md);
  font-weight: 600;
  color: var(--text-on-accent);
  background: var(--accent);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-raised);
  text-decoration: none;
  transform: translateY(calc(-100% - 12px));
}

.skip-link:focus-visible {
  transform: translateY(0);
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
}

/* First-run model hint: one compact inline row above the transcript. */
.onboarding-hint {
  display: flex;
  flex: none;
  align-items: center;
  gap: 0.6rem;
  padding: 0.4rem 0.7rem;
  font-size: 0.78rem;
  color: var(--text-primary);
  background: var(--warning-soft);
  border-bottom: 1px solid var(--border-subtle);
}

.onboarding-hint-text {
  flex: 1;
  min-width: 0;
  line-height: 1.35;
}

.onboarding-hint-text strong {
  font-weight: 650;
}

.onboarding-hint-action {
  flex: none;
  height: 26px;
  padding: 0 0.55rem;
  font: inherit;
  font-size: 0.76rem;
  font-weight: 600;
  color: var(--text-on-accent);
  background: var(--accent);
  border: 1px solid var(--accent);
  border-radius: 6px;
  cursor: pointer;
  white-space: nowrap;
}

.onboarding-hint-action:hover {
  opacity: 0.9;
}

.onboarding-hint-action:focus-visible {
  outline-offset: 2px;
}

.onboarding-hint-dismiss {
  flex: none;
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  padding: 0;
  color: var(--text-secondary);
  background: transparent;
  border: none;
  border-radius: 6px;
  cursor: pointer;
}

.onboarding-hint-dismiss:hover {
  color: var(--text-primary);
  background: var(--surface-hover);
}

.onboarding-hint-dismiss:focus-visible {
  outline-offset: 0;
}

.onboarding-hint-icon {
  width: 13px;
  height: 13px;
}

@media (max-width: 640px) {
  .onboarding-hint {
    flex-wrap: wrap;
  }

  .onboarding-hint-text {
    flex-basis: 100%;
  }
}

/* Header affordance for the keyboard-first palette (Ctrl+K / Cmd+K). It is a
   button as well, so the palette is discoverable without knowing the chord. */
.palette-chip {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 0.35rem;
  padding: 0.18rem 0.5rem;
  font-size: 0.75rem;
  color: var(--text-secondary);
  background: transparent;
  border: 1px solid var(--border-strong);
  border-radius: 999px;
  cursor: pointer;
  white-space: nowrap;
}

.palette-chip:hover {
  color: var(--text-primary);
  background: var(--surface-hover);
}

.palette-chip-icon {
  width: 13px;
  height: 13px;
  flex: none;
}

.palette-chip-keys {
  padding: 0.02rem 0.28rem;
  font-family: var(--font-mono);
  font-size: 0.68rem;
  color: var(--text-secondary);
  background: var(--surface-canvas);
  border: 1px solid var(--border-subtle);
  border-radius: 4px;
}

@media (max-width: 640px) {
  .palette-chip-label {
    display: none;
  }
}
</style>
