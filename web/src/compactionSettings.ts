// Pure model for Settings → Advanced → Auto-compaction: the four run-level
// context budgets the backend persists in the top-level `compaction` section of
// `sessions/settings.json` (snake_case, integers >= 0, 0 = off/unknown). No DOM
// and no Vue imports, so `tests/compactionSettings.test.ts` covers it directly:
//   node --import ./tests/register-ts.mjs --test tests/compactionSettings.test.ts
//
// The vocabulary mirrors `packages/harness/src/config.ts`
// (`CompactionSettingsView` / `CompactionFieldSource`) and
// `packages/harness/src/settings_store.ts` (`PersistedCompactionSettings`). The
// web workspace never imports backend sources, so keep the field names and the
// truthful copy in sync when the server shape changes.

import type {
  CompactionFieldSource,
  CompactionFieldView,
  CompactionSettingsView,
} from './types'

/** The four persisted budgets, in display order. */
export type CompactionFieldKey =
  | 'threshold_chars'
  | 'threshold_tokens'
  | 'keep_recent_chars'
  | 'context_window'

export const COMPACTION_FIELD_KEYS: readonly CompactionFieldKey[] = [
  'threshold_chars',
  'threshold_tokens',
  'keep_recent_chars',
  'context_window',
]

/** Every source the backend may report for one effective value. */
export const COMPACTION_SOURCES: readonly CompactionFieldSource[] = [
  'options',
  'flag',
  'persisted',
  'preset',
  'absent',
]

/** One field's operator-facing copy. */
export interface CompactionFieldCopy {
  key: CompactionFieldKey
  /** Short input label. */
  label: string
  /** One truthful sentence about what the budget does. */
  help: string
}

export const COMPACTION_FIELDS: readonly CompactionFieldCopy[] = [
  {
    key: 'threshold_chars',
    label: 'Threshold (chars)',
    help:
      'Compact proactively once the rendered transcript passes this many characters. ' +
      'Ignored in token mode.',
  },
  {
    key: 'threshold_tokens',
    label: 'Threshold (tokens)',
    help:
      'Compact proactively once the estimated transcript passes this many tokens. ' +
      'Setting it switches compaction to token mode.',
  },
  {
    key: 'keep_recent_chars',
    label: 'Keep recent (chars)',
    help:
      'How much recent transcript stays verbatim after a compaction. It only shapes ' +
      'a compaction; on its own it never triggers one.',
  },
  {
    key: 'context_window',
    label: 'Context window (tokens)',
    help:
      'The model context window, used to derive token-mode triggers and budgets. ' +
      'Leave 0 when the window is unknown; a serve flag/env or this saved value ' +
      "wins over the roles' provider presets (the smaller preset window applies last).",
  },
]

/** Shared helper copy: every budget treats 0 as "off/unknown". */
export const COMPACTION_ZERO_HELP =
  '0 = off/unknown. A serve CLI flag or TWO_BROTHERS_* environment variable pins ' +
  'its field and wins over the saved value.'

export const COMPACTION_UNSUPPORTED_REASON =
  'This backend does not support persisted compaction settings yet; it uses its ' +
  'startup flags only. Restart it from a current @two-brothers/harness build to ' +
  'save context budgets here.'

/** The four persisted budgets (0 = not stored). */
export type CompactionFieldValues = Record<CompactionFieldKey, number>

/** What the dialog knows about one field. */
export type CompactionFieldState = CompactionFieldView

/** What the dialog knows about the server's compaction settings. */
export interface CompactionState {
  /**
   * True when the backend returned a `compaction` section, i.e. it persists
   * budgets. An older backend omits the field; the dialog then disables the
   * card and must not send the section.
   */
  supported: boolean
  /** Stored values, used to seed the form and detect unsaved changes. */
  values: CompactionFieldValues
  /** Per-field stored/effective/source view from the backend. */
  fields: Record<CompactionFieldKey, CompactionFieldState>
  /** `--compact` on the server: compact once before every run starts. */
  force: boolean
  /** True when a serve flag/env pin (or server option) owns at least one field. */
  pinned: boolean
}

/** What the dialog holds while the operator types. */
export type CompactionInputs = Record<CompactionFieldKey, string>

