/**
 * Opt-in serve-level load/soak runner (MANUAL / release observation).
 *
 * Starts the REAL `serve` backend (built `dist/cli.js serve`) with the mock
 * provider for a hermetic self-test, or with an operator-provided
 * OpenAI-compatible endpoint, registers a temp workspace + one session per run
 * over HTTP, submits a bounded-concurrency batch of `POST /api/runs`, polls
 * `GET /api/runs` until every run is terminal, and reports honest per-run
 * `queued -> running -> completed` timings plus a summary. This exercises the
 * actual RunManager/worker-pool/queue path — the CLI-level `e2e/load.ts` cannot
 * see it — while remaining a manual tool: nothing here belongs to `npm test`,
 * the smoke gate or CI.
 *
 *   node e2e/serve-load.ts --mock --runs 3 --workers 1        # hermetic self-test
 *   node e2e/serve-load.ts --base-url http://192.168.31.123:1234/v1 \
 *     --model lfm3-1.7b --runs 2 --workers 1 --timeout 900 --retries 1
 *
 * Design notes:
 * - Every run gets its own session (`POST /api/sessions`, workspace-linked).
 *   RunManager serializes runs that share a session (context `seq` invariant),
 *   so per-run sessions are what let `--workers > 1` actually run runs
 *   concurrently; with the default `--workers 1` the queue is observable.
 * - Timings are client-observed (a `GET /api/runs` snapshot every poll
 *   interval; the server records only whole seconds), and the summary says so.
 * - Spawns `dist/cli.js` (run `npm run build` first); falls back to
 *   `src/cli.ts` with a warning when the build is missing.
 *
 * Exit codes: 0 = every run reached `completed`; 1 = at least one run failed,
 * was cancelled or missed the deadline / the server could not start; 2 =
 * invalid usage. SIGINT/SIGTERM stop the serve child and exit 130/143; a normal
 * exit stops it too, so no orphan server is left behind. Temp dirs are removed
 * unless `--keep` is given.
 */
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, "..");
const DIST_CLI = path.join(PKG_ROOT, "dist", "cli.js");
const SRC_CLI = path.join(PKG_ROOT, "src", "cli.ts");

const DEFAULT_RUNS = 3;
const MAX_RUNS = 50;
const DEFAULT_WORKERS = 1;
const MAX_WORKERS = 32;
const DEFAULT_PORT = 8631;
const MAX_CONCURRENCY = 50;
const DEFAULT_TIMEOUT_S = 120;
const MAX_TIMEOUT_S = 3600;
const DEFAULT_RETRIES = 1;
const MAX_RETRIES = 10;
const DEFAULT_TASK = "Plan a reversible migration from Redis to Valkey";
const MARKER = "serve-load marker: WAVE12-MARKER-9";

/** Readiness poll cadence while the server boots. */
const HEALTH_INTERVAL_MS = 200;
const HEALTH_TIMEOUT_MS = 30_000;
/** Run-state polling cadence (one `GET /api/runs` snapshot per tick). */
const POLL_INTERVAL_MS = 150;
/** Mock runs can finish in well under the real cadence: poll tightly in --mock. */
const MOCK_POLL_INTERVAL_MS = 25;
/** Graceful serve-SIGTERM window before the child is hard-killed. */
const SERVE_STOP_GRACE_MS = 5000;
/** Per-run wall cap derived from --timeout; the whole batch deadline adds the rest. */
const PER_RUN_CAP_MIN_S = 120;
/** Extra headroom added to the batch deadline for startup/shutdown/HTTP overhead. */
const DEADLINE_HEADROOM_MS = 120_000;
/** Bounded serve stdout/stderr capture for diagnostics. */
const SERVE_LOG_TAIL_CHARS = 8000;
const PRINTED_LOG_TAIL_CHARS = 1200;
/** Control-route HTTP timeout. */
const HTTP_TIMEOUT_MS = 15_000;

const TERMINAL_STATES = new Set(["completed", "failed", "cancelled"]);

interface Options {
  mock: boolean;
  baseUrl: string | null;
  model: string | null;
  runs: number;
  workers: number;
  concurrency: number;
  port: number;
  timeoutS: number;
  retries: number;
  keep: boolean;
  task: string;
}

interface ApiResponse {
  status: number;
  body: unknown;
}

interface TrackedRun {
  index: number;
  submitAt: number;
  session: string | null;
  runId: string | null;
  states: Array<{ at: number; status: string }>;
  lastStatus: string;
  firstRunningAt: number | null;
  terminalAt: number | null;
  terminalStatus: string | null;
  usage: Record<string, unknown> | null;
  error: string | null;
  submitError: string | null;
  /** Wall time the run's submit POST pair took (server backpressure is visible here). */
  submitLatencyMs: number | null;
  /** Server-persisted `run_status`/`run_end` sequence (authoritative transitions). */
  sidecarStates: Array<{ atS: number; status: string }>;
  /** Server-recorded whole-second epochs (fallback when polling misses a state). */
  serverCreatedS: number | null;
  serverStartedS: number | null;
  serverFinishedS: number | null;
  timedOut: boolean;
  stopRequested: boolean;
}

