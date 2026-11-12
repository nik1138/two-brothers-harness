/**
 * Runtime tests: RunManager lifecycle, worker pool, approval broker, sidecar
 * persistence, and settings masking. Ports the applicable parts of the
 * original prototype's runtime and parallel-run tests (removed 2026-11-04;
 * see git history) to node:test
 * (fake-clock-free; small real sleeps).
 *
 * Run with: node tests/run-all.ts (or node --test tests/)
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { Action, Decision, type ApprovalRequest } from "../src/permissions.ts";
import { DefaultSecretBox } from "../src/secretbox.ts";
import { SettingsStore } from "../src/settings_store.ts";
import { resolveConfig, type Config } from "../src/config.ts";
import { ACTIVE_STATES, RunManager, RuntimeSettings, type RunJob, type RunJobResult } from "../src/runtime.ts";
import { RuntimeEventStore, RunApprovalBroker } from "../src/runevents.ts";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(cond: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

function tmpdir(): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-runtime-"));
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function done(decision?: Record<string, unknown>): RunJobResult {
  return { cancelled: false, decision: decision ?? {}, errors: [] };
}

/**
 * Two-party barrier for concurrency tests: both jobs must be inside before
 * either proceeds. The timeout timer is cleared by `close()` so no floating
 * promise outlives the test.
 */
function barrier2(timeoutMs = 5000): {
  arrive: (name: string) => Promise<void>;
  close: () => void;
} {
  const entered: string[] = [];
  const waiters: Array<() => void> = [];
  let fireTimeout!: (reason: Error) => void;
  const timer = setTimeout(() => fireTimeout(new Error("barrier timed out")), timeoutMs);
  const timeout = new Promise<never>((_resolve, reject) => {
    fireTimeout = reject;
  });
  timeout.catch(() => undefined); // the race below handles the rejection
  return {
    async arrive(name: string): Promise<void> {
      entered.push(name);
      if (entered.length === 2) {
        waiters.splice(0).forEach((w) => w());
        return;
      }
      await Promise.race([
        new Promise<void>((resolve) => waiters.push(resolve)),
        timeout,
      ]);
    },
    close: () => clearTimeout(timer),
  };
}

/** A job that mimics a slow model call, honouring cooperative cancel. */
function slowJob(delayMs = 500): RunJob {
  return async (signal, onEnvelope) => {
    for (let i = 0; i < 20; i++) {
      if (signal.aborted) return { cancelled: true, decision: {}, errors: ["stopped"] };
      await sleep(delayMs / 20);
    }
    onEnvelope({ seq: 1, kind: "message" });
    return { cancelled: false, decision: { decision: "done" }, errors: [] };
  };
}

// ---------------------------------------------------------------------------
// RunManager lifecycle
// ---------------------------------------------------------------------------

test("run completes with typed events", async () => {
  const manager = new RunManager();
  const record = manager.submit("task", "s.jsonl", slowJob(50));
  assert.equal(await manager.wait(record.runId), true);
  assert.equal(record.status, "completed");
  assert.deepEqual(record.decision, { decision: "done" });
  const types = record.events.map((e) => e.type);
  assert.equal(types[0], "run_status");
  assert.equal((record.events[0] as { status: string }).status, "queued");
  assert.ok(types.includes("envelope"));
  assert.equal(types[types.length - 1], "run_end");
});

test("stop while running cancels", async () => {
  const manager = new RunManager();
  const record = manager.submit("task", "s.jsonl", slowJob(5000));
  await waitFor(() => record.status === "running", "running");
  const view = manager.stop(record.runId);
  assert.equal(view?.status, "running"); // stop is a request
  assert.equal(await manager.wait(record.runId), true);
  assert.equal(record.status, "cancelled");
});

