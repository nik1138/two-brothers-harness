/**
 * Token-based compaction accounting (Wave 3 sub-wave 3b): the zero-dep
 * `estimateTokens` heuristic, the deterministic mode-resolution rule
 * (token mode iff `contextWindow` or `thresholdTokens` is set), token trigger
 * and budget derivation, token-mode cut/summary caps, overflow recovery sized
 * in tokens, and char-mode back-compat.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { main, type CliIO } from "../src/cli.ts";
import { resolveConfig } from "../src/config.ts";
import { SharedContext, type ChatMessage } from "../src/context.ts";
import {
  DEFAULT_RESERVE_CHARS,
  DEFAULT_RESERVE_TOKENS,
  compactContext,
  compactionBudgets,
  compactionSummaryText,
  compactionTriggerChars,
  compactionTriggerTokens,
  compactionUnit,
  estimateTokens,
  isCompactionSummary,
  selectCutPoint,
  selectCutPointTokens,
  serializeEnvelope,
} from "../src/compaction.ts";
import { TwoBrothersHarness, type HarnessOptions } from "../src/harness.ts";
import {
  MockProvider,
  ProviderContextOverflowError,
  type Provider,
} from "../src/provider.ts";
import { createMessage, validateMessage, type Message } from "../src/protocol.ts";
import { SessionStore } from "../src/session.ts";

const SUMMARY_TEXT = "## Goal\nShip the report.\n\n## Next Steps\n1. Merge";

class RecordingProvider implements Provider {
  readonly requests: ChatMessage[][] = [];
  /** Throw on summarization calls (fail-soft tests). */
  failCompaction = false;
  private readonly inner = new MockProvider();

  async chat(messages: ChatMessage[], responseKind = "message"): Promise<string> {
    this.requests.push(messages);
    if (this.failCompaction && responseKind === "compaction") {
      throw new Error("summarizer endpoint down");
    }
    if (responseKind === "compaction") return SUMMARY_TEXT;
    return this.inner.chat(messages, responseKind);
  }

  compactionRequests(): ChatMessage[][] {
    return this.requests.filter((messages) =>
      messages.some((m) => m.content.includes("<conversation>")),
    );
  }
}

/** Serves a scripted (possibly oversized) summary on compaction calls. */
class LongSummaryProvider implements Provider {
  private readonly summary: string;

  constructor(summary: string) {
    this.summary = summary;
  }

  async chat(messages: ChatMessage[], responseKind = "message"): Promise<string> {
    if (responseKind === "compaction") return this.summary;
    return new MockProvider().chat(messages, responseKind);
  }
}

/** Overflows on the first non-compaction call (or on every one). */
class OverflowProvider implements Provider {
  readonly calls: ChatMessage[][] = [];
  compactionCalls = 0;
  overflowThrown = 0;
  private readonly alwaysOverflow: boolean;
  private readonly inner = new MockProvider();

  constructor(alwaysOverflow: boolean) {
    this.alwaysOverflow = alwaysOverflow;
  }

  async chat(messages: ChatMessage[], responseKind = "message"): Promise<string> {
    this.calls.push(messages);
    if (responseKind === "compaction") {
      this.compactionCalls += 1;
      return SUMMARY_TEXT;
    }
    if (this.alwaysOverflow || this.overflowThrown === 0) {
      this.overflowThrown += 1;
      throw new ProviderContextOverflowError(413, "request exceeds the model context window");
    }
    return this.inner.chat(messages, responseKind);
  }
}

function taskMessage(text = "Ship the report"): Message {
  return createMessage(null, "user", "senior", "message", { text });
}

function consult(askPad: number): Message {
  return createMessage(null, "senior", "junior", "consult", {
    task: "synthetic task",
    ask: `What about this? ${"y".repeat(askPad)}`,
    expect: "proposal",
  });
}

