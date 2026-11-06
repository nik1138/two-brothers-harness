#!/usr/bin/env node
/**
 * CLI for the Two Brothers harness. Mirrors the original prototype's CLI
 * (removed 2026-11-04; see git history).
 *
 *   node src/cli.ts run "<task>" [flags]
 *   node src/cli.ts run - [flags]                (task from stdin, max 1 MiB)
 *   node src/cli.ts run --task-file <path> [flags]
 *   node src/cli.ts chat [flags]
 *   node src/cli.ts tui [task] [flags]
 *   node src/cli.ts help [command | --all]
 *   node src/cli.ts sessions [--sessions-dir sessions] [--json] [--limit N]
 *   node src/cli.ts sessions show <name> [--json] [--limit N]
 *   node src/cli.ts config [--json] [provider flags]
 *   node src/cli.ts selftest
 *   node src/cli.ts models --base-url <url> [--api-key <key>] [--json]
 *   node src/cli.ts onboard [--sessions-dir sessions] [--preset <id>] [--non-interactive]
 *   node src/cli.ts doctor [--json] [--sessions-dir sessions] [--timeout <s>]
 *   node src/cli.ts completions <bash|zsh|fish|powershell>
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";

import { resolveConfig, maxTokensForRole, validateRunConfig, type Config } from "./config.ts";
import {
  buildConfigView,
  renderConfigView,
  sourceLabel,
  type ConfigView,
} from "./configview.ts";
import {
  allFlagNames,
  commandHelp,
  commandNames,
  commandUsage,
  flagCandidatesForCommand,
  renderBriefUsage,
  renderCommandHelp,
  renderFullHelp,
  renderMainHelp,
  suggestCommand,
  suggestFlag,
} from "./clihelp.ts";
import {
  COMPLETION_SHELLS,
  generateCompletions,
  type CompletionShell,
  type CompletionSpec,
} from "./completions.ts";
import { SharedContext } from "./context.ts";
import type { CompactionSettings } from "./compaction.ts";
import {
  discoverCommands,
  expandCommand,
  matchCommand,
  type CommandCatalog,
} from "./commands.ts";
import { estimateCost, type CostEstimate } from "./cost.ts";
import { formatDoctorReport, runDoctor } from "./doctor.ts";
import { TwoBrothersHarness, type PromptAuditEntry, type ToolScopes } from "./harness.ts";
import {
  loadMcpToolSpecs,
  loadMcpTools,
  mergeMcpConfig,
  type McpConfigFileShape,
  type McpToolSet,
} from "./mcp.ts";
import { SessionMetadataStore } from "./metadata.ts";
import { mergeSeedPresets, presetById, presetIds, seedPresets } from "./presets.ts";
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
import {
  SEARCH_MIN_QUERY_CHARS,
  loadSessionDocs,
  searchSessions,
  sessionToJsonString,
  sessionToMarkdown,
  type SessionSearchDoc,
} from "./sessionsearch.ts";
import { discoverSkills, type SkillCatalog } from "./skills.ts";
import { envPinnedPairs, SettingsStore } from "./settings_store.ts";
import { runTuiApp } from "./tui/app.ts";
import { tuiHelpLines } from "./tui/keymap.ts";

/**
 * The shared `run` / `chat` / `tui` / `serve` flag table. Exported so the
 * help catalog (`src/clihelp.ts`) can be checked for parity and so shell
 * completions can be generated from the same source.
 */
export const OPTIONS = {
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
} satisfies ParseArgsOptionsConfig;

/** `--help` / `-h` on every command: print the command's help, exit 0. */
const HELP_OPTIONS = {
  help: { type: "boolean" as const, default: false },
  h: { type: "boolean" as const, default: false },
} satisfies ParseArgsOptionsConfig;

/**
 * `--dry-run` is parsed by `run` and `chat` only (not part of the shared
 * `OPTIONS` table, so `serve`/`tui` reject it instead of silently ignoring
 * it). `--task-file` is a `run`-only input.
 */
const DRY_RUN_OPTIONS = {
  "dry-run": { type: "boolean" as const, default: false },
} satisfies ParseArgsOptionsConfig;

const TASK_FILE_OPTIONS = {
  "task-file": { type: "string" as const },
} satisfies ParseArgsOptionsConfig;

const RUN_INPUT_OPTIONS = {
  ...DRY_RUN_OPTIONS,
  ...TASK_FILE_OPTIONS,
} satisfies ParseArgsOptionsConfig;

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

// --------------------------------------------------------------------------- //
// help + argument-error plumbing (all help text lives in src/clihelp.ts)
// --------------------------------------------------------------------------- //

/** `--help` or `-h` was passed (both `parseArgs` keys are checked). */
function isHelpRequested(values: Record<string, any>): boolean {
  return values.help === true || values.h === true;
}

/** Print the concise grouped top-level help (bare invocation, `--help`, ...). */
function printHelp(io: CliIO): void {
  io.log(renderMainHelp());
}

/**
 * An unknown command (or an unknown target of `help <command>`): the error,
 * a did-you-mean suggestion within edit distance 2 and the help pointer go to
 * stderr; stdout keeps the short usage block the legacy contract expects.
 * Returns exit code 2.
 */
function reportUnknownCommand(target: string, io: CliIO): number {
  const suggestion = suggestCommand(target);
  io.error(`Unknown command: ${target}`);
  if (suggestion !== null) io.error(`Did you mean '${suggestion}'?`);
  io.error("Run 'two-brothers help' for the command list.");
  io.log(renderBriefUsage());
  return 2;
}

/**
 * An unknown option: `Unknown option '--x'` first (the documented diagnostic),
 * the command's usage line, the nearest known flag and the per-command help
 * pointer. Returns exit code 2. `command` is undefined for a top-level option.
 */
function reportUnknownOption(token: string, command: string | undefined, io: CliIO): void {
  io.error(`[error] Unknown option '${token}'`);
  io.error(
    `Usage: ${command !== undefined ? commandUsage(command) : "two-brothers [command] [flags]"}`,
  );
  const candidates =
    command !== undefined
      ? flagCandidatesForCommand(command)
      : [...allFlagNames(), "-h", "-v"];
  const suggestion = suggestFlag(token, candidates);
  if (suggestion !== null) io.error(`Did you mean '${suggestion}'?`);
  io.error(`Run '${command !== undefined ? `two-brothers ${command}` : "two-brothers"} --help'.`);
}

