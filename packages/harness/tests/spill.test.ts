/**
 * Bounded tool-output spill: storage mechanics plus the harness wiring.
 *
 * Hermetic only: temp directories, scripted providers and in-memory tools. No
 * network, no child processes, no sleeps beyond filesystem retry-free setup.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { resolveConfig } from "../src/config.ts";
import type { ChatMessage } from "../src/context.ts";
import { TwoBrothersHarness } from "../src/harness.ts";
import {
  MockProvider,
  type Provider,
  type Tool,
  type ToolChatOptions,
  type ToolChatResponse,
} from "../src/provider.ts";
import {
  SPILL_READ_MAX_CHARS,
  SPILL_READ_TOOL_NAME,
  SpillRootUnsafeError,
  SpillStore,
  spillMarker,
  spillPreview,
} from "../src/spill.ts";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function tmpdir(prefix: string): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const DELIVERABLE = JSON.stringify({
  result: "done",
  artifacts: [],
  notes: "",
  confidence: 0.9,
});

function fakeTool(name: string, execute: () => string): Tool {
  return {
    name,
    description: `fake ${name}`,
    parameters: { type: "object", properties: {} },
    execute,
  };
}

/**
 * A junior provider that calls one tool, inspects the model-facing result,
 * then either stops (small-result test) or asks `spill_read` for the marker's
 * id and captures the returned chunk.
 */
class SpillProbeProvider implements Provider {
  readonly seenMessages: ChatMessage[][] = [];
  readonly seenTools: string[][] = [];
  preview = "";
  retrieved = "";
  private step = 0;
  private readonly toolName: string;
  private readonly readSpill: boolean;
  private readonly chunkChars: number;

  constructor(toolName: string, readSpill: boolean, chunkChars = 1_000) {
    this.toolName = toolName;
    this.readSpill = readSpill;
    this.chunkChars = chunkChars;
  }

  async chat(): Promise<string> {
    return DELIVERABLE;
  }

  async chatWithTools(
    messages: ChatMessage[],
    tools: Tool[],
    _options: ToolChatOptions = {},
  ): Promise<ToolChatResponse> {
    this.seenMessages.push(messages.map((message) => ({ ...message })));
    this.seenTools.push(tools.map((tool) => tool.name));
    const lastTool = [...messages].reverse().find((message) => message.role === "tool");
    if (this.step === 0) {
      this.step = 1;
      return {
        content: "",
        toolCalls: [{ id: "call-big", name: this.toolName, args: {} }],
      };
    }
    if (this.step === 1) {
      this.preview = String(lastTool?.content ?? "");
      this.step = 2;
      if (!this.readSpill) return { content: DELIVERABLE, toolCalls: [] };
      const match = /\[\[SPILL id=([a-f0-9]{16,64}) chars=(\d+)\]\]/.exec(this.preview);
      assert.ok(match, `spill marker present in: ${this.preview.slice(0, 300)}`);
      return {
        content: "",
        toolCalls: [
          {
            id: "call-read",
            name: SPILL_READ_TOOL_NAME,
            args: { id: match[1], offset: 0, max_chars: this.chunkChars },
          },
        ],
      };
    }
    this.retrieved = String(lastTool?.content ?? "");
    return { content: DELIVERABLE, toolCalls: [] };
  }
}

function harnessFor(
  root: string,
  tool: Tool,
  provider: SpillProbeProvider,
  options: { maxInlineChars?: number; maxReadChars?: number } = {},
): TwoBrothersHarness {
  return new TwoBrothersHarness(resolveConfig({ provider: "mock", mode: "work" }), {
    senior: new MockProvider(),
    junior: provider,
    toolScopes: { shared: [tool] },
    spill: {
      root,
      ...(options.maxInlineChars !== undefined ? { maxInlineChars: options.maxInlineChars } : {}),
      ...(options.maxReadChars !== undefined ? { maxReadChars: options.maxReadChars } : {}),
    },
  });
}

// ---------------------------------------------------------------------------
// SpillStore: save, validation and bounded reads
// ---------------------------------------------------------------------------

