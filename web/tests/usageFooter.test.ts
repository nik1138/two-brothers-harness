/**
 * Focused tests for the web usage footer's cost formatting (wave 24):
 * `~$0.0312 est.` rendering, the tooltip that names the priced model and says
 * the number is an estimate, and honest absence when the backend reports
 * `cost: null` (mixed models / unknown price row).
 *
 * The Vue component imports these pure helpers; no DOM or Vue runtime needed.
 *
 * Run with: node --import ./tests/register-ts.mjs --test tests/usageFooter.test.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { costLabel, costTitle } from '../src/usageCost.ts'
import type { RunCost } from '../src/types.ts'

const GPT4O: RunCost = { currency: 'USD', total: 0.0312, model: 'gpt-4o' }

test('costLabel renders the cli-style four-decimal estimate', () => {
  assert.equal(costLabel(GPT4O), '~$0.0312 est.')
  // four decimals, rounded like the CLI's toFixed(4)
  assert.equal(costLabel({ currency: 'USD', total: 1.23456, model: 'gpt-4o' }), '~$1.2346 est.')
  // a known-priced local model is a real $0 estimate, not an unknown
  assert.equal(costLabel({ currency: 'USD', total: 0, model: 'lfm3-1.7b' }), '~$0.0000 est.')
})

test('costTitle names the model and says it is not a bill', () => {
  assert.equal(
    costTitle(GPT4O),
    'gpt-4o — estimated from token usage; not a bill',
  )
  assert.equal(
    costTitle({ currency: 'USD', total: 0.5, model: '  claude-sonnet-4  ' }),
    'claude-sonnet-4 — estimated from token usage; not a bill',
  )
})

test('null/undefined cost omits the segment entirely', () => {
  assert.equal(costLabel(null), null)
  assert.equal(costLabel(undefined), null)
  assert.equal(costTitle(null), null)
  assert.equal(costTitle(undefined), null)
})

test('App clears the stale estimate before refetching and prunes it on delete', () => {
  // App.vue owns the session-scoped cost state and has no DOM test harness;
  // pin the two lifecycle calls the stale-estimate bug needed.
  const source = readFileSync(fileURLToPath(new URL('../src/App.vue', import.meta.url)), 'utf8')
  const clear = source.indexOf(
    'runCostBySession.value = { ...runCostBySession.value, [entry.session]: null }',
  )
  assert.ok(clear >= 0, 'a finished run must clear the previous cost estimate before refetching')
  // run_end has already installed the new run's usage by this point, so the
  // asynchronous getRun must not be the first thing to touch the old estimate.
  assert.ok(
    source.indexOf('getRun(runId)', clear) > clear,
    'the null clear must precede the getRun(runId) refetch',
  )

  const start = source.indexOf('function onSessionDeleted')
  const end = source.indexOf('async function onCreateSession', start)
  assert.ok(start >= 0 && end > start, 'onSessionDeleted must stay in App.vue')
  const deletion = source.slice(start, end)
  assert.match(
    deletion,
    /const costs = \{ \.\.\.runCostBySession\.value \}\s*delete costs\[name\]\s*runCostBySession\.value = costs/,
    'session deletion must prune runCostBySession alongside the usage counters',
  )
})

test('malformed estimates are withheld instead of rendered as a number', () => {
  const malformed = (value: unknown): RunCost => value as RunCost
  assert.equal(costLabel(malformed({ currency: 'EUR', total: 1, model: 'gpt-4o' })), null)
  assert.equal(costLabel(malformed({ currency: 'USD', total: Number.NaN, model: 'gpt-4o' })), null)
  assert.equal(costLabel(malformed({ currency: 'USD', total: -0.01, model: 'gpt-4o' })), null)
  assert.equal(costLabel(malformed({ currency: 'USD', total: 1, model: '' })), null)
  // no model means the estimate cannot be attributed — hide it, never guess
  assert.equal(costTitle(malformed({ currency: 'USD', total: 1, model: '' })), null)
})
