// Focused tests for src/compactionSettings.ts — the pure Settings → Advanced →
// Auto-compaction model (payload normalization, strict input parsing, save
// payload, dirty tracking, pinned/effective copy). No DOM:
//   node --import ./tests/register-ts.mjs --test tests/compactionSettings.test.ts

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  COMPACTION_FIELDS,
  COMPACTION_FIELD_KEYS,
  COMPACTION_SOURCES,
  COMPACTION_UNSUPPORTED_REASON,
  COMPACTION_ZERO_HELP,
  compactionFormOf,
  compactionInputsDirty,
  compactionInputsOf,
  compactionPatch,
  compactionSettingsOf,
  effectiveCompactionText,
  parseCompactionInput,
  pinnedCompactionFields,
} from '../src/compactionSettings.ts'
import type { CompactionInputs, CompactionSettingsView } from '../src/types.ts'

function field(persisted: number, effective: number, source: string) {
  return { persisted, effective, source }
}

const SAVED: CompactionSettingsView = {
  threshold_chars: field(12000, 12000, 'persisted'),
  threshold_tokens: field(0, 0, 'absent'),
  keep_recent_chars: field(300, 50000, 'flag'),
  context_window: field(0, 8000, 'options'),
  force: false,
  pinned: true,
}

// ---------------------------------------------------------------------------
// vocabulary and copy
// ---------------------------------------------------------------------------

test('the four budget fields and their copy are the documented set', () => {
  assert.deepEqual(COMPACTION_FIELD_KEYS, [
    'threshold_chars',
    'threshold_tokens',
    'keep_recent_chars',
    'context_window',
  ])
  assert.deepEqual(
    COMPACTION_FIELDS.map((entry) => entry.key),
    COMPACTION_FIELD_KEYS,
  )
  for (const entry of COMPACTION_FIELDS) {
    assert.ok(entry.label.length > 0, `${entry.key} has a label`)
    assert.ok(entry.help.length > 0, `${entry.key} has honest help`)
  }
  assert.match(COMPACTION_ZERO_HELP, /0 = off\/unknown/)
  assert.match(COMPACTION_ZERO_HELP, /pins/)
  assert.match(COMPACTION_UNSUPPORTED_REASON, /does not support persisted compaction/)
  assert.deepEqual(COMPACTION_SOURCES, ['options', 'flag', 'persisted', 'absent'])
})

// ---------------------------------------------------------------------------
// backend payload normalization (fail-soft)
// ---------------------------------------------------------------------------

test('an older backend without the section reads as unsupported with zero budgets', () => {
  for (const payload of [null, undefined, 42, 'compaction', [], {}, { senior: {} }]) {
    const state = compactionSettingsOf(payload)
    assert.equal(state.supported, false, `unsupported for ${JSON.stringify(payload)}`)
    assert.deepEqual(state.values, {
      threshold_chars: 0,
      threshold_tokens: 0,
      keep_recent_chars: 0,
      context_window: 0,
    })
    for (const key of COMPACTION_FIELD_KEYS) {
      assert.deepEqual(state.fields[key], { persisted: 0, effective: 0, source: 'absent' })
    }
    assert.equal(state.force, false)
    assert.equal(state.pinned, false)
  }
})

test('a valid section reads field by field with stored, effective and source', () => {
  const state = compactionSettingsOf({ compaction: SAVED })
  assert.equal(state.supported, true)
  assert.deepEqual(state.values, {
    threshold_chars: 12000,
    threshold_tokens: 0,
    keep_recent_chars: 300,
    context_window: 0,
  })
  assert.deepEqual(state.fields.threshold_chars, field(12000, 12000, 'persisted'))
  assert.deepEqual(state.fields.keep_recent_chars, field(300, 50000, 'flag'))
  assert.deepEqual(state.fields.context_window, field(0, 8000, 'options'))
  assert.equal(state.pinned, true)
  assert.equal(state.force, false)

  const forced = compactionSettingsOf({ compaction: { ...SAVED, force: true } })
  assert.equal(forced.force, true)
})

test('a malformed section still proves support but never invents a budget', () => {
  const state = compactionSettingsOf({
    compaction: {
      threshold_chars: { persisted: -5, effective: 'x', source: 'nonsense' },
      threshold_tokens: null,
      keep_recent_chars: { persisted: 1.5, effective: Number.NaN, source: 'flag' },
      context_window: { persisted: 8000, effective: 8000, source: 'persisted' },
      force: 'yes',
      pinned: 1,
    },
  })
  assert.equal(state.supported, true)
  assert.deepEqual(state.fields.threshold_chars, { persisted: 0, effective: 0, source: 'absent' })
  assert.deepEqual(state.fields.threshold_tokens, { persisted: 0, effective: 0, source: 'absent' })
  assert.deepEqual(state.fields.keep_recent_chars, { persisted: 0, effective: 0, source: 'flag' })
  assert.deepEqual(state.fields.context_window, field(8000, 8000, 'persisted'))
  assert.equal(state.force, false)
  assert.equal(state.pinned, false)
  assert.deepEqual(state.values, {
    threshold_chars: 0,
    threshold_tokens: 0,
    keep_recent_chars: 0,
    context_window: 8000,
  })
})

test('the form seeds from the stored values as editable text', () => {
  const state = compactionSettingsOf({ compaction: SAVED })
  assert.deepEqual(compactionInputsOf(state), {
    threshold_chars: '12000',
    threshold_tokens: '0',
    keep_recent_chars: '300',
    context_window: '0',
  })
})

