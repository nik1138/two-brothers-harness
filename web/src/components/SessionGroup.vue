<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, useId } from 'vue'
import type { SessionStatusView } from '../sessionStatus'
import type { SessionInfo } from '../types'
import AppIcon from './AppIcon.vue'
import SessionRow from './SessionRow.vue'

const props = defineProps<{
  /** Id of the list, wired to the header's `aria-controls`. */
  listId: string
  label: string
  /** Rows to render (already trimmed to the preview window). */
  items: SessionInfo[]
  /** Sessions in the whole group, including the ones not rendered yet. */
  total: number
  /** Sessions beyond the preview window. */
  hiddenCount: number
  /** The preview window is expanded ("Show N more" was pressed). */
  expanded: boolean
  /** The group's list is collapsed. */
  collapsed: boolean
  /** Render the folder header and its collapse control. */
  collapsible: boolean
  /** A "Show less" control is available. */
  showLess: boolean
  unassigned?: boolean
  selected: string | null
  liveNames: string[]
  /** Derived row statuses for the whole sidebar, keyed by session name. */
  statuses?: Record<string, SessionStatusView>
  /** Registered workspace id; the header's actions menu needs it (absent for
   *  the Unassigned/search groups and unknown workspace links). */
  workspaceId?: string
  /** Move up is possible (the workspace is not first). */
  canMoveUp?: boolean
  /** Move down is possible (the workspace is not last). */
  canMoveDown?: boolean
  /** The group header is a drag source (registered workspace, unfiltered list). */
  canDrag?: boolean
  /** A workspace-group drag is in progress somewhere in the sidebar. */
  dragActive?: boolean
  /** This group is the drag source currently being dragged. */
  dragging?: boolean
  /** Honest drop indicator: before/after this group while it is hovered. */
  dropPosition?: 'before' | 'after' | null
}>()

const emit = defineEmits<{
  toggleCollapse: []
  toggleExpand: []
  select: [name: string]
  refresh: []
  deleted: [name: string]
  /** A row forked its conversation; the parent refreshes and opens the fork. */
  forked: [name: string]
  /** Header actions menu: rename this workspace. */
  renameWorkspace: [id: string]
  /** Header actions menu: move this workspace by `delta` slots (-1/+1). */
  moveWorkspace: [id: string, delta: number]
  /** Drag handle: this group's workspace drag started. */
  dragStart: [id: string]
  /** Drag over another group's header: drop before/after it. */
  dragOver: [id: string, position: 'before' | 'after']
  /** The drag left this group without dropping. */
  dragLeave: [id: string]
  /** Dropped on this group: before/after it (the parent computes the move). */
  drop: [id: string, position: 'before' | 'after']
  /** The drag ended (dropped or cancelled) — always clears the drag state. */
  dragEnd: []
}>()

const liveSet = computed(() => new Set(props.liveNames))

function statusFor(name: string): SessionStatusView | null {
  return props.statuses?.[name] ?? null
}

const groupLabel = computed(() => {
  const sessions = props.total === 1 ? '1 session' : `${props.total} sessions`
  return props.unassigned ? `${props.label}, ${sessions}` : `Workspace ${props.label}, ${sessions}`
})

// -- header actions menu -------------------------------------------------------
// Same accessible popover pattern as SessionRow: one `⋯` trigger per registered
// workspace, arrow/Home/End navigation between role=menuitem buttons, Escape or
// Tab closes, and the teleported menu escapes the sidebar's scroll clipping.

const showActions = computed(() => props.collapsible && !!props.workspaceId)

// -- drag-and-drop reorder -----------------------------------------------------
// Progressive enhancement over the actions menu: the dedicated handle is the
// only drag source (the header buttons keep their click/keyboard behavior), a
// plain click on it does nothing, and the parent turns a drop into the existing
// moveWorkspace event so App.vue keeps the optimistic update/revert + API call.

/** Only registered workspace groups in the unfiltered list are draggable. */
const showDrag = computed(() => props.canDrag === true)

const headingRef = ref<HTMLElement | null>(null)