test("stop while queued never starts", async () => {
  // single worker: the second run (different session) really queues,
  // because the default pool of 2 would start it concurrently
  const manager = new RunManager({ workers: 1 });
  const first = manager.submit("first", "a.jsonl", slowJob(1000));
  const second = manager.submit("second", "b.jsonl", slowJob(50));
  assert.equal(second.status, "queued");
  const view = manager.stop(second.runId);
  assert.equal(view?.status, "cancelled");
  assert.equal(await manager.wait(second.runId), true);
  assert.equal(await manager.wait(first.runId), true);
  // the worker eventually dequeues it and skips the body
  await waitFor(
    () => second.events.some((e) => e.type === "run_end"),
    "queued run_end",
  );
  assert.equal(second.status, "cancelled"); // worker skipped it
  assert.ok(!second.events.some((e) => e.type === "run_status" && (e as { status: string }).status === "running"));
  assert.equal(second.events[second.events.length - 1].type, "run_end");
});

test("failing job marks failed", async () => {
  const manager = new RunManager();
  const boom: RunJob = async () => {
    throw new Error("provider exploded");
  };
  const record = manager.submit("task", "s.jsonl", boom);
  assert.equal(await manager.wait(record.runId), true);
  assert.equal(record.status, "failed");
  assert.equal(record.error, "Error: provider exploded");
  assert.equal(record.events[record.events.length - 1].type, "run_end");
});

test("stop during in-flight call ends cancelled", async () => {
  // Stop lands while a (bounded) model call is in flight: when the call
  // errors out — the timeout path — the run must end `cancelled`, not
  // linger `running` nor misreport `failed`.
  const job: RunJob = async () => {
    await sleep(300); // in-flight window for the stop to land
    throw new Error("request timed out"); // the bounded call erroring out
  };
  const manager = new RunManager();
  const record = manager.submit("task", "s.jsonl", job);
  await waitFor(() => record.status === "running", "running");
  manager.stop(record.runId);
  assert.equal(await manager.wait(record.runId), true);
  assert.equal(record.status, "cancelled");
  assert.ok(record.error.includes("timed out"));
  const endStatuses = record.events
    .filter((e) => e.type === "run_end")
    .map((e) => (e as { status: string }).status);
  assert.deepEqual(endStatuses, ["cancelled"]);
});

test("unknown run", async () => {
  const manager = new RunManager();
  assert.equal(manager.get("nope"), null);
  assert.equal(manager.stop("nope"), null);
  assert.equal(await manager.wait("nope"), false);
});

test("run_end carries per-run usage", async () => {
  const manager = new RunManager();
  const job: RunJob = async () => ({
    cancelled: false,
    decision: {},
    errors: [],
    usage: { model_calls: 2, input_tokens: 10, output_tokens: 5, cached_tokens: 3 },
  });
  const record = manager.submit("task", "s.jsonl", job);
  assert.equal(await manager.wait(record.runId), true);
  assert.deepEqual(record.usage, {
    model_calls: 2,
    input_tokens: 10,
    output_tokens: 5,
    cached_tokens: 3,
    cache_write_tokens: 0,
  });
  const end = record.events[record.events.length - 1] as { type: string; usage: Record<string, number> };
  assert.equal(end.type, "run_end");
  assert.deepEqual(end.usage, record.usage);
});

test("a failed job keeps the partial usage attached to its error", async () => {
  const manager = new RunManager();
  const partial = {
    model_calls: 1,
    input_tokens: 11,
    output_tokens: 7,
    cached_tokens: 5,
  };
  const expected = { ...partial, cache_write_tokens: 0 };
  const job: RunJob = async () => {
    // The harness attaches `usage` to the non-abort error it rethrows after
    // successful provider calls; a job can do the same (a partial snapshot is
    // normalized, not rejected).
    const failure = new Error("provider failed after one call");
    Object.defineProperty(failure, "usage", { value: partial, configurable: true });
    throw failure;
  };
  const record = manager.submit("task", "s.jsonl", job);
  assert.equal(await manager.wait(record.runId), true);
  assert.equal(record.status, "failed");
  assert.equal(record.error, "Error: provider failed after one call");
  assert.deepEqual(record.usage, expected);
  assert.deepEqual(record.public().usage, expected);
  // the terminal event order and payload are unchanged apart from the usage
  const types = record.events.map((event) => event.type);
  assert.equal(types.at(-2), "run_error");
  assert.equal(types.at(-1), "run_end");
  const end = record.events.at(-1) as { type: string; status: string; usage: Record<string, number> };
  assert.equal(end.type, "run_end");
  assert.equal(end.status, "failed");
  assert.deepEqual(end.usage, expected);
});

