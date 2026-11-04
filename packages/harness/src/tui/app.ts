/**
 * The interactive TUI's state machine and harness glue.
 *
 * Layering: `render.ts` is pure presentation, `terminal.ts` is the only
 * module that touches a real terminal, and this module owns everything in
 * between — input actions, the line buffer, one harness run per turn, and the
 * graceful teardown. The stream-event reducer (`reduceStreamEvent`) and the
 * input resolver (`resolveTuiInput`) are pure exports so the interactive
 * behavior is testable without a TTY.
 *
 * The harness construction mirrors `cli.ts`'s chat path: the same resolved
 * `Config`, one shared `SharedContext` (with the same `--session-file` /
 * `--resume` semantics), the same plugin bindings, the same MCP
 * config-plus-plugin merge, and the same hook/skill/compaction wiring.
 * Plugins are re-bound per turn exactly like the chat REPL; skills and slash
 * commands are discovered once per session.
 */
import * as path from "node:path";

import { discoverCommands, expandCommand, matchCommand, type CommandCatalog } from "../commands.ts";
import type { CompactionSettings } from "../compaction.ts";
import { validateRunConfig, type Config } from "../config.ts";
import { SharedContext } from "../context.ts";
import { TwoBrothersHarness, type ToolScopes } from "../harness.ts";
import {
  loadMcpToolSpecs,
  loadMcpTools,
  mergeMcpConfig,
  type McpConfigFileShape,
  type McpToolSet,
} from "../mcp.ts";
import { PluginManager, type PluginBindings } from "../plugins.ts";
import type { Message } from "../protocol.ts";
import type { RoleEndpoint } from "../runtime.ts";
import type { StreamEvent } from "../runstream.ts";
import { restoreContext, SessionError, SessionStore } from "../session.ts";
import { discoverSkills, type SkillCatalog } from "../skills.ts";
import type { Tool } from "../provider.ts";

import {
  renderFrame,
  type TuiLine,
  type TuiLineKind,
  type TuiState,
} from "./render.ts";
import { createTerminal, isTtyOk, TuiTerminalError, type Key, type Terminal } from "./terminal.ts";

/** Minimal output sink, the same shape `CliIO` has. */
export interface TuiIO {
  log(line: string): void;
  error(line: string): void;
}

/** Resolved resources a TUI session discovers once. */
export interface TuiResources {
  /** Null when plugin discovery itself failed (fail-soft). */
  plugins: PluginManager | null;
  skills: SkillCatalog;
  commands: CommandCatalog;
}

/** Options for the TUI entry point (`cli.ts tui` builds these). */
export interface TuiAppOptions {
  cfg: Config;
  io: TuiIO;
  /** `--plugins-dir` resolved path; default `PluginManager` behavior when omitted. */
  pluginsDir?: string;
  skillsRoots?: string[];
  commandsRoots?: string[];
  /** `--mcp-config` file path. */
  mcpConfig?: string;
  /** `--stream-tokens`: append provider text deltas in place while a turn runs. */
  streamTokens?: boolean;
  /** `tui "<task>"`: run this task as soon as the screen opens. */
  initialTask?: string;
  /** Injection seams for tests/embedding; default to the process streams. */
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
}

// --------------------------------------------------------------------------- //
// pure line-buffer reducer (tested without a terminal)
// --------------------------------------------------------------------------- //

/** Chat lines plus the index token deltas currently append to. */
export interface TuiLineBuffer {
  lines: TuiLine[];
  /** Index into `lines` of the draft reply, or null between replies. */
  pending: number | null;
}

/** An empty buffer, optionally seeded with lines (welcome text). */
export function createLineBuffer(lines: TuiLine[] = []): TuiLineBuffer {
  return { lines: [...lines], pending: null };
}

/** Immutable push; the pending token draft keeps its index. */
export function pushLineToBuffer(buffer: TuiLineBuffer, line: TuiLine): TuiLineBuffer {
  return { lines: [...buffer.lines, line], pending: buffer.pending };
}

/** Option for the reducer: the per-line character cap for streamed text. */
export interface ReduceOptions {
  /** Payload/token text is clipped to this many chars (default 2000). */
  maxTextChars?: number;
}

/** Result of folding one stream event into the buffer. */
export interface ReduceResult {
  buffer: TuiLineBuffer;
  /** New status-bar text when the event implies one. */
  status?: string;
}

