<script setup lang="ts">
import { ref, watch } from 'vue'
import { NButton, NInput, NPopconfirm } from 'naive-ui'
import { ApiError, createProvider, deleteProvider, listProviders, updateProvider } from '../../api'
import type { ProviderPreset } from '../../types'

const props = defineProps<{
  providers: ProviderPreset[]
  /** Load failure reported by the dialog before this section mounted. */
  initialError?: string | null
}>()

const emit = defineEmits<{
  'update:providers': [ProviderPreset[]]
  deleted: [name: string]
}>()

const error = ref<string | null>(props.initialError ?? null)
const editingProvider = ref<string | null>(null)
const editBaseUrl = ref('')
const editKey = ref('')
const busy = ref(false)

const newName = ref('')
const newBaseUrl = ref('')
const newKey = ref('')
const addBusy = ref(false)

watch(
  () => props.initialError,
  (value) => {
    if (value) error.value = value
  },
)

function errText(e: unknown): string {
  return e instanceof ApiError ? e.message : String(e)
}

async function refresh() {
  try {
    const next = await listProviders()
    error.value = null
    emit('update:providers', next)
  } catch (e) {
    error.value = errText(e)
  }
}

function startEdit(provider: ProviderPreset) {
  editingProvider.value = provider.name
  editBaseUrl.value = provider.base_url
  editKey.value = ''
}

function cancelEdit() {
  editingProvider.value = null
  editKey.value = ''
}

async function saveEdit(provider: ProviderPreset) {
  if (busy.value) return
  const base = editBaseUrl.value.trim()
  if (!base) {
    // an all-empty patch would be accepted by the backend as a no-op while
    // the operator believes a change applied — refuse it visibly
    error.value = 'base URL must not be empty'
    return
  }
  busy.value = true
  error.value = null
  try {
    const patch: { base_url?: string; api_key?: string } = { base_url: base }
    if (editKey.value) patch.api_key = editKey.value
    await updateProvider(provider.name, patch)
    editingProvider.value = null
    editKey.value = ''
    await refresh()
  } catch (e) {
    error.value = errText(e)
  } finally {
    busy.value = false
  }
}

async function addProvider() {
  if (addBusy.value) return
  addBusy.value = true
  error.value = null
  try {
    await createProvider({
      name: newName.value.trim(),
      base_url: newBaseUrl.value.trim(),
      ...(newKey.value ? { api_key: newKey.value } : {}),
    })
    newName.value = ''
    newBaseUrl.value = ''
    newKey.value = ''
    await refresh()
  } catch (e) {
    error.value = errText(e)
  } finally {
    addBusy.value = false
  }
}

