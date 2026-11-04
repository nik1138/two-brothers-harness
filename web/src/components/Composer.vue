<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { NButton } from 'naive-ui'
import { getSettings } from '../api'
import type { RunMode, RunProvider } from '../types'

const props = defineProps<{
  /** The followed run is working (queued/running) — the composer is locked. */
  busy: boolean
  /**
   * The followed run is parked on an operator approval. The input stays
   * usable for drafting, but sending is blocked until the run finishes.
   */
  waiting?: boolean
  stopping: boolean
  settingsVersion?: number
}>()

const emit = defineEmits<{
  submit: [payload: { task: string; mode: RunMode; provider: RunProvider | null }]
  stop: []
  openSettings: []
}>()

const task = ref('')
const mode = ref<RunMode>('consult')
/** '' means "take the providers from the role settings". */
const provider = ref<RunProvider | ''>('')

/**
 * True while the provider override is "from settings" but at least one role
 * lacks model settings (such runs fail fast with the no-base_url error).
 * Unknown (request failed) stays false — the run error toast already explains failures.
 */
const settingsMissing = ref(false)

async function checkSettings() {
  if (provider.value !== '') {
    settingsMissing.value = false
    return
  }
  try {
    const settings = await getSettings()
    settingsMissing.value = (['senior', 'junior'] as const).some(
      (role) => !settings[role].model && !settings[role].base_url,
    )
  } catch {
    settingsMissing.value = false
  }
}

onMounted(checkSettings)
watch(provider, checkSettings)
// the operator may have saved settings while the composer stayed mounted
watch(() => props.settingsVersion, checkSettings)

function submit() {
  const text = task.value.trim()
  // `waiting` keeps the textarea usable for drafting, but a new run cannot
  // start while this session's run is still alive.
  if (!text || props.busy || props.waiting) return
  emit('submit', { task: text, mode: mode.value, provider: provider.value || null })
  task.value = ''
}

function onKeydown(e: KeyboardEvent) {
  // while waiting Enter must stay a newline — the text is a draft, not a task
  if (props.busy || props.waiting) return
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    submit()
  }
}
</script>

<template>
  <form class="composer" aria-label="New task" @submit.prevent="submit">
    <div v-if="settingsMissing" class="composer-hint" role="note">
      <span>No model settings saved — runs will fail until you configure them.</span>
      <button type="button" class="composer-hint-action" @click="emit('openSettings')">
        Open settings
      </button>
    </div>
    <div v-if="waiting" class="composer-waiting" role="note">
      <span
        >The run is waiting for your approval — answer the request in the conversation. You can
        draft the next task meanwhile.</span
      >
    </div>
    <textarea
      v-model="task"
      class="composer-input"
      rows="1"
      :placeholder="
        waiting
          ? 'Draft your next task… (it can be sent once this run finishes)'
          : 'Describe a task for the two brothers… (Enter to send, Shift+Enter for a new line)'
      "
      :disabled="busy"
      @keydown="onKeydown"
    ></textarea>
    <div class="composer-controls">
      <label class="control">
        <span class="control-label">mode</span>
        <select v-model="mode" :disabled="busy" title="Cooperation mode">
          <option value="consult">consult</option>
          <option value="work">work</option>
          <option value="auto">auto</option>
        </select>
      </label>
      <label class="control">
        <span class="control-label">provider</span>
        <select v-model="provider" :disabled="busy" title="Provider override for this run">
          <option value="mock">mock</option>
          <option value="openai">openai</option>
          <option value="">from settings</option>
        </select>
      </label>
      <n-button
        v-if="busy || waiting"
        type="error"
        :disabled="stopping"
        @click="emit('stop')"
      >
        {{ stopping ? 'Stopping…' : 'Stop' }}
      </n-button>
      <n-button
        v-else
        attr-type="submit"
        type="primary"
        :disabled="!task.trim()"
      >Send</n-button>
    </div>
  </form>
</template>

<style scoped>
.composer-waiting {
  padding: 0.4rem 0.75rem;
  font-size: 0.8rem;
  color: var(--warning);
  background: var(--warning-soft);
  border: 1px solid var(--warning);
  border-radius: var(--radius-md);
}

.composer-hint {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.4rem 0.75rem;
  font-size: 0.8rem;
  color: var(--warning);
  background: var(--warning-soft);
  border: 1px solid var(--warning);
  border-radius: var(--radius-md);
}

.composer-hint-action {
  flex: 0 0 auto;
  border: none;
  background: transparent;
  color: inherit;
  font-size: 0.8rem;
  font-weight: 600;
  cursor: pointer;
  text-decoration: underline;
  padding: 0.1rem 0.2rem;
}
</style>
