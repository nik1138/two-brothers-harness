<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue'
import { filterPalette } from '../palette'
import type { PaletteItem } from '../palette'
import AppDialog from './AppDialog.vue'
import AppIcon from './AppIcon.vue'

/**
 * Keyboard-first command palette (P1). The owner builds `items` (sessions,
 * workspaces, actions) and toggles `visible`; this component filters per
 * keystroke and drives a standard combobox/listbox: the text input keeps DOM
 * focus while `aria-activedescendant` points at the highlighted option.
 *
 * Success is a selection: emitting `select` does not close the dialog itself —
 * the owner decides what running an item means and then flips `visible`.
 */

const props = defineProps<{
  visible: boolean
  /** Already built by the owner via `buildPaletteItems`. */
  items: PaletteItem[]
}>()

const emit = defineEmits<{
  close: []
  select: [item: PaletteItem]
}>()

const KIND_ORDER = ['session', 'workspace', 'action'] as const
const KIND_LABELS: Record<PaletteItem['kind'], string> = {
  session: 'Sessions',
  workspace: 'Workspaces',
  action: 'Actions',
}

/** ids for the aria wiring; useId may contain characters that need escaping. */
const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '')
const listId = `command-palette-list-${uid}`
const labelId = (kind: PaletteItem['kind']) => `${listId}-${kind}-label`
const optionId = (index: number) => `${listId}-option-${index}`

const query = ref('')
const activeIndex = ref(0)
const inputEl = ref<HTMLInputElement | null>(null)
const listEl = ref<HTMLElement | null>(null)

/** Filtered + scored items (palette.ts caps the output). */
const results = computed(() => filterPalette(props.items ?? [], query.value))
const total = computed(() => (Array.isArray(props.items) ? props.items.length : 0))

interface PaletteGroup {
  kind: PaletteItem['kind']
  label: string
  /** Index of this group's first item in the flat display order. */
  start: number
  items: PaletteItem[]
}

/** Fixed group order (Sessions / Workspaces / Actions), score order inside. */
const groups = computed<PaletteGroup[]>(() => {
  const groups: PaletteGroup[] = []
  let start = 0
  for (const kind of KIND_ORDER) {
    const items = results.value.filter((item) => item.kind === kind)
    if (!items.length) continue
    groups.push({ kind, label: KIND_LABELS[kind], start, items })
    start += items.length
  }
  return groups
})

/** Flat order matching what is on screen; the active index points in here. */
const visibleItems = computed(() => groups.value.flatMap((group) => group.items))
const activeDescendant = computed(() =>
  activeIndex.value >= 0 ? optionId(activeIndex.value) : undefined,
)

function close(): void {
  emit('close')
}

function activate(index: number): void {
  const item = visibleItems.value[index]
  if (!item) return
  emit('select', item)
}

/** Arrow navigation with wrap-around; recovering from an empty selection. */
function move(step: number): void {
  const count = visibleItems.value.length
  if (!count) {
    activeIndex.value = -1
    return
  }
  if (activeIndex.value < 0) {
    activeIndex.value = step > 0 ? 0 : count - 1
    return
  }
  activeIndex.value = (activeIndex.value + step + count) % count
}

/**
 * Escape closes from anywhere in the palette; list navigation keys are only
 * claimed while the search input has focus (a focused footer/close button
 * keeps its native Enter/Space behavior).
 */
function onKeydown(event: KeyboardEvent): void {
  if (event.isComposing) return
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    close()
    return
  }
  if (!inputEl.value || event.target !== inputEl.value) return
  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault()
      move(1)
      break
    case 'ArrowUp':
      event.preventDefault()
      move(-1)
      break
    case 'Enter':
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
      event.preventDefault()
      activate(activeIndex.value)
      break
  }
}

watch(
  () => props.visible,
  (open) => {
    if (!open) return
    query.value = ''
    activeIndex.value = 0
    void nextTick(() => inputEl.value?.focus())
  },
  { immediate: true },
)

/** Typing restarts the highlight at the top; shrinking results stay in range. */
watch(query, () => {
  activeIndex.value = 0
  if (listEl.value) listEl.value.scrollTop = 0
})

watch(results, (items) => {
  if (!items.length) activeIndex.value = -1
  else if (activeIndex.value < 0) activeIndex.value = 0
  else if (activeIndex.value >= items.length) activeIndex.value = items.length - 1
})

/** Keep the highlighted option visible while arrowing through the list. */
watch(activeIndex, async (index) => {
  if (index < 0) return
  await nextTick()
  listEl.value
    ?.querySelector<HTMLElement>(`#${optionId(index)}`)
    ?.scrollIntoView({ block: 'nearest' })
})
</script>

