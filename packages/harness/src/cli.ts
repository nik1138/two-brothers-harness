#!/usr/bin/env node
/**
 * CLI for the Two Brothers harness. Mirrors the original prototype's CLI
 * (removed 2026-11-04; see git history).
 *
 *   node src/cli.ts run "<task>" [flags]
 *   node src/cli.ts chat [flags]
 *   node src/cli.ts tui [task] [flags]
 *   node src/cli.ts sessions [--sessions-dir sessions]
 *   node src/cli.ts selftest
 *   node src/cli.ts models --base-url <url> [--api-key <key>] [--json]
 *   node src/cli.ts onboard [--sessions-dir sessions] [--preset <id>] [--non-interactive]
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";

import { resolveConfig, maxTokensForRole, validateRunConfig, type Config } from "./config.ts";
import { SharedContext } from "./context.ts";
import type { CompactionSettings } from "./compaction.ts";
import {
  discoverCommands,
  expandCommand,
  matchCommand,
  type CommandCatalog,
} from "./commands.ts";
import { estimateCost, type CostEstimate } from "./cost.ts";
import { TwoBrothersHarness, type PromptAuditEntry, type ToolScopes } from "./harness.ts";
import {
  loadMcpToolSpecs,
  loadMcpTools,
  mergeMcpConfig,
  type McpConfigFileShape,
  type McpToolSet,
} from "./mcp.ts";
import { presetById, presetIds, seedPresets } from "./presets.ts";
import { toNdjsonLine, type StreamEvent } from "./runstream.ts";
import {
  PluginManager,
  type PluginBindings,
  type PluginDiagnosticEntry,
} from "./plugins.ts";
import {
  buildProvider,
  DEFAULT_PROVIDER_KIND,
  isProviderKind,
  listModels,
  PROVIDER_KIND_HINT,
  resolveProviderKind,
  type Provider,
  type Tool,
} from "./provider.ts";
import type { RoleEndpoint } from "./runtime.ts";
import { selftest } from "./selftest.ts";
import { createServer } from "./server.ts";
import { restoreContext, SessionError, SessionStore } from "./session.ts";
import { discoverSkills, type SkillCatalog } from "./skills.ts";
import { envPinnedPairs, SettingsStore } from "./settings_store.ts";
import { runTuiApp } from "./tui/app.ts";
import { tuiHelpLines } from "./tui/keymap.ts";

const OPTIONS = {
  provider: { type: "string" as const },
  "provider-kind": { type: "string" as const },
  "senior-kind": { type: "string" as const },
  "junior-kind": { type: "string" as const },
  "base-url": { type: "string" as const },
  "api-key": { type: "string" as const },
  "senior-base-url": { type: "string" as const },
  "senior-api-key": { type: "string" as const },
  "junior-base-url": { type: "string" as const },
  "junior-api-key": { type: "string" as const },
  "senior-model": { type: "string" as const },
  "junior-model": { type: "string" as const },
  "senior-system": { type: "string" as const },
  "junior-system": { type: "string" as const },
  "max-rounds": { type: "string" as const },
  "max-tokens": { type: "string" as const },
  temperature: { type: "string" as const },
  timeout: { type: "string" as const },
  retries: { type: "string" as const },
  mode: { type: "string" as const },
  verbose: { type: "boolean" as const, default: false },
  json: { type: "boolean" as const, default: false },
  "json-events": { type: "boolean" as const, default: false },
  stream: { type: "boolean" as const, default: false },
  "stream-tokens": { type: "boolean" as const, default: false },
  "session-file": { type: "string" as const },
  resume: { type: "boolean" as const, default: false },
  compact: { type: "boolean" as const, default: false },
  "compact-threshold": { type: "string" as const },
  "compact-threshold-tokens": { type: "string" as const },
  "compact-keep-recent": { type: "string" as const },
  "context-window": { type: "string" as const },
  "mcp-config": { type: "string" as const },
  "plugins-dir": { type: "string" as const },
  "skills-dir": { type: "string" as const, multiple: true },
  "commands-dir": { type: "string" as const, multiple: true },
};

const FLAG_TO_CONFIG: Record<string, string> = {
  provider: "provider",
  "provider-kind": "kind",
  "senior-kind": "seniorKind",
  "junior-kind": "juniorKind",
  "base-url": "baseUrl",
  "api-key": "apiKey",
  "senior-base-url": "seniorBaseUrl",
  "senior-api-key": "seniorApiKey",
  "junior-base-url": "juniorBaseUrl",
  "junior-api-key": "juniorApiKey",
  "senior-model": "seniorModel",
  "junior-model": "juniorModel",
  "senior-system": "seniorSystem",
  "junior-system": "juniorSystem",
  "max-rounds": "maxRounds",
  "max-tokens": "maxTokens",
  temperature: "temperature",
  timeout: "timeout",
  retries: "retries",
  mode: "mode",
  verbose: "verbose",
  json: "jsonOut",
  "session-file": "sessionFile",
  resume: "resume",
  compact: "compact",
  "compact-threshold": "compactThreshold",
  "compact-threshold-tokens": "compactThresholdTokens",
  "compact-keep-recent": "compactKeepRecent",
  "context-window": "contextWindow",
};

/** Output sink so commands can be driven in-process by tests. */
export interface CliIO {
  log(line: string): void;
  error(line: string): void;
}

const defaultIO: CliIO = {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

/**
 * One line per provider call: the assembled section names, the tool belt
 * offered, and both prompt lengths. Names and sizes only — never bodies.
 */
function renderPromptAudits(audits: PromptAuditEntry[]): string {
  if (audits.length === 0) return "";
  const lines = ["prompt audits:"];
  for (const audit of audits) {
    const tools = audit.tools.length > 0 ? audit.tools.join(", ") : "(none)";
    lines.push(
      `  ${audit.role} ${audit.kind}: ${audit.sections.join(" > ")}; tools: ${tools}; ` +
        `system ${audit.systemChars} chars, user ${audit.userChars} chars`,
    );
  }
  return lines.join("\n");
}

function renderMessages(messages: Array<Record<string, any>>, verbose: boolean): string {
  const out: string[] = [];
  for (const msg of messages) {
    const frm = msg.from;
    const to = msg.to;
    const kind = msg.kind;
    const payload = msg.payload ?? {};

    if (kind === "message" && frm === "user") {
      out.push(`[user]      ${payload.text ?? ""}`);
      continue;
    }

    out.push(`[${frm} -> ${to}] ${kind}`);
    if (verbose) out.push("    " + JSON.stringify(payload));

    if (kind === "consult") {
      out.push(`    ask: ${payload.ask ?? ""}`);
      out.push(`    expect: ${payload.expect ?? "proposal"}`);
    } else if (kind === "proposal") {
      out.push(`    title: ${payload.title ?? ""}`);
      out.push(`    answer: ${payload.answer ?? ""}`);
      if (payload.rationale) out.push(`    rationale: ${payload.rationale}`);
      if (payload.risks) {
        out.push("    risks:");
        for (const risk of payload.risks) out.push(`      - ${risk}`);
      }
      out.push(`    confidence: ${payload.confidence ?? ""}`);
      if (payload.asks) {
        out.push("    asks:");
        for (const ask of payload.asks) out.push(`      - ${ask}`);
      }
    } else if (kind === "delegation") {
      out.push(`    work: ${payload.work ?? ""}`);
      out.push("    acceptance:");
      for (const acceptance of payload.acceptance ?? []) out.push(`      - ${acceptance}`);
    } else if (kind === "deliverable") {
      out.push(`    result: ${payload.result ?? ""}`);
      if (payload.artifacts) {
        out.push("    artifacts:");
        for (const artifact of payload.artifacts) out.push(`      - ${artifact}`);
      }
      out.push(`    confidence: ${payload.confidence ?? ""}`);
    } else if (kind === "review") {
      out.push(`    verdict: ${payload.verdict ?? ""}`);
      out.push(`    notes: ${payload.notes ?? ""}`);
    } else if (kind === "decision") {
      out.push(`    decision: ${payload.decision ?? ""}`);
      out.push(`    rationale: ${payload.rationale ?? ""}`);
      out.push(`    confidence: ${payload.confidence ?? ""}`);
      out.push(`    dissent: ${payload.dissent ?? "(none)"}`);
      if (payload.accepted_proposals) {
        out.push("    accepted_proposals:");
        for (const proposal of payload.accepted_proposals) out.push(`      - ${proposal}`);
      }
    }
  }
  return out.join("\n");
}

function argsToConfigArgs(values: Record<string, any>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [flag, configKey] of Object.entries(FLAG_TO_CONFIG)) {
    // "print"/"json" are output modes for `run`, not cooperation modes —
    // leave cfg.mode at its default (or the env value) in that case
    if (flag === "mode" && isOutputMode(values[flag])) continue;
    if (values[flag] !== undefined) result[configKey] = values[flag];
  }
  return result;
}

