<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { NButton } from 'naive-ui'
import type { ApprovalItem } from '../runtime'
import { QUESTION_FALLBACK_NOTE } from '../question'

/**
 * Structured operator question (the additive `kind: "question"` approval
 * event). It parks the run exactly like an approval; this card is the
 * actionable surface. Answering posts the additive `decision: "answer"` body
 * on the same approvals route; "Decline" posts the regular deny decision.
 *
 * Interaction contract (single, unambiguous): single-select options answer
 * immediately on click; multi-select options are checkboxes confirmed by one
 * Confirm button (disabled until at least one is picked).
 */
const props = defineProps<{
  item: ApprovalItem
  /** The approval deny path: decline maps to it, like the approval card's Deny. */
  resolve: (runId: string, approvalId: string, allow: boolean) => Promise<boolean>
  /** Post a structured answer (the picked option labels) for this question. */
  answer: (runId: string, approvalId: string, labels: string[]) => Promise<boolean>
}>()

const answering = ref(false)
/** Failure of the answer/decline request, surfaced on the card itself. */
const errorText = ref<string | null>(null)
const cardEl = ref<HTMLElement | null>(null)
const highlighted = ref(false)
let highlightTimer: number | undefined

/** Labels picked in multi-select mode (single-select answers immediately). */
const picked = ref<string[]>([])

const pending = computed(() => props.item.decision === undefined)
const declined = computed(() => props.item.decision === 'deny')
const multi = computed(() => props.item.question?.multi_select === true)
const broken = computed(() => props.item.questionError === true)

function togglePicked(label: string, on: boolean) {
  picked.value = on ? [...new Set([...picked.value, label])] : picked.value.filter((l) => l !== label)
}

async function post(op: () => Promise<boolean>) {
  if (answering.value || !pending.value) return
  answering.value = true
  errorText.value = null
  try {
    const accepted = await op()
    if (!accepted) errorText.value = 'The answer was not accepted — try again.'
  } finally {
    answering.value = false
  }
}

/** Single-select: click is the answer. Multi-select: Confirm posts the picks. */
function answerWith(labels: string[]) {
  void post(() => props.answer(props.item.runId, props.item.approvalId, labels))
}

function confirmPicks() {
  if (picked.value.length === 0) return
  answerWith([...picked.value])
}

/** Decline rides the approval deny path (the core maps it to "operator declined"). */
function decline() {
  void post(() => props.resolve(props.item.runId, props.item.approvalId, false))
}

async function reveal() {
  await nextTick()
  const el = cardEl.value
  if (!el) return
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  el.scrollIntoView({ block: 'nearest', behavior: reduceMotion ? 'auto' : 'smooth' })
  highlighted.value = true
  if (highlightTimer !== undefined) window.clearTimeout(highlightTimer)
  highlightTimer = window.setTimeout(() => {
    highlighted.value = false
  }, 1800)
}

watch(pending, (isPending, wasPending) => {
  if (isPending && !wasPending) reveal()
  if (!isPending) picked.value = []
})

watch(
  () => props.item.approvalId,
  () => {
    picked.value = []
  },
)

onMounted(() => {
  // a reload can land on a run that is already parked on this question
  if (pending.value) reveal()
})

onUnmounted(() => {
  if (highlightTimer !== undefined) window.clearTimeout(highlightTimer)
})

/**
 * Arrow keys move between the option controls scoped to this card; Enter/Space
 * activate the focused control natively (a click for single-select, the
 * checkbox toggle for multi-select).
 */
function onKeydown(e: KeyboardEvent) {
  if (!pending.value || answering.value) return
  if (e.altKey || e.ctrlKey || e.metaKey) return
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
  const controls = Array.from(
    cardEl.value?.querySelectorAll<HTMLElement>('.question-option') ?? [],
  )
  if (controls.length === 0) return
  e.preventDefault()
  const current = controls.indexOf(document.activeElement as HTMLElement)
  const next =
    e.key === 'ArrowDown'
      ? current < 0
        ? 0
        : (current + 1) % controls.length
      : current < 0
        ? controls.length - 1
        : (current - 1 + controls.length) % controls.length
  controls[next]?.focus()
}
</script>

