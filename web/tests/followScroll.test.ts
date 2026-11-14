// Focused tests for src/followScroll.ts (the chat transcript's bottom-follow
// model). No DOM: geometry is plain numbers so the gesture predictions and
// the follow state machine are exercised offline:
//   node --import ./tests/register-ts.mjs --test tests/followScroll.test.ts

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  ARROW_KEY_SCROLL_PX,
  BOTTOM_EPSILON_PX,
  FALLBACK_LINE_HEIGHT_PX,
  FOLLOW_THRESHOLD_PX,
  applyGestureFollow,
  applyProgrammaticFollow,
  applyScrolledFollow,
  clampScrollTop,
  distanceFromBottom,
  initialFollowState,
  isAtBottom,
  isNearBottom,
  maxScrollTop,
  predictedScrollTopAfterTouch,
  predictedScrollTopAfterWheel,
  predictedScrollTopForKey,
  trackableTouch,
  wheelDeltaYPixels,
  wheelAffectsFollow,
} from '../src/followScroll.ts'
import type { FollowState, ScrollGeometry } from '../src/followScroll.ts'

function geom(overrides: Partial<ScrollGeometry> = {}): ScrollGeometry {
  // 5000px of content in a 800px viewport, parked at the bottom
  return { scrollHeight: 5000, scrollTop: 4200, clientHeight: 800, ...overrides }
}

test('isNearBottom uses the 120px follow threshold', () => {
  assert.equal(isNearBottom(geom({ scrollTop: 5000 - 800 - 119 })), true)
  assert.equal(isNearBottom(geom({ scrollTop: 5000 - 800 - 120 })), false)
  assert.equal(isNearBottom(geom({ scrollTop: 0 })), false)
  assert.equal(isNearBottom(geom({ scrollTop: 5000 - 800 })), true)
  assert.equal(isNearBottom(geom({ scrollHeight: 700, scrollTop: 0 })), true, 'non-scrollable counts as near')
  assert.equal(isNearBottom(geom(), 0), false, 'a zero threshold needs a strictly negative distance')
  assert.equal(isNearBottom(geom({ scrollTop: 5000 - 800 }), 1), true)
})

test('distanceFromBottom and maxScrollTop describe the same edge', () => {
  const g = geom()
  assert.equal(distanceFromBottom(g), 0)
  assert.equal(maxScrollTop(g), 4200)
  assert.equal(maxScrollTop(geom({ scrollHeight: 500 })), 0, 'content shorter than the viewport cannot scroll')
})

test('clampScrollTop keeps programmatic targets in range', () => {
  const g = geom()
  assert.equal(clampScrollTop(-50, g), 0)
  assert.equal(clampScrollTop(99999, g), 4200)
  assert.equal(clampScrollTop(1200, g), 1200)
})

test('isAtBottom admits a 2px epsilon around the bottom edge', () => {
  assert.equal(BOTTOM_EPSILON_PX, 2)
  assert.equal(isAtBottom(geom()), true)
  assert.equal(isAtBottom(geom({ scrollTop: 4200 - 2 })), true)
  assert.equal(isAtBottom(geom({ scrollTop: 4200 - 3 })), false)
  assert.equal(isAtBottom(geom({ scrollTop: 0 })), false)
  // content shorter than the viewport rests at the bottom by definition
  assert.equal(isAtBottom(geom({ scrollHeight: 700, scrollTop: 0 })), true)
})

test('wheelDeltaYPixels scales line and page modes', () => {
  assert.equal(wheelDeltaYPixels(120, 0, 16, 800), 120)
  assert.equal(wheelDeltaYPixels(3, 1, 20, 800), 60)
  assert.equal(wheelDeltaYPixels(-1, 2, 16, 800), -800)
  assert.equal(wheelDeltaYPixels(120, 99, 16, 800), 120, 'unknown modes fall back to pixels')
})

