/**
 * Operator child controls (slice A1). The **Stop helper** button lives only in
 * the child drawer; tree rows stay plain buttons. An old backend has no
 * interrupt route (404), so the capability is latched off for the rest of the
 * session and one inline sentence replaces the control — the drawer still
 * renders the transcript.
 *
 * Pure module: the drawer owns the request, this owns the session latch and the
 * exact wording, so both are unit-testable without a DOM.
 */

/** The drawer's inline sentence when an old backend lacks helper controls. */
export const SUBAGENT_CONTROLS_UNSUPPORTED_NOTICE =
  'This backend does not support helper controls.'

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
