// Focused tests for src/composerKeys.ts (the composer key contract, the
// double-Escape stop gesture and the shortcut-reference chord) plus the
// single-source shortcut table in src/shortcuts.ts. No DOM:
//   node --import ./tests/register-ts.mjs --test tests/composerKeys.test.ts

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  STOP_GESTURE_WINDOW_MS,
  canSubmitComposer,
  canUseStopGesture,
  classifyComposerKey,
  classifyComposerRecall,
  composerLockReason,
  isImeComposing,
  isStopGesture,
} from '../src/composerKeys.ts'
import type { ComposerKeyInput } from '../src/composerKeys.ts'
import {
  SHORTCUTS,
  SHORTCUT_GROUPS,
  shortcutGroupViews,
} from '../src/shortcuts.ts'

function key(overrides: Partial<ComposerKeyInput> = {}): ComposerKeyInput {
  return { key: 'Enter', ...overrides }
}

// -- IME & submit -------------------------------------------------------------

test('isImeComposing covers isComposing and the legacy keyCode 229', () => {
  assert.equal(isImeComposing(key()), false)
  assert.equal(isImeComposing(key({ isComposing: true })), true)
  assert.equal(isImeComposing(key({ keyCode: 229 })), true)
  assert.equal(isImeComposing(null), false)
})

test('closed picker: Enter submits, Ctrl/Cmd+Enter is the accelerated gesture', () => {
  assert.equal(classifyComposerKey(key(), false), 'submit')
  assert.equal(classifyComposerKey(key({ ctrlKey: true }), false), 'submit-accelerated')
  assert.equal(classifyComposerKey(key({ metaKey: true }), false), 'submit-accelerated')
  // Alt+Enter is the dedicated steer gesture (wave 23)
  assert.equal(classifyComposerKey(key({ altKey: true }), false), 'steer')
  // Shift still wins the newline, and the submit chords are unchanged
  assert.equal(classifyComposerKey(key({ shiftKey: true }), false), 'newline')
  assert.equal(classifyComposerKey(key({ ctrlKey: true, shiftKey: true }), false), 'newline')
})

test('Alt+Enter is a steer intent: exact modifiers, IME/repeat safe', () => {
  assert.equal(classifyComposerKey(key({ altKey: true }), false), 'steer')
  // Shift takes precedence (newline), exactly as before the gesture existed.
  assert.equal(classifyComposerKey(key({ altKey: true, shiftKey: true }), false), 'newline')
  // IME composition and held repeats never steer (nor submit).
  assert.equal(classifyComposerKey(key({ altKey: true, isComposing: true }), false), 'ignore')
  assert.equal(classifyComposerKey(key({ altKey: true, keyCode: 229 }), false), 'ignore')
  assert.equal(classifyComposerKey(key({ altKey: true, repeat: true }), false), 'ignore')
  // Only Alt+Enter: a second modifier keeps the pre-gesture no-op meaning.
  assert.equal(classifyComposerKey(key({ altKey: true, ctrlKey: true }), false), 'ignore')
  assert.equal(classifyComposerKey(key({ altKey: true, metaKey: true }), false), 'ignore')
  // Other Alt-modified keys are ordinary typing, not the steer chord.
  assert.equal(classifyComposerKey(key({ key: 'a', altKey: true }), false), 'ignore')
  assert.equal(classifyComposerKey(key({ key: 'Tab', altKey: true }), false), 'ignore')
  // An open picker owns Enter: Alt+Enter accepts the highlighted row, exactly
  // like Enter did before the steer intent existed.
  assert.equal(classifyComposerKey(key({ altKey: true }), true), 'picker-accept')
})

