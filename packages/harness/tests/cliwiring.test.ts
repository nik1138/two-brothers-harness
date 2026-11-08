/**
 * CLI wiring for the polish wave: `run --stream --stream-tokens`, the chat
 * REPL's slash-command dispatch (discovered templates and the first-party
 * base commands from `src/basecommands.ts`) and the REPL-performed local
 * actions (`/compact`, `/export`, `/status`, `/permission`, `/mode`, `/new`).
 * Hermetic: mock providers only, temp directories for sessions/commands, and
 * (for the REPL) a real CLI subprocess driven over piped stdin — the same
 * idiom as `e2e/cli.ts`.
 *
 * Run with: node --test tests/cliwiring.test.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { main, type CliIO } from "../src/cli.ts";
import { BASE_COMMANDS } from "../src/basecommands.ts";
import { COMPACTION_SUMMARY_PREFIX } from "../src/compaction.ts";
import {
  installTurnSignalHandlers,
  turnCancelNotice,
  turnSignalExitCode,
  TURN_CANCEL_BUDGET_MS,
  waitForTurnOutcome,
  type TurnSignalEmitter,
} from "../src/turnsignal.ts";
import { SHELL_DRAIN_BUDGET_MS } from "../src/shell.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The source CLI entry (Node native type stripping runs it directly). */
const CLI = path.join(HERE, "..", "src", "cli.ts");

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

function tmpdir(prefix: string): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    root,
    cleanup: () => {
      // Windows briefly holds handles on freshly written files.
      for (let attempt = 0; ; attempt++) {
        try {
          fs.rmSync(root, { recursive: true, force: true });
          return;
        } catch (exc) {
          if (attempt >= 4) throw exc;
          const deadline = Date.now() + 50 * (attempt + 1);
          while (Date.now() < deadline) {
            // busy-wait: cleanup runs synchronously inside test teardowns
          }
        }
      }
    },
  };
}

interface NdjsonRecord {
  type?: string;
  role?: string;
  delta?: string;
  [key: string]: unknown;
}

function parseLines(lines: string[]): NdjsonRecord[] {
  return lines.map((line) => JSON.parse(line) as NdjsonRecord);
}

// ---------------------------------------------------------------------------
// (i) run --stream --stream-tokens emits token records
// ---------------------------------------------------------------------------

test("run --stream --stream-tokens emits token NDJSON records", async () => {
  const io = makeIO();
  const code = await main(
    ["run", "Pick a testing scheme", "--provider", "mock", "--stream", "--stream-tokens"],
    io,
  );

  assert.equal(code, 0, io.err.join("\n"));
  const records = parseLines(io.out);
  const tokens = records.filter((record) => record.type === "token");
  assert.ok(tokens.length > 0, "at least one token record was emitted");
  for (const token of tokens) {
    assert.equal(typeof token.delta, "string");
    assert.ok((token.delta ?? "").length > 0, "a token record carries a delta");
    assert.ok(token.role === "senior" || token.role === "junior", `role ${String(token.role)}`);
    assert.equal(typeof token.at, "string");
  }
  // additive: the envelope records and the terminal result are still there
  assert.ok(records.some((record) => record.type === "envelope"));
  assert.ok(records.some((record) => record.type === "result"));
});

// ---------------------------------------------------------------------------
// (ii) --stream-tokens without --stream is a usage error
// ---------------------------------------------------------------------------

test("--stream-tokens without --stream exits 2 and runs nothing", async () => {
  const io = makeIO();
  const code = await main(
    ["run", "Pick a testing scheme", "--provider", "mock", "--stream-tokens"],
    io,
  );

  assert.equal(code, 2);
  assert.match(io.err.join("\n"), /--stream-tokens only applies to --stream/);
  assert.deepEqual(io.out, [], "no NDJSON records were emitted");
});

// ---------------------------------------------------------------------------
// (iii) chat REPL slash commands: expansion, /commands, unknown names
// ---------------------------------------------------------------------------

function writeCommand(root: string, name: string, source: string): void {
  fs.writeFileSync(path.join(root, `${name}.md`), source, "utf-8");
}

function userMessages(sessionFile: string): string[] {
  const raw = fs.readFileSync(sessionFile, "utf-8");
  const texts: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const event = JSON.parse(line) as {
      from?: string;
      kind?: string;
      payload?: { text?: unknown };
    };
    if (event.from === "user" && event.kind === "message") {
      texts.push(String(event.payload?.text ?? ""));
    }
  }
  return texts;
}

