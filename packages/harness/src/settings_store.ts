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
 *     readProviders()  -> [{name, base_url, api_key, kind, models, context_window?}, ...]   // key decrypted
 *     readApprovalPolicy() -> "ask" | "readonly" | "edits" | "allow-all"
 *     readCompaction() -> {threshold_chars?, threshold_tokens?, ...}  // budgets
 *     write(settings, plugins?, providers?)                  // api_key in
 *         plaintext; encrypted for disk
 *     writeApprovalPolicy(mode)                              // strict enum, atomic
 *     writeCompaction(settings)                              // strict ints, atomic
 *     readSessionApprovals(session) -> [pair key, ...]       // "always allow"
 *     addSessionApproval(session, pairKey)                   // persist one pair
 *     clearSessionApprovals(session)                         // session delete
 *
 * Schema versioning: every write adds a top-level `"version": 1`
 * (`SETTINGS_SCHEMA_VERSION`). A file without a version is legacy v0 and reads
 * exactly like before; its next write normalizes it to v1. A document written
 * by a newer release (integer version > 1) still reads its known sections
 * tolerantly, but every write refuses with `SettingsSchemaVersionError` rather
 * than downgrading the document and dropping sections this release does not
 * know. A non-integer/negative/string version is treated as legacy/unversioned
 * for reads (fail-soft, never throwing) and normalizes to v1 on the next
 * write. Unknown top-level sections on a v0/v1 document are preserved by
 * `write()` so a same-version extension from a sibling build is never silently
 * dropped.
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
 * The `approvals` section (top level) is the persisted "always allow for this
 * session" approval scope:
 * `{"<session file>": ["<pair key>", ...]}`. A pair key is
 * `action\0normalized-target` (`runevents.ts::approvalPairKey`) — the action
 * and its comparison target only, never prompts, keys or other request
 * payloads. The server appends one when the operator answers a session-scope
 * approval (persisting *before* resolving it) and reads it when a run for that
 * session starts; `clearSessionApprovals()` runs on session delete. A
 * missing/corrupt section reads as empty (fail closed: a damaged file never
 * auto-allows anything), each session list is capped at
 * `MAX_SESSION_APPROVALS` pairs (oldest dropped), and every write keeps the
 * other sections intact.
 *
 * The `approval_policy` section (top level) is the persisted operator approval
 * mode for workspace runs: `{"mode": "ask"}`. It is fail-closed on read — a
 * missing or corrupt section, or an unknown mode, reads as `ask` (never a more
 * permissive mode) — and every role-settings save preserves the section,
 * normalizing a corrupt one to the fail-closed shape. The mode gates nothing
 * secret, so the section is unencrypted. `writeApprovalPolicy()` is the only
 * write path; a per-run CLI/env choice is a server option and never reaches
 * this file.
 *
 * The `compaction` section (top level) is the persisted run-level
 * auto-compaction configuration:
 * `{"threshold_chars"?: int, "threshold_tokens"?: int,
 * "keep_recent_chars"?: int, "context_window"?: int}` (snake_case like the
 * rest of the file; every value an integer >= 0, where 0 means off/unknown).
 * It is fail-closed on read: a missing/non-object section reads as absent,
 * unknown keys are dropped, and a non-integer or negative value is dropped —
 * `readCompaction()` never throws and never invents a budget. Every
 * role-settings save preserves the section (a corrupt one normalizes to
 * absent fields). `writeCompaction()` is the only write path: it validates the
 * whole section strictly before touching disk (the server maps a rejection to
 * a 400) and writes atomically, keeping every other section. The values only
 * tune token/char budgets — never prompts, keys or session content — so the
 * section is unencrypted. A serve CLI flag/env pin wins over a persisted
 * value per field and is never written here.
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

import {
  DEFAULT_APPROVAL_MODE,
  normalizeApprovalMode,
  type ApprovalMode,
} from "./permissions.ts";
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
  /**
   * Additive context window in tokens for models this preset serves (snake_case
   * like `base_url`). A positive safe integer; `0`/absent means unknown. Seeds
   * may omit it, and older stored presets never carry it — absent behaves
   * exactly like 0. Reading is fail-soft: a negative, float or string value is
   * dropped (unknown), never coerced.
   */
  context_window?: number;
}

/** Preset `kind` default — additive field, tolerant at the boundary. */
export const PROVIDER_KIND_DEFAULT = "openai-compatible";

