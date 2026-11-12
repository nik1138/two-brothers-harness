<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { NButton, NConfigProvider, NMessageProvider, darkTheme, lightTheme } from 'naive-ui'
import { accentThemeOverrides, darkThemeOverrides, themeOverrides } from './theme'
import {
  applyThemeAttribute,
  readThemeMode,
  resolveDark,
  saveThemeMode,
} from './themeMode'
import type { ThemeMode } from './themeMode'
import { applyDensityAttribute, readDensity, saveDensity } from './density'
import type { Density } from './density'
import { applyAccentAttribute, applyRoleThemeAttribute, readUiPrefs, saveUiPrefs } from './uiPrefs'
import type { AccentTheme, RoleTheme, UiPrefs } from './uiPrefs'
import {
  ApiError,
  answerRunApproval,
  appliedApprovalScope,
  approvalOutcomeNotice,
  compactSession,
  createSession,
  forkSession,
  getRun,
  getSession,
  getSessionRuntimeEvents,
  getSettings,
  listCommands,
  listRuns,
  listSessions,
  listWorkspaces,
  previewRunUndo,
  reorderWorkspaces,
  startRun,
  steerRun,
  stopRun,
} from './api'
import type { AppliedApprovalScope, ApprovalScope } from './api'
import type {
  BaseCommand,
  CommandInfo,
  Envelope,
  RoleSettingsView,
  RunEvent,
  RunCost,
  RunMode,
  RunProvider,
  RunRecord,
  RunStatus,
  RunUsage,
  SessionInfo,
  SessionRewindResult,
  SettingsView,
  TokenEvent,
  Workspace,
} from './types'
import {
  EMPTY_QUEUE_VIEW,
  sessionQueueViews,
  withQueuedRun,
  withoutRun,
} from './queueState'
import type { QueuedRunRow, SessionQueueView } from './queueState'
import { isBaseCommandAction } from './basecommands'
import type { ComposerCommandRequest } from './basecommands'
import { canUseStopGesture, isStopGesture } from './composerKeys'
import {
  steeredNotice,
  steerAvailability,
  steerFailureNotice,
  steerTextError,
} from './steering'
import {
  operatorTurnIndexes,
  rewindActionFor,
  rewindOutcomeNotice,
  rewindPreview,
} from './sessionRewind'
import type { RewindAction, RewindPreview } from './sessionRewind'
import {
  FORK_FROM_HERE_LABEL,
  forkAvailability,
  forkFailureNotice,
  forkFromHereConfirmation,
  forkRequestBody,
  forkSuccessNotice,
} from './sessionFork'
import type { ForkAvailability } from './sessionFork'
import {
  UNDO_ACTION_LABEL,
  undoActionHint,
  undoApplyNotice,
  undoFailureNotice,
  undoUnavailableNotice,
} from './runUndo'
import type { RunUndoApplyResult, RunUndoPreview } from './runUndo'
import {
  bindingLabel,
  detectBindingPlatform,
  matchesBinding,
  readKeybindings,
} from './keybindings'
import type { Keybindings } from './keybindings'
import { projectEnvelopes, sessionTitle, taskOf } from './chat'
import { downloadSessionExport } from './download'
import { buildPaletteItems, PALETTE_SESSION_PREFIX, PALETTE_WORKSPACE_PREFIX } from './palette'
import type { PaletteItem } from './palette'
import { contentItemSession } from './search'
import { isSameOrder, moveWorkspaceId } from './workspaceOrder'
import { runWorkspaceId } from './workspaceContext'
import {
  STREAMING_MAX_CHARS,
  applyRuntimeEvent,
  applyToken,
  createStreamingState,
  hasStreamingDraft,
  isTokenEvent,
  resetStreaming,
  streamingBlocks,
} from './streaming'
import type { StreamingState } from './streaming'
import {
  changedFilesOf,
  mergeTimeline,
  projectRuntimeEvents,
  runtimeDedupeKey,
  todosOf,
} from './runtime'
import type { ApprovalItem, PromptAuditItem } from './runtime'
import {
  deriveSessionStatus,
  loadLastSeen,
  markSessionSeen,
  pruneLastSeen,
  saveLastSeen,
} from './sessionStatus'
import type { LastSeenMap, SessionStatusKind, SessionStatusView } from './sessionStatus'
import { tabTitle } from './tabTitle'
import type { TabTitleStatus } from './tabTitle'
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
import QueueDock from './components/QueueDock.vue'
import RewindDialog from './components/RewindDialog.vue'
import AppDialog from './components/AppDialog.vue'
import RunUndoDialog from './components/RunUndoDialog.vue'
import TodoPanel from './components/TodoPanel.vue'
import UsageFooter from './components/UsageFooter.vue'
import CommandPalette from './components/CommandPalette.vue'
import ShortcutHelpDialog from './components/ShortcutHelpDialog.vue'
import SessionStatusDialog from './components/SessionStatusDialog.vue'
import PermissionInfoDialog from './components/PermissionInfoDialog.vue'
import AppIcon from './components/AppIcon.vue'
import WelcomeHero from './components/WelcomeHero.vue'
import type { HeroStarter } from './components/WelcomeHero.vue'

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
 * run several sessions at once. The entry is the session's current run (the
 * FIFO head: running/waiting, else the queued head), never a queued tail. */
const liveRuns = ref<Record<string, LiveRun>>({})
/** Per-session active-run projection from the latest pool snapshot: the current
 * run plus the bounded FIFO of submissions queued behind it (queue dock). */
const queueBySession = ref<Record<string, SessionQueueView>>({})
/** Queued-run cancel requests in flight, keyed by run id (rows stay focusable). */
const queueStopping = ref<Record<string, boolean>>({})
/** Live token draft of the followed run (ephemeral SSE `token` frames). */
const streamingState = ref<StreamingState>(createStreamingState())
/** Render-ready live draft; null sections are not shown by ChatView. */
const streamingView = computed(() => streamingBlocks(streamingState.value))
/** The run this app follows: the live run of the selected session, if any.
 * Footer, stop, and the event stream all target this run; runs on other
 * sessions keep running in the background and only appear in liveRuns. */
const activeRun = computed<LiveRun | null>(() =>
  selected.value ? (liveRuns.value[selected.value] ?? null) : null,
)
/** Selected session's live queue: current run + rows queued behind it. */
const queueView = computed<SessionQueueView>(() =>
  selected.value
    ? (queueBySession.value[selected.value] ?? EMPTY_QUEUE_VIEW)
    : EMPTY_QUEUE_VIEW,
)
/** Submissions already waiting behind the selected session's current run. */
const queuedCount = computed(() => queueView.value.queuedCount)
/**
 * Polite, persistent announcement for queue changes. It is always mounted, so
 * screen readers hear a queued submission even when the dock itself is only
 * just appearing (a freshly inserted live region is often not announced).
 */
const queueAnnouncement = computed(() => {
  const count = queuedCount.value
  if (count === 0) return ''
  return count === 1
    ? '1 task queued — it starts after the current run finishes.'
    : `${count} tasks queued — they start after the current run finishes.`
})
/** Outcome of the last composer submission; the draft clears only on `accepted`. */
const submitResult = ref<{ token: number; accepted: boolean } | null>(null)
/**
 * Outcome of the last steer request (wave 23). Like `submitResult`, the
 * composer clears its draft only when the backend accepted the steer; a
 * rejection keeps the text so the operator can fix and retry.
 */
const steerResult = ref<{ token: number; accepted: boolean } | null>(null)
/** Pending steer count echoed by the last accepted steer (honest composer copy). */
const steerPending = ref(0)
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
/** Submitted request per run id, so a failed run is retried with its own task
 * (a queued submission must never replace the current run's retry action). */
const requestByRun = ref<Record<string, RunRequestState>>({})
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
/**
 * Latest known run cost estimate, keyed by session (wave 24). Null/absent is
 * honest unknown (mixed models or an unpriced model); the footer omits the
 * segment then. Cost is not in `run_end`, so it is refreshed from the run
 * record after a terminal event.
 */
const runCostBySession = ref<Record<string, RunCost | null>>({})

