/**
 * Degraded-review visibility (owner decision B1).
 *
 * A review reply that fails the strict payload check AND its one repair re-ask
 * still degrades to `verdict: "accept"` through the tolerant boundary (fail-soft,
 * unchanged, never a thrown error). What this lane adds is a VISIBLE signal for
 * machine consumers, which otherwise only see the accept:
 *
 * - `HarnessResult.reviewDegraded` — optional, present only when the run's LAST
 *   review was degraded (a clean run's result shape stays byte-identical);
 * - one additive `review_degraded` typed runtime event per degraded review,
 *   `{type, round, verdict}` — the `steering_dropped` / `auto_route` shape, with
 *   the manager stamping `run_id`/`at` and the sidecar replay staying
 *   type-driven (no extra persistence code);
 * - the `review_degraded` key of the CLI `--json` / `--mode json` object and the
 *   additive `reviewDegraded` field of the `--stream` `result` NDJSON record;
 * - the pre-existing `unstructured model reply for review` entry (unchanged —
 *   exactly one, never a second warning).
 *
 * Everything here is hermetic: scripted fake providers, an in-process CLI with a
 * loopback `node:http` stub, temp directories. No network, no real endpoint.
 *
 * Run with: node tests/run-all.ts (or node --test tests/)
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { main as cliMain, type CliIO } from "../src/cli.ts";
import { resolveConfig } from "../src/config.ts";
import { SharedContext, type ChatMessage } from "../src/context.ts";
import { TwoBrothersHarness } from "../src/harness.ts";
import { REPAIR_REQUEST_PREFIX } from "../src/payloads.ts";
import type { Provider } from "../src/provider.ts";
import type { ReviewDegradedEvent, RuntimeEvent } from "../src/runevents.ts";
import { RuntimeEventStore } from "../src/runevents.ts";
import { RunManager, type RunJob } from "../src/runtime.ts";
import type { StreamEvent } from "../src/runstream.ts";
import { SessionStore } from "../src/session.ts";

const TASK = "Is this plan good enough to ship?";

const cfg = (mode = "consult") => resolveConfig({ provider: "mock", mode });

/** A reply that is not a usable review payload at all. */
const PROSE = "I read the proposal and I think it is broadly fine, let us proceed.";

/**
 * A reply that fails the strict review schema (a malformed `points`) while its
 * `verdict` still survives sanitize as `revise` — the shape that lets a degraded
 * review route into a revise cycle.
 */
const DEGRADED_REVISE = JSON.stringify({ verdict: "revise", points: "not-a-list" });

/** One strict-valid payload per structured kind (the scripted baseline). */
const VALID: Record<string, Record<string, unknown>> = {
  consult: { task: "t", ask: "a", expect: "proposal", deadline_hint: "today" },
  proposal: { title: "P", answer: "A", rationale: "R", risks: [], confidence: 0.7, asks: [] },
  delegation: { work: "W", acceptance: ["done"], return: "deliverable", notes: "" },
  deliverable: { result: "R", artifacts: [], notes: "", confidence: 0.8 },
  review: { verdict: "accept", notes: "", points: [] },
  decision: { decision: "D", rationale: "", confidence: 0.7, dissent: null, accepted_proposals: [] },
};

function validReply(kind: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...VALID[kind], ...extra });
}

interface Call {
  role: "senior" | "junior";
  kind: string;
  messages: ChatMessage[];
}

/**
 * Scripted text provider: one queue of replies per response kind; an empty
 * queue answers with the strict-valid payload for that kind, so a test only
 * scripts the calls it cares about. Every request is captured.
 */
class ScriptedProvider implements Provider {
  readonly calls: Call[] = [];
  private readonly replies: Record<string, string[]>;
  private readonly role: "senior" | "junior";

  constructor(role: "senior" | "junior", replies: Record<string, string[]> = {}) {
    this.role = role;
    this.replies = replies;
  }

  async chat(messages: ChatMessage[], responseKind = "message"): Promise<string> {
    this.calls.push({
      role: this.role,
      kind: responseKind,
      messages: messages.map((message) => ({ ...message })),
    });
    const queue = this.replies[responseKind];
    if (queue !== undefined && queue.length > 0) return queue.shift()!;
    return validReply(responseKind);
  }

  callsOf(kind: string): Call[] {
    return this.calls.filter((call) => call.kind === kind);
  }
}

function repairEnvelopes(messages: Array<{ payload: Record<string, unknown> }>): number {
  return messages.filter((message) =>
    String(message.payload.text ?? "").startsWith(REPAIR_REQUEST_PREFIX),
  ).length;
}