/** Before/after the header midpoint: the honest insert position for a drop. */
function dropPositionFor(event: DragEvent): 'before' | 'after' {
  const heading = headingRef.value
  if (!heading) return 'before'
  const rect = heading.getBoundingClientRect()
  const y = typeof event.clientY === 'number' && Number.isFinite(event.clientY)
    ? event.clientY
    : rect.top
  return y < rect.top + rect.height / 2 ? 'before' : 'after'
}

function onHandleDragStart(event: DragEvent) {
  const id = props.workspaceId
  if (!showDrag.value || !id) {
    event.preventDefault()
    return
  }
  // The custom type identifies the payload if it is ever dropped outside the
  // app; the sidebar tracks the drag in memory, so it relies on its own state.
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('application/x-twobrothers-workspace', id)
    event.dataTransfer.setData('text/plain', props.label)
  }
  emit('dragStart', id)
}

function onHandleDragEnd() {
  emit('dragEnd')
}

function onGroupDragOver(event: DragEvent) {
  if (!props.dragActive || !showDrag.value || !props.workspaceId) return
  // Only our own drag may drop here (a file drag over the header is ignored).
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  emit('dragOver', props.workspaceId, dropPositionFor(event))
}

function onGroupDragLeave(event: DragEvent) {
  const current = event.currentTarget as Node | null
  const related = event.relatedTarget as Node | null
  // Moving between child elements is not leaving the group.
  if (current && related && current.contains(related)) return
  if (!props.dragActive || !props.workspaceId) return
  emit('dragLeave', props.workspaceId)
}

function onGroupDrop(event: DragEvent) {
  if (!props.dragActive || !showDrag.value || !props.workspaceId) return
  event.preventDefault()
  event.stopPropagation()
  emit('drop', props.workspaceId, dropPositionFor(event))
}

const menuOpen = ref(false)
const menuStyle = ref<Record<string, string>>({})
const triggerRef = ref<HTMLButtonElement | null>(null)
const menuRef = ref<HTMLElement | null>(null)
const menuId = `workspace-menu-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`

const MENU_WIDTH = 176
/** Enough for three 30px items plus gaps/padding, used only to pick placement. */
const MENU_HEIGHT = 116

/** Enabled menu items only: disabled Move up/down must not trap arrow keys. */
function menuItems(): HTMLElement[] {
  return Array.from(
    menuRef.value?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? [],
  )
}

function focusMenuItem(index: number | 'last') {
  const items = menuItems()
  const i = index === 'last' ? items.length - 1 : Math.max(0, Math.min(index, items.length - 1))
  items[i]?.focus()
}

function onDocPointerDown(e: PointerEvent) {
  const target = e.target as Node | null
  if (!target) return
  if (menuRef.value?.contains(target) || triggerRef.value?.contains(target)) return
  closeMenu(true)
}

/** Scroll or resize invalidates the fixed menu position; close without moving focus. */
function onViewportChange() {
  closeMenu(false)
}

function addMenuListeners() {
  document.addEventListener('pointerdown', onDocPointerDown, true)
  window.addEventListener('scroll', onViewportChange, true)
  window.addEventListener('resize', onViewportChange)
}

function removeMenuListeners() {
  document.removeEventListener('pointerdown', onDocPointerDown, true)
  window.removeEventListener('scroll', onViewportChange, true)
  window.removeEventListener('resize', onViewportChange)
}

function openMenu() {
  if (menuOpen.value) return
  const trigger = triggerRef.value
  if (!trigger) return
  const rect = trigger.getBoundingClientRect()
  let top = rect.bottom + 4
  if (top + MENU_HEIGHT > window.innerHeight - 8) {
    top = Math.max(8, rect.top - MENU_HEIGHT - 4)
  }
  const left = Math.max(
    8,
    Math.min(rect.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 8),
  )
  menuStyle.value = {
    top: `${Math.round(top)}px`,
    left: `${Math.round(left)}px`,
    width: `${MENU_WIDTH}px`,
  }
  menuOpen.value = true
  addMenuListeners()
  nextTick(() => focusMenuItem(0))
}

/** Close the menu; `restoreFocus` returns focus to the header trigger. */
function closeMenu(restoreFocus: boolean) {
  if (!menuOpen.value) return
  menuOpen.value = false
  removeMenuListeners()
  if (restoreFocus) nextTick(() => triggerRef.value?.focus())
}

