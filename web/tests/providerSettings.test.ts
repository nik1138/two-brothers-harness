// Focused tests for src/providerSettings.ts — the pure master–detail model
// behind Settings → Providers. No DOM:
//   node --import ./tests/register-ts.mjs --test tests/providerSettings.test.ts

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  DISCOVERY_UNSUPPORTED_BACKEND,
  PROVIDER_KIND_DEFAULT,
  apiKeyPlaceholder,
  apiKeyStateLabel,
  applyProviderReset,
  applyProviderUpdate,
  cleanModelList,
  discoveredAdditions,
  discoveredModels,
  discoveryStatusText,
  failDiscovery,
  isCurrentDiscovery,
  isProviderDraftDirty,
  mergeDiscoveredModels,
  newDiscoveryState,
  nextProviderIndex,
  normalizeProviders,
  parseProviderContextWindow,
  providerBadge,
  providerContextWindowOf,
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
  settleDiscovery,
  startDiscovery,
  supportsModelDiscovery,
  toggleOpenProvider,
  unsupportedDiscoveryCopy,
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
    context_window: 0,
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

test('normalizeProviders: context window is tolerant and defaults to unknown', () => {
  assert.equal(normalizeProviders([rawProvider({ context_window: 8192 })])[0]?.context_window, 8192)
  assert.equal(normalizeProviders([rawProvider()])[0]?.context_window, 0)
  for (const bad of [0, -1, 1.5, '8192', true, null, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(
      normalizeProviders([rawProvider({ context_window: bad })])[0]?.context_window,
      0,
      `invalid ${String(bad)} reads as unknown`,
    )
  }
})

test('providerContextWindowOf: only positive safe integers survive', () => {
  assert.equal(providerContextWindowOf(8192), 8192)
  assert.equal(providerContextWindowOf(0), 0)
  for (const bad of [-1, 1.5, '8192', null, undefined, Number.NaN, Infinity]) {
    assert.equal(providerContextWindowOf(bad), 0)
  }
})

test('parseProviderContextWindow: strict whole-token input, empty = unknown', () => {
  assert.deepEqual(parseProviderContextWindow(''), { value: 0, error: null })
  assert.deepEqual(parseProviderContextWindow('   '), { value: 0, error: null })
  assert.deepEqual(parseProviderContextWindow('0'), { value: 0, error: null })
  assert.deepEqual(parseProviderContextWindow('8192'), { value: 8192, error: null })
  assert.deepEqual(parseProviderContextWindow(' 08192 '), { value: 8192, error: null })
  for (const bad of ['-1', '1.5', '+3', '1e3', '0x10', '8,192', 'abc', '8192 tokens']) {
    const parsed = parseProviderContextWindow(bad)
    assert.equal(parsed.value, 0, bad)
    assert.match(parsed.error ?? '', /whole number of tokens/, bad)
  }
  const huge = parseProviderContextWindow('9'.repeat(400))
  assert.equal(huge.value, 0)
  assert.match(huge.error ?? '', /too large/)
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
  const provider = view({
    base_url: 'http://x',
    models: ['m1'],
    kind: 'anthropic',
    context_window: 8192,
  })
  const draft = providerDraftOf(provider)
  assert.deepEqual(draft, {
    baseUrl: 'http://x',
    apiKey: '',
    models: ['m1'],
    kind: 'anthropic',
    contextWindow: '8192',
  })
  draft.models.push('m2')
  assert.deepEqual(provider.models, ['m1'], 'models are copied')
  assert.deepEqual(providerDraftOf(null), {
    baseUrl: '',
    apiKey: '',
    models: [],
    kind: PROVIDER_KIND_DEFAULT,
    contextWindow: '0',
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

test('isProviderDraftDirty tracks the context window strictly', () => {
  const provider = view({ context_window: 8192 })
  const base = providerDraftOf(provider)
  assert.equal(isProviderDraftDirty(provider, base), false)
  assert.equal(isProviderDraftDirty(provider, { ...base, contextWindow: ' 08192 ' }), false)
  assert.equal(isProviderDraftDirty(provider, { ...base, contextWindow: '16384' }), true)
  assert.equal(isProviderDraftDirty(provider, { ...base, contextWindow: '0' }), true)
  // an unparsable window is dirty so the unsaved guard sees it
  assert.equal(isProviderDraftDirty(provider, { ...base, contextWindow: '-1' }), true)
  assert.equal(isProviderDraftDirty(provider, { ...base, contextWindow: '1.5' }), true)
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
    context_window: 16384,
  }
  const next = applyProviderUpdate(current, saved)
  assert.equal(next[0]?.seed, true, 'additive flag preserved')
  assert.equal(next[0]?.customized, false)
  assert.equal(next[0]?.base_url, 'http://localhost:9999/v1')
  assert.equal(next[0]?.api_key_set, true)
  assert.equal(next[0]?.kind, 'anthropic')
  assert.deepEqual(next[0]?.models, ['custom'])
  assert.equal(next[0]?.context_window, 16384)
  assert.deepEqual(next[1], current[1], 'other rows untouched')

  // a response without the field clears it back to unknown (0 semantics)
  const cleared = applyProviderUpdate(next, { ...saved, context_window: undefined })
  assert.equal(cleared[0]?.context_window, 0)
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
    context_window: 65536,
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

// -- model discovery ("Refresh models") ---------------------------------------

test('supportsModelDiscovery: only OpenAI-compatible endpoints can be probed', () => {
  assert.equal(supportsModelDiscovery('openai-compatible'), true)
  assert.equal(supportsModelDiscovery(''), true, 'empty means the default kind')
  assert.equal(supportsModelDiscovery(undefined), true)
  assert.equal(supportsModelDiscovery(null), true)
  assert.equal(supportsModelDiscovery('anthropic'), false)
  assert.equal(supportsModelDiscovery('google'), false)
  assert.equal(supportsModelDiscovery('future-kind'), false)
})

test('unsupportedDiscoveryCopy names the wire kind and stays honest', () => {
  assert.match(unsupportedDiscoveryCopy('anthropic'), /not supported for Anthropic providers/)
  assert.match(unsupportedDiscoveryCopy('anthropic'), /OpenAI-compatible/)
  assert.match(unsupportedDiscoveryCopy('anthropic'), /two-brothers models/)
  assert.match(unsupportedDiscoveryCopy('google'), /Google Gemini/)
})

test('discoveredModels: tolerant ids from objects, strings and wrappers', () => {
  assert.deepEqual(discoveredModels([{ id: 'a' }, { id: 'b', owned_by: 'org' }, 'c']), [
    'a',
    'b',
    'c',
  ])
  assert.deepEqual(discoveredModels({ models: [{ id: 'a' }, { name: 'b' }, ' a '] }), ['a', 'b'])
  assert.deepEqual(discoveredModels({ data: ['x', 'y'] }), ['x', 'y'])
  assert.deepEqual(discoveredModels({ models: 'nope' }), [])
  assert.deepEqual(discoveredModels({ nope: true }), [])
  assert.deepEqual(discoveredModels(null), [])
  assert.deepEqual(discoveredModels([{ id: 42 }, {}, { id: ' ' }, null]), [])
})

test('discovery tokens: only the newest probe may settle', () => {
  const first = startDiscovery(' mine ', 1)
  assert.deepEqual(first, { token: 1, name: 'mine', phase: 'loading', models: [], message: '' })
  assert.equal(isCurrentDiscovery(first, 1, 'mine'), true)
  assert.equal(isCurrentDiscovery(first, 1, ' mine '), true, 'both sides are trimmed')
  assert.equal(isCurrentDiscovery(first, 1, 'Mine'), false, 'provider ids stay case-sensitive')
  assert.equal(isCurrentDiscovery(first, 1, 'other'), false)
  assert.equal(isCurrentDiscovery(first, 2, 'mine'), false)
  // starting a newer probe supersedes the older token
  const second = startDiscovery('mine', 2)
  assert.equal(isCurrentDiscovery(second, 1, 'mine'), false)
  assert.equal(isCurrentDiscovery(second, 2, 'mine'), true)
})

test('settleDiscovery: ready, empty, malformed and stale answers', () => {
  const ready = settleDiscovery(startDiscovery('mine', 7), 7, 'mine', [{ id: 'm1' }, 'm2'])
  assert.deepEqual(ready, {
    token: 7,
    name: 'mine',
    phase: 'ready',
    models: ['m1', 'm2'],
    message: '',
  })

  // An empty (or malformed) answer is a valid answer: honest `empty` phase and
  // copy that says the saved catalog is untouched — never a reason to erase it.
  for (const raw of [{ models: [] }, [], { data: [] }, null, { nope: true }]) {
    const empty = settleDiscovery(startDiscovery('mine', 8), 8, 'mine', raw)
    assert.equal(empty.phase, 'empty')
    assert.deepEqual(empty.models, [])
    assert.match(empty.message, /reported no models/)
    assert.match(empty.message, /unchanged/)
  }

  // A stale response is dropped object-identically (no state churn).
  const current = startDiscovery('mine', 9)
  assert.equal(settleDiscovery(current, 8, 'mine', [{ id: 'old' }]), current)
  assert.equal(settleDiscovery(current, 9, 'other', [{ id: 'other' }]), current)
})

test('failDiscovery: old backends/unsupported kinds vs real upstream errors', () => {
  // 404 = the backend predates the discovery route: honest unsupported, not a
  // scary network error. Nothing in the draft may change.
  const legacy = failDiscovery(startDiscovery('mine', 3), 3, 'mine', 404, 'Not Found')
  assert.equal(legacy.phase, 'unsupported')
  assert.equal(legacy.message, DISCOVERY_UNSUPPORTED_BACKEND)
  assert.deepEqual(legacy.models, [])

  // 400 "not supported" = the server's honest wire-kind answer.
  const kind = failDiscovery(
    startDiscovery('mine', 4),
    4,
    'mine',
    400,
    'model discovery is not supported for the anthropic provider kind (use openai-compatible|anthropic|google)',
  )
  assert.equal(kind.phase, 'unsupported')
  assert.match(kind.message, /not supported for the anthropic provider kind/)

  // Other failures are errors with the detail preserved.
  const upstream = failDiscovery(
    startDiscovery('mine', 5),
    5,
    'mine',
    502,
    'model discovery failed: HTTP 500 from http://x/v1/models: boom',
  )
  assert.equal(upstream.phase, 'error')
  assert.match(upstream.message, /^Model discovery failed: /)
  assert.match(upstream.message, /HTTP 500/)

  const unreachable = failDiscovery(
    startDiscovery('mine', 6),
    6,
    'mine',
    0,
    'API is unreachable — is the backend running on port 8600?',
  )
  assert.equal(unreachable.phase, 'error')
  assert.match(unreachable.message, /API is unreachable/)

  // A stale failure never replaces a newer probe's state.
  const current = startDiscovery('mine', 10)
  assert.equal(failDiscovery(current, 9, 'mine', 502, 'old failure'), current)
})

test('discoveryStatusText truthfully describes every phase', () => {
  assert.equal(discoveryStatusText(newDiscoveryState()), '')
  assert.match(discoveryStatusText(startDiscovery('mine', 1)), /Asking the endpoint/)
  const ready = settleDiscovery(startDiscovery('mine', 2), 2, 'mine', ['a', 'b'])
  assert.match(discoveryStatusText(ready), /2 models reported/)
  assert.match(discoveryStatusText(ready), /Nothing is saved/)
  const one = settleDiscovery(startDiscovery('mine', 3), 3, 'mine', ['a'])
  assert.match(discoveryStatusText(one), /1 model reported/)
  const empty = settleDiscovery(startDiscovery('mine', 4), 4, 'mine', [])
  assert.match(discoveryStatusText(empty), /no models/)
  const error = failDiscovery(startDiscovery('mine', 5), 5, 'mine', 502, 'boom')
  assert.match(discoveryStatusText(error), /Model discovery failed: boom/)
})

test('mergeDiscoveredModels/discoveredAdditions: union in draft order, never erase', () => {
  assert.deepEqual(mergeDiscoveredModels(['a', 'b'], ['b', 'c']), ['a', 'b', 'c'])
  assert.deepEqual(mergeDiscoveredModels([], ['b', 'a', 'b']), ['b', 'a'])
  assert.deepEqual(mergeDiscoveredModels(['keep'], []), ['keep'], 'empty answer never erases')
  assert.deepEqual(mergeDiscoveredModels('nope', ['a']), ['a'])
  assert.deepEqual(mergeDiscoveredModels([' a '], [{ id: 'b' }]), ['a', 'b'])

  assert.deepEqual(discoveredAdditions(['a', 'b'], ['b', 'c', 'd']), ['c', 'd'])
  assert.deepEqual(discoveredAdditions(['a'], []), [])
  assert.deepEqual(discoveredAdditions([], ['a']), ['a'])
  assert.deepEqual(discoveredAdditions(['a'], ['a']), [])
})

test('discovery never applies by itself: only the explicit merge changes a list', () => {
  const draftModels = ['manual-model']
  const settled = settleDiscovery(startDiscovery('mine', 12), 12, 'mine', ['fresh-model'])
  assert.deepEqual(draftModels, ['manual-model'], 'settling a result performs no write')
  // Empty results must not erase the existing catalog even when merged.
  assert.deepEqual(mergeDiscoveredModels(draftModels, []), ['manual-model'])
  assert.deepEqual(mergeDiscoveredModels(draftModels, settled.models), [
    'manual-model',
    'fresh-model',
  ])
})

// -- models.dev catalog prefill (Add form) -------------------------------------

test('a catalog prefill passes the Add-form validation unchanged', () => {
  // The browser suggests a sanitized, family-suffixed, collision-free name;
  // the Add form accepts it as-is and still lets the operator edit it.
  const prefill = {
    name: 'opencode-go-anthropic',
    baseUrl: 'https://opencode.ai/inference/go/anthropic/v1',
  }
  assert.equal(validateAddProviderForm(prefill, ['opencode-go']), null)
  // The browser dedupes a taken name before prefilling, and that deduped name
  // passes this validation too (the operator can still edit it).
  assert.equal(
    validateAddProviderForm({ ...prefill, name: 'opencode-go-anthropic-2' }, [
      'opencode-go',
      'opencode-go-anthropic',
    ]),
    null,
  )
  assert.match(
    validateAddProviderForm(prefill, ['OpenCode-Go-Anthropic'])?.name ?? '',
    /already uses this ID/,
  )
  // An editable name that a later edit breaks is still rejected.
  assert.match(
    validateAddProviderForm({ ...prefill, name: 'Opencode-Go' }, [])?.name ?? '',
    /lowercase letters/,
  )
  assert.match(
    validateAddProviderForm({ ...prefill, baseUrl: '' }, [])?.baseUrl ?? '',
    /must not be empty/,
  )
  assert.match(
    validateAddProviderForm({ ...prefill, baseUrl: 'ftp://nope' }, [])?.baseUrl ?? '',
    /http:\/\/ or https:\/\//,
  )
})

test('the new Add-form context-window field parses like the detail field', () => {
  // The catalog prefill carries the smallest selected window; the Add form
  // parses it with the same strict rule and only sends a positive value.
  assert.deepEqual(parseProviderContextWindow('200000'), { value: 200000, error: null })
  assert.deepEqual(parseProviderContextWindow(''), { value: 0, error: null })
  assert.deepEqual(parseProviderContextWindow('0'), { value: 0, error: null })
  assert.equal(parseProviderContextWindow('1.5').error !== null, true)
  assert.equal(parseProviderContextWindow('-1').error !== null, true)
  assert.equal(parseProviderContextWindow('1e6').error !== null, true)
  assert.equal(parseProviderContextWindow('lots').error !== null, true)
  assert.equal(providerContextWindowOf(0), 0)
  assert.equal(providerContextWindowOf(200000), 200000)
  assert.equal(providerContextWindowOf('200000'), 0)
})

