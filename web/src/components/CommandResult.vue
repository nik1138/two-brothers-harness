<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue'

export interface CommandResultPayload {
  command: string
  status: string
  exit_code: number | null
  stdout: string
  stderr: string
  truncated: boolean
  duration_ms: number
  error?: string
}

const props = defineProps<{
  result: CommandResultPayload
}>()

const open = ref(false)

const succeeded = computed(
  () =>
    props.result.exit_code === 0 &&
    ['ok', 'completed', 'success'].includes(props.result.status),
)

const failed = computed(() => !succeeded.value)

const statusText = computed(() => {
  if (props.result.exit_code !== null) return `exit ${props.result.exit_code}`
  return props.result.status
})

const durationText = computed(() => {
  const ms = props.result.duration_ms
  if (!(ms > 0)) return null
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`
  return `${ms}ms`
})

const hasOutput = computed(() => Boolean(props.result.stdout || props.result.stderr))

const toggleLabel = computed(() => (open.value ? 'Hide output' : 'Show output'))

// -- copy output --------------------------------------------------------------

const copied = ref(false)
let copyTimer: number | undefined

/** Both streams, labelled, so a pasted excerpt keeps its context. */
const outputText = computed(() => {
  const parts: string[] = []
  if (props.result.stdout) parts.push(props.result.stdout)
  if (props.result.stderr) parts.push(props.result.stderr)
  return parts.join('\n')
})

async function copyOutput() {
  try {
    await navigator.clipboard.writeText(outputText.value)
    copied.value = true
    if (copyTimer !== undefined) window.clearTimeout(copyTimer)
    copyTimer = window.setTimeout(() => {
      copied.value = false
    }, 1500)
  } catch {
    // Clipboard unavailable (non-secure context): the button stays inert.
  }
}

onUnmounted(() => {
  if (copyTimer !== undefined) window.clearTimeout(copyTimer)
})
</script>

<template>
  <article class="cmd" :class="{ 'cmd-failed': failed }">
    <header class="cmd-header">
      <code class="cmd-command" :title="result.command">{{ result.command }}</code>
      <span class="cmd-meta">
        <span
          class="cmd-status"
          :class="succeeded ? 'cmd-ok' : 'cmd-bad'"
          role="status"
        >{{ statusText }}</span>
        <span v-if="durationText" class="cmd-duration muted">{{ durationText }}</span>
        <button
          v-if="hasOutput"
          type="button"
          class="cmd-toggle cmd-copy"
          :aria-label="`${copied ? 'Copied' : 'Copy'} output for command: ${result.command}`"
          @click="copyOutput"
        >{{ copied ? 'copied' : 'copy' }}</button>
        <button
          v-if="hasOutput"
          type="button"
          class="cmd-toggle"
          :aria-expanded="open"
          :aria-label="`${toggleLabel} for command: ${result.command}`"
          @click="open = !open"
        >{{ open ? '▾' : '▸' }} {{ toggleLabel }}</button>
      </span>
    </header>
    <div v-if="result.error" class="cmd-error" role="alert">{{ result.error }}</div>
    <div v-show="open && hasOutput" class="cmd-output">
      <template v-if="result.stdout">
        <p class="cmd-stream-label">stdout</p>
        <pre class="cmd-stream" aria-label="Standard output">{{ result.stdout }}</pre>
      </template>
      <template v-if="result.stderr">
        <p class="cmd-stream-label">stderr</p>
        <pre class="cmd-stream cmd-stderr" aria-label="Standard error">{{ result.stderr }}</pre>
      </template>
      <p v-if="result.truncated" class="cmd-truncated muted">Output truncated.</p>
    </div>
    <p v-if="!hasOutput && !result.error" class="cmd-none muted">No output.</p>
  </article>
</template>

<style scoped>
.cmd {
  border: 1px solid var(--border-subtle);
  border-left: 3px solid var(--ok);
  border-radius: var(--radius-md);
  background: var(--surface-panel);
  overflow: hidden;
  font-size: 0.85rem;
}

.cmd-failed {
  border-left-color: var(--danger);
}

.cmd-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.6rem;
  padding: 0.45rem 0.7rem;
  flex-wrap: wrap;
}

.cmd-command {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 0.8rem;
}

.cmd-meta {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  flex-shrink: 0;
}

.cmd-status {
  font-size: 0.7rem;
  font-weight: 600;
  border-radius: var(--radius-pill);
  padding: 0.1rem 0.55rem;
  color: var(--text-on-accent);
}

.cmd-ok {
  background: var(--ok);
}

.cmd-bad {
  background: var(--danger);
}

.cmd-duration {
  font-size: 0.75rem;
  font-variant-numeric: tabular-nums;
}

.cmd-toggle {
  border: none;
  background: transparent;
  color: var(--accent);
  cursor: pointer;
  font-size: 0.78rem;
  padding: 0.15rem 0.3rem;
  border-radius: var(--radius-sm);
}

.cmd-toggle:hover {
  background: var(--surface-hover);
}

.cmd-copy {
  color: var(--text-secondary);
}

.cmd-error {
  margin: 0 0.7rem;
  padding: 0.4rem 0.6rem;
  border-radius: var(--radius-sm);
  background: var(--danger-soft);
  color: var(--danger);
  font-size: 0.8rem;
  overflow-wrap: break-word;
}

.cmd-output {
  border-top: 1px solid var(--border-subtle);
  padding: 0.4rem 0.7rem 0.6rem;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.cmd-stream-label {
  margin: 0;
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-secondary);
}

.cmd-stream {
  margin: 0;
  padding: 0.45rem 0.6rem;
  border-radius: var(--radius-sm);
  background: var(--surface-canvas);
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 0.78rem;
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: break-word;
  max-height: 16rem;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.cmd-stderr {
  color: var(--danger);
}

.cmd-truncated {
  margin: 0;
  font-size: 0.75rem;
}

.cmd-none {
  margin: 0;
  padding: 0 0.7rem var(--space-2);
  font-size: 0.78rem;
}
</style>