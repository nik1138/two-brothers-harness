/**
 * Responsive right-hand status side panel.
 *
 * The panel is a wide-terminal affordance: it exists only when the terminal
 * has room for it (`SIDE_PANEL_MIN_WIDTH` × `SIDE_PANEL_MIN_HEIGHT`), the
 * operator has not toggled it off (the `panel` registry command), and no
 * full-screen overlay is open. Every decision is made by one pure function
 * ({@link sidePanelLayout}), so the app, the screen composer and the tests
 * share the exact same rule and an 80×24 terminal renders byte-identically to
 * the pre-panel layout.
 *
 * The panel occupies columns at the right of the transcript *body* only: the
 * composer and the two-line status bar keep the full terminal width, so
 * showing or hiding the panel never moves them. Each content row is
 * label + value, truncated with `…` to the box's content width, and the box
 * drawing is the same `renderBox` primitive the other views use.
 *
 * Everything here is deterministic and terminal-free; model/state values are
 * sanitized by `renderBox`/`truncateToWidth`, and nothing is invented: a value
 * the app does not know renders as `unknown` (or the existing honest
 * `cost unknown` marker) instead of a plausible-looking zero.
 */
import { findCommand, formatChord, TUI_COMMANDS, type TuiCommand } from "../keymap.ts";
import { blankRow, boxContentWidth, fitStyled, renderBox, sanitizeDisplayText } from "../screen.ts";
import { truncateToWidth } from "../text.ts";
import { plainTheme, type Theme, type ThemeToken } from "../theme.ts";
import { formatCost, formatCount, formatElapsed } from "./statusbar.ts";

/** Minimum terminal width that shows the panel (80-column terminals keep today's layout). */
export const SIDE_PANEL_MIN_WIDTH = 100;

/** Minimum terminal height that shows the panel. */
export const SIDE_PANEL_MIN_HEIGHT = 20;

/** Narrowest panel box (including its border) once it is shown. */
export const SIDE_PANEL_MIN_PANEL_WIDTH = 30;

/** Widest panel box, so a very wide terminal keeps a focused column. */
export const SIDE_PANEL_MAX_PANEL_WIDTH = 40;

/** The transcript never shrinks below this many columns to make room. */
export const SIDE_PANEL_MIN_TRANSCRIPT_WIDTH = 60;

/** Box title, matching the other bordered views' uppercase style. */
export const SIDE_PANEL_TITLE = "STATUS";

/** Why the layout ended up visible or hidden (stable for tests/logs). */
export type SidePanelReason = "visible" | "disabled" | "overlay" | "narrow" | "short";

/** Inputs for {@link sidePanelLayout} beyond the terminal size. */
export interface SidePanelLayoutOptions {
  /** The registry-toggle choice; `false` hides the panel at every size. */
  enabled?: boolean;
  /** A full-screen overlay (palette/help/dialog/picker) is open. */
  overlayOpen?: boolean;
}

/** One frame's panel geometry. Widths always add up to the terminal width. */
export interface SidePanelLayout {
  visible: boolean;
  reason: SidePanelReason;
  /** Terminal width the layout was computed for. */
  width: number;
  /** Terminal height the layout was computed for. */
  height: number;
  /** Panel box width, 0 while hidden. */
  panelWidth: number;
  /** Transcript width: the terminal width when hidden. */
  transcriptWidth: number;
}

/**
 * How many columns the panel may take on a `width`-column terminal.
 *
 * About 30% of the row, clamped to the panel's own bounds, and never at the
 * expense of {@link SIDE_PANEL_MIN_TRANSCRIPT_WIDTH}.
 */
export function sidePanelColumns(width: number): number {
  const columns = Math.max(0, Math.floor(width));
  const preferred = Math.round(columns * 0.3);
  const clamped = Math.max(
    SIDE_PANEL_MIN_PANEL_WIDTH,
    Math.min(SIDE_PANEL_MAX_PANEL_WIDTH, preferred),
  );
  return Math.max(0, Math.min(clamped, columns - SIDE_PANEL_MIN_TRANSCRIPT_WIDTH));
}

/**
 * The one visibility/geometry rule: wide enough, tall enough, enabled, and
 * no overlay. `transcriptWidth + panelWidth === width` in every case, so a
 * hidden panel gives the transcript exactly the width it had before.
 */
