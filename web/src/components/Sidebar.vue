<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { NScrollbar } from 'naive-ui'
import { sessionTitle } from '../chat'
import type { SessionStatusView } from '../sessionStatus'
import type { ThemeMode } from '../themeMode'
import type { SessionInfo, Workspace } from '../types'
import { dropReorderDelta, orderedWorkspaces } from '../workspaceOrder'
import AppIcon from './AppIcon.vue'
import SessionGroup from './SessionGroup.vue'
import SidebarFooter from './SidebarFooter.vue'

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
  /** Derived per-session row status, keyed by session name (App owns the derivation). */
  statuses?: Record<string, SessionStatusView>
  /** Selected theme preference shown by the footer's three-way selector. */
  themeMode: ThemeMode
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
  /** A session was forked; the parent refreshes the list and opens the new one. */
  forked: [name: string]
  /** Footer: open the settings dialog. */
  openSettings: []
  /** Footer: the user picked a theme preference. */
  themeChange: [mode: ThemeMode]
  /** Group header menu: rename this workspace (the shell owns the dialog). */
  renameWorkspace: [workspace: Workspace]
  /** Group header menu: move this workspace by `delta` slots (-1/+1). */
  moveWorkspace: [id: string, delta: number]
}>()

/** Sessions rendered per group before "Show N more". */
const PREVIEW_LIMIT = 5

/** Client-side title filter (case-insensitive substring; empty shows everything). */
const query = ref('')
const searchOpen = ref(false)
const searchInput = ref<HTMLInputElement | null>(null)
const searchButton = ref<HTMLButtonElement | null>(null)

/** Collapsed workspace groups, keyed by workspace id ('' = Unassigned). */
const collapsedGroups = ref<Record<string, boolean>>({})
/** Groups whose preview window was expanded with "Show N more". */
const expandedGroups = ref<Record<string, boolean>>({})

function titleOf(s: SessionInfo): string {
  return s.title || sessionTitle(s.name)
}

const liveNames = computed(() =>
  props.liveSessions ?? (props.live ? [props.live] : []),
)

/** Compact legend for the row dots; `read` intentionally has none. */
const STATUS_LEGEND = [
  { label: 'live', tone: 'ok', title: 'A run is working in this session.' },
  { label: 'waiting', tone: 'warning', title: 'The run is paused until you allow or deny.' },
  { label: 'failed', tone: 'danger', title: 'The last run in this session failed.' },
  { label: 'new', tone: 'accent', title: 'A run finished since you last opened the session.' },
] as const

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

interface DisplayGroup {
  key: string
  label: string
  unassigned: boolean
  items: SessionInfo[]
}

/** Defensive, ordered view of the registered workspaces (persisted order). */
const orderedWorkspaceList = computed(() => orderedWorkspaces(props.workspaces))
const workspaceIndexById = computed(() => {
  const index = new Map<string, number>()
  orderedWorkspaceList.value.forEach((workspace, i) => index.set(workspace.id, i))
  return index
})

/**
 * Groups for the list: by workspace under the "All" filter, in the persisted
 * workspace order. Registered workspaces render even before their first session
 * (so rename/reorder stay reachable and the visible order is the real order);
 * links to workspaces the backend no longer lists keep an "Unknown workspace"
 * group, and Unassigned stays last.
 */
const displayGroups = computed<DisplayGroup[]>(() => {
  if (props.workspaceFilter !== 'all') {
    return [{ key: props.workspaceFilter, label: '', unassigned: false, items: filteredSessions.value }]
  }
  const sessionsByKey = new Map<string, SessionInfo[]>()
  for (const s of filteredSessions.value) {
    const key = s.workspace_id ?? ''
    const list = sessionsByKey.get(key)
    if (list) list.push(s)
    else sessionsByKey.set(key, [s])
  }
  const out: DisplayGroup[] = []
  for (const workspace of orderedWorkspaceList.value) {
    out.push({
      key: workspace.id,
      label: workspace.name,
      unassigned: false,
      items: sessionsByKey.get(workspace.id) ?? [],
    })
    sessionsByKey.delete(workspace.id)
  }
  for (const [key, items] of sessionsByKey) {
    if (!key) continue
    out.push({ key, label: 'Unknown workspace', unassigned: false, items })
  }
  const unassigned = sessionsByKey.get('')
  if (unassigned?.length) {
    out.push({ key: '', label: 'Unassigned', unassigned: true, items: unassigned })
  }
  return out
})

