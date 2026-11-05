<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, useId } from 'vue'
import { useMessage } from 'naive-ui'
import { ApiError, deleteSession, renameSession } from '../api'
import { relativeTime, sessionTitle } from '../chat'
import { deriveSessionStatus } from '../sessionStatus'
import type { SessionStatusView } from '../sessionStatus'
import type { SessionInfo } from '../types'
import AppIcon from './AppIcon.vue'

const props = defineProps<{
  session: SessionInfo
  /** This session's transcript is the one on screen. */
  active: boolean
  /** A run is live on this session. */
  live: boolean
  /** Derived row status; absent falls back to the live-dot-only behavior. */
  status?: SessionStatusView | null
}>()

const emit = defineEmits<{
  select: []
  /** The title changed on the backend; the parent re-lists sessions. */
  refresh: []
  /** The session was deleted; the parent clears its selection if it was open. */
  deleted: [name: string]
}>()

const message = useMessage()

const title = computed(() => props.session.title || sessionTitle(props.session.name))

/**
 * The single row indicator. App derives it from run/live/last-seen state; the
 * fallback keeps the pre-existing live-dot behavior for other callers.
 */
const statusView = computed<SessionStatusView>(
  () => props.status ?? deriveSessionStatus({ liveStatus: props.live ? 'running' : null }),
)
const showStatus = computed(
  () => statusView.value.kind !== 'read' && statusView.value.label !== '',
)

/** Menu state. The row shows one overflow button; rename and delete live in it. */
const menuOpen = ref(false)
const menuStyle = ref<Record<string, string>>({})
const triggerRef = ref<HTMLButtonElement | null>(null)
const menuRef = ref<HTMLElement | null>(null)

/** Inline title editor (replaces the row while open). */
const editing = ref(false)
const renameDraft = ref('')
const renameInput = ref<HTMLInputElement | null>(null)

/** Delete is a two-step action: the menu item asks for confirmation for 3s. */
const confirmDelete = ref(false)
const busy = ref(false)
let confirmTimer: ReturnType<typeof setTimeout> | null = null

const menuId = `session-menu-${useId()}`

const MENU_WIDTH = 176
/** Enough for two 30px items plus padding, used only to pick up/down placement. */
const MENU_HEIGHT = 78

function errText(e: unknown): string {
  return e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e)
}

// -- row menu -----------------------------------------------------------------

function menuItems(): HTMLElement[] {
  return Array.from(menuRef.value?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])
}

function focusMenuItem(index: number | 'last') {
  const items = menuItems()
  const i = index === 'last' ? items.length - 1 : Math.max(0, Math.min(index, items.length - 1))
  items[i]?.focus()
}

function cancelConfirmTimer() {
  if (confirmTimer) {
    clearTimeout(confirmTimer)
    confirmTimer = null
  }
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
  if (menuOpen.value || editing.value || busy.value) return
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
  menuStyle.value = { top: `${Math.round(top)}px`, left: `${Math.round(left)}px`, width: `${MENU_WIDTH}px` }
  menuOpen.value = true
  addMenuListeners()
  nextTick(() => focusMenuItem(0))
}

