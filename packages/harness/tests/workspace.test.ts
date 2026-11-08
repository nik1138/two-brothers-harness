/**
 * Workspace execution tests. Ports the original prototype's coding-tool
 * tests (removed 2026-11-04; see git history)
 * (confinement, permissions, diffs, shell runner) to node:test, plus the two
 * permission tests deferred from Stage 4 (mutation fails closed without a
 * broker; senior shell still goes through the approval broker) and an
 * end-to-end work-mode smoke with a real Workspace + CallbackBroker.
 *
 * Run with: node tests/run-all.ts (or node --test tests/)
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import {
  Action,
  CallbackBroker,
  Decision,
  PermissionDenied,
  PermissionManager,
  PermissionPolicy,
  StaticBroker,
  normalizeDecision,
  type ApprovalRequest,
} from "../src/permissions.ts";
import { ShellRunner } from "../src/shell.ts";
import {
  DELETE_APPROVAL_REASON,
  SHELL_APPROVAL_REASON,
  Workspace,
  WorkspaceError,
  isSensitivePath,
  makeDiff,
} from "../src/workspace.ts";
import { approvalPairKey } from "../src/runevents.ts";
import { resolveConfig } from "../src/config.ts";
import { SENIOR_VERIFY_TOOL_NAMES, TwoBrothersHarness } from "../src/harness.ts";
import { MockProvider } from "../src/provider.ts";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function tmpdir(): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-ws-"));
  // Windows can still hold a just-killed shell's cwd/handle for a moment, so
  // the recursive remove retries the transient EPERM/EBUSY instead of turning
  // a cleanup-only race into a suite failure (the same hardening the load and
  // reliability suites already use).
  return {
    root,
    cleanup: () =>
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }),
  };
}

const approved = (root: string): Workspace =>
  new Workspace(root, new PermissionManager(null, new StaticBroker(Decision.ALLOW)));

// ---------------------------------------------------------------------------
// PermissionManagerTest (ports PermissionManagerTest)
// ---------------------------------------------------------------------------

test("read auto-allows", async () => {
  const pm = new PermissionManager();
  const decision = await pm.check({ action: Action.READ, target: "a.txt" });
  assert.equal(decision, Decision.ALLOW);
});

test("write asks and fails closed without broker", async () => {
  const pm = new PermissionManager();
  const decision = await pm.check({ action: Action.WRITE, target: "a.txt" });
  assert.equal(decision, Decision.DENY);
});

test("static broker allow and deny", async () => {
  const allow = new PermissionManager(null, new StaticBroker(Decision.ALLOW));
  const deny = new PermissionManager(null, new StaticBroker(Decision.DENY));
  const req: ApprovalRequest = { action: Action.SHELL, command: "ls" };
  assert.equal(await allow.check(req), Decision.ALLOW);
  assert.equal(await deny.check(req), Decision.DENY);
});

test("require denies unresolved approval", async () => {
  const pm = new PermissionManager(null, new StaticBroker(Decision.ASK));
  await assert.rejects(
    () => pm.require({ action: Action.WRITE, target: "a.txt" }),
    PermissionDenied,
  );
});

test("callback broker accepts strings and async", async () => {
  const calls: ApprovalRequest[] = [];
  const broker = new CallbackBroker(async (req) => {
    calls.push(req);
    return "approve";
  });
  const pm = new PermissionManager(null, broker);
  const decision = await pm.check({ action: Action.EDIT, target: "a.txt" });
  assert.equal(decision, Decision.ALLOW);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].action, Action.EDIT);
});

test("plain callable broker", async () => {
  const pm = new PermissionManager(null, () => "reject");
  assert.equal(await pm.check({ action: Action.WRITE }), Decision.DENY);
});

test("policy can disable read auto-allow", async () => {
  const pm = new PermissionManager(new PermissionPolicy(false));
  assert.equal(await pm.check({ action: Action.READ }), Decision.DENY);
});

test("normalizeDecision maps DeepAgents-style strings", () => {
  assert.equal(normalizeDecision("approve"), Decision.ALLOW);
  assert.equal(normalizeDecision("Allow"), Decision.ALLOW);
  assert.equal(normalizeDecision("yes"), Decision.ALLOW);
  assert.equal(normalizeDecision("edit"), Decision.ASK);
  assert.equal(normalizeDecision("respond"), Decision.ASK);
  assert.equal(normalizeDecision("reject"), Decision.DENY);
  assert.equal(normalizeDecision("no"), Decision.DENY);
  assert.equal(normalizeDecision(null), Decision.DENY);
  assert.equal(normalizeDecision(undefined), Decision.DENY);
  assert.equal(normalizeDecision(Decision.ASK), Decision.ASK);
});

// ---------------------------------------------------------------------------
// PathSafetyTest (ports PathSafetyTest)
// ---------------------------------------------------------------------------

test("rejects parent traversal", () => {
  const { root, cleanup } = tmpdir();
  try {
    const ws = new Workspace(root);
    assert.throws(() => ws.resolve("../outside.txt"), WorkspaceError);
  } finally {
    cleanup();
  }
});

test("rejects absolute paths", () => {
  const { root, cleanup } = tmpdir();
  try {
    const ws = new Workspace(root);
    assert.throws(() => ws.resolve(path.join(root, "file.txt")), WorkspaceError);
  } finally {
    cleanup();
  }
});

test("rejects symlink escape", (t) => {
  const { root, cleanup } = tmpdir();
  try {
    const ws = new Workspace(root);
    const outside = path.join(path.dirname(root), `tb-outside-${process.pid}.txt`);
    fs.writeFileSync(outside, "secret", "utf-8");
    let skipped = false;
    try {
      fs.symlinkSync(outside, path.join(root, "link.txt"));
    } catch {
      t.skip("symlinks not permitted on this system");
      skipped = true;
    }
    if (!skipped) {
      assert.throws(() => ws.resolve("link.txt"), WorkspaceError);
    }
    fs.rmSync(outside, { force: true });
  } finally {
    cleanup();
  }
});

test("rejects sensitive files", () => {
  const { root, cleanup } = tmpdir();
  try {
    const ws = new Workspace(root);
    assert.throws(() => ws.resolve(".env"), WorkspaceError);
    assert.throws(() => ws.resolve("keys/server.pem"), WorkspaceError);
    assert.throws(() => ws.resolve(".ssh/id_rsa"), WorkspaceError);
    assert.equal(isSensitivePath("sub/.env"), ".env");
    assert.equal(isSensitivePath("src/main.py"), null);
  } finally {
    cleanup();
  }
});

test("allows deep paths", () => {
  const { root, cleanup } = tmpdir();
  try {
    fs.mkdirSync(path.join(root, "a", "b"), { recursive: true });
    const ws = new Workspace(root);
    assert.equal(ws.resolve("a/b"), fs.realpathSync(path.join(root, "a", "b")));
  } finally {
    cleanup();
  }
});

test("sensitive refusal happens before any permission check (both directions)", async () => {
  const { root, cleanup } = tmpdir();
  try {
    fs.writeFileSync(path.join(root, ".env"), "TOKEN=x", "utf-8");
    // even an allow-all broker must never see the request...
    let asked = 0;
    const broker = new CallbackBroker(() => {
      asked += 1;
      return Decision.ALLOW;
    });
    const ws = new Workspace(root, new PermissionManager(null, broker));
    // ...and the denial must surface even when mutations are approved
    const write = await ws.write_file(".env", "TOKEN=y");
    assert.equal(write.status, "error");
    assert.match(String(write.error), /sensitive/);
    const read = await ws.read_file(".env");
    assert.equal(read.status, "error");
    assert.match(String(read.error), /sensitive/);
    assert.equal(asked, 0, "refusal happens before the permission check");
    assert.equal(fs.readFileSync(path.join(root, ".env"), "utf-8"), "TOKEN=x");
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// ReadToolsTest (ports ReadToolsTest)
// ---------------------------------------------------------------------------

function readFixture(): { root: string; cleanup: () => void } {
  const { root, cleanup } = tmpdir();
  fs.writeFileSync(path.join(root, "hello.txt"), "hello\nworld\n", "utf-8");
  fs.mkdirSync(path.join(root, "sub"));
  fs.writeFileSync(path.join(root, "sub", "deep.txt"), "deep hello\n", "utf-8");
  return { root, cleanup };
}

test("read_file", async () => {
  const { root, cleanup } = readFixture();
  try {
    const ws = new Workspace(root);
    const result = await ws.read_file("hello.txt");
    assert.equal(result.status, "ok");
    assert.equal(result.content, "hello\nworld\n");
    assert.equal(result.tool, "read_file");
  } finally {
    cleanup();
  }
});

test("read_file truncates", async () => {
  const { root, cleanup } = readFixture();
  try {
    const ws = new Workspace(root);
    const result = await ws.read_file("hello.txt", 10);
    assert.equal(result.truncated, true);
    assert.ok(String(result.content).includes("hello"));
    assert.ok(String(result.content).includes("[truncated"));
  } finally {
    cleanup();
  }
});

test("read missing is structured error", async () => {
  const { root, cleanup } = readFixture();
  try {
    const ws = new Workspace(root);
    const result = await ws.read_file("missing.txt");
    assert.equal(result.status, "error");
    assert.ok("error" in result);
  } finally {
    cleanup();
  }
});

test("read sensitive is refused", async () => {
  const { root, cleanup } = readFixture();
  try {
    fs.writeFileSync(path.join(root, ".env"), "TOKEN=x", "utf-8");
    const ws = new Workspace(root);
    const result = await ws.read_file(".env");
    assert.equal(result.status, "error");
    assert.match(String(result.error), /sensitive/);
  } finally {
    cleanup();
  }
});

test("list_dir", async () => {
  const { root, cleanup } = readFixture();
  try {
    const ws = new Workspace(root);
    const result = await ws.list_dir(".");
    assert.equal(result.status, "ok");
    const names = Object.fromEntries(
      (result.entries as Array<{ name: string; type: string }>).map((e) => [e.name, e.type]),
    );
    assert.deepEqual(names, { "hello.txt": "file", sub: "dir" });
  } finally {
    cleanup();
  }
});

test("search_text", async () => {
  const { root, cleanup } = readFixture();
  try {
    const ws = new Workspace(root);
    const result = await ws.search_text("hello");
    assert.equal(result.status, "ok");
    assert.deepEqual(
      (result.matches as Array<{ path: string; line: number }>).map((m) => [m.path, m.line]),
      [["hello.txt", 1], ["sub/deep.txt", 1]],
    );
  } finally {
    cleanup();
  }
});

test("search is bounded", async () => {
  const { root, cleanup } = readFixture();
  try {
    const ws = new Workspace(root);
    const result = await ws.search_text("hello", ".", 1);
    assert.equal(result.truncated, true);
    assert.equal((result.matches as unknown[]).length, 1);
  } finally {
    cleanup();
  }
});

test("search skips sensitive", async () => {
  const { root, cleanup } = readFixture();
  try {
    fs.writeFileSync(path.join(root, ".env"), "hello-token", "utf-8");
    const ws = new Workspace(root);
    const result = await ws.search_text("hello-token");
    assert.deepEqual(result.matches, []);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// MutatingToolsTest (ports MutatingToolsTest)
// ---------------------------------------------------------------------------

test("write new file returns diff", async () => {
  const { root, cleanup } = tmpdir();
  try {
    const ws = new Workspace(root); // no broker: WRITE would be denied
    const denied = await ws.write_file("new.txt", "hi");
    assert.equal(denied.status, "denied");
    const ok = await approved(root).write_file("new.txt", "hi");
    assert.equal(ok.status, "ok");
    const diff = ok.diff as { added_lines: number; unified: string };
    assert.equal(diff.added_lines, 1);
    assert.ok(diff.unified.includes("+hi"));
  } finally {
    cleanup();
  }
});

test("write overwrite returns diff", async () => {
  const { root, cleanup } = tmpdir();
  try {
    const ws = approved(root);
    await ws.write_file("a.txt", "one\n");
    const result = await ws.write_file("a.txt", "two\n");
    assert.equal(result.status, "ok");
    const diff = result.diff as { unified: string; added_lines: number; removed_lines: number };
    assert.ok(diff.unified.includes("-one"));
    assert.ok(diff.unified.includes("+two"));
    assert.equal(diff.added_lines, 1);
    assert.equal(diff.removed_lines, 1);
  } finally {
    cleanup();
  }
});

test("edit_file", async () => {
  const { root, cleanup } = tmpdir();
  try {
    const ws = approved(root);
    await ws.write_file("a.txt", "foo bar\nbaz\n");
    const result = await ws.edit_file("a.txt", "bar", "qux");
    assert.equal(result.status, "ok");
    assert.equal(fs.readFileSync(path.join(root, "a.txt"), "utf-8"), "foo qux\nbaz\n");
    const diff = result.diff as { unified: string };
    assert.ok(diff.unified.includes("-foo bar"));
  } finally {
    cleanup();
  }
});

test("edit_file requires unique match", async () => {
  const { root, cleanup } = tmpdir();
  try {
    const ws = approved(root);
    await ws.write_file("a.txt", "x\nx\n");
    const result = await ws.edit_file("a.txt", "x", "y");
    assert.equal(result.status, "error");
    const ok = await ws.edit_file("a.txt", "x", "y", true);
    assert.equal(ok.status, "ok");
    assert.equal(fs.readFileSync(path.join(root, "a.txt"), "utf-8"), "y\ny\n");
  } finally {
    cleanup();
  }
});

test("edit_file not found", async () => {
  const { root, cleanup } = tmpdir();
  try {
    const ws = approved(root);
    await ws.write_file("a.txt", "abc");
    const result = await ws.edit_file("a.txt", "zzz", "y");
    assert.equal(result.status, "error");
  } finally {
    cleanup();
  }
});

test("delete_file", async () => {
  const { root, cleanup } = tmpdir();
  try {
    const ws = approved(root);
    await ws.write_file("a.txt", "x");
    const result = await ws.delete_file("a.txt");
    assert.equal(result.status, "ok");
    assert.equal(fs.existsSync(path.join(root, "a.txt")), false);
  } finally {
    cleanup();
  }
});

test("mutations are denied without broker", async () => {
  const { root, cleanup } = tmpdir();
  try {
    const wsApproved = approved(root);
    await wsApproved.write_file("a.txt", "x");
    const ws = new Workspace(root);
    assert.equal((await ws.edit_file("a.txt", "x", "y")).status, "denied");
    assert.equal((await ws.delete_file("a.txt")).status, "denied");
    assert.equal((await ws.run_shell("echo hi")).status, "denied");
    // and nothing was changed
    assert.equal(fs.readFileSync(path.join(root, "a.txt"), "utf-8"), "x");
  } finally {
    cleanup();
  }
});

test("denied write still carries the path", async () => {
  const { root, cleanup } = tmpdir();
  try {
    const ws = new Workspace(root);
    const result = await ws.write_file("a.txt", "x");
    assert.equal(result.status, "denied");
    assert.equal(result.path, "a.txt");
    assert.match(String(result.error), /permission denied for write on a\.txt/);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// DiffTest (ports DiffTest)
// ---------------------------------------------------------------------------

test("make_diff metadata", () => {
  const diff = makeDiff("f.txt", "a\nb\nc\n", "a\nB\nc\nd\n");
  assert.equal(diff.added_lines, 2);
  assert.equal(diff.removed_lines, 1);
  assert.ok(diff.unified.includes("a/f.txt"));
  assert.ok(diff.unified.includes("b/f.txt"));
});

test("make_diff matches difflib's unified format exactly", () => {
  const diff = makeDiff("f.txt", "a\nb\nc\n", "a\nB\nc\nd\n");
  assert.equal(
    diff.unified,
    "--- a/f.txt\n+++ b/f.txt\n@@ -1,3 +1,4 @@\n a\n-b\n+B\n c\n+d\n",
  );
  // empty old side: the insert starts at line 0 (difflib's empty-range rule)
  const created = makeDiff("new.txt", "", "hi");
  assert.equal(created.unified, "--- a/new.txt\n+++ b/new.txt\n@@ -0,0 +1 @@\n+hi");
});

// ---------------------------------------------------------------------------
// ShellToolTest (ports ShellToolTest)
// ---------------------------------------------------------------------------

test("run echo", async () => {
  const { root, cleanup } = tmpdir();
  try {
    const ws = approved(root);
    const result = await ws.run_shell("echo hello");
    assert.equal(result.status, "ok");
    assert.equal(result.exit_code, 0);
    assert.ok(String(result.stdout).includes("hello"));
    assert.equal(result.tool, "run_shell");
  } finally {
    cleanup();
  }
});

test("run exit status", async () => {
  const { root, cleanup } = tmpdir();
  try {
    const ws = approved(root);
    const result = await ws.run_shell("exit 3");
    assert.equal(result.exit_code, 3);
    assert.equal(result.status, "ok");
  } finally {
    cleanup();
  }
});

test("shell path extra finds interpreter", async () => {
  const { root, cleanup } = tmpdir();
  const prev = process.env.TWO_BROTHERS_SHELL_PATH_EXTRA;
  process.env.TWO_BROTHERS_SHELL_PATH_EXTRA = path.dirname(process.execPath);
  try {
    const ws = approved(root); // reads TWO_BROTHERS_SHELL_PATH_EXTRA at construction
    const result = await ws.run_shell("node --version");
    assert.equal(result.exit_code, 0, JSON.stringify(result));
    assert.ok((String(result.stdout) + String(result.stderr)).includes("v"));
  } finally {
    if (prev === undefined) delete process.env.TWO_BROTHERS_SHELL_PATH_EXTRA;
    else process.env.TWO_BROTHERS_SHELL_PATH_EXTRA = prev;
    cleanup();
  }
});

test("run timeout", async () => {
  const { root, cleanup } = tmpdir();
  try {
    const ws = approved(root);
    const cmd = `"${process.execPath}" -e "setTimeout(function(){}, 5000)"`;
    const result = await ws.run_shell(cmd, 0.5);
    assert.equal(result.status, "timeout");
    assert.equal(result.timed_out, true);
  } finally {
    cleanup();
  }
});

test("run cancelled via AbortSignal", async () => {
  const { root, cleanup } = tmpdir();
  try {
    const ws = approved(root);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 200);
    const cmd = `"${process.execPath}" -e "setTimeout(function(){}, 5000)"`;
    const result = await ws.run_shell(cmd, 30, controller.signal);
    clearTimeout(timer);
    assert.equal(result.status, "cancelled");
    assert.equal(result.cancelled, true);
    assert.ok(Number(result.duration_ms) < 5000);
  } finally {
    cleanup();
  }
});

test("run output bounded", async () => {
  const { root, cleanup } = tmpdir();
  try {
    const ws = approved(root);
    const cmd = `"${process.execPath}" -e "console.log('x'.repeat(50000))"`;
    const result = await ws.run_shell(cmd);
    assert.equal(result.truncated, true);
    assert.ok(String(result.stdout).includes("[truncated"));
    assert.ok(String(result.stdout).length < 20_500); // cap plus marker text
  } finally {
    cleanup();
  }
});

test("unknown command yields a nonzero exit code", async () => {
  const { root, cleanup } = tmpdir();
  try {
    const runner = new ShellRunner({ cwd: root });
    const result = await runner.run("definitely-not-a-real-command-tb-123");
    assert.equal(result.status, "ok");
    assert.equal(result.exit_code, 127); // bash: command not found
  } finally {
    cleanup();
  }
});

test("spawn failure (missing cwd) is a structured error", async () => {
  const { root, cleanup } = tmpdir();
  try {
    const missing = path.join(root, "no-such-dir");
    const runner = new ShellRunner({ cwd: missing });
    const result = await runner.run("echo hi");
    assert.equal(result.status, "error");
    assert.ok(String(result.error).length > 0);
    assert.equal(result.exit_code, null);
  } finally {
    cleanup();
  }
});

test("events are JSON serializable", async () => {
  const { root, cleanup } = tmpdir();
  try {
    const ws = approved(root);
    const results = [await ws.list_dir("."), await ws.run_shell("echo hi"), await ws.write_file("a.txt", "1")];
    for (const result of results) {
      JSON.stringify(result);
    }
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Deferred Stage 4 permission tests (ports test_graph.py with a real Workspace)
// ---------------------------------------------------------------------------

test("work mode: workspace mutation fails closed without broker", async () => {
  const { root, cleanup } = tmpdir();
  try {
    const events: Array<Record<string, any>> = [];
    const workspace = new Workspace(root, new PermissionManager()); // no broker: deny
    const harness = new TwoBrothersHarness(resolveConfig({ provider: "mock", mode: "work" }), {
      junior: new MockProvider([
        { tool: "workspace_write_file", args: { path: "out/result.txt", content: "done\n" } },
      ]),
      senior: new MockProvider(),
      workspace,
      onEvent: (e) => events.push(e as Record<string, any>),
    });
    const result = await harness.run("write the result file");
    assert.equal(fs.existsSync(path.join(root, "out", "result.txt")), false);
    const completed = events.filter((e) => e.type === "tool_completed");
    assert.equal(completed[0].status, "denied");
    assert.equal(completed[0].result.status, "denied");
    assert.equal(result.messages.map((m) => m.kind).at(-1), "decision");
  } finally {
    cleanup();
  }
});

test("senior shell still goes through the approval broker", async () => {
  const { root, cleanup } = tmpdir();
  try {
    const events: Array<Record<string, any>> = [];
    const workspace = new Workspace(root, new PermissionManager()); // no broker: deny
    const harness = new TwoBrothersHarness(resolveConfig({ provider: "mock", mode: "work" }), {
      junior: new MockProvider(),
      senior: new MockProvider([
        { tool: "workspace_run_shell", args: { command: "echo hacked > marker.txt" } },
      ]),
      workspace,
      onEvent: (e) => events.push(e as Record<string, any>),
    });
    const result = await harness.run("write the result file");
    assert.equal(fs.existsSync(path.join(root, "marker.txt")), false); // shell never ran
    const seniorCompleted = events.filter(
      (e) => e.type === "tool_completed" && e.actor === "senior",
    );
    assert.equal(seniorCompleted[0].tool, "workspace_run_shell");
    assert.equal(seniorCompleted[0].status, "denied");
    const review = result.messages[3].payload;
    assert.ok(
      (review.points as string[]).some(
        (p) => p.includes("workspace_run_shell") && p.includes("denied"),
      ),
    );
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Approval reasons: honest, stable, additive (shell + delete only)
// ---------------------------------------------------------------------------

test("shell and delete approvals carry honest reasons; write and edit carry none", async () => {
  const { root, cleanup } = tmpdir();
  try {
    const requests: ApprovalRequest[] = [];
    const broker = new CallbackBroker((request) => {
      requests.push(request);
      return Decision.ALLOW;
    });
    const ws = new Workspace(root, new PermissionManager(null, broker));
    await ws.write_file("notes.txt", "one\n");
    await ws.edit_file("notes.txt", "one", "two");
    await ws.run_shell("echo hi");
    await ws.write_file("doomed.txt", "bye\n");
    await ws.delete_file("doomed.txt");

    assert.deepEqual(
      requests.map((request) => request.action),
      [Action.WRITE, Action.EDIT, Action.SHELL, Action.WRITE, Action.DELETE],
    );
    const requestsFor = (action: Action): ApprovalRequest[] =>
      requests.filter((request) => request.action === action);

    // Shell: the operator genuinely cannot preview the effects of arbitrary
    // code, so the request carries one stable, path- and command-free reason.
    const shell = requestsFor(Action.SHELL);
    assert.equal(shell.length, 1);
    assert.equal(shell[0]?.reason, SHELL_APPROVAL_REASON);
    assert.ok(SHELL_APPROVAL_REASON.length > 0 && SHELL_APPROVAL_REASON.length <= 200);
    assert.doesNotMatch(SHELL_APPROVAL_REASON, /[\r\n]/);
    assert.equal(SHELL_APPROVAL_REASON.includes(root), false, "no workspace path leaks");
    assert.equal(SHELL_APPROVAL_REASON.includes("echo hi"), false, "no command echo");

    // Delete: permanent and undoable, so it states that.
    const removed = requestsFor(Action.DELETE);
    assert.equal(removed.length, 1);
    assert.equal(removed[0]?.reason, DELETE_APPROVAL_REASON);
    assert.ok(DELETE_APPROVAL_REASON.length > 0 && DELETE_APPROVAL_REASON.length <= 200);
    assert.doesNotMatch(DELETE_APPROVAL_REASON, /[\r\n]/);
    assert.equal(DELETE_APPROVAL_REASON.includes(root), false, "no workspace path leaks");

    // Write/edit stay reason-free: their diff preview is the explanation.
    for (const request of [...requestsFor(Action.WRITE), ...requestsFor(Action.EDIT)]) {
      assert.equal(request.reason, "", `${request.action} must not invent a reason`);
    }
    const reasons = new Set([SHELL_APPROVAL_REASON, DELETE_APPROVAL_REASON]);
    assert.equal(reasons.size, 2, "the two reasons are distinct, stable strings");
  } finally {
    cleanup();
  }
});

test("approvalPairKey is unaffected by the reason field", () => {
  const writeWithout: ApprovalRequest = { action: Action.WRITE, target: "notes.txt" };
  const writeWith: ApprovalRequest = { ...writeWithout, reason: "anything" };
  assert.equal(approvalPairKey(writeWith), approvalPairKey(writeWithout));

  const shellWithout: ApprovalRequest = { action: Action.SHELL, command: "echo hi" };
  const shellWith: ApprovalRequest = { ...shellWithout, reason: SHELL_APPROVAL_REASON };
  assert.equal(approvalPairKey(shellWith), approvalPairKey(shellWithout));

  const deleteWithout: ApprovalRequest = { action: Action.DELETE, target: "doomed.txt" };
  const deleteWith: ApprovalRequest = { ...deleteWithout, reason: DELETE_APPROVAL_REASON };
  assert.equal(approvalPairKey(deleteWith), approvalPairKey(deleteWithout));
});

// ---------------------------------------------------------------------------
// End-to-end smoke: work-mode run with a real workspace and auto-approvals
// ---------------------------------------------------------------------------

test("work mode end-to-end: junior writes, senior verifies, evidence in payloads", async () => {
  const { root, cleanup } = tmpdir();
  try {
    const approvals: ApprovalRequest[] = [];
    const broker = new CallbackBroker((req) => {
      approvals.push(req);
      return "approve";
    });
    const workspace = new Workspace(root, new PermissionManager(null, broker));
    const harness = new TwoBrothersHarness(resolveConfig({ provider: "mock", mode: "work" }), {
      junior: new MockProvider([
        { tool: "workspace_write_file", args: { path: "out/result.txt", content: "done\n" } },
        { tool: "workspace_run_shell", args: { command: "echo checked > marker.txt" } },
      ]),
      senior: new MockProvider([
        { tool: "workspace_read_file", args: { path: "out/result.txt" } },
      ]),
      workspace,
      onEvent: () => {},
    });
    const result = await harness.run("write and verify the result file");

    // the mutations actually happened, inside the workspace root
    assert.equal(fs.readFileSync(path.join(root, "out", "result.txt"), "utf-8"), "done\n");
    assert.equal(fs.readFileSync(path.join(root, "marker.txt"), "utf-8").trim(), "checked");

    // both mutations went through the broker (reads auto-allow, no request)
    assert.deepEqual(
      approvals.map((a) => a.action),
      [Action.WRITE, Action.SHELL],
    );
    assert.equal(approvals[0].target, "out/result.txt");

    // envelope flow is unchanged
    assert.deepEqual(
      result.messages.map((m) => m.kind),
      ["message", "delegation", "deliverable", "review", "decision"],
    );

    // the deliverable carries clipped tool evidence for the senior
    const deliverable = result.messages[2].payload;
    assert.ok(
      (deliverable.artifacts as string[]).some((a) => a.startsWith("tool: workspace_write_file")),
    );
    assert.ok(
      (deliverable.artifacts as string[]).some((a) => a.startsWith("tool: workspace_run_shell")),
    );

    // the review is grounded in the senior's own read of the file
    const review = result.messages[3].payload;
    assert.equal(review.verdict, "accept");
    assert.ok(
      (review.points as string[]).some((p) => p.startsWith("verify: workspace_read_file")),
    );

    // the senior's verify slice is exactly the read-only tool names
    assert.ok(SENIOR_VERIFY_TOOL_NAMES.has("workspace_read_file"));
    assert.ok(!SENIOR_VERIFY_TOOL_NAMES.has("workspace_write_file"));
  } finally {
    cleanup();
  }
});
