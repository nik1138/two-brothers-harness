// Focused tests for the "select a workspace to start" rule helpers
// (src/workspaceContext.ts) plus the source-level invariants of the New
// session dialog and the in-place composer prompt. No DOM:
//   node --import ./tests/register-ts.mjs --test tests/workspaceStart.test.ts

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import {
  SELECT_WORKSPACE_MESSAGE,
  SELECT_WORKSPACE_NOTE,
  canStartRun,
  initialSessionWorkspaceId,
  isSelectWorkspaceMessage,
  normalizeWorkspaceId,
  runWorkspaceForSession,
} from '../src/workspaceContext.ts'

const sourceOf = (file: string) =>
  readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8')

test('the UI copy names the backend contract message byte-for-byte', () => {
  assert.equal(SELECT_WORKSPACE_MESSAGE, 'select a workspace to start')
  assert.equal(SELECT_WORKSPACE_NOTE, 'Select a workspace to start')
  // the in-place prompt and the backend's refusal are recognizably the same rule
  const prompt = sourceOf('components/WorkspaceStartPrompt.vue')
  assert.match(prompt, /SELECT_WORKSPACE_MESSAGE/)
  assert.match(prompt, /SELECT_WORKSPACE_NOTE/)
})

test('normalizeWorkspaceId: trimmed real id, never the all sentinel or junk', () => {
  assert.equal(normalizeWorkspaceId('ws-1'), 'ws-1')
  assert.equal(normalizeWorkspaceId('  ws-1  '), 'ws-1')
  assert.equal(normalizeWorkspaceId(''), null)
  assert.equal(normalizeWorkspaceId('   '), null)
  assert.equal(normalizeWorkspaceId('all'), null)
  assert.equal(normalizeWorkspaceId(null), null)
  assert.equal(normalizeWorkspaceId(undefined), null)
  assert.equal(normalizeWorkspaceId(42), null)
  assert.equal(normalizeWorkspaceId({}), null)
})

test('canStartRun: only a real workspace id lets a run start', () => {
  assert.equal(canStartRun('ws-1'), true)
  assert.equal(canStartRun('  ws-1  '), true)
  assert.equal(canStartRun(''), false)
  assert.equal(canStartRun('   '), false)
  assert.equal(canStartRun('all'), false)
  assert.equal(canStartRun(null), false)
  assert.equal(canStartRun(undefined), false)
  assert.equal(canStartRun(0), false)
})

test('an existing session runs only with its own link (a pending pick is not silent binding)', () => {
  assert.equal(runWorkspaceForSession(true, 'linked', 'picked'), 'linked')
  assert.equal(runWorkspaceForSession(true, '  linked  ', null), 'linked')
  // unlinked session: the pick is staged but not a run workspace until bound
  assert.equal(runWorkspaceForSession(true, null, 'picked'), null)
  assert.equal(runWorkspaceForSession(true, '', 'picked'), null)
  assert.equal(runWorkspaceForSession(true, 'all', 'picked'), null)
  assert.equal(runWorkspaceForSession(true, undefined, undefined), null)
})

test('a new session uses the explicit start-screen pick', () => {
  assert.equal(runWorkspaceForSession(false, null, 'picked'), 'picked')
  assert.equal(runWorkspaceForSession(false, 'linked', '  picked  '), 'picked')
  assert.equal(runWorkspaceForSession(false, null, null), null)
  assert.equal(runWorkspaceForSession(false, null, 'all'), null)
  assert.equal(runWorkspaceForSession(false, null, ''), null)
})