/** Close the menu; `restoreFocus` returns focus to the row's trigger. */
function closeMenu(restoreFocus: boolean) {
  if (!menuOpen.value) return
  menuOpen.value = false
  confirmDelete.value = false
  cancelConfirmTimer()
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

// -- rename -------------------------------------------------------------------

function startRename() {
  closeMenu(false)
  renameDraft.value = title.value
  editing.value = true
  nextTick(() => {
    renameInput.value?.focus()
    renameInput.value?.select()
  })
}

/** Leave the inline editor and put focus back on the row's menu trigger. */
function endRename() {
  editing.value = false
  nextTick(() => triggerRef.value?.focus())
}

async function commitRename() {
  const next = renameDraft.value.trim()
  if (!next || next === title.value) {
    endRename()
    return
  }
  if (busy.value) return
  busy.value = true
  try {
    await renameSession(props.session.name, next)
    endRename()
    emit('refresh')
  } catch (e) {
    message.error(`Rename failed: ${errText(e)}`)
  } finally {
    busy.value = false
  }
}

// -- delete -------------------------------------------------------------------

function askDelete() {
  if (busy.value) return
  confirmDelete.value = true
  if (confirmTimer) clearTimeout(confirmTimer)
  confirmTimer = setTimeout(() => {
    confirmTimer = null
    const confirmHeldFocus =
      (document.activeElement as HTMLElement | null)?.getAttribute('aria-label') ===
      'Confirm delete session'
    confirmDelete.value = false
    if (confirmHeldFocus && menuOpen.value) nextTick(() => focusMenuItem(1))
  }, 3000)
  nextTick(() => focusMenuItem(1))
}

async function doDelete() {
  if (busy.value) return
  cancelConfirmTimer()
  busy.value = true
  closeMenu(false)
  try {
    await deleteSession(props.session.name)
    emit('deleted', props.session.name)
  } catch (e) {
    message.error(`Delete failed: ${errText(e)}`)
  } finally {
    busy.value = false
  }
}

onUnmounted(() => {
  cancelConfirmTimer()
  removeMenuListeners()
})
</script>

<template>
  <li class="session-row" :data-name="session.name">
    <form v-if="editing" class="session-rename" @submit.prevent="commitRename">
      <input
        ref="renameInput"
        v-model="renameDraft"
        class="session-rename-input"
        :aria-label="`Rename ${title}`"
        :disabled="busy"
        @keydown.esc.prevent="endRename()"
      />
      <button
        type="submit"
        class="icon-btn"
        title="Save title"
        aria-label="Save session title"
        :disabled="busy"
      >
        <AppIcon name="check" class="icon" />
      </button>
      <button
        type="button"
        class="icon-btn"
        title="Cancel rename"
        aria-label="Cancel rename"
        @click="endRename()"
      >
        <AppIcon name="x" class="icon" />
      </button>
    </form>

    <template v-else>
      <button
        type="button"
        class="session-item"
        :class="{ active }"
        :aria-current="active ? 'page' : undefined"
        :title="title"
        @click="emit('select')"
      >
        <span class="session-title">{{ title }}</span>
        <span
          v-if="showStatus"
          class="session-status"
          :class="`tone-${statusView.tone}`"
          role="img"
          :aria-label="statusView.ariaLabel"
          :title="statusView.title"
        >
          <span
            class="status-dot"
            :class="{ 'live-dot': statusView.kind === 'live' }"
            aria-hidden="true"
          ></span>
          <span class="live-label" aria-hidden="true">{{ statusView.label }}</span>
        </span>
        <span v-else class="session-time">{{ relativeTime(session.mtime) }}</span>
      </button>

      <button
        ref="triggerRef"
        type="button"
        class="row-menu-trigger"
        :aria-label="`Actions for ${title}`"
        aria-haspopup="menu"
        :aria-expanded="menuOpen"
        :aria-controls="menuId"
        :title="`Actions for ${title}`"
        :disabled="busy"
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
          class="row-menu"
          role="menu"
          :aria-label="`Actions for ${title}`"
          :style="menuStyle"
          @keydown="onMenuKeydown"
        >
          <button
            type="button"
            role="menuitem"
            class="row-menu-item"
            aria-label="Rename session"
            :disabled="busy"
            @click="startRename"
          >
            <AppIcon name="pencil" class="icon" />
            <span>Rename</span>
          </button>
          <button
            v-if="!confirmDelete"
            type="button"
            role="menuitem"
            class="row-menu-item row-menu-danger"
            aria-label="Delete session"
            :disabled="busy"
            @click="askDelete"
          >
            <AppIcon name="trash" class="icon" />
            <span>Delete</span>
          </button>
          <button
            v-else
            type="button"
            role="menuitem"
            class="row-menu-item row-menu-danger is-confirm"
            aria-label="Confirm delete session"
            :disabled="busy"
            @click="doDelete"
          >
            <AppIcon name="trash" class="icon" />
            <span>{{ busy ? 'Deleting…' : 'Confirm delete' }}</span>
          </button>
        </div>
      </Teleport>
    </template>
  </li>
</template>

<style scoped>
.icon {
  width: 15px;
  height: 15px;
  display: block;
  flex: none;
}

/* Row = select button + overflow trigger. The trigger sits in reserved padding
   so revealing it on hover never shifts the title or the timestamp. */
.session-row {
  position: relative;
  display: flex;
  min-width: 0;
}

.session-row .session-item {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  height: 32px;
  padding: 0 30px 0 8px;
  font: inherit;
  color: var(--text-primary);
  text-align: left;
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  cursor: pointer;
}

.session-row .session-item:hover {
  background: var(--surface-hover);
}

.session-row .session-item.active {
  background: var(--surface-highlight);
  border: none;
}

.session-row .session-item:focus-visible {
  outline-offset: -2px;
}

.session-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.8125rem;
  line-height: 1.35;
}

