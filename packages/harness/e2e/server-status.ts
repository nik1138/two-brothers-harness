/**
 * Hermetic E2E suites for the Wave-2 web-run status contract.
 *
 * These drive the real `node:http` server over real HTTP/SSE (in-process,
 * ephemeral port) and assert the contract end to end:
 *
 *   server-status-waiting   an operator park emits `approval_requested` then
 *                           `run_status: waiting` (one per park, never twice
 *                           in a row); answering emits `approval_resolved`
 *                           then `run_status: running`; the run completes; a
 *                           stop while parked resolves the wait as deny and
 *                           unwinds `cancelled` with no phantom `running`.
 *   server-mode-contract    `POST /api/runs` with a mode -> the run record
 *                           from `GET /api/runs` and `GET /api/runs/{id}`
 *                           carries it; omitting it records the resolved
 *                           config default; a later run adopting the same
 *                           session keeps its own mode; a reload still sees
 *                           both.
 *   server-error-restart    a terminal failed run emits `run_error` + failed
 *                           `run_end`; a second server over the same sessions
 *                           dir (a simulated backend restart) rebuilds the
 *                           record from the runtime sidecar with the original
 *                           error, terminal status, and empty task/mode;
 *                           unknown ids stay 404.
 *
 * The suites are fully offline: mock providers, temp sessions/workspace dirs,
 * in-process servers. `buildStatusSuites()` also returns `-live` variants when
 * the runner resolved a live OpenAI-compatible endpoint; those reuse the same
 * suite bodies with the real providers (mode contract and error transport).
 *
 * Runner integration: `e2e/run.ts` registers these suites so `npm run
 * test:e2e` (and `test:e2e:dist` against built `dist/`) exercises them even
 * when no real endpoint is reachable. The module is also directly runnable:
 *
 *   node e2e/server-status.ts            # sources (type stripping)
 *   TWO_BROTHERS_E2E_DIST=1 node e2e/server-status.ts   # built dist/
 *
 * Exit codes: 0 = every suite passed; 1 = at least one failed. Evidence
 * (SSE event dumps) is written under `e2e/runs/` (gitignored), matching the
 * other e2e runners.
 */
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

import type { Config, Message, Provider, ServerHandle, UsageTotals } from "../src/index.ts";

export type HarnessApi = typeof import("../src/index.ts");
type Api = HarnessApi;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNS_DIR = path.join(HERE, "runs");

/** Mock runs are immediate; a generous bound still catches a hung park. */
const HERMETIC_TIMEOUT_MS = 30_000;
/** Small local models at ~30-90 s per call, and real work runs park often. */
const LIVE_TIMEOUT_MS = 15 * 60_000;

const FAIL_MESSAGE = "e2e scripted senior provider failure";
const WAIT_TASK = "Write the file status.txt containing the text ok, then confirm it.";
const MODE_TASK = "Name one benefit of code review";

/** A suite the runner reports as SKIP: model-dependent, not a contract break. */
export class StatusSuiteSkip extends Error {}

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

function mkTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function writeEvidence(runsDir: string, name: string, data: unknown): string {
  fs.mkdirSync(runsDir, { recursive: true });
  const file = path.join(runsDir, `${name}-${stamp()}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
}

// ---------------------------------------------------------------------------
// HTTP / SSE helpers
// ---------------------------------------------------------------------------

interface HttpResult {
  status: number;
  body: unknown;
}

async function httpJson(base: string, method: string, route: string, body?: unknown): Promise<HttpResult> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const response = await fetch(base + route, init);
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // keep the raw body (e.g. an HTML error page)
  }
  return { status: response.status, body: parsed };
}

interface SseEvent extends Record<string, unknown> {
  id?: number;
  type?: string;
}

/**
 * Drive a run's SSE stream (`GET /api/runs/{id}/events`) and invoke
 * `onEvent` for every frame as it arrives — approval answering happens
 * mid-stream. Resolves with all events once `run_end` arrives (the server
 * closes the stream); rejects on timeout.
 */
function driveRunSse(
  base: string,
  runId: string,
  onEvent: (event: SseEvent) => Promise<void> | void,
  timeoutMs: number,
): Promise<SseEvent[]> {
  return new Promise<SseEvent[]>((resolve, reject) => {
    const events: SseEvent[] = [];
    let buf = "";
    let settled = false;
    const finish = (err: Error | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(events);
    };
    const timer = setTimeout(() => {
      req.destroy();
      finish(
        new Error(
          `SSE drive for run ${runId} timed out after ${(timeoutMs / 1000).toFixed(0)}s; ` +
            `last events: ${JSON.stringify(events.slice(-2))}`,
        ),
      );
    }, timeoutMs);
    const req = http.get(`${base}/api/runs/${runId}/events`, (res) => {
      if (res.statusCode !== 200) {
        finish(new Error(`SSE GET -> HTTP ${res.statusCode}`));
        res.resume();
        return;
      }
      res.setEncoding("utf-8");
      res.on("data", (chunk: string) => {
        buf += chunk;
        let sep: number;
        while ((sep = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          let id: number | null = null;
          let data = "";
          for (const line of frame.split(/\r?\n/)) {
            if (line.startsWith("id: ")) id = Number(line.slice(4));
            else if (line.startsWith("data: ")) data += line.slice(6);
          }
          if (!data) continue; // keepalive comment frame
          let event: SseEvent;
          try {
            event = JSON.parse(data) as SseEvent;
          } catch (exc) {
            finish(new Error(`bad SSE frame: ${exc}; frame: ${frame.slice(0, 200)}`));
            req.destroy();
            return;
          }
          if (id !== null) event.id = id;
          events.push(event);
          Promise.resolve(onEvent(event)).catch((exc) => {
            req.destroy();
            finish(exc instanceof Error ? exc : new Error(String(exc)));
          });
          if (event.type === "run_end") {
            req.destroy();
            finish(null);
          }
        }
      });
      res.on("end", () => finish(null));
      res.on("error", (exc) => finish(exc));
    });
    req.on("error", (exc: Error) => {
      // a destroy() after run_end lands here; ignore it once settled
      if (!settled) finish(exc);
    });
  });
}

// ---------------------------------------------------------------------------
// server / record helpers
// ---------------------------------------------------------------------------

interface RunningApi {
  base: string;
  handle: ServerHandle;
  dir: string;
  close(): Promise<void>;
}

async function startServer(
  api: Api,
  dir: string,
  configFactory: () => Config,
  providerOverrides?: { senior?: Provider; junior?: Provider },
): Promise<RunningApi> {
  const handle = api.createServer({
    configFactory,
    sessionsDir: dir,
    webDist: null,
    ...(providerOverrides ? { providerOverrides } : {}),
  });
  const server = await handle.listen("127.0.0.1", 0);
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, handle, dir, close: () => handle.close() };
}

interface SubmittedRun {
  runId: string;
  session: string;
}

async function submitRun(base: string, body: Record<string, unknown>): Promise<SubmittedRun> {
  const res = await httpJson(base, "POST", "/api/runs", body);
  check(res.status === 202, `POST /api/runs -> HTTP ${res.status}: ${JSON.stringify(res.body)}`);
  const record = res.body as Record<string, unknown>;
  const runId = String(record.run_id ?? "");
  const session = String(record.session ?? "");
  check(runId.length > 0 && session.length > 0, `POST /api/runs returned no run_id/session: ${JSON.stringify(res.body)}`);
  return { runId, session };
}

async function getRun(base: string, runId: string): Promise<Record<string, unknown>> {
  const res = await httpJson(base, "GET", `/api/runs/${runId}`);
  check(res.status === 200, `GET /api/runs/${runId} -> HTTP ${res.status}`);
  check(isRecord(res.body), `GET /api/runs/${runId} did not return an object`);
  return res.body;
}

async function waitTerminal(
  base: string,
  runId: string,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const record = await getRun(base, runId);
    if (["completed", "failed", "cancelled"].includes(String(record.status))) return record;
    if (Date.now() > deadline) throw new CheckError(`run ${runId} did not finish in ${timeoutMs / 1000}s`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function registerWorkspace(base: string, root: string): Promise<string> {
  const res = await httpJson(base, "POST", "/api/workspaces", { path: root, name: "e2e-status" });
  check(res.status === 201, `POST /api/workspaces -> HTTP ${res.status}: ${JSON.stringify(res.body)}`);
  const id = String((res.body as Record<string, unknown>).id ?? "");
  check(id.length > 0, "POST /api/workspaces returned no id");
  return id;
}

function loadSession(api: Api, file: string): Message[] {
  check(fs.existsSync(file), `session file missing: ${file}`);
  return new api.SessionStore(file).load() as Message[];
}

function assertDenseSeqs(events: Message[], where: string): void {
  const seqs = events.map((event) => event.seq);
  check(new Set(seqs).size === seqs.length, `${where}: duplicate seqs: ${seqs.join(",")}`);
  check(
    seqs.every((seq, index) => seq === index + 1),
    `${where}: seqs not dense 1..${seqs.length}: ${seqs.join(",")}`,
  );
}

function assertValidEnvelopes(api: Api, events: Message[], where: string): void {
  for (const event of events) {
    const errors = api.validateMessage(event);
    check(errors.length === 0, `${where}: envelope failed validateMessage: ${errors.join("; ")}`);
  }
}

/** A failing provider for the restart suite (hermetic variant). */
function failingProvider(message: string): Provider {
  return {
    async chat() {
      throw new Error(message);
    },
    async chatWithTools() {
      throw new Error(message);
    },
  };
}

function assertUsageEqual(left: unknown, right: unknown, where: string): void {
  const a = (isRecord(left) ? left : {}) as Partial<UsageTotals>;
  const b = (isRecord(right) ? right : {}) as Partial<UsageTotals>;
  for (const key of ["model_calls", "input_tokens", "output_tokens", "cached_tokens"] as const) {
    check(a[key] === b[key], `${where}: usage.${key} ${String(a[key])} != ${String(b[key])}`);
  }
}

// ---------------------------------------------------------------------------
// profiles: the same suite bodies run hermetic (mock) or against a live model
// ---------------------------------------------------------------------------

export interface LiveEndpoint {
  baseUrl: string;
  seniorModel: string;
  juniorModel: string;
}

interface WaitingProfile {
  label: string;
  configFactory: () => Config;
  /** Fresh per run (a MockProvider script is consumed once). */
  providerOverrides?: () => { senior?: Provider; junior?: Provider };
  task: string;
  timeoutMs: number;
}

interface ContractProfile {
  label: string;
  configFactory: () => Config;
  timeoutMs: number;
}

interface ErrorProfile {
  label: string;
  configFactory: () => Config;
  /** Fresh per server instance (only the first instance runs). */
  providerOverrides?: () => { senior?: Provider; junior?: Provider };
  /** Required substring of the recorded error (hermetic scripted message). */
  errorNeedle?: string;
  timeoutMs: number;
}

const HERMETIC_DELIVERABLE = JSON.stringify({
  result: "the status file is written",
  artifacts: ["status.txt"],
  confidence: 0.8,
});

function mockConfig(api: Api, extra: Record<string, unknown> = {}): () => Config {
  return () => api.resolveConfig({ provider: "mock", mode: "consult", ...extra });
}

function hermeticWaitingProfile(api: Api): WaitingProfile {
  return {
    label: "hermetic",
    configFactory: mockConfig(api),
    providerOverrides: () => ({
      junior: new api.MockProvider([
        { tool: "workspace_write_file", args: { path: "status.txt", content: "ok" } },
        { text: HERMETIC_DELIVERABLE },
      ]),
    }),
    task: WAIT_TASK,
    timeoutMs: HERMETIC_TIMEOUT_MS,
  };
}

function liveWaitingProfile(api: Api, live: LiveEndpoint): WaitingProfile {
  return {
    label: "live",
    configFactory: () =>
      api.resolveConfig({
        provider: "openai",
        baseUrl: live.baseUrl,
        seniorModel: live.seniorModel,
        juniorModel: live.juniorModel,
        timeout: 120,
        retries: 2,
      }),
    task:
      "Create the file calc.js containing a JavaScript function add(a, b) that " +
      "returns the sum of its two arguments, plus a one-line comment above it " +
      "explaining what the function does. Then confirm the file was written.",
    timeoutMs: LIVE_TIMEOUT_MS,
  };
}

function liveContractProfile(api: Api, live: LiveEndpoint): ContractProfile {
  return {
    label: "live",
    // work-mode default makes the no-mode run cheap (no workspace -> no tools)
    configFactory: () =>
      api.resolveConfig({
        provider: "openai",
        baseUrl: live.baseUrl,
        seniorModel: live.seniorModel,
        juniorModel: live.juniorModel,
        mode: "work",
        timeout: 120,
        retries: 2,
      }),
    timeoutMs: LIVE_TIMEOUT_MS,
  };
}

function liveErrorProfile(api: Api, live: LiveEndpoint): ErrorProfile {
  return {
    label: "live",
    // a real endpoint with a model it does not serve: the provider fails
    // fast (non-retryable 4xx) and the message must survive the restart
    configFactory: () =>
      api.resolveConfig({
        provider: "openai",
        baseUrl: live.baseUrl,
        seniorModel: "e2e-model-that-does-not-exist",
        juniorModel: live.juniorModel,
        timeout: 20,
        retries: 0,
      }),
    timeoutMs: 120_000,
  };
}

// ---------------------------------------------------------------------------
// server-status-waiting
// ---------------------------------------------------------------------------

interface WaitingRunResult {
  events: SseEvent[];
  finalRecord: Record<string, unknown>;
  session: string;
  kinds: string[];
  seqs: number[];
}

/**
 * Start one work-mode run, observe the park on the SSE stream, then either
 * allow the pending approval (once, at the first `waiting`) or stop the run.
 * The server and temp dirs are torn down before returning; the session shape
 * is read while they are still alive.
 */
async function driveWaitingRun(
  api: Api,
  profile: WaitingProfile,
  answer: "allow" | "stop",
): Promise<WaitingRunResult> {
  const dir = mkTempDir(`tb-e2e-status-${answer}-`);
  const wsDir = mkTempDir(`tb-e2e-status-ws-${answer}-`);
  const srv = await startServer(api, dir, profile.configFactory, profile.providerOverrides?.());
  try {
    const workspaceId = await registerWorkspace(srv.base, wsDir);
    const submitted = await submitRun(srv.base, {
      task: profile.task,
      mode: "work",
      workspace_id: workspaceId,
      session: `status-${answer}-${stamp()}.jsonl`,
    });

    let parks = 0;
    const events = await driveRunSse(
      srv.base,
      submitted.runId,
      async (event) => {
        if (event.type !== "run_status" || event.status !== "waiting") return;
        // allow answers every park (a real work run may approve several
        // mutations); stop only needs the first one
        if (answer === "stop" && parks > 0) return;
        parks += 1;

        // the record and the pending-approval list agree with the stream
        const record = await getRun(srv.base, submitted.runId);
        check(
          record.status === "waiting",
          `${profile.label}: GET run at the park -> status ${String(record.status)} (expected waiting)`,
        );
        const pending = await httpJson(srv.base, "GET", `/api/runs/${submitted.runId}/approvals`);
        check(pending.status === 200, `GET pending approvals -> HTTP ${pending.status}`);
        const list = (pending.body as Record<string, unknown>).pending;
        check(
          Array.isArray(list) && list.length >= 1,
          `${profile.label}: no pending approval at the park: ${JSON.stringify(pending.body)}`,
        );
        const approvalId = String((list[0] as Record<string, unknown>).approval_id);
        check(approvalId.length > 0, `${profile.label}: pending approval has no approval_id`);

        if (answer === "allow") {
          const resolved = await httpJson(
            srv.base,
            "POST",
            `/api/runs/${submitted.runId}/approvals/${approvalId}`,
            { allow: true },
          );
          check(
            resolved.status === 200 && (resolved.body as Record<string, unknown>).decision === "allow",
            `${profile.label}: approval answer -> HTTP ${resolved.status}: ${JSON.stringify(resolved.body)}`,
          );
        } else {
          const stopped = await httpJson(srv.base, "POST", `/api/runs/${submitted.runId}/stop`);
          check(stopped.status === 200, `${profile.label}: POST stop -> HTTP ${stopped.status}`);
        }
      },
      profile.timeoutMs,
    );
    if (parks === 0) {
      // a real model that never mutates never parks; that is model behavior,
      // not a status-contract break. The hermetic suite can never take this
      // path.
      if (profile.label !== "hermetic") {
        throw new StatusSuiteSkip(
          `${profile.label}: the run completed without parking on an operator approval ` +
            "(model behavior; status contract not exercised)",
        );
      }
      throw new CheckError(`${profile.label}: the run never emitted run_status: waiting`);
    }

    const finalRecord = await getRun(srv.base, submitted.runId);
    const sessionEvents = loadSession(api, path.join(dir, submitted.session));
    return {
      events,
      finalRecord,
      session: submitted.session,
      kinds: sessionEvents.map((event) => event.kind),
      seqs: sessionEvents.map((event) => event.seq),
    };
  } finally {
    await srv.close();
    rmDir(dir);
    rmDir(wsDir);
  }
}

function runStatuses(events: SseEvent[]): string[] {
  return events
    .filter((event) => event.type === "run_status")
    .map((event) => String(event.status));
}

function indexOfLast<T>(items: T[], before: number, predicate: (item: T) => boolean): number {
  for (let index = Math.min(before - 1, items.length - 1); index >= 0; index--) {
    if (predicate(items[index])) return index;
  }
  return -1;
}

/**
 * Shared ordering invariants: the cause event precedes its park transition,
 * a park resolves before the return to running, a park is never emitted
 * twice in a row, and `run_end` is terminal.
 */
function assertWaitingInvariants(events: SseEvent[], where: string): void {
  check(events.length > 0, `${where}: empty SSE stream`);
  check(events[events.length - 1].type === "run_end", `${where}: last event is not run_end`);
  for (let index = 1; index < events.length; index++) {
    const previous = events[index - 1];
    const current = events[index];
    check(
      !(
        previous.type === "run_status" &&
        previous.status === "waiting" &&
        current.type === "run_status" &&
        current.status === "waiting"
      ),
      `${where}: duplicate run_status: waiting at events ${index - 1},${index}`,
    );
  }
  let openRequests = 0;
  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    if (event.type === "approval_requested") openRequests += 1;
    if (event.type === "approval_resolved") openRequests = Math.max(0, openRequests - 1);
    if (event.type === "run_status" && event.status === "waiting") {
      check(openRequests > 0, `${where}: run_status: waiting with no open approval_requested`);
    }
    if (event.type === "run_status" && event.status === "running" && index > 0) {
      const waitingIndex = indexOfLast(
        events,
        index,
        (candidate: SseEvent) => candidate.type === "run_status" && candidate.status === "waiting",
      );
      if (waitingIndex >= 0) {
        const resolvedIndex = indexOfLast(
          events,
          index,
          (candidate: SseEvent) => candidate.type === "approval_resolved",
        );
        check(
          resolvedIndex > waitingIndex,
          `${where}: returned to running after the park without an approval_resolved`,
        );
      }
    }
  }
}

async function suiteStatusWaiting(
  api: Api,
  runsDir: string,
  profile: WaitingProfile,
): Promise<SuiteOutcome> {
  // -- allow: park -> stale-proof wait -> resolve -> running -> completed --
  const allowed = await driveWaitingRun(api, profile, "allow");
  const allowWhere = `server-status-waiting (${profile.label}, allow)`;
  assertWaitingInvariants(allowed.events, allowWhere);

  const allowStatuses = runStatuses(allowed.events);
  check(allowStatuses[0] === "queued", `${allowWhere}: first run_status is ${allowStatuses[0]}, expected queued`);
  check(allowStatuses.includes("waiting"), `${allowWhere}: no waiting status: ${allowStatuses.join(",")}`);
  const allowEnd = allowed.events[allowed.events.length - 1];
  check(allowEnd.status === "completed", `${allowWhere}: run_end status ${String(allowEnd.status)}`);
  check(allowed.finalRecord.status === "completed", `${allowWhere}: record status ${String(allowed.finalRecord.status)}`);
  check(allowed.seqs.every((seq, index) => seq === index + 1),
    `${allowWhere}: session seqs not dense: ${allowed.seqs.join(",")}`);

  // exact hermetic cycle; live runs may park more than once, so only the
  // first cycle is pinned there (the invariants above cover the rest)
  if (profile.label === "hermetic") {
    check(allowStatuses.filter((status) => status === "waiting").length === 1,
      `${allowWhere}: expected exactly one waiting status: ${allowStatuses.join(",")}`);
    check(allowed.kinds.join(",") === "message,delegation,deliverable,review,decision",
      `${allowWhere}: unexpected envelope kinds: ${allowed.kinds.join(",")}`);
    check(allowStatuses.join(",") === "queued,running,waiting,running",
      `${allowWhere}: run_status sequence ${allowStatuses.join(",")}`);
  } else {
    // the real run's envelope shape may include revise rounds; pin only the
    // frame the cooperation contract guarantees
    check(allowed.kinds[0] === "message", `${allowWhere}: first envelope ${allowed.kinds[0]} (expected message)`);
    check(allowed.kinds[1] === "delegation", `${allowWhere}: second envelope ${allowed.kinds[1]} (expected delegation)`);
    check(
      allowed.kinds[allowed.kinds.length - 2] === "review" &&
        allowed.kinds[allowed.kinds.length - 1] === "decision",
      `${allowWhere}: tail envelopes ${allowed.kinds.slice(-2).join(",")} (expected review,decision)`,
    );
  }

  // cause first, transition second — for the first park on both profiles
  const waitingIndex = allowed.events.findIndex(
    (event) => event.type === "run_status" && event.status === "waiting",
  );
  check(waitingIndex >= 0, `${allowWhere}: no waiting transition to order`);
  const requestedIndex = indexOfLast(
    allowed.events,
    waitingIndex,
    (event: SseEvent) => event.type === "approval_requested",
  );
  check(requestedIndex >= 0 && requestedIndex < waitingIndex,
    `${allowWhere}: approval_requested does not precede the waiting transition`);
  const resolvedIndex = allowed.events.findIndex(
    (event, index) => index > waitingIndex && event.type === "approval_resolved" && event.decision === "allow",
  );
  const runningIndex = allowed.events.findIndex(
    (event, index) => index > waitingIndex && event.type === "run_status" && event.status === "running",
  );
  check(resolvedIndex > waitingIndex && resolvedIndex < runningIndex,
    `${allowWhere}: approval_resolved does not precede the return to running (${resolvedIndex} vs ${runningIndex})`);

  // -- stop while parked: denyAll on abort, cancelled, no phantom running --
  const stopped = await driveWaitingRun(api, profile, "stop");
  const stopWhere = `server-status-waiting (${profile.label}, stop)`;
  assertWaitingInvariants(stopped.events, stopWhere);
  const stopStatuses = runStatuses(stopped.events);
  check(stopStatuses.join(",") === "queued,running,waiting",
    `${stopWhere}: run_status sequence ${stopStatuses.join(",")}`);
  const stopEnd = stopped.events[stopped.events.length - 1];
  check(stopEnd.status === "cancelled", `${stopWhere}: run_end status ${String(stopEnd.status)}`);
  check(stopped.finalRecord.status === "cancelled", `${stopWhere}: record status ${String(stopped.finalRecord.status)}`);
  check(!stopped.events.some((event) => event.type === "run_error"),
    `${stopWhere}: a stop-deny emitted run_error`);
  const denied = stopped.events.find((event) => event.type === "approval_resolved");
  check(denied !== undefined, `${stopWhere}: no approval_resolved for the pending wait`);
  check(denied.decision === "deny", `${stopWhere}: stop resolved the wait as ${String(denied.decision)}`);
  check(denied.reason === "cancelled", `${stopWhere}: stop resolution reason ${String(denied.reason)}`);

  const evidenceFile = writeEvidence(runsDir, `server-status-waiting-${profile.label}-events`, {
    allow: allowed.events,
    stop: stopped.events,
  });
  return {
    detail:
      `park/resolve cycle ${allowStatuses.join(" -> ")} over SSE; ` +
      `stop-deny ${stopStatuses.join(" -> ")} then cancelled with no phantom running`,
    evidenceFile,
    approvals: profile.label === "hermetic" ? 2 : allowed.events.filter((e) => e.type === "approval_requested").length + 1,
  };
}

// ---------------------------------------------------------------------------
// server-mode-contract
// ---------------------------------------------------------------------------

async function suiteModeContract(
  api: Api,
  runsDir: string,
  profile: ContractProfile,
): Promise<SuiteOutcome> {
  const dir = mkTempDir("tb-e2e-mode-");
  const srv = await startServer(api, dir, profile.configFactory);
  const where = `server-mode-contract (${profile.label})`;
  const records: Record<string, unknown>[] = [];
  try {
    const defaultMode = String(profile.configFactory().mode);
    check(defaultMode.length > 0, `${where}: config factory returned an empty default mode`);

    // explicit mode round-trips through POST -> GET {id} -> GET list, at
    // submit time (queued/running) and at the terminal record
    const explicitSession = `mode-explicit-${stamp()}.jsonl`;
    const explicit = await submitRun(srv.base, {
      task: MODE_TASK,
      mode: "consult",
      session: explicitSession,
    });
    const immediate = await getRun(srv.base, explicit.runId);
    check(immediate.mode === "consult", `${where}: immediate record mode ${String(immediate.mode)} (expected consult)`);
    records.push(immediate);
    const explicitFinal = await waitTerminal(srv.base, explicit.runId, profile.timeoutMs);
    check(explicitFinal.mode === "consult", `${where}: terminal record mode ${String(explicitFinal.mode)}`);
    check(explicitFinal.task === MODE_TASK, `${where}: terminal record lost its task`);
    records.push(explicitFinal);

    const listedExplicit = await httpJson(
      srv.base,
      "GET",
      `/api/runs?session=${encodeURIComponent(explicitSession)}`,
    );
    check(listedExplicit.status === 200, `${where}: GET /api/runs -> HTTP ${listedExplicit.status}`);
    check(Array.isArray(listedExplicit.body), `${where}: GET /api/runs did not return a list`);
    const explicitEntry = (listedExplicit.body as Array<Record<string, unknown>>).find(
      (record) => record.run_id === explicit.runId,
    );
    check(explicitEntry !== undefined, `${where}: GET /api/runs list misses the run`);
    check(explicitEntry.mode === "consult", `${where}: list mode ${String(explicitEntry.mode)} (expected consult)`);

    // omitted mode records the resolved config default the job runs with
    const fallback = await submitRun(srv.base, {
      task: MODE_TASK,
      session: `mode-default-${stamp()}.jsonl`,
    });
    const fallbackFinal = await waitTerminal(srv.base, fallback.runId, profile.timeoutMs);
    check(
      fallbackFinal.mode === defaultMode,
      `${where}: omitted-mode record ${String(fallbackFinal.mode)} (expected config default ${defaultMode})`,
    );
    records.push(fallbackFinal);

    // a run adopting the persisted session keeps its own mode; the earlier
    // record keeps its original one (no last-writer-wins on the record)
    const adopted = await submitRun(srv.base, {
      task: "Name one risk of tight deadlines",
      mode: "work",
      session: explicitSession,
    });
    const adoptedFinal = await waitTerminal(srv.base, adopted.runId, profile.timeoutMs);
    check(adoptedFinal.mode === "work", `${where}: adopted run mode ${String(adoptedFinal.mode)}`);
    records.push(adoptedFinal);
    const originalAgain = await getRun(srv.base, explicit.runId);
    check(originalAgain.mode === "consult", `${where}: adopted-session run overwrote the earlier mode`);
    const listedSession = await httpJson(
      srv.base,
      "GET",
      `/api/runs?session=${encodeURIComponent(explicitSession)}`,
    );
    const sessionModes = (listedSession.body as Array<Record<string, unknown>>)
      .map((record) => `${String(record.run_id)}:${String(record.mode)}`)
      .sort();
    check(
      sessionModes.length === 2 && sessionModes.includes(`${explicit.runId}:consult`) && sessionModes.includes(`${adopted.runId}:work`),
      `${where}: session list modes ${JSON.stringify(sessionModes)}`,
    );

    // a client reload: the whole list and both ids still carry their modes
    const reloaded = await httpJson(srv.base, "GET", "/api/runs");
    check(reloaded.status === 200, `${where}: reload list -> HTTP ${reloaded.status}`);
    const reloadedRecords = reloaded.body as Array<Record<string, unknown>>;
    for (const expected of [explicitFinal, fallbackFinal, adoptedFinal]) {
      const entry = reloadedRecords.find((record) => record.run_id === expected.run_id);
      check(entry !== undefined, `${where}: reloaded list misses run ${String(expected.run_id)}`);
      check(entry.mode === expected.mode,
        `${where}: reloaded mode ${String(entry.mode)} != ${String(expected.mode)} for ${String(expected.run_id)}`);
    }

    // invalid modes are still rejected before a record exists
    const bad = await httpJson(srv.base, "POST", "/api/runs", { task: MODE_TASK, mode: "bogus" });
    check(bad.status === 400, `${where}: invalid mode -> HTTP ${bad.status} (expected 400)`);

    const evidenceFile = writeEvidence(runsDir, `server-mode-contract-${profile.label}-records`, records);
    return {
      detail:
        `explicit consult + omitted-mode ${defaultMode} + adopted-session work all observable ` +
        `through /api/runs and /api/runs/{id} (${records.length} record reads)`,
      evidenceFile,
    };
  } finally {
    await srv.close();
    rmDir(dir);
  }
}

// ---------------------------------------------------------------------------
// server-error-restart
// ---------------------------------------------------------------------------

function readJsonl(file: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const line of fs.readFileSync(file, "utf-8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (isRecord(parsed)) out.push(parsed);
    } catch {
      // tolerate a torn last line
    }
  }
  return out;
}

async function suiteErrorRestart(
  api: Api,
  runsDir: string,
  profile: ErrorProfile,
): Promise<SuiteOutcome> {
  const dir = mkTempDir("tb-e2e-restart-");
  const where = `server-error-restart (${profile.label})`;
  try {
    let runId = "";
    let session = "";
    let errorMessage = "";
    let originalUsage: unknown;
    let streamed: SseEvent[] = [];

    const first = await startServer(api, dir, profile.configFactory, profile.providerOverrides?.());
    try {
      const submitted = await submitRun(first.base, {
        task: "fail on purpose",
        mode: "auto",
        session: `fail-${stamp()}.jsonl`,
      });
      runId = submitted.runId;
      session = submitted.session;

      streamed = await driveRunSse(first.base, runId, () => undefined, profile.timeoutMs);
      const errorEvent = streamed.find((event) => event.type === "run_error");
      check(errorEvent !== undefined, `${where}: no run_error event`);
      errorMessage = String(errorEvent.message ?? "");
      check(errorMessage.length > 0, `${where}: run_error carried an empty message`);
      if (profile.errorNeedle !== undefined) {
        check(
          errorMessage.includes(profile.errorNeedle),
          `${where}: run_error ${JSON.stringify(errorMessage)} misses ${JSON.stringify(profile.errorNeedle)}`,
        );
      }
      const end = streamed[streamed.length - 1];
      check(end.type === "run_end", `${where}: last SSE event is ${String(end.type)}`);
      check(end.status === "failed", `${where}: run_end status ${String(end.status)}`);

      const failed = await waitTerminal(first.base, runId, profile.timeoutMs);
      check(failed.status === "failed", `${where}: terminal record status ${String(failed.status)}`);
      check(failed.error === errorMessage, `${where}: record error ${JSON.stringify(String(failed.error))} != ${JSON.stringify(errorMessage)}`);
      originalUsage = failed.usage;

      const sidecar = path.join(dir, "runtime", `${session}.events.jsonl`);
      check(fs.existsSync(sidecar), `${where}: runtime sidecar missing: ${sidecar}`);
      const sidecarEvents = readJsonl(sidecar).filter((event) => event.run_id === runId);
      check(
        sidecarEvents.some((event) => event.type === "run_error" && event.message === errorMessage),
        `${where}: sidecar has no matching run_error`,
      );
      check(
        sidecarEvents.some((event) => event.type === "run_end" && event.status === "failed"),
        `${where}: sidecar has no failed run_end`,
      );
    } finally {
      await first.close();
    }

    // simulated backend restart: a fresh server + RunManager over the same
    // sessions dir. The in-memory record map is empty; only the sidecar is left.
    const second = await startServer(api, dir, profile.configFactory, profile.providerOverrides?.());
    try {
      check(second.handle.state.runs.get(runId) === null,
        `${where}: restarted server still has the run in memory`);
      const recovered = await httpJson(second.base, "GET", `/api/runs/${runId}`);
      check(recovered.status === 200, `${where}: GET recovered run -> HTTP ${recovered.status}`);
      const record = recovered.body as Record<string, unknown>;
      check(record.status === "failed", `${where}: rebuilt status ${String(record.status)}`);
      check(record.error === errorMessage,
        `${where}: rebuilt error ${JSON.stringify(String(record.error))} != ${JSON.stringify(errorMessage)}`);
      check(record.task === "", `${where}: rebuilt task ${JSON.stringify(String(record.task))} (expected "")`);
      check(record.mode === "", `${where}: rebuilt mode ${JSON.stringify(String(record.mode))} (expected "")`);
      check(record.session === session, `${where}: rebuilt session ${String(record.session)} != ${session}`);
      assertUsageEqual(originalUsage, record.usage, where);
      check(typeof record.created === "number" && record.created > 0, `${where}: rebuilt created ${String(record.created)}`);
      check(typeof record.started === "number" && record.started > 0, `${where}: rebuilt started ${String(record.started)}`);
      check(typeof record.finished === "number" && record.finished > 0, `${where}: rebuilt finished ${String(record.finished)}`);

      const unknown = await httpJson(second.base, "GET", "/api/runs/definitely-not-a-run");
      check(unknown.status === 404, `${where}: unknown run id -> HTTP ${unknown.status} (expected 404)`);

      const evidenceFile = writeEvidence(runsDir, `server-error-restart-${profile.label}-events`, {
        run_id: runId,
        session,
        error: errorMessage,
        events: streamed,
        recovered: record,
      });
      return {
        detail:
          `failed run emitted run_error + run_end; after restart GET /api/runs/${runId} ` +
          `rebuilt status=failed with the same error (task/mode ""), unknown ids 404`,
        evidenceFile,
      };
    } finally {
      await second.close();
    }
  } finally {
    rmDir(dir);
  }
}

// ---------------------------------------------------------------------------
// suite registry / standalone runner
// ---------------------------------------------------------------------------

export interface SuiteOutcome {
  detail: string;
  sessionFile?: string;
  evidenceFile?: string;
  usage?: UsageTotals;
  approvals?: number;
}

export interface StatusSuite {
  name: string;
  run: () => Promise<SuiteOutcome>;
}

export interface StatusSuiteOptions {
  api: Api;
  runsDir: string;
  /** When set, also register the three `-live` variants against this endpoint. */
  live?: LiveEndpoint;
}

/**
 * Build the status-contract suites. The three hermetic suites are always
 * present; `live` adds `-live` copies driven against the real endpoint.
 */
export function buildStatusSuites(options: StatusSuiteOptions): StatusSuite[] {
  const { api, runsDir, live } = options;
  const suites: StatusSuite[] = [
    {
      name: "server-status-waiting",
      run: () => suiteStatusWaiting(api, runsDir, hermeticWaitingProfile(api)),
    },
    {
      name: "server-mode-contract",
      run: () =>
        suiteModeContract(api, runsDir, {
          label: "hermetic",
          configFactory: mockConfig(api),
          timeoutMs: HERMETIC_TIMEOUT_MS,
        }),
    },
    {
      name: "server-error-restart",
      run: () =>
        suiteErrorRestart(api, runsDir, {
          label: "hermetic",
          configFactory: mockConfig(api),
          providerOverrides: () => ({ senior: failingProvider(FAIL_MESSAGE) }),
          errorNeedle: FAIL_MESSAGE,
          timeoutMs: HERMETIC_TIMEOUT_MS,
        }),
    },
  ];
  if (live !== undefined) {
    suites.push(
      {
        name: "server-status-waiting-live",
        run: () => suiteStatusWaiting(api, runsDir, liveWaitingProfile(api, live)),
      },
      {
        name: "server-mode-contract-live",
        run: () => suiteModeContract(api, runsDir, liveContractProfile(api, live)),
      },
      {
        name: "server-error-restart-live",
        run: () => suiteErrorRestart(api, runsDir, liveErrorProfile(api, live)),
      },
    );
  }
  return suites;
}

async function main(): Promise<number> {
  const dist = process.env.TWO_BROTHERS_E2E_DIST === "1";
  const entry = new URL(dist ? "../dist/index.js" : "../src/index.ts", import.meta.url).href;
  const api = (await import(entry)) as unknown as Api;
  fs.mkdirSync(RUNS_DIR, { recursive: true });

  log(`E2E status: entry ${dist ? "dist" : "src"}, node ${process.version}`);
  const suites = buildStatusSuites({ api, runsDir: RUNS_DIR });
  let failures = 0;
  for (const suite of suites) {
    const started = Date.now();
    try {
      const evidence = await suite.run();
      log(`  PASS ${suite.name} (${((Date.now() - started) / 1000).toFixed(1)}s) — ${evidence.detail}`);
    } catch (exc) {
      if (exc instanceof StatusSuiteSkip) {
        log(`  SKIP ${suite.name} (${((Date.now() - started) / 1000).toFixed(1)}s) — ${exc.message}`);
        continue;
      }
      failures += 1;
      log(
        `  FAIL ${suite.name} (${((Date.now() - started) / 1000).toFixed(1)}s) — ` +
          `${exc instanceof Error ? exc.message : String(exc)}`,
      );
    }
  }
  log(failures === 0 ? "E2E status: PASS" : `E2E status: FAIL (${failures} suite(s) failed)`);
  return failures === 0 ? 0 : 1;
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.stack ?? err.message : String(err));
      process.exitCode = 1;
    });
}