test('the steer intent agrees with the /help shortcut table', () => {
  const row = SHORTCUTS.find((entry) => entry.id === 'steer')
  assert.ok(row !== undefined, 'the Alt+Enter steer gesture is listed in /help')
  assert.deepEqual(row!.keys, ['Alt', 'Enter'])
  assert.match(row!.description ?? '', /next step/)
  // The documented chord is exactly the one the pure classifier emits, so the
  // help copy can never describe a different key.
  assert.equal(classifyComposerKey(key({ altKey: true }), false), 'steer')
  assert.equal(classifyComposerKey(key(), false), 'submit')
})

test('a held or IME-composing Enter never submits', () => {
  assert.equal(classifyComposerKey(key({ repeat: true }), false), 'ignore')
  assert.equal(classifyComposerKey(key({ repeat: true, ctrlKey: true }), false), 'ignore')
  assert.equal(classifyComposerKey(key({ isComposing: true }), false), 'ignore')
  assert.equal(classifyComposerKey(key({ keyCode: 229 }), false), 'ignore')
  assert.equal(classifyComposerKey(null, false), 'ignore')
})

test('Escape with no picker open is left to the shell layers', () => {
  assert.equal(classifyComposerKey(key({ key: 'Escape' }), false), 'ignore')
  assert.equal(classifyComposerKey(key({ key: 'ArrowDown' }), false), 'ignore')
  assert.equal(classifyComposerKey(key({ key: 'a' }), false), 'ignore')
})

// -- picker keys --------------------------------------------------------------

test('open picker: Enter/Tab accept, Shift+Tab/Escape close, arrows move', () => {
  assert.equal(classifyComposerKey(key(), true), 'picker-accept')
  assert.equal(classifyComposerKey(key({ key: 'Tab' }), true), 'picker-accept')
  assert.equal(classifyComposerKey(key({ key: 'Tab', shiftKey: true }), true), 'picker-close')
  assert.equal(classifyComposerKey(key({ key: 'Escape' }), true), 'picker-close')
  assert.equal(classifyComposerKey(key({ key: 'ArrowDown' }), true), 'picker-next')
  assert.equal(classifyComposerKey(key({ key: 'ArrowUp' }), true), 'picker-prev')
  // Shift+Enter keeps the textarea newline behaviour
  assert.equal(classifyComposerKey(key({ shiftKey: true }), true), 'newline')
  // typing filters, it never submits or closes
  assert.equal(classifyComposerKey(key({ key: 'p' }), true), 'ignore')
})

test('open picker: Enter can never submit and repeats are ignored', () => {
  for (const input of [
    key(),
    key({ ctrlKey: true }),
    key({ metaKey: true }),
    key({ altKey: true }),
  ]) {
    assert.equal(classifyComposerKey(input, true), 'picker-accept')
  }
  assert.equal(classifyComposerKey(key({ repeat: true }), true), 'ignore')
  assert.equal(classifyComposerKey(key({ key: 'Tab', repeat: true }), true), 'picker-accept')
  assert.equal(classifyComposerKey(key({ isComposing: true }), true), 'ignore')
})

// -- composer recall bridge ---------------------------------------------------

const SINGLE_END = { text: 'draft', selectionStart: 5, selectionEnd: 5 }
const SINGLE_START = { text: 'draft', selectionStart: 0, selectionEnd: 0 }
const MULTILINE_EDGES = {
  start: { text: 'one\ntwo', selectionStart: 0, selectionEnd: 0 },
  end: { text: 'one\ntwo', selectionStart: 7, selectionEnd: 7 },
  interior: { text: 'one\ntwo', selectionStart: 3, selectionEnd: 3 },
}
const IDLE_RECALL = { pickerOpen: false, recallActive: false, historyCount: 2 }

