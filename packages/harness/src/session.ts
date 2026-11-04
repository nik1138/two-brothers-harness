/**
 * JSONL session persistence for the shared context.
 * Mirrors the original prototype's session module (removed 2026-11-04; see
 * git history).
 *
 * One envelope per line; every append is flushed immediately, so a crashed or
 * killed run still leaves a valid, replayable log. Loading returns the
 * envelopes in file order; they can be fed back through
 * `SharedContext.append` to rebuild the context (`seq` is derived from the
 * event count, so numbering continues).
 */
import * as fs from "node:fs";
import type { Message } from "./protocol.ts";
import { SharedContext } from "./context.ts";

export class SessionError extends Error {}

export class SessionStore {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  exists(): boolean {
    return fs.existsSync(this.path);
  }

  load(): Message[] {
    if (!this.exists()) return [];
    let text: string;
    try {
      text = fs.readFileSync(this.path, "utf-8");
    } catch (exc) {
      throw new SessionError(`cannot read session file ${this.path}: ${exc}`);
    }
    const events: Message[] = [];
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch (exc) {
        throw new SessionError(`corrupt session file ${this.path}, line ${i + 1}: ${exc}`);
      }
      if (typeof msg !== "object" || msg === null || Array.isArray(msg)) {
        throw new SessionError(`corrupt session file ${this.path}, line ${i + 1}: expected a JSON object`);
      }
      events.push(msg as Message);
    }
    return events;
  }

  append(msg: Message): void {
    const line = JSON.stringify(msg);
    try {
      fs.appendFileSync(this.path, line + "\n", "utf-8");
    } catch (exc) {
      throw new SessionError(`cannot write session file ${this.path}: ${exc}`);
    }
  }

  /**
   * Replace the whole file with `messages` (one envelope per line), used by
   * context compaction. Write-then-rename — a crash mid-write leaves either
   * the old file or the new one, never a torn JSONL (the technique pi's JSONL
   * storage uses for sidecar reclaim; see
   * research/harnesses/pi-durable-mcp-chord.md). Callers keep the JSONL
   * contract: dense `seq`, one envelope per line.
   */
  rewrite(messages: Message[]): void {
    const text = messages.map((msg) => JSON.stringify(msg)).join("\n") + "\n";
    const tmpPath = `${this.path}.tmp-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
    try {
      fs.writeFileSync(tmpPath, text, "utf-8");
      fs.renameSync(tmpPath, this.path);
    } catch (exc) {
      try {
        fs.rmSync(tmpPath, { force: true });
      } catch {
        // best-effort temp cleanup
      }
      throw new SessionError(`cannot rewrite session file ${this.path}: ${exc}`);
    }
  }
}

/**
 * Rebuild a validated context from a session file.
 *
 * The events are validated through a throwaway context and then attached to a
 * fresh one that persists to `store` — loaded events are not written back, so
 * resuming never duplicates lines.
 */
export function restoreContext(store: SessionStore): SharedContext {
  const loaded = new SharedContext();
  for (const msg of store.load()) {
    loaded.append(msg); // validates; throws on a bad envelope
  }
  const ctx = new SharedContext(store);
  ctx.events = loaded.events;
  return ctx;
}
