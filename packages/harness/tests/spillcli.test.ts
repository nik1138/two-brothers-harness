/**
 * CLI `spill stats` / `spill gc`: operator retention over `<sessions-dir>/spill`.
 *
 * Hermetic, in-process (`main(argv, io)`): temp directories, no server, no
 * network. Covers the human/JSON output, the required age, dry-run purity,
 * malformed durations (exit 2), the single-writer lock refusal and --force,
 * and the missing-store no-op.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { main, type CliIO } from "../src/cli.ts";
import { SessionLayout } from "../src/sessionlayout.ts";

function makeIO(): CliIO & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    log: (line) => out.push(line),
    error: (line) => err.push(line),
  };
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-spill-cli-"));
  try {
    await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function spillId(digit: string): string {
  return digit.repeat(32);
}

/** Write one valid spill artifact under `<sessionsDir>/spill`. */
function writeSpill(
  sessionsDir: string,
  id: string,
  content: string,
  mtimeMs?: number,
): string {
  const root = path.join(sessionsDir, "spill");
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, `${id}.txt`);
  fs.writeFileSync(file, content);
  if (mtimeMs !== undefined) {
    const date = new Date(mtimeMs);
    fs.utimesSync(file, date, date);
  }
  return file;
}

test("spill stats: human, JSON and a missing store", async () => {
  await withTempDir(async (dir) => {
    writeSpill(dir, spillId("a"), "abc");
    writeSpill(dir, spillId("b"), "12345");

    const io = makeIO();
    assert.equal(await main(["spill", "stats", "--sessions-dir", dir], io), 0);
    assert.deepEqual(io.err, []);
    assert.equal(io.out.length, 1);
    assert.equal(
      io.out[0],
      `2 spill file(s), 8 bytes in ${path.resolve(dir, "spill")}`,
    );

    const json = makeIO();
    assert.equal(
      await main(["spill", "stats", "--sessions-dir", dir, "--json"], json),
      0,
    );
    assert.deepEqual(JSON.parse(json.out[0]), {
      root: path.resolve(dir, "spill"),
      files: 2,
      bytes: 8,
    });

    const missingDir = path.join(dir, "does-not-exist");
    const missing = makeIO();
    assert.equal(
      await main(["spill", "stats", "--sessions-dir", missingDir], missing),
      0,
    );
    assert.deepEqual(missing.out, [
      `no spill files in ${path.resolve(missingDir, "spill")}`,
    ]);
    assert.equal(fs.existsSync(missingDir), false, "stats never creates the store");
  });
});

test("spill gc: dry run is pure, then the real pass removes only old files", async () => {
  await withTempDir(async (dir) => {
    const now = Date.now();
    const oldFile = writeSpill(dir, spillId("a"), "old artifact", now - 2 * 86_400_000);
    const freshFile = writeSpill(dir, spillId("b"), "fresh artifact", now);

    const dry = makeIO();
    assert.equal(
      await main(
        ["spill", "gc", "--sessions-dir", dir, "--older-than", "1d", "--dry-run"],
        dry,
      ),
      0,
      dry.err.join("\n"),
    );
    assert.equal(fs.existsSync(oldFile), true, "dry run deletes nothing");
    assert.equal(fs.existsSync(freshFile), true);
    assert.match(dry.out[0], /would remove 1 of 2 spill file\(s\) older than 1d \(12 bytes\); 1 would be kept/);

    const dryJson = makeIO();
    assert.equal(
      await main(
        [
          "spill",
          "gc",
          "--sessions-dir",
          dir,
          "--older-than",
          "1d",
          "--dry-run",
          "--json",
        ],
        dryJson,
      ),
      0,
    );
    const parsed = JSON.parse(dryJson.out[0]);
    assert.equal(parsed.dry_run, true);
    assert.equal(parsed.older_than, "1d");
    assert.equal(parsed.older_than_ms, 86_400_000);
    assert.equal(parsed.removed, 1);
    assert.equal(parsed.kept, 1);
    assert.equal(parsed.bytes, Buffer.byteLength("old artifact"));
    assert.equal(parsed.failed, 0);
    assert.equal(parsed.files_before, 2);
    assert.equal(parsed.files_after, 1);
    assert.deepEqual(parsed.errors, []);
    assert.equal(parsed.root, path.resolve(dir, "spill"));
    assert.equal(fs.existsSync(oldFile), true);

    const real = makeIO();
    assert.equal(
      await main(
        ["spill", "gc", "--sessions-dir", dir, "--older-than", "1d"],
        real,
      ),
      0,
      real.err.join("\n"),
    );
    assert.equal(fs.existsSync(oldFile), false);
    assert.equal(fs.existsSync(freshFile), true);
    assert.match(real.out[0], /removed 1 of 2 spill file\(s\) older than 1d \(12 bytes\); 1 kept/);
    assert.equal(fs.existsSync(path.join(dir, ".writer.json")), false, "lock released");
  });
});

