<script setup lang="ts">
import { computed, ref } from 'vue'
import { NButton } from 'naive-ui'
import type { RunUsage, SubagentDetail } from '../types'
import {
  subagentBackgroundLabel,
  subagentDuration,
  subagentElapsed,
  subagentMessageLabel,
  subagentRoleLabel,
  subagentStatusLabel,
  subagentTaskPreview,
  subagentTokenLabel,
} from '../subagents'
import {
  SUBAGENT_CONTROLS_UNSUPPORTED_NOTICE,
  canSendSubagentFollowUp,
  isMissingSubagentControlRoute,
  markSubagentControlsUnavailable,
  subagentControlsUnavailable,
  subagentFollowUpNotice,
  subagentInterruptNotice,
} from '../subagentControls'
import { ApiError, interruptSubagent, sendSubagentMessage } from '../api'
import { cacheHitPercent, promptTokensOf } from '../usageCache'

const props = defineProps<{
  detail: SubagentDetail | null
  loading: boolean
  error: string
}>()

const emit = defineEmits<{ back: [] }>()

const statusLabel = computed(() => subagentStatusLabel(props.detail?.status ?? 'running'))
/** Slice B: the Senior did not wait for this helper (opt-in background spawn). */
const backgroundLabel = computed(() => subagentBackgroundLabel(props.detail))
const elapsed = computed(() =>
  props.detail ? subagentElapsed(props.detail.started_at, props.detail.ended_at) : '',
)
const tokens = computed(() => subagentTokenLabel(props.detail?.usage))
const cachePct = computed(() => cacheHitPercent(props.detail?.usage))
const promptTokens = computed(() => promptTokensOf(props.detail?.usage))
const taskLine = computed(() => subagentTaskPreview(props.detail?.task ?? '', 180))
const usage = computed<RunUsage | null>(() => props.detail?.usage ?? null)

/** Local request state for the drawer-only Stop control (the SSE event is the truth). */
const stopping = ref(false)
const stopNotice = ref('')
const stopError = ref('')
/** Latched off after a 404: an old backend has no helper controls. */
const controlsUnavailable = ref(subagentControlsUnavailable())
const canStop = computed(
  () => props.detail?.status === 'running' && !controlsUnavailable.value,
)

/** Drawer follow-up state (A2): queued text, local in-flight/feedback only. */
const followUpDraft = ref('')
const sendingFollowUp = ref(false)
const followUpNotice = ref('')
const followUpError = ref('')
const canFollowUp = computed(
  () =>
    !controlsUnavailable.value &&
    canSendSubagentFollowUp(props.detail?.status ?? 'running') &&
    props.detail !== null,
)
const followUpReady = computed(() => followUpDraft.value.trim() !== '')

/** Stop only this helper; the parent run keeps going. */
async function stopHelper() {
  const detail = props.detail
  if (detail === null || stopping.value || !canStop.value) return
  stopping.value = true
  stopNotice.value = ''
  stopError.value = ''
  try {
    const result = await interruptSubagent(detail.id)
    stopNotice.value = subagentInterruptNotice(result.status) ?? ''
  } catch (exc) {
    if (exc instanceof ApiError && isMissingSubagentControlRoute(exc.status)) {
      markSubagentControlsUnavailable()
      controlsUnavailable.value = true
      stopError.value = SUBAGENT_CONTROLS_UNSUPPORTED_NOTICE
    } else {
      stopError.value = exc instanceof Error ? exc.message : String(exc)
    }
  } finally {
    stopping.value = false
  }
}

/**
 * Queue one follow-up for this helper's next step. The response says `queued`
 * (never delivered); nothing here claims the helper read it. A 404 is an old
 * backend and latches the whole control family off; 400/409 details (too long,
 * finished, queue full, context full) stay inline.
 */
