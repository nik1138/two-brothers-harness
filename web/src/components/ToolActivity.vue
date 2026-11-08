<script setup lang="ts">
import { computed, onUnmounted, shallowReactive, ref, watch } from 'vue'
import type { ToolActivityItem } from '../runtime'
import type { CommandResultPayload } from './CommandResult.vue'
import DiffView from './DiffView.vue'
import CommandResult from './CommandResult.vue'

const props = defineProps<{
  item: ToolActivityItem
}>()

/**
 * The runtime projection resolves a call by mutating the item in place, so the
 * prop object gains `status`/`result`/`finishedAt` without a reactive
 * notification (a raw object passed down as a prop does not re-render its
 * card). Mirror the rendered fields into a local shallow-reactive view, and
 * refresh it from the once-a-second ticker while the call is open. A rebuilt
 * projection replaces the item object, which the prop watcher resyncs.
 */
const view = shallowReactive({
  actor: props.item.actor,
  tool: props.item.tool,
  args: props.item.args,
  at: props.item.at,
  status: props.item.status,
  result: props.item.result,
  finishedAt: props.item.finishedAt,
})

function syncView() {
  const item = props.item
  view.actor = item.actor
  view.tool = item.tool
  view.args = item.args
  view.at = item.at
  view.status = item.status
  view.result = item.result
  view.finishedAt = item.finishedAt
}

/** Cards stay collapsed by default; expanding is a per-card choice. */
const open = ref(false)

const compact = computed(() => {
  const r = view.result
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null
  return r as Record<string, unknown>
})

/** What the tool was pointed at: a path, a shell command, or nothing useful. */
const target = computed<string | null>(() => {
  const c = compact.value
  const path = typeof c?.path === 'string' ? c.path : view.args.path
  if (typeof path === 'string' && path) return path
  const command = typeof c?.command === 'string' ? c.command : view.args.command
  if (typeof command === 'string' && command) return `$ ${command}`
  return null
})

const running = computed(() => view.status === 'running')

const failed = computed(() => !running.value && view.status !== 'ok')

const statusClass = computed(() =>
  running.value ? 'tool-running' : failed.value ? 'tool-failed' : 'tool-ok',
)

const diff = computed(() => {
  const d = compact.value?.diff
  if (!d || typeof d !== 'object') return null
  const u = (d as Record<string, unknown>).unified
  return typeof u === 'string' ? u : null
})

const diffStats = computed<{ added: number; removed: number } | null>(() => {
  const d = compact.value?.diff
  if (!d || typeof d !== 'object') return null
  const obj = d as Record<string, unknown>
  return {
    added: typeof obj.added_lines === 'number' ? obj.added_lines : 0,
    removed: typeof obj.removed_lines === 'number' ? obj.removed_lines : 0,
  }
})

/** Map a shell-like tool result onto CommandResult's payload. */
const commandResult = computed<CommandResultPayload | null>(() => {
  const c = compact.value
  if (!c) return null
  const isShell =
    typeof c.command === 'string' ||
    typeof c.exit_code === 'number' ||
    typeof c.stdout === 'string' ||
    typeof c.stderr === 'string'
  if (!isShell) return null
  const command =
    typeof c.command === 'string'
      ? c.command
      : typeof view.args.command === 'string'
        ? view.args.command
        : view.tool
  return {
    command,
    status: view.status,
    exit_code: typeof c.exit_code === 'number' ? c.exit_code : null,
    stdout: typeof c.stdout === 'string' ? c.stdout : '',
    stderr: typeof c.stderr === 'string' ? c.stderr : '',
    truncated: Boolean(c.truncated),
    duration_ms: typeof c.duration_ms === 'number' ? c.duration_ms : 0,
    error: typeof c.error === 'string' ? c.error : undefined,
  }
})

const textResult = computed<string | null>(() => {
  if (commandResult.value || diff.value) return null
  if (typeof view.result === 'string' && view.result) return view.result
  return null
})

/** Remaining args worth showing (path/command already surfaced in the header). */
const extraArgs = computed(() =>
  Object.entries(view.args).filter(
    ([k, v]) => k !== 'path' && k !== 'command' && v !== null && v !== undefined && v !== '',
  ),
)

// -- elapsed / duration (G-7) -------------------------------------------------
//
// `finishedAt` comes from the matching tool_completed event (cross-chunk
// contract 1 in the audit).

