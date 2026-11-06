// Focused tests for src/mentions.ts (composer @ skills/files and / commands)
// and the matching api.ts wiring. No DOM; mocked fetch keeps the API checks
// offline:
//   node --import ./tests/register-ts.mjs --test tests/mentions.test.ts

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  DEFAULT_FILE_QUERY_LIMIT,
  MAX_COMMAND_ITEMS,
  MAX_FILE_ITEMS,
  MAX_FILE_QUERY_LIMIT,
  MAX_SKILL_ITEMS,
  MENTION_DEBOUNCE_MS,
  MENTION_FOOTER_HINT,
  SKILL_MENTION_PREFIX,
  clampFileQueryLimit,
  commandMentionItems,
  detectMentionTrigger,
  fileMentionItems,
  filterCommandItems,
  filterFileItems,
  filterSkillItems,
  insertMention,
  itemHint,
  itemLabel,
  mentionPickerHint,
  mentionTokenFor,
  skillMentionItems,
} from '../src/mentions.ts'
import { ApiError, listCommands, listSkills, listWorkspaceFiles } from '../src/api.ts'
import type { CommandInfo, SkillInfo, WorkspaceFileEntry } from '../src/types.ts'

function skill(name: string, scope: SkillInfo['scope'] = 'shared', extra: Partial<SkillInfo> = {}): SkillInfo {
  return { name, description: `${name} description`, scope, tools: [], file: `/skills/${name}/SKILL.md`, ...extra }
}

function command(name: string, extra: Partial<CommandInfo> = {}): CommandInfo {
  return { name, description: `${name} description`, argumentHint: '', file: `/commands/${name}.md`, ...extra }
}

function file(path: string, extra: Partial<WorkspaceFileEntry> = {}): WorkspaceFileEntry {
  return { path, size: 10, mtime: 1700000000, ...extra }
}

const names = (items: Array<{ name: string }>): string[] => items.map((item) => item.name)
const paths = (items: Array<{ path: string }>): string[] => items.map((item) => item.path)

// -- constants ----------------------------------------------------------------

test('picker constants stay pinned and bounded', () => {
  assert.equal(MAX_COMMAND_ITEMS, 8)
  assert.equal(MAX_SKILL_ITEMS, 8)
  assert.equal(MAX_FILE_ITEMS, 12)
  assert.equal(MENTION_DEBOUNCE_MS, 150)
  assert.equal(SKILL_MENTION_PREFIX, '@skill:')
  assert.equal(MENTION_FOOTER_HINT, '↑↓ navigate · Enter insert · Esc close')
  assert.ok(DEFAULT_FILE_QUERY_LIMIT > MAX_FILE_ITEMS)
  assert.ok(MAX_FILE_QUERY_LIMIT >= DEFAULT_FILE_QUERY_LIMIT)
})

test('clampFileQueryLimit defaults and clamps into 1..MAX', () => {
  assert.equal(clampFileQueryLimit(), DEFAULT_FILE_QUERY_LIMIT)
  assert.equal(clampFileQueryLimit(Number.NaN), DEFAULT_FILE_QUERY_LIMIT)
  assert.equal(clampFileQueryLimit(Number.POSITIVE_INFINITY), DEFAULT_FILE_QUERY_LIMIT)
  assert.equal(clampFileQueryLimit(5.9), 5)
  assert.equal(clampFileQueryLimit(0), 1)
  assert.equal(clampFileQueryLimit(-3), 1)
  assert.equal(clampFileQueryLimit(MAX_FILE_QUERY_LIMIT + 100), MAX_FILE_QUERY_LIMIT)
})

// -- trigger detection --------------------------------------------------------

test('detectMentionTrigger: a plain @ at a token start opens the file picker', () => {
  assert.deepEqual(detectMentionTrigger('@', 1), { kind: 'file', start: 0, query: '' })
  assert.deepEqual(detectMentionTrigger('please @src/ma', 14), {
    kind: 'file',
    start: 7,
    query: 'src/ma',
  })
  assert.deepEqual(detectMentionTrigger('hello\n@uti', 10), {
    kind: 'file',
    start: 6,
    query: 'uti',
  })
  // caret in the middle of the token still resolves the same token
  assert.deepEqual(detectMentionTrigger('hello @src/m', 9), {
    kind: 'file',
    start: 6,
    query: 'sr',
  })
  assert.deepEqual(detectMentionTrigger('a\t@b', 4), { kind: 'file', start: 2, query: 'b' })
})

