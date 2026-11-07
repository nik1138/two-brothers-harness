import type { Envelope, ReviewVerdict } from './types'

// Projection of protocol envelopes (PROTOCOL.md) into group-chat items.
// This is the only place where envelope payloads are interpreted for display;
// components consume ChatItem[] and never touch raw envelopes.

export type Speaker = 'operator' | 'senior' | 'junior'

export interface DetailLine {
  label: string
  value: string
}

export interface DetailList {
  label: string | null
  items: string[]
}

export interface ChatMessage {
  id: string
  seq: number
  ts: string
  kind: Envelope['kind']
  title: string | null
  body: string | null
  details: DetailLine[]
  lists: DetailList[]
  verdict: ReviewVerdict | null
  confidencePct: number | null
  dissent: string | null
  /** Final-decision styling. */
  highlight: boolean
}

export interface ChatGroup {
  author: Speaker
  recipient: Speaker
  startTs: string
  messages: ChatMessage[]
}

/** A neutral system activity projected from internal protocol traffic
 * (e.g. a payload repair re-ask). Never carries raw markers or prompt text. */
export interface SystemActivity {
  id: string
  seq: number
  ts: string
  label: string
  body: string | null
  /** Internal context traffic: rendered neutrally and kept out of find results. */
  quiet?: boolean
}

export type ChatItem =
  | { type: 'group'; group: ChatGroup }
  | { type: 'divider'; seq: number; label: string }
  | { type: 'system'; activity: SystemActivity }

export function speakerOf(from: Envelope['from']): Speaker {
  return from === 'user' ? 'operator' : from
}

/**
 * Visible speaker labels. The third seat at the table is the person at the
 * keyboard, so it reads "You" (the internal speaker id stays `operator`).
 */
export const SPEAKER_LABELS: Readonly<Record<Speaker, string>> = {
  operator: 'You',
  senior: 'Senior',
  junior: 'Junior',
}

/** Label for one speaker row. */
export function speakerLabel(speaker: Speaker): string {
  return SPEAKER_LABELS[speaker] ?? speaker
}

/** One-letter avatar mark matching the visible label. */
export function speakerInitial(speaker: Speaker): string {
  return speakerLabel(speaker).charAt(0).toUpperCase()
}

/**
 * Present-continuous phrase for live announcements ("You are thinking",
 * "Senior is responding"). Grammatical for the operator even though the
 * operator cannot emit stream tokens today.
 */
export function speakerActivityLabel(
  speaker: Speaker,
  activity: 'thinking' | 'responding',
): string {
  if (speaker === 'operator') return activity === 'thinking' ? 'You are thinking' : 'You are responding'
  return `${speakerLabel(speaker)} is ${activity}`
}


const GROUP_GAP_MS = 10 * 60 * 1000

function str(v: unknown): string | null {
  if (typeof v === 'string' && v.trim() !== '') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return null
}

function strList(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.map(str).filter((s): s is string => s !== null)
}

function detail(lines: DetailLine[], label: string, value: string | null) {
  if (value !== null) lines.push({ label, value })
}

// -- payload repair (REPAIR_REQUEST) ------------------------------------------
// The harness re-asks a role whose structured reply failed the strict schema by
// appending a `message` envelope from "user" whose text is wrapped in
// `[[REPAIR_REQUEST]]` … `[[/REPAIR_REQUEST]]` markers (payloads.ts
// buildRepairRequest). The raw text is internal prompt traffic: the projection
// turns it into a compact, marker-free system activity; the session file and
// protocol behavior are untouched.

const REPAIR_REQUEST_PREFIX = '[[REPAIR_REQUEST]]'
const REPAIR_REQUEST_SUFFIX = '[[/REPAIR_REQUEST]]'

/** True when a user message text is a payload-repair re-ask envelope.
 *  Anchored on the generated structure (payloads.ts buildRepairRequest):
 *  the text must open with the prefix marker and close with the suffix
 *  marker after trimming — a mere mention of the marker inside an operator
 *  message must stay operator speech. */
export function isRepairRequestText(text: unknown): text is string {
  if (typeof text !== 'string') return false
  const trimmed = text.trim()
  return trimmed.startsWith(REPAIR_REQUEST_PREFIX) && trimmed.endsWith(REPAIR_REQUEST_SUFFIX)
}

