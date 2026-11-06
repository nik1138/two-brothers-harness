/**
 * Session search and export helpers.
 *
 * `searchSessions` matches a query against a session title and the string leaf
 * values of each envelope payload (never JSON keys or envelope metadata) and
 * returns bounded single-line snippets. `sessionToMarkdown` /
 * `sessionToJsonString` render one session document for download, and
 * `loadSessionDocs` reads the `<sessionsDir>/*.jsonl` corpus newest-first with
 * metadata titles attached.
 *
 * The search/export functions are pure and never throw on malformed input;
 * only `loadSessionDocs` touches the filesystem and it fails soft (missing
 * directory, corrupt file). Consumers: the HTTP server and the CLI.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { deriveTitle, SessionMetadataStore } from "./metadata.ts";
import type { Message } from "./protocol.ts";
import { SessionStore } from "./session.ts";

/** Shortest query (after trimming) that is actually searched. */
export const SEARCH_MIN_QUERY_CHARS = 2;
/** Default number of hits returned by `searchSessions`. */
export const SEARCH_DEFAULT_LIMIT = 20;
/** Hard ceiling on the number of hits returned by `searchSessions`. */
export const SEARCH_MAX_LIMIT = 100;
/** Maximum length of a single-line hit snippet, ellipses included. */
export const SEARCH_SNIPPET_CHARS = 160;
/** Default cap on hits collected from one session. */
export const SEARCH_MAX_PER_SESSION = 3;
/** Default cap on session files read by `loadSessionDocs`. */
export const SEARCH_MAX_SESSIONS = 200;
/** Default cap on envelopes loaded per session by `loadSessionDocs`. */
export const SEARCH_MAX_EVENTS_PER_SESSION = 2000;
/** Chars of leaf text scanned per envelope (a bounded search window). */
export const SEARCH_MAX_TEXT_PER_EVENT = 100_000;

/** Which part of the document matched. */
export type SessionHitField = "title" | "message" | "decision";

/** One search hit: a title, or one envelope's payload text. */
export interface SessionSearchHit {
  session: string;
  title: string;
  field: SessionHitField;
  /** Envelope `seq`; `null` for a title hit. */
  seq: number | null;
  /** Envelope `from`; `null` for a title hit. */
  role: string | null;
  /** Envelope `kind`; `null` for a title hit. */
  kind: string | null;
  snippet: string;
  /** Envelope `ts` when present. */
  ts: string | null;
}

/** Result envelope of a session search. */
export interface SessionSearchResult {
  /** Trimmed query. */
  query: string;
  scanned_sessions: number;
  /** True when a per-session cap or the overall limit clipped real matches. */
  truncated: boolean;
  hits: SessionSearchHit[];
}

/** One loaded session document, as consumed by search/export. */
export interface SessionSearchDoc {
  /** File name including `.jsonl`. */
  name: string;
  title: string;
  events: Message[];
  workspace_id?: string | null;
  /** Unix seconds, optional. */
  updated?: number | null;
}

/** Bounds for `loadSessionDocs`. */
export interface LoadSessionDocsOptions {
  maxSessions?: number;
  maxEventsPerSession?: number;
}

/** Result of `loadSessionDocs`. */
export interface LoadedSessionDocs {
  docs: SessionSearchDoc[];
  /** Files that could not be read or parsed. */
  skipped: number;
  /** True when files were dropped by the session cap. */
  truncated: boolean;
}

/** Options for the export renderers. */
export interface SessionExportOptions {
  /** Injected export timestamp for deterministic tests. */
  exportedAt?: string;
}

