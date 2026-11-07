// Focused tests for src/providerSettings.ts — the pure master–detail model
// behind Settings → Providers. No DOM:
//   node --import ./tests/register-ts.mjs --test tests/providerSettings.test.ts

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  PROVIDER_KIND_DEFAULT,
  apiKeyPlaceholder,
  apiKeyStateLabel,
  applyProviderReset,
  applyProviderUpdate,
  cleanModelList,
  isProviderDraftDirty,
  nextProviderIndex,
  normalizeProviders,
  providerBadge,
  providerDeleteAllowed,
  providerDeleteImpact,
  providerDraftOf,
  providerIsCustomizedSeed,
  providerKindLabel,
  providerMoveForKey,
  providerResetAllowed,
  providerRowSummary,
  providerUsageBadges,
  resolveProviderSelection,
  sameModelList,
  toggleOpenProvider,
  validateAddProviderForm,
  validateProviderBaseUrl,
} from '../src/providerSettings.ts'
import type { ProviderView } from '../src/providerSettings.ts'
import type { ProviderPreset } from '../src/types.ts'

function rawProvider(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'openai',
    base_url: 'https://api.openai.com/v1',
    api_key_set: false,
    kind: 'openai-compatible',
    models: ['gpt-4o'],
    seed: true,
    customized: false,
    ...overrides,
  }
}

function view(overrides: Partial<ProviderView> = {}): ProviderView {
  return {
    name: 'lmstudio',
    base_url: 'http://localhost:1234/v1',
    api_key_set: false,
    kind: PROVIDER_KIND_DEFAULT,
    models: ['spark', 'lfm'],
    seed: false,
    customized: true,
    ...overrides,
  }
}

// -- normalization & flags ----------------------------------------------------

test('normalizeProviders: additive flags and old-backend fallback', () => {
  const providers = normalizeProviders([
    rawProvider(),
    rawProvider({ name: 'lmstudio', seed: false, customized: true, models: [] }),
    null,
    { name: '' },
    rawProvider({ name: 'OPENAI' }), // duplicate (case-insensitive), ignored
  ])
  assert.deepEqual(
    providers.map((provider) => [provider.name, provider.seed, provider.customized]),
    [
      ['openai', true, false],
      ['lmstudio', false, true],
    ],
  )

  // an old backend omits both flags: seed=false, customized=true (still usable)
  const legacy = normalizeProviders([rawProvider({ seed: undefined, customized: undefined })])
  assert.equal(legacy[0]?.seed, false)
  assert.equal(legacy[0]?.customized, true)

  // partial flags fall back per field
  const partial = normalizeProviders([rawProvider({ seed: undefined })])
  assert.equal(partial[0]?.seed, false)
  assert.equal(partial[0]?.customized, false)

  assert.deepEqual(normalizeProviders(null), [])
  assert.deepEqual(normalizeProviders('nope'), [])
})

test('normalizeProviders: trims fields and cleans model lists', () => {
  const [provider] = normalizeProviders([
    rawProvider({
      name: '  custom  ',
      base_url: '  http://x/v1  ',
      api_key_set: 'yes',
      kind: '',
      models: ['a', ' ', 'a', 'b', 3],
    }),
  ])
  assert.equal(provider?.name, 'custom')
  assert.equal(provider?.base_url, 'http://x/v1')
  assert.equal(provider?.api_key_set, false)
  assert.equal(provider?.kind, PROVIDER_KIND_DEFAULT)
  assert.deepEqual(provider?.models, ['a', 'b'])
})

test('cleanModelList/sameModelList: trim, dedupe, order-sensitive compare', () => {
  assert.deepEqual(cleanModelList([' a ', '', 'a', 'b', null]), ['a', 'b'])
  assert.deepEqual(cleanModelList('nope'), [])
  assert.equal(sameModelList(['a', 'b'], ['a ', 'b']), true)
  assert.equal(sameModelList(['b', 'a'], ['a', 'b']), false)
  assert.equal(sameModelList(['a'], ['a', 'b']), false)
})

