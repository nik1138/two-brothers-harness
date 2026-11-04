/**
 * In-process CLI tests: the `sessions` listing and argument-parsing edges,
 * driven through `main(argv, io)` so no TTY or child process is needed.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

import { deriveTitle, isCliEntry, main, type CliIO } from "../src/cli.ts";

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

let fakeSeq = 0;

function envelope(
  from: string,
  kind: string,
  payload: Record<string, unknown>,
): string {
  fakeSeq += 1;
  return JSON.stringify({
    v: 1,
    id: `id-${fakeSeq}`,
    seq: fakeSeq,
    ts: "2026-11-01T00:00:00Z",
    from,
    to: from === "user" ? "senior" : "user",
    kind,
    payload,
  });
}

function userMessage(text: string): string {
  return envelope("user", "message", { text });
}

function consult(): string {
  return envelope("senior", "consult", { task: "t", ask: "a", expect: "proposal" });
}

function writeSession(dir: string, name: string, lines: string[]): void {
  fs.writeFileSync(path.join(dir, name), lines.join("\n") + "\n", "utf-8");
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-cli-test-"));
  try {
    await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("sessions: missing directory prints a friendly message", async () => {
  const io = makeIO();
  const code = await main(["sessions", "--sessions-dir", "/nonexistent/tb-path"], io);
  assert.equal(code, 0);
  assert.deepEqual(io.out, ["no session files in /nonexistent/tb-path"]);
  assert.deepEqual(io.err, []);
});

test("sessions: empty directory prints a friendly message", async () => {
  await withTempDir(async (dir) => {
    const io = makeIO();
    const code = await main(["sessions", "--sessions-dir", dir], io);
    assert.equal(code, 0);
    assert.deepEqual(io.out, [`no session files in ${dir}`]);
  });
});

test("sessions: default sessions-dir is 'sessions'", async () => {
  // The default resolves against process.cwd(); run from an empty temp cwd
  // so the test never reads (or races with) a real ./sessions directory.
  // cwd is restored even when the assertion fails.
  await withTempDir(async (dir) => {
    const cwd = process.cwd();
    try {
      process.chdir(dir);
      const io = makeIO();
      const code = await main(["sessions"], io);
      assert.equal(code, 0);
      assert.deepEqual(io.out, ["no session files in sessions"]);
    } finally {
      process.chdir(cwd);
    }
  });
});

test("sessions: lists titles, envelope counts and update times", async () => {
  await withTempDir(async (dir) => {
    writeSession(dir, "alpha.jsonl", [
      userMessage("Fix the flaky   login test"),
      consult(),
      envelope("junior", "proposal", { title: "Plan", answer: "Do it" }),
    ]);
    writeSession(dir, "beta.jsonl", [consult(), userMessage("Second session task")]);
    // no user message at all -> title falls back to the file stem
    writeSession(dir, "gamma.jsonl", [consult(), consult()]);
    // non-jsonl files are ignored
    fs.writeFileSync(path.join(dir, "notes.txt"), "hello\n", "utf-8");

    const io = makeIO();
    const code = await main(["sessions", "--sessions-dir", dir], io);
    assert.equal(code, 0);
    assert.equal(io.out.length, 4, io.out.join("\n"));
    assert.equal(
      io.out[0],
      `${"session".padEnd(28)} ${"title".padEnd(44)} ${"envelopes".padStart(9)} updated`,
    );

    const byName = new Map(io.out.slice(1).map((line) => [line.slice(0, 28).trim(), line]));
    const alpha = byName.get("alpha.jsonl");
    assert.ok(alpha, "alpha.jsonl listed");
    assert.ok(alpha.includes("Fix the flaky login test"), alpha);
    assert.match(alpha, /\s3\s+\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/, alpha);

    const beta = byName.get("beta.jsonl");
    assert.ok(beta, "beta.jsonl listed");
    assert.ok(beta.includes("Second session task"), beta);
    assert.match(beta, /\s2\s+\d{4}/, beta);

    const gamma = byName.get("gamma.jsonl");
    assert.ok(gamma, "gamma.jsonl listed");
    assert.ok(gamma.includes("gamma"), gamma); // stem fallback title
  });
});

test("deriveTitle: collapses whitespace, truncates at 80 chars with ellipsis", () => {
  const events = [
    { from: "senior", kind: "consult", payload: {} },
    { from: "user", kind: "message", payload: { text: "  many   spaces\there " } },
    { from: "user", kind: "message", payload: { text: "ignored second message" } },
  ];
  assert.equal(deriveTitle(events, "fallback"), "many spaces here");

  const long = "word ".repeat(30).trim(); // 149 chars
  const truncated = deriveTitle(
    [{ from: "user", kind: "message", payload: { text: long } }],
    "fallback",
  );
  assert.equal(truncated.length, 81); // 80 chars + ellipsis
  assert.ok(truncated.endsWith("…"));

  const plain = "word ".repeat(15).trim(); // 74 chars, under the limit
  assert.equal(
    deriveTitle([{ from: "user", kind: "message", payload: { text: plain } }], "fallback"),
    plain,
  );
});

test("deriveTitle: fallback for missing/blank user messages", () => {
  assert.equal(deriveTitle([], "my-stem"), "my-stem");
  assert.equal(deriveTitle(null as never, ""), "Untitled session");
  assert.equal(
    deriveTitle([{ from: "user", kind: "message", payload: { text: "   " } }], "stem"),
    "stem",
  );
  // only kind "message" envelopes count
  assert.equal(
    deriveTitle([{ from: "user", kind: "decision", payload: { text: "nope" } }], "stem"),
    "stem",
  );
});

test("sessions: title column truncates long titles for display", async () => {
  await withTempDir(async (dir) => {
    const long = "abcdefghij ".repeat(8).trim(); // 87 chars
    writeSession(dir, "long.jsonl", [userMessage(long)]);
    const io = makeIO();
    await main(["sessions", "--sessions-dir", dir], io);
    const title = io.out[1].slice(29, 73); // name column (28) + separator
    assert.equal(title.length, 44);
    assert.ok(long.startsWith(title.trimEnd()), title);
  });
});

test("sessions: corrupt lines get an error marker without crashing", async () => {
  await withTempDir(async (dir) => {
    writeSession(dir, "good.jsonl", [userMessage("Healthy session")]);
    writeSession(dir, "bad.jsonl", [userMessage("Half session"), "{not json"]);
    const io = makeIO();
    const code = await main(["sessions", "--sessions-dir", dir], io);
    assert.equal(code, 0);
    const lines = io.out.slice(1);
    const good = lines.find((l) => l.startsWith("good.jsonl"));
    const bad = lines.find((l) => l.startsWith("bad.jsonl"));
    assert.ok(good && !good.includes("[error"), good);
    assert.ok(bad, "bad.jsonl still listed");
    assert.ok(bad.includes("[error: corrupt line 2]"), bad);
    assert.ok(bad.includes("Half session"), bad); // title from parseable prefix
    assert.match(bad, /\s1\s+\d{4}/, bad); // one parseable envelope counted
  });
});

test("sessions: non-object JSON lines count as corrupt", async () => {
  await withTempDir(async (dir) => {
    writeSession(dir, "arr.jsonl", ["[1,2,3]"]);
    const io = makeIO();
    const code = await main(["sessions", "--sessions-dir", dir], io);
    assert.equal(code, 0);
    assert.ok(io.out[1].includes("[error: corrupt line 1]"), io.out[1]);
  });
});

test("run: missing task is an error, not a crash", async () => {
  const io = makeIO();
  const code = await main(["run"], io);
  assert.equal(code, 2);
  assert.match(io.err.join("\n"), /no task given/);
});

test("run: unknown --provider value surfaces a config error", async () => {
  const io = makeIO();
  await assert.rejects(main(["run", "task", "--provider", "bogus"], io), /invalid provider/);
});

test("unknown command prints help and exits 2", async () => {
  const io = makeIO();
  const code = await main(["bogus"], io);
  assert.equal(code, 2);
  assert.match(io.err.join("\n"), /Unknown command: bogus/);
  assert.match(io.out.join("\n"), /two-brothers run "<task>"/);
});

test("no arguments prints help and exits 0", async () => {
  const io = makeIO();
  const code = await main([], io);
  assert.equal(code, 0);
  assert.match(io.out.join("\n"), /sessions \[--sessions-dir/);
});

test("help aliases print help and exit 0 (no Unknown command)", async () => {
  for (const alias of ["help", "--help", "-h"]) {
    const io = makeIO();
    const code = await main([alias], io);
    assert.equal(code, 0, alias);
    assert.doesNotMatch(io.err.join("\n"), /Unknown command/, alias);
    assert.match(io.out.join("\n"), /two-brothers run "<task>"/, alias);
  }
});

test("sessions: rejects unexpected positional arguments", async () => {
  const io = makeIO();
  await assert.rejects(main(["sessions", "extra"], io), /unexpected argument/i);
});

// ---------------------------------------------------------------------------
// Entry-point detection: npm's POSIX `.bin` is a symlink, so argv[1] carries
// the link path while `import.meta.url` resolves the real file — a plain
// string comparison there silently skipped `main()`.
// ---------------------------------------------------------------------------

test("isCliEntry: realpath comparison unit cases", () => {
  const here = fileURLToPath(import.meta.url);
  assert.equal(isCliEntry(import.meta.url, here), true, "same file via its own path");
  assert.equal(
    isCliEntry(import.meta.url, path.join(here, "..", "run-all.ts")),
    false,
    "a sibling file is not the entry",
  );
  assert.equal(
    isCliEntry(import.meta.url, path.join(here, "missing.ts")),
    false,
    "an unreadable path is not the entry",
  );
  assert.equal(isCliEntry(import.meta.url, undefined), false, "no argv[1]");
});

test("CLI runs through a symlinked entry (npm .bin parity)", async (t) => {
  await withTempDir(async (dir) => {
    // Extensionless like the POSIX bin; Windows needs an extension for the
    // loader to pick the module format from the link name.
    const link = path.join(
      dir,
      process.platform === "win32" ? "two-brothers.js" : "two-brothers",
    );
    const target = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
    try {
      fs.symlinkSync(target, link, "file");
    } catch (exc) {
      t.skip(`symlinks unavailable here: ${exc instanceof Error ? exc.message : String(exc)}`);
      return;
    }

    const pkg = JSON.parse(
      fs.readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf-8"),
    ) as { version: string };

    // Before the realpath fix both invocations exited 0 with no output.
    const version = spawnSync(process.execPath, [link, "--version"], { encoding: "utf-8" });
    assert.equal(version.status, 0, version.stderr);
    assert.equal(version.stdout.trim(), pkg.version, "symlinked --version prints the version");

    const help = spawnSync(process.execPath, [link, "--help"], { encoding: "utf-8" });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /two-brothers run "<task>"/, "symlinked --help prints usage");

    const selftest = spawnSync(process.execPath, [link, "selftest"], { encoding: "utf-8" });
    assert.equal(selftest.status, 0, selftest.stderr);
    assert.match(selftest.stdout, /SELFTEST: PASS/, "symlinked selftest runs");
  });
});
