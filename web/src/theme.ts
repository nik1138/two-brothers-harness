import type { GlobalThemeOverrides } from 'naive-ui'

import type { AccentTheme } from './uiPrefs'

/**
 * Naive UI theme overrides mapped from the design tokens in style.css
 * (:root custom properties). Keep the two in sync when tokens change; this
 * module is the sanctioned home for raw hex values outside tokens.css because
 * naive-ui takes plain values rather than CSS custom properties (tokens.test.ts
 * asserts the accent mapping below cannot drift from the CSS accent tokens).
 *
 * | token                  | naive var                     |
 * |------------------------|-------------------------------|
 * | --accent               | primaryColor*                 |
 * | --danger               | errorColor*                   |
 * | --warning              | warningColor*                 |
 * | --ok                   | successColor*                 |
 * | --text-primary         | textColorBase / textColor1    |
 * | --text-secondary       | textColor2                    |
 * | --text-tertiary        | textColor3                    |
 * | --border-subtle        | borderColor / dividerColor    |
 * | --surface-hover        | hoverColor                    |
 * | --surface-sunken       | actionColor / tableColor      |
 * | --radius-sm/md         | borderRadiusSmall / radius    |
 * | --font-sans / --font-mono | fontFamily / fontFamilyMono |
 */

const FONT_SANS =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"

const FONT_MONO =
  "ui-monospace, SFMono-Regular, Consolas, 'Liberation Mono', monospace"

type CommonOverrides = NonNullable<GlobalThemeOverrides['common']>

const TYPE_SCALE = {
  fontSizeMini: '11px',
  fontSizeTiny: '12px',
  fontSizeSmall: '12px',
  fontSizeMedium: '13px',
  fontSizeLarge: '15px',
  fontSizeHuge: '17px',
  heightMini: '22px',
  heightTiny: '26px',
  heightSmall: '28px',
  heightMedium: '32px',
  heightLarge: '36px',
  heightHuge: '40px',
  lineHeight: '1.5',
  fontFamily: FONT_SANS,
  fontFamilyMono: FONT_MONO,
  fontWeight: '400',
  fontWeightStrong: '600',
} satisfies Partial<CommonOverrides>

const SHAPE = {
  borderRadius: '10px',
  borderRadiusSmall: '6px',
  scrollbarWidth: '8px',
  scrollbarHeight: '8px',
  scrollbarBorderRadius: '4px',
} satisfies Partial<CommonOverrides>

const MOTION = {
  cubicBezierEaseInOut: 'cubic-bezier(0.2, 0, 0, 1)',
  cubicBezierEaseOut: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
  cubicBezierEaseIn: 'cubic-bezier(0.4, 0, 1, 1)',
} satisfies Partial<CommonOverrides>

export const themeOverrides: GlobalThemeOverrides = {
  common: {
    ...TYPE_SCALE,
    ...SHAPE,
    ...MOTION,
    primaryColor: '#3568d4',
    primaryColorHover: '#2a56b4',
    primaryColorPressed: '#234a9e',
    primaryColorSuppl: '#3568d4',
    errorColor: '#c8433b',
    errorColorHover: '#d95c54',
    errorColorPressed: '#a9362f',
    errorColorSuppl: '#c8433b',
    warningColor: '#946200',
    warningColorHover: '#ad7410',
    warningColorPressed: '#7a5000',
    successColor: '#1c7f3f',
    successColorHover: '#249a4d',
    successColorPressed: '#166832',
    textColorBase: '#171a21',
    textColor1: '#171a21',
    textColor2: '#5c6370',
    textColor3: '#858c98',
    textColorDisabled: '#858c98',
    placeholderColor: '#858c98',
    iconColor: '#5c6370',
    borderColor: '#e4e7ec',
    dividerColor: '#e4e7ec',
    inputColor: '#ffffff',
    bodyColor: '#f6f7f9',
    cardColor: '#ffffff',
    modalColor: '#ffffff',
    popoverColor: '#ffffff',
    tableColor: '#ffffff',
    actionColor: '#eef1f5',
    hoverColor: '#f1f3f7',
    pressedColor: '#e7ebf1',
    scrollbarColor: '#cbd1db',
    scrollbarColorHover: '#aab2bf',
    boxShadow1: '0 1px 2px rgb(16 24 40 / 6%)',
    boxShadow2: '0 8px 24px -12px rgb(16 24 40 / 18%)',
    boxShadow3: '0 24px 64px -18px rgb(16 24 40 / 32%)',
  },
}

/** Dark-scheme overrides matching the `data-theme='dark'` /
 * prefers-color-scheme tokens in style.css. Consumed with naive's
 * `darkTheme`. */
