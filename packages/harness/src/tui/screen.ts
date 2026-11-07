/**
 * Shared screen and text-shaping primitives for the pure TUI views.
 *
 * Everything here is deterministic and terminal-free. Model-provided text is
 * sanitized before it reaches a width calculation (CSI/OSC/other escape
 * sequences and control characters are removed), so a model reply can never
 * drive the terminal. The actual grapheme/width/wrap work is delegated to the
 * sibling `text.ts` helpers (`displayWidth`, `truncateToWidth`, `wrapText`,
 * `padToWidth`); this file only composes them.
 */
import {
  displayWidth,
  padToWidth,
  sanitizeText,
  stripAnsi as stripTextAnsi,
  truncateToWidth,
  wrapText,
} from "./text.ts";
import { plainTheme, type Theme, type ThemeToken } from "./theme.ts";

/** Remove terminal control sequences and normalize CRLF/tabs. */
export function sanitizeDisplayText(text: string): string {
  return sanitizeText(text);
}

/** Display width of sanitized plain text. */
export function textWidth(text: string): number {
  return displayWidth(sanitizeDisplayText(text));
}

/** Width of a view row that may already contain our own theme escapes. */
export function styledWidth(text: string): number {
  return displayWidth(stripAnsi(text));
}

/** Strip escapes without normalizing newlines (for already-shaped rows). */
export function stripAnsi(text: string): string {
  return stripTextAnsi(text);
}

/**
 * Greedy wrap of model text to `width` columns. Explicit newlines are
 * preserved as blank rows, matching the transcript/composer expectations.
 */
export function wrapDisplay(text: string, width: number): string[] {
  const columns = Math.max(1, Math.floor(width));
  const clean = sanitizeDisplayText(text);
  const out: string[] = [];
  for (const paragraph of clean.split("\n")) {
    if (paragraph === "") {
      out.push("");
      continue;
    }
    if (displayWidth(paragraph) <= columns) {
      out.push(paragraph);
      continue;
    }
    const rows = wrapText(paragraph, columns);
    if (rows.length === 0) out.push("");
    else out.push(...rows);
  }
  return out.length === 0 ? [""] : out;
}

/** Clip sanitized model text to `width` columns (no trailing padding). */
export function clipDisplay(text: string, width: number): string {
  const columns = Math.max(0, Math.floor(width));
  const clean = sanitizeDisplayText(text);
  if (columns === 0) return "";
  return displayWidth(clean) <= columns ? clean : truncateToWidth(clean, columns);
}

/** Pad sanitized model text to exactly `width` columns. */
export function padDisplay(text: string, width: number): string {
  const columns = Math.max(0, Math.floor(width));
  const clean = sanitizeDisplayText(text);
  const current = displayWidth(clean);
  if (current === columns) return clean;
  if (current > columns) return truncateToWidth(clean, columns);
  return padToWidth(clean, columns);
}

/** Fit sanitized model text to exactly `width` columns. */
export function fitDisplay(text: string, width: number): string {
  return padDisplay(text, width);
}

/** Clip an already-styled row without letting a truncation tear an escape. */
export function clipStyled(text: string, width: number): string {
  const columns = Math.max(0, Math.floor(width));
  if (columns === 0) return "";
  const current = styledWidth(text);
  if (current <= columns) return text;
  return truncateToWidth(stripAnsi(text), columns);
}

/** Fit an already-styled row to exactly `width` columns. */
export function fitStyled(text: string, width: number): string {
  const columns = Math.max(0, Math.floor(width));
  const current = styledWidth(text);
  if (current > columns) return truncateToWidth(stripAnsi(text), columns);
  if (current === columns) return text;
  return text + " ".repeat(columns - current);
}

/** Center a styled row inside `width` and pad it to the full width. */
export function centerStyled(text: string, width: number): string {
  const columns = Math.max(0, Math.floor(width));
  const current = styledWidth(text);
  if (current >= columns) return fitStyled(text, columns);
  const left = Math.floor((columns - current) / 2);
  return fitStyled(" ".repeat(left) + text, columns);
}

/** Usable content width inside a bordered box with the given padding. */
export function boxContentWidth(width: number, padding = 1): number {
  const columns = Math.max(0, Math.floor(width));
  const inner = Math.max(0, columns - 2);
  if (inner <= 2) return inner;
  const safePadding = Math.max(0, Math.min(Math.floor(padding), Math.floor((inner - 1) / 2)));
  return Math.max(1, inner - safePadding * 2);
}

/** Options for {@link renderBox}. `content` rows must already be wrapped. */
export interface BoxOptions {
  width: number;
  title?: string;
  tone?: ThemeToken;
  theme?: Theme;
  padding?: number;
}

/**
 * Draw a box around already-wrapped, possibly styled content rows.
 *
 * The box never wraps or reflows content: callers use {@link wrapDisplay}
 * with {@link boxContentWidth} first. Rows wider than the content area are
 * clipped (styling is dropped only on that overflow path).
 */
