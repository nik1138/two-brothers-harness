<script setup lang="ts">
import { computed, defineComponent, h, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type { PropType, VNode } from 'vue'
import { NButton } from 'naive-ui'
import { formatTime } from '../chat'
import type { ChatGroup, ChatMessage, Speaker } from '../chat'
import { findMatches, nextMatch, prevMatch } from '../find'
import type { FindMatch } from '../find'
import { nextActorLabel, timestampOf } from '../runtime'
import type { TimelineEntry } from '../runtime'
import { parseMarkdown } from '../markdown'
import type { MarkdownBlock, MarkdownInline } from '../markdown'
import ToolActivity from './ToolActivity.vue'
import ApprovalCard from './ApprovalCard.vue'
import PromptAudit from './PromptAudit.vue'
import ContextMeter from './ContextMeter.vue'
import AppIcon from './AppIcon.vue'

const props = defineProps<{
  timeline: TimelineEntry[]
  loading: boolean
  /** Short live-run status line shown at the end of the stream, if any. */
  activity: string | null
  /** Answer a pending approval; returns true when the backend accepted it. */
  resolveApproval: (runId: string, approvalId: string, allow: boolean) => Promise<boolean>
  /** Approval currently docked above the composer; its pending timeline card is
   * suppressed (the dock is its live surface), resolved cards stay in history. */
  dockedApprovalId?: string | null
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

/** Keep the transcript pinned when chrome (the find bar) changes its height. */
function keepPinnedToBottom() {
  const el = scrollEl.value
  if (el && nearBottom.value) el.scrollTop = el.scrollHeight
}

const SPEAKER_LABEL: Record<Speaker, string> = {
  operator: 'Operator',
  senior: 'Senior',
  junior: 'Junior',
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
    else if (e.type === 'system' || e.type === 'tool' || e.type === 'approval') n += 1
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
  if (entry.type === 'system') return entry.activity.id
  if (entry.type === 'tool') return entry.id
  if (entry.type === 'prompt_audit') return entry.id
  return `approval-${entry.approvalId}`
}

/** Pending approvals surfaced by the dock above the composer hide their
 * duplicate timeline card; resolved approvals always render as history. */
function isDockedApproval(entry: TimelineEntry['entry']): boolean {
  return (
    entry.type === 'approval' &&
    entry.decision === undefined &&
    entry.approvalId === props.dockedApprovalId
  )
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

// -- find in transcript (Ctrl+F / Cmd+F) --------------------------------------
// Search covers the rendered conversation only: blocks are collected from the
// transcript DOM when the bar opens (or when the rendered window changes), so
// sidebar/composer text can never match and the matcher sees exactly the text
// the markdown renderer printed. find.ts owns the matching semantics. Indexed
// regions are the always-visible conversation text (message titles/bodies,
// dissent notes, system activities, tool/approval/audit headers and bodies);
// collapsed drill-down drawers are left out so the counter never points at
// text that cannot be painted.
//
// Escape layering, topmost first: command palette → dialogs → mobile drawer →
// this find bar. The palette and every dialog are modal AppDialogs with
// role="dialog"; the drawer marks the chat shell inert. A keydown while any of
// those is above the bar is deliberately left to that layer, so Ctrl+F cannot
// open a second search surface behind a modal and Escape cannot dismiss the bar
// through a dialog. `Esc` otherwise closes the bar and clears its highlights.
// The palette shortcut (Ctrl+K) and the composer's Enter/Shift+Enter are never
// touched: Enter is claimed only while the find input has focus.
//
// Highlighting uses the CSS Custom Highlight API (Range objects registered by
// name), so no <mark> wrappers are inserted: Vue's text nodes, copy behavior
// and the transcript structure stay untouched. Browsers without the API still
// get the counter and scroll-to-match. App.vue keys ChatView by session, so a
// session switch remounts this component — the bar, its focus and its highlight
// registry entries therefore cannot leak across sessions (unmount clears the
// global registry explicitly as well).

const FIND_TEXT_SELECTOR = [
  '.bubble-title',
  '.bubble-body',
  '.dissent-note',
  '.system-activity',
  '.tool-header',
  '.approval-header',
  '.approval-body',
  '.audit-header',
].join(', ')

const FIND_HIGHLIGHT_ALL = 'two-brothers-find'
const FIND_HIGHLIGHT_ACTIVE = 'two-brothers-find-active'
const FIND_SCROLL_PAD = 16

/** One rendered text region: its concatenated text and the DOM nodes behind it. */
interface FindTextBlock {
  text: string
  nodes: Text[]
  el: HTMLElement
}

interface FindHighlightRegistry {
  set(name: string, highlight: Highlight): void
  delete(name: string): void
}

/**
 * CSS Custom Highlight API when the browser supports it. TypeScript's DOM lib
 * (5.6) declares the registry incompletely, so the two calls this view needs
 * are typed through `FindHighlightRegistry`; the runtime check keeps older
 * browsers on the no-highlight fallback instead of throwing.
 */
const findHighlights: FindHighlightRegistry | null = (() => {
  if (typeof CSS === 'undefined' || typeof Highlight !== 'function') return null
  const registry = (CSS as unknown as { highlights?: unknown }).highlights
  if (!registry || typeof (registry as FindHighlightRegistry).set !== 'function') return null
  return registry as FindHighlightRegistry
})()

const findOpen = ref(false)
const findQuery = ref('')
const findCaseSensitive = ref(false)
const findActiveIndex = ref(-1)
const findTotal = ref(0)
const findInputEl = ref<HTMLInputElement | null>(null)

const findStatus = computed(() => {
  if (!findOpen.value || findQuery.value.trim() === '') return ''
  if (findTotal.value === 0) return 'No results'
  return `${findActiveIndex.value + 1}/${findTotal.value}`
})

/** Searchable blocks, collected lazily and invalidated whenever they re-render. */
let findBlocks: FindTextBlock[] | null = null
let findResults: FindMatch[] = []
let findReturnFocus: HTMLElement | null = null

function collectFindBlocks(): FindTextBlock[] {
  const root = scrollEl.value
  if (!root) return []
  const blocks: FindTextBlock[] = []
  for (const el of root.querySelectorAll<HTMLElement>(FIND_TEXT_SELECTOR)) {
    const nodes: Text[] = []
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    let node = walker.nextNode()
    while (node !== null) {
      const text = node as Text
      if (text.data.length > 0) nodes.push(text)
      node = walker.nextNode()
    }
    if (nodes.length === 0) continue
    blocks.push({ text: nodes.map((text) => text.data).join(''), nodes, el })
  }
  return blocks
}

interface FindTextPoint {
  node: Text
  offset: number
}

/** DOM point for a character offset inside one block; null on a stale block. */
function findTextPoint(block: FindTextBlock, target: number): FindTextPoint | null {
  if (target === block.text.length) {
    const last = block.nodes[block.nodes.length - 1]
    return last ? { node: last, offset: last.data.length } : null
  }
  let base = 0
  for (const node of block.nodes) {
    const end = base + node.data.length
    if (target >= base && target < end) return { node, offset: target - base }
    base = end
  }
  return null
}

function findRange(match: FindMatch): Range | null {
  const block = findBlocks?.[match.blockIndex]
  if (!block) return null
  const start = findTextPoint(block, match.start)
  const end = findTextPoint(block, match.end)
  if (!start || !end) return null
  const range = document.createRange()
  range.setStart(start.node, start.offset)
  range.setEnd(end.node, end.offset)
  return range
}

function clearFindHighlights() {
  findHighlights?.delete(FIND_HIGHLIGHT_ALL)
  findHighlights?.delete(FIND_HIGHLIGHT_ACTIVE)
}

function paintFindHighlights() {
  if (!findHighlights) return
  const ranges: Range[] = []
  for (const match of findResults) {
    const range = findRange(match)
    if (range) ranges.push(range)
  }
  if (ranges.length === 0) {
    clearFindHighlights()
    return
  }
  const activeResult =
    findActiveIndex.value >= 0 ? findResults[findActiveIndex.value] : undefined
  const activeRange = activeResult ? findRange(activeResult) : null
  try {
    const allHighlight = new Highlight(...ranges)
    allHighlight.priority = 0
    findHighlights.set(FIND_HIGHLIGHT_ALL, allHighlight)
    if (activeRange) {
      const activeHighlight = new Highlight(activeRange)
      // paint the active hit over the subtle set even where ranges coincide
      activeHighlight.priority = 1
      findHighlights.set(FIND_HIGHLIGHT_ACTIVE, activeHighlight)
    } else {
      findHighlights.delete(FIND_HIGHLIGHT_ACTIVE)
    }
  } catch {
    // A pathological number of ranges can hit engine limits; the counter and
    // scroll-to-match are more important than the paint.
    clearFindHighlights()
  }
}

/**
 * Bring the active match into view with `block: 'nearest'` semantics (a Range
 * has no scrollIntoView): only move the transcript when the match is outside
 * the visible band, and align it to the near edge instead of centering it.
 * Smooth scrolling is skipped under `prefers-reduced-motion: reduce`.
 */
function revealActiveMatch() {
  const match = findActiveIndex.value >= 0 ? findResults[findActiveIndex.value] : undefined
  const el = scrollEl.value
  if (!match || !el) return
  const range = findRange(match)
  if (!range) return
  const rect = range.getBoundingClientRect()
  const view = el.getBoundingClientRect()
  // A match inside a collapsed detail (e.g. a tool result) has an empty rect;
  // fall back to the owning block so at least its card is revealed.
  const block = findBlocks?.[match.blockIndex]
  const target =
    rect.width > 0 || rect.height > 0 ? rect : (block?.el.getBoundingClientRect() ?? null)
  if (!target) return

  let delta = 0
  if (target.top < view.top + FIND_SCROLL_PAD) {
    delta = target.top - view.top - FIND_SCROLL_PAD
  } else if (target.bottom > view.bottom - FIND_SCROLL_PAD) {
    delta = target.bottom - view.bottom + FIND_SCROLL_PAD
  }
  if (delta === 0) return
  const top = Math.max(0, Math.min(el.scrollTop + delta, el.scrollHeight - el.clientHeight))
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  el.scrollTo({ top, behavior: reduceMotion ? 'auto' : 'smooth' })
}

/** Re-match the cached blocks; `resetActive` selects the first match afresh. */
function rebuildFind(resetActive: boolean) {
  if (findBlocks === null) findBlocks = collectFindBlocks()
  findResults = findMatches(findBlocks, findQuery.value, {
    caseSensitive: findCaseSensitive.value,
  })
  const total = findResults.length
  findTotal.value = total
  if (total === 0) {
    findActiveIndex.value = -1
  } else if (resetActive || findActiveIndex.value < 0 || findActiveIndex.value >= total) {
    findActiveIndex.value = 0
  }
  paintFindHighlights()
}

function moveFind(direction: 1 | -1) {
  if (findTotal.value === 0) return
  findActiveIndex.value =
    direction === 1
      ? nextMatch(findActiveIndex.value, findTotal.value)
      : prevMatch(findActiveIndex.value, findTotal.value)
  paintFindHighlights()
  revealActiveMatch()
}

/** True while a modal or the mobile drawer is above the find bar (Escape order). */
function findLayerAbove(): boolean {
  return (
    document.querySelector('[role="dialog"]') !== null ||
    document.querySelector('.chat-shell[inert]') !== null
  )
}

function openFind() {
  if (findLayerAbove()) return
  if (findOpen.value) {
    findInputEl.value?.focus()
    findInputEl.value?.select()
    return
  }
  const active = document.activeElement
  findReturnFocus = active instanceof HTMLElement ? active : null
  findOpen.value = true
  void nextTick(() => {
    if (!findOpen.value) return
    findInputEl.value?.focus()
    findInputEl.value?.select()
    // the bar takes layout height; keep a bottom-pinned reader at the bottom
    keepPinnedToBottom()
    rebuildFind(true)
    revealActiveMatch()
  })
}

function closeFind() {
  if (!findOpen.value) return
  findOpen.value = false
  findActiveIndex.value = -1
  findTotal.value = 0
  findResults = []
  findBlocks = null
  clearFindHighlights()
  const back = findReturnFocus
  findReturnFocus = null
  if (back?.isConnected) back.focus({ preventScroll: true })
  void nextTick(keepPinnedToBottom)
}

function onFindEnter(event: KeyboardEvent) {
  if (event.isComposing) return
  event.preventDefault()
  moveFind(event.shiftKey ? -1 : 1)
}

/**
 * Window capture phase: Ctrl+F must be claimed before the browser opens its
 * own find UI, and Escape must reach this layer before the shell's drawer
 * handler. Both are gated on `findLayerAbove()` so the documented order holds.
 */
function onFindKeydown(event: KeyboardEvent) {
  if (event.defaultPrevented || event.isComposing) return
  if (event.key === 'Escape') {
    if (!findOpen.value || findLayerAbove()) return
    event.preventDefault()
    closeFind()
    return
  }
  if (event.repeat) return
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return
  if (event.key.toLowerCase() !== 'f') return
  if (findLayerAbove()) return
  event.preventDefault()
  openFind()
}

// Typing/toggling re-runs the matcher over the cached blocks and follows the
// first hit; live transcript updates invalidate the blocks without stealing
// the reader's position (only the highlight ranges are refreshed).
watch([findQuery, findCaseSensitive], () => {
  if (!findOpen.value) return
  rebuildFind(true)
  revealActiveMatch()
})

watch(visibleTimeline, () => {
  findBlocks = null
  if (!findOpen.value) return
  void nextTick(() => {
    // re-collect after Vue has patched the transcript, even if a keystroke
    // rebuilt against the previous DOM in the meantime
    findBlocks = null
    if (!findOpen.value) return
    rebuildFind(false)
  })
})

/** Shell hooks (session switches remount this component; keeps the bar scriptable). */
defineExpose({ openFind, closeFind })

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

// -- live "who is acting" status line ------------------------------------------
// One line, not two: the shell's `activity` text (stopping / queued / working)
// and the derived actor label share a single row so the stream never shows
// duplicate "working…" banners.

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

onMounted(() => {
  window.addEventListener('keydown', onFindKeydown, true)
})

onUnmounted(() => {
  if (tickTimer !== undefined) window.clearInterval(tickTimer)
  if (copyTimer !== undefined) window.clearTimeout(copyTimer)
  window.removeEventListener('keydown', onFindKeydown, true)
  clearFindHighlights()
})

const statusLine = computed(() => {
  if (!runLive.value) return null
  const tail = props.timeline[props.timeline.length - 1]?.entry
  const at = timestampOf(tail)
  const secs = at === null ? null : Math.max(0, Math.floor((now.value - at) / 1000))
  // shell status wins (Stopping… / Run queued…); a live working run also gets
  // the elapsed clock
  if (props.activity) {
    if (
      secs !== null &&
      !props.activity.startsWith('Run queued') &&
      !props.activity.startsWith('Stopping')
    ) {
      return `${props.activity} · ${secs}s`
    }
    return props.activity
  }
  const label = nextActorLabel(tail) ?? 'Working…'
  return secs !== null ? `${label} · ${secs}s` : label
})
</script>

<template>
  <div class="chat-view">
    <div v-if="findOpen" class="find-bar" role="search" aria-label="Find in conversation">
      <AppIcon name="search" class="find-bar-icon" />
      <input
        ref="findInputEl"
        v-model="findQuery"
        class="find-input"
        type="text"
        placeholder="Find in conversation"
        aria-label="Find in conversation"
        autocomplete="off"
        spellcheck="false"
        @keydown.enter="onFindEnter"
      />
      <span
        class="find-status"
        :class="{ 'find-status-empty': findTotal === 0 && findQuery.trim() !== '' }"
        role="status"
        aria-live="polite"
      >{{ findStatus }}</span>
      <div class="find-actions">
        <button
          type="button"
          class="find-btn"
          :class="{ 'find-btn-active': findCaseSensitive }"
          :aria-pressed="findCaseSensitive"
          title="Match case"
          aria-label="Match case"
          @click="findCaseSensitive = !findCaseSensitive"
        >Aa</button>
        <button
          type="button"
          class="find-btn"
          title="Previous match (Shift+Enter)"
          aria-label="Previous match"
          :disabled="findTotal === 0"
          @click="moveFind(-1)"
        >↑</button>
        <button
          type="button"
          class="find-btn"
          title="Next match (Enter)"
          aria-label="Next match"
          :disabled="findTotal === 0"
          @click="moveFind(1)"
        >↓</button>
        <button
          type="button"
          class="find-btn find-close"
          title="Close (Esc)"
          aria-label="Close find"
          @click="closeFind"
        ><AppIcon name="x" /></button>
      </div>
    </div>
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

        <div v-else-if="row.entry.type === 'system'" class="system-activity" role="note">
          <span class="system-activity-dot" aria-hidden="true"></span>
          <span class="system-activity-label">{{ row.entry.activity.label }}</span>
          <span v-if="row.entry.activity.body" class="system-activity-body">{{
            row.entry.activity.body
          }}</span>
        </div>

        <ToolActivity v-else-if="row.entry.type === 'tool'" :item="row.entry" />

        <PromptAudit v-else-if="row.entry.type === 'prompt_audit'" :item="row.entry" />

        <ApprovalCard
          v-else-if="row.entry.type === 'approval' && !isDockedApproval(row.entry)"
          :item="row.entry"
          :resolve="resolveApproval"
        />

        <section v-else-if="row.entry.type === 'group'" class="chat-group" :class="[`side-${row.entry.group.author}`]">
          <div class="avatar" :class="`avatar-${row.entry.group.author}`" aria-hidden="true">
            {{ initial(row.entry.group.author) }}
          </div>
          <div class="group-content">
            <header class="group-header">
              <span class="speaker-name">{{ SPEAKER_LABEL[row.entry.group.author] }}</span>
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
                <header v-if="m.title || m.verdict || m.highlight" class="bubble-meta">
                  <h3 v-if="m.title" class="bubble-title">{{ m.title }}</h3>
                  <span v-if="m.kind !== 'message'" class="kind-chip">{{ m.kind }}</span>
                  <span v-if="m.verdict" class="verdict-chip" :class="verdictClass(m)">{{ m.verdict }}</span>
                </header>

                <div v-if="m.body" class="bubble-body md-body">
                  <MarkdownBlockView
                    v-for="(block, k) in markdownBlocks(m)"
                    :key="k"
                    :block="block"
                  />
                </div>

                <p v-if="m.dissent" class="dissent-note">dissent: {{ m.dissent }}</p>

                <details
                  v-if="m.details.length || m.lists.length || m.confidencePct !== null"
                  class="bubble-tech"
                >
                  <summary>Details</summary>
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

                  <div v-if="m.confidencePct !== null" class="confidence">
                    <div class="confidence-bar" role="img" :aria-label="`confidence ${m.confidencePct}%`">
                      <div class="confidence-fill" :style="{ width: m.confidencePct + '%' }"></div>
                    </div>
                    <span class="muted small">{{ m.confidencePct }}% confident</span>
                  </div>
                </details>
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

      <p v-if="statusLine" class="activity-line" aria-live="polite">
        <span class="activity-dot" aria-hidden="true"></span>{{ statusLine }}
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
  max-width: none;
  align-self: flex-start;
}

.side-operator .bubble-wrap {
  align-self: flex-end;
}

.bubble-wrap .bubble {
  max-width: none;
}

/* Compact neutral marker for internal protocol activity (payload repairs). */
.system-activity {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  max-width: 46rem;
  margin: 0.1rem 0;
  padding: 0.28rem 0.7rem;
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius-md);
  background: var(--surface-panel);
  color: var(--text-secondary);
  font-size: 0.78rem;
  line-height: 1.4;
}

.system-activity-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-tertiary);
  align-self: center;
}

