/**
 * Per-role runtime settings persistence (`sessions/settings.json`).
 * Ports the original prototype's settings store (removed 2026-11-04; see git
 * history).
 *
 * Follows the WorkspaceRegistry pattern: a small JSON document next to the
 * session files, loaded at startup so operator settings survive restarts.
 * API keys are stored through `secretbox` — DPAPI (`dpapi1:`) on Windows,
 * base64 + 0o600 file (`plain1:`) elsewhere — and only ever decrypted into
 * memory. `public()` masks them behind `api_key_set`.
 *
 *     read()           -> {senior: {provider, model, base_url, api_key, ...}, ...}
 *     readPlugins()    -> [name, ...]                        // one shared list
 *     readProviders()  -> [{name, base_url, api_key, kind, models}, ...]   // key decrypted
 *     write(settings, plugins?, providers?)                  // api_key in
 *         plaintext; encrypted for disk
 *
 * The top-level `plugins` section (the active plugin list) lives in the same
 * file, unencrypted — plugin names are not secret. Entries are bare
 * name/path strings or `{path, options}` objects (per-plugin settings; both
 * shapes round-trip unchanged). Plugins are
 * shared-by-default (owner decision 2026-11-03): one list feeds both brothers,
 * replacing the old per-role `{"senior": [...], "junior": [...]}` section.
 * Reading a legacy per-role section (or legacy top-level
 * `plugins_senior`/`plugins_junior` keys) merges the names into the shared
 * list (dedup, order preserved); the next write drops the old keys. The
 * `providers` section (Stage 17: named OpenAI-compatible provider presets)
 * also lives at the top level; preset `api_key` values are protected through
 * `secretbox` exactly like role API keys.
 *
 * Env pinning: Python strips `TWO_BROTHERS_*`-pinned fields in
 * `server._persistence_snapshot` because the server owns RuntimeSettings.
 * This port has no server module, so `write()` strips the pinned
 * `(role, field)` pairs itself — env values are the source of truth for
 * their fields while set and must never reach settings.json (a removed var
 * would otherwise resurrect the value from disk, and an env API key must
 * never be persisted at all).
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { defaultSecretBox, type SecretBox } from "./secretbox.ts";

const ROLES = ["senior", "junior"] as const;
type Role = (typeof ROLES)[number];
const ROLE_FIELDS = ["provider", "model", "base_url", "api_key"] as const;
type RoleField = (typeof ROLE_FIELDS)[number];

export type RoleSettings = Partial<Record<RoleField | "provider_ref", string>>;
export type SettingsSnapshot = Partial<Record<Role, RoleSettings>>;

/** One options-carrying plugin selection entry (`plugins.ts` `PluginSetting`). */
export interface PluginSelectionEntry {
  /** Plugin name or path, matched against discovered plugin names. */
  path: string;
  /** Per-plugin settings, validated against the plugin's `configSchema`. */
  options?: Record<string, unknown>;
}

/**
 * The shared active-plugin list (both brothers receive every plugin tool).
 * Entries are either a bare name/path (the historical shape) or a
 * `{path, options}` object carrying per-plugin settings; both round-trip
 * through the store unchanged and normalize to the same shape the plugin
 * manager accepts.
 */
export type PluginSelection = Array<string | PluginSelectionEntry>;

export interface ProviderPreset {
  name: string;
  base_url: string;
  api_key: string;
  /** Preset flavor; only "openai-compatible" exists today (default on read). */
  kind: string;
  /** Manual model list for the preset (model discovery is deferred; default []). */
  models: string[];
}

/** Preset `kind` default — additive field, tolerant at the boundary. */
export const PROVIDER_KIND_DEFAULT = "openai-compatible";

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.length > 0);
}

/**
 * One persisted plugin entry normalized to its shared-list form, or null when
 * it carries no usable name (`{path, options}` objects keep their options).
 */
function pluginEntry(value: unknown): string | PluginSelectionEntry | null {
  if (typeof value === "string") {
    const name = value.trim();
    return name ? name : null;
  }
  if (!isRecord(value)) return null;
  const entryPath = typeof value.path === "string" ? value.path.trim() : "";
  if (!entryPath) return null;
  return isRecord(value.options)
    ? { path: entryPath, options: { ...value.options } }
    : { path: entryPath };
}

/** Dedupe key of a selection entry (the plugin name or path). */
function pluginKey(entry: string | PluginSelectionEntry): string {
  return typeof entry === "string" ? entry : entry.path;
}

/**
 * Plugin names from one persisted value. Tolerant at the boundary: the
 * current shape is the shared list (an array); the legacy per-role object
 * (`{"senior": [...], "junior": [...]}`) is merged into that list with order
 * preserved and duplicates dropped. Anything else contributes nothing.
 * String entries stay strings; `{path, options}` entries are kept as objects
 * so per-plugin settings round-trip.
 */
