/**
 * Model providers. Mirrors the original prototype's provider module (removed
 * 2026-11-04; see git history) and PROTOCOL.md §11.
 */
import type { ChatMessage } from "./context.ts";
import { extractTask } from "./context.ts";

export interface Provider {
  chat(messages: ChatMessage[], responseKind: string): Promise<string>;
}

export interface ProviderConfig {
  provider: string;
  baseUrl: string;
  apiKey: string;
  seniorModel: string;
  juniorModel: string;
  temperature: number;
  timeout: number;
}

export class OpenAICompatibleProvider implements Provider {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly temperature: number;
  readonly timeout: number;

  constructor(cfg: ProviderConfig & { model: string }) {
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, "");
    this.apiKey = cfg.apiKey ?? "";
    this.model = cfg.model;
    this.temperature = cfg.temperature;
    this.timeout = cfg.timeout;
  }

  async chat(messages: ChatMessage[], _responseKind = "message"): Promise<string> {
    const url = `${this.baseUrl}/chat/completions`;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout * 1000);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: this.model, messages, temperature: this.temperature }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`HTTP ${response.status} from ${url}: ${detail || response.statusText}`);
      }
      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = data.choices?.[0]?.message?.content;
      if (content === undefined) {
        throw new Error(`unexpected response shape from ${url}: ${JSON.stringify(data)}`);
      }
      return content;
    } finally {
      clearTimeout(timer);
    }
  }
}

function clip(text: string, limit = 120): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length <= limit ? collapsed : collapsed.slice(0, limit - 1) + "…";
}

export class MockProvider implements Provider {
  async chat(messages: ChatMessage[], responseKind = "message"): Promise<string> {
    const text = messages.length > 0 ? String(messages[messages.length - 1].content ?? "") : "";
    const task = extractTask(text);
    const quoted = task ? clip(task) : "(no task)";
    const kind = responseKind || "message";

    let payload: Record<string, unknown>;
    if (kind === "consult") {
      payload = {
        task: quoted,
        ask: `What is the best way to solve the task: «${quoted}»?`,
        expect: "proposal",
        deadline_hint: "within the day",
      };
    } else if (kind === "delegation") {
      payload = {
        work: `Do part of the task: «${quoted}»`,
        acceptance: ["done", "checked against the criteria"],
        return: "deliverable",
        notes: "",
      };
    } else if (kind === "proposal") {
      payload = {
        title: `Plan for «${quoted}»`,
        answer: `For the task «${quoted}» I propose a step-by-step plan: first clarify the goals, then choose the approach, then implement and verify.`,
        rationale: "A step-by-step approach reduces risk and gives checkpoints.",
        risks: ["Incomplete requirements", "Shifting priorities"],
        confidence: 0.7,
        asks: ["Can we clarify the priorities?", "Are additional resources needed?"],
      };
    } else if (kind === "deliverable") {
      payload = {
        result: `Part of the task «${quoted}» is done: a prototype is written and a test is added.`,
        artifacts: ["proto.py", "test_proto.py"],
        notes: "Checked against the senior's criteria.",
        confidence: 0.8,
      };
    } else if (kind === "review") {
      const verdict = this.reviewVerdict(text);
      payload = {
        verdict,
        notes:
          verdict === "accept"
            ? "The proposal meets the criteria."
            : "Needs rework: add clarifications and a check.",
        points: verdict === "accept" ? [] : ["Collapse the details"],
      };
    } else if (kind === "decision") {
      payload = {
        decision: `Final decision on «${quoted}»: accept the junior's proposal with amendments, execute step by step and verify each step.`,
        rationale: "The senior took the junior's advice on step-by-step execution into account and checked it against the criteria.",
        confidence: 0.82,
        dissent: null,
        accepted_proposals: [`Plan for «${quoted}»`],
      };
    } else {
      payload = { text: quoted };
    }

    return JSON.stringify(payload);
  }

  private reviewVerdict(transcript: string): "accept" | "revise" {
    for (const needle of [
      '"verdict": "revise"',
      '"verdict":"revise"',
      '"verdict": "reject"',
      '"verdict":"reject"',
    ]) {
      if (transcript.includes(needle)) return "revise";
    }
    return "accept";
  }
}

export function buildProvider(cfg: ProviderConfig, role: string): Provider {
  if (cfg.provider === "mock") return new MockProvider();
  if (cfg.provider === "openai") {
    const model = role === "senior" ? cfg.seniorModel : cfg.juniorModel;
    return new OpenAICompatibleProvider({ ...cfg, model });
  }
  throw new Error(`unknown provider: ${cfg.provider}`);
}
