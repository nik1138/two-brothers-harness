/**
 * Session rewind (wave 23): the pure client model behind the transcript's
 * "Rewind to here…" action on an operator message.
 *
 * Rewind removes the selected operator task and everything after it from the
 * persisted session JSONL (`POST /api/sessions/{name}/rewind {turns}`); the
 * file is rewritten in place and `seq` stays dense because only a suffix is
 * dropped. This module mirrors the backend boundary rules
 * (`packages/harness/src/sessionrewind.ts`) so the UI can:
 *
 * - find the REAL operator turns (harness-generated context — compaction
 *   summaries, repair requests, mid-run steer texts, the auto-mode routing
 *   marker and attached `@skill:`/`@file` blocks — is never a task boundary);
 * - derive the turn depth from the clicked message (the backend takes a depth,
 *   not an index);
 * - state exactly what the destructive confirmation will remove;
 * - show the backend's clamp (`stoppedAtCompaction`/`reason`) verbatim.
 *
 * No DOM and no backend import: the marker constants are duplicated with the
 * backend module named in the comments (the web app cannot import the package
 * sources), and the duplication is pinned by the unit tests.
 */

import type { Envelope, SessionRewindResult } from './types'

/** Smallest accepted rewind depth (mirrors the backend `MIN_REWIND_TURNS`). */
export const MIN_REWIND_TURNS = 1
/** Largest accepted rewind depth (mirrors the backend `MAX_REWIND_TURNS`). */
export const MAX_REWIND_TURNS = 100

/**
 * Opening marker of a compaction-summary envelope
 * (`packages/harness/src/compaction.ts::COMPACTION_SUMMARY_PREFIX`). The full
 * prefix is pinned here because the summary is generated context, never an
 * operator task boundary.
 */
export const COMPACTION_SUMMARY_PREFIX =
  'The conversation history before this point was compacted into the following summary:\n\n<summary>\n'

/** Marker of a payload-repair re-ask (`payloads.ts::REPAIR_REQUEST_PREFIX`). */
export const REPAIR_REQUEST_PREFIX = '[[REPAIR_REQUEST]]'

/** Marker of a mid-run operator steer (`harness.ts::STEERING_PREFIX`). */
export const STEERING_PREFIX = '[[OPERATOR STEER]] '

/** Marker of the auto-mode routing decision (`harness.ts::AUTO_ROUTE_PREFIX`). */
export const AUTO_ROUTE_PREFIX = '[[AUTO ROUTE]] '

/** Opening tag of an attached skill block (`mentions.ts::renderSkillLoadedBlock`). */
export const ATTACHED_SKILL_TAG = '<skill-loaded'

/** Opening tag of an attached file block (`mentions.ts::renderFileBlock`). */
export const ATTACHED_FILE_TAG = '<file '

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Typed view of one possibly-malformed envelope (never throws). */
function envelopeRecord(event: unknown): Record<string, unknown> | null {
  return isRecord(event) ? event : null
}

/** Payload text of a `user -> senior` message envelope, or null. */
function userEnvelopeText(event: unknown): string | null {
  const record = envelopeRecord(event)
  if (record === null) return null
  if (record.from !== 'user' || record.kind !== 'message') return null
  const payload = isRecord(record.payload) ? record.payload : null
  if (payload === null) return null
  return typeof payload.text === 'string' ? payload.text : null
}

/** True for a compaction-summary envelope (generated context). */
export function isCompactionSummaryEnvelope(event: unknown): boolean {
  const record = envelopeRecord(event)
  const text = userEnvelopeText(event)
  return record !== null && text !== null && text.startsWith(COMPACTION_SUMMARY_PREFIX)
}

/** True for an attached `@skill:`/`@file` context block. */
export function isAttachedContextEnvelope(event: unknown): boolean {
  const record = envelopeRecord(event)
  const text = userEnvelopeText(event)
  if (record === null || text === null || record.to !== 'senior') return false
  return text.startsWith(ATTACHED_SKILL_TAG) || text.startsWith(ATTACHED_FILE_TAG)
}

/**
 * True for a REAL operator task boundary: a `user -> senior` `message` with
 * non-blank text that is not harness-generated context. Mirrors
 * `sessionrewind.ts::isRealOperatorTask` exactly.
 */
export function isOperatorTurn(event: unknown): boolean {
  const record = envelopeRecord(event)
  const text = userEnvelopeText(event)
  if (record === null || text === null) return false
  if (record.to !== 'senior') return false
  if (text.trim() === '') return false
  if (isCompactionSummaryEnvelope(event)) return false
  if (text.startsWith(REPAIR_REQUEST_PREFIX)) return false
  if (text.startsWith(STEERING_PREFIX)) return false
  if (text.startsWith(AUTO_ROUTE_PREFIX)) return false
  if (text.startsWith(ATTACHED_SKILL_TAG) || text.startsWith(ATTACHED_FILE_TAG)) return false
  return true
}

