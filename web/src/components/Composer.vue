<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NButton, NPopover } from 'naive-ui'
import {
  ApiError,
  getSettings,
  listCommands,
  listSkills,
  listWorkspaceFiles,
} from '../api'
import type { SettingsResponse } from '../api'
import {
  MODE_COMMAND_USAGE,
  commandSectionCount,
  commandUsageLine,
  isBaseCommandAction,
  mergeCommandSections,
  parseSubmittedCommand,
  resolveModeCommandArg,
  resolveTypedCommand,
  typedCommandNotice,
} from '../basecommands'
import type { ComposerCommandRequest } from '../basecommands'
import { canSubmitComposer, classifyComposerKey, classifyComposerRecall, composerLockReason } from '../composerKeys'
import type { ComposerKeyInput, ComposerSendContext } from '../composerKeys'
import { composerSeats } from '../composerStatus'
import { clearDraft, getDraft, setDraft } from '../drafts'
import { createRecallState, loadRecall, recordRecall, saveRecall, stepRecall } from '../recall'
import type { RecallState } from '../recall'
import {
  MAX_FILE_ITEMS,
  MENTION_DEBOUNCE_MS,
  MENTION_FOOTER_HINT,
  MENTION_FOOTER_HINT_COMMAND,
  detectMentionTrigger,
  fileMentionItems,
  insertMention,
  mentionPickerHint,
  skillMentionItems,
} from '../mentions'
import type { MentionItem, MentionKind, MentionTrigger } from '../mentions'
import type { PromptAuditItem } from '../runtime'
import type {
  BaseCommand,
  CommandInfo,
  RunMode,
  RunProvider,
  SkillInfo,
  WorkspaceFileEntry,
} from '../types'

const props = defineProps<{
  /** Session the composer belongs to; its unsent text is saved under this id. */
  sessionId?: string | null
  /**
   * Workspace whose files the `@` picker searches (the selected session's
   * workspace, or the active sidebar filter for a not-yet-started session).
   */
  workspaceId?: string | null
  /**
   * Outcome of the last submission. The box clears only when the run request
   * was accepted (`accepted: true`); a rejected request keeps the text and its
   * saved draft, so a usage error never loses what the operator typed.
   */
  submitResult?: { token: number; accepted: boolean } | null
  /**
   * A run is working on the session (queued/running): the box stays usable and
   * a submission joins the backend's FIFO queue behind it. This no longer locks
   * sending — see `waiting` for the parked-on-approval block.
   */
  busy: boolean
  /** How many submissions already wait behind the working run (honest copy). */
  queuedCount?: number
  /**
   * A manual context compaction is in flight: the draft stays editable but the
   * composer must not submit (the server rejects a run racing a compaction).
   */
  compacting?: boolean
  /**
   * The followed run is parked on an operator approval. The input stays
   * usable for drafting, but sending is blocked until the approval resolves.
   */
  waiting?: boolean
  stopping: boolean
  settingsVersion?: number
  /**
   * Latest prompt audit of the selected session (per provider call: role, node
   * kind, section/tool names and character lengths). Feeds the context seat;
   * nothing is shown until one exists.
   */
  latestAudit?: PromptAuditItem | null
  /**
   * Shell-requested starter text (welcome/empty-hero suggestions). The token
   * makes every request distinct; the box replaces its draft with the text,
   * saves it and focuses the caret at the end so the operator can edit it.
   */
  prefill?: { token: number; text: string } | null
  /**
   * Dev/test-only provider injection. The normal composer has no provider
   * control and always submits `provider: null` so the per-role settings (or
   * the server environment) decide. A test host may pass `dev-provider`, or
   * open the app with `?provider=mock` / `?provider=openai`; neither path puts
   * provider text in the composer DOM.
   */
  devProvider?: RunProvider | null
}>()

const emit = defineEmits<{
  submit: [
    payload: { task: string; mode: RunMode; provider: RunProvider | null; token: number },
  ]
  stop: []
  openSettings: []
  /** A first-party base action chosen from the `/` menu or typed directly. */
  command: [request: ComposerCommandRequest]
  /** Neutral, composer-local notice for the shell to surface (usage errors…). */
  notice: [message: string]
}>()

interface ModeOption {
  value: RunMode
  label: string
  description: string
}

const MODE_OPTIONS: readonly ModeOption[] = [
  {
    value: 'consult',
    label: 'Consult',
    description: 'The Junior advises; the Senior makes the decision.',
  },
  {
    value: 'work',
    label: 'Work',
    description: 'The Senior delegates the work to the Junior, then verifies it.',
  },
  {
    value: 'auto',
    label: 'Auto',
    description: 'The Senior chooses how to proceed (currently consult).',
  },
]

const task = ref('')
const mode = ref<RunMode>('consult')
const currentMode = computed(
  () => MODE_OPTIONS.find((option) => option.value === mode.value) ?? MODE_OPTIONS[0],
)

/**
 * Optional explicit test injection, plus a documented URL flag for hermetic
 * browser tests. Normal submissions resolve `provider` to null.
 */
const queryProvider = (() => {
  if (typeof window === 'undefined') return null
  const value = new URLSearchParams(window.location.search).get('provider')
  return value === 'mock' || value === 'openai' ? (value as RunProvider) : null
})()
const providerForRun = computed<RunProvider | null>(() => {
  const injected = props.devProvider
  if (injected === 'mock' || injected === 'openai') return injected
  return queryProvider
})

interface RoleRoute {
  provider: string | null
  model: string | null
  providerRef: string | null
  baseUrl: string | null
}

const settings = ref<SettingsResponse | null>(null)
/** Loading until the first settings response; unknown when the request failed. */
const settingsState = ref<'loading' | 'ready' | 'unknown'>('loading')
let settingsRequest = 0

function routeFor(role: 'senior' | 'junior'): RoleRoute | null {
  const view = settings.value?.[role]
  if (!view) return null
  return {
    provider: view.provider?.trim() || null,
    model: view.model?.trim() || null,
    providerRef: view.provider_ref?.trim() || null,
    baseUrl: view.base_url?.trim() || null,
  }
}

const seniorRoute = computed(() => routeFor('senior'))
const juniorRoute = computed(() => routeFor('junior'))

function roleConfigured(route: RoleRoute | null): boolean {
  return Boolean(
    route && (route.provider === 'mock' || (route.model && route.baseUrl)),
  )
}

function missingRoles(): Array<'senior' | 'junior'> {
  if (settingsState.value !== 'ready') return []
  return (['senior', 'junior'] as const).filter(
    (role) => !roleConfigured(role === 'senior' ? seniorRoute.value : juniorRoute.value),
  )
}

const settingsMissing = computed(
  () => providerForRun.value === null && missingRoles().length > 0,
)
const missingLabel = computed(() => {
  const roles = missingRoles()
  if (roles.length === 2) return 'Senior and Junior models'
  if (roles.length === 1) return `${roles[0] === 'senior' ? 'Senior' : 'Junior'} model`
  return 'models'
})

function modelLabel(route: RoleRoute | null): string {
  if (route?.model) return route.model
  if (route?.provider === 'mock') return 'built-in'
  return 'not set'
}

const routeAriaLabel = computed(() => {
  const describe = (role: string, route: RoleRoute | null): string => {
    const model = route?.model || (route?.provider === 'mock' ? 'built-in model' : 'no model set')
    const source = route?.providerRef ? `, ${route.providerRef} preset` : ''
    return `${role}: ${model}${source}`
  }
  return `Model route from settings — ${describe('Senior', seniorRoute.value)}; ${describe(
    'Junior',
    juniorRoute.value,
  )}`
})

