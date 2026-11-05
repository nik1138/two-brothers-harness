<script setup lang="ts">
import { NModal } from 'naive-ui'
import { clickInModalBody } from '../modal'
import WorkspaceFinder from './WorkspaceFinder.vue'

const emit = defineEmits<{ close: []; select: [path: string] }>()

function onMaskClick(e: MouseEvent): void {
  if (clickInModalBody(e)) return
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
      class="modal folder-picker-dialog"
      role="dialog"
      aria-modal="true"
      aria-label="Browse folder"
      @keydown.esc.stop="emit('close')"
    >
      <header class="folder-picker-header">
        <h2>Browse folder</h2>
        <p>Choose a folder directly, or select a subfolder before confirming.</p>
      </header>
      <WorkspaceFinder
        label="Browse folders"
        :name-field="false"
        @confirm="emit('select', $event.path)"
        @cancel="emit('close')"
      />
    </div>
  </n-modal>
</template>

<style scoped>
.folder-picker-dialog {
  width: min(42.5rem, calc(100vw - 1.5rem));
  max-width: 42.5rem;
  height: min(31.25rem, calc(100dvh - 1.5rem));
  max-height: calc(100dvh - 1.5rem);
}

.folder-picker-header {
  flex: none;
  margin-bottom: 0.75rem;
}

.folder-picker-header h2 {
  margin: 0 0 0.2rem;
}

.folder-picker-header p {
  margin: 0;
  color: var(--text-secondary);
  font-size: 0.78rem;
}

@media (max-width: 720px) {
  .folder-picker-dialog {
    width: calc(100vw - 1rem);
    height: min(33rem, calc(100dvh - 1rem));
  }
}
</style>
