/**
 * TUI provider connection state: the persisted settings, the effective
 * per-role endpoints and the `/provider` save path.
 *
 * The TUI used to build role endpoints from CLI flags/env only, so a provider
 * configured by the web Settings, `two-brothers onboard` or a previous `serve`
 * (persisted in `<sessionsDir>/settings.json`, API keys encrypted at rest) was
 * silently ignored and a turn hit the default endpoint. This module reads the
 * same `SettingsStore` the backend uses and resolves the same effective
 * per-role endpoints with `runtime.ts::resolveRoleEndpoints`, so the TUI, the
 * web workspace and the API produce the same connection.
 *
 * Precedence (the operator's most explicit request first):
 *
 *   1. `TWO_BROTHERS_*` env pairs (`TWO_BROTHERS_SENIOR_BASE_URL`/`_API_KEY`,
 *      then the shared `TWO_BROTHERS_BASE_URL`/`_API_KEY`) — all-or-nothing,
 *      exactly like `serve`; env-pinned fields are never persisted by the
 *      store.
 *   2. Explicit CLI flags (`--base-url`/`--api-key`, the per-role
 *      `--senior-*`/`--junior-*` flags, `--provider`, `--senior-model`/
 *      `--junior-model`) — also all-or-nothing per pair. The resolved `Config`
 *      already merged flags > env, so a non-empty connection field is an
 *      explicit request; the only ambiguity left is when a flag repeats a
 *      default value (e.g. `--provider openai`), which is a no-op anyway.
 *   3. Persisted role settings (manual fields, or a named `provider_ref` that
 *      resolves through the merged seed+stored preset table).
 *   4. Built-in seed presets (`presets.ts`) through the resolver's preset
 *      lookup, and finally the harness's per-field run-config fallback.
 *
 * Security: API keys are only carried in memory for provider construction and
 * storage writes. Everything this module exposes for display is a
 * {@link ProviderRoleSummary}/{@link ProviderPresetChoice} with
 * `apiKeySet: boolean` and no key material — the value is never formatted,
 * logged, echoed into the transcript, or put into prompt history.
 */
import * as path from "node:path";

import { DEFAULTS, type Config } from "../config.ts";
import { mergeSeedPresets, presetApiKey, presetById, type Preset } from "../presets.ts";
import { DEFAULT_PROVIDER_KIND } from "../provider.ts";
import {
  resolveRoleEndpoints,
  RuntimeSettings,
  type RoleEndpoint,
  type RoleEndpoints,
  type RuntimeSettingsSnapshot,
} from "../runtime.ts";
import {
  envPinnedPairs,
  SettingsStore,
  type ProviderPreset,
} from "../settings_store.ts";

// --------------------------------------------------------------------------- //
// load + resolve
// --------------------------------------------------------------------------- //

/** One role's effective connection as the TUI shows it (never the key value). */
export interface ProviderRoleSummary {
  role: "senior" | "junior";
  /** Display label ("Senior" / "Junior"). */
  label: "Senior" | "Junior";
  /** Effective provider implementation (`openai` / `mock`). */
  provider: string;
  /** Effective model id ('' when unset). */
  model: string;
  /** Effective base URL ('' when unset). */
  baseUrl: string;
  /** Effective wire family (preset kind, else the run-config kind chain). */
  kind: string;
  /** True when a stored/env-backed/preset key resolves — never the value. */
  apiKeySet: boolean;
  /** Persisted `provider_ref` currently in effect ('' for manual fields). */
  providerRef: string;
  /** Role fields currently forced by `TWO_BROTHERS_*` env vars. */
  pinned: string[];
}

/** One selectable provider preset (seed or stored override) for the dialog. */
export interface ProviderPresetChoice {
  name: string;
  kind: string;
  baseUrl: string;
  /** True when the preset resolves an API key (seed env var or stored key). */
  apiKeySet: boolean;
  models: string[];
  /** Built-in seed name (vs an operator-created preset). */
  seed: boolean;
}

/** One pickable model id plus the preset that advertises it. */
export interface ProviderModelChoice {
  model: string;
  preset: string;
  seed: boolean;
}

