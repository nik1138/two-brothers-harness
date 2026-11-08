<script setup lang="ts">
import { computed, defineComponent, h, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type { PropType, VNode } from 'vue'
import { NButton } from 'naive-ui'
import { formatTime, SPEAKER_LABELS, speakerActivityLabel, speakerInitial } from '../chat'
import type { ChatGroup, ChatMessage, Speaker } from '../chat'
import { findMatches, nextMatch, prevMatch } from '../find'
import type { FindMatch } from '../find'
import { buildFoldRows } from '../folding'
import type { FoldRenderRow } from '../folding'
import { nextActorLabel, timestampOf } from '../runtime'
import type { ReasoningItem, TimelineEntry } from '../runtime'
import { parseMarkdown } from '../markdown'
import type { MarkdownBlock, MarkdownInline } from '../markdown'
import type { StreamingBlocks } from '../streaming'
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
  /**
   * Live ephemeral draft of the followed run (folded from the SSE `token`
   * frames by the shell). Null sections are not rendered; the blocks disappear
   * as soon as the completed envelope lands in the timeline.
   */
  streaming?: StreamingBlocks | null
  /**
   * Render per-model-call prompt-audit annotations. Off by default: the
   * Settings → Advanced preference owns this, so a normal transcript reads
   * cleanly. Rows are absent from the DOM (find/scroll cannot reach them).
   */
  showPromptAudits?: boolean
  /**
   * The run this app currently follows. Its tool/audit rows stay expanded; older
   * completed runs fold into disclosure rows. Null = no run is followed, so all
   * completed-run activity folds.
   */
  liveRunId?: string | null
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

const SPEAKER_LABEL: Readonly<Record<Speaker, string>> = SPEAKER_LABELS

function initial(s: Speaker): string {
  return speakerInitial(s)
}

const lastTime = computed(() => props.timeline[props.timeline.length - 1]?.time ?? 0)

/** Prompt-audit rows are developer annotations: concealed unless the pref is on. */
const auditVisible = computed(() => props.showPromptAudits === true)

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

// -- step folding ------------------------------------------------------------
// Older completed-run tool/audit cards collapse into one muted disclosure row
// (folding.ts owns the projection and its truthful counts). The followed run and
// every conversation row stay open; a collapsed group's rows leave the DOM
// entirely, so the find cache is invalidated on each toggle (see below).

/** Fold-group keys the operator expanded — per mount, i.e. per session. */
const expandedFolds = ref<ReadonlySet<string>>(new Set())

function toggleFold(key: string): void {
  const next = new Set(expandedFolds.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  expandedFolds.value = next
  void nextTick(keepPinnedToBottom)
}

/** Render rows for the visible slice: transcript entries plus fold rows. */
const foldRows = computed<FoldRenderRow[]>(() =>
  buildFoldRows(
    visibleTimeline.value,
    {
      liveRunId: props.liveRunId ?? null,
      showPromptAudits: auditVisible.value,
      dockedApprovalId: props.dockedApprovalId ?? null,
      expanded: expandedFolds.value,
    },
    windowStart.value,
  ),
)

// -- replayed reasoning rows --------------------------------------------------
// The runtime sidecar persists one bounded, sanitized reasoning record per
// streaming provider call (backend capture is streaming-only, so a
// non-streaming run has none — exactly like an older backend). Replay renders
// them as quiet, collapsed-by-default disclosure rows, visually the same shape
// as the live thinking block but static and labelled "replayed". The body is
// plain text from the projection (Vue text interpolation), so reasoning can
// never become markup; it is also excluded from the shared-context meter.

/** Replayed reasoning rows the reader expanded — per mount (per session). */
const expandedReasoning = ref<ReadonlySet<string>>(new Set())

const REASONING_ROLE_LABEL: Readonly<Record<'senior' | 'junior', string>> = {
  senior: 'Senior',
  junior: 'Junior',
}

function reasoningBodyId(item: ReasoningItem): string {
  return `reasoning-body-${item.id.replace(/[^A-Za-z0-9_-]/g, '')}`
}

function isReasoningExpanded(id: string): boolean {
  return expandedReasoning.value.has(id)
}

function toggleReasoning(id: string): void {
  const next = new Set(expandedReasoning.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expandedReasoning.value = next
  void nextTick(keepPinnedToBottom)
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
    // internal context rows (compaction summaries) are deliberately not searchable
    if (el.closest('[data-find-skip]')) continue
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

/**
 * Drop the cached searchable blocks and, with the bar open, re-collect them
 * after Vue has patched the transcript. Text that left the DOM (a collapsed fold
 * group, hidden prompt audits) must not keep matching.
 */
function invalidateFindBlocks(): void {
  findBlocks = null
  if (!findOpen.value) return
  void nextTick(() => {
    // re-collect after Vue has patched the transcript, even if a keystroke
    // rebuilt against the previous DOM in the meantime
    findBlocks = null
    if (!findOpen.value) return
    rebuildFind(false)
  })
}

// A live update appends/replaces rows, so the rendered text changed.
watch(visibleTimeline, invalidateFindBlocks)

// Toggling the audit preference changes the rendered transcript without
// changing visibleTimeline: hidden audits must drop out of find results (and
// reappear when shown).
watch(auditVisible, invalidateFindBlocks)

// Expanding/collapsing a fold group adds or removes its rows from the DOM.
watch(expandedFolds, invalidateFindBlocks)

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

// -- live streaming draft (ephemeral SSE `token` frames) ----------------------
// The shell folds the named `token` frames into a bounded draft (thinking and
// reply separately). These blocks are transient: the completed reply arrives as
// a normal envelope and replaces them (the shell clears the draft), while
// run_end/run_error clear it outright. Thinking renders as plain text; the reply
// goes through the same dependency-free Markdown renderer as committed bubbles,
// so partial/streaming markdown stays safe.

const streamingThinking = computed(() => props.streaming?.thinking ?? null)
const streamingText = computed(() => props.streaming?.text ?? null)
const streamingSpeaker = computed<Speaker>(() => {
  const role = props.streaming?.role
  return role === 'user' ? 'operator' : role === 'junior' ? 'junior' : 'senior'
})
const streamingMarkdown = computed<MarkdownBlock[]>(() =>
  streamingText.value ? parseMarkdown(streamingText.value.text) : [],
)

/**
 * Live thinking starts folded and only the reader opens it: reasoning is a
 * peek-on-demand block, never an auto-opening one. A new draft (the block
 * disappears) folds it again; the reply arriving never changes it.
 */
const thinkingExpanded = ref(false)

watch(streamingThinking, (next) => {
  if (!next) thinkingExpanded.value = false
})

function toggleThinking(): void {
  thinkingExpanded.value = !thinkingExpanded.value
  void nextTick(keepPinnedToBottom)
}

/** Succinct live-region updates; token deltas themselves are never announced. */
const streamAnnouncement = ref('')
watch(streamingThinking, (next, prev) => {
  if (next && !prev) {
    streamAnnouncement.value = speakerActivityLabel(streamingSpeaker.value, 'thinking')
  }
})
watch(streamingText, (next, prev) => {
  if (next && !prev) {
    streamAnnouncement.value = speakerActivityLabel(streamingSpeaker.value, 'responding')
  } else if (!next && prev) {
    streamAnnouncement.value = 'Response complete'
  }
})

/** Follow live growth only while the reader is already near the bottom. */
watch(
  () => (streamingThinking.value?.text.length ?? 0) + (streamingText.value?.text.length ?? 0),
  async () => {
    await nextTick()
    const el = scrollEl.value
    if (el && nearBottom.value) el.scrollTop = el.scrollHeight
  },
)
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

      <!-- Older completed-run activity folds into one disclosure row per group
           (folding.ts owns the projection). Collapsed rows leave the DOM, so
           find/copy see exactly what the transcript renders. -->
      <template v-for="row in foldRows" :key="row.key">
        <div v-if="row.type === 'fold'" class="fold-row">
          <button
            type="button"
            class="fold-toggle"
            :aria-expanded="row.expanded"
            :aria-label="`${row.expanded ? 'Collapse' : 'Expand'} ${row.summary.label}`"
            @click="toggleFold(row.key)"
          >
            <AppIcon
              class="fold-chevron"
              :name="row.expanded ? 'chevron-down' : 'chevron-right'"
              :size="12"
            />
            <span class="fold-ellipsis" aria-hidden="true">…</span>
            <span class="fold-label">{{ row.summary.label }}</span>
            <span class="fold-hint" aria-hidden="true">{{
              row.expanded ? 'collapse' : 'expand'
            }}</span>
          </button>
        </div>

        <template v-else>
          <div v-if="row.entry.type === 'divider'" class="revision-divider" role="separator">
          <span class="revision-label">{{ row.entry.label }}</span>
        </div>

        <div
          v-else-if="row.entry.type === 'system'"
          class="system-activity"
          role="note"
          :data-find-skip="row.entry.activity.quiet ? 'true' : undefined"
        >
          <span class="system-activity-dot" aria-hidden="true"></span>
          <span class="system-activity-label">{{ row.entry.activity.label }}</span>
          <details
            v-if="row.entry.activity.body && row.entry.activity.quiet"
            class="system-activity-details"
          >
            <summary>Summary</summary>
            <div class="system-activity-body system-activity-summary">{{
              row.entry.activity.body
            }}</div>
          </details>
          <span v-else-if="row.entry.activity.body" class="system-activity-body">{{
            row.entry.activity.body
          }}</span>
        </div>

        <ToolActivity v-else-if="row.entry.type === 'tool'" :item="row.entry" />

        <PromptAudit
          v-else-if="row.entry.type === 'prompt_audit' && auditVisible"
          :item="row.entry"
        />

        <ApprovalCard
          v-else-if="row.entry.type === 'approval' && !isDockedApproval(row.entry)"
          :item="row.entry"
          :resolve="resolveApproval"
        />

        <!-- Replayed reasoning: a collapsed, honest "Thinking · replayed" row
             from the runtime sidecar (bounded/sanitized by the backend). Mirrors
             the live thinking block's disclosure chrome; plain text only. -->
        <section
          v-else-if="row.entry.type === 'reasoning'"
          class="stream-thinking reasoning-row"
          :class="{ 'is-collapsed': !isReasoningExpanded(row.entry.id) }"
          role="note"
        >
          <button
            type="button"
            class="stream-thinking-head"
            :aria-expanded="isReasoningExpanded(row.entry.id)"
            :aria-controls="reasoningBodyId(row.entry)"
            :aria-label="`Replayed ${REASONING_ROLE_LABEL[row.entry.role]} reasoning — ${isReasoningExpanded(row.entry.id) ? 'collapse' : 'expand'}`"
            @click="toggleReasoning(row.entry.id)"
          >
            <span class="stream-thinking-dot" aria-hidden="true"></span>
            <span class="stream-thinking-label">
              Thinking · replayed
              <span class="reasoning-who">· {{ REASONING_ROLE_LABEL[row.entry.role] }}</span>
            </span>
            <AppIcon
              :name="isReasoningExpanded(row.entry.id) ? 'chevron-down' : 'chevron-right'"
              :size="12"
              class="stream-thinking-chevron"
            />
          </button>
          <div
            v-show="isReasoningExpanded(row.entry.id)"
            :id="reasoningBodyId(row.entry)"
            class="stream-thinking-body"
          >{{ row.entry.text }}</div>
          <p v-if="row.entry.truncated" class="stream-clipped">
            This reasoning was clipped for length.
          </p>
        </section>

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
      </template>

      <!-- Live streaming draft (ephemeral SSE token frames). aria-live="off"
           keeps token-by-token updates out of the transcript's polite live
           region; a separate visually-hidden status announces start/finish. -->
      <div
        v-if="streamingThinking || streamingText"
        class="stream-live"
        aria-live="off"
      >
        <section
          v-if="streamingThinking"
          class="stream-thinking"
          :class="{
            'is-live': streamingThinking.streaming,
            'is-collapsed': !thinkingExpanded,
          }"
        >
          <button
            type="button"
            class="stream-thinking-head"
            :aria-expanded="thinkingExpanded"
            aria-controls="stream-thinking-body"
            @click="toggleThinking"
          >
            <span class="stream-thinking-dot" aria-hidden="true"></span>
            <span class="stream-thinking-label">
              {{ streamingThinking.streaming ? 'Thinking…' : 'Thought for a moment' }}
            </span>
            <AppIcon
              :name="thinkingExpanded ? 'chevron-down' : 'chevron-right'"
              :size="12"
              class="stream-thinking-chevron"
            />
          </button>
          <div
            v-show="thinkingExpanded"
            id="stream-thinking-body"
            class="stream-thinking-body"
          >{{ streamingThinking.text }}</div>
          <p v-if="streamingThinking.truncated" class="stream-clipped">
            This reasoning was clipped for length.
          </p>
        </section>

        <section
          v-if="streamingText"
          class="chat-group stream-response"
          :class="`side-${streamingSpeaker}`"
        >
          <div class="avatar" :class="`avatar-${streamingSpeaker}`" aria-hidden="true">
            {{ initial(streamingSpeaker) }}
          </div>
          <div class="group-content">
            <header class="group-header">
              <span class="speaker-name">{{ SPEAKER_LABEL[streamingSpeaker] }}</span>
              <span class="stream-state">
                {{ streamingText.streaming ? 'responding…' : 'complete' }}
              </span>
            </header>
            <article class="bubble stream-bubble">
              <div class="md-body stream-md">
                <MarkdownBlockView
                  v-for="(block, k) in streamingMarkdown"
                  :key="k"
                  :block="block"
                />
                <span
                  v-if="streamingText.streaming"
                  class="stream-caret"
                  aria-hidden="true"
                ></span>
              </div>
              <p v-if="streamingText.truncated" class="stream-clipped">
                Earlier response text was clipped for length.
              </p>
            </article>
          </div>
        </section>
      </div>

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

      <!-- Empty transcript: the shell supplies the welcome hero; the fallback
           stays for hosts that do not pass the slot. -->
      <template v-if="timeline.length === 0 && !runError">
        <slot name="empty">
          <p class="empty-hint">This session has no messages yet.</p>
        </slot>
      </template>
    </template>
    </div>
    <p class="visually-hidden" role="status" aria-live="polite">{{ streamAnnouncement }}</p>
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
  gap: var(--space-2);
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

/* Internal context rows (e.g. a compaction summary): disclosure with a bounded,
   pre-wrapped body; the row itself is excluded from find. */
.system-activity-details {
  min-width: 0;
}

.system-activity-details summary {
  cursor: pointer;
  color: var(--text-secondary);
  font-size: 0.78rem;
}

.system-activity-details summary:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 1px;
}

.system-activity-summary {
  margin: 0.3rem 0 0;
  max-height: 18rem;
  overflow-y: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 0.8rem;
  line-height: 1.45;
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
  border-radius: var(--radius-pill);
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
  border-radius: var(--radius-pill);
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

/* Fold row: one muted disclosure line for a completed run's tool/audit rows.
   Width-safe — the label ellipsizes instead of wrapping the transcript. */
.fold-row {
  display: flex;
  justify-content: flex-start;
  width: 100%;
  margin: 0.1rem 0;
}

.fold-toggle {
  display: inline-flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: 0.35rem;
  max-width: 100%;
  min-width: 0;
  padding: 0.18rem 0.6rem;
  font: inherit;
  font-size: 0.76rem;
  line-height: 1.3;
  color: var(--text-secondary);
  background: transparent;
  border: 1px dashed var(--border-subtle);
  border-radius: var(--radius-pill);
  cursor: pointer;
}

.fold-toggle:hover {
  color: var(--text-primary);
  background: var(--surface-hover);
  border-color: var(--border-strong);
}

.fold-toggle:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 1px;
}

.fold-chevron {
  flex: none;
  opacity: 0.7;
}

.fold-ellipsis {
  flex: none;
  font-weight: 700;
}

.fold-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fold-hint {
  flex: none;
  font-size: 0.7rem;
  opacity: 0.85;
}

.run-error {
  max-width: 46rem;
  margin: var(--space-2) 0;
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
    gap: var(--space-1);
  }

  .find-input {
    flex-basis: 7rem;
  }

  .find-status {
    min-width: 3.5rem;
  }
}

/* Collapsed thinking is a quiet button row, not a card: the dashed/panel chrome
   only appears once the reader opens it (or while it is live, so the pulse has
   a visible home). Kept here (scoped) to avoid touching the shared sheet. */
.stream-thinking.is-collapsed {
  padding: 0;
  border-color: transparent;
  background: transparent;
}

.stream-thinking.is-collapsed.is-live {
  border-color: transparent;
}

/* Replayed reasoning rows reuse the live thinking block's collapse chrome; the
   only extra bit is the muted speaker name after the honest "replayed" label. */
.reasoning-who {
  color: var(--text-tertiary);
  font-weight: 500;
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
  border-radius: var(--radius-xs);
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
  padding: var(--space-2) 0.65rem;
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
  padding: var(--space-1) 0.55rem;
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
  margin: var(--space-2) 0 0;
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
