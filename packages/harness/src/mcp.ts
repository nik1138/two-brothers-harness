/**
 * MCP tool loading with role-scoped server assignment — the original
 * prototype's MCP module analogue, built on `@earendil-works/pi-mcp` (the research verdict in
 * research/harnesses/pi-durable-mcp-chord.md: 3.3k LOC MIT client, stdio +
 * streamable-HTTP transports, in-memory transport pair for tests, correct
 * client lifetime).
 *
 * When `--mcp-config` points to a JSON file, the brothers get the tools of
 * those MCP servers while executing a `delegation` — delegation becomes
 * executable instead of purely textual. The config file format is the
 * Claude-Desktop style (`mcpServers` object):
 *
 *     {
 *       "mcpServers": {
 *         "filesystem": {
 *           "command": "npx",
 *           "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
 *           "timeoutMs": 60000
 *         },
 *         "remote": {
 *           "url": "https://example.com/mcp",
 *           "headers": {"Authorization": "Bearer ..."}
 *         }
 *       }
 *     }
 *
 * Python's `mcp.py` is junior-only (the junior gets every loaded tool). The
 * TS port generalizes per the BACKLOG "Role-scoped tool context"
 * requirement: each entry takes an optional `"role"` field —
 * `"shared" | "senior" | "junior"`, default `"junior"` so plain configs
 * behave exactly like Python's.
 *
 * Plugins can contribute servers of their own (`PluginContext.add_mcp_server`
 * or an exported `mcpServers` object, `src/plugins.ts`; research note R6 in
 * research/harnesses/plugins-pi.md). `mergeMcpConfig` folds those
 * declarations under the configured shape before loading — a configured entry
 * wins a name collision, then the first plugin to contribute the name, and
 * every rejection/collision is a diagnostic. The merge only assembles the
 * same `{mcpServers}` shape this module already accepts, so tool namespacing,
 * the result clip and role routing below are unaffected.
 *
 * Model-facing tool names are namespaced per pi's coding-agent convention
 * (`packages/coding-agent/src/extensions/mcp/tools.ts`):
 * `mcp__<server>__<tool>`, everything but `[A-Za-z0-9_]` replaced by `_`,
 * capped at 64 characters, and a stable `_<sha256 prefix>` suffix when the
 * sanitized name is too long or already taken (two tools sanitizing to the
 * same name). The raw server/tool pair stays available in
 * `McpToolSet.displayNames` (and on each `McpToolEntry`) so transcripts,
 * runtime events and artifacts can render `server/tool` instead of the
 * wire name. This is a deliberate TS-first divergence: Python's `mcp.py`
 * exposes raw MCP tool names and has no namespacing, result cap or per-call
 * timeout — MCP is a TS-port surface, so Python parity is not required.
 *
 * Model-facing text of one result is capped at 20 KiB (`MCP_OUTPUT_MAX_CHARS`,
 * pi's `MCP_OUTPUT_MAX_BYTES`): `output.ts` keeps the head and tail with the
 * shell runner's `...[truncated N chars]...` marker. Each tool call gets a
 * per-call `timeoutMs` (default 60 s, overridable per server entry) so a
 * hung server cannot stall the run; a timeout comes back as an
 * `MCP tool error: timed out after …` tool result, never a crash. A caller
 * abort still rejects the call (the harness turns that into a tool error).
 *
 * `loadMcpTools` returns `(tools, client, errors)` as an object —
 * keep `client` referenced for as long as the tools may be used, because it
 * holds the open stdio/HTTP connections; `client.close()` is idempotent.
 * A server that fails to start is recorded in `errors` and skipped; the
 * run continues with the remaining servers (fail-soft, as in Python).
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";

import {
  McpClient,
  McpTimeoutError,
  StdioTransport,
  StreamableHttpTransport,
  toLlmContent,
  type CallToolResult,
  type McpTransport,
  type Tool as McpTool,
} from "@earendil-works/pi-mcp";

import { boundOutput, sanitizeOutput } from "./output.ts";
import type { PluginMcpServer } from "./plugins.ts";
import type { Tool } from "./provider.ts";

/** Which brother belt an MCP server's tools join (default "junior"). */
export type McpServerRole = "shared" | "senior" | "junior";

export const MCP_SERVER_ROLES: readonly McpServerRole[] = ["shared", "senior", "junior"];

/** Cap for model-facing MCP tool names (the provider limit pi targets). */
export const MCP_TOOL_NAME_MAX_LENGTH = 64;