async function checkSettings() {
  const request = ++settingsRequest
  if (!settings.value) settingsState.value = 'loading'
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

const inputEl = ref<HTMLTextAreaElement | null>(null)
const MIN_INPUT_HEIGHT = 46
const MAX_INPUT_HEIGHT = 192

function resizeInput() {
  const el = inputEl.value
  if (!el) return
  el.style.height = 'auto'
  const height = Math.min(Math.max(el.scrollHeight, MIN_INPUT_HEIGHT), MAX_INPUT_HEIGHT)
  el.style.height = `${height}px`
  el.style.overflowY = el.scrollHeight > MAX_INPUT_HEIGHT ? 'auto' : 'hidden'
}

/**
 * Why sending is blocked right now. A working run is intentionally NOT a lock:
 * its submission queues behind it. Only a run parked on an approval and an
 * in-flight compaction keep the send control unavailable.
 */
const sendContext = computed<ComposerSendContext>(() => ({
  busy: false,
  waiting: props.waiting,
  compacting: props.compacting,
  text: task.value,
}))

/**
 * One submission is in flight until App reports its outcome (accepted or not).
 * Guards double-submits while the draft intentionally stays in the box.
 */
const pendingSubmit = ref<{ token: number; text: string; sessionId: string | null } | null>(
  null,
)
const submitting = computed(() => pendingSubmit.value !== null)
let submitToken = 0

/** Send availability: text present, no lock, no submission already in flight. */
const canSend = computed(() => !submitting.value && canSubmitComposer(sendContext.value))

const lockReason = computed(() => composerLockReason(sendContext.value))

const placeholder = computed(() => {
  if (lockReason.value === 'compacting') return 'Compacting context — sending unlocks when it finishes…'
  if (lockReason.value === 'waiting') return 'Draft the next task…'
  if (props.busy) return 'Type the next task — it will queue behind the run in progress…'
  return 'Describe a task for the two brothers…'
})

const statusHint = computed(() => {
  if (props.busy && props.stopping) return 'Stopping the run…'
  if (lockReason.value === 'compacting') {
    return 'Compacting context… sending unlocks when it finishes.'
  }
  if (lockReason.value === 'waiting') {
    return 'Drafting only — sending unlocks when the run continues.'
  }
  if (submitting.value) return props.busy ? 'Queueing the task…' : 'Sending the task…'
  if (props.busy) {
    const queued = Math.max(0, props.queuedCount ?? 0)
    const suffix = queued > 0 ? ` ${queued} already queued.` : ''
    return `New tasks queue — they start after the current run finishes.${suffix}`
  }
  return 'Enter to send · Shift+Enter new line · Ctrl/⌘+Enter send now'
})

const settingsHint = computed(
  () => `Set the ${missingLabel.value} in Settings to start a run.`,
)

/**
 * Truthful status seats (models · effective permission mode · latest
 * audit-derived context breakdown). Each seat hides itself when its data is
 * unknown, so the row never shows placeholders or fabricated token counts.
 * The permission seat names the saved approval mode (`ask` when the backend
 * omits the additive section, which is the mode such a backend applies).
 */
const statusSeats = computed(() =>
  composerSeats({
    settingsReady: settingsState.value === 'ready',
    seniorLabel: settings.value ? modelLabel(seniorRoute.value) : null,
    juniorLabel: settings.value ? modelLabel(juniorRoute.value) : null,
    workspaceLinked: Boolean(props.workspaceId),
    approvalMode: settings.value?.approval_policy?.mode ?? null,
    latestAudit: props.latestAudit ?? null,
  }),
)

// -- unsent draft persistence -------------------------------------------------
// The box holds one draft at a time: the active session's unsent text, or —
// with no session selected — the welcome-screen text, remembered in memory.
// Switching without remounting flushes the previous state synchronously and
// restores the next one, so drafts never leak across sessions. Busy/approval-
// waiting changes only lock sending — they must never touch the text or the
// saved copy.

const DRAFT_SAVE_DELAY_MS = 300
let draftSaveTimer: ReturnType<typeof setTimeout> | null = null
/** True while a restore writes `task`; that programmatic change is not saved. */
let restoringDraft = false
/** Welcome-screen draft (no active session), kept in memory until submit. */
let unsessionedDraft = ''

// -- prompt-history recall ----------------------------------------------------
// Up/Down at the draft edges recall accepted submissions, newest first (the
// same contract as the TUI composer). Browsing is in memory: the live draft is
// stashed in `recallState.draft` and restored exactly, and the drafts blob is
// deliberately left alone while a recalled entry is on screen. Entries are
// recorded only when App reports an accepted submission (`submitResult`), so an
// unsent draft is never recallable and navigation never appends.
const recallEntries = ref<string[]>([])
let recallState: RecallState = createRecallState()
/** True while a recall step writes `task`; that change is not a draft edit. */
let applyingRecall = false

function cancelDraftSave() {
  if (draftSaveTimer === null) return
  clearTimeout(draftSaveTimer)
  draftSaveTimer = null
}

/** Write the current text for `sessionId` now (session switch / unmount). */
function flushDraft(sessionId: string | null | undefined = props.sessionId) {
  cancelDraftSave()
  // While a recalled entry is on screen the operator's live draft is the
  // stashed one: the recalled text must never overwrite the saved draft.
  const text = recallState.active ? recallState.draft : task.value
  if (!sessionId) {
    // no storage key for the welcome screen — remember the text in memory
    unsessionedDraft = text
    return
  }
  setDraft(sessionId, text)
}

/** Show `sessionId`'s saved draft, or the remembered welcome-screen text. */
function restoreDraft(sessionId: string | null | undefined) {
  cancelDraftSave()
  // A restored draft replaces the box, so any recall browsing is over.
  recallState = createRecallState()
  applyingRecall = false
  restoringDraft = true
  task.value = sessionId ? getDraft(sessionId) : unsessionedDraft
  void nextTick(() => {
    restoringDraft = false
  })
}

/**
 * null -> id: a non-empty welcome-screen draft follows the operator into the
 * session they just picked (persisted under that id), unless the session
 * already has its own saved draft — then that saved draft wins.
 */
function adoptOrRestore(sessionId: string) {
  if (getDraft(sessionId) === '' && task.value.trim().length > 0) {
    setDraft(sessionId, task.value)
    return
  }
  restoreDraft(sessionId)
}

function scheduleDraftSave() {
  if (restoringDraft || applyingRecall || recallState.active) return
  if (!props.sessionId) {
    // nothing to key the welcome-screen draft to; the in-memory copy is enough
    unsessionedDraft = task.value
    return
  }
  cancelDraftSave()
  const sessionId = props.sessionId
  draftSaveTimer = setTimeout(() => {
    draftSaveTimer = null
    // the selection may have moved while the timer was pending
    if (props.sessionId !== sessionId) return
    setDraft(sessionId, task.value)
  }, DRAFT_SAVE_DELAY_MS)
}

function submit() {
  // submitting always closes the mention picker (the text now owns the task)
  closePicker()
  // one request at a time: the draft stays in the box until App reports the
  // outcome, so a second Enter must not send the same text again
  if (submitting.value) return
  const text = task.value.trim()
  // Locked states keep the draft intact: a run parked on an approval and an
  // in-flight context compaction (the server rejects a run that races one).
  // A working run is not a lock — the submission queues behind it.
  if (!canSubmitComposer(sendContext.value)) return
  // a typed `/action` is performed locally instead of becoming a run
  if (interceptCommandSubmit()) return
  const token = ++submitToken
  pendingSubmit.value = { token, text, sessionId: props.sessionId ?? null }
  emit('submit', {
    task: text,
    mode: mode.value,
    provider: providerForRun.value,
    token,
  })
  // The box is cleared by the acceptance handshake below, never optimistically:
  // a rejected request (e.g. a server usage error) keeps text and draft.
}

/**
 * App reports each submission's outcome. On acceptance the accepted text is
 * consumed — unless the operator already typed something new, which stays.
 * On rejection nothing is cleared: the draft is exactly where it was.
 */
watch(
  () => props.submitResult,
  (result) => {
    const pending = pendingSubmit.value
    if (!result || !pending || result.token !== pending.token) return
    pendingSubmit.value = null
    if (!result.accepted) return
    // Only accepted submissions (a run the backend queued included) join the
    // recall history; a rejected request must never become recallable.
    rememberRecall(pending.text)
    if (props.sessionId === pending.sessionId) {
      // same box: only clear when it still holds the submitted text
      if (task.value.trim() === pending.text) consumeComposerText()
      return
    }
    // the selection moved on while the request was in flight; the accepted
    // task's saved draft (under its old session) must not reappear later
    if (pending.sessionId) clearDraft(pending.sessionId)
    else unsessionedDraft = ''
  },
)

/** Clear the whole draft (a submit or a consumed base command). */
function consumeComposerText() {
  cancelDraftSave()
  recallState = createRecallState()
  applyingRecall = false
  clearDraft(props.sessionId)
  unsessionedDraft = ''
  task.value = ''
}

// -- prompt-history recall (keyboard) ----------------------------------------
// Up on a single-line draft (or the very start of a multiline one) recalls the
// newest accepted submission; Down steps forward again, restoring the stashed
// draft past the newest entry. Any other arrow usage keeps the textarea's own
// caret movement. A recalled entry is programmatic text: it never saves to the
// drafts blob, and typing over it ends browsing (the pre-recall draft is
// dropped, exactly like editing a recalled task in the TUI).

/** The caret/textarea facts the recall boundary rule reads. */
function recallCaret(): { text: string; selectionStart: number; selectionEnd: number } {
  const el = inputEl.value
  const text = composerValue()
  const start = el && typeof el.selectionStart === 'number' ? el.selectionStart : text.length
  const end = el && typeof el.selectionEnd === 'number' ? el.selectionEnd : text.length
  return { text, selectionStart: start, selectionEnd: end }
}

/** Place recalled text in the box without treating it as an operator edit. */
function showRecalledText(text: string): void {
  cancelDraftSave()
  applyingRecall = true
  task.value = text
  void nextTick(() => {
    applyingRecall = false
    const el = inputEl.value
    if (!el) return
    const end = text.length
    el.focus()
    try {
      el.setSelectionRange(end, end)
    } catch {
      // a detached/disabled textarea must never throw while restoring the caret
    }
    resizeInput()
  })
}

/** One Up/Down recall step (the keystroke was already consumed). */
function applyRecallStep(action: 'recall-previous' | 'recall-next'): void {
  const liveText = composerValue()
  if (!recallState.active) {
    // Capture the unsent draft synchronously before the box is replaced, so
    // stepping back to it — or switching sessions — restores exactly this text
    // while drafts.ts keeps its copy.
    flushDraft()
  }
  const step = stepRecall(
    recallState,
    action === 'recall-previous' ? 'previous' : 'next',
    recallEntries.value,
    liveText,
  )
  if (step.text === null) return
  recallState = step.state
  showRecalledText(step.text)
}

/** Record one accepted submission and persist the bounded history. */
function rememberRecall(text: string): void {
  recallEntries.value = recordRecall(recallEntries.value, text)
  saveRecall(recallEntries.value)
}

// -- @ mention and / command pickers -----------------------------------------
// Typing `@` opens skills + workspace files, `@skill:` narrows to skills and a
// line-start `/` opens discovered slash commands. The textarea keeps DOM focus:
// the popover is a listbox driven by `aria-activedescendant`, and catalogs are
// fetched lazily (skills/commands once per settings version; files per query
// with a debounce + monotonic token so stale answers never win).

const mentionListId = 'composer-mention-list'
const pickerList = ref<HTMLElement | null>(null)
const pickerTrigger = ref<MentionTrigger | null>(null)
const pickerActive = ref(-1)
const pickerOpen = computed(() => pickerTrigger.value !== null)
/** Escape dismissed this token; further typing re-arms the picker. */
let pickerDismissed: MentionTrigger | null = null

const skills = ref<SkillInfo[]>([])
const commands = ref<CommandInfo[]>([])
const baseCommands = ref<BaseCommand[]>([])
const skillsState = ref<'idle' | 'loading' | 'ready' | 'error'>('idle')
const commandsState = ref<'idle' | 'loading' | 'ready' | 'error'>('idle')
let skillsRequest = 0
let commandsRequest = 0

const files = ref<WorkspaceFileEntry[]>([])
const filesState = ref<'idle' | 'loading' | 'ready' | 'error' | 'unsupported'>('idle')
/** Workspace + query the current `files`/`filesState` belong to. */
const filesWorkspace = ref<string | null>(null)
const filesQuery = ref('')
let filesRequest = 0
let filesTimer: ReturnType<typeof setTimeout> | null = null

const pickerKind = computed<MentionKind | null>(() => pickerTrigger.value?.kind ?? null)
const pickerQuery = computed(() => pickerTrigger.value?.query ?? '')
/** `/` menu: built-in base commands + discovered templates, filtered by query. */
const commandSections = computed(() =>
  mergeCommandSections(commands.value, baseCommands.value, pickerQuery.value),
)
const commandRowCount = computed(() => commandSectionCount(commandSections.value))
const skillItems = computed(() => skillMentionItems(skills.value, pickerQuery.value))
const fileItems = computed(() => fileMentionItems(files.value))

interface PickerRow {
  item: MentionItem
  index: number
}

interface PickerGroupView {
  /** Unique per rendered section (aria ids, not just the kind). */
  id: string
  kind: MentionKind
  label: string
  rows: PickerRow[]
}

/** Rendered groups (empty sections are skipped; indices stay flat-consistent). */
const pickerGroups = computed<PickerGroupView[]>(() => {
  const kind = pickerKind.value
  if (!kind) return []
  const sections: Array<{
    id: string
    kind: MentionKind
    label: string
    items: MentionItem[]
  }> =
    kind === 'command'
      ? commandSections.value.map((section) => ({
          id: section.id,
          kind: 'command' as const,
          label: section.label,
          items: section.items,
        }))
      : [
          { id: 'skills', kind: 'skill' as const, label: 'Skills', items: skillItems.value },
          ...(kind === 'file'
            ? [{ id: 'files', kind: 'file' as const, label: 'Files', items: fileItems.value }]
            : []),
        ]
  let index = 0
  const groups: PickerGroupView[] = []
  for (const section of sections) {
    if (!section.items.length) continue
    groups.push({
      id: section.id,
      kind: section.kind,
      label: section.label,
      rows: section.items.map((item) => ({ item, index: index++ })),
    })
  }
  return groups
})

const pickerFlat = computed<MentionItem[]>(() =>
  pickerGroups.value.flatMap((group) => group.rows.map((row) => row.item)),
)

const mentionOptionId = (index: number) => `composer-mention-option-${index}`
const activeOptionId = computed(() => {
  const item = pickerFlat.value[pickerActive.value]
  if (!pickerOpen.value || !item || item.disabled) return undefined
  return mentionOptionId(pickerActive.value)
})
const pickerFootHint = computed(() =>
  pickerKind.value === 'command' ? MENTION_FOOTER_HINT_COMMAND : MENTION_FOOTER_HINT,
)
const pickerHintLabel = computed(() => mentionPickerHint(pickerKind.value ?? 'file'))

/** Honest per-section status lines (loading / empty / unavailable). */
const pickerNotes = computed<string[]>(() => {
  const kind = pickerKind.value
  if (!kind) return []
  const query = pickerQuery.value.trim()
  const notes: string[] = []

  if (kind === 'skill' || kind === 'file') {
    const items = skillItems.value
    if (skillsState.value === 'error') notes.push('Skills are unavailable.')
    else if (!items.length) {
      const sharedCount = skills.value.filter((skill) => skill.scope === 'shared').length
      if (skillsState.value === 'loading') notes.push('Loading skills…')
      else if (sharedCount === 0) notes.push('No shared skills')
      else if (query) notes.push('No matching skills')
    }
    if (items.some((item) => item.disabled)) {
      notes.push('Role-scoped skills are model-invoked; only shared skills can be attached.')
    }
  }

  if (kind === 'file') {
    if (!props.workspaceId) {
      notes.push('Select a workspace to attach files')
    } else if (filesState.value === 'unsupported') {
      // older backend: the Files group is hidden gracefully (no error noise)
    } else if (filesState.value === 'error') {
      notes.push('Files are unavailable right now.')
    } else if (!fileItems.value.length) {
      if (filesState.value === 'loading') notes.push('Searching files…')
      else notes.push(query ? 'No matching files' : 'No files in this workspace')
    }
  }

  if (kind === 'command') {
    const catalogSize = baseCommands.value.length + commands.value.length
    if (commandsState.value === 'error') notes.push('Slash commands are unavailable.')
    else if (commandRowCount.value === 0) {
      if (commandsState.value === 'loading') notes.push('Loading commands…')
      else if (query && catalogSize > 0) notes.push('No matching commands')
      else notes.push('No commands available')
    }
  }

  return notes
})

function isMissingEndpoint(cause: unknown): boolean {
  return (
    cause instanceof ApiError &&
    (cause.status === 404 || cause.status === 405 || cause.status === 501)
  )
}

function closePicker(): void {
  if (pickerTrigger.value) {
    pickerTrigger.value = null
    pickerActive.value = -1
    // transient failures retry on the next open; a cached catalog stays cached
    if (skillsState.value === 'error') skillsState.value = 'idle'
    if (commandsState.value === 'error') commandsState.value = 'idle'
    if (filesState.value === 'error') filesState.value = 'idle'
  }
  pickerActive.value = -1
}

function dismissPicker(): void {
  pickerDismissed = pickerTrigger.value ? { ...pickerTrigger.value } : null
  closePicker()
}

// -- catalogs (skills + commands) --------------------------------------------

async function loadSkillsCatalog(): Promise<void> {
  if (skillsState.value === 'loading' || skillsState.value === 'ready') return
  const request = ++skillsRequest
  skillsState.value = 'loading'
  try {
    const response = await listSkills()
    if (request !== skillsRequest) return
    skills.value = response.skills
    skillsState.value = 'ready'
  } catch {
    if (request !== skillsRequest) return
    skillsState.value = 'error'
  }
}

async function loadCommandsCatalog(): Promise<void> {
  if (commandsState.value === 'loading' || commandsState.value === 'ready') return
  const request = ++commandsRequest
  commandsState.value = 'loading'
  try {
    const response = await listCommands()
    if (request !== commandsRequest) return
    commands.value = response.commands
    // additive field: an older backend has no base commands at all
    baseCommands.value = response.baseCommands
    commandsState.value = 'ready'
  } catch {
    if (request !== commandsRequest) return
    commandsState.value = 'error'
  }
}

/** Lazy first-open fetch; cached afterwards until the settings version changes. */
function ensureCatalogs(): void {
  if (skillsState.value === 'idle') void loadSkillsCatalog()
  if (commandsState.value === 'idle') void loadCommandsCatalog()
}

/** Drop both catalogs so the next open re-discovers them. */
function resetCatalogs(): void {
  skillsRequest += 1
  commandsRequest += 1
  skills.value = []
  commands.value = []
  baseCommands.value = []
  skillsState.value = 'idle'
  commandsState.value = 'idle'
}

// -- workspace files (per query) ---------------------------------------------

function cancelFileSearch(): void {
  filesRequest += 1
  if (filesTimer) {
    clearTimeout(filesTimer)
    filesTimer = null
  }
  if (filesState.value === 'loading') filesState.value = 'idle'
}

/** Forget the cached file list (workspace/session switch, unmount). */
function resetFileState(): void {
  cancelFileSearch()
  files.value = []
  filesWorkspace.value = null
  filesQuery.value = ''
  filesState.value = 'idle'
}

function scheduleFileSearch(query: string): void {
  const workspaceId = props.workspaceId ?? null
  if (!workspaceId) {
    cancelFileSearch()
    files.value = []
    filesWorkspace.value = null
    filesQuery.value = ''
    filesState.value = 'idle'
    return
  }
  if (filesWorkspace.value !== workspaceId) {
    // a different workspace means different files; never show the old list
    files.value = []
    filesState.value = 'idle'
    filesWorkspace.value = null
    filesQuery.value = ''
  }
  const normalized = query.trim()
  if (
    filesWorkspace.value === workspaceId &&
    filesQuery.value === normalized &&
    (filesState.value === 'ready' || filesState.value === 'loading')
  ) {
    return
  }
  if (filesTimer) {
    clearTimeout(filesTimer)
    filesTimer = null
  }
  filesRequest += 1
  const request = filesRequest
  filesWorkspace.value = workspaceId
  filesQuery.value = normalized
  filesState.value = 'loading'
  filesTimer = setTimeout(() => {
    filesTimer = null
    void runFileSearch(workspaceId, normalized, request)
  }, MENTION_DEBOUNCE_MS)
}

async function runFileSearch(
  workspaceId: string,
  query: string,
  request: number,
): Promise<void> {
  try {
    const response = await listWorkspaceFiles(workspaceId, query, MAX_FILE_ITEMS)
    if (request !== filesRequest) return // a newer query owns the picker
    files.value = response.files
    filesState.value = 'ready'
  } catch (cause) {
    if (request !== filesRequest) return
    files.value = []
    filesState.value = isMissingEndpoint(cause) ? 'unsupported' : 'error'
  }
}

// -- trigger tracking & keyboard ---------------------------------------------

function syncPicker(): void {
  const el = inputEl.value
  const value = el ? el.value : task.value
  const caret =
    el && typeof el.selectionStart === 'number' ? el.selectionStart : value.length
  const trigger = detectMentionTrigger(value, caret)
  if (!trigger) {
    pickerDismissed = null
    closePicker()
    return
  }
  // Escape dismissed exactly this token; moving to another token/typing re-arms
  if (
    pickerDismissed &&
    pickerDismissed.kind === trigger.kind &&
    pickerDismissed.start === trigger.start
  ) {
    closePicker()
    return
  }
  pickerDismissed = null
  const previous = pickerTrigger.value
  const changed =
    !previous ||
    previous.kind !== trigger.kind ||
    previous.start !== trigger.start ||
    previous.query !== trigger.query
  pickerTrigger.value = trigger
  ensureCatalogs()
  if (trigger.kind === 'file') scheduleFileSearch(trigger.query)
  if (changed) {
    pickerActive.value = -1
    ensureActive()
  }
}

/** The input event owns text changes; typing re-arms a dismissed picker. */
function onInput(): void {
  // Editing a recalled entry turns it into the live draft: history browsing
  // ends and the operator's new text is the draft from here on (the same rule
  // as editing a recalled task in the TUI composer).
  if (recallState.active) recallState = createRecallState()
  pickerDismissed = null
  syncPicker()
}

/**
 * True for the duration of a press on the picker. The textarea's blur fires
 * between pointerdown and click; without this guard, mutating the selection
 * (mouse) would unmount the row before its click handler could insert it.
 */
let pickerPressing = false

function onPickerPointerDown(): void {
  pickerPressing = true
  window.setTimeout(() => {
    pickerPressing = false
  }, 0)
}

/** Leaving the box (Send, chips, elsewhere) closes the picker. */
function onTextareaBlur(): void {
  // a fresh focus should be able to reopen the token (Escape dismissal is
  // scoped to the current uninterrupted edit)
  pickerDismissed = null
  if (pickerPressing) return
  closePicker()
}

function firstEnabledIndex(items: MentionItem[], from: number): number {
  if (!items.length) return -1
  for (let offset = 0; offset < items.length; offset += 1) {
    const index = ((from % items.length) + items.length + offset) % items.length
    if (!items[index]?.disabled) return index
  }
  return -1
}

function ensureActive(): void {
  const items = pickerFlat.value
  if (!items.length) {
    pickerActive.value = -1
    return
  }
  const current = items[pickerActive.value]
  if (current && !current.disabled) return
  pickerActive.value = firstEnabledIndex(items, Math.max(pickerActive.value, 0))
}

function stepPicker(step: number): void {
  const items = pickerFlat.value
  if (!items.length) return
  const enabled: number[] = []
  for (let index = 0; index < items.length; index += 1) {
    if (!items[index]?.disabled) enabled.push(index)
  }
  if (!enabled.length) {
    pickerActive.value = -1
    return
  }
  const current = enabled.indexOf(pickerActive.value)
  const next =
    current < 0
      ? step > 0
        ? 0
        : enabled.length - 1
      : (current + step + enabled.length) % enabled.length
  pickerActive.value = enabled[next] ?? -1
}

function activePickerItem(): MentionItem | null {
  const item = pickerFlat.value[pickerActive.value]
  return item && !item.disabled ? item : null
}

/** Replace the active token and put focus/caret back on the textarea. */
function insertPickerItem(item: MentionItem | null): boolean {
  const trigger = pickerTrigger.value
  const el = inputEl.value
  if (!item || item.disabled || !trigger || !item.token || !el) return false
  const text = el.value
  const caret = typeof el.selectionStart === 'number' ? el.selectionStart : text.length
  const result = insertMention(text, caret, trigger, item.token)
  task.value = result.text
  closePicker()
  const restoredCaret = result.caret
  void nextTick(() => {
    const textarea = inputEl.value
    if (!textarea) return
    textarea.focus()
    try {
      textarea.setSelectionRange(restoredCaret, restoredCaret)
    } catch {
      // a detached/disabled textarea must never throw while restoring the caret
    }
    resizeInput()
  })
  return true
}

// -- first-party base commands (actions run locally) -------------------------
// Selecting a base action row (or typing `/action` and pressing Enter) never
// submits a run: the composer consumes the command text and emits `command` for
// the shell to perform it. Actions that need arguments are inserted first so
// the operator can type them; an unsupported action becomes a clear notice.

/** The textarea value is the source of truth (v-model can lag one event). */
function composerValue(): string {
  return inputEl.value?.value ?? task.value
}

function composerCaret(): number {
  const el = inputEl.value
  return el && typeof el.selectionStart === 'number'
    ? el.selectionStart
    : composerValue().length
}

/** Replace the consumed command span, keep any other draft text, refocus. */
function consumeCommandSpan(start: number, caret: number): void {
  const text = composerValue()
  const from = Math.min(Math.max(start, 0), text.length)
  const to = Math.min(Math.max(caret, from), text.length)
  const next = `${text.slice(0, from)}${text.slice(to)}`
  task.value = next
  cancelDraftSave()
  if (!next.trim()) {
    clearDraft(props.sessionId)
    unsessionedDraft = ''
  }
  void nextTick(() => {
    const textarea = inputEl.value
    if (!textarea) return
    textarea.focus()
    try {
      textarea.setSelectionRange(from, from)
    } catch {
      // a detached/disabled textarea must never throw while restoring the caret
    }
    resizeInput()
  })
}

function emitCommandRequest(
  action: ComposerCommandRequest['action'],
  name: string,
  args: string,
  requiresArguments: boolean,
): void {
  emit('command', {
    action,
    name,
    args,
    requiresArguments,
    baseCommands: [...baseCommands.value],
    commands: [...commands.value],
    mode: mode.value,
  })
}

/** Run one picker row: action rows act/insert locally, everything else inserts. */
function activatePickerRow(item: MentionItem | null): boolean {
  if (!item || item.disabled) return false
  if (item.action !== undefined) {
    // an action that needs arguments is inserted (`/mode `), never an instant error
    if (item.requiresArguments) return insertPickerItem(item)
    return runActionRow(item)
  }
  return insertPickerItem(item)
}

function runActionRow(item: MentionItem): boolean {
  const action = item.action
  if (action === undefined || !isBaseCommandAction(action)) return false
  const trigger = pickerTrigger.value
  const start = trigger?.kind === 'command' ? trigger.start : 0
  const caret = composerCaret()
  closePicker()
  consumeCommandSpan(start, caret)
  if (action === 'mode') {
    // the cooperation mode is a composer-local control
    openModePicker()
    return true
  }
  emitCommandRequest(action, item.label.replace(/^\//, ''), '', item.requiresArguments === true)
  return true
}

/**
 * A `/command args` line typed directly: base actions run locally, prompt
 * commands submit (the server expands them). Returns true when the composer
 * consumed the text instead of submitting a run.
 */
function interceptCommandSubmit(): boolean {
  const submitted = parseSubmittedCommand(task.value)
  if (!submitted) return false
  const resolution = resolveTypedCommand(baseCommands.value, commands.value, submitted.token)

  if (resolution.kind === 'base-action' || resolution.kind === 'base-prompt') {
    const command = resolution.command
    const args = submitted.args.trim()

    // Only canonical names and ASCII aliases survive the server's ASCII
    // `matchCommand` rule. A typed non-ASCII alias must neither run locally nor
    // be submitted verbatim: name the canonical spelling and keep the draft.
    if (!resolution.typeable) {
      emit('notice', typedCommandNotice(resolution) ?? `Use ${commandUsageLine(command)}`)
      return true
    }

    if (command.kind === 'action') {
      if (command.requiresArguments && args === '') {
        emit('notice', `Usage: ${commandUsageLine(command)}`)
        return true
      }
      if (!isBaseCommandAction(command.action)) {
        emit('notice', `/${command.name} is not available in the web workspace yet.`)
        return true
      }
      if (command.action === 'mode') {
        // `/mode <arg>` applies the mode; `/mode` alone opens the control.
        const modeArg = resolveModeCommandArg(args)
        if (modeArg.kind === 'invalid') {
          emit('notice', `Usage: ${MODE_COMMAND_USAGE}`)
          return true
        }
        consumeComposerText()
        if (modeArg.kind === 'apply') {
          mode.value = modeArg.mode
          emit('notice', `Cooperation mode: ${modeArg.mode === 'work' ? 'Work' : 'Consult'}`)
        } else {
          openModePicker()
        }
        return true
      }
      consumeComposerText()
      emitCommandRequest(command.action, command.name, args, command.requiresArguments)
      return true
    }

    // prompt command: fail loudly with the usage line instead of submitting an
    // empty template; otherwise the server expands it normally
    if (command.requiresArguments && args === '') {
      emit('notice', `Usage: ${commandUsageLine(command)}`)
      return true
    }
    return false
  }

  return false
}

/** Scroll only the picker list so the active row stays visible. */
function scrollActiveIntoView(): void {
  const list = pickerList.value
  const index = pickerActive.value
  if (!list || index < 0) return
  const option = list.querySelector<HTMLElement>(`#${mentionOptionId(index)}`)
  if (!option) return
  const listRect = list.getBoundingClientRect()
  const optionRect = option.getBoundingClientRect()
  if (optionRect.top < listRect.top) {
    list.scrollTop -= listRect.top - optionRect.top
  } else if (optionRect.bottom > listRect.bottom) {
    list.scrollTop += optionRect.bottom - listRect.bottom
  }
}

function keyInput(e: KeyboardEvent): ComposerKeyInput {
  return {
    key: e.key,
    shiftKey: e.shiftKey,
    ctrlKey: e.ctrlKey,
    metaKey: e.metaKey,
    altKey: e.altKey,
    isComposing: e.isComposing,
    keyCode: e.keyCode,
    repeat: e.repeat,
  }
}

/** Keys owned by the open picker; returns true when the event was consumed. */
function onPickerKeydown(e: KeyboardEvent): boolean {
  switch (classifyComposerKey(keyInput(e), true)) {
    case 'picker-close':
      e.preventDefault()
      e.stopPropagation()
      dismissPicker()
      return true
    case 'picker-accept':
      e.preventDefault()
      if (!activatePickerRow(activePickerItem())) closePicker()
      return true
    case 'picker-next':
      e.preventDefault()
      stepPicker(1)
      return true
    case 'picker-prev':
      e.preventDefault()
      stepPicker(-1)
      return true
    case 'newline':
      return false
    default:
      return false
  }
}

function onKeydown(e: KeyboardEvent) {
  // an open picker owns Enter/Tab/arrows/Escape: Enter/Tab accept, Shift+Enter
  // keeps the newline, Shift+Tab/Escape close, and Enter can never submit
  if (pickerOpen.value && onPickerKeydown(e)) return
  // Up/Down at the draft edges recall accepted submissions (never an unsent
  // draft, never a submit); an open picker above keeps its own arrow handling.
  // The bridge returns null for any keystroke that is not an actual recall
  // step (nothing to recall, an inactive Down, the wrong caret edge,
  // IME/modifier/repeat, a selection), so those keep the textarea's native
  // behavior and this handler never consumes them as a no-op.
  const recallAction = classifyComposerRecall(keyInput(e), recallCaret(), {
    pickerOpen: pickerOpen.value,
    recallActive: recallState.active,
    historyCount: recallEntries.value.length,
  })
  if (recallAction !== null) {
    e.preventDefault()
    applyRecallStep(recallAction)
    return
  }
  // a run parked on an approval owns the turn: Enter stays a newline, the
  // text is a draft. A working run does not block — Enter queues a submission.
  if (props.waiting) return
  switch (classifyComposerKey(keyInput(e), false)) {
    case 'submit':
    case 'submit-accelerated':
      e.preventDefault()
      submit()
      break
    default:
      break
  }
}

watch(pickerFlat, ensureActive)
watch(pickerActive, () => {
  void nextTick(scrollActiveIntoView)
})

// -- mode popover -------------------------------------------------------------

const modeOpen = ref(false)
const modeTrigger = ref<HTMLButtonElement | null>(null)
const modeMenu = ref<HTMLDivElement | null>(null)

function onModeShow(show: boolean) {
  modeOpen.value = show
  if (!show) return
  void nextTick(() => {
    const checked =
      modeMenu.value?.querySelector<HTMLInputElement>('input[type="radio"]:checked') ??
      modeMenu.value?.querySelector<HTMLInputElement>('input[type="radio"]')
    checked?.focus()
  })
}

function onModeKeydown(e: KeyboardEvent) {
  if (e.key !== 'Escape') return
  e.preventDefault()
  e.stopPropagation()
  closeMode(true)
}

function closeMode(restoreFocus = false) {
  modeOpen.value = false
  if (restoreFocus) void nextTick(() => modeTrigger.value?.focus())
}

function chooseMode(value: RunMode) {
  mode.value = value
  closeMode(true)
}

/** Open the existing mode control (used by the `/mode` base action). */
function openModePicker(): void {
  modeOpen.value = true
  void nextTick(() => {
    const checked =
      modeMenu.value?.querySelector<HTMLInputElement>('input[type="radio"]:checked') ??
      modeMenu.value?.querySelector<HTMLInputElement>('input[type="radio"]')
    checked?.focus()
  })
}

// -- model route popover ------------------------------------------------------

const modelOpen = ref(false)
const modelTrigger = ref<HTMLButtonElement | null>(null)
const modelConfigure = ref<HTMLButtonElement | null>(null)

function onModelShow(show: boolean) {
  modelOpen.value = show
  if (show) void nextTick(() => modelConfigure.value?.focus())
}

function onModelKeydown(e: KeyboardEvent) {
  if (e.key !== 'Escape') return
  e.preventDefault()
  e.stopPropagation()
  closeModels(true)
}

function closeModels(restoreFocus = false) {
  modelOpen.value = false
  if (restoreFocus) void nextTick(() => modelTrigger.value?.focus())
}

function configureModels() {
  modelOpen.value = false
  emit('openSettings')
}

const MENU_STYLE = { padding: '0.35rem', width: 'min(20rem, calc(100vw - 2rem))' }

watch(task, () => nextTick(resizeInput))
watch(task, scheduleDraftSave)
watch(
  () => props.sessionId,
  (next, prev) => {
    // a session switch cancels any picker tied to the previous draft
    closePicker()
    pickerDismissed = null
    resetFileState()
    // `task` still holds the previous state's text here: save it under the old
    // id (or remember it when there was no session), then swap the box. While
    // browsing history, `flushDraft` writes the stashed live draft instead of
    // the recalled text, and the box is put back on that draft before the new
    // session adopts it — a recalled task must never leak into a draft.
    const stashedRecall = recallState.active ? recallState.draft : null
    flushDraft(prev)
    recallState = createRecallState()
    applyingRecall = false
    if (stashedRecall !== null) {
      applyingRecall = true
      task.value = stashedRecall
      void nextTick(() => {
        applyingRecall = false
      })
    }
    if (!prev && next) adoptOrRestore(next)
    else restoreDraft(next)
  },
)
// Welcome-hero starter: replace the draft with the suggestion, persist it and
// put the caret at the end so it can be edited before sending. Only the token
// triggers this, so re-renders and typing are never disturbed.
watch(
  () => props.prefill?.token ?? 0,
  () => {
    const prefill = props.prefill
    if (!prefill || typeof prefill.text !== 'string' || prefill.text === '') return
    // Never discard an unsent draft: a starter fills an empty composer, and an
    // occupied one keeps the operator's text with an honest notice instead.
    const current = task.value.trim()
    if (current !== '' && current !== prefill.text.trim()) {
      emit('notice', 'The composer already has a draft — clear it to use the starter.')
      return
    }
    cancelDraftSave()
    restoringDraft = false
    recallState = createRecallState()
    applyingRecall = false
    task.value = prefill.text
    if (props.sessionId) setDraft(props.sessionId, prefill.text)
    else unsessionedDraft = prefill.text
    void nextTick(() => {
      resizeInput()
      const el = inputEl.value
      if (!el) return
      el.focus()
      const end = prefill.text.length
      el.setSelectionRange(end, end)
    })
  },
)
// The composer's @ file picker follows the selected session's workspace (or the
// sidebar filter for a session that does not exist yet).
watch(
  () => props.workspaceId,
  () => {
    resetFileState()
    if (pickerOpen.value && pickerKind.value === 'file') scheduleFileSearch(pickerQuery.value)
  },
)
watch(
  () => props.busy,
  (busy) => {
    if (!busy) return
    modeOpen.value = false
    modelOpen.value = false
    // a run starting owns the conversation chrome; dismiss an open picker
    closePicker()
  },
)
watch(() => props.settingsVersion, () => {
  resetCatalogs()
  if (pickerOpen.value) ensureCatalogs()
  void checkSettings()
})

onMounted(() => {
  // a mounted composer may already have a session (restored selection on load)
  restoreDraft(props.sessionId)
  recallEntries.value = loadRecall()
  resizeInput()
  window.addEventListener('resize', resizeInput)
  void checkSettings()
  // typed `/action` lines are resolved locally, so warm the command catalog
  // immediately instead of waiting for the picker's first open
  void loadCommandsCatalog()
})

onBeforeUnmount(() => {
  // synchronous last write: the debounce may still be pending
  flushDraft()
  settingsRequest++
  cancelFileSearch()
  skillsRequest++
  commandsRequest++
  pickerDismissed = null
  window.removeEventListener('resize', resizeInput)
})
</script>

<template>
  <form
    class="composer"
    aria-label="New task"
    :aria-busy="compacting || submitting"
    @submit.prevent="submit"
  >
    <div
      class="composer-surface"
      :class="{ 'is-busy': busy, 'is-waiting': waiting, 'is-compacting': compacting }"
    >
      <!-- @ mentions and / commands: a listbox above the box, driven by the
           textarea's aria-activedescendant while the textarea keeps focus. -->
      <div
        v-if="pickerOpen"
        class="mention-picker"
        data-composer-mentions
        @pointerdown="onPickerPointerDown"
      >
        <div
          :id="mentionListId"
          ref="pickerList"
          class="mention-list"
          role="listbox"
          :aria-label="pickerHintLabel"
        >
          <div
            v-for="group in pickerGroups"
            :key="group.id"
            class="mention-group"
            role="group"
            :aria-labelledby="`composer-mention-${group.id}-label`"
          >
            <div
              :id="`composer-mention-${group.id}-label`"
              class="mention-group-label"
            >
              {{ group.label }}
              <span class="mention-group-count">{{ group.rows.length }}</span>
            </div>
            <div
              v-for="row in group.rows"
              :id="mentionOptionId(row.index)"
              :key="row.item.id"
              class="mention-option"
              :class="{ 'is-disabled': row.item.disabled }"
              role="option"
              :aria-disabled="row.item.disabled || undefined"
              :aria-selected="pickerActive === row.index"
              :title="row.item.hint || row.item.label"
              @mousedown.prevent
              @click="activatePickerRow(row.item)"
            >
              <span class="mention-option-label">{{ row.item.label }}</span>
              <span v-if="row.item.action" class="mention-badge">action</span>
              <span v-if="row.item.hint" class="mention-option-hint">{{ row.item.hint }}</span>
            </div>
          </div>
        </div>

        <div v-if="pickerNotes.length" class="mention-notes" role="status">
          <p v-for="note in pickerNotes" :key="note" class="mention-note">{{ note }}</p>
        </div>

        <div class="mention-foot">{{ pickerFootHint }}</div>
      </div>

      <textarea
        id="composer-input"
        ref="inputEl"
        v-model="task"
        class="composer-input"
        rows="1"
        role="combobox"
        aria-label="Task for the two brothers"
        aria-autocomplete="list"
        :aria-expanded="pickerOpen"
        :aria-controls="pickerOpen ? mentionListId : undefined"
        :aria-activedescendant="activeOptionId"
        :placeholder="placeholder"
        @keydown="onKeydown"
        @input="onInput"
        @keyup="syncPicker"
        @click="syncPicker"
        @select="syncPicker"
        @blur="onTextareaBlur"
      ></textarea>

      <div class="composer-controls">
        <div class="composer-context">
          <n-popover
            v-model:show="modeOpen"
            trigger="click"
            placement="top-start"
            :content-style="MENU_STYLE"
            @update:show="onModeShow"
          >
            <template #trigger>
              <button
                ref="modeTrigger"
                type="button"
                class="composer-chip"
                data-testid="composer-mode"
                :aria-label="`Cooperation mode: ${currentMode.label}`"
                aria-haspopup="true"
                aria-controls="composer-mode-menu"
                :aria-expanded="modeOpen"
              >
                <span class="chip-caption">Mode</span>
                <span class="chip-value">{{ currentMode.label }}</span>
                <svg class="chip-chevron" viewBox="0 0 16 16" aria-hidden="true">
                  <path
                    d="M4 6l4 4 4-4"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.5"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
              </button>
            </template>

            <div
              id="composer-mode-menu"
              ref="modeMenu"
              class="mode-menu"
              role="radiogroup"
              aria-label="Cooperation mode"
              @keydown="onModeKeydown"
            >
              <p class="menu-heading">Cooperation mode</p>
              <label
                v-for="option in MODE_OPTIONS"
                :key="option.value"
                class="mode-option"
                :class="{ 'is-selected': mode === option.value }"
                @click="chooseMode(option.value)"
              >
                <input
                  v-model="mode"
                  class="mode-input"
                  type="radio"
                  name="composer-mode"
                  :value="option.value"
                />
                <span class="mode-text">
                  <span class="mode-title">{{ option.label }}</span>
                  <span class="mode-desc">{{ option.description }}</span>
                </span>
              </label>
            </div>
          </n-popover>

          <button
            v-if="settingsMissing"
            type="button"
            class="composer-chip is-warn"
            :aria-label="`${settingsHint} Open settings.`"
            :title="settingsHint"
            @click="emit('openSettings')"
          >
            <span class="chip-caption">Models</span>
            <span class="chip-value">Configure models</span>
          </button>

          <n-popover
            v-else
            v-model:show="modelOpen"
            trigger="click"
            placement="top-start"
            :content-style="MENU_STYLE"
            @update:show="onModelShow"
          >
            <template #trigger>
              <button
                ref="modelTrigger"
                type="button"
                class="composer-chip route-chip"
                :aria-label="routeAriaLabel"
                aria-haspopup="true"
                aria-controls="composer-model-route"
                :aria-expanded="modelOpen"
              >
                <span class="chip-caption">Models</span>
                <span v-if="settings" class="chip-value route-pair">
                  <span class="route-role is-senior">S</span>
                  <span class="route-model">{{ modelLabel(seniorRoute) }}</span>
                  <span class="route-sep" aria-hidden="true">·</span>
                  <span class="route-role is-junior">J</span>
                  <span class="route-model">{{ modelLabel(juniorRoute) }}</span>
                </span>
                <span v-else class="chip-value">
                  {{ settingsState === 'loading' ? 'Loading models…' : 'Models from settings' }}
                </span>
                <svg class="chip-chevron" viewBox="0 0 16 16" aria-hidden="true">
                  <path
                    d="M4 6l4 4 4-4"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.5"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
              </button>
            </template>

            <div
              id="composer-model-route"
              class="model-menu"
              role="group"
              aria-label="Model route from settings"
              @keydown="onModelKeydown"
            >
              <p class="menu-heading">Model route from settings</p>

              <template v-if="settingsState === 'loading'">
                <p class="menu-empty">Loading model settings…</p>
              </template>
              <template v-else-if="settingsState === 'unknown'">
                <p class="menu-empty">Model settings could not be loaded.</p>
              </template>
              <template v-else>
                <div class="model-row">
                  <span class="model-role">Senior</span>
                  <span class="model-name">{{ seniorRoute?.model || 'No model set' }}</span>
                  <span v-if="seniorRoute?.providerRef" class="model-source">
                    {{ seniorRoute.providerRef }} preset
                  </span>
                </div>
                <div class="model-row">
                  <span class="model-role">Junior</span>
                  <span class="model-name">{{ juniorRoute?.model || 'No model set' }}</span>
                  <span v-if="juniorRoute?.providerRef" class="model-source">
                    {{ juniorRoute.providerRef }} preset
                  </span>
                </div>
              </template>

              <div class="menu-divider" role="presentation"></div>
              <button
                ref="modelConfigure"
                type="button"
                class="menu-action"
                @click="configureModels"
              >
                Configure models
              </button>
            </div>
          </n-popover>
        </div>

        <n-button
          v-if="busy || waiting"
          attr-type="button"
          type="error"
          class="composer-stop"
          :disabled="stopping"
          @click="emit('stop')"
        >
          {{ stopping ? 'Stopping…' : 'Stop' }}
        </n-button>
        <!-- Sending stays available while a run works: the submission queues
             behind it. A parked run (`waiting`) is the only chrome state that
             hides the send control, as before. -->
        <n-button
          v-if="!waiting"
          attr-type="submit"
          type="primary"
          class="composer-send"
          :disabled="!canSend"
        >
          {{ submitting ? (busy ? 'Queueing…' : 'Sending…') : busy ? 'Queue' : 'Send' }}
        </n-button>
      </div>

      <!-- Truthful run status seats (models · permission expectation · latest
           prompt-audit context). Unknown seats hide themselves. -->
      <ul v-if="statusSeats.length" class="composer-seats" aria-label="Run status">
        <li
          v-for="seat in statusSeats"
          :key="seat.id"
          class="composer-seat"
          :class="`is-${seat.id}`"
          :title="seat.title"
        >
          <span class="seat-label">{{ seat.label }}</span>
          <span class="seat-value">{{ seat.value }}</span>
        </li>
      </ul>

      <div class="composer-foot">
        <span v-if="pickerOpen" class="composer-hint" role="status">
          {{ pickerFootHint }}
        </span>
        <span v-else-if="settingsMissing" class="composer-hint is-warn">{{ settingsHint }}</span>
        <span v-else class="composer-hint" role="status">{{ statusHint }}</span>
      </div>
    </div>
  </form>
</template>

<style scoped>
.composer {
  flex: 0 0 auto;
  width: 100%;
  max-width: var(--composer-max-width, 880px);
  margin: 0 auto;
  padding: 0 var(--space-5) var(--space-4);
  display: block;
}

.composer-surface {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
  padding: 0.6rem 0.7rem 0.45rem;
  background: var(--surface-panel);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-raised);
  transition: border-color 120ms ease, box-shadow 120ms ease;
}

.composer-surface:focus-within {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent-soft), var(--shadow-raised);
}

/* Keyboard focus on the text area: the surface owns the visible ring (the
   textarea itself has no border to outline), using the shared focus token. */
.composer-surface:has(.composer-input:focus-visible) {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--focus-ring), var(--shadow-raised);
}

