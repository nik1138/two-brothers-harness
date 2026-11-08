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
//   3. no colour literal is left in the migrated sheets (theme.ts is the one
//      sanctioned home for raw colour values outside tokens.css: it maps the
//      token colours to naive-ui's plain-value theme overrides);
//   4. canonical radius sizes and spacing-scale steps are tokens in the
//      migrated sheets (the mechanical migration contract);
//   5. the spacing scale, type/motion/radius/focus tokens exist where they
//      belong, and theme.ts maps the documented naive-ui colours to tokens;
//   6. every accent theme overrides the same accent/focus/selected token set in
//      the light and both dark blocks, without growing the token inventory; the
//      text-only accent token keeps AA contrast on the dark surfaces it sits on;
//   7. every role palette overrides exactly the role identity tokens and their
//      three decorative fill companions in the light and both dark blocks;
//      role-coloured text keeps AA contrast on the surfaces it sits on, and
//      white on every accessible-palette fill keeps AA contrast, in both
//      schemes;
//   8. the default palette keeps each fill companion equal to its role token,
//      so the default look is unchanged.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { accentThemeOverrides, darkThemeOverrides, themeOverrides } from '../src/theme.ts'

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')

const TOKENS_CSS = read('../src/tokens.css')

/** Sheets migrated to the token layer: style.css plus every chrome component. */
const MIGRATED_SHEETS: ReadonlyArray<{ name: string; source: string }> = [
  { name: 'style.css', source: read('../src/style.css') },
  { name: 'App.vue', source: read('../src/App.vue') },
  { name: 'Sidebar.vue', source: read('../src/components/Sidebar.vue') },
  { name: 'SessionGroup.vue', source: read('../src/components/SessionGroup.vue') },
  { name: 'SessionRow.vue', source: read('../src/components/SessionRow.vue') },
  { name: 'WelcomeHero.vue', source: read('../src/components/WelcomeHero.vue') },
  { name: 'ChatView.vue', source: read('../src/components/ChatView.vue') },
  { name: 'Composer.vue', source: read('../src/components/Composer.vue') },
  { name: 'CommandPalette.vue', source: read('../src/components/CommandPalette.vue') },
  { name: 'ToolActivity.vue', source: read('../src/components/ToolActivity.vue') },
  { name: 'ApprovalCard.vue', source: read('../src/components/ApprovalCard.vue') },
  { name: 'UsageFooter.vue', source: read('../src/components/UsageFooter.vue') },
  { name: 'ContextMeter.vue', source: read('../src/components/ContextMeter.vue') },
  { name: 'PromptAudit.vue', source: read('../src/components/PromptAudit.vue') },
  { name: 'CommandResult.vue', source: read('../src/components/CommandResult.vue') },
  { name: 'SidebarFooter.vue', source: read('../src/components/SidebarFooter.vue') },
  { name: 'WorkspaceFinder.vue', source: read('../src/components/WorkspaceFinder.vue') },
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
  // An at-rule body (the media query) already contains its nested blocks, so a
  // token appears more than once there by design; plain rule bodies stay strict.
  const atRule = block.prelude.startsWith('@')
  for (const name of declarations(block.body, !atRule).keys()) ALL_TOKENS.add(name)
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
  '--accent-text',
  '--senior',
  '--junior',
  '--operator',
  '--senior-fill',
  '--junior-fill',
  '--operator-fill',
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

/** The accent-theme variant names the token sheet must define. */
const ACCENT_VARIANT_NAMES = ['violet', 'teal', 'amber'] as const

/**
 * The only tokens an accent theme may (and must) override: the accent family,
 * the focus ring/border and the selected-surface tint. Role identity colours,
 * intent colours, surfaces and everything else keep their values.
 */
const ACCENT_VARIANT_TOKENS = [
  '--accent',
  '--accent-hover',
  '--accent-pressed',
  '--accent-soft',
  '--accent-text',
  '--focus-ring',
  '--border-focus',
  '--surface-highlight',
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
  // descendants inherit: Sidebar's `.sidebar` defines it, and SessionGroup /
  // SidebarFooter render inside that column.
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

test('migrated sheets: canonical radii and scale spacing use tokens', () => {
  // Values the token layer defines must never stay literal in a migrated
  // sheet. Radii are checked in every border-radius value; the spacing scale
  // only in true spacing properties — a one-step value on an icon width or a
  // font size is not spacing and keeps its literal (the wave-4 policy).
  const CANONICAL_RADII = new Set(['4px', '6px', '10px', '14px', '18px', '999px'])
  const CANONICAL_SPACING = [
    '0.25rem',
    '0.5rem',
    '0.75rem',
    '1rem',
    '1.25rem',
    '1.5rem',
    '2rem',
    '2.5rem',
  ] as const
  const SPACING_PROPERTY =
    /^(padding|margin|gap|row-gap|column-gap|inset|top|right|bottom|left|scroll-margin|scroll-padding)/
  const literalPattern = (raw: string): RegExp =>
    new RegExp(`(?<![\\w.])${raw.replace(/[.]/g, '\\.')}(?![0-9.])`)

  const problems: string[] = []
  for (const sheet of MIGRATED_SHEETS) {
    const css = stripComments(styleSheet(sheet.source, sheet.name))
    for (const match of css.matchAll(/border-radius:\s*([^;]+);/g)) {
      for (const value of match[1]!.split(/\s+/)) {
        if (CANONICAL_RADII.has(value.trim())) {
          problems.push(`${sheet.name}: border-radius ${value.trim()}`)
        }
      }
    }
    for (const match of css.matchAll(/([a-zA-Z-]+)\s*:\s*([^;{}]+);/g)) {
      if (!SPACING_PROPERTY.test(match[1]!)) continue
      for (const raw of CANONICAL_SPACING) {
        if (literalPattern(raw).test(match[2]!)) {
          problems.push(`${sheet.name}: ${match[1]} ${raw}`)
        }
      }
    }
  }
  assert.deepEqual(
    problems,
    [],
    `canonical radius/spacing values must be tokens: ${problems.join(', ')}`,
  )
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

// --- accent contrast helpers -------------------------------------------------

/** WCAG relative luminance for a 6-digit hex colour (throws on other shapes). */
function relativeLuminance(hex: string): number {
  const match = /^#([0-9a-f]{6})$/i.exec(hex.trim())
  assert.ok(match, `expected a 6-digit hex colour, got ${String(hex)}`)
  const value = Number.parseInt(match[1]!, 16)
  const [r, g, b] = [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff].map((channel) => {
    const c = channel / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}

/** WCAG contrast ratio between two hex colours. */
function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** Dark surfaces the accent-as-text classes actually sit on. */
const DARK_TEXT_SURFACES = [
  '--surface-canvas',
  '--surface-panel',
  '--surface-raised',
  '--surface-sunken',
  '--surface-hover',
  '--surface-active',
] as const

/**
 * Light surfaces that actually host `--accent-text`: the panel/canvas inherited
 * by links and toggles, the hovered session row, the selected row
 * (`--surface-highlight`) and the soft accent chips (`.mention-badge`,
 * `.tool-running`, `.approval-waiting`, `.diff-review-count`, ...).
 * `--surface-active` is deliberately absent: no accent-text class sits on a
 * pressed neutral surface (pressed states are transparent or the primary fill).
 */
const LIGHT_TEXT_SURFACES = [
  '--surface-panel',
  '--surface-canvas',
  '--surface-hover',
  '--surface-highlight',
  '--accent-soft',
] as const

/** WCAG AA for normal-size text. */
const ACCENT_TEXT_MIN_CONTRAST = 4.5

test('token layer: naive-ui accent overrides mirror the CSS accent tokens (no drift)', () => {
  const ACCENTS = ['blue', 'violet', 'teal', 'amber'] as const
  const EXPECTED_KEYS = [
    'primaryColor',
    'primaryColorHover',
    'primaryColorPressed',
    'primaryColorSuppl',
  ]
  const lightPalette = (accent: string): Map<string, string> =>
    accent === 'blue'
      ? LIGHT
      : declarations(
          tokenBlocks.find((block) => block.prelude === `:root[data-accent='${accent}']`)!.body,
        )
  const darkPalette = (accent: string): Map<string, string> =>
    accent === 'blue'
      ? DARK_PINNED
      : declarations(
          tokenBlocks.find(
            (block) => block.prelude === `:root[data-theme='dark'][data-accent='${accent}']`,
          )!.body,
        )
  const tokenValues = new Set<string>()
  for (const block of tokenBlocks) {
    const atRule = block.prelude.startsWith('@')
    for (const value of declarations(block.body, !atRule).values()) tokenValues.add(value.toLowerCase())
    for (const inner of blocks(block.body)) {
      for (const value of declarations(inner.body).values()) tokenValues.add(value.toLowerCase())
    }
  }

  for (const accent of ACCENTS) {
    const mapped: string[] = []
    for (const scheme of ['light', 'dark'] as const) {
      const palette = scheme === 'light' ? lightPalette(accent) : darkPalette(accent)
      const common = accentThemeOverrides(accent, scheme).common as unknown as Record<
        string,
        string
      >
      assert.deepEqual(
        Object.keys(common).sort(),
        [...EXPECTED_KEYS].sort(),
        `${accent} ${scheme}: the accent mapping must only override the primary family`,
      )
      assert.equal(
        common.primaryColor,
        palette.get('--accent'),
        `${accent} ${scheme}: primaryColor must equal the CSS --accent`,
      )
      assert.equal(
        common.primaryColorHover,
        palette.get('--accent-hover'),
        `${accent} ${scheme}: primaryColorHover must equal the CSS --accent-hover`,
      )
      assert.equal(
        common.primaryColorPressed,
        palette.get('--accent-pressed'),
        `${accent} ${scheme}: primaryColorPressed must equal the CSS --accent-pressed`,
      )
      assert.equal(
        common.primaryColorSuppl,
        palette.get('--accent'),
        `${accent} ${scheme}: primaryColorSuppl must equal the CSS --accent`,
      )
      for (const value of Object.values(common)) {
        mapped.push(value)
        assert.ok(
          tokenValues.has(value.toLowerCase()),
          `${accent} ${scheme}: ${value} must be a token value defined in tokens.css`,
        )
      }
    }
    const lightCommon = accentThemeOverrides(accent, 'light').common as unknown as Record<
      string,
      string
    >
    const darkCommon = accentThemeOverrides(accent, 'dark').common as unknown as Record<
      string,
      string
    >
    assert.notEqual(
      lightCommon.primaryColor,
      darkCommon.primaryColor,
      `${accent}: the light and dark naive-ui primaries must come from their own scheme`,
    )
  }

  // Fail-soft: an unknown accent falls back to blue for the requested scheme;
  // an unknown scheme falls back to light.
  const fallback = accentThemeOverrides(
    'magenta' as never,
    'sepia' as never,
  ).common as unknown as Record<string, string>
  assert.equal(fallback.primaryColor, LIGHT.get('--accent'))
  assert.equal(fallback.primaryColorHover, LIGHT.get('--accent-hover'))
  assert.equal(fallback.primaryColorPressed, LIGHT.get('--accent-pressed'))
  const fallbackDark = accentThemeOverrides(
    'magenta' as never,
    'dark',
  ).common as unknown as Record<string, string>
  assert.equal(fallbackDark.primaryColor, darkPalette('blue').get('--accent'))
  assert.equal(fallbackDark.primaryColorHover, darkPalette('blue').get('--accent-hover'))
  assert.equal(fallbackDark.primaryColorPressed, darkPalette('blue').get('--accent-pressed'))
  const fallbackScheme = accentThemeOverrides(
    'violet',
    'sepia' as never,
  ).common as unknown as Record<string, string>
  assert.equal(fallbackScheme.primaryColor, lightPalette('violet').get('--accent'))
})

test('token layer: accent variants override the same accent/focus/selected set in both schemes', () => {
  const sortedEntries = (map: Map<string, string>): Record<string, string> =>
    Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b)))
  const expectedKeys = [...ACCENT_VARIANT_TOKENS].sort()
  const variantNames = tokenBlocks
    .map((block) => /^:root\[data-accent='([a-z]+)'\]$/.exec(block.prelude)?.[1])
    .filter((name): name is string => name !== undefined)
    .sort()
  assert.deepEqual(
    variantNames,
    [...ACCENT_VARIANT_NAMES].sort(),
    'exactly the documented accent variants must be defined',
  )

  for (const name of ACCENT_VARIANT_NAMES) {
    const light = declarations(
      tokenBlocks.find((block) => block.prelude === `:root[data-accent='${name}']`)!.body,
    )
    const mediaBlock = blocks(mediaDark!.body).find(
      (block) => block.prelude === `:root:not([data-theme='light'])[data-accent='${name}']`,
    )
    assert.ok(mediaBlock, `the dark media block must define the ${name} accent`)
    const media = declarations(mediaBlock.body)
    const pinned = declarations(
      tokenBlocks.find(
        (block) => block.prelude === `:root[data-theme='dark'][data-accent='${name}']`,
      )!.body,
    )

    for (const [label, palette] of [
      ['light', light],
      ['dark (media)', media],
      ['dark (pinned)', pinned],
    ] as const) {
      assert.deepEqual(
        [...palette.keys()].sort(),
        expectedKeys,
        `${label} ${name}: an accent theme may only override the documented accent/focus/selected tokens`,
      )
      for (const token of ACCENT_VARIANT_TOKENS) {
        assert.ok(
          LIGHT.has(token),
          `${token} must stay an existing token — accent themes may not grow the inventory`,
        )
      }
    }
    assert.deepEqual(
      sortedEntries(media),
      sortedEntries(pinned),
      `the dark ${name} accent must be identical in the media and pinned blocks`,
    )
    // Text-only accent token: light equals the variant accent (AA on light
    // surfaces); dark is a lightened value that clears AA on every dark surface
    // the accent-as-text classes sit on, including the variant's own soft and
    // selected-surface tints.
    assert.equal(
      light.get('--accent-text'),
      light.get('--accent'),
      `${name}: the light --accent-text must equal the variant accent`,
    )
    assert.notEqual(
      media.get('--accent-text'),
      media.get('--accent'),
      `${name}: the dark --accent-text must be lightened past the fill accent`,
    )
    assert.equal(
      media.get('--accent-text'),
      pinned.get('--accent-text'),
      `${name}: both dark blocks must agree on --accent-text`,
    )
    const accentText = pinned.get('--accent-text')!
    const darkSurfaces: Array<[string, string]> = [
      ...DARK_TEXT_SURFACES.map(
        (token) => [token, DARK_PINNED.get(token)!] as [string, string],
      ),
      ['--accent-soft', pinned.get('--accent-soft')!],
      ['--surface-highlight', pinned.get('--surface-highlight')!],
    ]
    for (const [surface, background] of darkSurfaces) {
      const ratio = contrastRatio(accentText, background)
      assert.ok(
        ratio >= ACCENT_TEXT_MIN_CONTRAST,
        `${name}: dark --accent-text on ${surface} is ${ratio.toFixed(2)}:1 ` +
          `(WCAG AA needs ${ACCENT_TEXT_MIN_CONTRAST}:1)`,
      )
    }
    // Light scheme: the accent text (== the accent) must clear AA on every
    // light surface it sits on, including the selected row and soft chips.
    const lightText = light.get('--accent-text')!
    for (const surface of LIGHT_TEXT_SURFACES) {
      const background = (light.get(surface) ?? LIGHT.get(surface))!
      const ratio = contrastRatio(lightText, background)
      assert.ok(
        ratio >= ACCENT_TEXT_MIN_CONTRAST,
        `${name}: light --accent-text on ${surface} is ${ratio.toFixed(2)}:1 ` +
          `(WCAG AA needs ${ACCENT_TEXT_MIN_CONTRAST}:1)`,
      )
    }
    assert.notEqual(
      light.get('--accent'),
      LIGHT.get('--accent'),
      `${name} must change the default accent in light`,
    )
    assert.notEqual(
      media.get('--accent'),
      DARK_MEDIA.get('--accent'),
      `${name} must change the default accent in dark`,
    )
    // Role identity colours are deliberately not themable.
    for (const roleToken of ['--senior', '--junior', '--operator']) {
      assert.equal(
        light.has(roleToken) || media.has(roleToken) || pinned.has(roleToken),
        false,
        `${roleToken} is role identity and must not follow the accent theme`,
      )
    }
  }

  // Blue is the default `:root` palette and needs no override block.
  assert.equal(
    tokenBlocks.some((block) => block.prelude === ":root[data-accent='blue']"),
    false,
    "the default blue accent must stay the base :root values (no override block)",
  )
})

const ROLE_VARIANT_NAMES = ['contrast', 'neutral'] as const

/** Role identity tokens: the colour role-coloured text renders in. */
const ROLE_TEXT_TOKENS = ['--senior', '--junior', '--operator'] as const

/**
 * The decorative fill companions: backgrounds that carry white initials/glyphs
 * (avatars, role dots). They keep the same role identity as the text tokens but
 * are tuned independently so the accessible palettes can satisfy both the text
 * contrast floor and the white-on-fill floor at the same time.
 */
const ROLE_FILL_TOKENS = ['--senior-fill', '--junior-fill', '--operator-fill'] as const

/** The only tokens a role palette may override: three text + three fill. */
const ROLE_VARIANT_TOKENS = [...ROLE_TEXT_TOKENS, ...ROLE_FILL_TOKENS] as const

/** WCAG AA floor for normal-size text (same floor as the accent text tokens). */
const ROLE_TEXT_MIN_CONTRAST = 4.5

/** WCAG AA floor for white initials/glyphs painted on a decorative role fill. */
const ROLE_FILL_MIN_CONTRAST = 4.5

/** The colour the role avatars paint their initials/glyphs in (--text-on-accent). */
const ROLE_FILL_GLYPH = '#ffffff'

/**
 * Surfaces role-coloured text actually sits on: panel/canvas rows, the hovered
 * provider row, and every accent theme's soft/selected tint (an open or selected
 * provider row changes its background while the role label keeps the role
 * colour). Avatar/dot fills are not text surfaces — the initial glyph is
 * aria-hidden decorative chrome and the adjacent speaker name carries the
 * accessible identity — so they are checked against the white-on-fill floor
 * below instead.
 */
function roleTextSurfaces(scheme: 'light' | 'dark'): Array<[string, string]> {
  const base = scheme === 'light' ? LIGHT : DARK_PINNED
  const neutralSurfaces =
    scheme === 'light'
      ? (['--surface-panel', '--surface-canvas', '--surface-hover'] as const)
      : ([
          '--surface-panel',
          '--surface-canvas',
          '--surface-raised',
          '--surface-hover',
        ] as const)
  const surfaces: Array<[string, string]> = neutralSurfaces.map((token) => [
    token,
    base.get(token)!,
  ])
  surfaces.push(
    ['--accent-soft', base.get('--accent-soft')!],
    ['--surface-highlight', base.get('--surface-highlight')!],
  )
  for (const accent of ['violet', 'teal', 'amber'] as const) {
    const palette =
      scheme === 'light'
        ? declarations(
            tokenBlocks.find((block) => block.prelude === `:root[data-accent='${accent}']`)!.body,
          )
        : declarations(
            tokenBlocks.find(
              (block) => block.prelude === `:root[data-theme='dark'][data-accent='${accent}']`,
            )!.body,
          )
    surfaces.push(
      [`--accent-soft (${accent})`, palette.get('--accent-soft')!],
      [`--surface-highlight (${accent})`, palette.get('--surface-highlight')!],
    )
  }
  return surfaces
}

test('token layer: role palettes override the role and fill tokens and clear AA in both schemes', () => {
  const sortedEntries = (map: Map<string, string>): Record<string, string> =>
    Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b)))
  const expectedKeys = [...ROLE_VARIANT_TOKENS].sort()
  const variantNames = tokenBlocks
    .map((block) => /^:root\[data-roles='([a-z-]+)'\]$/.exec(block.prelude)?.[1])
    .filter((name): name is string => name !== undefined)
    .sort()
  assert.deepEqual(
    variantNames,
    [...ROLE_VARIANT_NAMES].sort(),
    'exactly the documented role palettes must be defined',
  )
  assert.equal(
    tokenBlocks.some((block) => block.prelude === ":root[data-roles='default']"),
    false,
    'the default palette must stay the base :root role tokens (no override block)',
  )

  const lightPalettes = new Map<string, Map<string, string>>()
  const darkPalettes = new Map<string, Map<string, string>>()
  for (const name of ROLE_VARIANT_NAMES) {
    const light = declarations(
      tokenBlocks.find((block) => block.prelude === `:root[data-roles='${name}']`)!.body,
    )
    const mediaBlock = blocks(mediaDark!.body).find(
      (block) => block.prelude === `:root:not([data-theme='light'])[data-roles='${name}']`,
    )
    assert.ok(mediaBlock, `the dark media block must define the ${name} role palette`)
    const media = declarations(mediaBlock.body)
    const pinned = declarations(
      tokenBlocks.find(
        (block) => block.prelude === `:root[data-theme='dark'][data-roles='${name}']`,
      )!.body,
    )
    for (const [label, palette] of [
      ['light', light],
      ['dark (media)', media],
      ['dark (pinned)', pinned],
    ] as const) {
      assert.deepEqual(
        [...palette.keys()].sort(),
        expectedKeys,
        `${label} ${name}: a role palette must override exactly the role identity and fill tokens`,
      )
      for (const token of ROLE_VARIANT_TOKENS) {
        assert.ok(
          LIGHT.has(token) && DARK_PINNED.has(token),
          `${token} must stay an existing token — role palettes may not grow the inventory`,
        )
      }
    }
    assert.deepEqual(
      sortedEntries(media),
      sortedEntries(pinned),
      `the dark ${name} role palette must be identical in the media and pinned blocks`,
    )
    for (const token of ROLE_TEXT_TOKENS) {
      assert.notEqual(
        light.get(token),
        pinned.get(token),
        `${name}: ${token} must differ between the light and dark palettes`,
      )
      assert.notEqual(
        light.get(token),
        LIGHT.get(token),
        `${name}: light ${token} must differ from the default palette`,
      )
      assert.notEqual(
        pinned.get(token),
        DARK_PINNED.get(token),
        `${name}: dark ${token} must differ from the default palette`,
      )
    }
    // The fill companions follow the palette too, and the dark palettes need
    // their own values: their role tokens are lightened for dark surfaces and
    // cannot double as fills behind white glyphs.
    for (const token of ROLE_FILL_TOKENS) {
      assert.notEqual(
        light.get(token),
        LIGHT.get(token),
        `${name}: light ${token} must differ from the default palette`,
      )
      assert.notEqual(
        pinned.get(token),
        DARK_PINNED.get(token),
        `${name}: dark ${token} must differ from the default palette`,
      )
      assert.notEqual(
        light.get(token),
        pinned.get(token),
        `${name}: ${token} must be tuned per scheme`,
      )
    }
    for (const [scheme, palette] of [
      ['light', light],
      ['dark', pinned],
    ] as const) {
      for (const token of ROLE_TEXT_TOKENS) {
        const text = palette.get(token)!
        for (const [surface, background] of roleTextSurfaces(scheme)) {
          const ratio = contrastRatio(text, background)
          assert.ok(
            ratio >= ROLE_TEXT_MIN_CONTRAST,
            `${name} ${scheme}: ${token} on ${surface} is ${ratio.toFixed(2)}:1 ` +
              `(WCAG AA needs ${ROLE_TEXT_MIN_CONTRAST}:1)`,
          )
        }
      }
      // The decorative fills carry white initials/glyphs: every fill must clear
      // the AA floor against white in both schemes.
      for (const token of ROLE_FILL_TOKENS) {
        const fill = palette.get(token)!
        const ratio = contrastRatio(ROLE_FILL_GLYPH, fill)
        assert.ok(
          ratio >= ROLE_FILL_MIN_CONTRAST,
          `${name} ${scheme}: white on ${token} (${fill}) is ${ratio.toFixed(2)}:1 ` +
            `(WCAG AA needs ${ROLE_FILL_MIN_CONTRAST}:1)`,
        )
      }
      // Role identity must stay readable in the decorative chrome: the three
      // fills are distinguishable from each other in a given palette/scheme.
      assert.equal(
        new Set(ROLE_FILL_TOKENS.map((token) => palette.get(token))).size,
        ROLE_FILL_TOKENS.length,
        `${name} ${scheme}: the three role fills must stay distinct from each other`,
      )
    }
    lightPalettes.set(name, light)
    darkPalettes.set(name, pinned)
  }

  // The two palettes are meaningfully different from each other.
  for (const token of ROLE_VARIANT_TOKENS) {
    assert.notEqual(
      lightPalettes.get('contrast')!.get(token),
      lightPalettes.get('neutral')!.get(token),
      `${token}: the contrast and neutral light palettes must differ`,
    )
    assert.notEqual(
      darkPalettes.get('contrast')!.get(token),
      darkPalettes.get('neutral')!.get(token),
      `${token}: the contrast and neutral dark palettes must differ`,
    )
  }
})