/** Folder headers only make sense in the unfiltered, non-search list. */
const showGroupHeaders = computed(() => props.workspaceFilter === 'all' && !searching.value)

interface GroupView extends DisplayGroup {
  listId: string
  collapsible: boolean
  collapsed: boolean
  expanded: boolean
  shownItems: SessionInfo[]
  total: number
  hiddenCount: number
  showLess: boolean
  /** Registered workspace target for the header actions menu, when any. */
  workspaceId?: string
  canMoveUp: boolean
  canMoveDown: boolean
}

/** Search results stay flat: one unlabelled group with every match. */
const groupViews = computed<GroupView[]>(() => {
  if (searching.value) {
    const items = filteredSessions.value
    return [
      {
        key: 'search',
        label: '',
        unassigned: false,
        items,
        listId: 'session-search-results',
        collapsible: false,
        collapsed: false,
        expanded: false,
        shownItems: items,
        total: items.length,
        hiddenCount: 0,
        showLess: false,
        canMoveUp: false,
        canMoveDown: false,
      },
    ]
  }
  return displayGroups.value.map((g, i) => {
    const collapsible = showGroupHeaders.value
    const collapsed = collapsible && !!collapsedGroups.value[g.key]
    const expanded = !!expandedGroups.value[g.key]
    const shownItems = collapsed ? [] : expanded ? g.items : g.items.slice(0, PREVIEW_LIMIT)
    const workspaceIndex = g.unassigned ? -1 : (workspaceIndexById.value.get(g.key) ?? -1)
    return {
      ...g,
      listId: `session-list-${i}`,
      collapsible,
      collapsed,
      expanded,
      shownItems,
      total: g.items.length,
      hiddenCount: collapsed ? 0 : g.items.length - shownItems.length,
      showLess: !collapsed && expanded && g.items.length > PREVIEW_LIMIT,
      workspaceId: workspaceIndex >= 0 ? g.key : undefined,
      canMoveUp: workspaceIndex > 0,
      canMoveDown:
        workspaceIndex >= 0 && workspaceIndex < orderedWorkspaceList.value.length - 1,
    }
  })
})

// -- search --------------------------------------------------------------------

function openSearch() {
  searchOpen.value = true
  nextTick(() => searchInput.value?.focus())
}

/** Leave the search panel and put focus back on the Search action. */
function closeSearch() {
  query.value = ''
  searchOpen.value = false
  nextTick(() => searchButton.value?.focus())
}

function onSearchEscape() {
  if (query.value) query.value = ''
  else closeSearch()
}

function clearSearch() {
  query.value = ''
  searchInput.value?.focus()
}

// -- groups --------------------------------------------------------------------

function toggleGroup(key: string) {
  collapsedGroups.value = { ...collapsedGroups.value, [key]: !collapsedGroups.value[key] }
}

function toggleExpand(key: string) {
  expandedGroups.value = { ...expandedGroups.value, [key]: !expandedGroups.value[key] }
}

// -- deletion focus fallback ---------------------------------------------------

/** Focus the first session row, or the search box on an empty list. The list
 * re-renders after the parent's async re-list, so poll briefly instead of a
 * single nextTick. */
function focusListFallback() {
  const deadline = Date.now() + 800
  const tryFocus = () => {
    const target =
      document.querySelector<HTMLElement>('.session-item') ??
      document.querySelector<HTMLElement>('.session-search-input')
    if (target) {
      target.focus()
      return
    }
    if (Date.now() < deadline) window.setTimeout(tryFocus, 100)
  }
  window.setTimeout(tryFocus, 50)
}

function onRowDeleted(name: string) {
  emit('deleted', name)
  focusListFallback()
}

