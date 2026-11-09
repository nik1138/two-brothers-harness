/**
 * Session on-disk layout: one compatibility seam for the legacy *flat* store
 * (`<root>/<name>.jsonl` plus sibling sidecars) and the project/session
 * *directory* store (`<root>/<project>/<name>/session.jsonl`).
 *
 * The legacy layout stays the default until a store is migrated. A migrated
 * store carries `.layout.json` (`{"version":1,"layout":"dirs"}`); writers then
 * materialize new sessions as directories while this release's readers always
 * accept both layouts, so an operator can migrate without a flag day. An older
 * release only knows the flat layout, so a migrated store is not
 * backward-compatible with older binaries; keep a backup before downgrading.
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

/** Marker file describing the process currently writing this store. */
export const SESSION_LOCK_FILE = ".writer.json";

/**
 * A malformed/empty writer lock is treated as stale only after this grace, so
 * a concurrent writer that has created the file but not finished writing its
 * record is never mistaken for a crashed one.
 */
export const SESSION_LOCK_MALFORMED_GRACE_MS = 5_000;

export type SessionLayoutMode = "flat" | "dirs";

/** The writer lock record stored at `<root>/.writer.json`. */
export interface SessionWriterLock {
  owner: string;
  pid: number;
  created: string;
  /**
   * Random per-acquisition token. A release closure only removes the exact
   * lock it created (older records may omit it). Additive and optional.
   */
  nonce?: string;
}

/** Raised when a writer (serve/TUI) already owns the store. */
export class SessionLayoutLockedError extends Error {
  readonly holder: SessionWriterLock | null;

  constructor(holder: SessionWriterLock | null) {
    super(
      holder === null
        ? "the sessions directory is locked by an unknown writer"
        : `the sessions directory is in use by ${holder.owner} (pid ${holder.pid})`,
    );
    this.name = "SessionLayoutLockedError";
    this.holder = holder;
  }
}

/** True when `pid` names a live process (EPERM counts as alive). */
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (exc) {
    return (exc as NodeJS.ErrnoException).code === "EPERM";
  }
}

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
  /** Layout after the pass; a clean dry run reports the intended `dirs`. */
  layout: SessionLayoutMode;
  entries: SessionMigrationEntry[];
}

export interface SessionMigrationOptions {
  dryRun?: boolean;
  /** Proceed even when a live writer owns the store (dangerous; explicit). */
  force?: boolean;
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
  /**
   * Test seam for the writer-lock record write (production leaves it unset).
   * A throw here exercises the cleanup path that removes a just-created lock
   * after a write/fsync failure.
   */
  lockWriteHook?: (fd: number, data: string) => void;
  /**
   * Test seam invoked after a stale lock's identity snapshot is taken and
   * before its identity-checked unlink (production leaves it unset). A test
   * can replace the path here to prove a concurrent writer's fresh lock is
   * never removed by mistake.
   */
  lockReclaimHook?: (file: string, stats: fs.Stats) => void;
}

const JSONL_SUFFIX = ".jsonl";
const META_SUFFIX = ".meta.json";
const RUNTIME_SUFFIX = ".events.jsonl";
const RUNTIME_DIR = "runtime";
const UNDO_DIR = "undo";
/**
 * Direct children that are application data, never project directories:
 * runtime sidecars (flat layout), undo images, spill files, and hidden
 * temp/marker files.
 */
const RESERVED_DIRS = new Set([RUNTIME_DIR, UNDO_DIR, "spill"]);

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