test('detectMentionTrigger: emails and word-internal @ never open the picker', () => {
  assert.equal(detectMentionTrigger('mail me at a@b.co', 'mail me at a@b.co'.length), null)
  assert.equal(detectMentionTrigger('user@example.com', 16), null)
  assert.equal(detectMentionTrigger('foo@bar', 7), null)
  assert.equal(detectMentionTrigger('@ hello', 2), null, '@ followed by whitespace ends the token')
  assert.equal(detectMentionTrigger('@ ', 2), null)
})

test('detectMentionTrigger: @skill: narrows to the skill picker', () => {
  assert.deepEqual(detectMentionTrigger('@skill:review', 13), {
    kind: 'skill',
    start: 0,
    query: 'review',
  })
  assert.deepEqual(detectMentionTrigger('@skill:', 7), { kind: 'skill', start: 0, query: '' })
  assert.deepEqual(detectMentionTrigger('use @SKILL:Rev', 14), {
    kind: 'skill',
    start: 4,
    query: 'Rev',
  })
  // a near-miss prefix is just a file query
  assert.deepEqual(detectMentionTrigger('@skillx', 7), { kind: 'file', start: 0, query: 'skillx' })
})

test('detectMentionTrigger: / only at the start of a line', () => {
  assert.deepEqual(detectMentionTrigger('/help', 5), { kind: 'command', start: 0, query: 'help' })
  assert.deepEqual(detectMentionTrigger('   /he', 6), { kind: 'command', start: 3, query: 'he' })
  assert.deepEqual(detectMentionTrigger('hi\n/co', 6), { kind: 'command', start: 3, query: 'co' })
  assert.deepEqual(detectMentionTrigger('/co', 3), { kind: 'command', start: 0, query: 'co' })

  assert.equal(detectMentionTrigger('hello /cmd', 10), null, 'text before the / on its line')
  assert.equal(detectMentionTrigger('see /usr/bin', 12), null)
  assert.equal(detectMentionTrigger('src/main.ts', 11), null)
  assert.equal(detectMentionTrigger('https://example.com', 19), null)
})

test('detectMentionTrigger tolerates odd input and clamps the caret', () => {
  assert.equal(detectMentionTrigger('', 0), null)
  assert.equal(detectMentionTrigger('plain text', 10), null)
  assert.equal(detectMentionTrigger(null, 3), null)
  assert.equal(detectMentionTrigger('@ab', Number.NaN), null)
  assert.equal(detectMentionTrigger('@ab', -5), null)
  assert.deepEqual(detectMentionTrigger('@ab', 99), { kind: 'file', start: 0, query: 'ab' })
  assert.equal(detectMentionTrigger('@ab', 0), null, 'caret before the trigger')
  // caret between a whitespace and following text, with an earlier @ in the line
  assert.equal(detectMentionTrigger('hi @foo', 3), null)
})

// -- filtering & ranking ------------------------------------------------------

test('filterCommandItems: prefix beats substring, case-insensitive, stable', () => {
  const items = [command('deploy'), command('pr-review'), command('review'), command('unrelated')]
  assert.deepEqual(names(filterCommandItems(items, 'rev')), ['review', 'pr-review'])
  assert.deepEqual(names(filterCommandItems(items, 'REV')), ['review', 'pr-review'])
  assert.deepEqual(names(filterCommandItems(items, 'depl')), ['deploy'])
  assert.deepEqual(names(filterCommandItems(items, 'zzz')), [])

  // equal scores keep the input order
  const ties = [command('a1'), command('a2')]
  assert.deepEqual(names(filterCommandItems(ties, 'a')), ['a1', 'a2'])

  // blank/absent query keeps the catalog order
  assert.deepEqual(names(filterCommandItems(items, '')), names(items))
  assert.deepEqual(names(filterCommandItems(items, '   ')), names(items))
})