// -- workspace header actions --------------------------------------------------

/** Header menu chose Rename: hand the registered workspace to the shell. */
function onGroupRename(id: string) {
  const workspace = orderedWorkspaceList.value.find((item) => item.id === id)
  if (workspace) emit('renameWorkspace', workspace)
}

/** Header menu chose Move: the shell owns the optimistic reorder + API call. */
function onGroupMove(id: string, delta: number) {
  emit('moveWorkspace', id, delta)
}

// -- workspace drag-and-drop reorder -------------------------------------------
// A drag handle in each workspace group header (SessionGroup) is the source;
// this column only tracks the drag/drop state for the honest indicator and
// translates a drop into the SAME delta event the actions menu emits, so the
// shell keeps its optimistic reorder + persist + revert-on-failure behavior.

type GroupDropPosition = 'before' | 'after'

const draggingWorkspaceId = ref<string | null>(null)
const dropTarget = ref<{ id: string; position: GroupDropPosition } | null>(null)

function startWorkspaceDrag(id: string) {
  draggingWorkspaceId.value = id
  dropTarget.value = null
}

function hoverWorkspaceDrop(id: string, position: GroupDropPosition) {
  const source = draggingWorkspaceId.value
  if (source === null || id === source) {
    if (dropTarget.value !== null) dropTarget.value = null
    return
  }
  const current = dropTarget.value
  if (current !== null && current.id === id && current.position === position) return
  dropTarget.value = { id, position }
}

function leaveWorkspaceDrop(id: string) {
  if (dropTarget.value?.id === id) dropTarget.value = null
}

function endWorkspaceDrag() {
  draggingWorkspaceId.value = null
  dropTarget.value = null
}

/** Drop happened on `targetId`: emit the equivalent delta move, if any. */
function dropWorkspace(targetId: string, position: GroupDropPosition) {
  const sourceId = draggingWorkspaceId.value
  endWorkspaceDrag()
  if (sourceId === null || sourceId === targetId) return
  const ids = orderedWorkspaceList.value.map((workspace) => workspace.id)
  const delta = dropReorderDelta(ids, sourceId, targetId, position)
  if (delta !== 0) emit('moveWorkspace', sourceId, delta)
}

let narrowViewport: MediaQueryList | null = null

function collapseSidebar() {
  emit('collapse')
  nextTick(() => document.querySelector<HTMLElement>('.sidebar-expand')?.focus())
}

function onViewportChange(event: MediaQueryListEvent) {
  if (event.matches) collapseSidebar()
}

onMounted(() => {
  narrowViewport = window.matchMedia('(max-width: 1023px)')
  narrowViewport.addEventListener('change', onViewportChange)
})

onUnmounted(() => {
  narrowViewport?.removeEventListener('change', onViewportChange)
})
</script>