test('composer recall bridge: inactive recall leaves Up/Down unconsumed', () => {
  // The polish fix: with accepted history but no browsing, ArrowDown must fall
  // through (null = the caller must not preventDefault) so the textarea moves
  // the caret natively instead of eating a no-op.
  assert.equal(classifyComposerRecall(key({ key: 'ArrowDown' }), SINGLE_END, IDLE_RECALL), null)
  assert.equal(
    classifyComposerRecall(
      key({ key: 'ArrowDown' }),
      SINGLE_END,
      { ...IDLE_RECALL, historyCount: 0 },
    ),
    null,
  )
  // Up still starts a recall when there is history...
  assert.equal(
    classifyComposerRecall(key({ key: 'ArrowUp' }), SINGLE_END, IDLE_RECALL),
    'recall-previous',
  )
  // ...and falls through when there is nothing to recall.
  assert.equal(
    classifyComposerRecall(
      key({ key: 'ArrowUp' }),
      SINGLE_START,
      { ...IDLE_RECALL, historyCount: 0 },
    ),
    null,
  )
})

test('composer recall bridge: browsing keeps Up/Down, including boundary no-ops', () => {
  const browsing = { ...IDLE_RECALL, recallActive: true }
  assert.equal(
    classifyComposerRecall(key({ key: 'ArrowUp' }), SINGLE_END, browsing),
    'recall-previous',
  )
  assert.equal(
    classifyComposerRecall(key({ key: 'ArrowDown' }), SINGLE_END, browsing),
    'recall-next',
  )
  // Active browsing claims its boundary no-ops exactly as before (the caller
  // consumes the key; the pure step function is the one that does nothing).
  assert.equal(
    classifyComposerRecall(key({ key: 'ArrowUp' }), SINGLE_START, browsing),
    'recall-previous',
  )
})

test('composer recall bridge: picker, IME, modifiers and selection still defer', () => {
  assert.equal(
    classifyComposerRecall(
      key({ key: 'ArrowUp' }),
      SINGLE_END,
      { ...IDLE_RECALL, pickerOpen: true },
    ),
    null,
  )
  for (const blocked of [
    { isComposing: true },
    { keyCode: 229 },
    { repeat: true },
    { shiftKey: true },
    { ctrlKey: true },
    { metaKey: true },
    { altKey: true },
  ]) {
    assert.equal(
      classifyComposerRecall(key({ key: 'ArrowUp', ...blocked }), SINGLE_END, IDLE_RECALL),
      null,
      JSON.stringify(blocked),
    )
  }
  assert.equal(classifyComposerRecall(key({ key: 'Enter' }), SINGLE_END, IDLE_RECALL), null)
  // Enter is not a recall key, so the steer chord is never claimed by recall:
  // the composer handles Alt+Enter through `classifyComposerKey` instead.
  assert.equal(classifyComposerRecall(key({ altKey: true }), SINGLE_END, IDLE_RECALL), null)
  const selection = { text: 'draft', selectionStart: 0, selectionEnd: 2 }
  assert.equal(classifyComposerRecall(key({ key: 'ArrowUp' }), selection, IDLE_RECALL), null)
  assert.equal(classifyComposerRecall(null, SINGLE_END, IDLE_RECALL), null)
})

test('composer recall bridge: the multiline absolute-edge rule is unchanged', () => {
  assert.equal(
    classifyComposerRecall(key({ key: 'ArrowUp' }), MULTILINE_EDGES.interior, IDLE_RECALL),
    null,
  )
  assert.equal(
    classifyComposerRecall(key({ key: 'ArrowUp' }), MULTILINE_EDGES.start, IDLE_RECALL),
    'recall-previous',
  )
  const browsing = { ...IDLE_RECALL, recallActive: true }
  assert.equal(
    classifyComposerRecall(key({ key: 'ArrowDown' }), MULTILINE_EDGES.interior, browsing),
    null,
  )
  assert.equal(
    classifyComposerRecall(key({ key: 'ArrowDown' }), MULTILINE_EDGES.end, browsing),
    'recall-next',
  )
  // single-line drafts recall/step from any caret column
  assert.equal(
    classifyComposerRecall(key({ key: 'ArrowUp' }), SINGLE_START, IDLE_RECALL),
    'recall-previous',
  )
})

// -- compose lock -------------------------------------------------------------