function pluginNames(value: unknown): PluginSelection {
  const out: PluginSelection = [];
  const seen = new Set<string>();
  const add = (item: unknown): void => {
    const entry = pluginEntry(item);
    if (entry === null) return;
    const key = pluginKey(entry);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(entry);
  };
  if (Array.isArray(value)) {
    for (const item of value) add(item);
  } else if (isRecord(value)) {
    for (const role of ROLES) {
      const list = value[role];
      if (Array.isArray(list)) for (const item of list) add(item);
    }
  }
  return out;
}

/** Operator-facing role view — no API key material, only whether one is set. */
export interface PublicRoleSettings {
  provider: string | null;
  model: string | null;
  base_url: string | null;
  api_key_set: boolean;
  provider_ref: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function sealMany(box: SecretBox, texts: string[]): string[] {
  return texts.length > 0 ? box.sealMany(texts) : [];
}

function unsealMany(box: SecretBox, storeds: string[]): string[] {
  return storeds.length > 0 ? box.unsealMany(storeds) : [];
}

/**
 * `(role, field)` pairs currently forced by `TWO_BROTHERS_*` env vars.
 * Ports `server._env_pinned_pairs`.
 */
export function envPinnedPairs(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const pairs = new Set<string>();
  if (env.TWO_BROTHERS_PROVIDER === "openai" || env.TWO_BROTHERS_PROVIDER === "mock") {
    pairs.add("senior:provider");
    pairs.add("junior:provider");
  }
  for (const [envName, field] of [
    ["TWO_BROTHERS_BASE_URL", "base_url"],
    ["TWO_BROTHERS_API_KEY", "api_key"],
  ] as Array<[string, RoleField]>) {
    if (env[envName]) {
      pairs.add(`senior:${field}`);
      pairs.add(`junior:${field}`);
    }
  }
  if (env.TWO_BROTHERS_SENIOR_MODEL) pairs.add("senior:model");
  if (env.TWO_BROTHERS_JUNIOR_MODEL) pairs.add("junior:model");
  // Stage 18 per-role endpoint env vars pin their role's fields (the new
  // CLI flags' env equivalents) — same never-persisted rule as the shared pair.
  for (const role of ROLES) {
    const prefix = role === "senior" ? "TWO_BROTHERS_SENIOR" : "TWO_BROTHERS_JUNIOR";
    if (env[`${prefix}_BASE_URL`]) pairs.add(`${role}:base_url`);
    if (env[`${prefix}_API_KEY`]) pairs.add(`${role}:api_key`);
  }
  return pairs;
}

/** JSON-backed persistence of per-role Senior/Junior settings. */
export class SettingsStore {
  readonly filePath: string;
  private readonly secretBox: SecretBox;

  constructor(filePath: string, secretBox: SecretBox = defaultSecretBox()) {
    this.filePath = filePath;
    this.secretBox = secretBox;
  }

  private readRaw(): Record<string, unknown> {
    if (!fs.existsSync(this.filePath)) return {};
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
    } catch {
      return {}; // missing/unreadable/corrupt file starts empty
    }
    return isRecord(raw) ? raw : {};
  }

  /** Decrypted settings by role. Missing/corrupt file -> `{}`. */
  read(): SettingsSnapshot {
    const raw = this.readRaw();
    const out: SettingsSnapshot = {};
    const pending: Array<{ entry: RoleSettings }> = [];
    for (const role of ROLES) {
      const data = raw[role];
      if (!isRecord(data)) continue;
      const entry: RoleSettings = {};
      for (const field of ROLE_FIELDS) {
        const value = asNonEmptyString(data[field]);
        if (value !== undefined && field !== "api_key") entry[field] = value;
        else if (value !== undefined) {
          pending.push({ entry }); // api_key unsealed in one batch below
          entry.api_key = value; // placeholder position, overwritten after batch
        }
      }
      const ref = asNonEmptyString(data.provider_ref);
      if (ref !== undefined) entry.provider_ref = ref;
      out[role] = entry;
    }
    if (pending.length > 0) {
      const unsealed = unsealMany(this.secretBox, pending.map((p) => p.entry.api_key as string));
      pending.forEach((p, i) => {
        p.entry.api_key = unsealed[i];
      });
    }
    return out;
  }

  /**
   * The persisted shared active-plugin list (empty when absent).
   *
   * Legacy shapes are merged in fail-soft: a per-role `{senior, junior}`
   * section and top-level `plugins_senior`/`plugins_junior` keys both
   * contribute their names in senior-then-junior order, deduplicated.
   */
  readPlugins(): PluginSelection {
    const raw = this.readRaw();
    const out = pluginNames(raw.plugins);
    const seen = new Set(out.map(pluginKey));
    for (const legacyKey of ["plugins_senior", "plugins_junior"]) {
      for (const entry of pluginNames(raw[legacyKey])) {
        const key = pluginKey(entry);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(entry);
      }
    }
    return out;
  }

