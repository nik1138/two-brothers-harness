<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, useId, watch } from 'vue'
import type { ComponentPublicInstance } from 'vue'
import { NButton, NDynamicTags, NInput, NSelect } from 'naive-ui'
import type { InputInst } from 'naive-ui'
import {
  ApiError,
  createProvider,
  deleteProvider,
  discoverDraftProviderModels,
  discoverProviderModels,
  listProviders,
  resetProvider,
  updateProvider,
} from '../../api'
import type { ProviderCreateRequest, ProviderDiscoverRequest, ProviderPatchRequest } from '../../api'
import type { ProviderPreset } from '../../types'
import {
  MODEL_FILTER_THRESHOLD,
  PROVIDER_KIND_DEFAULT,
  PROVIDER_KINDS,
  addDiscoveryEligible,
  addDiscoveryStatusText,
  apiKeyPlaceholder,
  apiKeyStateLabel,
  appendSelectedReportedModels,
  applyAddModelSelection,
  applyProviderDelete,
  applyProviderReset,
  applyProviderUpdate,
  cleanModelList,
  defaultAddModelSelection,
  discoveryStatusText,
  failDiscovery,
  filterModelIds,
  hasAddableReportedModels,
  isCurrentDiscovery,
  isProviderDraftDirty,
  newDiscoveryState,
  nextProviderIndex,
  normalizeProviders,
  parseProviderContextWindow,
  providerBadge,
  providerDeleteAllowed,
  providerDeleteImpact,
  providerDraftOf,
  providerIsCustomizedSeed,
  providerKindLabel,
  providerMoveForKey,
  providerResetAllowed,
  providerRowSummary,
  providerUsageBadges,
  resolveProviderSelection,
  selectAllModels,
  selectedReportedAdditions,
  settleDiscovery,
  startDiscovery,
  supportsModelDiscovery,
  toggleModelSelection,
  unsupportedDiscoveryCopy,
  validateAddProviderForm,
  validateProviderBaseUrl,
} from '../../providerSettings'
import type {
  ProviderDiscoveryState,
  ProviderDraft,
  ProviderUsageRole,
  ProviderView,
} from '../../providerSettings'
import { importAnnouncement, type CatalogImport } from '../../modelsDev'
import AppDialog from '../AppDialog.vue'
import ModelsDevBrowser from './ModelsDevBrowser.vue'

/**
 * Settings → Providers as an identity-only master list with the selected
 * provider's settings expanded inline immediately after its row (the dialog
 * body is ~560px wide, too narrow for side-by-side panes). At most one detail
 * card is open; clicking the open row closes it. "Add provider" reveals a
 * create card below the list.
 *
 * Provider changes apply immediately through the API (no dialog Save): the
 * sections emits the refreshed list upward so the role connection selects stay
 * in sync. Seed/customized flags are additive; an older backend without them
 * degrades to "every row is a custom, editable provider".
 */

const props = defineProps<{
  providers: ProviderPreset[]
  /** Load failure reported by the dialog before this section mounted. */
  initialError?: string | null
  /** `GET /api/providers` is still in flight. */
  loading?: boolean
  /** Current role connection refs, so rows can show "Used by" badges. */
  seniorProviderRef?: string | null
  juniorProviderRef?: string | null
  /** Optional dedicated helper route ref (older backends omit the section). */
  subagentProviderRef?: string | null
}>()

const emit = defineEmits<{
  'update:providers': [ProviderPreset[]]
  deleted: [name: string]
}>()

const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '')
const panelId = `providers-panel-${uid}`
const optionId = (index: number) => `${panelId}-row-${index}`
const detailId = (index: number) => `${panelId}-detail-${index}`
const detailTitleId = (index: number) => `${panelId}-detail-title-${index}`
const announcementId = `${panelId}-announcement`

const listError = ref<string | null>(props.initialError ?? null)
const detailError = ref<string | null>(null)
const announcement = ref('')
const busy = ref(false)
const addBusy = ref(false)

const views = computed<ProviderView[]>(() => normalizeProviders(props.providers))
const activeName = ref<string | null>(null)
const openName = ref<string | null>(null)
const openIndex = computed(() =>
  views.value.findIndex((provider) => provider.name === openName.value),
)
const openProvider = computed<ProviderView | null>(() => views.value[openIndex.value] ?? null)
const usageRoles = computed(() =>
  openProvider.value
    ? providerUsageBadges(openProvider.value, {
        senior: props.seniorProviderRef,
        junior: props.juniorProviderRef,
        subagent: props.subagentProviderRef,
      })
    : [],
)
const deleteImpact = computed(() => providerDeleteImpact(usageRoles.value))

const draft = reactive<ProviderDraft>({
  baseUrl: '',
  apiKey: '',
  models: [],
  kind: PROVIDER_KIND_DEFAULT,
  contextWindow: '0',
})
const draftDirty = computed(() =>
  openProvider.value ? isProviderDraftDirty(openProvider.value, draft) : false,
)
const contextWindowProblem = computed(
  () => parseProviderContextWindow(draft.contextWindow).error,
)

// -- model discovery ("Refresh models") --------------------------------------
// A manual, explicit probe of the CURRENT draft: separate from Apply, never
// auto-saves, and stale responses are dropped via the monotonic token below.
const discovery = ref<ProviderDiscoveryState>(newDiscoveryState())
/** Newest probe token; a settling response with an older token is stale. */
let discoverySequence = 0
const discovering = computed(() => discovery.value.phase === 'loading')
const discoveryText = computed(() => discoveryStatusText(discovery.value))
const discoveryModels = computed(() =>
  discovery.value.phase === 'ready' ? discovery.value.models : [],
)
const discoveryCountId = `${panelId}-discovery-count`
/** Ids the operator checked in the detail picker (nothing is checked by default). */
const discoverySelection = ref<string[]>([])
/** Case-insensitive filter over the reported ids ('' shows every row). */
const discoveryFilter = ref('')
/** Ids already in the draft render as disabled "in draft" rows. */
const discoveryInDraft = computed(() => new Set(draft.models))
const discoveryVisibleModels = computed(() =>
  filterModelIds(discoveryModels.value, discoveryFilter.value),
)
/** Selected ids that are reported, checked and not already in the draft. */
const discoverySelectedCount = computed(
  () =>
    selectedReportedAdditions(draft.models, discoveryModels.value, discoverySelection.value).length,
)
const discoveryAllInDraft = computed(
  () =>
    discoveryModels.value.length > 0 &&
    !hasAddableReportedModels(draft.models, discoveryModels.value),
)
const discoveryCanSelectAll = computed(() =>
  discoveryVisibleModels.value.some(
    (model) => !discoveryInDraft.value.has(model) && !discoverySelection.value.includes(model),
  ),
)

/** Unsaved-draft guard: closing, or switching to another provider. */
const pendingClose = ref<'close' | { name: string } | null>(null)
const pendingDelete = ref(false)
const deleteError = ref<string | null>(null)
const pendingReset = ref<string | null>(null)
const resetError = ref<string | null>(null)
const completedResetName = ref<string | null>(null)
const resetTarget = computed(() =>
  views.value.find((provider) => provider.name === pendingReset.value) ?? null,
)

const addOpen = ref(false)
const addName = ref('')
const addBaseUrl = ref('')
const addApiKey = ref('')
const addModels = ref<string[]>([])
const addKind = ref(PROVIDER_KIND_DEFAULT)
const addContextWindow = ref('')
const addNameError = ref<string | null>(null)
const addBaseUrlError = ref<string | null>(null)
const addContextWindowError = ref<string | null>(null)
const addFormError = ref<string | null>(null)
/**
 * Catalog provenance carried invisibly by the Add form (no operator-facing
 * field). Set by a models.dev import; absent on manual providers.
 */
const addCatalogId = ref<string | null>(null)
const browseOpen = ref(false)

