/**
 * Single source of truth for the Two Brothers CLI's help surface.
 *
 * `cli.ts` consumes this module for:
 *
 * - the concise, grouped top-level help (`two-brothers help`, `--help`, bare
 *   invocation on a non-TTY stdin),
 * - per-command help (`two-brothers help <command>` and
 *   `two-brothers <command> --help` / `-h`),
 * - `two-brothers help --all`, the full command/flag/environment reference,
 * - the usage lines printed on argument errors,
 * - did-you-mean suggestions for unknown commands (edit distance ≤ 2) and
 *   unknown options (nearest known flag for that command).
 *
 * Nothing here reads the environment, the filesystem or process state: it is
 * pure data plus rendering, so tests can check it directly and other modules
 * (e.g. a shell-completions generator) can reuse the same command/flag
 * catalog. Keep every command and flag in this file — `cli.ts` must not
 * hard-code help text of its own.
 */

const HELP_WIDTH = 96;
const DESCRIPTION_INDENT = 2;

/** One CLI flag: the long name, an optional value placeholder and a one-line
 * help text. `aliases` are short names rendered as `-h, --help`. */
export interface FlagHelp {
  /** Long flag name without the leading dashes (the `parseArgs` key). */
  name: string;
  /** Value placeholder shown after the flag, e.g. `"<url>"`; omitted for booleans. */
  value?: string;
  /** One-line description (rendered wrapped when long). */
  description: string;
  /** Short aliases without the leading dash, e.g. `["h"]`. */
  aliases?: string[];
}

/** One command's help entry. */
export interface CommandHelp {
  /** Command name as typed on the command line. */
  name: string;
  /** One-line summary used in the grouped top-level help. */
  summary: string;
  /** Command form shown in the top-level Commands list, e.g.
   * `two-brothers run "<task>" [flags]` (the `two-brothers` prefix included). */
  commandLine: string;
  /**
   * The line(s) after `Usage: `. The first is the primary form used by
   * argument-error messages; extra lines document alternate forms
   * (`sessions show <name>`, manual `onboard`, ...).
   */
  usage: string[];
  /** Longer description rendered under the usage block. */
  description: string;
  /** Flags shown in this command's help, in display order (`help` is appended
   * automatically when absent). */
  flags: readonly string[];
  /** Every flag `parseArgs` accepts for this command (defaults to `flags`);
   * used for unknown-option suggestions and shell completions. */
  acceptedFlags?: readonly string[];
  /** Command-specific description overrides for a shared flag. */
  flagNotes?: Record<string, string>;
  /** Example invocations (without the leading `two-brothers`). */
  examples: string[];
  /** Extra lines rendered between the description and the flags (REPL
   * commands, notes about accepted values, ...). */
  details?: string[];
}

// --------------------------------------------------------------------------- //
// flags
// --------------------------------------------------------------------------- //

/**
 * Every flag the CLI parses, keyed by its long name. Keep this table in sync
 * with `OPTIONS` in `cli.ts` (the cliergonomics test asserts the parity).
 */