test('providerKindLabel and providerBadge copy', () => {
  assert.equal(providerKindLabel('anthropic'), 'Anthropic')
  assert.equal(providerKindLabel('google'), 'Google Gemini')
  assert.equal(providerKindLabel('future-kind'), 'future-kind')
  assert.equal(providerKindLabel(''), 'OpenAI-compatible')
  assert.equal(providerBadge({ seed: true }), 'Built-in')
  assert.equal(providerBadge({ seed: false }), 'Custom')
})

test('providerIsCustomizedSeed marks only edited seeds', () => {
  assert.equal(providerIsCustomizedSeed({ seed: true, customized: true }), true)
  assert.equal(providerIsCustomizedSeed({ seed: true, customized: false }), false)
  assert.equal(providerIsCustomizedSeed({ seed: false, customized: true }), false)
  assert.equal(providerIsCustomizedSeed(null), false)
})

test('providerResetAllowed: only customized built-in seeds are eligible', () => {
  assert.equal(providerResetAllowed({ seed: true, customized: true }), true)
  assert.equal(providerResetAllowed({ seed: true, customized: false }), false)
  assert.equal(providerResetAllowed({ seed: false, customized: true }), false)
  assert.equal(providerResetAllowed({ seed: false, customized: false }), false)
  assert.equal(providerResetAllowed(null), false)
  // Missing additive flags normalize to a legacy custom provider, not a resettable seed.
  const [legacy] = normalizeProviders([rawProvider({ seed: undefined, customized: undefined })])
  assert.equal(providerResetAllowed(legacy), false)
})

// -- selection & open state ---------------------------------------------------

test('resolveProviderSelection keeps a live selection, else picks the first', () => {
  const providers = [view({ name: 'a' }), view({ name: 'b' })]
  assert.equal(resolveProviderSelection(providers, 'b'), 'b')
  assert.equal(resolveProviderSelection(providers, 'gone'), 'a')
  assert.equal(resolveProviderSelection(providers, null), 'a')
  assert.equal(resolveProviderSelection([], 'a'), null)
})

test('toggleOpenProvider opens one at a time and closes the open row', () => {
  assert.equal(toggleOpenProvider(null, 'a'), 'a')
  assert.equal(toggleOpenProvider('a', 'b'), 'b')
  assert.equal(toggleOpenProvider('a', 'a'), null)
})

// -- usage badges & delete rules ---------------------------------------------

test('providerUsageBadges maps role refs case-insensitively', () => {
  const provider = view({ name: 'DeepSeek' })
  assert.deepEqual(providerUsageBadges(provider, { senior: 'deepseek' }), ['Senior'])
  assert.deepEqual(providerUsageBadges(provider, { junior: ' DEEPSEEK ' }), ['Junior'])
  assert.deepEqual(
    providerUsageBadges(provider, { senior: 'deepseek', junior: 'deepseek' }),
    ['Senior', 'Junior'],
  )
  assert.deepEqual(providerUsageBadges(provider, { senior: 'openai' }), [])
  assert.deepEqual(providerUsageBadges(provider, {}), [])
  assert.deepEqual(providerUsageBadges(view({ name: '' }), { senior: '' }), [])
})

test('providerDeleteAllowed: only stored (non-seed) providers may be deleted', () => {
  assert.equal(providerDeleteAllowed({ seed: false }), true)
  assert.equal(providerDeleteAllowed({ seed: true }), false)
  assert.equal(providerDeleteAllowed(null), false)
  // the old-backend fallback marks everything custom -> delete stays available
  const [legacy] = normalizeProviders([rawProvider({ seed: undefined, customized: undefined })])
  assert.equal(providerDeleteAllowed(legacy), true)
})

test('providerDeleteImpact names the roles that will switch to Manual', () => {
  assert.match(providerDeleteImpact([]), /No role uses this provider/)
  assert.equal(
    providerDeleteImpact(['Senior']),
    'Senior uses this provider. It will switch to Manual.',
  )
  assert.equal(
    providerDeleteImpact(['Senior', 'Junior']),
    'Senior and Junior use this provider. They will switch to Manual.',
  )
})

// -- drafts & dirty tracking --------------------------------------------------