test('wheelAffectsFollow ignores horizontal-only and Ctrl+wheel (zoom) gestures', () => {
  assert.equal(wheelAffectsFollow({ deltaY: -120, ctrlKey: false }), true)
  assert.equal(wheelAffectsFollow({ deltaY: 120, ctrlKey: false }), true)
  assert.equal(wheelAffectsFollow({ deltaY: 0, ctrlKey: false }), false, 'horizontal-only wheels scroll nothing vertically')
  assert.equal(wheelAffectsFollow({ deltaY: -120, ctrlKey: true }), false, 'Ctrl+wheel is a zoom gesture, not a scroll')
  assert.equal(wheelAffectsFollow({ deltaY: 120, ctrlKey: true }), false)
})

test('trackableTouch only tracks a single-finger pan', () => {
  const touch = { clientY: 300 }
  assert.equal(trackableTouch({ length: 0 }), null, 'no active touch')
  assert.equal(trackableTouch({ length: 1, 0: touch }), touch)
  assert.equal(trackableTouch({ length: 2, 0: touch, 1: { clientY: 400 } }), null, 'multi-touch travel is ambiguous')
})

test('a small wheel up from the bottom cancels follow even inside the band', () => {
  const g = geom()
  // 100px up lands 100px from the bottom: inside the 120px threshold, but a
  // deliberate upward gesture parks the reader — the hold must engage
  const landed = predictedScrollTopAfterWheel(-100, 0, g, FALLBACK_LINE_HEIGHT_PX)
  assert.equal(landed, 4100)
  assert.equal(isNearBottom({ ...g, scrollTop: landed }), true)
  const next = applyGestureFollow(initialFollowState(), landed, g)
  assert.deepEqual(next, { nearBottom: false, hold: true })
})

test('the asynchronously dispatched scroll event must not undo an in-band hold', () => {
  const g = geom()
  const held = applyGestureFollow(initialFollowState(), predictedScrollTopAfterWheel(-100, 0, g, 16), g)
  assert.equal(held.hold, true)
  // the gesture's own scroll event arrives once the browser has applied the
  // 100px move: geometry alone would call this "near bottom", the hold wins
  const afterScroll = applyScrolledFollow(held, { ...g, scrollTop: 4100 })
  assert.deepEqual(afterScroll, { nearBottom: false, hold: true }, 'onScroll keeps the pin disengaged')
})

test('follow resumes only at the actual bottom, not merely inside the band', () => {
  const g = geom()
  const held = applyGestureFollow(initialFollowState(), predictedScrollTopAfterWheel(-100, 0, g, 16), g)
  // 3px off the bottom is inside the band but not "at" it: still held
  assert.deepEqual(applyScrolledFollow(held, { ...g, scrollTop: 4197 }), { nearBottom: false, hold: true })
  // growth past the bottom edge (rewind/shrink) counts as returned
  assert.deepEqual(applyScrolledFollow(held, { ...g, scrollTop: 4202 }), { nearBottom: true, hold: false })
  assert.deepEqual(applyScrolledFollow(held, { ...g, scrollTop: 4200 }), { nearBottom: true, hold: false })
  // back at the band but off the edge: held again from a fresh gesture
  const reheld = applyGestureFollow({ nearBottom: true, hold: false }, 4100, { ...g, scrollTop: 4200 })
  assert.deepEqual(reheld, { nearBottom: false, hold: true })
})

test('repeated upward gestures before any scroll event keep the hold', () => {
  let state: FollowState = initialFollowState()
  const g = geom()
  // three quick notches land 100px, 200px, 300px up — only the first scroll
  // event may dispatch after all of them
  for (const up of [-100, -100, -100]) {
    state = applyGestureFollow(state, predictedScrollTopAfterWheel(up, 0, g, 16), g)
    assert.equal(state.hold, true)
    assert.equal(state.nearBottom, false)
  }
  // then the scroll events arrive, one per notch: none re-enables the pin
  state = applyScrolledFollow(state, { ...g, scrollTop: 4100 })
  state = applyScrolledFollow(state, { ...g, scrollTop: 4000 })
  state = applyScrolledFollow(state, { ...g, scrollTop: 3900 })
  assert.deepEqual(state, { nearBottom: false, hold: true })
})

