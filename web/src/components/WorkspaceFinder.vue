<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import { NButton, NInput } from 'naive-ui'
import type { InputInst } from 'naive-ui'
import { ApiError, browseFs } from '../api'
import type { FsEntry } from '../types'

/**
 * Folder-finder surface shared by the workspace dialogs: breadcrumbs, an
 * editable path (secondary), a responsive folder list and an explicit
 * confirmation. It is deliberately NOT a modal — the owning dialog renders
 * one NModal around it so the workspace flow never stacks two dialogs.
 */

const props = withDefaults(
  defineProps<{
    /** First listing; empty means the server default (drive roots / cwd). */
    initialPath?: string
    confirmLabel?: string
    busyLabel?: string
    cancelLabel?: string
    /** Optional workspace display name collected before confirmation. */
    nameField?: boolean
    namePlaceholder?: string
    /** The owner's create call is in flight: the finder freezes. */
    busy?: boolean
    /** Error text reported by the owner's create call. */
    serverError?: string | null
    label?: string
  }>(),
  {
    initialPath: '',
    confirmLabel: 'Select this folder',
    busyLabel: 'Working…',
    cancelLabel: 'Cancel',
    nameField: true,
    namePlaceholder: 'Defaults to the folder name',
    busy: false,
    serverError: null,
    label: 'Folder finder',
  },
)

const emit = defineEmits<{
  confirm: [payload: { path: string; name: string }]
  cancel: []
}>()

interface Crumb {
  label: string
  path: string
}

/** ids for aria-activedescendant; useId may contain characters CSS escapes. */
const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '')
const nameId = `wsf-name-${uid}`
const listId = `wsf-list-${uid}`

const displayPath = ref('')
const parentPath = ref<string | null>(null)
const entries = ref<FsEntry[]>([])
const truncated = ref(false)
const loading = ref(false)
const ready = ref(false)
const error = ref<string | null>(null)
const pathEditing = ref(false)
const draft = ref('')
const selectedPath = ref<string | null>(null)
const activeIndex = ref(-1)
const name = ref('')
/** The path the last listing asked for (`null` = server default), for Retry. */
const lastRequested = ref<string | null>(null)

const listEl = ref<HTMLElement | null>(null)
const crumbsEl = ref<HTMLElement | null>(null)
const pathInput = ref<InputInst | null>(null)

/** Monotonic request token: a slow response from an earlier navigation must
 * never overwrite the listing of a newer one (double-click / Enter spam). */
let loadSeq = 0
let alive = true

onBeforeUnmount(() => {
  alive = false
  loadSeq += 1
})

function errText(e: unknown): string {
  return e instanceof ApiError ? e.message : String(e)
}

function separatorFor(path: string): string {
  return path.includes('\\') ? '\\' : '/'
}

/** Display breadcrumbs for one absolute path of either platform. */
function pathCrumbs(path: string): Crumb[] {
  if (!path) return []
  const drive = /^([A-Za-z]:)[\\/]/.exec(path)
  if (drive) {
    const root = `${drive[1]}\\`
    const out: Crumb[] = [{ label: root, path: root }]
    let acc = root
    for (const part of path.slice(drive[0].length).split(/[\\/]+/).filter(Boolean)) {
      acc = acc.endsWith('\\') ? `${acc}${part}` : `${acc}\\${part}`
      out.push({ label: part, path: acc })
    }
    return out
  }
  if (path.startsWith('\\\\')) {
    const parts = path.replace(/^\\\\/, '').split(/[\\/]+/).filter(Boolean)
    if (!parts.length) return [{ label: path, path }]
    const root = `\\\\${parts[0]}\\${parts[1] ?? ''}`
    const out: Crumb[] = [{ label: root, path: root }]
    let acc = root
    for (const part of parts.slice(2)) {
      acc = `${acc}\\${part}`
      out.push({ label: part, path: acc })
    }
    return out
  }
  if (path.startsWith('/')) {
    if (path === '/') return [{ label: '/', path: '/' }]
    const out: Crumb[] = [{ label: '/', path: '/' }]
    let acc = ''
    for (const part of path.split('/').filter(Boolean)) {
      acc = `${acc}/${part}`
      out.push({ label: part, path: acc })
    }
    return out
  }
  return [{ label: path, path }]
}

