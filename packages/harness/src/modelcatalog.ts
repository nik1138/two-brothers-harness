/**
 * models.dev catalog: model reasoning metadata and the read-only provider
 * browse/import view.
 *
 * The effort levels are a property of the model, not a product-wide enum:
 * models.dev declares `reasoning_options` such as
 * `{type:"effort", values:["low","high","max"]}` or a `budget_tokens` range.
 * The web UI only offers the effort values a model actually reports, and a
 * model with no effort option gets no effort control.
 *
 * The same document also feeds Settings → Providers → "Browse models.dev…":
 * provider summaries and per-model wire-family inference (the OpenCode Go
 * case, where one catalog provider serves three protocols). One compact index
 * is built per successful fetch and the ~6 MB parsed document is dropped, so
 * one download serves both the effort route and the two browse routes.
 *
 * Every failure is fail-soft: a lookup answers honestly with no levels, the
 * browse view answers `source:"curated"` from the seed presets, and no route
 * ever sees a throw from this module.
 */

import { normalizeEffortValue } from "./effort.ts";
import { isProviderKind, type ProviderKind } from "./provider.ts";
import { seedPresets, type Preset } from "./presets.ts";
import { PROVIDER_CATALOG_ID_RE } from "./settings_store.ts";

const MODELS_DEV_URL = "https://models.dev/api.json";

/** Fresh in-memory snapshot lifetime (the document is ~6 MB). */
export const CACHE_TTL_MS = 60 * 60 * 1000;
/** A failed refresh is not retried for this long (offline clicks stay cheap). */
export const FAILURE_TTL_MS = 60 * 1000;
/** One fetch attempt's hard timeout (Node's global fetch honors the signal). */
export const FETCH_TIMEOUT_MS = 10_000;

/** Defensive bounds; a hit truncates and reports `truncated: true`. */
export const MAX_PROVIDERS = 400;
export const MAX_MODELS_PER_PROVIDER = 300;
export const MAX_CATALOG_BYTES = 32 * 1024 * 1024;
export const MAX_ID_CHARS = 100;
export const MAX_NAME_CHARS = 200;
export const MAX_URL_CHARS = 500;
export const MAX_ENV_ENTRIES = 3;
export const MAX_EFFORTS = 16;

/** The catalog provider id accepted by `GET /api/models-dev/providers/{id}`. */
export const CATALOG_PROVIDER_ID_RE = PROVIDER_CATALOG_ID_RE;

/**
 * Preset names that differ from their models.dev provider id. The seed table
 * follows the dsh/pi catalog but keeps short, stable names for settings. A
 * preset imported from the catalog stores its own `catalog_id` instead, which
 * the server prefers over this table.
 */
const PROVIDER_ALIASES: Readonly<Record<string, string>> = {
  "kimi-coding": "kimi-code-plan-global",
  "qwen-token-plan": "alibaba-token-plan",
  "zai-coding": "zai-coding-plan",
  "zai-coding-cn": "zai-coding-plan",
};

/** Where a browse answer came from. */
export type CatalogSource = "network" | "cache" | "stale" | "curated";

/** Why a provider/model kind was inferred. */
export type KindSource = "type" | "npm" | "id" | "guessed";

/** Why a catalog entry cannot be imported. */
export type RejectReason = "proprietary-protocol" | "unknown-type";

/** Listed models per wire family (always all four keys). */
export interface CatalogFamilies {
  "openai-compatible": number;
  anthropic: number;
  google: number;
  unsupported: number;
}

/** One provider row of `GET /api/models-dev/providers` (no model arrays). */
export interface CatalogProviderSummary {
  id: string;
  name: string;
  /** Usable base URL, or null when the entry has none (or an unusable one). */
  api: string | null;
  /** Env-var NAMES only (display), at most {@link MAX_ENV_ENTRIES}. */
  env: string[];
  /** Resolved wire family; null when the entry is rejected. */
  kind: ProviderKind | null;
  kind_source: KindSource | null;
  rejected: boolean;
  reject_reason: RejectReason | null;
  needs_base_url: boolean;
  /** Listed (importable-shape) models, after the catalog filter. */
  model_count: number;
  families: CatalogFamilies;
}

