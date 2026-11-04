/**
 * Hermetic CLI E2E suite: drives the BUILT (or source) CLI as a real
 * subprocess — `node src/cli.ts` by default, `node dist/cli.js` with
 * `--dist` or TWO_BROTHERS_E2E_CLI_DIST=1 — and asserts exit codes plus
 * key output. Fully offline: every scenario uses `--provider mock`, temp
 * sessions directories under the system temp, and the checked-in MCP demo
 * fixture. Nothing here needs a live model endpoint.
 *
 *   node e2e/cli.ts            # sources (Node native type stripping)
 *   node e2e/cli.ts --dist     # built dist/ (the published artifact)
 *
 * Exit codes: 0 = every scenario passed; 1 = at least one failed.
 * Report idiom follows e2e/run.ts (PASS/FAIL lines, final verdict).
 */
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

const DIST =
  process.env.TWO_BROTHERS_E2E_CLI_DIST === "1" || process.argv.includes("--dist");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, "..");
const REPO_ROOT = path.resolve(PKG_ROOT, "..", "..");
const CLI = DIST ? path.join(PKG_ROOT, "dist", "cli.js") : path.join(PKG_ROOT, "src", "cli.ts");
const WEB_DIST = path.join(REPO_ROOT, "web", "dist");
/** cwd for spawned runs: the MCP fixture references tests/fixtures relatively. */
const CLI_CWD = PKG_ROOT;

class CheckError extends Error {}

function check(condition: boolean, message: string): void {
  if (!condition) throw new CheckError(message);
}

function log(line: string): void {
  console.log(line);
}

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], timeoutMs = 60_000): CliResult {
  const run = spawnSync(process.execPath, [CLI, ...args], {
    cwd: CLI_CWD,
    timeout: timeoutMs,
    encoding: "utf-8",
    env: { ...process.env },
  });
  return { status: run.status, stdout: run.stdout ?? "", stderr: run.stderr ?? "" };
}

/** Envelope kinds in render order from `run` stdout (`[user]` == message). */
function envelopeKinds(stdout: string): string[] {
  const kinds: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith("[user]")) {
      kinds.push("message");
      continue;
    }
    const match = /^\[(?:senior|junior) -> (?:senior|junior|user)\] (\w+)/.exec(line);
    if (match) kinds.push(match[1]);
  }
  return kinds;
}

function loadSessionSeqs(sessionFile: string): number[] {
  return fs
    .readFileSync(sessionFile, "utf-8")
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => (JSON.parse(line) as { seq: number }).seq);
}

function mkTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Reserve a free loopback port by bind-then-release. */
async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function getJson(url: string, timeoutMs = 5_000): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    fetch(url, { signal: controller.signal })
      .then(async (response) => {
        const text = await response.text();
        let body: unknown = text;
        try {
          body = JSON.parse(text);
        } catch {
          // keep the raw body (e.g. HTML)
        }
        resolve({ status: response.status, body });
      })
      .catch(reject)
      .finally(() => clearTimeout(timer));
  });
}