/** Depth bound for walking a payload's nested values. */
const MAX_PAYLOAD_DEPTH = 6;
/** Per-envelope payload rendering cap in exported documents. */
const EXPORT_MAX_PAYLOAD_CHARS = 20_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Collapse runs of whitespace into single spaces and trim the ends. */
function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Clamp a caller-supplied count: finite integers only, within [min, max]. */
function clampCount(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/** Clamp a caller-supplied cap: finite integers only, never negative. */
function clampCap(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

/**
 * Collect the string leaf values of one envelope payload, recursively.
 *
 * Bounded twice so a hostile or huge envelope stays cheap: the walk stops at
 * `MAX_PAYLOAD_DEPTH` levels and at `SEARCH_MAX_TEXT_PER_EVENT` characters of
 * collected leaf text. Keys are never collected — only values match.
 */
function collectTextLeaves(payload: unknown): string[] {
  const leaves: string[] = [];
  let budget = SEARCH_MAX_TEXT_PER_EVENT;
  const walk = (value: unknown, depth: number): void => {
    if (budget <= 0) return;
    if (typeof value === "string") {
      const leaf = value.slice(0, budget);
      if (leaf) leaves.push(leaf);
      budget -= leaf.length;
      return;
    }
    if (depth >= MAX_PAYLOAD_DEPTH) return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    if (isRecord(value)) {
      for (const item of Object.values(value)) walk(item, depth + 1);
    }
  };
  walk(payload, 0);
  return leaves;
}

/**
 * Clip one single-line window around a match.
 *
 * The window is centred on the match, at most `maxChars` characters including
 * the leading/trailing `…` markers. A match longer than the window contributes
 * its own middle slice so the result is never empty.
 */
function clipSnippet(line: string, index: number, matchLength: number, maxChars: number): string {
  if (line.length <= maxChars) return line;
  const room = Math.max(1, maxChars - 2); // reserve both ellipses
  let start: number;
  if (matchLength >= room) {
    start = Math.min(Math.max(0, index), line.length - room);
  } else {
    const before = Math.floor((room - matchLength) / 2);
    start = Math.max(0, Math.min(index - before, line.length - room));
  }
  const end = start + room;
  const prefix = start > 0 ? "…" : "";
  const suffix = end < line.length ? "…" : "";
  return prefix + line.slice(start, end) + suffix;
}

interface TextMatch {
  snippet: string;
}

/**
 * Find `needle` in one text leaf, case-insensitively unless requested
 * otherwise. Both sides are whitespace-collapsed, so a multi-line payload
 * still matches a single-line query and the snippet is always one line.
 */
function matchInText(text: string, needle: string, caseSensitive: boolean): TextMatch | null {
  const line = collapseWhitespace(text);
  if (!line || !needle) return null;
  const haystack = caseSensitive ? line : line.toLowerCase();
  const target = caseSensitive ? needle : needle.toLowerCase();
  const index = haystack.indexOf(target);
  if (index === -1) return null;
  return { snippet: clipSnippet(line, index, target.length, SEARCH_SNIPPET_CHARS) };
}

interface EventMatch {
  field: SessionHitField;
  seq: number | null;
  role: string | null;
  kind: string | null;
  ts: string | null;
  snippet: string;
}

/**
 * First matching string leaf of one envelope payload, or `null`. One envelope
 * yields at most one hit: repeated occurrences in the same payload are the same
 * envelope match, so they do not produce duplicate hits.
 */
function matchEvent(event: unknown, needle: string, caseSensitive: boolean): EventMatch | null {
  if (!isRecord(event)) return null;
  const leaves = collectTextLeaves(event.payload);
  for (const leaf of leaves) {
    const match = matchInText(leaf, needle, caseSensitive);
    if (!match) continue;
    return {
      field: event.kind === "decision" ? "decision" : "message",
      seq: typeof event.seq === "number" && Number.isFinite(event.seq) ? event.seq : null,
      role: typeof event.from === "string" ? event.from : null,
      kind: typeof event.kind === "string" ? event.kind : null,
      ts: typeof event.ts === "string" ? event.ts : null,
      snippet: match.snippet,
    };
  }
  return null;
}

/**
 * Search already-loaded session documents.
 *
 * Docs are searched in the given order (the caller usually gets newest-first
 * from `loadSessionDocs`); a doc contributes its title hit first, then envelope
 * hits in envelope order. Each doc is capped at `perSession` hits and the
 * whole result at `limit`; caps that actually drop a match set `truncated`.
 * Never throws — malformed docs, envelopes and payloads are tolerated.
 */
export function searchSessions(
  docs: SessionSearchDoc[],
  query: string,
  options: { limit?: number; perSession?: number; caseSensitive?: boolean } = {},
): SessionSearchResult {
  const trimmedQuery = typeof query === "string" ? query.trim() : "";
  const list: unknown[] = Array.isArray(docs) ? (docs as unknown[]) : [];
  const needle = collapseWhitespace(trimmedQuery);
  if (needle.length < SEARCH_MIN_QUERY_CHARS) {
    return { query: trimmedQuery, scanned_sessions: list.length, truncated: false, hits: [] };
  }
  const caseSensitive = options.caseSensitive === true;
  const limit = clampCount(options.limit, SEARCH_DEFAULT_LIMIT, 1, SEARCH_MAX_LIMIT);
  const perSession = clampCount(
    options.perSession,
    SEARCH_MAX_PER_SESSION,
    1,
    Number.MAX_SAFE_INTEGER,
  );

  const hits: SessionSearchHit[] = [];
  let truncated = false;

  for (const rawDoc of list) {
    if (!isRecord(rawDoc)) continue;
    const session = typeof rawDoc.name === "string" ? rawDoc.name : "";
    const title = typeof rawDoc.title === "string" ? rawDoc.title : "";
    const events: unknown[] = Array.isArray(rawDoc.events) ? rawDoc.events : [];
    let sessionHits = 0;

    const titleMatch = title ? matchInText(title, needle, caseSensitive) : null;
    if (titleMatch) {
      if (hits.length >= limit) {
        truncated = true;
        break;
      }
      hits.push({
        session,
        title,
        field: "title",
        seq: null,
        role: null,
        kind: null,
        snippet: titleMatch.snippet,
        ts: null,
      });
      sessionHits += 1;
    }

    for (const event of events) {
      if (sessionHits >= perSession) {
        // The per-session cap already dropped this session's remaining
        // envelope text; only a real further match makes it truncation.
        if (matchEvent(event, needle, caseSensitive)) {
          truncated = true;
          break;
        }
        continue;
      }
      const match = matchEvent(event, needle, caseSensitive);
      if (!match) continue;
      if (hits.length >= limit) {
        truncated = true;
        break;
      }
      hits.push({
        session,
        title,
        field: match.field,
        seq: match.seq,
        role: match.role,
        kind: match.kind,
        snippet: match.snippet,
        ts: match.ts,
      });
      sessionHits += 1;
    }
  }

  return { query: trimmedQuery, scanned_sessions: list.length, truncated, hits };
}

/**
 * Load `<sessionsDir>/*.jsonl` newest-first, attach metadata titles and cap
 * the result. Corrupt or unreadable files are skipped, a missing directory
 * yields an empty result, and the function never throws.
 */
export function loadSessionDocs(
  sessionsDir: string,
  options: LoadSessionDocsOptions = {},
): LoadedSessionDocs {
  const maxSessions = clampCap(options.maxSessions, SEARCH_MAX_SESSIONS);
  const maxEvents = clampCap(options.maxEventsPerSession, SEARCH_MAX_EVENTS_PER_SESSION);
  const dir = typeof sessionsDir === "string" ? sessionsDir : "";

  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
  } catch {
    return { docs: [], skipped: 0, truncated: false };
  }

  let skipped = 0;
  const entries: Array<{ name: string; mtimeMs: number }> = [];
  for (const name of names) {
    try {
      const stat = fs.statSync(path.join(dir, name));
      if (!stat.isFile()) {
        skipped += 1;
        continue;
      }
      entries.push({ name, mtimeMs: stat.mtimeMs });
    } catch {
      skipped += 1;
    }
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));
  const truncated = entries.length > maxSessions;

  const metadata = new SessionMetadataStore(dir);
  const docs: SessionSearchDoc[] = [];
  for (const entry of entries.slice(0, maxSessions)) {
    let events: Message[];
    try {
      events = new SessionStore(path.join(dir, entry.name)).load();
    } catch {
      skipped += 1;
      continue;
    }
    if (events.length > maxEvents) events = events.slice(0, maxEvents);

    let meta: Record<string, unknown> | null = null;
    try {
      meta = metadata.get(entry.name);
    } catch {
      meta = null;
    }
    const metaTitle = typeof meta?.title === "string" ? meta.title.trim() : "";
    const stem = entry.name.replace(/\.jsonl$/, "");
    const title =
      metaTitle ||
      deriveTitle(events as unknown as Array<Record<string, any>>, stem);
    const workspaceId =
      typeof meta?.workspace_id === "string" && meta.workspace_id ? meta.workspace_id : null;
    const updated =
      typeof meta?.updated === "number" && Number.isFinite(meta.updated)
        ? meta.updated
        : Math.floor(entry.mtimeMs / 1000);

    docs.push({ name: entry.name, title, events, workspace_id: workspaceId, updated });
  }
  return { docs, skipped, truncated };
}