/** One model row of `GET /api/models-dev/providers/{id}`. */
export interface CatalogModelEntry {
  id: string;
  name: string;
  /** Resolved family for this model; null = unsupported protocol. */
  kind: ProviderKind | null;
  /** True when this model's family differs from the provider's primary kind. */
  mixed_family: boolean;
  /** Base URL override, only when it differs from the provider `api`. */
  base_url: string | null;
  /** Context window in tokens; 0 = unknown. */
  context_window: number;
  reasoning: boolean;
  /** The same normalized list the effort route returns (display only). */
  efforts: string[];
}

/** One provider's detail (summary fields plus the bounded model list). */
export interface CatalogProviderDetail extends CatalogProviderSummary {
  truncated: boolean;
  models: CatalogModelEntry[];
}

/** `GET /api/models-dev/providers` body. */
export interface CatalogSnapshot {
  source: CatalogSource;
  /** Epoch ms of the last successful fetch; null when curated/never. */
  fetched_at: number | null;
  /** Only when the snapshot is stale or curated. */
  upstream_error?: string;
  /** Only when the live catalog is env-disabled. */
  disabled?: boolean;
  truncated: boolean;
  providers: CatalogProviderSummary[];
}

/** `GET /api/models-dev/providers/{id}` body. */
export interface CatalogDetail {
  source: CatalogSource;
  fetched_at: number | null;
  upstream_error?: string;
  disabled?: boolean;
  provider: CatalogProviderDetail;
}

/** One model's selectable effort levels (empty = no effort control). */
export interface ModelEfforts {
  reasoning: boolean;
  efforts: string[];
  /** `models.dev` when the lookup succeeded, `unavailable` otherwise. */
  source: "models.dev" | "unavailable";
}

/** The compact per-fetch index: lowercased provider id -> provider entry. */
export type CatalogIndex = Map<string, CatalogIndexProvider>;

export interface CatalogIndexProvider {
  summary: CatalogProviderSummary;
  /** Exact catalog model id -> model entry (filtered). */
  models: Map<string, CatalogModelEntry>;
}

/** Fetch/injection seam (every test injects a fixture `fetchImpl`). */
export interface ModelsDevCatalogOptions {
  url?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  ttlMs?: number;
  failureTtlMs?: number;
  timeoutMs?: number;
  /** False disables the network entirely (offline E2E/CI); lookups stay empty. */
  enabled?: boolean;
}

/** Deprecated name kept for one release. */
export type ModelEffortCatalogOptions = ModelsDevCatalogOptions;

// ---------------------------------------------------------------------------
// pure helpers (string bounds, inference, index building)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Trimmed, clipped string (untrusted catalog values never grow unbounded). */
function clipped(value: unknown, maxChars: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxChars) : "";
}

/**
 * A base URL we can put in front of an adapter: an http(s) URL without a
 * `${…}` placeholder, ≤ {@link MAX_URL_CHARS}. Everything else is "unknown".
 */