.composer-surface.is-waiting {
  border-color: var(--warning);
}

/* Compaction in flight: drafting stays possible, sending is locked. */
.composer-surface.is-compacting {
  border-color: var(--warning);
  box-shadow: 0 0 0 1px var(--warning-soft), var(--shadow-raised);
}

.composer-input {
  display: block;
  width: 100%;
  min-height: 2.75rem;
  max-height: 12rem;
  margin: 0;
  padding: 0.3rem 0.4rem;
  resize: none;
  font: inherit;
  line-height: 1.5;
  color: var(--text-primary);
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  box-shadow: none;
  overflow-y: hidden;
}

.composer-input::placeholder {
  color: var(--text-secondary);
}

.composer-input:focus {
  /* the .composer-surface :focus-within ring is the visible focus indicator */
  border-color: transparent;
  outline: none;
}

.composer-input:disabled {
  cursor: not-allowed;
  color: var(--text-secondary);
}

.composer-controls {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.6rem;
  padding: 0 0.15rem;
  min-width: 0;
}

.composer-context {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
}

/* Composer status seats: one compact second row of run facts below the input.
   Each seat is a label/value pair; absent data removes the seat entirely, so
   the row never reserves empty placeholders. */
.composer-seats {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.1rem 0.55rem;
  min-width: 0;
  margin: 0;
  padding: 0 0.15rem;
  list-style: none;
  font-size: 0.72rem;
  line-height: 1.35;
  color: var(--text-secondary);
}

