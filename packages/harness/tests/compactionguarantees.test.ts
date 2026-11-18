/**
 * Regression pins for the two compaction guarantees research lanes kept
 * re-flagging as gaps:
 *
 * 1. **Atomic cuts (never-split).** Protocol envelopes are atomic — tool-call
 *    evidence rides inside payload fields, never as separate envelopes — so
 *    every cut point is an envelope boundary and the `[[TASK]]` head is never
 *    inside the compacted prefix. pi's "never split tool calls" rule needs no
 *    analogue. Pinned here against `selectCutPoint`/`selectCutPointTokens`
 *    over a transcript dense with tool-call-like payload evidence, and
 *    end-to-end through `compactContext` (retained tail is whole envelopes;
 *    an oversized boundary envelope is folded with the explicit middle
 *    truncation marker, never silently dropped).
 * 2. **Min-of-roles window.** The effective auto-compaction context window is
 *    the SMALLER of the two roles' resolved preset windows
 *    (`runtime.ts::presetContextWindow`), fed into
 *    `config.ts::serveCompactionSettings` as the last-resort
 *    `context_window` — senior 1M + junior 200K ⇒ 200K. Pinned here against
 *    `presetContextWindow`, `resolveRoleEndpoints` and
 *    `serveCompactionSettings` (including the flag > persisted > preset
 *    precedence and the one-sided/neither cases).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  COMPACTION_SUMMARY_PREFIX,
  compactionBudgets,
  compactionTriggerTokens,
  compactContext,
  compactionUnit,
  isCompactionSummary,
  selectCutPoint,
  selectCutPointTokens,
  type CompactionSettings,
} from "../src/compaction.ts";
import { resolveConfig, serveCompactionSettings } from "../src/config.ts";
import { SharedContext, type ChatMessage } from "../src/context.ts";
import { MockProvider, type Provider } from "../src/provider.ts";
import { createMessage, type Message } from "../src/protocol.ts";
import {
  presetContextWindow,
  resolveRoleEndpoints,
  type EndpointPreset,
  type RuntimeSettingsSnapshot,
} from "../src/runtime.ts";

const SUMMARY_TEXT = "## Goal\nShip the catalog.\n\n## Next Steps\n1. Merge";

/** A Provider that records every request and scripts the summarizer call. */
class RecordingProvider implements Provider {
  readonly requests: ChatMessage[][] = [];
  private readonly inner: MockProvider;

  constructor(inner: MockProvider = new MockProvider()) {
    this.inner = inner;
  }

  async chat(messages: ChatMessage[], responseKind = "message"): Promise<string> {
    this.requests.push(messages);
    if (responseKind === "compaction") return SUMMARY_TEXT;
    return this.inner.chat(messages, responseKind);
  }
}

function compactionRequestText(provider: RecordingProvider): string {
  const call = provider.requests.find((messages) =>
    messages.some((m) => m.content.includes("<conversation>")),
  );
  assert.ok(call, "expected exactly one summarization request");
  return call!.map((m) => m.content).join("\n");
}

/**
 * A transcript whose payloads carry tool-call-like evidence the way the
 * harness actually renders it: tool calls and tool results embedded inside
 * payload fields of structured envelopes, plus a user-side context event.
 */
function toolEvidenceTranscript(hugeDelegationPad = 0): Message[] {
  const task = createMessage(null, "user", "senior", "message", {
    text: "synthetic task",
  });
  const todoEvent = createMessage(null, "user", "senior", "message", {
    text: "Context events: todo_updated — [x] read compaction.ts",
  });
  const consult = createMessage(null, "senior", "junior", "consult", {
    task: "synthetic task",
    ask: "Inspect src/compaction.ts before proposing.",
    expect: "proposal",
  });
  const delegation = createMessage(null, "senior", "junior", "delegation", {
    work: `Read src/compaction.ts and summarize the cut-point algorithm. Tool calls so far: ${JSON.stringify(
      [
        { tool: "workspace_read_file", args: { path: "src/compaction.ts" } },
        { tool: "run_shell", args: { command: "node dist/selftest.js" } },
      ],
    )}. ${"w".repeat(hugeDelegationPad)}`,
    acceptance: "A proposal naming the cut function.",
    notes: "Tool results observed: " + JSON.stringify({ ok: true, bytes: 4200 }),
  });
  const proposal = createMessage(null, "junior", "senior", "proposal", {
    title: "Cut points",
    answer: `selectCutPoint walks back from the tail. Evidence: ${JSON.stringify({
      tool: "workspace_read_file",
      result: "export function selectCutPoint(",
    })}`,
  });
  const deliverable = createMessage(null, "junior", "senior", "deliverable", {
    result: "Summary of src/compaction.ts attached.",
    notes: `verification tool result: ${JSON.stringify({ exit: 0 })}`,
  });
  return [task, todoEvent, consult, delegation, proposal, deliverable];
}

