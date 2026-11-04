/**
 * Manual color-scheme control (G-6). The design tokens in style.css follow the
 * OS scheme by default (a prefers-color-scheme block); `data-theme` on <html>
 * pins one scheme regardless of the OS.
 *
 * - 'system' removes the attribute, so the media query stays authoritative.
 * - 'light' / 'dark' write the matching tokens block from style.css.
 *
 * naive-ui's theme is driven separately by `isDark` in App.vue — keep the two
 * in step through resolveDark().
 */
export type ThemeMode = 'light' | 'dark' | 'system'

const STORAGE_KEY = 'two-brothers.theme'

const MODES: readonly ThemeMode[] = ['light', 'dark', 'system']

/** Stored preference, or 'system' when nothing usable is stored. */
export function readThemeMode(): ThemeMode {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY)
    if (saved && (MODES as readonly string[]).includes(saved)) return saved as ThemeMode
  } catch {
    // localStorage can be unavailable (private mode / blocked storage)
  }
  return 'system'
}

export function saveThemeMode(mode: ThemeMode): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, mode)
  } catch {
    // the toggle still works for this page view; only persistence is lost
  }
}

/** Effective color scheme for a mode — 'system' follows the OS. */
export function resolveDark(mode: ThemeMode, systemDark: boolean): boolean {
  return mode === 'system' ? systemDark : mode === 'dark'
}

/** Pin (or release) the token block by writing `data-theme` on <html>. */
export function applyThemeAttribute(mode: ThemeMode, isDark: boolean): void {
  const root = document.documentElement
  if (mode === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', isDark ? 'dark' : 'light')
}

/** Cycle order used by the header toggle: light → dark → system → light. */
export function nextThemeMode(mode: ThemeMode): ThemeMode {
  const i = MODES.indexOf(mode)
  return MODES[(i + 1) % MODES.length]
}

export function themeModeLabel(mode: ThemeMode): string {
  return mode === 'system' ? 'system' : mode
}

/** Header button glyph: sun / moon / half circle for the system follow. */
export function themeModeGlyph(mode: ThemeMode): string {
  if (mode === 'light') return '☀'
  if (mode === 'dark') return '☾'
  return '◐'
}