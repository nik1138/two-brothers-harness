/**
 * In-process CLI tests: the `sessions` listing and argument-parsing edges,
 * driven through `main(argv, io)` so no TTY or child process is needed.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

import { deriveTitle, isCliEntry, main, workModeWithoutToolsWarning, type CliIO } from "../src/cli.ts";
import { resolveCliStyle } from "../src/clistyle.ts";

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

/**
 * A sink that reports an interactive stdout: the injectable TTY signal the
 * live transcript keys on (`CliIO.isTTY`). stdout is not a real terminal in
 * tests, so this is how live mode is exercised hermetically.
 */
function makeTTYIO(): CliIO & { out: string[]; err: string[] } {
  return { ...makeIO(), isTTY: true };
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

// ---------------------------------------------------------------------------
// human text layout + machine-mode purity (slice 2)
// ---------------------------------------------------------------------------

/** Strip every SGR sequence (the CLI theme is the only escape source). */
function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/** The 16-color style the CLI resolves on a depth-4 TTY. */
function ansi16Style(): ReturnType<typeof resolveCliStyle> {
  return resolveCliStyle({ depth: 4, env: {} });
}

/**
 * The stable part of one machine-output object: protocol ids and timestamps are
 * generated per run, so parity is asserted with those volatile fields
 * normalized.
 */
function normalizeMachineOutput(line: string): string {
  const parsed = JSON.parse(line) as {
    events: Array<Record<string, unknown>>;
    [key: string]: unknown;
  };
  return JSON.stringify({
    ...parsed,
    events: parsed.events.map((event) => ({ ...event, id: "<id>", ts: "<ts>" })),
  });
}

/**
 * `TWO_BROTHERS_JSON` is the env spelling of a bare `--json` (contract
 * alignment): a real spawned CLI must produce the same machine output either
 * way, with no escapes despite FORCE_COLOR.
 */
test("spawned CLI: TWO_BROTHERS_JSON=1 matches bare --json output", () => {
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const env: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: "3" };
  for (const key of Object.keys(env)) {
    if (key.startsWith("TWO_BROTHERS_") || key === "NO_COLOR") delete env[key];
  }
  const run = (extraEnv: NodeJS.ProcessEnv, args: string[]) => {
    const result = spawnSync(
      process.execPath,
      [cli, "run", "pick an approach", "--provider", "mock", ...args],
      { encoding: "utf-8", env: { ...env, ...extraEnv }, timeout: 60_000 },
    );
    assert.equal(result.status, 0, result.stderr ?? String(result.error));
    return result;
  };

  const flag = run({}, ["--json"]);
  const envVar = run({ TWO_BROTHERS_JSON: "1" }, []);
  const envTrue = run({ TWO_BROTHERS_JSON: "true" }, []);

  assert.equal(flag.stdout.trim().split("\n").length, 1, "one machine line");
  for (const result of [envVar, envTrue]) {
    const lines = result.stdout.trim().split("\n");
    assert.equal(lines.length, 1, "one machine line");
    assert.equal(result.stderr, "", "a clean machine run keeps stderr silent");
    assert.ok(!result.stdout.includes("\u001b"), "machine output carries no escapes");
    assert.equal(
      normalizeMachineOutput(lines[0]),
      normalizeMachineOutput(flag.stdout.trim()),
      "env and flag must produce the same machine object",
    );
  }
});

const MOCK_RUN_ARGS = ["run", "pick an approach", "--provider", "mock"] as const;

test("run: text mode renders separated blocks, a ruled decision and the compact footer", async () => {
  const io = makeIO();
  const code = await main([...MOCK_RUN_ARGS], io);
  assert.equal(code, 0, io.err.join("\n"));
  const text = io.out.join("\n");
  assert.ok(!text.includes("\x1b"), "a custom io must stay plain");
  assert.match(text, /^\[user\]\s+pick an approach$/m);
  // a blank line separates every pair of envelope blocks
  assert.match(text, /\n\n\[senior -> junior\] consult\n/);
  assert.match(text, /\n\n\[junior -> senior\] proposal\n/);
  assert.match(text, /\n\n\[senior -> junior\] review\n/);
  // the decision block is ruled off with a width-capped label
  assert.match(text, /\n\n── decision ─+$/m);
  assert.match(text, /^\[senior -> user\] decision$/m);
  // the compact human footer replaces the machine `tokens:` line in text mode
  assert.match(text, /^tokens \d+ in \/ \d+ out · \d+ calls?$/m);
  assert.match(text, /\n\ntokens \d+ in \/ \d+ out · \d+ calls?$/);
  assert.doesNotMatch(text, /^tokens:/m, "text mode must not print the print-mode footer");
});

