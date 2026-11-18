<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { NForm, NFormItem, NSelect } from 'naive-ui'
import { ApiError } from '../../api'
import type { PluginDescriptor, PluginLoadError } from '../../api'
import { updatePluginOptions } from '../../api'
import type { PluginOptionField } from '../../pluginOptions'
import { buildOptions, fieldsFromSchema, initialDraft } from '../../pluginOptions'

const props = defineProps<{
  plugins: string[]
  options: { label: string; value: string }[]
  errors: PluginLoadError[]
  /** Full `GET /api/plugins` descriptors (additive fields tolerated as absent). */
  descriptors: PluginDescriptor[]
}>()

const emit = defineEmits<{
  'update:plugins': [string[]]
  /** Fired after a successful options apply, with the effective values. */
  'options-updated': [name: string, options: Record<string, unknown>]
}>()

const activeCount = computed(() => props.plugins.length)

function onSelection(value: unknown) {
  emit('update:plugins', Array.isArray(value) ? value.map(String) : [])
}

// -- per-plugin options editors ------------------------------------------------

interface EditorState {
  saving: boolean
  /** Bounded inline error (400 schema rejection / local validation). */
  error: string | null
}

const drafts = reactive<Record<string, Record<string, string | boolean>>>({})
const editorState = reactive<Record<string, EditorState>>({})
/** 404/409 style failures: shown in the error-list area, like load errors. */
const applyErrors = ref<PluginLoadError[]>([])

const enabledDescriptors = computed(() => {
  const out: PluginDescriptor[] = []
  for (const name of props.plugins) {
    const found = props.descriptors.find((d) => d.name === name)
    if (found) out.push(found)
  }
  return out
})

function fieldsFor(descriptor: PluginDescriptor): PluginOptionField[] {
  return fieldsFromSchema(descriptor.configSchema ?? null)
}

function stateFor(name: string): EditorState {
  if (!editorState[name]) editorState[name] = { saving: false, error: null }
  return editorState[name]
}

function isBundle(descriptor: PluginDescriptor): boolean {
  return descriptor.kind === 'bundle'
}

// Pre-populate drafts whenever the enabled set or reported options change.
watch(
  enabledDescriptors,
  (list) => {
    for (const descriptor of list) {
      const fields = fieldsFor(descriptor)
      if (fields.length === 0) continue
      const existing = drafts[descriptor.name]
      const fresh = initialDraft(fields, descriptor.options ?? {})
      if (!existing) {
        drafts[descriptor.name] = fresh
        continue
      }
      // Keep keystrokes; adopt newly reported values for untouched fields.
      for (const field of fields) {
        if (existing[field.key] === undefined || existing[field.key] === '') {
          existing[field.key] = fresh[field.key]
        }
      }
    }
  },
  { immediate: true, deep: true },
)

function describeTools(descriptor: PluginDescriptor): { line: string; tooltip: string } | null {
  const scopes = descriptor.toolsByScope
  if (!scopes) return null
  const parts: string[] = []
  const names: string[] = []
  for (const scope of ['shared', 'senior', 'junior'] as const) {
    const tools = scopes[scope]
    if (tools.length > 0) {
      parts.push(`${scope} (${tools.length})`)
      names.push(`${scope}: ${tools.join(', ')}`)
    }
  }
  if (parts.length === 0) return null
  return { line: `tools: ${parts.join(' · ')}`, tooltip: names.join('\n') }
}

async function applyOptions(descriptor: PluginDescriptor) {
  const name = descriptor.name
  const fields = fieldsFor(descriptor)
  const state = stateFor(name)
  const built = buildOptions(fields, drafts[name] ?? {})
  if (!built.ok) {
    state.error = built.error
    return
  }
  state.error = null
  state.saving = true
  try {
    const result = await updatePluginOptions(name, built.options)
    // Adopt the post-reload effective values back into the editor.
    drafts[name] = initialDraft(fields, result.options)
    applyErrors.value = applyErrors.value.filter((e) => e.plugin !== name)
    emit('options-updated', name, result.options)
  } catch (e) {
    if (e instanceof ApiError && e.status === 400) {
      state.error = e.message
    } else if (e instanceof ApiError) {
      // 404 (unknown plugin) / 409 (plugin unavailable): error-list area.
      applyErrors.value = [
        ...applyErrors.value.filter((entry) => entry.plugin !== name),
        { plugin: name, error: e.message },
      ]
    } else {
      state.error = e instanceof Error ? e.message : String(e)
    }
  } finally {
    state.saving = false
  }
}
</script>