test('providerDraftOf: key starts empty; models/kind are copied', () => {
  const provider = view({ base_url: 'http://x', models: ['m1'], kind: 'anthropic' })
  const draft = providerDraftOf(provider)
  assert.deepEqual(draft, {
    baseUrl: 'http://x',
    apiKey: '',
    models: ['m1'],
    kind: 'anthropic',
  })
  draft.models.push('m2')
  assert.deepEqual(provider.models, ['m1'], 'models are copied')
  assert.deepEqual(providerDraftOf(null), {
    baseUrl: '',
    apiKey: '',
    models: [],
    kind: PROVIDER_KIND_DEFAULT,
  })
})

test('isProviderDraftDirty tracks URL, typed key, models and kind', () => {
  const provider = view({
    base_url: 'http://x/v1',
    models: ['a'],
    kind: 'openai-compatible',
  })
  const base = providerDraftOf(provider)
  assert.equal(isProviderDraftDirty(provider, base), false)

  assert.equal(isProviderDraftDirty(provider, { ...base, baseUrl: ' http://x/v1 ' }), false)
  assert.equal(isProviderDraftDirty(provider, { ...base, baseUrl: 'http://y/v1' }), true)
  assert.equal(isProviderDraftDirty(provider, { ...base, apiKey: ' sk ' }), true)
  assert.equal(isProviderDraftDirty(provider, { ...base, models: ['a', 'b'] }), true)
  assert.equal(isProviderDraftDirty(provider, { ...base, models: ['b'] }), true)
  assert.equal(isProviderDraftDirty(provider, { ...base, kind: 'anthropic' }), true)
  assert.equal(isProviderDraftDirty(provider, null), false)
})

test('apiKeyPlaceholder/state stay honest and never echo the key', () => {
  assert.equal(apiKeyPlaceholder({ api_key_set: true }), 'Set — type a new value to replace')
  assert.equal(apiKeyPlaceholder({ api_key_set: false }), 'Not set — paste a key to store one')
  assert.equal(apiKeyStateLabel({ api_key_set: true }), 'API key set')
  assert.equal(apiKeyStateLabel({ api_key_set: false }), 'API key missing')
})

// -- validation ---------------------------------------------------------------

test('validateProviderBaseUrl requires a non-empty http(s) URL', () => {
  assert.equal(validateProviderBaseUrl(''), 'Base URL must not be empty.')
  assert.equal(validateProviderBaseUrl('   '), 'Base URL must not be empty.')
  assert.match(validateProviderBaseUrl('localhost:1234'), /must start with http/)
  assert.match(validateProviderBaseUrl('ftp://x'), /must start with http/)
  assert.equal(validateProviderBaseUrl('http://localhost:1234/v1'), null)
  assert.equal(validateProviderBaseUrl('HTTPS://api.example.com/v1'), null)
  assert.equal(validateProviderBaseUrl('https://api.example.com/v1'), null)
})

test('validateAddProviderForm: required fields, id pattern, duplicate check, http URL', () => {
  assert.deepEqual(validateAddProviderForm({ name: '', baseUrl: '' }), {
    name: 'Name is required.',
    baseUrl: 'Base URL must not be empty.',
  })
  assert.deepEqual(validateAddProviderForm({ name: 'Bad Name', baseUrl: 'http://x' }), {
    name: 'Use lowercase letters, digits and hyphens, starting with a letter.',
  })
  assert.ok(validateAddProviderForm({ name: '1st', baseUrl: 'http://x' })?.name)
  assert.deepEqual(validateAddProviderForm({ name: 'lm-studio', baseUrl: 'http://x' }), null)
  // duplicate against the loaded list, case-insensitive
  assert.deepEqual(
    validateAddProviderForm({ name: 'openai', baseUrl: 'http://x' }, ['OpenAI']),
    { name: 'A provider already uses this ID.' },
  )
  assert.deepEqual(
    validateAddProviderForm({ name: 'openai-2', baseUrl: 'ftp://x' }),
    { baseUrl: 'Base URL must start with http:// or https://.' },
  )
  assert.equal(validateAddProviderForm(null)?.name, 'Name is required.')
})

// -- keyboard arithmetic ------------------------------------------------------

