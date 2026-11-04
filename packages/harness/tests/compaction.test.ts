/**
 * Context compaction tests. Covers the pi-durable port in src/compaction.ts
 * and its harness wiring: cut-point selection, transcript serialization,
 * summary generation through a recording provider, byte-valid envelopes
 * after compaction, resume-after-compaction, fail-soft on a summarizer
 * error, the auto threshold trigger, and the CLI flags.
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
  COMPACTION_SUMMARY_PREFIX,
  compactContext,
  isCompactionSummary,
  selectCut,
  serializeConversation,
  serializeEnvelope,
} from "../src/compaction.ts";
import { TwoBrothersHarness, type HarnessOptions } from "../src/harness.ts";
import { MockProvider, type Provider } from "../src/provider.ts";
import { createMessage, validateMessage, type Message } from "../src/protocol.ts";
import { restoreContext, SessionStore } from "../src/session.ts";

const SUMMARY_TEXT = "## Goal\nShip the catalog.\n\n## Next Steps\n1. Merge";

/** A Provider that records every request and scripts the summarizer call. */
class RecordingProvider implements Provider {
  readonly requests: ChatMessage[][] = [];
  /** Throw when the request is a summarization call (fail-soft tests). */
  failCompaction = false;
  private readonly inner: MockProvider;

  constructor(inner: MockProvider = new MockProvider()) {
    this.inner = inner;
  }

  async chat(messages: ChatMessage[], responseKind = "message"): Promise<string> {
    this.requests.push(messages);
    if (this.failCompaction && messages.some((m) => m.content.includes("<conversation>"))) {
      throw new Error("summarizer endpoint down");
    }
    if (responseKind === "compaction") return SUMMARY_TEXT;
    return this.inner.chat(messages, responseKind);
  }
}

function compactionRequests(provider: RecordingProvider): ChatMessage[][] {
  return provider.requests.filter((messages) =>
    messages.some((m) => m.content.includes("<conversation>")),
  );
}

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "two-brothers-compaction-"));
}

function proposal(answerPad: number, title = "Plan"): Message {
  return createMessage(null, "junior", "senior", "proposal", {
    title,
    answer: `Do it step by step. ${"z".repeat(answerPad)}`,
  });
}

function consult(askPad: number): Message {
  return createMessage(null, "senior", "junior", "consult", {
    task: "synthetic task",
    ask: `What about this? ${"y".repeat(askPad)}`,
    expect: "proposal",
  });
}

/** Build a context (optionally persisted) from already-valid envelopes. */
function buildContext(events: Message[], store?: SessionStore): SharedContext {
  const ctx = new SharedContext(store ?? null);
  for (const event of events) ctx.append(event);
  return ctx;
}

/** [task, big consult, proposal p1, proposal p2, proposal p3] (~2.4k chars). */
function longTranscript(store?: SessionStore): { ctx: SharedContext; events: Message[] } {
  const task = createMessage(null, "user", "senior", "message", { text: "synthetic task" });
  const ctx = buildContext(
    [task, consult(800), proposal(400, "p1"), proposal(400, "p2"), proposal(400, "p3")],
    store,
  );
  return { ctx, events: ctx.events };
}

// ---------------------------------------------------------------------------
// cut-point selection (pi's selectCut ported onto envelopes)
// ---------------------------------------------------------------------------

test("selectCut keeps the task head and a verbatim recent tail", () => {
  const { events } = longTranscript();
  // each proposal line is ~476 chars; a 900-char budget keeps the last two
  const cut = selectCut(events, 900);
  assert.equal(cut, 3);
  // the head (task) is never inside the compacted prefix
  assert.ok(cut! > 0);
  assert.equal(events[0]!.payload.text, "synthetic task");
});

test("selectCut refuses when nothing precedes the cut or the budget covers all", () => {
  const { events } = longTranscript();
  // budget larger than the whole context: nothing to compact
  assert.equal(selectCut(events, 100_000), undefined);
  // a single-event context (just the task): the head cannot be cut
  const taskOnly = buildContext([createMessage(null, "user", "senior", "message", { text: "t" })]);
  assert.equal(selectCut(taskOnly.events, 1), undefined);
});