function usage(): string {
  return [
    "Usage: node e2e/serve-load.ts (--mock | --base-url <url> --model <id>) [flags]",
    "",
    "Opt-in serve-level load/soak runner: starts the real serve backend, registers a",
    "temp workspace + one session per run over HTTP, submits bounded-concurrency",
    "POST /api/runs, polls until terminal, and reports queued->running->completed",
    "timings plus a summary. It starts a local server and (real mode) sends REAL",
    "model calls: it is never run by `npm test`, the smoke gate or CI.",
    "",
    "Modes (the first two are required unless --mock):",
    "  --mock               start serve with --provider mock (hermetic self-test)",
    "  --base-url <url>     OpenAI-compatible base URL (env TWO_BROTHERS_E2E_BASE_URL)",
    "  --model <id>         model id used for BOTH roles (env TWO_BROTHERS_E2E_MODEL)",
    "  (an endpoint that needs auth: set TWO_BROTHERS_E2E_API_KEY, forwarded to the",
    "   serve child as TWO_BROTHERS_API_KEY; keys are never printed or put in argv)",
    "",
    "Options:",
    `  --runs <n>           total runs (default ${DEFAULT_RUNS}, max ${MAX_RUNS})`,
    `  --workers <n>        serve worker pool size (default ${DEFAULT_WORKERS}, max ${MAX_WORKERS}; ` +
      "passed as `serve --workers`; 1 keeps queueing visible)",
    "  --concurrency <n>    max in-flight POST /api/runs submissions (default = runs, " + `max ${MAX_CONCURRENCY})`,
    `  --port <n>           serve port (default ${DEFAULT_PORT}; fails clearly if busy)`,
    `  --timeout <s>        per-attempt provider timeout (default ${DEFAULT_TIMEOUT_S}, max ${MAX_TIMEOUT_S})`,
    `  --retries <n>        retries after a failed model call (default ${DEFAULT_RETRIES}, max ${MAX_RETRIES})`,
    `  --task <text>        task text (default "${DEFAULT_TASK}")`,
    "  --keep               keep the temp sessions dir + workspace for inspection",
    "  -h, --help           print this help and exit 0",
    "",
    "Exit codes: 0 = every run completed; 1 = failure/timeout/server error; 2 = invalid usage.",
    "",
    "Examples:",
    "  node e2e/serve-load.ts --mock --runs 3 --workers 1",
    "  node e2e/serve-load.ts --base-url http://192.168.31.123:1234/v1 --model lfm3-1.7b \\",
    "    --runs 2 --workers 1 --timeout 900 --retries 1",
    "",
    "Runs the built `dist/cli.js serve` (run `npm run build` first); falls back to",
    "`src/cli.ts` with a warning when the build is missing.",
  ].join("\n");
}

function fail(message: string): never {
  console.error(`[serve-load] error: ${message}`);
  console.error("");
  console.error(usage());
  process.exit(2);
}

function takeValue(argv: string[], index: number, flag: string): { value: string; next: number } {
  const token = argv[index];
  const eq = token.indexOf("=");
  if (eq >= 0) {
    const value = token.slice(eq + 1);
    if (value.trim() === "") fail(`${flag} needs a non-empty value`);
    return { value, next: index + 1 };
  }
  const raw = argv[index + 1];
  if (raw === undefined || raw.startsWith("--")) fail(`${flag} needs a value`);
  if (raw.trim() === "") fail(`${flag} needs a non-empty value`);
  return { value: raw, next: index + 2 };
}

function parseInteger(name: string, raw: string, min: number, max: number): number {
  const value = Number(raw);
  if (!Number.isInteger(value)) fail(`${name} must be an integer (got "${raw}")`);
  if (value < min || value > max) fail(`${name} must be between ${min} and ${max} (got ${value})`);
  return value;
}

function envValue(name: string): string | undefined {
  const value = process.env[name];
  return value !== undefined && value.trim() !== "" ? value.trim() : undefined;
}

