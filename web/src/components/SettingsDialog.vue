<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue'
import type { ComponentPublicInstance } from 'vue'
import { NButton, NModal } from 'naive-ui'
import {
  ApiError,
  getSettings,
  listPlugins,
  listProviders,
  normalizePluginSelection,
  updateSettingsWithPlugins,
} from '../api'
import type { PluginLoadError, RoleSettingsPatch, SettingsPatch } from '../api'
import type { ProviderPreset, RoleSettingsView } from '../types'
import { clickInModalBody } from '../modal'
import { applyThemeAttribute, readThemeMode, resolveDark, saveThemeMode } from '../themeMode'
import type { ThemeMode } from '../themeMode'
import { applyDensityAttribute, readDensity, saveDensity } from '../density'
import type { Density } from '../density'
import ModelsRolesSection from './settings/ModelsRolesSection.vue'
import ProvidersSection from './settings/ProvidersSection.vue'
import PluginsSection from './settings/PluginsSection.vue'
import AppearanceSection from './settings/AppearanceSection.vue'
import AdvancedSection from './settings/AdvancedSection.vue'

/** Optional controlled theme mode and density. When supplied, the host owns
 *  live application and this panel only emits the change events. */
const props = defineProps<{ themeMode?: ThemeMode; density?: Density }>()

const emit = defineEmits<{
  close: []
  saved: []
  'theme-change': [ThemeMode]
  'density-change': [Density]
}>()

function onMaskClick(e: MouseEvent) {
  if (clickInModalBody(e)) return
  emit('close')
}

interface RoleForm {
  provider: string
  model: string
  base_url: string
  api_key: string
  providerRef: string
}

const loading = ref(true)
const settingsLoaded = ref(false)
const saving = ref(false)
const error = ref<string | null>(null)
const panelRef = ref<HTMLElement | null>(null)

const senior = reactive<RoleForm>({
  provider: '',
  model: '',
  base_url: '',
  api_key: '',
  providerRef: '',
})
const junior = reactive<RoleForm>({
  provider: '',
  model: '',
  base_url: '',
  api_key: '',
  providerRef: '',
})
const keySet = reactive({ senior: false, junior: false })

// Plugin selection (Stage 15): options come from GET /api/plugins, the
// active list rides the settings GET/PUT under `plugins`. Plugins are
// shared-by-default (owner decision 2026-11-03): one multi-select feeds
// both brothers; a legacy per-role response is merged fail-soft.
const pluginOptions = ref<{ label: string; value: string }[]>([])
const pluginErrors = ref<PluginLoadError[]>([])
const plugins = ref<string[]>([])

// Connection presets (Stage 17): the per-role "connection" select picks a
// provider preset (which supplies base URL + API key) or "Manual".
const providers = ref<ProviderPreset[]>([])
const providersError = ref<string | null>(null)
/** Providers load independently after the role settings; the section shows this. */
const providersLoading = ref(false)

const connectionOptions = computed(() => [
  { label: 'Manual', value: '' },
  ...providers.value.map((p) => ({ label: `${p.name} — ${p.base_url}`, value: p.name })),
])

// -- section navigation -------------------------------------------------------

type SectionId = 'models' | 'providers' | 'plugins' | 'appearance' | 'advanced'

const sections: {
  id: SectionId
  label: string
  description: string
}[] = [
  {
    id: 'models',
    label: 'Models & roles',
    description: 'Each brother keeps its own provider connection and model.',
  },
  {
    id: 'providers',
    label: 'Providers',
    description: 'Reusable connections that supply a base URL and API key.',
  },
  {
    id: 'plugins',
    label: 'Plugins',
    description: 'Tools both brothers can use; the enabled list is shared.',
  },
  {
    id: 'appearance',
    label: 'Appearance',
    description: 'Choose how the workspace looks on this device.',
  },
  {
    id: 'advanced',
    label: 'Advanced',
    description: 'Environment pins, stored settings, and test transports.',
  },
]

const activeId = ref<SectionId>('models')
const activeSection = computed(
  () => sections.find((section) => section.id === activeId.value) ?? sections[0]!,
)

const navRefs = ref<HTMLButtonElement[]>([])