/** Non-interactive output modes (pi-style print mode): "print" streams only
 * the final decision text, "json" one machine-readable JSON object, "stream"
 * NDJSON run events as they happen (`runstream.ts`, `run --stream`). */
export type OutputMode = "text" | "print" | "json" | "stream";

function isOutputMode(value: unknown): value is "print" | "json" {
  return value === "print" || value === "json";
}

function resolveOutputMode(values: Record<string, unknown>): OutputMode {
  if (values.stream === true) return "stream";
  if (values["json-events"] === true) return "json";
  // An explicit output mode wins, so the documented `--mode print --json`
  // (decision object only) keeps working. A BARE `--json` is shorthand for
  // `--mode json`: the full machine-readable object, never a print-mode
  // modifier that leaves the human transcript on stdout.
  if (isOutputMode(values.mode)) return values.mode;
  if (values.json === true) return "json";
  return "text";
}

/**
 * Per-role endpoints from the four Stage 18 CLI flags (and their
 * `TWO_BROTHERS_SENIOR_*` / `TWO_BROTHERS_JUNIOR_*` env equivalents, picked
 * up by `resolveConfig`). Env/flags pin these — they are never persisted
 * (the CLI has no settings store). Empty fields fall back per role to the
 * shared config inside the harness/validation, so `--senior-base-url` alone
 * leaves the junior on `--base-url`. Returns undefined when no per-role
 * field is set (the shared-config path, unchanged behavior).
 */
function cliEndpoints(cfg: Config): { senior: RoleEndpoint; junior: RoleEndpoint } | undefined {
  if (!cfg.seniorBaseUrl && !cfg.seniorApiKey && !cfg.juniorBaseUrl && !cfg.juniorApiKey) {
    return undefined;
  }
  return {
    senior: {
      provider: cfg.provider,
      baseUrl: cfg.seniorBaseUrl,
      apiKey: cfg.seniorApiKey,
      model: cfg.seniorModel,
    },
    junior: {
      provider: cfg.provider,
      baseUrl: cfg.juniorBaseUrl,
      apiKey: cfg.juniorApiKey,
      model: cfg.juniorModel,
    },
  };
}

/**
 * Per-role provider instances for the native families. The harness builds
 * OpenAI-compatible providers from `endpoints` itself (and dispatches the
 * shared config through `buildProvider`), but its endpoint path knows only
 * `openai`/`mock`; anthropic and google roles therefore travel through the
 * harness's per-role provider override seam (`options.senior`/`junior`).
 * Roles on the default family are left alone so the existing path is
 * byte-stable — unless a per-role output cap (`TWO_BROTHERS_SENIOR_MAX_TOKENS`
 * / `_JUNIOR_MAX_TOKENS`) applies: the harness's provider construction takes
 * only the run-level cap, so a capped role's provider is built here instead.
 */
function nativeProviders(
  cfg: Config,
  endpoints: { senior: RoleEndpoint; junior: RoleEndpoint } | undefined,
  onWarning?: (line: string) => void,
): { senior?: Provider; junior?: Provider } {
  if (cfg.provider !== "openai") return {}; // mock roles never reach the network
  const out: { senior?: Provider; junior?: Provider } = {};
  for (const role of ["senior", "junior"] as const) {
    const kind = resolveProviderKind(cfg, role);
    const maxTokens = maxTokensForRole(cfg, role);
    if (kind === DEFAULT_PROVIDER_KIND && maxTokens === undefined) continue;
    const endpoint = endpoints?.[role];
    out[role] = buildProvider(
      {
        provider: cfg.provider,
        kind,
        baseUrl: endpoint?.baseUrl || cfg.baseUrl,
        apiKey: endpoint?.apiKey || cfg.apiKey,
        seniorModel: cfg.seniorModel,
        juniorModel: cfg.juniorModel,
        model: endpoint?.model || (role === "senior" ? cfg.seniorModel : cfg.juniorModel),
        temperature: cfg.temperature,
        timeout: cfg.timeout,
        retries: cfg.retries,
        contextWindow: cfg.contextWindow,
        maxTokens,
        ...(onWarning ? { onWarning } : {}),
      },
      role,
    );
  }
  return out;
}

/**
 * Compaction settings from the CLI flags (and their `TWO_BROTHERS_COMPACT*` /
 * `TWO_BROTHERS_CONTEXT_WINDOW` env equivalents): `--compact` forces one
 * compaction at the start, `--compact-threshold <chars>` auto-compacts
 * whenever the rendered context passes that size, and
 * `--compact-threshold-tokens <n>` / `--context-window <n>` switch to token
 * mode (trigger in estimated tokens; the char flags are then ignored).
 * Nothing is returned when none is set (the harness then never compacts —
 * the default).
 */
function compactionOptions(cfg: Config): CompactionSettings | undefined {
  if (
    !cfg.compact &&
    cfg.compactThreshold <= 0 &&
    cfg.compactThresholdTokens <= 0 &&
    cfg.contextWindow <= 0
  ) {
    return undefined;
  }
  return {
    ...(cfg.compact ? { force: true } : {}),
    ...(cfg.compactThreshold > 0 ? { thresholdChars: cfg.compactThreshold } : {}),
    ...(cfg.compactKeepRecent > 0 ? { keepRecentChars: cfg.compactKeepRecent } : {}),
    ...(cfg.compactThresholdTokens > 0 ? { thresholdTokens: cfg.compactThresholdTokens } : {}),
    ...(cfg.contextWindow > 0 ? { contextWindow: cfg.contextWindow } : {}),
  };
}

function openSession(cfg: Config, io: CliIO): SharedContext {
  if (!cfg.sessionFile) return new SharedContext();
  const store = new SessionStore(cfg.sessionFile);
  if (store.exists() && !cfg.resume) {
    throw new SessionError(
      `session file already exists: ${cfg.sessionFile} ` +
        "(use --resume to continue it, or delete it to start a new session)",
    );
  }
  if (cfg.resume) {
    if (store.exists()) return restoreContext(store);
    io.error(`[warn] no session to resume at ${cfg.sessionFile}; starting a new session`);
    return new SharedContext(store);
  }
  return new SharedContext(store);
}

// --------------------------------------------------------------------------- //
// plugins + skills for run/chat (the server owns the same wiring in server.ts)
// --------------------------------------------------------------------------- //

/**
 * Plugin directory for a run: `--plugins-dir` > `TWO_BROTHERS_PLUGINS_DIR`
 * > `<cwd>/plugins` (the repo convention). Env and flags are pinned like
 * every other `TWO_BROTHERS_*` value — never persisted.
 */
export function pluginsDirForCli(
  values: Record<string, any>,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const flag = typeof values["plugins-dir"] === "string" ? values["plugins-dir"].trim() : "";
  const envDir = (env.TWO_BROTHERS_PLUGINS_DIR ?? "").trim();
  return path.resolve(flag || envDir || path.join(process.cwd(), "plugins"));
}

/**
 * Skill roots for a run: every `--skills-dir` (repeatable), then
 * `TWO_BROTHERS_SKILLS_DIR` (roots separated by the OS path-list separator —
 * `;` on Windows, `:` elsewhere), then `<cwd>/skills` and
 * `~/.two-brothers/skills`. `discoverSkills` ignores missing roots and
 * dedupes by resolved path.
 */
