// Focused tests for src/palette.ts — run directly (matches the other suites;
// no DOM, no dependencies):
//   node --import ./tests/register-ts.mjs tests/palette.test.ts

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  PALETTE_SESSION_PREFIX,
  PALETTE_WORKSPACE_PREFIX,
  buildPaletteItems,
  filterPalette,
  scoreItem,
} from '../src/palette.ts'
import type { PaletteItem } from '../src/palette.ts'

/** Minimal action item; ids default to a slug of the label. */
function action(
  label: string,
  extra: Partial<Omit<PaletteItem, 'label'>> = {},
): PaletteItem {
  return {
    id: extra.id ?? label.toLowerCase().replace(/\s+/g, '-'),
    kind: 'action',
    label,
    ...extra,
  }
}

const ids = (items: PaletteItem[]): string[] => items.map((item) => item.id)

test('build: sessions (title fallback) then workspaces then actions, with hints', () => {
  const built = buildPaletteItems({
    sessions: [
      { name: '20260101-fix-login', title: 'Fix login', workspace_id: 'w1' },
      { name: 'legacy-session' },
    ],
    workspaces: [
      { id: 'w1', name: 'Two Brothers' },
      { id: 'w2', name: 'Sandbox' },
    ],
    actions: [
      { id: 'action:settings', kind: 'action', label: 'Settings' },
      { id: 'action:new-session', kind: 'action', label: 'New session' },
    ],
  })

  assert.deepEqual(ids(built), [
    `${PALETTE_SESSION_PREFIX}20260101-fix-login`,
    `${PALETTE_SESSION_PREFIX}legacy-session`,
    `${PALETTE_WORKSPACE_PREFIX}w1`,
    `${PALETTE_WORKSPACE_PREFIX}w2`,
    'action:settings',
    'action:new-session',
  ])
  assert.deepEqual(built.map((item) => item.kind), [
    'session',
    'session',
    'workspace',
    'workspace',
    'action',
    'action',
  ])

  assert.equal(built[0]?.label, 'Fix login')
  assert.equal(built[0]?.hint, 'Two Brothers')
  assert.deepEqual(built[0]?.keywords, ['20260101-fix-login', 'Two Brothers'])
  // no title / no workspace link: name label, no hint
  assert.equal(built[1]?.label, 'legacy-session')
  assert.equal(built[1]?.hint, undefined)
  assert.equal(built[2]?.label, 'Two Brothers')
  assert.equal(built[2]?.kind, 'workspace')
})

test('build: empty inputs give an empty list; blank titles and actions are tolerated', () => {
  assert.deepEqual(buildPaletteItems({ sessions: [], workspaces: [], actions: [] }), [])

  const built = buildPaletteItems({
    sessions: [{ name: 'plain', title: '   ' }],
    workspaces: [],
    // an action claiming another kind is normalized to 'action'
    actions: [{ id: 'made-up', kind: 'workspace', label: 'Made up' }],
  })
  assert.equal(built.length, 2)
  assert.equal(built[0]?.label, 'plain', 'blank title falls back to the session name')
  assert.equal(built[1]?.kind, 'action')
})

test('empty query: base order is preserved (stable, deduped, not label-sorted)', () => {
  const items = [
    action('Beta', { id: 'b' }),
    action('Alpha', { id: 'a' }),
    action('Alpha duplicate', { id: 'a' }), // same id — the first copy wins
    action('Gamma', { id: 'c' }),
  ]

  assert.deepEqual(ids(filterPalette(items, '')), ['b', 'a', 'c'])
  assert.deepEqual(ids(filterPalette(items, '   ')), ['b', 'a', 'c'])
  for (const item of items) assert.equal(scoreItem(item, ''), 1, 'empty query matches all')
})

test('scoring is case-insensitive and ignores surrounding whitespace', () => {
  const settings = action('Settings')
  assert.equal(scoreItem(settings, 'settings'), scoreItem(settings, 'SETTINGS'))
  assert.ok(scoreItem(settings, '  SETTINGS  ') > 0)
  assert.ok(scoreItem(action('Fix Login'), 'fix login') > 0)

  // diacritics are folded, so ASCII queries hit accented labels
  assert.ok(scoreItem(action('Café plan'), 'cafe') > 0)
})

test('prefix beats substring; exact beats prefix', () => {
  const prefix = action('Settings', { id: 'prefix' })
  const substring = action('Project settings', { id: 'substring' })

  assert.ok(scoreItem(prefix, 'set') > scoreItem(substring, 'set'))
  assert.ok(scoreItem(action('set', { id: 'exact' }), 'set') > scoreItem(prefix, 'set'))
  assert.deepEqual(ids(filterPalette([substring, prefix], 'set')), ['prefix', 'substring'])
})