function parseOptions(argv: string[]): Options {
  let mock = false;
  let keep = false;
  let baseUrl: string | undefined;
  let model: string | undefined;
  let runs = DEFAULT_RUNS;
  let workers = DEFAULT_WORKERS;
  let concurrency: number | undefined;
  let port = DEFAULT_PORT;
  let timeoutS = DEFAULT_TIMEOUT_S;
  let retries = DEFAULT_RETRIES;
  let task = DEFAULT_TASK;

  for (let i = 0; i < argv.length; ) {
    const token = argv[i];
    const flag = token.includes("=") ? token.slice(0, token.indexOf("=")) : token;
    switch (flag) {
      case "-h":
      case "--help": {
        console.log(usage());
        process.exit(0);
      }
      case "--mock": {
        mock = true;
        i += 1;
        break;
      }
      case "--keep": {
        keep = true;
        i += 1;
        break;
      }
      case "--base-url": {
        const taken = takeValue(argv, i, "--base-url");
        baseUrl = taken.value;
        i = taken.next;
        break;
      }
      case "--model": {
        const taken = takeValue(argv, i, "--model");
        model = taken.value;
        i = taken.next;
        break;
      }
      case "--runs": {
        const taken = takeValue(argv, i, "--runs");
        runs = parseInteger("--runs", taken.value, 1, MAX_RUNS);
        i = taken.next;
        break;
      }
      case "--workers": {
        const taken = takeValue(argv, i, "--workers");
        workers = parseInteger("--workers", taken.value, 1, MAX_WORKERS);
        i = taken.next;
        break;
      }
      case "--concurrency": {
        const taken = takeValue(argv, i, "--concurrency");
        concurrency = parseInteger("--concurrency", taken.value, 1, MAX_CONCURRENCY);
        i = taken.next;
        break;
      }
      case "--port": {
        const taken = takeValue(argv, i, "--port");
        port = parseInteger("--port", taken.value, 1, 65_535);
        i = taken.next;
        break;
      }
      case "--timeout": {
        const taken = takeValue(argv, i, "--timeout");
        timeoutS = parseInteger("--timeout", taken.value, 1, MAX_TIMEOUT_S);
        i = taken.next;
        break;
      }
      case "--retries": {
        const taken = takeValue(argv, i, "--retries");
        retries = parseInteger("--retries", taken.value, 0, MAX_RETRIES);
        i = taken.next;
        break;
      }
      case "--task": {
        const taken = takeValue(argv, i, "--task");
        task = taken.value;
        i = taken.next;
        break;
      }
      default:
        fail(`unknown argument "${token}" (see --help)`);
    }
  }

  const resolvedConcurrency = concurrency ?? runs;
  if (resolvedConcurrency < 1 || resolvedConcurrency > MAX_CONCURRENCY) {
    fail(`--concurrency must be between 1 and ${MAX_CONCURRENCY}`);
  }

  let resolvedBaseUrl: string | null = null;
  let resolvedModel: string | null = null;
  if (!mock) {
    const rawBaseUrl = baseUrl ?? envValue("TWO_BROTHERS_E2E_BASE_URL");
    if (rawBaseUrl === undefined) {
      fail("--base-url is required for a real run (or set TWO_BROTHERS_E2E_BASE_URL), or use --mock");
    }
    let parsed: URL;
    try {
      parsed = new URL(rawBaseUrl);
    } catch {
      fail(`--base-url is not a valid URL: "${rawBaseUrl}"`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      fail(`--base-url must be http(s): "${rawBaseUrl}"`);
    }
    resolvedBaseUrl = rawBaseUrl.replace(/\/+$/, "");
    const rawModel = model ?? envValue("TWO_BROTHERS_E2E_MODEL");
    if (rawModel === undefined) {
      fail("--model is required for a real run (or set TWO_BROTHERS_E2E_MODEL), or use --mock");
    }
    resolvedModel = rawModel;
  }

  return {
    mock,
    baseUrl: resolvedBaseUrl,
    model: resolvedModel,
    runs,
    workers,
    concurrency: resolvedConcurrency,
    port,
    timeoutS,
    retries,
    keep,
    task,
  };
}

function log(line: string): void {
  console.log(`[serve-load] ${line}`);
}

function warn(line: string): void {
  console.warn(`[serve-load] warning: ${line}`);
}

function seconds(ms: number): string {
  return (ms / 1000).toFixed(1);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Prefer the built artifact; warn + fall back to sources when missing. */
function resolveCli(): { path: string; label: string } {
  if (fs.existsSync(DIST_CLI)) return { path: DIST_CLI, label: "dist/cli.js (built artifact)" };
  if (fs.existsSync(SRC_CLI)) {
    warn(
      "dist/cli.js not found — falling back to src/cli.ts (Node native type stripping). " +
        "Run `npm run build` to load the published artifact.",
    );
    return { path: SRC_CLI, label: "src/cli.ts (source fallback; no build found)" };
  }
  throw new Error(`neither ${DIST_CLI} nor ${SRC_CLI} exists — run this from the package checkout`);
}

/** True when nothing is listening on 127.0.0.1:<port> (bind-then-release probe). */
function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

async function api(
  base: string,
  method: string,
  route: string,
  body?: unknown,
): Promise<ApiResponse> {
  const res = await fetch(base + route, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed };
}

function apiError(route: string, response: ApiResponse): string {
  const body = isRecord(response.body) && typeof response.body.detail === "string"
    ? response.body.detail
    : JSON.stringify(response.body);
  return `${route} -> HTTP ${response.status}: ${body}`;
}

/** Poll `GET /api/sessions` until the server answers; fail fast if the child exits. */
async function waitForHealth(
  base: string,
  child: ChildProcess,
  serveLog: { stdout: string; stderr: string },
): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let lastError = "";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `serve exited before becoming healthy (exit ${child.exitCode}` +
          `${child.signalCode ? `, signal ${child.signalCode}` : ""})\n` +
          `--- serve stderr ---\n${serveLog.stderr.slice(-PRINTED_LOG_TAIL_CHARS)}`,
      );
    }
    try {
      const response = await api(base, "GET", "/api/sessions");
      if (response.status === 200) return;
      lastError = `HTTP ${response.status}`;
    } catch (exc) {
      lastError = exc instanceof Error ? exc.message : String(exc);
    }
    await sleep(HEALTH_INTERVAL_MS);
  }
  throw new Error(`serve did not become healthy within ${HEALTH_TIMEOUT_MS / 1000}s (${lastError})`);
}

