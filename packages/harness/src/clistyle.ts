/**
 * Semantic color for the human (non-TUI) CLI.
 *
 * This module is a thin adapter over the existing TUI theme layer
 * (`src/tui/theme.ts`): it owns no ANSI sequences of its own, adds no
 * dependency, and exposes the same semantic tokens (`accent`, `muted`,
 * `decision`, `error`, …). Views ask for a token, never for a raw color.
 *
 * The style is OPT-IN and terminal-gated:
 *
 * - stdout is not a TTY and `FORCE_COLOR` is unset → {@link plainCliStyle}
 *   (the identity style), so piped output stays byte-identical;
 * - a TTY whose terminal reports 2/4/8-bit color gets the 16-color palette;
 *   24-bit color gets the dark or light truecolor palette (`COLORFGBG`,
 *   `TWO_BROTHERS_THEME`); `NO_COLOR` (non-empty), `TERM=dumb` and a reported
 *   depth of 0/1 mean plain;
 * - `FORCE_COLOR=0|false` is plain even on a TTY; `FORCE_COLOR=1|2|3` forces
 *   color at 16/256/truecolor even when piped, and wins over `NO_COLOR`;
 * - `TWO_BROTHERS_THEME=dark|light|ansi16` selects the palette where the
 *   terminal supports it (below 24-bit the 16-color palette is the only one
 *   every supported terminal can render);
 * - machine output modes never call this module at all — the CLI resolves a
 *   style for text mode and passes {@link plainCliStyle} to machine branches.
 *
 * `getColorDepth()` only exists on a TTY `process.stdout`; a piped stream
 * reports depth 1, which is exactly the "no color" signal. Windows is covered
 * by the same Node API.
 */
import {
  colorEnabled,
  createTheme,
  detectThemeMode,
  plainTheme,
  type EmphasisStyle,
  type ThemeMode,
  type ThemeToken,
} from "./tui/theme.ts";

/**
 * The CLI text surface's style. It is a narrow view of the TUI `Theme`: a
 * token painter plus the two attribute helpers the printers use. `paint` is
 * the only way text gains an SGR sequence, and `plainCliStyle` makes it the
 * identity function.
 */
export interface CliStyle {
  /** False for {@link plainCliStyle}; true only when SGR sequences are emitted. */
  readonly color: boolean;
  /** Paint `text` with one semantic token (identity when `color` is false). */
  paint(token: ThemeToken, text: string): string;
  /**
   * Paint `text` with a token plus one Markdown emphasis (`bold`, `italic`,
   * `code`, `link`, `marker`); the transcript's Markdown bodies use it so the
   * span vocabulary and its SGR stay in `tui/theme.ts`. Identity when
   * `color` is false, and `emphasis: undefined` is exactly {@link paint}.
   */
  paintEmphasis(token: ThemeToken, emphasis: EmphasisStyle | undefined, text: string): string;
  /** Bold `text` (identity when `color` is false). */
  bold(text: string): string;
  /** Dim `text` (identity when `color` is false). */
  dim(text: string): string;
}

/** The deterministic, color-free CLI style (the default for every printer). */
export const plainCliStyle: CliStyle = plainTheme;

/** Width used when stdout is not a TTY or reports no usable column count. */
export const FALLBACK_TERMINAL_WIDTH = 96;

/** Narrowest terminal width a renderer accepts before falling back to 96. */
const MIN_TERMINAL_WIDTH = 40;

/** Options for {@link resolveCliStyle} (all injectable for tests). */
export interface ResolveCliStyleOptions {
  /**
   * Terminal color depth in bits: 1 (none), 2/4 (16 colors), 8 (256 colors),
   * 24 (truecolor). Defaults to `process.stdout.getColorDepth()` when stdout
   * is a TTY and to 1 (plain) when it is not.
   */
  depth?: number;
  /** Environment to read (`NO_COLOR`, `FORCE_COLOR`, `TERM`, theme vars). */
  env?: Record<string, string | undefined>;
  /** Explicit palette override; below 24-bit depth the 16-color palette wins. */
  mode?: ThemeMode | null;
}

/**
 * Parse `FORCE_COLOR` into an enforced depth: `0` means force plain, `4`/`8`/
 * `24` force color, `null` means "not forced". `1`/`true`/empty force the
 * 16-color palette; `2` and `3` map to 256-color and truecolor (the same
 * shallow/deep levels Node itself uses).
 */
function forcedColorDepth(value: string | undefined): number | 0 | null {
  if (value === undefined) return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "0" || normalized === "false") return 0;
  if (normalized === "2") return 8;
  if (normalized === "3") return 24;
  // "1", "true", "" and any other non-empty value mean "on" at 16 colors.
  return 4;
}

/** The color depth `process.stdout` reports, or 1 for a non-TTY pipe. */
function stdoutColorDepth(): number {
  const stream = process.stdout as unknown as {
    isTTY?: boolean;
    getColorDepth?: (env?: Record<string, string | undefined>) => number;
  };
  if (typeof stream.getColorDepth === "function") {
    try {
      const depth = stream.getColorDepth();
      if (Number.isFinite(depth)) return depth;
    } catch {
      // A terminal that cannot answer is treated like a plain pipe.
    }
  }
  return 1;
}

/**
 * Resolve the CLI style. Piped output and every "no color" signal resolve to
 * {@link plainCliStyle}; the caller never has to special-case them.
 */
export function resolveCliStyle(options: ResolveCliStyleOptions = {}): CliStyle {
  const env = options.env ?? process.env;
  const forced = forcedColorDepth(env.FORCE_COLOR);
  if (forced === 0) return plainCliStyle;
  // FORCE_COLOR wins over NO_COLOR/TERM=dumb; otherwise the standard
  // "user says no" switches are authoritative.
  if (forced === null && !colorEnabled(env)) return plainCliStyle;
  const depth = forced ?? options.depth ?? stdoutColorDepth();
  if (!Number.isFinite(depth) || depth < 2) return plainCliStyle;
  // Only a truecolor terminal can render the dark/light palettes faithfully;
  // below 24-bit every supported terminal gets the 16-color palette.
  const mode: ThemeMode =
    depth >= 24 ? (options.mode ?? detectThemeMode(env)) : "ansi16";
  return createTheme(mode, { color: true });
}

/**
 * The width a help/transcript renderer may wrap to: an explicit `columns`
 * value when the caller measured one, else `process.stdout.columns` only on a
 * real TTY, else {@link FALLBACK_TERMINAL_WIDTH}. Piped output therefore
 * keeps the 96-column layout even when `FORCE_COLOR` turns paint on.
 */
export function terminalWidth(columns?: number): number {
  const stream = process.stdout as unknown as { isTTY?: boolean; columns?: number };
  const measured =
    columns ?? (stream.isTTY === true ? stream.columns : undefined);
  if (
    typeof measured === "number" &&
    Number.isFinite(measured) &&
    measured >= MIN_TERMINAL_WIDTH
  ) {
    return Math.trunc(measured);
  }
  return FALLBACK_TERMINAL_WIDTH;
}
