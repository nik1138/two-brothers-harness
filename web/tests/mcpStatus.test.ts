/**
 * View-model tests for the MCP web surfaces (web/src/mcpStatus.ts): the
 * Settings section rows (badges, transport labels, empty state) and the
 * `/status` MCP block (visibility, mixed connected/failed rows, bounded
 * errors, failed-count emphasis). Pure module — no DOM, no network.
 *
 * Run with: node --import ./tests/register-ts.mjs --test tests/mcpStatus.test.ts
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  boundMcpError,
  MCP_EMPTY_MESSAGE,
  MCP_ERROR_MAX,
  mcpBlockVisible,
  mcpSectionRows,
  mcpStatusBlock,
  mcpTransportLabel,
} from '../src/mcpStatus'
import type { McpConfiguredServer, McpStatus } from '../src/types'

const NOW = Date.parse('2026-11-18T12:05:00.000Z')

function server(partial: Partial<McpConfiguredServer> = {}): McpConfiguredServer {
  return {
    name: 'deja',
    source: 'config',
    plugin: null,
    role: 'junior',
    transport: 'stdio',
    target: 'deja mcp',
    ...partial,
  }
}

function status(partial: Partial<McpStatus> = {}): McpStatus {
  return { configured: [], lastRun: null, ...partial }
}

// -- Settings section rows ----------------------------------------------------

test('empty state message points at --mcp-config / the env var and plugins', () => {
  assert.match(MCP_EMPTY_MESSAGE, /--mcp-config/)
  assert.match(MCP_EMPTY_MESSAGE, /TWO_BROTHERS_MCP_CONFIG/)
  assert.match(MCP_EMPTY_MESSAGE, /plugin/)
})

test('section rows: config source badges as config, plugin source badges as the plugin name', () => {
  const rows = mcpSectionRows([
    server(),
    server({ name: 'notes', source: 'plugin', plugin: 'notes-plugin', role: 'shared' }),
  ])
  assert.deepEqual(
    rows.map((r) => [r.name, r.badge, r.transport, r.role, r.target, r.invalid]),
    [
      ['deja', 'config', 'stdio', 'junior', 'deja mcp', false],
      ['notes', 'notes-plugin', 'stdio', 'shared', 'deja mcp', false],
    ],
  )
})

test('transport labels: http renders as HTTP, stdio/invalid stay lowercase', () => {
  assert.equal(mcpTransportLabel('http'), 'HTTP')
  assert.equal(mcpTransportLabel('stdio'), 'stdio')
  assert.equal(mcpTransportLabel('invalid'), 'invalid')
  const rows = mcpSectionRows([
    server({ name: 'remote', transport: 'http', target: 'https://example.test/mcp' }),
    server({ name: 'broken', transport: 'invalid', target: '' }),
  ])
  assert.deepEqual(
    rows.map((r) => [r.name, r.transport, r.invalid]),
    [
      ['remote', 'HTTP', false],
      ['broken', 'invalid', true],
    ],
  )
})

// -- /status block visibility ---------------------------------------------------

test('status block: hidden when status is missing, or configured-but-empty with no lastRun', () => {
  assert.equal(mcpBlockVisible(null), false)
  assert.equal(mcpBlockVisible(undefined), false)
  assert.equal(mcpBlockVisible(status()), false)
  assert.equal(mcpBlockVisible(status({ configured: [server()] })), false)
  const withRun = status({
    configured: [],
    lastRun: {
      at: '2026-11-18T12:00:00.000Z',
      session: 'my-session',
      runId: 'abc123',
      servers: [],
    },
  })
  assert.equal(mcpBlockVisible(withRun), true)
})

// -- /status block rows -----------------------------------------------------------

test('status block: mixed connected/failed rows with tool counts and bounded errors', () => {
  const block = mcpStatusBlock(
    {
      at: '2026-11-18T12:00:00.000Z',
      session: 'my-session',
      runId: 'abc123',
      servers: [
        { name: 'deja', status: 'connected', toolCount: 1 },
        { name: 'broken', status: 'failed', error: 'initialization timed out', toolCount: 0 },
      ],
    },
    NOW,
  )
  assert.equal(block.title, 'MCP — last run')
  assert.equal(block.timeText, '5 min ago')
  assert.match(block.timeTitle, /2026/)
  assert.equal(block.failedCount, 1)
  assert.deepEqual(block.rows, [
    { name: 'deja', ok: true, detail: '1 tool' },
    { name: 'broken', ok: false, detail: 'initialization timed out' },
  ])
})

test('status block: plural tool counts, missing error falls back, no failures', () => {
  const block = mcpStatusBlock(
    {
      at: '2026-11-18T12:00:00.000Z',
      session: 's',
      runId: 'r',
      servers: [
        { name: 'a', status: 'connected', toolCount: 3 },
        { name: 'b', status: 'failed', toolCount: 0 },
      ],
    },
    NOW,
  )
  assert.equal(block.failedCount, 1)
  assert.deepEqual(block.rows, [
    { name: 'a', ok: true, detail: '3 tools' },
    { name: 'b', ok: false, detail: 'failed' },
  ])
})

test('boundMcpError collapses whitespace and hard-bounds long failures', () => {
  assert.equal(boundMcpError('  initialization\n\ttimed out '), 'initialization timed out')
  const long = 'x'.repeat(MCP_ERROR_MAX * 3)
  const bounded = boundMcpError(long)
  assert.equal(bounded.length, MCP_ERROR_MAX)
  assert.ok(bounded.endsWith('…'))
})
