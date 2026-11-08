// Focused tests for src/workspaceContext.ts — the workspace a web run carries.
// No DOM:
//   node --import ./tests/register-ts.mjs --test tests/workspaceContext.test.ts

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { runWorkspaceId } from '../src/workspaceContext.ts'

test('a session-linked workspace wins over the sidebar filter', () => {
  assert.equal(runWorkspaceId('linked-ws', 'all'), 'linked-ws')
  assert.equal(runWorkspaceId('linked-ws', 'other-ws'), 'linked-ws')
  assert.equal(runWorkspaceId('  linked-ws  ', 'other-ws'), 'linked-ws')
})

test('the sidebar filter is the fallback for an unlinked session', () => {
  assert.equal(runWorkspaceId(null, 'filter-ws'), 'filter-ws')
  assert.equal(runWorkspaceId('', 'filter-ws'), 'filter-ws')
  assert.equal(runWorkspaceId(undefined, '  filter-ws  '), 'filter-ws')
  assert.equal(runWorkspaceId('   ', 'filter-ws'), 'filter-ws')
})

test('no link and no real filter means no workspace', () => {
  assert.equal(runWorkspaceId(null, 'all'), null)
  assert.equal(runWorkspaceId(undefined, 'all'), null)
  assert.equal(runWorkspaceId('', ''), null)
  assert.equal(runWorkspaceId('   ', '   '), null)
  assert.equal(runWorkspaceId(null, null), null)
  assert.equal(runWorkspaceId(null, undefined), null)
})

test('unexpected values are treated as not set', () => {
  const junk = 42 as unknown as string
  assert.equal(runWorkspaceId(junk, 'filter-ws'), 'filter-ws')
  assert.equal(runWorkspaceId(null, junk), null)
  assert.equal(runWorkspaceId({} as unknown as string, junk), null)
})

test('App submits the composer workspace with every run (source-level)', () => {
  const source = readFileSync(new URL('../src/App.vue', import.meta.url), 'utf8')
  assert.match(source, /workspace_id: composerWorkspaceId\.value/)
  assert.doesNotMatch(source, /workspace_id: workspaceFilter\.value/)
})
