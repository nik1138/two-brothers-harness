/**
 * Opt-in real-network load runner (MANUAL / release observation).
 *
 * Spawns the package's CLI as bounded-concurrency subprocesses against an
 * operator-provided OpenAI-compatible endpoint and reports honest per-run
 * latency/outcome plus a summary. This deliberately exercises the REAL
 * provider path end to end (no fetch stubs, no mock provider): each run is a
 * full cooperation cycle the CLI would produce for the operator.
 *
 * It is NOT a test: nothing here is hermetic (it needs a reachable endpoint and
 * sends real model calls), so it is never part of `npm test`, the offline smoke
 * gate or CI. It complements the hermetic real-socket fault layer
 * (`e2e/faults.ts`), which covers retry/timeout/overflow over real TCP without
 * an external endpoint — see `e2e/README.md`.
 *
 *   node e2e/load.ts --base-url http://localhost:1234/v1 --model lfm3-1.7b
 *   node e2e/load.ts --base-url <url> --model <id> --concurrency 2 --runs 3 \
 *     --timeout 900 --retries 1
 *
 * Runs spawn `<package>/dist/cli.js` (the published artifact; requires
 * `npm run build`); when the build is missing the runner falls back to
 * `src/cli.ts` through Node native type stripping and says so. Each child gets
 * `run "<task>" --base-url … --senior-model <id> --junior-model <id>
 * --mode consult|work --timeout … --retries … --no-live`; exit code 0 means
 * "the run completed successfully" in the CLI's own terms (this runner does not
 * parse protocol JSON — use `--json` by hand for that).
 *
 * Exit codes: 0 = every run exited 0; 1 = at least one run failed; 2 = invalid
 * usage. SIGINT/SIGTERM terminate every child before the process exits; a
 * normal exit also sweeps any straggler so no orphan runs are left behind.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, "..");
const DIST_CLI = path.join(PKG_ROOT, "dist", "cli.js");
const SRC_CLI = path.join(PKG_ROOT, "src", "cli.ts");

const DEFAULT_TASK = "Plan a reversible migration from Redis to Valkey";
const DEFAULT_CONCURRENCY = 3;
const MAX_CONCURRENCY = 16;
const MAX_RUNS = 100;
const DEFAULT_TIMEOUT_S = 120;
const MAX_TIMEOUT_S = 3600;
const DEFAULT_RETRIES = 1;
const MAX_RETRIES = 10;
/** Per-stream capture bound (chars kept from the END of stdout/stderr). */
const OUTPUT_TAIL_CHARS = 4000;
/** How much of a failed run's tails is printed (bounded, honest). */
const PRINTED_TAIL_CHARS = 800;
/** Endpoint reachability probe timeout; a soft warning only (never fatal). */
const PROBE_TIMEOUT_MS = 8000;

interface Options {
  baseUrl: string;
  model: string;
  concurrency: number;
  runs: number;
  mode: "consult" | "work";
  timeoutS: number;
  retries: number;
  task: string;
}

interface RunResult {
  /** 1-based run number in submission order (completion order can differ). */
  index: number;
  durationMs: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  ok: boolean;
  stdoutTail: string;
  stderrTail: string;
  spawnError?: string;
}

function usage(): string {
  return [
    "Usage: node e2e/load.ts --base-url <url> --model <id> [flags]",
    "",
    "Opt-in real-network load runner: spawns the built CLI concurrently against an",
    "OpenAI-compatible endpoint and reports per-run latency/outcome plus a summary.",
    "It needs a reachable endpoint and sends REAL model calls: it is never run by",
    "`npm test`, the smoke gate or CI (use it manually / for release observation).",
    "",
    "Required (flag or env fallback):",
    "  --base-url <url>     OpenAI-compatible base URL (env TWO_BROTHERS_E2E_BASE_URL)",
    "  --model <id>         model id used for BOTH roles (env TWO_BROTHERS_E2E_MODEL)",
    "  (an endpoint that needs auth reads TWO_BROTHERS_API_KEY from the environment;",
    "   keys are never passed in argv or printed by this runner)",
    "",
    "Options:",
    `  --concurrency <n>    parallel CLI runs (default ${DEFAULT_CONCURRENCY}, max ${MAX_CONCURRENCY})`,
    "  --runs <n>           total runs (default = concurrency, max " + MAX_RUNS + ")",
    "  --mode <m>           cooperation mode: consult | work (default consult)",
    `  --timeout <s>        per-attempt provider timeout seconds (default ${DEFAULT_TIMEOUT_S}, max ${MAX_TIMEOUT_S})`,
    `  --retries <n>        retries after a failed model call (default ${DEFAULT_RETRIES}, max ${MAX_RETRIES})`,
    `  --task <text>        task text (default "${DEFAULT_TASK}")`,
    "  -h, --help           print this help and exit 0",
    "",
    "Exit codes: 0 = all runs succeeded; 1 = at least one failed; 2 = invalid usage.",
    "",
    "Examples:",
    "  node e2e/load.ts --base-url http://localhost:1234/v1 --model lfm3-1.7b",
    "  node e2e/load.ts --base-url http://192.168.31.123:1234/v1 --model lfm3-1.7b \\",
    "    --concurrency 2 --runs 3 --timeout 900 --retries 1",
    "",
    "Runs the built `dist/cli.js` (run `npm run build` first); falls back to",
    "`src/cli.ts` with a warning when the build is missing.",
  ].join("\n");
}

