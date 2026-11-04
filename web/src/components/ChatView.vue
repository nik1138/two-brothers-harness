<script setup lang="ts">
import { computed, defineComponent, h, nextTick, onUnmounted, ref, watch } from 'vue'
import type { PropType, VNode } from 'vue'
import { NButton } from 'naive-ui'
import { formatTime } from '../chat'
import type { ChatGroup, ChatMessage, Speaker } from '../chat'
import { nextActorLabel, timestampOf } from '../runtime'
import type { TimelineEntry } from '../runtime'
import { parseMarkdown } from '../markdown'
import type { MarkdownBlock, MarkdownInline } from '../markdown'
import ToolActivity from './ToolActivity.vue'
import ApprovalCard from './ApprovalCard.vue'
import PromptAudit from './PromptAudit.vue'
import ContextMeter from './ContextMeter.vue'

const props = defineProps<{
  timeline: TimelineEntry[]
  loading: boolean
  /** Short live-run status line shown at the end of the stream, if any. */
  activity: string | null
  /** Answer a pending approval; returns true when the backend accepted it. */
  resolveApproval: (runId: string, approvalId: string, allow: boolean) => Promise<boolean>
  /** Inline failure card at the tail of the stream (G-5 contract, optional). */
  runError?: string | null
  /** Retry handler for the failure card; the button hides when omitted. */
  onRetry?: () => void
}>()

const scrollEl = ref<HTMLElement | null>(null)
/** Pin-to-bottom only while the user is already near the bottom; reading
 * history must not be interrupted by incoming messages. */
const nearBottom = ref(true)

function onScroll() {
  const el = scrollEl.value
  if (!el) return
  nearBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 120
}

const SPEAKER_LABEL: Record<Speaker, string> = {
  operator: 'Operator',
  senior: 'Senior',
  junior: 'Junior',
}

function recipientLabel(g: ChatGroup): string {
  return g.author === 'operator' ? `to ${SPEAKER_LABEL[g.recipient]}` : `to ${SPEAKER_LABEL[g.recipient]}`
}

function initial(s: Speaker): string {
  return s === 'operator' ? 'O' : s === 'senior' ? 'S' : 'J'
}

const lastTime = computed(() => props.timeline[props.timeline.length - 1]?.time ?? 0)

/**
 * Proxy for shared-context pressure: every projected message counts, plus one
 * per tool/approval entry. Revision dividers carry no content and are skipped.
 */
const contextCount = computed(() => {
  let n = 0
  for (const row of props.timeline) {
    const e = row.entry
    if (e.type === 'group') n += e.group.messages.length
    else if (e.type === 'tool' || e.type === 'approval') n += 1
  }
  return n
})

watch(
  lastTime,
  async () => {
    await nextTick()
    const el = scrollEl.value
    if (el && nearBottom.value) el.scrollTop = el.scrollHeight
  },
  // fire at mount too: opening a session must land on the latest message,
  // not on the first one (the watcher would otherwise only react to updates)
  { immediate: true },
)

function verdictClass(m: ChatMessage): string {
  return m.verdict ? `verdict-${m.verdict}` : ''
}

function entryKey(entry: TimelineEntry['entry'], i: number): string {
  if (entry.type === 'group') return entry.group.messages[0].id
  if (entry.type === 'divider') return `divider-${entry.seq}-${i}`
  if (entry.type === 'tool') return entry.id
  if (entry.type === 'prompt_audit') return entry.id
  return `approval-${entry.approvalId}`
}

/** Envelope time for the group header; null when the group lacks a usable ts. */
function groupTime(g: ChatGroup): string | null {
  return Number.isNaN(Date.parse(g.startTs)) ? null : g.startTs
}

// -- markdown body rendering -------------------------------------------------
// parseMarkdown() returns a typed tree; every string becomes a Vue text node,
// so payload HTML is escaped by the DOM. Link protocols are allow-listed in
// markdown.ts and no v-html is used anywhere in this view.

type InlineChild = VNode | string