export function usableBaseUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const url = value.trim();
  if (!url || url.length > MAX_URL_CHARS) return null;
  if (url.includes("${")) return null;
  if (!/^https?:\/\//i.test(url)) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/** npm package markers that speak a protocol we do not implement. */
const PROPRIETARY_NPM_MARKERS: readonly string[] = [
  "amazon-bedrock",
  "bedrock",
  "cohere",
  "google-vertex",
  "vertexai",
  "azure",
  "cloudflare",
  "watsonx",
  "sap-ai",
];

/** npm package markers known to be OpenAI-compatible. */
const OPENAI_COMPATIBLE_NPM_MARKERS: readonly string[] = [
  "mistral",
  "xai",
  "grok",
  "groq",
  "cerebras",
  "togetherai",
  "together-ai",
  "fireworks",
  "deepinfra",
  "openrouter",
  "deepseek",
  "perplexity",
  "moonshot",
  "zhipu",
  "qwen",
  "ollama",
  "openai-compatible",
];

export interface ProviderKindInference {
  kind: ProviderKind | null;
  kind_source: KindSource | null;
  rejected: boolean;
  reject_reason: RejectReason | null;
}

function familyInference(kind: ProviderKind, source: KindSource): ProviderKindInference {
  return { kind, kind_source: source, rejected: false, reject_reason: null };
}

function rejectedInference(reason: RejectReason): ProviderKindInference {
  return { kind: null, kind_source: null, rejected: true, reject_reason: reason };
}

function npmInference(npm: string): ProviderKindInference {
  const lower = npm.trim().toLowerCase();
  for (const marker of PROPRIETARY_NPM_MARKERS) {
    if (lower.includes(marker)) return rejectedInference("proprietary-protocol");
  }
  if (lower.includes("anthropic") || lower.includes("claude")) {
    return familyInference("anthropic", "npm");
  }
  if (lower.includes("google") || lower.includes("gemini")) {
    return familyInference("google", "npm");
  }
  if (lower.includes("openai")) return familyInference("openai-compatible", "npm");
  for (const marker of OPENAI_COMPATIBLE_NPM_MARKERS) {
    if (lower.includes(marker)) return familyInference("openai-compatible", "npm");
  }
  // An npm package we do not recognize is guessed OpenAI-compatible and shown
  // with the `guessed` warning; the Add form's Kind stays editable.
  return familyInference("openai-compatible", "guessed");
}

export interface ProviderKindSignals {
  /** Catalog provider id (the document key). */
  id?: unknown;
  /** Forward-compatible provider `type` field (the live v1 doc has none). */
  type?: unknown;
  /** Provider-level SDK package. */
  npm?: unknown;
}

/**
 * Providers: ordered rules, first match wins.
 * 1. explicit `type` (a type we do not speak is rejected, never guessed);
 * 2. `npm` markers (proprietary first, then the known families);
 * 3. the id's markers when `npm` is absent;
 * 4. otherwise OpenAI-compatible + `guessed`.
 */
export function inferProviderKind(signals: ProviderKindSignals): ProviderKindInference {
  const type = clipped(signals.type, MAX_ID_CHARS).toLowerCase();
  if (type) {
    if (type === "openai" || type === "openai-compatible") {
      return familyInference("openai-compatible", "type");
    }
    if (type === "anthropic") return familyInference("anthropic", "type");
    if (type === "google" || type === "google-genai") {
      return familyInference("google", "type");
    }
    return rejectedInference("unknown-type");
  }
  const npm = clipped(signals.npm, MAX_NAME_CHARS);
  if (npm) return npmInference(npm);
  const id = clipped(signals.id, MAX_ID_CHARS).toLowerCase();
  if (!id) return familyInference("openai-compatible", "guessed");
  for (const marker of PROPRIETARY_NPM_MARKERS) {
    if (id.includes(marker)) return rejectedInference("proprietary-protocol");
  }
  if (id.includes("anthropic") || id.includes("claude")) {
    return familyInference("anthropic", "id");
  }
  if (id.includes("google") || id.includes("gemini")) {
    return familyInference("google", "id");
  }
  if (id.includes("openai")) return familyInference("openai-compatible", "id");
  for (const marker of OPENAI_COMPATIBLE_NPM_MARKERS) {
    if (id.includes(marker)) return familyInference("openai-compatible", "id");
  }
  return familyInference("openai-compatible", "guessed");
}

export interface ModelKindSignals {
  /** The raw catalog model entry. */
  model: unknown;
  /** The provider's resolved family (null = the provider is rejected). */
  providerKind: ProviderKind | null;
  /** The provider's usable `api` (null = no base URL). */
  providerApi: string | null;
}

export interface ModelKindInference {
  kind: ProviderKind | null;
  kind_source: KindSource | null;
  mixed_family: boolean;
  base_url: string | null;
  rejected: boolean;
  reject_reason: RejectReason | null;
}

/**
 * Models: a per-model `provider.npm` override resolves that model's own family
 * (the OpenCode Go case); a `provider.api` alone keeps the provider family and
 * only overrides the base URL; no override inherits the provider family.
 */
export function inferModelKind(signals: ModelKindSignals): ModelKindInference {
  const entry = isRecord(signals.model) ? signals.model : {};
  const override = isRecord(entry.provider) ? entry.provider : null;
  const npm = override ? clipped(override.npm, MAX_NAME_CHARS) : "";
  const overrideApi = override ? usableBaseUrl(override.api) : null;
  if (npm) {
    const inference = npmInference(npm);
    if (inference.rejected) {
      return {
        kind: null,
        kind_source: null,
        mixed_family: false,
        base_url: overrideApi,
        rejected: true,
        reject_reason: inference.reject_reason,
      };
    }
    const kind = inference.kind;
    const base = overrideApi ?? signals.providerApi;
    return {
      kind,
      kind_source: inference.kind_source,
      mixed_family: kind !== null && kind !== signals.providerKind,
      base_url: base !== signals.providerApi ? base : null,
      rejected: false,
      reject_reason: null,
    };
  }
  if (overrideApi !== null && overrideApi !== signals.providerApi) {
    return {
      kind: signals.providerKind,
      kind_source: null,
      mixed_family: false,
      base_url: overrideApi,
      rejected: false,
      reject_reason: null,
    };
  }
  return {
    kind: signals.providerKind,
    kind_source: null,
    mixed_family: false,
    base_url: null,
    rejected: false,
    reject_reason: null,
  };
}

/** Model `type` values that are chat-shaped; anything else is skipped. */
const CHAT_MODEL_TYPES: ReadonlySet<string> = new Set([
  "chat",
  "language",
  "text",
  "llm",
  "completion",
]);

/**
 * Filter one catalog model entry. Filtering is silent by design: an embedding,
 * a deprecated/alpha snapshot, or a non-text output model is simply not in the
 * list (a model with an unknown context window still is).
 */
function isListedModel(modelId: string, entry: Record<string, unknown>): boolean {
  const type = clipped(entry.type, MAX_ID_CHARS).toLowerCase();
  if (type && !CHAT_MODEL_TYPES.has(type)) return false;
  const status = clipped(entry.status, MAX_ID_CHARS).toLowerCase();
  if (status === "deprecated" || status === "alpha") return false;
  const modalities = isRecord(entry.modalities) ? entry.modalities.output : undefined;
  if (Array.isArray(modalities) && modalities.length > 0) {
    const outputs = modalities
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim().toLowerCase());
    if (!outputs.includes("text")) return false;
  }
  const family = clipped(entry.family, MAX_NAME_CHARS).toLowerCase();
  const name = clipped(entry.name, MAX_NAME_CHARS).toLowerCase();
  if (
    modelId.toLowerCase().includes("embed") ||
    family.includes("embed") ||
    name.includes("embed")
  ) {
    return false;
  }
  return true;
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
      if (normalized !== null && !efforts.includes(normalized)) {
        efforts.push(normalized);
        if (efforts.length >= MAX_EFFORTS) break;
      }
    }
    if (efforts.length >= MAX_EFFORTS) break;
  }
  const reasoning = entry.reasoning === true || efforts.length > 0;
  if (!reasoning) return null;
  return { reasoning: true, efforts, source: "models.dev" };
}