// -- model discovery in the Add card ("Fetch models") ---------------------------
// A name-agnostic probe of the unsaved Add draft (`POST /api/providers/
// discover`): it never saves the provider, never resolves a stored or env
// credential, and the typed key is sent write-only for the one request. A
// successful result renders as checkboxes whose selection IS the draft's
// model list (default: everything discovered).
const ADD_DISCOVERY_NAME = 'add'
const addDiscovery = ref<ProviderDiscoveryState>(newDiscoveryState())
/** Newest Add-card probe token; a settling response with an older token is stale. */
let addDiscoverySequence = 0
const addDiscovering = computed(() => addDiscovery.value.phase === 'loading')
const addDiscoveryText = computed(() => addDiscoveryStatusText(addDiscovery.value))
/** True for finished probes whose copy should be announced assertively. */
const addDiscoveryAlert = computed(() =>
  ['empty', 'error', 'unsupported'].includes(addDiscovery.value.phase),
)
const addDiscoveryModels = computed(() =>
  addDiscovery.value.phase === 'ready' ? addDiscovery.value.models : [],
)
/** Ids the operator checked in the discovery list (drives the draft's models). */
const addDiscoverySelection = ref<string[]>([])
/** Nothing is checked until the operator picks; a fetch alone adds no model. */
const addDiscoveryFilter = ref('')
const addDiscoveryVisibleModels = computed(() =>
  filterModelIds(addDiscoveryModels.value, addDiscoveryFilter.value),
)
const addDiscoveryCanSelectAll = computed(() =>
  addDiscoveryVisibleModels.value.some(
    (model) => !addDiscoverySelection.value.includes(model),
  ),
)
/** The probe needs a valid Base URL and an OpenAI-compatible kind. */
const addFetchEligible = computed(() =>
  addDiscoveryEligible({ baseUrl: addBaseUrl.value, kind: addKind.value }),
)
const addDiscoveryCountId = `${panelId}-add-discovery-count`

const rowEls = new Map<string, HTMLButtonElement>()
const sectionRoot = ref<HTMLElement | null>(null)
const detailHeading = ref<HTMLElement | null>(null)
const baseUrlInput = ref<InputInst | null>(null)
const addNameInput = ref<InputInst | null>(null)
const addApiKeyInput = ref<InputInst | null>(null)
const addCard = ref<HTMLElement | null>(null)
const discardButton = ref<HTMLButtonElement | null>(null)
const deleteCancelButton = ref<HTMLButtonElement | null>(null)

const providerNames = computed(() => views.value.map((provider) => provider.name))
const browseDisabled = computed(
  () =>
    busy.value ||
    addBusy.value ||
    pendingReset.value !== null ||
    discovering.value,
)

const effectiveLoading = computed(() => props.loading === true && views.value.length === 0)

const kindOptions = computed(() => {
  const options = PROVIDER_KINDS.map((entry) => ({ label: entry.label, value: entry.value }))
  // tolerate an unknown kind already stored on the backend

  if (
    openProvider.value &&
    openProvider.value.kind &&
    !options.some((option) => option.value === openProvider.value?.kind)
  ) {
    options.push({ label: openProvider.value.kind, value: openProvider.value.kind })
  }
  return options
})

const addKindOptions = computed(() => {
  const options = PROVIDER_KINDS.map((entry) => ({ label: entry.label, value: entry.value }))
  if (addKind.value && !options.some((option) => option.value === addKind.value)) {
    options.push({ label: addKind.value, value: addKind.value })
  }
  return options
})

function errText(e: unknown): string {
  return e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e)
}

function setRowRef(el: Element | ComponentPublicInstance | null, name: string): void {
  if (el instanceof HTMLButtonElement) rowEls.set(name, el)
  else rowEls.delete(name)
}

// The detail card lives inside the list's v-for, so string refs would collect
// into arrays; use explicit setters for its focus targets.
function setHeadingRef(el: Element | ComponentPublicInstance | null): void {
  detailHeading.value = el instanceof HTMLElement ? el : null
}

function setBaseUrlInput(el: Element | ComponentPublicInstance | null): void {
  baseUrlInput.value = (el as InputInst | null) ?? null
}

function setDiscardButton(el: Element | ComponentPublicInstance | null): void {
  discardButton.value = el instanceof HTMLButtonElement ? el : null
}

function setDeleteCancelButton(el: Element | ComponentPublicInstance | null): void {
  deleteCancelButton.value = el instanceof HTMLButtonElement ? el : null
}

function focusRow(name: string | null | undefined): void {
  if (!name) return
  rowEls.get(name)?.focus()
}

function announce(message: string): void {
  announcement.value = message
}

function resetDraft(provider: ProviderView | null = openProvider.value): void {
  const next = providerDraftOf(provider)
  draft.baseUrl = next.baseUrl
  draft.apiKey = next.apiKey
  draft.models = next.models
  draft.kind = next.kind
  draft.contextWindow = next.contextWindow
}

/** Drop any probe result/selection and invalidate an in-flight one (newer token wins). */
function resetDiscovery(): void {
  discoverySequence += 1
  discovery.value = newDiscoveryState()
  discoverySelection.value = []
  discoveryFilter.value = ''
}

/**
 * Probe the current draft's endpoint for its model list
 * (`POST /api/providers/{name}/discover`). Purely informational: saved values
 * are untouched, and a typed key is sent write-only for this one request.
 */
async function refreshModels(): Promise<void> {
  const provider = openProvider.value
  if (!provider || busy.value || addBusy.value || pendingReset.value || discovering.value) return
  const name = provider.name
  const token = ++discoverySequence
  const started = startDiscovery(name, token)
  // Every refresh starts from an empty picker: a stale selection can never
  // leak into the new catalog, and the operator re-checks what to add.
  discoverySelection.value = []
  discoveryFilter.value = ''
  // Honest early answer for wire kinds without a live model listing:
  // the server refuses them too (400), but this avoids a pointless round trip.
  if (!supportsModelDiscovery(draft.kind)) {
    const message = unsupportedDiscoveryCopy(draft.kind)
    discovery.value = failDiscovery(started, token, name, 400, message)
    announce(message)
    return
  }
  const request: ProviderDiscoverRequest = {
    base_url: draft.baseUrl.trim(),
    kind: draft.kind || PROVIDER_KIND_DEFAULT,
  }
  // Only a key typed in this form is sent; blank means the server falls back
  // to the stored/env-backed key. Either way the key is never persisted here.
  const typedKey = draft.apiKey.trim()
  if (typedKey) request.api_key = typedKey
  discovery.value = started
  announce(`Refreshing the model list for ${name}…`)
  try {
    const result = await discoverProviderModels(name, request)
    if (!isCurrentDiscovery(discovery.value, token, name)) return
    discovery.value = settleDiscovery(discovery.value, token, name, result.models)
    const phase = discovery.value.phase
    if (phase === 'ready') {
      const count = discovery.value.models.length
      announce(
        `${count} model${
          count === 1 ? '' : 's'
        } reported by the endpoint. Choose the ones to add to the draft; nothing was saved.`,
      )
    } else {
      // Empty answers leave no rows to pick: drop any residual selection.
      discoverySelection.value = []
      discoveryFilter.value = ''
      announce(discovery.value.message)
    }
  } catch (e) {
    if (!isCurrentDiscovery(discovery.value, token, name)) return
    const status = e instanceof ApiError ? e.status : 0
    discovery.value = failDiscovery(discovery.value, token, name, status, errText(e))
    discoverySelection.value = []
    discoveryFilter.value = ''
    announce(discovery.value.message)
  }
}

/** Check/uncheck one reported row (in-draft rows are disabled and never enter the selection). */
function onDiscoveryToggle(model: string, event: Event): void {
  const checked = event.target instanceof HTMLInputElement ? event.target.checked : false
  const next = new Set(toggleModelSelection(discoverySelection.value, model))
  if (checked) next.add(model)
  else next.delete(model)
  // Keep reported order (not click order); in-draft ids are not selectable.
  discoverySelection.value = discoveryModels.value.filter(
    (entry) => next.has(entry) && !discoveryInDraft.value.has(entry),
  )
}

/** Select every visible row that can still be added (in-draft rows stay excluded). */
function selectAllDiscovery(): void {
  const next = new Set(selectAllModels(discoverySelection.value, discoveryVisibleModels.value))
  discoverySelection.value = discoveryModels.value.filter(
    (entry) => next.has(entry) && !discoveryInDraft.value.has(entry),
  )
}

function clearDiscoverySelection(): void {
  discoverySelection.value = []
}

/** Explicit, draft-only append of exactly the checked reported ids (needs Save changes). */
function useDiscoveredModels(): void {
  if (!openProvider.value || busy.value || addBusy.value) return
  const selected = selectedReportedAdditions(
    draft.models,
    discoveryModels.value,
    discoverySelection.value,
  )
  if (!selected.length) {
    announce(
      discoveryAllInDraft.value
        ? 'All reported models are already in the draft.'
        : 'Select at least one reported model to add.',
    )
    return
  }
  draft.models = appendSelectedReportedModels(draft.models, discoveryModels.value, selected)
  // The added ids are now in the draft (and disabled), so the picker starts clean.
  discoverySelection.value = []
  announce(
    `Added ${selected.length} model${selected.length === 1 ? '' : 's'} to draft. Save changes to keep them.`,
  )
}

