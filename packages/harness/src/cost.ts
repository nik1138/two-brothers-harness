/**
 * Cost estimation for a run's token usage: a small hand-maintained price
 * table (USD per 1M tokens) plus pure lookups. No network, no deps — the
 * numbers are a convenience gauge, not a bill. Update `MODEL_PRICES` when a
 * provider changes its list price; nothing else needs touching.
 *
 * Prompt caching is priced honestly with the optional cache columns:
 * cache READS use the provider's published cached-input price and cache
 * WRITES use its cache-write price. A row without those columns falls back
 * to the input rate (documented on `ModelPrice`), so adding a row never
 * requires cache prices and two-field legacy calls keep their old arithmetic.
 *
 * Model matching is tolerant at the boundary:
 * 1. exact match on the lowercased model id;
 * 2. the same for the id's last `/` segment (so `openai/gpt-4o` and
 *    `models/gemini-2.5-pro` resolve);
 * 3. otherwise the LONGEST table key that is a prefix of the id wins, so
 *    dated snapshots resolve (`gpt-4o-2024-08-06` → `gpt-4o`,
 *    `claude-sonnet-4-5` → `claude-sonnet-4`) and `gpt-4o-mini-*` picks
 *    `gpt-4o-mini`, not `gpt-4o`.
 * Unknown models return `null` — the caller prints "—" / JSON `null` rather
 * than a made-up number.
 */

/** One price row: USD per 1M tokens, with optional prompt-cache prices. */
export interface ModelPrice {
  /** Canonical model id (also the prefix-matching key). */
  model: string;
  /** USD per 1,000,000 prompt (input) tokens, cache misses. */
  inputPer1M: number;
  /** USD per 1,000,000 completion (output) tokens. */
  outputPer1M: number;
  /**
   * USD per 1M cache-READ (cache-hit) prompt tokens, as published by the
   * provider. Absent = no published cache-read price, so those tokens price
   * at `inputPer1M` (the legacy behavior; never a guessed discount).
   */
  cachedInputPer1M?: number;
  /**
   * USD per 1M cache-WRITE prompt tokens. Absent = the provider publishes no
   * per-token write fee (or none is sourced), so writes price at
   * `inputPer1M`. Anthropic rows carry it because their 5-minute ephemeral
   * cache writes are billed at 1.25x input.
   */
  cacheWritePer1M?: number;
  /** Optional note (e.g. "local weights: ~0"). */
  note?: string;
}

/**
 * The price table. Keep it a plain literal: one row per model, USD per 1M
 * tokens. Local models sit at 0 (compute is the operator's own).
 *
 * Cache prices are the providers' published list prices, checked against the
 * official pricing pages on 2026-11-08:
 * - OpenAI cached input (50% of input for gpt-4o, 25% for the 4.1 family):
 *   https://platform.openai.com/docs/pricing
 * - Anthropic: cache reads at 0.1x input and the default 5-minute ephemeral
 *   cache writes at 1.25x input (the adapter's `cache_control` uses the
 *   default 5-minute cache): https://docs.anthropic.com/en/docs/about-claude/pricing
 * - DeepSeek cache-hit input: https://api-docs.deepseek.com/quick_start/pricing
 * - Google cached input: https://ai.google.dev/gemini-api/docs/pricing
 *
 * OpenAI, DeepSeek and Google publish no separate per-token cache-WRITE fee
 * (OpenAI's automatic caching and Gemini's implicit caching are free to
 * write, and Gemini's explicit context caching bills storage per token-hour,
 * which a per-token column cannot express), so those rows leave
 * `cacheWritePer1M` unset — the documented input-rate fallback applies, and
 * their usage payloads report no writes today.
 */