function clipText(text: string, maxChars: number): string {
  if (maxChars <= 0 || text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}… (+${text.length - maxChars} chars)`;
}

function textField(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  return value === undefined || value === null ? "" : String(value);
}

function optionalLine(label: string, value: string): string {
  return value.trim() === "" ? "" : `${label}: ${value}`;
}

function joinSections(sections: string[]): string {
  return sections.filter((section) => section.trim() !== "").join("\n");
}

/**
 * Project one protocol envelope onto a chat line. The payload is rendered as
 * readable text (never raw JSON unless the kind is unknown); the caller
 * clips the result to `maxChars`.
 */
export function envelopeToLine(message: Message, maxChars = 2000): TuiLine {
  const payload = message.payload ?? {};
  const kind: TuiLineKind =
    message.from === "user" ? "user" : message.from === "junior" ? "junior" : "senior";
  let text: string;
  if (message.from === "user") {
    text = textField(payload, "text");
  } else {
    switch (message.kind) {
      case "message":
        text = textField(payload, "text") || JSON.stringify(payload);
        break;
      case "consult":
        text = joinSections([
          `consult: ${textField(payload, "ask")}`,
          optionalLine("expect", textField(payload, "expect")),
        ]);
        break;
      case "proposal":
        text = joinSections([
          `proposal: ${textField(payload, "title")}`,
          textField(payload, "answer"),
          optionalLine("rationale", textField(payload, "rationale")),
          optionalLine("confidence", textField(payload, "confidence")),
        ]);
        break;
      case "delegation":
        text = joinSections([
          `delegation: ${textField(payload, "work")}`,
          msgList(payload.acceptance, "acceptance"),
        ]);
        break;
      case "deliverable":
        text = joinSections([
          `deliverable: ${textField(payload, "result")}`,
          optionalLine("confidence", textField(payload, "confidence")),
        ]);
        break;
      case "review":
        text = joinSections([
          `review: ${textField(payload, "verdict")}`,
          textField(payload, "notes"),
        ]);
        break;
      case "decision":
        text = joinSections([
          `decision: ${textField(payload, "decision")}`,
          optionalLine("rationale", textField(payload, "rationale")),
          optionalLine("confidence", textField(payload, "confidence")),
          optionalLine("dissent", textField(payload, "dissent")),
        ]);
        break;
      default:
        text = `${message.kind}: ${JSON.stringify(payload)}`;
    }
  }
  return { kind, text: clipText(text, maxChars) };
}

function msgList(value: unknown, label: string): string {
  if (!Array.isArray(value) || value.length === 0) return "";
  return joinSections([`${label}:`, ...value.map((item) => `  - ${String(item)}`)]);
}

/**
 * Fold one in-process stream event into the chat buffer. Pure: the input
 * buffer is never mutated, so tests can assert both the new state and the
 * old one.
 *
 * Token events append to a draft line; the next envelope replaces that draft
 * in place (so token streaming never duplicates the committed reply), and
 * tool events can interleave without breaking the draft's index.
 */
export function reduceStreamEvent(
  buffer: TuiLineBuffer,
  event: StreamEvent,
  options: ReduceOptions = {},
): ReduceResult {
  const maxChars = options.maxTextChars ?? 2000;
  const lines = buffer.lines;
  switch (event.type) {
    case "token": {
      const kind: TuiLineKind = event.role === "junior" ? "junior" : "senior";
      const index = buffer.pending;
      if (index !== null && index >= 0 && index < lines.length && lines[index].kind === kind) {
        const updated = lines.slice();
        updated[index] = { kind, text: clipText(lines[index].text + event.delta, maxChars) };
        return { buffer: { lines: updated, pending: index } };
      }
      const draft: TuiLine = { kind, text: clipText(event.delta, maxChars) };
      return { buffer: { lines: [...lines, draft], pending: lines.length } };
    }
    case "envelope": {
      const line = envelopeToLine(event.envelope, maxChars);
      const index = buffer.pending;
      if (index !== null && index >= 0 && index < lines.length && lines[index].kind === line.kind) {
        const updated = lines.slice();
        updated[index] = line;
        return { buffer: { lines: updated, pending: null } };
      }
      return { buffer: { lines: [...lines, line], pending: null } };
    }
    case "tool_call":
      return {
        buffer: pushLineToBuffer(buffer, {
          kind: "tool",
          text: `call ${event.role}: ${event.tool}`,
        }),
      };
    case "tool_result":
      return {
        buffer: pushLineToBuffer(buffer, {
          kind: "tool",
          text: `result ${event.role}: ${event.tool} — ${event.status}`,
        }),
      };
    case "repair":
      return {
        buffer: pushLineToBuffer(buffer, {
          kind: "system",
          text: `repair: ${event.role} ${event.kind} reply re-asked (strict payload check)`,
        }),
      };
    case "run_status": {
      const status =
        event.status === "started"
          ? "running…"
          : event.status === "completed"
            ? "ready — turn completed"
            : event.status === "cancelled"
              ? "turn cancelled"
              : "turn failed — the session is still open";
      return { buffer: { lines, pending: buffer.pending }, status };
    }
    case "result": {
      const usage = event.result.usage ?? {};
      const input = Number(usage.input_tokens ?? 0) || 0;
      const output = Number(usage.output_tokens ?? 0) || 0;
      return {
        buffer: { lines, pending: null },
        status: `ready — ${input}/${output} tokens (in/out)`,
      };
    }
    default:
      return { buffer };
  }
}

// --------------------------------------------------------------------------- //
// pure input resolver
// --------------------------------------------------------------------------- //

/** What one submitted input line means for the app. */
export type TuiAction =
  | { type: "none" }
  | { type: "run"; task: string; mode?: "consult" | "work" }
  | { type: "lines"; lines: TuiLine[]; status?: string }
  | { type: "mode"; mode: "consult" | "work" }
  | { type: "exit" };

const MODES: ReadonlySet<string> = new Set(["consult", "work"]);

function commandLines(commands: CommandCatalog): TuiLine[] {
  if (commands.commands.length === 0) {
    return [
      {
        kind: "system",
        text: "no slash commands discovered: add <name>.md to a commands directory",
      },
    ];
  }
  return commands.commands.map((command) => ({
    kind: "system" as const,
    text:
      `/${command.name} — ${command.description}` +
      (command.argumentHint ? ` (${command.argumentHint})` : ""),
  }));
}

function helpLines(commands: CommandCatalog): TuiLine[] {
  return [
    { kind: "system", text: "tui commands:" },
    { kind: "system", text: "  /help      this list" },
    { kind: "system", text: "  /commands  list discovered slash commands" },
    { kind: "system", text: "  /mode consult|work  switch the cooperation mode" },
    { kind: "system", text: "  /exit      leave (Ctrl+C or Esc twice also quits)" },
    { kind: "system", text: "slash commands:" },
    ...commandLines(commands),
    { kind: "system", text: "anything else is sent to the brothers as a task" },
  ];
}

/**
 * Interpret one submitted input line. Builtins (`/help`, `/commands`,
 * `/mode`, `/exit`) are local actions; a discovered slash command expands to
 * a task (its frontmatter `mode`, when set, applies to that turn only); an
 * unknown slash name becomes an error line and is never submitted.
 */
export function resolveTuiInput(input: string, commands: CommandCatalog): TuiAction {
  const trimmed = input.trim();
  if (trimmed === "") return { type: "none" };
  const lower = trimmed.toLowerCase();
  if (lower === "/exit" || lower === "/quit" || lower === "/q") return { type: "exit" };
  if (lower === "/help" || lower === "/h") {
    return { type: "lines", lines: helpLines(commands) };
  }
  if (lower === "/commands") {
    return { type: "lines", lines: commandLines(commands) };
  }
  const matched = matchCommand(trimmed);
  if (matched !== null && (matched.name === "mode" || matched.name === "modes")) {
    const requested = matched.args.trim().toLowerCase();
    if (!MODES.has(requested)) {
      return {
        type: "lines",
        lines: [{ kind: "error", text: "usage: /mode consult|work" }],
      };
    }
    return { type: "mode", mode: requested as "consult" | "work" };
  }
  if (matched !== null) {
    const found = commands.commands.find((command) => command.name === matched.name);
    if (found === undefined) {
      return {
        type: "lines",
        lines: [
          {
            kind: "error",
            text: `unknown command: ${matched.name} (type /commands to list available commands)`,
          },
        ],
      };
    }
    const task = expandCommand(found, matched.args);
    return found.mode === undefined
      ? { type: "run", task }
      : { type: "run", task, mode: found.mode };
  }
  return { type: "run", task: trimmed };
}

// --------------------------------------------------------------------------- //
// session construction (same shape as cli.ts's chat path)
// --------------------------------------------------------------------------- //

/** Discover plugins, skills and slash commands once per TUI session. */
export async function loadTuiResources(options: {
  cfg: Config;
  io: TuiIO;
  pluginsDir?: string;
  skillsRoots?: string[];
  commandsRoots?: string[];
}): Promise<TuiResources> {
  const skills = discoverSkills(options.skillsRoots ?? []);
  const commands = discoverCommands(options.commandsRoots ?? []);
  let plugins: PluginManager | null = null;
  try {
    plugins =
      options.pluginsDir === undefined
        ? await PluginManager.create()
        : await PluginManager.create(options.pluginsDir);
  } catch (exc) {
    if (options.cfg.verbose) {
      options.io.error(
        `[plugin] cannot load ${options.pluginsDir ?? "(default)"}: ${messageOf(exc)}`,
      );
    }
  }
  if (options.cfg.verbose) {
    for (const entry of plugins?.errors ?? []) {
      options.io.error(`[plugin] ${entry.plugin}: ${entry.error}`);
    }
    for (const entry of plugins?.diagnostics ?? []) {
      options.io.error(`[plugin] ${entry.plugin}: ${entry.message}`);
    }
    for (const line of skills.diagnostics) options.io.error(`[skills] ${line}`);
    for (const line of commands.diagnostics) options.io.error(`[commands] ${line}`);
  }
  return { plugins, skills, commands };
}

/**
 * Open the shared context with the chat REPL's semantics: no session file =
 * in memory; an existing file without `--resume` is an error; `--resume`
 * restores (or warns and starts fresh when the file is gone).
 */
export function openTuiContext(cfg: Config, io: TuiIO): SharedContext {
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

/** Per-role endpoints, so role caps and wire kinds apply as in the CLI. */
function tuiEndpoints(cfg: Config): { senior: RoleEndpoint; junior: RoleEndpoint } {
  return {
    senior: {
      provider: cfg.provider,
      baseUrl: cfg.seniorBaseUrl || cfg.baseUrl,
      apiKey: cfg.seniorApiKey || cfg.apiKey,
      model: cfg.seniorModel,
    },
    junior: {
      provider: cfg.provider,
      baseUrl: cfg.juniorBaseUrl || cfg.baseUrl,
      apiKey: cfg.juniorApiKey || cfg.apiKey,
      model: cfg.juniorModel,
    },
  };
}

/** Compaction settings from the resolved config (same flags as `run`). */
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

/** Fold plugin scope buckets into the MCP-derived `toolScopes` registry. */
function mergeScopes(scopes: ToolScopes, bindings: PluginBindings): ToolScopes {
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

interface TurnSetup {
  cfg: Config;
  mode: Config["mode"];
  resources: TuiResources;
  mcpConfig?: string;
  streamTokens?: boolean;
  onStreamEvent: (event: StreamEvent) => void;
  onWarning: (line: string) => void;
}

interface TurnHarness {
  harness: TwoBrothersHarness;
  mcp: McpToolSet | null;
}

/** Build the harness for one turn (the chat REPL's per-turn construction). */
async function buildTurnHarness(setup: TurnSetup): Promise<TurnHarness> {
  const cfg: Config = setup.mode === setup.cfg.mode ? setup.cfg : { ...setup.cfg, mode: setup.mode };
  const endpoints = tuiEndpoints(cfg);
  validateRunConfig(cfg, endpoints);

  let bindings: PluginBindings | null = null;
  if (setup.resources.plugins !== null) {
    try {
      bindings = await setup.resources.plugins.bindingsFor(
        [...setup.resources.plugins.plugins.keys()],
        null,
      );
      if (cfg.verbose) {
        for (const entry of bindings.diagnostics) {
          setup.onWarning(`[plugin] ${entry.plugin}: ${entry.message}`);
        }
      }
    } catch (exc) {
      setup.onWarning(`plugins: ${messageOf(exc)}`);
    }
  }

  let mcp: McpToolSet | null = null;
  let toolScopes: ToolScopes = {};
  const pluginServers = bindings?.mcpServers ?? [];
  if (setup.mcpConfig !== undefined || pluginServers.length > 0) {
    let base: McpConfigFileShape | null = null;
    if (setup.mcpConfig !== undefined) {
      try {
        base = { mcpServers: loadMcpToolSpecs(setup.mcpConfig) };
      } catch (exc) {
        setup.onWarning(`MCP: ${messageOf(exc)}`);
      }
    }
    const merged = mergeMcpConfig(base, pluginServers);
    for (const line of merged.diagnostics) setup.onWarning(line);
    try {
      mcp = await loadMcpTools(merged.config);
      toolScopes = {
        shared: mcp.sharedTools,
        senior: mcp.seniorTools,
        junior: mcp.juniorTools,
      };
    } catch (exc) {
      setup.onWarning(`MCP: ${messageOf(exc)}`);
    }
  }
  if (bindings !== null) toolScopes = mergeScopes(toolScopes, bindings);
  const hasScopes = Object.values(toolScopes).some((list) => list !== undefined);
  const compaction = compactionOptions(cfg);
  const harness = new TwoBrothersHarness(cfg, {
    ...(hasScopes ? { toolScopes } : {}),
    endpoints,
    ...(compaction ? { compaction } : {}),
    ...(bindings !== null ? { hooks: bindings.hooks } : {}),
    ...(setup.resources.skills.skills.length > 0 ? { skills: setup.resources.skills } : {}),
    onStreamEvent: setup.onStreamEvent,
    ...(setup.streamTokens === true ? { streamTokens: true } : {}),
    onProviderWarning: setup.onWarning,
  });
  return { harness, mcp };
}

function messageOf(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

// --------------------------------------------------------------------------- //
// interactive app
// --------------------------------------------------------------------------- //

const QUIT_HINT = "quit? press Ctrl+C or Esc again to exit (any other key cancels)";
const READY_HINT = "ready — Enter sends · /help commands · PgUp/PgDn scroll · Ctrl+C quits";

/** Printable single characters only (paste/escape sequences are ignored). */
export function printableChar(key: Key): string | null {
  if (key.ctrl) return null;
  if (key.raw.length !== 1) return null;
  const code = key.raw.codePointAt(0) ?? 0;
  return code >= 0x20 && code !== 0x7f ? key.raw : null;
}

/**
 * Run the TUI. Returns a process exit code: 0 after a clean quit, 2 for a
 * non-TTY stdin/stdout (the hermetic-CI guard), 1 for a startup failure
 * (session/config). Turn errors are shown in the UI and never end the loop.
 */
export async function runTuiApp(options: TuiAppOptions): Promise<number> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  if (!isTtyOk(input) || !isTtyOk(output)) {
    options.io.error(
      "Error: tui needs an interactive terminal — stdin/stdout are not TTYs. " +
        "Use `two-brothers chat` for piped or redirected sessions.",
    );
    return 2;
  }

  let context: SharedContext;
  try {
    context = openTuiContext(options.cfg, options.io);
  } catch (exc) {
    if (exc instanceof SessionError) {
      options.io.error(`[error] ${exc.message}`);
      return 1;
    }
    throw exc;
  }

  const resources = await loadTuiResources({
    cfg: options.cfg,
    io: options.io,
    ...(options.pluginsDir !== undefined ? { pluginsDir: options.pluginsDir } : {}),
    ...(options.skillsRoots !== undefined ? { skillsRoots: options.skillsRoots } : {}),
    ...(options.commandsRoots !== undefined ? { commandsRoots: options.commandsRoots } : {}),
  });

  let terminal: Terminal;
  try {
    terminal = createTerminal(input, output);
  } catch (exc) {
    if (exc instanceof TuiTerminalError) {
      options.io.error(`Error: ${exc.message}`);
      return 2;
    }
    throw exc;
  }

  const cfg = options.cfg;
  let mode: Config["mode"] = cfg.mode;
  const sessionName = cfg.sessionFile ? path.basename(cfg.sessionFile) : "in-memory";
  let buffer = createLineBuffer([
    {
      kind: "system",
      text: "Two Brothers TUI. Type a task and press Enter; /help lists commands.",
    },
    {
      kind: "system",
      text:
        `senior model=${cfg.seniorModel || "(unset)"} | ` +
        `junior model=${cfg.juniorModel || "(unset)"} | provider=${cfg.provider}`,
    },
  ]);
  const state: TuiState = {
    header: {
      mode,
      seniorModel: cfg.seniorModel,
      juniorModel: cfg.juniorModel,
      sessionName,
    },
    lines: buffer.lines,
    input: "",
    status: READY_HINT,
    scrollOffset: 0,
    height: 24,
    width: 80,
  };
  let confirmQuit = false;
  let lastStreamRender = 0;

  const render = (): void => {
    const size = terminal.size();
    state.width = size.columns;
    state.height = size.rows;
    state.lines = buffer.lines;
    terminal.render(renderFrame(state));
  };

  const pushLocal = (line: TuiLine): void => {
    buffer = pushLineToBuffer(buffer, line);
  };

  const executeTurn = async (task: string, turnMode: Config["mode"]): Promise<void> => {
    buffer = { lines: [...buffer.lines, { kind: "user", text: task }], pending: null };
    state.scrollOffset = 0;
    state.status = `running (${turnMode})…`;
    render();
    const onStreamEvent = (event: StreamEvent): void => {
      // The harness echoes the submitted task as a user envelope; the app
      // already owns that line, so skip only that exact duplicate.
      if (
        event.type === "envelope" &&
        event.envelope.from === "user" &&
        event.envelope.kind === "message" &&
        String(event.envelope.payload?.text ?? "") === task
      ) {
        return;
      }
      const reduced = reduceStreamEvent(buffer, event);
      buffer = reduced.buffer;
      if (reduced.status !== undefined) state.status = reduced.status;
      state.lines = buffer.lines;
      const now = Date.now();
      if (event.type !== "token" || now - lastStreamRender >= 40) {
        lastStreamRender = now;
        render();
      }
    };
    const onWarning = (line: string): void => {
      pushLocal({ kind: "system", text: line });
    };
    try {
      const { harness, mcp } = await buildTurnHarness({
        cfg,
        mode: turnMode,
        resources,
        ...(options.mcpConfig !== undefined ? { mcpConfig: options.mcpConfig } : {}),
        ...(options.streamTokens === true ? { streamTokens: true } : {}),
        onStreamEvent,
        onWarning,
      });
      try {
        const result = await harness.run(task, context);
        for (const warning of result.warnings) pushLocal({ kind: "system", text: `warn: ${warning}` });
        for (const error of result.errors) pushLocal({ kind: "error", text: error });
        for (const audit of result.promptAudits) {
          if (cfg.verbose) {
            pushLocal({
              kind: "system",
              text:
                `audit ${audit.role} ${audit.kind}: ${audit.sections.join(" > ")}; ` +
                `tools: ${audit.tools.length > 0 ? audit.tools.join(", ") : "(none)"}`,
            });
          }
        }
        if (result.errors.length > 0) state.status = "ready — turn completed with errors";
      } finally {
        await mcp?.client.close();
      }
    } catch (exc) {
      pushLocal({ kind: "error", text: messageOf(exc) });
      state.status = "turn failed — the session is still open";
    }
    state.lines = buffer.lines;
    render();
  };

  const submit = async (): Promise<void> => {
    const raw = state.input;
    state.input = "";
    const action = resolveTuiInput(raw, resources.commands);
    switch (action.type) {
      case "none":
        break;
      case "exit":
        throw new TuiExit();
      case "lines":
        for (const line of action.lines) pushLocal(line);
        if (action.status !== undefined) state.status = action.status;
        break;
      case "mode":
        mode = action.mode;
        state.header.mode = mode;
        state.status = `mode: ${mode} — the next turn uses it`;
        break;
      case "run":
        await executeTurn(action.task, action.mode ?? mode);
        break;
    }
  };

  try {
    terminal.enter();
    render();
    if (options.initialTask !== undefined && options.initialTask.trim() !== "") {
      await executeTurn(options.initialTask.trim(), mode);
    }
    for (;;) {
      render();
      const key = await terminal.readKey();
      if (key.ctrl && (key.name === "c" || key.raw === "\u0003")) {
        if (confirmQuit) break;
        confirmQuit = true;
        state.status = QUIT_HINT;
        continue;
      }
      if (key.name === "escape") {
        if (confirmQuit) break;
        confirmQuit = true;
        state.status = QUIT_HINT;
        continue;
      }
      const page = Math.max(1, terminal.size().rows - 7);
      if (key.name === "pageup") {
        state.scrollOffset += page;
        confirmQuit = false;
        continue;
      }
      if (key.name === "pagedown") {
        state.scrollOffset = Math.max(0, state.scrollOffset - page);
        confirmQuit = false;
        continue;
      }
      if (key.name === "return" || key.name === "enter") {
        confirmQuit = false;
        try {
          await submit();
        } catch (exc) {
          if (exc instanceof TuiExit) break;
          throw exc;
        }
        continue;
      }
      if (key.name === "backspace" || key.raw === "\u007f" || key.raw === "\b") {
        state.input = state.input.slice(0, -1);
        confirmQuit = false;
        continue;
      }
      const char = printableChar(key);
      if (char !== null) {
        state.input += char;
        confirmQuit = false;
        continue;
      }
      confirmQuit = false;
    }
    return 0;
  } finally {
    terminal.restore();
  }
}

/** Internal control-flow signal for `/exit` handed out of `submit`. */
class TuiExit extends Error {
  constructor() {
    super("tui exit");
    this.name = "TuiExit";
  }
}