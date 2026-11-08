/**
 * Configuration: CLI flags > environment variables > defaults.
 * Mirrors the original prototype's config (removed 2026-11-04; see git
 * history) and PROTOCOL.md section 7.
 *
 * base_url and the models default to empty: an `openai` run fails fast with
 * a clear error until they are configured (flags/env), so no endpoint is
 * ever contacted by surprise. `mock` runs need nothing.
 */
import type { CompactionSettings } from "./compaction.ts";
import {
  ANTHROPIC_MIN_THINKING_BUDGET,
  DEFAULT_PROVIDER_KIND,
  isProviderKind,
  PROVIDER_KIND_HINT,
} from "./provider.ts";
import {
  APPROVAL_MODES,
  DEFAULT_APPROVAL_MODE,
  isApprovalMode,
  type ApprovalMode,
} from "./permissions.ts";

export interface Config {
  provider: string;
  /**
   * True when `provider` came from an explicit source — the `--provider` flag
   * or the `TWO_BROTHERS_PROVIDER` env var — instead of the built-in default.
   * `resolveConfig` records it; the TUI's provider resolution uses it so an
   * explicitly requested default-valued provider (e.g. `--provider openai`)
   * beats a persisted non-default one. A hand-built `Config` may omit it: an
   * absent flag then keeps the documented non-default heuristic.
   */
  providerExplicit?: boolean;
  /**
   * Wire family for `openai` roles (`--provider-kind`): openai-compatible,
   * anthropic or google. Role kinds win over this run-level default.
   */
  kind: string;
  /** Per-role wire family overrides (`--senior-kind` / `--junior-kind`). */
  seniorKind: string;
  juniorKind: string;
  baseUrl: string;
  apiKey: string;
  /** Stage 18 per-role endpoint overrides (CLI flags/env; never persisted). */
  seniorBaseUrl: string;
  seniorApiKey: string;
  juniorBaseUrl: string;
  juniorApiKey: string;
  seniorModel: string;
  juniorModel: string;
  seniorSystem: string;
  juniorSystem: string;
  maxRounds: number;
  temperature: number;
  timeout: number;
  retries: number;
  mode: "consult" | "work" | "auto";
  verbose: boolean;
  jsonOut: boolean;
  sessionFile: string;
  resume: boolean;
  /** `--compact`: compact the context once before the run starts. */
  compact: boolean;
  /** Auto-compact when the rendered context passes this many chars (0 = off). */
  compactThreshold: number;
  /** Chars of recent envelopes kept verbatim when compacting. */
  compactKeepRecent: number;
  /**
   * Auto-compact when the estimated transcript passes this many tokens
   * (0 = unset). Setting it — or a context window — switches compaction to
   * token mode, where the char flags are ignored.
   */
  compactThresholdTokens: number;
  /**
   * Run-level provider context window in tokens (`--context-window`). Feeds
   * compaction only: with it known, the auto trigger is
   * `contextWindow - reserveTokens` estimated tokens and budgets derive in
   * tokens. 0 = unknown (char mode unless `compactThresholdTokens` is set).
   */
  contextWindow: number;
  /**
   * Output-token cap (`--max-tokens`, env `TWO_BROTHERS_MAX_TOKENS`). Sent as
   * `max_tokens` / Anthropic `max_tokens` / Gemini `maxOutputTokens` when
   * set; undefined leaves the provider default (Anthropic's 4096).
   */
  maxTokens?: number;
  /**
   * Per-role output caps (env `TWO_BROTHERS_SENIOR_MAX_TOKENS` /
   * `TWO_BROTHERS_JUNIOR_MAX_TOKENS`). 0 = unset: the role uses
   * `maxTokens`. Applied by the CLI's provider construction; the shared
   * settings/server path carries only the run-level cap.
   */
  seniorMaxTokens: number;
  juniorMaxTokens: number;
  /**
   * Anthropic extended-thinking budget in tokens (`--thinking-budget`, env
   * `TWO_BROTHERS_THINKING_BUDGET`). 0 = unset: no `thinking` field is sent and
   * the Anthropic request stays byte-identical to before the option existed.
   * When > 0 the Anthropic Messages adapter sends
   * `thinking: {type: "enabled", budget_tokens: N}` on every request and the
   * tool loop echoes the signed thinking blocks back verbatim. Other provider
   * families ignore it. Must be at least `ANTHROPIC_MIN_THINKING_BUDGET`
   * (1024); when it does not fit under the effective `max_tokens`, the adapter
   * raises that request cap with one honest warning.
   */
  thinkingBudget: number;
  /**
   * Operator approval mode for workspace actions (`--approval-mode`, env
   * `TWO_BROTHERS_APPROVAL_MODE`). Only a surface that binds a
   * `PermissionManager` (the web `serve` runs, the TUI workspace) acts on it;
   * `ask` is the fail-closed default. Flags/env pin it — never persisted, and
   * `resolveConfig` rejects an unknown value before any run starts.
   */
  approvalMode: ApprovalMode;
}