function buildContext(events: Message[]): SharedContext {
  const ctx = new SharedContext(null);
  for (const event of events) ctx.append(event);
  return ctx;
}

// ---------------------------------------------------------------------------
// Guarantee 1: atomic cuts — every cut lands on an envelope boundary and the
// [[TASK]] head is never compacted away.
// ---------------------------------------------------------------------------

test("guarantee: cut-point selection never splits an envelope and never cuts the task head (chars)", () => {
  const events = toolEvidenceTranscript(3000);
  assert.ok(events[0]!.payload.text === "synthetic task");
  const total = events.reduce((sum, event) => sum + JSON.stringify(event.payload).length, 0);
  let cuts = 0;
  for (let budget = 1; budget <= total + 100; budget += 7) {
    const cut = selectCutPoint(events, budget);
    if (cut === undefined) continue;
    cuts++;
    // The task head is never inside the compacted prefix: the first kept
    // index is always after it, and the split (folded) envelope is never the
    // head either.
    assert.ok(
      cut.firstKeptIndex >= 1,
      `budget ${budget}: firstKeptIndex ${cut.firstKeptIndex} would cut the task head`,
    );
    assert.ok(cut.firstKeptIndex <= events.length);
    if (cut.splitIndex !== undefined) {
      // A split-payload cut folds ONE whole envelope into the summary: the
      // kept tail starts right after it — still whole envelopes only.
      assert.ok(cut.splitIndex >= 1, `budget ${budget}: split envelope is the task head`);
      assert.ok(cut.splitIndex <= events.length - 1);
      assert.equal(cut.firstKeptIndex, cut.splitIndex + 1);
    }
  }
  assert.ok(cuts > 10, "expected the budget sweep to produce many distinct cuts");
});

test("guarantee: cut-point selection never splits an envelope and never cuts the task head (tokens)", () => {
  const events = toolEvidenceTranscript(3000);
  const totalTokens = events.reduce(
    (sum, event) => sum + Math.ceil(JSON.stringify(event.payload).length / 4),
    0,
  );
  let cuts = 0;
  for (let budget = 1; budget <= totalTokens + 100; budget += 5) {
    const cut = selectCutPointTokens(events, budget);
    if (cut === undefined) continue;
    cuts++;
    assert.ok(cut.firstKeptIndex >= 1);
    assert.ok(cut.firstKeptIndex <= events.length);
    if (cut.splitIndex !== undefined) {
      assert.ok(cut.splitIndex >= 1);
      assert.equal(cut.firstKeptIndex, cut.splitIndex + 1);
    }
  }
  assert.ok(cuts > 10, "expected the token budget sweep to produce many distinct cuts");
});

/** First budget whose ordinary cut keeps nothing before `minFirstKept`. */
function findOrdinaryBudget(events: Message[], minFirstKept: number): number | undefined {
  for (let budget = 1; budget <= 5000; budget++) {
    const cut = selectCutPoint(events, budget);
    if (cut && cut.splitIndex === undefined && cut.firstKeptIndex >= minFirstKept) return budget;
  }
  return undefined;
}

test("guarantee: compactContext retains only whole envelopes and keeps the task head", async () => {
  const events = toolEvidenceTranscript();
  // Budget chosen so the cut lands at/after the delegation envelope: the
  // summarized prefix carries its tool-call evidence.
  const budget = findOrdinaryBudget(events, 4);
  assert.ok(budget, "fixture must admit an ordinary cut after the delegation");
  const settings: CompactionSettings = { force: true, keepRecentChars: budget };
  const expectedCut = selectCutPoint(events, budget);
  assert.ok(expectedCut);
  assert.equal(expectedCut.splitIndex, undefined);

  const ctx = buildContext(events);
  const provider = new RecordingProvider();
  assert.equal(await compactContext(ctx, provider, settings), true);
  const rebuilt = ctx.events;

  // [task head, summary event, kept tail…]
  assert.equal(rebuilt[0]!.payload.text, "synthetic task");
  assert.ok(isCompactionSummary(rebuilt[1]!));
  assert.ok(rebuilt.length >= 3);

  // The kept tail is a verbatim slice of the original envelopes — same ids,
  // same payloads, dense renumbered seq — never a partial envelope.
  const tail = rebuilt.slice(2);
  const cutIndex = events.length - tail.length;
  assert.equal(cutIndex, expectedCut.firstKeptIndex);
  assert.ok(cutIndex >= 1, "the task head is never in the compacted prefix");
  assert.deepEqual(
    tail.map((event) => event.id),
    events.slice(cutIndex).map((event) => event.id),
  );
  for (let i = 0; i < tail.length; i++) {
    assert.deepEqual(tail[i]!.payload, events[cutIndex + i]!.payload);
    assert.equal(tail[i]!.seq, i + 3);
  }

  // The summarizer saw the compacted prefix (including the tool-call evidence
  // payloads) under the explicit <conversation> framing.
  const request = compactionRequestText(provider);
  assert.match(request, /<conversation>/);
  assert.match(request, /workspace_read_file/);
  // The deliverable's verification result is in the kept tail for this cut,
  // so pin the delegation's embedded tool-results note instead.
  assert.match(request, /\\"ok\\":true,\\"bytes\\":4200/);
});

