/**
 * Safety pins for the two compaction fixes from the core-workflow (F4) and
 * provider-cache (F2) audits:
 *
 * 1. **F4 — the summarization request is size-aware.** Recovery compaction
 *    used to send the WHOLE serialized prefix in one uncapped request, so a
 *    small-window summarizer overflowed too; `compactionFailed` then re-raised
 *    the original overflow and an otherwise recoverable run died. Char mode
 *    (no known window) now bounds the serialized conversation; token mode
 *    (known window) keeps its pre-existing request bytes, and an overflowing
 *    summarizer gets exactly one tighter retry before the fail-soft path.
 * 2. **F2 — the token-mode trigger measures the static prompt prefix.** The
 *    trigger used to compare `estimateTokens(renderTranscript())` alone, so
 *    the system prompt + tool schemas (~thousands of tokens) were on the wire
 *    but unmeasured and proactive compaction fired late. The gauge now adds
 *    the assembled system prompt and tool schemas (the same seam the role
 *    calls use, max across roles); char mode stays transcript-only.
 *
 * Hermetic and offline: scripted/mock providers only, no network, no temp
 * files. Every assertion is on observable behavior (a compaction request, a
 * summary envelope, an overflow), never on private internals.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_SUMMARIZER_SOURCE_CHARS,
  compactContext,
  compactionBudgets,
  estimateTokens,
  isCompactionSummary,
  selectCutPointTokens,
  serializeConversation,
  summarizerSourceBudget,
} from "../src/compaction.ts";
import { resolveConfig } from "../src/config.ts";
import { SharedContext, type ChatMessage } from "../src/context.ts";
import { TwoBrothersHarness, type HarnessOptions } from "../src/harness.ts";
import {
  MockProvider,
  ProviderContextOverflowError,
  type Provider,
  type Tool,
  type ToolChatOptions,
  type ToolChatResponse,
} from "../src/provider.ts";
import { createMessage, type Message } from "../src/protocol.ts";

const SUMMARY_TEXT = "## Goal\nKeep the run alive.\n\n## Next Steps\n1. Retry the node.";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function taskMessage(text = "recovery task"): Message {
  return createMessage(null, "user", "senior", "message", { text });
}

/** One large brother envelope, the way a tool-heavy node appends one. */
function bigEnvelope(chars: number, index: number): Message {
  return createMessage(null, "junior", "senior", "deliverable", {
    result: `chunk ${index} ` + "r".repeat(chars),
    notes: "checked against the acceptance criteria",
  });
}

/**
 * A context of ~280 000 chars (≈ 70k estimated tokens): the shape the F4
 * scenario reaches when tool-heavy nodes' evidence has landed in the shared
 * context and the serialized summarizer source — ~2 000 chars per envelope —
 * is far larger than the summarizer's own window. No window is configured for
 * this run, so it is char mode.
 */
function bigContext(): SharedContext {
  const ctx = new SharedContext();
  ctx.append(taskMessage());
  for (let index = 0; index < 90; index++) ctx.append(bigEnvelope(3000, index));
  return ctx;
}

/** A compactable transcript of ~20k estimated tokens (the F2 gauge probe). */
function triggerContext(): SharedContext {
  const ctx = new SharedContext();
  ctx.append(taskMessage("token trigger task"));
  ctx.append(
    createMessage(null, "user", "senior", "message", {
      text: "Context events: todo_updated — [x] inspect the cut point",
    }),
  );
  for (let index = 0; index < 20; index++) ctx.append(bigEnvelope(4000, index));
  return ctx;
}

/**
 * A provider that enforces a small-window model hermetically: every request
 * measured over `windowTokens` raises `ProviderContextOverflowError`, exactly
 * like the adapters' overflow classification. Compaction calls are measured
 * too, which is what reproduces F4 (an uncapped summarizer request overflows
 * the summarizer).
 */
