/**
 * Configuration introspection: the data behind `two-brothers config` and the
 * `run --dry-run` plan.
 *
 * The view answers "where did this value come from?" without ever exposing an
 * API-key value: the key field is only ever the literal `"set"` / `"not set"`.
 * Per-role precedence follows the documented chain
 * `flag > role env > shared env > preset > settings > default`
 * (`src/runtime.ts::resolveRoleEndpoints` is the server-side cousin).
 *
 * Pattern reference (ideas only, MIT, local-only research clone): opencode's
 * `packages/cli/src/commands/handlers/debug/config.ts` resolves the effective
 * config and prints a `redactConfig(...)` view; here the redaction lives in
 * the data model itself, so no renderer can leak a key.
 *
 * The module is pure: it reads no environment, filesystem, clock or cwd. The
 * caller passes everything in `ConfigViewInput` (the CLI fills `env` from
 * `process.env` and the paths from the real cwd/home); the defaults here are
 * relative placeholders so direct unit tests stay deterministic.
 */
import * as path from "node:path";

import type { Config } from "./config.ts";
import { DEFAULTS, maxTokensForRole } from "./config.ts";
import {
  DEFAULT_KEEP_RECENT_CHARS,
  DEFAULT_KEEP_RECENT_TOKENS,
  DEFAULT_RESERVE_CHARS,
  DEFAULT_RESERVE_TOKENS,
} from "./compaction.ts";
import { DEFAULT_PROVIDER_KIND } from "./provider.ts";
import type { Preset } from "./presets.ts";
import { presetApiKey } from "./presets.ts";
import { envPinnedPairs } from "./settings_store.ts";
import type { RoleSettings, SettingsSnapshot } from "./settings_store.ts";

export type RoleName = "senior" | "junior";

/** The layers that can supply a value, highest precedence first. */
export type ConfigSourceKind =
  | "flag"
  | "role-env"
  | "shared-env"
  | "preset"
  | "settings"
  | "default";

/** One value's origin. `detail` is the flag/env name or the preset/store id. */
export interface ConfigSource {
  kind: ConfigSourceKind;
  detail: string;
}

/** API keys are reported by presence only — never by value. */
export type ApiKeyState = "set" | "not set";

export interface RoleConfigView {
  role: RoleName;
  /** Effective provider family (`openai` / `mock`). */
  provider: string;
  /** Effective wire family (`openai-compatible` / `anthropic` / `google`). */
  kind: string;
  /** Effective base URL; empty means "not configured". */
  baseUrl: string;
  /** Effective model id; empty means "not configured". */
  model: string;
  /** Whether an API key resolves for this role. */
  apiKey: ApiKeyState;
  /** Origin per field, in the documented precedence order. */
  sources: {
    provider: ConfigSource;
    kind: ConfigSource;
    baseUrl: ConfigSource;
    model: ConfigSource;
    apiKey: ConfigSource;
  };
}

export interface RootView {
  path: string;
  source: ConfigSource;
}

export interface RootsView {
  paths: string[];
  source: ConfigSource;
}

export type CompactionMode = "off" | "chars" | "tokens";

export interface CompactionView {
  /** `tokens` when a context window or token threshold is set, else `chars`. */
  mode: CompactionMode;
  /** `--compact`: compact once even when under the trigger. */
  force: boolean;
  thresholdChars: number;
  thresholdTokens: number;
  contextWindow: number;
  reserveChars: number;
  reserveTokens: number;
  keepRecentChars: number;
  keepRecentTokens: number;
  summarizerRole: RoleName;
}

export interface LimitsView {
  /** Run-level output-token cap, `null` when unset. */
  maxTokens: number | null;
  /** Effective per-role caps (role override, else the run-level cap). */
  seniorMaxTokens: number | null;
  juniorMaxTokens: number | null;
  maxRounds: number;
  temperature: number;
  retries: number;
  timeoutSeconds: number;
}

export interface PinningEntry {
  role: RoleName;
  /** settings.json field name (`base_url`, `api_key`, ...). */
  field: "provider" | "base_url" | "api_key" | "model";
  env: string;
}

export interface ConfigPinningView {
  /** `(role, field)` pairs currently forced by a non-empty `TWO_BROTHERS_*` var. */
  pinned: PinningEntry[];
  notes: string[];
}