<template>
  <nav class="sidebar" aria-label="Sessions">
    <p id="workspace-drag-help" class="visually-hidden">
      Drag a workspace group with its handle to reorder it, or use the workspace actions menu
      to move it up or down with the keyboard.
    </p>
    <div class="sidebar-top">
      <div class="brand-row">
        <span class="brand-mark" aria-hidden="true">TB</span>
        <span class="brand-name">Two Brothers</span>
        <span class="brand-spacer"></span>
        <button
          type="button"
          class="icon-btn"
          title="Refresh session list"
          aria-label="Refresh session list"
          @click="emit('refresh')"
        >
          <AppIcon name="refresh" class="icon" />
        </button>
        <button
          type="button"
          class="icon-btn"
          title="Collapse sidebar"
          aria-label="Collapse sidebar"
          @click="collapseSidebar"
        >
          <AppIcon name="panel" class="icon" />
        </button>
      </div>

      <div class="workspace-row">
        <AppIcon name="folder" class="icon workspace-icon" />
        <span class="workspace-select-wrap">
          <select
            class="workspace-select"
            :value="workspaceFilter"
            aria-label="Workspace"
            title="Filter sessions by workspace"
            @change="emit('filterWorkspace', ($event.target as HTMLSelectElement).value)"
          >
            <option value="all">All workspaces</option>
            <option v-for="w in orderedWorkspaceList" :key="w.id" :value="w.id">{{ w.name }}</option>
          </select>
          <AppIcon name="chevron-right" class="icon workspace-chevron" />
        </span>
        <button
          type="button"
          class="icon-btn"
          title="Add workspace"
          aria-label="Add workspace"
          @click="emit('addWorkspace')"
        >
          <AppIcon name="folder-plus" class="icon" />
        </button>
      </div>

      <div v-if="!searchOpen" class="primary-actions">
        <button
          type="button"
          class="new-session"
          aria-label="New session"
          @click="emit('newSession')"
        >
          <AppIcon name="plus" class="icon" />
          <span>New session</span>
        </button>
        <button
          ref="searchButton"
          type="button"
          class="action-secondary"
          title="Search sessions"
          aria-label="Search sessions"
          @click="openSearch"
        >
          <AppIcon name="search" class="icon" />
          <span>Search</span>
        </button>
      </div>

      <form v-else class="session-search" role="search" @submit.prevent>
        <AppIcon name="search" class="icon search-icon" />
        <input
          ref="searchInput"
          v-model="query"
          type="search"
          class="session-search-input"
          aria-label="Search sessions"
          placeholder="Search sessions…"
          @keydown.esc.prevent="onSearchEscape"
        />
        <button
          type="button"
          class="icon-btn search-close"
          title="Close search"
          aria-label="Close search"
          @click="closeSearch"
        >
          <AppIcon name="x" class="icon" />
        </button>
      </form>
      <p v-if="searching && filteredSessions.length" class="session-search-count" aria-live="polite">
        {{ filteredSessions.length }} of {{ sessions.length }} sessions
      </p>
    </div>

    <n-scrollbar class="sidebar-scroll">
      <div class="sidebar-list">
        <div v-if="sessions.length === 0" class="empty-state">
          <p class="empty-state-title">{{ emptyTitle }}</p>
          <p class="empty-state-hint">
            Describe a task in the composer below
            <span class="empty-state-arrow" aria-hidden="true">↓</span>
          </p>
          <div class="empty-state-actions">
            <button type="button" class="empty-primary" @click="emit('newSession')">
              New session
            </button>
            <button
              v-if="workspaceFilter !== 'all'"
              type="button"
              class="empty-secondary"
              @click="emit('filterWorkspace', 'all')"
            >
              Show all workspaces
            </button>
            <button
              v-else-if="workspaces.length === 0"
              type="button"
              class="empty-secondary"
              @click="emit('addWorkspace')"
            >
              Add workspace
            </button>
          </div>
        </div>

        <div v-else-if="filteredSessions.length === 0" class="empty-state">
          <p class="empty-state-title">No sessions match “{{ query.trim() }}”</p>
          <div class="empty-state-actions">
            <button type="button" class="empty-secondary" @click="clearSearch">Clear search</button>
          </div>
        </div>

        <template v-else>
          <SessionGroup
            v-for="g in groupViews"
            :key="g.key || 'unassigned'"
            :list-id="g.listId"
            :label="g.label"
            :items="g.shownItems"
            :total="g.total"
            :hidden-count="g.hiddenCount"
            :expanded="g.expanded"
            :collapsed="g.collapsed"
            :collapsible="g.collapsible"
            :show-less="g.showLess"
            :unassigned="g.unassigned"
            :selected="selected"
            :live-names="liveNames"
            :statuses="statuses"
            :workspace-id="g.workspaceId"
            :can-move-up="g.canMoveUp"
            :can-move-down="g.canMoveDown"
            :can-drag="g.collapsible && !!g.workspaceId"
            :dragging="draggingWorkspaceId === g.workspaceId"
            :drag-active="draggingWorkspaceId !== null"
            :drop-position="
              dropTarget !== null && dropTarget.id === g.workspaceId ? dropTarget.position : null
            "
            @toggle-collapse="toggleGroup(g.key)"
            @toggle-expand="toggleExpand(g.key)"
            @select="emit('select', $event)"
            @refresh="emit('refresh')"
            @deleted="onRowDeleted"
            @forked="emit('forked', $event)"
            @rename-workspace="onGroupRename"
            @move-workspace="onGroupMove"
            @drag-start="startWorkspaceDrag"
            @drag-over="hoverWorkspaceDrop"
            @drag-leave="leaveWorkspaceDrop"
            @drop="dropWorkspace"
            @drag-end="endWorkspaceDrag"
          />
        </template>
      </div>
    </n-scrollbar>

    <div
      v-if="sessions.length"
      class="status-legend"
      role="group"
      aria-label="Session status legend"
    >
      <span class="status-legend-title">Status</span>
      <span
        v-for="item in STATUS_LEGEND"
        :key="item.label"
        class="status-legend-item"
        :title="item.title"
      >
        <span class="legend-dot" :class="`tone-${item.tone}`" aria-hidden="true"></span>
        <span>{{ item.label }}</span>
      </span>
    </div>

    <SidebarFooter
      :theme-mode="themeMode"
      @open-settings="emit('openSettings')"
      @theme-change="emit('themeChange', $event)"
    />
  </nav>
