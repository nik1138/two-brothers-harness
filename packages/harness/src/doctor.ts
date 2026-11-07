/**
 * Environment diagnostics: `two-brothers doctor`.
 *
 * A pure, injectable reporter with two entry points:
 *
 *     runDoctor(options)        -> Promise<DoctorReport>   // never throws
 *     formatDoctorReport(report) -> string[]               // stable lines
 *
 * `runDoctor` runs a fixed set of checks in a deterministic order and never
 * prints, never throws and never mutates the environment beyond one
 * write+delete probe under the sessions directory. The network is only
 * touched by the `endpoint` check, through the injectable `fetchImpl`, and is
 * skipped entirely for the `mock` provider.
 *
 * Checks, in order:
 *
 *   engine       Node version against the package `engines` floor (>= 22.19)
 *   settings     sessions/settings.json: missing = warn, valid JSON = pass,
 *                unparseable = fail. The file's bytes are never echoed — a
 *                JSON.parse error message can quote them (API keys included).
 *   sessions-dir writability probe; a missing directory is a warn ("will be
 *                created on first run") because doctor must not create it
 *   roles        per-role provider kind / base URL / model; `mock` needs no
 *                endpoint or models, so it passes
 *   endpoint     `GET {baseUrl}/models` with a timeout, `Authorization:
 *                Bearer ...` only when a key is set; both roles' models are
 *                matched case-insensitively. `mock` skips it; a missing base
 *                URL is a skip (the roles check already fails it).
 *   web-assets   caller-supplied roots (default: the packaged <package>/web
 *                copy, then the repo's web/dist — the same candidates the
 *                server serves) with an index.html
 *   plugins      <cwd>/plugins — optional, so merely a warn when absent
 *
 * API keys are never rendered: role details say "key set"/"key not set" and
 * the endpoint detail never includes request headers or response bodies.
 *
 * `ok` is true when no check has status `fail` (warn/skip do not fail a
 * report). Cross-platform: paths come from `node:path`, missing-path errors
 * are matched by ENOENT/ENOTDIR.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type { Config } from "./config.ts";
import { plainCliStyle, type CliStyle } from "./clistyle.ts";
import type { ThemeToken } from "./tui/theme.ts";
import {
  DEFAULT_PROVIDER_KIND,
  isProviderKind,
  PROVIDER_KIND_HINT,
  type FetchLike,
} from "./provider.ts";

/** Outcome of one diagnostic check. */
export type DoctorStatus = "pass" | "warn" | "fail" | "skip";

/** One reported check. Stable `id`, human `label`, status and optional detail. */
export interface DoctorCheck {
  id: string;
  label: string;
  status: DoctorStatus;
  detail?: string;
}

/** The whole diagnostic result: `ok` iff no check failed. */
export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}

/**
 * Everything `runDoctor` needs, all injectable so tests never touch the
 * network or the real home directory. Relative paths resolve against `cwd`.
 */
export interface DoctorOptions {
  /** Resolved run configuration (see `resolveConfig` / `DEFAULTS`). */
  config: Config;
  /** Sessions directory (default `<cwd>/sessions`). */
  sessionsDir?: string;
  /** Settings file (default `<sessionsDir>/settings.json`). */
  settingsPath?: string;
  /** Built-web-app candidate directories (default: packaged copy, repo build). */
  webRoots?: string[];
  /** Base directory for the relative options above (default `process.cwd()`). */
  cwd?: string;
  /** Transport for the endpoint probe (default the global `fetch`). */
  fetchImpl?: FetchLike;
  /** Endpoint probe timeout in milliseconds (default 5000; non-positive = default). */
  timeoutMs?: number;
  /**
   * Epoch-milliseconds clock used to report endpoint latency. Defaults to
   * `Date.now`; inject a fixed sequence for deterministic reports.
   */
  now?: () => number;
}

/** Endpoint probe timeout used when `timeoutMs` is unset or non-positive. */
export const DEFAULT_DOCTOR_TIMEOUT_MS = 5000;

