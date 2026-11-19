/**
 * TUI status-panel per-role usage rows (feat/usage-surfaces, additive).
 *
 * The Ctrl+B panel keeps its merged CONTEXT/TOKENS/CACHE rows untouched and
 * gains SENIOR USE / JUNIOR USE rows directly beneath them when the turn
 * reported a `HarnessResult.usageByRole` split: tokens in/out plus the role's
 * own cache read percentage, the derived cache-miss count when that role read
 * the cache, and cache writes. Absent split (old provider /
 * mock) renders exactly the pre-feature document; a role that answered no call
 * gets no row (never a fabricated zero half); narrow panels clip the value
 * with the shared `…` marker instead of dropping the row.
 *
 * Hermetic and terminal-free (pure view module).
 * Run with: node --test tests/tuisidepanelusage.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { stripAnsi } from "../src/tui/screen.ts";
import {
  sidePanelEntries,
  sidePanelRows,
  type SidePanelState,
} from "../src/tui/view/sidepanel.ts";

const SENIOR = {
  model_calls: 1,
  input_tokens: 1200,
  output_tokens: 340,
  cached_tokens: 500,
  cache_write_tokens: 60,
};
const JUNIOR = {
  model_calls: 2,
  input_tokens: 800,
  output_tokens: 120,
  cached_tokens: 0,
  cache_write_tokens: 0,
};

function state(extra: Partial<SidePanelState> = {}): SidePanelState {
  return {
    mode: "consult",
    inputTokens: 2000,
    outputTokens: 460,
    cachedTokens: 500,
    cacheWriteTokens: 60,
    ...extra,
  };
}

test("per-role usage rows render beneath the merged CACHE row", () => {
  const entries = sidePanelEntries(
    state({ usageByRole: { senior: SENIOR, junior: JUNIOR } }),
  );
  const labels = entries.map((entry) => entry.label);
  const cache = labels.indexOf("CACHE");
  const senior = labels.indexOf("SENIOR USE");
  const junior = labels.indexOf("JUNIOR USE");
  const cost = labels.indexOf("COST");
  assert.ok(cache >= 0 && senior === cache + 1 && junior === senior + 1 && cost === junior + 1);
  assert.equal(
    entries[senior].value,
    // `miss` is derived: prompt (1,200) minus the 500 cache reads.
    "in 1.2k · out 340 · cache 42% · miss 700 · write 60",
  );
  // junior: no cache reads/writes → the miss/write segments are omitted, and
  // 0 cached is a real measured 0% (not "unknown")
  assert.equal(entries[junior].value, "in 800 · out 120 · cache 0%");
});

test("a fully cached role reports a zero miss", () => {
  const entries = sidePanelEntries(
    state({
      usageByRole: { senior: { ...SENIOR, cached_tokens: 1200 }, junior: JUNIOR },
    }),
  );
  const senior = entries.find((entry) => entry.label === "SENIOR USE");
  assert.equal(
    senior?.value,
    "in 1.2k · out 340 · cache 100% · miss 0 · write 60",
  );
});

test("an absent split leaves the historical merged-only panel", () => {
  const labels = sidePanelEntries(state()).map((entry) => entry.label);
  assert.ok(!labels.includes("SENIOR USE"));
  assert.ok(!labels.includes("JUNIOR USE"));
  // the merged rows are still there, unchanged
  assert.ok(labels.includes("TOKENS"));
  assert.ok(labels.includes("CACHE"));
});

test("a role with no provider call gets no row (never a fabricated half)", () => {
  const labels = sidePanelEntries(
    state({
      usageByRole: {
        senior: { model_calls: 0, input_tokens: 0, output_tokens: 0, cached_tokens: 0 },
        junior: JUNIOR,
      },
    }),
  ).map((entry) => entry.label);
  assert.ok(!labels.includes("SENIOR USE"));
  assert.ok(labels.includes("JUNIOR USE"));
});

test("a narrow panel clips the role value instead of dropping the row", () => {
  const rows = sidePanelRows(
    state({ usageByRole: { senior: SENIOR, junior: JUNIOR } }),
    20,
  ).map(stripAnsi);
  const senior = rows.find((row) => row.startsWith("SENIOR USE"));
  assert.ok(senior, "the SENIOR USE row must still be present");
  assert.ok(senior.length <= 20, `row over the width: ${JSON.stringify(senior)}`);
  assert.ok(senior.endsWith("…"), `clipped value keeps the marker: ${JSON.stringify(senior)}`);
});

test("a wide panel keeps the whole role value", () => {
  const rows = sidePanelRows(
    state({ usageByRole: { senior: SENIOR, junior: JUNIOR } }),
    44,
  ).map(stripAnsi);
  const junior = rows.find((row) => row.startsWith("JUNIOR USE"));
  assert.ok(junior);
  assert.ok(junior.includes("in 800 · out 120 · cache 0%"));
  assert.ok(!junior.endsWith("…"));
});

// ---------------------------------------------------------------------------
// additive per-role cost (`feat/role-cost-surfaces`)
// ---------------------------------------------------------------------------

test("a priced role appends its own cost segment to the usage row", () => {
  const entries = sidePanelEntries(
    state({
      usageByRole: { senior: SENIOR, junior: JUNIOR },
      usageCostByRole: { senior: 0.000225, junior: null },
    }),
  );
  const senior = entries.find((entry) => entry.label === "SENIOR USE");
  assert.equal(
    senior?.value,
    "in 1.2k · out 340 · cache 42% · miss 700 · write 60 · cost $0.0002",
  );
  // An unpriced half renders NO cost segment (never `$0` / `cost unknown`).
  const junior = entries.find((entry) => entry.label === "JUNIOR USE");
  assert.equal(junior?.value, "in 800 · out 120 · cache 0%");
});

test("absent or all-unknown per-role cost keeps the pre-cost rows exactly", () => {
  const base = sidePanelEntries(state({ usageByRole: { senior: SENIOR, junior: JUNIOR } }));
  const allNull = sidePanelEntries(
    state({
      usageByRole: { senior: SENIOR, junior: JUNIOR },
      usageCostByRole: { senior: null, junior: null },
    }),
  );
  assert.deepEqual(
    allNull.map((entry) => entry.value),
    base.map((entry) => entry.value),
  );
  assert.ok(!base.some((entry) => entry.value.includes("cost ")));
});

test("a narrow panel still clips a priced role row with the shared marker", () => {
  const rows = sidePanelRows(
    state({
      usageByRole: { senior: SENIOR, junior: JUNIOR },
      usageCostByRole: { senior: 0.000225, junior: null },
    }),
    20,
  ).map(stripAnsi);
  const senior = rows.find((row) => row.startsWith("SENIOR USE"));
  assert.ok(senior, "the SENIOR USE row must still be present");
  assert.ok(senior.length <= 20, `row over the width: ${JSON.stringify(senior)}`);
  assert.ok(senior.endsWith("…"), `clipped value keeps the marker: ${JSON.stringify(senior)}`);
});
