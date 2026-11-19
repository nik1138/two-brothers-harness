/**
 * TUI session-fork suite: the chordless `/fork` command end to end over fake
 * TTY streams and a real temp session store. Covers the argument grammar and
 * bounded notices (pure), a whole-session fork that switches the app and keeps
 * the source byte-identical, a prefix fork under an explicit name, the
 * mid-turn and compaction refusals, the no-current-session/absent-file/
 * outside-store refusals, and the fork service's real name-collision,
 * out-of-range-`--at` and corrupt-source errors surfaced as bounded notices.
 * Everything is hermetic:
 * the mock provider drives turns, and the compaction gate uses an ephemeral
 * loopback endpoint (the same pattern `tuiintegration.test.ts` uses).
 *
 * Run with: node --test tests/tuifork.test.ts
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { resolveConfig } from "../src/config.ts";
import { MockProvider, type Provider } from "../src/provider.ts";
import { runTuiApp, type TuiIO } from "../src/tui/app.ts";
import {
  boundForkNotice,
  FORK_NOTICE_MAX_CHARS,
  FORK_USAGE,
  forkSwitchNotice,
  parseForkCommandArgs,
} from "../src/tui/forkcommand.ts";
import { ANSI, stripAnsi } from "../src/tui/render.ts";

class FakeInput extends EventEmitter {
  isTTY = true;
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  setEncoding(): void {}
  unref(): void {}

  type(text: string): void {
    for (const char of text) {
      this.emit("keypress", char, { name: char, ctrl: false, shift: char !== char.toLowerCase() });
    }
  }

  key(name: string, modifiers: { ctrl?: boolean; shift?: boolean; raw?: string } = {}): void {
    this.emit("keypress", modifiers.raw ?? "", {
      name,
      ctrl: modifiers.ctrl === true,
      shift: modifiers.shift === true,
    });
  }

  enter(): void {
    this.key("return", { raw: "\r" });
  }
}

class FakeOutput extends EventEmitter {
  isTTY = true;
  columns = 80;
  rows = 24;
  data = "";
  write(chunk: string): boolean {
    this.data += chunk;
    return true;
  }
  resize(columns: number, rows: number): void {
    this.columns = columns;
    this.rows = rows;
    this.emit("resize");
  }
}

function makeIO(): TuiIO & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, log: (line) => out.push(line), error: (line) => err.push(line) };
}

interface Harness {
  app: Promise<number>;
  input: FakeInput;
  output: FakeOutput;
  io: ReturnType<typeof makeIO>;
}

/** Start the assembled TUI over fake TTYs; every call names its own store. */
function startApp(
  sessionsDir: string,
  extra: Partial<Parameters<typeof runTuiApp>[0]> = {},
): Harness {
  const input = new FakeInput();
  const output = new FakeOutput();
  const io = makeIO();
  const app = runTuiApp({
    cfg: resolveConfig({ provider: "mock" }),
    io,
    input: input as unknown as NodeJS.ReadStream,
    output: output as unknown as NodeJS.WriteStream,
    pluginsDir: `${process.cwd()}/does-not-exist-tui-fork-plugins`,
    sessionsDir,
    ...extra,
  });
  return { app, input, output, io };
}

const textOf = (output: FakeOutput): string => stripAnsi(output.data);

/** All rendered text with box glyphs and whitespace collapsed (wrapped notices match). */
const flatText = (output: FakeOutput): string =>
  textOf(output)
    .replace(/[│─╭╮╰╯┌┐└┘]/g, " ")
    .replace(/\s+/g, " ");

/** The newest fully rendered frame (rows joined with newlines). */
const lastFrameText = (output: FakeOutput): string =>
  stripAnsi(output.data.split(ANSI.cursorHome).at(-1) ?? "");

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
}

async function quit(input: FakeInput, app: Promise<number>): Promise<number> {
  for (let press = 0; press < 5; press += 1) {
    input.key("escape");
    const settled = await Promise.race([
      app.then((code) => code as number | "exited"),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 250)),
    ]);
    if (settled !== "pending") return settled === "exited" ? 0 : settled;
  }
  const code = await Promise.race([
    app,
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 10_000)),
  ]);
  if (code === "timeout") throw new Error("the TUI did not exit after repeated Escape");
  return code;
}

