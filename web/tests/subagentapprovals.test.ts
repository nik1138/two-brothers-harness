/**
 * Child-tagged approvals in the web shell: the runtime projection of the
 * additive `subagent_id`/`subagent_label` fields, the approval card's helper
 * row/aria label (old-backend fail-soft), and the child tree wait clearing on
 * resolution. Source assertions only where .vue templating needs the build:
 *   node --import ./tests/register-ts.mjs --test tests/subagentapprovals.test.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { projectRuntimeEvents } from '../src/runtime.ts'
import { applySubagentApprovalEvent } from '../src/subagents.ts'
import type { RunEvent, SubagentInfo } from '../src/types.ts'

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/${relative}`, import.meta.url)), 'utf8')

function requested(overrides: Record<string, unknown> = {}): RunEvent {
  return {
    type: 'approval_requested',
    approval_id: 'approval-1',
    action: 'write',
    target: 'e2e-helper.txt',
    run_id: 'run-1',
    at: 10,
    ...overrides,
  } as RunEvent
}

function resolved(overrides: Record<string, unknown> = {}): RunEvent {
  return {
    type: 'approval_resolved',
    approval_id: 'approval-1',
    decision: 'allow',
    run_id: 'run-1',
    at: 11,
    ...overrides,
  } as RunEvent
}

function childRow(overrides: Partial<SubagentInfo> = {}): SubagentInfo {
  return {
    id: 'sub-12345678',
    parent_session: 'parent.jsonl',
    label: 'Write the helper file',
    role: 'junior',
    model: 'e2e-helper',
    task: 'Write e2e-helper.txt.',
    status: 'running',
    started_at: 1_000,
    last_activity: null,
    usage: null,
    result: null,
    error: null,
    ...overrides,
  }
}

test('the runtime projection carries child identity on an approval item', () => {
  const items = projectRuntimeEvents([
    requested({
      subagent_id: 'sub-12345678',
      subagent_label: 'Write the helper file',
    }),
  ])
  assert.equal(items.length, 1)
  const item = items[0]
  assert.ok(item?.type === 'approval')
  assert.equal(item.subagentId, 'sub-12345678')
  assert.equal(item.subagentLabel, 'Write the helper file')
  assert.equal(item.action, 'write')
  assert.equal(item.target, 'e2e-helper.txt')
})

test('an old backend / brother request projects exactly as before', () => {
  const items = projectRuntimeEvents([requested()])
  const item = items[0]
  assert.ok(item?.type === 'approval')
  assert.equal('subagentId' in item, false)
  assert.equal('subagentLabel' in item, false)
  // Malformed child fields are ignored (the card stays byte-identical).
  const malformed = projectRuntimeEvents([
    requested({ subagent_id: 42, subagent_label: '   ' }),
  ])
  const broken = malformed[0]
  assert.ok(broken?.type === 'approval')
  assert.equal('subagentId' in broken, false)
  assert.equal('subagentLabel' in broken, false)
})

test('the approval card shows the helper only when the backend sends it', () => {
  const card = read('components/ApprovalCard.vue')
  assert.ok(card.includes('item.subagentLabel'))
  assert.ok(card.includes('by helper'))
  assert.ok(card.includes('Requested by an isolated helper on behalf of the Senior.'))
  assert.equal(/v-html\s*=/.test(card), false, 'the helper label is plain text')
  // The decision surface is unchanged: the same three answers, no new button.
  assert.ok(card.includes('Allow once'))
  assert.ok(card.includes('Deny'))
  assert.ok(card.includes('Always allow this session'))
})

test('a child approval_resolved clears the tree wait', () => {
  const waiting = applySubagentApprovalEvent(
    [childRow()],
    requested({ subagent_id: 'sub-12345678', subagent_label: 'Write the helper file' }),
  )
  assert.equal(waiting[0]?.last_activity?.status, 'awaiting_approval')
  const resumed = applySubagentApprovalEvent(
    waiting,
    resolved({ subagent_id: 'sub-12345678' }),
  )
  assert.equal(resumed[0]?.status, 'running')
  assert.equal(resumed[0]?.last_activity?.status, 'running')
  // A brother approval or an unknown child never touches the tree.
  const tree = [childRow()]
  assert.equal(applySubagentApprovalEvent(tree, requested()), tree)
  assert.equal(
    applySubagentApprovalEvent(tree, resolved({ subagent_id: 'sub-other' })),
    tree,
  )
})
