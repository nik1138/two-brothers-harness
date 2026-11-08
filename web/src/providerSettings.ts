/**
 * Provider preset master–detail model (pure, DOM-free).
 *
 * The Settings → Providers surface is an identity-only list with the selected
 * provider's settings expanded inline (the dialog body is too narrow for
 * side-by-side panes). Everything decision-like lives here so it is testable:
 * normalization of the additive `seed`/`customized` flags (old-backend
 * fallback), selection/open state, dirty tracking, role "used by" badges,
 * delete/reset eligibility and impact copy, add-form validation and list
 * keyboard arithmetic.
 */

import type { ProviderPreset } from './types'

/** Default wire family for a new/unknown provider. */
export const PROVIDER_KIND_DEFAULT = 'openai-compatible'

/** Wire families the server knows; the picker shows friendly labels. */
export const PROVIDER_KINDS: readonly { value: string; label: string }[] = [
  { value: 'openai-compatible', label: 'OpenAI-compatible' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'google', label: 'Google Gemini' },
]

/** Provider ids are typed by operators and referenced by roles; keep them strict. */
export const PROVIDER_NAME_PATTERN = /^[a-z][a-z0-9-]*$/

/** Render-ready provider row/detail model. */
export interface ProviderView {
  name: string
  base_url: string
  api_key_set: boolean
  kind: string
  models: string[]
  /** Declared context window in tokens; 0 = unknown (older backends omit it). */
  context_window: number
  /** Built-in seed preset (additive server flag, false when absent). */
  seed: boolean
  /** A stored entry exists for this name (true when the flag is absent). */
  customized: boolean
}

/** Editable draft of one provider's settings (the key always starts empty). */
export interface ProviderDraft {
  baseUrl: string
  apiKey: string
  models: string[]
  kind: string
  /** Context window as typed text; validated strictly on save (0 = unknown). */
  contextWindow: string
}

export interface ProviderRoleRefs {
  senior?: string | null
  junior?: string | null
}

/** Add-card draft, unwrapped from the form refs for validation. */
export interface AddProviderForm {
  name: unknown
  baseUrl: unknown
}

/** Field-level validation errors for the Add card (empty = valid). */
export interface AddProviderValidation {
  name?: string
  baseUrl?: string
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** Trim, drop empties/duplicates, keep order (mirrors server cleanModelList). */
export function cleanModelList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    const model = text(entry)
    if (!model || seen.has(model)) continue
    seen.add(model)
    out.push(model)
  }
  return out
}

/** A usable preset context window: a positive safe integer, else 0 (unknown). */
export function providerContextWindowOf(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0
}

/** One parsed context-window input: a value, or an inline error. */
export interface ProviderContextWindowResult {
  /** Whole tokens; 0 means unknown. */
  value: number
  error: string | null
}

/**
 * Strict context-window input parsing (mirrors the server's PUT validation):
 * empty means 0/unknown, otherwise only a non-negative whole number is
 * accepted. Floats, negatives, signs, exponents and text are errors — never
 * silently coerced.
 */
export function parseProviderContextWindow(value: unknown): ProviderContextWindowResult {
  const raw = text(value)
  if (raw === '') return { value: 0, error: null }
  if (!/^\d+$/.test(raw)) {
    return { value: 0, error: 'Enter a whole number of tokens (0 = unknown).' }
  }
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed)) {
    return { value: 0, error: 'This number is too large; use a smaller whole number.' }
  }
  return { value: parsed, error: null }
}

/** Order-sensitive comparison of two model lists after cleaning. */
export function sameModelList(a: unknown, b: unknown): boolean {
  const left = cleanModelList(a)
  const right = cleanModelList(b)
  if (left.length !== right.length) return false
  return left.every((model, index) => model === right[index])
}

/** Friendly label for a wire-family value (unknown values render verbatim). */
export function providerKindLabel(kind: unknown): string {
  const value = text(kind) || PROVIDER_KIND_DEFAULT
  return PROVIDER_KINDS.find((entry) => entry.value === value)?.label ?? value
}

