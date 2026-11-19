/**
 * Per-role usage on the run record and the terminal `run_end` event
 * (feat/usage-surfaces, additive).
 *
 * The harness already attributes every provider call (`HarnessResult.usageByRole`,
 * `call_usage` runtime events). This suite pins the two remaining run-record
 * surfaces: the additive `usage_by_role` field on `RunRecord.public()` /
 * `run_end`, the live/partial split folded from this run's `call_usage` events
 * (so a failed run keeps the spend it measured), and the sidecar rebuild —
 * `GET /api/runs/{id}` prefers the terminal event's split, sums the sidecar's
 * `call_usage` events when an older backend wrote no split, and omits the field
 * entirely for a pre-feature session (merged-only, never fabricated).
 *
 * Hermetic: mock/scripted providers, temp dirs, ephemeral loopback ports.
 * Run with: node --test tests/usagebyrolesurfaces.test.ts
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { resolveConfig, type Config } from "../src/config.ts";
import type { ChatMessage } from "../src/context.ts";
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
  addCallUsage,
  normalizeUsageByRole,
  RunManager,
  usageByRoleFromEvents,
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

function mockConfig(extra: Record<string, unknown> = {}): () => Config {
  return () => resolveConfig({ provider: "mock", mode: "consult", ...extra });
}

/** Five calls at the same counters, split across the two roles by the flow. */
function meteredMockProvider(
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

/** The split half of one call_usage event, for the hand-written sidecars. */
function callUsage(
  runId: string,
  role: "senior" | "junior",
  kind: string,
  usage: Record<string, unknown>,
): Record<string, unknown> {
  const base = { type: "call_usage", at: 1, role, kind, usage };
  return runId === "" ? base : { ...base, run_id: runId };
}

/** The newest typed event of `type` (no `Array.findLast` lib dependency). */
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

// ---------------------------------------------------------------------------
// RunManager: run_end and the public record
// ---------------------------------------------------------------------------

test("run_end carries usage_by_role and the public record publishes it", async () => {
  const split = {
    senior: { model_calls: 2, input_tokens: 20, output_tokens: 10, cached_tokens: 8, cache_write_tokens: 2 },
    junior: { model_calls: 1, input_tokens: 5, output_tokens: 3, cached_tokens: 0, cache_write_tokens: 0 },
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
    });
  const manager = new RunManager();
  const record = manager.submit("task", "split.jsonl", job);
  assert.equal(await record.done, true);

  const publicRecord = record.public();
  assert.deepEqual(publicRecord.usage_by_role, split);
  // the merged counters are untouched by the additive split
  assert.deepEqual(publicRecord.usage, {
    model_calls: 3,
    input_tokens: 25,
    output_tokens: 13,
    cached_tokens: 8,
    cache_write_tokens: 2,
  });
  const end = lastEvent(record.events, "run_end") as RunEndEvent;
  assert.ok(end);
  assert.deepEqual(end.usage_by_role, split);
  assert.deepEqual(end.usage, publicRecord.usage);
});

test("run_end and the public record omit usage_by_role when nothing was measured", async () => {
  const job: RunJob = (): Promise<RunJobResult> =>
    Promise.resolve({ cancelled: false, decision: {}, errors: [] });
  const manager = new RunManager();
  const record = manager.submit("task", "plain.jsonl", job);
  assert.equal(await record.done, true);

  assert.equal("usage_by_role" in record.public(), false);
  const end = lastEvent(record.events, "run_end") as RunEndEvent;
  assert.ok(end);
  assert.equal("usage_by_role" in end, false);
});

test("a failed run keeps the split folded from its call_usage events", async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const job: RunJob = async (_signal, onEnvelope): Promise<RunJobResult> => {
    onEnvelope(callUsage("", "senior", "consult", {
      model_calls: 1,
      input_tokens: 100,
      output_tokens: 20,
      cached_tokens: 40,
      cache_write_tokens: 5,
      prompt_tokens: 145,
    }));
    onEnvelope(callUsage("", "junior", "proposal", {
      model_calls: 2,
      input_tokens: 60,
      output_tokens: 8,
      cached_tokens: 10,
    }));
    await gate;
    throw new Error("provider exploded");
  };
  const manager = new RunManager();
  const record = manager.submit("task", "failed.jsonl", job);
  // The split is visible while the run is still in flight (the record folds
  // the events it persists; no fabricated halves for a role with no call).
  await waitFor(
    () => record.public().usage_by_role !== undefined,
    "the live record to fold its call_usage events",
  );
  const midRun = record.public();
  assert.ok(midRun.usage_by_role);
  const midSplit = midRun.usage_by_role as Record<string, any>;
  assert.equal(midSplit.senior.model_calls, 1);
  assert.equal(midSplit.junior.model_calls, 2);
  release();
  assert.equal(await record.done, true);

  assert.equal(record.status, "failed");
  const split = record.public().usage_by_role as Record<string, any>;
  assert.deepEqual(split.senior, {
    model_calls: 1,
    input_tokens: 100,
    output_tokens: 20,
    cached_tokens: 40,
    cache_write_tokens: 5,
    prompt_tokens: 145,
  });
  assert.deepEqual(split.junior, {
    model_calls: 2,
    input_tokens: 60,
    output_tokens: 8,
    cached_tokens: 10,
    cache_write_tokens: 0,
  });
  const end = lastEvent(record.events, "run_end") as RunEndEvent;
  assert.equal(end.status, "failed");
  assert.deepEqual(end.usage_by_role, split);
});

