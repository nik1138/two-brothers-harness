/**
 * Model-declared effort levels in the UI (pure helpers + source wiring). No
 * DOM/Vue runtime:
 *   node --import ./tests/register-ts.mjs --test tests/modelEfforts.test.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  effortChoices,
  effortLabel,
  effortSupported,
  modelEffortKey,
  withModelEfforts,
} from '../src/modelEfforts.ts'
import type { ModelEffortInfo } from '../src/types.ts'

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/${relative}`, import.meta.url)), 'utf8')

function info(efforts: string[], source: ModelEffortInfo['source'] = 'models.dev'): ModelEffortInfo {
  return {
    provider: 'opencode-go',
    model: 'deepseek-v4.1-flash',
    reasoning: true,
    efforts,
    source,
  }
}

test('the UI offers Default plus exactly the model-declared levels', () => {
  assert.deepEqual(effortChoices(info(['low', 'high', 'max'])), [
    { value: '', label: 'Default' },
    { value: 'low', label: 'Low' },
    { value: 'high', label: 'High' },
    { value: 'max', label: 'Max' },
  ])
  assert.deepEqual(effortChoices(info(['high', 'HIGH', ''])), [
    { value: '', label: 'Default' },
    { value: 'high', label: 'High' },
  ])
  assert.deepEqual(effortChoices(null), [{ value: '', label: 'Default' }])
})

test('labels cover the vendor vocabulary', () => {
  assert.equal(effortLabel('xhigh'), 'Extra high')
  assert.equal(effortLabel('max'), 'Max')
  assert.equal(effortLabel('minimal'), 'Minimal')
  assert.equal(effortLabel('none'), 'None')
  assert.equal(effortLabel(''), 'Default')
})

test('stored effort support is honest, including unavailable metadata', () => {
  const declared = info(['low', 'high', 'max'])
  assert.equal(effortSupported(declared, 'max'), true)
  assert.equal(effortSupported(declared, 'medium'), false)
  assert.equal(effortSupported(declared, ''), true, 'Default is always valid')
  assert.equal(effortSupported(info([], 'unavailable'), 'high'), false)
})

test('the lookup cache is keyed per provider and model, case-insensitively', () => {
  const key = modelEffortKey('OpenCode-Go', 'deepseek-v4.1-flash')
  assert.equal(key, modelEffortKey('opencode-go', 'deepseek-v4.1-flash'))
  const cache = withModelEfforts({}, info(['high', 'max']))
  assert.deepEqual(cache[key]?.efforts, ['high', 'max'])
  assert.notEqual(withModelEfforts(cache, info(['low'])), cache)
})

test('the composer renders a model-reported effort pane and saves it', () => {
  const composer = read('components/Composer.vue')
  assert.ok(composer.includes('getModelEfforts'))
  assert.ok(composer.includes('effortChoices'))
  assert.ok(composer.includes('openRoleEffort'))
  assert.ok(composer.includes('chooseEffort'))
  assert.ok(composer.includes('activeEffortChoices'))
  assert.ok(composer.includes('model-effort-row'))
  assert.ok(composer.includes('effort: value'))
  assert.ok(composer.includes("effort: ''"), 'a model change clears a stale effort')
  assert.ok(composer.includes('not reported by this'))
})

test('Settings loads levels for the selected provider/model and saves effort', () => {
  const settings = read('components/SettingsDialog.vue')
  assert.ok(settings.includes('getModelEfforts'))
  assert.ok(settings.includes('refreshEffortOptions'))
  assert.ok(settings.includes('effort: form.effort'))
  assert.ok(settings.includes('effort-options'))

  const editor = read('components/settings/RoleEditor.vue')
  assert.ok(editor.includes('effortSelectOptions'))
  assert.ok(editor.includes('effortOptions'))
  assert.ok(editor.includes('onEffort'))
  assert.ok(editor.includes('Levels reported by the selected model'))
})