/** Model-facing text of one MCP result beyond this is cut in the middle
 *  (20 KiB, pi's `MCP_OUTPUT_MAX_BYTES`). Measured in characters, matching
 *  `output.ts`'s bounded-window convention. */
export const MCP_OUTPUT_MAX_CHARS = 20 * 1024;

/** Per-tool-call timeout when a server entry does not set `timeoutMs`. */
export const MCP_DEFAULT_TIMEOUT_MS = 60_000;

/** One `mcpServers` entry: a stdio command spec or a streamable-HTTP spec. */
export interface McpServerSpec {
  /** stdio transport: executable to spawn. */
  command?: string;
  args?: string[];
  cwd?: string;
  /** Environment for the spawned server; `${VAR}` references expand from
   *  `process.env` (the pi coding-agent config shape — python passes `env`
   *  verbatim, so this is a deliberate TS extension). */
  env?: Record<string, string>;
  /** streamable-HTTP transport: server endpoint. */
  url?: string;
  headers?: Record<string, string>;
  /** Role scope for the server's tools (default "junior", matching Python). */
  role?: McpServerRole;
  /** Per-tool-call timeout in milliseconds (default 60 s). Must be a
   *  positive finite number; an invalid value skips the server with an
   *  error entry, like an invalid role. */
  timeoutMs?: number;
}

/** The top-level shape of an `--mcp-config` JSON file. */
export interface McpServersConfig {
  mcpServers: Record<string, McpServerSpec>;
}

/** The `--mcp-config` file shape (an alias kept for the merge signature). */
export type McpConfigFileShape = McpServersConfig;

/** Characters allowed in an MCP server name (`mcpServers` key). */
const MCP_SERVER_NAME_RE = /^[a-z0-9_-]+$/;

/**
 * True for a usable `mcpServers` key / `PluginContext.add_mcp_server` name:
 * a non-empty `[a-z0-9_-]+` string (the same class plugin file names use).
 */
export function isValidMcpServerName(name: unknown): name is string {
  return typeof name === "string" && MCP_SERVER_NAME_RE.test(name);
}

/**
 * Minimal shape check for one `mcpServers` entry (or a plugin-contributed
 * declaration). Returns a diagnostic string, or `null` when the entry is
 * something `loadMcpTools` can attempt.
 *
 * Only the fields that decide whether a transport can even be built are
 * checked — a non-empty `command` (stdio) or `url` (streamable HTTP), the
 * optional `role`, and a positive `timeoutMs`. Other keys (including a
 * `transport`/`type` discriminator some configs carry) pass through
 * untouched; anything else is `loadMcpTools`' per-server fail-soft business.
 */
export function mcpServerSpecIssue(config: unknown): string | null {
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    return "entry must be an object";
  }
  const spec = config as Record<string, unknown>;
  const command = spec.command;
  const url = spec.url;
  if (command !== undefined && typeof command !== "string") {
    return "'command' must be a string";
  }
  if (url !== undefined && typeof url !== "string") {
    return "'url' must be a string";
  }
  const hasCommand = typeof command === "string" && command.trim() !== "";
  const hasUrl = typeof url === "string" && url.trim() !== "";
  if (!hasCommand && !hasUrl) {
    return "entry needs a non-empty 'command' (stdio) or 'url' (http)";
  }
  const role = spec.role;
  if (role !== undefined && !MCP_SERVER_ROLES.includes(role as McpServerRole)) {
    return `invalid role ${JSON.stringify(role)} (use shared|senior|junior)`;
  }
  const timeoutMs = spec.timeoutMs;
  if (
    timeoutMs !== undefined &&
    (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0)
  ) {
    return "invalid timeoutMs (must be a positive number of milliseconds)";
  }
  return null;
}

/** The merged config plus the notes generated while merging. */
export interface McpConfigMergeResult {
  /** `{mcpServers: {...}}` — ready for `loadMcpTools` (or a config file). */
  config: McpConfigFileShape;
  /** Collisions and rejected declarations, one line each; never thrown. */
  diagnostics: string[];
}

