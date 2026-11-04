<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue'
import { NButton, NForm, NFormItem, NInput, NModal, NPopconfirm, NSelect } from 'naive-ui'
import {
  ApiError,
  createProvider,
  deleteProvider,
  getSettings,
  listPlugins,
  listProviders,
  normalizePluginSelection,
  updateProvider,
  updateSettingsWithPlugins,
} from '../api'
import type { PluginLoadError, RoleSettingsPatch, SettingsPatch } from '../api'
import type { ProviderPreset, RoleSettingsView } from '../types'
import { clickInModalBody } from '../modal'

const emit = defineEmits<{ close: []; saved: [] }>()

function onMaskClick(e: MouseEvent) {
  if (clickInModalBody(e)) return
  emit('close')
}

const loading = ref(true)
const saving = ref(false)
const error = ref<string | null>(null)

watch(loading, async (isLoading) => {
  if (isLoading) return
  await nextTick()
  // `autofocus` only applies at parse time; this form mounts after the data
  // load completes, so focus the first field (Senior model) programmatically
  document.querySelector<HTMLElement>('.role-fieldset input')?.focus()
})

// Connection presets (Stage 17): the per-role "connection" select picks a
// provider preset (which supplies base URL + API key) or "Manual".
const connectionOptions = computed(() => [
  { label: 'Manual', value: '' },
  ...providers.value.map((p) => ({ label: `${p.name} — ${p.base_url}`, value: p.name })),
])

interface RoleForm {
  provider: string
  model: string
  base_url: string
  api_key: string
  providerRef: string
}

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

// Provider presets: CRUD fires on its own buttons (not deferred to Save).
const providers = ref<ProviderPreset[]>([])
const providersError = ref<string | null>(null)
const editingProvider = ref<string | null>(null)
const editBaseUrl = ref('')
const editKey = ref('')
const editBusy = ref(false)
const newName = ref('')
const newBaseUrl = ref('')
const newKey = ref('')
const addBusy = ref(false)

function errText(e: unknown): string {
  return e instanceof ApiError ? e.message : String(e)
}

function roleForm(role: 'senior' | 'junior'): RoleForm {
  return role === 'senior' ? senior : junior
}

function fill(role: 'senior' | 'junior', view: RoleSettingsView) {
  const f = roleForm(role)
  f.provider = view.provider ?? ''
  f.model = view.model ?? ''
  f.base_url = view.base_url ?? ''
  f.providerRef = view.provider_ref ?? ''
  keySet[role] = view.api_key_set
}

async function refreshProviders() {
  providers.value = await listProviders()
}

function startEdit(p: ProviderPreset) {
  editingProvider.value = p.name
  editBaseUrl.value = p.base_url
  editKey.value = ''
}

async function saveEdit(p: ProviderPreset) {
  if (editBusy.value) return
  const base = editBaseUrl.value.trim()
  if (!base) {
    // an all-empty patch would be accepted by the backend as a no-op while
    // the operator believes a change applied — refuse it visibly
    providersError.value = 'base URL must not be empty'
    return
  }
  editBusy.value = true
  providersError.value = null
  try {
    const patch: { base_url?: string; api_key?: string } = { base_url: base }
    if (editKey.value) patch.api_key = editKey.value
    await updateProvider(p.name, patch)
    editingProvider.value = null
    await refreshProviders()
  } catch (e) {
    providersError.value = errText(e)
  } finally {
    editBusy.value = false
  }
}

async function addProvider() {
  if (addBusy.value) return
  addBusy.value = true
  providersError.value = null
  try {
    await createProvider({
      name: newName.value.trim(),
      base_url: newBaseUrl.value.trim(),
      ...(newKey.value ? { api_key: newKey.value } : {}),
    })
    newName.value = ''
    newBaseUrl.value = ''
    newKey.value = ''
    await refreshProviders()
  } catch (e) {
    providersError.value = errText(e)
  } finally {
    addBusy.value = false
  }
}

async function removePreset(name: string) {
  providersError.value = null
  try {
    await deleteProvider(name)
    if (editingProvider.value === name) editingProvider.value = null
    // the backend clears a deleted preset's role refs; re-sync the form so a
    // stranded select value doesn't fail the next save with a 400
    for (const role of ['senior', 'junior'] as const) {
      if (roleForm(role).providerRef === name) roleForm(role).providerRef = ''
    }
    await refreshProviders()
  } catch (e) {
    providersError.value = errText(e)
  }
}

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
  } catch (e) {
    error.value = errText(e)
  } finally {
    loading.value = false
  }
  // presets load independently so a missing /api/providers still shows roles
  try {
    await refreshProviders()
  } catch (e) {
    providersError.value = errText(e)
  }
})