.composer-seat {
  display: inline-flex;
  align-items: baseline;
  gap: 0.28rem;
  min-width: 0;
  max-width: 100%;
}

.composer-seat + .composer-seat::before {
  content: '·';
  margin-right: 0.3rem;
  opacity: 0.6;
}

.seat-label {
  flex: none;
  font-weight: 600;
  opacity: 0.9;
}

.seat-value {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Narrow widths: the context breakdown is the most verbose seat; hiding it
   keeps the row a single deterministic line (models + permissions remain). */
@media (max-width: 640px) {
  .composer-seat.is-context {
    display: none;
  }
}

.composer-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  min-width: 0;
  height: 1.9rem;
  padding: 0 var(--space-2);
  font: inherit;
  font-size: 0.78rem;
  color: var(--text-secondary);
  background: transparent;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  cursor: pointer;
}

.composer-chip:hover:not(:disabled) {
  color: var(--text-primary);
  background: var(--surface-hover);
  border-color: var(--border-strong);
}

.composer-chip:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 1px;
}

.composer-chip:disabled {
  opacity: 0.55;
  cursor: default;
}

.composer-chip.is-warn {
  color: var(--warning);
  border-color: var(--warning);
  background: var(--warning-soft);
}

.composer-chip.is-warn:hover {
  color: var(--warning);
  background: var(--warning-soft);
  border-color: var(--warning);
}

