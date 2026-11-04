/**
 * E2E runner: the harness against a live OpenAI-compatible endpoint (LM
 * Studio) plus the hermetic server-status and prompt-audit suites. The live
 * suites are the only non-hermetic test surface in the package — everything
 * under tests/ stays offline; `e2e/server-status.ts` and
 * `e2e/server-prompt-audit.ts` use mock providers and temp dirs, and run even
 * when no endpoint is reachable.
 *
 *   node e2e/run.ts                  # sources (Node >= 22.6 type stripping)
 *   node e2e/run-dist.mjs            # built dist/ (the published artifact)
 *
 * Environment:
 *   TWO_BROTHERS_E2E_BASE_URL        override endpoint (default: probe list)
 *   TWO_BROTHERS_E2E_API_KEY         key the endpoint requires (default "")
 *   TWO_BROTHERS_E2E_SENIOR_MODEL    default spark-x2.6-4b@q4_k_m
 *   TWO_BROTHERS_E2E_JUNIOR_MODEL    default lfm3-1.7b
 *   TWO_BROTHERS_E2E_DIST=1          import dist/ instead of src/
 *   TWO_BROTHERS_E2E_ONLY=<substr>   run only suites whose name contains it
 *                                    (iteration aid; e.g. "server")
 *
 * Exit codes: 0 = every suite passed, or a clean `E2E SKIP:` when the
 * endpoint is unreachable / the models are not served (the hermetic
 * server-status suites still run in that case); 1 = at least one suite
 * failed.
 *
 * Evidence: session JSONL per suite plus a machine-readable run report and
 * the raw model replies are written to e2e/runs/ (gitignored).
 */
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

import type {
  ApprovalRequest,
  Config,
  HarnessOptions,
  Message,
  PayloadParseResult,
  Provider,
  ServerHandle,
  ToolChatResponse,
  UsageTotals,
} from "../src/index.ts";
import { buildStatusSuites, StatusSuiteSkip } from "./server-status.ts";
import { buildPromptAuditSuites } from "./server-prompt-audit.ts";

type HarnessApi = typeof import("../src/index.ts");
type Harness = InstanceType<HarnessApi["TwoBrothersHarness"]>;

const DIST = process.env.TWO_BROTHERS_E2E_DIST === "1";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const RUNS_DIR = path.join(HERE, "runs");

// The import specifier is built at runtime so this file typechecks without
// dist/ present; run-dist.mjs flips TWO_BROTHERS_E2E_DIST=1 before importing.
const entry = new URL(DIST ? "../dist/index.js" : "../src/index.ts", import.meta.url).href;
const api = (await import(entry)) as unknown as HarnessApi;

const CANDIDATE_BASE_URLS = [
  "http://172.18.0.1:1234/v1",
  "http://localhost:1234/v1",
  "http://127.0.0.1:1234/v1",
];
const SENIOR_MODEL = process.env.TWO_BROTHERS_E2E_SENIOR_MODEL ?? "spark-x2.6-4b@q4_k_m";
const JUNIOR_MODEL = process.env.TWO_BROTHERS_E2E_JUNIOR_MODEL ?? "lfm3-1.7b";
/** API key sent to the endpoint (empty for LM Studio, required for hosted providers). */
const E2E_API_KEY = process.env.TWO_BROTHERS_E2E_API_KEY ?? "";

const CONSULT_TASK = "Propose a test strategy for a calculator module";
const WORK_TASK =
  "Create the file calc.js containing a JavaScript function add(a, b) that " +
  "returns the sum of its two arguments, plus a one-line comment above it " +
  "explaining what the function does. Then confirm the file was written.";
const RESUME_TASK_A = "Name one benefit of code review";
const RESUME_TASK_B = "Name one risk of tight deadlines";

const CONNECT_TIMEOUT_MS = 5_000;
const MODELS_TIMEOUT_MS = 10_000;
/** Small models on a local server: per-request bound for E2E runs. */
const REQUEST_TIMEOUT_S = 120;
/** Keep a mid-run hiccup cheap; the retry loop itself is covered offline. */
const E2E_RETRIES = 2;

// ---------------------------------------------------------------------------
// tiny runner
// ---------------------------------------------------------------------------

class CheckError extends Error {}

function check(condition: boolean, message: string): void {
  if (!condition) throw new CheckError(message);
}

interface RawReply {
  role: string;
  kind: string;
  text: string;
  toolCalls: number;
}

interface SuiteRecord {
  name: string;
  status: "PASS" | "FAIL" | "SKIP";
  durationMs: number;
  detail: string;
  sessionFile?: string;
  evidenceFile?: string;
  usage?: UsageTotals;
  approvals?: number;
}

/** What a suite hands back to the runner on success. */
interface SuiteEvidence {
  detail: string;
  sessionFile?: string;
  evidenceFile?: string;
  usage?: UsageTotals;
  approvals?: number;
}

interface RunReport {
  generatedAt: string;
  dist: boolean;
  node: string;
  baseUrl: string;
  models: { senior: string; junior: string };
  suites: SuiteRecord[];
  approvals: number;
  quirks: string[];
}

