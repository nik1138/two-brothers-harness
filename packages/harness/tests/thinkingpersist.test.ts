/**
 * Persisted reasoning replay — backend half (Wave 7 lane 1).
 *
 * Thinking/reasoning deltas are observational and live-only today: the harness
 * streams them as `token` stream events (`kind: "thinking"`), which the run
 * record and the runtime sidecar never see. This suite pins the additive
 * persistence path: when token streaming is active, each provider call that
 * actually produced thinking deltas emits exactly ONE bounded, sanitized
 * `reasoning` RuntimeEvent, so `RunManager`'s sidecar persister writes it to
 * `sessions/runtime/*.events.jsonl` automatically and a web reload can replay
 * it.
 *
 * Pinned here:
 * - one event per provider call, in call order, carrying role + node kind;
 * - the real `RunManager` + `RuntimeEventStore` round trip, interleaved with
 *   the run's `envelope` events (the sidecar replays the run in order);
 * - bounds (`REASONING_EVENT_MAX_CHARS`, head+tail marker, `truncated: true`)
 *   and ANSI/control sanitization — while the live `token` stream keeps its
 *   raw deltas unchanged (observational);
 * - no event when the call produced no thinking deltas;
 * - streaming-only limitation: no streaming/no consumer means no ChatOptions,
 *   so the provider contract hands back no reasoning text and nothing is
 *   persisted;
 * - tool-loop rounds each get their own record;
 * - no protocol envelope/session-JSONL change: reasoning never enters the
 *   transcript, the decision or the session file.
 *
 * Hermetic: scripted providers, temp dirs, no network.
 *
 * Run with: node tests/run-all.ts (or node --test tests/)
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { resolveConfig } from "../src/config.ts";
import { SharedContext, type ChatMessage, type ToolCall } from "../src/context.ts";
import { TwoBrothersHarness } from "../src/harness.ts";
import {
  type ChatOptions,
  type Provider,
  type Tool,
  type ToolChatOptions,
  type ToolChatResponse,
} from "../src/provider.ts";
import {
  REASONING_EVENT_MAX_CHARS,
  RuntimeEventStore,
  type ReasoningEvent,
  type RuntimeEvent,
} from "../src/runevents.ts";
import { RunManager, type RunJob } from "../src/runtime.ts";
import type { StreamEvent, TokenStreamEvent } from "../src/runstream.ts";
import { SessionStore } from "../src/session.ts";

const cfg = (extra: Record<string, unknown> = {}) =>
  resolveConfig({ provider: "mock", mode: "consult", ...extra });

// ---------------------------------------------------------------------------
// scripted provider: emits thinking deltas through the real ChatOptions sink
// ---------------------------------------------------------------------------

/** The strict-valid baseline reply for every kind a consult-mode node asks for. */
const VALID: Record<string, Record<string, unknown>> = {
  consult: { task: "t", ask: "a", expect: "proposal", deadline_hint: "today" },
  proposal: { title: "P", answer: "A", rationale: "R", risks: [], confidence: 0.7, asks: [] },
  review: { verdict: "accept", notes: "", points: [] },
  decision: { decision: "D", rationale: "", confidence: 0.7, dissent: null, accepted_proposals: [] },
};

function validReply(kind: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...VALID[kind], ...extra });
}

/** One scripted `chatWithTools` round: tool calls and/or final text. */
interface ToolRound {
  toolCalls?: ToolCall[];
  text?: string;
}

interface ScriptedCall {
  channel: "chat" | "tools";
  kind: string;
  /** True when the harness handed the call streaming ChatOptions. */
  streaming: boolean;
}

/**
 * A provider that records every call and emits scripted thinking chunks
 * through `ChatOptions.onThinkingDelta` (the exact harness capture seam).
 * `thinking(role, kind, round)` returns the chunks for one call, or null for a
 * call that produces no reasoning text. Bump `round` is per provider call (so
 * tool loops can vary their reasoning per round).
 */
class ThinkingProvider implements Provider {
  readonly role: "senior" | "junior";
  readonly calls: ScriptedCall[] = [];
  private readonly thinking: (
    role: "senior" | "junior",
    kind: string,
    round: number,
  ) => string[] | null;
  private readonly toolRounds: Record<string, ToolRound[]>;
  private round = 0;

  constructor(
    role: "senior" | "junior",
    spec: {
      thinking?: (role: "senior" | "junior", kind: string, round: number) => string[] | null;
      toolRounds?: Record<string, ToolRound[]>;
    } = {},
  ) {
    this.role = role;
    this.thinking = spec.thinking ?? (() => null);
    this.toolRounds = Object.fromEntries(
      Object.entries(spec.toolRounds ?? {}).map(([kind, rounds]) => [kind, [...rounds]]),
    );
  }

