/**
 * Per-call `model`/`effort` overrides on the `subagent` tool (slice M):
 * precedence, the pinned connection (provider/baseUrl/apiKey/kind never come
 * from an argument), validation before any spawn/budget counter, effort
 * normalization, and the resolved model on every observability surface.
 * Hermetic: mock/scripted providers plus one loopback HTTP fixture.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { resolveConfig, type Config } from "../src/config.ts";
import { SharedContext } from "../src/context.ts";
import { TwoBrothersHarness } from "../src/harness.ts";
import {
  AnthropicProvider,
  MockProvider,
  OpenAICompatibleProvider,
  type Provider,
  type Tool,
  type ToolChatOptions,
  type ToolChatResponse,
} from "../src/provider.ts";
import type { RuntimeEvent } from "../src/runevents.ts";
import {
  LIST_AGENTS_TOOL_NAME,
  SUBAGENT_EFFORT_MAX_CHARS,
  SUBAGENT_MODEL_MAX_CHARS,
  SUBAGENT_REPORT_TOOL_NAME,
  SUBAGENT_TOOL_DESCRIPTION,
  SUBAGENT_TOOL_NAME,
  SUBAGENT_TOOL_PARAMETERS,
  SubagentStore,
  type SubagentEndpoint,
} from "../src/subagent.ts";

function tmpdir(): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-subagent-ovr-"));
  return {
    root,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/** White-box access to the harness internals, like tests/subagent.test.ts uses. */
interface HarnessInternals {
  buildSubagentProvider: (
    role: "senior" | "junior",
    configured?: SubagentEndpoint,
    model?: string,
    effort?: string,
  ) => Provider;
  subagentModel: (
    role: "senior" | "junior",
    configured?: SubagentEndpoint,
    model?: string,
  ) => string;
  subagentTool: (state: Record<string, unknown>) => Tool;
}

function internals(harness: TwoBrothersHarness): HarnessInternals {
  return harness as unknown as HarnessInternals;
}

/** The minimal cooperation state shape the subagent tool reads (see subagent.test.ts). */
function fakeState(): Record<string, unknown> {
  return {
    task: "x",
    mode: "consult",
    maxRounds: 1,
    ctx: new SharedContext(),
    runEvents: [],
    rounds: 0,
    lastVerdict: "accept",
    decision: {},
    errors: [],
    verifyEvidence: [],
    verifySummary: "",
    compactNow: false,
    promptAudits: [],
    approvalDenials: new Map(),
    injectedSkills: new Set(),
    todos: [],
  };
}

/** The wire-visible fields every HTTP provider exposes for assertions. */
function wire(provider: Provider): {
  baseUrl: string;
  apiKey: string;
  model: string;
  effort?: string;
} {
  return provider as unknown as {
    baseUrl: string;
    apiKey: string;
    model: string;
    effort?: string;
  };
}

test("the subagent tool schema gains exactly two optional properties", () => {
  const schema = SUBAGENT_TOOL_PARAMETERS as {
    properties: Record<string, unknown>;
    required: string[];
    additionalProperties: boolean;
  };
  assert.deepEqual(Object.keys(schema.properties).sort(), [
    "background",
    "effort",
    "label",
    "model",
    "role",
    "task",
  ]);
  assert.deepEqual(schema.required, ["task"]);
  assert.equal(schema.additionalProperties, false);
  const model = schema.properties.model as { type: string; description: string };
  const effort = schema.properties.effort as { type: string; description: string };
  assert.equal(model.type, "string");
  assert.equal(effort.type, "string");
  assert.match(model.description, /provider, base URL and API key/i);
});