/** Neutral summary of a repair envelope — no markers, no internal prompt text. */
function repairActivityOf(env: Envelope): SystemActivity {
  const raw = str((env.payload ?? {})['text']) ?? ''
  const inner = raw.replace(REPAIR_REQUEST_PREFIX, '').replace(REPAIR_REQUEST_SUFFIX, '')
  const kind = inner.match(/required\s+([\w-]+)\s+payload\s+schema/i)?.[1] ?? null
  const body = kind
    ? `The ${kind} reply did not match the required format — the request was sent again.`
    : 'A reply did not match the required format — the request was sent again.'
  return { id: env.id || `repair-${env.seq}`, seq: env.seq, ts: env.ts, label: 'Reply format repair', body }
}

// -- context compaction summary (COMPACTION_SUMMARY) --------------------------
// `/compact` rewrites the session so the older history is replaced by one
// `message` envelope from "user" whose text wraps the summary in the harness's
// `<summary>` markers. That envelope is internal context traffic, never the
// operator's words: the projection renders a neutral "Context compacted"
// activity with the (clipped) summary body. The marker constants are mirrored
// from `packages/harness/src/compaction.ts` (COMPACTION_SUMMARY_PREFIX/_SUFFIX,
// attribution: the harness package — web cannot import package sources); keep
// them byte-identical. Exported so tests assert the mirror.

export const COMPACTION_SUMMARY_PREFIX =
  'The conversation history before this point was compacted into the following summary:\n\n<summary>\n'
export const COMPACTION_SUMMARY_SUFFIX = '\n</summary>'

/** Cap on the rendered summary body (the full text stays in the session file). */
const COMPACTION_ACTIVITY_MAX_CHARS = 4_000

/** True when a user message text is a compaction-summary context envelope.
 *  Mirrors `compaction.ts::isCompactionSummary` (prefix-anchored), so a summary
 *  is never mistaken for operator speech and a mention of the marker inside an
 *  operator message stays operator text. */
export function isCompactionSummaryText(text: unknown): text is string {
  return typeof text === 'string' && text.startsWith(COMPACTION_SUMMARY_PREFIX)
}

/** Clean, bounded summary body of a compaction envelope (markers stripped). */
export function compactionSummaryBody(text: unknown): string {
  if (!isCompactionSummaryText(text)) return ''
  const inner = text.slice(COMPACTION_SUMMARY_PREFIX.length)
  const body = (inner.endsWith(COMPACTION_SUMMARY_SUFFIX)
    ? inner.slice(0, inner.length - COMPACTION_SUMMARY_SUFFIX.length)
    : inner
  ).trim()
  if (body.length <= COMPACTION_ACTIVITY_MAX_CHARS) return body
  return `${body.slice(0, COMPACTION_ACTIVITY_MAX_CHARS).trimEnd()} … [summary clipped]`
}

/** Neutral system activity for a compaction-summary envelope. */
function compactionActivityOf(env: Envelope): SystemActivity {
  const raw = str((env.payload ?? {})['text']) ?? ''
  return {
    id: env.id || `compact-${env.seq}`,
    seq: env.seq,
    ts: env.ts,
    label: 'Context compacted',
    body: compactionSummaryBody(raw) || null,
    quiet: true,
  }
}