test("a failed job without usage reports zeros, not invented numbers", async () => {
  const manager = new RunManager();
  const job: RunJob = async () => {
    throw new Error("failed before any provider call");
  };
  const record = manager.submit("task", "s.jsonl", job);
  assert.equal(await manager.wait(record.runId), true);
  assert.equal(record.status, "failed");
  assert.deepEqual(record.usage, {
    model_calls: 0,
    input_tokens: 0,
    output_tokens: 0,
    cached_tokens: 0,
    cache_write_tokens: 0,
  });
  const end = record.events.at(-1) as { type: string; usage: Record<string, number> };
  assert.equal(end.type, "run_end");
  assert.deepEqual(end.usage, record.usage);
});

test("live usage event updates the record before run_end", async () => {
  const manager = new RunManager();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const live = {
    model_calls: 1,
    input_tokens: 100,
    output_tokens: 10,
    cached_tokens: 40,
    cache_write_tokens: 0,
  };
  const job: RunJob = async (_signal, onEnvelope) => {
    onEnvelope({ type: "usage", usage: live });
    await gate;
    return { cancelled: false, decision: {}, errors: [], usage: live };
  };
  const record = manager.submit("task", "s.jsonl", job);
  await waitFor(() => record.usage.cached_tokens === 40, "live usage on the record");
  assert.deepEqual(record.usage, live);
  // The event is on the stream (and sidecar projection) before the terminal end.
  const frames = record.events.filter((event) => event.type === "usage");
  assert.equal(frames.length, 1);
  assert.equal(record.events.at(-1)?.type, "usage");
  release();
  assert.equal(await manager.wait(record.runId), true);
  assert.equal(record.events.at(-1)?.type, "run_end");
});

test("active/terminal state sets cover the lifecycle", () => {
  assert.ok(ACTIVE_STATES.has("queued") && ACTIVE_STATES.has("running") && ACTIVE_STATES.has("waiting"));
  for (const terminal of ["completed", "failed", "cancelled"]) {
    assert.ok(!ACTIVE_STATES.has(terminal));
  }
});

// ---------------------------------------------------------------------------
// Typed runtime events + persist hook
// ---------------------------------------------------------------------------

test("typed runtime events pass through unwrapped", async () => {
  const manager = new RunManager();
  const job: RunJob = async (_signal, onEnvelope) => {
    onEnvelope({ type: "tool_completed", tool: "workspace_write_file", status: "ok" });
    onEnvelope({ seq: 1, kind: "message", from: "user", to: "senior", payload: {} });
    return done();
  };
  const record = manager.submit("task", "s.jsonl", job);
  assert.equal(await manager.wait(record.runId), true);
  const typed = record.events.filter((e) => e.type === "tool_completed") as unknown as Array<Record<string, unknown>>;
  const wrapped = record.events.filter((e) => e.type === "envelope") as unknown as Array<Record<string, unknown>>;
  assert.equal(typed[0].tool, "workspace_write_file");
  assert.ok(!("envelope" in typed[0]));
  assert.equal((wrapped[0].envelope as { kind: string }).kind, "message");
  assert.ok(record.events.every((e) => (e as { run_id?: string }).run_id === record.runId));
  assert.ok(record.events.every((e) => typeof (e as { at?: number }).at === "number"));
});