export function skillsRootsForCli(
  values: Record<string, any>,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const roots: string[] = [];
  const flags = Array.isArray(values["skills-dir"]) ? (values["skills-dir"] as unknown[]) : [];
  for (const raw of flags) {
    const dir = String(raw ?? "").trim();
    if (dir) roots.push(dir);
  }
  const envDirs = (env.TWO_BROTHERS_SKILLS_DIR ?? "").trim();
  if (envDirs) {
    for (const part of envDirs.split(path.delimiter)) {
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
 * Command roots for a REPL session: every `--commands-dir` (repeatable), then
 * `TWO_BROTHERS_COMMANDS_DIR` (roots separated by the OS path-list separator,
 * the `TWO_BROTHERS_SKILLS_DIR` convention), then `<cwd>/commands` and
 * `~/.two-brothers/commands`. Env and flags are pinned like every other
 * `TWO_BROTHERS_*` value — never persisted. `discoverCommands` ignores
 * missing roots.
 */
export function commandsRootsForCli(
  values: Record<string, any>,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const roots: string[] = [];
  const flags = Array.isArray(values["commands-dir"])
    ? (values["commands-dir"] as unknown[])
    : [];
  for (const raw of flags) {
    const dir = String(raw ?? "").trim();
    if (dir) roots.push(dir);
  }
  const envDirs = (env.TWO_BROTHERS_COMMANDS_DIR ?? "").trim();
  if (envDirs) {
    for (const part of envDirs.split(path.delimiter)) {
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

/** Truthy `TWO_BROTHERS_*` boolean env value (the `coerce` convention). */
function envFlag(env: NodeJS.ProcessEnv, name: string): boolean {
  const raw = (env[name] ?? "").trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes" || raw === "on";
}

/**
 * Token-level streaming request: the `--stream-tokens` flag or its pinned
 * env default `TWO_BROTHERS_STREAM_TOKENS`. Only meaningful with `--stream`
 * (the run-stream NDJSON sink is what carries the `token` records), so the
 * caller treats it as a usage error otherwise.
 */
export function streamTokensForCli(
  values: Record<string, any>,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return values["stream-tokens"] === true || envFlag(env, "TWO_BROTHERS_STREAM_TOKENS");
}

/** One `run`/`chat` process's plugin + skill resources. */
export interface CliRunResources {
  /** Loaded plugin manager, or null when discovery failed (fail-soft). */
  plugins: PluginManager | null;
  /** Discovered skills (possibly empty; diagnostics ride along). */
  skills: SkillCatalog;
}

/**
 * Load the CLI's plugins and skills once per process (run = one; chat =
 * shared by every turn). Fail-soft by contract: a missing/broken plugins
 * directory never blocks a run, and diagnostics are printed only under
 * `--verbose` so normal output stays byte-stable.
 */
export async function loadRunResources(
  cfg: Config,
  values: Record<string, any>,
  io: CliIO,
): Promise<CliRunResources> {
  const skills = discoverSkills(skillsRootsForCli(values));
  const dir = pluginsDirForCli(values);
  let plugins: PluginManager | null = null;
  try {
    plugins = await PluginManager.create(dir);
  } catch (exc) {
    if (cfg.verbose) {
      const message = exc instanceof Error ? exc.message : String(exc);
      io.error(`[plugin] cannot load ${dir}: ${message}`);
    }
  }
  if (cfg.verbose) {
    for (const entry of plugins?.errors ?? []) io.error(`[plugin] ${entry.plugin}: ${entry.error}`);
    for (const entry of plugins?.diagnostics ?? []) {
      io.error(`[plugin] ${entry.plugin}: ${entry.message}`);
    }
    if (plugins !== null && plugins.plugins.size > 0) {
      io.error(`[plugin] ${plugins.plugins.size} loaded from ${dir}`);
    }
    for (const line of skills.diagnostics) io.error(`[skills] ${line}`);
    if (skills.skills.length > 0) {
      io.error(`[skills] ${skills.skills.length} discovered from ${skillsRootsForCli(values).join(", ")}`);
    }
  }
  return { plugins, skills };
}

/**
 * Fold a binding pass's scope buckets into the MCP-derived `toolScopes`
 * registry. A `shared` plugin tool joins both belts; `senior` / `junior`
 * tools stay on their own side (legacy positional roles already bucketed as
 * shared by `effectiveToolScope`). Empty buckets are dropped so the harness
 * keeps its "no scopes configured" defaults.
 */
export function mergePluginScopes(
  scopes: ToolScopes,
  bindings: PluginBindings,
): ToolScopes {
  const merge = (current: Tool[] | undefined, extra: Tool[]): Tool[] | undefined => {
    const merged = [...(current ?? []), ...extra];
    return merged.length > 0 ? merged : undefined;
  };
  return {
    shared: merge(scopes.shared, bindings.toolsByScope.shared),
    senior: merge(scopes.senior, bindings.toolsByScope.senior),
    junior: merge(scopes.junior, bindings.toolsByScope.junior),
  };
}

/** The active plugin names for a CLI run: every discovered plugin (no store). */
function activePluginNames(manager: PluginManager): string[] {
  return [...manager.plugins.keys()];
}

/** Loose view of a `UsageTotals` (or an empty object) for CLI rendering. */
interface UsageView {
  input_tokens?: unknown;
  output_tokens?: unknown;
  cached_tokens?: unknown;
  model_calls?: unknown;
}

function usageInt(value: unknown): number {
  const num = Number(value ?? 0) || 0;
  return Number.isFinite(num) ? num : 0;
}

function usageLine(usage: UsageView): string {
  const inp = usageInt(usage.input_tokens);
  const out = usageInt(usage.output_tokens);
  const cached = usageInt(usage.cached_tokens);
  const calls = usageInt(usage.model_calls);
  const pct = inp ? Math.min(100, Math.round((cached * 100) / inp)) : 0;
  return `tokens: ${inp}/${out} (cache ${pct}%, ${calls} model calls)`;
}

/**
 * The run's cost estimate, when the merged usage can be attributed to one
 * model: both roles must resolve to the same id (the run result carries one
 * merged counter set, not per-role splits, so a mixed-model run honestly
 * reports no estimate). `null` when unknown — the caller prints no line and
 * JSON carries `null`.
 */
export function estimateRunCost(cfg: Config, usage: UsageView): CostEstimate | null {
  const model = cfg.seniorModel.trim();
  if (!model || model !== cfg.juniorModel.trim()) return null;
  return estimateCost(model, {
    promptTokens: usageInt(usage.input_tokens),
    completionTokens: usageInt(usage.output_tokens),
  });
}

/** `cost: $0.0300 (in 4000 / out 2000 tokens)`, or null when not estimable. */
export function costLine(cfg: Config, usage: UsageView): string | null {
  const cost = estimateRunCost(cfg, usage);
  if (cost === null) return null;
  return (
    `cost: $${cost.totalCost.toFixed(4)} ` +
    `(in ${usageInt(usage.input_tokens)} / out ${usageInt(usage.output_tokens)} tokens)`
  );
}

/**
 * A per-run provider diagnostic sink: `[warn]` lines reach stderr (never
 * stdout, so `--mode json` / `--json` / `--stream` stay parseable), at most
 * three per run. These are diagnostics, not `--verbose` output — a slow
 * endpoint should say something without the operator opting in.
 */
function providerWarningSink(io: CliIO, limit = 3): (line: string) => void {
  let emitted = 0;
  return (line) => {
    if (emitted >= limit) return;
    emitted += 1;
    io.error(line);
  };
}

/** Options for one `runOnce` turn (`run`, and every chat REPL turn). */
export interface RunOnceOptions {
  /** `--mcp-config` file path. */
  mcpConfig?: string;
  outputMode?: OutputMode;
  resources?: CliRunResources;
  /** `--stream-tokens`: token deltas as `token` stream records (needs `--stream`). */
  streamTokens?: boolean;
  /** Per-turn cooperation mode; a command's frontmatter `mode` overrides it. */
  mode?: Config["mode"];
}

async function runOnce(
  cfg: Config,
  task: string,
  io: CliIO,
  context?: SharedContext,
  options: RunOnceOptions = {},
): Promise<number> {
  const { mcpConfig, resources, streamTokens = false } = options;
  const outputMode = options.outputMode ?? "text";
  // A command's `mode` applies to this turn only — the shared config object
  // stays untouched for the next REPL turn.
  if (options.mode !== undefined) cfg = { ...cfg, mode: options.mode };
  // validate before connecting to MCP servers so a misconfigured run fails
  // fast instead of opening stdio connections first
  const endpoints = cliEndpoints(cfg);
  validateRunConfig(cfg, endpoints);
  // `run --stream`: one NDJSON line per run event, printed as it happens. The
  // human summary and cost line are suppressed below — the terminal `result`
  // event carries usage, and consumers compute cost via `estimateCost`.
  const onStreamEvent =
    outputMode === "stream"
      ? (event: StreamEvent): void => io.log(toNdjsonLine(event))
      : undefined;
  // Plugin contribution for this run: hooks and MCP server declarations for
  // every run, tools only when the run is workspace-bound (the CLI has no
  // workspace option, so a CLI run gets no plugin tools — a `serve` run over
  // a workspace does). Fail-soft.
  let bindings: PluginBindings | null = null;
  if (resources?.plugins !== null && resources?.plugins !== undefined) {
    try {
      bindings = await resources.plugins.bindingsFor(activePluginNames(resources.plugins), null);
      if (cfg.verbose) {
        for (const entry of bindings.diagnostics as PluginDiagnosticEntry[]) {
          io.error(`[plugin] ${entry.plugin}: ${entry.message}`);
        }
      }
    } catch (exc) {
      io.error(`[warn] plugins: ${exc instanceof Error ? exc.message : String(exc)}`);
    }
  }
  // MCP after the binding pass: the configured `--mcp-config` base first (a
  // missing/invalid file keeps the run going, and plugin-declared servers
  // still load), then the plugin-contributed declarations. A configured
  // server wins a name collision; merge notes go to stderr.
  let mcp: McpToolSet | null = null;
  let toolScopes: ToolScopes = {};
  const pluginServers = bindings?.mcpServers ?? [];
  if (mcpConfig || pluginServers.length > 0) {
    let base: McpConfigFileShape | null = null;
    if (mcpConfig) {
      try {
        base = { mcpServers: loadMcpToolSpecs(mcpConfig) };
      } catch (exc) {
        // a missing/invalid config file warns; the run continues text-only
        io.error(`[warn] MCP: ${exc instanceof Error ? exc.message : String(exc)}`);
      }
    }
    const merged = mergeMcpConfig(base, pluginServers);
    for (const line of merged.diagnostics) io.error(`[warn] ${line}`);
    try {
      mcp = await loadMcpTools(merged.config);
      toolScopes.shared = mcp.sharedTools;
      toolScopes.senior = mcp.seniorTools;
      toolScopes.junior = mcp.juniorTools;
    } catch (exc) {
      io.error(`[warn] MCP: ${exc instanceof Error ? exc.message : String(exc)}`);
    }
  }
  // Plugin tools join after the MCP scopes (shared/senior/junior buckets).
  if (bindings !== null) toolScopes = mergePluginScopes(toolScopes, bindings);
  try {
    const hasScopes = Object.values(toolScopes).some((list) => list !== undefined);
    const compaction = compactionOptions(cfg);
    const providerWarnings = providerWarningSink(io);
    const native = nativeProviders(cfg, endpoints, providerWarnings);
    const harness = new TwoBrothersHarness(cfg, {
      onProviderWarning: providerWarnings,
      ...(hasScopes ? { toolScopes } : {}),
      ...(endpoints ? { endpoints } : {}),
      ...native,
      ...(compaction ? { compaction } : {}),
      ...(bindings ? { hooks: bindings.hooks } : {}),
      ...(resources?.skills ? { skills: resources.skills } : {}),
      ...(onStreamEvent ? { onStreamEvent } : {}),
      ...(streamTokens ? { streamTokens: true } : {}),
    });
    const result = await harness.run(task, context);
    // connections stay open for the whole run; closed in the finally below
    for (const err of mcp?.errors ?? []) io.error(`[warn] ${err}`);
    for (const warning of result.warnings) io.error(`[warn] ${warning}`);
    const failed = result.errors.length > 0;
    if (outputMode === "stream") {
      // every event, the terminal `result` included, already went to stdout
      // as one NDJSON line; diagnostics stayed on stderr
      return failed ? 1 : 0;
    }
    if (outputMode === "json") {
      // one machine-readable object on stdout; diagnostics stay on stderr
      io.log(
        JSON.stringify({
          task: result.task,
          events: result.messages,
          decision: result.decision,
          usage: result.usage,
          cost: estimateRunCost(cfg, result.usage ?? {}),
          rounds: result.rounds,
          errors: result.errors,
        }),
      );
      return failed ? 1 : 0;
    }
    if (outputMode === "print") {
      for (const err of result.errors) io.error(`[warn] ${err}`);
      io.error(usageLine(result.usage ?? {})); // stdout carries decision only
      const cost = costLine(cfg, result.usage ?? {});
      if (cost) io.error(cost);
      if (cfg.jsonOut) {
        io.log(JSON.stringify(result.decision));
      } else {
        const text =
          typeof result.decision?.decision === "string" ? result.decision.decision : "";
        io.log(text || JSON.stringify(result.decision));
      }
      return failed ? 1 : 0;
    }
    io.log(
      renderMessages(
        result.messages as unknown as Array<Record<string, any>>,
        cfg.verbose,
      ),
    );
    if (cfg.verbose) {
      const audits = renderPromptAudits(result.promptAudits);
      if (audits) io.log(audits);
    }
    for (const err of result.errors) io.error(`[warn] ${err}`);
    if (!cfg.jsonOut) {
      io.log(usageLine(result.usage ?? {}));
      const cost = costLine(cfg, result.usage ?? {});
      if (cost) io.log(cost);
    }
    if (cfg.jsonOut) io.log(JSON.stringify(result.decision));
    return failed ? 1 : 0;
  } finally {
    await mcp?.client.close();
  }
}

async function doRun(argv: string[], io: CliIO): Promise<number> {
  let values: Record<string, any>;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: OPTIONS,
    }) as { values: Record<string, any>; positionals: string[] });
  } catch (exc) {
    io.error(`[error] ${exc instanceof Error ? exc.message : String(exc)}`);
    io.error('Usage: two-brothers run "<task>" [flags]  (see: two-brothers help)');
    return 2;
  }
  const cfg = resolveConfig(argsToConfigArgs(values));
  const task = positionals.join(" ").trim();
  if (
    values.stream === true &&
    (values.json === true || values["json-events"] === true || isOutputMode(values.mode))
  ) {
    io.error(
      "Error: --stream is its own non-interactive output mode; pick one of --stream, --json/--json-events or --mode print|json.",
    );
    return 2;
  }
  // Token-level streaming rides the run stream: without --stream there is no
  // consumer, so it mirrors the --stream × --json usage-error pattern.
  const streamTokens = streamTokensForCli(values);
  if (streamTokens && values.stream !== true) {
    io.error(
      "Error: --stream-tokens only applies to --stream; add --stream (env TWO_BROTHERS_STREAM_TOKENS is pinned like a flag).",
    );
    return 2;
  }
  if (!task) {
    io.error('Error: no task given. Usage: run "<task>"');
    return 2;
  }
  try {
    const context = openSession(cfg, io);
    const resources = await loadRunResources(cfg, values, io);
    return await runOnce(cfg, task, io, context, {
      ...(values["mcp-config"] ? { mcpConfig: values["mcp-config"] } : {}),
      outputMode: resolveOutputMode(values),
      resources,
      streamTokens,
    });
  } catch (exc) {
    if (exc instanceof SessionError) {
      io.error(`[error] ${exc.message}`);
      return 1;
    }
    throw exc;
  }
}

async function doChat(argv: string[], io: CliIO): Promise<number> {
  let values: Record<string, any>;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: { ...OPTIONS, help: { type: "boolean" as const, default: false } },
    }) as { values: Record<string, any> });
  } catch (exc) {
    io.error(`[error] ${exc instanceof Error ? exc.message : String(exc)}`);
    io.error("Usage: two-brothers chat [flags]  (see: two-brothers chat --help)");
    return 2;
  }
  if (values.help === true) {
    printChatHelp(io);
    return 0;
  }
  const cfg = resolveConfig(argsToConfigArgs(values));
  // `--stream-tokens` is a `run --stream` option; a REPL turn prints the
  // human transcript, so there is no stream sink to carry token records.
  // (The env default stays a run-mode default for the same reason.)
  if (values["stream-tokens"] === true) {
    io.error(
      "Error: --stream-tokens only applies to run --stream; the chat REPL has no stream output.",
    );
    return 2;
  }
  let context: SharedContext;
  try {
    context = openSession(cfg, io);
  } catch (exc) {
    if (exc instanceof SessionError) {
      io.error(`[error] ${exc.message}`);
      return 1;
    }
    throw exc;
  }
  // Plugins + skills load once per REPL process; every turn reuses them.
  const resources = await loadRunResources(cfg, values, io);
  // Slash commands are discovered once per REPL session (a new `<name>.md`
  // needs a new session, unlike the per-turn plugin collection).
  const commandRoots = commandsRootsForCli(values);
  const commands = discoverCommands(commandRoots);
  if (cfg.verbose) {
    for (const line of commands.diagnostics) io.error(`[commands] ${line}`);
    if (commands.commands.length > 0) {
      io.error(
        `[commands] ${commands.commands.length} discovered from ${commandRoots.join(", ")}`,
      );
    }
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  io.log("Two Brothers REPL. Enter a task (empty line or exit to quit).");
  printResolvedRoles(cfg, io);
  // `for await` over the interface (not question-per-loop): lines that arrive
  // while a run is in progress stay buffered, so piped scripts can script the
  // REPL; question() would drop them. The prompt is only displayed on an
  // interactive terminal — echoed onto a piped transcript it would glue the
  // first output line onto the prompt line.
  const showPrompt = process.stdin.isTTY === true;
  rl.setPrompt("task> ");
  if (showPrompt) rl.prompt();
  // One line per discovered command: `name — description (argument-hint)`.
  const commandList = (): string =>
    commands.commands.length === 0
      ? "  (none discovered: add <name>.md to a commands directory)"
      : commands.commands
          .map(
            (found) =>
              `  ${found.name} — ${found.description}` +
              (found.argumentHint ? ` (${found.argumentHint})` : ""),
          )
          .join("\n");
  // eslint-disable-next-line no-constant-condition
  for await (const line of rl) {
    const trimmed = line.trim();
    const command = trimmed.toLowerCase();
    if (!trimmed || ["exit", "quit", "q", "/exit", "/quit"].includes(command)) {
      rl.close();
      return 0;
    }
    if (command === "/help" || command === "/h") {
      io.log(
        "REPL commands:\n" +
          "  /commands      list discovered slash commands\n" +
          "  /config        resolved provider/model/base-url per role\n" +
          "  /help          this list\n" +
          "  /exit, /quit   leave (empty line, exit, quit, q also work)\n" +
          "slash commands:\n" +
          commandList() +
          "\nanything else is sent to the brothers as a task",
      );
      if (showPrompt) rl.prompt();
      continue;
    }
    if (command === "/commands") {
      io.log(`commands:\n${commandList()}`);
      if (showPrompt) rl.prompt();
      continue;
    }
    if (command === "/config") {
      printResolvedRoles(cfg, io);
      if (showPrompt) rl.prompt();
      continue;
    }
    // Slash commands expand to a task once, literally; an unknown name is a
    // REPL note, never a submitted task, and `null` means "not a command".
    const matched = matchCommand(trimmed);
    if (matched !== null) {
      const found = commands.commands.find((cmd) => cmd.name === matched.name);
      if (found === undefined) {
        io.error(
          `unknown command: ${matched.name} (type /commands to list available commands)`,
        );
      } else {
        await runOnce(cfg, expandCommand(found, matched.args), io, context, {
          ...(values["mcp-config"] ? { mcpConfig: values["mcp-config"] } : {}),
          outputMode: "text",
          resources,
          ...(found.mode ? { mode: found.mode } : {}),
        });
        io.log("");
      }
      if (showPrompt) rl.prompt();
      continue;
    }
    await runOnce(cfg, trimmed, io, context, {
      ...(values["mcp-config"] ? { mcpConfig: values["mcp-config"] } : {}),
      outputMode: "text",
      resources,
    });
    io.log("");
    if (showPrompt) rl.prompt();
  }
  // stdin closed (EOF) — e.g. a piped script that ended without an empty line
  return 0;
}