function proposal(answerPad: number, title = "Plan"): Message {
  return createMessage(null, "junior", "senior", "proposal", {
    title,
    answer: `Do it step by step. ${"z".repeat(answerPad)}`,
  });
}

function hugeDelegation(pad: number): Message {
  return createMessage(null, "senior", "junior", "delegation", {
    work: `HEAD-MARKER ${"x".repeat(pad)}`,
    acceptance: "the report lands",
    return: "deliverable",
    notes: "TAIL-MARKER keep me",
  });
}

function buildContext(events: Message[]): SharedContext {
  const ctx = new SharedContext();
  for (const event of events) ctx.append(event);
  return ctx;
}

function consultHarness(senior: Provider, options: HarnessOptions = {}): TwoBrothersHarness {
  return new TwoBrothersHarness(resolveConfig({ provider: "mock", mode: "consult" }), {
    senior,
    ...options,
  });
}

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "two-brothers-compaction-tokens-"));
}

function makeIO(): CliIO & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, log: (line) => out.push(line), error: (line) => err.push(line) };
}

function writeLongSession(file: string, task: string): void {
  const store = new SessionStore(file);
  const ctx = new SharedContext(store);
  ctx.makeAndAppend("user", "senior", "message", { text: task });
  ctx.makeAndAppend("senior", "junior", "consult", {
    task,
    ask: `q ${"y".repeat(300)}`,
    expect: "proposal",
  });
  ctx.makeAndAppend("junior", "senior", "proposal", { title: "p1", answer: `a ${"z".repeat(300)}` });
  ctx.makeAndAppend("senior", "junior", "review", { verdict: "accept", notes: "ok" });
}

// ---------------------------------------------------------------------------
// estimator sanity
// ---------------------------------------------------------------------------

test("estimateTokens: zero-dep heuristic rows (empty, ASCII, CJK, code)", () => {
  assert.equal(estimateTokens(""), 0);
  // ASCII: 4 chars/token, rounded up
  assert.equal(estimateTokens("hello world"), 3); // 11 / 4 = 2.75
  assert.equal(estimateTokens("x".repeat(4000)), 1000);
  // CJK: one token per character (never the ASCII 4:1 ratio)
  assert.equal(estimateTokens("你好世界"), 4);
  // Mixed ASCII + CJK: 6/4 + 2 = 3.5 -> 4
  assert.equal(estimateTokens("hello 世界"), 4);
  // Code is plain ASCII: the estimator is deliberately crude here
  assert.equal(estimateTokens("function f() { return 42; }"), 7); // 27 / 4
  // Rounding is always up, so any non-empty string costs at least 1
  assert.equal(estimateTokens("x"), 1);
  assert.ok(estimateTokens("x".repeat(4001)) > estimateTokens("x".repeat(4000)));
});

// ---------------------------------------------------------------------------
// mode resolution + trigger
// ---------------------------------------------------------------------------

test("mode resolution: tokens iff contextWindow/thresholdTokens, chars otherwise", () => {
  assert.equal(compactionUnit({}), "chars");
  assert.equal(compactionUnit({ thresholdChars: 4000 }), "chars");
  assert.equal(compactionUnit({ keepRecentChars: 100 }), "chars");
  assert.equal(compactionUnit({ contextWindow: 128000 }), "tokens");
  assert.equal(compactionUnit({ thresholdTokens: 100000 }), "tokens");
  // thresholdTokens wins over a known window as the trigger threshold, but
  // either field alone is enough to select token mode
  assert.equal(compactionUnit({ contextWindow: 128000, thresholdTokens: 60000 }), "tokens");

  // No char trigger in token mode, no token trigger in char mode
  assert.equal(compactionTriggerChars({ contextWindow: 128000 }), 0);
  assert.equal(compactionTriggerTokens({ thresholdChars: 4000 }), 0);
  assert.equal(compactionTriggerTokens({}), 0);
});

