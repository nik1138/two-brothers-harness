/**
 * models.dev catalog browse/import model (pure, DOM-free).
 *
 * Settings → Providers → "Browse models.dev…" is a read-only view over the
 * backend's cached catalog: the component fetches, this module decides
 * everything testable — tolerant normalization, search, wire-family grouping,
 * base-URL resolution, the (empty) default selection, the context-window
 * prefill, the Add-form name suggestion and the import payload.
 *
 * Owner decision (§15.6): nothing is preselected. The operator picks models
 * (per-model toggles or an explicit Select all), and an import with zero
 * selected models is refused with an honest reason. Importing only ever
 * prefills the existing Add-provider form; saving still goes through
 * `POST /api/providers`.
 */

import {
  PROVIDER_NAME_PATTERN,
  cleanModelList,
  providerKindLabel,
  validateProviderBaseUrl,
} from './providerSettings'

/** Where a catalog answer came from (mirrors the backend `source`). */
export type ModelsDevSource = 'network' | 'cache' | 'stale' | 'curated'

/** The three wire families Two Brothers can speak. */
export type CatalogFamily = 'openai-compatible' | 'anthropic' | 'google'

/** Family order for the selector and counts (the backend's order). */
export const CATALOG_FAMILIES: readonly CatalogFamily[] = [
  'openai-compatible',
  'anthropic',
  'google',
]

/** Listed models per wire family (always all four keys). */
export interface CatalogFamilies {
  'openai-compatible': number
  anthropic: number
  google: number
  unsupported: number
}

/** One provider row of the browse list. */
export interface CatalogProviderView {
  id: string
  name: string
  api: string | null
  env: string[]
  kind: CatalogFamily | null
  kindSource: string | null
  rejected: boolean
  rejectReason: string | null
  needsBaseUrl: boolean
  modelCount: number
  families: CatalogFamilies
}

/** The list response, normalized for the dialog. */
export interface CatalogProvidersView {
  source: ModelsDevSource
  fetchedAt: number | null
  upstreamError: string | null
  disabled: boolean
  truncated: boolean
  providers: CatalogProviderView[]
}

/** One model row of the detail pane. */
export interface CatalogModelView {
  id: string
  name: string
  /** Resolved family; null = unsupported protocol (never selectable). */
  kind: CatalogFamily | null
  mixedFamily: boolean
  baseUrl: string | null
  /** Context window in tokens; 0 = unknown. */
  contextWindow: number
  reasoning: boolean
  efforts: string[]
}

/** One provider's detail. */
export interface CatalogProviderDetailView extends CatalogProviderView {
  truncated: boolean
  models: CatalogModelView[]
}

/** The detail response, normalized for the dialog. */
export interface CatalogDetailView {
  source: ModelsDevSource
  fetchedAt: number | null
  upstreamError: string | null
  disabled: boolean
  provider: CatalogProviderDetailView
}

/** The Add-form prefill produced by one import (nothing is saved by it). */
export interface CatalogImport {
  name: string
  base_url: string
  kind: CatalogFamily
  models: string[]
  context_window: number
  /** The models.dev provider id, carried invisibly by the Add form. */
  catalog_id: string
}

// -- tolerant normalization -----------------------------------------------------

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** A non-negative whole number, else the fallback (never NaN/negative). */
function wholeNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fallback
}

