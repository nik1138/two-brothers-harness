// Focused tests for src/helpAliases.ts (display-time alias filtering for the
// help surfaces) plus the resolution guarantees it must not break:
//   node --import ./tests/register-ts.mjs --test tests/helpAliases.test.ts

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { displayCommandAliases } from '../src/helpAliases.ts'
import {
  findBaseCommand,
  isTypeableCommandToken,
  resolveTypedCommand,
} from '../src/basecommands.ts'
import type { BaseCommand } from '../src/types.ts'

function base(overrides: Partial<BaseCommand> = {}): BaseCommand {
  return {
    name: 'plan',
    aliases: ['计划'],
    description: 'Agree an ordered plan',
    argumentHint: '<objective>',
    kind: 'prompt',
    requiresArguments: true,
    priority: 100,
    ...overrides,
  }
}

test('displayCommandAliases keeps ASCII aliases', () => {
  const command = base({ aliases: ['objective', '目标'] })
  assert.deepEqual(displayCommandAliases(command), ['objective'])
})

test('displayCommandAliases drops the Chinese reference spellings', () => {
  const catalog: BaseCommand[] = [
    base({ name: 'plan', aliases: ['计划'] }),
    base({ name: 'compact', aliases: ['压缩'] }),
    base({ name: 'objective', aliases: ['objective', '目标'] }),
    base({ name: 'export', aliases: ['export-md', '导出'], kind: 'action' }),
    base({ name: 'permission', aliases: ['permissions', '权限'], kind: 'action' }),
    base({ name: 'feedback', aliases: ['bug', 'review', '反馈'], kind: 'action' }),
  ]
  for (const command of catalog) {
    for (const alias of displayCommandAliases(command)) {
      assert.ok(isTypeableCommandToken(alias), `${alias} rendered for /${command.name}`)
    }
  }
  assert.deepEqual(displayCommandAliases(catalog[0]), [])
  assert.deepEqual(displayCommandAliases(catalog[2]), ['objective'])
  assert.deepEqual(displayCommandAliases(catalog[4]), ['permissions'])
  assert.deepEqual(displayCommandAliases(catalog[5]), ['bug', 'review'])
})

test('displayCommandAliases leaves an all-ASCII alias list unchanged', () => {
  const command = base({ aliases: ['bug', 'review'] })
  assert.deepEqual(displayCommandAliases(command), ['bug', 'review'])
})

test('typing a non-ASCII alias still resolves to the command', () => {
  const catalog = [base({ name: 'objective', aliases: ['objective', '目标'] })]
  const found = findBaseCommand(catalog, '目标')
  assert.equal(found?.name, 'objective')

  const resolution = resolveTypedCommand(catalog, [], '目标')
  assert.equal(resolution.kind, 'base-prompt')
  assert.equal(resolution.command.name, 'objective')
  assert.equal(resolution.spelling, 'non-ascii-alias')
  assert.equal(resolution.matchedAlias, '目标')
})

test('typing an ASCII alias still resolves to the command', () => {
  const catalog = [base({ name: 'goal', aliases: ['objective', '目标'] })]
  const resolution = resolveTypedCommand(catalog, [], 'objective')
  assert.equal(resolution.kind, 'base-prompt')
  assert.equal(resolution.spelling, 'ascii-alias')
  assert.equal(resolution.typeable, true)
})