test("token trigger: window minus reserve, thresholds explicit, reserve clamped to half", () => {
  assert.equal(DEFAULT_RESERVE_TOKENS, 2000);
  assert.equal(compactionTriggerTokens({ contextWindow: 128000 }), 126000);
  assert.equal(compactionTriggerTokens({ contextWindow: 128000, reserveTokens: 8000 }), 120000);
  assert.equal(compactionTriggerTokens({ contextWindow: 10000, reserveTokens: 0 }), 10000);
  // default reserve is clamped to half a small threshold, so it still fires
  assert.equal(compactionTriggerTokens({ contextWindow: 1000 }), 500);
  assert.equal(compactionTriggerTokens({ thresholdTokens: 1000, reserveTokens: 9000 }), 500);
  assert.equal(compactionTriggerTokens({ thresholdTokens: 1000 }), 500);
  assert.equal(compactionTriggerTokens({ thresholdTokens: 1000, reserveTokens: 100 }), 900);
  // an explicit threshold beats the window-derived one
  assert.equal(
    compactionTriggerTokens({ contextWindow: 128000, thresholdTokens: 64000, reserveTokens: 4000 }),
    60000,
  );
});

test("auto budgets derive in tokens (tail <= trigger/2, summary <= trigger/4)", () => {
  assert.deepEqual(compactionBudgets({ thresholdTokens: 1000, reserveTokens: 200 }), {
    unit: "tokens",
    keepRecent: 400,
    summaryCap: 200,
  });
  assert.deepEqual(compactionBudgets({ contextWindow: 10000 }), {
    unit: "tokens",
    keepRecent: 4000,
    summaryCap: 2000,
  });
  // an explicit tail is capped to half the trigger; the summary floor is 200
  assert.deepEqual(
    compactionBudgets({ thresholdTokens: 1000, reserveTokens: 0, keepRecentTokens: 100000 }),
    {
      unit: "tokens",
      keepRecent: 500,
      summaryCap: 250,
    },
  );
});

test("char budgets are unchanged when no window/threshold tokens are configured", () => {
  assert.deepEqual(compactionBudgets({ thresholdChars: 4000, reserveChars: 1000 }), {
    unit: "chars",
    keepRecent: 1500,
    summaryCap: 750,
  });
  assert.deepEqual(compactionBudgets({ keepRecentChars: 40000 }), {
    unit: "chars",
    keepRecent: 40000,
    summaryCap: 20000,
  });
  assert.equal(DEFAULT_RESERVE_CHARS, 8000);
  assert.equal(compactionTriggerChars({ thresholdChars: 10000 }), 5000);
});

// ---------------------------------------------------------------------------
// token trigger fires through the harness
// ---------------------------------------------------------------------------

function triggerContext(): SharedContext {
  return buildContext([
    taskMessage("token trigger task"),
    consult(800),
    proposal(400, "p1"),
    proposal(400, "p2"),
    proposal(400, "p3"),
  ]);
}

test("token trigger: an over-window transcript compacts at window - reserve", async () => {
  const ctx = triggerContext();
  const measured = estimateTokens(ctx.renderTranscript());

  // trigger == measured exactly: the context is due for compaction
  const provider = new RecordingProvider();
  const result = await consultHarness(provider, {
    compaction: { contextWindow: measured + 50, reserveTokens: 50 },
  }).run("token trigger task", ctx);
  assert.deepEqual(result.warnings, []);
  assert.ok(provider.compactionRequests().length >= 1);
  assert.equal(ctx.events.filter(isCompactionSummary).length, 1);
});

test("token trigger: a transcript under the trigger leaves the summarizer alone", async () => {
  const ctx = triggerContext();
  const measured = estimateTokens(ctx.renderTranscript());

  // reserve 0 and a window twice the measured size: trigger = 2 * measured
  const provider = new RecordingProvider();
  const result = await consultHarness(provider, {
    compaction: { contextWindow: measured * 2, reserveTokens: 0 },
  }).run("token trigger task", ctx);
  assert.deepEqual(result.warnings, []);
  assert.equal(provider.compactionRequests().length, 0);
  assert.equal(ctx.events.filter(isCompactionSummary).length, 0);
});

