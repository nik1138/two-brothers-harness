/**
 * Per-turn Senior/Junior usage + cache split (additive slice).
 *
 * The run footer already reports one merged counter set. This suite pins the
 * split: every provider call's counters are attributed to the acting role and
 * node kind (from the provider's own family-mapped usage delta), aggregated
 * per role on `HarnessResult.usageByRole`, completed onto the call's
 * `PromptAuditEntry`, streamed as an additive `call_usage` runtime event, and
 * rendered as an extra CLI line/segment — with the merged footer and every
 * machine-mode byte unchanged.
 *
 * Hermetic: mock/scripted providers and a stubbed `FetchLike`, no endpoint,
 * clock or filesystem. Run with: node --test tests/usagebyrole.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { main, type CliIO } from "../src/cli.ts";
import {
  humanFooter,
  roleUsageLines,
} from "../src/clilayout.ts";
import {
  FALLBACK_TERMINAL_WIDTH,
  plainCliStyle,
  resolveCliStyle,
} from "../src/clistyle.ts";
import { resolveConfig } from "../src/config.ts";
import type { ChatMessage } from "../src/context.ts";
import { TwoBrothersHarness } from "../src/harness.ts";
import {
  AnthropicProvider,
  MockProvider,
  type FetchLike,
  type ModelProviderConfig,
  type Provider,
  type Tool,
  type ToolChatOptions,
  type ToolChatResponse,
} from "../src/provider.ts";
import type { CallUsageEvent, RuntimeEvent } from "../src/runevents.ts";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

interface RecordedRequest {
  url: string;
  headers: Record<string, string>;
  body: any;
}

/** Replays `handler` for every call and records the wire request. */
function stubFetch(handler: (request: RecordedRequest, index: number) => Response): {
  fetchImpl: FetchLike;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  return {
    requests,
    fetchImpl: async (url, init) => {
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries((init.headers ?? {}) as Record<string, string>)) {
        headers[name.toLowerCase()] = value;
      }
      const request: RecordedRequest = {
        url,
        headers,
        body: typeof init.body === "string" ? JSON.parse(init.body) : init.body,
      };
      requests.push(request);
      return handler(request, requests.length - 1);
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A minimal Anthropic provider config for the stubbed transport. */
const ANTHROPIC_BASE: Omit<ModelProviderConfig, "fetchImpl"> = {
  provider: "openai",
  baseUrl: "http://stub.example",
  apiKey: "secret-key",
  seniorModel: "senior-model",
  juniorModel: "junior-model",
  temperature: 0.2,
  timeout: 5,
  retries: 0,
  model: "claude-test",
};

function makeIO(): CliIO & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, log: (line) => out.push(line), error: (line) => err.push(line) };
}

/** Strip every SGR sequence (the CLI theme is the only escape source). */
function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/** The 16-color style the CLI resolves on a depth-4 TTY. */
function ansi16Style(): ReturnType<typeof resolveCliStyle> {
  return resolveCliStyle({ depth: 4, env: {} });
}

const MOCK_RUN_ARGS = ["run", "pick an approach", "--provider", "mock"] as const;

/** The consult-mode node sequence the mock provider answers. */
const CONSULT_CALLS = ["senior/consult", "junior/proposal", "senior/review", "senior/decision"];

function callUsageEvents(events: RuntimeEvent[]): CallUsageEvent[] {
  return events.filter((event): event is CallUsageEvent => event.type === "call_usage");
}

/**
 * A provider that answers through a delegate but tracks NO usage — the shape
 * of an embedder-supplied provider without `usageSnapshot()`.
 */
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

// ---------------------------------------------------------------------------
// harness: per-call attribution and per-role aggregation
// ---------------------------------------------------------------------------

