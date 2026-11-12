/**
 * Model-declared reasoning effort levels (pure). The backend serves models.dev
 * metadata per provider/model; the UI offers exactly the tokens the model
 * reports and hides the control when the model declares none.
 */

import type { ModelEffortInfo } from './types'

/** Stable cache key for one provider/model pair. */
export function modelEffortKey(provider: string, model: string): string {
  return `${provider.trim().toLowerCase()}\u0000${model.trim()}`
}

/** Human label for a model-declared effort token. */
export function effortLabel(value: string): string {
  const token = value.trim().toLowerCase()
  if (token === 'xhigh') return 'Extra high'
  if (token === 'max') return 'Max'
  if (token === 'minimal') return 'Minimal'
  if (token === 'none') return 'None'
  if (token === '') return 'Default'
  return token.charAt(0).toUpperCase() + token.slice(1)
}

/** Default + the model's declared levels, de-duplicated in catalog order. */
export function effortChoices(
  info: ModelEffortInfo | null | undefined,
): Array<{ value: string; label: string }> {
  const choices = [{ value: '', label: 'Default' }]
  for (const value of info?.efforts ?? []) {
    const token = value.trim().toLowerCase()
    if (token === '' || choices.some((choice) => choice.value === token)) continue
    choices.push({ value: token, label: effortLabel(token) })
  }
  return choices
}

/** True when the model reports the stored value (empty always means Default). */
export function effortSupported(
  info: ModelEffortInfo | null | undefined,
  value: string,
): boolean {
  const token = value.trim().toLowerCase()
  if (token === '') return true
  return (info?.efforts ?? []).some((effort) => effort.trim().toLowerCase() === token)
}

/** Add one lookup to a cache, returning a new object (stable reactivity). */
export function withModelEfforts(
  cache: Readonly<Record<string, ModelEffortInfo>>,
  info: ModelEffortInfo,
): Record<string, ModelEffortInfo> {
  return { ...cache, [modelEffortKey(info.provider, info.model)]: info }
}
