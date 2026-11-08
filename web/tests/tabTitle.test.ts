// Focused tests for src/tabTitle.ts — run directly:
//   node --import ./tests/register-ts.mjs --test tests/tabTitle.test.ts
// The title decision is pure and DOM-free, so nothing here touches `document`.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  TAB_TITLE_DEFAULT_PRODUCT,
  TAB_TITLE_MAX_CHARS,
  tabTitle,
} from '../src/tabTitle.ts'

const PRODUCT = 'Two Brothers'

test('defaults: no session and no status gives the bare product name', () => {
  assert.equal(tabTitle(), PRODUCT)
  assert.equal(tabTitle({}), PRODUCT)
  assert.equal(tabTitle({ sessionTitle: null }), PRODUCT)
  assert.equal(tabTitle({ sessionTitle: '' }), PRODUCT)
  assert.equal(tabTitle({ sessionTitle: '   \n\t ' }), PRODUCT)
  assert.equal(TAB_TITLE_DEFAULT_PRODUCT, PRODUCT)
})

test('matrix: running and queued share the play marker', () => {
  for (const status of ['running', 'queued'] as const) {
    assert.equal(
      tabTitle({ sessionTitle: 'Fix login', status }),
      `▶ Fix login — ${PRODUCT}`,
      status,
    )
  }
})

test('matrix: waiting carries the exclamation marker', () => {
  assert.equal(
    tabTitle({ sessionTitle: 'Fix login', status: 'waiting' }),
    `! Fix login — ${PRODUCT}`,
  )
})

test('matrix: failed is spelled out, never a colour/marker guess', () => {
  assert.equal(
    tabTitle({ sessionTitle: 'Fix login', status: 'failed' }),
    `Fix login (failed) — ${PRODUCT}`,
  )
})

test('matrix: completed and cancelled runs fall back to the plain title', () => {
  for (const status of ['completed', 'cancelled'] as const) {
    assert.equal(
      tabTitle({ sessionTitle: 'Fix login', status }),
      `Fix login — ${PRODUCT}`,
      status,
    )
  }
})

test('matrix: no session but a live/failed status stays honest (product only)', () => {
  // A marker needs a name to point at; without one the tab must not pretend.
  for (const status of ['running', 'queued', 'waiting', 'failed'] as const) {
    assert.equal(tabTitle({ status }), PRODUCT, status)
  }
})

test('unread: a count is shown only when nothing is selected', () => {
  assert.equal(tabTitle({ unreadCount: 1 }), `(1) ${PRODUCT}`)
  assert.equal(tabTitle({ unreadCount: 2 }), `(2) ${PRODUCT}`)
  assert.equal(tabTitle({ unreadCount: 12, sessionTitle: '   ' }), `(12) ${PRODUCT}`)

  // any selected session wins over the count (opening it consumes the unread)
  assert.equal(
    tabTitle({ sessionTitle: 'Fix login', unreadCount: 2 }),
    `Fix login — ${PRODUCT}`,
  )

  // a selected session never suppresses its own live/failed state
  assert.equal(
    tabTitle({ sessionTitle: 'Fix login', status: 'running', unreadCount: 9 }),
    `▶ Fix login — ${PRODUCT}`,
  )
})

