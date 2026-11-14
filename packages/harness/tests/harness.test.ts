/** Harness cooperation-loop tests. Mirrors the original prototype's suite
 * (removed 2026-11-04; see git history). */
import { test } from "node:test";
import assert from "node:assert/strict";

import { TwoBrothersHarness, sanitizePayload, fileSessionTailsSize } from "../src/harness.ts";
import { resolveConfig } from "../src/config.ts";
import { MockProvider, type Provider } from "../src/provider.ts";
import type { ChatMessage } from "../src/context.ts";
import { SharedContext } from "../src/context.ts";
import { SessionStore } from "../src/session.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

class ReviseProvider {
  async chat(messages: ChatMessage[], responseKind = "message"): Promise<string> {
    if (responseKind === "review") {
      return '{"verdict": "revise", "notes": "needs rework", "points": ["details"]}';
    }
    return new MockProvider().chat(messages, responseKind);
  }
}

test("consult loop produces a decision", async () => {
  const harness = new TwoBrothersHarness(resolveConfig({ provider: "mock", mode: "consult" }));
  const result = await harness.run("build a catalog");
  assert.ok(result.decision.decision);
  assert.equal(result.decision.confidence, 0.82);
  assert.equal(result.rounds, 0);
});

test("message kinds in consult mode", async () => {
  const harness = new TwoBrothersHarness(resolveConfig({ provider: "mock", mode: "consult" }));
  const result = await harness.run("build a catalog");
  assert.deepEqual(
    result.messages.map((m) => m.kind),
    ["message", "consult", "proposal", "review", "decision"],
  );
});

test("user task is first", async () => {
  const harness = new TwoBrothersHarness(resolveConfig({ provider: "mock", mode: "consult" }));
  const result = await harness.run("first task");
  assert.equal(result.messages[0].from, "user");
  assert.equal(result.messages[0].payload.text, "first task");
});

test("shared context is identical for both roles", async () => {
  const harness = new TwoBrothersHarness(resolveConfig({ provider: "mock", mode: "consult" }));
  const result = await harness.run("shared context");
  const ctx = result.context;
  const seniorView = ctx.renderForRole("senior", "SYSTEM_S");
  const juniorView = ctx.renderForRole("junior", "SYSTEM_J");
  assert.equal(seniorView[1].content, juniorView[1].content);
  assert.notEqual(seniorView[0].content, juniorView[0].content);
});

test("live usage events precede the result and match the final totals", async () => {
  const runtime: Array<Record<string, unknown>> = [];
  const stream: Array<Record<string, unknown>> = [];
  const harness = new TwoBrothersHarness(resolveConfig({ provider: "mock", mode: "consult" }), {
    onEvent: (event) => runtime.push(event as unknown as Record<string, unknown>),
    onStreamEvent: (event) => stream.push(event as unknown as Record<string, unknown>),
  });
  const result = await harness.run("cache me");
  const live = runtime.filter((event) => event.type === "usage");
  assert.ok(live.length > 0, "at least one node reports live usage");
  const last = live.at(-1) as { usage: Record<string, number> };
  assert.deepEqual(last.usage, result.usage);
  assert.ok(
    stream.some((event) => event.type === "usage"),
    "the in-process stream carries the same live usage",
  );
  // The terminal result remains the authority; the live frames are additive.
  assert.equal(stream.at(-1)?.type, "result");
});

test("mock reads task from context", async () => {
  const harness = new TwoBrothersHarness(resolveConfig({ provider: "mock", mode: "consult" }));
  const result = await harness.run("unique-task-marker-123");
  const joined = result.messages
    .map((m) => Object.values(m.payload).join(" "))
    .join(" ");
  assert.ok(joined.includes("unique-task-marker-123"));
});

test("work mode delegates and delivers", async () => {
  const harness = new TwoBrothersHarness(resolveConfig({ provider: "mock", mode: "work" }));
  const result = await harness.run("do part of the work");
  assert.deepEqual(
    result.messages.map((m) => m.kind),
    ["message", "delegation", "deliverable", "review", "decision"],
  );
  assert.ok(result.decision.decision);
});

