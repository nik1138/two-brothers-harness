/**
 * Background attention for the TUI: a terminal title and at most one
 * conservative desktop notification.
 *
 * Everything here is pure: the functions build the exact bytes the terminal
 * driver writes, and never touch a stream or the environment directly. The
 * app decides **when** the title changes (session start/switch and run status
 * transitions) and when a notification is allowed (one per approval id), and
 * `terminal.ts` owns the guarded write.
 *
 * The notification allow-list is deliberately small: an OSC 9 only reaches a
 * terminal that documents it (iTerm2, WezTerm, Ghostty, Warp, kitty) or a tmux
 * client (wrapped in a DCS passthrough), and everything else gets one BEL.
 * Titles and notification text are sanitized (no control bytes) and capped, so
 * a model-written session title can never emit an escape sequence.
 */
import { ANSI } from "./render.ts";

/** Product name used when a caller supplies none. */
export const PRODUCT_NAME = "Two Brothers";
/** Hard cap for the rendered terminal title (code units). */
export const MAX_TITLE_CHARS = 120;
/** Hard cap for the OSC 9 / tmux notification message (code units). */
export const MAX_NOTIFICATION_CHARS = 200;

const BEL = "\u0007";
const ST = `${ANSI.esc}\\`;

/** Run states the title may advertise (idle is the absence of a status). */
export type AttentionStatus = "working" | "approval" | "done" | "failed";

const ATTENTION_STATUSES: readonly AttentionStatus[] = [
  "working",
  "approval",
  "done",
  "failed",
];

function isAttentionStatus(value: unknown): value is AttentionStatus {
  return (
    typeof value === "string" &&
    (ATTENTION_STATUSES as readonly string[]).includes(value)
  );
}

/** Inputs for {@link terminalTitle}. */
export interface TerminalTitleInput {
  /** Product label (default {@link PRODUCT_NAME}). */
  product?: string;
  /** Session label; omitted/empty leaves just the product name. */
  session?: string | null;
  /** Run status; an unknown value is ignored (never printed). */
  status?: string | null;
}

/** One notification body; the sink adds the terminal-specific framing. */
export interface NotificationInput {
  title: string;
  body?: string;
}

/**
 * A destination for attention writes. `terminal.ts` implements the real one;
 * tests and embeds inject a recorder so no escape byte reaches a terminal.
 */
export interface AttentionSink {
  setTitle(title: string): void;
  notify(input: NotificationInput): void;
}

/**
 * Strip control bytes (C0, DEL, C1 — including BEL/ESC/ST, so notification
 * text can never terminate its own sequence), collapse whitespace and trim.
 */
export function sanitizeAttentionText(text: string): string {
  return text
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Cut `text` to at most `max` code units, marking the cut with an ellipsis. */
function truncate(text: string, max: number): string {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * Build the terminal title: `Two Brothers — <session> · <status>`, with the
 * session and status each optional. Sanitized and capped at
 * {@link MAX_TITLE_CHARS}; the status suffix is kept visible when the session
 * label needs truncating.
 */
export function terminalTitle(input: TerminalTitleInput = {}): string {
  const product =
    sanitizeAttentionText(input.product ?? "") || PRODUCT_NAME;
  const session = sanitizeAttentionText(input.session ?? "");
  const status = isAttentionStatus(input.status) ? input.status : null;
  const suffix = status === null ? "" : ` · ${status}`;
  let base = session === "" ? product : `${product} — ${session}`;
  const available = MAX_TITLE_CHARS - suffix.length;
  if (available <= 1) return truncate(product, MAX_TITLE_CHARS);
  if (base.length > available) base = truncate(base, available);
  return `${base}${suffix}`;
}

/** The OSC 0 sequence that sets the terminal title (XTerm/ECMA-48). */
export function terminalTitleSequence(title: string): string {
  const clean = truncate(sanitizeAttentionText(title), MAX_TITLE_CHARS);
  return `${ANSI.esc}]0;${clean}${BEL}`;
}

/** Terminals that document OSC 9 desktop notifications. */
const TERM_PROGRAM_OSC9: ReadonlySet<string> = new Set([
  "iterm.app",
  "wezterm",
  "ghostty",
  "warpterminal",
]);
const TERM_OSC9: ReadonlySet<string> = new Set([
  "xterm-kitty",
  "ghostty",
  "xterm-ghostty",
]);

function nonEmpty(value: string | undefined): boolean {
  return typeof value === "string" && value.trim() !== "";
}

function osc9Supported(env: Record<string, string | undefined>): boolean {
  const program = (env.TERM_PROGRAM ?? "").trim().toLowerCase();
  if (TERM_PROGRAM_OSC9.has(program)) return true;
  const term = (env.TERM ?? "").trim().toLowerCase();
  return TERM_OSC9.has(term);
}

/**
 * Build the exact notification bytes for one attention event.
 *
 * 1. Inside tmux: one DCS passthrough containing an OSC 9, with every ESC in
 *    the payload doubled (`ESC Ptmux ; … ESC \`) — tmux itself is otherwise
 *    allowed to swallow the notification.
 * 2. Allow-listed terminal (see the sets above): one OSC 9.
 * 3. Anything else: exactly one BEL.
 *
 * The message is control-stripped and capped before framing, so the payload
 * can never break out of its terminator.
 */
export function terminalNotification(
  input: NotificationInput,
  env: Record<string, string | undefined> = process.env,
): string {
  const title =
    truncate(sanitizeAttentionText(input.title), MAX_TITLE_CHARS) || PRODUCT_NAME;
  const body = truncate(
    sanitizeAttentionText(input.body ?? ""),
    MAX_NOTIFICATION_CHARS,
  );
  const message = truncate(
    body === "" ? title : `${title}: ${body}`,
    MAX_NOTIFICATION_CHARS,
  );
  const osc9 = `${ANSI.esc}]9;${message}${BEL}`;
  if (nonEmpty(env.TMUX)) {
    // Double every ESC inside the payload so tmux forwards the OSC intact.
    return `${ANSI.esc}Ptmux;${osc9.replaceAll(ANSI.esc, `${ANSI.esc}${ANSI.esc}`)}${ST}`;
  }
  return osc9Supported(env) ? osc9 : BEL;
}