const crumbs = computed(() => pathCrumbs(displayPath.value))
const targetPath = computed(() => selectedPath.value ?? (displayPath.value || null))
const canConfirm = computed(
  () => ready.value && !!targetPath.value && !props.busy && !loading.value && !error.value,
)
const listLabel = computed(() =>
  displayPath.value ? `Folders in ${displayPath.value}` : 'Folders',
)
const activeDescendant = computed(() =>
  activeIndex.value >= 0 ? optionId(activeIndex.value) : undefined,
)

function optionId(index: number): string {
  return `${listId}-${index}`
}

async function scrollCrumbsToTail(): Promise<void> {
  await nextTick()
  const el = crumbsEl.value
  if (el) el.scrollLeft = el.scrollWidth
}

async function load(next?: string): Promise<void> {
  const seq = ++loadSeq
  lastRequested.value = next ?? null
  loading.value = true
  error.value = null
  try {
    const res = await browseFs(next)
    if (!alive || seq !== loadSeq) return
    displayPath.value = res.path
    parentPath.value = res.parent
    entries.value = res.entries
    truncated.value = res.truncated
    selectedPath.value = null
    activeIndex.value = -1
    pathEditing.value = false
    ready.value = true
    await scrollCrumbsToTail()
  } catch (e) {
    if (!alive || seq !== loadSeq) return
    error.value = errText(e)
    entries.value = []
    truncated.value = false
    selectedPath.value = null
    activeIndex.value = -1
    ready.value = false
  } finally {
    if (seq === loadSeq && alive) loading.value = false
  }
}

function retry(): void {
  if (props.busy || loading.value) return
  void load(lastRequested.value ?? undefined)
}

function navigate(path?: string): void {
  if (props.busy) return
  pathEditing.value = false
  void load(path)
}

function goParent(): void {
  if (props.busy || loading.value) return
  if (parentPath.value === null) return
  navigate(parentPath.value)
}

function goHome(): void {
  if (props.busy || loading.value) return
  navigate(undefined)
}

async function startPathEdit(): Promise<void> {
  if (props.busy || loading.value) return
  const base = selectedPath.value ?? displayPath.value
  pathEditing.value = true
  if (!base) {
    draft.value = ''
  } else {
    const sep = separatorFor(base)
    draft.value = base.endsWith(sep) ? base : `${base}${sep}`
  }
  await nextTick()
  pathInput.value?.focus()
}

function commitPath(): void {
  const next = draft.value.trim()
  if (!next || props.busy) return
  pathEditing.value = false
  void load(next)
  void nextTick(() => listEl.value?.focus())
}

function cancelPathEdit(): void {
  pathEditing.value = false
  void nextTick(() => listEl.value?.focus())
}

function setActive(index: number): void {
  activeIndex.value = index
  selectedPath.value = entries.value[index]?.path ?? null
}

function clearSelection(): void {
  selectedPath.value = null
  activeIndex.value = -1
  listEl.value?.focus()
}

function openSelected(): void {
  if (activeIndex.value >= 0) openRow(activeIndex.value)
}

function onRowClick(index: number): void {
  if (props.busy || loading.value) return
  pathEditing.value = false
  listEl.value?.focus()
  setActive(index)
}

function openRow(index: number): void {
  if (props.busy || loading.value) return
  const entry = entries.value[index]
  if (!entry) return
  navigate(entry.path)
}

function onListKeydown(e: KeyboardEvent): void {
  if (props.busy || loading.value) return
  // Ctrl/Cmd+Enter is the surface-wide confirm, never "open this row".
  if (e.ctrlKey || e.metaKey) return
  const count = entries.value.length
  if (!count) return
  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault()
      setActive(activeIndex.value < 0 ? 0 : Math.min(count - 1, activeIndex.value + 1))
      break
    case 'ArrowUp':
      e.preventDefault()
      setActive(activeIndex.value < 0 ? count - 1 : Math.max(0, activeIndex.value - 1))
      break
    case 'Home':
      e.preventDefault()
      setActive(0)
      break
    case 'End':
      e.preventDefault()
      setActive(count - 1)
      break
    case 'ArrowRight':
    case 'Enter':
      if (activeIndex.value >= 0) {
        e.preventDefault()
        openRow(activeIndex.value)
      }
      break
    case 'ArrowLeft':
      e.preventDefault()
      goParent()
      break
    case ' ':
      if (activeIndex.value >= 0) {
        e.preventDefault()
        setActive(activeIndex.value)
      }
      break
  }
}

