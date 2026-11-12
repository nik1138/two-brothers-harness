/**
 * Read-only helper subagents in the web shell (pure helpers + source wiring).
 * No DOM/Vue runtime:
 *   node --import ./tests/register-ts.mjs --test tests/subagents.test.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  applySubagentDetailEvent,
  applySubagentEvent,
  normalizeSubagentDetail,
  normalizeSubagentList,
  runningSubagentCount,
  subagentActivityText,
  subagentDuration,
  subagentElapsed,
  subagentRoleLabel,
  subagentStatusLabel,
  subagentTaskPreview,
  subagentTokenLabel,
} from '../src/subagents.ts'
import type {
  RunEvent,
  SubagentActivityEvent,
  SubagentCompletedEvent,
  SubagentDetail,
  SubagentInfo,
  SubagentStartedEvent,
} from '../src/types.ts'

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/${relative}`, import.meta.url)), 'utf8')

function info(overrides: Partial<SubagentInfo> = {}): SubagentInfo {
  return {
    id: 'sub-12345678',
    parent_session: 'parent.jsonl',
    label: 'Read auth',
    role: 'junior',
    model: 'lfm3-1.7b',
    task: 'Inspect src/auth.ts.',
    status: 'running',
    started_at: 1_000,
    last_activity: null,
    usage: null,
    result: null,
    error: null,
    ...overrides,
  }
}

function detail(overrides: Partial<SubagentDetail> = {}): SubagentDetail {
  return {
    ...info(),
    transcript: [
      { type: 'message', role: 'user', text: 'Inspect src/auth.ts.', at: 1_000 },
      { type: 'message', role: 'assistant', text: 'It exports login().', at: 1_020 },
    ],
    ...overrides,
  }
}

function started(overrides: Partial<SubagentStartedEvent> = {}): SubagentStartedEvent {
  return {
    type: 'subagent_started',
    subagent_id: 'sub-12345678',
    label: 'Read auth',
    role: 'junior',
    model: 'lfm3-1.7b',
    task: 'Inspect src/auth.ts.',
    started_at: 1_000,
    run_id: 'run-1',
    at: 10,
    ...overrides,
  }
}

function activity(
  overrides: Partial<SubagentActivityEvent> = {},
): SubagentActivityEvent {
  return {
    type: 'subagent_activity',
    subagent_id: 'sub-12345678',
    label: 'Read auth',
    activity: 'message',
    text: 'The auth flow starts at login().',
    run_id: 'run-1',
    at: 12,
    ...overrides,
  }
}

function completed(
  overrides: Partial<SubagentCompletedEvent> = {},
): SubagentCompletedEvent {
  return {
    type: 'subagent_completed',
    subagent_id: 'sub-12345678',
    label: 'Read auth',
    status: 'completed',
    result: 'It exports login().',
    usage: {
      model_calls: 2,
      input_tokens: 1_200,
      output_tokens: 300,
      cached_tokens: 600,
      cache_write_tokens: 0,
    },
    duration_ms: 12_000,
    ended_at: 13_000,
    run_id: 'run-1',
    at: 13,
    ...overrides,
  }
}

test('normalizes the parent tree and a child detail tolerantly', () => {
  const list = normalizeSubagentList({
    subagents: [info(), { id: 'broken' }, null],
  })
  assert.equal(list.length, 1)
  assert.equal(list[0]?.status, 'running')
  assert.equal(list[0]?.last_activity, null)

  const detailRow = normalizeSubagentDetail({
    ...info({ status: 'completed', result: 'done', ended_at: 2_000 }),
    transcript: [
      { type: 'message', role: 'assistant', text: 'done', at: 1_500 },
      { type: 'tool', tool: 'workspace_read_file', status: 'completed', result: 'x', at: 1_600 },
      { type: 'tool', tool: '', status: 'completed' },
    ],
  })
  assert.ok(detailRow)
  assert.equal(detailRow.status, 'completed')
  assert.equal(detailRow.transcript.length, 2)
  assert.equal(detailRow.transcript[1]?.tool, 'workspace_read_file')
  assert.equal(normalizeSubagentList('nope').length, 0)
  assert.equal(normalizeSubagentDetail({ id: '' }), null)
})

test('folds started, activity and completed events into one tree row', () => {
  let tree = applySubagentEvent([], started() as RunEvent)
  assert.equal(tree.length, 1)
  assert.equal(tree[0]?.status, 'running')
  assert.equal(runningSubagentCount(tree), 1)

  tree = applySubagentEvent(
    tree,
    activity({ activity: 'tool', tool: 'workspace_read_file', status: 'completed' }) as RunEvent,
  )
  assert.equal(tree[0]?.last_activity?.tool, 'workspace_read_file')
  assert.equal(tree[0]?.last_activity?.status, 'completed')

  tree = applySubagentEvent(tree, completed() as RunEvent)
  assert.equal(tree[0]?.status, 'completed')
  assert.equal(tree[0]?.usage?.cached_tokens, 600)
  assert.equal(tree[0]?.duration_ms, 12_000)
  assert.equal(runningSubagentCount(tree), 0)
  // A repeated terminal event updates in place, never appends another row.
  tree = applySubagentEvent(tree, completed() as RunEvent)
  assert.equal(tree.length, 1)
})

test('the open child drawer never duplicates the final report', () => {
  const row = detail({ status: 'running', result: null })
  const next = applySubagentDetailEvent(
    row,
    activity({ text: 'It exports login().' }) as RunEvent,
  )
  assert.equal(next.transcript.length, 2, 'the same assistant text is not duplicated')
  assert.equal(next.last_activity?.kind, 'message')

  const finished = applySubagentDetailEvent(next, completed() as RunEvent)
  assert.equal(finished.status, 'completed')
  assert.equal(finished.usage?.cached_tokens, 600)
  assert.equal(finished.transcript.length, 2)
})

test('tool events pair with the newest open row and a missing start appends', () => {
  const row = detail({ transcript: [] })
  const startedTool = applySubagentDetailEvent(
    row,
    activity({
      activity: 'tool',
      tool: 'workspace_read_file',
      status: 'started',
      args: { path: 'a.ts' },
    }) as RunEvent,
  )
  assert.equal(startedTool.transcript.length, 1)
  assert.equal(startedTool.transcript[0]?.status, 'started')
  // A repeated start for the same open tool is ignored.
  const repeated = applySubagentDetailEvent(
    startedTool,
    activity({
      activity: 'tool',
      tool: 'workspace_read_file',
      status: 'started',
    }) as RunEvent,
  )
  assert.equal(repeated.transcript.length, 1)
  const done = applySubagentDetailEvent(
    repeated,
    activity({
      activity: 'tool',
      tool: 'workspace_read_file',
      status: 'completed',
      result: 'export const a = 1',
    }) as RunEvent,
  )
  assert.equal(done.transcript.length, 1)
  assert.equal(done.transcript[0]?.status, 'completed')
  assert.match(done.transcript[0]?.result ?? '', /export const a/)
  // A completion with no start is still visible (a reconnect gap).
  const orphan = applySubagentDetailEvent(
    detail({ transcript: [] }),
    activity({ activity: 'tool', tool: 'workspace_list_dir', status: 'completed' }) as RunEvent,
  )
  assert.equal(orphan.transcript.length, 1)
  assert.equal(orphan.transcript[0]?.status, 'completed')
})

test('labels, duration, activity and usage stay compact and honest', () => {
  assert.equal(subagentStatusLabel('running'), 'running')
  assert.equal(subagentStatusLabel('completed'), 'completed')
  assert.equal(subagentStatusLabel('failed'), 'failed')
  assert.equal(subagentRoleLabel('senior'), 'Senior model')
  assert.equal(subagentRoleLabel('junior'), 'Junior model')
  assert.equal(subagentDuration(0), '0:00')
  assert.equal(subagentDuration(62_000), '1:02')
  assert.equal(subagentDuration(3_723_000), '1:02:03')
  assert.equal(subagentElapsed(1_000, 63_000), '1:02')
  assert.equal(subagentElapsed(0, 5_000), '')
  assert.equal(subagentTokenLabel(null), '')
  assert.equal(
    subagentTokenLabel({
      model_calls: 1,
      input_tokens: 1_200,
      output_tokens: 300,
      cached_tokens: 0,
    }),
    '1.5k tok',
  )
  assert.match(
    subagentActivityText({ kind: 'tool', tool: 'workspace_read_file', status: 'completed', at: 1 }),
    /done/,
  )
  assert.match(
    subagentActivityText({ kind: 'tool', tool: 'workspace_read_file', status: 'error', at: 1 }),
    /failed/,
  )
  assert.equal(subagentActivityText(null, 'running'), 'starting…')
  assert.equal(subagentTaskPreview('a\nb', 10), 'a b')
})

test('the shell owns the live tree, a read-only drawer and the API wiring', () => {
  const app = read('App.vue')
  assert.ok(app.includes('listSessionSubagents'))
  assert.ok(app.includes('getSubagent'))
  assert.ok(app.includes('applySubagentEvent'))
  assert.ok(app.includes('applySubagentDetailEvent'))
  assert.ok(app.includes('SubagentView'))
  assert.ok(app.includes('subagent-chip'))
  assert.ok(app.includes('subagent-tree'))
  assert.ok(app.includes('subagent_started'))
  assert.ok(app.includes('subagent_completed'))
  assert.ok(app.includes('openSubagent'))
  assert.ok(app.includes('closeSubagent'))
  assert.ok(app.includes('onSubagentEscape'))

  const view = read('components/SubagentView.vue')
  assert.ok(view.includes('Final report'))
  assert.ok(view.includes('read-only'))
  assert.ok(view.includes('transcript'))
  assert.equal(view.includes('<Composer'), false, 'the child view is read-only')

  const api = read('api.ts')
  assert.ok(api.includes('/api/sessions/${encodeURIComponent(name)}/subagents'))
  assert.ok(api.includes('/api/subagents/${encodeURIComponent(id)}'))
})
