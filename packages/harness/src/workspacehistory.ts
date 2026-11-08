/**
 * Run-scoped workspace edit undo: a bounded, content-addressed store of the
 * pre/post images of every file mutation one run made, plus preview/apply/
 * discard over the live workspace.
 *
 * Design adapted from opencode's snapshot + session-revert services (MIT,
 * github.com/sst/opencode: `packages/core/src/snapshot.ts` and
 * `packages/core/src/session/revert.ts`). Content-addressed captures and
 * per-file restores are the borrowed ideas; the git shadow-tree machinery is
 * deliberately not vendored — this store keeps only the bytes one run needs,
 * under a caller-provided root (the server will pass `<sessions>/undo`), with
 * no git dependency and no new runtime deps.
 *
 * Store layout:
 *
 *   <root>/runs/<runId>.json     one record per run (metadata only)
 *   <root>/blobs/<xx>/<sha256>   exact bytes, content-addressed, shared across runs
 *
 * Honesty rules:
 * - Undo only touches files the run mutated through the workspace tools.
 *   Shell-made changes, external edits, and untracked files are out of scope.
 * - Every entry is classified against the LIVE workspace. A file whose content
 *   no longer matches the recorded post-image is refused per file
 *   (`changed-since`), never overwritten.
 * - Capture limits (per-file size, entry cap, byte budget) are recorded as
 *   `skipped` entries, never silently dropped. Anything the store cannot undo
 *   is reported as such.
 * - IO failures during apply are fail-soft per file and counted in the
 *   result; whole-store problems (invalid run id, missing/corrupt record,
 *   workspace-root mismatch) refuse the operation with a
 *   {@link WorkspaceUndoError}.
 * - Retention is explicit and bounded: a capture close runs one pass that
 *   keeps the newest N records per session, prunes records past the max age
 *   (default 20 / 30 days) and never removes an active run's record; a
 *   discard then collects blobs no retained record references. Shared blobs
 *   survive, and an unreadable record refuses blob collection rather than
 *   guessing.
 * - POSIX file mode/ownership is captured additively and restored best-effort
 *   after a write (a failed chmod/chown is disclosed on the apply row, never
 *   fatal, and never turns a restored file into `failed`). Windows is a no-op.
 *
 * The store is a session side artifact: it never enters protocol envelopes or
 * session JSONL.
 */
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  MAX_MUTATION_CAPTURE_BYTES,
  type WorkspaceMutationImage,
  type WorkspaceMutationRecord,
  type WorkspaceMutationRecorder,
} from "./workspace.ts";

/** Record format version; a mismatch refuses instead of guessing. */
export const WORKSPACE_UNDO_VERSION = 1;

/** One side of a mutation is skipped beyond this size (same bound the seam uses). */
export const MAX_UNDO_FILE_BYTES = MAX_MUTATION_CAPTURE_BYTES;

/** At most this many distinct files are undo-tracked per run. */
export const MAX_UNDO_ENTRIES = 64;

/**
 * At most this many NEW blob bytes are stored per run. Content already in the
 * store (dedupe across runs and within a run) is free and not counted.
 */
export const MAX_UNDO_STORE_BYTES = 8 * 1024 * 1024;

/** Records are metadata only; a bigger file is corrupt and refused. */
export const MAX_UNDO_RECORD_BYTES = 1024 * 1024;

/** Diagnostic lines kept per capture session (further failures are counted, not stored). */
export const MAX_UNDO_DIAGNOSTICS = 16;

/**
 * Default retention: keep the newest N records per session. Retention only
 * ever runs when explicitly triggered (a capture close, an explicit GC call);
 * a record for a run that is still active is never removed.
 */
export const DEFAULT_UNDO_MAX_RECORDS_PER_SESSION = 20;

/** Default retention: delete records older than this many days (0 disables age pruning). */
export const DEFAULT_UNDO_MAX_AGE_DAYS = 30;

/** One bounded retention pass never scans more record files than this. */
export const MAX_UNDO_GC_RECORDS = 500;

/** One bounded blob pass never scans more blob files than this. */
export const MAX_UNDO_GC_BLOBS = 10000;

/** Run ids are opaque caller tokens; traversal and separators are refused. */
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Machine-readable reason a {@link WorkspaceUndoError} was raised, so HTTP
 * routes can map it without matching messages: unknown/invalid records are a
 * 404, corrupt/oversized/unsupported/mismatched records a 409, and unexpected
 * store IO a 422. The message stays the operator-facing detail.
 */
export type WorkspaceUndoErrorCode =
  | "invalid_run_id"
  | "unknown_record"
  | "corrupt_record"
  | "unsupported_version"
  | "oversized_record"
  | "workspace_unavailable"
  | "workspace_mismatch"
  | "io_error";

/** Raised when a whole-store operation cannot proceed honestly. */
export class WorkspaceUndoError extends Error {
  readonly code: WorkspaceUndoErrorCode;

  constructor(code: WorkspaceUndoErrorCode, message: string) {
    super(message);
    this.name = "WorkspaceUndoError";
    this.code = code;
  }
}

/** One captured side of one mutation. */
export interface WorkspaceUndoImage {
  exists: boolean;
  /** sha256 hex of the captured bytes (absent when the image was skipped). */
  sha256?: string;
  /** Byte size when the target existed. */
  size?: number;
  /**
   * POSIX permission/special bits (`stat.mode & 0o7777`) when captured. The
   * seam may supply it; the store also stats the live target after a
   * write/edit, where the old mode is preserved, so a 0755 script keeps its
   * executable bits across undo. Absent on Windows and for old records.
   */
  mode?: number;
  /** POSIX owner id when captured (best-effort restore, never fatal). */
  uid?: number;
  /** POSIX group id when captured (best-effort restore, never fatal). */
  gid?: number;
}

/** One undo entry: the net effect of a run on one file. */
export interface WorkspaceUndoEntry {
  /** Workspace-relative POSIX path. */
  path: string;
  /** The run's last action on the file (for display; undo goes by pre/post). */
  action: "write" | "edit" | "delete";
  /** Image of the file before the run first touched it. */
  pre: WorkspaceUndoImage;
  /** Image of the file after the run last touched it. */
  post: WorkspaceUndoImage;
  /** Why this file cannot be undone by this store (capture bound, budget, ...). */
  skipped?: string;
}

/** One run's undo record (versioned side artifact, never a protocol record). */
export interface WorkspaceUndoRecord {
  version: number;
  /** Canonical absolute workspace root the run mutated. */
  workspace_root: string;
  /** Session that produced the record, when the caller supplied one. */
  session?: string;
  /** ISO timestamp of the capture session start. */
  created_at: string;
  entries: WorkspaceUndoEntry[];
  /** Mutations refused after {@link MAX_UNDO_ENTRIES}; reported, not dropped. */
  omitted?: { entries: number; reason: string };
}

/** How one file would fare if the run were undone now. */
export type WorkspaceUndoStatus =
  | "applicable"
  | "created"
  | "deleted"
  | "changed-since"
  | "skipped"
  | "missing";

/** Per-file preview row. */
export interface WorkspaceUndoPreviewEntry {
  path: string;
  action: "write" | "edit" | "delete";
  status: WorkspaceUndoStatus;
  reason?: string;
  /** True when `applyUndo` would restore or delete this file. */
  reversible: boolean;
}

/** Honest, live classification of one run's mutations. */
export interface WorkspaceUndoPreview {
  run_id: string;
  workspace_root: string;
  created_at: string;
  entries: WorkspaceUndoPreviewEntry[];
  counts: {
    applicable: number;
    created: number;
    deleted: number;
    changed_since: number;
    skipped: number;
    missing: number;
    total: number;
  };
  omitted?: { entries: number; reason: string };
}

/** Outcome of applying undo to one file. */
export type WorkspaceUndoApplyStatus = "applied" | "refused" | "failed";