function fail(message: string): never {
  console.error(`[load] error: ${message}`);
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
  let baseUrl: string | undefined;
  let model: string | undefined;
  let concurrency = DEFAULT_CONCURRENCY;
  let runs: number | undefined;
  let mode: Options["mode"] = "consult";
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
      case "--concurrency": {
        const taken = takeValue(argv, i, "--concurrency");
        concurrency = parseInteger("--concurrency", taken.value, 1, MAX_CONCURRENCY);
        i = taken.next;
        break;
      }
      case "--runs": {
        const taken = takeValue(argv, i, "--runs");
        runs = parseInteger("--runs", taken.value, 1, MAX_RUNS);
        i = taken.next;
        break;
      }
      case "--mode": {
        const taken = takeValue(argv, i, "--mode");
        const value = taken.value.toLowerCase();
        if (value !== "consult" && value !== "work") {
          fail(`--mode must be consult or work (got "${taken.value}")`);
        }
        mode = value;
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

  const resolvedBaseUrl = baseUrl ?? envValue("TWO_BROTHERS_E2E_BASE_URL");
  if (resolvedBaseUrl === undefined) {
    fail("--base-url is required (or set TWO_BROTHERS_E2E_BASE_URL)");
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(resolvedBaseUrl);
  } catch {
    fail(`--base-url is not a valid URL: "${resolvedBaseUrl}"`);
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    fail(`--base-url must be http(s): "${resolvedBaseUrl}"`);
  }

  const resolvedModel = model ?? envValue("TWO_BROTHERS_E2E_MODEL");
  if (resolvedModel === undefined) {
    fail("--model is required (or set TWO_BROTHERS_E2E_MODEL)");
  }

  const resolvedRuns = runs ?? concurrency;
  if (resolvedRuns > MAX_RUNS) fail(`--runs must be at most ${MAX_RUNS}`);

  return {
    baseUrl: resolvedBaseUrl.replace(/\/+$/, ""),
    model: resolvedModel,
    concurrency,
    runs: resolvedRuns,
    mode,
    timeoutS,
    retries,
    task,
  };
}

interface CliChoice {
  path: string;
  label: string;
}

/** Prefer the built artifact (documented); warn + fall back to sources when missing. */
function resolveCli(): CliChoice {
  if (fs.existsSync(DIST_CLI)) {
    return { path: DIST_CLI, label: "dist/cli.js (built artifact)" };
  }
  if (fs.existsSync(SRC_CLI)) {
    console.warn(
      "[load] warning: dist/cli.js not found — falling back to src/cli.ts " +
        "(Node native type stripping). Run `npm run build` to load the published artifact.",
    );
    return { path: SRC_CLI, label: "src/cli.ts (source fallback; no build found)" };
  }
  throw new Error(`neither ${DIST_CLI} nor ${SRC_CLI} exists — run this from the package checkout`);
}

/** Soft endpoint probe: report reachability/model presence, never fail the run. */
async function probeEndpoint(baseUrl: string, model: string): Promise<void> {
  const url = `${baseUrl}/models`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!res.ok) {
      console.log(`[load] endpoint probe: ${url} -> HTTP ${res.status} (runs may still work; /models is not required)`);
      return;
    }
    const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
    const ids = Array.isArray(body.data)
      ? body.data.map((entry) => String(entry.id ?? "")).filter((id) => id !== "")
      : [];
    const listed = ids.includes(model);
    console.log(
      `[load] endpoint probe: OK (${ids.length} model(s) listed; "${model}" listed: ${listed ? "yes" : "NO"})`,
    );
    if (!listed && ids.length > 0) {
      console.warn(`[load] warning: "${model}" is not in the endpoint's model list (${ids.slice(0, 8).join(", ")}…)`);
    }
  } catch (exc) {
    const detail = exc instanceof Error ? exc.message : String(exc);
    console.warn(`[load] endpoint probe: unreachable (${detail}) — runs will probably fail; continuing so the failures are measured`);
  }
}

