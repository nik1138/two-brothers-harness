// Per-role usage split projection (feat/usage-surfaces, additive).
//
// The backend attributes every provider call to the acting role
// (`HarnessResult.usageByRole`, the display-only `call_usage` runtime event,
// and the additive `usage_by_role` field on `run_end` / the run record). This
// module is the web's one place for that data: a tolerant normalizer for the
// wire shapes, a pure incremental fold for live `call_usage` events, and the
// render-ready rows the usage footer and the `/status` dialog share.
//
// Fail-soft by design: a missing split (older backend, a provider that tracks
// no usage, a pre-feature session) projects to null — callers then render
// today's merged counters and never a fabricated `0/0` role row. The additive
// per-role cost (`feat/role-cost-surfaces`) is likewise only carried: the
// backend prices it from each half's own model identity and the web renders
// `cost_by_role` when present, adding no segment otherwise. No DOM/Vue
// imports, so the pure tests cover it directly.

import type { RoleRunUsage, RunCost, RunCostByRole, RunEvent, RunUsage, RunUsageByRole } from './types'
import { costLabel, costTitle } from './usageCost'
import { cacheHitPercent, promptTokensOf } from './usageCache'

export type RoleName = 'senior' | 'junior'

const ROLES: readonly RoleName[] = ['senior', 'junior']

/** The role display label used by the footer and the status dialog. */
export const ROLE_LABELS: Record<RoleName, string> = { senior: 'Senior', junior: 'Junior' }

