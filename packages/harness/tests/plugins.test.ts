/**
 * Plugin system tests: fail-soft loader, the register(ctx) contract,
 * shared-by-default tool assignment through the toolScopes registry,
 * confined workspace helpers, and the HTTP endpoints. Ports the coverage of
 * original prototype's plugin tests (removed 2026-11-04; see git history);
 * per-role plugin assignment was retired by
 * owner decision 2026-11-03 (every plugin tool joins the shared scope).
 *
 * Fixture plugins are written to temp directories at runtime and loaded
 * through the real dynamic-import path (`.ts` fixtures, plus one `.mts`);
 * each fixture dir carries a `{"type": "module"}` package.json so Node
 * treats the `.ts` files as ESM without the typeless-package warning.
 *
 * Run with: node tests/run-all.ts (or node --test tests/)
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { resolveConfig } from "../src/config.ts";
import { TwoBrothersHarness } from "../src/harness.ts";
import {
  Action,
  CallbackBroker,
  Decision,
  PermissionManager,
  StaticBroker,
  type ApprovalRequest,
} from "../src/permissions.ts";
import {
  PluginContext,
  PluginError,
  PluginManager,
  asHarnessTool,
  defaultPluginsDir,
  loadPlugins,
  toolParameters,
  type PluginToolHandler,
  type RegisteredTool,
} from "../src/plugins.ts";
import { MockProvider } from "../src/provider.ts";
import {
  type RuntimeEvent,
  type ToolCompletedEvent,
  type ToolStartedEvent,
} from "../src/runevents.ts";
import { createServer, type ServerHandle, type ServerOptions } from "../src/server.ts";
import { Workspace } from "../src/workspace.ts";

// ---------------------------------------------------------------------------
// helpers + fixtures
// ---------------------------------------------------------------------------

function rmWithRetry(target: string): void {
  // Windows briefly holds handles on freshly written files; a short retry
  // keeps temp-dir cleanup from flaking the suite.
  for (let attempt = 0; ; attempt++) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
      return;
    } catch (exc) {
      if (attempt >= 4) throw exc;
      const deadline = Date.now() + 50 * (attempt + 1);
      while (Date.now() < deadline) {
        // busy-wait: cleanup runs synchronously inside test teardowns
      }
    }
  }
}

function tmpdir(prefix: string): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { root, cleanup: () => rmWithRetry(root) };
}

/** A temp plugins dir; `files` maps file name -> source. */
function makePluginsDir(files: Record<string, string>): {
  root: string;
  cleanup: () => void;
} {
  const tmp = tmpdir("tb-plugins-");
  for (const [name, source] of Object.entries(files)) {
    fs.writeFileSync(path.join(tmp.root, name), source, "utf-8");
  }
  // `.ts` fixtures resolve as ESM without Node's typeless-package warning.
  fs.writeFileSync(path.join(tmp.root, "package.json"), JSON.stringify({ type: "module" }));
  return tmp;
}

const GOOD_PLUGIN = [
  'export function register(ctx) {',
  '  ctx.set_description("A good test plugin");',
  "  ctx.add_tool(\"ping\", (args) => `ping ${args.word ?? \"pong\"}`, \"Say ping\", { word: \"string\" }, \"junior\");",
  '  ctx.add_tool("seniors_only", () => "senior ok", "", {}, "senior");',
  "}",
  "",
].join("\n");

const BROKEN_PLUGIN = "export function register(ctx: {{{\n";

const COLLIDING_PLUGIN = [
  "export function register(ctx) {",
  '  ctx.add_tool("workspace_write_file", () => "impostor", "collision");',
  "}",
  "",
].join("\n");

const NO_REGISTER_PLUGIN = "export const nothing = 1;\n";

const BAD_ROLE_PLUGIN = [
  "export function register(ctx) {",
  '  ctx.add_tool("mischief", () => "", "", {}, "chief");',
  "}",
  "",
].join("\n");

const DUPLICATES_PLUGIN = [
  "export function register(ctx) {",
  '  ctx.add_tool("twice", () => "one");',
  '  ctx.add_tool("twice", () => "two");',
  "}",
  "",
].join("\n");

/** Captures the ctx it was registered with, for per-run binding checks. */
const MARKER_PLUGIN = [
  "export function register(ctx) {",
  "  ctx.add_tool(",
  '    "mark",',
  "    async () => {",
  '      const result = await ctx.workspace_write("marker.txt", "from " + ctx.plugin_name);',
  "      return result.status;",
  '    },',
  '    "",',
  "    {},",
  '    "junior",',
  "  );",
  "}",
  "",
].join("\n");

