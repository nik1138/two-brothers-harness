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

const TITLE_MAX = 80;

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Sidecar `*.meta.json` store living next to the session files. */
export class SessionMetadataStore {
  readonly sessionsDir: string;

  constructor(sessionsDir: string) {
    this.sessionsDir = sessionsDir;
  }

  private metaPath(sessionName: string): string {
    let stem = path.basename(sessionName);
    if (stem.endsWith(".jsonl")) stem = stem.slice(0, -".jsonl".length);
    return path.join(this.sessionsDir, `${stem}.meta.json`);
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

  /** Create or update metadata; `undefined` fields keep existing values. */
  save(
    sessionName: string,
    options: {
      title?: string | undefined;
      workspaceId?: string | undefined;
      events?: Array<Record<string, unknown>> | undefined;
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
    meta.updated = now;
    fs.mkdirSync(this.sessionsDir, { recursive: true });
    fs.writeFileSync(this.metaPath(sessionName), JSON.stringify(meta, null, 2), "utf-8");
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