/** Non-empty JSONL lines of a session file ([] when the file is missing). */
function sessionLines(file: string): string[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter((line) => line.trim() !== "");
}

/** One wire-valid protocol envelope line, dense `seq`. */
function envelope(
  seq: number,
  from: "user" | "senior",
  to: string,
  text: string,
): string {
  return JSON.stringify({
    v: 1,
    id: `e${seq}`,
    seq,
    ts: "2026-11-19T09:00:00Z",
    from,
    to,
    kind: "message",
    payload: { text },
  });
}

/** Write a four-envelope source session (plus an optional sidecar title). */
function writeSource(
  sessionsDir: string,
  name: string,
  title?: string,
): { file: string; bytes: Buffer } {
  fs.mkdirSync(sessionsDir, { recursive: true });
  const file = path.join(sessionsDir, name);
  const text = `${[
    envelope(1, "user", "senior", "first task"),
    envelope(2, "senior", "user", "first reply"),
    envelope(3, "user", "senior", "follow-up task"),
    envelope(4, "senior", "user", "follow-up reply"),
  ].join("\n")}\n`;
  fs.writeFileSync(file, text, "utf8");
  if (title !== undefined) {
    fs.writeFileSync(
      path.join(sessionsDir, name.replace(/\.jsonl$/, ".meta.json")),
      JSON.stringify({ title, created: 1, updated: 2 }, null, 2),
      "utf8",
    );
  }
  return { file, bytes: fs.readFileSync(file) };
}

/** Generated fork files currently in the store. */
function forkFiles(sessionsDir: string): string[] {
  if (!fs.existsSync(sessionsDir)) return [];
  return fs
    .readdirSync(sessionsDir)
    .filter((name) => name.endsWith(".jsonl") && name.includes("-fork-"));
}

// --------------------------------------------------------------------------- //
// pure argument grammar and notices
// --------------------------------------------------------------------------- //

test("/fork arguments: empty = whole session, name/--at in either order, honest usage errors", () => {
  assert.deepEqual(parseForkCommandArgs(""), { request: {}, error: null });
  assert.deepEqual(parseForkCommandArgs("   "), { request: {}, error: null });
  assert.deepEqual(parseForkCommandArgs(" branch-a "), {
    request: { name: "branch-a" },
    error: null,
  });
  assert.deepEqual(parseForkCommandArgs("--at 4"), { request: { atSeq: 4 }, error: null });
  assert.deepEqual(parseForkCommandArgs("--at 4 branch-a"), {
    request: { atSeq: 4, name: "branch-a" },
    error: null,
  });
  assert.deepEqual(parseForkCommandArgs("branch-a --at 4"), {
    request: { atSeq: 4, name: "branch-a" },
    error: null,
  });

  for (const [args, problem] of [
    ["--at", "--at needs a seq"],
    ["--at x", "--at must be a positive integer"],
    ["--at 0", "--at must be a positive integer"],
    ["--at -2", "--at must be a positive integer"],
    ["--at 1.5", "--at must be a positive integer"],
    ["--at 1 --at 2", "--at was given more than once"],
    ["--name x", "unknown option --name"],
    ["one two", "unexpected argument two"],
  ] as const) {
    const parsed = parseForkCommandArgs(args);
    assert.equal(parsed.error, `${problem} — usage: ${FORK_USAGE}`, args);
    assert.deepEqual(parsed.request, {}, args);
  }
});

test("/fork notices: success states the copy count, untouched source and switch; long text is bounded", () => {
  const notice = forkSwitchNotice({
    source: "alpha.jsonl",
    name: "alpha-fork-1.jsonl",
    events: 4,
  });
  assert.match(notice, /^forked alpha\.jsonl → alpha-fork-1\.jsonl/);
  assert.match(notice, /4 envelopes copied/);
  assert.match(notice, /the source session is untouched/);
  assert.match(notice, /switched to the fork$/);
  assert.match(
    forkSwitchNotice({ source: "a.jsonl", name: "a-fork-1.jsonl", events: 1 }),
    /1 envelope copied/,
  );

  const usage = ` — usage: ${FORK_USAGE}`;
  const long = `fork failed: ${"x".repeat(FORK_NOTICE_MAX_CHARS * 2)}${usage}`;
  const bounded = boundForkNotice(long);
  assert.equal(bounded.length, FORK_NOTICE_MAX_CHARS);
  assert.ok(bounded.startsWith("fork failed: "), "the head is kept");
  assert.ok(bounded.endsWith(usage), "the actionable tail is kept, not dropped");
  assert.ok(bounded.includes("…"), "the middle is elided honestly");
  assert.equal(boundForkNotice("short"), "short");
});

