/**
 * Composer mention pickers: trigger detection, filtering/ranking and token
 * serialization for `@` skills/files and `/` commands.
 *
 * Pure and DOM-free (the component reads the caret and passes it in), so the
 * whole interaction model is unit-testable. The tokens match what the server
 * parses from a task: `@skill:<name>`, `@<relative/path>` (forward slashes;
 * root-level files carry a leading `./`, e.g. `@./README.md`, so the core
 * parser recognizes them as file mentions) and `/<name>`, each followed by one
 * space when inserted.
 */

import type { BaseCommandAction, CommandInfo, SkillInfo, WorkspaceFileEntry } from './types'

/** Options rendered for slash commands (the component's Commands group). */
export const MAX_COMMAND_ITEMS = 8
/** Options rendered for skills (shared first, then role-scoped, disabled). */
export const MAX_SKILL_ITEMS = 8
/** Options rendered for workspace files. */
export const MAX_FILE_ITEMS = 12
/** Hits requested from `GET /api/workspaces/{id}/files` when no limit is given. */
export const DEFAULT_FILE_QUERY_LIMIT = 20
/** Upper bound this client requests from the files endpoint. */
export const MAX_FILE_QUERY_LIMIT = 50
/** Quiet period after the last keystroke before the file search is sent. */
export const MENTION_DEBOUNCE_MS = 150
/** Popover footer help line (plain text, no markup). */
export const MENTION_FOOTER_HINT = '↑↓ navigate · Enter insert · Esc close'
/** Footer help line for the `/` command menu (Enter may run an action). */
export const MENTION_FOOTER_HINT_COMMAND = '↑↓ navigate · Enter insert/run · Esc close'
/** Prefix that narrows an `@` mention to the skill picker. */
export const SKILL_MENTION_PREFIX = '@skill:'

export type MentionKind = 'skill' | 'file' | 'command'

/** Active `@`/`/` token at the caret, or null when no picker should open. */
export interface MentionTrigger {
  kind: MentionKind
  /** Index of the trigger character (`@` or `/`) in the text. */
  start: number
  /** Text typed after the trigger (after `@skill:` for skills); may be ''. */
  query: string
}

/** One selectable row of the composer picker. */
export interface MentionItem {
  /** Stable, kind-namespaced id (`skill:name`, `file:path`, `command:name`). */
  id: string
  kind: MentionKind
  /** Primary display text (commands show their `/`). */
  label: string
  /** Secondary display text (scope/description/dirname); may be ''. */
  hint: string
  /** Insertable token without the trailing space; '' when not insertable. */
  token: string
  /** Listed for context but not insertable (role-scoped skills). */
  disabled: boolean
  /** `/` command rows only: first-party action the shell performs locally. */
  action?: BaseCommandAction
  /** `/` command rows only: true for a first-party (base) command. */
  base?: boolean
  /** `/` command rows only: every typed spelling that resolves to this row. */
  aliases?: string[]
  /** `/` command rows only: empty arguments are a usage error. */
  requiresArguments?: boolean
}

/** Score tiers: exact > prefix > word start > substring. */
const SCORE_EXACT = 100
const SCORE_PREFIX = 80
const SCORE_WORD_START = 70
const SCORE_SUBSTRING = 50

function asList<T>(items: readonly T[] | null | undefined): readonly T[] {
  return Array.isArray(items) ? items : []
}

function normalizeQuery(query: unknown): string {
  return typeof query === 'string' ? query.trim().toLowerCase() : ''
}

/** Clamp an explicit item limit; a missing/invalid limit uses `fallback`. */
function clampLimit(limit: unknown, fallback: number): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return fallback
  return Math.max(0, Math.floor(limit))
}

function isValidName(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== ''
}

/** Clamp the file-search limit requested from the backend into 1..MAX. */
export function clampFileQueryLimit(limit?: number): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return DEFAULT_FILE_QUERY_LIMIT
  return Math.min(MAX_FILE_QUERY_LIMIT, Math.max(1, Math.floor(limit)))
}

/** Case-insensitive name ranking used by commands and skills. */
function scoreName(name: string, query: string): number {
  const value = name.toLowerCase()
  if (!value) return 0
  if (value === query) return SCORE_EXACT
  if (value.startsWith(query)) return SCORE_PREFIX
  const index = value.indexOf(query)
  if (index > 0) {
    // "pr-review" / "review_tool": a hit after a word separator ranks higher
    return /[-_ ]/.test(value[index - 1] ?? '') ? SCORE_WORD_START : SCORE_SUBSTRING
  }
  return 0
}

