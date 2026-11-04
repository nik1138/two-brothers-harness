/**
 * CLI wiring for the polish wave: `run --stream --stream-tokens` and the chat
 * REPL's slash-command dispatch. Hermetic: mock providers only, temp
 * directories for sessions/commands, and (for the REPL) a real CLI
 * subprocess driven over piped stdin — the same idiom as `e2e/cli.ts`.
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