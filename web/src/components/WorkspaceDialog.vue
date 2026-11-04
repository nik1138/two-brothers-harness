<script setup lang="ts">
import { ref } from 'vue'
import { NButton, NForm, NFormItem, NInput, NModal } from 'naive-ui'
import { ApiError, addWorkspace } from '../api'
import { clickInModalBody } from '../modal'
import FolderPicker from './FolderPicker.vue'

const emit = defineEmits<{ close: [] }>()

function onMaskClick(e: MouseEvent) {
  // a click inside the stacked FolderPicker fires our mask-click too — ignore it
  if (clickInModalBody(e)) return
  emit('close')
}

const path = ref('')
const name = ref('')
const busy = ref(false)
const error = ref<string | null>(null)
const pickerOpen = ref(false)

function errText(e: unknown): string {
  return e instanceof ApiError ? e.message : String(e)
}

function onFolderPicked(picked: string) {
  pickerOpen.value = false
  path.value = picked
}

async function submit() {
  const p = path.value.trim()
  if (!p || busy.value) return
  busy.value = true
  error.value = null
  try {
    await addWorkspace({ path: p, name: name.value.trim() || undefined })
    emit('close')
  } catch (e) {
    error.value = errText(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <n-modal :show="true" @mask-click="onMaskClick" @esc="emit('close')">
    <div class="modal" role="dialog" aria-modal="true" aria-label="Add workspace">
      <h2>Add workspace</h2>
      <n-form label-placement="top" :show-require-mark="false" @submit.prevent="submit">
        <n-form-item label="Directory path">
          <div class="folder-picker-path">
            <n-input
              v-model:value="path"
              placeholder="C:\path\to\project"
              :input-props="{ autofocus: true }"
            />
            <n-button attr-type="button" @click.stop="pickerOpen = true">Browse…</n-button>
          </div>
        </n-form-item>
        <n-form-item label="Name (optional)">
          <n-input v-model:value="name" placeholder="Defaults to the directory name" />
        </n-form-item>
        <p v-if="error" class="modal-error" role="alert">{{ error }}</p>
        <div class="modal-actions">
          <n-button attr-type="button" @click="emit('close')">Cancel</n-button>
          <n-button attr-type="submit" type="primary" :disabled="busy || !path.trim()">
            {{ busy ? 'Adding…' : 'Add' }}
          </n-button>
        </div>
      </n-form>
    </div>
  </n-modal>
  <!-- Sibling root, not nested in the outer n-modal's slot: a nested second
       n-modal inherits the outer modal's mask-click bubbling and closes both
       dialogs on the Browse… click. -->
  <FolderPicker v-if="pickerOpen" @close="pickerOpen = false" @select="onFolderPicked" />
</template>
