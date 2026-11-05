/**
 * Durable prompt history for the TUI.
 *
 * The store is deliberately tiny and fail-soft: a submitted prompt should
 * survive a TUI restart, but a missing, unreadable or corrupt history file
 * must never stop the app or print anything. File IO is synchronous and
 * best-effort, and saves are atomic (a uniquely named temp file in the same
 * directory followed by a rename) so a crash can never leave a half-written
 * history behind.
 *
 * Shape (versioned, newest-last):
 *
 *   { "version": 1, "entries": ["oldest", …, "newest"] }
 *
 * The same caps as the editor apply: {@link TUI_HISTORY_MAX_ENTRIES} entries
 * and {@link TUI_HISTORY_MAX_ENTRY_CHARS} characters per entry. Consecutive
 * duplicates are collapsed on both load and save. Entry text is otherwise
 * preserved byte-for-byte (only the per-entry cap can clip it), so recall
 * returns exactly what was submitted.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { graphemes } from "./editor.ts";

/** On-disk schema version. A file with any other version loads as empty. */
export const TUI_HISTORY_VERSION = 1;

/** Maximum persisted entries (newest are kept). */
export const TUI_HISTORY_MAX_ENTRIES = 100;

/** Maximum UTF-16 code units per persisted entry. */
export const TUI_HISTORY_MAX_ENTRY_CHARS = 16_384;

/** Environment override for the history file path. */
export const TUI_HISTORY_FILE_ENV = "TWO_BROTHERS_TUI_HISTORY_FILE";

/** The versioned JSON document written by {@link saveHistory}. */
export interface TuiHistoryFile {
  version: typeof TUI_HISTORY_VERSION;
  entries: string[];
}

/**
 * Resolve the history path: the environment override when set, else
 * `~/.two-brothers/tui-history.json` (the same local-state directory used by
 * skills and commands). The `env` parameter keeps this testable without
 * mutating the process environment.
 */
export function defaultTuiHistoryPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[TUI_HISTORY_FILE_ENV];
  if (typeof override === "string" && override.trim() !== "") return override.trim();
  return path.join(os.homedir(), ".two-brothers", "tui-history.json");
}

/** Clip one entry to the character cap without splitting a grapheme. */
export function clipHistoryEntry(text: string): string {
  if (text.length <= TUI_HISTORY_MAX_ENTRY_CHARS) return text;
  let accepted = "";
  for (const unit of graphemes(text)) {
    if (accepted.length + unit.length > TUI_HISTORY_MAX_ENTRY_CHARS) break;
    accepted += unit;
  }
  return accepted;
}

/**
 * Sanitize a history sequence: drop non-strings and blank entries, clip each
 * entry to the cap, collapse consecutive duplicates, and keep the newest
 * {@link TUI_HISTORY_MAX_ENTRIES} entries. Always returns a fresh array.
 */
export function normalizeHistory(entries: readonly unknown[]): string[] {
  const normalized: string[] = [];
  for (const value of entries) {
    if (typeof value !== "string" || value.trim() === "") continue;
    const entry = clipHistoryEntry(value);
    if (normalized.length > 0 && normalized[normalized.length - 1] === entry) continue;
    normalized.push(entry);
  }
  return normalized.slice(-TUI_HISTORY_MAX_ENTRIES);
}

/**
 * Append one prompt with the store's rules: blank entries are ignored, an
 * exact repeat of the newest entry is not duplicated, the per-entry cap is
 * applied, and the oldest entries fall off the cap.
 */
export function appendHistory(entries: readonly string[], entry: string): string[] {
  const current = normalizeHistory(entries);
  if (entry.trim() === "") return current;
  const clipped = clipHistoryEntry(entry);
  if (current.length > 0 && current[current.length - 1] === clipped) return current;
  return [...current, clipped].slice(-TUI_HISTORY_MAX_ENTRIES);
}

/**
 * Read persisted history. Every failure (missing file, directory, bad JSON,
 * wrong version, wrong shape) yields an empty history and no output.
 */
export function loadHistory(filePath: string): string[] {
  if (filePath.trim() === "") return [];
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return [];
    const document = parsed as { version?: unknown; entries?: unknown };
    if (document.version !== TUI_HISTORY_VERSION) return [];
    if (!Array.isArray(document.entries)) return [];
    return normalizeHistory(document.entries);
  } catch {
    return [];
  }
}

/**
 * Persist history atomically and fail-soft. The temp file lives beside the
 * target so the rename stays on one filesystem; the target is replaced only
 * after the full document has been written. Any IO error is swallowed and
 * leaves the previous file (if any) untouched.
 */
export function saveHistory(filePath: string, entries: readonly string[]): void {
  if (filePath.trim() === "") return;
  const document: TuiHistoryFile = {
    version: TUI_HISTORY_VERSION,
    entries: normalizeHistory(entries),
  };
  const payload = `${JSON.stringify(document)}\n`;
  const directory = path.dirname(filePath);
  const tempPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${Date.now().toString(36)}` +
      `.${Math.random().toString(36).slice(2, 8)}.tmp`,
  );
  try {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(tempPath, payload, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tempPath, filePath);
  } catch {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // the temp file may never have been created, or the rename consumed it
    }
  }
}