export const DEFAULTS: Omit<Config, "seniorSystem" | "juniorSystem"> = {
  provider: "openai",
  kind: DEFAULT_PROVIDER_KIND,
  seniorKind: "",
  juniorKind: "",
  baseUrl: "",
  apiKey: "",
  seniorBaseUrl: "",
  seniorApiKey: "",
  juniorBaseUrl: "",
  juniorApiKey: "",
  seniorModel: "",
  juniorModel: "",
  maxRounds: 3,
  temperature: 0.4,
  timeout: 120,
  retries: 6,
  mode: "consult",
  verbose: false,
  jsonOut: false,
  sessionFile: "",
  resume: false,
  compact: false,
  compactThreshold: 0,
  compactKeepRecent: 40000,
  compactThresholdTokens: 0,
  contextWindow: 0,
  maxTokens: undefined,
  seniorMaxTokens: 0,
  juniorMaxTokens: 0,
  thinkingBudget: 0,
  approvalMode: DEFAULT_APPROVAL_MODE,
};

const ENV_KEYS: Record<string, string> = {
  provider: "TWO_BROTHERS_PROVIDER",
  kind: "TWO_BROTHERS_PROVIDER_KIND",
  seniorKind: "TWO_BROTHERS_SENIOR_KIND",
  juniorKind: "TWO_BROTHERS_JUNIOR_KIND",
  baseUrl: "TWO_BROTHERS_BASE_URL",
  apiKey: "TWO_BROTHERS_API_KEY",
  seniorBaseUrl: "TWO_BROTHERS_SENIOR_BASE_URL",
  seniorApiKey: "TWO_BROTHERS_SENIOR_API_KEY",
  juniorBaseUrl: "TWO_BROTHERS_JUNIOR_BASE_URL",
  juniorApiKey: "TWO_BROTHERS_JUNIOR_API_KEY",
  seniorModel: "TWO_BROTHERS_SENIOR_MODEL",
  juniorModel: "TWO_BROTHERS_JUNIOR_MODEL",
  seniorSystem: "TWO_BROTHERS_SENIOR_SYSTEM",
  juniorSystem: "TWO_BROTHERS_JUNIOR_SYSTEM",
  maxRounds: "TWO_BROTHERS_MAX_ROUNDS",
  temperature: "TWO_BROTHERS_TEMPERATURE",
  timeout: "TWO_BROTHERS_TIMEOUT",
  retries: "TWO_BROTHERS_RETRIES",
  mode: "TWO_BROTHERS_MODE",
  verbose: "TWO_BROTHERS_VERBOSE",
  jsonOut: "TWO_BROTHERS_JSON",
  sessionFile: "TWO_BROTHERS_SESSION_FILE",
  resume: "TWO_BROTHERS_RESUME",
  compact: "TWO_BROTHERS_COMPACT",
  compactThreshold: "TWO_BROTHERS_COMPACT_THRESHOLD",
  compactKeepRecent: "TWO_BROTHERS_COMPACT_KEEP_RECENT",
  compactThresholdTokens: "TWO_BROTHERS_COMPACT_THRESHOLD_TOKENS",
  contextWindow: "TWO_BROTHERS_CONTEXT_WINDOW",
  maxTokens: "TWO_BROTHERS_MAX_TOKENS",
  seniorMaxTokens: "TWO_BROTHERS_SENIOR_MAX_TOKENS",
  juniorMaxTokens: "TWO_BROTHERS_JUNIOR_MAX_TOKENS",
  thinkingBudget: "TWO_BROTHERS_THINKING_BUDGET",
  approvalMode: "TWO_BROTHERS_APPROVAL_MODE",
};