function roleBadges(provider: ProviderView): ProviderUsageRole[] {
  return providerUsageBadges(provider, {
    senior: props.seniorProviderRef,
    junior: props.juniorProviderRef,
    subagent: props.subagentProviderRef,
  })
}

// Selection survives refreshes; an open provider that disappears closes.
watch(
  views,
  (list) => {
    const next = resolveProviderSelection(list, activeName.value ?? openName.value)
    activeName.value = next
    if (openName.value && !list.some((provider) => provider.name === openName.value)) {
      openName.value = null
      pendingClose.value = null
      pendingDelete.value = false
      pendingReset.value = null
      resetError.value = null
      detailError.value = null
      resetDraft(null)
      resetDiscovery()
    }
    if (!draftDirty.value) resetDraft(openProvider.value)
  },
  { immediate: true },
)

// A probe result describes the draft it was started for: editing the Base URL
// or Kind makes it stale (and invalidates an in-flight probe, whose token is
// then no longer the newest).
watch([() => draft.baseUrl, () => draft.kind], () => {
  if (discovery.value.phase !== 'idle') resetDiscovery()
})

// An Add-card probe describes the draft it was started for: editing the Base
// URL or Kind makes the result (and any in-flight probe) stale.
watch([addBaseUrl, addKind], () => {
  if (addDiscovery.value.phase !== 'idle') resetAddDiscovery()
})

watch(
  () => props.initialError,
  (value) => {
    if (value) listError.value = value
  },
)

watch(pendingClose, async (pending) => {
  if (!pending) return
  await nextTick()
  discardButton.value?.focus()
})

async function refreshProviders(preserveFocus = false): Promise<void> {
  const hadFocus = !!document.activeElement && rowEls.get(activeName.value ?? '') === document.activeElement
  try {
    const next = await listProviders()
    listError.value = null
    emit('update:providers', next)
    detailError.value = null
    if (preserveFocus || hadFocus) void nextTick(() => focusRow(activeName.value))
  } catch (e) {
    listError.value = errText(e)
  }
}

function openDetail(name: string, focusHeading = false): void {
  const provider = views.value.find((entry) => entry.name === name)
  if (!provider) return
  activeName.value = name
  openName.value = name
  pendingClose.value = null
  pendingDelete.value = false
  pendingReset.value = null
  resetError.value = null
  detailError.value = null
  resetDraft(provider)
  resetDiscovery()
  if (focusHeading) void nextTick(() => detailHeading.value?.focus())
}

function closeDetail(restoreRowFocus = true): void {
  const name = activeName.value
  openName.value = null
  pendingClose.value = null
  pendingDelete.value = false
  pendingReset.value = null
  resetError.value = null
  detailError.value = null
  resetDraft(null)
  resetDiscovery()
  if (restoreRowFocus) void nextTick(() => focusRow(name))
}

/** Row activation: open, close (one open at a time), or ask before discarding. */
function toggleRow(name: string, viaKeyboard = false): void {
  if (busy.value || addBusy.value || pendingReset.value) return
  // Never move the roving activeName before the dirty-edit guard: it only
  // changes when a detail actually opens (openDetail), so a blocked click
  // (discard prompt) leaves focus/tabindex on the currently open row.
  if (openName.value === name) {
    if (draftDirty.value) {
      pendingClose.value = 'close'
      return
    }
    closeDetail(true)
    return
  }
  if (openName.value && draftDirty.value) {
    pendingClose.value = { name }
    return
  }
  openDetail(name, viaKeyboard)
}

function resolveOpenIntent(discard: boolean): void {
  const pending = pendingClose.value
  pendingClose.value = null
  if (!pending) return
  if (!discard) {
    void nextTick(() => baseUrlInput.value?.focus())
    return
  }
  if (pending === 'close') closeDetail(true)
  else openDetail(pending.name, true)
}

/** Roving listbox keys: arrows move focus/selection, Enter/Space toggles. */
function onRowKeydown(event: KeyboardEvent, provider: ProviderView, index: number): void {
  const move = providerMoveForKey(event.key)
  if (move) {
    event.preventDefault()
    const nextIndex = nextProviderIndex(index, views.value.length, move)
    const next = views.value[nextIndex]
    if (!next) return
    activeName.value = next.name
    void nextTick(() => focusRow(next.name))
    return
  }
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    toggleRow(provider.name, true)
  }
}

/**
 * Escape layering inside this section: a delete/discard confirmation, an open
 * detail card or the add card consumes the first Escape; otherwise the key
 * falls through and the Settings dialog closes. The listener sits on
 * `document` in the bubble phase so it runs before naive-ui's window-level
 * modal Esc handler, whose `onEsc` (the dialog close) cannot be prevented from
 * a descendant keydown handler.
 */
function handleSectionEscape(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || event.defaultPrevented) return
  // The teleported AppDialog owns Escape and focus while reset is confirmed.
  if (pendingReset.value) return
  const root = sectionRoot.value
  const target = event.target instanceof Node ? event.target : document.activeElement
  if (!root || !target || !root.contains(target)) return
  if (pendingDelete.value) {
    pendingDelete.value = false
  } else if (pendingClose.value) {
    resolveOpenIntent(false)
  } else if (openName.value) {
    if (draftDirty.value) pendingClose.value = 'close'
    else closeDetail(true)
  } else if (addOpen.value) {
    closeAdd()
  } else {
    return // let the Settings dialog handle Escape
  }
  event.preventDefault()
  event.stopPropagation()
}

onMounted(() => {
  document.addEventListener('keydown', handleSectionEscape)
})

onBeforeUnmount(() => {
  document.removeEventListener('keydown', handleSectionEscape)
})

function onModelsChange(value: string[]): void {
  draft.models = cleanModelList(value)
}

function onKindChange(value: string): void {
  draft.kind = value || PROVIDER_KIND_DEFAULT
}

async function saveSelected(): Promise<void> {
  const provider = openProvider.value
  if (!provider || busy.value || addBusy.value || pendingReset.value || discovering.value) return
  const urlProblem = validateProviderBaseUrl(draft.baseUrl)
  if (urlProblem) {
    detailError.value = urlProblem
    return
  }
  const window = parseProviderContextWindow(draft.contextWindow)
  if (window.error) {
    detailError.value = window.error
    return
  }
  const patch: ProviderPatchRequest = {
    base_url: draft.baseUrl.trim(),
    models: cleanModelList(draft.models),
    kind: draft.kind || PROVIDER_KIND_DEFAULT,
    // 0 clears the stored window (unknown); the server validates strictly too.
    context_window: window.value,
  }
  if (draft.apiKey.trim()) patch.api_key = draft.apiKey.trim()
  busy.value = true
  detailError.value = null
  try {
    const saved = await updateProvider(provider.name, patch)
    // the PUT response is the merged view; keep our additive seed flags
    emit('update:providers', applyProviderUpdate(props.providers, saved))
    announce(`Saved ${provider.name}.`)
    closeDetail(true)
  } catch (e) {
    detailError.value =
      e instanceof ApiError && e.status === 400 && /base_url/i.test(e.message)
        ? 'Base URL must not be empty.'
        : errText(e)
  } finally {
    busy.value = false
  }
}

async function confirmDelete(): Promise<void> {
  const provider = openProvider.value
  if (!provider || busy.value || addBusy.value || pendingReset.value) return
  busy.value = true
  deleteError.value = null
  try {
    await deleteProvider(provider.name)
    emit('deleted', provider.name)
    // Optimistic removal: if the reconciling refresh below fails, the deleted
    // row must still disappear (a stale list must not keep it editable).
    emit('update:providers', applyProviderDelete(props.providers, provider.name))
    announce(`Deleted ${provider.name}.`)
    const removedName = provider.name
    pendingDelete.value = false
    openName.value = null
    resetDraft(null)
    resetDiscovery()
    await refreshProviders(false)
    await nextTick()
    activeName.value = resolveProviderSelection(views.value, null)
    void nextTick(() => {
      if (activeName.value === removedName) focusRow(views.value[0]?.name)
      else focusRow(activeName.value)
    })
  } catch (e) {
    deleteError.value = errText(e)
  } finally {
    busy.value = false
  }
}

function requestDelete(): void {
  if (!openProvider.value || busy.value || addBusy.value || pendingReset.value) return
  pendingDelete.value = true
  deleteError.value = null
  void nextTick(() => deleteCancelButton.value?.focus())
}

function requestReset(): void {
  const provider = openProvider.value
  if (!provider || busy.value || addBusy.value || pendingReset.value) return
  if (!providerResetAllowed(provider)) return
  pendingReset.value = provider.name
  resetError.value = null
  completedResetName.value = null
}

function cancelReset(): void {
  if (busy.value) return
  pendingReset.value = null
  resetError.value = null
}