// ---------------------------------------------------------------------------
// token-mode cut and summary cap (serialization stays char-based)
// ---------------------------------------------------------------------------

test("token cut: an oversized envelope still takes the split-payload path", () => {
  const ctx = buildContext([taskMessage(), hugeDelegation(6000)]);
  assert.deepEqual(selectCutPointTokens(ctx.events, 100), { firstKeptIndex: 2, splitIndex: 1 });
  // char-mode selection is untouched and still measures chars
  assert.deepEqual(selectCutPoint(ctx.events, 1000), { firstKeptIndex: 2, splitIndex: 1 });
});

test("token compaction caps the summary by estimated tokens", async () => {
  const events = [
    taskMessage("cap task"),
    consult(800),
    proposal(400, "p1"),
    proposal(400, "p2"),
    proposal(400, "p3"),
    proposal(400, "p4"),
  ];
  const ctx = buildContext(events);
  const provider = new LongSummaryProvider("word ".repeat(2000));
  // trigger 400 tokens -> summary cap max(200, 100) = 200 tokens
  assert.equal(await compactContext(ctx, provider, { thresholdTokens: 400 }), true);

  const summary = ctx.events.find(isCompactionSummary);
  assert.ok(summary !== undefined);
  assert.ok(estimateTokens(compactionSummaryText(summary!)!) <= 200);
  assert.equal(ctx.events[0]!.payload.text, "cap task");
  for (const event of ctx.events) assert.deepEqual(validateMessage(event), []);
  // the verbatim tail is measured in tokens too: it stays under twice the
  // derived tail budget (400/2), rather than the 40000-char default
  const kept = ctx.events.slice(2).map(serializeEnvelope).join("\n\n");
  assert.ok(estimateTokens(kept) <= 400, `kept tail was ${estimateTokens(kept)} tokens`);
});

// ---------------------------------------------------------------------------
// overflow recovery with a known window
// ---------------------------------------------------------------------------

function overflowContext(): SharedContext {
  return buildContext([
    taskMessage("overflow task"),
    consult(400),
    proposal(400, "p1"),
    proposal(400, "p2"),
    proposal(400, "p3"),
  ]);
}

test("overflow recovery: a known window sizes the recovery budgets in tokens", async () => {
  const ctx = overflowContext();
  const provider = new OverflowProvider(false);
  // Char defaults (40000 chars) would leave nothing to cut here; token
  // budgets derived from the window make the recovery compaction possible.
  const harness = consultHarness(provider, {
    compaction: { contextWindow: 1200, reserveTokens: 200, keepRecentTokens: 100 },
  });

  const result = await harness.run("overflow task", ctx);

  assert.ok(result.decision.decision);
  assert.deepEqual(result.warnings, []);
  assert.equal(provider.overflowThrown, 1);
  assert.equal(provider.compactionCalls, 1);
  const nonCompactionCalls = provider.calls.filter((messages) =>
    messages.every((m) => !m.content.includes("<conversation>")),
  );
  assert.ok(nonCompactionCalls.length >= 2);
  assert.ok(nonCompactionCalls[1]![1]!.content.length < nonCompactionCalls[0]![1]!.content.length);
  assert.equal(ctx.events.filter(isCompactionSummary).length, 1);
});

test("overflow recovery: with a window, a second overflow still propagates", async () => {
  const ctx = overflowContext();
  const provider = new OverflowProvider(true);
  const harness = consultHarness(provider, {
    compaction: { contextWindow: 1200, reserveTokens: 200, keepRecentTokens: 100 },
  });

  await assert.rejects(
    () => harness.run("overflow task", ctx),
    (err: unknown) => err instanceof ProviderContextOverflowError,
  );
  assert.equal(provider.overflowThrown, 2);
  assert.equal(provider.compactionCalls, 1);
});

