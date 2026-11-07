import { TUI_COMMANDS, hintSegments } from "../keymap.ts";
import { clipStyled, fitStyled, styledWidth } from "../screen.ts";
import { plainTheme, type Theme, type ThemeToken } from "../theme.ts";

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
  hints?: string;
}

export interface StatusSegment {
  text: string;
  tone: ThemeToken;
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
  const second: StatusSegment[] = [];
  if (state.activity?.trim()) {
    second.push({ text: state.activity.trim(), tone: state.running === true ? "warning" : "notice" });
  }
  second.push({
    text: state.hints ?? hintSegments(TUI_COMMANDS, [
      { id: "palette", label: "commands" },
      { id: "help", label: "help" },
    ]),
    tone: "dim",
  });
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

/**
 * Fit as many whole segments as possible, in priority order. An over-wide
 * segment is omitted, never cut in half; later smaller segments may still fit.
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
    const addition = row === "" ? segment.text.length === 0 ? 0 : styledWidth(segment.text) : styledWidth(` · ${segment.text}`);
    if (used + addition > columns) continue;
    if (row === "") row += theme.paint(segment.tone, segment.text);
    else row += theme.paint("dim", " · ") + theme.paint(segment.tone, segment.text);
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
