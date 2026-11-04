<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue'
import { NButton, NScrollbar, useMessage } from 'naive-ui'
import { relativeTime, sessionTitle } from '../chat'
import { ApiError, deleteSession, renameSession } from '../api'
import type { SessionInfo, Workspace } from '../types'

const props = defineProps<{
  sessions: SessionInfo[]
  workspaces: Workspace[]
  /** 'all' or a workspace id. */
  workspaceFilter: string
  selected: string | null
  /** Session currently streaming a run, if any. */
  live: string | null
  /** All sessions with a live run (parallel runs); takes precedence over `live` when set. */
  liveSessions?: string[]
}>()

const emit = defineEmits<{
  select: [name: string]
  refresh: []
  collapse: []
  addWorkspace: []
  newSession: []
  filterWorkspace: [value: string]
  /** A session was deleted; the parent clears its selection if it was active. */
  deleted: [name: string]
}>()

const message = useMessage()

/** Client-side title filter (case-insensitive substring; empty shows everything). */
const query = ref('')
/** Session currently being renamed (inline editor), if any. */
const editing = ref<string | null>(null)
const renameDraft = ref('')
/** Session with a pending delete confirmation, if any. */
const confirmDelete = ref<string | null>(null)
/** Session whose rename/delete request is in flight, if any. */
const busy = ref<string | null>(null)
let confirmTimer: ReturnType<typeof setTimeout> | null = null

function titleOf(s: SessionInfo): string {
  return s.title || sessionTitle(s.name)
}

function isLive(name: string): boolean {
  return props.liveSessions ? props.liveSessions.includes(name) : props.live === name
}

const searching = computed(() => query.value.trim() !== '')

const filteredSessions = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return props.sessions
  return props.sessions.filter((s) => titleOf(s).toLowerCase().includes(q))
})

const filteredWorkspaceName = computed(() => {
  if (props.workspaceFilter === 'all') return null
  return props.workspaces.find((w) => w.id === props.workspaceFilter)?.name ?? 'this workspace'
})

const emptyTitle = computed(() =>
  filteredWorkspaceName.value ? `No sessions in ${filteredWorkspaceName.value}` : 'Start your first run',
)

interface SessionGroup {
  key: string
  label: string
  items: SessionInfo[]
}

/**
 * Groups for the list: by workspace under the "All" filter, a single flat
 * group otherwise (the group label is then not rendered).
 */
const displayGroups = computed<SessionGroup[]>(() => {
  if (props.workspaceFilter !== 'all') {
    return [{ key: '', label: '', items: filteredSessions.value }]
  }
  const out: SessionGroup[] = []
  const byKey = new Map<string, SessionGroup>()
  for (const s of filteredSessions.value) {
    const key = s.workspace_id ?? ''
    let group = byKey.get(key)
    if (!group) {
      const ws = key ? props.workspaces.find((w) => w.id === key) : undefined
      group = { key, label: ws ? ws.name : 'Unassigned', items: [] }
      byKey.set(key, group)
      out.push(group)
    }
    group.items.push(s)
  }
  return out
})

// -- search ------------------------------------------------------------------

function clearSearch() {
  query.value = ''
}

// -- session management (rename / delete) ------------------------------------

function errText(e: unknown): string {
  return e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e)
}

function startRename(s: SessionInfo) {
  editing.value = s.name
  renameDraft.value = titleOf(s)
}

async function commitRename(s: SessionInfo) {
  const title = renameDraft.value.trim()
  if (!title) {
    editing.value = null
    return
  }
  if (title === titleOf(s)) {
    editing.value = null
    return
  }
  if (busy.value) return
  busy.value = s.name
  try {
    await renameSession(s.name, title)
    editing.value = null
    emit('refresh')
  } catch (e) {
    message.error(`Rename failed: ${errText(e)}`)
  } finally {
    busy.value = null
  }
}