export const darkThemeOverrides: GlobalThemeOverrides = {
  common: {
    ...TYPE_SCALE,
    ...SHAPE,
    ...MOTION,
    primaryColor: '#2f6fed',
    primaryColorHover: '#2b5fd9',
    primaryColorPressed: '#2753c9',
    primaryColorSuppl: '#2f6fed',
    errorColor: '#d54941',
    errorColorHover: '#e06862',
    errorColorPressed: '#ab382f',
    errorColorSuppl: '#d54941',
    warningColor: '#b07d10',
    warningColorHover: '#c8952c',
    warningColorPressed: '#8d650c',
    successColor: '#1f883d',
    successColorHover: '#2aa24c',
    successColorPressed: '#186e31',
    bodyColor: '#101115',
    cardColor: '#17181d',
    modalColor: '#17181d',
    popoverColor: '#1d1f25',
    tableColor: '#17181d',
    inputColor: '#17181d',
    actionColor: '#0b0c0f',
    hoverColor: '#23252c',
    pressedColor: '#2b2e37',
    borderColor: '#2a2c34',
    dividerColor: '#2a2c34',
    textColorBase: '#e7e9ef',
    textColor1: '#e7e9ef',
    textColor2: '#a1a7b3',
    textColor3: '#7d8492',
    textColorDisabled: '#7d8492',
    placeholderColor: '#7d8492',
    iconColor: '#a1a7b3',
    scrollbarColor: '#3d404a',
    scrollbarColorHover: '#4c505c',
    boxShadow1: '0 1px 2px rgb(0 0 0 / 45%)',
    boxShadow2: '0 8px 24px -12px rgb(0 0 0 / 55%)',
    boxShadow3: '0 24px 64px -18px rgb(0 0 0 / 70%)',
  },
}

// -- accent themes --------------------------------------------------------------

/** Effective colour scheme for the naive-ui overrides (`isDark` in App.vue). */
export type ThemeScheme = 'light' | 'dark'

/** The accent-derived naive-ui variables (native primary-control colours). */
export interface AccentNaivePalette {
  accent: string
  hover: string
  pressed: string
}

/**
 * Canonical accent hexes for naive-ui, mirroring the semantic CSS tokens in
 * tokens.css: `--accent`, `--accent-hover`, `--accent-pressed` in the matching
 * scheme and `data-accent` variant. This is the only place outside tokens.css
 * that may spell these colours; the drift test in tokens.test.ts keeps the two
 * sources identical (all four variants × light/dark).
 *
 * Dark hover values are intentionally DEEPER than the base accent (blue,
 * violet, teal) instead of naive-ui's usual lightening: the hover surface
 * carries normal-size white text and naive-ui also uses `primaryColorHover` for
 * switch rails and input focus borders, so it must both clear WCAG AA 4.5:1
 * against white and stay visibly distinct from the base and pressed colours.
 * Amber's existing lighter hover already clears AA (5.02:1) and is unchanged.
 * tokens.test.ts enforces the white-text floor for every accent × scheme.
 */
export const ACCENT_NAIVE_PALETTES: Record<
  AccentTheme,
  Record<ThemeScheme, AccentNaivePalette>
> = {
  blue: {
    light: { accent: '#3568d4', hover: '#2a56b4', pressed: '#234a9e' },
    dark: { accent: '#2f6fed', hover: '#2b5fd9', pressed: '#2753c9' },
  },
  violet: {
    light: { accent: '#6d28d9', hover: '#5b21b6', pressed: '#4c1d95' },
    dark: { accent: '#7c3aed', hover: '#7433e0', pressed: '#6d28d9' },
  },
  teal: {
    light: { accent: '#0e7490', hover: '#155e75', pressed: '#164e63' },
    dark: { accent: '#0f7d99', hover: '#0e7692', pressed: '#0b6080' },
  },
  amber: {
    light: { accent: '#b45309', hover: '#92400e', pressed: '#78350f' },
    dark: { accent: '#a35407', hover: '#b45309', pressed: '#8a4306' },
  },
}

/**
 * naive-ui overrides for one accent theme + scheme, merged over
 * `themeOverrides` / `darkThemeOverrides` by App.vue's NConfigProvider. This is
 * what makes native naive-ui primary controls (n-button type=primary, switches,
 * input focus borders, …) follow Settings → Appearance instead of staying
 * brand-blue. Pure: no DOM/global state; an unknown accent falls back to blue
 * for the requested scheme (and an unknown scheme to light) instead of throwing.
 */
export function accentThemeOverrides(
  accent: AccentTheme,
  scheme: ThemeScheme,
): GlobalThemeOverrides {
  const schemeKey: ThemeScheme = scheme === 'dark' ? 'dark' : 'light'
  const palette =
    ACCENT_NAIVE_PALETTES[accent]?.[schemeKey] ?? ACCENT_NAIVE_PALETTES.blue[schemeKey]
  return {
    common: {
      primaryColor: palette.accent,
      primaryColorHover: palette.hover,
      primaryColorPressed: palette.pressed,
      primaryColorSuppl: palette.accent,
    },
  }
}