const BOOL_FIELDS = ["verbose", "jsonOut", "resume", "compact"] as const;
const INT_FIELDS = [
  "maxRounds",
  "timeout",
  "retries",
  "compactThreshold",
  "compactKeepRecent",
  "compactThresholdTokens",
  "contextWindow",
  "maxTokens",
  "seniorMaxTokens",
  "juniorMaxTokens",
  "thinkingBudget",
] as const;
const FLOAT_FIELDS = ["temperature"] as const;

function coerce(field: string, value: unknown): unknown {
  if ((BOOL_FIELDS as readonly string[]).includes(field)) {
    if (typeof value === "boolean") return value;
    return String(value).trim().toLowerCase() === "true" ||
      String(value).trim().toLowerCase() === "1" ||
      String(value).trim().toLowerCase() === "yes" ||
      String(value).trim().toLowerCase() === "on";
  }
  if ((INT_FIELDS as readonly string[]).includes(field)) return Number.parseInt(String(value), 10);
  if ((FLOAT_FIELDS as readonly string[]).includes(field)) return Number.parseFloat(String(value));
  return value;
}

export interface Args {
  [key: string]: unknown;
}

/** Raised by `validateRunConfig` — an incomplete openai run config. */
export class RunConfigError extends Error {}

/**
 * Structural endpoint view used by `openaiRoleProblem` — `RoleEndpoint`
 * (runtime.ts) is assignable. All fields optional: unset fields fall back
 * to the shared `Config` fields, mirroring Python's
 * `role_base_url or cfg.base_url`.
 */
export interface RoleEndpointView {
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  /** Preset wire flavor when the connection came from a named preset. */
  kind?: string;
}

/**
 * The wire family a role actually uses: its own kind, else the run-level
 * kind, else "openai-compatible".
 */
function roleKind(cfg: Config, role: "senior" | "junior"): string {
  return (
    (role === "senior" ? cfg.seniorKind : cfg.juniorKind) ||
    cfg.kind ||
    DEFAULT_PROVIDER_KIND
  ).trim();
}

/**
 * Readable reason an `openai`-backed role cannot start, or `null`.
 * Ports `config.openai_role_problem`. With a resolved `endpoint` (Stage 18
 * per-role endpoints) each role is checked against its own effective
 * provider/baseUrl/model, falling back per field to the shared `Config`;
 * without one the shared fields are checked, as before. Native families
 * (anthropic/google) are covered by `providerKindProblem` instead, so a role
 * is never reported by both.
 */
export function openaiRoleProblem(
  cfg: Config,
  role: "senior" | "junior",
  endpoint?: RoleEndpointView,
): string | null {
  const provider = endpoint?.provider || cfg.provider;
  if (provider !== "openai") return null;
  if (roleKind(cfg, role) !== DEFAULT_PROVIDER_KIND) return null;
  if (!(endpoint?.baseUrl || cfg.baseUrl)) {
    const roleFlag = role === "senior" ? "--senior-base-url" : "--junior-base-url";
    const roleEnv =
      role === "senior" ? "TWO_BROTHERS_SENIOR_BASE_URL" : "TWO_BROTHERS_JUNIOR_BASE_URL";
    return (
      `no base_url configured for the ${role} role — set it in the ` +
      "Settings dialog (`two-brothers serve`), or pass --base-url / " +
      `${roleFlag} / set TWO_BROTHERS_BASE_URL / ${roleEnv}`
    );
  }
  const model = endpoint?.model || (role === "senior" ? cfg.seniorModel : cfg.juniorModel);
  if (!model) {
    const modelFlag = role === "senior" ? "--senior-model" : "--junior-model";
    const modelEnv =
      role === "senior" ? "TWO_BROTHERS_SENIOR_MODEL" : "TWO_BROTHERS_JUNIOR_MODEL";
    return (
      `no model configured for the ${role} role — set it in the ` +
      `Settings dialog (\`two-brothers serve\`), or pass ${modelFlag} / ` +
      `set ${modelEnv}`
    );
  }
  return null;
}