// ---------------------------------------------------------------------------
// strict input parsing
// ---------------------------------------------------------------------------

test('input parsing accepts whole numbers and treats empty as 0', () => {
  assert.deepEqual(parseCompactionInput(''), { value: 0, error: null })
  assert.deepEqual(parseCompactionInput('   '), { value: 0, error: null })
  assert.deepEqual(parseCompactionInput('0'), { value: 0, error: null })
  assert.deepEqual(parseCompactionInput('12000'), { value: 12000, error: null })
  assert.deepEqual(parseCompactionInput(' 300 '), { value: 300, error: null })
  assert.deepEqual(parseCompactionInput('007'), { value: 7, error: null })
})

test('input parsing rejects negatives, floats, signs, exponents and text', () => {
  for (const bad of ['-1', '1.5', '+3', '1e3', '0x10', 'abc', '12,000', '1 2', '٣']) {
    const parsed = parseCompactionInput(bad)
    assert.equal(parsed.value, null, bad)
    assert.match(parsed.error ?? '', /whole number of 0 or more/, bad)
  }
  const huge = parseCompactionInput('9'.repeat(400))
  assert.equal(huge.value, null)
  assert.match(huge.error ?? '', /too large/)
})

test('the whole form reports one inline error per invalid field', () => {
  const inputs: CompactionInputs = {
    threshold_chars: '12000',
    threshold_tokens: '-2',
    keep_recent_chars: '300',
    context_window: 'nope',
  }
  const form = compactionFormOf(inputs)
  assert.equal(form.ok, false)
  assert.deepEqual(form.errors, {
    threshold_tokens: 'Enter a whole number of 0 or more (0 = off/unknown).',
    context_window: 'Enter a whole number of 0 or more (0 = off/unknown).',
  })
  assert.deepEqual(form.values, {
    threshold_chars: 12000,
    threshold_tokens: 0,
    keep_recent_chars: 300,
    context_window: 0,
  })

  const empty = compactionFormOf({
    threshold_chars: '',
    threshold_tokens: '',
    keep_recent_chars: '',
    context_window: '',
  })
  assert.equal(empty.ok, true)
  assert.deepEqual(empty.errors, {})
  assert.deepEqual(empty.values, {
    threshold_chars: 0,
    threshold_tokens: 0,
    keep_recent_chars: 0,
    context_window: 0,
  })
})

// ---------------------------------------------------------------------------
// save payload and dirty tracking
// ---------------------------------------------------------------------------

test('the save payload is omitted for an older backend and complete otherwise', () => {
  assert.deepEqual(
    compactionPatch({ supported: false }, { threshold_chars: 12000, threshold_tokens: 0, keep_recent_chars: 300, context_window: 0 }),
    {},
  )
  assert.deepEqual(
    compactionPatch({ supported: true }, { threshold_chars: 12000, threshold_tokens: 0, keep_recent_chars: 300, context_window: 0 }),
    {
      compaction: {
        threshold_chars: 12000,
        threshold_tokens: 0,
        keep_recent_chars: 300,
        context_window: 0,
      },
    },
  )
  // values are sanitized to usable budgets even if a caller hands garbage in
  assert.deepEqual(
    compactionPatch(
      { supported: true },
      { threshold_chars: -1, threshold_tokens: 1.5, keep_recent_chars: Number.NaN, context_window: 8000 },
    ),
    {
      compaction: {
        threshold_chars: 0,
        threshold_tokens: 0,
        keep_recent_chars: 0,
        context_window: 8000,
      },
    },
  )
})

test('dirty tracking compares parsed values with the stored budgets', () => {
  const state = compactionSettingsOf({ compaction: SAVED })
  const seed = compactionInputsOf(state)
  assert.equal(compactionInputsDirty(seed, state), false)
  // Equivalent text (leading zeros, surrounding spaces) is not dirty.
  assert.equal(
    compactionInputsDirty({ ...seed, threshold_chars: ' 012000 ' }, state),
    false,
  )
  assert.equal(compactionInputsDirty({ ...seed, threshold_chars: '13000' }, state), true)
  assert.equal(compactionInputsDirty({ ...seed, context_window: '8000' }, state), true)
  // An unparsable value counts as dirty so the unsaved note never hides it.
  assert.equal(compactionInputsDirty({ ...seed, keep_recent_chars: 'abc' }, state), true)
})

// ---------------------------------------------------------------------------
// display helpers
// ---------------------------------------------------------------------------

test('pinned fields are exactly the flag/options ones', () => {
  const state = compactionSettingsOf({ compaction: SAVED })
  assert.deepEqual(pinnedCompactionFields(state), ['keep_recent_chars', 'context_window'])
  const unsupported = compactionSettingsOf(null)
  assert.deepEqual(pinnedCompactionFields(unsupported), [])
})

test('effective copy is honest about pins and unconfigured fields', () => {
  assert.match(
    effectiveCompactionText({ persisted: 300, effective: 50000, source: 'flag' }),
    /^Effective: 50000 \(pinned by a serve flag\/env\)$/,
  )
  assert.match(
    effectiveCompactionText({ persisted: 0, effective: 8000, source: 'options' }),
    /^Effective: 8000 \(set by the server process\)$/,
  )
  assert.match(
    effectiveCompactionText({ persisted: 12000, effective: 12000, source: 'persisted' }),
    /^Effective: 12000$/,
  )
  assert.equal(
    effectiveCompactionText({ persisted: 0, effective: 0, source: 'absent' }),
    'Effective: not configured',
  )
})