interface ServeHandle {
  child: ChildProcess;
  log: { stdout: string; stderr: string };
}

function spawnServe(options: Options, cli: { path: string }, sessionsDir: string): ServeHandle {
  const args = [
    cli.path,
    "serve",
    "--port",
    String(options.port),
    "--sessions-dir",
    sessionsDir,
    "--workers",
    String(options.workers),
    "--timeout",
    String(options.timeoutS),
  ];
  if (options.mock) {
    args.push("--provider", "mock");
  } else {
    args.push(
      "--base-url",
      options.baseUrl ?? "",
      "--senior-model",
      options.model ?? "",
      "--junior-model",
      options.model ?? "",
    );
  }
  // Ambient provider/worker switches must not leak into the controlled server:
  // the runner owns the connection and the pool size.
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of [
    "TWO_BROTHERS_PROVIDER",
    "TWO_BROTHERS_BASE_URL",
    "TWO_BROTHERS_API_KEY",
    "TWO_BROTHERS_SENIOR_MODEL",
    "TWO_BROTHERS_JUNIOR_MODEL",
    "TWO_BROTHERS_WORKERS",
    "TWO_BROTHERS_TIMEOUT",
    "TWO_BROTHERS_MODE",
    "TWO_BROTHERS_RETRIES",
    "TWO_BROTHERS_APPROVAL_MODE",
  ]) {
    delete env[key];
  }
  // Deliberate auth passthrough: an ambient key would leak an unrelated
  // credential into the tested server, so the runner only forwards the
  // dedicated opt-in variable (documented in e2e/README.md).
  const e2eKey = (process.env.TWO_BROTHERS_E2E_API_KEY ?? "").trim();
  if (e2eKey !== "") env.TWO_BROTHERS_API_KEY = e2eKey;
  env.TWO_BROTHERS_RETRIES = String(options.retries);

  const child = spawn(process.execPath, args, {
    cwd: PKG_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const handle: ServeHandle = { child, log: { stdout: "", stderr: "" } };
  child.stdout?.on("data", (chunk: Buffer) => {
    handle.log.stdout = (handle.log.stdout + chunk.toString("utf8")).slice(-SERVE_LOG_TAIL_CHARS);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    handle.log.stderr = (handle.log.stderr + chunk.toString("utf8")).slice(-SERVE_LOG_TAIL_CHARS);
  });
  return handle;
}

/**
 * Graceful stop: SIGTERM, wait up to the grace window, then SIGKILL. Returns
 * once the child has exited (or after the hard kill), never rejects.
 */
async function stopServe(handle: ServeHandle | null): Promise<void> {
  const child = handle?.child;
  if (child === undefined || child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
  try {
    child.kill("SIGTERM");
  } catch {
    // already gone
  }
  const timedOut = await Promise.race([
    exited.then(() => false),
    sleep(SERVE_STOP_GRACE_MS).then(() => true),
  ]);
  if (timedOut) {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
    await Promise.race([exited, sleep(1000)]);
  }
}

interface ReadyServer {
  base: string;
  sessionsDir: string;
  workspaceId: string;
  createdSession: string;
}

async function prepareServer(
  options: Options,
  cli: { path: string },
  workspaceDir: string,
  onSpawn: (handle: ServeHandle) => void,
): Promise<{ handle: ServeHandle; ready: ReadyServer }> {
  const sessionsDir = path.join(path.dirname(workspaceDir), "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });
  log(`starting serve on port ${options.port} (workers ${options.workers}${options.mock ? ", provider mock" : ""})`);
  const handle = spawnServe(options, cli, sessionsDir);
  // Register the handle with the caller immediately: a health/registration
  // failure or an interrupt during this setup must still stop the child.
  onSpawn(handle);
  const base = `http://127.0.0.1:${options.port}`;
  await waitForHealth(base, handle.child, handle.log);
  log("serve is healthy");

  const workspace = await api(base, "POST", "/api/workspaces", {
    path: workspaceDir,
    name: "serve-load-ws",
  });
  if (workspace.status !== 201 || !isRecord(workspace.body) || typeof workspace.body.id !== "string") {
    throw new Error(`workspace registration failed: ${apiError("POST /api/workspaces", workspace)}`);
  }
  const workspaceId = workspace.body.id;
  log(`workspace registered: ${workspaceId}`);

  // Validate the session-creation route + workspace link once up front; the
  // runs then each create their own session (see the design notes).
  const session = await api(base, "POST", "/api/sessions", {
    title: `serve-load probe (${options.runs} runs)`,
    workspace_id: workspaceId,
  });
  if (session.status !== 201 || !isRecord(session.body) || typeof session.body.name !== "string") {
    throw new Error(`session creation failed: ${apiError("POST /api/sessions", session)}`);
  }
  log(`session API verified: ${session.body.name}`);
  return {
    handle,
    ready: { base, sessionsDir, workspaceId, createdSession: session.body.name },
  };
}

/** Submit one run: per-run session (workspace-linked), then POST /api/runs. */
async function submitOne(
  ready: ReadyServer,
  options: Options,
  tracked: TrackedRun,
): Promise<void> {
  const submitStartedAt = Date.now();
  const session = await api(ready.base, "POST", "/api/sessions", {
    title: `serve-load run ${tracked.index}`,
    workspace_id: ready.workspaceId,
  });
  if (session.status !== 201 || !isRecord(session.body) || typeof session.body.name !== "string") {
    throw new Error(apiError("POST /api/sessions", session));
  }
  tracked.session = session.body.name;
  const run = await api(ready.base, "POST", "/api/runs", {
    task: options.task,
    session: session.body.name,
    workspace_id: ready.workspaceId,
  });
  if (run.status !== 202 || !isRecord(run.body) || typeof run.body.run_id !== "string") {
    throw new Error(apiError("POST /api/runs", run));
  }
  tracked.runId = run.body.run_id;
  tracked.submitLatencyMs = Date.now() - submitStartedAt;
  tracked.lastStatus = "queued";
  tracked.states.push({ at: Date.now(), status: "queued" });
}

interface SubmitOutcome {
  maxInFlightPosts: number;
}

/** The per-run tracking records, created before submission so polling can start first. */
function makeTracked(runs: number): TrackedRun[] {
  return Array.from({ length: runs }, (_, offset) => ({
    index: offset + 1,
    submitAt: Date.now(),
    session: null,
    runId: null,
    states: [],
    lastStatus: "",
    firstRunningAt: null,
    terminalAt: null,
    terminalStatus: null,
    usage: null,
    error: null,
    submitError: null,
    submitLatencyMs: null,
    sidecarStates: [],
    serverCreatedS: null,
    serverStartedS: null,
    serverFinishedS: null,
    timedOut: false,
    stopRequested: false,
  }));
}

/** Bounded-concurrency submission; every run keeps a record even when a POST fails. */
async function submitRuns(
  ready: ReadyServer,
  options: Options,
  tracked: TrackedRun[],
): Promise<SubmitOutcome> {
  const queue = tracked.map((entry) => entry.index - 1);
  let inFlight = 0;
  let maxInFlightPosts = 0;
  const poster = async (): Promise<void> => {
    for (;;) {
      const index = queue.shift();
      if (index === undefined) return;
      inFlight += 1;
      maxInFlightPosts = Math.max(maxInFlightPosts, inFlight);
      try {
        await submitOne(ready, options, tracked[index]);
      } catch (exc) {
        tracked[index].submitError = exc instanceof Error ? exc.message : String(exc);
      } finally {
        inFlight -= 1;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(options.concurrency, options.runs) }, () => poster()),
  );
  return { maxInFlightPosts };
}

interface PollStats {
  peakQueued: number;
  peakRunning: number;
}

/**
 * Poll `GET /api/runs` until every tracked run is terminal (and submission has
 * finished), or the deadline passes. Runs concurrently with submission so fast
 * (mock) runs still show their `queued -> running` transitions.
 */
async function pollUntilTerminal(
  ready: ReadyServer,
  tracked: TrackedRun[],
  deadline: number,
  submissionDone: () => boolean,
  pollIntervalMs: number,
): Promise<PollStats> {
  const stats: PollStats = { peakQueued: 0, peakRunning: 0 };
  for (;;) {
    let list: unknown = null;
    try {
      const response = await api(ready.base, "GET", "/api/runs");
      if (response.status === 200) list = response.body;
    } catch {
      // transient — retry on the next tick
    }
    const records = Array.isArray(list) ? list.filter(isRecord) : [];
    const byId = new Map<string, TrackedRun>();
    for (const entry of tracked) {
      if (entry.runId !== null) byId.set(entry.runId, entry);
    }
    let queuedNow = 0;
    let runningNow = 0;
    for (const record of records) {
      const runId = typeof record.run_id === "string" ? record.run_id : null;
      if (runId === null) continue;
      const trackedRun = byId.get(runId);
      if (trackedRun === undefined) continue;
      const status = typeof record.status === "string" ? record.status : "";
      const created = numberOrNull(record.created);
      const started = numberOrNull(record.started);
      const finished = numberOrNull(record.finished);
      if (created !== null) trackedRun.serverCreatedS = created;
      if (started !== null && started > 0) trackedRun.serverStartedS = started;
      if (finished !== null && finished > 0) trackedRun.serverFinishedS = finished;
      if (status === "queued" || status === "pending") queuedNow += 1;
      if (status === "running" || status === "waiting") runningNow += 1;
      if (status !== "" && status !== trackedRun.lastStatus) {
        trackedRun.lastStatus = status;
        trackedRun.states.push({ at: Date.now(), status });
        if ((status === "running" || status === "waiting") && trackedRun.firstRunningAt === null) {
          trackedRun.firstRunningAt = Date.now();
        }
      }
      if (TERMINAL_STATES.has(status)) {
        trackedRun.terminalStatus = status;
        trackedRun.terminalAt = Date.now();
        trackedRun.usage = isRecord(record.usage) ? record.usage : null;
        trackedRun.error = typeof record.error === "string" ? record.error : null;
      }
    }
    stats.peakQueued = Math.max(stats.peakQueued, queuedNow);
    stats.peakRunning = Math.max(stats.peakRunning, runningNow);
    const unsettled = tracked.filter(
      (entry) => entry.submitError === null && (entry.runId === null || entry.terminalStatus === null),
    );
    if (submissionDone() && unsettled.length === 0) break;
    if (Date.now() >= deadline) break;
    await sleep(pollIntervalMs);
  }
  return stats;
}

/** On the batch deadline, ask the server to stop whatever is still active. */
async function stopStragglers(ready: ReadyServer, tracked: TrackedRun[]): Promise<void> {
  for (const entry of tracked) {
    if (entry.runId === null || entry.terminalStatus !== null || entry.stopRequested) continue;
    entry.timedOut = true;
    entry.stopRequested = true;
    try {
      await api(ready.base, "POST", `/api/runs/${entry.runId}/stop`);
    } catch {
      // best effort; the deadline verdict stands either way
    }
  }
  // Give cooperative stops a moment to land so the terminal state is recorded.
  await sleep(500);
}

/**
 * Read the authoritative per-session runtime sidecars the server wrote
 * (`<sessions>/runtime/<session>.events.jsonl`): HTTP polling can miss fast
 * transitions (a mock run can starve the server's event loop), but the persisted
 * `run_status`/`run_end` records keep the exact per-run sequence.
 */
function collectSidecarStates(sessionsDir: string, tracked: TrackedRun[]): void {
  for (const entry of tracked) {
    if (entry.session === null || entry.runId === null) continue;
    const file = path.join(sessionsDir, "runtime", `${entry.session}.events.jsonl`);
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      continue; // no sidecar (run never started) — observed states remain
    }
    const sequence: Array<{ atS: number; status: string }> = [];
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(event) || event.run_id !== entry.runId) continue;
      if (typeof event.status !== "string") continue;
      if (event.type === "run_status" || event.type === "run_end") {
        sequence.push({ atS: numberOrNull(event.at) ?? 0, status: event.status });
      }
    }
    if (sequence.length > 0) entry.sidecarStates = sequence;
  }
}