/** A positive epoch-ms timestamp, else null (curated/never). */
function optionalTimestamp(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

function normalizeSource(value: unknown): ModelsDevSource {
  const source = text(value)
  if (source === 'network' || source === 'cache' || source === 'stale') return source
  return 'curated'
}

/** Only the three known families; anything else is unsupported. */
export function normalizeCatalogFamily(value: unknown): CatalogFamily | null {
  const kind = text(value)
  return (CATALOG_FAMILIES as readonly string[]).includes(kind)
    ? (kind as CatalogFamily)
    : null
}

function normalizeFamilies(value: unknown): CatalogFamilies {
  const item = record(value)
  return {
    'openai-compatible': wholeNumber(item?.['openai-compatible']),
    anthropic: wholeNumber(item?.anthropic),
    google: wholeNumber(item?.google),
    unsupported: wholeNumber(item?.unsupported),
  }
}

/** One provider summary, or null when the entry has no usable id. */
export function normalizeCatalogProvider(raw: unknown): CatalogProviderView | null {
  const item = record(raw)
  if (!item) return null
  const id = text(item.id)
  if (!id) return null
  const families = normalizeFamilies(item.families)
  const counted = families['openai-compatible'] + families.anthropic + families.google + families.unsupported
  const env = Array.isArray(item.env)
    ? item.env
        .map((entry) => text(entry))
        .filter((entry) => entry !== '')
        .slice(0, 3)
    : []
  return {
    id,
    name: text(item.name) || id,
    api: text(item.api) || null,
    env,
    kind: normalizeCatalogFamily(item.kind),
    kindSource: text(item.kind_source) || null,
    rejected: item.rejected === true,
    rejectReason: text(item.reject_reason) || null,
    needsBaseUrl: item.needs_base_url === true,
    modelCount: wholeNumber(item.model_count, counted),
    families,
  }
}

/** The normalized provider list; malformed entries are dropped. */
export function normalizeCatalogProviders(raw: unknown): CatalogProvidersView {
  const item = record(raw)
  if (!item) {
    return {
      source: 'curated',
      fetchedAt: null,
      upstreamError: null,
      disabled: false,
      truncated: false,
      providers: [],
    }
  }
  const providers = Array.isArray(item.providers)
    ? item.providers
        .map((entry) => normalizeCatalogProvider(entry))
        .filter((entry): entry is CatalogProviderView => entry !== null)
    : []
  return {
    source: normalizeSource(item.source),
    fetchedAt: optionalTimestamp(item.fetched_at),
    upstreamError: text(item.upstream_error) || null,
    disabled: item.disabled === true,
    truncated: item.truncated === true,
    providers,
  }
}

/** One model entry, or null when it has no usable id. */
export function normalizeCatalogModel(raw: unknown): CatalogModelView | null {
  const item = record(raw)
  if (!item) return null
  const id = text(item.id)
  if (!id) return null
  const efforts = Array.isArray(item.efforts)
    ? item.efforts.map((entry) => text(entry)).filter((entry) => entry !== '')
    : []
  return {
    id,
    name: text(item.name) || id,
    kind: normalizeCatalogFamily(item.kind),
    mixedFamily: item.mixed_family === true,
    baseUrl: text(item.base_url) || null,
    contextWindow: wholeNumber(item.context_window),
    reasoning: item.reasoning === true,
    efforts,
  }
}

/**
 * The normalized detail response, or null when the body is not a provider
 * detail at all (old-backend garbage). A model whose `kind` is null stays in
 * the list as unsupported — never silently dropped.
 */
export function normalizeCatalogProviderDetail(raw: unknown): CatalogDetailView | null {
  const item = record(raw)
  if (!item) return null
  const providerRaw = record(item.provider)
  if (!providerRaw) return null
  const summary = normalizeCatalogProvider(providerRaw)
  if (!summary) return null
  const models = Array.isArray(providerRaw.models)
    ? providerRaw.models
        .map((entry) => normalizeCatalogModel(entry))
        .filter((entry): entry is CatalogModelView => entry !== null)
    : []
  return {
    source: normalizeSource(item.source),
    fetchedAt: optionalTimestamp(item.fetched_at),
    upstreamError: text(item.upstream_error) || null,
    disabled: item.disabled === true,
    provider: {
      ...summary,
      truncated: providerRaw.truncated === true,
      models,
    },
  }
}

// -- search ---------------------------------------------------------------------

function matches(haystack: readonly string[], query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return haystack.some((value) => value.toLowerCase().includes(needle))
}

/** Case-insensitive search over id/name/env/wire family (empty = all). */
export function filterCatalogProviders(
  providers: readonly CatalogProviderView[],
  query: string,
): CatalogProviderView[] {
  return providers.filter((provider) =>
    matches(
      [
        provider.id,
        provider.name,
        provider.kind ?? '',
        provider.kind === null ? 'not importable' : providerKindLabel(provider.kind),
        ...provider.env,
      ],
      query,
    ),
  )
}

/** Case-insensitive search over the model id/name (empty = all). */
export function filterCatalogModels(
  models: readonly CatalogModelView[],
  query: string,
): CatalogModelView[] {
  return models.filter((model) => matches([model.id, model.name], query))
}

// -- families and base URLs ------------------------------------------------------

/** Families with at least one listed model, in the canonical order. */
export function availableFamilies(detail: CatalogDetailView): CatalogFamily[] {
  return CATALOG_FAMILIES.filter(
    (family) => detail.provider.families[family] > 0 || familyModels(detail, family).length > 0,
  )
}

/** The models of one family, in catalog order (never mixed families). */
export function familyModels(
  detail: CatalogDetailView,
  family: CatalogFamily,
): CatalogModelView[] {
  return detail.provider.models.filter((model) => model.kind === family)
}

/** The family the detail opens on: the provider's own kind when it has models. */
export function primaryFamily(detail: CatalogDetailView): CatalogFamily | null {
  const providerKind = detail.provider.kind
  if (providerKind !== null && familyModels(detail, providerKind).length > 0) {
    return providerKind
  }
  return availableFamilies(detail)[0] ?? null
}

/**
 * The base URL one family's import uses: the provider `api` when the family is
 * the provider's own, otherwise the first usable per-model override for that
 * family (e.g. OpenCode Go's `…/go/anthropic/v1`). Null = the operator must
 * type one.
 */
export function familyBaseUrl(
  detail: CatalogDetailView,
  family: CatalogFamily,
): string | null {
  if (detail.provider.kind === family) return detail.provider.api
  const override = detail.provider.models.find(
    (model) => model.kind === family && model.baseUrl !== null,
  )
  return override?.baseUrl ?? null
}

/** True when the selected family has no catalog base URL (input required). */
export function requiresBaseUrl(
  detail: CatalogDetailView,
  family: CatalogFamily | null,
): boolean {
  if (family === null) return true
  return familyBaseUrl(detail, family) === null
}

/** The URL the import would use: the typed value wins over the catalog's. */
export function resolveImportBaseUrl(
  detail: CatalogDetailView,
  family: CatalogFamily | null,
  typed: string,
): string {
  const entered = text(typed)
  if (entered) return entered
  return family === null ? '' : familyBaseUrl(detail, family) ?? ''
}

/** A real base URL or the Add form's own http(s) problem (null = valid). */
export function baseUrlProblem(value: string): string | null {
  return validateProviderBaseUrl(value)
}

// -- selection (§15.6: default NONE + explicit Select all) -------------------------

/**
 * Owner decision §15.6: the browser preselects NO models. The operator chooses
 * with per-model toggles or Select all; an import with zero selected models is
 * refused.
 */
export function defaultSelection(): string[] {
  return []
}

/** Every model id of one family (the explicit "Select all (N)" control). */
export function selectAllFamily(
  detail: CatalogDetailView,
  family: CatalogFamily | null,
): string[] {
  if (family === null) return []
  return familyModels(detail, family).map((model) => model.id)
}

/** Toggle one model id, keeping selection order (pure: returns a new array). */
export function toggleModelSelection(
  selection: readonly string[],
  modelId: string,
): string[] {
  const id = text(modelId)
  if (!id) return [...selection]
  return selection.includes(id)
    ? selection.filter((entry) => entry !== id)
    : [...selection, id]
}

/** True when the model id is selected. */
export function isModelSelected(selection: readonly string[], modelId: string): boolean {
  return selection.includes(text(modelId))
}

/** Selected ids in catalog order, filtered to the currently viewed family. */
export function selectedModelIds(
  detail: CatalogDetailView,
  family: CatalogFamily | null,
  selection: readonly string[],
): string[] {
  if (family === null) return []
  const wanted = new Set(selection)
  return familyModels(detail, family)
    .filter((model) => wanted.has(model.id))
    .map((model) => model.id)
}

/** Smallest positive context window (0 when none reports one). */
export function minimumContextWindow(models: readonly CatalogModelView[]): number {
  let minimum = 0
  for (const model of models) {
    if (model.contextWindow > 0 && (minimum === 0 || model.contextWindow < minimum)) {
      minimum = model.contextWindow
    }
  }
  return minimum
}

/** Context-window prefill: the smallest positive window among the selection. */
export function selectionContextWindow(
  detail: CatalogDetailView,
  selection: readonly string[],
): number {
  const wanted = new Set(selection)
  return minimumContextWindow(
    detail.provider.models.filter((model) => wanted.has(model.id)),
  )
}

// -- name suggestion and import gating -------------------------------------------

/**
 * A catalog id sanitized to the Add form's provider-id grammar: lowercase,
 * dots/underscores and other separators become hyphens, a leading non-letter
 * run is dropped (`302ai` -> `ai`, `wafer.ai` -> `wafer-ai`).
 */
export function sanitizeProviderId(raw: string): string {
  let id = text(raw).toLowerCase()
  id = id.replace(/[^a-z0-9-]+/g, '-')
  id = id.replace(/-+/g, '-').replace(/^-+|-+$/g, '')
  id = id.replace(/^[^a-z]+/, '')
  if (!id) id = 'provider'
  return id.slice(0, 64)
}

/** The family suffix that keeps one import = one wire family. */
export function familyNameSuffix(
  detail: CatalogDetailView,
  family: CatalogFamily | null,
): string {
  if (family === null || family === primaryFamily(detail)) return ''
  if (family === 'openai-compatible') return '-openai'
  return `-${family}`
}

/** First free `<base>`, `<base>-2`, `<base>-3` … name (case-insensitive). */
export function uniqueProviderName(
  base: string,
  existingNames: readonly string[] = [],
): string {
  const taken = new Set(existingNames.map((name) => text(name).toLowerCase()).filter(Boolean))
  const candidate = base || 'provider'
  if (!taken.has(candidate.toLowerCase())) return candidate
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const next = `${candidate}-${suffix}`
    if (!taken.has(next.toLowerCase())) return next
  }
  return `${candidate}-1000`
}

