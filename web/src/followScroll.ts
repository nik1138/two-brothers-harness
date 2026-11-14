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

/** Keys that scroll a scrollable region, and where each one lands. */
export function predictedScrollTopForKey(
  key: string,
  g: ScrollGeometry,
  arrowStepPx = ARROW_KEY_SCROLL_PX,
): number | null {
  switch (key) {
    case 'PageUp':
      return clampScrollTop(g.scrollTop - g.clientHeight, g)
    case 'PageDown':
    case ' ':
      return clampScrollTop(g.scrollTop + g.clientHeight, g)
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
