// Deterministic token-layer tests (no DOM, no browser): parse the CSS sources
// and assert the contract between tokens.css, the sheets that consume it, and
// the naive-ui theme overrides that mirror the colour tokens.
//
//   node --import ./tests/register-ts.mjs --test tests/tokens.test.ts
//
// The checks are:
//   1. every var(--x) reference in style.css / the migrated components is
//      defined (in tokens.css, or locally in the same sheet);
//   2. every core colour token exists in the light block and is overridden by
//      both dark blocks, which must stay byte-identical to each other;
//   3. no colour literal is left in the migrated sheets;
//   4. the spacing scale, type/motion/radius/focus tokens exist where they
//      belong, and theme.ts maps the documented naive-ui colours to tokens.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { darkThemeOverrides, themeOverrides } from '../src/theme.ts'

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')

const TOKENS_CSS = read('../src/tokens.css')

/** Sheets migrated to the token layer: style.css plus the owned components. */
const MIGRATED_SHEETS: ReadonlyArray<{ name: string; source: string }> = [
  { name: 'style.css', source: read('../src/style.css') },
  { name: 'Sidebar.vue', source: read('../src/components/Sidebar.vue') },
  { name: 'SessionGroup.vue', source: read('../src/components/SessionGroup.vue') },
  { name: 'SessionRow.vue', source: read('../src/components/SessionRow.vue') },
  { name: 'WelcomeHero.vue', source: read('../src/components/WelcomeHero.vue') },
]

// --- tiny CSS scanners --------------------------------------------------------

interface CssBlock {
  prelude: string
  body: string
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

/** Top-level blocks of a comment-free CSS chunk (nested blocks stay in `body`). */
function blocks(css: string): CssBlock[] {
  const out: CssBlock[] = []
  let i = 0
  let start = 0
  while (i < css.length) {
    const ch = css[i]
    if (ch === '{') {
      const prelude = css.slice(start, i).trim()
      let depth = 1
      let j = i + 1
      while (j < css.length && depth > 0) {
        if (css[j] === '{') depth += 1
        else if (css[j] === '}') depth -= 1
        j += 1
      }
      assert.equal(depth, 0, `unbalanced braces near "${prelude}"`)
      out.push({ prelude, body: css.slice(i + 1, j - 1) })
      i = j
      start = j
      continue
    }
    if (ch === ';') start = i + 1
    i += 1
  }
  return out
}

/**
 * Custom-property declarations in a CSS chunk, values whitespace-normalized.
 * `strict` rejects a duplicate name in the same block (a token-definition
 * invariant); component sheets may redefine a local property per modifier, so
 * their definitions are collected with last-wins.
 */
function declarations(css: string, strict = true): Map<string, string> {
  const out = new Map<string, string>()
  for (const match of css.matchAll(/(--[a-zA-Z0-9-]+)\s*:\s*([^;]+);/g)) {
    const name = match[1]!
    const value = match[2]!.replace(/\s+/g, ' ').trim()
    if (strict) assert.equal(out.has(name), false, `duplicate custom property ${name}`)
    out.set(name, value)
  }
  return out
}

/** Custom-property names referenced through var(--x[, fallback]). */
function references(css: string): Set<string> {
  const out = new Set<string>()
  for (const match of css.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)/g)) out.add(match[1]!)
  return out
}

