// Focused tests for src/basecommands.ts (the `/` menu's first-party command
// model) and the matching api.ts wiring. No DOM; mocked fetch keeps the API
// checks offline:
//   node --import ./tests/register-ts.mjs --test tests/basecommands.test.ts

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  BASE_COMMAND_ACTIONS,
  BASE_COMMAND_GROUP_LABEL,
  DISCOVERED_COMMAND_GROUP_LABEL,
  baseCommandMatchesQuery,
  commandSectionCount,
  commandUsageLine,
  findBaseCommand,
  isBaseCommandAction,
  mergeCommandSections,
  normalizeBaseCommands,
  parseSubmittedCommand,
  resolveTypedCommand,
} from '../src/basecommands.ts'
import type { ComposerCommandRequest } from '../src/basecommands.ts'
import { MAX_COMMAND_ITEMS, MENTION_FOOTER_HINT_COMMAND } from '../src/mentions.ts'
import { ApiError, compactSession, listCommands } from '../src/api.ts'
import type { BaseCommand, CommandInfo } from '../src/types.ts'

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

function action(name: string, overrides: Partial<BaseCommand> = {}): BaseCommand {
  return base({
    name,
    aliases: [],
    description: `${name} description`,
    argumentHint: '',
    kind: 'action',
    action: 'compact',
    requiresArguments: false,
    priority: 50,
    ...overrides,
  })
}

function command(name: string, overrides: Partial<CommandInfo> = {}): CommandInfo {
  return {
    name,
    description: `${name} description`,
    argumentHint: '',
    file: `/commands/${name}.md`,
    ...overrides,
  }
}

const rowNames = (items: Array<{ label: string }>): string[] => items.map((item) => item.label)

// -- normalization ------------------------------------------------------------

test('normalizeBaseCommands tolerates junk, dedupes and fills defaults', () => {
  assert.deepEqual(normalizeBaseCommands(null), [])
  assert.deepEqual(normalizeBaseCommands(undefined), [])
  assert.deepEqual(normalizeBaseCommands([null, 7, 'nope', {}, { name: '' }, { name: 'x' }]), [])

  const normalized = normalizeBaseCommands([
    { name: '/plan', kind: 'prompt', aliases: ['计划', '计划', ''], priority: 10 },
    { name: 'PLAN', kind: 'action', action: 'compact' }, // duplicate name (case-insens)
    { name: 'mystery', kind: 'action', action: 'teleport' }, // unknown action kept honestly
    { name: 'badkind', kind: 'nonsense' },
  ])
  assert.deepEqual(normalized.map((entry) => entry.name), ['plan', 'mystery'])
  assert.deepEqual(normalized[0]?.aliases, ['计划'])
  assert.equal(normalized[0]?.description, '')
  assert.equal(normalized[0]?.requiresArguments, false)
  assert.equal(normalized[0]?.priority, 10)
  assert.equal(normalized[1]?.kind, 'action')
  assert.equal(normalized[1]?.action, undefined, 'an unknown action stays unset')
})

test('normalizeBaseCommands sorts by priority desc, then name', () => {
  const sorted = normalizeBaseCommands([
    base({ name: 'zeta', priority: 10 }),
    base({ name: 'beta', priority: 50 }),
    base({ name: 'alpha', priority: 50 }),
    base({ name: 'early', priority: 90 }),
  ])
  assert.deepEqual(sorted.map((entry) => entry.name), ['early', 'alpha', 'beta', 'zeta'])
})

test('isBaseCommandAction lists exactly the supported surface actions', () => {
  assert.deepEqual(
    [...BASE_COMMAND_ACTIONS].sort(),
    ['compact', 'export', 'help', 'mode', 'new', 'permission', 'status'],
  )
  for (const value of BASE_COMMAND_ACTIONS) assert.equal(isBaseCommandAction(value), true)
  for (const value of [null, undefined, '', 'teleport', 7, {}]) {
    assert.equal(isBaseCommandAction(value), false, String(value))
  }
})

// -- lookup & resolution ------------------------------------------------------

test('findBaseCommand resolves canonical names and aliases case-insensitively', () => {
  const catalog = [base(), action('compact', { aliases: ['压缩'] })]
  assert.equal(findBaseCommand(catalog, 'plan')?.name, 'plan')
  assert.equal(findBaseCommand(catalog, 'PLAN')?.name, 'plan')
  assert.equal(findBaseCommand(catalog, '/plan')?.name, 'plan')
  assert.equal(findBaseCommand(catalog, '计划')?.name, 'plan')
  assert.equal(findBaseCommand(catalog, '压缩')?.name, 'compact')
  assert.equal(findBaseCommand(catalog, 'nope'), null)
  assert.equal(findBaseCommand(catalog, ''), null)
  assert.equal(findBaseCommand(null, 'plan'), null)
})

