/**
 * HTTP server + SSE for the web viewer. Ports the original prototype's HTTP
 * server (removed 2026-11-04; see git history; product-shell module 3) so the
 * Vue app in `web/` runs against this server unchanged.
 *
 * Framework: plain `node:http` (recorded in docs/history/ts-rewrite-plan.md).
 * Every route is a static prefix plus at most one path parameter, SSE is a raw
 * response stream, and JSON bodies are ~15 lines — less total code than
 * pulling in a web framework, and the runtime dependency list stays at zero
 * new deps.
 *
 * Contract notes (see the Python module docstring for the endpoint list):
 * - Error bodies are FastAPI-shaped: `{"detail": "..."}` with 400/404/405/
 *   409 statuses; invalid JSON bodies map to 400 "invalid request body"
 *   (the `RequestValidationError` handler).
 * - Background runs execute on the `RunManager` worker pool; the per-run
 *   `RunApprovalBroker` is reachable through the run record, so the approval
 *   endpoints resolve a mutation parked mid-run.
 * - A run record carries the requested `mode` (the config default when the
 *   request omits it), so a client can retry a failed run with its exact mode.
 * - Run records are in-memory; when a run id is unknown after a backend
 *   restart, `GET /api/runs/{id}` rebuilds a minimal record from the
 *   per-session runtime sidecar (terminal `run_end` + `run_error`). `task`
 *   and `mode` are not part of the event stream and come back as "".
 * - Settings/preset persistence goes through `RuntimeSettings`/`SettingsStore`
 *   (`public()` masking, env-pinned `TWO_BROTHERS_*` fields stripped before
 *   disk writes). Effective endpoint precedence per role: role env pair >
 *   shared env pair (both all-or-nothing) > named preset > role manual
 *   fields; per-role providers are built from the resolved endpoints (Stage
 *   18 — python per-role parity), with the shared config as the per-field
 *   fallback. A dangling `provider_ref` warns and falls back to the role's
 *   manual fields (tolerant boundary, never fails the run).
 * - Provider presets carry an additive `kind` (default "openai-compatible")
 *   and a manual `models` list; key material is never echoed back. The
 *   curated seed table (`presets.ts`) is always present, with stored presets
 *   of the same name layered on top; seed keys resolve through their
 *   `api_key_env` variable at use time and only `api_key_set` leaves the
 *   server.
 * - `GET /api/plugins` lists the plugins discovered by the PluginManager
 *   (`src/plugins.ts`, the plugins.py port) plus load errors, and additively
 *   `diagnostics` (load-time notes plus the last run's binding notes) when
 *   non-empty. The shared enable/disable list rides `PUT /api/settings`
 *   under `plugins` (one list for both brothers — owner decision 2026-11-03;
 *   the legacy per-role object is still accepted and merged; entries may be
 *   `{path, options}` and are handed to `setSettings` before the reload).
 *   Plugin tools route by their declared scope (`shared` / `senior` /
 *   `junior`) into the run's `toolScopes`, and every run receives the
 *   plugin hook registry.
 * - `GET /api/skills` lists discovered skills (name, description, scope,
 *   tools, file) with discovery diagnostics — metadata only, never bodies.
 * - `GET /api/commands` lists discovered slash commands (name, description,
 *   argumentHint, optional mode, file) with the same kind of diagnostics —
 *   metadata only, never the template bodies.
 * - `GET /api/search?q=<query>&limit=<n>` full-text searches every session
 *   document (`src/sessionsearch.ts`, newest session first) and returns the
 *   bounded `SessionSearchResult` hit list. A trimmed query shorter than
 *   `SEARCH_MIN_QUERY_CHARS` is a 400 ("query must be at least 2 characters")
 *   and `limit` is clamped to 1..100 (default 20). Corrupt session files are
 *   skipped by `loadSessionDocs`, never fatal. `GET
 *   /api/sessions/{name}/export?format=markdown|json` renders one session as
 *   a downloadable attachment (`Content-Disposition`, markdown or JSON); an
 *   unknown format is a 400, a missing/`..`-unsafe name is a 404/400, and a
 *   HEAD request returns the same headers without a body.
 * - Each run merges the plugin-contributed MCP servers under the configured
 *   `mcpConfig` file (`mergeMcpConfig`: a configured entry wins a name
 *   collision, then the first plugin), connects them, folds the per-role
 *   tool buckets into the run's `toolScopes`, and closes the MCP client
 *   after `harness.run` settles. A missing configured file warns and keeps
 *   the plugin servers.
 * - Static serving: the built app is served at `/` with an SPA fallback,
 *   `/assets` mounted like FastAPI's StaticFiles. Lookup order (computed from
 *   this module, never cwd): the packaged `<package>/web` copy that
 *   `scripts/sync-web.mjs` places in the npm tarball, then the repo layout
 *   `<repo>/web/dist`. Overridable via `webDist`.
 * - `GET /api/workspaces` lists operator-registered workspaces in their
 *   operator-set order; `POST /api/workspaces` registers one (201),
 *   `PATCH /api/workspaces/{id}` renames one (200 with the updated object:
 *   a missing or blank name is a 400 "name must not be empty", a
 *   non-string name the generic 400 "invalid request body", an unknown id
 *   a 404, and a name over 120 characters is capped rather than rejected —
 *   the route echoes the stored, trimmed/capped name),
 *   and `PUT /api/workspaces/order` takes `{"ids": [...]}`, which must be
 *   an exact permutation of the registered ids, and returns
 *   `{"workspaces": [...]}` in the new order (400 naming the non-array,
 *   duplicate, unknown or missing ids; no partial reorder on error).
 *   `DELETE /api/workspaces/{id}` is unchanged.
 * - Local-request guards (SECURITY.md: local single-user, loopback only):
 *   while every binding is loopback, requests with a non-loopback `Host`
 *   (DNS-rebinding defense) and state-changing requests with a non-local
 *   browser `Origin` (cross-site write defense) are refused with 403.
 *   Binding a routable address (`--host 0.0.0.0` etc.) opts out with a
 *   startup warning — that deployment is outside the intended threat model.
 */
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  resolveConfig,
  RunConfigError,
  validateRunConfig,
  type Config,
} from "./config.ts";
import type { CompactionSettings } from "./compaction.ts";
import { discoverCommands, type CommandCatalog } from "./commands.ts";
import { SharedContext } from "./context.ts";
import { TwoBrothersHarness, type HarnessResult, type ToolScopes } from "./harness.ts";
import {
  loadMcpToolSpecs,
  loadMcpTools,
  mergeMcpConfig,
  type McpConfigFileShape,
  type McpToolSet,
} from "./mcp.ts";
import { deriveTitle, SessionMetadataStore } from "./metadata.ts";
import { Decision, PermissionManager } from "./permissions.ts";
import {
  PluginManager,
  type HookRegistry,
  type PluginBindings,
  type PluginDiagnosticEntry,
} from "./plugins.ts";
import { mergeSeedPresets, presetApiKey, presetById, type Preset } from "./presets.ts";
import { emptyUsage, type Provider } from "./provider.ts";
import { restoreContext, SessionStore } from "./session.ts";
import {
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MAX_LIMIT,
  SEARCH_MIN_QUERY_CHARS,
  exportSessionFileName,
  loadSessionDocs,
  searchSessions,
  sessionToJsonString,
  sessionToMarkdown,
  type SessionSearchDoc,
} from "./sessionsearch.ts";
import {
  PROVIDER_KIND_DEFAULT,
  SettingsStore,
  type PluginSelection,
  type ProviderPreset,
} from "./settings_store.ts";
import { discoverSkills, type SkillCatalog } from "./skills.ts";
import { RunApprovalBroker, RuntimeEventStore } from "./runevents.ts";
import {
  ACTIVE_STATES,
  TERMINAL_STATES,
  resolveRoleEndpoints,
  RunManager,
  RuntimeSettings,
  type PublicRuntimeSettings,
  type RoleEndpoints,
  type RunJob,
} from "./runtime.ts";
import {
  Workspace,
  WorkspaceError,
  WorkspaceRegistry,
  type RegisteredWorkspace,
} from "./workspace.ts";

const MODES = new Set(["consult", "work", "auto"]);
const PROVIDERS = new Set(["openai", "mock"]);
const ROLES = ["senior", "junior"] as const;
const FS_BROWSE_LIMIT = 500;
const BODY_LIMIT_BYTES = 1_000_000;
const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  "X-Accel-Buffering": "no",
} as const;