/** Effective provider state the TUI holds for one process. */
export interface TuiProviderState {
  /** Persisted role snapshot (decrypted keys included — never display this). */
  snapshot: RuntimeSettingsSnapshot;
  /** Seed presets with stored overrides layered on top (keys resolved). */
  presets: Preset[];
  /** Effective endpoints handed to the harness / provider construction. */
  endpoints: RoleEndpoints;
  /** Non-fatal resolution warnings (dangling refs, …) — shown honestly. */
  warnings: string[];
  /** Set when the settings file could not be read (fail-soft, never thrown). */
  loadError?: string;
}

/** Inputs for the pure resolution step (tests drive these directly). */
export interface ResolveTuiProviderOptions {
  snapshot: RuntimeSettingsSnapshot;
  storedPresets: readonly ProviderPreset[];
  cfg: Config;
  env?: NodeJS.ProcessEnv;
  /** `/models` picker choices for this TUI process; never persisted. */
  modelOverrides?: Partial<Record<"senior" | "junior", string>>;
  /** Fail-soft load note carried into the state. */
  loadError?: string;
}

/** An empty persisted snapshot (used after a corrupt/missing store read). */
export function emptyRuntimeSnapshot(): RuntimeSettingsSnapshot {
  const emptyRole = (): RuntimeSettingsSnapshot["senior"] => ({
    provider: "",
    model: "",
    base_url: "",
    api_key: "",
    provider_ref: "",
  });
  return { senior: emptyRole(), junior: emptyRole() };
}

/** `sessions/settings.json` for a TUI sessions directory. */
export function providerSettingsPath(sessionsDir: string): string {
  return path.join(sessionsDir, "settings.json");
}

/** The store the TUI resolves from and persists `/provider` changes through. */
export function createProviderStore(sessionsDir: string): SettingsStore {
  return new SettingsStore(providerSettingsPath(sessionsDir));
}

function copySnapshot(snapshot: RuntimeSettingsSnapshot): RuntimeSettingsSnapshot {
  const role = (value: RuntimeSettingsSnapshot["senior"]): RuntimeSettingsSnapshot["senior"] => ({
    provider: value.provider ?? "",
    model: value.model ?? "",
    base_url: value.base_url ?? "",
    api_key: value.api_key ?? "",
    provider_ref: value.provider_ref ?? "",
  });
  return { senior: role(snapshot.senior), junior: role(snapshot.junior) };
}

/**
 * Apply the `TWO_BROTHERS_*` env overlay exactly like `serve`'s
 * `applyEnvOverrides`: env values win over the persisted snapshot, and a
 * connection env pair is all-or-nothing (it also clears the `provider_ref`, so
 * the resolver cannot pair a preset key with an env URL).
 */
function applyEnvOverlay(
  snapshot: RuntimeSettingsSnapshot,
  env: NodeJS.ProcessEnv,
): RuntimeSettingsSnapshot {
  const out = copySnapshot(snapshot);
  const provider = env.TWO_BROTHERS_PROVIDER;
  if (provider === "openai" || provider === "mock") {
    out.senior.provider = provider;
    out.junior.provider = provider;
  }
  const sharedBase = env.TWO_BROTHERS_BASE_URL ?? "";
  const sharedKey = env.TWO_BROTHERS_API_KEY ?? "";
  for (const role of ["senior", "junior"] as const) {
    const prefix = role === "senior" ? "TWO_BROTHERS_SENIOR" : "TWO_BROTHERS_JUNIOR";
    const roleBase = env[`${prefix}_BASE_URL`] ?? "";
    const roleKey = env[`${prefix}_API_KEY`] ?? "";
    if (roleBase || roleKey) {
      out[role].base_url = roleBase;
      out[role].api_key = roleKey;
      out[role].provider_ref = "";
    } else if (sharedBase || sharedKey) {
      out[role].base_url = sharedBase;
      out[role].api_key = sharedKey;
      out[role].provider_ref = "";
    }
    const model = env[`${prefix}_MODEL`];
    if (model) out[role].model = model;
  }
  return out;
}

/**
 * Apply the resolved `Config` explicit sources on top of the env overlay.
 * `Config` already merged flags > env, so a non-empty connection field is an
 * operator request; role flags beat the shared pair (the CLI's
 * `seniorBaseUrl || baseUrl` order). A pair also clears `provider_ref` for the
 * same reason as env: a preset key must never travel with a foreign URL.
 */
