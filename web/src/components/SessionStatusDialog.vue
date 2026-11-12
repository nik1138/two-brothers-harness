<script setup lang="ts">
import { computed } from 'vue'
import { NButton } from 'naive-ui'
import type { RunMode, RunStatus, RunUsage, SettingsView } from '../types'
import { cacheHitPercent, promptTokensOf } from '../usageCache'
import AppDialog from './AppDialog.vue'

/**
 * `/status` overlay: only facts the shell actually holds are shown; anything
 * unknown (no usage recorded yet, no model configured, no workspace link) is
 * omitted rather than guessed.
 */

const props = defineProps<{
  session: { name: string; title?: string } | null
  workspaceName?: string | null
  mode: RunMode
  runStatus: RunStatus | null
  roles: SettingsView | null
  usage: RunUsage | null
  turns: number
  events: number
  /** Additive auto-mode routing decision of the newest known run (null when
   *  the run did not route or the backend predates the feature). */
  route?: 'solo' | 'consult' | 'work' | null
  routeReason?: string | null
}>()

const emit = defineEmits<{ close: [] }>()

const MODE_LABELS: Record<RunMode, string> = {
  consult: 'Consult',
  work: 'Work',
  auto: 'Auto',
}

const RUN_LABELS: Record<RunStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  waiting: 'Waiting for approval',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Stopped',
}

const runLabel = computed(() =>
  props.runStatus ? RUN_LABELS[props.runStatus] : 'Idle (no live run for this session)',
)

/** Family-normalized prompt total; OpenAI-compatible runs omit prompt_tokens. */
const promptTokens = computed(() => promptTokensOf(props.usage))
/** `cached / prompt`, clamped; null only when there is no counter to show. */
const cachePct = computed(() => cacheHitPercent(props.usage))
const sessionTitle = computed(
  () => props.session?.title || props.session?.name || 'No session selected',
)

function roleLine(role: 'senior' | 'junior'): string | null {
  const view = props.roles?.[role]
  if (!view) return null
  const model = view.model?.trim()
  const provider = view.provider?.trim()
  if (!model && !provider) return null
  const parts = [model || 'no model set']
  if (provider) parts.push(provider === 'mock' ? 'mock provider' : provider)
  if (view.provider_ref?.trim()) parts.push(`${view.provider_ref.trim()} preset`)
  return parts.join(' · ')
}
</script>

<template>
  <AppDialog
    :show="true"
    size="md"
    title="Session status"
    description="Read-only snapshot from the workspace; unknown values are omitted."
    @close="emit('close')"
  >
    <dl class="status-list">
      <div class="status-row">
        <dt>Session</dt>
        <dd>{{ sessionTitle }}</dd>
      </div>
      <div v-if="session" class="status-row">
        <dt>File</dt>
        <dd><code class="status-mono">{{ session.name }}</code></dd>
      </div>
      <div v-if="workspaceName" class="status-row">
        <dt>Workspace</dt>
        <dd>{{ workspaceName }}</dd>
      </div>
      <div class="status-row">
        <dt>Mode</dt>
        <dd>{{ MODE_LABELS[mode] }}</dd>
      </div>
      <div v-if="route" class="status-row">
        <dt>Route</dt>
        <dd>
          {{ route }}<template v-if="routeReason"> — {{ routeReason }}</template>
        </dd>
      </div>
      <div class="status-row">
        <dt>Run</dt>
        <dd>{{ runLabel }}</dd>
      </div>
      <div v-if="roles" class="status-row">
        <dt>Senior</dt>
        <dd>{{ roleLine('senior') ?? 'No provider or model configured' }}</dd>
      </div>
      <div v-if="roles" class="status-row">
        <dt>Junior</dt>
        <dd>{{ roleLine('junior') ?? 'No provider or model configured' }}</dd>
      </div>
      <div class="status-row">
        <dt>Conversation</dt>
        <dd>{{ turns }} turn{{ turns === 1 ? '' : 's' }} from you · {{ events }} envelopes</dd>
      </div>
      <template v-if="usage">
        <div class="status-row">
          <dt>Usage</dt>
          <dd>
            {{ usage.model_calls }} model call{{ usage.model_calls === 1 ? '' : 's' }}
          </dd>
        </div>
        <div class="status-row">
          <dt>Tokens</dt>
          <dd>
            {{ promptTokens }} in · {{ usage.output_tokens }} out
            <template v-if="cachePct !== null">
              · cache {{ cachePct }}% ({{ usage.cached_tokens }} cached)
            </template>
            <template v-if="(usage.cache_write_tokens ?? 0) > 0">
              · {{ usage.cache_write_tokens }} written
            </template>
          </dd>
        </div>
      </template>
      <div v-else class="status-row">
        <dt>Usage</dt>
        <dd class="status-muted">No completed run usage recorded for this session</dd>
      </div>
    </dl>

    <template #footer>
      <n-button attr-type="button" type="primary" @click="emit('close')">Close</n-button>
    </template>
  </AppDialog>
</template>

<style scoped>
.status-list {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  margin: 0;
}

.status-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.2rem 0.9rem;
  padding: 0.42rem 0.5rem;
  border-radius: var(--radius-sm);
}

.status-row:nth-child(odd) {
  background: var(--surface-canvas);
}

.status-row dt {
  flex: none;
  min-width: 6.5rem;
  font-size: 0.72rem;
  font-weight: 650;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-secondary);
}

.status-row dd {
  flex: 1 1 14rem;
  min-width: 0;
  margin: 0;
  font-size: 0.84rem;
  color: var(--text-primary);
  overflow-wrap: anywhere;
}

.status-mono {
  font-family: var(--font-mono);
  font-size: 0.78rem;
}

.status-muted {
  color: var(--text-secondary);
}
</style>