/** Render one payload value as display text (arrays/scalars inline, objects JSON). */
function scalarText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

/** `message` payload text when one is present. */
function messageText(payload: unknown): string | null {
  if (typeof payload === "string") return payload;
  if (isRecord(payload) && typeof payload.text === "string") return payload.text;
  return null;
}

/**
 * Bullet list of a structured payload's fields in key order; arrays join with
 * `", "`, nested objects render as JSON. `null`/`undefined` fields are skipped.
 */
function renderStructuredPayload(payload: unknown): string {
  if (typeof payload === "string" && payload) return payload;
  if (!isRecord(payload)) return "_(no payload fields)_";
  const lines: string[] = [];
  for (const [key, value] of Object.entries(payload)) {
    if (value === null || value === undefined) continue;
    const rendered = Array.isArray(value)
      ? value.map((item) => scalarText(item)).join(", ")
      : scalarText(value);
    lines.push(`- ${key}: ${rendered}`);
  }
  return lines.length > 0 ? lines.join("\n") : "_(no payload fields)_";
}

/** Bound one envelope's rendered payload with an explicit truncation marker. */
function boundExportedPayload(text: string): string {
  if (text.length <= EXPORT_MAX_PAYLOAD_CHARS) return text;
  const omitted = text.length - EXPORT_MAX_PAYLOAD_CHARS;
  const marker = `\n\n_[payload truncated: ${omitted} characters omitted]_`;
  const head = Math.max(0, EXPORT_MAX_PAYLOAD_CHARS - marker.length);
  return text.slice(0, head) + marker;
}