/** The notes.py/notes.mts shape, self-contained for the harness runs. */
const NOTES_PLUGIN = [
  "export function register(ctx) {",
  '  ctx.set_description("Keep short notes inside the workspace");',
  "  async function write_note(args) {",
  '    const filename = args.filename ?? "notes.txt";',
  '    const result = await ctx.workspace_write(filename, args.text ?? "");',
  '    if (result.status !== "ok") return result;',
  '    return "note saved to " + filename;',
  "  }",
  '  ctx.add_tool("write_note", write_note, "Write a note",',
  '    { text: "string", filename: "string" }, "junior");',
  "}",
  "",
].join("\n");

function workspaceWith(
  root: string,
  broker: StaticBroker | CallbackBroker,
): Workspace {
  return new Workspace(root, new PermissionManager(null, broker));
}

// ---------------------------------------------------------------------------
// Loader + manager (fail-soft)
// ---------------------------------------------------------------------------

test("loader discovers the notes example from the default plugins dir", async () => {
  const manager = await PluginManager.create();
  assert.deepEqual(manager.errors, []);
  assert.ok(manager.plugins.has("notes"));
  const entry = manager.describe().plugins.find((p) => p.name === "notes");
  assert.equal(entry?.description, "Keep short notes inside the workspace");
  assert.deepEqual(entry?.roles, ["shared"]);
  assert.equal(defaultPluginsDir(), manager.pluginsDir);
});

test("a broken plugin is skipped and recorded; the others still load", async () => {
  const dir = makePluginsDir({ "good.ts": GOOD_PLUGIN, "broken.ts": BROKEN_PLUGIN });
  try {
    const manager = await PluginManager.create(dir.root);
    assert.ok(manager.plugins.has("good"));
    assert.ok(!manager.plugins.has("broken"));
    assert.equal(manager.errors.length, 1);
    assert.equal(manager.errors[0].plugin, "broken");
    assert.match(manager.errors[0].error, /SyntaxError/);
  } finally {
    dir.cleanup();
  }
});

test("filename rules ignore non-plugin files", async () => {
  const dir = makePluginsDir({
    "good.ts": GOOD_PLUGIN,
    "README.md": "not a plugin\n",
    "Bad-Name.ts": "export function register(ctx) {}\n",
    "legacy.py": "def register(ctx): pass\n",
    "typed.d.ts": "export {};\n",
    "also.mts": GOOD_PLUGIN.replace("ping", "pong"),
  });
  try {
    const manager = await PluginManager.create(dir.root);
    assert.deepEqual([...manager.plugins.keys()].sort(), ["also", "good"]);
    assert.deepEqual(manager.errors, []);
  } finally {
    dir.cleanup();
  }
});

test("a missing plugins dir means no plugins and no errors", async () => {
  const missing = path.join(os.tmpdir(), "tb-plugins-missing-zzz");
  fs.rmSync(missing, { recursive: true, force: true });
  const { plugins, errors } = await loadPlugins(missing);
  assert.equal(plugins.size, 0);
  assert.deepEqual(errors, []);
});

test("reload picks up newly dropped plugins and re-imports changed files", async () => {
  const dir = makePluginsDir({});
  try {
    const manager = await PluginManager.create(dir.root);
    assert.equal(manager.plugins.size, 0);
    fs.writeFileSync(path.join(dir.root, "good.ts"), GOOD_PLUGIN, "utf-8");
    await manager.reload();
    assert.ok(manager.plugins.has("good"));
    // same URL, changed content: the ?v=N cache-bust must re-import
    fs.writeFileSync(
      path.join(dir.root, "good.ts"),
      GOOD_PLUGIN.replace("A good test plugin", "A better test plugin"),
      "utf-8",
    );
    await manager.reload();
    assert.equal(manager.plugins.get("good")?.description, "A better test plugin");
  } finally {
    dir.cleanup();
  }
});

test("concurrent reloads serialize instead of interleaving", async () => {
  const dir = makePluginsDir({ "good.ts": GOOD_PLUGIN });
  try {
    const manager = new PluginManager(dir.root);
    await Promise.all([manager.reload(), manager.reload(), manager.reload()]);
    assert.deepEqual([...manager.plugins.keys()], ["good"]);
    assert.deepEqual(manager.errors, []);
  } finally {
    dir.cleanup();
  }
});