test("chat REPL expands /name args, lists /commands and rejects unknown names", () => {
  const dir = tmpdir("tb-cli-commands-");
  const commandsRoot = path.join(dir.root, "commands");
  fs.mkdirSync(commandsRoot);
  writeCommand(
    commandsRoot,
    "summarize",
    [
      "---",
      "description: Summarize a document",
      "argument-hint: <path>",
      "mode: work",
      "---",
      "Summarize $ARGUMENTS carefully.",
      "",
    ].join("\n"),
  );
  const sessionFile = path.join(dir.root, "session.jsonl");
  try {
    const env: NodeJS.ProcessEnv = { ...process.env };
    // Never let a developer's pinned env change the scenario.
    delete env.TWO_BROTHERS_COMMANDS_DIR;
    delete env.TWO_BROTHERS_STREAM_TOKENS;

    const run = spawnSync(
      process.execPath,
      [
        CLI,
        "chat",
        "--provider",
        "mock",
        "--session-file",
        sessionFile,
        "--commands-dir",
        commandsRoot,
      ],
      {
        cwd: dir.root,
        timeout: 60_000,
        encoding: "utf-8",
        env,
        // one expanded command, the list, an unknown name, then exit
        input: "/summarize docs/readme.md\n/commands\n/nope\n\n",
      },
    );
    assert.equal(run.status, 0, `exit ${run.status}: ${String(run.stderr).slice(-500)}`);
    const stdout = run.stdout ?? "";
    const stderr = run.stderr ?? "";

    // the expanded template (mode: work) reached the provider/session as the task
    const tasks = userMessages(sessionFile);
    assert.equal(tasks[0], "Summarize docs/readme.md carefully.");

    // /commands lists name — description (argument-hint)
    assert.ok(
      stdout.includes("summarize — Summarize a document (<path>)"),
      `command list missing:\n${stdout}`,
    );

    // an unknown command prints the hint and is never submitted
    assert.match(stderr, /unknown command: nope/);
    assert.match(stderr, /\/commands/);
    assert.ok(
      tasks.every((text) => !text.includes("/nope")),
      "the unknown command was submitted as a task",
    );
  } finally {
    dir.cleanup();
  }
});

// ---------------------------------------------------------------------------
// (iv) chat REPL: first-party base commands (plan/goal/feedback prompts and
// compact/export/status/permission/mode/help actions)
// ---------------------------------------------------------------------------

/** Env vars that would let a developer's shell change the scenario. */
const PINNED_ENV_KEYS = [
  "TWO_BROTHERS_PROVIDER",
  "TWO_BROTHERS_MODE",
  "TWO_BROTHERS_SESSION_FILE",
  "TWO_BROTHERS_RESUME",
  "TWO_BROTHERS_COMMANDS_DIR",
  "TWO_BROTHERS_COMPACT",
  "TWO_BROTHERS_COMPACT_THRESHOLD",
  "TWO_BROTHERS_COMPACT_KEEP_RECENT",
  "TWO_BROTHERS_COMPACT_THRESHOLD_TOKENS",
  "TWO_BROTHERS_CONTEXT_WINDOW",
  "TWO_BROTHERS_STREAM_TOKENS",
] as const;

interface ChatProcessResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Run the source CLI `chat` REPL with a scripted stdin, hermetic env. */
function runChat(args: string[], input: string, cwd: string): ChatProcessResult {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of PINNED_ENV_KEYS) delete env[key];
  const run = spawnSync(process.execPath, [CLI, "chat", ...args], {
    cwd,
    timeout: 90_000,
    encoding: "utf-8",
    env,
    input,
  });
  return { status: run.status, stdout: run.stdout ?? "", stderr: run.stderr ?? "" };
}

interface StoredEvent {
  seq?: number;
  from?: string;
  kind?: string;
  payload?: { text?: unknown };
}

function sessionEvents(sessionFile: string): StoredEvent[] {
  return fs
    .readFileSync(sessionFile, "utf-8")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as StoredEvent);
}

function eventKinds(sessionFile: string): string[] {
  return sessionEvents(sessionFile).map((event) => String(event.kind ?? ""));
}

function basePrompt(name: string): string {
  const command = BASE_COMMANDS.find((entry) => entry.name === name);
  assert.ok(command !== undefined, `missing base command ${name}`);
  return command.template ?? "";
}

