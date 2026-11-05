/**
 * The interactive TUI's state machine and harness glue.
 *
 * Layering: `render.ts` is the legacy pure line renderer (kept as a test
 * seam), the block model lives in `model.ts`, the views in `view/`, and
 * `terminal.ts` is the only module that touches a real terminal. This module
 * owns everything in between — the grapheme-aware editor, the block
 * transcript, overlays (palette/help/history search/pickers/dialogs), one
 * non-blocking harness run per turn with `AbortController` cancellation, and
 * the graceful teardown. The stream-event reducer (`reduceStreamEvent`) and the
 * input resolver (`resolveTuiInput`) stay exported as pure functions so the
 * interactive behavior is testable without a TTY.
 *
 * The harness construction mirrors `cli.ts`'s chat path: the same resolved
 * `Config`, one shared `SharedContext` (with the same `--session-file` /
 * `--resume` semantics), the same plugin bindings, the same MCP
 * config-plus-plugin merge, and the same hook/skill/compaction wiring.
 * Plugins are re-bound per turn exactly like the chat REPL; skills and slash
 * commands are discovered once per session.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { discoverCommands, expandCommand, matchCommand, type Command, type CommandCatalog } from "../commands.ts";
import type { CompactionSettings } from "../compaction.ts";
import { estimateTokens } from "../compaction.ts";
import { validateRunConfig, type Config } from "../config.ts";
import { estimateCost } from "../cost.ts";
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
import { mergeSeedPresets } from "../presets.ts";
import type { Message } from "../protocol.ts";
import type { RoleEndpoint } from "../runtime.ts";
import type { StreamEvent } from "../runstream.ts";
import { restoreContext, SessionError, SessionStore } from "../session.ts";
import { envPinnedPairs } from "../settings_store.ts";
import { discoverSkills, type SkillCatalog } from "../skills.ts";
import type { Tool } from "../provider.ts";

import {
  clearEditor,
  createEditor,
  handleEditorKey,
  insertText,
  pasteText,
  recordHistory,
  setEditorText,
  takeSubmission,
  type EditorOptions,
  type EditorState,
} from "./editor.ts";
import {
  appendHistory,
  defaultTuiHistoryPath,
  loadHistory,
  saveHistory,
  TUI_HISTORY_FILE_ENV,
} from "./historystore.ts";
import {
  findSlashCommand,
  isCommandEnabled,
  paletteEntries,
  resolveKey,
  TUI_COMMANDS,
  type KeyLike,
  type PaletteEntry,
  type SlashCommandInfo,
  type TuiCommand,
} from "./keymap.ts";
import {
  addNotice,
  addUserBlock,
  createTuiModel,
  reduceModelEvent,
  type TuiModel,
} from "./model.ts";
import {
  newestToolBlock,
  toggleNewestToolExpansion,
  withToolExpansion,
  type ToolExpansionKeys,
} from "./transcript.ts";
import {
  type TuiLine,
  type TuiLineKind,
} from "./render.ts";
import { renderBox } from "./screen.ts";
import { resolveTheme, type Theme, type ThemeMode } from "./theme.ts";
import { createDialog, dialogView, handleDialogKey, type DialogState } from "./view/dialog.ts";
import {
  createHelpState,
  handleHelpKey,
  helpEntries,
  helpView,
  type HelpState,
} from "./view/help.ts";
import {
  historySearchView,
  openHistorySearch,
  searchHistoryKey,
  type HistorySearchState,
} from "./view/historysearch.ts";
import {
  createPaletteState,
  handlePaletteKey,
  paletteView,
  type PaletteState,
} from "./view/palette.ts";
import {
  createPickerState,
  handlePickerKey,
  pickerView,
  type PickerItem,
  type PickerState,
} from "./view/picker.ts";
import { screenView } from "./view/screen.ts";
import type { StatusBarState } from "./view/statusbar.ts";
import type { Toast, ToastLevel } from "./view/toast.ts";
import {
  latestTranscriptScroll,
  scrollTranscript,
  type TranscriptScroll,
} from "./view/transcript.ts";
import {
  createTerminal,
  guardTtyResizeRefresh,
  isTtyOk,
  TuiTerminalError,
  type Key,
  type Terminal,
} from "./terminal.ts";

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
  /** Working directory shown in the welcome screen and status bar. */
  cwd?: string;
  /** Directory the session picker scans for `.jsonl` sessions. */
  sessionsDir?: string;
  /**
   * Prompt-history JSON path. Defaults to `TWO_BROTHERS_TUI_HISTORY_FILE` or
   * `~/.two-brothers/tui-history.json`. Callers injecting `input`/`output`
   * (tests, embedding) must pass a path or the env override to persist, so an
   * embedded app never writes the host's home directory unasked.
   */
  historyFile?: string;
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
  signal?: AbortSignal;
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
    ...(setup.signal !== undefined ? { signal: setup.signal } : {}),
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

/**
 * One modal surface over the transcript. Only one overlay is open at a time;
 * Escape always closes it and restores the composer focus. Palette and help
 * share the registry-derived entries; pickers and dialogs carry callbacks
 * into the app, so no overlay module knows about the harness.
 */
type Overlay =
  | { kind: "palette"; state: PaletteState }
  | { kind: "help"; state: HelpState }
  | { kind: "history-search"; state: HistorySearchState }
  | {
      kind: "picker";
      title: string;
      items: PickerItem[];
      state: PickerState;
      emptyText?: string;
      onAccept: (item: PickerItem) => void;
    }
  | { kind: "dialog"; state: DialogState; onAction: (id: string) => void };