// ---------------------------------------------------------------------------
// pure helpers (the web/TUI mirrors follow the same rules)
// ---------------------------------------------------------------------------

test("normalizeUsageByRole is tolerant and never invents a half", () => {
  assert.equal(normalizeUsageByRole(null), null);
  assert.equal(normalizeUsageByRole({ senior: "x", junior: 4 }), null);
  const partial = normalizeUsageByRole({ senior: { model_calls: 2, input_tokens: 9 } });
  assert.ok(partial);
  assert.equal(partial.senior.model_calls, 2);
  assert.equal(partial.senior.input_tokens, 9);
  // a present split always carries both halves (the harness convention)
  assert.equal(partial.junior.model_calls, 0);
  assert.equal("prompt_tokens" in partial.senior, false);
  // malformed counters contribute nothing rather than NaN
  const odd = normalizeUsageByRole({
    senior: { model_calls: "3", input_tokens: "nope", cached_tokens: -2 },
  });
  assert.ok(odd);
  assert.equal(odd.senior.model_calls, 3);
  assert.equal(odd.senior.input_tokens, 0);
  assert.equal(odd.senior.cached_tokens, -2);
});

test("addCallUsage folds one event per role and ignores unknown roles", () => {
  const first = addCallUsage(null, "senior", { model_calls: 1, input_tokens: 10 });
  assert.ok(first);
  assert.equal(first.junior.model_calls, 0);
  const second = addCallUsage(first, "junior", { model_calls: 2, output_tokens: 4 });
  assert.ok(second);
  assert.equal(second.senior.input_tokens, 10);
  assert.equal(second.junior.output_tokens, 4);
  // a pure update: the previous value is never mutated
  assert.equal(first.junior.output_tokens, 0);
  // unknown role / malformed usage leave the value untouched
  assert.equal(addCallUsage(second, "helper", { model_calls: 9 }), second);
  assert.equal(addCallUsage(second, "senior", null), second);
});

test("usageByRoleFromEvents sums call_usage events and omits an empty stream", () => {
  assert.equal(usageByRoleFromEvents([]), null);
  assert.equal(
    usageByRoleFromEvents([{ type: "run_status", status: "running" }]),
    null,
  );
  const split = usageByRoleFromEvents([
    callUsage("r", "senior", "consult", { model_calls: 1, input_tokens: 10 }),
    { type: "run_error", message: "ignored" },
    callUsage("r", "senior", "decision", { model_calls: 1, input_tokens: 5 }),
    callUsage("r", "junior", "proposal", { model_calls: 1, output_tokens: 2 }),
  ]);
  assert.ok(split);
  assert.equal(split.senior.model_calls, 2);
  assert.equal(split.senior.input_tokens, 15);
  assert.equal(split.junior.model_calls, 1);
  assert.equal(split.junior.output_tokens, 2);
});

// ---------------------------------------------------------------------------
// server: GET /api/runs carries the live split and rebuilds it honestly
// ---------------------------------------------------------------------------

