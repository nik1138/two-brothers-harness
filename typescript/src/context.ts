/**
 * The shared, append-only context that both brothers see.
 * Mirrors the original prototype's context module (removed 2026-11-04; see
 * git history) and PROTOCOL.md section 2.
 */
import type { Message } from "./protocol.ts";
import { createMessage, validateMessage } from "./protocol.ts";
import type { SessionStore } from "./session.ts";

const TASK_START = "[[TASK]]";
const TASK_END = "[[/TASK]]";

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

export class SharedContext {
  events: Message[] = [];
  store: SessionStore | null;

  constructor(store: SessionStore | null = null) {
    this.store = store;
  }

  nextSeq(): number {
    return this.events.length + 1;
  }

  append(msg: Message): Message {
    const next: Message = { ...msg };
    if (!next.seq) next.seq = this.nextSeq();
    if (!next.v) next.v = 1;
    if (!next.ts) next.ts = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const errors = validateMessage(next);
    if (errors.length > 0) {
      throw new Error(`invalid message appended to context: ${errors.join("; ")}`);
    }
    this.events.push(next);
    if (this.store !== null) this.store.append(next);
    return next;
  }

  makeAndAppend(fromRole: string, toRole: string, kind: string, payload: Record<string, unknown>): Message {
    return this.append(createMessage(this.nextSeq(), fromRole, toRole, kind, payload));
  }

  renderTranscript(): string {
    const taskLines: string[] = [];
    for (const event of this.events) {
      if (event.from === "user" && event.kind === "message") {
        taskLines.push(String(event.payload.text ?? ""));
      }
    }
    const task = taskLines[0] ?? "";
    const lines = [TASK_START, task, TASK_END, "", "Context events:"];
    for (const event of this.events) {
      const payload = JSON.stringify(event.payload);
      lines.push(`[${event.seq}] [${event.from} -> ${event.to}] ${event.kind}: ${payload}`);
    }
    return lines.join("\n");
  }

  renderForRole(role: string, systemPrompt: string): ChatMessage[] {
    const transcript = this.renderTranscript();
    return [
      { role: "system", content: systemPrompt },
      { role: "user", content: transcript },
    ];
  }

  renderForUser(): string {
    const lines = [this.renderTranscript(), "", "Exchange history:"];
    for (const event of this.events) {
      lines.push(`  [${event.seq}] ${event.from} -> ${event.to}: ${JSON.stringify(event.payload)}`);
    }
    return lines.join("\n");
  }
}

export function extractTask(text: string): string {
  const start = text.indexOf(TASK_START);
  const end = text.indexOf(TASK_END);
  if (start !== -1 && end !== -1 && end > start) {
    return text.slice(start + TASK_START.length, end).trim();
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed && trimmed !== TASK_START && trimmed !== TASK_END) return trimmed;
  }
  return "";
}
