/**
 * Seeded provider presets: a curated table of well-known OpenAI-compatible
 * (and native Anthropic / Gemini) endpoints, so a fresh install can offer
 * "OpenAI / DeepSeek / OpenRouter / LM Studio / …" without the operator
 * typing a base URL first.
 *
 * Shape: one `Preset` matches the persisted `ProviderPreset`
 * (`settings_store.ts`: `name`, `base_url`, `api_key`, `kind`, `models`) with
 * one additive field — `api_key_env`, the NAME of the environment variable
 * that holds the key. Seeds never carry a literal key (`api_key` stays "");
 * `presetApiKey()` resolves the variable at use time. A seed's `name` is also
 * its id: `settings.provider_ref` matches presets by `name`.
 *
 * Seeds are defaults, never stored state. User-defined presets with the same
 * name override the seed; deleting such a preset restores the seed. Do NOT
 * persist seeds into `settings.json` — `mergeSeedPresets()` layers stored
 * presets on top of the seed list at read time.
 *
 * Integration TODO (server lane, `src/server.ts`): `GET /api/providers`,
 * `provider_ref` resolution and the settings write-path validation still read
 * `settingsStore.readProviders()` (stored presets only). Swap that read for
 * `mergeSeedPresets(store.readProviders())`, resolve keys through
 * `presetApiKey(preset)` and keep `publicProvider`'s masking (the resolved
 * key must never be echoed). `SettingsStore.write()` does not persist
 * `api_key_env` — a stored preset always speaks for itself, so an
 * env-backed seed that gets edited turns into a normal stored preset.
 */
import type { ProviderPreset } from "./settings_store.ts";
import { PROVIDER_KIND_DEFAULT } from "./settings_store.ts";

/** A seeded preset: the persisted shape plus the key's env-var name. */
export interface Preset extends ProviderPreset {
  /**
   * Environment variable holding this provider's API key (e.g.
   * `OPENAI_API_KEY`). Absent for local endpoints that need no key.
   */
  api_key_env?: string;
}

/**
 * The curated seed table. Order is display order: hosted providers first, the
 * local-first default after them, the custom skeleton last.
 *
 * `kind` selects the wire family: `openai-compatible` speaks
 * `/chat/completions`, `anthropic` the Messages API (`/v1/messages`) and
 * `google` Gemini's `:generateContent`. Anthropic and Gemini presets omit the
 * version segment their adapter appends (`/v1`, `/v1beta`).
 */
const SEED_PRESETS: readonly Preset[] = [
  {
    name: "openai",
    base_url: "https://api.openai.com/v1",
    api_key: "",
    api_key_env: "OPENAI_API_KEY",
    kind: "openai-compatible",
    models: ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini"],
  },
  {
    name: "deepseek",
    base_url: "https://api.deepseek.com/v1",
    api_key: "",
    api_key_env: "DEEPSEEK_API_KEY",
    kind: "openai-compatible",
    models: ["deepseek-chat", "deepseek-reasoner"],
  },
  {
    name: "anthropic",
    base_url: "https://api.anthropic.com",
    api_key: "",
    api_key_env: "ANTHROPIC_API_KEY",
    kind: "anthropic",
    models: ["claude-sonnet-4-5", "claude-opus-4-1"],
  },
  {
    name: "gemini",
    base_url: "https://generativelanguage.googleapis.com",
    api_key: "",
    api_key_env: "GEMINI_API_KEY",
    kind: "google",
    models: ["gemini-2.5-pro", "gemini-2.5-flash"],
  },
  {
    name: "openrouter",
    base_url: "https://openrouter.ai/api/v1",
    api_key: "",
    api_key_env: "OPENROUTER_API_KEY",
    kind: "openai-compatible",
    models: ["openai/gpt-4o", "deepseek/deepseek-chat", "anthropic/claude-sonnet-4"],
  },
  {
    // The local-first default (same URL `onboard` offers): LM Studio serves an
    // OpenAI-compatible API and needs no key. The model ids are the ones the
    // LM Studio transcript evidence used; `two-brothers models --base-url
    // http://localhost:1234/v1` lists what the local server actually has.
    name: "lmstudio",
    base_url: "http://localhost:1234/v1",
    api_key: "",
    kind: PROVIDER_KIND_DEFAULT,
    models: ["spark-x2.6-4b@q4_k_m", "lfm3-1.7b"],
  },
  {
    // Skeleton for anything not listed: point it at a local gateway or a
    // gateway-compatible proxy and fill in the models it serves.
    name: "custom",
    base_url: "http://localhost:1234/v1",
    api_key: "",
    api_key_env: "CUSTOM_API_KEY",
    kind: PROVIDER_KIND_DEFAULT,
    models: [],
  },
];

function copyPreset(preset: Preset): Preset {
  return { ...preset, models: [...preset.models] };
}

/** The seed list, fresh copies so callers may mutate their own view. */
export function seedPresets(): Preset[] {
  return SEED_PRESETS.map(copyPreset);
}

/** One seed by id (`name`), exact match first, then case-insensitive. */
export function presetById(id: string): Preset | undefined {
  const wanted = id.trim();
  if (!wanted) return undefined;
  const exact = SEED_PRESETS.find((preset) => preset.name === wanted);
  if (exact) return copyPreset(exact);
  const folded = wanted.toLowerCase();
  const loose = SEED_PRESETS.find((preset) => preset.name.toLowerCase() === folded);
  return loose ? copyPreset(loose) : undefined;
}

/**
 * True when `name` is a built-in seed preset id. Reuses
 * {@link presetById}'s exact-then-case-insensitive lookup, so the server's
 * `GET /api/providers` `seed` flag can never disagree with
 * {@link mergeSeedPresets} about which names are built in.
 */
export function isSeedPresetName(name: string): boolean {
  return presetById(name) !== undefined;
}

/** Seed ids in display order (for onboarding help and error messages). */
export function presetIds(): string[] {
  return SEED_PRESETS.map((preset) => preset.name);
}

/**
 * Seeds with stored user presets layered on top: a stored preset whose name
 * matches a seed (case-insensitive) replaces it in place, so user edits win
 * and ordering stays stable; stored-only presets append in their own order.
 */
export function mergeSeedPresets(stored: readonly ProviderPreset[] = []): Preset[] {
  const merged = seedPresets();
  const indexByName = new Map(merged.map((preset, i) => [preset.name.toLowerCase(), i]));
  for (const preset of stored) {
    const copy: Preset = {
      name: preset.name,
      base_url: preset.base_url,
      api_key: preset.api_key,
      kind: preset.kind || PROVIDER_KIND_DEFAULT,
      models: [...preset.models],
    };
    const index = indexByName.get(copy.name.toLowerCase());
    if (index === undefined) {
      indexByName.set(copy.name.toLowerCase(), merged.length);
      merged.push(copy);
    } else {
      merged[index] = copy;
    }
  }
  return merged;
}

/**
 * The API key for a preset at use time: its `api_key_env` variable when set,
 * else the preset's literal `api_key` (stored presets). Never logs or prints
 * the value.
 */
export function presetApiKey(
  preset: Preset,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const name = preset.api_key_env?.trim();
  if (name) {
    const value = env[name];
    if (value) return value;
  }
  return preset.api_key;
}