interface RunTimings {
  queueMs: number | null;
  execMs: number | null;
  totalMs: number | null;
}

function timingsOf(tracked: TrackedRun): RunTimings {
  // Client-observed transitions first; when a fast run slipped past two poll
  // ticks fall back to the server's whole-second epochs / persisted run_status
  // sequence (still honest, coarser).
  const serverQueueMs =
    tracked.serverStartedS !== null && tracked.serverCreatedS !== null
      ? (tracked.serverStartedS - tracked.serverCreatedS) * 1000
      : null;
  const serverExecMs =
    tracked.serverFinishedS !== null && tracked.serverStartedS !== null
      ? (tracked.serverFinishedS - tracked.serverStartedS) * 1000
      : null;
  let sidecarQueueMs: number | null = null;
  let sidecarExecMs: number | null = null;
  if (tracked.sidecarStates.length > 0) {
    const queuedAtS = tracked.sidecarStates[0]?.atS ?? 0;
    const runningEntry = tracked.sidecarStates.find((entry) => entry.status === "running");
    const endEntry = tracked.sidecarStates[tracked.sidecarStates.length - 1];
    if (runningEntry !== undefined && runningEntry.atS > queuedAtS) {
      sidecarQueueMs = (runningEntry.atS - queuedAtS) * 1000;
    }
    if (runningEntry !== undefined && endEntry !== undefined && endEntry.atS > runningEntry.atS) {
      sidecarExecMs = (endEntry.atS - runningEntry.atS) * 1000;
    }
  }
  const queueMs =
    tracked.firstRunningAt !== null
      ? tracked.firstRunningAt - tracked.submitAt
      : serverQueueMs !== null && serverQueueMs > 0
        ? serverQueueMs
        : sidecarQueueMs;
  const execMs =
    tracked.firstRunningAt !== null && tracked.terminalAt !== null
      ? tracked.terminalAt - tracked.firstRunningAt
      : serverExecMs !== null && serverExecMs > 0
        ? serverExecMs
        : sidecarExecMs;
  const totalMs = tracked.terminalAt !== null ? tracked.terminalAt - tracked.submitAt : null;
  // Whole-second sidecar/record fallbacks are coarse: never let them exceed the
  // measured total (that would just be rounding noise), and keep them labelled
  // as fallbacks in the file header.
  const plausible = (value: number | null): number | null =>
    value !== null && (totalMs === null || value <= totalMs) ? value : null;
  return { queueMs: plausible(queueMs), execMs: plausible(execMs), totalMs };
}