/** One listed model's context window from `limit.context`; 0 = unknown. */
function contextWindowOf(entry: Record<string, unknown>): number {
  const limit = isRecord(entry.limit) ? entry.limit : null;
  const value = limit ? limit.context : entry.context_window;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function countFamilies(models: Iterable<CatalogModelEntry>): CatalogFamilies {
  const families: CatalogFamilies = {
    "openai-compatible": 0,
    anthropic: 0,
    google: 0,
    unsupported: 0,
  };
  for (const model of models) {
    if (model.kind === null) families.unsupported += 1;
    else families[model.kind] += 1;
  }
  return families;
}

function catalogEnv(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const name = clipped(item, MAX_ID_CHARS);
    if (!name || out.includes(name)) continue;
    out.push(name);
    if (out.length >= MAX_ENV_ENTRIES) break;
  }
  return out;
}

function buildModelEntry(
  rawModelId: string,
  rawModel: unknown,
  providerKind: ProviderKind | null,
  providerApi: string | null,
): CatalogModelEntry | null {
  const id = clipped(rawModelId, MAX_ID_CHARS);
  if (!id || !isRecord(rawModel)) return null;
  if (!isListedModel(id, rawModel)) return null;
  const inference = inferModelKind({ model: rawModel, providerKind, providerApi });
  const effortInfo = effortsForModel(rawModel);
  return {
    id,
    name: clipped(rawModel.name, MAX_NAME_CHARS) || id,
    kind: inference.kind,
    mixed_family: inference.kind !== null && inference.kind !== providerKind,
    base_url: inference.base_url,
    context_window: contextWindowOf(rawModel),
    reasoning: effortInfo !== null,
    efforts: effortInfo?.efforts ?? [],
  };
}

