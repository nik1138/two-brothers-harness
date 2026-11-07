/**
 * Approval modes and guardrails (Wave 4, lane C).
 *
 * Covers the mode decision table (ask/readonly/edits/allow-all) at the
 * `PermissionPolicy`/`PermissionManager` level with and without a broker, the
 * fail-closed normalization of untrusted mode strings, workspace-level
 * enforcement (readonly denies without parking; allow-all opts out; workspace
 * confinement and the sensitive-path refusal still run first), the broker
 * never being able to widen the mode, and the CLI surface (`--approval-mode`
 * flag/env, the allow-all warning line, the usage-error exit code, help).
 *
 * Persistence is covered by `settings.test.ts` and the HTTP/run wiring by
 * `server.test.ts`; the broker deny/session-allow semantics stay in
 * `approvalbrokerdeny.test.ts`.
 *
 * Hermetic: no network, no provider calls (mock only), temp dirs per test.
 * Run with: node --test tests/approvalmodes.test.ts
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { main, type CliIO } from "../src/cli.ts";
import { resolveConfig } from "../src/config.ts";
import {
  Action,
  APPROVAL_MODE_INFO,
  APPROVAL_MODES,
  ApprovalMode,
  DEFAULT_APPROVAL_MODE,
  Decision,
  PermissionDenied,
  PermissionManager,
  PermissionPolicy,
  StaticBroker,
  approvalModeWarning,
  isApprovalMode,
  normalizeApprovalMode,
  resolveApprovalMode,
  type ApprovalRequest,
  type ApprovalBroker,
  type BrokerAnswer,
} from "../src/permissions.ts";
import { RunApprovalBroker } from "../src/runevents.ts";
import { Workspace } from "../src/workspace.ts";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function tmpdir(): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-approval-modes-"));
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

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

interface RecordingBroker extends ApprovalBroker {
  readonly requests: ApprovalRequest[];
  answer: BrokerAnswer;
}

/** A broker that records every ask and answers with a settable value. */
function recordingBroker(answer: BrokerAnswer = Decision.ALLOW): RecordingBroker {
  const broker: RecordingBroker = {
    requests: [],
    answer,
    approve(request: ApprovalRequest): BrokerAnswer {
      broker.requests.push(request);
      return broker.answer;
    },
  };
  return broker;
}

const ALL_ACTIONS: readonly Action[] = [
  Action.READ,
  Action.WRITE,
  Action.EDIT,
  Action.DELETE,
  Action.SHELL,
];

function requestFor(action: Action): ApprovalRequest {
  return action === Action.SHELL
    ? { action, command: "echo hi" }
    : { action, target: "a.txt" };
}

/** Set env vars for the duration of `fn`, restoring the previous state. */
async function withEnv(
  values: Record<string, string>,
  fn: () => Promise<void>,
): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(values)) saved[key] = process.env[key];
  Object.assign(process.env, values);
  try {
    await fn();
  } finally {
    for (const [key, prev] of Object.entries(saved)) {
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    }
  }
}

function makeIO(): CliIO & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, log: (line) => out.push(line), error: (line) => err.push(line) };
}

// ---------------------------------------------------------------------------
// mode constants and strict normalization
// ---------------------------------------------------------------------------

