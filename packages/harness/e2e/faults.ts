/**
 * Real-socket fault-injection E2E (`node e2e/faults.ts`, opt-in).
 *
 * The package's retry/timeout/overflow logic is covered in-process by
 * `tests/retryregistry.test.ts`, `tests/compactionv2.test.ts` and friends, but
 * those tests replace `fetch` with a stub. This runner closes the
 * "no real-network fault injection" gap: it starts a scripted `node:http`
 * server on a loopback ephemeral port and drives the package's REAL
 * `OpenAICompatibleProvider` retry loop and REAL `TwoBrothersHarness` overflow
 * recovery against it over actual TCP sockets (Node's `fetch`/undici), with
 * temp sessions dirs. It is fully offline and deterministic. It never runs
 * under `npm test`; the offline smoke gate (`scripts/smoke-test.ps1`) runs it
 * as a package-gate step, and it can also be run directly.
 *
 * Scenarios (each asserts attempt counts and classification, never wall-clock
 * correctness):
 *   429-retry-after   one 429 + `Retry-After: 1`, then success: the retry loop
 *                     makes exactly 2 attempts and honors the header instead of
 *                     the fixed backoff (the documented wait is recorded through
 *                     the provider's `sleeper` seam so the run stays fast).
 *   5xx-transient     500 then 503 then success: exactly 3 attempts, waits equal
 *                     the documented exponential backoff, one recorded usage.
 *   timeout-retry     first attempt hangs past a 150 ms per-attempt timeout,
 *                     retry succeeds: documented [warn] line, 1 successful call.
 *   overflow-surface  413/context-overflow body: `ProviderContextOverflowError`
 *                     fails fast after ONE request even with 6 retries, no wait,
 *                     classification reason `context-overflow`, no usage.
 *   overflow-recovery a real seeded ~92 KB session: first senior call overflows,
 *                     the harness compacts ONCE through the same socket-backed
 *                     provider and retries the node once; the cooperation cycle
 *                     completes (consult → proposal → review → decision), the
 *                     session JSONL is rewritten with exactly one summary and
 *                     still restores/appends with dense `seq`.
 *   overflow-bounded  the same seeded session with a server that always
 *                     overflows: exactly 3 requests (overflow, one compaction,
 *                     one retried overflow), then the documented surface error
 *                     — never an infinite retry.
 *   quota-fatal       429 `insufficient_quota`: fatal `provider-limit` (no retry
 *                     budget burned, zero waits) with the provider message.
 *
 * Every scenario owns its server and closes it in `finally`; each scenario has
 * a 10 s watchdog and the runner fails if the whole run exceeds 30 s. Exit
 * code: 0 = every scenario passed, 1 = at least one failed. Evidence (scenario
 * results, timings, request counts) is written under `e2e/runs/` (gitignored),
 * matching the other e2e runners.
 *
 * Usage:
 *   node e2e/faults.ts              # sources (Node >= 22.6 type stripping)
 *   npm run test:e2e:faults         # same, via the package script
 */
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

import type {
  Config,
  Message,
  ModelProviderConfig,
  Sleeper,
  UsageTotals,
} from "../src/index.ts";
import {
  OpenAICompatibleProvider,
  ProviderContextOverflowError,
  ProviderHttpError,
  SessionStore,
  SharedContext,
  TwoBrothersHarness,
  classifyProviderError,
  compactionSummaryText,
  emptyUsage,
  isCompactionSummary,
  resolveConfig,
  restoreContext,
} from "../src/index.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const RUNS_DIR = path.join(HERE, "runs");

/** Model id every scripted request carries (the server never validates it). */
const FAULT_MODEL = "fault-model";
/** Successful reply content each scripted completion returns. */
const PROBE_CONTENT = "PONG";
/** Per-scenario watchdog; a hung socket or missing cleanup must fail loudly. */
const SCENARIO_TIMEOUT_MS = 10_000;
/** Whole-run budget, matching the task's bounded-runtime contract. */
const TOTAL_BUDGET_MS = 30_000;

// --------------------------------------------------------------------------- //
// tiny check/log runner (same idiom as e2e/run.ts)
// --------------------------------------------------------------------------- //

