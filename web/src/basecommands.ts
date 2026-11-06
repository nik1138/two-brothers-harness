/**
 * First-party ("base") slash commands in the web composer.
 *
 * `GET /api/commands` additively returns `baseCommands` next to the discovered
 * `<name>.md` templates. Base commands come in two kinds: `prompt` commands are
 * inserted (`/plan `) and expanded by the server on submit, while `action`
 * commands are performed locally by the shell (`/compact`, `/export`, `/help`,…)
 * and must never be submitted as a run.
 *
 * This module is pure and DOM-free: it normalizes/sorts/merges the catalogue,
 * builds the picker sections (Built-in first by priority, then discovered
 * alphabetically, discovered names shadow base ones), searches names/aliases/
 * descriptions, and resolves a typed `/name args` line. App.vue performs the
 * actions; Composer.vue renders the rows. Everything is deterministic and
 * unit-tested.
 */

import type { RunMode } from './types'
import type {
  BaseCommand,
  BaseCommandAction,
  BaseCommandKind,
  CommandInfo,
} from './types'
import { commandMentionItems, MAX_COMMAND_ITEMS } from './mentions'
import type { MentionItem } from './mentions'

/** Group label for the first-party catalogue. */
export const BASE_COMMAND_GROUP_LABEL = 'Built-in'
/** Group label for discovered `<name>.md` templates. */
export const DISCOVERED_COMMAND_GROUP_LABEL = 'Commands'

/** Every action a web surface can perform. */
export const BASE_COMMAND_ACTIONS: readonly BaseCommandAction[] = [
  'compact',
  'export',
  'permission',
  'help',
  'status',
  'mode',
  'new',
]

const ACTION_SET: ReadonlySet<string> = new Set(BASE_COMMAND_ACTIONS)

/** True when `value` is an action this surface understands. */
export function isBaseCommandAction(value: unknown): value is BaseCommandAction {
  return typeof value === 'string' && ACTION_SET.has(value)
}

/** One picker section: a label plus its flat rows. */
export interface CommandPickerSection {
  id: 'base' | 'discovered'
  label: string
  items: MentionItem[]
}

/** A `/name args` line typed directly into the composer. */
export interface SubmittedCommand {
  /** Command spelling without the leading slash, e.g. `plan`. */
  token: string
  /** Everything after the command name, untrimmed. */
  args: string
}

/** Resolution of one typed command spelling. */
export type TypedCommandResolution =
  | { kind: 'base-action'; command: BaseCommand }
  | { kind: 'base-prompt'; command: BaseCommand }
  | { kind: 'discovered'; command: CommandInfo }
  | { kind: 'unknown' }

/** Payload sent to the shell when a base action is chosen/typed. */
export interface ComposerCommandRequest {
  action: BaseCommandAction
  /** Canonical name (no leading slash). */
  name: string
  /** Arguments typed after the command; may be ''. */
  args: string
  requiresArguments: boolean
  /** Catalogs at dispatch time (the shell uses them for the help overlay). */
  baseCommands: BaseCommand[]
  commands: CommandInfo[]
  /** Cooperation mode selected in the composer for the next run. */
  mode: RunMode
}

