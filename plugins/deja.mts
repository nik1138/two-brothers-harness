/**
 * deja-vu memory recall (example MCP plugin).
 *
 * Contributes the local `deja` binary's stdio MCP server so both brothers
 * can search this machine's cross-agent session memory (the `deja` tool's
 * recall / context / blame / fix / how / remember / handoff modes). The
 * plugin registers no tools of its own — the contributed server declaration
 * is the whole plugin; see "Contributed MCP servers" in docs/plugins.md.
 *
 * Requires `deja` on PATH (https://github.com/vshulcz/deja-vu). The server
 * connects per run, so first use may pay the deja startup cost once.
 */

import type { PluginContext } from "@two-brothers/harness";

export function register(ctx: PluginContext): void {
  ctx.set_description("Cross-agent memory recall via the local deja binary");

  ctx.add_mcp_server("deja", {
    command: "deja",
    args: ["mcp"],
    role: "shared",
    timeoutMs: 30_000,
  });
}
