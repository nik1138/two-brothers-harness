/**
 * Plugin-contributed MCP servers (research/harnesses/plugins-pi.md R6).
 *
 * Hermetic: the registry/collect/merge logic is exercised with fake contexts
 * and fake module objects (temp-dir fixtures through the real dynamic-import
 * loader), and the merged config is fed to `loadMcpTools` over pi-mcp's
 * in-memory transport pair — no child process and no network. Namespacing
 * (`mcp__<server>__<tool>`), role routing and the 20 KiB result clip are
 * `mcp.ts`'s untouched behavior; the last test only proves the merge feeds
 * them byte-for-byte.
 *
 * Run with: node --test tests/pluginmcp.test.ts
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import {
  createInMemoryTransportPair,
  type InMemoryTransport,
} from "@earendil-works/pi-mcp/testing";

import {
  loadMcpTools,
  mergeMcpConfig,
  MCP_OUTPUT_MAX_CHARS,
  type McpConfigFileShape,
  type McpServerSpec,
} from "../src/mcp.ts";
import {
  collectPluginMcpServers,
  loadPlugins,
  PluginContext,
  PluginManager,
  type PluginMcpServer,
} from "../src/plugins.ts";

// ---------------------------------------------------------------------------
// fixtures + helpers
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

/** A temp plugins dir; `files` maps file name -> source. */
function makePluginsDir(files: Record<string, string>): {
  root: string;
  cleanup: () => void;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-pluginmcp-"));
  for (const [name, source] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, name), source, "utf-8");
  }
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }));
  return { root, cleanup: () => rmWithRetry(root) };
}

/** One plugin exercising both contribution paths (register + module export). */
const MCP_PLUGIN = [
  "export const mcpServers = {",
  '  manifest_http: { url: "https://example.invalid/mcp", headers: { Authorization: "Bearer test" }, role: "senior" },',
  '  notes: { url: "https://shadow.invalid/mcp" },',
  '  "%bad_name": { command: "nope" },',
  "  broken: { role: \"senior\" },",
  "};",
  "export function register(ctx) {",
  '  ctx.add_mcp_server("notes", { command: "node", args: ["notes.mjs"], env: { TOKEN: "${TOKEN}" }, role: "junior" });',
  "}",
  "",
].join("\n");

const BAD_MANIFEST_PLUGIN = [
  'export const mcpServers = "nope";',
  "export function register(ctx) {",
  '  ctx.set_description("broken manifest export");',
  "}",
  "",
].join("\n");

// ---------------------------------------------------------------------------
// fake MCP server over pi-mcp's in-memory transport pair
// ---------------------------------------------------------------------------

interface FakeToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run?: (args: Record<string, unknown>) => string;
}

interface FakeServer {
  client: InMemoryTransport;
  closed: boolean;
}

function startFakeServer(defs: FakeToolDef[]): FakeServer {
  const { client, server } = createInMemoryTransportPair();
  void server.start().catch(() => undefined);
  const fake: FakeServer = { client, closed: false };
  client.onClose(() => {
    fake.closed = true;
  });
  server.onMessage((message) => {
    const msg = message as Record<string, any>;
    const reply = (result: unknown): void => {
      void server.send({ jsonrpc: "2.0", id: msg.id, result } as never);
    };
    if (msg.method === "initialize") {
      reply({
        protocolVersion: msg.params?.protocolVersion ?? "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "fake-mcp", version: "1.0.0" },
      });
    } else if (msg.method === "tools/list") {
      reply({
        tools: defs.map((def) => ({
          name: def.name,
          description: def.description,
          inputSchema: def.inputSchema,
        })),
      });
    } else if (msg.method === "tools/call") {
      const callArgs = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      const def = defs.find((d) => d.name === msg.params?.name);
      if (!def) {
        reply({ content: [{ type: "text", text: `unknown tool: ${msg.params?.name}` }], isError: true });
        return;
      }
      try {
        reply({ content: [{ type: "text", text: def.run ? def.run(callArgs) : `called ${def.name}` }] });
      } catch {
        reply({ content: [{ type: "text", text: "boom" }], isError: true });
      }
    } else if (msg.id !== undefined && msg.id !== null) {
      void server.send({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32601, message: `method not found: ${msg.method}` },
      } as never);
    }
  });
  return fake;
}