async function waitForServer(base: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const response = await getJson(`${base}/api/sessions`, 1_000);
      if (response.status === 200) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (exc) {
      lastError = exc;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new CheckError(`server did not become ready: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function stopChild(child: ChildProcess, timeoutMs = 5_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

// ---------------------------------------------------------------------------
// scenarios
// ---------------------------------------------------------------------------

async function scenarioConsult(): Promise<string> {
  const dir = mkTempDir("tb-cli-consult-");
  try {
    const sessionFile = path.join(dir, "s.jsonl");
    const result = runCli([
      "run", "Name one benefit of code review",
      "--provider", "mock",
      "--session-file", sessionFile,
    ]);
    check(result.status === 0, `exit code ${result.status}: ${result.stderr.slice(-300)}`);
    const kinds = envelopeKinds(result.stdout);
    check(
      kinds.join(",") === "message,consult,proposal,review,decision",
      `unexpected kind sequence: ${kinds.join(",")}`,
    );
    assert.match(result.stdout, /^tokens: \d+\/\d+ \(cache \d+%, \d+ model calls\)$/m, "usage footer missing");
    return `${kinds.length} envelopes (${kinds.join(" -> ")}), usage footer present`;
  } finally {
    rmDir(dir);
  }
}

async function scenarioChat(): Promise<string> {
  const dir = mkTempDir("tb-cli-chat-");
  try {
    const sessionFile = path.join(dir, "s.jsonl");
    // piped stdin drives the REPL: one task, /config, /help, empty line exits
    const run = spawnSync(
      process.execPath,
      [CLI, "chat", "--provider", "mock", "--session-file", sessionFile],
      {
        cwd: CLI_CWD,
        timeout: 60_000,
        encoding: "utf-8",
        env: { ...process.env },
        input: "Name one benefit of code review\n/config\n/help\n\n",
      },
    );
    check(run.status === 0, `exit code ${run.status}: ${String(run.stderr).slice(-300)}`);
    const stdout = run.stdout ?? "";
    check(
      /senior: provider=mock model=\(unset\)/.test(stdout),
      "resolved per-role banner missing",
    );
    check(/\[senior -> user\] decision/.test(stdout), "decision not rendered");
    check(/REPL commands/.test(stdout), "/help listing missing");
    const kinds = envelopeKinds(stdout);
    check(
      kinds.join(",") === "message,consult,proposal,review,decision",
      `unexpected kind sequence: ${kinds.join(",")}`,
    );
    return "banner + /config + /help + consult cycle over piped stdin";
  } finally {
    rmDir(dir);
  }
}

async function scenarioHelp(): Promise<string> {
  // bare invocation on piped (non-TTY) stdin prints usage, like scripts see it
  const bare = runCli([]);
  check(bare.status === 0, `bare exit code ${bare.status}`);
  check(/two-brothers run "<task>"/.test(bare.stdout), "bare usage screen missing");
  for (const alias of ["help", "--help", "-h"]) {
    const result = runCli([alias]);
    check(result.status === 0, `${alias} exit code ${result.status}`);
    check(!/Unknown command/.test(result.stderr), `${alias} printed Unknown command`);
    check(/two-brothers run "<task>"/.test(result.stdout), `${alias} usage screen missing`);
  }
  const bogus = runCli(["bogus"]);
  check(bogus.status === 2, `unknown command exit code ${bogus.status}`);
  check(/Unknown command: bogus/.test(bogus.stderr), "unknown command diagnostic missing");
  return "bare/help/--help/-h exit 0 with usage; unknown command exits 2";
}

async function scenarioWork(): Promise<string> {
  const dir = mkTempDir("tb-cli-work-");
  try {
    const sessionFile = path.join(dir, "s.jsonl");
    const result = runCli([
      "run", "List the files in the workspace",
      "--mode", "work",
      "--provider", "mock",
      "--session-file", sessionFile,
    ]);
    check(result.status === 0, `exit code ${result.status}: ${result.stderr.slice(-300)}`);
    const kinds = envelopeKinds(result.stdout);
    check(
      kinds.join(",") === "message,delegation,deliverable,review,decision",
      `unexpected kind sequence: ${kinds.join(",")}`,
    );
    check(/\[junior -> senior\] deliverable/.test(result.stdout), "deliverable envelope not rendered");
    return `${kinds.length} envelopes (${kinds.join(" -> ")})`;
  } finally {
    rmDir(dir);
  }
}

async function scenarioSessionResume(): Promise<string> {
  const dir = mkTempDir("tb-cli-resume-");
  try {
    const sessionFile = path.join(dir, "s.jsonl");
    const first = runCli([
      "run", "Name one benefit of code review",
      "--provider", "mock",
      "--session-file", sessionFile,
    ]);
    check(first.status === 0, `run 1 exit code ${first.status}: ${first.stderr.slice(-300)}`);
    const seqs1 = loadSessionSeqs(sessionFile);
    check(
      seqs1.join(",") === "1,2,3,4,5",
      `run 1 seqs not dense 1..5: ${seqs1.join(",")}`,
    );

    const second = runCli([
      "run", "Name one risk of tight deadlines",
      "--provider", "mock",
      "--session-file", sessionFile,
      "--resume",
    ]);
    check(second.status === 0, `resume exit code ${second.status}: ${second.stderr.slice(-300)}`);
    const seqs2 = loadSessionSeqs(sessionFile);
    check(seqs2.length === 10, `expected 10 envelopes after resume, got ${seqs2.length}`);
    check(
      new Set(seqs2).size === seqs2.length,
      `duplicate seqs after resume: ${seqs2.join(",")}`,
    );
    check(
      seqs2.every((seq, i) => seq === i + 1),
      `seqs not dense after resume: ${seqs2.join(",")}`,
    );

    const listed = runCli(["sessions", "--sessions-dir", dir]);
    check(listed.status === 0, `sessions exit code ${listed.status}: ${listed.stderr.slice(-300)}`);
    check(listed.stdout.includes("s.jsonl"), "sessions listing misses the session file");
    check(
      listed.stdout.includes("Name one benefit of code review"),
      `sessions listing misses the derived title: ${listed.stdout.trim()}`,
    );
    return `seqs 1..5 then dense 1..10, no dups; sessions lists derived title`;
  } finally {
    rmDir(dir);
  }
}

async function scenarioMcp(): Promise<string> {
  const dir = mkTempDir("tb-cli-mcp-");
  try {
    const sessionFile = path.join(dir, "s.jsonl");
    const result = runCli([
      "run", "Say hello",
      "--provider", "mock",
      "--mcp-config", "tests/fixtures/mcp-config.stdio.json",
      "--session-file", sessionFile,
    ]);
    check(result.status === 0, `exit code ${result.status}: ${result.stderr.slice(-300)}`);
    assert.doesNotMatch(result.stderr, /\[warn\] MCP:/, "MCP client failed to load");
    return "MCP stdio client loaded (tests/fixtures/mcp-config.stdio.json); mock run unaffected";
  } finally {
    rmDir(dir);
  }
}

async function scenarioServe(): Promise<string> {
  const dir = mkTempDir("tb-cli-serve-");
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [CLI, "serve", "--port", String(port), "--sessions-dir", dir], {
    cwd: CLI_CWD,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf-8")));
  try {
    await waitForServer(base);

    const sessions = await getJson(`${base}/api/sessions`);
    check(sessions.status === 200, `GET /api/sessions -> HTTP ${sessions.status}`);
    check(Array.isArray(sessions.body), "GET /api/sessions must return a list");

    const index = await getJson(base + "/");
    let webNote: string;
    if (fs.existsSync(path.join(WEB_DIST, "index.html"))) {
      check(index.status === 200, `GET / -> HTTP ${index.status} (web/dist exists)`);
      check(
        typeof index.body === "string" && index.body.toLowerCase().includes("<html"),
        "GET / did not serve the web/dist index.html",
      );
      webNote = "GET / serves web/dist index.html";
    } else {
      check(index.status === 404, `GET / -> HTTP ${index.status}, expected 404 (no web/dist)`);
      webNote = "web/dist not built: GET / -> 404 (expected)";
    }
    check(stderr === "", `serve wrote to stderr: ${stderr.slice(-200)}`);
    return `/api/sessions 200; ${webNote}; clean shutdown`;
  } finally {
    await stopChild(child);
    rmDir(dir);
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const SCENARIOS: Array<{ name: string; run: () => Promise<string> }> = [
  { name: "consult", run: scenarioConsult },
  { name: "chat-repl", run: scenarioChat },
  { name: "help", run: scenarioHelp },
  { name: "work", run: scenarioWork },
  { name: "session+resume", run: scenarioSessionResume },
  { name: "mcp", run: scenarioMcp },
  { name: "serve", run: scenarioServe },
];

async function main(): Promise<number> {
  check(fs.existsSync(CLI), `CLI entry not found: ${CLI}${DIST ? " (run npm run build first)" : ""}`);
  log(`E2E CLI: entry ${path.relative(REPO_ROOT, CLI)} (dist=${DIST}), node ${process.version}`);

  let failures = 0;
  for (const scenario of SCENARIOS) {
    const started = Date.now();
    try {
      const detail = await scenario.run();
      log(`  PASS ${scenario.name} (${((Date.now() - started) / 1000).toFixed(1)}s) — ${detail}`);
    } catch (exc) {
      failures += 1;
      log(`  FAIL ${scenario.name} (${((Date.now() - started) / 1000).toFixed(1)}s) — ${exc instanceof Error ? exc.message : String(exc)}`);
    }
  }
  log(failures === 0 ? "E2E CLI: PASS" : `E2E CLI: FAIL (${failures} scenario(s) failed)`);
  return failures === 0 ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exitCode = 1;
  });
