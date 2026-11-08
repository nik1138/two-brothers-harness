<script setup lang="ts">
/**
 * Plan/todo dock: the model-maintained plan of the followed session, docked
 * with the other composer docks (queue, approval). Purely presentational — the
 * projection (last write wins, tolerant payloads, bounded selection) lives in
 * `runtime.ts`; the state comes from `App.vue`'s selected-session event list.
 *
 * An older backend simply never emits `todo_updated`, so this dock never
 * renders there. Markers mirror the TUI dock: ✓ completed, ▸ in progress,
 * ○ pending. The collapsed list is bounded; a real expand button
 * (`aria-expanded`) reveals the complete plan. Updates are announced through a
 * polite live region, and the expanded state resets on a session switch so one
 * session's panel never leaks into another's.
 */
import { computed, ref, watch } from 'vue'
import type { TodoItem, TodoStatus } from '../types'
import {
  TODO_PANEL_COLLAPSED_ROWS,
  selectTodoRows,
  todoHiddenLabel,
  todoPlanSummary,
} from '../runtime'

const props = defineProps<{
  /** The selected session's current plan (latest `todo_updated` snapshot). */
  todos: TodoItem[]
  /** Selected session name; a switch resets local panel state. */
  session?: string | null
}>()

const expanded = ref(false)

/** Latest visible plan state; recomputed when a new snapshot replaces the list. */
const summary = computed(() => todoPlanSummary(props.todos))

/** The collapsed selection (bounded rows + hidden counts). */
const collapsed = computed(() => selectTodoRows(props.todos, TODO_PANEL_COLLAPSED_ROWS))

/** Whether the plan is longer than the collapsed bound. */
const canExpand = computed(() => props.todos.length > TODO_PANEL_COLLAPSED_ROWS)

/** Rows to render: everything when expanded, the bounded selection otherwise. */
const rows = computed(() => (expanded.value ? props.todos : collapsed.value.rows))

const hiddenLabel = computed(() => todoHiddenLabel(collapsed.value))

/** Header counts: truthful done/total and active work, nothing invented. */
const counts = computed(() => {
  const value = summary.value
  if (value.total === 0) return ''
  const active = value.inProgress > 0 ? ` · ${value.inProgress} in progress` : ''
  return `${value.completed}/${value.total} done${active}`
})

const MARKERS: Record<TodoStatus, string> = {
  completed: '✓',
  in_progress: '▸',
  pending: '○',
}

const STATUS_LABELS: Record<TodoStatus, string> = {
  completed: 'completed',
  in_progress: 'in progress',
  pending: 'pending',
}

function marker(status: TodoStatus): string {
  return MARKERS[status]
}

function statusLabel(status: TodoStatus): string {
  return STATUS_LABELS[status]
}

/** Polite announcement of a plan change (empty until the list actually changes). */
const announcement = ref('')

watch(
  () => props.todos,
  (todos, previous) => {
    // The first render is the load of the session's plan, not an update: no
    // redundant announcement. A session switch also loads, not updates.
    if (previous === undefined) return
    if (todos.length === 0) {
      announcement.value = 'Plan cleared.'
      return
    }
    const value = todoPlanSummary(todos)
    const current = value.current === null ? '' : `, now: ${value.current.content}`
    announcement.value = `Plan updated: ${value.completed} of ${value.total} done${current}.`
  },
)

watch(
  () => props.session,
  () => {
    // A session switch is not a plan update: reset the local panel state and
    // stay silent (the new session's plan arrives as a fresh prop).
    expanded.value = false
    announcement.value = ''
  },
)
</script>

<template>
  <!-- Always mounted with the session so the live region can announce the plan
       being cleared; the visual dock only renders while a plan exists. -->
  <p class="visually-hidden" role="status" aria-live="polite">{{ announcement }}</p>
  <section v-if="todos.length > 0" class="todo-panel" aria-label="Plan">
    <header class="todo-panel-header">
      <span class="todo-panel-title">Plan</span>
      <span class="todo-panel-counts">{{ counts }}</span>
      <button
        v-if="canExpand"
        type="button"
        class="todo-panel-expand"
        :aria-expanded="expanded ? 'true' : 'false'"
        :title="expanded ? 'Show the bounded plan summary' : 'Show the complete plan'"
        @click="expanded = !expanded"
      >
        {{ expanded ? 'Show less' : hiddenLabel }}
      </button>
    </header>
    <ul class="todo-panel-list">
      <li
        v-for="(todo, index) in rows"
        :key="`${index}-${todo.content}`"
        class="todo-panel-row"
        :class="`todo-panel-row-${todo.status}`"
      >
        <span class="todo-panel-marker" aria-hidden="true">{{ marker(todo.status) }}</span>
        <span class="visually-hidden">{{ statusLabel(todo.status) }}: </span>
        <span class="todo-panel-content">{{ todo.content }}</span>
      </li>
    </ul>
  </section>
</template>

<style scoped>
/* Same dock geometry as the queue/approval docks: pinned above the composer. */
.todo-panel {
  flex: 0 0 auto;
  width: calc(100% - 2.5rem);
  max-width: var(--composer-max-width);
  margin: 0.35rem auto 0;
  padding: 0.45rem 0.65rem 0.5rem;
  background: var(--surface-panel);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
}

.todo-panel-header {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  margin-bottom: 0.3rem;
}

.todo-panel-title {
  font-size: 0.72rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-secondary);
}

.todo-panel-counts {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 0.72rem;
  font-variant-numeric: tabular-nums;
  color: var(--text-secondary);
}

.todo-panel-expand {
  flex: none;
  padding: 0 0.15rem;
  font: inherit;
  font-size: 0.72rem;
  font-weight: 600;
  color: var(--accent-text);
  background: transparent;
  border: 0;
  cursor: pointer;
}

.todo-panel-expand:hover {
  text-decoration: underline;
}

.todo-panel-expand:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 1px;
  border-radius: var(--radius-sm);
}

.todo-panel-list {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  max-height: 12rem;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;
}

.todo-panel-row {
  display: flex;
  align-items: baseline;
  gap: 0.4rem;
  min-width: 0;
  font-size: 0.78rem;
}

.todo-panel-marker {
  flex: none;
  width: 1rem;
  text-align: center;
  font-weight: 700;
}

.todo-panel-row-completed .todo-panel-marker {
  color: var(--ok);
}

.todo-panel-row-in_progress .todo-panel-marker {
  color: var(--accent-text);
}

.todo-panel-row-pending .todo-panel-marker {
  color: var(--text-secondary);
}

.todo-panel-content {
  flex: 1 1 auto;
  min-width: 0;
  color: var(--text-primary);
  overflow-wrap: break-word;
}

.todo-panel-row-completed .todo-panel-content {
  color: var(--text-secondary);
  text-decoration: line-through;
}

.todo-panel-row-in_progress .todo-panel-content {
  font-weight: 600;
}
</style>