function inlineNodes(nodes: MarkdownInline[]): InlineChild[] {
  const out: InlineChild[] = []
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        out.push(node.text)
        break
      case 'break':
        out.push(h('br'))
        break
      case 'code':
        out.push(h('code', { class: 'md-inline-code' }, node.text))
        break
      case 'strong':
        out.push(h('strong', null, inlineNodes(node.children)))
        break
      case 'em':
        out.push(h('em', null, inlineNodes(node.children)))
        break
      case 'link':
        out.push(
          h(
            'a',
            { class: 'body-link', href: node.url, target: '_blank', rel: 'noopener noreferrer' },
            inlineNodes(node.children),
          ),
        )
        break
    }
  }
  return out
}

function renderBlock(block: MarkdownBlock): VNode {
  switch (block.type) {
    case 'paragraph':
      return h('p', { class: 'md-p' }, inlineNodes(block.inlines))
    case 'heading':
      return h(
        `h${block.level}`,
        { class: ['md-heading', `md-h${block.level}`] },
        inlineNodes(block.inlines),
      )
    case 'code':
      return h('div', { class: 'md-code' }, [
        block.lang ? h('span', { class: 'md-code-lang' }, block.lang) : null,
        h('pre', { class: 'md-pre' }, [h('code', null, block.text)]),
      ])
    case 'list': {
      const items = block.items.map((item, i) =>
        h('li', { key: i, class: ['md-li', `md-li-l${item.level}`] }, inlineNodes(item.inlines)),
      )
      return block.ordered
        ? h('ol', { class: 'md-list', start: block.start }, items)
        : h('ul', { class: 'md-list' }, items)
    }
    case 'quote':
      return h(
        'blockquote',
        { class: 'md-quote' },
        block.lines.map((line, i) =>
          h('p', { key: i, class: 'md-quote-line' }, inlineNodes(line)),
        ),
      )
    case 'table':
      return h('div', { class: 'md-table-wrap' }, [
        h('table', { class: 'md-table' }, [
          h('thead', null, [
            h(
              'tr',
              null,
              block.header.map((cell, ci) =>
                h(
                  'th',
                  { key: ci, class: `md-align-${block.align[ci] ?? 'left'}` },
                  inlineNodes(cell),
                ),
              ),
            ),
          ]),
          h(
            'tbody',
            null,
            block.rows.map((row, ri) =>
              h(
                'tr',
                { key: ri },
                row.map((cell, ci) =>
                  h(
                    'td',
                    { key: ci, class: `md-align-${block.align[ci] ?? 'left'}` },
                    inlineNodes(cell),
                  ),
                ),
              ),
            ),
          ),
        ]),
      ])
    case 'rule':
      return h('hr', { class: 'md-rule' })
    case 'note':
      return h('p', { class: 'md-note' }, block.text)
  }
}

const MarkdownBlockView = defineComponent({
  name: 'MarkdownBlockView',
  props: {
    block: { type: Object as PropType<MarkdownBlock>, required: true },
  },
  setup(blockProps) {
    return () => renderBlock(blockProps.block)
  },
})

const markdownCache = new WeakMap<ChatMessage, MarkdownBlock[]>()

function markdownBlocks(m: ChatMessage): MarkdownBlock[] {
  if (!m.body) return []
  let blocks = markdownCache.get(m)
  if (!blocks) {
    blocks = parseMarkdown(m.body)
    markdownCache.set(m, blocks)
  }
  return blocks
}

// -- timeline windowing ------------------------------------------------------
// The projection keeps the whole timeline (merge caching, context meter and the
// working line need it); rendering is capped to the newest rows so a long run
// stays responsive. "Show earlier" reveals one more page and keeps the reading
// position stable.
const WINDOW_STEP = 500
const windowSize = ref(WINDOW_STEP)
const windowStart = computed(() => Math.max(0, props.timeline.length - windowSize.value))
const hiddenCount = computed(() => windowStart.value)
const visibleTimeline = computed(() => props.timeline.slice(windowStart.value))

async function showEarlier() {
  const el = scrollEl.value
  const fromTop = el ? el.scrollHeight - el.scrollTop : 0
  windowSize.value += WINDOW_STEP
  await nextTick()
  if (el) el.scrollTop = Math.max(0, el.scrollHeight - fromTop)
}

// -- per-bubble copy ----------------------------------------------------------

const copiedId = ref<string | null>(null)
let copyTimer: number | undefined