function runPassed(tracked: TrackedRun): boolean {
  return tracked.submitError === null && !tracked.timedOut && tracked.terminalStatus === "completed";
}

function printRun(tracked: TrackedRun): void {
  const verdict = runPassed(tracked) ? "PASS" : "FAIL";
  const state = tracked.terminalStatus ?? (tracked.timedOut ? "timed out" : "not terminal");
  const timings = timingsOf(tracked);
  const parts = [`state ${state}`, `total ${seconds(timings.totalMs ?? 0)}s`];
  if (timings.queueMs !== null) parts.push(`queued ${seconds(timings.queueMs)}s`);
  if (timings.execMs !== null) parts.push(`ran ${seconds(timings.execMs)}s`);
  if (tracked.submitLatencyMs !== null) parts.push(`submit ${seconds(tracked.submitLatencyMs)}s`);
  const modelCalls = tracked.usage === null ? null : numberOrNull(tracked.usage.model_calls);
  if (modelCalls !== null) parts.push(`${modelCalls} model calls`);
  // The persisted run_status sequence is authoritative; polling states are the
  // fallback when the sidecar has nothing (e.g. a run that never started).
  const states =
    tracked.sidecarStates.length > 0
      ? tracked.sidecarStates.map((entry) => entry.status).join(" -> ")
      : tracked.states.map((entry) => entry.status).join(" -> ");
  console.log(
    `run ${tracked.index}: ${verdict} ${state} (${parts.join(", ")})` +
      `${states !== "" ? ` [${states}]` : ""}${tracked.session ? ` session ${tracked.session}` : ""}`,
  );
  if (tracked.submitError !== null) console.log(`  submit error: ${tracked.submitError}`);
  if (tracked.error !== null) console.log(`  run error: ${tracked.error}`);
}