function buildProviderEntry(
  rawProviderId: string,
  rawProvider: unknown,
): CatalogIndexProvider | null {
  if (!isRecord(rawProvider)) return null;
  const id = clipped(rawProviderId, MAX_ID_CHARS);
  if (!id) return null;
  const name = clipped(rawProvider.name, MAX_NAME_CHARS) || id;
  const api = usableBaseUrl(rawProvider.api);
  const inference = inferProviderKind({
    id,
    type: rawProvider.type,
    npm: rawProvider.npm,
  });
  const rawModels = isRecord(rawProvider.models) ? rawProvider.models : {};
  const models = new Map<string, CatalogModelEntry>();
  for (const [rawModelId, rawModel] of Object.entries(rawModels)) {
    const model = buildModelEntry(rawModelId, rawModel, inference.kind, api);
    if (model !== null) models.set(model.id, model);
  }
  const summary: CatalogProviderSummary = {
    id,
    name,
    api,
    env: catalogEnv(rawProvider.env),
    kind: inference.kind,
    kind_source: inference.kind_source,
    rejected: inference.rejected,
    reject_reason: inference.reject_reason,
    needs_base_url: api === null,
    model_count: models.size,
    families: countFamilies(models.values()),
  };
  return { summary, models };
}

/**
 * Build the compact index from one models.dev document. Never throws: a
 * malformed provider entry is skipped, and the raw document is not retained.
 */
export function buildCatalogIndex(raw: unknown): CatalogIndex {
  const index: CatalogIndex = new Map();
  if (!isRecord(raw)) return index;
  for (const [rawProviderId, rawProvider] of Object.entries(raw)) {
    try {
      const entry = buildProviderEntry(rawProviderId, rawProvider);
      if (entry !== null) index.set(entry.summary.id.toLowerCase(), entry);
    } catch {
      // fail-soft: one broken entry never kills the whole catalog
    }
  }
  return index;
}

/**
 * Compatibility view for the effort route's tests: provider -> reasoning
 * models -> effort levels, derived from the compact index.
 */
