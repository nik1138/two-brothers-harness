<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NButton, NPopover } from 'naive-ui'
import { getSettings } from '../api'
import type { RunMode, RunProvider, SettingsView } from '../types'

const props = defineProps<{
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

function submit() {
  const text = task.value.trim()
  // `waiting` keeps the textarea usable for drafting, but a new run cannot
  // start while this session's run is still alive.
  if (!text || props.busy || props.waiting) return
  emit('submit', { task: text, mode: mode.value, provider: providerForRun.value })
  task.value = ''
}

function onKeydown(e: KeyboardEvent) {
  // while waiting Enter must stay a newline — the text is a draft, not a task
  if (props.busy || props.waiting) return
  if (e.key !== 'Enter' || e.shiftKey) return
  // let an IME finish its composition instead of submitting a partial word
  if (e.isComposing || e.keyCode === 229) return
  e.preventDefault()
  submit()
}

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
watch(
  () => props.busy,
  (busy) => {
    if (!busy) return
    modeOpen.value = false
    modelOpen.value = false
  },
)
watch(() => props.settingsVersion, checkSettings)

onMounted(() => {
  resizeInput()
  window.addEventListener('resize', resizeInput)
  void checkSettings()
})

onBeforeUnmount(() => {
  settingsRequest++
  window.removeEventListener('resize', resizeInput)
})
</script>

<template>
  <form class="composer" aria-label="New task" @submit.prevent="submit">
    <div
      class="composer-surface"
      :class="{ 'is-busy': busy, 'is-waiting': waiting }"
    >
      <textarea
        ref="inputEl"
        v-model="task"
        class="composer-input"
        rows="1"
        aria-label="Task for the two brothers"
        :placeholder="placeholder"
        :disabled="busy"
        @keydown="onKeydown"
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
        <span v-if="settingsMissing" class="composer-hint is-warn">{{ settingsHint }}</span>
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

@media (max-width: 620px) {
  .composer {
    padding: 0 0.75rem 0.75rem;
  }

  .chip-caption {
    display: none;
  }
}
</style>