class CheckError extends Error {}

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new CheckError(message);
}

function log(line: string): void {
  console.log(line);
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function withTimeout<T>(work: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  // If the watchdog wins, `work` keeps running: keep a handled branch so a
  // late rejection cannot surface as an unhandled rejection after the race.
  void work.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new CheckError(`${label}: exceeded the ${timeoutMs} ms scenario budget`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// --------------------------------------------------------------------------- //
// scripted fault server (real localhost socket)
// --------------------------------------------------------------------------- //

/** One request the scripted server observed (parsed JSON body when possible). */
interface FaultRequest {
  /** Zero-based request ordinal across the scenario's server. */
  index: number;
  url: string;
  body: Record<string, unknown>;
}

/** What the scripted server answers for one request. */
interface FaultReply {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  /** Delay the response (ms). The client's per-attempt timeout may win first. */
  delayMs?: number;
}

type FaultHandler = (request: FaultRequest) => FaultReply | Promise<FaultReply>;

interface FaultServer {
  /** Provider base URL, e.g. `http://127.0.0.1:54321/v1`. */
  baseUrl: string;
  /** Every request observed, in arrival order. */
  requests: FaultRequest[];
  close(): Promise<void>;
}

async function startFaultServer(handler: FaultHandler): Promise<FaultServer> {
  const requests: FaultRequest[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      void (async () => {
        let body: Record<string, unknown> = {};
        try {
          const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
          if (isRecord(parsed)) body = parsed;
        } catch {
          // a malformed body is still one observed request (the scenario asserts it)
        }
        const request: FaultRequest = { index: requests.length, url: req.url ?? "", body };
        requests.push(request);
        let reply: FaultReply;
        try {
          reply = await handler(request);
        } catch (exc) {
          reply = {
            status: 500,
            body: JSON.stringify({ error: { message: `scripted handler failed: ${describeError(exc)}` } }),
          };
        }
        const send = (): void => {
          if (res.writableEnded || res.destroyed) return;
          try {
            res.writeHead(reply.status ?? 200, {
              "content-type": "application/json",
              ...(reply.headers ?? {}),
            });
            res.end(reply.body ?? "");
          } catch {
            // the client aborted (the timeout scenario relies on this)
          }
        };
        const delayMs = reply.delayMs ?? 0;
        if (delayMs > 0) {
          const timer = setTimeout(() => {
            timers.delete(timer);
            send();
          }, delayMs);
          timers.add(timer);
          res.on("close", () => {
            clearTimeout(timer);
            timers.delete(timer);
          });
        } else {
          send();
        }
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: async () => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Run `fn` against one scripted server and always close it + its sockets. */
async function withFaultServer<T>(handler: FaultHandler, fn: (server: FaultServer) => Promise<T>): Promise<T> {
  const server = await startFaultServer(handler);
  try {
    return await fn(server);
  } finally {
    await server.close();
  }
}

// --------------------------------------------------------------------------- //
// OpenAI-compatible wire helpers
// --------------------------------------------------------------------------- //

function completion(content: string): string {
  return JSON.stringify({
    id: "chatcmpl-fault",
    object: "chat.completion",
    model: FAULT_MODEL,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
  });
}

/** The last `user` message content of a request body (the rendered transcript). */
function lastUserText(body: Record<string, unknown>): string {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (isRecord(message) && message.role === "user" && typeof message.content === "string") {
      return message.content;
    }
  }
  return "";
}

/** True when the request is the harness' compaction (summarizer) call. */
function isCompactionRequest(body: Record<string, unknown>): boolean {
  return lastUserText(body).startsWith("<conversation>");
}

/** One rendered transcript envelope line: `[seq] [from -> to] kind: {json}`. */
const ENVELOPE_LINE = /^\[(\d+)\] \[(\S+) -> (\S+)\] (\w+): /;

/** The kind of the newest envelope in the rendered transcript, if any. */
function lastEnvelopeKind(body: Record<string, unknown>): string | null {
  const lines = lastUserText(body).split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = ENVELOPE_LINE.exec((lines[index] ?? "").trim());
    if (match !== null) return match[4] ?? null;
  }
  return null;
}

/** The system message of a request body (the assembled role prompt). */
function systemText(body: Record<string, unknown>): string {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const message of messages) {
    if (isRecord(message) && message.role === "system" && typeof message.content === "string") {
      return message.content;
    }
  }
  return "";
}

/** Map one payload example shape to its node kind (see harness `PAYLOAD_EXAMPLES`). */
function kindOfPayload(payload: Record<string, unknown>): string | null {
  if ("ask" in payload) return "consult";
  if ("verdict" in payload) return "review";
  if ("title" in payload) return "proposal";
  if ("decision" in payload) return "decision";
  if ("work" in payload) return "delegation";
  if ("result" in payload) return "deliverable";
  return null;
}

/**
 * The structured node kind a role call answers. The assembled system prompt
 * appends that kind's few-shot payload example (`PAYLOAD_EXAMPLES`), so the
 * scripted model can answer by kind instead of guessing from the transcript —
 * required for the recovery scenario, whose seeded history ends in archived
 * `consult` envelopes regardless of the node being retried.
 */
function requestedNodeKind(body: Record<string, unknown>): string | null {
  const system = systemText(body);
  const marker = system.lastIndexOf("```json");
  if (marker < 0) return lastEnvelopeKind(body);
  const start = marker + "```json".length;
  const end = system.indexOf("```", start);
  if (end < 0) return lastEnvelopeKind(body);
  try {
    const example: unknown = JSON.parse(system.slice(start, end).trim());
    if (isRecord(example)) return kindOfPayload(example);
  } catch {
    // fall through to the transcript inference
  }
  return lastEnvelopeKind(body);
}

/** Strict-valid payload shapes for one consult-mode cooperation cycle. */
const CYCLE_PAYLOADS = {
  consult: JSON.stringify({
    task: "fault-injection cooperation task",
    ask: "What is the next step?",
    expect: "proposal",
  }),
  proposal: JSON.stringify({
    title: "Fault-injection plan",
    answer: "Proceed step by step and verify each step.",
  }),
  review: JSON.stringify({
    verdict: "accept",
    notes: "The plan is sound.",
  }),
  decision: JSON.stringify({
    decision: "Proceed with the plan.",
    confidence: 0.9,
  }),
} as const;

/** The next structured reply for the current transcript (a scripted model). */
function cycleReply(body: Record<string, unknown>): string {
  const kind = requestedNodeKind(body);
  if (kind === "proposal") return CYCLE_PAYLOADS.proposal;
  if (kind === "review") return CYCLE_PAYLOADS.review;
  if (kind === "decision") return CYCLE_PAYLOADS.decision;
  return CYCLE_PAYLOADS.consult;
}

// --------------------------------------------------------------------------- //
// provider construction (the package's real retry-managed provider)
// --------------------------------------------------------------------------- //

interface FaultProviderOptions {
  retries?: number;
  /** Per-attempt timeout in seconds (tiny values are fine: 0.15 = 150 ms). */
  timeout?: number;
  backoffBase?: number;
  backoffCap?: number;
  /** Documented injection seam: lets a scenario record the backoff contract. */
  sleeper?: Sleeper;
  onWarning?: (line: string) => void;
}

/** A real OpenAI-compatible provider aimed at the scripted localhost server. */
function faultProvider(baseUrl: string, options: FaultProviderOptions = {}): OpenAICompatibleProvider {
  const config: ModelProviderConfig = {
    provider: "openai",
    baseUrl,
    apiKey: "",
    seniorModel: FAULT_MODEL,
    juniorModel: FAULT_MODEL,
    model: FAULT_MODEL,
    temperature: 0,
    timeout: options.timeout ?? 5,
    retries: options.retries ?? 2,
    backoffBase: options.backoffBase ?? 0.05,
    backoffCap: options.backoffCap ?? 0.5,
    ...(options.sleeper !== undefined ? { sleeper: options.sleeper } : {}),
    ...(options.onWarning !== undefined ? { onWarning: options.onWarning } : {}),
  };
  return new OpenAICompatibleProvider(config);
}

/** A recording sleeper: returns immediately and records each requested wait. */
function recordingSleeper(): { sleeper: Sleeper; sleeps: number[] } {
  const sleeps: number[] = [];
  return {
    sleeps,
    sleeper: async (seconds) => {
      sleeps.push(seconds);
    },
  };
}

function sumNumbers(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function checkWaits(
  sleeps: readonly number[],
  expectedSeconds: number,
  what: string,
  tolerance = 1e-6,
): void {
  const total = sumNumbers(sleeps);
  check(
    Math.abs(total - expectedSeconds) <= tolerance,
    `${what}: expected ${expectedSeconds}s of waits, recorded ${total}s ` +
      `(${sleeps.length} sleeper call(s))`,
  );
}

// --------------------------------------------------------------------------- //
// scenario 1: 429 + Retry-After then success
// --------------------------------------------------------------------------- //

async function scenario429RetryAfter(): Promise<string> {
  return withFaultServer(
    (request) =>
      request.index === 0
        ? {
            status: 429,
            headers: { "retry-after": "1" },
            body: JSON.stringify({ error: { message: "rate limit exceeded; please retry" } }),
          }
        : { status: 200, body: completion(PROBE_CONTENT) },
    async (server) => {
      const { sleeper, sleeps } = recordingSleeper();
      const provider = faultProvider(server.baseUrl, { retries: 2, sleeper });
      const reply = await provider.chat([{ role: "user", content: "ping" }]);
      check(reply === PROBE_CONTENT, `expected ${PROBE_CONTENT}, got ${JSON.stringify(reply)}`);
      check(server.requests.length === 2, `expected 2 attempts, got ${server.requests.length}`);
      check(
        server.requests[0]!.url.endsWith("/chat/completions"),
        `unexpected request path: ${server.requests[0]!.url}`,
      );
      // Retry-After: 1 replaces the fixed 0.05 s backoff: the documented wait
      // is 1 s, recorded through the sleeper seam (zero real time here).
      checkWaits(sleeps, 1, "Retry-After must replace the fixed backoff");
      check(provider.usageSnapshot().model_calls === 1, "only the success records usage");
      return `429(+Retry-After:1) then 200 over ${server.requests.length} real HTTP attempts; ` +
        `1 s requested wait honored, 1 recorded model call`;
    },
  );
}

// --------------------------------------------------------------------------- //
// scenario 2: 5xx transient then success
// --------------------------------------------------------------------------- //

async function scenarioTransientServerErrors(): Promise<string> {
  const statuses = [500, 503];
  return withFaultServer(
    (request) => {
      const status = statuses[request.index];
      if (status !== undefined) {
        return {
          status,
          body: JSON.stringify({ error: { message: `upstream internal error ${status}` } }),
        };
      }
      return { status: 200, body: completion(PROBE_CONTENT) };
    },
    async (server) => {
      const { sleeper, sleeps } = recordingSleeper();
      const provider = faultProvider(server.baseUrl, {
        retries: 3,
        backoffBase: 0.05,
        backoffCap: 0.5,
        sleeper,
      });
      const reply = await provider.chat([{ role: "user", content: "ping" }]);
      check(reply === PROBE_CONTENT, `expected ${PROBE_CONTENT}, got ${JSON.stringify(reply)}`);
      check(server.requests.length === 3, `expected 3 attempts, got ${server.requests.length}`);
      // Documented exponential backoff: base 0.05, then 0.1 (2^1).
      checkWaits(sleeps, 0.05 + 0.1, "the documented exponential backoff must be used");
      check(provider.usageSnapshot().model_calls === 1, "only the success records usage");
      return `500, 503 then 200 over ${server.requests.length} real HTTP attempts; ` +
        `backoff waits ${sumNumbers(sleeps).toFixed(2)}s as documented`;
    },
  );
}

// --------------------------------------------------------------------------- //
// scenario 3: per-attempt timeout then success
// --------------------------------------------------------------------------- //

async function scenarioAttemptTimeout(): Promise<string> {
  return withFaultServer(
    (request) =>
      request.index === 0
        ? { status: 200, body: completion("TOO LATE"), delayMs: 500 }
        : { status: 200, body: completion(PROBE_CONTENT) },
    async (server) => {
      const warnings: string[] = [];
      const provider = faultProvider(server.baseUrl, {
        retries: 2,
        timeout: 0.15, // 150 ms per attempt
        backoffBase: 0.01,
        backoffCap: 0.01,
        onWarning: (line) => warnings.push(line),
      });
      const reply = await provider.chat([{ role: "user", content: "ping" }]);
      check(reply === PROBE_CONTENT, `expected ${PROBE_CONTENT}, got ${JSON.stringify(reply)}`);
      check(server.requests.length === 2, `expected 2 attempts, got ${server.requests.length}`);
      check(warnings.length === 1, `expected exactly one timeout warning, got ${warnings.length}`);
      check(
        /provider attempt timed out after 0\.15s/.test(warnings[0] ?? ""),
        `unexpected timeout warning: ${warnings[0] ?? "(none)"}`,
      );
      check(
        /retrying \(attempt 2\/3\)/.test(warnings[0] ?? ""),
        `the warning must name the next attempt: ${warnings[0] ?? "(none)"}`,
      );
      // A retry re-sends the same request (no half-built payload survives).
      check(
        JSON.stringify(server.requests[0]!.body.messages) ===
          JSON.stringify(server.requests[1]!.body.messages),
        "the retry must re-send the same request messages",
      );
      check(provider.usageSnapshot().model_calls === 1, "the timed-out attempt records no usage");
      return `150 ms per-attempt timeout then success over ${server.requests.length} real attempts; ` +
        `documented timeout warning emitted once`;
    },
  );
}

// --------------------------------------------------------------------------- //
// scenario 4: context overflow fails fast (documented provider surface)
// --------------------------------------------------------------------------- //

const OVERFLOW_BODY = JSON.stringify({
  error: {
    message:
      "This model's maximum context length is 8192 tokens, however you requested " +
      "10000 tokens. Please reduce the length of the messages.",
  },
});

async function scenarioOverflowSurface(): Promise<string> {
  return withFaultServer(
    () => ({ status: 413, body: OVERFLOW_BODY }),
    async (server) => {
      const { sleeper, sleeps } = recordingSleeper();
      const provider = faultProvider(server.baseUrl, { retries: 6, sleeper });
      let thrown: unknown;
      try {
        await provider.chat([{ role: "user", content: "oversized prompt" }]);
      } catch (exc) {
        thrown = exc;
      }
      check(thrown instanceof ProviderContextOverflowError, "expected ProviderContextOverflowError");
      check(server.requests.length === 1, `overflow must fail fast (got ${server.requests.length} attempts)`);
      check(sleeps.length === 0, "an overflow must never wait for a retry");
      check(classifyProviderError(thrown).reason === "context-overflow", "classification reason");
      check(
        describeError(thrown).includes("maximum context length"),
        `the provider message must survive: ${describeError(thrown)}`,
      );
      check(provider.usageSnapshot().model_calls === 0, "a failed attempt records no usage");
      return `413 overflow failed fast after ${server.requests.length} real attempt; ` +
        `no retry, no wait, classification context-overflow`;
    },
  );
}

// --------------------------------------------------------------------------- //
// scenarios 5–6: overflow recovery through a real seeded session
// --------------------------------------------------------------------------- //

const RECOVERY_TASK = "real-socket overflow recovery task";
/** Archived envelopes seeded before the run (each ~9 KB, ~92 KB total). */
const RECOVERY_DEPTH = 10;
const RECOVERY_FILLER_CHARS = 9_000;
const RECOVERY_SUMMARY =
  "## Goal\nKeep the fault-injection session compactable.\n\n" +
  "## Progress\n### Done\n- [x] archived consultations summarized\n\n" +
  "## Next Steps\n1. Answer the operator";

interface RecoveryServerState {
  /** True once the single scripted overflow has been served. */
  overflowed: boolean;
  /** Always serve overflow on non-compaction requests (the boundedness case). */
  alwaysOverflow: boolean;
  compactionCalls: number;
  nonCompactionCalls: number;
  /** Reply status per observed request, in arrival order. */
  statuses: number[];
}

/** A scripted model server for a seeded session: one overflow, then a cycle. */
function recoveryHandler(state: RecoveryServerState): FaultHandler {
  return (request) => {
    if (isCompactionRequest(request.body)) {
      state.compactionCalls += 1;
      state.statuses.push(200);
      return { status: 200, body: completion(RECOVERY_SUMMARY) };
    }
    state.nonCompactionCalls += 1;
    if (state.alwaysOverflow || !state.overflowed) {
      state.overflowed = true;
      state.statuses.push(413);
      return { status: 413, body: OVERFLOW_BODY };
    }
    state.statuses.push(200);
    return { status: 200, body: completion(cycleReply(request.body)) };
  };
}

function newRecoveryState(alwaysOverflow = false): RecoveryServerState {
  return {
    overflowed: false,
    alwaysOverflow,
    compactionCalls: 0,
    nonCompactionCalls: 0,
    statuses: [],
  };
}

/** Config for a real harness run against the scripted localhost endpoint. */
function recoveryConfig(baseUrl: string): Config {
  return resolveConfig({
    provider: "openai",
    baseUrl,
    apiKey: "",
    seniorModel: FAULT_MODEL,
    juniorModel: FAULT_MODEL,
    mode: "consult",
    temperature: 0,
    timeout: 5,
    retries: 2,
    maxRounds: 3,
    compact: false,
    compactThreshold: 0,
    compactThresholdTokens: 0,
    contextWindow: 0,
  });
}

/** Seed a session large enough that one overflow compaction has something to fold. */
function seedRecoverySession(store: SessionStore): void {
  const context = new SharedContext(store);
  context.makeAndAppend("user", "senior", "message", { text: RECOVERY_TASK });
  for (let index = 0; index < RECOVERY_DEPTH; index += 1) {
    context.makeAndAppend("senior", "junior", "consult", {
      task: RECOVERY_TASK,
      ask: `archived consultation ${index}: ${"a".repeat(RECOVERY_FILLER_CHARS)}`,
      expect: "proposal",
    });
  }
}

function mkTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
}

function checkDenseSeq(events: readonly Message[], label: string): void {
  check(events.length > 0, `${label}: no envelopes`);
  for (const [index, event] of events.entries()) {
    check(event.seq === index + 1, `${label}: seq ${event.seq} at index ${index} is not dense`);
  }
}

async function scenarioOverflowRecovery(): Promise<string> {
  const dir = mkTempDir("tb-faults-recovery-");
  try {
    const file = path.join(dir, "recovery-session.jsonl");
    const store = new SessionStore(file);
    seedRecoverySession(store);
    const seeded = new SessionStore(file).load();
    checkDenseSeq(seeded, "seeded session");
    check(seeded.length === RECOVERY_DEPTH + 1, "seeded session envelope count");

    const state = newRecoveryState();
    return await withFaultServer(recoveryHandler(state), async (server) => {
      const harness = new TwoBrothersHarness(recoveryConfig(server.baseUrl));
      const result = await harness.run(RECOVERY_TASK, restoreContext(new SessionStore(file)));

      check(!result.cancelled, "the recovered run must complete");
      check(result.errors.length === 0, `unexpected run errors: ${result.errors.join("; ")}`);
      check(result.warnings.length === 0, `unexpected warnings: ${result.warnings.join("; ")}`);
      check(
        typeof result.decision.decision === "string" && result.decision.decision.length > 0,
        "the recovered run must reach a decision",
      );

      // Exactly one overflow, one compaction, one retried node, then the cycle.
      check(state.nonCompactionCalls === 5, `expected 5 non-compaction requests, got ${state.nonCompactionCalls}`);
      check(state.compactionCalls === 1, `expected exactly 1 compaction request, got ${state.compactionCalls}`);
      check(
        server.requests.length === 6,
        `expected 6 total requests (overflow, compaction, retry, then 3 nodes), got ${server.requests.length}`,
      );
      check(
        state.statuses.join(",") === "413,200,200,200,200,200",
        `unexpected reply sequence: ${state.statuses.join(",")}`,
      );

      // The retried node continues the cooperation cycle after the summary.
      const kinds = result.messages.map((message) => message.kind);
      check(
        kinds.join(",") === "message,consult,proposal,review,decision",
        `unexpected envelope kinds after recovery: ${kinds.join(",")}`,
      );
      check(result.messages.filter(isCompactionSummary).length === 1, "one published summary envelope");
      check(
        compactionSummaryText(result.messages.find(isCompactionSummary)!) === RECOVERY_SUMMARY,
        "the summary body must round-trip",
      );
      check(
        result.usage.model_calls === 5,
        `expected 5 successful model calls (4 nodes + 1 summarizer), got ${result.usage.model_calls}`,
      );
      check(result.usage.input_tokens === 15 && result.usage.output_tokens === 10, "usage totals");

      // The rewritten session still restores, keeps one summary and resumes.
      const reloaded = new SessionStore(file).load();
      checkDenseSeq(reloaded, "recovered session");
      check(
        reloaded.filter(isCompactionSummary).length === 1,
        "the compacted session must keep exactly one summary",
      );
      check(reloaded.at(-1)?.kind === "decision", "the recovered session ends with the decision");
      const restored = restoreContext(new SessionStore(file));
      const appended = restored.makeAndAppend("user", "senior", "message", {
        text: "resume after the real-socket overflow recovery",
      });
      check(appended.seq === reloaded.length + 1, "resuming appends with the next dense seq");
      check(new SessionStore(file).load().length === reloaded.length + 1, "the resumed envelope persisted");

      return `one 413 overflow, one summarized compaction and one node retry over ` +
        `${server.requests.length} real requests; cycle completed, session restores with 1 summary`;
    });
  } finally {
    rmDir(dir);
  }
}

async function scenarioSecondOverflowBounded(): Promise<string> {
  const dir = mkTempDir("tb-faults-bounded-");
  try {
    const file = path.join(dir, "bounded-session.jsonl");
    const store = new SessionStore(file);
    seedRecoverySession(store);

    const state = newRecoveryState(true);
    return await withFaultServer(recoveryHandler(state), async (server) => {
      const harness = new TwoBrothersHarness(recoveryConfig(server.baseUrl));
      let thrown: unknown;
      try {
        await harness.run(RECOVERY_TASK, restoreContext(new SessionStore(file)));
      } catch (exc) {
        thrown = exc;
      }
      check(
        thrown instanceof ProviderContextOverflowError,
        "a second overflow must surface the provider's error",
      );
      check(state.nonCompactionCalls === 2, `expected 2 overflow attempts, got ${state.nonCompactionCalls}`);
      check(state.compactionCalls === 1, `expected exactly 1 compaction attempt, got ${state.compactionCalls}`);
      check(server.requests.length === 3, `expected 3 bounded requests, got ${server.requests.length}`);
      const seniorProvider = harness.providers.senior as unknown as {
        usageSnapshot?: () => UsageTotals;
      };
      const seniorUsage = seniorProvider.usageSnapshot?.() ?? emptyUsage();
      check(
        seniorUsage.model_calls === 1,
        `expected exactly one summarizer call, got ${seniorUsage.model_calls}`,
      );
      return `always-overflow server: ${server.requests.length} bounded requests ` +
        `(overflow, one compaction, retried overflow) then the documented error`;
    });
  } finally {
    rmDir(dir);
  }
}

// --------------------------------------------------------------------------- //
// scenario 7: quota/billing fatal (fail fast, no retry burn)
// --------------------------------------------------------------------------- //

const QUOTA_BODY = JSON.stringify({
  error: {
    message: "insufficient_quota: your billing hard limit has been reached; add credit to continue",
  },
});

async function scenarioQuotaFatal(): Promise<string> {
  return withFaultServer(
    () => ({ status: 429, body: QUOTA_BODY }),
    async (server) => {
      const { sleeper, sleeps } = recordingSleeper();
      const provider = faultProvider(server.baseUrl, { retries: 6, sleeper });
      let thrown: unknown;
      try {
        await provider.chat([{ role: "user", content: "ping" }]);
      } catch (exc) {
        thrown = exc;
      }
      check(thrown instanceof ProviderHttpError, "expected a provider HTTP error");
      check(!(thrown instanceof ProviderContextOverflowError), "quota exhaustion is not an overflow");
      check(thrown.retryable === false, "quota exhaustion must be fatal (no retry)");
      check(thrown.reason === "provider-limit", `unexpected classification reason: ${thrown.reason}`);
      check(server.requests.length === 1, `expected 1 attempt, got ${server.requests.length}`);
      check(sleeps.length === 0, "a fatal provider limit must never wait for a retry");
      check(provider.usageSnapshot().model_calls === 0, "a failed attempt records no usage");
      check(
        describeError(thrown).includes("insufficient_quota"),
        `the provider message must survive: ${describeError(thrown)}`,
      );
      return `429 insufficient_quota failed fast after ${server.requests.length} real attempt; ` +
        `reason provider-limit, no retry burn`;
    },
  );
}

// --------------------------------------------------------------------------- //
// runner
// --------------------------------------------------------------------------- //

interface ScenarioResult {
  name: string;
  status: "PASS" | "FAIL";
  durationMs: number;
  detail: string;
}

const results: ScenarioResult[] = [];

async function runScenario(name: string, run: () => Promise<string>): Promise<void> {
  const started = Date.now();
  try {
    const detail = await withTimeout(run(), SCENARIO_TIMEOUT_MS, name);
    const durationMs = Date.now() - started;
    results.push({ name, status: "PASS", durationMs, detail });
    log(`  PASS  ${name} (${durationMs} ms) — ${detail}`);
  } catch (exc) {
    const durationMs = Date.now() - started;
    const detail = describeError(exc);
    results.push({ name, status: "FAIL", durationMs, detail });
    log(`  FAIL  ${name} (${durationMs} ms) — ${detail}`);
    if (exc instanceof Error && !(exc instanceof CheckError) && exc.stack !== undefined) {
      log(exc.stack);
    }
  }
}

async function main(): Promise<number> {
  const started = Date.now();
  log("Two Brothers — real-socket fault-injection E2E (offline, localhost only)");
  log("  endpoint: scripted node:http server on 127.0.0.1:<ephemeral> (real fetch/TCP)");
  log("");

  await runScenario("429-retry-after", scenario429RetryAfter);
  await runScenario("5xx-transient", scenarioTransientServerErrors);
  await runScenario("timeout-retry", scenarioAttemptTimeout);
  await runScenario("overflow-surface", scenarioOverflowSurface);
  await runScenario("overflow-recovery", scenarioOverflowRecovery);
  await runScenario("overflow-bounded", scenarioSecondOverflowBounded);
  await runScenario("quota-fatal", scenarioQuotaFatal);

  const totalMs = Date.now() - started;
  let failures = results.filter((result) => result.status === "FAIL").length;
  if (totalMs > TOTAL_BUDGET_MS) {
    failures += 1;
    log(`  FAIL  runtime budget — ${totalMs} ms exceeds the ${TOTAL_BUDGET_MS} ms bound`);
  }

  const report = {
    schema: "two-brothers.faults/1",
    generatedAt: new Date().toISOString(),
    mode: "real-socket-scripted-http",
    scenarios: results,
    totals: {
      scenarios: results.length,
      passed: results.filter((result) => result.status === "PASS").length,
      failed: failures,
      durationMs: totalMs,
    },
  };
  fs.mkdirSync(RUNS_DIR, { recursive: true });
  const reportFile = path.join(RUNS_DIR, `faults-report-${stamp()}.json`);
  fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);

  log("");
  log(
    failures === 0
      ? `Faults: PASS — ${results.length}/${results.length} scenarios, ${totalMs} ms ` +
          `(budget ${TOTAL_BUDGET_MS} ms)`
      : `Faults: FAIL — ${failures} failure(s), ${totalMs} ms`,
  );
  log(`Faults: report -> ${path.relative(REPO_ROOT, reportFile)}`);
  return failures === 0 ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
    // The global fetch dispatcher keeps keep-alive sockets briefly; never let a
    // finished opt-in runner hang on them (the budget is a hard bound).
    setTimeout(() => process.exit(code), 250).unref();
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
