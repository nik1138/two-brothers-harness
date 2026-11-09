/**
 * Composer status seats (pure): the compact second row inside the composer that
 * states what the next run will use, built only from data the app already holds.
 *
 * Truthfulness rules:
 * - every seat disappears when its data is unknown (role settings not loaded, no
 *   workspace context, no prompt audit yet) — the row never guesses;
 * - the context seat reports the latest prompt audit's character counts and
 *   offered-tool count exactly as recorded. No tokenizer is invented from char
 *   counts, and no context-window number is shown: the web client does not
 *   receive one, so a token seat would be fabricated;
 * - the permission seat describes the product's real approval model for the
 *   linked workspace: the effective approval mode (`ask`/`readonly`/`edits`/
 *   `allow-all`) from settings, or the fail-closed `ask` default when an older
 *   backend omits the additive `approval_policy` section; a run without a
 *   linked workspace has no privileged workspace tools to approve.
 *
 * No DOM or Vue dependency: the derivation is unit-tested directly.
 */

import type { ApprovalMode } from './types'

/** The fields of `PromptAuditItem` the seats read (no prompt bodies exist). */
export interface AuditSeatInput {
  role: 'senior' | 'junior'
  kind: string
  tools: readonly string[]
  systemChars: number
  userChars: number
}

export interface ComposerStatusInput {
  /** Role settings are loaded; false/undefined ⇒ the models seat is hidden. */
  settingsReady?: boolean
  /** Display label per role, already humanized by the caller (`modelLabel`). */
  seniorLabel?: string | null
  juniorLabel?: string | null
  /**
   * Composer workspace context: `true` = linked, `false` = none,
   * `null`/`undefined` = unknown (seat hidden).
   */
  workspaceLinked?: boolean | null
  /**
   * Latest prompt audit of the selected session / followed run, when any.
   */
  latestAudit?: AuditSeatInput | null
  /**
   * Effective workspace approval mode from settings (`approval_policy`), when
   * known. `null`/`undefined` on an older backend that omits the section: the
   * seat keeps the fail-closed default copy, which is what that backend applies.
   */
  approvalMode?: ApprovalMode | null
}

export type ComposerSeatId = 'models' | 'permissions' | 'context'

/** One rendered seat: short visible value plus the full truthful description. */
export interface ComposerSeat {
  id: ComposerSeatId
  label: string
  value: string
  /** Tooltip/aria description with the unabbreviated facts. */
  title: string
}

/** Thousands separator for the exact counts inside a seat's description. */
function exactCount(value: number): string {
  return Math.max(0, Math.floor(value)).toLocaleString('en-US')
}

/** Finite, non-negative number or 0 for anything a backend may omit. */
function safeChars(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0
}

function safeLabel(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function trimTrailingZero(value: number): string {
  const fixed = value.toFixed(1)
  return fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed
}

/**
 * Compact, honest char count: exact below 1 000, one decimal in the low
 * thousands, whole thousands up to a million, one decimal millions.
 */
export function formatCharCount(chars: number): string {
  if (typeof chars !== 'number' || !Number.isFinite(chars) || chars <= 0) return '0'
  const n = Math.floor(chars)
  if (n < 1_000) return String(n)
  if (n < 10_000) return `${trimTrailingZero(n / 1_000)}k`
  // Rounding must never print "1000k": values that would round up switch unit.
  if (n < 999_500) return `${Math.round(n / 1_000)}k`
  return `${trimTrailingZero(n / 1_000_000)}M`
}

function modelsSeat(input: ComposerStatusInput): ComposerSeat | null {
  if (input.settingsReady !== true) return null
  const senior = safeLabel(input.seniorLabel) ?? 'not set'
  const junior = safeLabel(input.juniorLabel) ?? 'not set'
  return {
    id: 'models',
    label: 'Models',
    value: `S ${senior} · J ${junior}`,
    title: `Senior model: ${senior}. Junior model: ${junior}. Change these in Settings → Models & roles.`,
  }
}

function permissionsSeat(input: ComposerStatusInput): ComposerSeat | null {
  if (input.workspaceLinked === true) {
    // The seat names the effective mode honestly; `ask` is also the fail-closed
    // fallback an older backend (no additive approval_policy section) applies.
    if (input.approvalMode === 'readonly') {
      return {
        id: 'permissions',
        label: 'Permissions',
        value: 'Read only',
        title:
          'Permission preset "Read only": writes, edits, deletes and shell commands are denied without asking. Change it in Settings → Permissions.',
      }
    }
    if (input.approvalMode === 'edits') {
      return {
        id: 'permissions',
        label: 'Permissions',
        value: 'Workspace write',
        title:
          'Permission preset "Workspace write": writes and edits run without asking; deletes and shell commands pause the run and ask here. Change it in Settings → Permissions.',
      }
    }
    if (input.approvalMode === 'allow-all') {
      return {
        id: 'permissions',
        label: 'Permissions',
        value: 'Full access',
        title:
          'Permission preset "Full access": every action runs without asking, including deletes and shell commands. Change it in Settings → Permissions.',
      }
    }
    return {
      id: 'permissions',
      label: 'Permissions',
      value: 'Always ask',
      title:
        'Permission preset "Always ask": reads run freely; writes, edits, deletes and shell commands pause the run and ask here. Change it in Settings → Permissions.',
    }
  }
  if (input.workspaceLinked === false) {
    return {
      id: 'permissions',
      label: 'Permissions',
      value: 'No workspace',
      title:
        'No workspace is linked, so this run has no file or shell tools that could need approval.',
    }
  }
  return null
}

function contextSeat(input: ComposerStatusInput): ComposerSeat | null {
  const audit = input.latestAudit
  if (!audit || typeof audit !== 'object') return null
  const system = safeChars(audit.systemChars)
  const context = safeChars(audit.userChars)
  const tools = Array.isArray(audit.tools) ? audit.tools.length : 0
  const role =
    audit.role === 'senior' ? 'Senior' : audit.role === 'junior' ? 'Junior' : null
  const kind = safeLabel(audit.kind)
  const who = role === null ? '' : role + (kind ? ` · ${kind}` : '')
  return {
    id: 'context',
    label: 'Context',
    value: `${formatCharCount(system)} system · ${formatCharCount(context)} context · ${tools} ${
      tools === 1 ? 'tool' : 'tools'
    }`,
    title: `Latest prompt audit${
      who ? ` (${who})` : ''
    }: ${exactCount(system)} system-prompt characters, ${exactCount(
      context,
    )} context characters, ${tools} tools offered.`,
  }
}

/**
 * Derive the visible seats in display order (models → permissions → context).
 * A seat with no data is simply absent, so the row collapses instead of showing
 * placeholders.
 */
export function composerSeats(input: ComposerStatusInput | null | undefined): ComposerSeat[] {
  if (!input || typeof input !== 'object') return []
  const seats: ComposerSeat[] = []
  const models = modelsSeat(input)
  if (models) seats.push(models)
  const permissions = permissionsSeat(input)
  if (permissions) seats.push(permissions)
  const context = contextSeat(input)
  if (context) seats.push(context)
  return seats
}