function setNavRef(el: Element | ComponentPublicInstance | null, index: number) {
  if (el instanceof HTMLButtonElement) navRefs.value[index] = el
}

function onNavKeydown(event: KeyboardEvent, index: number) {
  const step =
    event.key === 'ArrowDown' || event.key === 'ArrowRight'
      ? 1
      : event.key === 'ArrowUp' || event.key === 'ArrowLeft'
        ? -1
        : 0
  if (!step && event.key !== 'Home' && event.key !== 'End') return
  event.preventDefault()
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? sections.length - 1
        : (index + step + sections.length) % sections.length
  activeId.value = sections[next]!.id
  void nextTick(() => navRefs.value[next]?.focus())
}

// -- theme -------------------------------------------------------------------

/** Mirror used only while no `themeMode` prop is bound (standalone mount). */
const fallbackTheme = ref<ThemeMode>(readThemeMode())
const activeTheme = computed(() => props.themeMode ?? fallbackTheme.value)

function onThemeChange(mode: ThemeMode) {
  if (props.themeMode === undefined) {
    // No host binding yet: persist through the existing theme API and apply
    // the token attribute so the choice survives. The shell must pass
    // `themeMode` and handle `theme-change` for naive-ui to follow live.
    saveThemeMode(mode)
    const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches
    applyThemeAttribute(mode, resolveDark(mode, systemDark))
    fallbackTheme.value = mode
  }
  emit('theme-change', mode)
}

// -- density -----------------------------------------------------------------

/** Mirror used only while no `density` prop is bound (standalone mount). */
const fallbackDensity = ref<Density>(readDensity())
const activeDensity = computed(() => props.density ?? fallbackDensity.value)

function onDensityChange(density: Density) {
  if (props.density === undefined) {
    // No host binding yet: persist and apply locally, like the theme fallback.
    saveDensity(density)
    applyDensityAttribute(density)
    fallbackDensity.value = density
  }
  emit('density-change', density)
}

// -- data --------------------------------------------------------------------

function errText(e: unknown): string {
  return e instanceof ApiError ? e.message : String(e)
}

function roleForm(role: 'senior' | 'junior'): RoleForm {
  return role === 'senior' ? senior : junior
}

function fill(role: 'senior' | 'junior', view: RoleSettingsView) {
  const form = roleForm(role)
  form.provider = view.provider ?? ''
  form.model = view.model ?? ''
  form.base_url = view.base_url ?? ''
  form.providerRef = view.provider_ref ?? ''
  keySet[role] = view.api_key_set
}

function updateSenior(patch: Partial<RoleForm>) {
  Object.assign(senior, patch)
}

function updateJunior(patch: Partial<RoleForm>) {
  Object.assign(junior, patch)
}

async function refreshProviders() {
  providers.value = await listProviders()
}

function onProvidersUpdated(next: ProviderPreset[]) {
  providers.value = next
  providersError.value = null
}

function onProviderDeleted(name: string) {
  // the backend clears a deleted preset's role refs; re-sync the form so a
  // stranded select value doesn't fail the next save with a 400
  for (const role of ['senior', 'junior'] as const) {
    if (roleForm(role).providerRef === name) roleForm(role).providerRef = ''
  }
}

watch(loading, async (isLoading) => {
  if (isLoading || !settingsLoaded.value) return
  await nextTick()
  // `autofocus` only applies at parse time; this form mounts after the data
  // load completes, so focus the first field (Senior connection) programmatically
  panelRef.value?.querySelector<HTMLElement>('.role-card input')?.focus()
})

onMounted(async () => {
  try {
    const [view, discovered] = await Promise.all([getSettings(), listPlugins()])
    fill('senior', view.senior)
    fill('junior', view.junior)
    plugins.value = normalizePluginSelection(view.plugins)
    pluginOptions.value = discovered.plugins.map((p) => ({
      label: p.description ? `${p.name} — ${p.description}` : p.name,
      value: p.name,
    }))
    pluginErrors.value = discovered.errors
    settingsLoaded.value = true
  } catch (e) {
    error.value = errText(e)
  } finally {
    loading.value = false
  }
  // presets load independently so a missing /api/providers still shows roles
  providersLoading.value = true
  try {
    await refreshProviders()
  } catch (e) {
    providersError.value = errText(e)
  } finally {
    providersLoading.value = false
  }
})

