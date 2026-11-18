/**
 * MCP server status views — the opencode MCP visibility model ported for the
 * server: WHAT is configured (config file + plugin contributions, with the
 * effective role and transport of every server) and HOW the last run's MCP
 * load went (connected / failed per server, with the bounded failure detail).
 *
 * Pure, dependency-free functions over the shapes `src/mcp.ts` already
 * produces (`McpServerSpec`, `PluginMcpServer`, `McpToolSet`): the module
 * never connects to a server itself. `src/server.ts` records one
 * `McpLastRunStatus` per run whose merged MCP set was non-empty and serves
 * the pair at `GET /api/mcp`.
 *
 * Two bounds keep the view safe to render and free of secrets:
 * `MCP_TARGET_MAX_CHARS` caps the human description of a server's target
 * (stdio: `command args…`; http: the URL) — env maps and header maps never
 * appear in any field — and `MCP_STATUS_ERROR_MAX_CHARS` caps a failure
 * detail. Both mirror the tolerant-boundary house style: nothing here throws
 * on a malformed spec; a bad entry degrades to the honest "invalid" view.
 */
import {
  MCP_SERVER_ROLES,
  isValidMcpServerName,
  mcpServerSpecIssue,
  type McpServerRole,
  type McpServerSpec,
  type McpToolSet,
} from "./mcp.ts";
import type { PluginMcpServer } from "./plugins.ts";

/** Cap for a configured server's `target` string (command line or URL). */
export const MCP_TARGET_MAX_CHARS = 200;

/** Cap for a per-server failure detail in the last-run view. */
export const MCP_STATUS_ERROR_MAX_CHARS = 300;

/** One configured MCP server, exactly as the next run's merge would see it. */
export interface McpConfiguredServer {
  /** The `mcpServers` key. */
  name: string;
  /** Where the entry comes from: the `--mcp-config` file or a plugin. */
  source: "config" | "plugin";
  /** Contributing plugin's name when `source === "plugin"`, else null. */
  plugin: string | null;
  /** Effective role, computed exactly like `loadMcpTools` (`role ?? "junior"`). */
  role: McpServerRole;
  /** "stdio" (command), "http" (url) or "invalid" (neither set). */
  transport: "stdio" | "http" | "invalid";
  /** stdio: `command` + `args` joined; http: the URL; bounded; never env/headers. */
  target: string;
}

/** One server's outcome in the last run's MCP load. */
export interface McpRunServer {
  name: string;
  status: "connected" | "failed";
  /** Failure detail (bounded); present only when `status === "failed"`. */
  error?: string;
  /** Tools this server contributed to the run (0 for failed servers). */
  toolCount: number;
}

/** The recorded MCP outcome of the most recent run with servers configured. */
export interface McpLastRunStatus {
  /** ISO-8601 timestamp of when the run's MCP load finished. */
  at: string;
  /** Session name of the recording run. */
  session: string;
  /** Run id at recording time ("" when the run had none yet). */
  runId: string;
  /** One entry per server in the run's merged config, in name order. */
  servers: McpRunServer[];
}

/** Bound `text` to at most `max` chars, keeping the head and tail with the
 *  honest `...[truncated N chars]...` marker counted inside the budget. */
function boundText(text: string, max: number): string {
  if (text.length <= max) return text;
  // The dropped count depends on the marker length, which depends on the
  // dropped count's digit width — converge (one extra pass covers the
  // 99 → 100 digit-growth edge).
  let keep = 0;
  for (let i = 0; i < 3; i++) {
    const dropped = text.length - keep;
    const markerLen = `...[truncated ${dropped} chars]...`.length;
    const nextKeep = Math.max(0, max - markerLen);
    if (nextKeep === keep) break;
    keep = nextKeep;
  }
  const dropped = text.length - keep;
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return `${text.slice(0, head)}...[truncated ${dropped} chars]...${text.slice(text.length - tail)}`;
}

/**
 * The configured-server view: the union of the `--mcp-config` base and the
 * plugin contributions, sorted by name for deterministic bytes.
 *
 * The merge mirrors `mergeMcpConfig`'s first-wins rule exactly (a configured
 * entry wins a name collision, then the first valid plugin to contribute the
 * name; an invalid name or a spec `mcpServerSpecIssue` rejects is dropped),
 * so the reported set is byte-identical to the set the next run will load.
 * The effective role matches the loader (`spec.role ?? "junior"`; an
 * out-of-set role on a raw config entry degrades to "junior" here — the
 * loader would skip the server, and this view stays renderable).
 */
