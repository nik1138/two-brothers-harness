// Cache-hit percentage over the family-normalized prompt total.
//
// OpenAI-compatible payloads make `input_tokens` the whole prompt (cache reads
// included) and omit `prompt_tokens`; Anthropic reports uncached input only and
// Gemini reports prompt-minus-cached, so both send the additive `prompt_tokens`
// total from the backend. Dividing Anthropic/Gemini cached tokens by their raw
// `input_tokens` would inflate the hit rate (and can exceed 100% on a fully
// cached call). No DOM/Vue imports, so the pure tests cover it directly.

import type { RunUsage } from './types'

/** The honest cache denominator: normalized prompt total, falling back to input. */
export function promptTokensOf(
  usage: Pick<RunUsage, 'input_tokens' | 'prompt_tokens'> | null | undefined,
): number {
  if (!usage) return 0
  const prompt = Number(usage.prompt_tokens)
  if (Number.isFinite(prompt) && prompt > 0) return Math.floor(prompt)
  const input = Number(usage.input_tokens)
  return Number.isFinite(input) && input > 0 ? Math.floor(input) : 0
}

/**
 * Rounded, clamped cache-hit share, or null when no counter can be shown.
 * A fully cached Anthropic call has `input_tokens: 0` and `cached_tokens > 0`;
 * that is 100%, not an absent segment.
 */
export function cacheHitPercent(
  usage: Partial<RunUsage> | null | undefined,
): number | null {
  if (!usage) return null
  const prompt = promptTokensOf(usage as Pick<RunUsage, 'input_tokens' | 'prompt_tokens'>)
  const cachedRaw = Number(usage.cached_tokens)
  const cached = Number.isFinite(cachedRaw) ? Math.max(0, cachedRaw) : 0
  if (prompt <= 0) return cached > 0 ? 100 : null
  return Math.min(100, Math.round((cached / prompt) * 100))
}