test("chat REPL: /plan and /goal expand to tasks; a bare /plan prints usage only", () => {
  const dir = tmpdir("tb-cli-baseprompt-");
  const sessionFile = path.join(dir.root, "s.jsonl");
  try {
    const run = runChat(
      ["--provider", "mock", "--session-file", sessionFile],
      [
        "/plan Ship the Redis migration",
        "/plan",
        "/goal Keep the scope small",
        // an English alias resolves to the same base prompt command
        "/objective Also keep it testable",
        "",
      ].join("\n"),
      dir.root,
    );
    assert.equal(run.status, 0, `exit ${run.status}: ${run.stderr.slice(-500)}`);

    const tasks = userMessages(sessionFile);
    assert.equal(tasks.length, 3, `unexpected tasks: ${JSON.stringify(tasks)}`);
    assert.equal(
      tasks[0],
      basePrompt("plan").replace("$ARGUMENTS", "Ship the Redis migration"),
    );
    assert.equal(tasks[1], basePrompt("goal").replace("$ARGUMENTS", "Keep the scope small"));
    assert.equal(tasks[2], basePrompt("goal").replace("$ARGUMENTS", "Also keep it testable"));

    // missing required arguments: the usage line, no turn, the REPL continues
    assert.match(run.stderr, /usage: \/plan <objective>/);
    assert.ok(tasks.every((task) => !task.includes("$ARGUMENTS")));

    // the built-in prompt commands' consult mode overrides the turn
    assert.deepEqual(eventKinds(sessionFile), [
      "message",
      "consult",
      "proposal",
      "review",
      "decision",
      "message",
      "consult",
      "proposal",
      "review",
      "decision",
      "message",
      "consult",
      "proposal",
      "review",
      "decision",
    ]);
  } finally {
    dir.cleanup();
  }
});

test("chat REPL: /mode switches the following turns; prompt commands keep their mode", () => {
  const dir = tmpdir("tb-cli-basemode-");
  const sessionFile = path.join(dir.root, "s.jsonl");
  try {
    const run = runChat(
      ["--provider", "mock", "--session-file", sessionFile],
      [
        "/mode work",
        "Do the work-mode task",
        "/plan A plan for the work-mode conversation",
        "/mode bogus",
        "/mode",
        "",
      ].join("\n"),
      dir.root,
    );
    assert.equal(run.status, 0, `exit ${run.status}: ${run.stderr.slice(-500)}`);

    // `/mode work` applies to the plain line (work-mode envelopes) ...
    assert.equal((run.stdout.match(/mode: work/g) ?? []).length, 2, run.stdout);
    // ... and then /mode with no argument reports it unchanged.
    assert.match(run.stderr, /usage: \/mode \[consult\|work\]/);

    const tasks = userMessages(sessionFile);
    assert.equal(tasks[0], "Do the work-mode task");
    assert.equal(
      tasks[1],
      basePrompt("plan").replace("$ARGUMENTS", "A plan for the work-mode conversation"),
    );
    assert.deepEqual(eventKinds(sessionFile), [
      "message",
      "delegation",
      "deliverable",
      "review",
      "decision",
      "message",
      "consult",
      "proposal",
      "review",
      "decision",
    ]);
  } finally {
    dir.cleanup();
  }
});

test("chat REPL: /compact compacts a long context and rewrites the session file", () => {
  const dir = tmpdir("tb-cli-compact-");
  const sessionFile = path.join(dir.root, "s.jsonl");
  try {
    const run = runChat(
      ["--provider", "mock", "--session-file", sessionFile, "--compact-keep-recent", "80"],
      "First turn task\n/compact\n\n",
      dir.root,
    );
    assert.equal(run.status, 0, `exit ${run.status}: ${run.stderr.slice(-500)}`);
    assert.match(run.stdout, /compacted: 5 → 3 envelopes/, run.stdout);
    assert.match(run.stdout, /rewrote .*s\.jsonl/, run.stdout);

    // dense seq after the rewrite, the task head kept, the summary inserted
    const events = sessionEvents(sessionFile);
    assert.equal(events.length, 3);
    assert.deepEqual(events.map((event) => event.seq), [1, 2, 3]);
    assert.equal(events[0]?.payload?.text, "First turn task");
    assert.ok(
      String(events[1]?.payload?.text ?? "").startsWith(COMPACTION_SUMMARY_PREFIX),
      "the compaction summary envelope is missing",
    );

    // the rewritten session resumes cleanly (no new turn, no re-append)
    const resumed = runChat(
      ["--provider", "mock", "--session-file", sessionFile, "--resume"],
      "",
      dir.root,
    );
    assert.equal(resumed.status, 0, `resume exit ${resumed.status}: ${resumed.stderr.slice(-500)}`);
    assert.match(resumed.stdout, /Two Brothers REPL/);
    assert.equal(sessionEvents(sessionFile).length, 3);
  } finally {
    dir.cleanup();
  }
});