class WindowProvider implements Provider {
  readonly windowTokens: number;
  /** The serialized `<conversation>` request of every compaction attempt. */
  readonly compactionSources: string[] = [];
  /** Response kind + measured size of every request, in call order. */
  readonly calls: { kind: string; tokens: number }[] = [];
  readonly overflowed: string[] = [];
  private readonly inner = new MockProvider();

  constructor(windowTokens: number) {
    this.windowTokens = windowTokens;
  }

  async chat(messages: ChatMessage[], responseKind = "message"): Promise<string> {
    const isCompaction = messages.some((message) => message.content.includes("<conversation>"));
    const tokens = messages.reduce((sum, message) => sum + estimateTokens(message.content), 0);
    if (isCompaction) {
      this.compactionSources.push(messages.map((message) => message.content).join("\n"));
    }
    this.calls.push({ kind: isCompaction ? "compaction" : responseKind, tokens });
    if (tokens > this.windowTokens) {
      this.overflowed.push(isCompaction ? "compaction" : responseKind);
      throw new ProviderContextOverflowError(413, "request exceeds the model context window");
    }
    if (isCompaction) return SUMMARY_TEXT;
    return this.inner.chat(messages, responseKind);
  }

  async chatWithTools(
    messages: ChatMessage[],
    tools: Tool[],
    options: ToolChatOptions = {},
  ): Promise<ToolChatResponse> {
    const tokens = messages.reduce((sum, message) => sum + estimateTokens(message.content), 0);
    this.calls.push({ kind: options.responseKind ?? "message", tokens });
    if (tokens > this.windowTokens) {
      this.overflowed.push(options.responseKind ?? "message");
      throw new ProviderContextOverflowError(413, "request exceeds the model context window");
    }
    return this.inner.chatWithTools(messages, tools, options);
  }
}

/** Records every request and scripts the summarizer call. */
class RecordingProvider implements Provider {
  readonly requests: ChatMessage[][] = [];
  /** Response kinds in call order, for first-boundary assertions. */
  readonly kinds: string[] = [];
  private readonly inner: MockProvider;

  constructor(inner: MockProvider = new MockProvider()) {
    this.inner = inner;
  }

  async chat(messages: ChatMessage[], responseKind = "message"): Promise<string> {
    this.requests.push(messages);
    this.kinds.push(responseKind);
    if (responseKind === "compaction") return SUMMARY_TEXT;
    return this.inner.chat(messages, responseKind);
  }

  async chatWithTools(
    messages: ChatMessage[],
    tools: Tool[],
    options: ToolChatOptions = {},
  ): Promise<ToolChatResponse> {
    this.requests.push(messages);
    this.kinds.push(options.responseKind ?? "message");
    return this.inner.chatWithTools(messages, tools, options);
  }

  compactionRequests(): ChatMessage[][] {
    return this.requests.filter((messages) =>
      messages.some((message) => message.content.includes("<conversation>")),
    );
  }
}

/**
 * A summarizer that overflows above `limitTokens` and answers below it, so the
 * one-tighter-retry path can be observed without any harness run.
 */
class OverLimitSummarizer implements Provider {
  readonly limitTokens: number;
  readonly sources: string[] = [];
  private readonly inner = new MockProvider();

  constructor(limitTokens: number) {
    this.limitTokens = limitTokens;
  }

  async chat(messages: ChatMessage[], responseKind = "message"): Promise<string> {
    if (responseKind !== "compaction") return this.inner.chat(messages, responseKind);
    const tokens = messages.reduce((sum, message) => sum + estimateTokens(message.content), 0);
    this.sources.push(messages.map((message) => message.content).join("\n"));
    if (tokens > this.limitTokens) {
      throw new ProviderContextOverflowError(413, "summarizer context window exceeded");
    }
    return SUMMARY_TEXT;
  }
}