test("APPROVAL_MODES is the exact four-mode enum with ask as the fail-closed default", () => {
  assert.deepEqual(APPROVAL_MODES, ["ask", "readonly", "edits", "allow-all"]);
  assert.equal(DEFAULT_APPROVAL_MODE, ApprovalMode.ASK);
  assert.equal(APPROVAL_MODES.includes("allow-all"), true);
  // every mode has honest operator copy; only allow-all carries the danger text
  for (const mode of APPROVAL_MODES) {
    const info = APPROVAL_MODE_INFO[mode];
    assert.equal(info.mode, mode);
    assert.ok(info.label.length > 0, `${mode} needs a label`);
    assert.ok(info.description.length > 0, `${mode} needs a description`);
    assert.equal(
      info.danger !== undefined,
      mode === ApprovalMode.ALLOW_ALL,
      `only allow-all carries danger copy (${mode})`,
    );
  }
  // the CLI/server warning is derived from the same table
  for (const mode of [ApprovalMode.ASK, ApprovalMode.READONLY, ApprovalMode.EDITS]) {
    assert.equal(approvalModeWarning(mode), null, `${mode} keeps the operator in the loop`);
  }
  const warning = approvalModeWarning(ApprovalMode.ALLOW_ALL);
  assert.ok(warning !== null);
  assert.match(warning!, /^approval mode "allow-all":/);
  assert.match(warning!, /irreversible change/);
});

