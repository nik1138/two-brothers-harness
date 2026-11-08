/**
 * Single source of truth for the web workspace's keyboard shortcuts and the
 * `/help` reference overlay.
 *
 * {@link SHORTCUTS} is the static default table: it lists the gestures the web
 * app implements, grouped for the overlay, and is what an untouched install
 * shows. First-slice rebinding covers exactly three modifier chords — the
 * command palette, find in the conversation and this shortcut reference — so
 * {@link shortcutEntries} renders the *current* bindings into those rows (and
 * into the palette-derived rows, whose actions run from the palette) while
 * every other shortcut stays fixed.
 */

import {
  DEFAULT_KEYBINDINGS,
  bindingKeyCaps,
  detectBindingPlatform,
} from './keybindings'
import type { BindingPlatform, Keybindings } from './keybindings'

export type ShortcutGroup =
  | 'Composer'
  | 'Pickers'
  | 'Navigation'
  | 'Session'
  | 'Appearance'
  | 'Layers'

export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
  'Composer',
  'Pickers',
  'Navigation',
  'Session',
  'Appearance',
  'Layers',
]

export interface ShortcutEntry {
  /** Stable id (tests + keys). */
  id: string
  group: ShortcutGroup
  /** Key caps to render, in order. */
  keys: string[]
  label: string
  description?: string
  /** True for the three chords the operator can rebind (Settings → Keyboard). */
  rebindable?: boolean
}

/**
 * Every implemented shortcut. Entries that the web exposes through the command
 * palette say so honestly ("Ctrl/⌘ K, then …") instead of inventing a chord.
 */
export const SHORTCUTS: readonly ShortcutEntry[] = [
  {
    id: 'send',
    group: 'Composer',
    keys: ['Enter'],
    label: 'Send the task',
  },
  {
    id: 'send-accelerated',
    group: 'Composer',
    keys: ['Ctrl/⌘', 'Enter'],
    label: 'Send now',
    description: 'Explicit accelerated submit gesture',
  },
  {
    id: 'steer',
    group: 'Composer',
    keys: ['Alt', 'Enter'],
    label: 'Steer the running run',
    description:
      "Applies the draft at the run's next step; only while a run is working or waiting on an approval",
  },
  {
    id: 'newline',
    group: 'Composer',
    keys: ['Shift', 'Enter'],
    label: 'Insert a newline',
  },
  {
    id: 'stop',
    group: 'Composer',
    keys: ['Esc', 'Esc'],
    label: 'Stop the running run',
    description: 'Press twice within half a second, outside dialogs and approval prompts',
  },
  {
    id: 'mentions',
    group: 'Composer',
    keys: ['@'],
    label: 'Attach a skill or workspace file',
    description: 'Type @skill: to narrow to skills',
  },
  {
    id: 'commands',
    group: 'Composer',
    keys: ['/'],
    label: 'Open the command menu',
    description: 'At the start of a line; built-in actions run locally',
  },
  {
    id: 'recall',
    group: 'Composer',
    keys: ['↑', '↓'],
    label: 'Recall previous tasks',
    description:
      'At the draft edges; the unsent draft is preserved and restored exactly',
  },
  {
    id: 'picker-navigate',
    group: 'Pickers',
    keys: ['↑', '↓'],
    label: 'Move through picker rows',
  },
  {
    id: 'picker-accept',
    group: 'Pickers',
    keys: ['Enter', 'Tab'],
    label: 'Insert or run the highlighted row',
  },
  {
    id: 'picker-dismiss',
    group: 'Pickers',
    keys: ['Esc', 'Shift', 'Tab'],
    label: 'Close the picker',
  },
  {
    id: 'palette',
    group: 'Navigation',
    keys: ['Ctrl/⌘', 'K'],
    label: 'Open the command palette / search',
  },
  {
    id: 'find',
    group: 'Navigation',
    keys: ['Ctrl/⌘', 'F'],
    label: 'Find in the conversation',
  },
  {
    id: 'shortcut-help',
    group: 'Navigation',
    keys: ['?', 'Ctrl/⌘ /'],
    label: 'Show this shortcut reference',
  },
  {
    id: 'new-session',
    group: 'Session',
    keys: ['Ctrl/⌘', 'K'],
    label: 'New session',
    description: 'From the command palette',
  },
  {
    id: 'search-sessions',
    group: 'Session',
    keys: ['Ctrl/⌘', 'K'],
    label: 'Search sessions and messages',
    description: 'From the command palette',
  },
  {
    id: 'theme',
    group: 'Appearance',
    keys: ['Ctrl/⌘', 'K'],
    label: 'Change the theme',
    description: 'From the command palette (Theme: Light / Dark / System)',
  },
  {
    id: 'settings',
    group: 'Appearance',
    keys: ['Ctrl/⌘', 'K'],
    label: 'Open settings',
    description: 'From the command palette',
  },
  {
    id: 'escape-layering',
    group: 'Layers',
    keys: ['Esc'],
    label: 'Close the topmost layer',
    description: 'Picker → dialog → mobile drawer; Escape never submits the draft',
  },
]

/** Inputs for the, current-bindings-aware shortcut table. */
export interface ShortcutRenderOptions {
  /** Current bindings (defaults when omitted, e.g. a standalone mount). */
  bindings?: Keybindings
  /** Label platform (`Ctrl` vs `⌘`); defaults to this browser's platform. */
  platform?: BindingPlatform
}

/**
 * The shortcut table rendered for the current bindings: the three rebindable
 * chords and every palette-derived row show the operator's current chords,
 * while the fixed entries stay exactly as declared. `?` remains a fixed alias
 * for the shortcut reference next to its rebindable modifier chord.
 */
export function shortcutEntries(options: ShortcutRenderOptions = {}): ShortcutEntry[] {
  const bindings = options.bindings ?? DEFAULT_KEYBINDINGS
  const platform = options.platform ?? detectBindingPlatform()
  const paletteKeys = bindingKeyCaps(bindings.palette, platform)
  const findKeys = bindingKeyCaps(bindings.find, platform)
  const helpKeys = bindingKeyCaps(bindings['shortcut-help'], platform)
  return SHORTCUTS.map((entry) => {
    switch (entry.id) {
      case 'palette':
        return { ...entry, keys: paletteKeys, rebindable: true }
      case 'find':
        return { ...entry, keys: findKeys, rebindable: true }
      case 'shortcut-help':
        return {
          ...entry,
          keys: ['?', ...helpKeys],
          rebindable: true,
          description: '? is a fixed alias; the modifier chord is rebindable in Settings → Keyboard',
        }
      case 'new-session':
      case 'search-sessions':
      case 'theme':
      case 'settings':
        // These actions run from the palette, so their chord follows it.
        return { ...entry, keys: paletteKeys }
      default:
        return entry
    }
  })
}

export interface ShortcutGroupView {
  group: ShortcutGroup
  entries: ShortcutEntry[]
}

/** The table grouped for rendering (groups keep `SHORTCUT_GROUPS` order). */
export function shortcutGroupViews(
  entries: readonly ShortcutEntry[] = SHORTCUTS,
): ShortcutGroupView[] {
  const views: ShortcutGroupView[] = []
  for (const group of SHORTCUT_GROUPS) {
    const grouped = entries.filter((entry) => entry.group === group)
    if (grouped.length) views.push({ group, entries: grouped })
  }
  return views
}