/**
 * Merge plugin-contributed server declarations under a base `--mcp-config`
 * shape (research/harnesses/plugins-pi.md R6: names registered by a plugin
 * lose to the configured entry).
 *
 * Precedence, first match wins, all recorded in `diagnostics`:
 * 1. a base `mcpServers` entry with the same name (config wins);
 * 2. the first plugin to contribute a name (`pluginServers` order — first
 *    wins);
 * 3. a declaration whose name/config `mcpServerSpecIssue` rejects.
 *
 * The base object is never mutated: the result owns a fresh `mcpServers`
 * map, and contributed specs are shallow-copied. `loadMcpTools` accepts the
 * result directly (`{mcpServers}`), so the merge changes nothing downstream
 * — namespacing (`mcp__<server>__<tool>`), the 20 KiB result clip and
 * per-server role routing are untouched.
 */
export function mergeMcpConfig(
  base: McpConfigFileShape | null,
  pluginServers: readonly PluginMcpServer[] = [],
): McpConfigMergeResult {
  const diagnostics: string[] = [];
  const merged: Record<string, McpServerSpec> = {};
  const baseServers = base === null || base === undefined ? undefined : base.mcpServers;
  if (baseServers !== undefined && baseServers !== null) {
    if (typeof baseServers !== "object" || Array.isArray(baseServers)) {
      diagnostics.push("MCP config: 'mcpServers' must be an object; using an empty base");
    } else {
      for (const [name, spec] of Object.entries(baseServers)) merged[name] = spec;
    }
  }
  const configured = new Set(Object.keys(merged));
  const contributor = new Map<string, string>();
  for (const entry of pluginServers) {
    const name: unknown = (entry as { name?: unknown } | null | undefined)?.name;
    const config: unknown = (entry as { config?: unknown } | null | undefined)?.config;
    const rawPlugin: unknown = (entry as { plugin?: unknown } | null | undefined)?.plugin;
    const plugin =
      typeof rawPlugin === "string" && rawPlugin !== "" ? rawPlugin : "(unknown plugin)";
    if (!isValidMcpServerName(name)) {
      diagnostics.push(
        `MCP server ${JSON.stringify(name)} from plugin ${JSON.stringify(plugin)} ignored: ` +
          `name must match ${MCP_SERVER_NAME_RE.source}`,
      );
      continue;
    }
    const issue = mcpServerSpecIssue(config);
    if (issue !== null) {
      diagnostics.push(
        `MCP server ${JSON.stringify(name)} from plugin ${JSON.stringify(plugin)} ignored: ${issue}`,
      );
      continue;
    }
    if (configured.has(name)) {
      diagnostics.push(
        `MCP server ${JSON.stringify(name)} from plugin ${JSON.stringify(plugin)} ignored: ` +
          "already configured (config wins)",
      );
      continue;
    }
    const first = contributor.get(name);
    if (first !== undefined) {
      diagnostics.push(
        `MCP server ${JSON.stringify(name)} from plugin ${JSON.stringify(plugin)} ignored: ` +
          `already contributed by plugin ${JSON.stringify(first)} (first wins)`,
      );
      continue;
    }
    contributor.set(name, plugin);
    merged[name] = { ...(config as Record<string, unknown>) } as McpServerSpec;
  }
  return { config: { mcpServers: merged }, diagnostics };
}

/**
 * Owns the connected MCP clients for one `loadMcpTools` call. The caller
 * keeps this alive for the whole run and closes it on return — the analogue
 * of holding the Python `MultiServerMCPClient` reference.
 */
export interface McpToolClient {
  /** Names of the servers that connected successfully. */
  readonly servers: string[];
  /** Idempotent: closes every owned client/transport; safe to call twice. */
  close(): Promise<void>;
}

/** Optional hooks for `loadMcpTools` (tests inject in-memory transports). */
export interface McpLoadOptions {
  /** Build the transport for a server (defaults to stdio / streamable-HTTP
   *  from the spec). Hermetic tests return pi-mcp's `InMemoryTransport`. */
  transportFor?(serverName: string, spec: McpServerSpec): McpTransport;
}

/**
 * One loaded MCP tool: the harness `Tool` plus the raw server/tool pair and
 * a readable `server/tool` display name for transcripts and artifacts.
 */
export interface McpToolEntry extends Tool {
  /** `server/tool`, the human-facing name when the wire name is namespaced. */
  readonly displayName: string;
  readonly server: string;
  readonly tool: string;
}

/** The `(tools, client, errors)` triple, with the tools split per role scope. */
export interface McpToolSet {
  /** Every loaded tool, all servers. */
  tools: McpToolEntry[];
  sharedTools: McpToolEntry[];
  seniorTools: McpToolEntry[];
  juniorTools: McpToolEntry[];
  /** Namespaced tool name -> readable `server/tool` name. */
  displayNames: Record<string, string>;
  client: McpToolClient;
  /** Per-server failures (`MCP server 'x': ...`); the run continues without them. */
  errors: string[];
}