test("the description pins the honest override rule and keeps the policy sentences", () => {
  assert.match(SUBAGENT_TOOL_DESCRIPTION, /`model` and `effort` arguments refine only/);
  assert.match(
    SUBAGENT_TOOL_DESCRIPTION,
    /provider, base URL and API key always come from the configured route or the role endpoint/,
  );
  // Unchanged model-facing contract sentences:
  assert.match(SUBAGENT_TOOL_DESCRIPTION, /cannot widen the run's policy/);
  assert.match(SUBAGENT_TOOL_DESCRIPTION, /It cannot spawn more subagents/);
  assert.match(SUBAGENT_TOOL_DESCRIPTION, /Do not use it as a replacement for the Junior/);
  assert.doesNotMatch(SUBAGENT_TOOL_DESCRIPTION, /when set, it wins/);
});

test("model resolution precedence: override, then route, then role endpoint, then config", () => {
  const cfg = resolveConfig({
    provider: "mock",
    seniorModel: "cfg-senior",
    juniorModel: "cfg-junior",
  });
  const harness = new TwoBrothersHarness(cfg, {
    endpoints: {
      junior: { provider: "openai", baseUrl: "http://x/v1", apiKey: "", model: "ep-junior" },
    },
  });
  const inner = internals(harness);
  // Dedicated route wins over the role endpoint and the config.
  const route: SubagentEndpoint = {
    provider: "openai",
    baseUrl: "http://route/v1",
    apiKey: "",
    model: "route-model",
  };
  assert.equal(inner.subagentModel("junior", route), "route-model");
  // The per-call override wins over everything.
  assert.equal(inner.subagentModel("junior", route, "arg-model"), "arg-model");
  assert.equal(inner.subagentModel("senior", route, "arg-model"), "arg-model");
  // Role endpoint when no dedicated route is configured.
  assert.equal(inner.subagentModel("junior"), "ep-junior");
  assert.equal(inner.subagentModel("junior", undefined, "arg-model"), "arg-model");
  // Run config fallback for a role with no endpoint.
  assert.equal(inner.subagentModel("senior"), "cfg-senior");
  // Role literal when even the config has no model.
  const bare = { ...cfg, seniorModel: "", juniorModel: "" } as Config;
  const bareHarness = new TwoBrothersHarness(bare, {});
  assert.equal(internals(bareHarness).subagentModel("senior"), "senior");
  assert.equal(internals(bareHarness).subagentModel("junior"), "junior");
});

test("the connection stays frozen: overrides change only model/effort on the route copy", () => {
  const cfg = resolveConfig({ provider: "openai", baseUrl: "http://cfg/v1", apiKey: "cfg-key" });
  const harness = new TwoBrothersHarness(cfg, {});
  const route: SubagentEndpoint = {
    provider: "openai",
    baseUrl: "http://route.example/v1",
    apiKey: "route-secret",
    model: "route-model",
    kind: "anthropic",
    contextWindow: 128_000,
    effort: "low",
  };
  const provider = internals(harness).buildSubagentProvider("junior", route, "override", "high");
  // The wire family came from the route kind, never from an argument.
  assert.ok(provider instanceof AnthropicProvider);
  const fields = wire(provider);
  assert.equal(fields.baseUrl, "http://route.example/v1");
  assert.equal(fields.apiKey, "route-secret");
  assert.equal(fields.model, "override");
  assert.equal(fields.effort, "high");
});

test("no override builds the identical provider from the route or role endpoint", () => {
  const cfg = resolveConfig({
    provider: "openai",
    baseUrl: "http://cfg/v1",
    apiKey: "cfg-key",
    juniorModel: "cfg-junior",
  });
  const harness = new TwoBrothersHarness(cfg, {});
  const inner = internals(harness);
  const route: SubagentEndpoint = {
    provider: "openai",
    baseUrl: "http://route.example/v1",
    apiKey: "route-secret",
    model: "route-model",
    effort: "low",
  };
  const fromRoute = wire(inner.buildSubagentProvider("junior", route));
  assert.equal(fromRoute.baseUrl, "http://route.example/v1");
  assert.equal(fromRoute.apiKey, "route-secret");
  assert.equal(fromRoute.model, "route-model");
  assert.equal(fromRoute.effort, "low");
  const fromCfg = wire(inner.buildSubagentProvider("junior", undefined));
  assert.equal(fromCfg.baseUrl, "http://cfg/v1");
  assert.equal(fromCfg.apiKey, "cfg-key");
  assert.equal(fromCfg.model, "cfg-junior");
  assert.equal(fromCfg.effort, undefined);
});

test("with no endpoint, an override synthesizes the connection from the run config", () => {
  const cfg = resolveConfig({
    provider: "openai",
    baseUrl: "http://cfg.example/v1",
    apiKey: "cfg-key",
    juniorModel: "cfg-junior",
  });
  const harness = new TwoBrothersHarness(cfg, {});
  const provider = internals(harness).buildSubagentProvider("junior", undefined, "m", "low");
  assert.ok(provider instanceof OpenAICompatibleProvider);
  const fields = wire(provider);
  assert.equal(fields.baseUrl, "http://cfg.example/v1");
  assert.equal(fields.apiKey, "cfg-key");
  assert.equal(fields.model, "m");
  assert.equal(fields.effort, "low");
  // The no-override path stays on the historical buildProvider route.
  const plain = internals(harness).buildSubagentProvider("junior", undefined);
  assert.ok(plain instanceof OpenAICompatibleProvider);
  assert.equal(wire(plain).model, "cfg-junior");
  assert.equal(wire(plain).effort, undefined);
  const mockHarness = new TwoBrothersHarness(resolveConfig({ provider: "mock" }), {});
  assert.ok(
    internals(mockHarness).buildSubagentProvider("senior", undefined, "m") instanceof
      MockProvider,
  );
});

test("an invalid provider kind fails the override path with the provider's error", () => {
  const cfg = resolveConfig({ provider: "openai" });
  const harness = new TwoBrothersHarness(cfg, {});
  const bogus: SubagentEndpoint = {
    provider: "openai",
    baseUrl: "http://route/v1",
    apiKey: "",
    model: "route-model",
    kind: "bogus",
  };
  assert.throws(
    () => internals(harness).buildSubagentProvider("junior", bogus, "m"),
    /unknown provider kind/,
  );
  // Without an override the same endpoint is built lazily only at spawn time;
  // the display-only model resolution stays total.
  assert.equal(internals(harness).subagentModel("junior", bogus, "m"), "m");
});

test("invalid model arguments return a bounded tool error with no spawn and no budget use", async () => {
  const { root, cleanup } = tmpdir();
  try {
    const store = new SubagentStore(path.join(root, "subagents"));
    const harness = new TwoBrothersHarness(resolveConfig({ provider: "mock" }), {
      subagents: {
        store,
        parentSession: "parent.jsonl",
        maxPerRun: 1,
        providerFactory: () => new MockProvider([{ text: "ok" }]),
      },
    });
    const tool = internals(harness).subagentTool(fakeState());
    const bad = [
      { model: "" },
      { model: "   " },
      { model: "x".repeat(SUBAGENT_MODEL_MAX_CHARS + 1) },
      { model: "bad model" },
      { model: "-leading-dash" },
      { model: "../path" },
      { model: "ok-ish_but:bad?" },
    ];
    for (const args of bad) {
      const result = JSON.parse(await tool.execute({ task: "Inspect.", ...args })) as {
        status: string;
        error?: string;
      };
      assert.equal(result.status, "error", JSON.stringify(args));
      assert.match(result.error ?? "", /`model`/);
    }
    // No child was spawned or counted for any rejected call …
    assert.deepEqual(store.list("parent.jsonl"), []);
    // … so the single allowed spawn still succeeds and the next hits the budget.
    const first = JSON.parse(await tool.execute({ task: "Inspect one.", model: "ok-model" })) as {
      status: string;
      model?: string;
    };
    assert.equal(first.status, "completed");
    assert.equal(first.model, "ok-model");
    const second = JSON.parse(await tool.execute({ task: "Inspect two." })) as {
      status: string;
      error?: string;
    };
    assert.equal(second.status, "error");
    assert.match(second.error ?? "", /per-run limit/);
  } finally {
    cleanup();
  }
});

test("invalid effort arguments return a bounded tool error with no spawn and no budget use", async () => {
  const { root, cleanup } = tmpdir();
  try {
    const store = new SubagentStore(path.join(root, "subagents"));
    const harness = new TwoBrothersHarness(resolveConfig({ provider: "mock" }), {
      subagents: {
        store,
        parentSession: "parent.jsonl",
        maxPerRun: 1,
        providerFactory: () => new MockProvider([{ text: "ok" }]),
      },
    });
    const tool = internals(harness).subagentTool(fakeState());
    const bad = [
      { effort: "" },
      { effort: "   " },
      { effort: "x".repeat(SUBAGENT_EFFORT_MAX_CHARS + 1) },
      { effort: "HIGH!" },
      { effort: "hi there" },
      { effort: "UPPER case" },
    ];
    for (const args of bad) {
      const result = JSON.parse(await tool.execute({ task: "Inspect.", ...args })) as {
        status: string;
        error?: string;
      };
      assert.equal(result.status, "error", JSON.stringify(args));
      assert.match(result.error ?? "", /`effort`/);
    }
    assert.deepEqual(store.list("parent.jsonl"), []);
    const first = JSON.parse(
      await tool.execute({ task: "Inspect one.", effort: "HIGH" }),
    ) as { status: string };
    assert.equal(first.status, "completed");
    const second = JSON.parse(await tool.execute({ task: "Inspect two." })) as {
      status: string;
      error?: string;
    };
    assert.equal(second.status, "error");
    assert.match(second.error ?? "", /per-run limit/);
  } finally {
    cleanup();
  }
});

test("override validation runs before the budget check and spawns nothing", async () => {
  const { root, cleanup } = tmpdir();
  try {
    const store = new SubagentStore(path.join(root, "subagents"));
    const harness = new TwoBrothersHarness(resolveConfig({ provider: "mock" }), {
      subagents: {
        store,
        parentSession: "parent.jsonl",
        maxPerRun: 1,
        providerFactory: () => new MockProvider([{ text: "ok" }]),
      },
    });
    const tool = internals(harness).subagentTool(fakeState());
    const first = JSON.parse(await tool.execute({ task: "Inspect one." })) as { status: string };
    assert.equal(first.status, "completed");
    // Budget is now exhausted; a bad override still reports the validation
    // error, not the budget error, and changes no counter.
    const bad = JSON.parse(
      await tool.execute({ task: "Inspect two.", model: "bad model" }),
    ) as { status: string; error?: string };
    assert.equal(bad.status, "error");
    assert.match(bad.error ?? "", /`model`/);
    assert.deepEqual(store.list("parent.jsonl").length, 1);
  } finally {
    cleanup();
  }
});

/** A scripted Senior: subagent → list_agents → subagent_report, then a default payload. */
class ObservabilitySenior extends MockProvider {
  calls = 0;
  readonly transcripts: string[] = [];
  private readonly extra: Record<string, unknown>;

  constructor(extra: Record<string, unknown>) {
    super();
    this.extra = extra;
  }

  override async chatWithTools(
    messages: Parameters<MockProvider["chatWithTools"]>[0],
    tools: Tool[],
    options: ToolChatOptions = {},
  ): Promise<ToolChatResponse> {
    this.usage.record(10, 5, 0);
    this.calls += 1;
    this.transcripts.push(JSON.stringify(messages));
    if (this.calls === 1) {
      return {
        content: "",
        toolCalls: [
          { id: "call-1", name: SUBAGENT_TOOL_NAME, args: { task: "Summarize the schema.", ...this.extra } },
        ],
      };
    }
    if (this.calls === 2) {
      return {
        content: "",
        toolCalls: [{ id: "call-2", name: LIST_AGENTS_TOOL_NAME, args: {} }],
      };
    }
    if (this.calls === 3) {
      // Tool results are JSON strings inside the stringified messages, so the
      // inner quotes arrive escaped.
      const match = /\\"subagent_id\\":\\"(sub-[a-f0-9]+)\\"/.exec(
        this.transcripts.at(-1) ?? "",
      );
      return {
        content: "",
        toolCalls: [
          {
            id: "call-3",
            name: SUBAGENT_REPORT_TOOL_NAME,
            args: { agent_id: match?.[1] ?? "" },
          },
        ],
      };
    }
    return super.chatWithTools(messages, tools, options);
  }
}

/** Parse one tool result out of a recorded transcript (messages at one call). */
function toolResult(
  transcripts: string[],
  index: number,
  callId: string,
): Record<string, unknown> {
  const messages = JSON.parse(transcripts[index] ?? "[]") as {
    toolCallId?: string;
    content?: unknown;
  }[];
  const message = messages.find((entry) => entry.toolCallId === callId);
  assert.ok(message, `tool result for ${callId} recorded`);
  return JSON.parse(String(message.content ?? "{}")) as Record<string, unknown>;
}

test("the resolved model flows to the result, started event, list_agents and subagent_report", async () => {
  const { root, cleanup } = tmpdir();
  try {
    const store = new SubagentStore(path.join(root, "subagents"));
    const events: RuntimeEvent[] = [];
    const senior = new ObservabilitySenior({ model: "override-model" });
    const harness = new TwoBrothersHarness(resolveConfig({ provider: "mock" }), {
      senior,
      junior: new MockProvider(),
      subagents: {
        store,
        parentSession: "parent.jsonl",
        providerFactory: () => new MockProvider([{ text: "The schema has three tables." }]),
      },
      onEvent: (event) => events.push(event),
    });
    const result = await harness.run("Plan a migration", new SharedContext());
    assert.equal(result.cancelled, false);

    // subagent_started carries the resolved model.
    const started = events.find((event) => event.type === "subagent_started") as
      | { model?: string }
      | undefined;
    assert.equal(started?.model, "override-model");
    // The child log row carries it.
    const rows = store.list("parent.jsonl");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.model, "override-model");
    assert.equal(rows[0]?.status, "completed");
    // The synchronous tool result carries the resolved model.
    const spawnResult = toolResult(senior.transcripts, 1, "call-1");
    assert.equal(spawnResult.model, "override-model");
    assert.equal(spawnResult.status, "completed");
    // list_agents answered with the resolved model (second call's result).
    const listResult = toolResult(senior.transcripts, 2, "call-2");
    assert.equal(listResult.tool, LIST_AGENTS_TOOL_NAME);
    const agents = listResult.agents as { model?: string; status?: string }[];
    assert.equal(agents.length, 1);
    assert.equal(agents[0]?.model, "override-model");
    assert.equal(agents[0]?.status, "completed");
    // subagent_report answered with the resolved model and the report.
    const reportResult = toolResult(senior.transcripts, 3, "call-3");
    assert.equal(reportResult.tool, SUBAGENT_REPORT_TOOL_NAME);
    assert.equal(reportResult.model, "override-model");
    assert.equal(reportResult.status, "completed");
    assert.equal(typeof reportResult.report, "string");
    assert.notEqual(reportResult.report, "");
  } finally {
    cleanup();
  }
});

