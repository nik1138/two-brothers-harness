/**
 * Provider preset master–detail model (pure, DOM-free).
 *
 * The Settings → Providers surface is an identity-only list with the selected
 * provider's settings expanded inline (the dialog body is too narrow for
 * side-by-side panes). Everything decision-like lives here so it is testable:
 * normalization of the additive `seed`/`customized` flags (old-backend
 * fallback), selection/open state, dirty tracking, role "used by" badges,
 * delete eligibility and impact copy, add-form validation and list keyboard
 * arithmetic.
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
  provider: Pick<ProviderView, 'base_url' | 'models' | 'kind'> | null | undefined,
): ProviderDraft {
  return {
    baseUrl: provider?.base_url ?? '',
    apiKey: '',
    models: [...(provider?.models ?? [])],
    kind: text(provider?.kind) || PROVIDER_KIND_DEFAULT,
  }
}

/** True when the draft would change something. */
export function isProviderDraftDirty(
  provider: Pick<ProviderView, 'base_url' | 'models' | 'kind'>,
  draft: ProviderDraft | null | undefined,
): boolean {
  if (!draft) return false
  if (text(draft.baseUrl) !== text(provider.base_url)) return true
  if (text(draft.apiKey).length > 0) return true
  if (!sameModelList(draft.models, provider.models)) return true
  if ((text(draft.kind) || PROVIDER_KIND_DEFAULT) !== (text(provider.kind) || PROVIDER_KIND_DEFAULT)) {
    return true
  }
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
 * providers. A pure seed DELETE is a 404, and resetting an edited seed has no
 * safe server path yet (DELETE would also clear the role refs), so no reset
 * control is rendered this round.
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
    }
  })
}