  private emit(kind: string, options: ChatOptions | undefined): void {
    const chunks = this.thinking(this.role, kind, this.round++);
    if (chunks === null) return;
    for (const delta of chunks) options?.onThinkingDelta?.(delta);
  }

  async chat(messages: ChatMessage[], responseKind = "message", _signal?: AbortSignal, options?: ChatOptions): Promise<string> {
    this.calls.push({ channel: "chat", kind: responseKind, streaming: options !== undefined });
    this.emit(responseKind, options);
    return validReply(responseKind);
  }

  async chatWithTools(
    _messages: ChatMessage[],
    _tools: Tool[],
    options: ToolChatOptions = {},
  ): Promise<ToolChatResponse> {
    const kind = options.responseKind ?? "deliverable";
    this.calls.push({ channel: "tools", kind, streaming: options.onThinkingDelta !== undefined });
    this.emit(kind, options);
    const rounds = this.toolRounds[kind];
    const round = rounds?.shift();
    if (round === undefined) return { content: validReply(kind), toolCalls: [] };
    return { content: round.text ?? "", toolCalls: round.toolCalls ?? [] };
  }
}

function reasoningOf(events: readonly RuntimeEvent[]): ReasoningEvent[] {
  return events.filter((event): event is ReasoningEvent => event.type === "reasoning");
}

function tokenEvents(events: readonly StreamEvent[]): TokenStreamEvent[] {
  return events.filter((event): event is TokenStreamEvent => event.type === "token");
}

const READ_TOOL: Tool = {
  name: "workspace_read_file",
  description: "Read a file from the workspace.",
  parameters: { type: "object", properties: {} },
  execute: () =>
    JSON.stringify({ tool: "workspace_read_file", status: "ok", path: "notes.txt", content: "hi" }),
};

/** A consult-mode harness whose providers emit one scripted thinking chunk per call. */
function reasoningHarness(options: {
  streamTokens?: boolean;
  withStreamConsumer?: boolean;
  thinking?: (role: "senior" | "junior", kind: string, round: number) => string[] | null;
  senior?: Provider;
  junior?: Provider;
  toolScopes?: { senior?: Tool[] };
}) {
  const runtimeEvents: RuntimeEvent[] = [];
  const streamEvents: StreamEvent[] = [];
  // Streaming (and therefore the capture seam) is on unless a test opts out.
  const streamTokens = options.streamTokens !== false;
  const harness = new TwoBrothersHarness(cfg(), {
    senior:
      options.senior ??
      new ThinkingProvider("senior", {
        thinking:
          options.thinking ??
          ((role, kind) => [`Reasoning for the ${kind} call by the ${role}.`]),
      }),
    junior:
      options.junior ??
      new ThinkingProvider("junior", {
        thinking:
          options.thinking ??
          ((role, kind) => [`Reasoning for the ${kind} call by the ${role}.`]),
      }),
    ...(streamTokens ? { streamTokens: true } : {}),
    ...(options.withStreamConsumer !== false
      ? { onStreamEvent: (event: StreamEvent) => streamEvents.push(event) }
      : {}),
    onEvent: (event) => runtimeEvents.push(event),
    ...(options.toolScopes !== undefined ? { toolScopes: options.toolScopes } : {}),
  });
  return { harness, runtimeEvents, streamEvents };
}

// ---------------------------------------------------------------------------
// (i) RunManager + RuntimeEventStore round trip: one record per provider call
// ---------------------------------------------------------------------------