export const MODEL_PRICES: readonly ModelPrice[] = [
  { model: "gpt-4o", inputPer1M: 2.5, outputPer1M: 10, cachedInputPer1M: 1.25 },
  { model: "gpt-4o-mini", inputPer1M: 0.15, outputPer1M: 0.6, cachedInputPer1M: 0.075 },
  { model: "gpt-4.1", inputPer1M: 2, outputPer1M: 8, cachedInputPer1M: 0.5 },
  { model: "gpt-4.1-mini", inputPer1M: 0.4, outputPer1M: 1.6, cachedInputPer1M: 0.1 },
  { model: "gpt-4.1-nano", inputPer1M: 0.1, outputPer1M: 0.4, cachedInputPer1M: 0.025 },
  { model: "deepseek-chat", inputPer1M: 0.27, outputPer1M: 1.1, cachedInputPer1M: 0.07 },
  { model: "deepseek-reasoner", inputPer1M: 0.55, outputPer1M: 2.19, cachedInputPer1M: 0.14 },
  {
    model: "claude-sonnet-4",
    inputPer1M: 3,
    outputPer1M: 15,
    cachedInputPer1M: 0.3,
    cacheWritePer1M: 3.75,
  },
  {
    model: "claude-opus-4",
    inputPer1M: 15,
    outputPer1M: 75,
    cachedInputPer1M: 1.5,
    cacheWritePer1M: 18.75,
  },
  {
    model: "claude-3-5-sonnet",
    inputPer1M: 3,
    outputPer1M: 15,
    cachedInputPer1M: 0.3,
    cacheWritePer1M: 3.75,
  },
  { model: "gemini-2.5-pro", inputPer1M: 1.25, outputPer1M: 10, cachedInputPer1M: 0.31 },
  { model: "gemini-2.5-flash", inputPer1M: 0.3, outputPer1M: 2.5, cachedInputPer1M: 0.075 },
  { model: "llama-3.3-70b", inputPer1M: 0.23, outputPer1M: 0.4 },
  // Local weights served by LM Studio: no per-token price.
  { model: "spark-x2.6", inputPer1M: 0, outputPer1M: 0, note: "local" },
  { model: "lfm3-1.7b", inputPer1M: 0, outputPer1M: 0, note: "local" },
];

/**
 * Token counts for one estimate. camelCase on purpose (provider-agnostic).
 *
 * `promptTokens` is the TOTAL prompt token count — uncached + cache reads +
 * cache writes. Map the run's counters to that total: Anthropic is
 * `input_tokens + cached_tokens + cache_write_tokens` (its `input_tokens` is
 * uncached only), OpenAI-compatible is `input_tokens` (its `prompt_tokens`
 * already includes the cached subset), and Gemini is
 * `input_tokens + cached_tokens`. `cachedTokens` / `cacheWriteTokens` are the
 * subsets priced at the cache-read / cache-write rate; omit both for the
 * legacy "all prompt tokens at the input rate" arithmetic, which is
 * byte-stable with pre-cache-pricing calls. Values above `promptTokens` are
 * clamped to it so a bad caller can never produce negative input.
 */
export interface CostUsage {
  promptTokens: number;
  completionTokens: number;
  /** Cache-read (hit) prompt tokens, a subset of `promptTokens`. */
  cachedTokens?: number;
  /** Cache-write prompt tokens, a subset of `promptTokens`. */
  cacheWriteTokens?: number;
}

/** One cost estimate, USD. */
export interface CostEstimate {
  /**
   * USD spent on prompt tokens: uncached × input rate + cache reads ×
   * cache-read rate + cache writes × cache-write rate.
   */
  inputCost: number;
  /** USD spent on completion tokens. */
  outputCost: number;
  /** `inputCost + outputCost`. */
  totalCost: number;
  currency: "USD";
  /** The price row the model resolved to. */
  model: string;
}

