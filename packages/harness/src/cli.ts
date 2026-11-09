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

import {
  compactionSettingsFromConfig,
  resolveConfig,
  maxTokensForRole,
  thinkingBudgetForRole,
  validateRunConfig,
  type Config,
} from "./config.ts";
import {
  APPROVAL_MODES,
  approvalModeWarning,
  normalizeApprovalMode,
  type ApprovalMode,
} from "./permissions.ts";
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
import { compactContext, estimateTokens, type CompactionSettings } from "./compaction.ts";
import {
  BASE_COMMANDS,
  baseCommandUsage,
  expandBaseCommand,
  findBaseCommand,
  sortBaseCommands,
  type BaseCommand,
} from "./basecommands.ts";
import {
  discoverCommands,
  expandCommand,
  matchCommand,
  type CommandCatalog,
} from "./commands.ts";
import { estimateRunCostFromUsage, type CostEstimate } from "./cost.ts";
import { plainCliStyle, resolveCliStyle, terminalWidth, type CliStyle } from "./clistyle.ts";
import {
  createLiveTranscript,
  humanFooter,
  paintRole,
  renderMessages,
  sanitizeOneLine,
} from "./clilayout.ts";
import { formatDoctorReport, runDoctor } from "./doctor.ts";
import { TwoBrothersHarness, type PromptAuditEntry, type ToolScopes } from "./harness.ts";
import { RuntimeEventStore, type RuntimeEvent } from "./runevents.ts";
import {
  loadMcpToolSpecs,
  loadMcpTools,
  mergeMcpConfig,
  type McpConfigFileShape,
  type McpToolSet,
} from "./mcp.ts";
import { SessionMetadataStore } from "./metadata.ts";
import {
  migrateFlatSessions,
  SessionLayout,
  SessionLayoutLockedError,
} from "./sessionlayout.ts";
import { mergeSeedPresets, presetById, presetIds, seedPresets } from "./presets.ts";
import { repeatToolGuardFromEnv } from "./repeatguard.ts";
import { toNdjsonLine, type StreamEvent } from "./runstream.ts";
import {
  PluginManager,
  type PluginBindings,
  type PluginDiagnosticEntry,
} from "./plugins.ts";
import {
  buildProvider,
  ANTHROPIC_MIN_THINKING_BUDGET,
  DEFAULT_PROVIDER_KIND,
  isProviderKind,
  listModels,
  PROVIDER_KIND_HINT,
  roleProviderKind,
  resolveProviderKind,
  type Provider,
  type Tool,
} from "./provider.ts";
import type { RoleEndpoint } from "./runtime.ts";
import { selftest } from "./selftest.ts";
import { createServer } from "./server.ts";
import {
  restoreContextResult,
  sessionRecoveryWarning,
  SessionError,
  SessionStore,
} from "./session.ts";
import { forkSession, SessionForkError } from "./sessionfork.ts";
import {
  SEARCH_MIN_QUERY_CHARS,
  loadSessionDocs,
  searchSessions,
  sessionToHtmlString,
  sessionToJsonString,
  sessionToMarkdown,
  type SessionSearchDoc,
} from "./sessionsearch.ts";
import { rewindSession, validateRewindTurns } from "./sessionrewind.ts";
import { discoverSkills, type SkillCatalog } from "./skills.ts";
import {
  SpillStore,
  type SpillPruneResult,
  type SpillStats,
} from "./spill.ts";
import { envPinnedPairs, SettingsStore } from "./settings_store.ts";
import { WorkspaceRegistry } from "./workspace.ts";
import {
  applyUndo,
  collectOrphanBlobs,
  discardUndo,
  listUndoRecords,
  loadUndoRecord,
  previewUndo,
  WorkspaceUndoError,
  type WorkspaceUndoRecord,
} from "./workspacehistory.ts";
import { runTuiApp } from "./tui/app.ts";
import {
  defaultTuiKeysPath,
  loadTuiKeyCommands,
  type TuiKeysLoadState,
  type TuiKeysOrigin,
  type TuiKeysSource,
} from "./tui/keyoverrides.ts";
import { tuiHelpLines, TUI_COMMANDS, type TuiCommand } from "./tui/keymap.ts";
import {
  installTurnSignalHandlers,
  turnSignalExitCode,
  TURN_CANCEL_BUDGET_MS,
  waitForTurnOutcome,
  type TurnSignalEmitter,
  type TurnSignalName,
} from "./turnsignal.ts";

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

/**
 * `--approval-mode` is parsed by `run`, `chat`, `serve` and `tui`. `run`/`chat`
 * bind no workspace so the flag is inert there (the help says so honestly);
 * `serve` pins it for every web run and `tui` pins it for the TUI process
 * (both never persisted — the saved `approval_policy` setting otherwise
 * applies, and the TUI's `/permission` selector writes that setting).
 * `resolveConfig` validates the value (exit 2 on an unknown mode).
 */
const APPROVAL_MODE_OPTIONS = {
  "approval-mode": { type: "string" as const },
} satisfies ParseArgsOptionsConfig;

/**
 * `--thinking-budget` is parsed by `run`, `chat`, `tui` and `serve` only — the
 * surfaces that build role providers and validate the option. It stays out of
 * the shared `OPTIONS` table so other commands reject it instead of silently
 * ignoring an Anthropic extended-thinking setting.
 */
const THINKING_BUDGET_OPTIONS = {
  "thinking-budget": { type: "string" as const },
} satisfies ParseArgsOptionsConfig;

/**
 * `tui`-only flags. Like `--dry-run` they stay out of the shared `OPTIONS`
 * table, so `run`/`chat`/`serve` reject them instead of silently ignoring
 * them. `--workspace <dir>` binds every TUI turn to one confined workspace
 * (workspace tools, operator approvals and `@path` attachments).
 */
const TUI_OPTIONS = {
  workspace: { type: "string" as const },
  "keys-file": { type: "string" as const },
  "keys-watch": { type: "boolean" as const, default: false },
} satisfies ParseArgsOptionsConfig;

const RUN_INPUT_OPTIONS = {
  ...DRY_RUN_OPTIONS,
  ...TASK_FILE_OPTIONS,
} satisfies ParseArgsOptionsConfig;

/**
 * Live-transcript flags, parsed by `run` and `chat` only. Like `--dry-run`
 * they stay out of the shared `OPTIONS` table, so `serve`/`tui` reject them
 * instead of silently ignoring them.
 *
 * The default is "live only on an interactive stdout": `--live` cannot force
 * a pipe to stream (piped bytes never change), and `--no-live` is the
 * explicit opt-out on a terminal. `--no-live` wins when both are given.
 */
const LIVE_OPTIONS = {
  live: { type: "boolean" as const, default: false },
  "no-live": { type: "boolean" as const, default: false },
} satisfies ParseArgsOptionsConfig;

/**
 * The `runOnce` live override from parsed flags: `false` for `--no-live`
 * (wins when both are given), `true` for `--live`, and `undefined` for the
 * default "on for a TTY only, never for a pipe or a machine output mode".
 */
function liveFlag(values: Record<string, any>): boolean | undefined {
  if (values["no-live"] === true) return false;
  if (values.live === true) return true;
  return undefined;
}

/**
 * Validate an explicit `--approval-mode` (or its `TWO_BROTHERS_APPROVAL_MODE`
 * env counterpart) before `resolveConfig` runs: an unknown mode is a usage
 * error the caller reports as exit 2, not a rejected run. `null` = valid or
 * absent (the default applies).
 */
function approvalModeProblem(values: Record<string, any>): string | null {
  const raw =
    typeof values["approval-mode"] === "string" && values["approval-mode"].trim()
      ? values["approval-mode"]
      : (process.env.TWO_BROTHERS_APPROVAL_MODE ?? "").trim();
  if (!raw) return null;
  if (normalizeApprovalMode(raw) !== null) return null;
  return `invalid approval mode: ${String(raw)} (use ${APPROVAL_MODES.join("|")})`;
}

/** One usage-error block for a bad `--approval-mode`; returns exit code 2. */
function reportApprovalModeProblem(
  command: string,
  problem: string,
  io: CliIO,
): number {
  io.error(`[error] ${problem}`);
  io.error(`Usage: ${commandUsage(command)}`);
  io.error(`Run 'two-brothers ${command} --help'.`);
  return 2;
}

/**
 * Validate an explicit `--thinking-budget` (or its
 * `TWO_BROTHERS_THINKING_BUDGET` env counterpart) before `resolveConfig` runs:
 * it must be a positive integer of at least `ANTHROPIC_MIN_THINKING_BUDGET`
 * (1024). `null` = valid or absent. A budget that does not fit under the
 * effective `max_tokens` is not an error here: the Anthropic adapter keeps the
 * request valid by raising that cap with one honest warning (the
 * budget < max_tokens relationship is a provider-api detail the adapter owns).
 */
function thinkingBudgetProblem(values: Record<string, any>): string | null {
  const raw =
    typeof values["thinking-budget"] === "string" && values["thinking-budget"].trim()
      ? values["thinking-budget"].trim()
      : (process.env.TWO_BROTHERS_THINKING_BUDGET ?? "").trim();
  if (!raw) return null;
  const parsed = /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < ANTHROPIC_MIN_THINKING_BUDGET) {
    return (
      `invalid thinking budget: ${raw} (use an integer of at least ` +
      `${ANTHROPIC_MIN_THINKING_BUDGET} tokens; --thinking-budget <n>)`
    );
  }
  return null;
}

/** One usage-error block for a bad `--thinking-budget`; returns exit code 2. */
function reportThinkingBudgetProblem(command: string, problem: string, io: CliIO): number {
  io.error(`[error] ${problem}`);
  io.error(`Usage: ${commandUsage(command)}`);
  io.error(`Run 'two-brothers ${command} --help'.`);
  return 2;
}

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
  "thinking-budget": "thinkingBudget",
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
  "approval-mode": "approvalMode",
};

/**
 * Output sink so commands can be driven in-process by tests.
 *
 * `isTTY` is the stdout terminal signal used to turn the live transcript on:
 * it is injectable (tests/embedders can simulate a terminal) and optional —
 * a custom sink without it is treated as a pipe, so its bytes never change.
 */
export interface CliIO {
  log(line: string): void;
  error(line: string): void;
  /** True when stdout is an interactive terminal (enables live transcript). */
  readonly isTTY?: boolean;
}

const defaultIO: CliIO = {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
  // A getter, not a snapshot: `main` is called once per process but tests and
  // embedders can flip the terminal state; the live decision must read it then.
  get isTTY() {
    return process.stdout.isTTY === true;
  },
};

// --------------------------------------------------------------------------- //
// help + argument-error plumbing (all help text lives in src/clihelp.ts)
// --------------------------------------------------------------------------- //

/** `--help` or `-h` was passed (both `parseArgs` keys are checked). */
function isHelpRequested(values: Record<string, any>): boolean {
  return values.help === true || values.h === true;
}

/** Paint the leading `[warn]` marker of a diagnostic line, leaving text intact. */
function paintWarningPrefix(style: CliStyle, line: string): string {
  const match = /^\[warn\](\s[\s\S]*)$/.exec(line);
  if (match === null) return line;
  return `[${style.paint("warning", "warn")}]${match[1]}`;
}

/** Print the concise grouped top-level help (bare invocation, `--help`, ...). */
function printHelp(io: CliIO, style: CliStyle = plainCliStyle): void {
  io.log(renderMainHelp(style));
}

/**
 * An unknown command (or an unknown target of `help <command>`): the error,
 * a did-you-mean suggestion within edit distance 2 and the help pointer go to
 * stderr; stdout keeps the short usage block the legacy contract expects.
 * Returns exit code 2.
 */
