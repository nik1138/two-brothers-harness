// Focused tests for src/followScroll.ts (the chat transcript's bottom-follow
// model). No DOM: geometry is plain numbers so the gesture predictions are
// exercised offline:
//   node --import ./tests/register-ts.mjs --test tests/followScroll.test.ts

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  ARROW_KEY_SCROLL_PX,
  FALLBACK_LINE_HEIGHT_PX,
  FOLLOW_THRESHOLD_PX,
  clampScrollTop,
  distanceFromBottom,
  isNearBottom,
  maxScrollTop,
  predictedScrollTopAfterTouch,
  predictedScrollTopAfterWheel,
  predictedScrollTopForKey,
  wheelDeltaYPixels,
} from '../src/followScroll.ts'
import type { ScrollGeometry } from '../src/followScroll.ts'

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

test('wheelDeltaYPixels scales line and page modes', () => {
  assert.equal(wheelDeltaYPixels(120, 0, 16, 800), 120)
  assert.equal(wheelDeltaYPixels(3, 1, 20, 800), 60)
  assert.equal(wheelDeltaYPixels(-1, 2, 16, 800), -800)
  assert.equal(wheelDeltaYPixels(120, 99, 16, 800), 120, 'unknown modes fall back to pixels')
})

test('a small wheel up from the bottom stays in follow range', () => {
  const g = geom()
  // 100px up lands 100px from the bottom: still inside the 120px threshold
  const landed = predictedScrollTopAfterWheel(-100, 0, g, FALLBACK_LINE_HEIGHT_PX)
  assert.equal(landed, 4100)
  assert.equal(isNearBottom({ ...g, scrollTop: landed }), true)
})

test('a decisive wheel up cancels follow', () => {
  const g = geom()
  const landed = predictedScrollTopAfterWheel(-480, 0, g, FALLBACK_LINE_HEIGHT_PX)
  assert.equal(landed, 3720)
  assert.equal(isNearBottom({ ...g, scrollTop: landed }), false)
})

test('wheeling down at the bottom keeps the pin (follow preserved)', () => {
  const g = geom()
  assert.equal(predictedScrollTopAfterWheel(480, 0, g, FALLBACK_LINE_HEIGHT_PX), 4200)
  assert.equal(
    isNearBottom({ ...g, scrollTop: predictedScrollTopAfterWheel(480, 0, g, FALLBACK_LINE_HEIGHT_PX) }),
    true,
  )
})

test('wheel deltas clamp at the top edge', () => {
  const g = geom()
  assert.equal(predictedScrollTopAfterWheel(-99999, 0, g, FALLBACK_LINE_HEIGHT_PX), 0)
  const atTop = geom({ scrollTop: 0 })
  assert.equal(isNearBottom({ ...atTop, scrollTop: predictedScrollTopAfterWheel(-480, 0, atTop, 16) }), false)
})

test('horizontal-only wheel gestures do not move the follow state', () => {
  const g = geom()
  assert.equal(predictedScrollTopAfterWheel(0, 0, g, FALLBACK_LINE_HEIGHT_PX), 4200)
})

test('touch drag predicts from the touchstart baseline and re-engages at the bottom', () => {
  const g = geom()
  // the content follows the finger: swiping DOWN the screen reveals older
  // content (scrollTop shrinks) — the gesture that must cancel follow
  assert.equal(predictedScrollTopAfterTouch(4200, 100, 700, g), 3600)
  assert.equal(
    isNearBottom({ ...g, scrollTop: predictedScrollTopAfterTouch(4200, 100, 700, g) }),
    false,
  )
  // swiping back up to (and past) the bottom re-engages follow
  assert.equal(predictedScrollTopAfterTouch(3600, 700, 100, g), 4200)
  assert.equal(
    isNearBottom({ ...g, scrollTop: predictedScrollTopAfterTouch(3600, 700, 100, g) }),
    true,
  )
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

test('PageUp near the top clamps and lands away from the bottom', () => {
  const nearTop = geom({ scrollTop: 300 })
  assert.equal(predictedScrollTopForKey('PageUp', nearTop), 0)
  assert.equal(isNearBottom({ ...nearTop, scrollTop: 0 }), false)
})

test('End re-engages follow from anywhere', () => {
  const up = geom({ scrollTop: 0 })
  assert.equal(isNearBottom({ ...up, scrollTop: predictedScrollTopForKey('End', up) ?? -1 }), true)
})

test('the reported race: an in-flight pin sees the gesture-updated follow flag', () => {
  // Reader pinned at the bottom while tokens stream; a wheel-up gesture must
  // flip the flag synchronously (before any scroll event), so the next token
  // frame's pin guard — reading the same flag — stands down.
  const g = geom()
  const follow = { nearBottom: isNearBottom(g) }
  assert.equal(follow.nearBottom, true)
  const landed = predictedScrollTopAfterWheel(-480, 0, g, FALLBACK_LINE_HEIGHT_PX)
  follow.nearBottom = isNearBottom({ ...g, scrollTop: landed })
  assert.equal(follow.nearBottom, false, 'the flag flips before the browser even dispatches the scroll event')
})

test('FOLLOW_THRESHOLD_PX matches the documented follow band', () => {
  assert.equal(FOLLOW_THRESHOLD_PX, 120)
})