/** Plain-text serialization of the bubble's payload fields, body first. */
function copyTextOf(m: ChatMessage): string {
  const parts: string[] = []
  if (m.title) parts.push(m.title)
  if (m.body) parts.push(m.body)
  for (const d of m.details) parts.push(`${d.label}: ${d.value}`)
  for (const l of m.lists) {
    if (l.label) parts.push(l.label)
    for (const item of l.items) parts.push(`- ${item}`)
  }
  if (m.dissent) parts.push(`dissent: ${m.dissent}`)
  return parts.join('\n')
}

async function copyMessage(m: ChatMessage) {
  try {
    await navigator.clipboard.writeText(copyTextOf(m))
    copiedId.value = m.id
    if (copyTimer !== undefined) window.clearTimeout(copyTimer)
    copyTimer = window.setTimeout(() => {
      copiedId.value = null
    }, 1500)
  } catch {
    // Clipboard unavailable (non-secure context): the button stays inert.
  }
}

// -- live "who is acting" working row ------------------------------------------

/** A run is live when the shell says so; `loading` also covers session loads. */
const runLive = computed(() => props.loading || props.activity !== null)

const now = ref(Date.now())
let tickTimer: number | undefined

watch(
  runLive,
  (live) => {
    if (live) {
      now.value = Date.now()
      if (tickTimer === undefined) {
        tickTimer = window.setInterval(() => {
          now.value = Date.now()
        }, 1000)
      }
    } else if (tickTimer !== undefined) {
      window.clearInterval(tickTimer)
      tickTimer = undefined
    }
  },
  { immediate: true },
)

onUnmounted(() => {
  if (tickTimer !== undefined) window.clearInterval(tickTimer)
  if (copyTimer !== undefined) window.clearTimeout(copyTimer)
})

const workingLine = computed(() => {
  if (!runLive.value) return null
  const tail = props.timeline[props.timeline.length - 1]?.entry
  const label = nextActorLabel(tail) ?? 'Working…'
  const at = timestampOf(tail)
  if (at === null) return label
  const secs = Math.max(0, Math.floor((now.value - at) / 1000))
  return `${label} · ${secs}s`
})
</script>

