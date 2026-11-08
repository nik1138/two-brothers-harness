/**
 * Unit tests for the pure run-undo client model (`web/src/runUndo.ts`): the
 * preview statuses, counts, sort order, apply summary (refused files are never
 * folded into the success count) and failure copy. No DOM, no backend.
 *
 * Run with: node --import ./tests/register-ts.mjs --test tests/runUndo.test.ts
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  UNDO_ACTION_LABEL,
  UNDO_PREVIEW_STATUSES,
  canApplyUndo,
  isReversibleStatus,
  normalizeUndoApplyResult,
  normalizeUndoPreview,
  sortUndoEntries,
  summarizeUndoPreview,
  undoActionHint,
  undoAppliedLabel,
  undoApplyEntries,
  undoApplyNotice,
  undoConfirmation,
  undoEntryAction,
  undoFailureNotice,
  undoPreviewEntries,
  undoPreviewNotice,
  undoStatusLabel,
  undoStatusReason,
  undoUnavailableNotice,
} from '../src/runUndo'
import type { RunUndoApplyResult, RunUndoPreview, RunUndoPreviewEntry } from '../src/runUndo'

function entry(
  path: string,
  status: RunUndoPreviewEntry['status'],
  overrides: Partial<RunUndoPreviewEntry> = {},
): RunUndoPreviewEntry {
  return {
    path,
    action: overrides.action ?? 'edit',
    status,
    reversible: isReversibleStatus(status),
    ...overrides,
  }
}

const PREVIEW: RunUndoPreview = {
  run_id: 'run-1',
  workspace_root: '/work',
  entries: [
    entry('src/app.ts', 'applicable'),
    entry('src/new.ts', 'created'),
    entry('src/gone.ts', 'deleted'),
    entry('src/changed.ts', 'changed-since'),
    entry('big.bin', 'skipped'),
    entry('lost.ts', 'missing'),
  ],
  counts: { applicable: 1, created: 1, deleted: 1, changed_since: 1, skipped: 1, missing: 1, total: 6 },
}

test('the preview vocabulary is the documented six statuses', () => {
  assert.deepEqual([...UNDO_PREVIEW_STATUSES], [
    'applicable',
    'created',
    'deleted',
    'changed-since',
    'skipped',
    'missing',
  ])
  for (const status of ['applicable', 'created', 'deleted']) {
    assert.equal(isReversibleStatus(status), true, status)
  }
  for (const status of ['changed-since', 'skipped', 'missing', 'nope', '', null, undefined]) {
    assert.equal(isReversibleStatus(status), false, String(status))
  }
})

test('every status has honest operator copy (no raw backend tokens)', () => {
  assert.match(undoStatusLabel('applicable'), /restored/)
  assert.match(undoStatusLabel('created'), /deleted \(created by the run\)/)
  assert.match(undoStatusLabel('deleted'), /restored \(deleted by the run\)/)
  assert.match(undoStatusLabel('changed-since'), /changed since the run/)
  assert.match(undoStatusLabel('skipped'), /not captured/)
  assert.match(undoStatusLabel('missing'), /saved copy is missing/)
  assert.equal(undoStatusLabel('weird'), 'unknown state')
  for (const status of UNDO_PREVIEW_STATUSES) {
    assert.doesNotMatch(undoStatusLabel(status), new RegExp(`^${status}$`))
  }

  // the server's per-file reason wins; the fallbacks explain the refusal
  assert.equal(
    undoStatusReason({ status: 'changed-since', reason: 'edited after the run' }),
    'edited after the run',
  )
  assert.match(undoStatusReason({ status: 'changed-since' }), /was not touched/)
  assert.match(undoStatusReason({ status: 'skipped' }), /size or count bound/)
  assert.match(undoStatusReason({ status: 'missing' }), /absent or corrupt/)
  assert.equal(undoStatusReason({ status: 'applicable' }), '')

  assert.match(undoEntryAction('created', 'write'), /Delete the file the run created/)
  assert.match(undoEntryAction('deleted', 'delete'), /Restore the file the run deleted/)
  assert.match(undoEntryAction('applicable', 'edit'), /Restore the earlier file content/)
})

test('preview counting separates reversible files from refusals', () => {
  const summary = summarizeUndoPreview(PREVIEW)
  assert.equal(summary.reversible, 3)
  assert.equal(summary.refused, 3)
  assert.equal(summary.total, 6)
  assert.deepEqual(summary.byStatus, {
    applicable: 1,
    created: 1,
    deleted: 1,
    'changed-since': 1,
    skipped: 1,
    missing: 1,
  })
  assert.equal(canApplyUndo(PREVIEW), true)
  assert.equal(canApplyUndo({ entries: [entry('a', 'changed-since')] }), false)
  assert.equal(canApplyUndo(null), false)
  assert.equal(summarizeUndoPreview(null).total, 0)
})

test('preview copy states the honest split and repeats the capture note', () => {
  const notice = undoPreviewNotice(PREVIEW)
  assert.match(notice, /^3 of 6 recorded files can be undone now/)
  assert.match(notice, /3 will be refused/)

  const withOmitted = undoPreviewNotice({
    entries: [entry('a', 'applicable')],
    omitted: { entries: 2, reason: 'run entry cap of 64 reached' },
  })
  assert.match(withOmitted, /2 further changes were not captured \(run entry cap of 64 reached\)/)
  assert.equal(
    undoPreviewNotice({ entries: [] }),
    'This run recorded no file changes to undo.',
  )

  const body = undoConfirmation(PREVIEW)
  assert.match(body, /3 files will be restored or deleted/)
  assert.match(body, /3 will be left untouched/)
  assert.match(body, /each row says why/)
  assert.match(body, /Nothing outside the run's recorded files is touched/)
})

test('apply summary never reports a refused file as undone', () => {
  const notice = undoApplyNotice({
    applied: 2,
    refused: 1,
    failed: 1,
    entries: [],
  })
  assert.match(notice, /Undo applied: 2 files restored, 1 refused, 1 failed\./)
  assert.doesNotMatch(notice, /3 files restored/)

  assert.match(
    undoApplyNotice({ applied: 0, refused: 2, failed: 0, entries: [] }),
    /without applying any file: 0 files restored, 2 refused/,
  )
  assert.match(undoApplyNotice({ applied: 1, refused: 0, failed: 0, entries: [] }), /1 file restored/)
  const withOmitted = undoApplyNotice({
    applied: 1,
    refused: 0,
    failed: 0,
    entries: [],
    omitted: { entries: 1, reason: 'byte budget reached' },
  })
  assert.match(withOmitted, /1 further change was not captured \(byte budget reached\)/)
  assert.equal(undoApplyNotice(null), 'Undo finished.')
  assert.match(
    undoApplyNotice({ applied: 0, refused: 0, failed: 0, entries: [] }),
    /no files were changed/,
  )
})

test('per-file apply labels say what actually happened', () => {
  assert.equal(
    undoAppliedLabel({ path: 'a', action: 'edit', status: 'applied', preview_status: 'applicable' }),
    'restored',
  )
  assert.equal(
    undoAppliedLabel({ path: 'a', action: 'write', status: 'applied', preview_status: 'created' }),
    'deleted',
  )
  assert.equal(
    undoAppliedLabel({ path: 'a', action: 'edit', status: 'refused', preview_status: 'changed-since' }),
    'refused',
  )
  assert.equal(
    undoAppliedLabel({ path: 'a', action: 'edit', status: 'failed', preview_status: 'applicable' }),
    'failed',
  )
  assert.equal(undoAppliedLabel(null), 'unknown')
})

test('preview rows sort actionable first, then by path', () => {
  const sorted = sortUndoEntries([
    entry('z-refused.ts', 'missing'),
    entry('b-applicable.ts', 'applicable'),
    entry('a-created.ts', 'created'),
    entry('m-changed.ts', 'changed-since'),
    entry('c-refused.ts', 'skipped'),
  ])
  assert.deepEqual(
    sorted.map((row) => row.path),
    ['b-applicable.ts', 'a-created.ts', 'm-changed.ts', 'c-refused.ts', 'z-refused.ts'],
  )
  assert.deepEqual(sortUndoEntries(null), [])
})

test('failure copy maps the documented route contract honestly', () => {
  assert.match(undoFailureNotice({ status: 0 }), /unreachable/)
  assert.match(undoFailureNotice({ status: 404 }), /recorded no file changes/)
  assert.equal(
    undoFailureNotice({ status: 409, detail: 'workspace root mismatch' }),
    'workspace root mismatch',
  )
  assert.match(undoFailureNotice({ status: 409 }), /does not match this workspace/)
  assert.match(undoFailureNotice({ status: 400 }), /undo request was rejected/)
  assert.match(undoFailureNotice({ status: 500 }), /HTTP 500/)
})

test('the run-specific action copy is honest about an unknown workspace link', () => {
  assert.equal(UNDO_ACTION_LABEL, 'Undo file changes…')
  const known = undoActionHint(true)
  assert.match(known, /Restores the files this run changed/)
  assert.match(known, /changed since the run are refused/)
  assert.doesNotMatch(known, /Preview the files/)
  // Without a known workspace link the action still exists, but it does not
  // claim knowledge: the preview reports whether files were changed.
  const unknown = undoActionHint(false)
  assert.match(unknown, /^Preview the files this run changed \(if any\)/)
  assert.match(unknown, /changed since the run are refused/)
  assert.match(undoUnavailableNotice(), /No file undo is available for this run/)
  assert.match(undoUnavailableNotice(), /does not support file undo/)
})

test('the approved `statuses`/`files` fields and the tolerant aliases read the same', () => {
  const approved: RunUndoPreview = {
    session: 'chat.jsonl',
    run_id: 'run-1',
    workspace_root: '/work',
    statuses: [entry('src/app.ts', 'applicable'), entry('big.bin', 'skipped')],
    counts: { applicable: 1, skipped: 1, total: 2 },
  }
  const alias: RunUndoPreview = {
    session: 'chat.jsonl',
    run_id: 'run-1',
    entries: [entry('src/app.ts', 'applicable'), entry('big.bin', 'skipped')],
  }
  assert.equal(undoPreviewEntries(approved).length, 2)
  assert.deepEqual(undoPreviewEntries(approved), undoPreviewEntries(alias))
  assert.equal(summarizeUndoPreview(approved).reversible, 1)
  assert.equal(summarizeUndoPreview(alias).reversible, 1)
  assert.deepEqual(undoPreviewEntries(null), [])

  const applyApproved: RunUndoApplyResult = {
    applied: 1,
    refused: 1,
    failed: 0,
    files: [
      { path: 'a', action: 'edit', status: 'applied', preview_status: 'applicable' },
      { path: 'b', action: 'edit', status: 'refused', preview_status: 'changed-since' },
    ],
  }
  const applyAlias: RunUndoApplyResult = {
    applied: 1,
    refused: 1,
    failed: 0,
    entries: applyApproved.files,
  }
  assert.equal(undoApplyEntries(applyApproved).length, 2)
  assert.deepEqual(undoApplyEntries(applyApproved), undoApplyEntries(applyAlias))
  assert.match(undoApplyNotice(applyApproved), /1 file restored, 1 refused/)
})

test('normalizeUndoPreview tolerantly maps the approved session-scoped response', () => {
  const raw = {
    session: 'chat.jsonl',
    run_id: 'run-1',
    workspace_root: 'C:\\work',
    created_at: '2026-11-08T09:00:00.000Z',
    statuses: [
      { path: 'src/app.ts', action: 'edit', status: 'applicable', reversible: true },
      { path: 'new.ts', action: 'write', status: 'created', reversible: true },
      { path: 'x.ts', action: 'edit', status: 'changed-since', reason: 'edited later', reversible: false },
      { path: 42, action: 'edit', status: 'applicable' },
      { path: 'bad-status.ts', action: 'edit', status: 'weird' },
    ],
    counts: { applicable: 1, created: 1, changed_since: 1, skipped: 0, total: 3, bogus: 'x' },
    omitted: { entries: 2, reason: 'run entry cap of 64 reached' },
  }
  const preview = normalizeUndoPreview(raw)!
  assert.equal(preview.session, 'chat.jsonl')
  assert.equal(preview.run_id, 'run-1')
  assert.equal(preview.workspace_root, 'C:\\work')
  assert.equal(preview.created_at, '2026-11-08T09:00:00.000Z')
  assert.equal(preview.statuses!.length, 4, 'malformed path row dropped, unknown status kept inert')
  assert.deepEqual(preview.counts, { applicable: 1, created: 1, changed_since: 1, skipped: 0, total: 3 })
  assert.deepEqual(preview.omitted, { entries: 2, reason: 'run entry cap of 64 reached' })
  const summary = summarizeUndoPreview(preview)
  assert.equal(summary.total, 4)
  assert.equal(summary.reversible, 2)
  assert.equal(summary.refused, 2)

  // Non-objects and garbage never throw; an empty document is a valid preview.
  assert.equal(normalizeUndoPreview(null), null)
  assert.equal(normalizeUndoPreview('nope'), null)
  assert.deepEqual(normalizeUndoPreview({}), { statuses: [] })
})

test('normalizeUndoApplyResult tolerantly maps the approved apply response', () => {
  const result = normalizeUndoApplyResult({
    session: 'chat.jsonl',
    run_id: 'run-1',
    workspace_root: '/work',
    applied: 2,
    refused: 1,
    failed: 1,
    files: [
      { path: 'a.ts', action: 'edit', status: 'applied', preview_status: 'applicable' },
      { path: 'b.ts', action: 'write', status: 'applied', preview_status: 'created' },
      { path: 'c.ts', action: 'edit', status: 'refused', preview_status: 'changed-since', reason: 'edited' },
      { path: 'd.ts', action: 'edit', status: 'failed', preview_status: 'applicable', reason: 'EACCES' },
    ],
    counts: { applicable: 3, created: 1, changed_since: 1, total: 4 },
  })!
  assert.equal(result.applied, 2)
  assert.equal(result.refused, 1)
  assert.equal(result.failed, 1)
  assert.equal(result.files!.length, 4)
  assert.equal(result.files![2]!.reason, 'edited')
  assert.equal(normalizeUndoApplyResult(null), null)
  assert.equal(normalizeUndoApplyResult({})!.applied, 0)
})