/**
 * The stable config-introspection object. Field order is fixed: JSON consumers
 * may rely on the key order (the tests snapshot the role/field keys).
 */
export interface ConfigView {
  schema: "two-brothers.config/1";
  /** Run-level provider family (roles may override it via settings). */
  provider: string;
  providerSource: ConfigSource;
  mode: Config["mode"];
  modeSource: ConfigSource;
  sessionsDir: string;
  sessionsDirSource: ConfigSource;
  settings: {
    /** Path of the settings store consulted for the preset/settings layers. */
    file: string;
    present: boolean;
  };
  roots: {
    plugins: RootView;
    skills: RootsView;
    commands: RootsView;
  };
  compaction: CompactionView;
  limits: LimitsView;
  roles: { senior: RoleConfigView; junior: RoleConfigView };
  pinning: ConfigPinningView;
  /** Non-fatal provenance notes (dangling preset refs, CLI-vs-serve layers). */
  notes: string[];
  warnings: string[];
}

/** Everything the view needs; all optional inputs have deterministic defaults. */
export interface ConfigViewInput {
  /** The resolved run config (flags + env + defaults, already validated). */
  config: Config;
  /** The environment map the CLI read the `TWO_BROTHERS_*` values from. */
  env?: NodeJS.ProcessEnv;
  /** Persisted per-role settings (`SettingsStore.read()`); keys are masked. */
  settings?: SettingsSnapshot;
  /** The parsed CLI values, keyed by flag name (`senior-model`, ...). */
  flags?: Record<string, unknown>;
  /** Preset table used to resolve a settings `provider_ref`. */
  presets?: readonly Preset[];
  /** Working directory for the default plugin/skills/commands roots. */
  cwd?: string;
  /** Home directory for the `~/.two-brothers/*` default roots. */
  homeDir?: string;
  /** Sessions directory (default `sessions`). */
  sessionsDir?: string;
  /** Settings-store path (default `<sessionsDir>/settings.json`). */
  settingsFile?: string;
  /** Whether the settings file exists; derived from `settings` when omitted. */
  settingsPresent?: boolean;
}

const ROLES: readonly RoleName[] = ["senior", "junior"];

/** Non-empty trimmed string, else "". */
function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function source(kind: ConfigSourceKind, detail: string): ConfigSource {
  return { kind, detail };
}

function settingsRole(
  settings: SettingsSnapshot,
  role: RoleName,
): RoleSettings {
  return settings[role] ?? {};
}

/**
 * The preset a role's settings `provider_ref` names, or undefined. A dangling
 * ref becomes a warning (the runtime resolver warns and falls back too).
 */
function presetFor(
  role: RoleName,
  settings: SettingsSnapshot,
  presets: readonly Preset[],
  warnings: string[],
): Preset | undefined {
  const ref = text(settingsRole(settings, role).provider_ref);
  if (!ref) return undefined;
  const found = presets.find((preset) => preset.name === ref);
  if (found === undefined) {
    warnings.push(
      `provider_ref "${ref}" for the ${role} role has no matching preset; ` +
        "the settings fields apply",
    );
  }
  return found;
}

/** A flag is "present" when parsed with a non-empty string value. */
function flagText(flags: Record<string, unknown>, name: string): string {
  return text(flags[name]);
}

/** The first flag among `names` with a non-empty value, as `[name, value]`. */
function firstFlag(
  flags: Record<string, unknown>,
  names: readonly string[],
): [string, string] | null {
  for (const name of names) {
    const value = flagText(flags, name);
    if (value) return [name, value];
  }
  return null;
}

/** The first non-empty env var among `names`, as `[name, value]`. */
function firstEnv(
  env: NodeJS.ProcessEnv,
  names: readonly string[],
): [string, string] | null {
  for (const name of names) {
    const value = text(env[name]);
    if (value) return [name, value];
  }
  return null;
}

function roleEnvName(role: RoleName, suffix: "BASE_URL" | "API_KEY" | "MODEL" | "KIND"): string {
  return `TWO_BROTHERS_${role === "senior" ? "SENIOR" : "JUNIOR"}_${suffix}`;
}

