/**
 * Broker-level approval repeat cap (`RunApprovalBroker`).
 *
 * The harness caps repeat denials of the built-in workspace tools
 * (`tests/approvaldeny.test.ts`); the broker cap covers every other consumer
 * of the same `PermissionManager`/broker — plugin/MCP-contributed approval
 * paths and custom managers — so a stubborn model cannot park a run in
 * `waiting` forever on any of them.
 *
 * Covered here: the default limit shared with the harness, N operator
 * denials then an immediate DENY for the next identical request (no pending
 * entry, no `approval_requested`), the additive `approval_auto_denied` event
 * (exactly one per auto-denial, exact fields), pair isolation, allow
 * answers never counting/resetting, `denyAll()`/abort cancellations never
 * counting, custom/invalid `denyLimit` values, the no-op operator paths, and
 * the `RunManager` wiring (event carries `run_id`/`at` and reaches the
 * sidecar).
 *
 * Hermetic: no provider, no network, no workspace — broker/manager only.
 * Run with: node --test tests/approvalbrokerdeny.test.ts
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import {
  Action,
  Decision,
  PermissionManager,
  type ApprovalRequest,
} from "../src/permissions.ts";
import {
  APPROVAL_DENY_LIMIT,
  RuntimeEventStore,
  RunApprovalBroker,
  approvalPairKey,
  type ApprovalAutoDeniedEvent,
} from "../src/runevents.ts";
import { RunManager, type RunJob } from "../src/runtime.ts";

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
    await sleep(5);
  }
}

function tmpdir(): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-approval-broker-"));
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function writeRequest(target = "a.txt"): ApprovalRequest {
  return { action: Action.WRITE, target };
}

function shellRequest(command: string, reason?: string): ApprovalRequest {
  return { action: Action.SHELL, command, ...(reason !== undefined ? { reason } : {}) };
}

interface BrokerFixture {
  broker: RunApprovalBroker;
  emitted: Array<Record<string, unknown>>;
}

/** A broker with an attached event collector (no abort signal). */
function makeBroker(options: { denyLimit?: number } = {}): BrokerFixture {
  const emitted: Array<Record<string, unknown>> = [];
  const broker = new RunApprovalBroker(options);
  broker.attach((event) => emitted.push(event as unknown as Record<string, unknown>), null);
  return { broker, emitted };
}

function eventsOfType(fixture: BrokerFixture, type: string): Array<Record<string, unknown>> {
  return fixture.emitted.filter((event) => event.type === type);
}

/** Park one request, answer it with `decision`, return the resolved decision. */
async function parkAndAnswer(
  broker: RunApprovalBroker,
  request: ApprovalRequest,
  decision: Decision,
): Promise<Decision> {
  const waiting = broker.approve(request);
  const pending = broker.pending();
  assert.equal(pending.length, 1, "the request must park on the operator");
  const requestId = String(pending[0].approval_id);
  assert.equal(broker.respond(requestId, decision), decision);
  const resolved = await waiting;
  assert.deepEqual(broker.pending(), [], "no pending entry survives an answer");
  return resolved;
}

/** N operator denials of one request (the cap's setup). */
async function denyTimes(
  broker: RunApprovalBroker,
  request: ApprovalRequest,
  times = APPROVAL_DENY_LIMIT,
): Promise<void> {
  for (let index = 0; index < times; index++) {
    assert.equal(await parkAndAnswer(broker, request, Decision.DENY), Decision.DENY);
  }
}

// ---------------------------------------------------------------------------
// default limit
// ---------------------------------------------------------------------------

