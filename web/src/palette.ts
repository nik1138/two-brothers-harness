/**
 * Command palette model (P1): pure item building, scoring and filtering.
 *
 * No DOM and no dependencies. `App.vue` builds the item list once from its
 * current sessions/workspaces plus the static action list; `CommandPalette.vue`
 * re-filters it per keystroke. Everything here is bounded: queries and match
 * fields are truncated, subsequence matching is linear, and `filterPalette`
 * caps its output, so typing stays cheap however long the session list grows.
 */

export interface PaletteItem {
  id: string
  /**
   * `content` items are remote session-message hits from `search.ts`; they are
   * appended by `CommandPalette.vue` instead of `buildPaletteItems` so the
   * static/owner-built list stays synchronous.
   */
  kind: 'session' | 'workspace' | 'action' | 'content'
  label: string
  hint?: string
  keywords?: string[]
  /** Session file name for `kind: 'content'` hits (`search.ts` fills it). */
  session?: string
}

/** Item id prefixes, so the owner can recover the session name / workspace id. */
export const PALETTE_SESSION_PREFIX = 'session:'
export const PALETTE_WORKSPACE_PREFIX = 'workspace:'

export interface PaletteBuildInput {
  sessions: { name: string; title?: string; workspace_id?: string }[]
  workspaces: { id: string; name: string }[]
  actions: PaletteItem[]
}

/** Upper bound on how much of a query or field is matched (grapheme-safe enough
 * for search: truncation can only lose matches at absurd lengths). */
const MAX_QUERY_CHARS = 128
const MAX_FIELD_CHARS = 200

/** Score tiers: label hits dominate, keyword hits are scaled, hints are weakest. */
const SCORE_EXACT = 1000
const SCORE_PREFIX = 800
const SCORE_WORD_START = 650
const SCORE_SUBSTRING = 560
const KEYWORD_WEIGHT = 0.65
const HINT_WEIGHT = 0.4

/**
 * Build the palette's base list: sessions (in the backend's order), then
 * workspaces, then the caller's actions. Labels fall back from title to name;
 * the workspace name becomes the session's hint (and an extra keyword).
 */
export function buildPaletteItems(input: PaletteBuildInput): PaletteItem[] {
  const sessions = Array.isArray(input?.sessions) ? input.sessions : []
  const workspaces = Array.isArray(input?.workspaces) ? input.workspaces : []
  const actions = Array.isArray(input?.actions) ? input.actions : []

  const workspaceNames = new Map<string, string>()
  for (const workspace of workspaces) {
    if (!workspace || typeof workspace.id !== 'string' || !workspace.id) continue
    const name = typeof workspace.name === 'string' ? workspace.name.trim() : ''
    workspaceNames.set(workspace.id, name || workspace.id)
  }

  const items: PaletteItem[] = []

  for (const session of sessions) {
    if (!session || typeof session.name !== 'string' || !session.name) continue
    const title = typeof session.title === 'string' ? session.title.trim() : ''
    const workspaceName =
      typeof session.workspace_id === 'string'
        ? workspaceNames.get(session.workspace_id)
        : undefined
    const keywords = [session.name]
    if (workspaceName) keywords.push(workspaceName)
    items.push({
      id: `${PALETTE_SESSION_PREFIX}${session.name}`,
      kind: 'session',
      label: title || session.name,
      hint: workspaceName,
      keywords,
    })
  }

  for (const workspace of workspaces) {
    if (!workspace || typeof workspace.id !== 'string' || !workspace.id) continue
    const name = typeof workspace.name === 'string' ? workspace.name.trim() : ''
    items.push({
      id: `${PALETTE_WORKSPACE_PREFIX}${workspace.id}`,
      kind: 'workspace',
      label: name || workspace.id,
      hint: 'Filter sessions',
      keywords: [workspace.id, 'workspace'],
    })
  }

  for (const action of actions) {
    if (!action || typeof action.id !== 'string' || !action.id) continue
    items.push({
      ...action,
      kind: 'action',
      keywords: Array.isArray(action.keywords) ? [...action.keywords] : undefined,
    })
  }

  return items
}

/** Lowercase, strip diacritics, collapse whitespace, and truncate. */
function normalizeText(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_FIELD_CHARS)
}

function normalizeQuery(query: unknown): string {
  return normalizeText(query).slice(0, MAX_QUERY_CHARS)
}

function isWordStart(text: string, index: number): boolean {
  if (index <= 0) return true
  return !/[a-z0-9]/.test(text[index - 1] ?? '')
}

