/**
 * Bottom-follow model for the chat transcript (pure).
 *
 * `ChatView` pins the transcript to the bottom ("follow mode") only while the
 * reader is already near the bottom; reading history must not be interrupted
 * by incoming messages or live token frames. The pin check reads a single
 * boolean, and this module decides when that boolean flips.
 *
 * The subtlety is *when* the boolean may be recomputed: the scroll event for a
 * user gesture is dispatched asynchronously, after the gesture's default
 * action, while a streaming token frame's `nextTick` pin runs on a microtask
 * in between. Reading `scrollTop` only inside the scroll handler therefore
 * races the pin: the pin re-pins to the bottom before the handler sees the new
 * position, the handler then recomputes from the re-pinned position, and
 * follow mode can never be escaped while tokens arrive quickly. The handlers
 * instead recompute the boolean *synchronously* from the gesture itself —
 * before the browser applies the scroll — using the landing position the
 * gesture will produce:
 *
 * - wheel: current `scrollTop` plus the (deltaMode-scaled) delta, clamped,
 * - touch drag: the touchstart baseline plus the finger's vertical travel,
 * - keyboard: the scroll position the key produces (PageUp/Down, arrows,
 *   Home/End, Space), or null for keys that do not scroll.
 *
 * A deliberate upward gesture parks the reader even when its landing stays
 * inside the 120px near-bottom band: {@link FollowState.hold} records that
 * manual hold, and the asynchronously dispatched scroll event must not undo
 * it. Only an actual return to the bottom edge (within
 * {@link BOTTOM_EPSILON_PX}) releases the hold and re-engages the pin.
 *
 * Programmatic scrolls (show-earlier, find/history reveals, window
 * compensation) set the boolean directly at the moment they move the
 * transcript, so an in-flight pin cannot override them either.
 *
 * No DOM or Vue dependency: the model is unit-tested directly.
 */

/** Distance from the bottom (px) that still counts as "near the bottom". */
export const FOLLOW_THRESHOLD_PX = 120

/** Fallback line height for `deltaMode: DOM_DELTA_LINE` wheel events. */
export const FALLBACK_LINE_HEIGHT_PX = 16

/** One vertical arrow-key press scrolls roughly this far. */
export const ARROW_KEY_SCROLL_PX = 40

/** A scroll position within this distance of the bottom edge counts as "at"
 *  the bottom": the reader has genuinely returned, releasing a manual hold. */
export const BOTTOM_EPSILON_PX = 2

/** Vertical scroll geometry of the transcript element. */
export interface ScrollGeometry {
  scrollHeight: number
  scrollTop: number
  clientHeight: number
}

/** Signed distance from the bottom edge; negative means scrolled past it. */
export function distanceFromBottom(g: ScrollGeometry): number {
  return g.scrollHeight - g.scrollTop - g.clientHeight
}

/** True when the reader sits within {@link FOLLOW_THRESHOLD_PX} of the bottom. */
export function isNearBottom(g: ScrollGeometry, threshold = FOLLOW_THRESHOLD_PX): boolean {
  return distanceFromBottom(g) < threshold
}

/** True when the scroll position sits essentially at the bottom edge. */
export function isAtBottom(g: ScrollGeometry, epsilon = BOTTOM_EPSILON_PX): boolean {
  return distanceFromBottom(g) <= epsilon
}

/** The largest reachable scrollTop for the geometry. */
export function maxScrollTop(g: ScrollGeometry): number {
  return Math.max(0, g.scrollHeight - g.clientHeight)
}

/** A scrollTop clamped into `[0, maxScrollTop]`. */
export function clampScrollTop(top: number, g: ScrollGeometry): number {
  return Math.max(0, Math.min(top, maxScrollTop(g)))
}

/** Convert a wheel delta to pixels (wheel events may count lines or pages). */
export function wheelDeltaYPixels(
  deltaY: number,
  deltaMode: number,
  lineHeightPx: number,
  pageHeightPx: number,
): number {
  if (deltaMode === 1) return deltaY * lineHeightPx
  if (deltaMode === 2) return deltaY * pageHeightPx
  return deltaY
}

/** The scrollTop a wheel event will land on, from the current geometry. */
export function predictedScrollTopAfterWheel(
  deltaY: number,
  deltaMode: number,
  g: ScrollGeometry,
  lineHeightPx: number,
): number {
  const pixels = wheelDeltaYPixels(deltaY, deltaMode, lineHeightPx, g.clientHeight)
  return clampScrollTop(g.scrollTop + pixels, g)
}

/** The scrollTop a one-finger vertical drag will land on (touch panning). */
export function predictedScrollTopAfterTouch(
  startScrollTop: number,
  startClientY: number,
  clientY: number,
  g: ScrollGeometry,
): number {
  return clampScrollTop(startScrollTop + (startClientY - clientY), g)
}

