/**
 * Helper subagents in the web shell (pure helpers + source wiring). No DOM/Vue
 * runtime:
 *   node --import ./tests/register-ts.mjs --test tests/subagents.test.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  applySubagentApprovalDetailEvent,
  applySubagentApprovalEvent,
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

test('the shell owns the live tree, an isolated drawer and the API wiring', () => {
  const app = read('App.vue')
  assert.ok(app.includes('listSessionSubagents'))
  assert.ok(app.includes('getSubagent'))
  assert.ok(app.includes('applySubagentEvent'))
  assert.ok(app.includes('applySubagentDetailEvent'))
  assert.ok(app.includes('applySubagentApprovalEvent'))
  assert.ok(app.includes('applySubagentApprovalDetailEvent'))
  assert.ok(app.includes('SubagentView'))
  assert.ok(app.includes('subagent-chip'))
  assert.ok(app.includes('subagent-tree'))
  assert.ok(app.includes('subagent_started'))
  assert.ok(app.includes('subagent_completed'))
  assert.ok(app.includes('openSubagent'))
  assert.ok(app.includes('closeSubagent'))
  assert.ok(app.includes('onSubagentEscape'))
  assert.ok(app.includes('Helpers'), 'the tree title no longer claims read-only')

  const view = read('components/SubagentView.vue')
  assert.ok(view.includes('Final report'))
  assert.ok(view.includes('subagent-approval'), 'approval rows render in the drawer')
  assert.ok(view.includes('transcript'))
  assert.equal(view.includes('read-only'), false, 'the drawer copy is not read-only')
  assert.equal(/v-html\s*=/.test(view), false, 'child rows are plain text only')
  assert.equal(view.includes('<Composer'), false, 'the child view has no composer')

  const api = read('api.ts')
  assert.ok(api.includes('/api/sessions/${encodeURIComponent(name)}/subagents'))
  assert.ok(api.includes('/api/subagents/${encodeURIComponent(id)}'))
})

// ---------------------------------------------------------------------------
// approval rows and child-tagged approval events
// ---------------------------------------------------------------------------

function approvalEvent(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: 'approval_requested',
    approval_id: 'approval-1',
    action: 'write',
    target: 'e2e-helper.txt',
    subagent_id: 'sub-12345678',
    subagent_label: 'Write the helper file',
    run_id: 'run-1',
    at: 40,
    ...overrides,
  }
}

test('the child detail keeps approval rows and drops malformed ones', () => {
  const row = normalizeSubagentDetail({
    ...info(),
    transcript: [
      { type: 'approval', status: 'pending', action: 'write', target: 'a.txt', at: 1 },
      { type: 'approval', status: 'allowed', action: 'shell', command: 'echo hi', at: 2 },
      { type: 'approval', status: 'bogus', action: 'write', at: 3 },
      { type: 'approval', status: 'pending', action: '', at: 4 },
      { type: 'message', role: 'assistant', text: 'done', at: 5 },
    ],
  })
  assert.ok(row)
  assert.equal(row.transcript.length, 3)
  const first = row.transcript[0]
  assert.ok(first?.type === 'approval')
  assert.equal(first.status, 'pending')
  assert.equal(first.action, 'write')
  assert.equal(first.target, 'a.txt')
  const second = row.transcript[1]
  assert.ok(second?.type === 'approval')
  assert.equal(second.command, 'echo hi')
})

test('a child-tagged approval event sets and clears the row wait', () => {
  const tree: SubagentInfo[] = [info()]
  const waiting = applySubagentApprovalEvent(tree, approvalEvent() as RunEvent)
  assert.equal(waiting[0]?.last_activity?.kind, 'status')
  assert.equal(waiting[0]?.last_activity?.status, 'awaiting_approval')
  assert.equal(
    subagentActivityText(waiting[0]?.last_activity, 'running'),
    'waiting for approval',
  )
  const resumed = applySubagentApprovalEvent(
    waiting,
    {
      type: 'approval_resolved',
      approval_id: 'approval-1',
      decision: 'allow',
      subagent_id: 'sub-12345678',
      run_id: 'run-1',
      at: 41,
    } as RunEvent,
  )
  assert.equal(resumed[0]?.last_activity?.status, 'running')
  // Unknown child / no helper id / terminal row: no patch, same list.
  assert.equal(applySubagentApprovalEvent(tree, approvalEvent({ subagent_id: 'sub-nope' }) as RunEvent), tree)
  assert.equal(applySubagentApprovalEvent(tree, approvalEvent({ subagent_id: undefined }) as RunEvent), tree)
  const finished = applySubagentEvent(tree, completed() as RunEvent)
  const afterFinish = applySubagentApprovalEvent(finished, approvalEvent() as RunEvent)
  assert.equal(afterFinish[0]?.last_activity?.status, 'completed')
})

test('a child-tagged approval event appends and flips the drawer row', () => {
  const row = detail({ status: 'running', result: null, transcript: [] })
  const pending = applySubagentApprovalDetailEvent(row, approvalEvent() as RunEvent)
  assert.equal(pending.transcript.length, 1)
  const approval = pending.transcript[0]
  assert.ok(approval?.type === 'approval')
  assert.equal(approval.status, 'pending')
  assert.equal(approval.target, 'e2e-helper.txt')
  assert.equal(pending.last_activity?.status, 'awaiting_approval')
  // A repeated requested event does not duplicate the pending row.
  assert.equal(
    applySubagentApprovalDetailEvent(pending, approvalEvent() as RunEvent),
    pending,
  )
  const resolved = applySubagentApprovalDetailEvent(pending, {
    type: 'approval_resolved',
    approval_id: 'approval-1',
    decision: 'allow',
    subagent_id: 'sub-12345678',
    run_id: 'run-1',
    at: 41,
  } as RunEvent)
  const flipped = resolved.transcript[0]
  assert.ok(flipped?.type === 'approval')
  assert.equal(flipped.status, 'allowed')
  assert.equal(resolved.last_activity?.status, 'running')
  // A cancellation resolves the row as cancelled; another child is a no-op.
  const cancelled = applySubagentApprovalDetailEvent(pending, {
    type: 'approval_resolved',
    approval_id: 'approval-1',
    decision: 'deny',
    reason: 'cancelled',
    subagent_id: 'sub-12345678',
    run_id: 'run-1',
    at: 42,
  } as RunEvent)
  assert.equal(
    (cancelled.transcript[0] as { status?: string } | undefined)?.status,
    'cancelled',
  )
  assert.equal(
    applySubagentApprovalDetailEvent(pending, approvalEvent({ subagent_id: 'sub-other' }) as RunEvent),
    pending,
  )
})
