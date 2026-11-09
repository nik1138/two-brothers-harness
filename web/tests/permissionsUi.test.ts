/**
 * Source-level contract for the Permissions UI (no DOM/Vue runtime):
 * Settings exposes a Permissions section, `/permission` deep-links to it, the
 * composer seat opens it, and the live usage frame updates the footer instead
 * of inventing a timeline row. These are wiring assertions that the pure
 * model tests cannot see.
 *
 * Run with: node --import ./tests/register-ts.mjs --test tests/permissionsUi.test.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/${relative}`, import.meta.url)), 'utf8')

test('Settings exposes Permissions (not Approvals) and accepts an initial section', () => {
  const source = read('components/SettingsDialog.vue')
  assert.ok(source.includes("import PermissionsSection from './settings/PermissionsSection.vue'"))
  assert.ok(source.includes("id: 'permissions'"))
  assert.ok(source.includes("label: 'Permissions'"))
  assert.ok(source.includes('initialSection?: SectionId'))
  assert.ok(source.includes("ref<SectionId>(props.initialSection ?? 'models')"))
  assert.ok(source.includes('v-show="activeId === \'permissions\'"'))
  assert.ok(source.includes('aria-label="Permissions"'))
  assert.ok(!source.includes("id: 'approvals'"), 'the old Approvals section id is gone')
  assert.ok(!source.includes('ApprovalPolicySection'), 'the old section component is gone')
})

test('PermissionsSection renders the preset catalog with its stored mode and danger', () => {
  const source = read('components/settings/PermissionsSection.vue')
  assert.ok(source.includes('PERMISSION_PRESETS'))
  assert.ok(source.includes('PERMISSION_PRESET_COPY'))
  assert.ok(source.includes('permissionPresetId'))
  assert.ok(source.includes('permissionPresetDanger'))
  assert.ok(source.includes('stores mode:'))
  assert.ok(source.includes('danger-full-access'))
  assert.ok(source.includes('role="radiogroup"'))
})

test('App deep-links /permission and the composer seat to the Permissions pane', () => {
  const app = read('App.vue')
  assert.ok(app.includes('const settingsSection = ref<SettingsSection>'))
  assert.ok(app.includes('function openSettings(section: SettingsSection'))
  assert.ok(app.includes("openSettings('permissions')"))
  assert.ok(app.includes(':initial-section="settingsSection"'))
  assert.ok(app.includes('@open-permissions="openSettings(\'permissions\')"'))

  const composer = read('components/Composer.vue')
  assert.ok(composer.includes('openPermissions: []'))
  assert.ok(composer.includes("seat.id === 'permissions'"))
  assert.ok(composer.includes("emit('openPermissions')"))

  const info = read('components/PermissionInfoDialog.vue')
  assert.ok(info.includes('Open Permissions'))
  assert.ok(info.includes('Always ask'))
  assert.ok(info.includes('Workspace write'))
})

test('the live usage frame updates the footer counters, not the timeline', () => {
  const types = read('types.ts')
  assert.ok(types.includes('export interface UsageEvent'))
  assert.ok(types.includes('| UsageEvent'))

  const app = read('App.vue')
  assert.ok(app.includes("case 'usage':"))
  assert.ok(app.includes('runUsageBySession.value = { ...runUsageBySession.value, [run.session]: data.usage }'))
  // A new followed head must not show the previous run's tokens/cache/cost.
  assert.ok(app.includes('function forgetSessionUsage(session: string)'))
  assert.ok(app.includes('forgetSessionUsage(res.session)'))
  assert.ok(app.includes('forgetSessionUsage(session)'))

  const footer = read('components/UsageFooter.vue')
  assert.ok(footer.includes('cache {{ cachePct }}%'))
  assert.ok(footer.includes('cached ${usage.cached_tokens.toLocaleString'))
  // Counters now render for live/waiting runs too, outside the post-run v-else.
  assert.ok(footer.includes('Counters appear as soon as the backend reports them'))
})