test("harness: every provider call's tokens are attributed to its role and node kind", async () => {
  const events: RuntimeEvent[] = [];
  const harness = new TwoBrothersHarness(resolveConfig({ provider: "mock", mode: "consult" }), {
    onEvent: (event) => events.push(event),
  });
  const result = await harness.run("split the usage");

  // one audit row and one call_usage event per request, in call order
  assert.deepEqual(
    result.promptAudits.map((audit) => `${audit.role}/${audit.kind}`),
    CONSULT_CALLS,
  );
  const calls = callUsageEvents(events);
  assert.deepEqual(
    calls.map((event) => `${event.role}/${event.kind}`),
    CONSULT_CALLS,
    "one call_usage event per provider request, role and kind aligned",
  );

  // the mock provider records 10 in / 5 out per call, so the split is exact
  const expectedSenior = {
    model_calls: 3,
    input_tokens: 30,
    output_tokens: 15,
    cached_tokens: 0,
    cache_write_tokens: 0,
  };
  const expectedJunior = {
    model_calls: 1,
    input_tokens: 10,
    output_tokens: 5,
    cached_tokens: 0,
    cache_write_tokens: 0,
  };
  assert.deepEqual(result.usageByRole, { senior: expectedSenior, junior: expectedJunior });

  // each audit row carries its own call's delta, and the matching event and
  // the group of rows add up to the role aggregate
  for (const audit of result.promptAudits) {
    assert.ok(audit.usage !== undefined, `${audit.role}/${audit.kind} carries its own usage`);
    assert.equal(audit.usage.model_calls, 1, "one model call per audit row");
    const event = calls.find((item) => item.role === audit.role && item.kind === audit.kind);
    assert.ok(event !== undefined);
    assert.deepEqual(event.usage, { ...audit.usage }, "the event carries the same delta");
    assert.deepEqual(Object.keys(event).sort(), ["kind", "role", "type", "usage"]);
  }
  const seniorRows = result.promptAudits.filter((audit) => audit.role === "senior");
  assert.equal(seniorRows.length, 3);
  assert.equal(
    seniorRows.reduce((sum, audit) => sum + (audit.usage?.input_tokens ?? 0), 0),
    expectedSenior.input_tokens,
  );
  // the merged run counters are unchanged by the split
  assert.equal(result.usage.model_calls, 4);
  assert.equal(result.usage.input_tokens, 40);
  assert.equal(result.usage.output_tokens, 20);
});

test("harness: the split reuses the provider family mapping for cache reads and writes", async () => {
  // Senior: Anthropic (cache_read/cache_creation mapped by its adapter);
  // Junior: the mock provider (no cache counters of its own).
  const seniorUsages = [
    { input_tokens: 50, output_tokens: 5, cache_read_input_tokens: 25 },
    { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 7 },
    { input_tokens: 5, output_tokens: 1 },
  ];
  const replies = [
    { task: "t", ask: "why?", expect: "proposal" },
    { verdict: "accept", notes: "ok" },
    { decision: "ship it", rationale: "because" },
  ];
  const stub = stubFetch((_request, index) =>
    jsonResponse({
      content: [{ type: "text", text: JSON.stringify(replies[index]) }],
      usage: seniorUsages[index],
    }),
  );
  const senior = new AnthropicProvider({ ...ANTHROPIC_BASE, fetchImpl: stub.fetchImpl });

  const harness = new TwoBrothersHarness(resolveConfig({ provider: "mock", mode: "consult" }), {
    senior,
    junior: new MockProvider(),
  });
  const result = await harness.run("split cached tokens");

  assert.equal(result.promptAudits.length, 4);
  // The senior half keeps Anthropic's own math: input is uncached-only,
  // prompt = input + cache reads + cache writes, a write is never a hit.
  assert.deepEqual(result.usageByRole?.senior, {
    model_calls: 3,
    input_tokens: 65,
    output_tokens: 11,
    cached_tokens: 25,
    cache_write_tokens: 7,
    prompt_tokens: 97,
  });
  // The junior half stays an OpenAI-compatible counter set (no prompt_tokens).
  assert.deepEqual(result.usageByRole?.junior, {
    model_calls: 1,
    input_tokens: 10,
    output_tokens: 5,
    cached_tokens: 0,
    cache_write_tokens: 0,
  });
  // Per-call rows carry the same family mapping, so a cache read/write is
  // attributable to one node: consult read 25, review wrote 7, decision none.
  const seniorRows = result.promptAudits.filter((audit) => audit.role === "senior");
  assert.deepEqual(
    seniorRows.map((audit) => audit.usage),
    [
      {
        model_calls: 1,
        input_tokens: 50,
        output_tokens: 5,
        cached_tokens: 25,
        cache_write_tokens: 0,
        prompt_tokens: 75,
      },
      {
        model_calls: 1,
        input_tokens: 10,
        output_tokens: 5,
        cached_tokens: 0,
        cache_write_tokens: 7,
        prompt_tokens: 17,
      },
      {
        model_calls: 1,
        input_tokens: 5,
        output_tokens: 1,
        cached_tokens: 0,
        cache_write_tokens: 0,
        prompt_tokens: 5,
      },
    ],
  );
  // The merged run counters are unchanged by the split.
  assert.deepEqual(result.usage, {
    model_calls: 4,
    input_tokens: 75,
    output_tokens: 16,
    cached_tokens: 25,
    cache_write_tokens: 7,
    prompt_tokens: 107,
  });
});