function toMillis(at: number): number {
  return at > 1e12 ? at : at * 1000
}

const startedMs = computed(() => (Number.isFinite(view.at) ? toMillis(view.at) : null))

const finishedMs = computed<number | null>(() => {
  const raw = view.finishedAt
  return typeof raw === 'number' && Number.isFinite(raw) ? toMillis(raw) : null
})

/** Reported tool time wins; otherwise the started→completed wall time. */
const durationMs = computed<number | null>(() => {
  const reported = compact.value?.duration_ms
  if (typeof reported === 'number' && reported > 0) return reported
  if (startedMs.value !== null && finishedMs.value !== null) {
    return Math.max(0, finishedMs.value - startedMs.value)
  }
  return null
})

const now = ref(Date.now())
let tickTimer: number | undefined

function tick() {
  now.value = Date.now()
  syncView()
  // An orphaned call (run stopped before tool_completed) would otherwise tick
  // forever; 30 minutes is far past any real tool invocation.
  const started = startedMs.value
  if (started !== null && now.value - started > 30 * 60_000) stopTicker()
}

function startTicker() {
  now.value = Date.now()
  if (tickTimer === undefined) {
    tickTimer = window.setInterval(tick, 1000)
  }
}

function stopTicker() {
  if (tickTimer !== undefined) {
    window.clearInterval(tickTimer)
    tickTimer = undefined
  }
}

watch(
  running,
  (isRunning) => {
    if (isRunning) startTicker()
    else stopTicker()
  },
  { immediate: true },
)

// A rebuilt projection (session load / sidecar merge) replaces the item
// object; resync immediately and resume ticking if the call is still open.
watch(
  () => props.item,
  () => {
    syncView()
    if (running.value) startTicker()
  },
)

onUnmounted(stopTicker)

function formatDuration(ms: number): string {
  const total = Math.max(0, ms)
  if (total < 60_000) return `${(total / 1000).toFixed(1)}s`
  const secs = Math.floor(total / 1000)
  return `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, '0')}s`
}

const durationText = computed<string | null>(() => {
  if (running.value) {
    if (startedMs.value === null) return null
    return formatDuration(Math.max(0, now.value - startedMs.value))
  }
  return durationMs.value === null ? null : formatDuration(durationMs.value)
})

// -- one-line summary chip ----------------------------------------------------

/** Chars of content the card would show when expanded (already backend-clipped). */
const outputChars = computed(() => {
  const c = compact.value
  if (c) {
    let n = 0
    if (typeof c.stdout === 'string') n += c.stdout.length
    if (typeof c.stderr === 'string') n += c.stderr.length
    const d = c.diff
    if (d && typeof d === 'object') {
      const unified = (d as Record<string, unknown>).unified
      if (typeof unified === 'string') n += unified.length
    }
    return n
  }
  return typeof view.result === 'string' ? view.result.length : 0
})

function formatSize(chars: number): string {
  if (chars < 1000) return `${chars} B`
  return `${(chars / 1000).toFixed(1)} kB`
}

const summaryParts = computed<string[]>(() => {
  const c = compact.value
  const parts: string[] = []
  if (diffStats.value) parts.push(`+${diffStats.value.added} -${diffStats.value.removed}`)
  if (typeof c?.exit_code === 'number') parts.push(`exit ${c.exit_code}`)
  if (c?.timed_out) parts.push('timed out')
  if (c?.cancelled) parts.push('cancelled')
  if (c?.deleted) parts.push('deleted')
  if (outputChars.value > 0) parts.push(formatSize(outputChars.value))
  if (c?.truncated) parts.push('truncated')
  return parts.slice(0, 3)
})

const toggleLabel = computed(() => (open.value ? 'Hide details' : 'Show details'))
const expandable = computed(
  () => diff.value !== null || commandResult.value !== null || textResult.value !== null || extraArgs.value.length > 0,
)
</script>

