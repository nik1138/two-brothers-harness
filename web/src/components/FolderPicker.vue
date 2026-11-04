<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { NButton, NInput, NModal } from 'naive-ui'
import { ApiError, browseFs } from '../api'
import { clickInModalBody } from '../modal'
import type { FsEntry } from '../types'

const emit = defineEmits<{ close: []; select: [path: string] }>()

function onMaskClick(e: MouseEvent) {
  if (clickInModalBody(e)) return
  emit('close')
}

const path = ref('')
const parent = ref<string | null>(null)
const entries = ref<FsEntry[]>([])
const truncated = ref(false)
const loading = ref(false)
const error = ref<string | null>(null)

/** Monotonic request token: a slow response from an earlier navigation must
 * never overwrite the listing of a newer one (double-Enter / click spam). */
let loadSeq = 0

function errText(e: unknown): string {
  return e instanceof ApiError ? e.message : String(e)
}

async function load(next?: string) {
  const seq = ++loadSeq
  loading.value = true
  error.value = null
  try {
    const res = await browseFs(next)
    if (seq !== loadSeq) return
    path.value = res.path
    parent.value = res.parent
    entries.value = res.entries
    truncated.value = res.truncated
  } catch (e) {
    if (seq === loadSeq) error.value = errText(e)
  } finally {
    if (seq === loadSeq) loading.value = false
  }
}

function descend(entry: FsEntry) {
  load(entry.path)
}

function select() {
  const p = path.value.trim()
  if (p) emit('select', p)
}

onMounted(() => load())
</script>

<template>
  <n-modal :show="true" @mask-click="onMaskClick" @esc="emit('close')">
    <div class="modal" role="dialog" aria-modal="true" aria-label="Browse folder">
      <h2>Browse folder</h2>
      <div class="folder-picker-path">
        <n-input
          v-model:value="path"
          placeholder="Folder path"
          :input-props="{ 'aria-label': 'Folder path' }"
          @keyup.enter="load(path.trim() || undefined)"
        />
        <n-button attr-type="button" :disabled="parent === null || loading" @click="load(parent ?? undefined)">
          ⬅ Parent
        </n-button>
      </div>
      <div class="folder-list" role="group" aria-label="Folders">
        <p v-if="loading" class="empty-hint">Loading…</p>
        <p v-else-if="error" class="modal-error" role="alert">{{ error }}</p>
        <p v-else-if="entries.length === 0" class="empty-hint">No subfolders here</p>
        <template v-else>
          <button
            v-for="entry in entries"
            :key="entry.path"
            type="button"
            class="folder-row"
            @click="descend(entry)"
          >
            {{ entry.name }}
          </button>
          <p v-if="truncated" class="field-hint">… listing truncated</p>
        </template>
      </div>
      <div class="modal-actions">
        <n-button attr-type="button" @click="emit('close')">Cancel</n-button>
        <n-button
          attr-type="button"
          type="primary"
          :disabled="!path.trim() || loading"
          @click="select"
        >
          Select this folder
        </n-button>
      </div>
    </div>
  </n-modal>
</template>