// ---------------------------------------------------------------------------
// register(ctx) contract
// ---------------------------------------------------------------------------

test("a plugin without a top-level register(ctx) is rejected", async () => {
  const dir = makePluginsDir({ "noregister.ts": NO_REGISTER_PLUGIN });
  try {
    const manager = await PluginManager.create(dir.root);
    assert.equal(manager.plugins.size, 0);
    assert.match(manager.errors[0].error, /no top-level register\(ctx\)/);
  } finally {
    dir.cleanup();
  }
});

test("a tool name colliding with a built-in is rejected (built-ins win)", async () => {
  const dir = makePluginsDir({ "impostor.ts": COLLIDING_PLUGIN });
  try {
    const manager = await PluginManager.create(dir.root);
    assert.equal(manager.plugins.size, 0);
    assert.equal(manager.errors[0].plugin, "impostor");
    assert.match(manager.errors[0].error, /collides with a built-in tool/);
  } finally {
    dir.cleanup();
  }
});

test("duplicate tool names within one plugin are rejected", async () => {
  const dir = makePluginsDir({ "doubles.ts": DUPLICATES_PLUGIN });
  try {
    const manager = await PluginManager.create(dir.root);
    assert.equal(manager.plugins.size, 0);
    assert.match(manager.errors[0].error, /duplicate tool name/);
  } finally {
    dir.cleanup();
  }
});

test("add_tool validates name, role, and handler (PluginError)", () => {
  const ctx = new PluginContext("unit");
  assert.throws(
    () => ctx.add_tool("   ", () => ""),
    (exc: unknown) => exc instanceof PluginError && /non-empty string/.test(exc.message),
  );
  assert.throws(
    () => ctx.add_tool("mischief", () => "", "", {}, "chief"),
    (exc: unknown) => exc instanceof PluginError && /unknown role/.test(exc.message),
  );
  assert.throws(
    () => ctx.add_tool("mischief", "not callable" as unknown as PluginToolHandler),
    (exc: unknown) => exc instanceof PluginError && /not callable/.test(exc.message),
  );
  assert.equal(ctx._tools.length, 0);
});

test("a registration raising part-way fails the whole plugin, not the load", async () => {
  const dir = makePluginsDir({ "badrole.ts": BAD_ROLE_PLUGIN, "good.ts": GOOD_PLUGIN });
  try {
    const manager = await PluginManager.create(dir.root);
    assert.deepEqual([...manager.plugins.keys()], ["good"]);
    assert.equal(manager.errors.length, 1);
    assert.equal(manager.errors[0].plugin, "badrole");
    assert.match(manager.errors[0].error, /unknown role/);
  } finally {
    dir.cleanup();
  }
});

test("ctx.log writes a one-line server-log note", () => {
  const ctx = new PluginContext("unit");
  const lines: string[] = [];
  const original = console.log;
  console.log = (line: unknown) => lines.push(String(line));
  try {
    ctx.log("hello");
  } finally {
    console.log = original;
  }
  assert.deepEqual(lines, ["[unit] hello"]);
});

// ---------------------------------------------------------------------------
// Tool adapter: params schema + fail-soft execution
// ---------------------------------------------------------------------------

function registered(partial: Partial<RegisteredTool> & { name: string }): RegisteredTool {
  return {
    handler: () => "",
    description: "",
    paramsSchema: {},
    role: "junior",
    ...partial,
  };
}

test("params_schema: Python shorthand translates to string-typed properties", () => {
  assert.deepEqual(toolParameters({ text: "string", count: "integer" }), {
    type: "object",
    properties: { text: { type: "string" }, count: { type: "integer" } },
  });
  const tool = asHarnessTool(
    registered({ name: "ping", paramsSchema: { word: "string" } }),
  );
  assert.deepEqual(tool.parameters, {
    type: "object",
    properties: { word: { type: "string" } },
  });
});

test("params_schema: a full JSON Schema passes through", () => {
  const schema = {
    type: "object",
    properties: { path: { type: "string", description: "target file" } },
    required: ["path"],
  };
  assert.deepEqual(toolParameters(schema), schema);
});

test("params_schema: empty or malformed falls back to a bare object schema", () => {
  assert.deepEqual(toolParameters({}), { type: "object", properties: {} });
});

