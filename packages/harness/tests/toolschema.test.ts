/**
 * The hand-rolled JSON-Schema-subset validator (`src/toolschema.ts`) used for
 * plugin tool arguments and per-plugin options. Zero dependency, tolerant at
 * the boundary (unknown keywords and malformed keywords are ignored), strict
 * about the subset it does understand.
 *
 * Run with: node --test tests/toolschema.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { validateArgs, type JsonSchemaSubset } from "../src/toolschema.ts";

/** Assert failure and return the errors (keeps the cases compact). */
function errorsOf(schema: JsonSchemaSubset, value: unknown): string[] {
  const result = validateArgs(schema, value);
  assert.equal(result.ok, false, `expected a failure, got ok for ${JSON.stringify(value)}`);
  return (result as { ok: false; errors: string[] }).errors;
}

test("object schemas: matching values pass and the value is returned unchanged", () => {
  const schema: JsonSchemaSubset = {
    type: "object",
    properties: {
      code: { type: "string" },
      count: { type: "integer" },
    },
    required: ["code"],
  };
  const value = { code: "abc", count: 3 };
  const result = validateArgs(schema, value);
  assert.deepEqual(result, { ok: true, value });
  // identity, not a clone: validation never rewrites arguments
  assert.equal((result as { value: unknown }).value, value);
});

test("type errors use short, model-facing paths", () => {
  const schema: JsonSchemaSubset = {
    type: "object",
    properties: { code: { type: "string" } },
  };
  assert.deepEqual(errorsOf(schema, { code: 7 }), ["args.code: expected string, got number"]);
  assert.deepEqual(errorsOf(schema, { code: ["a"] }), ["args.code: expected string, got array"]);
  assert.deepEqual(errorsOf(schema, { code: null }), ["args.code: expected string, got null"]);
  assert.deepEqual(errorsOf(schema, { code: true }), ["args.code: expected string, got boolean"]);
});

test("a type mismatch stops nested checks (one error per value)", () => {
  const schema: JsonSchemaSubset = {
    type: "object",
    properties: { nested: { type: "object", required: ["x"] } },
  };
  assert.deepEqual(errorsOf(schema, { nested: "text" }), [
    "args.nested: expected object, got string",
  ]);
});

test("required properties are reported by path", () => {
  const schema: JsonSchemaSubset = {
    type: "object",
    properties: { code: { type: "string" }, note: { type: "string" } },
    required: ["code", "note"],
  };
  assert.deepEqual(errorsOf(schema, {}), [
    "args.code: required property missing",
    "args.note: required property missing",
  ]);
});

test("additionalProperties: false rejects unknown keys; other values tolerate them", () => {
  const closed: JsonSchemaSubset = {
    type: "object",
    properties: { code: { type: "string" } },
    additionalProperties: false,
  };
  assert.deepEqual(errorsOf(closed, { code: "ok", extra: 1 }), [
    "args.extra: unexpected property",
  ]);
  const open: JsonSchemaSubset = { type: "object", properties: { code: { type: "string" } } };
  assert.deepEqual(validateArgs(open, { code: "ok", extra: 1 }).ok, true);
  const explicitTrue: JsonSchemaSubset = { ...closed, additionalProperties: true };
  assert.deepEqual(validateArgs(explicitTrue, { extra: 1 }).ok, true);
});

test("string minLength / maxLength / pattern", () => {
  const schema: JsonSchemaSubset = {
    type: "object",
    properties: {
      short: { type: "string", maxLength: 3 },
      long: { type: "string", minLength: 4 },
      code: { type: "string", pattern: "^[A-Z]{3}$" },
    },
  };
  assert.deepEqual(errorsOf(schema, { short: "abcd" }), [
    "args.short: longer than maxLength 3",
  ]);
  assert.deepEqual(errorsOf(schema, { long: "abc" }), ["args.long: shorter than minLength 4"]);
  assert.deepEqual(errorsOf(schema, { code: "abc" }), [
    'args.code: does not match pattern "^[A-Z]{3}$"',
  ]);
  assert.equal(validateArgs(schema, { code: "ABC" }).ok, true);
});

test("an uncompilable pattern is skipped, never thrown or used to reject", () => {
  const schema: JsonSchemaSubset = {
    type: "object",
    properties: { code: { type: "string", pattern: "^[unclosed" } },
  };
  assert.deepEqual(validateArgs(schema, { code: "anything" }), {
    ok: true,
    value: { code: "anything" },
  });
});

