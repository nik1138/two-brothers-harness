// Find-in-transcript matching (P2).
//
// Pure and DOM-free on purpose: the view feeds it the rendered transcript
// slices (`{ text }`, one per visible text region, in document order) and maps
// the returned offsets back onto DOM Ranges for highlighting. Keeping the
// matcher here means the behavior is unit-testable under plain `node --test`,
// without a browser or Vue.
//
// Contract:
//   - matches come back in document order (block order, then offset);
//   - offsets are UTF-16 code unit indices into the block text, but both ends
//     always sit on Unicode code point boundaries, so a match can never split a
//     surrogate pair or end inside a case-fold expansion;
//   - matching is non-overlapping and left to right: scanning resumes after the
//     end of the previous match, so "aa" hits "aaaa" twice, not three times;
//   - an empty or whitespace-only query matches nothing;
//   - the scan is linear in the total block text length for a fixed query
//     (repeated indexOf plus a bounded whole-word check per candidate).

/** One searchable slice of the transcript, in document order. */
export interface FindBlock {
  readonly text: string
}

/** A match inside `blocks[blockIndex]`, as UTF-16 code unit offsets. */
export interface FindMatch {
  readonly blockIndex: number
  /** Start offset (inclusive). */
  readonly start: number
  /** End offset (exclusive). */
  readonly end: number
}

export interface FindOptions {
  /** Default false: matching is case-insensitive (Unicode-aware folding). */
  readonly caseSensitive?: boolean
  /** Require non-word characters (or text edges) on both sides. */
  readonly wholeWord?: boolean
}

/** Letter, number or underscore; the whole-word boundary definition. */
const WORD_CHAR = /[\p{L}\p{N}_]/u

function isWordCodePoint(codePoint: number): boolean {
  return WORD_CHAR.test(String.fromCodePoint(codePoint))
}

interface FoldedText {
  /** Lower-cased text, folded one code point at a time. */
  readonly text: string
  /**
   * startOf[i] = original offset of the code point that produced folded unit i.
   * `null` means the fold is offset-preserving (every code point maps to the
   * same number of UTF-16 units), so folded offsets are original offsets.
   */
  readonly startOf: number[] | null
  /**
   * endCut[i] = original cut for a match that ends before folded unit i.
   * A cut between two code points is their shared offset; a cut inside a fold
   * expansion rounds up to that code point's end, so a highlight always covers
   * the whole original character. `null` when the mapping is the identity.
   */
  readonly endCut: number[] | null
}

/**
 * True when walking `text` and its lower-case form yields the same sequence of
 * code point lengths. Lower-casing never reorders code points, so that means
 * folded offsets line up with original offsets and no mapping table is needed.
 *
 * This keeps the common mixed-case ASCII case allocation-free instead of
 * building three arrays per character.
 */
function foldOffsetsAligned(text: string, lower: string): boolean {
  if (text.length !== lower.length) return false
  let i = 0
  let j = 0
  while (i < text.length && j < lower.length) {
    const a = text.codePointAt(i) as number
    const b = lower.codePointAt(j) as number
    const aLength = a > 0xffff ? 2 : 1
    const bLength = b > 0xffff ? 2 : 1
    if (aLength !== bLength) return false
    i += aLength
    j += bLength
  }
  return i === text.length && j === lower.length
}

/**
 * Lower-case `text` code point by code point, recording how every folded unit
 * maps back to the original. Folding per code point (rather than whole-string
 * `toLowerCase`) keeps the mapping O(1) per character and cannot merge
 * surrogate pairs; the trade-off is that context-sensitive folds (Greek final
 * sigma) are not reproduced, which is the documented behavior of this matcher.
 */
function foldText(text: string): FoldedText {
  const lower = text.toLowerCase()
  if (foldOffsetsAligned(text, lower)) return { text: lower, startOf: null, endCut: null }

  const pieces: string[] = []
  const startOf: number[] = []
  const endCut: number[] = []
  let original = 0
  for (const point of text) {
    const folded = point.toLowerCase()
    const end = original + point.length
    for (let i = 0; i < folded.length; i += 1) {
      startOf.push(original)
      endCut.push(i === 0 ? original : end)
    }
    pieces.push(folded)
    original = end
  }
  startOf.push(original)
  endCut.push(original)
  return { text: pieces.join(''), startOf, endCut }
}