test("chat REPL: /compact says nothing to compact when the tail already fits", () => {
  const dir = tmpdir("tb-cli-compact-short-");
  const sessionFile = path.join(dir.root, "s.jsonl");
  try {
    const run = runChat(
      ["--provider", "mock", "--session-file", sessionFile],
      "One short turn\n/compact\n\n",
      dir.root,
    );
    assert.equal(run.status, 0, `exit ${run.status}: ${run.stderr.slice(-500)}`);
    assert.match(run.stdout, /nothing to compact/, run.stdout);
    assert.equal(sessionEvents(sessionFile).length, 5);
  } finally {
    dir.cleanup();
  }
});

test("chat REPL: /export writes the session as Markdown", () => {
  const dir = tmpdir("tb-cli-export-");
  const sessionFile = path.join(dir.root, "s.jsonl");
  try {
    const run = runChat(
      ["--provider", "mock", "--session-file", sessionFile],
      "Name one benefit of code review\n/export export.md\n\n",
      dir.root,
    );
    assert.equal(run.status, 0, `exit ${run.status}: ${run.stderr.slice(-500)}`);
    assert.match(run.stdout, /exported: .*export\.md \(5 envelopes\)/, run.stdout);

    const exported = fs.readFileSync(path.join(dir.root, "export.md"), "utf-8");
    assert.ok(exported.startsWith("# Name one benefit of code review\n"), exported.slice(0, 200));
    assert.ok(exported.includes("- envelopes: 5"), exported);
    assert.ok(exported.includes("- session: s.jsonl"), exported);
    assert.ok(exported.includes("## 1. user → senior · message"), exported);
    assert.ok(exported.includes("Name one benefit of code review"));
    assert.ok(exported.endsWith("\n") && !exported.endsWith("\n\n"));
  } finally {
    dir.cleanup();
  }
});

test("chat REPL: /status and /permission report honest local state; /new refuses", () => {
  const dir = tmpdir("tb-cli-status-");
  try {
    const run = runChat(
      ["--provider", "mock"],
      "/status\n/permission\n/new\n\n",
      dir.root,
    );
    assert.equal(run.status, 0, `exit ${run.status}: ${run.stderr.slice(-500)}`);
    const stdout = run.stdout;

    assert.match(stdout, /^status:$/m);
    assert.match(stdout, /^ {2}session: \(none; in-memory\)$/m);
    assert.match(stdout, /^ {2}mode: consult$/m);
    assert.match(stdout, /^ {2}context: 0 events, 0 chars \(~0 tokens\)$/m);
    assert.match(stdout, /^roles:$/m);
    assert.match(stdout, /senior: provider=mock model=\(unset\)/);

    assert.match(stdout, /^permission:$/m);
    assert.match(stdout, /policy: fail-closed/);
    assert.match(stdout, /broker: none in the line REPL/);
    assert.match(stdout, /workspace: none — CLI runs are not workspace-bound/);
    assert.match(stdout, /tool scopes: MCP not configured/);
    assert.match(stdout, /plugins: 0 discovered/);

    // /new is honest: the line REPL cannot start a fresh session in place
    assert.match(stdout, /new: the line REPL cannot start a fresh session in place/);
    assert.match(stdout, /exit \(\/exit or Ctrl\+D\)/);
  } finally {
    dir.cleanup();
  }
});

