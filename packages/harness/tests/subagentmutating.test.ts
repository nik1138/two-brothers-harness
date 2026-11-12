/**
 * Mutating helper subagents: the child workspace/permission view (step 1), the
 * child tool belt and the spawn wiring (step 2). Hermetic: temp dirs and
 * scripted brokers/providers only, no network.
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
  type ApprovalBroker,
  type ApprovalRequest,
} from "../src/permissions.ts";
import { Workspace } from "../src/workspace.ts";

function tmpdir(): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-subagent-mut-"));
  return {
    root,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/** A broker that records every request and answers with a fixed decision. */
class RecordingBroker implements ApprovalBroker {
  readonly requests: ApprovalRequest[] = [];
  decision: Decision;

  constructor(decision: Decision = Decision.ALLOW) {
    this.decision = decision;
  }

  approve(request: ApprovalRequest): Decision {
    this.requests.push(request);
    return this.decision;
  }
}

test("childView tags every parked request with the child identity", async () => {
  const broker = new RecordingBroker(Decision.ALLOW);
  const parent = new PermissionManager(
    new PermissionPolicy(ApprovalMode.ASK),
    broker,
  );
  const requested: ApprovalRequest[] = [];
  const resolved: Array<{ action: string; decision: Decision }> = [];
  const child = parent.childView(
    { id: "sub-0123456789abcdef", label: "Write the notes" },
    {
      onRequest: (request) => requested.push(request),
      onResolved: (request, decision) =>
        resolved.push({ action: request.action, decision }),
    },
  );

  const decision = await child.check({ action: Action.WRITE, target: "notes.txt" });
  assert.equal(decision, Decision.ALLOW);
  assert.equal(broker.requests.length, 1);
  assert.equal(broker.requests[0]?.subagent_id, "sub-0123456789abcdef");
  assert.equal(broker.requests[0]?.subagent_label, "Write the notes");
  assert.equal(requested.length, 1);
  assert.equal(requested[0]?.subagent_id, "sub-0123456789abcdef");
  assert.deepEqual(resolved, [{ action: "write", decision: Decision.ALLOW }]);

  // A parent request is never tagged.
  await parent.check({ action: Action.WRITE, target: "notes.txt" });
  assert.equal(broker.requests[1]?.subagent_id, undefined);
});

test("childView snapshots the policy: later parent widening never reaches the child", async () => {
  const broker = new RecordingBroker(Decision.ALLOW);
  const parent = new PermissionManager(
    new PermissionPolicy(ApprovalMode.READONLY),
    broker,
  );
  const child = parent.childView({ id: "sub-1", label: "Read only child" });

  // Test-only mutation of the parent's policy object: the child keeps its
  // snapshot (readonly), so the parked broker is never consulted.
  (parent.policy as unknown as { mode: ApprovalMode }).mode = ApprovalMode.ALLOW_ALL;
  const denied = await child.check({ action: Action.WRITE, target: "a.txt" });
  assert.equal(denied, Decision.DENY);
  assert.equal(broker.requests.length, 0);
  // The parent itself now allows (its policy was mutated, its own behaviour).
  const widened = await parent.check({ action: Action.WRITE, target: "a.txt" });
  assert.equal(widened, Decision.ALLOW);

  // A legacy boolean policy (autoAllowRead=false) keeps reads asking in the
  // snapshot as well.
  const legacy = new PermissionManager(new PermissionPolicy(false), broker);
  const legacyChild = legacy.childView({ id: "sub-2", label: "Legacy child" });
  const read = await legacyChild.check({ action: Action.READ, target: "a.txt" });
  assert.equal(read, Decision.ALLOW); // broker answers
  assert.equal(broker.requests.length, 1);
});

test("childView fails closed without a parent broker and observes a throwing broker", async () => {
  const noBrokerParent = new PermissionManager(
    new PermissionPolicy(ApprovalMode.ASK),
    null,
  );
  let requests = 0;
  const orphan = noBrokerParent.childView(
    { id: "sub-3", label: "No broker" },
    {
      onRequest: () => {
        requests += 1;
      },
    },
  );
  assert.equal(
    await orphan.check({ action: Action.WRITE, target: "a.txt" }),
    Decision.DENY,
  );
  assert.equal(requests, 0);
  // Reads are still free (the policy snapshot is ask).
  assert.equal(
    await orphan.check({ action: Action.READ, target: "a.txt" }),
    Decision.ALLOW,
  );

  const resolved: Decision[] = [];
  const throwing: ApprovalBroker = {
    approve() {
      throw new Error("broker exploded");
    },
  };
  const child = new PermissionManager(
    new PermissionPolicy(ApprovalMode.ASK),
    throwing,
  ).childView(
    { id: "sub-4", label: "Throwing broker" },
    { onResolved: (_request, decision) => resolved.push(decision) },
  );
  await assert.rejects(
    child.check({ action: Action.WRITE, target: "a.txt" }),
    /broker exploded/,
  );
  assert.deepEqual(resolved, [Decision.DENY]);
});

test("Workspace.childView shares confinement, shell and the late-installed undo seam", async () => {
  const { root, cleanup } = tmpdir();
  try {
    const records: Array<{ action: string; path: string; preExists: boolean }> = [];
    const parent = new Workspace(
      root,
      new PermissionManager(new PermissionPolicy(ApprovalMode.ALLOW_ALL)),
    );
    const child = parent.childView({ id: "sub-5", label: "Writer" });
    // The recorder is installed AFTER the view exists: the shared seam must
    // still capture the child's mutation.
    parent.setMutationRecorder((record) =>
      records.push({
        action: record.action,
        path: record.path,
        preExists: record.pre.exists,
      }),
    );

    const wrote = await child.write_file("a.txt", "hello\n");
    assert.equal(wrote.status, "ok");
    assert.equal(fs.readFileSync(path.join(root, "a.txt"), "utf-8"), "hello\n");
    assert.deepEqual(records, [{ action: "write", path: "a.txt", preExists: false }]);

    assert.equal(child.root, parent.root);
    assert.equal(child.shell, parent.shell);
    const escaped = await child.write_file("../escape.txt", "nope");
    assert.equal(escaped.status, "error");
    assert.match(String(escaped.error), /escapes the workspace/);
    const sensitive = await child.write_file(".env", "secret");
    assert.equal(sensitive.status, "error");
    assert.match(String(sensitive.error), /sensitive file refused/);
    // The child view's policy is distinct from the parent's manager.
    assert.notEqual(child.permissions, parent.permissions);
    assert.notEqual(child.permissions.policy, parent.permissions.policy);
  } finally {
    cleanup();
  }
});

test("a child workspace parks on the parent broker and reports a denial as a tool result", async () => {
  const { root, cleanup } = tmpdir();
  try {
    const broker = new RecordingBroker(Decision.DENY);
    const parent = new Workspace(
      root,
      new PermissionManager(new PermissionPolicy(ApprovalMode.ASK), broker),
    );
    const child = parent.childView({ id: "sub-6", label: "Denied writer" });
    const denied = await child.write_file("blocked.txt", "nope");
    assert.equal(denied.status, "denied");
    assert.match(String(denied.error), /permission denied for write on blocked.txt/);
    assert.equal(fs.existsSync(path.join(root, "blocked.txt")), false);
    assert.equal(broker.requests.length, 1);
    assert.equal(broker.requests[0]?.subagent_id, "sub-6");
  } finally {
    cleanup();
  }
});