/** Parsed `parseArgs` result with positionals normalized (always an array). */
interface ParsedCommandArgs {
  values: Record<string, any>;
  positionals: string[];
}

/**
 * `parseArgs` with the consistent CLI argument-error contract: an unknown
 * command option is exit 2 with a nearest-flag suggestion, every other
 * argument error is exit 2 with the command's usage and `--help` pointer.
 * Returns null after printing the diagnostics; the caller returns 2.
 */
function parseCommandArgs(
  argv: string[],
  options: ParseArgsOptionsConfig,
  command: string,
  io: CliIO,
  allowPositionals = false,
): ParsedCommandArgs | null {
  try {
    const parsed = parseArgs({
      args: argv,
      options,
      ...(allowPositionals ? { allowPositionals: true } : {}),
    }) as { values: Record<string, any>; positionals?: string[] };
    return { values: parsed.values, positionals: parsed.positionals ?? [] };
  } catch (exc) {
    const message = exc instanceof Error ? exc.message : String(exc);
    const unknown = /Unknown option '([^']+)'/.exec(message);
    if (unknown !== null) {
      reportUnknownOption(unknown[1], command, io);
      return null;
    }
    io.error(`[error] ${message}`);
    io.error(`Usage: ${commandUsage(command)}`);
    io.error(`Run 'two-brothers ${command} --help'.`);
    return null;
  }
}

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

// --------------------------------------------------------------------------- //
// run task input: positional, `run -` (stdin) and --task-file
// --------------------------------------------------------------------------- //

/** Upper bound for a task piped on stdin (`run -`): 1 MiB of raw bytes. */
const STDIN_TASK_MAX_BYTES = 1024 * 1024;

/** A usage error while resolving the task (missing/blank/oversized input). */
class TaskInputError extends Error {}

interface ResolvedTask {
  task: string;
  source: "argument" | "stdin" | "file";
}

/** Read all of stdin, failing past `maxBytes` instead of buffering forever. */
async function readStdinTask(maxBytes = STDIN_TASK_MAX_BYTES): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buffer.length;
    if (total > maxBytes) {
      throw new TaskInputError(
        `stdin task exceeds the ${STDIN_TASK_MAX_BYTES / (1024 * 1024)} MiB limit; ` +
          "pass a shorter task or use --task-file",
      );
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

/**
 * Resolve `run`'s task: the positional argument, `-` (stdin, bounded) or
 * `--task-file <path>`. A blank task is a usage error, exactly like a missing
 * positional; the caller prints the exit-2 diagnostic and usage line.
 */
async function resolveRunTask(
  positionals: string[],
  values: Record<string, any>,
): Promise<ResolvedTask> {
  const positional = positionals.join(" ").trim();
  const taskFile =
    typeof values["task-file"] === "string" ? values["task-file"].trim() : "";
  if (taskFile && positional) {
    throw new TaskInputError(
      "--task-file and a positional task are mutually exclusive; pass exactly one",
    );
  }
  if (taskFile) {
    let raw: string;
    try {
      raw = fs.readFileSync(taskFile, "utf-8");
    } catch (exc) {
      throw new TaskInputError(
        `cannot read --task-file ${taskFile}: ${exc instanceof Error ? exc.message : String(exc)}`,
      );
    }
    const task = raw.trim();
    if (!task) throw new TaskInputError(`--task-file ${taskFile} is empty`);
    return { task, source: "file" };
  }
  if (positional === "-") {
    const task = (await readStdinTask()).trim();
    if (!task) {
      throw new TaskInputError("no task given on stdin (run - expects the task on stdin)");
    }
    return { task, source: "stdin" };
  }
  if (!positional) throw new TaskInputError('no task given. Usage: run "<task>"');
  return { task: positional, source: "argument" };
}

// --------------------------------------------------------------------------- //
// --dry-run: the resolved plan, without provider calls or session writes
// --------------------------------------------------------------------------- //

interface DryRunSession {
  file: string | null;
  mode: "none" | "new" | "resume" | "exists";
  note: string;
}

interface DryRunTools {
  plugins: { dir: string; present: boolean; files: number };
  skills: { roots: string[]; count: number };
  commands: { roots: string[]; count: number };
  mcp: {
    configured: boolean;
    file: string | null;
    present: boolean;
    servers: number;
    error: string | null;
  };
}

/** The `--dry-run --json` object (one stable shape; `config` is the config view). */
interface DryRunPlan {
  dryRun: true;
  command: "run" | "chat";
  task: string | null;
  taskSource: "argument" | "stdin" | "file" | null;
  session: DryRunSession;
  tools: DryRunTools;
  problems: string[];
  config: ConfigView;
}

/**
 * Plugin-file count for the plan. Mirrors `PLUGIN_FILE_RE` in `plugins.ts`
 * (kept local: a dry run must not import/execute plugin modules, so this is
 * a filesystem glance, not a plugin load).
 */
const PLUGIN_FILE_NAME = /^[a-z0-9_]+\.(?:ts|mts|mjs)$/;

function planPlugins(dir: string): DryRunTools["plugins"] {
  let present = false;
  let files = 0;
  try {
    present = fs.statSync(dir).isDirectory();
  } catch {
    present = false;
  }
  if (present) {
    try {
      files = fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && PLUGIN_FILE_NAME.test(entry.name)).length;
    } catch {
      files = 0;
    }
  }
  return { dir, present, files };
}

/** MCP config presence/server count; never spawns a server. */
function planMcp(values: Record<string, any>): DryRunTools["mcp"] {
  const file =
    typeof values["mcp-config"] === "string" ? values["mcp-config"].trim() : "";
  if (!file) {
    return { configured: false, file: null, present: false, servers: 0, error: null };
  }
  if (!fs.existsSync(file)) {
    return {
      configured: true,
      file,
      present: false,
      servers: 0,
      error: `MCP config not found: ${file}`,
    };
  }
  try {
    const specs = loadMcpToolSpecs(file);
    return {
      configured: true,
      file,
      present: true,
      servers: Object.keys(specs).length,
      error: null,
    };
  } catch (exc) {
    return {
      configured: true,
      file,
      present: true,
      servers: 0,
      error: exc instanceof Error ? exc.message : String(exc),
    };
  }
}