test('token layer: the default palette fill companions mirror the role tokens', () => {
  // The default palette's decorative fills are its role identity colours, so the
  // default look is exactly the role-identity look in both schemes. This also
  // freezes the default dark operator avatar's existing white-on-fill ratio; the
  // accessible palettes are the ones held to the AA floor.
  for (const [fillToken, roleToken] of [
    ['--senior-fill', '--senior'],
    ['--junior-fill', '--junior'],
    ['--operator-fill', '--operator'],
  ] as const) {
    for (const [label, palette] of [
      ['light', LIGHT],
      ['dark (media)', DARK_MEDIA],
      ['dark (pinned)', DARK_PINNED],
    ] as const) {
      assert.equal(
        palette.get(fillToken),
        palette.get(roleToken),
        `${label}: ${fillToken} must equal ${roleToken} so the default palette keeps its look`,
      )
    }
  }
})

test('token layer: the base blue accent text clears AA on every surface it sits on', () => {
  assert.ok(LIGHT.has('--accent-text'), 'the light block must define --accent-text')
  assert.ok(DARK_MEDIA.has('--accent-text'), 'the dark media block must define --accent-text')
  assert.ok(DARK_PINNED.has('--accent-text'), 'the dark pinned block must define --accent-text')
  assert.equal(LIGHT.get('--accent-text'), LIGHT.get('--accent'), 'light --accent-text is the accent')
  assert.notEqual(
    DARK_PINNED.get('--accent-text'),
    DARK_PINNED.get('--accent'),
    'dark --accent-text is lightened past the fill accent',
  )
  assert.equal(
    DARK_MEDIA.get('--accent-text'),
    DARK_PINNED.get('--accent-text'),
    'both dark blocks must agree on the base --accent-text',
  )
  const accentText = DARK_PINNED.get('--accent-text')!
  const darkSurfaces: Array<[string, string]> = [
    ...DARK_TEXT_SURFACES.map((token) => [token, DARK_PINNED.get(token)!] as [string, string]),
    ['--accent-soft', DARK_PINNED.get('--accent-soft')!],
    ['--surface-highlight', DARK_PINNED.get('--surface-highlight')!],
  ]
  for (const [surface, background] of darkSurfaces) {
    const ratio = contrastRatio(accentText, background)
    assert.ok(
      ratio >= ACCENT_TEXT_MIN_CONTRAST,
      `base dark --accent-text on ${surface} is ${ratio.toFixed(2)}:1 ` +
        `(WCAG AA needs ${ACCENT_TEXT_MIN_CONTRAST}:1)`,
    )
  }
  for (const surface of LIGHT_TEXT_SURFACES) {
    const ratio = contrastRatio(LIGHT.get('--accent-text')!, LIGHT.get(surface)!)
    assert.ok(
      ratio >= ACCENT_TEXT_MIN_CONTRAST,
      `base light --accent-text on ${surface} is ${ratio.toFixed(2)}:1 ` +
        `(WCAG AA needs ${ACCENT_TEXT_MIN_CONTRAST}:1)`,
    )
  }
})

