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
  const ref = typeof providerRef === 'string' ? providerRef.trim() : ''
  if (!ref) return null
  const lowered = ref.toLowerCase()
  const preset = providers.find(
    (provider) =>
      typeof provider?.name === 'string' && provider.name.trim().toLowerCase() === lowered,
  )
  if (!preset || typeof preset.base_url !== 'string') return null
  return preset.base_url
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