test("re-compaction folds the earlier summary into the new one", async () => {
  const { ctx } = longTranscript();
  const provider = new RecordingProvider();
  assert.equal(await compactContext(ctx, provider, { keepRecentChars: 1000 }), true);
  // compacted once: [task, summary, proposal p1, proposal p2, proposal p3]
  assert.equal(ctx.events.length, 5);
  assert.ok(isCompactionSummary(ctx.events[1]!));
  // the task head is never re-compacted: the cut lands behind it
  assert.equal(selectCut(ctx.events, 10), 4);
  // a second pass: the old summary is passed as <previous-summary> and
  // folded — the context still carries exactly one summary event
  assert.equal(await compactContext(ctx, provider, { keepRecentChars: 10 }), true);
  assert.equal(ctx.events.filter(isCompactionSummary).length, 1);
  assert.equal(ctx.events[0]!.payload.text, "synthetic task");
  const folds = compactionRequests(provider);
  assert.equal(folds.length, 2);
  assert.ok(folds[1]![1]!.content.includes("<previous-summary>"));
  assert.ok(!folds[1]![1]!.content.includes("compacted into the following summary"));
});

// ---------------------------------------------------------------------------
// transcript serialization
// ---------------------------------------------------------------------------

test("serializeConversation renders user and brother envelopes, capping long entries", () => {
  const { events } = longTranscript();
  const text = serializeConversation(events.slice(0, 2));
  assert.ok(text.startsWith("[User]: synthetic task"));
  assert.ok(text.includes("[Senior -> Junior] (consult)"));

  const line = serializeEnvelope(consult(5000));
  const long = serializeConversation([consult(5000)]);
  assert.ok(long.includes(`[... ${line.length - 2000} more characters truncated]`));
  // pi's cap: the kept head is exactly 2000 chars
  assert.equal(long.split("\n\n[...")[0]!.length, 2000);
});

// ---------------------------------------------------------------------------
// compactContext: summary generation, byte-valid envelopes, store rewrite
// ---------------------------------------------------------------------------