/** Ctrl/Cmd+Enter confirms from anywhere in the surface (footer hint). */
function onSurfaceKeydown(e: KeyboardEvent): void {
  if (e.isComposing) return
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault()
    confirm()
  }
}

function confirm(): void {
  if (!canConfirm.value) return
  const path = targetPath.value
  if (!path) return
  emit('confirm', { path, name: name.value.trim() })
}

function onNameEnter(e: KeyboardEvent): void {
  if (e.isComposing || e.ctrlKey || e.metaKey) return
  e.preventDefault()
  confirm()
}

watch(activeIndex, async (index) => {
  if (index < 0) return
  await nextTick()
  listEl.value
    ?.querySelector<HTMLElement>(`#${optionId(index)}`)
    ?.scrollIntoView({ block: 'nearest' })
})

onMounted(() => {
  void nextTick(() => listEl.value?.focus())
  void load(props.initialPath || undefined)
})
</script>

<template>
  <div class="wsf" role="group" :aria-label="label" @keydown="onSurfaceKeydown">
    <div class="wsf-nav">
      <button
        type="button"
        class="wsf-icon-btn"
        aria-label="Parent folder"
        title="Parent folder"
        :disabled="parentPath === null || busy || loading"
        @click="goParent"
      >
        <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <path
            d="M8 3v10M4.5 6.5 8 3l3.5 3.5"
            fill="none"
            stroke="currentColor"
            stroke-width="1.4"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>
      <button
        type="button"
        class="wsf-icon-btn"
        aria-label="Home"
        title="Home — drives on Windows, the server working directory elsewhere"
        :disabled="busy || loading"
        @click="goHome"
      >
        <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <path
            d="M2.5 7.2 8 2.8l5.5 4.4M4 6.6v6.1h8V6.6"
            fill="none"
            stroke="currentColor"
            stroke-width="1.3"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>
      <nav ref="crumbsEl" class="wsf-crumbs" aria-label="Folder path">
        <template v-if="pathEditing">
          <n-input
            ref="pathInput"
            v-model:value="draft"
            class="wsf-path-input"
            size="small"
            placeholder="Enter an absolute folder path"
            :input-props="{ 'aria-label': 'Folder path' }"
            :disabled="busy"
            @keydown.enter.prevent="commitPath"
            @keydown.esc.stop="cancelPathEdit"
          />
          <n-button
            size="tiny"
            attr-type="button"
            :disabled="!draft.trim() || busy"
            @click="commitPath"
          >
            Go
          </n-button>
        </template>
        <template v-else>
          <span v-if="!crumbs.length" class="wsf-crumb-static">Drives</span>
          <template v-for="(crumb, index) in crumbs" :key="crumb.path">
            <span v-if="index > 0" class="wsf-crumb-sep" aria-hidden="true">
              <svg viewBox="0 0 16 16" focusable="false">
                <path
                  d="m6.5 3.5 4.5 4.5-4.5 4.5"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.4"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
            </span>
            <button
              type="button"
              class="wsf-crumb"
              :aria-current="index === crumbs.length - 1 ? 'page' : undefined"
              :disabled="busy || loading"
              @click="navigate(crumb.path)"
            >
              {{ crumb.label }}
            </button>
          </template>
        </template>
      </nav>
      <button
        v-if="!pathEditing"
        type="button"
        class="wsf-icon-btn"
        aria-label="Edit path"
        title="Edit path"
        :disabled="busy || loading"
        @click="startPathEdit"
      >
        <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <path
            d="m3 13 7.9-7.9M9.4 3.6l3 3"
            fill="none"
            stroke="currentColor"
            stroke-width="1.3"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>
    </div>

    <div
      :id="listId"
      ref="listEl"
      class="wsf-list"
      :class="{ 'is-loading': loading && entries.length > 0 }"
      role="listbox"
      tabindex="0"
      :aria-label="listLabel"
      :aria-busy="loading"
      :aria-activedescendant="activeDescendant"
      @keydown="onListKeydown"
    >
      <div v-if="loading && !entries.length" class="wsf-status" role="status">
        <span class="wsf-spinner" aria-hidden="true" />
        <p>Loading folders…</p>
      </div>
      <div v-else-if="error" class="wsf-status wsf-status-error" role="alert">
        <p>{{ error }}</p>
        <n-button size="small" attr-type="button" :disabled="busy" @click="retry">
          Retry
        </n-button>
      </div>
      <div v-else-if="!entries.length" class="wsf-status">
        <p>No subfolders here.</p>
        <p class="wsf-status-hint">You can still select this folder.</p>
      </div>
      <template v-else>
        <div
          v-for="(entry, index) in entries"
          :id="optionId(index)"
          :key="entry.path"
          class="wsf-row"
          :class="{ 'is-selected': selectedPath === entry.path, 'is-active': activeIndex === index }"
          role="option"
          :aria-selected="selectedPath === entry.path"
          @click="onRowClick(index)"
          @dblclick="openRow(index)"
        >
          <svg class="wsf-row-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <path
              d="M1.8 4.4c0-.6.4-1 1-1h3l1.3 1.3h5.1c.6 0 1 .4 1 1v6c0 .6-.4 1-1 1h-9.4c-.6 0-1-.4-1-1z"
              fill="none"
              stroke="currentColor"
              stroke-width="1.2"
              stroke-linejoin="round"
            />
          </svg>
          <span class="wsf-entry-name">{{ entry.name }}</span>
          <svg class="wsf-chevron" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <path
              d="m6.5 3.5 4.5 4.5-4.5 4.5"
              fill="none"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </div>
      </template>
    </div>

    <div class="wsf-meta">
      <span v-if="loading && entries.length" role="status">Loading…</span>
      <span v-else-if="truncated">Listing truncated — showing the first folders.</span>
      <span v-else />
      <span class="wsf-hint-inline">Double-click or Enter opens a folder</span>
    </div>

    <div class="wsf-current" aria-live="polite">
      <span class="wsf-current-label">
        {{ selectedPath ? 'Selected folder' : 'Current folder' }}
      </span>
      <span class="wsf-current-path" :title="targetPath ?? undefined">
        {{ targetPath ?? 'Choose a drive' }}
      </span>
      <button
        v-if="selectedPath"
        type="button"
        class="wsf-clear"
        aria-label="Open selected folder"
        :disabled="busy || loading"
        @click="openSelected"
      >
        Open
      </button>
      <button
        v-if="selectedPath"
        type="button"
        class="wsf-clear"
        :disabled="busy || loading"
        @click="clearSelection"
      >
        Clear
      </button>
    </div>

    <div v-if="nameField" class="wsf-name">
      <label class="wsf-name-label" :for="nameId">
        Workspace name <span>(optional)</span>
      </label>
      <n-input
        v-model:value="name"
        size="small"
        :input-props="{ id: nameId }"
        :placeholder="namePlaceholder"
        :disabled="busy"
        @keydown.enter="onNameEnter"
      />
    </div>

    <p v-if="serverError" class="modal-error" role="alert">{{ serverError }}</p>

    <div class="wsf-actions">
      <span class="wsf-hint">↑↓ select · → open · ← up · Enter open · Ctrl+Enter confirm</span>
      <div class="wsf-action-buttons">
        <n-button attr-type="button" :disabled="busy" @click="emit('cancel')">
          {{ cancelLabel }}
        </n-button>
        <n-button
          attr-type="button"
          type="primary"
          :disabled="!canConfirm"
          :loading="busy"
          @click="confirm"
        >
          {{ busy ? busyLabel : confirmLabel }}
        </n-button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.wsf {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 0.55rem;
  min-height: 0;
}

