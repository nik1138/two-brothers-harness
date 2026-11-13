// Hermetic tests for the browser-E2E missing-backend SKIP registry.
//
//   node --test e2e/skip-registry.test.mjs
//
// Regression guard for the drift that left model-switch and the four
// subagent scenarios out of the SKIP report e2e/run.mjs emits when
// packages/harness/dist is not built: the report must be derived from the
// same hermetic registry the runner executes, and every scenario result the
// runner can pass must be covered by that derivation. Pure source/imports
// checks — offline, deterministic, no browser and no built backend needed.
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { test } from 'node:test'

import {
  HERMETIC_LABELS,
  hermeticResultNames,
  labelResultNames,
} from './scenario-registry.mjs'

const RUN_SOURCE = fs.readFileSync(new URL('./run.mjs', import.meta.url), 'utf-8')

/**
 * Every result name a scenario passes, recovered from run.mjs source. The
 * approval block passes `approval-${decision}` for both decisions, so the
 * template literal is expanded by hand.
 */
function passedResultNames() {
  const names = new Set()
  for (const match of RUN_SOURCE.matchAll(/runner\.pass\(\s*'([^']+)'\s*\)/g)) {
    names.add(match[1])
  }
  for (const match of RUN_SOURCE.matchAll(/runner\.pass\(\s*`([^`]+)`\s*\)/g)) {
    if (match[1] === 'approval-${decision}') {
      names.add('approval-allow')
      names.add('approval-deny')
    } else {
      names.add(match[1])
    }
  }
  return names
}

test('registry labels are unique kebab-case block names', () => {
  assert.equal(new Set(HERMETIC_LABELS).size, HERMETIC_LABELS.length, 'duplicate labels')
  for (const label of HERMETIC_LABELS) {
    assert.match(
      label,
      /^[a-z0-9]+(-[a-z0-9]+)*(\/[a-z0-9]+(-[a-z0-9]+)*)?$/,
      `label "${label}" is not a kebab-case block name`,
    )
  }
})

test('chat/resume stays one block that contributes two result names', () => {
  assert.deepEqual(labelResultNames('chat/resume'), ['chat', 'resume'])
  assert.deepEqual(
    HERMETIC_LABELS.filter((label) => label.includes('/')),
    ['chat/resume'],
    'only the chat/resume block may pass several results',
  )
})

test('derived skip names are unique and exclude the opt-in real scenario', () => {
  const names = hermeticResultNames()
  assert.equal(new Set(names).size, names.length, 'duplicate result names')
  assert.ok(!names.includes('real'), 'the opt-in real scenario is appended separately')
  assert.equal(
    names.length,
    HERMETIC_LABELS.length + 1,
    'exactly one block (chat/resume) contributes a second result',
  )
})

test('every scenario result in run.mjs is covered by the skip derivation', () => {
  const covered = new Set(hermeticResultNames())
  const omitted = [...passedResultNames()].filter((name) => name !== 'real' && !covered.has(name))
  assert.deepEqual(
    omitted,
    [],
    `missing-backend SKIP would silently omit: ${omitted.join(', ')}`,
  )
})

test('every derived skip name is a real scenario result in run.mjs', () => {
  const passed = passedResultNames()
  const orphan = hermeticResultNames().filter((name) => !passed.has(name))
  assert.deepEqual(
    orphan,
    [],
    `registry result name without a runner.pass() in run.mjs: ${orphan.join(', ')}`,
  )
})

test('run.mjs derives its skip report from the registry, not a literal list', () => {
  assert.match(
    RUN_SOURCE,
    /from '\.\/scenario-registry\.mjs'/,
    'run.mjs must import the shared scenario registry',
  )
  assert.match(
    RUN_SOURCE,
    /\[\.\.\.hermeticResultNames\(\),\s*'real'\]/,
    'the missing-backend SKIP report must be derived from the shared registry',
  )
  assert.match(
    RUN_SOURCE,
    /must match e2e\/scenario-registry\.mjs exactly/,
    'run.mjs must keep its hermetic table in lockstep with the registry',
  )
})