<template>
  <div class="chat-view">
    <ContextMeter :count="contextCount" />
    <div
      ref="scrollEl"
      class="chat-scroll"
      role="log"
      aria-live="polite"
      aria-label="Conversation"
      @scroll.passive="onScroll"
    >
    <p v-if="loading" class="empty-hint">Loading…</p>
    <template v-else>
      <button
        v-if="hiddenCount > 0"
        type="button"
        class="show-earlier"
        @click="showEarlier"
      >Show earlier messages ({{ hiddenCount }})</button>

      <template v-for="(row, i) in visibleTimeline" :key="entryKey(row.entry, i + windowStart)">
        <div v-if="row.entry.type === 'divider'" class="revision-divider" role="separator">
          <span class="revision-label">{{ row.entry.label }}</span>
        </div>

        <ToolActivity v-else-if="row.entry.type === 'tool'" :item="row.entry" />

        <PromptAudit v-else-if="row.entry.type === 'prompt_audit'" :item="row.entry" />

        <ApprovalCard
          v-else-if="row.entry.type === 'approval'"
          :item="row.entry"
          :resolve="resolveApproval"
        />

        <section v-else class="chat-group" :class="[`side-${row.entry.group.author}`]">
          <div class="avatar" :class="`avatar-${row.entry.group.author}`" aria-hidden="true">
            {{ initial(row.entry.group.author) }}
          </div>
          <div class="group-content">
            <header class="group-header">
              <span class="speaker-name">{{ SPEAKER_LABEL[row.entry.group.author] }}</span>
              <span class="recipient-chip">{{ recipientLabel(row.entry.group) }}</span>
              <time
                v-if="groupTime(row.entry.group)"
                class="muted"
                :datetime="row.entry.group.startTs"
              >{{ formatTime(row.entry.group.startTs) }}</time>
            </header>

            <div v-for="(m, j) in row.entry.group.messages" :key="m.id" class="bubble-wrap">
              <article
                class="bubble"
                :class="{ 'bubble-highlight': m.highlight, 'bubble-continuation': j > 0 }"
              >
                <header v-if="m.title || m.verdict || m.kind !== 'message'" class="bubble-meta">
                  <h3 v-if="m.title" class="bubble-title">{{ m.title }}</h3>
                  <span class="kind-chip">{{ m.kind }}</span>
                  <span v-if="m.verdict" class="verdict-chip" :class="verdictClass(m)">{{ m.verdict }}</span>
                </header>

                <div v-if="m.body" class="bubble-body md-body">
                  <MarkdownBlockView
                    v-for="(block, k) in markdownBlocks(m)"
                    :key="k"
                    :block="block"
                  />
                </div>

                <dl v-if="m.details.length" class="detail-list">
                  <div v-for="d in m.details" :key="d.label" class="detail-row">
                    <dt>{{ d.label }}</dt>
                    <dd>{{ d.value }}</dd>
                  </div>
                </dl>

                <div v-for="l in m.lists" :key="l.label ?? 'items'" class="detail-list-block">
                  <p v-if="l.label" class="list-label muted">{{ l.label }}</p>
                  <ul class="detail-items">
                    <li v-for="(entry, k) in l.items" :key="k">{{ entry }}</li>
                  </ul>
                </div>

                <p v-if="m.dissent" class="dissent-note">dissent: {{ m.dissent }}</p>

                <div v-if="m.confidencePct !== null" class="confidence">
                  <div class="confidence-bar" role="img" :aria-label="`confidence ${m.confidencePct}%`">
                    <div class="confidence-fill" :style="{ width: m.confidencePct + '%' }"></div>
                  </div>
                  <span class="muted small">{{ m.confidencePct }}% confident</span>
                </div>
              </article>

              <button
                type="button"
                class="bubble-copy"
                aria-label="Copy message"
                @click="copyMessage(m)"
              >{{ copiedId === m.id ? 'copied' : 'copy' }}</button>
            </div>
          </div>
        </section>
      </template>

      <p v-if="activity" class="activity-line" aria-live="polite">
        <span class="activity-dot" aria-hidden="true"></span>{{ activity }}
      </p>

      <p v-if="workingLine" class="activity-line working-line">
        <span class="activity-dot" aria-hidden="true"></span>{{ workingLine }}
      </p>

      <article v-if="runError" class="run-error" role="alert">
        <div class="run-error-head">
          <span class="run-error-title">Run failed</span>
          <n-button
            v-if="onRetry"
            size="tiny"
            type="primary"
            attr-type="button"
            @click="onRetry?.()"
          >Retry</n-button>
        </div>
        <p class="run-error-text">{{ runError }}</p>
      </article>

      <p v-if="timeline.length === 0 && !runError" class="empty-hint">
        This session has no messages yet.
      </p>
    </template>
    </div>
  </div>
</template>

<style scoped>
.chat-view {
  flex: 1;
  min-width: 0;
  /* see .chat-shell: the scroll container only works when every flex
     ancestor is allowed to shrink below its content height */
  min-height: 0;
  width: 100%;
  display: flex;
  flex-direction: column;
}

.bubble-wrap {
  position: relative;
  max-width: 46rem;
  align-self: flex-start;
}

.side-operator .bubble-wrap {
  align-self: flex-end;
}

.bubble-wrap .bubble {
  max-width: none;
}

.bubble-copy {
  position: absolute;
  top: 0.3rem;
  right: 0.4rem;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--surface-panel);
  color: var(--text-secondary);
  font-size: 0.7rem;
  line-height: 1.4;
  padding: 0.05rem 0.45rem;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.12s ease;
}

.bubble-wrap:hover .bubble-copy,
.bubble-wrap:focus-within .bubble-copy {
  opacity: 1;
}

.show-earlier {
  display: block;
  margin: 0.2rem auto 0.7rem;
  border: 1px solid var(--border-subtle);
  border-radius: 999px;
  background: var(--surface-panel);
  color: var(--text-secondary);
  font-size: 0.78rem;
  padding: 0.22rem 0.85rem;
  cursor: pointer;
}

.show-earlier:hover {
  background: var(--surface-hover);
  color: var(--text-primary);
}

.run-error {
  max-width: 46rem;
  margin: 0.5rem 0;
  border: 1px solid var(--danger);
  border-radius: var(--radius-md);
  background: var(--danger-soft);
  padding: 0.55rem 0.8rem;
}

.run-error-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.6rem;
}

