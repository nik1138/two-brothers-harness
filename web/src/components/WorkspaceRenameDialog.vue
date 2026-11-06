<script setup lang="ts">
import { computed, ref } from 'vue'
import { NButton, NInput } from 'naive-ui'
import type { InputInst } from 'naive-ui'
import { ApiError, renameWorkspace } from '../api'
import {
  WORKSPACE_NAME_MAX,
  normalizeWorkspaceName,
  workspaceNameProblem,
} from '../workspaceOrder'
import type { Workspace } from '../types'
import AppDialog from './AppDialog.vue'

/**
 * Small rename dialog for a registered workspace, built on `AppDialog` so the
 * focus trap, Escape handling and focus restore come from the shared modal
 * shell. The input is prefilled with the current name; Enter submits, Esc
 * cancels, and an unchanged name closes without a request.
 *
 * The dialog owns the `PATCH /api/workspaces/{id}` call (same pattern as the
 * other workspace dialogs) and reports a failed save inline (role=alert) and
 * to the shell (`error`), which raises the standard toast.
 */

const props = defineProps<{
  workspace: Workspace
}>()

const emit = defineEmits<{
  close: []
  renamed: [workspace: Workspace]
  /** Non-blocking shell feedback: the save failed with `message`. */
  error: [message: string]
}>()

const name = ref(props.workspace.name)
const busy = ref(false)
const validationError = ref<string | null>(null)
const serverError = ref<string | null>(null)
const nameInput = ref<InputInst | null>(null)

const errorText = computed(() => validationError.value ?? serverError.value)
const description = computed(() => props.workspace.path || 'Workspace display name')

function errText(e: unknown): string {
  return e instanceof ApiError ? e.message : String(e)
}

/** Select the prefilled name so typing replaces it. */
function selectName(): void {
  nameInput.value?.select()
}

function requestClose(): void {
  if (busy.value) return
  emit('close')
}

async function submit(): Promise<void> {
  if (busy.value) return
  serverError.value = null
  const problem = workspaceNameProblem(name.value)
  if (problem) {
    validationError.value = problem
    nameInput.value?.focus()
    return
  }
  validationError.value = null
  const next = normalizeWorkspaceName(name.value)
  // no-op save: nothing changed, just close without an API round-trip
  if (next === props.workspace.name) {
    emit('close')
    return
  }
  busy.value = true
  try {
    const saved = await renameWorkspace(props.workspace.id, next)
    emit('renamed', saved)
  } catch (e) {
    const message = errText(e)
    serverError.value = message
    emit('error', message)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <AppDialog
    :show="true"
    size="sm"
    title="Rename workspace"
    :description="description"
    :persistent="busy"
    initial-focus=".workspace-rename-input"
    @close="requestClose"
    @after-enter="selectName"
  >
    <form class="workspace-rename" @submit.prevent="submit">
      <label class="workspace-rename-label" for="workspace-rename-input">
        Workspace name
      </label>
      <n-input
        ref="nameInput"
        v-model:value="name"
        :input-props="{
          id: 'workspace-rename-input',
          class: 'workspace-rename-input',
          autocomplete: 'off',
          spellcheck: 'false',
        }"
        :maxlength="WORKSPACE_NAME_MAX"
        :disabled="busy"
        :status="errorText ? 'error' : undefined"
        placeholder="Workspace name"
        @keydown.enter.prevent="submit"
      />
      <p v-if="errorText" class="workspace-rename-error" role="alert">
        {{ errorText }}
      </p>
    </form>

    <template #footer>
      <n-button attr-type="button" :disabled="busy" @click="requestClose">Cancel</n-button>
      <n-button attr-type="button" type="primary" :loading="busy" @click="submit">
        {{ busy ? 'Renaming…' : 'Rename' }}
      </n-button>
    </template>
  </AppDialog>
</template>

<style scoped>
.workspace-rename {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.workspace-rename-label {
  color: var(--text-secondary);
  font-size: 0.78rem;
  font-weight: 500;
}

.workspace-rename-error {
  margin: 0.1rem 0 0;
  color: var(--danger);
  font-size: 0.76rem;
  line-height: 1.35;
}
</style>
