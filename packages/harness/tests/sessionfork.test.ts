/**
 * Session fork by copy (`src/sessionfork.ts`).
 *
 * Hermetic filesystem tests over temp dirs under `os.tmpdir()` (cleaned up in
 * `finally`). Every case that touches a real source proves it stays
 * byte-identical; the JSONL copy is checked line-by-line so an accidental
 * re-serialization fails. No network, no sleeps.
 * Run with: node --test tests/sessionfork.test.ts
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import {
  SessionMetadataStore,
  SESSION_NAME_MAX_CHARS,
  type SessionParentLink,
} from "../src/metadata.ts";
import type { Message } from "../src/protocol.ts";
import { RuntimeEventStore } from "../src/runevents.ts";
import { SessionStore } from "../src/session.ts";
import { SessionForkError, forkFileName, forkSession } from "../src/sessionfork.ts";

/** Hand-formatted source lines: the fork must copy these bytes, not re-encode. */
const RAW_LINES = [
  '{"v": 1, "id": "a", "seq": 1, "ts": "2026-11-06T12:00:00Z", "from": "user", "to": "senior", "kind": "message", "payload": { "text": "Plan the Redis migration" }}',
  '{"v":1,"id":"b","seq":2,"ts":"2026-11-06T12:01:00Z","from":"senior","to":"junior","kind":"delegation","payload":{"work":"check  the   plan"}}',
  '{"v":1,"id":"c","seq":3,"ts":"2026-11-06T12:02:00Z","from":"junior","to":"senior","kind":"deliverable","payload":{"result":"done","artifacts":["a.ts","b.ts"]}}',
];

function message(overrides: Partial<Message> = {}): Message {
  return {
    v: 1,
    id: `msg-${Math.random().toString(16).slice(2, 10)}`,
    seq: 1,
    ts: "2026-11-06T12:00:00Z",
    from: "senior",
    to: "junior",
    kind: "message",
    payload: { text: "hello" },
    ...overrides,
  };
}

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "two-brothers-sessionfork-"));
}

function jsonlPath(dir: string, name: string): string {
  return path.join(dir, name.endsWith(".jsonl") ? name : `${name}.jsonl`);
}

function writeRawSession(dir: string, name: string, lines: string[]): string {
  const file = jsonlPath(dir, name);
  fs.writeFileSync(file, lines.join("\n") + "\n", "utf-8");
  return file;
}

function writeSession(dir: string, name: string, events: Message[]): string {
  return writeRawSession(dir, name, events.map((event) => JSON.stringify(event)));
}

function metaPath(dir: string, name: string): string {
  return path.join(dir, name.replace(/\.jsonl$/, "") + ".meta.json");
}

