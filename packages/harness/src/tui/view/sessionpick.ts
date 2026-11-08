/**
 * Pure helpers behind the TUI `/sessions` resume picker: display-title
 * resolution and a short human age.
 *
 * The web sidebar and the TUI `/export` path already resolve a readable
 * session title (metadata sidecar title, else the first operator message,
 * else the file stem); the resume picker used to render raw `.jsonl` stems
 * and a raw `String(Date)` mtime instead. This module centralises that
 * resolution so the picker can be unit-tested without a TTY or a filesystem:
 * the app does the bounded IO (one sidecar read and, only when the sidecar
 * carries no title, one bounded JSONL prefix read) and hands the raw values
 * in.
 *
 * Nothing here reorders sessions: {@link sessionPickerItems} maps the entries
 * in exactly the order it receives them, and the app keeps its existing
 * alphabetical scan. Rendering stays width-safe through the picker's own
 * `clipDisplay`; the age string is deliberately tiny (`2h ago`, `3d ago`,
 * `(unknown time)`), so the description never crowds out the label at narrow
 * widths.
 */
import { deriveTitle } from "../../metadata.ts";
import type { PickerItem } from "./picker.ts";

/** Bounded number of parsed JSONL events used to derive a fallback title. */
export const SESSION_TITLE_EVENT_SCAN = 20;

/**
 * Bounded JSONL prefix the app reads for a derived title. One operator
 * message is normally within the first few lines; this cap means a huge
 * session file is never read whole just to label a picker row.
 */
export const SESSION_TITLE_PREFIX_BYTES = 64 * 1024;

/** Honest age shown when the session file's stat failed. */
export const UNKNOWN_SESSION_AGE = "(unknown time)";

/** One session as the picker sees it: raw values, no IO in this module. */
export interface SessionPickEntry {
  /** Session file name including `.jsonl`. */
  readonly name: string;
  /** Raw sidecar `title`, when a sidecar exists (untrusted). */
  readonly sidecarTitle?: unknown;
  /** Parsed JSONL prefix; only needed when the sidecar has no usable title. */
  readonly events?: ReadonlyArray<Record<string, any>> | null;
  /** `statSync(...).mtimeMs`, or `null`/`undefined` when the stat failed. */
  readonly mtimeMs?: number | null;
}

/** The picker label: the session file stem (`.jsonl` removed). */
export function sessionStem(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  return base.endsWith(".jsonl") ? base.slice(0, -".jsonl".length) : base;
}

/**
 * Resolve one session's display title: a non-blank metadata sidecar title
 * wins, then the bounded first-operator-message title (`deriveTitle`, which
 * collapses whitespace and caps at 80 characters), then the file stem.
 * `events` is the already-parsed bounded prefix; `null`/`undefined` is an
 * unreadable/corrupt session and falls through to the stem without throwing.
 */
export function resolveSessionTitle(
  name: string,
  sidecarTitle?: unknown,
  events?: ReadonlyArray<Record<string, any>> | null,
): string {
  const stem = sessionStem(name);
  if (typeof sidecarTitle === "string") {
    const trimmed = sidecarTitle.trim();
    if (trimmed !== "") return trimmed;
  }
  return deriveTitle(events as Array<Record<string, any>> | null | undefined, stem);
}

/**
 * Parse at most `limit` JSON objects from the text prefix of a session JSONL
 * file. Corrupt lines, non-object JSON (`null`, arrays, strings) and blank
 * lines are skipped silently: a half-written session still gets whatever
 * readable prefix it has, and never throws. A truncated final line is just
 * another unparseable line.
 */
export function parseSessionEventPrefix(
  text: string,
  limit: number = SESSION_TITLE_EVENT_SCAN,
): Array<Record<string, any>> {
  const max = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
  const events: Array<Record<string, any>> = [];
  if (max === 0) return events;
  for (const line of text.split("\n")) {
    if (events.length >= max) break;
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
    events.push(parsed as Record<string, any>);
  }
  return events;
}

/**
 * Short human age: `just now`, `Nm ago`, `Nh ago`, `Nd ago`, or the honest
 * `(unknown time)` when the stat failed. A future mtime (clock skew) never
 * renders a negative age. Days are intentionally the largest unit — the
 * string stays short for any age and never needs a locale.
 */
export function formatSessionAge(
  mtimeMs: number | null | undefined,
  nowMs: number = Date.now(),
): string {
  if (typeof mtimeMs !== "number" || !Number.isFinite(mtimeMs)) return UNKNOWN_SESSION_AGE;
  const deltaMs = Math.max(0, nowMs - mtimeMs);
  const seconds = Math.floor(deltaMs / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** A picker label is always one line, even if a sidecar title is not. */
function oneLineTitle(title: string): string {
  return title.replace(/\s+/g, " ").trim();
}

/** Build one picker row from a raw session entry (order is the caller's). */
export function sessionPickerItem(
  entry: SessionPickEntry,
  nowMs: number = Date.now(),
): PickerItem {
  const stem = sessionStem(entry.name);
  return {
    id: entry.name,
    label: oneLineTitle(resolveSessionTitle(entry.name, entry.sidecarTitle, entry.events)),
    description: formatSessionAge(entry.mtimeMs, nowMs),
    // The raw file name stays searchable even though it is no longer the label.
    keywords: [entry.name, stem],
  };
}

/** Build picker rows in the given order — no hidden reordering. */
export function sessionPickerItems(
  entries: readonly SessionPickEntry[],
  nowMs: number = Date.now(),
): PickerItem[] {
  return entries.map((entry) => sessionPickerItem(entry, nowMs));
}
