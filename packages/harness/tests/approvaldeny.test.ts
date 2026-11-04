/**
 * Approval-deny repeat cap: a stubborn model that keeps re-requesting the
 * same denied `(action, target)` mutation must not park a run in `waiting`
 * forever. Two operator denials of one pair are honored by asking again;
 * from the third identical request on the harness auto-denies without
 * touching the workspace's PermissionManager broker. Different targets and
 * actions still reach the operator.
 *
 * Hermetic: a real `Workspace` over a temp directory, a counting denying
 * broker, and the offline mock provider. Run with: `node tests/run-all.ts`.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { resolveConfig } from "../src/config.ts";
import { TwoBrothersHarness, APPROVAL_DENY_LIMIT } from "../src/harness.ts";
import { MockProvider } from "../src/provider.ts";
import {
  CallbackBroker,
  Decision,
  PermissionManager,
  type ApprovalRequest,
} from "../src/permissions.ts";
import { Workspace } from "../src/workspace.ts";

const cfg = () => resolveConfig({ provider: "mock", mode: "work" });

interface Fixture {
  root: string;
  workspace: Workspace;
  brokerCalls: ApprovalRequest[];
}

function makeWorkspace(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-approval-deny-"));
  const brokerCalls: ApprovalRequest[] = [];
  const broker = new CallbackBroker((request) => {
    brokerCalls.push(request);
    return Decision.DENY;
  });
  const workspace = new Workspace(root, new PermissionManager(null, broker));
  return { root, workspace, brokerCalls };
}

function toolCalls(
  calls: Array<{ tool: string; args: Record<string, unknown> }>,
): MockProvider {
  return new MockProvider(calls);
}

function write(pathName: string, content: string): { tool: string; args: Record<string, unknown> } {
  return { tool: "workspace_write_file", args: { path: pathName, content } };
}

test("a pair denied twice is auto-denied on the third identical request", async () => {
  const fixture = makeWorkspace();
  try {
    const events: Array<Record<string, any>> = [];
    const harness = new TwoBrothersHarness(cfg(), {
      junior: toolCalls([
        write("notes.txt", "one"),
        write("notes.txt", "two"),
        write("notes.txt", "three"),
        write("other.txt", "elsewhere"),
        { tool: "workspace_run_shell", args: { command: "echo hi" } },
      ]),
      senior: new MockProvider(),
      workspace: fixture.workspace,
      onEvent: (event) => events.push(event as Record<string, any>),
    });

    const result = await harness.run("write the notes twice, then again");

    // exactly two operator prompts for notes.txt; the third never reached it
    const noteRequests = fixture.brokerCalls.filter((request) => request.target === "notes.txt");
    assert.equal(noteRequests.length, APPROVAL_DENY_LIMIT);
    for (const request of noteRequests) assert.equal(request.action, "write");
    // different target and different action still reach the operator
    assert.equal(
      fixture.brokerCalls.filter((request) => request.target === "other.txt").length,
      1,
    );
    assert.equal(
      fixture.brokerCalls.filter((request) => request.action === "shell").length,
      1,
    );
    assert.equal(fixture.brokerCalls.length, APPROVAL_DENY_LIMIT + 2);

    // runtime events reuse the workspace's denied representation
    const completed = events.filter(
      (event) => event.type === "tool_completed" && event.tool === "workspace_write_file",
    );
    const noteResults = completed.filter((event) => event.result?.path === "notes.txt");
    assert.equal(noteResults.length, 3);
    assert.deepEqual(
      noteResults.map((event) => event.status),
      ["denied", "denied", "denied"],
    );
    assert.match(String(noteResults[2].result.error), /auto-denied/);
    assert.doesNotMatch(String(noteResults[0].result.error), /auto-denied/);

    // nothing was written
    assert.equal(fs.existsSync(path.join(fixture.root, "notes.txt")), false);

    // the auto-denial is visible to the model as tool evidence
    const deliverable = result.messages[2].payload;
    const artifactLines = (deliverable.artifacts as string[]) ?? [];
    assert.ok(
      artifactLines.some((line) => line.includes("auto-denied")),
      `expected auto-denial evidence, got: ${artifactLines.join(" | ")}`,
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("the deny cap is per run: a fresh run asks the operator again", async () => {
  const fixture = makeWorkspace();
  try {
    const build = (): TwoBrothersHarness =>
      new TwoBrothersHarness(cfg(), {
        junior: toolCalls([write("notes.txt", "one"), write("notes.txt", "two")]),
        senior: new MockProvider(),
        workspace: fixture.workspace,
      });

    await build().run("first run");
    assert.equal(fixture.brokerCalls.length, 2);

    // a fresh harness/run starts with a clean denial map
    await build().run("second run");
    assert.equal(fixture.brokerCalls.length, 4);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("read-only workspace tools never reach the approval path", async () => {
  const fixture = makeWorkspace();
  try {
    fs.writeFileSync(path.join(fixture.root, "readme.md"), "hello\n", "utf-8");
    const harness = new TwoBrothersHarness(cfg(), {
      junior: toolCalls([{ tool: "workspace_read_file", args: { path: "readme.md" } }]),
      senior: new MockProvider(),
      workspace: fixture.workspace,
    });
    const result = await harness.run("read readme.md");
    assert.equal(fixture.brokerCalls.length, 0);
    assert.ok(result.messages.length > 0);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});