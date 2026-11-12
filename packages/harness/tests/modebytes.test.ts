/**
 * Byte-stability regression for explicit consult/work runs (auto+solo lane,
 * design §7.3). The goldens in tests/fixtures/modebytes/ were captured on the
 * PRE-change tree; explicit modes never enter the auto routing node, so every
 * provider request, the rendered transcript and the envelope log must stay
 * byte-identical across the feature.
 *
 * If this suite fails, the change moved bytes it must not move — fix the
 * change, never the golden (regeneration is an explicit owner decision).
 *
 * Run with: node tests/run-all.ts (or node --test tests/)
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { REPAIR_REQUEST_PREFIX } from "../src/payloads.ts";
import { runScenario, SCENARIO_NAMES, type ScenarioOutcome } from "./fixtures/modebytes/scenarios.ts";

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "modebytes");

function golden(name: string): ScenarioOutcome {
  return JSON.parse(fs.readFileSync(path.join(fixtureDir, `${name}.json`), "utf8")) as ScenarioOutcome;
}

for (const name of SCENARIO_NAMES) {
  test(`modebytes: ${name} requests/transcript/envelopes are byte-identical to the pre-change golden`, async () => {
    const actual = await runScenario(name);
    assert.deepStrictEqual(actual, golden(name));
  });
}

test("modebytes: explicit consult never asks for a route payload", async () => {
  const outcome = await runScenario("consult-mock");
  assert.deepEqual(
    outcome.calls.map((call) => call.kind),
    ["consult", "proposal", "review", "decision"],
  );
  assert.ok(outcome.calls.every((call) => call.kind !== "route"));
  assert.ok(outcome.envelopes.every((envelope) => !String(envelope.payload.text ?? "").includes("[[AUTO ROUTE]]")));
});

test("modebytes: explicit work never asks for a route payload", async () => {
  const outcome = await runScenario("work-mock");
  assert.deepEqual(
    outcome.calls.map((call) => call.kind),
    ["delegation", "deliverable", "review", "decision"],
  );
  assert.ok(outcome.calls.every((call) => call.kind !== "route"));
  assert.ok(outcome.envelopes.every((envelope) => !String(envelope.payload.text ?? "").includes("[[AUTO ROUTE]]")));
});

test("modebytes: consult transcript keeps the byte-stable markers", async () => {
  const outcome = await runScenario("consult-mock");
  assert.ok(outcome.transcript.startsWith("[[TASK]]\nPlan a migration from Redis to Valkey\n[[/TASK]]\n\nContext events:\n"));
  assert.ok(outcome.transcript.includes("[1] [user -> senior] message:"));
});

test("modebytes: work transcript keeps the byte-stable markers", async () => {
  const outcome = await runScenario("work-mock");
  assert.ok(outcome.transcript.startsWith("[[TASK]]\nPlan a migration from Redis to Valkey\n[[/TASK]]\n\nContext events:\n"));
  assert.ok(outcome.transcript.includes("[2] [senior -> junior] delegation:"));
});

test("modebytes: repair scenarios carry exactly one marked repair envelope", async () => {
  for (const name of ["consult-repair", "work-repair"]) {
    const outcome = await runScenario(name);
    const repairs = outcome.envelopes.filter((envelope) =>
      String(envelope.payload.text ?? "").startsWith(REPAIR_REQUEST_PREFIX),
    );
    assert.equal(repairs.length, 1, `${name}: one repair envelope`);
    assert.deepEqual(outcome.errors, [], `${name}: repair succeeded, no errors`);
    assert.deepEqual(outcome.warnings, [], `${name}: no degradation warning`);
  }
});

test("modebytes: belt scenarios offer the fixture tool on the loop calls only", async () => {
  const consult = await runScenario("consult-mock-belt");
  for (const call of consult.calls) {
    if (call.channel === "tools") assert.ok(call.tools.includes("notes_lookup"));
    else assert.deepEqual(call.tools, []);
  }
  const work = await runScenario("work-mock-belt");
  const toolCalls = work.calls.filter((call) => call.channel === "tools");
  assert.ok(toolCalls.length >= 2, "work belt runs the junior deliverable and senior verify loops");
  for (const call of toolCalls) assert.ok(call.tools.includes("notes_lookup"));
});