export const FLAGS: Record<string, FlagHelp> = {
  provider: {
    name: "provider",
    value: "<openai|mock>",
    description: "provider family (default openai; mock is fully offline)",
  },
  "provider-kind": {
    name: "provider-kind",
    value: "<openai-compatible|anthropic|google>",
    description: "wire family for openai roles (default openai-compatible)",
  },
  "senior-kind": {
    name: "senior-kind",
    value: "<kind>",
    description: "per-role wire family override for the senior",
  },
  "junior-kind": {
    name: "junior-kind",
    value: "<kind>",
    description: "per-role wire family override for the junior",
  },
  "base-url": {
    name: "base-url",
    value: "<url>",
    description: "OpenAI-compatible base URL shared by both roles",
  },
  "api-key": {
    name: "api-key",
    value: "<key>",
    description: "API key (may be empty for a local server)",
  },
  "senior-base-url": {
    name: "senior-base-url",
    value: "<url>",
    description: "per-role endpoint override: senior base URL (empty falls back to --base-url)",
  },
  "senior-api-key": {
    name: "senior-api-key",
    value: "<key>",
    description: "per-role endpoint override: senior API key",
  },
  "junior-base-url": {
    name: "junior-base-url",
    value: "<url>",
    description: "per-role endpoint override: junior base URL (empty falls back to --base-url)",
  },
  "junior-api-key": {
    name: "junior-api-key",
    value: "<key>",
    description: "per-role endpoint override: junior API key",
  },
  "senior-model": {
    name: "senior-model",
    value: "<m>",
    description: "senior model id",
  },
  "junior-model": {
    name: "junior-model",
    value: "<m>",
    description: "junior model id",
  },
  "senior-system": {
    name: "senior-system",
    value: "<text>",
    description: "override the senior system prompt",
  },
  "junior-system": {
    name: "junior-system",
    value: "<text>",
    description: "override the junior system prompt",
  },
  "max-rounds": {
    name: "max-rounds",
    value: "<n>",
    description: "maximum revise rounds (default 3)",
  },
  "max-tokens": {
    name: "max-tokens",
    value: "<n>",
    description: "output-token cap for both roles (env TWO_BROTHERS_MAX_TOKENS)",
  },
  temperature: {
    name: "temperature",
    value: "<f>",
    description: "sampling temperature (default 0.4)",
  },
  timeout: {
    name: "timeout",
    value: "<s>",
    description:
      "per-attempt provider timeout in seconds (default 120); raise it for slow local models",
  },
  retries: {
    name: "retries",
    value: "<n>",
    description: "retries after a failed model call (default 6; env TWO_BROTHERS_RETRIES)",
  },
  mode: {
    name: "mode",
    value: "<consult|work|auto>",
    description: "cooperation mode (default consult)",
  },
  verbose: {
    name: "verbose",
    description: "extra diagnostics: payloads, prompt audits, plugin load notes",
  },
  json: {
    name: "json",
    description: "run output mode: one machine-readable JSON object on stdout",
  },
  "json-events": {
    name: "json-events",
    description: "alias for --mode json (run only)",
  },
  stream: {
    name: "stream",
    description: "run output mode: NDJSON run events on stdout as they happen",
  },
  "stream-tokens": {
    name: "stream-tokens",
    description:
      "with --stream: one token NDJSON record per provider text delta (env TWO_BROTHERS_STREAM_TOKENS)",
  },
  "dry-run": {
    name: "dry-run",
    description:
      "resolve the run (config, tools, session) and print the plan; no model calls, no session written",
  },
  "task-file": {
    name: "task-file",
    value: "<path>",
    description:
      "read the task from a file (run only); a task of `-` on the command line reads stdin (max 1 MiB)",
  },
  "session-file": {
    name: "session-file",
    value: "<path>",
    description: "JSONL file that persists every protocol envelope",
  },
  resume: {
    name: "resume",
    description: "resume --session-file instead of starting a new session",
  },
  compact: {
    name: "compact",
    description: "compact the context once before the run starts",
  },
  "compact-threshold": {
    name: "compact-threshold",
    value: "<chars>",
    description: "auto-compact when the rendered context passes this size (0 = off)",
  },
  "compact-threshold-tokens": {
    name: "compact-threshold-tokens",
    value: "<n>",
    description:
      "auto-compact at this token estimate (env TWO_BROTHERS_COMPACT_THRESHOLD_TOKENS)",
  },
  "compact-keep-recent": {
    name: "compact-keep-recent",
    value: "<chars>",
    description: "chars of recent envelopes kept verbatim when compacting (default 40000)",
  },
  "context-window": {
    name: "context-window",
    value: "<n>",
    description: "provider context window in tokens; enables token-mode auto-compaction",
  },
  "mcp-config": {
    name: "mcp-config",
    value: "<file>",
    description: 'JSON file with MCP server definitions ({"mcpServers": {...}})',
  },
  "plugins-dir": {
    name: "plugins-dir",
    value: "<dir>",
    description: "plugin directory for run/chat/serve (default <cwd>/plugins; env TWO_BROTHERS_PLUGINS_DIR)",
  },
  "skills-dir": {
    name: "skills-dir",
    value: "<path>",
    description: "extra skills root, repeatable (env TWO_BROTHERS_SKILLS_DIR)",
  },
  "commands-dir": {
    name: "commands-dir",
    value: "<path>",
    description: "extra slash-command root, repeatable (env TWO_BROTHERS_COMMANDS_DIR)",
  },
  host: {
    name: "host",
    value: "<addr>",
    description: "bind address for serve (default 127.0.0.1)",
  },
  port: {
    name: "port",
    value: "<n>",
    description: "port for serve (default 8600)",
  },
  workers: {
    name: "workers",
    value: "<n>",
    description: "background run workers for serve (env TWO_BROTHERS_WORKERS)",
  },
  "sessions-dir": {
    name: "sessions-dir",
    value: "<dir>",
    description: "sessions directory (default sessions)",
  },
  limit: {
    name: "limit",
    value: "<n>",
    description: "limit the number of rows or events printed",
  },
  preset: {
    name: "preset",
    value: "<id>",
    description:
      "seeded provider preset id (openai, deepseek, anthropic, gemini, openrouter, lmstudio, custom)",
  },
  "api-key-env": {
    name: "api-key-env",
    value: "<VAR>",
    description: "read the API key from an environment variable instead of --api-key",
  },
  "non-interactive": {
    name: "non-interactive",
    description: "don't prompt; take every value from flags and the preset",
  },
  all: {
    name: "all",
    description: "print the full command/flag/environment reference",
  },
  help: {
    name: "help",
    description: "show this help and exit",
    aliases: ["h"],
  },
};

/**
 * The flags every `run` / `chat` / `tui` invocation parses (the shared
 * `OPTIONS` table in `cli.ts`), in display order. `serve` accepts these too
 * plus its own server flags.
 */
export const SHARED_FLAGS: readonly string[] = [
  "provider",
  "provider-kind",
  "senior-kind",
  "junior-kind",
  "base-url",
  "api-key",
  "senior-base-url",
  "senior-api-key",
  "junior-base-url",
  "junior-api-key",
  "senior-model",
  "junior-model",
  "senior-system",
  "junior-system",
  "max-rounds",
  "max-tokens",
  "temperature",
  "timeout",
  "retries",
  "mode",
  "verbose",
  "json",
  "json-events",
  "stream",
  "stream-tokens",
  "session-file",
  "resume",
  "compact",
  "compact-threshold",
  "compact-threshold-tokens",
  "compact-keep-recent",
  "context-window",
  "mcp-config",
  "plugins-dir",
  "skills-dir",
  "commands-dir",
];

/** Output-related shared flags (`run` only, listed separately in `run --help`). */
const RUN_OUTPUT_FLAGS = ["json", "json-events", "stream", "stream-tokens", "verbose"];

// --------------------------------------------------------------------------- //
// commands
// --------------------------------------------------------------------------- //

const COMMAND_TABLE: Record<string, CommandHelp> = {};

function defineCommand(spec: CommandHelp): void {
  COMMAND_TABLE[spec.name] = spec;
}