function oneTool(name: string): FakeToolDef[] {
  return [
    {
      name,
      description: `The ${name} tool.`,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      run: () => `${name}: ok`,
    },
  ];
}

// ---------------------------------------------------------------------------
// ctx.add_mcp_server: registry + tolerant validation
// ---------------------------------------------------------------------------

test("add_mcp_server records declarations with plugin provenance", () => {
  const ctx = new PluginContext("notes_plugin");
  ctx.add_mcp_server("notes", { command: "node", args: ["notes.mjs"], role: "junior" });
  // `transport`/`type` style keys pass through untouched — only the transport
  // (command/url) and role/timeoutMs are checked; no default role is injected.
  ctx.add_mcp_server("remote", { transport: "http", url: "https://example.invalid/mcp" });

  assert.deepEqual(ctx.diagnostics, []);
  assert.deepEqual(ctx._mcpServers, [
    {
      name: "notes",
      config: { command: "node", args: ["notes.mjs"], role: "junior" },
      plugin: "notes_plugin",
    },
    {
      name: "remote",
      config: { transport: "http", url: "https://example.invalid/mcp" },
      plugin: "notes_plugin",
    },
  ]);
});

test("add_mcp_server rejects bad names and configs with diagnostics, never throws", () => {
  const ctx = new PluginContext("typo_plugin");
  ctx.add_mcp_server("BadName", { command: "x" });
  ctx.add_mcp_server("", { command: "x" });
  (ctx.add_mcp_server as (name: unknown, config: unknown) => void)(42, { command: "x" });
  ctx.add_mcp_server("no_transport", { role: "junior" });
  ctx.add_mcp_server("empty_command", { command: "   " });
  ctx.add_mcp_server("bad_role", { command: "x", role: "chief" });
  ctx.add_mcp_server("bad_timeout", { url: "https://example.invalid/mcp", timeoutMs: 0 });
  ctx.add_mcp_server(
    "array_config",
    [] as unknown as Record<string, unknown>,
  );

  assert.deepEqual(ctx._mcpServers, []);
  assert.equal(ctx.diagnostics.length, 8);
  assert.match(ctx.diagnostics[0], /"BadName".*name must match/);
  assert.match(ctx.diagnostics[1], /"" rejected: name must match/);
  assert.match(ctx.diagnostics[2], /42 rejected: name must match/);
  assert.match(ctx.diagnostics[3], /no_transport.*command.*url/);
  assert.match(ctx.diagnostics[4], /empty_command.*command.*url/);
  assert.match(ctx.diagnostics[5], /bad_role.*invalid role/);
  assert.match(ctx.diagnostics[6], /bad_timeout.*invalid timeoutMs/);
  assert.match(ctx.diagnostics[7], /array_config.*entry must be an object/);
});

test("a name registered twice by one plugin keeps the first declaration", () => {
  const ctx = new PluginContext("twice");
  ctx.add_mcp_server("dup", { command: "first" });
  ctx.add_mcp_server("dup", { command: "second" });

  assert.equal(ctx._mcpServers.length, 1);
  assert.equal(ctx._mcpServers[0].config.command, "first");
  assert.equal(ctx.diagnostics.length, 1);
  assert.match(ctx.diagnostics[0], /dup.*already registered by this plugin \(first wins\)/);
});

test("collectPluginMcpServers flattens contexts in order and keeps duplicates", () => {
  const alpha = new PluginContext("alpha");
  alpha.add_mcp_server("shared_mem", { command: "mem-server" });
  const beta = new PluginContext("beta");
  beta.add_mcp_server("shared_mem", { url: "https://beta.invalid/mcp" });
  beta.add_mcp_server("beta_tools", { command: "beta-server", role: "senior" });

  const collected = collectPluginMcpServers([alpha, beta]);
  assert.deepEqual(
    collected.map((server) => [server.name, server.plugin]),
    [
      ["shared_mem", "alpha"],
      ["shared_mem", "beta"],
      ["beta_tools", "beta"],
    ],
  );
  // fixtures are never shared between contexts
  assert.notEqual(collected[0].config, collected[1].config);
  assert.deepEqual(collectPluginMcpServers(new Set()), []);
});

// ---------------------------------------------------------------------------
// exported `mcpServers` manifest + loadPlugins / bindingsFor
// ---------------------------------------------------------------------------