test('filterCommandItems/skills: caps, malformed entries and empty input are safe', () => {
  const many = Array.from({ length: 20 }, (_, i) => command(`cmd-${String(i).padStart(2, '0')}`))
  assert.equal(filterCommandItems(many, '').length, MAX_COMMAND_ITEMS)
  assert.equal(filterCommandItems(many, 'cmd').length, MAX_COMMAND_ITEMS)

  const junk = [null, 7, 'nope', { name: '' }, { name: '   ' }, command('good')]
  assert.deepEqual(names(filterCommandItems(junk as unknown as CommandInfo[], 'good')), ['good'])
  assert.deepEqual(filterCommandItems(null, 'x'), [])
  assert.deepEqual(filterCommandItems(undefined, 'x'), [])

  const skills = [skill('alpha'), skill('alphabet'), skill('beta')]
  assert.deepEqual(names(filterSkillItems(skills, 'alph')), ['alpha', 'alphabet'])
  assert.deepEqual(filterSkillItems(skills, '').length, 3)
})

test('filterFileItems: basename relevance outranks path substrings', () => {
  const files = [
    file('src/components/Button.tsx'),
    file('docs/button-guide.md'),
    file('src/button/theme.css'),
    file('src/order.ts'),
  ]
  // exact basename (Button.tsx) > basename prefix (button-guide, button dir) > path substring
  const ranked = paths(filterFileItems(files, 'button'))
  assert.equal(ranked[0], 'src/components/Button.tsx')
  assert.deepEqual(new Set(ranked), new Set([
    'src/components/Button.tsx',
    'docs/button-guide.md',
    'src/button/theme.css',
  ]))

  // a directory segment prefix still matches ("src/button/…" for "but")
  assert.ok(paths(filterFileItems(files, 'but')).includes('src/button/theme.css'))

  // case-insensitive; exact basename looks at the final segment
  assert.equal(paths(filterFileItems(files, 'ORDER.TS'))[0], 'src/order.ts')

  // blank query keeps order and caps
  const many = Array.from({ length: 30 }, (_, i) => file(`dir/f${i}.ts`))
  assert.equal(filterFileItems(many, '').length, MAX_FILE_ITEMS)
  assert.equal(filterFileItems(many, 'f').length, MAX_FILE_ITEMS)
  assert.deepEqual(filterFileItems(null, 'x'), [])
  assert.deepEqual(filterFileItems([null, {}, { path: '  ' }] as unknown as WorkspaceFileEntry[], 'x'), [])
})

// -- item builders ------------------------------------------------------------

test('commandMentionItems: /name labels, argument hint, insertable token', () => {
  const items = commandMentionItems([
    command('review', { argumentHint: '<diff>', description: 'Review a diff' }),
    command('summarize', { description: 'Summarize the context' }),
  ])
  assert.deepEqual(items.map((item) => item.label), ['/review', '/summarize'])
  assert.equal(items[0]?.hint, '<diff>')
  assert.equal(items[1]?.hint, 'Summarize the context')
  assert.equal(items[0]?.token, '/review')
  assert.equal(items[0]?.disabled, false)
  assert.equal(items[0]?.kind, 'command')
  assert.equal(items[0]?.id, 'command:review')
  assert.deepEqual(commandMentionItems(null), [])
  assert.deepEqual(commandMentionItems([command('rev'), command('review')], 'rev').map((i) => i.label), [
    '/rev',
    '/review',
  ])
})

