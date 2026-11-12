/**
 * Byte-stability regression scenarios (auto+solo lane, design §7.3).
 *
 * Canonical explicit `consult` and `work` runs whose FULL provider requests
 * (every `ChatMessage[]`, the offered tool names), the rendered transcript and
 * the envelope log are snapshotted as goldens. Explicit modes never enter the
 * auto routing node, so these bytes must stay identical across the feature.
 *
 * The scenario definitions are shared by the capture script (`capture.ts`,
 * run once on the PRE-change tree to write the goldens) and the regression
 * suite (`tests/modebytes.test.ts`, re-runs and deep-equals). Keep this module
 * deterministic: fixed task text, fixed fake tools, scripted replies only.
 *
 * Run with: node tests/fixtures/modebytes/capture.ts (regenerate goldens)
 */
import { resolveConfig } from "../../../src/config.ts";
import type { ChatMessage } from "../../../src/context.ts";
import { TwoBrothersHarness } from "../../../src/harness.ts";
import {
  emptyUsage,
  MockProvider,
  type Provider,
  type Tool,
  type ToolChatOptions,
  type ToolChatResponse,
  type UsageTotals,
} from "../../../src/provider.ts";

/** The canonical demo task — identical in every scenario. */
export const MODEBYTES_TASK = "Plan a migration from Redis to Valkey";

/** One recorded provider request (the full wire-shaped message array). */
export interface ScenarioCall {
  role: "senior" | "junior";
  channel: "chat" | "tools";
  /** The `responseKind` the harness passed (wire kind). */
  kind: string;
  messages: ChatMessage[];
  /** Model-facing tool names offered on this call (empty for plain chat). */
  tools: string[];
}

/** The deterministic, timestamp-free projection of one scenario run. */
export interface ScenarioOutcome {
  calls: ScenarioCall[];
  transcript: string;
  envelopes: Array<{
    seq: number;
    from: string;
    to: string;
    kind: string;
    payload: Record<string, unknown>;
  }>;
  decision: Record<string, unknown>;
  rounds: number;
  errors: string[];
  warnings: string[];
}

/** The strict-valid baseline reply for every structured kind (repair scripts). */
const VALID: Record<string, Record<string, unknown>> = {
  consult: { task: "t", ask: "a", expect: "proposal", deadline_hint: "today" },
  proposal: { title: "P", answer: "A", rationale: "R", risks: [], confidence: 0.7, asks: [] },
  delegation: { work: "W", acceptance: ["done"], return: "deliverable", notes: "" },
  deliverable: { result: "R", artifacts: [], notes: "", confidence: 0.8 },
  review: { verdict: "accept", notes: "", points: [] },
  decision: { decision: "D", rationale: "", confidence: 0.7, dissent: null, accepted_proposals: [] },
};

/**
 * A scripted plain provider: per-kind reply queues, strict-valid fallback.
 * Deliberately WITHOUT `chatWithTools` so repair scenarios stay on the exact
 * plain request path.
 */
class ScriptedProvider implements Provider {
  private readonly queues: Record<string, string[]>;

  constructor(scripts: Record<string, string[]> = {}) {
    this.queues = Object.fromEntries(
      Object.entries(scripts).map(([kind, replies]) => [kind, [...replies]]),
    );
  }

  async chat(_messages: ChatMessage[], responseKind = "message"): Promise<string> {
    const queue = this.queues[responseKind];
    if (queue !== undefined && queue.length > 0) return queue.shift()!;
    return JSON.stringify(VALID[responseKind] ?? { text: "ok" });
  }
}

/**
 * Records every request, then delegates to the inner provider unchanged.
 * `chatWithTools` is exposed ONLY when the inner provider has it, so the
 * harness's tool-capability gate sees the inner provider's true shape.
 */