test('token layer: naive-ui primary states keep white text at WCAG AA in both schemes', () => {
  // naive-ui paints normal-size white text on the primary family (buttons,
  // checked switch rails), and primaryColorHover is also used for input focus
  // borders, so every state a user can see must clear AA. The drift test above
  // pins these values to the CSS accent tokens, so this floor covers both.
  const WHITE = '#ffffff'
  for (const accent of ['blue', 'violet', 'teal', 'amber'] as const) {
    for (const scheme of ['light', 'dark'] as const) {
      const common = accentThemeOverrides(accent, scheme).common as unknown as Record<
        string,
        string
      >
      for (const key of ['primaryColor', 'primaryColorHover', 'primaryColorPressed'] as const) {
        const ratio = contrastRatio(WHITE, common[key]!)
        assert.ok(
          ratio >= 4.5,
          `${accent} ${scheme}: white on ${key} (${common[key]}) is ` +
            `${ratio.toFixed(2)}:1 — WCAG AA needs 4.5:1`,
        )
      }
      assert.notEqual(
        common.primaryColorHover,
        common.primaryColor,
        `${accent} ${scheme}: hover must stay visibly distinct from the primary`,
      )
      assert.notEqual(
        common.primaryColorPressed,
        common.primaryColor,
        `${accent} ${scheme}: pressed must stay visibly distinct from the primary`,
      )
      assert.notEqual(
        common.primaryColorHover,
        common.primaryColorPressed,
        `${accent} ${scheme}: hover and pressed must remain distinguishable`,
      )
    }
  }
})