function applyExplicitConfigOverlay(
  snapshot: RuntimeSettingsSnapshot,
  cfg: Config,
  overrides?: Partial<Record<"senior" | "junior", string>>,
): RuntimeSettingsSnapshot {
  const out = copySnapshot(snapshot);
  const sharedSet = cfg.baseUrl !== "" || cfg.apiKey !== "";
  const seniorSet = cfg.seniorBaseUrl !== "" || cfg.seniorApiKey !== "";
  const juniorSet = cfg.juniorBaseUrl !== "" || cfg.juniorApiKey !== "";
  if (sharedSet) {
    for (const role of ["senior", "junior"] as const) {
      out[role].base_url = cfg.baseUrl;
      out[role].api_key = cfg.apiKey;
      out[role].provider_ref = "";
    }
  }
  if (seniorSet) {
    out.senior.base_url = cfg.seniorBaseUrl;
    out.senior.api_key = cfg.seniorApiKey;
    out.senior.provider_ref = "";
  }
  if (juniorSet) {
    out.junior.base_url = cfg.juniorBaseUrl;
    out.junior.api_key = cfg.juniorApiKey;
    out.junior.provider_ref = "";
  }
  // An explicit run-level provider (`--provider mock`, `TWO_BROTHERS_PROVIDER`)
  // is a direct operator request and beats persisted role providers. The
  // default provider is not an explicit request, so persisted values survive.
  if (cfg.provider !== DEFAULTS.provider) {
    out.senior.provider = cfg.provider;
    out.junior.provider = cfg.provider;
  }
  // Explicit role models (flags/env) beat persisted models; then the current
  // session's `/models` choice (still the operator's request).
  for (const role of ["senior", "junior"] as const) {
    const flagged = role === "senior" ? cfg.seniorModel : cfg.juniorModel;
    if (flagged !== "") out[role].model = flagged;
  }
  if (overrides) {
    for (const role of ["senior", "junior"] as const) {
      const override = overrides[role];
      if (override !== undefined && override !== "") out[role].model = override;
    }
  }
  return out;
}

/**
 * Merge seed and stored presets like the server's `mergedPresets`: a stored
 * preset with no key of its own keeps the seed's `api_key_env` (so editing a
 * seed's models does not silently drop its env-backed key).
 */
export function mergeTuiPresets(stored: readonly ProviderPreset[]): Preset[] {
  return mergeSeedPresets(stored).map((preset) => {
    if (preset.api_key || preset.api_key_env) return preset;
    const seed = presetById(preset.name);
    return seed?.api_key_env ? { ...preset, api_key_env: seed.api_key_env } : preset;
  });
}

/** Presets with each key resolved for the resolver (never display these). */
function resolvablePresets(
  presets: readonly Preset[],
  env: NodeJS.ProcessEnv,
): Array<{ name: string; base_url: string; api_key: string; kind: string }> {
  return presets.map((preset) => ({
    name: preset.name,
    base_url: preset.base_url,
    api_key: presetApiKey(preset, env),
    kind: preset.kind,
  }));
}

/**
 * Pure effective-state resolution: persisted snapshot + env + explicit
 * `Config` → the same per-role endpoints `serve` would build.
 */
export function resolveTuiProviderState(options: ResolveTuiProviderOptions): TuiProviderState {
  const env = options.env ?? process.env;
  const presets = mergeTuiPresets(options.storedPresets);
  const snapshot = applyExplicitConfigOverlay(
    applyEnvOverlay(options.snapshot, env),
    options.cfg,
    options.modelOverrides,
  );
  const endpoints = resolveRoleEndpoints(
    snapshot,
    resolvablePresets(presets, env),
    // The env tier is already folded into the snapshot above (all-or-nothing
    // pairing included), so the resolver must not read the env a second time.
    {},
    {
      provider: options.cfg.provider,
      seniorModel: options.cfg.seniorModel,
      juniorModel: options.cfg.juniorModel,
    },
  );
  return {
    snapshot,
    presets,
    endpoints,
    warnings: [...endpoints.warnings],
    ...(options.loadError !== undefined ? { loadError: options.loadError } : {}),
  };
}