function recordingProvider(
  inner: Provider,
  role: "senior" | "junior",
): Provider & { calls: ScenarioCall[] } {
  const calls: ScenarioCall[] = [];
  const tracked = inner as Provider & { usageSnapshot?: () => UsageTotals };
  const base = {
    calls,
    usageSnapshot: (): UsageTotals =>
      typeof tracked.usageSnapshot === "function" ? tracked.usageSnapshot() : emptyUsage(),
    chat: async (
      messages: ChatMessage[],
      responseKind = "message",
      signal?: AbortSignal,
      options?: Parameters<Provider["chat"]>[3],
    ): Promise<string> => {
      calls.push({
        role,
        channel: "chat",
        kind: responseKind,
        messages: messages.map((message) => ({ ...message })),
        tools: [],
      });
      return inner.chat(messages, responseKind, signal, options);
    },
  };
  if (inner.chatWithTools === undefined) return base;
  const innerChatWithTools = inner.chatWithTools.bind(inner);
  return {
    ...base,
    chatWithTools: async (
      messages: ChatMessage[],
      tools: Tool[],
      options: ToolChatOptions = {},
    ): Promise<ToolChatResponse> => {
      calls.push({
        role,
        channel: "tools",
        kind: options.responseKind ?? "",
        messages: messages.map((message) => ({ ...message })),
        tools: tools.map((tool) => tool.name),
      });
      return innerChatWithTools(messages, tools, options);
    },
  };
}

/** The fixed fake read-only tool the belt scenarios offer (never executed). */
function fixtureTool(): Tool {
  return {
    name: "notes_lookup",
    description: "Look up a migration note by name (modebytes fixture).",
    parameters: { type: "object", properties: { name: { type: "string" } } },
    execute: () => JSON.stringify({ tool: "notes_lookup", status: "ok", note: "dual-write first" }),
  };
}

interface ScenarioSpec {
  mode: "consult" | "work";
  belt: boolean;
  /** Per-role per-kind scripted `chat` replies (repair scenarios). */
  scripts?: { senior?: Record<string, string[]>; junior?: Record<string, string[]> };
}

const SCENARIOS: Record<string, ScenarioSpec> = {
  "consult-mock": { mode: "consult", belt: false },
  "work-mock": { mode: "work", belt: false },
  "consult-mock-belt": { mode: "consult", belt: true },
  "work-mock-belt": { mode: "work", belt: true },
  "consult-repair": {
    mode: "consult",
    belt: false,
    scripts: {
      senior: {
        consult: ["I would rather just answer this myself without asking the junior."],
      },
    },
  },
  "work-repair": {
    mode: "work",
    belt: false,
    scripts: {
      junior: {
        deliverable: ["The work is basically done, trust me."],
      },
    },
  },
};

export const SCENARIO_NAMES: readonly string[] = Object.keys(SCENARIOS);

/** Run one canonical scenario and return its deterministic projection. */
export async function runScenario(name: string): Promise<ScenarioOutcome> {
  const spec = SCENARIOS[name];
  if (spec === undefined) throw new Error(`unknown modebytes scenario: ${name}`);
  const cfg = resolveConfig({ provider: "mock", mode: spec.mode });

  const seniorInner: Provider =
    spec.scripts?.senior !== undefined ? new ScriptedProvider(spec.scripts.senior) : new MockProvider();
  const juniorInner: Provider =
    spec.scripts?.junior !== undefined ? new ScriptedProvider(spec.scripts.junior) : new MockProvider();
  const senior = recordingProvider(seniorInner, "senior");
  const junior = recordingProvider(juniorInner, "junior");

  const harness = new TwoBrothersHarness(cfg, {
    senior,
    junior,
    ...(spec.belt ? { toolScopes: { shared: [fixtureTool()] } } : {}),
  });
  const result = await harness.run(MODEBYTES_TASK);

  // Merge the two recorders in call order: the harness serializes same-session
  // runs, but the two roles interleave by node — rebuild the true order from
  // the prompt audit trail (one entry per provider request, in call order).
  const merged: ScenarioCall[] = [];
  const seniorQueue = [...senior.calls];
  const juniorQueue = [...junior.calls];
  for (const audit of result.promptAudits) {
    const queue = audit.role === "senior" ? seniorQueue : juniorQueue;
    const call = queue.shift();
    if (call === undefined) throw new Error(`modebytes: missing recorded call for ${audit.role}/${audit.kind}`);
    merged.push(call);
  }
  if (seniorQueue.length > 0 || juniorQueue.length > 0) {
    throw new Error("modebytes: recorded calls left over after the audit merge");
  }

  return {
    calls: merged,
    transcript: result.context.renderTranscript(),
    envelopes: result.messages.map((message) => ({
      seq: message.seq,
      from: message.from,
      to: message.to,
      kind: message.kind,
      payload: message.payload,
    })),
    decision: result.decision,
    rounds: result.rounds,
    errors: result.errors,
    warnings: result.warnings,
  };
}