test("tool execution: string passes through, objects serialize, failures never crash", async () => {
  const plain = asHarnessTool(registered({ name: "a", handler: () => "plain" }));
  assert.equal(await plain.execute({}), "plain");

  const structured = asHarnessTool(registered({ name: "b", handler: () => ({ ok: 1 }) }));
  assert.equal(await structured.execute({}), JSON.stringify({ ok: 1 }));

  const nothing = asHarnessTool(registered({ name: "c", handler: () => undefined }));
  assert.equal(await nothing.execute({}), "null");

  const boom = asHarnessTool(
    registered({
      name: "d",
      handler: () => {
        throw new Error("kaput");
      },
    }),
  );
  assert.equal(await boom.execute({}), "plugin tool error: kaput");

  const undescribed = asHarnessTool(registered({ name: "e" }));
  assert.equal(undescribed.description, "Plugin tool e.");
});

// ---------------------------------------------------------------------------
// Shared-by-default assignment + confined workspace helpers
// ---------------------------------------------------------------------------

test("toolsFor offers every tool of the active plugins, regardless of declared role", async () => {
  const dir = makePluginsDir({ "good.ts": GOOD_PLUGIN });
  const tmp = tmpdir("tb-ws-");
  try {
    const manager = await PluginManager.create(dir.root);
    const ws = workspaceWith(tmp.root, new StaticBroker(Decision.ALLOW));
    // `ping` declared "junior" and `seniors_only` declared "senior" — both
    // join the shared scope (owner decision 2026-11-03)
    const tools = await manager.toolsFor(["good"], ws);
    assert.deepEqual(tools.map((t) => t.name), ["ping", "seniors_only"]);
    // inactive or unknown plugin names are not offered
    assert.deepEqual(await manager.toolsFor([], ws), []);
    assert.deepEqual(await manager.toolsFor(["ghost"], ws), []);
    // no workspace -> no plugin tools (workspace-bound runs only)
    assert.deepEqual(await manager.toolsFor(["good"], null), []);
  } finally {
    dir.cleanup();
    tmp.cleanup();
  }
});

test("workspace helpers raise PluginError without a workspace", () => {
  const ctx = new PluginContext("unit");
  assert.throws(() => ctx.workspace_read("x.txt"), PluginError);
  assert.throws(() => ctx.workspace_list(), PluginError);
  assert.throws(() => ctx.workspace_search("x"), PluginError);
  assert.throws(() => ctx.workspace_write("x", "y"), PluginError);
  assert.throws(() => ctx.workspace_edit("x", "a", "b"), PluginError);
  assert.throws(() => ctx.workspace_delete("x"), PluginError);
  assert.throws(() => ctx.workspace_shell("ls"), PluginError);
});

test("workspace helpers are confined and hit the disk through the run's workspace", async () => {
  const dir = makePluginsDir({ "good.ts": GOOD_PLUGIN });
  const tmp = tmpdir("tb-ws-");
  try {
    const manager = await PluginManager.create(dir.root);
    const ws = workspaceWith(tmp.root, new StaticBroker(Decision.ALLOW));
    const [tool] = await manager.toolsFor(["good"], ws);
    assert.ok(tool);
    const ctx = new PluginContext("unit", ws);
    // confinement holds for plugin helpers exactly like for the built-ins
    const escaped = await ctx.workspace_read("../../etc/passwd");
    assert.equal(escaped.status, "error");
    assert.match(String(escaped.error ?? ""), /escapes the workspace/);
    const sensitive = await ctx.workspace_read(".git/config");
    assert.equal(sensitive.status, "error");
    // a direct confined read through the same manager-bound workspace
    fs.writeFileSync(path.join(tmp.root, "hello.txt"), "hi there", "utf-8");
    const read = await ctx.workspace_read("hello.txt");
    assert.equal(read.status, "ok");
    assert.equal(read.content, "hi there");
    const listed = await ctx.workspace_list(".");
    assert.ok(Array.isArray(listed.entries));
    const searched = await ctx.workspace_search("hi");
    assert.equal((searched.matches as unknown[]).length, 1);
    const edited = await ctx.workspace_edit("hello.txt", "hi", "bye");
    assert.equal(edited.status, "ok");
    const removed = await ctx.workspace_delete("hello.txt");
    assert.equal(removed.status, "ok");
    const shelled = await ctx.workspace_shell("echo plugin-shell");
    assert.equal(shelled.status, "ok");
    assert.match(String(shelled.stdout ?? ""), /plugin-shell/);
  } finally {
    dir.cleanup();
    tmp.cleanup();
  }
});