test("chat REPL: /help and /commands list built-ins grouped, then discovered templates", () => {
  const dir = tmpdir("tb-cli-basehelp-");
  const commandsRoot = path.join(dir.root, "commands");
  fs.mkdirSync(commandsRoot);
  writeCommand(
    commandsRoot,
    "plan",
    ["---", "description: Discovered plan", "argument-hint: <topic>", "---", "DISCOVERED PLAN $ARGUMENTS", ""].join(
      "\n",
    ),
  );
  const sessionFile = path.join(dir.root, "s.jsonl");
  try {
    const run = runChat(
      ["--provider", "mock", "--session-file", sessionFile, "--commands-dir", commandsRoot],
      "/help\n/commands\n/plan override me\n/nope\n\n",
      dir.root,
    );
    assert.equal(run.status, 0, `exit ${run.status}: ${run.stderr.slice(-500)}`);
    const stdout = run.stdout;

    // /help keeps the REPL command list and adds both groups
    assert.match(stdout, /REPL commands:/);
    assert.match(stdout, /prompt commands \(submit a task this turn\):/);
    assert.match(stdout, /action commands \(performed by the REPL\):/);
    assert.ok(stdout.includes("/plan — Agree an ordered"), stdout);
    assert.ok(stdout.includes("(<objective>)"), stdout);
    assert.ok(stdout.includes("/compact — Compact the conversation context"), stdout);
    assert.ok(stdout.includes("/export — Export this session as Markdown ([path])"), stdout);
    assert.ok(stdout.includes("discovered commands:"), stdout);

    // /commands uses the same listing shape for the discovered template
    assert.ok(stdout.includes("plan — Discovered plan (<topic>)"), stdout);

    // a discovered template wins over the same-named built-in prompt command
    const tasks = userMessages(sessionFile);
    assert.equal(tasks[0], "DISCOVERED PLAN override me");

    // the unknown-name note is unchanged
    assert.match(run.stderr, /unknown command: nope/);
    assert.ok(tasks.every((task) => !task.includes("/nope")));
  } finally {
    dir.cleanup();
  }
});

// ---------------------------------------------------------------------------
// (iv) per-turn process signal handling (CLI cooperative cancellation)
// ---------------------------------------------------------------------------

/** Minimal EventEmitter stand-in: no process signals reach the test runner. */
class FakeEmitter implements TurnSignalEmitter {
  private readonly listeners = new Map<string, Set<() => void>>();

  on(event: string, listener: () => void): this {
    const set = this.listeners.get(event) ?? new Set<() => void>();
    set.add(listener);
    this.listeners.set(event, set);
    return this;
  }

  off(event: string, listener: () => void): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  emit(event: string): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener();
  }

  count(event?: string): number {
    if (event !== undefined) return this.listeners.get(event)?.size ?? 0;
    let total = 0;
    for (const set of this.listeners.values()) total += set.size;
    return total;
  }
}

test("turn signals: first SIGINT cancels, second forces the conventional exit", () => {
  const emitter = new FakeEmitter();
  const cancels: string[] = [];
  const exits: Array<{ code: number; signal: string }> = [];
  const notices: string[] = [];
  const handlers = installTurnSignalHandlers({
    emitter,
    platform: "win32",
    onCancel: (signal) => cancels.push(signal),
    onForceExit: (code, signal) => exits.push({ code, signal }),
    onNotice: (line) => notices.push(line),
  });
  try {
    emitter.emit("SIGINT");
    assert.deepEqual(cancels, ["SIGINT"]);
    assert.equal(notices.length, 1, "exactly one bounded notice on the first signal");
    assert.equal(notices[0], turnCancelNotice("SIGINT"));
    assert.match(notices[0], /Ctrl\+C again to exit immediately/);
    assert.equal(notices[0].includes("\u001b"), false, "notice is plain text");

    emitter.emit("SIGINT");
    assert.deepEqual(cancels, ["SIGINT"], "a repeated signal never re-cancels");
    assert.deepEqual(exits, [{ code: 130, signal: "SIGINT" }]);

    // Nothing happens after the forced exit was requested.
    emitter.emit("SIGINT");
    assert.equal(exits.length, 1);
  } finally {
    handlers.dispose();
  }
});

test("turn signals: SIGTERM cancels then forces 143", () => {
  const emitter = new FakeEmitter();
  const cancels: string[] = [];
  const exits: number[] = [];
  const handlers = installTurnSignalHandlers({
    emitter,
    platform: "win32",
    onCancel: (signal) => cancels.push(signal),
    onForceExit: (code) => exits.push(code),
  });
  try {
    emitter.emit("SIGTERM");
    emitter.emit("SIGTERM");
    assert.deepEqual(cancels, ["SIGTERM"]);
    assert.deepEqual(exits, [143]);
  } finally {
    handlers.dispose();
  }
});

