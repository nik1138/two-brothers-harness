<script setup lang="ts">
import { computed, nextTick, onMounted, ref, useId } from 'vue'
import { NButton, NInput, NModal } from 'naive-ui'
import type { InputInst } from 'naive-ui'
import { ApiError, addWorkspace } from '../api'
import { clickInModalBody } from '../modal'
import WorkspaceFinder from './WorkspaceFinder.vue'
import type { Workspace } from '../types'

/**
 * New-session dialog with an inline workspace finder. Existing workspaces are
 * listed for choice; "Add folder" swaps the SAME modal to the finder step, so
 * adding a workspace never stacks a second dialog. Keep the public contract
 * (`close`, `create`) unchanged.
 */

const props = defineProps<{
  workspaces: Workspace[]
  /** Pre-selected workspace id (the current sidebar filter), if any. */
  defaultWorkspace: string | null
}>()

const emit = defineEmits<{
  close: []
  create: [payload: { title: string; workspace_id: string | null }]
  /** A workspace was added from inside this flow (optional app hook). */
  'workspace-created': [workspace: Workspace]
}>()

function onMaskClick(e: MouseEvent) {
  if (clickInModalBody(e)) return
  if (adding.value) return
  emit('close')
}

const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '')
const titleId = `new-session-title-${uid}`
const workspaceLabelId = `new-session-workspace-${uid}`
const radioName = `new-session-workspace-${uid}`

const title = ref('')
const workspaceId = ref<string>(props.defaultWorkspace ?? '')
const step = ref<'choose' | 'add'>('choose')
const adding = ref(false)
const addError = ref<string | null>(null)
/** Workspaces created from this dialog; merged with the prop list by id. */
const addedWorkspaces = ref<Workspace[]>([])

const dialogEl = ref<HTMLElement | null>(null)
const titleInput = ref<InputInst | null>(null)

const allWorkspaces = computed(() => {
  const known = new Set(props.workspaces.map((w) => w.id))
  return [...props.workspaces, ...addedWorkspaces.value.filter((w) => !known.has(w.id))]
})

function errText(e: unknown): string {
  return e instanceof ApiError ? e.message : String(e)
}

/** Park focus on the selected workspace row, else the add action. */
function focusChoice(): void {
  void nextTick(() => {
    const root = dialogEl.value
    if (!root) return
    const target =
      root.querySelector<HTMLElement>('input[type="radio"]:checked') ??
      root.querySelector<HTMLElement>('[data-focus-target="add-folder"]')
    target?.focus()
  })
}

function startAdd(): void {
  if (adding.value) return
  addError.value = null
  step.value = 'add'
}

function backToChoose(): void {
  if (adding.value) return
  addError.value = null
  step.value = 'choose'
  focusChoice()
}

async function onAddWorkspace(payload: { path: string; name: string }): Promise<void> {
  if (adding.value) return
  adding.value = true
  addError.value = null
  try {
    const workspace = await addWorkspace({
      path: payload.path,
      name: payload.name || undefined,
    })
    addedWorkspaces.value = [...addedWorkspaces.value, workspace]
    workspaceId.value = workspace.id
    step.value = 'choose'
    emit('workspace-created', workspace)
    focusChoice()
  } catch (e) {
    addError.value = errText(e)
  } finally {
    adding.value = false
  }
}

function submit(): void {
  emit('create', {
    title: title.value.trim(),
    workspace_id: workspaceId.value || null,
  })
}

function onEsc(): void {
  if (step.value === 'add') {
    if (adding.value) return
    backToChoose()
    return
  }
  emit('close')
}

onMounted(() => {
  void nextTick(() => titleInput.value?.focus())
})
</script>