test("one bounded reasoning event per provider call lands in the run sidecar, in run order", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tb-reasoning-sidecar-"));
  try {
    const sessionFile = path.join(tmp, "reasoning-session.jsonl");
    const store = new SessionStore(sessionFile);
    const ctx = new SharedContext(store);
    const sidecar = new RuntimeEventStore(path.join(tmp, "runtime"));
    const manager = new RunManager({ persist: sidecar.asPersist() });
    const tokens: TokenStreamEvent[] = [];

    const job: RunJob = async (signal, onEnvelope) => {
      const harness = new TwoBrothersHarness(cfg(), {
        senior: new ThinkingProvider("senior", {
          thinking: (role, kind) => [`Reasoning for the ${kind} call by the ${role}.`],
        }),
        junior: new ThinkingProvider("junior", {
          thinking: (role, kind) => [`Reasoning for the ${kind} call by the ${role}.`],
        }),
        signal,
        streamTokens: true,
        // A consumer is what activates token streaming (and the capture seam).
        onStreamEvent: (event) => {
          if (event.type === "token") tokens.push(event);
        },
        onEvent: (event) => onEnvelope(event),
        // Envelopes use the same manager hook (the server's wiring).
        onEnvelope: (message) => onEnvelope(message),
      });
      const result = await harness.run("persist the reasoning", ctx);
      return {
        cancelled: result.cancelled,
        decision: result.decision,
        errors: result.errors,
        usage: result.usage,
      };
    };

    const record = manager.submit("persist the reasoning", "reasoning-session.jsonl", job, "consult", {
      streamTokens: true,
    });
    assert.equal(await manager.wait(record.runId), true);
    assert.equal(record.status, "completed");

    // -- the persisted sidecar carries exactly one event per provider call ----
    const persisted = sidecar.load("reasoning-session.jsonl");
    const persistedReasoning = persisted.filter(
      (event) => event.type === "reasoning",
    ) as unknown as ReasoningEvent[];
    assert.equal(persistedReasoning.length, 4, "consult run: one record per provider call");
    assert.deepEqual(
      persistedReasoning.map((event) => `${event.role}/${event.kind}`),
      ["senior/consult", "junior/proposal", "senior/review", "senior/decision"],
      "records follow the call order and name the node kind",
    );
    assert.deepEqual(
      persistedReasoning.map((event) => event.text),
      [
        "Reasoning for the consult call by the senior.",
        "Reasoning for the proposal call by the junior.",
        "Reasoning for the review call by the senior.",
        "Reasoning for the decision call by the senior.",
      ],
      "the text is exactly the thinking the stream carried",
    );
    for (const event of persistedReasoning) {
      assert.deepEqual(Object.keys(event).sort(), [
        "at",
        "kind",
        "role",
        "run_id",
        "text",
        "truncated",
        "type",
      ]);
      assert.equal(event.run_id, record.runId, "the manager stamps the owning run");
      assert.equal(typeof event.at, "number");
      assert.equal(event.truncated, false);
    }

    // -- the reasoning record is interleaved with the run's envelopes ---------
    const order = persisted
      .filter((event) => event.type === "reasoning" || event.type === "envelope")
      .map((event) => {
        if (event.type === "reasoning") return `reasoning:${String(event.kind)}`;
        const envelope = event.envelope as { kind?: string } | undefined;
        return `envelope:${String(envelope?.kind ?? "")}`;
      });
    assert.deepEqual(order, [
      "envelope:message",
      "reasoning:consult",
      "envelope:consult",
      "reasoning:proposal",
      "envelope:proposal",
      "reasoning:review",
      "envelope:review",
      "reasoning:decision",
      "envelope:decision",
    ]);

    // -- the live token stream is unchanged (raw, observational) -------------
    assert.ok(tokens.length > 0, "the live thinking stream still ran");
    assert.ok(tokens.every((event) => event.kind === "thinking"));
    assert.equal(
      tokens.map((event) => event.delta).join(""),
      persistedReasoning.map((event) => event.text).join(""),
      "the persisted record is the same text the live stream delivered",
    );

    // -- no protocol/session-JSONL change ------------------------------------
    const sessionLines = fs
      .readFileSync(sessionFile, "utf-8")
      .split(/\r?\n/)
      .filter((line) => line.trim());
    assert.equal(sessionLines.length, ctx.events.length);
    assert.deepEqual(
      sessionLines.map((line) => (JSON.parse(line) as { kind: string }).kind),
      ["message", "consult", "proposal", "review", "decision"],
      "the session file stays envelope-only",
    );
    for (const line of sessionLines) {
      assert.equal("type" in (JSON.parse(line) as Record<string, unknown>), false);
      assert.ok(!line.includes("Reasoning for"), "reasoning text never enters the session JSONL");
    }
    assert.ok(!JSON.stringify(record.decision).includes("Reasoning for"));

    // -- the in-memory record saw the same events ----------------------------
    assert.equal(reasoningOf(record.events).length, 4);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (ii) bounds + sanitization; the live stream stays raw
// ---------------------------------------------------------------------------

test("reasoning text is sanitized and bounded; the live token deltas stay raw", async () => {
  const ansiThinking = ["\x1b[31mred\x1b[0m", " \x07plan\x00 ok\n"];
  const poisoned = reasoningHarness({ thinking: () => ansiThinking });
  const result = await poisoned.harness.run("sanitize my reasoning");

  const events = reasoningOf(poisoned.runtimeEvents);
  assert.equal(events.length, 4);
  assert.equal(events[0].text, "red plan ok\n", "ANSI escapes and control bytes are stripped");
  assert.ok(!events[0].text.includes("\x1b"));
  assert.ok(!events[0].text.includes("\x00") && !events[0].text.includes("\x07"));
  assert.equal(events[0].truncated, false);

  // Additive/observational: the live token stream keeps the raw deltas.
  const tokens = tokenEvents(poisoned.streamEvents);
  assert.ok(tokens.some((event) => event.delta.includes("\x1b[31m")));
  assert.ok(tokens.some((event) => event.delta.includes("\x07")));
  assert.equal(
    tokens.map((event) => event.delta).join(""),
    // the same raw chunks were streamed by all four provider calls
    ansiThinking.join("").repeat(4),
  );

  // The bounded record never leaks into the transcript/decision.
  assert.ok(!JSON.stringify(result.messages).includes("red plan"));
  assert.ok(!JSON.stringify(result.decision).includes("red plan"));

  // -- oversized reasoning is clipped head+tail with the shared marker ------
  const huge = "x".repeat(25_000);
  const clipped = reasoningHarness({ thinking: () => [huge] });
  await clipped.harness.run("bound my reasoning");
  const bounded = reasoningOf(clipped.runtimeEvents)[0]!;
  assert.equal(bounded.truncated, true);
  assert.ok(bounded.text.length <= REASONING_EVENT_MAX_CHARS + 64, `bounded length ${bounded.text.length}`);
  assert.ok(bounded.text.length >= REASONING_EVENT_MAX_CHARS);
  assert.match(bounded.text, /\.\.\.\[truncated 15000 chars\]\.\.\./);
  assert.ok(bounded.text.startsWith("x".repeat(100)));
  assert.ok(bounded.text.endsWith("x".repeat(100)));
  assert.ok(bounded.text.length < huge.length, "the full reasoning is not persisted");
});

// ---------------------------------------------------------------------------
// (iii) one event per call: multiple deltas collapse into one record
// ---------------------------------------------------------------------------

test("multiple thinking deltas in one call collapse into exactly one record", async () => {
  const { harness, runtimeEvents } = reasoningHarness({
    thinking: (role, kind) =>
      role === "senior" && kind === "consult"
        ? ["Think", "ing ", "piece", " by piece."]
        : null,
  });
  await harness.run("collapse my deltas");

  const events = reasoningOf(runtimeEvents);
  assert.equal(events.length, 1, "one record for the only call that reasoned");
  assert.equal(events[0].role, "senior");
  assert.equal(events[0].kind, "consult");
  assert.equal(events[0].text, "Thinking piece by piece.");
});

// ---------------------------------------------------------------------------
// (iv) no thinking deltas => no record
// ---------------------------------------------------------------------------

test("a streaming call that produced no thinking emits no reasoning record", async () => {
  const { harness, runtimeEvents } = reasoningHarness({ thinking: () => null });
  const result = await harness.run("no reasoning here");

  assert.deepEqual(result.errors, []);
  assert.equal(reasoningOf(runtimeEvents).length, 0);
  // The sink WAS active: these calls were streaming, they simply had no
  // thinking deltas — absence of a record is not the streaming gate.
  const providers = [
    ...(harness.providers.senior as ThinkingProvider).calls,
    ...(harness.providers.junior as ThinkingProvider).calls,
  ];
  assert.equal(providers.length, 4);
  assert.ok(providers.every((call) => call.streaming));
});

// ---------------------------------------------------------------------------
// (v) streaming-only limitation: no ChatOptions, no reasoning text, no record
// ---------------------------------------------------------------------------

test("without streaming the provider is never asked for reasoning, so nothing is persisted", async () => {
  // (a) token streaming not requested at all.
  const plain = reasoningHarness({ streamTokens: false, thinking: () => ["should never be seen"] });
  await plain.harness.run("non-streaming run");
  assert.equal(reasoningOf(plain.runtimeEvents).length, 0, "no streaming => no reasoning record");
  const plainProviders = [
    ...(plain.harness.providers.senior as ThinkingProvider).calls,
    ...(plain.harness.providers.junior as ThinkingProvider).calls,
  ];
  assert.ok(
    plainProviders.every((call) => !call.streaming),
    "the provider gets the plain non-streaming call (the state it is handed is undefined)",
  );

  // (b) token streaming requested but no stream consumer: the harness keeps the
  //     pre-streaming call path, so again no reasoning text can exist.
  const noConsumer = reasoningHarness({
    streamTokens: true,
    withStreamConsumer: false,
    thinking: () => ["should never be seen"],
  });
  await noConsumer.harness.run("no consumer run");
  assert.equal(
    reasoningOf(noConsumer.runtimeEvents).length,
    0,
    "no consumer => no ChatOptions => no reasoning record",
  );
  const noConsumerProviders = [
    ...(noConsumer.harness.providers.senior as ThinkingProvider).calls,
    ...(noConsumer.harness.providers.junior as ThinkingProvider).calls,
  ];
  assert.ok(noConsumerProviders.every((call) => !call.streaming));
});

// ---------------------------------------------------------------------------
// (vi) tool-loop rounds get their own record each
// ---------------------------------------------------------------------------

test("every tool-loop round gets its own reasoning record (one per provider call)", async () => {
  const senior = new ThinkingProvider("senior", {
    thinking: (role, kind, round) => [`${role} ${kind} round ${round}.`],
    toolRounds: {
      consult: [
        { toolCalls: [{ id: "c1", name: "workspace_read_file", args: { path: "notes.txt" } }] },
        { text: validReply("consult", { ask: "after the tool round" }) },
      ],
    },
  });
  const junior = new ThinkingProvider("junior", {
    thinking: (role, kind, round) => [`${role} ${kind} round ${round}.`],
  });
  const { harness, runtimeEvents } = reasoningHarness({
    senior,
    junior,
    toolScopes: { senior: [READ_TOOL] },
  });
  const result = await harness.run("reason through tools");

  const events = reasoningOf(runtimeEvents);
  assert.deepEqual(
    events.map((event) => `${event.role}/${event.kind}`),
    [
      "senior/consult", // tool round
      "senior/consult", // answer after the tool result
      "junior/proposal",
      "senior/review",
      "senior/decision",
    ],
    "each provider call has exactly one record — the tool loop's two rounds count twice",
  );
  assert.deepEqual(
    events.map((event) => event.text),
    [
      "senior consult round 0.",
      "senior consult round 1.",
      "junior proposal round 0.",
      "senior review round 2.",
      "senior decision round 3.",
    ],
    "the record holds that call's deltas only (per-call buffer reset)",
  );
  assert.equal(
    result.messages.find((message) => message.kind === "consult")?.payload.ask,
    "after the tool round",
  );
});

// ---------------------------------------------------------------------------
// (vii) durability: a second run appends its own records, old ones replay
// ---------------------------------------------------------------------------

test("reasoning records accumulate per run in the sidecar and replay after a restart", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tb-reasoning-restart-"));
  try {
    const sidecarDir = path.join(tmp, "runtime");
    const session = "restart-session.jsonl";
    const runOnce = async (manager: RunManager, task: string, text: string) => {
      const job: RunJob = async (signal, onEnvelope) => {
        const harness = new TwoBrothersHarness(cfg(), {
          senior: new ThinkingProvider("senior", { thinking: (role, kind) => [`${text} ${role} ${kind}.`] }),
          junior: new ThinkingProvider("junior", { thinking: (role, kind) => [`${text} ${role} ${kind}.`] }),
          signal,
          streamTokens: true,
          onStreamEvent: () => undefined,
          onEvent: (event) => onEnvelope(event),
        });
        const result = await harness.run(task);
        return { cancelled: result.cancelled, decision: result.decision, errors: result.errors, usage: result.usage };
      };
      const record = manager.submit(task, session, job, "consult", { streamTokens: true });
      assert.equal(await manager.wait(record.runId), true);
      assert.equal(record.status, "completed");
      return record;
    };

    const firstManager = new RunManager({ persist: new RuntimeEventStore(sidecarDir).asPersist() });
    const first = await runOnce(firstManager, "first reasoning run", "first");
    const secondManager = new RunManager({ persist: new RuntimeEventStore(sidecarDir).asPersist() });
    const second = await runOnce(secondManager, "second reasoning run", "second");

    // A fresh store instance (the backend restart path) replays both runs.
    const persisted = new RuntimeEventStore(sidecarDir).load(session);
    const reasoning = persisted.filter((event) => event.type === "reasoning") as unknown as ReasoningEvent[];
    assert.equal(reasoning.length, 8, "two runs x four calls each");
    assert.deepEqual(
      reasoning.filter((event) => event.run_id === first.runId).map((event) => event.kind),
      ["consult", "proposal", "review", "decision"],
    );
    assert.deepEqual(
      reasoning.filter((event) => event.run_id === second.runId).map((event) => event.kind),
      ["consult", "proposal", "review", "decision"],
    );
    assert.ok(reasoning.some((event) => event.text.startsWith("first")));
    assert.ok(reasoning.some((event) => event.text.startsWith("second")));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
