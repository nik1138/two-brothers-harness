<script setup lang="ts">
import { computed } from 'vue'
import { NForm, NFormItem, NInput, NSelect } from 'naive-ui'
import { effortLabel } from '../../modelEfforts'

interface RoleForm {
  provider: string
  model: string
  base_url: string
  api_key: string
  providerRef: string
  effort: string
}

const props = defineProps<{
  role: 'senior' | 'junior' | 'subagent'
  form: RoleForm
  keySet: boolean
  connectionOptions: { label: string; value: string }[]
  /** Model-declared levels (`GET /api/model-efforts`); empty = no control. */
  effortOptions: string[]
  effortLoading?: boolean
  effortError?: string
}>()

const emit = defineEmits<{ 'update:form': [Partial<RoleForm>] }>()

const label = computed(() =>
  props.role === 'senior' ? 'Senior' : props.role === 'junior' ? 'Junior' : 'Subagent',
)
const description = computed(() =>
  props.role === 'senior'
    ? 'Arbitrates the exchange and makes the final decision.'
    : props.role === 'junior'
      ? 'Explores, implements, and reports back to the Senior.'
      : 'Read-only helper spawned by the Senior. A configured route here overrides the tool\'s role fallback.',
)
const presetActive = computed(() => Boolean(props.form.providerRef))
const showEffort = computed(
  () => props.effortOptions.length > 0 || props.form.effort !== '' || props.effortLoading === true,
)
const effortSelectOptions = computed(() => {
  const options = [
    { label: 'Default', value: '' },
    ...props.effortOptions.map((level) => ({ label: effortLabel(level), value: level })),
  ]
  const current = props.form.effort
  if (current !== '' && !props.effortOptions.includes(current)) {
    options.push({ label: `${effortLabel(current)} (saved, not reported)`, value: current })
  }
  return options
})

function patch(change: Partial<RoleForm>) {
  emit('update:form', change)
}

function onConnection(value: unknown) {
  patch({ providerRef: typeof value === 'string' ? value : '' })
}

function onModel(value: string) {
  patch({ model: value })
}

function onBaseUrl(value: string) {
  patch({ base_url: value })
}

function onApiKey(value: string) {
  patch({ api_key: value })
}

function onEffort(value: string) {
  patch({ effort: value })
}
</script>

<template>
  <section class="role-card" :class="`role-card--${role}`" :aria-label="`${label} connection`">
    <header class="role-card-head">
      <span class="role-dot" aria-hidden="true"></span>
      <div class="role-card-copy">
        <h3>{{ label }}</h3>
        <p>{{ description }}</p>
      </div>
      <span v-if="presetActive" class="role-chip">preset</span>
    </header>

    <n-form label-placement="top" :show-require-mark="false">
      <n-form-item label="Connection">
        <n-select
          :value="form.providerRef"
          :options="connectionOptions"
          :consistent-menu-width="false"
          @update:value="onConnection"
        />
      </n-form-item>
      <n-form-item label="Model">
        <n-input
          :value="form.model"
          placeholder="e.g. spark-x2.6-4b@q4_k_m"
          @update:value="onModel"
        />
      </n-form-item>
      <n-form-item v-if="showEffort" label="Effort">
        <n-select
          :value="form.effort"
          :options="effortSelectOptions"
          :loading="effortLoading === true"
          :consistent-menu-width="false"
          @update:value="onEffort"
        />
        <template #feedback>
          <span v-if="effortError">{{ effortError }}</span>
          <span v-else-if="effortLoading">Loading model-reported levels…</span>
          <span v-else-if="effortOptions.length === 0">
            This model reports no selectable effort levels; Default sends no reasoning control.
          </span>
          <span v-else>Levels reported by the selected model.</span>
        </template>
      </n-form-item>
      <n-form-item label="Base URL">
        <n-input
          :value="form.base_url"
          placeholder="http://127.0.0.1:1234/v1"
          :disabled="presetActive"
          @update:value="onBaseUrl"
        />
        <template #feedback>
          <span v-if="presetActive">Supplied by the selected provider preset.</span>
        </template>
      </n-form-item>
      <n-form-item label="API key">
        <n-input
          :value="form.api_key"
          type="password"
          show-password-on="click"
          autocomplete="off"
          :placeholder="keySet ? 'set — type a new value to replace' : 'not set'"
          :disabled="presetActive"
          @update:value="onApiKey"
        />
        <template #feedback>
          <span v-if="keySet && !presetActive">
            A key is stored on the backend; it is never sent back to this app.
          </span>
        </template>
      </n-form-item>
    </n-form>
  </section>
</template>

<style scoped>
.role-card {
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  padding: 14px 16px 0;
  background: var(--surface-panel);
}

.role-card-head {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin-bottom: 12px;
}

.role-dot {
  flex: none;
  width: 8px;
  height: 8px;
  margin-top: 7px;
  border-radius: 50%;
  background: var(--senior-fill);
}

.role-card--junior .role-dot {
  background: var(--junior-fill);
}

.role-card--subagent .role-dot {
  background: var(--accent);
}

.role-card-copy {
  min-width: 0;
}

.role-card-copy h3 {
  margin: 0;
  font-size: 0.9rem;
  font-weight: 600;
}

.role-card-copy p {
  margin: 2px 0 0;
  font-size: 0.75rem;
  line-height: 1.4;
  color: var(--text-secondary);
}

.role-chip {
  flex: none;
  margin-left: auto;
  border: 1px solid var(--border-subtle);
  border-radius: 999px;
  padding: 1px 8px;
  font-size: 0.7rem;
  color: var(--text-secondary);
  background: var(--surface-canvas);
}

:deep(.n-form-item) {
  margin-bottom: 6px;
}

:deep(.n-form-item-feedback-wrapper) {
  min-height: 1.1rem;
}

:deep(.n-form-item-feedback) {
  font-size: 0.72rem;
  color: var(--text-secondary);
}
</style>