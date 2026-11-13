/**
 * Operator child controls (slices A1 + A2). The **Stop helper** button and the
 * **follow-up field** live only in the child drawer; tree rows stay plain
 * buttons. An old backend has no helper routes (404), so the capability is
 * latched off for the rest of the session and one inline sentence replaces the
 * controls — the drawer still renders the transcript.
 *
 * Pure module: the drawer owns the requests, this owns the session latch and the
 * exact wording, so both are unit-testable without a DOM.
 */

import type { SubagentStatus } from './types'

/** The drawer's inline sentence when an old backend lacks helper controls. */
export const SUBAGENT_CONTROLS_UNSUPPORTED_NOTICE =
  'This backend does not support helper controls.'

/** Mirrors the backend's per-follow-up bound (one text, trimmed). */
export const SUBAGENT_FOLLOWUP_MAX_CHARS = 4_000

let controlsUnavailable = false

/** True once an old backend answered the interrupt route with 404. */
export function subagentControlsUnavailable(): boolean {
  return controlsUnavailable
}

/** Latch the capability off for the rest of the session. */
export function markSubagentControlsUnavailable(): void {
  controlsUnavailable = true
}

/** Test hook: clear the latch so one suite's backend cannot affect the next. */
export function resetSubagentControlsAvailability(): void {
  controlsUnavailable = false
}

export type SubagentInterruptStatus = 'interrupting' | 'already_finished'

/**
 * The drawer's notice for an accepted interrupt, or null when the terminal
 * `subagent_completed` event is the only feedback needed ("Stopping…" sits on
 * the button until then). An already-finished helper says so honestly instead
 * of pretending something was stopped.
 */
export function subagentInterruptNotice(
  status: SubagentInterruptStatus,
): string | null {
  return status === 'already_finished' ? 'The helper had already finished.' : null
}

/**
 * 404 on the child routes is the capability signal (old backend), not a child
 * error; every other status is a real failure the drawer shows inline.
 */
export function isMissingSubagentControlRoute(status: number | undefined): boolean {
  return status === 404
}

/**
 * The follow-up composer exists only while the child is live: a settled helper
 * has no next step, so it takes no text (its report is final). A parked helper
 * stays sendable — the queue holds the text until the wait resolves.
 */
export function canSendSubagentFollowUp(status: SubagentStatus): boolean {
  return status === 'running'
}

/**
 * The drawer's honest acceptance copy. `queued` is deliberate: the backend
 * never claims the helper read the text, only that it will at its next step.
 */
export function subagentFollowUpNotice(pending: number): string {
  const count = Number.isFinite(pending) && pending > 0 ? Math.trunc(pending) : 1
  return `queued — delivered at the helper's next step (${count} pending)`
}
