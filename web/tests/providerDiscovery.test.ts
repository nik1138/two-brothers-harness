// Focused tests for the discovered-model pickers in src/providerSettings.ts —
// the pure selection/filter rules shared by the detail "Refresh models" card and
// the Add-provider "Fetch models" card. No DOM:
//   node --import ./tests/register-ts.mjs --test tests/providerDiscovery.test.ts

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  MODEL_FILTER_THRESHOLD,
  appendSelectedReportedModels,
  defaultAddModelSelection,
  filterModelIds,
  hasAddableReportedModels,
  selectAllModels,
  selectedReportedAdditions,
  toggleModelSelection,
} from '../src/providerSettings'

const REPORTED = [
  'e2e-a1',
  'e2e-a2',
  'e2e-a3',
  'e2e-b1',
  'e2e-b2',
  'e2e-b3',
  'e2e-b4',
  'e2e-b5',
  'e2e-b6',
  'e2e-b7',
]

test('defaultAddModelSelection: a fetch never preselects anything', () => {
  assert.deepEqual(defaultAddModelSelection(REPORTED), [])
  assert.deepEqual(defaultAddModelSelection([{ id: 'm1' }, ' m2 ', 'm1']), [])
  assert.deepEqual(defaultAddModelSelection([]), [])
  assert.deepEqual(defaultAddModelSelection(null), [])
})

test('toggleModelSelection adds/removes one id without disturbing order', () => {
  assert.deepEqual(toggleModelSelection([], 'a'), ['a'])
  assert.deepEqual(toggleModelSelection(['a', 'b'], 'c'), ['a', 'b', 'c'])
  assert.deepEqual(toggleModelSelection(['a', 'b'], 'b'), ['a'])
  assert.deepEqual(toggleModelSelection([], ' a '), ['a'], 'ids are trimmed')
  assert.deepEqual(toggleModelSelection(['a'], ''), ['a'], 'empty id is a no-op')
  assert.deepEqual(toggleModelSelection([' a ', '', 'a'], 'b'), ['a', 'b'], 'stale input is cleaned')
})

test('filterModelIds: case-insensitive substring, order preserved, blank = all', () => {
  const ids = ['llama-3.1-8b', 'Qwen2.5-Coder', 'mistral-7b', 'qwen2.5-vl']
  assert.deepEqual(filterModelIds(ids, 'QWEN'), ['Qwen2.5-Coder', 'qwen2.5-vl'])
  assert.deepEqual(filterModelIds(ids, '  coder '), ['Qwen2.5-Coder'], 'the query is trimmed')
  assert.deepEqual(filterModelIds(ids, ''), ids, 'blank query shows every row')
  assert.deepEqual(filterModelIds(ids, '   '), ids)
  assert.deepEqual(filterModelIds(ids, 'zzz'), [], 'a non-matching query hides every row')
  assert.deepEqual(filterModelIds(null, 'x'), [])
  assert.deepEqual(filterModelIds([{ id: 'A-B' }, 'a-b'], 'a-b'), ['A-B', 'a-b'])
})

test('model filters stay opt-in past the threshold', () => {
  // The pickers show the filter only when the reported list is longer than
  // MODEL_FILTER_THRESHOLD; the constant itself is part of the contract.
  assert.equal(MODEL_FILTER_THRESHOLD, 8)
  assert.equal(REPORTED.length > MODEL_FILTER_THRESHOLD, true)
})

test('selectAllModels: Select all unions the visible rows only', () => {
  const visible = filterModelIds(REPORTED, '-a')
  assert.deepEqual(visible, ['e2e-a1', 'e2e-a2', 'e2e-a3'])
  assert.deepEqual(selectAllModels([], visible), visible, 'an empty selection takes the visible ids')
  assert.deepEqual(
    selectAllModels(['hidden', 'e2e-a2'], visible),
    ['hidden', 'e2e-a2', 'e2e-a1', 'e2e-a3'],
    'hidden selections survive and visible ids are added once',
  )
  assert.deepEqual(selectAllModels(visible, visible), visible, 'no duplicates on a repeated select')
  assert.deepEqual(selectAllModels(['keep'], []), ['keep'], 'no visible rows is a no-op')
})

test('add-only-selected-and-new appends in reported order, skipping existing ids', () => {
  assert.deepEqual(
    appendSelectedReportedModels(['manual'], ['a', 'b', 'c'], ['c', 'a']),
    ['manual', 'a', 'c'],
    'draft order is kept and checked ids follow in reported order',
  )
  assert.deepEqual(
    appendSelectedReportedModels(['a', 'manual'], ['a', 'b'], ['a', 'b']),
    ['a', 'manual', 'b'],
    'an existing id is never duplicated',
  )
  assert.deepEqual(appendSelectedReportedModels([], ['a', 'b'], []), [], 'nothing checked adds nothing')
  assert.deepEqual(
    appendSelectedReportedModels(['a'], ['a'], ['a']),
    ['a'],
    'checking an id already in the draft leaves the list unchanged',
  )
  assert.deepEqual(
    appendSelectedReportedModels([' a '], ['b'], ['b', 'not-reported']),
    ['a', 'b'],
    'unreported/stale ids are ignored',
  )
})

test('clear: an empty selection adds nothing and stays out of the count', () => {
  // Clear resets the picker's selection; the pure rules must then add and
  // count nothing even while the reported ids remain available.
  assert.deepEqual(selectedReportedAdditions(['saved'], REPORTED, []), [])
  assert.deepEqual(appendSelectedReportedModels(['saved'], REPORTED, []), ['saved'])
  assert.deepEqual(selectAllModels([], []), [])
})

test('already-in-draft rows are excluded from the add count and the action', () => {
  // e2e-a1/e2e-a2 are saved in the draft; only the other ids are addable.
  const current = ['e2e-a1', 'e2e-a2']
  assert.deepEqual(selectedReportedAdditions(current, REPORTED, ['e2e-a1', 'e2e-a3']), [
    'e2e-a3',
  ])
  assert.deepEqual(
    selectedReportedAdditions(current, REPORTED, ['e2e-a1', 'e2e-a2']),
    [],
    'in-draft ids never count even when checked',
  )
  assert.deepEqual(selectedReportedAdditions([], ['a', 'b'], ['b', 'a']), ['a', 'b'])
  assert.deepEqual(selectedReportedAdditions([], ['a', 'b'], ['not-reported']), [])
  assert.deepEqual(selectedReportedAdditions([], ['a'], []), [])

  assert.equal(hasAddableReportedModels(current, REPORTED), true)
  assert.equal(hasAddableReportedModels(['a', 'b'], ['a', 'b']), false, 'all reported are in draft')
  assert.equal(hasAddableReportedModels([], []), false, 'an empty report has nothing to add')
  assert.equal(hasAddableReportedModels(['a'], ['a', 'b']), true)
})