/** A compact but real tool belt: schemas that ride the wire beside the prompt. */
function bigBelt(count: number): Tool[] {
  return Array.from({ length: count }, (_, index) => ({
    name: `inspect_${index}`,
    description: `Inspect part ${index} of the workspace. ${"d".repeat(400)}`,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: `file path ${"p".repeat(200)}` },
        mode: { type: "string", enum: ["read", "list", "stat"] },
      },
      required: ["path"],
    },
    execute: () => "ok",
  }));
}

/** A harness config whose compaction knobs are explicitly zeroed (env-immune). */
function safetyConfig(extra: Record<string, unknown> = {}) {
  return resolveConfig({
    provider: "mock",
    mode: "consult",
    contextWindow: 0,
    compact: false,
    compactThreshold: 0,
    compactThresholdTokens: 0,
    compactKeepRecent: 0,
    ...extra,
  });
}

// ---------------------------------------------------------------------------
// F4: the summarizer source is bounded when no window is known
// ---------------------------------------------------------------------------

test("F4: recovery compaction survives a small-window summarizer (no configured window)", async () => {
  // The F4 scenario in miniature: a ~280k-char context (tool-heavy cycles'
  // envelopes) on a 32k-token model with no --context-window and no preset
  // window. The first node call overflows; recovery must be able to summarize
  // WITHOUT overflowing the summarizer too.
  const windowTokens = 32_000;
  const ctx = bigContext();
  assert.ok(
    estimateTokens(ctx.renderTranscript()) > windowTokens,
    "fixture must overflow the simulated window before compaction",
  );
  const provider = new WindowProvider(windowTokens);
  const harness = new TwoBrothersHarness(safetyConfig(), {
    senior: provider,
    junior: provider,
  });

  const result = await harness.run("recovery task", ctx);

  // Pre-fix: the summarizer request carried the whole ~154k-char prefix
  // (~38k tokens) and overflowed, compactionFailed surfaced the original
  // overflow and the run failed. Post-fix: the bounded source fits.
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  assert.ok(result.decision.decision);
  assert.equal(ctx.events[0]!.payload.text, "recovery task");
  assert.equal(ctx.events.filter(isCompactionSummary).length, 1);
  // The summarizer request is bounded, not the whole prefix.
  assert.ok(provider.compactionSources.length >= 1);
  const firstRequest = provider.compactionSources[0]!;
  assert.ok(
    firstRequest.length < DEFAULT_SUMMARIZER_SOURCE_CHARS + 5000,
    `summarizer request was ${firstRequest.length} chars`,
  );
  assert.match(firstRequest, /\.\.\. \d+ more characters truncated\]/);
  assert.ok(provider.overflowed.includes("consult"), "the node call must overflow first");
});

test("F4: token mode keeps the existing uncapped summarizer request", async () => {
  // The same large prefix with a known window stays on the pre-existing
  // path: the request carries the exact uncapped serialization (known-window
  // request bytes are unchanged by this fix).
  const ctx = bigContext();
  const events = ctx.events.slice();
  const provider = new RecordingProvider();
  assert.equal(await compactContext(ctx, provider, { thresholdTokens: 100_000 }), true);

  const requests = provider.compactionRequests();
  assert.equal(requests.length, 1);
  const request = requests[0]!.map((message) => message.content).join("\n");
  // Rebuild the pre-fix source with the public cut/serialize helpers: the
  // known-window request must contain it verbatim, however large it is.
  const cut = selectCutPointTokens(events, compactionBudgets({ thresholdTokens: 100_000 }).keepRecent);
  assert.ok(cut);
  const source = serializeConversation(events.slice(0, cut.firstKeptIndex), {
    splitIndex: cut.splitIndex,
  });
  assert.ok(
    source.length > DEFAULT_SUMMARIZER_SOURCE_CHARS,
    `fixture source must exceed the conservative cap (was ${source.length} chars)`,
  );
  assert.ok(request.includes(source), "token mode must keep the uncapped source bytes");
  assert.equal(ctx.events.findIndex(isCompactionSummary) >= 0, true);
});