/** Index of the last compaction-summary envelope, or -1 when there is none. */
export function lastCompactionSummaryIndex(events: readonly Envelope[]): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (isCompactionSummaryEnvelope(events[index])) return index
  }
  return -1
}

/** Every real operator turn in the event log, in file order. */
export function operatorTurnIndexes(events: readonly Envelope[]): number[] {
  const indexes: number[] = []
  for (let index = 0; index < events.length; index += 1) {
    if (isOperatorTurn(events[index])) indexes.push(index)
  }
  return indexes
}

/**
 * The turn depth for an operator message at `index`: the number of real
 * operator turns at/after it (that is exactly what the backend removes when
 * asked for this depth). 0 when `index` is not an operator turn.
 */
export function rewindTurnsForIndex(events: readonly Envelope[], index: number): number {
  if (!Number.isInteger(index) || index < 0 || index >= events.length) return 0
  if (!isOperatorTurn(events[index])) return 0
  let turns = 0
  for (let at = index; at < events.length; at += 1) {
    if (isOperatorTurn(events[at])) turns += 1
  }
  return turns
}

/** What the shell knows when rewind is offered. */
export interface RewindBlockContext {
  /** A run is live (queued/running/waiting) for this session. */
  live?: boolean
  /** A manual context compaction is in flight for this session. */
  compacting?: boolean
}

/** Why rewind is unavailable right now, or null when it is available. */
export function rewindBlockedReason(
  context: RewindBlockContext | null | undefined,
): string | null {
  if (!context) return null
  if (context.live) {
    return 'Rewind is unavailable while a run is active for this session. Stop the run first.'
  }
  if (context.compacting) {
    return 'Rewind is unavailable while the context is being compacted.'
  }
  return null
}

/** Why a rewind boundary is currently unavailable (null = available). */
export type RewindBlock = 'run-active' | 'compacting' | 'compaction-floor' | 'empty'

/** One operator message's rewind affordance, computed from the loaded events. */
export interface RewindAction {
  /** Index of the operator message in the events array. */
  index: number
  /** The operator task text (payload.text exactly as persisted). */
  text: string
  /** Depth the backend call would send. */
  turns: number
  /** False when this message can no longer be a rewind boundary. */
  removable: boolean
  /** Honest reason when `removable` is false. */
  reason: string | null
  /** Coarse cause of the block (a `compaction-floor` turn is normal history,
   *  not an unavailable action — callers hide that one instead of disabling). */
  blockedBy: RewindBlock | null
}

/**
 * The rewind affordance for one operator message: null when the envelope is
 * not an operator turn (the UI shows no action then). A turn at or before the
 * last compaction summary is no longer rewindable — it is already folded into
 * the summary, and the backend refuses to cross that floor.
 */
export function rewindActionFor(
  events: readonly Envelope[],
  index: number,
  context: RewindBlockContext | null | undefined = null,
): RewindAction | null {
  if (!Number.isInteger(index) || index < 0 || index >= events.length) return null
  if (!isOperatorTurn(events[index])) return null
  const text = String(events[index]!.payload.text ?? '')
  const turns = rewindTurnsForIndex(events, index)
  if (context?.live === true) {
    return {
      index,
      text,
      turns,
      removable: false,
      reason: 'Rewind is unavailable while a run is active for this session. Stop the run first.',
      blockedBy: 'run-active',
    }
  }
  if (context?.compacting === true) {
    return {
      index,
      text,
      turns,
      removable: false,
      reason: 'Rewind is unavailable while the context is being compacted.',
      blockedBy: 'compacting',
    }
  }
  if (index <= lastCompactionSummaryIndex(events)) {
    return {
      index,
      text,
      turns,
      removable: false,
      reason:
        'This task is already folded into the context compaction summary and cannot be rewound.',
      blockedBy: 'compaction-floor',
    }
  }
  if (turns < MIN_REWIND_TURNS) {
    return {
      index,
      text,
      turns,
      removable: false,
      reason: 'There is nothing to remove here.',
      blockedBy: 'empty',
    }
  }
  return { index, text, turns, removable: true, reason: null, blockedBy: null }
}

/** Everything the destructive confirmation names, derived before the request. */
export interface RewindPreview {
  /** Envelope index of the selected operator task. */
  operatorIndex: number
  /** Depth sent to the backend. */
  turns: number
  /** Messages removed = the selected task through the end of the log. */
  removedMessages: number
  /** Messages kept after the rewrite. */
  keptMessages: number
  /** The selected task text, for the confirmation quote (bounded). */
  taskText: string
}

/** Longest task snippet quoted in the confirmation (never a full transcript). */
export const REWIND_QUOTE_MAX_CHARS = 160

/** The quoted one-line task snippet for the confirmation. */
export function rewindQuote(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean.length <= REWIND_QUOTE_MAX_CHARS) return clean
  return `${clean.slice(0, REWIND_QUOTE_MAX_CHARS - 1)}…`
}

