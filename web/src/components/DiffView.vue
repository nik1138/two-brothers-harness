<script setup lang="ts">
import { computed } from 'vue'

export interface DiffObject {
  unified?: string
}

const props = defineProps<{
  diff: string | DiffObject
  path?: string
}>()

type DiffLineKind = 'add' | 'del' | 'context' | 'meta' | 'hunk'

interface DiffLine {
  kind: DiffLineKind
  text: string
}

function isDiffObject(value: string | DiffObject): value is DiffObject {
  return typeof value !== 'string'
}

const source = computed<string>(() => {
  if (isDiffObject(props.diff)) return props.diff.unified ?? ''
  return props.diff
})

const lines = computed<DiffLine[]>(() => {
  if (!source.value) return []
  const out: DiffLine[] = []
  for (const raw of source.value.split(/\r\n|\r|\n/)) {
    if (
      raw.startsWith('+++') ||
      raw.startsWith('---') ||
      raw.startsWith('diff ') ||
      raw.startsWith('index ') ||
      raw.startsWith('new file') ||
      raw.startsWith('deleted file') ||
      raw.startsWith('similarity') ||
      raw.startsWith('rename ')
    ) {
      out.push({ kind: 'meta', text: raw })
    } else if (raw.startsWith('@@')) {
      out.push({ kind: 'hunk', text: raw })
    } else if (raw.startsWith('+')) {
      out.push({ kind: 'add', text: raw })
    } else if (raw.startsWith('-')) {
      out.push({ kind: 'del', text: raw })
    } else {
      out.push({ kind: 'context', text: raw })
    }
  }
  return out
})

const added = computed(() => lines.value.filter((l) => l.kind === 'add').length)
const removed = computed(() => lines.value.filter((l) => l.kind === 'del').length)
const hunks = computed(() => lines.value.filter((l) => l.kind === 'hunk').length)

const summary = computed(
  () => `Diff of ${props.path ?? 'changes'}: ${added.value} lines added, ${removed.value} lines removed`,
)
</script>

<template>
  <figure class="diff-view">
    <figcaption class="diff-header">
      <span class="diff-path" :title="path ?? 'changes'">{{ path ?? 'changes' }}</span>
      <span class="diff-header-meta">
        <span v-if="hunks" class="diff-hunks muted">
          {{ hunks }} {{ hunks === 1 ? 'hunk' : 'hunks' }}
        </span>
        <span class="diff-stats">
          <span class="diff-added" :aria-label="`${added} added lines`">+{{ added }}</span>
          <span class="diff-removed" :aria-label="`${removed} removed lines`">-{{ removed }}</span>
        </span>
      </span>
    </figcaption>
    <div class="diff-body" role="table" :aria-label="summary">
      <pre
        v-for="(line, i) in lines"
        :key="i"
        class="diff-line"
        :class="`diff-${line.kind}`"
        role="row"
      ><span class="diff-sign" aria-hidden="true">{{
        line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '
      }}</span><code role="cell">{{ line.kind === 'meta' || line.kind === 'hunk' ? line.text : line.text.slice(1) }}</code></pre>
    </div>
    <p v-if="!lines.length" class="diff-empty muted">No diff content.</p>
  </figure>
</template>

<style scoped>
.diff-view {
  margin: 0;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--surface-panel);
  overflow: hidden;
}

.diff-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.6rem;
  padding: 0.4rem 0.7rem;
  border-bottom: 1px solid var(--border-subtle);
  background: var(--surface-panel);
  font-size: 0.78rem;
}

.diff-path {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  color: var(--text-secondary);
}

.diff-header-meta {
  display: inline-flex;
  align-items: center;
  gap: 0.55rem;
  flex-shrink: 0;
}

.diff-hunks {
  font-size: 0.72rem;
}

.diff-stats {
  display: inline-flex;
  gap: 0.5rem;
  flex-shrink: 0;
  font-weight: 600;
}

.diff-added {
  color: var(--ok);
}

.diff-removed {
  color: var(--danger);
}

/* Long diffs scroll inside the card instead of stretching the page. */
.diff-body {
  max-height: min(26rem, 55vh);
  overflow: auto;
  overscroll-behavior: contain;
  padding: 0.25rem 0;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 0.8rem;
  line-height: 1.5;
}

.diff-line {
  margin: 0;
  padding: 0 0.7rem;
  display: flex;
  gap: 0.5rem;
  white-space: pre;
}

.diff-line code {
  font: inherit;
}

.diff-sign {
  flex: 0 0 auto;
  user-select: none;
  color: var(--text-secondary);
}

.diff-add {
  background: color-mix(in srgb, var(--ok) 12%, transparent);
}

.diff-add .diff-sign {
  color: var(--ok);
}

.diff-del {
  background: color-mix(in srgb, var(--danger) 12%, transparent);
}

.diff-del .diff-sign {
  color: var(--danger);
}

.diff-hunk {
  color: var(--text-secondary);
  font-weight: 600;
}

.diff-meta {
  color: var(--text-secondary);
}

.diff-empty {
  margin: 0;
  padding: 0.6rem 0.7rem;
  font-size: 0.8rem;
}
</style>