function toMessage(env: Envelope): ChatMessage {
  const p = (env.payload ?? {}) as Record<string, unknown>
  let title: string | null = null
  let body: string | null = null
  const details: DetailLine[] = []
  const lists: DetailList[] = []

  switch (env.kind) {
    case 'message':
      body = str(p.text)
      break
    case 'consult':
      title = str(p.task)
      body = str(p.ask)
      detail(details, 'expects', str(p.expect))
      detail(details, 'deadline', str(p.deadline_hint))
      break
    case 'proposal':
      title = str(p.title)
      body = str(p.answer)
      detail(details, 'rationale', str(p.rationale))
      lists.push({ label: 'risks', items: strList(p.risks) })
      lists.push({ label: 'asks', items: strList(p.asks) })
      break
    case 'delegation':
      title = str(p.work)
      lists.push({ label: 'acceptance criteria', items: strList(p.acceptance) })
      detail(details, 'return', str(p.return))
      detail(details, 'notes', str(p.notes))
      break
    case 'deliverable':
      body = str(p.result)
      lists.push({ label: 'artifacts', items: strList(p.artifacts) })
      detail(details, 'notes', str(p.notes))
      break
    case 'review': {
      body = str(p.notes)
      const points = strList(p.points)
      if (points.length) lists.push({ label: null, items: points })
      break
    }
    case 'decision':
      body = str(p.decision)
      detail(details, 'rationale', str(p.rationale))
      lists.push({ label: 'accepted', items: strList(p.accepted_proposals) })
      break
  }

  const c = typeof p.confidence === 'number' && Number.isFinite(p.confidence) ? p.confidence : null
  const verdict =
    env.kind === 'review' && (p.verdict === 'accept' || p.verdict === 'revise' || p.verdict === 'reject')
      ? p.verdict
      : null

  return {
    id: env.id || `${env.seq}`,
    seq: env.seq,
    ts: env.ts,
    kind: env.kind,
    title,
    body,
    details,
    lists: lists.filter((l) => l.items.length > 0),
    verdict,
    confidencePct: c === null ? null : c <= 1 ? Math.round(c * 100) : Math.round(c),
    dissent: env.kind === 'decision' ? str(p.dissent) : null,
    highlight: env.kind === 'decision',
  }
}

// Incremental projection state. Appending an envelope interprets only that
// envelope and reuses the grouping decision, so a live run costs O(1) per event
// instead of O(n). `seen` mirrors the caller's envelope sequence; `items` stays
// index-stable (rows are only appended or replaced, never removed) and
// `snapshot` is the array handed to components (invalidated whenever the
// projection changes so Vue's computed dependencies see a new value).
//
// Changed rows get fresh objects: a message appended to the open group
// replaces the group item with a new ChatGroup/ChatItem instead of mutating it,
// because these objects are passed to child components as props — Vue skips a
// child update when the prop reference is unchanged, so in-place mutation would
// leave the view stale.
interface ChatProjectionState {
  seen: Envelope[]
  items: ChatItem[]
  group: ChatGroup | null
  revision: number
  snapshot: ChatItem[] | null
}

function freshChatState(): ChatProjectionState {
  return { seen: [], items: [], group: null, revision: 0, snapshot: null }
}

let chatState = freshChatState()
let chatGeneration = 0

/**
 * Bumped on every full rebuild (session load / cleared timeline). The timeline
 * merge uses it to distinguish "same projection, only appended or replaced
 * rows" from "a different transcript".
 */
export function chatProjectionGeneration(): number {
  return chatGeneration
}

/** Fold one envelope into the projection (the body of the full-pass loop). */
function appendToProjection(state: ChatProjectionState, env: Envelope) {
  // Repair re-asks and compaction summaries are internal protocol traffic, not
  // operator speech: project them as neutral system activities and break the
  // open speaker group.
  const text = (env.payload ?? {})['text']
  if (env.from === 'user' && env.kind === 'message') {
    if (isRepairRequestText(text)) {
      state.group = null
      state.items.push({ type: 'system', activity: repairActivityOf(env) })
      return
    }
    if (isCompactionSummaryText(text)) {
      state.group = null
      state.items.push({ type: 'system', activity: compactionActivityOf(env) })
      return
    }
  }

  const author = speakerOf(env.from)
  const recipient = speakerOf(env.to)
  const msg = toMessage(env)
  const prev = state.group?.messages[state.group.messages.length - 1]
  const gap =
    state.group && prev ? new Date(env.ts).getTime() - new Date(prev.ts).getTime() : Infinity

  const sameGroup =
    state.group !== null &&
    state.group.author === author &&
    state.group.recipient === recipient &&
    !prev?.highlight &&
    prev?.verdict !== 'revise' &&
    Math.abs(gap) < GROUP_GAP_MS

  const base: ChatGroup =
    sameGroup && state.group
      ? state.group
      : { author, recipient, startTs: env.ts, messages: [] }
  const nextGroup: ChatGroup = {
    author: base.author,
    recipient: base.recipient,
    startTs: base.startTs,
    messages: [...base.messages, msg],
  }
  state.group = nextGroup
  if (sameGroup) state.items[state.items.length - 1] = { type: 'group', group: nextGroup }
  else state.items.push({ type: 'group', group: nextGroup })

  if (msg.verdict === 'revise') {
    state.revision += 1
    state.group = null
    state.items.push({ type: 'divider', seq: env.seq, label: `Revision ${state.revision} requested` })
  } else if (msg.highlight) {
    state.group = null
  }
}