async function sendFollowUp() {
  const detail = props.detail
  if (detail === null || sendingFollowUp.value || !canFollowUp.value) return
  const text = followUpDraft.value.trim()
  if (text === '') return
  sendingFollowUp.value = true
  followUpNotice.value = ''
  followUpError.value = ''
  try {
    const result = await sendSubagentMessage(detail.id, text)
    followUpDraft.value = ''
    followUpNotice.value = subagentFollowUpNotice(result.pending)
  } catch (exc) {
    if (exc instanceof ApiError && isMissingSubagentControlRoute(exc.status)) {
      markSubagentControlsUnavailable()
      controlsUnavailable.value = true
      followUpError.value = SUBAGENT_CONTROLS_UNSUPPORTED_NOTICE
    } else {
      followUpError.value = exc instanceof Error ? exc.message : String(exc)
    }
  } finally {
    sendingFollowUp.value = false
  }
}

/** Enter sends; Shift+Enter inserts a newline (IME composition stays untouched). */
function onFollowUpKeydown(event: KeyboardEvent) {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
  event.preventDefault()
  void sendFollowUp()
}

/**
 * The drawer never closes under a non-empty follow-up draft: `App.vue` asks
 * this before handling Escape (design §7.1). Exposed, not a prop, because the
 * draft is drawer-local.
 */
function hasFollowUpDraft(): boolean {
  return followUpDraft.value.trim() !== ''
}

defineExpose({ hasFollowUpDraft })

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
          {{ detail ? subagentRoleLabel(detail.role) : 'Helper' }}
          <template v-if="elapsed"> · {{ elapsed }}</template>
        </p>
        <h2>{{ detail?.label ?? 'Subagent' }}</h2>
        <p v-if="taskLine" class="subagent-view-task">{{ taskLine }}</p>
      </div>
      <span class="subagent-status-badge" :class="`is-${detail?.status ?? 'running'}`">
        {{ statusLabel }}
      </span>
      <!-- Background helper (slice B): the parent continued without waiting for
           this report. Hidden for a sync child and on an old backend. -->
      <span v-if="backgroundLabel" class="subagent-background-badge">
        {{ backgroundLabel }}
      </span>
      <!-- Drawer-only operator control: tree rows stay plain buttons (no nested
           interactive elements), and the backend 404 on an old server hides it. -->
      <div v-if="canStop" class="subagent-view-actions">
        <NButton
          size="small"
          quaternary
          :disabled="stopping"
          aria-label="Stop this helper"
          @click="stopHelper"
        >
          {{ stopping ? 'Stopping…' : 'Stop helper' }}
        </NButton>
      </div>
    </header>

    <div class="subagent-view-body">
      <p v-if="stopError" class="subagent-view-error" role="alert">{{ stopError }}</p>
      <p v-else-if="stopNotice" class="subagent-view-note is-control" role="status">
        {{ stopNotice }}
      </p>
      <p v-if="loading" class="subagent-view-note">Loading the helper transcript…</p>
      <p v-else-if="error" class="subagent-view-error" role="alert">{{ error }}</p>
      <template v-else-if="detail">
        <p v-if="detail.status === 'running'" class="subagent-view-note is-live">
          <span class="subagent-live-dot" aria-hidden="true"></span>
          The helper is working. This view updates live and is isolated from the parent transcript.
        </p>

        <ol v-if="timeline.length || detail.result" class="subagent-timeline">
          <li v-for="(entry, index) in timeline" :key="index">
            <article
              v-if="entry.type === 'message'"
              class="subagent-message"
              :class="entry.role === 'user' ? 'is-task' : 'is-helper'"
            >
              <p class="subagent-message-role">
                {{ subagentMessageLabel(entry) }}
              </p>
              <pre>{{ entry.text }}</pre>
            </article>
            <article
              v-else-if="entry.type === 'tool'"
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
            <article
              v-else-if="entry.type === 'approval'"
              class="subagent-approval"
              :class="`is-${entry.status}`"
            >
              <div class="subagent-approval-head">
                <span class="subagent-approval-label">Approval · {{ entry.action }}</span>
                <span class="subagent-approval-status">{{ entry.status }}</span>
              </div>
              <p v-if="entry.target" class="subagent-approval-target">
                <code>{{ entry.target }}</code>
              </p>
              <pre v-if="entry.command" class="subagent-approval-command">{{
                entry.command
              }}</pre>
              <p v-if="entry.reason" class="subagent-approval-reason">{{ entry.reason }}</p>
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

        <!-- Drawer-only follow-up (A2): queued for the helper's next step, never
             written into the brothers' transcript. Hidden once the helper
             settled; enabled while it is parked on an approval (the whole
             point), disabled only while a local request is in flight. -->
        <form v-if="canFollowUp" class="subagent-follow-up" @submit.prevent="sendFollowUp">
          <label class="subagent-follow-up-label" for="subagent-follow-up-text">
            Follow-up
          </label>
          <textarea
            id="subagent-follow-up-text"
            v-model="followUpDraft"
            class="subagent-follow-up-input"
            rows="1"
            placeholder="Message this helper — queued for its next step"
            aria-label="Follow-up message"
            :disabled="sendingFollowUp"
            @keydown="onFollowUpKeydown"
          ></textarea>
          <NButton
            size="small"
            type="primary"
            attr-type="submit"
            :disabled="sendingFollowUp || !followUpReady"
          >
            {{ sendingFollowUp ? 'Sending…' : 'Send' }}
          </NButton>
        </form>
        <p v-if="followUpNotice" class="subagent-view-note is-control" role="status">
          {{ followUpNotice }}
        </p>
        <p v-if="followUpError" class="subagent-view-error" role="alert">
          {{ followUpError }}
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