function askDelete(name: string) {
  confirmDelete.value = name
  if (confirmTimer) clearTimeout(confirmTimer)
  confirmTimer = setTimeout(() => {
    confirmDelete.value = null
    confirmTimer = null
  }, 3000)
}

function cancelDelete() {
  if (confirmTimer) {
    clearTimeout(confirmTimer)
    confirmTimer = null
  }
  confirmDelete.value = null
}

async function doDelete(s: SessionInfo) {
  cancelDelete()
  if (busy.value) return
  busy.value = s.name
  try {
    await deleteSession(s.name)
    emit('deleted', s.name)
  } catch (e) {
    message.error(`Delete failed: ${errText(e)}`)
  } finally {
    busy.value = null
  }
}

onUnmounted(() => {
  if (confirmTimer) clearTimeout(confirmTimer)
})
</script>

<template>
  <nav class="sidebar" aria-label="Sessions">
    <div class="sidebar-header">
      <h2>Sessions</h2>
      <div class="sidebar-actions">
        <n-button
          circle
          quaternary
          size="small"
          class="icon-btn"
          title="New session"
          aria-label="New session"
          @click="emit('newSession')"
        >
          <span aria-hidden="true">✎</span>
        </n-button>
        <n-button
          circle
          quaternary
          size="small"
          class="icon-btn"
          title="Add workspace"
          aria-label="Add workspace"
          @click="emit('addWorkspace')"
        >
          <span aria-hidden="true">＋</span>
        </n-button>
        <n-button
          circle
          quaternary
          size="small"
          class="icon-btn"
          title="Refresh session list"
          aria-label="Refresh session list"
          @click="emit('refresh')"
        >
          <span aria-hidden="true">↻</span>
        </n-button>
        <n-button
          circle
          quaternary
          size="small"
          class="icon-btn"
          title="Collapse sidebar"
          aria-label="Collapse sidebar"
          @click="emit('collapse')"
        >
          <span aria-hidden="true">⇤</span>
        </n-button>
      </div>
    </div>

    <label class="control workspace-filter">
      <span class="control-label">workspace</span>
      <select
        :value="workspaceFilter"
        title="Filter sessions by workspace"
        @change="emit('filterWorkspace', ($event.target as HTMLSelectElement).value)"
      >
        <option value="all">All workspaces</option>
        <option v-for="w in workspaces" :key="w.id" :value="w.id">{{ w.name }}</option>
      </select>
    </label>

    <div class="session-search">
      <input
        v-model="query"
        type="search"
        class="session-search-input"
        aria-label="Search sessions"
        placeholder="Search sessions…"
        @keydown.esc="clearSearch"
      />
      <button
        v-if="searching"
        type="button"
        class="session-search-clear"
        title="Clear search"
        aria-label="Clear session search"
        @click="clearSearch"
      >
        <span aria-hidden="true">✕</span>
      </button>
    </div>
    <p v-if="searching && filteredSessions.length" class="session-search-count muted">
      {{ filteredSessions.length }} of {{ sessions.length }} sessions
    </p>

    <n-scrollbar class="sidebar-scroll">
      <div v-if="sessions.length === 0" class="empty-state">
        <p class="empty-state-title">{{ emptyTitle }}</p>
        <p class="empty-hint empty-state-hint">
          Describe a task in the composer below
          <span class="empty-state-arrow" aria-hidden="true">↓</span>
        </p>
        <div class="empty-state-actions">
          <n-button size="small" type="primary" @click="emit('newSession')">New session</n-button>
          <n-button
            v-if="workspaceFilter !== 'all'"
            size="small"
            tertiary
            @click="emit('filterWorkspace', 'all')"
          >
            Show all workspaces
          </n-button>
          <n-button
            v-else-if="workspaces.length === 0"
            size="small"
            tertiary
            @click="emit('addWorkspace')"
          >
            Add workspace
          </n-button>
        </div>
      </div>
      <div v-else-if="filteredSessions.length === 0" class="empty-state">
        <p class="empty-state-title">No sessions match “{{ query.trim() }}”</p>
        <div class="empty-state-actions">
          <n-button size="small" tertiary @click="clearSearch">Clear search</n-button>
        </div>
      </div>

      <template v-else>
        <section v-for="g in displayGroups" :key="g.key || 'unassigned'">
          <h3 v-if="workspaceFilter === 'all'" class="session-group-label">
            {{ g.label }}
            <span class="session-group-count" :aria-label="`${g.items.length} sessions`">
              {{ g.items.length }}
            </span>
          </h3>
          <ul class="session-list">
            <li v-for="s in g.items" :key="s.name" class="session-row">
              <form
                v-if="editing === s.name"
                class="session-rename"
                @submit.prevent="commitRename(s)"
              >
                <input
                  v-model="renameDraft"
                  class="session-rename-input"
                  :aria-label="`Rename ${titleOf(s)}`"
                  autofocus
                  @focus="($event.target as HTMLInputElement).select()"
                  @keydown.esc.prevent="editing = null"
                />
                <button
                  type="submit"
                  class="icon-btn"
                  title="Save title"
                  aria-label="Save session title"
                  :disabled="busy === s.name"
                >
                  <span aria-hidden="true">✓</span>
                </button>
                <button
                  type="button"
                  class="icon-btn"
                  title="Cancel rename"
                  aria-label="Cancel rename"
                  @click="editing = null"
                >
                  <span aria-hidden="true">✕</span>
                </button>
              </form>
              <template v-else>
                <button
                  class="session-item"
                  :class="{ active: s.name === selected }"
                  :aria-current="s.name === selected ? 'true' : undefined"
                  @click="emit('select', s.name)"
                >
                  <span class="session-title">{{ titleOf(s) }}</span>
                  <span class="session-meta">
                    <span v-if="isLive(s.name)" class="live-dot" aria-label="live"></span>
                    <span class="muted">{{ relativeTime(s.mtime) }}</span>
                  </span>
                </button>
                <!-- Sibling of the row button (never nested in it), so row clicks
                     can't be swallowed; the wrapper also stops propagation. -->
                <span class="session-actions" @click.stop>
                  <button
                    type="button"
                    class="icon-btn row-action"
                    title="Rename session"
                    aria-label="Rename session"
                    :disabled="busy === s.name"
                    @click="startRename(s)"
                  >
                    <span aria-hidden="true">✏</span>
                  </button>
                  <button
                    v-if="confirmDelete !== s.name"
                    type="button"
                    class="icon-btn row-action"
                    title="Delete session"
                    aria-label="Delete session"
                    :disabled="busy === s.name"
                    @click="askDelete(s.name)"
                  >
                    <span aria-hidden="true">🗑</span>
                  </button>
                  <button
                    v-else
                    type="button"
                    class="row-action row-action-confirm"
                    aria-label="Confirm delete session"
                    :disabled="busy === s.name"
                    @click="doDelete(s)"
                  >
                    {{ busy === s.name ? '…' : 'sure?' }}
                  </button>
                </span>
              </template>
            </li>
          </ul>
        </section>
      </template>
    </n-scrollbar>
  </nav>