test("run: an explicit colored style paints the text transcript and strips back", async () => {
  const plainIO = makeIO();
  assert.equal(await main([...MOCK_RUN_ARGS], plainIO), 0, plainIO.err.join("\n"));
  const coloredIO = makeIO();
  assert.equal(await main([...MOCK_RUN_ARGS], coloredIO, ansi16Style()), 0);
  const colored = coloredIO.out.join("\n");
  assert.ok(colored.includes("\x1b"), "an explicit style must paint the text transcript");
  assert.equal(stripAnsi(colored), plainIO.out.join("\n"));
  assert.equal(stripAnsi(coloredIO.err.join("\n")), plainIO.err.join("\n"));
});

test("run: machine output modes stay escape-free under an explicit colored style", async () => {
  const cases: Array<{ label: string; args: string[] }> = [
    { label: "--json", args: [...MOCK_RUN_ARGS, "--json"] },
    { label: "--json-events", args: [...MOCK_RUN_ARGS, "--json-events"] },
    { label: "--mode print", args: [...MOCK_RUN_ARGS, "--mode", "print"] },
    { label: "--stream", args: [...MOCK_RUN_ARGS, "--stream"] },
    { label: "--dry-run", args: [...MOCK_RUN_ARGS, "--dry-run"] },
  ];
  for (const { label, args } of cases) {
    const io = makeIO();
    assert.equal(await main(args, io, ansi16Style()), 0, `${label}: ${io.err.join("\n")}`);
    const output = [...io.out, ...io.err].join("\n");
    assert.ok(!output.includes("\x1b"), `${label} leaked an escape sequence`);
  }

  // one parseable JSON object on stdout, nothing else
  const json = makeIO();
  assert.equal(await main([...MOCK_RUN_ARGS, "--json"], json, ansi16Style()), 0);
  assert.equal(json.out.length, 1);
  JSON.parse(json.out[0]);

  // print mode keeps its documented split: decision on stdout, usage on stderr
  const print = makeIO();
  assert.equal(await main([...MOCK_RUN_ARGS, "--mode", "print"], print, ansi16Style()), 0);
  assert.equal(print.out.length, 1);
  assert.ok(print.err.some((line) => line.startsWith("tokens: ")), print.err.join("\n"));
});

// ---------------------------------------------------------------------------
// live TTY transcript (run/chat) with byte-identical piped output
// ---------------------------------------------------------------------------

/** Rows that are human-facing progress rather than transcript content. */
function withoutActivityRows(text: string): string {
  return text
    .split("\n")
    .filter((row) => !row.startsWith("· "))
    .join("\n");
}

function countRows(text: string, pattern: RegExp): number {
  return text.split("\n").filter((row) => pattern.test(row)).length;
}

const FOOTER_ROW = /^tokens \d+ in \/ \d+ out · \d+ calls?$/;
const DECISION_RULE_ROW = /^── decision ─+$/;