/**
 * Tolerant normalization of `GET /api/providers`: drops malformed entries,
 * keeps the backend's order and dedupes names (first wins, case-insensitive).
 *
 * Additive flags: `seed` defaults to false; `customized` defaults to true (an
 * older backend cannot tell a seed from a stored entry, so every row stays
 * editable/deletable and the UI still renders).
 */
export function normalizeProviders(raw: unknown): ProviderView[] {
  if (!Array.isArray(raw)) return []
  const out: ProviderView[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    const item = record(entry)
    if (!item) continue
    const name = text(item.name)
    if (!name || seen.has(name.toLowerCase())) continue
    seen.add(name.toLowerCase())
    out.push({
      name,
      base_url: typeof item.base_url === 'string' ? item.base_url.trim() : '',
      api_key_set: item.api_key_set === true,
      kind: text(item.kind) || PROVIDER_KIND_DEFAULT,
      models: cleanModelList(item.models),
      context_window: providerContextWindowOf(item.context_window),
      seed: typeof item.seed === 'boolean' ? item.seed : false,
      customized: typeof item.customized === 'boolean' ? item.customized : true,
    })
  }
  return out
}

/** Keep the current selection when it still exists; otherwise select the first. */
export function resolveProviderSelection(
  providers: readonly ProviderView[],
  current: string | null | undefined,
): string | null {
  if (!providers.length) return null
  if (typeof current === 'string' && providers.some((provider) => provider.name === current)) {
    return current
  }
  return providers[0]?.name ?? null
}

/** One detail open at a time: clicking the open row closes it. */
export function toggleOpenProvider(
  current: string | null | undefined,
  clicked: string,
): string | null {
  return current === clicked ? null : clicked
}

/** "Built-in" vs "Custom" detail badge. */
export function providerBadge(provider: Pick<ProviderView, 'seed'>): 'Built-in' | 'Custom' {
  return provider.seed ? 'Built-in' : 'Custom'
}

/** A seed with a stored override gets the subtle "Customized" row badge. */
export function providerIsCustomizedSeed(
  provider: Pick<ProviderView, 'seed' | 'customized'> | null | undefined,
): boolean {
  return !!provider && provider.seed === true && provider.customized === true
}

/** Reset is only offered for a built-in seed with a stored override. */
export function providerResetAllowed(
  provider: Pick<ProviderView, 'seed' | 'customized'> | null | undefined,
): boolean {
  return providerIsCustomizedSeed(provider)
}

/** Roles whose `provider_ref` points at this provider (case-insensitive). */
export function providerUsageBadges(
  provider: Pick<ProviderView, 'name'>,
  refs: ProviderRoleRefs,
): Array<'Senior' | 'Junior'> {
  const name = provider.name.trim().toLowerCase()
  if (!name) return []
  const out: Array<'Senior' | 'Junior'> = []
  if (text(refs.senior).toLowerCase() === name) out.push('Senior')
  if (text(refs.junior).toLowerCase() === name) out.push('Junior')
  return out
}

/** Initial edit draft for one provider (the key always starts empty). */
export function providerDraftOf(
  provider: Pick<ProviderView, 'base_url' | 'models' | 'kind' | 'context_window'> | null | undefined,
): ProviderDraft {
  return {
    baseUrl: provider?.base_url ?? '',
    apiKey: '',
    models: [...(provider?.models ?? [])],
    kind: text(provider?.kind) || PROVIDER_KIND_DEFAULT,
    contextWindow: String(providerContextWindowOf(provider?.context_window)),
  }
}

/** True when the draft would change something. */
export function isProviderDraftDirty(
  provider: Pick<ProviderView, 'base_url' | 'models' | 'kind' | 'context_window'>,
  draft: ProviderDraft | null | undefined,
): boolean {
  if (!draft) return false
  if (text(draft.baseUrl) !== text(provider.base_url)) return true
  if (text(draft.apiKey).length > 0) return true
  if (!sameModelList(draft.models, provider.models)) return true
  if ((text(draft.kind) || PROVIDER_KIND_DEFAULT) !== (text(provider.kind) || PROVIDER_KIND_DEFAULT)) {
    return true
  }
  // An unparsable window counts as dirty so the unsaved note never hides a
  // broken field; equivalent text (spaces, leading zeros) is not dirty.
  const window = parseProviderContextWindow(draft.contextWindow)
  if (window.error !== null) return true
  if (window.value !== providerContextWindowOf(provider.context_window)) return true
  return false
}

