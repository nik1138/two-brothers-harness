/**
 * Session metadata: readable titles and workspace links, stored as JSON
 * sidecars. Ports the original prototype's metadata module (removed
 * 2026-11-04; see git history).
 *
 * Each session file `<name>.jsonl` has a sibling `<name>.meta.json` holding
 * `title`, `workspace_id` and timestamps. The session JSONL itself stays a
 * pure protocol-envelope log — metadata never leaks into the shared context.
 *
 * Default titles are derived from the first operator message of the session so
 * existing session files get readable names without rewrites. (`deriveTitle`
 * below mirrors `cli.deriveTitle`, which ports the same Python function.)
 */
import * as fs from "node:fs";
import * as path from "node:path";

import type { SessionLayout } from "./sessionlayout.ts";

const TITLE_MAX = 80;
/** Suffix `deriveForkTitle` appends to the source title. */
const FORK_TITLE_SUFFIX = " (fork)";

/**
 * Longest portable session-name STEM (the part before `.jsonl`). Path
 * components much longer than this are not portable across common filesystems
 * and make for unusable download names, so fork names and export file names
 * are bounded to it with an explicit error/truncation at the call site.
 */
export const SESSION_NAME_MAX_CHARS = 120;

/**
 * Windows reserved device names. Windows refuses to create these as ordinary
 * files even with an extension (`CON`, `con.txt`, `NUL.log`), so a session
 * named `CON` passes POSIX-style validation but fails later as a write error
 * on Windows. Fork names reject them; export file names mangle them.
 */
const WINDOWS_RESERVED_DEVICE_NAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
]);

/**
 * True when `name` is a Windows reserved device name: `CON`, `PRN`, `AUX`,
 * `NUL`, `COM1`..`COM9`, `LPT1`..`LPT9`, case-insensitive and with or without
 * an extension (`CON.txt` is reserved too). Only the part before the FIRST dot
 * is compared, which is exactly Windows' rule.
 */
export function isWindowsReservedDeviceName(name: string): boolean {
  const base = name.split(".")[0]?.trim().toLowerCase() ?? "";
  return WINDOWS_RESERVED_DEVICE_NAMES.has(base);
}

/**
 * Canonical `<sessionsDir>/<stem>.meta.json` sidecar path for a session name
 * (with or without the `.jsonl` suffix). Shared by `SessionMetadataStore` and
 * the fork rollback, which must clean up a partially written sidecar.
 */
export function sessionMetaPath(sessionsDir: string, sessionName: string): string {
  let stem = path.basename(sessionName);
  if (stem.endsWith(".jsonl")) stem = stem.slice(0, -".jsonl".length);
  return path.join(sessionsDir, `${stem}.meta.json`);
}

/** First operator message text, whitespace-collapsed and truncated. */
export function deriveTitle(
  events: Array<Record<string, any>> | null | undefined,
  fallback = "",
): string {
  for (const event of events ?? []) {
    if (event?.from !== "user" || event?.kind !== "message") continue;
    const raw = String(event?.payload?.text ?? "");
    const text = raw.trim();
    if (!text) continue;
    const collapsed = text.split(/\s+/).join(" ");
    return collapsed.length > TITLE_MAX ? collapsed.slice(0, TITLE_MAX) + "…" : collapsed;
  }
  return fallback || "Untitled session";
}

/**
 * Title for a forked session: the source title plus `" (fork)"`, bounded to
 * `TITLE_MAX` characters (the source title is trimmed; an empty one falls back
 * to "Untitled session", like `deriveTitle`). Nested forks keep appending the
 * suffix, which honestly records the lineage depth on its own.
 */
export function deriveForkTitle(sourceTitle: string): string {
  const base =
    (typeof sourceTitle === "string" ? sourceTitle.trim() : "") || "Untitled session";
  if (base.length + FORK_TITLE_SUFFIX.length <= TITLE_MAX) return base + FORK_TITLE_SUFFIX;
  const room = Math.max(0, TITLE_MAX - FORK_TITLE_SUFFIX.length - 1);
  return `${base.slice(0, room)}…${FORK_TITLE_SUFFIX}`;
}

/** Local (non-protocol) lineage link recorded on a forked session's sidecar. */
export interface SessionParentLink {
  /** Source session file name including `.jsonl`. */
  name: string;
  /** Last copied envelope `seq` (0 when an empty session was copied). */
  seq: number;
}

