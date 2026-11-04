/**
 * The cooperation loop. Mirrors the original prototype's graph (removed
 * 2026-11-04; see git history) and PROTOCOL.md §5.
 */
import type { Config } from "./config.ts";
import { SharedContext } from "./context.ts";
import { loadPrompts } from "./prompts.ts";
import { createMessage, parseModelOutput, type Message } from "./protocol.ts";
import { buildProvider, type Provider } from "./provider.ts";

const FALLBACK_TEXT = "The model did not return a structured reply; using the text as is.";

const ALLOWED_KEYS: Record<string, string[]> = {
  consult: ["task", "ask", "expect", "deadline_hint"],
  proposal: ["title", "answer", "rationale", "risks", "confidence", "asks"],
  delegation: ["work", "acceptance", "return", "notes"],
  deliverable: ["result", "artifacts", "notes", "confidence"],
  review: ["verdict", "notes", "points"],
  decision: ["decision", "rationale", "confidence", "dissent", "accepted_proposals"],
  message: ["text"],
};

function asList(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.map((v) => String(v));
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function asConfidence(value: unknown): number {
  const num = Number(value);
  if (Number.isNaN(num)) return 0.5;
  return Math.max(0, Math.min(1, num));
}

function taskOf(ctx: SharedContext): string {
  for (const event of ctx.events) {
    if (event.from === "user" && event.kind === "message") {
      return String(event.payload.text ?? "");
    }
  }
  return "";
}

export function sanitizePayload(
  kind: string,
  payload: Record<string, unknown> | null | undefined,
  text: string,
  task = "",
): Record<string, unknown> {
  const data: Record<string, unknown> =
    payload && typeof payload === "object" ? { ...payload } : {};
  const allowed = ALLOWED_KEYS[kind];
  if (allowed) {
    for (const key of Object.keys(data)) {
      if (!allowed.includes(key)) delete data[key];
    }
  }

  if (kind === "consult") {
    if (data.task === undefined) data.task = task;
    if (data.ask === undefined) data.ask = text.trim() || "Please give a proposal.";
    if (data.expect === undefined) data.expect = "proposal";
  } else if (kind === "proposal") {
    if (data.title === undefined) data.title = "Proposal";
    if (data.answer === undefined) data.answer = text.trim() || FALLBACK_TEXT;
    data.risks = asList(data.risks);
    data.asks = asList(data.asks);
    data.confidence = asConfidence(data.confidence);
  } else if (kind === "delegation") {
    if (data.work === undefined) data.work = task || text.trim();
    data.acceptance = asList(data.acceptance);
    if (data.acceptance.length === 0) data.acceptance = ["done"];
    if (data.return === undefined) data.return = "deliverable";
  } else if (kind === "deliverable") {
    if (data.result === undefined) data.result = text.trim() || FALLBACK_TEXT;
    data.artifacts = asList(data.artifacts);
    data.confidence = asConfidence(data.confidence);
  } else if (kind === "review") {
    if (!["accept", "revise", "reject"].includes(String(data.verdict))) data.verdict = "accept";
    if (data.notes === undefined) data.notes = "";
    data.points = asList(data.points);
  } else if (kind === "decision") {
    if (data.decision === undefined) data.decision = text.trim() || FALLBACK_TEXT;
    if (data.rationale === undefined) data.rationale = "";
    data.confidence = asConfidence(data.confidence);
    if (data.dissent === undefined) data.dissent = null;
    data.accepted_proposals = asList(data.accepted_proposals);
  } else if (kind === "message") {
    if (data.text === undefined) data.text = text.trim();
  }
  return data;
}

export interface HarnessResult {
  task: string;
  messages: Message[];
  decision: Record<string, unknown>;
  rounds: number;
  context: SharedContext;
  errors: string[];
}

export class TwoBrothersHarness {
  readonly cfg: Config;
  readonly providers: Record<string, Provider>;
  private readonly prompts = loadPrompts();
  lastErrors: string[] = [];

  constructor(cfg: Config) {
    this.cfg = cfg;
    this.providers = {
      senior: buildProvider(cfg, "senior"),
      junior: buildProvider(cfg, "junior"),
    };
  }

  systemPrompt(role: string): string {
    if (role === "senior") return this.cfg.seniorSystem || this.prompts.senior;
    return this.cfg.juniorSystem || this.prompts.junior;
  }

  private async ask(
    ctx: SharedContext,
    role: string,
    responseKind: string,
  ): Promise<Record<string, unknown>> {
    const messages = ctx.renderForRole(role, this.systemPrompt(role));
    const text = await this.providers[role].chat(messages, responseKind);
    const parsed = parseModelOutput(text, responseKind);
    if (parsed.parseFailed) {
      this.lastErrors.push(`${role}.${responseKind}: unstructured model reply`);
    }
    return sanitizePayload(responseKind, parsed.payload, text, taskOf(ctx));
  }

  async run(task: string, context?: SharedContext): Promise<HarnessResult> {
    const ctx = context ?? new SharedContext();
    const messages: Message[] = [
      ctx.append(createMessage(ctx.nextSeq(), "user", "senior", "message", { text: task })),
    ];
    let rounds = 0;

    const mode = this.cfg.mode;
    const seniorKind = mode === "work" ? "delegation" : "consult";

    // 1) Senior reaches out to junior.
    const firstPayload = await this.ask(ctx, "senior", seniorKind);
    messages.push(ctx.makeAndAppend("senior", "junior", seniorKind, firstPayload));

    // 2) Junior answers with a proposal or a deliverable.
    const juniorKind = seniorKind === "delegation" ? "deliverable" : "proposal";
    const juniorPayload = await this.ask(ctx, "junior", juniorKind);
    messages.push(ctx.makeAndAppend("junior", "senior", juniorKind, juniorPayload));

    // 3) Senior reviews.
    let payload = await this.ask(ctx, "senior", "review");
    messages.push(ctx.makeAndAppend("senior", "junior", "review", payload));
    let verdict = String(payload.verdict ?? "accept");

    // 4) Revise loop.
    while (verdict !== "accept" && rounds < this.cfg.maxRounds) {
      rounds += 1;
      const proposal = await this.ask(ctx, "junior", "proposal");
      messages.push(ctx.makeAndAppend("junior", "senior", "proposal", proposal));
      payload = await this.ask(ctx, "senior", "review");
      messages.push(ctx.makeAndAppend("senior", "junior", "review", payload));
      verdict = String(payload.verdict ?? "accept");
    }

    // 5) Senior makes the final decision.
    const decision = await this.ask(ctx, "senior", "decision");
    messages.push(ctx.makeAndAppend("senior", "user", "decision", decision));

    return {
      task,
      messages,
      decision,
      rounds,
      context: ctx,
      errors: [...this.lastErrors],
    };
  }
}
