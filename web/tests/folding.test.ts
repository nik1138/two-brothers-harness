// Focused tests for src/folding.ts (older completed-run activity folds into one
// summary row; the followed run and conversation content stay open). No DOM:
//   node --import ./tests/register-ts.mjs --test tests/folding.test.ts

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  FOLD_MIN_ROWS,
  buildFoldRows,
  foldEntryId,
  isFoldableEntry,
  summarizeFold,
} from '../src/folding.ts'
import type { TimelineEntry } from '../src/runtime.ts'
import type { ToolActivityItem, PromptAuditItem, ApprovalItem, RuntimeItem } from '../src/runtime.ts'
import type { ChatGroup, ChatMessage, ChatItem } from '../src/chat.ts'

// -- builders -----------------------------------------------------------------

let order = 0

function entryRow(entry: TimelineEntry['entry'], time = 100): TimelineEntry {
  order += 1
  return { time: time * 1000, order, entry }
}

function tool(runId: string, n: number, time = 100): TimelineEntry {
  const item: ToolActivityItem = {
    type: 'tool',
    id: `${runId}:tool:${n}`,
    actor: 'junior',
    tool: 'read_file',
    args: {},
    at: time,
    runId,
    status: 'ok',
    result: null,
  }
  return entryRow(item, time)
}

function audit(runId: string, n: number, time = 100): TimelineEntry {
  const item: PromptAuditItem = {
    type: 'prompt_audit',
    id: `${runId}:audit:${n}`,
    role: 'senior',
    kind: 'consult',
    sections: ['base'],
    tools: ['read_file'],
    systemChars: 1200,
    userChars: 3400,
    at: time,
    runId,
  }
  return entryRow(item, time)
}

function approval(
  id: string,
  runId: string,
  decision: string | undefined = undefined,
  time = 100,
): TimelineEntry {
  const item: ApprovalItem = {
    type: 'approval',
    approvalId: id,
    action: 'write_file',
    target: 'notes.txt',
    command: null,
    at: time,
    runId,
    ...(decision === undefined ? {} : { decision }),
  }
  return entryRow(item, time)
}

function message(id: string): ChatMessage {
  return {
    id,
    seq: 1,
    ts: '2026-01-01T00:00:00.000Z',
    kind: 'message',
    title: null,
    body: 'hello',
    details: [],
    lists: [],
    verdict: null,
    confidencePct: null,
    dissent: null,
    highlight: false,
  }
}

function group(id: string, time = 100): TimelineEntry {
  const chatGroup: ChatGroup = {
    author: 'senior',
    recipient: 'junior',
    startTs: '2026-01-01T00:00:00.000Z',
    messages: [message(id)],
  }
  return entryRow({ type: 'group', group: chatGroup } as ChatItem, time)
}

function divider(seq = 2): TimelineEntry {
  return entryRow({ type: 'divider', seq, label: 'Revision 1 requested' }, 100)
}

function system(id: string): TimelineEntry {
  return entryRow({
    type: 'system',
    activity: { id, seq: 3, ts: '2026-01-01T00:00:00.000Z', label: 'Context compacted' },
  })
}

function entries(rows: ReturnType<typeof buildFoldRows>) {
  return rows.filter((row) => row.type === 'entry')
}

function folds(rows: ReturnType<typeof buildFoldRows>) {
  return rows.filter((row) => row.type === 'fold')
}

// -- entry identity -----------------------------------------------------------

test('foldEntryId is stable for every transcript entry kind', () => {
  assert.equal(foldEntryId(tool('run-a', 1).entry), 'run-a:tool:1')
  assert.equal(foldEntryId(audit('run-a', 2).entry), 'run-a:audit:2')
  assert.equal(foldEntryId(approval('ap-1', 'run-a').entry), 'approval-ap-1')
  assert.equal(foldEntryId(group('msg-1').entry), 'msg-1')
  assert.equal(foldEntryId(divider(7).entry), 'divider-7')
  assert.equal(foldEntryId(system('sys-1').entry), 'sys-1')
})