function toggleMenu() {
  if (menuOpen.value) closeMenu(true)
  else openMenu()
}

function onMenuKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    closeMenu(true)
    return
  }
  if (e.key === 'Tab') {
    e.preventDefault()
    closeMenu(true)
    return
  }
  const items = menuItems()
  if (!items.length) return
  const current = items.indexOf(document.activeElement as HTMLElement)
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    items[(current + 1) % items.length]?.focus()
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    items[(current - 1 + items.length) % items.length]?.focus()
  } else if (e.key === 'Home') {
    e.preventDefault()
    items[0]?.focus()
  } else if (e.key === 'End') {
    e.preventDefault()
    items[items.length - 1]?.focus()
  }
}

/**
 * Close the menu, park focus on the header trigger (so the dialog/refresh below
 * restores somewhere sensible), then ask the shell to rename the workspace.
 */
function requestRename(): void {
  const id = props.workspaceId
  if (!id) return
  triggerRef.value?.focus()
  closeMenu(true)
  emit('renameWorkspace', id)
}

/** Same focus hand-off as rename; the shell applies the optimistic reorder. */
function requestMove(delta: number): void {
  const id = props.workspaceId
  if (!id) return
  if (delta < 0 ? !props.canMoveUp : !props.canMoveDown) return
  triggerRef.value?.focus()
  closeMenu(true)
  emit('moveWorkspace', id, delta)
}

onUnmounted(removeMenuListeners)
</script>

<template>
  <section
    class="session-group"
    :class="{
      'is-dragging': dragging,
      'is-drop-before': dropPosition === 'before',
      'is-drop-after': dropPosition === 'after',
    }"
    @dragover="onGroupDragOver"
    @dragleave="onGroupDragLeave"
    @drop="onGroupDrop"
  >
    <h3
      v-if="collapsible"
      ref="headingRef"
      class="group-heading"
      :class="{ 'has-actions': showActions, 'has-drag': showDrag }"
    >
      <button
        type="button"
        class="group-toggle"
        :aria-expanded="!collapsed"
        :aria-controls="listId"
        :aria-label="groupLabel"
        @click="emit('toggleCollapse')"
      >
        <AppIcon
          name="chevron-right"
          class="icon group-chevron"
          :class="{ 'is-open': !collapsed }"
        />
        <AppIcon :name="unassigned ? 'inbox' : 'folder'" class="icon group-folder" />
        <span class="group-label" :title="label">{{ label }}</span>
        <span class="group-count" aria-hidden="true">{{ total }}</span>
      </button>

      <!-- Dedicated drag source: out of the tab order on purpose (keyboard users
           reorder through the actions menu below); the grip is decorative. The
           grip span itself is also draggable so native drag initiation works on
           every engine (some suppress it on interactive elements); the event
           bubbles to this handle's handlers. -->
      <button
        v-if="showDrag"
        type="button"
        class="group-drag-handle"
        tabindex="-1"
        draggable="true"
        :aria-label="`Drag ${label} to reorder`"
        aria-describedby="workspace-drag-help"
        :title="`Drag ${label} to reorder`"
        @dragstart="onHandleDragStart"
        @dragend="onHandleDragEnd"
      >
        <span class="drag-grip" draggable="true" aria-hidden="true"></span>
      </button>

      <button
        v-if="showActions"
        ref="triggerRef"
        type="button"
        class="group-menu-trigger"
        :aria-label="`Workspace actions for ${label}`"
        :title="`Workspace actions for ${label}`"
        aria-haspopup="menu"
        :aria-expanded="menuOpen"
        :aria-controls="menuId"
        @click="toggleMenu"
        @keydown.down.prevent="openMenu()"
      >
        <AppIcon name="ellipsis" class="icon" />
      </button>

      <Teleport to="body">
        <div
          v-if="menuOpen"
          ref="menuRef"
          :id="menuId"
          class="group-menu"
          role="menu"
          :aria-label="`Workspace actions for ${label}`"
          :style="menuStyle"
          @keydown="onMenuKeydown"
        >
          <button
            type="button"
            role="menuitem"
            class="group-menu-item"
            aria-label="Rename workspace"
            @click="requestRename"
          >
            <AppIcon name="pencil" class="icon" />
            <span>Rename…</span>
          </button>
          <button
            type="button"
            role="menuitem"
            class="group-menu-item"
            aria-label="Move workspace up"
            :disabled="!canMoveUp"
            @click="requestMove(-1)"
          >
            <AppIcon name="chevron-up" class="icon" />
            <span>Move up</span>
          </button>
          <button
            type="button"
            role="menuitem"
            class="group-menu-item"
            aria-label="Move workspace down"
            :disabled="!canMoveDown"
            @click="requestMove(1)"
          >
            <AppIcon name="chevron-down" class="icon" />
            <span>Move down</span>
          </button>
        </div>
      </Teleport>
    </h3>

    <ul v-show="!collapsed" :id="listId" class="session-list">
      <SessionRow
        v-for="s in items"
        :key="s.name"
        :session="s"
        :active="s.name === selected"
        :live="liveSet.has(s.name)"
        :status="statusFor(s.name)"
        @select="emit('select', s.name)"
        @refresh="emit('refresh')"
        @deleted="emit('deleted', $event)"
        @forked="emit('forked', $event)"
      />
    </ul>

    <button
      v-if="!collapsed && (hiddenCount > 0 || showLess)"
      type="button"
      class="group-more"
      :aria-expanded="expanded"
      :aria-controls="listId"
      @click="emit('toggleExpand')"
    >
      {{ showLess ? 'Show less' : `Show ${hiddenCount} more` }}
    </button>
  </section>