/** The package `engines` floor (major.minor) the engine check enforces. */
export const NODE_ENGINE_FLOOR = "22.19";

const ROLE_NAMES = ["senior", "junior"] as const;
type Role = (typeof ROLE_NAMES)[number];

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Trimmed string field, or "" for anything else (tolerant for partial configs). */
function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function makeCheck(
  id: string,
  label: string,
  status: DoctorStatus,
  detail?: string,
): DoctorCheck {
  const check: DoctorCheck = { id, label, status };
  if (detail !== undefined) check.detail = detail;
  return check;
}

/** True for "the path does not exist" errors (ENOENT, or ENOTDIR from a parent). */
function isMissingPath(exc: unknown): boolean {
  const code = (exc as NodeJS.ErrnoException | null | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** Short error text for an unexpected crash; never includes configuration secrets. */
function shortError(exc: unknown): string {
  if (exc instanceof Error && exc.message) return exc.message;
  return String(exc);
}

function stripTrailingSlashes(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

function roleKind(config: Config, role: Role): string {
  const own = role === "senior" ? asText(config.seniorKind) : asText(config.juniorKind);
  return own || asText(config.kind) || DEFAULT_PROVIDER_KIND;
}

/** Effective base URL for a role: its own override, else the shared one. */
function roleBaseUrl(config: Config, role: Role): string {
  const own = role === "senior" ? asText(config.seniorBaseUrl) : asText(config.juniorBaseUrl);
  return own || asText(config.baseUrl);
}

function roleModel(config: Config, role: Role): string {
  return role === "senior" ? asText(config.seniorModel) : asText(config.juniorModel);
}

function roleApiKey(config: Config, role: Role): string {
  const own = role === "senior" ? asText(config.seniorApiKey) : asText(config.juniorApiKey);
  return own || asText(config.apiKey);
}

function providerName(config: Config): string {
  return asText(config.provider) || "openai";
}

// ---------------------------------------------------------------------------
// engine
// ---------------------------------------------------------------------------

/**
 * Why `version` is below the package's Node floor, or `null` when it is
 * supported. Exported for the diagnostics tests; comparisons are
 * major-then-minor so `22.19.0` passes and `22.18.9` fails.
 */
export function nodeEngineProblem(
  version: string,
  floor: string = NODE_ENGINE_FLOOR,
): string | null {
  const floorMatch = /^v?(\d+)\.(\d+)/.exec(floor.trim());
  const versionMatch = /^v?(\d+)\.(\d+)/.exec(version.trim());
  if (!versionMatch) return `cannot parse Node version "${version}" (need >= ${floor})`;
  const major = Number(versionMatch[1]);
  const minor = Number(versionMatch[2]);
  if (!floorMatch) return null; // defensive: a bad floor must not fail a run
  const floorMajor = Number(floorMatch[1]);
  const floorMinor = Number(floorMatch[2]);
  if (major > floorMajor || (major === floorMajor && minor >= floorMinor)) return null;
  return `Node ${version} is below the required >= ${floor}`;
}

function checkEngine(): DoctorCheck {
  const version = process.versions.node || "unknown";
  const problem = nodeEngineProblem(version);
  if (problem !== null) {
    return makeCheck(
      "engine",
      "Node engine",
      "fail",
      `${problem} — upgrade Node (the package requires >= ${NODE_ENGINE_FLOOR})`,
    );
  }
  return makeCheck("engine", "Node engine", "pass", `v${version}`);
}

// ---------------------------------------------------------------------------
// settings file
// ---------------------------------------------------------------------------

function checkSettings(filePath: string): DoctorCheck {
  const id = "settings";
  const label = "Settings file";
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf-8");
  } catch (exc) {
    if (isMissingPath(exc)) {
      return makeCheck(
        id,
        label,
        "warn",
        `${filePath} not found — it will be created on the first settings save`,
      );
    }
    return makeCheck(id, label, "fail", `cannot read ${filePath} — check file permissions`);
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) {
      return makeCheck(id, label, "warn", `${filePath} is not a JSON object — it will be ignored`);
    }
    return makeCheck(id, label, "pass", `valid JSON: ${filePath}`);
  } catch {
    // Never surface the parser message: it can quote the file's bytes.
    return makeCheck(id, label, "fail", `${filePath} is not valid JSON — fix or delete it`);
  }
}

// ---------------------------------------------------------------------------
// sessions directory
// ---------------------------------------------------------------------------

function checkSessionsDir(dir: string): DoctorCheck {
  const id = "sessions-dir";
  const label = "Sessions directory";
  try {
    if (!fs.statSync(dir).isDirectory()) {
      return makeCheck(id, label, "fail", `${dir} exists but is not a directory`);
    }
  } catch (exc) {
    if (isMissingPath(exc)) {
      return makeCheck(id, label, "warn", `${dir} not found — it will be created on first run`);
    }
    return makeCheck(id, label, "fail", `cannot inspect ${dir} — check directory permissions`);
  }
  const probe = path.join(
    dir,
    `.doctor-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.tmp`,
  );
  try {
    fs.writeFileSync(probe, "doctor", "utf-8");
  } catch {
    return makeCheck(id, label, "fail", `${dir} is not writable — check directory permissions`);
  }
  try {
    fs.unlinkSync(probe);
  } catch {
    return makeCheck(
      id,
      label,
      "warn",
      `${dir} is writable but the write probe could not be removed (${path.basename(probe)})`,
    );
  }
  return makeCheck(id, label, "pass", `writable: ${dir}`);
}

// ---------------------------------------------------------------------------
// roles
// ---------------------------------------------------------------------------

function checkRoles(config: Config): DoctorCheck {
  const id = "roles";
  const label = "Role configuration";
  const provider = providerName(config);
  if (provider === "mock") {
    return makeCheck(
      id,
      label,
      "pass",
      "provider mock — both roles use the built-in mock; no endpoint or models required",
    );
  }
  if (provider !== "openai") {
    return makeCheck(id, label, "fail", `unknown provider "${provider}" — use openai|mock`);
  }
  const problems: string[] = [];
  const warnings: string[] = [];
  const summaries: string[] = [];
  for (const role of ROLE_NAMES) {
    const kind = roleKind(config, role);
    const baseUrl = roleBaseUrl(config, role);
    const model = roleModel(config, role);
    const apiKey = roleApiKey(config, role);
    if (!isProviderKind(kind)) {
      problems.push(`unknown ${role} provider kind "${kind}" — use ${PROVIDER_KIND_HINT}`);
      continue;
    }
    if (!baseUrl) {
      problems.push(`no ${role} base URL — set it in Settings or pass --base-url / --${role}-base-url`);
    }
    if (!model) {
      warnings.push(`no ${role} model — set it in Settings or pass --${role}-model`);
    }
    summaries.push(`${role}: ${kind}${model ? ` "${model}"` : ""}, key ${apiKey ? "set" : "not set"}`);
  }
  if (problems.length > 0) return makeCheck(id, label, "fail", problems.join("; "));
  if (warnings.length > 0) return makeCheck(id, label, "warn", warnings.join("; "));
  return makeCheck(id, label, "pass", summaries.join("; "));
}

// ---------------------------------------------------------------------------
// endpoint
// ---------------------------------------------------------------------------

/**
 * The endpoint the probe contacts and the key it presents: the shared
 * `baseUrl`/`apiKey` when configured, else the first configured per-role
 * endpoint with that role's key.
 */
function endpointTarget(config: Config): { baseUrl: string; apiKey: string } {
  const sharedBase = asText(config.baseUrl);
  if (sharedBase) return { baseUrl: stripTrailingSlashes(sharedBase), apiKey: asText(config.apiKey) };
  const seniorBase = asText(config.seniorBaseUrl);
  if (seniorBase) {
    return {
      baseUrl: stripTrailingSlashes(seniorBase),
      apiKey: asText(config.seniorApiKey) || asText(config.apiKey),
    };
  }
  const juniorBase = asText(config.juniorBaseUrl);
  if (juniorBase) {
    return {
      baseUrl: stripTrailingSlashes(juniorBase),
      apiKey: asText(config.juniorApiKey) || asText(config.apiKey),
    };
  }
  return { baseUrl: "", apiKey: "" };
}

function normalizeTimeoutMs(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : DEFAULT_DOCTOR_TIMEOUT_MS;
}

/** Tolerant model-id list: array, `{data: [...]}` or `{models: [...]}`. */
function modelIds(payload: unknown): string[] | null {
  let entries: unknown[] | null = null;
  if (Array.isArray(payload)) entries = payload;
  else if (isRecord(payload)) {
    if (Array.isArray(payload.data)) entries = payload.data;
    else if (Array.isArray(payload.models)) entries = payload.models;
  }
  if (entries === null) return null;
  const ids: string[] = [];
  for (const entry of entries) {
    const raw =
      typeof entry === "string" ? entry : isRecord(entry) ? (entry.id ?? entry.name) : undefined;
    if (typeof raw === "string" && raw.trim()) ids.push(normalizeModelId(raw));
  }
  return ids;
}

/** Comparison form of a model id: trimmed, `models/` prefix stripped, lowercased. */
function normalizeModelId(id: string): string {
  return id.trim().replace(/^models\//, "").toLowerCase();
}

function httpHint(status: number): string {
  if (status === 401 || status === 403) return "check the API key";
  if (status === 404) return "check the base URL path (some servers need /v1)";
  if (status === 429) return "rate limited — try again later";
  if (status >= 500) return "the provider is unavailable — try again later";
  return "the endpoint rejected the request";
}

function readClock(clock: () => number): number {
  try {
    const value = clock();
    return Number.isFinite(value) ? value : Date.now();
  } catch {
    return Date.now();
  }
}

/** Outcome of the one bounded `GET {baseUrl}/models` request. */
type EndpointProbe =
  | { kind: "models"; ids: string[]; elapsedMs: number }
  | { kind: "fail"; detail: string }
  | { kind: "warn"; detail: string };

/**
 * One bounded model-discovery request. The timeout covers the whole exchange
 * (headers and body) and is raced against the fetch so a transport that
 * ignores the abort signal cannot hang the doctor. Never throws.
 */
async function probeEndpoint(
  target: { baseUrl: string; apiKey: string },
  timeoutMs: number,
  fetchImpl: FetchLike,
  clock: () => number,
): Promise<EndpointProbe> {
  const url = `${target.baseUrl}/models`;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (target.apiKey) headers.Authorization = `Bearer ${target.apiKey}`;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const timeoutDetail = `timed out after ${timeoutMs} ms — check the base URL and the network`;
  const aborted = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener(
      "abort",
      () => reject(new Error("doctor endpoint probe timed out")),
      { once: true },
    );
  });
  try {
    const startedAt = readClock(clock);
    let response: Response;
    try {
      response = await Promise.race([
        fetchImpl(url, { method: "GET", headers, signal: controller.signal }),
        aborted,
      ]);
    } catch {
      if (timedOut) return { kind: "fail", detail: timeoutDetail };
      return {
        kind: "fail",
        detail: `cannot reach ${url} — check the base URL and that the provider is running`,
      };
    }
    const elapsedMs = Math.max(0, Math.round(readClock(clock) - startedAt));
    if (!response.ok) {
      return { kind: "fail", detail: `HTTP ${response.status} from ${url} — ${httpHint(response.status)}` };
    }
    let payload: unknown;
    try {
      // Race the body read too: a server can send headers and then stall.
      payload = await Promise.race([response.json(), aborted]);
    } catch {
      if (timedOut) return { kind: "fail", detail: timeoutDetail };
      return {
        kind: "warn",
        detail: `GET ${url} returned non-JSON — endpoint reachable, model list unknown`,
      };
    }
    const ids = modelIds(payload);
    if (ids === null) {
      return {
        kind: "warn",
        detail: `GET ${url} returned an unexpected shape — endpoint reachable, model list unknown`,
      };
    }
    return { kind: "models", ids, elapsedMs };
  } finally {
    clearTimeout(timer);
  }
}