test("harness: a compaction summarizer call is attributed without an audit row", async () => {
  const events: RuntimeEvent[] = [];
  const harness = new TwoBrothersHarness(resolveConfig({ provider: "mock", mode: "consult" }), {
    // A low char trigger compacts at the first node boundary that has enough
    // context to cut (the task envelope is always kept verbatim), so the
    // summarizer really calls the senior provider.
    compaction: { thresholdChars: 120, reserveChars: 0 },
    onEvent: (event) => events.push(event),
  });
  const result = await harness.run(`compact and split ${"x".repeat(400)}`);

  const calls = callUsageEvents(events);
  const compaction = calls.filter((event) => event.kind === "compaction");
  assert.ok(compaction.length >= 1, "the summarizer call is measured");
  for (const event of compaction) {
    assert.equal(event.role, "senior", "the default summarizer role is attributed");
  }
  // It is not a role prompt call: no prompt_audit row carries the kind.
  assert.ok(result.promptAudits.every((audit) => audit.kind !== "compaction"));
  // Attributed to the senior half, so the halves still sum to the merged total:
  // three senior node calls plus the summarizer passes, one junior proposal.
  assert.equal(result.usageByRole?.senior.model_calls, 3 + compaction.length);
  assert.equal(result.usageByRole?.junior.model_calls, 1);
  assert.equal(
    result.usageByRole!.senior.model_calls + result.usageByRole!.junior.model_calls,
    result.usage.model_calls,
    "every measured provider call lands in exactly one role half",
  );
  assert.deepEqual(
    calls.filter((event) => event.kind !== "compaction").map((event) => `${event.role}/${event.kind}`),
    CONSULT_CALLS,
    "the cooperation nodes keep their call order around the summarizer passes",
  );
});

test("harness: a provider with no usage tracking leaves the split absent", async () => {
  const events: RuntimeEvent[] = [];
  const harness = new TwoBrothersHarness(resolveConfig({ provider: "mock", mode: "consult" }), {
    senior: new UntrackedProvider(),
    junior: new UntrackedProvider(),
    onEvent: (event) => events.push(event),
  });
  const result = await harness.run("no usage tracking");

  assert.equal(result.promptAudits.length, 4, "the run itself still completes");
  assert.equal(result.usageByRole, undefined, "no invented per-role numbers");
  assert.deepEqual(
    result.promptAudits.filter((audit) => audit.usage !== undefined),
    [],
    "audit rows stay free of usage when the provider tracks none",
  );
  assert.deepEqual(callUsageEvents(events), [], "no call_usage events are invented");
  assert.equal(result.usage.model_calls, 0);
});

// ---------------------------------------------------------------------------
// CLI layout: the additive split line(s)
// ---------------------------------------------------------------------------