test("/fork notices never invent a copy count or an empty label", () => {
  const blank = forkSwitchNotice({ source: "  ", name: "", events: 0 });
  assert.match(
    blank,
    /^forked the current session → the new session \(0 envelopes copied;/,
    "blank labels fall back instead of rendering an empty arrow side",
  );
  for (const events of [Number.NaN, Number.POSITIVE_INFINITY, -3]) {
    const notice = forkSwitchNotice({ source: "alpha.jsonl", name: "alpha-fork-1.jsonl", events });
    assert.match(notice, /\(0 envelopes copied;/, `events ${String(events)} is a zero copy`);
    assert.equal(notice.includes("NaN"), false, "no NaN is ever rendered as an envelope count");
    assert.equal(notice.includes("Infinity"), false);
  }
  assert.match(
    forkSwitchNotice({ source: "alpha.jsonl", name: "alpha-fork-1.jsonl", events: 2.7 }),
    /\(2 envelopes copied;/,
    "a fractional count is floored, never rendered as a fraction",
  );
});

test("/fork parser echoes are bounded and never drop the usage clause", () => {
  const longOption = parseForkCommandArgs(`--${"y".repeat(5_000)}`);
  assert.deepEqual(longOption.request, {});
  assert.ok(longOption.error !== null);
  assert.ok(longOption.error.length <= FORK_NOTICE_MAX_CHARS);
  assert.ok(longOption.error.startsWith("unknown option --y"), "the head names the problem");
  assert.ok(longOption.error.endsWith(` — usage: ${FORK_USAGE}`), "the usage clause survives");
  assert.ok(longOption.error.includes("…"), "the token echo itself is elided");

  const longArgument = parseForkCommandArgs(`branch-a ${"z".repeat(5_000)}`);
  assert.ok(longArgument.error !== null);
  assert.equal(longArgument.error.length, FORK_NOTICE_MAX_CHARS);
  assert.ok(longArgument.error.startsWith("unexpected argument z"));
  assert.ok(longArgument.error.endsWith(` — usage: ${FORK_USAGE}`));
});

// --------------------------------------------------------------------------- //
// assembled app: fork then switch
// --------------------------------------------------------------------------- //

test("/fork copies the whole current session, switches to the copy and appends later turns to it", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-tui-fork-"));
  const sessionsDir = path.join(root, "sessions");
  const { file: sourceFile, bytes: sourceBytes } = writeSource(
    sessionsDir,
    "alpha.jsonl",
    "Alpha source",
  );
  const { app, input, output } = startApp(sessionsDir, {
    cfg: resolveConfig({ provider: "mock", sessionFile: sourceFile, resume: true }),
  });
  try {
    assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));
    // A narrow screen keeps the long success notice width-safe.
    output.resize(60, 24);

    input.type("/fork");
    input.enter();
    assert.ok(
      await waitFor(() =>
        textOf(output).includes("forked alpha.jsonl → alpha-fork-1.jsonl"),
      ),
      "the success notice names source and fork",
    );
    assert.ok(flatText(output).includes("4 envelopes copied; the source session is untouched"));
    assert.ok(
      await waitFor(() => lastFrameText(output).includes("alpha-fork-1")),
      "the app switched to the fork (status bar names it)",
    );
    assert.ok(
      lastFrameText(output)
        .split("\n")
        .every((row) => stripAnsi(row).length <= 60),
      "the fork notice stays width-safe at 60 columns",
    );

    const forkPath = path.join(sessionsDir, "alpha-fork-1.jsonl");
    assert.ok(fs.existsSync(forkPath), "the fork file exists");
    assert.deepEqual(
      fs.readFileSync(forkPath),
      sourceBytes,
      "a whole-session fork is byte-identical to the source",
    );
    assert.deepEqual(
      sessionLines(forkPath).map((line) => (JSON.parse(line) as { seq: number }).seq),
      [1, 2, 3, 4],
      "the copied envelopes keep dense seq",
    );
    const meta = JSON.parse(
      fs.readFileSync(path.join(sessionsDir, "alpha-fork-1.meta.json"), "utf8"),
    ) as { title?: unknown; parent?: unknown };
    assert.deepEqual(meta.parent, { name: "alpha.jsonl", seq: 4 });
    assert.equal(meta.title, "Alpha source (fork)");
    assert.deepEqual(
      fs.readFileSync(sourceFile),
      sourceBytes,
      "the source file is untouched by the fork",
    );

    // A turn after the switch is appended to the fork, never to the source.
    input.type("continue on the branch");
    input.enter();
    assert.ok(
      await waitFor(() => textOf(output).includes("decision:"), 30_000),
      "the turn after the fork completes",
    );
    assert.ok(
      sessionLines(forkPath).length > 4,
      "the post-fork turn appended its envelopes to the fork",
    );
    assert.deepEqual(
      fs.readFileSync(sourceFile),
      sourceBytes,
      "the source stays byte-identical after a post-fork turn",
    );

    assert.equal(await quit(input, app), 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("/fork --at copies only the prefix and switches to the explicitly named branch", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-tui-fork-cut-"));
  const sessionsDir = path.join(root, "sessions");
  const { file: sourceFile, bytes: sourceBytes } = writeSource(sessionsDir, "alpha.jsonl");
  const sourceText = sourceBytes.toString("utf8");
  const prefix = `${sourceText.split("\n").slice(0, 2).join("\n")}\n`;
  const { app, input, output } = startApp(sessionsDir, {
    cfg: resolveConfig({ provider: "mock", sessionFile: sourceFile, resume: true }),
  });
  try {
    assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));

    input.type("/fork branch-a --at 2");
    input.enter();
    assert.ok(
      await waitFor(() => flatText(output).includes("forked alpha.jsonl → branch-a.jsonl")),
      "the success notice names the explicit branch",
    );
    assert.ok(flatText(output).includes("2 envelopes copied; the source session is untouched"));
    assert.ok(
      await waitFor(() => lastFrameText(output).includes("session branch-a.jsonl")),
      "the app switched to the explicit branch",
    );

    const forkPath = path.join(sessionsDir, "branch-a.jsonl");
    assert.equal(
      fs.readFileSync(forkPath, "utf8"),
      prefix,
      "a prefix fork copies exactly the source's raw bytes through the cut",
    );
    const meta = JSON.parse(
      fs.readFileSync(path.join(sessionsDir, "branch-a.meta.json"), "utf8"),
    ) as { parent?: unknown };
    assert.deepEqual(meta.parent, { name: "alpha.jsonl", seq: 2 });
    assert.deepEqual(
      fs.readFileSync(sourceFile),
      sourceBytes,
      "the source file is untouched by the prefix fork",
    );

    assert.equal(await quit(input, app), 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------------------- //
// refusals and service errors
// --------------------------------------------------------------------------- //

test("/fork is refused while a turn runs (palette row unavailable) and writes nothing", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-tui-fork-running-"));
  const sessionsDir = path.join(root, "sessions");
  const { file: sourceFile } = writeSource(sessionsDir, "alpha.jsonl");
  let held = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const mock = new MockProvider();
  const gatedSenior: Provider = {
    async chat(messages, responseKind, signal, options) {
      if (!held) {
        held = true;
        await gate;
      }
      return mock.chat(messages, responseKind, signal, options);
    },
  };
  const { app, input, output } = startApp(sessionsDir, {
    cfg: resolveConfig({ provider: "mock", sessionFile: sourceFile, resume: true }),
    providerOverrides: { senior: gatedSenior, junior: mock },
  });
  try {
    assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));
    input.type("first task");
    input.enter();
    assert.ok(await waitFor(() => held), "the first senior call is held");

    input.key("p", { ctrl: true });
    assert.ok(await waitFor(() => lastFrameText(output).includes("COMMANDS")));
    input.type("fork");
    assert.ok(await waitFor(() => lastFrameText(output).includes("> fork")));
    assert.ok(
      await waitFor(() => lastFrameText(output).includes("› Fork session")),
      "the palette selects the fork row",
    );
    input.enter();
    assert.ok(
      await waitFor(() => lastFrameText(output).includes("COMMANDS")),
      "a disabled palette row keeps the palette open",
    );
    // The blocked-row toast is only painted once no overlay covers the screen,
    // so close the palette and read the refusal it posted.
    input.key("escape");
    assert.ok(
      await waitFor(() => /unavailable while a turn is running/.test(flatText(output))),
      "the idle-only row refuses with the existing reason",
    );
    assert.deepEqual(forkFiles(sessionsDir), [], "no fork file was written mid-turn");

    release();
    assert.ok(
      await waitFor(() => textOf(output).includes("decision:"), 30_000),
      "the held turn completes after the refusal",
    );
    assert.equal(await quit(input, app), 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("/fork is refused while compaction runs (palette dispatch) and writes nothing", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-tui-fork-compacting-"));
  const sessionsDir = path.join(root, "sessions");
  const { file: sourceFile } = writeSource(sessionsDir, "alpha.jsonl");
  const SUMMARY_TEXT = "ALPHA-FORK-GATE-SUMMARY";
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const server = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      void gate.then(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: SUMMARY_TEXT } }] }));
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const { app, input, output } = startApp(sessionsDir, {
    cfg: resolveConfig({
      provider: "openai",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: "test-key",
      seniorModel: "blocked-senior",
      juniorModel: "blocked-senior",
      sessionFile: sourceFile,
      resume: true,
      compactKeepRecent: 1,
      retries: 0,
    }),
  });
  try {
    assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));
    input.type("/compact");
    input.enter();
    assert.ok(
      await waitFor(() => lastFrameText(output).includes("compacting context…")),
      "compaction is pending on the held endpoint",
    );

    input.key("p", { ctrl: true });
    assert.ok(await waitFor(() => lastFrameText(output).includes("COMMANDS")));
    input.type("fork");
    assert.ok(await waitFor(() => lastFrameText(output).includes("> fork")));
    assert.ok(
      await waitFor(() => lastFrameText(output).includes("› Fork session")),
      "the palette selects the fork row during compaction",
    );
    input.enter();
    assert.ok(
      await waitFor(() =>
        flatText(output).includes("cannot fork a session while compaction is running"),
      ),
      "the compacting refusal is stated honestly",
    );
    assert.deepEqual(forkFiles(sessionsDir), [], "no fork file was written while compaction ran");

    release();
    assert.ok(
      await waitFor(() => textOf(output).includes("context compacted"), 30_000),
      "compaction completes once the endpoint answers",
    );
    assert.equal(await quit(input, app), 0);
  } finally {
    server.closeAllConnections?.();
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("/fork with no current session file refuses honestly", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-tui-fork-nosession-"));
  const sessionsDir = path.join(root, "sessions");
  const { app, input, output } = startApp(sessionsDir);
  try {
    assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));
    input.type("/fork");
    input.enter();
    assert.ok(
      await waitFor(() => flatText(output).includes("fork: no session file to fork")),
      "the in-memory session is refused with guidance",
    );
    assert.deepEqual(forkFiles(sessionsDir), []);
    assert.equal(await quit(input, app), 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("/fork refuses an absent current session file honestly", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-tui-fork-absent-"));
  const sessionsDir = path.join(root, "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });
  const ghost = path.join(sessionsDir, "ghost.jsonl");
  const { app, input, output } = startApp(sessionsDir, {
    cfg: resolveConfig({ provider: "mock", sessionFile: ghost }),
  });
  try {
    assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));
    input.type("/fork");
    input.enter();
    assert.ok(
      await waitFor(() =>
        flatText(output).includes("fork: the current session has no saved file yet"),
      ),
      "an unsaved current session is refused honestly",
    );
    assert.deepEqual(forkFiles(sessionsDir), []);
    assert.equal(await quit(input, app), 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("/fork refuses a current session outside the TUI's session store", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-tui-fork-outside-"));
  const sessionsDir = path.join(root, "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });
  const outsideFile = path.join(root, "outside.jsonl");
  fs.writeFileSync(
    outsideFile,
    `${[envelope(1, "user", "senior", "outside task")].join("\n")}\n`,
    "utf8",
  );
  const { app, input, output } = startApp(sessionsDir, {
    cfg: resolveConfig({ provider: "mock", sessionFile: outsideFile, resume: true }),
  });
  try {
    assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));
    input.type("/fork");
    input.enter();
    assert.ok(
      await waitFor(() =>
        flatText(output).includes(
          `fork: the current session is not a session in ${sessionsDir}`,
        ),
      ),
      "a file outside the store is refused instead of forking a same-named stranger",
    );
    assert.deepEqual(forkFiles(sessionsDir), []);
    assert.equal(await quit(input, app), 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("/fork surfaces a name collision as a bounded notice and keeps the source selected", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-tui-fork-collision-"));
  const sessionsDir = path.join(root, "sessions");
  const { file: sourceFile, bytes: sourceBytes } = writeSource(sessionsDir, "alpha.jsonl");
  fs.writeFileSync(
    path.join(sessionsDir, "taken.jsonl"),
    `${[envelope(1, "user", "senior", "taken task")].join("\n")}\n`,
    "utf8",
  );
  const { app, input, output } = startApp(sessionsDir, {
    cfg: resolveConfig({ provider: "mock", sessionFile: sourceFile, resume: true }),
  });
  try {
    assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));
    input.type("/fork taken");
    input.enter();
    assert.ok(
      await waitFor(() =>
        flatText(output).includes("fork failed: session already exists: taken.jsonl"),
      ),
      "the service's real name-collision message is shown",
    );
    assert.ok(
      lastFrameText(output).includes("session alpha.jsonl"),
      "a failed fork leaves the source session selected",
    );
    assert.deepEqual(forkFiles(sessionsDir), []);
    assert.deepEqual(fs.readFileSync(sourceFile), sourceBytes);
    assert.equal(await quit(input, app), 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("/fork --at beyond the log refuses honestly and keeps the source selected", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-tui-fork-at-range-"));
  const sessionsDir = path.join(root, "sessions");
  const { file: sourceFile, bytes: sourceBytes } = writeSource(sessionsDir, "alpha.jsonl");
  const { app, input, output } = startApp(sessionsDir, {
    cfg: resolveConfig({ provider: "mock", sessionFile: sourceFile, resume: true }),
  });
  try {
    assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));
    // The parser accepts any positive integer; the range belongs to the
    // session, so the service's refusal is what has to surface.
    input.type("/fork --at 9");
    input.enter();
    assert.ok(
      await waitFor(() =>
        flatText(output).includes("fork failed: at seq must be an integer between 1 and 4"),
      ),
      "the service's real range message is shown",
    );
    assert.ok(
      lastFrameText(output).includes("session alpha.jsonl"),
      "an out-of-range fork leaves the source session selected",
    );
    assert.deepEqual(forkFiles(sessionsDir), [], "no fork file was created");
    assert.deepEqual(fs.readFileSync(sourceFile), sourceBytes, "the source session is untouched");
    assert.equal(await quit(input, app), 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("/fork surfaces an unreadable/corrupt source as a bounded notice without writing", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-tui-fork-corrupt-"));
  const sessionsDir = path.join(root, "sessions");
  const { file: sourceFile } = writeSource(sessionsDir, "alpha.jsonl");
  const { app, input, output } = startApp(sessionsDir, {
    cfg: resolveConfig({ provider: "mock", sessionFile: sourceFile, resume: true }),
  });
  try {
    assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));
    // Simulate an externally damaged log after startup: the fork service reads
    // the file now and must refuse instead of copying a partial session.
    const corrupt = `${envelope(1, "user", "senior", "first task")}\nnot json\n`;
    fs.writeFileSync(sourceFile, corrupt, "utf8");

    input.type("/fork");
    input.enter();
    assert.ok(
      await waitFor(() =>
        flatText(output).includes("fork failed: cannot read session alpha.jsonl"),
      ),
      "the service's real read failure is shown",
    );
    assert.match(flatText(output), /corrupt/, "the real corruption detail is shown");
    assert.deepEqual(forkFiles(sessionsDir), []);
    assert.equal(fs.readFileSync(sourceFile, "utf8"), corrupt, "the failed fork wrote no byte");
    assert.equal(await quit(input, app), 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