function handleResetAfterLeave(): void {
  const name = completedResetName.value
  if (!name) return
  completedResetName.value = null
  if (openName.value === name) detailHeading.value?.focus()
  else focusRow(name)
}

async function confirmReset(): Promise<void> {
  const name = pendingReset.value
  if (!name || busy.value || addBusy.value) return
  const provider = views.value.find((entry) => entry.name === name)
  if (!providerResetAllowed(provider)) return
  busy.value = true
  resetError.value = null
  try {
    const restored = await resetProvider(name)
    const next = applyProviderReset(props.providers, restored)
    const restoredView = normalizeProviders([restored])[0] ?? null
    // Reset replaces the override in place; never emit `deleted` or clear role refs.
    emit('update:providers', next)
    pendingReset.value = null
    pendingClose.value = null
    pendingDelete.value = false
    detailError.value = null
    deleteError.value = null
    if (openName.value === name) resetDraft(restoredView)
    resetDiscovery()
    completedResetName.value = name
    announce(`Reset ${name} to default. Role assignments remain unchanged.`)
  } catch (e) {
    resetError.value =
      e instanceof ApiError && e.status === 404
        ? 'This backend does not support Reset to default yet. Your customized values, unsaved edits, and role assignments were not changed.'
        : errText(e)
  } finally {
    busy.value = false
  }
}

function openAdd(prefill?: CatalogImport): void {
  if (addBusy.value || busy.value || pendingReset.value) return
  addOpen.value = true
  addNameError.value = null
  addBaseUrlError.value = null
  addContextWindowError.value = null
  addFormError.value = null
  resetAddDiscovery()
  if (prefill) {
    // Catalog prefill: every field stays editable; the key is never supplied.
    addName.value = prefill.name
    addBaseUrl.value = prefill.base_url
    addKind.value = prefill.kind || PROVIDER_KIND_DEFAULT
    addModels.value = cleanModelList(prefill.models)
    addApiKey.value = ''
    addContextWindow.value =
      prefill.context_window > 0 ? String(prefill.context_window) : ''
    addCatalogId.value = prefill.catalog_id
  } else {
    addCatalogId.value = null
  }
  void nextTick(() => {
    addCard.value?.scrollIntoView({ block: 'nearest' })
    // A catalog import starts with the API key (the only field the catalog
    // cannot fill); a manual Add starts with the name.
    if (prefill) addApiKeyInput.value?.focus()
    else addNameInput.value?.focus()
  })
}

function closeAdd(): void {
  if (addBusy.value) return
  addOpen.value = false
  addName.value = ''
  addBaseUrl.value = ''
  addApiKey.value = ''
  addModels.value = []
  addKind.value = PROVIDER_KIND_DEFAULT
  addContextWindow.value = ''
  addCatalogId.value = null
  addNameError.value = null
  addBaseUrlError.value = null
  addContextWindowError.value = null
  addFormError.value = null
  resetAddDiscovery()
}

/** Drop the Add-card probe result and invalidate an in-flight one. */
function resetAddDiscovery(): void {
  addDiscoverySequence += 1
  addDiscovery.value = newDiscoveryState()
  addDiscoverySelection.value = []
  addDiscoveryFilter.value = ''
}

/** Push the current discovery selection into the Add draft's model list. */
function applyAddSelection(): void {
  addModels.value = applyAddModelSelection(
    addModels.value,
    addDiscoveryModels.value,
    addDiscoverySelection.value,
  )
}

/**
 * Probe the Add draft's endpoint for its model list through the name-agnostic
 * draft route (`POST /api/providers/discover`). Writes nothing: the provider
 * exists only after Add provider. Only the key typed in this form is sent —
 * the route never resolves stored or env credentials — so a keyless local
 * endpoint probes unauthenticated even when other presets have keys. A fetch
 * selects nothing: the operator checks the models to add (or Select all).
 */
async function fetchAddModels(): Promise<void> {
  if (addBusy.value || addDiscovering.value) return
  const token = ++addDiscoverySequence
  const started = startDiscovery(ADD_DISCOVERY_NAME, token)
  // Honest early answer for wire kinds without a live model listing.
  if (!supportsModelDiscovery(addKind.value)) {
    const message = unsupportedDiscoveryCopy(addKind.value)
    addDiscovery.value = failDiscovery(started, token, ADD_DISCOVERY_NAME, 400, message)
    announce(message)
    return
  }
  const request: ProviderDiscoverRequest = {
    base_url: addBaseUrl.value.trim(),
    kind: addKind.value || PROVIDER_KIND_DEFAULT,
  }
  // Only the key typed in this form is sent; it is write-only for this one
  // request and never persisted or echoed.
  const typedKey = addApiKey.value.trim()
  if (typedKey) request.api_key = typedKey
  addDiscovery.value = started
  announce('Asking the endpoint for its model list…')
  try {
    const result = await discoverDraftProviderModels(request)
    if (!isCurrentDiscovery(addDiscovery.value, token, ADD_DISCOVERY_NAME)) return
    addDiscovery.value = settleDiscovery(addDiscovery.value, token, ADD_DISCOVERY_NAME, result.models)
    const phase = addDiscovery.value.phase
    if (phase === 'ready') {
      // Nothing is preselected: the operator explicitly checks what to add.
      addDiscoverySelection.value = defaultAddModelSelection(addDiscovery.value.models)
      applyAddSelection()
      const count = addDiscovery.value.models.length
      announce(`${count} model${count === 1 ? '' : 's'} found. Select the ones to add.`)
    } else {
      addDiscoverySelection.value = []
      addDiscoveryFilter.value = ''
      announce(addDiscovery.value.message)
    }
  } catch (e) {
    if (!isCurrentDiscovery(addDiscovery.value, token, ADD_DISCOVERY_NAME)) return
    const status = e instanceof ApiError ? e.status : 0
    addDiscovery.value = failDiscovery(addDiscovery.value, token, ADD_DISCOVERY_NAME, status, errText(e))
    addDiscoverySelection.value = []
    addDiscoveryFilter.value = ''
    announce(addDiscovery.value.message)
  }
}

function onAddDiscoveryToggle(model: string, event: Event): void {
  const checked = event.target instanceof HTMLInputElement ? event.target.checked : false
  // The :checked binding keeps the model and the box in sync, so the toggle
  // result matches the box; the checkbox state still wins defensively.
  const next = new Set(toggleModelSelection(addDiscoverySelection.value, model))
  if (checked) next.add(model)
  else next.delete(model)
  // Keep discovery order (not click order) so the draft list stays stable.
  addDiscoverySelection.value = addDiscoveryModels.value.filter((entry) => next.has(entry))
  applyAddSelection()
}

/** Select all visible rows (a filter narrows what Select all applies to). */
function selectAllAddDiscovery(): void {
  addDiscoverySelection.value = selectAllModels(
    addDiscoverySelection.value,
    addDiscoveryVisibleModels.value,
  )
  applyAddSelection()
}

function clearAddDiscovery(): void {
  addDiscoverySelection.value = []
  applyAddSelection()
}

function onAddModelsChange(value: string[]): void {
  addModels.value = cleanModelList(value)
}

function onAddKindChange(value: string): void {
  addKind.value = value || PROVIDER_KIND_DEFAULT
}

function onAddContextWindowChange(value: string): void {
  addContextWindow.value = value
  addContextWindowError.value = null
}

function openBrowse(): void {
  if (browseDisabled.value) return
  browseOpen.value = true
}

function closeBrowse(): void {
  browseOpen.value = false
}

/** One import only prefills the Add card; nothing is saved until Add provider. */
function handleCatalogImport(payload: CatalogImport): void {
  browseOpen.value = false
  openAdd(payload)
  announce(importAnnouncement(payload.models.length, payload.catalog_id))
}