interface UsageSnapshot {
  input: number;
  output: number;
  cached: number;
  calls: number;
}

const SPINNER_MS = 120;
const TOKEN_RENDER_MS = 40;

/** Status-bar text while a quit chord is armed (reset verbatim on disarm). */
const QUIT_ARMED_ACTIVITY = "quit? press Ctrl+C or Esc again to exit (any other key cancels)";

/** Internal control-flow signal for quit handed out of the key loop. */
class TuiExit extends Error {
  constructor() {
    super("tui exit");
    this.name = "TuiExit";
  }
}

/** Printable single characters only (paste/escape sequences are ignored). */
export function printableChar(key: Key): string | null {
  if (key.ctrl) return null;
  if (key.raw.length !== 1) return null;
  const code = key.raw.codePointAt(0) ?? 0;
  return code >= 0x20 && code !== 0x7f ? key.raw : null;
}

/** One-slot draft stash: the stashed text, or null when the slot is empty. */
export type DraftStash = string | null;

/** What one stash-key press did. */
export type DraftStashOutcome = "stashed" | "restored" | "empty";

/** Pure result of folding the stash key into the composer and slot. */
export interface DraftStashResult {
  editor: EditorState;
  stash: DraftStash;
  outcome: DraftStashOutcome;
}

/**
 * Fold one stash-key press into the composer.
 *
 * A non-blank draft moves into the single stash slot and the composer clears;
 * an empty composer restores the stashed draft (and empties the slot); with
 * both empty nothing changes, so the caller can show an honest no-op toast.
 * Whitespace-only text counts as empty in both directions.
 */
export function toggleDraftStash(
  editor: EditorState,
  stash: DraftStash,
  options: EditorOptions = {},
): DraftStashResult {
  if (editor.text.trim() !== "") {
    return { editor: clearEditor(editor), stash: editor.text, outcome: "stashed" };
  }
  if (stash !== null && stash.trim() !== "") {
    return {
      editor: setEditorText(clearEditor(editor), stash, options),
      stash: null,
      outcome: "restored",
    };
  }
  return { editor, stash, outcome: "empty" };
}

/**
 * Seed an editor's history from persisted entries, oldest first. The editor's
 * own 100-entry cap and consecutive-dedupe rules apply, so a long history
 * never exceeds the recall depth the composer expects.
 */
export function seedEditorHistory(
  editor: EditorState,
  entries: readonly string[],
  options: EditorOptions = {},
): EditorState {
  let state = editor;
  for (const entry of entries) state = recordHistory(state, entry, options);
  return state;
}

function usageOf(value: unknown): UsageSnapshot {  const record = (value ?? {}) as Record<string, unknown>;
  const num = (key: string): number => {
    const n = Number(record[key]);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  };
  return {
    input: num("input_tokens"),
    output: num("output_tokens"),
    cached: num("cached_tokens"),
    calls: num("model_calls"),
  };
}

/**
 * Run the TUI. Returns a process exit code: 0 after a clean quit, 2 for a
 * non-TTY stdin/stdout (the hermetic-CI guard), 1 for a startup failure
 * (session/config). Turn errors are shown in the UI and never end the loop.
 *
 * The loop never awaits a model turn: `executeTurn` starts the harness run
 * and returns immediately, so typing, scrolling, overlays and cancellation
 * stay responsive while the brothers work. The turn's `AbortController` is
 * driven by Escape/Ctrl+C under a safe precedence: overlay close → turn
 * cancel → composer clear → quit confirm (never an unexpected quit).
 */