/** The Add form's prefilled name (sanitized, family-suffixed, deduped). */
export function suggestProviderName(
  detail: CatalogDetailView,
  family: CatalogFamily | null,
  existingNames: readonly string[] = [],
): string {
  return uniqueProviderName(suggestedFamilyName(detail, family), existingNames)
}

/**
 * The preset identity one family import would create, before collision
 * dedupe: `<sanitized catalog id><family suffix>`. The suffix keeps a
 * secondary family import distinct from the primary family's preset.
 */
export function suggestedFamilyName(
  detail: CatalogDetailView,
  family: CatalogFamily | null,
): string {
  return `${sanitizeProviderId(detail.provider.id)}${familyNameSuffix(detail, family)}`
}

/** True when a locally loaded provider already uses this id (case-insensitive). */
export function providerExists(
  existingNames: readonly string[],
  id: string,
): boolean {
  const wanted = text(id).toLowerCase()
  if (!wanted) return false
  return existingNames.some((name) => text(name).toLowerCase() === wanted)
}

/** Chips a provider row shows (already-imported / not importable / needs URL). */
export function catalogProviderChips(
  provider: CatalogProviderView,
  existingNames: readonly string[] = [],
): string[] {
  const chips: string[] = []
  if (providerExists(existingNames, provider.id)) chips.push('Already in your providers')
  if (provider.rejected) chips.push('Not importable')
  if (provider.needsBaseUrl) chips.push('Needs base URL')
  return chips
}