test("run: a TTY streams envelope blocks live and prints the footer once", async () => {
  const piped = makeIO();
  assert.equal(await main([...MOCK_RUN_ARGS], piped), 0, piped.err.join("\n"));
  const tty = makeTTYIO();
  assert.equal(await main([...MOCK_RUN_ARGS], tty), 0, tty.err.join("\n"));

  const pipedText = piped.out.join("\n");
  const liveText = tty.out.join("\n");
  // live output arrives in pieces: one sink call per block / activity row,
  // instead of the single finished-transcript string a pipe gets.
  assert.ok(
    tty.out.length > piped.out.length,
    `live sink calls ${tty.out.length} should exceed ${piped.out.length}`,
  );
  // compact activity rows are interleaved before the block they announce
  const expectActivityBefore = (activity: string, header: string): void => {
    const activityAt = liveText.indexOf(activity);
    const headerAt = liveText.indexOf(header);
    assert.ok(activityAt >= 0, `missing activity row ${activity}`);
    assert.ok(headerAt >= 0, `missing header ${header}`);
    assert.ok(activityAt < headerAt, `${activity} must precede ${header}`);
  };
  expectActivityBefore("· senior consulting…", "[senior -> junior] consult");
  expectActivityBefore("· junior proposing…", "[junior -> senior] proposal");
  expectActivityBefore("· senior reviewing…", "[senior -> junior] review");
  expectActivityBefore("· senior deciding…", "[senior -> user] decision");

  // the decision rule and the compact footer are printed exactly once
  assert.equal(countRows(liveText, DECISION_RULE_ROW), 1, "decision rule must print once");
  assert.equal(countRows(liveText, FOOTER_ROW), 1, "footer must print once");
  const nonEmpty = liveText.split("\n").filter((row) => row !== "");
  assert.match(nonEmpty[nonEmpty.length - 1] as string, FOOTER_ROW, "footer is last");
  // every envelope block appears once (no duplicate final re-render)
  for (const header of [
    "[senior -> junior] consult",
    "[junior -> senior] proposal",
    "[senior -> junior] review",
    "[senior -> user] decision",
  ]) {
    assert.equal(countRows(liveText, new RegExp(`^${header.replace(/[[\]]/g, "\\$&")}$`)), 1);
  }
  // dropping the activity rows reproduces the piped transcript byte for byte
  assert.equal(withoutActivityRows(liveText), pipedText);
});

test("run: --no-live and a non-TTY sink keep the finished-transcript output", async () => {
  const piped = makeIO();
  assert.equal(await main([...MOCK_RUN_ARGS], piped), 0, piped.err.join("\n"));
  const pipedText = piped.out.join("\n");
  assert.ok(!pipedText.split("\n").some((row) => row.startsWith("· ")), "piped output is static");

  const noLive = makeTTYIO();
  assert.equal(await main([...MOCK_RUN_ARGS, "--no-live"], noLive), 0);
  assert.equal(noLive.out.join("\n"), pipedText, "--no-live on a TTY must match a pipe");
  assert.equal(noLive.out.length, piped.out.length, "--no-live renders the transcript once");

  // --live cannot turn a pipe live: the bytes are unchanged
  const forcedPipe = makeIO();
  assert.equal(await main([...MOCK_RUN_ARGS, "--live"], forcedPipe), 0);
  assert.equal(forcedPipe.out.join("\n"), pipedText, "--live on a pipe must be a no-op");

  // --no-live wins when both flags are given
  const both = makeTTYIO();
  assert.equal(await main([...MOCK_RUN_ARGS, "--live", "--no-live"], both), 0);
  assert.equal(both.out.join("\n"), pipedText, "--no-live wins over --live");
});

