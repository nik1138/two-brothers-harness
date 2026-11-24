/**
 * The one head-and-tail notice bound shared by every TUI surface that composes
 * operator copy (`boundToastText`, `boundForkNotice`, `boundRewindNotice`).
 *
 * The overlay is top-cropped at the screen height (`screen.ts` `overlayRows`),
 * so an unbounded notice would lose exactly its tail — a `— usage: …` clause or
 * the diagnostic end of an error. Keeping the head AND the tail and eliding
 * only the middle is the same split on every surface; each caller keeps its own
 * named ceiling (the toast and the `/fork` / `/rewind` notices share 320).
 */
export function boundNoticeText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const tail = Math.floor((maxChars - 1) / 2);
  return `${text.slice(0, maxChars - 1 - tail)}…${text.slice(text.length - tail)}`;
}