/**
 * A new followed run must not inherit the previous run's counters: the live
 * footer now renders usage while working/waiting, so stale tokens/cache/cost
 * would claim the new run already spent them. The first `usage` event fills the
 * real values; until then the segments are absent.
 */
function forgetSessionUsage(session: string) {
  if (session in runUsageBySession.value) {
    const next = { ...runUsageBySession.value }
    delete next[session]
    runUsageBySession.value = next
  }
  if (session in runCostBySession.value) {
    const next = { ...runCostBySession.value }
    delete next[session]
    runCostBySession.value = next
  }
}

/** Newest known run record per session; terminal state survives a reload via the 5 s pool poll. */
interface LastRunInfo {
  status: RunStatus
  created: number
  finished: number
  error?: string
}
const lastRunBySession = ref<Record<string, LastRunInfo>>({})
/**
 * Newest COMPLETED run per session — the session-scoped undo preview target
 * (`/api/sessions/{name}/undo/{run_id}`). `workspace_id` is only known for runs
 * started from this browser tab; null means "unknown", and the action then
 * says so honestly instead of claiming the run touched a workspace.
 */
interface CompletedRunInfo {
  run_id: string
  finished: number
  workspace_id: string | null
}
const latestCompletedRunBySession = ref<Record<string, CompletedRunInfo>>({})
/** Sessions/run ids whose undo preview answered 404: action stays hidden there. */
const undoUnavailableRun = ref<Record<string, string>>({})
/** Open undo preview (dialog state): the run and its normalized preview. */
const undoPreview = ref<{ runId: string; preview: RunUndoPreview } | null>(null)
const undoLoading = ref(false)
/**
 * Workspace link captured when this tab submitted a run, keyed by run id. The
 * run record itself does not carry it; consuming it when the completed record
 * arrives lets the undo action name a known workspace link honestly (absent =
 * unknown, which the action copy says). Bounded by the tab's own submissions.
 */
const workspaceByRunId = new Map<string, string | null>()
/** Operator's last-open stamps, persisted so unread dots survive a reload. */
const lastSeen = ref<LastSeenMap>(loadLastSeen())
/** MRU workspace ids (persisted); `recentWorkspaces` resolves them against the live list. */
const recentWorkspaceIds = ref<string[]>(readRecentWorkspaces())
/** When the followed run started working (epoch ms), driving the footer ticker. */
const runStartedAt = ref<number | null>(null)
/** Provider override actually used for sessions started from this app (only known truth). */
const providerBySession = ref<Record<string, RunProvider>>({})
const settingsOpen = ref(false)
/** Section a fresh Settings mount opens on; `/permission` deep-links here. */
type SettingsSection =
  | 'models'
  | 'providers'
  | 'plugins'
  | 'permissions'
  | 'appearance'
  | 'keyboard'
  | 'advanced'
const settingsSection = ref<SettingsSection>('models')
function openSettings(section: SettingsSection = 'models') {
  settingsSection.value = section
  settingsOpen.value = true
}
/** `/help` overlay (also `?` or the rebindable shortcut-reference chord). */
const helpOpen = ref(false)
/** `/status` overlay. */
const statusOpen = ref(false)
/** `/permission` informational overlay. */
const permissionOpen = ref(false)
/** Neutral, auto-dismissing command notice (never an error toast). */
const commandNotice = ref<string | null>(null)
let commandNoticeTimer: ReturnType<typeof setTimeout> | null = null
/** Catalogs shown in the help overlay (refreshed when it opens from `?`). */
const helpCatalog = ref<{ baseCommands: BaseCommand[]; commands: CommandInfo[] }>({
  baseCommands: [],
  commands: [],
})
const helpCatalogState = ref<'idle' | 'loading' | 'ready' | 'error'>('idle')
/** A `/compact` request is in flight (prevents double submits). */
const compactBusy = ref(false)
/** Cooperation mode reported by the composer for the status overlay. */
const lastCommandMode = ref<RunMode>('consult')
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
/**
 * The composer's model switch saves through PUT /api/settings directly; just
 * refresh the shell's settings snapshot without closing the Settings dialog.
 */