test("run: live TTY output strips back to the plain live output", async () => {
  const plain = makeTTYIO();
  assert.equal(await main([...MOCK_RUN_ARGS], plain), 0, plain.err.join("\n"));
  const colored = makeTTYIO();
  assert.equal(await main([...MOCK_RUN_ARGS], colored, ansi16Style()), 0);
  const coloredText = colored.out.join("\n");
  assert.ok(coloredText.includes("\x1b"), "an explicit style must paint live output");
  assert.equal(stripAnsi(coloredText), plain.out.join("\n"));
  // activity rows are painted dim; the transcript is untouched by stripping
  assert.match(coloredText, /\x1b\[2m· senior consulting…\x1b\[0m/);
});

test("run: machine modes never stream live, even with a TTY sink", async () => {
  const cases: Array<{ label: string; args: string[] }> = [
    { label: "--json", args: [...MOCK_RUN_ARGS, "--json"] },
    { label: "--json-events", args: [...MOCK_RUN_ARGS, "--json-events"] },
    { label: "--mode print", args: [...MOCK_RUN_ARGS, "--mode", "print"] },
    { label: "--stream", args: [...MOCK_RUN_ARGS, "--stream"] },
    { label: "--dry-run", args: [...MOCK_RUN_ARGS, "--dry-run"] },
  ];
  for (const { label, args } of cases) {
    const tty = makeTTYIO();
    assert.equal(await main(args, tty, ansi16Style()), 0, `${label}: ${tty.err.join("\n")}`);
    const output = [...tty.out, ...tty.err].join("\n");
    assert.ok(!output.includes("\x1b"), `${label} leaked an escape sequence on a TTY`);
    assert.ok(
      !stripAnsi(output).split("\n").some((row) => row.startsWith("· ")),
      `${label} emitted a live activity row`,
    );
  }
});

test("help: run and chat document the live flags and the piped behavior", async () => {
  for (const command of ["run", "chat"]) {
    const io = makeIO();
    assert.equal(await main(["help", command], io), 0, io.err.join("\n"));
    const text = io.out.join("\n");
    assert.ok(text.includes("--live"), `${command} help does not list --live`);
    assert.ok(text.includes("--no-live"), `${command} help does not list --no-live`);
    assert.match(text, /live/i, `${command} help does not explain live output`);
  }
});

/**
 * Drive one piped `chat` REPL turn in-process by swapping `process.stdin` for a
 * scripted stream (the REPL reads the process stdin directly, so this is the
 * only way to exercise it without a child process).
 */
async function runChatTurn(
  io: CliIO & { out: string[]; err: string[] },
  lines: string[],
): Promise<number> {
  const original = Object.getOwnPropertyDescriptor(process, "stdin");
  Object.defineProperty(process, "stdin", {
    value: Readable.from(lines.map((line) => `${line}\n`)),
    configurable: true,
  });
  try {
    return await main(["chat", "--provider", "mock"], io);
  } finally {
    if (original !== undefined) Object.defineProperty(process, "stdin", original);
    else delete (process as unknown as { stdin?: unknown }).stdin;
  }
}

test("chat: a TTY REPL turn streams live per turn and keeps the footer once", async () => {
  const lines = ["Name one benefit of code review", ""];
  const piped = makeIO();
  assert.equal(await runChatTurn(piped, lines), 0, piped.err.join("\n"));
  const tty = makeTTYIO();
  assert.equal(await runChatTurn(tty, lines), 0, tty.err.join("\n"));

  const pipedText = piped.out.join("\n");
  const liveText = tty.out.join("\n");
  assert.ok(tty.out.length > piped.out.length, "a live turn writes incrementally");
  assert.match(liveText, /^· senior consulting…$/m);
  assert.match(liveText, /^· junior proposing…$/m);
  assert.equal(countRows(liveText, FOOTER_ROW), 1, "one footer per turn");
  assert.equal(countRows(liveText, DECISION_RULE_ROW), 1, "one ruled decision per turn");
  // stripping live activity leaves the same per-turn output a pipe sees
  assert.equal(withoutActivityRows(liveText), pipedText);
  // the banner and resolved-role rows are untouched by live mode
  assert.match(liveText, /Two Brothers REPL\./);
  assert.match(liveText, /senior: provider=mock model=/);
});

// ---------------------------------------------------------------------------
// work mode without a tool belt warns honestly (stderr only)
// ---------------------------------------------------------------------------

const WORK_WARNING_ROW = /^\[warn\] work mode has no tools bound/;

const fakeTool = {
  name: "echo",
  description: "Echo the arguments.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  execute: () => "ok",
};

test("run: work mode with no tool belt emits exactly one stderr warning", async () => {
  const io = makeIO();
  const code = await main([...MOCK_RUN_ARGS, "--mode", "work"], io);
  assert.equal(code, 0, io.err.join("\n"));

  const warnings = io.err.filter((line) => WORK_WARNING_ROW.test(line));
  assert.equal(warnings.length, 1, io.err.join("\n"));
  const warning = warnings[0] as string;
  assert.match(warning, /not workspace-bound/);
  assert.match(warning, /junior cannot read or write files/);
  assert.match(warning, /deliverable it claims may not exist/);
  assert.match(warning, /--mcp-config/);
  assert.match(warning, /`serve`\/TUI/);

  // stdout is untouched: the warning is a diagnostic, never a transcript block
  const stdout = io.out.join("\n");
  assert.doesNotMatch(stdout, /work mode has no tools bound/);
  assert.ok(io.out.some((line) => line.includes("[senior -> user] decision")));
});

test("run: the work-mode warning never fires with a tool or a non-work mode", async () => {
  // No tool belt but not work mode: no warning at all.
  for (const mode of ["consult", "auto"]) {
    const io = makeIO();
    assert.equal(await main([...MOCK_RUN_ARGS, "--mode", mode], io), 0, io.err.join("\n"));
    assert.deepEqual(
      io.err.filter((line) => WORK_WARNING_ROW.test(line)),
      [],
      `${mode}: ${io.err.join("\n")}`,
    );
  }

  // The predicate is the single source of truth: any non-empty scope suppresses it.
  assert.equal(workModeWithoutToolsWarning("work", { junior: [fakeTool] }), null);
  assert.equal(workModeWithoutToolsWarning("work", { shared: [fakeTool] }), null);
  assert.equal(workModeWithoutToolsWarning("work", { senior: [fakeTool] }), null);
  assert.equal(workModeWithoutToolsWarning("consult", {}), null);

  const missing = workModeWithoutToolsWarning("work", { junior: [] });
  assert.ok(missing !== null, "empty scope lists are still an empty belt");
  assert.match(missing, /work mode has no tools bound/);
  assert.ok(workModeWithoutToolsWarning("work", {}) !== null);
  assert.ok(workModeWithoutToolsWarning("work", { shared: [], senior: [], junior: [] }) !== null);
});

test("run: a bound MCP tool suppresses the work-mode warning", async (t) => {
  const serverPath = fileURLToPath(new URL("./fixtures/mcp-demo-server.mjs", import.meta.url));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tb-cli-work-tools-"));
  let code: number | null = null;
  const io = makeIO();
  try {
    const configPath = path.join(tmp, "mcp.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: { demo: { command: process.execPath, args: [serverPath], role: "junior" } },
      }),
      "utf-8",
    );
    code = await main(
      ["run", "smoke", "--provider", "mock", "--mode", "work", "--mcp-config", configPath],
      io,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  if (io.err.some((line) => line.startsWith("[warn] MCP server 'demo'"))) {
    // spawning unavailable in this environment: with no loaded tool the honest
    // warning must fire instead; a CI host with process spawning asserts absence.
    t.diagnostic("MCP stdio spawn unavailable; skipping the suppression assertion");
    assert.ok(
      io.err.some((line) => WORK_WARNING_ROW.test(line)),
      "an unloadable server leaves an empty belt, which must warn",
    );
    return;
  }
  assert.equal(code, 0, io.err.join("\n"));
  assert.deepEqual(io.err.filter((line) => WORK_WARNING_ROW.test(line)), []);
  assert.ok(io.out.some((line) => line.includes("[senior -> user] decision")));
});

test("run: the work-mode warning is stderr-only in machine output modes", async () => {
  const work = makeIO();
  assert.equal(await main([...MOCK_RUN_ARGS, "--mode", "work", "--json"], work), 0);
  assert.equal(work.out.length, 1, "one machine object on stdout");
  const parsed = JSON.parse(work.out[0]) as Record<string, unknown>;
  assert.deepEqual(
    Object.keys(parsed).sort(),
    ["cost", "decision", "errors", "events", "rounds", "task", "usage"],
    "the machine object shape is unchanged",
  );
  assert.ok(work.err.some((line) => WORK_WARNING_ROW.test(line)), "the warning still reaches stderr");
  assert.doesNotMatch(work.out[0], /work mode has no tools bound/, "stdout carries no warning text");

  // A consult machine run is byte-identical to before: no warning, one object.
  const consult = makeIO();
  assert.equal(await main([...MOCK_RUN_ARGS, "--json"], consult), 0);
  assert.deepEqual(consult.err, [], "clean machine runs keep stderr silent");
  assert.equal(consult.out.length, 1);
  JSON.parse(consult.out[0]);
});
