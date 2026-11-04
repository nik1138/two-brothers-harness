/**
 * A tiny, dependency-free validator for the practical JSON-Schema subset a
 * plugin tool declares with `add_tool(name, execute, { parameters })`.
 *
 * Deliberate scope (research/harnesses/plugins-pi.md, R3): `type`,
 * `properties`, `required`, `items`, `enum`, `additionalProperties: false`,
 * string `minLength` / `maxLength` / `pattern`, and numeric `minimum` /
 * `maximum`. No ajv, no TypeBox: the subset is smaller than the cost of
 * either dependency, and the parameter schema is already the wire format.
 *
 * Tolerant at the boundary, like the rest of the harness: unknown keywords are
 * ignored, a keyword of the wrong shape is ignored, and an uncompilable
 * `pattern` is skipped instead of rejecting an argument it cannot judge.
 * Errors are short and model-facing — `args.code: expected string, got number`
 * — so the model can repair the call instead of guessing.
 */

export type JsonSchemaType =
  | "object"
  | "array"
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "null";

/** The supported subset; extra keywords are tolerated and ignored. */
export interface JsonSchemaSubset {
  type?: JsonSchemaType;
  properties?: Record<string, JsonSchemaSubset>;
  required?: string[];
  items?: JsonSchemaSubset;
  enum?: unknown[];
  additionalProperties?: boolean;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  /** Unknown JSON-Schema keywords are accepted and not validated. */
  [keyword: string]: unknown;
}

export type ValidationResult =
  | { ok: true; value: unknown }
  | { ok: false; errors: string[] };

/** Root label of every reported path (the tool's argument object). */
const ROOT = "args";

/**
 * Validate `value` against `schema`. An empty or non-object schema accepts
 * anything (nothing was declared to check); the value is returned unchanged,
 * never coerced or cloned.
 */
export function validateArgs(schema: JsonSchemaSubset, value: unknown): ValidationResult {
  if (!isRecord(schema)) return { ok: true, value };
  const errors: string[] = [];
  checkValue(schema, value, ROOT, errors);
  return errors.length === 0 ? { ok: true, value } : { ok: false, errors };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value; // number | string | boolean | object | undefined | ...
}

function matchesType(expected: JsonSchemaType, value: unknown): boolean {
  switch (expected) {
    case "object":
      return isRecord(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return true; // unknown type keyword: tolerate
  }
}

function display(value: unknown): string {
  const encoded = JSON.stringify(value);
  return encoded === undefined ? String(value) : encoded;
}

function checkValue(
  schema: JsonSchemaSubset,
  value: unknown,
  path: string,
  errors: string[],
): void {
  if (!isRecord(schema)) return;
  if (typeof schema.type === "string") {
    if (!matchesType(schema.type as JsonSchemaType, value)) {
      errors.push(`${path}: expected ${schema.type}, got ${typeName(value)}`);
      return; // one error per value; nested checks would only add noise
    }
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => sameValue(candidate, value))) {
    const allowed = schema.enum.map((candidate) => display(candidate)).join(", ");
    errors.push(`${path}: expected one of [${allowed}], got ${display(value)}`);
  }
  if (typeof value === "string") {
    checkString(schema, value, path, errors);
  } else if (typeof value === "number") {
    checkNumber(schema, value, path, errors);
  } else if (Array.isArray(value)) {
    checkItems(schema, value, path, errors);
  } else if (isRecord(value)) {
    checkObject(schema, value, path, errors);
  }
}

function checkString(
  schema: JsonSchemaSubset,
  value: string,
  path: string,
  errors: string[],
): void {
  if (typeof schema.minLength === "number" && value.length < schema.minLength) {
    errors.push(`${path}: shorter than minLength ${schema.minLength}`);
  }
  if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
    errors.push(`${path}: longer than maxLength ${schema.maxLength}`);
  }
  if (typeof schema.pattern !== "string") return;
  let pattern: RegExp | null = null;
  try {
    pattern = new RegExp(schema.pattern);
  } catch {
    pattern = null; // an invalid pattern cannot judge the value: skip, never throw
  }
  if (pattern !== null && !pattern.test(value)) {
    errors.push(`${path}: does not match pattern ${JSON.stringify(schema.pattern)}`);
  }
}

function checkNumber(
  schema: JsonSchemaSubset,
  value: number,
  path: string,
  errors: string[],
): void {
  if (typeof schema.minimum === "number" && value < schema.minimum) {
    errors.push(`${path}: below minimum ${schema.minimum}`);
  }
  if (typeof schema.maximum === "number" && value > schema.maximum) {
    errors.push(`${path}: above maximum ${schema.maximum}`);
  }
}

function checkItems(
  schema: JsonSchemaSubset,
  value: unknown[],
  path: string,
  errors: string[],
): void {
  if (!isRecord(schema.items)) return;
  value.forEach((item, index) => {
    checkValue(schema.items as JsonSchemaSubset, item, `${path}[${index}]`, errors);
  });
}

function checkObject(
  schema: JsonSchemaSubset,
  value: Record<string, unknown>,
  path: string,
  errors: string[],
): void {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  if (Array.isArray(schema.required)) {
    for (const key of schema.required) {
      if (typeof key === "string" && !Object.hasOwn(value, key)) {
        errors.push(`${path}.${key}: required property missing`);
      }
    }
  }
  for (const [key, entry] of Object.entries(value)) {
    const child = properties[key];
    if (isRecord(child)) {
      checkValue(child as JsonSchemaSubset, entry, `${path}.${key}`, errors);
    } else if (schema.additionalProperties === false) {
      errors.push(`${path}.${key}: unexpected property`);
    }
  }
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  // `enum` is a primitive keyword in practice; for container values the JSON
  // form is the comparison (key order is not significant enough to matter).
  return JSON.stringify(a) === JSON.stringify(b);
}