// ---------------------------------------------------------------------------
// normalization of the backend payload (fail-soft, like approvalPolicyOf)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** A usable budget: a safe integer >= 0; anything else reads as 0. */
function budget(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function zeroField(): CompactionFieldState {
  return { persisted: 0, effective: 0, source: 'absent' }
}

function fieldOf(raw: unknown): CompactionFieldState {
  if (!isRecord(raw)) return zeroField()
  const source = COMPACTION_SOURCES.includes(raw.source as CompactionFieldSource)
    ? (raw.source as CompactionFieldSource)
    : 'absent'
  return {
    persisted: budget(raw.persisted),
    effective: budget(raw.effective),
    source,
  }
}

function valuesOf(fields: Record<CompactionFieldKey, CompactionFieldState>): CompactionFieldValues {
  return {
    threshold_chars: fields.threshold_chars.persisted,
    threshold_tokens: fields.threshold_tokens.persisted,
    keep_recent_chars: fields.keep_recent_chars.persisted,
    context_window: fields.context_window.persisted,
  }
}

/**
 * Read `GET /api/settings`' additive `compaction` section fail-soft: a missing
 * field (old backend) means unsupported with zero budgets and no save sent. A
 * present but malformed section still proves support; each unusable field
 * reads as 0/absent rather than inventing a budget.
 */
export function compactionSettingsOf(settings: unknown): CompactionState {
  const fields = {} as Record<CompactionFieldKey, CompactionFieldState>
  for (const key of COMPACTION_FIELD_KEYS) fields[key] = zeroField()
  const section = isRecord(settings) ? settings.compaction : undefined
  if (!isRecord(section)) {
    return {
      supported: false,
      values: valuesOf(fields),
      fields,
      force: false,
      pinned: false,
    }
  }
  const view = section as Partial<CompactionSettingsView> & Record<string, unknown>
  for (const key of COMPACTION_FIELD_KEYS) fields[key] = fieldOf(view[key])
  return {
    supported: true,
    values: valuesOf(fields),
    fields,
    force: view.force === true,
    pinned: view.pinned === true,
  }
}

/** The form seed for a state: the stored budgets as editable text. */
export function compactionInputsOf(state: CompactionState): CompactionInputs {
  return {
    threshold_chars: String(state.values.threshold_chars),
    threshold_tokens: String(state.values.threshold_tokens),
    keep_recent_chars: String(state.values.keep_recent_chars),
    context_window: String(state.values.context_window),
  }
}

// ---------------------------------------------------------------------------
// input validation and the save payload
// ---------------------------------------------------------------------------

/** One parsed input: a value, or null plus the inline error to show. */
export interface CompactionInputResult {
  value: number | null
  error: string | null
}

/**
 * Parse one numeric input strictly: an empty field means 0 (off/unknown),
 * otherwise only a non-negative whole number is accepted. Floats, negatives,
 * signs, exponents and text are inline errors — never silently coerced.
 */
export function parseCompactionInput(raw: string): CompactionInputResult {
  const text = String(raw ?? '').trim()
  if (text === '') return { value: 0, error: null }
  if (!/^\d+$/.test(text)) {
    return { value: null, error: 'Enter a whole number of 0 or more (0 = off/unknown).' }
  }
  const value = Number(text)
  if (!Number.isSafeInteger(value)) {
    return { value: null, error: 'This number is too large; use a smaller whole number.' }
  }
  return { value, error: null }
}

/** Parsed values plus per-field errors for the whole form. */
export interface CompactionFormResult {
  values: CompactionFieldValues
  errors: Partial<Record<CompactionFieldKey, string>>
  ok: boolean
}

export function compactionFormOf(inputs: CompactionInputs): CompactionFormResult {
  const values = {
    threshold_chars: 0,
    threshold_tokens: 0,
    keep_recent_chars: 0,
    context_window: 0,
  } satisfies CompactionFieldValues
  const errors: Partial<Record<CompactionFieldKey, string>> = {}
  for (const key of COMPACTION_FIELD_KEYS) {
    const parsed = parseCompactionInput(inputs[key] ?? '')
    if (parsed.error !== null) errors[key] = parsed.error
    else values[key] = parsed.value ?? 0
  }
  return { values, errors, ok: Object.keys(errors).length === 0 }
}

/**
 * The settings save payload for the budgets, or `{}` when the app must not send
 * the section: an older backend never reported it, so sending an unknown key
 * would be dropped at best and not sending keeps old documents untouched.
 * Values are sanitized to whole numbers >= 0 (the form already reported any
 * invalid input, and saving is blocked then).
 */
export function compactionPatch(
  state: Pick<CompactionState, 'supported'>,
  values: CompactionFieldValues,
): { compaction?: CompactionFieldValues } {
  if (!state.supported) return {}
  return {
    compaction: {
      threshold_chars: budget(values.threshold_chars),
      threshold_tokens: budget(values.threshold_tokens),
      keep_recent_chars: budget(values.keep_recent_chars),
      context_window: budget(values.context_window),
    },
  }
}

/**
 * True when the form differs from the stored budgets (an unparsable value
 * counts as dirty so the unsaved note never hides a broken field).
 */
export function compactionInputsDirty(
  inputs: CompactionInputs,
  state: CompactionState,
): boolean {
  for (const key of COMPACTION_FIELD_KEYS) {
    const parsed = parseCompactionInput(inputs[key] ?? '')
    if (parsed.value === null) return true
    if (parsed.value !== state.values[key]) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// display helpers
// ---------------------------------------------------------------------------

/** Fields currently owned by a CLI/env pin or a server option. */
export function pinnedCompactionFields(state: CompactionState): CompactionFieldKey[] {
  return COMPACTION_FIELD_KEYS.filter((key) => {
    const source = state.fields[key].source
    return source === 'flag' || source === 'options'
  })
}

/**
 * Honest one-line effective-value copy for one field. `not configured` means
 * the merge leaves the field out, so the harness applies its own default (or
 * nothing, for a trigger); it never claims a specific default value.
 */
export function effectiveCompactionText(field: CompactionFieldState): string {
  switch (field.source) {
    case 'flag':
      return `Effective: ${field.effective} (pinned by a serve flag/env)`
    case 'options':
      return `Effective: ${field.effective} (set by the server process)`
    case 'persisted':
      return `Effective: ${field.effective}`
    case 'preset':
      return `Effective: ${field.effective} (from the provider preset)`
    default:
      return 'Effective: not configured'
  }
}