defineCommand({
  name: "run",
  summary: "one cooperation cycle: task -> decision",
  commandLine: 'two-brothers run "<task>" [flags]',
  usage: [
    'run "<task>" [flags]',
    "run - [flags]",
    "run --task-file <path> [flags]",
  ],
  description:
    "Run one task through the two-brother loop: the senior either consults the " +
    "junior for a proposal or delegates work and receives a deliverable, reviews " +
    "it and makes the final decision. Prints the human transcript, a token-usage " +
    "footer and, when both roles resolve to the same priced model, a cost line. " +
    "The task comes from the positional argument; a task of `-` reads it from " +
    "stdin (bounded to 1 MiB) and --task-file reads it from a file. --dry-run " +
    "resolves the whole run and prints the plan without calling a model or " +
    "writing a session.",
  flags: [
    "provider",
    "provider-kind",
    "senior-kind",
    "junior-kind",
    "base-url",
    "api-key",
    "senior-base-url",
    "senior-api-key",
    "junior-base-url",
    "junior-api-key",
    "senior-model",
    "junior-model",
    "senior-system",
    "junior-system",
    "max-rounds",
    "max-tokens",
    "temperature",
    "timeout",
    "retries",
    "mode",
    ...RUN_OUTPUT_FLAGS,
    "dry-run",
    "task-file",
    "session-file",
    "resume",
    "compact",
    "compact-threshold",
    "compact-threshold-tokens",
    "compact-keep-recent",
    "context-window",
    "mcp-config",
    "plugins-dir",
    "skills-dir",
    "help",
  ],
  acceptedFlags: [...SHARED_FLAGS, "dry-run", "task-file"],
  flagNotes: {
    mode: "cooperation mode consult|work|auto; run also accepts the output modes print|json",
    "dry-run":
      "print the resolved plan (roles with sources, tools, session, compaction) " +
      "and exit 0; invalid with --stream (usage error)",
  },
  examples: [
    'two-brothers run "Plan a migration from Redis to Valkey" --provider mock',
    'two-brothers run "Pick a testing scheme" --provider mock --mode json',
    'two-brothers run "List the files" --provider mock --mode work --stream',
    'two-brothers run - --provider mock --dry-run < task.txt',
    "two-brothers run --task-file task.txt --provider mock",
  ],
});

defineCommand({
  name: "chat",
  summary: "REPL: many tasks in one shared session",
  commandLine: "two-brothers chat [flags]",
  usage: ["chat [flags]"],
  description:
    "Line-based REPL over the cooperation harness. Every non-command line is a " +
    "task; the shared context and an optional --session-file carry across turns. " +
    "An empty line, exit, quit, q, /exit or /quit leaves the REPL. --dry-run " +
    "prints the resolved plan and exits without starting the REPL.",
  flags: [
    "provider",
    "provider-kind",
    "senior-kind",
    "junior-kind",
    "base-url",
    "api-key",
    "senior-base-url",
    "senior-api-key",
    "junior-base-url",
    "junior-api-key",
    "senior-model",
    "junior-model",
    "senior-system",
    "junior-system",
    "max-rounds",
    "max-tokens",
    "temperature",
    "timeout",
    "retries",
    "mode",
    "verbose",
    "dry-run",
    "session-file",
    "resume",
    "compact",
    "compact-threshold",
    "compact-threshold-tokens",
    "compact-keep-recent",
    "context-window",
    "mcp-config",
    "plugins-dir",
    "skills-dir",
    "commands-dir",
    "help",
  ],
  acceptedFlags: [...SHARED_FLAGS, "dry-run"],
  flagNotes: {
    mode: "cooperation mode consult|work|auto (the run output modes are not accepted here)",
  },
  details: [
    "REPL commands:",
    "  /help, /h        this list",
    "  /commands        list discovered slash commands",
    "  /config          resolved provider/model/base-url per role",
    "  /exit, /quit     leave (empty line, exit, quit, q also work)",
    "  /<name> [args]   expand a command from the commands roots",
  ],
  examples: [
    "two-brothers chat --provider mock",
    "two-brothers chat --provider mock --session-file session.jsonl",
  ],
});

defineCommand({
  name: "tui",
  summary: "full-screen terminal chat (needs an interactive terminal)",
  commandLine: "two-brothers tui [task] [flags]",
  usage: ["tui [initial task] [flags]"],
  description:
    "Full-screen interactive chat in the terminal's alternate screen over the same " +
    "cooperation harness as run/chat (mock or real providers). A bare " +
    '"two-brothers" in an interactive terminal opens this TUI; a piped stdin is ' +
    "refused with exit 2 (use chat for scripts). The key guide printed below is " +
    "generated from the same registry that powers the in-app Ctrl+P palette and " +
    "the ? help overlay.",
  flags: [
    "provider",
    "provider-kind",
    "senior-kind",
    "junior-kind",
    "base-url",
    "api-key",
    "senior-base-url",
    "senior-api-key",
    "junior-base-url",
    "junior-api-key",
    "senior-model",
    "junior-model",
    "senior-system",
    "junior-system",
    "max-rounds",
    "max-tokens",
    "temperature",
    "timeout",
    "retries",
    "mode",
    "verbose",
    "session-file",
    "resume",
    "compact",
    "compact-threshold",
    "compact-threshold-tokens",
    "compact-keep-recent",
    "context-window",
    "mcp-config",
    "plugins-dir",
    "skills-dir",
    "commands-dir",
    "stream-tokens",
    "help",
  ],
  acceptedFlags: SHARED_FLAGS,
  flagNotes: {
    mode: "cooperation mode consult|work|auto (print/json are run output modes)",
  },
  examples: [
    "two-brothers tui --provider mock",
    'two-brothers tui "Plan a migration from Redis to Valkey" --provider mock',
  ],
});

