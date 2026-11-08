/**
 * Mid-run operator steering (wave 23): the pure decision/copy model behind the
 * composer's explicit "Steer run" action.
 *
 * A steer is an operator aside applied to a cooperation cycle that is ALREADY
 * working. The backend (`packages/harness`) accepts it only for an active run
 * (`running`, or `waiting` on an approval), queues it in memory and appends it
 * to the shared context at the run's next step — so this module deliberately
 * models two truths the UI must not blur:
 *
 * 1. steering is NOT queueing a next task: it applies at the next step of the
 *    followed run, while a normal submission queues behind it;
 * 2. a steer is only queued when the backend answered 200 — a rejected steer
 *    keeps the operator's draft untouched and says why.
 *
 * No DOM dependency: the composer and the unit tests share these decisions.
 */

import type { RunSteerResult, RunStatus } from './types'

/**
 * Largest steering text the web client sends. Mirrors the backend limit
 * (`packages/harness/src/runtime.ts::STEER_TEXT_MAX_CHARS`); the server is
 * still the authority and answers 400 beyond it.
 */
export const STEER_MAX_CHARS = 4000

/** The run statuses a steer can be applied to: `running`, or `waiting`. */
export const STEERABLE_RUN_STATUSES: readonly RunStatus[] = ['running', 'waiting']

/** The followed run, as far as steering is concerned. */
export interface SteerRunView {
  run_id: string
  status: RunStatus | string
}

/** Whether/why the composer's steer affordance is offered. */
export interface SteerAvailability {
  /** Render the control at all (only with a steerable active run). */
  visible: boolean
  /** The run status the control names, or null when no steerable run. */
  status: string | null
  /** Honest `title`/help text: where the text will be applied. */
  help: string
}

/** True when a run in this status can take a steer. */
export function isSteerableStatus(status: string | null | undefined): boolean {
  return typeof status === 'string' && (STEERABLE_RUN_STATUSES as readonly string[]).includes(status)
}

/**
 * Where a steer lands for one run status. `running` applies at the next step;
 * `waiting` is parked on an operator approval, so it applies at the next step
 * after the approval resolves. Anything else (queued, terminal) offers no
 * steer control: the backend would honestly answer 409.
 */
export function steerHelp(status: string): string {
  if (status === 'waiting') {
    return 'Applies to the run at its next step after the pending approval resolves — it does not start a new task.'
  }
  return 'Applies to the running run at its next step — it does not start a new task.'
}

/** Availability of the steer control for the followed run (null = no run). */
export function steerAvailability(run: SteerRunView | null | undefined): SteerAvailability {
  if (!run || !isSteerableStatus(run.status)) {
    return {
      visible: false,
      status: null,
      help: 'Steering is available while a run is working or waiting on an approval.',
    }
  }
  return { visible: true, status: String(run.status), help: steerHelp(run.status) }
}

/**
 * Why one draft cannot be steered with (null = it can). Mirrors the backend's
 * documented 400 cases (empty after trimming, over the character limit) so the
 * common failure never needs a round trip.
 */
export function steerTextError(text: string | null | undefined): string | null {
  const trimmed = typeof text === 'string' ? text.trim() : ''
  if (!trimmed) return 'Type a message to steer the run with.'
  if (trimmed.length > STEER_MAX_CHARS) {
    return `Steering text is limited to ${STEER_MAX_CHARS} characters.`
  }
  return null
}

/** True when the draft may be steered with. */
export function canSteerText(text: string | null | undefined): boolean {
  return steerTextError(text) === null
}

/** Clamp the backend's `pending` echo into the documented 0..cap range. */
export function clampSteerPending(value: unknown): number {
  const parsed = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : 0
  return Math.min(Math.max(parsed, 0), 8)
}

/**
 * Truthful confirmation for an accepted steer: it is QUEUED for the next step,
 * not delivered yet. A pending count above one is reported, never hidden.
 */
export function steeredNotice(result: Pick<RunSteerResult, 'pending'> | null | undefined): string {
  const pending = clampSteerPending(result?.pending)
  const suffix = pending > 1 ? ` (${pending} steering messages pending)` : ''
  return `Steer queued — it is applied at the run's next step${suffix}.`
}

/**
 * Honest operator-facing outcome for a rejected steer. The backend detail is
 * preferred when present (it names the run's real status or the full queue);
 * the status mapping covers transport and older/edge shapes.
 */
export function steerFailureNotice(input: {
  status?: number
  detail?: string
} | null | undefined): string {
  const status = typeof input?.status === 'number' ? input.status : 0
  const detail = typeof input?.detail === 'string' ? input.detail.trim() : ''
  if (status === 0) return 'The backend is unreachable — the steer was not delivered.'
  if (status === 400) return detail || 'That steering text was rejected.'
  if (status === 404) {
    return 'This run is no longer known — it may have ended or the backend restarted.'
  }
  if (status === 409) return detail || 'This run cannot take steering right now.'
  return detail || `Steering failed (HTTP ${status}).`
}
