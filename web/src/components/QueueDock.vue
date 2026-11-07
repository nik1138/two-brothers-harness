<script setup lang="ts">
/**
 * Queue dock: the queued runs waiting behind the current run of the selected
 * session. Purely presentational — the FIFO projection, bounds and honest
 * counts come from `queueState.ts`, the state and stop calls from `App.vue`.
 *
 * Never called "steering": a queued run is a submission the backend will run
 * only after the one before it finishes. No mid-turn injection exists.
 */
import { computed } from 'vue'
import type { QueuedRunRow } from '../queueState'

const props = defineProps<{
  /** Waiting rows behind the current run, FIFO, already bounded by the projection. */
  rows: QueuedRunRow[]
  /** Waiting runs that did not fit the bound (rendered as an honest tail count). */
  hidden: number
  /** Run ids with a cancel request in flight (rows stay keyboard-reachable). */
  stopping?: Record<string, boolean>
}>()

const emit = defineEmits<{ stop: [runId: string] }>()

/** Visible + hidden waiting runs; the summary states the true total. */
const total = computed(() => props.rows.length + Math.max(0, props.hidden || 0))

/**
 * Visible queue summary. Announcements live in a persistent shell live region
 * (App.vue), so inserting this dock does not double-announce.
 */
const summary = computed(() => {
  const count = total.value
  const noun = count === 1 ? 'task queued' : 'tasks queued'
  const verb = count === 1 ? 'it starts' : 'they start'
  return `${count} ${noun} — ${verb} automatically, in order, after the current run finishes.`
})

/** Local wall-clock time of the submission; '' when the record has none. */
function queuedAt(created: number): string {
  if (!Number.isFinite(created) || created <= 0) return ''
  return new Date(created * 1000).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function isoTime(created: number): string | undefined {
  if (!Number.isFinite(created) || created <= 0) return undefined
  return new Date(created * 1000).toISOString()
}

function isStopping(row: QueuedRunRow): boolean {
  return props.stopping?.[row.run_id] === true
}

function onStop(row: QueuedRunRow): void {
  if (isStopping(row)) return
  emit('stop', row.run_id)
}
</script>

<template>
  <section class="queue-dock" aria-label="Queued runs">
    <p class="queue-dock-summary">{{ summary }}</p>
    <ul class="queue-dock-list">
      <li v-for="row in rows" :key="row.run_id" class="queue-row">
        <span class="queue-position" aria-hidden="true">#{{ row.position }}</span>
        <span class="visually-hidden">Position {{ row.position }} in the queue.</span>
        <span class="queue-task" :title="row.task">{{ row.task || 'Untitled task' }}</span>
        <time
          v-if="queuedAt(row.created)"
          class="queue-time"
          :datetime="isoTime(row.created)"
        >
          <span class="visually-hidden">queued at </span>{{ queuedAt(row.created) }}
        </time>
        <button
          type="button"
          class="queue-stop"
          :data-queued-run="row.run_id"
          :aria-label="`Stop queued task #${row.position}: ${row.task || 'untitled task'}`"
          :aria-disabled="isStopping(row) ? 'true' : undefined"
          @click="onStop(row)"
        >
          {{ isStopping(row) ? 'Stopping…' : 'Stop' }}
        </button>
      </li>
    </ul>
    <p v-if="hidden > 0" class="queue-more">
      +{{ hidden }} more {{ hidden === 1 ? 'task' : 'tasks' }} queued (not shown).
    </p>
  </section>
</template>

<style scoped>
/* Same dock geometry as the approval dock above it: pinned above the composer
   so the queue is visible at any transcript position. */
.queue-dock {
  flex: 0 0 auto;
  width: calc(100% - 2.5rem);
  max-width: var(--composer-max-width);
  margin: 0.35rem auto 0;
  padding: 0.45rem 0.65rem 0.5rem;
  background: var(--surface-panel);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
}

.queue-dock-summary {
  margin: 0 0 0.35rem;
  font-size: 0.78rem;
  line-height: 1.35;
  color: var(--text-secondary);
}

.queue-dock-list {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  margin: 0;
  padding: 0;
  list-style: none;
}

.queue-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-width: 0;
  font-size: 0.78rem;
}

.queue-position {
  flex: none;
  min-width: 1.9rem;
  font-variant-numeric: tabular-nums;
  font-weight: 700;
  color: var(--text-secondary);
}

.queue-task {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--text-primary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.queue-time {
  flex: none;
  font-size: 0.72rem;
  font-variant-numeric: tabular-nums;
  color: var(--text-secondary);
}

.queue-stop {
  flex: none;
  height: 22px;
  padding: 0 0.5rem;
  font: inherit;
  font-size: 0.72rem;
  font-weight: 600;
  color: var(--danger);
  background: transparent;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  cursor: pointer;
}

.queue-stop:hover {
  background: var(--danger-soft);
  border-color: var(--danger);
}

.queue-stop:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 1px;
}

.queue-stop[aria-disabled='true'] {
  cursor: default;
  opacity: 0.55;
}

.queue-more {
  margin: 0.3rem 0 0;
  font-size: 0.72rem;
  color: var(--text-secondary);
}

/* Narrow screens: the task snippet keeps the row; the clock is secondary. */
@media (max-width: 640px) {
  .queue-time {
    display: none;
  }
}
</style>
