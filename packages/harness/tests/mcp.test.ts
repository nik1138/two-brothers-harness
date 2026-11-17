/**
 * MCP loading + role-scoped tool registry tests. Mirrors the intent of the
 * original prototype's MCP tests (removed 2026-11-04; see git history), but
 * hermetic: a fake MCP server speaks
 * JSON-RPC over pi-mcp's in-memory transport pair (shared fixture in
 * ./fixtures/fake-mcp-server.ts), so no child process or network is needed.
 * One test at the bottom exercises the real stdio transport against
 * tests/fixtures/mcp-demo-server.mjs and skips when spawning is unavailable;
 * another exercises the real streamable-HTTP transport against a loopback
 * node:http server.
 */
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import type { JsonRpcId, McpTransport, McpTransportMessageListener } from "@earendil-works/pi-mcp";

import { resolveConfig } from "../src/config.ts";
import { TwoBrothersHarness } from "../src/harness.ts";
import {
  closeMcpClientBounded,
  createMcpToolName,
  loadMcpTools,
  loadMcpToolSpecs,
  MCP_CLOSE_TIMEOUT_MS,
  MCP_TOOL_NAME_MAX_LENGTH,
  type McpToolClient,
  type McpToolSet,
} from "../src/mcp.ts";
import { MockProvider, type MockScriptStep, type Tool } from "../src/provider.ts";
import { main, type CliIO } from "../src/cli.ts";
import {
  configOf,
  startFakeServer,
  toolOf,
  transportFactory,
  type FakeServer,
  type FakeToolDef,
} from "./fixtures/fake-mcp-server.ts";

// ---------------------------------------------------------------------------
// fake MCP servers come from ./fixtures/fake-mcp-server.ts (shared with
// pluginmcp.test.ts)
// ---------------------------------------------------------------------------

const THREE_TOOLS: FakeToolDef[] = [
  {
    name: "mem_read",
    description: "Read the shared memory.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: () => "memory: hello",
  },
  {
    name: "mem_write",
    description: "Write the shared memory.",
    inputSchema: {
      type: "object",
      properties: { note: { type: "string" } },
      required: ["note"],
    },
    run: (args) => `wrote: ${args.note}`,
  },
  {
    name: "senior_audit",
    description: "Audit log readable only by the senior.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: () => "audit: clean",
  },
];

// ---------------------------------------------------------------------------
// loading / conversion
// ---------------------------------------------------------------------------

test("loads and converts MCP tools (in-memory transport)", async () => {
  const fake = startFakeServer(THREE_TOOLS);
  const mcp = await loadMcpTools(configOf({ fake: { command: "unused" } }), {
    transportFor: transportFactory(new Map([["fake", fake]])),
  });
  try {
    assert.deepEqual(mcp.errors, []);
    assert.deepEqual(mcp.client.servers, ["fake"]);
    assert.equal(mcp.tools.length, 3);

    const read = toolOf(mcp, "fake", "mem_read");
    assert.equal(read.name, "mcp__fake__mem_read");
    assert.equal(read.displayName, "fake/mem_read");
    assert.equal(mcp.displayNames[read.name], "fake/mem_read");
    assert.equal(read.description, "Read the shared memory.");
    assert.deepEqual(read.parameters, THREE_TOOLS[0].inputSchema);

    // execute goes through the MCP wire and back (the wire still sees raw names)
    assert.equal(await read.execute({}), "memory: hello");
    const write = toolOf(mcp, "fake", "mem_write");
    assert.equal(await write.execute({ note: "ship it" }), "wrote: ship it");
    assert.deepEqual(fake.calls.map((c) => c.name), ["mem_read", "mem_write"]);
  } finally {
    await mcp.client.close();
  }
});

test("client.close() is idempotent and closes the transport", async () => {
  const fake = startFakeServer(THREE_TOOLS);
  const mcp = await loadMcpTools(configOf({ fake: { command: "unused" } }), {
    transportFor: transportFactory(new Map([["fake", fake]])),
  });
  await mcp.client.close();
  await mcp.client.close(); // second call: no-op, still resolves
  assert.equal(fake.closed, true);
});

// ---------------------------------------------------------------------------
// bounded run-end close (a wedged transport must not pin the caller's slot)
// ---------------------------------------------------------------------------

function activeTimeoutCount(): number {
  return (process as unknown as { _getActiveHandles(): unknown[] })._getActiveHandles().filter(
    (handle) => (handle as { constructor?: { name?: string } }).constructor?.name === "Timeout",
  ).length;
}

