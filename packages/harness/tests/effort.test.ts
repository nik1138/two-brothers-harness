/**
 * Model-declared effort token helpers: no product-wide enum, unsafe values
 * rejected, labels and Anthropic/Google budget fallbacks exact.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  effortLabel,
  effortThinkingBudget,
  isEffortValue,
  normalizeEffortValue,
} from "../src/effort.ts";

test("effort values are model tokens, normalized but not constrained to a fixed enum", () => {
  assert.equal(normalizeEffortValue(" HIGH "), "high");
  assert.equal(normalizeEffortValue("xhigh"), "xhigh");
  assert.equal(normalizeEffortValue("max"), "max");
  assert.equal(normalizeEffortValue("none"), "none");
  assert.equal(normalizeEffortValue(""), null);
  assert.equal(normalizeEffortValue("   "), null);
  assert.equal(normalizeEffortValue(null), null);
  assert.equal(normalizeEffortValue("high effort"), null);
  assert.equal(normalizeEffortValue("hi\ngh"), null);
  assert.equal(normalizeEffortValue("high\n"), "high", "surrounding whitespace is trimmed safely");
  assert.equal(normalizeEffortValue("a".repeat(40)), null);
  assert.equal(isEffortValue("high"), true);
  assert.equal(isEffortValue(""), false);
});

test("labels are human and stable", () => {
  assert.equal(effortLabel("low"), "Low");
  assert.equal(effortLabel("xhigh"), "Extra high");
  assert.equal(effortLabel("max"), "Max");
  assert.equal(effortLabel("none"), "None");
  assert.equal(effortLabel(""), "Default");
});

test("Anthropic/Google budget fallback covers known levels, unknown stays undefined", () => {
  assert.equal(effortThinkingBudget("low"), 1024);
  assert.equal(effortThinkingBudget("medium"), 4096);
  assert.equal(effortThinkingBudget("high"), 16384);
  assert.equal(effortThinkingBudget("max"), 32768);
  assert.equal(effortThinkingBudget("custom-level"), undefined);
});
