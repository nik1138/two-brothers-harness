/**
 * Browser tab title for background attention (wave 25).
 *
 * A long cooperation run can finish (or park on an approval) while the operator
 * is looking at another tab, so the document title carries the same state the
 * sidebar shows. The decision is pure and DOM-free — `App.vue` feeds it the refs
 * it already maintains and writes `document.title`; this module only formats.
 *
 * Title shapes:
 *
 *   running/queued   ▶ <session> — Two Brothers
 *   waiting          ! <session> — Two Brothers
 *   failed           <session> (failed) — Two Brothers
 *   unread, none     (N) Two Brothers
 *   no session       Two Brothers
 *   otherwise        <session> — Two Brothers
 *
 * Unread only shows as a count when nothing is selected: opening a session
 * consumes its unread state, and the selected session never is unread. The
 * markers are the documented two (`▶`, `!`) plus the plain `(failed)` word, no
 * other emoji or decoration.
 *
 * Session titles can be model-derived (`chat.ts#sessionTitle`), so the input is
 * sanitized: control characters, bidi overrides and line breaks are stripped,
 * whitespace is collapsed, and the finished title is capped at 120 chars. The
 * cap truncates the session part and keeps the product suffix readable.
 */

import type { RunStatus } from './types'

/** Hard cap on the finished document title (chars, after sanitizing). */
export const TAB_TITLE_MAX_CHARS = 120

/** Product name used when none is supplied (and for the restore-on-unmount). */
export const TAB_TITLE_DEFAULT_PRODUCT = 'Two Brothers'

/** Documented live markers; the failed state uses the plain `(failed)` word. */
const RUNNING_MARKER = '▶ '
const WAITING_MARKER = '! '
const FAILED_SUFFIX = ' (failed)'
const PRODUCT_SEPARATOR = ' — '

/**
 * C0/C1 controls, the bidi embedding/override/isolate set and the Unicode
 * line/paragraph separators. `\s+` below then turns the replacements into a
 * single space.
 */
const CONTROL_CHARS =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g

/** Run status the title understands; `null` means nothing to flag. */
export type TabTitleStatus = RunStatus | null

export interface TabTitleInput {
  /** Product name; blank/absent falls back to "Two Brothers". */
  product?: string | null
  /** Selected session's display title; blank/absent means no session on screen. */
  sessionTitle?: string | null
  /** Status of the selected session's run (live, parked, or terminal). */
  status?: TabTitleStatus
  /** Finished runs the operator has not opened, used only without a session. */
  unreadCount?: number | null
}

/**
 * Truncate to `max` chars, appending `…` when clipped. Never leaves half of a
 * surrogate pair at the cut point, so an emoji title stays printable.
 */
function capText(value: string, max: number): string {
  if (max <= 0) return ''
  if (value.length <= max) return value
  let end = max - 1 // room for the ellipsis
  const last = value.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end -= 1 // high surrogate without its pair
  return `${value.slice(0, end).trimEnd()}…`
}

/** Strip control/bidi chars, collapse whitespace, trim and bound. */
function cleanText(value: unknown): string {
  if (typeof value !== 'string') return ''
  const text = value.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim()
  return capText(text, TAB_TITLE_MAX_CHARS)
}

function cleanProduct(value: unknown): string {
  return cleanText(value) || TAB_TITLE_DEFAULT_PRODUCT
}

/** Tolerant unread count: finite, floored, never negative. */
function unreadTotal(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  const count = Math.floor(value)
  return count > 0 ? count : 0
}

/**
 * Prefix + (bounded) session + suffix, keeping the markers and the product
 * suffix intact when the session title is long.
 */
function composeTitle(prefix: string, session: string, suffix: string): string {
  const room = TAB_TITLE_MAX_CHARS - prefix.length - suffix.length
  if (room < 1) return capText(`${prefix}${session}${suffix}`, TAB_TITLE_MAX_CHARS)
  return `${prefix}${capText(session, room)}${suffix}`
}

/**
 * Decide the document title. Pure: the same input always yields the same
 * string, and every unknown/blank field falls back instead of guessing.
 */
export function tabTitle(input: TabTitleInput = {}): string {
  const product = cleanProduct(input.product)
  const session = cleanText(input.sessionTitle)

  if (session) {
    const suffix = `${PRODUCT_SEPARATOR}${product}`
    if (input.status === 'waiting') return composeTitle(WAITING_MARKER, session, suffix)
    if (input.status === 'queued' || input.status === 'running') {
      return composeTitle(RUNNING_MARKER, session, suffix)
    }
    if (input.status === 'failed') {
      return composeTitle('', session, `${FAILED_SUFFIX}${suffix}`)
    }
    return composeTitle('', session, suffix)
  }

  const unread = unreadTotal(input.unreadCount)
  if (unread > 0) return capText(`(${unread}) ${product}`, TAB_TITLE_MAX_CHARS)
  return capText(product, TAB_TITLE_MAX_CHARS)
}