<template>
  <article
    class="tool-activity"
    :class="{ 'tool-failed-article': failed }"
    @click.self="expandable && (open = !open)"
  >
    <header class="tool-header">
      <span class="tool-actor" :class="`tool-actor-${view.actor}`">{{ view.actor }}</span>
      <code class="tool-name">{{ view.tool }}</code>
      <code v-if="target" class="tool-target" :title="target">{{ target }}</code>
      <span class="tool-meta">
        <span
          v-if="summaryParts.length"
          class="tool-summary"
          :class="{ 'tool-summary-truncated': Boolean(compact?.truncated) }"
          :title="summaryParts.join(' · ')"
        >{{ summaryParts.join(' · ') }}</span>
        <span
          v-if="durationText"
          class="tool-duration muted"
          :title="running ? 'Elapsed since the call started' : 'Time from tool start to completion'"
        >{{ durationText }}</span>
        <span class="tool-status" :class="statusClass">{{ running ? 'running…' : view.status }}</span>
        <button
          v-if="expandable"
          type="button"
          class="tool-toggle"
          :aria-expanded="open"
          :aria-label="`${toggleLabel} for ${view.tool}`"
          @click.stop="open = !open"
        >{{ open ? '▾' : '▸' }} {{ toggleLabel }}</button>
      </span>
    </header>

    <div v-show="open" class="tool-details">
      <dl v-if="extraArgs.length" class="tool-args">
        <div v-for="[k, v] in extraArgs" :key="k" class="tool-arg">
          <dt>{{ k }}</dt>
          <dd>{{ String(v) }}</dd>
        </div>
      </dl>
      <DiffView
        v-if="diff !== null"
        :diff="diff"
        :path="typeof compact?.path === 'string' ? compact.path : undefined"
      />
      <CommandResult v-else-if="commandResult" :result="commandResult" />
      <pre v-else-if="textResult" class="tool-text">{{ textResult }}</pre>
    </div>
  </article>
</template>

<style scoped>
.tool-activity {
  border: 1px solid var(--border-subtle);
  border-left: 3px solid var(--border-strong);
  border-radius: var(--radius-md);
  background: var(--surface-panel);
  overflow: hidden;
  font-size: 0.85rem;
}

.tool-failed-article {
  border-left-color: var(--danger);
}

.tool-header {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 0.4rem 0.7rem;
  flex-wrap: wrap;
}

.tool-actor {
  flex-shrink: 0;
  font-size: 0.68rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  border-radius: var(--radius-pill);
  padding: 0.08rem var(--space-2);
  color: var(--text-on-accent);
}

.tool-actor-senior {
  background: var(--accent);
}

.tool-actor-junior {
  background: var(--ok);
}

.tool-name {
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 0.78rem;
  font-weight: 600;
}

.tool-target {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 0.76rem;
  color: var(--text-secondary);
  flex: 1 1 auto;
}

.tool-meta {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  flex-shrink: 0;
  margin-left: auto;
}

.tool-summary {
  max-width: 16rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.7rem;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  color: var(--text-secondary);
  background: var(--surface-canvas);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-pill);
  padding: 0.05rem var(--space-2);
}

.tool-summary-truncated {
  color: var(--danger);
  border-color: var(--danger-soft);
}

.tool-duration {
  font-size: 0.72rem;
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}

.tool-status {
  font-size: 0.7rem;
  font-weight: 600;
  border-radius: var(--radius-pill);
  padding: 0.1rem 0.55rem;
}

.tool-ok {
  background: color-mix(in srgb, var(--ok) 15%, transparent);
  color: var(--ok);
}

.tool-failed {
  background: var(--danger-soft);
  color: var(--danger);
}

.tool-running {
  background: var(--accent-soft);
  color: var(--accent-text);
}

.tool-toggle {
  position: relative;
  z-index: 2;
  border: none;
  background: transparent;
  color: var(--accent-text);
  cursor: pointer;
  font-size: 0.78rem;
  padding: 0.15rem 0.3rem;
  border-radius: var(--radius-sm);
}

.tool-toggle:hover {
  background: var(--surface-hover);
}

.tool-details {
  border-top: 1px solid var(--border-subtle);
  padding: var(--space-2) 0.7rem 0.7rem;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.tool-args {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  font-size: 0.78rem;
}

.tool-arg {
  display: flex;
  gap: var(--space-2);
}

.tool-arg dt {
  color: var(--text-secondary);
  min-width: 5rem;
}

.tool-arg dd {
  margin: 0;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  overflow-wrap: break-word;
}

.tool-text {
  margin: 0;
  padding: 0.45rem 0.6rem;
  border-radius: var(--radius-sm);
  background: var(--surface-canvas);
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 0.78rem;
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: break-word;
  max-height: 16rem;
  overflow-y: auto;
}
</style>