</template>

<style scoped>
/* The list scrolls inside n-scrollbar; the nav itself must not scroll or the
   two scrollbar systems would overlap. */
.sidebar {
  overflow-y: hidden;
  padding-bottom: 0;
}

.sidebar-scroll {
  flex: 1;
  min-height: 0;
}

.session-search {
  position: relative;
  padding: 0 0.25rem 0.6rem;
}

.session-search-input {
  width: 100%;
  padding: 0.35rem 1.9rem 0.35rem 0.55rem;
  font: inherit;
  font-size: 0.85rem;
  color: var(--text-primary);
  background: var(--surface-panel);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
}

.session-search-input:focus {
  outline: none;
  border-color: var(--accent);
}

/* The wrapper's own clear button replaces the native search affordance. */
.session-search-input::-webkit-search-cancel-button {
  -webkit-appearance: none;
  appearance: none;
}

.session-search-clear {
  position: absolute;
  top: calc(50% - 0.3rem);
  right: 0.55rem;
  transform: translateY(-50%);
  display: grid;
  place-items: center;
  width: 1.4rem;
  height: 1.4rem;
  padding: 0;
  font-size: 0.75rem;
  color: var(--text-secondary);
  background: transparent;
  border: none;
  border-radius: 50%;
  cursor: pointer;
}