export function renderBox(content: readonly string[], options: BoxOptions): string[] {
  const width = Math.max(0, Math.floor(options.width));
  if (width === 0) return [];
  const theme = options.theme ?? plainTheme;
  const tone = options.tone ?? "border";
  const border = (text: string): string => theme.paint(tone, text);

  if (width < 4) {
    return content.map((row) => clipStyled(row, width));
  }

  const inner = width - 2;
  const padding = Math.max(
    0,
    Math.min(Math.floor(options.padding ?? 1), Math.max(0, Math.floor((inner - 1) / 2))),
  );
  const contentWidth = Math.max(1, inner - padding * 2);
  const out: string[] = [];

  // The decorated title is "─ " + title + " " (three extra columns), so the
  // title itself must fit inner - 3 or the top border grows past `width`.
  const title = options.title === undefined
    ? ""
    : clipDisplay(options.title.trim(), Math.max(0, inner - 3));
  if (title === "") {
    out.push(border("╭" + "─".repeat(inner) + "╮"));
  } else {
    const decorated = `─ ${title} `;
    const used = displayWidth(decorated);
    const dashes = Math.max(0, inner - used);
    out.push(border("╭") + theme.paint("accent", decorated) + border("─".repeat(dashes)) + border("╮"));
  }

  const side = border("│");
  const leftPad = " ".repeat(padding);
  const rightPad = " ".repeat(padding);
  for (const row of content) {
    out.push(side + leftPad + fitStyled(row, contentWidth) + rightPad + side);
  }
  out.push(border("╰" + "─".repeat(inner) + "╯"));
  return out;
}

/** Options for {@link composeScreen}. */
export interface ScreenLayout {
  width: number;
  height: number;
  header?: readonly string[];
  body?: readonly string[];
  footer?: readonly string[];
  /** Rows to place over the body (a dialog already rendered to a box). */
  overlay?: readonly string[];
  bodyAnchor?: "top" | "bottom";
  overlayAlign?: "top" | "center";
  /** Center overlay rows horizontally (default true). */
  overlayCenter?: boolean;
}

/**
 * Compose a fixed-size screen from header/body/footer rows and an optional
 * overlay. The result always has exactly `height` rows (or is empty when the
 * height is zero), and every row is exactly `width` columns.
 */
export function composeScreen(layout: ScreenLayout): string[] {
  const width = Math.max(0, Math.floor(layout.width));
  const height = Math.max(0, Math.floor(layout.height));
  if (height === 0) return [];

  const header = (layout.header ?? []).map((row) => fitStyled(row, width));
  const footer = (layout.footer ?? []).map((row) => fitStyled(row, width));
  let body = (layout.body ?? []).map((row) => fitStyled(row, width));
  const blank = " ".repeat(width);

  if (header.length + footer.length >= height) {
    return [...header, ...footer].slice(0, height);
  }

  const bodySpace = height - header.length - footer.length;
  let bodyRows: string[];
  if (layout.bodyAnchor === "bottom") {
    const visible = body.slice(Math.max(0, body.length - bodySpace));
    bodyRows = [...Array.from({ length: bodySpace - visible.length }, () => blank), ...visible];
  } else {
    bodyRows = body.slice(0, bodySpace);
    while (bodyRows.length < bodySpace) bodyRows.push(blank);
  }

  let rows = [...header, ...bodyRows, ...footer];
  if (layout.overlay !== undefined && layout.overlay.length > 0) {
    rows = overlayRows(rows, layout.overlay, {
      width,
      align: layout.overlayAlign ?? "center",
      center: layout.overlayCenter ?? true,
    });
  }
  return rows.map((row) => fitStyled(row, width));
}

/** Place overlay rows over a base row array, preserving the base height. */
export function overlayRows(
  base: readonly string[],
  overlay: readonly string[],
  options: { width: number; align?: "top" | "center"; center?: boolean } = { width: 0 },
): string[] {
  const width = Math.max(0, Math.floor(options.width));
  const prepared = overlay.map((row) =>
    options.center === true ? centerStyled(row, width) : fitStyled(row, width),
  );
  if (prepared.length === 0 || base.length === 0) return [...base];
  const visible = prepared.length > base.length
    ? prepared.slice(
        options.align === "top" ? 0 : Math.floor((prepared.length - base.length) / 2),
        (options.align === "top" ? 0 : Math.floor((prepared.length - base.length) / 2)) + base.length,
      )
    : prepared;
  const start = options.align === "top" ? 0 : Math.max(0, Math.floor((base.length - visible.length) / 2));
  const rows = [...base];
  for (let i = 0; i < visible.length; i += 1) {
    const target = start + i;
    if (target >= 0 && target < rows.length) rows[target] = visible[i] ?? rows[target] ?? "";
  }
  return rows;
}

/** A blank row of `width` spaces. */
export function blankRow(width: number): string {
  return " ".repeat(Math.max(0, Math.floor(width)));
}