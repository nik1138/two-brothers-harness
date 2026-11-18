/**
 * Pure derivations of the TUI's MCP server status, shared by the footer chip,
 * the status side panel and the app. Everything here is terminal-free and
 * unit-testable without booting the app: the inputs are the documented result
 * contract of `loadMcpTools` (`McpToolSet.client.servers` = connected server
 * names, `McpToolSet.errors` = per-server failure strings with the stable
 * prefix `MCP server '<name>': <error>`, `McpToolSet.tools` entries carrying
 * `.server`/`.tool`).
 */

/** Status of one configured MCP server after a load. */
export interface McpServerStatus {
  name: string;
  status: "connected" | "failed";
  /** Bounded failure detail for a failed server (the part after the prefix). */
  error?: string;
  /** Number of tools this server contributed to the loaded tool set. */
  toolCount: number;
}

/** The app's captured MCP status: one row per configured server. */
export interface McpStatusSnapshot {
  servers: McpServerStatus[];
  /** ISO timestamp of the capture (right after the load). */
  at: string;
}

/** The minimal `McpToolSet` shape the derivation reads (kept structural). */
export interface McpToolSetLike {
  tools: readonly { server: string }[];
  client: { servers: readonly string[] };
  errors: readonly string[];
}

/** Stable per-server failure prefix produced by `loadMcpTools`. */
export const MCP_ERROR_PREFIX = "MCP server '";

/** Parse one `McpToolSet.errors` line into server name and detail. */
export function parseMcpErrorLine(
  line: string,
): { name: string; error: string } | null {
  const text = line.trim();
  if (!text.startsWith(MCP_ERROR_PREFIX)) return null;
  const rest = text.slice(MCP_ERROR_PREFIX.length);
  const quote = rest.indexOf("'");
  if (quote <= 0) return null;
  return {
    name: rest.slice(0, quote),
    // Everything after `': `; a line with no detail still parses (empty error).
    error: rest.slice(quote + 1).replace(/^:\s*/, ""),
  };
}

/**
 * Derive the per-server status from a loaded tool set. Connected servers lead
 * (in the client's own order), failed servers follow (in `errors` order); a
 * server named by both counts once, as failed (a server that connected but
 * failed mid-load still reports its error). Returns `null` for a `null` tool
 * set (no MCP configured at all), so callers keep "not configured" distinct
 * from "zero servers".
 */
export function mcpStatusFromToolSet(
  toolSet: McpToolSetLike | null,
  at: string = new Date().toISOString(),
): McpStatusSnapshot | null {
  if (toolSet === null) return null;
  const counts = new Map<string, number>();
  for (const tool of toolSet.tools) {
    counts.set(tool.server, (counts.get(tool.server) ?? 0) + 1);
  }
  const failed = new Map<string, string>();
  for (const line of toolSet.errors) {
    const parsed = parseMcpErrorLine(line);
    if (parsed !== null) failed.set(parsed.name, parsed.error);
  }
  const servers: McpServerStatus[] = [];
  const seen = new Set<string>();
  for (const name of toolSet.client.servers) {
    if (seen.has(name)) continue;
    seen.add(name);
    servers.push({
      name,
      status: failed.has(name) ? "failed" : "connected",
      ...(failed.has(name) ? { error: failed.get(name) } : {}),
      toolCount: counts.get(name) ?? 0,
    });
  }
  for (const [name, error] of failed) {
    if (seen.has(name)) continue;
    seen.add(name);
    servers.push({ name, status: "failed", error, toolCount: counts.get(name) ?? 0 });
  }
  return { servers, at };
}

/**
 * The compact footer chip. `{total} MCP` when every server connected, dim
 * `{failed} MCP failed` when any failed, and `null` when no server is
 * configured — the chip is omitted entirely in that case.
 */
export function mcpStatusChip(snapshot: McpStatusSnapshot | null): {
  text: string;
  failed: boolean;
} | null {
  if (snapshot === null || snapshot.servers.length === 0) return null;
  const failed = snapshot.servers.filter((server) => server.status === "failed").length;
  if (failed === 0) return { text: `${snapshot.servers.length} MCP`, failed: false };
  return { text: `${failed} MCP failed`, failed: true };
}

/**
 * One bounded line per server for the side panel: `name connected (n tools)`
 * or `name failed — <error>`. The caller truncates to the box width.
 */
export function mcpServerLine(server: McpServerStatus): string {
  if (server.status === "failed") {
    const detail = (server.error ?? "").trim();
    return `${server.name} failed${detail === "" ? "" : ` — ${detail}`}`;
  }
  const tools = server.toolCount === 1 ? "1 tool" : `${server.toolCount} tools`;
  return `${server.name} connected (${tools})`;
}
