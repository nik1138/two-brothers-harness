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
 * Per-role provider endpoints are resolved from the persisted settings store
 * (`sessions/settings.json`, the same `SettingsStore`/`RuntimeSettings`/
 * `resolveRoleEndpoints` stack `serve` uses; see `providers.ts`), with CLI
 * flags/env as the explicit override and seed presets as the fallback, and are
 * re-resolved before every turn. Plugins are re-bound per turn exactly like
 * the chat REPL; skills and slash commands are discovered once per session.
 * `/provider` (also reached from `/settings`) is the real connect surface: it
 * persists through the same atomic store and never renders a key value.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

import { discoverCommands, expandCommand, matchCommand, type Command, type CommandCatalog } from "../commands.ts";
import { findBaseCommand, type BaseCommand } from "../basecommands.ts";
import {
  compactContext,
  isCompactionSummary,
  type CompactionSettings,
} from "../compaction.ts";
import {
  DEFAULT_KEEP_RECENT_CHARS,
  DEFAULT_KEEP_RECENT_TOKENS,
  estimateTokens,
} from "../compaction.ts";
import { compactionSettingsFromConfig, maxTokensForRole, validateRunConfig, type Config } from "../config.ts";
import { estimateRunCostFromUsage } from "../cost.ts";
import { SharedContext } from "../context.ts";
import { TwoBrothersHarness, type ToolScopes } from "../harness.ts";
import { deriveTitle, SessionMetadataStore } from "../metadata.ts";
import {
  loadMcpToolSpecs,
  loadMcpTools,
  mergeMcpConfig,
  type McpConfigFileShape,
  type McpToolSet,
} from "../mcp.ts";
import { PluginManager, type PluginBindings } from "../plugins.ts";
import {
  APPROVAL_MODE_INFO,
  APPROVAL_MODES,
  DEFAULT_APPROVAL_MODE,
  Decision,
  PermissionManager,
  PermissionPolicy,
  approvalModeWarning,
  normalizeApprovalMode,
  type ApprovalMode,
} from "../permissions.ts";
import type { Message } from "../protocol.ts";
import { RunApprovalBroker, RuntimeEventStore } from "../runevents.ts";
import type { RuntimeEvent } from "../runevents.ts";
import type { RoleEndpoints } from "../runtime.ts";
import { Workspace } from "../workspace.ts";
import { sanitizeTodos, type TodoItem } from "../todos.ts";
import {
  indexWorkspaceFiles,
  type WorkspaceFileEntry,
} from "../workspacefiles.ts";
import type { StreamEvent } from "../runstream.ts";
import { restoreContext, SessionError, SessionStore } from "../session.ts";
import {
  exportSessionFileName,
  sessionToMarkdown,
  type SessionSearchDoc,
} from "../sessionsearch.ts";
import { envPinnedPairs } from "../settings_store.ts";
import { discoverSkills, type SkillCatalog } from "../skills.ts";
import {
  MENTION_MAX_FILE_CHARS,
  MENTION_MAX_FILES,
  MENTION_MAX_SKILLS,
  MENTION_MAX_TOTAL_CHARS,
  normalizeMentionPath,
  parseMentions,
  renderFileBlock,
  renderSkillLoadedBlock,
} from "../mentions.ts";
import {
  buildProvider,
  MockProvider,
  resolveProviderKind,
  roleProviderKind,
  type Provider,
  type ProviderConfig,
} from "../provider.ts";
import type { Tool } from "../provider.ts";