test("persist hook receives every event", async () => {
  const persisted: Array<[string, Record<string, unknown>]> = [];
  const manager = new RunManager({
    persist: (session, event) => persisted.push([session, event as unknown as Record<string, unknown>]),
  });
  const record = manager.submit("task", "chat.jsonl", slowJob(50));
  assert.equal(await manager.wait(record.runId), true);
  assert.ok(persisted.length > 0);
  assert.ok(persisted.every(([session]) => session === "chat.jsonl"));
  const types = new Set(persisted.map(([, event]) => event.type));
  assert.ok(types.has("run_status"));
  assert.ok(types.has("run_end"));
});

test("a failing persist sink never breaks a run", async () => {
  const manager = new RunManager({
    persist: () => {
      throw new Error("disk full");
    },
  });
  const record = manager.submit("task", "s.jsonl", slowJob(20));
  assert.equal(await manager.wait(record.runId), true);
  assert.equal(record.status, "completed");
});

// ---------------------------------------------------------------------------
// Worker pool: concurrency + same-session serialization
// ---------------------------------------------------------------------------

test("different sessions run concurrently", async () => {
  // Both runs must be inside their jobs at the same time (wall-clock
  // overlap), which is impossible on a single worker.
  const manager = new RunManager({ workers: 2 });
  const barrier = barrier2();
  const windows: Record<string, [number, number]> = {};

  const make = (name: string): RunJob => {
    return async () => {
      const start = performance.now(); // fine-grained, unlike Date.now()
      await barrier.arrive(name);
      windows[name] = [start, performance.now()];
      return done({ ok: name });
    };
  };

  const a = manager.submit("a", "a.jsonl", make("a"));
  const b = manager.submit("b", "b.jsonl", make("b"));
  assert.equal(await manager.wait(a.runId), true);
  assert.equal(await manager.wait(b.runId), true);
  barrier.close();
  assert.deepEqual([a.status, b.status], ["completed", "completed"]);
  // the execution windows genuinely overlap
  assert.ok(windows.a[0] < windows.b[1]);
  assert.ok(windows.b[0] < windows.a[1]);
});

test("same-session runs serialize", async () => {
  // The second run on one session starts only after the first ends,
  // even with a free worker slot.
  const manager = new RunManager({ workers: 2 });
  const order: string[] = [];

  const job1: RunJob = async () => {
    order.push("start1");
    await sleep(200);
    order.push("end1");
    return done({ n: 1 });
  };
  const job2: RunJob = async () => {
    order.push("start2");
    return done({ n: 2 });
  };

  const a = manager.submit("first", "s.jsonl", job1);
  const b = manager.submit("second", "s.jsonl", job2);
  await waitFor(() => a.status === "running", "a running");
  // the session is taken: the second run waits although a slot is free
  assert.equal(b.status, "queued");
  assert.equal(await manager.wait(a.runId), true);
  assert.equal(await manager.wait(b.runId), true);
  assert.deepEqual(order, ["start1", "end1", "start2"]);
  assert.ok(b.started >= a.finished);
  assert.deepEqual(b.decision, { n: 2 });
});

test("worker pool dispatches FIFO across sessions", async () => {
  // One worker, three different sessions: completion order is submit order.
  const manager = new RunManager({ workers: 1 });
  const finished: string[] = [];
  const make = (name: string): RunJob => {
    return async () => {
      await sleep(30);
      finished.push(name);
      return done({ name });
    };
  };
  const records = [
    manager.submit("one", "1.jsonl", make("one")),
    manager.submit("two", "2.jsonl", make("two")),
    manager.submit("three", "3.jsonl", make("three")),
  ];
  assert.equal(records[1].status, "queued");
  assert.equal(records[2].status, "queued");
  for (const record of records) {
    assert.equal(await manager.wait(record.runId), true);
  }
  assert.deepEqual(finished, ["one", "two", "three"]);
});

