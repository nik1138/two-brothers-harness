/**
 * Pure model for the per-plugin options editor (Settings → Plugins): maps a
 * plugin's exported `configSchema` (the JSON-Schema subset from `api.ts`)
 * onto form fields and rebuilds the options object from editor drafts.
 *
 * Supported field shapes: string, number, integer, boolean, enum selects
 * (`enum` or `oneOf` of `const`/`enum`), and nested objects/arrays as opaque
 * JSON text. Everything else (combinators beyond oneOf, $refs, pattern-based
 * validation) is out of scope for the editor; unknown property types fall
 * back to the opaque JSON field so the value stays editable.
 */
import type { PluginConfigSchema } from './api'

export type PluginOptionFieldKind = 'string' | 'number' | 'integer' | 'boolean' | 'select' | 'json'

export interface PluginOptionChoice {
  /** Stable string key (JSON form of the value) used by the editor draft. */
  key: string
  label: string
  value: unknown
}

export interface PluginOptionField {
  key: string
  kind: PluginOptionFieldKind
  label: string
  description?: string
  required: boolean
  defaultValue?: unknown
  choices?: PluginOptionChoice[]
}

function scalarKey(value: unknown): string {
  return JSON.stringify(value) ?? 'null'
}

/** Flatten `enum` / `oneOf` entries into select choices; null when unsupported. */
function choicesFromSchema(schema: PluginConfigSchema): PluginOptionChoice[] | null {
  const raw: unknown[] = []
  if (Array.isArray(schema.enum)) {
    raw.push(...schema.enum)
  } else if (Array.isArray(schema.oneOf)) {
    const flattened: PluginOptionChoice[] = []
    for (const entry of schema.oneOf) {
      if (entry === null || typeof entry !== 'object') return null
      if ('const' in entry) {
        flattened.push({
          key: scalarKey(entry.const),
          label: typeof entry.description === 'string' && entry.description ? entry.description : scalarKey(entry.const),
          value: entry.const,
        })
      } else if (Array.isArray(entry.enum)) {
        for (const value of entry.enum) {
          flattened.push({ key: scalarKey(value), label: typeof value === 'string' ? value : scalarKey(value), value })
        }
      } else return null
    }
    return flattened
  } else {
    return null
  }
  if (raw.length === 0) return null
  return raw.map((value) => ({
    key: scalarKey(value),
    label: typeof value === 'string' ? value : scalarKey(value),
    value,
  }))
}

/**
 * Map a plugin's `configSchema` onto editor fields. Returns [] for a null /
 * non-object / property-less schema (the section then shows the
 * "no configurable options" note). Unknown property types become opaque JSON
 * fields so no declared property is silently dropped.
 */
export function fieldsFromSchema(schema: PluginConfigSchema | null | undefined): PluginOptionField[] {
  if (schema === null || schema === undefined || typeof schema !== 'object') return []
  const properties = schema.properties
  if (properties === null || typeof properties !== 'object') return []
  const required = new Set(
    Array.isArray(schema.required) ? schema.required.filter((r): r is string => typeof r === 'string') : [],
  )
  const fields: PluginOptionField[] = []
  for (const [key, raw] of Object.entries(properties)) {
    if (raw === null || typeof raw !== 'object') continue
    const prop = raw as PluginConfigSchema
    const base: PluginOptionField = {
      key,
      kind: 'json',
      label: key,
      required: required.has(key),
    }
    if (typeof prop.description === 'string' && prop.description) {
      base.description = prop.description
    }
    if ('default' in prop) base.defaultValue = prop.default
    const choices = choicesFromSchema(prop)
    if (choices) {
      base.kind = 'select'
      base.choices = choices
    } else if (prop.type === 'boolean') {
      base.kind = 'boolean'
    } else if (prop.type === 'integer') {
      base.kind = 'integer'
    } else if (prop.type === 'number') {
      base.kind = 'number'
    } else if (prop.type === 'string') {
      base.kind = 'string'
    } else {
      base.kind = 'json'
    }
    fields.push(base)
  }
  return fields
}

/** True when the plugin declares at least one editor-supported property. */
export function hasConfigurableOptions(schema: PluginConfigSchema | null | undefined): boolean {
  return fieldsFromSchema(schema).length > 0
}

/**
 * Editor draft value for one field, pre-populated from the current effective
 * options and falling back to the schema `default`. Text-ish fields use
 * strings ("" = unset), booleans use booleans, selects use the choice key
 * ("" = unset).
 */
export function initialDraftValue(field: PluginOptionField, options: Record<string, unknown>): unknown {
  const current = options[field.key]
  const value = current !== undefined ? current : field.defaultValue
  if (field.kind === 'boolean') return value === true
  if (value === undefined || value === null) return ''
  if (field.kind === 'select') {
    const key = scalarKey(value)
    return field.choices?.some((c) => c.key === key) ? key : ''
  }
  if (field.kind === 'json') {
    return typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? ''
  }
  return String(value)
}

export type PluginOptionDraft = Record<string, string | boolean>

export function initialDraft(
  fields: PluginOptionField[],
  options: Record<string, unknown>,
): PluginOptionDraft {
  const draft: PluginOptionDraft = {}
  for (const field of fields) {
    draft[field.key] = initialDraftValue(field, options) as string | boolean
  }
  return draft
}

export type BuildOptionsResult =
  | { ok: true; options: Record<string, unknown> }
  | { ok: false; error: string }

/**
 * Rebuild the options object from editor drafts. Unset text/select/JSON
 * fields are omitted (the server applies schema defaults); booleans always
 * carry their checkbox state. JSON fields must parse; a parse failure is a
 * bounded, field-scoped error string for inline display.
 */
export function buildOptions(fields: PluginOptionField[], draft: PluginOptionDraft): BuildOptionsResult {
  const options: Record<string, unknown> = {}
  for (const field of fields) {
    const raw = draft[field.key]
    if (field.kind === 'boolean') {
      options[field.key] = raw === true
      continue
    }
    const text = typeof raw === 'string' ? raw.trim() : ''
    if (!text) continue
    if (field.kind === 'select') {
      const choice = field.choices?.find((c) => c.key === text)
      if (!choice) return { ok: false, error: `${field.label}: unknown choice.` }
      options[field.key] = choice.value
    } else if (field.kind === 'number' || field.kind === 'integer') {
      const num = Number(text)
      if (!Number.isFinite(num)) return { ok: false, error: `${field.label}: expected a number.` }
      options[field.key] = field.kind === 'integer' ? Math.trunc(num) : num
    } else if (field.kind === 'json') {
      try {
        options[field.key] = JSON.parse(text)
      } catch {
        return { ok: false, error: `${field.label}: invalid JSON.` }
      }
    } else {
      options[field.key] = text
    }
  }
  return { ok: true, options }
}
