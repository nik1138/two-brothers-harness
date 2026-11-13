/**
 * models.dev catalog browse model (pure, DOM-free):
 *   node --import ./tests/register-ts.mjs --test tests/modelsDev.test.ts
 *
 * Covers the §9.2 plan: normalization, search, family grouping, default
 * selection NONE (§15.6), base-URL resolution, context-window prefill, name
 * suggestion/dedupe, the exact import payload, refusal copy and the
 * fail-soft phases/banners.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  CATALOG_EMPTY_COPY,
  CATALOG_LOADING_COPY,
  CATALOG_UNAVAILABLE_COPY,
  CATALOG_UNSUPPORTED_COPY,
  availableFamilies,
  buildCatalogImport,
  catalogBanner,
  catalogProviderChips,
  curatedBanner,
  defaultSelection,
  detailErrorCopy,
  disabledBanner,
  familyBaseUrl,
  familyLabel,
  familyModels,
  familyNameSuffix,
  filterCatalogModels,
  filterCatalogProviders,
  hardImportBlocker,
  importAnnouncement,
  importBlockedReason,
  isModelSelected,
  minimumContextWindow,
  normalizeCatalogModel,
  normalizeCatalogProvider,
  normalizeCatalogProviderDetail,
  normalizeCatalogProviders,
  primaryFamily,
  providerExists,
  rejectReasonLabel,
  relativeCatalogTime,
  requiresBaseUrl,
  resolveImportBaseUrl,
  sanitizeProviderId,
  selectAllFamily,
  selectedModelIds,
  selectionContextWindow,
  staleBanner,
  suggestProviderName,
  suggestedFamilyName,
  summaryErrorPhase,
  summaryPhase,
  toggleModelSelection,
  uniqueProviderName,
  type CatalogDetailView,
} from '../src/modelsDev.ts'

// A hand-written opencode-go-shaped body: 2 openai-compatible models, 2
// anthropic overrides and 1 google override, plus unsupported entries.
function listBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: 'network',
    fetched_at: 1_700_000_000_000,
    truncated: false,
    providers: [
      {
        id: 'opencode-go',
        name: 'OpenCode Go',
        api: 'https://opencode.ai/inference/go/openai/v1',
        env: ['OPENCODE_API_KEY', 'OPENCODE_ZEN_KEY', 'IGNORED_FOURTH'],
        kind: 'openai-compatible',
        kind_source: 'npm',
        rejected: false,
        reject_reason: null,
        needs_base_url: false,
        model_count: 5,
        families: { 'openai-compatible': 2, anthropic: 2, google: 1, unsupported: 0 },
      },
      {
        id: '302ai',
        name: '302.AI',
        api: null,
        env: [],
        kind: 'openai-compatible',
        kind_source: 'guessed',
        rejected: false,
        reject_reason: null,
        needs_base_url: true,
        model_count: 1,
        families: { 'openai-compatible': 1, anthropic: 0, google: 0, unsupported: 0 },
      },
      {
        id: 'amazon-bedrock',
        name: 'Amazon Bedrock',
        api: null,
        env: ['AWS_ACCESS_KEY_ID'],
        kind: null,
        kind_source: null,
        rejected: true,
        reject_reason: 'proprietary-protocol',
        needs_base_url: true,
        model_count: 1,
        families: { 'openai-compatible': 0, anthropic: 0, google: 0, unsupported: 1 },
      },
    ],
    ...overrides,
  }
}

function detailBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: 'network',
    fetched_at: 1_700_000_000_000,
    provider: {
      id: 'opencode-go',
      name: 'OpenCode Go',
      api: 'https://opencode.ai/inference/go/openai/v1',
      env: ['OPENCODE_API_KEY'],
      kind: 'openai-compatible',
      kind_source: 'npm',
      rejected: false,
      reject_reason: null,
      needs_base_url: false,
      model_count: 5,
      families: { 'openai-compatible': 2, anthropic: 2, google: 1, unsupported: 0 },
      truncated: false,
      models: [
        {
          id: 'glm-5.2',
          name: 'GLM 5.2',
          kind: 'openai-compatible',
          mixed_family: false,
          base_url: null,
          context_window: 200000,
          reasoning: true,
          efforts: ['high', 'max'],
        },
        {
          id: 'deepseek-v4.1-flash',
          name: 'DeepSeek V4.1 Flash',
          kind: 'openai-compatible',
          mixed_family: false,
          base_url: null,
          context_window: 1000000,
          reasoning: true,
          efforts: ['low', 'high', 'max'],
        },
        {
          id: 'claude-haiku-5-5',
          name: 'Claude Haiku 5.5',
          kind: 'anthropic',
          mixed_family: true,
          base_url: 'https://opencode.ai/inference/go/anthropic/v1',
          context_window: 1000000,
          reasoning: true,
          efforts: [],
        },
        {
          id: 'claude-opus-5',
          name: 'Claude Opus 5',
          kind: 'anthropic',
          mixed_family: true,
          base_url: 'https://opencode.ai/inference/go/anthropic/v1',
          context_window: 200000,
          reasoning: true,
          efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        },
        {
          id: 'gemini-3-pro',
          name: 'Gemini 3 Pro',
          kind: 'google',
          mixed_family: true,
          base_url: 'https://opencode.ai/inference/go/google/v1beta',
          context_window: 1048576,
          reasoning: true,
          efforts: [],
        },
      ],
    },
    ...overrides,
  }
}

function goDetail(): CatalogDetailView {
  const normalized = normalizeCatalogProviderDetail(detailBody())
  assert.ok(normalized)
  return normalized
}

// -- normalization --------------------------------------------------------------

test('normalizeCatalogProviders: carries source/flags and drops malformed rows', () => {
  const view = normalizeCatalogProviders(listBody({ disabled: false }))
  assert.equal(view.source, 'network')
  assert.equal(view.fetchedAt, 1_700_000_000_000)
  assert.equal(view.upstreamError, null)
  assert.equal(view.disabled, false)
  assert.equal(view.truncated, false)
  assert.deepEqual(
    view.providers.map((provider) => provider.id),
    ['opencode-go', '302ai', 'amazon-bedrock'],
  )
  const go = view.providers[0]
  assert.ok(go)
  assert.equal(go.kind, 'openai-compatible')
  assert.deepEqual(go.families, {
    'openai-compatible': 2,
    anthropic: 2,
    google: 1,
    unsupported: 0,
  })
  assert.equal(go.env.length, 3)

  const malformed = normalizeCatalogProviders({
    source: 'cache',
    providers: [{ id: '', name: 'no id' }, { name: 'no id either' }, 'nope', { id: 'ok' }],
  })
  assert.deepEqual(
    malformed.providers.map((provider) => provider.id),
    ['ok'],
  )
  // unknown kinds degrade to unsupported rather than inventing a family
  assert.equal(malformed.providers[0]?.kind, null)
  assert.equal(malformed.providers[0]?.modelCount, 0)
})

test('normalizeCatalogProviders: a non-array/garbage body is an empty curated view', () => {
  const empty = normalizeCatalogProviders({ providers: 'nope' })
  assert.deepEqual(empty.providers, [])
  assert.equal(empty.source, 'curated')
  for (const garbage of [null, undefined, [], 'body', 7]) {
    const view = normalizeCatalogProviders(garbage)
    assert.deepEqual(view.providers, [], JSON.stringify(garbage))
    assert.equal(view.fetchedAt, null)
  }
})

test('normalizeCatalogProviderDetail: keeps unsupported models and a null base URL', () => {
  const detail = normalizeCatalogProviderDetail(
    detailBody({
      provider: {
        ...(detailBody().provider as Record<string, unknown>),
        models: [
          ...((detailBody().provider as Record<string, unknown>).models as unknown[]),
          {
            id: 'bedrock-model',
            name: 'Bedrock Model',
            kind: null,
            mixed_family: false,
            base_url: null,
            context_window: 0,
            reasoning: false,
            efforts: [],
          },
        ],
      },
    }),
  )
  assert.ok(detail)
  assert.equal(detail?.source, 'network')
  const bedrock = detail?.provider.models.find((model) => model.id === 'bedrock-model')
  assert.equal(bedrock?.kind, null)
  assert.equal(bedrock?.baseUrl, null)
  assert.equal(bedrock?.contextWindow, 0)
  assert.equal(detail?.provider.models.length, 6)
})

test('normalizeCatalogProviderDetail: garbage bodies are null (fail-soft)', () => {
  for (const garbage of [null, {}, { provider: null }, { provider: [] }, 'x']) {
    assert.equal(normalizeCatalogProviderDetail(garbage), null, JSON.stringify(garbage))
  }
  const model = normalizeCatalogModel({ id: 'm', context_window: -5, efforts: ['high', ''] })
  assert.equal(model?.contextWindow, 0, 'negative windows normalize to unknown')
  assert.deepEqual(model?.efforts, ['high'])
})

test('normalizeCatalogProvider: a missing model_count falls back to the family sum', () => {
  const provider = normalizeCatalogProvider({
    id: 'x',
    families: { 'openai-compatible': 2, anthropic: 1, google: 0, unsupported: 1 },
  })
  assert.equal(provider?.modelCount, 4)
})

// -- search ---------------------------------------------------------------------

test('provider search matches id/name/env/kind case-insensitively', () => {
  const providers = normalizeCatalogProviders(listBody()).providers
  assert.equal(filterCatalogProviders(providers, '').length, 3)
  assert.deepEqual(
    filterCatalogProviders(providers, 'OPENCODE').map((provider) => provider.id),
    ['opencode-go'],
  )
  assert.deepEqual(
    filterCatalogProviders(providers, 'opencode_zen').map((provider) => provider.id),
    ['opencode-go'],
  )
  assert.deepEqual(
    filterCatalogProviders(providers, 'openai-compatible').map((provider) => provider.id),
    ['opencode-go', '302ai'],
    'the kind label is searchable too',
  )
  assert.deepEqual(
    filterCatalogProviders(providers, 'anthropic'),
    [],
    'no provider in this list resolves to the anthropic family',
  )
  assert.deepEqual(
    filterCatalogProviders(providers, 'bedrock').map((provider) => provider.id),
    ['amazon-bedrock'],
  )
  assert.deepEqual(filterCatalogProviders(providers, 'zzz'), [])
})

test('model search matches id/name only, and an empty query returns all', () => {
  const models = goDetail().provider.models
  assert.equal(filterCatalogModels(models, '').length, 5)
  assert.deepEqual(
    filterCatalogModels(models, 'CLAUDE').map((model) => model.id),
    ['claude-haiku-5-5', 'claude-opus-5'],
  )
  assert.deepEqual(
    filterCatalogModels(models, 'deepseek').map((model) => model.id),
    ['deepseek-v4.1-flash'],
  )
  assert.deepEqual(filterCatalogModels(models, 'nope'), [])
})

// -- families and base URLs -----------------------------------------------------

test('families group by the resolved per-model kind', () => {
  const detail = goDetail()
  assert.deepEqual(availableFamilies(detail), ['openai-compatible', 'anthropic', 'google'])
  assert.deepEqual(
    familyModels(detail, 'anthropic').map((model) => model.id),
    ['claude-haiku-5-5', 'claude-opus-5'],
  )
  assert.deepEqual(
    familyModels(detail, 'google').map((model) => model.id),
    ['gemini-3-pro'],
  )
  assert.equal(familyModels(detail, 'openai-compatible').length, 2)
  assert.equal(primaryFamily(detail), 'openai-compatible')
  assert.equal(familyLabel('anthropic'), 'Anthropic')
  assert.equal(familyLabel(null), 'Unsupported')
})

test('base URLs: provider api for the primary family, model override otherwise', () => {
  const detail = goDetail()
  assert.equal(
    familyBaseUrl(detail, 'openai-compatible'),
    'https://opencode.ai/inference/go/openai/v1',
  )
  assert.equal(
    familyBaseUrl(detail, 'anthropic'),
    'https://opencode.ai/inference/go/anthropic/v1',
  )
  assert.equal(
    familyBaseUrl(detail, 'google'),
    'https://opencode.ai/inference/go/google/v1beta',
  )
  assert.equal(requiresBaseUrl(detail, 'openai-compatible'), false)
  assert.equal(resolveImportBaseUrl(detail, 'anthropic', ''), 'https://opencode.ai/inference/go/anthropic/v1')
  assert.equal(
    resolveImportBaseUrl(detail, 'anthropic', '  https://typed.example/v1  '),
    'https://typed.example/v1',
  )

  const noApi = normalizeCatalogProviderDetail({
    source: 'curated',
    provider: {
      id: 'bare',
      name: 'Bare',
      api: null,
      env: [],
      kind: 'openai-compatible',
      kind_source: 'guessed',
      rejected: false,
      reject_reason: null,
      needs_base_url: true,
      model_count: 1,
      families: { 'openai-compatible': 1, anthropic: 0, google: 0, unsupported: 0 },
      truncated: false,
      models: [
        {
          id: 'bare-model',
          name: 'Bare Model',
          kind: 'openai-compatible',
          mixed_family: false,
          base_url: null,
          context_window: 32000,
          reasoning: false,
          efforts: [],
        },
      ],
    },
  })
  assert.ok(noApi)
  assert.equal(requiresBaseUrl(noApi, 'openai-compatible'), true)
  assert.equal(familyBaseUrl(noApi, 'openai-compatible'), null)
  assert.equal(resolveImportBaseUrl(noApi, 'openai-compatible', ''), '')
})

// -- selection (§15.6: default NONE + explicit Select all) ------------------------

test('default selection is NONE; Select all chooses the viewed family only', () => {
  const detail = goDetail()
  assert.deepEqual(defaultSelection(), [], '§15.6: nothing is preselected')
  assert.deepEqual(selectAllFamily(detail, 'anthropic'), ['claude-haiku-5-5', 'claude-opus-5'])
  assert.deepEqual(selectAllFamily(detail, 'openai-compatible'), ['glm-5.2', 'deepseek-v4.1-flash'])
  assert.deepEqual(selectAllFamily(detail, null), [])
  // selection is filtered to the viewed family: no cross-family import
  const mixed = ['claude-haiku-5-5', 'glm-5.2']
  assert.deepEqual(selectedModelIds(detail, 'anthropic', mixed), ['claude-haiku-5-5'])
  assert.deepEqual(selectedModelIds(detail, 'openai-compatible', mixed), ['glm-5.2'])
})

test('per-model toggles are pure and order-preserving', () => {
  let selection = defaultSelection()
  selection = toggleModelSelection(selection, 'glm-5.2')
  selection = toggleModelSelection(selection, 'deepseek-v4.1-flash')
  assert.deepEqual(selection, ['glm-5.2', 'deepseek-v4.1-flash'])
  assert.equal(isModelSelected(selection, 'glm-5.2'), true)
  selection = toggleModelSelection(selection, 'glm-5.2')
  assert.deepEqual(selection, ['deepseek-v4.1-flash'])
  const original = ['a']
  assert.notEqual(toggleModelSelection(original, 'b'), original)
  assert.deepEqual(toggleModelSelection(original, ''), ['a'])
})

test('context-window prefill is the smallest positive window of the selection', () => {
  const detail = goDetail()
  assert.equal(selectionContextWindow(detail, ['glm-5.2', 'deepseek-v4.1-flash']), 200000)
  assert.equal(selectionContextWindow(detail, ['claude-opus-5', 'gemini-3-pro']), 200000)
  assert.equal(selectionContextWindow(detail, []), 0)
  assert.equal(selectionContextWindow(detail, ['no-such-model']), 0)
  assert.equal(
    minimumContextWindow([
      { ...goDetail().provider.models[0]!, contextWindow: 0 },
    ]),
    0,
    'a reported 0 (unknown) never becomes the prefill',
  )
})

// -- import gating and payload ----------------------------------------------------

function state(overrides: Record<string, unknown> = {}) {
  return {
    detail: goDetail(),
    family: 'openai-compatible' as const,
    selection: ['glm-5.2', 'deepseek-v4.1-flash'],
    baseUrl: '',
    existingNames: [] as string[],
    ...overrides,
  }
}

test('zero selected models is refused with an honest notice', () => {
  const empty = state({ selection: [] })
  assert.equal(importBlockedReason(empty), 'Select at least one model to import.')
  assert.equal(hardImportBlocker(empty), null, 'the button stays clickable for the notice')
  const refused = buildCatalogImport(empty)
  assert.equal(refused.ok, false)
  if (!refused.ok) assert.match(refused.reason, /at least one model/)
})

test('buildCatalogImport produces the exact Add-form prefill', () => {
  const result = buildCatalogImport(state())
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.value, {
    name: 'opencode-go',
    base_url: 'https://opencode.ai/inference/go/openai/v1',
    kind: 'openai-compatible',
    models: ['glm-5.2', 'deepseek-v4.1-flash'],
    context_window: 200000,
    catalog_id: 'opencode-go',
  })
  // order follows the catalog list, not the click order
  const reordered = buildCatalogImport(
    state({ selection: ['deepseek-v4.1-flash', 'glm-5.2'] }),
  )
  assert.equal(reordered.ok, true)
  if (reordered.ok) {
    assert.deepEqual(reordered.value.models, ['glm-5.2', 'deepseek-v4.1-flash'])
  }
})

test('buildCatalogImport uses the family split name and base URL', () => {
  const result = buildCatalogImport(
    state({
      family: 'anthropic',
      selection: ['claude-haiku-5-5', 'claude-opus-5'],
    }),
  )
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.value.name, 'opencode-go-anthropic')
  assert.equal(result.value.kind, 'anthropic')
  assert.equal(result.value.base_url, 'https://opencode.ai/inference/go/anthropic/v1')
  assert.equal(result.value.context_window, 200000)
  assert.equal(result.value.catalog_id, 'opencode-go')

  const google = buildCatalogImport(state({ family: 'google', selection: ['gemini-3-pro'] }))
  assert.equal(google.ok, true)
  if (google.ok) assert.equal(google.value.name, 'opencode-go-google')
})

test('import refuses rejected, existing, modelless and bad-URL states', () => {
  const rejected = normalizeCatalogProviderDetail({
    source: 'network',
    provider: {
      id: 'bedrock',
      name: 'Bedrock',
      api: null,
      env: [],
      kind: null,
      kind_source: null,
      rejected: true,
      reject_reason: 'proprietary-protocol',
      needs_base_url: true,
      model_count: 0,
      families: { 'openai-compatible': 0, anthropic: 0, google: 0, unsupported: 0 },
      truncated: false,
      models: [],
    },
  })
  assert.ok(rejected)
  assert.match(
    importBlockedReason(state({ detail: rejected, family: null, selection: [] })) ?? '',
    /does not implement/,
  )
  assert.match(
    importBlockedReason(state({ existingNames: ['OPENCODE-GO'] })) ?? '',
    /already in your providers/,
  )
  // The seed `opencode-go` does not block the separate family preset the same
  // catalog entry needs (the OpenCode Go trap), but that preset is checked too.
  assert.equal(
    importBlockedReason(
      state({
        family: 'anthropic',
        selection: ['claude-haiku-5-5'],
        existingNames: ['opencode-go'],
      }),
    ),
    null,
  )
  assert.equal(
    importBlockedReason(
      state({
        family: 'anthropic',
        selection: ['claude-haiku-5-5'],
        existingNames: ['opencode-go-anthropic'],
      }),
    ),
    'This provider is already in your providers.',
  )
  assert.equal(suggestedFamilyName(goDetail(), 'anthropic'), 'opencode-go-anthropic')
  assert.match(
    importBlockedReason(state({ family: null, selection: [] })) ?? '',
    /no models/,
  )
  assert.equal(
    importBlockedReason(state({ family: 'google', selection: ['glm-5.2'] })),
    'Select at least one model to import.',
    'a selection from another family never leaks into this import',
  )
  const bare = state({
    detail: normalizeCatalogProviderDetail({
      source: 'curated',
      provider: {
        id: 'bare',
        name: 'Bare',
        api: null,
        env: [],
        kind: 'openai-compatible',
        kind_source: 'guessed',
        rejected: false,
        reject_reason: null,
        needs_base_url: true,
        model_count: 1,
        families: { 'openai-compatible': 1, anthropic: 0, google: 0, unsupported: 0 },
        truncated: false,
        models: [
          {
            id: 'bare-model',
            name: 'Bare Model',
            kind: 'openai-compatible',
            mixed_family: false,
            base_url: null,
            context_window: 0,
            reasoning: false,
            efforts: [],
          },
        ],
      },
    }),
    selection: ['bare-model'],
  })
  assert.equal(importBlockedReason(bare), 'Enter the base URL for this provider.')
  assert.match(
    importBlockedReason({ ...bare, baseUrl: 'ftp://nope' }) ?? '',
    /http:\/\/ or https:\/\//,
  )
  const noDetail = buildCatalogImport(state({ detail: null }))
  assert.equal(noDetail.ok, false)
  assert.ok(rejectReasonLabel('proprietary-protocol').length > 0)
})

test('provider chips explain the row state', () => {
  const providers = normalizeCatalogProviders(listBody()).providers
  assert.deepEqual(catalogProviderChips(providers[0]!, []), [])
  assert.deepEqual(catalogProviderChips(providers[0]!, ['opencode-go']), [
    'Already in your providers',
  ])
  assert.deepEqual(catalogProviderChips(providers[1]!, []), ['Needs base URL'])
  assert.deepEqual(catalogProviderChips(providers[2]!, []), [
    'Not importable',
    'Needs base URL',
  ])
  assert.equal(providerExists(['Opencode-Go'], 'OPENCODE-GO'), true)
  assert.equal(providerExists([], 'anything'), false)
})

// -- name suggestion --------------------------------------------------------------

test('sanitizeProviderId maps catalog ids onto the provider-id grammar', () => {
  assert.equal(sanitizeProviderId('opencode-go'), 'opencode-go')
  assert.equal(sanitizeProviderId('wafer.ai'), 'wafer-ai')
  assert.equal(sanitizeProviderId('302ai'), 'ai')
  assert.equal(sanitizeProviderId('Some Provider_Name'), 'some-provider-name')
  assert.equal(sanitizeProviderId('...'), 'provider')
  for (const raw of ['wafer.ai', '302ai', 'x_y z']) {
    assert.match(sanitizeProviderId(raw), /^[a-z][a-z0-9-]*$/)
  }
})

test('name suggestion adds a family suffix only for a secondary family', () => {
  const detail = goDetail()
  assert.equal(familyNameSuffix(detail, 'openai-compatible'), '')
  assert.equal(familyNameSuffix(detail, 'anthropic'), '-anthropic')
  assert.equal(familyNameSuffix(detail, 'google'), '-google')
  assert.equal(suggestProviderName(detail, 'openai-compatible', []), 'opencode-go')
  assert.equal(suggestProviderName(detail, 'anthropic', []), 'opencode-go-anthropic')
  assert.equal(
    suggestProviderName(detail, 'anthropic', ['opencode-go-anthropic']),
    'opencode-go-anthropic-2',
  )
  assert.equal(
    suggestProviderName(detail, 'anthropic', [
      'opencode-go-anthropic',
      'opencode-go-anthropic-2',
    ]),
    'opencode-go-anthropic-3',
  )
})

test('uniqueProviderName is case-insensitive and always returns a free id', () => {
  assert.equal(uniqueProviderName('abc', ['ABC']), 'abc-2')
  assert.equal(uniqueProviderName('abc', []), 'abc')
  assert.equal(uniqueProviderName('', []), 'provider')
})

// -- phases, banners and copy -----------------------------------------------------

test('phase helpers: loading copy, empty state, old backend vs error', () => {
  assert.match(CATALOG_LOADING_COPY, /Loading the models\.dev catalog/)
  assert.match(CATALOG_EMPTY_COPY, /no usable providers/)
  assert.equal(summaryPhase(normalizeCatalogProviders({ providers: [{ id: 'a' }] })), 'ready')
  assert.equal(summaryPhase(normalizeCatalogProviders({ providers: [] })), 'empty')
  assert.equal(summaryErrorPhase(404), 'unsupported')
  assert.equal(summaryErrorPhase(500), 'error')
  assert.equal(summaryErrorPhase(0), 'error')
  assert.match(CATALOG_UNSUPPORTED_COPY, /Nothing was changed/)
})

test('detail error copy: 503 is the offline notice, 404 is a vanished entry', () => {
  assert.equal(detailErrorCopy(503, 'anything'), CATALOG_UNAVAILABLE_COPY)
  assert.match(detailErrorCopy(404, ''), /no longer in the catalog/)
  assert.match(detailErrorCopy(500, 'boom'), /boom/)
})

test('banners: disabled > curated > stale, with honest relative time', () => {
  const now = 1_700_000_000_000
  const stale = normalizeCatalogProviders(
    listBody({ source: 'stale', fetched_at: now - 2 * 60 * 60 * 1000, upstream_error: 'HTTP 503' }),
  )
  assert.equal(
    staleBanner(stale, now),
    'Showing a saved catalog from 2 hours ago; the refresh failed.',
  )
  assert.equal(curatedBanner(stale), null)
  assert.equal(disabledBanner(stale), null)
  assert.equal(catalogBanner(stale, now), staleBanner(stale, now))

  const curated = normalizeCatalogProviders(
    listBody({ source: 'curated', fetched_at: null, upstream_error: 'HTTP 503' }),
  )
  assert.match(
    curatedBanner(curated) ?? '',
    /unavailable \(HTTP 503\).*curated provider list/,
  )
  assert.equal(staleBanner(curated, now), null)

  const disabled = normalizeCatalogProviders(
    listBody({ source: 'curated', fetched_at: null, disabled: true }),
  )
  assert.match(disabledBanner(disabled) ?? '', /disabled on this backend/)
  assert.equal(curatedBanner(disabled), null, 'disabled wins over curated copy')
  assert.equal(catalogBanner(disabled, now), disabledBanner(disabled))

  const live = normalizeCatalogProviders(listBody({ source: 'network' }))
  assert.equal(catalogBanner(live, now), null)
  assert.equal(relativeCatalogTime(null), 'an earlier session')
  assert.equal(relativeCatalogTime(now - 30_000, now), 'less than a minute ago')
  assert.equal(relativeCatalogTime(now - 90_000, now), '2 minutes ago')
  assert.equal(relativeCatalogTime(now - 25 * 60 * 60 * 1000, now), '1 day ago')
})

test('the import announcement says nothing is saved yet', () => {
  assert.equal(
    importAnnouncement(2, 'opencode-go'),
    'Imported 2 models from opencode-go into the Add provider form. Nothing is saved yet.',
  )
  assert.match(importAnnouncement(1, 'x'), /^Imported 1 model from x/)
})
