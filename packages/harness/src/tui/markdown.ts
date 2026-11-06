/**
 * Dependency-free Markdown renderer for TUI message bodies — plain-text
 * facade over the span-level model in `markdownstyle.ts`.
 *
 * `renderMarkdown` returns the same rows it always has: model Markdown turned
 * into plain, already width-safe text with every inline marker stripped. It is
 * exactly `renderMarkdownStyled(text, width).map(styledLineText)`, so the
 * styled model (`markdownstyle.ts`) is the single parser and this NO_COLOR
 * projection cannot drift from it: joining a row's spans always reproduces the
 * plain row byte for byte.
 *
 * The renderer never emits escape sequences and never lets model-supplied ANSI
 * through: the source is sanitized with `text.ts::sanitizeText` first, so a
 * reply can never drive the terminal. Color and emphasis are the transcript's
 * job — it paints each row with the role's theme token plus the per-span
 * emphasis, which keeps identity and structure readable under `NO_COLOR`.
 *
 * See `markdownstyle.ts` for the supported syntax, diff classification and
 * streaming-partial behavior; this module only projects the model to text.
 */
import { renderMarkdownStyled, styledLineText } from "./markdownstyle.ts";

/** Render Markdown to plain text rows no wider than `width` columns. */
export function renderMarkdown(text: string, width: number): string[] {
  return renderMarkdownStyled(text, width).map(styledLineText);
}