/**
 * Read the TUI's persisted settings and resolve the effective endpoints.
 * Fail-soft by design: a missing/corrupt/unreadable store yields the empty
 * snapshot (flags/env still apply) and an honest `loadError` — the TUI never
 * crashes because of provider settings.
 */
export function loadTuiProviderState(options: {
  store: SettingsStore;
  cfg: Config;
  env?: NodeJS.ProcessEnv;
  modelOverrides?: Partial<Record<"senior" | "junior", string>>;
}): TuiProviderState {
  let snapshot: RuntimeSettingsSnapshot = emptyRuntimeSnapshot();
  let storedPresets: ProviderPreset[] = [];
  let loadError: string | undefined;
  try {
    snapshot = new RuntimeSettings(options.store).snapshot();
  } catch (exc) {
    loadError = `cannot read role settings: ${messageOf(exc)}`;
  }
  try {
    storedPresets = options.store.readProviders();
  } catch (exc) {
    loadError ??= `cannot read provider presets: ${messageOf(exc)}`;
  }
  return resolveTuiProviderState({
    snapshot,
    storedPresets,
    cfg: options.cfg,
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.modelOverrides !== undefined ? { modelOverrides: options.modelOverrides } : {}),
    ...(loadError !== undefined ? { loadError } : {}),
  });
}