test("save/read chunks with offset, continuation and exact totals", async () => {
  const tmp = tmpdir("tb-spill-store-");
  try {
    const store = new SpillStore(tmp.root);
    const text = "0123456789".repeat(4_000); // 40,000 chars
    const saved = await store.save(text, { tool: "demo", callId: "call-1" });

    assert.match(saved.id, /^[a-f0-9]{32}$/);
    assert.equal(saved.chars, text.length);
    assert.equal(saved.path, path.join(store.root, `${saved.id}.txt`));
    assert.equal(fs.readFileSync(saved.path, "utf8"), text, "full text persisted verbatim");

    const first = await store.read(saved.id, { offset: 0, maxChars: 1_000 });
    assert.equal(first.text, text.slice(0, 1_000));
    assert.equal(first.offset, 0);
    assert.equal(first.nextOffset, 1_000);
    assert.equal(first.totalChars, text.length);
    assert.equal(first.eof, false);

    const middle = await store.read(saved.id, { offset: 1_000, maxChars: 1_000 });
    assert.equal(middle.text, text.slice(1_000, 2_000));
    assert.equal(middle.nextOffset, 2_000);
    assert.equal(middle.eof, false);

    const last = await store.read(saved.id, { offset: text.length - 500, maxChars: 1_000 });
    assert.equal(last.text, text.slice(text.length - 500));
    assert.equal(last.nextOffset, text.length);
    assert.equal(last.eof, true);

    const past = await store.read(saved.id, { offset: text.length + 100, maxChars: 10 });
    assert.equal(past.text, "");
    assert.equal(past.offset, text.length);
    assert.equal(past.nextOffset, text.length);
    assert.equal(past.totalChars, text.length);
    assert.equal(past.eof, true);
  } finally {
    tmp.cleanup();
  }
});

test("invalid ids and traversal are rejected before any path is joined", async () => {
  const tmp = tmpdir("tb-spill-ids-");
  try {
    const store = new SpillStore(tmp.root);
    const saved = await store.save("secret");
    const bad = [
      "",
      "abc",
      "a".repeat(15),
      "a".repeat(65),
      "A".repeat(32), // uppercase is not the random-id alphabet
      "../secret",
      "..\\secret",
      `${saved.id}/../secret`,
      path.resolve("outside.txt"),
      `${saved.id}.txt`,
    ];
    for (const id of bad) {
      await assert.rejects(store.read(id), /invalid spill id/, JSON.stringify(id));
    }
    // The valid id still works and never escapes the root.
    const chunk = await store.read(saved.id);
    assert.equal(chunk.text, "secret");
    assert.ok(path.resolve(saved.path).startsWith(`${path.resolve(store.root)}${path.sep}`));
  } finally {
    tmp.cleanup();
  }
});

test("chunk size is capped at 16 KiB and offsets clamp safely", async () => {
  const tmp = tmpdir("tb-spill-caps-");
  try {
    const store = new SpillStore(tmp.root);
    const text = "x".repeat(50_000);
    const saved = await store.save(text);

    const one = await store.read(saved.id, { maxChars: 1 });
    assert.equal(one.text.length, 1);

    const huge = await store.read(saved.id, { offset: 0, maxChars: 999_999 });
    assert.equal(huge.text.length, SPILL_READ_MAX_CHARS);
    assert.equal(huge.nextOffset, SPILL_READ_MAX_CHARS);

    const zero = await store.read(saved.id, { maxChars: 0 });
    assert.equal(zero.text.length, 1, "zero clamps to one character");

    const negative = await store.read(saved.id, { offset: -50, maxChars: 10 });
    assert.equal(negative.offset, 0);
    assert.equal(negative.text, text.slice(0, 10));

    const beyond = await store.read(saved.id, { offset: 999_999, maxChars: 10 });
    assert.equal(beyond.text, "");
    assert.equal(beyond.offset, text.length);
    assert.equal(beyond.eof, true);
  } finally {
    tmp.cleanup();
  }
});