test('resolveTypedCommand: discovered wins, then base names, then aliases', () => {
  const catalog = [
    base({ name: 'plan' }),
    action('compact', { aliases: ['压缩'] }),
    base({ name: 'goal', kind: 'prompt', requiresArguments: true }),
  ]
  assert.deepEqual(resolveTypedCommand(catalog, [], 'compact'), {
    kind: 'base-action',
    command: catalog[1],
  })
  assert.equal(resolveTypedCommand(catalog, [], '压缩').kind, 'base-action')
  assert.equal(resolveTypedCommand(catalog, [], 'goal').kind, 'base-prompt')
  assert.equal(resolveTypedCommand(catalog, [], 'nope').kind, 'unknown')
  // a discovered template named like a base action shadows it (no local action)
  assert.deepEqual(resolveTypedCommand(catalog, [command('compact')], 'compact'), {
    kind: 'discovered',
    command: command('compact'),
  })
  assert.equal(resolveTypedCommand(catalog, [command('compact')], '/COMPACT').kind, 'discovered')
})

test('parseSubmittedCommand recognises only one leading /command line', () => {
  assert.deepEqual(parseSubmittedCommand('/plan ship it'), { token: 'plan', args: 'ship it' })
  assert.deepEqual(parseSubmittedCommand('  /compact  '), { token: 'compact', args: '' })
  assert.deepEqual(parseSubmittedCommand('/plan\nmulti\nline args'), {
    token: 'plan',
    args: 'multi\nline args',
  })
  assert.equal(parseSubmittedCommand('hello /plan'), null)
  assert.equal(parseSubmittedCommand('/ plan'), null)
  assert.equal(parseSubmittedCommand('/'), null)
  assert.equal(parseSubmittedCommand(''), null)
  assert.equal(parseSubmittedCommand(null), null)
  assert.equal(parseSubmittedCommand(7), null)
})

test('commandUsageLine renders the usage line', () => {
  assert.equal(commandUsageLine(base()), '/plan <objective>')
  assert.equal(commandUsageLine(action('compact')), '/compact')
})

// -- merging the picker sections ---------------------------------------------

test('mergeCommandSections: fallback without base commands still shows discovered', () => {
  const sections = mergeCommandSections([command('zeta'), command('alpha')], undefined)
  assert.deepEqual(
    sections.map((section) => [section.id, section.label]),
    [
      ['base', BASE_COMMAND_GROUP_LABEL],
      ['discovered', DISCOVERED_COMMAND_GROUP_LABEL],
    ],
  )
  assert.deepEqual(sections[0]?.items, [])
  assert.deepEqual(rowNames(sections[1]?.items ?? []), ['/alpha', '/zeta'])
})

test('mergeCommandSections: Built-in first by priority, then alphabetical Commands', () => {
  const sections = mergeCommandSections(
    [command('review'), command('export')],
    [base({ name: 'plan', priority: 100 }), action('compact', { priority: 95 })],
  )
  assert.deepEqual(rowNames(sections[0]?.items ?? []), ['/plan', '/compact'])
  assert.deepEqual(rowNames(sections[1]?.items ?? []), ['/export', '/review'])

  const prompt = sections[0]?.items[0]
  assert.equal(prompt?.base, true)
  assert.equal(prompt?.token, '/plan')
  assert.equal(prompt?.requiresArguments, true)
  assert.equal(prompt?.action, undefined)
  assert.deepEqual(prompt?.aliases, ['计划'])
  assert.match(prompt?.hint ?? '', /Agree an ordered plan/)
  assert.match(prompt?.hint ?? '', /<objective>/)

  const compact = sections[0]?.items[1]
  assert.equal(compact?.action, 'compact')
  assert.equal(compact?.token, '/compact')
  assert.equal(compact?.base, true)
})

test('mergeCommandSections: a discovered command shadows its base namesake', () => {
  const sections = mergeCommandSections(
    [command('plan')],
    [base({ name: 'plan', priority: 100 }), action('compact', { priority: 90 })],
  )
  assert.deepEqual(rowNames(sections[0]?.items ?? []), ['/compact'], 'shadowed base row is hidden')
  assert.deepEqual(rowNames(sections[1]?.items ?? []), ['/plan'])
  assert.equal(sections[1]?.items[0]?.base, false)
})

