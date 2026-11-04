#!/usr/bin/env node
/**
 * Tiny stdio MCP demo server for the harness tests — no dependencies,
 * newline-delimited JSON-RPC over stdin/stdout. Exposes three tools:
 *
 *   demo_add(a, b)  -> sum of two numbers
 *   demo_echo(text) -> echoes the text back
 *   demo_env(name)  -> value of the process env var `name` (proves env pass-through)
 *
 * Used by tests/mcp.test.ts to prove the stdio transport path end-to-end.
 */
import * as readline from "node:readline";

const TOOLS = [
  {
    name: "demo_add",
    description: "Add two numbers.",
    inputSchema: {
      type: "object",
      properties: {
        a: { type: "number" },
        b: { type: "number" },
      },
      required: ["a", "b"],
    },
  },
  {
    name: "demo_echo",
    description: "Echo text back.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
  {
    name: "demo_env",
    description: "Read a process environment variable.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  },
];

function textResult(text) {
  return { content: [{ type: "text", text: String(text) }] };
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method === "initialize") {
    process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: msg.params?.protocolVersion ?? "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "two-brothers-demo", version: "1.0.0" },
        },
      }) + "\n",
    );
  } else if (msg.method === "notifications/initialized") {
    // no reply for notifications
  } else if (msg.method === "tools/list") {
    process.stdout.write(
      JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS } }) + "\n",
    );
  } else if (msg.method === "tools/call") {
    const args = msg.params?.arguments ?? {};
    let result;
    if (msg.params?.name === "demo_add") {
      result = textResult(Number(args.a) + Number(args.b));
    } else if (msg.params?.name === "demo_echo") {
      result = textResult(args.text);
    } else if (msg.params?.name === "demo_env") {
      result = textResult(process.env[String(args.name)] ?? "");
    } else {
      result = { ...textResult(`unknown tool: ${msg.params?.name}`), isError: true };
    }
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n");
  } else if (msg.id !== undefined && msg.id !== null) {
    process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32601, message: `method not found: ${msg.method}` },
      }) + "\n",
    );
  }
});
