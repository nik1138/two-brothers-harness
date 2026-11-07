/**
 * TUI workspace lane: `tui --workspace` startup validation, `@file` mention
 * resolution and picker rows, the docked approval panel (pure view + key
 * handling at several widths, plain/colour identity), and the real
 * `RunApprovalBroker` driving a workspace-bound harness turn (allow once,
 * allow for session, deny, abort = deny, bounded diff details).
 *
 * Hermetic: temp workspace directories, the offline mock provider and no
 * network/TTY. Run with `node tests/run-all.ts` (or this file directly).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { resolveConfig } from "../src/config.ts";
import { TwoBrothersHarness } from "../src/harness.ts";
import { TUI_COMMANDS } from "../src/tui/keymap.ts";
import { Decision, PermissionManager } from "../src/permissions.ts";
import { MockProvider } from "../src/provider.ts";
import { RunApprovalBroker } from "../src/runevents.ts";
import { resolveFileMentions, runTuiApp } from "../src/tui/app.ts";
import { plainTheme, createTheme } from "../src/tui/theme.ts";
import { displayWidth } from "../src/tui/text.ts";
import { stripAnsi } from "../src/tui/render.ts";
import {
  APPROVAL_ALLOW_ONCE,
  APPROVAL_ALLOW_SESSION,
  APPROVAL_DENY,
  approvalPanelKey,
  approvalPanelView,
  approvalPreview,
  createApprovalPanelState,
  type ApprovalPanelItem,
} from "../src/tui/view/approval.ts";
import {
  detectMentionTrigger,
  fileMentionItems,
  mentionPickerKey,
  mentionPickerView,
  openMentionPicker,
  type MentionPickerState,
} from "../src/tui/view/mentionpicker.ts";
import { screenView } from "../src/tui/view/screen.ts";
import { Workspace } from "../src/workspace.ts";

const cfg = () => resolveConfig({ provider: "mock", mode: "work" });

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write(pathName: string, content: string): { tool: string; args: Record<string, unknown> } {
  return { tool: "workspace_write_file", args: { path: pathName, content } };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

// --------------------------------------------------------------------------- //
// `tui --workspace` startup validation
// --------------------------------------------------------------------------- //

test("tui --workspace: an invalid root is a clear exit-2 startup error", async () => {
  const err: string[] = [];
  const code = await runTuiApp({
    cfg: resolveConfig({ provider: "mock" }),
    io: { log: () => {}, error: (line) => err.push(line) },
    workspaceRoot: path.join(os.tmpdir(), "tb-tui-missing-workspace-root"),
    input: { isTTY: false } as unknown as NodeJS.ReadStream,
    output: { isTTY: false } as unknown as NodeJS.WriteStream,
  });
  assert.equal(code, 2);
  assert.ok(err.length > 0, "the error is reported on the CLI sink");
  assert.match(err.join("\n"), /workspace root does not exist/);
});

test("tui --workspace: a file (not a directory) is refused with exit 2", async () => {
  const root = tempDir("tb-tui-workspace-file-");
  try {
    const file = path.join(root, "plain.txt");
    fs.writeFileSync(file, "x\n");
    const err: string[] = [];
    const code = await runTuiApp({
      cfg: resolveConfig({ provider: "mock" }),
      io: { log: () => {}, error: (line) => err.push(line) },
      workspaceRoot: file,
      input: { isTTY: false } as unknown as NodeJS.ReadStream,
      output: { isTTY: false } as unknown as NodeJS.WriteStream,
    });
    assert.equal(code, 2);
    assert.match(err.join("\n"), /not a directory/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------------------- //
// @file mention resolution (read-only, confined, bounded)
// --------------------------------------------------------------------------- //

test("@file mentions attach workspace files as <file> blocks", async () => {
  const root = tempDir("tb-tui-mentions-");
  try {
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src", "a.ts"), "export const a = 1;\n");
    fs.writeFileSync(path.join(root, "README.md"), "# readme\n");
    const workspace = new Workspace(root);
    const resolved = resolveFileMentions(
      "please read @src/a.ts and @./README.md",
      workspace,
    );
    assert.ok(resolved.ok);
    assert.deepEqual(resolved.plan.names, ["src/a.ts", "README.md"]);
    assert.equal(resolved.plan.blocks.length, 2);
    assert.ok(resolved.plan.blocks[0]?.includes('<file path="src/a.ts">'));
    assert.ok(resolved.plan.blocks[0]?.includes("export const a = 1;"));
    assert.ok(resolved.plan.blocks[1]?.includes('<file path="README.md">'));
    assert.ok(resolved.plan.totalChars > 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("@file mentions refuse unknown, absolute, escaping and sensitive paths honestly", async () => {
  const root = tempDir("tb-tui-mentions-bad-");
  try {
    fs.writeFileSync(path.join(root, ".env"), "SECRET=1\n");
    const workspace = new Workspace(root);
    const cases: Array<[string, RegExp]> = [
      ["read @nope/x.txt", /cannot attach file "@nope\/x\.txt"/],
      ["read @/etc/passwd", /absolute paths are not allowed/],
      ["read @../outside.txt", /path escapes the workspace/],
      ["read @./.env", /sensitive file refused/],
    ];
    for (const [task, pattern] of cases) {
      const resolved = resolveFileMentions(task, workspace);
      assert.equal(resolved.ok, false, task);
      if (!resolved.ok) assert.match(resolved.errors.join("\n"), pattern);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("@file mentions: no mentions is a no-op (plain tasks unchanged)", () => {
  const root = tempDir("tb-tui-mentions-none-");
  try {
    const workspace = new Workspace(root);
    const resolved = resolveFileMentions("just a task, no mentions", workspace);
    assert.ok(resolved.ok);
    assert.deepEqual(resolved.plan.blocks, []);
    assert.deepEqual(resolved.plan.names, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("@file mentions: more than five files is refused", async () => {
  const root = tempDir("tb-tui-mentions-many-");
  try {
    for (let i = 0; i < 6; i += 1) fs.writeFileSync(path.join(root, `f${i}.txt`), "x\n");
    const workspace = new Workspace(root);
    const task = [0, 1, 2, 3, 4, 5].map((i) => `@./f${i}.txt`).join(" ");
    const resolved = resolveFileMentions(task, workspace);
    assert.equal(resolved.ok, false);
    if (!resolved.ok) assert.match(resolved.errors.join("\n"), /too many file mentions/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------------------- //
// @file mention picker rows
// --------------------------------------------------------------------------- //

test("file mention rows carry canonical tokens and the picker inserts them", () => {
  const files = [
    { path: "README.md", size: 10, mtime: 1 },
    { path: "src/a.ts", size: 2048, mtime: 2 },
  ];
  const items = fileMentionItems(files);
  assert.deepEqual(
    items.map((item) => item.title),
    ["@./README.md", "@src/a.ts"],
  );
  assert.equal(items[0]?.insert, "@./README.md ");
  assert.equal(items[0]?.group, "Workspace files");

  const state: MentionPickerState = openMentionPicker("file", "", { files });
  const selected = mentionPickerKey(TUI_COMMANDS, state, { name: "return" });
  assert.equal(selected.action, "accept");
  assert.equal(selected.item?.insert, "@./README.md ");

  const view = mentionPickerView(state, { width: 60, theme: plainTheme });
  assert.ok(view.lines.every((line) => displayWidth(line) === 60));
  assert.ok(view.lines[0]?.includes("WORKSPACE FILES"));
});

test("mention trigger: a path-like @token opens the file picker, @skill: stays skills", () => {
  const fileTrigger = detectMentionTrigger("read @src/a.ts", 14);
  assert.ok(fileTrigger !== null);
  assert.equal(fileTrigger.kind, "file");
  assert.equal(fileTrigger.query, "src/a.ts");
  assert.equal(fileTrigger.start, 5);

  const rootTrigger = detectMentionTrigger("@./README", 10);
  assert.ok(rootTrigger !== null);
  assert.equal(rootTrigger.kind, "file");
  assert.equal(rootTrigger.query, "./README");

  const skillTrigger = detectMentionTrigger("@skill:check", 12);
  assert.ok(skillTrigger !== null);
  assert.equal(skillTrigger.kind, "skill");
  assert.equal(skillTrigger.query, "check");

  // Without a slash the token is still the skill picker.
  const shortTrigger = detectMentionTrigger("@re", 3);
  assert.ok(shortTrigger !== null);
  assert.equal(shortTrigger.kind, "skill");
});

// --------------------------------------------------------------------------- //
// approval panel: pure view + key handling
// --------------------------------------------------------------------------- //

function item(overrides: Partial<ApprovalPanelItem> = {}): ApprovalPanelItem {
  return {
    approvalId: "approval-1",
    action: "write",
    target: "src/report.ts",
    reason: "operator approval required",
    detail: {
      kind: "write",
      diff: "--- a/src/report.ts\n+++ b/src/report.ts\n@@ -0,0 +1,1 @@\n+hello\n",
      addedLines: 1,
      removedLines: 0,
    },
    ...overrides,
  };
}

test("approval panel: exact-width rows at 40/60/80/120, numbered decisions, no raw SGR", () => {
  const state = createApprovalPanelState(item());
  for (const width of [40, 60, 80, 120]) {
    const view = approvalPanelView(state, { width, theme: plainTheme });
    assert.ok(view.lines.length > 0, `width ${width} renders`);
    for (const line of view.lines) {
      assert.equal(displayWidth(line), width, `width ${width} row is exact`);
      assert.ok(!line.includes("\x1b"), "plainTheme output has no SGR");
    }
    const text = view.lines.join("\n");
    assert.match(text, /Allow once/);
    assert.match(text, /Always allow this session/);
    assert.match(text, /Deny/);
    assert.match(text, /\[1\]/);
    assert.match(text, /\[2\]/);
    assert.match(text, /\[3\]/);
    assert.match(text, /diff \+1\/-0 lines/);
    assert.ok(view.selectedRow > 0, "the default selection row is reported");
  }
});

test("approval panel: colour theme strips back to the exact plain rows", () => {
  const state = createApprovalPanelState(item());
  for (const width of [40, 80, 120]) {
    const plain = approvalPanelView(state, { width, theme: plainTheme }).lines;
    const colored = approvalPanelView(state, { width, theme: createTheme("dark") }).lines;
    assert.ok(colored.join("\n").includes("\x1b"), "the colour theme paints");
    for (let index = 0; index < plain.length; index += 1) {
      assert.equal(stripAnsi(colored[index] ?? ""), plain[index], `row ${index} at ${width}`);
    }
  }
});

test("approval panel: CJK/emoji action, target and reason stay width-safe", () => {
  const wideItem = item({
    action: "write",
    target: "文档/报告-🚀.md",
    reason: "理由：这是一个很长的说明 — ✅ approved?",
    detail: { kind: "write", diff: "+你好世界 🚀\n", addedLines: 1, removedLines: 0 },
  });
  const state = createApprovalPanelState(wideItem);
  for (const width of [40, 60, 80]) {
    const view = approvalPanelView(state, { width, theme: plainTheme });
    for (const line of view.lines) assert.equal(displayWidth(line), width);
    const text = view.lines.join("\n");
    assert.ok(text.includes("文档/报告") || text.includes("…"), "the target is visibly present");
  }
});

test("approval key handling: y/a/n and 1/2/3 answer, Esc denies exactly once", () => {
  const base = createApprovalPanelState(item());
  const press = (
    state: typeof base,
    key: { name: string; ctrl?: boolean },
  ) => approvalPanelKey(TUI_COMMANDS, state, key);

  assert.equal(press(base, { name: "y" }).action, "allow");
  assert.equal(press(base, { name: "1" }).action, "allow");
  assert.equal(press(base, { name: "a" }).action, "allow-session");
  assert.equal(press(base, { name: "2" }).action, "allow-session");
  assert.equal(press(base, { name: "n" }).action, "deny");
  assert.equal(press(base, { name: "3" }).action, "deny");
  assert.equal(press(base, { name: "escape" }).action, "deny");
  assert.equal(press(base, { name: "e", ctrl: true }).action, "preview");
  assert.equal(press(base, { name: "z" }).action, "none");

  // Up/Down move the highlight with wrap-around; Enter answers the selection.
  const movedDown = press(base, { name: "down" });
  assert.equal(movedDown.state.selected, APPROVAL_ALLOW_SESSION);
  assert.equal(press(movedDown.state, { name: "return" }).action, "allow-session");
  const denyMoved = press(movedDown.state, { name: "down" }).state;
  assert.equal(denyMoved.selected, APPROVAL_DENY);
  assert.equal(press(denyMoved, { name: "return" }).action, "deny");
  const wrapped = press(denyMoved, { name: "down" }).state;
  assert.equal(wrapped.selected, APPROVAL_ALLOW_ONCE);
  assert.equal(press(wrapped, { name: "up" }).state.selected, APPROVAL_DENY);
});

test("approval preview: bounded diff, shell command, and nothing for a bare request", () => {
  const diffPreview = approvalPreview(item());
  assert.ok(diffPreview !== null);
  assert.equal(diffPreview.title, "APPROVAL PREVIEW");
  assert.match(diffPreview.message, /src\/report\.ts/);
  assert.match(diffPreview.details, /\+hello/);

  const shellPreview = approvalPreview({
    approvalId: "a2",
    action: "shell",
    command: "npm test",
    detail: { kind: "shell", command: "npm test" },
  });
  assert.ok(shellPreview !== null);
  assert.match(shellPreview.details, /npm test/);

  assert.equal(approvalPreview({ approvalId: "a3", action: "delete", target: "x.txt" }), null);
});

test("screenView: the approval panel replaces the composer and keeps exact geometry", () => {
  const state = createApprovalPanelState(item());
  const panel = approvalPanelView(state, { width: 80, theme: plainTheme }).lines;
  const frame = screenView({
    width: 80,
    height: 30,
    model: { blocks: [], liveThinking: undefined } as never,
    editor: {
      text: "draft that must not show",
      cursor: 0,
      history: [],
      historyIndex: 0,
      stash: null,
    } as never,
    status: { mode: "work", seniorModel: "s", juniorModel: "j", running: true },
    approvalPanel: panel,
  });
  assert.equal(frame.lines.length, 30);
  for (const line of frame.lines) assert.equal(displayWidth(line), 80);
  const text = frame.lines.join("\n");
  assert.match(text, /APPROVAL REQUIRED/);
  assert.ok(!text.includes("draft that must not show"), "the composer is hidden while parked");
  assert.ok(!text.includes("MESSAGE"), "the composer box is replaced, not duplicated");
});

// --------------------------------------------------------------------------- //
// workspace-bound harness turn through the real RunApprovalBroker
// --------------------------------------------------------------------------- //

interface BrokerCapture {
  events: Array<Record<string, any>>;
}

function attachBroker(
  broker: RunApprovalBroker,
  signal?: AbortSignal,
): BrokerCapture {
  const capture: BrokerCapture = { events: [] };
  broker.attach((event) => capture.events.push(event as unknown as Record<string, any>), signal ?? null);
  return capture;
}

test("broker: allow once writes the file and the event carries the bounded diff detail", async () => {
  const root = tempDir("tb-tui-broker-allow-");
  try {
    const broker = new RunApprovalBroker();
    const capture = attachBroker(broker);
    const workspace = new Workspace(root, new PermissionManager(null, broker));
    const harness = new TwoBrothersHarness(cfg(), {
      junior: new MockProvider([write("notes.txt", "hello\n")]),
      senior: new MockProvider(),
      workspace,
    });
    const run = harness.run("write notes.txt");
    assert.ok(await waitFor(() => broker.pending().length === 1), "the turn parks on approval");
    const pending = broker.pending()[0] as Record<string, any>;
    assert.equal(pending.action, "write");
    assert.equal(pending.target, "notes.txt");
    assert.equal(pending.detail.kind, "write");
    assert.match(String(pending.detail.diff), /\+\+\+ b\/notes\.txt/);
    const requested = capture.events.find((event) => event.type === "approval_requested");
    assert.ok(requested !== undefined);
    assert.match(String(requested.detail.diff), /\+hello/);

    broker.respond(String(pending.approval_id), Decision.ALLOW);
    await run;
    assert.equal(fs.readFileSync(path.join(root, "notes.txt"), "utf-8"), "hello\n");
    assert.ok(
      capture.events.some(
        (event) => event.type === "approval_resolved" && event.decision === "allow",
      ),
    );
    assert.equal(broker.pending().length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("broker: deny leaves the file unwritten and reports a denied tool result", async () => {
  const root = tempDir("tb-tui-broker-deny-");
  try {
    const broker = new RunApprovalBroker();
    attachBroker(broker);
    const workspace = new Workspace(root, new PermissionManager(null, broker));
    const events: Array<Record<string, any>> = [];
    const harness = new TwoBrothersHarness(cfg(), {
      junior: new MockProvider([write("notes.txt", "hello\n")]),
      senior: new MockProvider(),
      workspace,
      onEvent: (event) => events.push(event as unknown as Record<string, any>),
    });
    const run = harness.run("write notes.txt");
    assert.ok(await waitFor(() => broker.pending().length === 1));
    broker.respond(String((broker.pending()[0] as Record<string, any>).approval_id), Decision.DENY);
    await run;
    assert.equal(fs.existsSync(path.join(root, "notes.txt")), false);
    const completed = events.find(
      (event) => event.type === "tool_completed" && event.tool === "workspace_write_file",
    );
    assert.ok(completed !== undefined);
    assert.equal(completed.status, "denied");
    assert.equal(broker.sessionAllows().length, 0, "a deny is not a session allow");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("broker: allowForSession auto-allows the next identical request without parking", async () => {
  const root = tempDir("tb-tui-broker-session-");
  try {
    const broker = new RunApprovalBroker();
    const capture = attachBroker(broker);
    const workspace = new Workspace(root, new PermissionManager(null, broker));
    const harness = new TwoBrothersHarness(cfg(), {
      junior: new MockProvider([write("notes.txt", "one\n"), write("notes.txt", "two\n")]),
      senior: new MockProvider(),
      workspace,
    });
    const run = harness.run("write notes.txt twice");
    assert.ok(await waitFor(() => broker.pending().length === 1));
    const pair = broker.sessionPairKey(String((broker.pending()[0] as Record<string, any>).approval_id));
    assert.ok(pair !== null);
    broker.allowForSession(String((broker.pending()[0] as Record<string, any>).approval_id));
    await run;
    assert.equal(fs.readFileSync(path.join(root, "notes.txt"), "utf-8"), "two\n");
    assert.deepEqual(broker.sessionAllows(), [pair]);
    assert.ok(
      capture.events.some((event) => event.type === "approval_auto_allowed"),
      "the second identical write was auto-allowed",
    );
    assert.equal(
      capture.events.filter((event) => event.type === "approval_requested").length,
      1,
      "only the first request parked",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("broker: aborting a parked turn resolves the approval as deny and writes nothing", async () => {
  const root = tempDir("tb-tui-broker-abort-");
  try {
    const controller = new AbortController();
    const broker = new RunApprovalBroker();
    const capture = attachBroker(broker, controller.signal);
    const workspace = new Workspace(root, new PermissionManager(null, broker));
    const harness = new TwoBrothersHarness(cfg(), {
      junior: new MockProvider([write("notes.txt", "hello\n")]),
      senior: new MockProvider(),
      workspace,
      signal: controller.signal,
    });
    const run = harness.run("write notes.txt");
    assert.ok(await waitFor(() => broker.pending().length === 1));
    controller.abort();
    const result = await run;
    assert.equal(result.cancelled, true);
    assert.equal(fs.existsSync(path.join(root, "notes.txt")), false);
    assert.equal(broker.pending().length, 0);
    assert.ok(
      capture.events.some(
        (event) =>
          event.type === "approval_resolved" &&
          event.decision === "deny" &&
          event.reason === "cancelled",
      ),
      "the parked approval was resolved as a cancellation deny",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("broker: denyAll resolves a parked approval once and the harness records a denial", async () => {
  const root = tempDir("tb-tui-broker-denyall-");
  try {
    const broker = new RunApprovalBroker();
    const capture = attachBroker(broker);
    const workspace = new Workspace(root, new PermissionManager(null, broker));
    const harness = new TwoBrothersHarness(cfg(), {
      junior: new MockProvider([write("notes.txt", "hello\n")]),
      senior: new MockProvider(),
      workspace,
    });
    const run = harness.run("write notes.txt");
    assert.ok(await waitFor(() => broker.pending().length === 1));
    assert.equal(broker.denyAll("stopped"), 1);
    await run;
    assert.equal(fs.existsSync(path.join(root, "notes.txt")), false);
    assert.equal(
      capture.events.filter((event) => event.type === "approval_resolved").length,
      1,
      "exactly one resolution event",
    );
    assert.equal(broker.pending().length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("workspace shell approvals carry the command as an additive preview detail", async () => {
  const root = tempDir("tb-tui-broker-shell-");
  try {
    const broker = new RunApprovalBroker();
    const capture = attachBroker(broker);
    const workspace = new Workspace(root, new PermissionManager(null, broker));
    const harness = new TwoBrothersHarness(cfg(), {
      junior: new MockProvider([
        { tool: "workspace_run_shell", args: { command: "echo hi" } },
      ]),
      senior: new MockProvider(),
      workspace,
    });
    const run = harness.run("run echo");
    assert.ok(await waitFor(() => broker.pending().length === 1));
    const requested = capture.events.find((event) => event.type === "approval_requested");
    assert.ok(requested !== undefined);
    assert.equal(requested.detail.kind, "shell");
    assert.equal(requested.detail.command, "echo hi");
    broker.respond(String(requested.approval_id), Decision.DENY);
    await run;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