/** Minimal shape of a `TouchList` the model needs (a DOM TouchList fits). */
export interface TouchPointList {
  readonly length: number
  [index: number]: { clientY: number }
}

/**
 * The single touch a gesture may track, or null when the gesture is not a
 * one-finger pan: with no active touch there is nothing to track, and with
 * several fingers the travel is ambiguous — the baseline must stay reset
 * until a fresh single-finger touchstart re-arms it.
 */
export function trackableTouch(touches: TouchPointList): { clientY: number } | null {
  return touches.length === 1 ? touches[0] : null
}

/**
 * Whether a wheel event may change the transcript's follow state at all:
 * horizontal-only gestures scroll nothing vertically, and Ctrl+wheel is a
 * browser zoom gesture (pinch on trackpads), not a scroll.
 */
export function wheelAffectsFollow(wheel: { deltaY: number; ctrlKey: boolean }): boolean {
  return wheel.deltaY !== 0 && !wheel.ctrlKey
}

/** Options for {@link predictedScrollTopForKey}. */
export interface KeyScrollOptions {
  /** Shift+Space pages up (like PageUp) instead of down. */
  shiftKey?: boolean
  arrowStepPx?: number
}

/** Keys that scroll a scrollable region, and where each one lands. */
export function predictedScrollTopForKey(
  key: string,
  g: ScrollGeometry,
  opts: KeyScrollOptions = {},
): number | null {
  const arrowStepPx = opts.arrowStepPx ?? ARROW_KEY_SCROLL_PX
  switch (key) {
    case 'PageUp':
      return clampScrollTop(g.scrollTop - g.clientHeight, g)
    case 'PageDown':
      return clampScrollTop(g.scrollTop + g.clientHeight, g)
    case ' ':
      return opts.shiftKey
        ? clampScrollTop(g.scrollTop - g.clientHeight, g)
        : clampScrollTop(g.scrollTop + g.clientHeight, g)
    case 'ArrowUp':
      return clampScrollTop(g.scrollTop - arrowStepPx, g)
    case 'ArrowDown':
      return clampScrollTop(g.scrollTop + arrowStepPx, g)
    case 'Home':
      return 0
    case 'End':
      return maxScrollTop(g)
    default:
      return null
  }
}

/**
 * Bottom-follow state.
 *
 * `nearBottom` is what the streaming pin consults; `hold` records that the
 * reader deliberately scrolled up, so the pin must stay disengaged until the
 * reader returns to the actual bottom edge — even while the parked position
 * still lies inside the 120px near-bottom band and geometry alone would call
 * it "near".
 */
export interface FollowState {
  nearBottom: boolean
  hold: boolean
}

/** Fresh transcript: open at the bottom, nothing held. */
export function initialFollowState(): FollowState {
  return { nearBottom: true, hold: false }
}

/**
 * Follow-state transition for a deliberate reader gesture (wheel notch, touch
 * drag, scroll key) whose landing position `predictedTop` is computed
 * synchronously, before the browser applies the scroll.
 *
 * Upward movement always parks the reader: the hold engages even when the
 * landing stays inside the near-bottom band. Movement that reaches the actual
 * bottom edge releases the hold and re-engages the pin. Downward movement
 * short of the bottom keeps whatever state the reader already had, so normal
 * bottom following (small wheel-down notches inside the band) is preserved.
 */
export function applyGestureFollow(state: FollowState, predictedTop: number, g: ScrollGeometry): FollowState {
  const landing: ScrollGeometry = { ...g, scrollTop: clampScrollTop(predictedTop, g) }
  if (isAtBottom(landing)) return { nearBottom: true, hold: false }
  if (landing.scrollTop < g.scrollTop) return { nearBottom: false, hold: true }
  if (state.hold) return { nearBottom: false, hold: true }
  return { nearBottom: isNearBottom(landing), hold: false }
}

/**
 * Follow-state transition for a dispatched scroll event: the gesture's own
 * scroll (arriving asynchronously, after the gesture already updated the
 * state), a programmatic scroll, or a layout-driven reposition. While the
 * hold is engaged, geometry alone must not re-enable the pin — only an
 * actual-bottom position releases it.
 */
export function applyScrolledFollow(state: FollowState, g: ScrollGeometry): FollowState {
  if (state.hold) {
    return isAtBottom(g) ? { nearBottom: true, hold: false } : { nearBottom: false, hold: true }
  }
  return { nearBottom: isNearBottom(g), hold: false }
}

/**
 * Follow-state transition for programmatic transcript moves (show-earlier,
 * find/history reveals): geometry decides, and the deliberate reveal
 * supersedes any reader hold, exactly as before the hold existed.
 */
export function applyProgrammaticFollow(_state: FollowState, g: ScrollGeometry): FollowState {
  return { nearBottom: isNearBottom(g), hold: false }
}
