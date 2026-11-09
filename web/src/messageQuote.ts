// Message quoting for the web transcript (pure, no DOM dependency).
//
// A quote is ordinary Markdown: every source line becomes a blockquote line,
// so the model reads it exactly like any other quoted text. No protocol,
// persistence or API shape is involved — the composer draft is the whole
// transport.

/** Source-character budget before the truncation marker is added. */
export const QUOTE_MAX_CHARS = 4000

/** Honest notice appended inside the quote when the source was capped. */
export const QUOTE_TRUNCATION_MARKER = (limit: number): string =>
  `… [quote truncated at ${limit} characters]`

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}

/**
 * Format `text` as a Markdown blockquote for the composer.
 *
 * - CRLF and lone CR become LF; outer whitespace and blank lines are trimmed.
 * - Every non-blank line gets `> `; a blank line inside the quote stays `>`.
 * - The result ends with one blank line (`\n\n`) so the operator can type after
 *   the quote without editing it.
 * - At most `maxChars` source characters are quoted. A cut that would split a
 *   surrogate pair backs off one code unit, and an explicit marker says the
 *   quote was truncated. Empty/whitespace-only input yields `''`.
 */
export function quoteBlock(text: string, maxChars: number = QUOTE_MAX_CHARS): string {
  const normalized = typeof text === 'string' ? text.replace(/\r\n?/gu, '\n').trim() : ''
  if (normalized === '') return ''

  const limit = Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : 0
  let excerpt = normalized
  let truncated = false
  if (excerpt.length > limit) {
    let cut = limit
    if (
      cut > 0 &&
      cut < excerpt.length &&
      isHighSurrogate(excerpt.charCodeAt(cut - 1)) &&
      isLowSurrogate(excerpt.charCodeAt(cut))
    ) {
      cut -= 1
    }
    excerpt = excerpt.slice(0, cut).replace(/\s+$/u, '')
    truncated = true
  }

  const lines =
    excerpt === ''
      ? []
      : excerpt.split('\n').map((line) => (line.trim() === '' ? '>' : `> ${line}`))
  if (truncated) lines.push(`> ${QUOTE_TRUNCATION_MARKER(limit)}`)
  return `${lines.join('\n')}\n\n`
}

/**
 * The text a quote action should use: a non-empty selection wins, otherwise the
 * whole-message fallback. Whitespace-only input yields `null` (nothing to
 * quote). Returned text is untrimmed; `quoteBlock` owns outer trimming.
 */
export function quoteTextForSelection(
  selectedText: string | null | undefined,
  fallbackText: string | null | undefined,
): string | null {
  const selected = typeof selectedText === 'string' ? selectedText : ''
  if (selected.trim() !== '') return selected
  const fallback = typeof fallbackText === 'string' ? fallbackText : ''
  if (fallback.trim() !== '') return fallback
  return null
}

/**
 * Append an already-formatted quote to the unsent draft. A non-empty draft is
 * kept verbatim except for trailing whitespace; one blank line separates it
 * from the quote. An empty (or whitespace-only) draft becomes the quote alone.
 * Never returns an empty draft for a non-empty quote.
 */
export function appendQuoteDraft(draft: string, quote: string): string {
  if (typeof quote !== 'string' || quote === '') return draft
  const base = typeof draft === 'string' ? draft.replace(/\s+$/u, '') : ''
  if (base === '') return quote
  return `${base}\n\n${quote}`
}
