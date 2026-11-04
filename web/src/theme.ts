import type { GlobalThemeOverrides } from 'naive-ui'

/**
 * Naive UI theme overrides mapped from the design tokens in style.css
 * (:root custom properties). Keep the two in sync when tokens change.
 *
 * | token                | naive var        |
 * |----------------------|------------------|
 * | --accent             | primaryColor*    |
 * | --danger             | errorColor*      |
 * | --warning            | warningColor*    |
 * | --ok                 | successColor*    |
 * | --text-primary       | textColorBase/1  |
 * | --text-secondary     | textColor2       |
 * | --border-subtle      | borderColor      |
 * | --surface-hover      | hoverColor       |
 * | --radius-sm          | borderRadius*    |
 * | body font stack      | fontFamily       |
 */
export const themeOverrides: GlobalThemeOverrides = {
  common: {
    primaryColor: '#2f6fed',
    primaryColorHover: '#5a8bf0',
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
    textColorBase: '#1d2129',
    textColor1: '#1d2129',
    textColor2: '#646a73',
    textColor3: '#646a73',
    borderColor: '#e4e6eb',
    dividerColor: '#e4e6eb',
    inputColor: '#ffffff',
    bodyColor: '#f4f5f7',
    cardColor: '#ffffff',
    modalColor: '#ffffff',
    popoverColor: '#ffffff',
    actionColor: '#f4f5f7',
    hoverColor: '#eef0f3',
    borderRadius: '12px',
    borderRadiusSmall: '8px',
    fontFamily:
      "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
  },
}

/** Dark-scheme overrides matching the `@media (prefers-color-scheme: dark)`
 * tokens in style.css. Consumed with naive's `darkTheme`. */
export const darkThemeOverrides: GlobalThemeOverrides = {
  common: {
    ...themeOverrides.common,
    bodyColor: '#17181c',
    cardColor: '#1f2026',
    modalColor: '#1f2026',
    popoverColor: '#1f2026',
    inputColor: '#1f2026',
    actionColor: '#232429',
    hoverColor: '#2a2b31',
    borderColor: '#33353c',
    dividerColor: '#33353c',
    textColorBase: '#e8eaf0',
    textColor1: '#e8eaf0',
    textColor2: '#9aa0ab',
    textColor3: '#9aa0ab',
  },
}