async function save() {
  if (loading.value || saving.value || !settingsLoaded.value) return
  saving.value = true
  error.value = null
  const patch: SettingsPatch = {}
  for (const role of ['senior', 'junior'] as const) {
    const form = roleForm(role)
    const entry: RoleSettingsPatch = {
      model: form.model.trim(),
      base_url: form.base_url.trim(),
      provider_ref: form.providerRef,
    }
    if (form.provider) entry.provider = form.provider
    // send the key only when the operator typed one; the response never
    // echoes key material, so the field is cleared from the form afterwards
    if (form.api_key) entry.api_key = form.api_key
    patch[role] = entry
  }
  try {
    // role settings and the shared plugin selection travel in one PUT
    const view = await updateSettingsWithPlugins({
      ...patch,
      plugins: plugins.value,
    })
    fill('senior', view.senior)
    fill('junior', view.junior)
    plugins.value = normalizePluginSelection(view.plugins)
    senior.api_key = ''
    junior.api_key = ''
    emit('saved')
    // reflects preset renames/deletes made while the dialog was open
    try {
      await refreshProviders()
    } catch (e) {
      providersError.value = errText(e)
    }
  } catch (e) {
    error.value = errText(e)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <n-modal :show="true" @mask-click="onMaskClick" @esc="emit('close')">
    <div
      ref="panelRef"
      class="settings-panel"
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-dialog-title"
    >
      <aside class="settings-rail">
        <div class="settings-brand">
          <span class="settings-eyebrow">Two Brothers</span>
          <h2 id="settings-dialog-title">Settings</h2>
        </div>
        <nav class="settings-nav" aria-label="Settings sections">
          <button
            v-for="(section, index) in sections"
            :key="section.id"
            :ref="(el) => setNavRef(el, index)"
            type="button"
            class="settings-nav-item"
            :class="{ active: activeId === section.id }"
            :aria-current="activeId === section.id ? 'page' : undefined"
            :tabindex="activeId === section.id ? 0 : -1"
            @click="activeId = section.id"
            @keydown="onNavKeydown($event, index)"
          >
            <svg
              v-if="section.id === 'models'"
              class="settings-nav-icon"
              viewBox="0 0 16 16"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linecap="round"
              aria-hidden="true"
              focusable="false"
            >
              <path d="M2 4.5h12M2 11.5h12" />
              <circle cx="5.5" cy="4.5" r="1.5" fill="currentColor" stroke="none" />
              <circle cx="10.5" cy="11.5" r="1.5" fill="currentColor" stroke="none" />
            </svg>
            <svg
              v-else-if="section.id === 'providers'"
              class="settings-nav-icon"
              viewBox="0 0 16 16"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              stroke-width="1.3"
              stroke-linecap="round"
              aria-hidden="true"
              focusable="false"
            >
              <rect x="2.5" y="2.5" width="11" height="4.4" rx="1.2" />
              <rect x="2.5" y="9.1" width="11" height="4.4" rx="1.2" />
              <path d="M4.9 4.7h.01M4.9 11.3h.01" />
            </svg>
            <svg
              v-else-if="section.id === 'plugins'"
              class="settings-nav-icon"
              viewBox="0 0 16 16"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              stroke-width="1.3"
              aria-hidden="true"
              focusable="false"
            >
              <rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" />
              <rect x="9" y="2.5" width="4.5" height="4.5" rx="1" />
              <rect x="2.5" y="9" width="4.5" height="4.5" rx="1" />
              <rect x="9" y="9" width="4.5" height="4.5" rx="1" />
            </svg>
            <svg
              v-else-if="section.id === 'appearance'"
              class="settings-nav-icon"
              viewBox="0 0 16 16"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              stroke-width="1.3"
              stroke-linecap="round"
              aria-hidden="true"
              focusable="false"
            >
              <circle cx="8" cy="8" r="3" />
              <path
                d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M12.6 3.4l-1.1 1.1M4.5 11.5l-1.1 1.1"
              />
            </svg>
            <svg
              v-else
              class="settings-nav-icon"
              viewBox="0 0 16 16"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
              focusable="false"
            >
              <path d="M5.5 4 2 8l3.5 4M10.5 4 14 8l-3.5 4" />
            </svg>
            <span class="settings-nav-label">{{ section.label }}</span>
          </button>
        </nav>
      </aside>

      <form id="settings-form" class="settings-main" @submit.prevent="save">
        <header class="settings-header">
          <div class="settings-heading">
            <h3>{{ activeSection.label }}</h3>
            <p>{{ activeSection.description }}</p>
          </div>
          <button
            type="button"
            class="settings-close"
            aria-label="Close settings"
            @click="emit('close')"
          >
            <svg
              viewBox="0 0 16 16"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              aria-hidden="true"
              focusable="false"
            >
              <path d="m4 4 8 8M12 4l-8 8" />
            </svg>
          </button>
        </header>

        <div class="settings-body" :aria-busy="loading">
          <div v-if="loading" class="settings-loading" role="status">
            <span class="settings-spinner" aria-hidden="true"></span>
            Loading settings…
          </div>
          <template v-else>
            <div
              v-show="activeId === 'models'"
              class="settings-pane"
              role="region"
              aria-label="Models & roles"
            >
              <ModelsRolesSection
                :senior="senior"
                :junior="junior"
                :key-set="keySet"
                :connection-options="connectionOptions"
                @update:senior="updateSenior"
                @update:junior="updateJunior"
              />
            </div>

            <div
              v-show="activeId === 'providers'"
              class="settings-pane"
              role="region"
              aria-label="Providers"
            >
              <ProvidersSection
                :providers="providers"
                :initial-error="providersError"
                :loading="providersLoading"
                :senior-provider-ref="senior.providerRef"
                :junior-provider-ref="junior.providerRef"
                @update:providers="onProvidersUpdated"
                @deleted="onProviderDeleted"
              />
            </div>

            <div
              v-show="activeId === 'plugins'"
              class="settings-pane"
              role="region"
              aria-label="Plugins"
            >
              <PluginsSection
                :plugins="plugins"
                :options="pluginOptions"
                :errors="pluginErrors"
                @update:plugins="plugins = $event"
              />
            </div>

            <div
              v-show="activeId === 'appearance'"
              class="settings-pane"
              role="region"
              aria-label="Appearance"
            >
              <AppearanceSection
                :mode="activeTheme"
                :density="activeDensity"
                @change="onThemeChange"
                @density-change="onDensityChange"
              />
            </div>

            <div
              v-show="activeId === 'advanced'"
              class="settings-pane"
              role="region"
              aria-label="Advanced"
            >
              <AdvancedSection />
            </div>
          </template>
        </div>

        <footer class="settings-footer">
          <p v-if="error" class="settings-footer-error" role="alert">{{ error }}</p>
          <p v-else class="settings-footer-hint">
            Role and plugin changes save together. Provider and theme changes apply immediately.
          </p>
          <div class="settings-footer-actions">
            <n-button attr-type="button" @click="emit('close')">Cancel</n-button>
            <n-button
              attr-type="submit"
              type="primary"
              :disabled="saving || loading || !settingsLoaded"
            >
              {{ saving ? 'Saving…' : 'Save' }}
            </n-button>
          </div>
        </footer>
      </form>
    </div>
  </n-modal>
</template>

<style scoped>
/* Shared 800x800 settings surface: a 188px section rail beside one scrolling
   section. The title header and Save/Cancel footer stay pinned while the
   section body scrolls; below 768px the panel fills the viewport and the rail
   turns into a horizontal strip. */
.settings-panel {
  display: flex;
  width: min(800px, calc(100vw - 32px));
  height: min(800px, calc(100dvh - 32px));
  max-width: calc(100vw - 32px);
  max-height: calc(100dvh - 32px);
  overflow: hidden;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  background: var(--surface-panel);
  box-shadow: var(--shadow-raised);
  color: var(--text-primary);
}

.settings-rail {
  flex: 0 0 188px;
  width: 188px;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--border-subtle);
  background: var(--surface-canvas);
}

.settings-brand {
  flex: none;
  padding: 22px 18px 10px;
}

.settings-eyebrow {
  display: block;
  font-size: 0.68rem;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-secondary);
}

