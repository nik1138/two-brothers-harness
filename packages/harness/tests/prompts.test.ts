/**
 * Prompts parity tests: the packaged shared/prompts.json copy must not drift
 * from the repo-root original, and systemPrompt must serve both roles.
 * Run with: node tests/run-all.ts  (or node --test tests/)
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { loadPrompts, systemPrompt } from "../src/prompts.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const packagePromptsPath = path.resolve(here, "..", "shared", "prompts.json");
const repoRootPromptsPath = path.resolve(here, "..", "..", "..", "shared", "prompts.json");

test("packaged shared/prompts.json matches the repo-root copy", () => {
  if (!fs.existsSync(repoRootPromptsPath)) return; // packed-tarball install: skip silently
  const packaged = fs.readFileSync(packagePromptsPath);
  const repoRoot = fs.readFileSync(repoRootPromptsPath);
  assert.ok(
    packaged.equals(repoRoot),
    `${packagePromptsPath} drifted from ${repoRootPromptsPath}`,
  );
});

test("systemPrompt returns a non-empty prompt for each role and they differ", () => {
  const senior = systemPrompt("senior");
  const junior = systemPrompt("junior");
  assert.ok(senior.length > 0);
  assert.ok(junior.length > 0);
  assert.notEqual(senior, junior);
});

test("loadPrompts serves the same keys", () => {
  const prompts = loadPrompts();
  assert.ok(prompts.senior.length > 0);
  assert.ok(prompts.junior.length > 0);
});

test("systemPrompt with an unknown role throws", () => {
  assert.throws(() => systemPrompt("robot"), /unknown role/);
});

test("base prompts carry one coherent payload contract and no example fence", () => {
  const prompts = loadPrompts();
  for (const [role, text] of Object.entries(prompts)) {
    assert.match(text, /one JSON object/, `${role}: one JSON object`);
    assert.match(text, /fenced JSON block is accepted/, `${role}: fence accepted`);
    assert.match(text, /[Cc]onfidence (?:is|as) a JSON number/, role);
    assert.match(text, /no envelope fields/, role);
    assert.ok(!text.includes("no markdown wrappers"), `${role}: no contradictory ban`);
    assert.ok(!text.includes("```json"), `${role}: no literal fence (faults.ts parses the last)`);
    for (const forbidden of ["Available tools", "Using tools", "mcp__", "workspace_"]) {
      assert.ok(!text.includes(forbidden), `${role}: ${forbidden} stays code-owned`);
    }
  }
  assert.match(prompts.senior, /consult/);
  assert.match(prompts.senior, /review/);
  assert.match(prompts.senior, /decision/);
  assert.match(prompts.junior, /proposal/);
  assert.match(prompts.junior, /deliverable/);
});