.run-error-title {
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--danger);
}

.run-error-text {
  margin: 0.35rem 0 0;
  font-size: 0.86rem;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>

<style>
/* Markdown body: rendered through ChatView's MarkdownBlockView (a runtime
   render function), whose descendants do not receive the scoped-CSS attribute.
   Every rule is prefixed by .md-body / .bubble-body so nothing leaks. */
.bubble-body.md-body {
  white-space: normal;
  overflow-wrap: anywhere;
}

.md-body > :first-child {
  margin-top: 0;
}

.md-body > :last-child {
  margin-bottom: 0;
}

.md-body .md-p {
  margin: 0.35rem 0;
}

.md-body .md-heading {
  margin: 0.7rem 0 0.3rem;
  line-height: 1.35;
  font-weight: 600;
}

.md-body .md-h1 {
  font-size: 1.25rem;
}

.md-body .md-h2 {
  font-size: 1.15rem;
}

.md-body .md-h3 {
  font-size: 1.05rem;
}

.md-body .md-h4,
.md-body .md-h5,
.md-body .md-h6 {
  font-size: 0.95rem;
}

.md-body .md-list {
  margin: 0.35rem 0;
  padding-left: 1.3rem;
}

.md-body .md-li {
  margin: 0.15rem 0;
  overflow-wrap: anywhere;
}

.md-body .md-li-l1 {
  margin-left: 1.1rem;
}

.md-body .md-li-l2 {
  margin-left: 2.2rem;
}

.md-body .md-li-l3 {
  margin-left: 3.3rem;
}

.md-body .md-inline-code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace;
  font-size: 0.88em;
  background: var(--surface-hover);
  border: 1px solid var(--border-subtle);
  border-radius: 4px;
  padding: 0.02rem 0.3rem;
}

.md-body .md-code {
  margin: 0.45rem 0;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--surface-hover);
  overflow: hidden;
}

.md-body .md-code-lang {
  display: block;
  padding: 0.22rem 0.6rem;
  border-bottom: 1px solid var(--border-subtle);
  color: var(--text-secondary);
  font-size: 0.7rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.md-body .md-pre {
  margin: 0;
  padding: 0.5rem 0.65rem;
  overflow-x: auto;
  font-size: 0.85em;
  line-height: 1.45;
}

.md-body .md-pre code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace;
  white-space: pre;
}

.md-body .md-quote {
  margin: 0.45rem 0;
  padding-left: 0.7rem;
  border-left: 3px solid var(--border-strong);
  color: var(--text-secondary);
}

.md-body .md-quote-line {
  margin: 0.15rem 0;
}

.md-body .md-table-wrap {
  margin: 0.45rem 0;
  overflow-x: auto;
}

.md-body .md-table {
  border-collapse: collapse;
  font-size: 0.88rem;
}

.md-body .md-table th,
.md-body .md-table td {
  border: 1px solid var(--border-subtle);
  padding: 0.25rem 0.55rem;
  text-align: left;
}

.md-body .md-table th {
  background: var(--surface-hover);
  font-weight: 600;
}

.md-body .md-align-center {
  text-align: center;
}

.md-body .md-align-right {
  text-align: right;
}

.md-body .md-rule {
  margin: 0.7rem 0;
  border: 0;
  border-top: 1px solid var(--border-subtle);
}

.md-body .md-note {
  margin: 0.5rem 0 0;
  color: var(--text-secondary);
  font-size: 0.78rem;
  font-style: italic;
}

.md-body .body-link {
  color: var(--accent);
  text-decoration: underline;
  overflow-wrap: anywhere;
}

.side-operator .bubble .body-link {
  color: var(--text-on-accent);
}

.side-operator .bubble .md-inline-code,
.side-operator .bubble .md-code {
  background: rgba(255, 255, 255, 0.14);
  border-color: rgba(255, 255, 255, 0.32);
}

.side-operator .bubble .md-code-lang,
.side-operator .bubble .md-table th,
.side-operator .bubble .md-table td {
  border-color: rgba(255, 255, 255, 0.32);
  color: inherit;
}

.side-operator .bubble .md-quote {
  border-left-color: rgba(255, 255, 255, 0.5);
  color: rgba(255, 255, 255, 0.85);
}
</style>