test("cli layout: the role split renders cache reads and writes per role", () => {
  const lines = roleUsageLines(
    {
      senior: {
        input_tokens: 60,
        prompt_tokens: 100,
        output_tokens: 20,
        cached_tokens: 40,
        cache_write_tokens: 7,
        model_calls: 2,
      },
      junior: { input_tokens: 10, output_tokens: 5, model_calls: 1 },
    },
    plainCliStyle,
    FALLBACK_TERMINAL_WIDTH,
  );
  assert.deepEqual(lines, [
    "senior: 100 in / 20 out · cache 40% · write 7 · 2 calls",
    "junior: 10 in / 5 out · 1 call",
  ]);

  // the merged footer is untouched: the split is additive, never a rewrite
  const merged = {
    input_tokens: 70,
    prompt_tokens: 110,
    output_tokens: 25,
    cached_tokens: 40,
    cache_write_tokens: 7,
    model_calls: 3,
  };
  assert.equal(
    humanFooter(merged, null, plainCliStyle, FALLBACK_TERMINAL_WIDTH),
    "tokens 110 in / 25 out · cache 36% · write 7 · 3 calls",
  );

  // colored output strips back to the plain bytes
  const colored = roleUsageLines(
    { senior: { input_tokens: 1, output_tokens: 1, model_calls: 1 } },
    ansi16Style(),
    FALLBACK_TERMINAL_WIDTH,
  );
  assert.equal(stripAnsi(colored[0] as string), "senior: 1 in / 1 out · 1 call");
});

test("cli layout: the role split omits untracked roles and caps the width", () => {
  assert.deepEqual(roleUsageLines(undefined, plainCliStyle, FALLBACK_TERMINAL_WIDTH), []);
  assert.deepEqual(roleUsageLines(null, plainCliStyle, FALLBACK_TERMINAL_WIDTH), []);
  assert.deepEqual(roleUsageLines({}, plainCliStyle, FALLBACK_TERMINAL_WIDTH), []);
  assert.deepEqual(
    roleUsageLines(
      {
        senior: { model_calls: 0 },
        junior: { input_tokens: 10, output_tokens: 5, model_calls: 1 },
      },
      plainCliStyle,
      FALLBACK_TERMINAL_WIDTH,
    ),
    ["junior: 10 in / 5 out · 1 call"],
    "a role that made no call is omitted instead of printed as zero",
  );

  const narrow = roleUsageLines(
    { senior: { input_tokens: 30, output_tokens: 15, cached_tokens: 15, model_calls: 3 } },
    plainCliStyle,
    20,
  );
  assert.equal(narrow.length, 1);
  const width = (line: string): number => [...line].length;
  assert.ok(width(narrow[0] as string) <= 20, narrow[0]);
  assert.ok((narrow[0] as string).endsWith("…"), narrow[0]);
});

// ---------------------------------------------------------------------------
// CLI surfaces
// ---------------------------------------------------------------------------

test("run: text mode prints the per-role split before the unchanged footer", async () => {
  const io = makeIO();
  assert.equal(await main([...MOCK_RUN_ARGS], io), 0, io.err.join("\n"));

  const rows = io.out;
  const seniorRow = rows.find((row) => row.startsWith("senior: "));
  const juniorRow = rows.find((row) => row.startsWith("junior: "));
  assert.equal(seniorRow, "senior: 30 in / 15 out · 3 calls");
  assert.equal(juniorRow, "junior: 10 in / 5 out · 1 call");

  const seniorAt = rows.indexOf(seniorRow as string);
  const juniorAt = rows.indexOf(juniorRow as string);
  const footerAt = rows.indexOf("tokens 40 in / 20 out · 4 calls");
  assert.ok(seniorAt > 0 && juniorAt === seniorAt + 1, "one line per role, senior first");
  assert.equal(rows[seniorAt - 1], "", "the split is its own blank-line-separated block");
  assert.ok(footerAt > juniorAt, "the split precedes the merged footer");
  assert.equal(rows[footerAt - 1], "", "the footer keeps its blank line");
  assert.equal(rows[rows.length - 1], "tokens 40 in / 20 out · 4 calls", "footer stays last");
  // the machine `tokens:` diagnostic never appears in text mode
  assert.ok(!rows.some((row) => row.startsWith("tokens: ")));
});