/** One child run, settled on exit/error; signal-safe cleanup lives in runPool. */
function runOne(
  index: number,
  options: Options,
  cli: CliChoice,
  children: Set<ChildProcess>,
  onSettled: (result: RunResult) => void,
): Promise<RunResult> {
  return new Promise<RunResult>((resolve) => {
    const args = [
      cli.path,
      "run",
      options.task,
      "--base-url",
      options.baseUrl,
      "--senior-model",
      options.model,
      "--junior-model",
      options.model,
      "--mode",
      options.mode,
      "--timeout",
      String(options.timeoutS),
      "--retries",
      String(options.retries),
      "--no-live",
    ];
    const startedAt = Date.now();
    let settled = false;
    let stdout = "";
    let stderr = "";
    let child: ChildProcess;
    const finish = (result: Omit<RunResult, "index" | "durationMs" | "stdoutTail" | "stderrTail">): void => {
      if (settled) return;
      settled = true;
      const final: RunResult = {
        index,
        durationMs: Date.now() - startedAt,
        stdoutTail: stdout.slice(-OUTPUT_TAIL_CHARS),
        stderrTail: stderr.slice(-OUTPUT_TAIL_CHARS),
        ...result,
      };
      resolve(final);
      onSettled(final);
    };
    try {
      child = spawn(process.execPath, args, {
        cwd: PKG_ROOT,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (exc) {
      finish({
        exitCode: null,
        signal: null,
        ok: false,
        spawnError: exc instanceof Error ? exc.message : String(exc),
      });
      return;
    }
    children.add(child);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = (stdout + chunk.toString("utf8")).slice(-OUTPUT_TAIL_CHARS * 2);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-OUTPUT_TAIL_CHARS * 2);
    });
    child.on("error", (exc: Error) => {
      children.delete(child);
      finish({ exitCode: null, signal: null, ok: false, spawnError: exc.message });
    });
    child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      children.delete(child);
      finish({ exitCode: code, signal, ok: code === 0 });
    });
  });
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function seconds(ms: number): string {
  return (ms / 1000).toFixed(1);
}

function printResult(result: RunResult): void {
  const verdict = result.ok ? "PASS" : "FAIL";
  const exit = result.exitCode === null ? "no exit code" : `exit ${result.exitCode}`;
  const signal = result.signal ? `, signal ${result.signal}` : "";
  console.log(`run ${result.index}: ${verdict} in ${seconds(result.durationMs)}s (${exit}${signal})`);
  if (!result.ok) {
    if (result.spawnError !== undefined) console.log(`  spawn error: ${result.spawnError}`);
    const printedStderr = result.stderrTail.trim();
    if (printedStderr !== "") {
      console.log(`  stderr tail: ${printedStderr.slice(-PRINTED_TAIL_CHARS).replace(/\r?\n/g, "\n               ")}`);
    }
    const printedStdout = result.stdoutTail.trim();
    if (printedStdout !== "") {
      console.log(`  stdout tail: ${printedStdout.slice(-PRINTED_TAIL_CHARS).replace(/\r?\n/g, "\n               ")}`);
    }
  }
}

