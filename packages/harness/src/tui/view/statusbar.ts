import { TUI_COMMANDS, hintSegments } from "../keymap.ts";
import { clipDisplay, clipStyled, fitStyled, styledWidth } from "../screen.ts";
import { plainTheme, type Theme, type ThemeToken } from "../theme.ts";

/**
 * Honest way out while a mutation/shell approval is parked. The approval panel
 * owns the decision keys, so Ctrl+C is inert until the request is answered:
 * deny first, the turn continues, and Ctrl+C can then stop it. Copy only — no
 * key handler reads this constant and no binding changes.
 */
export const APPROVAL_PARKED_HINT =
  "deny to continue — Ctrl+C stops the turn after it resolves";

/** How a transient slot is chosen for one render. */
export interface TransientHintOptions {
  /** An approval is parked: its quit-path copy outranks a one-shot hint. */
  approvalParked?: boolean;
  /** A one-shot transient hint (e.g. after a stopped turn). */
  transient?: string | undefined;
}

/**
 * Choose the transient status-bar slot: a parked approval always explains the
 * quit path, otherwise a live one-shot hint wins, otherwise there is none and
 * the rotating projection hint keeps the row.
 */
export function transientHintFor(options: TransientHintOptions): string | undefined {
  if (options.approvalParked === true) return APPROVAL_PARKED_HINT;
  const text = options.transient?.trim() ?? "";
  return text === "" ? undefined : text;
}

export interface StatusBarState {
  mode: string;
  seniorModel?: string;
  juniorModel?: string;
  sessionName?: string;
  cwd?: string;
  running?: boolean;
  activity?: string;
  contextTokens?: number;
  contextWindow?: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  /** Null is an honest unknown price; undefined omits the cost segment. */
  cost?: number | null;
  elapsedMs?: number;
  /** The rotating projection hint (or the app's composed tool-fold hint). */
  hints?: string;
  /**
   * Higher-priority, one-shot hint (a parked approval, a just-stopped turn).
   * It replaces the projection hint while present and is width-clipped rather
   * than dropped, so the actionable copy is never cut into a false label; the
   * activity segment and the mode/models row are never displaced.
   */
  transientHint?: string;
}

export interface StatusSegment {
  text: string;
  tone: ThemeToken;
  /**
   * Fit by clipping into the remaining cells (with a real ellipsis) instead of
   * being dropped whole. Used by the transient slot, whose actionable copy
   * should be shown as far as it fits; projection hints stay whole segments.
   */
  clip?: boolean;
}

export interface StatusBarOptions {
  width: number;
  theme?: Theme;
}

/** Compact count used by the status bar and the side panel (`12.5k`, `1.2m`). */
export function formatCount(value: number): string {
  const safe = Number.isFinite(value) ? Math.max(0, value) : 0;
  if (safe < 1_000) return String(Math.floor(safe));
  if (safe < 1_000_000) return `${(safe / 1_000).toFixed(safe < 100_000 ? 1 : 0)}k`;
  return `${(safe / 1_000_000).toFixed(safe < 10_000_000 ? 1 : 0)}m`;
}

/**
 * `$0.0123` for a known run cost, `null` when the price cannot be attributed
 * to the run's models (the caller prints the honest `cost unknown` marker).
 */
export function formatCost(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  return `$${Math.max(0, value).toFixed(4)}`;
}