// ---------------------------------------------------------------------------
// the degraded review is visible (result field + event + existing warning)
// ---------------------------------------------------------------------------

test("degraded review: run completes, one review_degraded event, result flag, existing warning", async () => {
  // Both the original review reply AND the repair re-ask are unusable, so the
  // degradation path is the one under test.
  const senior = new ScriptedProvider("senior", { review: [PROSE, PROSE] });
  const junior = new ScriptedProvider("junior");
  const events: RuntimeEvent[] = [];
  const stream: StreamEvent[] = [];
  // One unified log, so the event/envelope publication order is observable.
  const log: Array<{ channel: "event" | "envelope"; type: string; text?: string }> = [];
  const harness = new TwoBrothersHarness(cfg(), {
    senior,
    junior,
    onEvent: (event) => {
      events.push(event);
      log.push({ channel: "event", type: event.type });
    },
    onEnvelope: (message) =>
      log.push({ channel: "envelope", type: message.kind, text: String(message.payload.text ?? "") }),
    onStreamEvent: (event) => stream.push(event),
  });
  const result = await harness.run(TASK);

  // The run still completes with a decision (the tolerant boundary never throws).
  assert.deepEqual(result.errors, ["unstructured model reply for review"], "the existing entry stays, exactly once");
  assert.deepEqual(result.warnings, [], "no second warning is added");
  assert.equal(result.decision.decision, "D");
  assert.equal(result.reviewDegraded, true);
  // Exactly one repair re-ask was spent on the review call.
  assert.equal(senior.callsOf("review").length, 2);
  assert.equal(repairEnvelopes(result.messages), 1);

  // Exactly one typed event, with the additive shape and no invented `at`.
  const degraded = events.filter(
    (event): event is ReviewDegradedEvent => event.type === "review_degraded",
  );
  assert.equal(degraded.length, 1);
  assert.deepEqual(
    { type: degraded[0].type, round: degraded[0].round, verdict: degraded[0].verdict },
    { type: "review_degraded", round: 0, verdict: "accept" },
  );
  assert.deepEqual(Object.keys(degraded[0]).sort(), ["round", "type", "verdict"]);

  // Emitted before the review envelope it explains (the auto_route ordering).
  const eventIndex = log.findIndex((entry) => entry.channel === "event" && entry.type === "review_degraded");
  const reviewIndex = log.findIndex((entry) => entry.channel === "envelope" && entry.type === "review");
  assert.ok(eventIndex >= 0 && reviewIndex > eventIndex);

  // The `--stream` terminal record carries the additive flag.
  const resultRecord = stream.find((event) => event.type === "result");
  assert.ok(resultRecord !== undefined && resultRecord.type === "result");
  assert.equal(resultRecord.result.reviewDegraded, true);
});

test("clean run: no reviewDegraded field, no event, unchanged --stream result record", async () => {
  const events: RuntimeEvent[] = [];
  const stream: StreamEvent[] = [];
  const harness = new TwoBrothersHarness(cfg(), {
    senior: new ScriptedProvider("senior"),
    junior: new ScriptedProvider("junior"),
    onEvent: (event) => events.push(event),
    onStreamEvent: (event) => stream.push(event),
  });
  const result = await harness.run(TASK);

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.reviewDegraded, undefined, "absent, not false — the key set is unchanged");
  assert.equal(Object.hasOwn(result, "reviewDegraded"), false);
  assert.ok(!events.some((event) => event.type === "review_degraded"));
  const resultRecord = stream.find((event) => event.type === "result");
  assert.ok(resultRecord !== undefined && resultRecord.type === "result");
  assert.equal(Object.hasOwn(resultRecord.result, "reviewDegraded"), false);
});

// ---------------------------------------------------------------------------
// the FINAL review decides the run's value (revise cycle: degraded, then clean)
// ---------------------------------------------------------------------------