/**
 * File ranking: basename relevance first (exact > prefix > substring), then a
 * relative-path prefix, then a directory name that starts with the query.
 */
function scoreFile(pathValue: string, query: string): number {
  const value = pathValue.replace(/\\/g, '/').toLowerCase()
  if (!value) return 0
  const slash = value.lastIndexOf('/')
  const base = slash < 0 ? value : value.slice(slash + 1)
  if (base === query) return SCORE_EXACT
  if (base.startsWith(query)) return 90
  if (value.startsWith(query)) return 80
  if (base.includes(query)) return 60
  if (value.includes(query)) {
    const segments = value.split('/')
    if (segments.slice(0, -1).some((segment) => segment.startsWith(query))) return 55
    return 40
  }
  return 0
}

/**
 * Shared ranking pass: blank query keeps the input order and is capped; a real
 * query filters non-matches and sorts by score desc, input order for ties (so
 * ranking is deterministic and stable).
 */
function rankItems<T>(
  items: readonly T[] | null | undefined,
  query: unknown,
  limit: number | undefined,
  fallbackLimit: number,
  isValid: (item: T) => boolean,
  scoreOf: (item: T, normalizedQuery: string) => number,
): T[] {
  const max = clampLimit(limit, fallbackLimit)
  const out: T[] = []
  if (max === 0) return out
  const list = asList(items)
  const normalized = normalizeQuery(query)

  if (!normalized) {
    for (const item of list) {
      if (!isValid(item)) continue
      out.push(item)
      if (out.length >= max) break
    }
    return out
  }

  const scored: Array<{ item: T; score: number; index: number }> = []
  for (let index = 0; index < list.length; index += 1) {
    const item = list[index] as T
    if (!isValid(item)) continue
    const score = scoreOf(item, normalized)
    if (score > 0) scored.push({ item, score, index })
  }
  scored.sort((a, b) => b.score - a.score || a.index - b.index)
  for (const entry of scored) {
    out.push(entry.item)
    if (out.length >= max) break
  }
  return out
}

/** Rank slash commands by name (case-insensitive prefix/substring). */
export function filterCommandItems<T extends { name: string }>(
  commands: readonly T[] | null | undefined,
  query: unknown,
  limit: number = MAX_COMMAND_ITEMS,
): T[] {
  return rankItems(
    commands,
    query,
    limit,
    MAX_COMMAND_ITEMS,
    (command) =>
      !!command && typeof command === 'object' && isValidName((command as { name?: unknown }).name),
    (command, normalized) => scoreName(command.name, normalized),
  )
}

/** Rank skills by name (case-insensitive prefix/substring). */
export function filterSkillItems<T extends { name: string }>(
  skills: readonly T[] | null | undefined,
  query: unknown,
  limit: number = MAX_SKILL_ITEMS,
): T[] {
  return rankItems(
    skills,
    query,
    limit,
    MAX_SKILL_ITEMS,
    (skill) =>
      !!skill && typeof skill === 'object' && isValidName((skill as { name?: unknown }).name),
    (skill, normalized) => scoreName(skill.name, normalized),
  )
}

/** Rank workspace files by basename/path relevance (case-insensitive). */
export function filterFileItems<T extends { path: string }>(
  files: readonly T[] | null | undefined,
  query: unknown,
  limit: number = MAX_FILE_ITEMS,
): T[] {
  return rankItems(
    files,
    query,
    limit,
    MAX_FILE_ITEMS,
    (file) =>
      !!file && typeof file === 'object' && isValidName((file as { path?: unknown }).path),
    (file, normalized) => scoreFile(file.path, normalized),
  )
}

// -- trigger detection --------------------------------------------------------

const SKILL_PREFIX_RE = /^@skill:/i
const WHITESPACE_RE = /\s/
const LINE_PREFIX_RE = /^\s*$/

/**
 * Find the mention token the caret is inside, if any.
 *
 * - `@` must begin a token (`start === 0` or the previous character whitespace);
 *   an `@skill:` prefix selects the skill picker, any other `@token` selects the
 *   file picker. Word-internal `@` (emails) and `@` followed by whitespace never
 *   match.
 * - `/` opens the command picker only when the text before it on its line is
 *   whitespace-only, so paths like `src/http` never trigger.
 *
 * A token ends at whitespace, so completing an insert (which appends a space)
 * closes the picker naturally.
 */
