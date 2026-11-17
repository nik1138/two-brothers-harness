/**
 * Shared in-memory fake MCP server for the MCP test suites. Speaks
 * JSON-RPC over pi-mcp's in-memory transport pair, so no child process or
 * network is needed. Supports `hang` tool defs (never answer `tools/call`)
 * and call recording (with a wait helper for genuine in-flight abort tests).
 */
import assert from "node:assert/strict";

import { createInMemoryTransportPair, type InMemoryTransport } from "@earendil-works/pi-mcp/testing";

import type { McpServerSpec, McpToolEntry, McpToolSet } from "../../src/mcp.ts";

export interface FakeToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run?: (args: Record<string, unknown>) => string;
  /** Never answer `tools/call` — exercises the per-call timeout / abort. */
  hang?: boolean;
}

export interface FakeServer {
  /** Client-side transport: hand this to loadMcpTools' transportFor. */
  client: InMemoryTransport;
  /** tool calls the server received, in order */
  calls: Array<{ name: string; args: Record<string, unknown> }>;
  closed: boolean;
  /** Resolves once at least `n` tool calls have reached the server. */
  waitForCalls(n: number): Promise<void>;
}

export function startFakeServer(defs: FakeToolDef[]): FakeServer {
  const { client, server } = createInMemoryTransportPair();
  // the peer transport must be "started" before it can receive sends
  void server.start().catch(() => undefined);
  const calls: FakeServer["calls"] = [];
  const waiters: Array<{ n: number; resolve: () => void }> = [];
  const fake: FakeServer = {
    client,
    calls,
    closed: false,
    waitForCalls: (n) =>
      new Promise((resolve) => {
        if (calls.length >= n) resolve();
        else waiters.push({ n, resolve });
      }),
  };
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
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (calls.length >= waiters[i].n) {
          waiters[i].resolve();
          waiters.splice(i, 1);
        }
      }
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

/** One fake server per config entry, keyed by server name. */
export function transportFactory(map: Map<string, FakeServer>) {
  return (serverName: string): InMemoryTransport => {
    const fake = map.get(serverName);
    if (!fake) throw new Error(`no fake server for '${serverName}'`);
    return fake.client;
  };
}

export function configOf(entries: Record<string, McpServerSpec>) {
  return { mcpServers: entries };
}

/** The adapter for a raw server/tool pair (namespaced wire name). */
export function toolOf(mcp: McpToolSet, server: string, tool: string): McpToolEntry {
  const entry = mcp.tools.find((t) => t.server === server && t.tool === tool);
  assert.ok(entry, `no tool '${server}/${tool}' in [${mcp.tools.map((t) => t.name).join(", ")}]`);
  return entry;
}

/** A single-tool def list naming the tool after its result. */
export function oneTool(name: string): FakeToolDef[] {
  return [
    {
      name,
      description: `The ${name} tool.`,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      run: () => `${name}: ok`,
    },
  ];
}