/** Effective wire family for a role, mirroring `config.ts::roleKind`. */
function fallbackKind(config: Config, role: RoleName): string {
  const own = role === "senior" ? config.seniorKind : config.juniorKind;
  return (own || config.kind || DEFAULT_PROVIDER_KIND).trim();
}

function fallbackBaseUrl(config: Config, role: RoleName): string {
  const own = role === "senior" ? config.seniorBaseUrl : config.juniorBaseUrl;
  return own || config.baseUrl;
}

function fallbackApiKey(config: Config, role: RoleName): string {
  const own = role === "senior" ? config.seniorApiKey : config.juniorApiKey;
  return own || config.apiKey;
}

function fallbackModel(config: Config, role: RoleName): string {
  return role === "senior" ? config.seniorModel : config.juniorModel;
}

/**
 * One role's effective fields and their origins. The chain is walked per
 * field in the documented order; preset values only fill a field when no
 * flag/env value exists for it, and settings (including a preset named by
 * `provider_ref`) sit above the built-in default.
 */
function buildRoleView(
  role: RoleName,
  input: ConfigViewInput,
  preset: Preset | undefined,
  warnings: string[],
): RoleConfigView {
  const config = input.config;
  const env = input.env ?? {};
  const flags = input.flags ?? {};
  const settings = input.settings ?? {};
  const settingsRoleView = settingsRole(settings, role);
  const settingsDetail =
    input.settingsFile ?? path.join(input.sessionsDir ?? "sessions", "settings.json");

  // provider: flag > shared env > settings > default (no per-role provider env).
  let provider: string;
  let providerSource: ConfigSource;
  const providerFlag = flagText(flags, "provider");
  const providerEnv = text(env.TWO_BROTHERS_PROVIDER);
  if (providerFlag) {
    provider = config.provider;
    providerSource = source("flag", "--provider");
  } else if (providerEnv) {
    provider = config.provider;
    providerSource = source("shared-env", "TWO_BROTHERS_PROVIDER");
  } else if (text(settingsRoleView.provider)) {
    provider = text(settingsRoleView.provider);
    providerSource = source("settings", settingsDetail);
  } else {
    provider = config.provider || DEFAULTS.provider;
    providerSource = source("default", "built-in");
  }

  // Connection sources, resolved once: a preset supplies its base URL/key
  // pair — and with it its wire kind — only when no flag/env pair exists,
  // mirroring the all-or-nothing env pairs of runtime.ts::resolvePair.
  const baseFlag = firstFlag(flags, [`${role}-base-url`, "base-url"]);
  const baseEnv = firstEnv(env, [roleEnvName(role, "BASE_URL"), "TWO_BROTHERS_BASE_URL"]);
  const keyFlag = firstFlag(flags, [`${role}-api-key`, "api-key"]);
  const keyEnv = firstEnv(env, [roleEnvName(role, "API_KEY"), "TWO_BROTHERS_API_KEY"]);
  const presetConnection =
    preset !== undefined &&
    baseFlag === null &&
    baseEnv === null &&
    keyFlag === null &&
    keyEnv === null;

  // kind: role flag > shared flag > role env > shared env > preset > default.
  let kind: string;
  let kindSource: ConfigSource;
  const kindFlag = firstFlag(flags, [`${role}-kind`, "provider-kind"]);
  const kindEnv = firstEnv(env, [roleEnvName(role, "KIND"), "TWO_BROTHERS_PROVIDER_KIND"]);
  if (kindFlag !== null) {
    kind = kindFlag[1];
    kindSource = source("flag", `--${kindFlag[0]}`);
  } else if (kindEnv !== null) {
    kind = kindEnv[1];
    kindSource = source(
      kindEnv[0] === roleEnvName(role, "KIND") ? "role-env" : "shared-env",
      kindEnv[0],
    );
  } else if (presetConnection && preset?.kind) {
    kind = preset.kind;
    kindSource = source("preset", preset.name);
  } else {
    kind = fallbackKind(config, role);
    kindSource = source("default", "built-in");
  }

  // base URL: role flag > shared flag > role env > shared env > preset > settings > default.
  let baseUrl: string;
  let baseUrlSource: ConfigSource;
  if (baseFlag !== null) {
    baseUrl = baseFlag[1];
    baseUrlSource = source("flag", `--${baseFlag[0]}`);
  } else if (baseEnv !== null) {
    baseUrl = baseEnv[1];
    baseUrlSource = source(
      baseEnv[0] === roleEnvName(role, "BASE_URL") ? "role-env" : "shared-env",
      baseEnv[0],
    );
  } else if (preset?.base_url) {
    baseUrl = preset.base_url;
    baseUrlSource = source("preset", preset.name);
  } else if (text(settingsRoleView.base_url)) {
    baseUrl = text(settingsRoleView.base_url);
    baseUrlSource = source("settings", settingsDetail);
  } else {
    baseUrl = fallbackBaseUrl(config, role);
    baseUrlSource = source("default", "built-in");
  }

  // model: role flag > role env > settings > default.
  let model: string;
  let modelSource: ConfigSource;
  const modelFlag = flagText(flags, `${role}-model`);
  const modelEnv = text(env[roleEnvName(role, "MODEL")]);
  if (modelFlag) {
    model = modelFlag;
    modelSource = source("flag", `--${role}-model`);
  } else if (modelEnv) {
    model = modelEnv;
    modelSource = source("role-env", roleEnvName(role, "MODEL"));
  } else if (text(settingsRoleView.model)) {
    model = text(settingsRoleView.model);
    modelSource = source("settings", settingsDetail);
  } else {
    model = fallbackModel(config, role);
    modelSource = source("default", "built-in");
  }

  // API key: same chain; the preset resolves its key's env var at use time.
  let apiKeyValue: string;
  let apiKeySource: ConfigSource;
  if (keyFlag !== null) {
    apiKeyValue = keyFlag[1];
    apiKeySource = source("flag", `--${keyFlag[0]}`);
  } else if (keyEnv !== null) {
    apiKeyValue = keyEnv[1];
    apiKeySource = source(
      keyEnv[0] === roleEnvName(role, "API_KEY") ? "role-env" : "shared-env",
      keyEnv[0],
    );
  } else if (preset !== undefined) {
    apiKeyValue = presetApiKey(preset, env);
    const envName = text(preset.api_key_env);
    apiKeySource = source(
      "preset",
      envName ? `${preset.name} (${envName})` : preset.name,
    );
  } else if (text(settingsRoleView.api_key)) {
    apiKeyValue = text(settingsRoleView.api_key);
    apiKeySource = source("settings", settingsDetail);
  } else {
    apiKeyValue = fallbackApiKey(config, role);
    apiKeySource = source("default", "built-in");
  }

  return {
    role,
    provider,
    kind,
    baseUrl,
    model,
    apiKey: apiKeyValue ? "set" : "not set",
    sources: {
      provider: providerSource,
      kind: kindSource,
      baseUrl: baseUrlSource,
      model: modelSource,
      apiKey: apiKeySource,
    },
  };
}