/** Deterministic compact elapsed time; the caller supplies the measurement. */
export function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor((Number.isFinite(milliseconds) ? milliseconds : 0) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function modelSegment(role: "SENIOR" | "JUNIOR", model: string | undefined): StatusSegment {
  const value = model?.trim() ?? "";
  return value === ""
    ? { text: `${role} unset`, tone: "warning" }
    : { text: `${role} ${value}`, tone: role === "SENIOR" ? "senior" : "junior" };
}

/** Build both semantic rows before responsive fitting. */
export function statusBarSegments(state: StatusBarState): [StatusSegment[], StatusSegment[]] {
  const first: StatusSegment[] = [
    { text: state.mode.trim() || "consult", tone: "accent" },
  ];
  if (state.running === true) first.push({ text: "RUNNING", tone: "warning" });
  first.push(modelSegment("SENIOR", state.seniorModel));
  first.push(modelSegment("JUNIOR", state.juniorModel));
  if (state.sessionName?.trim()) first.push({ text: `session ${state.sessionName.trim()}`, tone: "muted" });
  if (state.cwd?.trim()) first.push({ text: state.cwd.trim(), tone: "dim" });

  // Learned from the on-screen keys: the hint is a discoverability affordance,
  // not a trailing flourish. It sits right after the live activity so the
  // tool-fold hint ("Ctrl+T expand tool") and the default palette/help hints
  // still fit at ordinary terminal widths; the metrics after it are optional
  // detail that may be dropped first. The "/settings configures models"
  // warning is last because row one already names an unset role as a warning.
  // A transient hint is the highest-priority occupant of the hint slot: it is
  // clipped to whatever the activity leaves, and the rotating hint returns once
  // it expires.
  const second: StatusSegment[] = [];
  if (state.activity?.trim()) {
    second.push({ text: state.activity.trim(), tone: state.running === true ? "warning" : "notice" });
  }
  const transient = state.transientHint?.trim() ?? "";
  if (transient !== "") {
    second.push({ text: transient, tone: "dim", clip: true });
  } else {
    second.push({
      text: state.hints ?? hintSegments(TUI_COMMANDS, [
        { id: "palette", label: "commands" },
        { id: "help", label: "help" },
      ]),
      tone: "dim",
    });
  }
  if (state.contextTokens !== undefined || state.contextWindow !== undefined) {
    const used = state.contextTokens === undefined ? "?" : formatCount(state.contextTokens);
    const total = state.contextWindow === undefined ? "?" : formatCount(state.contextWindow);
    second.push({ text: `context ${used}/${total}`, tone: "muted" });
  }
  if (state.inputTokens !== undefined || state.outputTokens !== undefined) {
    second.push({
      text: `tokens ${formatCount(state.inputTokens ?? 0)} in · ${formatCount(state.outputTokens ?? 0)} out`,
      tone: "muted",
    });
  }
  if (state.cachedTokens !== undefined) {
    second.push({ text: `cache ${formatCount(state.cachedTokens)}`, tone: "muted" });
  }
  if (state.cost !== undefined) {
    const amount = state.cost === null ? null : formatCost(state.cost);
    second.push({
      text: amount === null ? "cost unknown" : `cost ${amount}`,
      tone: amount === null ? "warning" : "muted",
    });
  }
  if (state.elapsedMs !== undefined) {
    second.push({ text: formatElapsed(state.elapsedMs), tone: "muted" });
  }
  if ((state.seniorModel ?? "").trim() === "" || (state.juniorModel ?? "").trim() === "") {
    second.push({ text: "/settings configures models", tone: "warning" });
  }
  return [first, second];
}

/** Minimum cells worth spending on a clipped segment; below it the slot is omitted. */
const MIN_CLIP_COLUMNS = 8;

/**
 * Fit as many whole segments as possible, in priority order. An over-wide
 * projection segment is omitted, never cut in half; later smaller segments may
 * still fit. A `clip` segment (the transient hint slot) is instead clipped into
 * whatever cells remain, with a real ellipsis and never mid-grapheme.
 */
export function fitStatusSegments(
  segments: readonly StatusSegment[],
  width: number,
  theme: Theme = plainTheme,
): string {
  const columns = Math.max(0, Math.floor(width));
  if (columns === 0) return "";
  let row = "";
  let used = 0;
  for (const segment of segments) {
    if (segment.text === "") continue;
    const separator = row === "" ? "" : " · ";
    const separatorWidth = row === "" ? 0 : styledWidth(separator);
    const remaining = columns - used - separatorWidth;
    if (remaining <= 0) continue;
    if (segment.clip === true) {
      // The transient slot is clipped, not dropped: show as much actionable
      // copy as fits, then let the rest of the row continue.
      if (remaining < MIN_CLIP_COLUMNS) continue;
      const text = styledWidth(segment.text) <= remaining
        ? segment.text
        : clipDisplay(segment.text, remaining);
      if (text === "") continue;
      if (row !== "") row += theme.paint("dim", separator);
      row += theme.paint(segment.tone, text);
      used += separatorWidth + styledWidth(text);
      continue;
    }
    const addition = separatorWidth + styledWidth(segment.text);
    if (used + addition > columns) continue;
    if (row === "") row += theme.paint(segment.tone, segment.text);
    else row += theme.paint("dim", separator) + theme.paint(segment.tone, segment.text);
    used += addition;
  }
  return clipStyled(row, columns);
}

/** Render exactly two rows, each no wider than the requested terminal width. */
export function renderStatusBar(state: StatusBarState, options: StatusBarOptions): string[] {
  const width = Math.max(0, Math.floor(options.width));
  if (width === 0) return ["", ""];
  const theme = options.theme ?? plainTheme;
  return statusBarSegments(state).map((segments) =>
    fitStyled(fitStatusSegments(segments, width, theme), width),
  );
}