test("stop one run does not affect others", async () => {
  // Stopping run A cancels only A: the running B completes and the
  // queued C (pool saturated) still executes afterwards.
  const manager = new RunManager({ workers: 2 });

  const longJob: RunJob = async (signal) => {
    for (let i = 0; i < 500; i++) {
      if (signal.aborted) return { cancelled: true, decision: {}, errors: [] };
      await sleep(10);
    }
    return done({ ok: "long" });
  };
  const shortJob: RunJob = async () => done({ ok: "short" });

  const a = manager.submit("a", "a.jsonl", longJob);
  const b = manager.submit("b", "b.jsonl", longJob);
  const c = manager.submit("c", "c.jsonl", shortJob);
  await waitFor(() => a.status === "running" && b.status === "running", "a and b running");
  assert.equal(c.status, "queued"); // pool full: backpressure, no rejection

  manager.stop(a.runId);
  assert.equal(await manager.wait(a.runId), true);
  assert.equal(a.status, "cancelled");
  // B never noticed: it completes on its own
  assert.equal(await manager.wait(b.runId, 15000), true);
  assert.equal(b.status, "completed");
  // C is dispatched once a slot frees and runs to completion
  assert.equal(await manager.wait(c.runId), true);
  assert.equal(c.status, "completed");
  assert.deepEqual(c.decision, { ok: "short" });
});

test("workers config: default, explicit, clamped, env fallback", () => {
  // explicit
  assert.equal((new RunManager({ workers: 5 }) as unknown as { _workers: number })._workers, 5);
  // clamped (Python parity: max(1, workers))
  assert.equal((new RunManager({ workers: 0 }) as unknown as { _workers: number })._workers, 1);
  assert.equal((new RunManager({ workers: -3 }) as unknown as { _workers: number })._workers, 1);
  // env fallback
  const old = process.env.TWO_BROTHERS_WORKERS;
  process.env.TWO_BROTHERS_WORKERS = "3";
  try {
    assert.equal((new RunManager() as unknown as { _workers: number })._workers, 3);
  } finally {
    if (old === undefined) delete process.env.TWO_BROTHERS_WORKERS;
    else process.env.TWO_BROTHERS_WORKERS = old;
  }
  // env value clamps too
  process.env.TWO_BROTHERS_WORKERS = "0";
  try {
    assert.equal((new RunManager() as unknown as { _workers: number })._workers, 1);
  } finally {
    if (old === undefined) delete process.env.TWO_BROTHERS_WORKERS;
    else process.env.TWO_BROTHERS_WORKERS = old;
  }
  // garbage env falls back to the default of 2
  process.env.TWO_BROTHERS_WORKERS = "junk";
  try {
    assert.equal((new RunManager() as unknown as { _workers: number })._workers, 2);
  } finally {
    if (old === undefined) delete process.env.TWO_BROTHERS_WORKERS;
    else process.env.TWO_BROTHERS_WORKERS = old;
  }
});

// ---------------------------------------------------------------------------
// Approval broker: operator answers, deny-on-stop
// ---------------------------------------------------------------------------

function writeRequest(target = "a.txt"): ApprovalRequest {
  return { action: Action.WRITE, target };
}

test("stop denies pending approval waits", async () => {
  const manager = new RunManager();
  const broker = new RunApprovalBroker();
  const verdicts: string[] = [];

  const job: RunJob = async (signal, onEnvelope) => {
    broker.attach(onEnvelope, signal);
    const decision = await broker.approve(writeRequest());
    verdicts.push(decision);
    return { cancelled: signal.aborted, decision: {}, errors: [] };
  };

  const record = manager.submit("task", "s.jsonl", job);
  // wait until the run is parked on the approval, then stop it
  await waitFor(() => broker.pending().length > 0, "approval pending");
  assert.equal(record.status, "waiting");
  manager.stop(record.runId);
  assert.equal(await manager.wait(record.runId), true);
  assert.deepEqual(verdicts, [Decision.DENY]); // no unapproved mutation path
  assert.equal(record.status, "cancelled");
  const resolved = record.events.filter((e) => e.type === "approval_resolved") as unknown as Array<Record<string, unknown>>;
  assert.equal(resolved[resolved.length - 1].decision, "deny");
});