defineCommand({
  name: "serve",
  summary: "web workspace backend (JSON API + SSE + the built web UI)",
  commandLine: "two-brothers serve [flags]",
  usage: ["serve [flags]"],
  description:
    "Start the local single-user web workspace backend: a plain node:http JSON " +
    "API with SSE for live run events, serving the built web app at / (the repo's " +
    "web/dist in a checkout, the packaged copy in the npm tarball). SIGINT/SIGTERM " +
    "run a graceful shutdown: in-flight runs are cooperatively stopped, SSE " +
    "connections ended and the server closed.",
  flags: [
    "host",
    "port",
    "workers",
    "sessions-dir",
    "timeout",
    "provider",
    "base-url",
    "api-key",
    "senior-base-url",
    "senior-api-key",
    "junior-base-url",
    "junior-api-key",
    "senior-model",
    "junior-model",
    "max-tokens",
    "plugins-dir",
    "skills-dir",
    "commands-dir",
    "mcp-config",
    "verbose",
    "help",
  ],
  acceptedFlags: [...SHARED_FLAGS, "host", "port", "sessions-dir", "workers"],
  flagNotes: {
    timeout:
      "per-provider-attempt timeout in seconds (default 120; env TWO_BROTHERS_TIMEOUT); " +
      "raise this for slow local models",
  },
  examples: [
    "two-brothers serve",
    "two-brothers serve --host 127.0.0.1 --port 8600 --sessions-dir sessions",
  ],
});

defineCommand({
  name: "sessions",
  summary: "list stored sessions, or read one session's envelopes",
  commandLine: "two-brothers sessions [--sessions-dir <dir>] [--json] [--limit <n>]",
  usage: [
    "sessions [--sessions-dir <dir>] [--json] [--limit <n>]",
    "sessions show <name> [--json] [--limit <n>]",
  ],
  description:
    "List the JSONL session files of a sessions directory with readable titles " +
    "(derived from the first operator message), envelope counts and the " +
    "last-modified time. Output-only: it never changes the files. " +
    "`sessions show <name>` prints one session's summary and its protocol " +
    "envelopes; the name resolves with or without the .jsonl suffix.",
  flags: ["sessions-dir", "json", "limit", "help"],
  flagNotes: {
    json: "print a stable JSON array (list) or one JSON object (show) instead of the table",
    limit: "list: cap the number of rows; show: cap the number of envelopes printed",
  },
  examples: [
    "two-brothers sessions",
    "two-brothers sessions --sessions-dir sessions --json",
    "two-brothers sessions show s",
    "two-brothers sessions show s.jsonl --json --limit 20",
  ],
});

defineCommand({
  name: "models",
  summary: "list the models an OpenAI-compatible endpoint reports",
  commandLine: "two-brothers models --base-url <url> [--api-key <key>] [--json]",
  usage: ["models --base-url <url> [--api-key <key> | --api-key-env <VAR>] [--json]"],
  description:
    "Ask an OpenAI-compatible endpoint for its model list (GET {base}/models) and " +
    "print the ids (with owned_by when the endpoint reports it). --json prints " +
    "the parsed list as one JSON array. The API key never appears in output.",
  flags: ["base-url", "api-key", "api-key-env", "timeout", "json", "help"],
  flagNotes: {
    json: "print the model list as one JSON array instead of the human table",
  },
  examples: [
    "two-brothers models --base-url https://api.deepseek.com/v1",
    "two-brothers models --base-url https://api.deepseek.com/v1 --api-key-env DEEPSEEK_API_KEY",
    "two-brothers models --base-url http://localhost:1234/v1 --json",
  ],
});

defineCommand({
  name: "onboard",
  summary: "write per-role provider settings to sessions/settings.json",
  commandLine: "two-brothers onboard [flags]",
  usage: [
    "onboard [--sessions-dir <dir>] [--preset <id>] [--non-interactive]",
    "onboard --base-url <url> [--api-key <key>] --senior-model <m> " +
      "[--junior-model <m>] [--non-interactive]",
  ],
  description:
    "Write per-role provider settings to <sessions-dir>/settings.json from a " +
    "seeded preset (openai, deepseek, anthropic, gemini, openrouter, lmstudio, " +
    "custom) or manual fields. Interactive by default; --non-interactive takes " +
    "every value from flags. The key is encrypted at rest and only its presence " +
    "is printed back.",
  flags: [
    "sessions-dir",
    "preset",
    "base-url",
    "api-key",
    "api-key-env",
    "senior-model",
    "junior-model",
    "provider-kind",
    "non-interactive",
    "help",
  ],
  examples: [
    "two-brothers onboard",
    "two-brothers onboard --preset lmstudio --non-interactive",
    "two-brothers onboard --base-url http://localhost:1234/v1 " +
      "--senior-model model-a --junior-model model-b --non-interactive",
  ],
});

defineCommand({
  name: "doctor",
  summary: "local environment and provider diagnostics",
  commandLine: "two-brothers doctor [--json] [flags]",
  usage: ["doctor [--json] [--sessions-dir <dir>] [--timeout <s>] [provider flags]"],
  description:
    "Run a fixed, local diagnostic pass in a stable order: Node engine, settings " +
    "file, sessions-directory writability, per-role provider configuration, the " +
    "provider endpoint (skipped for mock), built web assets, and the plugins " +
    "directory. Every check prints one [pass]/[warn]/[fail]/[skip] line; the " +
    "command exits 0 when no check failed and 1 otherwise (warnings never fail). " +
    "The endpoint probe is bounded by --timeout.",
  flags: [
    "provider",
    "provider-kind",
    "senior-kind",
    "junior-kind",
    "base-url",
    "api-key",
    "senior-base-url",
    "senior-api-key",
    "junior-base-url",
    "junior-api-key",
    "senior-model",
    "junior-model",
    "timeout",
    "sessions-dir",
    "json",
    "help",
  ],
  acceptedFlags: [
    "provider",
    "provider-kind",
    "senior-kind",
    "junior-kind",
    "base-url",
    "api-key",
    "senior-base-url",
    "senior-api-key",
    "junior-base-url",
    "junior-api-key",
    "senior-model",
    "junior-model",
    "timeout",
    "sessions-dir",
    "json",
  ],
  flagNotes: {
    timeout: "endpoint-probe timeout in seconds (default 5)",
    "sessions-dir": "sessions directory to inspect (default sessions)",
    json: "print one JSON object {ok, checks} instead of the human report",
  },
  examples: [
    "two-brothers doctor --provider mock",
    "two-brothers doctor --provider openai --timeout 10",
    "two-brothers doctor --json --sessions-dir ./sessions",
  ],
});

