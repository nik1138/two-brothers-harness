/**
 * Semantic theme tokens for the TUI.
 *
 * The theme layer is deliberately tiny and terminal-only: no package, no
 * framework, and no environment values beyond the handful of standard color
 * switches. Views ask for a semantic token (`senior`, `error`, `muted`, …)
 * and never for a raw color, so a dark, light or 16-color terminal gets the
 * same information hierarchy.
 *
 * `NO_COLOR` is authoritative: when it is present and non-empty, `resolveTheme`
 * returns the plain theme and `paint` is the identity function. `TERM=dumb`
 * does the same. Keys are never read here, so nothing in this module can leak
 * a provider credential into rendered output.
 */

/** The three supported terminal palettes. */
export type ThemeMode = "dark" | "light" | "ansi16";

/** Semantic colors used by the views (never a raw color outside this file). */
export type ThemeToken =
  | "bg"
  | "surface"
  | "text"
  | "strong"
  | "muted"
  | "dim"
  | "border"
  | "accent"
  | "user"
  | "senior"
  | "junior"
  | "tool"
  | "notice"
  | "warning"
  | "error"
  | "success"
  | "decision"
  | "dissent"
  | "focus"
  | "inverse";

/** SGR opening sequence per token. Empty string means "no styling". */
export type ThemeTokens = Readonly<Record<ThemeToken, string>>;

/**
 * Semantic inline emphasis a view can layer on top of a token: Markdown
 * `**bold**`, `*italic*`, `` `code` ``, link text and structural markers.
 * The escape sequences for these live only in this file, so no view spells
 * raw ANSI and `NO_COLOR`/`plainTheme` drops every attribute.
 */
export type EmphasisStyle = "bold" | "italic" | "code" | "link" | "marker";

/** A resolved theme. `paint` is the only way views emit color. */
export interface Theme {
  readonly mode: ThemeMode;
  readonly color: boolean;
  readonly tokens: ThemeTokens;
  paint(token: ThemeToken, text: string): string;
  /**
   * Paint `text` with a token color plus an optional inline emphasis. One
   * open sequence (attributes then color) and one reset keep nesting and
   * clipping safe; `emphasis` undefined is exactly {@link Theme.paint}.
   */
  paintEmphasis(token: ThemeToken, emphasis: EmphasisStyle | undefined, text: string): string;
  bold(text: string): string;
  dim(text: string): string;
  inverse(text: string): string;
}

/** Reset code appended after every painted run. */
export const RESET = "\x1b[0m";

/** SGR attribute opening per emphasis style (reset is shared with paint). */
const EMPHASIS_SGR: Readonly<Record<EmphasisStyle, string>> = {
  bold: "\x1b[1m",
  italic: "\x1b[3m",
  code: "\x1b[2m",
  link: "\x1b[4m",
  marker: "\x1b[2m",
};

const MODES: readonly ThemeMode[] = ["dark", "light", "ansi16"];