test("loadPlugins ingests the exported mcpServers object into the same registry", async () => {
  const dir = makePluginsDir({ "mcpfixture.mts": MCP_PLUGIN });
  try {
    const result = await loadPlugins(dir.root);
    assert.deepEqual(result.errors, []);
    const loaded = result.plugins.get("mcpfixture");
    assert.ok(loaded);

    // register-time calls first, then the export's valid entries; bad entries
    // and the cross-path duplicate are dropped with diagnostics.
    assert.deepEqual(
      loaded.mcpServers.map((server) => [server.name, server.plugin]),
      [
        ["notes", "mcpfixture"],
        ["manifest_http", "mcpfixture"],
      ],
    );
    assert.deepEqual(loaded.mcpServers[0].config, {
      command: "node",
      args: ["notes.mjs"],
      env: { TOKEN: "${TOKEN}" },
      role: "junior",
    });
    assert.deepEqual(loaded.mcpServers[1].config, {
      url: "https://example.invalid/mcp",
      headers: { Authorization: "Bearer test" },
      role: "senior",
    });

    const messages = result.diagnostics
      .filter((entry) => entry.plugin === "mcpfixture")
      .map((entry) => entry.message);
    assert.equal(messages.length, 3);
    assert.match(messages.join("\n"), /"notes".*already registered by this plugin/);
    assert.match(messages.join("\n"), /"%bad_name".*name must match/);
    assert.match(messages.join("\n"), /"broken".*command.*url/);
    // the load itself is fail-soft: the plugin is present and usable
    assert.equal(loaded.description, "");
  } finally {
    dir.cleanup();
  }
});

test("a non-object exported mcpServers is a diagnostic, not a load failure", async () => {
  const dir = makePluginsDir({ "badmanifest.mts": BAD_MANIFEST_PLUGIN });
  try {
    const result = await loadPlugins(dir.root);
    assert.deepEqual(result.errors, []);
    const loaded = result.plugins.get("badmanifest");
    assert.ok(loaded);
    assert.deepEqual(loaded.mcpServers, []);
    assert.match(loaded.diagnostics.join("\n"), /exported 'mcpServers' is not an object/);
    assert.equal(loaded.description, "broken manifest export");
  } finally {
    dir.cleanup();
  }
});

test("bindingsFor exposes per-run MCP servers without a workspace", async () => {
  const dir = makePluginsDir({ "mcpfixture.mts": MCP_PLUGIN });
  try {
    const manager = await PluginManager.create(dir.root);
    const bindings = await manager.bindingsFor(["mcpfixture"], null);
    assert.deepEqual(
      bindings.mcpServers.map((server) => server.name),
      ["notes", "manifest_http"],
    );
    // the same per-plugin notes reach the run binding
    assert.match(
      bindings.diagnostics.map((entry) => entry.message).join("\n"),
      /"broken".*command.*url/,
    );
    // hooks/tools behavior is untouched by the MCP collection
    assert.deepEqual(bindings.tools, []);
    assert.deepEqual(
      Object.keys(bindings.hooks),
      ["session_start", "session_end", "before_tool_call", "after_tool_call"],
    );
  } finally {
    dir.cleanup();
  }
});

// ---------------------------------------------------------------------------
// mergeMcpConfig
// ---------------------------------------------------------------------------

test("mergeMcpConfig returns plugin servers under a null base (copied specs)", () => {
  const servers: PluginMcpServer[] = [
    { name: "notes", config: { command: "node", args: ["notes.mjs"] }, plugin: "notes" },
  ];
  const { config, diagnostics } = mergeMcpConfig(null, servers);

  assert.deepEqual(diagnostics, []);
  assert.deepEqual(config, {
    mcpServers: { notes: { command: "node", args: ["notes.mjs"] } },
  });
  assert.notEqual(config.mcpServers.notes, servers[0].config);
  assert.deepEqual(mergeMcpConfig(null).config, { mcpServers: {} });
});