async function submitAdd(): Promise<void> {
  if (addBusy.value || busy.value || pendingReset.value) return
  const validation = validateAddProviderForm(
    { name: addName.value, baseUrl: addBaseUrl.value },
    views.value.map((provider) => provider.name),
  )
  addNameError.value = validation?.name ?? null
  addBaseUrlError.value = validation?.baseUrl ?? null
  const window = parseProviderContextWindow(addContextWindow.value)
  addContextWindowError.value = window.error
  addFormError.value = null
  if (validation || window.error) return
  addBusy.value = true
  let created: ProviderPreset | null = null
  try {
    const body: ProviderCreateRequest = {
      name: addName.value.trim(),
      base_url: addBaseUrl.value.trim(),
      kind: addKind.value || PROVIDER_KIND_DEFAULT,
    }
    if (addApiKey.value.trim()) body.api_key = addApiKey.value.trim()
    if (addModels.value.length) body.models = cleanModelList(addModels.value)
    // 0/empty = unknown; the field is only sent when the operator set a window.
    if (window.value > 0) body.context_window = window.value
    if (addCatalogId.value) body.catalog_id = addCatalogId.value
    created = await createProvider(body)
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) {
      addNameError.value = 'A provider already uses this ID.'
    } else if (e instanceof ApiError && e.status === 400 && /base_url/i.test(e.message)) {
      addBaseUrlError.value = 'Base URL must not be empty.'
    } else if (e instanceof ApiError && e.status === 400 && /name/i.test(e.message)) {
      addNameError.value = errText(e)
    } else {
      addFormError.value = errText(e)
    }
  } finally {
    addBusy.value = false
  }
  // The success tail runs only after addBusy is cleared: closeAdd() (and the
  // next openAdd) are no-ops while a save is in flight.
  if (created !== null) {
    announce(`Added ${created.name}.`)
    closeAdd()
    await refreshProviders(false)
    // the parent's prop update lands on the next render; select/open after it
    await nextTick()
    activeName.value = created.name
    openDetail(created.name, true)
  }
}
</script>