.chip-caption {
  flex: none;
  color: var(--text-tertiary, var(--text-secondary));
}

.chip-value {
  min-width: 0;
  overflow: hidden;
  font-weight: 500;
  color: var(--text-primary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.composer-chip.is-warn .chip-caption,
.composer-chip.is-warn .chip-value {
  color: inherit;
}

.chip-chevron {
  flex: none;
  width: 0.75rem;
  height: 0.75rem;
  opacity: 0.6;
}

.route-chip {
  max-width: 100%;
}

.route-pair {
  display: inline-flex;
  align-items: baseline;
  gap: var(--space-1);
}

.route-role {
  flex: none;
  font-size: 0.68rem;
  font-weight: 700;
  letter-spacing: 0.03em;
}

.route-role.is-senior {
  color: var(--senior, var(--accent-text));
}

.route-role.is-junior {
  color: var(--junior, var(--ok));
}

.route-model {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.route-sep {
  flex: none;
  color: var(--text-tertiary, var(--text-secondary));
}

.composer-send,
.composer-stop {
  flex: none;
  min-width: 4.8rem;
}

.composer-foot {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-height: 1rem;
  padding: 0 0.2rem;
}

.composer-hint {
  font-size: 0.72rem;
  line-height: 1.3;
  color: var(--text-secondary);
}

.composer-hint.is-warn {
  color: var(--warning);
}

/* @ mention / / command picker: anchored above the composer surface so it
   never pushes the transcript layout; the textarea keeps focus. */
.mention-picker {
  position: absolute;
  right: 0;
  bottom: calc(100% + 0.45rem);
  left: 0;
  z-index: 60;
  display: flex;
  flex-direction: column;
  max-height: min(20rem, 52vh);
  overflow: hidden;
  background: var(--surface-panel);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-raised);
}

.mention-list {
  flex: 1;
  min-height: 0;
  padding: 0.3rem;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.mention-group + .mention-group {
  margin-top: 0.15rem;
  padding-top: 0.15rem;
  border-top: 1px solid var(--border-subtle);
}

.mention-group-label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.3rem var(--space-2) 0.2rem;
  font-size: 0.68rem;
  font-weight: 650;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--text-secondary);
}

.mention-group-count {
  font-weight: 500;
  letter-spacing: 0;
  opacity: 0.8;
}

.mention-option {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  padding: 0.4rem var(--space-2);
  font-size: 0.83rem;
  border-radius: var(--radius-sm);
  cursor: pointer;
  user-select: none;
}

.mention-option:hover {
  background: var(--surface-hover);
}

.mention-option[aria-selected='true'] {
  background: var(--accent-soft);
  box-shadow: inset 0 0 0 2px var(--focus-ring);
}

.mention-option-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mention-option[aria-selected='true'] .mention-option-label {
  font-weight: 600;
}

/* `/` action rows: a small chip keeps run-local actions distinct from prompts. */
.mention-badge {
  flex: none;
  padding: 0.02rem 0.32rem;
  font-size: 0.6rem;
  font-weight: 650;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--accent-text);
  background: var(--accent-soft);
  border-radius: var(--radius-pill);
}