/** Tolerant `parent` sidecar read: anything not `{name, seq}` is ignored. */
function normalizeParent(value: unknown): SessionParentLink | null {
  if (!isRecord(value)) return null;
  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (!name) return null;
  if (typeof value.seq !== "number" || !Number.isInteger(value.seq) || value.seq < 0) return null;
  return { name, seq: value.seq };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Sidecar `*.meta.json` store living next to the session files. */
export class SessionMetadataStore {
  readonly sessionsDir: string;
  private readonly layout: SessionLayout | null;

  constructor(sessionsDir: string, layout?: SessionLayout | null) {
    this.sessionsDir = sessionsDir;
    this.layout = layout ?? null;
  }

  /** Existing metadata path: the resolved layout, else the flat sidecar. */
  private metaPath(sessionName: string): string {
    if (this.layout !== null) {
      const resolved = this.layout.resolve(sessionName);
      if (resolved !== null) return resolved.metaPath;
    }
    return sessionMetaPath(this.sessionsDir, sessionName);
  }

  /** Write target: materialize a new dirs-layout session when needed. */
  private metaPathForWrite(sessionName: string): string {
    if (this.layout !== null && this.layout.resolve(sessionName) === null) {
      return this.layout.materialize(sessionName).metaPath;
    }
    return this.metaPath(sessionName);
  }

  get(sessionName: string): Record<string, unknown> | null {
    const target = this.metaPath(sessionName);
    if (!fs.existsSync(target)) return null;
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(target, "utf-8"));
    } catch {
      return null;
    }
    return isRecord(raw) ? raw : null;
  }

  /** Remove the sidecar if present; `false` when there was none. */
  delete(sessionName: string): boolean {
    const target = this.metaPath(sessionName);
    if (!fs.existsSync(target)) return false;
    fs.unlinkSync(target);
    return true;
  }

  /**
   * Create or update metadata; `undefined` fields keep existing values.
   * `parent` is the additive local lineage link written by a session fork
   * (`src/sessionfork.ts`); an unparseable value is ignored rather than
   * written, so one bad caller can never corrupt the sidecar.
   */
  save(
    sessionName: string,
    options: {
      title?: string | undefined;
      workspaceId?: string | undefined;
      events?: Array<Record<string, unknown>> | undefined;
      parent?: SessionParentLink | undefined;
    } = {},
  ): Record<string, unknown> {
    const now = Math.floor(Date.now() / 1000);
    const meta = this.get(sessionName) ?? {};
    meta.created = typeof meta.created === "number" ? meta.created : now;
    if (options.title !== undefined) {
      const trimmed = options.title.trim();
      meta.title = trimmed || meta.title || "Untitled session";
    } else if (meta.title === undefined) {
      meta.title = deriveTitle(options.events, path.basename(sessionName).replace(/\.jsonl$/, ""));
    }
    if (options.workspaceId !== undefined) meta.workspace_id = options.workspaceId;
    if (options.parent !== undefined) {
      const parent = normalizeParent(options.parent);
      if (parent !== null) meta.parent = parent;
    }
    meta.updated = now;
    const target = this.metaPathForWrite(sessionName);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(meta, null, 2), "utf-8");
    return meta;
  }

  /** Return existing metadata or create it (with a derived title). */
  ensure(
    sessionName: string,
    options: {
      workspaceId?: string | undefined;
      events?: Array<Record<string, unknown>> | undefined;
    } = {},
  ): Record<string, unknown> {
    const meta = this.get(sessionName);
    if (meta !== null) {
      if (options.workspaceId !== undefined && !meta.workspace_id) {
        return this.save(sessionName, { workspaceId: options.workspaceId });
      }
      return meta;
    }
    return this.save(sessionName, { workspaceId: options.workspaceId, events: options.events });
  }

  /** Listing view: file stat plus metadata when present. */
  attach(
    sessionName: string,
    stat: { size: number; mtime: number } | null = null,
    events: Array<Record<string, unknown>> | null = null,
  ): Record<string, unknown> {
    const stem = path.basename(sessionName).replace(/\.jsonl$/, "");
    const item: Record<string, unknown> = { name: path.basename(sessionName) };
    if (stat !== null) {
      item.size = stat.size;
      item.mtime = stat.mtime;
    }
    const meta = this.get(sessionName);
    if (meta === null) {
      // legacy session without a sidecar: derive a title without writing
      item.title = deriveTitle(events, stem);
    } else {
      item.title = typeof meta.title === "string" ? meta.title : stem;
      if (typeof meta.workspace_id === "string" && meta.workspace_id) {
        item.workspace_id = meta.workspace_id;
      }
    }
    return item;
  }
}