  /**
   * The persisted provider presets, API keys decrypted (empty when absent).
   *
   * Tolerant at the boundary: entries missing a non-empty `name` or
   * `base_url` are dropped, unknown fields are ignored.
   */
  readProviders(): ProviderPreset[] {
    const section = this.readRaw().providers;
    if (!Array.isArray(section)) return [];
    const kept: Array<{
      name: string;
      base_url: string;
      stored: string | null;
      kind: string;
      models: string[];
    }> = [];
    for (const item of section) {
      if (!isRecord(item)) continue;
      const name = asNonEmptyString(item.name);
      const baseUrl = asNonEmptyString(item.base_url);
      if (name === undefined || baseUrl === undefined) continue;
      const key = item.api_key;
      kept.push({
        name,
        base_url: baseUrl,
        stored: typeof key === "string" && key ? key : null,
        kind: asNonEmptyString(item.kind) ?? PROVIDER_KIND_DEFAULT,
        models: asStringList(item.models),
      });
    }
    const unsealed = unsealMany(
      this.secretBox,
      kept.map((k) => k.stored ?? ""),
    );
    return kept.map((k, i) => ({
      name: k.name,
      base_url: k.base_url,
      api_key: k.stored ? unsealed[i] : "",
      kind: k.kind,
      models: [...k.models],
    }));
  }

  /**
   * Persist settings; `api_key` values arrive plaintext and are encrypted
   * before touching disk (all keys of this write in one secretbox batch).
   *
   * `plugins` is the shared active-plugin list, written into the top-level
   * `plugins` section unencrypted. A legacy per-role object is still
   * accepted on write and merged into that list (fail-soft for older
   * callers). When omitted, an existing section is normalized and preserved
   * so plain role-settings saves cannot wipe it — and any legacy per-role
   * keys on disk are dropped by that save. The same preserve-when-omitted
   * rule applies to `providers` (preset list, `api_key` encrypted for disk).
   *
   * Fields currently pinned by `TWO_BROTHERS_*` env vars are stripped from
   * the roles being written — env values must never reach the file (see
   * module docstring).
   */
  write(
    settings: Record<string, unknown>,
    plugins?: unknown,
    providers?: unknown[],
  ): void {
    const raw = this.readRaw();
    const payload: Record<string, unknown> = {};
    const pinned = envPinnedPairs();
    const pending: Array<{ holder: Record<string, unknown> }> = [];

    for (const role of ROLES) {
      const data = settings[role];
      if (!isRecord(data)) continue;
      const entry: Record<string, string> = {};
      for (const field of ROLE_FIELDS) {
        const value = asNonEmptyString(data[field]);
        if (value === undefined || pinned.has(`${role}:${field}`)) continue;
        if (field === "api_key") {
          pending.push({ holder: entry }); // sealed in one batch below
        }
        entry[field] = value;
      }
      const ref = asNonEmptyString(data.provider_ref);
      if (ref !== undefined) entry.provider_ref = ref;
      payload[role] = entry;
    }

    if (plugins === undefined) {
      // Normalize (and thereby migrate) whatever section is already on
      // disk; write nothing when the file never carried plugins at all.
      if (
        Object.hasOwn(raw, "plugins") ||
        Object.hasOwn(raw, "plugins_senior") ||
        Object.hasOwn(raw, "plugins_junior")
      ) {
        payload.plugins = this.readPlugins();
      }
    } else {
      payload.plugins = pluginNames(plugins);
    }

    if (providers === undefined) {
      const existing = raw.providers;
      if (Array.isArray(existing)) payload.providers = existing;
    } else {
      const presets: Array<Record<string, unknown>> = [];
      for (const item of providers) {
        if (!isRecord(item) || !item.name || !item.base_url) continue;
        const preset: Record<string, unknown> = {
          name: String(item.name),
          base_url: String(item.base_url),
          api_key: "",
          kind: asNonEmptyString(item.kind) ?? PROVIDER_KIND_DEFAULT,
          models: asStringList(item.models),
        };
        const key = item.api_key;
        if (typeof key === "string" && key) {
          pending.push({ holder: preset });
          preset.api_key = key; // placeholder, overwritten after the batch seal
        }
        presets.push(preset);
      }
      payload.providers = presets;
    }

    if (pending.length > 0) {
      const sealed = sealMany(
        this.secretBox,
        pending.map((p) => p.holder.api_key as string),
      );
      pending.forEach((p, i) => {
        p.holder.api_key = sealed[i];
      });
    }

    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    // write-then-rename so a crash mid-write cannot corrupt the file
    const tmpPath = this.filePath + ".tmp";
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), "utf-8");
    fs.renameSync(tmpPath, this.filePath);
    if (process.platform !== "win32") {
      // no DPAPI off Windows — restrict file access instead (best effort)
      try {
        fs.chmodSync(this.filePath, 0o600);
      } catch {
        // ignore
      }
    }
  }

  /**
   * Operator-facing view of the persisted settings — no API key material,
   * only whether one is set (ports `RuntimeSettings.public()`).
   */
  public(): Record<Role, PublicRoleSettings> {
    const data = this.read();
    const view = (role: Role): PublicRoleSettings => {
      const entry = data[role] ?? {};
      return {
        provider: entry.provider ?? null,
        model: entry.model ?? null,
        base_url: entry.base_url ?? null,
        api_key_set: Boolean(entry.api_key),
        provider_ref: entry.provider_ref ?? null,
      };
    };
    return { senior: view("senior"), junior: view("junior") };
  }
}