export function buildModelEffortIndex(
  raw: unknown,
): Map<string, Map<string, ModelEfforts>> {
  const index = buildCatalogIndex(raw);
  const out = new Map<string, Map<string, ModelEfforts>>();
  for (const [providerId, entry] of index) {
    const models = new Map<string, ModelEfforts>();
    for (const [modelId, model] of entry.models) {
      if (!model.reasoning) continue;
      models.set(modelId, {
        reasoning: true,
        efforts: [...model.efforts],
        source: "models.dev",
      });
    }
    if (models.size > 0) out.set(providerId, models);
  }
  return out;
}

function copySummary(summary: CatalogProviderSummary): CatalogProviderSummary {
  return {
    id: summary.id,
    name: summary.name,
    api: summary.api,
    env: [...summary.env],
    kind: summary.kind,
    kind_source: summary.kind_source,
    rejected: summary.rejected,
    reject_reason: summary.reject_reason,
    needs_base_url: summary.needs_base_url,
    model_count: summary.model_count,
    families: { ...summary.families },
  };
}

function copyModel(model: CatalogModelEntry): CatalogModelEntry {
  return { ...model, efforts: [...model.efforts] };
}

function compareProviders(
  a: CatalogProviderSummary,
  b: CatalogProviderSummary,
): number {
  const an = a.name.toLowerCase();
  const bn = b.name.toLowerCase();
  if (an < bn) return -1;
  if (an > bn) return 1;
  const ai = a.id.toLowerCase();
  const bi = b.id.toLowerCase();
  return ai < bi ? -1 : ai > bi ? 1 : 0;
}

/**
 * Provider summaries, sorted by display name then id, capped at
 * {@link MAX_PROVIDERS} (`truncated` reports a defensive cap hit).
 */
export function catalogSummaries(index: CatalogIndex): {
  providers: CatalogProviderSummary[];
  truncated: boolean;
} {
  const all = [...index.values()].map((entry) => entry.summary);
  all.sort(compareProviders);
  const truncated = all.length > MAX_PROVIDERS;
  const page = truncated ? all.slice(0, MAX_PROVIDERS) : all;
  return { providers: page.map(copySummary), truncated };
}

/**
 * One provider's detail from the index, models sorted by id and capped at
 * {@link MAX_MODELS_PER_PROVIDER}. The id lookup is case-insensitive.
 */
export function catalogDetail(
  index: CatalogIndex,
  id: string,
): CatalogProviderDetail | null {
  const entry = index.get(id.trim().toLowerCase());
  if (entry === undefined) return null;
  const sorted = [...entry.models.values()].sort((a, b) => {
    const ai = a.id;
    const bi = b.id;
    return ai < bi ? -1 : ai > bi ? 1 : 0;
  });
  const truncated = sorted.length > MAX_MODELS_PER_PROVIDER;
  const page = truncated ? sorted.slice(0, MAX_MODELS_PER_PROVIDER) : sorted;
  return { ...copySummary(entry.summary), truncated, models: page.map(copyModel) };
}

// ---------------------------------------------------------------------------
// curated fallback (the built-in seed table; no shipped snapshot)
// ---------------------------------------------------------------------------

function seedKind(preset: Preset): ProviderKind {
  return isProviderKind(preset.kind) ? preset.kind : "openai-compatible";
}

function seedSummary(preset: Preset): CatalogProviderSummary {
  const kind = seedKind(preset);
  const api = usableBaseUrl(preset.base_url);
  const modelCount = preset.models.length;
  const families: CatalogFamilies = {
    "openai-compatible": 0,
    anthropic: 0,
    google: 0,
    unsupported: 0,
  };
  families[kind] = modelCount;
  return {
    id: preset.name,
    name: preset.name,
    api,
    env: preset.api_key_env ? [clipped(preset.api_key_env, MAX_ID_CHARS)] : [],
    kind,
    kind_source: "id",
    rejected: false,
    reject_reason: null,
    needs_base_url: api === null,
    model_count: modelCount,
    families,
  };
}