test("per-run re-registration binds handlers to that run's workspace", async () => {
  const dir = makePluginsDir({ "marker.ts": MARKER_PLUGIN });
  const runA = tmpdir("tb-ws-a-");
  const runB = tmpdir("tb-ws-b-");
  try {
    const manager = await PluginManager.create(dir.root);
    const wsA = workspaceWith(runA.root, new StaticBroker(Decision.ALLOW));
    const wsB = workspaceWith(runB.root, new StaticBroker(Decision.ALLOW));
    const [toolA] = await manager.toolsFor(["marker"], wsA);
    const [toolB] = await manager.toolsFor(["marker"], wsB);
    assert.equal(await toolA.execute({}), "ok");
    assert.equal(await toolB.execute({}), "ok");
    // each run's handler wrote through its own workspace
    assert.equal(fs.readFileSync(path.join(runA.root, "marker.txt"), "utf-8"), "from marker");
    assert.equal(fs.readFileSync(path.join(runB.root, "marker.txt"), "utf-8"), "from marker");
    assert.equal(
      fs.readdirSync(runA.root).filter((f) => f === "marker.txt").length,
      1,
    );
  } finally {
    dir.cleanup();
    runA.cleanup();
    runB.cleanup();
  }
});

test("plugin writes pass through the central approval broker", async () => {
  const dir = makePluginsDir({ "notes.ts": NOTES_PLUGIN });
  const tmp = tmpdir("tb-ws-");
  try {
    const manager = await PluginManager.create(dir.root);
    const requests: ApprovalRequest[] = [];
    const recording = new CallbackBroker((req) => {
      requests.push(req);
      return Decision.ALLOW;
    });
    const ws = workspaceWith(tmp.root, recording);
    const [writeNote] = await manager.toolsFor(["notes"], ws);
    assert.ok(writeNote);
    const result = await writeNote.execute({ text: "hello", filename: "note.txt" });
    assert.equal(result, "note saved to note.txt");
    assert.equal(fs.readFileSync(path.join(tmp.root, "note.txt"), "utf-8"), "hello");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].action, Action.WRITE);
    assert.equal(requests[0].target, "note.txt");

    // deny-on-broker: the tool result surfaces "denied", never a crash
    const denying = workspaceWith(tmp.root, new StaticBroker(Decision.DENY));
    const [deniedTool] = await manager.toolsFor(["notes"], denying);
    const denied = await deniedTool.execute({ text: "x", filename: "blocked.txt" });
    assert.match(denied, /"status":"denied"/);
    assert.ok(!fs.existsSync(path.join(tmp.root, "blocked.txt")));
  } finally {
    dir.cleanup();
    tmp.cleanup();
  }
});