interface Endpoint {
  baseUrl: string;
  modelIds: string[];
}

/** Mutable state shared between suites. */
interface SuiteState {
  endpoint: Endpoint;
  report: RunReport;
  rawReplies: RawReply[];
  quirks: Set<string>;
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function log(line: string): void {
  console.log(line);
}

// ---------------------------------------------------------------------------
// endpoint probing (the SKIP path)
// ---------------------------------------------------------------------------

async function fetchJson(url: string, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      // Hosted providers 401 an unauthenticated /models probe (LM Studio
      // ignores auth, so the empty-key default stays behavior-compatible).
      ...(E2E_API_KEY
        ? { headers: { authorization: `Bearer ${E2E_API_KEY}` } }
        : {}),
    });
    if (!response.ok) throw new CheckError(`HTTP ${response.status}`);
    return (await response.json()) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pick a live endpoint. Returns a skip reason instead when nothing
 * responds or the required models are not served — the caller prints
 * `E2E SKIP:` and exits 0.
 */
async function resolveEndpoint(): Promise<Endpoint | { skip: string }> {
  const override = process.env.TWO_BROTHERS_E2E_BASE_URL?.trim();
  const candidates = override ? [override] : CANDIDATE_BASE_URLS;
  const errors: string[] = [];
  for (const baseUrl of candidates) {
    let modelIds: string[];
    try {
      // 5 s connect probe, then the model list under a 10 s total budget
      await fetchJson(`${baseUrl}/models`, CONNECT_TIMEOUT_MS);
      const data = (await fetchJson(`${baseUrl}/models`, MODELS_TIMEOUT_MS)) as {
        data?: Array<{ id?: string }>;
      };
      modelIds = (data.data ?? []).map((m) => String(m.id ?? ""));
    } catch (exc) {
      errors.push(`${baseUrl}: ${exc instanceof Error ? exc.message : String(exc)}`);
      continue;
    }
    const missing = [SENIOR_MODEL, JUNIOR_MODEL].filter((m) => !modelIds.includes(m));
    if (missing.length > 0) {
      return {
        skip:
          `endpoint ${baseUrl} is up but does not serve the required models ` +
          `(missing: ${missing.join(", ")}; served: ${modelIds.join(", ") || "(none)"})`,
      };
    }
    return { baseUrl, modelIds };
  }
  return { skip: `no OpenAI-compatible endpoint reachable (${errors.join(" | ")})` };
}

// ---------------------------------------------------------------------------
// harness construction with raw-reply recording
// ---------------------------------------------------------------------------

/**
 * Wrap a provider so every raw model reply lands in `sink`. The wrapper is
 * transparent: same chat/chatWithTools behavior, usage delegated.
 */
function recordingProvider(inner: Provider, role: string, sink: RawReply[]): Provider {
  const wrapper: Provider & { usageSnapshot?: () => UsageTotals } = {
    async chat(messages, responseKind, signal) {
      const text = await inner.chat(messages, responseKind, signal);
      sink.push({ role, kind: responseKind ?? "message", text, toolCalls: 0 });
      return text;
    },
  };
  if (inner.chatWithTools) {
    const chatWithTools = inner.chatWithTools.bind(inner);
    wrapper.chatWithTools = async (messages, tools, options): Promise<ToolChatResponse> => {
      const response = await chatWithTools(messages, tools, options);
      sink.push({
        role,
        kind: options?.responseKind ?? "deliverable",
        text: response.content,
        toolCalls: response.toolCalls.length,
      });
      return response;
    };
  }
  const tracked = inner as Provider & { usageSnapshot?: () => UsageTotals };
  if (typeof tracked.usageSnapshot === "function") {
    wrapper.usageSnapshot = () => tracked.usageSnapshot?.() as UsageTotals;
  }
  return wrapper;
}

interface HarnessSetup {
  harness: Harness;
  cfg: Config;
}

function makeHarness(
  state: SuiteState,
  sessionFile: string,
  mode: "consult" | "work",
  maxRounds: number,
  workspace?: InstanceType<HarnessApi["Workspace"]>,
): HarnessSetup {
  const cfg = api.resolveConfig({
    provider: "openai",
    baseUrl: state.endpoint.baseUrl,
    apiKey: E2E_API_KEY,
    seniorModel: SENIOR_MODEL,
    juniorModel: JUNIOR_MODEL,
    mode,
    sessionFile,
    timeout: REQUEST_TIMEOUT_S,
    retries: E2E_RETRIES,
  });
  const options: HarnessOptions = {
    senior: recordingProvider(api.buildProvider(cfg, "senior"), "senior", state.rawReplies),
    junior: recordingProvider(api.buildProvider(cfg, "junior"), "junior", state.rawReplies),
    maxRounds,
  };
  if (workspace) options.workspace = workspace;
  return { harness: new api.TwoBrothersHarness(cfg, options), cfg };
}

/**
 * True for a zod issue that is just a model-invented scalar type (a string
 * field delivered as object/number/...). The tolerant pipeline contract
 * (the original prototype's sanitize contract) fills missing keys and
 * coerces lists/confidence, but deliberately does NOT coerce wrong-type
 * scalars — so these are recorded as model quirks, never hard failures.
 * Anything else (bad enum, wrong shape, missing required key) is structural
 * and fails the suite.
 */