/**
 * The pre-request preview for one operator message; null when the message has
 * no rewind action (see `rewindActionFor`). The counts are local estimates of
 * exactly what will be removed; the backend's response is authoritative for
 * the applied cut and its clamp wording.
 */
export function rewindPreview(
  events: readonly Envelope[],
  index: number,
  context: RewindBlockContext | null | undefined = null,
): RewindPreview | null {
  const action = rewindActionFor(events, index, context)
  if (action === null || !action.removable) return null
  return {
    operatorIndex: index,
    turns: action.turns,
    removedMessages: Math.max(0, events.length - index),
    keptMessages: Math.max(0, index),
    taskText: action.text,
  }
}

/**
 * The destructive confirmation body: what is removed (counts), that the
 * conversation file is rewritten, and that it cannot be undone. The action
 * button label is separate (`Rewind`), so the body never says "just".
 */
export function rewindConfirmation(preview: RewindPreview | null | undefined): string {
  if (!preview) return 'This task cannot be rewound.'
  const quote = rewindQuote(preview.taskText)
  const messages = `${preview.removedMessages} ${preview.removedMessages === 1 ? 'message' : 'messages'}`
  const turns = `${preview.turns} ${preview.turns === 1 ? 'operator task' : 'operator tasks'}`
  return (
    `Remove this task and everything after it: ${messages} (${turns}) will be deleted from the ` +
    `session file, which is rewritten in place. This cannot be undone.` +
    (quote ? `\n\nSelected task: “${quote}”` : '')
  )
}

/** Bounded non-negative display count from a backend number. */
function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

/**
 * Outcome copy for an applied rewind: the numbers actually removed plus the
 * backend's clamp sentence when the request stopped at a boundary. Never
 * claims more than the response reports; a failed runtime-sidecar clear is
 * disclosed instead of hidden.
 */
export function rewindOutcomeNotice(
  result: SessionRewindResult | null | undefined,
): string {
  if (!result) return 'Rewind finished.'
  if (result.rewritten === false) {
    return 'Nothing was rewound — the session file is unchanged.'
  }
  const removed = count(result.removed)
  const turns = count(result.turns)
  const kept = count(result.kept)
  const sidecar =
    result.runtime_events_cleared === false
      ? ` The stale runtime event history could not be cleared: ${typeof result.runtime_events_clear_error === 'string' && result.runtime_events_clear_error.trim() ? result.runtime_events_clear_error.trim() : 'unknown error'}.`
      : ''
  if (result.stopped_at_compaction === true) {
    const reason = typeof result.reason === 'string' && result.reason.trim()
      ? result.reason.trim()
      : 'The rewind stopped at the last context compaction summary (older tasks are already folded into it).'
    return `Rewind stopped at a context boundary — ${removed} ${removed === 1 ? 'message' : 'messages'} removed (${turns} ${turns === 1 ? 'task' : 'tasks'}), ${kept} kept. ${reason}${sidecar}`
  }
  return `Rewound: ${removed} ${removed === 1 ? 'message' : 'messages'} removed (${turns} ${turns === 1 ? 'task' : 'tasks'}), ${kept} kept.${sidecar}`
}

/** True when the outcome removed exactly what the confirmation promised. */
export function rewindOutcomeMatchesPreview(
  result: SessionRewindResult | null | undefined,
  preview: RewindPreview | null | undefined,
): boolean {
  if (!result || !preview) return false
  return (
    result.rewritten !== false &&
    count(result.removed) === preview.removedMessages &&
    count(result.turns) === preview.turns &&
    result.stopped_at_compaction !== true
  )
}

/**
 * Honest failure copy for a rejected rewind. 400 invalid depth, 404 unknown
 * session, 409 while a run is active / a compaction is in flight; the backend
 * detail wins when present, and status 0 means the request never arrived.
 */
export function rewindFailureNotice(input: {
  status?: number
  detail?: string
} | null | undefined): string {
  const status = typeof input?.status === 'number' ? input.status : 0
  const detail = typeof input?.detail === 'string' ? input.detail.trim() : ''
  if (status === 0) return 'The backend is unreachable — the session was not changed.'
  if (status === 400) return detail || 'That rewind depth was rejected.'
  if (status === 404) return 'This session is no longer known — refresh the session list.'
  if (status === 409) return detail || 'The session changed under the request; try again after the run finishes.'
  return detail || `Rewind failed (HTTP ${status}) — the session was not changed.`
}

/** Validate a depth client-side before sending (mirrors the backend rule). */
export function validateRewindTurns(
  value: unknown,
): { ok: true; turns: number } | { ok: false; error: string } {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return {
      ok: false,
      error: `rewind turns must be an integer between ${MIN_REWIND_TURNS} and ${MAX_REWIND_TURNS}`,
    }
  }
  if (value < MIN_REWIND_TURNS || value > MAX_REWIND_TURNS) {
    return { ok: false, error: `rewind turns must be between ${MIN_REWIND_TURNS} and ${MAX_REWIND_TURNS}` }
  }
  return { ok: true, turns: value }
}
