/**
 * Shell-approval caution after a denied file mutation (Wave 6, lane 1).
 *
 * `workspace_run_shell` is a separate approval: in `ask`/`edits` a model whose
 * write/edit/delete was denied can retry the same effect through a command with
 * no diff preview. `RunApprovalBroker` therefore appends one bounded caution
 * sentence to a parked shell approval's existing additive `reason` once the
 * operator denied a file mutation earlier in the same run. Display-only: the
 * decision table, pair key, denial cap, session allows and event shape are
 * untouched, and the base reason is byte-identical when nothing was denied.
 *
 * Hermetic: broker/manager/workspace only, temp dirs per test; no network.
 * Run with: node --test tests/approvalshellcaution.test.ts
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import {
  Action,
  ApprovalMode,
  Decision,
  PermissionManager,
  PermissionPolicy,
  type ApprovalRequest,
} from "../src/permissions.ts";
import {
  APPROVAL_DENY_LIMIT,
  RunApprovalBroker,
  SHELL_DENIED_MUTATION_CAUTION,
  approvalPairKey,
} from "../src/runevents.ts";
import { SHELL_APPROVAL_REASON, Workspace } from "../src/workspace.ts";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

interface Fixture {
  broker: RunApprovalBroker;
  events: Array<Record<string, unknown>>;
}

/** A broker with an attached event collector (no abort signal by default). */
function makeBroker(options: { denyLimit?: number } = {}): Fixture {
  const events: Array<Record<string, unknown>> = [];
  const broker = new RunApprovalBroker(options);
  broker.attach((event) => events.push(event as unknown as Record<string, unknown>), null);
  return { broker, events };
}

function tmpdir(): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-shell-caution-"));
  // Retrying cleanup keeps the shell end-to-end case from inheriting the
  // repo's Git-Bash-on-PATH cleanup requirement (same pattern as load.test.ts).
  return {
    root,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }),
  };
}

function mutationRequest(action: Action, target: string): ApprovalRequest {
  return { action, target };
}

function shellRequest(
  command = "cat a.txt",
  reason = "base reason",
): ApprovalRequest {
  return { action: Action.SHELL, command, reason };
}

/** A shell request with no `reason` field at all (the additive key is absent). */
function shellRequestWithoutReason(command: string): ApprovalRequest {
  return { action: Action.SHELL, command };
}

async function waitFor(cond: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Start one approval, answer it, and return the resolved decision. */
async function parkAndAnswer(
  fixture: Fixture,
  request: ApprovalRequest,
  decision: Decision,
): Promise<Decision> {
  const waiting = fixture.broker.approve(request);
  const pending = fixture.broker.pending();
  assert.equal(pending.length, 1, "the request must park on the operator");
  assert.equal(fixture.broker.respond(String(pending[0].approval_id), decision), decision);
  return waiting;
}

/** The single `approval_requested` event a park emitted. */
function requestedEvent(fixture: Fixture, index = 0): Record<string, unknown> {
  const requested = fixture.events.filter((event) => event.type === "approval_requested");
  const event = requested[index];
  assert.ok(event, `missing approval_requested #${index}: ${JSON.stringify(fixture.events)}`);
  return event;
}

/** Count non-overlapping occurrences of one exact sentence. */
function occurrences(text: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = text.indexOf(needle, from);
    if (at < 0) return count;
    count += 1;
    from = at + needle.length;
  }
}

// ---------------------------------------------------------------------------
// copy contract + unchanged no-denial behavior
// ---------------------------------------------------------------------------

test("the caution is one exact, short, single-line sentence", () => {
  assert.equal(
    SHELL_DENIED_MUTATION_CAUTION,
    "a file change was denied earlier in this run — review this command closely",
  );
  assert.ok(SHELL_DENIED_MUTATION_CAUTION.length <= 120, "bounded copy");
  assert.equal(SHELL_DENIED_MUTATION_CAUTION.includes("\n"), false);
  // It names the earlier denial and asks for a close review; no paths, keys,
  // commands or other request payloads can leak through a fixed sentence.
  assert.match(SHELL_DENIED_MUTATION_CAUTION, /denied earlier in this run/);
  assert.match(SHELL_DENIED_MUTATION_CAUTION, /review this command closely/);
});

test("before any denial the shell reason is byte-identical to today", async () => {
  const fixture = makeBroker();
  const base = "runs arbitrary shell code inside the workspace";
  await parkAndAnswer(fixture, shellRequest("echo hi", base), Decision.ALLOW);
  const event = requestedEvent(fixture);
  assert.equal(event.reason, base, "base reason untouched without a denied mutation");
  assert.equal(JSON.stringify(event.reason).includes(SHELL_DENIED_MUTATION_CAUTION), false);
  // A retry of the same shell request keeps the same reason (no accumulation).
  await parkAndAnswer(fixture, shellRequest("echo hi", base), Decision.ALLOW);
  assert.equal(requestedEvent(fixture, 1).reason, base);
});