test("a plugin failing re-registration is skipped for that run only", async () => {
  const dir = makePluginsDir({
    "flaky.ts": [
      "let calls = 0;",
      "export function register(ctx) {",
      "  calls += 1;",
      '  if (calls > 1) throw new Error("boom on re-register");',
      '  ctx.add_tool("flaky", () => "ok", "", {}, "junior");',
      "}",
      "",
    ].join("\n"),
    "good.ts": GOOD_PLUGIN,
  });
  const tmp = tmpdir("tb-ws-");
  try {
    const manager = await PluginManager.create(dir.root);
    assert.ok(manager.plugins.has("flaky")); // load-time registration succeeded
    const ws = workspaceWith(tmp.root, new StaticBroker(Decision.ALLOW));
    const tools = await manager.toolsFor(["flaky", "good"], ws);
    // the flaky plugin is skipped for the run; the good one still lands
    assert.deepEqual(tools.map((t) => t.name), ["ping", "seniors_only"]);
  } finally {
    dir.cleanup();
    tmp.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Harness integration: plugin tools flow through the cooperation loop
// (python PluginGraphRunTest analogue)
// ---------------------------------------------------------------------------

async function runNoteHarness(
  decision: Decision,
): Promise<{
  result: {
    decision: Record<string, unknown>;
    errors: string[];
    messages: Array<{ kind: string; payload: Record<string, unknown> }>;
    promptAudits: Array<{ role: string; kind: string; tools: string[] }>;
  };
  requests: ApprovalRequest[];
  events: RuntimeEvent[];
  notePath: string;
  cleanup(): void;
}> {
  const dir = makePluginsDir({ "notes.ts": NOTES_PLUGIN });
  const tmp = tmpdir("tb-ws-");
  try {
    const manager = await PluginManager.create(dir.root);
    const requests: ApprovalRequest[] = [];
    const events: RuntimeEvent[] = [];
    const broker = new CallbackBroker((req) => {
      requests.push(req);
      return decision;
    });
    const workspace = new Workspace(tmp.root, new PermissionManager(null, broker));
    const harness = new TwoBrothersHarness(resolveConfig({ provider: "mock", mode: "work" }), {
      workspace,
      senior: new MockProvider(),
      junior: new MockProvider([
        { tool: "write_note", args: { text: "hello from plugin\n", filename: "note.txt" } },
        {
          text: JSON.stringify({
            result: "The note tool ran.",
            artifacts: ["note.txt"],
            notes: "",
            confidence: 0.99,
          }),
        },
      ]),
      toolScopes: {
        // shared scope: both the senior's verify slice and the junior's
        // belt receive every plugin tool (owner decision 2026-11-03)
        shared: await manager.toolsFor(["notes"], workspace),
      },
      onEvent: (event) => events.push(event),
    });
    const result = await harness.run("Write a note through the plugin");
    return {
      result,
      requests,
      events,
      notePath: path.join(tmp.root, "note.txt"),
      cleanup: () => {
        dir.cleanup();
        tmp.cleanup();
      },
    };
  } catch (exc) {
    // a failed run must not leak the fixture dirs
    dir.cleanup();
    tmp.cleanup();
    throw exc;
  }
}

function toolCompleted(events: RuntimeEvent[], name: string): ToolCompletedEvent[] {
  return events.filter(
    (event): event is ToolCompletedEvent =>
      event.type === "tool_completed" && event.tool === name,
  );
}

function toolStarted(events: RuntimeEvent[], name: string): ToolStartedEvent[] {
  return events.filter(
    (event): event is ToolStartedEvent =>
      event.type === "tool_started" && event.tool === name,
  );
}

test("junior run writes a note through the plugin; the write is approval-brokered", async () => {
  const run = await runNoteHarness(Decision.ALLOW);
  try {
    assert.ok(Object.keys(run.result.decision).length > 0);
    assert.equal(fs.readFileSync(run.notePath, "utf-8"), "hello from plugin\n");
    // the write went through the central PermissionManager broker
    const writes = run.requests.filter((req) => req.action === Action.WRITE);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].target, "note.txt");
    // runtime events show the plugin tool call like any built-in
    assert.equal(toolStarted(run.events, "write_note").length, 1);
    const completed = toolCompleted(run.events, "write_note");
    assert.equal(completed.length, 1);
    assert.equal(completed[0].status, "ok");
  } finally {
    run.cleanup();
  }
});

test("both brothers receive plugin tools from the shared scope", async () => {
  const run = await runNoteHarness(Decision.ALLOW);
  try {
    const juniorDeliverable = run.result.promptAudits.find(
      (audit) => audit.role === "junior" && audit.kind === "deliverable",
    );
    const seniorVerify = run.result.promptAudits.find(
      (audit) => audit.role === "senior" && audit.kind === "verify",
    );
    assert.ok(juniorDeliverable, "junior deliverable audit present");
    assert.ok(seniorVerify, "senior verify audit present");
    assert.ok(
      juniorDeliverable.tools.includes("write_note"),
      `junior belt: ${juniorDeliverable.tools.join(", ")}`,
    );
    assert.ok(
      seniorVerify.tools.includes("write_note"),
      `senior verify slice: ${seniorVerify.tools.join(", ")}`,
    );
  } finally {
    run.cleanup();
  }
});

test("a denied plugin write surfaces in the evidence, not a crashed run", async () => {
  const run = await runNoteHarness(Decision.DENY);
  try {
    assert.ok(!fs.existsSync(run.notePath));
    const completed = toolCompleted(run.events, "write_note");
    assert.equal(completed.length, 1);
    assert.equal(completed[0].status, "denied");
    // the denial rides in the deliverable evidence, exactly like a built-in
    const deliverable = run.result.messages.find((message) => message.kind === "deliverable");
    assert.ok(deliverable);
    const artifacts = (deliverable.payload.artifacts ?? []) as string[];
    assert.ok(artifacts.some((line) => line.includes("denied")));
  } finally {
    run.cleanup();
  }
});

// ---------------------------------------------------------------------------
// HTTP endpoints
// ---------------------------------------------------------------------------

interface RunningServer {
  base: string;
  handle: ServerHandle;
  close(): Promise<void>;
}

async function startServer(options: ServerOptions = {}): Promise<RunningServer> {
  const tmp = tmpdir("tb-srv-");
  const handle = createServer({
    configFactory: () => resolveConfig({ provider: "mock", mode: "consult" }),
    webDist: null,
    ...options,
    sessionsDir: options.sessionsDir ? path.resolve(options.sessionsDir) : tmp.root,
  });
  const server = await handle.listen("127.0.0.1", 0);
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    handle,
    close: async () => {
      await handle.close();
      tmp.cleanup();
    },
  };
}