function messageOf(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

// --------------------------------------------------------------------------- //
// display views (redacted)
// --------------------------------------------------------------------------- //

/** The wire family a role actually uses (endpoint kind, else the cfg chain). */
export function effectiveProviderKind(
  endpoint: Pick<RoleEndpoint, "kind"> | undefined,
  cfg: Pick<Config, "kind" | "seniorKind" | "juniorKind">,
  role: "senior" | "junior",
): string {
  const roleKind = (role === "senior" ? cfg.seniorKind : cfg.juniorKind) || cfg.kind;
  return (endpoint?.kind || roleKind || DEFAULT_PROVIDER_KIND).trim() || DEFAULT_PROVIDER_KIND;
}

/** Role fields pinned by `TWO_BROTHERS_*` env vars, in display order. */
export function pinnedFields(
  role: "senior" | "junior",
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const pinned = envPinnedPairs(env);
  return (["provider", "model", "base_url", "api_key"] as const).filter((field) =>
    pinned.has(`${role}:${field}`),
  );
}

/** The shared per-field run-config fallbacks a role endpoint still inherits. */
function configFallback(
  cfg: Config,
  role: "senior" | "junior",
): { provider: string; baseUrl: string; apiKey: string; model: string } {
  return {
    provider: cfg.provider,
    baseUrl: role === "senior" ? cfg.seniorBaseUrl || cfg.baseUrl : cfg.juniorBaseUrl || cfg.baseUrl,
    apiKey: role === "senior" ? cfg.seniorApiKey || cfg.apiKey : cfg.juniorApiKey || cfg.apiKey,
    model: role === "senior" ? cfg.seniorModel : cfg.juniorModel,
  };
}

/**
 * Redacted per-role view for the status bar, the settings dialog and the
 * `/provider` summary. The API key is reduced to `apiKeySet`; the value never
 * appears in this object.
 */
export function providerRoleSummary(
  state: TuiProviderState,
  cfg: Config,
  role: "senior" | "junior",
  env: NodeJS.ProcessEnv = process.env,
): ProviderRoleSummary {
  const endpoint = state.endpoints[role];
  const fallback = configFallback(cfg, role);
  return {
    role,
    label: role === "senior" ? "Senior" : "Junior",
    provider: endpoint.provider || fallback.provider || DEFAULTS.provider,
    model: endpoint.model || fallback.model,
    baseUrl: endpoint.baseUrl || fallback.baseUrl,
    kind: effectiveProviderKind(endpoint, cfg, role),
    apiKeySet: Boolean(endpoint.apiKey || fallback.apiKey),
    providerRef: state.snapshot[role].provider_ref ?? "",
    pinned: pinnedFields(role, env),
  };
}

/** Both role summaries in display order (Senior first). */
export function providerRoleSummaries(
  state: TuiProviderState,
  cfg: Config,
  env: NodeJS.ProcessEnv = process.env,
): [ProviderRoleSummary, ProviderRoleSummary] {
  return [
    providerRoleSummary(state, cfg, "senior", env),
    providerRoleSummary(state, cfg, "junior", env),
  ];
}

/** True when a role's effective model is actually configured (or mock). */
export function providerRoleConfigured(summary: ProviderRoleSummary): boolean {
  return summary.provider === "mock" || (summary.baseUrl !== "" && summary.model !== "");
}

/** Selectable presets for the dialog (seed order with stored overrides in place). */
export function providerPresetChoices(
  state: TuiProviderState,
  env: NodeJS.ProcessEnv = process.env,
): ProviderPresetChoice[] {
  return state.presets.map((preset) => ({
    name: preset.name,
    kind: preset.kind || DEFAULT_PROVIDER_KIND,
    baseUrl: preset.base_url,
    apiKeySet: Boolean(presetApiKey(preset, env)),
    models: [...preset.models],
    seed: presetById(preset.name) !== undefined,
  }));
}

/** Unique model ids advertised by the merged presets, preset order preserved. */
export function providerModelChoices(
  state: TuiProviderState,
  presetName?: string,
): ProviderModelChoice[] {
  const wanted = presetName?.trim().toLowerCase();
  const out: ProviderModelChoice[] = [];
  const seen = new Set<string>();
  for (const preset of state.presets) {
    if (wanted !== undefined && wanted !== "" && preset.name.toLowerCase() !== wanted) continue;
    for (const raw of preset.models) {
      const model = raw.trim();
      if (!model || seen.has(model)) continue;
      seen.add(model);
      out.push({ model, preset: preset.name, seed: presetById(preset.name) !== undefined });
    }
  }
  return out;
}

/**
 * Multi-line, key-free connection summary for the Settings dialog / `/provider`
 * overview: one block per role plus the preset count.
 */
export function providerSummaryLines(
  state: TuiProviderState,
  cfg: Config,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const lines: string[] = [];
  for (const summary of providerRoleSummaries(state, cfg, env)) {
    lines.push(
      `${summary.label.toUpperCase()} · ${summary.provider} · ${
        summary.model || "(no model)"
      } · ${summary.kind}`,
    );
    lines.push(
      `  ${summary.baseUrl || "(no base URL)"} · API key: ${
        summary.apiKeySet ? "set" : "not set"
      }${summary.providerRef !== "" ? ` · preset: ${summary.providerRef}` : ""}`,
    );
    if (summary.pinned.length > 0) {
      lines.push(`  pinned by env: ${summary.pinned.join(", ")}`);
    }
  }
  const presets = providerPresetChoices(state, env);
  const stored = presets.filter((preset) => !preset.seed).length;
  lines.push("");
  lines.push(
    `${presets.length} provider preset(s) available` +
      (stored > 0 ? ` (${stored} custom)` : "") +
      " — press p or run /provider to connect.",
  );
  if (state.warnings.length > 0) lines.push(`warning: ${state.warnings[0]}`);
  if (state.loadError !== undefined) lines.push(`settings error: ${state.loadError}`);
  return lines;
}

// --------------------------------------------------------------------------- //
// /provider save path (the same atomic store the backend uses)
// --------------------------------------------------------------------------- //

/** A named-preset connect: `provider_ref` plus the chosen model. */
export interface ConnectViaPreset {
  name: string;
  model: string;
}

/** A manual connect: fields written to the role, `provider_ref` cleared. */
export interface ConnectManual {
  provider?: string;
  baseUrl: string;
  model: string;
  /** Empty/absent keeps the currently stored key (never type-blanks a key). */
  apiKey?: string;
}

/** One `/provider` save request. */
export interface ProviderConnectRequest {
  role: "senior" | "junior";
  preset?: ConnectViaPreset;
  manual?: ConnectManual;
}

/** Outcome of a `/provider` save; a failure changed nothing on disk. */
export interface ProviderConnectResult {
  ok: boolean;
  error?: string;
  state?: TuiProviderState;
  warnings?: string[];
}

const VALID_PROVIDERS: readonly string[] = ["openai", "mock"];

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Persist one `/provider` connection through `RuntimeSettings.update` (one
 * atomic `SettingsStore.write`: temp file + rename, keys sealed in one
 * secretbox batch, env-pinned fields stripped). Validation happens before any
 * mutation, and a failed write leaves the persisted document untouched — the
 * caller keeps showing the previous state.
 */
export function saveTuiProviderConnection(
  store: SettingsStore,
  request: ProviderConnectRequest,
  options: {
    cfg: Config;
    env?: NodeJS.ProcessEnv;
    modelOverrides?: Partial<Record<"senior" | "junior", string>>;
  },
): ProviderConnectResult {
  const env = options.env ?? process.env;
  const role = request.role === "junior" ? "junior" : "senior";
  // Validate everything BEFORE touching the store: one update == one write.
  let patch: Record<string, string>;
  if (request.preset !== undefined) {
    if (request.manual !== undefined) {
      return { ok: false, error: "choose either a preset or manual fields, not both" };
    }
    const name = cleanText(request.preset.name);
    if (name === "") return { ok: false, error: "a preset name is required" };
    let presets: Preset[];
    try {
      presets = mergeTuiPresets(store.readProviders());
    } catch (exc) {
      return { ok: false, error: `cannot read provider presets: ${messageOf(exc)}` };
    }
    const preset = presets.find((candidate) => candidate.name === name);
    if (preset === undefined) return { ok: false, error: `unknown provider preset: ${name}` };
    const model = cleanText(request.preset.model);
    if (model === "") return { ok: false, error: "choose a model for the selected preset" };
    patch = { provider: "openai", provider_ref: preset.name, model };
    // The resolver reads the preset's base_url/key: do not copy them into the
    // role (an empty literal could shadow the preset and would persist a stale
    // endpoint copy). `update` skips only undefined, so the keys are absent.
  } else if (request.manual !== undefined) {
    const provider = cleanText(request.manual.provider) || "openai";
    if (!VALID_PROVIDERS.includes(provider)) {
      return { ok: false, error: `invalid provider: ${provider} (use openai|mock)` };
    }
    const baseUrl = cleanText(request.manual.baseUrl);
    if (baseUrl === "") return { ok: false, error: "Base URL must not be empty." };
    if (!/^https?:\/\//i.test(baseUrl)) {
      return { ok: false, error: "Base URL must start with http:// or https://." };
    }
    const model = cleanText(request.manual.model);
    if (model === "") return { ok: false, error: "Model must not be empty." };
    const apiKey = cleanText(request.manual.apiKey);
    if (apiKey !== "" && envPinnedPairs(env).has(`${role}:api_key`)) {
      // Honest: env wins and the store would strip the value anyway.
      return {
        ok: false,
        error: `${role} API key is pinned by a TWO_BROTHERS_* env var and cannot be changed here`,
      };
    }
    patch = {
      provider,
      provider_ref: "",
      base_url: baseUrl,
      model,
      ...(apiKey !== "" ? { api_key: apiKey } : {}),
    };
  } else {
    return { ok: false, error: "choose a provider preset or enter manual connection fields" };
  }

  try {
    new RuntimeSettings(store).update({ [role]: patch });
  } catch (exc) {
    return { ok: false, error: `cannot save provider settings: ${messageOf(exc)}` };
  }
  const state = loadTuiProviderState({
    store,
    cfg: options.cfg,
    env,
    ...(options.modelOverrides !== undefined ? { modelOverrides: options.modelOverrides } : {}),
  });
  return { ok: true, state, warnings: [...state.warnings] };
}

// --------------------------------------------------------------------------- //
// failure guidance
// --------------------------------------------------------------------------- //

const CONNECTION_ERROR_PATTERN =
  /cannot reach|fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE|socket hang up|getaddrinfo|network error|timed out|timeout/i;

/** True when a turn failure reads like a provider connection problem. */
export function isProviderConnectionError(message: string): boolean {
  return CONNECTION_ERROR_PATTERN.test(message);
}

/**
 * Post-failure guidance for a turn whose provider could not be reached. `null`
 * when the failure is not connection-shaped (the caller keeps its generic
 * error copy); the provider error itself always stays visible.
 */
export function providerFailureHint(message: string): string | null {
  if (!isProviderConnectionError(message)) return null;
  return (
    "Provider connection failed — run /provider to connect a provider (saved " +
    "with the same settings the web Settings use), or start the TUI with " +
    "--base-url/--api-key (or --senior-base-url/--junior-base-url)."
  );
}