test('isFoldableEntry only folds tool/audit rows of completed runs', () => {
  assert.equal(isFoldableEntry(tool('old', 1).entry, 'live'), true)
  assert.equal(isFoldableEntry(audit('old', 1).entry), true)
  // the followed run stays open
  assert.equal(isFoldableEntry(tool('live', 1).entry, 'live'), false)
  assert.equal(isFoldableEntry(audit('live', 1).entry, 'live'), false)
  // other kinds and run-less rows never fold
  assert.equal(isFoldableEntry(approval('ap', 'old').entry, 'live'), false)
  assert.equal(isFoldableEntry(group('m').entry, 'live'), false)
  assert.equal(isFoldableEntry(system('s').entry, 'live'), false)
  assert.equal(
    isFoldableEntry({ ...(tool('x', 1).entry as ToolActivityItem), runId: '' } as RuntimeItem, 'live'),
    false,
  )
})

// -- grouping -----------------------------------------------------------------

test('two consecutive completed-run tool rows fold into one summary row', () => {
  const rows = buildFoldRows([tool('old', 1), tool('old', 2)])
  assert.equal(rows.length, 1)
  const fold = rows[0]
  assert.equal(fold.type, 'fold')
  if (fold.type !== 'fold') return
  assert.equal(fold.expanded, false)
  assert.equal(fold.summary.toolCount, 2)
  assert.equal(fold.summary.auditCount, 0)
  assert.equal(fold.summary.runCount, 1)
  assert.equal(fold.summary.rowCount, 2)
  assert.equal(fold.summary.label, '2 tool calls')
})

test('a single tool row is not worth folding and keeps its full card', () => {
  const rows = buildFoldRows([tool('old', 1)])
  assert.equal(folds(rows).length, 0)
  assert.equal(entries(rows).length, 1)
  assert.equal(entries(rows)[0].entry.type, 'tool')
})

test('the followed run stays open while older runs fold', () => {
  const rows = buildFoldRows(
    [tool('old', 1), tool('old', 2), group('g-1'), tool('live', 1), tool('live', 2)],
    { liveRunId: 'live' },
  )
  assert.equal(folds(rows).length, 1)
  assert.equal(folds(rows)[0].type === 'fold' && folds(rows)[0].summary.label, '2 tool calls')
  assert.deepEqual(
    entries(rows).map((row) => (row.type === 'entry' ? row.entry.type : '')),
    ['group', 'tool', 'tool'],
  )
})

test('conversation rows break fold groups and are never folded themselves', () => {
  const rows = buildFoldRows([
    tool('old', 1),
    tool('old', 2),
    group('g-1'),
    system('sys-1'),
    tool('old', 3),
    tool('old', 4),
  ])
  assert.equal(folds(rows).length, 2)
  assert.deepEqual(
    entries(rows).map((row) => (row.type === 'entry' ? row.entry.type : '')),
    ['group', 'system'],
  )
})

test('two run ids in one group are counted honestly in the summary', () => {
  const rows = buildFoldRows([tool('run-a', 1), tool('run-b', 2)])
  assert.equal(rows.length, 1)
  const fold = rows[0]
  if (fold.type !== 'fold') return assert.fail('expected a fold row')
  assert.equal(fold.summary.runCount, 2)
  assert.equal(fold.summary.label, '2 tool calls in 2 runs')
})

test('minRows is configurable, so two rows stay open at a threshold of three', () => {
  const two = buildFoldRows([tool('old', 1), tool('old', 2)], { minRows: 3 })
  assert.equal(folds(two).length, 0)
  assert.equal(entries(two).length, 2)
  const three = buildFoldRows([tool('old', 1), tool('old', 2), tool('old', 3)], { minRows: 3 })
  assert.equal(folds(three).length, 1)
})

// -- hidden rows --------------------------------------------------------------

test('hidden prompt audits neither split a group nor pad the summary', () => {
  const hidden = buildFoldRows([tool('old', 1), audit('old', 1), tool('old', 2)])
  assert.equal(hidden.length, 1)
  const fold = hidden[0]
  if (fold.type !== 'fold') return assert.fail('expected a fold row')
  assert.equal(fold.summary.toolCount, 2)
  assert.equal(fold.summary.auditCount, 0)
  assert.equal(fold.summary.label, '2 tool calls')
})

