/**
 * Bounded run-history tests: the RunManager keeps every active/queued/waiting
 * run plus at most MAX_TERMINAL_RUNS terminal records, evicting older terminal
 * records from its registry without touching their event objects, the session
 * JSONL, or the persisted runtime sidecar (evicted ids recover through the
 * sidecar scan exactly like ids unknown after a backend restart).
 *
 * Run with: node tests/run-all.ts (or node --test tests/)
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { MAX_TERMINAL_RUNS, RunManager, type RunJob, type RunRecord } from "../src/runtime.ts";
import { RuntimeEventStore } from "../src/runevents.ts";

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-runhist-"));
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

type Internals = {
  _records: Map<string, RunRecord>;
  _order: string[];
  _pending: RunRecord[];
};

function internals(manager: RunManager): Internals {
  return manager as unknown as Internals;
}

/** A job that finishes immediately with a couple of envelopes. */
function quickJob(envelopes = 2): RunJob {
  return async (_signal, onEnvelope) => {
    for (let i = 0; i < envelopes; i++) onEnvelope({ seq: i + 1, kind: "message" });
    return { cancelled: false, decision: { decision: "done" } };
  };
}

/** A job that stays running until the gate resolves (honouring stop). */
function gatedJob(gate: Promise<void>): RunJob {
  return async (signal) => {
    if (signal.aborted) return { cancelled: true, decision: {} };
    await Promise.race([
      gate,
      new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      ),
    ]);
    if (signal.aborted) return { cancelled: true, decision: {} };
    return { cancelled: false, decision: { decision: "done" } };
  };
}

function terminalCount(manager: RunManager): number {
  const TERMINAL = new Set(["completed", "failed", "cancelled"]);
  let count = 0;
  for (const record of internals(manager)._records.values()) {
    if (TERMINAL.has(record.status)) count += 1;
  }
  return count;
}

function totalRetainedEvents(manager: RunManager): number {
  let total = 0;
  for (const record of internals(manager)._records.values()) total += record.events.length;
  return total;
}

// ---------------------------------------------------------------------------
// bounded terminal-run retention
// ---------------------------------------------------------------------------

test("500 completed runs leave the registry bounded at MAX_TERMINAL_RUNS", async () => {
  const manager = new RunManager({ workers: 8 });
  const records = [];
  for (let i = 0; i < 500; i++) {
    records.push(manager.submit(`task ${i}`, `scale-${i}.jsonl`, quickJob()));
  }
  const outcomes = await Promise.all(records.map((record) => record.done));
  assert.ok(outcomes.every((finished) => finished === true));

  // The oldest runs were evicted from the registry; the retention bound and
  // the order/registry consistency hold exactly.
  assert.equal(terminalCount(manager), MAX_TERMINAL_RUNS);
  assert.equal(internals(manager)._records.size, MAX_TERMINAL_RUNS);
  assert.equal(internals(manager)._order.length, MAX_TERMINAL_RUNS);
  for (const runId of internals(manager)._order) {
    assert.ok(internals(manager)._records.has(runId), `order id ${runId} missing from registry`);
  }

  // list() stays crash-free and reports only retained runs.
  const listed = manager.list();
  assert.equal(listed.length, MAX_TERMINAL_RUNS);
  assert.ok(listed.every((record) => typeof record.status === "string"));

  // Every retained run carries exactly its 5 events (queued/running/2
  // envelopes/run_end), so the retained event memory is bounded too.
  const perRun = records[499].events.length;
  assert.equal(perRun, 5);
  assert.equal(totalRetainedEvents(manager), MAX_TERMINAL_RUNS * perRun);

  // The evicted earliest run is unknown to the manager but its terminal
  // promise had already resolved (nothing a waiter held is lost).
  assert.equal(manager.get(records[0].runId), null);
  assert.equal(await manager.wait(records[0].runId), false);
});

test("active runs and records held by open consumers survive eviction pressure", async () => {
  const manager = new RunManager({ workers: 2 });
  const gate = deferred<void>();

  const active = manager.submit("long", "active.jsonl", gatedJob(gate.promise));
  await waitFor(() => active.status === "running", "the gated run to start");

  // Fill the registry past the bound while the gated run works.
  const doneRuns = [];
  for (let i = 0; i < 150; i++) {
    doneRuns.push(manager.submit(`fill ${i}`, `fill-${i}.jsonl`, quickJob()));
  }
  await Promise.all(doneRuns.map((record) => record.done));

  // The active run is never a terminal record: it stays registered and
  // running even though hundreds of terminal records were pruned around it.
  const live = manager.get(active.runId);
  assert.notEqual(live, null);
  assert.equal(live!.status, "running");
  assert.ok(internals(manager)._order.includes(active.runId));

  // A consumer that captured an evicted record keeps a stable view: the
  // object and its event buffer are untouched by eviction (an open SSE
  // replay's `?after` cursor stays valid until the consumer disconnects).
  const evicted = doneRuns[0];
  assert.equal(manager.get(evicted.runId), null);
  const eventsHeld = evicted.events.length;
  for (let i = 0; i < 50; i++) {
    manager.submit(`more ${i}`, `more-${i}.jsonl`, quickJob());
  }
  assert.equal(evicted.events.length, eventsHeld);
  assert.equal(evicted.events.at(-1)?.type, "run_end");

  gate.resolve();
  assert.equal(await active.done, true);
  assert.equal(active.status, "completed");
});