function isWrongScalarType(issue: { code?: unknown; expected?: unknown }): boolean {
  return issue.code === "invalid_type" && issue.expected === "string";
}

/** Assert a strict-zod result; wrong-scalar-type issues become quirks. */
function assertStrictParse(state: SuiteState, where: string, kind: string, strict: PayloadParseResult): void {
  if (strict.ok) return;
  const scalar = strict.issues.filter((i) => isWrongScalarType(i));
  const structural = strict.issues.filter((i) => !isWrongScalarType(i));
  check(
    structural.length === 0,
    `${where}: ${kind} payload has structural zod issues: ` +
      JSON.stringify(structural.map((i) => i.message)),
  );
  if (scalar.length > 0) {
    const fields = scalar
      .map((i) => {
        const issue = i as { path?: Array<string | number>; received?: string };
        const field = issue.path?.join(".") ?? "(?)";
        return `${field} received ${issue.received ?? "?"}`;
      })
      .join("; ");
    state.quirks.add(
      `${where}: ${kind} payload: model sent a non-string scalar (${fields}); ` +
        "tolerated per the sanitize contract (wrong scalar types are not coerced)",
    );
  }
}

/** Every envelope the run appended must pass protocol envelope validation. */
function assertEnvelopesValid(state: SuiteState, where: string, messages: Message[]): void {
  for (const msg of messages) {
    const errors = api.validateMessage(msg);
    check(errors.length === 0, `${where}: envelope failed validateMessage: ${errors.join("; ")}`);
  }
}

/**
 * The parsing-robustness contract: every raw model reply must survive
 * parseModelOutput + sanitizePayload (the tolerant pipeline never throws).
 * Strict zod compliance is asserted on the LAST reply of each
 * (role, kind) group — that is the reply that fed the state machine.
 * Earlier replies may have been superseded by the payload-repair pass
 * (one re-ask per node), so their issues are recorded as quirks instead
 * of failing the suite; wrong-scalar tolerance still applies everywhere
 * (see isWrongScalarType).
 */
function assertRawRepliesParse(state: SuiteState, where: string, replies: RawReply[]): void {
  const lastIndexByGroup = new Map<string, number>();
  replies.forEach((reply, i) => {
    lastIndexByGroup.set(`${reply.role}:${reply.kind}`, i);
  });
  for (const [i, reply] of replies.entries()) {
    const parsed = api.parseModelOutput(reply.text, reply.kind);
    if (parsed.parseFailed) {
      state.quirks.add(
        `${where}: ${reply.role} ${reply.kind} reply was unstructured; ` +
          "the tolerant pipeline fell back to the raw text",
      );
    }
    const sanitized = api.sanitizePayload(reply.kind, parsed.payload, reply.text);
    const isFinalForGroup = lastIndexByGroup.get(`${reply.role}:${reply.kind}`) === i;
    const strict = api.parsePayload(reply.kind, sanitized);
    if (!isFinalForGroup && !strict.ok) {
      state.quirks.add(
        `${where}: ${reply.kind} (from ${reply.role}) pre-repair reply failed strict parse ` +
          `(${strict.issues.length} issue(s)); superseded by the repair pass`,
      );
      continue;
    }
    assertStrictParse(state, where, `${reply.kind} (from ${reply.role})`, strict);
  }
}

function loadSessionSeqs(sessionFile: string): number[] {
  const events = new api.SessionStore(sessionFile).load() as Message[];
  return events.map((event) => event.seq);
}

// ---------------------------------------------------------------------------
// server E2E helpers (in-process node:http server on an ephemeral port)
// ---------------------------------------------------------------------------

interface HttpResult {
  status: number;
  body: unknown;
}

async function httpJson(base: string, method: string, route: string, body?: unknown): Promise<HttpResult> {
  const response = await fetch(base + route, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // keep the raw body (e.g. an HTML error page)
  }
  return { status: response.status, body: parsed };
}

interface RunningApi {
  base: string;
  handle: ServerHandle;
  /** Sessions dir under e2e/runs/ — the suite's on-disk evidence. */
  dir: string;
  close(): Promise<void>;
}

/**
 * Start the TS server in-process with the live LM Studio providers
 * (recording wrappers, so the raw-reply assertions cover server runs too).
 * `label` names the evidence directory under e2e/runs/.
 */
