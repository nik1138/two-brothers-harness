/**
 * Web per-role usage projection (feat/usage-surfaces, additive).
 *
 * The backend reports Senior/Junior usage three ways: the `call_usage` runtime
 * frames while a run works, the additive `usage_by_role` on `run_end`, and the
 * same field on the run record. This suite pins the web's pure projection
 * (tolerant normalize, incremental fold, replay) and the render-ready rows the
 * usage footer and the `/status` dialog share — including the honest absence
 * path: no split means today's merged-only display, never a fabricated row.
 *
 * The component assertions are source-level: the Vue components have no DOM
 * test harness here, and `npm run build` (vue-tsc) is their template gate.
 *
 * Run with: node --import ./tests/register-ts.mjs --test tests/usageByRole.test.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  addCallUsage,
  normalizeRunUsage,
  normalizeUsageByRole,
  roleUsageView,
  roleUsageViews,
  usageByRoleFromEvents,
} from '../src/usageByRole.ts'
import type { RunCostByRole, RunEvent, RunUsage, RunUsageByRole } from '../src/types.ts'

const SENIOR: RunUsage = {
  model_calls: 2,
  input_tokens: 1200,
  output_tokens: 340,
  cached_tokens: 500,
  cache_write_tokens: 60,
}
const JUNIOR: RunUsage = {
  model_calls: 1,
  input_tokens: 800,
  output_tokens: 120,
  cached_tokens: 0,
}

function callUsageEvent(
  runId: string,
  role: 'senior' | 'junior',
  usage: Partial<RunUsage>,
): RunEvent {
  return {
    type: 'call_usage',
    role,
    kind: 'consult',
    usage: usage as RunUsage,
    run_id: runId,
    at: 1,
  } as RunEvent
}

test('normalizeUsageByRole accepts a real split and omits an absent one', () => {
  assert.equal(normalizeUsageByRole(undefined), null)
  assert.equal(normalizeUsageByRole(null), null)
  assert.equal(normalizeUsageByRole({ senior: 'x', junior: 3 }), null)
  const split = normalizeUsageByRole({ senior: SENIOR, junior: JUNIOR })
  assert.ok(split)
  assert.deepEqual(split.senior, SENIOR)
  assert.deepEqual(split.junior, JUNIOR)
  // a partial wire value fills the missing half with zeros (the backend's own
  // convention), it does not fabricate a role row — the renderer filters those
  const partial = normalizeUsageByRole({ senior: { model_calls: 1, input_tokens: 5 } })
  assert.ok(partial)
  assert.equal(partial.senior.model_calls, 1)
  assert.equal(partial.junior.model_calls, 0)
})

test('normalizeRunUsage is tolerant and keeps omitted optional counters absent', () => {
  const usage = normalizeRunUsage({
    model_calls: '2',
    input_tokens: 'nope',
    output_tokens: 4,
    cached_tokens: -1,
  } as unknown as RunUsage)
  assert.equal(usage.model_calls, 2)
  assert.equal(usage.input_tokens, 0)
  assert.equal(usage.output_tokens, 4)
  assert.equal(usage.cached_tokens, -1)
  // OpenAI-compatible runs omit prompt_tokens; only Anthropic bills writes
  assert.equal('prompt_tokens' in usage, false)
  assert.equal('cache_write_tokens' in usage, false)
  assert.equal(normalizeRunUsage({ prompt_tokens: 7, cache_write_tokens: 3 } as RunUsage).prompt_tokens, 7)
})

test('addCallUsage folds one frame per role into a fresh split', () => {
  const first = addCallUsage(null, 'senior', { model_calls: 1, input_tokens: 10 })
  assert.ok(first)
  // a role with no frame yet is a zero half, never rendered (see roleUsageViews)
  assert.equal(first.junior.model_calls, 0)
  const second = addCallUsage(first, 'junior', { model_calls: 2, output_tokens: 6 })
  assert.ok(second)
  assert.equal(second.senior.input_tokens, 10)
  assert.equal(second.junior.output_tokens, 6)
  // pure: the previous value is not mutated
  assert.equal(first.junior.output_tokens, 0)
  // an unknown role or malformed payload leaves the value untouched
  assert.equal(addCallUsage(second, 'helper', { model_calls: 9 }), second)
  assert.equal(addCallUsage(second, 'senior', null), second)
  // prompt_tokens accumulates only when the frame reported it
  const summed = addCallUsage(second, 'senior', { model_calls: 1, prompt_tokens: 100 })
  assert.ok(summed)
  assert.equal(summed.senior.prompt_tokens, 100)
  assert.equal('prompt_tokens' in second.senior, false)
})

test('usageByRoleFromEvents replays only call_usage frames', () => {
  assert.equal(usageByRoleFromEvents([]), null)
  const split = usageByRoleFromEvents([
    { type: 'run_status', status: 'running', run_id: 'r', at: 1 } as RunEvent,
    callUsageEvent('r', 'senior', { model_calls: 1, input_tokens: 10 }),
    { type: 'run_error', message: 'nope', run_id: 'r', at: 2 } as RunEvent,
    callUsageEvent('r', 'junior', { model_calls: 1, input_tokens: 4 }),
  ])
  assert.ok(split)
  assert.equal(split.senior.model_calls, 1)
  assert.equal(split.senior.input_tokens, 10)
  assert.equal(split.junior.model_calls, 1)
  assert.equal(split.junior.input_tokens, 4)
})

test('roleUsageViews renders measured roles only, Senior first', () => {
  const split: RunUsageByRole = { senior: SENIOR, junior: JUNIOR }
  const rows = roleUsageViews(split)
  assert.equal(rows.length, 2)
  assert.deepEqual(
    rows.map((row) => row.label),
    ['Senior', 'Junior'],
  )
  assert.equal(rows[0].tokens, 'in 1,200 / out 340 tok')
  assert.equal(rows[0].cache, 'cache 42%')
  assert.equal(rows[0].cacheTitle, 'cached 500 of 1,200 prompt tokens')
  // Derived display, never a wire field: 1,200 prompt - 500 cache reads.
  assert.equal(rows[0].miss, 'miss 700 tok')
  assert.equal(rows[0].write, 'write 60 tok')
  // junior: a measured 0% is shown, no miss/write segment when nothing read/billed
  assert.equal(rows[1].cache, 'cache 0%')
  assert.equal(rows[1].miss, null)
  assert.equal(rows[1].write, null)

  // A fully cached role honestly reports a zero miss.
  const fullyCached = roleUsageView('senior', { ...SENIOR, cached_tokens: 1200 })
  assert.ok(fullyCached)
  assert.equal(fullyCached.miss, 'miss 0 tok')

  // a role that answered no call gets no row; no split = no rows at all
  const solo = roleUsageViews({
    senior: { ...SENIOR, model_calls: 0 },
    junior: JUNIOR,
  })
  assert.deepEqual(
    solo.map((row) => row.role),
    ['junior'],
  )
  assert.deepEqual(roleUsageViews(null), [])
  assert.deepEqual(roleUsageViews(undefined), [])
  // an unusable cache denominator honestly omits the cache segment
  const noPrompt = roleUsageView('senior', { ...SENIOR, input_tokens: 0, cached_tokens: 0 })
  assert.ok(noPrompt)
  assert.equal(noPrompt.cache, null)
  assert.equal(noPrompt.cacheTitle, null)
  assert.equal(noPrompt.miss, null)
})

test('the derived cache-miss segment is prompt minus cache reads', () => {
  // The family-normalized prompt total is the denominator (Anthropic reports
  // uncached input only and sends prompt_tokens), so 100 - 40 = 60.
  const anthropic = roleUsageView('senior', {
    model_calls: 1,
    input_tokens: 60,
    prompt_tokens: 100,
    output_tokens: 10,
    cached_tokens: 40,
    cache_write_tokens: 0,
  })
  assert.ok(anthropic)
  assert.equal(anthropic.cache, 'cache 40%')
  assert.equal(anthropic.miss, 'miss 60 tok')
  // A role that recorded no cache read shows no miss segment at all, so a
  // cache-free row keeps its historical bytes.
  const noCache = roleUsageView('junior', JUNIOR)
  assert.ok(noCache)
  assert.equal(noCache.cache, 'cache 0%')
  assert.equal(noCache.miss, null)
})

test('the UsageFooter renders the split on its own line and degrades to merged-only', () => {
  const footer = readFileSync(
    fileURLToPath(new URL('../src/components/UsageFooter.vue', import.meta.url)),
    'utf8',
  )
  assert.match(footer, /v-if="roleRows\.length > 0"/, 'the split block is conditional')
  assert.match(footer, /v-for="row in roleRows"/, 'one row per measured role')
  assert.match(footer, /class="usage-roles"/, 'the split rides its own footer line')
  assert.match(footer, /v-if="row\.miss !== null"/, 'the derived miss segment is conditional')
  assert.match(footer, /\{\{ row\.miss \}\}/, 'the row renders the derived miss count')
  // Drawer-width viewports keep the merged counters: growing the footer while a
  // run streams/ends shifts the transcript viewport under a parked reader.
  assert.match(
    footer,
    /@media \(max-width: 768px\) \{\s*\.usage-roles \{\s*display: none;/,
    'the split rows are hidden below the drawer breakpoint',
  )
  // absent rows must not render any role label
  assert.ok(!/Senior<\/span>/.test(footer), 'the label comes from the projection, not a constant')
})

test('the SessionStatusDialog renders a row per measured role', () => {
  const dialog = readFileSync(
    fileURLToPath(new URL('../src/components/SessionStatusDialog.vue', import.meta.url)),
    'utf8',
  )
  assert.match(dialog, /v-for="row in roleRows"/, 'one row per measured role')
  assert.match(dialog, /\{\{ row\.label \}\} usage/, 'the row names its role')
  assert.match(dialog, /v-if="row\.miss !== null"/, 'the derived miss segment is conditional')
  assert.match(dialog, /roleUsages\?: RoleUsageView\[\]/, 'the split prop is additive/optional')
})

test('App folds live call_usage frames and replaces them with the terminal split', () => {
  const app = readFileSync(fileURLToPath(new URL('../src/App.vue', import.meta.url)), 'utf8')
  assert.match(app, /case 'call_usage':/, 'live call_usage frames are handled')
  assert.match(app, /addCallUsage\(/, 'the live split is folded incrementally')
  assert.match(
    app,
    /normalizeUsageByRole\(data\.usage_by_role\)/,
    'run_end replaces the accumulator with the authoritative split (null when absent)',
  )
  assert.match(
    app,
    /normalizeUsageByRole\(rec\.usage_by_role\)/,
    'the finished run record is authoritative after the stream',
  )
  assert.equal(
    (app.match(/:role-usages="roleUsagesForSelected"/g) ?? []).length,
    2,
    'both the footer and the status dialog receive the split',
  )
  assert.match(app, /delete splits\[name\]/, 'session deletion prunes the split')
})

// ---------------------------------------------------------------------------
// additive per-role cost (`feat/role-cost-surfaces`)
// ---------------------------------------------------------------------------

test('normalizeUsageByRole carries the additive identity and drops junk', () => {
  const split = normalizeUsageByRole({
    senior: { ...SENIOR, model: '  gpt-4o  ', family: 'anthropic' },
    junior: { ...JUNIOR, model: '   ', family: 'bogus' },
  })
  assert.ok(split)
  assert.equal(split.senior.model, 'gpt-4o', 'the identity is trimmed, never re-derived')
  assert.equal(split.senior.family, 'anthropic')
  assert.equal('model' in split.junior, false, 'a blank model stays absent')
  assert.equal('family' in split.junior, false, 'an unknown family stays absent')
  // Old data without identity still normalizes to plain counters.
  const old = normalizeUsageByRole({ senior: SENIOR, junior: JUNIOR })
  assert.ok(old)
  assert.equal('model' in old.senior, false)
})

test('roleUsageViews appends each priced half cost and omits unknown ones', () => {
  const split: RunUsageByRole = { senior: SENIOR, junior: JUNIOR }
  const costs: RunCostByRole = {
    senior: { currency: 'USD', total: 0.000225, model: 'gpt-4o' },
    junior: null,
  }
  const rows = roleUsageViews(split, costs)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].cost, '~$0.0002 est.')
  assert.equal(rows[0].costTitle, 'gpt-4o — estimated from token usage; not a bill')
  // An unpriced half adds no segment (never "$0.0000").
  assert.equal(rows[1].cost, null)
  assert.equal(rows[1].costTitle, null)
  // The cost is additive: the existing segments are unchanged.
  assert.equal(rows[0].tokens, 'in 1,200 / out 340 tok')
  assert.equal(rows[1].tokens, 'in 800 / out 120 tok')

  // Absent / null costs keep today's rows byte-for-byte.
  assert.deepEqual(
    roleUsageViews(split).map((row) => row.cost),
    [null, null],
  )
  assert.deepEqual(
    roleUsageViews(split, null).map((row) => row.cost),
    [null, null],
  )
  // Malformed cost objects fail soft (no made-up number).
  const junk = roleUsageViews(split, {
    senior: { currency: 'USD', total: Number.NaN, model: 'gpt-4o' },
    junior: { currency: 'EUR' as 'USD', total: 1, model: 'deepseek-chat' },
  })
  assert.deepEqual(
    junk.map((row) => row.cost),
    [null, null],
  )
  // A role that measured no call gets no row even when a cost object exists.
  const solo = roleUsageViews(
    { senior: { ...SENIOR, model_calls: 0 }, junior: JUNIOR },
    { senior: { currency: 'USD', total: 1, model: 'gpt-4o' }, junior: null },
  )
  assert.deepEqual(
    solo.map((row) => row.role),
    ['junior'],
  )
})

test('the footer and /status rows render the additive per-role cost conditionally', () => {
  const footer = readFileSync(
    fileURLToPath(new URL('../src/components/UsageFooter.vue', import.meta.url)),
    'utf8',
  )
  assert.match(footer, /v-if="row\.cost !== null"/, 'the cost segment is conditional')
  assert.match(footer, /\{\{ row\.cost \}\}/, 'the row renders the priced estimate')
  assert.match(footer, /:title="row\.costTitle/, 'the segment carries the priced-model tooltip')

  const dialog = readFileSync(
    fileURLToPath(new URL('../src/components/SessionStatusDialog.vue', import.meta.url)),
    'utf8',
  )
  assert.match(dialog, /v-if="row\.cost !== null"/, 'the /status row cost is conditional')
  assert.match(dialog, /\{\{ row\.cost \}\}/, 'the /status row renders the estimate')
})

test('App carries cost_by_role from the run record into the role rows', () => {
  const app = readFileSync(fileURLToPath(new URL('../src/App.vue', import.meta.url)), 'utf8')
  assert.match(app, /runCostByRoleBySession/, 'the per-role estimate has its own session map')
  assert.match(
    app,
    /latest\.cost_by_role \?\? null/,
    'the newest completed record supplies the per-role estimate',
  )
  assert.match(app, /rec\.cost_by_role \?\? null/, 'the terminal record refreshes it')
  assert.match(
    app,
    /runCostByRoleBySession\.value\[selected\.value\] \?\? null/,
    'the selected session rows receive its per-role costs',
  )
  assert.match(app, /delete roleCosts\[name\]/, 'session deletion prunes the per-role estimate')
})