async function api<T = unknown>(
  base: string,
  method: string,
  route: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(base + route, init);
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed as T };
}

interface PluginInfo {
  name: string;
  description: string;
  roles: string[];
}

interface PluginsView {
  plugins: PluginInfo[];
  errors: Array<{ plugin: string; error: string }>;
}

test("GET /api/plugins lists discovered plugins and load errors", async () => {
  const dir = makePluginsDir({ "good.ts": GOOD_PLUGIN, "broken.ts": BROKEN_PLUGIN });
  try {
    const srv = await startServer({ pluginsDir: dir.root });
    try {
      const res = await api<PluginsView>(srv.base, "GET", "/api/plugins");
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.errors.map((e) => e.plugin), ["broken"]);
      const entry = res.body.plugins.find((p) => p.name === "good");
      assert.equal(entry?.description, "A good test plugin");
      assert.deepEqual(entry?.roles, ["shared"]);
      assert.deepEqual(Object.keys(entry ?? {}).sort(), ["description", "name", "roles"]);
    } finally {
      await srv.close();
    }
  } finally {
    dir.cleanup();
  }
});

test("GET /api/plugins with no plugins dir answers the empty view", async () => {
  const missing = path.join(os.tmpdir(), "tb-plugins-missing-zzz");
  fs.rmSync(missing, { recursive: true, force: true });
  const srv = await startServer({ pluginsDir: missing });
  try {
    const res = await api<PluginsView>(srv.base, "GET", "/api/plugins");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { plugins: [], errors: [] });
  } finally {
    await srv.close();
  }
});

test("settings PUT carries the shared selection; a fresh server hydrates it", async () => {
  const dir = makePluginsDir({ "good.ts": GOOD_PLUGIN });
  const sessions = tmpdir("tb-sessions-");
  try {
    const srv = await startServer({ pluginsDir: dir.root, sessionsDir: sessions.root });
    try {
      const put = await api<{ plugins: string[] }>(
        srv.base,
        "PUT",
        "/api/settings",
        { plugins: ["good"] },
      );
      assert.equal(put.status, 200);
      assert.deepEqual(put.body.plugins, ["good"]);
      const got = await api<{ plugins: string[] }>(
        srv.base,
        "GET",
        "/api/settings",
      );
      assert.deepEqual(got.body.plugins, ["good"]);
    } finally {
      await srv.close();
    }
    // the file carries the single shared list, not per-role keys
    const raw = JSON.parse(
      fs.readFileSync(path.join(sessions.root, "settings.json"), "utf-8"),
    ) as { plugins: unknown };
    assert.deepEqual(raw.plugins, ["good"]);
    // hydration: a fresh server over the same sessions dir applies the file
    const srv2 = await startServer({ pluginsDir: dir.root, sessionsDir: sessions.root });
    try {
      const got2 = await api<{ plugins: string[] }>(
        srv2.base,
        "GET",
        "/api/settings",
      );
      assert.deepEqual(got2.body.plugins, ["good"]);
    } finally {
      await srv2.close();
    }
  } finally {
    dir.cleanup();
    sessions.cleanup();
  }
});

test("settings PUT still accepts the legacy per-role plugin object (merged)", async () => {
  const dir = makePluginsDir({ "good.ts": GOOD_PLUGIN, "aaa.ts": MARKER_PLUGIN });
  const sessions = tmpdir("tb-sessions-");
  try {
    const srv = await startServer({ pluginsDir: dir.root, sessionsDir: sessions.root });
    try {
      const put = await api<{ plugins: string[] }>(srv.base, "PUT", "/api/settings", {
        plugins: { senior: ["good"], junior: ["aaa", "good"] },
      });
      assert.equal(put.status, 200);
      // merged in senior-then-junior order, deduplicated
      assert.deepEqual(put.body.plugins, ["good", "aaa"]);
      const got = await api<{ plugins: string[] }>(srv.base, "GET", "/api/settings");
      assert.deepEqual(got.body.plugins, ["good", "aaa"]);
    } finally {
      await srv.close();
    }
    // the save migrated the section to the shared array shape
    const raw = JSON.parse(
      fs.readFileSync(path.join(sessions.root, "settings.json"), "utf-8"),
    ) as { plugins: unknown };
    assert.deepEqual(raw.plugins, ["good", "aaa"]);
  } finally {
    dir.cleanup();
    sessions.cleanup();
  }
});