test("bounded close: a wedged client resolves after the grace with one honest diagnostic", async () => {
  assert.equal(MCP_CLOSE_TIMEOUT_MS, 5_000, "default grace matches serve's shutdown grace");
  const wedged: McpToolClient = {
    servers: ["wedged"],
    close: () => new Promise<void>(() => undefined), // never settles
  };
  const diagnostics: string[] = [];
  const started = Date.now();
  await closeMcpClientBounded(wedged, { timeoutMs: 50, onTimeout: (line) => diagnostics.push(line) });
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 45, `waited out the grace (${elapsed} ms)`);
  assert.ok(elapsed < 5_000, `released promptly after the grace (${elapsed} ms)`);
  assert.equal(diagnostics.length, 1, "exactly one diagnostic");
  assert.match(diagnostics[0], /did not settle within 50 ms/);
  assert.match(diagnostics[0], /servers: wedged/);
  assert.match(diagnostics[0], /unwinds in the background/);
});

test("bounded close: a normal close stays immediate and silent", async () => {
  const fake = startFakeServer(THREE_TOOLS);
  const mcp = await loadMcpTools(configOf({ fake: { command: "unused" } }), {
    transportFor: transportFactory(new Map([["fake", fake]])),
  });
  const diagnostics: string[] = [];
  const started = Date.now();
  await closeMcpClientBounded(mcp.client, { onTimeout: (line) => diagnostics.push(line) });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1_000, `normal close was not delayed (${elapsed} ms)`);
  assert.deepEqual(diagnostics, [], "no diagnostic on a clean close");
  assert.equal(fake.closed, true, "the transport really closed");
});

test("bounded close: a rejecting close still propagates (errors preserved)", async () => {
  const failing: McpToolClient = {
    servers: ["bad"],
    close: () => Promise.reject(new Error("close blew up")),
  };
  const diagnostics: string[] = [];
  await assert.rejects(
    () => closeMcpClientBounded(failing, { timeoutMs: 50, onTimeout: (line) => diagnostics.push(line) }),
    /close blew up/,
  );
  assert.deepEqual(diagnostics, [], "a fast rejection is not a timeout");
});

test("bounded close: the race timer is cleared on both paths (no lingering handle)", async () => {
  const fast: McpToolClient = { servers: ["fast"], close: () => Promise.resolve() };
  const wedged: McpToolClient = { servers: ["wedged"], close: () => new Promise<void>(() => undefined) };
  const before = activeTimeoutCount();
  await closeMcpClientBounded(fast, { timeoutMs: 10_000 });
  const afterFast = activeTimeoutCount();
  await closeMcpClientBounded(wedged, { timeoutMs: 20 });
  const afterWedged = activeTimeoutCount();
  assert.equal(afterFast, before, "fast close cleared its timer (REF'd, so it would linger if not cleared)");
  assert.ok(afterWedged <= before, "wedged close left no timer behind");
});

test("per-request abort cancels an in-flight MCP tool call", async () => {
  const fake = startFakeServer([
    ...THREE_TOOLS,
    { name: "hang", description: "never answers", inputSchema: { type: "object" }, hang: true },
  ]);
  const mcp = await loadMcpTools(configOf({ fake: { command: "unused" } }), {
    transportFor: transportFactory(new Map([["fake", fake]])),
  });
  try {
    const controller = new AbortController();
    const pending = Promise.resolve(toolOf(mcp, "fake", "hang").execute({}, controller.signal));
    // let the request actually reach the server before aborting
    await fake.waitForCalls(1);
    assert.deepEqual(fake.calls.map((c) => c.name), ["hang"]);
    controller.abort();
    // the in-flight call rejects with pi-mcp's abort (no result, no timeout string)
    await assert.rejects(pending, (exc: unknown) => {
      assert.ok(exc instanceof Error);
      assert.match(exc.message, /aborted/i);
      return true;
    });
    // the aborted call never receives a late result, and the client itself is
    // still healthy: a fresh call on the same connection succeeds
    assert.equal(await toolOf(mcp, "fake", "mem_read").execute({}), "memory: hello");
    assert.deepEqual(fake.calls.map((c) => c.name), ["hang", "mem_read"]);
  } finally {
    await mcp.client.close();
  }
});

test("${VAR} references in env expand from process.env before transport creation", async () => {
  const fake = startFakeServer(THREE_TOOLS);
  process.env.TB_MCP_TEST_TOKEN = "sekret";
  try {
    const seen: Array<Record<string, string> | undefined> = [];
    await loadMcpTools(
      configOf({
        fake: { command: "unused", env: { TOKEN: "${TB_MCP_TEST_TOKEN}", LITERAL: "x" } },
      }),
      {
        transportFor: (_name, spec) => {
          seen.push(spec.env);
          return fake.client;
        },
      },
    ).then((mcp) => mcp.client.close());
    assert.deepEqual(seen, [{ TOKEN: "sekret", LITERAL: "x" }]);
  } finally {
    delete process.env.TB_MCP_TEST_TOKEN;
  }
});

// ---------------------------------------------------------------------------
// fail-soft behavior
// ---------------------------------------------------------------------------