async function checkEndpoint(config: Config, options: DoctorOptions): Promise<DoctorCheck> {
  const id = "endpoint";
  const label = "Provider endpoint";
  const provider = providerName(config);
  if (provider === "mock") {
    return makeCheck(id, label, "skip", "provider mock — no endpoint is contacted");
  }
  if (provider !== "openai") {
    return makeCheck(id, label, "skip", `unknown provider "${provider}" — endpoint not checked`);
  }
  const target = endpointTarget(config);
  if (!target.baseUrl) {
    return makeCheck(
      id,
      label,
      "skip",
      "no base URL configured — see the Role configuration check",
    );
  }
  const url = `${target.baseUrl}/models`;
  const timeoutMs = normalizeTimeoutMs(options.timeoutMs);
  const fetchImpl: FetchLike = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const clock = options.now ?? Date.now;
  const probe = await probeEndpoint(target, timeoutMs, fetchImpl, clock);
  if (probe.kind === "fail") return makeCheck(id, label, "fail", probe.detail);
  if (probe.kind === "warn") return makeCheck(id, label, "warn", probe.detail);
  const { ids, elapsedMs } = probe;
  if (ids.length === 0) {
    return makeCheck(id, label, "warn", `GET ${url} reported no models — is the provider ready?`);
  }
  const configured = ROLE_NAMES.map((role) => ({ role, model: roleModel(config, role) })).filter(
    (entry) => entry.model !== "",
  );
  if (configured.length === 0) {
    return makeCheck(
      id,
      label,
      "warn",
      `GET ${url} — ${ids.length} models reported; no senior/junior model configured yet`,
    );
  }
  const available = new Set(ids);
  const missing = configured.filter((entry) => !available.has(normalizeModelId(entry.model)));
  const describe = (entries: typeof configured): string =>
    entries.map((entry) => `${entry.role} "${entry.model}"`).join(", ");
  if (missing.length === configured.length) {
    return makeCheck(
      id,
      label,
      "fail",
      `GET ${url} — none of the configured models reported (${describe(missing)}); run "two-brothers models --base-url ${target.baseUrl}" to list available models`,
    );
  }
  if (missing.length > 0) {
    return makeCheck(
      id,
      label,
      "warn",
      `GET ${url} — ${describe(missing)} not reported by the endpoint; run "two-brothers models --base-url ${target.baseUrl}" to list available models`,
    );
  }
  return makeCheck(
    id,
    label,
    "pass",
    `GET ${url} — ${describe(configured)} found (${ids.length} models, ${elapsedMs} ms)`,
  );
}

