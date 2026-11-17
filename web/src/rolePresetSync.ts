/**
 * Role-editor preset synchronization (pure, DOM-free).
 *
 * A RoleEditor patch that selects a provider preset carries only
 * `providerRef`; the role form's `base_url` must follow the preset so a save
 * never persists a stale URL from a previously selected preset or from
 * Manual entry. Resolution is case-insensitive, matching the rest of the
 * provider model (usage badges, add-form duplicate checks).
 */

import type { ProviderPreset } from './types'

/** The form fields this helper touches (structural; RoleForm satisfies it). */
export interface PresetSyncForm {
  providerRef: string
  base_url: string
}

/**
 * Base URL of the preset a provider ref points at, or null when the ref is
 * empty/blank or matches no preset (Manual, or a preset that has since been
 * deleted). Callers treat null as "leave base_url untouched".
 */
export function presetBaseUrlFor(
  providers: readonly ProviderPreset[],
  providerRef: unknown,
): string | null {
  const preset = presetForRef(providers, providerRef)
  if (!preset || typeof preset.base_url !== 'string') return null
  return preset.base_url
}

/**
 * Resolve a provider ref to its preset, case-insensitively; null for blank or
 * unknown refs (Manual, or a preset that has since been deleted).
 */
function presetForRef(
  providers: readonly ProviderPreset[],
  providerRef: unknown,
): ProviderPreset | null {
  const ref = typeof providerRef === 'string' ? providerRef.trim() : ''
  if (!ref) return null
  const lowered = ref.toLowerCase()
  return (
    providers.find(
      (provider) =>
        typeof provider?.name === 'string' && provider.name.trim().toLowerCase() === lowered,
    ) ?? null
  )
}

/**
 * The declared model ids of the preset a provider ref points at, trimmed and
 * de-blanked. `null` for a Manual/unknown ref — callers keep free text there;
 * an empty array means the preset genuinely declares no models yet (fall back
 * to free text with a fetch hint).
 */
export function presetModelsFor(
  providers: readonly ProviderPreset[],
  providerRef: unknown,
): string[] | null {
  const preset = presetForRef(providers, providerRef)
  if (!preset) return null
  return preset.models
    .map((model) => (typeof model === 'string' ? model.trim() : ''))
    .filter((model) => model !== '')
}

/** One option in the role-editor model selector. */
export interface RoleModelOption {
  label: string
  value: string
  /** True when the option preserves a current value the preset does not declare. */
  custom: boolean
}

/**
 * Options for the searchable role-editor model selector: the preset's
 * declared models plus the current value when it is not declared (a custom or
 * previously typed id stays visible and selectable, never silently rewritten).
 */
export function roleModelSelectOptions(
  presetModels: readonly string[],
  currentModel: string,
): RoleModelOption[] {
  const models = presetModels
    .map((model) => (typeof model === 'string' ? model.trim() : ''))
    .filter((model) => model !== '')
  const options: RoleModelOption[] = models.map((model) => ({
    label: model,
    value: model,
    custom: false,
  }))
  const current = typeof currentModel === 'string' ? currentModel.trim() : ''
  if (current !== '' && !models.includes(current)) {
    options.unshift({ label: `${current} (custom)`, value: current, custom: true })
  }
  return options
}

/**
 * Merge a RoleEditor patch into a role form and, when the patch selects a
 * preset, synchronize `base_url` to that preset's URL. A Manual selection
 * ('') or an unknown ref leaves `base_url` untouched so an operator-typed
 * Manual URL is never clobbered.
 */
export function applyRolePatch<T extends PresetSyncForm>(
  form: T,
  patch: Partial<T>,
  providers: readonly ProviderPreset[],
): T {
  Object.assign(form, patch)
  if ('providerRef' in patch) {
    const baseUrl = presetBaseUrlFor(providers, patch.providerRef)
    if (baseUrl !== null) form.base_url = baseUrl
  }
  return form
}
