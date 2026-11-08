/**
 * Run-scoped workspace edit undo (`src/workspacehistory.ts` + the optional
 * `src/workspace.ts` mutation-capture seam).
 *
 * Covered here: capture of write/edit/delete (including exact binary bytes),
 * the versioned record + content-addressed blob layout, preview classification
 * against the live workspace, apply round-trips, per-file refusal of
 * changed-since files, capture bounds (2 MiB per side, 64 entries, 8 MiB per
 * run), blob dedupe, traversal/absolute-path refusal, workspace-root mismatch,
 * fail-soft capture failures, and the default (no recorder) contract.
 *
 * Design provenance: opencode `snapshot.ts` / `session/revert.ts` (MIT) for the
 * content-addressed capture + per-file restore model; no upstream code copied.
 *
 * Run with: node tests/run-all.ts (or node --test tests/)
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { Decision, PermissionManager, StaticBroker } from "../src/permissions.ts";
import {
  MAX_MUTATION_CAPTURE_BYTES,
  Workspace,
  type WorkspaceMutationRecorder,
} from "../src/workspace.ts";
import {
  MAX_UNDO_ENTRIES,
  MAX_UNDO_FILE_BYTES,
  MAX_UNDO_RECORD_BYTES,
  MAX_UNDO_STORE_BYTES,
  WORKSPACE_UNDO_VERSION,
  WorkspaceUndoError,
  applyUndo,
  beginUndoCapture,
  collectOrphanBlobs,
  collectUndoStore,
  discardUndo,
  listUndoRecords,
  loadUndoRecord,
  previewUndo,
  type WorkspaceUndoCapture,
  type WorkspaceUndoErrorCode,
  type WorkspaceUndoPreview,
  type WorkspaceUndoRecord,
} from "../src/workspacehistory.ts";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const allow = (): PermissionManager =>
  new PermissionManager(null, new StaticBroker(Decision.ALLOW));

interface Fixture {
  base: string;
  root: string;
  store: string;
  cleanup(): void;
}

function fixture(prefix = "tb-undo-"): Fixture {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const root = path.join(base, "ws");
  const store = path.join(base, "undo");
  fs.mkdirSync(root);
  return {
    base,
    root,
    store,
    cleanup(): void {
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}

interface RunFixture extends Fixture {
  runId: string;
  capture: WorkspaceUndoCapture;
  diagnostics: string[];
  ws: Workspace;
}

function runFixture(prefix = "tb-undo-", runId = "run-1"): RunFixture {
  const fx = fixture(prefix);
  const capture = beginUndoCapture(fx.store, runId, fx.root);
  const diagnostics: string[] = [];
  const ws = new Workspace(fx.root, allow(), null, {
    mutationRecorder: capture.recorder,
    onCaptureDiagnostic: (line) => diagnostics.push(line),
  });
  return { ...fx, runId, capture, diagnostics, ws };
}

function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

interface RawRecord {
  version: number;
  workspace_root: string;
  session?: string;
  created_at: string;
  entries: Array<{
    path: string;
    action: string;
    pre: { exists: boolean; sha256?: string; size?: number; mode?: number };
    post: { exists: boolean; sha256?: string; size?: number; mode?: number };
    skipped?: string;
  }>;
  omitted?: { entries: number; reason: string };
}

function readStoredRecord(store: string, runId: string): RawRecord {
  const file = path.join(store, "runs", `${runId}.json`);
  return JSON.parse(fs.readFileSync(file, "utf-8")) as RawRecord;
}

function writeStoredRecord(store: string, runId: string, record: unknown): void {
  fs.mkdirSync(path.join(store, "runs"), { recursive: true });
  fs.writeFileSync(path.join(store, "runs", `${runId}.json`), JSON.stringify(record), "utf-8");
}

/** Assert a WorkspaceUndoError with an exact machine code, and return it. */
function undoErrorCode(exc: unknown): WorkspaceUndoErrorCode | null {
  return exc instanceof WorkspaceUndoError ? exc.code : null;
}

/** Run `fn`, returning the WorkspaceUndoError code when it throws, else null. */
function throwsCode(fn: () => unknown): WorkspaceUndoErrorCode | null {
  try {
    fn();
    return null;
  } catch (exc) {
    return undoErrorCode(exc);
  }
}

function blobPath(store: string, hash: string): string {
  return path.join(store, "blobs", hash.slice(0, 2), hash);
}

/** Write one content-addressed blob by hand and return its sha256 name. */
function writeBlobFile(store: string, content: string): string {
  const hash = sha256(content);
  const file = blobPath(store, hash);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf-8");
  return hash;
}

/** A minimal parseable record: one post-image entry when `blob` is set. */
function syntheticRecord(options: {
  store: string;
  workspaceRoot: string;
  createdAt: string;
  session?: string;
  blob?: string;
  preBlob?: string;
}): RawRecord {
  const image = (hash: string): { exists: boolean; sha256: string; size: number } => ({
    exists: true,
    sha256: hash,
    size: fs.statSync(blobPath(options.store, hash)).size,
  });
  return {
    version: WORKSPACE_UNDO_VERSION,
    workspace_root: options.workspaceRoot,
    ...(options.session !== undefined ? { session: options.session } : {}),
    created_at: options.createdAt,
    entries: [
      {
        path: "file.txt",
        action: options.preBlob === undefined ? "write" : "edit",
        pre: options.preBlob === undefined ? { exists: false } : image(options.preBlob),
        post: options.blob === undefined ? { exists: false } : image(options.blob),
      },
    ],
  };
}

/** Every regular file under `dir` (recursive), sorted. */
function filesUnder(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const dirent of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, dirent.name);
      if (dirent.isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(dir);
  return out.sort();
}

function statuses(preview: WorkspaceUndoPreview): Record<string, string> {
  return Object.fromEntries(preview.entries.map((entry) => [entry.path, entry.status]));
}

const LARGE = MAX_UNDO_FILE_BYTES + 1;

// ---------------------------------------------------------------------------
// capture + round-trip
// ---------------------------------------------------------------------------

test("write/edit/delete are captured and undo restores the pre-run workspace", async () => {
  const fx = runFixture();
  try {
    fs.writeFileSync(path.join(fx.root, "existing.txt"), "original\n", "utf-8");
    fs.writeFileSync(path.join(fx.root, "doomed.txt"), "bye\n", "utf-8");
    fs.writeFileSync(path.join(fx.root, "untouched.txt"), "not part of undo\n", "utf-8");

    assert.equal((await fx.ws.write_file("created.txt", "new\n")).status, "ok");
    assert.equal((await fx.ws.edit_file("existing.txt", "original", "changed")).status, "ok");
    assert.equal((await fx.ws.delete_file("doomed.txt")).status, "ok");

    const preview = previewUndo(fx.store, fx.runId, fx.root);
    assert.deepEqual(statuses(preview), {
      "created.txt": "created",
      "existing.txt": "applicable",
      "doomed.txt": "deleted",
    });
    assert.deepEqual(preview.counts, {
      applicable: 1,
      created: 1,
      deleted: 1,
      changed_since: 0,
      skipped: 0,
      missing: 0,
      total: 3,
    });
    assert.equal(preview.workspace_root, fs.realpathSync(fx.root));

    const result = applyUndo(fx.store, fx.runId, fx.root);
    assert.equal(result.applied, 3);
    assert.equal(result.refused, 0);
    assert.equal(result.failed, 0);
    assert.equal(fs.existsSync(path.join(fx.root, "created.txt")), false);
    assert.equal(fs.readFileSync(path.join(fx.root, "existing.txt"), "utf-8"), "original\n");
    assert.equal(fs.readFileSync(path.join(fx.root, "doomed.txt"), "utf-8"), "bye\n");
    // Untracked files are never touched.
    assert.equal(fs.readFileSync(path.join(fx.root, "untouched.txt"), "utf-8"), "not part of undo\n");

    // A second apply refuses everything: the live files no longer match the
    // recorded post-images, so undo never replays a restore twice.
    const again = applyUndo(fx.store, fx.runId, fx.root);
    assert.equal(again.applied, 0);
    assert.equal(again.refused, 3);
    for (const entry of again.entries) assert.equal(entry.preview_status, "changed-since");
  } finally {
    fx.cleanup();
  }
});