<template>
  <article
    ref="cardEl"
    class="question"
    :class="{
      'question-pending': pending,
      'question-declined': !pending && declined,
      'question-fresh': highlighted,
    }"
    :data-approval-id="item.approvalId"
    role="group"
    :aria-label="`Question from the run${item.question?.header ? `: ${item.question.header}` : ''}`"
    tabindex="0"
    @keydown="onKeydown"
  >
    <header class="question-header">
      <span class="question-flag">{{ item.question?.header ?? 'Question' }}</span>
      <span v-if="pending" class="question-status question-waiting">awaiting you</span>
      <span v-else class="question-status" :class="declined ? 'question-rejected' : 'question-answered'">
        {{ declined ? 'declined' : 'answered' }}
      </span>
    </header>

    <!-- Broken payload: the generic approval surface plus a bounded error note. -->
    <template v-if="broken">
      <dl class="question-body">
        <div v-if="item.action" class="question-row">
          <dt>action</dt>
          <dd><code>{{ item.action }}</code></dd>
        </div>
        <div v-if="item.target" class="question-row">
          <dt>target</dt>
          <dd><code>{{ item.target }}</code></dd>
        </div>
        <div v-if="item.command" class="question-row">
          <dt>command</dt>
          <dd><code class="question-command">{{ item.command }}</code></dd>
        </div>
      </dl>
      <p v-if="item.reason" class="question-reason muted">{{ item.reason }}</p>
      <p class="question-error" role="alert">{{ QUESTION_FALLBACK_NOTE }}</p>
      <footer v-if="pending" class="question-actions">
        <n-button
          type="error"
          size="large"
          class="question-btn"
          :disabled="answering"
          @click="decline"
        >Decline</n-button>
      </footer>
    </template>

    <template v-else-if="item.question">
      <p class="question-text">{{ item.question.text }}</p>
      <p v-if="item.reason && pending" class="question-reason muted">{{ item.reason }}</p>

      <div v-if="pending" class="question-options" :class="{ 'question-options-multi': multi }">
        <template v-for="option in item.question.options" :key="`${multi ? 'multi' : 'single'}:${option.label}`">
          <!-- Single-select: the option button IS the answer (click posts immediately). -->
          <button
            v-if="!multi"
            type="button"
            class="question-option question-option-single"
            :disabled="answering"
            @click="answerWith([option.label])"
          >
            <span class="question-option-label">{{ option.label }}</span>
            <span v-if="option.description" class="question-option-description muted">{{ option.description }}</span>
            <code
              v-if="option.intent"
              class="question-option-intent"
              title="Machine-readable tag for this option"
            >{{ option.intent }}</code>
          </button>
          <!-- Multi-select: checkboxes, one Confirm button for the picks. -->
          <label v-else class="question-option question-option-multi">
            <input
              type="checkbox"
              class="question-option-check"
              :checked="picked.includes(option.label)"
              :disabled="answering"
              @change="togglePicked(option.label, ($event.target as HTMLInputElement).checked)"
            />
            <span class="question-option-label">{{ option.label }}</span>
            <span v-if="option.description" class="question-option-description muted">{{ option.description }}</span>
            <code
              v-if="option.intent"
              class="question-option-intent"
              title="Machine-readable tag for this option"
            >{{ option.intent }}</code>
          </label>
        </template>
      </div>

      <p v-if="errorText" class="question-error" role="alert">{{ errorText }}</p>

      <footer v-if="pending" class="question-actions">
        <n-button
          v-if="multi"
          type="primary"
          size="large"
          class="question-btn"
          :disabled="answering || picked.length === 0"
          @click="confirmPicks"
        >{{ answering ? 'Answering…' : `Answer${picked.length ? ` (${picked.length})` : ''}` }}</n-button>
        <n-button
          type="error"
          size="large"
          class="question-btn"
          :disabled="answering"
          @click="decline"
        >Decline</n-button>
        <p class="question-shortcut muted">
          <kbd>↑</kbd>/<kbd>↓</kbd> move between options, <kbd>Enter</kbd> picks one.
          Decline lets the run continue without an answer.
        </p>
      </footer>
    </template>
  </article>
</template>

<style scoped>
.question {
  border: 1px solid var(--border-subtle);
  border-left: 3px solid var(--accent);
  border-radius: var(--radius-md);
  background: var(--surface-highlight);
  padding: 0.55rem 0.8rem 0.7rem;
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
  font-size: 0.85rem;
  scroll-margin-block: var(--space-4);
}

.question:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.question-fresh {
  animation: question-flash 1.8s ease-out;
}

@keyframes question-flash {
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

.question-declined {
  border-left-color: var(--danger);
}

.question-pending {
  border-left-color: var(--accent);
}

.question-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.6rem;
}

.question-flag {
  font-size: 0.72rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--accent-text);
  overflow-wrap: break-word;
}

.question-status {
  flex: none;
  font-size: 0.7rem;
  font-weight: 600;
  border-radius: var(--radius-pill);
  padding: 0.1rem 0.55rem;
}

.question-waiting {
  background: var(--accent-soft);
  color: var(--accent-text);
}

.question-answered {
  background: color-mix(in srgb, var(--ok) 15%, transparent);
  color: var(--ok);
}

.question-rejected {
  background: var(--danger-soft);
  color: var(--danger);
}

.question-body {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}

.question-row {
  display: flex;
  gap: 0.6rem;
  font-size: 0.8rem;
}

.question-row dt {
  color: var(--text-secondary);
  min-width: 4rem;
}

.question-row dd {
  margin: 0;
  min-width: 0;
}

.question-row code {
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  overflow-wrap: break-word;
}

.question-command {
  white-space: pre-wrap;
}

.question-text {
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: break-word;
}

.question-reason {
  margin: 0;
  font-size: 0.78rem;
}

.question-error {
  margin: 0;
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--danger);
}

.question-options {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  min-width: 0;
}

.question-option {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.35rem 0.5rem;
  width: 100%;
  padding: 0.4rem 0.55rem;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--surface-panel);
  color: var(--text-primary);
  font: inherit;
  font-size: 0.82rem;
  text-align: left;
  cursor: pointer;
}

.question-option-single:hover {
  border-color: var(--accent);
}

.question-option:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

.question-option:disabled {
  opacity: 0.6;
  cursor: default;
}

.question-option-check {
  flex: none;
  align-self: center;
  margin: 0;
}

.question-option-label {
  font-weight: 600;
  overflow-wrap: break-word;
}

.question-option-description {
  flex: 1 1 100%;
  font-size: 0.76rem;
  overflow-wrap: break-word;
}

.question-option-intent {
  flex: none;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 0.7rem;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-xs);
  padding: 0 0.3rem;
  color: var(--text-secondary);
  overflow-wrap: break-word;
}

.question-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.question-btn {
  flex: 1 1 6rem;
  min-height: 2.5rem;
  font-weight: 600;
}

.question-shortcut {
  flex: 1 1 100%;
  margin: 0.1rem 0 0;
  font-size: 0.72rem;
}

.question-shortcut kbd {
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 0.72rem;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-xs);
  padding: 0 0.3rem;
  background: var(--surface-panel);
  color: var(--text-primary);
}

@media (prefers-reduced-motion: reduce) {
  .question-fresh {
    animation: none;
  }
}
</style>