test("operator respond() allows and the run continues", async () => {
  const manager = new RunManager();
  const broker = new RunApprovalBroker();
  const verdicts: string[] = [];

  const job: RunJob = async (signal, onEnvelope) => {
    broker.attach(onEnvelope, signal);
    verdicts.push(await broker.approve(writeRequest()));
    return { cancelled: false, decision: { ok: true }, errors: [] };
  };

  const record = manager.submit("task", "s.jsonl", job);
  await waitFor(() => broker.pending().length > 0, "approval pending");
  assert.equal(record.status, "waiting");
  const pending = broker.pending();
  assert.equal(pending[0].action, Action.WRITE);
  assert.equal(pending[0].target, "a.txt");
  assert.equal(broker.respond(String(pending[0].approval_id), Decision.ALLOW), Decision.ALLOW);
  assert.equal(await manager.wait(record.runId), true);
  assert.deepEqual(verdicts, [Decision.ALLOW]);
  assert.equal(record.status, "completed");
  // the approval park rides on run_status too: waiting when the request
  // parks the run, back to running once the operator answers
  const statuses = record.events.filter((e) => e.type === "run_status") as unknown as Array<Record<string, unknown>>;
  assert.deepEqual(statuses.map((e) => e.status), ["queued", "running", "waiting", "running"]);
  const resolved = record.events.filter((e) => e.type === "approval_resolved") as unknown as Array<Record<string, unknown>>;
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].decision, "allow");
  assert.ok(!("reason" in resolved[0]));
});

test("respond() is single-shot; unknown ids answer null", async () => {
  const broker = new RunApprovalBroker();
  const job: RunJob = async (signal) => {
    broker.attach(null, signal);
    return { cancelled: false, decision: {}, errors: [] };
  };
  // drive the broker directly through approve() without a manager
  const approval = broker.approve(writeRequest());
  const pending = broker.pending();
  const id = String(pending[0].approval_id);
  assert.equal(broker.respond(id, Decision.DENY), Decision.DENY);
  assert.equal(broker.respond(id, Decision.ALLOW), null); // already answered
  assert.equal(broker.respond("nope", Decision.ALLOW), null); // unknown
  assert.equal(await approval, Decision.DENY);
  assert.deepEqual(broker.pending(), []);
  void job;
});

test("denyAll emits one resolution per pending wait", async () => {
  const broker = new RunApprovalBroker();
  const emitted: Array<Record<string, unknown>> = [];
  broker.attach((event) => emitted.push(event as unknown as Record<string, unknown>), null);
  const waits = [broker.approve(writeRequest("1.txt")), broker.approve(writeRequest("2.txt"))];
  assert.equal(broker.pending().length, 2);
  assert.equal(broker.denyAll("cancelled"), 2);
  assert.deepEqual(await Promise.all(waits), [Decision.DENY, Decision.DENY]);
  const resolved = emitted.filter((e) => e.type === "approval_resolved");
  assert.equal(resolved.length, 2);
  assert.ok(resolved.every((e) => e.decision === "deny" && e.reason === "cancelled"));
  assert.equal(broker.denyAll(), 0);
});

test("approval brokers are independent across concurrent runs", async () => {
  const manager = new RunManager({ workers: 2 });
  const brokers: Record<string, RunApprovalBroker> = {};
  const verdicts: Record<string, string> = {};
  const barrier = barrier2();

  const make = (name: string): RunJob => {
    const broker = new RunApprovalBroker();
    brokers[name] = broker;
    return async (signal, onEnvelope) => {
      broker.attach(onEnvelope, signal);
      await barrier.arrive(name); // both runs parked at their approvals
      verdicts[name] = await broker.approve({ action: Action.WRITE, target: `${name}.txt` });
      return { cancelled: signal.aborted, decision: {}, errors: [] };
    };
  };

  const a = manager.submit("a", "a.jsonl", make("a"));
  const b = manager.submit("b", "b.jsonl", make("b"));
  manager.get(a.runId)!.approvals = brokers.a;
  manager.get(b.runId)!.approvals = brokers.b;

  await waitFor(() => brokers.a.pending().length > 0 && brokers.b.pending().length > 0, "both pending");

  // answer only A's approval
  const approvalId = String(brokers.a.pending()[0].approval_id);
  assert.equal(brokers.a.respond(approvalId, Decision.ALLOW), Decision.ALLOW);
  assert.equal(await manager.wait(a.runId), true);
  barrier.close();
  assert.deepEqual({ ...verdicts }, { a: "allow" }); // B is still parked
  assert.ok(brokers.b.pending().length > 0);
  assert.equal(manager.get(b.runId)!.status, "waiting");

  // stopping B denies B's pending approval; A is untouched
  manager.stop(b.runId);
  assert.equal(await manager.wait(b.runId), true);
  assert.equal(verdicts.b, "deny");
  assert.equal(a.status, "completed");
  assert.equal(b.status, "cancelled");
});