<template>
  <div ref="sectionRoot" class="providers-section" :id="panelId">
    <p class="providers-lead">
      Presets supply the base URL and API key for roles that select them. Provider changes apply
      immediately; role and plugin changes still need Save.
    </p>

    <div v-if="listError || initialError" class="providers-error" role="alert">
      <span class="providers-error-text">{{ listError ?? initialError }}</span>
      <button type="button" class="providers-retry" @click="refreshProviders(true)">
        Retry
      </button>
    </div>

    <p v-if="effectiveLoading" class="providers-loading" role="status">
      <span class="providers-spinner" aria-hidden="true"></span>
      Loading providers…
    </p>

    <p v-else-if="!views.length" class="providers-empty">
      No providers are available. Add a custom provider below, or keep both roles on Manual
      connections.
    </p>

    <template v-else>
      <ul class="provider-list" role="list" aria-label="Providers">
        <li
          v-for="(provider, index) in views"
          :key="provider.name"
          class="provider-item"
        >
          <button
            :id="optionId(index)"
            :ref="(el) => setRowRef(el, provider.name)"
            type="button"
            class="provider-row"
            :class="{ 'is-open': openName === provider.name }"
            :aria-expanded="openName === provider.name"
            :aria-controls="openName === provider.name ? detailId(index) : undefined"
            :aria-current="openName === provider.name ? 'true' : undefined"
            :tabindex="(activeName ?? views[0]?.name) === provider.name ? 0 : -1"
            :title="providerRowSummary(provider)"
            @click="toggleRow(provider.name)"
            @keydown="onRowKeydown($event, provider, index)"
          >
            <span class="provider-row-name">{{ provider.name }}</span>
            <span
              v-for="role in roleBadges(provider)"
              :key="role"
              class="provider-role"
              :class="
                role === 'Senior' ? 'is-senior' : role === 'Junior' ? 'is-junior' : 'is-subagent'
              "
              role="img"
              :aria-label="`Used by ${role}`"
              :title="`Used by the ${role} role`"
            >{{ role }}</span>
            <span
              v-if="providerIsCustomizedSeed(provider)"
              class="provider-row-tag"
              title="This built-in preset has a saved override"
            >Customized</span>
            <span
              v-if="!provider.seed"
              class="provider-row-tag"
              title="A provider you added (deletable)"
            >custom</span>
            <span
              class="provider-key-dot"
              :class="{ 'is-set': provider.api_key_set }"
              role="img"
              :aria-label="apiKeyStateLabel(provider)"
              :title="apiKeyStateLabel(provider)"
            ></span>
            <svg
              class="provider-row-chevron"
              :class="{ 'is-open': openName === provider.name }"
              viewBox="0 0 16 16"
              width="12"
              height="12"
              fill="none"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="m6 4 4 4-4 4" />
            </svg>
          </button>

          <section
            v-if="openName === provider.name"
            :id="detailId(index)"
            class="provider-detail"
            role="region"
            :aria-labelledby="detailTitleId(index)"
            :aria-busy="busy || discovering"
          >
            <header class="provider-detail-header">
              <h3
                :id="detailTitleId(index)"
                :ref="setHeadingRef"
                class="provider-detail-title"
                tabindex="-1"
              >
                {{ provider.name }}
              </h3>
              <span class="provider-badge">{{ providerBadge(provider) }}</span>
              <span v-if="providerIsCustomizedSeed(provider)" class="provider-badge is-muted">
                Customized
              </span>
              <span
                v-for="role in usageRoles"
                :key="role"
                class="provider-badge is-role"
                :aria-label="`Used by ${role}`"
              >
                Used by {{ role }}
              </span>
              <span class="provider-kind-chip">{{ providerKindLabel(provider.kind) }}</span>
            </header>
            <p class="provider-id-line">
              Provider ID <code>{{ provider.name }}</code> · the name every role reference uses
              (not editable)
            </p>

            <label class="provider-field">
              <span class="provider-field-label">Base URL</span>
              <n-input
                :ref="setBaseUrlInput"
                v-model:value="draft.baseUrl"
                :disabled="busy"
                placeholder="http://127.0.0.1:1234/v1"
                @keydown.enter.prevent="saveSelected"
              />
            </label>

            <label class="provider-field">
              <span class="provider-field-label">Context window (tokens)</span>
              <n-input
                v-model:value="draft.contextWindow"
                :status="contextWindowProblem ? 'error' : undefined"
                :input-props="{
                  inputmode: 'numeric',
                  'aria-invalid': contextWindowProblem ? 'true' : undefined,
                  'aria-describedby': contextWindowProblem
                    ? 'provider-context-window-error'
                    : undefined,
                }"
                :disabled="busy"
                placeholder="0 (unknown)"
                @keydown.enter.prevent="saveSelected"
              />
              <span
                v-if="contextWindowProblem"
                id="provider-context-window-error"
                class="provider-field-error"
                role="alert"
              >
                {{ contextWindowProblem }}
              </span>
              <span v-else class="provider-field-note">
                0 = unknown. Used only for context compaction; a run-level flag, environment
                variable, or saved Advanced context window wins over this preset.
              </span>
            </label>

            <label class="provider-field">
              <span class="provider-field-label">API key</span>
              <n-input
                v-model:value="draft.apiKey"
                type="password"
                show-password-on="click"
                autocomplete="off"
                :disabled="busy"
                :placeholder="apiKeyPlaceholder(provider)"
                @keydown.enter.prevent="saveSelected"
              />
              <span class="provider-field-note">
                Leave blank to keep the saved key. Stored encrypted; it is never sent back to this
                app.
              </span>
            </label>

            <div class="provider-field">
              <span class="provider-field-label">Models</span>
              <n-dynamic-tags
                :value="draft.models"
                :disabled="busy"
                :input-props="{ placeholder: 'Model ID' }"
                @update:value="onModelsChange"
              >
                <template #trigger="{ activate, disabled }">
                  <n-button
                    attr-type="button"
                    size="small"
                    dashed
                    :disabled="disabled"
                    @click="activate"
                  >
                    + Add model
                  </n-button>
                </template>
              </n-dynamic-tags>
              <div class="provider-models-actions">
                <n-button
                  attr-type="button"
                  size="tiny"
                  :loading="discovering"
                  :disabled="busy || addBusy || discovering"
                  @click="refreshModels"
                >
                  {{ discovering ? 'Refreshing models…' : 'Refresh models' }}
                </n-button>
                <span
                  v-if="discoveryText"
                  class="provider-field-note provider-discovery-status"
                  :class="{
                    'is-error': discovery.phase === 'error',
                    'is-unsupported': discovery.phase === 'unsupported',
                    'is-empty': discovery.phase === 'empty',
                  }"
                >
                  {{ discoveryText }}
                </span>
              </div>
              <fieldset v-if="discoveryModels.length" class="provider-discovery">
                <legend class="provider-discovery-legend">Models reported by the endpoint</legend>
                <div class="provider-discovery-head">
                  <span
                    :id="discoveryCountId"
                    class="provider-discovery-count"
                    role="status"
                    aria-live="polite"
                  >
                    {{ discoverySelectedCount }} of {{ discoveryModels.length }} selected
                  </span>
                  <button
                    type="button"
                    class="provider-link-button"
                    :disabled="busy || addBusy || !discoveryCanSelectAll"
                    @click="selectAllDiscovery"
                  >
                    Select all
                  </button>
                  <button
                    type="button"
                    class="provider-link-button is-quiet"
                    :disabled="busy || addBusy || !discoverySelection.length"
                    @click="clearDiscoverySelection"
                  >
                    Clear
                  </button>
                </div>
                <label
                  v-if="discoveryModels.length > MODEL_FILTER_THRESHOLD"
                  class="provider-discovery-filter"
                >
                  <span class="provider-discovery-filter-label">Filter models</span>
                  <input
                    v-model="discoveryFilter"
                    type="search"
                    class="provider-discovery-filter-input"
                    placeholder="Filter models"
                    autocomplete="off"
                  />
                </label>
                <p v-if="!discoveryVisibleModels.length" class="provider-discovery-empty">
                  No reported models match “{{ discoveryFilter.trim() }}”.
                </p>
                <ul
                  v-else
                  class="provider-discovery-list"
                  role="group"
                  :aria-labelledby="discoveryCountId"
                >
                  <li v-for="model in discoveryVisibleModels" :key="model">
                    <label
                      class="provider-discovery-row"
                      :class="{ 'is-in-draft': discoveryInDraft.has(model) }"
                    >
                      <input
                        type="checkbox"
                        class="provider-discovery-check"
                        :checked="discoveryInDraft.has(model) || discoverySelection.includes(model)"
                        :disabled="busy || addBusy || discoveryInDraft.has(model)"
                        @change="onDiscoveryToggle(model, $event)"
                      />
                      <code class="provider-discovery-id">{{ model }}</code>
                      <span v-if="discoveryInDraft.has(model)" class="provider-discovery-in-draft">
                        in draft
                      </span>
                    </label>
                  </li>
                </ul>
                <p v-if="discoveryAllInDraft" class="provider-discovery-note">
                  All reported models are already in the draft.
                </p>
                <n-button
                  class="provider-discovery-add"
                  attr-type="button"
                  size="tiny"
                  type="primary"
                  :disabled="busy || addBusy || !discoverySelectedCount"
                  @click="useDiscoveredModels"
                >
                  Add selected ({{ discoverySelectedCount }})
                </n-button>
              </fieldset>
              <span class="provider-field-note">
                Model IDs are suggestions for the role pickers and onboarding; set the model each
                role actually uses in Models &amp; roles. Refresh probes the current Base URL and
                Kind (with the API key typed above, or the saved key when blank) without saving, and
                lists the reported ids so you choose which ones to add to the draft; the offline path
                is <code>two-brothers models --base-url &lt;url&gt; [--kind google]</code>.
              </span>
            </div>

            <details class="provider-advanced">
              <summary class="provider-advanced-summary">Advanced</summary>
              <label class="provider-field provider-advanced-field">
                <span class="provider-field-label">Kind</span>
                <n-select
                  :value="draft.kind"
                  :options="kindOptions"
                  :disabled="busy"
                  size="small"
                  @update:value="onKindChange"
                />
                <span class="provider-field-note">
                  Wire family: openai-compatible, anthropic or google. Changing it changes the API
                  adapter used for this provider.
                </span>
              </label>
            </details>

            <div v-if="detailError" class="provider-detail-error" role="alert">
              {{ detailError }}
            </div>

            <div v-if="pendingClose" class="provider-discard" role="alert">
              <p class="provider-discard-text">Discard unsaved changes?</p>
              <button
                :ref="setDiscardButton"
                type="button"
                class="provider-link-button"
                @click="resolveOpenIntent(true)"
              >
                Discard
              </button>
              <button
                type="button"
                class="provider-link-button is-quiet"
                @click="resolveOpenIntent(false)"
              >
                Keep editing
              </button>
            </div>

            <div v-else-if="pendingDelete" class="provider-delete-confirm" role="alert">
              <p class="provider-delete-title">Delete provider “{{ provider.name }}”?</p>
              <p class="provider-delete-impact">{{ deleteImpact }}</p>
              <p v-if="deleteError" class="provider-delete-error" role="alert">{{ deleteError }}</p>
              <div class="provider-detail-actions">
                <button
                  :ref="setDeleteCancelButton"
                  type="button"
                  class="provider-link-button"
                  @click="pendingDelete = false"
                >
                  Cancel
                </button>
                <n-button
                  attr-type="button"
                  size="small"
                  type="error"
                  :loading="busy"
                  :disabled="busy"
                  @click="confirmDelete"
                >
                  Delete provider
                </n-button>
              </div>
            </div>

            <div v-else class="provider-detail-actions">
              <n-button
                attr-type="button"
                :disabled="busy || addBusy || !draftDirty"
                @click="closeDetail(true)"
              >
                Cancel
              </n-button>
              <n-button
                attr-type="button"
                type="primary"
                :disabled="busy || addBusy || discovering || !draftDirty"
                :loading="busy"
                @click="saveSelected"
              >
                Save changes
              </n-button>
              <span class="provider-actions-spacer" />
              <n-button
                v-if="providerResetAllowed(provider)"
                attr-type="button"
                size="small"
                quaternary
                type="error"
                :disabled="busy || addBusy"
                @click="requestReset"
              >
                Reset to default
              </n-button>
              <n-button
                v-if="providerDeleteAllowed(provider)"
                attr-type="button"
                size="small"
                quaternary
                type="error"
                :disabled="busy || addBusy"
                @click="requestDelete"
              >
                Delete
              </n-button>
            </div>

            <p class="provider-detail-note">
              Changes apply immediately. A role using this provider picks them up on its next run.
            </p>
          </section>
        </li>
      </ul>

      <p class="providers-note">Environment pins override presets for that role (see Advanced).</p>

      <div v-if="!addOpen" class="provider-add-row">
        <n-button attr-type="button" dashed @click="openAdd()">+ Add provider</n-button>
        <n-button
          attr-type="button"
          class="provider-browse-button"
          :disabled="browseDisabled"
          @click="openBrowse"
        >
          Browse models.dev…
        </n-button>
      </div>
      <p v-if="!addOpen" class="provider-add-note">
        Browse the public models.dev catalog to prefill a provider. Nothing is saved until you add it.
      </p>

      <div v-else ref="addCard" class="provider-add" @keydown.esc.stop="closeAdd">
        <h3 class="provider-add-title">Add provider</h3>
        <label class="provider-field">
          <span class="provider-field-label">Name (Provider ID)</span>
          <n-input
            ref="addNameInput"
            v-model:value="addName"
            :status="addNameError ? 'error' : undefined"
            :disabled="addBusy"
            placeholder="e.g. lm-studio"
            @keydown.enter.prevent="submitAdd"
          />
          <span v-if="addNameError" class="provider-field-error" role="alert">{{ addNameError }}</span>
          <span v-else class="provider-field-note">
            Lowercase letters, digits and hyphens, starting with a letter. Not editable later.
          </span>
        </label>
        <label class="provider-field">
          <span class="provider-field-label">Base URL</span>
          <n-input
            v-model:value="addBaseUrl"
            :status="addBaseUrlError ? 'error' : undefined"
            :disabled="addBusy"
            placeholder="http://127.0.0.1:1234/v1"
            @keydown.enter.prevent="submitAdd"
          />
          <span v-if="addBaseUrlError" class="provider-field-error" role="alert">
            {{ addBaseUrlError }}
          </span>
        </label>
        <label class="provider-field">
          <span class="provider-field-label">
            API key <span class="provider-optional">(optional)</span>
          </span>
          <n-input
            ref="addApiKeyInput"
            v-model:value="addApiKey"
            type="password"
            show-password-on="click"
            autocomplete="off"
            :disabled="addBusy"
            placeholder="stored encrypted, never shown again"
            @keydown.enter.prevent="submitAdd"
          />
        </label>
        <div class="provider-field">
          <span class="provider-field-label">Models (optional)</span>
          <n-dynamic-tags
            :value="addModels"
            :disabled="addBusy"
            :input-props="{ placeholder: 'Model ID' }"
            @update:value="onAddModelsChange"
          >
            <template #trigger="{ activate, disabled }">
              <n-button attr-type="button" size="small" dashed :disabled="disabled" @click="activate">
                + Add model
              </n-button>
            </template>
          </n-dynamic-tags>
          <div class="provider-models-actions">
            <n-button
              attr-type="button"
              size="tiny"
              :loading="addDiscovering"
              :disabled="addBusy || addDiscovering || !addFetchEligible"
              @click="fetchAddModels"
            >
              {{ addDiscovering ? 'Fetching models…' : 'Fetch models' }}
            </n-button>
            <span
              v-if="addDiscoveryText"
              class="provider-field-note provider-discovery-status"
              :class="{
                'is-error': addDiscovery.phase === 'error',
                'is-unsupported': addDiscovery.phase === 'unsupported',
                'is-empty': addDiscovery.phase === 'empty',
              }"
              :role="addDiscoveryAlert ? 'alert' : 'status'"
            >
              {{ addDiscoveryText }}
            </span>
            <span v-else-if="!addFetchEligible" class="provider-field-note">
              Fetch models asks an OpenAI-compatible or Google Gemini endpoint for its model list:
              enter a valid Base URL and keep a supported kind. Manual ids above always work.
            </span>
          </div>
          <fieldset v-if="addDiscoveryModels.length" class="provider-discovery">
            <legend class="provider-discovery-legend">Models reported by the endpoint</legend>
            <div class="provider-discovery-head">
              <span
                :id="addDiscoveryCountId"
                class="provider-discovery-count"
                role="status"
                aria-live="polite"
              >
                {{ addDiscoverySelection.length }} of {{ addDiscoveryModels.length }} selected
              </span>
              <button
                type="button"
                class="provider-link-button"
                :disabled="addBusy || !addDiscoveryCanSelectAll"
                @click="selectAllAddDiscovery"
              >
                Select all
              </button>
              <button
                type="button"
                class="provider-link-button is-quiet"
                :disabled="addBusy || !addDiscoverySelection.length"
                @click="clearAddDiscovery"
              >
                Clear
              </button>
            </div>
            <label
              v-if="addDiscoveryModels.length > MODEL_FILTER_THRESHOLD"
              class="provider-discovery-filter"
            >
              <span class="provider-discovery-filter-label">Filter models</span>
              <input
                v-model="addDiscoveryFilter"
                type="search"
                class="provider-discovery-filter-input"
                placeholder="Filter models"
                autocomplete="off"
              />
            </label>
            <p v-if="!addDiscoveryVisibleModels.length" class="provider-discovery-empty">
              No reported models match “{{ addDiscoveryFilter.trim() }}”.
            </p>
            <ul
              v-else
              class="provider-discovery-list"
              role="group"
              :aria-labelledby="addDiscoveryCountId"
            >
              <li v-for="model in addDiscoveryVisibleModels" :key="model">
                <label class="provider-discovery-row">
                  <input
                    type="checkbox"
                    class="provider-discovery-check"
                    :checked="addDiscoverySelection.includes(model)"
                    :disabled="addBusy"
                    @change="onAddDiscoveryToggle(model, $event)"
                  />
                  <code class="provider-discovery-id">{{ model }}</code>
                </label>
              </li>
            </ul>
          </fieldset>
        </div>
        <details class="provider-advanced">
          <summary class="provider-advanced-summary">Advanced</summary>
          <label class="provider-field provider-advanced-field">
            <span class="provider-field-label">Kind</span>
            <n-select
              :value="addKind"
              :options="addKindOptions"
              :disabled="addBusy"
              size="small"
              @update:value="onAddKindChange"
            />
          </label>
          <label class="provider-field provider-advanced-field">
            <span class="provider-field-label">Context window (tokens)</span>
            <n-input
              :value="addContextWindow"
              :status="addContextWindowError ? 'error' : undefined"
              :input-props="{
                inputmode: 'numeric',
                'aria-invalid': addContextWindowError ? 'true' : undefined,
              }"
              :disabled="addBusy"
              placeholder="tokens; 0 = unknown"
              @update:value="onAddContextWindowChange"
              @keydown.enter.prevent="submitAdd"
            />
            <span v-if="addContextWindowError" class="provider-field-error" role="alert">
              {{ addContextWindowError }}
            </span>
            <span v-else-if="addCatalogId" class="provider-field-note">
              Context window is the smallest window among the selected models; edit or clear it
              if that is not what you want.
            </span>
            <span v-else class="provider-field-note">
              Used as a compaction fallback for this provider. 0 = unknown.
            </span>
          </label>
        </details>
        <div v-if="addFormError" class="provider-add-error" role="alert">{{ addFormError }}</div>
        <div class="provider-add-actions">
          <n-button attr-type="button" size="small" :disabled="addBusy" @click="closeAdd">
            Cancel
          </n-button>
          <n-button
            attr-type="button"
            size="small"
            type="primary"
            :loading="addBusy"
            :disabled="addBusy"
            @click="submitAdd"
          >
            {{ addBusy ? 'Adding…' : 'Add provider' }}
          </n-button>
        </div>
      </div>
    </template>

    <AppDialog
      :show="pendingReset !== null"
      size="sm"
      :title="`Reset ${resetTarget?.name ?? 'provider'} to default?`"
      description="Customized values and the stored override API key will be discarded. Senior and Junior role assignments remain unchanged."
      :persistent="busy"
      initial-focus=".provider-reset-cancel"
      @close="cancelReset"
      @after-leave="handleResetAfterLeave"
    >
      <div class="provider-reset-confirm">
        <p class="provider-reset-copy">
          Any unsaved edits in this form will also be discarded. The provider itself is not deleted.
        </p>
        <p v-if="resetError" class="provider-reset-error" role="alert">{{ resetError }}</p>
      </div>
      <template #footer>
        <n-button
          class="provider-reset-cancel"
          attr-type="button"
          :disabled="busy"
          @click="cancelReset"
        >
          Cancel
        </n-button>
        <n-button
          attr-type="button"
          type="error"
          :loading="busy"
          :disabled="busy"
          @click="confirmReset"
        >
          {{ busy ? 'Resetting…' : 'Reset to default' }}
        </n-button>
      </template>
    </AppDialog>

    <!-- Mounted only while open: the first catalog fetch happens on open, never
         on a Settings render. Import prefills the Add card above and saves
         nothing. -->
    <ModelsDevBrowser
      v-if="browseOpen"
      :show="browseOpen"
      :existing-names="providerNames"
      @close="closeBrowse"
      @import="handleCatalogImport"
    />

    <p :id="announcementId" class="visually-hidden" role="status" aria-live="polite">
      {{ announcement }}
    </p>
  </div>
