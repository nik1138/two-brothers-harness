<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { NCollapse, NCollapseItem } from 'naive-ui'
import type { ChangedFile } from '../runtime'
import DiffView from './DiffView.vue'

const props = defineProps<{
  files: ChangedFile[]
}>()

/**
 * Collapsed by default (G-4): the panel sits between the chat and the
 * composer, so it must never push the input off-screen on edit-heavy runs.
 * The choice is remembered for as long as the component stays mounted (one
 * session); the visible summary chip carries everything needed at a glance.
 */
const open = ref(false)

/** Files that arrived while collapsed; cleared as soon as the panel expands. */
const unseen = ref(0)
const bumping = ref(false)
const seenPaths = ref(new Set(props.files.map((f) => f.path)))

let bumpTimer: number | undefined

const totals = computed(() =>
  props.files.reduce(
    (acc, f) => ({ added: acc.added + f.added, removed: acc.removed + f.removed }),
    { added: 0, removed: 0 },
  ),
)

/** A short path preview keeps the collapsed chip informative without expanding. */
const previewPaths = computed(() => props.files.slice(0, 3))
const previewExtra = computed(() => Math.max(0, props.files.length - previewPaths.value.length))

const summaryLabel = computed(
  () =>
    `Changed files: ${props.files.length}, +${totals.value.added} -${totals.value.removed}. ` +
    (open.value ? 'Collapse' : 'Expand'),
)

watch(
  () => props.files,
  (files) => {
    const fresh = files.filter((f) => !seenPaths.value.has(f.path))
    if (!open.value && fresh.length > 0) {
      unseen.value += fresh.length
      bumping.value = true
      if (bumpTimer !== undefined) window.clearTimeout(bumpTimer)
      bumpTimer = window.setTimeout(() => {
        bumping.value = false
      }, 1600)
    }
    seenPaths.value = new Set(files.map((f) => f.path))
  },
)

watch(open, (isOpen) => {
  if (isOpen) unseen.value = 0
})

onUnmounted(() => {
  if (bumpTimer !== undefined) window.clearTimeout(bumpTimer)
})
</script>

<template>
  <section
    class="diff-review"
    :class="{ 'diff-review-bump': bumping }"
    aria-label="Changed files"
  >
    <button
      type="button"
      class="diff-review-toggle"
      :aria-expanded="open"
      :aria-label="summaryLabel"
      @click="open = !open"
    >
      <span class="diff-review-title">Changed files</span>
      <span class="diff-review-count">{{ files.length }}</span>
      <span class="diff-review-totals">
        <span class="diff-added">+{{ totals.added }}</span>
        <span class="diff-removed">-{{ totals.removed }}</span>
      </span>
      <span v-if="unseen > 0" class="diff-review-new">{{ unseen }} new</span>
      <span v-if="!open && previewPaths.length" class="diff-review-preview">
        <span
          v-for="f in previewPaths"
          :key="f.path"
          class="diff-review-file-path"
          :title="f.path"
        >{{ f.path }}</span>
        <span v-if="previewExtra" class="diff-review-more muted">+{{ previewExtra }} more</span>
      </span>
      <span class="diff-review-chevron" aria-hidden="true">{{ open ? '▾' : '▸' }}</span>
    </button>

    <div v-show="open" class="diff-review-body">
      <n-collapse class="diff-review-files">
        <n-collapse-item
          v-for="(f, i) in files"
          :key="`${f.path}-${i}`"
          :name="i"
          class="diff-review-file"
        >
          <template #header>
            <span class="diff-review-file-path" :title="f.path">{{ f.path }}</span>
          </template>
          <template #header-extra>
            <span class="diff-review-file-meta muted">{{ f.tool }}</span>
            <span class="diff-review-file-stats">
              <span class="diff-added" :aria-label="`${f.added} added lines`">+{{ f.added }}</span>
              <span class="diff-removed" :aria-label="`${f.removed} removed lines`">-{{ f.removed }}</span>
            </span>
          </template>
          <DiffView :diff="f.unified" :path="f.path" />
        </n-collapse-item>
      </n-collapse>
      <p v-if="files.length === 0" class="diff-review-empty muted">No file changes recorded.</p>
    </div>
  </section>
