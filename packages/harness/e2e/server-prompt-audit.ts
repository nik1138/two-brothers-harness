/**
 * Hermetic E2E suite for the per-call prompt audit on the wire
 * (`prompt_audit` typed runtime events).
 *
 * Drives the real `node:http` server over real HTTP/SSE (in-process,
 * ephemeral port) with mock providers, a temp workspace and a temp sessions
 * dir, and asserts the audit stream end to end:
 *
 *   server-prompt-audit   one `prompt_audit` frame per provider call (count
 *                         equals `run_end.usage.model_calls`), in call order
 *                         (`senior/delegation`, `junior/deliverable` ×2 —
 *                         the tool round plus the final answer —,
 *                         `senior/verify`, `senior/review`,
 *                         `senior/decision`); each frame carries the audit
 *                         entry field for field (role, kind, sections, tools,
 *                         character lengths — never prompt bodies); the
 *                         junior audit precedes its call's tool round
 *                         (`prompt_audit` -> `tool_started` ->
 *                         `approval_requested/resolved` -> `tool_completed` ->
 *                         next `prompt_audit` -> `deliverable`), and the
 *                         verify/review/decision audits stay pinned to their
 *                         envelopes; the frames persist in the runtime
 *                         sidecar and replay over `?after=N`; the protocol
 *                         session file stays envelope-only.
 *
 * The suite is fully offline (mock providers, in-process server) and runs even
 * when no live endpoint is reachable. Runner integration: `e2e/run.ts`
 * registers it alongside the other server suites. The module is also directly
 * runnable:
 *
 *   node e2e/server-prompt-audit.ts                      # sources (type stripping)
 *   TWO_BROTHERS_E2E_DIST=1 node e2e/server-prompt-audit.ts   # built dist/
 *
 * Exit codes: 0 = every suite passed; 1 = at least one failed. Evidence (the
 * SSE event dump) is written under `e2e/runs/` (gitignored), matching the
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

const TASK = "Write the file audit.txt containing the text ok, then confirm it.";
const DELIVERABLE_TEXT = JSON.stringify({
  result: "the audit file is written",
  artifacts: ["audit.txt"],
  notes: "",
  confidence: 0.8,
});

/** The exact frames a work-mode mock run must produce, in order. */
const EXPECTED_AUDITS = [
  "senior/delegation",
  "junior/deliverable",
  "junior/deliverable",
  "senior/verify",
  "senior/review",
  "senior/decision",
];

/** Every `prompt_audit` frame key (the SSE `id:` is added by the reader). */
const AUDIT_KEYS = [
  "at",
  "kind",
  "role",
  "run_id",
  "sections",
  "systemChars",
  "tools",
  "type",
  "userChars",
];

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