test("preview leaves small text untouched and stores only oversized text", async () => {
  const tmp = tmpdir("tb-spill-preview-");
  try {
    const store = new SpillStore(tmp.root);
    const small = "small output";
    const untouched = await spillPreview(small, store, {}, { maxInlineChars: 100 });
    assert.equal(untouched.text, small);
    assert.equal(untouched.spilled, false);
    assert.equal(untouched.saved, null);
    assert.equal(fs.readdirSync(store.root).length, 0, "no file for an inline result");

    const big = "H".repeat(100) + "M".repeat(30_000) + "T".repeat(100);
    const preview = await spillPreview(big, store, { tool: "big" }, {
      maxInlineChars: 2_000,
      maxReadChars: 500,
    });
    assert.equal(preview.spilled, true);
    assert.ok(preview.saved);
    const marker = spillMarker(preview.saved.id, preview.saved.chars);
    assert.ok(preview.text.includes(marker));
    assert.match(preview.text, /spill_read \{"id":"[a-f0-9]{32}","offset":0,"max_chars":500\}/);
    assert.ok(preview.text.length <= 2_000, `bounded preview (${preview.text.length})`);
    assert.ok(preview.text.startsWith("H"), "head kept");
    assert.ok(preview.text.includes("T"), "tail kept");
    assert.equal(fs.readFileSync(preview.saved.path, "utf8"), big);
  } finally {
    tmp.cleanup();
  }
});

test("write failure rejects so the caller can fall back", async () => {
  const tmp = tmpdir("tb-spill-fail-");
  try {
    const blocker = path.join(tmp.root, "blocker");
    fs.writeFileSync(blocker, "not a directory");
    const store = new SpillStore(path.join(blocker, "spill"));
    await assert.rejects(store.save("text"), /.+/);
  } finally {
    tmp.cleanup();
  }
});

// ---------------------------------------------------------------------------
// SpillStore: stats and age-based retention
// ---------------------------------------------------------------------------

/** A valid spill id (lowercase hex, 32 chars) derived from one digit. */
function spillId(digit: string): string {
  return digit.repeat(32);
}

/** Write one mock spill artifact, optionally backdating its mtime. */
function writeSpill(root: string, name: string, content: string, mtimeMs?: number): string {
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, name);
  fs.writeFileSync(file, content);
  if (mtimeMs !== undefined) {
    const date = new Date(mtimeMs);
    fs.utimesSync(file, date, date);
  }
  return file;
}

test("stats counts valid regular artifacts and their bytes only", async () => {
  const tmp = tmpdir("tb-spill-stats-");
  try {
    const store = new SpillStore(tmp.root);
    assert.deepEqual(store.stats(), { files: 0, bytes: 0 }, "missing root is empty");
    fs.mkdirSync(tmp.root, { recursive: true });

    writeSpill(tmp.root, `${spillId("a")}.txt`, "abc"); // 3 bytes
    writeSpill(tmp.root, `${spillId("b")}.txt`, "12345"); // 5 bytes
    writeSpill(tmp.root, `${spillId("c")}.TXT`, "ignored uppercase suffix");
    writeSpill(tmp.root, `${spillId("d").toUpperCase()}.txt`, "ignored uppercase id");
    writeSpill(tmp.root, ".tmp-1234567890abcdef", "ignored temp file");
    writeSpill(tmp.root, "notes.txt", "ignored malformed id");
    writeSpill(tmp.root, `${spillId("e")}.txt.bak`, "ignored other suffix");
    fs.mkdirSync(path.join(tmp.root, `${spillId("f")}.txt`), { recursive: true });

    // A symlink with a perfectly valid artifact name is not a regular file and
    // must never be followed (or counted). Windows may refuse symlink creation
    // without developer mode; that environment simply has no symlink case.
    const outside = path.join(tmp.root, "outside.txt");
    fs.writeFileSync(outside, "not a spill artifact");
    const link = path.join(tmp.root, `${spillId("9")}.txt`);
    let linked = false;
    try {
      fs.symlinkSync(outside, link, "file");
      linked = true;
    } catch {
      linked = false;
    }

    assert.deepEqual(store.stats(), { files: 2, bytes: 8 });
    if (linked) {
      assert.equal(fs.readFileSync(outside, "utf8"), "not a spill artifact");
    }
  } finally {
    tmp.cleanup();
  }
});

test("stats is empty for a missing root and refuses an unsafe one", async () => {
  const tmp = tmpdir("tb-spill-stats-fail-");
  try {
    const blocker = path.join(tmp.root, "blocker");
    fs.writeFileSync(blocker, "a file, not a directory");
    const notADir = new SpillStore(blocker);
    assert.throws(() => notADir.stats(), SpillRootUnsafeError);
    const missing = new SpillStore(path.join(tmp.root, "missing", "spill"));
    assert.deepEqual(missing.stats(), { files: 0, bytes: 0 });
  } finally {
    tmp.cleanup();
  }
});

