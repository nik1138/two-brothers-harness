/**
 * Hermetic tests for the per-plugin options editor model
 * (`web/src/pluginOptions.ts`): schema → form-field mapping (defaults, enum
 * selects, opaque JSON for nested shapes) and draft → options rebuild
 * (coercion, omission of unset fields, bounded errors).
 *
 * Run with: node --import ./tests/register-ts.mjs --test tests/pluginOptions.test.ts
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { PluginConfigSchema } from '../src/api'
import {
  buildOptions,
  fieldsFromSchema,
  hasConfigurableOptions,
  initialDraft,
  initialDraftValue,
} from '../src/pluginOptions'

test('null or schema-less config maps to no fields', () => {
  assert.deepEqual(fieldsFromSchema(null), [])
  assert.deepEqual(fieldsFromSchema(undefined), [])
  assert.deepEqual(fieldsFromSchema({}), [])
  assert.equal(hasConfigurableOptions(null), false)
})

test('scalar property types map to their field kinds', () => {
  const schema: PluginConfigSchema = {
    type: 'object',
    properties: {
      label: { type: 'string', description: 'Display label' },
      ratio: { type: 'number' },
      maxChars: { type: 'integer' },
      dryRun: { type: 'boolean' },
    },
    required: ['label'],
  }
  const fields = fieldsFromSchema(schema)
  assert.deepEqual(
    fields.map((f) => [f.key, f.kind]),
    [
      ['label', 'string'],
      ['ratio', 'number'],
      ['maxChars', 'integer'],
      ['dryRun', 'boolean'],
    ],
  )
  assert.equal(fields[0].required, true)
  assert.equal(fields[0].description, 'Display label')
  assert.equal(fields[1].required, false)
})

test('enum maps to a select with string keys for non-string values', () => {
  const fields = fieldsFromSchema({
    properties: { level: { type: 'string', enum: ['low', 'high'] } },
  })
  assert.equal(fields.length, 1)
  assert.equal(fields[0].kind, 'select')
  assert.deepEqual(fields[0].choices, [
    { key: '"low"', label: 'low', value: 'low' },
    { key: '"high"', label: 'high', value: 'high' },
  ])
})

test('oneOf of const values maps to a select, carrying descriptions as labels', () => {
  const fields = fieldsFromSchema({
    properties: {
      mode: {
        oneOf: [
          { const: 1, description: 'one' },
          { const: 2 },
        ],
      },
    },
  })
  assert.equal(fields[0].kind, 'select')
  assert.deepEqual(fields[0].choices, [
    { key: '1', label: 'one', value: 1 },
    { key: '2', label: '2', value: 2 },
  ])
})

test('object and array properties become opaque JSON fields', () => {
  const fields = fieldsFromSchema({
    properties: {
      mapping: { type: 'object', properties: { a: { type: 'string' } } },
      list: { type: 'array', items: { type: 'string' } },
      mystery: { type: 'frobnicator' },
    },
  })
  assert.deepEqual(
    fields.map((f) => f.kind),
    ['json', 'json', 'json'],
  )
})

test('initial draft honors effective options, then schema defaults', () => {
  const fields = fieldsFromSchema({
    properties: {
      label: { type: 'string', default: 'hello' },
      maxChars: { type: 'integer', default: 500 },
      dryRun: { type: 'boolean', default: true },
    },
  })
  const draft = initialDraft(fields, { maxChars: 42 })
  assert.equal(draft.label, 'hello')
  assert.equal(draft.maxChars, '42')
  // Effective option wins over the schema default.
  assert.equal(draft.dryRun, true)
  const overridden = initialDraft(fields, { label: 'custom', dryRun: false })
  assert.equal(overridden.label, 'custom')
  assert.equal(overridden.dryRun, false)
})

test('initial draft pre-fills JSON fields with the serialized value', () => {
  const fields = fieldsFromSchema({ properties: { mapping: { type: 'object' } } })
  const value = initialDraftValue(fields[0], { mapping: { a: 1 } })
  assert.equal(value, JSON.stringify({ a: 1 }, null, 2))
})

test('initial draft rejects an effective select value outside the enum', () => {
  const fields = fieldsFromSchema({ properties: { level: { enum: ['low'] } } })
  assert.equal(initialDraftValue(fields[0], { level: 'stale' }), '')
  assert.equal(initialDraftValue(fields[0], { level: 'low' }), '"low"')
})

test('buildOptions coerces numbers, truncates integers and resolves select keys', () => {
  const fields = fieldsFromSchema({
    properties: {
      label: { type: 'string' },
      ratio: { type: 'number' },
      maxChars: { type: 'integer' },
      level: { enum: ['low', 'high'] },
      dryRun: { type: 'boolean' },
    },
  })
  const result = buildOptions(fields, {
    label: '  hi ',
    ratio: '1.5',
    maxChars: '42.9',
    level: '"high"',
    dryRun: true,
  })
  assert.deepEqual(result, {
    ok: true,
    options: { label: 'hi', ratio: 1.5, maxChars: 42, level: 'high', dryRun: true },
  })
})

test('buildOptions omits unset fields but keeps explicit booleans', () => {
  const fields = fieldsFromSchema({
    properties: { label: { type: 'string' }, dryRun: { type: 'boolean' } },
  })
  const result = buildOptions(fields, { label: '', dryRun: false })
  assert.deepEqual(result, { ok: true, options: { dryRun: false } })
})

test('buildOptions parses JSON fields and reports parse errors boundedly', () => {
  const fields = fieldsFromSchema({ properties: { mapping: { type: 'object' } } })
  assert.deepEqual(buildOptions(fields, { mapping: '{"a":1}' }), {
    ok: true,
    options: { mapping: { a: 1 } },
  })
  const bad = buildOptions(fields, { mapping: '{nope' })
  assert.equal(bad.ok, false)
  if (!bad.ok) assert.match(bad.error, /mapping: invalid JSON/)
})

test('buildOptions reports non-numeric input for number fields', () => {
  const fields = fieldsFromSchema({ properties: { ratio: { type: 'number' } } })
  const bad = buildOptions(fields, { ratio: 'abc' })
  assert.equal(bad.ok, false)
})

test('non-object properties are skipped rather than crashing the mapping', () => {
  const fields = fieldsFromSchema({ properties: { ok: { type: 'string' }, junk: null } })
  assert.deepEqual(
    fields.map((f) => f.key),
    ['ok'],
  )
})
