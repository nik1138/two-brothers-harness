<script setup lang="ts">
import { computed, ref } from 'vue'
import { NButton, NForm, NFormItem, NInput, NModal, NSelect } from 'naive-ui'
import type { Workspace } from '../types'
import { clickInModalBody } from '../modal'

const props = defineProps<{
  workspaces: Workspace[]
  /** Pre-selected workspace id (the current sidebar filter), if any. */
  defaultWorkspace: string | null
}>()

const emit = defineEmits<{
  close: []
  create: [payload: { title: string; workspace_id: string | null }]
}>()

function onMaskClick(e: MouseEvent) {
  if (clickInModalBody(e)) return
  emit('close')
}

const title = ref('')
const workspaceId = ref<string | null>(props.defaultWorkspace ?? '')

const workspaceOptions = computed(() => [
  { label: 'None', value: '' },
  ...props.workspaces.map((w) => ({ label: w.name, value: w.id })),
])

function submit() {
  emit('create', {
    title: title.value.trim(),
    workspace_id: workspaceId.value || null,
  })
}
</script>

<template>
  <n-modal :show="true" @mask-click="onMaskClick" @esc="emit('close')">
    <div class="modal" role="dialog" aria-modal="true" aria-label="New session">
      <h2>New session</h2>
      <n-form label-placement="top" :show-require-mark="false" @submit.prevent="submit">
        <n-form-item label="Title (optional)">
          <n-input
            v-model:value="title"
            placeholder="Derived from your first task if empty"
            :input-props="{ autofocus: true }"
          />
        </n-form-item>
        <n-form-item label="Workspace">
          <n-select
            v-model:value="workspaceId"
            :options="workspaceOptions"
            :consistent-menu-width="false"
          />
        </n-form-item>
        <p class="field-hint">Send a task below to start the conversation.</p>
        <div class="modal-actions">
          <n-button attr-type="button" @click="emit('close')">Cancel</n-button>
          <n-button attr-type="submit" type="primary">Create</n-button>
        </div>
      </n-form>
    </div>
  </n-modal>
</template>