test("run: --json carries the additive usage_by_role split", async () => {
  const io = makeIO();
  assert.equal(await main([...MOCK_RUN_ARGS, "--json"], io), 0, io.err.join("\n"));
  assert.equal(io.out.length, 1, "one machine object on stdout");
  const parsed = JSON.parse(io.out[0] as string) as Record<string, any>;

  // existing keys are unchanged
  assert.equal(parsed.usage.model_calls, 4);
  assert.equal(parsed.usage.input_tokens, 40);
  assert.equal(typeof parsed.rounds, "number");
  // the additive split mirrors the run's two halves
  assert.deepEqual(parsed.usage_by_role, {
    senior: {
      model_calls: 3,
      input_tokens: 30,
      output_tokens: 15,
      cached_tokens: 0,
      cache_write_tokens: 0,
    },
    junior: {
      model_calls: 1,
      input_tokens: 10,
      output_tokens: 5,
      cached_tokens: 0,
      cache_write_tokens: 0,
    },
  });
  assert.deepEqual(io.err, [], "a clean machine run keeps stderr silent");
});

test("run: --verbose prompt-audit rows carry the per-call token segment", async () => {
  const io = makeIO();
  assert.equal(await main([...MOCK_RUN_ARGS, "--verbose"], io), 0, io.err.join("\n"));
  const rows = io.out
    .flatMap((entry) => entry.split("\n"))
    .filter((row) => row.includes("senior consult:") || row.includes("junior proposal:"));
  assert.ok(rows.length >= 2, io.out.join("\n"));
  for (const row of rows) {
    // The mock provider reports 10 in / 5 out per call: the segment is
    // additive (the names/lengths part of the row is unchanged).
    assert.ok(/; tokens 10 in \/ 5 out$/.test(row), row);
  }
});

test("run: --mode print keeps the decision on stdout and prints the split on stderr", async () => {
  const io = makeIO();
  assert.equal(await main([...MOCK_RUN_ARGS, "--mode", "print"], io), 0, io.err.join("\n"));
  assert.equal(io.out.length, 1, "stdout carries the decision only");
  assert.ok(!io.out[0]!.includes("senior: "), "no split line on the decision stream");
  assert.ok(
    io.err.some((line) => line.startsWith("tokens: ")),
    "the machine usage line is unchanged",
  );
  assert.ok(io.err.includes("senior: 30 in / 15 out · 3 calls"), io.err.join("\n"));
  assert.ok(io.err.includes("junior: 10 in / 5 out · 1 call"), io.err.join("\n"));
  const tokensAt = io.err.findIndex((line) => line.startsWith("tokens: "));
  const seniorAt = io.err.indexOf("senior: 30 in / 15 out · 3 calls");
  assert.ok(tokensAt >= 0 && seniorAt > tokensAt, "the split follows the diagnostics");
});

// ---------------------------------------------------------------------------
// the types the split exposes stay plain data
// ---------------------------------------------------------------------------

test("harness: the split is data-only (no prompt bodies, no protocol fields)", async () => {
  const harness = new TwoBrothersHarness(resolveConfig({ provider: "mock", mode: "consult" }), {});
  const result = await harness.run("shape check");

  const auditKeys = Object.keys(result.promptAudits[0]!).sort();
  assert.deepEqual(auditKeys, [
    "kind",
    "role",
    "sections",
    "systemChars",
    "tools",
    "usage",
    "userChars",
  ]);
  // the protocol envelopes never carry usage: the split is runtime data only
  for (const message of result.messages) {
    const envelope = message as unknown as Record<string, unknown>;
    assert.ok(!("usage" in envelope), "an envelope gained a usage field");
    assert.ok(
      !("usageByRole" in (envelope.payload as Record<string, unknown>)),
      "a payload gained usageByRole",
    );
  }
});