/** Atomic, durable-enough file write (fsync, then rename where a target exists). */
function writeDurable(target: string, data: string | Buffer): void {
  ensureDir(path.dirname(target));
  const temp = `${target}.tmp-${process.pid}-${randomBytes(3).toString("hex")}`;
  const fd = fs.openSync(temp, "w");
  try {
    fs.writeFileSync(fd, data);
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
  private readonly lockWriteHook: ((fd: number, data: string) => void) | null;
  private readonly lockReclaimHook: ((file: string, stats: fs.Stats) => void) | null;

  constructor(root: string, options: SessionLayoutOptions = {}) {
    this.root = path.resolve(root);
    this.defaultProject =
      typeof options.defaultProject === "string" && options.defaultProject.trim()
        ? options.defaultProject.trim()
        : null;
    this.lockWriteHook = options.lockWriteHook ?? null;
    this.lockReclaimHook = options.lockReclaimHook ?? null;
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

  /** All sessions in this root, both layouts; a directory session wins a clash. */
  list(): SessionLocation[] {
    const found = new Map<string, SessionLocation>();
    for (const location of this.scanDirectorySessions()) {
      if (!found.has(location.name)) found.set(location.name, location);
    }
    for (const entry of readdir(this.root, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(JSONL_SUFFIX)) continue;
      const name = canonicalSessionName(entry.name);
      if (name === null || found.has(name)) continue;
      found.set(name, flatLocation(this.root, name));
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
    for (const project of this.projectDirectories()) {
      const projectDir = path.join(this.root, project);
      for (const candidate of readdir(projectDir, { withFileTypes: true })) {
        if (!candidate.isDirectory() || candidate.name.startsWith(".")) continue;
        const name = canonicalSessionName(candidate.name + JSONL_SUFFIX);
        if (name === null || found.has(name)) continue;
        const location = dirLocation(this.root, project, name);
        if (isFile(location.eventsPath)) found.set(name, location);
      }
    }
    return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Sorted directory-layout sessions with a transcript, one per name. */
  private scanDirectorySessions(): SessionLocation[] {
    const found = new Map<string, SessionLocation>();
    for (const project of this.projectDirectories()) {
      const projectDir = path.join(this.root, project);
      for (const candidate of readdir(projectDir, { withFileTypes: true })) {
        if (!candidate.isDirectory() || candidate.name.startsWith(".")) continue;
        const name = canonicalSessionName(candidate.name + JSONL_SUFFIX);
        if (name === null || found.has(name)) continue;
        const location = dirLocation(this.root, project, name);
        if (!isFile(location.sessionPath)) continue;
        found.set(name, location);
      }
    }
    return [...found.values()];
  }

  /** Sorted project directory names (reserved/hidden excluded). */
  private projectDirectories(): string[] {
    return readdir(this.root, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          !entry.name.startsWith(".") &&
          !RESERVED_DIRS.has(entry.name),
      )
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  }

  /** A session directory is real when the transcript or either sidecar exists. */
  private hasArtifact(location: SessionLocation): boolean {
    return (
      isFile(location.sessionPath) ||
      isFile(location.metaPath) ||
      isFile(location.eventsPath)
    );
  }

  /**
   * Resolve an existing session by public name (with or without `.jsonl`).
   * Directory sessions win over a leftover flat file with the same name. An
   * empty directory is not a session: read paths must not create or accept
   * ghost artifacts (a 404 GET must leave the store untouched).
   */
  resolve(rawName: unknown): SessionLocation | null {
    const name = canonicalSessionName(rawName);
    if (name === null) return null;
    for (const project of this.projectDirectories()) {
      const location = dirLocation(this.root, project, name);
      if (this.hasArtifact(location)) return location;
    }
    const flat = flatLocation(this.root, name);
    if (isFile(flat.sessionPath)) return flat;
    return null;
  }

  /**
   * Like `resolve`, but also accepts a materialized session directory before
   * its first artifact (metadata/events may be written while a run is queued).
   * Write-side callers only; reads use `resolve`.
   */
  resolveForWrite(rawName: unknown): SessionLocation | null {
    const existing = this.resolve(rawName);
    if (existing !== null) return existing;
    const name = canonicalSessionName(rawName);
    if (name === null) return null;
    for (const project of this.projectDirectories()) {
      const location = dirLocation(this.root, project, name);
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
    const existing = this.resolveForWrite(rawName);
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
   * flat layout while the store is still unmigrated. The key must be a single
   * safe path segment even though callers derive it from `projectKeyFor`.
   */
  materializeIn(rawName: unknown, projectKey: string): SessionLocation {
    const existing = this.resolveForWrite(rawName);
    if (existing !== null) return existing;
    const name = canonicalSessionName(rawName);
    if (name === null) throw new Error(`invalid session name: ${String(rawName)}`);
    if (this.mode() === "flat") return flatLocation(this.root, name);
    const key = projectKey.trim();
    if (!/^[A-Za-z0-9._-]+$/.test(key) || key === "." || key === "..") {
      throw new Error(`invalid project key: ${projectKey}`);
    }
    const location = dirLocation(this.root, key, name);
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

  /** Public session name for an arbitrary file path (directory or flat). */
  nameForPath(filePath: string): string {
    const resolved = path.resolve(filePath);
    const relative = path.relative(this.root, resolved);
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
      const parts = relative.split(/[\\/]/).filter(Boolean);
      if (parts.length === 3 && parts[2] === "session.jsonl") {
        return `${parts[1]}.jsonl`;
      }
    }
    return path.basename(resolved);
  }

  /**
   * The current writer lock, or `null` when absent/malformed. A stale lock
   * whose pid is dead is treated as absent by `acquireWriterLock` but still
   * reported here for diagnostics.
   */
  writerLock(): SessionWriterLock | null {
    return this.writerLockSnapshot().holder;
  }

  /**
   * Read the lock record and the identity (`dev`/`ino`/size/mtime) of the
   * exact file the record came from. Reclaim paths compare a later `lstat`
   * against this snapshot before unlinking, so a lock another writer replaced
   * in the meantime is never deleted. A vanished lock is `{null, null}`.
   */
  private writerLockSnapshot(): { holder: SessionWriterLock | null; stats: fs.Stats | null } {
    const file = path.join(this.root, SESSION_LOCK_FILE);
    let fd: number;
    try {
      fd = fs.openSync(file, "r");
    } catch {
      return { holder: null, stats: null };
    }
    let holder: SessionWriterLock | null = null;
    let stats: fs.Stats | null = null;
    try {
      stats = fs.fstatSync(fd);
      const raw: unknown = JSON.parse(fs.readFileSync(fd, "utf-8"));
      if (isRecord(raw)) {
        const owner = typeof raw.owner === "string" ? raw.owner.trim() : "";
        const pid = typeof raw.pid === "number" ? raw.pid : Number.NaN;
        const created = typeof raw.created === "string" ? raw.created : "";
        const nonce = typeof raw.nonce === "string" ? raw.nonce : undefined;
        if (owner && Number.isInteger(pid) && pid > 0 && created) {
          holder = { owner, pid, created, ...(nonce !== undefined ? { nonce } : {}) };
        }
      }
    } catch {
      // unreadable/malformed/partial: the identity snapshot still lets a
      // stale reclaim prove it is removing the file it inspected
    } finally {
      try {
        fs.closeSync(fd);
      } catch {
        // already closed
      }
    }
    return { holder, stats };
  }

  /**
   * Delete `file` only when it still is the exact file described by
   * `expected`. The pre-unlink `lstat` narrows the reclaim race to the
   * lstat/unlink window; a replaced lock (new inode, size or mtime) survives
   * and the caller retries, which then sees the new owner. Tests can widen the
   * race with {@link SessionLayoutOptions.lockReclaimHook}.
   */
  private unlinkIfUnchanged(file: string, expected: fs.Stats): boolean {
    let current: fs.Stats;
    try {
      current = fs.lstatSync(file);
    } catch (exc) {
      return (exc as NodeJS.ErrnoException).code === "ENOENT";
    }
    if (
      current.dev !== expected.dev ||
      current.ino !== expected.ino ||
      current.size !== expected.size ||
      current.mtimeMs !== expected.mtimeMs
    ) {
      return false;
    }
    try {
      fs.unlinkSync(file);
      return true;
    } catch (exc) {
      return (exc as NodeJS.ErrnoException).code === "ENOENT";
    }
  }

  /**
   * True when the path still names the exact file this acquisition created,
   * including its per-acquisition nonce. A writer that stalled past the
   * malformed grace can be reclaimed while its write is in flight; the success
   * path checks this before reporting that it owns the store. The nonce also
   * protects against an immediate inode reuse by the reclaimer's new file.
   */
  private lockStillOwned(file: string, ownStats: fs.Stats, nonce: string): boolean {
    const snapshot = this.writerLockSnapshot();
    if (snapshot.stats === null || snapshot.holder === null) return false;
    return (
      snapshot.stats.dev === ownStats.dev &&
      snapshot.stats.ino === ownStats.ino &&
      snapshot.holder.nonce === nonce
    );
  }

  /**
   * Take the single-writer lock for this store. `serve`/TUI callers hold it
   * for their lifetime; `sessions migrate` and `spill gc` take it briefly and
   * refuse to run while a live lock exists. A lock whose pid is dead is
   * removed and retried once. A malformed/empty lock (a crashed writer, or a
   * disk-full write failure in the previous owner) is reclaimed only once it
   * is older than {@link SESSION_LOCK_MALFORMED_GRACE_MS}; a recent one still
   * refuses, because a concurrent writer may be mid-write. Reclaim and
   * failed-write cleanup only unlink the exact file they inspected, so two
   * processes racing over one stale lock cannot delete each other's fresh
   * lock. Every failure after this call created the lock file removes that
   * file before rethrowing.
   */
  acquireWriterLock(owner: string): () => void {
    ensureDir(this.root);
    const label = owner.trim() || "two-brothers";
    const file = path.join(this.root, SESSION_LOCK_FILE);
    const nonce = randomBytes(8).toString("hex");
    const body =
      JSON.stringify(
        { owner: label, pid: process.pid, created: new Date().toISOString(), nonce },
        null,
        2,
      ) + "\n";
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let fd: number;
      try {
        fd = fs.openSync(file, "wx");
      } catch (exc) {
        if ((exc as NodeJS.ErrnoException).code !== "EEXIST") throw exc;
        const snapshot = this.writerLockSnapshot();
        const holder = snapshot.holder;
        if (holder !== null && !pidAlive(holder.pid)) {
          if (snapshot.stats !== null) {
            this.lockReclaimHook?.(file, snapshot.stats);
            this.unlinkIfUnchanged(file, snapshot.stats);
          }
          continue;
        }
        if (holder === null) {
          if (snapshot.stats === null) continue; // vanished; retry the create
          if (
            snapshot.stats.isFile() &&
            Date.now() - snapshot.stats.mtimeMs >= SESSION_LOCK_MALFORMED_GRACE_MS
          ) {
            this.lockReclaimHook?.(file, snapshot.stats);
            this.unlinkIfUnchanged(file, snapshot.stats);
            continue;
          }
        }
        throw new SessionLayoutLockedError(holder);
      }
      let failure: unknown = null;
      let ownStats: fs.Stats | null = null;
      try {
        try {
          if (this.lockWriteHook !== null) this.lockWriteHook(fd, body);
          else fs.writeFileSync(fd, body);
          fs.fsyncSync(fd);
        } catch (exc) {
          failure = exc;
        }
      } finally {
        try {
          ownStats = fs.fstatSync(fd);
        } catch {
          // no identity to prove ownership; leave cleanup to the grace path
        }
        try {
          fs.closeSync(fd);
        } catch (exc) {
          if (failure === null) failure = exc;
        }
      }
      if (failure !== null) {
        // Remove only the inode this call created: a reclaim that raced past
        // the malformed grace may already own a fresh lock at this path.
        if (ownStats !== null) this.unlinkIfUnchanged(file, ownStats);
        throw failure;
      }
      // A successful but slow write can also lose the grace race. Do not
      // report ownership when the path no longer resolves to our file.
      if (ownStats === null || !this.lockStillOwned(file, ownStats, nonce)) {
        throw new SessionLayoutLockedError(this.writerLock());
      }
      return () => {
        const snapshot = this.writerLockSnapshot();
        const current = snapshot.holder;
        if (
          current !== null &&
          current.pid === process.pid &&
          current.owner === label &&
          current.nonce === nonce &&
          snapshot.stats !== null
        ) {
          this.unlinkIfUnchanged(file, snapshot.stats);
        }
      };
    }
    throw new SessionLayoutLockedError(this.writerLock());
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
  let stat: fs.Stats;
  try {
    stat = fs.statSync(layout.root);
  } catch {
    throw new Error(`sessions directory not found: ${layout.root}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`sessions path is not a directory: ${layout.root}`);
  }
  // Migration is a writer: hold the same single-writer lock as serve/TUI so a
  // live process cannot keep appending to a file that is being moved. An
  // explicit force is the operator's escape hatch (documented as unsafe).
  if (options.force === true) return migrateLocked(layout, options);
  const release = layout.acquireWriterLock("sessions migrate");
  try {
    return migrateLocked(layout, options);
  } finally {
    release();
  }
}

/** Remove hidden temp files left by a crashed previous migration. */
function cleanupStaleTemps(layout: SessionLayout): void {
  try {
    for (const entry of fs.readdirSync(layout.root, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.startsWith(`${SESSION_LAYOUT_FILE}.tmp-`)) {
        try {
          fs.unlinkSync(path.join(layout.root, entry.name));
        } catch {
          // best effort
        }
        continue;
      }
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      if (RESERVED_DIRS.has(entry.name)) continue;
      const projectDir = path.join(layout.root, entry.name);
      for (const child of fs.readdirSync(projectDir, { withFileTypes: true })) {
        if (!child.isDirectory() || !child.name.startsWith(".tmp-")) continue;
        try {
          fs.rmSync(path.join(projectDir, child.name), { recursive: true, force: true });
        } catch {
          // best effort
        }
      }
    }
  } catch {
    // best effort; never fail the migration over cleanup
  }
}

function migrateLocked(
  layout: SessionLayout,
  options: SessionMigrationOptions,
): SessionMigrationResult {
  // The migration lock is held: every hidden temp directory is a crashed
  // previous copy, so reclaiming them is safe.
  cleanupStaleTemps(layout);
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
    if (metaRaw === null && fs.existsSync(metaPath)) {
      entries.push({
        name,
        sourcePath,
        targetPath: target.sessionPath,
        status: "error",
        detail: "cannot read the flat meta.json; refusing to delete it",
      });
      continue;
    }

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
        const sourceEvents = fs.existsSync(eventsPath)
          ? fs.readFileSync(eventsPath)
          : null;
        const targetMetaRaw = fs.existsSync(target.metaPath)
          ? fs.readFileSync(target.metaPath, "utf-8")
          : null;
        const targetEvents = fs.existsSync(target.eventsPath)
          ? fs.readFileSync(target.eventsPath)
          : null;
        // Never delete a divergent flat sidecar. An interrupted migration
        // followed by an update on either side is a conflict until the
        // operator chooses which copy to keep.
        if (metaRaw !== null && targetMetaRaw !== null && metaRaw !== targetMetaRaw) {
          entries.push({
            name,
            sourcePath,
            targetPath: target.metaPath,
            status: "conflict",
            detail: "target meta.json already exists with different bytes",
          });
          continue;
        }
        if (sourceEvents !== null && targetEvents !== null && !sourceEvents.equals(targetEvents)) {
          entries.push({
            name,
            sourcePath,
            targetPath: target.eventsPath,
            status: "conflict",
            detail: "target events.jsonl already exists with different bytes",
          });
          continue;
        }
        if (!dryRun) {
          // Adopt an interrupted previous migration: fill missing identical
          // sidecars, then remove the flat source files.
          if (metaRaw !== null && targetMetaRaw === null) {
            writeDurable(target.metaPath, metaRaw);
          }
          if (sourceEvents !== null && targetEvents === null) {
            writeDurable(target.eventsPath, sourceEvents);
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
    // did not create). A dry run must not touch it but must report the same
    // conflict the real pass would.
    if (fs.existsSync(target.dir as string)) {
      let nonEmpty = false;
      try {
        nonEmpty = fs.readdirSync(target.dir as string).length > 0;
      } catch {
        nonEmpty = true;
      }
      if (nonEmpty) {
        entries.push({
          name,
          sourcePath,
          targetPath: target.sessionPath,
          status: "conflict",
          detail: "target directory is not empty",
        });
        continue;
      }
      if (!dryRun) {
        try {
          fs.rmdirSync(target.dir as string);
        } catch (exc) {
          entries.push({
            name,
            sourcePath,
            targetPath: target.sessionPath,
            status: "conflict",
            detail: `target directory could not be removed: ${exc instanceof Error ? exc.message : String(exc)}`,
          });
          continue;
        }
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
      writeDurable(path.join(tempDir, "session.jsonl"), sessionBytes);
      if (metaRaw !== null) writeDurable(path.join(tempDir, "meta.json"), metaRaw);
      if (fs.existsSync(eventsPath)) {
        writeDurable(path.join(tempDir, "events.jsonl"), fs.readFileSync(eventsPath));
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
  // A clean dry run reports the layout the real pass would write; a failure
  // leaves the store in its current layout.
  return {
    dryRun,
    layout: hasFailure ? layout.mode() : "dirs",
    entries,
  };
}