test("revise loop is bounded", async () => {
  const harness = new TwoBrothersHarness(
    resolveConfig({ provider: "mock", mode: "consult", maxRounds: 2 }),
  );
  harness.providers.senior = new ReviseProvider() as unknown as TwoBrothersHarness["providers"]["senior"];
  const result = await harness.run("rework the decision");
  const kinds = result.messages.map((m) => m.kind);
  assert.equal(kinds.filter((k) => k === "review").length, 3);
  assert.equal(result.rounds, 2);
  assert.equal(kinds[kinds.length - 1], "decision");
  assert.ok(result.decision.decision);
});

test("sanitizePayload keeps protocol shape", () => {
  const out = sanitizePayload("decision", { decision: "d" }, "text");
  assert.equal(out.decision, "d");
  assert.equal(out.confidence, 0.5);
});

test("config env override", () => {
  const prevMode = process.env.TWO_BROTHERS_MODE;
  const prevProvider = process.env.TWO_BROTHERS_PROVIDER;
  process.env.TWO_BROTHERS_MODE = "work";
  process.env.TWO_BROTHERS_PROVIDER = "mock";
  try {
    const cfg = resolveConfig();
    assert.equal(cfg.mode, "work");
    assert.equal(cfg.provider, "mock");
  } finally {
    if (prevMode === undefined) delete process.env.TWO_BROTHERS_MODE;
    else process.env.TWO_BROTHERS_MODE = prevMode;
    if (prevProvider === undefined) delete process.env.TWO_BROTHERS_PROVIDER;
    else process.env.TWO_BROTHERS_PROVIDER = prevProvider;
  }
});

test("config flag overrides env", () => {
  const prevMode = process.env.TWO_BROTHERS_MODE;
  process.env.TWO_BROTHERS_MODE = "consult";
  try {
    const cfg = resolveConfig({ mode: "work" });
    assert.equal(cfg.mode, "work");
  } finally {
    if (prevMode === undefined) delete process.env.TWO_BROTHERS_MODE;
    else process.env.TWO_BROTHERS_MODE = prevMode;
  }
});

test("invalid mode throws", () => {
  assert.throws(() => resolveConfig({ mode: "bad" }), /invalid mode/);
});

test("a reused harness does not leak lastErrors from a previous run", async () => {
  // Run 1 drives the senior's consult reply into the tolerant-degradation
  // path ("unstructured model reply" lands on the harness's lastErrors);
  // run 2 on the SAME harness instance must start with that per-run state
  // reset, so its errors stay empty.
  let run = 0;
  const senior: Provider = {
    async chat(messages: ChatMessage[], responseKind = "message"): Promise<string> {
      if (responseKind === "consult" && run === 1) return "prose instead of JSON";
      return new MockProvider().chat(messages, responseKind);
    },
  };
  const harness = new TwoBrothersHarness(resolveConfig({ provider: "mock", mode: "consult" }), {
    senior,
  });
  run = 1;
  const first = await harness.run("first run");
  assert.ok(first.errors.includes("unstructured model reply for consult"));
  run = 2;
  const second = await harness.run("second run");
  assert.equal(second.cancelled, false);
  assert.deepEqual(
    second.errors.filter((error) => error.includes("unstructured model reply")),
    [],
    "run 2 must not inherit run 1's degradation warnings",
  );
  assert.ok(second.decision.decision);
});

test("the session-file mutex removes its tail entry once the run settles", async () => {
  // `fileSessionTails` is module-level: without cleanup every run on a
  // persisted session file leaves one settled promise behind forever.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-mutex-"));
  try {
    const file = path.join(dir, "session.jsonl");
    const makeCtx = (): SharedContext => new SharedContext(new SessionStore(file));
    const run = (task: string, ctx: SharedContext) =>
      new TwoBrothersHarness(resolveConfig({ provider: "mock", mode: "consult" })).run(task, ctx);
    // The mutex entry is dropped in a promise reaction on the settled tail,
    // one macrotask after the run promise resolves.
    const settle = () => new Promise((resolve) => setImmediate(resolve));

    assert.equal(fileSessionTailsSize(), 0);
    await run("one", makeCtx());
    await settle();
    assert.equal(fileSessionTailsSize(), 0, "a settled run removes its tail entry");

    // Two contexts on the SAME session file serialize through one key; both
    // runs settle and neither entry may survive.
    await Promise.all([run("two", makeCtx()), run("three", makeCtx())]);
    await settle();
    assert.equal(fileSessionTailsSize(), 0, "concurrent same-file runs leave no entry");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