test('nextProviderIndex wraps and Home/End jump; empty list is -1', () => {
  assert.equal(nextProviderIndex(0, 3, 'down'), 1)
  assert.equal(nextProviderIndex(2, 3, 'down'), 0)
  assert.equal(nextProviderIndex(0, 3, 'up'), 2)
  assert.equal(nextProviderIndex(1, 3, 'first'), 0)
  assert.equal(nextProviderIndex(1, 3, 'last'), 2)
  assert.equal(nextProviderIndex(-5, 3, 'down'), 1)
  assert.equal(nextProviderIndex(99, 3, 'up'), 1)
  assert.equal(nextProviderIndex(0, 0, 'down'), -1)

  assert.equal(providerMoveForKey('ArrowUp'), 'up')
  assert.equal(providerMoveForKey('ArrowDown'), 'down')
  assert.equal(providerMoveForKey('Home'), 'first')
  assert.equal(providerMoveForKey('End'), 'last')
  assert.equal(providerMoveForKey('Enter'), null)
  assert.equal(providerMoveForKey('a'), null)
})

// -- update merge -------------------------------------------------------------

test('applyProviderUpdate merges the PUT response and preserves seed flags', () => {
  const current: ProviderPreset[] = [
    {
      name: 'deepseek',
      base_url: 'https://api.deepseek.com/v1',
      api_key_set: false,
      kind: 'openai-compatible',
      models: ['deepseek-chat'],
      seed: true,
      customized: false,
    },
    {
      name: 'other',
      base_url: 'http://o',
      api_key_set: false,
      kind: 'openai-compatible',
      models: [],
      seed: false,
      customized: true,
    },
  ]
  const saved: ProviderPreset = {
    name: 'deepseek',
    base_url: 'http://localhost:9999/v1',
    api_key_set: true,
    kind: 'anthropic',
    models: ['custom'],
  }
  const next = applyProviderUpdate(current, saved)
  assert.equal(next[0]?.seed, true, 'additive flag preserved')
  assert.equal(next[0]?.customized, false)
  assert.equal(next[0]?.base_url, 'http://localhost:9999/v1')
  assert.equal(next[0]?.api_key_set, true)
  assert.equal(next[0]?.kind, 'anthropic')
  assert.deepEqual(next[0]?.models, ['custom'])
  assert.deepEqual(next[1], current[1], 'other rows untouched')
})

test('applyProviderReset replaces override values and flags with the pristine response', () => {
  const current: ProviderPreset[] = [
    {
      name: 'deepseek',
      base_url: 'http://localhost:9999/v1',
      api_key_set: true,
      kind: 'anthropic',
      models: ['custom'],
      seed: true,
      customized: true,
    },
    {
      name: 'other',
      base_url: 'http://o',
      api_key_set: false,
      kind: 'openai-compatible',
      models: [],
      seed: false,
      customized: true,
    },
  ]
  const restored: ProviderPreset = {
    name: 'deepseek',
    base_url: 'https://api.deepseek.com/v1',
    api_key_set: false,
    kind: 'openai-compatible',
    models: ['deepseek-chat', 'deepseek-chat'],
    seed: true,
    customized: false,
  }
  const next = applyProviderReset(current, restored)
  assert.deepEqual(next[0], {
    ...restored,
    models: ['deepseek-chat'],
  })
  assert.equal(next[0]?.seed, true)
  assert.equal(next[0]?.customized, false, 'stale override flag is replaced')
  assert.equal(next[0]?.api_key_set, false, 'stored override key state is replaced')
  assert.deepEqual(next[1], current[1], 'other rows and role-independent identity stay untouched')

  const [restoredView] = normalizeProviders([next[0]])
  assert.ok(restoredView)
  const restoredDraft = providerDraftOf(restoredView)
  assert.equal(restoredDraft.apiKey, '', 'a stale typed key cannot be resubmitted')
  assert.equal(isProviderDraftDirty(restoredView, restoredDraft), false)
})

test('providerRowSummary is identity-only information', () => {
  assert.equal(
    providerRowSummary(view({ name: 'lmstudio', kind: 'openai-compatible', models: ['a', 'b'] })),
    'lmstudio · OpenAI-compatible · 2 models',
  )
  assert.match(providerRowSummary(view({ models: ['a'] })), /1 model$/)
})