test("a shell request with no reason stays reason-free before any denial", async () => {
  const fixture = makeBroker();
  await parkAndAnswer(fixture, shellRequestWithoutReason("echo hi"), Decision.ALLOW);
  const event = requestedEvent(fixture);
  assert.equal(
    Object.prototype.hasOwnProperty.call(event, "reason"),
    false,
    "the additive reason key is still omitted when there is no text",
  );
});

// ---------------------------------------------------------------------------
// arming: operator-denied mutations
// ---------------------------------------------------------------------------

test("a denied write arms the caution on the next parked shell approval", async () => {
  const fixture = makeBroker();
  const write = mutationRequest(Action.WRITE, "notes.txt");
  const request = shellRequest("rm notes.txt", "base reason");

  await parkAndAnswer(fixture, write, Decision.DENY);
  // the caller's object is never mutated (a retried request cannot duplicate it)
  assert.equal(request.reason, "base reason");

  await parkAndAnswer(fixture, request, Decision.ALLOW);
  const event = requestedEvent(fixture, 1);
  const expected = `base reason; ${SHELL_DENIED_MUTATION_CAUTION}`;
  assert.equal(event.reason, expected);
  assert.ok(String(event.reason).startsWith("base reason"), "the base reason stays present");
  assert.equal(occurrences(String(event.reason), SHELL_DENIED_MUTATION_CAUTION), 1);
  // the caller's request object is never mutated (a retried request cannot
  // accumulate a second sentence)
  assert.equal(request.reason, "base reason");
});

test("a denied edit and a denied delete also arm the caution", async () => {
  for (const action of [Action.EDIT, Action.DELETE]) {
    const fixture = makeBroker();
    await parkAndAnswer(fixture, mutationRequest(action, "notes.txt"), Decision.DENY);
    await parkAndAnswer(fixture, shellRequest("echo hi"), Decision.ALLOW);
    assert.equal(
      requestedEvent(fixture, 1).reason,
      `base reason; ${SHELL_DENIED_MUTATION_CAUTION}`,
      `${action} denial must arm the caution`,
    );
  }
});

test("the pending view carries the cautious reason too", async () => {
  const fixture = makeBroker();
  await parkAndAnswer(fixture, mutationRequest(Action.WRITE, "a.txt"), Decision.DENY);
  const waiting = fixture.broker.approve(shellRequest("rm a.txt", "base reason"));
  const pending = fixture.broker.pending();
  assert.equal(pending.length, 1);
  assert.equal(
    pending[0].reason,
    `base reason; ${SHELL_DENIED_MUTATION_CAUTION}`,
    "GET /api/runs/{id}/approvals and the TUI panel read this field",
  );
  assert.equal(
    fixture.broker.respond(String(pending[0].approval_id), Decision.DENY),
    Decision.DENY,
  );
  assert.equal(await waiting, Decision.DENY);
});

test("a shell request without a reason gets the caution as its only reason after a denial", async () => {
  const fixture = makeBroker();
  await parkAndAnswer(fixture, mutationRequest(Action.WRITE, "a.txt"), Decision.DENY);
  await parkAndAnswer(fixture, shellRequestWithoutReason("echo hi"), Decision.ALLOW);
  assert.equal(requestedEvent(fixture, 1).reason, SHELL_DENIED_MUTATION_CAUTION);
});

// ---------------------------------------------------------------------------
// non-arming paths
// ---------------------------------------------------------------------------

test("allowed, session-allowed and allowForSession mutations never arm the caution", async () => {
  // plain allow
  const allowed = makeBroker();
  await parkAndAnswer(allowed, mutationRequest(Action.WRITE, "a.txt"), Decision.ALLOW);
  await parkAndAnswer(allowed, shellRequest("echo hi"), Decision.ALLOW);
  assert.equal(requestedEvent(allowed, 1).reason, "base reason");

  // session-scope allowForSession
  const sessionAllow = makeBroker();
  const waiting = sessionAllow.broker.approve(mutationRequest(Action.DELETE, "doomed.txt"));
  assert.equal(
    sessionAllow.broker.allowForSession(String(sessionAllow.broker.pending()[0].approval_id)),
    Decision.ALLOW,
  );
  assert.equal(await waiting, Decision.ALLOW);
  await parkAndAnswer(sessionAllow, shellRequest("echo hi"), Decision.ALLOW);
  assert.equal(requestedEvent(sessionAllow, 1).reason, "base reason");

  // a seeded session allow auto-allows without parking (never an operator deny)
  const seeded = makeBroker();
  seeded.broker.seedSessionAllows([
    approvalPairKey(mutationRequest(Action.WRITE, "a.txt")),
  ]);
  const autoAllowed = await seeded.broker.approve(mutationRequest(Action.WRITE, "a.txt"));
  assert.equal(autoAllowed, Decision.ALLOW);
  await parkAndAnswer(seeded, shellRequest("echo hi"), Decision.ALLOW);
  assert.equal(requestedEvent(seeded, 0).reason, "base reason");
});