test("a symlink/junction root is refused and external artifacts survive", async (t) => {
  const tmp = tmpdir("tb-spill-root-link-");
  try {
    const external = path.join(tmp.root, "external");
    fs.mkdirSync(external, { recursive: true });
    const externalFile = path.join(external, `${spillId("a")}.txt`);
    fs.writeFileSync(externalFile, "external artifact");
    const old = new Date(Date.now() - 10 * 86_400_000);
    fs.utimesSync(externalFile, old, old);
    const link = path.join(tmp.root, "spill");
    let linked = false;
    try {
      fs.symlinkSync(external, link, process.platform === "win32" ? "junction" : "dir");
      linked = true;
    } catch {
      linked = false;
    }
    if (!linked) {
      t.skip("host cannot create a directory symlink/junction; unsafe-root case skipped");
      return;
    }
    const store = new SpillStore(link);
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true, "link is a symlink/junction");
    assert.throws(() => store.stats(), SpillRootUnsafeError);
    assert.throws(() => store.prune({ olderThanMs: 1_000 }), SpillRootUnsafeError);
    await assert.rejects(store.save("new text"), SpillRootUnsafeError);
    await assert.rejects(store.read(spillId("a")), SpillRootUnsafeError);
    assert.equal(fs.readFileSync(externalFile, "utf8"), "external artifact");
    assert.deepEqual(fs.readdirSync(external), [`${spillId("a")}.txt`]);
  } finally {
    tmp.cleanup();
  }
});

test("prune removes stale temp files but keeps recent ones and never counts them as artifacts", async () => {
  const tmp = tmpdir("tb-spill-temp-");
  try {
    const store = new SpillStore(tmp.root);
    const now = Date.UTC(2026, 0, 2);
    const old = now - 86_400_000;
    const stale = writeSpill(tmp.root, `.tmp-${spillId("a")}`, "stale temp", old);
    const recent = writeSpill(tmp.root, `.tmp-${spillId("b")}`, "recent temp", now);
    const artifact = writeSpill(tmp.root, `${spillId("c")}.txt`, "artifact", now);

    const dry = store.prune({ olderThanMs: 60_000, now, dryRun: true });
    assert.equal(dry.tempsRemoved, 1);
    assert.equal(dry.tempBytes, Buffer.byteLength("stale temp"));
    assert.equal(fs.existsSync(stale), true, "dry run removes no temp file");

    const real = store.prune({ olderThanMs: 60_000, now });
    assert.equal(real.filesBefore, 1);
    assert.equal(real.removed, 0);
    assert.equal(real.kept, 1);
    assert.equal(real.filesAfter, 1);
    assert.equal(real.tempsRemoved, 1);
    assert.equal(real.tempBytes, Buffer.byteLength("stale temp"));
    assert.equal(fs.existsSync(stale), false);
    assert.equal(fs.existsSync(recent), true, "recent temp kept");
    assert.equal(fs.existsSync(artifact), true, "artifact kept");
  } finally {
    tmp.cleanup();
  }
});

test("prune uses a strict age boundary and a dry run is pure", async () => {
  const tmp = tmpdir("tb-spill-prune-");
  try {
    const store = new SpillStore(tmp.root);
    const now = Date.UTC(2026, 0, 2, 3, 4, 5);
    const age = 60_000;
    const cutoff = now - age;
    const oldText = "old artifact";
    const boundaryText = "boundary artifact";
    const freshText = "fresh artifact";
    const oldFile = writeSpill(tmp.root, `${spillId("a")}.txt`, oldText, cutoff - 1);
    const boundaryFile = writeSpill(tmp.root, `${spillId("b")}.txt`, boundaryText, cutoff);
    const freshFile = writeSpill(tmp.root, `${spillId("c")}.txt`, freshText, now);

    const dry = store.prune({ olderThanMs: age, now, dryRun: true });
    assert.equal(dry.dryRun, true);
    assert.equal(dry.filesBefore, 3);
    assert.equal(dry.removed, 1, "only the strictly older file would go");
    assert.equal(dry.kept, 2);
    assert.equal(dry.bytes, Buffer.byteLength(oldText));
    assert.equal(dry.filesAfter, 2);
    assert.equal(dry.failed, 0);
    assert.deepEqual(dry.errors, []);
    for (const file of [oldFile, boundaryFile, freshFile]) {
      assert.equal(fs.existsSync(file), true, `dry run kept ${file}`);
    }

    const real = store.prune({ olderThanMs: age, now });
    assert.equal(real.dryRun, false);
    assert.equal(real.filesBefore, 3);
    assert.equal(real.removed, 1);
    assert.equal(real.kept, 2);
    assert.equal(real.bytes, Buffer.byteLength(oldText));
    assert.equal(real.filesAfter, 2);
    assert.equal(fs.existsSync(oldFile), false, "old artifact removed");
    assert.equal(fs.existsSync(boundaryFile), true, "boundary artifact kept");
    assert.equal(fs.existsSync(freshFile), true, "fresh artifact kept");
    assert.deepEqual(store.stats(), {
      files: 2,
      bytes: Buffer.byteLength(boundaryText) + Buffer.byteLength(freshText),
    });
  } finally {
    tmp.cleanup();
  }
});