function rgb(hex: string): string {
  const cleaned = hex.replace(/^#/, "");
  const value = Number.parseInt(cleaned, 16);
  const r = (value >> 16) & 0xff;
  const g = (value >> 8) & 0xff;
  const b = value & 0xff;
  return `\x1b[38;2;${r};${g};${b}m`;
}

function bgRgb(hex: string): string {
  const cleaned = hex.replace(/^#/, "");
  const value = Number.parseInt(cleaned, 16);
  const r = (value >> 16) & 0xff;
  const g = (value >> 8) & 0xff;
  const b = value & 0xff;
  return `\x1b[48;2;${r};${g};${b}m`;
}

function truecolorDark(): ThemeTokens {
  return {
    bg: bgRgb("#111318"),
    surface: bgRgb("#1b1e26"),
    text: rgb("#e6e6e6"),
    strong: `\x1b[1m${rgb("#f2f2f2")}`,
    muted: rgb("#9aa0a6"),
    dim: `\x1b[2m${rgb("#8a8f98")}`,
    border: rgb("#3f4652"),
    accent: rgb("#7aa2f7"),
    user: rgb("#7dcfff"),
    senior: rgb("#9ece6a"),
    junior: rgb("#e0af68"),
    tool: rgb("#bb9af7"),
    notice: rgb("#7aa2f7"),
    warning: rgb("#e0af68"),
    error: rgb("#f7768e"),
    success: rgb("#9ece6a"),
    decision: `\x1b[1m${rgb("#9ece6a")}`,
    dissent: rgb("#f7768e"),
    focus: rgb("#7aa2f7"),
    inverse: "\x1b[7m",
  };
}

function truecolorLight(): ThemeTokens {
  return {
    bg: bgRgb("#ffffff"),
    surface: bgRgb("#f6f8fa"),
    text: rgb("#1f2328"),
    strong: `\x1b[1m${rgb("#1f2328")}`,
    muted: rgb("#57606a"),
    dim: `\x1b[2m${rgb("#6e7781")}`,
    border: rgb("#d0d7de"),
    accent: rgb("#0969da"),
    user: rgb("#0550ae"),
    senior: rgb("#116329"),
    junior: rgb("#953800"),
    tool: rgb("#6639ba"),
    notice: rgb("#0969da"),
    warning: rgb("#9a6700"),
    error: rgb("#cf222e"),
    success: rgb("#116329"),
    decision: `\x1b[1m${rgb("#116329")}`,
    dissent: rgb("#cf222e"),
    focus: rgb("#0969da"),
    inverse: "\x1b[7m",
  };
}

function ansi16(): ThemeTokens {
  return {
    bg: "\x1b[40m",
    surface: "\x1b[40m",
    text: "\x1b[37m",
    strong: "\x1b[1m\x1b[37m",
    muted: "\x1b[90m",
    dim: "\x1b[2m\x1b[37m",
    border: "\x1b[90m",
    accent: "\x1b[36m",
    user: "\x1b[36m",
    senior: "\x1b[32m",
    junior: "\x1b[33m",
    tool: "\x1b[35m",
    notice: "\x1b[36m",
    warning: "\x1b[33m",
    error: "\x1b[31m",
    success: "\x1b[32m",
    decision: "\x1b[1m\x1b[32m",
    dissent: "\x1b[31m",
    focus: "\x1b[36m",
    inverse: "\x1b[7m",
  };
}

function paletteFor(mode: ThemeMode): ThemeTokens {
  switch (mode) {
    case "light":
      return truecolorLight();
    case "ansi16":
      return ansi16();
    default:
      return truecolorDark();
  }
}

function makeTheme(mode: ThemeMode, color: boolean): Theme {
  const tokens = color ? paletteFor(mode) : allEmptyTokens();
  const paint = (token: ThemeToken, text: string): string => {
    if (!color || text === "") return text;
    const open = tokens[token];
    return open === "" ? text : `${open}${text}${RESET}`;
  };
  const paintEmphasis = (
    token: ThemeToken,
    emphasis: EmphasisStyle | undefined,
    text: string,
  ): string => {
    if (!color || text === "") return text;
    const attribute = emphasis === undefined ? "" : EMPHASIS_SGR[emphasis];
    const open = tokens[token];
    if (attribute === "" && open === "") return text;
    return `${attribute}${open}${text}${RESET}`;
  };
  return {
    mode,
    color,
    tokens,
    paint,
    paintEmphasis,
    bold: (text: string): string => (color && text !== "" ? `\x1b[1m${text}${RESET}` : text),
    dim: (text: string): string => (color && text !== "" ? `\x1b[2m${text}${RESET}` : text),
    inverse: (text: string): string => (color && text !== "" ? `\x1b[7m${text}${RESET}` : text),
  };
}

const EMPTY_TOKENS: ThemeTokens = Object.fromEntries(
  (
    [
      "bg",
      "surface",
      "text",
      "strong",
      "muted",
      "dim",
      "border",
      "accent",
      "user",
      "senior",
      "junior",
      "tool",
      "notice",
      "warning",
      "error",
      "success",
      "decision",
      "dissent",
      "focus",
      "inverse",
    ] satisfies ThemeToken[]
  ).map((token) => [token, ""]),
) as ThemeTokens;

function allEmptyTokens(): ThemeTokens {
  return { ...EMPTY_TOKENS };
}

/** A deterministic, color-free theme for tests and non-color output. */
export const plainTheme: Theme = makeTheme("dark", false);

/** A color theme. Explicit `color: false` gives the plain theme. */
export function createTheme(mode: ThemeMode = "dark", options: { color?: boolean } = {}): Theme {
  return makeTheme(mode, options.color ?? true);
}

/**
 * True when color output is allowed. `NO_COLOR` (non-empty) and `TERM=dumb`
 * disable it; nothing else in the environment participates.
 */
export function colorEnabled(env: Record<string, string | undefined> = process.env): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.TERM === "dumb") return false;
  return true;
}

/** Pick a palette from the pinned theme env var, then `COLORFGBG`, else dark. */
export function detectThemeMode(env: Record<string, string | undefined> = process.env): ThemeMode {
  const explicit = (env.TWO_BROTHERS_THEME ?? "").trim().toLowerCase();
  if ((MODES as readonly string[]).includes(explicit)) return explicit as ThemeMode;

  const fgbg = (env.COLORFGBG ?? "").trim();
  if (fgbg !== "") {
    const parts = fgbg.split(";");
    const background = Number.parseInt(parts[parts.length - 1] ?? "", 10);
    if (Number.isFinite(background)) return background >= 8 ? "light" : "dark";
  }
  return "dark";
}

/**
 * Resolve the theme for a run. `NO_COLOR` wins even when `color: true` is
 * passed, because the user's terminal preference is authoritative.
 */
export function resolveTheme(
  options: {
    mode?: ThemeMode | null;
    env?: Record<string, string | undefined>;
    color?: boolean;
  } = {},
): Theme {
  const env = options.env ?? process.env;
  const enabled = options.color === false ? false : colorEnabled(env);
  const mode = options.mode ?? detectThemeMode(env);
  return makeTheme(mode, enabled);
}