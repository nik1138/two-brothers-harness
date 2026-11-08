/**
 * Session on-disk layout: one compatibility seam for the legacy *flat* store
 * (`<root>/<name>.jsonl` plus sibling sidecars) and the project/session
 * *directory* store (`<root>/<project>/<name>/session.jsonl`).
 *
 * The legacy layout stays the default until a store is migrated. A migrated
 * store carries `.layout.json` (`{"version":1,"layout":"dirs"}`); writers then
 * materialize new sessions as directories while readers always accept both
 * layouts, so an operator can migrate without a flag day and an old checkout
 * can still read a migrated store's sessions.
 *
 * Layouts:
 *
 *   flat                                  dirs
 *   <root>/<name>.jsonl                   <root>/<project>/<stem>/session.jsonl
 *   <root>/<stem>.meta.json               <root>/<project>/<stem>/meta.json
 *   <root>/runtime/<name>.events.jsonl    <root>/<project>/<stem>/events.jsonl
 *
 * `<name>` is the session's public file name (`<stem>.jsonl`), unchanged in
 * both layouts: API routes, run records, fork names and the web UI keep using
 * it. `<project>` is a readable slug plus a short hash of the normalized
 * workspace (or cwd) path; sessions with no known project live under
 * `_global`.
 *
 * Migration copies a flat session into its target directory (immutable source
 * bytes), verifies the copy, then removes the flat file and sidecars. A target
 * that already exists with identical bytes is adopted instead of duplicated; a
 * target with different bytes is a conflict and is never overwritten.
 */
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/** Layout marker file at the sessions root. */
export const SESSION_LAYOUT_FILE = ".layout.json";
/** Marker schema version. */
export const SESSION_LAYOUT_VERSION = 1;
/** Directory for sessions with no known workspace/project path. */
export const GLOBAL_PROJECT_KEY = "_global";

export type SessionLayoutMode = "flat" | "dirs";

/** One session's resolved paths. */
export interface SessionLocation {
  /** Public name, always ending in `.jsonl`. */
  name: string;
  /** Absolute path of the envelope log. */
  sessionPath: string;
  /** Absolute path of the metadata sidecar. */
  metaPath: string;
  /** Absolute path of the runtime-event sidecar. */
  eventsPath: string;
  /** Session-owned directory in the `dirs` layout; `null` when flat. */
  dir: string | null;
  /** Project directory key (`dirs` layout), else `null`. */
  projectKey: string | null;
  /** True for the legacy flat layout. */
  legacy: boolean;
}

/** Result of a migration pass. */
export interface SessionMigrationEntry {
  name: string;
  sourcePath: string;
  targetPath: string;
  status: "migrated" | "already" | "conflict" | "error";
  /** Human-readable detail for conflicts/errors. */
  detail?: string;
}

export interface SessionMigrationResult {
  dryRun: boolean;
  /** Layout after the pass (`dirs` when the marker was written). */
  layout: SessionLayoutMode;
  entries: SessionMigrationEntry[];
}

export interface SessionMigrationOptions {
  dryRun?: boolean;
  /** Resolve a metadata `workspace_id` to its registered path. */
  workspacePathFor?: (workspaceId: string) => string | null;
}

export interface SessionLayoutOptions {
  /**
   * Project path used by `materialize()` when the caller does not pass one.
   * The server sets the workspace path per run; the CLI/TUI leave it null, so
   * new sessions land under `_global` unless a caller names a project.
   */
  defaultProject?: string | null;
}

const JSONL_SUFFIX = ".jsonl";
const META_SUFFIX = ".meta.json";
const RUNTIME_SUFFIX = ".events.jsonl";
const RUNTIME_DIR = "runtime";
const UNDO_DIR = "undo";
/**
 * Direct children that are application data, never project directories:
 * runtime sidecars (flat layout), undo images, and hidden temp/marker files.
 */
const RESERVED_DIRS = new Set([RUNTIME_DIR, UNDO_DIR]);