/** Human copy for a backend reject reason (never echoes raw markup). */
export function rejectReasonLabel(reason: string | null | undefined): string {
  if (reason === 'proprietary-protocol') return 'proprietary protocol'
  if (reason === 'unknown-type') return 'unknown protocol type'
  return 'unsupported protocol'
}

/** Everything the import decision needs, unwrapped from the component. */
export interface CatalogImportState {
  detail: CatalogDetailView | null
  family: CatalogFamily | null
  selection: readonly string[]
  /** The operator-typed URL ('' when the family has a catalog URL). */
  baseUrl: string
  existingNames?: readonly string[]
}

function importBlocker(
  state: CatalogImportState,
  allowEmptySelection: boolean,
): string | null {
  const detail = state.detail
  if (!detail) return 'Choose a provider first.'
  if (detail.provider.rejected) {
    return `This provider speaks a ${rejectReasonLabel(detail.provider.rejectReason)}, which Two Brothers does not implement. Nothing can be imported.`
  }
  const family = state.family
  if (family === null || familyModels(detail, family).length === 0) {
    return 'This provider has no models for the selected wire family.'
  }
  // The preset this import would create must not already exist. The family
  // suffix is part of the identity: the seed `opencode-go` does not block the
  // separate `opencode-go-anthropic` preset the same catalog entry needs.
  if (providerExists(state.existingNames ?? [], suggestedFamilyName(detail, family))) {
    return 'This provider is already in your providers.'
  }
  if (!allowEmptySelection) {
    const selected = selectedModelIds(detail, family, state.selection)
    if (selected.length === 0) return 'Select at least one model to import.'
  }
  const url = resolveImportBaseUrl(detail, family, state.baseUrl)
  if (!url) return 'Enter the base URL for this provider.'
  const problem = baseUrlProblem(url)
  if (problem) return problem
  return null
}

/**
 * Why the import is refused (null = it would be accepted). Includes the
 * zero-selection refusal of §15.6.
 */
export function importBlockedReason(state: CatalogImportState): string | null {
  return importBlocker(state, false)
}

/**
 * Why the Import button is disabled: the same hard blockers, but an empty
 * selection is not one of them — clicking Import then shows the honest
 * "Select at least one model" notice instead of a dead button.
 */
export function hardImportBlocker(state: CatalogImportState): string | null {
  return importBlocker(state, true)
}

