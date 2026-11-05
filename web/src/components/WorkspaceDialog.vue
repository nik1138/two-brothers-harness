<script setup lang="ts">
import { ref } from 'vue'
import { NModal } from 'naive-ui'
import { ApiError, addWorkspace } from '../api'
import { clickInModalBody } from '../modal'
import WorkspaceFinder from './WorkspaceFinder.vue'
import type { Workspace } from '../types'

/**
 * Add-workspace dialog: ONE modal wrapping the folder finder. The old
 * path-form → nested `FolderPicker` stack is gone; the finder owns breadcrumb,
 * parent/home, editable-path, folder-list, and confirmation.
 */

const emit = defineEmits<{
  close: []
  /** The workspace was created (optional hook for the app shell). */
  created: [workspace: Workspace]
}>()

function onMaskClick(e: MouseEvent) {
  // A click inside another stacked dialog must not dismiss this one.
  if (clickInModalBody(e)) return
  if (busy.value) return
  emit('close')
}

const busy = ref(false)
const error = ref<string | null>(null)

function errText(e: unknown): string {
  return e instanceof ApiError ? e.message : String(e)
}

async function onConfirm(payload: { path: string; name: string }) {
  if (busy.value) return
  busy.value = true
  error.value = null
  try {
    const workspace = await addWorkspace({
      path: payload.path,
      name: payload.name || undefined,
    })
    emit('created', workspace)
    emit('close')
  } catch (e) {
    error.value = errText(e)
  } finally {
    busy.value = false
  }
}

function onEsc() {
  if (busy.value) return
  emit('close')
}
</script>

<template>
  <n-modal
    :show="true"
    :auto-focus="false"
    :close-on-esc="false"
    @mask-click="onMaskClick"
  >
    <div
      class="modal workspace-dialog"
      role="dialog"
      aria-modal="true"
      aria-label="Add workspace"
      @keydown.esc.stop="onEsc"
    >
      <header class="workspace-dialog-header">
        <h2>Add workspace</h2>
        <p class="workspace-dialog-sub">
          Browse to a project folder — no path typing required. Escape closes.
        </p>
      </header>
      <WorkspaceFinder
        label="Add workspace folder"
        confirm-label="Add workspace"
        busy-label="Adding…"
        :busy="busy"
        :server-error="error"
        @confirm="onConfirm"
        @cancel="emit('close')"
      />
    </div>
  </n-modal>
</template>

<style scoped>
.workspace-dialog {
  width: min(42.5rem, calc(100vw - 1.5rem));
  max-width: 42.5rem;
  height: min(31.25rem, calc(100dvh - 1.5rem));
  max-height: calc(100dvh - 1.5rem);
}

.workspace-dialog-header {
  display: flex;
  flex: none;
  flex-direction: column;
  gap: 0.2rem;
  margin-bottom: 0.75rem;
}

.workspace-dialog-header h2 {
  margin: 0;
}

.workspace-dialog-sub {
  margin: 0;
  color: var(--text-secondary);
  font-size: 0.78rem;
}

@media (max-width: 720px) {
  .workspace-dialog {
    width: calc(100vw - 1rem);
    height: min(33rem, calc(100dvh - 1rem));
  }
}
</style>
