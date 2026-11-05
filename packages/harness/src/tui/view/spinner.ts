import { clipStyled, styledWidth } from "../screen.ts";
import { plainTheme, type Theme } from "../theme.ts";

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/** Select a frame solely from the supplied tick; no clock or timer is read. */
export function spinnerFrame(tick: number, motion = true): string {
  if (!motion) return SPINNER_FRAMES[0];
  const index = Number.isFinite(tick) ? Math.floor(tick) : 0;
  return SPINNER_FRAMES[((index % SPINNER_FRAMES.length) + SPINNER_FRAMES.length) % SPINNER_FRAMES.length];
}

export interface SpinnerOptions {
  width?: number;
  theme?: Theme;
  motion?: boolean;
}

/** Render an activity indicator with a textual label for NO_COLOR output. */
export function renderSpinner(tick: number, label = "working", options: SpinnerOptions = {}): string {
  const theme = options.theme ?? plainTheme;
  const text = `${spinnerFrame(tick, options.motion ?? true)} ${label}`;
  return clipStyled(theme.paint("notice", text), Math.max(0, Math.floor(options.width ?? styledWidth(text))));
}