/** FastAPI-style HTTP error: `{"detail": ...}` with a status code. */
class HttpError extends Error {
  readonly status: number;
  constructor(status: number, detail: string) {
    super(detail);
    this.status = status;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorDetail(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

// ---------------------------------------------------------------------------
// Local-request guards (see SECURITY.md: local single-user, loopback only)
// ---------------------------------------------------------------------------

/**
 * A bind address or Host/Origin hostname is "local" when it is loopback:
 * `localhost`, any `*.localhost` name (RFC 6761), `::1`, or an IPv4 address
 * in 127.0.0.0/8. Everything else (machine IPs, `0.0.0.0`, public names) is
 * not.
 */
function isLocalHostName(host: string): boolean {
  const name = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (name === "localhost" || name.endsWith(".localhost")) return true;
  if (name === "::1" || name === "::ffff:127.0.0.1") return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(name);
  if (ipv4) return Number(ipv4[1]) === 127;
  return false;
}

/** The hostname part of a `Host` header (port stripped, brackets handled). */
function hostHeaderName(hostHeader: string): string {
  const trimmed = hostHeader.trim();
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    return end === -1 ? trimmed : trimmed.slice(1, end);
  }
  const idx = trimmed.lastIndexOf(":");
  if (idx !== -1 && /^\d+$/.test(trimmed.slice(idx + 1))) return trimmed.slice(0, idx);
  return trimmed;
}

// ---------------------------------------------------------------------------
// Request models (pydantic parity: wrong types -> 400 "invalid request body")
// ---------------------------------------------------------------------------

interface RunRequestData {
  task: string;
  mode?: string;
  session?: string;
  provider?: string;
  workspace_id?: string;
}

function invalidBody(): HttpError {
  return new HttpError(400, "invalid request body");
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw invalidBody();
  return value;
}

function parseRunRequest(body: unknown): RunRequestData {
  if (!isRecord(body) || typeof body.task !== "string") throw invalidBody();
  const req: RunRequestData = { task: body.task };
  req.mode = optionalString(body, "mode");
  req.session = optionalString(body, "session");
  req.provider = optionalString(body, "provider");
  req.workspace_id = optionalString(body, "workspace_id");
  return req;
}

function parseRunRequestStrict(body: unknown): RunRequestData {
  const req = parseRunRequest(body);
  const task = req.task.trim();
  if (!task) throw new HttpError(400, "task must not be empty");
  req.task = task;
  if (req.mode !== undefined && !MODES.has(req.mode)) {
    throw new HttpError(400, "invalid mode");
  }
  if (req.provider !== undefined && !PROVIDERS.has(req.provider)) {
    throw new HttpError(400, "invalid provider");
  }
  return req;
}

/**
 * Tolerant at the boundary: keep unique, non-empty entries, drop the rest.
 * Entries are plugin names/paths or `{path, options}` objects (per-plugin
 * settings); a malformed object is dropped rather than failing the save.
 */
function uniquePluginNames(items: unknown[]): PluginSelection {
  const out: PluginSelection = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (typeof item === "string") {
      const name = item.trim();
      if (name && !seen.has(name)) {
        seen.add(name);
        out.push(name);
      }
      continue;
    }
    if (!isRecord(item)) continue;
    const entryPath = typeof item.path === "string" ? item.path.trim() : "";
    if (!entryPath || seen.has(entryPath)) continue;
    seen.add(entryPath);
    out.push(
      isRecord(item.options) ? { path: entryPath, options: { ...item.options } } : { path: entryPath },
    );
  }
  return out;
}

/**
 * The `PUT /api/settings` plugin selection. The current shape is one shared
 * list (bare names or `{path, options}` entries); the legacy per-role object
 * (`{senior: [...], junior: [...]}`) is still accepted and merged into that
 * list (dedup, order preserved) so an older operator script or cached web
 * client keeps working.
 */
function cleanPluginSelection(value: unknown): PluginSelection {
  if (Array.isArray(value)) return uniquePluginNames(value);
  if (isRecord(value)) {
    const merged: unknown[] = [];
    for (const role of ROLES) {
      if (!(role in value)) continue;
      const list = value[role];
      if (!Array.isArray(list)) {
        throw new HttpError(400, "plugins.<role> must be a list of plugin names");
      }
      merged.push(...list);
    }
    return uniquePluginNames(merged);
  }
  throw new HttpError(400, "plugins must be a list of plugin names");
}

/** Dedupe key of a selection entry (the plugin name or path). */
function pluginEntryName(entry: string | { path: string }): string {
  return typeof entry === "string" ? entry : entry.path;
}

/** Merge names into `target` in order, dropping duplicates. */
function addPluginNames(target: PluginSelection, names: string[]): void {
  const seen = new Set(target.map(pluginEntryName));
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    target.push(name);
  }
}

// ---------------------------------------------------------------------------
// Session naming + env helpers (python server.py parity)
// ---------------------------------------------------------------------------

/**
 * Filesystem-safe, collision-free session name. Second-precision stamps
 * alone silently overwrite a session created within the same second, so the
 * readable `YYYY-MM-DDTHH-MM-SS` prefix carries a millisecond part and a
 * random suffix. Ports `server._new_session_name`.
 */
export function newSessionName(now: Date = new Date()): string {
  const pad = (n: number, width = 2): string => String(n).padStart(width, "0");
  const stamp =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T` +
    `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  const millis = pad(now.getMilliseconds(), 3);
  const suffix = randomBytes(3).toString("hex");
  return `${stamp}-${millis}-${suffix}.jsonl`;
}

/**
 * Deprecated env aliases for the shared plugin selection (comma-separated).
 * `TWO_BROTHERS_PLUGINS_SENIOR` / `_JUNIOR` are kept so existing operator
 * scripts keep working; they now merge into the one shared list instead of
 * scoping a role. They are an overlay only — never persisted.
 */
function envPluginNames(): string[] {
  const out: string[] = [];
  for (const envName of [
    "TWO_BROTHERS_PLUGINS_SENIOR",
    "TWO_BROTHERS_PLUGINS_JUNIOR",
  ]) {
    const raw = process.env[envName];
    if (!raw) continue;
    for (const part of raw.split(",")) {
      const name = part.trim();
      if (name && !out.includes(name)) out.push(name);
    }
  }
  return out;
}

/** Overlay `TWO_BROTHERS_*` env vars on persisted settings (env wins). */
function applyEnvOverrides(settings: RuntimeSettings): void {
  const patch: Record<string, Record<string, string>> = {};
  const provider = process.env.TWO_BROTHERS_PROVIDER;
  if (provider === "openai" || provider === "mock") {
    for (const role of ROLES) (patch[role] ??= {}).provider = provider;
  }
  for (const [envName, field] of [
    ["TWO_BROTHERS_BASE_URL", "base_url"],
    ["TWO_BROTHERS_API_KEY", "api_key"],
  ] as const) {
    const raw = process.env[envName];
    if (raw) for (const role of ROLES) (patch[role] ??= {})[field] = raw;
  }
  // Stage 18 per-role env pairs (the new CLI flags' env equivalents).
  for (const role of ROLES) {
    const prefix = role === "senior" ? "TWO_BROTHERS_SENIOR" : "TWO_BROTHERS_JUNIOR";
    for (const [envName, field] of [
      [`${prefix}_BASE_URL`, "base_url"],
      [`${prefix}_API_KEY`, "api_key"],
    ] as const) {
      const raw = process.env[envName];
      if (raw) (patch[role] ??= {})[field] = raw;
    }
  }
  const seniorModel = process.env.TWO_BROTHERS_SENIOR_MODEL;
  if (seniorModel) (patch.senior ??= {}).model = seniorModel;
  const juniorModel = process.env.TWO_BROTHERS_JUNIOR_MODEL;
  if (juniorModel) (patch.junior ??= {}).model = juniorModel;
  if (Object.keys(patch).length > 0) settings.update(patch);
}

/** Public preset view — key material is never echoed back. */
function publicProvider(preset: {
  name: string;
  base_url: string;
  api_key: string;
  kind: string;
  models: string[];
}): {
  name: string;
  base_url: string;
  api_key_set: boolean;
  kind: string;
  models: string[];
} {
  return {
    name: preset.name,
    base_url: preset.base_url,
    api_key_set: Boolean(preset.api_key),
    kind: preset.kind || PROVIDER_KIND_DEFAULT,
    models: [...preset.models],
  };
}

/**
 * Public view of a merged preset. `presetApiKey` resolves a seed's
 * `api_key_env` at use time, so `api_key_set` reflects an env-backed key
 * without the value ever leaving the server.
 */
function publicPreset(preset: Preset): ReturnType<typeof publicProvider> {
  return publicProvider({
    name: preset.name,
    base_url: preset.base_url,
    api_key: presetApiKey(preset),
    kind: preset.kind,
    models: preset.models,
  });
}

/**
 * Default skill roots, shared by run assembly and `GET /api/skills`:
 * `TWO_BROTHERS_SKILLS_DIR` (one or more roots separated by the OS path-list
 * separator — `;` on Windows, `:` elsewhere), then `<cwd>/skills`, then
 * `~/.two-brothers/skills`. A missing root is not an error (`discoverSkills`
 * reports only real problems).
 */
function defaultSkillsRoots(): string[] {
  const roots: string[] = [];
  const raw = process.env.TWO_BROTHERS_SKILLS_DIR;
  if (raw) {
    for (const part of raw.split(path.delimiter)) {
      const dir = part.trim();
      if (dir) roots.push(dir);
    }
  }
  roots.push(
    path.join(process.cwd(), "skills"),
    path.join(os.homedir(), ".two-brothers", "skills"),
  );
  return roots;
}

