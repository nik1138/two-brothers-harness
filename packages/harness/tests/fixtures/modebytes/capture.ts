/**
 * Capture the modebytes goldens (design §7.3). Run ONCE on the pre-change
 * tree by the implementation lane, then re-asserted by tests/modebytes.test.ts
 * after the change:
 *
 *   node tests/fixtures/modebytes/capture.ts
 *
 * Writes one JSON file per scenario next to this script. Regenerating goldens
 * after an intentional wire change is an explicit owner decision — never do it
 * to silence a failing regression.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { runScenario, SCENARIO_NAMES } from "./scenarios.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

for (const name of SCENARIO_NAMES) {
  const outcome = await runScenario(name);
  const file = path.join(here, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(outcome, null, 2) + "\n", "utf8");
  console.log(`captured ${name}: ${outcome.calls.length} calls, ${outcome.envelopes.length} envelopes`);
}
console.log("modebytes goldens written");