test("degraded revise then clean accept: the final review wins (not degraded)", async () => {
  // Review 1 (round 0): unusable reply + unusable repair → degrades to
  // `revise`, which routes into a revise cycle. Review 2 (round 1): a clean
  // accept ends the run — the result reports THAT review.
  const senior = new ScriptedProvider("senior", {
    review: [DEGRADED_REVISE, DEGRADED_REVISE, validReply("review")],
  });
  const junior = new ScriptedProvider("junior");
  const events: RuntimeEvent[] = [];
  const harness = new TwoBrothersHarness(cfg(), {
    senior,
    junior,
    onEvent: (event) => events.push(event),
  });
  const result = await harness.run(TASK);

  assert.equal(result.rounds, 1, "the degraded revise verdict routed one revise cycle");
  assert.equal(senior.callsOf("review").length, 3, "review 1 + its repair + review 2");
  assert.equal(result.decision.decision, "D");
  assert.equal(result.reviewDegraded, undefined, "the final review was clean");
  assert.equal(Object.hasOwn(result, "reviewDegraded"), false);
  // The earlier degradation is still recorded (it happened), exactly once.
  const degraded = events.filter(
    (event): event is ReviewDegradedEvent => event.type === "review_degraded",
  );
  assert.equal(degraded.length, 1);
  assert.deepEqual(
    { round: degraded[0].round, verdict: degraded[0].verdict },
    { round: 0, verdict: "revise" },
  );
  // One warning entry for the one degraded review.
  assert.deepEqual(result.errors, ["unstructured model reply for review"]);
});

// ---------------------------------------------------------------------------
// only the REVIEW node is reported (a degraded consult is not a review signal)
// ---------------------------------------------------------------------------

test("degraded non-review node + clean review: no flag and no event", async () => {
  // The consult reply degrades (prose + prose repair); the review that follows
  // is clean. The degradation belongs to the consult node, so the run must NOT
  // claim a degraded review — the per-call seam is reset by the review node.
  const senior = new ScriptedProvider("senior", { consult: [PROSE, PROSE] });
  const junior = new ScriptedProvider("junior");
  const events: RuntimeEvent[] = [];
  const harness = new TwoBrothersHarness(cfg(), {
    senior,
    junior,
    onEvent: (event) => events.push(event),
  });
  const result = await harness.run(TASK);

  assert.deepEqual(result.errors, ["unstructured model reply for consult"]);
  assert.equal(senior.callsOf("review").length, 1, "the review itself was clean (no repair)");
  assert.equal(result.reviewDegraded, undefined);
  assert.equal(Object.hasOwn(result, "reviewDegraded"), false);
  assert.ok(!events.some((event) => event.type === "review_degraded"));
});

test("two degraded reviews in one run: one event each, the last one sets the flag", async () => {
  // Review 1 degrades to `revise` (→ a revise cycle), review 2 degrades to the
  // accept default and ends the run: every degraded review is reported live,
  // and the result field still describes the FINAL review.
  const senior = new ScriptedProvider("senior", {
    review: [DEGRADED_REVISE, DEGRADED_REVISE, PROSE, PROSE],
  });
  const junior = new ScriptedProvider("junior");
  const events: RuntimeEvent[] = [];
  const harness = new TwoBrothersHarness(cfg(), {
    senior,
    junior,
    onEvent: (event) => events.push(event),
  });
  const result = await harness.run(TASK);

  assert.equal(result.rounds, 1);
  assert.equal(senior.callsOf("review").length, 4, "review 1 + repair + review 2 + repair");
  assert.equal(repairEnvelopes(result.messages), 2);
  const degraded = events.filter(
    (event): event is ReviewDegradedEvent => event.type === "review_degraded",
  );
  assert.equal(degraded.length, 2, "both degraded reviews are reported");
  assert.deepEqual(
    degraded.map((event) => ({ round: event.round, verdict: event.verdict })),
    [
      { round: 0, verdict: "revise" },
      { round: 1, verdict: "accept" },
    ],
  );
  assert.equal(result.reviewDegraded, true, "the final review was degraded");
  assert.equal(
    result.errors.filter((error) => error === "unstructured model reply for review").length,
    2,
  );
});

// ---------------------------------------------------------------------------
// sidecar persistence: type-driven, no extra code (RunManager + event store)
// ---------------------------------------------------------------------------