<template>
  <div class="plugins-section">
    <p class="settings-lead">
      Enabled plugins are available to both Senior and Junior. The selection is shared; there is no
      per-role plugin list.
    </p>

    <n-form label-placement="top" :show-require-mark="false">
      <n-form-item label="Enabled plugins">
        <n-select
          :value="plugins"
          multiple
          filterable
          max-tag-count="responsive"
          :options="options"
          :consistent-menu-width="false"
          placeholder="no plugins active"
          @update:value="onSelection"
        />
        <template #feedback>
          <span v-if="options.length">
            {{ activeCount }} of {{ options.length }} discovered plugin{{
              options.length === 1 ? '' : 's'
            }}
            active.
          </span>
          <span v-else>No plugins were discovered by the backend.</span>
        </template>
      </n-form-item>
    </n-form>

    <div v-if="enabledDescriptors.length" class="plugin-editor-list">
      <section v-for="descriptor in enabledDescriptors" :key="descriptor.name" class="plugin-card">
        <header class="plugin-card-head">
          <h3 class="plugin-card-title">{{ descriptor.name }}</h3>
          <span v-if="descriptor.version" class="plugin-card-version">{{ descriptor.version }}</span>
        </header>
        <p v-if="descriptor.description" class="plugin-card-desc">{{ descriptor.description }}</p>
        <p
          v-if="describeTools(descriptor)"
          class="plugin-tools"
          :title="describeTools(descriptor)!.tooltip"
        >
          {{ describeTools(descriptor)!.line }}
        </p>

        <p v-if="isBundle(descriptor)" class="plugin-no-options">
          Bundles take no configurable options.
        </p>
        <p v-else-if="fieldsFor(descriptor).length === 0" class="plugin-no-options">
          This plugin declares no configurable options.
        </p>

        <form v-else class="plugin-options-form" @submit.prevent="applyOptions(descriptor)">
          <div v-for="field in fieldsFor(descriptor)" :key="field.key" class="plugin-field">
            <label class="plugin-field-label" :for="`plugin-opt-${descriptor.name}-${field.key}`">
              {{ field.label }}
              <span v-if="field.required" class="plugin-field-required">required</span>
            </label>
            <select
              v-if="field.kind === 'select'"
              :id="`plugin-opt-${descriptor.name}-${field.key}`"
              v-model="(drafts[descriptor.name][field.key] as string)"
              class="plugin-field-input"
            >
              <option value="">(not set)</option>
              <option v-for="choice in field.choices" :key="choice.key" :value="choice.key">
                {{ choice.label }}
              </option>
            </select>
            <input
              v-else-if="field.kind === 'boolean'"
              :id="`plugin-opt-${descriptor.name}-${field.key}`"
              v-model="drafts[descriptor.name][field.key]"
              type="checkbox"
              class="plugin-field-check"
            />
            <textarea
              v-else-if="field.kind === 'json'"
              :id="`plugin-opt-${descriptor.name}-${field.key}`"
              v-model="(drafts[descriptor.name][field.key] as string)"
              class="plugin-field-input plugin-field-json"
              rows="3"
              spellcheck="false"
            ></textarea>
            <input
              v-else
              :id="`plugin-opt-${descriptor.name}-${field.key}`"
              v-model="(drafts[descriptor.name][field.key] as string)"
              class="plugin-field-input"
              :type="field.kind === 'string' ? 'text' : 'number'"
            />
            <p v-if="field.description" class="plugin-field-help">{{ field.description }}</p>
          </div>
          <p v-if="stateFor(descriptor.name).error" class="plugin-apply-error" role="alert">
            {{ stateFor(descriptor.name).error }}
          </p>
          <button
            type="submit"
            class="plugin-apply-button"
            :disabled="stateFor(descriptor.name).saving"
          >
            {{ stateFor(descriptor.name).saving ? 'Applying…' : 'Apply options' }}
          </button>
        </form>
      </section>
    </div>

    <div v-if="applyErrors.length" class="plugin-errors" role="status">
      <p class="plugin-errors-title">
        {{ applyErrors.length }} plugin option{{ applyErrors.length === 1 ? '' : 's' }} could not be
        saved.
      </p>
      <details v-for="entry in applyErrors" :key="entry.plugin" class="plugin-error">
        <summary>{{ entry.plugin }}</summary>
        <p>{{ entry.error }}</p>
      </details>
    </div>

    <div v-if="errors.length" class="plugin-errors" role="status">
      <p class="plugin-errors-title">
        {{ errors.length }} plugin{{ errors.length === 1 ? '' : 's' }} failed to load. The rest keep
        working.
      </p>
      <details v-for="entry in errors" :key="entry.plugin" class="plugin-error">
        <summary>{{ entry.plugin }}</summary>
        <p>{{ entry.error }}</p>
      </details>
    </div>

    <p class="settings-note">
      A plugin fixed outside this panel is picked up the next time settings are saved. Option
      changes apply immediately and are validated by the plugin's own schema.
    </p>
  </div>