test("fail-soft warning names the unit it measured in", async () => {
  const ctx = triggerContext();
  const provider = new RecordingProvider();
  provider.failCompaction = true;
  const harness = consultHarness(provider, {
    compaction: { contextWindow: 400, reserveTokens: 100 },
  });

  const result = await harness.run("token trigger task", ctx);

  assert.equal(result.warnings.length, 1);
  assert.ok(result.warnings[0]!.includes("context compaction failed"));
  assert.match(result.warnings[0]!, /\(tokens: measured \d+ tokens, trigger 300 tokens\)/);
  assert.equal(ctx.events.filter(isCompactionSummary).length, 0);
});

// ---------------------------------------------------------------------------
// CLI surface + char-mode back-compat
// ---------------------------------------------------------------------------

test("config: context-window and threshold-tokens defaults, flags and env", () => {
  const prev = {
    window: process.env.TWO_BROTHERS_CONTEXT_WINDOW,
    threshold: process.env.TWO_BROTHERS_COMPACT_THRESHOLD_TOKENS,
  };
  delete process.env.TWO_BROTHERS_CONTEXT_WINDOW;
  delete process.env.TWO_BROTHERS_COMPACT_THRESHOLD_TOKENS;
  try {
    const defaults = resolveConfig();
    assert.equal(defaults.contextWindow, 0);
    assert.equal(defaults.compactThresholdTokens, 0);

    const flagged = resolveConfig({ contextWindow: 128000, compactThresholdTokens: 100000 });
    assert.equal(flagged.contextWindow, 128000);
    assert.equal(flagged.compactThresholdTokens, 100000);

    process.env.TWO_BROTHERS_CONTEXT_WINDOW = "64000";
    process.env.TWO_BROTHERS_COMPACT_THRESHOLD_TOKENS = "32000";
    const fromEnv = resolveConfig();
    assert.equal(fromEnv.contextWindow, 64000);
    assert.equal(fromEnv.compactThresholdTokens, 32000);
  } finally {
    for (const [key, value] of [
      ["TWO_BROTHERS_CONTEXT_WINDOW", prev.window],
      ["TWO_BROTHERS_COMPACT_THRESHOLD_TOKENS", prev.threshold],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("CLI --context-window switches the auto trigger to tokens", async () => {
  const dir = tmpdir();
  try {
    const file = path.join(dir, "s.jsonl");
    writeLongSession(file, "first task");
    const io = makeIO();
    // window 60, default reserve 2000 clamped to 30 -> trigger 30 tokens;
    // the resumed session is well above that, so it compacts before the run
    const code = await main(
      ["run", "second task", "--provider", "mock", "--session-file", file, "--resume", "--context-window", "60"],
      io,
    );
    assert.equal(code, 0);
    const loaded = new SessionStore(file).load();
    assert.ok(loaded.some(isCompactionSummary), "session must contain the compaction summary");
    assert.equal(loaded[0]!.payload.text, "first task");
    for (const event of loaded) assert.deepEqual(validateMessage(event), []);
    assert.ok(!io.err.some((line) => line.includes("context compaction failed")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI --compact-threshold <chars> still char-triggers without a window", async () => {
  const dir = tmpdir();
  try {
    const file = path.join(dir, "s.jsonl");
    writeLongSession(file, "first task");
    const io = makeIO();
    const code = await main(
      ["run", "second task", "--provider", "mock", "--session-file", file, "--resume", "--compact-threshold", "50"],
      io,
    );
    assert.equal(code, 0);
    const loaded = new SessionStore(file).load();
    assert.ok(loaded.some(isCompactionSummary), "char trigger must still compact");
    assert.ok(!io.err.some((line) => line.includes("context compaction failed")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});