/** One usable preset context window: a positive safe integer, else unknown. */
function providerContextWindow(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

/** Max session-allowed pairs persisted per session (oldest dropped first). */
export const MAX_SESSION_APPROVALS = 64;

/** Top-level settings section carrying the operator approval mode. */
export const APPROVAL_POLICY_SECTION = "approval_policy";

/** Top-level settings section carrying the run-level compaction budgets. */
export const COMPACTION_SECTION = "compaction";

/** Schema version written by every settings write path. */
export const SETTINGS_SCHEMA_VERSION = 1;

/**
 * Raised by every write path when `sessions/settings.json` carries a schema
 * version newer than this release understands. Reads stay tolerant; writes
 * refuse rather than downgrading the document (and dropping sections the newer
 * release added).
 */
export class SettingsSchemaVersionError extends Error {
  /** Stored schema version that this release cannot write. */
  readonly version: number;
  /** The schema version this release reads and writes. */
  readonly supported: number;

  constructor(version: number, supported: number = SETTINGS_SCHEMA_VERSION) {
    super(
      `settings.json schema version ${version} was written by a newer release ` +
        `(this release supports version ${supported}); refusing to overwrite it ` +
        `— upgrade Two Brothers or restore a backup`,
    );
    this.name = "SettingsSchemaVersionError";
    this.version = version;
    this.supported = supported;
  }
}

/**
 * One settings document's schema state (`GET /api/settings` exposes it
 * additively as `schema`). `version` is the stored top-level integer, or
 * `null` when the file is legacy/invalid; `writable` is false only for a
 * version newer than this release.
 */
export interface SettingsSchemaState {
  version: number | null;
  supported: number;
  writable: boolean;
}

/**
 * Top-level sections this release owns. `write()` rebuilds these (dropping
 * legacy plugin keys on purpose) and copies every other top-level section
 * through unchanged, so a same-version extension survives a save.
 */
const KNOWN_SECTIONS = new Set<string>([
  ...ROLES,
  "plugins",
  "plugins_senior",
  "plugins_junior",
  "providers",
  "approvals",
  APPROVAL_POLICY_SECTION,
  COMPACTION_SECTION,
  "version",
]);

/** The stored top-level schema version, or null when missing/invalid (legacy). */
function storedSchemaVersion(raw: Record<string, unknown>): number | null {
  const value = raw.version;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * The persisted run-level auto-compaction budgets (snake_case, like the rest
 * of the settings file). Every value is an integer >= 0; 0 means off/unknown
 * (the field behaves as if it were absent). Unknown keys never survive a read.
 */
export interface PersistedCompactionSettings {
  threshold_chars?: number;
  threshold_tokens?: number;
  keep_recent_chars?: number;
  context_window?: number;
}

/** The known fields of the `compaction` section, in a stable order. */
const COMPACTION_KEYS = [
  "threshold_chars",
  "threshold_tokens",
  "keep_recent_chars",
  "context_window",
] as const;

/** One usable persisted budget: a safe integer >= 0 (0 = off/unknown). */
function isCompactionBudget(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * The stored `compaction` section normalized to its four known keys.
 * Fail-closed and never throwing: a non-object section reads as absent,
 * unknown keys are dropped, and only safe integer budgets >= 0 survive (a
 * string, float, negative, NaN or infinite value is dropped). A section whose
 * every field is invalid reads back as absent.
 */
function compactionSection(value: unknown): PersistedCompactionSettings {
  const out: PersistedCompactionSettings = {};
  if (!isRecord(value)) return out;
  for (const key of COMPACTION_KEYS) {
    const budget = value[key];
    if (isCompactionBudget(budget)) out[key] = budget;
  }
  return out;
}

/**
 * Strict validation for a `compaction` write (a `PUT /api/settings` section):
 * the value must be an object whose every own key is one of the four known
 * fields and whose value is a safe integer >= 0. Anything else throws a
 * `TypeError` naming the offending field, before the file is touched. Unlike
 * the read path this never drops silently — a bad write is the caller's bug.
 */
export function strictCompactionSettings(value: unknown): PersistedCompactionSettings {
  if (!isRecord(value)) throw new TypeError("compaction must be an object");
  const out: PersistedCompactionSettings = {};
  for (const key of Object.keys(value)) {
    if (!(COMPACTION_KEYS as readonly string[]).includes(key)) {
      throw new TypeError(`unknown compaction field: ${key}`);
    }
    const budget = value[key];
    if (budget === undefined) continue;
    if (!isCompactionBudget(budget)) {
      throw new TypeError(
        `invalid compaction ${key}: ${String(budget)} (use an integer >= 0; 0 = off/unknown)`,
      );
    }
    out[key as keyof PersistedCompactionSettings] = budget;
  }
  return out;
}

/** Bound on one persisted pair key (a shell command is the longest target). */
export const MAX_APPROVAL_PAIR_KEY_CHARS = 4096;

/**
 * The stored `approval_policy` mode, fail-closed: a missing/non-object section
 * or an unknown mode value reads as `ask`. Tolerant only in shape — the mode
 * itself must be one of the exact `ApprovalMode` names.
 */
function approvalPolicyOf(value: unknown): ApprovalMode {
  if (!isRecord(value)) return DEFAULT_APPROVAL_MODE;
  return normalizeApprovalMode(value.mode) ?? DEFAULT_APPROVAL_MODE;
}

/** One `approvalPairKey`-shaped string, or null when not a usable pair key. */
function normalizeApprovalPairKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const key = value.trim();
  if (!key || key.length > MAX_APPROVAL_PAIR_KEY_CHARS) return null;
  return key;
}

/**
 * The stored `approvals` section normalized to `{session file: [pair key]}`.
 * Tolerant at the boundary: non-object sections and non-array session values
 * contribute nothing, only non-empty string entries survive, duplicates
 * collapse in order, and each list keeps at most the newest
 * `MAX_SESSION_APPROVALS` entries. A null-prototype map keeps a hostile
 * `__proto__` key from touching the object prototype.
 */
function approvalSection(value: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = Object.create(null);
  if (!isRecord(value)) return out;
  for (const [session, raw] of Object.entries(value)) {
    if (!session || path.basename(session) !== session) continue;
    if (!Array.isArray(raw)) continue;
    const seen = new Set<string>();
    const list: string[] = [];
    for (const item of raw) {
      const key = normalizeApprovalPairKey(item);
      if (key === null || seen.has(key)) continue;
      seen.add(key);
      list.push(key);
    }
    if (list.length > 0) out[session] = list.slice(-MAX_SESSION_APPROVALS);
  }
  return out;
}

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

  /**
   * The document's schema state, read fail-soft: a missing/invalid version
   * reports `null` (legacy) and is writable; only an integer newer than
   * `SETTINGS_SCHEMA_VERSION` makes the document read-only. Never throws.
   */
  schemaState(): SettingsSchemaState {
    const raw = this.readRaw();
    const version = storedSchemaVersion(raw);
    return {
      version,
      supported: SETTINGS_SCHEMA_VERSION,
      writable: version === null || version <= SETTINGS_SCHEMA_VERSION,
    };
  }

  /**
   * Refuse a document written by a newer release. Every write path calls this
   * after reading the current document and before writing, so a downgrade can
   * never drop the newer release's sections.
   */
  private assertWritable(raw: Record<string, unknown>): void {
    const version = storedSchemaVersion(raw);
    if (version !== null && version > SETTINGS_SCHEMA_VERSION) {
      throw new SettingsSchemaVersionError(version);
    }
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
      context_window?: number;
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
        context_window: providerContextWindow(item.context_window),
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
      ...(k.context_window !== undefined ? { context_window: k.context_window } : {}),
    }));
  }

  /**
   * The persisted operator approval mode, fail-closed: a missing/corrupt
   * section or an unknown mode reads as `ask`. Never returns a mode the
   * operator did not explicitly persist.
   */
  readApprovalPolicy(): ApprovalMode {
    return approvalPolicyOf(this.readRaw()[APPROVAL_POLICY_SECTION]);
  }

  /**
   * Persist one operator approval mode (the only write path for the section).
   * Rejects a value outside the strict `ApprovalMode` enum before touching
   * disk — a mode can never arrive from a model or tool call, only from the
   * validated server/CLI surface. Atomic (temp file + rename); every other
   * section is preserved, and a corrupt `approval_policy` reads back as the
   * fail-closed default.
   */
  writeApprovalPolicy(mode: ApprovalMode): void {
    const normalized = normalizeApprovalMode(mode);
    if (normalized === null) {
      throw new TypeError(`invalid approval mode: ${String(mode)}`);
    }
    const raw = this.readRaw();
    this.assertWritable(raw);
    raw[APPROVAL_POLICY_SECTION] = { mode: normalized };
    this.writeRaw(raw);
  }

  /**
   * The persisted run-level compaction budgets (only valid fields; `{}` when
   * the section is missing, corrupt, or carries no usable integer). Reading
   * never throws and never writes: this is the fail-closed direction — a
   * damaged section can make compaction *less* aggressive, never sneak a
   * budget the operator did not store.
   */
  readCompaction(): PersistedCompactionSettings {
    return compactionSection(this.readRaw()[COMPACTION_SECTION]);
  }

  /**
   * Persist the run-level compaction budgets (the only write path for the
   * section). Strict: every present key must be one of the four known fields
   * with a safe integer value >= 0 — a bad value or unknown key is rejected
   * before touching disk. Atomic (temp file + rename); every other section is
   * preserved, and a corrupt `compaction` section reads back as absent. An
   * empty section removes the key entirely rather than storing `{}`.
   */
  writeCompaction(settings: PersistedCompactionSettings): void {
    const normalized = strictCompactionSettings(settings);
    const raw = this.readRaw();
    this.assertWritable(raw);
    if (Object.keys(normalized).length > 0) raw[COMPACTION_SECTION] = normalized;
    else delete raw[COMPACTION_SECTION];
    this.writeRaw(raw);
  }

  /**
   * Persisted session-allowed `approvalPairKey` pairs for one session file
   * (empty when the session has none, when the section is missing/corrupt, or
   * when the file cannot be read — the fail-closed direction for approvals).
   */
  readSessionApprovals(session: string): string[] {
    if (typeof session !== "string" || !session) return [];
    const section = approvalSection(this.readRaw().approvals);
    return Object.hasOwn(section, session) ? [...section[session]] : [];
  }

  /**
   * Persist one session allow pair for a session file and return the stored
   * list (newest last). `pairKey` must already be `approvalPairKey`-shaped; the
   * server derives it from the pending approval request. Additive and
   * idempotent; the write is atomic (temp file + rename) and keeps every other
   * section. Throws when the file cannot be written — the server persists
   * *before* resolving the approval, so a failed write leaves nothing
   * auto-allowed.
   */
  addSessionApproval(session: string, pairKey: string): string[] {
    const key = normalizeApprovalPairKey(pairKey);
    if (!session || key === null) return [];
    const raw = this.readRaw();
    this.assertWritable(raw);
    const section = approvalSection(raw.approvals);
    const list = Object.hasOwn(section, session) ? [...section[session]] : [];
    if (!list.includes(key)) {
      list.push(key);
      if (list.length > MAX_SESSION_APPROVALS) {
        list.splice(0, list.length - MAX_SESSION_APPROVALS);
      }
    }
    section[session] = list;
    raw.approvals = section;
    this.writeRaw(raw);
    return [...list];
  }

  /**
   * Drop one session's persisted allows (called when the session is deleted)
   * and keep every other session and section. Returns `true` when a write
   * happened; a missing session is a no-op.
   */
  clearSessionApprovals(session: string): boolean {
    if (typeof session !== "string" || !session) return false;
    const raw = this.readRaw();
    this.assertWritable(raw);
    const section = approvalSection(raw.approvals);
    if (!Object.hasOwn(section, session)) return false;
    delete section[session];
    if (Object.keys(section).length > 0) raw.approvals = section;
    else delete raw.approvals;
    this.writeRaw(raw);
    return true;
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
   * The `approvals` section (session allow lists) is always preserved here —
   * this method saves role settings, plugins and providers only. The
   * `approval_policy` section is preserved the same way when it exists on
   * disk (a corrupt one is rewritten as the fail-closed `ask`), and the
   * `compaction` section is preserved when it carries at least one valid
   * budget (a corrupt one is dropped, never rewritten with invented values).
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
    this.assertWritable(raw);
    // Same-version extensions: copy every top-level section this release does
    // not own. Known sections are rebuilt below (legacy plugin keys are
    // deliberately dropped by that rebuild).
    const payload: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (!KNOWN_SECTIONS.has(key)) payload[key] = value;
    }
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
        // Additive context window: only a positive safe integer is stored, so
        // 0/absent/invalid clears it (the preset then behaves as unknown).
        const contextWindow = providerContextWindow(item.context_window);
        if (contextWindow !== undefined) preset.context_window = contextWindow;
        const key = item.api_key;
        if (typeof key === "string" && key) {
          pending.push({ holder: preset });
          preset.api_key = key; // placeholder, overwritten after the batch seal
        }
        presets.push(preset);
      }
      payload.providers = presets;
    }

    const storedApprovals = approvalSection(raw.approvals);
    if (Object.keys(storedApprovals).length > 0) payload.approvals = storedApprovals;
    // Preserve the operator approval mode on every role-settings save; a
    // corrupt section is normalized to the fail-closed shape here.
    if (Object.hasOwn(raw, APPROVAL_POLICY_SECTION)) {
      payload[APPROVAL_POLICY_SECTION] = { mode: approvalPolicyOf(raw[APPROVAL_POLICY_SECTION]) };
    }
    // Preserve the run-level compaction budgets on every role-settings save;
    // a corrupt section normalizes to absent fields (never invented values).
    const storedCompaction = compactionSection(raw[COMPACTION_SECTION]);
    if (Object.keys(storedCompaction).length > 0) {
      payload[COMPACTION_SECTION] = storedCompaction;
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

    this.writeRaw(payload);
  }

  /**
   * Atomic (temp file + rename) write of one settings document. Every write
   * carries the current schema version; a legacy/invalid stored value is
   * normalized here rather than copied through.
   */
  private writeRaw(payload: Record<string, unknown>): void {
    const document = { ...payload, version: SETTINGS_SCHEMA_VERSION };
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    // write-then-rename so a crash mid-write cannot corrupt the file
    const tmpPath = this.filePath + ".tmp";
    fs.writeFileSync(tmpPath, JSON.stringify(document, null, 2), "utf-8");
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