/** The seed table as provider summaries (offline/curated browse view). */
export function curatedSummaries(): CatalogProviderSummary[] {
  return seedPresets().map(seedSummary);
}

/**
 * One seed preset as a catalog detail. Seed models carry the preset's own
 * window and no reasoning metadata; stored overrides are deliberately not
 * consulted (they are already visible in the provider list).
 */
export function curatedDetail(id: string): CatalogProviderDetail | null {
  const wanted = id.trim().toLowerCase();
  const preset = seedPresets().find((entry) => entry.name.toLowerCase() === wanted);
  if (preset === undefined) return null;
  const kind = seedKind(preset);
  const contextWindow =
    typeof preset.context_window === "number" && Number.isSafeInteger(preset.context_window)
      ? preset.context_window
      : 0;
  const models: CatalogModelEntry[] = preset.models.map((modelId) => ({
    id: modelId,
    name: modelId,
    kind,
    mixed_family: false,
    base_url: null,
    context_window: contextWindow,
    reasoning: false,
    efforts: [],
  }));
  const truncated = models.length > MAX_MODELS_PER_PROVIDER;
  return {
    ...seedSummary(preset),
    truncated,
    models: (truncated ? models.slice(0, MAX_MODELS_PER_PROVIDER) : models).map(copyModel),
  };
}

// ---------------------------------------------------------------------------
// cache + class
// ---------------------------------------------------------------------------

interface CatalogLoad {
  data: CatalogIndex | null;
  source: CatalogSource;
  fetchedAt: number | null;
  upstreamError: string | null;
  disabled: boolean;
}

const EMPTY: ModelEfforts = { reasoning: false, efforts: [], source: "unavailable" };

function errorMessage(exc: unknown): string {
  const message = exc instanceof Error ? exc.message : String(exc);
  return clipped(message || "the models.dev catalog is unavailable", MAX_NAME_CHARS);
}

/**
 * Lazily fetched, in-memory models.dev catalog: one compact index per
 * successful fetch, 1 h TTL, 60 s failure back-off, stale-on-error and
 * single-flight. Every lookup is fail-soft.
 */
export class ModelsDevCatalog {
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly failureTtlMs: number;
  private readonly timeoutMs: number;
  private readonly enabled: boolean;
  private cache: { at: number; data: CatalogIndex } | null = null;
  private failedAt: number | null = null;
  private lastError: string | null = null;
  private loading: Promise<CatalogLoad> | null = null;

  constructor(options: ModelsDevCatalogOptions = {}) {
    this.url = options.url ?? MODELS_DEV_URL;
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? CACHE_TTL_MS;
    this.failureTtlMs = options.failureTtlMs ?? FAILURE_TTL_MS;
    this.timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
    this.enabled = options.enabled ?? true;
  }

  /**
   * The current state: `network` (fresh fetch), `cache` (fresh memory),
   * `stale` (expired memory served after a failed refresh) or `curated`
   * (no usable snapshot; the caller answers from the seed table).
   */
  private async load(): Promise<CatalogLoad> {
    if (!this.enabled) {
      return {
        data: null,
        source: "curated",
        fetchedAt: null,
        upstreamError: null,
        disabled: true,
      };
    }
    const now = this.now();
    if (this.cache !== null && now - this.cache.at < this.ttlMs) {
      return {
        data: this.cache.data,
        source: "cache",
        fetchedAt: this.cache.at,
        upstreamError: null,
        disabled: false,
      };
    }
    if (this.failedAt !== null && now - this.failedAt < this.failureTtlMs) {
      return this.serveAfterFailure(this.lastError ?? "the models.dev catalog is unavailable");
    }
    if (this.loading !== null) return this.loading;
    this.loading = this.refresh(now);
    try {
      return await this.loading;
    } finally {
      this.loading = null;
    }
  }