async function startApiServer(state: SuiteState, label: string): Promise<RunningApi> {
  const dir = path.join(RUNS_DIR, `server-${label}-${stamp()}`);
  const configFactory = (): Config =>
    api.resolveConfig({
      provider: "openai",
      baseUrl: state.endpoint.baseUrl,
      apiKey: E2E_API_KEY,
      seniorModel: SENIOR_MODEL,
      juniorModel: JUNIOR_MODEL,
      timeout: REQUEST_TIMEOUT_S,
      retries: E2E_RETRIES,
    });
  const providerCfg = {
    provider: "openai",
    baseUrl: state.endpoint.baseUrl,
    apiKey: E2E_API_KEY,
    seniorModel: SENIOR_MODEL,
    juniorModel: JUNIOR_MODEL,
    temperature: 0.4,
    timeout: REQUEST_TIMEOUT_S,
    retries: E2E_RETRIES,
  };
  const handle = api.createServer({
    configFactory,
    sessionsDir: dir,
    webDist: null,
    providerOverrides: {
      senior: recordingProvider(
        new api.OpenAICompatibleProvider({ ...providerCfg, model: SENIOR_MODEL }),
        "senior",
        state.rawReplies,
      ),
      junior: recordingProvider(
        new api.OpenAICompatibleProvider({ ...providerCfg, model: JUNIOR_MODEL }),
        "junior",
        state.rawReplies,
      ),
    },
  });
  const server = await handle.listen("127.0.0.1", 0);
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, handle, dir, close: () => handle.close() };
}

interface SseEvent extends Record<string, unknown> {
  id?: number;
  type?: string;
}

/**
 * Drive a run's SSE stream (`GET /api/runs/{id}/events`), invoking
 * `onEvent` for every frame as it arrives — the approval flow answers
 * `approval_requested` mid-stream. Resolves with all events once `run_end`
 * arrives (the server closes the stream); rejects on timeout.
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

/**
 * Assert the cooperation envelope shape delivered over SSE / found in the
 * session file. `openKind` is consult|delegation, `answerKind` the junior's
 * reply (proposal|deliverable). Revise rounds are legal (the HTTP API has
 * no max-rounds knob): the middle alternates review/answer kinds, the last
 * two envelopes are always review -> decision.
 */
function assertCooperationShape(kinds: string[], openKind: string, answerKind: string, where: string): void {
  const allowed = new Set(["message", openKind, answerKind, "proposal", "review", "decision"]);
  check(kinds.length >= 5, `${where}: too few envelopes: ${kinds.join(",")}`);
  check(kinds[0] === "message", `${where}: first envelope must be the user message: ${kinds.join(",")}`);
  check(kinds[1] === openKind, `${where}: second envelope must be ${openKind}: ${kinds.join(",")}`);
  check(kinds[2] === answerKind, `${where}: third envelope must be ${answerKind}: ${kinds.join(",")}`);
  check(kinds[kinds.length - 2] === "review", `${where}: second-to-last must be review: ${kinds.join(",")}`);
  check(kinds[kinds.length - 1] === "decision", `${where}: last must be decision: ${kinds.join(",")}`);
  for (const kind of kinds) {
    check(allowed.has(kind), `${where}: unexpected envelope kind ${kind} in ${kinds.join(",")}`);
  }
  for (let i = 1; i < kinds.length; i++) {
    check(kinds[i] !== kinds[i - 1], `${where}: duplicate adjacent kinds: ${kinds.join(",")}`);
  }
}

/**
 * Repair-request markers appended by the payload-repair pass
 * (src/payloads.ts REPAIR_REQUEST_PREFIX). Live runs that produce a
 * repairable reply carry an extra user `message` envelope per repair;
 * sequence assertions must see only the cooperation envelopes.
 */
const REPAIR_MARKER = "[[REPAIR_REQUEST]]";

function isRepairEnvelope(envelope: unknown): boolean {
  if (!isRecord(envelope)) return false;
  if (envelope.kind !== "message") return false;
  const text = (envelope.payload as { text?: unknown } | null | undefined)?.text;
  return typeof text === "string" && text.startsWith(REPAIR_MARKER);
}