function reportUnknownCommand(
  target: string,
  io: CliIO,
  style: CliStyle = plainCliStyle,
): number {
  const suggestion = suggestCommand(target);
  io.error(`Unknown command: ${target}`);
  if (suggestion !== null) io.error(`Did you mean '${suggestion}'?`);
  io.error("Run 'two-brothers help' for the command list.");
  io.log(renderBriefUsage(style));
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
 * The role is painted with its transcript token and the node kind is `dim`.
 */
function renderPromptAudits(
  audits: PromptAuditEntry[],
  style: CliStyle = plainCliStyle,
): string {
  if (audits.length === 0) return "";
  const lines = [style.paint("strong", "prompt audits:")];
  for (const audit of audits) {
    const tools = audit.tools.length > 0 ? audit.tools.join(", ") : "(none)";
    lines.push(
      `  ${paintRole(style, audit.role)} ${style.dim(audit.kind)}: ` +
        `${audit.sections.join(" > ")}; tools: ${tools}; ` +
        `system ${audit.systemChars} chars, user ${audit.userChars} chars`,
    );
  }
  return lines.join("\n");
}

// The per-envelope renderer, the finished-transcript renderer and the live TTY
// projection live together in `src/clilayout.ts`, so one implementation feeds
// piped output, tests and the incremental path. `renderMessages` stays part of
// this module's surface for existing importers.
export { renderMessages };


/**
 * Boolean parser flags (`--compact`, `--resume`, `--json`, …). Their parser
 * default is `false`, so forwarding that default as a config arg would override
 * a true `TWO_BROTHERS_*` env value (resolveConfig merges env before args).
 * They are forwarded only when the flag is actually set.
 */
const BOOLEAN_CONFIG_FLAGS = new Set(
  Object.entries(OPTIONS)
    .filter(([, spec]) => (spec as { type?: string }).type === "boolean")
    .map(([flag]) => flag),
);

function argsToConfigArgs(values: Record<string, any>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [flag, configKey] of Object.entries(FLAG_TO_CONFIG)) {
    // "print"/"json" are output modes for `run`, not cooperation modes —
    // leave cfg.mode at its default (or the env value) in that case
    if (flag === "mode" && isOutputMode(values[flag])) continue;
    // `--json` is also forwarded when set, so Config.jsonOut keeps reflecting
    // the flag OR its env spelling (TWO_BROTHERS_JSON) for output resolution.
    if (BOOLEAN_CONFIG_FLAGS.has(flag) && values[flag] !== true) continue;
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

/**
 * Resolve the non-interactive output mode. Explicit output flags and modes
 * come first (`--stream` > `--json-events` > `--mode print|json` > bare
 * `--json`), then `Config.jsonOut` — the bare `--json` flag or its env
 * spelling `TWO_BROTHERS_JSON` (aligned by contract) — then the human text
 * default.
 */
function resolveOutputMode(values: Record<string, unknown>, jsonOut = false): OutputMode {
  if (values.stream === true) return "stream";
  if (values["json-events"] === true) return "json";
  // An explicit output mode wins, so the documented `--mode print --json`
  // (decision object only) keeps working. A BARE `--json` is shorthand for
  // `--mode json`: the full machine-readable object, never a print-mode
  // modifier that leaves the human transcript on stdout.
  if (isOutputMode(values.mode)) return values.mode;
  if (values.json === true) return "json";
  // `TWO_BROTHERS_JSON=1|true` is the env spelling of a bare `--json`; an
  // explicit output flag/mode above always wins over it (`--mode print` stays
  // print, `--json` flag with env `0` stays JSON).
  if (jsonOut) return "json";
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
        // Extended thinking is Anthropic-only; buildProvider forwards the
        // field and every other adapter ignores it (request bytes unchanged).
        thinkingBudgetTokens: thinkingBudgetForRole(cfg, role),
        ...(onWarning ? { onWarning } : {}),
      },
      role,
    );
  }
  return out;
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
    if (store.exists()) {
      const restored = restoreContextResult(store);
      // A torn final line (crash mid-append) is repaired by the resume path;
      // surface it once on stderr, never on machine stdout.
      if (restored.recovered) {
        io.error(`[warn] ${sessionRecoveryWarning(cfg.sessionFile, restored)}`);
      }
      return restored.context;
    }
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

/**
 * MCP config file for an invocation: `--mcp-config` > the pinned
 * `TWO_BROTHERS_MCP_CONFIG` environment variable (`clihelp.ts` and
 * `docs/cli-reference.md` map the two to each other). A blank/whitespace
 * value on either layer means "not configured"; a blank flag falls back to
 * the env value. The path is returned as given — the MCP loader resolves
 * relative paths — and flag/env are pinned like every other `TWO_BROTHERS_*`
 * value, never persisted.
 */
