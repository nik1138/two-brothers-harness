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
import { clearDraft, getDraft, setDraft } from '../drafts'
import {
  MAX_FILE_ITEMS,
  MENTION_DEBOUNCE_MS,
  MENTION_FOOTER_HINT,
  commandMentionItems,
  detectMentionTrigger,
  fileMentionItems,
  insertMention,
  mentionPickerHint,
  skillMentionItems,
} from '../mentions'
import type { MentionItem, MentionKind, MentionTrigger } from '../mentions'
import type {
  CommandInfo,
  RunMode,
  RunProvider,
  SettingsView,
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
   * Recovery payload from App: a start request that failed before any run
   * existed. `token` changes on every failure; the text is put back only when
   * the operator has not typed anything new since the submit.
   */
  draftRestore?: { token: number; text: string } | null
  /** The followed run is working (queued/running) — the composer is locked. */
  busy: boolean
  /**
   * The followed run is parked on an operator approval. The input stays
   * usable for drafting, but sending is blocked until the run finishes.
   */
  waiting?: boolean
  stopping: boolean
  settingsVersion?: number
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
  submit: [payload: { task: string; mode: RunMode; provider: RunProvider | null }]
  stop: []
  openSettings: []
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

const settings = ref<SettingsView | null>(null)
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

const canSend = computed(() => !props.busy && !props.waiting && task.value.trim().length > 0)

const placeholder = computed(() => {
  if (props.busy) return 'The brothers are working…'
  if (props.waiting) return 'Draft the next task…'
  return 'Describe a task for the two brothers…'
})

const statusHint = computed(() => {
  if (props.busy) {
    return props.stopping ? 'Stopping the run…' : 'The brothers are working — stop to interrupt.'
  }
  if (props.waiting) return 'Drafting only — sending unlocks when this run finishes.'
  return 'Enter to send · Shift+Enter for a new line'
})

const settingsHint = computed(
  () => `Set the ${missingLabel.value} in Settings to start a run.`,
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

function cancelDraftSave() {
  if (draftSaveTimer === null) return
  clearTimeout(draftSaveTimer)
  draftSaveTimer = null
}

/** Write the current text for `sessionId` now (session switch / unmount). */
function flushDraft(sessionId: string | null | undefined = props.sessionId) {
  cancelDraftSave()
  if (!sessionId) {
    // no storage key for the welcome screen — remember the text in memory
    unsessionedDraft = task.value
    return
  }
  setDraft(sessionId, task.value)
}

/** Show `sessionId`'s saved draft, or the remembered welcome-screen text. */
function restoreDraft(sessionId: string | null | undefined) {
  cancelDraftSave()
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
  if (restoringDraft) return
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
  const text = task.value.trim()
  // `waiting` keeps the textarea usable for drafting, but a new run cannot
  // start while this session's run is still alive.
  if (!text || props.busy || props.waiting) return
  emit('submit', { task: text, mode: mode.value, provider: providerForRun.value })
  // The run accepted the text — submit consumes every draft form. A blocked
  // submit returned above, so text and drafts stay intact.
  cancelDraftSave()
  clearDraft(props.sessionId)
  unsessionedDraft = ''
  task.value = ''
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
const commandItems = computed(() => commandMentionItems(commands.value, pickerQuery.value))
const skillItems = computed(() => skillMentionItems(skills.value, pickerQuery.value))
const fileItems = computed(() => fileMentionItems(files.value))

interface PickerRow {
  item: MentionItem
  index: number
}

interface PickerGroupView {
  kind: MentionKind
  label: string
  rows: PickerRow[]
}

/** Rendered groups (empty sections are skipped; indices stay flat-consistent). */
const pickerGroups = computed<PickerGroupView[]>(() => {
  const kind = pickerKind.value
  if (!kind) return []
  const sections: Array<{ kind: MentionKind; label: string; items: MentionItem[] }> =
    kind === 'command'
      ? [{ kind: 'command', label: 'Commands', items: commandItems.value }]
      : [
          { kind: 'skill', label: 'Skills', items: skillItems.value },
          ...(kind === 'file'
            ? [{ kind: 'file' as const, label: 'Files', items: fileItems.value }]
            : []),
        ]
  let index = 0
  const groups: PickerGroupView[] = []
  for (const section of sections) {
    if (!section.items.length) continue
    groups.push({
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
    if (commandsState.value === 'error') notes.push('Slash commands are unavailable.')
    else if (!commandItems.value.length) {
      if (commandsState.value === 'loading') notes.push('Loading commands…')
      else notes.push(query ? 'No matching commands' : 'No commands discovered')
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
  if (props.busy) {
    closePicker()
    return
  }
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

/** Keys owned by the open picker; returns true when the event was consumed. */
function onPickerKeydown(e: KeyboardEvent): boolean {
  switch (e.key) {
    case 'Escape':
      e.preventDefault()
      e.stopPropagation()
      dismissPicker()
      return true
    case 'ArrowDown':
      e.preventDefault()
      stepPicker(1)
      return true
    case 'ArrowUp':
      e.preventDefault()
      stepPicker(-1)
      return true
    case 'Enter': {
      if (e.shiftKey) return false // Shift+Enter keeps inserting a newline
      e.preventDefault()
      if (!insertPickerItem(activePickerItem())) closePicker()
      return true
    }
    case 'Tab': {
      if (e.shiftKey) return false
      if (insertPickerItem(activePickerItem())) {
        e.preventDefault()
        return true
      }
      closePicker()
      return false
    }
    default:
      return false
  }
}

function onKeydown(e: KeyboardEvent) {
  // let an IME finish its composition instead of acting on a partial word
  if (e.isComposing || e.keyCode === 229) return
  // an open picker owns Enter (never submit), arrows, Tab and Esc
  if (pickerOpen.value && onPickerKeydown(e)) return
  // while waiting Enter must stay a newline — the text is a draft, not a task
  if (props.busy || props.waiting) return
  if (e.key !== 'Enter' || e.shiftKey) return
  e.preventDefault()
  submit()
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
  if (props.busy) return
  mode.value = value
  closeMode(true)
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
    // id (or remember it when there was no session), then swap the box.
    flushDraft(prev)
    if (!prev && next) adoptOrRestore(next)
    else restoreDraft(next)
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
// A start request that threw before creating a run: App hands the task back.
// The successful-submit path already cleared text + saved draft, so this is
// the only way that text survives; an operator edit since then wins.
watch(
  () => props.draftRestore?.token ?? 0,
  () => {
    const restore = props.draftRestore
    if (!restore || restore.text.trim().length === 0) return
    if (task.value.trim().length > 0) return
    cancelDraftSave()
    restoringDraft = true
    task.value = restore.text
    // persist again now (the submit path consumed the saved copy)
    if (props.sessionId) setDraft(props.sessionId, restore.text)
    else unsessionedDraft = restore.text
    void nextTick(() => {
      restoringDraft = false
    })
  },
)
watch(
  () => props.busy,
  (busy) => {
    if (!busy) return
    modeOpen.value = false
    modelOpen.value = false
    // the textarea is disabled while a run works — no picker can stay open
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
  resizeInput()
  window.addEventListener('resize', resizeInput)
  void checkSettings()
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
  <form class="composer" aria-label="New task" @submit.prevent="submit">
    <div
      class="composer-surface"
      :class="{ 'is-busy': busy, 'is-waiting': waiting }"
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
          :aria-label="mentionPickerHint(pickerKind ?? 'file')"
        >
          <div
            v-for="group in pickerGroups"
            :key="group.kind"
            class="mention-group"
            role="group"
            :aria-labelledby="`composer-mention-${group.kind}-label`"
          >
            <div
              :id="`composer-mention-${group.kind}-label`"
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
              :title="row.item.token || row.item.label"
              @mousedown.prevent
              @click="insertPickerItem(row.item)"
            >
              <span class="mention-option-label">{{ row.item.label }}</span>
              <span v-if="row.item.hint" class="mention-option-hint">{{ row.item.hint }}</span>
            </div>
          </div>
        </div>

        <div v-if="pickerNotes.length" class="mention-notes" role="status">
          <p v-for="note in pickerNotes" :key="note" class="mention-note">{{ note }}</p>
        </div>

        <div class="mention-foot">{{ MENTION_FOOTER_HINT }}</div>
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
        :disabled="busy"
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
                :disabled="busy"
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
                  :disabled="busy"
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
        <n-button
          v-else
          attr-type="submit"
          type="primary"
          class="composer-send"
          :disabled="!canSend"
        >
          Send
        </n-button>
      </div>

      <div class="composer-foot">
        <span v-if="pickerOpen" class="composer-hint" role="status">
          {{ MENTION_FOOTER_HINT }}
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
  padding: 0 1.25rem 1rem;
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

.composer-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  min-width: 0;
  height: 1.9rem;
  padding: 0 0.5rem;
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
  gap: 0.25rem;
}

.route-role {
  flex: none;
  font-size: 0.68rem;
  font-weight: 700;
  letter-spacing: 0.03em;
}

.route-role.is-senior {
  color: var(--senior, var(--accent));
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
  gap: 0.75rem;
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
  padding: 0.3rem 0.5rem 0.2rem;
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
  gap: 0.5rem;
  min-width: 0;
  padding: 0.4rem 0.5rem;
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
  padding: 0.2rem 0.5rem 0.35rem;
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
  padding: 0.45rem 0.5rem;
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
  padding: 0.4rem 0.5rem;
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
  padding: 0.35rem 0.5rem;
  font-size: 0.78rem;
  color: var(--text-secondary);
}

.menu-divider {
  height: 1px;
  margin: 0.25rem 0.4rem;
  background: var(--border-subtle);
}

.menu-action {
  padding: 0.45rem 0.5rem;
  font: inherit;
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--accent);
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
    padding: 0 0.75rem 0.75rem;
  }

  .chip-caption {
    display: none;
  }

  .mention-picker {
    max-height: min(16rem, 46vh);
  }
}
</style>