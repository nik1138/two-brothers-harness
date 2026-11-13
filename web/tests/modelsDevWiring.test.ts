/**
 * Source wiring for the models.dev browser (no DOM): the API client exports the
 * two read-only calls, the dialog is mounted only from Settings → Providers'
 * closed Add row, the Add form carries the context window + invisible
 * catalog_id, and catalog strings are rendered as text.
 *   node --import ./tests/register-ts.mjs --test tests/modelsDevWiring.test.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/${relative}`, import.meta.url)), 'utf8')

test('the API client exposes the two read-only catalog calls', () => {
  const api = read('api.ts')
  assert.ok(api.includes('listModelsDevProviders'))
  assert.ok(api.includes('getModelsDevProvider'))
  assert.ok(api.includes('/api/models-dev/providers'))
  assert.ok(api.includes('request<ModelsDevProvidersResponse>'))
  assert.ok(api.includes('encodeURIComponent(id)'), 'the detail id is URL-encoded')
})

test('the browser is mounted only from the closed Add-action row', () => {
  const section = read('components/settings/ProvidersSection.vue')
  assert.ok(section.includes('Browse models.dev…'))
  assert.ok(section.includes('<ModelsDevBrowser'))
  assert.ok(section.includes('v-if="browseOpen"'))
  assert.ok(section.includes('@import="handleCatalogImport"'))
  assert.ok(section.includes(':existing-names="providerNames"'))
  assert.ok(section.includes('Nothing is saved until you add it.'))

  // The row (and its note) exist only while the Add card is closed.
  const rowStart = section.indexOf('class="provider-add-row"')
  assert.ok(rowStart > 0)
  const row = section.slice(rowStart - 120, rowStart + 700)
  assert.ok(row.includes('v-if="!addOpen"'))

  // No catalog fetch on a Settings render: only the dialog fetches.
  assert.ok(!section.includes('listModelsDevProviders'))
  const mounted = section.slice(section.indexOf('onMounted('), section.indexOf('</script>'))
  assert.ok(!mounted.includes('getModelsDevProvider'))
})

test('the Add form carries the context window and the invisible catalog_id', () => {
  const section = read('components/settings/ProvidersSection.vue')
  assert.ok(section.includes('addContextWindow'))
  assert.ok(section.includes('addContextWindowError'))
  assert.ok(section.includes('addCatalogId'))
  assert.ok(section.includes('function openAdd(prefill?: CatalogImport)'))
  assert.ok(section.includes('if (window.value > 0) body.context_window = window.value'))
  assert.ok(section.includes('if (addCatalogId.value) body.catalog_id = addCatalogId.value'))
  assert.ok(section.includes('parseProviderContextWindow(addContextWindow.value)'))
  assert.ok(section.includes('addApiKeyInput.value?.focus()'))
  assert.ok(section.includes('Context window is the smallest window among the selected models'))
  // The close path resets every new field.
  const closeAdd = section.slice(
    section.indexOf('function closeAdd()'),
    section.indexOf('function onAddModelsChange'),
  )
  assert.ok(closeAdd.includes('addContextWindow.value ='))
  assert.ok(closeAdd.includes('addCatalogId.value = null'))
})

test('the dialog is fail-soft, bounded, accessible and never renders HTML', () => {
  const browser = read('components/settings/ModelsDevBrowser.vue')
  assert.ok(browser.includes('CATALOG_LOADING_COPY'))
  assert.ok(browser.includes('CATALOG_UNSUPPORTED_COPY'))
  assert.ok(browser.includes('catalogBanner'))
  assert.ok(browser.includes('Select all ('))
  assert.ok(browser.includes('Nothing is preselected'))
  assert.ok(browser.includes('n-checkbox'))
  assert.ok(browser.includes('role="alert"'))
  assert.ok(
    browser.includes("'aria-label': 'Search providers'"),
    'the search label reaches the inner input (input-props)',
  )
  assert.ok(!browser.includes('v-html'))
  // The dialog is a single AppDialog; the section does not wrap it in another.
  assert.equal((browser.match(/<AppDialog/g) ?? []).length, 1)
  const model = read('modelsDev.ts')
  assert.ok(model.includes('Select at least one model to import.'))
  assert.ok(model.includes('Nothing is saved yet'))
  assert.ok(model.includes('models.dev catalog'))
})
