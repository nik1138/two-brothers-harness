/**
 * Hermetic tests for the MCP API client (web/src/api.ts): `getMcpStatus`
 * against the frozen GET /api/mcp contract plus the tolerant
 * `normalizeMcpStatus` boundary. `fetch` is stubbed — no network.
 *
 * Run with: node --import ./tests/register-ts.mjs --test tests/mcpApi.test.ts
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ApiError, getMcpStatus, normalizeMcpStatus } from '../src/api'

/** The frozen backend contract, byte-for-byte shape. */
const FROZEN = {
  configured: [
    {
      name: 'deja',
      source: 'config',
      plugin: null,
      role: 'junior',
      transport: 'stdio',
      target: 'deja mcp',
    },
  ],
  lastRun: {
    at: '2026-11-18T12:00:00.000Z',
    session: 'my-session',
    runId: 'abc123',
    servers: [
      { name: 'deja', status: 'connected', toolCount: 1 },
      { name: 'broken', status: 'failed', error: 'initialization timed out', toolCount: 0 },
    ],
  },
}

function stubFetch(body: unknown, status = 200): { calls: string[]; restore: () => void } {
  const original = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = (async (input: string | URL | Request) => {
    calls.push(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url)
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch
  return { calls, restore: () => (globalThis.fetch = original) }
}

test('getMcpStatus fetches /api/mcp and returns the frozen shape', async () => {
  const stub = stubFetch(FROZEN)
  try {
    const status = await getMcpStatus()
    assert.deepEqual(stub.calls, ['/api/mcp'])
    assert.deepEqual(status, FROZEN)
    assert.equal(status.configured[0]!.name, 'deja')
    assert.equal(status.configured[0]!.source, 'config')
    assert.equal(status.configured[0]!.plugin, null)
    assert.equal(status.configured[0]!.role, 'junior')
    assert.equal(status.configured[0]!.transport, 'stdio')
    assert.equal(status.configured[0]!.target, 'deja mcp')
    assert.equal(status.lastRun!.runId, 'abc123')
    assert.deepEqual(status.lastRun!.servers[1], {
      name: 'broken',
      status: 'failed',
      error: 'initialization timed out',
      toolCount: 0,
    })
  } finally {
    stub.restore()
  }
})

test('getMcpStatus maps HTTP failures onto ApiError', async () => {
  const stub = stubFetch({ detail: 'nope' }, 500)
  try {
    await assert.rejects(getMcpStatus(), (e: unknown) => {
      assert.ok(e instanceof ApiError)
      assert.equal(e.status, 500)
      assert.equal(e.message, 'nope')
      return true
    })
  } finally {
    stub.restore()
  }
})

test('normalizeMcpStatus tolerates garbage and fills defaults', () => {
  assert.deepEqual(normalizeMcpStatus(null), { configured: [], lastRun: null })
  assert.deepEqual(normalizeMcpStatus('junk'), { configured: [], lastRun: null })

  const normalized = normalizeMcpStatus({
    configured: [
      { name: 'a', source: 'plugin', plugin: 'p', role: 'senior', transport: 'http', target: 'u' },
      { name: 'b' },
      { noName: true },
      'junk',
      { name: 'c', source: 'other', role: 'bogus', transport: 'weird', plugin: 3, target: 9 },
    ],
    lastRun: {
      at: '2026-11-18T12:00:00.000Z',
      session: 's',
      runId: 'r',
      servers: [
        { name: 'ok', status: 'connected', toolCount: 2 },
        { name: 'bad' },
        null,
      ],
    },
  })

  assert.deepEqual(normalized.configured, [
    { name: 'a', source: 'plugin', plugin: 'p', role: 'senior', transport: 'http', target: 'u' },
    { name: 'b', source: 'config', plugin: null, role: 'shared', transport: 'invalid', target: '' },
    { name: 'c', source: 'config', plugin: null, role: 'shared', transport: 'invalid', target: '' },
  ])
  assert.deepEqual(normalized.lastRun!.servers, [
    { name: 'ok', status: 'connected', toolCount: 2 },
    { name: 'bad', status: 'failed', toolCount: 0 },
  ])

  // lastRun present but not an object → null.
  assert.equal(normalizeMcpStatus({ lastRun: 'x' }).lastRun, null)
})
