<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { NButton, NCheckbox, NInput } from 'naive-ui'
import type { InputInst } from 'naive-ui'
import { ApiError, getModelsDevProvider, listModelsDevProviders } from '../../api'
import {
  CATALOG_FAMILIES,
  CATALOG_EMPTY_COPY,
  CATALOG_LOADING_COPY,
  CATALOG_UNSUPPORTED_COPY,
  buildCatalogImport,
  catalogBanner,
  catalogProviderChips,
  defaultSelection,
  detailErrorCopy,
  familyBaseUrl,
  familyLabel,
  familyModels,
  filterCatalogModels,
  filterCatalogProviders,
  hardImportBlocker,
  isModelSelected,
  normalizeCatalogProviderDetail,
  normalizeCatalogProviders,
  primaryFamily,
  rejectReasonLabel,
  requiresBaseUrl,
  selectAllFamily,
  selectedModelIds,
  summaryErrorPhase,
  summaryPhase,
  toggleModelSelection,
  type CatalogDetailView,
  type CatalogFamily,
  type CatalogImport,
  type CatalogModelView,
  type CatalogPhase,
  type CatalogProviderView,
  type CatalogProvidersView,
} from '../../modelsDev'
import {
  nextProviderIndex,
  providerMoveForKey,
  validateProviderBaseUrl,
} from '../../providerSettings'
import AppDialog from '../AppDialog.vue'

/**
 * "Browse models.dev…" dialog: a read-only view of the backend's catalog that
 * prefills the existing Add-provider form. One pane at a time (provider list or
 * one provider's detail), bounded lists, client-side filtering only.
 *
 * The component is mounted by ProvidersSection only while the dialog is open
 * (`v-if`), so the first fetch happens on open — never on a Settings render.
 * Nothing is saved here: `import` only hands a prefill payload upward.
 */

const props = defineProps<{
  /** Dialog visibility (the parent also mounts this component with v-if). */
  show: boolean
  /** Locally loaded provider names, for the duplicate/planning hints. */
  existingNames: string[]
}>()

const emit = defineEmits<{
  close: []
  import: [CatalogImport]
}>()

const phase = ref<CatalogPhase>('loading')
const phaseMessage = ref('')
const providersView = ref<CatalogProvidersView | null>(null)
const bannerNow = ref(Date.now())
const summaryQuery = ref('')
const activeProviderId = ref<string | null>(null)

const selectedProviderId = ref<string | null>(null)
const detailPhase = ref<'idle' | 'loading' | 'ready' | 'unavailable' | 'notfound' | 'error'>(
  'idle',
)
const detailView = ref<CatalogDetailView | null>(null)
const detailMessage = ref('')
const family = ref<CatalogFamily | null>(null)
const selection = ref<string[]>([])
const modelQuery = ref('')
const typedBaseUrl = ref('')
const importNotice = ref('')

const providerSearch = ref<InputInst | null>(null)
const detailHeading = ref<HTMLElement | null>(null)
const rowEls = new Map<string, HTMLButtonElement>()

const filteredProviders = computed(() =>
  filterCatalogProviders(providersView.value?.providers ?? [], summaryQuery.value),
)
const banner = computed(() => catalogBanner(providersView.value, bannerNow.value))

const summaryCountText = computed(() => {
  if (phase.value !== 'ready') return ''
  const total = providersView.value?.providers.length ?? 0
  const shown = filteredProviders.value.length
  if (shown === total) return `${total} provider${total === 1 ? '' : 's'}`
  return `${shown} of ${total} providers`
})

const detailTitle = computed(
  () => detailView.value?.provider.name ?? selectedProviderId.value ?? 'Provider',
)
const detailKindLabel = computed(() =>
  detailView.value ? familyLabel(detailView.value.provider.kind) : '',
)

