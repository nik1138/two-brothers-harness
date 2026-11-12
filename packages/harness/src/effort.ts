/**
 * Reasoning-effort values. The levels are model metadata, not a fixed product
 * enum: `models.dev` declares per-model `reasoning_options` such as
 * `{type:"effort", values:["low","high","max"]}`, and the UI offers exactly
 * those values. A model that reports no effort option gets no effort control.
 *
 * The stored/API value is the model's own token (low, high, max, xhigh, …);
 * `""` means the provider default and sends no reasoning control at all.
 * Anthropic/Google models in `models.dev` declare `budget_tokens` rather than
 * effort values, so the effort control is not offered for them; if a custom
 * setup nevertheless sets one, the budget fallback below maps known levels.
 */

/** A model-declared effort token (lowercase, bounded, URL/header-safe). */
export type EffortValue = string;

const EFFORT_VALUE_RE = /^[a-z][a-z0-9_-]{0,31}$/;

/**
 * Normalize a persisted/API effort value. An empty string or null means
 * "provider default" and yields null; an unsafe/oversized token is rejected.
 */
export function normalizeEffortValue(value: unknown): EffortValue | null {
  if (typeof value !== "string") return null;
  const token = value.trim().toLowerCase();
  if (token === "") return null;
  return EFFORT_VALUE_RE.test(token) ? token : null;
}

/** True for a value the wire can carry (empty means default, not an error). */
export function isEffortValue(value: unknown): value is EffortValue {
  return normalizeEffortValue(value) !== null;
}

/** Human label for a model-declared effort token. */
export function effortLabel(value: string): string {
  const token = value.trim().toLowerCase();
  if (token === "xhigh") return "Extra high";
  if (token === "max") return "Max";
  if (token === "minimal") return "Minimal";
  if (token === "none") return "None";
  if (token === "") return "Default";
  return token.charAt(0).toUpperCase() + token.slice(1);
}

/**
 * Fallback thinking budgets for Anthropic/Google when an effort value is set
 * by a custom setup (their catalog models declare budget ranges, not effort
 * levels, so the normal UI never offers these). Unknown/new tokens have no
 * fallback — the adapter then leaves the request untouched rather than
 * inventing a budget.
 */
const EFFORT_BUDGETS: Readonly<Record<string, number>> = {
  minimal: 512,
  low: 1_024,
  medium: 4_096,
  high: 16_384,
  xhigh: 24_576,
  max: 32_768,
};

export function effortThinkingBudget(value: string): number | undefined {
  return EFFORT_BUDGETS[value.trim().toLowerCase()];
}
