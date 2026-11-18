/**
 * Hermetic tests for the plugins API client (`web/src/api.ts`): the extended
 * `GET /api/plugins` normalization (additive fields tolerated as absent) and
 * `updatePluginOptions` (PUT /api/plugins/{name}/options) — request shape and
 * the 200 / 400 / 404 / 409 response mapping. `fetch` is stubbed — no network.
 *
 * Run with: node --import ./tests/register-ts.mjs --test tests/pluginOptionsApi.test.ts
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  ApiError,
  listPlugins,
  normalizePluginDescriptor,
  normalizePluginSelection,
  updatePluginOptions,
} from '../src/api'

interface CapturedCall {
  url: string
  method: string
  body?: unknown
}

function stubFetch(responses: Array<{ status?: number; body: unknown }>): {
  calls: CapturedCall[]
  restore: () => void
} {
  const original = globalThis.fetch
  const calls: CapturedCall[] = []
  let index = 0
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) })
    const response = responses[Math.min(index, responses.length - 1)] ?? { body: {} }
    index += 1
    return new Response(JSON.stringify(response.body ?? {}), {
      status: response.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch
  return { calls, restore: () => (globalThis.fetch = original) }
}

test('normalizePluginDescriptor fills additive defaults for older backends', () => {
  const descriptor = normalizePluginDescriptor({ name: 'notes', description: 'Notes', roles: ['shared'] })
  assert.deepEqual(descriptor, {
    name: 'notes',
    description: 'Notes',
    roles: ['shared'],
    kind: 'code',
    version: undefined,
    configSchema: null,
    options: {},
    toolsByScope: { shared: [], senior: [], junior: [] },
  })
  assert.equal(normalizePluginDescriptor('junk'), null)
  assert.equal(normalizePluginDescriptor({ description: 'no name' }), null)
})

test('listPlugins maps the extended shape tolerantly', async () => {
  const stub = stubFetch([
    {
      body: {
        plugins: [
          {
            name: 'notes',
            description: 'Note keeping',
            roles: ['shared'],
            kind: 'code',
            configSchema: { type: 'object', properties: { maxChars: { type: 'integer' } } },
            options: { maxChars: 100 },
            toolsByScope: { shared: ['write_note'], senior: ['audit_notes'], junior: [] },
          },
          { name: 'standup', description: '', roles: [], kind: 'bundle', version: '1.0.0' },
          null,
        ],
        errors: [{ plugin: 'bad', error: 'boom' }, { plugin: 3 }],
      },
    },
  ])
  try {
    const view = await listPlugins()
    assert.equal(view.plugins.length, 2)
    assert.equal(view.plugins[0].kind, 'code')
    assert.deepEqual(view.plugins[0].options, { maxChars: 100 })
    assert.deepEqual(view.plugins[0].toolsByScope, {
      shared: ['write_note'],
      senior: ['audit_notes'],
      junior: [],
    })
    assert.equal(view.plugins[1].kind, 'bundle')
    assert.equal(view.plugins[1].version, '1.0.0')
    assert.deepEqual(view.plugins[1].toolsByScope, { shared: [], senior: [], junior: [] })
    // Malformed entries dropped; the well-formed error survives.
    assert.deepEqual(view.errors, [{ plugin: 'bad', error: 'boom' }])
    assert.equal(stub.calls[0].url, '/api/plugins')
    assert.equal(stub.calls[0].method, 'GET')
  } finally {
    stub.restore()
  }
})

test('updatePluginOptions PUTs the options and maps the 200 shape', async () => {
  const stub = stubFetch([{ body: { name: 'notes', options: { maxChars: 100 } } }])
  try {
    const result = await updatePluginOptions('notes', { maxChars: 100 })
    assert.deepEqual(result, { name: 'notes', options: { maxChars: 100 } })
    assert.equal(stub.calls[0].url, '/api/plugins/notes/options')
    assert.equal(stub.calls[0].method, 'PUT')
    assert.deepEqual(stub.calls[0].body, { options: { maxChars: 100 } })
  } finally {
    stub.restore()
  }
})

test('updatePluginOptions encodes the plugin name in the path', async () => {
  const stub = stubFetch([{ body: { name: 'a/b', options: {} } }])
  try {
    await updatePluginOptions('a/b', {})
    assert.equal(stub.calls[0].url, '/api/plugins/a%2Fb/options')
  } finally {
    stub.restore()
  }
})

test('updatePluginOptions maps 400 / 404 / 409 to ApiError with the detail', async () => {
  for (const [status, detail] of [
    [400, 'options rejected by configSchema: maxChars: expected integer'],
    [404, 'unknown plugin'],
    [409, 'plugin failed to load: boom'],
  ] as const) {
    const stub = stubFetch([{ status, body: { detail } }])
    try {
      await assert.rejects(updatePluginOptions('notes', {}), (e: unknown) => {
        assert.ok(e instanceof ApiError)
        assert.equal(e.status, status)
        assert.equal(e.message, detail)
        return true
      })
    } finally {
      stub.restore()
    }
  }
})

test('normalizePluginSelection extracts names from {path, options} entries', () => {
  assert.deepEqual(
    normalizePluginSelection(['a', { path: 'b', options: { x: 1 } }, { path: ' a ' }, 7, { nope: 1 }]),
    ['a', 'b'],
  )
  assert.deepEqual(normalizePluginSelection({ senior: ['s'], junior: ['j', 's'] }), ['s', 'j'])
})