function count(value: unknown): number {
  const number = Number(value)
  return Number.isFinite(number) ? Math.trunc(number) : 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Zero counters for one role (never used as a fabricated role row). */
export function emptyUsage(): RunUsage {
  return {
    model_calls: 0,
    input_tokens: 0,
    output_tokens: 0,
    cached_tokens: 0,
    cache_write_tokens: 0,
  }
}

/** Zero split: both halves present, the backend's own convention. */
export function emptyUsageByRole(): RunUsageByRole {
  return { senior: emptyUsage(), junior: emptyUsage() }
}

/**
 * Tolerant copy of one usage object: missing/malformed counters read 0, and
 * `prompt_tokens`/`cache_write_tokens` stay absent when the payload omits them
 * (OpenAI-compatible runs omit `prompt_tokens`; only Anthropic bills writes).
 */
export function normalizeRunUsage(value: unknown): RunUsage {
  if (!isRecord(value)) return emptyUsage()
  const usage: RunUsage = {
    model_calls: count(value.model_calls),
    input_tokens: count(value.input_tokens),
    output_tokens: count(value.output_tokens),
    cached_tokens: count(value.cached_tokens),
  }
  if (value.cache_write_tokens !== undefined) {
    usage.cache_write_tokens = count(value.cache_write_tokens)
  }
  if (value.prompt_tokens !== undefined) usage.prompt_tokens = count(value.prompt_tokens)
  return usage
}

/**
 * One half of a wire split: the tolerant counters plus the additive model
 * identity when the backend carried one. The identity is copied, never
 * derived — an old record or a mock/untracked run stays identity-free.
 */
function roleRunUsage(value: Record<string, unknown>): RoleRunUsage {
  const usage: RoleRunUsage = normalizeRunUsage(value)
  if (typeof value.model === 'string' && value.model.trim() !== '') usage.model = value.model.trim()
  if (
    value.family === 'openai-compatible' ||
    value.family === 'anthropic' ||
    value.family === 'google'
  ) {
    usage.family = value.family
  }
  return usage
}

/**
 * Tolerant read of a `{senior, junior}` split. Returns null unless at least
 * one half is an object, so an absent (old backend) or malformed value is
 * omitted rather than rendered as a fabricated zero split. A present-but-
 * partial split fills the missing half with zero counters. Each half's additive
 * model identity is carried through when present.
 */
export function normalizeUsageByRole(value: unknown): RunUsageByRole | null {
  if (!isRecord(value)) return null
  const senior = isRecord(value.senior) ? value.senior : null
  const junior = isRecord(value.junior) ? value.junior : null
  if (senior === null && junior === null) return null
  return {
    senior: senior === null ? emptyUsage() : roleRunUsage(senior),
    junior: junior === null ? emptyUsage() : roleRunUsage(junior),
  }
}

function addInto(target: RunUsage, delta: RunUsage): void {
  target.model_calls += delta.model_calls
  target.input_tokens += delta.input_tokens
  target.output_tokens += delta.output_tokens
  target.cached_tokens += delta.cached_tokens
  if (delta.cache_write_tokens !== undefined) {
    target.cache_write_tokens = (target.cache_write_tokens ?? 0) + delta.cache_write_tokens
  }
  if (delta.prompt_tokens !== undefined) {
    target.prompt_tokens = (target.prompt_tokens ?? 0) + delta.prompt_tokens
  }
}

/**
 * Fold one `call_usage` event into a split, pure and incremental (a fresh
 * object each time, matching the projection conventions). An unknown role or
 * malformed usage leaves the current value untouched, so a live stream never
 * gains a fabricated half.
 */
export function addCallUsage(
  current: RunUsageByRole | null,
  role: unknown,
  usage: unknown,
): RunUsageByRole | null {
  if (role !== 'senior' && role !== 'junior') return current
  if (!isRecord(usage)) return current
  const next: RunUsageByRole = current
    ? { senior: { ...current.senior }, junior: { ...current.junior } }
    : emptyUsageByRole()
  addInto(next[role], normalizeRunUsage(usage))
  return next
}

/**
 * Replay a run's `call_usage` frames into a split (the projection entry used
 * by the App's event handler and the tests). Returns null when the stream has
 * none, so an older backend's session stays merged-only.
 */
export function usageByRoleFromEvents(events: readonly RunEvent[]): RunUsageByRole | null {
  let split: RunUsageByRole | null = null
  for (const event of events) {
    if (event.type !== 'call_usage') continue
    split = addCallUsage(split, event.role, event.usage)
  }
  return split
}

/** One measured role's render-ready usage: tokens in/out, cache %, writes. */
export interface RoleUsageView {
  role: RoleName
  label: string
  modelCalls: number
  /** `in 1,200 / out 340 tok` (the footer's existing wording). */
  tokens: string
  /** `cache 42%`, or null when there is no counter to show. */
  cache: string | null
  /** Tooltip text for the cache segment: `cached N of M prompt tokens`. */
  cacheTitle: string | null
  /**
   * `miss 700 tok`, or null when the role recorded no cache read. Derived
   * display, never a wire field: it is the role's prompt total minus its cache
   * reads — the tokens that were not served from the provider cache.
   */
  miss: string | null
  /** `write 60 tok`, or null when the role billed no cache writes. */
  write: string | null
  /**
   * `~$0.0012 est.`, or null when the backend reported no priced cost for
   * this role (old/unpriced run). The segment is omitted then, never `$0`.
   */
  cost: string | null
  /** Hover text naming the priced model; null together with `cost`. */
  costTitle: string | null
}

function formatCount(value: number): string {
  return Number(Math.max(0, Number.isFinite(value) ? value : 0)).toLocaleString('en-US')
}

/**
 * One role's display rows, or null when that role measured no provider call
 * (the honest "no fabricated zero half" rule). Reuses the merged display's
 * family normalization: `cacheHitPercent`/`promptTokensOf`. `cost` is the
 * backend's additive per-role estimate for this half (`cost_by_role`); absent
 * or null adds no segment.
 */
export function roleUsageView(
  role: RoleName,
  usage: RunUsage | null | undefined,
  cost?: RunCost | null,
): RoleUsageView | null {
  if (!usage || count(usage.model_calls) <= 0) return null
  const prompt = promptTokensOf(usage)
  const percent = cacheHitPercent(usage)
  const cached = count(usage.cached_tokens)
  const written = count(usage.cache_write_tokens ?? 0)
  return {
    role,
    label: ROLE_LABELS[role],
    modelCalls: count(usage.model_calls),
    tokens: `in ${formatCount(prompt)} / out ${formatCount(usage.output_tokens)} tok`,
    cache: percent === null ? null : `cache ${percent}%`,
    cacheTitle:
      percent === null
        ? null
        : `cached ${formatCount(usage.cached_tokens)} of ${formatCount(prompt)} prompt tokens`,
    miss: cached > 0 ? `miss ${formatCount(Math.max(0, prompt - cached))} tok` : null,
    write: written > 0 ? `write ${formatCount(written)} tok` : null,
    cost: costLabel(cost),
    costTitle: costTitle(cost),
  }
}

/**
 * Both roles' render-ready rows, Senior first; absent split = no rows.
 * `costs` is the run record's additive `cost_by_role`: when present, each
 * priced half's row gains its own cost segment; absent (old/unpriced run)
 * keeps today's rows exactly.
 */
export function roleUsageViews(
  split: RunUsageByRole | null | undefined,
  costs?: RunCostByRole | null,
): RoleUsageView[] {
  if (!split) return []
  return ROLES.map((role) => roleUsageView(role, split[role], costs?.[role] ?? null)).filter(
    (view): view is RoleUsageView => view !== null,
  )
}
