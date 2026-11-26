// Focused tests for src/workspaceContext.ts — the display context the composer
// picker uses (the run rule's own helpers are covered in workspaceStart.test.ts).
// No DOM:
//   node --import ./tests/register-ts.mjs --test tests/workspaceContext.test.ts

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { contextWorkspaceId } from '../src/workspaceContext.ts'
import { pathCrumbs, separatorFor } from '../src/fsPath.ts'

test('a session-linked workspace wins over the pick and the sidebar filter', () => {
  assert.equal(contextWorkspaceId('linked-ws', 'picked-ws', 'all'), 'linked-ws')
  assert.equal(contextWorkspaceId('linked-ws', null, 'other-ws'), 'linked-ws')
  assert.equal(contextWorkspaceId('  linked-ws  ', 'picked-ws', 'other-ws'), 'linked-ws')
})

test('the explicit pick wins over the sidebar filter', () => {
  assert.equal(contextWorkspaceId(null, 'picked-ws', 'filter-ws'), 'picked-ws')
  assert.equal(contextWorkspaceId('', '  picked-ws  ', 'filter-ws'), 'picked-ws')
  assert.equal(contextWorkspaceId(undefined, 'picked-ws', 'all'), 'picked-ws')
})

test('the sidebar filter is the last display fallback for an unlinked session', () => {
  assert.equal(contextWorkspaceId(null, null, 'filter-ws'), 'filter-ws')
  assert.equal(contextWorkspaceId('', '', '  filter-ws  '), 'filter-ws')
  assert.equal(contextWorkspaceId(undefined, undefined, 'filter-ws'), 'filter-ws')
})

test('the all sentinel and junk values are never a workspace', () => {
  assert.equal(contextWorkspaceId(null, null, 'all'), null)
  assert.equal(contextWorkspaceId('', '', ''), null)
  assert.equal(contextWorkspaceId('   ', '   ', '   '), null)
  assert.equal(contextWorkspaceId(null, null, null), null)
  assert.equal(contextWorkspaceId(null, null, undefined), null)
  assert.equal(contextWorkspaceId('all', 'all', 'all'), null)
  const junk = 42 as unknown as string
  assert.equal(contextWorkspaceId(junk, 'picked-ws', junk), 'picked-ws')
  assert.equal(contextWorkspaceId(null, junk, junk), null)
  assert.equal(contextWorkspaceId({} as unknown as string, junk, junk), null)
})

test('App never submits the display context as the run workspace (source-level)', () => {
  const source = readFileSync(new URL('../src/App.vue', import.meta.url), 'utf8')
  // the run request carries the bound/picked mission workspace
  assert.match(source, /workspace_id: request\.workspace_id/)
  assert.match(source, /workspace_id: workspaceId,/)
  // the sidebar-filter display fallback is never a run submission
  assert.doesNotMatch(source, /workspace_id: composerWorkspaceId\.value/)
  assert.doesNotMatch(source, /workspace_id: workspaceFilter\.value/)
  assert.doesNotMatch(source, /workspace_id: null,\s*\n\s*stream_tokens/)
})

// fsPath — the workspace finder breadcrumbs and separator selection.
// These lock the component's current path semantics (Windows drive, UNC,
// POSIX root), not a general path library.

test('pathCrumbs: empty path shows the drive list', () => {
  assert.deepEqual(pathCrumbs(''), [])
})

test('pathCrumbs: Windows drive root and trailing separator', () => {
  assert.deepEqual(pathCrumbs('C:\\'), [{ label: 'C:\\', path: 'C:\\' }])
  assert.deepEqual(pathCrumbs('C:\\Users\\nik\\'), [
    { label: 'C:\\', path: 'C:\\' },
    { label: 'Users', path: 'C:\\Users' },
    { label: 'nik', path: 'C:\\Users\\nik' },
  ])
})

test('pathCrumbs: Windows drive with forward slash and mixed separators', () => {
  assert.deepEqual(pathCrumbs('D:/work'), [
    { label: 'D:\\', path: 'D:\\' },
    { label: 'work', path: 'D:\\work' },
  ])
  assert.deepEqual(pathCrumbs('C:\\a/b\\c'), [
    { label: 'C:\\', path: 'C:\\' },
    { label: 'a', path: 'C:\\a' },
    { label: 'b', path: 'C:\\a\\b' },
    { label: 'c', path: 'C:\\a\\b\\c' },
  ])
})

test('pathCrumbs: UNC server/share and deeper paths', () => {
  assert.deepEqual(pathCrumbs('\\\\srv\\share'), [
    { label: '\\\\srv\\share', path: '\\\\srv\\share' },
  ])
  assert.deepEqual(pathCrumbs('\\\\srv\\share\\'), [
    { label: '\\\\srv\\share', path: '\\\\srv\\share' },
  ])
  assert.deepEqual(pathCrumbs('\\\\srv\\share\\dir\\sub'), [
    { label: '\\\\srv\\share', path: '\\\\srv\\share' },
    { label: 'dir', path: '\\\\srv\\share\\dir' },
    { label: 'sub', path: '\\\\srv\\share\\dir\\sub' },
  ])
  // Server with no share falls back to a server root crumb with a trailing
  // separator — the component's actual (quirky) behavior, kept verbatim.
  assert.deepEqual(pathCrumbs('\\\\srv'), [{ label: '\\\\srv\\', path: '\\\\srv\\' }])
})

test('pathCrumbs: POSIX root, nested and trailing separator', () => {
  assert.deepEqual(pathCrumbs('/'), [{ label: '/', path: '/' }])
  assert.deepEqual(pathCrumbs('/home/user'), [
    { label: '/', path: '/' },
    { label: 'home', path: '/home' },
    { label: 'user', path: '/home/user' },
  ])
  assert.deepEqual(pathCrumbs('/home/user/'), [
    { label: '/', path: '/' },
    { label: 'home', path: '/home' },
    { label: 'user', path: '/home/user' },
  ])
})

test('pathCrumbs: relative paths render as a single crumb', () => {
  assert.deepEqual(pathCrumbs('projects/app'), [
    { label: 'projects/app', path: 'projects/app' },
  ])
})

test('separatorFor: backslash wins, forward slash is the default', () => {
  assert.equal(separatorFor('C:\\Users'), '\\')
  assert.equal(separatorFor('\\\\srv\\share'), '\\')
  assert.equal(separatorFor('/home/user'), '/')
  assert.equal(separatorFor('projects'), '/')
  assert.equal(separatorFor('C:\\a/b'), '\\')
})
