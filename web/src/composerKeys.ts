/**
 * Composer key contract (pure): IME-safe submit, accelerated submit, the
 * Alt+Enter mid-run steering gesture, picker accept/dismiss keys, Up/Down
 * prompt-history recall (including when it must fall through to the
 * textarea), the `?`/`Ctrl+/` shortcut-reference chord and the double-Escape
 * stop gesture.
 *
 * `Composer.vue`/`App.vue` only act on what this module classifies, so the
 * contract is documented in one place and unit-tested without a DOM.
 */

import { classifyRecallKey, type RecallCaret } from './recall'

/** Two Escape presses within this window request a run stop. */
export const STOP_GESTURE_WINDOW_MS = 500

/** The subset of `KeyboardEvent` the classifier reads. */
export interface ComposerKeyInput {
  key: string
  shiftKey?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  isComposing?: boolean
  keyCode?: number
  repeat?: boolean
}

export type ComposerKeyAction =
  | 'submit'
  | 'submit-accelerated'
  | 'steer'
  | 'newline'
  | 'picker-accept'
  | 'picker-close'
  | 'picker-next'
  | 'picker-prev'
  | 'ignore'

/** True while an IME is composing (never act on those keystrokes). */
export function isImeComposing(input: ComposerKeyInput | null | undefined): boolean {
  if (!input) return false
  return input.isComposing === true || input.keyCode === 229
}

/**
 * One composer keystroke → one intent.
 *
 * - IME-composing keystrokes are ignored entirely.
 * - With a picker open: Enter/Tab accept, Shift+Enter keeps the newline,
 *   Escape/Shift+Tab close, ↑/↓ navigate — Enter can never submit, and
 *   Alt+Enter keeps its picker meaning (the picker owns the key while open).
 * - Otherwise: Enter submits (`Ctrl`/`Cmd`+Enter is the explicit accelerated
 *   gesture), Shift+Enter inserts a newline, Alt+Enter is the explicit
 *   mid-run steering gesture (`steer`; the caller decides whether a steerable
 *   run exists — the key contract is availability-free), a repeated (held)
 *   Enter is ignored so it cannot machine-gun sends, and a multi-modifier
 *   Ctrl/⌘+Alt+Enter stays `ignore` (it was never a submit or a steer chord).
 */
export function classifyComposerKey(
  input: ComposerKeyInput | null | undefined,
  pickerOpen: boolean,
): ComposerKeyAction {
  if (!input || typeof input.key !== 'string') return 'ignore'
  if (isImeComposing(input)) return 'ignore'

  if (pickerOpen) {
    switch (input.key) {
      case 'Escape':
        return 'picker-close'
      case 'Enter':
        if (input.shiftKey) return 'newline'
        return input.repeat ? 'ignore' : 'picker-accept'
      case 'Tab':
        return input.shiftKey ? 'picker-close' : 'picker-accept'
      case 'ArrowDown':
        return 'picker-next'
      case 'ArrowUp':
        return 'picker-prev'
      default:
        return 'ignore'
    }
  }

  if (input.key !== 'Enter') return 'ignore'
  if (input.shiftKey) return 'newline'
  if (input.repeat) return 'ignore'
  if (input.altKey) {
    // Alt+Enter is the dedicated steer gesture; Ctrl/⌘+Alt+Enter carries two
    // modifiers and keeps the pre-gesture "do nothing" meaning.
    return input.ctrlKey || input.metaKey ? 'ignore' : 'steer'
  }
  return input.ctrlKey || input.metaKey ? 'submit-accelerated' : 'submit'
}

/** What an Up/Down press means for composer recall, or null for "leave it". */
export type ComposerRecallAction = 'recall-previous' | 'recall-next' | null

/** What the composer knows when an Up/Down press reaches the recall bridge. */
export interface ComposerRecallContext {
  /** An open `/`/`@` picker owns Up/Down (list navigation). */
  pickerOpen: boolean
  /** Recall browsing is active: the box currently shows a recalled entry. */
  recallActive: boolean
  /** Accepted submissions available to recall (`0` = nothing to recall). */
  historyCount: number
}