function chatSnapshot(): ChatItem[] {
  if (!chatState.snapshot) chatState.snapshot = chatState.items.slice()
  return chatState.snapshot
}

/**
 * True when `next` starts with the same envelope objects as `prev`. Session
 * loads replace the array wholesale, so a first/last reference check is enough
 * to tell an append from a reload; a reload always rebuilds.
 */
function looksAppended(prev: Envelope[], next: Envelope[]): boolean {
  if (next.length < prev.length) return false
  if (prev.length === 0) return true
  return next[0] === prev[0] && next[prev.length - 1] === prev[prev.length - 1]
}

function isPrefix(short: Envelope[], long: Envelope[]): boolean {
  if (short.length > long.length) return false
  for (let i = 0; i < short.length; i += 1) {
    if (short[i] !== long[i]) return false
  }
  return true
}

/** Reset the incremental projection (new session / cleared timeline). */
export function resetChatProjection(events: Envelope[] = []): void {
  chatGeneration += 1
  chatState = freshChatState()
  chatState.seen = events.slice()
  for (const env of events) appendToProjection(chatState, env)
  chatState.snapshot = null
}

function syncChatProjection(events: Envelope[]): void {
  if (events === chatState.seen) return
  if (events.length === 0) {
    if (chatState.seen.length > 0) resetChatProjection([])
    return
  }
  if (looksAppended(chatState.seen, events)) {
    const start = chatState.seen.length
    if (start < events.length) {
      for (let i = start; i < events.length; i += 1) {
        const env = events[i]
        appendToProjection(chatState, env)
        chatState.seen.push(env)
      }
      chatState.snapshot = null
    }
    return
  }
  // The caller may be feeding appends through appendEnvelope() while its own
  // array lags behind; keep the projection when the array is merely a prefix.
  if (events.length < chatState.seen.length && isPrefix(events, chatState.seen)) return
  resetChatProjection(events)
}

/**
 * Convert a session's envelopes into ordered chat items with grouping and
 * revision dividers. Append-only changes are projected incrementally: only
 * envelopes past the previously seen prefix are interpreted.
 */
export function projectEnvelopes(events: Envelope[]): ChatItem[] {
  syncChatProjection(events)
  return chatSnapshot()
}

/**
 * Incremental feed for live envelopes (contract with App.vue): interpret one
 * envelope and extend the cached projection. The caller must have primed the
 * projection with projectEnvelopes()/resetChatProjection() first, then read the
 * result through currentChatItems().
 */
export function appendEnvelope(env: Envelope): void {
  chatState.seen.push(env)
  appendToProjection(chatState, env)
  chatState.snapshot = null
}

/** Current projected items after appendEnvelope() calls. */
export function currentChatItems(): ChatItem[] {
  return chatSnapshot()
}

/** First operator task text in a session, used as the conversation title. */
export function taskOf(events: Envelope[]): string | null {
  for (const env of events) {
    if (env.from === 'user' && env.kind === 'message') {
      const text = str((env.payload as Record<string, unknown>).text)
      // internal context envelopes never become the visible task line
      if (text && !isRepairRequestText(text) && !isCompactionSummaryText(text)) return text
    }
    if (env.kind === 'consult') {
      const task = str((env.payload as Record<string, unknown>).task)
      if (task) return task
    }
  }
  return null
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Human-readable session title derived from the file name; no invented data. */
export function sessionTitle(name: string): string {
  const base = name.replace(/\.jsonl$/i, '')
  const m = base.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2})-(\d{2})(?:-(\d{2}))?$/)
  if (m) {
    const [, y, mo, d, h, mi] = m
    return `${Number(d)} ${MONTHS[Number(mo) - 1]} ${y}, ${h}:${mi}`
  }
  return base.replace(/[-_]+/g, ' ').trim() || name
}

export function formatTime(ts: string): string {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function formatDateTime(ts: string): string {
  const d = new Date(ts)
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString()
}

export function relativeTime(unixSeconds: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - unixSeconds * 1000)
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days} d ago`
  return formatDateTime(new Date(unixSeconds * 1000).toISOString())
}