/** Resolve a configured root against the caller-supplied cwd (pure in `base`). */
function resolveAgainst(base: string, value: string): string {
  return path.isAbsolute(value) ? value : path.join(base, value);
}

function resolveRoot(
  flags: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  flagName: string,
  envName: string,
  cwd: string,
  fallbackName: string,
): RootView {
  const flagValue = flagText(flags, flagName);
  if (flagValue) {
    return {
      path: resolveAgainst(cwd, flagValue),
      source: source("flag", `--${flagName}`),
    };
  }
  const envValue = text(env[envName]);
  if (envValue) {
    return {
      path: resolveAgainst(cwd, envValue),
      source: source("shared-env", envName),
    };
  }
  return { path: path.join(cwd, fallbackName), source: source("default", "built-in") };
}

function pathListFlags(flags: Record<string, unknown>, name: string): string[] {
  const raw = flags[name];
  const values = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  const out: string[] = [];
  for (const value of values) {
    const dir = text(value);
    if (dir) out.push(dir);
  }
  return out;
}

function envPathList(env: NodeJS.ProcessEnv, name: string): string[] {
  const raw = text(env[name]);
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(path.delimiter)) {
    const dir = part.trim();
    if (dir) out.push(dir);
  }
  return out;
}

/**
 * The skills/commands root list, mirroring `cli.ts::skillsRootsForCli` /
 * `commandsRootsForCli`: repeatable flags, then the env path list, then
 * `<cwd>/<kind>` and `~/.two-brothers/<kind>`.
 */