test("a denied shell and a cancelled/stopped run never arm the caution", async () => {
  // operator denies a shell: the next shell is not cautious
  const deniedShell = makeBroker();
  await parkAndAnswer(deniedShell, shellRequest("echo one"), Decision.DENY);
  await parkAndAnswer(deniedShell, shellRequest("echo two"), Decision.ALLOW);
  assert.equal(requestedEvent(deniedShell, 1).reason, "base reason");

  // denyAll() is a cancellation, not an operator answer
  const stopped = makeBroker();
  const parked = stopped.broker.approve(mutationRequest(Action.WRITE, "a.txt"));
  assert.equal(stopped.broker.pending().length, 1);
  assert.equal(stopped.broker.denyAll(), 1);
  assert.equal(await parked, Decision.DENY);
  await parkAndAnswer(stopped, shellRequest("echo hi"), Decision.ALLOW);
  assert.equal(requestedEvent(stopped, 1).reason, "base reason");

  // an abort also cancels rather than denies. The aborted signal is cleared
  // for this inspection so a later shell can park again on the same broker.
  const aborted = makeBroker();
  const controller = new AbortController();
  aborted.broker.attach(
    (event) => aborted.events.push(event as unknown as Record<string, unknown>),
    controller.signal,
  );
  const parkedWrite = aborted.broker.approve(mutationRequest(Action.EDIT, "a.txt"));
  controller.abort();
  assert.equal(await parkedWrite, Decision.DENY);
  aborted.broker.attach(
    (event) => aborted.events.push(event as unknown as Record<string, unknown>),
    null,
  );
  await parkAndAnswer(aborted, shellRequest("echo hi"), Decision.ALLOW);
  assert.equal(requestedEvent(aborted, 1).reason, "base reason");
});

test("readonly denies and allow-all allows without parking, so neither sees the caution", async () => {
  const closed: Array<Record<string, unknown>> = [];
  const broker = new RunApprovalBroker();
  broker.attach((event) => closed.push(event as unknown as Record<string, unknown>), null);

  const readonly = new PermissionManager(new PermissionPolicy(ApprovalMode.READONLY), broker);
  assert.equal(await readonly.check(shellRequest("rm a.txt", SHELL_APPROVAL_REASON)), Decision.DENY);
  assert.deepEqual(broker.pending(), []);
  assert.deepEqual(closed, [], "readonly emits no approval request and no caution");

  const allowAll = new PermissionManager(new PermissionPolicy(ApprovalMode.ALLOW_ALL), broker);
  assert.equal(await allowAll.check(shellRequest("rm a.txt", SHELL_APPROVAL_REASON)), Decision.ALLOW);
  assert.deepEqual(broker.pending(), []);
  assert.deepEqual(closed, [], "allow-all emits no approval request and no caution");
});

// ---------------------------------------------------------------------------
// decision/pair/cap semantics unchanged
// ---------------------------------------------------------------------------

test("the caution never affects the pair key, the denial cap or the answer", async () => {
  const fixture = makeBroker();
  const shell = shellRequest("echo hi", SHELL_APPROVAL_REASON);
  // reason is not part of the pairing identity, before or after arming
  await parkAndAnswer(fixture, mutationRequest(Action.WRITE, "a.txt"), Decision.DENY);
  const cautious = shellRequest("echo hi", `${SHELL_APPROVAL_REASON}; ${SHELL_DENIED_MUTATION_CAUTION}`);
  assert.equal(approvalPairKey(cautious), approvalPairKey(shell));

  // One shell denial is counted under the normal pair, not under the caution.
  assert.equal(await parkAndAnswer(fixture, shell, Decision.DENY), Decision.DENY);
  assert.deepEqual(fixture.broker.autoDenials(), {
    [approvalPairKey(mutationRequest(Action.WRITE, "a.txt"))]: 1,
    [approvalPairKey(shell)]: 1,
  });

  // The cap keeps working: after denyLimit denials the next identical shell is
  // auto-denied with the unchanged additive event (no reason field added).
  for (let index = 1; index < APPROVAL_DENY_LIMIT; index++) {
    assert.equal(await parkAndAnswer(fixture, shell, Decision.DENY), Decision.DENY);
  }
  assert.equal(await fixture.broker.approve(shell), Decision.DENY);
  const autoDenied = fixture.events.filter((event) => event.type === "approval_auto_denied");
  assert.equal(autoDenied.length, 1);
  assert.equal(autoDenied[0]?.action, Action.SHELL);
  assert.equal(autoDenied[0]?.count, APPROVAL_DENY_LIMIT);
  assert.equal(Object.prototype.hasOwnProperty.call(autoDenied[0], "reason"), false);
  assert.deepEqual(fixture.broker.autoDenials(), {
    [approvalPairKey(mutationRequest(Action.WRITE, "a.txt"))]: 1,
    [approvalPairKey(shell)]: APPROVAL_DENY_LIMIT,
  });
});