/** The resolved per-role provider line the REPL prints before the first
 * prompt (CLI-REFERENCE documents it); shared fields are shown per role with
 * the per-role overrides on top. A native family is named after `provider`
 * (`provider=openai kind=anthropic`); the default family stays byte-identical. */
function printResolvedRoles(cfg: Config, io: CliIO): void {
  const base = cfg.baseUrl || "(unset)";
  const kindFor = (role: "senior" | "junior"): string => {
    const kind = (role === "senior" ? cfg.seniorKind : cfg.juniorKind) || cfg.kind;
    return kind && kind !== DEFAULT_PROVIDER_KIND ? ` kind=${kind}` : "";
  };
  io.log(
    `senior: provider=${cfg.provider}${kindFor("senior")} model=${cfg.seniorModel || "(unset)"} ` +
      `base-url=${cfg.seniorBaseUrl || base} | junior: provider=${cfg.provider}` +
      `${kindFor("junior")} model=${cfg.juniorModel || "(unset)"} ` +
      `base-url=${cfg.juniorBaseUrl || base}`,
  );
}

function printTuiHelp(io: CliIO): void {
  io.log(`Usage: two-brothers tui [initial task] [flags]

Full-screen interactive chat in the terminal's alternate screen, over the
same cooperation harness as run/chat (mock or real providers). A bare
\`two-brothers\` in an interactive terminal opens this TUI; piped stdin is
refused with exit 2. The key guide below is generated from the same command
registry that powers the in-app Ctrl+P palette and ? help overlay.

${tuiHelpLines().join("\n")}

Flags: every chat flag (--provider, --base-url, --senior-model,
--session-file, --resume, --mcp-config, --plugins-dir, --skills-dir,
--commands-dir, --compact*, ...) plus --stream-tokens. --mode is the
cooperation mode (consult|work|auto) only; the run output modes
(print/json) are not accepted here.`);
}