/**
 * Default slash-command roots, shared by `GET /api/commands`:
 * `TWO_BROTHERS_COMMANDS_DIR` (OS path-list separated), then
 * `<cwd>/commands`, then `~/.two-brothers/commands` — the same convention as
 * the skill roots. A missing root is not an error.
 */
function defaultCommandsRoots(): string[] {
  const roots: string[] = [];
  const raw = process.env.TWO_BROTHERS_COMMANDS_DIR;
  if (raw) {
    for (const part of raw.split(path.delimiter)) {
      const dir = part.trim();
      if (dir) roots.push(dir);
    }
  }
  roots.push(
    path.join(process.cwd(), "commands"),
    path.join(os.homedir(), ".two-brothers", "commands"),
  );
  return roots;
}

/** Tolerant at the boundary: keep unique non-empty strings, drop the rest. */
function cleanModelList(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw invalidBody();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const name = item.trim();
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

export interface ServerOptions {
  /** Run-config factory (Python parity: a fresh config per run). */
  configFactory?: () => Config;
  /** Session file directory (default: `<cwd>/sessions`). */
  sessionsDir?: string;
  /**
   * Local plugin directory scanned by the PluginManager (default: `<repo
   * root>/plugins` — the prototype's default plugin dir; a
   * missing directory means no plugins).
   */
  pluginsDir?: string;
  /**
   * Skill roots scanned by `discoverSkills` (default:
   * `TWO_BROTHERS_SKILLS_DIR`, then `<cwd>/skills`, then
   * `~/.two-brothers/skills`). A missing root is not an error.
   */
  skillsDirs?: string[];
  /**
   * Slash-command roots scanned by `discoverCommands` (default:
   * `TWO_BROTHERS_COMMANDS_DIR`, then `<cwd>/commands`, then
   * `~/.two-brothers/commands`). Metadata serves at `GET /api/commands`.
   */
  commandsDirs?: string[];
  /**
   * `--mcp-config` JSON file. Its servers are the base of every run's MCP
   * set; plugin-contributed servers merge underneath it (configured wins),
   * and a missing file warns without dropping the plugin servers.
   */
  mcpConfig?: string;
  /**
   * Compaction settings for web runs (auto-compact threshold, keep-recent
   * budget, force). Unset = no compaction, matching the CLI defaults.
   */
  compaction?: CompactionSettings;
  /** Worker-pool size (default: `TWO_BROTHERS_WORKERS` or 2). */
  workers?: number;
  /**
   * Built web app to serve at `/` (default: the packaged `<package>/web`
   * copy, else the repo's `web/dist`, when either exists; pass `null` to
   * disable static serving).
   */
  webDist?: string | null;
  /** Test hook: provider overrides wired into every run (like Python's
   *  `mock.patch` on `build_responder`). */
  providerOverrides?: { senior?: Provider; junior?: Provider };
}

export interface ServerState {
  sessionsDir: string;
  configFactory: () => Config;
  workspaces: WorkspaceRegistry;
  metadata: SessionMetadataStore;
  settings: RuntimeSettings;
  settingsStore: SettingsStore;
  runtimeEvents: RuntimeEventStore;
  runs: RunManager;
  plugins: PluginManager;
  /** Resolves once the startup plugin load finishes (fail-soft by design). */
  pluginsReady: Promise<void>;
  /**
   * Effective shared plugin selection: the saved list (bare names or
   * `{path, options}` entries) plus the deprecated per-role env aliases
   * (both brothers receive every plugin tool).
   */
  pluginSelection: PluginSelection;
  /**
   * Diagnostics of the last run's plugin binding pass (`bindingsFor`):
   * deprecations, rejected options and failed hooks, as `plugin: message`.
   * Surfaced additively by `GET /api/plugins` when non-empty.
   */
  pluginDiagnostics: string[];
  /** `--mcp-config` file merged under the plugin MCP servers on every run. */
  mcpConfig?: string;
}

export interface ServerHandle {
  state: ServerState;
  handler: http.RequestListener;
  /** Listen on host/port (port 0 = ephemeral); resolves with the server. */
  listen(host?: string, port?: number): Promise<http.Server>;
  /** End all SSE connections and close every started server. */
  close(): Promise<void>;
}

/** Sentinel: the handler fully managed the response (SSE / static files). */
const HANDLED = Symbol("handled");

/** Explicit non-200 JSON response (201/202 creations and acceptances). */
class Respond {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown) {
    this.status = status;
    this.body = body;
  }
}

interface Ctx {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  /** Parsed JSON object body; non-objects and bad JSON -> 400. */
  json(): Promise<Record<string, unknown>>;
}

type RouteHandler = (ctx: Ctx) => unknown | Promise<unknown>;

interface Route {
  method: string;
  regex: RegExp;
  keys: string[];
  handler: RouteHandler;
}

function compileRoute(method: string, pattern: string, handler: RouteHandler): Route {
  const keys: string[] = [];
  const parts = pattern.split("/").filter((part) => part.length > 0);
  const regex =
    "^/" +
    parts
      .map((part) => {
        if (part.startsWith("{") && part.endsWith("}")) {
          keys.push(part.slice(1, -1));
          return "([^/]+)";
        }
        return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      })
      .join("/") +
    "/?$";
  return { method, regex: new RegExp(regex), keys, handler };
}

/**
 * Resolve the default built-web-app directory from this module's location
 * (never cwd). The packaged `<package>/web` copy wins — it is what
 * `scripts/sync-web.mjs` puts in the npm tarball — then the repo layout
 * `<repo>/web/dist` for dev checkouts. Returns `null` when neither has an
 * `index.html`.
 */
export function resolveDefaultWebDist(moduleUrl: string | URL = import.meta.url): string | null {
  const moduleDir = path.dirname(fileURLToPath(moduleUrl));
  const packageDir = path.resolve(moduleDir, "..");
  const candidates = [
    path.join(packageDir, "web"),
    path.resolve(packageDir, "..", "..", "web", "dist"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "index.html"))) return candidate;
  }
  return null;
}