.system-activity-label {
  flex: none;
  font-weight: 600;
}

.system-activity-body {
  min-width: 0;
}

/* Progressive disclosure for per-message technical detail. */
.bubble-tech {
  margin-top: 0.35rem;
}

.bubble-tech summary {
  display: inline-block;
  cursor: pointer;
  font-size: 0.72rem;
  color: var(--text-secondary);
  border: 1px solid var(--border-subtle);
  border-radius: 999px;
  padding: 0.05rem 0.55rem;
  user-select: none;
}

.bubble-tech summary:hover {
  color: var(--text-primary);
  background: var(--surface-hover);
}

.bubble-tech[open] summary {
  margin-bottom: 0.3rem;
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

/* Find bar: one row above the transcript, outside .chat-scroll so matches are
   never scrolled underneath it. It wraps instead of overflowing on narrow
   screens, and every control keeps the app's keyboard focus ring. */
.find-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.4rem;
  flex: 0 0 auto;
  width: calc(100% - 2.5rem);
  max-width: var(--composer-max-width);
  margin: 0.45rem auto 0;
  padding: 0.35rem 0.65rem;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-md);
  background: var(--surface-panel);
  box-shadow: var(--shadow-raised);
  font-size: var(--text-sm);
}

.find-bar:focus-within {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-soft);
}