const familyModelsList = computed<CatalogModelView[]>(() =>
  detailView.value !== null && family.value !== null
    ? familyModels(detailView.value, family.value)
    : [],
)
const filteredModels = computed(() =>
  filterCatalogModels(familyModelsList.value, modelQuery.value),
)
const familyOptions = computed(() =>
  CATALOG_FAMILIES.map((value) => ({
    value,
    label: familyLabel(value),
    count: detailView.value === null ? 0 : familyModels(detailView.value, value).length,
  })),
)
/** Models whose protocol we do not speak: listed, never selectable. */
const unsupportedModels = computed(() =>
  detailView.value === null
    ? []
    : detailView.value.provider.models.filter((model) => model.kind === null),
)
const needsBaseUrl = computed(
  () =>
    detailView.value !== null &&
    family.value !== null &&
    requiresBaseUrl(detailView.value, family.value),
)
const catalogBaseUrl = computed(() =>
  detailView.value !== null && family.value !== null
    ? familyBaseUrl(detailView.value, family.value)
    : null,
)
const baseUrlProblem = computed(() => {
  if (!needsBaseUrl.value) return null
  const typed = typedBaseUrl.value.trim()
  if (!typed) return null
  return validateProviderBaseUrl(typed)
})
const selectedCount = computed(() =>
  detailView.value !== null && family.value !== null
    ? selectedModelIds(detailView.value, family.value, selection.value).length
    : 0,
)
const hardBlocker = computed(() => {
  if (detailPhase.value !== 'ready' || detailView.value === null) return null
  return hardImportBlocker({
    detail: detailView.value,
    family: family.value,
    selection: selection.value,
    baseUrl: typedBaseUrl.value,
    existingNames: props.existingNames,
  })
})
/** The visible reason a disabled Import cannot be used (base-URL copy is inline). */
const hardBlockerHint = computed(() => {
  const reason = hardBlocker.value
  return reason === null || /base url/i.test(reason) ? null : reason
})
const importDisabled = computed(
  () => detailPhase.value !== 'ready' || hardBlocker.value !== null,
)

function errText(exc: unknown): string {
  return exc instanceof ApiError ? exc.message : exc instanceof Error ? exc.message : String(exc)
}

function setProviderSearch(el: unknown): void {
  providerSearch.value = (el as InputInst | null) ?? null
}

function setRowRef(el: unknown, id: string): void {
  if (el instanceof HTMLButtonElement) rowEls.set(id, el)
  else rowEls.delete(id)
}

function setDetailHeading(el: unknown): void {
  detailHeading.value = el instanceof HTMLElement ? el : null
}

async function loadSummary(): Promise<void> {
  phase.value = 'loading'
  phaseMessage.value = ''
  try {
    const body = await listModelsDevProviders()
    const view = normalizeCatalogProviders(body)
    providersView.value = view
    bannerNow.value = Date.now()
    const nextPhase = summaryPhase(view)
    if (nextPhase === 'empty') {
      phase.value = 'empty'
      phaseMessage.value = CATALOG_EMPTY_COPY
      return
    }
    phase.value = 'ready'
    activeProviderId.value = view.providers[0]?.id ?? null
  } catch (exc) {
    const status = exc instanceof ApiError ? exc.status : 0
    const nextPhase = summaryErrorPhase(status)
    phase.value = nextPhase
    phaseMessage.value =
      nextPhase === 'unsupported'
        ? CATALOG_UNSUPPORTED_COPY
        : `The models.dev catalog could not be loaded: ${errText(exc)}`
  }
}

async function openProvider(id: string): Promise<void> {
  const wanted = id.trim()
  if (!wanted) return
  activeProviderId.value = wanted
  selectedProviderId.value = wanted
  detailPhase.value = 'loading'
  detailView.value = null
  detailMessage.value = ''
  family.value = null
  selection.value = defaultSelection()
  modelQuery.value = ''
  typedBaseUrl.value = ''
  importNotice.value = ''
  void nextTick(() => detailHeading.value?.focus())
  try {
    const body = await getModelsDevProvider(wanted)
    if (selectedProviderId.value !== wanted) return
    const view = normalizeCatalogProviderDetail(body)
    if (view === null) {
      detailPhase.value = 'error'
      detailMessage.value = 'The catalog returned an unexpected provider response.'
      return
    }
    detailView.value = view
    family.value = primaryFamily(view)
    detailPhase.value = 'ready'
  } catch (exc) {
    if (selectedProviderId.value !== wanted) return
    const status = exc instanceof ApiError ? exc.status : 0
    detailPhase.value = status === 503 ? 'unavailable' : status === 404 ? 'notfound' : 'error'
    detailMessage.value = detailErrorCopy(status, errText(exc))
  }
}