test("a failing server is collected in errors; the others still load", async () => {
  const good = startFakeServer(THREE_TOOLS);
  const mcp = await loadMcpTools(
    configOf({
      bad: { command: "unused" },
      good: { command: "unused" },
    }),
    {
      transportFor: (name) => {
        if (name === "bad") throw new Error("spawn failed");
        return good.client;
      },
    },
  );
  try {
    assert.equal(mcp.tools.length, 3, "good server's tools loaded despite the bad one");
    assert.equal(mcp.errors.length, 1);
    assert.match(mcp.errors[0], /^MCP server 'bad': spawn failed/);
    assert.deepEqual(mcp.client.servers, ["good"]);
  } finally {
    await mcp.client.close();
  }
});

test("invalid role, missing command/url or bad timeoutMs records an error and skips", async () => {
  const fake = startFakeServer(THREE_TOOLS);
  const mcp = await loadMcpTools(
    configOf({
      weird: { command: "x", role: "operator" as never },
      empty: {},
      slowish: { command: "x", timeoutMs: -5 },
      fine: { command: "x" },
    }),
    { transportFor: transportFactory(new Map([["fine", fake]])) },
  );
  try {
    assert.equal(mcp.tools.length, 3, "only 'fine' loaded");
    assert.equal(mcp.errors.length, 3);
    assert.match(mcp.errors[0], /MCP server 'weird': invalid role 'operator'/);
    assert.match(mcp.errors[1], /MCP server 'empty': entry needs 'command' or 'url'/);
    assert.match(mcp.errors[2], /MCP server 'slowish': invalid timeoutMs '-5'/);
  } finally {
    await mcp.client.close();
  }
});

test("servers without a role default to the junior scope (Python parity)", async () => {
  const fake = startFakeServer(THREE_TOOLS);
  const mcp = await loadMcpTools(configOf({ plain: { command: "x" } }), {
    transportFor: transportFactory(new Map([["plain", fake]])),
  });
  try {
    assert.equal(mcp.juniorTools.length, 3);
    assert.equal(mcp.sharedTools.length, 0);
    assert.equal(mcp.seniorTools.length, 0);
  } finally {
    await mcp.client.close();
  }
});

// ---------------------------------------------------------------------------
// config file reading (the --mcp-config path)
// ---------------------------------------------------------------------------