test('skillMentionItems: shared skills first, role-scoped visible but disabled', () => {
  const items = skillMentionItems([
    skill('junior-only', 'junior'),
    skill('shared-one', 'shared', { description: 'Shared helper' }),
    skill('senior-only', 'senior'),
  ])
  assert.deepEqual(items.map((item) => item.label), ['shared-one', 'junior-only', 'senior-only'])
  assert.equal(items[0]?.disabled, false)
  assert.equal(items[0]?.token, '@skill:shared-one')
  assert.equal(items[0]?.hint, 'shared · Shared helper')
  assert.equal(items[1]?.disabled, true)
  assert.equal(items[1]?.token, '')
  assert.equal(items[1]?.hint, 'junior-only · junior-only description')
  assert.equal(items[2]?.hint.startsWith('senior-only ·'), true)
  assert.deepEqual(skillMentionItems(null), [])

  // only shared skills are insertable in a filtered view
  const filtered = skillMentionItems([skill('alpha', 'senior'), skill('beta', 'shared')], 'a')
  assert.deepEqual(filtered.map((item) => ({ label: item.label, disabled: item.disabled })), [
    { label: 'beta', disabled: false },
    { label: 'alpha', disabled: true },
  ])
})

test('skillMentionItems respects the skill cap after partitioning', () => {
  const shared = Array.from({ length: MAX_SKILL_ITEMS + 4 }, (_, i) => skill(`shared-${i}`))
  const scoped = Array.from({ length: 5 }, (_, i) => skill(`scoped-${i}`, 'senior'))
  const items = skillMentionItems([...scoped, ...shared])
  assert.equal(items.length, MAX_SKILL_ITEMS)
  assert.equal(items.filter((item) => !item.disabled).length, MAX_SKILL_ITEMS)
})

test('fileMentionItems: basename label, dirname hint, forward-slash @token', () => {
  const items = fileMentionItems([
    file('src\\components\\Button.tsx'),
    file('README.md'),
  ])
  assert.deepEqual(items.map((item) => item.label), ['Button.tsx', 'README.md'])
  assert.equal(items[0]?.hint, 'src/components')
  assert.equal(items[0]?.token, '@src/components/Button.tsx')
  assert.equal(items[0]?.id, 'file:src/components/Button.tsx')
  assert.equal(items[1]?.hint, 'workspace root')
  // root-level files need the explicit `./` for the core parser
  assert.equal(items[1]?.token, '@./README.md')
  assert.equal(items[1]?.disabled, false)
  assert.deepEqual(fileMentionItems(null), [])

  // the UI cap applies to a long server result
  const many = Array.from({ length: 30 }, (_, i) => file(`dir/f${i}.ts`))
  assert.equal(fileMentionItems(many).length, MAX_FILE_ITEMS)
})

// -- insertion & token serialization ------------------------------------------

test('insertMention replaces the active token with token + one space', () => {
  const trigger = { kind: 'file' as const, start: 7, query: 'src/ma' }
  const result = insertMention('please @src/ma', 14, trigger, '@src/main.ts')
  assert.deepEqual(result, { text: 'please @src/main.ts ', caret: 20 })
  assert.equal(result.text.slice(result.caret), '')

  // text after the caret is preserved
  const middle = insertMention('go @sr now', 6, { kind: 'file', start: 3, query: 'sr' }, '@src/x.ts')
  assert.deepEqual(middle, { text: 'go @src/x.ts  now', caret: 13 })

  // never mutates the input
  const source = 'a @b'
  insertMention(source, 4, { kind: 'file', start: 2, query: 'b' }, '@bee')
  assert.equal(source, 'a @b')
})

test('insertMention clamps a missing caret and tolerates junk', () => {
  const trigger = { kind: 'skill' as const, start: 0, query: 'rev' }
  assert.deepEqual(insertMention('@rev', 99, trigger, '@skill:review'), {
    text: '@skill:review ',
    caret: 14,
  })
  assert.deepEqual(insertMention('@rev', 4, null, '@skill:review'), { text: '@rev', caret: 4 })
  assert.deepEqual(insertMention('@rev', 4, trigger, ''), { text: '@rev', caret: 4 })
  assert.deepEqual(insertMention(null, Number.NaN, trigger, '@skill:review'), {
    text: '@skill:review ',
    caret: 14,
  })
  // start beyond the caret collapses the range safely
  assert.deepEqual(insertMention('abc', 1, { kind: 'file', start: 99, query: '' }, '@x'), {
    text: 'a@x bc',
    caret: 4,
  })
})

