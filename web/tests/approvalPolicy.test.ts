// Focused tests for src/approvalPolicy.ts — the pure Settings → Approvals
// model (mode copy, fail-closed normalization, old-backend fail-soft, save
// payload, pinned/read-only explanations). No DOM:
//   node --import ./tests/register-ts.mjs --test tests/approvalPolicy.test.ts

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  APPROVAL_MODES,
  DEFAULT_APPROVAL_MODE,
  approvalModeCopy,
  approvalModeDanger,
  approvalPolicyDisabledReason,
  approvalPolicyOf,
  approvalPolicyPatch,
  isApprovalMode,
  normalizeApprovalMode,
} from '../src/approvalPolicy.ts'

// ---------------------------------------------------------------------------
// mode vocabulary and copy
// ---------------------------------------------------------------------------

test('APPROVAL_MODES is the exact four-mode enum with ask as the default', () => {
  assert.deepEqual(APPROVAL_MODES, ['ask', 'readonly', 'edits', 'allow-all'])
  assert.equal(DEFAULT_APPROVAL_MODE, 'ask')
  for (const mode of APPROVAL_MODES) {
    assert.equal(isApprovalMode(mode), true)
    const copy = approvalModeCopy(mode)
    assert.equal(copy.mode, mode)
    assert.ok(copy.label.length > 0, `${mode} has a label`)
    assert.ok(copy.description.length > 0, `${mode} has honest copy`)
    // The destructive warning exists only for the mode that weakens a guardrail.
    assert.equal(approvalModeDanger(mode) !== null, mode === 'allow-all', mode)
  }
})

test('the copy states the real decision table per mode', () => {
  assert.match(approvalModeCopy('ask').description, /Reads run freely/)
  assert.match(approvalModeCopy('ask').description, /wait for your approval/)
  assert.match(approvalModeCopy('readonly').description, /Only reads run/)
  assert.match(approvalModeCopy('readonly').description, /denied without asking/)
  assert.match(approvalModeCopy('edits').description, /Reads, writes and edits run freely/)
  assert.match(approvalModeCopy('edits').description, /Deletes and shell commands/)
  assert.match(approvalModeCopy('allow-all').description, /without asking/)
  assert.match(approvalModeDanger('allow-all') ?? '', /irreversible change/)
})

test('normalizeApprovalMode never upgrades an unknown value', () => {
  for (const mode of APPROVAL_MODES) assert.equal(normalizeApprovalMode(mode), mode)
  for (const bad of [
    'ASK',
    'Readonly',
    'read-only',
    'auto',
    'never',
    'yolo',
    '',
    '   ',
    null,
    undefined,
    42,
    {},
    ['edits'],
  ]) {
    assert.equal(normalizeApprovalMode(bad), 'ask', JSON.stringify(bad))
    assert.equal(isApprovalMode(bad), false)
  }
})

// ---------------------------------------------------------------------------
// reading GET /api/settings
// ---------------------------------------------------------------------------

test('approvalPolicyOf reads the additive section with its pin state', () => {
  assert.deepEqual(approvalPolicyOf({ approval_policy: { mode: 'readonly' } }), {
    mode: 'readonly',
    supported: true,
    pinned: false,
  })
  assert.deepEqual(approvalPolicyOf({ approval_policy: { mode: 'allow-all', pinned: true } }), {
    mode: 'allow-all',
    supported: true,
    pinned: true,
  })
  // the rest of the settings payload is irrelevant to the policy read
  const state = approvalPolicyOf({
    senior: { provider: 'openai' },
    plugins: ['notes'],
    approval_policy: { mode: 'edits' },
  })
  assert.equal(state.mode, 'edits')
})

test('an older backend (no field) shows ask and reports unsupported', () => {
  for (const payload of [
    {},
    { senior: {}, junior: {} },
    { approval_policy: undefined },
    { approval_policy: null },
    { approval_policy: 'readonly' },
    { approval_policy: 42 },
    { approval_policy: ['edits'] },
    null,
    undefined,
  ]) {
    const state = approvalPolicyOf(payload)
    assert.equal(state.mode, 'ask', JSON.stringify(payload))
    assert.equal(state.supported, false, JSON.stringify(payload))
    assert.equal(state.pinned, false)
  }
})

test('a corrupt or unknown mode in a present section still fails closed to ask', () => {
  for (const section of [
    {},
    { mode: 'auto' },
    { mode: 'ASK' },
    { mode: 42 },
    { mode: null },
    { mode: '' },
  ]) {
    const state = approvalPolicyOf({ approval_policy: section })
    assert.equal(state.mode, 'ask', JSON.stringify(section))
    // the section proves the backend helps with modes, so saves are sent
    assert.equal(state.supported, true)
  }
  // pinned is only true for the strict boolean
  assert.equal(approvalPolicyOf({ approval_policy: { mode: 'ask', pinned: 'yes' } }).pinned, false)
})

// ---------------------------------------------------------------------------
// writing PUT /api/settings
// ---------------------------------------------------------------------------

test('approvalPolicyPatch sends the section only to a supporting, unpinned backend', () => {
  for (const mode of APPROVAL_MODES) {
    assert.deepEqual(approvalPolicyPatch({ mode, supported: true, pinned: false }), {
      approval_policy: { mode },
    })
  }
  // An old backend must not receive an unknown key (and must not have its
  // settings rewritten by this app); the dialog keeps Ask displayed.
  assert.deepEqual(approvalPolicyPatch({ mode: 'allow-all', supported: false, pinned: false }), {})
  assert.deepEqual(approvalPolicyPatch({ mode: 'readonly', supported: false, pinned: true }), {})
})

test('a pinned mode never reaches the persisted settings through a Save', () => {
  // The pin is server-process state: a normal Settings save while pinned must
  // not turn it into the durable approval_policy (a restart without the pin
  // would otherwise keep the pinned mode).
  for (const mode of APPROVAL_MODES) {
    assert.deepEqual(approvalPolicyPatch({ mode, supported: true, pinned: true }), {})
  }
})

test('approvalPolicyPatch normalizes a confused mode instead of sending it', () => {
  const payload = approvalPolicyPatch({ mode: 'auto' as never, supported: true, pinned: false })
  assert.deepEqual(payload, { approval_policy: { mode: 'ask' } })
})

// ---------------------------------------------------------------------------
// read-only explanations
// ---------------------------------------------------------------------------

test('a pinned server mode explains why the selector cannot change it', () => {
  const reason = approvalPolicyDisabledReason({ supported: true, pinned: true })
  assert.ok(reason !== null)
  assert.match(reason!, /TWO_BROTHERS_APPROVAL_MODE/)
  assert.match(reason!, /Restart the server/)
})

test('an old backend explains that it cannot persist a mode', () => {
  const reason = approvalPolicyDisabledReason({ supported: false, pinned: false })
  assert.ok(reason !== null)
  assert.match(reason!, /does not support approval modes/)
  assert.match(reason!, /applies Ask/)
})

test('a supported, unpinned backend leaves the selector editable', () => {
  assert.equal(approvalPolicyDisabledReason({ supported: true, pinned: false }), null)
  // pinned wins when both are somehow set
  assert.notEqual(approvalPolicyDisabledReason({ supported: false, pinned: true }), null)
})