export function mcpConfigFromValues(
  values: Record<string, any>,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const flag = typeof values["mcp-config"] === "string" ? values["mcp-config"].trim() : "";
  if (flag !== "") return flag;
  const envFile = (env.TWO_BROTHERS_MCP_CONFIG ?? "").trim();
  return envFile !== "" ? envFile : undefined;
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

/** Resolved TUI keys-file choice (`--keys-file` > env > default path). */
export interface CliTuiKeysFile {
  path: string;
  /** Where the path came from (`help tui`/`/keys show` report this honestly). */
  origin: TuiKeysOrigin;
  /** The operator named the path (flag or env), so a missing file is reported. */
  explicit: boolean;
}

/**
 * The TUI keys file for one invocation: `--keys-file` > the pinned
 * `TWO_BROTHERS_TUI_KEYS_FILE` environment variable > the default
 * `~/.two-brothers/tui-keys.json`. Flag and env are pinned like every other
 * `TWO_BROTHERS_*` value — never persisted.
 */
export function tuiKeysFileForCli(
  values: Record<string, any>,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): CliTuiKeysFile {
  const flag = typeof values["keys-file"] === "string" ? values["keys-file"].trim() : "";
  if (flag !== "") return { path: path.resolve(flag), origin: "flag", explicit: true };
  const envFile = (env.TWO_BROTHERS_TUI_KEYS_FILE ?? "").trim();
  if (envFile !== "") return { path: path.resolve(envFile), origin: "env", explicit: true };
  return { path: defaultTuiKeysPath(home), origin: "default", explicit: false };
}

/**
 * Opt-in keys-file watching for the TUI: `tui --keys-watch` or the pinned
 * `TWO_BROTHERS_TUI_KEYS_WATCH` environment variable (`1`/`true`/`yes`/`on`,
 * the usual boolean convention). Pinned like every other env value — never
 * persisted; off by default, so an invocation without either behaves exactly
 * like the on-demand-only TUI.
 */
export function tuiKeysWatchForCli(
  values: Record<string, any>,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return values["keys-watch"] === true || envFlag(env, "TWO_BROTHERS_TUI_KEYS_WATCH");
}

/**
 * The effective TUI command table for one invocation. Fail-soft by contract: a
 * missing default file is silent, while an unreadable/invalid file (or an
 * explicitly named one that is absent) yields the default commands plus one
 * honest diagnostic line, never a crash or a half-applied table.
 */
export function resolveTuiKeyCommandsForCli(
  values: Record<string, any>,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): {
  commands: readonly TuiCommand[];
  diagnostics: readonly string[];
  file: CliTuiKeysFile;
  state: TuiKeysLoadState;
} {
  const file = tuiKeysFileForCli(values, env, home);
  const source: TuiKeysSource = { path: file.path, origin: file.origin };
  const loaded = loadTuiKeyCommands(source);
  return {
    commands: loaded.commands,
    diagnostics: loaded.diagnostics,
    file,
    state: loaded.state,
  };
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

/**
 * Honest work-mode notice for the CLI path, or `null` when no warning applies.
 *
 * `two-brothers run --mode work` has no workspace option, so no workspace
 * built-ins can bind; without any shared or junior MCP/plugin-contributed tool
 * the junior has no way to read or write files. Senior-only tools do not help
 * the junior, so they never suppress the warning. In that configuration a small
 * model can fabricate a deliverable that the run accepts with exit 0. The
 * warning is one bounded line on stderr (stdout and exit codes stay untouched).
 */
export function workModeWithoutToolsWarning(
  mode: Config["mode"],
  scopes: ToolScopes,
): string | null {
  if (mode !== "work") return null;
  const juniorBelt = [...(scopes.shared ?? []), ...(scopes.junior ?? [])];
  if (juniorBelt.length > 0) return null;
  return (
    "work mode has no tools bound: CLI runs are not workspace-bound, so the junior " +
    "has no shared/junior tools and cannot read or write files; a deliverable it " +
    "claims may not exist. Use `serve`/TUI with a workspace, or bind a shared or " +
    "junior tool (for example an MCP server with role shared/junior, or a plugin tool)."
  );
}

/** Loose view of a `UsageTotals` (or an empty object) for CLI rendering. */
interface UsageView {
  input_tokens?: unknown;
  output_tokens?: unknown;
  cached_tokens?: unknown;
  cache_write_tokens?: unknown;
  model_calls?: unknown;
}

function usageInt(value: unknown): number {
  const num = Number(value ?? 0) || 0;
  return Number.isFinite(num) ? num : 0;
}

/** The token-usage footer: `tokens: in/out (cache N%, M model calls)`. */
export function usageLine(usage: UsageView, style: CliStyle = plainCliStyle): string {
  const inp = usageInt(usage.input_tokens);
  const out = usageInt(usage.output_tokens);
  const cached = usageInt(usage.cached_tokens);
  const calls = usageInt(usage.model_calls);
  const pct = inp ? Math.min(100, Math.round((cached * 100) / inp)) : 0;
  return (
    `${style.paint("muted", "tokens:")} ` +
    `${inp}/${out} (cache ${pct}%, ${calls} model calls)`
  );
}

/**
 * The run's cost estimate, when the merged usage can be attributed to one
 * model and one prompt-cache family: the harness reports one merged counter
 * set, not per-role splits, so mixed models stay unknown, and cache tokens are
 * priced with the same family mapping the server and TUI use (a CLI run against
 * Anthropic must not price cache reads/writes at the full input rate). `null`
 * when unknown — the caller prints no line and JSON carries `null`.
 */
export function estimateRunCost(cfg: Config, usage: UsageView): CostEstimate | null {
  return estimateRunCostFromUsage({
    seniorModel: cfg.seniorModel,
    juniorModel: cfg.juniorModel,
    seniorFamily: roleProviderKind(cfg, undefined, "senior"),
    juniorFamily: roleProviderKind(cfg, undefined, "junior"),
    usage,
  });
}

/** `cost: $0.0300 (in 4000 / out 2000 tokens)`, or null when not estimable. */
export function costLine(
  cfg: Config,
  usage: UsageView,
  style: CliStyle = plainCliStyle,
): string | null {
  const cost = estimateRunCost(cfg, usage);
  if (cost === null) return null;
  return (
    `${style.paint("muted", "cost:")} ` +
    `${style.paint("strong", `$${cost.totalCost.toFixed(4)}`)} ` +
    style.paint(
      "muted",
      `(in ${usageInt(usage.input_tokens)} / out ${usageInt(usage.output_tokens)} tokens)`,
    )
  );
}

/**
 * A per-run provider diagnostic sink: `[warn]` lines reach stderr (never
 * stdout, so `--mode json` / `--json` / `--stream` stay parseable), at most
 * three per run. These are diagnostics, not `--verbose` output — a slow
 * endpoint should say something without the operator opting in. The optional
 * style paints only the leading `[warn]` marker.
 */
function providerWarningSink(
  io: CliIO,
  limit = 3,
  style: CliStyle = plainCliStyle,
): (line: string) => void {
  let emitted = 0;
  return (line) => {
    if (emitted >= limit) return;
    emitted += 1;
    io.error(paintWarningPrefix(style, line));
  };
}

/**
 * Human verb for one provider-call node kind (`consult` → `consulting`), so
 * the live activity line reads `· senior consulting…` instead of repeating
 * the protocol kind. Unknown kinds fall back to the kind itself.
 */
const ACTIVITY_VERBS: Readonly<Record<string, string>> = {
  consult: "consulting",
  delegation: "delegating",
  proposal: "proposing",
  deliverable: "delivering",
  review: "reviewing",
  verify: "verifying",
  decision: "deciding",
  answer: "answering",
  message: "replying",
};

/**
 * The compact live activity row for one typed runtime event, or `null` when
 * the event has no operator-facing progress (run status, approvals, errors —
 * the transcript, footer and stderr already report those).
 *
 * `prompt_audit` fires immediately before each provider call, so the row is
 * visible while the model is working rather than only after the reply;
 * `tool_started` / a non-ok `tool_completed` mirror tool work. The rows are
 * deliberately plain text (no spinner frames): they stay honest on slow
 * provider waits, need no terminal cursor control, and are width/color-safe
 * through `clilayout.ts`.
 */
function activityForEvent(event: RuntimeEvent): string | null {
  switch (event.type) {
    case "prompt_audit": {
      const role = sanitizeOneLine(event.role);
      const kind = sanitizeOneLine(event.kind);
      const verb = ACTIVITY_VERBS[kind] ?? (kind !== "" ? kind : "working");
      return `${role} ${verb}…`;
    }
    case "tool_started": {
      const actor = sanitizeOneLine(event.actor);
      const tool = sanitizeOneLine(event.tool);
      return actor !== "" ? `${actor} tool ${tool}…` : `tool ${tool}…`;
    }
    case "tool_completed": {
      // A successful call needs no completion row: its start row already said
      // the tool is running. Errors/denials/blocks are worth an explicit line.
      if (event.status === "ok") return null;
      return `tool ${sanitizeOneLine(event.tool)} ${sanitizeOneLine(event.status)}`;
    }
    default:
      return null;
  }
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
  /**
   * Bare `--json` in `--mode print`: print the decision object as JSON on the
   * last stdout line. This is keyed on the FLAG, not on `Config.jsonOut`:
   * `TWO_BROTHERS_JSON` is a whole output mode (the machine object), and an
   * explicit `--mode print` wins over it, so the env var never narrows a print
   * run to the decision object.
   */
  jsonDecision?: boolean;
  /** Terminal style for the human text mode (machine modes always stay plain). */
  style?: CliStyle;
  /**
   * Live-transcript override from `--live`/`--no-live`: `false` never
   * streams live, `true` may stream when stdout is a TTY, `undefined` keeps
   * the default (live on a TTY only). Live is always disabled for machine
   * output modes and for a non-TTY sink, so piped bytes never change.
   */
  live?: boolean;
  /**
   * An extra SIGINT-only cancellation source for this turn (the chat REPL
   * passes its readline interface: while a turn is active readline consumes a
   * terminal Ctrl+C itself, so the process signal would never fire). Removed
   * when the turn settles.
   */
  cancelEmitter?: TurnSignalEmitter;
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
  // Machine modes (json/stream/print) are byte-pure: even with FORCE_COLOR
  // the resolved terminal style is replaced by the identity style here.
  const textStyle = outputMode === "text" ? (options.style ?? plainCliStyle) : plainCliStyle;
  // A command's `mode` applies to this turn only — the shared config object
  // stays untouched for the next REPL turn.
  if (options.mode !== undefined) cfg = { ...cfg, mode: options.mode };
  // One visible stderr warning per run when the operator chose a mode that
  // widens what runs without asking. `ask`/`readonly`/`edits` keep the
  // operator in the loop (or close it) and print nothing.
  const approvalWarning = approvalModeWarning(cfg.approvalMode);
  if (approvalWarning !== null) {
    io.error(paintWarningPrefix(textStyle, `[warn] ${approvalWarning}`));
  }
  // validate before connecting to MCP servers so a misconfigured run fails
  // fast instead of opening stdio connections first
  const endpoints = cliEndpoints(cfg);
  validateRunConfig(cfg, endpoints);
  // Overflow spill is enabled only when a session file is in play: the files
  // live beside it and persist until the operator removes them. Without
  // `--session-file` the historical clipping stays byte-identical.
  const sessionFilePath = context?.store?.path ?? (cfg.sessionFile || "");
  const spillRoot = sessionFilePath
    ? path.join(path.dirname(path.resolve(sessionFilePath)), "spill")
    : undefined;
  // `run --stream`: one NDJSON line per run event, printed as it happens. The
  // human summary and cost line are suppressed below — the terminal `result`
  // event carries usage, and consumers compute cost via `estimateCost`.
  const onStreamEvent =
    outputMode === "stream"
      ? (event: StreamEvent): void => io.log(toNdjsonLine(event))
      : undefined;
  // Live transcript: human text mode on an interactive stdout writes every
  // envelope block and activity line as the harness produces it. A pipe, a
  // sink without a TTY signal, a machine output mode or `--no-live` keep the
  // single final render below, so those bytes are unchanged from the
  // pre-live CLI. `--live` cannot force a pipe to stream live.
  const live =
    outputMode === "text" && options.live !== false && io.isTTY === true
      ? createLiveTranscript(io, {
          style: textStyle,
          verbose: cfg.verbose,
          width: terminalWidth(),
        })
      : null;
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
      io.error(
        paintWarningPrefix(
          textStyle,
          `[warn] plugins: ${exc instanceof Error ? exc.message : String(exc)}`,
        ),
      );
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
        io.error(
          paintWarningPrefix(
            textStyle,
            `[warn] MCP: ${exc instanceof Error ? exc.message : String(exc)}`,
          ),
        );
      }
    }
    const merged = mergeMcpConfig(base, pluginServers);
    for (const line of merged.diagnostics) {
      io.error(paintWarningPrefix(textStyle, `[warn] ${line}`));
    }
    try {
      mcp = await loadMcpTools(merged.config, {
        deferOutputBounds: spillRoot !== undefined,
      });
      toolScopes.shared = mcp.sharedTools;
      toolScopes.senior = mcp.seniorTools;
      toolScopes.junior = mcp.juniorTools;
    } catch (exc) {
      io.error(
        paintWarningPrefix(
          textStyle,
          `[warn] MCP: ${exc instanceof Error ? exc.message : String(exc)}`,
        ),
      );
    }
  }
  // Plugin tools join after the MCP scopes (shared/senior/junior buckets).
  if (bindings !== null) toolScopes = mergePluginScopes(toolScopes, bindings);
  // Work mode without any belt is the one configuration where the CLI cannot
  // deliver on the mode's promise: there is no workspace option on this path,
  // so the junior has no filesystem access. Warn once, before the run starts,
  // on stderr only — stdout/exit codes stay exactly as they are.
  const workWarning = workModeWithoutToolsWarning(cfg.mode, toolScopes);
  if (workWarning !== null) {
    io.error(paintWarningPrefix(textStyle, `[warn] ${workWarning}`));
  }
  // One AbortController per turn. The signal handlers below exist only while
  // this turn is active, so an idle REPL keeps its prior Ctrl+C behavior.
  // The first SIGINT/SIGTERM (and SIGHUP on POSIX) aborts cooperatively — the
  // harness forwards the signal to provider calls and tools, and `run_shell`
  // kills+drains its child tree — then the turn is awaited with a budget
  // sized from SHELL_DRAIN_BUDGET_MS, so the process never exits mid-cleanup.
  const controller = new AbortController();
  let cancelTurn: (signal: TurnSignalName) => void = () => {};
  const cancellation = new Promise<TurnSignalName>((resolve) => {
    cancelTurn = resolve;
  });
  const turnSignals = installTurnSignalHandlers({
    ...(options.cancelEmitter ? { sigintEmitters: [options.cancelEmitter] } : {}),
    onCancel: (signal) => {
      controller.abort(signal);
      cancelTurn(signal);
    },
    onForceExit: (code, signal) => {
      io.error(`[two-brothers] ${signal} received again — exiting immediately`);
      process.exit(code);
    },
    onNotice: (line) => io.error(line),
  });
  try {
    const hasScopes = Object.values(toolScopes).some((list) => list !== undefined);
    const compaction = compactionSettingsFromConfig(cfg);
    const providerWarnings = providerWarningSink(io, 3, textStyle);
    const native = nativeProviders(cfg, endpoints, providerWarnings);
    // Advisory repeat guard: default on; `TWO_BROTHERS_REPEAT_GUARD=off`
    // disables it for this invocation (run and every chat REPL turn).
    const repeatToolGuard = repeatToolGuardFromEnv();
    const harness = new TwoBrothersHarness(cfg, {
      signal: controller.signal,
      onProviderWarning: providerWarnings,
      ...(hasScopes ? { toolScopes } : {}),
      ...(endpoints ? { endpoints } : {}),
      ...native,
      ...(compaction ? { compaction } : {}),
      ...(repeatToolGuard !== undefined ? { repeatToolGuard } : {}),
      ...(spillRoot ? { spill: { root: spillRoot } } : {}),
      ...(bindings ? { hooks: bindings.hooks } : {}),
      ...(resources?.skills ? { skills: resources.skills } : {}),
      ...(onStreamEvent ? { onStreamEvent } : {}),
      ...(streamTokens ? { streamTokens: true } : {}),
      // Live TTY projection (null for pipes/machine modes: no hooks attached,
      // so those runs stay exactly as before).
      ...(live !== null
        ? {
            onEnvelope: (message: unknown): void =>
              live.envelope(message as Record<string, any>),
            onEvent: (event: RuntimeEvent): void => {
              const line = activityForEvent(event);
              if (line !== null) live.activity(line);
            },
          }
        : {}),
    });
    const outcome = await waitForTurnOutcome(
      harness.run(task, context),
      cancellation,
      TURN_CANCEL_BUDGET_MS,
    );
    if (turnSignals.cancelledBy !== null) {
      // The operator interrupted this turn. Never claim success and never
      // render the aborted result: machine stdout stays whatever complete
      // records it already has, and the notice (first signal) / this cleanup
      // line (only if teardown misbehaved) go to stderr.
      const signal = turnSignals.cancelledBy;
      if (outcome.status === "timeout") {
        io.error(
          `[two-brothers] ${signal} received — cleanup did not finish within ` +
            `${TURN_CANCEL_BUDGET_MS} ms; no longer waiting for the turn`,
        );
      } else if (outcome.status === "rejected") {
        io.error(
          `[two-brothers] ${signal} received — the turn ended with an error: ` +
            `${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)}`,
        );
      }
      return turnSignalExitCode(signal);
    }
    if (outcome.status === "rejected") throw outcome.error;
    if (outcome.status === "timeout") {
      // Only reachable after a cancellation, handled above.
      throw new Error("turn wait timed out before the run settled");
    }
    const result = outcome.value;
    // connections stay open for the whole run; closed in the finally below
    for (const err of mcp?.errors ?? []) {
      io.error(paintWarningPrefix(textStyle, `[warn] ${err}`));
    }
    for (const warning of result.warnings) {
      io.error(paintWarningPrefix(textStyle, `[warn] ${warning}`));
    }
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
      for (const err of result.errors) {
        io.error(paintWarningPrefix(textStyle, `[warn] ${err}`));
      }
      io.error(usageLine(result.usage ?? {}, textStyle)); // stdout carries decision only
      const cost = costLine(cfg, result.usage ?? {}, textStyle);
      if (cost) io.error(cost);
      if (options.jsonDecision === true) {
        io.log(JSON.stringify(result.decision));
      } else {
        const text =
          typeof result.decision?.decision === "string" ? result.decision.decision : "";
        io.log(text || JSON.stringify(result.decision));
      }
      return failed ? 1 : 0;
    }
    if (live === null) {
      // Piped/non-TTY output (or `--no-live`): the whole finished transcript,
      // exactly as before live output existed.
      io.log(
        renderMessages(
          result.messages as unknown as Array<Record<string, any>>,
          cfg.verbose,
          textStyle,
        ),
      );
    }
    // Live mode already printed every envelope block (and activity rows) as
    // the harness produced them; nothing is re-rendered here.
    if (cfg.verbose) {
      const audits = renderPromptAudits(result.promptAudits, textStyle);
      if (audits) io.log(audits);
    }
    for (const err of result.errors) {
      io.error(paintWarningPrefix(textStyle, `[warn] ${err}`));
    }
    // The compact human footer replaces the print-mode `tokens:`/`cost:`
    // diagnostics lines here; machine modes keep those exact formats and never
    // reach this text-only path.
    const cost = estimateRunCost(cfg, result.usage ?? {});
    const footer = humanFooter(
      result.usage ?? {},
      cost === null ? null : cost.totalCost,
      textStyle,
      terminalWidth(),
    );
    if (footer !== null) {
      // Live mode reserves the footer for the end (exactly once); the piped
      // path keeps its historical blank-line + footer layout.
      if (live !== null) live.foot(footer);
      else {
        io.log("");
        io.log(footer);
      }
    }
    return failed ? 1 : 0;
  } finally {
    // Handlers exist only while this turn is active: remove them before the
    // MCP teardown so a later command (or an embedder) never inherits them.
    turnSignals.dispose();
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
  const file = mcpConfigFromValues(values) ?? "";
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
  if (resolveOutputMode(values, cfg.jsonOut) === "json") {
    io.log(JSON.stringify(plan));
    return 0;
  }
  for (const line of renderDryRunPlan(plan)) io.log(line);
  return 0;
}

async function doRun(
  argv: string[],
  io: CliIO,
  style: CliStyle = plainCliStyle,
): Promise<number> {
  const parsed = parseCommandArgs(
    argv,
    { ...OPTIONS, ...HELP_OPTIONS, ...RUN_INPUT_OPTIONS, ...LIVE_OPTIONS, ...APPROVAL_MODE_OPTIONS, ...THINKING_BUDGET_OPTIONS },
    "run",
    io,
    true,
  );
  if (parsed === null) return 2;
  const { values, positionals } = parsed;
  if (isHelpRequested(values)) {
    io.log(renderCommandHelp("run", style));
    return 0;
  }
  const approvalProblem = approvalModeProblem(values);
  if (approvalProblem !== null) return reportApprovalModeProblem("run", approvalProblem, io);
  const thinkingProblem = thinkingBudgetProblem(values);
  if (thinkingProblem !== null) return reportThinkingBudgetProblem("run", thinkingProblem, io);
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
  const mcpConfig = mcpConfigFromValues(values);
  try {
    const context = openSession(cfg, io);
    const resources = await loadRunResources(cfg, values, io);
    return await runOnce(cfg, resolved.task, io, context, {
      ...(mcpConfig !== undefined ? { mcpConfig } : {}),
      outputMode: resolveOutputMode(values, cfg.jsonOut),
      jsonDecision: values.json === true,
      resources,
      streamTokens,
      style,
      live: liveFlag(values),
    });
  } catch (exc) {
    if (exc instanceof SessionError) {
      io.error(`[error] ${exc.message}`);
      return 1;
    }
    throw exc;
  }
}