test("prune ignores malformed names, temp files, directories and symlinks", async () => {
  const tmp = tmpdir("tb-spill-prune-skip-");
  try {
    const store = new SpillStore(tmp.root);
    const now = Date.UTC(2026, 0, 2);
    const old = now - 86_400_000;
    const validName = `${spillId("a")}.txt`;
    const tempFile = writeSpill(tmp.root, ".tmp-not-a-valid-id", "temp", old);
    const malformed = writeSpill(tmp.root, "notes.txt", "malformed", old);
    const uppercase = writeSpill(
      tmp.root,
      `${spillId("b").toUpperCase()}.txt`,
      "uppercase id",
      old,
    );
    const wrongSuffix = writeSpill(tmp.root, `${spillId("c")}.log`, "log", old);
    const shortId = writeSpill(tmp.root, "abc.txt", "short", old);
    const directory = path.join(tmp.root, validName);
    fs.mkdirSync(directory);

    const outside = path.join(tmp.root, "outside-target.txt");
    fs.writeFileSync(outside, "outside");
    const link = path.join(tmp.root, `${spillId("d")}.txt`);
    let linked = false;
    try {
      fs.symlinkSync(outside, link, "file");
      linked = true;
    } catch {
      linked = false;
    }

    const result = store.prune({ olderThanMs: 60_000, now });
    assert.equal(result.filesBefore, 0, "no skip target counts as an artifact");
    assert.equal(result.removed, 0);
    assert.equal(result.kept, 0);
    assert.equal(result.bytes, 0);
    assert.equal(result.failed, 0);
    for (const file of [tempFile, malformed, uppercase, wrongSuffix, shortId]) {
      assert.equal(fs.existsSync(file), true, `kept ${path.basename(file)}`);
    }
    assert.equal(fs.existsSync(directory), true, "directory kept");
    assert.equal(fs.readFileSync(outside, "utf8"), "outside");
    if (linked) {
      assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
      assert.equal(fs.existsSync(link), true, "symlink kept");
    }
  } finally {
    tmp.cleanup();
  }
});

test("prune rejects a non-positive or non-finite age and misses fail-soft", async () => {
  const tmp = tmpdir("tb-spill-prune-bad-");
  try {
    const store = new SpillStore(tmp.root);
    for (const olderThanMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      assert.throws(
        () => store.prune({ olderThanMs }),
        /positive finite number/,
        String(olderThanMs),
      );
    }
    // A missing root is an empty store for pruning too; nothing is created.
    const missing = new SpillStore(path.join(tmp.root, "missing", "spill"));
    const result = missing.prune({ olderThanMs: 1_000 });
    assert.deepEqual(
      {
        removed: result.removed,
        kept: result.kept,
        bytes: result.bytes,
        failed: result.failed,
        filesBefore: result.filesBefore,
        filesAfter: result.filesAfter,
      },
      { removed: 0, kept: 0, bytes: 0, failed: 0, filesBefore: 0, filesAfter: 0 },
    );
    assert.equal(fs.existsSync(path.join(tmp.root, "missing", "spill")), false);
  } finally {
    tmp.cleanup();
  }
});

// ---------------------------------------------------------------------------
// harness wiring
// ---------------------------------------------------------------------------