test("a settings save carrying a plugins section reloads the plugin set", async () => {
  const dir = makePluginsDir({ "good.ts": GOOD_PLUGIN });
  try {
    const srv = await startServer({ pluginsDir: dir.root });
    try {
      // drop a new plugin after startup; a plugins-carrying save (re)imports
      fs.writeFileSync(path.join(dir.root, "late.ts"), MARKER_PLUGIN, "utf-8");
      const put = await api(srv.base, "PUT", "/api/settings", {
        plugins: [],
      });
      assert.equal(put.status, 200);
      const res = await api<PluginsView>(srv.base, "GET", "/api/plugins");
      assert.ok(res.body.plugins.some((p) => p.name === "late"));
      assert.deepEqual(res.body.errors, []);
    } finally {
      await srv.close();
    }
  } finally {
    dir.cleanup();
  }
});

test("settings PUT rejects an invalid plugins payload with a 400", async () => {
  const srv = await startServer();
  try {
    const nonList = await api(srv.base, "PUT", "/api/settings", { plugins: "good" });
    assert.equal(nonList.status, 400);
    const legacyNonList = await api(srv.base, "PUT", "/api/settings", {
      plugins: { senior: "good" },
    });
    assert.equal(legacyNonList.status, 400);
  } finally {
    await srv.close();
  }
});

test("deprecated TWO_BROTHERS_PLUGINS_SENIOR/JUNIOR merge into the shared list and are not saved", async (t) => {
  const dir = makePluginsDir({ "good.ts": GOOD_PLUGIN });
  const sessions = tmpdir("tb-sessions-");
  process.env.TWO_BROTHERS_PLUGINS_SENIOR = "good,other";
  process.env.TWO_BROTHERS_PLUGINS_JUNIOR = "third";
  t.after(() => {
    delete process.env.TWO_BROTHERS_PLUGINS_SENIOR;
    delete process.env.TWO_BROTHERS_PLUGINS_JUNIOR;
  });
  try {
    const srv = await startServer({ pluginsDir: dir.root, sessionsDir: sessions.root });
    try {
      // both legacy vars are additive aliases for the one shared list
      const got = await api<{ plugins: string[] }>(srv.base, "GET", "/api/settings");
      assert.deepEqual(got.body.plugins, ["good", "other", "third"]);
      // a save stores only the explicit list; the env names stay an overlay
      const put = await api<{ plugins: string[] }>(srv.base, "PUT", "/api/settings", {
        plugins: ["good"],
      });
      assert.equal(put.status, 200);
      assert.deepEqual(put.body.plugins, ["good", "other", "third"]);
      const raw = JSON.parse(
        fs.readFileSync(path.join(sessions.root, "settings.json"), "utf-8"),
      ) as { plugins: unknown };
      assert.deepEqual(raw.plugins, ["good"]);
    } finally {
      await srv.close();
    }
    // removing the deprecated vars reveals exactly the saved list
    delete process.env.TWO_BROTHERS_PLUGINS_SENIOR;
    delete process.env.TWO_BROTHERS_PLUGINS_JUNIOR;
    const srv2 = await startServer({ pluginsDir: dir.root, sessionsDir: sessions.root });
    try {
      const got2 = await api<{ plugins: string[] }>(srv2.base, "GET", "/api/settings");
      assert.deepEqual(got2.body.plugins, ["good"]);
    } finally {
      await srv2.close();
    }
  } finally {
    dir.cleanup();
    sessions.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Boundary tolerance
// ---------------------------------------------------------------------------

test("describe() sorts plugin names and reports the shared scope", async () => {
  const dir = makePluginsDir({ "good.ts": GOOD_PLUGIN, "aaa.ts": MARKER_PLUGIN });
  try {
    const manager = await PluginManager.create(dir.root);
    const names = manager.describe().plugins.map((p) => p.name);
    assert.deepEqual(names, ["aaa", "good"]);
    const goodEntry = manager.describe().plugins.find((p) => p.name === "good");
    assert.deepEqual(goodEntry?.roles, ["shared"]);
  } finally {
    dir.cleanup();
  }
});