/** Readable text for one envelope payload: verbatim for `message`, bullets otherwise. */
function renderPayload(event: unknown): string {
  if (!isRecord(event)) return "_(no payload fields)_";
  if (event.kind === "message") {
    const text = messageText(event.payload);
    if (text !== null) return boundExportedPayload(text);
  }
  return boundExportedPayload(renderStructuredPayload(event.payload));
}

/** Normalise a rendered export to exactly one trailing newline. */
function withSingleTrailingNewline(body: string): string {
  return body.replace(/\n+$/, "") + "\n";
}

/**
 * Render one session as a stable Markdown export.
 *
 * The header carries session name, workspace, updated/exported timestamps and
 * the envelope count; every envelope becomes a `## <seq>. <from> → <to> · <kind>`
 * section with an italic `ts` line and a readable payload. Each payload is
 * bounded to 20_000 characters with an explicit truncation marker, no HTML is
 * emitted, and the document ends with exactly one newline.
 */
export function sessionToMarkdown(
  doc: SessionSearchDoc,
  options: SessionExportOptions = {},
): string {
  const record = isRecord(doc) ? (doc as Record<string, unknown>) : {};
  const rawTitle = typeof record.title === "string" ? record.title.trim() : "";
  const title = rawTitle || "Untitled session";
  const name = typeof record.name === "string" ? record.name : "";
  const workspace =
    typeof record.workspace_id === "string" && record.workspace_id ? record.workspace_id : "none";
  const updated =
    typeof record.updated === "number" && Number.isFinite(record.updated)
      ? new Date(record.updated * 1000).toISOString()
      : "none";
  const exportedAt =
    typeof options.exportedAt === "string" && options.exportedAt
      ? options.exportedAt
      : new Date().toISOString();
  const events: unknown[] = Array.isArray(record.events) ? record.events : [];

  const lines: string[] = [
    `# ${title}`,
    `- session: ${name}`,
    `- workspace: ${workspace}`,
    `- updated: ${updated}`,
    `- exported: ${exportedAt}`,
    `- envelopes: ${events.length}`,
  ];

  events.forEach((event, index) => {
    const envelope = isRecord(event) ? event : {};
    const seq =
      typeof envelope.seq === "number" && Number.isFinite(envelope.seq)
        ? envelope.seq
        : index + 1;
    const from = typeof envelope.from === "string" ? envelope.from : "unknown";
    const to = typeof envelope.to === "string" ? envelope.to : "unknown";
    const kind = typeof envelope.kind === "string" ? envelope.kind : "unknown";
    lines.push("", `## ${seq}. ${from} → ${to} · ${kind}`);
    if (typeof envelope.ts === "string" && envelope.ts) lines.push(`_${envelope.ts}_`);
    for (const payloadLine of renderPayload(event).split("\n")) lines.push(payloadLine);
  });

  return withSingleTrailingNewline(lines.join("\n"));
}