/** Per-file apply row. */
export interface WorkspaceUndoApplyEntry {
  path: string;
  action: "write" | "edit" | "delete";
  status: WorkspaceUndoApplyStatus;
  /** The live classification that drove the decision. */
  preview_status: WorkspaceUndoStatus;
  reason?: string;
  /**
   * Mode/ownership restoration is best-effort and never changes `status`:
   * a file whose bytes were restored successfully stays `applied` even when
   * its recorded mode could not be re-applied, and the failure is disclosed
   * here instead of being hidden.
   */
  mode_restored?: boolean;
  mode_error?: string;
  ownership_restored?: boolean;
  ownership_error?: string;
}

/** Summary of one apply pass (no partial silent corruption: every file is counted). */
export interface WorkspaceUndoApplyResult {
  run_id: string;
  workspace_root: string;
  applied: number;
  refused: number;
  failed: number;
  entries: WorkspaceUndoApplyEntry[];
  omitted?: { entries: number; reason: string };
}

/**
 * One run's capture handle. The server builds it before a run, wires
 * `recorder` into the workspace, and can inspect the outcome afterwards.
 */
export interface WorkspaceUndoCapture {
  readonly run_id: string;
  readonly store_root: string;
  readonly workspace_root: string;
  /** Pass as `WorkspaceOptions.mutationRecorder` (or `setMutationRecorder`). */
  readonly recorder: WorkspaceMutationRecorder;
  /** Undo entries recorded so far. */
  readonly entryCount: number;
  /** Mutations refused after {@link MAX_UNDO_ENTRIES}. */
  readonly omittedCount: number;
  /** One bounded line per capture failure; never thrown into the tool path. */
  readonly diagnostics: string[];
  /** Absolute run-record path; null until the first capture is written. */
  readonly recordPath: string | null;
  /**
   * Outcome of the bounded retention pass run by {@link close} (null when
   * retention was disabled or has not run yet). Fail-soft: a retention
   * failure is one diagnostic, never an exception.
   */
  readonly lastRetention: UndoRetentionResult | null;
  /**
   * Finish the capture (the run's `finally`): idempotent, never throws, stops
   * accepting further mutation records and makes one final persist attempt so
   * a record whose last write failed is salvaged. No record is written when the
   * run mutated nothing. A bounded retention pass then trims the newest-N /
   * max-age window (unless disabled) and collects unreferenced blobs.
   */
  close(): void;
}

/** Newest-N / max-age window applied by an explicit retention pass. */
export interface UndoRetentionPolicy {
  /** Keep the newest N records per session (default 20, minimum 1). */
  maxRecordsPerSession?: number;
  /** Remove records older than this many days (default 30; 0 disables). */
  maxAgeDays?: number;
}

/** Options for the close-time (and explicit) retention pass. */
export interface UndoRetentionOptions extends UndoRetentionPolicy {
  /** Clock override for tests; defaults to `Date.now()`. */
  now?: number | Date;
  /** Run ids that must never be removed (in-flight runs). */
  activeRuns?: Iterable<string>;
  /** Set false to skip orphan blob collection (record pruning still runs). */
  collectBlobs?: boolean;
  /**
   * Test seam: called immediately before a record unlink, so tests can
   * simulate a transient EPERM/EBUSY without platform-specific file locks.
   * Production never sets it.
   */
  beforeUnlink?: (recordPath: string, runId: string) => void;
}

/** Honest summary of one bounded retention pass. */
export interface UndoRetentionResult {
  records_scanned: number;
  records_kept: number;
  /** Run ids whose record file was removed. */
  records_removed: string[];
  /** Blob sha256 names whose bytes were removed as unreferenced. */
  blobs_removed: string[];
  /** Bounded fail-soft notes (a pass never throws). */
  diagnostics: string[];
}

/** Honest summary of one orphan blob collection. */
export interface UndoBlobGcResult {
  removed: string[];
  diagnostics: string[];
  /** Set when the pass refused to delete anything (with the reason). */
  skipped?: string;
}