async function httpJson(
  base: string,
  method: string,
  route: string,
  body?: unknown,
): Promise<HttpResult> {
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
 * Drive a run's SSE stream (`GET /api/runs/{id}/events`), invoking `onEvent`
 * for every frame as it arrives — approval answering happens mid-stream.
 * Resolves with all events once `run_end` arrives (the server closes the
 * stream); rejects on timeout.
 */
function driveRunSse(
  base: string,
  runId: string,
  onEvent: (event: SseEvent) => Promise<void> | void,
  timeoutMs: number,
  after = 0,
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
    const req = http.get(`${base}/api/runs/${runId}/events?after=${after}`, (res) => {
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
// server helpers
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
  providerOverrides?: { senior?: Provider; junior?: Provider },
): Promise<RunningApi> {
  const configFactory = (): Config => api.resolveConfig({ provider: "mock", mode: "work" });
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

async function registerWorkspace(base: string, root: string): Promise<string> {
  const res = await httpJson(base, "POST", "/api/workspaces", { path: root, name: "e2e-audit" });
  check(res.status === 201, `POST /api/workspaces -> HTTP ${res.status}: ${JSON.stringify(res.body)}`);
  const id = String((res.body as Record<string, unknown>).id ?? "");
  check(id.length > 0, "POST /api/workspaces returned no id");
  return id;
}

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

// ---------------------------------------------------------------------------
// server-prompt-audit
// ---------------------------------------------------------------------------

function auditLabel(event: SseEvent): string {
  return `${String(event.role)}/${String(event.kind)}`;
}

function isAudit(event: SseEvent, role: string, kind: string): boolean {
  return event.type === "prompt_audit" && event.role === role && event.kind === kind;
}

function kindIndex(events: SseEvent[], kind: string): number {
  return events.findIndex(
    (event) => event.type === "envelope" && (event.envelope as Record<string, unknown>)?.kind === kind,
  );
}

async function suitePromptAudit(api: Api, runsDir: string): Promise<PromptAuditSuiteOutcome> {
  const dir = mkTempDir("tb-e2e-audit-");
  const wsDir = mkTempDir("tb-e2e-audit-ws-");
  const where = "server-prompt-audit";
  const srv = await startServer(api, dir, {
    junior: new api.MockProvider([
      { tool: "workspace_write_file", args: { path: "audit.txt", content: "ok" } },
      { text: DELIVERABLE_TEXT },
    ]),
  });
  try {
    const workspaceId = await registerWorkspace(srv.base, wsDir);
    const submitted = await httpJson(srv.base, "POST", "/api/runs", {
      task: TASK,
      mode: "work",
      workspace_id: workspaceId,
      session: `prompt-audit-${stamp()}.jsonl`,
    });
    check(
      submitted.status === 202,
      `POST /api/runs -> HTTP ${submitted.status}: ${JSON.stringify(submitted.body)}`,
    );
    const runId = String((submitted.body as Record<string, unknown>).run_id ?? "");
    const session = String((submitted.body as Record<string, unknown>).session ?? "");
    check(runId.length > 0 && session.length > 0, "POST /api/runs returned no run_id/session");

    let approvals = 0;
    const events = await driveRunSse(
      srv.base,
      runId,
      async (event) => {
        if (event.type !== "approval_requested") return;
        approvals += 1;
        const answer = await httpJson(
          srv.base,
          "POST",
          `/api/runs/${runId}/approvals/${String(event.approval_id)}`,
          { allow: true },
        );
        check(
          answer.status === 200 && (answer.body as Record<string, unknown>).decision === "allow",
          `${where}: approval answer -> HTTP ${answer.status}: ${JSON.stringify(answer.body)}`,
        );
      },
      HERMETIC_TIMEOUT_MS,
    );
    check(approvals >= 1, `${where}: the run never parked on an approval`);

    const end = events[events.length - 1];
    check(end.type === "run_end", `${where}: last SSE frame is ${String(end.type)}`);
    check(end.status === "completed", `${where}: run_end status ${String(end.status)}`);
    const usage = isRecord(end.usage) ? (end.usage as unknown as UsageTotals) : null;
    check(usage !== null, `${where}: run_end carried no usage`);

    // -- one frame per provider call, in call order -------------------------
    const audits = events.filter((event) => event.type === "prompt_audit");
    check(
      audits.length === usage.model_calls,
      `${where}: ${audits.length} prompt_audit frames vs ${usage.model_calls} model calls`,
    );
    check(
      audits.map(auditLabel).join(",") === EXPECTED_AUDITS.join(","),
      `${where}: audit order ${audits.map(auditLabel).join(",")} (expected ${EXPECTED_AUDITS.join(",")})`,
    );
    for (const audit of audits) {
      check(audit.run_id === runId, `${where}: ${auditLabel(audit)} has run_id ${String(audit.run_id)}`);
      check(typeof audit.at === "number", `${where}: ${auditLabel(audit)} has no ` + "`at`");
      check(
        Array.isArray(audit.sections) && audit.sections.length >= 2 && audit.sections[0] === "base",
        `${where}: ${auditLabel(audit)} sections ${JSON.stringify(audit.sections)}`,
      );
      check(Array.isArray(audit.tools), `${where}: ${auditLabel(audit)} tools is not a list`);
      check(
        typeof audit.systemChars === "number" && audit.systemChars > 0,
        `${where}: ${auditLabel(audit)} systemChars ${String(audit.systemChars)}`,
      );
      check(
        typeof audit.userChars === "number" && audit.userChars > 0,
        `${where}: ${auditLabel(audit)} userChars ${String(audit.userChars)}`,
      );
      // names and lengths only: no prompt bodies ride the stream
      const keys = Object.keys(audit)
        .filter((key) => key !== "id")
        .sort();
      check(
        keys.join(",") === AUDIT_KEYS.join(","),
        `${where}: ${auditLabel(audit)} keys ${keys.join(",")} (expected ${AUDIT_KEYS.join(",")})`,
      );
    }

    // -- the audit precedes its call's tool round ---------------------------
    const delegationEnvelope = kindIndex(events, "delegation");
    const deliverableEnvelope = kindIndex(events, "deliverable");
    const reviewEnvelope = kindIndex(events, "review");
    const decisionEnvelope = kindIndex(events, "decision");
    check(
      delegationEnvelope >= 0 && deliverableEnvelope >= 0 && reviewEnvelope >= 0 && decisionEnvelope >= 0,
      `${where}: missing a cooperation envelope (${[
        delegationEnvelope,
        deliverableEnvelope,
        reviewEnvelope,
        decisionEnvelope,
      ].join(",")})`,
    );

    const delegationAudit = events.findIndex((event) => isAudit(event, "senior", "delegation"));
    const juniorAudits = events
      .map((event, index) => (isAudit(event, "junior", "deliverable") ? index : -1))
      .filter((index) => index >= 0);
    const verifyAudit = events.findIndex((event) => isAudit(event, "senior", "verify"));
    const reviewAudit = events.findIndex((event) => isAudit(event, "senior", "review"));
    const decisionAudit = events.findIndex((event) => isAudit(event, "senior", "decision"));
    check(
      juniorAudits.length === 2 && verifyAudit >= 0 && reviewAudit >= 0 && decisionAudit >= 0,
      `${where}: missing audit frames (${JSON.stringify({
        juniorAudits,
        verifyAudit,
        reviewAudit,
        decisionAudit,
      })})`,
    );
    const [juniorToolAudit, juniorAnswerAudit] = juniorAudits;

    const toolStarted = events.findIndex((event) => event.type === "tool_started");
    const approvalRequested = events.findIndex((event) => event.type === "approval_requested");
    const approvalResolved = events.findIndex((event) => event.type === "approval_resolved");
    const toolCompleted = events.findIndex((event) => event.type === "tool_completed");
    check(
      toolStarted >= 0 && approvalRequested >= 0 && approvalResolved >= 0 && toolCompleted >= 0,
      `${where}: missing tool/approval frames (${[
        toolStarted,
        approvalRequested,
        approvalResolved,
        toolCompleted,
      ].join(",")})`,
    );

    const toolStartedEvent = events[toolStarted];
    const toolName = String(toolStartedEvent.tool ?? "");
    const juniorToolAuditEvent = events[juniorToolAudit];
    check(
      delegationAudit >= 0 && delegationAudit < delegationEnvelope,
      `${where}: delegation audit (${delegationAudit}) does not precede its envelope (${delegationEnvelope})`,
    );
    check(
      juniorToolAudit > delegationEnvelope && juniorToolAudit < toolStarted,
      `${where}: junior audit (${juniorToolAudit}) does not precede its tool round (${toolStarted})`,
    );
    check(
      toolStarted > 0 && events[toolStarted - 1].type === "prompt_audit",
      `${where}: the frame before tool_started is ${String(events[toolStarted - 1]?.type)}`,
    );
    check(
      Array.isArray(juniorToolAuditEvent.tools) && juniorToolAuditEvent.tools.includes(toolName),
      `${where}: junior audit belt ${JSON.stringify(juniorToolAuditEvent.tools)} misses ${toolName}`,
    );
    check(
      toolStarted < approvalRequested && approvalRequested < approvalResolved && approvalResolved < toolCompleted,
      `${where}: tool round out of order (${toolStarted},${approvalRequested},${approvalResolved},${toolCompleted})`,
    );
    check(
      toolCompleted < juniorAnswerAudit && juniorAnswerAudit < deliverableEnvelope,
      `${where}: deliverable audit (${juniorAnswerAudit}) does not sit between the tool result (${toolCompleted}) ` +
        `and the deliverable envelope (${deliverableEnvelope})`,
    );
    check(
      deliverableEnvelope < verifyAudit && verifyAudit < reviewEnvelope,
      `${where}: verify audit (${verifyAudit}) does not sit between deliverable (${deliverableEnvelope}) ` +
        `and review (${reviewEnvelope})`,
    );
    const verifyAuditEvent = events[verifyAudit];
    check(
      Array.isArray(verifyAuditEvent.tools) &&
        verifyAuditEvent.tools.includes("workspace_read_file") &&
        !verifyAuditEvent.tools.includes("workspace_write_file"),
      `${where}: verify belt ${JSON.stringify(verifyAuditEvent.tools)} is not the read-only slice`,
    );
    check(
      reviewAudit > verifyAudit && reviewAudit < reviewEnvelope && reviewEnvelope < decisionAudit,
      `${where}: review/decision audits out of order (${reviewAudit},${reviewEnvelope},${decisionAudit})`,
    );
    check(
      decisionAudit < decisionEnvelope,
      `${where}: decision audit (${decisionAudit}) does not precede the decision envelope (${decisionEnvelope})`,
    );
    check(
      audits.every((audit) => typeof audit.id === "number" && audit.id > 0),
      `${where}: prompt_audit frames are missing SSE ids`,
    );

    // -- durability: sidecar + replay --------------------------------------
    const sidecar = path.join(dir, "runtime", `${session}.events.jsonl`);
    check(fs.existsSync(sidecar), `${where}: runtime sidecar missing: ${sidecar}`);
    const persisted = readJsonl(sidecar).filter(
      (event) => event.type === "prompt_audit" && event.run_id === runId,
    );
    check(
      persisted.length === audits.length,
      `${where}: sidecar has ${persisted.length} prompt_audit frames (expected ${audits.length})`,
    );

    // The tail is not a fixed decision+run_end pair: `usage` is an additive
    // runtime event emitted once per state-machine node (including the final
    // decision), so a usage snapshot sits between the decision envelope and
    // `run_end`. Anchor the replay on the decision frame and assert the whole
    // persisted tail (decision -> … -> run_end) replays verbatim.
    const decisionFrame = events.findIndex(
      (event) =>
        event.type === "envelope" &&
        (event.envelope as Record<string, unknown>)?.kind === "decision",
    );
    check(decisionFrame >= 0, `${where}: no decision envelope in the stream`);
    const replayAfter = Number(events[decisionFrame].id ?? 0) - 1;
    const tail = events.slice(decisionFrame);
    const replay = await driveRunSse(srv.base, runId, () => undefined, HERMETIC_TIMEOUT_MS, replayAfter);
    check(
      replay.length === tail.length,
      `${where}: ?after=${replayAfter} replayed ${replay.length} frames (expected ${tail.length})`,
    );
    check(
      replay[0].type === "envelope" &&
        (replay[0].envelope as Record<string, unknown>)?.kind === "decision",
      `${where}: replay tail head is ${String(replay[0].type)}`,
    );
    check(replay[replay.length - 1].type === "run_end", `${where}: replay tail misses run_end`);

    // -- the protocol session file stays envelope-only ---------------------
    const sessionFile = path.join(dir, session);
    check(fs.existsSync(sessionFile), `${where}: session file missing: ${sessionFile}`);
    const envelopes = readJsonl(sessionFile) as unknown as Message[];
    check(
      envelopes.every((event) => !("type" in (event as unknown as Record<string, unknown>))),
      `${where}: a typed runtime event leaked into the protocol session file`,
    );
    check(
      envelopes.map((event) => event.kind).join(",") ===
        "message,delegation,deliverable,review,decision",
      `${where}: unexpected envelope kinds: ${envelopes.map((event) => event.kind).join(",")}`,
    );

    const evidenceFile = writeEvidence(runsDir, "server-prompt-audit-events", {
      run_id: runId,
      session,
      audits,
      events,
    });
    return {
      detail:
        `${audits.length} prompt_audit frames over SSE (${audits.map(auditLabel).join(" -> ")}), ` +
        `pinned around the tool round (audit -> tool -> approval -> tool result -> audit -> deliverable), ` +
        `persisted in the sidecar and replayable with ?after=`,
      evidenceFile,
    };
  } finally {
    await srv.close();
    rmDir(dir);
    rmDir(wsDir);
  }
}

// ---------------------------------------------------------------------------
// suite registry / standalone runner
// ---------------------------------------------------------------------------

export interface PromptAuditSuiteOutcome {
  detail: string;
  sessionFile?: string;
  evidenceFile?: string;
  usage?: UsageTotals;
}

export interface PromptAuditSuite {
  name: string;
  run: () => Promise<PromptAuditSuiteOutcome>;
}

export interface PromptAuditSuiteOptions {
  api: Api;
  runsDir: string;
}

/** Build the prompt-audit suites (hermetic only — mock providers, temp dirs). */
export function buildPromptAuditSuites(options: PromptAuditSuiteOptions): PromptAuditSuite[] {
  const { api, runsDir } = options;
  return [{ name: "server-prompt-audit", run: () => suitePromptAudit(api, runsDir) }];
}

async function main(): Promise<number> {
  const dist = process.env.TWO_BROTHERS_E2E_DIST === "1";
  const entry = new URL(dist ? "../dist/index.js" : "../src/index.ts", import.meta.url).href;
  const api = (await import(entry)) as unknown as Api;
  fs.mkdirSync(RUNS_DIR, { recursive: true });

  log(`E2E prompt audit: entry ${dist ? "dist" : "src"}, node ${process.version}`);
  const suites = buildPromptAuditSuites({ api, runsDir: RUNS_DIR });
  let failures = 0;
  for (const suite of suites) {
    const started = Date.now();
    try {
      const evidence = await suite.run();
      log(`  PASS ${suite.name} (${((Date.now() - started) / 1000).toFixed(1)}s) — ${evidence.detail}`);
    } catch (exc) {
      failures += 1;
      log(
        `  FAIL ${suite.name} (${((Date.now() - started) / 1000).toFixed(1)}s) — ` +
          `${exc instanceof Error ? exc.message : String(exc)}`,
      );
    }
  }
  log(failures === 0 ? "E2E prompt audit: PASS" : `E2E prompt audit: FAIL (${failures} suite(s) failed)`);
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