/** A .vue source's scoped style block(s); style.css is used as-is. */
function styleSheet(source: string, name: string): string {
  if (name.endsWith('.css')) return source
  const sections = [...source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(
    (match) => match[1]!,
  )
  assert.ok(sections.length > 0, `${name} must keep a <style> block`)
  return sections.join('\n')
}

// --- the token layer ----------------------------------------------------------

const tokenBlocks = blocks(stripComments(TOKENS_CSS))
const rootBlock = tokenBlocks.find((block) => block.prelude === ':root')
assert.ok(rootBlock, 'tokens.css must have a top-level :root block')
const LIGHT = declarations(rootBlock.body)

const mediaDark = tokenBlocks.find(
  (block) => block.prelude.startsWith('@media') && block.prelude.includes('prefers-color-scheme: dark'),
)
assert.ok(mediaDark, 'tokens.css must have a prefers-color-scheme: dark block')
const mediaDarkRoot = blocks(mediaDark.body).find((block) =>
  block.prelude.startsWith(':root:not('),
)
assert.ok(mediaDarkRoot, 'the dark media block must override :root:not([data-theme=light])')
const DARK_MEDIA = declarations(mediaDarkRoot.body)

const pinnedDark = tokenBlocks.find((block) => block.prelude === ":root[data-theme='dark']")
assert.ok(pinnedDark, "tokens.css must pin the dark palette with :root[data-theme='dark']")
const DARK_PINNED = declarations(pinnedDark.body)

/** Every custom property the token sheet defines, anywhere. */
const ALL_TOKENS = new Set<string>()
for (const block of tokenBlocks) {
  for (const name of declarations(block.body).keys()) ALL_TOKENS.add(name)
  for (const inner of blocks(block.body)) {
    for (const name of declarations(inner.body).keys()) ALL_TOKENS.add(name)
  }
}

/** Colour tokens that every scheme must provide (light + both dark blocks). */
const CORE_COLOUR_TOKENS = [
  '--surface-canvas',
  '--surface-panel',
  '--surface-raised',
  '--surface-sunken',
  '--surface-bubble',
  '--surface-bubble-operator',
  '--surface-hover',
  '--surface-active',
  '--surface-highlight',
  '--border-subtle',
  '--border-strong',
  '--border-focus',
  '--text-primary',
  '--text-secondary',
  '--text-tertiary',
  '--text-on-accent',
  '--text-on-danger',
  '--accent',
  '--accent-hover',
  '--accent-pressed',
  '--accent-soft',
  '--senior',
  '--junior',
  '--operator',
  '--danger',
  '--danger-soft',
  '--warning',
  '--warning-soft',
  '--ok',
  '--ok-soft',
  '--focus-ring',
  '--diff-add-fg',
  '--diff-add-bg',
  '--diff-del-fg',
  '--diff-del-bg',
  '--find-hit-bg',
  '--find-hit-text',
  '--find-active-bg',
  '--find-active-text',
  '--thinking-bg',
  '--thinking-border',
  '--thinking-text',
  '--shadow-raised',
  '--shadow-dialog',
  '--overlay',
] as const

/** Scheme-independent tokens: one definition in :root, no dark override. */
const CORE_STATIC_TOKENS = [
  '--font-sans',
  '--font-mono',
  '--text-xs',
  '--text-sm',
  '--text-md',
  '--text-base',
  '--text-lg',
  '--text-xl',
  '--leading-tight',
  '--leading-normal',
  '--radius-xs',
  '--radius-sm',
  '--radius-md',
  '--radius-lg',
  '--radius-xl',
  '--radius-pill',
  '--motion-fast',
  '--motion-base',
  '--motion-slow',
  '--ease-standard',
  '--ease-emphasized',
  '--focus-ring-width',
  '--focus-ring-offset',
  // layout contract
  '--sidebar-width',
  '--session-row-height',
  '--chat-header-height',
  '--composer-max-width',
  '--control-height-sm',
  '--control-height-md',
  '--control-height-lg',
] as const

const SPACING_SCALE = [
  '--space-1',
  '--space-2',
  '--space-3',
  '--space-4',
  '--space-5',
  '--space-6',
  '--space-7',
  '--space-8',
] as const

test('token layer: :root defines the scheme-independent core once', () => {
  for (const name of CORE_STATIC_TOKENS) {
    assert.ok(LIGHT.has(name), `:root must define ${name}`)
    assert.equal(DARK_MEDIA.has(name), false, `${name} must not be duplicated in a dark block`)
    assert.equal(DARK_PINNED.has(name), false, `${name} must not be duplicated in a dark block`)
  }
})

test('token layer: light block defines every core colour token', () => {
  const missing = CORE_COLOUR_TOKENS.filter((name) => !LIGHT.has(name))
  assert.deepEqual(missing, [], `light :root is missing ${missing.join(', ')}`)
})

test('token layer: both dark blocks override every core colour token identically', () => {
  const missingMedia = CORE_COLOUR_TOKENS.filter((name) => !DARK_MEDIA.has(name))
  const missingPinned = CORE_COLOUR_TOKENS.filter((name) => !DARK_PINNED.has(name))
  assert.deepEqual(missingMedia, [], `dark media block is missing ${missingMedia.join(', ')}`)
  assert.deepEqual(missingPinned, [], `dark pinned block is missing ${missingPinned.join(', ')}`)

  // The two declarations are documented as byte-identical; keep them that way.
  const sortEntries = (map: Map<string, string>): Record<string, string> =>
    Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b)))
  assert.deepEqual(
    sortEntries(DARK_MEDIA),
    sortEntries(DARK_PINNED),
    'the prefers-color-scheme and data-theme=dark blocks must declare the same values',
  )
})