</template>

<style scoped>
.icon {
  width: 16px;
  height: 16px;
  display: block;
  flex: none;
}

/* The nav is a fixed-height column: top block, scrolling list, pinned footer. */
.sidebar {
  --sidebar-inline: 0.55rem;
  overflow: hidden;
  padding: 0;
  min-height: 0;
}

.sidebar-top {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  padding: var(--space-2) var(--sidebar-inline) 0.45rem;
  border-bottom: 1px solid var(--border-subtle);
}

.brand-row {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  min-height: 26px;
}

.brand-mark {
  flex: none;
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  font-size: 0.56rem;
  font-weight: 700;
  letter-spacing: 0.02em;
  color: var(--text-on-accent);
  background: var(--accent);
  border-radius: var(--radius-sm);
}

.brand-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.8rem;
  font-weight: 650;
}

.brand-spacer {
  flex: 1;
}

.icon-btn {
  flex: none;
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  padding: 0;
  color: var(--text-secondary);
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  cursor: pointer;
}

.icon-btn:hover {
  background: var(--surface-hover);
  color: var(--text-primary);
}

.icon-btn:focus-visible {
  outline-offset: -2px;
}

.workspace-row {
  display: flex;
  align-items: center;
  gap: 0.2rem;
  min-width: 0;
}

.workspace-icon {
  width: 14px;
  height: 14px;
  color: var(--text-secondary);
}

.workspace-select-wrap {
  position: relative;
  flex: 1;
  min-width: 0;
  display: flex;
}

.workspace-select {
  flex: 1;
  min-width: 0;
  height: 28px;
  padding: 0 1.2rem 0 0.35rem;
  font: inherit;
  font-size: 0.8125rem;
  font-weight: 550;
  color: var(--text-primary);
  text-overflow: ellipsis;
  white-space: nowrap;
  overflow: hidden;
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  appearance: none;
  -webkit-appearance: none;
  cursor: pointer;
}

.workspace-select:hover {
  background: var(--surface-hover);
}

.workspace-select:focus-visible {
  outline-offset: -2px;
}

.workspace-chevron {
  position: absolute;
  top: 50%;
  right: 5px;
  width: 11px;
  height: 11px;
  color: var(--text-secondary);
  transform: translateY(-50%) rotate(90deg);
  pointer-events: none;
}

.primary-actions {
  display: flex;
  gap: 0.3rem;
  min-width: 0;
}

.new-session {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.35rem;
  height: 30px;
  padding: 0 var(--space-2);
  font: inherit;
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--text-primary);
  background: var(--accent-soft);
  border: 1px solid transparent;
  border-radius: 7px;
  cursor: pointer;
  white-space: nowrap;
}

.new-session:hover {
  border-color: var(--accent);
}

.new-session:focus-visible,
.action-secondary:focus-visible {
  outline-offset: -2px;
}