/**
 * Readable reason an anthropic/google role cannot start, or `null`. Same
 * endpoint fallback as `openaiRoleProblem`; the message names the family so a
 * missing endpoint reads differently from a missing OpenAI one.
 */
export function providerKindProblem(
  cfg: Config,
  role: "senior" | "junior",
  endpoint?: RoleEndpointView,
): string | null {
  const provider = endpoint?.provider || cfg.provider;
  if (provider !== "openai") return null;
  // A preset's kind is intrinsic to its base_url — it wins over the
  // run-level kinds when the connection came from a preset.
  const kind = endpoint?.kind || roleKind(cfg, role);
  if (kind === DEFAULT_PROVIDER_KIND) return null;
  if (!isProviderKind(kind)) {
    return `unknown provider kind "${kind}" for the ${role} role (use ${PROVIDER_KIND_HINT})`;
  }
  if (!(endpoint?.baseUrl || cfg.baseUrl)) {
    const roleFlag = role === "senior" ? "--senior-base-url" : "--junior-base-url";
    const roleEnv =
      role === "senior" ? "TWO_BROTHERS_SENIOR_BASE_URL" : "TWO_BROTHERS_JUNIOR_BASE_URL";
    return (
      `no base_url configured for the ${role} role (provider kind ${kind}) — ` +
      "set it in the Settings dialog (`two-brothers serve`), or pass --base-url / " +
      `${roleFlag} / set TWO_BROTHERS_BASE_URL / ${roleEnv}`
    );
  }
  const model = endpoint?.model || (role === "senior" ? cfg.seniorModel : cfg.juniorModel);
  if (!model) {
    const modelFlag = role === "senior" ? "--senior-model" : "--junior-model";
    const modelEnv =
      role === "senior" ? "TWO_BROTHERS_SENIOR_MODEL" : "TWO_BROTHERS_JUNIOR_MODEL";
    return (
      `no model configured for the ${role} role (provider kind ${kind}) — ` +
      `set it in the Settings dialog (\`two-brothers serve\`), or pass ${modelFlag} / ` +
      `set ${modelEnv}`
    );
  }
  return null;
}

/**
 * The output-token cap a role should send: its own env override
 * (`TWO_BROTHERS_SENIOR/JUNIOR_MAX_TOKENS`), else the run-level
 * `--max-tokens`/`TWO_BROTHERS_MAX_TOKENS`. `undefined` = unset.
 */
export function maxTokensForRole(cfg: Config, role: "senior" | "junior"): number | undefined {
  const roleValue = role === "senior" ? cfg.seniorMaxTokens : cfg.juniorMaxTokens;
  if (Number.isFinite(roleValue) && roleValue > 0) return Math.trunc(roleValue);
  const value = cfg.maxTokens;
  return value !== undefined && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : undefined;
}

/**
 * The Anthropic extended-thinking budget a role should send. Run-level today —
 * there is no per-role thinking override — and `undefined` = unset, so the
 * request carries no `thinking` field. Kept as a per-role function so a future
 * override slots in exactly like {@link maxTokensForRole}.
 */
export function thinkingBudgetForRole(
  cfg: Config,
  _role: "senior" | "junior",
): number | undefined {
  return Number.isFinite(cfg.thinkingBudget) && cfg.thinkingBudget > 0
    ? Math.trunc(cfg.thinkingBudget)
    : undefined;
}

