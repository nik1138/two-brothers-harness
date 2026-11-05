<script setup lang="ts">
import { computed } from 'vue'
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
}>()

const emit = defineEmits<{
  toggleCollapse: []
  toggleExpand: []
  select: [name: string]
  refresh: []
  deleted: [name: string]
}>()

const liveSet = computed(() => new Set(props.liveNames))

const groupLabel = computed(() => {
  const sessions = props.total === 1 ? '1 session' : `${props.total} sessions`
  return props.unassigned ? `${props.label}, ${sessions}` : `Workspace ${props.label}, ${sessions}`
})
</script>

<template>
  <section class="session-group">
    <h3 v-if="collapsible" class="group-heading">
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
    </h3>

    <ul v-show="!collapsed" :id="listId" class="session-list">
      <SessionRow
        v-for="s in items"
        :key="s.name"
        :session="s"
        :active="s.name === selected"
        :live="liveSet.has(s.name)"
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
  border-radius: 6px;
  cursor: pointer;
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
  border-radius: 999px;
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
  border-radius: 6px;
  cursor: pointer;
}

.group-more:hover {
  background: var(--surface-hover);
  color: var(--text-primary);
}

.group-more:focus-visible {
  outline-offset: -2px;
}

@media (prefers-reduced-motion: reduce) {
  .group-chevron {
    transition: none;
  }
}
</style>