.action-secondary {
  flex: none;
  display: flex;
  align-items: center;
  gap: 0.3rem;
  height: 30px;
  padding: 0 var(--space-2);
  font: inherit;
  font-size: 0.8rem;
  color: var(--text-secondary);
  background: transparent;
  border: 1px solid transparent;
  border-radius: 7px;
  cursor: pointer;
  white-space: nowrap;
}

.action-secondary:hover {
  background: var(--surface-hover);
  color: var(--text-primary);
}

.session-search {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  height: 30px;
  padding: 0 0.2rem 0 0.45rem;
  background: var(--surface-canvas);
  border: 1px solid var(--border-strong);
  border-radius: 7px;
}

/* The search input has no border of its own, so the wrapper shows focus. The
   focus-within rule is the fallback for engines without :has(); the second rule
   upgrades a keyboard focus to the shared focus token ring. */
.session-search:focus-within {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-soft);
}

.session-search:has(.session-search-input:focus-visible) {
  border-color: var(--focus-ring);
  box-shadow: 0 0 0 2px var(--focus-ring);
}

.search-icon {
  width: 14px;
  height: 14px;
  color: var(--text-secondary);
}

.session-search-input {
  flex: 1;
  min-width: 0;
  height: 100%;
  padding: 0;
  font: inherit;
  font-size: 0.8125rem;
  color: var(--text-primary);
  background: transparent;
  border: none;
}

.session-search-input:focus,
.session-search-input:focus-visible {
  /* the bordered .session-search wrapper draws the focus ring (see above) */
  outline: none;
}

.session-search-input::placeholder {
  color: var(--text-secondary);
}

/* The wrapper's own close button replaces the native search affordance. */
.session-search-input::-webkit-search-cancel-button {
  -webkit-appearance: none;
  appearance: none;
}

.search-close {
  width: 22px;
  height: 22px;
  border-radius: 5px;
}

.session-search-count {
  margin: 0 0 0 0.1rem;
  font-size: 0.7rem;
  color: var(--text-secondary);
}

.sidebar-scroll {
  flex: 1;
  min-height: 0;
}

.sidebar-list {
  padding: 0.2rem var(--sidebar-inline) 0.6rem;
}

/* Empty list: a real call to action instead of inert text. */
.empty-state {
  padding: var(--space-4) 0.4rem 0.6rem;
  text-align: center;
}

.empty-state-title {
  margin: 0 0 0.3rem;
  font-size: 0.86rem;
  font-weight: 600;
  color: var(--text-primary);
  overflow-wrap: break-word;
}

.empty-state-hint {
  margin: 0 0 0.7rem;
  font-size: 0.78rem;
  color: var(--text-secondary);
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

.empty-primary,
.empty-secondary {
  height: 28px;
  padding: 0 0.6rem;
  font: inherit;
  font-size: 0.78rem;
  border-radius: var(--radius-sm);
  cursor: pointer;
}

.empty-primary {
  font-weight: 600;
  color: var(--text-on-accent);
  background: var(--accent);
  border: 1px solid var(--accent);
}

.empty-secondary {
  color: var(--text-primary);
  background: transparent;
  border: 1px solid var(--border-strong);
}

.empty-secondary:hover {
  background: var(--surface-hover);
  color: var(--text-primary);
}

.empty-primary:hover {
  opacity: 0.9;
}

/* Compact status legend pinned above the footer; muted until needed. */
.status-legend {
  flex: none;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.2rem 0.6rem;
  padding: 0.35rem var(--sidebar-inline) 0.4rem;
  border-top: 1px solid var(--border-subtle);
  color: var(--text-secondary);
  font-size: 0.68rem;
}

.status-legend-title {
  font-weight: 600;
  letter-spacing: 0.01em;
}

.status-legend-item {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  white-space: nowrap;
}

.legend-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-secondary);
}

.legend-dot.tone-ok {
  background: var(--ok);
}

.legend-dot.tone-warning {
  background: var(--warning);
}

.legend-dot.tone-danger {
  background: var(--danger);
}

.legend-dot.tone-accent {
  background: var(--accent);
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
</style>