const TUI_USAGE = "Usage: two-brothers tui [initial task] [flags]";

function printChatHelp(io: CliIO): void {
  io.log(`Usage: two-brothers chat [flags]

Interactive line-based REPL over the cooperation harness (mock or real
providers). A bare interactive two-brothers opens the full-screen TUI
instead; piped stdin runs one task per line.

REPL commands:
  /help, /h        this list
  /commands        list discovered slash commands
  /mode consult|work   switch the cooperation mode for the next turn
  /exit            leave the REPL
  /<name> [args]   expand a command from the commands roots
                   (<cwd>/commands, ~/.two-brothers/commands, --commands-dir)

Flags: --provider, --base-url, --api-key, --senior-model, --junior-model,
--mode consult|work|auto, --session-file, --resume, --mcp-config,
--plugins-dir, --skills-dir, --commands-dir, --verbose, --timeout,
--max-tokens. --stream-tokens is not accepted here (no stream sink in the
REPL); --mode takes cooperation modes only, not the run output modes.`);
}

async function doTui(argv: string[], io: CliIO): Promise<number> {
  let values: Record<string, any>;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { ...OPTIONS, help: { type: "boolean" as const, default: false } },
    }) as { values: Record<string, any>; positionals: string[] });
  } catch (exc) {
    io.error(`[error] ${exc instanceof Error ? exc.message : String(exc)}`);
    io.error(TUI_USAGE);
    return 2;
  }
  if (values.help === true) {
    printTuiHelp(io);
    return 0;
  }
  if (isOutputMode(values.mode)) {
    io.error(
      "Error: tui is interactive; --mode takes consult|work|auto (print/json are run output modes).",
    );
    return 2;
  }
  let cfg: Config;
  try {
    cfg = resolveConfig(argsToConfigArgs(values));
  } catch (exc) {
    io.error(`[error] ${exc instanceof Error ? exc.message : String(exc)}`);
    return 2;
  }
  const initialTask = positionals.join(" ").trim();
  return runTuiApp({
    cfg,
    io,
    pluginsDir: pluginsDirForCli(values),
    skillsRoots: skillsRootsForCli(values),
    commandsRoots: commandsRootsForCli(values),
    ...(typeof values["mcp-config"] === "string" && values["mcp-config"].trim()
      ? { mcpConfig: values["mcp-config"] }
      : {}),
    ...(streamTokensForCli(values) ? { streamTokens: true } : {}),
    ...(initialTask ? { initialTask } : {}),
  });
}