.mention-option-hint {
  flex: none;
  max-width: 46%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-secondary);
  font-size: 0.72rem;
}

.mention-option.is-disabled {
  color: var(--text-secondary);
  cursor: default;
  opacity: 0.6;
}

.mention-option.is-disabled:hover {
  background: transparent;
}

.mention-notes {
  flex: none;
  padding: 0.35rem 0.6rem;
  border-top: 1px solid var(--border-subtle);
}

.mention-note {
  margin: 0;
  font-size: 0.72rem;
  line-height: 1.35;
  color: var(--text-secondary);
}

.mention-note + .mention-note {
  margin-top: 0.15rem;
}

.mention-foot {
  flex: none;
  padding: 0.35rem 0.6rem;
  overflow: hidden;
  color: var(--text-secondary);
  font-size: 0.7rem;
  text-overflow: ellipsis;
  white-space: nowrap;
  border-top: 1px solid var(--border-subtle);
}

/* popover content (teleported by naive-ui) */
.menu-heading {
  margin: 0;
  padding: 0.2rem var(--space-2) 0.35rem;
  font-size: 0.68rem;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--text-tertiary, var(--text-secondary));
}

.mode-menu,
.model-menu {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
}

.mode-option {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 0.55rem;
  padding: 0.45rem var(--space-2);
  border-radius: var(--radius-sm);
  cursor: pointer;
}