test("the record is versioned metadata; blobs are content-addressed and exact", async () => {
  const fx = runFixture();
  try {
    const result = await fx.ws.write_file("sub/dir/hello.txt", "payload-marker\n");
    assert.equal(result.status, "ok");

    const record = readStoredRecord(fx.store, fx.runId);
    assert.equal(record.version, WORKSPACE_UNDO_VERSION);
    assert.equal(record.workspace_root, fs.realpathSync(fx.root));
    assert.ok(!Number.isNaN(Date.parse(record.created_at)));
    assert.equal(record.entries.length, 1);
    const entry = record.entries[0];
    assert.equal(entry.path, "sub/dir/hello.txt");
    assert.equal(entry.action, "write");
    assert.deepEqual(entry.pre, { exists: false });
    assert.ok(entry.post.exists);
    assert.equal(entry.post.sha256, sha256("payload-marker\n"));
    assert.equal(entry.post.size, Buffer.byteLength("payload-marker\n"));
    assert.equal(entry.skipped, undefined);

    // Blob layout <root>/blobs/<xx>/<sha256>, exact bytes; no content in the record.
    const blob = blobPath(fx.store, entry.post.sha256!);
    assert.equal(blob, path.join(fx.store, "blobs", entry.post.sha256!.slice(0, 2), entry.post.sha256!));
    assert.equal(fs.readFileSync(blob, "utf-8"), "payload-marker\n");
    assert.equal(JSON.stringify(record).includes("payload-marker"), false);

    // The record tree is exactly one record + one blob.
    assert.deepEqual(filesUnder(path.join(fx.store, "runs")), [path.join(fx.store, "runs", `${fx.runId}.json`)]);
    assert.deepEqual(filesUnder(path.join(fx.store, "blobs")), [blob]);
  } finally {
    fx.cleanup();
  }
});

test("the record can name its session; loadUndoRecord reads it without a workspace match", async () => {
  const fx = fixture();
  try {
    fs.writeFileSync(path.join(fx.root, "a.txt"), "before\n", "utf-8");
    const capture = beginUndoCapture(fx.store, "run-session", fx.root, { session: "chat" });
    const ws = new Workspace(fx.root, allow(), null, { mutationRecorder: capture.recorder });
    await ws.edit_file("a.txt", "before", "after");
    capture.close(); // idempotent: the record is already durable
    capture.close();

    const loaded = loadUndoRecord(fx.store, "run-session");
    assert.equal(loaded.version, WORKSPACE_UNDO_VERSION);
    assert.equal(loaded.session, "chat");
    assert.equal(loaded.workspace_root, fs.realpathSync(fx.root));
    assert.equal(loaded.entries.length, 1);
    assert.equal(loaded.entries[0].path, "a.txt");
    assert.equal(readStoredRecord(fx.store, "run-session").session, "chat");

    // A record written without the option has no session field and still loads
    // (the session-scoped route then skips its session check).
    const noSession: RawRecord = { ...readStoredRecord(fx.store, "run-session") };
    delete noSession.session;
    writeStoredRecord(fx.store, "run-no-session", noSession);
    assert.equal(loadUndoRecord(fx.store, "run-no-session").session, undefined);
  } finally {
    fx.cleanup();
  }
});

test("close() stops late mutations and salvages a record whose last write failed", async () => {
  const fx = fixture();
  try {
    const capture = beginUndoCapture(fx.store, "run-close", fx.root);
    const ws = new Workspace(fx.root, allow(), null, { mutationRecorder: capture.recorder });
    await ws.write_file("kept.txt", "kept\n");
    const recordFile = path.join(fx.store, "runs", "run-close.json");
    assert.equal(fs.existsSync(recordFile), true);

    // Simulate a lost final write: the record file disappears after the
    // capture; the close-time persist is the honest salvage attempt.
    fs.rmSync(recordFile);
    capture.close();
    assert.equal(fs.existsSync(recordFile), true);
    assert.equal(readStoredRecord(fx.store, "run-close").entries.length, 1);

    // After close the recorder accepts nothing more (the run is over).
    capture.recorder({
      action: "write",
      path: "late.txt",
      root: fs.realpathSync(fx.root),
      pre: { exists: false },
      post: { exists: false },
    });
    assert.equal(capture.entryCount, 1);
    assert.equal(readStoredRecord(fx.store, "run-close").entries.length, 1);
  } finally {
    fx.cleanup();
  }
});

test("whole-store refusals carry machine codes for the HTTP route mapping", async () => {
  const fx = runFixture();
  const other = fixture("tb-undo-codes-");
  try {
    await fx.ws.write_file("x.txt", "x\n");
    assert.equal(throwsCode(() => loadUndoRecord(fx.store, "never")), "unknown_record");
    assert.equal(throwsCode(() => loadUndoRecord(fx.store, "../escape")), "invalid_run_id");

    const record = readStoredRecord(fx.store, fx.runId) as unknown as Record<string, unknown>;
    writeStoredRecord(fx.store, "bad-version", { ...record, version: 99 });
    assert.equal(throwsCode(() => loadUndoRecord(fx.store, "bad-version")), "unsupported_version");

    fs.writeFileSync(path.join(fx.store, "runs", "bad-json.json"), "{not json", "utf-8");
    assert.equal(throwsCode(() => loadUndoRecord(fx.store, "bad-json")), "corrupt_record");

    fs.writeFileSync(
      path.join(fx.store, "runs", "too-big.json"),
      Buffer.alloc(MAX_UNDO_RECORD_BYTES + 1, 0x20),
    );
    assert.equal(throwsCode(() => loadUndoRecord(fx.store, "too-big")), "oversized_record");

    assert.equal(
      throwsCode(() => previewUndo(fx.store, fx.runId, other.root)),
      "workspace_mismatch",
    );
    assert.equal(
      throwsCode(() => previewUndo(fx.store, fx.runId, path.join(fx.base, "missing-root"))),
      "workspace_unavailable",
    );
  } finally {
    other.cleanup();
    fx.cleanup();
  }
});

test("binary content is preserved exactly through delete + undo", async () => {
  const fx = runFixture();
  try {
    // Includes NUL, invalid UTF-8, and every byte value; never text-normalized.
    const bytes = Buffer.from(Array.from({ length: 512 }, (_, i) => (i * 37 + 11) % 256));
    fs.writeFileSync(path.join(fx.root, "blob.bin"), bytes);

    assert.equal((await fx.ws.delete_file("blob.bin")).status, "ok");
    assert.equal(fs.existsSync(path.join(fx.root, "blob.bin")), false);
    assert.deepEqual(statuses(previewUndo(fx.store, fx.runId, fx.root)), { "blob.bin": "deleted" });

    const result = applyUndo(fx.store, fx.runId, fx.root);
    assert.equal(result.applied, 1);
    assert.deepEqual(fs.readFileSync(path.join(fx.root, "blob.bin")), bytes);
  } finally {
    fx.cleanup();
  }
});