/** True when `value` is a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** POSIX separators and no trailing slash; Windows paths are case-folded. */
export function normalizeProjectPath(projectPath: string): string {
  const absolute = path.resolve(projectPath).replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

/**
 * Readable project directory key: a slug of the path's last segment plus a
 * short stable hash of the normalized absolute path. Empty/unknown paths map
 * to the reserved `_global` key.
 */
export function projectKeyFor(projectPath?: string | null): string {
  const raw = typeof projectPath === "string" ? projectPath.trim() : "";
  if (!raw) return GLOBAL_PROJECT_KEY;
  const normalized = normalizeProjectPath(raw);
  const segment = normalized.split("/").filter(Boolean).pop() ?? "project";
  const slug =
    segment
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "project";
  const hash = createHash("sha256").update(normalized).digest("hex").slice(0, 8);
  return `${slug}-${hash}`;
}

/**
 * Canonical public session name (`<stem>.jsonl`) for a caller-supplied value.
 * Path separators are flattened; `.`/`..`, empty stems and dot-prefixed names
 * are rejected. Returns `null` instead of throwing so read paths stay tolerant
 * (write paths validate and report their own errors).
 */
export function canonicalSessionName(raw: unknown): string | null {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return null;
  const base = path.basename(text.replace(/\\/g, "/"));
  if (!base || base === "." || base === ".." || base.startsWith(".")) return null;
  const stem = base.endsWith(JSONL_SUFFIX) ? base.slice(0, -JSONL_SUFFIX.length) : base;
  if (!stem || stem === "." || stem === ".." || stem.startsWith(".")) return null;
  return stem + JSONL_SUFFIX;
}

/** Session stem (name without `.jsonl`). */
function stemOf(name: string): string {
  return name.endsWith(JSONL_SUFFIX) ? name.slice(0, -JSONL_SUFFIX.length) : name;
}

/** Best-effort directory listing; a missing/unreadable root yields `[]`. */
function readdir(dir: string, options: { withFileTypes: true }): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, options);
  } catch {
    return [];
  }
}

/** A flat-layout location for `name`. */
function flatLocation(root: string, name: string): SessionLocation {
  const stem = stemOf(name);
  return {
    name,
    sessionPath: path.join(root, name),
    metaPath: path.join(root, `${stem}${META_SUFFIX}`),
    eventsPath: path.join(root, RUNTIME_DIR, `${name}${RUNTIME_SUFFIX}`),
    dir: null,
    projectKey: null,
    legacy: true,
  };
}

/** A directory-layout location for `name` under `projectKey`. */
function dirLocation(root: string, projectKey: string, name: string): SessionLocation {
  const dir = path.join(root, projectKey, stemOf(name));
  return {
    name,
    sessionPath: path.join(dir, "session.jsonl"),
    metaPath: path.join(dir, "meta.json"),
    eventsPath: path.join(dir, "events.jsonl"),
    dir,
    projectKey,
    legacy: false,
  };
}