function sha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function listNames(dir: string): string[] {
  try {
    return fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
}

/** Assert the call throws a typed fork error and return it for code checks. */
function forkError(call: () => unknown): SessionForkError {
  try {
    call();
  } catch (exc) {
    if (!(exc instanceof SessionForkError)) {
      throw new Error(`expected SessionForkError, got ${String(exc)}`);
    }
    return exc;
  }
  throw new Error("expected a SessionForkError, but the call succeeded");
}

test("full fork copies every envelope byte-for-byte and links the parent seq", () => {
  const dir = tmpdir();
  try {
    const sourceFile = writeRawSession(dir, "src.jsonl", RAW_LINES);
    new SessionMetadataStore(dir).save("src.jsonl", { title: "Migration planning" });
    const sourceEvents = new SessionStore(sourceFile).load();
    const sourceHash = sha256(sourceFile);
    const sourceMeta = new SessionMetadataStore(dir).get("src.jsonl");

    const result = forkSession(dir, "src.jsonl");

    assert.equal(result.name, "src-fork-1.jsonl");
    assert.equal(result.title, "Migration planning (fork)");
    assert.equal(result.events, 3);
    assert.deepEqual(result.forked_from, { name: "src.jsonl", seq: 3 });

    // exact bytes: no JSON re-serialization, key order and spacing preserved
    const forkFile = path.join(dir, result.name);
    assert.equal(fs.readFileSync(forkFile, "utf-8"), RAW_LINES.join("\n") + "\n");

    // parses through the existing store with the same dense seq and content
    const forkedEvents = new SessionStore(forkFile).load();
    assert.deepEqual(
      forkedEvents.map((event) => event.seq),
      [1, 2, 3],
    );
    assert.deepEqual(forkedEvents, sourceEvents);

    // the additive local lineage link lives in the new sidecar
    const forkMeta = new SessionMetadataStore(dir).get(result.name);
    assert.deepEqual(forkMeta?.parent, { name: "src.jsonl", seq: 3 });
    assert.equal(forkMeta?.title, "Migration planning (fork)");

    // the source file and its sidecar are untouched
    assert.equal(sha256(sourceFile), sourceHash);
    assert.deepEqual(new SessionMetadataStore(dir).get("src.jsonl"), sourceMeta);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("fork at seq copies exactly the prefix and links the cut seq", () => {
  const dir = tmpdir();
  try {
    const sourceFile = writeRawSession(dir, "src.jsonl", RAW_LINES);
    const sourceHash = sha256(sourceFile);

    const result = forkSession(dir, "src", { atSeq: 2 });
    assert.equal(result.name, "src-fork-1.jsonl");
    assert.equal(result.events, 2);
    assert.deepEqual(result.forked_from, { name: "src.jsonl", seq: 2 });
    assert.equal(fs.readFileSync(path.join(dir, result.name), "utf-8"), RAW_LINES.slice(0, 2).join("\n") + "\n");
    assert.deepEqual(
      new SessionStore(path.join(dir, result.name)).load().map((event) => event.seq),
      [1, 2],
    );
    assert.deepEqual(new SessionMetadataStore(dir).get(result.name)?.parent, {
      name: "src.jsonl",
      seq: 2,
    });

    const one = forkSession(dir, "src.jsonl", { atSeq: 1 });
    assert.equal(one.events, 1);
    assert.deepEqual(one.forked_from, { name: "src.jsonl", seq: 1 });
    assert.equal(fs.readFileSync(path.join(dir, one.name), "utf-8"), RAW_LINES[0] + "\n");

    assert.equal(sha256(sourceFile), sourceHash);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("default naming takes the smallest free fork slot (sessions, meta and runtime sidecars)", () => {
  const dir = tmpdir();
  try {
    writeRawSession(dir, "src.jsonl", RAW_LINES);
    // occupied slots the app would read under these names
    writeRawSession(dir, "src-fork-1.jsonl", ['{"v":1}']);
    fs.writeFileSync(metaPath(dir, "src-fork-2.jsonl"), JSON.stringify({ title: "orphan" }), "utf-8");
    fs.mkdirSync(path.join(dir, "runtime"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "runtime", "src-fork-3.jsonl.events.jsonl"),
      "",
      "utf-8",
    );

    const first = forkSession(dir, "src.jsonl");
    assert.equal(first.name, "src-fork-4.jsonl");

    const second = forkSession(dir, "src.jsonl");
    assert.equal(second.name, "src-fork-5.jsonl");

    // a fork of a fork names itself after the fork stem
    const nested = forkSession(dir, first.name);
    assert.equal(nested.name, "src-fork-4-fork-1.jsonl");
    assert.deepEqual(nested.forked_from, { name: "src-fork-4.jsonl", seq: 3 });
    assert.equal(nested.title, "Plan the Redis migration (fork) (fork)");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("explicit name (with or without .jsonl) and explicit title are honored", () => {
  const dir = tmpdir();
  try {
    writeRawSession(dir, "src.jsonl", RAW_LINES);

    const plain = forkSession(dir, "src", { name: "branch-a" });
    assert.equal(plain.name, "branch-a.jsonl");
    assert.equal(plain.title, "Plan the Redis migration (fork)");
    assert.deepEqual(plain.forked_from, { name: "src.jsonl", seq: 3 });

    const suffixed = forkSession(dir, "src", { name: "branch-b.jsonl" });
    assert.equal(suffixed.name, "branch-b.jsonl");
    assert.ok(fs.existsSync(path.join(dir, "branch-b.jsonl")));
    assert.ok(!fs.existsSync(path.join(dir, "branch-b.jsonl.jsonl")));

    const titled = forkSession(dir, "src", { name: "branch-c", title: "  Custom branch  " });
    assert.equal(titled.title, "Custom branch");
    assert.equal(
      new SessionMetadataStore(dir).get("branch-c.jsonl")?.title,
      "Custom branch",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an existing target name is a name-taken error, never an overwrite", () => {
  const dir = tmpdir();
  try {
    writeRawSession(dir, "src.jsonl", RAW_LINES);
    const existing = writeRawSession(dir, "branch-a.jsonl", ['{"v": 1, "id": "keep"}']);
    const existingHash = sha256(existing);

    assert.equal(forkError(() => forkSession(dir, "src", { name: "branch-a" })).code, "name-taken");
    assert.equal(sha256(existing), existingHash, "existing session must not be overwritten");

    // a leftover metadata sidecar also reserves the name
    fs.writeFileSync(metaPath(dir, "ghost.jsonl"), JSON.stringify({ title: "ghost" }), "utf-8");
    assert.equal(forkError(() => forkSession(dir, "src", { name: "ghost" })).code, "name-taken");

    // the source can never be selected as the target
    assert.equal(forkError(() => forkSession(dir, "src", { name: "src" })).code, "name-taken");
    assert.ok(!fs.existsSync(path.join(dir, "src.jsonl.jsonl")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("explicit names with traversal or non-portable characters are rejected", () => {
  const dir = tmpdir();
  const container = tmpdir();
  try {
    const sessionsDir = path.join(container, "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    writeRawSession(sessionsDir, "src.jsonl", RAW_LINES);

    const invalid = [
      "",
      "   ",
      ".",
      "..",
      "../evil",
      "..\\evil",
      "sub/evil",
      "sub\\evil",
      "a:b",
      "bad?name",
      "bad*name",
      "nul\u0000name",
      "line\nbreak",
      "tab\tname",
    ];
    for (const name of invalid) {
      const error = forkError(() => forkSession(sessionsDir, "src", { name }));
      assert.equal(error.code, "invalid-name", `expected invalid-name for ${JSON.stringify(name)}`);
    }
    // nothing escaped the sessions directory and no partial session was written
    assert.deepEqual(listNames(sessionsDir), ["src.jsonl"]);
    assert.deepEqual(listNames(container), ["sessions"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(container, { recursive: true, force: true });
  }
});

test("forkFileName canonical form: optional suffix, single portable component", () => {
  assert.equal(forkFileName("branch"), "branch.jsonl");
  assert.equal(forkFileName("branch.jsonl"), "branch.jsonl");
  assert.equal(forkFileName(" branch "), "branch.jsonl");
  assert.equal(forkFileName("sp ace"), "sp ace.jsonl");
  assert.equal(forkFileName("a.b-c_d"), "a.b-c_d.jsonl");
});

test("unknown, missing and path-shaped sources fail honestly without writing", () => {
  const dir = tmpdir();
  try {
    writeRawSession(dir, "src.jsonl", RAW_LINES);

    assert.equal(forkError(() => forkSession(dir, "nope.jsonl")).code, "source-missing");
    assert.equal(forkError(() => forkSession(dir, "nope")).code, "source-missing");
    // traversal-ish source names are flattened to a basename inside the dir
    assert.equal(forkError(() => forkSession(dir, "../../etc/passwd")).code, "source-missing");
    assert.equal(forkError(() => forkSession(dir, "sub/../missing")).code, "source-missing");

    for (const source of ["", " ", ".", "..", "sub/.."]) {
      const error = forkError(() => forkSession(dir, source));
      assert.equal(error.code, "invalid-name", `expected invalid-name for ${JSON.stringify(source)}`);
    }

    // a path-shaped source that flattens to a real session resolves inside the dir
    const flattened = forkSession(dir, "sub/../src");
    assert.deepEqual(flattened.forked_from, { name: "src.jsonl", seq: 3 });
    assert.ok(fs.existsSync(path.join(dir, flattened.name)));
    fs.rmSync(path.join(dir, flattened.name), { force: true });
    fs.rmSync(metaPath(dir, flattened.name), { force: true });

    assert.deepEqual(listNames(dir), ["src.jsonl"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("invalid at seq values are rejected with the valid range", () => {
  const dir = tmpdir();
  try {
    const sourceFile = writeRawSession(dir, "src.jsonl", RAW_LINES);
    const sourceHash = sha256(sourceFile);

    const invalid: unknown[] = [0, -1, 4, 2.5, Number.NaN, Infinity, "2"];
    for (const atSeq of invalid) {
      const error = forkError(() => forkSession(dir, "src", { atSeq: atSeq as number }));
      assert.equal(error.code, "invalid-seq", `expected invalid-seq for ${String(atSeq)}`);
      assert.ok(/between 1 and 3/.test(error.message), error.message);
    }

    assert.deepEqual(listNames(dir), ["src.jsonl"]);
    assert.equal(sha256(sourceFile), sourceHash);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a full fork of an empty session is allowed; an explicit seq on it is not", () => {
  const dir = tmpdir();
  try {
    fs.writeFileSync(path.join(dir, "empty.jsonl"), "", "utf-8");

    const result = forkSession(dir, "empty.jsonl");
    assert.equal(result.name, "empty-fork-1.jsonl");
    assert.equal(result.events, 0);
    assert.deepEqual(result.forked_from, { name: "empty.jsonl", seq: 0 });
    assert.equal(result.title, "empty (fork)");
    assert.equal(fs.readFileSync(path.join(dir, result.name), "utf-8"), "");
    assert.deepEqual(new SessionMetadataStore(dir).get(result.name)?.parent, {
      name: "empty.jsonl",
      seq: 0,
    });

    const error = forkError(() => forkSession(dir, "empty.jsonl", { atSeq: 1 }));
    assert.equal(error.code, "invalid-seq");
    assert.ok(/no envelopes/.test(error.message), error.message);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a corrupt or non-dense source is source-unreadable and nothing is written", () => {
  const dir = tmpdir();
  try {
    writeRawSession(dir, "src.jsonl", RAW_LINES);
    fs.writeFileSync(path.join(dir, "corrupt.jsonl"), '{"v":1}\nnot json\n', "utf-8");
    fs.writeFileSync(path.join(dir, "array.jsonl"), "[1,2]\n", "utf-8");
    fs.writeFileSync(
      path.join(dir, "sparse.jsonl"),
      '{"v":1,"id":"a","seq":1,"ts":"t","from":"user","to":"senior","kind":"message","payload":{}}\n' +
        '{"v":1,"id":"b","seq":3,"ts":"t","from":"senior","to":"junior","kind":"message","payload":{}}\n',
      "utf-8",
    );

    for (const source of ["corrupt", "array", "sparse"]) {
      const error = forkError(() => forkSession(dir, source));
      assert.equal(error.code, "source-unreadable", `expected source-unreadable for ${source}`);
    }
    assert.equal(forkError(() => forkSession(dir, "sparse")).code, "source-unreadable");
    assert.ok(!listNames(dir).some((name) => name.includes("-fork-")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("derived fork titles use the source title, stay bounded and handle long/absent titles", () => {
  const dir = tmpdir();
  try {
    // no sidecar: title derives from the first operator message
    writeSession(dir, "nodesc.jsonl", [
      message({ seq: 1, from: "user", to: "senior", payload: { text: "A".repeat(100) } }),
      message({ seq: 2 }),
    ]);
    const derived = forkSession(dir, "nodesc");
    assert.ok(derived.title.startsWith("A"), derived.title);
    assert.ok(derived.title.endsWith(" (fork)"), derived.title);
    assert.equal(derived.title.length, 80);

    // an empty source title falls back to the fallback listing title (the stem)
    writeSession(dir, "nosubject.jsonl", [message({ seq: 1, payload: { text: "x" } })]);
    assert.equal(forkSession(dir, "nosubject").title, "nosubject (fork)");

    // a curated sidecar title wins over derivation
    writeSession(dir, "curated.jsonl", [message({ seq: 1, payload: { text: "ignored" } })]);
    new SessionMetadataStore(dir).save("curated.jsonl", { title: "Curated" });
    assert.equal(forkSession(dir, "curated").title, "Curated (fork)");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the parent link is additive: old sidecars stay valid and later saves keep it", () => {
  const dir = tmpdir();
  try {
    writeRawSession(dir, "src.jsonl", RAW_LINES);
    const metadata = new SessionMetadataStore(dir);
    // a pre-fork sidecar with no parent at all stays readable as-is
    metadata.save("src.jsonl", { title: "Curated source", workspaceId: "ws-1" });
    assert.equal(metadata.get("src.jsonl")?.parent, undefined);

    const result = forkSession(dir, "src");
    assert.equal(result.title, "Curated source (fork)");
    assert.deepEqual(metadata.get(result.name)?.parent, { name: "src.jsonl", seq: 3 });
    // the workspace link is deliberately not inherited by a fork
    assert.equal(metadata.get(result.name)?.workspace_id, undefined);
    assert.equal(metadata.get("src.jsonl")?.workspace_id, "ws-1");

    // a later title edit keeps the lineage link
    metadata.save(result.name, { title: "Renamed branch" });
    assert.equal(metadata.get(result.name)?.title, "Renamed branch");
    assert.deepEqual(metadata.get(result.name)?.parent, { name: "src.jsonl", seq: 3 });

    // an unparseable parent argument is ignored instead of corrupting the sidecar
    writeRawSession(dir, "other.jsonl", [RAW_LINES[0]]);
    metadata.save("other.jsonl", {
      title: "Other",
      parent: { name: "", seq: -1 } as unknown as SessionParentLink,
    });
    assert.equal(metadata.get("other.jsonl")?.parent, undefined);
    assert.equal(metadata.get("other.jsonl")?.title, "Other");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runtime evidence is not copied; the source runtime sidecar stays untouched", () => {
  const dir = tmpdir();
  try {
    writeRawSession(dir, "src.jsonl", RAW_LINES);
    fs.mkdirSync(path.join(dir, "runtime"), { recursive: true });
    const runtimeFile = path.join(dir, "runtime", "src.jsonl.events.jsonl");
    const runtimeLine = JSON.stringify({ type: "run_status", status: "completed", run_id: "r1" });
    fs.writeFileSync(runtimeFile, runtimeLine + "\n", "utf-8");

    const result = forkSession(dir, "src");
    const runtime = new RuntimeEventStore(path.join(dir, "runtime"));
    assert.equal(runtime.exists("src.jsonl"), true);
    assert.equal(runtime.exists(result.name), false, "a fresh fork must start with no tool evidence");
    assert.equal(fs.readFileSync(runtimeFile, "utf-8"), runtimeLine + "\n");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// review P2 fixes (wave 23): rollback honesty, TOCTOU, raw bytes, name safety
// ---------------------------------------------------------------------------

test("a metadata write failure rolls back the copied file and its partial sidecar", () => {
  const dir = tmpdir();
  try {
    writeRawSession(dir, "src.jsonl", RAW_LINES);
    const target = jsonlPath(dir, "branch-a");
    const sidecar = metaPath(dir, "branch-a.jsonl");

    const error = forkError(() =>
      forkSession(dir, "src", {
        name: "branch-a",
        metadataWriter: () => {
          // Simulate a non-atomic sidecar write failing after a partial file.
          fs.writeFileSync(sidecar, '{"title": "par', "utf-8");
          throw new Error("disk full");
        },
      }),
    );

    assert.equal(error.code, "write-failed");
    assert.match(error.message, /cannot write session metadata for branch-a\.jsonl/);
    assert.match(error.message, /disk full/);
    // Honest message: the JSONL rollback succeeded and says so.
    assert.match(error.message, /the copied session file was removed/);
    assert.ok(!error.message.includes("could not be removed"));
    // No orphan JSONL, and no leftover partial sidecar (it would block the name).
    assert.ok(!fs.existsSync(target), "no orphan JSONL after a failed metadata write");
    assert.ok(!fs.existsSync(sidecar), "the partial sidecar must be removed too");

    // The name is not permanently blocked: the same explicit name now works.
    const retry = forkSession(dir, "src", { name: "branch-a" });
    assert.equal(retry.name, "branch-a.jsonl");
    assert.equal(retry.events, 3);
    assert.ok(fs.existsSync(target));
    assert.deepEqual(new SessionMetadataStore(dir).get("branch-a.jsonl")?.parent, {
      name: "src.jsonl",
      seq: 3,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a rollback that cannot remove the copied file says so honestly", () => {
  const dir = tmpdir();
  try {
    writeRawSession(dir, "src.jsonl", RAW_LINES);
    const target = jsonlPath(dir, "branch-b");

    const error = forkError(() =>
      forkSession(dir, "src", {
        name: "branch-b",
        metadataWriter: () => {
          // Make the rollback's rmSync fail portably: replace the copied file
          // with a non-empty directory (rmSync without `recursive` refuses it).
          fs.rmSync(target, { force: true });
          fs.mkdirSync(target);
          fs.writeFileSync(path.join(target, "stuck"), "x", "utf-8");
          throw new Error("metadata write failed");
        },
      }),
    );

    assert.equal(error.code, "write-failed");
    assert.match(error.message, /the copied session file could not be removed/);
    // Never claims a removal that failed.
    assert.ok(!error.message.includes("the copied session file was removed"));
    assert.ok(fs.existsSync(target), "the stuck artifact is reported honestly");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a source replaced between the stat and the read is refused honestly", () => {
  const dir = tmpdir();
  try {
    const source = writeRawSession(dir, "src.jsonl", RAW_LINES);
    const original = fs.readFileSync(source, "utf-8");
    // Same byte length, different content: a size-only guard cannot see this.
    const replacement = original.replace("Redis", "Valky");
    assert.equal(replacement.length, original.length);
    assert.notEqual(replacement, original);

    const error = forkError(() =>
      forkSession(dir, "src", {
        beforeSourceRead: () => {
          fs.writeFileSync(source, replacement, "utf-8");
          const future = new Date(Date.now() + 60_000);
          fs.utimesSync(source, future, future);
        },
      }),
    );

    assert.equal(error.code, "source-unreadable");
    assert.match(error.message, /changed while it was being forked/);
    assert.ok(!listNames(dir).some((name) => name.includes("-fork-")), "nothing was written");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("CRLF and blank-line sources are copied as the exact raw byte prefix", () => {
  const dir = tmpdir();
  try {
    const sourceText = `${RAW_LINES[0]}\r\n\r\n${RAW_LINES[1]}\r\n${RAW_LINES[2]}\r\n`;
    const source = path.join(dir, "crlf.jsonl");
    fs.writeFileSync(source, sourceText, "utf-8");

    // A full fork keeps the raw bytes: CRLF terminators and the blank line.
    const full = forkSession(dir, "crlf");
    assert.equal(fs.readFileSync(path.join(dir, full.name), "utf-8"), sourceText);
    assert.deepEqual(
      new SessionStore(path.join(dir, full.name)).load().map((event) => event.seq),
      [1, 2, 3],
    );

    // A prefix copy stops after the cut envelope's own terminator (the blank
    // line after it belongs to the remainder, not to the copied prefix).
    const cut = forkSession(dir, "crlf", { atSeq: 1 });
    assert.equal(fs.readFileSync(path.join(dir, cut.name), "utf-8"), `${RAW_LINES[0]}\r\n`);
    assert.deepEqual(
      new SessionStore(path.join(dir, cut.name)).load().map((event) => event.seq),
      [1],
    );

    // The source is untouched.
    assert.equal(fs.readFileSync(source, "utf-8"), sourceText);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Windows reserved device names are rejected as invalid-name", () => {
  const dir = tmpdir();
  try {
    writeRawSession(dir, "src.jsonl", RAW_LINES);
    const reserved = [
      "CON",
      "con",
      "Con.jsonl",
      "PRN",
      "aux",
      "NUL",
      "nul.txt",
      "COM1",
      "com9",
      "LPT1",
      "lpt9",
      "CON.tar",
    ];
    for (const name of reserved) {
      const error = forkError(() => forkSession(dir, "src", { name }));
      assert.equal(error.code, "invalid-name", `expected invalid-name for ${JSON.stringify(name)}`);
      assert.match(error.message, /reserved device name/i, error.message);
    }
    // Names that merely start with a device name are portable, not reserved.
    assert.equal(forkFileName("CONSOLE"), "CONSOLE.jsonl");
    assert.equal(forkFileName("COM10"), "COM10.jsonl");
    assert.equal(forkFileName("lpt0"), "lpt0.jsonl");
    assert.deepEqual(listNames(dir), ["src.jsonl"], "no rejected name wrote anything");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the new session name length is bounded with an honest error", () => {
  const dir = tmpdir();
  try {
    writeRawSession(dir, "src.jsonl", RAW_LINES);
    const tooLong = "a".repeat(SESSION_NAME_MAX_CHARS + 1);
    const error = forkError(() => forkSession(dir, "src", { name: tooLong }));
    assert.equal(error.code, "invalid-name");
    assert.match(error.message, new RegExp(`max ${SESSION_NAME_MAX_CHARS} characters`), error.message);

    const longest = "b".repeat(SESSION_NAME_MAX_CHARS);
    const ok = forkSession(dir, "src", { name: longest });
    assert.equal(ok.name, longest + ".jsonl");
    assert.ok(fs.existsSync(path.join(dir, ok.name)));
    assert.deepEqual(
      listNames(dir).filter((name) => !name.startsWith("src")),
      [ok.name, ok.name.replace(/\.jsonl$/, ".meta.json")],
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