/**
 * Fail fast before a run: raise `RunConfigError` listing every gap, so a
 * missing base_url/model surfaces within seconds instead of reaching the
 * network. Ports `config.validate_run_config`; with per-role `endpoints`
 * each role is reported against its own effective settings (the message
 * names the misconfigured role), otherwise against the shared config.
 */
export function validateRunConfig(
  cfg: Config,
  endpoints?: Record<"senior" | "junior", RoleEndpointView | undefined>,
): void {
  const problems = (["senior", "junior"] as const)
    .flatMap((role) => [
      openaiRoleProblem(cfg, role, endpoints?.[role]),
      providerKindProblem(cfg, role, endpoints?.[role]),
    ])
    .filter((problem): problem is string => problem !== null);
  if (problems.length > 0) throw new RunConfigError(problems.join("; "));
}

export function resolveConfig(args: Args = {}): Config {
  const values: Record<string, unknown> = { ...DEFAULTS };
  // Provenance of the run-level provider: both the flag and the env var are
  // explicit operator requests, even when they repeat the built-in default.
  // The TUI needs this to distinguish `--provider openai` from no flag at all.
  const providerExplicit =
    ("provider" in args && args.provider !== undefined && args.provider !== null) ||
    (process.env.TWO_BROTHERS_PROVIDER !== undefined &&
      process.env.TWO_BROTHERS_PROVIDER !== "");

  for (const [field, envName] of Object.entries(ENV_KEYS)) {
    const raw = process.env[envName];
    if (raw === undefined || raw === "") continue;
    values[field] = coerce(field, raw);
  }

  for (const field of Object.keys(DEFAULTS)) {
    if (field in args && args[field] !== undefined && args[field] !== null) {
      values[field] = coerce(field, args[field]);
    }
  }
  if ("seniorSystem" in args && args.seniorSystem) values.seniorSystem = args.seniorSystem;
  if ("juniorSystem" in args && args.juniorSystem) values.juniorSystem = args.juniorSystem;

  const cfg = values as unknown as Config;
  cfg.providerExplicit = providerExplicit;
  if (!["consult", "work", "auto"].includes(cfg.mode)) {
    throw new Error(`invalid mode: ${cfg.mode} (use consult|work|auto)`);
  }
  if (!["openai", "mock"].includes(cfg.provider)) {
    throw new Error(`invalid provider: ${cfg.provider} (use openai|mock)`);
  }
  // A strict enum: an unknown mode would otherwise silently act like `ask` on
  // some surfaces and be ignored on others. Fail before any run starts.
  if (!isApprovalMode(cfg.approvalMode)) {
    throw new Error(
      `invalid approval mode: ${String(cfg.approvalMode)} (use ${APPROVAL_MODES.join("|")})`,
    );
  }
  // An empty per-role kind inherits the run-level kind; a non-empty one must
  // name a family we can actually speak — a typo fails here, before any run.
  for (const [field, value] of [
    ["provider kind", cfg.kind],
    ["senior provider kind", cfg.seniorKind],
    ["junior provider kind", cfg.juniorKind],
  ] as const) {
    if (value === "") continue;
    if (!isProviderKind(value)) {
      throw new Error(`invalid ${field}: ${value} (use ${PROVIDER_KIND_HINT})`);
    }
  }
  // 0 means "unset" for the env-driven per-role caps; the run-level cap is
  // optional and must be a positive integer when present.
  if (cfg.maxTokens !== undefined && (!Number.isFinite(cfg.maxTokens) || cfg.maxTokens <= 0)) {
    throw new Error(
      `invalid max tokens: ${String(cfg.maxTokens)} (use a positive integer; --max-tokens <n>)`,
    );
  }
  for (const [field, value] of [
    ["senior max tokens", cfg.seniorMaxTokens],
    ["junior max tokens", cfg.juniorMaxTokens],
  ] as const) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`invalid ${field}: ${String(value)} (use a positive integer or 0 for unset)`);
    }
  }
  // Anthropic extended thinking: 0 = unset (today's byte-identical request).
  // A set budget must be a positive integer and at least the API minimum; the
  // adapter handles the max_tokens relationship (it must exceed the budget)
  // with an honest raised-cap warning, so every surface reaches a valid
  // request without new error plumbing.
  if (!Number.isFinite(cfg.thinkingBudget) || cfg.thinkingBudget < 0) {
    throw new Error(
      `invalid thinking budget: ${String(cfg.thinkingBudget)} ` +
        "(use a positive integer or 0 for unset; --thinking-budget <n>)",
    );
  }
  if (cfg.thinkingBudget > 0 && cfg.thinkingBudget < ANTHROPIC_MIN_THINKING_BUDGET) {
    throw new Error(
      `invalid thinking budget: ${cfg.thinkingBudget} (Anthropic requires at least ` +
        `${ANTHROPIC_MIN_THINKING_BUDGET} tokens; --thinking-budget <n>)`,
    );
  }
  return cfg;
}