function asArray<T>(value: readonly T[] | null | undefined): readonly T[] {
  return Array.isArray(value) ? value : []
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function compareNames(a: { name: string }, b: { name: string }): number {
  const left = a.name.toLowerCase()
  const right = b.name.toLowerCase()
  return left < right ? -1 : left > right ? 1 : 0
}

function normalizeKind(value: unknown): BaseCommandKind | null {
  return value === 'prompt' || value === 'action' ? value : null
}

/**
 * Tolerant normalization of the additive `baseCommands` payload: drops
 * malformed entries, dedupes by name (first wins), copies arrays and sorts by
 * priority (higher first) then name — the same order every surface renders.
 * Unknown action values keep the command (kind `action`) with `action`
 * undefined, so a dispatch can report it honestly instead of inventing a run.
 */
export function normalizeBaseCommands(raw: unknown): BaseCommand[] {
  const out: BaseCommand[] = []
  const seen = new Set<string>()
  for (const entry of asArray(raw as readonly unknown[])) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const name = text(record.name).replace(/^\/+/, '')
    const kind = normalizeKind(record.kind)
    if (!name || !kind || seen.has(name.toLowerCase())) continue
    seen.add(name.toLowerCase())
    const aliases: string[] = []
    const aliasSeen = new Set<string>([name.toLowerCase()])
    for (const alias of asArray(record.aliases as readonly unknown[])) {
      const value = text(alias)
      if (!value || aliasSeen.has(value.toLowerCase())) continue
      aliasSeen.add(value.toLowerCase())
      aliases.push(value)
    }
    const priority =
      typeof record.priority === 'number' && Number.isFinite(record.priority)
        ? record.priority
        : 0
    out.push({
      name,
      aliases,
      description: text(record.description),
      argumentHint: text(record.argumentHint),
      kind,
      ...(kind === 'action' && isBaseCommandAction(record.action)
        ? { action: record.action }
        : {}),
      requiresArguments: record.requiresArguments === true,
      priority,
    })
  }
  return out.sort((a, b) => b.priority - a.priority || compareNames(a, b))
}

/** Normalize discovered commands for display (valid names only, alphabetical). */
function normalizeDiscovered(commands: readonly CommandInfo[] | null | undefined): CommandInfo[] {
  const out: CommandInfo[] = []
  const seen = new Set<string>()
  for (const command of asArray(commands)) {
    if (!command || typeof command !== 'object') continue
    const name = text(command.name).replace(/^\/+/, '')
    if (!name || seen.has(name.toLowerCase())) continue
    seen.add(name.toLowerCase())
    out.push(command)
  }
  return out.sort(compareNames)
}

/** Lowercased haystack for a base command: name + aliases + description + hint. */
function baseHaystack(command: BaseCommand): string {
  return [command.name, ...command.aliases, command.description, command.argumentHint]
    .join(' ')
    .toLowerCase()
}

/** Lowercased haystack for a discovered command (no aliases exist there). */
function discoveredHaystack(command: CommandInfo): string {
  return [command.name, command.description, command.argumentHint].join(' ').toLowerCase()
}

function matchesHaystack(haystack: string, query: string): boolean {
  if (!query) return true
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  return words.every((word) => haystack.includes(word))
}