test('mentionTokenFor serializes the server token formats', () => {
  assert.equal(mentionTokenFor('command', 'review'), '/review')
  assert.equal(mentionTokenFor('command', '/review'), '/review')
  assert.equal(mentionTokenFor('skill', 'review'), '@skill:review')
  assert.equal(mentionTokenFor('skill', '@skill:review'), '@skill:review')
  assert.equal(mentionTokenFor('skill', '@review'), '@skill:review')
  assert.equal(mentionTokenFor('file', 'src/main.ts'), '@src/main.ts')
  assert.equal(mentionTokenFor('file', './src\\main.ts'), '@src/main.ts')
  assert.equal(mentionTokenFor('file', '/src//main.ts'), '@src/main.ts')
  // root-level paths carry the explicit `./` the core parser needs
  assert.equal(mentionTokenFor('file', 'README.md'), '@./README.md')
  assert.equal(mentionTokenFor('file', './README.md'), '@./README.md')
  assert.equal(mentionTokenFor('file', '  README.md  '), '@./README.md')
  assert.equal(mentionTokenFor('file', '   '), '')
  assert.equal(mentionTokenFor('command', ''), '')
  assert.equal(mentionTokenFor('bogus', 'x'), '')
  assert.equal(mentionTokenFor(null, 'x'), '')
})

test('root-level file tokens round-trip as file mentions', () => {
  // a root file gets `./` and stays a file mention once inserted
  const rootToken = mentionTokenFor('file', 'README.md')
  assert.equal(rootToken, '@./README.md')
  const trigger = { kind: 'file' as const, start: 0, query: 'REA' }
  const inserted = insertMention('@REA', 4, trigger, rootToken)
  assert.deepEqual(inserted, { text: '@./README.md ', caret: 13 })
  // editing inside the inserted token still resolves a file mention
  assert.deepEqual(detectMentionTrigger(inserted.text, inserted.caret - 1), {
    kind: 'file',
    start: 0,
    query: './README.md',
  })

  // nested paths keep forward slashes and no bogus `./`
  const nestedToken = mentionTokenFor('file', 'src\\a.ts')
  assert.equal(nestedToken, '@src/a.ts')
  const nested = insertMention('@sr', 3, { kind: 'file', start: 0, query: 'sr' }, nestedToken)
  assert.deepEqual(nested, { text: '@src/a.ts ', caret: 10 })
  assert.deepEqual(detectMentionTrigger(nested.text, nested.caret - 1), {
    kind: 'file',
    start: 0,
    query: 'src/a.ts',
  })
})

// -- display helpers ----------------------------------------------------------

test('itemLabel/itemHint/mentionPickerHint describe every kind', () => {
  assert.equal(itemLabel('command', command('review')), '/review')
  assert.equal(itemLabel('skill', skill('alpha')), 'alpha')
  assert.equal(itemLabel('file', file('a/b.ts')), 'a/b.ts')
  assert.equal(itemLabel('file', null), '')
  assert.equal(itemLabel('skill', { name: '' }), '')

  assert.equal(itemHint('command', command('x', { argumentHint: '<arg>' })), '<arg>')
  assert.equal(itemHint('command', command('x', { description: 'Do it' })), 'Do it')
  assert.equal(itemHint('skill', skill('alpha', 'shared', { description: 'Helper' })), 'shared · Helper')
  assert.equal(itemHint('skill', skill('alpha', 'senior', { description: '' })), 'senior-only')
  assert.equal(itemHint('file', file('src/a.ts')), 'src')
  assert.equal(itemHint('file', file('a.ts')), 'workspace root')
  assert.equal(itemHint('file', null), '')

  assert.match(mentionPickerHint('skill'), /skill/)
  assert.match(mentionPickerHint('file'), /file/)
  assert.match(mentionPickerHint('command'), /command/)
  assert.ok(mentionPickerHint('nope').length > 0)
})

// -- api.ts wiring (mocked fetch; still fully offline) ------------------------

interface FakeResponse {
  ok: boolean
  status: number
  json: () => Promise<unknown>
}

function fakeResponse(status: number, body: unknown): FakeResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