function planTools(values: Record<string, any>): DryRunTools {
  const skillRoots = skillsRootsForCli(values);
  const commandRoots = commandsRootsForCli(values);
  return {
    plugins: planPlugins(pluginsDirForCli(values)),
    skills: { roots: skillRoots, count: discoverSkills(skillRoots).skills.length },
    commands: {
      roots: commandRoots,
      count: discoverCommands(commandRoots).commands.length,
    },
    mcp: planMcp(values),
  };
}

/** Session-file plan: existence is read, never opened/written. */
function planSession(cfg: Config): DryRunSession {
  if (!cfg.sessionFile) {
    return {
      file: null,
      mode: "none",
      note: "no --session-file; the session stays in memory",
    };
  }
  const exists = fs.existsSync(cfg.sessionFile);
  if (cfg.resume) {
    return exists
      ? {
          file: cfg.sessionFile,
          mode: "resume",
          note: "would resume this session file",
        }
      : {
          file: cfg.sessionFile,
          mode: "new",
          note: "no file to resume; a real run warns and starts a new session",
        };
  }
  return exists
    ? {
        file: cfg.sessionFile,
        mode: "exists",
        note: "file exists; a real run exits 1 unless --resume is passed",
      }
    : {
        file: cfg.sessionFile,
        mode: "new",
        note: "would be created on the first envelope",
      };
}

/** Provider-config gaps a real run would fail on (reported, never fatal here). */
function planProblems(cfg: Config): string[] {
  try {
    validateRunConfig(cfg, cliEndpoints(cfg));
    return [];
  } catch (exc) {
    return [exc instanceof Error ? exc.message : String(exc)];
  }
}

function buildDryRunPlan(
  command: "run" | "chat",
  cfg: Config,
  values: Record<string, any>,
  task: ResolvedTask | undefined,
): DryRunPlan {
  const sessionsDir =
    typeof values["sessions-dir"] === "string" && values["sessions-dir"].trim()
      ? values["sessions-dir"].trim()
      : "sessions";
  return {
    dryRun: true,
    command,
    task: task?.task ?? null,
    taskSource: task?.source ?? null,
    session: planSession(cfg),
    tools: planTools(values),
    problems: planProblems(cfg),
    config: buildConfigView({
      config: cfg,
      env: process.env,
      flags: values,
      cwd: process.cwd(),
      homeDir: os.homedir(),
      sessionsDir,
    }),
  };
}

/** Human plan text; the first line is the dry-run contract (asserted by tests). */
function renderDryRunPlan(plan: DryRunPlan): string[] {
  const { config } = plan;
  const lines: string[] = [
    "dry run — no model calls, no session written",
    `command: ${plan.command}`,
  ];
  if (plan.task !== null) {
    lines.push(`task: ${plan.task}`);
    lines.push(`task source: ${plan.taskSource}`);
  }
  lines.push(
    `mode: ${config.mode} (${sourceLabel(config.modeSource)})`,
    `provider: ${config.provider} (${sourceLabel(config.providerSource)})`,
    "roles:",
  );
  for (const role of ["senior", "junior"] as const) {
    const entry = config.roles[role];
    lines.push(
      `  ${role}: provider=${entry.provider} kind=${entry.kind} ` +
        `base-url=${entry.baseUrl || "(unset)"} model=${entry.model || "(unset)"} ` +
        `api-key=${entry.apiKey}`,
    );
  }
  const session = plan.session;
  lines.push(
    session.file === null
      ? `session: (none) — ${session.note}`
      : `session: ${session.file} (${session.mode}) — ${session.note}`,
  );
  lines.push(
    "tools:",
    `  plugins: ${plan.tools.plugins.dir} ` +
      `(${
        plan.tools.plugins.present
          ? `${plan.tools.plugins.files} plugin file(s); not loaded in a dry run`
          : "missing"
      })`,
    `  skills: ${plan.tools.skills.count} discovered from ` +
      `${plan.tools.skills.roots.join(", ")}`,
    `  commands: ${plan.tools.commands.count} discovered from ` +
      `${plan.tools.commands.roots.join(", ")}`,
  );
  const mcp = plan.tools.mcp;
  lines.push(
    !mcp.configured
      ? "  mcp: not configured"
      : `  mcp: ${mcp.file} ` +
          `(${mcp.present ? `${mcp.servers} server(s) configured` : "missing"})` +
          `${mcp.error ? ` — ${mcp.error}` : ""}`,
  );
  lines.push(
    `compaction: ${config.compaction.mode}` +
      `${config.compaction.force ? " (forced once)" : ""} — ` +
      `chars=${config.compaction.thresholdChars}, ` +
      `tokens=${config.compaction.thresholdTokens}, ` +
      `context-window=${config.compaction.contextWindow}, ` +
      `keep-recent=${config.compaction.keepRecentChars} chars, ` +
      `reserve=${config.compaction.reserveChars} chars/` +
      `${config.compaction.reserveTokens} tokens`,
    `limits: max-tokens=${config.limits.maxTokens ?? "(unset)"} ` +
      `retries=${config.limits.retries} timeout=${config.limits.timeoutSeconds}s`,
  );
  if (plan.problems.length === 0) {
    lines.push("problems: none");
  } else {
    lines.push("problems:");
    for (const problem of plan.problems) lines.push(`  - ${problem}`);
  }
  return lines;
}

/** `--dry-run` (+ `--json` in its JSON mode) for run/chat: exit 0, no writes. */
function printDryRun(
  command: "run" | "chat",
  cfg: Config,
  values: Record<string, any>,
  io: CliIO,
  task: ResolvedTask | undefined,
): number {
  const plan = buildDryRunPlan(command, cfg, values, task);
  if (resolveOutputMode(values) === "json") {
    io.log(JSON.stringify(plan));
    return 0;
  }
  for (const line of renderDryRunPlan(plan)) io.log(line);
  return 0;
}