function closeDetail(): void {
  selectedProviderId.value = null
  detailPhase.value = 'idle'
  detailView.value = null
  detailMessage.value = ''
  family.value = null
  selection.value = []
  modelQuery.value = ''
  typedBaseUrl.value = ''
  importNotice.value = ''
  void nextTick(() => providerSearch.value?.focus())
}

function onProviderKeydown(
  event: KeyboardEvent,
  provider: CatalogProviderView,
  index: number,
): void {
  const move = providerMoveForKey(event.key)
  if (move) {
    event.preventDefault()
    const nextIndex = nextProviderIndex(index, filteredProviders.value.length, move)
    const next = filteredProviders.value[nextIndex]
    if (!next) return
    activeProviderId.value = next.id
    void nextTick(() => rowEls.get(next.id)?.focus())
    return
  }
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    void openProvider(provider.id)
  }
}

function chooseFamily(value: CatalogFamily): void {
  if (family.value === value) return
  family.value = value
  selection.value = defaultSelection()
  modelQuery.value = ''
  typedBaseUrl.value = ''
  importNotice.value = ''
}

function toggleModel(modelId: string): void {
  selection.value = toggleModelSelection(selection.value, modelId)
  importNotice.value = ''
}

function selectAll(): void {
  if (detailView.value === null) return
  selection.value = selectAllFamily(detailView.value, family.value)
  importNotice.value = ''
}

function clearSelection(): void {
  selection.value = defaultSelection()
  importNotice.value = ''
}

function submitImport(): void {
  const result = buildCatalogImport({
    detail: detailView.value,
    family: family.value,
    selection: selection.value,
    baseUrl: typedBaseUrl.value,
    existingNames: props.existingNames,
  })
  if (!result.ok) {
    importNotice.value = result.reason
    return
  }
  importNotice.value = ''
  emit('import', result.value)
}

function requestClose(): void {
  emit('close')
}

function providerKindText(provider: CatalogProviderView): string {
  return provider.rejected ? 'Not importable' : familyLabel(provider.kind)
}

function chips(provider: CatalogProviderView): string[] {
  return catalogProviderChips(provider, props.existingNames)
}

function modelMeta(model: CatalogModelView): string {
  const context =
    model.contextWindow > 0
      ? `${model.contextWindow.toLocaleString('en-US')} tokens`
      : 'context unknown'
  return model.reasoning ? `${context} · reasoning` : context
}

onMounted(() => {
  void loadSummary()
})
</script>