test("a completed run's record and run_end carry the real per-role split", async () => {
  const tmp = tmpdir("tb-usage-split-");
  const options: ServerOptions = {
    configFactory: mockConfig(),
    sessionsDir: tmp.root,
    webDist: null,
    providerOverrides: {
      senior: meteredMockProvider(100, 20, 40, 5),
      junior: meteredMockProvider(100, 20, 40, 5),
    },
  };
  const handle = createServer(options);
  const server = await handle.listen("127.0.0.1", 0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const submitted = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "split me" }),
    });
    const started = (await submitted.json()) as Record<string, any>;
    const record = await waitTerminal(base, String(started.run_id));
    assert.equal(record.status, "completed");
    const split = record.usage_by_role as Record<string, any>;
    assert.ok(split, "the record must carry the additive split");
    assert.deepEqual(Object.keys(split).sort(), ["junior", "senior"]);
    // every role that answered a consult-flow call is attributed; the halves
    // sum to the unchanged merged counters
    assert.ok(split.senior.model_calls > 0);
    assert.ok(split.junior.model_calls > 0);
    assert.equal(split.senior.model_calls + split.junior.model_calls, record.usage.model_calls);
    assert.equal(
      split.senior.input_tokens + split.junior.input_tokens,
      record.usage.input_tokens,
    );
    assert.equal(
      split.senior.output_tokens + split.junior.output_tokens,
      record.usage.output_tokens,
    );
    assert.equal(
      split.senior.cached_tokens + split.junior.cached_tokens,
      record.usage.cached_tokens,
    );
  } finally {
    await handle.close();
    tmp.cleanup();
  }
});

test("a rebuilt record prefers run_end's split, else sums call_usage", async () => {
  const tmp = tmpdir("tb-usage-recover-");
  const session = "recover.jsonl";
  writeSidecar(tmp.root, session, [
    { type: "run_status", run_id: "run-sum", status: "running", at: 10 },
    callUsage("run-sum", "senior", "consult", {
      model_calls: 1,
      input_tokens: 100,
      output_tokens: 10,
      cached_tokens: 40,
    }),
    callUsage("run-sum", "junior", "proposal", {
      model_calls: 2,
      input_tokens: 50,
      output_tokens: 5,
      cached_tokens: 10,
    }),
    // an older backend: no usage_by_role on the terminal event
    {
      type: "run_end",
      run_id: "run-sum",
      status: "completed",
      at: 20,
      usage: {
        model_calls: 3,
        input_tokens: 150,
        output_tokens: 15,
        cached_tokens: 50,
        cache_write_tokens: 0,
      },
    },
    // a newer backend: the terminal event's own split is authoritative
    { type: "run_status", run_id: "run-end-split", status: "running", at: 30 },
    callUsage("run-end-split", "senior", "consult", { model_calls: 9, input_tokens: 900 }),
    {
      type: "run_end",
      run_id: "run-end-split",
      status: "completed",
      at: 40,
      usage: { model_calls: 1, input_tokens: 7, output_tokens: 3, cached_tokens: 0 },
      usage_by_role: {
        senior: { model_calls: 1, input_tokens: 7, output_tokens: 3, cached_tokens: 0 },
        junior: { model_calls: 0, input_tokens: 0, output_tokens: 0, cached_tokens: 0 },
      },
    },
    // a pre-feature session: neither call_usage nor a split
    { type: "run_status", run_id: "run-old", status: "running", at: 50 },
    {
      type: "run_end",
      run_id: "run-old",
      status: "completed",
      at: 60,
      usage: { model_calls: 2, input_tokens: 30, output_tokens: 4, cached_tokens: 0 },
    },
  ]);
  const handle = createServer({ configFactory: mockConfig(), sessionsDir: tmp.root, webDist: null });
  const server = await handle.listen("127.0.0.1", 0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const summed = await api(base, "GET", "/api/runs/run-sum");
    assert.equal(summed.status, 200);
    assert.equal(summed.body.rebuilt, true);
    assert.deepEqual(summed.body.usage_by_role, {
      senior: {
        model_calls: 1,
        input_tokens: 100,
        output_tokens: 10,
        cached_tokens: 40,
        cache_write_tokens: 0,
      },
      junior: {
        model_calls: 2,
        input_tokens: 50,
        output_tokens: 5,
        cached_tokens: 10,
        cache_write_tokens: 0,
      },
    });
    // the merged counters are still the persisted ones (never re-derived)
    assert.deepEqual(summed.body.usage, {
      model_calls: 3,
      input_tokens: 150,
      output_tokens: 15,
      cached_tokens: 50,
      cache_write_tokens: 0,
    });

    const preferred = await api(base, "GET", "/api/runs/run-end-split");
    assert.equal(preferred.status, 200);
    assert.equal(preferred.body.usage_by_role.senior.model_calls, 1);
    assert.equal(preferred.body.usage_by_role.junior.model_calls, 0);

    const old = await api(base, "GET", "/api/runs/run-old");
    assert.equal(old.status, 200);
    assert.equal(old.body.rebuilt, true);
    assert.equal("usage_by_role" in old.body, false);
  } finally {
    await handle.close();
    tmp.cleanup();
  }
});
