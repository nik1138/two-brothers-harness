import type { RunCost } from './types'

/**
 * The usage footer's cost segment, e.g. `~$0.0312 est.` — the same four-decimal
 * USD precision the CLI prints. `null` means "do not render a segment": the
 * backend reports `cost: null` for mixed-model/unknown-price runs, and a
 * malformed object must never turn into a made-up number.
 */
export function costLabel(cost: RunCost | null | undefined): string | null {
  if (!cost) return null
  if (cost.currency !== 'USD') return null
  if (typeof cost.model !== 'string' || cost.model.trim() === '') return null
  if (!Number.isFinite(cost.total) || cost.total < 0) return null
  return `~$${cost.total.toFixed(4)} est.`
}

/**
 * Hover text for a rendered cost segment. It names the model the estimate was
 * priced against and states plainly that the number is a token-usage
 * estimate, not a bill. `null` whenever there is no segment to label.
 */
export function costTitle(cost: RunCost | null | undefined): string | null {
  if (!cost || costLabel(cost) === null) return null
  return `${cost.model.trim()} — estimated from token usage; not a bill`
}