</template>

<style scoped>
.diff-review {
  flex: 0 0 auto;
  width: 100%;
  max-width: 880px;
  margin: 0 auto;
  padding: 0 1.25rem 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.diff-review-toggle {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-width: 0;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--surface-panel);
  padding: 0.4rem 0.7rem;
  cursor: pointer;
  font-size: 0.82rem;
  color: var(--text-primary);
  text-align: left;
}

.diff-review-toggle:hover {
  background: var(--surface-hover);
}

.diff-review-bump .diff-review-toggle {
  animation: diff-review-pulse 1.6s ease-out;
}

@keyframes diff-review-pulse {
  0% {
    border-color: var(--accent);
    box-shadow: 0 0 0 2px var(--accent-soft);
  }
  100% {
    border-color: var(--border-subtle);
    box-shadow: 0 0 0 0 transparent;
  }
}

@media (prefers-reduced-motion: reduce) {
  .diff-review-bump .diff-review-toggle {
    animation: none;
    border-color: var(--accent);
  }
}

.diff-review-title {
  flex-shrink: 0;
  font-weight: 600;
}

.diff-review-count {
  flex-shrink: 0;
  font-size: 0.72rem;
  font-weight: 600;
  border-radius: 999px;
  padding: 0.05rem 0.5rem;
  background: var(--accent-soft);
  color: var(--accent);
}

.diff-review-totals {
  display: inline-flex;
  gap: 0.4rem;
  flex-shrink: 0;
  font-weight: 600;
}

.diff-review-new {
  flex-shrink: 0;
  font-size: 0.7rem;
  font-weight: 600;
  border-radius: 999px;
  padding: 0.05rem 0.45rem;
  background: color-mix(in srgb, var(--ok) 16%, transparent);
  color: var(--ok);
}

.diff-review-preview {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  min-width: 0;
  overflow: hidden;
  flex: 0 1 auto;
}

.diff-review-preview .diff-review-file-path {
  flex: 0 1 auto;
  max-width: 13rem;
  font-size: 0.75rem;
}

.diff-review-more {
  flex-shrink: 0;
  font-size: 0.72rem;
}

.diff-review-chevron {
  flex-shrink: 0;
  margin-left: auto;
  color: var(--text-secondary);
}

/* Expanded: the file list scrolls inside the panel, never stretching the page. */
.diff-review-body {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  max-height: min(28rem, 60vh);
  overflow-y: auto;
  overscroll-behavior: contain;
}

/* Each changed file is a collapse item styled like the previous custom rows. */
.diff-review-files :deep(.n-collapse-item) {
  border-top: none;
  margin-top: 0.4rem;
}

.diff-review-files :deep(.n-collapse-item:first-child) {
  margin-top: 0;
}

.diff-review-files :deep(.n-collapse-item__header) {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--surface-panel);
  padding: 0.35rem 0.7rem;
  font-size: 0.8rem;
}

.diff-review-files :deep(.n-collapse-item__header:hover) {
  background: var(--surface-hover);
}

.diff-review-files :deep(.n-collapse-item__header-main) {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  flex: 1 1 auto;
  min-width: 0;
}

.diff-review-files :deep(.n-collapse-item__header-extra) {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  flex-shrink: 0;
}

.diff-review-files :deep(.n-collapse-item__content-inner) {
  padding-top: 0.3rem;
}

.diff-review-file-path {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
}

.diff-review-file-meta {
  flex-shrink: 0;
  font-size: 0.72rem;
}

.diff-review-file-stats {
  display: inline-flex;
  gap: 0.4rem;
  flex-shrink: 0;
  font-weight: 600;
}

.diff-review-files :deep(.diff-view) {
  margin-left: 0.5rem;
}

.diff-added {
  color: var(--ok);
}

.diff-removed {
  color: var(--danger);
}

.diff-review-empty {
  margin: 0;
  font-size: 0.8rem;
  padding: 0 0.2rem;
}
</style>