test("default deny limit is the shared APPROVAL_DENY_LIMIT", () => {
  assert.equal(APPROVAL_DENY_LIMIT, 2, "the published default stays 2");
  assert.equal(new RunApprovalBroker().denyLimit, APPROVAL_DENY_LIMIT);
  // non-positive / non-finite values fall back to the default
  for (const bad of [0, -1, -12, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.equal(
      new RunApprovalBroker({ denyLimit: bad }).denyLimit,
      APPROVAL_DENY_LIMIT,
      `denyLimit ${String(bad)} must fall back to the default`,
    );
  }
  // positive values are accepted (floored like the other integer options)
  assert.equal(new RunApprovalBroker({ denyLimit: 1 }).denyLimit, 1);
  assert.equal(new RunApprovalBroker({ denyLimit: 3 }).denyLimit, 3);
  assert.equal(new RunApprovalBroker({ denyLimit: 4.9 }).denyLimit, 4);
});

// ---------------------------------------------------------------------------
// core repeat-cap behavior
// ---------------------------------------------------------------------------

test("N operator denials cap identical requests: the next one denies immediately without parking", async () => {
  const fixture = makeBroker();
  const { broker } = fixture;

  await denyTimes(broker, writeRequest());
  assert.equal(eventsOfType(fixture, "approval_requested").length, APPROVAL_DENY_LIMIT);
  assert.equal(eventsOfType(fixture, "approval_resolved").length, APPROVAL_DENY_LIMIT);
  assert.equal(eventsOfType(fixture, "approval_auto_denied").length, 0);
  assert.deepEqual(broker.autoDenials(), {
    [approvalPairKey(writeRequest())]: APPROVAL_DENY_LIMIT,
  });

  // The cap tripped: this resolves DENY without an operator, a pending entry
  // or an approval_requested event.
  assert.equal(await broker.approve(writeRequest()), Decision.DENY);
  assert.deepEqual(broker.pending(), [], "an auto-denied attempt never parks");
  assert.equal(
    eventsOfType(fixture, "approval_requested").length,
    APPROVAL_DENY_LIMIT,
    "no approval_requested for the auto-denied attempt",
  );
  assert.equal(
    eventsOfType(fixture, "approval_resolved").length,
    APPROVAL_DENY_LIMIT,
    "an auto-denied attempt is not a resolution event",
  );

  // Exactly one additive event, with the exact field set.
  const auto = eventsOfType(fixture, "approval_auto_denied");
  assert.equal(auto.length, 1);
  assert.deepEqual(Object.keys(auto[0]), ["type", "action", "target", "count", "limit"]);
  assert.equal(auto[0].type, "approval_auto_denied");
  assert.equal(auto[0].action, "write");
  assert.equal(auto[0].target, "a.txt");
  assert.equal(auto[0].count, APPROVAL_DENY_LIMIT);
  assert.equal(auto[0].limit, APPROVAL_DENY_LIMIT);
  assert.ok(!("approval_id" in auto[0]), "the additive event carries no approval id");
  assert.equal(fixture.emitted[fixture.emitted.length - 1].type, "approval_auto_denied");
});

test("every further identical attempt auto-denies once and never increments past the limit", async () => {
  const fixture = makeBroker();
  const { broker } = fixture;
  await denyTimes(broker, writeRequest());

  for (let attempt = 0; attempt < 3; attempt++) {
    assert.equal(await broker.approve(writeRequest()), Decision.DENY);
  }
  const auto = eventsOfType(fixture, "approval_auto_denied");
  assert.equal(auto.length, 3, "one event per auto-denial");
  for (const event of auto) {
    assert.equal(event.count, APPROVAL_DENY_LIMIT);
    assert.equal(event.limit, APPROVAL_DENY_LIMIT);
  }
  assert.deepEqual(broker.autoDenials(), {
    [approvalPairKey(writeRequest())]: APPROVAL_DENY_LIMIT,
  });
  assert.equal(broker.denyAll(), 0, "nothing is pending after auto-denials");
  assert.equal(eventsOfType(fixture, "approval_requested").length, APPROVAL_DENY_LIMIT);
});

test("a different (action, target) pair is unaffected by another pair's cap", async () => {
  const fixture = makeBroker();
  const { broker } = fixture;
  await denyTimes(broker, writeRequest("a.txt"));

  // Same action, different target: still reaches the operator.
  assert.equal(
    await parkAndAnswer(broker, writeRequest("b.txt"), Decision.ALLOW),
    Decision.ALLOW,
  );
  // Same target, different action: still reaches the operator.
  assert.equal(
    await parkAndAnswer(broker, { action: Action.DELETE, target: "a.txt" }, Decision.ALLOW),
    Decision.ALLOW,
  );
  // The capped pair is still capped.
  assert.equal(await broker.approve(writeRequest("a.txt")), Decision.DENY);
  assert.deepEqual(Object.keys(broker.autoDenials()), [approvalPairKey(writeRequest("a.txt"))]);
});

// ---------------------------------------------------------------------------
// what counts as an operator denial
// ---------------------------------------------------------------------------

test("allow answers never count and never reset a pair's denial count", async () => {
  const fixture = makeBroker();
  const { broker } = fixture;

  // Allows park + resolve like a denial, but leave no counter behind.
  for (let index = 0; index < 3; index++) {
    assert.equal(await parkAndAnswer(broker, writeRequest(), Decision.ALLOW), Decision.ALLOW);
  }
  assert.deepEqual(broker.autoDenials(), {});
  // The next deny is the first counted denial, not the fourth attempt.
  await denyTimes(broker, writeRequest(), 1);
  assert.deepEqual(broker.autoDenials(), {
    [approvalPairKey(writeRequest())]: 1,
  });

  // An allow between two denials neither counts nor resets the earlier deny.
  await parkAndAnswer(broker, writeRequest(), Decision.ALLOW);
  await denyTimes(broker, writeRequest(), 1);
  assert.deepEqual(broker.autoDenials(), {
    [approvalPairKey(writeRequest())]: APPROVAL_DENY_LIMIT,
  });
  assert.equal(await broker.approve(writeRequest()), Decision.DENY);
});

test("denyAll()-resolved waits never count toward the cap", async () => {
  const fixture = makeBroker();
  const { broker } = fixture;
  for (let index = 0; index < 3; index++) {
    const waiting = broker.approve(writeRequest());
    assert.equal(broker.pending().length, 1);
    assert.equal(broker.denyAll("cancelled"), 1);
    assert.equal(await waiting, Decision.DENY);
    assert.deepEqual(broker.pending(), []);
  }
  assert.deepEqual(broker.autoDenials(), {}, "cancellations are not operator denials");
  assert.equal(eventsOfType(fixture, "approval_auto_denied").length, 0);
  const resolved = eventsOfType(fixture, "approval_resolved");
  assert.equal(resolved.length, 3);
  assert.ok(resolved.every((event) => event.reason === "cancelled"));

  // The operator budget is intact: the next identical request still parks.
  assert.equal(await parkAndAnswer(broker, writeRequest(), Decision.ALLOW), Decision.ALLOW);
});

test("abort-resolved waits never count toward the cap", async () => {
  const emitted: Array<Record<string, unknown>> = [];
  const controller = new AbortController();
  const broker = new RunApprovalBroker();
  broker.attach((event) => emitted.push(event as unknown as Record<string, unknown>), controller.signal);
  for (let index = 0; index < 3; index++) {
    const waiting = broker.approve(writeRequest());
    controller.abort();
    assert.equal(await waiting, Decision.DENY);
  }
  assert.deepEqual(broker.autoDenials(), {});
  assert.equal(emitted.filter((event) => event.type === "approval_auto_denied").length, 0);
  // Every wait resolved as a cancellation denial, exactly once.
  const resolved = emitted.filter((event) => event.type === "approval_resolved");
  assert.equal(resolved.length, 3);
  assert.ok(resolved.every((event) => event.decision === "deny" && event.reason === "cancelled"));
});

test("unknown answers and answers after auto-denial are no-ops", async () => {
  const fixture = makeBroker();
  const { broker } = fixture;
  assert.equal(broker.respond("never-seen", Decision.ALLOW), null);
  assert.equal(broker.respond("never-seen", Decision.DENY), null);
  assert.deepEqual(broker.autoDenials(), {}, "unknown denies must not count");

  await denyTimes(broker, writeRequest());
  assert.equal(await broker.approve(writeRequest()), Decision.DENY);
  const emittedBefore = fixture.emitted.length;
  // There is no id for an auto-denied attempt; stale/unknown ids stay no-ops.
  assert.equal(broker.respond("stale-id", Decision.ALLOW), null);
  assert.equal(broker.respond("stale-id", Decision.DENY), null);
  assert.equal(broker.denyAll(), 0);
  assert.equal(fixture.emitted.length, emittedBefore, "no-op operator calls emit nothing");
  assert.deepEqual(broker.autoDenials(), {
    [approvalPairKey(writeRequest())]: APPROVAL_DENY_LIMIT,
  });
});

test("broker still resolves a normal approval (requested -> resolved exactly once)", async () => {
  const fixture = makeBroker();
  const { broker } = fixture;
  const allow = await parkAndAnswer(broker, writeRequest("normal.txt"), Decision.ALLOW);
  assert.equal(allow, Decision.ALLOW);
  const deny = await parkAndAnswer(broker, writeRequest("normal.txt"), Decision.DENY);
  assert.equal(deny, Decision.DENY);

  assert.equal(eventsOfType(fixture, "approval_requested").length, 2);
  const resolved = eventsOfType(fixture, "approval_resolved");
  assert.deepEqual(
    resolved.map((event) => event.decision),
    [Decision.ALLOW, Decision.DENY],
  );
  assert.equal(eventsOfType(fixture, "approval_auto_denied").length, 0);
});

// ---------------------------------------------------------------------------
// custom limits and pairing semantics
// ---------------------------------------------------------------------------

test("custom denyLimit changes when the cap trips", async () => {
  const one = makeBroker({ denyLimit: 1 });
  await denyTimes(one.broker, writeRequest(), 1);
  assert.equal(await one.broker.approve(writeRequest()), Decision.DENY);

  const three = makeBroker({ denyLimit: 3 });
  await denyTimes(three.broker, writeRequest(), 2);
  assert.equal(three.broker.pending().length, 0);
  // Two denials are below a limit of three: the next request still parks.
  const waiting = three.broker.approve(writeRequest());
  assert.equal(three.broker.pending().length, 1);
  three.broker.respond(String(three.broker.pending()[0].approval_id), Decision.DENY);
  assert.equal(await waiting, Decision.DENY);
  // Now at the limit: the next identical request auto-denies.
  assert.equal(await three.broker.approve(writeRequest()), Decision.DENY);
  assert.equal(eventsOfType(three, "approval_auto_denied").length, 1);
  assert.equal(eventsOfType(three, "approval_auto_denied")[0].count, 3);
});

test("shell approvals pair on the command and ignore the reason text", async () => {
  const fixture = makeBroker();
  const { broker } = fixture;
  await denyTimes(broker, shellRequest("echo hi"));
  // A changed reason is still the same request.
  assert.equal(await broker.approve(shellRequest("echo hi", "different reason")), Decision.DENY);
  const auto = eventsOfType(fixture, "approval_auto_denied");
  assert.equal(auto.length, 1);
  assert.equal(auto[0].action, "shell");
  assert.equal(auto[0].target, "echo hi");

  // A different shell command is a different pair.
  assert.equal(await parkAndAnswer(broker, shellRequest("echo bye"), Decision.ALLOW), Decision.ALLOW);
});

test("targets normalize like the harness pair (./, backslashes) so repeats match", async () => {
  const fixture = makeBroker();
  const { broker } = fixture;
  await denyTimes(broker, writeRequest("./dir\\file.txt"));
  // Same normalized target, written differently: the cap applies.
  assert.equal(await broker.approve(writeRequest("dir/file.txt")), Decision.DENY);
  assert.equal(eventsOfType(fixture, "approval_auto_denied").length, 1);
});

test("a fresh broker starts with a clean cap (per-run isolation)", async () => {
  const first = makeBroker();
  await denyTimes(first.broker, writeRequest());
  assert.equal(await first.broker.approve(writeRequest()), Decision.DENY);

  const second = makeBroker();
  assert.deepEqual(second.broker.autoDenials(), {});
  // The operator is asked again in a new run.
  assert.equal(await parkAndAnswer(second.broker, writeRequest(), Decision.ALLOW), Decision.ALLOW);
});

// ---------------------------------------------------------------------------
// PermissionManager integration: the cap covers non-workspace consumers
// ---------------------------------------------------------------------------

test("a PermissionManager plugged into the broker inherits the cap", async () => {
  const fixture = makeBroker();
  const { broker } = fixture;
  const gated = new PermissionManager(null, broker);

  await denyTimes(broker, writeRequest());

  // The third identical check resolves DENY without parking the manager.
  assert.equal(await gated.check(writeRequest()), Decision.DENY);
  assert.deepEqual(broker.pending(), []);
  assert.equal(eventsOfType(fixture, "approval_auto_denied").length, 1);
  // A different pair still parks and can be allowed through the manager.
  const check = gated.check(writeRequest("other.txt"));
  await waitFor(() => broker.pending().length === 1, "pending via PermissionManager");
  broker.respond(String(broker.pending()[0].approval_id), Decision.ALLOW);
  assert.equal(await check, Decision.ALLOW);
});

// ---------------------------------------------------------------------------
// RunManager wiring: run_id/at, sidecar persistence, no re-park
// ---------------------------------------------------------------------------

test("RunManager: auto-denied attempt carries run_id/at, persists, and never re-parks the run", async () => {
  const tmp = tmpdir();
  try {
    const store = new RuntimeEventStore(path.join(tmp.root, "runtime"));
    const manager = new RunManager({ persist: store.asPersist() });
    const broker = new RunApprovalBroker();
    const decisions: string[] = [];

    const job: RunJob = async (signal, onEnvelope) => {
      broker.attach(onEnvelope, signal);
      for (let attempt = 0; attempt < APPROVAL_DENY_LIMIT + 1; attempt++) {
        decisions.push(await broker.approve(writeRequest()));
      }
      return { cancelled: false, decision: {}, errors: [] };
    };

    const record = manager.submit("repeat the denied write", "s.jsonl", job);
    for (let attempt = 0; attempt < APPROVAL_DENY_LIMIT; attempt++) {
      await waitFor(() => broker.pending().length > 0, "approval pending");
      const pending = broker.pending();
      const approvalId = String(pending[0].approval_id);
      assert.equal(record.status, "waiting", "each parked wait reports waiting");
      assert.equal(broker.respond(approvalId, Decision.DENY), Decision.DENY);
      // Let the answered entry clear before looking for the next park (the
      // job may issue the following approval in the same microtask turn).
      await waitFor(
        () => !broker.pending().some((entry) => String(entry.approval_id) === approvalId),
        "answered approval cleared",
      );
    }

    assert.equal(await manager.wait(record.runId), true);
    assert.equal(record.status, "completed");
    assert.deepEqual(decisions, [Decision.DENY, Decision.DENY, Decision.DENY]);

    // Exactly one additive event, enriched by the manager with run metadata.
    const auto = record.events.filter(
      (event): event is ApprovalAutoDeniedEvent => event.type === "approval_auto_denied",
    );
    assert.equal(auto.length, 1);
    assert.equal(auto[0].action, "write");
    assert.equal(auto[0].target, "a.txt");
    assert.equal(auto[0].count, APPROVAL_DENY_LIMIT);
    assert.equal(auto[0].limit, APPROVAL_DENY_LIMIT);
    assert.equal(auto[0].run_id, record.runId);
    assert.equal(typeof auto[0].at, "number");

    // The auto-denied attempt never re-parked the run: only the two operator
    // waits produced `waiting`.
    const waiting = record.events.filter(
      (event) => event.type === "run_status" && event.status === "waiting",
    );
    assert.equal(waiting.length, APPROVAL_DENY_LIMIT);

    // The additive event reaches the durable sidecar unchanged.
    const sidecar = store.load("s.jsonl");
    const persisted = sidecar.filter((event) => event.type === "approval_auto_denied");
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].run_id, record.runId);
    assert.equal(persisted[0].count, APPROVAL_DENY_LIMIT);
  } finally {
    tmp.cleanup();
  }
});