/**
 * Recall bridge: an open picker owns Up/Down (list navigation), so recall only
 * applies while it is closed. The boundary rule itself lives in `recall.ts`
 * (single-line anywhere, multiline only at the draft's very edges) and the
 * returned action is applied by `Composer.vue` with `stepRecall`.
 *
 * `null` means "not a recall keystroke": the caller must leave the event alone
 * (no `preventDefault`, no state change) so the textarea keeps its native caret
 * movement. A key is only claimed when it actually does something: Up starts a
 * recall only when history exists, and Down only steps while browsing — an
 * inactive Down has nothing to navigate to and falls through.
 */
export function classifyComposerRecall(
  input: ComposerKeyInput | null | undefined,
  caret: RecallCaret | null | undefined,
  context: ComposerRecallContext,
): ComposerRecallAction {
  if (context.pickerOpen) return null
  const intent = classifyRecallKey(input, caret)
  if (intent === 'previous') {
    // Browsing keeps its exact semantics (including the honest no-op at the
    // oldest entry); starting a recall needs at least one accepted submission.
    return context.recallActive || context.historyCount > 0 ? 'recall-previous' : null
  }
  if (intent === 'next') {
    // Inactive recall has no entry to step forward to: pass the key through so
    // the textarea moves its caret instead of eating a no-op.
    return context.recallActive ? 'recall-next' : null
  }
  return null
}

/** True when `now` is a second Escape press inside the stop window. */
export function isStopGesture(
  previousAt: number | null | undefined,
  now: number,
  windowMs: number = STOP_GESTURE_WINDOW_MS,
): boolean {
  if (previousAt === null || previousAt === undefined) return false
  if (!Number.isFinite(previousAt) || !Number.isFinite(now) || windowMs <= 0) return false
  const delta = now - previousAt
  return delta >= 0 && delta <= windowMs
}

/** What the shell knows when an Escape reaches it. */
export interface StopGestureContext {
  /** A followed run is queued/running/waiting. */
  runActive: boolean
  /** The keystroke finished an IME composition. */
  composing?: boolean
  /** Held-down key auto-repeat. */
  repeat?: boolean
  /** A closer layer (picker, find, palette, dialog) already consumed it. */
  defaultPrevented?: boolean
  /** A modal dialog owns the keyboard. */
  dialogOpen?: boolean
  /** Focus is inside an approval card (its own keyboard surface). */
  approvalFocused?: boolean
  /** The mobile session drawer is open (not the conversation region). */
  drawerOpen?: boolean
  /** Focus is outside the conversation region (sidebar, header, footer…). */
  outsideConversation?: boolean
}

/** Guard for the double-Escape stop gesture (a single Escape stays normal). */
export function canUseStopGesture(context: StopGestureContext | null | undefined): boolean {
  if (!context || !context.runActive) return false
  if (context.composing || context.repeat || context.defaultPrevented) return false
  if (context.dialogOpen || context.approvalFocused || context.drawerOpen) return false
  if (context.outsideConversation) return false
  return true
}

/** Why the composer cannot submit right now (null = it can). */
export type ComposerLockReason = 'busy' | 'compacting' | 'waiting' | null

export interface ComposerSendContext {
  /** A followed run is working. */
  busy?: boolean
  /** The followed run is parked on an approval (drafting allowed, sending not). */
  waiting?: boolean
  /** A manual context compaction is in flight. */
  compacting?: boolean
  text?: string | null
}

/** Precedence: working run → compaction → approval wait. */
export function composerLockReason(
  context: ComposerSendContext | null | undefined,
): ComposerLockReason {
  if (!context) return 'busy'
  if (context.busy) return 'busy'
  if (context.compacting) return 'compacting'
  if (context.waiting) return 'waiting'
  return null
}

/** True when the draft may be submitted (non-empty text, no lock). */
export function canSubmitComposer(context: ComposerSendContext | null | undefined): boolean {
  if (!context) return false
  if (composerLockReason(context)) return false
  return typeof context.text === 'string' && context.text.trim().length > 0
}