.wsf-nav {
  display: flex;
  flex: none;
  align-items: center;
  gap: 0.15rem;
  min-width: 0;
  padding: 0.12rem 0.2rem;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
}

.wsf-icon-btn {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 1.8rem;
  height: 1.8rem;
  padding: 0;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}

.wsf-icon-btn svg {
  width: 1rem;
  height: 1rem;
}

.wsf-icon-btn:hover:not(:disabled) {
  background: var(--surface-hover);
  color: var(--text-primary);
}

.wsf-icon-btn:disabled {
  opacity: 0.4;
  cursor: default;
}

.wsf-crumbs {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 0.1rem;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: none;
}

.wsf-crumbs::-webkit-scrollbar {
  display: none;
}

.wsf-crumb {
  flex: none;
  max-width: 11rem;
  padding: 0.1rem 0.25rem;
  overflow: hidden;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-secondary);
  font-size: 0.82rem;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}

.wsf-crumb:hover:not(:disabled) {
  background: var(--surface-hover);
  color: var(--text-primary);
}

.wsf-crumb[aria-current='page'] {
  color: var(--text-primary);
  font-weight: 600;
}

.wsf-crumb:disabled {
  opacity: 0.65;
  cursor: default;
}

.wsf-crumb-sep {
  display: inline-flex;
  flex: none;
  color: var(--text-secondary);
  opacity: 0.65;
}

