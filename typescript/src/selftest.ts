/**
 * Offline self-test. Mirrors the original prototype's CLI selftest (removed
 * 2026-11-04; see git history).
 * Run with: node src/selftest.ts
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { TwoBrothersHarness } from "./harness.ts";
import { resolveConfig } from "./config.ts";
import { SharedContext } from "./context.ts";
import { MockProvider } from "./provider.ts";
import { restoreContext, SessionStore } from "./session.ts";
import {
  createMessage,
  parseModelOutput,
  validateMessage,
  payloadIsValid,
} from "./protocol.ts";

export async function selftest(): Promise<number> {
  try {
    // -- envelope --
    const msg = createMessage(1, "senior", "junior", "consult", { task: "t", ask: "a" });
    assert.deepEqual(validateMessage(msg), []);

    const bad = createMessage(2, "senior", "junior", "nope", { task: "t", ask: "a" });
    assert.notEqual(validateMessage(bad).length, 0, "invalid kind must be rejected");

    // -- payload validation --
    const incomplete = createMessage(3, "senior", "junior", "proposal", { title: "x" });
    assert.ok(validateMessage(incomplete).some((e) => e.includes("answer")));

    // -- model output parsing --
    const p1 = parseModelOutput('```json\n{"title": "Plan", "answer": "answer"}\n```', "proposal");
    assert.equal(p1.parseFailed, false);
    assert.equal(p1.payload.title, "Plan");

    const p2 = parseModelOutput("not JSON", "proposal");
    assert.equal(p2.parseFailed, true);

    const p3 = parseModelOutput('{"decision": "d"}', "decision");
    assert.equal(p3.parseFailed, false);
    assert.equal(p3.payload.decision, "d");

    assert.equal(payloadIsValid("decision", { decision: "d" }), true);
    assert.equal(payloadIsValid("decision", { decision: "" }), false);

    // -- mock provider contract --
    const provider = new MockProvider();
    const transcript = "[[TASK]]\nWrite hello world\n[[/TASK]]\n\nContext events:";
    for (const kind of ["consult", "delegation", "proposal", "deliverable", "review", "decision"]) {
      const raw = await provider.chat([{ role: "user", content: transcript }], kind);
      const data = JSON.parse(raw) as Record<string, unknown>;
      assert.ok(data && typeof data === "object");
    }
    const revised = await provider.chat(
      [
        {
          role: "user",
          content: transcript + '\n[1] review: {"verdict": "revise"}',
        },
      ],
      "review",
    );
    assert.equal((JSON.parse(revised) as { verdict: string }).verdict, "revise");

    // -- full harness loop (consult) --
    const harness = new TwoBrothersHarness(resolveConfig({ provider: "mock", mode: "consult" }));
    const result = await harness.run("Do something useful");
    assert.ok(result.decision.decision);
    assert.ok(result.messages.length >= 5);
    assert.deepEqual(
      result.messages.map((m) => m.kind),
      ["message", "consult", "proposal", "review", "decision"],
    );

    // -- work mode --
    const harnessWork = new TwoBrothersHarness(resolveConfig({ provider: "mock", mode: "work" }));
    const resultWork = await harnessWork.run("Do part of the work");
    assert.deepEqual(
      resultWork.messages.map((m) => m.kind),
      ["message", "delegation", "deliverable", "review", "decision"],
    );

    // -- session persistence (JSONL round-trip) --
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "two-brothers-"));
    try {
      const store = new SessionStore(path.join(tmpdir, "selftest.jsonl"));
      const saved = new TwoBrothersHarness(resolveConfig({ provider: "mock", mode: "consult" }));
      await saved.run("Session task", new SharedContext(store));
      const resumed = restoreContext(store);
      assert.equal(resumed.events.length, 5);
      assert.deepEqual(resumed.events.map((e) => e.seq), [1, 2, 3, 4, 5]);
      assert.equal(resumed.events[resumed.events.length - 1].kind, "decision");
      // continuing the session keeps numbering dense
      const nxt = resumed.makeAndAppend("user", "senior", "message", { text: "second" });
      assert.equal(nxt.seq, 6);
      assert.equal(store.load().length, 6, "store must hold every envelope exactly once");
    } finally {
      fs.rmSync(tmpdir, { recursive: true, force: true });
    }

    console.log("SELFTEST: PASS");
    return 0;
  } catch (err) {
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    console.log("SELFTEST: FAIL");
    return 1;
  }
}

const isMain =
  typeof process.argv[1] === "string" &&
  process.argv[1].replace(/\\/g, "/").endsWith("src/selftest.ts");

if (isMain) {
  selftest().then((code) => {
    process.exitCode = code;
  });
}
