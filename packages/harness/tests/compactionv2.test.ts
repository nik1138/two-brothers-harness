/**
 * Compaction v2 tests: the split-payload cut for envelopes larger than the
 * verbatim budget, incremental `<previous-summary>` chaining, the
 * overflow → compact-and-retry path (and its surfacing when the retry also
 * overflows), and the reserve margin below `thresholdChars`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveConfig } from "../src/config.ts";
import { SharedContext, type ChatMessage } from "../src/context.ts";
import {
  COMPACTION_SUMMARY_PREFIX,
  COMPACTION_SUMMARY_SUFFIX,
  DEFAULT_RESERVE_CHARS,
  compactContext,
  compactionSummaryText,
  compactionTriggerChars,
  isCompactionSummary,
  selectCutPoint,
} from "../src/compaction.ts";
import { TwoBrothersHarness, type HarnessOptions } from "../src/harness.ts";
import {
  MockProvider,
  ProviderContextOverflowError,
  type Provider,
  type Tool,
} from "../src/provider.ts";
import { createMessage, validateMessage, type Message } from "../src/protocol.ts";

const SUMMARY_TEXT = "## Goal\nShip the report.\n\n## Next Steps\n1. Merge";

/** A Provider that records requests and scripts the summarizer call. */
class RecordingProvider implements Provider {
  readonly requests: ChatMessage[][] = [];
  private readonly inner = new MockProvider();

  async chat(messages: ChatMessage[], responseKind = "message"): Promise<string> {
    this.requests.push(messages);
    if (responseKind === "compaction") return SUMMARY_TEXT;
    return this.inner.chat(messages, responseKind);
  }

  compactionRequests(): ChatMessage[][] {
    return this.requests.filter((messages) =>
      messages.some((m) => m.content.includes("<conversation>")),
    );
  }
}

/**
 * A Provider that overflows on its first non-compaction call (or on every
 * one) and serves the summarizer normally, so the harness's recovery path is
 * observable.
 */
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