defineCommand({
  name: "config",
  summary: "resolved configuration: roles, sources, roots and limits",
  commandLine: "two-brothers config [--json] [provider flags]",
  usage: ["config [--json] [--sessions-dir <dir>] [provider flags]"],
  description:
    "Print the resolved configuration without making a model call: per role the " +
    "provider, wire kind, base URL, model and API-key presence, each with the " +
    "layer that supplied it (flag > role env > shared env > preset > settings > " +
    "default), then the cooperation mode, sessions directory, plugin/skills/" +
    "commands roots, compaction settings and the token/retry/timeout limits. " +
    "API keys are only ever reported as set or not set — a value never leaves " +
    "the process. The settings and preset layers come from " +
    "<sessions-dir>/settings.json (the serve store); run/chat/tui resolve flags " +
    "and TWO_BROTHERS_* env only. --json prints one stable object instead of " +
    "the aligned table.",
  flags: [
    "provider",
    "provider-kind",
    "senior-kind",
    "junior-kind",
    "base-url",
    "api-key",
    "senior-base-url",
    "senior-api-key",
    "junior-base-url",
    "junior-api-key",
    "senior-model",
    "junior-model",
    "max-tokens",
    "retries",
    "timeout",
    "mode",
    "sessions-dir",
    "json",
    "help",
  ],
  acceptedFlags: [
    "provider",
    "provider-kind",
    "senior-kind",
    "junior-kind",
    "base-url",
    "api-key",
    "senior-base-url",
    "senior-api-key",
    "junior-base-url",
    "junior-api-key",
    "senior-model",
    "junior-model",
    "max-tokens",
    "retries",
    "timeout",
    "mode",
    "sessions-dir",
    "json",
  ],
  flagNotes: {
    json: "print one stable JSON object instead of the human table (keys stay masked)",
    "sessions-dir": "sessions directory whose settings.json and defaults are inspected",
  },
  examples: [
    "two-brothers config",
    "two-brothers config --json",
    "two-brothers config --provider mock --sessions-dir ./sessions",
    "two-brothers config --provider openai --base-url https://api.deepseek.com/v1 --senior-model deepseek-chat",
  ],
});

defineCommand({
  name: "completions",
  summary: "shell completion scripts (bash|zsh|fish|powershell)",
  commandLine: "two-brothers completions <shell>",
  usage: ["completions <bash|zsh|fish|powershell>"],
  description:
    "Print a ready-to-source completion script for one shell on stdout. The " +
    "script is generated from the same command and flag catalog as help, so every " +
    "command (including doctor and completions) completes like the rest. Install " +
    "with: bash `source <(two-brothers completions bash)`; zsh " +
    "`two-brothers completions zsh > \"$fpath[1]/_two-brothers\"` (or source it " +
    "after compinit); fish " +
    "`two-brothers completions fish > ~/.config/fish/completions/two-brothers.fish`; " +
    "PowerShell `two-brothers completions powershell | Out-String | Invoke-Expression`.",
  flags: ["help"],
  examples: [
    "two-brothers completions bash",
    "two-brothers completions zsh > _two-brothers",
    "two-brothers completions powershell | Out-String | Invoke-Expression",
  ],
});

defineCommand({
  name: "selftest",
  summary: "offline check of the protocol, providers and cooperation loop",
  commandLine: "two-brothers selftest",
  usage: ["selftest"],
  description:
    "Run the bundled offline self-test: protocol envelopes, tolerant payload " +
    "parsing, the mock provider and one full cooperation loop. Prints " +
    "SELFTEST: PASS and exits 0 on success, 1 on failure.",
  flags: ["help"],
  examples: ["two-brothers selftest"],
});

defineCommand({
  name: "help",
  summary: "command help; `help --all` for the full reference",
  commandLine: "two-brothers help [command]",
  usage: ["help [command]", "help --all"],
  description:
    "Without an argument print the grouped overview; with a command name print " +
    "that command's usage, flags and examples; with --all print the complete " +
    "command/flag/environment reference.",
  flags: ["all", "help"],
  acceptedFlags: ["all", "help"],
  examples: [
    "two-brothers help",
    "two-brothers help run",
    "two-brothers help --all",
  ],
});

/** Command display order for the grouped help, `help --all` and completions. */
export const COMMAND_ORDER: readonly string[] = [
  "run",
  "chat",
  "tui",
  "serve",
  "sessions",
  "models",
  "onboard",
  "doctor",
  "config",
  "completions",
  "selftest",
  "help",
];

/** Known command names, in display order. */
export function commandNames(): string[] {
  return [...COMMAND_ORDER];
}

/** The help spec for a known command, or `undefined`. */
export function commandHelp(name: string): CommandHelp | undefined {
  return COMMAND_TABLE[name];
}

/** The primary usage line for a command, used by argument-error messages. */
export function commandUsage(name: string): string {
  const spec = COMMAND_TABLE[name];
  if (spec === undefined) return "two-brothers [command] [flags]";
  return `two-brothers ${spec.usage[0]}`;
}

// --------------------------------------------------------------------------- //
// rendering
// --------------------------------------------------------------------------- //