test('token layer: the spacing scale is complete, ordered and rem-based', () => {
  let previous = 0
  for (const name of SPACING_SCALE) {
    const value = LIGHT.get(name)
    assert.ok(value, `:root must define ${name}`)
    const match = /^([0-9.]+)rem$/.exec(value)
    assert.ok(match, `${name} must be a rem value, got ${value}`)
    const rem = Number(match[1])
    assert.ok(rem > previous, `${name} must grow with the scale (${value} after ${previous}rem)`)
    previous = rem
  }
})

test('token layer: every var(--x) used by the migrated sheets is defined', () => {
  // Properties a migrated component sheet sets on a chrome ancestor and its
  // descendants inherit (SessionGroup renders inside Sidebar's `.sidebar`).
  const inherited = new Set(['--sidebar-inline'])
  const sidebar = MIGRATED_SHEETS.find((sheet) => sheet.name === 'Sidebar.vue')
  assert.ok(sidebar, 'Sidebar.vue must stay in the migrated set')
  assert.ok(
    declarations(stripComments(styleSheet(sidebar.source, sidebar.name)), false).has(
      '--sidebar-inline',
    ),
    '--sidebar-inline must stay defined by Sidebar.vue (inherited by SessionGroup.vue)',
  )

  const problems: string[] = []
  for (const sheet of MIGRATED_SHEETS) {
    const css = stripComments(styleSheet(sheet.source, sheet.name))
    const local = new Set(declarations(css, false).keys())
    for (const name of references(css)) {
      if (!ALL_TOKENS.has(name) && !local.has(name) && !inherited.has(name)) {
        problems.push(`${sheet.name}: ${name}`)
      }
    }
  }
  assert.deepEqual(problems, [], `undefined token reference(s): ${problems.join(', ')}`)
})

test('migrated sheets: no colour literal outside tokens.css', () => {
  const problems: string[] = []
  for (const sheet of MIGRATED_SHEETS) {
    const css = stripComments(styleSheet(sheet.source, sheet.name))
    for (const match of css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
      problems.push(`${sheet.name}: hex ${match[0]}`)
    }
    for (const match of css.matchAll(/\b(rgba?|hsla?)\(/g)) {
      problems.push(`${sheet.name}: ${match[1]}() colour`)
    }
  }
  assert.deepEqual(problems, [], `colour literals must live in tokens.css: ${problems.join(', ')}`)
})

test('token layer: naive theme overrides stay mapped to the colour tokens', () => {
  const THEME_MAP = {
    primaryColor: '--accent',
    primaryColorHover: '--accent-hover',
    primaryColorPressed: '--accent-pressed',
    errorColor: '--danger',
    warningColor: '--warning',
    successColor: '--ok',
    textColorBase: '--text-primary',
    textColor1: '--text-primary',
    textColor2: '--text-secondary',
    textColor3: '--text-tertiary',
    textColorDisabled: '--text-tertiary',
    placeholderColor: '--text-tertiary',
    iconColor: '--text-secondary',
    borderColor: '--border-subtle',
    dividerColor: '--border-subtle',
    hoverColor: '--surface-hover',
    pressedColor: '--surface-active',
    actionColor: '--surface-sunken',
    scrollbarColor: '--border-strong',
    bodyColor: '--surface-canvas',
    cardColor: '--surface-panel',
    modalColor: '--surface-panel',
    tableColor: '--surface-panel',
    inputColor: '--surface-panel',
  } as const

  const assertMapped = (
    label: string,
    overrides: typeof themeOverrides,
    palette: Map<string, string>,
  ): void => {
    const common = overrides.common as unknown as Record<string, string>
    for (const [property, token] of Object.entries(THEME_MAP)) {
      const expected = palette.get(token)
      assert.ok(expected, `${token} must be defined`)
      assert.equal(
        common[property]?.toLowerCase(),
        expected.toLowerCase(),
        `${label}.common.${property} must map to ${token}`,
      )
    }
  }

  assertMapped('light', themeOverrides, LIGHT)
  assertMapped('dark', darkThemeOverrides, DARK_PINNED)

  // The one deliberate divergence: the dark popover sits on the raised surface.
  const darkCommon = darkThemeOverrides.common as unknown as Record<string, string>
  assert.equal(darkCommon.popoverColor?.toLowerCase(), DARK_PINNED.get('--surface-raised'))
  const lightCommon = themeOverrides.common as unknown as Record<string, string>
  assert.equal(lightCommon.popoverColor?.toLowerCase(), LIGHT.get('--surface-panel'))
})