function printSummary(options: Options, results: RunResult[], wallMs: number, maxInFlight: number): void {
  const durations = results.map((result) => result.durationMs);
  const successes = results.filter((result) => result.ok);
  const failures = results.filter((result) => !result.ok);
  console.log("");
  console.log("=== Real-network load summary ===");
  console.log(`endpoint: ${options.baseUrl}  model: ${options.model}  mode: ${options.mode}`);
  console.log(`timeout: ${options.timeoutS}s  retries: ${options.retries}`);
  console.log(`runs planned: ${options.runs}  concurrency: ${options.concurrency}  max concurrent observed: ${maxInFlight}`);
  console.log(`successes: ${successes.length}  failures: ${failures.length}`);
  if (failures.length > 0) {
    const codes = failures
      .map((result) => `${result.index}:${result.exitCode ?? "spawn-error"}`)
      .join(", ");
    console.log(`failed runs (run:exit): ${codes}`);
  }
  if (durations.length > 0) {
    console.log(
      `latency (s): min ${seconds(Math.min(...durations))}  median ${seconds(median(durations))}  ` +
        `max ${seconds(Math.max(...durations))}`,
    );
  }
  console.log(`total wall time: ${seconds(wallMs)}s`);
  console.log(failures.length === 0 ? "PASS: every run exited 0" : `FAIL: ${failures.length} run(s) did not exit 0`);
}

async function runPool(
  options: Options,
  cli: CliChoice,
): Promise<{ results: RunResult[]; maxInFlight: number }> {
  const children = new Set<ChildProcess>();
  const results: RunResult[] = new Array<RunResult>(options.runs);
  let inFlight = 0;
  let maxInFlight = 0;
  let interrupted = false;

  const killChildren = (signal: NodeJS.Signals): void => {
    for (const child of children) {
      try {
        child.kill(signal);
      } catch {
        // already gone / not killable — the sweep keeps going
      }
    }
  };
  const onSignal = (signal: NodeJS.Signals, exitCode: number): void => {
    if (interrupted) return;
    interrupted = true;
    // Honour the signal exit code even if the pool finishes (and main resolves)
    // before the hard-kill timer fires; main() only sets exitCode when unset.
    process.exitCode = exitCode;
    console.error(`\n[load] ${signal}: terminating ${children.size} child run(s)…`);
    killChildren("SIGTERM");
    // Give children a moment to unwind, then hard-kill whatever is left.
    setTimeout(() => {
      killChildren("SIGKILL");
      process.exit(exitCode);
    }, 2000).unref();
  };
  const onSigint = (): void => onSignal("SIGINT", 130);
  const onSigterm = (): void => onSignal("SIGTERM", 143);
  const onExit = (): void => killChildren("SIGKILL");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  process.on("exit", onExit);

  const queue = Array.from({ length: options.runs }, (_, index) => index + 1);
  const settle = (): void => {
    inFlight -= 1;
  };
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = queue.shift();
      if (index === undefined || interrupted) return;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await runOne(index, options, cli, children, (settled) => {
        results[settled.index - 1] = settled;
        settle();
        printResult(settled);
      });
    }
  };

  try {
    const workers = Math.min(options.concurrency, options.runs);
    await Promise.all(Array.from({ length: workers }, () => worker()));
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    process.removeListener("exit", onExit);
    killChildren("SIGKILL");
  }
  const collected = results.filter((result): result is RunResult => result !== undefined);
  return { results: collected, maxInFlight };
}

async function main(): Promise<number> {
  const options = parseOptions(process.argv.slice(2));
  console.log(`[load] base-url: ${options.baseUrl}`);
  console.log(`[load] model: ${options.model} (both roles)  mode: ${options.mode}`);
  console.log(`[load] runs: ${options.runs}  concurrency: ${options.concurrency}  timeout: ${options.timeoutS}s  retries: ${options.retries}`);
  await probeEndpoint(options.baseUrl, options.model);

  let cli: CliChoice;
  try {
    cli = resolveCli();
  } catch (exc) {
    console.error(`[load] error: ${exc instanceof Error ? exc.message : String(exc)}`);
    return 1;
  }
  console.log(`[load] cli: ${cli.label}`);
  console.log(`[load] task: ${options.task}`);
  console.log("");

  const startedAt = Date.now();
  const { results, maxInFlight } = await runPool(options, cli);
  const wallMs = Date.now() - startedAt;
  printSummary(options, results, wallMs, maxInFlight);
  return results.length === options.runs && results.every((result) => result.ok) ? 0 : 1;
}

main()
  .then((code) => {
    // An interrupt sets the signal exit code first; a normal completion sets
    // its own result.
    if (process.exitCode === undefined) process.exitCode = code;
  })
  .catch((exc: unknown) => {
    console.error(`[load] fatal: ${exc instanceof Error ? (exc.stack ?? exc.message) : String(exc)}`);
    if (process.exitCode === undefined) process.exitCode = 1;
  });