test("oversized tool result spills and spill_read retrieves the full text", async () => {
  const tmp = tmpdir("tb-spill-wire-");
  try {
    const big = "H".repeat(10_000) + "M".repeat(30_000) + "T".repeat(10_000);
    const provider = new SpillProbeProvider("big_tool", true, 1_000);
    const harness = harnessFor(
      tmp.root,
      fakeTool("big_tool", () => big),
      provider,
      { maxInlineChars: 2_000, maxReadChars: 1_000 },
    );
    const result = await harness.run("run the big tool");

    assert.deepEqual(result.errors, [], "spill is not a run error");
    assert.deepEqual(
      result.warnings.filter((line) => line.includes("spill")),
      [],
      "no spill warning on a successful save",
    );
    assert.ok(provider.preview.includes("[[SPILL id="), "model saw a spill marker");
    assert.ok(!provider.preview.includes(big), "full text did not reach the model");
    assert.ok(provider.preview.length <= 2_100, `preview bounded (${provider.preview.length})`);
    assert.match(provider.preview, /Full output saved; read it in chunks with spill_read/);

    // The next round offered spill_read, and the retrieval tool returned the
    // first 1,000 characters with continuation metadata.
    assert.ok(
      provider.seenTools.some((names) => names.includes(SPILL_READ_TOOL_NAME)),
      "spill_read offered after the spill",
    );
    assert.ok(provider.retrieved.includes(big.slice(0, 1_000)));
    assert.match(provider.retrieved, /\[\[SPILL_READ id=[a-f0-9]{32} offset=0 next=1000 total=\d+\]\]/);

    // The spilled file reconstructs the exact original.
    const store = new SpillStore(tmp.root);
    const marker = /\[\[SPILL id=([a-f0-9]{32}) chars=(\d+)\]\]/.exec(provider.preview);
    assert.ok(marker);
    const saved = await store.read(marker[1]);
    assert.equal(saved.totalChars, big.length);
    const full = fs.readFileSync(
      path.join(store.root, `${marker[1]}.txt`),
      "utf8",
    );
    assert.equal(full, big);

    // Shared scope: the senior's verification belt sees the retrieval tool too.
    const seniorVerify = result.promptAudits.find(
      (audit) => audit.role === "senior" && audit.kind === "verify",
    );
    if (seniorVerify !== undefined) {
      assert.ok(seniorVerify.tools.includes(SPILL_READ_TOOL_NAME));
    }
  } finally {
    tmp.cleanup();
  }
});

test("a small tool result is byte-identical and creates no spill file", async () => {
  const tmp = tmpdir("tb-spill-small-");
  try {
    const small = "small output";
    const provider = new SpillProbeProvider("small_tool", false);
    const harness = harnessFor(tmp.root, fakeTool("small_tool", () => small), provider, {
      maxInlineChars: 2_000,
    });
    const result = await harness.run("run the small tool");
    assert.deepEqual(result.errors, []);
    assert.equal(provider.preview, small);
    assert.ok(!provider.preview.includes("[[SPILL"), "no marker for a small result");
    assert.equal(fs.readdirSync(tmp.root).length, 0, "no spill file for a small result");
  } finally {
    tmp.cleanup();
  }
});

test("spill storage failure is fail-soft: clipped text plus one warning", async () => {
  const tmp = tmpdir("tb-spill-fallback-");
  try {
    const blocker = path.join(tmp.root, "blocker");
    fs.writeFileSync(blocker, "not a directory");
    const big = "H".repeat(100) + "M".repeat(30_000) + "T".repeat(100);
    const provider = new SpillProbeProvider("big_tool", false);
    const harness = harnessFor(path.join(blocker, "spill"), fakeTool("big_tool", () => big), provider, {
      maxInlineChars: 1_000,
    });
    const result = await harness.run("run the big tool");

    assert.deepEqual(result.errors, [], "a spill failure never fails the run");
    assert.equal(result.warnings.filter((line) => line.includes("spill failed")).length, 1);
    assert.match(provider.preview, /\.\.\.\[truncated \d+ chars\]\.\.\./);
    assert.ok(!provider.preview.includes("[[SPILL id="), "no marker when storage failed");
    assert.ok(provider.preview.length < big.length);
  } finally {
    tmp.cleanup();
  }
});