test("numeric minimum / maximum and integer / number types", () => {
  const schema: JsonSchemaSubset = {
    type: "object",
    properties: {
      count: { type: "integer", minimum: 1, maximum: 10 },
      ratio: { type: "number", minimum: 0, maximum: 1 },
    },
  };
  assert.equal(validateArgs(schema, { count: 3, ratio: 0.5 }).ok, true);
  assert.deepEqual(errorsOf(schema, { count: 0 }), ["args.count: below minimum 1"]);
  assert.deepEqual(errorsOf(schema, { count: 11 }), ["args.count: above maximum 10"]);
  assert.deepEqual(errorsOf(schema, { count: 1.5 }), [
    "args.count: expected integer, got number",
  ]);
  assert.deepEqual(errorsOf(schema, { ratio: 2 }), ["args.ratio: above maximum 1"]);
  // `number` accepts an integer value
  assert.equal(validateArgs({ type: "number" }, 3).ok, true);
});

test("enum: primitives compare by value and report the allowed set", () => {
  const schema: JsonSchemaSubset = {
    type: "object",
    properties: { color: { type: "string", enum: ["red", "green"] } },
  };
  assert.equal(validateArgs(schema, { color: "green" }).ok, true);
  assert.deepEqual(errorsOf(schema, { color: "blue" }), [
    'args.color: expected one of ["red", "green"], got "blue"',
  ]);
  // enum alone (no `type`) still works on numbers
  assert.equal(validateArgs({ enum: [1, 2] }, 2).ok, true);
  assert.deepEqual(errorsOf({ enum: [1, 2] }, 3), ["args: expected one of [1, 2], got 3"]);
});

test("array items validate every element with indexed paths", () => {
  const schema: JsonSchemaSubset = {
    type: "object",
    properties: { tags: { type: "array", items: { type: "string" } } },
  };
  assert.equal(validateArgs(schema, { tags: ["a", "b"] }).ok, true);
  assert.deepEqual(errorsOf(schema, { tags: ["a", 2] }), [
    "args.tags[1]: expected string, got number",
  ]);
  // a non-object `items` is tolerated
  assert.equal(
    validateArgs({ type: "array", items: 7 as unknown as JsonSchemaSubset }, [1]).ok,
    true,
  );
});

test("nested object paths join with dots", () => {
  const schema: JsonSchemaSubset = {
    type: "object",
    properties: {
      user: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    },
  };
  assert.deepEqual(errorsOf(schema, { user: { name: false } }), [
    "args.user.name: expected string, got boolean",
  ]);
  assert.deepEqual(errorsOf(schema, { user: {} }), [
    "args.user.name: required property missing",
  ]);
});

test("boolean and null types", () => {
  assert.equal(validateArgs({ type: "boolean" }, false).ok, true);
  assert.deepEqual(errorsOf({ type: "boolean" }, "false"), [
    "args: expected boolean, got string",
  ]);
  assert.equal(validateArgs({ type: "null" }, null).ok, true);
  assert.deepEqual(errorsOf({ type: "null" }, 0), ["args: expected null, got number"]);
});

test("independent fields report independent errors", () => {
  const schema: JsonSchemaSubset = {
    type: "object",
    properties: {
      code: { type: "string" },
      count: { type: "integer" },
      extra: { type: "boolean" },
    },
  };
  assert.deepEqual(errorsOf(schema, { code: 1, count: "x", extra: 3 }), [
    "args.code: expected string, got number",
    "args.count: expected integer, got string",
    "args.extra: expected boolean, got number",
  ]);
});

test("unknown keywords are tolerated and ignored", () => {
  const schema: JsonSchemaSubset = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "unused",
    description: "unused",
    oneOf: [{ type: "string" }],
    type: "object",
    properties: { code: { type: "string", format: "uuid" } },
  };
  assert.equal(validateArgs(schema, { code: "not-a-uuid" }).ok, true);
});

test("an absent or malformed schema accepts anything", () => {
  assert.deepEqual(validateArgs({}, { whatever: [1, 2, 3] }), {
    ok: true,
    value: { whatever: [1, 2, 3] },
  });
  assert.equal(validateArgs(undefined as unknown as JsonSchemaSubset, 5).ok, true);
  assert.equal(validateArgs([] as unknown as JsonSchemaSubset, 5).ok, true);
  assert.equal(validateArgs("nope" as unknown as JsonSchemaSubset, 5).ok, true);
});

test("a malformed keyword is ignored rather than enforced", () => {
  const schema = {
    type: "object",
    required: "code", // wrong shape
    properties: { code: { type: "string" } },
    minLength: 4, // wrong place: strings only, and value is an object
    minimum: "1", // wrong shape
  } as unknown as JsonSchemaSubset;
  assert.equal(validateArgs(schema, { code: "ok" }).ok, true);
  assert.equal(validateArgs(schema, {}).ok, true);
});