export function sidePanelLayout(
  width: number,
  height: number,
  options: SidePanelLayoutOptions = {},
): SidePanelLayout {
  const columns = Math.max(0, Math.floor(Number.isFinite(width) ? width : 0));
  const rows = Math.max(0, Math.floor(Number.isFinite(height) ? height : 0));
  const hidden = (reason: SidePanelReason): SidePanelLayout => ({
    visible: false,
    reason,
    width: columns,
    height: rows,
    panelWidth: 0,
    transcriptWidth: columns,
  });

  if (options.enabled === false) return hidden("disabled");
  if (options.overlayOpen === true) return hidden("overlay");
  const panelWidth = sidePanelColumns(columns);
  if (columns < SIDE_PANEL_MIN_WIDTH || panelWidth < SIDE_PANEL_MIN_PANEL_WIDTH) {
    return hidden("narrow");
  }
  if (rows < SIDE_PANEL_MIN_HEIGHT) return hidden("short");
  return {
    visible: true,
    reason: "visible",
    width: columns,
    height: rows,
    panelWidth,
    transcriptWidth: columns - panelWidth,
  };
}

/**
 * Fold one press of the `panel` chord into the stored choice.
 *
 * `null` means "no choice made yet": the panel follows the terminal size.
 * The first press therefore hides a size-driven panel, and every later press
 * flips the boolean, so the choice survives resize for the rest of the run.
 */
export function toggleSidePanelEnabled(current: boolean | null): boolean {
  return current === false;
}

// --------------------------------------------------------------------------- //
// content
// --------------------------------------------------------------------------- //

/**
 * Compaction configuration as the app resolved it
 * (`compactionSettingsFromConfig`), with the same default budgets the
 * compaction module applies. `off` means no trigger is configured;
 * `undefined` (the whole field) means "unknown".
 */
export interface SidePanelCompaction {
  mode: "tokens" | "chars" | "off";
  /** Configured auto trigger in the mode's unit. */
  threshold?: number;
  /** Configured keep-recent budget in the mode's unit. */
  keepRecent?: number;
  /** `--compact`: one forced pass before the run. */
  force?: boolean;
}

/** Plugin discovery, when the app loaded the plugin manager. */
export interface SidePanelPlugins {
  loaded: number;
  errors: number;
}

/** Skill discovery counts by scope. */
export interface SidePanelSkills {
  shared: number;
  senior: number;
  junior: number;
}

/** MCP presence: the configured file and any plugin-declared servers. */
export interface SidePanelMcp {
  configPath?: string;
  pluginServers?: number;
}

/** Discovery counts the app already knows at session start. */
export interface SidePanelDiscovery {
  plugins?: SidePanelPlugins;
  skills?: SidePanelSkills;
  commands?: number;
  mcp?: SidePanelMcp;
}

/** Everything the panel may display; absent fields render as `unknown`. */
export interface SidePanelState {
  mode: string;
  seniorModel?: string;
  juniorModel?: string;
  /** Wire family per role (`--senior-kind`/`--junior-kind`, else `--provider-kind`). */
  seniorKind?: string;
  juniorKind?: string;
  /** Provider name (`openai`, `mock`, …). */
  provider?: string;
  sessionName?: string;
  /** `--resume`: the session was restored rather than created. */
  resume?: boolean;
  cwd?: string;
  running?: boolean;
  contextTokens?: number;
  contextWindow?: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  /** Null is the honest unknown price; undefined means "not measured yet". */
  cost?: number | null;
  elapsedMs?: number;
  compaction?: SidePanelCompaction;
  discovery?: SidePanelDiscovery;
}

/** One labelled panel row before width fitting (`label` "" = plain row). */
export interface SidePanelEntry {
  label: string;
  value: string;
  tone: ThemeToken;
}

/** Fixed label column; labels are ASCII so padding is exact. */
const LABEL_WIDTH = 9;

function roleValue(model: string | undefined, kind: string | undefined): string {
  const name = model?.trim() ?? "";
  const wire = kind?.trim() ?? "";
  if (name === "") return wire === "" ? "(unset)" : `(unset) · ${wire}`;
  return wire === "" ? name : `${name} · ${wire}`;
}

function contextValue(state: SidePanelState): string {
  const used = state.contextTokens === undefined ? "unknown" : formatCount(state.contextTokens);
  const total = state.contextWindow === undefined ? "unknown" : formatCount(state.contextWindow);
  return `${used} / ${total}`;
}