test("loadMcpToolSpecs raises on a missing file or non-object mcpServers", () => {
  assert.throws(() => loadMcpToolSpecs(path.join(os.tmpdir(), "tb-mcp-nope.json")), /MCP config not found/);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tb-mcp-spec-"));
  try {
    const bad = path.join(tmp, "bad.json");
    fs.writeFileSync(bad, JSON.stringify({ mcpServers: ["nope"] }), "utf-8");
    assert.throws(() => loadMcpToolSpecs(bad), /'mcpServers' must be an object/);
    const good = path.join(tmp, "good.json");
    fs.writeFileSync(good, JSON.stringify({ mcpServers: { a: { command: "x" } } }), "utf-8");
    assert.deepEqual(Object.keys(loadMcpToolSpecs(good)), ["a"]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// role-scoped run: shared / junior-only / senior-only
// ---------------------------------------------------------------------------

/** MockProvider that records the tool lists offered to it. */
class RecordingMock extends MockProvider {
  readonly seenToolNames: string[][] = [];
  constructor(steps: MockScriptStep[] = []) {
    super(steps);
  }
  override async chatWithTools(
    messages: Parameters<MockProvider["chatWithTools"]>[0],
    tools: Tool[],
    options?: Parameters<MockProvider["chatWithTools"]>[2],
  ): Promise<Awaited<ReturnType<MockProvider["chatWithTools"]>>> {
    this.seenToolNames.push(tools.map((t) => t.name));
    return super.chatWithTools(messages, tools, options);
  }
}

/**
 * One server per scope, one tool each: mem_read (shared), mem_write
 * (junior), senior_audit (senior). The junior is scripted to call a
 * junior-only and the shared tool; the senior to call the shared and its
 * senior-only tool.
 */
async function scopedRun(): Promise<{
  juniorSeen: string[][];
  seniorSeen: string[][];
  calls: Array<{ name: string }>;
  mcp: McpToolSet;
  fakes: FakeServer[];
}> {
  const fakes = {
    shared: startFakeServer([THREE_TOOLS[0]]),
    junior: startFakeServer([THREE_TOOLS[1]]),
    senior: startFakeServer([THREE_TOOLS[2]]),
  };
  const map = new Map(Object.entries(fakes));
  const mcp = await loadMcpTools(
    configOf({
      sharedSrv: { command: "x", role: "shared" },
      juniorSrv: { command: "x", role: "junior" },
      seniorSrv: { command: "x", role: "senior" },
    }),
    {
      transportFor: (name) => {
        const key = { sharedSrv: "shared", juniorSrv: "junior", seniorSrv: "senior" }[name];
        if (!key) throw new Error(`no fake server for '${name}'`);
        return map.get(key)!.client;
      },
    },
  );
  const junior = new RecordingMock([
    { tool: "mcp__juniorSrv__mem_write", args: { note: "draft" } },
    { tool: "mcp__sharedSrv__mem_read", args: {} },
    { text: '{"result": "done", "artifacts": [], "notes": "", "confidence": 0.9}' },
  ]);
  const senior = new RecordingMock([
    { tool: "mcp__sharedSrv__mem_read", args: {} },
    { tool: "mcp__seniorSrv__senior_audit", args: {} },
    { text: '{"verdict": "accept", "notes": "verified", "points": []}' },
  ]);
  const harness = new TwoBrothersHarness(resolveConfig({ provider: "mock", mode: "work" }), {
    senior,
    junior,
    toolScopes: {
      shared: mcp.sharedTools,
      senior: mcp.seniorTools,
      junior: mcp.juniorTools,
    },
  });
  await harness.run("cooperate through MCP");
  return {
    juniorSeen: junior.seenToolNames,
    seniorSeen: senior.seenToolNames,
    calls: [...fakes.shared.calls, ...fakes.junior.calls, ...fakes.senior.calls],
    mcp,
    fakes: [fakes.shared, fakes.junior, fakes.senior],
  };
}

test("role-scoped run: shared callable by both, scoped tools stay on their belt", async () => {
  const { juniorSeen, seniorSeen, calls, mcp } = await scopedRun();
  try {
    assert.ok(juniorSeen.length > 0, "junior entered its tool loop");
    assert.ok(seniorSeen.length > 0, "senior entered its verification loop");

    // junior belt: shared + junior, never senior-only (namespaced wire names)
    for (const offered of juniorSeen) {
      assert.ok(offered.includes("mcp__sharedSrv__mem_read"), "shared tool offered to the junior");
      assert.ok(offered.includes("mcp__juniorSrv__mem_write"), "junior-only tool offered to the junior");
      assert.ok(!offered.includes("mcp__seniorSrv__senior_audit"), "senior-only tool absent from the junior belt");
    }
    // senior belt: shared + senior, never junior-only
    for (const offered of seniorSeen) {
      assert.ok(offered.includes("mcp__sharedSrv__mem_read"), "shared tool offered to the senior");
      assert.ok(offered.includes("mcp__seniorSrv__senior_audit"), "senior-only tool offered to the senior");
      assert.ok(!offered.includes("mcp__juniorSrv__mem_write"), "junior-only tool absent from the senior's slice");
    }

    // and both brothers actually executed the shared tool over MCP
    const counts = new Map<string, number>();
    for (const call of calls) counts.set(call.name, (counts.get(call.name) ?? 0) + 1);
    assert.equal(counts.get("mem_read") ?? 0, 2, "shared tool executed by both brothers");
    assert.equal(counts.get("mem_write") ?? 0, 1);
    assert.equal(counts.get("senior_audit") ?? 0, 1);
  } finally {
    await mcp.client.close();
  }
});

test("the MCP client stays alive through the run and closes afterwards", async () => {
  const { mcp, fakes } = await scopedRun();
  // still connected while the tool belt holds: a fresh call succeeds
  const read = mcp.sharedTools[0];
  assert.equal(await read.execute({}), "memory: hello");
  await mcp.client.close();
  for (const fake of fakes) assert.equal(fake.closed, true, "server transport closed");
});

// ---------------------------------------------------------------------------
// CLI: --mcp-config
// ---------------------------------------------------------------------------

function makeIO(): CliIO & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, log: (line) => out.push(line), error: (line) => err.push(line) };
}

test("CLI --mcp-config: missing config warns and the run continues", async () => {
  const io = makeIO();
  const code = await main(
    ["run", "smoke", "--provider", "mock", "--mcp-config", path.join(os.tmpdir(), "tb-mcp-missing.json")],
    io,
  );
  assert.equal(code, 0);
  assert.ok(io.err.some((line) => line.startsWith("[warn] MCP: MCP config not found")), io.err.join("\n"));
  assert.ok(io.out.some((line) => line.includes("[senior -> user] decision")));
});

test("CLI --mcp-config: real stdio server tools join the run", async () => {
  const serverPath = fileURLToPath(new URL("./fixtures/mcp-demo-server.mjs", import.meta.url));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tb-mcp-cli-"));
  let code: number | null = null;
  const io = makeIO();
  try {
    const configPath = path.join(tmp, "mcp.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: { demo: { command: process.execPath, args: [serverPath], role: "shared" } },
      }),
      "utf-8",
    );
    code = await main(["run", "smoke", "--provider", "mock", "--mcp-config", configPath], io);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  if (io.err.some((line) => line.startsWith("[warn]") && line.includes("'demo'"))) {
    // spawning unavailable in this environment: warn, not fail
    return;
  }
  assert.equal(code, 0, io.err.join("\n"));
  assert.deepEqual(io.err.filter((line) => line.startsWith("[warn]")), []);
  assert.ok(io.out.some((line) => line.includes("[senior -> user] decision")));
});

// ---------------------------------------------------------------------------
// stdio transport end-to-end (skipped where spawning is unavailable)
// ---------------------------------------------------------------------------

test("stdio transport: demo MCP server end-to-end", async (t) => {
  const serverPath = fileURLToPath(new URL("./fixtures/mcp-demo-server.mjs", import.meta.url));
  const mcp = await loadMcpTools({
    mcpServers: {
      demo: {
        command: process.execPath,
        args: [serverPath],
        role: "shared",
        env: { TB_DEMO_MARKER: "marker-123" },
      },
    },
  });
  try {
    if (mcp.tools.length === 0) {
      t.skip(`stdio MCP server could not be spawned: ${mcp.errors.join("; ")}`);
      return;
    }
    assert.deepEqual(mcp.errors, []);
    assert.deepEqual(
      mcp.tools.map((tool) => tool.name).sort(),
      ["mcp__demo__demo_add", "mcp__demo__demo_echo", "mcp__demo__demo_env"],
    );
    const byName = new Map(mcp.tools.map((tool) => [tool.name, tool]));
    assert.equal(await byName.get("mcp__demo__demo_add")!.execute({ a: 2, b: 3 }), "5");
    assert.equal(await byName.get("mcp__demo__demo_echo")!.execute({ text: "ping" }), "ping");
    // env pass-through on the spawned server
    assert.equal(await byName.get("mcp__demo__demo_env")!.execute({ name: "TB_DEMO_MARKER" }), "marker-123");
    assert.deepEqual(mcp.client.servers, ["demo"]);
  } finally {
    await mcp.client.close();
  }
});

// ---------------------------------------------------------------------------
// streamable-HTTP transport end-to-end over a real loopback socket
// (pi-mcp's StreamableHttpTransport against a node:http MCP endpoint)
// ---------------------------------------------------------------------------

test("streamable-HTTP transport: url: server end-to-end over loopback", async () => {
  const received: Array<{ method?: string; params?: Record<string, unknown> }> = [];
  const server = http.createServer((req, res) => {
    if (req.method === "GET") {
      // no server-to-client SSE stream: the transport tolerates 405
      res.writeHead(405).end();
      return;
    }
    if (req.method === "DELETE") {
      res.writeHead(202).end();
      return;
    }
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const msg = JSON.parse(body) as { id?: unknown; method?: string; params?: Record<string, unknown> };
      received.push({ method: msg.method, params: msg.params });
      const replyJson = (result: unknown, extraHeaders: Record<string, string> = {}): void => {
        res.writeHead(200, { "content-type": "application/json", ...extraHeaders }).end(
          JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }),
        );
      };
      if (msg.method === "initialize") {
        replyJson(
          {
            protocolVersion: (msg.params as { protocolVersion?: string })?.protocolVersion ?? "2025-11-25",
            capabilities: { tools: {} },
            serverInfo: { name: "loopback-http", version: "1.0.0" },
          },
          { "mcp-session-id": "test-session" },
        );
      } else if (msg.method === "notifications/initialized") {
        res.writeHead(202).end();
      } else if (msg.method === "tools/list") {
        replyJson({ tools: THREE_TOOLS });
      } else if (msg.method === "tools/call") {
        const name = String((msg.params as { name?: unknown })?.name);
        replyJson({ content: [{ type: "text", text: `http: ${name}` }] });
      } else {
        res.writeHead(404).end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/mcp`;
  const mcp = await loadMcpTools(configOf({ web: { url, role: "shared" } }));
  try {
    assert.deepEqual(mcp.errors, []);
    assert.deepEqual(mcp.client.servers, ["web"]);
    assert.deepEqual(mcp.tools.map((t) => t.name).sort(), [
      "mcp__web__mem_read",
      "mcp__web__mem_write",
      "mcp__web__senior_audit",
    ]);
    assert.equal(await toolOf(mcp, "web", "mem_read").execute({}), "http: mem_read");
    assert.equal(mcp.sharedTools.length, 3, "role: shared routing through the url: transport");
  } finally {
    await mcp.client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  assert.ok(
    received.some((m) => m.method === "tools/call"),
    "the HTTP server really saw the tool call",
  );
});

// ---------------------------------------------------------------------------
// hardening: namespacing, result cap, per-call timeout
// ---------------------------------------------------------------------------

const SEARCH_TOOL: FakeToolDef = {
  name: "search",
  description: "Search one server's index.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  run: () => "hit",
};

test("tool names are namespaced per server; cross-server collisions keep both tools", async () => {
  const alpha = startFakeServer([SEARCH_TOOL]);
  const beta = startFakeServer([SEARCH_TOOL]);
  const mcp = await loadMcpTools(
    configOf({ alpha: { command: "x", role: "shared" }, beta: { command: "x", role: "shared" } }),
    { transportFor: transportFactory(new Map([["alpha", alpha], ["beta", beta]])) },
  );
  try {
    assert.deepEqual(mcp.errors, []);
    assert.deepEqual(mcp.tools.map((tool) => tool.name).sort(), [
      "mcp__alpha__search",
      "mcp__beta__search",
    ]);
    assert.equal(mcp.tools.length, 2, "no last-wins drop across servers");
    assert.deepEqual(mcp.displayNames, {
      "mcp__alpha__search": "alpha/search",
      "mcp__beta__search": "beta/search",
    });
    assert.equal(await toolOf(mcp, "alpha", "search").execute({}), "hit");
    assert.equal(await toolOf(mcp, "beta", "search").execute({}), "hit");
    assert.equal(alpha.calls.length, 1);
    assert.equal(beta.calls.length, 1);
  } finally {
    await mcp.client.close();
  }
});

test("sanitized name collisions in one server get a stable hash suffix", async () => {
  const defs: FakeToolDef[] = [
    { name: "a-b", description: "dash", inputSchema: { type: "object" }, run: () => "dash" },
    { name: "a_b", description: "underscore", inputSchema: { type: "object" }, run: () => "underscore" },
  ];
  const load = async () => {
    const fake = startFakeServer(defs);
    return loadMcpTools(configOf({ srv: { command: "x" } }), {
      transportFor: () => fake.client,
    });
  };
  const first = await load();
  const second = await load();
  try {
    const names = first.tools.map((tool) => tool.name);
    assert.deepEqual(names, second.tools.map((tool) => tool.name), "hash suffix is stable");
    assert.equal(names[0], "mcp__srv__a_b");
    assert.match(names[1], /^mcp__srv__a_b_[0-9a-f]{8}$/);
    assert.equal(new Set(names).size, 2, "collision resolved, not dropped");
    assert.equal(first.tools[1].displayName, "srv/a_b");
    assert.equal(first.tools[1].tool, "a_b", "wire name stays raw");
    assert.equal(await first.tools[1].execute({}), "underscore");
  } finally {
    await first.client.close();
    await second.client.close();
  }
});

test("tool names longer than 64 characters get a stable hash suffix", async () => {
  const server = "s".repeat(40);
  const tool = "t".repeat(40);
  const name = createMcpToolName(server, tool);
  assert.equal(name.length, MCP_TOOL_NAME_MAX_LENGTH);
  assert.match(name, /_mcp__|_[0-9a-f]{8}$/);
  assert.match(name, /^mcp__s{40}__t+_[0-9a-f]{8}$/);
  assert.equal(createMcpToolName(server, tool), name, "same pair, same name");
  assert.notEqual(createMcpToolName(server, `${tool}x`), name, "different pair, different hash");

  // and through a real load: wire name sanitized/capped, display name intact
  const longTool: FakeToolDef = {
    name: "very/long tool name with spaces and symbols " + "z".repeat(40),
    description: "long",
    inputSchema: { type: "object" },
    run: () => "long result",
  };
  const fake = startFakeServer([longTool]);
  const mcp = await loadMcpTools(configOf({ "my server": { command: "x" } }), {
    transportFor: () => fake.client,
  });
  try {
    const entry = mcp.tools[0];
    assert.ok(entry.name.length <= MCP_TOOL_NAME_MAX_LENGTH);
    assert.ok(entry.name.startsWith("mcp__my_server__very_long_tool_name_with_spaces"));
    assert.equal(entry.displayName, `my server/${longTool.name}`);
    assert.equal(await entry.execute({}), "long result");
  } finally {
    await mcp.client.close();
  }
});

test("MCP tool results are clipped to 20 KiB with a truncation marker", async () => {
  const big = "H".repeat(100) + "M".repeat(30_000) + "T".repeat(100);
  const fake = startFakeServer([
    { name: "big", description: "big", inputSchema: { type: "object" }, run: () => big },
    {
      name: "noisy",
      description: "ansi junk",
      inputSchema: { type: "object" },
      run: () => "ok\x1b[31mred\x07",
    },
  ]);
  const mcp = await loadMcpTools(configOf({ srv: { command: "x" } }), {
    transportFor: () => fake.client,
  });
  try {
    const result = await toolOf(mcp, "srv", "big").execute({});
    assert.ok(result.length < big.length, "result was clipped");
    assert.match(result, /\.\.\.\[truncated 9720 chars\]\.\.\./);
    assert.ok(result.startsWith("H"), "head kept");
    assert.ok(result.endsWith("T"), "tail kept");
    // terminal junk never reaches the transcript
    assert.equal(await toolOf(mcp, "srv", "noisy").execute({}), "okred");
  } finally {
    await mcp.client.close();
  }
});

test("deferOutputBounds keeps full MCP text for the harness spill layer", async () => {
  const big = "H".repeat(100) + "M".repeat(30_000) + "T".repeat(100);
  const fake = startFakeServer([
    { name: "big", description: "big", inputSchema: { type: "object" }, run: () => big },
  ]);
  const mcp = await loadMcpTools(configOf({ srv: { command: "x" } }), {
    transportFor: () => fake.client,
    deferOutputBounds: true,
  });
  try {
    // The clip is deliberately skipped here: the run's harness must receive
    // the full text so its spill layer can save it and bound the preview.
    assert.equal(await toolOf(mcp, "srv", "big").execute({}), big);
  } finally {
    await mcp.client.close();
  }
});

test("config-file timeoutMs reaches the tool adapter; a hung call times out as a tool error", async () => {
  const fake = startFakeServer([
    { name: "hang", description: "never answers", inputSchema: { type: "object" }, hang: true },
  ]);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tb-mcp-timeout-"));
  try {
    const configPath = path.join(tmp, "mcp.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          slow: { command: process.execPath, args: ["unused"], timeoutMs: 25 },
        },
      }),
      "utf-8",
    );
    // config parsing: the per-server timeoutMs survives the file read
    const specs = loadMcpToolSpecs(configPath);
    assert.equal(specs.slow.timeoutMs, 25);

    // adapter behavior through the same --mcp-config path the CLI uses
    const mcp = await loadMcpTools(configPath, { transportFor: () => fake.client });
    try {
      assert.deepEqual(mcp.errors, []);
      const started = Date.now();
      const result = await toolOf(mcp, "slow", "hang").execute({});
      const elapsed = Date.now() - started;
      assert.equal(result, "MCP tool error: timed out after 25 ms calling 'slow/hang'");
      assert.ok(elapsed >= 15, `timeout waited (${elapsed} ms)`);
      assert.ok(elapsed < 5_000, `timeout fired promptly (${elapsed} ms)`);
    } finally {
      await mcp.client.close();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// bounded initialization: initialize answered, notifications/initialized
// never settles (pi-mcp awaits that notification POST without a timeout)
// ---------------------------------------------------------------------------

/** A deferred the test controls by hand — the wedged notification send. */
interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface HangyTransport {
  transport: McpTransport;
  /** The never-settled `notifications/initialized` send; tests settle it late. */
  notification: Deferred<void>;
  /** Did client.connect() reach the notifications/initialized send? */
  sawInitializedNotification: boolean;
  /** Did anyone close the transport? */
  closed: boolean;
}

/**
 * Fake transport modelling a streamable-HTTP server that answers
 * `initialize` then hangs the `notifications/initialized` POST forever (no
 * request timeout covers that notification). `closeHang` makes the
 * transport close wedge too, for the bounded-cleanup assertion.
 */
function hangingInitTransport(closeHang = false): HangyTransport {
  const notification = deferred<void>();
  const state: HangyTransport = {
    notification,
    sawInitializedNotification: false,
    closed: false,
    transport: undefined as unknown as McpTransport,
  };
  const messageListeners = new Set<McpTransportMessageListener>();
  state.transport = {
    start: async () => {},
    send: (message) => {
      const msg = message as { id?: unknown; method?: string; params?: { protocolVersion?: string } };
      if (msg.method === "initialize") {
        const id = msg.id as JsonRpcId;
        const protocolVersion = msg.params?.protocolVersion ?? "2025-11-25";
        queueMicrotask(() => {
          for (const listener of messageListeners) {
            listener({
              jsonrpc: "2.0",
              id,
              result: {
                protocolVersion,
                capabilities: { tools: {} },
                serverInfo: { name: "hangy", version: "1.0.0" },
              },
            });
          }
        });
        return Promise.resolve();
      }
      if (msg.method === "notifications/initialized") {
        state.sawInitializedNotification = true;
        return notification.promise; // never settles on its own
      }
      return Promise.reject(new Error(`unexpected message: ${String(msg.method)}`));
    },
    close: () => {
      state.closed = true;
      return closeHang ? new Promise<void>(() => undefined) : Promise.resolve();
    },
    onMessage: (listener) => {
      messageListeners.add(listener);
      return () => messageListeners.delete(listener);
    },
    onError: () => () => {},
    onClose: () => () => {},
  };
  return state;
}

/** A microtask+timer flush so a late settlement is observable, if it matters. */
const settle = async (ms = 25): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

test("connect deadline: initialize answered but the initialized notification hangs — fail soft, healthy server still loads", async () => {
  const good = startFakeServer(THREE_TOOLS);
  const hangy = hangingInitTransport();
  const started = Date.now();
  const mcp = await loadMcpTools(
    configOf({ slow: { command: "x" }, good: { command: "x" } }),
    {
      transportFor: (name) => (name === "slow" ? hangy.transport : good.client),
      connectTimeoutMs: 50,
    },
  );
  const elapsed = Date.now() - started;
  try {
    assert.ok(hangy.sawInitializedNotification, "the hang is the initialized notification, post-initialize");
    assert.equal(mcp.errors.length, 1, "exactly one errors entry — no double report");
    assert.match(mcp.errors[0], /^MCP server 'slow': initialization timed out after 50 ms/);
    assert.match(mcp.errors[0], /connect \+ tools\/list did not settle/);
    assert.ok(elapsed >= 40, `the deadline was waited out (${elapsed} ms)`);
    assert.ok(elapsed < 5_000, `released promptly after the deadline (${elapsed} ms)`);
    assert.deepEqual(mcp.client.servers, ["good"], "the wedged server did not join the client");
    assert.equal(mcp.tools.length, 3, "healthy server's tools loaded");
    assert.equal(hangy.closed, true, "the wedged server's client was closed");
  } finally {
    hangy.notification.resolve(); // let the abandoned connect unwind
    await settle();
    await mcp.client.close();
  }
});

test("connect deadline: a late settlement cannot resurrect the failed server or reject unhandled", async () => {
  const good = startFakeServer(THREE_TOOLS);
  const hangy = hangingInitTransport();
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    const mcp = await loadMcpTools(
      configOf({ slow: { command: "x" }, good: { command: "x" } }),
      {
        transportFor: (name) => (name === "slow" ? hangy.transport : good.client),
        connectTimeoutMs: 50,
      },
    );
    assert.equal(mcp.errors.length, 1, "the server already failed on the deadline");
    assert.deepEqual(mcp.client.servers, ["good"]);

    // the wedged notification settles late: connect completes (or fails)
    // after loadMcpTools moved on — it must stay inert
    hangy.notification.resolve();
    await settle();
    assert.deepEqual(mcp.client.servers, ["good"], "a late connect cannot join the client");
    assert.equal(mcp.errors.length, 1, "no second report from the late settlement");
    assert.equal(mcp.tools.length, 3, "no tools appeared from the failed server");
    await mcp.client.close();

    // and a late REJECTION is just as inert (fresh fakes: the first good
    // transport is closed with its client)
    const good2 = startFakeServer(THREE_TOOLS);
    const hangy2 = hangingInitTransport();
    const mcp2 = await loadMcpTools(configOf({ slow: { command: "x" }, good: { command: "x" } }), {
      transportFor: (name) => (name === "slow" ? hangy2.transport : good2.client),
      connectTimeoutMs: 50,
    });
    assert.equal(mcp2.errors.length, 1);
    hangy2.notification.reject(new Error("late transport failure"));
    await settle();
    assert.deepEqual(mcp2.client.servers, ["good"]);
    assert.equal(mcp2.errors.length, 1);
    await mcp2.client.close();

    assert.deepEqual(unhandled, [], "no unhandled rejection from either late settlement");
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("connect deadline: the cleanup close is bounded even when the wedged transport close hangs", async () => {
  const good = startFakeServer(THREE_TOOLS);
  const hangy = hangingInitTransport(true); // close() never settles either
  const before = activeTimeoutCount();
  const started = Date.now();
  const mcp = await loadMcpTools(
    configOf({ slow: { command: "x" }, good: { command: "x" } }),
    {
      transportFor: (name) => (name === "slow" ? hangy.transport : good.client),
      connectTimeoutMs: 50,
    },
  );
  const elapsed = Date.now() - started;
  try {
    assert.equal(mcp.errors.length, 1, "one errors entry — the wedged close adds none");
    assert.match(mcp.errors[0], /initialization timed out after 50 ms/);
    // deadline (50 ms) + cleanup grace (min(5000, 50) = 50 ms), far under
    // the production MCP_CLOSE_TIMEOUT_MS grace — the test never waits it
    assert.ok(elapsed >= 80, `deadline and cleanup grace both waited (${elapsed} ms)`);
    assert.ok(elapsed < 2_000, `load released despite the wedged close (${elapsed} ms)`);
    assert.deepEqual(mcp.client.servers, ["good"]);
    assert.equal(hangy.closed, true, "close was still attempted");
    assert.equal(activeTimeoutCount(), before, "no lingering race timers after the bounded close");
  } finally {
    hangy.notification.resolve();
    await settle();
    await mcp.client.close();
  }
});

test("connect deadline: the per-server timeoutMs setting bounds initialization when no override is given", async () => {
  const hangy = hangingInitTransport();
  const started = Date.now();
  const mcp = await loadMcpTools(configOf({ slow: { command: "x", timeoutMs: 40 } }), {
    transportFor: () => hangy.transport,
  });
  const elapsed = Date.now() - started;
  try {
    assert.equal(mcp.errors.length, 1);
    assert.match(mcp.errors[0], /^MCP server 'slow': initialization timed out after 40 ms/);
    assert.ok(elapsed >= 30 && elapsed < 5_000, `deadline came from the server entry (${elapsed} ms)`);
  } finally {
    hangy.notification.resolve();
    await settle();
    await mcp.client.close();
  }
});