</template>

<style scoped>
/* All styling is scoped here (the global sheet is owned by the Appearance lane)
   and uses the shared design tokens only. */

.providers-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}

.providers-lead {
  margin: 0;
  font-size: 0.8rem;
  line-height: 1.5;
  color: var(--text-secondary);
}

.providers-error {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 10px;
  font-size: 0.78rem;
  color: var(--danger);
  background: var(--danger-soft);
  border: 1px solid var(--danger);
  border-radius: var(--radius-sm);
}

.providers-error-text {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}

.providers-retry {
  flex: none;
  padding: 0;
  font: inherit;
  font-weight: 600;
  color: inherit;
  text-decoration: underline;
  cursor: pointer;
  background: none;
  border: none;
}

.providers-loading {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  padding: 16px;
  font-size: 0.8rem;
  color: var(--text-secondary);
}

.providers-spinner {
  width: 12px;
  height: 12px;
  border: 2px solid var(--border-strong);
  border-top-color: var(--accent);
  border-radius: 50%;
}

.providers-empty {
  margin: 0;
  padding: 16px;
  font-size: 0.8rem;
  line-height: 1.5;
  text-align: center;
  color: var(--text-secondary);
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius-md);
}

/* Identity-only list; the selected provider's card sits between its row and
   the next row (one open at a time). */
.provider-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--surface-canvas);
  overflow: hidden;
}

.provider-item {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.provider-item + .provider-item {
  border-top: 1px solid var(--border-subtle);
}

.provider-row {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  min-width: 0;
  padding: 8px 10px;
  font: inherit;
  font-size: 0.84rem;
  color: var(--text-primary);
  text-align: left;
  cursor: pointer;
  background: transparent;
  border: none;
}

.provider-row:hover {
  background: var(--surface-hover);
}

.provider-row.is-open {
  background: var(--accent-soft);
  color: var(--accent-text);
}

.provider-row:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: -2px;
}

.provider-row-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.provider-role {
  flex: none;
  padding: 0.5px 0;
  font-size: 0.68rem;
  font-weight: 600;
  letter-spacing: 0.01em;
  color: var(--text-secondary);
  white-space: nowrap;
}

.provider-role::before {
  display: inline-block;
  width: 6px;
  height: 6px;
  margin-right: 4px;
  content: '';
  vertical-align: 1px;
  background: currentColor;
  border-radius: 50%;
}

.provider-role:not(:last-of-type)::after {
  margin-left: 4px;
  content: '·';
  color: var(--text-tertiary);
}

.provider-role.is-senior {
  color: var(--senior);
}

.provider-role.is-junior {
  color: var(--junior);
}

.provider-role.is-subagent {
  color: var(--accent);
}