.session-item.active .session-title {
  font-weight: 600;
}

.session-time {
  flex: none;
  font-size: 0.6875rem;
  line-height: 1;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.session-status {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  font-size: 0.6875rem;
  font-weight: 600;
  line-height: 1;
  color: var(--text-secondary);
}

.session-status.tone-ok {
  color: var(--ok);
}

.session-status.tone-warning {
  color: var(--warning);
}

.session-status.tone-danger {
  color: var(--danger);
}

.session-status.tone-accent {
  color: var(--accent);
}

.status-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}

/* The original live dot keeps its pulse; the other tones stay still. */
.live-dot {
  animation: session-pulse 1.4s ease-in-out infinite;
}

@keyframes session-pulse {
  50% {
    opacity: 0.35;
  }
}

.row-menu-trigger {
  position: absolute;
  top: 50%;
  right: 2px;
  transform: translateY(-50%);
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  padding: 0;
  color: var(--text-secondary);
  background: transparent;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.12s ease;
}

.session-row:hover .row-menu-trigger,
.session-row:focus-within .row-menu-trigger,
.row-menu-trigger[aria-expanded='true'] {
  opacity: 1;
  pointer-events: auto;
}

.row-menu-trigger:hover {
  background: var(--surface-panel);
  color: var(--text-primary);
}

.row-menu-trigger:focus-visible {
  outline-offset: 0;
}

.row-menu-trigger:disabled {
  cursor: progress;
  opacity: 0.5;
}

/* Touch has no hover: keep the trigger permanently reachable. */
@media (hover: none) {
  .row-menu-trigger {
    opacity: 1;
    pointer-events: auto;
    width: 28px;
    height: 28px;
  }
}

/* Teleported to <body>: fixed placement escapes the sidebar's scroll clipping. */
.row-menu {
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

.row-menu-item {
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

.row-menu-item:hover,
.row-menu-item:focus-visible {
  background: var(--surface-hover);
  outline: none;
}

.row-menu-item:focus-visible {
  box-shadow: inset 0 0 0 2px var(--accent);
}

.row-menu-item:disabled {
  cursor: progress;
  opacity: 0.55;
}

.row-menu-danger {
  color: var(--danger);
}

.row-menu-danger.is-confirm {
  background: var(--danger-soft);
  font-weight: 600;
}

.row-menu-danger.is-confirm:hover,
.row-menu-danger.is-confirm:focus-visible {
  background: var(--danger-soft);
}

@media (hover: none) {
  .row-menu-item {
    height: 36px;
  }
}

/* Inline rename keeps the row's footprint (no layout jump). */
.session-rename {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 0.15rem;
  height: 32px;
}

.session-rename-input {
  flex: 1;
  min-width: 0;
  height: 28px;
  padding: 0 7px;
  font: inherit;
  font-size: 0.8125rem;
  color: var(--text-primary);
  background: var(--surface-panel);
  border: 1px solid var(--accent);
  border-radius: 6px;
}

.session-rename-input:focus {
  outline: none;
}

.session-rename-input:focus-visible {
  box-shadow: 0 0 0 2px var(--accent-soft);
}

.session-rename .icon-btn {
  width: 24px;
  height: 24px;
  display: grid;
  place-items: center;
  padding: 0;
  color: var(--text-secondary);
  background: transparent;
  border: none;
  border-radius: 6px;
  cursor: pointer;
}

.session-rename .icon-btn:hover {
  background: var(--surface-hover);
  color: var(--text-primary);
}

@media (prefers-reduced-motion: reduce) {
  .live-dot {
    animation: none;
  }

  .row-menu-trigger {
    transition: none;
  }
}
</style>