test("evicted terminal records recover from the persisted sidecar", async () => {
  const { root, cleanup } = tmpdir();
  try {
    const store = new RuntimeEventStore(root);
    const manager = new RunManager({ workers: 8, persist: store.asPersist() });
    const records = [];
    for (let i = 0; i < MAX_TERMINAL_RUNS + 20; i++) {
      records.push(manager.submit(`task ${i}`, `persist-${i}.jsonl`, quickJob()));
    }
    await Promise.all(records.map((record) => record.done));

    const evicted = records[0];
    assert.equal(manager.get(evicted.runId), null);
    assert.equal(manager.stop(evicted.runId), null);
    assert.equal(await manager.wait(evicted.runId), false);

    // The durable half of the record survives eviction: the sidecar scan
    // rebuilds the run's events (the same seam GET /api/runs/{id} uses after
    // a backend restart).
    const found = store.findRun(evicted.runId);
    assert.notEqual(found, null);
    assert.equal(found!.session, "persist-0.jsonl");
    const end = [...found!.events].reverse().find((event) => event.type === "run_end");
    assert.notEqual(end, undefined);
    assert.equal(end!.status, "completed");
  } finally {
    cleanup();
  }
});

test("queued same-session runs are retained and stop stays correct under pressure", async () => {
  const manager = new RunManager({ workers: 2 });
  const gate = deferred<void>();

  // Worker 1 takes the gated run; the same-session quick run must queue
  // behind it no matter how many other sessions fill the pool.
  const first = manager.submit("gate", "shared.jsonl", gatedJob(gate.promise));
  await waitFor(() => first.status === "running", "the gated run to start");
  const queued = manager.submit("queued behind", "shared.jsonl", quickJob());
  assert.equal(queued.status, "queued");

  const fillers = [];
  for (let i = 0; i < 150; i++) {
    fillers.push(manager.submit(`fill ${i}`, `qfill-${i}.jsonl`, quickJob()));
  }
  await Promise.all(fillers.map((record) => record.done));

  // Terminal records were pruned to the bound, but the queued run was kept
  // and is still waiting in the dispatch queue.
  assert.equal(terminalCount(manager), MAX_TERMINAL_RUNS);
  const liveQueued = manager.get(queued.runId);
  assert.notEqual(liveQueued, null);
  assert.equal(liveQueued!.status, "queued");
  assert.ok(internals(manager)._pending.includes(liveQueued!));

  // stop() on the queued run is unchanged: immediate cancelled terminal.
  const stopped = manager.stop(queued.runId);
  assert.notEqual(stopped, null);
  assert.equal(stopped!.status, "cancelled");
  assert.equal(await queued.done, true);

  gate.resolve();
  assert.equal(await first.done, true);
  assert.equal(first.status, "completed");
  assert.equal(manager.get(first.runId)?.status, "completed");
});

test("terminal records drop listeners and freeze their event buffers", async () => {
  const manager = new RunManager({ workers: 2 });
  const job: RunJob = async (_signal, onEnvelope, onToken) => {
    onEnvelope({ seq: 1, kind: "message" });
    onToken({ type: "token", role: "senior", kind: "text", delta: "hi", at: "1" });
    return { cancelled: false, decision: { decision: "done" } };
  };
  const record = manager.submit("tokens", "tokens.jsonl", job, "", { streamTokens: true });

  let tokenFrames = 0;
  const unsubscribe = record.onLiveToken(() => {
    tokenFrames += 1;
  });
  assert.equal(await record.done, true);
  assert.equal(tokenFrames, 1);
  assert.equal(record.status, "completed");

  // finish() closed the live-token registry: late tokens reach nobody, a
  // late subscriber is never called, and the unsubscribe stays a safe no-op.
  const internalsRecord = record as unknown as { _liveTokenListeners: Set<unknown> };
  assert.equal(internalsRecord._liveTokenListeners.size, 0);
  let late = 0;
  const lateUnsub = record.onLiveToken(() => {
    late += 1;
  });
  record.emitLiveToken({ type: "token", role: "senior", kind: "text", delta: "x", at: "2" });
  assert.equal(late, 0);
  lateUnsub();
  unsubscribe();

  // A terminal record accepts no steering and its event buffer is final.
  assert.equal(record.steer("too late"), false);
  assert.equal(record.pendingSteering, 0);
  assert.equal(record.events.at(-1)?.type, "run_end");
  const frozen = record.events.length;
  record.finish(); // idempotent
  assert.equal(record.events.length, frozen);

  // Eviction later keeps those guarantees: the captured record is unchanged.
  const flood = [];
  for (let i = 0; i < MAX_TERMINAL_RUNS + 10; i++) {
    flood.push(manager.submit(`flood ${i}`, `flood-${i}.jsonl`, quickJob()));
  }
  await Promise.all(flood.map((record) => record.done));
  assert.equal(manager.get(record.runId), null);
  assert.equal(record.events.length, frozen);
  assert.equal(internalsRecord._liveTokenListeners.size, 0);
});
