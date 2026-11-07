<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, useId, watch } from 'vue'
import type { ComponentPublicInstance } from 'vue'
import { NButton, NDynamicTags, NInput, NSelect } from 'naive-ui'
import type { InputInst } from 'naive-ui'
import {
  ApiError,
  createProvider,
  deleteProvider,
  discoverProviderModels,
  listProviders,
  resetProvider,
  updateProvider,
} from '../../api'
import type { ProviderCreateRequest, ProviderDiscoverRequest, ProviderPatchRequest } from '../../api'
import type { ProviderPreset } from '../../types'
import {
  PROVIDER_KIND_DEFAULT,
  PROVIDER_KINDS,
  apiKeyPlaceholder,
  apiKeyStateLabel,
  applyProviderReset,
  applyProviderUpdate,
  cleanModelList,
  discoveredAdditions,
  discoveryStatusText,
  failDiscovery,
  isCurrentDiscovery,
  isProviderDraftDirty,
  mergeDiscoveredModels,
  newDiscoveryState,
  nextProviderIndex,
  normalizeProviders,
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
  settleDiscovery,
  startDiscovery,
  supportsModelDiscovery,
  unsupportedDiscoveryCopy,
  validateAddProviderForm,
  validateProviderBaseUrl,
} from '../../providerSettings'
import type { ProviderDiscoveryState, ProviderDraft, ProviderView } from '../../providerSettings'
import AppDialog from '../AppDialog.vue'

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
      })
    : [],
)
const deleteImpact = computed(() => providerDeleteImpact(usageRoles.value))

const draft = reactive<ProviderDraft>({
  baseUrl: '',
  apiKey: '',
  models: [],
  kind: PROVIDER_KIND_DEFAULT,
})
const draftDirty = computed(() =>
  openProvider.value ? isProviderDraftDirty(openProvider.value, draft) : false,
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
const discoveryAdditions = computed(() =>
  discoveredAdditions(draft.models, discoveryModels.value),
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
const addNameError = ref<string | null>(null)
const addBaseUrlError = ref<string | null>(null)
const addFormError = ref<string | null>(null)

const rowEls = new Map<string, HTMLButtonElement>()
const sectionRoot = ref<HTMLElement | null>(null)
const detailHeading = ref<HTMLElement | null>(null)
const baseUrlInput = ref<InputInst | null>(null)
const addNameInput = ref<InputInst | null>(null)
const discardButton = ref<HTMLButtonElement | null>(null)
const deleteCancelButton = ref<HTMLButtonElement | null>(null)

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
}

/** Drop any probe result and invalidate an in-flight one (newer token wins). */
function resetDiscovery(): void {
  discoverySequence += 1
  discovery.value = newDiscoveryState()
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
  // Honest early answer for wire kinds without an OpenAI-compatible listing:
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
        `${count} model${count === 1 ? '' : 's'} reported by the endpoint. Nothing was saved.`,
      )
    } else if (phase === 'empty') {
      announce(discovery.value.message)
    }
  } catch (e) {
    if (!isCurrentDiscovery(discovery.value, token, name)) return
    const status = e instanceof ApiError ? e.status : 0
    discovery.value = failDiscovery(discovery.value, token, name, status, errText(e))
    announce(discovery.value.message)
  }
}

/** Explicit, draft-only merge of the reported models (still needs Save changes). */
function useDiscoveredModels(): void {
  if (!openProvider.value || busy.value || addBusy.value || !discoveryModels.value.length) return
  const additions = discoveryAdditions.value
  if (!additions.length) {
    announce('All reported models are already in the draft.')
    return
  }
  draft.models = mergeDiscoveredModels(draft.models, discoveryModels.value)
  announce(
    `Added ${additions.length} model${
      additions.length === 1 ? '' : 's'
    } to the draft. Save changes to keep them.`,
  )
}

