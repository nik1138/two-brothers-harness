/**
 * Dedicated helper-subagent route in Settings (source-level wiring; the form
 * behavior itself is Vue/naive-ui). No DOM/Vue runtime:
 *   node --import ./tests/register-ts.mjs --test tests/settingsSubagent.test.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/${relative}`, import.meta.url)), 'utf8')

test('Settings owns a third helper route with its own model and effort', () => {
  const dialog = read('components/SettingsDialog.vue')
  assert.ok(dialog.includes('const subagent = reactive<RoleForm>'))
  assert.ok(dialog.includes('subagentSupported'))
  assert.ok(dialog.includes("fill('subagent', view.subagent)"))
  assert.ok(dialog.includes("refreshEffortOptions('subagent')"))
  assert.ok(dialog.includes('patch.subagent = entry'))
  assert.ok(dialog.includes("subagent.api_key = ''"))
  assert.ok(dialog.includes('@update:subagent="updateSubagent"'))
  assert.ok(dialog.includes("keySet = reactive({ senior: false, junior: false, subagent: false })"))

  const section = read('components/settings/ModelsRolesSection.vue')
  assert.ok(section.includes('role="subagent"'))
  assert.ok(section.includes('v-if="subagentSupported"'))
  assert.ok(section.includes('effortOptions.subagent'))
  assert.ok(section.includes('effortErrors.subagent'))
  assert.ok(section.includes('update:subagent'))
  assert.ok(
    section.includes('Helper subagents are isolated and request approved workspace changes.'),
  )
  assert.equal(
    section.includes('read-only'),
    false,
    'the helper intro no longer claims read-only',
  )

  const editor = read('components/settings/RoleEditor.vue')
  assert.ok(editor.includes("'senior' | 'junior' | 'subagent'"))
  assert.ok(editor.includes("props.role === 'junior' ? 'Junior' : 'Subagent'"))
  assert.ok(editor.includes('Isolated helper spawned by the Senior'))
  assert.ok(editor.includes('approved workspace changes'))
  assert.equal(editor.includes('Read-only helper'), false)
  assert.ok(editor.includes('.role-card--subagent .role-dot'))

  const api = read('api.ts')
  assert.ok(api.includes('subagent?: RoleSettingsPatch'))
  const types = read('types.ts')
  assert.ok(types.includes('subagent?: RoleSettingsView'))
})