test('mergeCommandSections: alias/description/hint search, explicit empty states', () => {
  const catalog = [
    base({ name: 'plan', aliases: ['计划'], description: 'Agree an ordered plan' }),
    action('compact', { aliases: ['压缩'], description: 'Compact the conversation context' }),
    base({
      name: 'help',
      aliases: [],
      kind: 'action',
      action: 'help',
      description: 'List commands',
      priority: 40,
    }),
  ]
  const discover = [command('review', { description: 'Review a diff' })]

  assert.deepEqual(
    rowNames(mergeCommandSections(discover, catalog, '计划')[0]?.items ?? []),
    ['/plan'],
    'Chinese alias search',
  )
  assert.deepEqual(
    rowNames(mergeCommandSections(discover, catalog, '压缩')[0]?.items ?? []),
    ['/compact'],
  )
  assert.deepEqual(
    rowNames(mergeCommandSections(discover, catalog, 'diff')[1]?.items ?? []),
    ['/review'],
    'discovered description search',
  )
  assert.deepEqual(
    rowNames(mergeCommandSections(discover, catalog, 'ordered plan')[0]?.items ?? []),
    ['/plan'],
    'multi-word match',
  )
  // no match: both sections exist but carry no rows
  const none = mergeCommandSections(discover, catalog, 'zzzz')
  assert.equal(commandSectionCount(none), 0)
  assert.equal(baseCommandMatchesQuery(catalog[0]!, 'zzzz'), false)
})

test('mergeCommandSections caps discovered rows for the menu', () => {
  const many = Array.from({ length: MAX_COMMAND_ITEMS + 5 }, (_, i) =>
    command(`cmd-${String(i).padStart(2, '0')}`),
  )
  const sections = mergeCommandSections(many, [])
  assert.equal(sections[1]?.items.length, MAX_COMMAND_ITEMS)
})

test('the command footer hint mentions insert/run', () => {
  assert.match(MENTION_FOOTER_HINT_COMMAND, /insert\/run/)
  assert.match(MENTION_FOOTER_HINT_COMMAND, /Esc close/)
})

// -- api.ts wiring (mocked fetch) --------------------------------------------

interface FakeResponse {
  ok: boolean
  status: number
  json: () => Promise<unknown>
}

function fakeResponse(status: number, body: unknown): FakeResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

async function withFetch(
  impl: (url: string, init?: RequestInit) => Promise<FakeResponse>,
  run: (calls: { url: string; init?: RequestInit }[]) => Promise<void>,
): Promise<void> {
  const calls: { url: string; init?: RequestInit }[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: typeof input === 'string' ? input : String(input), init })
    return impl(typeof input === 'string' ? input : String(input), init)
  }) as typeof fetch
  try {
    await run(calls)
  } finally {
    globalThis.fetch = original
  }
}

test('listCommands: baseCommands defaults to [] on an older backend', async () => {
  await withFetch(
    async () => fakeResponse(200, { commands: [command('review')], diagnostics: [] }),
    async () => {
      const result = await listCommands()
      assert.deepEqual(result.commands.map((entry) => entry.name), ['review'])
      assert.deepEqual(result.baseCommands, [])
    },
  )
  await withFetch(
    async () => fakeResponse(200, { commands: [], baseCommands: [base()], diagnostics: ['d'] }),
    async () => {
      const result = await listCommands()
      assert.deepEqual(result.baseCommands, [base()])
      assert.deepEqual(result.diagnostics, ['d'])
    },
  )
  // tolerant fallbacks: bare array / junk body
  await withFetch(
    async () => fakeResponse(200, [command('x')]),
    async () => {
      const result = await listCommands()
      assert.deepEqual(result.commands.map((entry) => entry.name), ['x'])
      assert.deepEqual(result.baseCommands, [])
    },
  )
  await withFetch(
    async () => fakeResponse(200, {}),
    async () => {
      const result = await listCommands()
      assert.deepEqual(result, { commands: [], baseCommands: [], diagnostics: [] })
    },
  )
})

test('compactSession posts to the session compact endpoint and normalizes the result', async () => {
  await withFetch(
    async () => fakeResponse(200, { compacted: true, before_events: 40, after_events: 6 }),
    async (calls) => {
      const result = await compactSession('20260101-120000.jsonl')
      assert.deepEqual(result, { compacted: true, before_events: 40, after_events: 6 })
      assert.equal(calls[0]?.url, '/api/sessions/20260101-120000.jsonl/compact')
      assert.equal(calls[0]?.init?.method, 'POST')
    },
  )
  await withFetch(
    async () => fakeResponse(200, { compacted: false, reason: 'nothing to compact' }),
    async () => {
      assert.deepEqual(await compactSession('s'), {
        compacted: false,
        reason: 'nothing to compact',
      })
    },
  )
  await withFetch(
    async () => fakeResponse(409, { detail: 'a run is live' }),
    async () => {
      await assert.rejects(
        () => compactSession('s'),
        (error: unknown) =>
          error instanceof ApiError && error.status === 409 && error.message === 'a run is live',
      )
    },
  )
})

// The command payload type is part of the component/shell contract.
test('ComposerCommandRequest carries the catalogs and the composer mode', () => {
  const request: ComposerCommandRequest = {
    action: 'help',
    name: 'help',
    args: '',
    requiresArguments: false,
    baseCommands: [base()],
    commands: [command('review')],
    mode: 'consult',
  }
  assert.equal(isBaseCommandAction(request.action), true)
  assert.equal(request.baseCommands.length, 1)
})