<template>
  <AppDialog
    :show="show"
    size="lg"
    flush
    scroll-body
    height="min(640px, 100vh - 48px)"
    title="Browse models.dev"
    description="Prefill a provider from the public catalog. Nothing is saved until you add it."
    initial-focus=".catalog-provider-search input"
    @close="requestClose"
  >
    <div class="catalog">
      <!-- Provider list -------------------------------------------------------->
      <template v-if="selectedProviderId === null">
        <div class="catalog-toolbar">
          <n-input
            :ref="setProviderSearch"
            v-model:value="summaryQuery"
            class="catalog-provider-search"
            placeholder="Search providers"
            :input-props="{ 'aria-label': 'Search providers' }"
            clearable
          />
          <span class="catalog-count" role="status">{{ summaryCountText }}</span>
        </div>

        <p v-if="banner" class="catalog-banner" role="note">{{ banner }}</p>

        <p v-if="phase === 'loading'" class="catalog-state" role="status">
          {{ CATALOG_LOADING_COPY }}
        </p>
        <div
          v-else-if="phase === 'unsupported' || phase === 'error'"
          class="catalog-state is-error"
          role="alert"
        >
          <span>{{ phaseMessage }}</span>
          <n-button
            v-if="phase === 'error'"
            attr-type="button"
            size="tiny"
            @click="loadSummary"
          >
            Retry
          </n-button>
        </div>
        <div v-else-if="phase === 'empty'" class="catalog-state">
          <span>{{ phaseMessage }}</span>
          <n-button attr-type="button" size="tiny" @click="loadSummary">Retry</n-button>
        </div>
        <p v-else-if="filteredProviders.length === 0" class="catalog-state">
          No providers match this search.
        </p>
        <ul v-else class="catalog-provider-list" role="list" aria-label="models.dev providers">
          <li v-for="(provider, index) in filteredProviders" :key="provider.id">
            <button
              :ref="(el) => setRowRef(el, provider.id)"
              type="button"
              class="catalog-provider-row"
              :tabindex="(activeProviderId ?? filteredProviders[0]?.id) === provider.id ? 0 : -1"
              :aria-label="`${provider.name} (${provider.id}), ${providerKindText(provider)}, ${provider.modelCount} models`"
              @click="openProvider(provider.id)"
              @keydown="onProviderKeydown($event, provider, index)"
            >
              <span class="catalog-provider-name">{{ provider.name }}</span>
              <code class="catalog-provider-id">{{ provider.id }}</code>
              <span class="catalog-provider-kind">{{ providerKindText(provider) }}</span>
              <span class="catalog-provider-count">
                {{ provider.modelCount }} model{{ provider.modelCount === 1 ? '' : 's' }}
              </span>
              <span
                v-for="chip in chips(provider)"
                :key="chip"
                class="catalog-chip"
                :class="{ 'is-warn': chip === 'Not importable' }"
              >
                {{ chip }}
              </span>
            </button>
          </li>
        </ul>
      </template>

      <!-- Provider detail ------------------------------------------------------>
      <template v-else>
        <div class="catalog-detail-head">
          <n-button
            attr-type="button"
            size="tiny"
            quaternary
            class="catalog-back"
            @click="closeDetail"
          >
            ← Back
          </n-button>
          <h3 :ref="setDetailHeading" class="catalog-detail-title" tabindex="-1">
            {{ detailTitle }}
          </h3>
        </div>
        <p class="catalog-detail-meta">
          <code>{{ selectedProviderId }}</code>
          <span v-if="detailKindLabel"> · {{ detailKindLabel }}</span>
        </p>

        <p v-if="detailPhase === 'loading'" class="catalog-state" role="status">
          Loading the provider…
        </p>
        <p
          v-else-if="detailPhase !== 'ready'"
          class="catalog-state is-error"
          role="alert"
        >
          {{ detailMessage }}
        </p>
        <template v-else-if="detailView">
          <p
            v-if="detailView.provider.rejected"
            class="catalog-state is-error"
            role="alert"
          >
            Not importable: this provider speaks a
            {{ rejectReasonLabel(detailView.provider.rejectReason) }}, which Two Brothers does
            not implement.
          </p>
          <p v-if="detailView.provider.env.length" class="catalog-hint">
            Key variables (display only):
            <code
              v-for="name in detailView.provider.env"
              :key="name"
              class="catalog-env"
            >{{ name }}</code>
          </p>

          <div class="catalog-base">
            <label v-if="needsBaseUrl" class="catalog-field">
              <span class="catalog-field-label">Base URL</span>
              <n-input
                v-model:value="typedBaseUrl"
                :status="baseUrlProblem ? 'error' : undefined"
                placeholder="https://…"
              />
            </label>
            <span v-if="baseUrlProblem" class="catalog-error" role="alert">
              {{ baseUrlProblem }}
            </span>
            <span v-else-if="needsBaseUrl" class="catalog-hint">
              This provider has no usable base URL in the catalog; type one to import.
            </span>
            <p v-else class="catalog-hint">
              Base URL: <code>{{ catalogBaseUrl }}</code>
            </p>
          </div>

          <div class="catalog-families" role="group" aria-label="Wire family">
            <button
              v-for="option in familyOptions"
              :key="option.value"
              type="button"
              class="catalog-family"
              :class="{ 'is-active': family === option.value }"
              :aria-pressed="family === option.value"
              :disabled="option.count === 0"
              @click="chooseFamily(option.value)"
            >
              {{ option.label }}
              <span class="catalog-family-count">{{ option.count }}</span>
            </button>
          </div>

          <p v-if="unsupportedModels.length" class="catalog-hint">
            Not importable (no checkbox):
            <code
              v-for="model in unsupportedModels"
              :key="model.id"
              class="catalog-env"
            >{{ model.id }}</code>
          </p>

          <div class="catalog-models-head">
            <n-input
              v-model:value="modelQuery"
              class="catalog-model-search"
              placeholder="Search models"
              :input-props="{ 'aria-label': 'Search models' }"
              clearable
            />
            <n-button
              attr-type="button"
              size="tiny"
              :disabled="familyModelsList.length === 0"
              @click="selectAll"
            >
              Select all ({{ familyModelsList.length }})
            </n-button>
            <n-button
              attr-type="button"
              size="tiny"
              :disabled="selectedCount === 0"
              @click="clearSelection"
            >
              Clear
            </n-button>
            <span class="catalog-count" role="status">{{ selectedCount }} selected</span>
          </div>
          <p class="catalog-hint">Nothing is preselected — choose the models to import.</p>

          <ul
            v-if="filteredModels.length"
            class="catalog-model-list"
            role="list"
            aria-label="Models"
          >
            <li v-for="model in filteredModels" :key="model.id" class="catalog-model">
              <n-checkbox
                :checked="isModelSelected(selection, model.id)"
                @update:checked="toggleModel(model.id)"
              >
                <span class="catalog-model-id">{{ model.id }}</span>
                <span v-if="model.name !== model.id" class="catalog-model-name">
                  {{ model.name }}
                </span>
                <span class="catalog-model-meta">{{ modelMeta(model) }}</span>
              </n-checkbox>
              <span v-if="model.mixedFamily" class="catalog-chip">
                served by this provider's other wire family; import as a separate preset
              </span>
            </li>
          </ul>
          <p v-else class="catalog-state">No models match this search.</p>

          <p v-if="hardBlockerHint" class="catalog-hint">{{ hardBlockerHint }}</p>
          <p v-if="importNotice" class="catalog-error" role="alert">{{ importNotice }}</p>

          <div class="catalog-actions">
            <n-button attr-type="button" size="small" @click="closeDetail">Cancel</n-button>
            <n-button
              attr-type="button"
              size="small"
              type="primary"
              :disabled="importDisabled"
              @click="submitImport"
            >
              Import
            </n-button>
          </div>
        </template>
      </template>
    </div>
  </AppDialog>