function printSummary(
  options: Options,
  tracked: TrackedRun[],
  stats: PollStats,
  maxInFlightPosts: number,
  wallMs: number,
): boolean {
  const successes = tracked.filter(runPassed);
  const failures = tracked.filter((entry) => !runPassed(entry));
  const terminalCounts = new Map<string, number>();
  for (const entry of tracked) {
    const key = entry.timedOut ? "timed-out" : (entry.terminalStatus ?? "not-terminal");
    terminalCounts.set(key, (terminalCounts.get(key) ?? 0) + 1);
  }
  const queueTimes = tracked
    .map((entry) => timingsOf(entry).queueMs)
    .filter((value): value is number => value !== null);
  const execTimes = tracked
    .map((entry) => timingsOf(entry).execMs)
    .filter((value): value is number => value !== null);
  const submitTimes = tracked
    .map((entry) => entry.submitLatencyMs)
    .filter((value): value is number => value !== null);
  const persistedRuns = tracked.filter((entry) => entry.sidecarStates.length > 0).length;

  console.log("");
  console.log("=== serve-level load summary ===");
  console.log(
    options.mock
      ? "mode: mock (serve --provider mock, hermetic)"
      : `mode: real (${options.baseUrl}  model ${options.model})`,
  );
  console.log(
    `serve: built CLI, port ${options.port}, workers ${options.workers}, ` +
      `provider timeout ${options.timeoutS}s, retries ${options.retries}`,
  );
  console.log(
    `runs: ${options.runs}  concurrency (max in-flight POSTs): ${Math.min(options.concurrency, options.runs)}  ` +
      `observed max in-flight POSTs: ${maxInFlightPosts}`,
  );
  console.log(`observed peak queued: ${stats.peakQueued}  observed peak running: ${stats.peakRunning}`);
  console.log(
    `persisted run_status: ${persistedRuns}/${tracked.length} run(s) carry a server-side ` +
      "queued -> running -> terminal sequence (runtime sidecar)",
  );
  console.log(`successes (completed): ${successes.length}  failures: ${failures.length}`);
  console.log(
    `terminal states: ${[...terminalCounts.entries()].map(([name, count]) => `${name} ${count}`).join(", ")}`,
  );
  if (queueTimes.length > 0) {
    console.log(
      `queue wait (s): min ${seconds(Math.min(...queueTimes))}  median ${seconds(median(queueTimes))}  ` +
        `max ${seconds(Math.max(...queueTimes))}`,
    );
  }
  if (execTimes.length > 0) {
    console.log(
      `execution (s): min ${seconds(Math.min(...execTimes))}  median ${seconds(median(execTimes))}  ` +
        `max ${seconds(Math.max(...execTimes))}`,
    );
  }
  if (submitTimes.length > 0) {
    console.log(
      `submit latency (s): min ${seconds(Math.min(...submitTimes))}  ` +
        `median ${seconds(median(submitTimes))}  max ${seconds(Math.max(...submitTimes))}`,
    );
  }
  console.log(
    "timings: client-observed at the poll granularity above; whole-second server " +
      "records/sidecars are used only when a transition was missed.",
  );
  console.log(`total wall time: ${seconds(wallMs)}s`);
  const passed = failures.length === 0 && successes.length === options.runs;
  console.log(
    passed ? "PASS: every run reached completed" : `FAIL: ${failures.length} run(s) did not complete`,
  );
  return passed;
}

interface CleanupState {
  handle: ServeHandle | null;
  tempRoot: string | null;
  keep: boolean;
  cleaned: boolean;
}

