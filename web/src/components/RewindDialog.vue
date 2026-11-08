<script setup lang="ts">
/**
 * Session-rewind confirmation (wave 23). A destructive action needs exactly
 * one honest confirmation step: this dialog names what will be removed (the
 * selected operator task and everything after it, with message/task counts),
 * states that the session file is rewritten in place and cannot be undone, and
 * only then calls `POST /api/sessions/{name}/rewind`.
 *
 * Dialogs in this app own their API call and report a failed request inline
 * (`role=alert`) plus to the shell (`error`, which raises the standard toast),
 * so the shell only has to reload the rewritten session on `rewound`.
 */
import { computed, ref } from 'vue'
import { NButton } from 'naive-ui'
import { ApiError, rewindSession } from '../api'
import { rewindConfirmation, rewindFailureNotice } from '../sessionRewind'
import type { RewindPreview } from '../sessionRewind'
import type { SessionRewindResult } from '../types'
import AppDialog from './AppDialog.vue'

const props = defineProps<{
  /** Canonical session file name the rewrite targets. */
  session: string
  /** The pre-request preview the operator is confirming. */
  preview: RewindPreview
}>()

const emit = defineEmits<{
  close: []
  /** The backend applied a cut; the shell reloads the session. */
  rewound: [result: SessionRewindResult]
  /** Non-blocking shell feedback: the request failed with `message`. */
  error: [message: string]
}>()

const busy = ref(false)
const serverError = ref<string | null>(null)

const body = computed(() => rewindConfirmation(props.preview))
const taskQuote = computed(() => props.preview.taskText.trim())

function errText(e: unknown): string {
  return e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e)
}

function requestClose(): void {
  if (busy.value) return
  emit('close')
}

async function submit(): Promise<void> {
  if (busy.value) return
  serverError.value = null
  busy.value = true
  try {
    const result = await rewindSession(props.session, props.preview.turns)
    emit('rewound', result)
  } catch (e) {
    const message = rewindFailureNotice({
      status: e instanceof ApiError ? e.status : undefined,
      detail: errText(e),
    })
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
    title="Rewind conversation to here?"
    :description="`Session ${session}`"
    :persistent="busy"
    initial-focus=".rewind-cancel"
    @close="requestClose"
  >
    <div class="rewind-body">
      <p class="rewind-copy">{{ body }}</p>
      <p v-if="taskQuote" class="rewind-selected">
        Selected task: <q>{{ taskQuote }}</q>
      </p>
      <p v-if="serverError" class="rewind-error" role="alert">{{ serverError }}</p>
    </div>

    <template #footer>
      <n-button attr-type="button" class="rewind-cancel" :disabled="busy" @click="requestClose">
        Cancel
      </n-button>
      <n-button
        attr-type="button"
        type="error"
        class="rewind-confirm"
        :loading="busy"
        @click="submit"
      >
        {{ busy ? 'Rewinding…' : 'Rewind and delete' }}
      </n-button>
    </template>
  </AppDialog>
</template>

<style scoped>
.rewind-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  font-size: 0.82rem;
  line-height: 1.5;
}

.rewind-copy {
  margin: 0;
  white-space: pre-line;
  color: var(--text-primary);
}

.rewind-selected {
  margin: 0;
  color: var(--text-secondary);
  overflow-wrap: anywhere;
}

.rewind-error {
  margin: 0;
  color: var(--danger);
  font-size: 0.78rem;
  line-height: 1.4;
}
</style>