import {
  clearEditor,
  createEditor,
  handleEditorKey,
  insertText,
  pasteText,
  recordHistory,
  replaceTextRange,
  setEditorText,
  takeSubmission,
  type EditorOptions,
  type EditorState,
} from "./editor.ts";
import {
  createProviderStore,
  loadTuiProviderState,
  providerFailureHint,
  providerModelChoices,
  providerPresetChoices,
  providerRoleSummaries,
  providerRoleSummary,
  providerSummaryLines,
  saveTuiProviderConnection,
  type ProviderConnectRequest,
  type TuiProviderState,
} from "./providers.ts";
import {
  BASE_COMMAND_ENTRY_PREFIX,
  nonAsciiBaseAliasNotice,
  planBaseCommandSubmission,
  tuiBaseCommands,
  tuiBasePaletteEntries,
  tuiNativeCommandTokens,
} from "./basecommands.ts";
import {
  guardComposerSubmit,
  type RepeatGuardSnapshot,
} from "./inputguard.ts";
import {
  appendHistory,
  defaultTuiHistoryPath,
  loadHistory,
  saveHistory,
  TUI_HISTORY_FILE_ENV,
} from "./historystore.ts";
import {
  composeStatusHints,
  findSlashCommand,
  hintSegments,
  isCommandEnabled,
  paletteEntries,
  resolveKey,
  TUI_COMMANDS,
  type KeyChord,
  type KeyLike,
  type PaletteEntry,
  type SlashCommandInfo,
  type TuiCommand,
} from "./keymap.ts";
import {
  boundTuiKeysNotice,
  describeTuiKeys,
  globalKeySummary,
  reloadTuiCommands,
  watchTuiKeysFile,
  type TuiKeysLoadResult,
  type TuiKeysLoadState,
  type TuiKeysSource,
  type TuiKeysWatchHandle,
  type TuiKeysWatchState,
} from "./keyoverrides.ts";
import {
  addNotice,
  addUserBlock,
  commitEnvelope,
  createCompactionSummaryModel,
  createTuiModel,
  reduceModelEvent,
  type TuiModel,
} from "./model.ts";
import {
  newestToolBlock,
  toggleNewestToolExpansion,
  toolFoldHint,
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
  activeFindMatch,
  appendFindText,
  findBarView,
  findCorpus,
  findKey,
  openFind,
  refreshFind,
  setFindQuery,
  type FindState,
} from "./view/findbar.ts";
import {
  createHelpState,
  handleHelpKey,
  helpEntries,
  helpView,
  type HelpState,
} from "./view/help.ts";
import {
  detectMentionTrigger,
  mentionPickerKey,
  mentionPickerView,
  openMentionPicker,
  updateMentionPicker,
  type MentionPickerState,
} from "./view/mentionpicker.ts";
import {
  approvalPanelKey,
  approvalPanelView,
  approvalPreview,
  createApprovalPanelState,
  type ApprovalPanelState,
} from "./view/approval.ts";
import { sessionSidecarKey, todosFromRuntimeEvents, todoPanelView } from "./view/todo.ts";
import { persistTodoSnapshot } from "./todoPersist.ts";
import { loadSessionReasoning, type ReplayedReasoning } from "./reasoningPersist.ts";
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
import {
  parseSessionEventPrefix,
  sessionPickerItems,
  SESSION_TITLE_PREFIX_BYTES,
  type SessionPickEntry,
} from "./view/sessionpick.ts";
import {
  createProviderConnectState,
  providerConnectKey,
  providerConnectView,
  setProviderConnectError,
  type ProviderConnectData,
  type ProviderConnectState,
} from "./view/provider.ts";
import { screenView } from "./view/screen.ts";
import {
  SIDE_PANEL_MIN_HEIGHT,
  SIDE_PANEL_MIN_WIDTH,
  sidePanelEntries,
  sidePanelLayout,
  toggleSidePanelEnabled,
  type SidePanelCompaction,
  type SidePanelDiscovery,
  type SidePanelState,
} from "./view/sidepanel.ts";
import type { StatusBarState } from "./view/statusbar.ts";
import { transientHintFor } from "./view/statusbar.ts";
import type { Toast, ToastLevel } from "./view/toast.ts";
import {
  latestTranscriptScroll,
  scrollToBlock,
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
  /**
   * The effective TUI command table (default {@link TUI_COMMANDS}): the
   * file-configured key overrides resolved at startup. Matching, the
   * palette/help listings, status hints and every surface footer derive their
   * chords from this one table.
   */
  commands?: readonly TuiCommand[];
  /**
   * The keys-file source captured at startup (path + origin) for `/keys show`
   * and `/keys reload`. Absent when an embedding injects `commands` directly;
   * the built-in command then reports that no source was captured.
   */
  keysSource?: TuiKeysSource;
  /** Result of the startup load (reported by `/keys show`, maintained on reload). */
  keysState?: TuiKeysLoadState;
  /** Diagnostics from the startup load (reported by `/keys show`). */
  keysDiagnostics?: readonly string[];
  /**
   * `tui --keys-watch` / `TWO_BROTHERS_TUI_KEYS_WATCH=1`: poll the captured
   * keys file and apply valid edits automatically (fail-soft, last-good table;
   * one bounded notice per detected change). Off by default and never
   * persisted; the flag/env are captured at startup (changing them needs a
   * restart), while the FILE's contents keep reloading.
   */
  keysWatch?: boolean;
  /**
   * `tui --approval-mode` / `TWO_BROTHERS_APPROVAL_MODE`: pin the workspace
   * approval policy for this TUI process. Never persisted; without a pin the
   * saved `approval_policy` setting is read per turn and `/permission` writes
   * that setting. The dialog states the pinned mode and offers no save buttons
   * (the pin would keep winning until restart, so pretending to change it
   * would be dishonest).
   */
  approvalMode?: ApprovalMode;
  /** `tui "<task>"`: run this task as soon as the screen opens. */
  initialTask?: string;
  /**
   * `tui --workspace <dir>`: bind every turn to this confined workspace. The
   * junior gets the `workspace_*` tool belt, the senior the read-only verify
   * slice, mutations/shell park on an operator approval panel, plugins bind
   * workspace-bound and the composer `@path` picker/attachments use this root.
   * An invalid root is a startup error (exit 2) before the screen opens.
   */
  workspaceRoot?: string;
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
// composer mentions (@skill:<name>)
// --------------------------------------------------------------------------- //

/** A validated skill attachment: the exact context message texts to append. */
export interface SkillAttachmentPlan {
  /** Attached skill names, in mention order (already deduped). */
  names: string[];
  /** `renderSkillLoadedBlock(name, body)` texts, parallel to `names`. */
  blocks: string[];
  /** Total block characters (bounded by `MENTION_MAX_TOTAL_CHARS`). */
  totalChars: number;
}

/** Result of validating a task's `@skill:<name>` mentions. */
export type SkillMentionResolution =
  | { ok: true; plan: SkillAttachmentPlan }
  | { ok: false; errors: string[] };

/**
 * Validate the `@skill:<name>` mentions of one task against the discovered
 * catalog, the same rules the submit path needs: unknown names and role-scoped
 * skills are refused (only shared skills are operator-attachable), and
 * `MENTION_MAX_SKILLS` / `MENTION_MAX_TOTAL_CHARS` bound the cost. File
 * mentions (`@rel/path`) are deliberately ignored here: the TUI runs have no
 * workspace, so they stay literal task text. Pure: no context access.
 */
export function resolveSkillMentions(
  task: string,
  catalog: SkillCatalog,
): SkillMentionResolution {
  const parsed = parseMentions(task);
  if (parsed.skills.length === 0) {
    return { ok: true, plan: { names: [], blocks: [], totalChars: 0 } };
  }
  const errors: string[] = [];
  if (parsed.skills.length > MENTION_MAX_SKILLS) {
    errors.push(
      `too many skill mentions (${parsed.skills.length}); at most ${MENTION_MAX_SKILLS} per task`,
    );
  }
  const names: string[] = [];
  const blocks: string[] = [];
  for (const name of parsed.skills) {
    const skill = catalog.skills.find((candidate) => candidate.name === name);
    if (skill === undefined) {
      errors.push(
        `unknown skill: @skill:${name} (type @ in the composer to list the shared skills)`,
      );
      continue;
    }
    if (skill.scope !== "shared") {
      errors.push(
        `skill "${name}" is ${skill.scope}-scoped; only shared skills can be attached by the operator`,
      );
      continue;
    }
    names.push(name);
    blocks.push(renderSkillLoadedBlock(name, skill.body));
  }
  const totalChars = blocks.reduce((total, block) => total + block.length, 0);
  if (totalChars > MENTION_MAX_TOTAL_CHARS) {
    errors.push(
      `attached skill content is too large (${totalChars} > ${MENTION_MAX_TOTAL_CHARS} chars)`,
    );
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, plan: { names, blocks, totalChars } };
}

/** A validated file attachment: the exact context message texts to append. */
export interface FileAttachmentPlan {
  /** Attached workspace-relative paths, in mention order (deduped). */
  names: string[];
  /** `renderFileBlock(...)` texts, parallel to `names`. */
  blocks: string[];
  /** Total block characters (bounded by `MENTION_MAX_TOTAL_CHARS`). */
  totalChars: number;
}

/** Result of validating a task's `@<path>` mentions. */
export type FileMentionResolution =
  | { ok: true; plan: FileAttachmentPlan }
  | { ok: false; errors: string[] };

/**
 * Read at most `maxBytes` of a file as UTF-8 (bounded synchronous read, the
 * operator-submission path). Returns the text and whether the file was larger.
 */
function readBoundedFileText(target: string, maxBytes: number, size: number): {
  text: string;
  truncated: boolean;
} {
  const bytes = Math.max(0, Math.min(size, Math.max(0, Math.floor(maxBytes))));
  if (bytes === 0) return { text: "", truncated: size > 0 };
  const buffer = Buffer.alloc(bytes);
  const fd = fs.openSync(target, "r");
  let read = 0;
  try {
    read = fs.readSync(fd, buffer, 0, buffer.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  const raw = buffer.subarray(0, read).toString("utf-8");
  const truncated = size > read || raw.length > MENTION_MAX_FILE_CHARS;
  return {
    text: raw.length > MENTION_MAX_FILE_CHARS ? raw.slice(0, MENTION_MAX_FILE_CHARS) : raw,
    truncated,
  };
}

/**
 * Validate the `@<path>` mentions of one task against a bound workspace and
 * build the `<file path="…">` context blocks, with the same rules the server
 * path enforces: at most `MENTION_MAX_FILES`, normalised workspace-relative
 * paths (absolute paths and `..` segments refused), confined reads through
 * `Workspace.resolve` (sensitive files refused), text files only, per-file
 * `MENTION_MAX_FILE_CHARS` with the standard truncation marker, and the
 * `MENTION_MAX_TOTAL_CHARS` aggregate cap. Pure IO on the given workspace;
 * never throws for a bad mention — those come back as honest errors.
 */
export function resolveFileMentions(
  task: string,
  workspace: Workspace,
): FileMentionResolution {
  const parsed = parseMentions(task);
  if (parsed.files.length === 0) {
    return { ok: true, plan: { names: [], blocks: [], totalChars: 0 } };
  }
  const errors: string[] = [];
  if (parsed.files.length > MENTION_MAX_FILES) {
    errors.push(
      `too many file mentions (${parsed.files.length}); at most ${MENTION_MAX_FILES} per task`,
    );
  }
  const names: string[] = [];
  const blocks: string[] = [];
  const seen = new Set<string>();
  for (const raw of parsed.files) {
    const rel = normalizeMentionPath(raw);
    if (rel === "") {
      errors.push(`cannot attach file "@${raw}": invalid path`);
      continue;
    }
    if (path.isAbsolute(rel) || rel.startsWith("/") || /^[A-Za-z]:[\\/]/.test(rel)) {
      errors.push(`cannot attach file "@${raw}": absolute paths are not allowed: ${rel}`);
      continue;
    }
    if (rel.split("/").includes("..")) {
      errors.push(`cannot attach file "@${raw}": path escapes the workspace: ${rel}`);
      continue;
    }
    if (seen.has(rel)) continue;
    seen.add(rel);
    let target: string;
    try {
      target = workspace.resolve(rel);
    } catch (exc) {
      errors.push(`cannot attach file "@${raw}": ${messageOf(exc)}`);
      continue;
    }
    let size: number;
    try {
      const stat = fs.statSync(target);
      if (!stat.isFile()) {
        errors.push(`cannot attach file "@${raw}": not a file: ${rel}`);
        continue;
      }
      size = stat.size;
    } catch (exc) {
      errors.push(`cannot attach file "@${raw}": ${messageOf(exc)}`);
      continue;
    }
    let read: { text: string; truncated: boolean };
    try {
      read = readBoundedFileText(target, MENTION_MAX_FILE_CHARS * 4, size);
    } catch (exc) {
      errors.push(`cannot attach file "@${raw}": ${messageOf(exc)}`);
      continue;
    }
    if (read.text.includes("\u0000")) {
      errors.push(`cannot attach file "@${raw}": not a text file`);
      continue;
    }
    names.push(rel);
    blocks.push(renderFileBlock(rel, read.text, { truncated: read.truncated }));
  }
  const totalChars = blocks.reduce((total, block) => total + block.length, 0);
  if (totalChars > MENTION_MAX_TOTAL_CHARS) {
    errors.push(
      `attached file content is too large (${totalChars} > ${MENTION_MAX_TOTAL_CHARS} chars)`,
    );
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, plan: { names, blocks, totalChars } };
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
  // A native registry command always wins its own name (see `keymap.ts`): a
  // discovered `<name>.md` template reusing a native slash name (`provider.md`,
  // `help.md`, …) would either shadow the native surface in the palette/help/
  // `/` picker or silently turn it into a task, so it is dropped from the TUI
  // catalog before any surface reads it. `/provider` stays the native connect
  // surface even when such a template exists.
  const nativeSlashTokens = tuiNativeCommandTokens();
  const shadowed = commands.commands.filter((command) =>
    nativeSlashTokens.has(command.name.toLowerCase()),
  );
  for (const command of shadowed) {
    commands.diagnostics.push(
      `ignored command "${command.name}": it shadows a native TUI command and native commands win`,
    );
  }
  if (shadowed.length > 0) {
    commands.commands = commands.commands.filter(
      (command) => !nativeSlashTokens.has(command.name.toLowerCase()),
    );
  }
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

/**
 * Build one role's provider for a TUI-local action (the manual `/compact`
 * pass). Mirrors the harness's per-role endpoint construction so it talks to
 * the same endpoint a turn would: the resolved endpoint (`providers.ts`) wins,
 * with the run config as the per-field fallback; a preset kind is intrinsic to
 * its URL and wins, else the role/run-level kind chain applies. Throws on an
 * invalid provider configuration; callers report it honestly.
 */
function tuiRoleProvider(
  cfg: Config,
  endpoints: RoleEndpoints,
  role: "senior" | "junior",
  onWarning?: (line: string) => void,
): Provider {
  const endpoint = endpoints[role];
  const provider = endpoint.provider || cfg.provider;
  if (provider === "mock") return new MockProvider();
  if (provider !== "openai") throw new Error(`unknown provider: ${provider}`);
  const kind = endpoint.kind
    ? resolveProviderKind({ kind: endpoint.kind, seniorKind: "", juniorKind: "" }, role)
    : resolveProviderKind(cfg, role);
  const roleBaseUrl = role === "senior" ? cfg.seniorBaseUrl || cfg.baseUrl : cfg.juniorBaseUrl || cfg.baseUrl;
  const roleApiKey = role === "senior" ? cfg.seniorApiKey || cfg.apiKey : cfg.juniorApiKey || cfg.apiKey;
  const config: ProviderConfig = {
    provider,
    kind,
    seniorKind: "",
    juniorKind: "",
    baseUrl: endpoint.baseUrl || roleBaseUrl,
    apiKey: endpoint.apiKey || roleApiKey,
    seniorModel: cfg.seniorModel,
    juniorModel: cfg.juniorModel,
    temperature: cfg.temperature,
    timeout: cfg.timeout,
    retries: cfg.retries,
    contextWindow: cfg.contextWindow,
    maxTokens: maxTokensForRole(cfg, role),
    model: endpoint.model || (role === "senior" ? cfg.seniorModel : cfg.juniorModel),
    ...(onWarning !== undefined ? { onWarning } : {}),
  };
  return buildProvider(config, role);
}

interface TurnSetup {
  cfg: Config;
  mode: Config["mode"];
  /**
   * Effective per-role endpoints for this turn, resolved from the persisted
   * settings store (+ flags/env) by `providers.ts` — the same resolution
   * `serve` uses. The harness builds both role providers from these.
   */
  endpoints: RoleEndpoints;
  resources: TuiResources;
  mcpConfig?: string;
  streamTokens?: boolean;
  signal?: AbortSignal;
  /**
   * The turn's confined workspace (`tui --workspace`). Its `workspace_*` tools
   * become the junior's belt and the senior's read-only verify slice; plugin
   * bindings see the same workspace.
   */
  workspace?: Workspace;
  /**
   * Typed runtime events of this turn (the harness `onEvent` hook): the app
   * watches `todo_updated` for the docked plan panel. Optional so callers that
   * only stream envelopes stay unchanged.
   */
  onRuntimeEvent?: (event: RuntimeEvent) => void;
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
  const endpoints = setup.endpoints;
  validateRunConfig(cfg, endpoints);

  let bindings: PluginBindings | null = null;
  if (setup.resources.plugins !== null) {
    try {
      bindings = await setup.resources.plugins.bindingsFor(
        [...setup.resources.plugins.plugins.keys()],
        setup.workspace ?? null,
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
  const compaction = compactionSettingsFromConfig(cfg);
  const harness = new TwoBrothersHarness(cfg, {
    ...(setup.workspace !== undefined ? { workspace: setup.workspace } : {}),
    ...(hasScopes ? { toolScopes } : {}),
    endpoints,
    ...(compaction ? { compaction } : {}),
    ...(bindings !== null ? { hooks: bindings.hooks } : {}),
    ...(setup.resources.skills.skills.length > 0 ? { skills: setup.resources.skills } : {}),
    ...(setup.onRuntimeEvent !== undefined ? { onEvent: setup.onRuntimeEvent } : {}),
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
  | { kind: "provider"; state: ProviderConnectState; data: ProviderConnectData }
  | { kind: "dialog"; state: DialogState; onAction: (id: string) => void };

interface UsageSnapshot {
  input: number;
  output: number;
  cached: number;
  cacheWrite: number;
  calls: number;
}

const SPINNER_MS = 120;
const TOKEN_RENDER_MS = 40;

/**
 * Render budget of one transient status hint: the render that publishes it
 * consumes one unit, so the copy is visible for a few frames and then the
 * rotating projection hint returns. Deliberately a render count, never a clock,
 * so the same interaction sequence is reproducible in tests.
 */
const TRANSIENT_HINT_RENDERS = 6;

/** Transient copy after a turn is stopped; the exit chord comes from the registry. */
export const CANCELLED_TURN_HINT = `turn stopped — ${hintSegments(TUI_COMMANDS, [
  { id: "exit", label: "exits" },
])}`;

/** Status-bar text while a quit chord is armed (reset verbatim on disarm). */
const QUIT_ARMED_ACTIVITY = "quit? press Ctrl+C or Esc again to exit (any other key cancels)";

/** Internal control-flow signal for quit handed out of the key loop. */
class TuiExit extends Error {
  constructor() {
    super("tui exit");
    this.name = "TuiExit";
  }
}

/**
 * True when a chord is one printable, unmodified character. The help command's
 * printable chord is typing when the composer has text (the long-standing "?"
 * rule, generalized to whatever chord a keys file gives help).
 */
function isSinglePrintableKeyChord(chord: KeyChord): boolean {
  if (chord.ctrl === true || chord.alt === true || chord.shift === true) return false;
  const units = [...chord.name];
  return (
    units.length === 1 &&
    !/[\u0000-\u001f\u007f\s]/u.test(chord.name)
  );
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
    cacheWrite: num("cache_write_tokens"),
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
  /** One resolved registry table for matching, labels, palette/help and hints. */
  let commands = options.commands ?? TUI_COMMANDS;
  // `/keys` state: the captured source is reloaded on demand; the diagnostics
  // and load state are the last attempt's (startup or latest reload/auto-reload).
  // A failed reload keeps the previous table (see `reloadTuiCommands`).
  let keysSource: TuiKeysSource | null = options.keysSource ?? null;
  let keysState: TuiKeysLoadState | "none" =
    options.keysState ?? (keysSource === null ? "none" : "loaded");
  let keysDiagnostics: readonly string[] = options.keysDiagnostics ?? [];
  // The opt-in file watcher: `off` unless `--keys-watch`/the pinned env asked
  // for it; there is nothing to watch when an embedding injected commands
  // directly (honest `unavailable`). `/keys show` reports this state.
  let keysWatchState: TuiKeysWatchState = keysSource === null ? "unavailable" : "off";
  let keysWatcher: TuiKeysWatchHandle | null = null;
  // `tui --workspace <dir>`: validate the confined root before the screen is
  // built. A bad root is a clear startup error (exit 2) and never opens the
  // alternate screen; an omitted flag keeps the TUI exactly as before.
  let workspaceRoot: string | null = null;
  let mentionWorkspace: Workspace | null = null;
  if (options.workspaceRoot !== undefined && options.workspaceRoot.trim() !== "") {
    try {
      mentionWorkspace = new Workspace(options.workspaceRoot);
      workspaceRoot = mentionWorkspace.root;
    } catch (exc) {
      options.io.error(`[error] ${messageOf(exc)}`);
      return 2;
    }
  }
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

  /**
   * Persisted provider settings + the effective per-role endpoints (the same
   * `SettingsStore`/`RuntimeSettings`/`resolveRoleEndpoints` stack `serve`
   * uses; see `providers.ts`). Loaded once at startup and re-resolved before
   * every turn/compaction, so a provider connected through the web Settings,
   * `onboard` or a previous TUI run is picked up without a restart — and with
   * the decrypted stored key, never a flag.
   */
  const providerStore = createProviderStore(sessionsDir);
  /** Per-session `/models` choices: operator-explicit, never persisted. */
  const sessionModelOverrides: Partial<Record<"senior" | "junior", string>> = {};
  let providerState: TuiProviderState = loadTuiProviderState({
    store: providerStore,
    cfg: sessionCfg,
  });
  const refreshProviderState = (): TuiProviderState => {
    providerState = loadTuiProviderState({
      store: providerStore,
      cfg: sessionCfg,
      modelOverrides: sessionModelOverrides,
    });
    return providerState;
  };

  /**
   * The persisted operator approval mode, read fresh for every turn/compaction
   * and for `/permission`, so a change made in another surface (web Settings,
   * a previous TUI run) applies without a restart. `SettingsStore` reads the
   * section fail-closed (missing/corrupt/unknown => `ask`); a read error is
   * treated the same way, never as a more permissive mode.
   */
  const currentApprovalMode = (): ApprovalMode => {
    if (options.approvalMode !== undefined) return options.approvalMode;
    try {
      return providerStore.readApprovalPolicy();
    } catch {
      return DEFAULT_APPROVAL_MODE;
    }
  };

  /** Process-pinned mode (flag/env); absent means the saved setting applies. */
  const pinnedApprovalMode = options.approvalMode;

  /**
   * Persist one operator approval mode (the only TUI write path; it can never
   * arrive from a model reply or a tool call). Returns an error message when
   * the save failed, or null on success — the caller decides how to report it.
   */
  const saveApprovalMode = (mode: ApprovalMode): string | null => {
    try {
      providerStore.writeApprovalPolicy(mode);
      return null;
    } catch (exc) {
      return messageOf(exc);
    }
  };

  /**
   * The runtime sidecar store for plan snapshots. It is the server's store
   * directory: `serve` runs and TUI turns both write `todo_updated` snapshots
   * here (the TUI writes only plan snapshots — see `todoPersist.ts`), so the
   * plan of a session is durable across a TUI restart with the same file.
   */
  const runtimeStore = new RuntimeEventStore(path.join(sessionsDir, "runtime"));

  /**
   * The last persisted plan snapshot for one session file, replayed from the
   * session's runtime sidecar (`sessions/runtime/<session file>.events.jsonl`).
   * Both a `two-brothers serve` backend and this TUI's turns write that
   * sidecar (TUI turns persist plan snapshots only). Fail-soft: a
   * missing/unreadable sidecar is an empty plan, never an error.
   */
  function loadSessionTodos(sessionFile: string): TodoItem[] {
    // `RuntimeEventStore` appends `.events.jsonl` to its key and session file
    // names include the extension, so the sidecar is
    // `sessions/runtime/<session file>.events.jsonl`.
    const name = sessionSidecarKey(sessionFile);
    if (!name) return [];
    try {
      return todosFromRuntimeEvents(runtimeStore.load(name));
    } catch {
      return [];
    }
  }

  /**
   * Read-only replay of the displayed session's persisted reasoning records
   * (the wave-7 `reasoning` runtime events a STREAMING serve/CLI run wrote to
   * the same runtime sidecar). The TUI shows them as dim `THINKING (replayed)`
   * blocks above the transcript blocks; it never writes a reasoning event and
   * live thinking is untouched. Fail-soft and bounded (the loader keeps the
   * newest records only, with an honest hidden count).
   */
  let replayedReasoning: readonly ReplayedReasoning[] = [];
  let hiddenReplayedReasoning = 0;
  function loadSessionReasoningFor(sessionFile: string): void {
    const loaded = loadSessionReasoning(runtimeStore, sessionFile);
    replayedReasoning = loaded.blocks;
    hiddenReplayedReasoning = loaded.hidden;
  }

  /**
   * This process's live plan snapshots, keyed by the resolved session file.
   * The sidecar is durable, but the cache keeps session switching instant and
   * covers in-memory sessions (no file, nothing to persist).
   */
  const planCache = new Map<string, TodoItem[]>();

  /** Remember the live plan of `sessionFile` for the rest of this process. */
  function rememberTodos(sessionFile: string, snapshot: readonly TodoItem[]): void {
    if (sessionFile === "") return;
    const key = path.resolve(sessionFile);
    // Bounded: a long session-hopping process must not grow this map forever.
    if (!planCache.has(key) && planCache.size >= 32) {
      const oldest = planCache.keys().next();
      if (!oldest.done) planCache.delete(oldest.value);
    }
    planCache.set(key, [...snapshot]);
  }

  /** The plan to show for `sessionFile`: this process's snapshot first, else the sidecar. */
  function planForSession(sessionFile: string): TodoItem[] {
    if (sessionFile === "") return [];
    const cached = planCache.get(path.resolve(sessionFile));
    if (cached !== undefined) return [...cached];
    return loadSessionTodos(sessionFile);
  }

  const slashInfos = (): SlashCommandInfo[] =>
    resources.commands.commands.map((command: Command) => ({
      name: command.name,
      description: command.description,
      ...(command.argumentHint ? { argumentHint: command.argumentHint } : {}),
      ...(command.mode ? { mode: command.mode } : {}),
    }));

  /**
   * First-party base commands this TUI surfaces: native keymap commands and
   * discovered templates keep their names (they shadow the base catalogue), so
   * only `/plan`, `/goal`, `/feedback`, `/compact`, `/export`, `/permission`,
   * `/status` and `/new` are added.
   */
  const baseCommandList = (): BaseCommand[] => tuiBaseCommands({ templates: slashInfos(), commands });

  /** Help entries: registry keys + discovered templates + base commands. */
  const helpOverlayEntries = (): PaletteEntry[] => [
    ...helpEntries(commands, { commands: slashInfos(), running }),
    ...tuiBasePaletteEntries(baseCommandList()),
  ];

  let mode: Config["mode"] = sessionCfg.mode;
  // A resumed compacted session carries `<summary>` context envelopes: show
  // them as neutral SUMMARY markers (never as an operator message). An
  // uncompacted context yields the empty model, byte-identical to before.
  let model: TuiModel = createCompactionSummaryModel(context.events);
  /**
   * Provider resolution warnings (a dangling `provider_ref`, an unreadable
   * settings document): shown honestly at startup and again only when a
   * per-turn refresh produces a NEW line — never hidden and never spammed.
   */
  const providerWarningsSeen = new Set<string>();
  const showProviderWarnings = (): void => {
    const warnings = [
      ...providerState.warnings,
      ...(providerState.loadError !== undefined ? [providerState.loadError] : []),
    ];
    for (const warning of warnings) {
      if (providerWarningsSeen.has(warning)) continue;
      providerWarningsSeen.add(warning);
      model = addNotice(model, "warn", `provider: ${warning}`);
    }
  };
  showProviderWarnings();
  /** Effective role summaries from the latest provider resolution. */
  const providerSummaries = () => providerRoleSummaries(providerState, sessionCfg);
  // The current conversation's plan (the latest `todo_updated` snapshot). A
  // resumed session replays the runtime sidecar (written by a serve backend or
  // by this TUI's own turns); live writes replace it, persist it and are
  // remembered across session switches.
  let todos: TodoItem[] = planForSession(sessionCfg.sessionFile);
  // Persisted reasoning of the session being opened: a read-only sidecar
  // replay shown as bounded `THINKING (replayed)` blocks (streaming-only
  // records; a non-streaming run simply has none).
  loadSessionReasoningFor(sessionCfg.sessionFile);
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
  // Find (Ctrl+F) is an inline bar rather than a modal overlay: it keeps the
  // composer visible, owns the keyboard while open, and restores the exact
  // pre-find viewport and draft on close.
  let find: FindState | null = null;
  let findModel: TuiModel | null = null;
  let findReturnScroll: TranscriptScroll = latestTranscriptScroll();
  // The inline `/` command and `@skill:` mention picker. It owns the composer
  // keys while open, mirrors its filter into the draft, and is hidden whenever
  // a modal overlay is up.
  let mention: MentionPickerState | null = null;
  let running = false;
  /** `/compact` is an in-process background pass: turns wait for it. */
  let compacting = false;
  let turnAbort: AbortController | null = null;
  let turnDone: Promise<void> | null = null;
  let lastFailedTask: { task: string; turnMode: Config["mode"] } | null = null;
  let usage: UsageSnapshot | null = null;
  let cost: number | null = null;
  let contextTokens: number | null = null;
  let turnStartedAt = 0;
  let lastElapsedMs: number | undefined;
  let activity = "ready — type a task and press Enter";
  /**
   * Monotonic turn counter behind the deterministic status-bar tip rotation.
   * One accepted turn advances the rotation one tip; it is app state, never a
   * clock or a random source, so the same turn sequence renders the same tips.
   */
  let tipStep = 0;
  /**
   * One-shot status hint shown for a bounded number of renders after an event
   * (a stopped turn), then the rotating hint returns. The app owns the event and
   * the TTL; the pure status bar only renders the text it is given.
   */
  let transientHint: { text: string; remaining: number } | null = null;
  let quitArmed = false;
  /** Last repeat-sensitive keypress (composer submit/mention accept). */
  let lastRepeatGuard: RepeatGuardSnapshot | null = null;
  let lastRenderAt = 0;
  let spinnerTick = 0;
  let toastSeq = 0;
  let toasts: Toast[] = [];
  let themeMode: ThemeMode | null = null;
  let theme: Theme = resolveTheme({ mode: themeMode });
  // The `panel` registry command's choice for this run: null = no choice yet
  // (the panel follows the terminal size), false = hidden, true = shown.
  let sidePanelChoice: boolean | null = null;
  /**
   * A pending operator approval: set from the turn broker's
   * `approval_requested`, cleared by `approval_resolved`. While set, the
   * approval panel replaces the composer and owns the decision keys; closing
   * an overlay never answers it.
   */
  let approval: ApprovalPanelState | null = null;
  /** The running turn's approval broker — the only approval authority. */
  let activeBroker: RunApprovalBroker | null = null;
  /**
   * `approvalPairKey` pairs the operator allowed "for this session" in this
   * TUI process. Memory only: seeded into each new per-turn broker so an
   * identical request does not park again, and never persisted to settings.
   */
  const sessionAllows = new Map<string, { action: string; target: string }>();

  /**
   * The workspace file index for the composer `@path` picker. Re-indexed when
   * a file picker opens so files created during the session are findable; a
   * missing/unreadable root yields an empty index (fail-soft).
   */
  const workspaceFilesForPicker = (): WorkspaceFileEntry[] => {
    if (workspaceRoot === null) return [];
    try {
      return indexWorkspaceFiles(workspaceRoot).files;
    } catch {
      return [];
    }
  };

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
   * Publish a one-shot status hint for the next few renders. The caller decides
   * the event and the TTL; the hint takes the status bar's hint slot until it
   * expires, then the rotating tip returns (no clock, no background timer).
   */
  const showTransientHint = (text: string, renders = TRANSIENT_HINT_RENDERS): void => {
    const clean = text.trim();
    if (clean === "") {
      transientHint = null;
      return;
    }
    transientHint = { text: clean, remaining: Math.max(1, Math.floor(renders)) };
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

  /**
   * The status bar's projection hint string: one rotating, registry-derived
   * high-value tip per accepted turn (`tipStep`), led by the fold action the
   * newest tool row's state allows ("expand tool" / "collapse tool") whenever a
   * tool row is on screen. Chords come from the registry, never a literal here,
   * and the fold action is removed from the rotation so it never repeats.
   */
  const statusHints = (): string | undefined => {
    const fold = toolFoldHint(model, toolExpansion);
    return composeStatusHints(commands, tipStep, {
      running,
      ...(fold !== null ? { fold: { commandId: fold.commandId, label: fold.label } } : {}),
    });
  };

  const statusState = (): StatusBarState => {
    const hints = statusHints();
    const [seniorRole, juniorRole] = providerSummaries();
    const transient = transientHintFor({
      approvalParked: approval !== null,
      ...(transientHint !== null ? { transient: transientHint.text } : {}),
    });
    return {
      mode,
      seniorModel: seniorRole.model,
      juniorModel: juniorRole.model,
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
      ...(hints !== undefined ? { hints } : {}),
      ...(transient !== undefined ? { transientHint: transient } : {}),
    };
  };

  /** The compaction configuration as the harness will see it (no new math). */
  const sidePanelCompaction = (): SidePanelCompaction => {
    const settings = compactionSettingsFromConfig(sessionCfg);
    if (settings === undefined) return { mode: "off" };
    const tokenMode =
      (settings.thresholdTokens ?? 0) > 0 || (settings.contextWindow ?? 0) > 0;
    const summary: SidePanelCompaction = { mode: tokenMode ? "tokens" : "chars" };
    if (settings.force === true) summary.force = true;
    if (tokenMode) {
      const threshold =
        (settings.thresholdTokens ?? 0) > 0 ? settings.thresholdTokens : settings.contextWindow;
      if (threshold !== undefined && threshold > 0) summary.threshold = threshold;
      summary.keepRecent = DEFAULT_KEEP_RECENT_TOKENS;
    } else {
      if ((settings.thresholdChars ?? 0) > 0) summary.threshold = settings.thresholdChars;
      summary.keepRecent = settings.keepRecentChars ?? DEFAULT_KEEP_RECENT_CHARS;
    }
    return summary;
  };

  /** Discovery counts the session already loaded (plugins/skills/commands/MCP). */
  const sidePanelDiscovery = (): SidePanelDiscovery => {
    const plugins = resources.plugins;
    const skills = resources.skills.skills;
    const pluginServers =
      plugins === null
        ? 0
        : [...plugins.plugins.values()].reduce(
            (total, plugin) => total + plugin.mcpServers.length,
            0,
          );
    return {
      ...(plugins !== null
        ? { plugins: { loaded: plugins.plugins.size, errors: plugins.errors.length } }
        : {}),
      skills: {
        shared: skills.filter((skill) => skill.scope === "shared").length,
        senior: skills.filter((skill) => skill.scope === "senior").length,
        junior: skills.filter((skill) => skill.scope === "junior").length,
      },
      commands: resources.commands.commands.length,
      mcp: {
        ...(options.mcpConfig !== undefined ? { configPath: options.mcpConfig } : {}),
        pluginServers,
      },
    };
  };

  const sidePanelState = (): SidePanelState => {
    const [seniorRole, juniorRole] = providerSummaries();
    // One shared provider label when both roles agree; otherwise say so
    // honestly instead of pretending one provider covers both.
    const provider =
      seniorRole.provider === juniorRole.provider
        ? seniorRole.provider
        : `${seniorRole.provider} / ${juniorRole.provider}`;
    return {
      mode,
      seniorModel: seniorRole.model,
      juniorModel: juniorRole.model,
      seniorKind: seniorRole.kind,
      juniorKind: juniorRole.kind,
      provider,
      sessionName: sessionName(),
      resume: sessionCfg.resume,
      cwd,
      running,
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
      compaction: sidePanelCompaction(),
      discovery: sidePanelDiscovery(),
    };
  };

  /**
   * The `panel` command: flip the in-memory choice and say honestly whether
   * the terminal is big enough for the panel to appear right now.
   */
  const toggleSidePanel = (): void => {
    sidePanelChoice = toggleSidePanelEnabled(sidePanelChoice);
    const shown = sidePanelChoice === true;
    const size = terminal.size();
    const fits = sidePanelLayout(size.columns, size.rows).visible;
    if (shown && !fits) {
      pushToast(
        "info",
        `status panel needs ${SIDE_PANEL_MIN_WIDTH}×${SIDE_PANEL_MIN_HEIGHT} — ` +
          "it appears when the terminal grows",
      );
    } else if (shown) {
      pushToast("info", "status panel shown");
    } else {
      pushToast(
        "info",
        fits
          ? "status panel hidden"
          : "status panel hidden — this terminal is too small to show it",
      );
    }
    render();
  };

  /** Transcript columns after the panel (full width whenever it is hidden). */
  const transcriptWidth = (): number => {
    const size = terminal.size();
    return sidePanelLayout(size.columns, size.rows, {
      enabled: sidePanelChoice !== false,
    }).transcriptWidth;
  };

  function transcriptBodyHeight(): number {
    const size = terminal.size();
    return Math.max(1, size.rows - 14);
  }

  const overlayLines = (columns: number, rows: number): string[] | undefined => {
    if (overlay === null) return undefined;
    if (overlay.kind === "palette") {
      const boxW = Math.max(30, Math.min(Math.max(columns - 4, 30), 76));
      const boxH = Math.max(8, Math.min(Math.max(rows - 4, 8), 22));
      const entries = paletteEntries(commands, { commands: slashInfos(), running });
      const lines = paletteView(commands, overlay.state, entries, {
        width: Math.max(10, boxW - 4),
        height: Math.max(3, boxH - 2),
        title: "Commands",
        theme,
      }).lines;
      return renderBox(lines, { width: boxW, title: "COMMANDS", theme });
    }
    if (overlay.kind === "help") {
      const boxW = Math.max(30, Math.min(Math.max(columns - 4, 30), 80));
      const boxH = Math.max(8, Math.min(Math.max(rows - 4, 8), 24));
      const entries = helpOverlayEntries();
      const lines = helpView(commands, overlay.state, entries, {
        width: Math.max(10, boxW - 4),
        height: Math.max(3, boxH - 2),
        title: "Help",
        theme,
      }).lines;
      return renderBox(lines, { width: boxW, title: "HELP", theme });
    }
    if (overlay.kind === "history-search") {
      const boxW = Math.max(30, Math.min(Math.max(columns - 4, 30), 72));
      const boxH = Math.max(6, Math.min(Math.max(rows - 4, 6), 14));
      const lines = historySearchView(overlay.state, {
        width: Math.max(10, boxW - 4),
        height: Math.max(3, boxH - 2),
        commands,
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
        commands,
      }).lines;
    }
    if (overlay.kind === "provider") {
      const boxW = Math.max(30, Math.min(Math.max(columns - 8, 30), 76));
      const boxH = Math.max(10, Math.min(Math.max(rows - 6, 10), 22));
      return providerConnectView(overlay.state, overlay.data, {
        width: boxW,
        height: boxH,
        theme,
        commands,
      }).lines;
    }
    const boxW = Math.max(30, Math.min(Math.max(columns - 8, 30), 72));
    const boxH = Math.max(8, Math.min(Math.max(rows - 6, 8), 20));
    return dialogView(overlay.state, { width: boxW, height: boxH, theme }).lines;
  };

  function render(): void {
    refreshFindState();
    const size = terminal.size();
    const findBar = find === null
      ? undefined
      : findBarView(find, { width: size.columns, theme, commands }).lines;
    const findBlockId = find === null ? undefined : activeFindMatch(find)?.match.blockId;
    // The inline picker is a composer affordance, never a modal surface: it is
    // hidden while any overlay is up or while an approval owns the footer.
    const mentionRows = overlay === null && approval === null && mention !== null
      ? mentionPickerView(mention, { width: size.columns, theme, commands }).lines
      : undefined;
    // A parked approval replaces the composer (the run needs an answer, not a
    // draft); closing an overlay above it never answers it.
    const approvalRows = approval === null
      ? undefined
      : approvalPanelView(approval, { width: size.columns, theme, commands }).lines;
    // The model's plan is display-only state: a dock above the composer that
    // never takes a key and never replaces the composer.
    const todoRows = todos.length === 0
      ? undefined
      : todoPanelView(todos, { width: size.columns, theme }).lines;
    const frame = screenView({
      width: size.columns,
      height: size.rows,
      model: withToolExpansion(model, toolExpansion),
      editor,
      status: statusState(),
      theme,
      commands,
      scroll,
      overlay: overlayLines(size.columns, size.rows),
      ...(approvalRows !== undefined ? { approvalPanel: approvalRows } : {}),
      ...(todoRows !== undefined ? { todoPanel: todoRows } : {}),
      ...(mentionRows !== undefined ? { mentionPicker: mentionRows } : {}),
      ...(findBar !== undefined ? { findBar } : {}),
      ...(findBlockId !== undefined ? { findBlockId } : {}),
      // Read-only sidecar replay: an empty set adds no option, so the frame is
      // byte-identical to the pre-replay layout.
      ...(replayedReasoning.length > 0
        ? {
            replayedReasoning,
            ...(hiddenReplayedReasoning > 0 ? { hiddenReplayedReasoning } : {}),
          }
        : {}),
      toasts,
      spinnerTick,
      reducedMotion: process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "",
      sidePanel: sidePanelState(),
      sidePanelEnabled: sidePanelChoice !== false,
    });
    terminal.render(frame.lines.join("\n"));
    // The transient slot is a bounded render budget, not a timer: this render
    // showed the hint and consumes one unit, and the rotating tip returns when
    // the budget runs out (or immediately when no hint is pending).
    if (transientHint !== null) {
      transientHint = transientHint.remaining > 1
        ? { text: transientHint.text, remaining: transientHint.remaining - 1 }
        : null;
    }
  }

  const onStreamEvent = (event: StreamEvent): void => {
    const previousThinking = model.liveThinking;
    const reduced = reduceModelEvent(model, event);
    model = reduced.model;
    if (reduced.status !== undefined) activity = reduced.status;
    const now = Date.now();
    // A new reasoning buffer (first thinking delta, or a new call after the
    // previous one's text) must paint immediately even when provider deltas
    // arrive in a burst; the first visible-text delta that completes the
    // reasoning does the same so the live "…" marker settles at once. Every
    // other token delta keeps the existing 40 ms render throttle.
    const startedThinking =
      event.type === "token" &&
      event.kind === "thinking" &&
      model.liveThinking !== undefined &&
      (previousThinking === undefined ||
        previousThinking.role !== model.liveThinking.role ||
        previousThinking.streaming === false);
    const settledThinking =
      event.type === "token" &&
      event.kind !== "thinking" &&
      previousThinking?.streaming === true;
    if (
      startedThinking ||
      settledThinking ||
      event.type !== "token" ||
      now - lastRenderAt >= TOKEN_RENDER_MS
    ) {
      lastRenderAt = now;
      render();
    }
  };

  const onWarning = (line: string): void => {
    model = addNotice(model, "warn", line);
  };

  // --------------------------------------------------------------------- //
  // operator approvals (workspace-bound turns only)
  // --------------------------------------------------------------------- //

  /**
   * Answer the pending approval through the turn's broker. The app is the only
   * caller of the broker's operator API; a decision resolves the parked tool
   * exactly once, and the broker's `approval_resolved` event clears the panel.
   */
  const answerApproval = (decision: "allow" | "session" | "deny"): void => {
    const current = approval;
    const broker = activeBroker;
    if (current === null) return;
    if (broker === null) {
      approval = null;
      model = addNotice(model, "warn", "the approval's turn is no longer running");
      render();
      return;
    }
    const approvalId = current.item.approvalId;
    if (decision === "session") {
      // Remember the pair for this TUI process BEFORE resolving, so the next
      // identical request is auto-allowed; the broker itself stays in-memory.
      const pair = broker.sessionPairKey(approvalId);
      if (pair !== null) {
        sessionAllows.set(pair, {
          action: current.item.action,
          target: current.item.target ?? current.item.command ?? "",
        });
        broker.allowForSession(approvalId);
      }
    } else {
      broker.respond(approvalId, decision === "allow" ? Decision.ALLOW : Decision.DENY);
    }
    render();
  };

  /** `Ctrl+E`: the full-screen preview for a pending write/edit/shell request. */
  const openApprovalPreview = (): void => {
    if (approval === null) return;
    const preview = approvalPreview(approval.item);
    if (preview === null) {
      pushToast("info", "nothing to preview for this approval");
      render();
      return;
    }
    overlay = {
      kind: "dialog",
      state: createDialog({
        title: preview.title,
        message: preview.message,
        details: preview.details,
        showDetails: true,
        tone: "warning",
        actions: [{ id: "close", label: "Close" }],
      }),
      // Closing the preview NEVER answers the request: the panel stays parked.
      onAction: () => {},
    };
    render();
  };

  /** Fold one keypress into the parked approval panel (its own key scope). */
  const handleApprovalKey = (key: Key): void => {
    if (approval === null) return;
    const result = approvalPanelKey(commands, approval, key);
    approval = result.state;
    switch (result.action) {
      case "move":
        render();
        return;
      case "preview":
        openApprovalPreview();
        return;
      case "allow":
        answerApproval("allow");
        return;
      case "allow-session":
        answerApproval("session");
        return;
      case "deny":
        answerApproval("deny");
        return;
      default:
        return;
    }
  };

  /**
   * Resolve every pending approval as deny (turn cancelled / app torn down).
   * A stopped run must never leave a mutation parked mid-approval; these are
   * cancellations, not operator answers, so they never consume the deny cap.
   */
  const denyPendingApprovals = (reason: string): void => {
    const broker = activeBroker;
    activeBroker = null;
    approval = null;
    broker?.denyAll(reason);
  };

  /**
   * Start one turn. `prompt` is the user-facing submission to remember in
   * history (raw composer text, a CLI task, or a palette template) and is
   * deliberately separate from the expanded `task`. Only a turn that actually
   * starts records history; retry replays the same task without a new entry.
   * Returns false when the turn was refused (mention validation or a defensive
   * running guard) and nothing was recorded.
   */
  const executeTurn = (task: string, turnMode: Config["mode"], prompt?: string): boolean => {
    if (running || compacting) {
      // Defensive only — submitEditor refuses before reaching here, so the
      // caller's draft is never dropped by this guard.
      model = addNotice(
        model,
        "warn",
        compacting
          ? "compaction is running — wait for it to finish before sending a task"
          : "a turn is still running — wait for it to finish",
      );
      render();
      return false;
    }
    // Validate `@skill:` and `@<path>` mentions before anything is recorded or
    // started: an unknown or role-scoped skill, or an unresolvable/oversized
    // file, refuses the whole task (the same rules the server path enforces).
    // File mentions need the bound workspace; without one they stay literal
    // task text exactly as before.
    const attachment = resolveSkillMentions(task, resources.skills);
    if (!attachment.ok) {
      for (const error of attachment.errors) {
        model = addNotice(model, "error", error);
      }
      activity = "skill mention refused — fix the task and send it again";
      render();
      return false;
    }
    let fileAttachment: FileAttachmentPlan | null = null;
    if (workspaceRoot !== null && mentionWorkspace !== null) {
      const files = resolveFileMentions(task, mentionWorkspace);
      if (!files.ok) {
        for (const error of files.errors) {
          model = addNotice(model, "error", error);
        }
        activity = "file mention refused — fix the task and send it again";
        render();
        return false;
      }
      if (files.plan.blocks.length > 0) fileAttachment = files.plan;
    }
    if (prompt !== undefined) rememberPrompt(prompt);
    model = addUserBlock(model, task);
    scroll = latestTranscriptScroll();
    running = true;
    // Advance the deterministic footer-tip rotation once per accepted turn.
    // The step is app state (never a clock), so the same turn sequence always
    // shows the same tips and tests can reproduce a frame exactly.
    tipStep += 1;
    quitArmed = false;
    turnStartedAt = Date.now();
    lastRenderAt = 0;
    activity = `running (${turnMode})…`;
    const controller = new AbortController();
    turnAbort = controller;
    // Attach the validated mention blocks to the shared context BEFORE the run.
    // The operator task is appended first so `renderTranscript`'s [[TASK]]
    // extraction is unchanged; `harness.run` sees the task already present and
    // does not append a duplicate. Skills come first, then files (the server
    // order), and identical blocks are never re-attached, so a retry does not
    // grow the context.
    const fileAttachmentPlan = fileAttachment;
    if (attachment.plan.blocks.length > 0 || fileAttachmentPlan !== null) {
      try {
        const hasMessage = (text: string): boolean =>
          context.events.some(
            (event) =>
              event.from === "user" &&
              event.kind === "message" &&
              String(event.payload.text ?? "") === text,
          );
        if (!hasMessage(task)) {
          context.makeAndAppend("user", "senior", "message", { text: task });
        }
        const blocks = [
          ...attachment.plan.blocks,
          ...(fileAttachmentPlan?.blocks ?? []),
        ];
        for (const block of blocks) {
          if (hasMessage(block)) continue;
          context.makeAndAppend("user", "senior", "message", { text: block });
        }
        const attached: string[] = [];
        const skillNames = attachment.plan.names;
        const fileNames = fileAttachmentPlan?.names ?? [];
        if (fileNames.length === 0) {
          // Skill-only attachment keeps the exact pre-workspace wording.
          pushToast("info", `skill attached: ${skillNames.join(", ")}`);
        } else {
          if (skillNames.length > 0) attached.push(`skill: ${skillNames.join(", ")}`);
          attached.push(`file: ${fileNames.join(", ")}`);
          pushToast("info", `attached ${attached.join(" · ")}`);
        }
      } catch (exc) {
        model = addNotice(model, "warn", `mention attachment failed: ${messageOf(exc)}`);
      }
    }
    render();
    // Pin the session this turn belongs to: a resume action can replace the
    // session while the run is still unwinding, and a late plan write must be
    // attributed to (and only displayed for) the session that produced it.
    const turnSessionFile = sessionCfg.sessionFile;
    // One run id per turn: every plan snapshot this turn persists shares it.
    const turnRunId = `tui-${randomUUID()}`;
    turnDone = (async () => {
      let turnWorkspace: Workspace | undefined;
      try {
        if (workspaceRoot !== null) {
          // The approval mode is a persisted operator policy, read fresh per
          // turn. It only widens/narrows what the workspace permission layer
          // decides; the workspace confinement and sensitive-path refusals run
          // before it and are untouched. `allow-all` gets one visible warning
          // per turn because it is the only mode that weakens a guardrail.
          const approvalMode = currentApprovalMode();
          // One broker per turn: it emits the approval events the panel renders
          // and is bound to this turn's abort signal, so stopping the turn
          // resolves every parked approval as DENY. Session allows granted in
          // this TUI process are seeded in (memory only, never from settings).
          const broker = new RunApprovalBroker();
          broker.seedSessionAllows([...sessionAllows.keys()]);
          broker.attach((event) => {
            if (event.type === "approval_requested") {
              approval = createApprovalPanelState({
                approvalId: event.approval_id,
                action: String(event.action ?? ""),
                ...(event.target !== undefined && event.target !== ""
                  ? { target: event.target }
                  : {}),
                ...(event.command !== undefined && event.command !== ""
                  ? { command: event.command }
                  : {}),
                ...(event.reason !== undefined && event.reason !== ""
                  ? { reason: event.reason }
                  : {}),
                ...(event.detail !== undefined ? { detail: event.detail } : {}),
              });
              // The panel owns the footer; the inline picker and find bar must
              // not compete with the decision keys.
              mention = null;
              if (find !== null) closeFindBar();
              // Drop any leftover one-shot hint: while the approval is parked
              // the transient slot carries the quit-path copy instead.
              transientHint = null;
              activity = `waiting for approval: ${event.action}${
                event.target !== undefined && event.target !== "" ? ` ${event.target}` : ""
              }`;
              render();
            } else if (event.type === "approval_resolved") {
              const resolvedAction = approval?.item.action ?? "request";
              approval = null;
              activity =
                event.reason === "cancelled"
                  ? "approval cancelled — the turn is stopping"
                  : `approval ${String(event.decision ?? "denied")}: ${resolvedAction}`;
              render();
            } else if (event.type === "approval_auto_allowed") {
              pushToast(
                "info",
                `auto-allowed for this TUI session: ${event.action} ${event.target}`.trim(),
              );
              render();
            } else if (event.type === "approval_auto_denied") {
              pushToast(
                "warn",
                `auto-denied after ${event.count} operator denials: ` +
                  `${event.action} ${event.target}`.trim(),
              );
              render();
            }
          }, controller.signal);
          activeBroker = broker;
          // The persisted mode shapes every workspace permission decision this
          // turn; `ask` is the historical default. The warning is visible, not
          // buried: a silent widening is exactly what this mode must never be.
          const modeWarning = approvalModeWarning(approvalMode);
          if (modeWarning !== null) pushToast("warn", modeWarning);
          turnWorkspace = new Workspace(
            workspaceRoot,
            new PermissionManager(new PermissionPolicy(approvalMode), broker),
          );
        }
        // Re-resolve the provider settings for THIS turn: a provider connected
        // in the web workspace / `onboard` / a previous TUI run is picked up
        // without a restart, and the harness gets the same per-role endpoints
        // `serve` would build (stored keys included, never flags on the wire).
        const turnProviders = refreshProviderState();
        showProviderWarnings();
        const { harness, mcp } = await buildTurnHarness({
          cfg: sessionCfg,
          mode: turnMode,
          endpoints: turnProviders.endpoints,
          resources,
          ...(options.mcpConfig !== undefined ? { mcpConfig: options.mcpConfig } : {}),
          ...(options.streamTokens === true ? { streamTokens: true } : {}),
          ...(turnWorkspace !== undefined ? { workspace: turnWorkspace } : {}),
          signal: controller.signal,
          onStreamEvent,
          onRuntimeEvent: (event) => {
            // Display-only plan state: the latest snapshot replaces the panel.
            if (event.type === "todo_updated") {
              const snapshot = sanitizeTodos(event.todos);
              // Durability: persist the snapshot to this turn session's runtime
              // sidecar (display-only, fail-soft; one line per plan write) so a
              // TUI restart with the same session file shows the last plan.
              persistTodoSnapshot(runtimeStore, turnSessionFile, snapshot, {
                runId: turnRunId,
                at: Math.floor(Date.now() / 1000),
                ...(sessionCfg.verbose ? { onWarning } : {}),
              });
              rememberTodos(turnSessionFile, snapshot);
              if (sessionCfg.sessionFile === turnSessionFile) {
                todos = snapshot;
                render();
              }
            }
          },
          onWarning,
        });
        try {
          const result = await harness.run(task, context);
          usage = usageOf(result.usage);
          lastElapsedMs = Date.now() - turnStartedAt;
          measureContext();
          const estimate = estimateRunCostFromUsage({
            seniorModel: turnProviders.endpoints.senior.model || sessionCfg.seniorModel,
            juniorModel: turnProviders.endpoints.junior.model || sessionCfg.juniorModel,
            seniorFamily: roleProviderKind(sessionCfg, turnProviders.endpoints.senior, "senior"),
            juniorFamily: roleProviderKind(sessionCfg, turnProviders.endpoints.junior, "junior"),
            usage: {
              input_tokens: usage.input,
              output_tokens: usage.output,
              cached_tokens: usage.cached,
              cache_write_tokens: usage.cacheWrite,
            },
          });
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
          // A harness-level connection failure is reported through
          // `result.errors` (not a throw): point at /provider once, keeping the
          // provider's own message above.
          const errorsHint = providerFailureHint(result.errors.join("\n"));
          if (errorsHint !== null) model = addNotice(model, "info", errorsHint);
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
          // A stopped turn is exactly when the exit path needs restating: the
          // status hint slot counts down a few renders and then the rotating
          // tip returns (copy only; the chords themselves are unchanged).
          showTransientHint(CANCELLED_TURN_HINT);
        } else {
          // Keep the provider's real error visible; when it reads like a
          // connection problem, add the actionable path instead of leaving a
          // generic failure: connect with /provider or pass the endpoint flags.
          const hint = providerFailureHint(text);
          model = addNotice(model, "error", text, {
            details: `task: ${task}`,
            retryable: true,
          });
          if (hint !== null) model = addNotice(model, "info", hint);
          activity = hint !== null
            ? "provider connection failed — run /provider to connect a provider"
            : "turn failed — the session is still open";
          if (overlay === null) {
            overlay = {
              kind: "dialog",
              state: createDialog({
                title: hint !== null ? "Provider connection failed" : "Turn failed",
                message: hint !== null ? `${text}\n\n${hint}` : text,
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
        // A turn that ends with anything still parked must deny it: the
        // broker's abort listener already denies a cancellation, and a normal
        // finish has nothing parked. Clearing the broker keeps a stale panel
        // (and a stale approval authority) impossible.
        denyPendingApprovals("cancelled");
        running = false;
        turnAbort = null;
        render();
      }
    })();
    // The turn reports its own errors into the transcript; a rejection here
    // would be a bug, but it must never become an unhandled rejection.
    turnDone.catch(() => {});
    return true;
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

  /** Move the viewport to the active find match's block (when there is one). */
  const syncFindScroll = (): void => {
    const active = find === null ? undefined : activeFindMatch(find);
    if (active !== undefined) scroll = scrollToBlock(active.match.blockId);
  };

  /**
   * Open the inline find bar over the current transcript. The composer draft,
   * the editor history and the transcript document are never touched; the
   * pre-find scroll position is remembered so Escape restores the exact view.
   * A modal overlay keeps its precedence: Ctrl+F is only handled when no
   * overlay is open (the caller already routed the key exclusively).
   */
  const openFindBar = (initialQuery?: string): void => {
    if (overlay !== null || find !== null) return;
    find = openFind(findCorpus(model));
    findModel = model;
    findReturnScroll = scroll;
    if (initialQuery !== undefined && initialQuery.trim() !== "") {
      find = setFindQuery(find, initialQuery.trim());
      syncFindScroll();
    }
    render();
  };

  /** Close the find bar, restoring the pre-find viewport exactly. */
  const closeFindBar = (): void => {
    if (find === null) return;
    find = null;
    findModel = null;
    scroll = findReturnScroll;
    render();
  };

  /**
   * Re-search after the model changed (streaming deltas, new blocks). The
   * query and the active index are kept where they still make sense.
   */
  const refreshFindState = (): void => {
    if (find === null || findModel === model) return;
    find = refreshFind(find, findCorpus(model));
    findModel = model;
    syncFindScroll();
  };

  /** Fold one keypress into the open find bar; Enter/arrows/Esc come from the registry. */
  const handleFindBarKey = (key: KeyLike): void => {
    if (find === null) return;
    const result = findKey(commands, find, key);
    if (result.action === "close") {
      closeFindBar();
      return;
    }
    find = result.state;
    if (result.action === "no-match") {
      pushToast(
        "info",
        find.query === ""
          ? "type a query to search the transcript"
          : `no matches for "${find.query}"`,
      );
    } else if (result.action === "filter" || result.action === "move") {
      syncFindScroll();
    }
    render();
  };

  // --------------------------------------------------------------------- //
  // inline `/` and `@skill:` picker
  // --------------------------------------------------------------------- //

  /**
   * The catalogs the inline picker composes its rows from (once per open).
   * The workspace file index is built only for the file picker, so `/` and
   * `@skill:` opens stay as cheap as before.
   */
  const mentionCatalogs = (kind: "command" | "skill" | "file"): {
    commands: readonly TuiCommand[];
    templates: SlashCommandInfo[];
    skills: SkillCatalog["skills"];
    baseCommands: BaseCommand[];
    files: WorkspaceFileEntry[];
  } => ({
    commands,
    templates: slashInfos(),
    skills: resources.skills.skills,
    baseCommands: baseCommandList(),
    files: kind === "file" ? workspaceFilesForPicker() : [],
  });

  /** Insert a picked token over the trigger range; the caret lands after it. */
  const insertMentionItem = (item: { insert: string }): void => {
    const trigger = mention?.trigger;
    mention = null;
    if (trigger === undefined) return;
    editor = replaceTextRange(editor, trigger.start, trigger.end, item.insert);
  };

  /**
   * Re-detect the trigger token at the composer caret and open/refresh/close
   * the inline picker accordingly. Called after every composer edit, so the
   * filter text and the draft stay the same string: typing filters, Backspace
   * narrows, and deleting the trigger closes the picker.
   */
  const syncMentionPicker = (): void => {
    if (overlay !== null || find !== null) {
      mention = null;
      return;
    }
    const trigger = detectMentionTrigger(editor.text, editor.cursor);
    if (trigger === null) {
      mention = null;
      return;
    }
    const triggerRange = { start: trigger.start, end: trigger.end };
    if (mention === null || mention.kind !== trigger.kind) {
      mention = openMentionPicker(
        trigger.kind,
        trigger.query,
        mentionCatalogs(trigger.kind),
        triggerRange,
      );
    } else {
      mention = updateMentionPicker(mention, trigger.query, triggerRange);
    }
  };

  /**
   * Fold one keypress into the open mention picker.
   *
   * Navigation/accept/close come from the registry's `"mention"` scope; every
   * other key is mirrored into the editor and the picker is re-detected, so
   * the filter always equals the typed token. Enter on an *exactly typed*
   * command name follows the pre-picker behavior and submits it (so `/exit`
   * + Enter still quits); Tab always inserts. The picker never runs a turn on
   * its own.
   */
  const handleMentionKey = (key: KeyLike): void => {
    if (mention === null) return;
    const result = mentionPickerKey(commands, mention, key);
    if (result.action === "close") {
      mention = null;
      render();
      return;
    }
    if (result.action === "blocked") {
      pushToast("warn", result.reason ?? "unavailable");
      render();
      return;
    }
    if (result.action === "accept" && result.item !== undefined) {
      const exact =
        mention.kind === "command" &&
        result.chordName === "return" &&
        mention.query.trim().toLowerCase() !== "" &&
        result.item.name.toLowerCase() === mention.query.trim().toLowerCase();
      if (exact) {
        mention = null;
        submitEditor();
        render();
        return;
      }
      insertMentionItem(result.item);
      render();
      return;
    }
    if (result.action === "move") {
      mention = result.state;
      render();
      return;
    }
    // Printable/Backspace/other: edit the composer, then re-detect the token.
    const edited = handleEditorKey(editor, { ...key, raw: key.raw ?? "" });
    if (edited.action === "cancel") {
      mention = null;
      cancelKey();
      return;
    }
    editor = edited.state;
    syncMentionPicker();
    render();
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

  /**
   * Why `/models` cannot change a role model right now (null = changeable):
   * a `TWO_BROTHERS_*` env var or an explicit `--senior-model`/`--junior-model`
   * flag outranks the in-session choice (the same precedence endpoint
   * resolution uses in `providers.ts`).
   */
  const modelPinReason = (role: "senior" | "junior"): string | null => {
    if (envPinnedPairs().has(`${role}:model`)) return "pinned by a TWO_BROTHERS_* env var";
    const flagged = role === "senior" ? sessionCfg.seniorModel : sessionCfg.juniorModel;
    if (flagged.trim() !== "") return `fixed by --${role}-model for this run`;
    return null;
  };

  const modelItemsForRole = (role: "senior" | "junior"): PickerItem[] => {
    const pinned = modelPinReason(role);
    // The effective model (persisted settings + flags/env), so a provider
    // connected from the web or a preset shows its real current model.
    const current = providerRoleSummary(providerState, sessionCfg, role).model.trim();
    const items: PickerItem[] = [];
    if (current !== "") {
      items.push({
        id: `keep:${role}`,
        label: `keep current (${current})`,
        description: "no change",
        ...(pinned !== null ? { disabled: true, disabledReason: pinned } : {}),
      });
    }
    // Seed AND stored presets: a provider preset connected via `/provider` or
    // the web Settings contributes its model list here.
    for (const choice of providerModelChoices(providerState)) {
      items.push({
        id: `${role}:${choice.model}`,
        label: choice.model,
        description: `${choice.preset} preset`,
        keywords: [choice.preset, role],
        ...(pinned !== null ? { disabled: true, disabledReason: pinned } : {}),
      });
    }
    if (items.length === 0) {
      items.push({
        id: "none",
        label: "(no provider models configured)",
        disabled: true,
        disabledReason: "connect a provider with /provider",
      });
    }
    return items;
  };

  const applyRoleModel = (role: "senior" | "junior", value: string): void => {
    // The in-session choice is a direct operator request, so it outranks the
    // persisted model for the rest of this TUI run (never written to disk).
    sessionModelOverrides[role] = value;
    refreshProviderState();
    pushToast("success", `${role} model set to ${value} for this TUI run (not saved)`);
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

  /**
   * Bounded, fail-soft JSONL prefix read for the picker's derived title. A
   * missing/unreadable file (or a sidecar-only session) yields `[]`, so title
   * resolution falls through to the file stem instead of failing the picker.
   */
  const readSessionTitleEvents = (file: string): Array<Record<string, any>> => {
    try {
      const fd = fs.openSync(file, "r");
      try {
        const buffer = Buffer.alloc(SESSION_TITLE_PREFIX_BYTES);
        const read = fs.readSync(fd, buffer, 0, SESSION_TITLE_PREFIX_BYTES, 0);
        return parseSessionEventPrefix(buffer.toString("utf-8", 0, read));
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return [];
    }
  };

  const openSessionPicker = (): void => {
    const entries: SessionPickEntry[] = [];
    try {
      const metadata = new SessionMetadataStore(sessionsDir);
      for (const name of fs.readdirSync(sessionsDir).filter((n) => n.endsWith(".jsonl")).sort()) {
        let mtimeMs: number | null = null;
        try {
          mtimeMs = fs.statSync(path.join(sessionsDir, name)).mtimeMs;
        } catch {
          // unreadable stat still lists the session with an honest unknown age
        }
        // Readable titles come from the metadata sidecar the web sidebar and
        // `/export` already use; only a sidecar without a usable title costs a
        // bounded JSONL prefix read for the first-operator-message fallback.
        let sidecarTitle: unknown;
        try {
          sidecarTitle = metadata.get(name)?.title;
        } catch {
          // a corrupt/unreadable sidecar falls through to the derived title
        }
        const events =
          typeof sidecarTitle === "string" && sidecarTitle.trim() !== ""
            ? undefined
            : readSessionTitleEvents(path.join(sessionsDir, name));
        entries.push({ name, sidecarTitle, events, mtimeMs });
      }
    } catch {
      // missing sessions dir: the picker shows its empty state
    }
    const items = sessionPickerItems(entries);
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
              // Seed the neutral compaction markers of the restored context;
              // the rest of the TUI transcript history is not replayed.
              model = createCompactionSummaryModel(context.events);
              // The plan belongs to the session: show this process's live
              // snapshot when there is one, else replay the session sidecar
              // (serve-written or TUI-written plan snapshots).
              todos = planForSession(sessionFile);
              // Read-only replay of the session's persisted reasoning records.
              loadSessionReasoningFor(sessionFile);
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

  // --------------------------------------------------------------------- //
  // provider connection (`/provider`, also reached from /settings)
  // --------------------------------------------------------------------- //

  /** The `/provider` view data from the latest key-free resolution. */
  const providerConnectData = (): ProviderConnectData => ({
    roles: providerRoleSummaries(providerState, sessionCfg),
    presets: providerPresetChoices(providerState),
  });

  /** Open the real in-TUI provider connect surface (`/provider`). */
  const openProviderSurface = (role: "senior" | "junior" = "senior"): void => {
    if (running || compacting) {
      baseNotice("warn", "cannot change providers while a turn or compaction is running");
      return;
    }
    refreshProviderState();
    showProviderWarnings();
    overlay = {
      kind: "provider",
      state: createProviderConnectState(role),
      data: providerConnectData(),
    };
    render();
  };

  /**
   * Persist one `/provider` choice through the same atomic settings store the
   * backend uses. A failure keeps the dialog open with the real error and the
   * previous state (nothing was written); a success closes it and reports the
   * new effective connection WITHOUT any key material.
   */
  const commitProviderConnect = (request: ProviderConnectRequest): void => {
    if (overlay?.kind !== "provider") return;
    const result = saveTuiProviderConnection(providerStore, request, {
      cfg: sessionCfg,
      modelOverrides: sessionModelOverrides,
    });
    if (result.ok && result.state !== undefined) {
      providerState = result.state;
      overlay = null;
      showProviderWarnings();
      const summary = providerRoleSummary(providerState, sessionCfg, request.role);
      const target =
        request.preset !== undefined
          ? `preset ${request.preset.name} · ${request.preset.model}`
          : `manual · ${summary.model} · ${summary.baseUrl}`;
      baseNotice(
        "success",
        `${summary.label} connected: ${target} · API key ${
          summary.apiKeySet ? "set" : "not set"
        } — saved to sessions/settings.json`,
      );
      return;
    }
    const message = result.error ?? "cannot save provider settings";
    overlay = { ...overlay, state: setProviderConnectError(overlay.state, message) };
    pushToast("error", message);
    render();
  };

  /**
   * `/settings`: the effective, key-free provider summary for both roles plus
   * the real connect action (the old copy only said to leave the TUI and run
   * `onboard`).
   */
  const openSettingsDialog = (): void => {
    refreshProviderState();
    showProviderWarnings();
    overlay = {
      kind: "dialog",
      state: createDialog({
        title: "PROVIDER SETTINGS",
        // The effective summary is the message (visible immediately); there is
        // no secret detail to hide behind "d".
        message: providerSummaryLines(providerState, sessionCfg).join("\n"),
        actions: [
          { id: "provider", label: "Connect provider…" },
          { id: "close", label: "Close" },
        ],
      }),
      onAction: (id) => {
        if (id === "provider") openProviderSurface();
      },
    };
    render();
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

  // --------------------------------------------------------------------- //
  // first-party base commands (`src/basecommands.ts`)
  // --------------------------------------------------------------------- //

  /** Show one base-command result as a notice + toast, then repaint. */
  const baseNotice = (level: ToastLevel, message: string): void => {
    model = addNotice(
      model,
      level === "warn" ? "warn" : level === "error" ? "error" : "info",
      message,
    );
    pushToast(level, message);
    render();
  };

  /**
   * `/compact`: run the same in-process compaction path the harness uses —
   * `compactContext` through the senior endpoint, rewriting the session file
   * when the context has one — between turns only. The visible transcript is a
   * display record and is NOT rewritten; the notice says so honestly.
   */
  const compactContextAction = (): void => {
    if (running) {
      baseNotice("warn", "cannot compact while a turn is running — wait for it to finish");
      return;
    }
    if (compacting) {
      baseNotice("info", "compaction is already running");
      return;
    }
    if (context.events.length === 0) {
      baseNotice("info", "nothing to compact — the shared context is empty");
      return;
    }
    let provider: Provider;
    try {
      // Re-resolve first so a provider connected in the web Settings is used.
      const compactState = refreshProviderState();
      validateRunConfig(sessionCfg, compactState.endpoints);
      provider = tuiRoleProvider(sessionCfg, compactState.endpoints, "senior", onWarning);
    } catch (exc) {
      baseNotice("error", `cannot compact: ${messageOf(exc)}`);
      return;
    }
    const eventsBefore = context.events.length;
    // Manual compaction always honours the configured keep-recent budget,
    // even when auto-compaction itself is off (no threshold configured).
    const settings: CompactionSettings = {
      ...(compactionSettingsFromConfig(sessionCfg) ?? {}),
      ...(sessionCfg.compactKeepRecent > 0
        ? { keepRecentChars: sessionCfg.compactKeepRecent }
        : {}),
    };
    compacting = true;
    activity = "compacting context…";
    render();
    void (async () => {
      try {
        const changed = await compactContext(context, provider, settings);
        measureContext();
        if (changed) {
          // Show the fresh summary as a neutral SUMMARY marker (the same block
          // the inline stream / resume paths produce), never as an operator
          // message. The visible transcript history itself is not rewritten.
          const summary = context.events.find(isCompactionSummary);
          if (summary !== undefined) model = commitEnvelope(model, summary);
          scroll = latestTranscriptScroll();
          const after = context.events.length;
          baseNotice(
            "success",
            `context compacted: ${eventsBefore} → ${after} events (the visible transcript history is kept; the summary is in context)`,
          );
        } else {
          baseNotice("info", "nothing to compact yet — the context is below the keep-recent budget");
        }
      } catch (exc) {
        baseNotice("error", `compaction failed: ${messageOf(exc)}`);
      } finally {
        compacting = false;
        if (!running) activity = "ready — type a task and press Enter";
        measureContext();
        render();
      }
    })();
  };

  /**
   * `/export [path]`: write the current session as the canonical Markdown
   * export (`sessionsearch.ts::sessionToMarkdown`). A file-backed session
   * defaults to `<sessions-dir>/<stem>.md`; an in-memory session needs an
   * explicit path and is refused honestly otherwise.
   */
  const exportSessionAction = (args: string): void => {
    if (running) {
      baseNotice("warn", "cannot export while a turn is running — wait for it to finish");
      return;
    }
    if (compacting) {
      baseNotice("warn", "cannot export while compaction is running");
      return;
    }
    const requested = args.trim();
    const sessionFile = sessionCfg.sessionFile;
    if (sessionFile === "" && requested === "") {
      baseNotice(
        "warn",
        "cannot export: this session is in memory only — start the TUI with --session-file, " +
          "or pass a path: /export <path>",
      );
      return;
    }
    try {
      const events = context.events;
      if (events.length === 0) {
        baseNotice("info", "nothing to export yet — this session has no events");
        return;
      }
      const name = sessionFile !== "" ? path.basename(sessionFile) : "session.jsonl";
      const dir = sessionFile !== "" ? path.dirname(sessionFile) : cwd;
      let title = "";
      let workspaceId: string | null = null;
      let updated: number | null = null;
      if (sessionFile !== "") {
        try {
          const meta = new SessionMetadataStore(dir).get(name);
          if (meta !== null) {
            title = typeof meta.title === "string" ? meta.title.trim() : "";
            workspaceId =
              typeof meta.workspace_id === "string" && meta.workspace_id
                ? meta.workspace_id
                : null;
          }
          updated = Math.floor(fs.statSync(sessionFile).mtimeMs / 1000);
        } catch {
          // title/workspace/mtime are optional export metadata
        }
      }
      if (title === "") {
        title = deriveTitle(
          events as unknown as Array<Record<string, unknown>>,
          name.replace(/\.jsonl$/, ""),
        );
      }
      const doc: SessionSearchDoc = {
        name,
        title,
        events,
        workspace_id: workspaceId,
        updated,
      };
      const markdown = sessionToMarkdown(doc);
      const outPath =
        requested !== ""
          ? path.resolve(cwd, requested)
          : path.resolve(dir, exportSessionFileName(name, "markdown"));
      fs.writeFileSync(outPath, markdown, "utf-8");
      baseNotice("success", `exported ${events.length} events to ${outPath}`);
    } catch (exc) {
      baseNotice("error", `export failed: ${messageOf(exc)}`);
    }
  };

  /**
   * Apply one operator approval mode to the persisted settings and report the
   * outcome honestly: a success toast, plus the mode's destructive warning
   * when it weakens a guardrail; a failed save keeps the previous mode. Shared
   * by the `/permission` dialog buttons and the `/permission <mode>` form.
   */
  const applyApprovalMode = (next: ApprovalMode): boolean => {
    if (pinnedApprovalMode !== undefined) {
      pushToast(
        "warn",
        `approval mode is pinned to ${pinnedApprovalMode} for this TUI process — restart without --approval-mode / TWO_BROTHERS_APPROVAL_MODE to change the saved policy`,
      );
      return false;
    }
    const error = saveApprovalMode(next);
    if (error !== null) {
      pushToast("warn", `approval mode not saved: ${error}`);
      return false;
    }
    pushToast("info", `approval mode: ${next} — the next workspace turn uses it`);
    const warning = approvalModeWarning(next);
    if (warning !== null) pushToast("warn", warning);
    return true;
  };

  /**
   * `/permission`: state the persisted approval mode, the bound workspace and
   * the session allows from what this TUI actually knows — never implying a
   * policy that does not exist. The dialog buttons change the persisted mode
   * (`allow-all` is tone-warned; a write failure keeps the old mode);
   * `/permission <mode>` applies one directly. A change applies from the next
   * workspace turn, and the mode never relaxes workspace confinement or the
   * sensitive-path refusal, which run before permission checks.
   */
  const openPermissionDialog = (args = ""): void => {
    const requested = args.trim();
    if (requested !== "") {
      const next = normalizeApprovalMode(requested);
      if (next === null) {
        baseNotice(
          "warn",
          `unknown approval mode "${requested}" — use ${APPROVAL_MODES.join(" | ")}`,
        );
        return;
      }
      applyApprovalMode(next);
      return;
    }
    const plugins = resources.plugins;
    const pluginServers =
      plugins === null
        ? 0
        : [...plugins.plugins.values()].reduce(
            (total, plugin) => total + plugin.mcpServers.length,
            0,
          );
    const pluginTools =
      plugins === null
        ? 0
        : [...plugins.plugins.values()].reduce((total, plugin) => total + plugin.tools.length, 0);
    const skills = resources.skills.skills;
    const mode = currentApprovalMode();
    const modeInfo = APPROVAL_MODE_INFO[mode];
    const modeLines = [
      `approval mode: ${mode} — ${modeInfo.description}`,
      ...(modeInfo.danger !== undefined ? [`warning: ${modeInfo.danger}`] : []),
      ...(pinnedApprovalMode !== undefined
        ? [
            "pinned by --approval-mode / TWO_BROTHERS_APPROVAL_MODE for this TUI process (never persisted); the saved approval_policy applies again after a restart without the pin",
          ]
        : [
            "the buttons below persist the mode (sessions/settings.json); it applies from the next workspace turn",
          ]),
    ];
    const approvalLines =
      workspaceRoot === null
        ? [
            ...modeLines,
            "approvals: none — this TUI run has no workspace or approval broker; workspace tools are unavailable",
            "workspace: none — start the TUI with --workspace <dir> to bind one",
          ]
        : [
            ...modeLines,
            `workspace: ${workspaceRoot}`,
            "approval decisions: 1 / Y allow once · 2 / A allow for this TUI session · 3 / N / Esc deny · Ctrl+E preview",
            `session allows (memory only, this TUI process): ${
              sessionAllows.size === 0
                ? "none"
                : [...sessionAllows.values()]
                    .map((entry) => `${entry.action} ${entry.target}`.trim())
                    .join("; ")
            }`,
          ];
    const lines = [
      ...approvalLines,
      "tool scopes: built per turn from plugins + MCP (shared / senior / junior belts)",
      plugins === null
        ? "plugins: discovery failed"
        : `plugins: ${plugins.plugins.size} loaded · ${pluginTools} tool(s) · ${plugins.errors.length} error(s)`,
      `MCP: ${options.mcpConfig !== undefined ? options.mcpConfig : "no --mcp-config"}${
        pluginServers > 0 ? ` · ${pluginServers} plugin server(s)` : ""
      }`,
      `skills: shared ${skills.filter((skill) => skill.scope === "shared").length} · ` +
        `senior ${skills.filter((skill) => skill.scope === "senior").length} · ` +
        `junior ${skills.filter((skill) => skill.scope === "junior").length} ` +
        "(only shared skills are operator-attachable)",
    ];
    // Close is listed last and is the default selection: opening /permission
    // and pressing Enter must never persist a mode change (a no-op close is the
    // safe default; the operator moves the selection to choose a mode).
    const modeActions =
      pinnedApprovalMode !== undefined
        ? [{ id: "close", label: "Close" }]
        : [
            ...APPROVAL_MODES.map((candidate) => ({
              id: candidate,
              label:
                candidate === mode
                  ? `${APPROVAL_MODE_INFO[candidate].label} (current)`
                  : APPROVAL_MODE_INFO[candidate].label,
            })),
            { id: "close", label: "Close" },
          ];
    overlay = {
      kind: "dialog",
      state: createDialog({
        title: "PERMISSIONS",
        message: "Approval policy and configured tool scopes",
        details: lines.join("\n"),
        ...(mode === "allow-all" ? { tone: "warning" as const } : {}),
        actions: modeActions,
        selected: modeActions.length - 1,
      }),
      onAction: (id) => {
        const next = normalizeApprovalMode(id);
        if (next !== null) applyApprovalMode(next);
        render();
      },
    };
    render();
  };

  /** `/status`: the existing status surface (the side panel's own rows). */
  const openStatusDialog = (): void => {
    const entries = sidePanelEntries(sidePanelState(), commands).filter((entry) => entry.label !== "");
    const details = entries.map((entry) => `${entry.label}: ${entry.value}`).join("\n");
    const phase = running ? "running" : compacting ? "compacting" : "idle";
    overlay = {
      kind: "dialog",
      state: createDialog({
        title: "STATUS",
        message: `${activity} (${phase})`,
        details,
        actions: [{ id: "close", label: "Close" }],
      }),
      onAction: () => {},
    };
    render();
  };

  /**
   * `/new`: start a fresh session. An in-memory TUI has a real fresh-session
   * path (a new `SharedContext` + cleared display); a file-backed session is
   * refused honestly because rotating the file needs a new name the TUI does
   * not collect.
   */
  const startNewSessionAction = (): void => {
    if (running) {
      baseNotice("warn", "cannot start a new session while a turn is running — cancel it first");
      return;
    }
    if (compacting) {
      baseNotice("warn", "cannot start a new session while compaction is running");
      return;
    }
    if (sessionCfg.sessionFile !== "") {
      baseNotice(
        "warn",
        "cannot rotate an on-disk session from here — restart the TUI without " +
          "--session-file/--resume to start a fresh session file",
      );
      return;
    }
    context = new SharedContext();
    sessionCfg = { ...sessionCfg, resume: false };
    model = createTuiModel();
    todos = [];
    // A fresh in-memory session has no sidecar, so no reasoning replay either.
    replayedReasoning = [];
    hiddenReplayedReasoning = 0;
    toolExpansion = new Set<string>();
    scroll = latestTranscriptScroll();
    usage = null;
    cost = null;
    lastElapsedMs = undefined;
    contextTokens = null;
    lastFailedTask = null;
    activity = "ready — new in-memory session";
    baseNotice("success", "new in-memory session started");
  };

  /** Perform one base `action` command locally (never a turn). */
  const performBaseAction = (command: BaseCommand, args: string): void => {
    switch (command.action) {
      case "compact":
        compactContextAction();
        return;
      case "export":
        exportSessionAction(args);
        return;
      case "permission":
        openPermissionDialog(args);
        return;
      case "status":
        openStatusDialog();
        return;
      case "new":
        startNewSessionAction();
        return;
      case "help":
        openHelp();
        render();
        return;
      case "mode": {
        const requested = args.trim().toLowerCase();
        if (requested === "consult" || requested === "work") {
          mode = requested;
          pushToast("info", `mode: ${mode} — the next turn uses it`);
          render();
          return;
        }
        openModePicker();
        render();
        return;
      }
      default:
        baseNotice("warn", `/${command.name} is not available in the TUI`);
    }
  };

  /**
   * Typed `/name args` dispatch for a base command. Prompt commands expand to
   * the exact template bytes and start a normal turn (mode override applied);
   * actions are performed locally and never submitted as a task. A usage error
   * restores the exact pre-submit draft.
   */
  const dispatchBaseCommand = (
    command: BaseCommand,
    args: string,
    promptText: string,
    draftBefore: EditorState,
  ): void => {
    if (command.kind === "action") {
      performBaseAction(command, args);
      return;
    }
    const submission = planBaseCommandSubmission(command, args, mode);
    if (submission.kind === "usage") {
      editor = draftBefore;
      baseNotice("warn", submission.message);
      return;
    }
    const started = executeTurn(submission.task, submission.mode, promptText);
    if (!started) editor = draftBefore;
  };

  /** Run a palette/help entry: commands dispatch, templates become tasks. */
  const dispatchEntry = (entry: PaletteEntry): void => {
    if (entry.kind === "base-command") {
      const command = findBaseCommand(entry.id.slice(BASE_COMMAND_ENTRY_PREFIX.length));
      if (command === undefined) return;
      if (command.kind === "action") {
        performBaseAction(command, "");
        return;
      }
      if (command.argumentHint !== "") {
        editor = insertText(editor, `/${command.name} `);
        render();
        return;
      }
      const submission = planBaseCommandSubmission(command, "", mode);
      if (submission.kind === "usage") {
        baseNotice("warn", submission.message);
        return;
      }
      executeTurn(submission.task, submission.mode, `/${command.name}`);
      return;
    }
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
      case "keys":
        dispatchKeys("");
        break;
      case "history-search":
        openHistorySearchOverlay();
        break;
      case "find":
        openFindBar();
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
      case "panel":
        toggleSidePanel();
        break;
      case "settings":
        openSettingsDialog();
        break;
      case "provider":
        openProviderSurface();
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
      // Resolve every parked approval as deny BEFORE the abort: a stopped run
      // must never leave a mutation waiting on an operator who already
      // cancelled.
      denyPendingApprovals("cancelled");
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
      ...commands.map((c) => c.slash).filter((s): s is string => s !== undefined),
      ...resources.commands.commands.map((c) => c.name),
      ...baseCommandList().flatMap((command) => [command.name, ...command.aliases]),
    ];
    const unique = [...new Set(names.filter((name) => name.toLowerCase().startsWith(prefix)))];
    if (unique.length === 1 && unique[0] !== undefined && unique[0] !== prefix) {
      editor = insertText(editor, `/${unique[0]} `.slice(text.length));
    }
  };

  /**
   * Apply one keys reload outcome to the live app: a valid table is swapped in
   * place, and every outcome posts exactly one bounded notice. Shared by
   * `/keys reload` (`via` "manual") and the file watcher ("watch"), so both
   * surfaces use the same validated path, the same last-good-table rule and
   * the same no-spam budget (one notice per attempted reload/change).
   */
  const applyKeysLoadResult = (result: TuiKeysLoadResult, via: "manual" | "watch"): void => {
    keysState = result.state;
    keysDiagnostics = result.diagnostics;
    const sourceText =
      keysSource === null ? "" : `${keysSource.path} (${keysSource.origin})`;
    if (result.state === "loaded") {
      commands = result.commands;
      const label = via === "watch" ? "keys auto-reloaded" : "keys reloaded";
      model = addNotice(
        model,
        "info",
        boundTuiKeysNotice(`${label}: ${globalKeySummary(commands)} — ${sourceText}`),
      );
      return;
    }
    if (result.state === "missing") {
      model = addNotice(
        model,
        "info",
        boundTuiKeysNotice(
          via === "watch"
            ? `keys watch: no file at ${sourceText} — keeping the current chords`
            : `keys: no file at ${sourceText} — keeping the current chords`,
        ),
      );
      return;
    }
    const detail =
      result.diagnostics.length > 0 ? result.diagnostics.join("; ") : "invalid keys file";
    model = addNotice(
      model,
      "warn",
      boundTuiKeysNotice(
        via === "watch"
          ? `keys watch: ${detail} — keeping the current chords`
          : `keys reload failed: ${detail} — keeping the current chords`,
      ),
    );
  };

  /**
   * Start the opt-in keys-file watcher. `--keys-watch`/the pinned env are
   * captured at startup (changing them needs a restart); only the FILE's
   * contents are watched, and `/keys show` reports `on`/`off`/`unavailable`.
   */
  const startKeysWatch = (): void => {
    if (options.keysWatch !== true || keysSource === null || keysWatcher !== null) return;
    const source = keysSource;
    keysWatcher = watchTuiKeysFile(source, {
      current: () => commands,
      onChange: (result) => {
        applyKeysLoadResult(result, "watch");
        render();
      },
    });
    keysWatchState = keysWatcher === null ? "unavailable" : "on";
  };

  /** Stop and unwatch the opt-in poll (idempotent; used on every exit path). */
  const stopKeysWatch = (): void => {
    const watcher = keysWatcher;
    if (watcher !== null) watcher.stop();
    keysWatcher = null;
  };

  /**
   * `/keys` (show) and `/keys reload`: report the three effective global chords
   * plus the captured keys-file source and watch state, or re-read that source
   * and swap the active table in place. Reload failure/absence keeps the last
   * good table.
   */
  const dispatchKeys = (args: string): void => {
    const sub = args.trim().toLowerCase();
    if (sub === "" || sub === "show") {
      const lines = describeTuiKeys(commands, {
        source: keysSource,
        state: keysState,
        diagnostics: keysDiagnostics,
        watch: keysWatchState,
      });
      for (const line of lines) model = addNotice(model, "info", line);
      render();
      return;
    }
    if (sub !== "reload") {
      model = addNotice(model, "warn", "usage: /keys [show|reload]");
      render();
      return;
    }
    if (keysSource === null) {
      model = addNotice(
        model,
        "warn",
        "keys: no keys-file source was captured for this TUI session — reload is unavailable",
      );
      render();
      return;
    }
    const result = reloadTuiCommands(keysSource, commands);
    applyKeysLoadResult(result, "manual");
    render();
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
            const pinReason = modelPinReason(words[0]);
            if (pinReason !== null) {
              model = addNotice(model, "warn", `${words[0]} model is ${pinReason} and cannot be changed here`);
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
      case "panel":
        toggleSidePanel();
        return true;
      case "stash":
        toggleStash();
        return true;
      case "keys":
        dispatchKeys(args);
        return true;
      case "settings":
        if (!gateIdleCommand(command)) return true;
        openSettingsDialog();
        return true;
      case "provider":
        if (!gateIdleCommand(command)) return true;
        openProviderSurface();
        return true;
      case "retry":
        doRetry();
        return true;
      case "find":
        openFindBar(args);
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
    if (compacting && editor.text.trim() !== "") {
      model = addNotice(
        model,
        "warn",
        "compaction is running — your draft is kept; send it when it finishes",
      );
      render();
      return;
    }
    // A typed non-ASCII base alias (`/目标 …`) cannot pass matchCommand's ASCII
    // name gate and would otherwise run as a literal task. Mirror the web rule:
    // a neutral notice names the canonical ASCII spelling + usage, the composer
    // text is kept for editing, and no turn starts. Canonical names and ASCII
    // aliases keep their existing resolver path.
    const aliasNotice = nonAsciiBaseAliasNotice(editor.text);
    if (aliasNotice !== null) {
      model = addNotice(model, "info", aliasNotice.message);
      render();
      return;
    }
    const draftBefore = editor;
    const submission = takeSubmission(editor);
    editor = submission.state;
    const text = submission.text;
    if (text.trim() === "") return;
    const matched = matchCommand(text);
    if (matched !== null) {
      // A native registry command always wins its own name (the same rule the
      // catalog filter in `loadTuiResources` applies to the surfaces): a
      // discovered template can never shadow a native app surface such as
      // `/provider`. Native commands this dispatcher does not own fall through
      // to the template/base resolution below unchanged.
      const builtin = findSlashCommand(commands, matched.name);
      if (builtin !== null && dispatchSlash(builtin, matched.args)) return;
      // A discovered template shadows a same-named base command; when no
      // template claims the name, a first-party base command handles it
      // (prompt → expanded turn, action → performed locally, never a task).
      const templateExists = resources.commands.commands.some(
        (template) => template.name === matched.name,
      );
      if (!templateExists) {
        const base = findBaseCommand(matched.name);
        if (base !== undefined) {
          dispatchBaseCommand(base, matched.args, text, draftBefore);
          return;
        }
      }
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
        // A refused mention (unknown/role-scoped/too many) never started a
        // turn: restore the exact draft so the operator can fix the token.
        if (!executeTurn(action.task, action.mode ?? mode, text)) editor = draftBefore;
        break;
    }
  };

  const handleOverlayKey = (key: KeyLike): void => {
    if (overlay === null) return;
    if (overlay.kind === "palette") {
      const entries = paletteEntries(commands, { commands: slashInfos(), running });
      const result = handlePaletteKey(commands, overlay.state, key, entries);
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
      const entries = helpOverlayEntries();
      const result = handleHelpKey(commands, overlay.state, key, entries);
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
    if (overlay.kind === "provider") {
      const result = providerConnectKey(overlay.state, overlay.data, key);
      overlay = { ...overlay, state: result.state };
      if (result.action.type === "close") overlay = null;
      else if (result.action.type === "save") commitProviderConnect(result.action.request);
      render();
      return;
    }
    const result = handleDialogKey(overlay.state, key);
    if (result.action === "close") {
      overlay = null;
    } else if (result.action === "accept" && result.actionId !== undefined) {
      const onAction = overlay.onAction;
      overlay = null;
      onAction(result.actionId);
    } else if (result.action === "details" || result.action === "move") {
      // The dialog owns its own selection/details; keep the updated state so
      // "Press d for details" and action movement actually work.
      overlay = { ...overlay, state: result.state };
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
      case "find":
        openFindBar();
        return true;
      case "panel":
        toggleSidePanel();
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
    // A parked approval owns the keyboard: its panel is the only footer and
    // its `approval` key scope is authoritative (Esc = deny exactly once).
    // Closing the optional preview overlay above is handled by the branch
    // above and never answers the request.
    if (approval !== null) {
      handleApprovalKey(key);
      return;
    }
    // The inline find bar owns the keyboard while it is open: typing edits the
    // query, Enter/arrows navigate matches and Esc closes the bar (the
    // overlay-vs-find precedence above keeps modal surfaces first).
    if (find !== null) {
      handleFindBarKey(key);
      return;
    }
    // The inline `/` command and `@skill:` picker is a composer typing mode:
    // it owns printable input, Up/Down, Enter/Tab and Esc while open.
    if (mention !== null) {
      handleMentionKey(key);
      return;
    }
    const match = resolveKey(commands, key, "app");
    // A printable one-character chord that opened help is typing while the
    // composer has text (the rule "?" always had, now derived from whichever
    // chord the rebindable help command carries). F1 and function keys still
    // open help.
    const helpChordBlocksTyping =
      match !== null &&
      match.command.id === "help" &&
      isSinglePrintableKeyChord(match.chord) &&
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
          width: transcriptWidth(),
          height: transcriptBodyHeight(),
          theme,
          // The replayed section is part of the row document the scroll math
          // counts; the hidden-record marker row must be passed too or the
          // document is one row shorter than the rendered frame.
          ...(replayedReasoning.length > 0
            ? {
                replayedReasoning,
                ...(hiddenReplayedReasoning > 0 ? { hiddenReplayedReasoning } : {}),
              }
            : {}),
        });
        break;
      case "scroll-next":
        scroll = scrollTranscript(model, scroll, pageSize(), {
          width: transcriptWidth(),
          height: transcriptBodyHeight(),
          theme,
          ...(replayedReasoning.length > 0
            ? {
                replayedReasoning,
                ...(hiddenReplayedReasoning > 0 ? { hiddenReplayedReasoning } : {}),
              }
            : {}),
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
    // Opening a trigger token is a composer affordance, not a key binding:
    // after every edit the current line/token decides whether the picker is up.
    syncMentionPicker();
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
    // Teardown path: deny anything parked before aborting, then abort; the
    // broker also listens to the signal, so a pending wait resolves exactly
    // once (denyAll removes the entries first).
    denyPendingApprovals("cancelled");
    const controller = turnAbort;
    if (controller !== null) controller.abort();
  };

  try {
    terminal.enter();
    // Start the opt-in watcher only once the screen owns the terminal; every
    // exit path below stops and unwatches it in the `finally`.
    if (options.keysWatch === true) startKeysWatch();
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
        if (overlay !== null) {
          // The provider form has real text fields (Base URL / model / API
          // key): paste is routed into the field editor, never the composer or
          // history. Every other overlay ignores pastes.
          if (overlay.kind === "provider") {
            const pasted = providerConnectKey(overlay.state, overlay.data, {
              name: "paste",
              raw: event.text,
            });
            overlay = { kind: "provider", state: pasted.state, data: overlay.data };
            render();
          }
          continue;
        }
        if (find !== null) {
          // A paste while finding extends the query as one sanitized line; it
          // can never reach the composer or submit a turn.
          find = appendFindText(find, event.text);
          findModel = model;
          syncFindScroll();
        } else {
          editor = pasteText(editor, event.text);
          syncMentionPicker();
        }
        continue;
      }
      // Key-repeat guard: a held Enter/Tab must never send the same submit (or
      // accept the picker item) twice. Only the composer context is guarded —
      // modal overlays and the find bar have their own idempotent handlers.
      if (overlay === null && find === null) {
        const decision = guardComposerSubmit(lastRepeatGuard, event.key, editor.text, {
          mentionOpen: mention !== null,
          commands,
        });
        lastRepeatGuard = decision.snapshot;
        if (decision.suppress) continue;
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
    // Stop and unwatch the opt-in poll on every exit path (no leaked timer).
    stopKeysWatch();
    unsubscribeResize();
    clearInterval(spinnerTimer);
    abortRunningTurn();
    if (turnDone !== null) {
      await Promise.race([turnDone, new Promise((resolve) => setTimeout(resolve, 1500))]);
    }
    terminal.restore();
  }
}
