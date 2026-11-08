/**
 * Session fork (wave 23): the pure request/copy model behind the sidebar row's
 * "Fork session…" action.
 *
 * A fork copies the conversation into a NEW session
 * (`POST /api/sessions/{name}/fork`, optional `{seq, name}`) and leaves the
 * original session file and sidecar byte-identical. The row menu action forks
 * at the end of the conversation, so it sends no `seq`; an explicit name/seq is
 * available to library callers and tests. Nothing here depends on the DOM.
 */

import type { SessionForkResult } from './types'

/** One-line explanation shown with the menu action (honest, no jargon). */
export const FORK_MENU_HINT =
  'Copies the conversation into a new session; the original is untouched.'

/** Menu label: the ellipsis marks the follow-up confirmation/notice. */
export const FORK_MENU_LABEL = 'Fork session…'

/**
 * Transcript action label (wave 26): branches the conversation at one operator
 * message instead of at the end. The accessible name is the full label; the
 * bubble renders the compact visible word "fork".
 */
export const FORK_FROM_HERE_LABEL = 'Fork from here…'

/** One-line explanation for the transcript action (honest, no jargon). */
export const FORK_FROM_HERE_HINT =
  'Copy this session through this message into a new session; the source is untouched.'

/** What the row knows about the session's state when the action is offered. */
export interface ForkAvailabilityContext {
  /** A run is live (queued/running/waiting) for this session. */
  live?: boolean
  /** Another row action (rename/export/delete/fork) is still in flight. */
  busy?: boolean
}

/** Why forking is unavailable right now, or null when it is available. */
export interface ForkAvailability {
  available: boolean
  /** Honest reason when unavailable (a plain sentence, never a fake tooltip). */
  reason: string | null
}

/**
 * Availability rule: never fork a session whose run is active — the fork reads
 * a prefix of an append-only log, but the operator should fork a quiescent
 * session so the copy is a stable point in time. A busy row defers a second
 * action for the same reason the other menu actions do.
 */
export function forkAvailability(
  context: ForkAvailabilityContext | null | undefined,
): ForkAvailability {
  if (!context) return { available: true, reason: null }
  if (context.busy) return { available: false, reason: 'Another session action is still running…' }
  if (context.live) {
    return {
      available: false,
      reason: 'Forking is unavailable while a run is active for this session. Stop the run first.',
    }
  }
  return { available: true, reason: null }
}

/**
 * The optional `POST /fork` body: only explicitly supplied, usable fields are
 * sent (the menu action sends `{}` = fork the whole session under a generated
 * name). `seq` must be a positive integer; a blank name is omitted.
 */
export function forkRequestBody(
  options: { seq?: number | null; name?: string | null } = {},
): { seq?: number; name?: string } {
  const body: { seq?: number; name?: string } = {}
  const seq = options.seq
  if (typeof seq === 'number' && Number.isInteger(seq) && seq >= 1) body.seq = seq
  const name = typeof options.name === 'string' ? options.name.trim() : ''
  if (name) body.name = name
  return body
}

/**
 * The cut point a transcript bubble can fork at, or null when the bubble is not
 * a safe marker. Only operator `message` envelopes carry a bubble (repair and
 * compaction traffic projects as system activity), and the protocol keeps `seq`
 * dense/positive, so a valid bubble seq is exactly the prefix the backend
 * copies (`at seq 1..N`).
 */
export function forkFromHerePoint(
  message: { kind?: string | null; seq?: number | null } | null | undefined,
): { seq: number } | null {
  if (!message || message.kind !== 'message') return null
  const seq = message.seq
  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 1) return null
  return { seq }
}

/**
 * Confirmation shown before a prefix fork. It names the cut (the envelope seq
 * of the message the operator picked) and repeats the one fact that matters:
 * the source session is never modified.
 */
export function forkFromHereConfirmation(input: {
  seq: number
  session?: string | null
}): string {
  const seq = Number.isInteger(input.seq) && input.seq >= 1 ? input.seq : 0
  const source =
    typeof input.session === 'string' && input.session.trim()
      ? ` ${input.session.trim()}`
      : ' this session'
  const through = seq > 0 ? ` through this message (envelope ${seq})` : ' through this message'
  return `Copy${source}${through} into a new session; the source is untouched.`
}

/** Envelope count from a fork result, defensively bounded (display only). */
function copiedCount(result: Pick<SessionForkResult, 'events'> | null | undefined): number {
  const events = result?.events
  return typeof events === 'number' && Number.isFinite(events) && events > 0
    ? Math.floor(events)
    : 0
}

/**
 * Success copy: names the new session, how much was copied and repeats that the
 * original is untouched (the one fact an operator must not have to guess).
 */
export function forkSuccessNotice(
  result: Pick<SessionForkResult, 'name' | 'events'> | null | undefined,
  source?: string | null,
): string {
  const name = typeof result?.name === 'string' && result.name.trim() ? result.name.trim() : 'the new session'
  const from = typeof source === 'string' && source.trim() ? ` from ${source.trim()}` : ''
  const count = copiedCount(result)
  return `Forked${from} to ${name} — ${count} ${count === 1 ? 'envelope' : 'envelopes'} copied; the original session is untouched.`
}

/**
 * Honest failure copy for a rejected fork. The backend detail wins when there
 * is one; otherwise the status maps to the documented route contract
 * (400 invalid seq/name, 404 unknown source, 409 name taken, 422 corrupt
 * source). Status 0 means the backend could not be reached.
 */
export function forkFailureNotice(input: {
  status?: number
  detail?: string
} | null | undefined): string {
  const status = typeof input?.status === 'number' ? input.status : 0
  const detail = typeof input?.detail === 'string' ? input.detail.trim() : ''
  if (status === 0) return 'The backend is unreachable — nothing was forked.'
  if (status === 400) return detail || 'That fork request was rejected.'
  if (status === 404) return 'This session is no longer known — refresh the session list.'
  if (status === 409) return detail || 'A session with that name already exists.'
  if (status === 422) return detail || 'The session file cannot be read; it may be corrupt.'
  return detail || `Fork failed (HTTP ${status}).`
}
