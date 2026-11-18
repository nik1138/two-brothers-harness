/**
 * Source-level wiring tests for the structured operator question surfaces
 * (the web suite has no DOM/Vue runtime — see tests/AGENTS.md). Asserts the
 * QuestionCard branch in ChatView/App, the single-select-immediate / multi-
 * select-Confirm interaction split, the decline→deny mapping, the broken-
 * payload fallback note, and the additive api/types contract.
 *
 * Run with: node --import ./tests/register-ts.mjs --test tests/questionWiring.test.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/${relative}`, import.meta.url)), 'utf8')

// -- additive contract: types ---------------------------------------------------

test('types.ts: the approval event and answer body gain only additive fields', () => {
  const types = read('types.ts')
  assert.match(types, /kind\?: 'approval' \| 'question'/)
  assert.match(types, /question\?: unknown/)
  assert.match(types, /decision\?: 'answer'/)
  assert.match(types, /labels\?: string\[\]/)
  assert.match(types, /interface ApprovalQuestion \{/)
  assert.match(types, /multi_select\?: boolean/)
  assert.match(types, /intent\?: string/)
  // the pending-approval list payload carries the same additive fields
  const pending = types.slice(types.indexOf('interface PendingApproval'), types.indexOf('interface RunApprovalsView'))
  assert.match(pending, /kind\?: 'approval' \| 'question'/)
  assert.match(pending, /question\?: unknown/)
  // the approval answer route body stays compatible: allow is still required
  const answer = types.slice(types.indexOf('interface ApprovalAnswerRequest'), types.indexOf('interface ApprovalDecisionView'))
  assert.match(answer, /allow: boolean/)
})

// -- api.ts: the answering endpoint + body shape ---------------------------------

test('api.ts: answerRunQuestion reuses the approvals route with the additive decision', () => {
  const api = read('api.ts')
  assert.ok(api.includes('export async function answerRunQuestion'))
  assert.match(api, /\/api\/runs\/\$\{encodeURIComponent\(runId\)\}\/approvals\/\$\{encodeURIComponent\(approvalId\)\}/)
  assert.match(api, /json\('POST', \{ allow: true, decision: 'answer', labels \}\)/)
  // the existing allow/deny answer is untouched
  assert.ok(api.includes('export async function answerRunApproval'))
})

// -- ChatView branch --------------------------------------------------------------

test('ChatView renders QuestionCard for kind "question" and keeps ApprovalCard as the default', () => {
  const chat = read('components/ChatView.vue')
  assert.ok(chat.includes("import QuestionCard from './QuestionCard.vue'"))
  const questionIdx = chat.indexOf("row.entry.kind === 'question'")
  const approvalIdx = chat.indexOf('<ApprovalCard')
  assert.ok(questionIdx !== -1 && approvalIdx !== -1)
  assert.ok(questionIdx < approvalIdx, 'the question branch wins before the approval card')
  assert.ok(chat.includes(':answer="answerQuestion"'), 'the question card receives the answer callback')
  assert.ok(chat.includes('answerQuestion: (runId: string, approvalId: string, labels: string[]) => Promise<boolean>'))
  // docked suppression is preserved: the question card also respects isDockedApproval
  assert.match(chat, /isDockedApproval\(row\.entry\)/)
})

// -- QuestionCard interaction contract ---------------------------------------------

test('QuestionCard: single-select answers immediately; multi-select confirms picks', () => {
  const card = read('components/QuestionCard.vue')
  // single-select: clicking the option button posts its label at once
  assert.match(card, /@click="answerWith\(\[option\.label\]\)"/)
  assert.match(card, /type="checkbox"/, 'multi-select uses real checkboxes')
  assert.match(card, /:disabled="answering \|\| picked\.length === 0"/, 'Confirm is disabled until ≥1 picked')
  assert.match(card, /@click="confirmPicks"/)
  // decline rides the existing deny decision
  assert.match(card, /@click="decline"/)
  assert.match(card, /props\.resolve\(props\.item\.runId, props\.item\.approvalId, false\)/)
  // descriptions as secondary text; intent as a mono badge with an explaining tooltip
  assert.match(card, /class="question-option-description muted"/)
  assert.match(card, /class="question-option-intent"/)
  assert.match(card, /title="Machine-readable tag for this option"/)
  // keyboard: arrow keys move between the option controls
  assert.match(card, /e\.key !== 'ArrowDown' && e\.key !== 'ArrowUp'/)
  assert.match(card, /\.question-option'\)/)
})

test('QuestionCard: broken payload renders the generic surface with a bounded alert, never a crash', () => {
  const card = read('components/QuestionCard.vue')
  assert.match(card, /role="alert"/)
  assert.match(card, /QUESTION_FALLBACK_NOTE/)
  assert.match(card, /item\.questionError === true/)
  // the fallback still offers Decline (mapped to the deny decision)
  const fallback = card.slice(card.indexOf('v-if="broken"'))
  assert.match(fallback, /Decline/)
})

test('QuestionCard uses existing CSS tokens only', () => {
  const card = read('components/QuestionCard.vue')
  for (const token of ['--accent', '--danger', '--ok', '--border-subtle', '--surface-highlight', '--surface-panel']) {
    assert.ok(card.includes(`var(${token})`), `reuses ${token}`)
  }
})

// -- App.vue wiring -----------------------------------------------------------------

test('App.vue passes answerQuestion down and branches the dock', () => {
  const app = read('App.vue')
  assert.ok(app.includes("import QuestionCard from './components/QuestionCard.vue'"))
  assert.ok(app.includes('answerRunQuestion'))
  assert.ok(app.includes('async function answerQuestion('))
  assert.match(app, /decision: 'answer'/, 'a local answer resolution flips the card')
  assert.ok(app.includes(':answer-question="answerQuestion"'))
  // the dock renders QuestionCard for a parked question, ApprovalCard otherwise
  const dock = app.slice(app.indexOf('class="approval-dock"'))
  assert.match(dock, /<QuestionCard/)
  assert.match(dock, /pendingApproval\.kind === 'question'/)
  assert.match(dock, /<ApprovalCard v-else/)
})