.subagent-view-actions {
  flex: none;
  display: flex;
  align-items: center;
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

/* Background helper (slice B): a quiet marker, never a second status. */
.subagent-background-badge {
  flex: none;
  padding: 0.1rem 0.45rem;
  font-size: 0.7rem;
  color: var(--text-secondary);
  background: var(--surface-sunken);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-pill);
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

/* Local feedback for the drawer's Stop control (cleared by the live event). */
.subagent-view-note.is-control {
  color: var(--accent);
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

/* Drawer follow-up composer: one line by default, never a nested tree control. */
.subagent-follow-up {
  display: flex;
  align-items: flex-end;
  gap: var(--space-2);
  margin-top: var(--space-4);
  padding: var(--space-3);
  background: var(--surface-panel);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
}

.subagent-follow-up-label {
  flex: none;
  padding-bottom: 0.45rem;
  font-size: 0.7rem;
  font-weight: 600;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  color: var(--text-secondary);
}

.subagent-follow-up-input {
  flex: 1;
  min-width: 0;
  max-height: 9rem;
  padding: 0.45rem 0.6rem;
  font: inherit;
  font-size: 0.84rem;
  line-height: 1.4;
  color: var(--text-primary);
  background: var(--surface-sunken);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  resize: vertical;
}

.subagent-follow-up-input:focus-visible {
  outline: var(--focus-ring-width) solid var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
}

.subagent-follow-up-input:disabled {
  opacity: 0.6;
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
.subagent-approval,
.subagent-report {
  padding: var(--space-3);
  background: var(--surface-panel);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
}

/* One child approval row: status, action, target and (for shell) the exact
   command. Plain text only — never v-html. */
.subagent-approval {
  border-left: 3px solid var(--accent);
}

.subagent-approval.is-allowed {
  border-left-color: var(--ok);
}

.subagent-approval.is-denied,
.subagent-approval.is-cancelled {
  border-left-color: var(--danger);
}

.subagent-approval-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  margin-bottom: var(--space-1);
}

.subagent-approval-label {
  font-size: 0.7rem;
  font-weight: 600;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  color: var(--text-secondary);
}

.subagent-approval-status {
  flex: none;
  font-size: 0.68rem;
  color: var(--text-tertiary);
}

.subagent-approval.is-allowed .subagent-approval-status {
  color: var(--ok);
}

.subagent-approval.is-denied .subagent-approval-status,
.subagent-approval.is-cancelled .subagent-approval-status {
  color: var(--danger);
}

.subagent-approval-target,
.subagent-approval-reason {
  margin: 0;
  overflow-wrap: anywhere;
  font-size: 0.76rem;
  color: var(--text-secondary);
}

.subagent-approval-target code,
.subagent-approval-command {
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
}

.subagent-approval-command {
  margin: var(--space-1) 0 0;
  overflow-wrap: anywhere;
  font-size: 0.74rem;
  color: var(--text-primary);
  white-space: pre-wrap;
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