function printHelp(io: CliIO): void {
  io.log(`Two Brothers: a senior (arbiter) and a junior (advisor/executor).

Usage:
  two-brothers run "<task>" [flags]   one call: task -> cooperation -> decision
  two-brothers chat [flags]           REPL: many tasks in one session
  two-brothers tui [task] [flags]     full-screen terminal chat (alternate
                                      screen; needs a TTY; chat flags plus
                                      --stream-tokens)
  two-brothers sessions [--sessions-dir sessions]
                                      list session files with readable titles
  two-brothers selftest               offline check of the protocol and providers
  two-brothers serve [--host 127.0.0.1] [--port 8600] [--sessions-dir sessions]
                                      web viewer backend (API + SSE + web/dist)
  two-brothers models --base-url <url> [--api-key <key>|--api-key-env <VAR>] [--json]
                                      list the models an OpenAI-compatible
                                      endpoint reports (GET {base}/models)
  two-brothers onboard [--sessions-dir sessions] [--preset <id>]
                       [--base-url <url>] [--api-key <key>]
                       [--senior-model <m>] [--junior-model <m>]
                       [--non-interactive]
                                      write per-role settings to
                                      sessions/settings.json (interactive
                                      prompts unless --non-interactive)
  two-brothers --version             print the @two-brothers/harness version

Flags:
  --provider openai|mock
  --provider-kind openai-compatible|anthropic|google
                              wire family for openai roles (default
                              openai-compatible; env TWO_BROTHERS_PROVIDER_KIND)
  --senior-kind <kind>        --junior-kind <kind>
                              per-role wire family overrides (env
                              TWO_BROTHERS_SENIOR_KIND / _JUNIOR_KIND; pinned
                              like all env vars, never persisted)
  --base-url <url>            --api-key <key>
  --senior-base-url <url>     --senior-api-key <key>
  --junior-base-url <url>     --junior-api-key <key>
                              (per-role endpoints; env equivalents
                              TWO_BROTHERS_SENIOR_BASE_URL etc. — like all
                              env vars they pin and are never persisted)
  --senior-model <m>          --junior-model <m>
  --senior-system <text>      --junior-system <text>
  --max-rounds <n>            --temperature <f>   --timeout <s>
  --retries <n>               retries after a failed model call (default 6;
                              env TWO_BROTHERS_RETRIES)
  --max-tokens <n>            output-token cap for both roles (env
                              TWO_BROTHERS_MAX_TOKENS; per-role env
                              TWO_BROTHERS_SENIOR_MAX_TOKENS /
                              _JUNIOR_MAX_TOKENS override it; Anthropic's
                              default stays 4096, OpenAI/Gemini omit it)
  --mode consult|work|auto
  --mode print|json           (run only) non-interactive output: "print"
                              streams only the final decision text, "json"
                              one machine-readable object on stdout
                              ({task, events, decision, usage, cost, rounds,
                              errors}); see --json for the shorthand.
                              --json-events is an alias for --mode json so
                              e.g. --mode work --json-events stays possible
  --session-file <path>       --resume
  --stream                    (run only) NDJSON run events on stdout as they
                              happen: one JSON object per line from
                              run_status, envelope, repair, tool_call,
                              tool_result and result. The terminal result
                              event carries usage, so the human summary and
                              cost line are suppressed. Its own output mode:
                              cannot be combined with --json/--json-events or
                              --mode print|json
  --stream-tokens             (run --stream, or tui) stream provider
                              replies and add one "token" NDJSON record per
                              text delta ({type, role, delta, at}), in arrival
                              order, additive to the envelope records. In the
                              TUI, token deltas render in place while a turn
                              runs. Without --stream in a run it is a usage
                              error (env TWO_BROTHERS_STREAM_TOKENS=1 pins it
                              on)
  --compact                   compact the context once before the run starts
  --compact-threshold <chars> auto-compact when the rendered context passes
                              this many characters (0 = off, the default; an
                              auto trigger keeps the compacted context under
                              the threshold)
  --compact-threshold-tokens <n>
                              auto-compact when the estimated transcript
                              passes this many tokens; switches compaction to
                              token mode (env
                              TWO_BROTHERS_COMPACT_THRESHOLD_TOKENS)
  --context-window <n>        provider context window in tokens; with it
                              known, auto-compaction triggers at
                              window - reserve (default reserve 2000) and
                              budgets are measured in tokens (env
                              TWO_BROTHERS_CONTEXT_WINDOW). Token mode
                              overrides --compact-threshold <chars>
  --compact-keep-recent <n>   chars of recent envelopes kept verbatim when
                              compacting in char mode (default 40000; token
                              mode derives its own tail from the trigger; env
                              TWO_BROTHERS_COMPACT* equivalents)
  --mcp-config <file>         JSON file with MCP server definitions
                              ({"mcpServers": {...}}, optional per-server
                              "role": "shared"|"senior"|"junior", default junior)
  --plugins-dir <dir>         plugin directory for run/chat/serve (default
                              <cwd>/plugins; env TWO_BROTHERS_PLUGINS_DIR —
                              pinned like all env vars, never persisted).
                              Plugins load fail-soft; hook diagnostics print
                              under --verbose. Plugin tools need a workspace,
                              so serve runs over a workspace get them (a CLI
                              run has none).
  --skills-dir <path>         extra skills root (repeatable); defaults are
                              TWO_BROTHERS_SKILLS_DIR (OS path list), then
                              <cwd>/skills and ~/.two-brothers/skills
  --commands-dir <path>       extra slash-command root for the chat REPL and
                              tui (repeatable); defaults are
                              TWO_BROTHERS_COMMANDS_DIR (OS path list), then
                              <cwd>/commands and ~/.two-brothers/commands.
                              Type /commands or /help in either UI to list
                              them
  --json                      (run only) shorthand for --mode json: ONE
                              machine-readable object on stdout instead of
                              the human transcript. It is an output mode of
                              its own, not a print-mode modifier; with an
                              explicit --mode print it only narrows that
                              mode's output to the decision object as JSON
  --verbose                   extra diagnostics (prompt audits; per-run
                              plugin load notes). Warnings, usage and the
                              provider timeout hint always go to stderr.
`);
}

// --------------------------------------------------------------------------- //
// sessions: list session JSONL files with derived titles
// --------------------------------------------------------------------------- //

const TITLE_MAX = 80;
/** Bounded scan for the title-bearing prefix, as in python's _first_user_event. */
const SCAN_LIMIT = 200;

function padTrunc(text: string, width: number): string {
  const str = text.length > width ? text.slice(0, width) : text;
  return str.padEnd(width, " ");
}

/** First operator message text, whitespace-collapsed and truncated (mirrors
 * python's metadata.derive_title; the sidecar store itself is out of scope). */
export function deriveTitle(events: Array<Record<string, any>> | null | undefined, fallback: string): string {
  for (const event of events ?? []) {
    if (event?.from !== "user" || event?.kind !== "message") continue;
    const raw = String(event?.payload?.text ?? "");
    const text = raw.trim();
    if (!text) continue;
    const collapsed = text.split(/\s+/).join(" ");
    return collapsed.length > TITLE_MAX
      ? collapsed.slice(0, TITLE_MAX) + "…"
      : collapsed;
  }
  return fallback || "Untitled session";
}

interface SessionListing {
  name: string;
  title: string;
  count: number;
  updated: string;
  error: string | null;
}

function listSessions(sessionsDir: string): SessionListing[] {
  const names = fs
    .readdirSync(sessionsDir)
    .filter((name) => name.endsWith(".jsonl"))
    .sort();
  const listings: SessionListing[] = [];
  for (const name of names) {
    const filePath = path.join(sessionsDir, name);
    const fallback = name.slice(0, -".jsonl".length);
    let updated = "(unknown)";
    try {
      updated = formatMtime(fs.statSync(filePath).mtime);
    } catch {
      // unreadable stat: still list the file
    }

    let text: string;
    try {
      text = fs.readFileSync(filePath, "utf-8");
    } catch (exc) {
      listings.push({
        name,
        title: "(unreadable)",
        count: 0,
        updated,
        error: `cannot read file: ${exc}`,
      });
      continue;
    }

    const lines = text.split(/\r?\n/);
    const head: Array<Record<string, any>> = [];
    let count = 0;
    let corruptLine = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        if (!corruptLine) corruptLine = i + 1;
        continue;
      }
      if (typeof event !== "object" || event === null || Array.isArray(event)) {
        if (!corruptLine) corruptLine = i + 1;
        continue;
      }
      count += 1;
      if (head.length < SCAN_LIMIT) head.push(event as Record<string, any>);
    }

    if (corruptLine) {
      listings.push({
        name,
        title: deriveTitle(head, fallback),
        count,
        updated,
        error: `corrupt line ${corruptLine}`,
      });
    } else {
      listings.push({
        name,
        title: deriveTitle(head, fallback),
        count,
        updated,
        error: null,
      });
    }
  }
  return listings;
}

