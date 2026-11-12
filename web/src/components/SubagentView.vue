<script setup lang="ts">
import { computed } from 'vue'
import type { RunUsage, SubagentDetail } from '../types'
import {
  subagentDuration,
  subagentElapsed,
  subagentRoleLabel,
  subagentStatusLabel,
  subagentTaskPreview,
  subagentTokenLabel,
} from '../subagents'
import { cacheHitPercent, promptTokensOf } from '../usageCache'

const props = defineProps<{
  detail: SubagentDetail | null
  loading: boolean
  error: string
}>()

const emit = defineEmits<{ back: [] }>()

const statusLabel = computed(() => subagentStatusLabel(props.detail?.status ?? 'running'))
const elapsed = computed(() =>
  props.detail ? subagentElapsed(props.detail.started_at, props.detail.ended_at) : '',
)
const tokens = computed(() => subagentTokenLabel(props.detail?.usage))
const cachePct = computed(() => cacheHitPercent(props.detail?.usage))
const promptTokens = computed(() => promptTokensOf(props.detail?.usage))
const taskLine = computed(() => subagentTaskPreview(props.detail?.task ?? '', 180))
const usage = computed<RunUsage | null>(() => props.detail?.usage ?? null)

/** Avoid painting the final report twice: the store's last assistant message wins. */
const timeline = computed(() => {
  const detail = props.detail
  if (!detail) return []
  const entries = detail.transcript
  const result = detail.result?.trim() ?? ''
  const last = entries[entries.length - 1]
  if (
    result !== '' &&
    last?.type === 'message' &&
    last.role === 'assistant' &&
    (last.text ?? '').trim() === result
  ) {
    return entries.slice(0, -1)
  }
  return entries
})

function argsText(args: Record<string, unknown> | undefined): string {
  if (!args) return ''
  try {
    return JSON.stringify(args, null, 2)
  } catch {
    return ''
  }
}

function closeOnBackdrop(event: MouseEvent) {
  if (event.target === event.currentTarget) emit('back')
}
</script>

<template>
  <section
    class="subagent-view"
    aria-label="Subagent transcript"
    @click="closeOnBackdrop"
  >
    <header class="subagent-view-head">
      <button
        type="button"
        class="subagent-back"
        aria-label="Back to parent session"
        @click="emit('back')"
      >
        ← Parent
      </button>
      <div class="subagent-view-title">
        <p class="subagent-view-kicker">
          <span
            class="subagent-status-dot"
            :class="`is-${detail?.status ?? 'running'}`"
            aria-hidden="true"
          ></span>
          {{ detail ? subagentRoleLabel(detail.role) : 'Read-only helper' }}
          <template v-if="elapsed"> · {{ elapsed }}</template>
        </p>
        <h2>{{ detail?.label ?? 'Subagent' }}</h2>
        <p v-if="taskLine" class="subagent-view-task">{{ taskLine }}</p>
      </div>
      <span class="subagent-status-badge" :class="`is-${detail?.status ?? 'running'}`">
        {{ statusLabel }}
      </span>
    </header>

    <div class="subagent-view-body">
      <p v-if="loading" class="subagent-view-note">Loading the helper transcript…</p>
      <p v-else-if="error" class="subagent-view-error" role="alert">{{ error }}</p>
      <template v-else-if="detail">
        <p v-if="detail.status === 'running'" class="subagent-view-note is-live">
          <span class="subagent-live-dot" aria-hidden="true"></span>
          The helper is working. This view updates live and is read-only.
        </p>

        <ol v-if="timeline.length || detail.result" class="subagent-timeline">
          <li v-for="(entry, index) in timeline" :key="index">
            <article
              v-if="entry.type === 'message'"
              class="subagent-message"
              :class="entry.role === 'user' ? 'is-task' : 'is-helper'"
            >
              <p class="subagent-message-role">
                {{ entry.role === 'user' ? 'Task' : 'Helper' }}
              </p>
              <pre>{{ entry.text }}</pre>
            </article>
            <article
              v-else
              class="subagent-tool"
              :class="`is-${entry.status ?? 'started'}`"
            >
              <div class="subagent-tool-head">
                <span class="subagent-tool-name">{{ entry.tool }}</span>
                <span class="subagent-tool-status">{{ entry.status ?? 'started' }}</span>
              </div>
              <pre v-if="entry.args" class="subagent-tool-args">{{
                argsText(entry.args)
              }}</pre>
              <pre v-if="entry.result" class="subagent-tool-result">{{ entry.result }}</pre>
            </article>
          </li>
        </ol>

        <section v-if="detail.result" class="subagent-report">
          <h3>Final report</h3>
          <pre>{{ detail.result }}</pre>
        </section>

        <p v-if="detail.error" class="subagent-view-error" role="alert">
          {{ detail.error }}
        </p>

        <footer class="subagent-view-foot">
          <span>{{ subagentRoleLabel(detail.role) }} · {{ detail.model || 'unknown model' }}</span>
          <span v-if="tokens">{{ tokens }}</span>
          <span
            v-if="cachePct !== null && usage"
            :title="`cached ${usage.cached_tokens.toLocaleString('en-US')} of ${promptTokens.toLocaleString('en-US')} prompt tokens`"
          >
            cache {{ cachePct }}%
          </span>
          <span v-if="usage && usage.model_calls > 0">
            {{ usage.model_calls }} {{ usage.model_calls === 1 ? 'call' : 'calls' }}
          </span>
          <span v-if="detail.duration_ms !== undefined">
            {{ subagentDuration(detail.duration_ms) }}
          </span>
        </footer>
      </template>
    </div>
  </section>