/**
 * Render one session as pretty JSON (2-space indent) with the export metadata
 * fields; envelopes are emitted verbatim. Ends with exactly one newline.
 */
export function sessionToJsonString(
  doc: SessionSearchDoc,
  options: SessionExportOptions = {},
): string {
  const record = isRecord(doc) ? (doc as Record<string, unknown>) : {};
  const exportedAt =
    typeof options.exportedAt === "string" && options.exportedAt
      ? options.exportedAt
      : new Date().toISOString();
  const payload = {
    name: typeof record.name === "string" ? record.name : "",
    title: typeof record.title === "string" ? record.title : "",
    workspace_id:
      typeof record.workspace_id === "string" && record.workspace_id ? record.workspace_id : null,
    updated:
      typeof record.updated === "number" && Number.isFinite(record.updated)
        ? record.updated
        : null,
    exported_at: exportedAt,
    envelopes: Array.isArray(record.events) ? record.events : [],
  };
  return JSON.stringify(payload, null, 2) + "\n";
}

/**
 * Safe download basename for one session: `foo.jsonl` → `foo.md` / `foo.json`.
 * Path components, traversal dots and characters illegal in file names are
 * stripped; an unusable name falls back to `session`.
 */
export function exportSessionFileName(name: string, format: "markdown" | "json"): string {
  const raw = typeof name === "string" ? name : "";
  let base = raw.replace(/\\/g, "/").split("/").pop() ?? "";
  base = base.replace(/\.jsonl$/i, "");
  base = base.replace(/\.(md|json)$/i, "");
  base = base
    .replace(/[<>:"|?*\u0000-\u001f]/g, "-")
    .replace(/^\.+/, "")
    .replace(/[. ]+$/, "")
    .trim();
  if (!base) base = "session";
  return base + (format === "markdown" ? ".md" : ".json");
}
