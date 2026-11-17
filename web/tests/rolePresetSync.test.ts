/**
 * Role-editor preset base URL sync: pure helper unit tests plus the
 * source-level wiring that keeps all three role paths on it. No DOM/Vue
 * runtime:
 *   node --import ./tests/register-ts.mjs --test tests/rolePresetSync.test.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { applyRolePatch, presetBaseUrlFor, presetModelsFor, roleModelSelectOptions } from '../src/rolePresetSync.ts'
import type { ProviderPreset } from '../src/types.ts'

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/${relative}`, import.meta.url)), 'utf8')

function preset(name: string, baseUrl: string, models: string[] = []): ProviderPreset {
  return {
    name,
    base_url: baseUrl,
    api_key_set: false,
    kind: 'openai-compatible',
    models,
    context_window: 0,
    seed: true,
  }
}

const PROVIDERS = [
  preset('lmstudio', 'http://localhost:1234/v1', ['spark-x2.6-4b@q4_k_m', ' qwen3-8b ']),
  preset('opencode', 'https://opencode.example/v1'),
]

interface Form {
  provider: string
  model: string
  base_url: string
  api_key: string
  providerRef: string
  effort: string
}

function form(overrides: Partial<Form> = {}): Form {
  return {
    provider: '',
    model: '',
    base_url: '',
    api_key: '',
    providerRef: '',
    effort: '',
    ...overrides,
  }
}

test('presetBaseUrlFor resolves a known ref case-insensitively', () => {
  assert.equal(presetBaseUrlFor(PROVIDERS, 'lmstudio'), 'http://localhost:1234/v1')
  assert.equal(presetBaseUrlFor(PROVIDERS, 'LMStudio'), 'http://localhost:1234/v1')
  assert.equal(presetBaseUrlFor(PROVIDERS, '  lmstudio  '), 'http://localhost:1234/v1')
})

test('presetBaseUrlFor returns null for Manual, blank and unknown refs', () => {
  assert.equal(presetBaseUrlFor(PROVIDERS, ''), null)
  assert.equal(presetBaseUrlFor(PROVIDERS, '   '), null)
  assert.equal(presetBaseUrlFor(PROVIDERS, 'ghost'), null)
  assert.equal(presetBaseUrlFor(PROVIDERS, null), null)
  assert.equal(presetBaseUrlFor([], 'lmstudio'), null)
})

test('applyRolePatch syncs base_url when a preset is selected', () => {
  const stale = form({ providerRef: 'opencode', base_url: 'https://opencode.example/v1' })
  applyRolePatch(stale, { providerRef: 'lmstudio' }, PROVIDERS)
  assert.equal(stale.providerRef, 'lmstudio')
  assert.equal(stale.base_url, 'http://localhost:1234/v1')
})

test('applyRolePatch matches the preset case-insensitively', () => {
  const f = form({ providerRef: '', base_url: '' })
  applyRolePatch(f, { providerRef: 'LMSTUDIO' }, PROVIDERS)
  assert.equal(f.base_url, 'http://localhost:1234/v1')
})

test('applyRolePatch leaves base_url untouched on Manual', () => {
  const f = form({ providerRef: 'lmstudio', base_url: 'http://localhost:1234/v1' })
  applyRolePatch(f, { providerRef: '' }, PROVIDERS)
  assert.equal(f.providerRef, '')
  assert.equal(f.base_url, 'http://localhost:1234/v1')
})

test('applyRolePatch leaves base_url untouched on an unknown ref', () => {
  const manual = form({ base_url: 'http://127.0.0.1:9/v1' })
  applyRolePatch(manual, { providerRef: 'ghost' }, PROVIDERS)
  assert.equal(manual.providerRef, 'ghost')
  assert.equal(manual.base_url, 'http://127.0.0.1:9/v1')
})

test('applyRolePatch without a providerRef never touches base_url', () => {
  const f = form({ base_url: 'http://127.0.0.1:9/v1' })
  applyRolePatch(f, { model: 'spark-x2.6-4b@q4_k_m' }, PROVIDERS)
  assert.equal(f.base_url, 'http://127.0.0.1:9/v1')
  applyRolePatch(f, { base_url: 'http://127.0.0.1:9/v1' }, PROVIDERS)
  assert.equal(f.base_url, 'http://127.0.0.1:9/v1')
})

test('SettingsDialog routes all three role patches through applyRolePatch', () => {
  const dialog = read('components/SettingsDialog.vue')
  assert.ok(dialog.includes("import { applyRolePatch } from '../rolePresetSync'"))
  for (const role of ['senior', 'junior', 'subagent']) {
    assert.ok(
      dialog.includes(`applyRolePatch(${role}, patch, providers.value)`),
      `${role} update must sync base_url from the selected preset`,
    )
  }
  assert.ok(!dialog.includes('Object.assign(senior, patch)'), 'no stale raw assign left')
})

// -- searchable model selector -------------------------------------------------

test('presetModelsFor returns the declared models, trimmed and de-blanked', () => {
  assert.deepEqual(presetModelsFor(PROVIDERS, 'lmstudio'), ['spark-x2.6-4b@q4_k_m', 'qwen3-8b'])
  assert.deepEqual(presetModelsFor(PROVIDERS, 'LMSTUDIO'), ['spark-x2.6-4b@q4_k_m', 'qwen3-8b'])
})

test('presetModelsFor returns an empty list for a model-less preset', () => {
  assert.deepEqual(presetModelsFor(PROVIDERS, 'opencode'), [])
})

test('presetModelsFor returns null for Manual, blank and deleted refs', () => {
  assert.equal(presetModelsFor(PROVIDERS, ''), null)
  assert.equal(presetModelsFor(PROVIDERS, '  '), null)
  assert.equal(presetModelsFor(PROVIDERS, 'ghost'), null)
  assert.equal(presetModelsFor([], 'lmstudio'), null)
})

test('roleModelSelectOptions lists preset models as plain options', () => {
  const options = roleModelSelectOptions(['a', 'b'], '')
  assert.deepEqual(options, [
    { label: 'a', value: 'a', custom: false },
    { label: 'b', value: 'b', custom: false },
  ])
})

test('roleModelSelectOptions keeps an undeclared current model visible as custom', () => {
  const options = roleModelSelectOptions(['a', 'b'], 'my-custom-7b')
  assert.deepEqual(options[0], { label: 'my-custom-7b (custom)', value: 'my-custom-7b', custom: true })
  assert.equal(options.length, 3)
})

test('roleModelSelectOptions does not duplicate a declared current model', () => {
  const options = roleModelSelectOptions(['a', 'b'], 'b')
  assert.deepEqual(
    options.map((option) => option.value),
    ['a', 'b'],
  )
  assert.ok(options.every((option) => !option.custom))
})

test('roleModelSelectOptions ignores a blank current model', () => {
  assert.deepEqual(
    roleModelSelectOptions(['a'], '   ').map((option) => option.value),
    ['a'],
  )
})

test('RoleEditor uses a filterable+tag model selector fed by presetModelsFor', () => {
  const editor = read('components/settings/RoleEditor.vue')
  assert.ok(editor.includes("import { presetModelsFor, roleModelSelectOptions } from '../../rolePresetSync'"))
  assert.ok(editor.includes('filterable'), 'selector must be keyboard-searchable')
  assert.ok(editor.includes('tag'), 'selector must accept arbitrary custom model ids')
  assert.ok(editor.includes('presetModelsFor(props.providers, props.form.providerRef)'))
  // provider changes alone must not rewrite the model: the connection handler
  // patches only providerRef, and applyRolePatch syncs base_url only.
  assert.ok(editor.includes("patch({ providerRef: typeof value === 'string' ? value : '' })"))
})

test('ModelsRolesSection feeds providers to all three role editors', () => {
  const section = read('components/settings/ModelsRolesSection.vue')
  assert.ok(section.includes('providers: ProviderPreset[]'))
  const occurrences = section.split(':providers="providers"').length - 1
  assert.equal(occurrences, 3, 'senior, junior and subagent editors all receive providers')
})

test('SettingsDialog passes providers into ModelsRolesSection', () => {
  const dialog = read('components/SettingsDialog.vue')
  assert.ok(dialog.includes(':providers="providers"'))
})