test("guarantee: an oversized boundary envelope is folded with an explicit truncation marker, not silently dropped", async () => {
  const hugePad = 6000;
  const events = toolEvidenceTranscript(hugePad);
  const hugeDelegation = events[3]!;
  assert.ok(JSON.stringify(hugeDelegation.payload).length > 4000);
  // A tail budget between "the recent envelopes" and "the huge delegation"
  // forces the boundary envelope to exceed it on its own → split-payload cut.
  const settings: CompactionSettings = { force: true, keepRecentChars: 1000 };
  const expectedCut = selectCutPoint(events, 1000);
  assert.ok(expectedCut, "fixture must be compactable at this budget");
  assert.equal(expectedCut.splitIndex, 3, "the huge delegation is the folded envelope");
  assert.equal(expectedCut.firstKeptIndex, 4);

  const ctx = buildContext(events);
  const provider = new RecordingProvider();
  assert.equal(await compactContext(ctx, provider, settings), true);
  const rebuilt = ctx.events;
  assert.ok(isCompactionSummary(rebuilt[1]!));

  // The kept tail starts AFTER the folded envelope: it is not verbatim in the
  // context, so a single huge delegation can never make the session
  // uncompactable.
  assert.equal(rebuilt[2]!.id, events[expectedCut.firstKeptIndex]!.id);
  assert.equal(rebuilt.length, 2 + (events.length - expectedCut.firstKeptIndex));

  // The summarizer request carries head + tail of the folded envelope with
  // the explicit middle marker — no silent drop.
  const request = compactionRequestText(provider);
  assert.match(request, /characters truncated from the middle of this envelope/);
  // Head of the delegation payload survives…
  assert.match(request, /Read src\/compaction\.ts and summarize/);
  // …and its tail (the tool-results note) survives past the marker.
  const markerIndex = request.indexOf("characters truncated from the middle of this envelope");
  const afterMarker = request.slice(markerIndex);
  assert.match(afterMarker, /Tool results observed/);
  // The envelopes after the fold stayed verbatim in the context — they are
  // NOT re-serialized into the summary request.
  assert.doesNotMatch(request, /selectCutPoint walks back from the tail/);
});

test("guarantee: the summary event is a byte-valid marked message envelope", async () => {
  const ctx = buildContext(toolEvidenceTranscript());
  const provider = new RecordingProvider();
  assert.equal(
    await compactContext(ctx, provider, { force: true, keepRecentChars: 400 }),
    true,
  );
  const summary = ctx.events[1]!;
  assert.equal(summary.from, "user");
  assert.equal(summary.kind, "message");
  assert.ok(String(summary.payload.text).startsWith(COMPACTION_SUMMARY_PREFIX));
});

// ---------------------------------------------------------------------------
// Guarantee 2: the effective window is the smaller of the two roles' preset
// windows (min semantics).
// ---------------------------------------------------------------------------

test("guarantee: presetContextWindow takes the smaller of the two roles' windows", () => {
  // The headline case: senior 1M + junior 200K ⇒ 200K.
  assert.equal(
    presetContextWindow({ senior: { contextWindow: 1_000_000 }, junior: { contextWindow: 200_000 } }),
    200_000,
  );
  assert.equal(
    presetContextWindow({ senior: { contextWindow: 200_000 }, junior: { contextWindow: 1_000_000 } }),
    200_000,
  );
  // One-sided cases: the single declared window wins.
  assert.equal(presetContextWindow({ senior: { contextWindow: 1_000_000 } }), 1_000_000);
  assert.equal(presetContextWindow({ junior: { contextWindow: 200_000 } }), 200_000);
  // Neither declares (env/manual-field connections): unknown == 0.
  assert.equal(presetContextWindow({}), 0);
  assert.equal(presetContextWindow(undefined), 0);
  assert.equal(presetContextWindow(null), 0);
  // Non-positive, non-integer and unsafe values are ignored like absent.
  assert.equal(
    presetContextWindow({
      senior: { contextWindow: 0 },
      junior: { contextWindow: -5 },
    }),
    0,
  );
  assert.equal(
    presetContextWindow({
      senior: { contextWindow: 1_000_000 },
      junior: { contextWindow: Number.NaN },
    }),
    1_000_000,
  );
});