/** True when a base command matches the picker query (name/aliases/description). */
export function baseCommandMatchesQuery(command: BaseCommand, query: unknown): boolean {
  const value = text(query).replace(/^\//, '')
  return matchesHaystack(baseHaystack(command), value)
}

/** Hint line for a command row: description plus the argument placeholder. */
function commandHint(description: string, argumentHint: string): string {
  const desc = text(description)
  const hint = text(argumentHint)
  if (desc && hint) return `${desc} · ${hint}`
  return desc || hint
}

function baseMentionItems(base: BaseCommand[]): MentionItem[] {
  return base.map((command) => ({
    id: `base:${command.name}`,
    kind: 'command',
    label: `/${command.name}`,
    hint: commandHint(command.description, command.argumentHint),
    // Insertable text for both kinds: prompt commands are submitted, action
    // commands are consumed locally (or inserted when they need arguments).
    token: `/${command.name}`,
    disabled: false,
    base: true,
    aliases: [...command.aliases],
    requiresArguments: command.requiresArguments,
    ...(command.kind === 'action' && command.action !== undefined
      ? { action: command.action }
      : {}),
  }))
}

function discoveredMentionItems(commands: CommandInfo[]): MentionItem[] {
  return commandMentionItems(commands).map((item) => ({
    ...item,
    base: false,
  }))
}

/**
 * Merge the catalogues into the `/` picker sections: "Built-in" first (priority
 * desc, then name) and "Commands" (discovered, alphabetical). A discovered
 * command whose name matches a base command shadows it (the operator's template
 * wins), matching the server's resolution order.
 */
export function mergeCommandSections(
  commands: readonly CommandInfo[] | null | undefined,
  baseCommands: readonly BaseCommand[] | null | undefined,
  query?: unknown,
): CommandPickerSection[] {
  const base = normalizeBaseCommands(baseCommands)
  const discovered = normalizeDiscovered(commands)
  const shadowed = new Set(discovered.map((command) => command.name.toLowerCase()))
  const visibleBase = base.filter(
    (command) => !shadowed.has(command.name.toLowerCase()) && baseCommandMatchesQuery(command, query),
  )
  const queryValue = text(query).replace(/^\//, '')
  const visibleDiscovered = discovered
    .filter((command) => matchesHaystack(discoveredHaystack(command), queryValue))
    .slice(0, MAX_COMMAND_ITEMS)
  return [
    {
      id: 'base',
      label: BASE_COMMAND_GROUP_LABEL,
      items: baseMentionItems(visibleBase),
    },
    {
      id: 'discovered',
      label: DISCOVERED_COMMAND_GROUP_LABEL,
      items: discoveredMentionItems(visibleDiscovered),
    },
  ]
}

/** Total rows the `/` picker would show for a query (both sections). */
export function commandSectionCount(sections: readonly CommandPickerSection[]): number {
  return sections.reduce((sum, section) => sum + section.items.length, 0)
}

/** Find a base command by canonical name or alias (case-insensitive). */
export function findBaseCommand(
  baseCommands: readonly BaseCommand[] | null | undefined,
  token: unknown,
): BaseCommand | null {
  const needle = text(token).replace(/^\/+/, '').toLowerCase()
  if (!needle) return null
  const base = normalizeBaseCommands(baseCommands)
  const exact = base.find((command) => command.name.toLowerCase() === needle)
  if (exact) return exact
  return (
    base.find((command) => command.aliases.some((alias) => alias.toLowerCase() === needle)) ?? null
  )
}

/**
 * Resolve a typed spelling exactly like the server does: an exact discovered
 * command name wins (it shadows a base command), then a base name, then a base
 * alias. Unknown spellings stay verbatim submissions.
 */
export function resolveTypedCommand(
  baseCommands: readonly BaseCommand[] | null | undefined,
  commands: readonly CommandInfo[] | null | undefined,
  token: unknown,
): TypedCommandResolution {
  const needle = text(token).replace(/^\/+/, '').toLowerCase()
  if (!needle) return { kind: 'unknown' }
  const discovered = normalizeDiscovered(commands).find(
    (command) => command.name.toLowerCase() === needle,
  )
  if (discovered) return { kind: 'discovered', command: discovered }
  const base = findBaseCommand(baseCommands, needle)
  if (base) {
    return base.kind === 'action'
      ? { kind: 'base-action', command: base }
      : { kind: 'base-prompt', command: base }
  }
  return { kind: 'unknown' }
}

/**
 * Parse a composer value that is exactly one `/command args` line. Returns null
 * for ordinary tasks (text before the slash, a bare `/`, or no slash).
 */
export function parseSubmittedCommand(value: unknown): SubmittedCommand | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text.startsWith('/')) return null
  const match = /^\/([^\s/][^\s]*)(?:\s+([\s\S]*))?$/.exec(text)
  if (!match) return null
  const token = (match[1] ?? '').trim()
  if (!token) return null
  return { token, args: (match[2] ?? '').trim() }
}

/** Usage line for a base command, e.g. `/plan <objective>`. */
export function commandUsageLine(command: BaseCommand): string {
  const hint = text(command.argumentHint)
  return hint ? `/${command.name} ${hint}` : `/${command.name}`
}