test("the approval_requested event shape stays additive-compatible", async () => {
  // The cautious event has exactly the same keys as a normal shell request;
  // only the additive `reason` text changes.
  const plain = makeBroker();
  await parkAndAnswer(plain, shellRequest("echo hi"), Decision.ALLOW);
  const cautious = makeBroker();
  await parkAndAnswer(cautious, mutationRequest(Action.WRITE, "a.txt"), Decision.DENY);
  await parkAndAnswer(cautious, shellRequest("echo hi"), Decision.ALLOW);
  assert.deepEqual(
    Object.keys(requestedEvent(cautious, 1)).sort(),
    Object.keys(requestedEvent(plain, 0)).sort(),
  );
});

test("many denials still produce one bounded caution sentence", async () => {
  const fixture = makeBroker({ denyLimit: 10 });
  for (let index = 0; index < 5; index++) {
    await parkAndAnswer(
      fixture,
      mutationRequest(Action.WRITE, `f${index}.txt`),
      Decision.DENY,
    );
  }
  await parkAndAnswer(fixture, shellRequest("echo hi", "base reason"), Decision.ALLOW);
  const reason = String(requestedEvent(fixture, 5).reason);
  assert.equal(occurrences(reason, SHELL_DENIED_MUTATION_CAUTION), 1);
  assert.equal(reason, `base reason; ${SHELL_DENIED_MUTATION_CAUTION}`);
  assert.ok(reason.length < 300, "one base reason plus one fixed sentence");
});

// ---------------------------------------------------------------------------
// the real workspace path (SHELL_APPROVAL_REASON) and RunManager wiring
// ---------------------------------------------------------------------------

test("workspace: a denied write then an approved shell carries the caution end to end", async () => {
  const tmp = tmpdir();
  try {
    const fixture = makeBroker();
    const workspace = new Workspace(
      tmp.root,
      new PermissionManager(new PermissionPolicy(ApprovalMode.ASK), fixture.broker),
    );

    const pendingWrite = workspace.write_file("notes.txt", "x\n");
    await waitFor(() => fixture.broker.pending().length === 1, "the write approval to park");
    const write = fixture.broker.pending();
    assert.equal(write.length, 1);
    assert.equal(fixture.broker.respond(String(write[0].approval_id), Decision.DENY), Decision.DENY);
    assert.equal((await pendingWrite).status, "denied");

    const pendingShell = workspace.run_shell("echo hi");
    await waitFor(() => fixture.broker.pending().length === 1, "the shell approval to park");
    const shell = fixture.broker.pending();
    assert.equal(shell.length, 1, "the shell approval is a separate parked request");
    assert.equal(
      shell[0].reason,
      `${SHELL_APPROVAL_REASON}; ${SHELL_DENIED_MUTATION_CAUTION}`,
    );
    assert.equal(
      String(requestedEvent(fixture, 1).reason),
      `${SHELL_APPROVAL_REASON}; ${SHELL_DENIED_MUTATION_CAUTION}`,
    );
    assert.equal(
      fixture.broker.respond(String(shell[0].approval_id), Decision.ALLOW),
      Decision.ALLOW,
    );
    const result = await pendingShell;
    assert.equal(result.status, "ok");
    assert.ok(String(result.stdout).includes("hi"));
  } finally {
    tmp.cleanup();
  }
});

test("workspace: no denied mutation keeps the shell reason exactly SHELL_APPROVAL_REASON", async () => {
  const tmp = tmpdir();
  try {
    const fixture = makeBroker();
    const workspace = new Workspace(
      tmp.root,
      new PermissionManager(new PermissionPolicy(ApprovalMode.ASK), fixture.broker),
    );
    const pendingShell = workspace.run_shell("echo hi");
    await waitFor(() => fixture.broker.pending().length === 1, "the shell approval to park");
    const shell = fixture.broker.pending();
    assert.equal(shell.length, 1);
    assert.equal(shell[0].reason, SHELL_APPROVAL_REASON, "byte-identical to today");
    assert.equal(requestedEvent(fixture, 0).reason, SHELL_APPROVAL_REASON);
    fixture.broker.respond(String(shell[0].approval_id), Decision.DENY);
    assert.equal((await pendingShell).status, "denied");
  } finally {
    tmp.cleanup();
  }
});
