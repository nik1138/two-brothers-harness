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
 *
 * Torn-tail rule (vendor scout F3): the one defect a crash mid-append can
 * leave behind is an unparseable final non-empty fragment. Reading tolerates
 * exactly that fragment — it is dropped in memory and the complete prefix is
 * returned. An owner that will APPEND (`restoreContext`, `loadForAppend`)
 * additionally truncates the file atomically to the last complete newline so
 * the next envelope never lands after a fragment. Read-only listing/search/
 * export call `loadDetailed()` and never rewrite the file. Interior
 * corruption (a bad non-final record) is still a typed `SessionError` naming
 * the line; only the final fragment is recoverable.
 */
import * as fs from "node:fs";
import type { Message } from "./protocol.ts";
import { SharedContext } from "./context.ts";

export class SessionError extends Error {}

/** Additive torn-tail recovery detail returned by the load helpers. */
export interface SessionRecovery {
  /** True when only the final non-empty JSONL fragment was unparseable. */
  recovered: boolean;
  /** Bytes dropped from the logical end of the file; 0 when none. */
  droppedBytes: number;
  /** 1-based physical line number of the dropped fragment; 0 when none. */
  droppedLine: number;
}

/** Result of `SessionStore.loadDetailed()` (`load()` stays a `Message[]`). */
export interface SessionLoadResult extends SessionRecovery {
  events: Message[];
}

/** Result of `restoreContextResult()`; `context` is bound to the store. */
export interface RestoreContextResult extends SessionRecovery {
  context: SharedContext;
}

/** Internal scan result: the public fields plus the raw bytes and offsets. */
interface SessionScan extends SessionLoadResult {
  buffer: Buffer;
  /** Exclusive byte offset just past the last `\n` (0 when there is none). */
  lastCompleteEnd: number;
  /** True when the file is empty or its final byte is `\n`. */
  endsWithNewline: boolean;
}

/**
 * One bounded, actionable warning for a recovered torn tail. The torn fragment
 * itself is never included — only its line number and byte count.
 */
export function sessionRecoveryWarning(path: string, recovery: SessionRecovery): string {
  return (
    `recovered session ${path}: dropped a torn final line ${recovery.droppedLine} ` +
    `(${recovery.droppedBytes} bytes) and truncated to the last complete envelope`
  );
}

export class SessionStore {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  exists(): boolean {
    return fs.existsSync(this.path);
  }

  /**
   * Read the envelopes in file order.
   *
   * A file whose ONLY defect is an unparseable final non-empty fragment (a
   * crash mid-append) yields its complete prefix: the fragment is dropped in
   * memory only — this read path never rewrites the file. Use
   * `loadDetailed()` when the caller needs to report the recovery.
   */
  load(): Message[] {
    return this.loadDetailed().events;
  }

  /** `load()` plus the additive torn-tail recovery detail. Read-only. */
  loadDetailed(): SessionLoadResult {
    const scan = this.scan();
    return {
      events: scan.events,
      recovered: scan.recovered,
      droppedBytes: scan.droppedBytes,
      droppedLine: scan.droppedLine,
    };
  }

  /**
   * Strict read for destructive, non-append operations (rewind): a torn final
   * fragment is NOT recovered here — it raises the same line-numbered
   * `SessionError` as interior corruption, so the caller refuses before any
   * rewrite. Append/resume paths use `loadForAppend()` instead.
   */
  loadStrict(): Message[] {
    return this.scan(false).events;
  }