test("compactContext summarizes through the provider and rewrites the context", async () => {
  const dir = tmpdir();
  try {
    const store = new SessionStore(path.join(dir, "s.jsonl"));
    const { ctx } = longTranscript(store);
    const provider = new RecordingProvider();

    assert.equal(await compactContext(ctx, provider, { keepRecentChars: 1000 }), true);

    // the summarizer saw pi's pinned prompts and the serialized prefix
    const calls = compactionRequests(provider);
    assert.equal(calls.length, 1);
    assert.ok(calls[0]![0]!.content.startsWith("You are a context summarization assistant."));
    assert.ok(calls[0]![1]!.content.includes("<conversation>"));
    assert.ok(calls[0]![1]!.content.includes("## Key Decisions"));
    // only the prefix was serialized: the kept tail is not in the source
    assert.ok(!calls[0]![1]!.content.includes('"p1"'));
    assert.ok(!calls[0]![1]!.content.includes('"p2"'));
    assert.ok(!calls[0]![1]!.content.includes('"p3"'));

    // shape: [task, summary, kept...] with dense seq
    assert.equal(ctx.events.length, 5);
    assert.equal(ctx.events[0]!.payload.text, "synthetic task");
    assert.ok(isCompactionSummary(ctx.events[1]!));
    assert.deepEqual(
      ctx.events.map((e) => e.seq),
      [1, 2, 3, 4, 5],
    );
    assert.equal(ctx.events[2]!.payload.title, "p1");
    assert.equal(ctx.events[4]!.payload.title, "p3");

    // summary text is the provider's, clearly marked
    const summaryText = String(ctx.events[1]!.payload.text);
    assert.ok(summaryText.startsWith(COMPACTION_SUMMARY_PREFIX));
    assert.ok(summaryText.includes(SUMMARY_TEXT));
    assert.ok(summaryText.endsWith("</summary>"));

    // every envelope stays byte-valid per shared/protocol.schema.json:
    // exactly the 8 top-level fields (additionalProperties: false) and
    // protocol.ts validation clean
    for (const event of ctx.events) {
      assert.deepEqual(
        Object.keys(event).sort(),
        ["from", "id", "kind", "payload", "seq", "to", "ts", "v"].sort(),
      );
      assert.deepEqual(validateMessage(event), []);
    }

    // the session file was rewritten to the compacted envelopes
    const loaded = store.load();
    assert.equal(loaded.length, 5);
    assert.deepEqual(loaded, ctx.events);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("compactContext renders a byte-stable transcript with the original task", async () => {
  const { ctx } = longTranscript();
  await compactContext(ctx, new RecordingProvider(), { keepRecentChars: 1000 });
  const rendered = ctx.renderTranscript();
  assert.ok(rendered.startsWith("[[TASK]]\nsynthetic task\n[[/TASK]]\n\nContext events:"));
  // the transcript renders payloads JSON-escaped; the marker text survives
  assert.ok(rendered.includes("compacted into the following summary"));
  assert.ok(rendered.indexOf("Context events:") < rendered.indexOf("compacted into the following summary"));
});

test("compactContext throws on an empty summary and changes nothing", async () => {
  const { ctx, events } = longTranscript();
  const before = JSON.parse(JSON.stringify(ctx.events));
  const silent: Provider = { chat: async () => "   " };
  await assert.rejects(() => compactContext(ctx, silent, { keepRecentChars: 1000 }), /no text/);
  assert.deepEqual(ctx.events, before);
  assert.equal(ctx.events.length, events.length);
});

// ---------------------------------------------------------------------------
// harness wiring: auto threshold trigger + fail-soft
// ---------------------------------------------------------------------------

function consultHarness(senior: Provider, options: HarnessOptions = {}) {
  return new TwoBrothersHarness(resolveConfig({ provider: "mock", mode: "consult" }), {
    senior,
    ...options,
  });
}

test("auto trigger: compaction fires mid-run when the context passes the threshold", async () => {
  const senior = new RecordingProvider();
  // pre-load the context: task + one big consult + one proposal (~1.6k chars
  // rendered); the run's own consult append crosses a 1000-char threshold
  const ctx = buildContext([
    createMessage(null, "user", "senior", "message", { text: "trigger" }),
    consult(800),
    proposal(400, "kept proposal"),
  ]);
  const harness = consultHarness(senior, { compaction: { thresholdChars: 1000 } });
  const result = await harness.run("trigger", ctx);

  assert.deepEqual(result.warnings, []);
  assert.equal(result.cancelled, false);
  assert.ok(result.decision.decision);
  // the loop keeps growing the context past the threshold, so further
  // compactions may fire — each through the senior provider, each emitting
  // exactly one summary event
  const requests = compactionRequests(senior).length;
  assert.ok(requests >= 1, "at least one summarization call");
  assert.equal(result.messages.filter(isCompactionSummary).length, requests);
  // every fold keeps the task, keeps one marked summary, drops the padded consult
  assert.equal(ctx.events[0]!.payload.text, "trigger");
  assert.ok(!JSON.stringify(ctx.events).includes("y".repeat(50)));
  assert.equal(ctx.events.filter(isCompactionSummary).length, 1);
  assert.deepEqual(
    ctx.events.map((e) => e.seq),
    ctx.events.map((_, i) => i + 1),
  );
});

test("fail-soft: a summarizer error keeps the full context and warns once", async () => {
  const senior = new RecordingProvider();
  senior.failCompaction = true;
  const ctx = buildContext([
    createMessage(null, "user", "senior", "message", { text: "trigger" }),
    consult(800),
    proposal(400, "kept proposal"),
  ]);
  const original = JSON.parse(JSON.stringify(ctx.events));
  const harness = consultHarness(senior, { compaction: { thresholdChars: 1000 } });
  const result = await harness.run("trigger", ctx);

  // the run completes normally: the original three envelopes survive
  // untouched (the run's own envelopes follow), one warning, no summary
  assert.ok(result.decision.decision);
  assert.deepEqual(result.errors, []);
  assert.equal(result.warnings.length, 1);
  assert.ok(result.warnings[0]!.includes("context compaction failed"));
  assert.ok(result.warnings[0]!.includes("summarizer endpoint down"));
  assert.deepEqual(ctx.events.slice(0, original.length), original);
  assert.equal(ctx.events.length, original.length + 4); // consult, proposal, review, decision
  assert.equal(ctx.events.filter(isCompactionSummary).length, 0);
  // the failing summarizer is not hammered again later in the run
  assert.equal(compactionRequests(senior).length, 1);
});

test("force on a tiny context is a no-op and never warns", async () => {
  const senior = new RecordingProvider();
  const harness = consultHarness(senior, { compaction: { force: true } });
  const result = await harness.run("tiny");
  // two envelopes (task + consult) cannot compact: nothing precedes the cut
  assert.deepEqual(result.warnings, []);
  assert.equal(result.context.events.filter(isCompactionSummary).length, 0);
  // the summarizer is never called when there is nothing to compact
  assert.equal(compactionRequests(senior).length, 0);
});

// ---------------------------------------------------------------------------
// resume after compaction
// ---------------------------------------------------------------------------

test("a compacted session file resumes and keeps rendering correctly", async () => {
  const dir = tmpdir();
  try {
    const store = new SessionStore(path.join(dir, "s.jsonl"));
    const first = new TwoBrothersHarness(resolveConfig({ provider: "mock", mode: "consult" }));
    await first.run("task one", new SharedContext(store));
    assert.equal(store.load().length, 5);

    // compact the persisted session down to task + summary + tail
    const ctx = restoreContext(store);
    const provider = new RecordingProvider();
    assert.equal(await compactContext(ctx, provider, { keepRecentChars: 100 }), true);
    assert.equal(store.load().length, ctx.events.length);
    assert.ok(store.load().some(isCompactionSummary));

    // resume: the compacted file loads, renders the original task, and the
    // loop continues with dense seq numbering
    const restored = restoreContext(store);
    assert.equal(restored.events[0]!.payload.text, "task one");
    const rendered = restored.renderTranscript();
    assert.ok(rendered.startsWith("[[TASK]]\ntask one\n[[/TASK]]"));

    const second = new TwoBrothersHarness(resolveConfig({ provider: "mock", mode: "consult" }));
    const result = await second.run("task two", restored);
    assert.ok(result.decision.decision);
    const seqs = restored.events.map((e) => e.seq);
    assert.deepEqual(seqs, seqs.map((_, i) => i + 1));
    assert.equal(store.load().length, restored.events.length);
    // still exactly one summary event after the resumed run
    assert.equal(restored.events.filter(isCompactionSummary).length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------

function makeIO(): CliIO & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, log: (line) => out.push(line), error: (line) => err.push(line) };
}

function writeLongSession(file: string, task: string): void {
  const store = new SessionStore(file);
  const ctx = new SharedContext(store);
  ctx.makeAndAppend("user", "senior", "message", { text: task });
  ctx.makeAndAppend("senior", "junior", "consult", { task, ask: `q ${"y".repeat(300)}`, expect: "proposal" });
  ctx.makeAndAppend("junior", "senior", "proposal", { title: "p1", answer: `a ${"z".repeat(300)}` });
  ctx.makeAndAppend("senior", "junior", "review", { verdict: "accept", notes: "ok" });
}

test("CLI --resume --compact compacts the session before the run", async () => {
  const dir = tmpdir();
  try {
    const file = path.join(dir, "s.jsonl");
    writeLongSession(file, "first task");
    const io = makeIO();
    const code = await main(
      ["run", "second task", "--provider", "mock", "--session-file", file, "--resume", "--compact", "--compact-keep-recent", "40"],
      io,
    );
    assert.equal(code, 0);
    const loaded = new SessionStore(file).load();
    assert.ok(loaded.some(isCompactionSummary), "session must contain the compaction summary");
    // the old padded consult and proposal were folded into the summary
    assert.ok(!JSON.stringify(loaded).includes("y".repeat(100)));
    assert.ok(!JSON.stringify(loaded).includes("z".repeat(100)));
    assert.ok(loaded.length < 9, "session shrank: old prefix folded into the summary");
    assert.equal(loaded[0]!.payload.text, "first task");
    for (const event of loaded) assert.deepEqual(validateMessage(event), []);
    assert.ok(!io.err.some((line) => line.includes("context compaction failed")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI --compact-threshold auto-compacts during the run", async () => {
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
    assert.ok(loaded.some(isCompactionSummary));
    assert.equal(loaded[0]!.payload.text, "first task");
    for (const event of loaded) assert.deepEqual(validateMessage(event), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("config: compaction defaults and env overrides", () => {
  const prev = {
    compact: process.env.TWO_BROTHERS_COMPACT,
    threshold: process.env.TWO_BROTHERS_COMPACT_THRESHOLD,
    keep: process.env.TWO_BROTHERS_COMPACT_KEEP_RECENT,
  };
  delete process.env.TWO_BROTHERS_COMPACT;
  delete process.env.TWO_BROTHERS_COMPACT_THRESHOLD;
  delete process.env.TWO_BROTHERS_COMPACT_KEEP_RECENT;
  try {
    const defaults = resolveConfig();
    assert.equal(defaults.compact, false);
    assert.equal(defaults.compactThreshold, 0);
    assert.equal(defaults.compactKeepRecent, 40000);

    process.env.TWO_BROTHERS_COMPACT = "true";
    process.env.TWO_BROTHERS_COMPACT_THRESHOLD = "1234";
    process.env.TWO_BROTHERS_COMPACT_KEEP_RECENT = "567";
    const cfg = resolveConfig();
    assert.equal(cfg.compact, true);
    assert.equal(cfg.compactThreshold, 1234);
    assert.equal(cfg.compactKeepRecent, 567);
  } finally {
    for (const [key, value] of [
      ["TWO_BROTHERS_COMPACT", prev.compact],
      ["TWO_BROTHERS_COMPACT_THRESHOLD", prev.threshold],
      ["TWO_BROTHERS_COMPACT_KEEP_RECENT", prev.keep],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