.wsf-crumb-sep svg {
  width: 0.7rem;
  height: 0.7rem;
}

.wsf-crumb-static {
  padding: 0 0.3rem;
  color: var(--text-secondary);
  font-size: 0.82rem;
  white-space: nowrap;
}

.wsf-path-input {
  flex: 1;
  min-width: 0;
}

.wsf-list {
  flex: 1;
  align-content: start;
  display: grid;
  gap: 0.125rem;
  min-height: 4.5rem;
  padding: 0.3rem;
  overflow-y: auto;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  grid-template-columns: repeat(auto-fill, minmax(11.5rem, 1fr));
  outline: none;
}

.wsf-list:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.wsf-list.is-loading {
  opacity: 0.55;
}

.wsf-row {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  min-width: 0;
  padding: 0.4rem 0.5rem;
  border-radius: var(--radius-sm);
  font-size: 0.85rem;
  cursor: pointer;
  user-select: none;
}

.wsf-row:hover {
  background: var(--surface-hover);
}

.wsf-row.is-selected {
  background: var(--accent-soft);
}

.wsf-row.is-active {
  box-shadow: inset 0 0 0 1.5px var(--accent);
}

.wsf-row-icon {
  flex: none;
  width: 1rem;
  height: 1rem;
  color: var(--text-secondary);
}

.wsf-row.is-selected .wsf-row-icon {
  color: var(--accent);
}

.wsf-entry-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wsf-chevron {
  flex: none;
  width: 0.75rem;
  height: 0.75rem;
  color: var(--text-secondary);
  opacity: 0;
}

.wsf-row:hover .wsf-chevron {
  opacity: 0.8;
}

.wsf-status {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.45rem;
  padding: 1.6rem 1rem;
  color: var(--text-secondary);
  font-size: 0.85rem;
  text-align: center;
  grid-column: 1 / -1;
}

.wsf-status p {
  margin: 0;
}

.wsf-status-hint {
  font-size: 0.78rem;
  opacity: 0.85;
}

.wsf-status-error {
  color: var(--danger);
}

.wsf-spinner {
  width: 0.9rem;
  height: 0.9rem;
  border: 2px solid var(--border-strong);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: wsf-spin 0.8s linear infinite;
}

@keyframes wsf-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .wsf-spinner {
    animation: none;
  }
}

.wsf-meta {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  min-height: 0.9rem;
  padding: 0 0.15rem;
  color: var(--text-secondary);
  font-size: 0.72rem;
}

.wsf-hint-inline {
  margin-left: auto;
}

.wsf-current {
  display: flex;
  flex: none;
  align-items: center;
  gap: 0.45rem;
  min-width: 0;
  font-size: 0.78rem;
}

.wsf-current-label {
  flex: none;
  color: var(--text-secondary);
}

.wsf-current-path {
  min-width: 0;
  overflow: hidden;
  color: var(--text-primary);
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 0.76rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wsf-clear {
  flex: none;
  padding: 0.1rem 0.25rem;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--accent);
  font-size: 0.76rem;
  cursor: pointer;
}

.wsf-clear:hover:not(:disabled) {
  background: var(--surface-hover);
}

.wsf-name {
  display: flex;
  flex: none;
  flex-direction: column;
  gap: 0.25rem;
}

.wsf-name-label {
  color: var(--text-secondary);
  font-size: 0.78rem;
}

.wsf-name-label span {
  opacity: 0.8;
}

.wsf-actions {
  display: flex;
  flex: none;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.6rem;
}

.wsf-hint {
  margin-right: auto;
  color: var(--text-secondary);
  font-size: 0.72rem;
}

.wsf-action-buttons {
  display: flex;
  gap: 0.5rem;
  margin-left: auto;
}

@media (max-width: 720px) {
  .wsf-hint,
  .wsf-hint-inline {
    display: none;
  }
}

@media (max-width: 480px) {
  .wsf-list {
    grid-template-columns: 1fr;
  }

  .wsf-action-buttons {
    width: 100%;
    justify-content: flex-end;
  }
}
</style>