test("normalizeApprovalMode is a strict enum; resolveApprovalMode fails closed to ask", () => {
  for (const mode of APPROVAL_MODES) {
    assert.equal(normalizeApprovalMode(mode), mode);
    assert.equal(isApprovalMode(mode), true);
  }
  // surrounding whitespace is tolerated, the value itself is not translated
  assert.equal(normalizeApprovalMode("  readonly  "), "readonly");
  for (const bad of [
    "READONLY",
    "Readonly",
    "read-only",
    "auto",
    "never",
    "yolo",
    "allow all",
    "",
    "   ",
    42,
    null,
    undefined,
    {},
    ["ask"],
  ]) {
    assert.equal(normalizeApprovalMode(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
  // a confused value never becomes a more permissive mode
  for (const bad of ["auto", "allow_all", "ALLOW-ALL", 42, null, undefined]) {
    assert.equal(resolveApprovalMode(bad), ApprovalMode.ASK);
  }
  assert.equal(resolveApprovalMode("edits"), "edits");
});

// ---------------------------------------------------------------------------
// the decision matrix
// ---------------------------------------------------------------------------

/** Expected decisions per mode: read, write, edit, delete, shell. */
const MATRIX: Readonly<Record<string, readonly Decision[]>> = {
  ask: [Decision.ALLOW, Decision.ASK, Decision.ASK, Decision.ASK, Decision.ASK],
  readonly: [Decision.ALLOW, Decision.DENY, Decision.DENY, Decision.DENY, Decision.DENY],
  edits: [Decision.ALLOW, Decision.ALLOW, Decision.ALLOW, Decision.ASK, Decision.ASK],
  "allow-all": [
    Decision.ALLOW,
    Decision.ALLOW,
    Decision.ALLOW,
    Decision.ALLOW,
    Decision.ALLOW,
  ],
};

test("each mode applies its fixed decision table when no broker is configured", async () => {
  for (const mode of APPROVAL_MODES) {
    const manager = new PermissionManager(new PermissionPolicy(mode));
    const decisions: Decision[] = [];
    for (const action of ALL_ACTIONS) decisions.push(await manager.check(requestFor(action)));
    // ASK without a broker is fail-closed DENY
    const expected = MATRIX[mode].map((decision) =>
      decision === Decision.ASK ? Decision.DENY : decision,
    );
    assert.deepEqual(decisions, expected, `no-broker matrix for ${mode}`);
  }
});

test("each mode applies its fixed decision table with an allow-once broker", async () => {
  for (const mode of APPROVAL_MODES) {
    const manager = new PermissionManager(new PermissionPolicy(mode), new StaticBroker());
    const decisions: Decision[] = [];
    for (const action of ALL_ACTIONS) decisions.push(await manager.check(requestFor(action)));
    // an ASK is answered by the broker (allow-once here); readonly never asks
    const expected = MATRIX[mode].map((decision) =>
      decision === Decision.ASK ? Decision.ALLOW : decision,
    );
    assert.deepEqual(decisions, expected, `broker matrix for ${mode}`);
  }
});

test("ask keeps the historical behavior: reads free, mutations park on the operator", async () => {
  const broker = recordingBroker();
  const manager = new PermissionManager(new PermissionPolicy(), broker);
  assert.equal(await manager.check(requestFor(Action.READ)), Decision.ALLOW);
  assert.equal(broker.requests.length, 0, "reads never reach the broker");
  assert.equal(await manager.check(requestFor(Action.WRITE)), Decision.ALLOW);
  assert.equal(broker.requests.length, 1);
  assert.equal(broker.requests[0]?.action, Action.WRITE);
  // the legacy boolean constructor still turns read auto-allow off
  const strictReads = new PermissionPolicy(false);
  assert.equal(strictReads.mode, ApprovalMode.ASK);
  assert.equal(strictReads.autoAllowRead, false);
  assert.equal(await new PermissionManager(strictReads).check(requestFor(Action.READ)), Decision.DENY);
});

test("readonly denies mutations and shell deterministically: the broker is never consulted", async () => {
  const broker = recordingBroker();
  const manager = new PermissionManager(new PermissionPolicy(ApprovalMode.READONLY), broker);
  for (const action of [Action.WRITE, Action.EDIT, Action.DELETE, Action.SHELL]) {
    assert.equal(await manager.check(requestFor(action)), Decision.DENY, action);
  }
  assert.deepEqual(broker.requests, [], "a readonly mode never asks anyone");
  // reads still flow without the broker
  assert.equal(await manager.check(requestFor(Action.READ)), Decision.ALLOW);
});

test("edits auto-allows write/edit but keeps delete and shell on the operator", async () => {
  const broker = recordingBroker();
  const manager = new PermissionManager(new PermissionPolicy(ApprovalMode.EDITS), broker);
  assert.equal(await manager.check(requestFor(Action.WRITE)), Decision.ALLOW);
  assert.equal(await manager.check(requestFor(Action.EDIT)), Decision.ALLOW);
  assert.equal(broker.requests.length, 0, "write/edit never ask in edits mode");
  assert.equal(await manager.check(requestFor(Action.DELETE)), Decision.ALLOW);
  assert.equal(await manager.check(requestFor(Action.SHELL)), Decision.ALLOW);
  assert.deepEqual(
    broker.requests.map((request) => request.action),
    [Action.DELETE, Action.SHELL],
  );
});

test("allow-all auto-allows every action without consulting a broker", async () => {
  const broker = recordingBroker();
  const manager = new PermissionManager(new PermissionPolicy(ApprovalMode.ALLOW_ALL), broker);
  for (const action of ALL_ACTIONS) {
    assert.equal(await manager.check(requestFor(action)), Decision.ALLOW, action);
  }
  assert.deepEqual(broker.requests, []);
  // ... and works with no broker at all (the explicit opt-in path)
  const bare = new PermissionManager(new PermissionPolicy(ApprovalMode.ALLOW_ALL));
  for (const action of ALL_ACTIONS) {
    assert.equal(await bare.check(requestFor(action)), Decision.ALLOW, action);
  }
});

test("a broker answer can never widen the policy: unknown answers fail closed", async () => {
  // DeepAgents-style strings still normalize, but they can only choose among
  // allow/deny/ask — a policy name is not a decision.
  const manager = new PermissionManager(
    new PermissionPolicy(ApprovalMode.ASK),
    new StaticBroker("allow-all" as Decision),
  );
  assert.equal(await manager.check(requestFor(Action.WRITE)), Decision.DENY);
  const spelledOut = new PermissionManager(
    new PermissionPolicy(ApprovalMode.ASK),
    new StaticBroker("ask" as Decision),
  );
  // "ask" is a legitimate re-ask answer: it resolves to ASK, never to allow,
  // so a `require` still fails closed.
  assert.equal(await spelledOut.check(requestFor(Action.WRITE)), Decision.ASK);
  // readonly closes the question even when the broker would say allow
  assert.equal(
    await new PermissionManager(new PermissionPolicy(ApprovalMode.READONLY), new StaticBroker()).check(
      requestFor(Action.WRITE),
    ),
    Decision.DENY,
  );
});

test("require() raises a structured PermissionDenied naming the action and target", async () => {
  const manager = new PermissionManager(new PermissionPolicy(ApprovalMode.READONLY));
  await assert.rejects(
    manager.require({ action: Action.WRITE, target: "a.txt" }),
    (exc: unknown) =>
      exc instanceof PermissionDenied &&
      /permission denied for write on a\.txt/.test(exc.message),
  );
  // an allowed action never throws
  await manager.require({ action: Action.READ, target: "a.txt" });
});

// ---------------------------------------------------------------------------
// workspace enforcement
// ---------------------------------------------------------------------------

test("readonly: workspace mutations are denied with no parked approval; reads still work", async () => {
  const tmp = tmpdir();
  try {
    fs.writeFileSync(path.join(tmp.root, "existing.txt"), "hello\n");
    const broker = new RunApprovalBroker();
    const events: Array<Record<string, unknown>> = [];
    broker.attach((event) => events.push(event as unknown as Record<string, unknown>), null);
    const workspace = new Workspace(
      tmp.root,
      new PermissionManager(new PermissionPolicy(ApprovalMode.READONLY), broker),
    );

    assert.equal((await workspace.read_file("existing.txt")).status, "ok");

    const write = await workspace.write_file("new.txt", "x\n");
    assert.equal(write.status, "denied");
    assert.equal(fs.existsSync(path.join(tmp.root, "new.txt")), false);

    const edit = await workspace.edit_file("existing.txt", "hello", "bye");
    assert.equal(edit.status, "denied");
    assert.equal(fs.readFileSync(path.join(tmp.root, "existing.txt"), "utf-8"), "hello\n");

    const del = await workspace.delete_file("existing.txt");
    assert.equal(del.status, "denied");
    assert.equal(fs.existsSync(path.join(tmp.root, "existing.txt")), true);

    const shell = await workspace.run_shell("echo hi");
    assert.equal(shell.status, "denied");

    assert.deepEqual(broker.pending(), [], "readonly must never park an approval");
    assert.equal(
      events.filter((event) => event.type === "approval_requested").length,
      0,
      "readonly emits no approval_requested events",
    );
    assert.equal(
      events.filter((event) => event.type === "run_status").length,
      0,
      "no approval-driven status changes",
    );
  } finally {
    tmp.cleanup();
  }
});

test("allow-all: workspace mutations run without a broker", async () => {
  const tmp = tmpdir();
  try {
    const workspace = new Workspace(
      tmp.root,
      new PermissionManager(new PermissionPolicy(ApprovalMode.ALLOW_ALL)),
    );
    const write = await workspace.write_file("notes.txt", "first\n");
    assert.equal(write.status, "ok");
    assert.equal(fs.readFileSync(path.join(tmp.root, "notes.txt"), "utf-8"), "first\n");

    const edit = await workspace.edit_file("notes.txt", "first", "second", false);
    assert.equal(edit.status, "ok");
    assert.equal(fs.readFileSync(path.join(tmp.root, "notes.txt"), "utf-8"), "second\n");

    const del = await workspace.delete_file("notes.txt");
    assert.equal(del.status, "ok");
    assert.equal(fs.existsSync(path.join(tmp.root, "notes.txt")), false);
  } finally {
    tmp.cleanup();
  }
});

test("confinement and sensitive-path refusal run before permissions, even under allow-all", async () => {
  const tmp = tmpdir();
  try {
    const broker = recordingBroker();
    const workspace = new Workspace(
      tmp.root,
      new PermissionManager(new PermissionPolicy(ApprovalMode.ALLOW_ALL), broker),
    );
    // A sensitive file is refused by Workspace.resolve, before any permission
    // check: allow-all cannot write it and the broker is never consulted.
    const env = await workspace.write_file(".env", "SECRET=1\n");
    assert.equal(env.status, "error");
    assert.match(String(env.error ?? ""), /sensitive file refused/);
    // Reads are confined too; the mode never widens a read.
    const readEnv = await workspace.read_file(".env");
    assert.equal(readEnv.status, "error");
    assert.match(String(readEnv.error ?? ""), /sensitive file refused/);
    // Parent traversal is refused before permissions as well.
    const escape = await workspace.write_file("../escape.txt", "nope\n");
    assert.equal(escape.status, "error");
    assert.match(String(escape.error ?? ""), /escapes the workspace/);
    // Same for deletes.
    const del = await workspace.delete_file("../escape.txt");
    assert.equal(del.status, "error");
    assert.deepEqual(broker.requests, [], "a refused path never reaches the approval broker");
  } finally {
    tmp.cleanup();
  }
});

test("edits: a workspace write proceeds without approval, a delete still parks", async () => {
  const tmp = tmpdir();
  try {
    fs.writeFileSync(path.join(tmp.root, "doomed.txt"), "bye\n");
    const broker = new RunApprovalBroker();
    const events: Array<Record<string, unknown>> = [];
    broker.attach((event) => events.push(event as unknown as Record<string, unknown>), null);
    const workspace = new Workspace(
      tmp.root,
      new PermissionManager(new PermissionPolicy(ApprovalMode.EDITS), broker),
    );

    assert.equal((await workspace.write_file("notes.txt", "x\n")).status, "ok");
    assert.deepEqual(broker.pending(), [], "a write never parks in edits mode");

    const pendingDelete = workspace.delete_file("doomed.txt");
    await waitFor(() => broker.pending().length === 1, "the delete approval to park");
    assert.equal(broker.respond(String(broker.pending()[0].approval_id), Decision.DENY), Decision.DENY);
    assert.equal((await pendingDelete).status, "denied");
    assert.equal(fs.existsSync(path.join(tmp.root, "doomed.txt")), true);
    assert.equal(
      events.filter((event) => event.type === "approval_requested").length,
      1,
      "only the delete asked",
    );
  } finally {
    tmp.cleanup();
  }
});

test("ask (default) still parks a workspace write until the operator answers", async () => {
  const tmp = tmpdir();
  try {
    const broker = new RunApprovalBroker();
    const workspace = new Workspace(tmp.root, new PermissionManager(new PermissionPolicy(), broker));
    const pendingWrite = workspace.write_file("hello.txt", "hello\n");
    await waitFor(() => broker.pending().length === 1, "the default ask to park");
    assert.equal(
      broker.respond(String(broker.pending()[0].approval_id), Decision.ALLOW),
      Decision.ALLOW,
    );
    assert.equal((await pendingWrite).status, "ok");
    assert.equal(fs.readFileSync(path.join(tmp.root, "hello.txt"), "utf-8"), "hello\n");
  } finally {
    tmp.cleanup();
  }
});

// ---------------------------------------------------------------------------
// configuration + CLI surface
// ---------------------------------------------------------------------------

test("resolveConfig: approval mode flag/env, strict validation, ask default", async () => {
  assert.equal(resolveConfig({}).approvalMode, ApprovalMode.ASK);
  assert.equal(resolveConfig({ approvalMode: "readonly" }).approvalMode, "readonly");
  assert.equal(resolveConfig({ approvalMode: "allow-all" }).approvalMode, "allow-all");
  assert.throws(
    () => resolveConfig({ approvalMode: "auto" }),
    /invalid approval mode: auto \(use ask\|readonly\|edits\|allow-all\)/,
  );
  await withEnv({ TWO_BROTHERS_APPROVAL_MODE: "edits" }, async () => {
    assert.equal(resolveConfig({}).approvalMode, "edits");
    // a flag wins over the env value
    assert.equal(resolveConfig({ approvalMode: "readonly" }).approvalMode, "readonly");
  });
  await withEnv({ TWO_BROTHERS_APPROVAL_MODE: "bogus" }, async () => {
    assert.throws(() => resolveConfig({}), /invalid approval mode: bogus/);
  });
});

test("CLI: allow-all prints one visible stderr warning per run; quiet modes stay quiet", async () => {
  const allowAll = makeIO();
  assert.equal(
    await main(["run", "Say hi", "--provider", "mock", "--approval-mode", "allow-all"], allowAll),
    0,
  );
  const warnings = allowAll.err.filter((line) => line.includes("approval mode"));
  assert.equal(warnings.length, 1, `exactly one warning, got: ${allowAll.err.join("\n")}`);
  assert.match(warnings[0]!, /^\[warn\] approval mode "allow-all":/);

  for (const mode of ["ask", "readonly", "edits"]) {
    const quiet = makeIO();
    assert.equal(
      await main(["run", "Say hi", "--provider", "mock", "--approval-mode", mode], quiet),
      0,
      mode,
    );
    assert.equal(
      quiet.err.filter((line) => line.includes("approval mode")).length,
      0,
      `${mode} must not warn`,
    );
  }
});

test("CLI: an invalid --approval-mode is a usage error (exit 2), never a crash", async () => {
  const io = makeIO();
  assert.equal(
    await main(["run", "Say hi", "--provider", "mock", "--approval-mode", "auto"], io),
    2,
  );
  assert.match(io.err[0]!, /^\[error\] invalid approval mode: auto/);
  assert.ok(io.err.some((line) => /^Usage: two-brothers run/.test(line)), io.err.join("\n"));
  assert.ok(io.err.some((line) => line.includes("run --help")));

  const chat = makeIO();
  assert.equal(
    await main(["chat", "--provider", "mock", "--approval-mode", "never"], chat),
    2,
  );
  assert.match(chat.err[0]!, /^\[error\] invalid approval mode: never/);

  // serve validates before listening (no server is started by this call)
  const serve = makeIO();
  assert.equal(
    await main(["serve", "--approval-mode", "allow_all", "--port", "0"], serve),
    2,
  );
  assert.match(serve.err[0]!, /^\[error\] invalid approval mode: allow_all/);

  // an env-provided invalid value is reported the same way
  await withEnv({ TWO_BROTHERS_APPROVAL_MODE: "nope" }, async () => {
    const env = makeIO();
    assert.equal(await main(["run", "Say hi", "--provider", "mock"], env), 2);
    assert.match(env.err[0]!, /^\[error\] invalid approval mode: nope/);
  });
});

test("CLI: run/serve help and the full reference document --approval-mode and its env", async () => {
  const runHelp = makeIO();
  assert.equal(await main(["run", "--help"], runHelp), 0);
  const runText = runHelp.out.join("\n");
  assert.match(runText, /--approval-mode <mode>/);
  assert.match(runText, /ask\|readonly\|edits\|allow-all/);

  const serveHelp = makeIO();
  assert.equal(await main(["serve", "--help"], serveHelp), 0);
  assert.match(serveHelp.out.join("\n"), /--approval-mode/);

  const all = makeIO();
  assert.equal(await main(["help", "--all"], all), 0);
  assert.match(all.out.join("\n"), /TWO_BROTHERS_APPROVAL_MODE/);

  // The TUI applies the saved approval_policy through `/permission` and also
  // accepts the same per-process pin as serve. This test harness is not a TTY,
  // so a valid pin reaches the honest interactive-terminal refusal (exit 2)
  // while an invalid mode is a usage error before that.
  const tuiInvalid = makeIO();
  assert.equal(await main(["tui", "--approval-mode", "nope"], tuiInvalid), 2);
  assert.match(tuiInvalid.err[0]!, /^\[error\] invalid approval mode: nope/);
  const tui = makeIO();
  assert.equal(await main(["tui", "--approval-mode", "ask"], tui), 2);
  assert.match(tui.err.join("\n"), /needs an interactive terminal/);
});