function consult(askPad: number, task = "synthetic task"): Message {
  return createMessage(null, "senior", "junior", "consult", {
    task,
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

/** One huge delegation: the head marker first, the tail marker in the last field. */
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

// ---------------------------------------------------------------------------
// split-payload cut
// ---------------------------------------------------------------------------

test("split-payload cut: an oversized single delegation folds head+tail and the session compacts", async () => {
  const ctx = buildContext([taskMessage(), hugeDelegation(6000)]);
  // the boundary envelope alone exceeds the budget: an envelope-boundary cut
  // would have nothing older to summarize, so the cut moves past it
  assert.deepEqual(selectCutPoint(ctx.events, 1000), { firstKeptIndex: 2, splitIndex: 1 });

  const provider = new RecordingProvider();
  assert.equal(await compactContext(ctx, provider, { keepRecentChars: 1000 }), true);

  // the huge delegation is gone from the verbatim context, represented by the
  // marked summary; the task head survives and seq stays dense
  assert.equal(ctx.events.length, 2);
  assert.equal(ctx.events[0]!.payload.text, "Ship the report");
  assert.ok(isCompactionSummary(ctx.events[1]!));
  assert.deepEqual(
    ctx.events.map((event) => event.seq),
    [1, 2],
  );
  for (const event of ctx.events) assert.deepEqual(validateMessage(event), []);
  assert.ok(!JSON.stringify(ctx.events).includes("x".repeat(100)));

  // the summarizer saw the head and tail of the split envelope plus an
  // explicit truncation marker — cut content is never silently dropped
  const request = provider.requests[0]![1]!.content;
  assert.ok(request.startsWith("<conversation>\n"));
  assert.ok(request.includes("HEAD-MARKER"));
  assert.ok(request.includes("TAIL-MARKER"));
  assert.match(request, /\.\.\. \d+ characters truncated from the middle of this envelope\]/);
  assert.ok(!request.includes("<previous-summary>"));
});

test("split-payload cut: an oversized envelope mid-tail is folded, later envelopes stay verbatim", async () => {
  const ctx = buildContext([taskMessage(), hugeDelegation(6000), proposal(200, "still recent")]);
  const cut = selectCutPoint(ctx.events, 1000);
  assert.deepEqual(cut, { firstKeptIndex: 2, splitIndex: 1 });

  const provider = new RecordingProvider();
  assert.equal(await compactContext(ctx, provider, { keepRecentChars: 1000 }), true);
  assert.equal(ctx.events.length, 3);
  assert.ok(isCompactionSummary(ctx.events[1]!));
  assert.equal(ctx.events[2]!.payload.title, "still recent");
  assert.ok(provider.requests[0]![1]!.content.includes("HEAD-MARKER"));
});

// ---------------------------------------------------------------------------
// incremental summary chaining
// ---------------------------------------------------------------------------

test("incremental chaining: a previous summary rides <previous-summary> with the update prompt", async () => {
  const previousBody = "## Goal\nOld goal kept.\n\n## Progress\n### Done\n- [x] first pass";
  const ctx = buildContext([
    taskMessage(),
    createMessage(null, "user", "senior", "message", {
      text: `${COMPACTION_SUMMARY_PREFIX}${previousBody}${COMPACTION_SUMMARY_SUFFIX}`,
    }),
    proposal(600, "p1"),
    proposal(600, "p2"),
  ]);
  assert.equal(compactionSummaryText(ctx.events[1]!), previousBody);

  const provider = new RecordingProvider();
  assert.equal(await compactContext(ctx, provider, { keepRecentChars: 10 }), true);

  const request = provider.requests[0]![1]!.content;
  const conversation = request.slice(
    request.indexOf("<conversation>"),
    request.indexOf("</conversation>") + "</conversation>".length,
  );
  assert.ok(request.includes(`<previous-summary>\n${previousBody}\n</previous-summary>`));
  assert.ok(request.includes("Update the existing structured summary with new information."));
  assert.ok(!request.includes("Create a structured context checkpoint summary"));
  // the old summary envelope is not repeated inside the conversation source
  assert.ok(!conversation.includes("compacted into the following summary"));

  // still exactly one summary event, carrying the provider's fresh text
  assert.equal(ctx.events[0]!.payload.text, "Ship the report");
  assert.equal(ctx.events.filter(isCompactionSummary).length, 1);
  assert.equal(compactionSummaryText(ctx.events[1]!), SUMMARY_TEXT);
  assert.deepEqual(
    ctx.events.map((event) => event.seq),
    ctx.events.map((_, index) => index + 1),
  );
});

// ---------------------------------------------------------------------------
// overflow recovery
// ---------------------------------------------------------------------------

function overflowContext(): SharedContext {
  return buildContext([
    taskMessage("overflow task"),
    consult(2000, "overflow task"),
    proposal(2000, "p1"),
    proposal(2000, "p2"),
  ]);
}

test("overflow recovery: one compact-and-retry succeeds against the compacted context", async () => {
  const ctx = overflowContext();
  const provider = new OverflowProvider(false);
  const harness = consultHarness(provider, { compaction: { keepRecentChars: 100 } });

  const result = await harness.run("overflow task", ctx);

  assert.ok(result.decision.decision);
  assert.deepEqual(result.warnings, []);
  assert.equal(provider.overflowThrown, 1);
  assert.equal(provider.compactionCalls, 1);
  // the retried request was rebuilt from the compacted context and is smaller
  const nonCompactionCalls = provider.calls.filter((messages) =>
    messages.every((m) => !m.content.includes("<conversation>")),
  );
  assert.ok(nonCompactionCalls.length >= 2);
  assert.ok(nonCompactionCalls[1]![1]!.content.length < nonCompactionCalls[0]![1]!.content.length);
  // the summary event flowed into the run and the session context
  assert.equal(ctx.events.filter(isCompactionSummary).length, 1);
  assert.equal(result.messages.filter(isCompactionSummary).length, 1);
});

test("overflow recovery: a tool-loop overflow compacts and retries with rebuilt messages", async () => {
  class ToolOverflowProvider implements Provider {
    compactionCalls = 0;
    overflowThrown = 0;
    private readonly inner = new MockProvider();

    async chat(messages: ChatMessage[], responseKind = "message"): Promise<string> {
      if (responseKind === "compaction") {
        this.compactionCalls += 1;
        return SUMMARY_TEXT;
      }
      return this.inner.chat(messages, responseKind);
    }

    async chatWithTools(messages: ChatMessage[], tools: Tool[], options = {}) {
      if (this.overflowThrown === 0) {
        this.overflowThrown += 1;
        throw new ProviderContextOverflowError(413, "tool request exceeds the context window");
      }
      const response = await this.inner.chatWithTools(messages, tools, options);
      return { content: response.content, toolCalls: [] };
    }
  }

  const tool: Tool = {
    name: "read_file",
    description: "read a file",
    parameters: {},
    execute: () => "contents",
  };
  const provider = new ToolOverflowProvider();
  const harness = new TwoBrothersHarness(resolveConfig({ provider: "mock", mode: "work" }), {
    senior: provider,
    seniorTools: [tool],
    compaction: { keepRecentChars: 100 },
  });

  const result = await harness.run("tool overflow task");

  assert.ok(result.decision.decision);
  assert.deepEqual(result.warnings, []);
  assert.equal(provider.overflowThrown, 1);
  assert.equal(provider.compactionCalls, 1);
  assert.equal(result.context.events.filter(isCompactionSummary).length, 1);
});

test("overflow recovery: a second overflow surfaces the provider error", async () => {
  const ctx = overflowContext();
  const provider = new OverflowProvider(true);
  const harness = consultHarness(provider, { compaction: { keepRecentChars: 100 } });

  await assert.rejects(
    () => harness.run("overflow task", ctx),
    (err: unknown) => err instanceof ProviderContextOverflowError,
  );
  // exactly one retry; the compaction did run before the error surfaced
  assert.equal(provider.overflowThrown, 2);
  assert.equal(provider.compactionCalls, 1);
  assert.equal(ctx.events.filter(isCompactionSummary).length, 1);
});

// ---------------------------------------------------------------------------
// reserve margin
// ---------------------------------------------------------------------------

test("reserve margin: the trigger sits below the threshold and stays configurable", () => {
  assert.equal(compactionTriggerChars({ thresholdChars: 10000, reserveChars: 2000 }), 8000);
  assert.equal(
    compactionTriggerChars({ thresholdChars: 10000, reserveChars: 0 }),
    10000,
  );
  // default reserve, clamped to half the threshold so small budgets still fire
  assert.equal(DEFAULT_RESERVE_CHARS, 8000);
  assert.equal(compactionTriggerChars({ thresholdChars: 10000 }), 5000);
  assert.equal(compactionTriggerChars({ thresholdChars: 1000 }), 500);
  assert.equal(compactionTriggerChars({}), 0);
});

test("reserve margin: a context between the trigger and the threshold compacts early", async () => {
  const events = [
    taskMessage("reserve task"),
    consult(800, "reserve task"),
    proposal(400, "kept one"),
    proposal(400, "kept two"),
    proposal(400, "kept three"),
  ];
  const length = buildContext(events).renderTranscript().length;

  // threshold = 2 * length, reserve = length: the trigger is exactly `length`,
  // so the preloaded context is already due for compaction...
  const reservedProvider = new RecordingProvider();
  const reserved = await consultHarness(reservedProvider, {
    compaction: { thresholdChars: length * 2, reserveChars: length },
  }).run("reserve task", buildContext(events));
  assert.deepEqual(reserved.warnings, []);
  assert.ok(reservedProvider.compactionRequests().length >= 1);

  // ...while without the reserve margin the same context and run stay under
  // the threshold and never call the summarizer
  const controlProvider = new RecordingProvider();
  const controlCtx = buildContext(events);
  const control = await consultHarness(controlProvider, {
    compaction: { thresholdChars: length * 2, reserveChars: 0 },
  }).run("reserve task", controlCtx);
  assert.deepEqual(control.warnings, []);
  assert.equal(controlProvider.compactionRequests().length, 0);
  assert.equal(controlCtx.events.filter(isCompactionSummary).length, 0);
});