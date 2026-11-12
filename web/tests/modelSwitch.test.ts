/**
 * Composer model switch: pure provider-grouped choices plus the source-level
 * wiring that keeps the switch inside the message input. No DOM/Vue runtime:
 *   node --import ./tests/register-ts.mjs --test tests/modelSwitch.test.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import type { ProviderView } from '../src/providerSettings.ts'
import {
  filterModelGroups,
  isCurrentModelChoice,
  modelChoiceCount,
  modelChoiceKey,
  modelChoicePatch,
  modelGroupsForRole,
} from '../src/modelSwitch.ts'

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/${relative}`, import.meta.url)), 'utf8')

function provider(
  name: string,
  models: string[],
  apiKeySet = true,
): ProviderView {
  return {
    name,
    base_url: `https://${name}.example/v1`,
    api_key_set: apiKeySet,
    kind: 'openai-compatible',
    models,
    context_window: 0,
    seed: true,
    customized: false,
  }
}

const providers = [
  provider('opencode-go', ['glm-5.2', 'kimi-k3.1-pro', 'deepseek-v4.1-flash']),
  provider('kimi-coding', ['k3.1-pro', 'kimi-for-coding'], false),
]

const settings = {
  senior: {
    provider: 'openai',
    model: 'glm-5.2',
    base_url: 'https://opencode-go.example/v1',
    api_key_set: true,
    provider_ref: 'opencode-go',
  },
  junior: {
    provider: 'openai',
    model: 'my-local-model',
    base_url: 'http://127.0.0.1:1234/v1',
    api_key_set: true,
    provider_ref: null,
  },
}

test('groups presets and marks the current model check', () => {
  const groups = modelGroupsForRole(settings, providers, 'senior')
  assert.deepEqual(
    groups.map((group) => group.provider),
    ['opencode-go', 'kimi-coding'],
    'the current provider group comes first',
  )
  const current = groups[0]!.models.find((choice) => choice.current)
  assert.equal(current?.model, 'glm-5.2')
  assert.equal(current?.providerRef, 'opencode-go')
  assert.equal(groups[1]!.hasKey, false, 'a keyless provider is still visible');
  assert.equal(modelChoiceCount(groups), 5)
})

test('a manual current route gets a first, no-op Current connection group', () => {
  const groups = modelGroupsForRole(settings, providers, 'junior')
  assert.equal(groups[0]!.provider, 'Current connection')
  assert.equal(groups[0]!.providerRef, null)
  assert.deepEqual(groups[0]!.models.map((choice) => choice.model), ['my-local-model'])
  assert.equal(groups[0]!.models[0]!.current, true)
  assert.equal(modelChoicePatch('junior', groups[0]!.models[0]!), null)
})

test('a current model missing from its preset list is still selectable', () => {
  const custom = {
    senior: { ...settings.senior, model: 'not-in-catalog' },
    junior: settings.junior,
  }
  const groups = modelGroupsForRole(custom, providers, 'senior')
  assert.equal(groups[0]!.provider, 'opencode-go')
  assert.equal(groups[0]!.models[0]!.model, 'not-in-catalog')
  assert.equal(groups[0]!.models[0]!.current, true)
  assert.equal(groups[0]!.models.filter((choice) => choice.model === 'glm-5.2').length, 1)
})

test('a dangling provider_ref keeps its current connection visible', () => {
  const dangling = {
    senior: { ...settings.senior, provider_ref: 'retired-preset', model: 'old-model' },
    junior: settings.junior,
  }
  const groups = modelGroupsForRole(dangling, providers, 'senior')
  assert.equal(groups[0]!.provider, 'retired-preset')
  assert.equal(groups[0]!.models[0]!.model, 'old-model')
})

test('search matches model and provider terms in any order', () => {
  const groups = modelGroupsForRole(settings, providers, 'senior')
  const kimi = filterModelGroups(groups, 'kimi go')
  assert.equal(kimi.length, 1)
  assert.equal(kimi[0]!.provider, 'opencode-go')
  assert.deepEqual(kimi[0]!.models.map((choice) => choice.model), ['kimi-k3.1-pro'])

  const allKimi = filterModelGroups(groups, 'kimi')
  assert.deepEqual(
    allKimi.map((group) => group.provider),
    ['opencode-go', 'kimi-coding'],
  )
  assert.deepEqual(filterModelGroups(groups, 'no-such-model'), [])
  assert.equal(filterModelGroups(groups, '   ').length, groups.length)
})

test('the patch writes provider_ref + model so the endpoint follows the preset', () => {
  const choice = modelGroupsForRole(settings, providers, 'senior')[1]!.models[0]!
  assert.deepEqual(modelChoicePatch('senior', choice), {
    senior: { provider_ref: 'kimi-coding', model: 'k3.1-pro' },
  })
  assert.equal(modelChoiceKey(choice), 'kimi-coding:k3.1-pro')
  assert.equal(isCurrentModelChoice(settings.senior, choice), false)
  assert.equal(
    isCurrentModelChoice(settings.senior, { providerRef: 'OPENCODE-GO', model: 'glm-5.2' }),
    true,
  )
})

test('no settings or providers is an empty switch, never a fabricated route', () => {
  assert.deepEqual(modelGroupsForRole(null, [], 'senior'), [])
  assert.deepEqual(modelGroupsForRole(undefined, providers, 'senior').length, 2)
})

test('the message input owns the switch: provider fetch, save and refresh wiring', () => {
  const composer = read('components/Composer.vue')
  assert.ok(composer.includes('modelGroupsForRole'))
  assert.ok(composer.includes('filterModelGroups'))
  assert.ok(composer.includes('listProviders'))
  assert.ok(composer.includes('updateSettings'))
  assert.ok(composer.includes('modelPane'))
  assert.ok(composer.includes('chooseModel'))
  assert.ok(composer.includes('modelsChanged'))
  assert.ok(composer.includes('Search models'))
  assert.ok(read('modelSwitch.ts').includes('Current connection'))
  assert.ok(composer.includes('@click="chooseModel(choice)"'))

  const app = read('App.vue')
  assert.ok(app.includes('@models-changed'))
  assert.ok(app.includes('function onComposerModelsChanged'))
})
