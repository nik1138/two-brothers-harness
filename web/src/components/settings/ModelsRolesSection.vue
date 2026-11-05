<script setup lang="ts">
import RoleEditor from './RoleEditor.vue'

interface RoleForm {
  provider: string
  model: string
  base_url: string
  api_key: string
  providerRef: string
}

defineProps<{
  senior: RoleForm
  junior: RoleForm
  keySet: { senior: boolean; junior: boolean }
  connectionOptions: { label: string; value: string }[]
}>()

const emit = defineEmits<{
  'update:senior': [Partial<RoleForm>]
  'update:junior': [Partial<RoleForm>]
}>()

function updateSenior(patch: Partial<RoleForm>) {
  emit('update:senior', patch)
}

function updateJunior(patch: Partial<RoleForm>) {
  emit('update:junior', patch)
}
</script>

<template>
  <div class="models-roles">
    <p class="settings-lead">
      Both brothers share one conversation but keep their own provider connection and model. A
      preset supplies the base URL and API key; choose Manual to enter them directly.
    </p>

    <div class="role-stack">
      <RoleEditor
        role="senior"
        :form="senior"
        :key-set="keySet.senior"
        :connection-options="connectionOptions"
        @update:form="updateSenior"
      />
      <RoleEditor
        role="junior"
        :form="junior"
        :key-set="keySet.junior"
        :connection-options="connectionOptions"
        @update:form="updateJunior"
      />
    </div>

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