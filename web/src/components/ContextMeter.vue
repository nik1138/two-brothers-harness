<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  /** Projected messages + tool/approval entries currently in the shared context. */
  count: number
}>()

const NOTE_MIN = 30
const WARN_MIN = 80

const level = computed<'hidden' | 'note' | 'warning'>(() =>
  props.count >= WARN_MIN ? 'warning' : props.count >= NOTE_MIN ? 'note' : 'hidden',
)
</script>

<template>
  <p v-if="level !== 'hidden'" class="context-meter" :class="`context-meter-${level}`" role="status">
    <span class="context-meter-count">{{ count }} messages in context</span>
    <span v-if="level === 'warning'" class="context-meter-nudge">
      Context is getting long — consider a new session for best results.
    </span>
  </p>
</template>

<style scoped>
.context-meter {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--space-2);
  width: 100%;
  max-width: 880px;
  margin: 0 auto;
  padding: 0.55rem var(--space-5) 0;
  font-size: 0.78rem;
  line-height: 1.4;
}

.context-meter-count {
  color: var(--text-secondary);
}

.context-meter-note .context-meter-count {
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-pill);
  background: var(--surface-panel);
  padding: 0.1rem 0.6rem;
}

.context-meter-warning .context-meter-count {
  border: 1px solid var(--warning);
  border-radius: var(--radius-pill);
  background: var(--warning-soft);
  color: var(--warning);
}

.context-meter-nudge {
  color: var(--warning);
}
</style>