</template>

<style scoped>
/* Scoped only; shared tokens, no global resets, no new naive-ui component. */
.catalog {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 14px;
  min-width: 0;
}

.catalog-toolbar,
.catalog-models-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.catalog-provider-search,
.catalog-model-search {
  flex: 1 1 12rem;
  min-width: 0;
}

.catalog-count {
  flex: none;
  font-size: 0.72rem;
  color: var(--text-secondary);
  white-space: nowrap;
}

.catalog-banner {
  margin: 0;
  padding: 7px 9px;
  font-size: 0.74rem;
  line-height: 1.45;
  color: var(--text-secondary);
  background: var(--surface-panel);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
}

.catalog-state {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: 0;
  padding: 12px 4px;
  font-size: 0.78rem;
  line-height: 1.45;
  color: var(--text-secondary);
}

.catalog-state.is-error {
  padding: 7px 9px;
  color: var(--danger);
  background: var(--danger-soft);
  border: 1px solid var(--danger);
  border-radius: var(--radius-sm);
}

.catalog-provider-list,
.catalog-model-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  overflow: hidden;
  background: var(--surface-canvas);
}

.catalog-provider-row {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px;
  width: 100%;
  min-width: 0;
  padding: 7px 9px;
  font: inherit;
  font-size: 0.82rem;
  color: var(--text-primary);
  text-align: left;
  cursor: pointer;
  background: transparent;
  border: none;
}