test("no override keeps every surface on the route model", async () => {
  const { root, cleanup } = tmpdir();
  try {
    const store = new SubagentStore(path.join(root, "subagents"));
    const events: RuntimeEvent[] = [];
    const senior = new ObservabilitySenior({});
    const harness = new TwoBrothersHarness(resolveConfig({ provider: "mock" }), {
      senior,
      junior: new MockProvider(),
      subagents: {
        store,
        parentSession: "parent.jsonl",
        endpoint: {
          provider: "mock",
          baseUrl: "",
          apiKey: "",
          model: "route-model",
          kind: "openai-compatible",
        },
        providerFactory: () => new MockProvider([{ text: "route reply" }]),
      },
      onEvent: (event) => events.push(event),
    });
    const result = await harness.run("Plan a migration", new SharedContext());
    assert.equal(result.cancelled, false);
    const started = events.find((event) => event.type === "subagent_started") as
      | { model?: string }
      | undefined;
    assert.equal(started?.model, "route-model");
    assert.equal(store.list("parent.jsonl")[0]?.model, "route-model");
    // The subagent tool result (first call's reply) shows the route model too.
    assert.equal(toolResult(senior.transcripts, 1, "call-1").model, "route-model");
  } finally {
    cleanup();
  }
});

test("a role endpoint (no dedicated route) honors the override", async () => {
  const { root, cleanup } = tmpdir();
  try {
    const store = new SubagentStore(path.join(root, "subagents"));
    const events: RuntimeEvent[] = [];
    const senior = new ObservabilitySenior({ model: "role-override" });
    const harness = new TwoBrothersHarness(
      resolveConfig({ provider: "mock", seniorModel: "cfg-senior", juniorModel: "cfg-junior" }),
      {
        senior,
        junior: new MockProvider(),
        endpoints: {
          junior: { provider: "openai", baseUrl: "http://x/v1", apiKey: "", model: "ep-junior" },
        },
        subagents: {
          store,
          parentSession: "parent.jsonl",
          providerFactory: () => new MockProvider([{ text: "endpoint reply" }]),
        },
        onEvent: (event) => events.push(event),
      },
    );
    const result = await harness.run("Plan a migration", new SharedContext());
    assert.equal(result.cancelled, false);
    const started = events.find((event) => event.type === "subagent_started") as
      | { model?: string }
      | undefined;
    assert.equal(started?.model, "role-override");
    assert.equal(store.list("parent.jsonl")[0]?.model, "role-override");
  } finally {
    cleanup();
  }
});