/** True when a path is an existing regular file. */
function isFile(target: string): boolean {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

/** Make a directory (and its parents) if needed. */
function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/** Atomic, durable-enough marker write (temp + rename, fsync before rename). */
function writeDurable(target: string, data: string): void {
  ensureDir(path.dirname(target));
  const temp = `${target}.tmp-${process.pid}-${randomBytes(3).toString("hex")}`;
  const fd = fs.openSync(temp, "w");
  try {
    fs.writeFileSync(fd, data, "utf-8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, target);
}

/**
 * The session layout of one sessions root. Readers accept both layouts in
 * every mode; `mode()` only decides where *new* sessions are materialized.
 */
export class SessionLayout {
  readonly root: string;
  private readonly defaultProject: string | null;

  constructor(root: string, options: SessionLayoutOptions = {}) {
    this.root = path.resolve(root);
    this.defaultProject =
      typeof options.defaultProject === "string" && options.defaultProject.trim()
        ? options.defaultProject.trim()
        : null;
  }

  /** Current writer layout: the marker value, else `flat` (legacy default). */
  mode(): SessionLayoutMode {
    const marker = path.join(this.root, SESSION_LAYOUT_FILE);
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(marker, "utf-8"));
      if (
        isRecord(raw) &&
        raw.version === SESSION_LAYOUT_VERSION &&
        raw.layout === "dirs"
      ) {
        return "dirs";
      }
    } catch {
      // absent/invalid marker: legacy flat
    }
    return "flat";
  }

  /**
   * Persist the writer layout. `dirs` is the migrated layout; `flat` is only
   * written by an explicit reset (kept for tests/operators).
   */
  setMode(mode: "dirs" | "flat"): void {
    const marker = path.join(this.root, SESSION_LAYOUT_FILE);
    const body = JSON.stringify({ version: SESSION_LAYOUT_VERSION, layout: mode }, null, 2);
    writeDurable(marker, body + "\n");
  }

  /** All sessions in this root, both layouts, newest layout wins on a name clash. */
  list(): SessionLocation[] {
    const found = new Map<string, SessionLocation>();

    for (const entry of readdir(this.root, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(JSONL_SUFFIX)) continue;
      const name = canonicalSessionName(entry.name);
      if (name === null) continue;
      found.set(name, flatLocation(this.root, name));
    }

    for (const location of this.scanDirectorySessions()) {
      found.set(location.name, location);
    }

    return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Session directories that carry `events.jsonl`, including ones whose
   * transcript was never written (a failed run can persist runtime evidence
   * before its first envelope). Used by restart recovery.
   */
  listEventSessions(): SessionLocation[] {
    const found = new Map<string, SessionLocation>();
    for (const project of readdir(this.root, { withFileTypes: true })) {
      if (!project.isDirectory() || project.name.startsWith(".")) continue;
      if (RESERVED_DIRS.has(project.name)) continue;
      const projectDir = path.join(this.root, project.name);
      for (const candidate of readdir(projectDir, { withFileTypes: true })) {
        if (!candidate.isDirectory() || candidate.name.startsWith(".")) continue;
        const name = canonicalSessionName(candidate.name + JSONL_SUFFIX);
        if (name === null) continue;
        const location = dirLocation(this.root, project.name, name);
        if (isFile(location.eventsPath)) found.set(name, location);
      }
    }
    return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Directory-layout sessions with a transcript, one per name. */
  private scanDirectorySessions(): SessionLocation[] {
    const found = new Map<string, SessionLocation>();
    for (const project of readdir(this.root, { withFileTypes: true })) {
      if (!project.isDirectory() || project.name.startsWith(".")) continue;
      if (RESERVED_DIRS.has(project.name)) continue;
      const projectDir = path.join(this.root, project.name);
      for (const candidate of readdir(projectDir, { withFileTypes: true })) {
        if (!candidate.isDirectory() || candidate.name.startsWith(".")) continue;
        const name = canonicalSessionName(candidate.name + JSONL_SUFFIX);
        if (name === null) continue;
        const location = dirLocation(this.root, project.name, name);
        if (!isFile(location.sessionPath)) continue;
        found.set(name, location);
      }
    }
    return [...found.values()];
  }

  /**
   * Resolve an existing session by public name (with or without `.jsonl`).
   * Directory sessions win over a leftover flat file with the same name.
   */
  resolve(rawName: unknown): SessionLocation | null {
    const name = canonicalSessionName(rawName);
    if (name === null) return null;
    const stem = stemOf(name);

    for (const project of readdir(this.root, { withFileTypes: true })) {
      if (!project.isDirectory() || project.name.startsWith(".")) continue;
      if (RESERVED_DIRS.has(project.name)) continue;
      const location = dirLocation(this.root, project.name, name);
      // A materialized session directory counts even before its first
      // envelope: metadata/events may be written while a run is still queued.
      if (fs.existsSync(location.dir as string)) return location;
    }

    const flat = flatLocation(this.root, name);
    if (isFile(flat.sessionPath)) return flat;
    return null;
  }

  /**
   * Resolve an existing session or compute the paths a new one will use under
   * `projectPath` (the configured default when omitted). The directory layer
   * is created for the `dirs` layout; the envelope file is not.
   */
  materialize(rawName: unknown, projectPath?: string | null): SessionLocation {
    const existing = this.resolve(rawName);
    if (existing !== null) return existing;
    const name = canonicalSessionName(rawName);
    if (name === null) throw new Error(`invalid session name: ${String(rawName)}`);
    if (this.mode() === "flat") return flatLocation(this.root, name);
    const project = projectPath ?? this.defaultProject;
    return this.materializeIn(name, projectKeyFor(project));
  }

  /**
   * Materialize a new session under an already-computed project key (used by
   * fork/migration, which preserve the source's project). Falls back to the
   * flat layout while the store is still unmigrated.
   */
  materializeIn(rawName: unknown, projectKey: string): SessionLocation {
    const existing = this.resolve(rawName);
    if (existing !== null) return existing;
    const name = canonicalSessionName(rawName);
    if (name === null) throw new Error(`invalid session name: ${String(rawName)}`);
    if (this.mode() === "flat") return flatLocation(this.root, name);
    const location = dirLocation(this.root, projectKey || GLOBAL_PROJECT_KEY, name);
    ensureDir(location.dir as string);
    return location;
  }

  /** Metadata path for an existing session; `null` when it does not exist. */
  metaPath(rawName: unknown): string | null {
    return this.resolve(rawName)?.metaPath ?? null;
  }

  /** Runtime-event path for an existing session; `null` when it does not exist. */
  eventsPath(rawName: unknown): string | null {
    return this.resolve(rawName)?.eventsPath ?? null;
  }
}

/**
 * Migrate every flat session in `root` into the directory layout. Copy-first:
 * a target is fully written (and verified by the byte comparison inherent in
 * the shared source) before the flat source is removed; conflicts are reported
 * and never overwritten.
 */
export function migrateFlatSessions(
  root: string,
  options: SessionMigrationOptions = {},
): SessionMigrationResult {
  const layout = new SessionLayout(root);
  const dryRun = options.dryRun === true;
  const entries: SessionMigrationEntry[] = [];
  const names = readdir(layout.root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(JSONL_SUFFIX))
    .map((entry) => entry.name)
    .sort();

  for (const rawName of names) {
    const name = canonicalSessionName(rawName);
    if (name === null) continue;
    const stem = stemOf(name);
    const sourcePath = path.join(layout.root, name);
    const metaPath = path.join(layout.root, `${stem}${META_SUFFIX}`);
    const eventsPath = path.join(layout.root, RUNTIME_DIR, `${name}${RUNTIME_SUFFIX}`);

    let meta: Record<string, unknown> | null = null;
    let metaRaw: string | null = null;
    try {
      metaRaw = fs.readFileSync(metaPath, "utf-8");
      const parsed: unknown = JSON.parse(metaRaw);
      if (isRecord(parsed)) meta = parsed;
    } catch {
      // no/unreadable metadata: preserve raw bytes when readable, else migrate
      // the session alone
    }
    const workspaceId =
      meta !== null && typeof meta.workspace_id === "string" ? meta.workspace_id : null;
    const workspacePath =
      workspaceId !== null && options.workspacePathFor
        ? options.workspacePathFor(workspaceId)
        : null;
    const target = dirLocation(layout.root, projectKeyFor(workspacePath), name);

    if (fs.existsSync(target.sessionPath)) {
      try {
        const sourceBytes = fs.readFileSync(sourcePath);
        const targetBytes = fs.readFileSync(target.sessionPath);
        if (!sourceBytes.equals(targetBytes)) {
          entries.push({
            name,
            sourcePath,
            targetPath: target.sessionPath,
            status: "conflict",
            detail: "target session.jsonl already exists with different bytes",
          });
          continue;
        }
        if (!dryRun) {
          // Adopt an interrupted previous migration: fill missing sidecars,
          // then remove the flat source files.
          if (metaRaw !== null && !fs.existsSync(target.metaPath)) {
            fs.writeFileSync(target.metaPath, metaRaw, "utf-8");
          }
          if (fs.existsSync(eventsPath) && !fs.existsSync(target.eventsPath)) {
            fs.copyFileSync(eventsPath, target.eventsPath);
          }
          fs.unlinkSync(sourcePath);
          if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
          if (fs.existsSync(eventsPath)) fs.unlinkSync(eventsPath);
        }
        entries.push({
          name,
          sourcePath,
          targetPath: target.sessionPath,
          status: "already",
        });
      } catch (exc) {
        entries.push({
          name,
          sourcePath,
          targetPath: target.sessionPath,
          status: "error",
          detail: exc instanceof Error ? exc.message : String(exc),
        });
      }
      continue;
    }

    // An empty session directory left by an interrupted previous attempt does
    // not block the migration; a non-empty one does (never delete content we
    // did not create). A dry run must not touch it.
    if (!dryRun && fs.existsSync(target.dir as string)) {
      try {
        fs.rmdirSync(target.dir as string);
      } catch (exc) {
        entries.push({
          name,
          sourcePath,
          targetPath: target.sessionPath,
          status: "conflict",
          detail: `target directory is not empty: ${exc instanceof Error ? exc.message : String(exc)}`,
        });
        continue;
      }
    }

    if (dryRun) {
      entries.push({
        name,
        sourcePath,
        targetPath: target.sessionPath,
        status: "migrated",
      });
      continue;
    }

    const tempDir = path.join(
      path.dirname(target.dir as string),
      `.tmp-${stem}-${process.pid}-${randomBytes(3).toString("hex")}`,
    );
    try {
      ensureDir(tempDir);
      const sessionBytes = fs.readFileSync(sourcePath);
      fs.writeFileSync(path.join(tempDir, "session.jsonl"), sessionBytes);
      if (metaRaw !== null) fs.writeFileSync(path.join(tempDir, "meta.json"), metaRaw);
      if (fs.existsSync(eventsPath)) {
        fs.copyFileSync(eventsPath, path.join(tempDir, "events.jsonl"));
      }
      // Parent exists (ensureDir above); rename publishes the whole directory.
      ensureDir(path.dirname(target.dir as string));
      fs.renameSync(tempDir, target.dir as string);
      fs.unlinkSync(sourcePath);
      if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
      if (fs.existsSync(eventsPath)) fs.unlinkSync(eventsPath);
      entries.push({
        name,
        sourcePath,
        targetPath: target.sessionPath,
        status: "migrated",
      });
    } catch (exc) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // best effort
      }
      entries.push({
        name,
        sourcePath,
        targetPath: target.sessionPath,
        status: "error",
        detail: exc instanceof Error ? exc.message : String(exc),
      });
    }
  }

  const hasFailure = entries.some((entry) => entry.status === "conflict" || entry.status === "error");
  if (!dryRun && !hasFailure) layout.setMode("dirs");
  return { dryRun, layout: layout.mode(), entries };
}