export function describeConfigured(
  base: Record<string, McpServerSpec> | null,
  pluginServers: readonly PluginMcpServer[] = [],
): McpConfiguredServer[] {
  const entries = new Map<string, McpConfiguredServer>();
  const baseServers =
    base !== null && typeof base === "object" ? (base as Record<string, McpServerSpec>) : {};
  for (const [name, spec] of Object.entries(baseServers)) {
    entries.set(name, configuredView(name, "config", null, spec));
  }
  for (const entry of pluginServers) {
    const name: unknown = (entry as { name?: unknown } | null | undefined)?.name;
    const config: unknown = (entry as { config?: unknown } | null | undefined)?.config;
    const rawPlugin: unknown = (entry as { plugin?: unknown } | null | undefined)?.plugin;
    const plugin =
      typeof rawPlugin === "string" && rawPlugin !== "" ? rawPlugin : "(unknown plugin)";
    if (!isValidMcpServerName(name)) continue;
    if (entries.has(name)) continue;
    if (mcpServerSpecIssue(config) !== null) continue;
    entries.set(name, configuredView(name, "plugin", plugin, config as McpServerSpec));
  }
  return [...entries.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Build one configured view entry from a raw spec (tolerant of bad shapes). */
function configuredView(
  name: string,
  source: "config" | "plugin",
  plugin: string | null,
  raw: unknown,
): McpConfiguredServer {
  const spec = (raw !== null && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const role: McpServerRole = MCP_SERVER_ROLES.includes(spec.role as McpServerRole)
    ? (spec.role as McpServerRole)
    : "junior";
  const url = typeof spec.url === "string" && spec.url.trim() !== "" ? spec.url : null;
  const command = typeof spec.command === "string" && spec.command.trim() !== "" ? spec.command : null;
  let transport: McpConfiguredServer["transport"];
  let target: string;
  if (url !== null) {
    transport = "http";
    target = url;
  } else if (command !== null) {
    transport = "stdio";
    const args = Array.isArray(spec.args)
      ? spec.args.filter((a): a is string => typeof a === "string")
      : [];
    target = [command, ...args].join(" ");
  } else {
    transport = "invalid";
    target = "";
  }
  return { name, source, plugin, role, transport, target: boundText(target, MCP_TARGET_MAX_CHARS) };
}

/**
 * Derive the last-run per-server outcomes from a loaded `McpToolSet`. A server
 * is "connected" when its name is in `toolSet.client.servers`; otherwise it is
 * "failed" with the detail parsed out of the `errors[]` entry carrying the
 * stable `MCP server '<name>':` prefix (no matching line → the generic
 * "failed to connect"). `toolCount` is the number of loaded tools whose
 * `entry.server` is this server. Entries come back sorted by name for
 * deterministic bytes.
 */
export function deriveRunStatus(
  configServerNames: readonly string[],
  toolSet: Pick<McpToolSet, "client" | "errors" | "tools">,
): McpRunServer[] {
  const connected = new Set(toolSet.client.servers);
  const out: McpRunServer[] = [];
  for (const name of configServerNames) {
    const toolCount = toolSet.tools.filter((entry) => entry.server === name).length;
    if (connected.has(name)) {
      out.push({ name, status: "connected", toolCount });
      continue;
    }
    const prefix = `MCP server '${name}': `;
    const line = toolSet.errors.find((entry) => entry.startsWith(prefix));
    const detail = line !== undefined ? line.slice(prefix.length) : "failed to connect";
    out.push({
      name,
      status: "failed",
      error: boundText(detail || "failed to connect", MCP_STATUS_ERROR_MAX_CHARS),
      toolCount,
    });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * One failed entry per configured server for the rare path where
 * `loadMcpTools` itself throws (an unreadable merged shape the per-server
 * fail-soft could not contain): the whole load is one bounded error detail
 * shared by every configured server.
 */
export function summarizeLoadFailure(
  configServerNames: readonly string[],
  exc: unknown,
): McpRunServer[] {
  const detail = exc instanceof Error ? exc.message : String(exc);
  return configServerNames
    .map((name) => ({
      name,
      status: "failed" as const,
      error: boundText(detail || "failed to load MCP tools", MCP_STATUS_ERROR_MAX_CHARS),
      toolCount: 0,
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