function cleanup(state: CleanupState, hard: boolean): void {
  if (state.cleaned) return;
  state.cleaned = true;
  const child = state.handle?.child;
  if (child !== undefined && child.exitCode === null) {
    try {
      child.kill(hard ? "SIGKILL" : "SIGTERM");
    } catch {
      // already gone
    }
  }
  if (state.tempRoot !== null && !state.keep) {
    try {
      fs.rmSync(state.tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch (exc) {
      console.warn(`[serve-load] warning: could not remove temp dir ${state.tempRoot}: ${String(exc)}`);
    }
  }
}

async function runServeLoad(options: Options): Promise<number> {
  const cli = resolveCli();
  log(`cli: ${cli.label}`);

  if (!(await portFree(options.port))) {
    console.error(`[serve-load] error: port ${options.port} is already in use (pick another with --port)`);
    return 1;
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tb-serve-load-"));
  const workspaceDir = path.join(tempRoot, "workspace");
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(
    path.join(workspaceDir, "README.md"),
    `# serve-load workspace\n${MARKER}\nthird line: temporary load-run workspace\n`,
    "utf8",
  );
  const cleanupState: CleanupState = { handle: null, tempRoot, keep: options.keep, cleaned: false };
  const onExit = (): void => cleanup(cleanupState, true);
  process.on("exit", onExit);
  const signal = (name: NodeJS.Signals, code: number): void => {
    console.error(`\n[serve-load] ${name}: stopping the serve child and cleaning up…`);
    cleanup(cleanupState, true);
    process.exit(code);
  };
  const onSigint = (): void => signal("SIGINT", 130);
  const onSigterm = (): void => signal("SIGTERM", 143);
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  const startedAt = Date.now();
  let tracked: TrackedRun[] = [];
  try {
    log(`temp dir: ${tempRoot}${options.keep ? " (kept after the run)" : ""}`);
    const { handle, ready } = await prepareServer(options, cli, workspaceDir, (spawned) => {
      cleanupState.handle = spawned;
    });
    cleanupState.handle = handle;

    tracked = makeTracked(options.runs);
    const perRunCapS = Math.max(PER_RUN_CAP_MIN_S, options.timeoutS);
    const waves = Math.ceil(options.runs / options.workers);
    const deadline = Date.now() + waves * perRunCapS * 1000 + DEADLINE_HEADROOM_MS;

    log(
      `submitting ${options.runs} run(s), max ${Math.min(options.concurrency, options.runs)} in-flight POST(s)`,
    );
    log(`polling until terminal (batch deadline ${seconds(deadline - Date.now())}s from now)`);
    let submissionDone = false;
    const submissionPromise = submitRuns(ready, options, tracked)
      .catch((exc: unknown) => {
        // A catastrophic submission failure must not leave the poll loop waiting
        // forever: stamp the unsubmitted entries and let the caller see the error.
        const message = exc instanceof Error ? exc.message : String(exc);
        for (const entry of tracked) {
          if (entry.runId === null && entry.submitError === null) {
            entry.submitError = `submission failed: ${message}`;
          }
        }
        throw exc instanceof Error ? exc : new Error(message);
      })
      .finally(() => {
        submissionDone = true;
      });
    const [submission, stats] = await Promise.all([
      submissionPromise,
      pollUntilTerminal(
        ready,
        tracked,
        deadline,
        () => submissionDone,
        options.mock ? MOCK_POLL_INTERVAL_MS : POLL_INTERVAL_MS,
      ),
    ]);
    const maxInFlightPosts = submission.maxInFlightPosts;
    for (const entry of tracked) {
      if (entry.submitError !== null) console.log(`run ${entry.index}: FAIL submit (${entry.submitError})`);
    }
    if (
      tracked.some(
        (entry) => entry.runId !== null && entry.terminalStatus === null && entry.submitError === null,
      )
    ) {
      warn("batch deadline reached; requesting cooperative stop for the remaining run(s)");
      await stopStragglers(ready, tracked);
      // One last snapshot so the stop's terminal state is collected.
      await pollUntilTerminal(ready, tracked, Date.now() + 5000, () => true, 100);
    }

    collectSidecarStates(ready.sessionsDir, tracked);
    for (const entry of tracked) printRun(entry);
    const passed = printSummary(options, tracked, stats, maxInFlightPosts, Date.now() - startedAt);
    if (options.keep) log(`kept temp dir: ${tempRoot}`);
    return passed ? 0 : 1;
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    await stopServe(cleanupState.handle);
    cleanup(cleanupState, false);
    process.removeListener("exit", onExit);
  }
}

async function main(): Promise<number> {
  const options = parseOptions(process.argv.slice(2));
  if (options.mock) {
    if (options.baseUrl !== undefined || options.model !== undefined) {
      console.warn("[serve-load] warning: --base-url/--model are ignored with --mock");
    }
    log(`mode: mock self-test (hermetic; runs ${options.runs}, workers ${options.workers})`);
  } else {
    log(`mode: real endpoint ${options.baseUrl} model ${options.model}`);
  }
  log(`task: ${options.task}`);
  return runServeLoad(options);
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((exc: unknown) => {
    console.error(
      `[serve-load] fatal: ${exc instanceof Error ? (exc.stack ?? exc.message) : String(exc)}`,
    );
    process.exitCode = 1;
  });