function tokenValue(state: SidePanelState): string {
  if (state.inputTokens === undefined && state.outputTokens === undefined) return "unknown";
  return `in ${formatCount(state.inputTokens ?? 0)} · out ${formatCount(state.outputTokens ?? 0)}`;
}

function costValue(cost: number | null | undefined): string {
  if (cost === undefined) return "unknown";
  return formatCost(cost) ?? "cost unknown";
}

function compactionValue(compaction: SidePanelCompaction | undefined): string {
  if (compaction === undefined) return "unknown";
  const parts: string[] = [];
  if (compaction.force === true) parts.push("force");
  if (compaction.mode === "off") {
    parts.push("off");
    return parts.join(" · ");
  }
  const unit = compaction.mode === "tokens" ? "tok" : "ch";
  parts.push(
    compaction.threshold === undefined
      ? "auto unknown"
      : `auto ${formatCount(compaction.threshold)} ${unit}`,
  );
  if (compaction.keepRecent !== undefined) {
    parts.push(`keep ${formatCount(compaction.keepRecent)}`);
  }
  return parts.join(" · ");
}

function pluginsValue(plugins: SidePanelPlugins | undefined): string {
  if (plugins === undefined) return "unknown";
  const errorText = plugins.errors === 1 ? "1 error" : `${plugins.errors} errors`;
  return `${plugins.loaded} loaded${plugins.errors > 0 ? ` · ${errorText}` : ""}`;
}

function skillsValue(skills: SidePanelSkills | undefined): string {
  if (skills === undefined) return "unknown";
  return `shared ${skills.shared} · senior ${skills.senior} · junior ${skills.junior}`;
}

/** Basename of a configured path without touching the filesystem. */
function baseName(filePath: string): string {
  const parts = filePath.split(/[\\/]/u).filter((part) => part !== "");
  return parts.at(-1) ?? filePath;
}

function mcpValue(mcp: SidePanelMcp | undefined): string {
  if (mcp === undefined) return "unknown";
  const parts: string[] = [];
  if ((mcp.configPath ?? "") !== "") parts.push(baseName(mcp.configPath ?? ""));
  if ((mcp.pluginServers ?? 0) > 0) {
    parts.push(`${mcp.pluginServers ?? 0} plugin`);
  }
  return parts.length === 0 ? "none configured" : parts.join(" · ");
}

/**
 * Two short key-tip rows, both derived from the registry (no view string
 * spells a shortcut). Unknown ids degrade to a single-part or empty row.
 */
export function sidePanelKeyTips(
  commands: typeof TUI_COMMANDS = TUI_COMMANDS,
): string[] {
  const line = (pairs: readonly (readonly [string, string])[]): string =>
    pairs
      .map(([id, label]) => {
        const command = findCommand(commands, id);
        const chord = command?.keys?.[0];
        return chord === undefined ? "" : `${formatChord(chord)} ${label}`;
      })
      .filter((part) => part !== "")
      .join(" · ");
  return [
    line([["palette", "commands"], ["help", "help"]]),
    line([["tool-expand", "tools"], ["panel", "panel"]]),
  ].filter((row) => row !== "");
}

/**
 * The panel's labelled rows in display order, before width fitting: identity
 * and usage first, because a short body clips the list from the bottom. Empty
 * labels are separator/plain rows (the key tips).
 */
