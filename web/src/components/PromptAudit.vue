<script setup lang="ts">
import { computed, ref } from 'vue'
import type { PromptAuditItem } from '../runtime'

/**
 * One provider call's prompt/tool-belt audit: role, node kind, section and
 * tool counts, prompt char lengths. Collapsed by default; expanding shows the
 * section and tool name lists. Names and lengths only — the backend never
 * sends prompt bodies, so this card cannot leak them.
 */
const props = defineProps<{
  item: PromptAuditItem
}>()

const open = ref(false)

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

function formatChars(chars: number): string {
  return chars >= 1000 ? `${(chars / 1000).toFixed(1)}k` : String(chars)
}

const summaryParts = computed<string[]>(() => [
  plural(props.item.sections.length, 'section'),
  plural(props.item.tools.length, 'tool'),
  `system ${formatChars(props.item.systemChars)} ch`,
  `user ${formatChars(props.item.userChars)} ch`,
])

const toggleLabel = computed(() => (open.value ? 'Hide prompt' : 'Show prompt'))
</script>

<template>
  <article class="prompt-audit" @click.self="open = !open">
    <header class="audit-header">
      <span class="audit-role" :class="`audit-role-${item.role}`">{{ item.role }}</span>
      <code class="audit-kind" title="Node kind this provider call answers">{{ item.kind }}</code>
      <span class="audit-meta">
        <span class="audit-summary" :title="summaryParts.join(' · ')">
          {{ summaryParts.join(' · ') }}
        </span>
        <button
          type="button"
          class="audit-toggle"
          :aria-expanded="open"
          :aria-label="`${toggleLabel} for ${item.role} ${item.kind}`"
          @click.stop="open = !open"
        >{{ open ? '▾' : '▸' }} {{ toggleLabel }}</button>
      </span>
    </header>

    <div v-show="open" class="audit-details">
      <dl class="audit-lists">
        <div class="audit-list">
          <dt>Sections</dt>
          <dd>
            <template v-if="item.sections.length">
              <code v-for="name in item.sections" :key="name">{{ name }}</code>
            </template>
            <span v-else class="audit-empty">none</span>
          </dd>
        </div>
        <div class="audit-list">
          <dt>Tools</dt>
          <dd>
            <template v-if="item.tools.length">
              <code v-for="name in item.tools" :key="name">{{ name }}</code>
            </template>
            <span v-else class="audit-empty">none</span>
          </dd>
        </div>
      </dl>
    </div>
  </article>
</template>

<style scoped>
/* Lighter than a tool card on purpose: an audit is a per-call annotation,
   not an action the operator took. */
.prompt-audit {
  border: 1px solid var(--border-subtle);
  border-left: 3px solid var(--border-strong);
  border-radius: var(--radius-md);
  background: transparent;
  overflow: hidden;
  font-size: 0.78rem;
  opacity: 0.92;
}

.audit-header {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  padding: var(--space-1) 0.6rem;
  flex-wrap: wrap;
}

.audit-role {
  flex-shrink: 0;
  font-size: 0.62rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  border-radius: var(--radius-pill);
  padding: 0.05rem 0.42rem;
  color: var(--text-on-accent);
}

.audit-role-senior {
  background: var(--accent);
}

.audit-role-junior {
  background: var(--ok);
}

.audit-kind {
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 0.72rem;
  font-weight: 600;
  color: var(--text-secondary);
}

.audit-meta {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  flex: 1 1 auto;
  min-width: 0;
  margin-left: auto;
}

.audit-summary {
  flex: 1 1 auto;
  min-width: 0;
  max-width: 20rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.68rem;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  color: var(--text-secondary);
}

.audit-toggle {
  border: none;
  background: transparent;
  color: var(--accent-text);
  cursor: pointer;
  font-size: 0.72rem;
  padding: 0.1rem 0.3rem;
  border-radius: var(--radius-sm);
}

.audit-toggle:hover {
  background: var(--surface-hover);
}

.audit-details {
  border-top: 1px solid var(--border-subtle);
  padding: 0.4rem 0.6rem var(--space-2);
  background: var(--surface-panel);
}

.audit-lists {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.audit-list {
  display: flex;
  gap: var(--space-2);
}

.audit-list dt {
  color: var(--text-secondary);
  min-width: 5rem;
  font-size: 0.72rem;
}

.audit-list dd {
  margin: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
}

.audit-list code {
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 0.7rem;
  background: var(--surface-canvas);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  padding: 0 0.35rem;
}

.audit-empty {
  color: var(--text-secondary);
  font-size: 0.72rem;
}
</style>