  /**
   * Load for an owner that will append to this file (`--resume`, a TUI
   * session switch, a resumed server run).
   *
   * Repair rule: an unparseable FINAL fragment is dropped and the file is
   * truncated atomically (temp file + rename in the same directory) to the
   * last complete newline, so the next append never sits after a fragment and
   * future reads never see an interior corrupt line. A valid final envelope
   * whose line lacks its trailing newline is KEPT and exactly one newline is
   * added the same way (that is not corruption). Empty/whitespace-only files
   * and a clean file are left byte-identical. Read-only listing/search/export
   * use `loadDetailed()`, never this method.
   */
  loadForAppend(): SessionLoadResult {
    const scan = this.scan();
    if (scan.recovered) {
      // Keep the raw prefix through the last complete newline; CRLF/BOM and
      // any blank lines stay byte-identical.
      this.rewritePrefixAtomically(scan.buffer.subarray(0, scan.lastCompleteEnd), false, scan.buffer.length);
    } else if (scan.events.length > 0 && !scan.endsWithNewline) {
      // A complete, valid final envelope without its newline is not a tear,
      // but appending after it would merge two JSON objects onto one line.
      this.rewritePrefixAtomically(scan.buffer, true, scan.buffer.length);
    }
    return {
      events: scan.events,
      recovered: scan.recovered,
      droppedBytes: scan.droppedBytes,
      droppedLine: scan.droppedLine,
    };
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
   * Scan the file once, byte-addressed so the torn fragment can be measured
   * and truncated exactly. Empty lines and whitespace-only trailing lines are
   * skipped (not corruption). Any unparseable/ non-object line other than an
   * unterminated final fragment raises a line-numbered `SessionError`.
   */
  private scan(recoverFinal = true): SessionScan {
    if (!this.exists()) {
      return {
        events: [],
        recovered: false,
        droppedBytes: 0,
        droppedLine: 0,
        buffer: Buffer.alloc(0),
        lastCompleteEnd: 0,
        endsWithNewline: true,
      };
    }
    let buffer: Buffer;
    try {
      buffer = fs.readFileSync(this.path);
    } catch (exc) {
      throw new SessionError(`cannot read session file ${this.path}: ${exc}`);
    }

    const events: Message[] = [];
    let lineNumber = 1;
    let start = 0;
    let lastCompleteEnd = 0;
    for (;;) {
      const newline = buffer.indexOf(0x0a, start);
      if (newline === -1) break;
      const msg = this.parseLine(buffer.subarray(start, newline), lineNumber);
      if (msg !== null) events.push(msg);
      lastCompleteEnd = newline + 1;
      start = newline + 1;
      lineNumber += 1;
    }

    let recovered = false;
    let droppedBytes = 0;
    let droppedLine = 0;
    const fragment = buffer.subarray(start);
    const fragmentText = fragment.toString("utf-8").trim();
    if (fragmentText) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(fragmentText);
      } catch (exc) {
        // The only recoverable defect: the final fragment has no terminator
        // and no parseable object (a crash wrote part of one envelope).
        if (!recoverFinal) {
          throw new SessionError(
            `corrupt session file ${this.path}, line ${lineNumber}: ${exc}`,
          );
        }
        recovered = true;
        droppedBytes = buffer.length - start;
        droppedLine = lineNumber;
        parsed = undefined;
      }
      if (recovered) {
        // Nothing to add; the prefix already ends at the last complete line.
      } else if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new SessionError(
          `corrupt session file ${this.path}, line ${lineNumber}: expected a JSON object`,
        );
      } else {
        events.push(parsed as Message);
      }
    }

    return {
      events,
      recovered,
      droppedBytes,
      droppedLine,
      buffer,
      lastCompleteEnd,
      endsWithNewline: buffer.length === 0 || buffer[buffer.length - 1] === 0x0a,
    };
  }

  /** Parse one newline-terminated line; blank lines return `null`. */
  private parseLine(raw: Buffer, lineNumber: number): Message | null {
    const line = raw.toString("utf-8").trim();
    if (!line) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (exc) {
      throw new SessionError(`corrupt session file ${this.path}, line ${lineNumber}: ${exc}`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new SessionError(`corrupt session file ${this.path}, line ${lineNumber}: expected a JSON object`);
    }
    return parsed as Message;
  }

  /**
   * Write `prefix` (+ an optional newline) to a temp file in the same
   * directory and rename it over the session. A concurrent append between our
   * scan and the rename makes the rename a no-op failure instead of clobbering
   * bytes we did not read: the caller retries (`SessionError`).
   */
  private rewritePrefixAtomically(prefix: Buffer, addNewline: boolean, expectedSize: number): void {
    const tmpPath = `${this.path}.tmp-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
    try {
      const fd = fs.openSync(tmpPath, "w");
      try {
        if (prefix.length > 0) fs.writeSync(fd, prefix);
        if (addNewline) fs.writeSync(fd, Buffer.from("\n", "utf-8"));
      } finally {
        fs.closeSync(fd);
      }
      if (fs.statSync(this.path).size !== expectedSize) {
        throw new Error("session file changed while repairing the torn tail; retry");
      }
      fs.renameSync(tmpPath, this.path);
    } catch (exc) {
      try {
        fs.rmSync(tmpPath, { force: true });
      } catch {
        // best-effort temp cleanup
      }
      throw new SessionError(`cannot repair session file ${this.path}: ${exc}`);
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
 * Rebuild a validated context from a session file, with the additive
 * torn-tail recovery detail.
 *
 * This is an append-for-append path: `loadForAppend()` first repairs a torn
 * final fragment (temp file + rename, see its contract), then the events are
 * validated through a throwaway context and attached to a fresh one that
 * persists to `store` — loaded events are not written back, so resuming never
 * duplicates lines.
 */
export function restoreContextResult(store: SessionStore): RestoreContextResult {
  const loaded = new SharedContext();
  const result = store.loadForAppend();
  for (const msg of result.events) {
    loaded.append(msg); // validates; throws on a bad envelope
  }
  const ctx = new SharedContext(store);
  ctx.events = loaded.events;
  return {
    context: ctx,
    recovered: result.recovered,
    droppedBytes: result.droppedBytes,
    droppedLine: result.droppedLine,
  };
}

/** `restoreContextResult()` without the recovery detail (compatibility form). */
export function restoreContext(store: SessionStore): SharedContext {
  return restoreContextResult(store).context;
}
