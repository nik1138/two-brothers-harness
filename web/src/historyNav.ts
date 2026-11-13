// User-message navigator model (pure).
//
// The navigator is secondary navigation over the transcript: an on-demand
// popover lists every operator (user) message from the FULL projected
// timeline — not just the rendered window — so the operator can jump back to
// anything they said. This module owns the pure side of that feature:
//
// - enumerating operator messages from the projected timeline (messages, never
//   groups; internal context envelopes never reach the projection as operator
//   speech, see chat.ts), with stable ids, chronological indexes, single-line
//   excerpts and formatted times;
// - planning transcript-window growth so a jump target hidden by the
//   newest-page window (transcriptWindow.ts) becomes rendered, bounded by an
//   activation cap so a live session appending rows can never make growth run
//   forever.
//
// No DOM or Vue dependency: the model is unit-tested directly.

import { formatTime } from './chat'
import type { TimelineEntry } from './runtime'
import {
  TRANSCRIPT_CHUNK_SIZE,
  TRANSCRIPT_PAGE_SIZE,
  transcriptWindow,
} from './transcriptWindow'
import type { TranscriptWindowOptions, TranscriptWindowState } from './transcriptWindow'

/** Bound on one navigator excerpt, in characters (the excerpt is one line). */
export const HISTORY_NAV_EXCERPT_MAX = 80

/**
 * Default cap on "show earlier"-equivalent activations for one reveal plan.
 * Revealing a target at the very top of an enormous transcript needs at most
 * (total - page) / chunk activations; the cap exists for the live-session
 * race, where appends keep moving the target while the view re-plans.
 */
export const HISTORY_NAV_MAX_GROWTH_ACTIVATIONS = 1000

/** One operator message in the navigator, chronological (`index`) order. */
export interface HistoryNavEntry {
  /** Stable identity: `op-<seq>`; the envelope seq is unique per message. */
  readonly id: string
  /** Envelope seq — the same identity rewind/fork use. */
  readonly seq: number
  /** Chronological position among the session's user messages (0-based). */
  readonly index: number
  /** Absolute index of the owning row in the projected timeline — the window
   *  growth target. */
  readonly rowIndex: number
  /** Single-line excerpt (whitespace collapsed, bounded). */
  readonly excerpt: string
  /** Formatted message time, or null when the timestamp does not parse. */
  readonly time: string | null
}

/** Flatten `text` to one line and bound it to `max` chars; '' when blank. */
export function excerptOf(
  text: string | null | undefined,
  max: number = HISTORY_NAV_EXCERPT_MAX,
): string {
  const flat = (text ?? '').replace(/\s+/gu, ' ').trim()
  if (flat.length <= max) return flat
  return `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

/**
 * All operator (user) messages in the projected timeline, in timeline order.
 * Only chat-group rows authored by the operator contribute, and only their
 * `message`-kind bubbles — the projection already converted repair re-asks,
 * compaction summaries and auto-route markers into neutral system activities,
 * so they can never appear here. Messages are enumerated individually even
 * when several share one group.
 */
export function operatorMessagesOf(timeline: readonly TimelineEntry[]): HistoryNavEntry[] {
  const entries: HistoryNavEntry[] = []
  for (let rowIndex = 0; rowIndex < timeline.length; rowIndex += 1) {
    const row = timeline[rowIndex]
    if (row.entry.type !== 'group' || row.entry.group.author !== 'operator') continue
    for (const m of row.entry.group.messages) {
      if (m.kind !== 'message') continue
      entries.push({
        id: `op-${m.seq}`,
        seq: m.seq,
        index: entries.length,
        rowIndex,
        excerpt: excerptOf(m.title ?? m.body),
        time: Number.isNaN(Date.parse(m.ts)) ? null : formatTime(m.ts),
      })
    }
  }
  return entries
}

/** Options for {@link planRevealGrowth}. */
export interface RevealGrowthOptions extends TranscriptWindowOptions {
  /** Live-session clamp on activations (default
   *  {@link HISTORY_NAV_MAX_GROWTH_ACTIVATIONS}). */
  readonly maxActivations?: number
}

/**
 * How to grow the transcript window so a jump target becomes rendered.
 * `activations` is the number of "show earlier" chunks the plan is worth —
 * the growth granularity the transcript window itself uses.
 */
export interface RevealGrowthPlan {
  /** Window state to set; never shrinks the rows the operator already loaded. */
  readonly state: TranscriptWindowState
  /** "Show earlier"-equivalent activations the plan performs. */
  readonly activations: number
  /** True when the target row is inside the planned window. */
  readonly revealed: boolean
  /** True when the activation cap stopped growth before the target. */
  readonly clamped: boolean
}

/** A non-negative integer count; anything else reads as 0. */
function countOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0
}

/** A positive integer option; invalid values fall back to `fallback`. */
function sizeOf(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : fallback
}

/**
 * Plan the window growth that reveals `targetRowIndex` (an absolute row in
 * the projected timeline). Growth never shrinks what `state` already loaded
 * and never loads rows the window model would refuse (loading stops when
 * nothing is hidden). An out-of-range target plans nothing and reports
 * `revealed: false`.
 */
export function planRevealGrowth(
  totalRows: unknown,
  targetRowIndex: unknown,
  state: TranscriptWindowState = { loaded: 0 },
  options: RevealGrowthOptions = {},
): RevealGrowthPlan {
  const total = transcriptWindow(totalRows, { loaded: 0 }, options).total
  const target =
    typeof targetRowIndex === 'number' && Number.isFinite(targetRowIndex)
      ? Math.floor(targetRowIndex)
      : -1
  const loaded = countOf(state?.loaded)
  if (total === 0 || target < 0 || target >= total) {
    return { state: { loaded }, activations: 0, revealed: false, clamped: false }
  }
  const page = sizeOf(options.pageSize, TRANSCRIPT_PAGE_SIZE)
  const chunk = sizeOf(options.chunkSize, TRANSCRIPT_CHUNK_SIZE)
  // Rows the target still needs loaded beyond the current window.
  const required = Math.max(0, total - page - target)
  const grown = Math.max(loaded, required)
  const needed = Math.ceil((grown - loaded) / chunk)
  const cap = sizeOf(options.maxActivations, HISTORY_NAV_MAX_GROWTH_ACTIVATIONS)
  const activations = Math.min(needed, cap)
  // Chunk-granular growth, capped at what the window can actually load.
  const planned = Math.min(loaded + activations * chunk, Math.max(0, total - page))
  const finalLoaded = Math.max(loaded, planned)
  return {
    state: { loaded: finalLoaded },
    activations,
    revealed: transcriptWindow(total, { loaded: finalLoaded }, options).start <= target,
    clamped: needed > activations,
  }
}