function formatMtime(mtime: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${mtime.getFullYear()}-${pad(mtime.getMonth() + 1)}-${pad(mtime.getDate())} ` +
    `${pad(mtime.getHours())}:${pad(mtime.getMinutes())}`
  );
}

function doSessions(argv: string[], io: CliIO): number {
  const { values } = parseArgs({
    args: argv,
    options: { "sessions-dir": { type: "string" as const } },
  });
  const sessionsDir = values["sessions-dir"] ?? "sessions";

  let listings: SessionListing[];
  try {
    listings = listSessions(sessionsDir);
  } catch {
    io.log(`no session files in ${sessionsDir}`);
    return 0;
  }
  if (listings.length === 0) {
    io.log(`no session files in ${sessionsDir}`);
    return 0;
  }

  io.log(
    `${padTrunc("session", 28)} ${padTrunc("title", 44)} ` +
      `${"envelopes".padStart(9)} updated`,
  );
  for (const item of listings) {
    const marker = item.error ? `  [error: ${item.error}]` : "";
    io.log(
      `${padTrunc(item.name, 28)} ${padTrunc(item.title, 44)} ` +
        `${String(item.count).padStart(9)} ${item.updated}${marker}`,
    );
  }
  return 0;
}

/** `two-brothers serve --help`: the server's own flags (the run flags it
 * shares still accept their long forms, but the output lives here). */
function printServeHelp(io: CliIO): void {
  io.log(`Usage: two-brothers serve [flags]

Start the web workspace backend: JSON API + SSE + the built web app
(the repo's web/dist, or the packaged copy).

Flags:
  --host <addr>               bind address (default 127.0.0.1)
  --port <n>                  port (default 8600)
  --sessions-dir <dir>        session store root (default sessions)
  --workers <n>               background run workers
  --timeout <s>               per-provider-attempt timeout in seconds
                              (default 120; env TWO_BROTHERS_TIMEOUT). A
                              timed-out attempt is retried and warns on
                              stderr, at most three times per run — raise
                              this for slow local models
  --plugins-dir <dir>         plugin directory (default <cwd>/plugins; env
                              TWO_BROTHERS_PLUGINS_DIR)
  --skills-dir <path>         extra skills root (repeatable)
  --commands-dir <path>       extra slash-command root (repeatable; served as
                              metadata at GET /api/commands)
  --mcp-config <file>         MCP server definitions merged with the
                              plugin-contributed servers on every run
  --help                      this screen

The shared provider flags (--provider, --base-url, --senior-*/--junior-*,
--max-tokens, ...) are accepted too; see "two-brothers --help".`);
}

async function doServe(argv: string[], io: CliIO): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      ...OPTIONS,
      host: { type: "string" as const },
      port: { type: "string" as const },
      "sessions-dir": { type: "string" as const },
      workers: { type: "string" as const },
      help: { type: "boolean" as const, default: false },
    },
  });
  if (values.help === true) {
    printServeHelp(io);
    return 0;
  }
  const host = values.host ?? "127.0.0.1";
  const port = Number.parseInt(values.port ?? "8600", 10);
  if (!Number.isFinite(port)) {
    io.error(`[error] invalid port: ${String(values.port)}`);
    return 2;
  }
  const workers = values.workers !== undefined ? Number.parseInt(values.workers, 10) : undefined;
  // Explicit --plugins-dir (or TWO_BROTHERS_PLUGINS_DIR) wins; otherwise the
  // server keeps its module-relative default (`<repo>/plugins`), which is what
  // existing checkouts and tests rely on. Skill roots follow the same
  // convention as run/chat.
  const pluginsDirFlag =
    (typeof values["plugins-dir"] === "string" && values["plugins-dir"].trim()) ||
    (process.env.TWO_BROTHERS_PLUGINS_DIR ?? "").trim();
  const app = createServer({
    // CLI flags (applied per run via the config factory) > env > persisted.
    configFactory: () => resolveConfig(argsToConfigArgs(values)),
    sessionsDir: values["sessions-dir"] ?? "sessions",
    workers: workers !== undefined && Number.isFinite(workers) ? workers : undefined,
    ...(pluginsDirFlag ? { pluginsDir: path.resolve(pluginsDirFlag) } : {}),
    skillsDirs: skillsRootsForCli(values),
    commandsDirs: commandsRootsForCli(values),
    ...(typeof values["mcp-config"] === "string" && values["mcp-config"].trim()
      ? { mcpConfig: values["mcp-config"] }
      : {}),
  });
  const server = await app.listen(host, port);
  io.log(
    `Two Brothers server on http://${host}:${port} ` +
      `(sessions: ${path.resolve(values["sessions-dir"] ?? "sessions")})`,
  );
  // Serve until interrupted. SIGINT/SIGTERM run a graceful shutdown:
  // cooperatively cancel in-flight runs, end SSE connections, close the
  // server — then fall through to the normal exit-code path instead of
  // dying in the signal default. A `close` from any other source (an
  // embedder calling app.close()) resolves the loop the same way.
  await new Promise<void>((resolve) => {
    let shutdownStarted = false;
    const finish = (): void => {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      resolve();
    };
    const beginShutdown = (signal: string | null): void => {
      if (shutdownStarted) return;
      shutdownStarted = true;
      if (signal !== null) io.error(`[two-brothers] ${signal} received — shutting down`);
      void shutdownServe(app)
        .catch((exc) => {
          io.error(
            `[two-brothers] shutdown error: ${exc instanceof Error ? exc.message : String(exc)}`,
          );
        })
        .finally(finish);
    };
    const onSigint = (): void => beginShutdown("SIGINT");
    const onSigterm = (): void => beginShutdown("SIGTERM");
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);
    server.on("close", () => beginShutdown(null));
  });
  return 0;
}

/** Grace window for in-flight runs to unwind after a cooperative stop. */
const SERVE_SHUTDOWN_GRACE_MS = 5_000;

type ServeApp = ReturnType<typeof createServer>;

/**
 * Graceful `serve` shutdown, shared by the CLI signal handlers: stop
 * accepting new requests by closing the HTTP server(s), cooperatively cancel
 * queued/running/waiting runs (a stop resolves pending approvals as deny, so
 * no mutation parks mid-approval), give in-flight runs a bounded grace window
 * to unwind their resources (MCP clients close in the run's finally), and end
 * every SSE connection. Already-flushed session JSONL is never touched —
 * envelopes are written per append, so shutdown loses no recorded history.
 */
export async function shutdownServe(
  app: ServeApp,
  graceMs: number = SERVE_SHUTDOWN_GRACE_MS,
): Promise<void> {
  const runs = app.state.runs;
  const activeStatuses = new Set(["queued", "running", "waiting"]);
  for (const record of runs.list()) {
    if (activeStatuses.has(String(record.status))) {
      runs.stop(String(record.run_id));
    }
  }
  const idleDeadline = Date.now() + graceMs;
  while (Date.now() < idleDeadline) {
    const stillActive = runs
      .list()
      .some((record) => activeStatuses.has(String(record.status)));
    if (!stillActive) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await app.close();
}

// --------------------------------------------------------------------------- //
// models: list the models an OpenAI-compatible endpoint reports
// --------------------------------------------------------------------------- //

const MODELS_OPTIONS = {
  "base-url": { type: "string" as const },
  "api-key": { type: "string" as const },
  "api-key-env": { type: "string" as const },
  timeout: { type: "string" as const },
  json: { type: "boolean" as const, default: false },
};

const MODELS_USAGE =
  "Usage: models --base-url <url> [--api-key <key> | --api-key-env <VAR>] [--json]";

/**
 * `parseArgs` with a clean usage error: the onboarding/discovery commands
 * fail with exit 2 on a malformed flag instead of throwing out of `main`.
 */
function parseCliArgs(
  argv: string[],
  options: ParseArgsOptionsConfig,
  usage: string,
  io: CliIO,
): Record<string, any> | null {
  try {
    return parseArgs({ args: argv, options }).values as Record<string, any>;
  } catch (exc) {
    io.error(`[error] ${exc instanceof Error ? exc.message : String(exc)}`);
    io.error(usage);
    return null;
  }
}

async function doModels(argv: string[], io: CliIO): Promise<number> {
  const values = parseCliArgs(argv, MODELS_OPTIONS, MODELS_USAGE, io);
  if (values === null) return 2;
  const baseUrl = values["base-url"]?.trim() ?? "";
  if (!baseUrl) {
    io.error(MODELS_USAGE);
    return 2;
  }
  let apiKey = values["api-key"] ?? "";
  const apiKeyEnv = values["api-key-env"]?.trim();
  if (!apiKey && apiKeyEnv) {
    apiKey = process.env[apiKeyEnv] ?? "";
    if (!apiKey) {
      io.error(`[error] environment variable ${apiKeyEnv} is not set or empty`);
      return 2;
    }
  }
  const timeout = values.timeout !== undefined ? Number.parseInt(values.timeout, 10) : undefined;
  if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0)) {
    io.error(`[error] invalid timeout: ${values.timeout} (use seconds)`);
    return 2;
  }

  let models: Awaited<ReturnType<typeof listModels>>;
  try {
    models = await listModels(baseUrl, {
      ...(apiKey ? { apiKey } : {}),
      ...(timeout !== undefined ? { timeoutSeconds: timeout } : {}),
    });
  } catch (exc) {
    io.error(`[error] ${exc instanceof Error ? exc.message : String(exc)}`);
    return 1;
  }

  if (values.json) {
    io.log(JSON.stringify(models));
    return 0;
  }
  if (models.length === 0) {
    io.log(`no models reported by ${baseUrl}`);
    return 0;
  }
  const showOwner = models.some((model) => model.owned_by);
  if (!showOwner) {
    for (const model of models) io.log(model.id);
    return 0;
  }
  const width = Math.min(60, Math.max(2, ...models.map((model) => model.id.length)));
  io.log(`${"id".padEnd(width)} owned_by`);
  for (const model of models) {
    io.log(`${model.id.padEnd(width)} ${model.owned_by ?? ""}`.trimEnd());
  }
  return 0;
}

// --------------------------------------------------------------------------- //
// onboard: write per-role settings (sessions/settings.json)
// --------------------------------------------------------------------------- //

const ONBOARD_OPTIONS = {
  "sessions-dir": { type: "string" as const },
  preset: { type: "string" as const },
  "base-url": { type: "string" as const },
  "api-key": { type: "string" as const },
  "api-key-env": { type: "string" as const },
  "senior-model": { type: "string" as const },
  "junior-model": { type: "string" as const },
  "provider-kind": { type: "string" as const },
  "non-interactive": { type: "boolean" as const, default: false },
};

/** Local-first default endpoint LM Studio serves. */
const DEFAULT_ONBOARD_BASE_URL = "http://localhost:1234/v1";

const ONBOARD_USAGE =
  "Usage: onboard [--sessions-dir <dir>] [--preset <id>] [--base-url <url>] " +
  "[--api-key <key> | --api-key-env <VAR>] [--senior-model <m>] [--junior-model <m>] " +
  "[--non-interactive]";

/**
 * Read one answer from a line iterator: the prompt is written manually so
 * piped scripts (not just a TTY) can drive onboarding — `readline.question`
 * drops lines that arrive while no question is pending. An empty line takes
 * `fallback`.
 */
function askWithDefault(
  lines: AsyncIterator<string>,
  label: string,
  fallback: string,
): Promise<string> {
  process.stdout.write(`${label}${fallback ? ` [${fallback}]` : ""}: `);
  return lines.next().then((next) => {
    if (next.done) throw new Error("input closed before onboarding finished");
    const answer = String(next.value ?? "").trim();
    return answer || fallback;
  });
}