.session-search-clear:hover {
  color: var(--text-primary);
  background: var(--surface-hover);
}

.session-search-count {
  margin: -0.35rem 0.25rem 0.45rem;
  font-size: 0.72rem;
}

.session-group-count {
  display: inline-block;
  min-width: 1.25rem;
  margin-left: 0.35rem;
  padding: 0 0.3rem;
  font-size: 0.68rem;
  font-weight: 500;
  line-height: 1.3;
  text-align: center;
  color: var(--text-secondary);
  background: var(--surface-hover);
  border-radius: 999px;
}

/* Empty list: a real call to action instead of inert text. */
.empty-state {
  padding: 0.9rem 0.4rem 0.6rem;
  text-align: center;
}

.empty-state-title {
  margin: 0 0 0.3rem;
  font-size: 0.92rem;
  font-weight: 600;
  color: var(--text-primary);
}

.empty-state-hint {
  margin: 0 0 0.7rem;
}

.empty-state-arrow {
  display: inline-block;
  margin-left: 0.15rem;
  animation: empty-arrow-nudge 1.8s ease-in-out infinite;
}

.empty-state-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 0.4rem;
}

@keyframes empty-arrow-nudge {
  0%,
  100% {
    transform: translateY(0);
  }
  50% {
    transform: translateY(0.22rem);
  }
}

@media (prefers-reduced-motion: reduce) {
  .empty-state-arrow {
    animation: none;
  }
}

/* Row = main button + action buttons as siblings, so the actions never
   overlap the row click target (E2E clicks .session-item to select). */
.session-row {
  display: flex;
  align-items: stretch;
  gap: 0.1rem;
}

.session-row .session-item {
  width: auto;
  flex: 1;
  min-width: 0;
}

.session-actions {
  display: flex;
  align-items: center;
  gap: 0.05rem;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.12s ease;
}

.session-row:hover .session-actions,
.session-row:focus-within .session-actions {
  opacity: 1;
  pointer-events: auto;
}

/* Touch devices have no hover: keep the row actions permanently reachable
   and give them a comfortable tap target. */
@media (hover: none) {
  .session-actions {
    opacity: 1;
    pointer-events: auto;
  }

  .row-action {
    min-width: 2.5rem;
    min-height: 2.5rem;
  }
}

.row-action {
  flex: 0 0 auto;
  font-size: 0.8rem;
}

.row-action:disabled {
  cursor: progress;
  opacity: 0.55;
}

.row-action-confirm {
  border: 1px solid var(--danger);
  border-radius: var(--radius-sm);
  background: var(--danger-soft);
  color: var(--danger);
  font-size: 0.75rem;
  padding: 0 0.45rem;
  cursor: pointer;
  white-space: nowrap;
}

.session-rename {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 0.15rem;
  padding: 0.15rem 0;
}

.session-rename-input {
  flex: 1;
  min-width: 0;
  padding: 0.4rem 0.55rem;
  font: inherit;
  font-size: 0.88rem;
  color: var(--text-primary);
  background: var(--surface-panel);
  border: 1px solid var(--accent);
  border-radius: var(--radius-md);
}

.session-rename-input:focus {
  outline: none;
}
</style>