// --------------------------------------------------------------------------- //
// chat REPL: first-party base commands (src/basecommands.ts)
// --------------------------------------------------------------------------- //

/**
 * Map one cancelled REPL turn's exit code back to the REPL loop.
 *
 * A turn returns 128+signal only when a signal cancelled it. Interactive
 * Ctrl+C (`SIGINT`) is a *cancel* in a chat session — the turn stops and the
 * prompt comes back, matching the TUI's cancel precedence; a piped/non-TTY
 * REPL is automation, so SIGINT ends it. SIGTERM/SIGHUP are termination
 * requests and end the REPL after the turn unwinds. The ordinary error code 1
 * and success 0 keep the REPL running as before.
 */
function replTurnStop(code: number): number | null {
  if (code < 128) return null;
  if (code === 130 && process.stdin.isTTY === true) return null;
  return code;
}

/**
 * The built-in catalogue as REPL listing lines, grouped prompt then action in
 * `sortBaseCommands` order, using the same `name — description
 * (argument-hint)` shape as discovered templates; aliases are listed too so
 * the Chinese/English spellings are discoverable.
 */
function baseCommandListLines(style: CliStyle = plainCliStyle): string[] {
  const lines: string[] = [];
  const groups = [
    { kind: "prompt" as const, heading: "prompt commands (submit a task this turn):" },
    { kind: "action" as const, heading: "action commands (performed by the REPL):" },
  ];
  const ordered = sortBaseCommands(BASE_COMMANDS);
  for (const group of groups) {
    lines.push(style.paint("strong", group.heading));
    for (const command of ordered) {
      if (command.kind !== group.kind) continue;
      const hint = command.argumentHint === "" ? "" : ` (${command.argumentHint})`;
      const aliases =
        command.aliases.length === 0 ? "" : ` [aliases: ${command.aliases.join(", ")}]`;
      lines.push(
        `  ${style.paint("accent", `/${command.name}`)} — ${command.description}` +
          style.paint("dim", `${hint}${aliases}`),
      );
    }
  }
  return lines;
}

/**
 * Compaction settings for an explicit REPL `/compact`: the configured budgets
 * apply even when no auto trigger is set, because the operator asked for a
 * compaction by name. `compaction.ts` picks the unit (chars unless a token
 * threshold/window is configured) and derives the tail/summary budgets.
 */
function replCompactionSettings(cfg: Config): CompactionSettings {
  return {
    ...(cfg.compactKeepRecent > 0 ? { keepRecentChars: cfg.compactKeepRecent } : {}),
    ...(cfg.compactThreshold > 0 ? { thresholdChars: cfg.compactThreshold } : {}),
    ...(cfg.compactThresholdTokens > 0 ? { thresholdTokens: cfg.compactThresholdTokens } : {}),
    ...(cfg.contextWindow > 0 ? { contextWindow: cfg.contextWindow } : {}),
  };
}

/**
 * The summarizer provider for an explicit REPL `/compact` — built from the
 * same effective per-role endpoint/config the run path uses (the REPL has no
 * harness instance between turns, so the provider is built on demand).
 */
function replSummarizerProvider(
  cfg: Config,
  role: "senior" | "junior",
  io: CliIO,
  style: CliStyle = plainCliStyle,
): Provider {
  const endpoints = cliEndpoints(cfg);
  const endpoint = endpoints?.[role];
  return buildProvider(
    {
      provider: cfg.provider,
      kind: resolveProviderKind(cfg, role),
      baseUrl: endpoint?.baseUrl || cfg.baseUrl,
      apiKey: endpoint?.apiKey || cfg.apiKey,
      seniorModel: cfg.seniorModel,
      juniorModel: cfg.juniorModel,
      model: endpoint?.model || (role === "senior" ? cfg.seniorModel : cfg.juniorModel),
      temperature: cfg.temperature,
      timeout: cfg.timeout,
      retries: cfg.retries,
      contextWindow: cfg.contextWindow,
      maxTokens: maxTokensForRole(cfg, role),
      onWarning: providerWarningSink(io, 3, style),
    },
    role,
  );
}

