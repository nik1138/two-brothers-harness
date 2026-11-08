<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import type { RunCost, RunUsage } from '../types'
import { costLabel, costTitle } from '../usageCost'

const props = defineProps<{
  /** A run this app follows is actively working on the selected session. */
  live: boolean
  /** The followed run is parked on an operator approval (G-1). */
  waiting?: boolean
  /** Epoch ms when the followed run started working (drives the ticker). */
  startedAt: number | null
  /** Operator turns in the selected session (envelopes from the user). */
  turns: number
  /** Latest known usage for the selected session; null when unavailable. */
  usage: RunUsage | null
  /**
   * Latest known run cost estimate for the session; null/absent = unknown.
   * The segment is omitted entirely in that case (never "$0.00").
   */
  cost?: RunCost | null
}>()

const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | null = null

/** The clock keeps running while the run is alive — working or waiting. */
const ticking = computed(() => props.live || props.waiting === true)

watch(
  ticking,
  (on) => {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
    if (on) {
      now.value = Date.now()
      timer = setInterval(() => {
        now.value = Date.now()
      }, 1000)
    }
  },
  { immediate: true },
)

onUnmounted(() => {
  if (timer) clearInterval(timer)
})

const elapsed = computed(() => {
  if (!props.startedAt) return ''
  const total = Math.max(0, Math.floor((now.value - props.startedAt) / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const ss = String(s).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
})

const cachePct = computed(() => {
  const u = props.usage
  if (!u || u.input_tokens <= 0) return null
  return Math.round((u.cached_tokens / u.input_tokens) * 100)
})

/** `~$0.0312 est.`, or null when the backend could not attribute a cost. */
const costText = computed(() => costLabel(props.cost))
/** Tooltip: the priced model plus "estimated …, not a bill". */
const costTitleText = computed(() => costTitle(props.cost))

const visible = computed(() => ticking.value || props.usage !== null || props.turns > 0)
</script>

<template>
  <!-- No aria-live: the elapsed time ticks every second while a run is alive,
       which would re-announce the region continuously to screen readers. -->
  <footer v-if="visible" class="usage-footer">
    <template v-if="waiting">
      <span class="usage-dot usage-dot-waiting" aria-hidden="true"></span>
      <span>{{ elapsed ? `${elapsed} · ` : '' }}waiting for approval</span>
    </template>
    <template v-else-if="live">
      <span class="usage-dot" aria-hidden="true"></span>
      <span>{{ elapsed ? `${elapsed} · ` : '' }}working…</span>
    </template>
    <template v-else>
      <span>{{ turns }} {{ turns === 1 ? 'turn' : 'turns' }}</span>
      <template v-if="usage">
        <span class="usage-sep" aria-hidden="true">·</span>
        <span
          >in {{ usage.input_tokens.toLocaleString('en-US') }} / out
          {{ usage.output_tokens.toLocaleString('en-US') }} tok</span
        >
        <template v-if="cachePct !== null">
          <span class="usage-sep" aria-hidden="true">·</span>
          <span>cache {{ cachePct }}%</span>
        </template>
        <template v-if="usage.model_calls > 0">
          <span class="usage-sep" aria-hidden="true">·</span>
          <span
            >{{ usage.model_calls }}
            {{ usage.model_calls === 1 ? 'model call' : 'model calls' }}</span
          >
        </template>
        <template v-if="costText !== null">
          <span class="usage-sep" aria-hidden="true">·</span>
          <span class="usage-cost" :title="costTitleText ?? undefined">{{ costText }}</span>
        </template>
      </template>
    </template>
  </footer>
</template>

<style scoped>
.usage-footer {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-wrap: wrap;
  gap: 0.3rem 0.45rem;
  width: 100%;
  max-width: 880px;
  margin: 0 auto;
  padding: 0 var(--space-5) 0.4rem;
  font-size: 0.75rem;
  color: var(--text-secondary);
}

.usage-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--ok);
  animation: usage-pulse 1.4s ease-in-out infinite;
}

.usage-dot-waiting {
  background: var(--warning);
  animation-duration: 2.4s;
}

@keyframes usage-pulse {
  50% {
    opacity: 0.35;
  }
}

.usage-sep {
  opacity: 0.7;
}

/* The estimate's tooltip carries the model/disclaimer; hint that it is hoverable. */
.usage-cost {
  cursor: help;
}
</style>