function roleBadges(provider: ProviderView): Array<'Senior' | 'Junior'> {
  return providerUsageBadges(provider, {
    senior: props.seniorProviderRef,
    junior: props.juniorProviderRef,
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
  activeName.value = name
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
  const patch: ProviderPatchRequest = {
    base_url: draft.baseUrl.trim(),
    models: cleanModelList(draft.models),
    kind: draft.kind || PROVIDER_KIND_DEFAULT,
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

function openAdd(): void {
  if (addBusy.value || busy.value || pendingReset.value) return
  addOpen.value = true
  addNameError.value = null
  addBaseUrlError.value = null
  addFormError.value = null
  void nextTick(() => addNameInput.value?.focus())
}

function closeAdd(): void {
  if (addBusy.value) return
  addOpen.value = false
  addName.value = ''
  addBaseUrl.value = ''
  addApiKey.value = ''
  addModels.value = []
  addKind.value = PROVIDER_KIND_DEFAULT
  addNameError.value = null
  addBaseUrlError.value = null
  addFormError.value = null
}

function onAddModelsChange(value: string[]): void {
  addModels.value = cleanModelList(value)
}

function onAddKindChange(value: string): void {
  addKind.value = value || PROVIDER_KIND_DEFAULT
}

async function submitAdd(): Promise<void> {
  if (addBusy.value || busy.value || pendingReset.value) return
  const validation = validateAddProviderForm(
    { name: addName.value, baseUrl: addBaseUrl.value },
    views.value.map((provider) => provider.name),
  )
  addNameError.value = validation?.name ?? null
  addBaseUrlError.value = validation?.baseUrl ?? null
  addFormError.value = null
  if (validation) return
  addBusy.value = true
  try {
    const body: ProviderCreateRequest = {
      name: addName.value.trim(),
      base_url: addBaseUrl.value.trim(),
      kind: addKind.value || PROVIDER_KIND_DEFAULT,
    }
    if (addApiKey.value.trim()) body.api_key = addApiKey.value.trim()
    if (addModels.value.length) body.models = cleanModelList(addModels.value)
    const created = await createProvider(body)
    announce(`Added ${created.name}.`)
    closeAdd()
    await refreshProviders(false)
    // the parent's prop update lands on the next render; select/open after it
    await nextTick()
    activeName.value = created.name
    openDetail(created.name, true)
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
              :class="role === 'Senior' ? 'is-senior' : 'is-junior'"
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
              <div
                v-if="discoveryModels.length"
                class="provider-discovered"
                aria-label="Models reported by the endpoint"
              >
                <p class="provider-discovered-text">
                  Reported by the endpoint (not saved):
                  <code
                    v-for="model in discoveryModels"
                    :key="model"
                    class="provider-discovered-model"
                    >{{ model }}</code
                  >
                </p>
                <n-button
                  class="provider-discovered-action"
                  attr-type="button"
                  size="tiny"
                  :disabled="busy || addBusy || !discoveryAdditions.length"
                  @click="useDiscoveredModels"
                >
                  {{
                    discoveryAdditions.length
                      ? `Add ${discoveryAdditions.length} to draft`
                      : 'All in draft'
                  }}
                </n-button>
              </div>
              <span class="provider-field-note">
                Model IDs are suggestions for the role pickers and onboarding; set the model each
                role actually uses in Models &amp; roles. Refresh probes the current Base URL and
                Kind (with the API key typed above, or the saved key when blank) without saving; the
                offline path is <code>two-brothers models --base-url &lt;url&gt;</code>.
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
        <n-button attr-type="button" dashed @click="openAdd">+ Add provider</n-button>
      </div>

      <div v-else class="provider-add" @keydown.esc.stop="closeAdd">
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
  color: var(--accent);
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
  color: var(--accent);
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

.provider-discovered {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  background: var(--ok-soft);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
}

.provider-discovered-text {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 5px;
  margin: 0;
  font-size: 0.72rem;
  line-height: 1.5;
  color: var(--text-secondary);
}

.provider-discovered-model {
  padding: 0 6px;
  font-family: var(--font-mono);
  font-size: 0.68rem;
  line-height: 1.5;
  color: var(--text-primary);
  overflow-wrap: anywhere;
  background: var(--surface-canvas);
  border: 1px solid var(--border-subtle);
  border-radius: 999px;
}

.provider-discovered-action {
  align-self: flex-start;
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
  color: var(--accent);
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
