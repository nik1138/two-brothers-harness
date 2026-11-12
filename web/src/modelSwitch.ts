/**
 * Composer model switch (pure): the provider-grouped model choices behind the
 * "Models" chip in the message input.
 *
 * The backend settings already describe the effective route per role
 * (`provider_ref` + `model`, or manual fields). The switch reuses the provider
 * preset catalog from `GET /api/providers`: picking a preset model writes that
 * role's `provider_ref` and `model`, so the endpoint, wire kind and key follow
 * the preset. The current model is always present even when it is not in a
 * preset's list (a manually typed model), and its group sorts first.
 *
 * No DOM or Vue dependency: the derivation is unit-tested directly.
 */

import type { RoleSettingsView } from './types'
import type { SettingsPatch } from './api'
import type { ProviderView } from './providerSettings'

export type ModelRole = 'senior' | 'junior'

/** One selectable model in the composer switch. */
export interface ModelChoice {
  /** Provider/preset name shown as the group heading. */
  provider: string
  /** Preset name written to `provider_ref`; `null` for a manual connection. */
  providerRef: string | null
  model: string
  /** True when this is the role's effective model and route. */
  current: boolean
  /** True when the provider reports a usable key. */
  hasKey: boolean
}

/** One provider group in the model switch. */
export interface ModelGroup {
  provider: string
  providerRef: string | null
  hasKey: boolean
  models: ModelChoice[]
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function folded(value: string): string {
  return value.trim().toLowerCase()
}

/** The effective route view for one role, when settings are loaded. */
function routeOf(
  settings: Partial<Record<ModelRole, RoleSettingsView>> | null | undefined,
  role: ModelRole,
): RoleSettingsView | null {
  const view = settings?.[role]
  return view && typeof view === 'object' ? view : null
}

/**
 * Provider-grouped choices for one role. The current route's group comes
 * first; a preset model missing from its declared list is added so the active
 * model always has its check mark. A manual/dangling route gets a
 * "Current connection" group that is a no-op when selected.
 */
export function modelGroupsForRole(
  settings: Partial<Record<ModelRole, RoleSettingsView>> | null | undefined,
  providers: readonly ProviderView[],
  role: ModelRole,
): ModelGroup[] {
  const view = routeOf(settings, role)
  const currentModel = text(view?.model)
  const currentRef = text(view?.provider_ref)
  const currentKey = view?.api_key_set === true

  const groups: ModelGroup[] = []
  const refs = new Set<string>()
  for (const provider of providers) {
    const name = text(provider.name)
    if (!name) continue
    const ref = folded(name)
    if (refs.has(ref)) continue
    refs.add(ref)
    const isCurrentProvider = currentRef !== '' && folded(currentRef) === ref
    const models: ModelChoice[] = provider.models
      .map((model) => text(model))
      .filter((model) => model !== '')
      .map((model) => ({
        provider: name,
        providerRef: name,
        model,
        current: isCurrentProvider && model === currentModel,
        hasKey: provider.api_key_set === true,
      }))
    // A manually typed model (or a catalog entry that dropped it) still needs
    // a visible, selectable current row under its own provider.
    if (
      isCurrentProvider &&
      currentModel !== '' &&
      !models.some((choice) => choice.model === currentModel)
    ) {
      models.unshift({
        provider: name,
        providerRef: name,
        model: currentModel,
        current: true,
        hasKey: provider.api_key_set === true,
      })
    }
    if (models.length === 0) continue
    groups.push({
      provider: name,
      providerRef: name,
      hasKey: provider.api_key_set === true,
      models,
    })
  }

  const hasCurrentGroup = groups.some((group) => group.models.some((choice) => choice.current))
  if (currentModel !== '' && !hasCurrentGroup) {
    const label = currentRef || 'Current connection'
    groups.unshift({
      provider: label,
      providerRef: currentRef || null,
      hasKey: currentKey,
      models: [
        {
          provider: label,
          providerRef: currentRef || null,
          model: currentModel,
          current: true,
          hasKey: currentKey,
        },
      ],
    })
  } else {
    // Keep the route the operator is actually using at the top.
    const index = groups.findIndex((group) => group.models.some((choice) => choice.current))
    if (index > 0) {
      const [current] = groups.splice(index, 1)
      if (current) groups.unshift(current)
    }
  }

  return groups
}

/** Total selectable rows across groups (search is shown above four, like dsh). */
export function modelChoiceCount(groups: readonly ModelGroup[]): number {
  return groups.reduce((total, group) => total + group.models.length, 0)
}

/**
 * Case-insensitive search over model ids and provider names. Every
 * whitespace-separated term must match the combined text, so "kimi go" finds
 * a Kimi model in the `opencode-go` group. Groups with no matches disappear.
 */
export function filterModelGroups(
  groups: readonly ModelGroup[],
  query: string,
): ModelGroup[] {
  const terms = text(query).toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return [...groups]
  return groups
    .map((group) => ({
      ...group,
      models: group.models.filter((choice) => {
        const haystack = `${choice.model} ${group.provider}`.toLowerCase()
        return terms.every((term) => haystack.includes(term))
      }),
    }))
    .filter((group) => group.models.length > 0)
}

/** Stable DOM key for one choice. */
export function modelChoiceKey(choice: Pick<ModelChoice, 'providerRef' | 'model'>): string {
  return `${choice.providerRef ?? 'manual'}:${choice.model}`
}

/**
 * The settings patch for one choice, or `null` when it cannot switch anything
 * (a manual current connection). A preset choice always writes the preset as
 * the role's `provider_ref`, so the base URL, wire kind and key follow it.
 */
export function modelChoicePatch(
  role: ModelRole,
  choice: Pick<ModelChoice, 'providerRef' | 'model'>,
): SettingsPatch | null {
  const model = text(choice.model)
  const providerRef = text(choice.providerRef)
  if (model === '' || providerRef === '') return null
  return { [role]: { provider_ref: providerRef, model } }
}

/** True when the choice is already the role's effective route. */
export function isCurrentModelChoice(
  view: RoleSettingsView | null | undefined,
  choice: Pick<ModelChoice, 'providerRef' | 'model'>,
): boolean {
  const currentModel = text(view?.model)
  const currentRef = text(view?.provider_ref)
  const choiceRef = text(choice.providerRef)
  return (
    currentModel !== '' &&
    currentModel === text(choice.model) &&
    folded(currentRef) === folded(choiceRef)
  )
}
