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
}>()

const emit = defineEmits<{
  toggleCollapse: []
  toggleExpand: []
  select: [name: string]
  refresh: []
  deleted: [name: string]
  /** Header actions menu: rename this workspace. */
  renameWorkspace: [id: string]
  /** Header actions menu: move this workspace by `delta` slots (-1/+1). */
  moveWorkspace: [id: string, delta: number]
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
  <section class="session-group">
    <h3 v-if="collapsible" class="group-heading" :class="{ 'has-actions': showActions }">
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
}
</style>
