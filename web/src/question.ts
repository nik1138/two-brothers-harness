// Structured operator questions (the additive `kind: "question"` approval
// stream event). Pure module — no DOM, no network.
//
// The boundary is tolerant in the house idiom (api.ts::normalizeMcpStatus):
// `normalizeQuestion` coerces field types, clamps oversized values and returns
// null for input that cannot be rendered (missing text, fewer than two valid
// options). A null result never crashes the UI — the question card falls back
// to the generic approval surface with a bounded error note.
import type { ApprovalQuestion, ApprovalQuestionOption } from './types'

/** Hard bounds for one question payload (mirrors the backend's size caps). */
export const QUESTION_HEADER_MAX = 200
export const QUESTION_TEXT_MAX = 4_000
export const QUESTION_LABEL_MAX = 200
export const QUESTION_DESCRIPTION_MAX = 500
export const QUESTION_INTENT_MAX = 100
/** At least two options make a choice; more than this is clamped, not rendered. */
export const QUESTION_OPTIONS_MIN = 2
export const QUESTION_OPTIONS_MAX = 20

function boundedText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed
}

function normalizeOption(value: unknown): ApprovalQuestionOption | null {
  if (value === null || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const label = boundedText(raw.label, QUESTION_LABEL_MAX)
  if (label === null) return null
  const option: ApprovalQuestionOption = { label }
  const description = boundedText(raw.description, QUESTION_DESCRIPTION_MAX)
  if (description !== null) option.description = description
  const intent = boundedText(raw.intent, QUESTION_INTENT_MAX)
  if (intent !== null) option.intent = intent
  return option
}

/**
 * Tolerant read of one raw `question` payload. Returns the normalized question,
 * or null when the payload is unusable (not an object, missing/empty text,
 * options not an array, fewer than `QUESTION_OPTIONS_MIN` valid options).
 * Extra fields are dropped; oversized strings are bounded with an ellipsis.
 */
export function normalizeQuestion(value: unknown): ApprovalQuestion | null {
  if (value === null || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const text = boundedText(raw.text, QUESTION_TEXT_MAX)
  if (text === null) return null
  if (!Array.isArray(raw.options)) return null
  const options: ApprovalQuestionOption[] = []
  for (const entry of raw.options) {
    const option = normalizeOption(entry)
    if (option !== null) options.push(option)
    if (options.length >= QUESTION_OPTIONS_MAX) break
  }
  if (options.length < QUESTION_OPTIONS_MIN) return null
  const question: ApprovalQuestion = { text, options }
  const header = boundedText(raw.header, QUESTION_HEADER_MAX)
  if (header !== null) question.header = header
  if (raw.multi_select === true) question.multi_select = true
  return question
}

/**
 * The bounded, operator-facing error note for a `kind: "question"` event whose
 * payload failed tolerant normalization. Static on purpose: the raw payload is
 * untrusted and never rendered.
 */
export const QUESTION_FALLBACK_NOTE =
  'This question could not be displayed (its options were missing or invalid). ' +
  'You can decline it to let the run continue.'