<template>
  <n-modal
    :show="true"
    :auto-focus="false"
    :close-on-esc="false"
    @mask-click="onMaskClick"
  >
    <div
      ref="dialogEl"
      class="modal new-session-dialog"
      :class="{ 'is-add': step === 'add' }"
      role="dialog"
      aria-modal="true"
      aria-label="New session"
      @keydown.esc.stop="onEsc"
    >
      <header class="ns-header">
        <h2>{{ step === 'add' ? 'Add workspace' : 'New session' }}</h2>
        <p v-if="step === 'add'" class="ns-sub">
          Pick the project folder to add. Escape returns to session details.
        </p>
      </header>

      <template v-if="step === 'choose'">
        <div class="ns-body">
          <label class="ns-field-label" :for="titleId">
            Title <span>(optional)</span>
          </label>
          <n-input
            ref="titleInput"
            v-model:value="title"
            :input-props="{ id: titleId }"
            placeholder="Derived from your first task if empty"
            @keydown.enter.prevent="submit"
          />

          <div class="ns-workspace-head">
            <span :id="workspaceLabelId" class="ns-field-label">Workspace</span>
            <n-button
              size="tiny"
              attr-type="button"
              data-focus-target="add-folder"
              @click="startAdd"
            >
              <template #icon>
                <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                  <path
                    d="M8 3.5v9M3.5 8h9"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.4"
                    stroke-linecap="round"
                  />
                </svg>
              </template>
              Add folder…
            </n-button>
          </div>

          <div class="ns-workspaces" role="radiogroup" :aria-labelledby="workspaceLabelId">
            <label class="ns-ws" :class="{ 'is-selected': workspaceId === '' }">
              <input
                v-model="workspaceId"
                class="ns-radio"
                type="radio"
                :name="radioName"
                value=""
              />
              <span class="ns-radio-dot" aria-hidden="true" />
              <span class="ns-ws-text">
                <span class="ns-ws-name">No workspace</span>
                <span class="ns-ws-path">Keep this session unattached</span>
              </span>
            </label>
            <label
              v-for="workspace in allWorkspaces"
              :key="workspace.id"
              class="ns-ws"
              :class="{ 'is-selected': workspaceId === workspace.id }"
            >
              <input
                v-model="workspaceId"
                class="ns-radio"
                type="radio"
                :name="radioName"
                :value="workspace.id"
              />
              <span class="ns-radio-dot" aria-hidden="true" />
              <span class="ns-ws-text">
                <span class="ns-ws-name">{{ workspace.name }}</span>
                <span class="ns-ws-path" :title="workspace.path">{{ workspace.path }}</span>
              </span>
            </label>
          </div>
          <p v-if="!allWorkspaces.length" class="field-hint ns-empty">
            No workspaces yet — add a project folder to group sessions by directory.
          </p>
          <p class="field-hint">Send a task below to start the conversation.</p>
        </div>

        <div class="ns-actions">
          <span class="ns-hint">Esc closes</span>
          <n-button attr-type="button" @click="emit('close')">Cancel</n-button>
          <n-button attr-type="button" type="primary" @click="submit">Create</n-button>
        </div>
      </template>

      <template v-else>
        <WorkspaceFinder
          label="Add a workspace folder"
          confirm-label="Add workspace"
          busy-label="Adding…"
          cancel-label="Back"
          :initial-path="allWorkspaces.find((w) => w.id === workspaceId)?.path ?? ''"
          :busy="adding"
          :server-error="addError"
          @confirm="onAddWorkspace"
          @cancel="backToChoose"
        />
      </template>
    </div>
  </n-modal>
</template>

<style scoped>
.new-session-dialog {
  width: min(38rem, calc(100vw - 1.5rem));
  max-width: 38rem;
}

.new-session-dialog.is-add {
  width: min(42.5rem, calc(100vw - 1.5rem));
  max-width: 42.5rem;
  height: min(31.25rem, calc(100dvh - 1.5rem));
  max-height: calc(100dvh - 1.5rem);
}

.ns-header {
  display: flex;
  flex: none;
  flex-direction: column;
  gap: 0.2rem;
  margin-bottom: 0.75rem;
}

.ns-header h2 {
  margin: 0;
}

.ns-sub {
  margin: 0;
  color: var(--text-secondary);
  font-size: 0.78rem;
}

.ns-body {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 0.4rem;
  min-height: 0;
  overflow-y: auto;
}

.ns-field-label {
  color: var(--text-secondary);
  font-size: 0.78rem;
  font-weight: 500;
}

.ns-field-label span {
  opacity: 0.8;
}

.ns-workspace-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  margin-top: 0.55rem;
}

.ns-workspaces {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  max-height: 12rem;
  padding: 0.15rem;
  overflow-y: auto;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
}

.ns-ws {
  position: relative;
  display: flex;
  align-items: center;
  gap: 0.55rem;
  min-width: 0;
  padding: 0.4rem 0.5rem;
  border-radius: var(--radius-sm);
  cursor: pointer;
}

.ns-ws:hover {
  background: var(--surface-hover);
}

.ns-ws.is-selected {
  background: var(--accent-soft);
}

.ns-ws:has(.ns-radio:focus-visible) {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}

/* Kept in the accessibility tree and the tab order; only painted away. */
.ns-radio {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: 0;
  opacity: 0;
  pointer-events: none;
}

.ns-radio-dot {
  display: grid;
  flex: none;
  place-items: center;
  width: 0.9rem;
  height: 0.9rem;
  border: 1.5px solid var(--border-strong);
  border-radius: 50%;
}

.ns-ws.is-selected .ns-radio-dot {
  border-color: var(--accent);
}

.ns-ws.is-selected .ns-radio-dot::after {
  content: '';
  width: 0.45rem;
  height: 0.45rem;
  border-radius: 50%;
  background: var(--accent);
}

.ns-ws-text {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 0.05rem;
  min-width: 0;
}

.ns-ws-name {
  overflow: hidden;
  font-size: 0.85rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ns-ws-path {
  overflow: hidden;
  color: var(--text-secondary);
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 0.72rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ns-empty {
  margin: 0.1rem 0 0;
}

.ns-actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: 0.5rem;
  margin-top: 1rem;
}

.ns-hint {
  margin-right: auto;
  color: var(--text-secondary);
  font-size: 0.72rem;
}

@media (max-width: 480px) {
  .new-session-dialog {
    width: calc(100vw - 1rem);
  }

  .ns-hint {
    display: none;
  }
}
</style>