</template>

<style scoped>
.subagent-view {
  position: absolute;
  inset: 0;
  z-index: 40;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--surface-canvas);
}

.subagent-view-head {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding: var(--space-4) var(--space-5);
  background: var(--surface-panel);
  border-bottom: 1px solid var(--border-subtle);
}

.subagent-back {
  flex: none;
  padding: var(--space-1) var(--space-2);
  font: inherit;
  font-size: 0.78rem;
  color: var(--text-secondary);
  background: transparent;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  cursor: pointer;
}

.subagent-back:hover {
  color: var(--text-primary);
  background: var(--surface-hover);
}

.subagent-back:focus-visible {
  outline: var(--focus-ring-width) solid var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
}

.subagent-view-title {
  flex: 1;
  min-width: 0;
}

.subagent-view-kicker {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  margin: 0;
  font-size: 0.72rem;
  color: var(--text-secondary);
}

.subagent-view-title h2 {
  margin: 0.1rem 0 0;
  font-size: 1.05rem;
  line-height: 1.3;
  overflow-wrap: anywhere;
}

.subagent-view-task {
  margin: 0.2rem 0 0;
  overflow: hidden;
  font-size: 0.76rem;
  color: var(--text-tertiary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.subagent-status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--text-tertiary);
}

.subagent-status-dot.is-running {
  background: var(--accent);
  animation: subagent-pulse 1.4s ease-in-out infinite;
}

.subagent-status-dot.is-completed {
  background: var(--ok);
}

.subagent-status-dot.is-failed {
  background: var(--danger);
}

.subagent-status-badge {
  flex: none;
  padding: 0.1rem 0.45rem;
  font-size: 0.7rem;
  color: var(--text-secondary);
  background: var(--surface-sunken);
  border-radius: var(--radius-pill);
}

.subagent-status-badge.is-running {
  color: var(--accent);
}

.subagent-status-badge.is-completed {
  color: var(--ok);
}

.subagent-status-badge.is-failed {
  color: var(--danger);
}

.subagent-view-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-4) var(--space-5) var(--space-7);
  max-width: 920px;
  width: 100%;
  margin: 0 auto;
}

.subagent-view-note {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: 0 0 var(--space-3);
  font-size: 0.78rem;
  color: var(--text-secondary);
}

.subagent-view-error {
  margin: 0 0 var(--space-3);
  padding: var(--space-2) var(--space-3);
  font-size: 0.8rem;
  color: var(--danger);
  background: var(--danger-soft);
  border-radius: var(--radius-sm);
}

.subagent-live-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  animation: subagent-pulse 1.4s ease-in-out infinite;
}

.subagent-timeline {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  margin: 0;
  padding: 0;
  list-style: none;
}

.subagent-message,
.subagent-tool,
.subagent-report {
  padding: var(--space-3);
  background: var(--surface-panel);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
}

.subagent-message.is-task {
  background: var(--surface-sunken);
}

.subagent-message-role,
.subagent-tool-name {
  margin: 0 0 var(--space-1);
  font-size: 0.7rem;
  font-weight: 600;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  color: var(--text-secondary);
}

.subagent-message pre,
.subagent-tool pre,
.subagent-report pre {
  margin: 0;
  overflow-wrap: anywhere;
  font: inherit;
  font-size: 0.82rem;
  line-height: 1.5;
  color: var(--text-primary);
  white-space: pre-wrap;
}

.subagent-tool-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  margin-bottom: var(--space-1);
}

.subagent-tool-head .subagent-tool-name {
  margin: 0;
  font-family: ui-monospace, monospace;
  text-transform: none;
  color: var(--text-primary);
}

.subagent-tool-status {
  flex: none;
  font-size: 0.68rem;
  color: var(--text-tertiary);
}

.subagent-tool.is-error .subagent-tool-status {
  color: var(--danger);
}

.subagent-tool.is-completed .subagent-tool-status {
  color: var(--ok);
}

.subagent-tool-args,
.subagent-tool-result {
  margin-top: var(--space-2) !important;
  padding-top: var(--space-2);
  font-size: 0.74rem !important;
  color: var(--text-secondary) !important;
  border-top: 1px dashed var(--border-subtle);
}

.subagent-report {
  margin-top: var(--space-4);
  border-color: var(--border-strong);
}

.subagent-report h3 {
  margin: 0 0 var(--space-2);
  font-size: 0.8rem;
  color: var(--text-primary);
}

.subagent-view-foot {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-top: var(--space-4);
  padding-top: var(--space-3);
  font-size: 0.72rem;
  color: var(--text-secondary);
  border-top: 1px solid var(--border-subtle);
}

@keyframes subagent-pulse {
  50% {
    opacity: 0.3;
  }
}

@media (prefers-reduced-motion: reduce) {
  .subagent-status-dot.is-running,
  .subagent-live-dot {
    animation: none;
  }
}

@media (max-width: 720px) {
  .subagent-view-head {
    padding: var(--space-3);
  }

  .subagent-view-body {
    padding: var(--space-3) var(--space-3) var(--space-6);
  }
}
</style>