async function doChat(
  argv: string[],
  io: CliIO,
  style: CliStyle = plainCliStyle,
): Promise<number> {
  const parsed = parseCommandArgs(
    argv,
    { ...OPTIONS, ...HELP_OPTIONS, ...DRY_RUN_OPTIONS, ...LIVE_OPTIONS, ...APPROVAL_MODE_OPTIONS, ...THINKING_BUDGET_OPTIONS },
    "chat",
    io,
  );
  if (parsed === null) return 2;
  const { values } = parsed;
  if (isHelpRequested(values)) {
    io.log(renderCommandHelp("chat", style));
    return 0;
  }
  const approvalProblem = approvalModeProblem(values);
  if (approvalProblem !== null) return reportApprovalModeProblem("chat", approvalProblem, io);
  const thinkingProblem = thinkingBudgetProblem(values);
  if (thinkingProblem !== null) return reportThinkingBudgetProblem("chat", thinkingProblem, io);
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
  // Automation output for every REPL turn: the same resolution `run` uses, so
  // `TWO_BROTHERS_JSON` and the bare `--json` flag select the machine-readable
  // object per turn (explicit --mode print|json / --json-events / --stream win).
  // The REPL banner, resolved-role rows and blank turn separators are stdout
  // decoration, so they are suppressed for machine modes to keep each turn's
  // payload parseable.
  const turnOutputMode = resolveOutputMode(values, cfg.jsonOut);
  const turnJsonDecision = values.json === true;
  const machineOutput = turnOutputMode !== "text";
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
  // `--mcp-config` > `TWO_BROTHERS_MCP_CONFIG`, resolved once per REPL process
  // like the resources above; every turn forwards the same choice.
  const mcpConfig = mcpConfigFromValues(values);
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
  // One line per discovered command: `name — description (argument-hint)`.
  const discoveredCommandList = (): string =>
    commands.commands.length === 0
      ? "  (none discovered: add <name>.md to a commands directory)"
      : commands.commands
          .map(
            (found) =>
              `  ${style.paint("accent", found.name)} — ${found.description}` +
              style.paint("dim", found.argumentHint ? ` (${found.argumentHint})` : ""),
          )
          .join("\n");
  // The `/commands` listing: built-in groups (prompt, then action), then the
  // discovered templates in the long-standing format.
  const commandList = (): string =>
    [
      ...baseCommandListLines(style),
      "",
      style.paint("strong", "discovered commands:"),
      discoveredCommandList(),
    ].join("\n");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  if (!machineOutput) {
    io.log(
      `${style.paint("strong", "Two Brothers REPL.")} Enter a task (empty line or exit to quit). ` +
        `Type ${style.paint("accent", "/help")} for commands.`,
    );
    printResolvedRoles(cfg, io);
  }
  // The REPL's default cooperation mode for following turns. A discovered
  // template's or a built-in prompt command's `mode` overrides it for one turn.
  let replMode: Config["mode"] = cfg.mode;
  // `chat` turns stream live on an interactive stdout exactly like `run`
  // turns; a piped stdin (or `--no-live`) keeps the per-turn finished render.
  const live = liveFlag(values);

  /** `/help`: the REPL commands, then the built-in catalogue, then discovered. */
  const printReplHelp = (): void => {
    io.log(
      `${style.paint("strong", "REPL commands:")}\n` +
        `  ${style.paint("accent", "/commands")}      list built-in and discovered slash commands\n` +
        `  ${style.paint("accent", "/config")}        resolved provider/model/base-url per role\n` +
        `  ${style.paint("accent", "/help")}, ${style.paint("accent", "/h")}      this list\n` +
        `  ${style.paint("accent", "/mode")} [consult|work]  show or set the cooperation mode for following turns\n` +
        `  ${style.paint("accent", "/exit")}, ${style.paint("accent", "/quit")}   leave (empty line, exit, quit, q also work)\n` +
        `${style.paint("strong", "built-in commands:")}\n` +
        baseCommandListLines(style).join("\n") +
        `\n${style.paint("strong", "discovered commands:")}\n` +
        discoveredCommandList() +
        "\nanything else is sent to the brothers as a task",
    );
  };

  /** `/export [path]`: this REPL session as Markdown (`sessions export` renderer). */
  const exportReplSession = (rawArgs: string): void => {
    const requested = rawArgs.trim();
    const stem =
      cfg.sessionFile === "" ? "chat" : path.basename(cfg.sessionFile).replace(/\.jsonl$/, "");
    const target = requested === "" ? `${stem === "" ? "chat" : stem}.md` : requested;
    const doc: SessionSearchDoc = {
      name: cfg.sessionFile === "" ? "chat.jsonl" : path.basename(cfg.sessionFile),
      title: deriveTitle(context.events as unknown as Array<Record<string, any>>, stem),
      events: [...context.events],
      workspace_id: null,
      updated: Math.floor(Date.now() / 1000),
    };
    try {
      fs.writeFileSync(target, sessionToMarkdown(doc), "utf-8");
    } catch (exc) {
      io.error(`export failed: ${exc instanceof Error ? exc.message : String(exc)}`);
      return;
    }
    io.log(`exported: ${path.resolve(target)} (${doc.events.length} envelopes)`);
  };

  /** `/status`: session identity, cooperation mode, context size and roles. */
  const printReplStatus = (): void => {
    const events = context.events;
    const chars = events.reduce((sum, event) => sum + JSON.stringify(event).length, 0);
    const approxTokens = estimateTokens(events.map((event) => JSON.stringify(event)).join("\n"));
    io.log("status:");
    io.log(
      `  session: ${cfg.sessionFile === "" ? "(none; in-memory)" : path.resolve(cfg.sessionFile)}`,
    );
    io.log(`  mode: ${replMode}`);
    io.log(`  context: ${events.length} events, ${chars} chars (~${approxTokens} tokens)`);
    io.log("roles:");
    printResolvedRoles(cfg, io);
  };

  /** `/permission`: the fail-closed policy and what this process can scope. */
  const printReplPermission = (): void => {
    const mcpFile = mcpConfig ?? "";
    const pluginCount = resources.plugins?.plugins.size ?? 0;
    io.log("permission:");
    io.log(
      "  policy: fail-closed — read-only actions are auto-allowed; mutating actions ask the operator, " +
        "and with no approval broker an ask is denied",
    );
    io.log("  broker: none in the line REPL (there is no operator approval channel)");
    io.log(
      "  workspace: none — CLI runs are not workspace-bound, so workspace tools are unavailable",
    );
    io.log(
      `  tool scopes: MCP ${
        mcpFile === "" ? "not configured" : `from MCP config ${path.resolve(mcpFile)}`
      }; plugin tools need a workspace-bound run`,
    );
    io.log(`  plugins: ${pluginCount} discovered (hooks apply; plugin tools are inactive here)`);
  };

  /**
   * `/compact`: summarize older context between turns; persists an open
   * `--session-file` through `compactContext`'s store rewrite. Only the line
   * loop calls this, and it awaits each turn, so a compaction can never run
   * mid-turn or mid-stream.
   */
  const compactReplContext = async (): Promise<void> => {
    const before = context.events.length;
    if (before === 0) {
      io.log("nothing to compact (empty context)");
      return;
    }
    try {
      validateRunConfig(cfg, cliEndpoints(cfg));
      const settings = replCompactionSettings(cfg);
      const provider = replSummarizerProvider(
        cfg,
        settings.summarizerRole ?? "senior",
        io,
        style,
      );
      // `compactContext` rewrites `context.store` (dense seq) when a
      // `--session-file` is open, so `--resume` keeps working — same as a run.
      const changed = await compactContext(context, provider, settings);
      if (!changed) {
        io.log("nothing to compact");
        return;
      }
      const persisted =
        context.store === null || cfg.sessionFile === ""
          ? ""
          : `; rewrote ${path.resolve(cfg.sessionFile)}`;
      io.log(`compacted: ${before} → ${context.events.length} envelopes${persisted}`);
    } catch (exc) {
      io.error(`compact failed: ${exc instanceof Error ? exc.message : String(exc)}`);
    }
  };

  /** Perform one built-in action command locally (never submits a task). */
  const performBaseAction = async (command: BaseCommand, args: string): Promise<void> => {
    switch (command.action) {
      case "compact":
        await compactReplContext();
        return;
      case "export":
        exportReplSession(args);
        return;
      case "status":
        printReplStatus();
        return;
      case "permission":
        printReplPermission();
        return;
      case "mode": {
        const next = args.trim().toLowerCase();
        if (next === "") {
          io.log(`mode: ${replMode}`);
          return;
        }
        if (next !== "consult" && next !== "work") {
          io.error("usage: /mode [consult|work]");
          return;
        }
        replMode = next;
        io.log(`mode: ${replMode}`);
        return;
      }
      case "help":
        printReplHelp();
        return;
      case "new":
        io.log(
          "new: the line REPL cannot start a fresh session in place; " +
            "exit (/exit or Ctrl+D) and start a new `two-brothers chat` " +
            "(serve/web can open new sessions).",
        );
        return;
      default:
        io.error(`base command /${command.name}: no REPL action configured`);
        return;
    }
  };

  // `for await` over the interface (not question-per-loop): lines that arrive
  // while a run is in progress stay buffered, so piped scripts can script the
  // REPL; question() would drop them. The prompt is only displayed on an
  // interactive terminal — echoed onto a piped transcript it would glue the
  // first output line onto the prompt line.
  // The prompt is only displayed on an interactive terminal and never in a
  // machine output mode: on a TTY, readline echoes the prompt on stdout, which
  // would interleave with the per-turn JSON/NDJSON payload.
  const showPrompt = process.stdin.isTTY === true && !machineOutput;
  rl.setPrompt("task> ");
  if (showPrompt) rl.prompt();
  // eslint-disable-next-line no-constant-condition
  for await (const line of rl) {
    const trimmed = line.trim();
    const command = trimmed.toLowerCase();
    if (!trimmed || ["exit", "quit", "q", "/exit", "/quit"].includes(command)) {
      rl.close();
      return 0;
    }
    if (command === "/help" || command === "/h") {
      printReplHelp();
      if (showPrompt) rl.prompt();
      continue;
    }
    if (command === "/commands") {
      io.log(`${style.paint("strong", "commands:")}\n${commandList()}`);
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
    // A discovered `<name>.md` keeps priority over a same-named base command;
    // base prompt commands expand and run, base action commands are performed
    // locally (they are never submitted as tasks).
    const matched = matchCommand(trimmed);
    if (matched !== null) {
      const discovered = commands.commands.find((cmd) => cmd.name === matched.name);
      if (discovered !== undefined) {
        const turnCode = await runOnce(cfg, expandCommand(discovered, matched.args), io, context, {
          ...(mcpConfig !== undefined ? { mcpConfig } : {}),
          outputMode: turnOutputMode,
          jsonDecision: turnJsonDecision,
          resources,
          style,
          live,
          cancelEmitter: rl,
          ...(discovered.mode ? { mode: discovered.mode } : {}),
        });
        const stop = replTurnStop(turnCode);
        if (stop !== null) return stop;
        if (!machineOutput) io.log("");
      } else {
        const base = findBaseCommand(matched.name);
        if (base === undefined) {
          io.error(
            `unknown command: ${matched.name} (type /commands to list available commands)`,
          );
        } else if (base.kind === "prompt") {
          let task: string | null = null;
          try {
            task = expandBaseCommand(base, matched.args);
          } catch (exc) {
            if (exc instanceof RangeError) {
              // Missing required arguments: print the usage line and submit
              // nothing (the REPL continues with the next line).
              io.error(`usage: ${baseCommandUsage(base)}`);
            } else {
              io.error(`[error] ${exc instanceof Error ? exc.message : String(exc)}`);
            }
          }
          if (task !== null) {
            const turnCode = await runOnce(cfg, task, io, context, {
              ...(mcpConfig !== undefined ? { mcpConfig } : {}),
              outputMode: turnOutputMode,
              jsonDecision: turnJsonDecision,
              resources,
              style,
              live,
              cancelEmitter: rl,
              ...(base.mode ? { mode: base.mode } : {}),
            });
            const stop = replTurnStop(turnCode);
            if (stop !== null) return stop;
            if (!machineOutput) io.log("");
          }
        } else {
          await performBaseAction(base, matched.args);
        }
      }
      if (showPrompt) rl.prompt();
      continue;
    }
    const turnCode = await runOnce(cfg, trimmed, io, context, {
      ...(mcpConfig !== undefined ? { mcpConfig } : {}),
      outputMode: turnOutputMode,
      jsonDecision: turnJsonDecision,
      resources,
      style,
      live,
      cancelEmitter: rl,
      mode: replMode,
    });
    const stop = replTurnStop(turnCode);
    if (stop !== null) return stop;
    if (!machineOutput) io.log("");
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
 * that powers the in-app Ctrl+P palette and `?` overlay (with any keys-file
 * overrides already resolved). */
function commandHelpFor(
  command: string,
  style: CliStyle = plainCliStyle,
  commands: readonly TuiCommand[] = TUI_COMMANDS,
): string {
  const text = renderCommandHelp(command, style);
  if (command !== "tui") return text;
  // tuiHelpLines() already starts with its own "Keys:" heading.
  return `${text}\n\n${tuiHelpLines(commands).join("\n")}`;
}

/** `tui --help`: the clihelp spec plus the generated key guide. */
function printTuiHelp(
  io: CliIO,
  style: CliStyle = plainCliStyle,
  commands: readonly TuiCommand[] = TUI_COMMANDS,
): void {
  io.log(commandHelpFor("tui", style, commands));
}

async function doTui(
  argv: string[],
  io: CliIO,
  style: CliStyle = plainCliStyle,
): Promise<number> {
  const parsed = parseCommandArgs(
    argv,
    { ...OPTIONS, ...TUI_OPTIONS, ...APPROVAL_MODE_OPTIONS, ...THINKING_BUDGET_OPTIONS, ...HELP_OPTIONS },
    "tui",
    io,
    true,
  );
  if (parsed === null) return 2;
  const { values, positionals } = parsed;
  // The keys file is read once at startup: the same resolved table drives
  // `--help`, matching, labels, the palette/help listings and the status hints.
  // An unreadable/invalid file prints one honest line and keeps the defaults.
  // `--keys-watch`/TWO_BROTHERS_TUI_KEYS_WATCH then keeps watching the captured
  // path and applies valid edits through the same validated reload path.
  const keyResolution = resolveTuiKeyCommandsForCli(values);
  if (keyResolution.diagnostics.length > 0) {
    io.error(`[tui keys] ${keyResolution.diagnostics.join("; ")}`);
  }
  if (isHelpRequested(values)) {
    printTuiHelp(io, style, keyResolution.commands);
    return 0;
  }
  const approvalProblem = approvalModeProblem(values);
  if (approvalProblem !== null) return reportApprovalModeProblem("tui", approvalProblem, io);
  const thinkingProblem = thinkingBudgetProblem(values);
  if (thinkingProblem !== null) return reportThinkingBudgetProblem("tui", thinkingProblem, io);
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
  const workspace = typeof values.workspace === "string" ? values.workspace.trim() : "";
  // A `--approval-mode`/env value pins the policy for THIS TUI process only
  // (never persisted): without one the saved `approval_policy` setting is read
  // per turn and `/permission` writes it. The pin is reported honestly in the
  // `/permission` dialog, and `allow-all` gets the same visible warning the CLI
  // run path prints.
  const rawApprovalMode =
    (typeof values["approval-mode"] === "string" && values["approval-mode"].trim()) ||
    (process.env.TWO_BROTHERS_APPROVAL_MODE ?? "").trim();
  const pinnedApprovalMode = rawApprovalMode
    ? (normalizeApprovalMode(rawApprovalMode) ?? undefined)
    : undefined;
  if (pinnedApprovalMode !== undefined) {
    const warning = approvalModeWarning(pinnedApprovalMode);
    if (warning !== null) io.error(paintWarningPrefix(style, `[warn] ${warning}`));
  }
  // `--mcp-config` > `TWO_BROTHERS_MCP_CONFIG`, pinned for this TUI process only.
  const mcpConfig = mcpConfigFromValues(values);
  return runTuiApp({
    cfg,
    io,
    commands: keyResolution.commands,
    keysSource: { path: keyResolution.file.path, origin: keyResolution.file.origin },
    keysState: keyResolution.state,
    keysDiagnostics: keyResolution.diagnostics,
    ...(tuiKeysWatchForCli(values) ? { keysWatch: true } : {}),
    pluginsDir: pluginsDirForCli(values),
    skillsRoots: skillsRootsForCli(values),
    commandsRoots: commandsRootsForCli(values),
    ...(workspace !== "" ? { workspaceRoot: workspace } : {}),
    ...(pinnedApprovalMode !== undefined ? { approvalMode: pinnedApprovalMode } : {}),
    ...(mcpConfig !== undefined ? { mcpConfig } : {}),
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
  const layout = new SessionLayout(sessionsDir);
  return layout.list().map((location) => {
    const scan = scanSessionFile(location.sessionPath, location.name);
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
  at: { type: "string" as const },
  name: { type: "string" as const },
  turns: { type: "string" as const },
  run: { type: "string" as const },
  apply: { type: "boolean" as const, default: false },
  discard: { type: "boolean" as const, default: false },
  "dry-run": { type: "boolean" as const, default: false },
  force: { type: "boolean" as const, default: false },
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

/** A resolved session: its public name plus the on-disk envelope path. */
interface ResolvedSessionEntry {
  name: string;
  path: string;
}

/** Public name for an explicit path: directory sessions keep their stem. */
function sessionNameForPath(sessionsDir: string, filePath: string): string {
  const root = path.resolve(sessionsDir);
  const resolved = path.resolve(filePath);
  const relative = path.relative(root, resolved);
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    const parts = relative.split(/[\\/]/).filter(Boolean);
    if (parts.length === 3 && parts[2] === "session.jsonl") {
      return `${parts[1]}.jsonl`;
    }
  }
  return path.basename(resolved);
}

/** Resolve a session name or path to its public name and envelope path. */
function resolveSessionEntry(
  sessionsDir: string,
  requested: string,
): ResolvedSessionEntry | null {
  const name = requested.trim();
  if (!name) return null;
  // Explicit paths keep their historical resolution (they may point outside
  // the sessions root); bare names resolve through either layout.
  if (!/[\\/]/.test(name) && !path.isAbsolute(name)) {
    const resolved = new SessionLayout(sessionsDir).resolve(name);
    if (resolved !== null) return { name: resolved.name, path: resolved.sessionPath };
  }
  const candidates = name.endsWith(".jsonl") ? [name] : [`${name}.jsonl`, name];
  for (const candidate of candidates) {
    const resolved = path.resolve(sessionsDir, candidate);
    try {
      if (fs.statSync(resolved).isFile()) {
        return { name: sessionNameForPath(sessionsDir, resolved), path: resolved };
      }
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
  const entry = resolveSessionEntry(sessionsDir, requested);
  if (entry === null) {
    io.error(`Unknown session: ${requested} (in ${path.resolve(sessionsDir)})`);
    io.error("Run 'two-brothers sessions' for the session list.");
    return 2;
  }
  const filePath = entry.path;
  const scan = scanSessionFile(filePath, entry.name);
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
function exportDocForCli(
  sessionsDir: string,
  filePath: string,
  sessionName?: string,
): SessionSearchDoc | null {
  const name = sessionName ?? path.basename(filePath);
  const scan = scanSessionFile(filePath, name);
  if (scan.title === "(unreadable)") return null;
  const stem = name.replace(/\.jsonl$/, "");
  const meta = new SessionMetadataStore(
    sessionsDir,
    new SessionLayout(sessionsDir),
  ).get(name);
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
 * `sessions export <name> [--format markdown|json|html] [--output <path>]`:
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
      "no session name: sessions export <name> [--format markdown|json|html] [--output <path>]",
      io,
    );
  }
  if (args.length > 1) {
    return sessionsUsageError(`unexpected argument: ${args.slice(1).join(" ")}`, io);
  }
  const format = (typeof formatRaw === "string" ? formatRaw : "markdown").trim().toLowerCase();
  if (format !== "markdown" && format !== "json" && format !== "html") {
    return sessionsUsageError(`unknown export format: ${format} (use markdown, json or html)`, io);
  }
  const requested = args[0];
  const entry = resolveSessionEntry(sessionsDir, requested);
  if (entry === null) {
    io.error(`[error] session not found: ${requested} (in ${path.resolve(sessionsDir)})`);
    return 1;
  }
  const filePath = entry.path;
  const doc = exportDocForCli(sessionsDir, filePath, entry.name);
  if (doc === null) {
    io.error(`[error] cannot read session file: ${filePath}`);
    return 1;
  }
  const body =
    format === "markdown"
      ? sessionToMarkdown(doc)
      : format === "json"
        ? sessionToJsonString(doc)
        : sessionToHtmlString(doc);
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

/**
 * `sessions fork <name> [--at <seq>] [--name <new>]`: copy a session (or its
 * first `--at` envelopes) into a NEW session file and print the new name.
 * `--json` prints the fork result object instead of the human line. A missing
 * source, an out-of-range `--at`, an invalid/taken `--name` or a write
 * failure is a runtime error (exit 1); a non-numeric `--at`, a missing/extra
 * name or an unknown flag is a usage error (exit 2).
 */
function forkSessionCommand(
  sessionsDir: string,
  args: string[],
  atRaw: unknown,
  nameRaw: unknown,
  jsonMode: boolean,
  io: CliIO,
): number {
  if (args.length === 0) {
    return sessionsUsageError(
      "no session name: sessions fork <name> [--at <seq>] [--name <new>]",
      io,
    );
  }
  if (args.length > 1) {
    return sessionsUsageError(`unexpected argument: ${args.slice(1).join(" ")}`, io);
  }
  const atText = typeof atRaw === "string" ? atRaw.trim() : "";
  let atSeq: number | undefined;
  if (atText !== "") {
    if (!/^[1-9]\d*$/.test(atText)) {
      io.error(`[error] invalid --at: ${String(atRaw)} (use a positive integer envelope seq)`);
      return 2;
    }
    atSeq = Number.parseInt(atText, 10);
  }
  const requested = args[0];
  const entry = resolveSessionEntry(sessionsDir, requested);
  if (entry === null) {
    io.error(`[error] session not found: ${requested} (in ${path.resolve(sessionsDir)})`);
    return 1;
  }
  const sourceName = entry.name;
  let result;
  try {
    result = forkSession(sessionsDir, sourceName, {
      ...(atSeq === undefined ? {} : { atSeq }),
      ...(nameRaw === undefined ? {} : { name: String(nameRaw) }),
    });
  } catch (exc) {
    if (exc instanceof SessionForkError) {
      io.error(`[error] ${exc.message}`);
      return 1;
    }
    throw exc;
  }
  if (jsonMode) {
    io.log(JSON.stringify(result));
    return 0;
  }
  io.log(
    `forked ${result.name} from ${result.forked_from.name} at seq ${result.forked_from.seq} ` +
      `(${result.events} envelope(s); title: ${result.title})`,
  );
  return 0;
}

/**
 * `sessions rewind <name> --turns <n>`: drop the last n operator turns from
 * one persisted session and print what actually happened (the pure helper's
 * honest cut reason). `--turns` is a strict integer 1..100: a bad value is a
 * usage error (exit 2); a missing/corrupt session exits 1. A cut that removes
 * nothing is a success with an honest reason, never a fake error.
 */
function rewindSessionCommand(
  sessionsDir: string,
  args: string[],
  turnsRaw: unknown,
  jsonMode: boolean,
  io: CliIO,
): number {
  if (args.length === 0) {
    return sessionsUsageError("no session name: sessions rewind <name> --turns <n>", io);
  }
  if (args.length > 1) {
    return sessionsUsageError(`unexpected argument: ${args.slice(1).join(" ")}`, io);
  }
  if (turnsRaw === undefined) {
    return sessionsUsageError("missing --turns: sessions rewind <name> --turns <1-100>", io);
  }
  const text = String(turnsRaw).trim();
  const parsed = validateRewindTurns(/^\d+$/.test(text) ? Number.parseInt(text, 10) : Number.NaN);
  if (!parsed.ok) {
    io.error(`[error] ${parsed.error}`);
    return 2;
  }
  const requested = args[0];
  const entry = resolveSessionEntry(sessionsDir, requested);
  if (entry === null) {
    io.error(`[error] session not found: ${requested} (in ${path.resolve(sessionsDir)})`);
    return 1;
  }
  const filePath = entry.path;
  const name = entry.name;
  let result;
  try {
    result = rewindSession(new SessionStore(filePath), parsed.turns);
  } catch (exc) {
    io.error(`[error] ${exc instanceof Error ? exc.message : String(exc)}`);
    return 1;
  }
  const cut = result.cut;
  // Same operator action as the HTTP route: rewriting the transcript clears the
  // session's runtime-event sidecar (tool/approval history of the removed runs
  // is gone; the kept transcript remains). A clear failure is disclosed.
  let runtimeEventsCleared = false;
  let runtimeEventsClearError: string | null = null;
  if (result.rewritten) {
    try {
      runtimeEventsCleared = new RuntimeEventStore(
        path.join(sessionsDir, "runtime"),
        new SessionLayout(sessionsDir),
      ).delete(name);
    } catch (exc) {
      runtimeEventsClearError = exc instanceof Error ? exc.message : String(exc);
    }
  }
  if (jsonMode) {
    io.log(
      JSON.stringify({
        name,
        rewritten: result.rewritten,
        kept: cut.keptCount,
        removed: cut.removedCount,
        turns: cut.turns,
        requested_turns: cut.requestedTurns,
        stopped_at_compaction: cut.stoppedAtCompaction,
        stops_before: cut.stopsBefore,
        reason: cut.reason,
        runtime_events_cleared: runtimeEventsCleared,
        ...(runtimeEventsClearError === null
          ? {}
          : { runtime_events_clear_error: runtimeEventsClearError }),
      }),
    );
    return 0;
  }
  const sidecarNote =
    runtimeEventsClearError !== null
      ? `; could not clear the tool/approval history sidecar: ${runtimeEventsClearError}`
      : runtimeEventsCleared
        ? "; cleared the tool/approval history sidecar (the transcript is kept)"
        : "";
  io.log(
    result.rewritten
      ? `rewound ${name}: ${cut.reason}${sidecarNote}`
      : `nothing to rewind in ${name}: ${cut.reason}`,
  );
  return 0;
}

/**
 * `sessions undo <name> [--run <id>] [--apply] [--discard] [--json]`: preview,
 * apply or discard one run's captured file mutations through the shared
 * workspace-history store (`src/workspacehistory.ts`, `<sessions>/undo`) and
 * the session's linked workspace (`*.meta.json` -> `workspaces.json`). The
 * server is not required: the store and the workspace link are both persisted.
 * Default is a read-only preview. Exit codes: 1 for an unknown session/record
 * (or an unreadable/unusable record and per-file apply failures), 2 for a
 * usage error.
 */
function undoSessionCommand(
  sessionsDir: string,
  args: string[],
  runRaw: unknown,
  applyMode: boolean,
  discardMode: boolean,
  jsonMode: boolean,
  io: CliIO,
): number {
  const usage =
    "no session name: sessions undo <name> [--run <id>] [--apply] [--discard] [--json]";
  if (args.length === 0) return sessionsUsageError(usage, io);
  if (args.length > 1) return sessionsUsageError(`unexpected argument: ${args.slice(1).join(" ")}`, io);
  if (applyMode && discardMode) {
    return sessionsUsageError("--apply and --discard are mutually exclusive", io);
  }
  const requested = args[0];
  const entry = resolveSessionEntry(sessionsDir, requested);
  if (entry === null) {
    io.error(`[error] session not found: ${requested} (in ${path.resolve(sessionsDir)})`);
    return 1;
  }
  const name = entry.name;
  const store = path.join(sessionsDir, "undo");

  let runId: string;
  if (typeof runRaw === "string" && runRaw.trim() !== "") {
    runId = runRaw.trim();
    let record: WorkspaceUndoRecord;
    try {
      record = loadUndoRecord(store, runId);
    } catch (exc) {
      return undoCliError(exc, io);
    }
    if (record.session !== undefined && record.session !== name) {
      io.error(`[error] no undo record for run ${runId} in ${name}`);
      return 1;
    }
  } else {
    const newest = listUndoRecords(store).find((entry) => entry.session === name);
    if (newest === undefined) {
      io.error(`[error] no undo record for ${name} (in ${path.resolve(store)})`);
      return 1;
    }
    runId = newest.run_id;
  }

  if (discardMode) {
    // Discard only deletes the record and unreferenced blobs: it does not need
    // a workspace link, so cleanup still works after the workspace is gone.
    let discarded = false;
    try {
      discarded = discardUndo(store, runId);
    } catch (exc) {
      return undoCliError(exc, io);
    }
    if (!discarded) {
      io.error(`[error] no undo record for run ${runId}`);
      return 1;
    }
    const gc = collectOrphanBlobs(store);
    if (jsonMode) {
      io.log(
        JSON.stringify({
          discarded: true,
          session: name,
          run_id: runId,
          ...(gc.removed.length > 0 ? { blobs_removed: gc.removed.length } : {}),
          ...(gc.diagnostics.length > 0 ? { gc_diagnostics: gc.diagnostics } : {}),
        }),
      );
      return 0;
    }
    io.log(
      `discarded the undo record for ${name} (run ${runId}); ` +
        `removed ${gc.removed.length} unreferenced blob(s)`,
    );
    if (gc.skipped !== undefined) io.error(`[warning] blob collection skipped: ${gc.skipped}`);
    return 0;
  }

  // The session's workspace link is the authority (same rule the HTTP route
  // applies through the live registry); a session without a link or a record
  // from another workspace is refused instead of restoring into a guess.
  const meta = new SessionMetadataStore(
    sessionsDir,
    new SessionLayout(sessionsDir),
  ).get(name);
  const workspaceId =
    meta !== null && typeof meta.workspace_id === "string" ? meta.workspace_id.trim() : "";
  const linked =
    workspaceId === ""
      ? null
      : new WorkspaceRegistry(path.join(sessionsDir, "workspaces.json")).get(workspaceId);
  if (linked === null) {
    io.error(
      workspaceId === ""
        ? `[error] session ${name} has no linked workspace; undo needs a workspace-bound run`
        : `[error] session ${name} links to an unregistered workspace (${workspaceId})`,
    );
    return 1;
  }
  const workspaceRoot = linked.path;

  if (applyMode) {
    let result;
    try {
      result = applyUndo(store, runId, workspaceRoot);
    } catch (exc) {
      return undoCliError(exc, io);
    }
    const statusCount = (status: string): number =>
      result.entries.filter((entry) => entry.preview_status === status).length;
    const counts = {
      applicable: statusCount("applicable"),
      created: statusCount("created"),
      deleted: statusCount("deleted"),
      changed_since: statusCount("changed-since"),
      skipped: statusCount("skipped"),
      missing: statusCount("missing"),
      total: result.entries.length,
    };
    if (jsonMode) {
      io.log(
        JSON.stringify({
          session: name,
          run_id: runId,
          workspace_root: result.workspace_root,
          applied: result.applied,
          refused: result.refused,
          failed: result.failed,
          files: result.entries,
          counts,
          ...(result.omitted !== undefined ? { omitted: result.omitted } : {}),
        }),
      );
    } else {
      io.log(
        `applied ${result.applied}, refused ${result.refused}, failed ${result.failed} ` +
          `in ${name} (run ${runId})`,
      );
      for (const entry of result.entries) {
        const note = entry.reason !== undefined ? ` — ${entry.reason}` : "";
        io.log(`  ${entry.status.padEnd(8)} ${entry.action.padEnd(6)} ${entry.path}${note}`);
      }
      if (result.omitted !== undefined) {
        io.log(`  ${result.omitted.entries} more mutation(s) were not captured (${result.omitted.reason})`);
      }
    }
    return result.failed > 0 ? 1 : 0;
  }

  let preview;
  try {
    preview = previewUndo(store, runId, workspaceRoot);
  } catch (exc) {
    return undoCliError(exc, io);
  }
  if (jsonMode) {
    io.log(
      JSON.stringify({
        session: name,
        run_id: runId,
        workspace_root: preview.workspace_root,
        created_at: preview.created_at,
        statuses: preview.entries,
        counts: preview.counts,
        ...(preview.omitted !== undefined ? { omitted: preview.omitted } : {}),
      }),
    );
    return 0;
  }
  io.log(`session: ${name}`);
  io.log(`run: ${runId}`);
  io.log(`workspace: ${preview.workspace_root}`);
  io.log(`created: ${preview.created_at || "(unknown)"}`);
  io.log(
    `${preview.counts.total} file(s): ${preview.counts.applicable} applicable, ` +
      `${preview.counts.created} created, ${preview.counts.deleted} deleted, ` +
      `${preview.counts.changed_since} changed-since, ${preview.counts.skipped} skipped, ` +
      `${preview.counts.missing} missing`,
  );
  for (const entry of preview.entries) {
    const note = entry.reason !== undefined ? ` — ${entry.reason}` : "";
    io.log(`  ${entry.status.padEnd(12)} ${entry.action.padEnd(6)} ${entry.path}${note}`);
  }
  if (preview.omitted !== undefined) {
    io.log(`${preview.omitted.entries} more mutation(s) were not captured (${preview.omitted.reason})`);
  }
  io.log("preview only; pass --apply to restore these files or --discard to drop the record");
  return 0;
}

/** Map a workspace-undo store error to the CLI's honest exit code + one line. */
function undoCliError(exc: unknown, io: CliIO): number {
  if (exc instanceof WorkspaceUndoError) {
    io.error(`[error] ${exc.message}`);
    return exc.code === "invalid_run_id" ? 2 : 1;
  }
  io.error(`[error] ${exc instanceof Error ? exc.message : String(exc)}`);
  return 1;
}

/** `sessions migrate`: move flat sessions into project/session directories. */
function migrateSessionsCommand(
  sessionsDir: string,
  jsonMode: boolean,
  dryRun: boolean,
  force: boolean,
  io: CliIO,
): number {
  let result;
  const missingWorkspaces = new Set<string>();
  try {
    const registry = new WorkspaceRegistry(path.join(sessionsDir, "workspaces.json"));
    result = migrateFlatSessions(sessionsDir, {
      dryRun,
      force,
      workspacePathFor: (id) => {
        const workspacePath = registry.get(id)?.path ?? null;
        if (workspacePath === null) missingWorkspaces.add(id);
        return workspacePath;
      },
    });
  } catch (exc) {
    io.error(`[error] ${exc instanceof Error ? exc.message : String(exc)}`);
    return 1;
  }
  if (missingWorkspaces.size > 0) {
    io.error(
      `[warning] workspace registry did not resolve: ${[...missingWorkspaces].sort().join(", ")} ` +
        "(affected sessions were grouped under _global)",
    );
  }
  if (jsonMode) {
    io.log(JSON.stringify(result, null, 2));
  } else {
    if (result.entries.length === 0) io.log(`no flat sessions in ${sessionsDir}`);
    for (const entry of result.entries) {
      if (entry.status === "migrated") {
        io.log(
          `${dryRun ? "would migrate" : "migrated"} ${entry.name} -> ${entry.targetPath}`,
        );
      } else if (entry.status === "already") {
        io.log(`already migrated ${entry.name}`);
      } else {
        io.error(
          `[error] ${entry.name}: ${entry.status}` +
            (entry.detail ? `: ${entry.detail}` : ""),
        );
      }
    }
    io.log(`layout: ${result.layout}${dryRun ? " (dry run; nothing written)" : ""}`);
  }
  return result.entries.some(
    (entry) => entry.status === "conflict" || entry.status === "error",
  )
    ? 1
    : 0;
}

function doSessions(
  argv: string[],
  io: CliIO,
  style: CliStyle = plainCliStyle,
): number {
  const parsed = parseCommandArgs(argv, SESSIONS_OPTIONS, "sessions", io, true);
  if (parsed === null) return 2;
  const { values, positionals } = parsed;
  if (isHelpRequested(values)) {
    io.log(renderCommandHelp("sessions", style));
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
  if (subcommand === "fork") {
    return forkSessionCommand(
      sessionsDir,
      positionals.slice(1),
      values.at,
      values.name,
      jsonMode,
      io,
    );
  }
  if (subcommand === "rewind") {
    return rewindSessionCommand(sessionsDir, positionals.slice(1), values.turns, jsonMode, io);
  }
  if (subcommand === "undo") {
    return undoSessionCommand(
      sessionsDir,
      positionals.slice(1),
      values.run,
      values.apply === true,
      values.discard === true,
      jsonMode,
      io,
    );
  }
  if (subcommand === "migrate") {
    return migrateSessionsCommand(
      sessionsDir,
      jsonMode,
      values["dry-run"] === true,
      values.force === true,
      io,
    );
  }
  // Kept as a thrown argument error (the long-standing contract for extra
  // positionals, covered by tests/cli.test.ts).
  throw new Error(
    `unexpected argument '${subcommand}' (sessions takes 'list', 'show', 'search', 'export', 'fork', 'rewind', 'undo' or 'migrate')`,
  );
}

// --------------------------------------------------------------------------- //
// spill: inspect and prune spilled tool-output files
// --------------------------------------------------------------------------- //

const SPILL_OPTIONS = {
  "sessions-dir": { type: "string" as const },
  "older-than": { type: "string" as const },
  "dry-run": { type: "boolean" as const, default: false },
  force: { type: "boolean" as const, default: false },
  json: { type: "boolean" as const, default: false },
  ...HELP_OPTIONS,
} satisfies ParseArgsOptionsConfig;

/** One parsed `--older-than` value: the millisecond age and its display form. */
type SpillDuration = { ok: true; ms: number; label: string } | { ok: false; error: string };

const SPILL_DURATION_UNITS: Record<string, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * Parse the strict `spill gc --older-than` syntax: a positive integer plus one
 * lowercase unit (`m` minutes, `h` hours, `d` days). Anything else is a usage
 * error at the call site; there is no implicit/default age.
 */
function parseSpillDuration(raw: unknown): SpillDuration {
  const text = typeof raw === "string" ? raw.trim() : "";
  const match = /^([1-9]\d*)([mhd])$/.exec(text);
  if (match === null) {
    return {
      ok: false,
      error:
        `invalid --older-than: ${String(raw)} ` +
        "(use a positive integer with m, h or d, e.g. 30m, 24h, 7d)",
    };
  }
  const amount = Number.parseInt(match[1], 10);
  const unit = match[2];
  const ms = amount * SPILL_DURATION_UNITS[unit];
  if (!Number.isSafeInteger(ms) || ms <= 0) {
    return { ok: false, error: `invalid --older-than: ${text} (duration is too large)` };
  }
  return { ok: true, ms, label: `${amount}${unit}` };
}

/** Shared `spill` subcommand usage diagnostic: exit 2. */
function spillUsageError(message: string, io: CliIO): number {
  io.error(`[error] ${message}`);
  io.error(`Usage: ${commandUsage("spill")}`);
  io.error("Run 'two-brothers spill --help'.");
  return 2;
}

/** The spill root shared with serve/TUI: `<sessions-dir>/spill`. */
function spillRootFor(sessionsDir: string): string {
  return path.join(sessionsDir, "spill");
}

/**
 * `spill stats [--sessions-dir <dir>] [--json]`: read-only aggregate of the
 * valid spill artifacts. A missing root is an empty store (exit 0); an
 * existing root that is a symlink/junction or not a real directory is refused
 * (exit 1) instead of being followed.
 */
function spillStatsCommand(sessionsDir: string, jsonMode: boolean, io: CliIO): number {
  const root = spillRootFor(sessionsDir);
  const absoluteRoot = path.resolve(root);
  let stats: SpillStats;
  try {
    stats = new SpillStore(root).stats();
  } catch (exc) {
    io.error(`[error] spill stats refused: ${exc instanceof Error ? exc.message : String(exc)}`);
    return 1;
  }
  if (jsonMode) {
    io.log(JSON.stringify({ root: absoluteRoot, files: stats.files, bytes: stats.bytes }));
    return 0;
  }
  if (stats.files === 0) {
    io.log(`no spill files in ${absoluteRoot}`);
    return 0;
  }
  io.log(`${stats.files} spill file(s), ${stats.bytes} bytes in ${absoluteRoot}`);
  return 0;
}

/** Print the honest count line shared by the dry run and the real pass. */
function spillPruneSummary(
  result: SpillPruneResult,
  label: string,
  root: string,
): string {
  if (result.filesBefore === 0) {
    return `no spill files older than ${label} in ${root}`;
  }
  const verb = result.dryRun ? "would remove" : "removed";
  const keptVerb = result.dryRun ? "would be kept" : "kept";
  const failure =
    result.failed > 0 ? `; ${result.failed} could not be removed` : "";
  const temps =
    result.tempsRemoved > 0
      ? `; ${result.tempsRemoved} stale temp file(s) removed (${result.tempBytes} bytes)`
      : "";
  return (
    `${verb} ${result.removed} of ${result.filesBefore} spill file(s) older than ` +
    `${label} (${result.bytes} bytes); ${result.kept} ${keptVerb}${failure}${temps}`
  );
}

/**
 * `spill gc --older-than <n>m|h|d [--dry-run] [--json] [--force]`: prune valid
 * artifacts by mtime. The pass holds the sessions-store single-writer lock
 * unless `--force`, so it refuses while serve/TUI is writing; a missing
 * sessions directory is an empty store (nothing is created).
 */
function spillGcCommand(
  sessionsDir: string,
  duration: Extract<SpillDuration, { ok: true }>,
  dryRun: boolean,
  force: boolean,
  jsonMode: boolean,
  io: CliIO,
): number {
  const root = spillRootFor(sessionsDir);
  const absoluteRoot = path.resolve(root);
  // A missing store has nothing to prune; do not create it just to take a lock.
  if (!fs.existsSync(path.resolve(sessionsDir))) {
    const empty: SpillPruneResult = {
      removed: 0,
      kept: 0,
      bytes: 0,
      failed: 0,
      filesBefore: 0,
      filesAfter: 0,
      tempsRemoved: 0,
      tempBytes: 0,
      dryRun,
      errors: [],
    };
    if (jsonMode) {
      io.log(
        JSON.stringify({
          root: absoluteRoot,
          older_than_ms: duration.ms,
          older_than: duration.label,
          dry_run: dryRun,
          removed: 0,
          kept: 0,
          bytes: 0,
          failed: 0,
          files_before: 0,
          files_after: 0,
          temps_removed: 0,
          temp_bytes: 0,
          errors: [],
        }),
      );
      return 0;
    }
    io.log(spillPruneSummary(empty, duration.label, absoluteRoot));
    return 0;
  }

  let release: (() => void) | null = null;
  if (!force) {
    try {
      release = new SessionLayout(sessionsDir).acquireWriterLock("spill gc");
    } catch (exc) {
      if (exc instanceof SessionLayoutLockedError) {
        const holder = exc.holder;
        io.error(
          `[error] spill gc refused: ${holder === null ? "the sessions directory is locked by an unknown writer" : `the sessions directory is in use by ${holder.owner} (pid ${holder.pid})`}`,
        );
        io.error(
          "Stop that writer (serve/TUI) first, or pass --force " +
            "(unsafe while it is running).",
        );
        return 1;
      }
      io.error(`[error] cannot lock ${path.resolve(sessionsDir)}: ${exc instanceof Error ? exc.message : String(exc)}`);
      return 1;
    }
  }

  let result: SpillPruneResult;
  try {
    result = new SpillStore(root).prune({ olderThanMs: duration.ms, dryRun });
  } catch (exc) {
    io.error(`[error] spill gc failed: ${exc instanceof Error ? exc.message : String(exc)}`);
    return 1;
  } finally {
    release?.();
  }

  for (const line of result.errors) io.error(`[warn] ${line}`);
  if (jsonMode) {
    io.log(
      JSON.stringify({
        root: absoluteRoot,
        older_than_ms: duration.ms,
        older_than: duration.label,
        dry_run: result.dryRun,
        removed: result.removed,
        kept: result.kept,
        bytes: result.bytes,
        failed: result.failed,
        files_before: result.filesBefore,
        files_after: result.filesAfter,
        temps_removed: result.tempsRemoved,
        temp_bytes: result.tempBytes,
        errors: result.errors,
      }),
    );
    return result.failed > 0 ? 1 : 0;
  }
  io.log(spillPruneSummary(result, duration.label, absoluteRoot));
  return result.failed > 0 ? 1 : 0;
}

/**
 * `two-brothers spill <stats|gc>`: the operator-facing retention surface. The
 * root is always `<sessions-dir>/spill`, the same convention as serve/TUI.
 */
function doSpill(
  argv: string[],
  io: CliIO,
  style: CliStyle = plainCliStyle,
): number {
  const parsed = parseCommandArgs(argv, SPILL_OPTIONS, "spill", io, true);
  if (parsed === null) return 2;
  const { values, positionals } = parsed;
  if (isHelpRequested(values)) {
    io.log(renderCommandHelp("spill", style));
    return 0;
  }
  const sessionsDir =
    typeof values["sessions-dir"] === "string" && values["sessions-dir"].trim()
      ? values["sessions-dir"]
      : "sessions";
  const jsonMode = values.json === true;
  const subcommand = positionals[0];
  if (subcommand === undefined) {
    return spillUsageError("no subcommand: spill <stats|gc> [flags]", io);
  }
  if (positionals.length > 1) {
    return spillUsageError(`unexpected argument: ${positionals.slice(1).join(" ")}`, io);
  }
  if (subcommand === "stats") {
    // stats is read-only: gc's age/dry-run/force flags are usage errors here,
    // not silently ignored options.
    const gcOnly = argv.filter(
      (arg) =>
        arg === "--older-than" ||
        arg.startsWith("--older-than=") ||
        arg === "--dry-run" ||
        arg === "--force",
    );
    if (gcOnly.length > 0) {
      return spillUsageError(
        `spill stats does not accept gc-only flag(s): ${[...new Set(gcOnly)].join(", ")}`,
        io,
      );
    }
    return spillStatsCommand(sessionsDir, jsonMode, io);
  }
  if (subcommand === "gc") {
    if (values["older-than"] === undefined) {
      return spillUsageError(
        "missing --older-than: spill gc --older-than <n>m|h|d [--dry-run] [--json] [--force]",
        io,
      );
    }
    const duration = parseSpillDuration(values["older-than"]);
    if (!duration.ok) return spillUsageError(duration.error, io);
    return spillGcCommand(
      sessionsDir,
      duration,
      values["dry-run"] === true,
      values.force === true,
      jsonMode,
      io,
    );
  }
  return spillUsageError(
    `unexpected argument '${subcommand}' (spill takes 'stats' or 'gc')`,
    io,
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
async function doDoctor(
  argv: string[],
  io: CliIO,
  style: CliStyle = plainCliStyle,
): Promise<number> {
  const parsed = parseCommandArgs(argv, DOCTOR_OPTIONS, "doctor", io);
  if (parsed === null) return 2;
  const { values } = parsed;
  if (isHelpRequested(values)) {
    io.log(renderCommandHelp("doctor", style));
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
  for (const line of formatDoctorReport(report, style)) io.log(line);
  const failed = report.checks.filter((check) => check.status === "fail").length;
  io.log(
    report.ok
      ? style.paint("success", "doctor: ok")
      : style.paint("error", `doctor: ${failed} failed check(s)`),
  );
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
function doConfig(
  argv: string[],
  io: CliIO,
  style: CliStyle = plainCliStyle,
): number {
  const parsed = parseCommandArgs(argv, CONFIG_OPTIONS, "config", io);
  if (parsed === null) return 2;
  const { values } = parsed;
  if (isHelpRequested(values)) {
    io.log(renderCommandHelp("config", style));
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
function doCompletions(
  argv: string[],
  io: CliIO,
  style: CliStyle = plainCliStyle,
): number {
  const parsed = parseCommandArgs(argv, HELP_OPTIONS, "completions", io, true);
  if (parsed === null) return 2;
  const { values, positionals } = parsed;
  if (isHelpRequested(values)) {
    io.log(renderCommandHelp("completions", style));
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

async function doServe(
  argv: string[],
  io: CliIO,
  style: CliStyle = plainCliStyle,
): Promise<number> {
  const parsed = parseCommandArgs(
    argv,
    {
      ...OPTIONS,
      host: { type: "string" as const },
      port: { type: "string" as const },
      "sessions-dir": { type: "string" as const },
      workers: { type: "string" as const },
      "spill-retention-days": { type: "string" as const },
      ...APPROVAL_MODE_OPTIONS,
      ...THINKING_BUDGET_OPTIONS,
      ...HELP_OPTIONS,
    },
    "serve",
    io,
  );
  if (parsed === null) return 2;
  const { values } = parsed;
  if (isHelpRequested(values)) {
    io.log(renderCommandHelp("serve", style));
    return 0;
  }
  const host = values.host ?? "127.0.0.1";
  const port = Number.parseInt(values.port ?? "8600", 10);
  if (!Number.isFinite(port)) {
    io.error(`[error] invalid port: ${String(values.port)}`);
    return 2;
  }
  const workers = values.workers !== undefined ? Number.parseInt(values.workers, 10) : undefined;
  // Opt-in startup retention: absent means no automatic deletion. The value is
  // a positive whole number of days; gc's duration syntax stays a CLI-only
  // convenience for the manual command.
  let spillRetentionDays: number | undefined;
  if (values["spill-retention-days"] !== undefined) {
    const raw = String(values["spill-retention-days"]).trim();
    if (!/^[1-9]\d*$/.test(raw)) {
      io.error(
        `[error] invalid --spill-retention-days: ${String(values["spill-retention-days"])} ` +
          "(use a positive integer number of days)",
      );
      io.error(`Usage: ${commandUsage("serve")}`);
      io.error("Run 'two-brothers serve --help'.");
      return 2;
    }
    const days = Number.parseInt(raw, 10);
    if (!Number.isSafeInteger(days) || !Number.isSafeInteger(days * 86_400_000)) {
      io.error(`[error] invalid --spill-retention-days: ${raw} (number of days is too large)`);
      return 2;
    }
    spillRetentionDays = days;
  }

  // Pinned approval mode: an explicit --approval-mode (or its env counterpart)
  // pins every run this server starts. The pin is in-memory only and never
  // reaches sessions/settings.json; without either, the persisted
  // approval_policy setting (or the fail-closed `ask`) applies.
  const rawApprovalMode =
    (typeof values["approval-mode"] === "string" && values["approval-mode"].trim()) ||
    (process.env.TWO_BROTHERS_APPROVAL_MODE ?? "").trim();
  let approvalPolicy: ApprovalMode | undefined;
  if (rawApprovalMode) {
    const normalized = normalizeApprovalMode(rawApprovalMode);
    if (normalized === null) {
      io.error(
        `[error] invalid approval mode: ${rawApprovalMode} (use ${APPROVAL_MODES.join("|")})`,
      );
      return 2;
    }
    approvalPolicy = normalized;
    const warning = approvalModeWarning(normalized);
    if (warning !== null) io.error(`[warn] ${warning}`);
  }
  const thinkingProblem = thinkingBudgetProblem(values);
  if (thinkingProblem !== null) return reportThinkingBudgetProblem("serve", thinkingProblem, io);
  // Explicit --plugins-dir (or TWO_BROTHERS_PLUGINS_DIR) wins; otherwise the
  // server keeps its module-relative default (`<repo>/plugins`), which is what
  // existing checkouts and tests rely on. Skill roots follow the same
  // convention as run/chat.
  const pluginsDirFlag =
    (typeof values["plugins-dir"] === "string" && values["plugins-dir"].trim()) ||
    (process.env.TWO_BROTHERS_PLUGINS_DIR ?? "").trim();
  // `--mcp-config` > `TWO_BROTHERS_MCP_CONFIG`; the server treats the file as
  // the per-run MCP base (a missing file warns and keeps plugin servers).
  const mcpConfig = mcpConfigFromValues(values);
  const app = createServer({
    // CLI flags (applied per run via the config factory) > env > persisted.
    configFactory: () => resolveConfig(argsToConfigArgs(values)),
    sessionsDir: values["sessions-dir"] ?? "sessions",
    workers: workers !== undefined && Number.isFinite(workers) ? workers : undefined,
    ...(pluginsDirFlag ? { pluginsDir: path.resolve(pluginsDirFlag) } : {}),
    skillsDirs: skillsRootsForCli(values),
    commandsDirs: commandsRootsForCli(values),
    ...(mcpConfig !== undefined ? { mcpConfig } : {}),
    ...(approvalPolicy !== undefined ? { approvalPolicy } : {}),
    ...(spillRetentionDays !== undefined ? { spillRetentionDays } : {}),
  });
  const server = await app.listen(host, port);
  io.log(
    `Two Brothers server on http://${host}:${port} ` +
      `(sessions: ${path.resolve(values["sessions-dir"] ?? "sessions")})`,
  );
  // Serve until interrupted. SIGINT/SIGTERM (and SIGHUP on POSIX) run a
  // graceful shutdown: cooperatively cancel in-flight runs, end SSE
  // connections, close the server — then fall through to the normal
  // exit-code path instead of dying in the signal default. A `close` from any
  // other source (an embedder calling app.close()) resolves the loop the same
  // way.
  const posixSignals = process.platform !== "win32";
  await new Promise<void>((resolve) => {
    let shutdownStarted = false;
    const finish = (): void => {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      if (posixSignals) process.off("SIGHUP", onSighup);
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
    const onSighup = (): void => beginShutdown("SIGHUP");
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);
    // SIGHUP rides the same idempotent beginShutdown path on POSIX. Windows
    // can emit it on console close but force-terminates ~10 s later; the
    // deliberate omission avoids claiming a cleanup window we cannot keep.
    if (posixSignals) process.on("SIGHUP", onSighup);
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

async function doModels(
  argv: string[],
  io: CliIO,
  style: CliStyle = plainCliStyle,
): Promise<number> {
  const parsed = parseCommandArgs(argv, MODELS_OPTIONS, "models", io);
  if (parsed === null) return 2;
  const { values } = parsed;
  if (isHelpRequested(values)) {
    io.log(renderCommandHelp("models", style));
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

async function doOnboard(
  argv: string[],
  io: CliIO,
  style: CliStyle = plainCliStyle,
): Promise<number> {
  const parsed = parseCommandArgs(argv, ONBOARD_OPTIONS, "onboard", io);
  if (parsed === null) return 2;
  const { values } = parsed;
  if (isHelpRequested(values)) {
    io.log(renderCommandHelp("onboard", style));
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
function doHelp(
  argv: string[],
  io: CliIO,
  style: CliStyle = plainCliStyle,
): number {
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
    io.log(renderFullHelp(style));
    return 0;
  }
  if (isHelpRequested(values)) {
    printHelp(io, style);
    return 0;
  }
  const target = positionals[0];
  if (target === undefined) {
    printHelp(io, style);
    return 0;
  }
  if (positionals.length > 1) {
    io.error(`[error] unexpected argument: ${positionals.slice(1).join(" ")}`);
    io.error("Usage: two-brothers help [command]");
    io.error("Run 'two-brothers help --help'.");
    return 2;
  }
  if (commandHelp(target) === undefined) return reportUnknownCommand(target, io, style);
  if (target === "tui") {
    // `help tui` has no `--keys-file` flag context, so it resolves the same
    // env/default precedence `tui --help` uses when no flag is passed: an
    // invalid/unreadable configured file prints the same one-line diagnostic
    // and falls back to the default chords (a missing default file is silent).
    const resolved = resolveTuiKeyCommandsForCli({});
    if (resolved.diagnostics.length > 0) {
      io.error(`[tui keys] ${resolved.diagnostics.join("; ")}`);
    }
    io.log(commandHelpFor(target, style, resolved.commands));
    io.log("");
    io.log(
      'note: this key guide uses the env/default TUI keys file (TWO_BROTHERS_TUI_KEYS_FILE ' +
        'or ~/.two-brothers/tui-keys.json); run "two-brothers tui --help --keys-file <path>" ' +
        "to show a flag-selected file.",
    );
    return 0;
  }
  io.log(commandHelpFor(target, style));
  return 0;
}

/** `two-brothers selftest [--help]`: the offline protocol/provider gate. */
async function doSelftest(
  argv: string[],
  io: CliIO,
  style: CliStyle = plainCliStyle,
): Promise<number> {
  const parsed = parseCommandArgs(argv, HELP_OPTIONS, "selftest", io);
  if (parsed === null) return 2;
  if (isHelpRequested(parsed.values)) {
    io.log(renderCommandHelp("selftest", style));
    return 0;
  }
  return selftest();
}

/**
 * The CLI entry point. `io` is injectable so tests and embedders can drive it
 * in-process; `style` is injectable for the same reason. Without an explicit
 * style, the real process sink resolves the terminal style from stdout/env
 * while a custom sink stays plain (its bytes are not the operator's terminal).
 */
export async function main(
  argv: string[],
  io: CliIO = defaultIO,
  style?: CliStyle,
): Promise<number> {
  const cliStyle = style ?? (io === defaultIO ? resolveCliStyle() : plainCliStyle);
  if (argv.length === 0) {
    // Modern-CLI convention: an interactive terminal opens the full TUI
    // (like opencode/kimi bare invocations); piped or CI invocations get
    // the usage screen so scripts keep working.
    if (process.stdin.isTTY === true) return doTui([], io, cliStyle);
    printHelp(io, cliStyle);
    return 0;
  }
  const command = argv[0];
  if (command === "help") return doHelp(argv.slice(1), io, cliStyle);
  if (command === "--help" || command === "-h") {
    printHelp(io, cliStyle);
    return 0;
  }
  if (command === "--version" || command === "-v") {
    io.log(packageVersion());
    return 0;
  }
  if (command === "selftest") return doSelftest(argv.slice(1), io, cliStyle);
  if (command === "sessions") return doSessions(argv.slice(1), io, cliStyle);
  if (command === "spill") return doSpill(argv.slice(1), io, cliStyle);
  if (command === "run") return doRun(argv.slice(1), io, cliStyle);
  if (command === "chat") return doChat(argv.slice(1), io, cliStyle);
  if (command === "tui") return doTui(argv.slice(1), io, cliStyle);
  if (command === "serve") return doServe(argv.slice(1), io, cliStyle);
  if (command === "models") return doModels(argv.slice(1), io, cliStyle);
  if (command === "onboard") return doOnboard(argv.slice(1), io, cliStyle);
  if (command === "doctor") return doDoctor(argv.slice(1), io, cliStyle);
  if (command === "config") return doConfig(argv.slice(1), io, cliStyle);
  if (command === "completions") return doCompletions(argv.slice(1), io, cliStyle);
  // An option in the command position (`two-brothers --bogus`) is an unknown
  // option; anything else is an unknown command (both exit 2 with a hint).
  if (command.startsWith("-")) {
    reportUnknownOption(command, undefined, io);
    return 2;
  }
  return reportUnknownCommand(command, io, cliStyle);
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
