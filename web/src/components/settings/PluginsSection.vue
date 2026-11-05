<script setup lang="ts">
import { computed } from 'vue'
import { NForm, NFormItem, NSelect } from 'naive-ui'
import type { PluginLoadError } from '../../api'

const props = defineProps<{
  plugins: string[]
  options: { label: string; value: string }[]
  errors: PluginLoadError[]
}>()

const emit = defineEmits<{ 'update:plugins': [string[]] }>()

const activeCount = computed(() => props.plugins.length)

function onSelection(value: unknown) {
  emit('update:plugins', Array.isArray(value) ? value.map(String) : [])
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
      A plugin fixed outside this panel is picked up the next time settings are saved.
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