async function save() {
  saving.value = true
  error.value = null
  const patch: SettingsPatch = {}
  for (const role of ['senior', 'junior'] as const) {
    const f = roleForm(role)
    const entry: RoleSettingsPatch = {
      model: f.model.trim(),
      base_url: f.base_url.trim(),
      provider_ref: f.providerRef,
    }
    if (f.provider) entry.provider = f.provider
    // send the key only when the operator typed one; the response never
    // echoes key material, so the field is cleared from the form afterwards
    if (f.api_key) entry.api_key = f.api_key
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
    <div class="modal" role="dialog" aria-modal="true" aria-label="Model settings">
      <h2>Model settings</h2>
      <p v-if="loading" class="empty-hint">Loading…</p>
      <template v-else>
        <n-form
          id="settings-form"
          class="modal-body"
          label-placement="top"
          :show-require-mark="false"
          @submit.prevent="save"
        >
          <fieldset v-for="role in ['senior', 'junior'] as const" :key="role" class="role-fieldset">
            <legend>{{ role === 'senior' ? 'Senior' : 'Junior' }}</legend>
            <n-form-item label="connection">
              <n-select
                v-model:value="roleForm(role).providerRef"
                :options="connectionOptions"
                :consistent-menu-width="false"
              />
            </n-form-item>
            <n-form-item label="model">
              <n-input
                v-model:value="roleForm(role).model"
                placeholder="e.g. spark-x2.6-4b@q4_k_m"
              />
            </n-form-item>
            <n-form-item label="base URL">
              <n-input
                v-model:value="roleForm(role).base_url"
                placeholder="http://127.0.0.1:1234/v1"
                :disabled="!!roleForm(role).providerRef"
              />
              <template #feedback>
                <span v-if="roleForm(role).providerRef">
                  Supplied by the selected provider preset.
                </span>
              </template>
            </n-form-item>
            <n-form-item label="API key">
              <n-input
                v-model:value="roleForm(role).api_key"
                type="password"
                show-password-on="click"
                autocomplete="off"
                :placeholder="keySet[role] ? 'set — type a new value to replace' : 'not set'"
                :disabled="!!roleForm(role).providerRef"
              />
              <template #feedback>
                <span v-if="keySet[role] && !roleForm(role).providerRef">
                  A key is stored on the backend; it is never sent back to this app.
                </span>
              </template>
            </n-form-item>
          </fieldset>
          <fieldset class="role-fieldset plugins-fieldset">
            <legend>Plugins</legend>
            <p class="field-hint">
              Enabled plugins are available to both Senior and Junior.
            </p>
            <n-form-item label="plugins">
              <n-select
                v-model:value="plugins"
                multiple
                filterable
                :options="pluginOptions"
                :consistent-menu-width="false"
                placeholder="no plugins active"
              />
              <template #feedback>
                <span v-if="pluginErrors.length">
                  {{ pluginErrors.length }} plugin(s) failed to load:
                  {{ pluginErrors.map((e) => e.plugin).join(', ') }}
                </span>
              </template>
            </n-form-item>
          </fieldset>
          <fieldset class="role-fieldset providers-fieldset">
            <legend>Providers</legend>
            <p class="field-hint">
              Presets supply the base URL and API key for roles that select them; changes apply
              immediately.
            </p>
            <div class="provider-list">
              <div v-for="p in providers" :key="p.name" class="provider-row">
                <template v-if="editingProvider === p.name">
                  <n-input v-model:value="editBaseUrl" placeholder="http://127.0.0.1:1234/v1" />
                  <n-input
                    v-model:value="editKey"
                    type="password"
                    show-password-on="click"
                    autocomplete="off"
                    :placeholder="p.api_key_set ? 'set — type a new value to replace' : 'not set'"
                  />
                  <div class="provider-row-actions">
                    <n-button attr-type="button" size="small" @click="editingProvider = null">
                      Cancel
                    </n-button>
                    <n-button
                      attr-type="button"
                      size="small"
                      type="primary"
                      :disabled="editBusy"
                      @click="saveEdit(p)"
                    >
                      Save
                    </n-button>
                  </div>
                </template>
                <template v-else>
                  <span class="provider-row-name">{{ p.name }}</span>
                  <span class="provider-row-url">{{ p.base_url }}</span>
                  <span v-if="p.api_key_set" class="provider-chip">key set</span>
                  <div class="provider-row-actions">
                    <n-button attr-type="button" size="small" @click="startEdit(p)">Edit</n-button>
                    <n-popconfirm @positive-click="removePreset(p.name)">
                      <template #trigger>
                        <n-button attr-type="button" size="small">Delete</n-button>
                      </template>
                      Delete provider {{ p.name }}?
                    </n-popconfirm>
                  </div>
                </template>
              </div>
              <p v-if="providers.length === 0" class="empty-hint">No provider presets yet</p>
            </div>
            <div class="provider-add">
              <n-input v-model:value="newName" placeholder="Preset name" />
              <n-input v-model:value="newBaseUrl" placeholder="http://127.0.0.1:1234/v1" />
              <n-input
                v-model:value="newKey"
                type="password"
                show-password-on="click"
                autocomplete="off"
                placeholder="API key (optional)"
              />
              <n-button
                attr-type="button"
                type="primary"
                :disabled="addBusy || !newName.trim() || !newBaseUrl.trim()"
                @click="addProvider"
              >
                Add provider
              </n-button>
            </div>
            <p v-if="providersError" class="modal-error" role="alert">{{ providersError }}</p>
          </fieldset>
        </n-form>
        <p v-if="error" class="modal-error" role="alert">{{ error }}</p>
        <div class="modal-actions">
          <n-button attr-type="button" @click="emit('close')">Cancel</n-button>
          <n-button form="settings-form" attr-type="submit" type="primary" :disabled="saving || loading">
            {{ saving ? 'Saving…' : 'Save' }}
          </n-button>
        </div>
      </template>
    </div>
  </n-modal>
</template>