test("the override reaches the child's wire request; effort is normalized; the connection is the route's", async () => {
  const { root, cleanup } = tmpdir();
  const requests: { auth: string | undefined; body: Record<string, unknown> }[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: string) => {
      raw += chunk;
    });
    req.on("end", () => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        body = {};
      }
      requests.push({ auth: req.headers.authorization, body });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-1",
          object: "chat.completion",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "loopback reply" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const store = new SubagentStore(path.join(root, "subagents"));
    const senior = new MockProvider([
      {
        tool: SUBAGENT_TOOL_NAME,
        args: { task: "Ask the loopback.", model: "override-model", effort: "HIGH" },
      },
    ]);
    const harness = new TwoBrothersHarness(
      resolveConfig({
        provider: "openai",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: "run-key",
        seniorModel: "senior-m",
        juniorModel: "junior-m",
        retries: 0,
        timeout: 5,
      }),
      {
        senior,
        junior: new MockProvider(),
        subagents: {
          store,
          parentSession: "parent.jsonl",
          endpoint: {
            provider: "openai",
            baseUrl: `http://127.0.0.1:${port}/v1`,
            apiKey: "route-secret",
            model: "route-model",
            kind: "openai-compatible",
          },
        },
        onEvent: () => {},
      },
    );
    const result = await harness.run("Plan a migration", new SharedContext());
    assert.equal(result.cancelled, false);
    const child = requests.find((request) => request.body.model === "override-model");
    assert.ok(child, "the child's request carried the override model");
    // The connection is the route's, never the run config's or an argument's.
    assert.equal(child?.auth, "Bearer route-secret");
    // Effort arrived normalized (HIGH -> high).
    assert.equal(child?.body.reasoning_effort, "high");
    assert.equal(store.list("parent.jsonl")[0]?.model, "override-model");
    assert.equal(store.list("parent.jsonl")[0]?.status, "completed");
  } finally {
    server.close();
    cleanup();
  }
});