/** Options for {@link beginUndoCapture}. */
export interface BeginUndoCaptureOptions extends UndoRetentionPolicy {
  /** Owning session name (the server passes it); persisted additively. */
  session?: string;
  /** Set false to disable the close-time retention pass. */
  retention?: boolean;
  /** Lazily read every run id that must never be removed at close time. */
  activeRuns?: () => Iterable<string>;
  /** Receives the close-time retention result (a throwing sink is ignored). */
  onRetention?: (result: UndoRetentionResult) => void;
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function message(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function samePath(a: string, b: string): boolean {
  const x = path.resolve(a);
  const y = path.resolve(b);
  return process.platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y;
}

function assertRunId(runId: string): void {
  if (typeof runId !== "string" || !RUN_ID_PATTERN.test(runId)) {
    throw new WorkspaceUndoError(
      "invalid_run_id",
      `invalid undo run id: ${String(runId).slice(0, 64)}`,
    );
  }
}

function assertStoreRoot(storeRoot: string): string {
  if (typeof storeRoot !== "string" || storeRoot.trim() === "") {
    throw new WorkspaceUndoError("io_error", "an undo store root is required");
  }
  return path.resolve(storeRoot);
}

/** Clamp the newest-N policy to a positive integer (bad input falls back). */
function normalizeRetentionCount(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const rounded = Math.trunc(value);
  return rounded >= 1 ? rounded : 1;
}

/** Clamp the max-age policy to a non-negative integer (0 disables age pruning). */
function normalizeRetentionAge(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const rounded = Math.trunc(value);
  return rounded >= 0 ? rounded : fallback;
}

function resolveWorkspaceRoot(workspaceRoot: string): string {
  try {
    const resolved = fs.realpathSync(workspaceRoot);
    if (!fs.statSync(resolved).isDirectory()) {
      throw new WorkspaceUndoError(
        "workspace_unavailable",
        `workspace root is not a directory: ${workspaceRoot}`,
      );
    }
    return resolved;
  } catch (exc) {
    if (exc instanceof WorkspaceUndoError) throw exc;
    throw new WorkspaceUndoError(
      "workspace_unavailable",
      `workspace root is not available: ${workspaceRoot}`,
    );
  }
}

function undoRecordPath(storeRoot: string, runId: string): string {
  return path.join(storeRoot, "runs", `${runId}.json`);
}

function blobPath(storeRoot: string, hash: string): string {
  return path.join(storeRoot, "blobs", hash.slice(0, 2), hash);
}

/**
 * Resolve a recorded workspace-relative path to a canonical target inside the
 * workspace, or explain why it is refused. Traversal, absolute paths, and
 * paths that escape through a symlink are all refused.
 */
function resolveEntryTarget(
  workspaceRoot: string,
  rel: string,
): { ok: true; target: string } | { ok: false; reason: string } {
  if (typeof rel !== "string" || rel.length === 0 || rel.length > 4096) {
    return { ok: false, reason: "malformed record entry (no usable path)" };
  }
  if (rel.includes("\0")) return { ok: false, reason: "refused record entry: NUL byte in path" };
  if (path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) {
    return { ok: false, reason: `refused record entry: absolute paths are not allowed (${rel})` };
  }
  if (process.platform === "win32" && rel.includes("/") === false && rel.includes("\\")) {
    return { ok: false, reason: "refused record entry: backslash in a Windows record path" };
  }
  const parts = rel.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    return { ok: false, reason: `refused record entry: path escapes the workspace (${rel})` };
  }
  let candidate: string;
  try {
    candidate = realpathNonStrict(path.resolve(workspaceRoot, rel));
  } catch (exc) {
    return { ok: false, reason: `cannot resolve record entry ${rel}: ${message(exc)}` };
  }
  if (candidate === workspaceRoot) {
    return { ok: false, reason: `refused record entry: the workspace root is not a file target (${rel})` };
  }
  if (!candidate.startsWith(workspaceRoot + path.sep)) {
    return { ok: false, reason: `refused record entry: path escapes the workspace (${rel})` };
  }
  return { ok: true, target: candidate };
}

/** Resolve symlinks on the existing prefix, keep the rest — pathlib resolve(strict=False). */
function realpathNonStrict(target: string): string {
  let anchor = target;
  const rest: string[] = [];
  for (;;) {
    try {
      const resolved = fs.realpathSync(anchor);
      return path.resolve(resolved, ...rest.reverse());
    } catch {
      const parent = path.dirname(anchor);
      if (parent === anchor) return target;
      rest.push(path.basename(anchor));
      anchor = parent;
    }
  }
}

/** Bounded, atomic-ish replace: write a sibling temp file, then rename over. */
function writeAtomic(target: string, bytes: Uint8Array): void {
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const temp = path.join(dir, `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temp, bytes);
    fs.renameSync(temp, target);
  } catch (exc) {
    try {
      fs.unlinkSync(temp);
    } catch {
      // the temp file may never have been created; the real error is below
    }
    throw exc;
  }
}

function blobExists(storeRoot: string, hash: string): boolean {
  try {
    return fs.statSync(blobPath(storeRoot, hash)).isFile();
  } catch {
    return false;
  }
}

function storeBlob(storeRoot: string, hash: string, bytes: Uint8Array): void {
  if (blobExists(storeRoot, hash)) return;
  writeAtomic(blobPath(storeRoot, hash), bytes);
}

/** Read one stored image and prove the bytes still hash to its name. */
function readBlobVerified(storeRoot: string, image: WorkspaceUndoImage): Buffer {
  if (image.exists !== true) throw new Error("recorded image does not exist");
  if (typeof image.sha256 !== "string" || !SHA256_PATTERN.test(image.sha256)) {
    throw new Error("recorded image has no valid sha256");
  }
  const bytes = fs.readFileSync(blobPath(storeRoot, image.sha256));
  if (sha256Hex(bytes) !== image.sha256) {
    throw new Error("stored image bytes do not match their sha256");
  }
  if (image.size !== undefined && bytes.byteLength !== image.size) {
    throw new Error(`stored image is ${bytes.byteLength} bytes, record says ${image.size}`);
  }
  return bytes;
}

/** Chunked file hash: bounded memory for any live file size. */
function hashFileSync(target: string): string {
  const hash = createHash("sha256");
  const fd = fs.openSync(target, "r");
  try {
    const chunk = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const read = fs.readSync(fd, chunk, 0, chunk.byteLength, null);
      if (read <= 0) break;
      hash.update(chunk.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

/**
 * Restore the recorded POSIX mode/ownership after the bytes were written.
 * Best-effort by contract: a failure is disclosed on the apply row and never
 * turns a successful byte restore into a `failed` one. Windows is a no-op.
 */
function applyModeAttributes(
  target: string,
  image: WorkspaceUndoImage,
): Pick<
  WorkspaceUndoApplyEntry,
  "mode_restored" | "mode_error" | "ownership_restored" | "ownership_error"
> {
  const out: Pick<
    WorkspaceUndoApplyEntry,
    "mode_restored" | "mode_error" | "ownership_restored" | "ownership_error"
  > = {};
  if (process.platform === "win32") return out;
  // Ownership first: a successful chown clears setuid/setgid on Linux, so
  // restoring the mode afterwards is what makes special bits stick.
  if (image.uid !== undefined && image.gid !== undefined) {
    try {
      fs.chownSync(target, image.uid, image.gid);
      out.ownership_restored = true;
    } catch (exc) {
      out.ownership_restored = false;
      out.ownership_error = `could not restore file ownership: ${message(exc)}`;
    }
  }
  if (image.mode !== undefined) {
    // A recorded mode is a POSIX permission word (permission bits plus
    // setuid/setgid/sticky), so an out-of-range or non-integer value is a
    // corrupt record. Refuse it explicitly instead of handing it to chmod,
    // where a large value may be silently truncated and "succeed".
    if (!Number.isInteger(image.mode) || image.mode < 0 || image.mode > 0o7777) {
      out.mode_restored = false;
      out.mode_error = `could not restore the file mode: invalid recorded mode ${String(image.mode)}`;
    } else {
      try {
        fs.chmodSync(target, image.mode);
        out.mode_restored = true;
      } catch (exc) {
        out.mode_restored = false;
        out.mode_error = `could not restore the file mode: ${message(exc)}`;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// capture
// ---------------------------------------------------------------------------

interface PlannedImage {
  /** Stored-image metadata (sha256 only when the bytes were available). */
  image: WorkspaceUndoImage;
  content?: Buffer;
  hash?: string;
  /** Bytes that would be added to the store if this image is committed. */
  newBytes: number;
  skipped?: string;
}

class UndoCapture implements WorkspaceUndoCapture {
  readonly run_id: string;
  readonly store_root: string;
  readonly workspace_root: string;
  readonly recorder: WorkspaceMutationRecorder;
  readonly diagnostics: string[] = [];

  private readonly session?: string;
  private readonly createdAt = new Date().toISOString();
  private readonly entries: WorkspaceUndoEntry[] = [];
  private readonly index = new Map<string, number>();
  private readonly retentionEnabled: boolean;
  private readonly retentionPolicy: Required<UndoRetentionPolicy>;
  private readonly activeRuns?: () => Iterable<string>;
  private readonly onRetention?: (result: UndoRetentionResult) => void;
  private retentionResult: UndoRetentionResult | null = null;
  private storedBytes = 0;
  private omitted = 0;
  private wroteRecord = false;
  private closed = false;

  constructor(
    storeRoot: string,
    runId: string,
    workspaceRoot: string,
    options: BeginUndoCaptureOptions = {},
  ) {
    this.run_id = runId;
    this.store_root = storeRoot;
    this.workspace_root = workspaceRoot;
    const rawSession = options.session;
    if (typeof rawSession === "string" && rawSession.trim() !== "") {
      this.session = rawSession.trim();
    }
    this.retentionEnabled = options.retention !== false;
    this.retentionPolicy = {
      maxRecordsPerSession: normalizeRetentionCount(
        options.maxRecordsPerSession,
        DEFAULT_UNDO_MAX_RECORDS_PER_SESSION,
      ),
      maxAgeDays: normalizeRetentionAge(options.maxAgeDays, DEFAULT_UNDO_MAX_AGE_DAYS),
    };
    if (options.activeRuns !== undefined) this.activeRuns = options.activeRuns;
    if (options.onRetention !== undefined) this.onRetention = options.onRetention;
    this.recorder = (record) => {
      try {
        this.capture(record);
      } catch (exc) {
        this.diagnostic(`undo capture failed for ${safePath(record?.path)}: ${message(exc)}`);
      }
    };
  }

  get entryCount(): number {
    return this.entries.length;
  }

  get omittedCount(): number {
    return this.omitted;
  }

  get recordPath(): string | null {
    return this.wroteRecord ? undoRecordPath(this.store_root, this.run_id) : null;
  }

  get lastRetention(): UndoRetentionResult | null {
    return this.retentionResult;
  }

  /**
   * Finish the capture: idempotent, never throws. One final persist salvages a
   * record whose per-mutation write failed; further mutation records are
   * ignored (the run is over, nothing may change the undo state afterwards).
   * The bounded retention pass runs even when the run mutated nothing — it is
   * housekeeping, not a property of this one record.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.entries.length > 0) {
      try {
        this.persist();
      } catch (exc) {
        this.diagnostic(`undo capture close: final record write failed: ${message(exc)}`);
      }
    }
    this.runRetention();
  }

  /** One bounded, fail-soft retention pass. Never throws, one diagnostic per failure. */
  private runRetention(): void {
    if (!this.retentionEnabled) return;
    try {
      const active = new Set<string>([this.run_id]);
      try {
        for (const runId of this.activeRuns?.() ?? []) {
          if (typeof runId === "string" && runId.length > 0) active.add(runId);
        }
      } catch (exc) {
        this.diagnostic(`undo retention: active-run lookup failed: ${message(exc)}`);
      }
      const result = collectUndoStore(this.store_root, {
        maxRecordsPerSession: this.retentionPolicy.maxRecordsPerSession,
        maxAgeDays: this.retentionPolicy.maxAgeDays,
        activeRuns: active,
        now: Date.now(),
      });
      this.retentionResult = result;
      for (const line of result.diagnostics) this.diagnostic(`undo retention: ${line}`);
      try {
        this.onRetention?.(result);
      } catch {
        // a broken retention sink must never break a run's finalizer
      }
    } catch (exc) {
      this.diagnostic(`undo retention failed: ${message(exc)}`);
    }
  }

  private diagnostic(line: string): void {
    if (this.diagnostics.length < MAX_UNDO_DIAGNOSTICS) this.diagnostics.push(line.slice(0, 500));
  }

  private capture(record: WorkspaceMutationRecord): void {
    if (this.closed) return; // the run is over: no mutation may change the undo state
    if (record === null || typeof record !== "object") {
      this.diagnostic("undo capture failed: the workspace emitted no mutation record");
      return;
    }
    const action = record.action;
    if (action !== "write" && action !== "edit" && action !== "delete") {
      this.diagnostic(`undo capture failed: unknown mutation action ${String(action)}`);
      return;
    }
    if (typeof record.root !== "string" || typeof record.path !== "string") {
      this.diagnostic("undo capture failed: mutation record has no root/path");
      return;
    }
    if (!samePath(record.root, this.workspace_root)) {
      this.diagnostic(`undo capture refused for ${safePath(record.path)}: record belongs to another workspace`);
      return;
    }
    const rel = normalizeRecordPath(record.path);
    if (rel === null) {
      this.diagnostic(`undo capture refused for ${safePath(record.path)}: path is not workspace-relative`);
      return;
    }

    const existingIndex = this.index.get(rel);
    const existing = existingIndex === undefined ? undefined : this.entries[existingIndex];

    // A skipped entry can never be recovered: its earliest pre-image is gone.
    if (existing !== undefined && existing.skipped !== undefined) {
      existing.action = action;
      existing.post = describeImage(record.post);
      return;
    }

    const pre = this.planImage(record.pre);
    const post = this.planImage(record.post);
    if (process.platform !== "win32") {
      this.enrichMode(rel, action, existing, pre.image, post.image);
    }
    const skipReason = pre.skipped ?? post.skipped;
    if (skipReason !== undefined) {
      this.recordEntry(existing, {
        path: rel,
        action,
        pre: describeImage(record.pre),
        post: describeImage(record.post),
        skipped: skipReason,
      });
      this.persist();
      return;
    }

    if (this.storedBytes + pre.newBytes + post.newBytes > MAX_UNDO_STORE_BYTES) {
      this.recordEntry(existing, {
        path: rel,
        action,
        pre: describeImage(record.pre),
        post: describeImage(record.post),
        skipped:
          `run capture budget of ${MAX_UNDO_STORE_BYTES} bytes exhausted ` +
          `(would need ${pre.newBytes + post.newBytes} more)`,
      });
      this.persist();
      return;
    }

    // Commit the bytes first, so a record never references a missing blob.
    if (pre.hash !== undefined && pre.content !== undefined && pre.newBytes > 0) {
      storeBlob(this.store_root, pre.hash, pre.content);
      this.storedBytes += pre.newBytes;
    }
    if (post.hash !== undefined && post.content !== undefined && post.newBytes > 0) {
      storeBlob(this.store_root, post.hash, post.content);
      this.storedBytes += post.newBytes;
    }

    this.recordEntry(existing, {
      path: rel,
      action,
      pre: existing !== undefined ? existing.pre : pre.image,
      post: post.image,
    });
    this.persist();
  }

  private planImage(raw: WorkspaceMutationImage): PlannedImage {
    if (raw === null || typeof raw !== "object") {
      return { image: { exists: false }, newBytes: 0, skipped: "image was not captured" };
    }
    if (typeof raw.skipped === "string" && raw.skipped.length > 0) {
      return {
        image: describeImage(raw),
        newBytes: 0,
        skipped: raw.skipped,
      };
    }
    if (raw.exists !== true) return { image: { exists: false }, newBytes: 0 };
    if (!Buffer.isBuffer(raw.content)) {
      return {
        image: describeImage(raw),
        newBytes: 0,
        skipped: "image content was not captured",
      };
    }
    const content = raw.content;
    const size = content.byteLength;
    if (size > MAX_UNDO_FILE_BYTES) {
      const image: WorkspaceUndoImage = { exists: true, size };
      copyModeFields(raw, image);
      return {
        image,
        newBytes: 0,
        skipped: `image is ${size} bytes; the capture limit is ${MAX_UNDO_FILE_BYTES} bytes`,
      };
    }
    const hash = sha256Hex(content);
    const image: WorkspaceUndoImage = { exists: true, sha256: hash, size };
    copyModeFields(raw, image);
    return {
      image,
      content,
      hash,
      newBytes: blobExists(this.store_root, hash) ? 0 : size,
    };
  }

  /**
   * Attach the live POSIX mode/ownership to the images when it can be trusted.
   * A write/edit preserves the existing file's mode, so the live stat after
   * the mutation is the pre-run mode; a delete has no live target, so the mode
   * recorded by an earlier mutation of the same path (if any) is kept.
   * Windows never records or restores modes (a no-op by contract).
   */
  private enrichMode(
    rel: string,
    action: WorkspaceMutationRecord["action"],
    existing: WorkspaceUndoEntry | undefined,
    pre: WorkspaceUndoImage,
    post: WorkspaceUndoImage,
  ): void {
    if (process.platform === "win32") return;
    const live = this.liveMode(rel);
    if (live !== null) {
      post.mode = live.mode;
      post.uid = live.uid;
      post.gid = live.gid;
    }
    if (!pre.exists || pre.mode !== undefined) return;
    const source = existing !== undefined ? existing.pre : action === "delete" ? null : live;
    if (source === null) return;
    if (source.mode !== undefined) pre.mode = source.mode;
    if (source.uid !== undefined) pre.uid = source.uid;
    if (source.gid !== undefined) pre.gid = source.gid;
  }

  /** Stat the live target's POSIX mode/ownership, or null when unavailable. */
  private liveMode(rel: string): { mode: number; uid: number; gid: number } | null {
    if (process.platform === "win32") return null;
    const resolved = resolveEntryTarget(this.workspace_root, rel);
    if (!resolved.ok) return null;
    try {
      const stat = fs.statSync(resolved.target);
      if (!stat.isFile()) return null;
      return { mode: stat.mode & 0o7777, uid: stat.uid, gid: stat.gid };
    } catch {
      return null;
    }
  }

  /**
   * Upsert the one entry per path: the earliest pre-image and the latest
   * post-image are the net run effect, so undo is a single restore/delete.
   */
  private recordEntry(existing: WorkspaceUndoEntry | undefined, next: WorkspaceUndoEntry): void {
    if (existing !== undefined) {
      existing.action = next.action;
      existing.post = next.post;
      if (next.skipped !== undefined) existing.skipped = next.skipped;
      return;
    }
    if (this.entries.length >= MAX_UNDO_ENTRIES) {
      this.omitted += 1;
      // The record file carries the honest count; one diagnostic names the cap.
      if (this.omitted === 1) {
        this.diagnostic(
          `undo capture omitted further mutations after the ${MAX_UNDO_ENTRIES}-entry cap`,
        );
      }
      return;
    }
    this.index.set(next.path, this.entries.length);
    this.entries.push(next);
  }

  private persist(): void {
    const record: WorkspaceUndoRecord = {
      version: WORKSPACE_UNDO_VERSION,
      workspace_root: this.workspace_root,
      ...(this.session !== undefined ? { session: this.session } : {}),
      created_at: this.createdAt,
      entries: this.entries,
      ...(this.omitted > 0
        ? {
            omitted: {
              entries: this.omitted,
              reason: `run entry cap of ${MAX_UNDO_ENTRIES} reached`,
            },
          }
        : {}),
    };
    writeAtomic(
      undoRecordPath(this.store_root, this.run_id),
      Buffer.from(JSON.stringify(record, null, 2) + "\n", "utf-8"),
    );
    this.wroteRecord = true;
  }
}

function safePath(value: unknown): string {
  return typeof value === "string" ? value.slice(0, 200) : "<unknown>";
}

/** Workspace record paths are display() POSIX paths; validate and normalize one. */
function normalizeRecordPath(rel: string): string | null {
  if (rel.length === 0 || rel.length > 4096) return null;
  if (rel.includes("\0")) return null;
  if (rel.startsWith("/") || rel.startsWith("\\")) return null;
  if (path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) return null;
  const parts = rel.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return null;
  if (process.platform === "win32" && rel.includes("\\")) return null;
  return parts.join("/");
}

/** Metadata-only view of a seam image (never carries the bytes into a record). */
function describeImage(raw: WorkspaceMutationImage): WorkspaceUndoImage {
  const exists = raw !== null && typeof raw === "object" && raw.exists === true;
  const image: WorkspaceUndoImage = { exists };
  if (raw !== null && typeof raw === "object" && typeof raw.size === "number" && Number.isFinite(raw.size)) {
    image.size = raw.size;
  }
  if (raw !== null && typeof raw === "object") copyModeFields(raw, image);
  return image;
}

/** Copy optional mode/uid/gid from a raw image when they are usable integers. */
function copyModeFields(raw: unknown, image: WorkspaceUndoImage): void {
  if (raw === null || typeof raw !== "object") return;
  const source = raw as Record<string, unknown>;
  const mode = source.mode;
  if (typeof mode === "number" && Number.isInteger(mode) && mode >= 0) image.mode = mode;
  const uid = source.uid;
  if (typeof uid === "number" && Number.isInteger(uid) && uid >= 0) image.uid = uid;
  const gid = source.gid;
  if (typeof gid === "number" && Number.isInteger(gid) && gid >= 0) image.gid = gid;
}

/**
 * Start capturing one run's mutations. Nothing is written until the first
 * successful mutation, so a run that changed nothing leaves no record.
 *
 * `options.session` is the owning session name when the caller knows it (the
 * server does): it is persisted additively so a session-scoped undo route can
 * refuse a run id that belongs to a different session. Records written without
 * it still load; the route simply skips that check.
 */
export function beginUndoCapture(
  storeRoot: string,
  runId: string,
  workspaceRoot: string,
  options: BeginUndoCaptureOptions = {},
): WorkspaceUndoCapture {
  const store = assertStoreRoot(storeRoot);
  assertRunId(runId);
  const workspace = resolveWorkspaceRoot(workspaceRoot);
  return new UndoCapture(store, runId, workspace, options);
}

// ---------------------------------------------------------------------------
// record loading and validation
// ---------------------------------------------------------------------------

interface OpenedUndoRecord {
  record: WorkspaceUndoRecord;
  store_root: string;
  workspace_root: string;
  record_path: string;
}

function sanitizeImage(raw: unknown): WorkspaceUndoImage {
  const source = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const image: WorkspaceUndoImage = { exists: source.exists === true };
  if (typeof source.sha256 === "string") image.sha256 = source.sha256;
  if (typeof source.size === "number" && Number.isFinite(source.size)) image.size = source.size;
  copyModeFields(source, image);
  return image;
}

function sanitizeEntry(raw: unknown): WorkspaceUndoEntry {
  const source = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const action =
    source.action === "write" || source.action === "edit" || source.action === "delete"
      ? source.action
      : "write";
  const entry: WorkspaceUndoEntry = {
    path: typeof source.path === "string" ? source.path : "",
    action,
    pre: sanitizeImage(source.pre),
    post: sanitizeImage(source.post),
  };
  if (typeof source.skipped === "string" && source.skipped.length > 0) {
    entry.skipped = source.skipped.slice(0, 500);
  }
  return entry;
}

function parseUndoRecord(text: string, runId: string): WorkspaceUndoRecord {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (exc) {
    throw new WorkspaceUndoError(
      "corrupt_record",
      `undo record for run ${runId} is not valid JSON: ${message(exc)}`,
    );
  }
  if (raw === null || typeof raw !== "object") {
    throw new WorkspaceUndoError("corrupt_record", `undo record for run ${runId} is not an object`);
  }
  const source = raw as Record<string, unknown>;
  if (source.version !== WORKSPACE_UNDO_VERSION) {
    throw new WorkspaceUndoError(
      "unsupported_version",
      `unsupported undo record version for run ${runId}: ${String(source.version)}`,
    );
  }
  if (typeof source.workspace_root !== "string" || source.workspace_root.length === 0) {
    throw new WorkspaceUndoError(
      "corrupt_record",
      `undo record for run ${runId} has no workspace root`,
    );
  }
  if (!Array.isArray(source.entries)) {
    throw new WorkspaceUndoError(
      "corrupt_record",
      `undo record for run ${runId} has no entries array`,
    );
  }
  if (source.entries.length > MAX_UNDO_ENTRIES) {
    throw new WorkspaceUndoError(
      "corrupt_record",
      `undo record for run ${runId} exceeds the ${MAX_UNDO_ENTRIES}-entry cap`,
    );
  }
  const record: WorkspaceUndoRecord = {
    version: WORKSPACE_UNDO_VERSION,
    workspace_root: source.workspace_root,
    created_at: typeof source.created_at === "string" ? source.created_at : "",
    entries: source.entries.map(sanitizeEntry),
  };
  if (typeof source.session === "string" && source.session.trim() !== "") {
    record.session = source.session.trim();
  }
  if (source.omitted !== null && typeof source.omitted === "object") {
    const omitted = source.omitted as Record<string, unknown>;
    const count = typeof omitted.entries === "number" && Number.isFinite(omitted.entries) ? omitted.entries : 0;
    if (count > 0) {
      record.omitted = {
        entries: count,
        reason:
          typeof omitted.reason === "string" && omitted.reason.length > 0
            ? omitted.reason
            : `run entry cap of ${MAX_UNDO_ENTRIES} reached`,
      };
    }
  }
  return record;
}

interface StoredUndoRecord {
  record: WorkspaceUndoRecord;
  record_path: string;
}

/**
 * Read and validate one run's record file without comparing its workspace
 * root. The HTTP routes use {@link loadUndoRecord} first to read the recorded
 * root/session (which registered workspace it belongs to), then call preview/
 * apply with that root; preview/apply re-read the record themselves.
 */
function readUndoRecordFile(storeRoot: string, runId: string): StoredUndoRecord {
  const recordPath = undoRecordPath(storeRoot, runId);
  let text: string;
  try {
    const stat = fs.statSync(recordPath);
    if (!stat.isFile()) {
      throw new WorkspaceUndoError(
        "corrupt_record",
        `undo record for run ${runId} is not a file`,
      );
    }
    if (stat.size > MAX_UNDO_RECORD_BYTES) {
      throw new WorkspaceUndoError(
        "oversized_record",
        `undo record for run ${runId} is oversized (${stat.size} bytes; limit ${MAX_UNDO_RECORD_BYTES})`,
      );
    }
    text = fs.readFileSync(recordPath, "utf-8");
  } catch (exc) {
    if (exc instanceof WorkspaceUndoError) throw exc;
    const code = (exc as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new WorkspaceUndoError("unknown_record", `no undo record for run ${runId}`);
    }
    throw new WorkspaceUndoError(
      "io_error",
      `cannot read undo record for run ${runId}: ${message(exc)}`,
    );
  }
  return { record: parseUndoRecord(text, runId), record_path: recordPath };
}

/**
 * Read and validate one run's stored record WITHOUT the workspace-root
 * comparison (a route needs the recorded root/session before it can resolve a
 * registered workspace and call `previewUndo`/`applyUndo`). Throws
 * {@link WorkspaceUndoError} with a machine code for every failure.
 */
export function loadUndoRecord(storeRoot: string, runId: string): WorkspaceUndoRecord {
  const store = assertStoreRoot(storeRoot);
  assertRunId(runId);
  return readUndoRecordFile(store, runId).record;
}

function openUndoRecord(storeRoot: string, runId: string, workspaceRoot: string): OpenedUndoRecord {
  const store = assertStoreRoot(storeRoot);
  assertRunId(runId);
  const workspace = resolveWorkspaceRoot(workspaceRoot);
  const { record, record_path } = readUndoRecordFile(store, runId);
  if (!samePath(record.workspace_root, workspace)) {
    throw new WorkspaceUndoError(
      "workspace_mismatch",
      `undo record for run ${runId} belongs to workspace ${record.workspace_root}, not ${workspace}`,
    );
  }
  return { record, store_root: store, workspace_root: workspace, record_path };
}

// ---------------------------------------------------------------------------
// live classification
// ---------------------------------------------------------------------------

interface LiveFile {
  ok: boolean;
  exists: boolean;
  isFile: boolean;
  sha256?: string;
  reason?: string;
}

function inspectLiveFile(target: string): LiveFile {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(target);
  } catch (exc) {
    const code = (exc as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { ok: true, exists: false, isFile: false };
    }
    return {
      ok: false,
      exists: false,
      isFile: false,
      reason: `cannot inspect the current file: ${message(exc)}`,
    };
  }
  if (!stat.isFile()) return { ok: true, exists: true, isFile: false };
  try {
    return { ok: true, exists: true, isFile: true, sha256: hashFileSync(target) };
  } catch (exc) {
    return {
      ok: false,
      exists: true,
      isFile: true,
      reason: `cannot read the current file: ${message(exc)}`,
    };
  }
}

function inspectStoredImage(
  storeRoot: string,
  image: WorkspaceUndoImage,
): { ok: true } | { ok: false; reason: string } {
  try {
    readBlobVerified(storeRoot, image);
    return { ok: true };
  } catch (exc) {
    return { ok: false, reason: `stored pre-image is unavailable: ${message(exc)}` };
  }
}

interface Classification {
  status: WorkspaceUndoStatus;
  reason?: string;
  target?: string;
}

/**
 * Classify one entry against the live workspace right now.
 *
 * - `applicable`: a write/edit whose live content still equals the recorded
 *   post-image; undo restores the recorded pre-image.
 * - `created`: the run created the file and it is still exactly that content;
 *   undo deletes it.
 * - `deleted`: the run deleted the file and it is still absent; undo restores it.
 * - `changed-since`: the live content no longer equals the recorded
 *   post-image (or the file was re-created/moved); refused per file.
 * - `skipped`: the capture itself is incomplete (bounds, budget, malformed
 *   entry, duplicate, net no-op); there is nothing honest to apply.
 * - `missing`: undo would apply, but the stored pre-image bytes are absent or
 *   corrupt; refused per file.
 */
function classifyEntry(opened: OpenedUndoRecord, entry: WorkspaceUndoEntry): Classification {
  if (entry.skipped !== undefined) return { status: "skipped", reason: entry.skipped };
  const resolved = resolveEntryTarget(opened.workspace_root, entry.path);
  if (!resolved.ok) return { status: "skipped", reason: resolved.reason };
  const target = resolved.target;
  const live = inspectLiveFile(target);
  if (!live.ok) return { status: "changed-since", reason: live.reason, target };

  if (entry.post.exists) {
    if (!live.exists) {
      return {
        status: "changed-since",
        reason: "the recorded file is gone (removed or moved after the run)",
        target,
      };
    }
    if (!live.isFile) {
      return { status: "changed-since", reason: "the path is no longer a regular file", target };
    }
    if (typeof entry.post.sha256 !== "string" || !SHA256_PATTERN.test(entry.post.sha256)) {
      return { status: "skipped", reason: "recorded post-image has no valid sha256", target };
    }
    if (live.sha256 !== entry.post.sha256) {
      return {
        status: "changed-since",
        reason: "file content no longer matches the recorded post-image",
        target,
      };
    }
    if (!entry.pre.exists) return { status: "created", target };
    if (typeof entry.pre.sha256 !== "string" || !SHA256_PATTERN.test(entry.pre.sha256)) {
      return { status: "skipped", reason: "recorded pre-image has no valid sha256", target };
    }
    const blob = inspectStoredImage(opened.store_root, entry.pre);
    if (!blob.ok) return { status: "missing", reason: blob.reason, target };
    return { status: "applicable", target };
  }

  // The run's last action on the file was a delete (or it left the file absent).
  if (live.exists) {
    return {
      status: "changed-since",
      reason: "the deleted file was re-created or changed after the run",
      target,
    };
  }
  if (!entry.pre.exists) {
    return {
      status: "skipped",
      reason: "the run left no net change to this file (absent before and after)",
      target,
    };
  }
  if (typeof entry.pre.sha256 !== "string" || !SHA256_PATTERN.test(entry.pre.sha256)) {
    return { status: "skipped", reason: "recorded pre-image has no valid sha256", target };
  }
  const blob = inspectStoredImage(opened.store_root, entry.pre);
  if (!blob.ok) return { status: "missing", reason: blob.reason, target };
  return { status: "deleted", target };
}

/** Last record index per path, so a corrupt duplicate can be reported honestly. */
function lastIndexByPath(record: WorkspaceUndoRecord): Map<string, number> {
  const last = new Map<string, number>();
  record.entries.forEach((entry, index) => last.set(entry.path, index));
  return last;
}

// ---------------------------------------------------------------------------
// preview
// ---------------------------------------------------------------------------

/**
 * Classify every recorded file of one run against the LIVE workspace without
 * changing anything. Throws {@link WorkspaceUndoError} when the record itself
 * cannot be used (unknown run, corrupt/oversized record, invalid run id, or a
 * workspace-root mismatch) — a whole-store problem must never be papered over
 * with per-file statuses.
 */
export function previewUndo(
  storeRoot: string,
  runId: string,
  workspaceRoot: string,
): WorkspaceUndoPreview {
  const opened = openUndoRecord(storeRoot, runId, workspaceRoot);
  const last = lastIndexByPath(opened.record);
  const counts: WorkspaceUndoPreview["counts"] = {
    applicable: 0,
    created: 0,
    deleted: 0,
    changed_since: 0,
    skipped: 0,
    missing: 0,
    total: opened.record.entries.length,
  };
  const entries = opened.record.entries.map((entry, index): WorkspaceUndoPreviewEntry => {
    if (entry.path !== "" && last.get(entry.path) !== index) {
      return {
        path: entry.path,
        action: entry.action,
        status: "skipped",
        reason: "duplicate record entry for this path; a later entry supersedes it",
        reversible: false,
      };
    }
    const classified = classifyEntry(opened, entry);
    switch (classified.status) {
      case "applicable":
        counts.applicable += 1;
        break;
      case "created":
        counts.created += 1;
        break;
      case "deleted":
        counts.deleted += 1;
        break;
      case "changed-since":
        counts.changed_since += 1;
        break;
      case "skipped":
        counts.skipped += 1;
        break;
      case "missing":
        counts.missing += 1;
        break;
    }
    const row: WorkspaceUndoPreviewEntry = {
      path: entry.path,
      action: entry.action,
      status: classified.status,
      reversible:
        classified.status === "applicable" ||
        classified.status === "created" ||
        classified.status === "deleted",
    };
    if (classified.reason !== undefined) row.reason = classified.reason;
    return row;
  });
  return {
    run_id: runId,
    workspace_root: opened.workspace_root,
    created_at: opened.record.created_at,
    entries,
    counts,
    ...(opened.record.omitted !== undefined ? { omitted: opened.record.omitted } : {}),
  };
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

/**
 * Undo one run's workspace mutations.
 *
 * Applies `applicable` (restore pre-image), `created` (delete), and `deleted`
 * (restore pre-image) entries. `changed-since`, `skipped`, and `missing`
 * entries are refused and counted; a per-file IO failure is `failed` and never
 * stops the rest. Each entry is re-classified against the live workspace
 * immediately before it is touched, so a file changed after preview is still
 * refused. The record is left in place: `discardUndo` is the explicit step.
 */
export function applyUndo(
  storeRoot: string,
  runId: string,
  workspaceRoot: string,
): WorkspaceUndoApplyResult {
  const opened = openUndoRecord(storeRoot, runId, workspaceRoot);
  const last = lastIndexByPath(opened.record);
  const result: WorkspaceUndoApplyResult = {
    run_id: runId,
    workspace_root: opened.workspace_root,
    applied: 0,
    refused: 0,
    failed: 0,
    entries: [],
  };

  opened.record.entries.forEach((entry, index) => {
    const row: WorkspaceUndoApplyEntry = {
      path: entry.path,
      action: entry.action,
      status: "refused",
      preview_status: "skipped",
    };
    if (entry.path !== "" && last.get(entry.path) !== index) {
      row.preview_status = "skipped";
      row.reason = "duplicate record entry for this path; a later entry supersedes it";
    } else {
      const classified = classifyEntry(opened, entry);
      row.preview_status = classified.status;
      if (classified.status === "applicable" || classified.status === "deleted") {
        try {
          const bytes = readBlobVerified(opened.store_root, entry.pre);
          writeAtomic(classified.target!, bytes);
          Object.assign(row, applyModeAttributes(classified.target!, entry.pre));
          row.status = "applied";
        } catch (exc) {
          row.status = "failed";
          row.reason = `could not restore the file: ${message(exc)}`;
        }
      } else if (classified.status === "created") {
        try {
          fs.unlinkSync(classified.target!);
          row.status = "applied";
        } catch (exc) {
          const code = (exc as NodeJS.ErrnoException).code;
          if (code === "ENOENT" || code === "ENOTDIR") {
            row.status = "applied";
            row.reason = "the file was already absent";
          } else {
            row.status = "failed";
            row.reason = `could not delete the file: ${message(exc)}`;
          }
        }
      } else {
        row.status = "refused";
        row.reason = classified.reason ?? classified.status;
      }
    }
    if (row.status === "applied") result.applied += 1;
    else if (row.status === "refused") result.refused += 1;
    else result.failed += 1;
    result.entries.push(row);
  });

  if (opened.record.omitted !== undefined) result.omitted = opened.record.omitted;
  return result;
}

/**
 * Drop one run's undo record. The record is what makes a run undoable; the
 * content-addressed blobs are shared store state, so this function leaves them
 * in place. Call {@link collectOrphanBlobs} after the last reference is gone
 * (the HTTP DELETE route and `sessions undo --discard` both do).
 */
export function discardUndo(storeRoot: string, runId: string): boolean {
  const store = assertStoreRoot(storeRoot);
  assertRunId(runId);
  try {
    fs.unlinkSync(undoRecordPath(store, runId));
    return true;
  } catch (exc) {
    const code = (exc as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw new WorkspaceUndoError(
      "io_error",
      `cannot discard undo record for run ${runId}: ${message(exc)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// retention, record listing and orphan blob collection
// ---------------------------------------------------------------------------

/** One record file as the retention/listing pass sees it (metadata only). */
export interface UndoRecordSummary {
  run_id: string;
  record_path: string;
  session?: string;
  created_at: string;
  mtime_ms: number;
}

interface ScannedUndoRecord {
  run_id: string;
  record_path: string;
  record: WorkspaceUndoRecord | null;
  mtime_ms: number;
}

function pushBoundedDiagnostic(list: string[], line: string): void {
  if (list.length < MAX_UNDO_DIAGNOSTICS) list.push(line.slice(0, 500));
}

function recordRunId(fileName: string): string | null {
  if (!fileName.endsWith(".json")) return null;
  const runId = fileName.slice(0, -".json".length);
  return RUN_ID_PATTERN.test(runId) ? runId : null;
}

function recordCreatedMs(record: ScannedUndoRecord): number | null {
  if (record.record !== null && record.record.created_at !== "") {
    const parsed = Date.parse(record.record.created_at);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return Number.isFinite(record.mtime_ms) ? record.mtime_ms : null;
}

/**
 * Read every record file once, bounded and fail-soft. A corrupt/oversized
 * record is returned with `record: null` (and one diagnostic) so retention can
 * refuse to delete blobs it cannot prove unreferenced.
 */
function scanUndoStore(
  storeRoot: string,
  diagnostics: string[],
): { records: ScannedUndoRecord[]; truncated: boolean } {
  const runsDir = path.join(storeRoot, "runs");
  let names: string[];
  try {
    names = fs.readdirSync(runsDir).sort();
  } catch (exc) {
    const code = (exc as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      pushBoundedDiagnostic(diagnostics, `cannot read undo record directory: ${message(exc)}`);
    } else {
      // A missing runs dir is normal (empty store); a store ROOT that is a
      // regular file/unreadable is not — report it once instead of pretending.
      // POSIX reports ENOTDIR for `<file>/runs`; Windows often reports ENOENT,
      // so both codes take this same root check.
      try {
        if (!fs.statSync(storeRoot).isDirectory()) {
          pushBoundedDiagnostic(diagnostics, `undo store root is not a directory: ${storeRoot}`);
        }
      } catch {
        // genuinely absent: an empty store, nothing to report
      }
    }
    return { records: [], truncated: false };
  }
  const candidates: string[] = [];
  for (const name of names) {
    const runId = recordRunId(name);
    if (runId !== null) candidates.push(runId);
  }
  const truncated = candidates.length > MAX_UNDO_GC_RECORDS;
  const records: ScannedUndoRecord[] = [];
  for (const runId of candidates.slice(0, MAX_UNDO_GC_RECORDS)) {
    const recordPath = path.join(runsDir, `${runId}.json`);
    let mtimeMs = 0;
    let record: WorkspaceUndoRecord | null = null;
    try {
      const stat = fs.statSync(recordPath);
      mtimeMs = stat.mtimeMs;
      if (!stat.isFile()) {
        pushBoundedDiagnostic(diagnostics, `undo record ${runId} is not a file`);
      } else if (stat.size > MAX_UNDO_RECORD_BYTES) {
        pushBoundedDiagnostic(diagnostics, `undo record ${runId} is oversized; left untouched`);
      } else {
        record = parseUndoRecord(fs.readFileSync(recordPath, "utf-8"), runId);
      }
    } catch (exc) {
      const code = (exc as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        pushBoundedDiagnostic(diagnostics, `cannot read undo record ${runId}: ${message(exc)}`);
      }
    }
    records.push({ run_id: runId, record_path: recordPath, record, mtime_ms: mtimeMs });
  }
  // Newest first; a record with no usable timestamp falls back to its mtime.
  records.sort((a, b) => (recordCreatedMs(b) ?? 0) - (recordCreatedMs(a) ?? 0));
  return { records, truncated };
}

/**
 * List every undo record in a store, newest first (metadata only, bounded,
 * fail-soft: a corrupt record is simply not listed). Used by the CLI to pick
 * the newest record of a session and by retention.
 */
export function listUndoRecords(storeRoot: string): UndoRecordSummary[] {
  const store = assertStoreRoot(storeRoot);
  const diagnostics: string[] = [];
  return scanUndoStore(store, diagnostics).records
    .filter((entry) => entry.record !== null)
    .map((entry) => ({
      run_id: entry.run_id,
      record_path: entry.record_path,
      ...(entry.record?.session !== undefined ? { session: entry.record.session } : {}),
      created_at: entry.record?.created_at ?? "",
      mtime_ms: entry.mtime_ms,
    }));
}

/** Every sha256 referenced by one block of records (pre/post images). */
function referencedBlobNames(records: readonly ScannedUndoRecord[]): Set<string> {
  const referenced = new Set<string>();
  for (const entry of records) {
    if (entry.record === null) continue;
    for (const file of entry.record.entries) {
      for (const image of [file.pre, file.post]) {
        if (typeof image.sha256 === "string" && SHA256_PATTERN.test(image.sha256)) {
          referenced.add(image.sha256);
        }
      }
    }
  }
  return referenced;
}

/**
 * Delete blob files no given record references. Bounded (never scans more than
 * {@link MAX_UNDO_GC_BLOBS} files), atomic per file and fail-soft; a record
 * that could not be parsed refuses the whole pass so a referenced byte can
 * never be deleted.
 */
function collectBlobsForRecords(
  storeRoot: string,
  records: readonly ScannedUndoRecord[],
  diagnostics: string[],
): { removed: string[]; skipped?: string } {
  if (records.some((entry) => entry.record === null)) {
    return { removed: [], skipped: "an undo record could not be parsed; blob collection skipped" };
  }
  const referenced = referencedBlobNames(records);
  const blobsDir = path.join(storeRoot, "blobs");
  let dirs: fs.Dirent[];
  try {
    dirs = fs.readdirSync(blobsDir, { withFileTypes: true });
  } catch (exc) {
    const code = (exc as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      pushBoundedDiagnostic(diagnostics, `cannot read the blob directory: ${message(exc)}`);
      return { removed: [], skipped: "the blob directory is unreadable" };
    }
    return { removed: [] };
  }
  const removed: string[] = [];
  let scanned = 0;
  for (const dirent of dirs) {
    if (!dirent.isDirectory()) continue;
    const dir = path.join(blobsDir, dirent.name);
    let files: fs.Dirent[];
    try {
      files = fs.readdirSync(dir, { withFileTypes: true });
    } catch (exc) {
      pushBoundedDiagnostic(diagnostics, `cannot read blob directory ${dirent.name}: ${message(exc)}`);
      continue;
    }
    for (const file of files) {
      if (!file.isFile()) continue;
      scanned += 1;
      if (scanned > MAX_UNDO_GC_BLOBS) {
        pushBoundedDiagnostic(
          diagnostics,
          `blob scan capped at ${MAX_UNDO_GC_BLOBS} files; remaining orphans were left in place`,
        );
        return { removed, skipped: "blob scan capped" };
      }
      if (!SHA256_PATTERN.test(file.name) || referenced.has(file.name)) continue;
      try {
        fs.unlinkSync(path.join(dir, file.name));
        removed.push(file.name);
      } catch (exc) {
        pushBoundedDiagnostic(diagnostics, `cannot remove unreferenced blob ${file.name}: ${message(exc)}`);
      }
    }
    try {
      // Remove the now-empty two-character shard; a non-empty one stays.
      fs.rmdirSync(dir);
    } catch {
      // not empty (a shared/leftover blob) or already gone — both fine
    }
  }
  return { removed };
}

/**
 * Collect content-addressed blobs no retained record references. Never throws:
 * store IO problems come back as diagnostics with nothing (or only proven
 * orphans) removed, and an unreadable/corrupt record refuses the pass.
 */
export function collectOrphanBlobs(storeRoot: string): UndoBlobGcResult {
  const result: UndoBlobGcResult = { removed: [], diagnostics: [] };
  let store: string;
  try {
    store = assertStoreRoot(storeRoot);
  } catch (exc) {
    pushBoundedDiagnostic(result.diagnostics, message(exc));
    result.skipped = "invalid undo store root";
    return result;
  }
  const scanned = scanUndoStore(store, result.diagnostics);
  if (scanned.truncated) {
    result.skipped = `record scan capped at ${MAX_UNDO_GC_RECORDS} files`;
    return result;
  }
  const gc = collectBlobsForRecords(store, scanned.records, result.diagnostics);
  result.removed = gc.removed;
  if (gc.skipped !== undefined) result.skipped = gc.skipped;
  return result;
}

/**
 * One bounded, explicit retention pass: keep the newest N records per session
 * (default {@link DEFAULT_UNDO_MAX_RECORDS_PER_SESSION}), delete records older
 * than the max age (default {@link DEFAULT_UNDO_MAX_AGE_DAYS} days, 0 disables),
 * never touch a record whose run id is active, then collect unreferenced blobs.
 * Never throws; every failure is one bounded diagnostic.
 */
export function collectUndoStore(
  storeRoot: string,
  options: UndoRetentionOptions = {},
): UndoRetentionResult {
  const result: UndoRetentionResult = {
    records_scanned: 0,
    records_kept: 0,
    records_removed: [],
    blobs_removed: [],
    diagnostics: [],
  };
  let store: string;
  try {
    store = assertStoreRoot(storeRoot);
  } catch (exc) {
    pushBoundedDiagnostic(result.diagnostics, message(exc));
    return result;
  }
  const scanned = scanUndoStore(store, result.diagnostics);
  result.records_scanned = scanned.records.length;
  const active = new Set<string>();
  for (const runId of options.activeRuns ?? []) {
    if (typeof runId === "string" && runId.length > 0) active.add(runId);
  }
  const maxPerSession = normalizeRetentionCount(
    options.maxRecordsPerSession,
    DEFAULT_UNDO_MAX_RECORDS_PER_SESSION,
  );
  const maxAgeDays = normalizeRetentionAge(options.maxAgeDays, DEFAULT_UNDO_MAX_AGE_DAYS);
  const rawNow = options.now ?? Date.now();
  const nowMs = rawNow instanceof Date ? rawNow.getTime() : rawNow;
  const cutoff = maxAgeDays > 0 ? nowMs - maxAgeDays * 24 * 60 * 60 * 1000 : null;

  const removal = new Set<string>();
  // `scanned.records` is newest first, so one pass per session group keeps the
  // newest N and marks the rest.
  const bySession = new Map<string, ScannedUndoRecord[]>();
  for (const entry of scanned.records) {
    const key = entry.record?.session ?? "";
    const group = bySession.get(key);
    if (group === undefined) bySession.set(key, [entry]);
    else group.push(entry);
  }
  for (const group of bySession.values()) {
    group.forEach((entry, index) => {
      if (index >= maxPerSession) removal.add(entry.run_id);
    });
  }
  if (cutoff !== null) {
    for (const entry of scanned.records) {
      const created = recordCreatedMs(entry);
      if (created !== null && created < cutoff) removal.add(entry.run_id);
    }
  }
  for (const runId of active) removal.delete(runId);

  let removedCount = 0;
  const deleted = new Set<string>();
  for (const entry of scanned.records) {
    if (!removal.has(entry.run_id)) continue;
    try {
      options.beforeUnlink?.(entry.record_path, entry.run_id);
      fs.unlinkSync(entry.record_path);
      removedCount += 1;
      deleted.add(entry.run_id);
      result.records_removed.push(entry.run_id);
    } catch (exc) {
      const code = (exc as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        removedCount += 1;
        deleted.add(entry.run_id);
        result.records_removed.push(entry.run_id);
      } else {
        pushBoundedDiagnostic(
          result.diagnostics,
          `cannot remove undo record ${entry.run_id}: ${message(exc)}`,
        );
      }
    }
  }
  result.records_kept = Math.max(0, scanned.records.length - removedCount);

  if (scanned.truncated) {
    pushBoundedDiagnostic(
      result.diagnostics,
      `record scan capped at ${MAX_UNDO_GC_RECORDS} files; blob collection skipped`,
    );
  } else if (options.collectBlobs !== false) {
    // Only records whose file actually disappeared are unreferenced. A record
    // whose unlink failed still owns its blobs; collecting them would leave a
    // listed but permanently un-undoable run (missing pre-images).
    const kept = scanned.records.filter((entry) => !deleted.has(entry.run_id));
    const gc = collectBlobsForRecords(store, kept, result.diagnostics);
    result.blobs_removed = gc.removed;
    if (gc.skipped !== undefined) {
      pushBoundedDiagnostic(result.diagnostics, gc.skipped);
    }
  }
  return result;
}