async function doRun(argv: string[], io: CliIO): Promise<number> {
  const parsed = parseCommandArgs(
    argv,
    { ...OPTIONS, ...HELP_OPTIONS, ...RUN_INPUT_OPTIONS },
    "run",
    io,
    true,
  );
  if (parsed === null) return 2;
  const { values, positionals } = parsed;
  if (isHelpRequested(values)) {
    io.log(renderCommandHelp("run"));
    return 0;
  }
  const cfg = resolveConfig(argsToConfigArgs(values));
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
  const dryRun = values["dry-run"] === true;
  if (dryRun && values.stream === true) {
    io.error(
      "Error: --dry-run makes no model calls, so it cannot combine with --stream; drop one of them.",
    );
    return 2;
  }
  let resolved: ResolvedTask;
  try {
    resolved = await resolveRunTask(positionals, values);
  } catch (exc) {
    if (exc instanceof TaskInputError) {
      io.error(`[error] ${exc.message}`);
      io.error(`Usage: ${commandUsage("run")}`);
      io.error("Run 'two-brothers run --help'.");
      return 2;
    }
    throw exc;
  }
  if (dryRun) return printDryRun("run", cfg, values, io, resolved);
  try {
    const context = openSession(cfg, io);
    const resources = await loadRunResources(cfg, values, io);
    return await runOnce(cfg, resolved.task, io, context, {
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
  const parsed = parseCommandArgs(
    argv,
    { ...OPTIONS, ...HELP_OPTIONS, ...DRY_RUN_OPTIONS },
    "chat",
    io,
  );
  if (parsed === null) return 2;
  const { values } = parsed;
  if (isHelpRequested(values)) {
    io.log(renderCommandHelp("chat"));
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
  if (values["dry-run"] === true) return printDryRun("chat", cfg, values, io, undefined);
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

/** Command help as printed by `<command> --help` / `help <command>`; the TUI
 * additionally prints the key guide generated from the same keymap registry
 * that powers the in-app Ctrl+P palette and `?` overlay. */
function commandHelpFor(command: string): string {
  const text = renderCommandHelp(command);
  if (command !== "tui") return text;
  // tuiHelpLines() already starts with its own "Keys:" heading.
  return `${text}\n\n${tuiHelpLines().join("\n")}`;
}

/** `tui --help`: the clihelp spec plus the generated key guide. */
function printTuiHelp(io: CliIO): void {
  io.log(commandHelpFor("tui"));
}

async function doTui(argv: string[], io: CliIO): Promise<number> {
  const parsed = parseCommandArgs(argv, { ...OPTIONS, ...HELP_OPTIONS }, "tui", io, true);
  if (parsed === null) return 2;
  const { values, positionals } = parsed;
  if (isHelpRequested(values)) {
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

/** One parsed session JSONL: the listing view plus every protocol envelope
 * (needed by `sessions show`; the list command only uses the summary fields). */
interface SessionScan extends SessionListing {
  events: Array<Record<string, any>>;
}

/**
 * Read and parse one session JSONL file. Never throws for IO/parse problems:
 * an unreadable file comes back with an `error`, and corrupt lines are counted
 * (the first line number is reported) while every valid object is kept.
 */
function scanSessionFile(filePath: string, name: string): SessionScan {
  const fallback = name.endsWith(".jsonl") ? name.slice(0, -".jsonl".length) : name;
  let updated = "(unknown)";
  try {
    updated = formatMtime(fs.statSync(filePath).mtime);
  } catch {
    // unreadable stat: still list/show the file
  }

  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf-8");
  } catch (exc) {
    return {
      name,
      title: "(unreadable)",
      count: 0,
      updated,
      error: `cannot read file: ${exc instanceof Error ? exc.message : String(exc)}`,
      events: [],
    };
  }

  const lines = text.split(/\r?\n/);
  const head: Array<Record<string, any>> = [];
  const events: Array<Record<string, any>> = [];
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
    events.push(event as Record<string, any>);
    if (head.length < SCAN_LIMIT) head.push(event as Record<string, any>);
  }

  return {
    name,
    title: deriveTitle(head, fallback),
    count,
    updated,
    error: corruptLine ? `corrupt line ${corruptLine}` : null,
    events,
  };
}

function listSessions(sessionsDir: string): SessionListing[] {
  const names = fs
    .readdirSync(sessionsDir)
    .filter((name) => name.endsWith(".jsonl"))
    .sort();
  return names.map((name) => {
    const scan = scanSessionFile(path.join(sessionsDir, name), name);
    return {
      name: scan.name,
      title: scan.title,
      count: scan.count,
      updated: scan.updated,
      error: scan.error,
    };
  });
}

function formatMtime(mtime: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${mtime.getFullYear()}-${pad(mtime.getMonth() + 1)}-${pad(mtime.getDate())} ` +
    `${pad(mtime.getHours())}:${pad(mtime.getMinutes())}`
  );
}

const SESSIONS_OPTIONS = {
  "sessions-dir": { type: "string" as const },
  json: { type: "boolean" as const, default: false },
  limit: { type: "string" as const },
  format: { type: "string" as const },
  output: { type: "string" as const },
  ...HELP_OPTIONS,
} satisfies ParseArgsOptionsConfig;

/** `--limit` parse result: absent is fine, a bad value is a usage error. */
type LimitParse = { ok: true; limit?: number } | { ok: false };

function parseLimit(raw: unknown, io: CliIO): LimitParse {
  if (raw === undefined) return { ok: true };
  const text = String(raw).trim();
  if (!/^\d+$/.test(text)) {
    io.error(`[error] invalid --limit: ${String(raw)} (use a non-negative integer)`);
    return { ok: false };
  }
  return { ok: true, limit: Number.parseInt(text, 10) };
}

/** Resolve `sessions show <name>`: the name works with or without the
 * `.jsonl` suffix (and may be a path relative to the sessions directory). */
function resolveSessionFile(sessionsDir: string, requested: string): string | null {
  const name = requested.trim();
  if (!name) return null;
  const candidates = name.endsWith(".jsonl") ? [name] : [`${name}.jsonl`, name];
  for (const candidate of candidates) {
    const resolved = path.resolve(sessionsDir, candidate);
    try {
      if (fs.statSync(resolved).isFile()) return resolved;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/** Whitespace-collapsed, length-capped payload preview for `sessions show`. */
function previewText(value: unknown, max = 90): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > max ? text.slice(0, max) + "…" : text;
}

/** One rendered envelope line for the human `sessions show` output. */
function renderSessionEvent(event: Record<string, any>): string {
  const seq = typeof event.seq === "number" ? String(event.seq).padStart(3) : "  ?";
  const from = String(event.from ?? "?");
  const to = String(event.to ?? "?");
  const kind = String(event.kind ?? "?");
  const payload = event.payload ?? {};
  let summary = "";
  if (kind === "message") {
    summary = previewText(payload.text);
  } else if (kind === "consult") {
    summary = `ask: ${previewText(payload.ask)}`;
  } else if (kind === "proposal") {
    summary = `${previewText(payload.title)} — ${previewText(payload.answer)}`;
  } else if (kind === "delegation") {
    summary = `work: ${previewText(payload.work)}`;
  } else if (kind === "deliverable") {
    summary = `result: ${previewText(payload.result)}`;
  } else if (kind === "review") {
    summary = `verdict: ${previewText(payload.verdict)}`;
  } else if (kind === "decision") {
    summary = previewText(payload.decision);
  }
  return `  ${seq} ${from} -> ${to} ${kind}${summary ? ` — ${summary}` : ""}`;
}

/** `sessions [--json] [--limit N]`: the human table or a stable JSON array. */
function listSessionsCommand(
  sessionsDir: string,
  jsonMode: boolean,
  limit: number | undefined,
  io: CliIO,
): number {
  let listings: SessionListing[];
  try {
    listings = listSessions(sessionsDir);
  } catch {
    if (jsonMode) io.log("[]");
    else io.log(`no session files in ${sessionsDir}`);
    return 0;
  }
  if (listings.length === 0) {
    if (jsonMode) io.log("[]");
    else io.log(`no session files in ${sessionsDir}`);
    return 0;
  }
  const rows = limit === undefined ? listings : listings.slice(0, limit);
  if (jsonMode) {
    io.log(
      JSON.stringify(
        rows.map((item) => ({
          name: item.name,
          title: item.title,
          envelopes: item.count,
          updated: item.updated,
          error: item.error,
        })),
      ),
    );
    return 0;
  }
  io.log(
    `${padTrunc("session", 28)} ${padTrunc("title", 44)} ` +
      `${"envelopes".padStart(9)} updated`,
  );
  for (const item of rows) {
    const marker = item.error ? `  [error: ${item.error}]` : "";
    io.log(
      `${padTrunc(item.name, 28)} ${padTrunc(item.title, 44)} ` +
        `${String(item.count).padStart(9)} ${item.updated}${marker}`,
    );
  }
  return 0;
}

/** `sessions show <name> [--json] [--limit N]`: summary + protocol envelopes. */
function showSession(
  sessionsDir: string,
  names: string[],
  jsonMode: boolean,
  limit: number | undefined,
  io: CliIO,
): number {
  if (names.length === 0) {
    io.error("[error] no session name: sessions show <name> [--json] [--limit <n>]");
    io.error("Run 'two-brothers sessions --help'.");
    return 2;
  }
  if (names.length > 1) {
    io.error(`[error] unexpected argument: ${names.slice(1).join(" ")}`);
    io.error(`Usage: ${commandUsage("sessions")}`);
    io.error("Run 'two-brothers sessions --help'.");
    return 2;
  }
  const requested = names[0];
  const filePath = resolveSessionFile(sessionsDir, requested);
  if (filePath === null) {
    io.error(`Unknown session: ${requested} (in ${path.resolve(sessionsDir)})`);
    io.error("Run 'two-brothers sessions' for the session list.");
    return 2;
  }
  const scan = scanSessionFile(filePath, path.basename(filePath));
  if (scan.error !== null && scan.title === "(unreadable)") {
    io.error(`[error] ${scan.error}`);
    return 1;
  }
  const total = scan.events.length;
  const events = limit === undefined ? scan.events : scan.events.slice(0, limit);
  if (jsonMode) {
    io.log(
      JSON.stringify({
        name: scan.name,
        title: scan.title,
        envelopes: scan.count,
        updated: scan.updated,
        error: scan.error,
        events,
      }),
    );
    return 0;
  }
  io.log(`session: ${scan.name}`);
  io.log(`title: ${scan.title}`);
  io.log(`envelopes: ${scan.count}`);
  io.log(`updated: ${scan.updated}`);
  if (scan.error) io.log(`error: ${scan.error}`);
  if (events.length === 0) {
    io.log(
      total === 0
        ? "events: (none)"
        : `events: (none shown; ${total} hidden by --limit ${limit ?? 0})`,
    );
    return 0;
  }
  io.log("events:");
  for (const event of events) io.log(renderSessionEvent(event));
  if (limit !== undefined && limit < total) {
    io.log(`  … ${total - limit} more envelope(s); raise --limit to see them`);
  }
  return 0;
}

/** Shared diagnostic for a bad `sessions` subcommand invocation: exit 2. */
function sessionsUsageError(message: string, io: CliIO): number {
  io.error(`[error] ${message}`);
  io.error(`Usage: ${commandUsage("sessions")}`);
  io.error("Run 'two-brothers sessions --help'.");
  return 2;
}

/**
 * `sessions search <query> [--json] [--limit N]`: full-text search over every
 * session document (`src/sessionsearch.ts`, newest session first). Human
 * output is a `N matches in M sessions` header plus one
 * `<session>  <field>  <snippet>` line per hit; `--json` prints the exact
 * `SessionSearchResult` object. No matches prints "no matches" and exits 0; a
 * too-short/absent query or a bad flag is a usage error (exit 2).
 */
function searchSessionsCommand(
  sessionsDir: string,
  args: string[],
  jsonMode: boolean,
  limit: number | undefined,
  io: CliIO,
): number {
  const query = args.join(" ").trim();
  if (!query) {
    return sessionsUsageError("no search query: sessions search <query> [--json] [--limit <n>]", io);
  }
  if (query.length < SEARCH_MIN_QUERY_CHARS) {
    return sessionsUsageError(
      `query must be at least ${SEARCH_MIN_QUERY_CHARS} characters`,
      io,
    );
  }
  // Fail-soft corpus load: a missing sessions dir is an empty corpus and a
  // corrupt session file is skipped by `loadSessionDocs`.
  const loaded = loadSessionDocs(sessionsDir);
  const result = searchSessions(loaded.docs, query, limit === undefined ? {} : { limit });
  if (jsonMode) {
    io.log(JSON.stringify(result));
    return 0;
  }
  if (result.hits.length === 0) {
    io.log("no matches");
    return 0;
  }
  io.log(`${result.hits.length} matches in ${result.scanned_sessions} sessions`);
  for (const hit of result.hits) {
    io.log(`${hit.session}  ${hit.field}  ${hit.snippet}`);
  }
  return 0;
}

/**
 * One session as an export document (`src/sessionsearch.ts` shape), tolerant
 * like `sessions show`: corrupt lines are skipped, the `<name>.meta.json`
 * sidecar title wins over the derived one, and the file mtime supplies
 * `updated` (Unix seconds) for the export header. `null` when unreadable.
 */
function exportDocForCli(sessionsDir: string, filePath: string): SessionSearchDoc | null {
  const name = path.basename(filePath);
  const scan = scanSessionFile(filePath, name);
  if (scan.title === "(unreadable)") return null;
  const stem = name.replace(/\.jsonl$/, "");
  const meta = new SessionMetadataStore(sessionsDir).get(name);
  const metaTitle = meta !== null && typeof meta.title === "string" ? meta.title.trim() : "";
  const workspaceId =
    meta !== null && typeof meta.workspace_id === "string" && meta.workspace_id
      ? meta.workspace_id
      : null;
  let updated: number | null = null;
  try {
    updated = Math.floor(fs.statSync(filePath).mtimeMs / 1000);
  } catch {
    updated = null;
  }
  return {
    name,
    title: metaTitle || scan.title || stem,
    events: scan.events as unknown as SessionSearchDoc["events"],
    workspace_id: workspaceId,
    updated,
  };
}

/**
 * `sessions export <name> [--format markdown|json] [--output <path>]`:
 * default markdown on stdout; `--output <path>` writes the file and prints a
 * short `wrote <path>` confirmation to stderr (`--output -` means stdout).
 * Session names resolve with or without the `.jsonl` suffix. A missing
 * session is a runtime error (exit 1, the run/selftest convention); a bad
 * format, missing/extra name or unknown flag is a usage error (exit 2).
 */
function exportSessionCommand(
  sessionsDir: string,
  args: string[],
  formatRaw: unknown,
  outputRaw: unknown,
  io: CliIO,
): number {
  if (args.length === 0) {
    return sessionsUsageError(
      "no session name: sessions export <name> [--format markdown|json] [--output <path>]",
      io,
    );
  }
  if (args.length > 1) {
    return sessionsUsageError(`unexpected argument: ${args.slice(1).join(" ")}`, io);
  }
  const format = (typeof formatRaw === "string" ? formatRaw : "markdown").trim().toLowerCase();
  if (format !== "markdown" && format !== "json") {
    return sessionsUsageError(`unknown export format: ${format} (use markdown or json)`, io);
  }
  const requested = args[0];
  const filePath = resolveSessionFile(sessionsDir, requested);
  if (filePath === null) {
    io.error(`[error] session not found: ${requested} (in ${path.resolve(sessionsDir)})`);
    return 1;
  }
  const doc = exportDocForCli(sessionsDir, filePath);
  if (doc === null) {
    io.error(`[error] cannot read session file: ${filePath}`);
    return 1;
  }
  const body = format === "markdown" ? sessionToMarkdown(doc) : sessionToJsonString(doc);
  const output = typeof outputRaw === "string" ? outputRaw.trim() : "";
  if (!output || output === "-") {
    // the renderers end with exactly one newline; `io.log` adds one itself
    io.log(body.endsWith("\n") ? body.slice(0, -1) : body);
    return 0;
  }
  try {
    fs.writeFileSync(output, body, "utf-8");
  } catch (exc) {
    io.error(
      `[error] cannot write ${output}: ${exc instanceof Error ? exc.message : String(exc)}`,
    );
    return 1;
  }
  io.error(`wrote ${path.resolve(output)}`);
  return 0;
}

function doSessions(argv: string[], io: CliIO): number {
  const parsed = parseCommandArgs(argv, SESSIONS_OPTIONS, "sessions", io, true);
  if (parsed === null) return 2;
  const { values, positionals } = parsed;
  if (isHelpRequested(values)) {
    io.log(renderCommandHelp("sessions"));
    return 0;
  }
  const sessionsDir =
    typeof values["sessions-dir"] === "string" && values["sessions-dir"].trim()
      ? values["sessions-dir"]
      : "sessions";
  const limitResult = parseLimit(values.limit, io);
  if (!limitResult.ok) return 2;
  const jsonMode = values.json === true;
  const subcommand = positionals[0];
  if (subcommand === undefined) {
    return listSessionsCommand(sessionsDir, jsonMode, limitResult.limit, io);
  }
  if (subcommand === "show") {
    return showSession(sessionsDir, positionals.slice(1), jsonMode, limitResult.limit, io);
  }
  if (subcommand === "search") {
    return searchSessionsCommand(
      sessionsDir,
      positionals.slice(1),
      jsonMode,
      limitResult.limit,
      io,
    );
  }
  if (subcommand === "export") {
    return exportSessionCommand(
      sessionsDir,
      positionals.slice(1),
      values.format,
      values.output,
      io,
    );
  }
  // Kept as a thrown argument error (the long-standing contract for extra
  // positionals, covered by tests/cli.test.ts).
  throw new Error(
    `unexpected argument '${subcommand}' (sessions takes 'list', 'show', 'search' or 'export')`,
  );
}

// --------------------------------------------------------------------------- //
// doctor: local environment + provider diagnostics
// --------------------------------------------------------------------------- //

/**
 * The config flags `doctor` resolves (a focused subset of the shared run
 * flags: diagnostics read the provider, endpoints, models and wire kinds, and
 * nothing else). `--timeout` doubles as the endpoint-probe timeout below.
 */
const DOCTOR_OPTIONS = {
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
  timeout: { type: "string" as const },
  "sessions-dir": { type: "string" as const },
  json: { type: "boolean" as const, default: false },
  ...HELP_OPTIONS,
} satisfies ParseArgsOptionsConfig;

/**
 * `two-brothers doctor [--json] [--sessions-dir <dir>] [--timeout <s>]`:
 * run the diagnostics in `src/doctor.ts` and print the human report (plus a
 * `doctor: ok` / `doctor: N failed check(s)` summary) or one JSON object.
 * Exit 0 when no check failed, 1 otherwise, 2 on a usage/config error.
 */
async function doDoctor(argv: string[], io: CliIO): Promise<number> {
  const parsed = parseCommandArgs(argv, DOCTOR_OPTIONS, "doctor", io);
  if (parsed === null) return 2;
  const { values } = parsed;
  if (isHelpRequested(values)) {
    io.log(renderCommandHelp("doctor"));
    return 0;
  }
  let cfg: Config;
  try {
    // exactly like run: flags and TWO_BROTHERS_* env vars resolve the config;
    // a bad value (provider, kind, mode) is a usage error, not a crash
    cfg = resolveConfig(argsToConfigArgs(values));
  } catch (exc) {
    io.error(`[error] ${exc instanceof Error ? exc.message : String(exc)}`);
    io.error(`Usage: ${commandUsage("doctor")}`);
    return 2;
  }
  let timeoutMs: number | undefined;
  if (values.timeout !== undefined) {
    const seconds = Number(values.timeout);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      io.error(`[error] invalid --timeout: ${String(values.timeout)} (use positive seconds)`);
      io.error(`Usage: ${commandUsage("doctor")}`);
      return 2;
    }
    timeoutMs = seconds * 1000;
  }
  const report = await runDoctor({
    config: cfg,
    sessionsDir: values["sessions-dir"] ?? "sessions",
    cwd: process.cwd(),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
  if (values.json === true) {
    io.log(JSON.stringify(report, null, 2));
    return report.ok ? 0 : 1;
  }
  for (const line of formatDoctorReport(report)) io.log(line);
  const failed = report.checks.filter((check) => check.status === "fail").length;
  io.log(report.ok ? "doctor: ok" : `doctor: ${failed} failed check(s)`);
  return report.ok ? 0 : 1;
}

// --------------------------------------------------------------------------- //
// config: the resolved configuration, with per-field provenance
// --------------------------------------------------------------------------- //

/**
 * The config command's flags: the provider subset `doctor` accepts plus the
 * store location and `--json`. It resolves exactly like `run` (flags > env >
 * defaults) and layers the persisted settings/presets from `<sessions-dir>`
 * for the serve path.
 */
const CONFIG_OPTIONS = {
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
  "max-tokens": { type: "string" as const },
  retries: { type: "string" as const },
  timeout: { type: "string" as const },
  mode: { type: "string" as const },
  "sessions-dir": { type: "string" as const },
  json: { type: "boolean" as const, default: false },
  ...HELP_OPTIONS,
} satisfies ParseArgsOptionsConfig;

/**
 * `two-brothers config [--json] [provider flags]`: the resolved configuration
 * with per-field provenance. Reads `<sessions-dir>/settings.json` for the
 * preset/settings layers; keys are only reported as set/not set. Never makes
 * a provider call. Exit 0, or 2 on a usage/config error.
 */
function doConfig(argv: string[], io: CliIO): number {
  const parsed = parseCommandArgs(argv, CONFIG_OPTIONS, "config", io);
  if (parsed === null) return 2;
  const { values } = parsed;
  if (isHelpRequested(values)) {
    io.log(renderCommandHelp("config"));
    return 0;
  }
  let cfg: Config;
  try {
    cfg = resolveConfig(argsToConfigArgs(values));
  } catch (exc) {
    io.error(`[error] ${exc instanceof Error ? exc.message : String(exc)}`);
    io.error(`Usage: ${commandUsage("config")}`);
    io.error("Run 'two-brothers config --help'.");
    return 2;
  }
  const sessionsDir =
    typeof values["sessions-dir"] === "string" && values["sessions-dir"].trim()
      ? values["sessions-dir"].trim()
      : "sessions";
  const store = new SettingsStore(path.join(sessionsDir, "settings.json"));
  const view = buildConfigView({
    config: cfg,
    env: process.env,
    settings: store.read(),
    flags: values,
    presets: mergeSeedPresets(store.readProviders()),
    cwd: process.cwd(),
    homeDir: os.homedir(),
    sessionsDir,
    settingsFile: store.filePath,
    settingsPresent: fs.existsSync(store.filePath),
  });
  if (values.json === true) {
    io.log(JSON.stringify(view));
    return 0;
  }
  for (const line of renderConfigView(view)) io.log(line);
  return 0;
}

// --------------------------------------------------------------------------- //
// completions: shell completion scripts from the clihelp catalog
// --------------------------------------------------------------------------- //

/**
 * The completion surface: every command in display order (with the help
 * catalog's one-line summary and the exact flag names its parseArgs accepts)
 * plus every long flag as a global candidate. The same catalog powers help,
 * so the script can never drift from the documented commands.
 */
function completionSpec(): CompletionSpec {
  return {
    program: "two-brothers",
    commands: commandNames().map((name) => {
      const help = commandHelp(name);
      return {
        name,
        ...(help ? { description: help.summary } : {}),
        flags: flagCandidatesForCommand(name),
      };
    }),
    globalFlags: allFlagNames(),
  };
}

/**
 * `two-brothers completions <bash|zsh|fish|powershell>`: print the generated
 * script on stdout. A missing or unknown shell is a usage error (exit 2).
 */
function doCompletions(argv: string[], io: CliIO): number {
  const parsed = parseCommandArgs(argv, HELP_OPTIONS, "completions", io, true);
  if (parsed === null) return 2;
  const { values, positionals } = parsed;
  if (isHelpRequested(values)) {
    io.log(renderCommandHelp("completions"));
    return 0;
  }
  if (positionals.length > 1) {
    io.error(`[error] unexpected argument: ${positionals.slice(1).join(" ")}`);
    io.error(`Usage: ${commandUsage("completions")}`);
    io.error("Run 'two-brothers completions --help'.");
    return 2;
  }
  const shell = (positionals[0] ?? "").trim().toLowerCase();
  if (!shell) {
    io.error(`[error] no shell given: completions <${COMPLETION_SHELLS.join("|")}>`);
    io.error(`Usage: ${commandUsage("completions")}`);
    io.error("Run 'two-brothers completions --help'.");
    return 2;
  }
  if (!(COMPLETION_SHELLS as readonly string[]).includes(shell)) {
    io.error(
      `[error] unknown shell: ${shell} (choose one of ${COMPLETION_SHELLS.join(", ")})`,
    );
    io.error(`Usage: ${commandUsage("completions")}`);
    io.error("Run 'two-brothers completions --help'.");
    return 2;
  }
  const script = generateCompletions(shell as CompletionShell, completionSpec());
  // the generator returns exactly one trailing newline; `io.log` adds one
  io.log(script.endsWith("\n") ? script.slice(0, -1) : script);
  return 0;
}

async function doServe(argv: string[], io: CliIO): Promise<number> {
  const parsed = parseCommandArgs(
    argv,
    {
      ...OPTIONS,
      host: { type: "string" as const },
      port: { type: "string" as const },
      "sessions-dir": { type: "string" as const },
      workers: { type: "string" as const },
      ...HELP_OPTIONS,
    },
    "serve",
    io,
  );
  if (parsed === null) return 2;
  const { values } = parsed;
  if (isHelpRequested(values)) {
    io.log(renderCommandHelp("serve"));
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
  ...HELP_OPTIONS,
} satisfies ParseArgsOptionsConfig;

async function doModels(argv: string[], io: CliIO): Promise<number> {
  const parsed = parseCommandArgs(argv, MODELS_OPTIONS, "models", io);
  if (parsed === null) return 2;
  const { values } = parsed;
  if (isHelpRequested(values)) {
    io.log(renderCommandHelp("models"));
    return 0;
  }
  const baseUrl = values["base-url"]?.trim() ?? "";
  if (!baseUrl) {
    io.error("[error] --base-url is required");
    // Keep the legacy bare `Usage: models ...` line: the discovery command's
    // long-standing message is pinned by tests/cliergonomics.test.ts.
    io.error(`Usage: ${commandUsage("models").replace(/^two-brothers /, "")}`);
    io.error("Run 'two-brothers models --help'.");
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
  ...HELP_OPTIONS,
} satisfies ParseArgsOptionsConfig;

/** Local-first default endpoint LM Studio serves. */
const DEFAULT_ONBOARD_BASE_URL = "http://localhost:1234/v1";

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
  const parsed = parseCommandArgs(argv, ONBOARD_OPTIONS, "onboard", io);
  if (parsed === null) return 2;
  const { values } = parsed;
  if (isHelpRequested(values)) {
    io.log(renderCommandHelp("onboard"));
    return 0;
  }
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
    io.error(`Usage: ${commandUsage("onboard")}`);
    io.error("Run 'two-brothers onboard --help'.");
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

/** `two-brothers help [command]` / `two-brothers help --all`. */
function doHelp(argv: string[], io: CliIO): number {
  const parsed = parseCommandArgs(
    argv,
    { all: { type: "boolean" as const, default: false }, ...HELP_OPTIONS },
    "help",
    io,
    true,
  );
  if (parsed === null) return 2;
  const { values, positionals } = parsed;
  if (values.all === true) {
    io.log(renderFullHelp());
    return 0;
  }
  if (isHelpRequested(values)) {
    printHelp(io);
    return 0;
  }
  const target = positionals[0];
  if (target === undefined) {
    printHelp(io);
    return 0;
  }
  if (positionals.length > 1) {
    io.error(`[error] unexpected argument: ${positionals.slice(1).join(" ")}`);
    io.error("Usage: two-brothers help [command]");
    io.error("Run 'two-brothers help --help'.");
    return 2;
  }
  if (commandHelp(target) === undefined) return reportUnknownCommand(target, io);
  io.log(commandHelpFor(target));
  return 0;
}

/** `two-brothers selftest [--help]`: the offline protocol/provider gate. */
async function doSelftest(argv: string[], io: CliIO): Promise<number> {
  const parsed = parseCommandArgs(argv, HELP_OPTIONS, "selftest", io);
  if (parsed === null) return 2;
  if (isHelpRequested(parsed.values)) {
    io.log(renderCommandHelp("selftest"));
    return 0;
  }
  return selftest();
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
  if (command === "help") return doHelp(argv.slice(1), io);
  if (command === "--help" || command === "-h") {
    printHelp(io);
    return 0;
  }
  if (command === "--version" || command === "-v") {
    io.log(packageVersion());
    return 0;
  }
  if (command === "selftest") return doSelftest(argv.slice(1), io);
  if (command === "sessions") return doSessions(argv.slice(1), io);
  if (command === "run") return doRun(argv.slice(1), io);
  if (command === "chat") return doChat(argv.slice(1), io);
  if (command === "tui") return doTui(argv.slice(1), io);
  if (command === "serve") return doServe(argv.slice(1), io);
  if (command === "models") return doModels(argv.slice(1), io);
  if (command === "onboard") return doOnboard(argv.slice(1), io);
  if (command === "doctor") return doDoctor(argv.slice(1), io);
  if (command === "config") return doConfig(argv.slice(1), io);
  if (command === "completions") return doCompletions(argv.slice(1), io);
  // An option in the command position (`two-brothers --bogus`) is an unknown
  // option; anything else is an unknown command (both exit 2 with a hint).
  if (command.startsWith("-")) {
    reportUnknownOption(command, undefined, io);
    return 2;
  }
  return reportUnknownCommand(command, io);
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