export async function runTuiApp(options: TuiAppOptions): Promise<number> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  // The process-level streams, not just the injected pair: a late console
  // buffer event hits Node's internal SIGWINCH refresh on stderr too.
  guardTtyResizeRefresh(process.stdout);
  guardTtyResizeRefresh(process.stderr);
  if (!isTtyOk(input) || !isTtyOk(output)) {
    options.io.error(
      "Error: tui needs an interactive terminal — stdin/stdout are not TTYs. " +
        "Use `two-brothers chat` for piped or redirected sessions.",
    );
    return 2;
  }

  let sessionCfg = options.cfg;
  let context: SharedContext;
  try {
    context = openTuiContext(sessionCfg, options.io);
  } catch (exc) {
    if (exc instanceof SessionError) {
      options.io.error(`[error] ${exc.message}`);
      return 1;
    }
    throw exc;
  }

  const resources = await loadTuiResources({
    cfg: sessionCfg,
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

  const cwd = options.cwd ?? process.cwd();
  const sessionsDir = options.sessionsDir ?? path.join(cwd, "sessions");
  const slashInfos = (): SlashCommandInfo[] =>
    resources.commands.commands.map((command: Command) => ({
      name: command.name,
      description: command.description,
      ...(command.argumentHint ? { argumentHint: command.argumentHint } : {}),
      ...(command.mode ? { mode: command.mode } : {}),
    }));

  let mode: Config["mode"] = sessionCfg.mode;
  let model: TuiModel = createTuiModel();
  // Tool-result expansion is per row and keyed by call id (or block id), so
  // it survives streaming updates and never depends on the row's position.
  let toolExpansion: ToolExpansionKeys = new Set<string>();
  // Loaded exactly once per TUI run; later submissions are appended here and
  // saved atomically. A malformed/unreadable file yields [] without noise.
  const envHistoryFile = process.env[TUI_HISTORY_FILE_ENV];
  const historyFile =
    options.historyFile ??
    (typeof envHistoryFile === "string" && envHistoryFile.trim() !== ""
      ? envHistoryFile.trim()
      : options.input === undefined && options.output === undefined
        ? defaultTuiHistoryPath()
        : null);
  let promptHistory: string[] = historyFile === null ? [] : loadHistory(historyFile);
  let editor: EditorState = seedEditorHistory(createEditor(), promptHistory);
  let draftStash: DraftStash = null;
  let scroll: TranscriptScroll = latestTranscriptScroll();
  let overlay: Overlay | null = null;
  let running = false;
  let turnAbort: AbortController | null = null;
  let turnDone: Promise<void> | null = null;
  let lastFailedTask: { task: string; turnMode: Config["mode"] } | null = null;
  let usage: UsageSnapshot | null = null;
  let cost: number | null = null;
  let contextTokens: number | null = null;
  let turnStartedAt = 0;
  let lastElapsedMs: number | undefined;
  let activity = "ready — type a task and press Enter";
  let quitArmed = false;
  let lastRenderAt = 0;
  let spinnerTick = 0;
  let toastSeq = 0;
  let toasts: Toast[] = [];
  let themeMode: ThemeMode | null = null;
  let theme: Theme = resolveTheme({ mode: themeMode });

  const sessionName = (): string =>
    sessionCfg.sessionFile ? path.basename(sessionCfg.sessionFile) : "in-memory";

  const measureContext = (): void => {
    try {
      contextTokens = estimateTokens(context.renderTranscript());
    } catch {
      contextTokens = null;
    }
  };
  measureContext();

  const spinnerTimer = setInterval(() => {
    if (!running) return;
    spinnerTick += 1;
    render();
  }, SPINNER_MS);
  spinnerTimer.unref?.();

  const pushToast = (level: ToastLevel, text: string): void => {
    toastSeq += 1;
    const toast: Toast = { id: `t${toastSeq}`, level, text };
    toasts = [...toasts, toast].slice(-3);
    const id = toast.id;
    const timer = setTimeout(() => {
      toasts = toasts.filter((entry) => entry.id !== id);
      render();
    }, 4000);
    timer.unref?.();
  };

  /**
   * Remember one accepted prompt in the live editor history and the persisted
   * sequence. A blank prompt or a repeat of the newest entry is a no-op, so a
   * seeded entry is never duplicated just because it was submitted again.
   */
  const rememberPrompt = (entry: string): void => {
    const prompt = appendHistory([], entry)[0];
    if (prompt === undefined) return;
    editor = recordHistory(editor, prompt);
    const next = appendHistory(promptHistory, prompt);
    const unchanged =
      next.length === promptHistory.length &&
      next.every((value, index) => value === promptHistory[index]);
    if (unchanged) return;
    promptHistory = next;
    if (historyFile !== null) saveHistory(historyFile, promptHistory);
  };

  /** One Ctrl+O press: stash the draft, restore it, or report the no-op. */
  const toggleStash = (): void => {
    const result = toggleDraftStash(editor, draftStash);
    editor = result.editor;
    draftStash = result.stash;
    if (result.outcome === "stashed") {
      pushToast("success", "draft stashed");
    } else if (result.outcome === "restored") {
      pushToast("success", "draft restored");
    } else {
      pushToast(
        "info",
        "nothing to stash or restore — the composer is empty and no draft is stashed",
      );
    }
    render();
  };

  /** Ctrl+T: show every line of the newest tool result, or collapse it. */
  const toggleToolExpansion = (): void => {
    const newest = newestToolBlock(model);
    const result = toggleNewestToolExpansion(model, toolExpansion);
    toolExpansion = result.keys;
    if (newest === undefined) {
      pushToast("info", "no tool result yet — expansion applies to the newest tool call");
    } else {
      pushToast("info", `${result.expanded ? "expanded" : "collapsed"} ${newest.tool} output`);
    }
    render();
  };

  const statusState = (): StatusBarState => ({
    mode,
    seniorModel: sessionCfg.seniorModel,
    juniorModel: sessionCfg.juniorModel,
    sessionName: sessionName(),
    cwd,
    running,
    activity,
    ...(contextTokens !== null ? { contextTokens } : {}),
    ...(sessionCfg.contextWindow > 0 ? { contextWindow: sessionCfg.contextWindow } : {}),
    ...(usage !== null
      ? {
          inputTokens: usage.input,
          outputTokens: usage.output,
          cachedTokens: usage.cached,
        }
      : {}),
    cost,
    ...(running
      ? { elapsedMs: Date.now() - turnStartedAt }
      : lastElapsedMs !== undefined
        ? { elapsedMs: lastElapsedMs }
        : {}),
  });

  function transcriptBodyHeight(): number {
    const size = terminal.size();
    return Math.max(1, size.rows - 14);
  }

  const overlayLines = (columns: number, rows: number): string[] | undefined => {
    if (overlay === null) return undefined;
    if (overlay.kind === "palette") {
      const boxW = Math.max(30, Math.min(Math.max(columns - 4, 30), 76));
      const boxH = Math.max(8, Math.min(Math.max(rows - 4, 8), 22));
      const entries = paletteEntries(TUI_COMMANDS, { commands: slashInfos(), running });
      const lines = paletteView(TUI_COMMANDS, overlay.state, entries, {
        width: Math.max(10, boxW - 4),
        height: Math.max(3, boxH - 2),
        title: "Commands",
      }).lines;
      return renderBox(lines, { width: boxW, title: "COMMANDS", theme });
    }
    if (overlay.kind === "help") {
      const boxW = Math.max(30, Math.min(Math.max(columns - 4, 30), 80));
      const boxH = Math.max(8, Math.min(Math.max(rows - 4, 8), 24));
      const entries = helpEntries(TUI_COMMANDS, { commands: slashInfos(), running });
      const lines = helpView(TUI_COMMANDS, overlay.state, entries, {
        width: Math.max(10, boxW - 4),
        height: Math.max(3, boxH - 2),
        title: "Help",
      }).lines;
      return renderBox(lines, { width: boxW, title: "HELP", theme });
    }
    if (overlay.kind === "history-search") {
      const boxW = Math.max(30, Math.min(Math.max(columns - 4, 30), 72));
      const boxH = Math.max(6, Math.min(Math.max(rows - 4, 6), 14));
      const lines = historySearchView(overlay.state, {
        width: Math.max(10, boxW - 4),
        height: Math.max(3, boxH - 2),
      }).lines;
      return renderBox(lines, { width: boxW, title: "HISTORY", theme });
    }
    if (overlay.kind === "picker") {
      const boxW = Math.max(30, Math.min(Math.max(columns - 8, 30), 72));
      const boxH = Math.max(8, Math.min(Math.max(rows - 6, 8), 18));
      return pickerView(overlay.state, overlay.items, {
        width: boxW,
        height: boxH,
        title: overlay.title,
        ...(overlay.emptyText !== undefined ? { emptyText: overlay.emptyText } : {}),
        theme,
      }).lines;
    }
    const boxW = Math.max(30, Math.min(Math.max(columns - 8, 30), 72));
    const boxH = Math.max(8, Math.min(Math.max(rows - 6, 8), 20));
    return dialogView(overlay.state, { width: boxW, height: boxH, theme }).lines;
  };

  function render(): void {
    const size = terminal.size();
    const frame = screenView({
      width: size.columns,
      height: size.rows,
      model: withToolExpansion(model, toolExpansion),
      editor,
      status: statusState(),
      theme,
      scroll,
      overlay: overlayLines(size.columns, size.rows),
      toasts,
      spinnerTick,
      reducedMotion: process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "",
    });
    terminal.render(frame.lines.join("\n"));
  }

  const onStreamEvent = (event: StreamEvent): void => {
    const reduced = reduceModelEvent(model, event);
    model = reduced.model;
    if (reduced.status !== undefined) activity = reduced.status;
    const now = Date.now();
    if (event.type !== "token" || now - lastRenderAt >= TOKEN_RENDER_MS) {
      lastRenderAt = now;
      render();
    }
  };

  const onWarning = (line: string): void => {
    model = addNotice(model, "warn", line);
  };

  /**
   * Start one turn. `prompt` is the user-facing submission to remember in
   * history (raw composer text, a CLI task, or a palette template) and is
   * deliberately separate from the expanded `task`. Only a turn that actually
   * starts records history; retry replays the same task without a new entry.
   */
  const executeTurn = (task: string, turnMode: Config["mode"], prompt?: string): void => {
    if (running) {
      // Defensive only — submitEditor refuses before reaching here, so the
      // caller's draft is never dropped by this guard.
      model = addNotice(model, "warn", "a turn is still running — wait for it to finish");
      render();
      return;
    }
    if (prompt !== undefined) rememberPrompt(prompt);
    model = addUserBlock(model, task);
    scroll = latestTranscriptScroll();
    running = true;
    quitArmed = false;
    turnStartedAt = Date.now();
    lastRenderAt = 0;
    activity = `running (${turnMode})…`;
    const controller = new AbortController();
    turnAbort = controller;
    render();
    turnDone = (async () => {
      try {
        const { harness, mcp } = await buildTurnHarness({
          cfg: sessionCfg,
          mode: turnMode,
          resources,
          ...(options.mcpConfig !== undefined ? { mcpConfig: options.mcpConfig } : {}),
          ...(options.streamTokens === true ? { streamTokens: true } : {}),
          signal: controller.signal,
          onStreamEvent,
          onWarning,
        });
        try {
          const result = await harness.run(task, context);
          usage = usageOf(result.usage);
          lastElapsedMs = Date.now() - turnStartedAt;
          measureContext();
          const senior = sessionCfg.seniorModel.trim();
          const estimate =
            senior !== "" && senior === sessionCfg.juniorModel.trim()
              ? estimateCost(senior, {
                  promptTokens: usage.input,
                  completionTokens: usage.output,
                })
              : null;
          // an honest unknown marker, never a fabricated zero
          cost = estimate === null ? null : estimate.totalCost;
          for (const warning of result.warnings) {
            model = addNotice(model, "warn", `warn: ${warning}`);
          }
          for (const error of result.errors) {
            model = addNotice(model, "error", error, {
              details: `task: ${task}`,
              retryable: true,
            });
          }
          if (result.errors.length > 0) {
            lastFailedTask = { task, turnMode };
            activity = "turn completed with errors — /retry re-sends it";
          }
          if (sessionCfg.verbose) {
            for (const audit of result.promptAudits) {
              model = addNotice(
                model,
                "info",
                `audit ${audit.role} ${audit.kind}: ${audit.sections.join(" > ")}; ` +
                  `tools: ${audit.tools.length > 0 ? audit.tools.join(", ") : "(none)"}`,
              );
            }
          }
        } finally {
          await mcp?.client.close();
        }
      } catch (exc) {
        const text = messageOf(exc);
        if (controller.signal.aborted) {
          model = addNotice(model, "info", "turn cancelled");
          activity = "turn cancelled — the session is still open";
        } else {
          model = addNotice(model, "error", text, {
            details: `task: ${task}`,
            retryable: true,
          });
          activity = "turn failed — the session is still open";
          if (overlay === null) {
            overlay = {
              kind: "dialog",
              state: createDialog({
                title: "Turn failed",
                message: text,
                details: task,
                tone: "error",
                actions: [
                  { id: "retry", label: "Retry" },
                  { id: "close", label: "Close" },
                ],
              }),
              onAction: (id) => {
                if (id === "retry") doRetry();
              },
            };
          }
        }
        lastFailedTask = { task, turnMode };
      } finally {
        running = false;
        turnAbort = null;
        render();
      }
    })();
    // The turn reports its own errors into the transcript; a rejection here
    // would be a bug, but it must never become an unhandled rejection.
    turnDone.catch(() => {});
  };

  const doRetry = (): void => {
    if (running) return;
    if (lastFailedTask === null) {
      model = addNotice(model, "info", "nothing to retry");
      return;
    }
    executeTurn(lastFailedTask.task, lastFailedTask.turnMode);
  };

  const gateIdleCommand = (command: Pick<TuiCommand, "idleOnly" | "title">): boolean => {
    if (isCommandEnabled(command, { running })) return true;
    model = addNotice(model, "warn", `${command.title} is unavailable while a turn is running`);
    return false;
  };

  // --------------------------------------------------------------------- //
  // overlays
  // --------------------------------------------------------------------- //

  const openPalette = (): void => {
    overlay = { kind: "palette", state: createPaletteState() };
  };
  const openHelp = (): void => {
    overlay = { kind: "help", state: createHelpState() };
  };
  /**
   * Open reverse-history search over the editor's submitted history. The
   * composer draft and cursor are deliberately left untouched: accepting
   * replaces them, cancelling simply closes the overlay, so Escape always
   * restores the exact pre-search draft.
   */
  const openHistorySearchOverlay = (): void => {
    overlay = { kind: "history-search", state: openHistorySearch(editor.history) };
  };

  const openModePicker = (): void => {
    const items: PickerItem[] = [
      {
        id: "consult",
        label: "consult",
        description: "the senior asks the junior and decides (read-only)",
        keywords: ["mode"],
      },
      {
        id: "work",
        label: "work",
        description: "the junior may use its tool belt and workspace",
        keywords: ["mode"],
      },
    ];
    overlay = {
      kind: "picker",
      title: "COOPERATION MODE",
      items,
      state: createPickerState(),
      onAccept: (item) => {
        mode = item.id === "work" ? "work" : "consult";
        pushToast("info", `mode: ${mode} — the next turn uses it`);
      },
    };
  };

  const modelItemsForRole = (role: "senior" | "junior"): PickerItem[] => {
    const pinned = envPinnedPairs().has(`${role}:model`);
    const current = (role === "senior" ? sessionCfg.seniorModel : sessionCfg.juniorModel).trim();
    const items: PickerItem[] = [];
    if (current !== "") {
      items.push({
        id: `keep:${role}`,
        label: `keep current (${current})`,
        description: "no change",
        ...(pinned ? { disabled: true, disabledReason: "pinned by a TWO_BROTHERS_* env var" } : {}),
      });
    }
    for (const preset of mergeSeedPresets()) {
      for (const presetModel of preset.models ?? []) {
        items.push({
          id: `${role}:${presetModel}`,
          label: presetModel,
          description: `${preset.name} preset`,
          keywords: [preset.name, role],
          ...(pinned ? { disabled: true, disabledReason: "pinned by a TWO_BROTHERS_* env var" } : {}),
        });
      }
    }
    if (items.length === 0) {
      items.push({
        id: "none",
        label: "(no presets carry model lists)",
        disabled: true,
        disabledReason: "configure with --senior-model/--junior-model or two-brothers onboard",
      });
    }
    return items;
  };

  const applyRoleModel = (role: "senior" | "junior", value: string): void => {
    sessionCfg =
      role === "senior"
        ? { ...sessionCfg, seniorModel: value }
        : { ...sessionCfg, juniorModel: value };
    pushToast("success", `${role} model set to ${value} for this session`);
  };

  const openModelPicker = (preselectedRole?: "senior" | "junior"): void => {
    const openRolePicker = (role: "senior" | "junior"): void => {
      overlay = {
        kind: "picker",
        title: `${role.toUpperCase()} MODEL`,
        items: modelItemsForRole(role),
        state: createPickerState(),
        onAccept: (item) => {
          if (item.id.startsWith("keep:")) return;
          const value = item.id.slice(role.length + 1);
          if (value !== "") applyRoleModel(role, value);
        },
      };
    };
    if (preselectedRole !== undefined) openRolePicker(preselectedRole);
    else {
      overlay = {
        kind: "picker",
        title: "CHOOSE A ROLE",
        items: [
          { id: "senior", label: "Senior", description: "the arbiter — experience and judgment" },
          { id: "junior", label: "Junior", description: "the executor — brave and determined" },
        ],
        state: createPickerState(),
        onAccept: (item) => openRolePicker(item.id === "junior" ? "junior" : "senior"),
      };
    }
  };

  const openSessionPicker = (): void => {
    const items: PickerItem[] = [];
    try {
      for (const name of fs.readdirSync(sessionsDir).filter((n) => n.endsWith(".jsonl")).sort()) {
        let updated = "(unknown time)";
        try {
          updated = String(fs.statSync(path.join(sessionsDir, name)).mtime);
        } catch {
          // unreadable stat still lists the session
        }
        items.push({
          id: name,
          label: name.slice(0, -".jsonl".length),
          description: updated,
          keywords: [name],
        });
      }
    } catch {
      // missing sessions dir: the picker shows its empty state
    }
    overlay = {
      kind: "picker",
      title: "RESUME SESSION",
      items,
      state: createPickerState(),
      emptyText: `No saved sessions in ${sessionsDir}.`,
      onAccept: (item) => {
        overlay = {
          kind: "dialog",
          state: createDialog({
            title: "Resume session",
            message: `Resume "${item.label}"? The current context is replaced by the saved session.`,
            actions: [
              { id: "resume", label: "Resume" },
              { id: "cancel", label: "Cancel" },
            ],
          }),
          onAction: (id) => {
            if (id !== "resume") return;
            try {
              const sessionFile = path.join(sessionsDir, item.id);
              context = openTuiContext({ ...sessionCfg, sessionFile, resume: true }, options.io);
              sessionCfg = { ...sessionCfg, sessionFile, resume: true };
              model = createTuiModel();
              toolExpansion = new Set<string>();
              // A session switch resets the draft but not durable prompt
              // history or the in-memory stash slot.
              editor = seedEditorHistory(createEditor(), editor.history);
              scroll = latestTranscriptScroll();
              usage = null;
              cost = null;
              measureContext();
              pushToast("success", `resumed ${item.label}`);
            } catch (exc) {
              model = addNotice(model, "error", messageOf(exc));
            }
          },
        };
      },
    };
  };

  const openSettingsDialog = (): void => {
    overlay = {
      kind: "dialog",
      state: createDialog({
        title: "Settings",
        message:
          "Provider setup is stored per role in sessions/settings.json. " +
          "Run `two-brothers onboard` outside the TUI for guided setup, or start " +
          "the TUI with --senior-model/--junior-model (and --base-url/--api-key).",
        actions: [{ id: "close", label: "Close" }],
      }),
      onAction: () => {},
    };
  };

  const cycleTheme = (explicit?: string): void => {
    const requested = explicit?.trim().toLowerCase();
    if (requested === "dark" || requested === "light") {
      themeMode = requested;
    } else if (requested === "system" || requested === undefined || requested === "") {
      themeMode = null; // back to environment detection
    } else {
      model = addNotice(model, "warn", "usage: /theme dark|light|system");
      return;
    }
    theme = resolveTheme({ mode: themeMode });
    pushToast("info", `theme: ${theme.mode}${theme.color ? "" : " (no color)"}`);
  };

  /** Run a palette/help entry: commands dispatch, templates become tasks. */
  const dispatchEntry = (entry: PaletteEntry): void => {
    if (entry.kind === "slash-template") {
      const template = resources.commands.commands.find(
        (c) => c.name === entry.id.slice("template:".length),
      );
      if (template === undefined) return;
      if ((template.argumentHint ?? "") !== "") {
        editor = insertText(editor, `/${template.name} `);
      } else {
        executeTurn(expandCommand(template, ""), template.mode ?? mode, `/${template.name}`);
      }
      return;
    }
    switch (entry.id) {
      case "palette":
        openPalette();
        break;
      case "help":
        openHelp();
        break;
      case "commands": {
        const action = resolveTuiInput("/commands", resources.commands);
        if (action.type === "lines") {
          for (const line of action.lines) {
            model = addNotice(model, line.kind === "error" ? "error" : "info", line.text);
          }
        }
        break;
      }
      case "exit":
        requestQuit();
        break;
      case "tool-expand":
        toggleToolExpansion();
        break;
      case "stash":
        toggleStash();
        break;
      case "history-search":
        openHistorySearchOverlay();
        break;
      case "mode":
        openModePicker();
        break;
      case "models":
        openModelPicker();
        break;
      case "sessions":
        openSessionPicker();
        break;
      case "theme":
        cycleTheme();
        break;
      case "settings":
        openSettingsDialog();
        break;
      case "retry":
        doRetry();
        break;
      default:
        break;
    }
  };

  // --------------------------------------------------------------------- //
  // key handling
  // --------------------------------------------------------------------- //

  const requestQuit = (): void => {
    if (quitArmed) throw new TuiExit();
    quitArmed = true;
    activity = QUIT_ARMED_ACTIVITY;
    render();
  };

  /** Safe precedence: turn cancel → composer clear → quit confirm. */
  const cancelKey = (): void => {
    if (running && turnAbort !== null) {
      turnAbort.abort();
      activity = "cancelling…";
      render();
      return;
    }
    if (editor.text !== "") {
      editor = clearEditor(editor);
      activity = "composer cleared";
      render();
      return;
    }
    requestQuit();
  };

  const completeSlash = (): void => {
    const text = editor.text;
    if (!text.startsWith("/") || text.includes(" ")) return;
    const prefix = text.slice(1).toLowerCase();
    if (prefix === "") return;
    const names = [
      ...TUI_COMMANDS.map((c) => c.slash).filter((s): s is string => s !== undefined),
      ...resources.commands.commands.map((c) => c.name),
    ];
    const unique = [...new Set(names.filter((name) => name.toLowerCase().startsWith(prefix)))];
    if (unique.length === 1 && unique[0] !== undefined && unique[0] !== prefix) {
      editor = insertText(editor, `/${unique[0]} `.slice(text.length));
    }
  };

  /** Slash forms for registry commands that `resolveTuiInput` does not own
   *  (`/models`, `/sessions`, `/theme`, …). Returns false when the caller
   *  should fall back to the template/builtin resolver. */
  const dispatchSlash = (command: TuiCommand, args: string): boolean => {
    switch (command.id) {
      case "palette":
        openPalette();
        return true;
      case "help":
        openHelp();
        return true;
      case "commands": {
        const action = resolveTuiInput("/commands", resources.commands);
        if (action.type === "lines") {
          for (const line of action.lines) {
            model = addNotice(model, line.kind === "error" ? "error" : "info", line.text);
          }
        }
        return true;
      }
      case "exit":
        throw new TuiExit();
      case "mode": {
        const requested = args.trim().toLowerCase();
        if (requested === "") {
          openModePicker();
          return true;
        }
        if (requested === "consult" || requested === "work") {
          mode = requested;
          pushToast("info", `mode: ${mode} — the next turn uses it`);
          return true;
        }
        model = addNotice(model, "warn", "usage: /mode consult|work");
        return true;
      }
      case "models": {
        if (!gateIdleCommand(command)) return true;
        const words = args.trim().split(/\s+/).filter(Boolean);
        if (words[0] === "senior" || words[0] === "junior") {
          if (words.length >= 2 && words[1] !== undefined) {
            if (envPinnedPairs().has(`${words[0]}:model`)) {
              model = addNotice(
                model,
                "warn",
                `${words[0]} model is pinned by a TWO_BROTHERS_* env var and cannot be changed here`,
              );
              return true;
            }
            applyRoleModel(words[0], words[1]);
            return true;
          }
          openModelPicker(words[0]);
          return true;
        }
        openModelPicker();
        return true;
      }
      case "sessions":
        if (!gateIdleCommand(command)) return true;
        openSessionPicker();
        return true;
      case "theme":
        cycleTheme(args);
        return true;
      case "settings":
        if (!gateIdleCommand(command)) return true;
        openSettingsDialog();
        return true;
      case "retry":
        doRetry();
        return true;
      default:
        return false;
    }
  };

  const submitEditor = (): void => {
    // Refuse before consuming the submission: takeSubmission would clear the
    // editor, and a silent `executeTurn` return mid-run would lose the draft.
    if (running && editor.text.trim() !== "") {
      model = addNotice(
        model,
        "warn",
        "a turn is still running — your draft is kept; send it when the turn finishes",
      );
      render();
      return;
    }
    const submission = takeSubmission(editor);
    editor = submission.state;
    const text = submission.text;
    if (text.trim() === "") return;
    const matched = matchCommand(text);
    if (matched !== null) {
      const builtin = findSlashCommand(TUI_COMMANDS, matched.name);
      const shadowsTemplate = resources.commands.commands.some((c) => c.name === matched.name);
      if (builtin !== null && !shadowsTemplate && dispatchSlash(builtin, matched.args)) return;
    }
    const action = resolveTuiInput(text, resources.commands);
    switch (action.type) {
      case "none":
        break;
      case "exit":
        throw new TuiExit();
      case "lines":
        for (const line of action.lines) {
          model = addNotice(model, line.kind === "error" ? "error" : "info", line.text);
        }
        if (action.status !== undefined) activity = action.status;
        break;
      case "mode":
        mode = action.mode;
        pushToast("info", `mode: ${mode} — the next turn uses it`);
        break;
      case "run":
        executeTurn(action.task, action.mode ?? mode, text);
        break;
    }
  };

  const handleOverlayKey = (key: KeyLike): void => {
    if (overlay === null) return;
    if (overlay.kind === "palette") {
      const entries = paletteEntries(TUI_COMMANDS, { commands: slashInfos(), running });
      const result = handlePaletteKey(TUI_COMMANDS, overlay.state, key, entries);
      overlay = { ...overlay, state: result.state };
      if (result.action === "close") overlay = null;
      else if (result.action === "accept" && result.entry !== undefined) {
        const entry = result.entry;
        overlay = null;
        dispatchEntry(entry);
      } else if (result.action === "blocked") {
        pushToast("warn", result.reason ?? "unavailable");
      }
      return;
    }
    if (overlay.kind === "help") {
      const entries = helpEntries(TUI_COMMANDS, { commands: slashInfos(), running });
      const result = handleHelpKey(TUI_COMMANDS, overlay.state, key, entries);
      overlay = { ...overlay, state: result.state };
      if (result.action === "close") overlay = null;
      else if (result.action === "accept" && result.entry !== undefined) {
        const entry = result.entry;
        overlay = null;
        dispatchEntry(entry);
      } else if (result.action === "blocked") {
        pushToast("warn", result.reason ?? "unavailable");
      }
      return;
    }
    if (overlay.kind === "history-search") {
      const result = searchHistoryKey(overlay.state, key);
      if (result.action === "cancel") {
        // The composer was never touched while searching, so closing the
        // overlay restores the exact pre-search draft and cursor.
        overlay = null;
      } else if (result.action === "accept" && result.text !== undefined) {
        // setEditorText puts the cursor at the end and leaves the history
        // untouched: accepting recalls, it never re-records.
        editor = setEditorText(editor, result.text);
        overlay = null;
      } else {
        overlay = { ...overlay, state: result.state };
      }
      return;
    }
    if (overlay.kind === "picker") {
      const result = handlePickerKey(overlay.state, key, overlay.items);
      overlay = { ...overlay, state: result.state };
      if (result.action === "close") overlay = null;
      else if (result.action === "accept" && result.item !== undefined) {
        const accept = overlay.onAccept;
        overlay = null;
        accept(result.item);
      } else if (result.action === "blocked") {
        pushToast("warn", result.reason ?? "unavailable");
      }
      return;
    }
    const result = handleDialogKey(overlay.state, key);
    if (result.action === "close") {
      overlay = null;
    } else if (result.action === "accept" && result.actionId !== undefined) {
      const onAction = overlay.onAction;
      overlay = null;
      onAction(result.actionId);
    } else if (result.action === "blocked") {
      pushToast("warn", "unavailable");
    }
  };

  /**
   * Registry command dispatch for the app scope. Returns true when the key
   * was consumed here; false lets the editor handle it (typing, history,
   * submission, scrolling).
   */
  const dispatchCommand = (command: TuiCommand): boolean => {
    switch (command.id) {
      case "palette":
        openPalette();
        return true;
      case "help":
        openHelp();
        return true;
      case "stash":
        toggleStash();
        return true;
      case "tool-expand":
        toggleToolExpansion();
        return true;
      case "history-search":
        openHistorySearchOverlay();
        return true;
      case "cancel":
      case "exit":
        cancelKey();
        return true;
      default:
        return false;
    }
  };

  const pageSize = (): number => Math.max(1, terminal.size().rows - 10);

  const handleKey = (key: Key): void => {
    if (overlay !== null) {
      handleOverlayKey(key);
      return;
    }
    const match = resolveKey(TUI_COMMANDS, key, "app");
    // A literal "?" with text in the composer is typing, not the help chord —
    // tasks are full of questions. F1 (and "?" on an empty composer) still
    // open help.
    const helpChordBlocksTyping =
      match !== null &&
      match.command.id === "help" &&
      match.chord.name === "?" &&
      editor.text !== "";
    if (match !== null && !helpChordBlocksTyping && dispatchCommand(match.command)) {
      return;
    }
    const result = handleEditorKey(editor, key);
    editor = result.state;
    switch (result.action) {
      case "submit":
        submitEditor();
        break;
      case "scroll-prev":
        scroll = scrollTranscript(model, scroll, -pageSize(), {
          width: terminal.size().columns,
          height: transcriptBodyHeight(),
          theme,
        });
        break;
      case "scroll-next":
        scroll = scrollTranscript(model, scroll, pageSize(), {
          width: terminal.size().columns,
          height: transcriptBodyHeight(),
          theme,
        });
        break;
      case "cancel":
        cancelKey();
        break;
      case "complete":
        completeSlash();
        break;
      default:
        break;
    }
  };

  function isQuitChord(key: Key): boolean {
    return (
      (key.ctrl === true && (key.name === "c" || key.raw === "\u0003")) ||
      key.name === "escape"
    );
  }

  const unsubscribeResize = terminal.onResize(() => {
    render();
  });

  const abortRunningTurn = (): void => {
    const controller = turnAbort;
    if (controller !== null) controller.abort();
  };

  try {
    terminal.enter();
    render();
    if (options.initialTask !== undefined && options.initialTask.trim() !== "") {
      executeTurn(options.initialTask.trim(), mode, options.initialTask.trim());
    }
    for (;;) {
      render();
      const event = await terminal.readEvent();
      if (event.type === "key" && quitArmed && isQuitChord(event.key)) {
        // the confirming press of a quit chord: leave, restore the terminal
        break;
      }
      if (quitArmed) {
        // any other input disarms the quit chord; the armed status-bar text
        // must not linger once the chord is cancelled
        quitArmed = false;
        if (activity === QUIT_ARMED_ACTIVITY) activity = "quit cancelled";
      }
      if (event.type === "paste") {
        if (overlay === null) editor = pasteText(editor, event.text);
        continue;
      }
      handleKey(event.key);
    }
    return 0;
  } catch (exc) {
    // `/exit` (and the palette Exit entry) quit via this control-flow signal;
    // it is a clean quit, not an error — without the catch it reached the
    // CLI top level and turned into exit code 1.
    if (!(exc instanceof TuiExit)) throw exc;
    return 0;
  } finally {
    unsubscribeResize();
    clearInterval(spinnerTimer);
    abortRunningTurn();
    if (turnDone !== null) {
      await Promise.race([turnDone, new Promise((resolve) => setTimeout(resolve, 1500))]);
    }
    terminal.restore();
  }
}