.mode-option:hover {
  background: var(--surface-hover);
}

.mode-option.is-selected {
  background: var(--surface-highlight);
}

.mode-option:has(.mode-input:focus-visible) {
  outline: 2px solid var(--focus-ring);
  outline-offset: -1px;
}

.mode-input {
  flex: none;
  width: 0.85rem;
  height: 0.85rem;
  margin: 0.2rem 0 0;
  appearance: none;
  cursor: pointer;
  background: transparent;
  border: 1.5px solid var(--border-strong);
  border-radius: 50%;
}

.mode-input:checked {
  background: radial-gradient(circle, var(--accent) 0 42%, transparent 45%);
  border-color: var(--accent);
}

.mode-input:disabled {
  cursor: default;
  opacity: 0.55;
}

.mode-input:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 1px;
}

.mode-text {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  min-width: 0;
}

.mode-title {
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--text-primary);
}

.mode-desc {
  font-size: 0.75rem;
  line-height: 1.35;
  color: var(--text-secondary);
}

.model-row {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.15rem 0.6rem;
  padding: 0.4rem var(--space-2);
}

.model-role {
  flex: none;
  min-width: 3.4rem;
  font-size: 0.68rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-secondary);
}

.model-name {
  font-size: 0.82rem;
  font-weight: 600;
  color: var(--text-primary);
  overflow-wrap: anywhere;
}

.model-source {
  font-size: 0.72rem;
  color: var(--text-secondary);
  overflow-wrap: anywhere;
}

.menu-empty {
  margin: 0;
  padding: 0.35rem var(--space-2);
  font-size: 0.78rem;
  color: var(--text-secondary);
}

.menu-divider {
  height: 1px;
  margin: var(--space-1) 0.4rem;
  background: var(--border-subtle);
}

.menu-action {
  padding: 0.45rem var(--space-2);
  font: inherit;
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--accent-text);
  text-align: left;
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  cursor: pointer;
}

.menu-action:hover {
  background: var(--surface-hover);
}

.menu-action:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: -1px;
}

@media (prefers-reduced-motion: reduce) {
  .composer-surface {
    transition: none;
  }
}

@media (max-width: 620px) {
  .composer {
    padding: 0 var(--space-3) var(--space-3);
  }

  .chip-caption {
    display: none;
  }

  .mention-picker {
    max-height: min(16rem, 46vh);
  }
}
</style>