test('token layer: the token inventory is the documented 97 tokens', () => {
  // 93 shared tokens + the --accent-text AA companion + the three role fill
  // companions. Adding a token means updating this expectation and the layer
  // docs deliberately.
  assert.equal(ALL_TOKENS.size, 97, 'the token inventory must stay at the documented size')
})

test('token layer: diff chrome tokens freeze the intent colours they replaced', () => {
  const hexRgb = (value: string | undefined): [number, number, number] => {
    const match = /^#([0-9a-f]{6})$/i.exec((value ?? '').trim())
    assert.ok(match, `expected a 6-digit hex colour, got ${String(value)}`)
    const n = Number.parseInt(match[1]!, 16)
    return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
  }
  const assertDiff = (label: string, palette: Map<string, string>): void => {
    const ok = hexRgb(palette.get('--ok'))
    const danger = hexRgb(palette.get('--danger'))
    // The diff views consume these tokens instead of --ok/--danger; freezing
    // the mapping keeps a future token edit from silently recolouring them.
    assert.deepEqual(
      hexRgb(palette.get('--diff-add-fg')),
      ok,
      `${label}: --diff-add-fg must stay the --ok colour`,
    )
    assert.deepEqual(
      hexRgb(palette.get('--diff-del-fg')),
      danger,
      `${label}: --diff-del-fg must stay the --danger colour`,
    )
    // The views previously built the fills with color-mix(… 12%, transparent),
    // which resolves to exactly this rgb() overlay.
    assert.equal(
      palette.get('--diff-add-bg'),
      `rgb(${ok.join(' ')} / 12%)`,
      `${label}: --diff-add-bg must be the 12% --ok overlay`,
    )
    assert.equal(
      palette.get('--diff-del-bg'),
      `rgb(${danger.join(' ')} / 12%)`,
      `${label}: --diff-del-bg must be the 12% --danger overlay`,
    )
  }
  assertDiff('light', LIGHT)
  assertDiff('dark (media)', DARK_MEDIA)
  assertDiff('dark (pinned)', DARK_PINNED)
})