  /** A cached snapshot is never replaced by a failed or empty result. */
  private serveAfterFailure(error: string): CatalogLoad {
    if (this.cache !== null) {
      return {
        data: this.cache.data,
        source: "stale",
        fetchedAt: this.cache.at,
        upstreamError: error,
        disabled: false,
      };
    }
    return {
      data: null,
      source: "curated",
      fetchedAt: null,
      upstreamError: error,
      disabled: false,
    };
  }

  private async refresh(now: number): Promise<CatalogLoad> {
    try {
      const data = await this.fetchCatalog();
      this.cache = { at: now, data };
      this.failedAt = null;
      this.lastError = null;
      return {
        data,
        source: "network",
        fetchedAt: now,
        upstreamError: null,
        disabled: false,
      };
    } catch (exc) {
      const error = errorMessage(exc);
      this.failedAt = now;
      this.lastError = error;
      return this.serveAfterFailure(error);
    }
  }

  private async fetchCatalog(): Promise<CatalogIndex> {
    const response = await this.fetchImpl(this.url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const declared = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > MAX_CATALOG_BYTES) {
      throw new Error(`the catalog payload is too large (${declared} bytes)`);
    }
    const raw: unknown = await response.json();
    if (!isRecord(raw)) throw new Error("the catalog payload is not a JSON object");
    if (Object.keys(raw).length === 0) {
      throw new Error("the catalog payload has no providers");
    }
    const index = buildCatalogIndex(raw);
    if (index.size === 0) throw new Error("the catalog payload has no usable providers");
    return index;
  }

  /** One model's effort metadata; absent = no control (never invented). */
  async efforts(provider: string, model: string): Promise<ModelEfforts> {
    const state = await this.load();
    if (state.data === null) return EMPTY;
    const key = provider.trim().toLowerCase();
    const entry =
      state.data.get(key) ?? state.data.get((PROVIDER_ALIASES[key] ?? "").toLowerCase());
    const modelEntry = entry?.models.get(model.trim());
    if (modelEntry === undefined || !modelEntry.reasoning) return EMPTY;
    return { reasoning: true, efforts: [...modelEntry.efforts], source: "models.dev" };
  }

  /** Provider summaries (or the curated seed view when there is no snapshot). */
  async providers(): Promise<CatalogSnapshot> {
    const state = await this.load();
    if (state.data === null) {
      return {
        source: "curated",
        fetched_at: null,
        ...(state.upstreamError === null ? {} : { upstream_error: state.upstreamError }),
        ...(state.disabled ? { disabled: true } : {}),
        truncated: false,
        providers: curatedSummaries(),
      };
    }
    const { providers, truncated } = catalogSummaries(state.data);
    return {
      source: state.source,
      fetched_at: state.fetchedAt,
      ...(state.upstreamError === null ? {} : { upstream_error: state.upstreamError }),
      truncated,
      providers,
    };
  }

  /**
   * One provider's detail: `null` when the id is unknown to the current
   * snapshot (or to the seed table while there is no snapshot). The
   * server decides 404 vs 503 from the summary's `source`.
   */
  async provider(id: string): Promise<CatalogDetail | null> {
    const state = await this.load();
    const wanted = id.trim().toLowerCase();
    if (state.data !== null) {
      const detail = catalogDetail(state.data, wanted);
      if (detail === null) return null;
      return {
        source: state.source,
        fetched_at: state.fetchedAt,
        ...(state.upstreamError === null ? {} : { upstream_error: state.upstreamError }),
        provider: detail,
      };
    }
    const detail = curatedDetail(wanted);
    if (detail === null) return null;
    return {
      source: "curated",
      fetched_at: null,
      ...(state.upstreamError === null ? {} : { upstream_error: state.upstreamError }),
      ...(state.disabled ? { disabled: true } : {}),
      provider: detail,
    };
  }
}

/**
 * Deprecated alias kept for one release so existing imports compile as both a
 * value and a type.
 */
export { ModelsDevCatalog as ModelEffortCatalog };