function buildRoots(
  flags: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  flagName: string,
  envName: string,
  kind: "skills" | "commands",
  cwd: string,
  homeDir: string,
): RootsView {
  const flagDirs = pathListFlags(flags, flagName);
  const envDirs = envPathList(env, envName);
  const roots: string[] = [];
  const add = (dir: string): void => {
    roots.push(resolveAgainst(cwd, dir));
  };
  for (const dir of flagDirs) add(dir);
  for (const dir of envDirs) add(dir);
  add(kind);
  roots.push(path.join(homeDir, ".two-brothers", kind));
  return {
    paths: roots,
    source:
      flagDirs.length > 0
        ? source("flag", `--${flagName}`)
        : envDirs.length > 0
          ? source("shared-env", envName)
          : source("default", "built-in"),
  };
}

function buildCompaction(config: Config): CompactionView {
  const tokenMode = config.compactThresholdTokens > 0 || config.contextWindow > 0;
  const charTrigger = config.compactThreshold > 0;
  return {
    mode: tokenMode ? "tokens" : charTrigger ? "chars" : "off",
    force: config.compact,
    thresholdChars: config.compactThreshold,
    thresholdTokens: config.compactThresholdTokens,
    contextWindow: config.contextWindow,
    reserveChars: DEFAULT_RESERVE_CHARS,
    reserveTokens: DEFAULT_RESERVE_TOKENS,
    keepRecentChars:
      config.compactKeepRecent > 0 ? config.compactKeepRecent : DEFAULT_KEEP_RECENT_CHARS,
    keepRecentTokens: DEFAULT_KEEP_RECENT_TOKENS,
    summarizerRole: "senior",
  };
}

function buildLimits(config: Config): LimitsView {
  return {
    maxTokens: config.maxTokens ?? null,
    seniorMaxTokens: maxTokensForRole(config, "senior") ?? null,
    juniorMaxTokens: maxTokensForRole(config, "junior") ?? null,
    maxRounds: config.maxRounds,
    temperature: config.temperature,
    retries: config.retries,
    timeoutSeconds: config.timeout,
  };
}

function fieldLabel(field: PinningEntry["field"]): string {
  return field === "base_url" ? "base URL" : field === "api_key" ? "API key" : field;
}

function buildPinning(
  env: NodeJS.ProcessEnv,
  settingsPresent: boolean,
): ConfigPinningView {
  const pinnedPairs = envPinnedPairs(env);
  const pinned: PinningEntry[] = [];
  const add = (role: RoleName, field: PinningEntry["field"], envName: string): void => {
    if (!envName) return;
    if (!pinnedPairs.has(`${role}:${field}`)) return;
    pinned.push({ role, field, env: envName });
  };
  for (const role of ROLES) {
    add(
      role,
      "provider",
      text(env.TWO_BROTHERS_PROVIDER) ? "TWO_BROTHERS_PROVIDER" : "",
    );
    add(
      role,
      "base_url",
      text(env[roleEnvName(role, "BASE_URL")])
        ? roleEnvName(role, "BASE_URL")
        : text(env.TWO_BROTHERS_BASE_URL)
          ? "TWO_BROTHERS_BASE_URL"
          : "",
    );
    add(
      role,
      "api_key",
      text(env[roleEnvName(role, "API_KEY")])
        ? roleEnvName(role, "API_KEY")
        : text(env.TWO_BROTHERS_API_KEY)
          ? "TWO_BROTHERS_API_KEY"
          : "",
    );
    add(
      role,
      "model",
      text(env[roleEnvName(role, "MODEL")]) ? roleEnvName(role, "MODEL") : "",
    );
  }
  const notes = pinned.map(
    (entry) => `${entry.role} ${fieldLabel(entry.field)} pinned by ${entry.env}`,
  );
  if (pinned.length > 0 && settingsPresent) {
    notes.push(
      "env-pinned fields are ignored in settings.json while the variable is " +
        "set and are stripped from settings writes",
    );
  }
  return { pinned, notes };
}

/**
 * Build the stable config view. Pure: every input is explicit, and the
 * returned object contains no API-key value (only `"set"` / `"not set"`).
 */
