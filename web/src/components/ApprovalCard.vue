<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { NButton } from 'naive-ui'
import type { ApprovalItem } from '../runtime'
import type { ApprovalScope } from '../api'

const props = defineProps<{
  item: ApprovalItem
  /**
   * Returns true when the decision was accepted by the backend. The optional
   * scope asks for "allow for this session"; the App shell resolves the
   * applied scope and shows the honest notice when an older backend only
   * allowed once.
   */
  resolve: (
    runId: string,
    approvalId: string,
    allow: boolean,
    scope?: ApprovalScope,
  ) => Promise<boolean>
}>()

const answering = ref(false)
/** Failure of the decision request, surfaced on the card itself (G-19). */
const errorText = ref<string | null>(null)
const cardEl = ref<HTMLElement | null>(null)
const highlighted = ref(false)
let highlightTimer: number | undefined

const pending = computed(() => props.item.decision === undefined)

const allowed = computed(() => props.item.decision === 'allow')

/**
 * Pull the card into view when it starts waiting (G-1): the operator may have
 * scrolled up to read history, and nothing else would reveal the new request.
 */
async function reveal() {
  await nextTick()
  const el = cardEl.value
  if (!el) return
  el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  highlighted.value = true
  if (highlightTimer !== undefined) window.clearTimeout(highlightTimer)
  highlightTimer = window.setTimeout(() => {
    highlighted.value = false
  }, 1800)
}

watch(pending, (isPending, wasPending) => {
  if (isPending && !wasPending) reveal()
})

onMounted(() => {
  // a reload can land on a run that is already parked on this request
  if (pending.value) reveal()
})

onUnmounted(() => {
  if (highlightTimer !== undefined) window.clearTimeout(highlightTimer)
})

async function answer(allow: boolean, scope: ApprovalScope = 'once') {
  if (answering.value || !pending.value) return
  answering.value = true
  errorText.value = null
  try {
    const accepted = await props.resolve(props.item.runId, props.item.approvalId, allow, scope)
    if (!accepted) errorText.value = 'The decision was not accepted — try again.'
  } finally {
    answering.value = false
  }
}

/**
 * 'y' allows once, 'a' allows for the session, 'n' denies — scoped to the
 * focused card, so several pending approvals never race each other.
 */
function onKeydown(e: KeyboardEvent) {
  if (!pending.value || answering.value) return
  if (e.altKey || e.ctrlKey || e.metaKey) return
  const target = e.target as HTMLElement | null
  if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
  const key = e.key.toLowerCase()
  if (key === 'y') {
    e.preventDefault()
    answer(true)
  } else if (key === 'a') {
    e.preventDefault()
    answer(true, 'session')
  } else if (key === 'n') {
    e.preventDefault()
    answer(false)
  }
}
</script>

<template>
  <article
    ref="cardEl"
    class="approval"
    :class="{
      'approval-pending': pending,
      'approval-denied': !pending && !allowed,
      'approval-fresh': highlighted,
    }"
    :data-approval-id="item.approvalId"
    role="group"
    :aria-label="`Approval requested: ${item.action}${item.target ? ` ${item.target}` : ''}`"
    aria-keyshortcuts="y n a"
    tabindex="0"
    @keydown="onKeydown"
  >
    <header class="approval-header">
      <span class="approval-flag">Approval requested</span>
      <span v-if="pending" class="approval-status approval-waiting">awaiting you</span>
      <span v-else class="approval-status" :class="allowed ? 'approval-allowed' : 'approval-rejected'">
        {{ allowed ? 'allowed' : 'denied' }}
      </span>
    </header>

    <dl class="approval-body">
      <div class="approval-row">
        <dt>action</dt>
        <dd><code>{{ item.action }}</code></dd>
      </div>
      <div v-if="item.target" class="approval-row">
        <dt>target</dt>
        <dd><code>{{ item.target }}</code></dd>
      </div>
      <div v-if="item.command" class="approval-row">
        <dt>command</dt>
        <dd><code class="approval-command">{{ item.command }}</code></dd>
      </div>
    </dl>

    <p v-if="item.reason && pending" class="approval-reason muted">{{ item.reason }}</p>
    <p v-if="errorText" class="approval-error" role="alert">{{ errorText }}</p>

    <footer v-if="pending" class="approval-actions">
      <n-button
        type="primary"
        size="large"
        class="approval-btn"
        :disabled="answering"
        @click="answer(true)"
      >{{ answering ? 'Answering…' : 'Allow once' }}</n-button>
      <n-button
        type="error"
        size="large"
        class="approval-btn"
        :disabled="answering"
        @click="answer(false)"
      >Deny</n-button>
      <n-button
        size="large"
        class="approval-btn-session"
        :disabled="answering"
        title="Allow identical requests for the rest of this session (saved with the session's settings, removed with the session)"
        @click="answer(true, 'session')"
      >Always allow this session</n-button>
      <p class="approval-shortcut muted">
        Press <kbd>y</kbd> to allow once or <kbd>n</kbd> to deny while this card is
        focused. <kbd>a</kbd> allows this action for the rest of the session only — it is
        saved with the session's settings and removed when the session is deleted.
      </p>
    </footer>
    <p v-else-if="item.reason" class="approval-note muted">{{ item.reason }}</p>
  </article>