test('canSubmitComposer: text plus no lock; compaction is its own lock reason', () => {
  assert.equal(canSubmitComposer({ text: 'ship it' }), true)
  assert.equal(canSubmitComposer({ text: '   ' }), false)
  assert.equal(canSubmitComposer({ text: '' }), false)
  assert.equal(canSubmitComposer(null), false)
  assert.equal(canSubmitComposer({ busy: true, text: 'ship it' }), false)
  assert.equal(canSubmitComposer({ waiting: true, text: 'ship it' }), false)
  assert.equal(canSubmitComposer({ compacting: true, text: 'ship it' }), false)
  assert.equal(composerLockReason({ compacting: true }), 'compacting')
  assert.equal(composerLockReason({ waiting: true }), 'waiting')
  assert.equal(composerLockReason({}), null)
  // precedence: a working run outranks compaction, which outranks an approval wait
  assert.equal(composerLockReason({ waiting: true, compacting: true }), 'compacting')
  assert.equal(composerLockReason({ busy: true, compacting: true, waiting: true }), 'busy')
  assert.equal(composerLockReason(null), 'busy')
})

// -- double-escape stop gesture ----------------------------------------------

test('isStopGesture: a 500 ms window, resetting outside it', () => {
  assert.equal(STOP_GESTURE_WINDOW_MS, 500)
  assert.equal(isStopGesture(null, 1000), false)
  assert.equal(isStopGesture(1000, 1000), true)
  assert.equal(isStopGesture(1000, 1500), true)
  assert.equal(isStopGesture(1000, 1501), false)
  assert.equal(isStopGesture(1501, 1000), false)
  assert.equal(isStopGesture(Number.NaN, 1000), false)
  assert.equal(isStopGesture(1000, 1100, 0), false)
})

test('canUseStopGesture: only in the conversation with a live run', () => {
  const ok = { runActive: true }
  assert.equal(canUseStopGesture(ok), true)
  assert.equal(canUseStopGesture(null), false)
  assert.equal(canUseStopGesture({ runActive: false }), false)
  for (const blocked of [
    { composing: true },
    { repeat: true },
    { defaultPrevented: true },
    { dialogOpen: true },
    { approvalFocused: true },
    { drawerOpen: true },
    { outsideConversation: true },
  ]) {
    assert.equal(
      canUseStopGesture({ runActive: true, ...blocked }),
      false,
      JSON.stringify(blocked),
    )
  }
})

// -- shortcut table -----------------------------------------------------------

test('SHORTCUTS covers the documented gestures with unique ids', () => {
  const ids = SHORTCUTS.map((entry) => entry.id)
  assert.equal(new Set(ids).size, ids.length, 'ids are unique')
  for (const required of [
    'send',
    'send-accelerated',
    'newline',
    'stop',
    'palette',
    'find',
    'shortcut-help',
    'escape-layering',
  ]) {
    assert.ok(ids.includes(required), `missing shortcut: ${required}`)
  }
  for (const entry of SHORTCUTS) {
    assert.ok(entry.keys.length > 0, `${entry.id} has keys`)
    assert.ok(entry.label.length > 0, `${entry.id} has a label`)
    assert.ok(SHORTCUT_GROUPS.includes(entry.group))
  }
  const stop = SHORTCUTS.find((entry) => entry.id === 'stop')
  assert.deepEqual(stop?.keys, ['Esc', 'Esc'])
})

test('shortcutGroupViews keeps the declared group order and drops empty groups', () => {
  const views = shortcutGroupViews()
  assert.deepEqual(views.map((view) => view.group), [...SHORTCUT_GROUPS])
  for (const view of views) {
    assert.ok(view.entries.length > 0)
    for (const entry of view.entries) assert.equal(entry.group, view.group)
  }
  // custom subset: only groups that have entries are rendered
  const subset = shortcutGroupViews([
    { id: 'x', group: 'Composer', keys: ['Enter'], label: 'Send' },
  ])
  assert.deepEqual(subset.map((view) => view.group), ['Composer'])
})
