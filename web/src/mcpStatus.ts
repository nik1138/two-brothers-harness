/**
 * Pure view model for the MCP surfaces (Settings → MCP, `/status` MCP block).
 * The components stay thin; everything testable — badges, row shapes, empty
 * state, error bounding, failed-count emphasis — lives here. Date-dependent
 * wording takes an injectable `now` so tests stay deterministic.
 */
import type { McpConfiguredServer, McpLastRun, McpStatus, McpTransport } from './types'
import { formatDateTime, relativeTime } from './chat'

/** Settings empty state: no config file entries and no plugin-declared servers. */
export const MCP_EMPTY_MESSAGE =
  'No MCP servers configured — point `--mcp-config` (or `TWO_BROTHERS_MCP_CONFIG`) ' +
  'at a config file, or enable a plugin that declares MCP servers.'

/** Hard cap on a failure detail rendered in the status block. */
export const MCP_ERROR_MAX = 160

/** Bound an error string for inline display (single line, ellipsis). */
export function boundMcpError(error: string, max = MCP_ERROR_MAX): string {
  const collapsed = error.replace(/\s+/g, ' ').trim()
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed
}

/**
 * Source badge shown on a configured-server row: `config` for config-file
 * entries, the declaring plugin's name for plugin-sourced ones.
 */
export function mcpSourceBadge(server: McpConfiguredServer): string {
  return server.source === 'plugin' && server.plugin ? server.plugin : 'config'
}

/** Transport label: stdio/invalid stay lowercase, http renders as HTTP. */
export function mcpTransportLabel(transport: McpTransport): string {
  return transport === 'http' ? 'HTTP' : transport
}

/** Settings list row for one configured server. */
export interface McpSectionRow {
  name: string
  badge: string
  transport: string
  role: string
  target: string
  /** A server whose transport could not be determined stands out. */
  invalid: boolean
}

export function mcpSectionRows(servers: McpConfiguredServer[]): McpSectionRow[] {
  return servers.map((server) => ({
    name: server.name,
    badge: mcpSourceBadge(server),
    transport: mcpTransportLabel(server.transport),
    role: server.role,
    target: server.target,
    invalid: server.transport === 'invalid',
  }))
}

/**
 * The `/status` dialog shows the MCP block only when a run actually
 * initialized servers; "nothing configured yet" is carried by the Settings
 * section instead.
 */
export function mcpBlockVisible(status: McpStatus | null | undefined): boolean {
  return status !== null && status !== undefined && status.lastRun !== null
}

/** One server row in the `/status` MCP block. */
export interface McpBlockRow {
  name: string
  ok: boolean
  /** `N tools` for connected servers; the bounded error otherwise. */
  detail: string
}

/** Render-ready `/status` MCP block. */
export interface McpBlockView {
  title: string
  /** Relative stamp for the header line. */
  timeText: string
  /** Absolute stamp for the header tooltip. */
  timeTitle: string
  rows: McpBlockRow[]
  /** Failure emphasis: > 0 paints the block header count red. */
  failedCount: number
}

export function mcpStatusBlock(lastRun: McpLastRun, now: number = Date.now()): McpBlockView {
  const rows: McpBlockRow[] = []
  let failedCount = 0
  for (const server of lastRun.servers) {
    if (server.status === 'connected') {
      rows.push({
        name: server.name,
        ok: true,
        detail: `${server.toolCount} tool${server.toolCount === 1 ? '' : 's'}`,
      })
    } else {
      failedCount += 1
      rows.push({
        name: server.name,
        ok: false,
        detail: boundMcpError(server.error ?? 'failed'),
      })
    }
  }
  const atMs = Date.parse(lastRun.at)
  const valid = !Number.isNaN(atMs)
  return {
    title: 'MCP — last run',
    timeText: valid ? relativeTime(atMs / 1000, now) : '',
    timeTitle: valid ? formatDateTime(lastRun.at) : '',
    rows,
    failedCount,
  }
}