/** Envelope events out of an SSE event list (repair requests filtered out). */
function envelopeKinds(events: SseEvent[]): string[] {
  return events
    .filter((e) => e.type === "envelope" && isRecord(e.envelope) && !isRepairEnvelope(e.envelope))
    .map((e) => String((e.envelope as Record<string, unknown>).kind));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate + strictly parse every envelope of a session JSONL file. */
function assertSessionFile(state: SuiteState, where: string, sessionFile: string): Message[] {
  check(fs.existsSync(sessionFile), `${where}: session file missing: ${sessionFile}`);
  const events = new api.SessionStore(sessionFile).load() as Message[];
  check(events.length >= 5, `${where}: expected >= 5 envelopes on disk, got ${events.length}`);
  const seqs = events.map((e) => e.seq);
  check(new Set(seqs).size === seqs.length, `${where}: duplicate seqs on disk: ${seqs.join(",")}`);
  check(seqs.every((seq, i) => seq === i + 1), `${where}: seqs not dense on disk: ${seqs.join(",")}`);
  assertEnvelopesValid(state, where, events);
  for (const msg of events) {
    assertStrictParse(state, where, msg.kind, api.parsePayload(msg.kind, msg.payload));
  }
  return events;
}

/** Write an evidence JSON file under runs/ and return its path. */
function writeEvidence(name: string, data: unknown): string {
  const file = path.join(RUNS_DIR, `${name}-${stamp()}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
}

/** A generous per-run budget: small models at ~30-90 s per call. */
const SERVER_RUN_TIMEOUT_MS = 15 * 60_000;

// ---------------------------------------------------------------------------
// suites
// ---------------------------------------------------------------------------

async function suiteConnection(state: SuiteState): Promise<SuiteEvidence> {
  check(
    state.endpoint.modelIds.includes(SENIOR_MODEL) &&
      state.endpoint.modelIds.includes(JUNIOR_MODEL),
    "required models missing from /v1/models",
  );
  return { detail: `GET /v1/models on ${state.endpoint.baseUrl} serves: ${state.endpoint.modelIds.join(", ")}` };
}

async function suiteConsult(state: SuiteState): Promise<SuiteEvidence> {
  const sessionFile = path.join(RUNS_DIR, `consult-${stamp()}.jsonl`);
  // maxRounds 0: one review, then decision — the 5-envelope shape this
  // suite asserts. (Same knob as `--max-rounds 0`; tolerant semantics
  // untouched.)
  const { harness } = makeHarness(state, sessionFile, "consult", 0);
  const repliesFrom = state.rawReplies.length;
  const result = await harness.run(CONSULT_TASK, new api.SharedContext(new api.SessionStore(sessionFile)));

  check(!result.cancelled, "run was cancelled");
  // The payload-repair pass may insert marked repair messages between
  // cooperation envelopes; sequence assertions ignore them.
  const kinds = result.messages.filter((m) => !isRepairEnvelope(m)).map((m) => m.kind);
  check(
    kinds.join(",") === "message,consult,proposal,review,decision",
    `unexpected envelope kinds: ${kinds.join(",")}`,
  );
  assertEnvelopesValid(state, "consult", result.messages);
  for (const msg of result.messages) {
    assertStrictParse(state, "consult", msg.kind, api.parsePayload(msg.kind, msg.payload));
  }
  check(
    String(result.decision.decision ?? "").trim().length > 0,
    "decision payload is empty",
  );
  check(
    result.usage.model_calls >= 4,
    `expected >= 4 model calls, got ${result.usage.model_calls}`,
  );
  const transcript = result.context.renderTranscript();
  check(
    transcript.includes("[[TASK]]") && transcript.includes("[[/TASK]]"),
    "[[TASK]]/[[/TASK]] markers missing from the rendered transcript",
  );
  assertRawRepliesParse(state, "consult", state.rawReplies.slice(repliesFrom));
  for (const warning of result.errors) {
    state.quirks.add(`consult: harness warning: ${warning}`);
  }

  return {
    detail:
      `${kinds.length} envelopes (${kinds.join(" -> ")}), ${result.usage.model_calls} model calls, ` +
      `decision: ${JSON.stringify(String(result.decision.decision)).slice(0, 80)}…`,
    sessionFile,
    usage: result.usage,
  };
}

async function suiteWork(state: SuiteState): Promise<SuiteEvidence> {
  const sessionFile = path.join(RUNS_DIR, `work-${stamp()}.jsonl`);
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tb-e2e-work-"));
  const approvals: ApprovalRequest[] = [];
  // fail-open operator: every approval request is granted and recorded
  const permissions = new api.PermissionManager(null, (request: ApprovalRequest) => {
    approvals.push(request);
    return "approve";
  });
  const workspace = new api.Workspace(workspaceRoot, permissions);
  const { harness } = makeHarness(state, sessionFile, "work", 0, workspace);
  const repliesFrom = state.rawReplies.length;
  const result = await harness.run(WORK_TASK, new api.SharedContext(new api.SessionStore(sessionFile)));

  check(!result.cancelled, "run was cancelled");
  // The payload-repair pass may insert marked repair messages between
  // cooperation envelopes; sequence assertions ignore them.
  const kinds = result.messages.filter((m) => !isRepairEnvelope(m)).map((m) => m.kind);
  check(
    kinds.join(",") === "message,delegation,deliverable,review,decision",
    `unexpected envelope kinds: ${kinds.join(",")}`,
  );
  assertEnvelopesValid(state, "work", result.messages);
  check(approvals.length >= 1, "no approval request reached the broker");

  const deliverable = result.messages.find((m) => m.kind === "deliverable");
  const artifacts = ((deliverable?.payload.artifacts ?? []) as string[]);
  check(
    artifacts.some((a) => a.startsWith("tool:")),
    `deliverable carries no tool: artifact (artifacts: ${JSON.stringify(artifacts)})`,
  );
  const review = result.messages.find((m) => m.kind === "review");
  const points = ((review?.payload.points ?? []) as string[]);
  check(
    points.some((p) => p.startsWith("verify:")),
    `review carries no verify: point (points: ${JSON.stringify(points)})`,
  );

  // the file the junior was asked to create: exists on disk with real content
  const target = path.join(workspaceRoot, "calc.js");
  check(fs.existsSync(target), "calc.js was not created in the workspace");
  const content = fs.readFileSync(target, "utf-8");
  check(content.includes("add"), "calc.js does not contain the requested add function");
  check(
    content.includes("//") || content.includes("/*"),
    "calc.js does not contain the requested comment",
  );
  assertRawRepliesParse(state, "work", state.rawReplies.slice(repliesFrom));
  for (const warning of result.errors) {
    state.quirks.add(`work: harness warning: ${warning}`);
  }

  state.report.approvals += approvals.length;
  return {
    detail:
      `${kinds.length} envelopes (${kinds.join(" -> ")}), ${approvals.length} approvals ` +
      `(${approvals.map((a) => a.action).join(",")}), calc.js verified on disk (${content.length} chars)`,
    sessionFile,
    usage: result.usage,
    approvals: approvals.length,
  };
}

async function suiteResume(state: SuiteState): Promise<SuiteEvidence> {
  const sessionFile = path.join(RUNS_DIR, `resume-${stamp()}.jsonl`);
  const store = () => new api.SessionStore(sessionFile);

  const first = makeHarness(state, sessionFile, "consult", 0);
  const ctx1 = new api.SharedContext(store());
  const firstResult = await first.harness.run(RESUME_TASK_A, ctx1);
  assertEnvelopesValid(state, "resume (run 1)", firstResult.messages);

  // --resume-equivalent: rebuild the context from the JSONL session file
  const resumed = api.restoreContext(store());
  const second = makeHarness(state, sessionFile, "consult", 0);
  const secondResult = await second.harness.run(RESUME_TASK_B, resumed);
  assertEnvelopesValid(state, "resume (run 2)", secondResult.messages);

  const seqs = loadSessionSeqs(sessionFile);
  check(seqs.length >= 10, `expected >= 10 envelopes after resume, got ${seqs.length}`);
  const unique = new Set(seqs);
  check(unique.size === seqs.length, `duplicate seqs after resume: ${seqs.join(",")}`);
  const dense = seqs.every((seq, i) => seq === i + 1);
  check(dense, `seqs not dense after resume: ${seqs.join(",")}`);
  return { detail: `seqs 1..${seqs.length} dense, no duplicates across run + resume`, sessionFile };
}

// ---------------------------------------------------------------------------
// server suites (in-process node:http server against the live endpoint)
// ---------------------------------------------------------------------------

async function suiteConnectionServer(state: SuiteState): Promise<SuiteEvidence> {
  // the LM Studio probe (main's resolveEndpoint) already gated the run;
  // this suite proves the TS server itself boots and serves
  const srv = await startApiServer(state, "connection");
  try {
    const sessions = await httpJson(srv.base, "GET", "/api/sessions");
    check(sessions.status === 200, `GET /api/sessions -> HTTP ${sessions.status}`);
    check(Array.isArray(sessions.body), "GET /api/sessions must return a list");
    const settings = await httpJson(srv.base, "GET", "/api/settings");
    check(settings.status === 200, `GET /api/settings -> HTTP ${settings.status}`);
    check(isRecord(settings.body) && "senior" in settings.body && "junior" in settings.body,
      "GET /api/settings must return per-role settings");
    const health = await httpJson(srv.base, "GET", "/api/fs/browse?path=");
    check(health.status === 200, `GET /api/fs/browse -> HTTP ${health.status}`);
    return {
      detail: `in-process server on ${srv.base}: /api/sessions, /api/settings, /api/fs/browse all 200`,
    };
  } finally {
    await srv.close();
  }
}

async function suiteServerConsult(state: SuiteState): Promise<SuiteEvidence> {
  const srv = await startApiServer(state, "consult");
  try {
    const submitted = await httpJson(srv.base, "POST", "/api/runs", {
      task: CONSULT_TASK,
      mode: "consult",
      provider: "openai",
      session: `e2e-server-consult-${stamp()}.jsonl`,
    });
    check(submitted.status === 202, `POST /api/runs -> HTTP ${submitted.status}: ${JSON.stringify(submitted.body)}`);
    const runId = String((submitted.body as Record<string, unknown>).run_id);
    const session = String((submitted.body as Record<string, unknown>).session);

    const repliesFrom = state.rawReplies.length;
    const events = await driveRunSse(srv.base, runId, () => undefined, SERVER_RUN_TIMEOUT_MS);
    const evidenceFile = writeEvidence("server-consult-events", events);
    assertRawRepliesParse(state, "server-consult", state.rawReplies.slice(repliesFrom));

    const kinds = envelopeKinds(events);
    assertCooperationShape(kinds, "consult", "proposal", "server-consult");
    // SSE id: frames must be present and strictly increasing
    const ids = events.map((e) => e.id ?? -1);
    check(ids.every((id) => id > 0), "server-consult: SSE id: frames missing");
    for (let i = 1; i < ids.length; i++) {
      check(ids[i] > ids[i - 1], `server-consult: SSE ids not increasing: ${ids.join(",")}`);
    }
    const end = events.find((e) => e.type === "run_end");
    check(end !== undefined, "server-consult: no run_end event");
    check(end?.status === "completed", `server-consult: run_end status ${String(end?.status)}`);
    const decision = isRecord(end?.decision) ? end.decision : {};
    check(String(decision.decision ?? "").trim().length > 0, "server-consult: decision payload empty");
    const usage = isRecord(end?.usage)
      ? (end.usage as unknown as UsageTotals)
      : { model_calls: 0, input_tokens: 0, output_tokens: 0, cached_tokens: 0 };
    check(usage.model_calls >= 4, `server-consult: expected >= 4 model calls, got ${usage.model_calls}`);

    const sessionFile = path.join(srv.dir, session);
    assertSessionFile(state, "server-consult", sessionFile);

    // reconnect semantics: ?after=<last id> replays nothing already delivered
    const lastId = ids[ids.length - 1];
    const replay = await httpJson(srv.base, "GET", `/api/runs/${runId}/events?after=${lastId}`);
    check(replay.status === 200, `SSE reconnect -> HTTP ${replay.status}`);

    return {
      detail:
        `${kinds.length} envelopes over SSE (${kinds.join(" -> ")}), run_end completed, ` +
        `${usage.model_calls} model calls, session JSONL verified`,
      sessionFile,
      evidenceFile,
      usage,
    };
  } finally {
    await srv.close();
  }
}

async function suiteServerWorkApprovals(state: SuiteState): Promise<SuiteEvidence> {
  const srv = await startApiServer(state, "work");
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tb-e2e-srv-work-"));
  try {
    const registered = await httpJson(srv.base, "POST", "/api/workspaces", {
      path: workspaceRoot,
      name: "e2e-server-work",
    });
    check(registered.status === 201, `POST /api/workspaces -> HTTP ${registered.status}: ${JSON.stringify(registered.body)}`);
    const workspaceId = String((registered.body as Record<string, unknown>).id);

    const submitted = await httpJson(srv.base, "POST", "/api/runs", {
      task: WORK_TASK,
      mode: "work",
      provider: "openai",
      workspace_id: workspaceId,
      session: `e2e-server-work-${stamp()}.jsonl`,
    });
    check(submitted.status === 202, `POST /api/runs -> HTTP ${submitted.status}: ${JSON.stringify(submitted.body)}`);
    const runId = String((submitted.body as Record<string, unknown>).run_id);
    const session = String((submitted.body as Record<string, unknown>).session);

    // operator loop: grant every approval as it arrives, mid-stream
    const approvalsSeen: SseEvent[] = [];
    const resolutions: SseEvent[] = [];
    const repliesFrom = state.rawReplies.length;
    const events = await driveRunSse(
      srv.base,
      runId,
      async (event) => {
        if (event.type !== "approval_requested") return;
        approvalsSeen.push(event);
        const approvalId = String(event.approval_id);
        const pending = await httpJson(srv.base, "GET", `/api/runs/${runId}/approvals`);
        check(
          pending.status === 200 &&
            Array.isArray((pending.body as Record<string, unknown>).pending) &&
            ((pending.body as Record<string, unknown>).pending as unknown[]).length >= 1,
          "server-work: pending approvals endpoint empty",
        );
        const answer = await httpJson(srv.base, "POST", `/api/runs/${runId}/approvals/${approvalId}`, {
          allow: true,
        });
        check(
          answer.status === 200 && (answer.body as Record<string, unknown>).decision === "allow",
          `server-work: approval answer -> HTTP ${answer.status}: ${JSON.stringify(answer.body)}`,
        );
      },
      SERVER_RUN_TIMEOUT_MS,
    );
    for (const event of events) {
      if (event.type === "approval_resolved") resolutions.push(event);
    }
    const evidenceFile = writeEvidence("server-work-events", events);
    assertRawRepliesParse(state, "server-work", state.rawReplies.slice(repliesFrom));

    check(approvalsSeen.length >= 1, "server-work: no approval_requested event over SSE");
    check(resolutions.length >= 1, "server-work: no approval_resolved event over SSE");
    for (const request of approvalsSeen) {
      const matched = resolutions.some((r) => r.approval_id === request.approval_id);
      check(matched, `server-work: approval ${String(request.approval_id)} never resolved`);
    }
    state.report.approvals += approvalsSeen.length;

    const end = events.find((e) => e.type === "run_end");
    check(end !== undefined, "server-work: no run_end event");
    check(end?.status === "completed", `server-work: run_end status ${String(end?.status)}`);
    const usage = isRecord(end?.usage)
      ? (end.usage as unknown as UsageTotals)
      : { model_calls: 0, input_tokens: 0, output_tokens: 0, cached_tokens: 0 };

    const kinds = envelopeKinds(events);
    assertCooperationShape(kinds, "delegation", "deliverable", "server-work");

    // the junior's write landed on disk, approved through the HTTP broker
    const target = path.join(workspaceRoot, "calc.js");
    check(fs.existsSync(target), "server-work: calc.js not created in the workspace");
    const content = fs.readFileSync(target, "utf-8");
    check(content.includes("add"), "server-work: calc.js lacks the add function");
    check(content.includes("//") || content.includes("/*"), "server-work: calc.js lacks the comment");

    const sessionFile = path.join(srv.dir, session);
    assertSessionFile(state, "server-work", sessionFile);

    return {
      detail:
        `${kinds.length} envelopes over SSE (${kinds.join(" -> ")}), ${approvalsSeen.length} approvals ` +
        `(${approvalsSeen.map((a) => String(a.action)).join(",")}) requested+resolved over HTTP, ` +
        `calc.js verified on disk (${content.length} chars)`,
      sessionFile,
      evidenceFile,
      usage,
      approvals: approvalsSeen.length,
    };
  } finally {
    await srv.close();
  }
}

class SkipSuite extends Error {}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

/** Suites that need a live model endpoint (gated by resolveEndpoint). */
const LIVE_SUITES: Array<{ name: string; run: (state: SuiteState) => Promise<SuiteEvidence> }> = [
  { name: "connection", run: suiteConnection },
  { name: "consult", run: suiteConsult },
  { name: "work", run: suiteWork },
  { name: "resume", run: suiteResume },
  { name: "connection-server", run: suiteConnectionServer },
  { name: "server-consult", run: suiteServerConsult },
  { name: "server-work-approvals", run: suiteServerWorkApprovals },
];

async function main(): Promise<number> {
  fs.mkdirSync(RUNS_DIR, { recursive: true });
  const report: RunReport = {
    generatedAt: new Date().toISOString(),
    dist: DIST,
    node: process.version,
    baseUrl: "",
    models: { senior: SENIOR_MODEL, junior: JUNIOR_MODEL },
    suites: [],
    approvals: 0,
    quirks: [],
  };
  const state: SuiteState = {
    endpoint: { baseUrl: "", modelIds: [] },
    report,
    rawReplies: [],
    quirks: new Set(),
  };

  const endpoint = await resolveEndpoint();
  let liveEndpoint: Endpoint | null = null;
  if ("skip" in endpoint) {
    log(`E2E SKIP: ${endpoint.skip}`);
    log("(real-model suites not run; the hermetic server-status suites still run)");
    report.suites.push({
      name: "connection",
      status: "SKIP",
      durationMs: 0,
      detail: endpoint.skip,
    });
  } else {
    liveEndpoint = endpoint;
    state.endpoint = endpoint;
    report.baseUrl = endpoint.baseUrl;
    log(
      `E2E: endpoint ${endpoint.baseUrl} (dist=${DIST}), models: ` +
        `${SENIOR_MODEL} (senior), ${JUNIOR_MODEL} (junior)`,
    );
  }

  // Hermetic status-contract suites always run (mock providers, in-process
  // server, temp dirs). The `-live` copies cover the same contract against
  // the real models when the endpoint is reachable. The prompt-audit suite
  // rides the same rail: hermetic, no endpoint needed.
  const statusSuites = [
    ...buildStatusSuites({
      api,
      runsDir: RUNS_DIR,
      ...(liveEndpoint !== null
        ? { live: { baseUrl: liveEndpoint.baseUrl, seniorModel: SENIOR_MODEL, juniorModel: JUNIOR_MODEL } }
        : {}),
    }),
    ...buildPromptAuditSuites({ api, runsDir: RUNS_DIR }),
  ].map((suite) => ({ name: suite.name, run: async (): Promise<SuiteEvidence> => suite.run() }));

  const allSuites: Array<{ name: string; run: (state: SuiteState) => Promise<SuiteEvidence> }> =
    liveEndpoint !== null
      ? [LIVE_SUITES[0], ...statusSuites, ...LIVE_SUITES.slice(1)]
      : statusSuites;

  let failures = 0;
  const only = process.env.TWO_BROTHERS_E2E_ONLY?.trim();
  const suites = only ? allSuites.filter((s) => s.name.includes(only)) : allSuites;
  if (suites.length === 0) {
    log(`E2E SKIP: no suite matches TWO_BROTHERS_E2E_ONLY=${only}`);
    return 0;
  }
  for (const suite of suites) {
    const started = Date.now();
    let record: SuiteRecord;
    try {
      const evidence = await suite.run(state);
      record = {
        name: suite.name,
        status: "PASS",
        durationMs: Date.now() - started,
        ...evidence,
      };
    } catch (exc) {
      if (exc instanceof SkipSuite || exc instanceof StatusSuiteSkip) {
        record = {
          name: suite.name,
          status: "SKIP",
          durationMs: Date.now() - started,
          detail: exc.message,
        };
      } else {
        failures += 1;
        record = {
          name: suite.name,
          status: "FAIL",
          durationMs: Date.now() - started,
          detail: exc instanceof Error ? exc.message : String(exc),
        };
      }
    }
    report.suites.push(record);
    log(
      `  ${record.status.padEnd(4)} ${record.name} (${(record.durationMs / 1000).toFixed(1)}s) — ${record.detail}`,
    );
  }

  report.quirks = [...state.quirks];
  const runStamp = stamp();
  fs.writeFileSync(
    path.join(RUNS_DIR, `report-${runStamp}.json`),
    JSON.stringify(report, null, 2),
  );
  fs.writeFileSync(
    path.join(RUNS_DIR, `raw-replies-${runStamp}.json`),
    JSON.stringify(state.rawReplies, null, 2),
  );

  log(`E2E: report -> ${path.relative(REPO_ROOT, path.join(RUNS_DIR, `report-${runStamp}.json`))}`);
  if (report.quirks.length > 0) {
    log("E2E: model-output quirks observed:");
    for (const quirk of report.quirks) log(`  - ${quirk}`);
  }
  log(failures === 0 ? "E2E: PASS" : `E2E: FAIL (${failures} suite(s) failed)`);
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