/** Run `run` with a stubbed global fetch, restoring the real one afterwards. */
async function withFetch(
  impl: (url: string, init?: RequestInit) => Promise<FakeResponse>,
  run: (calls: { url: string; init?: RequestInit }[]) => Promise<void>,
): Promise<void> {
  const calls: { url: string; init?: RequestInit }[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input)
    calls.push({ url, init })
    return impl(url, init)
  }) as typeof fetch
  try {
    await run(calls)
  } finally {
    globalThis.fetch = original
  }
}

test('listWorkspaceFiles: id/query/limit encoding and response unwrapping', async () => {
  const response = {
    workspace_id: 'w 1',
    files: [file('src/main.ts')],
    truncated: true,
    total: 3,
  }
  await withFetch(
    async () => fakeResponse(200, response),
    async (calls) => {
      const result = await listWorkspaceFiles('w 1', 'main file', 5)
      assert.deepEqual(result, response)
      assert.equal(
        calls[0]?.url,
        '/api/workspaces/w%201/files?limit=5&q=main%20file',
      )
    },
  )

  await withFetch(
    async () => fakeResponse(200, response),
    async (calls) => {
      await listWorkspaceFiles('w1')
      assert.equal(calls[0]?.url, `/api/workspaces/w1/files?limit=${DEFAULT_FILE_QUERY_LIMIT}`)
      await listWorkspaceFiles('w1', '   ')
      assert.equal(calls[1]?.url, `/api/workspaces/w1/files?limit=${DEFAULT_FILE_QUERY_LIMIT}`)
      await listWorkspaceFiles('w1', 'q', MAX_FILE_QUERY_LIMIT * 10)
      assert.equal(calls[2]?.url, `/api/workspaces/w1/files?limit=${MAX_FILE_QUERY_LIMIT}&q=q`)
    },
  )
})

test('listWorkspaceFiles: tolerant unwrapping and ApiError status', async () => {
  await withFetch(
    async () => fakeResponse(200, [file('a.ts')]),
    async () => {
      const result = await listWorkspaceFiles('w1')
      assert.deepEqual(result.files, [file('a.ts')])
      assert.equal(result.truncated, false)
      assert.equal(result.total, 1)
      assert.equal(result.workspace_id, 'w1')
    },
  )
  await withFetch(
    async () => fakeResponse(200, { nope: true }),
    async () => {
      const result = await listWorkspaceFiles('w1')
      assert.deepEqual(result.files, [])
      assert.equal(result.total, 0)
    },
  )
  await withFetch(
    async () => fakeResponse(404, { detail: 'not found' }),
    async () => {
      await assert.rejects(
        () => listWorkspaceFiles('gone'),
        (error: unknown) =>
          error instanceof ApiError && error.status === 404 && error.message === 'not found',
      )
    },
  )
})

test('listSkills/listCommands: unwrap objects and bare arrays', async () => {
  const skills = [skill('alpha')]
  await withFetch(
    async () => fakeResponse(200, { skills, diagnostics: ['d'] }),
    async () => {
      assert.deepEqual(await listSkills(), { skills, diagnostics: ['d'] })
    },
  )
  await withFetch(
    async () => fakeResponse(200, skills),
    async () => {
      assert.deepEqual(await listSkills(), { skills, diagnostics: [] })
    },
  )
  await withFetch(
    async () => fakeResponse(200, { nope: 1 }),
    async () => {
      assert.deepEqual(await listSkills(), { skills: [], diagnostics: [] })
    },
  )

  const commands = [command('review')]
  await withFetch(
    async () => fakeResponse(200, { commands, diagnostics: [] }),
    async () => {
      // `baseCommands` is the additive first-party catalogue ([] on older bodies)
      assert.deepEqual(await listCommands(), {
        commands,
        baseCommands: [],
        diagnostics: [],
      })
    },
  )
  await withFetch(
    async () => fakeResponse(200, commands),
    async () => {
      assert.deepEqual(await listCommands(), {
        commands,
        baseCommands: [],
        diagnostics: [],
      })
    },
  )
})