test("a file created in a new directory is deleted by undo and the directory is left alone", async () => {
  const fx = runFixture();
  try {
    assert.equal((await fx.ws.write_file("nested/deep/new.txt", "fresh\n")).status, "ok");
    assert.equal(applyUndo(fx.store, fx.runId, fx.root).applied, 1);
    assert.equal(fs.existsSync(path.join(fx.root, "nested", "deep", "new.txt")), false);
    assert.equal(fs.existsSync(path.join(fx.root, "nested", "deep")), true);
  } finally {
    fx.cleanup();
  }
});

test("multiple mutations of one file collapse to one entry with the net effect", async () => {
  const fx = runFixture();
  try {
    fs.writeFileSync(path.join(fx.root, "multi.txt"), "v0\n", "utf-8");
    await fx.ws.write_file("multi.txt", "v1\n");
    await fx.ws.edit_file("multi.txt", "v1", "v2");

    const record = readStoredRecord(fx.store, fx.runId);
    const multi = record.entries.filter((entry) => entry.path === "multi.txt");
    assert.equal(multi.length, 1);
    assert.equal(multi[0].action, "edit");
    assert.equal(multi[0].pre.sha256, sha256("v0\n"));
    assert.equal(multi[0].post.sha256, sha256("v2\n"));
    assert.deepEqual(statuses(previewUndo(fx.store, fx.runId, fx.root)), { "multi.txt": "applicable" });
    assert.equal(applyUndo(fx.store, fx.runId, fx.root).applied, 1);
    assert.equal(fs.readFileSync(path.join(fx.root, "multi.txt"), "utf-8"), "v0\n");

    // Create then delete nets out: recorded honestly, but nothing to apply.
    await fx.ws.write_file("ephemeral.txt", "temp\n");
    await fx.ws.delete_file("ephemeral.txt");
    const preview = previewUndo(fx.store, fx.runId, fx.root);
    assert.equal(statuses(preview)["ephemeral.txt"], "skipped");
    assert.match(String(preview.entries.find((entry) => entry.path === "ephemeral.txt")?.reason), /no net change/);
    const result = applyUndo(fx.store, fx.runId, fx.root);
    assert.equal(result.applied, 0);
    // multi.txt is changed-since after the first apply; ephemeral is skipped.
    assert.equal(result.refused, 2);
  } finally {
    fx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// live classification
// ---------------------------------------------------------------------------

test("changed-since files are refused while the rest of the run still applies", async () => {
  const fx = runFixture();
  try {
    fs.writeFileSync(path.join(fx.root, "edited.txt"), "one\n", "utf-8");
    await fx.ws.edit_file("edited.txt", "one", "two");
    await fx.ws.write_file("written.txt", "run wrote this\n");

    // Simulate an operator/other agent editing the file after the run.
    fs.writeFileSync(path.join(fx.root, "edited.txt"), "external change\n", "utf-8");

    const preview = previewUndo(fx.store, fx.runId, fx.root);
    assert.equal(statuses(preview)["edited.txt"], "changed-since");
    assert.equal(statuses(preview)["written.txt"], "created");
    assert.equal(preview.counts.changed_since, 1);
    assert.equal(preview.counts.created, 1);

    const result = applyUndo(fx.store, fx.runId, fx.root);
    assert.equal(result.applied, 1);
    assert.equal(result.refused, 1);
    assert.equal(fs.readFileSync(path.join(fx.root, "edited.txt"), "utf-8"), "external change\n");
    assert.equal(fs.existsSync(path.join(fx.root, "written.txt")), false);
  } finally {
    fx.cleanup();
  }
});

test("apply re-checks the live file, so a change after preview is refused", async () => {
  const fx = runFixture();
  try {
    fs.writeFileSync(path.join(fx.root, "guard.txt"), "one\n", "utf-8");
    await fx.ws.edit_file("guard.txt", "one", "two");
    assert.equal(statuses(previewUndo(fx.store, fx.runId, fx.root))["guard.txt"], "applicable");

    fs.writeFileSync(path.join(fx.root, "guard.txt"), "sneaky\n", "utf-8");
    const result = applyUndo(fx.store, fx.runId, fx.root);
    assert.equal(result.applied, 0);
    assert.equal(result.refused, 1);
    assert.equal(result.entries[0].preview_status, "changed-since");
    assert.equal(fs.readFileSync(path.join(fx.root, "guard.txt"), "utf-8"), "sneaky\n");
  } finally {
    fx.cleanup();
  }
});

test("a deleted file that reappears is refused (changed-since)", async () => {
  const fx = runFixture();
  try {
    fs.writeFileSync(path.join(fx.root, "gone.txt"), "before\n", "utf-8");
    await fx.ws.delete_file("gone.txt");
    fs.writeFileSync(path.join(fx.root, "gone.txt"), "re-created\n", "utf-8");
    assert.equal(statuses(previewUndo(fx.store, fx.runId, fx.root))["gone.txt"], "changed-since");
    assert.equal(applyUndo(fx.store, fx.runId, fx.root).applied, 0);
    assert.equal(fs.readFileSync(path.join(fx.root, "gone.txt"), "utf-8"), "re-created\n");
  } finally {
    fx.cleanup();
  }
});

test("a corrupt stored pre-image is reported as missing and never written", async () => {
  const fx = runFixture();
  try {
    fs.writeFileSync(path.join(fx.root, "a.txt"), "original\n", "utf-8");
    fs.writeFileSync(path.join(fx.root, "b.txt"), "deleted later\n", "utf-8");
    await fx.ws.edit_file("a.txt", "original", "edited");
    await fx.ws.delete_file("b.txt");

    const record = readStoredRecord(fx.store, fx.runId);
    const preA = record.entries.find((entry) => entry.path === "a.txt")!.pre.sha256!;
    fs.writeFileSync(blobPath(fx.store, preA), "corrupted", "utf-8");

    const preview = previewUndo(fx.store, fx.runId, fx.root);
    assert.equal(statuses(preview)["a.txt"], "missing");
    assert.equal(statuses(preview)["b.txt"], "deleted");
    assert.match(String(preview.entries.find((entry) => entry.path === "a.txt")?.reason), /unavailable/);

    // The other file still applies; the corrupt one is refused, not guessed at.
    const result = applyUndo(fx.store, fx.runId, fx.root);
    assert.equal(result.applied, 1);
    assert.equal(result.refused, 1);
    assert.equal(fs.readFileSync(path.join(fx.root, "a.txt"), "utf-8"), "edited\n");
    assert.equal(fs.readFileSync(path.join(fx.root, "b.txt"), "utf-8"), "deleted later\n");
  } finally {
    fx.cleanup();
  }
});

test("preview is read-only", async () => {
  const fx = runFixture();
  try {
    fs.writeFileSync(path.join(fx.root, "steady.txt"), "before\n", "utf-8");
    await fx.ws.edit_file("steady.txt", "before", "after");
    const recordFile = path.join(fx.store, "runs", `${fx.runId}.json`);
    const recordBefore = fs.readFileSync(recordFile);
    const liveBefore = fs.readFileSync(path.join(fx.root, "steady.txt"));
    previewUndo(fx.store, fx.runId, fx.root);
    assert.deepEqual(fs.readFileSync(recordFile), recordBefore);
    assert.deepEqual(fs.readFileSync(path.join(fx.root, "steady.txt")), liveBefore);
  } finally {
    fx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// bounds
// ---------------------------------------------------------------------------

test("a pre-image over the capture limit is recorded as skipped and never restored", async () => {
  const fx = runFixture();
  try {
    fs.writeFileSync(path.join(fx.root, "big.bin"), Buffer.alloc(LARGE, 7));
    assert.equal((await fx.ws.delete_file("big.bin")).status, "ok");

    const record = readStoredRecord(fx.store, fx.runId);
    const entry = record.entries[0];
    assert.equal(entry.path, "big.bin");
    assert.ok(entry.skipped);
    assert.match(entry.skipped!, new RegExp(`${MAX_UNDO_FILE_BYTES}-byte capture limit`));
    assert.equal(entry.pre.sha256, undefined);

    const preview = previewUndo(fx.store, fx.runId, fx.root);
    assert.equal(statuses(preview)["big.bin"], "skipped");
    const result = applyUndo(fx.store, fx.runId, fx.root);
    assert.equal(result.applied, 0);
    assert.equal(result.refused, 1);
    // Honest: the file was deleted by the run and cannot be restored, so it stays gone.
    assert.equal(fs.existsSync(path.join(fx.root, "big.bin")), false);
  } finally {
    fx.cleanup();
  }
});

test("a post-image over the capture limit is recorded as skipped and never deleted", async () => {
  const fx = runFixture();
  try {
    assert.equal((await fx.ws.write_file("huge.txt", "x".repeat(LARGE))).status, "ok");
    const entry = readStoredRecord(fx.store, fx.runId).entries[0];
    assert.equal(entry.path, "huge.txt");
    assert.ok(entry.skipped);
    assert.equal(entry.post.sha256, undefined);
    assert.equal(statuses(previewUndo(fx.store, fx.runId, fx.root))["huge.txt"], "skipped");
    assert.equal(applyUndo(fx.store, fx.runId, fx.root).refused, 1);
    // Without a captured post-image the store cannot prove the file is still
    // the run's content, so it refuses to delete it.
    assert.equal(fs.existsSync(path.join(fx.root, "huge.txt")), true);
  } finally {
    fx.cleanup();
  }
});

test("the per-run entry cap is 64 and further mutations are counted, not dropped silently", async () => {
  const fx = runFixture();
  try {
    for (let i = 0; i < MAX_UNDO_ENTRIES + 1; i++) {
      assert.equal((await fx.ws.write_file(`file-${i}.txt`, `content ${i}\n`)).status, "ok");
    }
    assert.equal(fx.capture.entryCount, MAX_UNDO_ENTRIES);
    assert.equal(fx.capture.omittedCount, 1);
    assert.ok(fx.capture.diagnostics.some((line) => /entry cap/.test(line)));

    const record = readStoredRecord(fx.store, fx.runId);
    assert.equal(record.entries.length, MAX_UNDO_ENTRIES);
    assert.ok(record.omitted);
    assert.equal(record.omitted!.entries, 1);
    assert.match(record.omitted!.reason, /entry cap/);

    const preview = previewUndo(fx.store, fx.runId, fx.root);
    assert.ok(preview.omitted);
    assert.equal(preview.counts.total, MAX_UNDO_ENTRIES);
    assert.equal(preview.counts.created, MAX_UNDO_ENTRIES);
  } finally {
    fx.cleanup();
  }
});

test("the per-run byte budget skips later captures but keeps earlier undo available", async () => {
  const fx = runFixture();
  try {
    const chunk = 1024 * 1024;
    const written = Math.floor(MAX_UNDO_STORE_BYTES / chunk);
    for (let i = 0; i <= written; i++) {
      const content = `file ${i}:`.padEnd(chunk, String.fromCharCode(97 + (i % 26)));
      assert.equal((await fx.ws.write_file(`big-${i}.txt`, content)).status, "ok");
    }
    const record = readStoredRecord(fx.store, fx.runId);
    assert.equal(record.entries.length, written + 1);
    assert.equal(record.entries.filter((entry) => entry.skipped === undefined).length, written);
    const skipped = record.entries.find((entry) => entry.skipped !== undefined)!;
    assert.match(skipped.skipped!, new RegExp(`${MAX_UNDO_STORE_BYTES} bytes`));

    const storedBytes = filesUnder(path.join(fx.store, "blobs")).reduce(
      (total, file) => total + fs.statSync(file).size,
      0,
    );
    assert.ok(storedBytes <= MAX_UNDO_STORE_BYTES, `store holds ${storedBytes} bytes`);

    const result = applyUndo(fx.store, fx.runId, fx.root);
    assert.equal(result.applied, written);
    assert.equal(result.refused, 1);
  } finally {
    fx.cleanup();
  }
});

test("identical content is stored once (blob dedupe across files)", async () => {
  const fx = runFixture();
  try {
    await fx.ws.write_file("a.txt", "duplicate content\n");
    await fx.ws.write_file("b.txt", "duplicate content\n");
    await fx.ws.write_file("c.txt", "duplicate content\n");
    const blobs = filesUnder(path.join(fx.store, "blobs"));
    assert.equal(blobs.length, 1);
    assert.equal(fs.readFileSync(blobs[0], "utf-8"), "duplicate content\n");
    assert.equal(applyUndo(fx.store, fx.runId, fx.root).applied, 3);
  } finally {
    fx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// structural refusal
// ---------------------------------------------------------------------------

test("traversal and absolute record paths are refused per entry, never followed", async () => {
  const fx = fixture();
  try {
    const outside = path.join(fx.base, "outside.txt");
    fs.writeFileSync(outside, "safe\n", "utf-8");
    const post = { exists: true, sha256: sha256("pwned"), size: 5 };
    writeStoredRecord(fx.store, "evil-run", {
      version: WORKSPACE_UNDO_VERSION,
      workspace_root: fs.realpathSync(fx.root),
      created_at: new Date().toISOString(),
      entries: [
        { path: "../outside.txt", action: "write", pre: { exists: false }, post },
        { path: path.join(fx.root, "absolute.txt"), action: "write", pre: { exists: false }, post },
      ],
    });

    const preview = previewUndo(fx.store, "evil-run", fx.root);
    assert.equal(preview.entries[0].status, "skipped");
    assert.match(String(preview.entries[0].reason), /escapes the workspace/);
    assert.equal(preview.entries[1].status, "skipped");
    assert.match(String(preview.entries[1].reason), /absolute/);

    const result = applyUndo(fx.store, "evil-run", fx.root);
    assert.equal(result.applied, 0);
    assert.equal(result.refused, 2);
    assert.equal(fs.readFileSync(outside, "utf-8"), "safe\n");
    assert.equal(fs.existsSync(path.join(fx.root, "absolute.txt")), false);
  } finally {
    fx.cleanup();
  }
});

test("a record from another workspace root is refused as a whole", async () => {
  const fx = runFixture();
  const other = fixture("tb-undo-other-");
  try {
    await fx.ws.write_file("x.txt", "x\n");
    assert.throws(
      () => previewUndo(fx.store, fx.runId, other.root),
      (exc: unknown) =>
        exc instanceof WorkspaceUndoError && /belongs to workspace/.test((exc as Error).message),
    );
    assert.throws(
      () => applyUndo(fx.store, fx.runId, other.root),
      (exc: unknown) => exc instanceof WorkspaceUndoError,
    );
  } finally {
    other.cleanup();
    fx.cleanup();
  }
});

test("invalid run ids and missing records are refused as a whole", async () => {
  const fx = runFixture();
  try {
    await fx.ws.write_file("x.txt", "x\n");
    assert.throws(
      () => previewUndo(fx.store, "../escape", fx.root),
      (exc: unknown) =>
        exc instanceof WorkspaceUndoError && /invalid undo run id/.test((exc as Error).message),
    );
    assert.throws(
      () => previewUndo(fx.store, "never-ran", fx.root),
      (exc: unknown) =>
        exc instanceof WorkspaceUndoError && /no undo record/.test((exc as Error).message),
    );
  } finally {
    fx.cleanup();
  }
});

test("discardUndo removes the record; content-addressed blobs are left for sharing", async () => {
  const fx = runFixture();
  try {
    await fx.ws.write_file("kept.txt", "bytes\n");
    const blobs = filesUnder(path.join(fx.store, "blobs"));
    assert.equal(blobs.length, 1);
    assert.equal(discardUndo(fx.store, fx.runId), true);
    assert.equal(discardUndo(fx.store, fx.runId), false);
    assert.throws(() => previewUndo(fx.store, fx.runId, fx.root), WorkspaceUndoError);
    // The blob is shared store state, so discard keeps it (GC is a later phase).
    assert.deepEqual(filesUnder(path.join(fx.store, "blobs")), blobs);
  } finally {
    fx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// fail-soft capture
// ---------------------------------------------------------------------------

test(
  "an IO failure restoring one file is counted as failed and the rest still applies",
  { skip: process.platform !== "win32" ? "read-only file replace is POSIX-agnostic only on Windows" : false },
  async () => {
    const fx = runFixture();
    try {
      fs.writeFileSync(path.join(fx.root, "locked.txt"), "locked-before\n", "utf-8");
      fs.writeFileSync(path.join(fx.root, "free.txt"), "free-before\n", "utf-8");
      await fx.ws.edit_file("locked.txt", "locked-before", "locked-after");
      await fx.ws.edit_file("free.txt", "free-before", "free-after");

      // A read-only target makes the atomic temp+rename restore fail with EPERM
      // on Windows (rename over a read-only file is refused).
      fs.chmodSync(path.join(fx.root, "locked.txt"), 0o444);

      const result = applyUndo(fx.store, fx.runId, fx.root);
      assert.equal(result.applied, 1);
      assert.equal(result.failed, 1);
      assert.equal(result.refused, 0);
      const locked = result.entries.find((entry) => entry.path === "locked.txt")!;
      assert.equal(locked.status, "failed");
      assert.match(String(locked.reason), /could not restore/);
      assert.equal(fs.readFileSync(path.join(fx.root, "locked.txt"), "utf-8"), "locked-after\n");
      assert.equal(fs.readFileSync(path.join(fx.root, "free.txt"), "utf-8"), "free-before\n");
    } finally {
      const locked = path.join(fx.root, "locked.txt");
      if (fs.existsSync(locked)) fs.chmodSync(locked, 0o666);
      fx.cleanup();
    }
  },
);

test("a throwing recorder is contained: the tool still succeeds with one diagnostic", async () => {
  const fx = fixture();
  try {
    const diagnostics: string[] = [];
    const recorder: WorkspaceMutationRecorder = () => {
      throw new Error("recorder boom");
    };
    const ws = new Workspace(fx.root, allow(), null, {
      mutationRecorder: recorder,
      onCaptureDiagnostic: (line) => diagnostics.push(line),
    });

    const result = await ws.write_file("a.txt", "hi\n");
    assert.equal(result.status, "ok");
    assert.equal(fs.readFileSync(path.join(fx.root, "a.txt"), "utf-8"), "hi\n");
    assert.equal(diagnostics.length, 1);
    assert.match(diagnostics[0], /undo capture failed/);
    assert.match(diagnostics[0], /recorder boom/);
  } finally {
    fx.cleanup();
  }
});

test("an unwritable store is fail-soft: the tool succeeds, preview honestly has no record", async () => {
  const fx = fixture();
  try {
    // A regular file where the store's parent directory should be makes every
    // store write fail with ENOTDIR — a realistic disk/permission failure.
    const blocker = path.join(fx.base, "blocked");
    fs.writeFileSync(blocker, "not a directory", "utf-8");
    const capture = beginUndoCapture(path.join(blocker, "undo"), "run-blocked", fx.root);
    const ws = new Workspace(fx.root, allow(), null, { mutationRecorder: capture.recorder });

    const result = await ws.write_file("still-works.txt", "payload\n");
    assert.equal(result.status, "ok");
    assert.equal(fs.readFileSync(path.join(fx.root, "still-works.txt"), "utf-8"), "payload\n");
    assert.ok(capture.diagnostics.length >= 1);
    assert.match(capture.diagnostics[0], /undo capture failed/);
    assert.equal(capture.recordPath, null);
    assert.throws(() => previewUndo(path.join(blocker, "undo"), "run-blocked", fx.root), WorkspaceUndoError);
  } finally {
    fx.cleanup();
  }
});

test("denied and failed mutations record nothing", async () => {
  const fx = fixture();
  try {
    const denied = beginUndoCapture(fx.store, "run-denied", fx.root);
    const deniedWs = new Workspace(fx.root, new PermissionManager(), null, {
      mutationRecorder: denied.recorder,
    });
    assert.equal((await deniedWs.write_file("denied.txt", "x")).status, "denied");
    assert.equal(denied.entryCount, 0);
    assert.equal(denied.recordPath, null);

    const capture = beginUndoCapture(fx.store, "run-failed", fx.root);
    const ws = new Workspace(fx.root, allow(), null, { mutationRecorder: capture.recorder });
    assert.equal((await ws.edit_file("missing.txt", "a", "b")).status, "error");
    assert.equal((await ws.write_file("ambiguous.txt", "x\nx\n")).status, "ok");
    const before = capture.entryCount;
    assert.equal((await ws.edit_file("ambiguous.txt", "x", "y")).status, "error");
    assert.equal(capture.entryCount, before, "a failed mutation records nothing");
  } finally {
    fx.cleanup();
  }
});

test("without a recorder the workspace results are byte-identical", async () => {
  const plain = fixture("tb-undo-plain-");
  const captured = runFixture("tb-undo-cap-");
  try {
    const plainWs = new Workspace(plain.root, allow());
    const ops = async (ws: Workspace): Promise<string[]> => {
      const results = [
        await ws.write_file("new.txt", "hello\n"),
        await ws.edit_file("new.txt", "hello", "world"),
        await ws.write_file("same.txt", "unchanged\n"),
        await ws.delete_file("same.txt"),
      ];
      return results.map((result) => JSON.stringify(result));
    };

    const plainResults = await ops(plainWs);
    const capturedResults = await ops(captured.ws);
    assert.deepEqual(capturedResults, plainResults);
    for (const file of ["new.txt"]) {
      assert.deepEqual(
        fs.readFileSync(path.join(captured.root, file)),
        fs.readFileSync(path.join(plain.root, file)),
      );
    }
    assert.equal(fs.existsSync(path.join(plain.store)), false, "no store is created without a recorder");
    assert.equal(fs.existsSync(path.join(captured.store, "runs")), true);
  } finally {
    plain.cleanup();
    captured.cleanup();
  }
});

test("MAX_MUTATION_CAPTURE_BYTES and MAX_UNDO_FILE_BYTES agree", () => {
  // The seam's read bound and the store's accept bound are one policy: a file
  // the seam declines to read can never trip a different limit later.
  assert.equal(MAX_UNDO_FILE_BYTES, MAX_MUTATION_CAPTURE_BYTES);
});

// ---------------------------------------------------------------------------
// retention / garbage collection (wave 26)
// ---------------------------------------------------------------------------

test("collectUndoStore keeps the newest N records per session and collects orphan blobs", () => {
  const fx = fixture("tb-undo-retention-");
  try {
    const hashes: string[] = [];
    for (let i = 0; i < 8; i++) {
      const hash = writeBlobFile(fx.store, `blob-${i}\n`);
      hashes.push(hash);
      writeStoredRecord(
        fx.store,
        `run-${i}`,
        syntheticRecord({
          store: fx.store,
          workspaceRoot: fs.realpathSync(fx.root),
          session: "chat.jsonl",
          createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
          blob: hash,
        }),
      );
    }
    const otherHash = writeBlobFile(fx.store, "other session\n");
    writeStoredRecord(
      fx.store,
      "run-other",
      syntheticRecord({
        store: fx.store,
        workspaceRoot: fs.realpathSync(fx.root),
        session: "other.jsonl",
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 30)).toISOString(),
        blob: otherHash,
      }),
    );

    // Cap is per session: chat keeps 5..7, the other session's one record survives.
    const result = collectUndoStore(fx.store, { maxRecordsPerSession: 3, maxAgeDays: 0 });
    assert.equal(result.records_scanned, 9);
    assert.equal(result.records_kept, 4);
    assert.deepEqual(
      [...result.records_removed].sort(),
      ["run-0", "run-1", "run-2", "run-3", "run-4"],
    );
    for (const i of [0, 1, 2, 3, 4]) {
      assert.equal(fs.existsSync(path.join(fx.store, "runs", `run-${i}.json`)), false);
      assert.equal(fs.existsSync(blobPath(fx.store, hashes[i])), false, `blob ${i} was collected`);
    }
    for (const i of [5, 6, 7]) {
      assert.equal(fs.existsSync(path.join(fx.store, "runs", `run-${i}.json`)), true);
      assert.equal(fs.existsSync(blobPath(fx.store, hashes[i])), true);
    }
    assert.equal(fs.existsSync(path.join(fx.store, "runs", "run-other.json")), true);
    assert.equal(fs.existsSync(blobPath(fx.store, otherHash)), true);
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.blobs_removed.length, 5);
  } finally {
    fx.cleanup();
  }
});

test("collectUndoStore prunes records older than the max age only when the pass runs", () => {
  const fx = fixture("tb-undo-age-");
  try {
    const oldHash = writeBlobFile(fx.store, "old\n");
    const freshHash = writeBlobFile(fx.store, "fresh\n");
    writeStoredRecord(
      fx.store,
      "run-old",
      syntheticRecord({
        store: fx.store,
        workspaceRoot: fs.realpathSync(fx.root),
        session: "chat.jsonl",
        createdAt: "2026-01-01T00:00:00.000Z",
        blob: oldHash,
      }),
    );
    writeStoredRecord(
      fx.store,
      "run-fresh",
      syntheticRecord({
        store: fx.store,
        workspaceRoot: fs.realpathSync(fx.root),
        session: "chat.jsonl",
        createdAt: "2026-02-20T00:00:00.000Z",
        blob: freshHash,
      }),
    );

    // No pass: both records are still present (nothing runs implicitly).
    assert.equal(listUndoRecords(fx.store).length, 2);

    const result = collectUndoStore(fx.store, {
      maxRecordsPerSession: 100,
      maxAgeDays: 30,
      now: new Date("2026-03-01T00:00:00.000Z"),
    });
    assert.deepEqual(result.records_removed, ["run-old"]);
    assert.equal(result.records_kept, 1);
    assert.equal(fs.existsSync(path.join(fx.store, "runs", "run-old.json")), false);
    assert.equal(fs.existsSync(blobPath(fx.store, oldHash)), false);
    assert.equal(fs.existsSync(blobPath(fx.store, freshHash)), true);

    // 0 disables age pruning: an old record survives a cap-only pass.
    writeStoredRecord(
      fx.store,
      "run-old-2",
      syntheticRecord({
        store: fx.store,
        workspaceRoot: fs.realpathSync(fx.root),
        session: "chat.jsonl",
        createdAt: "2020-01-01T00:00:00.000Z",
        blob: writeBlobFile(fx.store, "ancient\n"),
      }),
    );
    const capOnly = collectUndoStore(fx.store, {
      maxRecordsPerSession: 100,
      maxAgeDays: 0,
      now: new Date("2026-03-01T00:00:00.000Z"),
    });
    assert.deepEqual(capOnly.records_removed, []);
    assert.equal(fs.existsSync(path.join(fx.store, "runs", "run-old-2.json")), true);
  } finally {
    fx.cleanup();
  }
});

test("active runs are never retention candidates, even when over the cap or too old", () => {
  const fx = fixture("tb-undo-active-");
  try {
    for (let i = 0; i < 4; i++) {
      writeStoredRecord(
        fx.store,
        `run-${i}`,
        syntheticRecord({
          store: fx.store,
          workspaceRoot: fs.realpathSync(fx.root),
          session: "chat.jsonl",
          createdAt:
            i === 0 ? "2020-01-01T00:00:00.000Z" : `2026-02-2${5 + i}T00:00:00.000Z`,
          blob: writeBlobFile(fx.store, `active-${i}\n`),
        }),
      );
    }
    const result = collectUndoStore(fx.store, {
      maxRecordsPerSession: 1,
      maxAgeDays: 30,
      now: new Date("2026-03-01T00:00:00.000Z"),
      activeRuns: ["run-0", "run-2"],
    });
    // Cap keeps only run-3; run-0 is far too old but active and must survive,
    // and run-2 is over the cap but active.
    assert.deepEqual([...result.records_removed].sort(), ["run-1"]);
    for (const runId of ["run-0", "run-2", "run-3"]) {
      assert.equal(fs.existsSync(path.join(fx.store, "runs", `${runId}.json`)), true, runId);
    }
  } finally {
    fx.cleanup();
  }
});

test("a shared blob survives while any retained record references it, then is collected", () => {
  const fx = fixture("tb-undo-shared-");
  try {
    const shared = writeBlobFile(fx.store, "shared bytes\n");
    const unique = writeBlobFile(fx.store, "unique bytes\n");
    writeStoredRecord(
      fx.store,
      "run-a",
      syntheticRecord({
        store: fx.store,
        workspaceRoot: fs.realpathSync(fx.root),
        session: "chat.jsonl",
        createdAt: "2026-02-01T00:00:00.000Z",
        preBlob: shared,
        blob: unique,
      }),
    );
    writeStoredRecord(
      fx.store,
      "run-b",
      syntheticRecord({
        store: fx.store,
        workspaceRoot: fs.realpathSync(fx.root),
        session: "chat.jsonl",
        createdAt: "2026-02-02T00:00:00.000Z",
        preBlob: shared,
        blob: shared,
      }),
    );

    assert.equal(discardUndo(fx.store, "run-a"), true);
    const first = collectOrphanBlobs(fx.store);
    assert.deepEqual(first.removed, [unique]);
    assert.equal(fs.existsSync(blobPath(fx.store, shared)), true, "run-b still references it");

    assert.equal(discardUndo(fx.store, "run-b"), true);
    const second = collectOrphanBlobs(fx.store);
    assert.deepEqual(second.removed, [shared]);
    assert.equal(fs.existsSync(blobPath(fx.store, shared)), false);
    assert.deepEqual(filesUnder(path.join(fx.store, "blobs")), []);
  } finally {
    fx.cleanup();
  }
});

test("a record that cannot be unlinked keeps its blobs (never collects a surviving record's bytes)", () => {
  const fx = fixture("tb-undo-unlinkfail-");
  try {
    const unique = writeBlobFile(fx.store, "only run-a needs these bytes\n");
    writeStoredRecord(
      fx.store,
      "run-a",
      syntheticRecord({
        store: fx.store,
        workspaceRoot: fs.realpathSync(fx.root),
        session: "chat.jsonl",
        createdAt: "2026-02-01T00:00:00.000Z",
        preBlob: unique,
        blob: unique,
      }),
    );
    writeStoredRecord(
      fx.store,
      "run-b",
      syntheticRecord({
        store: fx.store,
        workspaceRoot: fs.realpathSync(fx.root),
        session: "chat.jsonl",
        createdAt: "2026-02-02T00:00:00.000Z",
        blob: writeBlobFile(fx.store, "newer\n"),
      }),
    );

    const result = collectUndoStore(fx.store, {
      maxRecordsPerSession: 1,
      maxAgeDays: 0,
      beforeUnlink: (_recordPath, runId) => {
        if (runId === "run-a") {
          const error = new Error("busy") as NodeJS.ErrnoException;
          error.code = "EPERM";
          throw error;
        }
      },
    });
    assert.deepEqual(result.records_removed, []);
    assert.equal(result.records_kept, 2);
    assert.equal(fs.existsSync(path.join(fx.store, "runs", "run-a.json")), true);
    assert.equal(
      fs.existsSync(blobPath(fx.store, unique)),
      true,
      "a failed unlink must not make its pre-image collectable",
    );
    assert.ok(result.diagnostics.some((line) => line.includes("cannot remove undo record run-a")));
  } finally {
    fx.cleanup();
  }
});

test("orphan collection refuses a corrupt record (never deletes bytes it cannot prove unreferenced)", () => {
  const fx = fixture("tb-undo-corrupt-gc-");
  try {
    const hash = writeBlobFile(fx.store, "referenced by a readable record\n");
    writeStoredRecord(
      fx.store,
      "run-ok",
      syntheticRecord({
        store: fx.store,
        workspaceRoot: fs.realpathSync(fx.root),
        session: "chat.jsonl",
        createdAt: "2026-02-01T00:00:00.000Z",
        blob: hash,
      }),
    );
    fs.writeFileSync(path.join(fx.store, "runs", "run-corrupt.json"), "{not json", "utf-8");

    const gc = collectOrphanBlobs(fx.store);
    assert.deepEqual(gc.removed, []);
    assert.match(String(gc.skipped), /could not be parsed/);
    assert.equal(fs.existsSync(blobPath(fx.store, hash)), true);

    // Retention itself is fail-soft: one diagnostic, no throw.
    const result = collectUndoStore(fx.store, { maxRecordsPerSession: 20, maxAgeDays: 0 });
    assert.ok(result.diagnostics.length >= 1);
    assert.equal(fs.existsSync(blobPath(fx.store, hash)), true);
  } finally {
    fx.cleanup();
  }
});

test("retention is fail-soft on an unusable store root (one diagnostic, no crash)", () => {
  const fx = fixture("tb-undo-broken-gc-");
  try {
    const blocker = path.join(fx.base, "blocked");
    fs.writeFileSync(blocker, "not a directory", "utf-8");

    const result = collectUndoStore(blocker, { maxRecordsPerSession: 5, maxAgeDays: 30 });
    assert.deepEqual(result.records_removed, []);
    assert.ok(result.diagnostics.length >= 1);
    assert.match(result.diagnostics[0], /undo store root is not a directory/);

    const gc = collectOrphanBlobs(blocker);
    assert.deepEqual(gc.removed, []);
    assert.ok(gc.diagnostics.length >= 1);
  } finally {
    fx.cleanup();
  }
});

test("capture close runs the bounded retention pass and keeps its own record", async () => {
  const fx = fixture("tb-undo-close-gc-");
  try {
    for (let i = 0; i < 5; i++) {
      writeStoredRecord(
        fx.store,
        `run-${i}`,
        syntheticRecord({
          store: fx.store,
          workspaceRoot: fs.realpathSync(fx.root),
          session: "chat.jsonl",
          createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
          blob: writeBlobFile(fx.store, `close-${i}\n`),
        }),
      );
    }
    const capture = beginUndoCapture(fx.store, "run-new", fx.root, {
      session: "chat.jsonl",
      maxRecordsPerSession: 3,
      maxAgeDays: 0,
      activeRuns: () => ["run-0"],
    });
    const ws = new Workspace(fx.root, allow(), null, { mutationRecorder: capture.recorder });
    await ws.write_file("fresh.txt", "fresh\n");
    capture.close();

    const retention = capture.lastRetention;
    assert.ok(retention);
    assert.deepEqual([...retention.records_removed].sort(), ["run-1", "run-2"]);
    assert.equal(retention.records_kept, 4);
    assert.equal(fs.existsSync(path.join(fx.store, "runs", "run-new.json")), true);
    assert.equal(fs.existsSync(path.join(fx.store, "runs", "run-0.json")), true);
    assert.equal(fs.existsSync(path.join(fx.store, "runs", "run-2.json")), false);
    assert.equal(capture.diagnostics.length, 0);
  } finally {
    fx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// file mode / ownership restoration (wave 26)
// ---------------------------------------------------------------------------

test(
  "undo restores the recorded POSIX mode of an edited script",
  { skip: process.platform === "win32" ? "POSIX mode bits only" : false },
  async () => {
    const fx = runFixture();
    try {
      const script = path.join(fx.root, "run.sh");
      fs.writeFileSync(script, "#!/bin/sh\necho old\n", "utf-8");
      fs.chmodSync(script, 0o755);

      assert.equal((await fx.ws.edit_file("run.sh", "echo old", "echo new")).status, "ok");
      assert.equal(fs.statSync(script).mode & 0o7777, 0o755);
      const record = readStoredRecord(fx.store, fx.runId);
      assert.equal(record.entries[0].pre.mode, 0o755);

      const result = applyUndo(fx.store, fx.runId, fx.root);
      assert.equal(result.applied, 1);
      assert.equal(result.entries[0].mode_restored, true);
      assert.equal(fs.readFileSync(script, "utf-8"), "#!/bin/sh\necho old\n");
      assert.equal(fs.statSync(script).mode & 0o7777, 0o755);
    } finally {
      fx.cleanup();
    }
  },
);

test(
  "a delete-only run records and restores the POSIX mode from the live file",
  { skip: process.platform === "win32" ? "POSIX mode bits only" : false },
  async () => {
    const fx = runFixture();
    try {
      const script = path.join(fx.root, "cleanup.sh");
      fs.writeFileSync(script, "#!/bin/sh\necho cleanup\n", "utf-8");
      fs.chmodSync(script, 0o755);

      // The run's FIRST and only mutation of this path is a delete, so the
      // mode can only come from the mutation seam's pre-image stat.
      assert.equal((await fx.ws.delete_file("cleanup.sh")).status, "ok");
      const entry = readStoredRecord(fx.store, fx.runId).entries[0];
      assert.equal(entry.action, "delete");
      assert.equal(entry.pre.mode, 0o755);

      const result = applyUndo(fx.store, fx.runId, fx.root);
      assert.equal(result.applied, 1);
      assert.equal(result.entries[0].mode_restored, true);
      assert.equal(fs.readFileSync(script, "utf-8"), "#!/bin/sh\necho cleanup\n");
      assert.equal(fs.statSync(script).mode & 0o7777, 0o755);
    } finally {
      fx.cleanup();
    }
  },
);

test(
  "undo restores the recorded POSIX mode after delete + undo",
  { skip: process.platform === "win32" ? "POSIX mode bits only" : false },
  async () => {
    const fx = runFixture();
    try {
      const script = path.join(fx.root, "deploy.sh");
      fs.writeFileSync(script, "#!/bin/sh\necho deploy\n", "utf-8");
      fs.chmodSync(script, 0o750);

      // Edit (captures the mode) then delete: the net effect is a delete whose
      // pre-image must restore both bytes and executable bits.
      assert.equal((await fx.ws.edit_file("deploy.sh", "echo deploy", "echo deploy2")).status, "ok");
      assert.equal((await fx.ws.delete_file("deploy.sh")).status, "ok");
      const entry = readStoredRecord(fx.store, fx.runId).entries[0];
      assert.equal(entry.action, "delete");
      assert.equal(entry.pre.mode, 0o750);

      const result = applyUndo(fx.store, fx.runId, fx.root);
      assert.equal(result.applied, 1);
      assert.equal(fs.readFileSync(script, "utf-8"), "#!/bin/sh\necho deploy\n");
      assert.equal(fs.statSync(script).mode & 0o7777, 0o750);
    } finally {
      fx.cleanup();
    }
  },
);

test("old records without mode fields still load and apply (additive record fields)", async () => {
  const fx = fixture("tb-undo-oldmode-");
  try {
    fs.writeFileSync(path.join(fx.root, "legacy.txt"), "old\n", "utf-8");
    const hash = writeBlobFile(fx.store, "old\n");
    writeStoredRecord(fx.store, "run-legacy", {
      version: WORKSPACE_UNDO_VERSION,
      workspace_root: fs.realpathSync(fx.root),
      created_at: new Date().toISOString(),
      entries: [
        {
          path: "legacy.txt",
          action: "edit",
          pre: { exists: true, sha256: hash, size: 4 },
          post: { exists: true, sha256: sha256("new\n"), size: 4 },
        },
      ],
    });
    fs.writeFileSync(path.join(fx.root, "legacy.txt"), "new\n", "utf-8");

    const preview = previewUndo(fx.store, "run-legacy", fx.root);
    assert.equal(statuses(preview)["legacy.txt"], "applicable");
    const result = applyUndo(fx.store, "run-legacy", fx.root);
    assert.equal(result.applied, 1);
    assert.equal(result.entries[0].mode_restored, undefined);
    assert.equal(fs.readFileSync(path.join(fx.root, "legacy.txt"), "utf-8"), "old\n");
  } finally {
    fx.cleanup();
  }
});

test(
  "a failed mode restore is disclosed but never fatal (bytes still restored)",
  { skip: process.platform === "win32" ? "POSIX mode bits only" : false },
  async () => {
    const fx = fixture("tb-undo-modefail-");
    try {
      fs.writeFileSync(path.join(fx.root, "a.txt"), "a-before\n", "utf-8");
      fs.writeFileSync(path.join(fx.root, "b.txt"), "b-before\n", "utf-8");
      const preA = writeBlobFile(fx.store, "a-before\n");
      const preB = writeBlobFile(fx.store, "b-before\n");
      writeStoredRecord(fx.store, "run-modefail", {
        version: WORKSPACE_UNDO_VERSION,
        workspace_root: fs.realpathSync(fx.root),
        created_at: new Date().toISOString(),
        entries: [
          {
            path: "a.txt",
            action: "edit",
            pre: { exists: true, sha256: preA, size: 9, mode: 0o100000000 },
            post: { exists: true, sha256: writeBlobFile(fx.store, "a-after\n"), size: 8 },
          },
          {
            path: "b.txt",
            action: "edit",
            pre: { exists: true, sha256: preB, size: 9, mode: 0o644 },
            post: { exists: true, sha256: writeBlobFile(fx.store, "b-after\n"), size: 8 },
          },
        ],
      });
      fs.writeFileSync(path.join(fx.root, "a.txt"), "a-after\n", "utf-8");
      fs.writeFileSync(path.join(fx.root, "b.txt"), "b-after\n", "utf-8");

      const result = applyUndo(fx.store, "run-modefail", fx.root);
      assert.equal(result.applied, 2);
      assert.equal(result.failed, 0);
      const a = result.entries.find((entry) => entry.path === "a.txt")!;
      assert.equal(a.status, "applied");
      assert.equal(a.mode_restored, false);
      assert.match(String(a.mode_error), /could not restore the file mode/);
      const b = result.entries.find((entry) => entry.path === "b.txt")!;
      assert.equal(b.status, "applied");
      assert.equal(b.mode_restored, true);
      assert.equal(fs.readFileSync(path.join(fx.root, "a.txt"), "utf-8"), "a-before\n");
      assert.equal(fs.readFileSync(path.join(fx.root, "b.txt"), "utf-8"), "b-before\n");
    } finally {
      fx.cleanup();
    }
  },
);

test("listUndoRecords lists newest first with session metadata only", async () => {
  const fx = fixture("tb-undo-list-");
  try {
    writeStoredRecord(
      fx.store,
      "run-older",
      syntheticRecord({
        store: fx.store,
        workspaceRoot: fs.realpathSync(fx.root),
        session: "chat.jsonl",
        createdAt: "2026-02-01T00:00:00.000Z",
        blob: writeBlobFile(fx.store, "older\n"),
      }),
    );
    writeStoredRecord(
      fx.store,
      "run-newer",
      syntheticRecord({
        store: fx.store,
        workspaceRoot: fs.realpathSync(fx.root),
        session: "chat.jsonl",
        createdAt: "2026-02-02T00:00:00.000Z",
        blob: writeBlobFile(fx.store, "newer\n"),
      }),
    );
    fs.writeFileSync(path.join(fx.store, "runs", "bad name.json"), "{}", "utf-8");

    const listed = listUndoRecords(fx.store);
    assert.deepEqual(
      listed.map((entry) => entry.run_id),
      ["run-newer", "run-older"],
    );
    assert.equal(listed[0].session, "chat.jsonl");
    assert.equal(listed[0].created_at, "2026-02-02T00:00:00.000Z");
    assert.equal(typeof listed[0].record_path, "string");
  } finally {
    fx.cleanup();
  }
});