test("spill gc requires a valid --older-than and rejects bad durations (exit 2)", async () => {
  await withTempDir(async (dir) => {
    const file = writeSpill(dir, spillId("a"), "keep me", Date.now() - 10 * 86_400_000);

    const missing = makeIO();
    assert.equal(
      await main(["spill", "gc", "--sessions-dir", dir], missing),
      2,
    );
    assert.ok(missing.err.some((line) => line.includes("missing --older-than")));

    for (const value of ["1", "0d", "-1d", "1w", "abc", "1.5d", "01d", "d"]) {
      const io = makeIO();
      const flag = value.startsWith("-") ? `--older-than=${value}` : "--older-than";
      const args = flag.startsWith("--older-than=")
        ? ["spill", "gc", "--sessions-dir", dir, flag]
        : ["spill", "gc", "--sessions-dir", dir, flag, value];
      assert.equal(
        await main(args, io),
        2,
        value,
      );
      assert.ok(
        io.err.some((line) => line.includes("invalid --older-than")),
        `${value}: ${io.err.join("\n")}`,
      );
    }
    // `--older-than -1d` is rejected by the parser itself (option-like value);
    // either way it is a usage error and deletes nothing.
    const dashValue = makeIO();
    assert.equal(
      await main(
        ["spill", "gc", "--sessions-dir", dir, "--older-than", "-1d"],
        dashValue,
      ),
      2,
    );
    assert.equal(fs.existsSync(file), true, "bad invocations never delete");
  });
});

test("spill gc: unknown or extra subcommands are usage errors", async () => {
  const unknown = makeIO();
  assert.equal(await main(["spill", "sweep"], unknown), 2);
  assert.ok(unknown.err.some((line) => line.includes("spill takes 'stats' or 'gc'")));

  const extra = makeIO();
  assert.equal(
    await main(["spill", "stats", "extra"], extra),
    2,
  );
  assert.ok(extra.err.some((line) => line.includes("unexpected argument: extra")));
});

test("spill gc refuses a live writer and --force bypasses the lock", async () => {
  await withTempDir(async (dir) => {
    const file = writeSpill(dir, spillId("a"), "old", Date.now() - 2 * 86_400_000);
    const layout = new SessionLayout(dir);
    const release = layout.acquireWriterLock("writer");
    try {
      const refused = makeIO();
      assert.equal(
        await main(
          ["spill", "gc", "--sessions-dir", dir, "--older-than", "1d"],
          refused,
        ),
        1,
      );
      assert.ok(
        refused.err.some((line) => line.includes("in use by writer")),
        refused.err.join("\n"),
      );
      assert.ok(
        refused.err.some((line) => line.includes("pass --force")),
        refused.err.join("\n"),
      );
      assert.equal(fs.existsSync(file), true, "refusal deletes nothing");

      const forced = makeIO();
      assert.equal(
        await main(
          [
            "spill",
            "gc",
            "--sessions-dir",
            dir,
            "--older-than",
            "1d",
            "--force",
          ],
          forced,
        ),
        0,
        forced.err.join("\n"),
      );
      assert.equal(fs.existsSync(file), false);
    } finally {
      release();
    }
  });
});

test("spill gc on a missing sessions directory is a no-op and creates nothing", async () => {
  await withTempDir(async (dir) => {
    const missing = path.join(dir, "does-not-exist");
    const io = makeIO();
    assert.equal(
      await main(
        ["spill", "gc", "--sessions-dir", missing, "--older-than", "1d"],
        io,
      ),
      0,
      io.err.join("\n"),
    );
    assert.deepEqual(io.out, [
      `no spill files older than 1d in ${path.resolve(missing, "spill")}`,
    ]);
    assert.equal(fs.existsSync(missing), false);
  });
});
