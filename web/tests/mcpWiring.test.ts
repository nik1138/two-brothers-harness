/**
 * Source-level wiring tests for the MCP web components (the web suite has no
 * DOM/Vue runtime — see tests/AGENTS.md; behavior is covered by mcpStatus /
 * mcpApi, the browser E2E covers rendering). These assert the components bind
 * the view model: Settings nav registration order, the McpSection fetch/error
 * idioms, and the status-dialog MCP block conditions.
 *
 * Run with: node --import ./tests/register-ts.mjs --test tests/mcpWiring.test.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/${relative}`, import.meta.url)), 'utf8')

test('Settings nav registers MCP directly after Plugins, with a pane and an icon', () => {
  const dialog = read('components/SettingsDialog.vue')
  const pluginsIdx = dialog.indexOf("id: 'plugins'")
  const mcpIdx = dialog.indexOf("id: 'mcp'")
  const permissionsIdx = dialog.indexOf("id: 'permissions'")
  assert.ok(pluginsIdx !== -1 && mcpIdx !== -1 && permissionsIdx !== -1)
  assert.ok(pluginsIdx < mcpIdx && mcpIdx < permissionsIdx, 'MCP sits directly after Plugins')
  assert.ok(dialog.includes("| 'mcp'"), 'SectionId includes mcp')
  assert.ok(dialog.includes("import McpSection from './settings/McpSection.vue'"))
  assert.ok(dialog.includes("v-show=\"activeId === 'mcp'\""))
  assert.ok(dialog.includes('aria-label="MCP"'))
  assert.ok(dialog.includes("<McpSection />"))
  assert.ok(dialog.includes("section.id === 'mcp'"), 'nav has a dedicated icon branch')
})

test('McpSection fetches on mount, owns the empty state and surfaces API errors', () => {
  const section = read('components/settings/McpSection.vue')
  assert.ok(section.includes("from '../../api'"))
  assert.ok(section.includes('getMcpStatus'))
  assert.ok(section.includes('onMounted('), 'fetches on mount like the house pattern')
  assert.ok(section.includes('MCP_EMPTY_MESSAGE'))
  assert.ok(section.includes('mcpSectionRows(status.configured)'))
  assert.ok(section.includes('status.configured.length === 0'), 'empty state branch')
  assert.ok(section.includes('role="alert"'), 'API failure uses the error-text pattern')
  assert.ok(section.includes('row.target'))
  assert.ok(section.includes(':title="row.target"'), 'target rides a tooltip')
  assert.ok(section.includes('row.badge'))
  assert.ok(section.includes('row.transport'))
  assert.ok(section.includes('var(--ok)') === false, 'no invented colours')
  assert.ok(!section.includes('updateMcp'), 'read-only v1: no editing controls')
})

test('SessionStatusDialog shows the MCP block only for a non-null lastRun, with failure emphasis', () => {
  const dialog = read('components/SessionStatusDialog.vue')
  assert.ok(dialog.includes('mcp?: McpStatus | null'))
  assert.ok(dialog.includes('v-if="mcpBlock"'), 'block hidden unless a last run exists')
  assert.ok(dialog.includes('mcpBlockVisible'))
  assert.ok(dialog.includes('mcpStatusBlock'))
  assert.ok(dialog.includes('mcpBlock.title'))
  assert.ok(dialog.includes('mcpBlock.timeText'))
  assert.ok(dialog.includes('mcpBlock.failedCount'), 'failed count drives red emphasis')
  assert.ok(dialog.includes("row.ok ? '✓' : '✗'"))
  assert.ok(dialog.includes('row.detail'), 'N tools or the bounded error')
  assert.ok(dialog.includes('status-mcp-row--failed'))
  assert.ok(dialog.includes('var(--danger)'), 'failure emphasis reuses the danger token')
  assert.ok(dialog.includes('var(--ok)'), 'connected mark reuses the ok token')
})

test('App.vue loads MCP status when /status opens and passes it down', () => {
  const app = read('App.vue')
  assert.ok(app.includes('getMcpStatus'))
  assert.ok(app.includes('loadMcpStatus'))
  assert.ok(app.includes('mcpStatus = ref<McpStatus | null>(null)'))
  assert.ok(app.includes('statusOpen.value = true'))
  assert.ok(app.includes('void loadMcpStatus()'))
  assert.ok(app.includes(':mcp="mcpStatus"'))
  assert.ok(app.includes("| 'mcp'"), 'SettingsSection deep-link union includes mcp')
})
