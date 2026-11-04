/**
 * Tool-result bounding and display sanitizing.
 *
 * Bounded output windows + ANSI sanitizing, informed by pi (MIT,
 * github.com/earendil-works/pi) chord/src/output.ts. pi keeps a bounded head
 * or tail window of a stream at O(chunk) cost and strips escape sequences
 * before output reaches the model; our tool results are whole strings by the
 * time we see them, so this is our own simpler take: a synchronous
 * head+tail window over the final text (keeping both ends, with a middle
 * marker in the exact style of the shell runner's truncation) plus a display
 * sanitizer that removes ANSI escape sequences and control characters.
 *
 * Everything here is pure string surgery — no I/O, no dependencies.
 */

/**
 * Whole 7-bit escape sequences: strings (OSC, DCS, APC, PM, SOS) up to BEL or
 * ST, CSI, and short `ESC x` forms. Same coverage as pi's ESCAPE_SEQUENCE.
 */
const ESCAPE_SEQUENCE =
  /\x1b[\]PX^_][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]|\x1b[\x20-\x2f]*[\x30-\x7e]/g;

/** Control characters that break display and transcripts; tabs/newlines stay. */
const CONTROL_CHARACTERS = /[\x00-\x08\x0b-\x1f\ufff9-\ufffb]/g;

/**
 * Remove ANSI escape sequences and control characters from text that came
 * off a terminal (or a file pretending to be one), so junk like cursor
 * movement, color resets, and bell characters never reaches the shared model
 * context or the JSONL transcript. Tabs and newlines are preserved.
 */
export function sanitizeOutput(text: string): string {
  return text.replace(ESCAPE_SEQUENCE, "").replace(CONTROL_CHARACTERS, "");
}

/** A text run bounded to a window, with what the window dropped. */
export interface BoundedText {
  /** The kept text: a head window, a marker line, then a tail window. */
  text: string;
  /** True when `text` was shorter than the input. */
  truncated: boolean;
  /** Characters of the input omitted from `text` (marker excluded). */
  omittedChars: number;
}

/**
 * Bound `text` to roughly `maxChars` of its own characters, keeping the head
 * and the tail with a middle marker:
 *
 * ```
 * <head half>\n...[truncated N chars]...\n<tail half>
 * ```
 *
 * The marker format matches the shell runner's truncation exactly
 * (`shell.ts`), so every bounded tool result reads the same way to the model.
 * Inputs at or under the cap pass through untouched (no marker, truncated:
 * false), which keeps small-file results byte-stable. Lengths are measured in
 * UTF-16 code units, as with the existing shell cap.
 */
export function boundOutput(text: string, maxChars: number): BoundedText {
  if (text.length <= maxChars) {
    return { text, truncated: false, omittedChars: 0 };
  }
  const headLen = Math.ceil(maxChars / 2);
  const tailLen = Math.floor(maxChars / 2);
  return {
    text:
      text.slice(0, headLen) +
      `\n...[truncated ${text.length - maxChars} chars]...\n` +
      text.slice(text.length - tailLen),
    truncated: true,
    omittedChars: text.length - maxChars,
  };
}

/**
 * Serialize a structured tool result (or any JSON value) for size accounting,
 * so aggregate caps can be enforced over the exact bytes the model would see.
 */
export function resultSize(value: unknown): number {
  return JSON.stringify(value)?.length ?? 0;
}