.provider-row-tag {
  flex: none;
  padding: 0 6px;
  font-size: 0.64rem;
  color: var(--text-secondary);
  white-space: nowrap;
  background: var(--surface-hover);
  border-radius: 999px;
}

.provider-key-dot {
  flex: none;
  width: 7px;
  height: 7px;
  background: transparent;
  border: 1.5px solid var(--border-strong);
  border-radius: 50%;
}

.provider-key-dot.is-set {
  background: var(--ok);
  border-color: var(--ok);
}

.provider-row-chevron {
  flex: none;
  color: var(--text-tertiary);
  transition: transform 120ms ease;
}

.provider-row-chevron.is-open {
  transform: rotate(90deg);
}

.provider-detail {
  display: flex;
  flex-direction: column;
  gap: 11px;
  margin: 0 8px 10px;
  padding: 12px 14px;
  background: var(--surface-panel);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
}

.provider-detail-header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 7px;
}

.provider-detail-title {
  margin: 0;
  overflow-wrap: anywhere;
  font-size: 0.95rem;
  font-weight: 650;
  color: var(--text-primary);
}

.provider-detail-title:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
}

.provider-badge {
  flex: none;
  padding: 0 7px;
  font-size: 0.66rem;
  font-weight: 500;
  line-height: 1.5;
  color: var(--text-secondary);
  white-space: nowrap;
  background: var(--surface-canvas);
  border: 1px solid var(--border-subtle);
  border-radius: 999px;
}

.provider-badge.is-muted {
  color: var(--text-tertiary);
}

.provider-badge.is-role {
  color: var(--accent-text);
  background: var(--accent-soft);
  border-color: transparent;
}

.provider-kind-chip {
  flex: none;
  padding: 0 7px;
  font-family: var(--font-mono);
  font-size: 0.66rem;
  line-height: 1.5;
  color: var(--text-secondary);
  white-space: nowrap;
  border: 1px dashed var(--border-strong);
  border-radius: 999px;
}

.provider-id-line {
  margin: -4px 0 0;
  font-size: 0.72rem;
  line-height: 1.45;
  color: var(--text-tertiary);
}

.provider-id-line code,
.provider-field-note code {
  font-family: var(--font-mono);
  font-size: 0.7rem;
}

.provider-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.provider-field-label {
  font-size: 0.72rem;
  font-weight: 600;
  color: var(--text-secondary);
}

.provider-field-note {
  font-size: 0.7rem;
  line-height: 1.45;
  color: var(--text-tertiary);
}

.provider-field-error {
  font-size: 0.72rem;
  line-height: 1.45;
  color: var(--danger);
}

/* "Refresh models": a manual probe of the current draft, separate from Apply. */
.provider-models-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.provider-discovery-status {
  flex: 1;
  min-width: 11rem;
}

.provider-discovery-status.is-error {
  color: var(--danger);
}

.provider-discovery-status.is-unsupported {
  color: var(--warning);
}

.provider-discovery-status.is-empty {
  color: var(--text-secondary);
}

/* Discovered-model pickers (detail "Refresh models" + Add-card "Fetch models"):
   an explicit checkbox list with an optional filter. */
.provider-discovery {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  margin: 0;
  padding: 8px 10px;
  background: var(--ok-soft);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
}

.provider-discovery-legend {
  padding: 0;
  font-size: 0.72rem;
  font-weight: 600;
  color: var(--text-secondary);
}

.provider-discovery-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}

.provider-discovery-count {
  flex: 1;
  min-width: 8rem;
  font-size: 0.7rem;
  color: var(--text-secondary);
}

.provider-discovery-filter {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.provider-discovery-filter-label {
  font-size: 0.68rem;
  font-weight: 600;
  color: var(--text-secondary);
}

.provider-discovery-filter-input {
  width: 100%;
  min-width: 0;
  padding: 3px 7px;
  font: inherit;
  font-size: 0.72rem;
  color: var(--text-primary);
  background: var(--surface-canvas);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
}

.provider-discovery-filter-input:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 1px;
}

.provider-discovery-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 240px;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;
}

.provider-discovery-row {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 3px 4px;
  border-radius: var(--radius-sm);
  cursor: pointer;
}

.provider-discovery-row:hover {
  background: var(--surface-hover);
}

.provider-discovery-row.is-in-draft {
  cursor: default;
}

.provider-discovery-row.is-in-draft:hover {
  background: none;
}

.provider-discovery-check {
  flex: none;
  margin: 0;
  accent-color: var(--accent);
  cursor: pointer;
}

.provider-discovery-check:disabled {
  cursor: default;
}

.provider-discovery-check:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
}

.provider-discovery-id {
  min-width: 0;
  overflow-wrap: anywhere;
  font-family: var(--font-mono);
  font-size: 0.72rem;
  color: var(--text-primary);
}

.provider-discovery-row.is-in-draft .provider-discovery-id {
  color: var(--text-tertiary);
}

.provider-discovery-in-draft {
  flex: none;
  font-size: 0.66rem;
  font-weight: 600;
  color: var(--text-tertiary);
}

.provider-discovery-note,
.provider-discovery-empty {
  margin: 0;
  font-size: 0.7rem;
  line-height: 1.45;
  color: var(--text-tertiary);
}

.provider-discovery-add {
  align-self: flex-start;
}

.provider-link-button:disabled {
  opacity: 0.5;
  cursor: default;
}

.provider-optional {
  font-weight: 400;
  opacity: 0.8;
}

.provider-advanced {
  border-top: 1px solid var(--border-subtle);
  padding-top: 7px;
}

.provider-advanced-summary {
  font-size: 0.72rem;
  font-weight: 600;
  color: var(--text-secondary);
  cursor: pointer;
}

.provider-advanced-summary:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
}

.provider-advanced-field {
  margin-top: 8px;
}

.provider-detail-error {
  padding: 6px 9px;
  font-size: 0.76rem;
  line-height: 1.45;
  color: var(--danger);
  overflow-wrap: anywhere;
  background: var(--danger-soft);
  border: 1px solid var(--danger);
  border-radius: var(--radius-sm);
}

.provider-detail-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.provider-actions-spacer {
  flex: 1;
  min-width: 8px;
}

.provider-detail-note {
  margin: 0;
  font-size: 0.7rem;
  line-height: 1.4;
  color: var(--text-tertiary);
}

.provider-link-button {
  padding: 0;
  font: inherit;
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--accent-text);
  text-decoration: underline;
  cursor: pointer;
  background: none;
  border: none;
}

.provider-link-button.is-quiet {
  color: var(--text-secondary);
}

.provider-link-button:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
}

.provider-discard {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  padding: 7px 9px;
  background: var(--warning-soft);
  border-radius: var(--radius-sm);
}

.provider-discard-text {
  flex: 1;
  min-width: 8rem;
  margin: 0;
  font-size: 0.78rem;
  color: var(--text-primary);
}

.provider-delete-confirm {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 9px 10px;
  background: var(--danger-soft);
  border: 1px solid var(--danger);
  border-radius: var(--radius-sm);
}

.provider-delete-title {
  margin: 0;
  font-size: 0.82rem;
  font-weight: 650;
  color: var(--text-primary);
}

.provider-delete-impact,
.provider-delete-error {
  margin: 0;
  font-size: 0.76rem;
  line-height: 1.45;
  color: var(--text-secondary);
  overflow-wrap: anywhere;
}

.provider-delete-error {
  color: var(--danger);
}

.provider-reset-confirm {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.provider-reset-copy,
.provider-reset-error {
  margin: 0;
  font-size: 0.8rem;
  line-height: 1.5;
  color: var(--text-secondary);
}

.provider-reset-error {
  padding: 7px 9px;
  color: var(--danger);
  overflow-wrap: anywhere;
  background: var(--danger-soft);
  border: 1px solid var(--danger);
  border-radius: var(--radius-sm);
}

.providers-note {
  margin: 0;
  font-size: 0.7rem;
  line-height: 1.4;
  color: var(--text-tertiary);
}

.provider-add-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.provider-add-note {
  margin: 0;
  font-size: 0.7rem;
  line-height: 1.4;
  color: var(--text-tertiary);
}

.provider-add {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 14px;
  background: var(--surface-canvas);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
}

.provider-add-title {
  margin: 0;
  font-size: 0.84rem;
  font-weight: 650;
}

.provider-add-error {
  margin: 0;
  font-size: 0.76rem;
  color: var(--danger);
  overflow-wrap: anywhere;
}

.provider-add-actions {
  display: flex;
  gap: 8px;
}

@media (prefers-reduced-motion: reduce) {
  /* Only the chevron rotates; it snaps when motion is reduced. */
  .provider-row-chevron {
    transition: none;
  }
}
</style>