test('a decisive wheel up cancels follow', () => {
  const g = geom()
  const landed = predictedScrollTopAfterWheel(-480, 0, g, FALLBACK_LINE_HEIGHT_PX)
  assert.equal(landed, 3720)
  assert.deepEqual(applyGestureFollow(initialFollowState(), landed, g), { nearBottom: false, hold: true })
})

test('wheeling down at the bottom keeps the pin (follow preserved)', () => {
  const g = geom()
  assert.equal(predictedScrollTopAfterWheel(480, 0, g, FALLBACK_LINE_HEIGHT_PX), 4200)
  assert.deepEqual(
    applyGestureFollow(initialFollowState(), predictedScrollTopAfterWheel(480, 0, g, FALLBACK_LINE_HEIGHT_PX), g),
    { nearBottom: true, hold: false },
  )
})

test('wheel deltas clamp at the top edge', () => {
  const g = geom()
  assert.equal(predictedScrollTopAfterWheel(-99999, 0, g, FALLBACK_LINE_HEIGHT_PX), 0)
  const atTop = geom({ scrollTop: 0 })
  assert.equal(isNearBottom({ ...atTop, scrollTop: predictedScrollTopAfterWheel(-480, 0, atTop, 16) }), false)
})

test('touch drag predicts from the touchstart baseline and re-engages at the bottom', () => {
  const g = geom()
  // the content follows the finger: swiping DOWN the screen reveals older
  // content (scrollTop shrinks) — the gesture that must cancel follow
  assert.equal(predictedScrollTopAfterTouch(4200, 100, 700, g), 3600)
  assert.deepEqual(
    applyGestureFollow(initialFollowState(), predictedScrollTopAfterTouch(4200, 100, 700, g), g),
    { nearBottom: false, hold: true },
  )
  // swiping back up to (and past) the bottom re-engages follow
  assert.equal(predictedScrollTopAfterTouch(3600, 700, 100, g), 4200)
  assert.deepEqual(
    applyGestureFollow({ nearBottom: false, hold: true }, predictedScrollTopAfterTouch(3600, 700, 100, g), g),
    { nearBottom: true, hold: false },
  )
})

test('a small upward touch nudge inside the band still parks the reader', () => {
  const g = geom()
  // 100px swipe lands 100px from the bottom — inside the band, held anyway
  const landed = predictedScrollTopAfterTouch(4200, 600, 700, g)
  assert.equal(landed, 4100)
  assert.deepEqual(applyGestureFollow(initialFollowState(), landed, g), { nearBottom: false, hold: true })
})

test('while held, downward movement short of the bottom keeps the pin off', () => {
  const g = geom()
  const held: FollowState = { nearBottom: false, hold: true }
  // parked 300px up, a 100px wheel down lands 200px up: not the bottom yet
  const parked = geom({ scrollTop: 3900 })
  const landed = predictedScrollTopAfterWheel(100, 0, parked, FALLBACK_LINE_HEIGHT_PX)
  assert.equal(landed, 4000)
  assert.deepEqual(applyGestureFollow(held, landed, parked), { nearBottom: false, hold: true })
})

test('without a hold, downward movement inside the band keeps normal bottom following', () => {
  const g = geom()
  // parked 100px up with no hold (e.g. after chrome compensation), a small
  // wheel down that lands back inside the band preserves follow — the
  // pre-hold geometry semantics for downward movement
  const parked = geom({ scrollTop: 4100 })
  const landed = predictedScrollTopAfterWheel(60, 0, parked, FALLBACK_LINE_HEIGHT_PX)
  assert.equal(landed, 4160)
  assert.deepEqual(applyGestureFollow({ nearBottom: false, hold: false }, landed, parked), {
    nearBottom: true,
    hold: false,
  })
})

test('applyScrolledFollow without a hold keeps geometry-decided follow', () => {
  // parked 100px up, no hold: inside the band → the pin may re-engage (the
  // compensation/show-earlier path relies on this)
  assert.deepEqual(applyScrolledFollow({ nearBottom: true, hold: false }, { ...geom(), scrollTop: 4100 }), {
    nearBottom: true,
    hold: false,
  })
  assert.deepEqual(applyScrolledFollow({ nearBottom: true, hold: false }, { ...geom(), scrollTop: 3000 }), {
    nearBottom: false,
    hold: false,
  })
})