/** True when `index` is not between the halves of a surrogate pair. */
function isCodePointBoundary(text: string, index: number): boolean {
  if (index <= 0 || index >= text.length) return true
  const before = text.charCodeAt(index - 1)
  const at = text.charCodeAt(index)
  return !(before >= 0xd800 && before <= 0xdbff && at >= 0xdc00 && at <= 0xdfff)
}

/** Code point immediately before `index` (index is a code point boundary). */
function codePointBefore(text: string, index: number): number {
  const last = text.charCodeAt(index - 1)
  if (last >= 0xdc00 && last <= 0xdfff && index >= 2) {
    const high = text.charCodeAt(index - 2)
    if (high >= 0xd800 && high <= 0xdbff) {
      return (high - 0xd800) * 0x400 + (last - 0xdc00) + 0x10000
    }
  }
  return last
}

/** Code point starting at `index` (index is a code point boundary). */
function codePointAfter(text: string, index: number): number {
  const first = text.charCodeAt(index)
  if (first >= 0xd800 && first <= 0xdbff && index + 1 < text.length) {
    const low = text.charCodeAt(index + 1)
    if (low >= 0xdc00 && low <= 0xdfff) {
      return (first - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000
    }
  }
  return first
}

/** Whole-word check on the ORIGINAL text (offsets are code point boundaries). */
function isWholeWord(text: string, start: number, end: number): boolean {
  if (start > 0 && isWordCodePoint(codePointBefore(text, start))) return false
  if (end < text.length && isWordCodePoint(codePointAfter(text, end))) return false
  return true
}

/**
 * Find every occurrence of `query` across `blocks`, in document order.
 *
 * Case-insensitive by default. `start`/`end` are UTF-16 offsets into
 * `blocks[blockIndex].text`, code-point aligned. See the module contract above
 * for ordering, overlap and whole-word semantics.
 */
export function findMatches(
  blocks: readonly FindBlock[],
  query: string,
  options: FindOptions = {},
): FindMatch[] {
  if (!Array.isArray(blocks) || typeof query !== 'string' || query.trim() === '') return []

  const caseSensitive = options.caseSensitive === true
  const wholeWord = options.wholeWord === true
  const foldedQuery = caseSensitive ? null : foldText(query)
  const needle = foldedQuery ? foldedQuery.text : query
  if (needle.length === 0) return []

  const matches: FindMatch[] = []
  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
    const text = blocks[blockIndex]?.text
    if (typeof text !== 'string' || text.length === 0) continue

    const folded = caseSensitive ? null : foldText(text)
    const haystack = folded ? folded.text : text
    if (haystack.length < needle.length) continue

    let from = 0
    for (;;) {
      const at = haystack.indexOf(needle, from)
      if (at === -1) break
      const foldedEnd = at + needle.length
      // A malformed query (lone surrogate) can match half of a pair; skipping
      // such candidates keeps every returned range code-point aligned.
      if (isCodePointBoundary(haystack, at) && isCodePointBoundary(haystack, foldedEnd)) {
        const start = folded?.startOf ? folded.startOf[at] : at
        const end = folded?.endCut ? folded.endCut[foldedEnd] : foldedEnd
        if (!wholeWord || isWholeWord(text, start, end)) {
          matches.push({ blockIndex, start, end })
        }
      }
      // Non-overlapping: the next scan starts after this candidate, even when
      // the candidate was rejected (a word-boundary miss cannot contain a
      // second valid occurrence of the same query at a later offset).
      from = foldedEnd
    }
  }
  return matches
}

/**
 * Index of the match after `index`, wrapping to the first one. `-1` means "no
 * active match" (the first Enter selects match 0); an empty result set is -1.
 */
export function nextMatch(index: number, count: number): number {
  const total = normalizeCount(count)
  if (total === 0) return -1
  if (!Number.isFinite(index) || index < 0) return 0
  return (Math.floor(index) + 1) % total
}

/**
 * Index of the match before `index`, wrapping to the last one. From "no active
 * match" (-1) this selects the last match, mirroring nextMatch's first-match
 * behavior for Shift+Enter.
 */
export function prevMatch(index: number, count: number): number {
  const total = normalizeCount(count)
  if (total === 0) return -1
  if (!Number.isFinite(index) || index < 0) return total - 1
  return (Math.floor(index) - 1 + total) % total
}

function normalizeCount(count: number): number {
  if (!Number.isFinite(count) || count <= 0) return 0
  return Math.floor(count)
}