test("F4: char mode derives the source budget from the configured trigger", async () => {
  // threshold 50k chars -> trigger 42k (default reserve 8k). The source cap is
  // the caller's declared context budget, not the conservative default.
  const ctx = bigContext();
  const provider = new RecordingProvider();
  assert.equal(await compactContext(ctx, provider, { thresholdChars: 50_000 }), true);
  const request = provider.compactionRequests()[0]!.map((message) => message.content).join("\n");
  assert.ok(request.length < 42_000 + 5_000, `source must follow the trigger budget (was ${request.length})`);
  assert.match(request, /\.\.\. \d+ more characters truncated\]/);
});

test("summarizerSourceBudget: char mode bounds, token mode does not", () => {
  assert.equal(summarizerSourceBudget({}), DEFAULT_SUMMARIZER_SOURCE_CHARS);
  assert.equal(
    summarizerSourceBudget({ keepRecentChars: 1000 }),
    DEFAULT_SUMMARIZER_SOURCE_CHARS,
    "an explicit tail alone is not a context budget",
  );
  // thresholdChars 10000, default reserve 8000 clamped to half -> 5000
  assert.equal(summarizerSourceBudget({ thresholdChars: 10_000 }), 5000);
  assert.equal(summarizerSourceBudget({ thresholdChars: 100_000 }), 92_000);
  // A known window (or token threshold) means the existing uncapped path.
  assert.equal(summarizerSourceBudget({ contextWindow: 32_000 }), undefined);
  assert.equal(summarizerSourceBudget({ thresholdTokens: 30_000 }), undefined);
});

test("F4: an overflowing summarizer gets exactly one tighter retry", async () => {
  // First bounded source (64000 chars ≈ 16k tokens) overflows a 12000-token
  // summarizer; the halved retry (≈ 8k tokens) fits and produces the summary.
  const ctx = bigContext();
  const provider = new OverLimitSummarizer(12_000);
  assert.equal(await compactContext(ctx, provider, {}), true);
  assert.equal(provider.sources.length, 2, "exactly one retry");
  assert.ok(estimateTokens(provider.sources[0]!) > 12_000);
  assert.ok(estimateTokens(provider.sources[1]!) <= 12_000);
  assert.equal(ctx.events.filter(isCompactionSummary).length, 1);
});

test("F4: a summarizer that still overflows is fail-soft (context kept, no data lost)", async () => {
  const ctx = bigContext();
  const before = JSON.parse(JSON.stringify(ctx.events)) as Message[];
  const provider = new OverLimitSummarizer(1000);
  await assert.rejects(
    () => compactContext(ctx, provider, {}),
    (err: unknown) => err instanceof ProviderContextOverflowError,
  );
  assert.equal(provider.sources.length, 2, "one bounded try plus one tighter retry");
  assert.deepEqual(ctx.events, before, "a failed summarizer never rewrites the context");

  // Through the harness the same failure is fail-soft: one warning, the run
  // continues with the full context (never a lost prefix).
  const tiny = triggerContext();
  const tinyBefore = JSON.parse(JSON.stringify(tiny.events)) as Message[];
  const overflowing: Provider = {
    chat: async (messages, responseKind = "message") => {
      if (responseKind === "compaction") {
        throw new ProviderContextOverflowError(413, "summarizer context window exceeded");
      }
      return new MockProvider().chat(messages, responseKind);
    },
  };
  const harness = new TwoBrothersHarness(safetyConfig(), {
    senior: overflowing,
    junior: new MockProvider(),
    // A char threshold makes the first boundary compact; the summarizer then
    // overflows and the run must continue untouched.
    compaction: { thresholdChars: 100, reserveChars: 0 },
  });
  const result = await harness.run("token trigger task", tiny);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0]!, /context compaction failed/);
  assert.deepEqual(tiny.events.slice(0, tinyBefore.length), tinyBefore);
  assert.equal(tiny.events.filter(isCompactionSummary).length, 0);
  assert.ok(result.decision.decision);
});