export function detectMentionTrigger(text: unknown, caret: unknown): MentionTrigger | null {
  if (typeof text !== 'string' || text.length === 0) return null
  if (typeof caret !== 'number' || !Number.isFinite(caret)) return null
  const position = Math.min(Math.max(Math.trunc(caret), 0), text.length)
  if (position <= 0) return null

  // the token starts after the previous whitespace character
  let start = position
  while (start > 0 && !WHITESPACE_RE.test(text[start - 1] ?? '')) start -= 1
  if (start >= position) return null
  const token = text.slice(start, position)

  if (token.startsWith('@')) {
    if (SKILL_PREFIX_RE.test(token)) {
      return { kind: 'skill', start, query: token.slice(SKILL_MENTION_PREFIX.length) }
    }
    return { kind: 'file', start, query: token.slice(1) }
  }

  if (token.startsWith('/')) {
    const lineStart = text.lastIndexOf('\n', start - 1) + 1
    if (!LINE_PREFIX_RE.test(text.slice(lineStart, start))) return null
    return { kind: 'command', start, query: token.slice(1) }
  }

  return null
}

// -- insertion & token serialization ------------------------------------------

/** Normalize a workspace-relative path for a file mention token. */
function normalizeRelativePath(value: string): string {
  return value
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/{2,}/g, '/')
    .replace(/^\/+/, '')
}

/**
 * Serialize one selected value into the token the server understands:
 * `/<name>`, `@skill:<name>` or `@<relative/path>`. Root-level file paths get a
 * leading `./` (`@./README.md`) because the core parser only recognizes `@`
 * tokens that contain a path separator as file mentions. The trailing space is
 * added by `insertMention`. Blank or malformed values return ''.
 */
export function mentionTokenFor(kind: unknown, value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) return ''
  if (kind === 'command') {
    const name = raw.replace(/^\/+/, '')
    return name ? `/${name}` : ''
  }
  if (kind === 'skill') {
    const name = raw.replace(/^@+/, '').replace(/^skill:/i, '').trim()
    return name ? `${SKILL_MENTION_PREFIX}${name}` : ''
  }
  if (kind === 'file') {
    const relative = normalizeRelativePath(raw)
    if (!relative) return ''
    // Root-level files need the explicit `./`; the core parser treats a bare
    // `@README.md` as plain text, not a file mention.
    const path = relative.includes('/') ? relative : `./${relative}`
    return `@${path}`
  }
  return ''
}

/**
 * Replace the active mention token (`trigger.start`..`caret`) with `token` plus
 * one trailing space. Returns the resulting text and caret; never mutates the
 * input. Malformed arguments are tolerated (the caret is clamped).
 */
export function insertMention(
  text: unknown,
  caret: unknown,
  trigger: MentionTrigger | null | undefined,
  token: unknown,
): { text: string; caret: number } {
  const source = typeof text === 'string' ? text : ''
  const fallbackCaret =
    typeof caret === 'number' && Number.isFinite(caret)
      ? Math.min(Math.max(Math.trunc(caret), 0), source.length)
      : source.length
  const value = typeof token === 'string' ? token.trim() : ''
  if (!trigger || !value) return { text: source, caret: fallbackCaret }

  const start =
    typeof trigger.start === 'number' && Number.isFinite(trigger.start)
      ? Math.min(Math.max(Math.trunc(trigger.start), 0), fallbackCaret)
      : fallbackCaret
  const inserted = `${value} `
  return {
    text: `${source.slice(0, start)}${inserted}${source.slice(fallbackCaret)}`,
    caret: start + inserted.length,
  }
}

// -- display helpers ----------------------------------------------------------

function cleanHint(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
}

/** Primary row text from raw backend metadata (`/name`, skill name, file path). */
export function itemLabel(
  kind: MentionKind,
  item: { name?: unknown; path?: unknown } | null | undefined,
): string {
  if (!item || typeof item !== 'object') return ''
  if (kind === 'file') {
    const path = typeof item.path === 'string' ? item.path.trim() : ''
    return path
  }
  const name = typeof item.name === 'string' ? item.name.trim() : ''
  if (!name) return ''
  return kind === 'command' ? `/${name}` : name
}