</template>

<style scoped>
.plugins-section {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.settings-lead,
.settings-note {
  margin: 0;
  font-size: 0.8rem;
  line-height: 1.5;
  color: var(--text-secondary);
}

.settings-note {
  font-size: 0.75rem;
}

.plugin-editor-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.plugin-card {
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.plugin-card-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.plugin-card-title {
  margin: 0;
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--text-primary);
}

.plugin-card-version {
  font-size: 0.72rem;
  color: var(--text-secondary);
}

.plugin-card-desc,
.plugin-tools,
.plugin-no-options {
  margin: 0;
  font-size: 0.76rem;
  line-height: 1.5;
  color: var(--text-secondary);
}

.plugin-tools {
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 0.72rem;
}

.plugin-no-options {
  font-style: italic;
}

.plugin-options-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 2px;
}

.plugin-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.plugin-field-label {
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--text-primary);
}

.plugin-field-required {
  font-weight: 400;
  font-size: 0.7rem;
  color: var(--text-secondary);
  margin-left: 6px;
}

.plugin-field-input {
  font: inherit;
  font-size: 0.8rem;
  padding: 6px 8px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--surface-raised);
  color: var(--text-primary);
}

.plugin-field-json {
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 0.75rem;
  resize: vertical;
}

.plugin-field-check {
  width: 14px;
  height: 14px;
  align-self: flex-start;
}

.plugin-field-help {
  margin: 0;
  font-size: 0.72rem;
  line-height: 1.5;
  color: var(--text-secondary);
}

.plugin-apply-error {
  margin: 0;
  font-size: 0.75rem;
  color: var(--danger, var(--warning));
}

.plugin-apply-button {
  align-self: flex-start;
  font: inherit;
  font-size: 0.78rem;
  padding: 5px 12px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--surface-raised);
  color: var(--text-primary);
  cursor: pointer;
}

.plugin-apply-button:disabled {
  opacity: 0.6;
  cursor: default;
}

.plugin-errors {
  border: 1px solid var(--warning);
  border-radius: var(--radius-md);
  background: var(--warning-soft);
  padding: 10px 12px;
}

.plugin-errors-title {
  margin: 0 0 6px;
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--warning);
}

.plugin-error {
  border-top: 1px solid var(--border-subtle);
  padding: 6px 0;
  font-size: 0.76rem;
}

.plugin-error:first-of-type {
  border-top: none;
}

.plugin-error summary {
  cursor: pointer;
  color: var(--text-primary);
  font-weight: 600;
}

.plugin-error p {
  margin: 4px 0 0 14px;
  color: var(--text-secondary);
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 0.72rem;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

:deep(.n-form-item) {
  margin-bottom: 0;
}
</style>