test("a configured base entry wins a name collision; the base is not mutated", () => {
  const base: McpConfigFileShape = {
    mcpServers: {
      notes: { url: "https://configured.invalid/mcp", role: "shared" },
      fs: { command: "fs-server" },
    },
  };
  const before = JSON.parse(JSON.stringify(base)) as McpConfigFileShape;

  const { config, diagnostics } = mergeMcpConfig(base, [
    { name: "notes", config: { command: "impostor" }, plugin: "notes" },
    { name: "extra", config: { command: "extra-server" }, plugin: "extra" },
  ]);

  assert.deepEqual(config.mcpServers.notes, {
    url: "https://configured.invalid/mcp",
    role: "shared",
  });
  assert.deepEqual(config.mcpServers.fs, { command: "fs-server" });
  assert.deepEqual(config.mcpServers.extra, { command: "extra-server" });
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0], /"notes".*"notes".*already configured \(config wins\)/);
  assert.deepEqual(base, before);
});

test("a name contributed by two plugins keeps the first and reports it", () => {
  const { config, diagnostics } = mergeMcpConfig(null, [
    { name: "dup", config: { command: "first" }, plugin: "alpha" },
    { name: "dup", config: { command: "second" }, plugin: "beta" },
  ]);

  assert.equal(config.mcpServers.dup.command, "first");
  assert.equal(diagnostics.length, 1);
  assert.match(
    diagnostics[0],
    /"dup".*"beta".*already contributed by plugin "alpha" \(first wins\)/,
  );
});

test("mergeMcpConfig skips invalid declarations and an invalid base with diagnostics", () => {
  const merged = mergeMcpConfig(
    { mcpServers: [] as unknown as Record<string, McpServerSpec> },
    [
      { name: "Bad", config: { command: "x" }, plugin: "p" },
      { name: "no_transport", config: { role: "junior" }, plugin: "p" },
      { name: "bad_role", config: { command: "x", role: "chief" }, plugin: "p" },
      null as unknown as PluginMcpServer,
    ],
  );

  assert.deepEqual(merged.config.mcpServers, {});
  assert.equal(merged.diagnostics.length, 5);
  assert.match(merged.diagnostics[0], /'mcpServers' must be an object/);
  assert.match(merged.diagnostics[1], /"Bad".*name must match/);
  assert.match(merged.diagnostics[2], /no_transport.*command.*url/);
  assert.match(merged.diagnostics[3], /bad_role.*invalid role/);
  assert.match(merged.diagnostics[4], /undefined|\(unknown plugin\)/);
});

// ---------------------------------------------------------------------------
// merge boundary -> loadMcpTools (namespacing + role routing unchanged)
// ---------------------------------------------------------------------------

test("merged config feeds loadMcpTools unchanged: namespacing and roles", async () => {
  const sources = new Map<string, FakeServer>();
  const addFake = (name: string, tool: string): void => {
    sources.set(name, startFakeServer(oneTool(tool)));
  };
  addFake("configured", "base_read");
  addFake("plugin_notes", "plugin_read");
  addFake("plugin_default", "default_read");

  const ctx = new PluginContext("notes_plugin");
  ctx.add_mcp_server("plugin_notes", { command: "unused", role: "senior" });
  ctx.add_mcp_server("plugin_default", { command: "unused" });
  const merged = mergeMcpConfig(
    { mcpServers: { configured: { command: "unused", role: "junior" } } },
    collectPluginMcpServers([ctx]),
  );
  assert.deepEqual(merged.diagnostics, []);

  const mcp = await loadMcpTools(merged.config, {
    transportFor: (serverName) => {
      const fake = sources.get(serverName);
      if (!fake) throw new Error(`no fake server for '${serverName}'`);
      return fake.client;
    },
  });
  try {
    assert.deepEqual(mcp.errors, []);
    assert.deepEqual(mcp.client.servers, ["configured", "plugin_notes", "plugin_default"]);
    // namespacing is pi's, unchanged by the merge
    assert.deepEqual(
      mcp.sharedTools.map((tool) => tool.name),
      [],
    );
    assert.deepEqual(
      mcp.seniorTools.map((tool) => tool.name),
      ["mcp__plugin_notes__plugin_read"],
    );
    // no `role` in the declaration = junior (mcp.ts's documented default)
    assert.deepEqual(
      mcp.juniorTools.map((tool) => tool.name),
      ["mcp__configured__base_read", "mcp__plugin_default__default_read"],
    );
    assert.equal(mcp.displayNames["mcp__plugin_notes__plugin_read"], "plugin_notes/plugin_read");
    // the result clip is mcp.ts's untouched contract
    assert.equal(MCP_OUTPUT_MAX_CHARS, 20 * 1024);
  } finally {
    await mcp.client.close();
  }
});