function normalizeModel(model: string): string {
  return model.trim().toLowerCase().replace(/^models\//, "");
}

/** Last `/` segment of a model id (`openai/gpt-4o` → `gpt-4o`). */
function lastSegment(model: string): string {
  const index = model.lastIndexOf("/");
  return index === -1 ? model : model.slice(index + 1);
}

/**
 * The price row a model resolves to, or `undefined` for an unknown model.
 * See the module docstring for the matching rules.
 */
export function priceForModel(model: string): ModelPrice | undefined {
  const normalized = normalizeModel(model);
  if (!normalized) return undefined;
  const candidates = [normalized, lastSegment(normalized)].filter(
    (candidate, index, all) => candidate && all.indexOf(candidate) === index,
  );
  for (const candidate of candidates) {
    const exact = MODEL_PRICES.find((price) => price.model === candidate);
    if (exact) return exact;
  }
  // Longest prefix first: "gpt-4o-mini-2024-07-18" must beat "gpt-4o".
  const byLength = [...MODEL_PRICES].sort((a, b) => b.model.length - a.model.length);
  for (const candidate of candidates) {
    const match = byLength.find((price) => candidate.startsWith(price.model));
    if (match) return match;
  }
  return undefined;
}

function tokens(value: number | null | undefined): number {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : 0;
}

/**
 * Estimate one call/run's cost from token totals. `null` for a model the
 * table does not know (the caller shows an unknown marker instead of $0).
 *
 * Prompt tokens are split three ways: cache reads and cache writes are the
 * requested subsets of `promptTokens`, everything else is uncached input at
 * the full input rate. Cache reads use `cachedInputPer1M` when the row has
 * one, cache writes use `cacheWritePer1M` when the row has one, and each
 * falls back to the input rate otherwise. Output is priced as before, so the
 * returned shape and every two-field call are unchanged.
 */
export function estimateCost(model: string, usage: CostUsage): CostEstimate | null {
  const price = priceForModel(model);
  if (price === undefined) return null;
  const promptTokens = tokens(usage.promptTokens);
  const completionTokens = tokens(usage.completionTokens);
  const cachedTokens = Math.min(tokens(usage.cachedTokens), promptTokens);
  const cacheWriteTokens = Math.min(
    tokens(usage.cacheWriteTokens),
    promptTokens - cachedTokens,
  );
  const uncachedTokens = promptTokens - cachedTokens - cacheWriteTokens;
  const cachedRate = price.cachedInputPer1M ?? price.inputPer1M;
  const cacheWriteRate = price.cacheWritePer1M ?? price.inputPer1M;
  const inputCost =
    ((uncachedTokens * price.inputPer1M +
      cachedTokens * cachedRate +
      cacheWriteTokens * cacheWriteRate) /
      1_000_000);
  const outputCost = (completionTokens / 1_000_000) * price.outputPer1M;
  return {
    inputCost,
    outputCost,
    totalCost: inputCost + outputCost,
    currency: "USD",
    model: price.model,
  };
}

// ---------------------------------------------------------------------------
// family-aware run estimates
// ---------------------------------------------------------------------------

/**
 * The wire family whose prompt counters a merged usage came from. Each family
 * reports `input_tokens` against a different base, so the total prompt tokens
 * for pricing cannot be derived without knowing it:
 *
 * - `openai-compatible`: `input_tokens` is `prompt_tokens`, cache reads
 *   INCLUDED;
 * - `anthropic`: `input_tokens` is uncached only, so the total is
 *   `input + cache reads + cache writes`;
 * - `google`: `input_tokens` is `promptTokenCount - cachedContentTokenCount`,
 *   so the total is `input + cache reads`.
 */
export type CostPromptFamily = "openai-compatible" | "anthropic" | "google";

/**
 * Token counters exactly as the adapters report them (a merged `UsageTotals`
 * satisfies this shape). Values may be missing or hostile; they are coerced.
 */
export interface PromptTokenUsage {
  input_tokens?: unknown;
  output_tokens?: unknown;
  cached_tokens?: unknown;
  cache_write_tokens?: unknown;
}

/**
 * Map one family's counters onto {@link CostUsage}'s total-prompt model. Cache
 * writes are clamped by `estimateCost` and are 0 for families that report no
 * write counter.
 */
export function costUsageForFamily(
  family: CostPromptFamily,
  usage: PromptTokenUsage,
): CostUsage {
  const inputTokens = tokens(Number(usage.input_tokens));
  const cachedTokens = tokens(Number(usage.cached_tokens));
  const cacheWriteTokens = tokens(Number(usage.cache_write_tokens));
  const completionTokens = tokens(Number(usage.output_tokens));
  if (family === "anthropic") {
    return {
      promptTokens: inputTokens + cachedTokens + cacheWriteTokens,
      completionTokens,
      cachedTokens,
      cacheWriteTokens,
    };
  }
  if (family === "google") {
    return {
      promptTokens: inputTokens + cachedTokens,
      completionTokens,
      cachedTokens,
      cacheWriteTokens: 0,
    };
  }
  return {
    promptTokens: inputTokens,
    completionTokens,
    cachedTokens,
    cacheWriteTokens: 0,
  };
}

/** Inputs for one run's estimate; models come from the resolved run config. */
export interface RunCostInput {
  seniorModel: string;
  juniorModel: string;
  /** Resolved family per role; `null` when the kind could not be resolved. */
  seniorFamily?: CostPromptFamily | null;
  juniorFamily?: CostPromptFamily | null;
  usage: PromptTokenUsage;
}

/**
 * Estimate a run's cost from its merged usage, honouring prompt caching.
 *
 * The harness reports ONE merged counter set, not a per-role split, so the
 * estimate is honest only when both roles resolve to the same priced model and
 * the same family. A mixed-family run is still exact while both cache counters
 * are 0 (all three mappings equal `input_tokens`); with cache counters present
 * the prompt base is ambiguous and the caller gets `null` instead of a number
 * that prices cache tokens twice or not at all. `null` also covers an unknown
 * model, a blank model id and different models per role.
 */
export function estimateRunCostFromUsage(input: RunCostInput): CostEstimate | null {
  const senior = input.seniorModel.trim();
  const junior = input.juniorModel.trim();
  if (senior === "" || senior !== junior) return null;
  const seniorFamily = input.seniorFamily ?? null;
  const juniorFamily = input.juniorFamily ?? null;
  let family: CostPromptFamily;
  if (seniorFamily !== null && seniorFamily === juniorFamily) {
    family = seniorFamily;
  } else if (
    tokens(Number(input.usage.cached_tokens)) + tokens(Number(input.usage.cache_write_tokens)) === 0
  ) {
    family = "openai-compatible";
  } else {
    return null;
  }
  return estimateCost(senior, costUsageForFamily(family, input.usage));
}