function presetSnapshot(seniorRef: string, juniorRef: string): RuntimeSettingsSnapshot {
  const empty = { provider: "", model: "", base_url: "", api_key: "", provider_ref: "" };
  return {
    senior: { ...empty, provider_ref: seniorRef },
    junior: { ...empty, provider_ref: juniorRef },
  };
}

const BIG_PRESET: EndpointPreset = {
  name: "big",
  base_url: "http://big.example/v1",
  api_key: "big-key",
  context_window: 1_000_000,
};
const SMALL_PRESET: EndpointPreset = {
  name: "small",
  base_url: "http://small.example/v1",
  api_key: "small-key",
  context_window: 200_000,
};

test("guarantee: resolved role endpoints feed the min window exactly like the serve run path", () => {
  // Mirrors server.ts presetWindowForRun(): presetContextWindow(
  //   resolveRoleEndpoints(snapshot, resolvablePresets(), env, {})).
  const NO_ENV: NodeJS.ProcessEnv = {};
  // Both roles on presets: the smaller window wins.
  let endpoints = resolveRoleEndpoints(
    presetSnapshot("big", "small"),
    [BIG_PRESET, SMALL_PRESET],
    NO_ENV,
  );
  assert.equal(endpoints.senior.contextWindow, 1_000_000);
  assert.equal(endpoints.junior.contextWindow, 200_000);
  assert.equal(presetContextWindow(endpoints), 200_000);

  // Senior on a windowed preset, junior on manual fields (no preset window).
  endpoints = resolveRoleEndpoints(presetSnapshot("big", ""), [BIG_PRESET], NO_ENV);
  assert.equal(presetContextWindow(endpoints), 1_000_000);

  // Neither role on a preset: no preset window at all.
  endpoints = resolveRoleEndpoints(presetSnapshot("", ""), [BIG_PRESET], NO_ENV);
  assert.equal(presetContextWindow(endpoints), 0);
});

/** A config with every compaction knob explicitly zeroed (env-immune). */
function noCompactionConfig() {
  return resolveConfig({
    compact: false,
    compactThreshold: 0,
    compactKeepRecent: 0,
    compactThresholdTokens: 0,
    contextWindow: 0,
  });
}

test("guarantee: serveCompactionSettings derives the trigger from the smaller role window", () => {
  const cfg = noCompactionConfig();
  // The serve run path: serveCompactionSettings(cfg, persisted, undefined,
  // presetContextWindow(endpoints)) with senior 1M + junior 200K.
  const settings = serveCompactionSettings(cfg, undefined, undefined, 200_000);
  assert.ok(settings);
  assert.equal(settings.contextWindow, 200_000);
  // Token mode is active off the window, and the auto trigger is
  // window − reserveTokens (2000), never the larger role's window.
  assert.equal(compactionUnit(settings), "tokens");
  assert.equal(compactionTriggerTokens(settings), 200_000 - 2000);
  const budgets = compactionBudgets(settings);
  assert.equal(budgets.unit, "tokens");
  assert.ok(budgets.keepRecent <= Math.floor((200_000 - 2000) / 2));
  assert.ok(budgets.summaryCap <= Math.floor((200_000 - 2000) / 4));
});

test("guarantee: preset window is the last resort — persisted and flag windows win", () => {
  // Persisted compaction.context_window beats the preset fallback.
  let settings = serveCompactionSettings(
    noCompactionConfig(),
    { context_window: 300_000 },
    undefined,
    200_000,
  );
  assert.equal(settings?.contextWindow, 300_000);

  // A run-level flag/env window beats both.
  const flagged = resolveConfig({ contextWindow: 500_000 });
  settings = serveCompactionSettings(
    flagged,
    { context_window: 300_000 },
    undefined,
    200_000,
  );
  assert.equal(settings?.contextWindow, 500_000);

  // No trigger anywhere (no flag, no persisted section, no preset window):
  // serve runs keep byte-identical harness options — compaction stays off.
  assert.equal(serveCompactionSettings(noCompactionConfig(), undefined, undefined, 0), undefined);
});
