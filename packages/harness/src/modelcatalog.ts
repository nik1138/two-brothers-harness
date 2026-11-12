/**
 * Model reasoning metadata from models.dev.
 *
 * The effort levels are a property of the model, not a product-wide enum:
 * models.dev declares `reasoning_options` such as
 * `{type:"effort", values:["low","high","max"]}` or a `budget_tokens` range.
 * The web UI only offers the effort values a model actually reports, and a
 * model with no effort option gets no effort control.
 *
 * The catalog is one ~6 MB JSON document; it is fetched lazily on the first
 * effort lookup and cached in memory. Every failure is fail-soft: the UI
 * simply gets no levels, and no effort control is offered.
 */

import { normalizeEffortValue } from "./effort.ts";

const MODELS_DEV_URL = "https://models.dev/api.json";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const FAILURE_TTL_MS = 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Preset names that differ from their models.dev provider id. The seed table
 * follows the dsh/pi catalog but keeps short, stable names for settings.
 */
const PROVIDER_ALIASES: Readonly<Record<string, string>> = {
  "kimi-coding": "kimi-code-plan-global",
  "qwen-token-plan": "alibaba-token-plan",
  "zai-coding": "zai-coding-plan",
  "zai-coding-cn": "zai-coding-plan",
};

/** One model's selectable effort levels (empty = no effort control). */
export interface ModelEfforts {
  reasoning: boolean;
  efforts: string[];
  /** `models.dev` when the lookup succeeded, `unavailable` otherwise. */
  source: "models.dev" | "unavailable";
}

type EffortIndex = Map<string, Map<string, ModelEfforts>>;

export interface ModelEffortCatalogOptions {
  url?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  ttlMs?: number;
  failureTtlMs?: number;
  timeoutMs?: number;
  /** False disables the network entirely (offline E2E/CI); lookups stay empty. */
  enabled?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The effort values a models.dev model entry declares, in catalog order. */
function effortsForModel(entry: unknown): ModelEfforts | null {
  if (!isRecord(entry)) return null;
  const options = Array.isArray(entry.reasoning_options) ? entry.reasoning_options : [];
  const efforts: string[] = [];
  for (const option of options) {
    if (!isRecord(option) || option.type !== "effort") continue;
    const values = Array.isArray(option.values) ? option.values : [];
    for (const value of values) {
      const normalized = normalizeEffortValue(value);
      if (normalized !== null && !efforts.includes(normalized)) efforts.push(normalized);
    }
  }
  const reasoning = entry.reasoning === true || efforts.length > 0;
  if (!reasoning) return null;
  return { reasoning: true, efforts, source: "models.dev" };
}

/** Build the compact index from one models.dev document. */
export function buildModelEffortIndex(raw: unknown): EffortIndex {
  const index: EffortIndex = new Map();
  if (!isRecord(raw)) return index;
  for (const [providerId, provider] of Object.entries(raw)) {
    if (!isRecord(provider) || !isRecord(provider.models)) continue;
    const models: Map<string, ModelEfforts> = new Map();
    for (const [modelId, entry] of Object.entries(provider.models)) {
      const efforts = effortsForModel(entry);
      if (efforts !== null) models.set(modelId, efforts);
    }
    if (models.size > 0) index.set(providerId.toLowerCase(), models);
  }
  return index;
}

const EMPTY: ModelEfforts = { reasoning: false, efforts: [], source: "unavailable" };

/** Lazily fetched, in-memory models.dev effort index. */
export class ModelEffortCatalog {
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly failureTtlMs: number;
  private readonly timeoutMs: number;
  private readonly enabled: boolean;
  private cache: { at: number; index: EffortIndex } | null = null;
  private failedAt: number | null = null;
  private loading: Promise<EffortIndex> | null = null;

  constructor(options: ModelEffortCatalogOptions = {}) {
    this.url = options.url ?? MODELS_DEV_URL;
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? CACHE_TTL_MS;
    this.failureTtlMs = options.failureTtlMs ?? FAILURE_TTL_MS;
    this.timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
    this.enabled = options.enabled ?? true;
  }

  /** The cached index, fetching on first use; never throws. */
  async index(): Promise<EffortIndex> {
    if (!this.enabled) return new Map();
    const now = this.now();
    if (this.cache !== null && now - this.cache.at < this.ttlMs) return this.cache.index;
    if (this.failedAt !== null && now - this.failedAt < this.failureTtlMs) return new Map();
    if (this.loading !== null) return this.loading;
    this.loading = this.fetchIndex(now);
    try {
      return await this.loading;
    } finally {
      this.loading = null;
    }
  }

  private async fetchIndex(now: number): Promise<EffortIndex> {
    try {
      const response = await this.fetchImpl(this.url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const index = buildModelEffortIndex(await response.json());
      this.cache = { at: now, index };
      this.failedAt = null;
      return index;
    } catch {
      this.failedAt = now;
      return new Map();
    }
  }

  /** One model's effort metadata; absent = no control (never invented). */
  async efforts(provider: string, model: string): Promise<ModelEfforts> {
    const index = await this.index();
    const key = provider.trim().toLowerCase();
    const providerModels =
      index.get(key) ?? index.get((PROVIDER_ALIASES[key] ?? "").toLowerCase());
    return providerModels?.get(model.trim()) ?? EMPTY;
  }
}