export function sidePanelEntries(
  state: SidePanelState,
  commands: readonly TuiCommand[] = TUI_COMMANDS,
): SidePanelEntry[] {
  const seniorUnset = (state.seniorModel ?? "").trim() === "";
  const juniorUnset = (state.juniorModel ?? "").trim() === "";
  const rows: SidePanelEntry[] = [
    {
      label: "MODE",
      value: `${state.mode.trim() || "consult"}${state.running === true ? " · running" : ""}`,
      tone: state.running === true ? "warning" : "accent",
    },
    {
      label: "SENIOR",
      value: roleValue(state.seniorModel, state.seniorKind),
      tone: seniorUnset ? "warning" : "senior",
    },
    {
      label: "JUNIOR",
      value: roleValue(state.juniorModel, state.juniorKind),
      tone: juniorUnset ? "warning" : "junior",
    },
    { label: "CONTEXT", value: contextValue(state), tone: "muted" },
    { label: "TOKENS", value: tokenValue(state), tone: "muted" },
    {
      label: "CACHE",
      value: state.cachedTokens === undefined ? "unknown" : formatCount(state.cachedTokens),
      tone: "muted",
    },
    {
      label: "COST",
      value: costValue(state.cost),
      tone: state.cost === null ? "warning" : "muted",
    },
    {
      label: "ELAPSED",
      value: state.elapsedMs === undefined ? "unknown" : formatElapsed(state.elapsedMs),
      tone: "muted",
    },
    {
      label: "PROVIDER",
      value: (state.provider ?? "").trim() || "unknown",
      tone: "muted",
    },
    {
      label: "SESSION",
      value: `${(state.sessionName ?? "").trim() || "in-memory"}${
        state.resume === true ? " · resume" : ""
      }`,
      tone: "muted",
    },
    { label: "CWD", value: (state.cwd ?? "").trim() || "unknown", tone: "dim" },
    {
      label: "COMPACT",
      value: compactionValue(state.compaction),
      tone: state.compaction === undefined || state.compaction.mode === "off" ? "dim" : "muted",
    },
    {
      label: "PLUGINS",
      value: pluginsValue(state.discovery?.plugins),
      tone: "muted",
    },
    { label: "SKILLS", value: skillsValue(state.discovery?.skills), tone: "muted" },
    {
      label: "COMMANDS",
      value:
        state.discovery?.commands === undefined ? "unknown" : String(state.discovery.commands),
      tone: "muted",
    },
    { label: "MCP", value: mcpValue(state.discovery?.mcp), tone: "muted" },
    { label: "", value: "", tone: "dim" },
  ];
  for (const tip of sidePanelKeyTips(commands)) rows.push({ label: "", value: tip, tone: "dim" });
  return rows;
}

/**
 * Render the content rows to exactly `contentWidth` columns (or less, since
 * `renderBox` pads). Values are sanitized (terminal controls removed) and
 * truncated with `…`; labels are dim.
 */
export function sidePanelRows(
  state: SidePanelState,
  contentWidth: number,
  theme: Theme = plainTheme,
  commands: readonly TuiCommand[] = TUI_COMMANDS,
): string[] {
  const columns = Math.max(1, Math.floor(contentWidth));
  const rows: string[] = [];
  for (const cell of sidePanelEntries(state, commands)) {
    const value = sanitizeDisplayText(cell.value);
    if (cell.label === "") {
      rows.push(value === "" ? "" : theme.paint(cell.tone, truncateToWidth(value, columns)));
      continue;
    }
    if (columns <= LABEL_WIDTH) {
      rows.push(
        theme.paint(cell.tone, truncateToWidth(`${cell.label} ${value}`, columns)),
      );
      continue;
    }
    const label = cell.label.padEnd(LABEL_WIDTH);
    rows.push(
      theme.paint("dim", label) + theme.paint(cell.tone, truncateToWidth(value, columns - LABEL_WIDTH)),
    );
  }
  return rows;
}

/** Options for {@link sidePanelView}. */
export interface SidePanelViewOptions {
  width: number;
  height: number;
  theme?: Theme;
  /** Registry commands whose effective chords drive the key-tip rows (default `TUI_COMMANDS`). */
  commands?: readonly TuiCommand[];
}

/**
 * Render exactly `height` rows of exactly `width` columns (a bordered box
 * with the content padded/truncated to fit). Degenerate sizes fall back to
 * fitted plain rows so a resize can never emit a torn frame.
 */
export function sidePanelView(state: SidePanelState, options: SidePanelViewOptions): string[] {
  const width = Math.max(0, Math.floor(options.width));
  const height = Math.max(0, Math.floor(options.height));
  if (width === 0 || height === 0) return [];
  const theme = options.theme ?? plainTheme;
  const contentWidth = Math.max(1, boxContentWidth(width));
  const rows = sidePanelRows(state, contentWidth, theme, options.commands ?? TUI_COMMANDS);

  if (width < 4 || height < 4) {
    const lines = rows.slice(0, height).map((row) => fitStyled(row, width));
    while (lines.length < height) lines.push(blankRow(width));
    return lines;
  }

  const inner = height - 2;
  const content = rows.slice(0, inner);
  while (content.length < inner) content.push("");
  return renderBox(content, {
    width,
    title: SIDE_PANEL_TITLE,
    theme,
    tone: state.running === true ? "warning" : "border",
  });
}
