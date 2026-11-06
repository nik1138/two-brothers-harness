/**
 * Single source of truth for the web workspace's keyboard shortcuts and the
 * `/help` reference overlay. The table is static (no rebinding UI): it lists
 * the gestures the web app actually implements, grouped for the overlay.
 */

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