</template>

<style scoped>
.icon {
  display: block;
  flex: none;
}

/* Positioning context for the header controls and the drop indicator. */
.session-group {
  position: relative;
}

.group-heading {
  position: sticky;
  top: 0;
  z-index: 2;
  margin: 0 calc(-1 * var(--sidebar-inline, 0.55rem));
  padding: 0 var(--sidebar-inline, 0.55rem);
  background: var(--surface-panel);
  font-size: inherit;
  font-weight: inherit;
}

.group-heading.has-drag .group-toggle {
  /* Reserve both the drag handle and the actions trigger slot. */
  padding-right: 58px;
}

.session-group + .session-group {
  margin-top: 0.15rem;
}

.group-toggle {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  width: 100%;
  height: 28px;
  padding: 0 0.3rem 0 0.15rem;
  font: inherit;
  font-size: 0.72rem;
  font-weight: 600;
  letter-spacing: 0.01em;
  color: var(--text-secondary);
  text-align: left;
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  cursor: pointer;
}

/* Reserve the trigger's slot so revealing it on hover never shifts the label. */
.group-heading.has-actions .group-toggle {
  padding-right: 26px;
}

.group-toggle:hover {
  background: var(--surface-hover);
  color: var(--text-primary);
}

.group-toggle:focus-visible {
  outline-offset: -2px;
}

.group-chevron {
  width: 12px;
  height: 12px;
  color: var(--text-secondary);
  transition: transform 0.12s ease;
}

.group-chevron.is-open {
  transform: rotate(90deg);
}

.group-folder {
  width: 14px;
  height: 14px;
  color: var(--text-secondary);
}

.group-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.group-count {
  flex: none;
  min-width: 1.15rem;
  padding: 0 0.3rem;
  font-size: 0.68rem;
  font-weight: 500;
  line-height: 1.35;
  text-align: center;
  color: var(--text-secondary);
  background: var(--surface-hover);
  border-radius: var(--radius-pill);
}

/* Header actions trigger: hidden until the group is hovered/focused, like the
   session row's overflow button; touch and open menus keep it visible. */
.group-menu-trigger {
  position: absolute;
  top: 50%;
  right: 0.2rem;
  transform: translateY(-50%);
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  padding: 0;
  color: var(--text-secondary);
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  cursor: pointer;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.12s ease;
}

.session-group:hover .group-menu-trigger,
.session-group:focus-within .group-menu-trigger,
.group-menu-trigger[aria-expanded='true'] {
  opacity: 1;
  pointer-events: auto;
}