// ---------------------------------------------------------------------------
// web assets
// ---------------------------------------------------------------------------

/**
 * Default built-web candidates, resolved from the module location (never the
 * cwd). Same order as the server's `resolveDefaultWebDist`: the packaged
 * `<package>/web` copy first, then the repo's `web/dist` build.
 */
function defaultWebRoots(moduleUrl: string | URL = import.meta.url): string[] {
  const moduleDir = path.dirname(fileURLToPath(moduleUrl));
  const packageDir = path.resolve(moduleDir, "..");
  return [path.join(packageDir, "web"), path.resolve(packageDir, "..", "..", "web", "dist")];
}

function checkWebAssets(roots: string[]): DoctorCheck {
  const id = "web-assets";
  const label = "Web assets";
  if (roots.length === 0) {
    return makeCheck(
      id,
      label,
      "warn",
      'no web asset roots configured — build web/ and pass its dist directory',
    );
  }
  const found: string[] = [];
  for (const root of roots) {
    try {
      if (fs.statSync(path.join(root, "index.html")).isFile()) found.push(root);
    } catch {
      // candidate absent — try the next one
    }
  }
  if (found.length > 0) return makeCheck(id, label, "pass", `found: ${found[0]}`);
  return makeCheck(
    id,
    label,
    "warn",
    `no index.html in ${roots.length} candidate root${roots.length === 1 ? "" : "s"} — run "npm run build" in web/ (and "npm run sync-web" for the package copy)`,
  );
}

