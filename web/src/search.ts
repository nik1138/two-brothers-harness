/**
 * Session content search + export helpers (pure, no DOM, no fetch).
 *
 * `CommandPalette.vue` owns the debounced `searchSessions` call and feeds the
 * response through `contentItemsFromResult`, which turns backend hits into
 * palette items for the "Messages" group. `SessionRow.vue` uses
 * `exportDownloadName` for the blob download's filename. Everything here is
 * bounded and deterministic, so the palette stays cheap however large the
 * session corpus grows and the helpers are unit-testable directly.
 */

import { sessionTitle } from './chat'
import type { PaletteItem } from './palette'
import type { SearchHit, SearchResult, SessionExportFormat } from './types'

/** Shortest query the backend accepts (`GET /api/search` 400s below this). */
export const MIN_CONTENT_QUERY = 2
/** Quiet period after the last keystroke before a content search is sent. */
export const SEARCH_DEBOUNCE_MS = 180
/** Hits requested when the caller does not pass a limit. */
export const DEFAULT_SEARCH_LIMIT = 20
/** Upper bound this client will request (the backend clamps 1..100). */
export const MAX_SEARCH_LIMIT = 50
/** Palette id prefix for a content hit; mirrors the session/workspace prefixes. */
export const PALETTE_CONTENT_PREFIX = 'content:'
/** Hits rendered in the palette's Messages group. */
export const MAX_CONTENT_ITEMS = 10
/** Hits shown for one session before that session's remaining hits are dropped. */
export const MAX_CONTENT_HITS_PER_SESSION = 2
/** Query budget in code points; longer input is truncated before it is sent. */
export const MAX_SEARCH_QUERY_CHARS = 200
/** One-line label budgets (title and snippet parts). */
export const MAX_CONTENT_TITLE_CHARS = 60
export const MAX_CONTENT_SNIPPET_CHARS = 80

const ROLE_LABELS: Readonly<Record<string, string>> = {
  senior: 'Senior',
  junior: 'Junior',
  user: 'Operator',
  operator: 'Operator',
}

const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i

/** Strip control characters and collapse whitespace for one-line display. */
function cleanText(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Code-point-safe truncation with a single trailing ellipsis. */
export function truncateText(text: string, max: number): string {
  if (!text || !Number.isFinite(max) || max <= 0) return ''
  const chars = Array.from(text)
  if (chars.length <= max) return text
  if (max === 1) return '…'
  return `${chars.slice(0, max - 1).join('')}…`
}

/** Trim, collapse whitespace and bound the query the backend sees. */
export function normalizeSearchQuery(value: unknown): string {
  return truncateText(cleanText(value), MAX_SEARCH_QUERY_CHARS)
}

/** True when the normalized query is long enough to hit `/api/search`. */
export function shouldSearchContent(query: unknown): boolean {
  return normalizeSearchQuery(query).length >= MIN_CONTENT_QUERY
}

/** Clamp a requested hit limit into `[1, MAX_SEARCH_LIMIT]`, else the default. */
export function clampSearchLimit(limit?: number): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return DEFAULT_SEARCH_LIMIT
  return Math.min(MAX_SEARCH_LIMIT, Math.max(1, Math.floor(limit)))
}

/** Human role label used by the palette hint ("Senior", "Operator", …). */
function roleLabel(role: unknown): string {
  if (typeof role !== 'string' || !role) return ''
  const key = role.toLowerCase()
  const known = ROLE_LABELS[key]
  if (known) return known
  return key.charAt(0).toUpperCase() + key.slice(1)
}

/** Palette hint for a hit: who said it and what it is (`role · kind`). */
function hitHint(hit: SearchHit): string {
  if (hit.field === 'title') return 'Session title'
  const parts = [roleLabel(hit.role), cleanText(hit.kind)].filter(Boolean)
  if (parts.length) return parts.join(' · ')
  return hit.field === 'decision' ? 'Decision' : 'Message'
}

/**
 * A usable session file name from a hit: basename only, no control characters
 * and no `.`/`..`, so a malformed backend payload can never leak a path into a
 * `getSession`/export URL or a download filename.
 */
export function sessionFileNameFromHit(session: unknown): string {
  if (typeof session !== 'string') return ''
  const segment = session.split(/[\\/]/).pop() ?? ''
  const cleaned = segment.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  if (!cleaned || cleaned === '.' || cleaned === '..') return ''
  return cleaned
}