/**
 * Every positive compaction budget the resolved config carries, with no
 * enable gate: `force` plus the four budgets, copied only when set. Callers
 * that must act on a *manual* compaction request use this directly (the
 * budgets are meaningful even while auto compaction is off); callers that ask
 * "should this run compact at all?" use {@link compactionSettingsFromConfig}.
 */
export function compactionFieldsFromConfig(cfg: Config): CompactionSettings {
  return {
    ...(cfg.compact ? { force: true } : {}),
    ...(cfg.compactThreshold > 0 ? { thresholdChars: cfg.compactThreshold } : {}),
    ...(cfg.compactKeepRecent > 0 ? { keepRecentChars: cfg.compactKeepRecent } : {}),
    ...(cfg.compactThresholdTokens > 0 ? { thresholdTokens: cfg.compactThresholdTokens } : {}),
    ...(cfg.contextWindow > 0 ? { contextWindow: cfg.contextWindow } : {}),
  };
}

/**
 * Compaction settings derived from the resolved config — the single mapping
 * behind every auto-compaction surface (`run`/`chat`, `tui`, `serve`).
 *
 * `--compact` (and `TWO_BROTHERS_COMPACT`) becomes `force`; the budgets come
 * from {@link compactionFieldsFromConfig}, so the positive-only field mapping
 * exists once. `undefined` when nothing enables compaction is deliberate: the
 * harness then never compacted before this helper and its options stay
 * byte-identical (no default-behavior change). `keepRecentChars` alone does not
 * enable compaction — it only shapes a compaction that some trigger asked for.
 *
 * The `CompactionSettings` import is type-only, so there is no runtime import
 * cycle with `compaction.ts` (which does not import `config.ts`).
 */
export function compactionSettingsFromConfig(cfg: Config): CompactionSettings | undefined {
  if (
    !cfg.compact &&
    cfg.compactThreshold <= 0 &&
    cfg.compactThresholdTokens <= 0 &&
    cfg.contextWindow <= 0
  ) {
    return undefined;
  }
  return compactionFieldsFromConfig(cfg);
}

// ---------------------------------------------------------------------------
// provider preset seeds
// ---------------------------------------------------------------------------

/**
 * Seeded provider presets (see `src/presets.ts`): curated well-known
 * endpoints offered on top of the user's stored presets.
 *
 * The server integration is wired: `server.ts` serves
 * `mergeSeedPresets(settingsStore.readProviders())` on `GET /api/providers`,
 * uses the merged table for `provider_ref` validation/resolution and resolves
 * env-backed keys through `presetApiKey(preset)` (the key is never echoed).
 * `SettingsStore.write()` is unchanged — seeds are never persisted, so a
 * stored same-name preset overrides its seed.
 */
export {
  mergeSeedPresets,
  presetApiKey,
  presetById,
  presetIds,
  seedPresets,
  type Preset,
} from "./presets.ts";
