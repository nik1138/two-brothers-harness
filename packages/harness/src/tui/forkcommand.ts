/**
 * The `/fork` surface's pure model: argument parsing and bounded operator copy.
 *
 * `/fork [--at <seq>] [new-name]` copies the CURRENT session into a new one
 * through `src/sessionfork.ts` (byte-exact prefix, dense `seq`, parent sidecar
 * link) and then switches the TUI to the copy. This module owns only the parts
 * that need no I/O — the argument grammar, the bounded failure/success notices
 * — so the app can refuse a malformed invocation before touching the store and
 * every notice stays one bounded transcript row. The service itself is reused
 * as-is; nothing here re-implements the copy.
 */

/** The exact accepted invocation, shown by every usage refusal. */
export const FORK_USAGE = "/fork [--at <seq>] [new-name]";

/** Longest notice text (chars) before it is truncated with an ellipsis. */
export const FORK_NOTICE_MAX_CHARS = 320;

/** One validated `/fork` request; absent fields mean the service default. */
export interface ForkCommandRequest {
  /** Last envelope `seq` to copy; absent means the whole session. */
  atSeq?: number;
  /** Explicit new session name; absent means the generated `<stem>-fork-<k>`. */
  name?: string;
}

/** Parse outcome: either a request or one usage sentence (never both). */
export interface ForkCommandParse {
  request: ForkCommandRequest;
  /** A plain operator-facing usage refusal, or null when the request is valid. */
  error: string | null;
}

function usageError(problem: string): ForkCommandParse {
  // The problem can echo an operator token verbatim, so the composed sentence
  // is bounded too: on a long token only the middle of the echo is elided and
  // the `— usage:` clause (the part the operator has to act on) survives.
  return { request: {}, error: boundForkNotice(`${problem} — usage: ${FORK_USAGE}`) };
}

/**
 * Parse the argument text after `/fork`. Grammar: any order of one optional
 * `--at <seq>` (a positive decimal integer; range is the session's own and is
 * validated by the fork service) and one optional new name token. Rejections
 * are honest usage sentences naming the exact problem and the accepted form;
 * an empty argument list is the whole-session fork under a generated name.
 */
export function parseForkCommandArgs(raw: string): ForkCommandParse {
  const tokens = (typeof raw === "string" ? raw : "").trim().split(/\s+/).filter(Boolean);
  const request: ForkCommandRequest = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token === "--at") {
      if (request.atSeq !== undefined) return usageError("--at was given more than once");
      const value = tokens[index + 1];
      if (value === undefined) return usageError("--at needs a seq");
      if (!/^[0-9]+$/.test(value)) return usageError("--at must be a positive integer");
      const seq = Number(value);
      if (!Number.isSafeInteger(seq) || seq < 1) {
        return usageError("--at must be a positive integer");
      }
      request.atSeq = seq;
      index += 1;
      continue;
    }
    if (token.startsWith("--")) return usageError(`unknown option ${token}`);
    if (request.name !== undefined) return usageError(`unexpected argument ${token}`);
    request.name = token;
  }
  return { request, error: null };
}

/**
 * Bound one composed `/fork` notice so it stays one toast's worth of rows:
 * keep the head AND the tail (a `— usage: …` clause or a diagnostic tail is
 * the actionable part) and elide only the middle.
 */
export function boundForkNotice(text: string): string {
  if (text.length <= FORK_NOTICE_MAX_CHARS) return text;
  const tail = Math.floor((FORK_NOTICE_MAX_CHARS - 1) / 2);
  return `${text.slice(0, FORK_NOTICE_MAX_CHARS - 1 - tail)}…${text.slice(text.length - tail)}`;
}

/**
 * Success copy: names the source and the new session, how much was copied and
 * the one fact an operator must not have to guess (the source is untouched),
 * then states the switch. The envelope count comes from the service result, so
 * a prefix fork reports exactly what was copied.
 */
export function forkSwitchNotice(input: { source: string; name: string; events: number }): string {
  const source = input.source.trim() || "the current session";
  const name = input.name.trim() || "the new session";
  const events =
    Number.isFinite(input.events) && input.events > 0 ? Math.floor(input.events) : 0;
  const count = `${events} ${events === 1 ? "envelope" : "envelopes"} copied`;
  return (
    `forked ${source} → ${name} (${count}; the source session is untouched) ` +
    "— switched to the fork"
  );
}