test('unread: zero/negative/non-numeric counts are ignored tolerantly', () => {
  for (const unreadCount of [0, -1, -3.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(tabTitle({ unreadCount }), PRODUCT, String(unreadCount))
  }
  assert.equal(tabTitle({ unreadCount: '3' as unknown as number }), PRODUCT)
  // fractional counts floor rather than inventing a session
  assert.equal(tabTitle({ unreadCount: 2.9 }), `(2) ${PRODUCT}`)
})

test('sanitize: control chars and bidi overrides are stripped, not rendered', () => {
  assert.equal(
    tabTitle({ sessionTitle: 'Fix\u0000\n\tlogin\u001b\u0007', status: 'running' }),
    `▶ Fix login — ${PRODUCT}`,
  )
  assert.equal(
    tabTitle({ sessionTitle: '\u202eFix\u202c login\u2066' }),
    `Fix login — ${PRODUCT}`,
  )
  assert.equal(
    tabTitle({ sessionTitle: 'Fix\u2028login\u2029now' }),
    `Fix login now — ${PRODUCT}`,
  )
})

test('sanitize: whitespace is collapsed and trimmed; the marker stays adjacent', () => {
  assert.equal(
    tabTitle({ sessionTitle: '  Fix   login  ' }),
    `Fix login — ${PRODUCT}`,
  )
  assert.equal(
    tabTitle({ sessionTitle: '\n  Fix   login  \t' }),
    `Fix login — ${PRODUCT}`,
  )
  assert.equal(
    tabTitle({ sessionTitle: 'Fix\nlogin', status: 'waiting' }),
    `! Fix login — ${PRODUCT}`,
  )
})

test('sanitize: non-string and blank products fall back to the default', () => {
  assert.equal(tabTitle({ product: '   ', sessionTitle: 'Fix login' }), `Fix login — ${PRODUCT}`)
  assert.equal(tabTitle({ product: null, sessionTitle: 'Fix login' }), `Fix login — ${PRODUCT}`)
  assert.equal(
    tabTitle({ product: 42 as unknown as string, sessionTitle: 'Fix login' }),
    `Fix login — ${PRODUCT}`,
  )
  assert.equal(tabTitle({ product: 'Two Brothers Dev' }), 'Two Brothers Dev')
  assert.equal(
    tabTitle({ product: 'Two Brothers Dev', sessionTitle: 'Fix login' }),
    'Fix login — Two Brothers Dev',
  )
})

test('sanitize: a non-string session title is treated as absent', () => {
  assert.equal(tabTitle({ sessionTitle: 42 as unknown as string }), PRODUCT)
  assert.equal(
    tabTitle({ sessionTitle: 42 as unknown as string, unreadCount: 1 }),
    `(1) ${PRODUCT}`,
  )
})

test('cap: long session titles are bounded and keep the product suffix', () => {
  const long = 'x'.repeat(500)

  const plain = tabTitle({ sessionTitle: long })
  assert.equal(plain.length, TAB_TITLE_MAX_CHARS)
  assert.ok(plain.endsWith(`… — ${PRODUCT}`), plain)
  assert.ok(plain.startsWith('x'), plain)

  const running = tabTitle({ sessionTitle: long, status: 'running' })
  assert.equal(running.length, TAB_TITLE_MAX_CHARS)
  assert.ok(running.startsWith('▶ '), running)
  assert.ok(running.endsWith(`… — ${PRODUCT}`), running)

  const waiting = tabTitle({ sessionTitle: long, status: 'waiting' })
  assert.equal(waiting.length, TAB_TITLE_MAX_CHARS)
  assert.ok(waiting.startsWith('! '), waiting)
  assert.ok(waiting.endsWith(`… — ${PRODUCT}`), waiting)

  // the failed word survives the cut instead of being truncated mid-word
  const failed = tabTitle({ sessionTitle: long, status: 'failed' })
  assert.equal(failed.length, TAB_TITLE_MAX_CHARS)
  assert.ok(failed.endsWith(`… (failed) — ${PRODUCT}`), failed)
  assert.ok(!failed.includes('(fai…'), failed)
})

test('cap: a long custom product is bounded too', () => {
  const product = 'P'.repeat(500)
  const unread = tabTitle({ unreadCount: 3, product })
  assert.equal(unread.length, TAB_TITLE_MAX_CHARS)
  assert.ok(unread.startsWith(`(3) P`), unread)
  assert.ok(unread.endsWith('…'), unread)

  const session = tabTitle({ sessionTitle: 'Fix login', product })
  assert.ok(session.length <= TAB_TITLE_MAX_CHARS, String(session.length))
  assert.ok(session.endsWith('…'), session)
})

test('cap: truncation never leaves half of a surrogate pair (emoji titles)', () => {
  const long = '😀'.repeat(200)
  for (const status of [null, 'running', 'waiting', 'failed'] as const) {
    const title = tabTitle({ sessionTitle: long, status })
    assert.ok(title.length <= TAB_TITLE_MAX_CHARS, `${String(status)}: ${title.length}`)
    // at most the one backed-off code unit plus the ellipsis below the cap
    assert.ok(title.length >= TAB_TITLE_MAX_CHARS - 2, `${String(status)}: ${title.length}`)
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(title), `lone high surrogate: ${title}`)
    assert.ok(!/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(title), `lone low surrogate: ${title}`)
    // the emoji themselves are not replaced by a fallback glyph
    assert.ok(title.includes('😀'), title)
  }
})

test('shape: every non-default form keeps the documented separators', () => {
  assert.equal(tabTitle({ sessionTitle: 'Fix login' }), 'Fix login — Two Brothers')
  assert.equal(tabTitle({ sessionTitle: 'Fix login', status: 'running' }), '▶ Fix login — Two Brothers')
  assert.equal(tabTitle({ sessionTitle: 'Fix login', status: 'waiting' }), '! Fix login — Two Brothers')
  assert.equal(
    tabTitle({ sessionTitle: 'Fix login', status: 'failed' }),
    'Fix login (failed) — Two Brothers',
  )
  assert.equal(tabTitle({ unreadCount: 4 }), '(4) Two Brothers')
})
