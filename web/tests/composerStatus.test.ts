// Focused tests for src/composerStatus.ts (the composer's truthful status
// seats: models, permission expectation, latest prompt-audit context). No DOM:
//   node --import ./tests/register-ts.mjs --test tests/composerStatus.test.ts

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { composerSeats, formatCharCount } from '../src/composerStatus.ts'
import type { ComposerStatusInput } from '../src/composerStatus.ts'

function audit(overrides: Partial<ComposerStatusInput['latestAudit']> = {}) {
  return {
    role: 'senior' as const,
    kind: 'review',
    tools: ['read_file', 'write_file'],
    systemChars: 4200,
    userChars: 8100,
    ...overrides,
  }
}

test('no data means no seats at all', () => {
  assert.deepEqual(composerSeats(null), [])
  assert.deepEqual(composerSeats(undefined), [])
  assert.deepEqual(composerSeats({}), [])
  // labels without loaded settings are not "data": the models seat stays hidden
  assert.deepEqual(composerSeats({ seniorLabel: 'x', juniorLabel: 'y' }), [])
})

test('the models seat appears only once role settings are loaded', () => {
  const seats = composerSeats({
    settingsReady: true,
    seniorLabel: 'gpt-5',
    juniorLabel: 'gpt-5-mini',
  })
  assert.equal(seats.length, 1)
  assert.equal(seats[0].id, 'models')
  assert.equal(seats[0].label, 'Models')
  assert.equal(seats[0].value, 'S gpt-5 · J gpt-5-mini')
  assert.match(seats[0].title, /Senior model: gpt-5/)
  assert.match(seats[0].title, /Junior model: gpt-5-mini/)
})

test('missing or blank model labels stay honest without inventing a model', () => {
  const seats = composerSeats({ settingsReady: true, seniorLabel: '  ', juniorLabel: null })
  assert.equal(seats[0].value, 'S not set · J not set')
  assert.match(seats[0].title, /Senior model: not set/)
})

test('the permission seat states the real approval model per workspace context', () => {
  const linked = composerSeats({ workspaceLinked: true })
  assert.equal(linked.length, 1)
  assert.equal(linked[0].id, 'permissions')
  assert.equal(linked[0].value, 'Ask in app')
  assert.match(linked[0].title, /pause the run and ask here/)

  const unlinked = composerSeats({ workspaceLinked: false })
  assert.equal(unlinked[0].value, 'No workspace')
  assert.match(unlinked[0].title, /no file or shell tools/)

  // unknown workspace context is hidden, not guessed
  assert.deepEqual(composerSeats({ workspaceLinked: null }), [])
})

test('the permission seat names the effective approval mode', () => {
  const seatOf = (mode: 'ask' | 'readonly' | 'edits' | 'allow-all') =>
    composerSeats({ workspaceLinked: true, approvalMode: mode })[0]

  const ask = seatOf('ask')
  assert.equal(ask.value, 'Ask in app')
  assert.match(ask.title, /ask here before running/)

  const readonly = seatOf('readonly')
  assert.equal(readonly.value, 'Read only')
  assert.match(readonly.title, /denied without asking/)
  assert.match(readonly.title, /Settings → Approvals/)

  const edits = seatOf('edits')
  assert.equal(edits.value, 'Edits auto')
  assert.match(edits.title, /writes and edits run without asking/)
  assert.match(edits.title, /deletes and shell commands pause the run/)

  const allowAll = seatOf('allow-all')
  assert.equal(allowAll.value, 'Allow all')
  assert.match(allowAll.title, /every action runs without asking/)
  assert.match(allowAll.title, /including deletes and shell commands/)

  // A mode is only meaningful for a linked workspace: the unlinked seat keeps
  // saying there are no privileged tools, whatever the saved mode is.
  const unlinked = composerSeats({ workspaceLinked: false, approvalMode: 'readonly' })[0]
  assert.equal(unlinked.value, 'No workspace')
})

test('the context seat reports the latest prompt audit exactly', () => {
  const seats = composerSeats({ latestAudit: audit() })
  assert.equal(seats.length, 1)
  const seat = seats[0]
  assert.equal(seat.id, 'context')
  assert.equal(seat.label, 'Context')
  assert.equal(seat.value, '4.2k system · 8.1k context · 2 tools')
  assert.match(seat.title, /Latest prompt audit \(Senior · review\)/)
  assert.match(seat.title, /4,200 system-prompt characters/)
  assert.match(seat.title, /8,100 context characters/)
  assert.match(seat.title, /2 tools offered/)
})

test('context counts are defensive: invalid or missing values cannot fabricate', () => {
  const seats = composerSeats({
    latestAudit: {
      role: 'junior',
      kind: '',
      tools: [],
      systemChars: Number.NaN,
      userChars: -12,
    } as ComposerStatusInput['latestAudit'],
  })
  assert.equal(seats[0].value, '0 system · 0 context · 0 tools')
  assert.doesNotMatch(seats[0].title, /NaN|-\d/)
})

test('a single offered tool is not pluralized', () => {
  const seats = composerSeats({ latestAudit: audit({ tools: ['read_file'] }) })
  assert.match(seats[0].value, /1 tool$/)
})

test('seats are ordered models → permissions → context', () => {
  const seats = composerSeats({
    settingsReady: true,
    seniorLabel: 'a',
    juniorLabel: 'b',
    workspaceLinked: true,
    latestAudit: audit(),
  })
  assert.deepEqual(
    seats.map((seat) => seat.id),
    ['models', 'permissions', 'context'],
  )
})

test('formatCharCount is compact, monotonic and bounded', () => {
  assert.equal(formatCharCount(0), '0')
  assert.equal(formatCharCount(-5), '0')
  assert.equal(formatCharCount(Number.NaN), '0')
  assert.equal(formatCharCount(Number.POSITIVE_INFINITY), '0')
  assert.equal(formatCharCount(999), '999')
  assert.equal(formatCharCount(1000), '1k')
  assert.equal(formatCharCount(1200), '1.2k')
  assert.equal(formatCharCount(1500), '1.5k')
  assert.equal(formatCharCount(9999), '10k')
  assert.equal(formatCharCount(12_345), '12k')
  assert.equal(formatCharCount(999_000), '999k')
  assert.equal(formatCharCount(999_949), '1M')
  assert.equal(formatCharCount(1_000_000), '1M')
  assert.equal(formatCharCount(2_450_000), '2.5M')
})