function onComposerModelsChanged() {
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
/**
 * The selected session's current plan (the latest `todo_updated` snapshot):
 * last-write-wins over the session's runtime events. `runtimeEvents` is
 * replaced on session load (replayed from the run sidecar) and only ever
 * receives the followed run's live events, so this is per-session by
 * construction; an older backend never emits the event, so the dock stays
 * absent rather than inventing a plan.
 */
const todoPlan = computed(() => todosOf(runtimeEvents.value))
/**
 * Latest prompt-audit entry of the selected session (role, node kind, section/
 * tool names and char lengths). Feeds the composer context seat; absent until a
 * model call has been audited. Never carries prompt bodies.
 */
const latestPromptAudit = computed<PromptAuditItem | null>(() => {
  const items = runtimeItems.value
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i]
    if (item.type === 'prompt_audit') return item
  }
  return null
})
const title = computed(() => {
  if (!selected.value) return ''
  const info = sessions.value.find((s) => s.name === selected.value)
  return info?.title || sessionTitle(selected.value)
})
const task = computed(() => taskOf(events.value))
/** Operator turns in the selected session: envelopes authored by the user. */
const turns = computed(() => events.value.filter((e) => e.from === 'user').length)
/** Selected session's minimal identity for the `/status` overlay. */
const selectedSessionInfo = computed<{ name: string; title?: string } | null>(() =>
  selected.value
    ? { name: selected.value, ...(title.value ? { title: title.value } : {}) }
    : null,
)
/** Selected session's workspace name, when it is linked to a known workspace. */
const selectedWorkspaceName = computed<string | null>(() => {
  const name = selected.value
  if (!name) return null
  const session = sessions.value.find((item) => item.name === name)
  const workspaceId = session?.workspace_id
  if (!workspaceId) return null
  return workspaces.value.find((workspace) => workspace.id === workspaceId)?.name ?? null
})
/** Latest known usage for the selected session, if any. */
const usageForSelected = computed(() =>
  selected.value ? (runUsageBySession.value[selected.value] ?? null) : null,
)
/** Latest known run cost estimate for the selected session (null = unknown). */
const costForSelected = computed(() =>
  selected.value ? (runCostBySession.value[selected.value] ?? null) : null,
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
/**
 * Availability of the composer's mid-run steering action (wave 23): only a
 * running run or one parked on an approval is steerable — the backend answers
 * 409 for queued/terminal runs, so no control is offered there. The help copy
 * says where the draft lands (the run's next step).
 */
const steerView = computed(() => steerAvailability(activeRun.value))
/** True when the composer must offer the explicit "Steer run" action. */
const steerable = computed(() => steerView.value.visible)
/**
 * The pending steer count belongs to ONE run: clear it whenever the followed
 * run changes (new run, terminal, session switch) so the composer title can
 * never quote a stale queue from a previous run.
 */
watch(
  () => activeRun.value?.run_id ?? null,
  () => {
    steerPending.value = 0
  },
)

// -- session rewind (wave 23) -------------------------------------------------
/** The operator message whose rewind the confirmation dialog would apply. */
const rewindTarget = ref<RewindPreview | null>(null)
/**
 * What rewind is blocked by right now (the transcript action disables while a
 * run is live or a manual compaction is in flight; the backend also 409s).
 */
const rewindContext = computed(() => ({
  live: runActive.value,
  compacting: compactBusy.value,
}))
/**
 * Rewind affordances for the loaded transcript, keyed by envelope `seq` and
 * derived once per events/context change (an operator transcript can hold
 * hundreds of bubbles — the resolver must stay O(1)). The pure helper mirrors
 * the backend's operator-turn rule; a turn already folded into a compaction
 * summary is normal history, so no control is offered for it. A live run or an
 * in-flight compaction keeps the control visible but disabled with the honest
 * reason (`rewindTitle` in ChatView).
 */
const rewindActions = computed<Map<number, RewindAction>>(() => {
  const actions = new Map<number, RewindAction>()
  for (const index of operatorTurnIndexes(events.value)) {
    const action = rewindActionFor(events.value, index, rewindContext.value)
    if (action === null) continue
    if (!action.removable && action.blockedBy === 'compaction-floor') continue
    const seq = events.value[index]?.seq
    if (typeof seq === 'number') actions.set(seq, action)
  }
  return actions
})
/** Resolver prop for ChatView: the action for one operator message, if any. */
function rewindForSeq(seq: number): RewindAction | null {
  return rewindActions.value.get(seq) ?? null
}
/** Open the destructive rewind confirmation for one operator message. */
function requestRewind(seq: number): void {
  const action = rewindActions.value.get(seq)
  if (!action || !action.removable) return
  const preview = rewindPreview(events.value, action.index, rewindContext.value)
  if (preview !== null) rewindTarget.value = preview
}
/**
 * The rewind dialog applied a cut: report the applied counts (and any clamp
 * reason) and reload the rewritten session so the transcript matches the file.
 */
async function onSessionRewound(result: SessionRewindResult): Promise<void> {
  rewindTarget.value = null
  const name = result.name || selected.value
  if (!name) return
  showNotice(rewindOutcomeNotice(result))
  await refreshSessions(false)
  await loadSession(name)
}
/**
 * A session row forked its conversation: refresh the list, then open the new
 * session. The row already showed the backend-named success notice.
 */
async function onSessionForked(name: string): Promise<void> {
  await refreshSessions(false)
  if (sessions.value.some((session) => session.name === name)) {
    await loadSession(name)
  }
}

// -- fork from here (wave 26) --------------------------------------------------
/**
 * Branch the conversation at one operator message (envelope `seq`). Unlike the
 * session-row action (whole conversation, no `seq`), this always sends the
 * clicked bubble's `seq`, so the backend copies exactly that prefix into a new
 * session and leaves the source untouched. The confirmation dialog owns the
 * request; a failure stays inline and changes no session state.
 */
const forkFromHereTarget = ref<{ seq: number; session: string } | null>(null)
/** One fork request at a time; the dialog stays open (and persistent) while it runs. */
const forkFromHereBusy = ref(false)
/** Honest failure copy shown inline (the dialog is the error surface). */
const forkFromHereError = ref<string | null>(null)
/** A live run blocks the fork (the backend also 409s); a request blocks a second one. */
const forkFromHereContext = computed(() => ({
  live: runActive.value,
  busy: forkFromHereBusy.value,
}))
/** Resolver prop for ChatView: availability for one operator message. */
function forkFromHereFor(_seq: number): ForkAvailability {
  return forkAvailability(forkFromHereContext.value)
}
/** Open the fork-from-here confirmation for one operator message (`seq`). */
function requestForkFromHere(seq: number): void {
  const name = selected.value
  if (!name || forkFromHereBusy.value) return
  const state = forkAvailability(forkFromHereContext.value)
  if (!state.available) {
    showNotice(state.reason ?? 'Forking is unavailable right now.')
    return
  }
  forkFromHereError.value = null
  forkFromHereTarget.value = { seq, session: name }
}
/** Cancel the confirmation (never while the request is in flight). */
function closeForkFromHere(): void {
  if (forkFromHereBusy.value) return
  forkFromHereTarget.value = null
  forkFromHereError.value = null
}
/**
 * Confirm the prefix fork: `POST /api/sessions/{name}/fork` with `{seq}`. On
 * success the existing fork notice is shown, the list refreshes and the new
 * session opens; on failure the copy stays in the dialog and nothing is opened
 * (the source was never modified, and the backend rolled back any partial file).
 */
async function confirmForkFromHere(): Promise<void> {
  const target = forkFromHereTarget.value
  if (!target || forkFromHereBusy.value) return
  forkFromHereBusy.value = true
  forkFromHereError.value = null
  try {
    const result = await forkSession(target.session, forkRequestBody({ seq: target.seq }))
    forkFromHereTarget.value = null
    showNotice(forkSuccessNotice(result, target.session))
    await refreshSessions(false)
    if (sessions.value.some((session) => session.name === result.name)) {
      await loadSession(result.name)
    }
  } catch (e) {
    forkFromHereError.value = forkFailureNotice({
      status: e instanceof ApiError ? e.status : undefined,
      detail: errText(e),
    })
  } finally {
    forkFromHereBusy.value = false
  }
}
/** The confirmation is session-scoped: a session switch closes it. */
watch(selected, () => {
  if (forkFromHereBusy.value) return
  forkFromHereTarget.value = null
  forkFromHereError.value = null
})

// -- run-scoped file undo (wave 23) -------------------------------------------
/**
 * The newest completed run of the followed session, when its file changes can
 * be reviewed: no live run on that session and no compaction in flight. The
 * action is a plain enabled control while the preview is unknown; a 404 from
 * the preview (older backend without the route, or no undo record) hides it for
 * that run with an honest notice — never a permanently dead disabled button.
 */
const undoTarget = computed<CompletedRunInfo | null>(() => {
  const session = selected.value
  if (!session || compactBusy.value) return null
  if (liveRuns.value[session]) return null
  const run = latestCompletedRunBySession.value[session]
  if (!run) return null
  if (undoUnavailableRun.value[session] === run.run_id) return null
  return run
})
/** Action hint: names a known workspace link, or says the link is unknown. */
const undoHint = computed(() =>
  undoTarget.value ? undoActionHint(undoTarget.value.workspace_id !== null) : '',
)
/**
 * Fetch the session-scoped undo preview for the latest completed run and open
 * the review dialog. A 404 is the honest "no undo record for this run / older
 * backend" answer: hide the action for that run and say so once.
 */
async function openUndoPreview(): Promise<void> {
  const session = selected.value
  const target = undoTarget.value
  if (!session || !target || undoLoading.value) return
  undoLoading.value = true
  try {
    const preview = await previewRunUndo(session, target.run_id)
    undoPreview.value = { runId: target.run_id, preview }
  } catch (e) {
    const status = e instanceof ApiError ? e.status : undefined
    if (status === 404) {
      undoUnavailableRun.value = { ...undoUnavailableRun.value, [session]: target.run_id }
      showNotice(undoUnavailableNotice())
    } else {
      reportError(
        undoFailureNotice({ status, detail: errText(e) }),
      )
    }
  } finally {
    undoLoading.value = false
  }
}
/** Files were restored/deleted: report honestly and refresh the session list. */
function onUndoApplied(result: RunUndoApplyResult): void {
  showNotice(undoApplyNotice(result))
  refreshSessions(false)
}
/** The undo record was discarded (workspace files unchanged): refresh metadata. */
function onUndoDiscarded(): void {
  showNotice('Undo record discarded for this run; workspace files are unchanged.')
  refreshSessions(false)
}

/** The undo preview/dialog is session-scoped: a session switch closes it. */
watch(selected, () => {
  undoPreview.value = null
})
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
    ? 'Run queued — it starts as soon as a worker is free…'
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

/**
 * Workspace the composer's `@` file picker searches: the selected session's
 * linked workspace, else the sidebar filter (a session started under it will
 * belong to that workspace).
 */
const composerWorkspaceId = computed<string | null>(() => {
  const name = selected.value
  const session = name
    ? sessions.value.find((item) => item.name === name)
    : undefined
  return runWorkspaceId(session?.workspace_id, workspaceFilter.value)
})

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
 * Workspace context the welcome/empty hero shows: the sidebar filter when one is
 * active, else the selected session's linked workspace (null = all/none).
 */
const heroWorkspaceName = computed<string | null>(() => {
  if (workspaceFilter.value !== 'all') {
    return (
      workspaces.value.find((workspace) => workspace.id === workspaceFilter.value)?.name ?? null
    )
  }
  return selectedWorkspaceName.value
})

/** Editable task suggestions: starters are drafted into the composer, never run directly. */
const HERO_STARTERS: readonly HeroStarter[] = [
  {
    id: 'plan',
    label: 'Plan a change',
    description: 'Prefills /plan — add the objective, then send',
    text: '/plan ',
  },
  {
    id: 'review',
    label: 'Review the workspace',
    description: 'Ask for the main risks and next steps in the linked folder',
    text: 'Review the linked workspace and report the main risks and next steps.',
  },
  {
    id: 'explain',
    label: 'Explain a change',
    description: 'Ask what changed and why it matters',
    text: 'Explain what changed recently and why it matters.',
  },
]

/** Shell-requested composer prefill from a hero starter (token = one request). */
const composerPrefill = ref<{ token: number; text: string } | null>(null)
let composerPrefillToken = 0

/** Put a starter into the task box (editable, focus at the end; nothing is sent). */
function prefillComposer(text: string): void {
  const value = typeof text === 'string' ? text.trimStart() : ''
  if (!value) return
  composerPrefillToken += 1
  composerPrefill.value = { token: composerPrefillToken, text: value }
}

/**
 * A transcript bubble asked to quote itself. ChatView captured the selection
 * (or fell back to the whole message) and formatted the Markdown blockquote;
 * the composer appends it to the unsent draft without replacing or sending it.
 */
const composerQuote = ref<{ token: number; text: string } | null>(null)
let composerQuoteToken = 0

function appendQuoteToComposer(quote: string): void {
  const value = typeof quote === 'string' ? quote : ''
  if (value.trim() === '') return
  composerQuoteToken += 1
  composerQuote.value = { token: composerQuoteToken, text: value }
}

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

// -- tab title (background attention) -----------------------------------------
// The document title is the only surface that survives a backgrounded tab, so
// it mirrors what the sidebar already says: the selected session's name plus a
// marker for a live/waiting/failed run, an unread count when nothing is on
// screen, or the bare product name. `tabTitle.ts` owns the decision (markers,
// sanitizing, 120-char cap); this shell only feeds it state it already has.

/** The selected session's row state, reused so title and sidebar cannot disagree. */
const selectedStatusKind = computed<SessionStatusKind | null>(() =>
  selected.value ? (sessionStatuses.value[selected.value]?.kind ?? null) : null,
)

/** Row state -> run status the title formatter understands. */
const titleStatus = computed<TabTitleStatus>(() => {
  switch (selectedStatusKind.value) {
    case 'live':
      return 'running'
    case 'waiting':
      return 'waiting'
    case 'failed':
      return 'failed'
    default:
      return null
  }
})

/** Sessions with an unopened finished run; only used when nothing is selected. */
const unreadSessionCount = computed(
  () => Object.values(sessionStatuses.value).filter((status) => status.kind === 'unread').length,
)

const documentTitle = computed(() =>
  tabTitle({
    sessionTitle: title.value,
    status: titleStatus.value,
    unreadCount: unreadSessionCount.value,
  }),
)

// Guarded for non-DOM callers (the module is inert without a document).
watch(
  documentTitle,
  (next) => {
    if (typeof document !== 'undefined') document.title = next
  },
  { immediate: true },
)

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

// -- command palette (default Ctrl/⌘+K, rebindable in Settings → Keyboard) ------
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
/** Device-local rebindable global chords (Settings → Keyboard); live per change. */
const keybindings = ref<Keybindings>(readKeybindings())
const bindingPlatform = detectBindingPlatform()
/** Shortcut label for the header affordance; follows the current binding. */
const paletteShortcut = computed(() => bindingLabel(keybindings.value.palette, bindingPlatform))

/** Settings → Keyboard reported a new (already validated and persisted) set. */
function onKeybindingsChange(next: Keybindings): void {
  keybindings.value = next
}

/** Persisted spacing preference (Comfortable by default); applied as data-density. */
const density = ref<Density>(readDensity())

/** Persisted conversation preferences (prompt audits are hidden by default). */
const uiPrefs = ref<UiPrefs>(readUiPrefs())
const showPromptAudits = computed(() => uiPrefs.value.showPromptAudits)

/** Settings → Advanced toggle; applies immediately and persists per device. */
function setShowPromptAudits(next: boolean): void {
  if (uiPrefs.value.showPromptAudits === next) return
  uiPrefs.value = saveUiPrefs({ showPromptAudits: next })
}

// -- accent theme -------------------------------------------------------------
// Blue (the :root palette) or a violet/teal/amber variant from Settings →
// Appearance. The choice is persisted beside the other UI preferences and
// applied as `data-accent` on <html>; tokens.css owns every variant value.
const accent = computed(() => uiPrefs.value.accent)

function syncAccent(): void {
  applyAccentAttribute(uiPrefs.value.accent)
}

function setAccent(next: AccentTheme): void {
  if (uiPrefs.value.accent !== next) {
    uiPrefs.value = saveUiPrefs({ accent: next })
  }
  // always re-apply: a stale attribute (e.g. another tab) self-heals on use
  syncAccent()
}

// apply before the first paint, like the theme/density attributes below
syncAccent()

// -- role colour palette ------------------------------------------------------
// Default (the :root role tokens) or the contrast/neutral palettes from
// Settings → Appearance. Persisted beside the other UI preferences and applied
// as `data-roles` on <html>; tokens.css owns every palette value.
const roleTheme = computed(() => uiPrefs.value.roleTheme)

function syncRoleTheme(): void {
  applyRoleThemeAttribute(uiPrefs.value.roleTheme)
}

function setRoleTheme(next: RoleTheme): void {
  if (uiPrefs.value.roleTheme !== next) {
    uiPrefs.value = saveUiPrefs({ roleTheme: next })
  }
  // always re-apply: a stale attribute (e.g. another tab) self-heals on use
  syncRoleTheme()
}

// apply before the first paint, beside the accent attribute
syncRoleTheme()

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
  if (!matchesBinding(e, keybindings.value.palette)) return
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
      openSettings()
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

// -- live token draft (ephemeral SSE `token` frames) -------------------------
// The followed run's stream also emits named `token` frames while a model is
// generating (reasoning + reply deltas). They are not replayed, carry no id, and
// never touch the typed-event cursor: they only feed a disposable draft. Token
// batches are coalesced onto the next animation frame so a fast stream cannot
// re-render the transcript once per delta; the queue itself is bounded too, so
// a hidden tab (no animation frames) cannot grow it without limit.

let streamFrame: number | null = null
let pendingStreamTokens: TokenEvent[] = []
let pendingStreamChars = 0

/** Apply the buffered token delta batch to the draft right now. */
function flushStreamTokens(): void {
  if (streamFrame !== null) {
    window.cancelAnimationFrame(streamFrame)
    streamFrame = null
  }
  if (pendingStreamTokens.length === 0) return
  const batch = pendingStreamTokens
  pendingStreamTokens = []
  pendingStreamChars = 0
  let next = streamingState.value
  for (const token of batch) next = applyToken(next, token)
  streamingState.value = next
}

/** Clear the live draft and drop any buffered tokens/frame. */
function resetStreamingDraft(): void {
  pendingStreamTokens = []
  pendingStreamChars = 0
  if (streamFrame !== null) {
    window.cancelAnimationFrame(streamFrame)
    streamFrame = null
  }
  if (hasStreamingDraft(streamingState.value)) streamingState.value = resetStreaming()
}

/** Queue one live token for the followed run; ignores other runs entirely. */
function queueStreamToken(token: TokenEvent): void {
  const run = activeRun.value
  if (!run || token.run_id !== run.run_id) return
  pendingStreamTokens.push(token)
  pendingStreamChars += token.delta.length
  // a hidden/backgrounded tab may never run an animation frame: flush early
  if (pendingStreamChars > STREAMING_MAX_CHARS) {
    flushStreamTokens()
    return
  }
  if (streamFrame !== null) return
  streamFrame = window.requestAnimationFrame(() => {
    streamFrame = null
    flushStreamTokens()
  })
}

/**
 * Fold the typed runtime events that end a live draft into the streaming state:
 * a completed envelope replaces its role's draft, terminal events clear it.
 */
function applyStreamingEvent(event: RunEvent): void {
  if (!event) return
  if (event.type !== 'envelope' && event.type !== 'run_end' && event.type !== 'run_error') return
  flushStreamTokens()
  const next = applyRuntimeEvent(streamingState.value, event)
  if (next !== streamingState.value) streamingState.value = next
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

/** Remember the usage of the session's newest completed run, if the backend
 * reports one; clears a stale entry when the newest run predates usage tracking. */
async function refreshUsageForSession(session: string) {
  if (activeRun.value?.session === session) return
  try {
    const runs = await listRuns(session)
    const completed = runs
      .filter((r) => r.status === 'completed')
      .sort((a, b) => (b.finished || b.created || 0) - (a.finished || a.created || 0))
    const latest = completed[0]
    if (!latest) return
    // The newest completed record is also the session-scoped undo target. It is
    // discovered via the pool poll, so it cannot carry a workspace link; the
    // action copy says the link is unknown rather than pretending.
    recordLastRun(latest)
    runUsageBySession.value = { ...runUsageBySession.value, [session]: latest.usage ?? null }
    runCostBySession.value = { ...runCostBySession.value, [session]: latest.cost ?? null }
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
    const runs = await listRuns(session)
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
  if (wasFollowed) {
    closeStream()
    // the draft is ephemeral: the persisted transcript/timeline takes over now
    resetStreamingDraft()
  }
  const rest = { ...liveRuns.value }
  delete rest[entry.session]
  liveRuns.value = rest
  forgetRunStream(runId)
  // terminal now: the row leaves the queue, and the next queued run (if any)
  // must be adopted/followed immediately instead of on the next 5 s pool poll
  queueBySession.value = withoutRun(queueBySession.value, runId)
  void refreshLiveRuns()
  // a failed run is retried with its own submitted task, never with a newer
  // submission queued behind it
  const request = requestByRun.value[runId] ?? null
  if (requestByRun.value[runId]) {
    const nextRequests = { ...requestByRun.value }
    delete nextRequests[runId]
    requestByRun.value = nextRequests
  }
  if (status === 'failed') {
    // G-5: keep the failure visible after the toast expires (and after reload,
    // via syncRunOutcome); a later successful run clears it again.
    const message = error ?? runErrorBySession.value[entry.session] ?? 'Run failed'
    setRunError(entry.session, message)
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
  // Clear the previous run's estimate before the fetch: run_end has already
  // installed the new run's usage, so a slow or failed getRun must never pair
  // that usage with the old cost. The record's cost (or null) overwrites it.
  runCostBySession.value = { ...runCostBySession.value, [entry.session]: null }
  getRun(runId)
    .then((rec) => {
      // the record carries the authoritative finished timestamp for unread
      recordLastRun(rec)
      if (rec.usage) {
        runUsageBySession.value = { ...runUsageBySession.value, [entry.session]: rec.usage }
      }
      // Cost is computed by the backend at run completion (not in run_end), so
      // the terminal record is its only source.
      runCostBySession.value = { ...runCostBySession.value, [entry.session]: rec.cost ?? null }
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
  // keep the live draft in step with the typed events (envelope completes a
  // draft, run_end/run_error clear it) before the switch handles the event
  applyStreamingEvent(data)
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
    case 'usage':
      // Live counters: update the footer without inventing a timeline row.
      if (data.usage) {
        runUsageBySession.value = { ...runUsageBySession.value, [run.session]: data.usage }
      }
      break
    case 'todo_updated':
      // display-only plan snapshot: the projection keeps the latest write
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
  // ephemeral live tokens arrive as a NAMED event: they carry no id and are not
  // replayed, so they never feed the `?after` cursor used above
  source.addEventListener('token', (event: Event) => {
    let parsed: unknown
    try {
      parsed = JSON.parse((event as MessageEvent<string>).data)
    } catch {
      return
    }
    if (isTokenEvent(parsed)) queueStreamToken(parsed)
  })
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
    // switching the followed run (or its session) drops the previous draft
    if (prev !== runId) resetStreamingDraft()
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

/**
 * Reconcile the live-run map and the per-session queue projection with the
 * backend pool: adopt the current run of every active session (another
 * session, a reload, or the FIFO head that just took over after a finish) and
 * drop runs that reached a terminal state while unattended.
 *
 * `GET /api/runs` returns records newest first; `sessionQueueViews` restores
 * the per-session FIFO, so an adopted run is always the session's current run
 * and never one queued behind it. Only active records are projected — an older
 * backend that returns none simply yields an empty dock.
 */
let liveRunsRequest = 0

async function refreshLiveRuns() {
  // Last issued snapshot wins: a slow response must never overwrite a newer
  // projection (it would resurrect a run that already left the queue).
  const request = ++liveRunsRequest
  let runs: RunRecord[]
  try {
    runs = await listRuns(null)
  } catch {
    // fail-soft: keep the last known state and retry on the next poll
    return
  }
  if (request !== liveRunsRequest) return
  // keep the per-session newest-record map current for the sidebar statuses
  for (const rec of runs) recordLastRun(rec)
  const views = sessionQueueViews(runs)
  queueBySession.value = views
  const activeBySession = new Map<string, QueuedRunRow>()
  for (const [session, view] of Object.entries(views)) {
    if (view.current) activeBySession.set(session, view.current)
  }
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
  for (const [session, row] of activeBySession) {
    const current = liveRuns.value[session]
    if (!current || current.run_id !== row.run_id) {
      // a new head run (the one before it finished): follow it, so the next
      // queued run's stream, transcript and Stop control take over
      forgetSessionUsage(session)
      liveRuns.value = {
        ...liveRuns.value,
        [session]: { run_id: row.run_id, session, status: row.status },
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
  if (run.status === 'completed') {
    const prior = latestCompletedRunBySession.value[run.session]
    const captured = workspaceByRunId.get(run.run_id)
    if (captured !== undefined) workspaceByRunId.delete(run.run_id)
    latestCompletedRunBySession.value = {
      ...latestCompletedRunBySession.value,
      [run.session]: {
        run_id: run.run_id,
        finished: stamp,
        // A record discovered by the pool poll cannot know the workspace link;
        // keep what this tab captured, else a same-run prior value, else unknown.
        workspace_id:
          captured ?? (prior?.run_id === run.run_id ? prior.workspace_id : null),
      },
    }
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
  const completed: Record<string, CompletedRunInfo> = {}
  for (const [key, info] of Object.entries(latestCompletedRunBySession.value)) {
    if (valid.has(key)) completed[key] = info
  }
  latestCompletedRunBySession.value = completed
  const unavailable: Record<string, string> = {}
  for (const [key, runId] of Object.entries(undoUnavailableRun.value)) {
    if (valid.has(key)) unavailable[key] = runId
  }
  undoUnavailableRun.value = unavailable
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
  // never show the previous session's live draft while this one loads
  resetStreamingDraft()
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

/**
 * Submit one task. A live run on the selected session is no longer a blocker:
 * the backend keeps its per-session FIFO, so the request queues behind it. The
 * composer shows honest "runs after the current run finishes" copy, and clears
 * its draft only when this call reports the submission accepted.
 */
async function startNewRun(payload: {
  task: string
  mode: RunMode
  provider: RunProvider | null
  /** Composer submission token; its acceptance outcome drives the draft clear. */
  token?: number
}) {
  errors.value = []
  const request: RunRequestState = {
    task: payload.task,
    mode: payload.mode,
    provider: payload.provider,
    session: selected.value,
    // Same workspace the composer file picker and status seats use: the
    // session's link wins, the sidebar filter is the unlinked-session fallback.
    workspace_id: composerWorkspaceId.value,
  }
  let accepted = false
  try {
    const res = await startRun({
      task: request.task,
      mode: request.mode,
      provider: request.provider,
      session: request.session,
      workspace_id: request.workspace_id,
      // opt into the ephemeral live `token` frames for the followed run
      stream_tokens: true,
    })
    accepted = true
    requestByRun.value = { ...requestByRun.value, [res.run_id]: request }
    workspaceByRunId.set(res.run_id, request.workspace_id)
    setLastEventId(res.run_id, 0)
    setReconnectAttempts(res.run_id, 0)
    // A session without a followed run gets this one; a submission behind a
    // working run joins the queue and must never replace the run currently
    // being followed and streamed.
    if (!liveRuns.value[res.session]) {
      resetStreamingDraft()
      forgetSessionUsage(res.session)
      liveRuns.value = {
        ...liveRuns.value,
        [res.session]: { run_id: res.run_id, session: res.session, status: res.status },
      }
      stopping.value = false
      runStartedAt.value = Date.now()
      if (res.session !== selected.value) {
        // a fresh session: the stream will replay everything from the start
        selected.value = res.session
        events.value = []
        maxSeq = 0
        setRuntimeHistory([])
      }
    } else if (res.status === 'queued') {
      // Show the accepted run immediately; the pool snapshot requested below
      // replaces this projection with the authoritative FIFO (deduped by id).
      queueBySession.value = withQueuedRun(queueBySession.value, {
        run_id: res.run_id,
        session: res.session,
        task: request.task,
        status: res.status,
        created: Math.floor(Date.now() / 1000),
      })
    }
    // a run started under a workspace is a strong recency signal
    if (request.workspace_id) noteRecentWorkspace(request.workspace_id)
    // a new attempt supersedes the previous failure and its error card
    clearRunError(res.session)
    clearRetryAction(res.session)
    if (payload.provider) {
      providerBySession.value = { ...providerBySession.value, [res.session]: payload.provider }
    }
    // the activeRun watcher opens the stream for a newly followed run; the
    // pool refresh adopts the next queued run as soon as the current one ends
    void refreshLiveRuns()
    refreshSessions()
  } catch (e) {
    // The request never became a run: nothing was consumed (the composer
    // clears only an accepted submission), so the draft stays exactly as typed.
    reportError(errText(e))
  } finally {
    if (typeof payload.token === 'number') {
      submitResult.value = { token: payload.token, accepted }
    }
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
 * that run — e.g. answering from a reopened session). An optional `scope`
 * asks the backend to remember the pair for this session; the applied scope
 * is read back from the response, so an older backend that ignored the field
 * is reported honestly as one-shot instead of pretending it stuck. */
async function resolveApproval(
  runId: string,
  approvalId: string,
  allow: boolean,
  scope: ApprovalScope = 'once',
): Promise<boolean> {
  let applied: AppliedApprovalScope
  try {
    const result = await answerRunApproval(runId, approvalId, { allow, scope })
    applied = appliedApprovalScope(result)
  } catch (e) {
    reportError(errText(e))
    return false
  }
  if (scope === 'session') {
    const notice = approvalOutcomeNotice(scope, applied)
    if (notice) showNotice(notice)
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
    // run_end event finishes the flow. Tokens may stall mid-stop: drop the draft.
    resetStreamingDraft()
    if (res.status === 'cancelled') finalizeRun(run.run_id, 'cancelled', null)
  } catch (e) {
    stopping.value = false
    reportError(errText(e))
  }
}

/**
 * Queue one explicit operator steer on the followed run (wave 23): the text is
 * applied at the run's NEXT step — it never starts or queues a task. The
 * backend's 200 is the only acceptance; the composer clears its draft from
 * `steerResult`, and the confirmation says plainly that the text is queued for
 * the next step (the transcript entry arrives over the run SSE stream later).
 */
async function steerActiveRun(payload: { text: string; token: number }) {
  const run = activeRun.value
  const text = payload.text.trim()
  if (!run || !steerAvailability(run).visible || steerTextError(text) !== null) {
    steerResult.value = { token: payload.token, accepted: false }
    return
  }
  try {
    const result = await steerRun(run.run_id, text)
    steerPending.value = result.pending
    steerResult.value = { token: payload.token, accepted: true }
    showNotice(steeredNotice(result))
  } catch (e) {
    steerResult.value = { token: payload.token, accepted: false }
    reportError(
      steerFailureNotice({
        status: e instanceof ApiError ? e.status : undefined,
        detail: errText(e),
      }),
    )
  }
}

/**
 * Cancel one run queued behind the current run (`POST /api/runs/{id}/stop`).
 * The backend cancels a queued run immediately; the row leaves the projection
 * right away and the pool refresh confirms it. The button stays focusable
 * while the request is in flight, so cancellation never drops keyboard focus.
 */
async function stopQueuedRun(runId: string) {
  if (!runId || queueStopping.value[runId]) return
  const hadFocus = document.activeElement?.getAttribute('data-queued-run') === runId
  queueStopping.value = { ...queueStopping.value, [runId]: true }
  try {
    const res = await stopRun(runId)
    if (res.status === 'cancelled' || res.status === 'completed' || res.status === 'failed') {
      queueBySession.value = withoutRun(queueBySession.value, runId)
      if (requestByRun.value[runId]) {
        const requests = { ...requestByRun.value }
        delete requests[runId]
        requestByRun.value = requests
      }
    }
  } catch (e) {
    // a 404 means it already left the queue; either way the refresh reconciles
    reportError(errText(e))
  } finally {
    const nextStopping = { ...queueStopping.value }
    delete nextStopping[runId]
    queueStopping.value = nextStopping
    void refreshLiveRuns()
    if (hadFocus) {
      // the row disappears with this update — never strand focus on <body>
      void nextTick(() => {
        if (document.activeElement === document.body) {
          document.getElementById('composer-input')?.focus()
        }
      })
    }
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

// -- composer commands, shortcut help & stop gesture --------------------------
// The `/` menu's first-party actions are performed here; every result is an
// honest neutral notice (or the standard error toast for real failures).

function dismissNotice(): void {
  if (commandNoticeTimer) {
    clearTimeout(commandNoticeTimer)
    commandNoticeTimer = null
  }
  commandNotice.value = null
}

/** Show one neutral, auto-dismissing notice (command results and usage hints). */
function showNotice(message: string): void {
  const text = message.trim()
  if (!text) return
  commandNotice.value = text
  if (commandNoticeTimer) clearTimeout(commandNoticeTimer)
  commandNoticeTimer = setTimeout(() => {
    commandNoticeTimer = null
    commandNotice.value = null
  }, 6000)
}

/** Remember a catalogue for the help overlay (base + discovered commands). */
function setHelpCatalog(baseCommands: BaseCommand[], commands: CommandInfo[]): void {
  helpCatalog.value = { baseCommands, commands }
  helpCatalogState.value = 'ready'
}

/** Fetch the command catalogue for `?`/Ctrl+⌘+/ opens (fail-soft). */
async function loadHelpCatalog(): Promise<void> {
  if (helpCatalogState.value === 'loading') return
  helpCatalogState.value = 'loading'
  try {
    const catalog = await listCommands()
    setHelpCatalog(catalog.baseCommands, catalog.commands)
  } catch {
    helpCatalogState.value = 'error'
  }
}

function openShortcutHelp(baseCommands?: BaseCommand[], commands?: CommandInfo[]): void {
  if (Array.isArray(baseCommands) && Array.isArray(commands)) {
    setHelpCatalog(baseCommands, commands)
  }
  helpOpen.value = true
  if (helpCatalogState.value !== 'ready') void loadHelpCatalog()
}

/** `/compact`: compact the selected session in place, then reload its transcript. */
async function runCompactCommand(): Promise<void> {
  const name = selected.value
  if (!name) {
    showNotice('Open a session before using /compact.')
    return
  }
  if (compactBusy.value) {
    showNotice('A compaction is already running.')
    return
  }
  compactBusy.value = true
  try {
    const result = await compactSession(name)
    if (result.compacted) {
      const counts =
        typeof result.before_events === 'number' && typeof result.after_events === 'number'
          ? ` (${result.before_events} → ${result.after_events} events)`
          : ''
      await loadSession(name)
      showNotice(`Session compacted${counts}.`)
    } else {
      showNotice(
        result.reason
          ? `Not compacted: ${result.reason}.`
          : 'Not compacted — there was nothing to compact.',
      )
    }
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) {
      showNotice('A run is live on this session — stop it or wait for it to finish, then compact.')
    } else if (e instanceof ApiError && e.status === 404) {
      // the session may have been deleted, or this backend may not serve /compact
      showNotice('Compaction is unavailable for this session (missing session or older backend).')
    } else {
      reportError(`Compaction failed: ${errText(e)}`)
    }
  } finally {
    compactBusy.value = false
  }
}

/** `/export`: reuse the shared session export download flow (Markdown). */
async function runExportCommand(): Promise<void> {
  const name = selected.value
  if (!name) {
    showNotice('Open a session before using /export.')
    return
  }
  try {
    await downloadSessionExport(name, 'markdown')
    showNotice('Markdown export downloaded.')
  } catch (e) {
    reportError(`Export failed: ${errText(e)}`)
  }
}

/** One first-party base action chosen from the `/` menu or typed directly. */
function onComposerCommand(request: ComposerCommandRequest): void {
  lastCommandMode.value = request.mode
  const action = request.action
  if (!isBaseCommandAction(action)) {
    showNotice(`/${request.name} is not available in the web workspace yet.`)
    return
  }
  switch (action) {
    case 'compact':
      void runCompactCommand()
      break
    case 'export':
      void runExportCommand()
      break
    case 'help':
      openShortcutHelp(request.baseCommands, request.commands)
      break
    case 'status':
      if (!selected.value) {
        showNotice('Open a session to see its status.')
        break
      }
      lastCommandMode.value = request.mode
      statusOpen.value = true
      break
    case 'permission':
      permissionOpen.value = true
      break
    case 'mode':
      showNotice('Use the Mode control next to the composer to switch cooperation modes.')
      break
    case 'new':
      newSessionOpen.value = true
      break
  }
}

/** `?` (fixed alias) or the current shortcut-reference chord opens the reference. */
function onHelpShortcut(e: KeyboardEvent): void {
  if (e.defaultPrevented || e.isComposing || e.keyCode === 229 || e.repeat) return
  // The plain `?` alias is deliberately fixed; only the modifier chord is
  // rebindable (Settings → Keyboard).
  const questionMarkAlias =
    e.key === '?' && e.ctrlKey !== true && e.metaKey !== true && e.altKey !== true
  const boundChord = matchesBinding(e, keybindings.value['shortcut-help'])
  if (!questionMarkAlias && !boundChord) return
  const target = e.target instanceof Element ? e.target : null
  const editable = !!target?.closest('input, textarea, [contenteditable="true"]')
  // `?` typed inside a text field is just a question mark; a modifier chord is safe
  if (editable && !e.ctrlKey && !e.metaKey) return
  // a dialog already owns the screen (help itself included)
  if (document.querySelector('[role="dialog"]')) return
  e.preventDefault()
  openShortcutHelp()
}

let lastEscapeAt: number | null = null

/** Double Escape (≤500 ms) inside the conversation stops the followed run. */
function onStopShortcut(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return
  const target = e.target instanceof Element ? e.target : null
  const approvalFocused = !!target?.closest('.approval, .approval-dock, [role="dialog"]')
  const inConversation =
    !target || target === document.body || !!target.closest('.chat-shell')
  const usable = canUseStopGesture({
    runActive: runActive.value,
    composing: e.isComposing || e.keyCode === 229,
    repeat: e.repeat,
    defaultPrevented: e.defaultPrevented,
    dialogOpen: !!document.querySelector('[role="dialog"]'),
    approvalFocused,
    drawerOpen: drawerQuery?.matches === true && !sidebarCollapsed.value,
    outsideConversation: !inConversation,
  })
  if (!usable) {
    lastEscapeAt = null
    return
  }
  const now = Date.now()
  if (isStopGesture(lastEscapeAt, now)) {
    lastEscapeAt = null
    // the existing stop endpoint; requestStop is fail-soft (error toast only)
    void requestStop()
  } else {
    lastEscapeAt = now
  }
}

/** Sidebar deleted a session: drop the selection/view state if it was open, then re-list. */
function onSessionDeleted(name: string) {
  if (selected.value === name) {
    selected.value = null
    events.value = []
    setRuntimeHistory([])
  }
  if (queueBySession.value[name]) {
    const queues = { ...queueBySession.value }
    delete queues[name]
    queueBySession.value = queues
  }
  // submission bookkeeping for the deleted session can never finalize
  const staleRequests = Object.entries(requestByRun.value).filter(
    ([, request]) => request.session === name,
  )
  if (staleRequests.length > 0) {
    const requests = { ...requestByRun.value }
    for (const [runId] of staleRequests) delete requests[runId]
    requestByRun.value = requests
  }
  const rest = { ...runUsageBySession.value }
  delete rest[name]
  runUsageBySession.value = rest
  // the estimate belongs to the deleted session too; never resurrect it
  const costs = { ...runCostBySession.value }
  delete costs[name]
  runCostBySession.value = costs
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
  // the same Escape that closed the drawer must not arm the double-Esc stop
  lastEscapeAt = null
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

/**
 * naive-ui overrides for the current scheme plus the operator-selected accent:
 * the static base palette provides every non-accent value, and the accent
 * mapping from ./theme overrides the primary family so NATIVE naive-ui primary
 * controls (n-button type=primary, switches, input focus borders, …) follow
 * Settings → Appearance exactly like the CSS-token chrome. Computed, so an
 * accent or light/dark change re-renders native controls immediately.
 */
const configThemeOverrides = computed(() => {
  const scheme = isDark.value ? 'dark' : 'light'
  const base = isDark.value ? darkThemeOverrides : themeOverrides
  return {
    ...base,
    common: { ...base.common, ...accentThemeOverrides(accent.value, scheme).common },
  }
})
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
  window.addEventListener('keydown', onHelpShortcut)
  window.addEventListener('keydown', onStopShortcut)
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
  window.removeEventListener('keydown', onHelpShortcut)
  window.removeEventListener('keydown', onStopShortcut)
  if (sidebarTimer) clearInterval(sidebarTimer)
  if (reconnectTimer) clearTimeout(reconnectTimer)
  if (commandNoticeTimer) clearTimeout(commandNoticeTimer)
  settingsRequest++
  resetStreamingDraft()
  es?.close()
  // leave the tab with the product name, never a stale session/status marker
  if (typeof document !== 'undefined') document.title = tabTitle()
})
</script>

<template>
  <n-config-provider
    :theme="isDark ? darkTheme : lightTheme"
    :theme-overrides="configThemeOverrides"
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
      @forked="onSessionForked"
      @rename-workspace="openWorkspaceRename"
      @move-workspace="onMoveWorkspace"
      :theme-mode="themeMode"
      @open-settings="openSettings()"
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
          <span v-if="queuedCount > 0" class="provider-chip">
            {{ queuedCount === 1 ? '1 queued' : `${queuedCount} queued` }}
          </span>
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
          @click="openSettings()"
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
        :session-id="selected"
        :timeline="timeline"
        :loading="loading"
        :activity="activity"
        :streaming="streamingView"
        :show-prompt-audits="showPromptAudits"
        :find-binding="keybindings.find"
        :rewind-for="rewindForSeq"
        :on-rewind="requestRewind"
        :fork-from-here-for="forkFromHereFor"
        :on-fork-from-here="requestForkFromHere"
        :on-quote="appendQuoteToComposer"
        :live-run-id="activeRun?.run_id ?? null"
        :resolve-approval="resolveApproval"
        :docked-approval-id="pendingApproval?.approvalId ?? null"
        :run-error="runError"
        :on-retry="retryLastRun"
      >
        <!-- Empty transcript: the hero replaces the bare hint. Slot content is
             compiled in App scope, so its actions reach the shell state. -->
        <template #empty>
          <WelcomeHero
            variant="empty"
            :workspace-name="heroWorkspaceName"
            :workspace-count="workspaces.length"
            :session-title="title"
            :models-ready="modelsUsable"
            :starters="HERO_STARTERS"
            @starter="prefillComposer"
            @new-session="newSessionOpen = true"
            @add-workspace="workspaceDialogOpen = true"
            @open-help="openShortcutHelp()"
            @open-settings="openSettings()"
            :palette-label="paletteShortcut"
          />
        </template>
      </ChatView>
      <div v-else class="chat-scroll welcome">
        <WelcomeHero
          variant="start"
          :workspace-name="heroWorkspaceName"
          :workspace-count="workspaces.length"
          :models-ready="modelsUsable"
          :starters="HERO_STARTERS"
          @starter="prefillComposer"
          @new-session="newSessionOpen = true"
          @add-workspace="workspaceDialogOpen = true"
          @open-help="openShortcutHelp()"
          @open-settings="openSettings()"
          :palette-label="paletteShortcut"
        />
      </div>

      <!-- Queue changes are announced from a persistent live region: the dock
           appears/disappears with the queue, and an inserted live region is
           often not read until it changes. -->
      <p class="visually-hidden" role="status" aria-live="polite">
        {{ queueAnnouncement }}
      </p>

      <DiffReview v-if="selected && changedFiles.length" :files="changedFiles" />

      <!-- Run-scoped file undo for the newest completed run: only offered when
           no run is live and no compaction is in flight, and hidden for a run
           whose preview answered 404 (older backend / no record) — never a
           permanently dead disabled control. -->
      <div
        v-if="selected && undoTarget"
        class="run-undo-bar"
        role="group"
        aria-label="Undo this run's file changes"
      >
        <span class="run-undo-bar-text">{{ undoHint }}</span>
        <button
          type="button"
          class="run-undo-open"
          :disabled="undoLoading"
          @click="openUndoPreview"
        >
          {{ undoLoading ? 'Loading file changes…' : UNDO_ACTION_LABEL }}
        </button>
      </div>

      <!-- The model's plan: display-only and per session (the runtime sidecar
           replays it on reload). An older backend never emits it → no dock. -->
      <TodoPanel
        v-if="selected"
        :todos="todoPlan"
        :session="selected"
      />

      <div v-if="pendingApproval" class="approval-dock">
        <p class="approval-dock-label" role="status">
          <span class="approval-dock-dot" aria-hidden="true"></span>
          Waiting for your approval — the run stays paused until you allow or deny.
        </p>
        <ApprovalCard :item="pendingApproval" :resolve="resolveApproval" />
      </div>

      <!-- Submissions accepted while a run works wait in the backend FIFO; the
           dock shows the bounded queue behind the current run, never "steering". -->
      <QueueDock
        v-if="selected && queueView.queuedCount > 0"
        :rows="queueView.waiting"
        :hidden="queueView.hidden"
        :stopping="queueStopping"
        @stop="stopQueuedRun"
      />

      <UsageFooter
        :live="liveHere"
        :waiting="waitingHere"
        :started-at="runStartedAt"
        :turns="turns"
        :usage="usageForSelected"
        :cost="costForSelected"
      />
      <Composer
        :session-id="selected"
        :workspace-id="composerWorkspaceId"
        :busy="live"
        :queued-count="queuedCount"
        :waiting="waiting"
        :compacting="compactBusy"
        :stopping="stopping"
        :settings-version="settingsVersion"
        :submit-result="submitResult"
        :steerable="steerable"
        :steer-help="steerView.help"
        :steer-pending="steerPending"
        :steer-result="steerResult"
        :latest-audit="latestPromptAudit"
        :prefill="composerPrefill"
        :quote="composerQuote"
        @submit="startNewRun"
        @steer="steerActiveRun"
        @stop="requestStop"
        @open-settings="openSettings()"
        @open-permissions="openSettings('permissions')"
        @models-changed="onComposerModelsChanged"
        @command="onComposerCommand"
        @notice="showNotice"
      />
    </div>

    <ErrorToast :messages="errors" @dismiss="(i) => errors.splice(i, 1)" />

    <div v-if="commandNotice" class="command-notice" role="status" aria-live="polite">
      <span class="command-notice-text">{{ commandNotice }}</span>
      <button
        type="button"
        class="command-notice-close"
        title="Dismiss"
        aria-label="Dismiss notice"
        @click="dismissNotice"
      >
        ×
      </button>
    </div>

    <SettingsDialog
      v-if="settingsOpen"
      :initial-section="settingsSection"
      :theme-mode="themeMode"
      :density="density"
      :accent="accent"
      :role-theme="roleTheme"
      :show-prompt-audits="showPromptAudits"
      :keybindings="keybindings"
      @close="settingsOpen = false"
      @saved="onSettingsSaved"
      @theme-change="onThemeChange"
      @density-change="setDensity"
      @accent-change="setAccent"
      @role-theme-change="setRoleTheme"
      @show-prompt-audits-change="setShowPromptAudits"
      @keybindings-change="onKeybindingsChange"
    />
    <WorkspaceDialog v-if="workspaceDialogOpen" @close="onWorkspaceDialogClose" />
    <RewindDialog
      v-if="rewindTarget && selected"
      :session="selected"
      :preview="rewindTarget"
      @close="rewindTarget = null"
      @rewound="onSessionRewound"
      @error="reportError"
    />
    <AppDialog
      v-if="forkFromHereTarget"
      :show="true"
      size="sm"
      title="Fork from here?"
      :description="`Session ${forkFromHereTarget.session}`"
      :persistent="forkFromHereBusy"
      initial-focus=".fork-from-here-cancel"
      @close="closeForkFromHere"
    >
      <div class="fork-from-here-body">
        <p class="fork-from-here-copy">
          {{ forkFromHereConfirmation(forkFromHereTarget) }}
        </p>
        <p class="fork-from-here-hint">
          The new fork opens when it is ready; the original keeps its place in the sidebar.
        </p>
        <p v-if="forkFromHereError" class="fork-from-here-error" role="alert">
          {{ forkFromHereError }}
        </p>
      </div>

      <template #footer>
        <n-button
          attr-type="button"
          class="fork-from-here-cancel"
          :disabled="forkFromHereBusy"
          @click="closeForkFromHere"
        >
          Cancel
        </n-button>
        <n-button
          attr-type="button"
          type="primary"
          class="fork-from-here-confirm"
          :loading="forkFromHereBusy"
          @click="confirmForkFromHere"
        >
          {{ forkFromHereBusy ? 'Forking…' : FORK_FROM_HERE_LABEL }}
        </n-button>
      </template>
    </AppDialog>
    <RunUndoDialog
      v-if="undoPreview && selected"
      :session="selected"
      :run-id="undoPreview.runId"
      :preview="undoPreview.preview"
      @close="undoPreview = null"
      @applied="onUndoApplied"
      @discarded="onUndoDiscarded"
      @error="reportError"
    />
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
    <ShortcutHelpDialog
      v-if="helpOpen"
      :base-commands="helpCatalog.baseCommands"
      :commands="helpCatalog.commands"
      :catalog-state="helpCatalogState"
      :keybindings="keybindings"
      @close="helpOpen = false"
    />
    <SessionStatusDialog
      v-if="statusOpen"
      :session="selectedSessionInfo"
      :workspace-name="selectedWorkspaceName"
      :mode="lastCommandMode"
      :run-status="activeRun?.status ?? null"
      :roles="settings"
      :usage="usageForSelected"
      :turns="turns"
      :events="events.length"
      @close="statusOpen = false"
    />
    <PermissionInfoDialog
      v-if="permissionOpen"
      @close="permissionOpen = false"
      @open-settings="permissionOpen = false; openSettings('permissions')"
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
  border-radius: var(--radius-sm);
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
  border-radius: var(--radius-sm);
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

/* Header affordance for the keyboard-first palette (default Ctrl/⌘+K; the
   label follows the rebindable binding). It is a
   button as well, so the palette is discoverable without knowing the chord. */
.palette-chip {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 0.35rem;
  padding: 0.18rem var(--space-2);
  font-size: 0.75rem;
  color: var(--text-secondary);
  background: transparent;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-pill);
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
  border-radius: var(--radius-xs);
}

@media (max-width: 640px) {
  .palette-chip-label {
    display: none;
  }
}

/* Run-scoped file undo bar: a quiet row above the composer, present only when
   the newest completed run's changes can be reviewed (never during a run). */
.run-undo-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.35rem 0.6rem;
  margin: 0 auto;
  width: 100%;
  max-width: var(--composer-max-width, 880px);
  padding: 0.4rem var(--space-3);
  color: var(--text-secondary);
  background: var(--surface-panel);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
}

.run-undo-bar-text {
  flex: 1 1 16rem;
  min-width: 0;
  font-size: 0.76rem;
  line-height: 1.35;
}

.run-undo-open {
  flex: none;
  padding: 0.2rem 0.7rem;
  font: inherit;
  font-size: 0.76rem;
  color: var(--text-primary);
  background: var(--surface-canvas);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  cursor: pointer;
}

.run-undo-open:hover:not(:disabled) {
  background: var(--surface-hover);
}

.run-undo-open:disabled {
  cursor: progress;
  opacity: 0.6;
}

/* Fork-from-here confirmation: the copy names the cut and the untouched
   source; a failed request stays inline (role=alert) so nothing looks forked. */
.fork-from-here-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  font-size: 0.82rem;
  line-height: 1.5;
}

.fork-from-here-copy {
  margin: 0;
  color: var(--text-primary);
}

.fork-from-here-hint {
  margin: 0;
  color: var(--text-secondary);
  font-size: 0.78rem;
}

.fork-from-here-error {
  margin: 0;
  color: var(--danger);
  font-size: 0.78rem;
  line-height: 1.4;
}
</style>
