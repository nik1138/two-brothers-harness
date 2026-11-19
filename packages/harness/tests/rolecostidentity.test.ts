/**
 * Per-role model identity on run records/`run_end` and the derived per-role
 * cost (`feat/role-cost-surfaces`, additive).
 *
 * The split (`usage_by_role`) already carried each role's family-normalized
 * counters. This suite pins the additive identity that lets a surface price a
 * half: `model`/`family` on each measured half at the harness attribution seam,
 * carried through `run_end`/`RunRecord.public()` and the sidecar rebuild, plus
 * the record's derived `cost_by_role` (priced from that identity with the one
 * shared `cost.ts` rule). Honest absence is part of the contract: mock and
 * untracked providers, blank models, unpriced models and old sidecars never
 * gain a guessed identity or a fabricated `$0`.
 *
 * Hermetic: mock/metered providers, temp dirs, ephemeral loopback ports.
 * Run with: node --test tests/rolecostidentity.test.ts
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { resolveConfig, type Config } from "../src/config.ts";
import { estimateRoleCostsFromSplit } from "../src/cost.ts";
import type { ChatMessage } from "../src/context.ts";
import { TwoBrothersHarness } from "../src/harness.ts";
import {
  MockProvider,
  UsageTracker,
  type Provider,
  type Tool,
  type ToolChatOptions,
  type ToolChatResponse,
  type UsageTotals,
} from "../src/provider.ts";
import {
  normalizeUsageByRole,
  RunManager,
  type RunJob,
  type RunJobResult,
} from "../src/runtime.ts";
import type { RunEndEvent } from "../src/runevents.ts";
import { createServer, type ServerOptions } from "../src/server.ts";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(cond: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

function tmpdir(prefix: string): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** A mock-backed provider that tracks usage, so the split has real counters. */
function meteredProvider(
  input: number,
  output: number,
  cached: number,
  cacheWrite: number,
): Provider & { usageSnapshot(): UsageTotals } {
  const inner = new MockProvider();
  const tracker = new UsageTracker();
  const record = (): void => tracker.record(input, output, cached, cacheWrite);
  return {
    async chat(messages: ChatMessage[], responseKind?: string, _signal?: AbortSignal) {
      record();
      return inner.chat(messages, responseKind);
    },
    async chatWithTools(messages: ChatMessage[], tools: Tool[], options?: ToolChatOptions) {
      record();
      return inner.chatWithTools(messages, tools, options) as Promise<ToolChatResponse>;
    },
    usageSnapshot: () => tracker.snapshot(),
  };
}

/** A provider that tracks NO usage (an embedder-supplied provider). */
class UntrackedProvider implements Provider {
  private readonly delegate = new MockProvider();

  async chat(messages: ChatMessage[], responseKind = "message"): Promise<string> {
    return this.delegate.chat(messages, responseKind);
  }

  async chatWithTools(
    messages: ChatMessage[],
    tools: Tool[],
    options: ToolChatOptions = {},
  ): Promise<ToolChatResponse> {
    if (this.delegate.chatWithTools === undefined) return { content: "", toolCalls: [] };
    return this.delegate.chatWithTools(messages, tools, options);
  }
}

/** A real-provider config that never reaches the network (overrides are used). */
function openaiConfig(extra: Record<string, unknown> = {}): () => Config {
  return () =>
    resolveConfig({
      provider: "openai",
      mode: "consult",
      baseUrl: "http://stub.invalid/v1",
      apiKey: "test-key",
      seniorModel: "gpt-4o",
      juniorModel: "deepseek-chat",
      ...extra,
    });
}

function lastEvent(events: readonly { type: string }[], type: string): Record<string, any> {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as Record<string, any>;
    if (event.type === type) return event;
  }
  throw new Error(`no ${type} event`);
}

async function api(
  base: string,
  method: string,
  route: string,
): Promise<{ status: number; body: Record<string, any> }> {
  const res = await fetch(base + route, { method });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

async function waitTerminal(
  base: string,
  runId: string,
  timeoutMs = 10000,
): Promise<Record<string, any>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const record = await api(base, "GET", `/api/runs/${runId}`);
    if (record.status === 200 && ["completed", "failed", "cancelled"].includes(record.body.status)) {
      return record.body;
    }
    if (Date.now() > deadline) throw new Error("timed out waiting for a terminal run");
    await sleep(10);
  }
}

