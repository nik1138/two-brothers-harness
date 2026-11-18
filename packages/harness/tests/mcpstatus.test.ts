/**
 * MCP status tests: the pure view builders in `src/mcpstatus.ts`
 * (`describeConfigured`, `deriveRunStatus`, `summarizeLoadFailure`) and the
 * `GET /api/mcp` route in `src/server.ts` — what is configured (config file +
 * plugin contributions, effective role, transport, secrets-free target) and
 * how the last run's MCP load went (connected/failed per server). Hermetic:
 * the route test starts the real server in-process on an ephemeral port with
 * a mock provider and fake MCP servers on pi-mcp's in-memory transport pair.
 *
 * Run with: node tests/run-all.ts (or node --test tests/)
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { resolveConfig, type Config } from "../src/config.ts";
import type { McpServerSpec } from "../src/mcp.ts";
import {
  MCP_STATUS_ERROR_MAX_CHARS,
  MCP_TARGET_MAX_CHARS,
  deriveRunStatus,
  describeConfigured,
  summarizeLoadFailure,
} from "../src/mcpstatus.ts";
import type { PluginMcpServer } from "../src/plugins.ts";
import { createServer, type ServerOptions } from "../src/server.ts";
import { startFakeServer } from "./fixtures/fake-mcp-server.ts";

// ---------------------------------------------------------------------------
// describeConfigured
// ---------------------------------------------------------------------------

test("describeConfigured: config-only entries carry source, null plugin, default junior role", () => {
  const view = describeConfigured({
    alpha: { command: "deja", args: ["mcp"] },
    beta: { url: "https://example.com/mcp", role: "senior" },
  });
  assert.deepEqual(view, [
    {
      name: "alpha",
      source: "config",
      plugin: null,
      role: "junior",
      transport: "stdio",
      target: "deja mcp",
    },
    {
      name: "beta",
      source: "config",
      plugin: null,
      role: "senior",
      transport: "http",
      target: "https://example.com/mcp",
    },
  ]);
});

test("describeConfigured: plugin entries carry the contributing plugin and sort by name", () => {
  const pluginServers: PluginMcpServer[] = [
    { name: "zeta", config: { command: "run-zeta" }, plugin: "notes" },
    { name: "gamma", config: { url: "https://gamma.example/mcp", role: "shared" }, plugin: "other" },
  ];
  const view = describeConfigured(null, pluginServers);
  assert.deepEqual(
    view.map((entry) => [entry.name, entry.source, entry.plugin, entry.role]),
    [
      ["gamma", "plugin", "other", "shared"],
      ["zeta", "plugin", "notes", "junior"],
    ],
  );
});

test("describeConfigured: a config entry wins a name collision over a plugin entry", () => {
  const view = describeConfigured(
    { deja: { command: "cfg", args: ["mcp"] } },
    [{ name: "deja", config: { command: "plugin" }, plugin: "notes" }],
  );
  assert.equal(view.length, 1);
  assert.equal(view[0].source, "config");
  assert.equal(view[0].plugin, null);
  assert.equal(view[0].target, "cfg mcp");
});

test("describeConfigured: first plugin wins a name collision between plugins", () => {
  const view = describeConfigured(null, [
    { name: "dup", config: { command: "first" }, plugin: "one" },
    { name: "dup", config: { command: "second" }, plugin: "two" },
  ]);
  assert.equal(view.length, 1);
  assert.equal(view[0].plugin, "one");
  assert.equal(view[0].target, "first");
});

test("describeConfigured: invalid names and invalid specs from plugins are dropped", () => {
  const view = describeConfigured(null, [
    { name: "BAD NAME!", config: { command: "x" }, plugin: "p" },
    { name: "nospec", config: {}, plugin: "p" },
    { name: "ok", config: { command: "fine" }, plugin: "p" },
  ]);
  assert.deepEqual(
    view.map((entry) => entry.name),
    ["ok"],
  );
});

test("describeConfigured: invalid transport when neither command nor url is set", () => {
  const view = describeConfigured({ empty: {} });
  assert.deepEqual(view, [
    { name: "empty", source: "config", plugin: null, role: "junior", transport: "invalid", target: "" },
  ]);
});

test("describeConfigured: http wins when both url and command are present (loader order)", () => {
  const view = describeConfigured({ both: { command: "cmd", url: "https://x.example/mcp" } });
  assert.equal(view[0].transport, "http");
  assert.equal(view[0].target, "https://x.example/mcp");
});

test("describeConfigured: target is bounded and never carries env or header values", () => {
  const longArgs = Array.from({ length: 100 }, (_, i) => `arg-${i}`);
  const view = describeConfigured({
    big: { command: "tool", args: longArgs, env: { SECRET: "s3cr3t" } },
    authed: { url: "https://x.example/mcp", headers: { Authorization: "Bearer s3cr3t" } },
  });
  const big = view.find((entry) => entry.name === "big");
  assert.ok(big);
  assert.ok(big.target.length <= MCP_TARGET_MAX_CHARS, `target ${big.target.length} chars`);
  assert.ok(big.target.includes("...[truncated"));
  assert.ok(!big.target.includes("s3cr3t"));
  assert.ok(!view.find((entry) => entry.name === "authed")!.target.includes("s3cr3t"));
});

// ---------------------------------------------------------------------------
// deriveRunStatus / summarizeLoadFailure
// ---------------------------------------------------------------------------

function fakeToolSet(overrides: {
  servers?: string[];
  errors?: string[];
  tools?: Array<{ server: string }>;
}) {
  return {
    client: { servers: overrides.servers ?? [], close: async () => undefined },
    errors: overrides.errors ?? [],
    tools: (overrides.tools ?? []).map((tool, i) => ({
      server: tool.server,
      name: `t${i}`,
    })) as never,
  };
}

test("deriveRunStatus: connected server reports its tool count, failed server parses the error prefix", () => {
  const servers = deriveRunStatus(["good", "broken"], {
    client: { servers: ["good"], close: async () => undefined },
    errors: ["MCP server 'broken': initialization timed out after 30000 ms"],
    tools: [
      { server: "good", name: "a" },
      { server: "good", name: "b" },
    ] as never,
  });
  assert.deepEqual(servers, [
    { name: "broken", status: "failed", error: "initialization timed out after 30000 ms", toolCount: 0 },
    { name: "good", status: "connected", toolCount: 2 },
  ]);
});

test("deriveRunStatus: a failed server with no matching error line gets the generic detail", () => {
  const servers = deriveRunStatus(["mystery"], fakeToolSet({}));
  assert.deepEqual(servers, [
    { name: "mystery", status: "failed", error: "failed to connect", toolCount: 0 },
  ]);
});

test("deriveRunStatus: entries are sorted by name regardless of input order", () => {
  const servers = deriveRunStatus(
    ["z", "a", "m"],
    fakeToolSet({ servers: ["z", "a", "m"] }),
  );
  assert.deepEqual(
    servers.map((entry) => entry.name),
    ["a", "m", "z"],
  );
});

test("deriveRunStatus: error detail is bounded to MCP_STATUS_ERROR_MAX_CHARS", () => {
  const huge = "x".repeat(MCP_STATUS_ERROR_MAX_CHARS * 3);
  const servers = deriveRunStatus(
    ["loud"],
    fakeToolSet({ errors: [`MCP server 'loud': ${huge}`] }),
  );
  assert.ok(servers[0].error!.length <= MCP_STATUS_ERROR_MAX_CHARS + 40);
  assert.ok(servers[0].error!.includes("...[truncated"));
});

test("summarizeLoadFailure: one bounded failed entry per configured server", () => {
  const longMessage = "y".repeat(1000);
  const servers = summarizeLoadFailure(["b", "a"], new Error(longMessage));
  assert.deepEqual(
    servers.map((entry) => [entry.name, entry.status, entry.toolCount]),
    [
      ["a", "failed", 0],
      ["b", "failed", 0],
    ],
  );
  for (const entry of servers) {
    assert.ok(entry.error!.length <= MCP_STATUS_ERROR_MAX_CHARS + 40);
    assert.ok(entry.error!.includes("...[truncated"));
  }
});

// ---------------------------------------------------------------------------
// GET /api/mcp (real server, ephemeral port, mock provider, fake MCP servers)
// ---------------------------------------------------------------------------

function tmpdir(prefix: string): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
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
  return { status: res.status, body: JSON.parse(text) as T };
}

async function startStatusServer(
  options: ServerOptions,
): Promise<{ base: string; close(): Promise<void> }> {
  const tmp = tmpdir("tb-mcp-status-");
  const handle = createServer({
    configFactory: () => resolveConfig({ provider: "mock", mode: "consult" }) as Config,
    webDist: null,
    ...options,
    sessionsDir: options.sessionsDir ? path.resolve(options.sessionsDir) : tmp.root,
  });
  const server = await handle.listen("127.0.0.1", 0);
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    close: async () => {
      await handle.close();
      tmp.cleanup();
    },
  };
}

async function waitTerminal(
  base: string,
  runId: string,
  timeoutMs = 15000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await api<Record<string, unknown>>(base, "GET", `/api/runs/${runId}`);
    if (["completed", "failed", "cancelled"].includes(String(body.status))) return body;
    if (Date.now() > deadline) throw new Error(`run ${runId} did not finish in time`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("GET /api/mcp: nothing configured answers {configured: [], lastRun: null}", async () => {
  const srv = await startStatusServer({});
  try {
    const res = await api<Record<string, unknown>>(srv.base, "GET", "/api/mcp");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { configured: [], lastRun: null });
  } finally {
    await srv.close();
  }
});

test("GET /api/mcp: a run records connected + failed servers; configured lists both sources", async () => {
  const tmp = tmpdir("tb-mcp-status-run-");
  const good = startFakeServer([
    { name: "ping", description: "Ping.", inputSchema: { type: "object", properties: {} } },
    { name: "pong", description: "Pong.", inputSchema: { type: "object", properties: {} } },
  ]);
  const configPath = path.join(tmp.root, "mcp.json");
  const config: { mcpServers: Record<string, McpServerSpec> } = {
    mcpServers: {
      good: { command: "unused-good", role: "senior" },
      broken: { command: "unused-broken" },
    },
  };
  fs.writeFileSync(configPath, JSON.stringify(config), "utf-8");
  const srv = await startStatusServer({
    sessionsDir: tmp.root,
    mcpConfig: configPath,
    mcpLoadOptions: {
      transportFor: (name) => {
        if (name === "good") return good.client;
        throw new Error(`no fake server for '${name}'`);
      },
    },
  });
  try {
    const before = await api<{ configured: unknown[]; lastRun: unknown }>(
      srv.base,
      "GET",
      "/api/mcp",
    );
    assert.equal(before.status, 200);
    assert.equal(before.body.lastRun, null);
    assert.equal(before.body.configured.length, 2);

    const started = await api<{ run_id: string }>(srv.base, "POST", "/api/runs", {
      task: "status me",
    });
    assert.equal(started.status, 202);
    const record = await waitTerminal(srv.base, String(started.body.run_id));
    assert.equal(record.status, "completed");

    const res = await api<{
      configured: Array<Record<string, unknown>>;
      lastRun: {
        at: string;
        session: string;
        runId: string;
        servers: Array<Record<string, unknown>>;
      } | null;
    }>(srv.base, "GET", "/api/mcp");
    assert.equal(res.status, 200);

    // configured: both servers, sorted by name, with effective role/transport
    // and a secrets-free target straight from the config file.
    assert.deepEqual(res.body.configured, [
      {
        name: "broken",
        source: "config",
        plugin: null,
        role: "junior",
        transport: "stdio",
        target: "unused-broken",
      },
      {
        name: "good",
        source: "config",
        plugin: null,
        role: "senior",
        transport: "stdio",
        target: "unused-good",
      },
    ]);

    // lastRun: recorded by the run, one connected + one failed server.
    const lastRun = res.body.lastRun;
    assert.ok(lastRun, "lastRun is recorded after a run with MCP configured");
    assert.ok(Number.isNaN(Date.parse(lastRun.at)) === false, "at is ISO-8601");
    assert.equal(typeof lastRun.session, "string");
    assert.ok(lastRun.session.length > 0);
    assert.equal(lastRun.runId, String(started.body.run_id));
    assert.deepEqual(lastRun.servers, [
      {
        name: "broken",
        status: "failed",
        error: `no fake server for 'broken'`,
        toolCount: 0,
      },
      { name: "good", status: "connected", toolCount: 2 },
    ]);
  } finally {
    await srv.close();
    tmp.cleanup();
  }
});

test("GET /api/mcp: a run with nothing configured leaves lastRun untouched", async () => {
  const srv = await startStatusServer({});
  try {
    const started = await api<{ run_id: string }>(srv.base, "POST", "/api/runs", {
      task: "plain run",
    });
    assert.equal(started.status, 202);
    const record = await waitTerminal(srv.base, String(started.body.run_id));
    assert.equal(record.status, "completed");
    const res = await api<{ configured: unknown[]; lastRun: unknown }>(
      srv.base,
      "GET",
      "/api/mcp",
    );
    assert.deepEqual(res.body, { configured: [], lastRun: null });
  } finally {
    await srv.close();
  }
});
