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
   * Finish the capture (the run's `finally`): idempotent, never throws, stops
   * accepting further mutation records and makes one final persist attempt so
   * a record whose last write failed is salvaged. No record is written when the
   * run mutated nothing.
   */
  close(): void;
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
  private storedBytes = 0;
  private omitted = 0;
  private wroteRecord = false;
  private closed = false;

  constructor(storeRoot: string, runId: string, workspaceRoot: string, session?: string) {
    this.run_id = runId;
    this.store_root = storeRoot;
    this.workspace_root = workspaceRoot;
    if (session !== undefined) this.session = session;
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

  /**
   * Finish the capture: idempotent, never throws. One final persist salvages a
   * record whose per-mutation write failed; further mutation records are
   * ignored (the run is over, nothing may change the undo state afterwards).
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.entries.length === 0) return;
    try {
      this.persist();
    } catch (exc) {
      this.diagnostic(`undo capture close: final record write failed: ${message(exc)}`);
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
      return {
        image: { exists: true, size },
        newBytes: 0,
        skipped: `image is ${size} bytes; the capture limit is ${MAX_UNDO_FILE_BYTES} bytes`,
      };
    }
    const hash = sha256Hex(content);
    return {
      image: { exists: true, sha256: hash, size },
      content,
      hash,
      newBytes: blobExists(this.store_root, hash) ? 0 : size,
    };
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
  return image;
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
  options: { session?: string } = {},
): WorkspaceUndoCapture {
  const store = assertStoreRoot(storeRoot);
  assertRunId(runId);
  const workspace = resolveWorkspaceRoot(workspaceRoot);
  const rawSession = options.session;
  const session =
    typeof rawSession === "string" && rawSession.trim() !== "" ? rawSession.trim() : undefined;
  return new UndoCapture(store, runId, workspace, session);
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
 * Drop one run's undo record. Blobs are content-addressed and shared, so they
 * are intentionally left in place (the store's garbage collection is a later
 * phase); the record is what makes a run undoable.
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