.find-bar-icon {
  color: var(--text-tertiary);
}

.find-input {
  flex: 1 1 12rem;
  min-width: 0;
  border: none;
  background: transparent;
  color: var(--text-primary);
  font: inherit;
  font-size: var(--text-sm);
  padding: 0.15rem 0;
  outline: none;
}

.find-input::placeholder {
  color: var(--text-tertiary);
}

.find-status {
  flex: none;
  min-width: 4.5rem;
  text-align: right;
  color: var(--text-secondary);
  font-size: var(--text-xs);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.find-status-empty {
  color: var(--danger);
}

.find-actions {
  display: flex;
  align-items: center;
  gap: 0.1rem;
  flex: none;
  margin-left: auto;
}

.find-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 26px;
  height: 26px;
  padding: 0 0.3rem;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  font-size: var(--text-sm);
  line-height: 1;
  cursor: pointer;
}

.find-btn:hover:not(:disabled) {
  background: var(--surface-hover);
  color: var(--text-primary);
}

.find-btn:disabled {
  opacity: 0.45;
  cursor: default;
}

.find-btn-active {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent);
  font-weight: 600;
}

/* Narrow screens: the actions drop to a second row while the input shrinks
   (min-width: 0) instead of pushing the bar past the viewport. */
@media (max-width: 520px) {
  .find-bar {
    width: calc(100% - 1.25rem);
    padding: 0.35rem 0.45rem;
    gap: 0.25rem;
  }

  .find-input {
    flex-basis: 7rem;
  }

  .find-status {
    min-width: 3.5rem;
  }
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
</style>