test("review_degraded reaches the run sidecar with run_id/at and replays", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tb-review-degraded-"));
  try {
    const sessionName = "review-degraded-session.jsonl";
    const store = new SessionStore(path.join(tmp, sessionName));
    const ctx = new SharedContext(store);
    const sidecar = new RuntimeEventStore(path.join(tmp, "runtime"));
    const manager = new RunManager({ persist: sidecar.asPersist() });

    const job: RunJob = async (signal, onEnvelope) => {
      const harness = new TwoBrothersHarness(cfg(), {
        senior: new ScriptedProvider("senior", { review: [PROSE, PROSE] }),
        junior: new ScriptedProvider("junior"),
        signal,
        onEvent: (event) => onEnvelope(event),
        onEnvelope: (message) => onEnvelope(message),
      });
      const result = await harness.run(TASK, ctx);
      assert.equal(result.reviewDegraded, true);
      return {
        cancelled: result.cancelled,
        decision: result.decision,
        errors: result.errors,
        usage: result.usage,
      };
    };

    const record = manager.submit(TASK, sessionName, job, "consult");
    assert.equal(await manager.wait(record.runId), true);
    assert.equal(record.status, "completed");

    const persisted = sidecar
      .load(sessionName)
      .filter((event) => event.type === "review_degraded");
    assert.equal(persisted.length, 1, "the event is durable — no extra persistence code");
    assert.equal(persisted[0].run_id, record.runId, "the manager stamps the owning run");
    assert.equal(typeof persisted[0].at, "number");
    assert.equal(persisted[0].round, 0);
    assert.equal(persisted[0].verdict, "accept");
    // The same event reached the in-memory run record verbatim.
    assert.equal(
      record.events.filter((event) => event.type === "review_degraded").length,
      1,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// CLI machine output: --json / --mode json
// ---------------------------------------------------------------------------

function makeIO(): CliIO & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, log: (line) => out.push(line), error: (line) => err.push(line) };
}

interface RecordedRequest {
  body: any;
}

/**
 * A hermetic OpenAI-compatible stub on 127.0.0.1: every completion carries one
 * union payload that satisfies every node's strict schema (the sanctioned
 * cliergonomics trick), except the review requests while `degradeReview` is set,
 * which answer prose — the malformed review under test.
 */
async function startStub(): Promise<{
  url: string;
  degradeReview: { value: boolean };
  close(): Promise<void>;
}> {
  const degradeReview = { value: false };
  const requests: RecordedRequest[] = [];
  const payload = {
    text: "ok",
    task: "is this plan good enough?",
    ask: "what is best?",
    expect: "proposal",
    title: "Plan",
    answer: "Ship it",
    rationale: "because",
    risks: [],
    asks: [],
    confidence: 0.7,
    work: "do part",
    acceptance: ["done"],
    return: "deliverable",
    result: "done",
    artifacts: [],
    notes: "ok",
    verdict: "accept",
    points: [],
    decision: "Ship it",
    dissent: null,
    accepted_proposals: ["Plan"],
  };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      let body: any = undefined;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = raw;
      }
      requests.push({ body });
      const user = Array.isArray(body?.messages)
        ? String(
            [...body.messages].reverse().find((message: any) => message?.role === "user")?.content ?? "",
          )
        : "";
      const isReview = user.includes("Requested payload: review");
      const content =
        isReview && degradeReview.value ? PROSE : JSON.stringify(payload);
      res.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
      res.end(
        JSON.stringify({
          choices: [{ message: { content } }],
          usage: { prompt_tokens: 100, completion_tokens: 20 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    degradeReview,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

test("CLI --mode json: review_degraded only when the review degraded", async () => {
  const stub = await startStub();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tb-review-degraded-cli-"));
  const argv = [
    "run",
    "is this plan good enough?",
    "--provider",
    "openai",
    "--base-url",
    `${stub.url}/v1`,
    "--api-key",
    "sk-review-secret",
    "--senior-model",
    "gpt-4o",
    "--junior-model",
    "gpt-4o",
    "--sessions-dir",
    tmp,
    "--mode",
    "json",
  ];
  try {
    // Clean review: the machine object keeps its pre-feature key set.
    const clean = makeIO();
    assert.equal(await cliMain(argv, clean), 0, clean.err.join("\n"));
    assert.equal(clean.out.length, 1, clean.out.join("\n"));
    const cleanParsed = JSON.parse(clean.out[0]);
    assert.deepEqual(cleanParsed.errors, []);
    assert.equal(Object.hasOwn(cleanParsed, "review_degraded"), false);

    // Malformed review (original + repair both prose): the object carries the
    // key. The exit code is 1 because the pre-existing "unstructured model
    // reply for review" entry rides `errors` — unchanged by this lane.
    stub.degradeReview.value = true;
    const degraded = makeIO();
    assert.equal(await cliMain(argv, degraded), 1, degraded.err.join("\n"));
    assert.equal(degraded.out.length, 1, degraded.out.join("\n"));
    const degradedParsed = JSON.parse(degraded.out[0]);
    assert.equal(degradedParsed.review_degraded, true);
    assert.deepEqual(degradedParsed.errors, ["unstructured model reply for review"]);
    assert.equal(typeof degradedParsed.decision.decision, "string");
    // JSON mode prints `warnings` (not `errors`) to stderr, so the existing
    // entry appears exactly once — in the machine object — and no second
    // warning line was added.
    assert.equal(
      degraded.err.filter((line) => line.includes("unstructured model reply for review")).length,
      0,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    await stub.close();
  }
});