export function buildConfigView(input: ConfigViewInput): ConfigView {
  const config = input.config;
  const env = input.env ?? {};
  const settings = input.settings ?? {};
  const flags = input.flags ?? {};
  const presets = input.presets ?? [];
  const cwd = input.cwd ?? ".";
  const homeDir = input.homeDir ?? "~";
  const warnings: string[] = [];

  const sessionsFlag = flagText(flags, "sessions-dir");
  const sessionsDir = sessionsFlag || input.sessionsDir || "sessions";
  const settingsFile = input.settingsFile ?? path.join(sessionsDir, "settings.json");
  const settingsPresent =
    input.settingsPresent ?? Object.keys(settings).length > 0;

  const providerFlag = flagText(flags, "provider");
  const providerEnv = text(env.TWO_BROTHERS_PROVIDER);
  let provider: string;
  let providerSource: ConfigSource;
  if (providerFlag) {
    provider = config.provider;
    providerSource = source("flag", "--provider");
  } else if (providerEnv) {
    provider = config.provider;
    providerSource = source("shared-env", "TWO_BROTHERS_PROVIDER");
  } else {
    provider = config.provider || DEFAULTS.provider;
    providerSource = source("default", "built-in");
  }

  const modeFlag = flags.mode;
  const envMode = text(env.TWO_BROTHERS_MODE);
  let mode: Config["mode"];
  let modeSource: ConfigSource;
  if (
    modeFlag === "consult" ||
    modeFlag === "work" ||
    modeFlag === "auto"
  ) {
    mode = modeFlag;
    modeSource = source("flag", "--mode");
  } else if (envMode === "consult" || envMode === "work" || envMode === "auto") {
    mode = envMode;
    modeSource = source("shared-env", "TWO_BROTHERS_MODE");
  } else {
    mode = config.mode;
    modeSource = source("default", "built-in");
  }

  const roles = {
    senior: buildRoleView(
      "senior",
      { ...input, env, settings, flags, presets, settingsFile },
      presetFor("senior", settings, presets, warnings),
      warnings,
    ),
    junior: buildRoleView(
      "junior",
      { ...input, env, settings, flags, presets, settingsFile },
      presetFor("junior", settings, presets, warnings),
      warnings,
    ),
  };

  const compaction = buildCompaction(config);
  const limits = buildLimits(config);
  const pinning = buildPinning(env, settingsPresent);

  const notes: string[] = [];
  const usesStoreLayers = ROLES.some((role) => {
    const sources = roles[role].sources;
    return Object.values(sources).some(
      (entry) => entry.kind === "settings" || entry.kind === "preset",
    );
  });
  if (usesStoreLayers) {
    notes.push(
      "preset/settings layers come from the serve settings store; " +
        "run/chat/tui resolve flags > TWO_BROTHERS_* env > defaults",
    );
  }
  if (warnings.length > 0) notes.push(...warnings);

  return {
    schema: "two-brothers.config/1",
    provider,
    providerSource,
    mode,
    modeSource,
    sessionsDir,
    sessionsDirSource: sessionsFlag
      ? source("flag", "--sessions-dir")
      : source("default", "built-in"),
    settings: { file: settingsFile, present: settingsPresent },
    roots: {
      plugins: resolveRoot(
        flags,
        env,
        "plugins-dir",
        "TWO_BROTHERS_PLUGINS_DIR",
        cwd,
        "plugins",
      ),
      skills: buildRoots(
        flags,
        env,
        "skills-dir",
        "TWO_BROTHERS_SKILLS_DIR",
        "skills",
        cwd,
        homeDir,
      ),
      commands: buildRoots(
        flags,
        env,
        "commands-dir",
        "TWO_BROTHERS_COMMANDS_DIR",
        "commands",
        cwd,
        homeDir,
      ),
    },
    compaction,
    limits,
    roles,
    pinning,
    notes,
    warnings,
  };
}

/** One source as the human table's `source` column: `flag --senior-model`. */
export function sourceLabel(entry: ConfigSource): string {
  if (entry.kind === "default") return "default";
  if (entry.kind === "flag") return `flag ${entry.detail}`;
  if (entry.kind === "role-env") return `role env ${entry.detail}`;
  if (entry.kind === "shared-env") return `shared env ${entry.detail}`;
  if (entry.kind === "preset") return `preset ${entry.detail}`;
  return `settings ${entry.detail}`;
}