/** Masked-key placeholder by state; the value itself is never echoed. */
export function apiKeyPlaceholder(provider: Pick<ProviderView, 'api_key_set'>): string {
  return provider.api_key_set
    ? 'Set — type a new value to replace'
    : 'Not set — paste a key to store one'
}

/** Non-color key state for the row dot's accessible name. */
export function apiKeyStateLabel(provider: Pick<ProviderView, 'api_key_set'>): string {
  return provider.api_key_set ? 'API key set' : 'API key missing'
}

/**
 * Delete is only offered where the server accepts it: stored (non-seed)
 * providers. A pure seed DELETE is a 404; customized seeds use the reset
 * endpoint instead because DELETE would also clear role refs.
 */
export function providerDeleteAllowed(
  provider: Pick<ProviderView, 'seed'> | null | undefined,
): boolean {
  return !!provider && provider.seed !== true
}

/** Impact sentence for the Delete confirmation, naming the affected roles. */
export function providerDeleteImpact(roles: readonly ('Senior' | 'Junior')[]): string {
  if (!roles.length) return 'No role uses this provider. Its base URL, key and models are removed.'
  const tail = roles[roles.length - 1]!
  const names = roles.length === 1 ? tail : `${roles.slice(0, -1).join(', ')} and ${tail}`
  const pronoun = roles.length === 1 ? 'It' : 'They'
  return `${names} ${roles.length === 1 ? 'uses' : 'use'} this provider. ${pronoun} will switch to Manual.`
}