/** Cheap, linear subsequence score (always below the substring tier). */
function subsequenceScore(text: string, query: string): number {
  let matched = 0
  let first = -1
  let last = -1
  for (let i = 0; i < text.length && matched < query.length; i += 1) {
    if (text[i] === query[matched]) {
      if (first < 0) first = i
      last = i
      matched += 1
    }
  }
  if (matched < query.length) return 0
  const span = Math.max(last - first + 1, query.length)
  const compactness = query.length / span
  const coverage = query.length / text.length
  const boundaryBonus = isWordStart(text, first) ? 20 : 0
  return Math.round(80 + 120 * compactness + 60 * coverage + boundaryBonus)
}

/** Score one word against one field: exact > prefix > word start > substring > subsequence. */
function wordScore(text: string, word: string): number {
  if (!text || !word) return 0
  if (text === word) return SCORE_EXACT
  if (text.startsWith(word)) return SCORE_PREFIX
  const index = text.indexOf(word)
  if (index > 0) return isWordStart(text, index) ? SCORE_WORD_START : SCORE_SUBSTRING
  return subsequenceScore(text, word)
}

/** Score a whole query against one field; multi-word queries require every word. */
function fieldScore(text: string, query: string): number {
  if (!text || !query) return 0
  if (text === query) return SCORE_EXACT
  if (text.startsWith(query)) return SCORE_PREFIX
  const index = text.indexOf(query)
  if (index > 0) return isWordStart(text, index) ? SCORE_WORD_START : SCORE_SUBSTRING
  if (query.includes(' ')) {
    const words = query.split(' ')
    let total = 0
    for (const word of words) {
      const score = wordScore(text, word)
      if (score <= 0) return 0
      total += score
    }
    // an unordered/all-words match ranks just below the contiguous phrase
    return Math.round((total / words.length) * 0.9)
  }
  return subsequenceScore(text, query)
}

/**
 * Relevance of one item for a query: case-insensitive prefix/substring hits
 * over label, keywords and hint, falling through to subsequence matching.
 * An empty query matches everything with the base score (filter keeps order).
 */
export function scoreItem(item: PaletteItem, query: string): number {
  if (!item || typeof item.label !== 'string') return 0
  const q = normalizeQuery(query)
  if (!q) return 1

  let best = fieldScore(normalizeText(item.label), q)

  if (Array.isArray(item.keywords)) {
    for (const keyword of item.keywords) {
      const score = Math.round(fieldScore(normalizeText(keyword), q) * KEYWORD_WEIGHT)
      if (score > best) best = score
    }
  }

  if (typeof item.hint === 'string') {
    const score = Math.round(fieldScore(normalizeText(item.hint), q) * HINT_WEIGHT)
    if (score > best) best = score
  }

  return best
}

function isUsable(item: unknown): item is PaletteItem {
  return (
    !!item &&
    typeof item === 'object' &&
    typeof (item as PaletteItem).id === 'string' &&
    typeof (item as PaletteItem).label === 'string'
  )
}

/** Deterministic, locale-independent label ordering (lowercase first, then exact). */
function compareLabels(a: PaletteItem, b: PaletteItem): number {
  const left = normalizeText(a.label)
  const right = normalizeText(b.label)
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

/**
 * Filter and rank items. An empty query keeps the base order untouched (stable,
 * deduped); otherwise matches are sorted by score desc then label, deduped by
 * id (keeping the best-scoring copy), and capped at `limit` (default 50).
 */
export function filterPalette(
  items: PaletteItem[],
  query: string,
  limit = 50,
): PaletteItem[] {
  const max = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 50
  if (!Array.isArray(items) || max === 0) return []

  const seen = new Set<string>()
  const out: PaletteItem[] = []

  if (!normalizeQuery(query)) {
    for (const item of items) {
      if (!isUsable(item) || seen.has(item.id)) continue
      seen.add(item.id)
      out.push(item)
      if (out.length >= max) break
    }
    return out
  }

  const scored: { item: PaletteItem; score: number }[] = []
  for (const item of items) {
    if (!isUsable(item)) continue
    const score = scoreItem(item, query)
    if (score > 0) scored.push({ item, score })
  }
  scored.sort((a, b) => b.score - a.score || compareLabels(a.item, b.item))

  for (const entry of scored) {
    if (seen.has(entry.item.id)) continue
    seen.add(entry.item.id)
    out.push(entry.item)
    if (out.length >= max) break
  }
  return out
}
