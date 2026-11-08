/**
 * MCP loading + role-scoped tool registry tests. Mirrors the intent of the
 * original prototype's MCP tests (removed 2026-11-04; see git history), but
 * hermetic: a fake MCP server speaks
 * JSON-RPC over pi-mcp's in-memory transport pair, so no child process or
 * network is needed. One test at the bottom exercises the real stdio
 * transport against tests/fixtures/mcp-demo-server.mjs and skips when
 * spawning is unavailable.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { createInMemoryTransportPair, type InMemoryTransport } from "@earendil-works/pi-mcp/testing";

import { resolveConfig } from "../src/config.ts";
import { TwoBrothersHarness } from "../src/harness.ts";
import {
  createMcpToolName,
  loadMcpTools,
  loadMcpToolSpecs,
  MCP_DEFAULT_TIMEOUT_MS,
  MCP_OUTPUT_MAX_CHARS,
  MCP_TOOL_NAME_MAX_LENGTH,
  type McpServerSpec,
  type McpToolEntry,
  type McpToolSet,
} from "../src/mcp.ts";
import { MockProvider, type MockScriptStep, type Tool } from "../src/provider.ts";
import { main, type CliIO } from "../src/cli.ts";

// ---------------------------------------------------------------------------
// fake MCP server over the in-memory transport pair
// ---------------------------------------------------------------------------

interface FakeToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run?: (args: Record<string, unknown>) => string;
  /** Never answer `tools/call` — exercises the per-call timeout. */
  hang?: boolean;
}

interface FakeServer {
  /** Client-side transport: hand this to loadMcpTools' transportFor. */
  client: InMemoryTransport;
  /** tool calls the server received, in order */
  calls: Array<{ name: string; args: Record<string, unknown> }>;
  closed: boolean;
}

function startFakeServer(defs: FakeToolDef[]): FakeServer {
  const { client, server } = createInMemoryTransportPair();
  // the peer transport must be "started" before it can receive sends
  void server.start().catch(() => undefined);
  const calls: FakeServer["calls"] = [];
  const fake: FakeServer = { client, calls, closed: false };
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
      calls.push({ name: String(msg.params?.name), args: callArgs });
      const def = defs.find((d) => d.name === msg.params?.name);
      if (!def) {
        reply({ content: [{ type: "text", text: `unknown tool: ${msg.params?.name}` }], isError: true });
        return;
      }
      if (def.hang) return;
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

/** One fake server per config entry, keyed by server name. */
function transportFactory(map: Map<string, FakeServer>) {
  return (serverName: string): InMemoryTransport => {
    const fake = map.get(serverName);
    if (!fake) throw new Error(`no fake server for '${serverName}'`);
    return fake.client;
  };
}

function configOf(entries: Record<string, McpServerSpec>) {
  return { mcpServers: entries };
}

/** The adapter for a raw server/tool pair (namespaced wire name). */
function toolOf(mcp: McpToolSet, server: string, tool: string): McpToolEntry {
  const entry = mcp.tools.find((t) => t.server === server && t.tool === tool);
  assert.ok(entry, `no tool '${server}/${tool}' in [${mcp.tools.map((t) => t.name).join(", ")}]`);
  return entry;
}

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

test("per-request abort cancels an in-flight MCP tool call", async () => {
  const fake = startFakeServer(THREE_TOOLS);
  const mcp = await loadMcpTools(configOf({ fake: { command: "unused" } }), {
    transportFor: transportFactory(new Map([["fake", fake]])),
  });
  try {
    const controller = new AbortController();
    controller.abort();
    const read = toolOf(mcp, "fake", "mem_read");
    await assert.rejects(() => Promise.resolve(read.execute({}, controller.signal)));
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
    assert.equal(MCP_OUTPUT_MAX_CHARS, 20 * 1024);
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

test("a hung tool call times out as a tool error result (default 60 s, config override)", async () => {
  assert.equal(MCP_DEFAULT_TIMEOUT_MS, 60_000);
  const fake = startFakeServer([
    { name: "hang", description: "never answers", inputSchema: { type: "object" }, hang: true },
  ]);
  const mcp = await loadMcpTools(configOf({ slow: { command: "x", timeoutMs: 50 } }), {
    transportFor: () => fake.client,
  });
  try {
    const started = Date.now();
    const result = await toolOf(mcp, "slow", "hang").execute({});
    const elapsed = Date.now() - started;
    assert.equal(result, "MCP tool error: timed out after 50 ms calling 'slow/hang'");
    assert.ok(elapsed >= 40, `timeout waited (${elapsed} ms)`);
    assert.ok(elapsed < 5_000, `timeout fired promptly (${elapsed} ms)`);
  } finally {
    await mcp.client.close();
  }
});

test("config-file timeoutMs override reaches the tool adapter", async () => {
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
    const specs = loadMcpToolSpecs(configPath);
    assert.equal(specs.slow.timeoutMs, 25);
    assert.equal(loadMcpToolSpecs(configPath).slow.timeoutMs, 25, "config-file override survives");
    assert.equal(MCP_DEFAULT_TIMEOUT_MS, 60_000, "default applies when absent");
    const mcp = await loadMcpTools(configPath, { transportFor: () => fake.client });
    try {
      assert.deepEqual(mcp.errors, []);
      const result = await toolOf(mcp, "slow", "hang").execute({});
      assert.equal(result, "MCP tool error: timed out after 25 ms calling 'slow/hang'");
    } finally {
      await mcp.client.close();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