/** Write the flat runtime sidecar `sessionsDir/runtime/<session>.events.jsonl`. */
function writeSidecar(
  sessionsDir: string,
  session: string,
  events: Array<Record<string, unknown>>,
): void {
  const dir = path.join(sessionsDir, "runtime");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${session}.events.jsonl`),
    events.map((event) => `${JSON.stringify(event)}\n`).join(""),
    "utf-8",
  );
}

// ---------------------------------------------------------------------------
// harness: identity attribution at the usage seam
// ---------------------------------------------------------------------------

test("harness attaches each measured half's own model identity", async () => {
  const harness = new TwoBrothersHarness(openaiConfig()(), {
    senior: meteredProvider(100, 20, 40, 5),
    junior: meteredProvider(30, 6, 0, 0),
  });
  const result = await harness.run("attribute the identity");
  const split = result.usageByRole;
  assert.ok(split, "a measured run must carry the split");

  // Identity is the role's effective model id, not the other role's.
  assert.equal(split.senior.model, "gpt-4o");
  assert.equal(split.junior.model, "deepseek-chat");
  // The family is the wire family that produced the counters.
  assert.equal(split.senior.family, "openai-compatible");
  assert.equal(split.junior.family, "openai-compatible");
  // The counters are unchanged by the additive identity.
  assert.equal(split.senior.model_calls, 3);
  assert.equal(split.junior.model_calls, 1);
  assert.equal(split.senior.input_tokens, 300);
  assert.equal(split.junior.input_tokens, 30);
});

test("harness reports each role's own family on a mixed-family run", async () => {
  const harness = new TwoBrothersHarness(
    openaiConfig({
      seniorModel: "claude-sonnet-4",
      juniorModel: "gemini-2.5-flash",
      seniorKind: "anthropic",
      juniorKind: "google",
    })(),
    {
      senior: meteredProvider(10, 2, 0, 0),
      junior: meteredProvider(10, 2, 0, 0),
    },
  );
  const result = await harness.run("mixed families");
  assert.ok(result.usageByRole);
  assert.equal(result.usageByRole.senior.model, "claude-sonnet-4");
  assert.equal(result.usageByRole.senior.family, "anthropic");
  assert.equal(result.usageByRole.junior.model, "gemini-2.5-flash");
  assert.equal(result.usageByRole.junior.family, "google");
});

test("mock and untracked providers report no identity", async () => {
  const mock = new TwoBrothersHarness(resolveConfig({ provider: "mock", mode: "consult" }));
  const mockResult = await mock.run("mock identity");
  assert.ok(mockResult.usageByRole, "the mock provider tracks usage, so the split exists");
  // ...but a mock model is not a purchasable identity: never invented.
  assert.equal("model" in mockResult.usageByRole.senior, false);
  assert.equal("family" in mockResult.usageByRole.senior, false);
  assert.equal("model" in mockResult.usageByRole.junior, false);

  const untracked = new TwoBrothersHarness(openaiConfig()(), {
    senior: new UntrackedProvider(),
    junior: new UntrackedProvider(),
  });
  const untrackedResult = await untracked.run("untracked identity");
  // No measured call means no split at all — nothing to identify.
  assert.equal(untrackedResult.usageByRole, undefined);
});

test("a measured half with no configured model stays identity-free", async () => {
  const cfg = openaiConfig({ seniorModel: "", juniorModel: "deepseek-chat" })();
  const harness = new TwoBrothersHarness(cfg, {
    senior: meteredProvider(10, 2, 0, 0),
    junior: meteredProvider(10, 2, 0, 0),
  });
  const result = await harness.run("blank senior model");
  assert.ok(result.usageByRole);
  assert.equal(result.usageByRole.senior.model_calls, 3, "the senior did answer calls");
  assert.equal("model" in result.usageByRole.senior, false, "a blank model is never guessed");
  assert.equal(result.usageByRole.junior.model, "deepseek-chat");
});

// ---------------------------------------------------------------------------
// pure identity carry + per-role cost rule
// ---------------------------------------------------------------------------

test("normalizeUsageByRole carries identity tolerantly and never invents one", () => {
  const split = normalizeUsageByRole({
    senior: {
      model_calls: 1,
      input_tokens: 9,
      model: "  gpt-4o  ",
      family: "anthropic",
    },
    junior: { model_calls: 1, model: "   ", family: "bogus" },
  });
  assert.ok(split);
  assert.equal(split.senior.model, "gpt-4o", "the identity is trimmed, not re-derived");
  assert.equal(split.senior.family, "anthropic");
  assert.equal(split.senior.input_tokens, 9);
  assert.equal("model" in split.junior, false, "a blank model is omitted");
  assert.equal("family" in split.junior, false, "an unknown family is omitted");
  // Old records without identity still normalize to plain counters.
  const old = normalizeUsageByRole({ senior: { model_calls: 2, input_tokens: 5 } });
  assert.ok(old);
  assert.equal("model" in old.senior, false);
  assert.equal("family" in old.senior, false);
});

test("estimateRoleCostsFromSplit prices each half from its own identity", () => {
  const priced = estimateRoleCostsFromSplit({
    senior: {
      model_calls: 1,
      input_tokens: 1_000_000,
      output_tokens: 0,
      model: "gpt-4o",
      family: "openai-compatible",
    },
    junior: {
      model_calls: 1,
      input_tokens: 0,
      output_tokens: 0,
      model: "deepseek-chat",
      family: "openai-compatible",
    },
  });
  assert.ok(priced);
  assert.equal(priced.senior?.model, "gpt-4o");
  assert.equal(priced.senior?.totalCost, 2.5, "1M gpt-4o input tokens");
  assert.equal(priced.junior?.model, "deepseek-chat");
  assert.equal(priced.junior?.totalCost, 0, "zero counters on a priced model are an honest $0");

  // An unpriced half stays null while the other half is still priced.
  const mixed = estimateRoleCostsFromSplit({
    senior: { model_calls: 1, input_tokens: 10, model: "gpt-4o" },
    junior: { model_calls: 1, input_tokens: 10, model: "e2e-junior" },
  });
  assert.ok(mixed);
  assert.ok(mixed.senior !== null);
  assert.equal(mixed.junior, null, "an unknown model is never $0");

  // Nothing priced → null (the caller omits the field instead of a pair of nulls).
  assert.equal(
    estimateRoleCostsFromSplit({
      senior: { model_calls: 1, input_tokens: 10, model: "e2e-senior" },
      junior: { model_calls: 1, input_tokens: 10 },
    }),
    null,
  );
  // A role that measured no call is never priced.
  assert.equal(
    estimateRoleCostsFromSplit({
      senior: { model_calls: 0, input_tokens: 0, model: "gpt-4o" },
      junior: { model_calls: 0, input_tokens: 0, model: "gpt-4o" },
    }),
    null,
  );
  // An unresolved family prices only cache-free counters.
  assert.equal(
    estimateRoleCostsFromSplit({
      senior: { model_calls: 1, input_tokens: 10, cached_tokens: 5, model: "gpt-4o" },
    }),
    null,
    "cache tokens with an unresolved family are ambiguous, not $0",
  );
  assert.ok(
    estimateRoleCostsFromSplit({
      senior: { model_calls: 1, input_tokens: 10, model: "gpt-4o" },
    })?.senior !== null,
    "cache-free counters still price without a family",
  );
});

test("estimateRoleCostsFromSplit tolerates an absent split and a half that measured nothing", () => {
  // Old records and jobs without a split carry no `usage_by_role` at all: the
  // shared rule answers `null` (the caller omits `cost_by_role`) instead of
  // throwing or inventing a pair of nulls.
  assert.equal(estimateRoleCostsFromSplit(null), null);
  assert.equal(estimateRoleCostsFromSplit(undefined), null);

  // An explicitly absent half is skipped, the measured half is still priced.
  const oneHalf = estimateRoleCostsFromSplit({
    senior: null,
    junior: {
      model_calls: 1,
      input_tokens: 1_000_000,
      output_tokens: 0,
      model: "gpt-4o",
      family: "openai-compatible",
    },
  });
  assert.ok(oneHalf);
  assert.equal(oneHalf.senior, null, "an absent half is never priced");
  assert.equal(oneHalf.junior?.totalCost, 2.5);

  // `model_calls` decides whether a half measured anything: absent, zero, a
  // negative or a sub-one count is "no call", so a configured model with no
  // call never becomes a fabricated $0.
  for (const model_calls of [undefined, 0, -2, 0.4]) {
    assert.equal(
      estimateRoleCostsFromSplit({
        senior: { model_calls, input_tokens: 1_000_000, model: "gpt-4o" },
      }),
      null,
      `model_calls ${String(model_calls)} measured no call`,
    );
  }
  // A real (even fractional) count is a measured call and prices normally.
  assert.equal(
    estimateRoleCostsFromSplit({
      senior: { model_calls: 1.9, input_tokens: 1_000_000, model: "gpt-4o" },
    })?.senior?.totalCost,
    2.5,
    "the count is truncated only for the zero test, never for the price",
  );
});

// ---------------------------------------------------------------------------
// RunManager: run_end + public record
// ---------------------------------------------------------------------------

test("run_end and the public record carry the split identity; cost_by_role is record-only", async () => {
  const split = {
    senior: {
      model_calls: 2,
      input_tokens: 20,
      output_tokens: 10,
      cached_tokens: 8,
      cache_write_tokens: 2,
      model: "gpt-4o",
      family: "openai-compatible" as const,
    },
    junior: {
      model_calls: 1,
      input_tokens: 5,
      output_tokens: 3,
      cached_tokens: 0,
      cache_write_tokens: 0,
      model: "e2e-junior",
      family: "openai-compatible" as const,
    },
  };
  const job: RunJob = (_signal, _onEnvelope): Promise<RunJobResult> =>
    Promise.resolve({
      cancelled: false,
      decision: {},
      errors: [],
      usage: {
        model_calls: 3,
        input_tokens: 25,
        output_tokens: 13,
        cached_tokens: 8,
        cache_write_tokens: 2,
      },
      usageByRole: split,
      costByRole: {
        senior: { currency: "USD", total: 0.0001, model: "gpt-4o" },
        junior: null,
      },
    });
  const manager = new RunManager();
  const record = manager.submit("task", "identity.jsonl", job);
  assert.equal(await record.done, true);

  const publicRecord = record.public();
  assert.deepEqual(publicRecord.usage_by_role, split);
  assert.deepEqual(publicRecord.cost_by_role, {
    senior: { currency: "USD", total: 0.0001, model: "gpt-4o" },
    junior: null,
  });
  const end = lastEvent(record.events, "run_end") as RunEndEvent;
  assert.deepEqual(end.usage_by_role, split, "the identity rides the terminal event's split");
  assert.equal("cost_by_role" in end, false, "derived cost stays off the event stream");
});

test("a job that reports no per-role cost leaves cost_by_role off the record", async () => {
  const job: RunJob = (): Promise<RunJobResult> =>
    Promise.resolve({
      cancelled: false,
      decision: {},
      errors: [],
      usageByRole: {
        senior: {
          model_calls: 1,
          input_tokens: 1,
          output_tokens: 1,
          cached_tokens: 0,
          cache_write_tokens: 0,
          model: "e2e-senior",
        },
        junior: { model_calls: 0, input_tokens: 0, output_tokens: 0, cached_tokens: 0 },
      },
    });
  const manager = new RunManager();
  const record = manager.submit("task", "unpriced.jsonl", job);
  assert.equal(await record.done, true);
  assert.equal("cost_by_role" in record.public(), false);
});

test("a live record folds call_usage counters without inventing an identity", async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const job: RunJob = async (_signal, onEnvelope): Promise<RunJobResult> => {
    onEnvelope({
      type: "call_usage",
      role: "senior",
      kind: "consult",
      usage: { model_calls: 1, input_tokens: 10, output_tokens: 2, cached_tokens: 0 },
    });
    await gate;
    throw new Error("provider exploded");
  };
  const manager = new RunManager();
  const record = manager.submit("task", "failed-identity.jsonl", job);
  await waitFor(
    () => record.public().usage_by_role !== undefined,
    "the live record to fold its call_usage events",
  );
  const live = record.public().usage_by_role as Record<string, any>;
  assert.equal(live.senior.model_calls, 1);
  assert.equal("model" in live.senior, false, "call_usage carries counters only");
  release();
  assert.equal(await record.done, true);
  assert.equal("cost_by_role" in record.public(), false, "no identity means no priced half");
});

// ---------------------------------------------------------------------------
// server: record projection + sidecar rebuild
// ---------------------------------------------------------------------------

test("a completed run's record carries identity and a per-role cost", async () => {
  const tmp = tmpdir("tb-role-cost-");
  const options: ServerOptions = {
    configFactory: openaiConfig(),
    sessionsDir: tmp.root,
    webDist: null,
    providerOverrides: {
      senior: meteredProvider(100, 20, 40, 5),
      junior: meteredProvider(30, 6, 0, 0),
    },
  };
  const handle = createServer(options);
  const server = await handle.listen("127.0.0.1", 0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const submitted = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "price the roles" }),
    });
    const started = (await submitted.json()) as Record<string, any>;
    const record = await waitTerminal(base, String(started.run_id));
    assert.equal(record.status, "completed");

    const split = record.usage_by_role as Record<string, any>;
    assert.equal(split.senior.model, "gpt-4o");
    assert.equal(split.junior.model, "deepseek-chat");
    assert.equal(split.senior.family, "openai-compatible");
    assert.equal(split.junior.family, "openai-compatible");
    // Counters are still the measured ones (identity is additive).
    assert.ok(split.senior.model_calls > 0 && split.junior.model_calls > 0);

    // The merged single-model rule is unchanged: a mixed-model run stays null.
    assert.equal(record.cost, null);
    const costs = record.cost_by_role as Record<string, any>;
    assert.ok(costs, "the record must carry the additive per-role cost");
    assert.equal(costs.senior.model, "gpt-4o");
    assert.equal(costs.junior.model, "deepseek-chat");
    assert.ok(costs.senior.total > 0);
    assert.ok(costs.junior.total > 0);
  } finally {
    await handle.close();
    tmp.cleanup();
  }
});

test("an unpriced model keeps identity but omits cost_by_role", async () => {
  const tmp = tmpdir("tb-role-unpriced-");
  const options: ServerOptions = {
    configFactory: openaiConfig({ seniorModel: "e2e-senior", juniorModel: "e2e-junior" }),
    sessionsDir: tmp.root,
    webDist: null,
    providerOverrides: {
      senior: meteredProvider(10, 2, 0, 0),
      junior: meteredProvider(10, 2, 0, 0),
    },
  };
  const handle = createServer(options);
  const server = await handle.listen("127.0.0.1", 0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const submitted = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "unpriced roles" }),
    });
    const started = (await submitted.json()) as Record<string, any>;
    const record = await waitTerminal(base, String(started.run_id));
    assert.equal(record.usage_by_role.senior.model, "e2e-senior");
    assert.equal(record.usage_by_role.junior.model, "e2e-junior");
    assert.equal("cost_by_role" in record, false, "unpriced models are never $0");
    assert.equal(record.cost, null);
  } finally {
    await handle.close();
    tmp.cleanup();
  }
});

test("a rebuilt record recovers identity and re-derives the per-role cost", async () => {
  const tmp = tmpdir("tb-role-recover-");
  const session = "recover-identity.jsonl";
  writeSidecar(tmp.root, session, [
    { type: "run_status", run_id: "run-priced", status: "running", at: 10 },
    {
      type: "run_end",
      run_id: "run-priced",
      status: "completed",
      at: 20,
      usage: { model_calls: 2, input_tokens: 1_000_000, output_tokens: 0, cached_tokens: 0 },
      usage_by_role: {
        senior: {
          model_calls: 1,
          input_tokens: 1_000_000,
          output_tokens: 0,
          cached_tokens: 0,
          model: "gpt-4o",
          family: "openai-compatible",
        },
        junior: {
          model_calls: 1,
          input_tokens: 0,
          output_tokens: 0,
          cached_tokens: 0,
          model: "e2e-junior",
          family: "openai-compatible",
        },
      },
    },
    // A pre-identity sidecar: counters only.
    { type: "run_status", run_id: "run-old", status: "running", at: 30 },
    {
      type: "run_end",
      run_id: "run-old",
      status: "completed",
      at: 40,
      usage: { model_calls: 1, input_tokens: 10, output_tokens: 1, cached_tokens: 0 },
      usage_by_role: {
        senior: { model_calls: 1, input_tokens: 10, output_tokens: 1, cached_tokens: 0 },
        junior: { model_calls: 0, input_tokens: 0, output_tokens: 0, cached_tokens: 0 },
      },
    },
  ]);
  const handle = createServer({
    configFactory: () => resolveConfig({ provider: "mock", mode: "consult" }),
    sessionsDir: tmp.root,
    webDist: null,
  });
  const server = await handle.listen("127.0.0.1", 0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const priced = await api(base, "GET", "/api/runs/run-priced");
    assert.equal(priced.status, 200);
    assert.equal(priced.body.rebuilt, true);
    assert.equal(priced.body.usage_by_role.senior.model, "gpt-4o");
    assert.equal(priced.body.usage_by_role.senior.family, "openai-compatible");
    const costs = priced.body.cost_by_role;
    assert.ok(costs, "the rebuilt record must re-derive the priced half");
    assert.equal(costs.senior.model, "gpt-4o");
    assert.ok(costs.senior.total > 0);
    assert.equal(costs.junior, null, "the unpriced half stays honestly unknown");

    const old = await api(base, "GET", "/api/runs/run-old");
    assert.equal(old.status, 200);
    assert.equal(old.body.rebuilt, true);
    assert.equal("model" in old.body.usage_by_role.senior, false, "old data has no identity");
    assert.equal("cost_by_role" in old.body, false, "no identity means no guessed cost");
  } finally {
    await handle.close();
    tmp.cleanup();
  }
});