/** The exact Add-form prefill, or the honest reason it cannot be built. */
export function buildCatalogImport(
  state: CatalogImportState,
): { ok: true; value: CatalogImport } | { ok: false; reason: string } {
  const reason = importBlockedReason(state)
  if (reason !== null) return { ok: false, reason }
  const detail = state.detail
  const family = state.family
  if (!detail || family === null) return { ok: false, reason: 'Choose a provider first.' }
  const models = selectedModelIds(detail, family, state.selection)
  const name = suggestProviderName(detail, family, state.existingNames ?? [])
  if (!PROVIDER_NAME_PATTERN.test(name)) {
    return {
      ok: false,
      reason: 'Use lowercase letters, digits and hyphens, starting with a letter.',
    }
  }
  return {
    ok: true,
    value: {
      name,
      base_url: resolveImportBaseUrl(detail, family, state.baseUrl),
      kind: family,
      models: cleanModelList(models),
      context_window: selectionContextWindow(detail, state.selection),
      catalog_id: detail.provider.id,
    },
  }
}

// -- phases, banners and copy ----------------------------------------------------

/** The dialog phases (a 404 summary = old backend; a 503 detail = offline). */
export type CatalogPhase =
  | 'loading'
  | 'ready'
  | 'empty'
  | 'error'
  | 'unsupported'
  | 'unavailable'

export const CATALOG_LOADING_COPY = 'Loading the models.dev catalog…'
export const CATALOG_EMPTY_COPY = 'The catalog returned no usable providers.'
export const CATALOG_UNSUPPORTED_COPY =
  'This backend does not support the models.dev catalog yet. Nothing was changed. Update and restart the backend from this checkout.'
export const CATALOG_UNAVAILABLE_COPY =
  'This provider is only in the live catalog, which is unreachable right now. Add it by hand; your providers are unchanged.'

/** Relative wording for a stale snapshot (`an earlier session` when unknown). */
export function relativeCatalogTime(value: number | null, now = Date.now()): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return 'an earlier session'
  }
  const seconds = Math.max(0, Math.round((now - value) / 1000))
  if (seconds < 60) return 'less than a minute ago'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.round(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

/** Stale-on-error banner copy (null when the snapshot is fresh/absent). */
export function staleBanner(
  view: CatalogProvidersView | null,
  now = Date.now(),
): string | null {
  if (!view || view.source !== 'stale') return null
  return `Showing a saved catalog from ${relativeCatalogTime(view.fetchedAt, now)}; the refresh failed.`
}

/** Curated fallback banner copy (null when the snapshot is live). */
export function curatedBanner(view: CatalogProvidersView | null): string | null {
  if (!view || view.source !== 'curated' || view.disabled) return null
  const reason = view.upstreamError ?? 'no live catalog is available'
  return `The live models.dev catalog is unavailable (${reason}). Showing the curated provider list; model windows and reasoning metadata may be missing.`
}

/** Disabled banner copy (the live fetch is turned off on this backend). */
export function disabledBanner(view: CatalogProvidersView | null): string | null {
  if (!view || !view.disabled) return null
  return 'The live catalog is disabled on this backend. Showing the curated provider list.'
}

/** The one banner the dialog renders (disabled > curated > stale). */
export function catalogBanner(
  view: CatalogProvidersView | null,
  now = Date.now(),
): string | null {
  return disabledBanner(view) ?? curatedBanner(view) ?? staleBanner(view, now)
}

/** Phase for a successful summary response (empty when nothing is usable). */
export function summaryPhase(view: CatalogProvidersView): 'ready' | 'empty' {
  return view.providers.length > 0 ? 'ready' : 'empty'
}

/** Phase for a failed summary fetch: a 404 means an old backend, not an error. */
export function summaryErrorPhase(status: number): 'unsupported' | 'error' {
  return status === 404 ? 'unsupported' : 'error'
}

/**
 * Copy for a failed detail fetch. A 503 is the offline network-only provider
 * notice; a 404 after a successful summary is a vanished catalog entry.
 */
export function detailErrorCopy(status: number, message: string): string {
  if (status === 503) return CATALOG_UNAVAILABLE_COPY
  if (status === 404) return 'This provider is no longer in the catalog. Nothing was changed.'
  return `The provider could not be loaded: ${text(message) || `HTTP ${status}`}`
}

/** Announcement after a successful import (nothing has been saved yet). */
export function importAnnouncement(count: number, catalogId: string): string {
  return `Imported ${count} model${count === 1 ? '' : 's'} from ${catalogId} into the Add provider form. Nothing is saved yet.`
}

/** Visible label for a family (reuses the Add form's provider-kind labels). */
export function familyLabel(family: CatalogFamily | null): string {
  return family === null ? 'Unsupported' : providerKindLabel(family)
}
