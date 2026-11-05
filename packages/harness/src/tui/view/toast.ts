import { boxContentWidth, renderBox, wrapDisplay } from "../screen.ts";
import { plainTheme, type Theme, type ThemeToken } from "../theme.ts";

export type ToastLevel = "info" | "warn" | "error" | "success";

export interface Toast {
  id: string;
  level: ToastLevel;
  text: string;
  details?: string;
}

export interface ToastOptions {
  width: number;
  theme?: Theme;
}

function toastTone(level: ToastLevel): ThemeToken {
  switch (level) {
    case "error": return "error";
    case "warn": return "warning";
    case "success": return "success";
    default: return "notice";
  }
}

function toastLabel(level: ToastLevel): string {
  return level === "warn" ? "WARN" : level === "error" ? "ERROR" : level.toUpperCase();
}

/** Render one self-contained toast; all text is wrapped, never truncated. */
export function renderToast(toast: Toast, options: ToastOptions): string[] {
  const width = Math.max(0, Math.floor(options.width));
  if (width === 0) return [];
  const theme = options.theme ?? plainTheme;
  const tone = toastTone(toast.level);
  const contentWidth = Math.max(1, boxContentWidth(width));
  const rows: string[] = [];
  for (const row of wrapDisplay(`${toastLabel(toast.level)}  ${toast.text}`, contentWidth)) {
    rows.push(theme.paint(tone, row));
  }
  if (toast.details !== undefined && toast.details !== "") {
    for (const row of wrapDisplay(toast.details, contentWidth)) rows.push(theme.paint("dim", row));
  }
  return renderBox(rows, { width, theme, tone });
}

/** Render toasts in caller order with no blank rows between boxes. */
export function renderToasts(toasts: readonly Toast[], options: ToastOptions): string[] {
  return toasts.flatMap((toast) => renderToast(toast, options));
}