async function removePreset(name: string) {
  if (busy.value) return
  busy.value = true
  error.value = null
  try {
    await deleteProvider(name)
    if (editingProvider.value === name) cancelEdit()
    // the backend clears a deleted preset's role refs; the dialog re-syncs its
    // role form so a stranded select value doesn't fail the next save with a 400
    emit('deleted', name)
    await refresh()
  } catch (e) {
    error.value = errText(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="providers-section">
    <p class="settings-lead">
      Presets supply the base URL and API key for roles that select them. Provider changes apply
      immediately; role and plugin changes still need Save.
    </p>

    <div v-if="error" class="settings-error" role="alert">
      <span>{{ error }}</span>
      <button type="button" class="settings-link" @click="refresh">Retry</button>
    </div>

    <ul v-if="providers.length" class="provider-list" role="list">
      <li v-for="provider in providers" :key="provider.name" class="provider-row">
        <div v-if="editingProvider === provider.name" class="provider-edit">
          <label class="provider-field">
            <span>Base URL</span>
            <n-input v-model:value="editBaseUrl" placeholder="http://127.0.0.1:1234/v1" />
          </label>
          <label class="provider-field">
            <span>API key</span>
            <n-input
              v-model:value="editKey"
              type="password"
              show-password-on="click"
              autocomplete="off"
              :placeholder="provider.api_key_set ? 'set — type a new value to replace' : 'not set'"
            />
          </label>
          <div class="provider-row-actions">
            <n-button attr-type="button" size="small" :disabled="busy" @click="cancelEdit">
              Cancel
            </n-button>
            <n-button
              attr-type="button"
              size="small"
              type="primary"
              :disabled="busy"
              @click="saveEdit(provider)"
            >
              Save
            </n-button>
          </div>
        </div>

        <template v-else>
          <div class="provider-main">
            <div class="provider-title">
              <span class="provider-row-name">{{ provider.name }}</span>
              <span v-if="provider.api_key_set" class="provider-chip">key set</span>
              <span v-if="provider.models.length" class="provider-chip">
                {{ provider.models.length }} model{{ provider.models.length === 1 ? '' : 's' }}
              </span>
            </div>
            <span class="provider-row-url">{{ provider.base_url }}</span>
          </div>
          <div class="provider-row-actions">
            <n-button attr-type="button" size="small" :disabled="busy" @click="startEdit(provider)">
              Edit
            </n-button>
            <n-popconfirm @positive-click="removePreset(provider.name)">
              <template #trigger>
                <n-button attr-type="button" size="small" :disabled="busy">Delete</n-button>
              </template>
              Delete provider {{ provider.name }}?
            </n-popconfirm>
          </div>
        </template>
      </li>
    </ul>

    <p v-else-if="!error" class="settings-empty">
      No provider presets yet. Add one below, or keep both roles on Manual URLs.
    </p>

    <div class="provider-add">
      <h3>Add provider</h3>
      <label class="provider-field">
        <span>Name</span>
        <n-input v-model:value="newName" placeholder="e.g. lm-studio" />
      </label>
      <label class="provider-field">
        <span>Base URL</span>
        <n-input v-model:value="newBaseUrl" placeholder="http://127.0.0.1:1234/v1" />
      </label>
      <label class="provider-field">
        <span>API key <span class="provider-optional">(optional)</span></span>
        <n-input
          v-model:value="newKey"
          type="password"
          show-password-on="click"
          autocomplete="off"
          placeholder="stored encrypted, never shown again"
        />
      </label>
      <n-button
        attr-type="button"
        type="primary"
        :disabled="addBusy || !newName.trim() || !newBaseUrl.trim()"
        @click="addProvider"
      >
        {{ addBusy ? 'Adding…' : 'Add provider' }}
      </n-button>
    </div>
  </div>
</template>

<style scoped>
.providers-section {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.settings-lead {
  margin: 0;
  font-size: 0.8rem;
  line-height: 1.5;
  color: var(--text-secondary);
}

.settings-error {
  display: flex;
  align-items: center;
  gap: 10px;
  border: 1px solid var(--danger);
  border-radius: var(--radius-sm);
  background: var(--danger-soft);
  color: var(--danger);
  padding: 7px 10px;
  font-size: 0.78rem;
}

.settings-error > span {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}

.settings-link {
  flex: none;
  border: none;
  background: none;
  color: inherit;
  font: inherit;
  font-weight: 600;
  text-decoration: underline;
  cursor: pointer;
  padding: 0;
}

.settings-empty {
  margin: 0;
  padding: 16px;
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius-md);
  font-size: 0.8rem;
  text-align: center;
  color: var(--text-secondary);
}

.provider-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.provider-row {
  display: flex;
  align-items: center;
  gap: 10px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  padding: 10px 12px;
}

.provider-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.provider-title {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}

.provider-row-name {
  font-size: 0.85rem;
  font-weight: 600;
}

.provider-row-url {
  font-size: 0.76rem;
  color: var(--text-secondary);
  overflow-wrap: anywhere;
}

.provider-chip {
  border: 1px solid var(--border-subtle);
  border-radius: 999px;
  padding: 0 7px;
  font-size: 0.68rem;
  line-height: 1.45;
  color: var(--text-secondary);
  background: var(--surface-canvas);
}

.provider-row-actions {
  flex: none;
  display: flex;
  gap: 6px;
}

.provider-edit {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.provider-edit .provider-row-actions {
  justify-content: flex-end;
}

.provider-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  font-size: 0.72rem;
  color: var(--text-secondary);
}

.provider-optional {
  font-weight: 400;
  opacity: 0.8;
}

.provider-add {
  display: flex;
  flex-direction: column;
  gap: 10px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  padding: 12px 14px;
  background: var(--surface-canvas);
}

.provider-add h3 {
  margin: 0 0 2px;
  font-size: 0.82rem;
  font-weight: 600;
}

.provider-add > .n-button {
  align-self: flex-start;
}
</style>