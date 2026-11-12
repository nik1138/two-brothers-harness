<script setup lang="ts">
import RoleEditor from './RoleEditor.vue'

interface RoleForm {
  provider: string
  model: string
  base_url: string
  api_key: string
  providerRef: string
  effort: string
}

defineProps<{
  senior: RoleForm
  junior: RoleForm
  subagent: RoleForm
  /** An older backend omits the additive helper route; hide the card. */
  subagentSupported: boolean
  keySet: { senior: boolean; junior: boolean; subagent: boolean }
  connectionOptions: { label: string; value: string }[]
  effortOptions: { senior: string[]; junior: string[]; subagent: string[] }
  effortLoading: { senior: boolean; junior: boolean; subagent: boolean }
  effortErrors: { senior: string; junior: string; subagent: string }
}>()

const emit = defineEmits<{
  'update:senior': [Partial<RoleForm>]
  'update:junior': [Partial<RoleForm>]
  'update:subagent': [Partial<RoleForm>]
}>()

function updateSenior(patch: Partial<RoleForm>) {
  emit('update:senior', patch)
}

function updateJunior(patch: Partial<RoleForm>) {
  emit('update:junior', patch)
}

function updateSubagent(patch: Partial<RoleForm>) {
  emit('update:subagent', patch)
}
</script>

<template>
  <div class="models-roles">
    <p class="settings-lead">
      Both brothers share one conversation but keep their own provider connection and model. A
      preset supplies the base URL and API key; choose Manual to enter them directly. The
      optional helper subagent can use a dedicated route of its own.
    </p>

    <div class="role-stack">
      <RoleEditor
        role="senior"
        :form="senior"
        :key-set="keySet.senior"
        :connection-options="connectionOptions"
        :effort-options="effortOptions.senior"
        :effort-loading="effortLoading.senior"
        :effort-error="effortErrors.senior"
        @update:form="updateSenior"
      />
      <RoleEditor
        role="junior"
        :form="junior"
        :key-set="keySet.junior"
        :connection-options="connectionOptions"
        :effort-options="effortOptions.junior"
        :effort-loading="effortLoading.junior"
        :effort-error="effortErrors.junior"
        @update:form="updateJunior"
      />
      <RoleEditor
        v-if="subagentSupported"
        role="subagent"
        :form="subagent"
        :key-set="keySet.subagent"
        :connection-options="connectionOptions"
        :effort-options="effortOptions.subagent"
        :effort-loading="effortLoading.subagent"
        :effort-error="effortErrors.subagent"
        @update:form="updateSubagent"
      />
    </div>

    <p v-if="subagentSupported" class="settings-note">
      Helper subagents are isolated and request approved workspace changes. Leaving the helper
      route empty keeps the tool's Senior/Junior fallback; a configured route wins.
    </p>
    <p class="settings-note">
      Each role needs a model and a base URL, supplied manually, through a preset and model, or by
      environment pins.
    </p>
  </div>
</template>

<style scoped>
.models-roles {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.role-stack {
  display: flex;
  flex-direction: column;
  gap: 12px;
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
</style>