test('runWorkspaceForSession has no filter parameter (source-level)', () => {
  // The sidebar filter is a view filter: the helper signature cannot see it,
  // so a run can never fall back to it.
  const source = sourceOf('workspaceContext.ts')
  assert.match(
    source,
    /function runWorkspaceForSession\(\s*hasSession: boolean,\s*sessionWorkspaceId: string \| null \| undefined,\s*pickedWorkspaceId: string \| null \| undefined,?\s*\)/,
  )
  assert.doesNotMatch(source, /runWorkspaceForSession\([^\n]*filter/)
})

test('initialSessionWorkspaceId: the sidebar filter first, else the newest recent', () => {
  const existing = ['a', 'b', 'c']
  assert.equal(initialSessionWorkspaceId(existing, 'b', ['c', 'a']), 'b')
  // a stale default falls through to the recent list, newest first
  assert.equal(initialSessionWorkspaceId(existing, 'gone', ['c', 'a']), 'c')
  // records the backend no longer lists are skipped
  assert.equal(initialSessionWorkspaceId(existing, null, ['gone', 'a']), 'a')
  // the sentinel/null are never a pick
  assert.equal(initialSessionWorkspaceId(existing, 'all', ['all']), '')
  assert.equal(initialSessionWorkspaceId(existing, '', []), '')
})

test('initialSessionWorkspaceId never invents a default workspace', () => {
  assert.equal(initialSessionWorkspaceId([], 'a', ['a']), '')
  assert.equal(initialSessionWorkspaceId([], null, []), '')
  assert.equal(initialSessionWorkspaceId(['a'], undefined, undefined), '')
  assert.equal(initialSessionWorkspaceId(['a'], '  ', ['  ']), '')
  assert.equal(initialSessionWorkspaceId(['a'], 7 as unknown, [{}]), '')
})

test('isSelectWorkspaceMessage matches only the documented refusal', () => {
  assert.equal(isSelectWorkspaceMessage('select a workspace to start'), true)
  assert.equal(isSelectWorkspaceMessage('  Select a workspace to start  '), true)
  assert.equal(isSelectWorkspaceMessage('select a workspace to start.'.slice(0, -1)), true)
  assert.equal(isSelectWorkspaceMessage('select a workspace to start!'), false)
  assert.equal(isSelectWorkspaceMessage('unknown workspace_id'), false)
  assert.equal(isSelectWorkspaceMessage(''), false)
  assert.equal(isSelectWorkspaceMessage(null), false)
  assert.equal(isSelectWorkspaceMessage({ message: 'select a workspace to start' }), false)
})

test('the New session dialog has no unattached option and requires a pick', () => {
  const dialog = sourceOf('components/NewSessionDialog.vue')
  // no "No workspace" radio label and no empty-value radio
  assert.doesNotMatch(dialog, /No workspace<\/span>/)
  assert.doesNotMatch(dialog, /Keep this session unattached/)
  assert.doesNotMatch(dialog, /value=""/)
  // Create is bound to canCreate, which requires a real pick
  assert.match(dialog, /const canCreate = computed\(\(\) => workspaceId\.value !== ''\)/)
  assert.match(dialog, /:disabled="!canCreate"/)
  // the only seed is real-workspace-only
  assert.match(dialog, /initialSessionWorkspaceId\(/)
  // the add-workspace finder path stays available
  assert.match(dialog, /data-focus-target="add-folder"/)
  assert.match(dialog, /WorkspaceFinder/)
})

test('App preempts the request: submit is blocked until a workspace is bound', () => {
  const app = sourceOf('App.vue')
  // the guard runs before startRun and never sends a null workspace
  assert.match(app, /if \(workspaceRequired\.value \|\| !workspaceId\)/)
  // the documented 400 is surfaced as the prompt (never a toast)
  assert.match(app, /isSelectWorkspaceMessage\(e\.message\)/)
  assert.match(app, /markSelectedSessionUnbound\(\)/)
  // the binding PATCH is the documented shape
  assert.match(app, /setSessionWorkspace\(name, id\)/)
  const api = sourceOf('api.ts')
  assert.match(api, /json\('PATCH', \{ workspace_id: workspaceId \}\)/)
})

test('the composer disables submit with an accessible workspace reason', () => {
  const composer = sourceOf('components/Composer.vue')
  assert.match(composer, /workspace: props\.workspaceRequired !== true/)
  assert.match(composer, /:aria-describedby="workspaceRequired \? workspaceNoteId : undefined"/)
  assert.match(composer, /:disabled="!canSend"/)
  assert.match(composer, /SELECT_WORKSPACE_NOTE/)
})

test('the in-place prompt has no dialog and no new global chrome', () => {
  const prompt = sourceOf('components/WorkspaceStartPrompt.vue')
  assert.doesNotMatch(prompt, /NModal|n-modal|role="dialog"/)
  assert.match(prompt, /data-workspace-start/)
  assert.match(prompt, /role="radiogroup"/)
  assert.match(prompt, /data-workspace-add/)
})