test("broker approve() after stop resolves deny immediately", async () => {
  // A stop that lands before the tool even reaches the broker must still
  // deny (the abort signal is already set when approve() runs).
  const broker = new RunApprovalBroker();
  const controller = new AbortController();
  const emitted: Array<Record<string, unknown>> = [];
  broker.attach((event) => emitted.push(event as unknown as Record<string, unknown>), controller.signal);
  controller.abort();
  assert.equal(await broker.approve(writeRequest()), Decision.DENY);
  const resolved = emitted.filter((e) => e.type === "approval_resolved");
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].decision, "deny");
  assert.equal(resolved[0].reason, "cancelled");
});

test("RunApprovalBroker plugs into PermissionManager", async () => {
  // The manager-side integration: mutations fail closed without a broker,
  // and are gated by the run broker when one is registered.
  const { PermissionManager } = await import("../src/permissions.ts");
  const noBroker = new PermissionManager();
  assert.equal(await noBroker.check(writeRequest()), Decision.DENY);

  const broker = new RunApprovalBroker();
  const controller = new AbortController();
  broker.attach(null, controller.signal);
  const gated = new PermissionManager(null, broker);
  const waitDecision = gated.check(writeRequest());
  await waitFor(() => broker.pending().length > 0, "pending via PermissionManager");
  broker.respond(String(broker.pending()[0].approval_id), Decision.ALLOW);
  assert.equal(await waitDecision, Decision.ALLOW);
});

// ---------------------------------------------------------------------------
// RuntimeEventStore sidecar
// ---------------------------------------------------------------------------

test("sidecar roundtrip, torn last line, traversal safety", () => {
  const { root, cleanup } = tmpdir();
  try {
    const store = new RuntimeEventStore(root);
    assert.deepEqual(store.load("s.jsonl"), []);
    store.append("s.jsonl", { type: "tool_completed", status: "ok" });
    store.append("s.jsonl", { type: "run_end", status: "completed" });
    const got = store.load("s.jsonl");
    assert.deepEqual(
      got.map((e) => e.type),
      ["tool_completed", "run_end"],
    );
    // a torn last line (mid-write crash) is tolerated
    fs.appendFileSync(path.join(root, "s.jsonl.events.jsonl"), '{"type": "tool_start', "utf-8");
    assert.equal(store.load("s.jsonl").length, 2);
    // path traversal is flattened
    assert.equal(store.exists("../escape"), false);
    store.append("../escape", { type: "x" });
    assert.ok(fs.existsSync(path.join(root, "escape.events.jsonl")));
    assert.ok(!fs.existsSync(path.join(path.dirname(root), "escape.events.jsonl")));
    // delete
    assert.equal(store.delete("s.jsonl"), true);
    assert.equal(store.delete("s.jsonl"), false);
    assert.deepEqual(store.load("s.jsonl"), []);
  } finally {
    cleanup();
  }
});

