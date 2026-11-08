/**
 * TUI mid-run steering queue (wave 25): the pure decision model behind the
 * composer's steer chord.
 *
 * A steer is an operator aside applied to a cooperation cycle that is ALREADY
 * running. The harness (`HarnessOptions.steering`) drains a callback at every
 * state-machine node boundary and appends each text as an ordinary `message`
 * envelope from `user` to `senior` (payload prefixed `[[OPERATOR STEER]] `), so
 * this module deliberately models the same two truths the web module does:
 *
 * 1. steering is NOT queueing a next task: it applies at the next step of the
 *    followed turn, while a normal submission waits for the turn to finish;
 * 2. a steer is queued only when it passes the shipped bounds, and the
 *    composer is cleared only then — a rejection keeps the draft untouched.
 *
 * The queue carries the backend's exact limits (`STEER_TEXT_MAX_CHARS`,
 * `STEER_QUEUE_MAX`) and returns-and-clears in submission order. A stopped or
 * finished turn must never append anything, so {@link SteerQueue.drain} takes
 * the abort flag and clears without returning texts when it is set.
 *
 * No terminal, clock or I/O dependency: the app and the unit tests share these
 * decisions.
 */

import { STEER_QUEUE_MAX, STEER_TEXT_MAX_CHARS } from "../runtime.ts";

/** Why an enqueue was rejected (mirrors the backend's 400/409 cases). */
export type SteerRejectionReason = "empty" | "too_long" | "full";

/** One accepted steer: the trimmed text and the queue depth after it. */
export interface SteerAccepted {
  accepted: true;
  text: string;
  /** Texts pending after this enqueue (1-based, at most `STEER_QUEUE_MAX`). */
  pending: number;
}

/** One rejected steer with the operator-facing reason; the draft is kept. */
export interface SteerRejected {
  accepted: false;
  reason: SteerRejectionReason;
  message: string;
  /** Queue depth at rejection (informational; the text was not queued). */
  pending: number;
}

export type SteerDecision = SteerAccepted | SteerRejected;

/** Shared copy for an empty draft (same wording as the web composer). */
export const STEER_EMPTY_NOTICE = "Type a message to steer the running turn with.";

/** Why one draft cannot be steered with (null = it can). */
export function steerTextError(text: string): SteerRejectionReason | null {
  const trimmed = text.trim();
  if (trimmed === "") return "empty";
  if (trimmed.length > STEER_TEXT_MAX_CHARS) return "too_long";
  return null;
}

/**
 * Honest copy for a rejected enqueue. The bounds copy matches the web module;
 * a full queue names the backend's real 409 detail so the operator knows when
 * the next drain happens instead of reading a generic failure.
 */
export function steerRejectionMessage(reason: SteerRejectionReason, pending: number): string {
  switch (reason) {
    case "empty":
      return STEER_EMPTY_NOTICE;
    case "too_long":
      return `Steering text is limited to ${STEER_TEXT_MAX_CHARS} characters.`;
    case "full":
      return `steering queue is full (${pending} pending); retry after the turn's next step`;
  }
}

/** The per-turn bounded steer queue. */
export interface SteerQueue {
  /** Texts waiting for the harness's next drain. */
  readonly pending: number;
  /** Trim, bound-check and queue one draft; never throws. */
  enqueue(text: string): SteerDecision;
  /**
   * Return-and-clear the queued texts in submission order (the
   * `HarnessOptions.steering` callback). With `aborted` set, clear and return
   * nothing: a stopped turn may never append.
   */
  drain(aborted?: boolean): string[];
  /** Drop and return leftovers (turn end); `[]` when already empty. */
  clear(): string[];
}

/** Create one empty per-turn queue. */
export function createSteerQueue(): SteerQueue {
  const texts: string[] = [];
  return {
    get pending(): number {
      return texts.length;
    },
    enqueue(text: string): SteerDecision {
      const reason = steerTextError(text);
      if (reason !== null) {
        return {
          accepted: false,
          reason,
          message: steerRejectionMessage(reason, texts.length),
          pending: texts.length,
        };
      }
      if (texts.length >= STEER_QUEUE_MAX) {
        return {
          accepted: false,
          reason: "full",
          message: steerRejectionMessage("full", texts.length),
          pending: texts.length,
        };
      }
      const trimmed = text.trim();
      texts.push(trimmed);
      return { accepted: true, text: trimmed, pending: texts.length };
    },
    drain(aborted = false): string[] {
      if (aborted) {
        texts.length = 0;
        return [];
      }
      return texts.splice(0, texts.length);
    },
    clear(): string[] {
      return texts.splice(0, texts.length);
    },
  };
}

/**
 * Truthful acceptance toast: the text is QUEUED for the next step, not
 * delivered yet. The pending count is always reported, never hidden.
 */
export function steeredToast(pending: number): string {
  const count = Number.isFinite(pending) ? Math.max(0, Math.floor(pending)) : 0;
  return `Steer queued — applied at the turn's next step (${count} pending)`;
}

/**
 * Honest turn-end loss notice: texts still queued when the turn finished were
 * never applied. One bounded line, no silent loss.
 */
export function abandonedSteersToast(count: number): string {
  const n = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  return n === 1
    ? "turn ended before 1 queued steer was applied"
    : `turn ended before ${n} queued steers were applied`;
}