.catalog-provider-row:hover {
  background: var(--surface-hover);
}

.catalog-provider-row:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: -2px;
}

.catalog-provider-list li + li {
  border-top: 1px solid var(--border-subtle);
}

.catalog-provider-name {
  flex: 1 1 8rem;
  min-width: 0;
  font-weight: 600;
  overflow-wrap: anywhere;
}

.catalog-provider-id,
.catalog-env {
  padding: 0 5px;
  font-family: var(--font-mono);
  font-size: 0.68rem;
  color: var(--text-secondary);
  background: var(--surface-hover);
  border-radius: 4px;
}

.catalog-provider-kind,
.catalog-provider-count {
  flex: none;
  font-size: 0.7rem;
  color: var(--text-tertiary);
  white-space: nowrap;
}

.catalog-chip {
  flex: none;
  padding: 0 6px;
  font-size: 0.64rem;
  line-height: 1.55;
  color: var(--text-secondary);
  white-space: nowrap;
  background: var(--surface-hover);
  border-radius: 999px;
}

.catalog-chip.is-warn {
  color: var(--warning);
}

.catalog-detail-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.catalog-detail-title {
  margin: 0;
  overflow-wrap: anywhere;
  font-size: 1rem;
  font-weight: 650;
  color: var(--text-primary);
}

.catalog-detail-title:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
}

.catalog-detail-meta {
  margin: -4px 0 0;
  font-size: 0.74rem;
  color: var(--text-tertiary);
}

.catalog-detail-meta code {
  font-family: var(--font-mono);
  font-size: 0.7rem;
}

.catalog-hint {
  margin: 0;
  font-size: 0.72rem;
  line-height: 1.45;
  color: var(--text-tertiary);
  overflow-wrap: anywhere;
}

.catalog-hint code {
  font-family: var(--font-mono);
  font-size: 0.7rem;
}

.catalog-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.catalog-field-label {
  font-size: 0.72rem;
  font-weight: 600;
  color: var(--text-secondary);
}

.catalog-error {
  margin: 0;
  padding: 6px 9px;
  font-size: 0.74rem;
  line-height: 1.45;
  color: var(--danger);
  overflow-wrap: anywhere;
  background: var(--danger-soft);
  border: 1px solid var(--danger);
  border-radius: var(--radius-sm);
}

.catalog-families {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.catalog-family {
  display: inline-flex;
  align-items: baseline;
  gap: 5px;
  padding: 4px 9px;
  font: inherit;
  font-size: 0.74rem;
  color: var(--text-secondary);
  cursor: pointer;
  background: var(--surface-canvas);
  border: 1px solid var(--border-subtle);
  border-radius: 999px;
}

.catalog-family.is-active {
  color: var(--accent-text);
  background: var(--accent-soft);
  border-color: transparent;
}

.catalog-family:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.catalog-family:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
}

.catalog-family-count {
  font-size: 0.66rem;
  opacity: 0.8;
}

.catalog-model {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px;
  padding: 6px 9px;
}

.catalog-model-list li + li {
  border-top: 1px solid var(--border-subtle);
}

.catalog-model-id {
  font-family: var(--font-mono);
  font-size: 0.76rem;
  overflow-wrap: anywhere;
}

.catalog-model-name {
  margin-left: 6px;
  font-size: 0.72rem;
  color: var(--text-secondary);
}

.catalog-model-meta {
  margin-left: 6px;
  font-size: 0.68rem;
  color: var(--text-tertiary);
}

.catalog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding-top: 2px;
}
</style>
