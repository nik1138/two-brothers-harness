// Focused tests for src/workspaceContext.ts — the workspace a web run carries.
// No DOM:
//   node --import ./tests/register-ts.mjs --test tests/workspaceContext.test.ts

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { runWorkspaceId } from '../src/workspaceContext.ts'
import { pathCrumbs, separatorFor } from '../src/fsPath.ts'

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