// ---------------------------------------------------------------------------
// F2: the token-mode trigger counts the static prompt prefix
// ---------------------------------------------------------------------------

/**
 * Whether the FIRST node-boundary compaction fires at `window` tokens, for a
 * harness whose system prompts are `systemChars` long and whose shared belt is
 * the same big schemas. The trigger compares transcript + static prompt
 * prefix, so the first provider call is the summarizer exactly when the wire
 * request is due — the observable cross point.
 */
async function firstBoundaryCompacts(window: number, systemChars: number): Promise<boolean> {
  const ctx = triggerContext();
  const provider = new RecordingProvider();
  const harness = new TwoBrothersHarness(
    safetyConfig({
      seniorSystem: "s".repeat(systemChars),
      juniorSystem: "s".repeat(systemChars),
    }),
    {
      senior: provider,
      junior: provider,
      toolScopes: { shared: bigBelt(12) },
      compaction: { contextWindow: window, reserveTokens: 0 },
    } satisfies HarnessOptions,
  );
  const result = await harness.run("token trigger task", ctx);
  assert.deepEqual(result.warnings, []);
  return provider.kinds[0] === "compaction";
}

test("F2: the token trigger fires earlier by the measured static prompt prefix", async () => {
  const transcript = estimateTokens(triggerContext().renderTranscript());
  // Transcript-only measurement (pre-fix) sat at `transcript`; a window just
  // above it would never have compacted. With the prefix counted it fires.
  assert.equal(await firstBoundaryCompacts(transcript + 50, 4_000), true);

  // Cross point: the smallest window that does NOT compact at the first
  // boundary. It fires iff transcript + prefix >= window.
  const crossPoint = async (systemChars: number): Promise<number> => {
    let fires = transcript; // at the transcript-only size the trigger fires
    let quiet = transcript + 60_000; // far above any prompt: never fires
    assert.equal(await firstBoundaryCompacts(fires, systemChars), true);
    assert.equal(await firstBoundaryCompacts(quiet, systemChars), false);
    while (fires + 1 < quiet) {
      const middle = Math.floor((fires + quiet) / 2);
      if (await firstBoundaryCompacts(middle, systemChars)) fires = middle;
      else quiet = middle;
    }
    return quiet;
  };
  const smallCross = await crossPoint(4_000);
  const bigCross = await crossPoint(24_000);

  // Growing the system prompt by 20 000 ASCII chars (≈ 5 000 estimated
  // tokens) moves the cross point by exactly that measured amount — the
  // prefix is part of the gauge, and the trigger formula and reserve
  // semantics are otherwise unchanged.
  const extra = estimateTokens("s".repeat(24_000)) - estimateTokens("s".repeat(4_000));
  assert.ok(
    Math.abs(bigCross - smallCross - extra) <= 2,
    `cross points moved by ${bigCross - smallCross}, expected ~${extra}`,
  );
  // And the cross point sits above the transcript-only trigger, never at it.
  assert.ok(smallCross > transcript);
});

test("F2: char mode keeps the transcript-only trigger", async () => {
  // A large static prefix must NOT move the char-mode trigger: the threshold
  // is compared with the rendered transcript's char length, unchanged.
  const ctx = triggerContext();
  const transcriptChars = ctx.renderTranscript().length;
  const provider = new RecordingProvider();
  const harness = new TwoBrothersHarness(
    safetyConfig({
      seniorSystem: "s".repeat(24_000),
      juniorSystem: "s".repeat(24_000),
    }),
    {
      senior: provider,
      junior: provider,
      toolScopes: { shared: bigBelt(12) },
      compaction: { thresholdChars: transcriptChars + 5000, reserveChars: 0 },
    } satisfies HarnessOptions,
  );
  const result = await harness.run("token trigger task", ctx);
  assert.deepEqual(result.warnings, []);
  assert.notEqual(provider.kinds[0], "compaction", "char mode must stay transcript-only");
});