type OnboardRoleSettings = {
  provider: string;
  base_url: string;
  model: string;
  api_key?: string;
};

async function doOnboard(argv: string[], io: CliIO): Promise<number> {
  const values = parseCliArgs(argv, ONBOARD_OPTIONS, ONBOARD_USAGE, io);
  if (values === null) return 2;
  const sessionsDir = values["sessions-dir"] ?? "sessions";
  const store = new SettingsStore(path.join(sessionsDir, "settings.json"));
  const existing = store.read();
  const nonInteractive = values["non-interactive"] === true;

  const presetFlag = typeof values.preset === "string" ? values.preset.trim() : "";
  let preset = presetById(presetFlag);
  if (presetFlag && !preset) {
    io.error(`[error] unknown preset: ${presetFlag} (choose from ${presetIds().join(", ")})`);
    return 2;
  }

  let baseUrl = values["base-url"]?.trim() ?? "";
  let seniorModel = values["senior-model"]?.trim() ?? "";
  let juniorModel = values["junior-model"]?.trim() ?? "";

  const requestedKind = values["provider-kind"]?.trim() ?? "";
  if (requestedKind && !isProviderKind(requestedKind)) {
    io.error(`[error] invalid provider kind: ${requestedKind} (use ${PROVIDER_KIND_HINT})`);
    return 2;
  }

  let apiKey = values["api-key"] ?? "";
  const apiKeyEnv = values["api-key-env"]?.trim();
  if (!apiKey && apiKeyEnv) {
    apiKey = process.env[apiKeyEnv] ?? "";
    if (!apiKey) {
      io.error(`[error] environment variable ${apiKeyEnv} is not set or empty`);
      return 2;
    }
  }

  const existingSenior = existing.senior ?? {};
  const existingJunior = existing.junior ?? {};

  if (!nonInteractive) {
    io.log("provider presets (name, base url, key variable):");
    for (const seed of seedPresets()) {
      const key = seed.api_key_env ? ` (key: ${seed.api_key_env})` : " (no key needed)";
      io.log(`  ${seed.name.padEnd(12)} ${seed.base_url}${key}`);
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const lines = rl[Symbol.asyncIterator]();
    try {
      if (!preset) {
        const picked = await askWithDefault(lines, "preset id (blank for a custom endpoint)", "");
        if (picked) {
          preset = presetById(picked);
          if (!preset) {
            io.error(
              `[error] unknown preset: ${picked} (choose from ${presetIds().join(", ")})`,
            );
            return 2;
          }
        }
      }
      baseUrl = await askWithDefault(
        lines,
        "base url",
        baseUrl || preset?.base_url || existingSenior.base_url || DEFAULT_ONBOARD_BASE_URL,
      );
      seniorModel = await askWithDefault(
        lines,
        "senior model",
        seniorModel || preset?.models[0] || existingSenior.model || "",
      );
      while (!seniorModel) {
        seniorModel = await askWithDefault(lines, "senior model (required)", "");
      }
      juniorModel = await askWithDefault(
        lines,
        "junior model",
        juniorModel || preset?.models[1] || existingJunior.model || seniorModel,
      );
      while (!juniorModel) {
        juniorModel = await askWithDefault(lines, "junior model (required)", "");
      }
    } catch (exc) {
      io.error(`[error] ${exc instanceof Error ? exc.message : String(exc)}`);
      return 1;
    } finally {
      rl.close();
    }
  } else if (!baseUrl && preset) {
    baseUrl = preset.base_url;
  }

  const presetKind = preset?.kind ?? "";
  if (presetKind && presetKind !== DEFAULT_PROVIDER_KIND && !requestedKind) {
    io.log(
      `note: preset "${preset?.name ?? ""}" speaks the ${presetKind} wire family — ` +
        `run with --provider-kind ${presetKind} (or set ` +
        `TWO_BROTHERS_PROVIDER_KIND=${presetKind}); role settings carry no kind`,
    );
  }

  if (!baseUrl) {
    io.error(
      "[error] no base url: pass --base-url <url> (or --preset <id>; " +
        "interactive mode prompts for one)",
    );
    io.error(ONBOARD_USAGE);
    return 2;
  }
  if (!seniorModel) seniorModel = preset?.models[0] ?? existingSenior.model ?? "";
  if (!juniorModel) {
    juniorModel = preset?.models[1] ?? existingJunior.model ?? seniorModel;
  }
  if (!seniorModel || !juniorModel) {
    io.error("[error] no model ids: pass --senior-model <m> and --junior-model <m>");
    return 2;
  }

  const roleSettings = (model: string): OnboardRoleSettings => ({
    provider: "openai",
    base_url: baseUrl,
    model,
    ...(apiKey ? { api_key: apiKey } : {}),
  });
  try {
    store.write({ senior: roleSettings(seniorModel), junior: roleSettings(juniorModel) });
  } catch (exc) {
    io.error(
      `[error] cannot write ${store.filePath}: ${exc instanceof Error ? exc.message : String(exc)}`,
    );
    return 1;
  }

  // Print the persisted, masked view — never the key material.
  const persisted = store.public();
  io.log(`wrote ${path.resolve(store.filePath)}`);
  for (const role of ["senior", "junior"] as const) {
    const view = persisted[role];
    io.log(
      `  ${role}: provider=${view.provider ?? "(default)"} ` +
        `base-url=${view.base_url ?? "(unset)"} model=${view.model ?? "(unset)"} ` +
        `api-key=${view.api_key_set ? "(set)" : "(unset)"}`,
    );
  }
  const pinned = envPinnedPairs();
  const stripped: string[] = [];
  for (const role of ["senior", "junior"] as const) {
    if (pinned.has(`${role}:base_url`)) stripped.push(`${role} base url`);
    if (pinned.has(`${role}:api_key`)) stripped.push(`${role} api key`);
    if (pinned.has(`${role}:model`)) stripped.push(`${role} model`);
  }
  if (stripped.length > 0) {
    io.log(
      `note: ${stripped.join(", ")} pinned by TWO_BROTHERS_* env vars; ` +
        "the env value wins and was not written",
    );
  }
  return 0;
}

/**
 * The shipped package version for `--version`. Read from `package.json` at
 * the package root (a repo checkout and the packed tarball both place it one
 * level up from `src/`/`dist/`) — plain `node:fs`, no import assertions.
 */
function packageVersion(): string {
  const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  const parsed = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as { version?: unknown };
  if (typeof parsed.version !== "string" || parsed.version.length === 0) {
    throw new Error(`package.json at ${pkgPath} carries no version`);
  }
  return parsed.version;
}

export async function main(argv: string[], io: CliIO = defaultIO): Promise<number> {
  if (argv.length === 0) {
    // Modern-CLI convention: an interactive terminal opens the full TUI
    // (like opencode/kimi bare invocations); piped or CI invocations get
    // the usage screen so scripts keep working.
    if (process.stdin.isTTY === true) return doTui([], io);
    printHelp(io);
    return 0;
  }
  const command = argv[0];
  if (command === "help" || command === "--help" || command === "-h") {
    printHelp(io);
    return 0;
  }
  if (command === "--version" || command === "-v") {
    io.log(packageVersion());
    return 0;
  }
  if (command === "selftest") return selftest();
  if (command === "sessions") return doSessions(argv.slice(1), io);
  if (command === "run") return doRun(argv.slice(1), io);
  if (command === "chat") return doChat(argv.slice(1), io);
  if (command === "tui") return doTui(argv.slice(1), io);
  if (command === "serve") return doServe(argv.slice(1), io);
  if (command === "models") return doModels(argv.slice(1), io);
  if (command === "onboard") return doOnboard(argv.slice(1), io);
  io.error(`Unknown command: ${command}`);
  printHelp(io);
  return 2;
}

/**
 * True when this module is the process entry point. npm's POSIX `.bin`
 * entries are symlinks: `process.argv[1]` keeps the symlink path while
 * `import.meta.url` is already resolved to the real file, so a plain string
 * comparison misses. Compare canonical real paths on both sides instead
 * (also correct under `node --preserve-symlinks`, where the module URL keeps
 * the link path too). A missing entry path or unreadable file is not us.
 */
export function isCliEntry(moduleUrl: string, argv1: string | undefined): boolean {
  if (argv1 === undefined) return false;
  try {
    return fs.realpathSync(fileURLToPath(moduleUrl)) === fs.realpathSync(argv1);
  } catch {
    return false;
  }
}

const invokedAsScript = isCliEntry(import.meta.url, process.argv[1]);

if (invokedAsScript) {
  main(process.argv.slice(2))
    .then((code) => {
      // Set exit code without force-killing the loop (keeps libuv handles clean).
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    });
}