/** Validate a Base URL: required and http(s) (the server only checks non-empty). */
export function validateProviderBaseUrl(value: unknown): string | null {
  const url = text(value)
  if (!url) return 'Base URL must not be empty.'
  if (!/^https?:\/\//i.test(url)) return 'Base URL must start with http:// or https://.'
  return null
}

/**
 * Add-card validation: strict provider id (lowercase start), duplicate check
 * against the loaded names (case-insensitive), and an http(s) Base URL.
 * Returns null when the form is valid.
 */
export function validateAddProviderForm(
  form: AddProviderForm | null | undefined,
  existingNames: readonly string[] = [],
): AddProviderValidation | null {
  const errors: AddProviderValidation = {}
  const name = text(form?.name)
  if (!name) {
    errors.name = 'Name is required.'
  } else if (!PROVIDER_NAME_PATTERN.test(name)) {
    errors.name = 'Use lowercase letters, digits and hyphens, starting with a letter.'
  } else {
    const lowered = name.toLowerCase()
    if (existingNames.some((existing) => text(existing).toLowerCase() === lowered)) {
      errors.name = 'A provider already uses this ID.'
    }
  }
  const baseProblem = validateProviderBaseUrl(form?.baseUrl)
  if (baseProblem) errors.baseUrl = baseProblem
  return Object.keys(errors).length ? errors : null
}

export type ProviderListMove = 'up' | 'down' | 'first' | 'last'

/**
 * Next roving-focus index for the list (wraps on up/down, Home/End jump).
 * Returns -1 for an empty list.
 */
export function nextProviderIndex(
  current: number,
  count: number,
  move: ProviderListMove,
): number {
  if (!Number.isFinite(count) || count <= 0) return -1
  const size = Math.floor(count)
  const index = Number.isFinite(current) ? Math.min(Math.max(Math.floor(current), 0), size - 1) : 0
  switch (move) {
    case 'first':
      return 0
    case 'last':
      return size - 1
    case 'up':
      return (index - 1 + size) % size
    case 'down':
      return (index + 1) % size
    default:
      return index
  }
}

/** Keyboard move for a listbox key, or null when the key is not a move. */
export function providerMoveForKey(key: string): ProviderListMove | null {
  switch (key) {
    case 'ArrowUp':
      return 'up'
    case 'ArrowDown':
      return 'down'
    case 'Home':
      return 'first'
    case 'End':
      return 'last'
    default:
      return null
  }
}

/** Compact identity summary used by the row's title/tooltip. */
export function providerRowSummary(provider: ProviderView): string {
  const models = provider.models.length
  return `${provider.name} · ${providerKindLabel(provider.kind)} · ${models} model${
    models === 1 ? '' : 's'
  }`
}

/** Merge a PUT response into the current list, preserving the seed flags. */
export function applyProviderUpdate(
  providers: readonly ProviderPreset[],
  saved: ProviderPreset,
): ProviderPreset[] {
  const name = text(saved.name).toLowerCase()
  return providers.map((provider) => {
    if (text(provider.name).toLowerCase() !== name) return provider
    return {
      ...provider,
      name: saved.name || provider.name,
      base_url: saved.base_url,
      api_key_set: saved.api_key_set,
      kind: saved.kind,
      models: cleanModelList(saved.models),
      context_window: providerContextWindowOf(saved.context_window),
    }
  })
}

/** Merge a reset response, replacing stale override flags with the pristine flags. */
export function applyProviderReset(
  providers: readonly ProviderPreset[],
  restored: ProviderPreset,
): ProviderPreset[] {
  const name = text(restored.name).toLowerCase()
  return providers.map((provider) => {
    if (text(provider.name).toLowerCase() !== name) return provider
    return {
      ...provider,
      name: restored.name || provider.name,
      base_url: restored.base_url,
      api_key_set: restored.api_key_set,
      kind: restored.kind,
      models: cleanModelList(restored.models),
      context_window: providerContextWindowOf(restored.context_window),
      seed: restored.seed === true,
      customized: restored.customized === true,
    }
  })
}

// -- model discovery ("Refresh models") ---------------------------------------
//
// Discovery is a manual probe, deliberately separate from Apply: it never
// writes the provider preset and never touches the draft by itself. The pure
// state below is driven by the component, with a monotonic token so a slow
// response can never overwrite the result of a newer probe (or a draft the
// operator has since switched away from).

/** Copy for a backend that predates the discovery route (missing route = 404). */
export const DISCOVERY_UNSUPPORTED_BACKEND =
  'Model discovery is not supported by this backend. Nothing was changed.'

/** Phases of one "Refresh models" probe. */
export type ProviderDiscoveryPhase =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'empty'
  | 'error'
  | 'unsupported'

/** Pure state behind the Settings → Providers "Refresh models" control. */
export interface ProviderDiscoveryState {
  /** Monotonic token of the newest probe (0 before the first). */
  token: number
  /** Provider the newest probe belongs to ('' before the first). */
  name: string
  phase: ProviderDiscoveryPhase
  /** Model ids the endpoint reported (never applied automatically). */
  models: string[]
  /** Honest copy for the empty/error/unsupported phases ('' otherwise). */
  message: string
}

function discoveryState(
  token: number,
  name: string,
  phase: ProviderDiscoveryPhase,
  models: string[] = [],
  message = '',
): ProviderDiscoveryState {
  return { token, name, phase, models, message }
}

/** Initial idle state (nothing probed yet). */
export function newDiscoveryState(): ProviderDiscoveryState {
  return discoveryState(0, '', 'idle')
}

/**
 * Begin a probe. `token` must be newer than every previous one; the caller
 * keeps the counter (the model stays pure and deterministic in tests).
 */
export function startDiscovery(name: string, token: number): ProviderDiscoveryState {
  return discoveryState(token, text(name), 'loading')
}

/** True while a settling response still belongs to the newest probe. */
export function isCurrentDiscovery(
  state: ProviderDiscoveryState,
  token: number,
  name: string,
): boolean {
  return state.token === token && state.name === text(name)
}

/**
 * Tolerant model ids from a discovery response (`[{id, owned_by?}]`, bare id
 * strings, or a `{models: [...]}` wrapper): trimmed, deduped, order preserved.
 */
export function discoveredModels(raw: unknown): string[] {
  const wrapped = record(raw)
  let entries: unknown
  if (Array.isArray(raw)) entries = raw
  else entries = wrapped?.models ?? wrapped?.data
  if (!Array.isArray(entries)) return []
  const out: string[] = []
  for (const entry of entries) {
    const item = record(entry)
    const id = typeof entry === 'string' ? text(entry) : text(item?.id ?? item?.name)
    if (!id || out.includes(id)) continue
    out.push(id)
  }
  return out
}

/**
 * Settle a successful probe. An empty list is a valid answer: it becomes the
 * honest `empty` phase and says the saved catalog is untouched — it must never
 * be treated as a reason to erase the draft's model list.
 */
export function settleDiscovery(
  state: ProviderDiscoveryState,
  token: number,
  name: string,
  raw: unknown,
): ProviderDiscoveryState {
  if (!isCurrentDiscovery(state, token, name)) return state
  const models = discoveredModels(raw)
  if (models.length === 0) {
    return discoveryState(
      token,
      state.name,
      'empty',
      [],
      'The endpoint reported no models. Your saved model list is unchanged.',
    )
  }
  return discoveryState(token, state.name, 'ready', models)
}

/**
 * Settle a failed probe. A 404 means the backend has no discovery route yet
 * (old build) and an "unsupported" 400 means the wire kind has no compatible
 * listing — both are shown honestly as unsupported, never as a scary network
 * error, and neither can corrupt the draft.
 */
export function failDiscovery(
  state: ProviderDiscoveryState,
  token: number,
  name: string,
  status: number,
  detail: string,
): ProviderDiscoveryState {
  if (!isCurrentDiscovery(state, token, name)) return state
  const message = text(detail)
  if (status === 404) {
    return discoveryState(token, state.name, 'unsupported', [], DISCOVERY_UNSUPPORTED_BACKEND)
  }
  if (status === 400 && /not supported/i.test(message)) {
    return discoveryState(token, state.name, 'unsupported', [], message)
  }
  return discoveryState(
    token,
    state.name,
    'error',
    [],
    `Model discovery failed: ${message || `HTTP ${status}`}`,
  )
}

/** Discovery is only truthful for endpoints that expose an OpenAI `/models`. */
export function supportsModelDiscovery(kind: unknown): boolean {
  return (text(kind) || PROVIDER_KIND_DEFAULT) === PROVIDER_KIND_DEFAULT
}

/** Honest copy for a wire kind that has no OpenAI-compatible model listing. */
export function unsupportedDiscoveryCopy(kind: unknown): string {
  return `Model discovery is not supported for ${providerKindLabel(
    kind,
  )} providers; only OpenAI-compatible endpoints expose a /models listing. List models by hand or use two-brothers models with an OpenAI-compatible endpoint.`
}

/** Visible status copy for the control ('' when there is nothing to say). */
export function discoveryStatusText(state: ProviderDiscoveryState): string {
  switch (state.phase) {
    case 'loading':
      return 'Asking the endpoint for its model list…'
    case 'ready': {
      const count = state.models.length
      return `${count} model${count === 1 ? '' : 's'} reported by the endpoint. Nothing is saved until you add them to the draft and Save changes.`
    }
    case 'empty':
    case 'error':
    case 'unsupported':
      return state.message
    case 'idle':
    default:
      return ''
  }
}

/** Union of the current model list and discovered ids (current order first). */
export function mergeDiscoveredModels(current: unknown, discovered: unknown): string[] {
  const merged = cleanModelList(current)
  for (const model of discoveredModels(discovered)) {
    if (!merged.includes(model)) merged.push(model)
  }
  return merged
}

/** Discovered ids not already present in the current list (for the action copy). */
export function discoveredAdditions(current: unknown, discovered: unknown): string[] {
  const existing = cleanModelList(current)
  return discoveredModels(discovered).filter((model) => !existing.includes(model))
}