.settings-brand h2 {
  margin: 3px 0 0;
  font-size: 1rem;
  font-weight: 600;
  line-height: 1.3;
}

.settings-nav {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 4px 12px 16px;
  overflow-y: auto;
}

.settings-nav-item {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  min-height: 38px;
  padding: 8px 10px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-primary);
  font: inherit;
  font-size: 0.85rem;
  line-height: 1.3;
  text-align: left;
  cursor: pointer;
}

.settings-nav-item:hover {
  background: var(--surface-hover);
}

.settings-nav-item.active {
  background: var(--surface-hover);
  box-shadow: inset 3px 0 0 var(--accent);
  font-weight: 600;
}

.settings-nav-icon {
  flex: none;
  opacity: 0.75;
}

.settings-nav-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.settings-main {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.settings-header {
  flex: none;
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 20px 18px 14px 24px;
  border-bottom: 1px solid var(--border-subtle);
  background: var(--surface-panel);
}

.settings-heading {
  flex: 1;
  min-width: 0;
}

.settings-heading h3 {
  margin: 0;
  font-size: 1rem;
  font-weight: 600;
  line-height: 1.35;
}

.settings-heading p {
  margin: 3px 0 0;
  font-size: 0.76rem;
  line-height: 1.4;
  color: var(--text-secondary);
}

.settings-close {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}

.settings-close:hover {
  background: var(--surface-hover);
  color: var(--text-primary);
}

.settings-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 18px 24px 26px;
}