function isUsableHit(hit: unknown): hit is SearchHit {
  return (
    !!hit &&
    typeof hit === 'object' &&
    typeof (hit as SearchHit).session === 'string' &&
    sessionFileNameFromHit((hit as SearchHit).session) !== ''
  )
}

function contentItemFromHit(hit: SearchHit): PaletteItem | null {
  const session = sessionFileNameFromHit(hit.session)
  if (!session) return null

  const title = cleanText(hit.title) || sessionTitle(session)
  const titleText = truncateText(title, MAX_CONTENT_TITLE_CHARS)
  const snippet = truncateText(cleanText(hit.snippet), MAX_CONTENT_SNIPPET_CHARS)
  // Title hits have no message context: their snippet is the title itself.
  const label =
    hit.field === 'title' || !snippet || snippet.toLowerCase() === titleText.toLowerCase()
      ? titleText
      : `${titleText} — ${snippet}`

  const seq =
    typeof hit.seq === 'number' && Number.isFinite(hit.seq) && hit.seq >= 0
      ? Math.floor(hit.seq)
      : null

  return {
    id: `${PALETTE_CONTENT_PREFIX}${session}:${seq !== null ? seq : 'title'}`,
    kind: 'content',
    label,
    hint: hitHint(hit),
    session,
  }
}

export interface ContentItemsOptions {
  /** Hits rendered for one session (default `MAX_CONTENT_HITS_PER_SESSION`). */
  maxPerSession?: number
  /** Overall cap (default `MAX_CONTENT_ITEMS`; 0 renders nothing). */
  limit?: number
}

/**
 * Turn a `/api/search` response into palette items. Backend relevance order is
 * preserved, exact duplicates are dropped, each session contributes at most
 * `maxPerSession` hits, and the whole list is capped. Malformed/partial
 * payloads are tolerated (a missing or broken result is simply empty).
 */
export function contentItemsFromResult(
  result: SearchResult | null | undefined,
  options: ContentItemsOptions = {},
): PaletteItem[] {
  const hits = result && Array.isArray(result.hits) ? result.hits : []
  const perSession =
    typeof options.maxPerSession === 'number' && Number.isFinite(options.maxPerSession)
      ? Math.max(1, Math.floor(options.maxPerSession))
      : MAX_CONTENT_HITS_PER_SESSION
  const max =
    typeof options.limit === 'number' && Number.isFinite(options.limit)
      ? Math.max(0, Math.floor(options.limit))
      : MAX_CONTENT_ITEMS

  const items: PaletteItem[] = []
  const seen = new Set<string>()
  const perSessionCount = new Map<string, number>()

  for (const hit of hits) {
    if (items.length >= max) break
    if (!isUsableHit(hit)) continue
    const session = sessionFileNameFromHit(hit.session)
    const count = perSessionCount.get(session) ?? 0
    if (count >= perSession) continue
    const item = contentItemFromHit(hit)
    if (!item || seen.has(item.id)) continue
    seen.add(item.id)
    perSessionCount.set(session, count + 1)
    items.push(item)
  }

  return items
}

/**
 * The session file name a `content` palette item points at; null for every
 * other item kind (and for malformed items). Uses the explicit `session` field
 * when present and falls back to parsing `content:<session>:<seq|title>`.
 */
export function contentItemSession(item: PaletteItem | null | undefined): string | null {
  if (!item || item.kind !== 'content') return null
  const explicit = sessionFileNameFromHit(item.session)
  if (explicit) return explicit
  if (typeof item.id !== 'string' || !item.id.startsWith(PALETTE_CONTENT_PREFIX)) return null
  const rest = item.id.slice(PALETTE_CONTENT_PREFIX.length)
  const separator = rest.indexOf(':')
  const candidate = separator < 0 ? rest : rest.slice(0, separator)
  return sessionFileNameFromHit(candidate) || null
}

/**
 * Download filename for an exported session: the session stem with the format's
 * extension. Path parts, Windows-illegal characters and trailing dots/spaces
 * are removed so the browser never receives an unsafe `download` value.
 */
export function exportDownloadName(
  session: unknown,
  format: SessionExportFormat | string,
): string {
  const extension = format === 'json' ? 'json' : 'md'
  const name = sessionFileNameFromHit(session)
  const stem = name
    .replace(/\.(jsonl|json)$/i, '')
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[. ]+|[. ]+$/g, '')
    .slice(0, 120)
    .replace(/^[. ]+|[. ]+$/g, '')
  const safe = stem && !WINDOWS_RESERVED_NAME.test(stem) ? stem : 'session'
  return `${safe}.${extension}`
}