// ---------------------------------------------------------------------------
// plugins
// ---------------------------------------------------------------------------

function checkPlugins(cwd: string): DoctorCheck {
  const id = "plugins";
  const label = "Plugins directory";
  const dir = path.join(cwd, "plugins");
  try {
    if (!fs.statSync(dir).isDirectory()) {
      return makeCheck(id, label, "warn", `${dir} is not a directory — plugins are optional`);
    }
    return makeCheck(id, label, "pass", `found: ${dir}`);
  } catch (exc) {
    if (isMissingPath(exc)) {
      return makeCheck(
        id,
        label,
        "warn",
        `${dir} not found — plugins are optional; create it to add plugins`,
      );
    }
    return makeCheck(id, label, "warn", `cannot inspect ${dir} — plugins are optional`);
  }
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

/**
 * Run every check in the documented order. Never throws: each check is
 * isolated, and an unexpected crash becomes a `fail` check with that id.
 */
export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const runCheck = async (
    id: string,
    label: string,
    check: () => DoctorCheck | Promise<DoctorCheck>,
  ): Promise<void> => {
    try {
      checks.push(await check());
    } catch (exc) {
      checks.push(makeCheck(id, label, "fail", `check crashed: ${shortError(exc)}`));
    }
  };
  try {
    const raw = (options ?? {}) as DoctorOptions;
    const config = (raw.config ?? {}) as Config;
    const cwd = path.resolve(asText(raw.cwd) || process.cwd());
    const sessionsDir = asText(raw.sessionsDir)
      ? path.resolve(cwd, asText(raw.sessionsDir))
      : path.join(cwd, "sessions");
    const settingsPath = asText(raw.settingsPath)
      ? path.resolve(cwd, asText(raw.settingsPath))
      : path.join(sessionsDir, "settings.json");
    const providedRoots = Array.isArray(raw.webRoots) ? raw.webRoots : null;
    const webRoots =
      providedRoots === null
        ? defaultWebRoots()
        : providedRoots
            .filter((root): root is string => typeof root === "string" && root.trim() !== "")
            .map((root) => path.resolve(cwd, root));

    await runCheck("engine", "Node engine", () => checkEngine());
    await runCheck("settings", "Settings file", () => checkSettings(settingsPath));
    await runCheck("sessions-dir", "Sessions directory", () => checkSessionsDir(sessionsDir));
    await runCheck("roles", "Role configuration", () => checkRoles(config));
    await runCheck("endpoint", "Provider endpoint", () => checkEndpoint(config, raw));
    await runCheck("web-assets", "Web assets", () => checkWebAssets(webRoots));
    await runCheck("plugins", "Plugins directory", () => checkPlugins(cwd));
  } catch (exc) {
    checks.push(makeCheck("doctor", "Doctor", "fail", `unexpected failure: ${shortError(exc)}`));
  }
  return {
    ok: !checks.some((check) => check.status === "fail"),
    checks,
  };
}

/**
 * Stable human lines, one per check:
 *
 *     [pass] Node engine — v22.19.0
 *     [warn] Settings file — C:\...\settings.json not found — it will be created
 *
 * Formatting is deterministic: status, label, and ` — detail` only when a
 * detail exists. The optional `CliStyle` paints the status tag by severity
 * (pass=success, warn=warning, fail=error, skip=dim) and the label `strong`;
 * it defaults to `plainCliStyle`, so the rendered bytes are unchanged.
 */
export function formatDoctorReport(
  report: DoctorReport,
  style: CliStyle = plainCliStyle,
): string[] {
  const tokenFor = (status: DoctorStatus): ThemeToken => {
    switch (status) {
      case "pass":
        return "success";
      case "warn":
        return "warning";
      case "fail":
        return "error";
      default:
        return "dim";
    }
  };
  return report.checks.map((check) => {
    const suffix = check.detail ? ` — ${check.detail}` : "";
    return (
      `[${style.paint(tokenFor(check.status), check.status)}] ` +
      `${style.paint("strong", check.label)}${suffix}`
    );
  });
}
