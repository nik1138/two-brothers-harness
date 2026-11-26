<script setup lang="ts">
import { computed, useId } from 'vue'
import { NButton } from 'naive-ui'
import { SELECT_WORKSPACE_MESSAGE, SELECT_WORKSPACE_NOTE } from '../workspaceContext'
import type { Workspace } from '../types'

/**
 * In-place "select a workspace to start" state for the composer area.
 *
 * It renders where the composer sits (never a dialog), names the backend's
 * literal no-workspace rule, and offers the registered workspaces plus the
 * existing add-workspace finder. Picking a workspace emits immediately: for an
 * existing session the shell binds it through `PATCH /api/sessions/{name}`; on
 * the start screen the pick is the workspace the first run will carry.
 *
 * The composer keeps the submit disabled while this state is up (the shell
 * passes `workspaceRequired`), so the request is preempted instead of relying
 * on the backend's 400.
 */

const props = defineProps<{
  /** Existing unlinked session (bind) or the not-yet-created session (pick). */
  context: 'session' | 'start'
  /** Registered workspaces, in sidebar order. */
  workspaces: Workspace[]
  /** The operator's current pick; kept visible while binding / after an error. */
  selectedId?: string | null
  /** A bind request is in flight for this pick. */
  busy?: boolean
  /** One bounded error from the last bind attempt (the pick is never cleared). */
  error?: string | null
}>()

const emit = defineEmits<{
  select: [workspaceId: string]
  addWorkspace: []
}>()

const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '')
const titleId = `workspace-start-title-${uid}`
const copyId = `workspace-start-copy-${uid}`
const errorId = `workspace-start-error-${uid}`
const radioName = `workspace-start-workspace-${uid}`

const copy = computed(() =>
  props.context === 'session'
    ? 'This session has no workspace. Pick a project folder to bind before sending — ' +
      `a run needs one ("${SELECT_WORKSPACE_MESSAGE}").`
    : 'Pick a project folder before sending — ' +
      `a run needs a workspace ("${SELECT_WORKSPACE_MESSAGE}").`,
)

const addLabel = computed(() =>
  props.workspaces.length ? 'Add another workspace…' : 'Add a workspace…',
)

function choose(workspace: Workspace): void {
  if (props.busy) return
  emit('select', workspace.id)
}
</script>

<template>
  <section
    class="workspace-start"
    data-workspace-start
    role="region"
    :aria-labelledby="titleId"
    :aria-describedby="copyId"
  >
    <div class="workspace-start-head">
      <p :id="titleId" class="workspace-start-title">{{ SELECT_WORKSPACE_NOTE }}</p>
      <p :id="copyId" class="workspace-start-copy">{{ copy }}</p>
    </div>

    <div
      v-if="workspaces.length"
      class="workspace-start-list"
      role="radiogroup"
      :aria-labelledby="titleId"
    >
      <label
        v-for="workspace in workspaces"
        :key="workspace.id"
        class="workspace-start-option"
        :class="{ 'is-selected': selectedId === workspace.id }"
        @click="choose(workspace)"
      >
        <input
          class="workspace-start-radio"
          type="radio"
          :name="radioName"
          :value="workspace.id"
          :checked="selectedId === workspace.id"
          :disabled="busy"
          @change="choose(workspace)"
        />
        <span class="workspace-start-dot" aria-hidden="true" />
        <span class="workspace-start-text">
          <span class="workspace-start-name">{{ workspace.name }}</span>
          <span class="workspace-start-path" :title="workspace.path">{{ workspace.path }}</span>
        </span>
      </label>
    </div>
    <p v-else class="workspace-start-empty">
      No workspaces yet — add a project folder to start.
    </p>

    <p v-if="error" :id="errorId" class="workspace-start-error" role="alert">{{ error }}</p>

    <div class="workspace-start-actions">
      <n-button size="small" attr-type="button" data-workspace-add @click="emit('addWorkspace')">
        {{ addLabel }}
      </n-button>
      <n-button
        v-if="error && selectedId"
        size="small"
        attr-type="button"
        data-workspace-retry
        :disabled="busy"
        @click="emit('select', selectedId as string)"
      >
        Try again
      </n-button>
      <span v-if="busy" class="workspace-start-busy" role="status">Binding…</span>
    </div>
  </section>
</template>

<style scoped>
.workspace-start {
  width: 100%;
  max-width: var(--composer-max-width, 880px);
  margin: 0 auto 0.5rem;
  padding: 0 var(--space-5);
}

.workspace-start-head {
  padding: 0 0.15rem;
}

.workspace-start-title {
  margin: 0;
  color: var(--text-primary);
  font-size: 0.82rem;
  font-weight: 600;
}

.workspace-start-copy {
  margin: 0.15rem 0 0.45rem;
  color: var(--text-secondary);
  font-size: 0.74rem;
  line-height: 1.45;
}

.workspace-start-list {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  max-height: 10rem;
  padding: 0.2rem;
  overflow-y: auto;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--surface-panel);
}

.workspace-start-option {
  position: relative;
  display: flex;
  align-items: center;
  gap: 0.55rem;
  min-width: 0;
  padding: 0.4rem 0.5rem;
  border-radius: var(--radius-sm);
  cursor: pointer;
}

.workspace-start-option:hover {
  background: var(--surface-hover);
}

.workspace-start-option.is-selected {
  background: var(--accent-soft);
}

.workspace-start-option:has(.workspace-start-radio:focus-visible) {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}

/* Kept in the accessibility tree and the tab order; only painted away. */
.workspace-start-radio {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: 0;
  opacity: 0;
  pointer-events: none;
}

.workspace-start-dot {
  display: grid;
  flex: none;
  place-items: center;
  width: 0.9rem;
  height: 0.9rem;
  border: 1.5px solid var(--border-strong);
  border-radius: 50%;
}

.workspace-start-option.is-selected .workspace-start-dot {
  border-color: var(--accent);
}

.workspace-start-option.is-selected .workspace-start-dot::after {
  content: '';
  width: 0.45rem;
  height: 0.45rem;
  border-radius: 50%;
  background: var(--accent);
}

.workspace-start-text {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 0.05rem;
  min-width: 0;
}

.workspace-start-name {
  overflow: hidden;
  color: var(--text-primary);
  font-size: 0.82rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.workspace-start-path {
  overflow: hidden;
  color: var(--text-secondary);
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 0.7rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.workspace-start-empty {
  margin: 0;
  padding: 0.45rem 0.55rem;
  color: var(--text-secondary);
  font-size: 0.76rem;
  border: 1px dashed var(--border-subtle);
  border-radius: var(--radius-md);
}

.workspace-start-error {
  margin: 0.35rem 0 0;
  color: var(--danger);
  font-size: 0.74rem;
  line-height: 1.4;
  overflow-wrap: anywhere;
}

.workspace-start-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  margin-top: 0.45rem;
}

.workspace-start-busy {
  color: var(--text-secondary);
  font-size: 0.72rem;
}

@media (max-width: 640px) {
  .workspace-start {
    padding: 0 var(--space-4);
  }
}
</style>
