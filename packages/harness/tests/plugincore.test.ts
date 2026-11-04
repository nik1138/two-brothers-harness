/**
 * Plugin-core extensions: per-tool scope opt-in (with the legacy positional
 * `role` mapping + deprecation note), the typed fail-soft hook registry,
 * dispatch-time argument validation, per-tool timeouts, and per-plugin
 * options validated against an optional exported `configSchema`.
 *
 * Fixture plugins are written to temp dirs at runtime and loaded through the
 * real dynamic-import path, like tests/plugins.test.ts.
 *
 * Run with: node --test tests/plugincore.test.ts
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { Decision, PermissionManager, StaticBroker } from "../src/permissions.ts";
import {
  PluginContext,
  PluginError,
  PluginManager,
  asHarnessTool,
  collectHooks,
  createHookRegistry,
  dispatchHook,
  effectiveToolScope,
  loadPlugins,
  normalizePluginSettings,
  resolvePluginOptions,
  validateToolArgs,
  type BeforeToolCallEvent,
  type PluginSetting,
  type PluginToolHandler,
  type RegisteredTool,
} from "../src/plugins.ts";
import { Workspace } from "../src/workspace.ts";

// ---------------------------------------------------------------------------
// helpers + fixtures
// ---------------------------------------------------------------------------

function rmWithRetry(target: string): void {
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

function makePluginsDir(files: Record<string, string>): {
  root: string;
  cleanup: () => void;
} {
  const tmp = tmpdir("tb-plugincore-");
  for (const [name, source] of Object.entries(files)) {
    fs.writeFileSync(path.join(tmp.root, name), source, "utf-8");
  }
  // `.ts` fixtures resolve as ESM without Node's typeless-package warning.
  fs.writeFileSync(path.join(tmp.root, "package.json"), JSON.stringify({ type: "module" }));
  return tmp;
}

function workspaceWith(root: string): Workspace {
  return new Workspace(root, new PermissionManager(null, new StaticBroker(Decision.ALLOW)));
}

function registeredTool(
  partial: Partial<RegisteredTool> & { name: string; handler: PluginToolHandler },
): RegisteredTool {
  return {
    description: "",
    paramsSchema: {},
    role: "junior",
    scope: "shared",
    ...partial,
  };
}

const PLAIN_PLUGIN = [
  "export const description = 'A plain plugin';",
  "export function register(ctx) {",
  '  ctx.add_tool("plain", () => "plain", "A plain tool");',
  "}",
  "",
].join("\n");

const SCOPES_PLUGIN = [
  "export const description = 'Scope fixture';",
  "export function register(ctx) {",
  '  ctx.add_tool("both", () => "both");',
  '  ctx.add_tool("senior_only", () => "senior", { scope: "senior" });',
  '  ctx.add_tool("junior_only", () => "junior", { scope: "junior" });',
  '  ctx.add_tool("legacy_senior", () => "legacy", "", {}, "senior");',
  "}",
  "",
].join("\n");

const SCHEMA_PLUGIN = [
  "export function register(ctx) {",
  "  ctx.add_tool(",
  '    "code_tool",',
  '    (args) => "ran:" + args.code,',
  "    {",
  '      description: "A validated tool",',
  "      parameters: {",
  '        type: "object",',
  '        properties: { code: { type: "string" } },',
  '        required: ["code"],',
  "        additionalProperties: false,",
  "      },",
  "      timeoutMs: 500,",
  "    },",
  "  );",
  "}",
  "",
].join("\n");

const HOOKS_PLUGIN = [
  "export const description = 'Hook fixture';",
  "export function register(ctx) {",
  '  ctx.on_hook("before_tool_call", (event) => {',
  '    if (event.tool === "blocked") return { deny: "blocked by hook" };',
  "    event.args.seen = true;",
  "  });",
  '  ctx.on_hook("after_tool_call", (event) => { event.result = "rewritten"; });',
  '  ctx.add_tool("echo", (args) => JSON.stringify(args));',
  "}",
  "",
].join("\n");

const BAD_HOOK_PLUGIN = [
  "export function register(ctx) {",
  '  ctx.on_hook("before_tool_call", () => { throw new Error("hook kaboom"); });',
  '  ctx.add_tool("bad", () => "bad");',
  "}",
  "",
].join("\n");

const OPTS_PLUGIN = [
  "export const configSchema = {",
  '  type: "object",',
  '  properties: { greeting: { type: "string" } },',
  '  required: ["greeting"],',
  "  additionalProperties: false,",
  "};",
  "export const manifest = {",
  '  name: "opts",',
  '  version: "1.2.3",',
  '  description: "Manifest-described plugin",',
  "};",
  "export function register(ctx) {",
  '  ctx.add_tool("greet", () => String(ctx.options.greeting ?? "none"), "Greet the operator");',
  "}",
  "",
].join("\n");

const BAD_SCHEMA_PLUGIN = [
  "export const configSchema = 7;",
  "export function register(ctx) {",
  '  ctx.add_tool("echo", () => String(ctx.options.value ?? "none"));',
  "}",
  "",
].join("\n");

// ---------------------------------------------------------------------------
// add_tool options: scope, description, parameters, timeoutMs
// ---------------------------------------------------------------------------

test("add_tool defaults to the shared scope and stores the declared one", () => {
  const ctx = new PluginContext("unit");
  ctx.add_tool("plain", () => "");
  ctx.add_tool("seniors", () => "", { scope: "senior" });
  ctx.add_tool("juniors", () => "", { scope: "junior", description: "junior tool" });
  assert.deepEqual(
    ctx._tools.map((tool) => [tool.name, tool.scope, tool.role]),
    [
      ["plain", "shared", "junior"],
      ["seniors", "senior", "senior"],
      ["juniors", "junior", "junior"],
    ],
  );
  assert.equal(ctx._tools[2].description, "junior tool");
  // declaring a scope explicitly is not a deprecation
  assert.deepEqual(ctx.diagnostics, []);
});

test("add_tool options: parameters double as the model-facing schema", () => {
  const ctx = new PluginContext("unit");
  const parameters = {
    type: "object" as const,
    properties: { code: { type: "string" as const } },
    required: ["code"],
  };
  ctx.add_tool("verified", () => "", { parameters, timeoutMs: 250 });
  const [tool] = ctx._tools;
  assert.equal(tool.parameters, parameters);
  assert.deepEqual(tool.paramsSchema, parameters);
  assert.equal(tool.timeoutMs, 250);
  assert.deepEqual(asHarnessTool(tool).parameters, parameters);
});

test("add_tool options are validated (PluginError on bad values)", () => {
  const ctx = new PluginContext("unit");
  assert.throws(
    () => ctx.add_tool("bad_scope", () => "", { scope: "chief" as never }),
    (exc: unknown) => exc instanceof PluginError && /unknown scope/.test(exc.message),
  );
  assert.throws(
    () => ctx.add_tool("bad_timeout", () => "", { timeoutMs: 0 }),
    (exc: unknown) => exc instanceof PluginError && /timeoutMs/.test(exc.message),
  );
  assert.throws(
    () => ctx.add_tool("bad_params", () => "", { parameters: [] as never }),
    (exc: unknown) => exc instanceof PluginError && /parameters/.test(exc.message),
  );
  assert.equal(ctx._tools.length, 0);
});

test("the legacy positional role maps onto scope and leaves a deprecation note", () => {
  const ctx = new PluginContext("unit");
  ctx.add_tool("legacy", () => "", "", {}, "senior");
  assert.equal(ctx._tools[0].scope, "senior");
  assert.equal(ctx._tools[0].scopeSource, "legacy-role");
  assert.equal(ctx._tools[0].role, "senior");
  assert.equal(ctx.diagnostics.length, 1);
  assert.match(ctx.diagnostics[0], /positional role argument is deprecated/);
  assert.match(ctx.diagnostics[0], /"senior"/);
  // the owner decision wins: a legacy role does not scope assignment
  assert.equal(effectiveToolScope(ctx._tools[0]), "shared");
  // an explicit opt-in does
  ctx.add_tool("opted_in", () => "", { scope: "senior" });
  assert.equal(ctx._tools[1].scopeSource, "explicit");
  assert.equal(effectiveToolScope(ctx._tools[1]), "senior");
  // nothing declared: shared
  assert.equal(effectiveToolScope(registeredTool({ name: "bare", handler: () => "" })), "shared");
});

test("the legacy positional role keeps validating (unknown role still throws)", () => {
  const ctx = new PluginContext("unit");
  assert.throws(
    () => ctx.add_tool("mischief", () => "", "", {}, "chief"),
    (exc: unknown) => exc instanceof PluginError && /unknown role/.test(exc.message),
  );
  // omitting the role keeps the historical shared default, silently
  ctx.add_tool("plain", () => "", "description", { word: "string" });
  assert.equal(ctx._tools[0].scope, "shared");
  assert.deepEqual(ctx.diagnostics, []);
});

// ---------------------------------------------------------------------------
// Hooks: registration, ordering, fail-soft dispatch, monotonic deny
// ---------------------------------------------------------------------------

test("on_hook records per-plugin handlers in registration order", () => {
  const first = new PluginContext("first");
  const second = new PluginContext("second");
  first.on_hook("session_start", () => {});
  second.on_hook("session_start", () => {});
  first.on_hook("session_start", () => {});
  const registry = collectHooks([first, second]);
  assert.deepEqual(
    registry.session_start.map((hook) => hook.plugin),
    ["first", "first", "second"],
  );
  assert.deepEqual(registry.session_end, []);
});

test("on_hook rejects unknown names and non-callable handlers", () => {
  const ctx = new PluginContext("unit");
  assert.throws(
    () => ctx.on_hook("nope" as never, () => {}),
    (exc: unknown) => exc instanceof PluginError && /unknown hook/.test(exc.message),
  );
  assert.throws(
    () => ctx.on_hook("session_start", 5 as never),
    (exc: unknown) => exc instanceof PluginError && /not callable/.test(exc.message),
  );
  assert.equal(ctx._hooks.length, 0);
});

test("dispatchHook runs handlers in order, awaits them, and shares the event", async () => {
  const ctx = new PluginContext("ordered");
  const calls: string[] = [];
  ctx.on_hook("before_tool_call", async (event) => {
    calls.push("first");
    await Promise.resolve();
    event.args.value = 1;
  });
  ctx.on_hook("before_tool_call", (event) => {
    calls.push(`second:${String(event.args.value)}`);
  });
  const event: BeforeToolCallEvent = { role: "junior", tool: "write", args: {} };
  const result = await dispatchHook(collectHooks([ctx]), "before_tool_call", event);
  assert.deepEqual(calls, ["first", "second:1"]);
  assert.equal(event.args.value, 1);
  assert.equal(result.deny, undefined);
  assert.deepEqual(result.errors, []);
});

test("a returned deny is recorded on the event and reported", async () => {
  const ctx = new PluginContext("gate");
  ctx.on_hook("before_tool_call", (event) =>
    event.tool === "danger" ? { deny: "not allowed" } : undefined,
  );
  const blocked: BeforeToolCallEvent = { role: "senior", tool: "danger", args: {} };
  const allowed: BeforeToolCallEvent = { role: "senior", tool: "read", args: {} };
  const registry = collectHooks([ctx]);
  assert.equal((await dispatchHook(registry, "before_tool_call", blocked)).deny, "not allowed");
  assert.equal(blocked.deny, "not allowed");
  assert.equal((await dispatchHook(registry, "before_tool_call", allowed)).deny, undefined);
  // a directly assigned deny counts too
  const ctx2 = new PluginContext("assigning");
  ctx2.on_hook("before_tool_call", (event) => {
    event.deny = "veto";
  });
  const event: BeforeToolCallEvent = { role: "junior", tool: "x", args: {} };
  assert.equal((await dispatchHook(collectHooks([ctx2]), "before_tool_call", event)).deny, "veto");
});

test("deny is monotonic: later handlers cannot un-deny", async () => {
  const ctx = new PluginContext("gate");
  ctx.on_hook("before_tool_call", () => ({ deny: "first" }));
  ctx.on_hook("before_tool_call", (event) => {
    event.deny = undefined;
    return { deny: undefined };
  });
  ctx.on_hook("before_tool_call", () => ({ deny: "third" }));
  const event: BeforeToolCallEvent = { role: "junior", tool: "x", args: {} };
  const result = await dispatchHook(collectHooks([ctx]), "before_tool_call", event);
  assert.equal(result.deny, "first");
  assert.equal(event.deny, "first");
});

test("a throwing handler is contained: diagnostics + errors, other handlers still run", async () => {
  const bad = new PluginContext("bad");
  bad.on_hook("after_tool_call", () => {
    throw new Error("kaput");
  });
  const good = new PluginContext("good");
  good.on_hook("after_tool_call", async (event) => {
    event.result = "redacted";
  });
  const event = { role: "senior" as const, tool: "read", args: {}, result: "secret" };
  const result = await dispatchHook(collectHooks([bad, good]), "after_tool_call", event);
  assert.equal(event.result, "redacted");
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /hook after_tool_call from plugin "bad" failed: Error: kaput/);
  assert.deepEqual(bad.diagnostics, result.errors);
  assert.deepEqual(good.diagnostics, []);
});

test("session hooks receive their events in plugin order", async () => {
  const one = new PluginContext("one");
  const two = new PluginContext("two");
  const seen: string[] = [];
  one.on_hook("session_start", (event) => {
    seen.push(`one:${event.session_id}`);
  });
  two.on_hook("session_start", (event) => {
    seen.push(`two:${event.workspace ?? "no-workspace"}`);
  });
  await dispatchHook(collectHooks([one, two]), "session_start", {
    session_id: "s1",
    workspace: null,
  });
  assert.deepEqual(seen, ["one:s1", "two:no-workspace"]);
});

test("createHookRegistry starts empty and extendable", () => {
  const registry = createHookRegistry();
  assert.deepEqual(registry, {
    session_start: [],
    session_end: [],
    before_tool_call: [],
    after_tool_call: [],
  });
});

// ---------------------------------------------------------------------------
// Dispatch-time argument validation + tool timeouts
// ---------------------------------------------------------------------------

test("validateToolArgs accepts declared args and reports invalid ones", () => {
  const tool = registeredTool({
    name: "code_tool",
    handler: () => "ran",
    parameters: {
      type: "object",
      properties: { code: { type: "string" } },
      required: ["code"],
      additionalProperties: false,
    },
  });
  const ok = validateToolArgs(tool, { code: "abc" });
  assert.deepEqual(ok, { ok: true, args: { code: "abc" } });
  assert.deepEqual(validateToolArgs(tool, { code: 7 }), {
    ok: false,
    error: "invalid arguments: args.code: expected string, got number",
  });
  assert.deepEqual(validateToolArgs(tool, {}), {
    ok: false,
    error: "invalid arguments: args.code: required property missing",
  });
});

test("tools without a declared parameters schema stay tolerant", () => {
  const tool = registeredTool({
    name: "legacy",
    handler: () => "",
    paramsSchema: { count: "integer" },
  });
  assert.deepEqual(validateToolArgs(tool, { count: "not an integer" }), {
    ok: true,
    args: { count: "not an integer" },
  });
});

test("asHarnessTool refuses invalid args before the handler runs", async () => {
  let calls = 0;
  const tool = registeredTool({
    name: "code_tool",
    handler: () => {
      calls += 1;
      return "ran";
    },
    parameters: { type: "object", properties: { code: { type: "string" } } },
  });
  const harnessTool = asHarnessTool(tool);
  assert.equal(
    await harnessTool.execute({ code: 7 }),
    "plugin tool error: invalid arguments: args.code: expected string, got number",
  );
  assert.equal(calls, 0);
  assert.equal(await harnessTool.execute({ code: "ok" }), "ran");
  assert.equal(calls, 1);
});

test("a declared timeoutMs bounds the handler fail-softly", async () => {
  const ctx = new PluginContext("unit");
  ctx.add_tool("slow", () => new Promise(() => {}), { timeoutMs: 10 });
  const result = await asHarnessTool(ctx._tools[0]).execute({});
  assert.equal(result, "plugin tool error: timed out after 10 ms");

  ctx.add_tool("fast", async () => "quick", { timeoutMs: 1000 });
  assert.equal(await asHarnessTool(ctx._tools[1]).execute({}), "quick");
});

// ---------------------------------------------------------------------------
// Settings normalization + option validation
// ---------------------------------------------------------------------------

test("normalizePluginSettings accepts strings and {path, options}, drops junk", () => {
  assert.deepEqual(normalizePluginSettings(), []);
  assert.deepEqual(
    normalizePluginSettings([
      "notes",
      "  ",
      { path: " opts " },
      { path: "other", options: { greeting: "hi" } },
      { path: "" },
    ]),
    [
      { path: "notes", options: {} },
      { path: "opts", options: {} },
      { path: "other", options: { greeting: "hi" } },
    ],
  );
  assert.deepEqual(
    normalizePluginSettings([5, null, { options: { x: 1 } }] as unknown as PluginSetting[]),
    [],
  );
});

test("resolvePluginOptions validates against an exported configSchema, fail-soft", () => {
  const schema = {
    type: "object",
    properties: { greeting: { type: "string" } },
    required: ["greeting"],
  } as const;
  const ok = resolvePluginOptions({ configSchema: schema }, { greeting: "hi" });
  assert.deepEqual(ok, { options: { greeting: "hi" }, diagnostics: [] });

  const rejected = resolvePluginOptions({ configSchema: schema }, { greeting: 7 });
  assert.deepEqual(rejected.options, {});
  assert.equal(rejected.diagnostics.length, 1);
  assert.match(rejected.diagnostics[0], /options rejected by configSchema/);
  assert.match(rejected.diagnostics[0], /args\.greeting: expected string, got number/);

  const freeform = resolvePluginOptions({}, { anything: true });
  assert.deepEqual(freeform, { options: { anything: true }, diagnostics: [] });

  const malformed = resolvePluginOptions({ configSchema: 7 }, { anything: true });
  assert.deepEqual(malformed.options, { anything: true });
  assert.match(malformed.diagnostics[0], /not a JSON-schema object/);
});

// ---------------------------------------------------------------------------
// Loader: per-plugin options, manifest, diagnostics
// ---------------------------------------------------------------------------

test("loadPlugins applies settings options and records the manifest", async () => {
  const dir = makePluginsDir({ "opts.ts": OPTS_PLUGIN });
  try {
    const loaded = await loadPlugins(dir.root, 0, [
      { path: "opts", options: { greeting: "hi" } },
    ]);
    assert.deepEqual(loaded.errors, []);
    assert.deepEqual(loaded.diagnostics, []);
    const plugin = loaded.plugins.get("opts");
    assert.ok(plugin);
    assert.deepEqual(plugin.options, { greeting: "hi" });
    assert.equal(plugin.manifest?.version, "1.2.3");
    assert.equal(plugin.description, "Manifest-described plugin");
    const [greet] = plugin.tools;
    assert.equal(await asHarnessTool(greet).execute({}), "hi");
  } finally {
    dir.cleanup();
  }
});

test("invalid plugin options load with {} and one diagnostic", async () => {
  const dir = makePluginsDir({ "opts.ts": OPTS_PLUGIN });
  try {
    const loaded = await loadPlugins(dir.root, 0, [
      { path: "opts", options: { greeting: 7 } },
    ]);
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.plugins.size, 1);
    assert.deepEqual(loaded.plugins.get("opts")?.options, {});
    assert.equal(loaded.diagnostics.length, 1);
    assert.equal(loaded.diagnostics[0].plugin, "opts");
    assert.match(loaded.diagnostics[0].message, /options rejected by configSchema/);
    // the plugin still registered its tool and runs with the empty options
    assert.equal(await asHarnessTool(loaded.plugins.get("opts")!.tools[0]).execute({}), "none");
  } finally {
    dir.cleanup();
  }
});

test("a malformed configSchema is a diagnostic, not a load failure", async () => {
  const dir = makePluginsDir({ "badschema.ts": BAD_SCHEMA_PLUGIN });
  try {
    const loaded = await loadPlugins(dir.root, 0, [
      { path: "badschema", options: { value: "kept" } },
    ]);
    assert.deepEqual(loaded.errors, []);
    assert.deepEqual(loaded.plugins.get("badschema")?.options, { value: "kept" });
    assert.match(loaded.diagnostics[0].message, /not a JSON-schema object/);
  } finally {
    dir.cleanup();
  }
});

test("the historical string-only call shape still loads everything", async () => {
  const dir = makePluginsDir({ "plain.ts": PLAIN_PLUGIN });
  try {
    const all = await loadPlugins(dir.root);
    assert.deepEqual([...all.plugins.keys()], ["plain"]);
    assert.deepEqual(all.diagnostics, []);
    // a bare-string settings list means "no options", exactly like before
    const listed = await loadPlugins(dir.root, 1, ["plain"]);
    assert.deepEqual([...listed.plugins.keys()], ["plain"]);
    assert.deepEqual(listed.plugins.get("plain")?.options, {});
    assert.deepEqual(listed.diagnostics, []);
    assert.equal(listed.plugins.get("plain")?.description, "A plain plugin");
  } finally {
    dir.cleanup();
  }
});

test("a schema-declaring plugin with no options gets a diagnostic, not a failure", async () => {
  const dir = makePluginsDir({ "opts.ts": OPTS_PLUGIN });
  try {
    // `required: ["greeting"]` plus no settings entry means the declared
    // config is missing: fail-soft, so load with {} and say why.
    const loaded = await loadPlugins(dir.root, 0, ["opts"]);
    assert.deepEqual(loaded.errors, []);
    assert.deepEqual(loaded.plugins.get("opts")?.options, {});
    assert.match(loaded.diagnostics[0].message, /required property missing/);
    assert.equal(await asHarnessTool(loaded.plugins.get("opts")!.tools[0]).execute({}), "none");
  } finally {
    dir.cleanup();
  }
});

test("the manager carries load-time diagnostics and settings", async () => {
  const dir = makePluginsDir({ "scopes.ts": SCOPES_PLUGIN, "opts.ts": OPTS_PLUGIN });
  try {
    const manager = await PluginManager.create(dir.root, [
      { path: "opts", options: { greeting: "cfg" } },
    ]);
    assert.deepEqual(manager.errors, []);
    assert.deepEqual(manager.plugins.get("opts")?.options, { greeting: "cfg" });
    const deprecations = manager.diagnostics.filter((entry) => entry.plugin === "scopes");
    assert.equal(deprecations.length, 1);
    assert.match(deprecations[0].message, /deprecated/);
    // the legacy role was mapped onto the recorded scope
    const scopes = Object.fromEntries(
      (manager.plugins.get("scopes")?.tools ?? []).map((tool) => [tool.name, tool.scope]),
    );
    assert.deepEqual(scopes, {
      both: "shared",
      senior_only: "senior",
      junior_only: "junior",
      legacy_senior: "senior",
    });
  } finally {
    dir.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Per-run bindings: scope buckets, hooks, diagnostics, options overrides
// ---------------------------------------------------------------------------

test("bindingsFor buckets tools by declared scope and keeps the flat list", async () => {
  const dir = makePluginsDir({ "scopes.ts": SCOPES_PLUGIN });
  const tmp = tmpdir("tb-plugincore-ws-");
  try {
    const manager = await PluginManager.create(dir.root);
    const bindings = await manager.bindingsFor(["scopes"], workspaceWith(tmp.root));
    assert.deepEqual(
      bindings.tools.map((tool) => tool.name),
      ["both", "senior_only", "junior_only", "legacy_senior"],
    );
    // explicit opt-ins are honoured; the legacy-role tool stays shared
    // (owner decision 2026-11-03) even though its `scope` field says "senior"
    assert.deepEqual(bindings.toolsByScope.shared.map((tool) => tool.name), [
      "both",
      "legacy_senior",
    ]);
    assert.deepEqual(bindings.toolsByScope.senior.map((tool) => tool.name), ["senior_only"]);
    assert.deepEqual(bindings.toolsByScope.junior.map((tool) => tool.name), ["junior_only"]);
    // the flat list holds the same Tool objects
    assert.equal(bindings.toolsByScope.shared[0], bindings.tools[0]);
    // the deprecation is visible per run too
    assert.ok(bindings.diagnostics.some((entry) => /deprecated/.test(entry.message)));
    // toolsFor stays the flat compatibility view
    const flat = await manager.toolsFor(["scopes"], workspaceWith(tmp.root));
    assert.deepEqual(flat.map((tool) => tool.name), bindings.tools.map((tool) => tool.name));
    // unknown plugin names contribute nothing
    const empty = await manager.bindingsFor(["ghost"], workspaceWith(tmp.root));
    assert.deepEqual(empty.tools, []);
    assert.deepEqual(empty.diagnostics, []);
  } finally {
    dir.cleanup();
    tmp.cleanup();
  }
});

test("bindingsFor collects per-run hooks; hook failures reach run diagnostics", async () => {
  const dir = makePluginsDir({ "hooks.ts": HOOKS_PLUGIN, "badhook.ts": BAD_HOOK_PLUGIN });
  const tmp = tmpdir("tb-plugincore-ws-");
  try {
    const manager = await PluginManager.create(dir.root);
    assert.equal(manager.plugins.get("hooks")?.hooks.length, 2);
    const bindings = await manager.bindingsFor(["badhook", "hooks"], workspaceWith(tmp.root));
    assert.deepEqual(
      bindings.hooks.before_tool_call.map((hook) => hook.plugin),
      ["badhook", "hooks"],
    );
    const event: BeforeToolCallEvent = { role: "junior", tool: "workspace_read_file", args: {} };
    const result = await dispatchHook(bindings.hooks, "before_tool_call", event);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /"badhook"/);
    assert.equal(event.args.seen, true); // the healthy plugin still ran
    assert.equal(result.deny, undefined);
    // the failure is visible on the live run diagnostics view
    assert.ok(
      bindings.diagnostics.some(
        (entry) => entry.plugin === "badhook" && /hook before_tool_call/.test(entry.message),
      ),
    );

    // a veto from the healthy plugin
    const blocked: BeforeToolCallEvent = { role: "senior", tool: "blocked", args: {} };
    assert.equal((await dispatchHook(bindings.hooks, "before_tool_call", blocked)).deny, "blocked by hook");
  } finally {
    dir.cleanup();
    tmp.cleanup();
  }
});

test("hooks are collected without a workspace, tools are not", async () => {
  const dir = makePluginsDir({ "hooks.ts": HOOKS_PLUGIN });
  try {
    const manager = await PluginManager.create(dir.root);
    const bindings = await manager.bindingsFor(["hooks"], null);
    assert.deepEqual(bindings.tools, []);
    assert.deepEqual(bindings.toolsByScope, { shared: [], senior: [], junior: [] });
    assert.equal(bindings.hooks.before_tool_call.length, 1);
    assert.equal(await manager.toolsFor(["hooks"], null).then((tools) => tools.length), 0);
  } finally {
    dir.cleanup();
  }
});

test("per-run options override manager settings and are validated per run", async () => {
  const dir = makePluginsDir({ "opts.ts": OPTS_PLUGIN });
  const tmp = tmpdir("tb-plugincore-ws-");
  try {
    const manager = await PluginManager.create(dir.root, [
      { path: "opts", options: { greeting: "cfg" } },
    ]);
    const ws = workspaceWith(tmp.root);
    // manager settings are the fallback for a bare-string activation
    const fromSettings = await manager.bindingsFor(["opts"], ws);
    assert.equal(await fromSettings.tools[0].execute({}), "cfg");
    // an explicit {path, options} entry wins
    const override = await manager.bindingsFor(
      [{ path: "opts", options: { greeting: "run" } }],
      ws,
    );
    assert.equal(await override.tools[0].execute({}), "run");
    // invalid per-run options fall back to {} with a diagnostic
    const rejected = await manager.bindingsFor(
      [{ path: "opts", options: { greeting: false } }],
      ws,
    );
    assert.equal(await rejected.tools[0].execute({}), "none");
    assert.ok(rejected.diagnostics.some((entry) => /options rejected/.test(entry.message)));
  } finally {
    dir.cleanup();
    tmp.cleanup();
  }
});

test("a registration failure for a run is reported, not thrown", async () => {
  const dir = makePluginsDir({
    "flaky.ts": [
      "let calls = 0;",
      "export function register(ctx) {",
      "  calls += 1;",
      '  if (calls > 1) throw new Error("boom on re-register");',
      '  ctx.add_tool("flaky", () => "ok");',
      "}",
      "",
    ].join("\n"),
    "plain.ts": PLAIN_PLUGIN,
  });
  const tmp = tmpdir("tb-plugincore-ws-");
  try {
    const manager = await PluginManager.create(dir.root);
    const bindings = await manager.bindingsFor(["flaky", "plain"], workspaceWith(tmp.root));
    assert.deepEqual(bindings.tools.map((tool) => tool.name), ["plain"]);
    assert.ok(
      bindings.diagnostics.some(
        (entry) => entry.plugin === "flaky" && /registration failed for a run/.test(entry.message),
      ),
    );
  } finally {
    dir.cleanup();
    tmp.cleanup();
  }
});