function pad(textValue: string, width: number): string {
  const value = textValue.length > width ? textValue.slice(0, width) : textValue;
  return value.padEnd(width, " ");
}

/**
 * The human `two-brothers config` output: an aligned role table with a
 * `source` column, then the non-role view (mode, roots, compaction, limits,
 * pinning notes). Never prints a key value.
 */
export function renderConfigView(view: ConfigView): string[] {
  const rows: Array<[string, string, string, string]> = [];
  for (const role of ROLES) {
    const entry = view.roles[role];
    rows.push([role, "provider", entry.provider, sourceLabel(entry.sources.provider)]);
    rows.push([role, "kind", entry.kind, sourceLabel(entry.sources.kind)]);
    rows.push([
      role,
      "base-url",
      entry.baseUrl || "(unset)",
      sourceLabel(entry.sources.baseUrl),
    ]);
    rows.push([
      role,
      "model",
      entry.model || "(unset)",
      sourceLabel(entry.sources.model),
    ]);
    rows.push([role, "api-key", entry.apiKey, sourceLabel(entry.sources.apiKey)]);
  }
  const header: [string, string, string, string] = ["role", "field", "value", "source"];
  const widths = header.map((label, column) =>
    Math.max(label.length, ...rows.map((row) => row[column].length)),
  );
  const formatRow = (row: readonly string[]): string =>
    row.map((value, column) => pad(value, widths[column])).join("  ").trimEnd();

  const lines: string[] = [
    "Two Brothers — resolved configuration",
    "precedence: flag > role env > shared env > preset > settings > default",
    `settings: ${view.settings.file} (${view.settings.present ? "present" : "absent"})`,
    "",
    formatRow(header),
    ...rows.map((row) => formatRow(row)),
    "",
    `mode: ${view.mode} (${sourceLabel(view.modeSource)})`,
    `provider: ${view.provider} (${sourceLabel(view.providerSource)})`,
    `sessions: ${view.sessionsDir} (${sourceLabel(view.sessionsDirSource)})`,
    "",
    "roots:",
    `  plugins:  ${view.roots.plugins.path} (${sourceLabel(view.roots.plugins.source)})`,
    `  skills:   ${view.roots.skills.paths.join(", ")} (${sourceLabel(view.roots.skills.source)})`,
    `  commands: ${view.roots.commands.paths.join(", ")} (${sourceLabel(view.roots.commands.source)})`,
    "",
    "compaction:",
    `  mode: ${view.compaction.mode}${view.compaction.force ? " (forced once)" : ""}`,
    `  threshold-chars: ${view.compaction.thresholdChars} (0 = off)`,
    `  threshold-tokens: ${view.compaction.thresholdTokens} (0 = unset)`,
    `  context-window: ${view.compaction.contextWindow} (0 = unknown)`,
    `  reserve: ${view.compaction.reserveChars} chars / ${view.compaction.reserveTokens} tokens`,
    `  keep-recent: ${view.compaction.keepRecentChars} chars / ` +
      `${view.compaction.keepRecentTokens} tokens`,
    `  summarizer role: ${view.compaction.summarizerRole}`,
    "",
    "limits:",
    `  max-tokens: ${view.limits.maxTokens === null ? "(unset)" : String(view.limits.maxTokens)} ` +
      `(senior ${view.limits.seniorMaxTokens ?? "unset"}, ` +
      `junior ${view.limits.juniorMaxTokens ?? "unset"})`,
    `  retries: ${view.limits.retries}   timeout: ${view.limits.timeoutSeconds}s   ` +
      `max-rounds: ${view.limits.maxRounds}   temperature: ${view.limits.temperature}`,
  ];

  lines.push("", "pinning:");
  if (view.pinning.notes.length === 0) {
    lines.push("  (none)");
  } else {
    for (const note of view.pinning.notes) lines.push(`  - ${note}`);
  }
  if (view.notes.length > 0) {
    lines.push("", "notes:");
    for (const note of view.notes) lines.push(`  - ${note}`);
  }
  return lines;
}
