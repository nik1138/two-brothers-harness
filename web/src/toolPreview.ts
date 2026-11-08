/**
 * Tool-result display preview (additive `preview` field).
 *
 * The backend's `compactToolResult` adds one bounded plain-text `preview` for
 * workspace read/list/search results (a file-content head, directory entries,
 * or search match paths). This helper is the web card's only reader: it keeps
 * a hostile or hand-written sidecar row bounded too, and returns null when
 * there is nothing to show so the card stays collapsed exactly as before.
 *
 * The value is rendered as text in a <pre> — never HTML.
 */

/** Mirrors the backend's `CLIP_PREVIEW_CHARS`. */
export const TOOL_PREVIEW_MAX_CHARS = 500

/** The additive preview of one compacted tool result, or null. */
export function toolPreviewOf(result: unknown): string | null {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null
  const raw = (result as Record<string, unknown>).preview
  if (typeof raw !== 'string' || raw.trim() === '') return null
  return raw.length <= TOOL_PREVIEW_MAX_CHARS
    ? raw
    : `${raw.slice(0, TOOL_PREVIEW_MAX_CHARS - 1)}…`
}