test('shown prompt audits join the group and expansion restores their rows', () => {
  const shown = buildFoldRows(
    [tool('old', 1), audit('old', 1), tool('old', 2)],
    { showPromptAudits: true, expanded: new Set(['fold:old:tool:1']) },
  )
  assert.equal(shown[0].type, 'fold')
  const fold = shown[0]
  if (fold.type !== 'fold') return assert.fail('expected a fold row')
  assert.equal(fold.expanded, true)
  assert.equal(fold.summary.rowCount, 3)
  assert.equal(fold.summary.toolCount, 2)
  assert.equal(fold.summary.auditCount, 1)
  assert.equal(fold.summary.label, '2 tool calls and 1 prompt audit')
  assert.deepEqual(
    entries(shown).map((row) => (row.type === 'entry' ? row.entry.type : '')),
    ['tool', 'prompt_audit', 'tool'],
  )
})

test('a docked pending approval renders nowhere and does not break the group', () => {
  const rows = buildFoldRows(
    [tool('old', 1), approval('ap-1', 'old'), tool('old', 2)],
    { dockedApprovalId: 'ap-1' },
  )
  assert.equal(rows.length, 1)
  assert.equal(rows[0].type, 'fold')
})

test('a resolved approval is visible history and breaks the group', () => {
  const rows = buildFoldRows([
    tool('old', 1),
    tool('old', 2),
    approval('ap-1', 'old', 'allow'),
    tool('old', 3),
    tool('old', 4),
  ])
  assert.equal(folds(rows).length, 2)
  assert.equal(entries(rows).length, 1)
  assert.equal(entries(rows)[0].type === 'entry' && entries(rows)[0].entry.type, 'approval')
})

// -- expand / collapse --------------------------------------------------------

test('expanding a fold emits the summary row followed by the rows in order', () => {
  const timeline = [tool('old', 1), tool('old', 2), group('g-1')]
  const collapsed = buildFoldRows(timeline)
  assert.deepEqual(collapsed.map((row) => row.type), ['fold', 'entry'])

  const expanded = buildFoldRows(timeline, {
    expanded: new Set(['fold:old:tool:1']),
  })
  assert.deepEqual(expanded.map((row) => row.type), ['fold', 'entry', 'entry', 'entry'])
  const fold = expanded[0]
  assert.equal(fold.type === 'fold' && fold.expanded, true)
  assert.deepEqual(
    entries(expanded).map((row) => (row.type === 'entry' ? row.entry.type : '')),
    ['tool', 'tool', 'group'],
  )
  // the fold row keeps its identity across collapse/expand
  assert.equal(expanded[0].key, collapsed[0].key)
})

test('entry keys are stable, unique and offset-aware', () => {
  const rows = buildFoldRows([group('g-1'), tool('old', 1), tool('old', 2)], {}, 40)
  const keys = rows.map((row) => row.key)
  assert.equal(new Set(keys).size, keys.length)
  assert.deepEqual(keys, ['g-1#40', 'fold:old:tool:1'])
})

// -- summary ------------------------------------------------------------------

test('summarizeFold pluralizes honestly and never invents rows', () => {
  assert.equal(summarizeFold([]).label, 'older activity')
  assert.equal(summarizeFold([]).rowCount, 0)
  assert.equal(summarizeFold([tool('a', 1).entry]).label, '1 tool call')
  assert.equal(summarizeFold([audit('a', 1).entry]).label, '1 prompt audit')
  const mixed = summarizeFold([tool('a', 1).entry, audit('a', 2).entry, audit('a', 3).entry])
  assert.equal(mixed.label, '1 tool call and 2 prompt audits')
  assert.equal(mixed.rowCount, 3)
  assert.equal(mixed.runCount, 1)
})

test('an empty or all-live timeline renders entries only', () => {
  assert.deepEqual(buildFoldRows([]), [])
  const live = buildFoldRows([tool('live', 1), tool('live', 2)], { liveRunId: 'live' })
  assert.equal(folds(live).length, 0)
  assert.equal(entries(live).length, 2)
  // default threshold is exposed for callers that document the rule
  assert.equal(FOLD_MIN_ROWS, 2)
})