test("turn signals: SIGHUP is POSIX-only (installed on linux, absent on win32)", () => {
  const win = new FakeEmitter();
  const winCancels: string[] = [];
  const winHandlers = installTurnSignalHandlers({
    emitter: win,
    platform: "win32",
    onCancel: (signal) => winCancels.push(signal),
    onForceExit: () => {},
  });
  try {
    win.emit("SIGHUP");
    assert.deepEqual(winCancels, [], "no SIGHUP handler on Windows");
    assert.equal(win.count("SIGHUP"), 0);
  } finally {
    winHandlers.dispose();
  }

  const posix = new FakeEmitter();
  const posixCancels: string[] = [];
  const exits: number[] = [];
  const posixHandlers = installTurnSignalHandlers({
    emitter: posix,
    platform: "linux",
    onCancel: (signal) => posixCancels.push(signal),
    onForceExit: (code) => exits.push(code),
  });
  try {
    posix.emit("SIGHUP");
    assert.deepEqual(posixCancels, ["SIGHUP"]);
    posix.emit("SIGHUP");
    assert.deepEqual(exits, [129]);
    assert.equal(turnSignalExitCode("SIGHUP"), 129);
  } finally {
    posixHandlers.dispose();
  }
});

test("turn signals: dispose removes every listener and is idempotent", () => {
  const emitter = new FakeEmitter();
  const cancels: string[] = [];
  const handlers = installTurnSignalHandlers({
    emitter,
    platform: "linux",
    onCancel: (signal) => cancels.push(signal),
    onForceExit: () => {},
  });
  assert.equal(emitter.count(), 3, "SIGINT, SIGTERM and SIGHUP on POSIX");
  handlers.dispose();
  handlers.dispose();
  assert.equal(emitter.count(), 0, "no handler survives the turn");
  emitter.emit("SIGINT");
  emitter.emit("SIGHUP");
  assert.deepEqual(cancels, [], "a stray signal after settle is not ours");
});

test("turn signals: a REPL emitter only carries SIGINT", () => {
  const processEmitter = new FakeEmitter();
  const repl = new FakeEmitter();
  const cancels: string[] = [];
  const handlers = installTurnSignalHandlers({
    emitter: processEmitter,
    platform: "win32",
    sigintEmitters: [repl],
    onCancel: (signal) => cancels.push(signal),
    onForceExit: () => {},
  });
  try {
    repl.emit("SIGTERM");
    assert.deepEqual(cancels, [], "readline only rises for Ctrl+C");
    repl.emit("SIGINT");
    assert.deepEqual(cancels, ["SIGINT"]);
  } finally {
    handlers.dispose();
  }
  assert.equal(repl.count(), 0, "the REPL listener is removed with the turn");
});

test("turn wait: normal runs are not bounded, cancelled runs settle, stuck cleanup times out", async () => {
  // No cancellation: a long-running turn is awaited normally.
  const noCancel = await waitForTurnOutcome(Promise.resolve(1), new Promise(() => {}), 5);
  assert.deepEqual(noCancel, { status: "settled", value: 1 });

  // Cancelled, then the turn settles inside the budget.
  let release: ((value: number) => void) | null = null;
  const work = new Promise<number>((resolve) => {
    release = resolve;
  });
  const pending = waitForTurnOutcome(work, Promise.resolve(), 1_000);
  const timer = setTimeout(() => release?.(7), 5);
  try {
    assert.deepEqual(await pending, { status: "settled", value: 7 });
  } finally {
    clearTimeout(timer);
  }

  // Cancelled and never settles: the budget ends the wait instead of hanging.
  const started = Date.now();
  const stuck = await waitForTurnOutcome(new Promise(() => {}), Promise.resolve(), 10);
  assert.equal(stuck.status, "timeout");
  assert.ok(Date.now() - started < 1_000, "the bounded wait returned promptly");
});

test("turn budget covers run_shell's kill + drain", () => {
  assert.ok(TURN_CANCEL_BUDGET_MS >= SHELL_DRAIN_BUDGET_MS + 500);
});

test("cli wiring: turns own a controller, chat forwards readline SIGINT, serve handles SIGHUP", () => {
  const source = fs.readFileSync(CLI, "utf-8");
  assert.match(source, /installTurnSignalHandlers\(\{/);
  assert.match(source, /signal: controller\.signal/);
  assert.match(source, /cancelEmitter: rl/);
  assert.match(source, /process\.on\("SIGHUP", onSighup\)/);
  assert.match(source, /process\.platform !== "win32"/);
});