<template>
  <AppDialog
    :show="visible"
    size="md"
    flush
    :show-close="false"
    aria-label="Command palette"
    initial-focus=".palette-input"
    @close="close"
  >
    <div class="command-palette" data-command-palette @keydown="onKeydown">
      <div class="palette-search">
        <AppIcon name="search" class="palette-search-icon" />
        <input
          ref="inputEl"
          v-model="query"
          class="palette-input"
          type="text"
          role="combobox"
          aria-label="Search sessions, workspaces and actions"
          aria-autocomplete="list"
          aria-expanded="true"
          :aria-controls="listId"
          :aria-activedescendant="activeDescendant"
          placeholder="Search sessions, workspaces and actions…"
          autocomplete="off"
          spellcheck="false"
        />
        <button
          type="button"
          class="palette-close"
          title="Close palette"
          aria-label="Close command palette"
          @click="close"
        >
          <AppIcon name="x" :size="16" />
        </button>
      </div>

      <div
        :id="listId"
        ref="listEl"
        class="palette-list"
        role="listbox"
        aria-label="Command palette results"
      >
        <template v-if="visibleItems.length">
          <div
            v-for="group in groups"
            :key="group.kind"
            class="palette-group"
            role="group"
            :aria-labelledby="labelId(group.kind)"
          >
            <div :id="labelId(group.kind)" class="palette-group-label">
              {{ group.label }}
              <span class="palette-group-count">{{ group.items.length }}</span>
            </div>
            <div
              v-for="(item, index) in group.items"
              :id="optionId(group.start + index)"
              :key="item.id"
              class="palette-option"
              role="option"
              :aria-selected="activeIndex === group.start + index"
              @click="activate(group.start + index)"
            >
              <span class="palette-option-label">{{ item.label }}</span>
              <span v-if="item.hint" class="palette-option-hint">{{ item.hint }}</span>
            </div>
          </div>
        </template>
        <p v-else class="palette-empty" role="status">
          <template v-if="!total">Nothing to search yet — start a session or add a workspace.</template>
          <template v-else-if="query.trim()">No matches for “{{ query.trim() }}”.</template>
          <template v-else>No commands available.</template>
        </p>
      </div>

      <footer class="palette-footer">
        <span class="palette-keys"><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
        <span class="palette-keys"><kbd>Enter</kbd> select</span>
        <span class="palette-keys"><kbd>Esc</kbd> close</span>
        <span class="palette-count">{{ visibleItems.length }} of {{ total }}</span>
      </footer>
    </div>
  </AppDialog>
</template>

<style scoped>
.command-palette {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.palette-search {
  display: flex;
  flex: none;
  align-items: center;
  gap: 0.5rem;
  padding: 0.7rem 0.9rem;
  border-bottom: 1px solid var(--border-subtle);
}

.palette-search-icon {
  flex: none;
  width: 16px;
  height: 16px;
  color: var(--text-secondary);
}

.palette-input {
  flex: 1;
  min-width: 0;
  height: 1.9rem;
  padding: 0;
  font: inherit;
  font-size: 0.98rem;
  color: var(--text-primary);
  background: transparent;
  border: none;
  outline: none;
}

.palette-input::placeholder {
  color: var(--text-secondary);
}

.palette-input:focus,
.palette-input:focus-visible {
  outline: none;
}

.palette-close {
  flex: none;
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  padding: 0;
  color: var(--text-secondary);
  background: transparent;
  border: none;
  border-radius: 5px;
  cursor: pointer;
}

.palette-close:hover {
  color: var(--text-primary);
  background: var(--surface-hover);
}

.palette-list {
  flex: 1;
  min-height: 3rem;
  max-height: min(52vh, 26rem);
  padding: 0.3rem;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.palette-group + .palette-group {
  margin-top: 0.25rem;
  padding-top: 0.25rem;
  border-top: 1px solid var(--border-subtle);
}

.palette-group-label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.35rem 0.55rem 0.25rem;
  font-size: 0.68rem;
  font-weight: 650;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-secondary);
}

.palette-group-count {
  font-weight: 500;
  letter-spacing: 0;
  opacity: 0.8;
}

.palette-option {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  min-width: 0;
  padding: 0.42rem 0.6rem;
  border-radius: var(--radius-sm);
  font-size: 0.88rem;
  cursor: pointer;
  user-select: none;
}

.palette-option:hover {
  background: var(--surface-hover);
}

.palette-option[aria-selected='true'] {
  background: var(--accent-soft);
  box-shadow: inset 0 0 0 1px var(--accent);
}

.palette-option-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.palette-option[aria-selected='true'] .palette-option-label {
  font-weight: 600;
}

.palette-option-hint {
  flex: none;
  max-width: 42%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-secondary);
  font-size: 0.75rem;
}

.palette-empty {
  margin: 0;
  padding: 1.6rem 1rem;
  color: var(--text-secondary);
  font-size: 0.86rem;
  text-align: center;
}

.palette-footer {
  display: flex;
  flex: none;
  align-items: center;
  gap: 0.85rem;
  padding: 0.45rem 0.9rem;
  border-top: 1px solid var(--border-subtle);
  color: var(--text-secondary);
  font-size: 0.72rem;
}

.palette-keys {
  display: inline-flex;
  align-items: center;
  gap: 0.2rem;
  white-space: nowrap;
}

.palette-footer kbd {
  padding: 0.05rem 0.3rem;
  font-size: 0.68rem;
  color: var(--text-secondary);
  background: var(--surface-canvas);
  border: 1px solid var(--border-subtle);
  border-radius: 4px;
}

.palette-count {
  margin-left: auto;
  white-space: nowrap;
}
</style>
