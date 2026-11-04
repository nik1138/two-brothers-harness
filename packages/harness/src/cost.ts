/**
 * Cost estimation for a run's token usage: a small hand-maintained price
 * table (USD per 1M tokens) plus pure lookups. No network, no deps — the
 * numbers are a convenience gauge, not a bill. Update `MODEL_PRICES` when a
 * provider changes its list price; nothing else needs touching.
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

/** One price row: USD per 1M tokens, input and output. */
export interface ModelPrice {
  /** Canonical model id (also the prefix-matching key). */
  model: string;
  /** USD per 1,000,000 prompt (input) tokens. */
  inputPer1M: number;
  /** USD per 1,000,000 completion (output) tokens. */
  outputPer1M: number;
  /** Optional note (e.g. "local weights: ~0"). */
  note?: string;
}

/**
 * The price table. Keep it a plain literal: one row per model, USD per 1M
 * tokens. Local models sit at 0 (compute is the operator's own).
 */
export const MODEL_PRICES: readonly ModelPrice[] = [
  { model: "gpt-4o", inputPer1M: 2.5, outputPer1M: 10 },
  { model: "gpt-4o-mini", inputPer1M: 0.15, outputPer1M: 0.6 },
  { model: "gpt-4.1", inputPer1M: 2, outputPer1M: 8 },
  { model: "gpt-4.1-mini", inputPer1M: 0.4, outputPer1M: 1.6 },
  { model: "gpt-4.1-nano", inputPer1M: 0.1, outputPer1M: 0.4 },
  { model: "deepseek-chat", inputPer1M: 0.27, outputPer1M: 1.1 },
  { model: "deepseek-reasoner", inputPer1M: 0.55, outputPer1M: 2.19 },
  { model: "claude-sonnet-4", inputPer1M: 3, outputPer1M: 15 },
  { model: "claude-opus-4", inputPer1M: 15, outputPer1M: 75 },
  { model: "claude-3-5-sonnet", inputPer1M: 3, outputPer1M: 15 },
  { model: "gemini-2.5-pro", inputPer1M: 1.25, outputPer1M: 10 },
  { model: "gemini-2.5-flash", inputPer1M: 0.3, outputPer1M: 2.5 },
  { model: "llama-3.3-70b", inputPer1M: 0.23, outputPer1M: 0.4 },
  // Local weights served by LM Studio: no per-token price.
  { model: "spark-x2.6", inputPer1M: 0, outputPer1M: 0, note: "local" },
  { model: "lfm3-1.7b", inputPer1M: 0, outputPer1M: 0, note: "local" },
];

/** Token counts for one estimate. camelCase on purpose (provider-agnostic). */
export interface CostUsage {
  promptTokens: number;
  completionTokens: number;
}

/** One cost estimate, USD. */
export interface CostEstimate {
  /** USD spent on prompt tokens. */
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

function tokens(value: number): number {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : 0;
}

/**
 * Estimate one call/run's cost from token totals. `null` for a model the
 * table does not know (the caller shows an unknown marker instead of $0).
 */
export function estimateCost(model: string, usage: CostUsage): CostEstimate | null {
  const price = priceForModel(model);
  if (price === undefined) return null;
  const promptTokens = tokens(usage.promptTokens);
  const completionTokens = tokens(usage.completionTokens);
  const inputCost = (promptTokens / 1_000_000) * price.inputPer1M;
  const outputCost = (completionTokens / 1_000_000) * price.outputPer1M;
  return {
    inputCost,
    outputCost,
    totalCost: inputCost + outputCost,
    currency: "USD",
    model: price.model,
  };
}