test('programmatic reveals supersede the hold: geometry decides again', () => {
  const held: FollowState = { nearBottom: false, hold: true }
  // a find/history reveal landing inside the band re-enables follow exactly
  // as it did before the hold existed
  assert.deepEqual(applyProgrammaticFollow(held, { ...geom(), scrollTop: 4100 }), { nearBottom: true, hold: false })
  // and a reveal landing away from the bottom keeps it off, hold cleared
  assert.deepEqual(applyProgrammaticFollow(held, { ...geom(), scrollTop: 1000 }), { nearBottom: false, hold: false })
})

test('keyboard scroll keys predict their landing position', () => {
  const g = geom()
  assert.equal(predictedScrollTopForKey('PageUp', g), 4200 - 800)
  assert.equal(predictedScrollTopForKey('PageDown', g), 4200)
  assert.equal(predictedScrollTopForKey(' ', g), 4200)
  assert.equal(predictedScrollTopForKey('ArrowUp', g), 4200 - ARROW_KEY_SCROLL_PX)
  assert.equal(predictedScrollTopForKey('ArrowDown', g), 4200)
  assert.equal(predictedScrollTopForKey('Home', g), 0)
  assert.equal(predictedScrollTopForKey('End', g), 4200)
  assert.equal(predictedScrollTopForKey('Enter', g), null, 'Enter does not scroll')
  assert.equal(predictedScrollTopForKey('x', g), null)
})

test('Shift+Space predicts an upward landing like PageUp', () => {
  const g = geom()
  assert.equal(predictedScrollTopForKey(' ', g, { shiftKey: true }), 4200 - 800)
  assert.equal(
    isNearBottom({ ...g, scrollTop: predictedScrollTopForKey(' ', g, { shiftKey: true }) ?? 4200 }),
    false,
  )
  // without the modifier Space still pages down
  assert.equal(predictedScrollTopForKey(' ', g, { shiftKey: false }), 4200)
  // a small ArrowUp nudge lands inside the band — as a deliberate upward key
  // it parks the reader just like a wheel notch
  const landed = predictedScrollTopForKey('ArrowUp', g) ?? 4200
  assert.equal(isNearBottom({ ...g, scrollTop: landed }), true)
  assert.deepEqual(applyGestureFollow(initialFollowState(), landed, g), { nearBottom: false, hold: true })
})

test('PageUp near the top clamps and lands away from the bottom', () => {
  const nearTop = geom({ scrollTop: 300 })
  assert.equal(predictedScrollTopForKey('PageUp', nearTop), 0)
  assert.equal(isNearBottom({ ...nearTop, scrollTop: 0 }), false)
})

test('End re-engages follow from anywhere', () => {
  const up = geom({ scrollTop: 0 })
  const end: FollowState = { nearBottom: false, hold: true }
  assert.deepEqual(applyGestureFollow(end, predictedScrollTopForKey('End', up) ?? -1, up), {
    nearBottom: true,
    hold: false,
  })
})

test('the reported race: an in-flight pin sees the gesture-updated follow state', () => {
  // Reader pinned at the bottom while tokens stream; a wheel-up gesture must
  // flip the state synchronously (before any scroll event), so the next token
  // frame's pin guard — reading the same state — stands down.
  const g = geom()
  let state = initialFollowState()
  assert.equal(state.nearBottom, true)
  const landed = predictedScrollTopAfterWheel(-480, 0, g, FALLBACK_LINE_HEIGHT_PX)
  state = applyGestureFollow(state, landed, g)
  assert.equal(state.nearBottom, false, 'the state flips before the browser even dispatches the scroll event')
  // the token frame's pin guard reads `nearBottom` here — and stands down
  assert.equal(state.hold, true)
})

test('FOLLOW_THRESHOLD_PX matches the documented follow band', () => {
  assert.equal(FOLLOW_THRESHOLD_PX, 120)
})