/** Word-wrap `text` to `width` columns, returning bare lines. */
function wrapText(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter((word) => word.length > 0);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (current === "") {
      current = word;
    } else if (current.length + 1 + word.length <= width) {
      current += ` ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/** Render a paragraph with a hanging indent, one logical line per element. */
function renderParagraphs(texts: string[], indent = DESCRIPTION_INDENT): string[] {
  const lines: string[] = [];
  const pad = " ".repeat(indent);
  for (const text of texts) {
    for (const line of wrapText(text, HELP_WIDTH - indent)) lines.push(pad + line);
  }
  return lines;
}

/** A flag's rendered form, e.g. `--retries <n>` or `-h, --help`. */
function flagLabel(flag: FlagHelp): string {
  const long = `--${flag.name}${flag.value ? ` ${flag.value}` : ""}`;
  const short = flag.aliases?.map((alias) => `-${alias}`).join(", ");
  return short ? `${short}, ${long}` : long;
}

/** Render the `Flags:` block for a command spec. */
function renderFlags(spec: CommandHelp): string[] {
  const names = spec.flags.includes("help") ? spec.flags : [...spec.flags, "help"];
  const entries = names
    .map((name) => {
      const flag = FLAGS[name];
      if (flag === undefined) throw new Error(`help: unknown flag spec '${name}' for '${spec.name}'`);
      const description = spec.flagNotes?.[name] ?? flag.description;
      return { label: flagLabel(flag), description };
    });
  const labelWidth = Math.min(
    40,
    Math.max(2, ...entries.map((entry) => entry.label.length)),
  );
  const lines: string[] = ["Flags:"];
  for (const entry of entries) {
    const prefix = `  ${entry.label.padEnd(labelWidth)}  `;
    const continuation = " ".repeat(prefix.length);
    const width = Math.max(20, HELP_WIDTH - prefix.length);
    const wrapped = wrapText(entry.description, width);
    lines.push(prefix + wrapped[0]);
    for (const extra of wrapped.slice(1)) lines.push(continuation + extra);
  }
  return lines;
}

/** Render a command's help body (usage, description, details, flags, examples). */
function commandHelpBody(spec: CommandHelp): string[] {
  const lines: string[] = [];
  spec.usage.forEach((usage, index) => {
    lines.push(`${index === 0 ? "Usage: " : "       "}two-brothers ${usage}`);
  });
  lines.push("");
  lines.push(...renderParagraphs([spec.description]));
  if (spec.details && spec.details.length > 0) {
    lines.push("");
    lines.push(...spec.details);
  }
  lines.push("");
  lines.push(...renderFlags(spec));
  if (spec.examples.length > 0) {
    lines.push("");
    lines.push("Examples:");
    for (const example of spec.examples) lines.push(`  ${example}`);
  }
  return lines;
}

/**
 * `two-brothers help <command>` / `<command> --help`: usage, description,
 * flags and examples for one command, on stdout, exit 0.
 */
export function renderCommandHelp(name: string): string {
  const spec = COMMAND_TABLE[name];
  if (spec === undefined) throw new Error(`help: unknown command '${name}'`);
  return [...commandHelpBody(spec), "", "Run 'two-brothers help --all' for the full reference."].join(
    "\n",
  );
}

/** The concise, grouped top-level help screen. */
export function renderMainHelp(): string {
  const lines: string[] = [
    "Two Brothers: a senior (arbiter) and a junior (advisor/executor) sharing one context.",
    "",
    "Commands:",
  ];
  const commandColumn = 40;
  for (const name of COMMAND_ORDER) {
    const spec = COMMAND_TABLE[name];
    if (spec === undefined) continue;
    const commandLine = spec.commandLine;
    if (2 + commandLine.length + 2 + spec.summary.length <= HELP_WIDTH) {
      lines.push(`  ${commandLine.padEnd(commandColumn)}${spec.summary}`);
    } else {
      lines.push(`  ${commandLine}`);
      lines.push(`  ${" ".repeat(commandColumn)}${spec.summary}`);
    }
  }
  lines.push(
    `  ${"two-brothers --version".padEnd(commandColumn)}` +
      "print the @two-brothers/harness version",
    "",
    "Common flows:",
    '  two-brothers run "Plan a migration from Redis to Valkey" --provider mock',
    '  two-brothers run "Pick a testing scheme" --provider mock --mode json > out.json',
    "  two-brothers chat --provider mock",
    "  two-brothers tui --provider mock",
    "  two-brothers onboard --preset lmstudio --non-interactive",
    "  two-brothers sessions --sessions-dir ./sessions",
    "  two-brothers doctor --provider mock",
    "",
    "Output modes:",
    "  run: --json / --json-events  one machine-readable JSON object on stdout",
    "       --stream              NDJSON run events on stdout as they happen",
    "       --mode print          only the final decision text",
    "       --stream-tokens       with --stream: token deltas as NDJSON records",
    "       --verbose             payloads and diagnostics; warnings always go to stderr",
    "       --dry-run             resolve the run and print the plan; no model calls,",
    "                             no session written (invalid with --stream)",
    "       --task-file <path>    read the task from a file; `run -` reads stdin",
    "",
    "Provider & models:",
    "  --provider <openai|mock>   --base-url <url>   --api-key <key>",
    "  --senior-* / --junior-*    per-role endpoints, models and system prompts",
    "  --provider-kind / --senior-kind / --junior-kind   wire family",
    "  --timeout <s>              per-attempt HTTP timeout (default 120; raise for slow local models)",
    "  --retries <n>              retries after a failed model call (default 6; env TWO_BROTHERS_RETRIES)",
    "  --max-tokens <n>           output-token cap for both roles (env TWO_BROTHERS_MAX_TOKENS)",
    "  --max-rounds <n>   --temperature <f>   --mode consult|work|auto",
    "",
    "Sessions & context:",
    "  --session-file <path>  --resume  --sessions-dir <dir>",
    "  --compact  --compact-threshold <chars>  --compact-threshold-tokens <n>",
    "  --compact-keep-recent <chars>  --context-window <n>",
    "",
    "Extensions:",
    "  --mcp-config <file>  --plugins-dir <dir>  --skills-dir <path>",
    "  --commands-dir <path>",
    "",
    "Diagnostics & shell integration:",
    "  two-brothers config [--json]   resolved roles with their sources, roots,",
    "                                 compaction and limits; keys never printed",
    "  two-brothers doctor [--json]   check the engine, settings, sessions, roles,",
    "                                 endpoint, web assets and plugins; exit 1 on a",
    "                                 failing check, 0 otherwise (warnings pass)",
    "  two-brothers completions <shell>   bash|zsh|fish|powershell completion script",
    "                                    on stdout, generated from this catalog",
    "",
    "Environment:",
    "  Each flag has a TWO_BROTHERS_* counterpart that pins the value for the",
    "  invocation: TWO_BROTHERS_PROVIDER, TWO_BROTHERS_BASE_URL,",
    "  TWO_BROTHERS_API_KEY, TWO_BROTHERS_SENIOR_* / TWO_BROTHERS_JUNIOR_*,",
    "  TWO_BROTHERS_MAX_ROUNDS, TWO_BROTHERS_TEMPERATURE, TWO_BROTHERS_TIMEOUT,",
    "  TWO_BROTHERS_RETRIES, TWO_BROTHERS_MODE, TWO_BROTHERS_SESSION_FILE,",
    "  TWO_BROTHERS_MAX_TOKENS, TWO_BROTHERS_MCP_CONFIG, TWO_BROTHERS_PLUGINS_DIR,",
    "  TWO_BROTHERS_SKILLS_DIR, TWO_BROTHERS_COMMANDS_DIR, TWO_BROTHERS_STREAM_TOKENS.",
    "",
    "Run 'two-brothers help <command>' for one command's flags and examples,",
    "or 'two-brothers help --all' for the full flag and environment reference.",
  );
  return lines.join("\n");
}

/**
 * The short usage block printed to stdout for an unknown command. The legacy
 * contract (`tests/cli.test.ts`) expects `two-brothers run "<task>"` on stdout
 * while the diagnostics belong on stderr — keep this brief instead of dumping
 * the whole help screen.
 */
export function renderBriefUsage(): string {
  return [
    "Two Brothers: a senior (arbiter) and a junior (advisor/executor).",
    "",
    "Usage:",
    '  two-brothers run "<task>" [flags]   one cooperation cycle: task -> decision',
    "",
    "Run 'two-brothers help' for the command list.",
  ].join("\n");
}

/** One environment variable and the flag it mirrors. */
export interface EnvironmentHelp {
  variable: string;
  flag: string;
  /** Optional extra note (`per-role`, `boolean`, ...). */
  note?: string;
}

/** `help --all` environment table. Keep in sync with `config.ts`/`docs`. */
export const ENVIRONMENT: readonly EnvironmentHelp[] = [
  { variable: "TWO_BROTHERS_PROVIDER", flag: "--provider" },
  { variable: "TWO_BROTHERS_BASE_URL", flag: "--base-url" },
  { variable: "TWO_BROTHERS_API_KEY", flag: "--api-key" },
  { variable: "TWO_BROTHERS_SENIOR_BASE_URL", flag: "--senior-base-url" },
  { variable: "TWO_BROTHERS_SENIOR_API_KEY", flag: "--senior-api-key" },
  { variable: "TWO_BROTHERS_JUNIOR_BASE_URL", flag: "--junior-base-url" },
  { variable: "TWO_BROTHERS_JUNIOR_API_KEY", flag: "--junior-api-key" },
  { variable: "TWO_BROTHERS_SENIOR_MODEL", flag: "--senior-model" },
  { variable: "TWO_BROTHERS_JUNIOR_MODEL", flag: "--junior-model" },
  { variable: "TWO_BROTHERS_PROVIDER_KIND", flag: "--provider-kind" },
  { variable: "TWO_BROTHERS_SENIOR_KIND", flag: "--senior-kind" },
  { variable: "TWO_BROTHERS_JUNIOR_KIND", flag: "--junior-kind" },
  { variable: "TWO_BROTHERS_SENIOR_SYSTEM", flag: "--senior-system" },
  { variable: "TWO_BROTHERS_JUNIOR_SYSTEM", flag: "--junior-system" },
  { variable: "TWO_BROTHERS_MAX_ROUNDS", flag: "--max-rounds" },
  { variable: "TWO_BROTHERS_TEMPERATURE", flag: "--temperature" },
  { variable: "TWO_BROTHERS_TIMEOUT", flag: "--timeout" },
  { variable: "TWO_BROTHERS_RETRIES", flag: "--retries" },
  { variable: "TWO_BROTHERS_MODE", flag: "--mode" },
  { variable: "TWO_BROTHERS_VERBOSE", flag: "--verbose", note: "boolean" },
  { variable: "TWO_BROTHERS_JSON", flag: "--json", note: "boolean" },
  { variable: "TWO_BROTHERS_SESSION_FILE", flag: "--session-file" },
  { variable: "TWO_BROTHERS_RESUME", flag: "--resume", note: "boolean" },
  { variable: "TWO_BROTHERS_COMPACT", flag: "--compact", note: "boolean" },
  { variable: "TWO_BROTHERS_COMPACT_THRESHOLD", flag: "--compact-threshold" },
  {
    variable: "TWO_BROTHERS_COMPACT_THRESHOLD_TOKENS",
    flag: "--compact-threshold-tokens",
  },
  { variable: "TWO_BROTHERS_CONTEXT_WINDOW", flag: "--context-window" },
  { variable: "TWO_BROTHERS_COMPACT_KEEP_RECENT", flag: "--compact-keep-recent" },
  { variable: "TWO_BROTHERS_MAX_TOKENS", flag: "--max-tokens" },
  {
    variable: "TWO_BROTHERS_SENIOR_MAX_TOKENS",
    flag: "--max-tokens",
    note: "per-role override",
  },
  {
    variable: "TWO_BROTHERS_JUNIOR_MAX_TOKENS",
    flag: "--max-tokens",
    note: "per-role override",
  },
  { variable: "TWO_BROTHERS_MCP_CONFIG", flag: "--mcp-config" },
  { variable: "TWO_BROTHERS_PLUGINS_DIR", flag: "--plugins-dir" },
  { variable: "TWO_BROTHERS_SKILLS_DIR", flag: "--skills-dir" },
  { variable: "TWO_BROTHERS_COMMANDS_DIR", flag: "--commands-dir" },
  { variable: "TWO_BROTHERS_STREAM_TOKENS", flag: "--stream-tokens", note: "boolean" },
  { variable: "TWO_BROTHERS_WORKERS", flag: "--workers", note: "serve" },
];

/**
 * `two-brothers help --all`: the complete command/flag/environment reference.
 * Every command's block, then the environment table and the return codes.
 */
export function renderFullHelp(): string {
  const lines: string[] = [
    "Two Brothers CLI — full reference.",
    "",
    "Global invocations:",
    "  two-brothers --version, -v        print the @two-brothers/harness version",
    "  two-brothers help [command]       this reference, one command, or the overview",
    "  two-brothers                      an interactive terminal opens the TUI;",
    "                                    piped stdin prints the overview",
    "",
  ];
  for (const name of COMMAND_ORDER) {
    const spec = COMMAND_TABLE[name];
    if (spec === undefined) continue;
    lines.push(`${spec.name} — ${spec.summary}`, "");
    lines.push(...commandHelpBody(spec).map((line) => (line ? `  ${line}` : "")));
    lines.push("");
  }
  lines.push("Environment variables (CLI flags win; env vars pin the value):");
  const variableWidth = Math.min(
    48,
    Math.max(2, ...ENVIRONMENT.map((entry) => entry.variable.length)),
  );
  for (const entry of ENVIRONMENT) {
    const note = entry.note ? `  (${entry.note})` : "";
    lines.push(`  ${entry.variable.padEnd(variableWidth)}  ${entry.flag}${note}`);
  }
  lines.push(
    "",
    "Return codes:",
    "  0  success (including doctor with no failing check)",
    "  1  run error (the errors array is non-empty in --mode json) / selftest FAIL /",
    "     doctor found a failing check",
    "  2  usage error: unknown command or option, missing task, shell or argument",
    "",
  );
  return lines.join("\n");
}

// --------------------------------------------------------------------------- //
// suggestions
// --------------------------------------------------------------------------- //

/** Levenshtein edit distance (no transposition shortcut: distance ≤ 2 is the
 * documented command-suggestion threshold). */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + cost,
      );
    }
    previous = current;
  }
  return previous[b.length];
}

/**
 * Did-you-mean suggestion for an unknown command: the closest known command
 * within edit distance 2 (ties keep the first command in display order), or
 * `null`.
 */
export function suggestCommand(unknown: string): string | null {
  const target = unknown.trim().toLowerCase();
  if (!target) return null;
  let best: { name: string; distance: number } | null = null;
  for (const name of COMMAND_ORDER) {
    const distance = editDistance(target, name);
    if (distance > 2) continue;
    if (best === null || distance < best.distance) best = { name, distance };
  }
  return best?.name ?? null;
}

/**
 * Nearest-flag suggestion for an unknown option. Compares the bare names
 * (leading dashes stripped), accepts a transposition/typo within edit
 * distance 2, and treats a prefix of a known flag as a near match (so
 * `--prov` suggests `--provider`).
 */
export function suggestFlag(unknown: string, candidates: readonly string[]): string | null {
  const target = unknown.replace(/^-+/, "").toLowerCase();
  if (!target) return null;
  let best: { flag: string; distance: number } | null = null;
  for (const candidate of candidates) {
    const name = candidate.replace(/^-+/, "").toLowerCase();
    if (!name) continue;
    let distance = editDistance(target, name);
    const prefix = name.startsWith(target) || target.startsWith(name);
    if (prefix && Math.min(name.length, target.length) >= 2) distance = Math.min(distance, 1);
    if (distance > 2) continue;
    if (best === null || distance < best.distance || (distance === best.distance && candidate < best.flag)) {
      best = { flag: candidate, distance };
    }
  }
  return best?.flag ?? null;
}

/** Every flag name a command's `parseArgs` accepts, as `--flag` strings (plus
 * short aliases), for unknown-option suggestions and shell completions. */
export function flagCandidatesForCommand(commandName: string): string[] {
  const spec = COMMAND_TABLE[commandName];
  const names = new Set<string>(spec?.acceptedFlags ?? spec?.flags ?? []);
  // Every command accepts `--help` / `-h`, even when its displayed flag list
  // is a subset of the shared table (run/chat/tui/serve declare shared
  // `acceptedFlags` without repeating `help`).
  names.add("help");
  const out: string[] = [];
  for (const name of names) {
    const flag = FLAGS[name];
    out.push(`--${name}`);
    for (const alias of flag?.aliases ?? []) out.push(`-${alias}`);
  }
  return out;
}

/** All long flag names known to the CLI (`--flag` form), sorted. */
export function allFlagNames(): string[] {
  return Object.keys(FLAGS)
    .sort()
    .map((name) => `--${name}`);
}