.group-menu-trigger:hover {
  background: var(--surface-hover);
  color: var(--text-primary);
}

.group-menu-trigger:focus-visible {
  outline-offset: 0;
}

/* Dedicated drag handle: pointer-only affordance (tabindex=-1) — the actions
   menu remains the keyboard path. A quiet grip stays visible so the affordance
   is discoverable; hover/drag makes it solid. */
.group-drag-handle {
  position: absolute;
  top: 50%;
  right: var(--space-7);
  transform: translateY(-50%);
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  padding: 0;
  color: var(--text-secondary);
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  cursor: grab;
  opacity: 0.5;
  -webkit-user-drag: element;
  user-select: none;
  transition:
    opacity var(--motion-fast) var(--ease-standard),
    background-color var(--motion-fast) var(--ease-standard),
    color var(--motion-fast) var(--ease-standard);
}

.group-drag-handle:hover,
.group-drag-handle:active {
  opacity: 1;
  background: var(--surface-hover);
  color: var(--text-primary);
}

.group-drag-handle:active {
  cursor: grabbing;
}

.group-drag-handle:focus-visible {
  outline-offset: 0;
}

.drag-grip {
  width: 12px;
  height: 18px;
  background-image: radial-gradient(circle, currentColor 1px, transparent 1.2px);
  background-size: 6px 6px;
  background-position: center;
  border-radius: 2px;
  -webkit-user-drag: element;
  user-select: none;
}

.session-group.is-dragging .group-drag-handle {
  opacity: 1;
  cursor: grabbing;
}

.session-group.is-dragging {
  opacity: 0.55;
}

/* Honest insert indicator: an accent line on the edge the drop will use. */
.session-group.is-drop-before::before,
.session-group.is-drop-after::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  height: 2px;
  border-radius: 1px;
  background: var(--accent);
  pointer-events: none;
  z-index: 3;
}

.session-group.is-drop-before::before {
  top: -1px;
}

.session-group.is-drop-after::after {
  bottom: -1px;
}

.session-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.group-more {
  display: block;
  width: calc(100% - 0.1rem);
  height: 24px;
  margin: 1px 0.05rem 2px;
  padding: 0 0.55rem;
  font: inherit;
  font-size: 0.72rem;
  color: var(--text-secondary);
  text-align: left;
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  cursor: pointer;
}

.group-more:hover {
  background: var(--surface-hover);
  color: var(--text-primary);
}

.group-more:focus-visible {
  outline-offset: -2px;
}

/* Teleported to <body>: fixed placement escapes the sidebar's scroll clipping
   (same pattern/sizing as the session row menu). */
.group-menu {
  position: fixed;
  z-index: 2600;
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 4px;
  background: var(--surface-panel);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-raised);
}

.group-menu-item {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  width: 100%;
  height: 30px;
  padding: 0 8px;
  font: inherit;
  font-size: 0.8125rem;
  color: var(--text-primary);
  text-align: left;
  background: transparent;
  border: none;
  border-radius: 5px;
  cursor: pointer;
}

.group-menu-item:hover,
.group-menu-item:focus-visible {
  background: var(--surface-hover);
  outline: none;
}

.group-menu-item:focus-visible {
  box-shadow: inset 0 0 0 2px var(--accent);
}

.group-menu-item:disabled {
  color: var(--text-secondary);
  cursor: default;
  opacity: 0.5;
}

.group-menu-item:disabled:hover {
  background: transparent;
}

@media (hover: none) {
  .group-menu-trigger {
    opacity: 1;
    pointer-events: auto;
    width: 28px;
    height: 28px;
  }

  /* Touch has no native HTML5 drag: hide the pointer-only handle and fall back
     to the actions menu (the header keeps the trigger slot reserved). */
  .group-drag-handle {
    display: none;
  }

  .group-heading.has-drag .group-toggle {
    padding-right: 26px;
  }

  .group-menu-item {
    height: 36px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .group-chevron {
    transition: none;
  }

  .group-menu-trigger {
    transition: none;
  }

  .group-drag-handle {
    transition: none;
  }
}
</style>