.settings-pane {
  display: flex;
  flex-direction: column;
}

.settings-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  min-height: 12rem;
  font-size: 0.82rem;
  color: var(--text-secondary);
}

.settings-spinner {
  width: 14px;
  height: 14px;
  border: 2px solid var(--border-strong);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: settings-spin 0.8s linear infinite;
}

@keyframes settings-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .settings-spinner {
    animation: none;
  }
}

.settings-footer {
  flex: none;
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  padding: 11px 18px 12px 24px;
  border-top: 1px solid var(--border-subtle);
  background: var(--surface-panel);
}

.settings-footer-hint,
.settings-footer-error {
  flex: 1;
  min-width: 0;
  margin: 0;
  font-size: 0.74rem;
  line-height: 1.4;
}

.settings-footer-hint {
  color: var(--text-secondary);
}

.settings-footer-error {
  color: var(--danger);
  overflow-wrap: anywhere;
}

.settings-footer-actions {
  flex: none;
  display: flex;
  gap: 8px;
  margin-left: auto;
}

@media (max-width: 767px) {
  .settings-panel {
    flex-direction: column;
    width: 100vw;
    max-width: none;
    height: 100dvh;
    max-height: none;
    border: none;
    border-radius: 0;
  }

  .settings-rail {
    flex: none;
    width: 100%;
    border-right: none;
    border-bottom: 1px solid var(--border-subtle);
  }

  .settings-brand {
    padding: 12px 16px 6px;
  }

  .settings-eyebrow {
    display: none;
  }

  .settings-brand h2 {
    margin: 0;
    font-size: 0.95rem;
  }

  .settings-nav {
    flex: none;
    flex-direction: row;
    gap: 4px;
    padding: 0 12px 8px;
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: none;
  }

  .settings-nav::-webkit-scrollbar {
    display: none;
  }

  .settings-nav-item {
    flex: 1 0 auto;
    justify-content: center;
    min-width: 108px;
    min-height: 34px;
    padding: 6px 12px;
    box-shadow: none;
  }

  .settings-nav-item.active {
    box-shadow: inset 0 -2px 0 var(--accent);
  }

  .settings-nav-icon {
    display: none;
  }

  .settings-header {
    padding: 13px 16px 10px;
  }

  .settings-body {
    padding: 14px 16px 20px;
  }

  .settings-footer {
    padding: 10px 16px calc(10px + env(safe-area-inset-bottom));
  }
}
</style>