// informational only — the MCP server does not gate on it
const MCP_CLIENT_NAME = "two-brothers-harness";
const MCP_CLIENT_VERSION = "0.3.0";

/**
 * Namespaced model-facing name for one MCP tool: `mcp__<server>__<tool>`,
 * sanitized to `[A-Za-z0-9_]`, at most 64 characters. When sanitizing makes
 * the name too long or collides with a name `isTaken` reports (another tool
 * in the same listing), the name is truncated and given a stable
 * `_<8 hex>` sha256 suffix derived only from the raw server/tool pair — so
 * the same tool always gets the same name. Ported from pi's coding-agent
 * MCP adapter (`createMcpToolName`).
 */
export function createMcpToolName(
  server: string,
  tool: string,
  isTaken: (name: string) => boolean = () => false,
): string {
  const name = `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_]/g, "_");
  if (name.length <= MCP_TOOL_NAME_MAX_LENGTH && !isTaken(name)) return name;
  const hash = createHash("sha256").update(`${server}\0${tool}`).digest("hex").slice(0, 8);
  return `${name.slice(0, MCP_TOOL_NAME_MAX_LENGTH - hash.length - 1)}_${hash}`;
}

/** `server/tool` — the readable name kept alongside the namespaced one. */
export function mcpToolDisplayName(server: string, tool: string): string {
  return `${server}/${tool}`;
}

/**
 * Read the MCP config file and return the `mcpServers` mapping. Raises on a
 * missing file or non-object `mcpServers` (mirrors python's
 * `load_mcp_tool_specs`); the CLI turns that into a `[warn]` and continues.
 */
export function loadMcpToolSpecs(configPath: string): Record<string, McpServerSpec> {
  if (!fs.existsSync(configPath)) {
    throw new Error(`MCP config not found: ${configPath}`);
  }
  const data: unknown = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  const servers =
    data && typeof data === "object"
      ? (data as Record<string, unknown>).mcpServers
      : undefined;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
    throw new Error(`MCP config ${configPath}: 'mcpServers' must be an object`);
  }
  return servers as Record<string, McpServerSpec>;
}

/** `${VAR}` expansion for env/header values (undefined vars expand to ""). */
function expandEnvVars(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) =>
    process.env[name] ?? "",
  );
}

function expandMapping(mapping: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!mapping) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(mapping)) out[key] = expandEnvVars(value);
  return out;
}

/** The default transport for a spec: stdio command or streamable-HTTP URL.
 *  Receives the spec after `${VAR}` expansion (see loadMcpTools). */
function defaultTransport(serverName: string, spec: McpServerSpec): McpTransport {
  if (spec.url) {
    return new StreamableHttpTransport({
      url: spec.url,
      headers: spec.headers,
    });
  }
  if (spec.command) {
    return new StdioTransport({
      command: spec.command,
      args: spec.args ?? [],
      cwd: spec.cwd,
      env: spec.env,
      inheritEnv: true,
      stderr: "pipe",
    });
  }
  throw new Error(`MCP server '${serverName}': entry needs 'command' or 'url'`);
}

/** True for pi-mcp's request timeout (name check covers a duplicated copy). */
function isTimeoutError(exc: unknown): boolean {
  return exc instanceof McpTimeoutError || (exc instanceof Error && exc.name === "McpTimeoutError");
}

/** Render a CallToolResult as the tool-result string our Tool interface returns. */
function callToolResultToString(result: CallToolResult): string {
  const blocks = toLlmContent(result);
  const parts = blocks.map((block) =>
    "text" in block && typeof block.text === "string"
      ? block.text
      : `[${block.type} content]`,
  );
  const text = boundOutput(sanitizeOutput(parts.join("\n").trim()), MCP_OUTPUT_MAX_CHARS).text;
  if (result.isError) return `MCP tool error: ${text || "unknown error"}`;
  return text || "(empty result)";
}

/** Convert one MCP tool listing into our `Tool` (execution via `client.callTool`). */
function mcpToolToTool(
  serverName: string,
  tool: McpTool,
  client: McpClient,
  timeoutMs: number,
  isTaken: (name: string) => boolean,
): McpToolEntry {
  const displayName = mcpToolDisplayName(serverName, tool.name);
  return {
    name: createMcpToolName(serverName, tool.name, isTaken),
    displayName,
    server: serverName,
    tool: tool.name,
    description:
      tool.description ?? `MCP tool '${tool.name}'`,
    parameters: (tool.inputSchema ?? { type: "object", properties: {} }) as Record<
      string,
      unknown
    >,
    execute: async (args: Record<string, unknown>, signal?: AbortSignal): Promise<string> => {
      try {
        return callToolResultToString(
          await client.callTool(tool.name, args ?? {}, { signal, timeoutMs }),
        );
      } catch (exc) {
        // a hung tool call is a tool error for the model, not a crashed run;
        // caller aborts keep rejecting (the harness turns them into errors)
        if (isTimeoutError(exc)) {
          return `MCP tool error: timed out after ${timeoutMs} ms calling '${displayName}'`;
        }
        throw exc;
      }
    },
  };
}

class McpToolClientHandle implements McpToolClient {
  readonly servers: string[] = [];
  private readonly clients: McpClient[] = [];
  private closing: Promise<void> | null = null;

  add(serverName: string, client: McpClient): void {
    this.servers.push(serverName);
    this.clients.push(client);
  }

  close(): Promise<void> {
    // idempotent, like pi-mcp's own close: a second call is a no-op
    this.closing ??= (async () => {
      await Promise.all(
        this.clients.map((client) => client.close().catch(() => undefined)),
      );
    })();
    return this.closing;
  }
}

/**
 * Connect to the configured MCP servers and load all their tools, split by
 * role scope. Per-server failures are collected in `errors` and skipped —
 * a bad server must not kill the run (python: "the junior continues
 * text-only").
 */
export async function loadMcpTools(
  config: string | McpServersConfig,
  options: McpLoadOptions = {},
): Promise<McpToolSet> {
  const servers =
    typeof config === "string" ? loadMcpToolSpecs(config) : config.mcpServers;

  const tools: McpToolEntry[] = [];
  const byRole: Record<McpServerRole, McpToolEntry[]> = { shared: [], senior: [], junior: [] };
  const displayNames: Record<string, string> = {};
  const usedNames = new Set<string>();
  const errors: string[] = [];
  const handle = new McpToolClientHandle();

  for (const [name, spec] of Object.entries(servers)) {
    if (!spec || typeof spec !== "object") {
      errors.push(`MCP server '${name}': entry must be an object`);
      continue;
    }
    const role: McpServerRole = spec.role ?? "junior";
    if (!MCP_SERVER_ROLES.includes(role)) {
      errors.push(
        `MCP server '${name}': invalid role '${String(role)}' (use shared|senior|junior)`,
      );
      continue;
    }
    if (!spec.url && !spec.command) {
      errors.push(`MCP server '${name}': entry needs 'command' or 'url'`);
      continue;
    }
    const timeoutMs = spec.timeoutMs ?? MCP_DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      errors.push(
        `MCP server '${name}': invalid timeoutMs '${String(spec.timeoutMs)}' (must be a positive number)`,
      );
      continue;
    }
    const client = new McpClient({ name: MCP_CLIENT_NAME, version: MCP_CLIENT_VERSION });
    try {
      // effective spec: ${VAR} references in env/headers expand from
      // process.env before the transport sees them
      const effective: McpServerSpec = {
        ...spec,
        env: expandMapping(spec.env),
        headers: expandMapping(spec.headers),
      };
      const transport = options.transportFor
        ? options.transportFor(name, effective)
        : defaultTransport(name, effective);
      await client.connect(transport);
      const listed = await client.listTools();
      const converted = listed.map((tool) => {
        const entry = mcpToolToTool(name, tool, client, timeoutMs, (candidate) =>
          usedNames.has(candidate),
        );
        usedNames.add(entry.name);
        displayNames[entry.name] = entry.displayName;
        return entry;
      });
      handle.add(name, client);
      tools.push(...converted);
      byRole[role].push(...converted);
    } catch (exc) {
      // a bad server must not kill the run: record, close the partial
      // connection, and continue with the remaining servers
      errors.push(`MCP server '${name}': ${exc instanceof Error ? exc.message : String(exc)}`);
      await client.close().catch(() => undefined);
    }
  }

  return {
    tools,
    sharedTools: byRole.shared,
    seniorTools: byRole.senior,
    juniorTools: byRole.junior,
    displayNames,
    client: handle,
    errors,
  };
}