export function createServer(options: ServerOptions = {}): ServerHandle {
  const sessionsDir = options.sessionsDir
    ? path.resolve(options.sessionsDir)
    : path.join(process.cwd(), "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });

  const settingsStore = new SettingsStore(path.join(sessionsDir, "settings.json"));
  const settings = new RuntimeSettings(settingsStore);
  for (const role of ROLES) {
    const saved = settingsStore.read()[role];
    if (saved) settings.update({ [role]: saved });
  }
  // Environment beats the persisted file where set — effective precedence
  // for the run config is: per-run flags > TWO_BROTHERS_* env vars >
  // persisted settings > defaults. (Persisted writes strip env-pinned
  // fields, so this overlay never reaches settings.json.)
  applyEnvOverrides(settings);

  const runtimeEvents = new RuntimeEventStore(path.join(sessionsDir, "runtime"));
  const runs = new RunManager({ persist: runtimeEvents.asPersist(), workers: options.workers });
  const providerOverrides = options.providerOverrides ?? null;

  // Shared plugin selection (owner decision 2026-11-03): one list, both
  // brothers. `readPlugins()` merges any legacy per-role section on disk and
  // preserves `{path, options}` entries; the deprecated per-role env vars
  // stay accepted as additive aliases and are never persisted, so removing
  // them reveals the saved list again.
  let savedPluginSelection: PluginSelection = settingsStore.readPlugins();
  const pluginSelection: PluginSelection = [...savedPluginSelection];
  addPluginNames(pluginSelection, envPluginNames());

  // Local plugin system (plugins.py port): discovered once here and reloaded
  // after every settings change carrying a `plugins` section; a broken
  // plugin logs a warning and is skipped — never breaks startup. The
  // selection doubles as the load-time settings source for per-plugin options.
  const plugins = new PluginManager(options.pluginsDir, pluginSelection);
  const pluginsReady = plugins.reload();

  // Skill discovery is re-run on demand (a run, `GET /api/skills`), so a new
  // `SKILL.md` needs no server restart. Missing roots are skipped silently by
  // `discoverSkills`; the catalog is fail-soft either way.
  const skillsDirs = options.skillsDirs ?? defaultSkillsRoots();
  const skillCatalog = (): SkillCatalog => discoverSkills(skillsDirs);

  // Slash-command discovery is on demand too (`GET /api/commands`), so a new
  // `<name>.md` needs no server restart. A missing root is skipped silently.
  const commandsDirs = options.commandsDirs ?? defaultCommandsRoots();
  const commandCatalog = (): CommandCatalog => discoverCommands(commandsDirs);

  const state: ServerState = {
    sessionsDir,
    configFactory: options.configFactory ?? (() => resolveConfig()),
    workspaces: new WorkspaceRegistry(path.join(sessionsDir, "workspaces.json")),
    metadata: new SessionMetadataStore(sessionsDir),
    settings,
    settingsStore,
    runtimeEvents,
    runs,
    plugins,
    pluginsReady,
    pluginSelection,
    pluginDiagnostics: [],
    mcpConfig: options.mcpConfig,
  };

  // -- helpers ---------------------------------------------------------------

  function storeFor(name: string): SessionStore {
    // `path.basename` flattening: never allow path traversal out of the dir.
    return new SessionStore(path.join(sessionsDir, path.basename(name)));
  }

  function sessionName(raw: string | null | undefined): string {
    if (raw === "." || raw === "..") throw new HttpError(400, "invalid session name");
    const name = raw ? path.basename(raw) : newSessionName();
    if (name === "." || name === ".." || name === "") {
      throw new HttpError(400, "invalid session name");
    }
    return name.endsWith(".jsonl") ? name : `${name}.jsonl`;
  }

  /**
   * Validate a name that must already denote a session file: basename-
   * flattened (never a path) and ending in `.jsonl`, so the session endpoints
   * cannot touch the settings/provider JSON or the registry file living next
   * to the sessions. `sessionName()` above appends the extension for run
   * submissions; these handlers require it to be present instead.
   */
  function sessionFileName(raw: string): string {
    const name = path.basename(raw);
    if (name === "." || name === ".." || name === "" || !name.endsWith(".jsonl")) {
      throw new HttpError(400, "invalid session name");
    }
    return name;
  }

  function listSessions(workspaceId: string | null): Array<Record<string, unknown>> {
    let files: string[];
    try {
      files = fs.readdirSync(sessionsDir).filter((file) => file.endsWith(".jsonl"));
    } catch {
      return [];
    }
    const items: Array<Record<string, unknown>> = [];
    for (const file of files) {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(path.join(sessionsDir, file));
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      const item = state.metadata.attach(file, {
        size: stat.size,
        mtime: Math.floor(stat.mtimeMs / 1000),
      });
      if (workspaceId && item.workspace_id !== workspaceId) continue;
      items.push(item);
    }
    items.sort((a, b) => Number(b.mtime) - Number(a.mtime));
    return items;
  }

  function buildCfg(req: RunRequestData): { cfg: Config; endpoints: RoleEndpoints } {
    const cfg = state.configFactory();
    // Run-level provider (flags/env) before role settings overlay it —
    // it is the fallback for roles that do not set their own provider.
    const baseProvider = req.provider ?? cfg.provider;
    const snapshot = state.settings.snapshot();
    // Role settings overlay models (always) and provider (unless a
    // per-request provider override is in force) — connection fields are
    // deliberately NOT overlaid onto the shared cfg anymore (Stage 18
    // design decision 4; that collapse was the defect: junior won).
    for (const role of ROLES) {
      const rs = snapshot[role];
      if (rs.model) {
        if (role === "senior") cfg.seniorModel = rs.model;
        else cfg.juniorModel = rs.model;
      }
      if (req.provider === undefined && rs.provider) cfg.provider = rs.provider;
    }
    if (req.mode !== undefined) {
      if (!MODES.has(req.mode)) throw new HttpError(400, "invalid mode");
      cfg.mode = req.mode as Config["mode"];
    }
    if (req.provider !== undefined) {
      if (!PROVIDERS.has(req.provider)) throw new HttpError(400, "invalid provider");
      cfg.provider = req.provider;
    }
    // Stage 18: resolve each role's effective endpoint (role env pair >
    // shared env pair > named preset > role manual fields) and hand the
    // per-role endpoints to the harness. Connection fields gap-fill across
    // roles inside the resolver (Python's shared-config fallback), so a role
    // without its own resolved URL inherits the other role's; provider and
    // model are never borrowed across roles. The shared cfg fields remain
    // only as the per-field fallback inside the harness/validation.
    // Presets are the seeded table with stored presets layered on top; each
    // key is resolved through `presetApiKey` so an env-backed seed works.
    const endpoints = resolveRoleEndpoints(
      snapshot,
      resolvablePresets(),
      process.env,
      { provider: baseProvider, seniorModel: cfg.seniorModel, juniorModel: cfg.juniorModel },
      req.provider === undefined,
    );
    for (const warning of endpoints.warnings) {
      console.warn(`[two-brothers] ${warning}`);
    }
    return { cfg, endpoints };
  }

  /**
   * The seeded preset table with the stored presets layered on top: a stored
   * preset whose name matches a seed replaces it (user edits win), a stored
   * preset with no key of its own keeps the seed's `api_key_env` so editing a
   * seed's models does not silently drop its env-backed key.
   */
  function mergedPresets(): Preset[] {
    return mergeSeedPresets(state.settingsStore.readProviders()).map((preset) => {
      if (preset.api_key || preset.api_key_env) return preset;
      const seed = presetById(preset.name);
      return seed?.api_key_env ? { ...preset, api_key_env: seed.api_key_env } : preset;
    });
  }

  /** Merged presets with each key resolved for the endpoint resolver. */
  function resolvablePresets(): Array<{
    name: string;
    base_url: string;
    api_key: string;
    kind: string;
  }> {
    return mergedPresets().map((preset) => ({
      name: preset.name,
      base_url: preset.base_url,
      api_key: presetApiKey(preset),
      kind: preset.kind,
    }));
  }

  /**
   * Mode the submitted run record carries: the request's mode, else the
   * config default the job will run with. A failing config factory is not
   * fatal here — the job surfaces it as the run error.
   */
  function effectiveMode(req: RunRequestData): string {
    if (req.mode !== undefined) return req.mode;
    try {
      return state.configFactory().mode;
    } catch {
      return "";
    }
  }

  /**
   * Rebuild a minimal run record from the runtime sidecar when the in-memory
   * record is gone (backend restart). Every manager event is persisted with
   * its `run_id`, so the terminal `run_end` (plus the preceding `run_error`)
   * reconstructs status/error/usage/timestamps without a second store.
   * `task` and `mode` are not in the event stream and stay "". The record is
   * marked `rebuilt: true` (additive; live in-memory records omit the field)
   * so the UI can explain the blank fields instead of guessing. Returns null
   * when no sidecar holds a terminal run with that id.
   */
  function recoverRun(runId: string): Record<string, unknown> | null {
    const found = state.runtimeEvents.findRun(runId);
    if (found === null) return null;
    const reversed = [...found.events].reverse();
    const end = reversed.find((event) => event.type === "run_end");
    if (end === undefined || typeof end.status !== "string") return null;
    if (!TERMINAL_STATES.has(end.status)) return null;
    const error = reversed.find((event) => event.type === "run_error");
    const queued = found.events.find(
      (event) => event.type === "run_status" && event.status === "queued",
    );
    const running = found.events.find(
      (event) => event.type === "run_status" && event.status === "running",
    );
    const record: Record<string, unknown> = {
      run_id: runId,
      session: found.session,
      task: "",
      mode: "",
      rebuilt: true,
      status: end.status,
      created: typeof queued?.at === "number" ? queued.at : 0,
      started: typeof running?.at === "number" ? running.at : 0,
      finished: typeof end.at === "number" ? end.at : 0,
    };
    if (error !== undefined && typeof error.message === "string" && error.message) {
      record.error = error.message;
    }
    if (isRecord(end.decision)) record.decision = end.decision;
    record.usage = isRecord(end.usage) ? { ...emptyUsage(), ...end.usage } : { ...emptyUsage() };
    return record;
  }

  async function executeRun(
    task: string,
    name: string,
    cfg: Config,
    signal?: AbortSignal,
    onEnvelope?: (message: unknown) => void,
    workspace?: Workspace,
    endpoints?: RoleEndpoints,
  ): Promise<HarnessResult> {
    const store = storeFor(name);
    const context = store.exists() ? restoreContext(store) : new SharedContext(store);
    // Fail fast on an unusable model config before touching the network;
    // with per-role endpoints each role is checked against its own
    // effective settings and the message names the misconfigured role.
    validateRunConfig(cfg, endpoints);
    // Plugin contributions bind per run (plugins.py parity): tools only for
    // workspace-bound runs, through the same approval broker as the built-in
    // tools; hooks are collected for every run. Tools are routed by their
    // declared scope (`shared` / `senior` / `junior`) — a legacy positional
    // role keeps the tool shared (owner decision 2026-11-03) — so the
    // senior's verify slice and the junior's belt each get their own set.
    // Fail-soft: a broken binding pass never blocks the run.
    let toolScopes: ToolScopes | undefined;
    let hooks: HookRegistry | undefined;
    let bindings: PluginBindings | null = null;
    try {
      await state.pluginsReady;
      bindings = await state.plugins.bindingsFor(state.pluginSelection, workspace ?? null);
      hooks = bindings.hooks;
      state.pluginDiagnostics = bindings.diagnostics.map(
        (entry: PluginDiagnosticEntry) => `${entry.plugin}: ${entry.message}`,
      );
      if (workspace) toolScopes = mergeScopeBuckets(toolScopes, bindings.toolsByScope);
    } catch (exc) {
      console.warn(`[two-brothers] plugin binding failed: ${errorDetail(exc)}`);
    }
    // MCP after the binding pass and before the harness: the configured
    // `mcpConfig` file is the base (a missing file warns and keeps the
    // plugin servers), plugin declarations merge underneath it (configured
    // wins a name collision), and the per-role buckets join the run scopes.
    let mcp: McpToolSet | null = null;
    const pluginServers = bindings?.mcpServers ?? [];
    if (state.mcpConfig !== undefined || pluginServers.length > 0) {
      let base: McpConfigFileShape | null = null;
      if (state.mcpConfig !== undefined) {
        try {
          base = { mcpServers: loadMcpToolSpecs(state.mcpConfig) };
        } catch (exc) {
          console.warn(`[two-brothers] MCP config: ${errorDetail(exc)}`);
        }
      }
      const merged = mergeMcpConfig(base, pluginServers);
      for (const line of merged.diagnostics) console.warn(`[two-brothers] ${line}`);
      try {
        mcp = await loadMcpTools(merged.config);
        for (const err of mcp.errors) console.warn(`[two-brothers] ${err}`);
        toolScopes = mergeScopeBuckets(toolScopes, {
          shared: mcp.sharedTools,
          senior: mcp.seniorTools,
          junior: mcp.juniorTools,
        });
      } catch (exc) {
        console.warn(`[two-brothers] MCP: ${errorDetail(exc)}`);
      }
    }
    const harness = new TwoBrothersHarness(cfg, {
      workspace,
      signal,
      onEvent: onEnvelope,
      onEnvelope: onEnvelope ? (msg) => onEnvelope(msg) : undefined,
      senior: providerOverrides?.senior,
      junior: providerOverrides?.junior,
      endpoints,
      skills: skillCatalog(),
      ...(options.compaction ? { compaction: options.compaction } : {}),
      ...(toolScopes ? { toolScopes } : {}),
      ...(hooks ? { hooks } : {}),
    });
    try {
      return await harness.run(task, context);
    } finally {
      // connections stay open for the whole run; closed once it settles
      await mcp?.client.close();
    }
  }

  /**
   * Fold one binding pass's scope buckets into the run's `toolScopes`
   * registry (plugin tools, then the MCP buckets). Empty buckets are dropped
   * so the harness keeps its "no scopes configured" defaults.
   */
  function mergeScopeBuckets(
    scopes: ToolScopes | undefined,
    buckets: PluginBindings["toolsByScope"],
  ): ToolScopes | undefined {
    const merged: ToolScopes = {};
    for (const scope of ["shared", "senior", "junior"] as const) {
      const list = [...(scopes?.[scope] ?? []), ...buckets[scope]];
      if (list.length > 0) merged[scope] = list;
    }
    return Object.keys(merged).length > 0 ? merged : undefined;
  }

  function buildRunJob(
    task: string,
    name: string,
    req: RunRequestData,
    broker: RunApprovalBroker,
  ): RunJob {
    // The config is built inside the job so a run picks up settings current
    // at start time; the broker binds the per-run emit hook and cancel
    // signal once the worker starts it.
    return async (signal, onEnvelope) => {
      const { cfg, endpoints } = buildCfg(req);
      broker.attach(onEnvelope, signal);
      let workspace: Workspace | undefined;
      if (req.workspace_id) {
        const registered = state.workspaces.get(req.workspace_id);
        if (registered === null) {
          throw new WorkspaceError(`unknown workspace_id: ${req.workspace_id}`);
        }
        workspace = new Workspace(registered.path, new PermissionManager(null, broker));
      }
      const result = await executeRun(task, name, cfg, signal, onEnvelope, workspace, endpoints);
      return {
        cancelled: result.cancelled,
        decision: result.decision,
        errors: result.errors,
        usage: result.usage,
      };
    };
  }

  function ensureWorkspace(workspaceId: string | undefined): void {
    if (workspaceId && state.workspaces.get(workspaceId) === null) {
      throw new HttpError(400, "unknown workspace_id");
    }
  }

  function userMessageEvent(text: string): Array<Record<string, unknown>> {
    return [{ from: "user", kind: "message", payload: { text } }];
  }

  /**
   * One session as an export document (`src/sessionsearch.ts` shape): envelopes
   * from the durable store, the sidecar title when present (derived title
   * otherwise, the same fallback `loadSessionDocs` uses), workspace link and
   * mtime in Unix seconds for the export header. A missing file is a 404.
   */
  function sessionExportDoc(name: string): SessionSearchDoc {
    const store = storeFor(name);
    if (!store.exists()) throw new HttpError(404, "not found");
    const events = store.load();
    const stem = name.replace(/\.jsonl$/, "");
    const meta = state.metadata.get(name);
    const metaTitle = meta !== null && typeof meta.title === "string" ? meta.title.trim() : "";
    const workspaceId =
      meta !== null && typeof meta.workspace_id === "string" && meta.workspace_id
        ? meta.workspace_id
        : null;
    let updated: number | null = null;
    try {
      updated = Math.floor(fs.statSync(path.join(sessionsDir, name)).mtimeMs / 1000);
    } catch {
      updated = null;
    }
    return {
      name,
      title: metaTitle || deriveTitle(events as unknown as Array<Record<string, any>>, stem),
      events,
      workspace_id: workspaceId,
      updated,
    };
  }

  /**
   * `GET /api/search` limit param: an integer clamped to `1..SEARCH_MAX_LIMIT`,
   * defaulting to `SEARCH_DEFAULT_LIMIT` when absent or non-numeric.
   */
  function searchLimit(raw: string | null): number {
    const parsed = raw === null || raw.trim() === "" ? Number.NaN : Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return SEARCH_DEFAULT_LIMIT;
    return Math.min(SEARCH_MAX_LIMIT, Math.max(1, parsed));
  }

  // -- routes: Stage 1 (session files + synchronous run) ---------------------

  const routes: Route[] = [];

  routes.push(
    compileRoute("GET", "/api/sessions", (ctx) => {
      const workspaceId = ctx.query.get("workspace_id");
      return listSessions(workspaceId && workspaceId.trim() ? workspaceId : null);
    }),
  );

  routes.push(
    compileRoute("GET", "/api/sessions/{name}", (ctx) => {
      const name = sessionFileName(ctx.params.name);
      const store = storeFor(name);
      if (!store.exists()) throw new HttpError(404, "not found");
      const detail: Record<string, unknown> = {
        name,
        events: store.load(),
      };
      const meta = state.metadata.get(name);
      if (meta !== null) {
        const stem = name.replace(/\.jsonl$/, "");
        detail.title = typeof meta.title === "string" ? meta.title : stem;
        if (typeof meta.workspace_id === "string" && meta.workspace_id) {
          detail.workspace_id = meta.workspace_id;
        }
      }
      return detail;
    }),
  );

  routes.push(
    compileRoute("GET", "/api/sessions/{name}/events", (ctx) => {
      const name = sessionFileName(ctx.params.name);
      return {
        name,
        events: state.runtimeEvents.load(name),
      };
    }),
  );

  // -- routes: session search + export (src/sessionsearch.ts) -----------------

  routes.push(
    compileRoute("GET", "/api/search", (ctx) => {
      const query = (ctx.query.get("q") ?? "").trim();
      if (query.length < SEARCH_MIN_QUERY_CHARS) {
        throw new HttpError(400, "query must be at least 2 characters");
      }
      // `loadSessionDocs` is fail-soft: a missing sessions dir yields an empty
      // corpus and a corrupt session file is skipped with a count.
      const loaded = loadSessionDocs(sessionsDir);
      return searchSessions(loaded.docs, query, {
        limit: searchLimit(ctx.query.get("limit")),
      });
    }),
  );

  // GET serves the export body; HEAD returns the same status/type/disposition
  // headers without a body (one handler serves both methods).
  for (const method of ["GET", "HEAD"] as const) {
    routes.push(
      compileRoute(method, "/api/sessions/{name}/export", (ctx) => {
        const name = sessionFileName(ctx.params.name);
        const requestedFormat = (ctx.query.get("format") ?? "markdown").trim().toLowerCase();
        if (requestedFormat !== "markdown" && requestedFormat !== "json") {
          throw new HttpError(400, "format must be markdown or json");
        }
        const format: "markdown" | "json" = requestedFormat;
        const doc = sessionExportDoc(name);
        const body = format === "markdown" ? sessionToMarkdown(doc) : sessionToJsonString(doc);
        ctx.res.writeHead(200, {
          "Content-Type":
            format === "markdown"
              ? "text/markdown; charset=utf-8"
              : "application/json; charset=utf-8",
          "Content-Disposition": `attachment; filename="${exportSessionFileName(name, format)}"`,
          "Content-Length": Buffer.byteLength(body, "utf-8"),
        });
        ctx.res.end(ctx.req.method === "HEAD" ? undefined : body);
        return HANDLED;
      }),
    );
  }

  routes.push(
    compileRoute("POST", "/api/run", async (ctx) => {
      const req = parseRunRequest(await ctx.json());
      const task = req.task.trim();
      if (!task) throw new HttpError(400, "task must not be empty");
      const cfg = buildCfg(req);
      const name = sessionName(req.session);
      let result;
      try {
        result = await executeRun(task, name, cfg.cfg, undefined, undefined, undefined, cfg.endpoints);
      } catch (exc) {
        if (exc instanceof RunConfigError) throw new HttpError(400, exc.message);
        throw exc;
      }
      state.metadata.ensure(name, {
        workspaceId: req.workspace_id,
        events: userMessageEvent(task),
      });
      return {
        session: name,
        events: result.messages,
        decision: result.decision,
        errors: result.errors,
      };
    }),
  );

  routes.push(
    compileRoute("GET", "/api/stream", (ctx) => {
      const session = ctx.query.get("session");
      if (!session) throw new HttpError(400, "invalid request body");
      const store = storeFor(sessionFileName(session));
      ctx.res.writeHead(200, SSE_HEADERS);
      let sent = 0;
      let closed = false;
      ctx.req.on("close", () => {
        closed = true;
        ctx.res.end();
      });
      const replay = (): void => {
        let events: unknown[] = [];
        try {
          events = store.exists() ? store.load() : [];
        } catch {
          events = []; // mid-write line; retry next tick
        }
        for (const event of events.slice(sent)) {
          sent += 1;
          ctx.res.write(`data: ${JSON.stringify(event)}\n\n`);
        }
      };
      replay();
      const timer = setInterval(() => {
        if (closed) {
          clearInterval(timer);
          return;
        }
        replay();
        ctx.res.write(": keepalive\n\n");
      }, 500);
      return HANDLED;
    }),
  );

  // -- routes: workspaces ------------------------------------------------------

  routes.push(
    compileRoute("GET", "/api/workspaces", () => {
      return state.workspaces.list();
    }),
  );

  routes.push(
    compileRoute("POST", "/api/workspaces", async (ctx) => {
      const body = await ctx.json();
      const pathname = optionalString(body, "path");
      if (pathname === undefined) throw invalidBody();
      const name = optionalString(body, "name");
      let created: RegisteredWorkspace;
      try {
        created = state.workspaces.add(pathname, name);
      } catch (exc) {
        if (exc instanceof WorkspaceError) throw new HttpError(400, exc.message);
        throw exc;
      }
      return new Respond(201, created);
    }),
  );

  routes.push(
    compileRoute("PUT", "/api/workspaces/order", async (ctx) => {
      const body = await ctx.json();
      const ids = body.ids;
      if (!Array.isArray(ids)) throw new HttpError(400, "ids must be an array");
      if (ids.some((id) => typeof id !== "string")) {
        throw new HttpError(400, "ids must be an array of strings");
      }
      let ordered: RegisteredWorkspace[];
      try {
        ordered = state.workspaces.reorder(ids as string[]);
      } catch (exc) {
        if (exc instanceof WorkspaceError) throw new HttpError(400, exc.message);
        throw exc;
      }
      return { workspaces: ordered };
    }),
  );

  routes.push(
    compileRoute("PATCH", "/api/workspaces/{id}", async (ctx) => {
      // 404 first (house style, like PATCH /api/sessions/{name}): a rename
      // target that no longer exists is "not found" regardless of the body.
      if (!state.workspaces.get(ctx.params.id)) throw new HttpError(404, "not found");
      const body = await ctx.json();
      const name = optionalString(body, "name");
      if (name === undefined || !name.trim()) {
        throw new HttpError(400, "name must not be empty");
      }
      // The registry trims and caps the name (120 chars); a long name is
      // stored truncated and the stored value comes back in the 200 body.
      try {
        return state.workspaces.rename(ctx.params.id, name);
      } catch (exc) {
        if (exc instanceof WorkspaceError) throw new HttpError(400, exc.message);
        throw exc;
      }
    }),
  );

  routes.push(
    compileRoute("DELETE", "/api/workspaces/{id}", (ctx) => {
      if (!state.workspaces.remove(ctx.params.id)) throw new HttpError(404, "not found");
      return { removed: ctx.params.id };
    }),
  );

  // -- routes: session metadata ------------------------------------------------

  routes.push(
    compileRoute("POST", "/api/sessions", async (ctx) => {
      const body = await ctx.json();
      const title = optionalString(body, "title");
      const workspaceId = optionalString(body, "workspace_id");
      if (workspaceId) ensureWorkspace(workspaceId);
      const name = newSessionName();
      fs.writeFileSync(storeFor(name).path, "");
      const meta = state.metadata.save(name, {
        title,
        workspaceId,
        events: userMessageEvent(title ?? ""),
      });
      return new Respond(201, { name, ...meta });
    }),
  );

  routes.push(
    compileRoute("PATCH", "/api/sessions/{name}", async (ctx) => {
      const name = sessionFileName(ctx.params.name);
      const store = storeFor(name);
      if (!store.exists()) throw new HttpError(404, "not found");
      const body = await ctx.json();
      const title = optionalString(body, "title");
      if (title === undefined || !title.trim()) {
        throw new HttpError(400, "title must not be empty");
      }
      const meta = state.metadata.save(name, { title });
      return { name, ...meta };
    }),
  );

  routes.push(
    compileRoute("DELETE", "/api/sessions/{name}", async (ctx) => {
      const safe = sessionFileName(ctx.params.name);
      const store = storeFor(safe);
      let isFile = false;
      try {
        isFile = fs.statSync(store.path).isFile();
      } catch {
        isFile = false;
      }
      if (!isFile) throw new HttpError(404, "not found");
      // A live run keeps its SessionStore handle and would re-append the next
      // envelope, resurrecting the file — stop it and let it unwind first.
      const activeFor = (): Array<Record<string, unknown>> =>
        state.runs.list().filter(
          (record) =>
            record.session === safe &&
            typeof record.status === "string" &&
            ACTIVE_STATES.has(record.status),
        );
      for (const record of activeFor()) state.runs.stop(String(record.run_id));
      const deadline = Date.now() + 2500;
      while (activeFor().length > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      fs.unlinkSync(store.path);
      state.metadata.delete(safe);
      state.runtimeEvents.delete(safe);
      return { deleted: safe };
    }),
  );

  // -- routes: settings ----------------------------------------------------------

  routes.push(
    compileRoute("GET", "/api/settings", () => {
      // plugin names only — nothing secret leaves the backend
      return { ...state.settings.public(), plugins: [...state.pluginSelection] };
    }),
  );

  routes.push(
    compileRoute("PUT", "/api/settings", async (ctx) => {
      const body = await ctx.json();
      // Validate everything before mutating: a 400 must not leave a
      // half-applied update behind (the TS RuntimeSettings persists on
      // update, Python persisted only at the end of the handler). Refs may
      // point at a stored preset or a seeded one (seeds are always known).
      const knownPresets = new Set(mergedPresets().map((p) => p.name));
      for (const role of ROLES) {
        const patch = body[role];
        if (!isRecord(patch)) continue;
        const ref = patch.provider_ref;
        if (typeof ref === "string" && ref && !knownPresets.has(ref)) {
          throw new HttpError(400, `unknown provider preset: ${ref}`);
        }
      }
      let pluginsPatch: PluginSelection | null = null;
      if (body.plugins !== undefined && body.plugins !== null) {
        // shared list (current) or legacy per-role object (merged); may 400
        pluginsPatch = cleanPluginSelection(body.plugins);
      }
      let updated: PublicRuntimeSettings;
      try {
        updated = state.settings.update(body);
      } catch (exc) {
        throw new HttpError(400, errorDetail(exc));
      }
      if (pluginsPatch !== null) {
        // Saves replace the stored list; the deprecated per-role env aliases
        // are an overlay on top and stay out of the file, like other
        // `TWO_BROTHERS_*` env values.
        savedPluginSelection = [...pluginsPatch];
        const effective = [...savedPluginSelection];
        addPluginNames(effective, envPluginNames());
        state.pluginSelection = effective;
        // Per-plugin options travel inside `{path, options}` entries: hand
        // the new selection to the manager before the (re)import so load-time
        // options apply, then (re)import per design (serialized with the
        // startup load by the manager's reload chain).
        state.plugins.setSettings(effective);
        await state.plugins.reload();
      }
      // Persist the plugin selection; role settings were already persisted by
      // RuntimeSettings.update (env-pinned fields stripped by the store).
      // Writing the list shape also drops any legacy per-role keys on disk.
      state.settingsStore.write(state.settings.snapshot(), savedPluginSelection);
      return { ...updated, plugins: [...state.pluginSelection] };
    }),
  );

  routes.push(
    compileRoute("GET", "/api/plugins", async () => {
      await state.pluginsReady;
      const view = state.plugins.describe();
      // Additive diagnostics: load-time notes (deprecations, rejected
      // options) plus the last run's binding notes. Omitted when empty, so
      // the shipped `{plugins, errors}` fields stay byte-compatible.
      const diagnostics = [
        ...state.plugins.diagnostics.map((entry) => `${entry.plugin}: ${entry.message}`),
        ...state.pluginDiagnostics,
      ];
      return diagnostics.length > 0 ? { ...view, diagnostics } : view;
    }),
  );

  // -- routes: skills -------------------------------------------------------------

  routes.push(
    compileRoute("GET", "/api/skills", () => {
      // Metadata only — the skill bodies stay out of the response; they are
      // injected on demand (`renderSkillBody`) and never echoed wholesale.
      const catalog = skillCatalog();
      return {
        skills: catalog.skills.map((skill) => ({
          name: skill.name,
          description: skill.description,
          scope: skill.scope,
          tools: [...skill.tools],
          file: skill.file,
        })),
        diagnostics: [...catalog.diagnostics],
      };
    }),
  );

  // -- routes: slash commands -----------------------------------------------------

  routes.push(
    compileRoute("GET", "/api/commands", () => {
      // Metadata only — the template bodies stay out of the response; the
      // REPL expands one on demand (`expandCommand`).
      const catalog = commandCatalog();
      return {
        commands: catalog.commands.map((command) => ({
          name: command.name,
          description: command.description,
          argumentHint: command.argumentHint,
          ...(command.mode ? { mode: command.mode } : {}),
          file: command.file,
        })),
        diagnostics: [...catalog.diagnostics],
      };
    }),
  );

  // -- routes: provider presets (Stage 17) ----------------------------------------

  routes.push(
    compileRoute("GET", "/api/providers", () => {
      // Seeds first (display order), stored presets layered on top by name.
      return { providers: mergedPresets().map(publicPreset) };
    }),
  );

  routes.push(
    compileRoute("POST", "/api/providers", async (ctx) => {
      const body = await ctx.json();
      if (typeof body.name !== "string" || typeof body.base_url !== "string") throw invalidBody();
      const name = body.name.trim();
      const baseUrl = body.base_url.trim();
      if (!name || !baseUrl) {
        throw new HttpError(400, "name and base_url must not be empty");
      }
      const apiKey = optionalString(body, "api_key");
      const kind = optionalString(body, "kind") ?? PROVIDER_KIND_DEFAULT;
      const models = cleanModelList(body.models);
      const presets = state.settingsStore.readProviders();
      // Duplicates against the merged view: a seeded name is customized with
      // PUT (which materializes a stored override), not created twice.
      if (mergedPresets().some((p) => p.name.toLowerCase() === name.toLowerCase())) {
        throw new HttpError(409, `provider already exists: ${name}`);
      }
      presets.push({ name, base_url: baseUrl, api_key: apiKey ?? "", kind, models });
      state.settingsStore.write(state.settings.snapshot(), undefined, presets);
      return new Respond(201, { provider: publicProvider(presets[presets.length - 1]) });
    }),
  );

  routes.push(
    compileRoute("PUT", "/api/providers/{name}", async (ctx) => {
      const body = await ctx.json();
      const presets = state.settingsStore.readProviders();
      let index = presets.findIndex(
        (p) => p.name.toLowerCase() === ctx.params.name.toLowerCase(),
      );
      if (index === -1) {
        // A seed is a read-only default: editing one materializes a stored
        // override from the seed, so later reads merge it back in place. The
        // seed's literal key is empty; an env-backed seed keeps working
        // because `mergedPresets` re-attaches its `api_key_env` while the
        // stored override carries no key of its own.
        const seed = mergedPresets().find(
          (p) => p.name.toLowerCase() === ctx.params.name.toLowerCase(),
        );
        if (seed === undefined) throw new HttpError(404, "not found");
        presets.push({
          name: seed.name,
          base_url: seed.base_url,
          api_key: seed.api_key,
          kind: seed.kind,
          models: [...seed.models],
        });
        index = presets.length - 1;
      }
      if ("base_url" in body && body.base_url !== undefined && body.base_url !== null) {
        if (typeof body.base_url !== "string") throw invalidBody();
        const baseUrl = body.base_url.trim();
        if (!baseUrl) throw new HttpError(400, "base_url must not be empty");
        presets[index].base_url = baseUrl;
      }
      const apiKey = optionalString(body, "api_key");
      if (apiKey) {
        // omitted or empty keeps the stored key — responses never echo key
        // material, so the form cannot resend it
        presets[index].api_key = apiKey;
      }
      if ("kind" in body && body.kind !== undefined && body.kind !== null) {
        if (typeof body.kind !== "string") throw invalidBody();
        presets[index].kind = body.kind || PROVIDER_KIND_DEFAULT;
      }
      if ("models" in body && body.models !== undefined && body.models !== null) {
        presets[index].models = cleanModelList(body.models);
      }
      state.settingsStore.write(state.settings.snapshot(), undefined, presets);
      // The response mirrors GET's merged view: a seed override keeps its
      // seed's env-backed key status (never the key itself).
      const savedName = presets[index].name.toLowerCase();
      const merged = mergedPresets().find((p) => p.name.toLowerCase() === savedName);
      return { provider: merged !== undefined ? publicPreset(merged) : publicProvider(presets[index]) };
    }),
  );

  routes.push(
    compileRoute("DELETE", "/api/providers/{name}", (ctx) => {
      const presets = state.settingsStore.readProviders();
      const remaining = presets.filter((p) => p.name.toLowerCase() !== ctx.params.name.toLowerCase());
      if (remaining.length === presets.length) throw new HttpError(404, "not found");
      // No dangling refs: roles pointing at the deleted preset are cleared
      // in memory and persisted.
      for (const role of ROLES) {
        const snapshot = state.settings.snapshot();
        if ((snapshot[role].provider_ref ?? "").toLowerCase() === ctx.params.name.toLowerCase()) {
          state.settings.update({ [role]: { provider_ref: "" } });
        }
      }
      state.settingsStore.write(state.settings.snapshot(), undefined, remaining);
      return { removed: ctx.params.name };
    }),
  );

  // -- routes: folder explorer (Stage 17) ------------------------------------------

  function driveRoots(): Array<{ name: string; path: string }> {
    // Mounted Windows drive letters as browse entries (empty elsewhere).
    const roots: Array<{ name: string; path: string }> = [];
    for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
      const drive = `${letter}:\\`;
      if (fs.existsSync(drive)) roots.push({ name: drive, path: drive });
    }
    return roots;
  }

  routes.push(
    compileRoute("GET", "/api/fs/browse", (ctx) => {
      const raw = ctx.query.get("path") ?? "";
      let target: string;
      if (!raw) {
        if (process.platform === "win32") {
          return { path: "", parent: null, entries: driveRoots(), truncated: false };
        }
        target = process.cwd();
      } else {
        target = path.resolve(raw);
      }
      let isDir = false;
      try {
        isDir = fs.statSync(target).isDirectory();
      } catch {
        isDir = false;
      }
      if (!isDir) throw new HttpError(400, "not a directory");
      let children: fs.Dirent[];
      try {
        children = fs.readdirSync(target, { withFileTypes: true });
      } catch {
        // vanished (or denied) between the is_dir check and the listing
        if (!fs.existsSync(target)) throw new HttpError(400, "not a directory");
        children = [];
      }
      const dirs: string[] = [];
      for (const child of children) {
        try {
          if (child.isDirectory()) dirs.push(child.name);
        } catch {
          // unreadable entry — skip silently
        }
      }
      dirs.sort((a, b) => {
        const la = a.toLowerCase();
        const lb = b.toLowerCase();
        return la < lb ? -1 : la > lb ? 1 : 0;
      });
      const truncated = dirs.length > FS_BROWSE_LIMIT;
      const page = truncated ? dirs.slice(0, FS_BROWSE_LIMIT) : dirs;
      const parent = path.dirname(target);
      return {
        path: target,
        parent: parent === target ? null : parent,
        entries: page.map((name) => ({ name, path: path.join(target, name) })),
        truncated,
      };
    }),
  );

  // -- routes: background runs ------------------------------------------------------

  routes.push(
    compileRoute("POST", "/api/runs", async (ctx) => {
      const req = parseRunRequestStrict(await ctx.json());
      ensureWorkspace(req.workspace_id);
      const name = sessionName(req.session);
      const broker = new RunApprovalBroker();
      const record = state.runs.submit(
        req.task,
        name,
        buildRunJob(req.task, name, req, broker),
        effectiveMode(req),
      );
      record.approvals = broker;
      state.metadata.ensure(name, {
        workspaceId: req.workspace_id,
        events: userMessageEvent(req.task),
      });
      return new Respond(202, { run_id: record.runId, session: name, status: record.status });
    }),
  );

  routes.push(
    compileRoute("GET", "/api/runs", (ctx) => {
      const session = ctx.query.get("session");
      const records = state.runs.list();
      // empty string (client sent `?session=`) means "all runs"
      if (!session) return records;
      return records.filter((r) => r.session === session);
    }),
  );

  routes.push(
    compileRoute("GET", "/api/runs/{run_id}", (ctx) => {
      const record = state.runs.get(ctx.params.run_id);
      if (record !== null) return record.public();
      // unknown to the in-memory pool: a backend restart may have dropped the
      // record, so fall back to the durable runtime sidecar
      const recovered = recoverRun(ctx.params.run_id);
      if (recovered === null) throw new HttpError(404, "not found");
      return recovered;
    }),
  );

  routes.push(
    compileRoute("POST", "/api/runs/{run_id}/stop", (ctx) => {
      const record = state.runs.stop(ctx.params.run_id);
      if (record === null) throw new HttpError(404, "not found");
      return { run_id: record.runId, status: record.status };
    }),
  );

  routes.push(
    compileRoute("GET", "/api/runs/{run_id}/approvals", (ctx) => {
      const record = state.runs.get(ctx.params.run_id);
      if (record === null) throw new HttpError(404, "not found");
      const broker = record.approvals as RunApprovalBroker | null;
      const pending =
        broker !== null && typeof broker.pending === "function" ? broker.pending() : [];
      return { run_id: record.runId, pending };
    }),
  );

  routes.push(
    compileRoute("POST", "/api/runs/{run_id}/approvals/{approval_id}", async (ctx) => {
      const body = await ctx.json();
      let allow = true; // pydantic default
      if (body.allow !== undefined && body.allow !== null) {
        if (typeof body.allow !== "boolean") throw invalidBody();
        allow = body.allow;
      }
      const record = state.runs.get(ctx.params.run_id);
      if (record === null || record.approvals === null) throw new HttpError(404, "not found");
      const broker = record.approvals as RunApprovalBroker;
      const decision = broker.respond(
        ctx.params.approval_id,
        allow ? Decision.ALLOW : Decision.DENY,
      );
      if (decision === null) {
        throw new HttpError(404, "unknown or already resolved approval");
      }
      return { approval_id: ctx.params.approval_id, decision };
    }),
  );

  routes.push(
    compileRoute("GET", "/api/runs/{run_id}/events", (ctx) => {
      const record = state.runs.get(ctx.params.run_id);
      if (record === null) throw new HttpError(404, "not found");
      let after = 0;
      const rawAfter = ctx.query.get("after");
      if (rawAfter !== null && rawAfter !== "") {
        after = Number.parseInt(rawAfter, 10);
        if (!Number.isFinite(after) || after < 0) throw invalidBody();
      }
      let sent = after;
      let closed = false;
      ctx.req.on("close", () => {
        closed = true;
        ctx.res.end();
      });
      ctx.res.writeHead(200, SSE_HEADERS);
      // The loop replays the buffered tail, keeps the connection alive with
      // comment frames, and closes once run_end has been delivered (the
      // client may reconnect with ?after=N).
      void (async () => {
        while (!closed) {
          while (sent < record.events.length) {
            sent += 1;
            ctx.res.write(`id: ${sent}\ndata: ${JSON.stringify(record.events[sent - 1])}\n\n`);
          }
          if (record.isDone && sent >= record.events.length) break;
          ctx.res.write(": keepalive\n\n");
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        ctx.res.end();
      })().catch(() => ctx.res.end());
      return HANDLED;
    }),
  );

  // -- static web viewer (web/dist), if built --------------------------------------

  const webDistOption = options.webDist === undefined ? resolveDefaultWebDist() : options.webDist;
  const webDist = webDistOption !== null && fs.existsSync(webDistOption) ? webDistOption : null;

  const MIME: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".map": "application/json",
    ".txt": "text/plain; charset=utf-8",
  };

  function serveStaticFile(res: http.ServerResponse, filePath: string): boolean {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return false;
    }
    if (!stat.isFile()) return false;
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(filePath).toLowerCase()] ?? "application/octet-stream",
      "Content-Length": stat.size,
    });
    fs.createReadStream(filePath).pipe(res);
    return true;
  }

  function handleStatic(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): boolean {
    if (webDist === null || req.method !== "GET") return false;
    const index = path.join(webDist, "index.html");
    if (!fs.existsSync(index)) return false;
    if (pathname === "/") {
      serveStaticFile(res, index);
      return true;
    }
    const candidate = path.join(webDist, pathname.replace(/^\/+/, ""));
    if (pathname.startsWith("/assets/")) {
      if (serveStaticFile(res, candidate)) return true;
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ detail: "Not Found" }));
      return true;
    }
    if (serveStaticFile(res, candidate)) return true;
    // SPA fallback
    serveStaticFile(res, index);
    return true;
  }

  // -- dispatch --------------------------------------------------------------------

  const sseResponses = new Set<http.ServerResponse>();

  function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body === undefined ? null : body);
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(payload);
  }

  function writeError(res: http.ServerResponse, exc: unknown): void {
    if (res.headersSent) {
      res.end();
      return;
    }
    if (exc instanceof HttpError) {
      writeJson(res, exc.status, { detail: exc.message });
      return;
    }
    if (exc instanceof WorkspaceError) {
      writeJson(res, 400, { detail: exc.message });
      return;
    }
    writeJson(res, 500, { detail: errorDetail(exc) });
  }

  async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      size += buf.length;
      if (size > BODY_LIMIT_BYTES) throw invalidBody();
      chunks.push(buf);
    }
    if (chunks.length === 0) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
    } catch {
      throw invalidBody();
    }
    if (!isRecord(parsed)) throw invalidBody();
    return parsed;
  }

  const handler: http.RequestListener = (req, res) => {
    void (async () => {
      let pathname: string;
      let query: URLSearchParams;
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        pathname = url.pathname;
        query = url.searchParams;
      } catch {
        writeJson(res, 400, { detail: "invalid request body" });
        return;
      }
      const method = req.method ?? "GET";
      // Local-request guards (only while every binding is loopback — the
      // operator binding a routable address opts into that exposure, see
      // SECURITY.md):
      // - Host: rebinding an attacker-controlled DNS name to 127.0.0.1 makes
      //   the browser send a foreign Host header; refuse it, so the API is
      //   only reachable under a loopback name.
      // - Origin: a malicious page cannot read responses (no CORS headers),
      //   but simple cross-site requests would still execute state changes;
      //   refuse any non-local browser origin on state-changing methods.
      if (localBindingsOnly()) {
        const hostHeader = req.headers.host;
        if (hostHeader !== undefined && !isLocalHostName(hostHeaderName(hostHeader))) {
          writeJson(res, 403, { detail: "forbidden" });
          return;
        }
        if (method !== "GET" && method !== "HEAD") {
          const origin = req.headers.origin;
          if (origin !== undefined) {
            let originHost = "";
            try {
              originHost = new URL(origin).hostname;
            } catch {
              originHost = "";
            }
            if (!isLocalHostName(originHost)) {
              writeJson(res, 403, { detail: "forbidden" });
              return;
            }
          }
        }
      }
      let pathMatched = false;
      for (const route of routes) {
        const match = route.regex.exec(pathname);
        if (match === null) continue;
        pathMatched = true;
        if (route.method !== method) continue;
        const params: Record<string, string> = {};
        try {
          route.keys.forEach((key, i) => {
            params[key] = decodeURIComponent(match[i + 1]);
          });
        } catch {
          writeJson(res, 400, { detail: "invalid request body" });
          return;
        }
        const ctx: Ctx = { req, res, params, query, json: () => readBody(req) };
        if (route.regex.source.startsWith("^/api/runs/") || pathname === "/api/stream") {
          sseResponses.add(res);
          res.on("close", () => sseResponses.delete(res));
        }
        try {
          const out = await route.handler(ctx);
          if (out === HANDLED) return;
          if (out instanceof Respond) {
            writeJson(res, out.status, out.body);
            return;
          }
          writeJson(res, 200, out);
          return;
        } catch (exc) {
          writeError(res, exc);
          return;
        }
      }
      if (pathMatched) {
        writeJson(res, 405, { detail: "Method Not Allowed" });
        return;
      }
      if (pathname.startsWith("/api/")) {
        writeJson(res, 404, { detail: "Not Found" });
        return;
      }
      if (handleStatic(req, res, pathname)) return;
      writeJson(res, 404, { detail: "Not Found" });
    })().catch((exc) => writeError(res, exc));
  };

  // -- lifecycle -------------------------------------------------------------------

  const servers = new Set<http.Server>();
  // Every address this handle has been bound to (listen() records each one).
  // The local-request guards apply only while all of them are loopback.
  const boundHosts = new Set<string>();

  function localBindingsOnly(): boolean {
    if (boundHosts.size === 0) return true;
    for (const host of boundHosts) {
      if (!isLocalHostName(host)) return false;
    }
    return true;
  }

  return {
    state,
    handler,
    listen(host = "127.0.0.1", port = 0): Promise<http.Server> {
      boundHosts.add(host);
      if (!isLocalHostName(host)) {
        console.warn(
          `[two-brothers] serving on non-loopback address ${host} — the server has ` +
            "no authentication; exposing it beyond this machine is untrusted exposure " +
            "(see SECURITY.md).",
        );
      }
      const server = http.createServer(handler);
      servers.add(server);
      server.on("close", () => servers.delete(server));
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => resolve(server));
      });
    },
    async close(): Promise<void> {
      for (const res of sseResponses) {
        try {
          res.end();
        } catch {
          // already closed
        }
      }
      await Promise.all(
        [...servers].map(
          (server) =>
            new Promise<void>((resolve) => {
              const done = (): void => resolve();
              server.closeAllConnections?.();
              server.close(done);
              // guard: if close stalls (a connection ignored closeAll), resolve anyway
              setTimeout(done, 2000).unref?.();
            }),
        ),
      );
    },
  };
}