test("manager events flow to the sidecar via asPersist()", async () => {
  const { root, cleanup } = tmpdir();
  try {
    const store = new RuntimeEventStore(path.join(root, "runtime"));
    const manager = new RunManager({ persist: store.asPersist() });
    const record = manager.submit("task", "chat.jsonl", slowJob(30));
    assert.equal(await manager.wait(record.runId), true);
    assert.ok(store.exists("chat.jsonl"));
    const events = store.load("chat.jsonl");
    assert.deepEqual(events[0].type, "run_status");
    assert.deepEqual(events[events.length - 1].type, "run_end");
    assert.ok(events.every((e) => e.run_id === record.runId));
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// RuntimeSettings
// ---------------------------------------------------------------------------

test("public() never contains the api key", () => {
  const settings = new RuntimeSettings();
  settings.update({ senior: { api_key: "top-secret", model: "m1" } });
  const publicView = settings.public();
  assert.equal(publicView.senior.api_key_set, true);
  assert.ok(!JSON.stringify(publicView).includes("top-secret"));
  assert.equal(publicView.junior.api_key_set, false);
  // snapshot() is the persistence input and DOES carry the key
  assert.equal(settings.snapshot().senior.api_key, "top-secret");
});

test("apply() overlays only set fields", () => {
  const settings = new RuntimeSettings();
  settings.update({ senior: { model: "senior-model", api_key: "k" } });
  const cfg: Config = resolveConfig({ provider: "mock", seniorModel: "default-senior" });
  const originalJunior = cfg.juniorModel;
  settings.apply(cfg, true);
  assert.equal(cfg.seniorModel, "senior-model");
  assert.equal(cfg.juniorModel, originalJunior); // untouched
  assert.equal(cfg.apiKey, "k");
  assert.equal(cfg.provider, "mock"); // provider untouched when unset
});

test("apply() provider respects the allow flag", () => {
  const settings = new RuntimeSettings();
  settings.update({ senior: { provider: "openai" } });
  const cfg = resolveConfig({ provider: "mock" });
  settings.apply(cfg, false);
  assert.equal(cfg.provider, "mock");
  settings.apply(cfg, true);
  assert.equal(cfg.provider, "openai");
});

test("apply() overlays connection settings senior first, junior last", () => {
  const settings = new RuntimeSettings();
  settings.update({
    senior: { provider: "openai", base_url: "http://senior", api_key: "s" },
    junior: { provider: "mock", base_url: "http://junior", api_key: "j" },
  });
  const cfg = resolveConfig({ provider: "openai" });
  settings.apply(cfg);
  // The TS Config shares one provider/baseUrl/apiKey across roles; the
  // junior role is overlaid last, matching Python's loop order.
  assert.equal(cfg.provider, "mock");
  assert.equal(cfg.baseUrl, "http://junior");
  assert.equal(cfg.apiKey, "j");
  assert.equal(settings.snapshot().senior.api_key, "s");
  assert.equal(settings.snapshot().senior.base_url, "http://senior");
});

test("invalid provider rejected on update", () => {
  const settings = new RuntimeSettings();
  assert.throws(() => settings.update({ senior: { provider: "bad" } }), /invalid provider/);
});

test("RuntimeSettings hydrates from and writes through a SettingsStore", () => {
  const { root, cleanup } = tmpdir();
  try {
    const file = path.join(root, "settings.json");
    const box = new DefaultSecretBox({ dpapi: null }); // plain1: — no DPAPI spawn
    const store = new SettingsStore(file, box);
    const first = new RuntimeSettings(store);
    first.update({ senior: { model: "m1", api_key: "secret-key" }, junior: { provider: "mock" } });
    // write-through: the key landed encrypted on disk
    const raw = fs.readFileSync(file, "utf-8");
    assert.ok(!raw.includes("secret-key"));

    // hydration: a fresh instance over the same file sees the values
    const second = new RuntimeSettings(store);
    const view = second.public();
    assert.equal(view.senior.model, "m1");
    assert.equal(view.senior.api_key_set, true);
    assert.equal(view.junior.provider, "mock");
    // and the key material is available in memory for apply()
    const cfg = resolveConfig({ provider: "openai" });
    second.apply(cfg);
    assert.equal(cfg.apiKey, "secret-key");
    assert.equal(cfg.provider, "mock");
  } finally {
    cleanup();
  }
});