test('subsequence matching is the last-resort tier and never beats a substring', () => {
  const label = action('Open workspace dialog', { id: 'owd' })
  assert.ok(scoreItem(label, 'owd') > 0, 'o-w-d appears in order')
  assert.ok(scoreItem(label, 'open') > scoreItem(label, 'owd'))
  assert.equal(scoreItem(action('Settings'), 'zzz'), 0)
  assert.deepEqual(ids(filterPalette([label, action('Settings', { id: 'other' })], 'owd')), [
    'owd',
  ])
})

test('keywords and hints match, and a label hit outranks the same keyword hit', () => {
  const dark = action('Theme: Dark', {
    id: 'dark',
    hint: 'Appearance',
    keywords: ['night mode'],
  })
  const other = action('Refresh sessions', { id: 'other' })

  assert.ok(scoreItem(dark, 'night') > 0, 'keyword match')
  assert.deepEqual(ids(filterPalette([other, dark], 'night')), ['dark'])

  assert.ok(scoreItem(dark, 'appearance') > 0, 'hint match')
  assert.equal(scoreItem(other, 'appearance'), 0)
  assert.deepEqual(ids(filterPalette([other, dark], 'appearance')), ['dark'])

  const labelHit = action('Theme: Light', { id: 'label' })
  const keywordHit = action('Appearance', { id: 'keyword', keywords: ['theme'] })
  assert.ok(scoreItem(labelHit, 'theme') > scoreItem(keywordHit, 'theme'))
})

test('multi-word queries require every word, in any order', () => {
  const dark = action('Theme: Dark')
  assert.ok(scoreItem(dark, 'theme dark') > 0)
  assert.ok(scoreItem(action('Dark theme'), 'theme dark') > 0)
  assert.equal(scoreItem(dark, 'theme light'), 0)
  assert.ok(scoreItem(dark, 'theme') > 0)
})

test('filter: limit caps the list (default 50) and non-positive limits return nothing', () => {
  const many = Array.from({ length: 120 }, (_, index) =>
    action(`Item ${String(index).padStart(3, '0')}`, { id: `i${index}` }),
  )

  assert.equal(filterPalette(many, '').length, 50)
  assert.equal(filterPalette(many, '', 10).length, 10)
  assert.equal(filterPalette(many, 'item', 7).length, 7)
  assert.equal(filterPalette(many, '', Number.NaN).length, 50, 'non-finite limit falls back')
  assert.deepEqual(filterPalette(many, '', 0), [])
  assert.deepEqual(filterPalette(many, '', -5), [])
})

test('dedupe keeps the best-scoring copy of an id', () => {
  const weak = action('Workspace explorer', { id: 'dup' })
  const strong = action('Workspace', { id: 'dup' })

  const filtered = filterPalette([weak, strong], 'workspace')
  assert.equal(filtered.length, 1)
  assert.equal(filtered[0]?.label, 'Workspace')
  assert.equal(filtered[0]?.id, 'dup')
})

test('sort is stable for equal scores and by label for equal scores with different labels', () => {
  const first = action('Same label', { id: 't2' })
  const second = action('Same label', { id: 't1' })
  assert.deepEqual(ids(filterPalette([first, second], 'same')), ['t2', 't1'], 'input order kept')

  const beta = action('Item Beta', { id: 'beta' })
  const alpha = action('Item Alpha', { id: 'alpha' })
  assert.deepEqual(ids(filterPalette([beta, alpha], 'item')), ['alpha', 'beta'])
})

test('special characters are matched literally and never throw', () => {
  const cpp = action('Open C++ settings', { id: 'cpp' })
  assert.ok(scoreItem(cpp, 'c++') > 0)
  assert.ok(scoreItem(cpp, 'C++') > 0)
  assert.ok(scoreItem(action('Import a/b', { id: 'slash' }), 'a/b') > 0)
  assert.ok(scoreItem(action('Ship 🚀 plan', { id: 'emoji' }), '🚀') > 0)

  for (const query of ['[', '(', '*.ts', 'a?b', '^$', '\\', '([.*+?^${}()|\\]']) {
    assert.doesNotThrow(() => scoreItem(cpp, query))
    assert.doesNotThrow(() => filterPalette([cpp], query))
  }
  assert.equal(scoreItem(action('Anything'), '['), 0)
})

test('filter: empty item lists and empty/blank queries are safe', () => {
  assert.deepEqual(filterPalette([], ''), [])
  assert.deepEqual(filterPalette([], 'anything'), [])
  assert.deepEqual(
    filterPalette([action('Solo', { id: 'solo' })], '   ').map((item) => item.id),
    ['solo'],
  )
})