</template>

<style scoped>
.approval {
  border: 1px solid var(--border-subtle);
  border-left: 3px solid var(--accent);
  border-radius: var(--radius-md);
  background: var(--surface-highlight);
  padding: 0.55rem 0.8rem 0.7rem;
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
  font-size: 0.85rem;
  /* keeps scrollIntoView from pinning the card flush against the edge */
  scroll-margin-block: 1rem;
}

.approval:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.approval-fresh {
  animation: approval-flash 1.8s ease-out;
}

@keyframes approval-flash {
  0% {
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 55%, transparent);
  }
  35% {
    box-shadow: 0 0 0 5px color-mix(in srgb, var(--accent) 25%, transparent);
  }
  100% {
    box-shadow: 0 0 0 9px transparent;
  }
}

.approval-denied {
  border-left-color: var(--danger);
}

.approval-pending {
  border-left-color: var(--accent);
}

.approval-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.6rem;
}

.approval-flag {
  font-size: 0.72rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--accent);
}

.approval-status {
  font-size: 0.7rem;
  font-weight: 600;
  border-radius: 999px;
  padding: 0.1rem 0.55rem;
}

.approval-waiting {
  background: var(--accent-soft);
  color: var(--accent);
}

.approval-allowed {
  background: color-mix(in srgb, var(--ok) 15%, transparent);
  color: var(--ok);
}

.approval-rejected {
  background: var(--danger-soft);
  color: var(--danger);
}

.approval-body {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}

.approval-row {
  display: flex;
  gap: 0.6rem;
  font-size: 0.8rem;
}

.approval-row dt {
  color: var(--text-secondary);
  min-width: 4rem;
}

.approval-row dd {
  margin: 0;
  min-width: 0;
}

.approval-row code {
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  overflow-wrap: break-word;
}

.approval-command {
  white-space: pre-wrap;
}

.approval-reason,
.approval-note {
  margin: 0;
  font-size: 0.78rem;
}

.approval-error {
  margin: 0;
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--danger);
}

.approval-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.approval-btn {
  flex: 1 1 6rem;
  min-height: 2.5rem;
  font-weight: 600;
}

/*
 * The session-wide grant is its own full-width row, visually distinct from the
 * primary/error pair, and deliberately not `.approval-btn`: existing browser
 * flows select the allow/deny pair by that class.
 */
.approval-btn-session {
  flex: 1 1 100%;
  min-height: 2.5rem;
  font-weight: 600;
}

/* Phones: the allow/deny pair stays side by side below the session-wide row. */
@media (max-width: 480px) {
  .approval-btn {
    flex: 1 1 45%;
  }

  .approval-shortcut {
    flex-basis: 100%;
  }
}

.approval-shortcut {
  flex: 1 1 100%;
  margin: 0.1rem 0 0;
  font-size: 0.72rem;
}

.approval-shortcut kbd {
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 0.72rem;
  border: 1px solid var(--border-strong);
  border-radius: 4px;
  padding: 0 0.3rem;
  background: var(--surface-panel);
  color: var(--text-primary);
}

@media (prefers-reduced-motion: reduce) {
  .approval-fresh {
    animation: none;
  }
}
</style>