/** Secondary row text: argument hint/description, scope+description, dirname. */
export function itemHint(kind: MentionKind, item: unknown): string {
  if (!item || typeof item !== 'object') return ''
  const record = item as Record<string, unknown>
  if (kind === 'command') {
    const argumentHint = cleanHint(record.argumentHint)
    if (argumentHint) return argumentHint
    return cleanHint(record.description)
  }
  if (kind === 'skill') {
    const scope = record.scope
    const scopeText =
      scope === 'shared'
        ? 'shared'
        : scope === 'senior'
          ? 'senior-only'
          : scope === 'junior'
            ? 'junior-only'
            : 'unknown scope'
    const description = cleanHint(record.description)
    return description ? `${scopeText} · ${description}` : scopeText
  }
  const path = typeof record.path === 'string' ? record.path.replace(/\\/g, '/') : ''
  const slash = path.lastIndexOf('/')
  if (slash < 0) return path ? 'workspace root' : ''
  return path.slice(0, slash) || 'workspace root'
}

/** Short instruction for a picker kind (used as the listbox description). */
export function mentionPickerHint(kind: unknown): string {
  switch (kind) {
    case 'skill':
      return 'Type to filter shared skills'
    case 'file':
      return 'Type to filter workspace files'
    case 'command':
      return 'Type to filter slash commands'
    default:
      return 'Type to filter mentions'
  }
}

/**
 * Palette-style `MentionItem[]` for commands: `/name` labels, the argument hint
 * (or description) as the hint, and the insertable `/name` token.
 */
export function commandMentionItems(
  commands: readonly CommandInfo[] | null | undefined,
  query?: unknown,
): MentionItem[] {
  const seen = new Set<string>()
  const items: MentionItem[] = []
  for (const command of filterCommandItems(commands, query)) {
    const name = typeof command.name === 'string' ? command.name.trim() : ''
    const token = mentionTokenFor('command', name)
    if (!name || !token || seen.has(name)) continue
    seen.add(name)
    items.push({
      id: `command:${name}`,
      kind: 'command',
      label: itemLabel('command', command),
      hint: itemHint('command', command),
      token,
      disabled: false,
    })
  }
  return items
}

/**
 * `MentionItem[]` for skills. Shared skills (insertable) rank first; role-scoped
 * skills stay visible with their scope but are disabled — the server only
 * accepts shared operator mentions, so they are model-invoked instead.
 */
export function skillMentionItems(
  skills: readonly SkillInfo[] | null | undefined,
  query?: unknown,
): MentionItem[] {
  const seen = new Set<string>()
  const shared: MentionItem[] = []
  const scoped: MentionItem[] = []
  for (const skill of filterSkillItems(skills, query, Number.MAX_SAFE_INTEGER)) {
    const name = typeof skill.name === 'string' ? skill.name.trim() : ''
    if (!name || seen.has(name)) continue
    seen.add(name)
    const isShared = skill.scope === 'shared'
    const item: MentionItem = {
      id: `skill:${name}`,
      kind: 'skill',
      label: itemLabel('skill', skill),
      hint: itemHint('skill', skill),
      token: isShared ? mentionTokenFor('skill', name) : '',
      disabled: !isShared,
    }
    if (isShared) shared.push(item)
    else scoped.push(item)
  }
  return [...shared, ...scoped].slice(0, MAX_SKILL_ITEMS)
}

/**
 * `MentionItem[]` for workspace files: basename label, dirname hint, and the
 * `@relative/path` token (forward slashes; root-level files become
 * `@./name`).
 */
export function fileMentionItems(
  files: readonly WorkspaceFileEntry[] | null | undefined,
  query?: unknown,
): MentionItem[] {
  const seen = new Set<string>()
  const items: MentionItem[] = []
  for (const file of filterFileItems(files, query)) {
    const path = typeof file.path === 'string' ? file.path.replace(/\\/g, '/').trim() : ''
    const token = mentionTokenFor('file', path)
    if (!path || !token || seen.has(path)) continue
    seen.add(path)
    const slash = path.lastIndexOf('/')
    items.push({
      id: `file:${path}`,
      kind: 'file',
      label: slash < 0 ? path : path.slice(slash + 1),
      hint: itemHint('file', file),
      token,
      disabled: false,
    })
  }
  return items
}
