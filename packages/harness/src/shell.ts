/**
 * Bounded shell command execution for the workspace. Ports the original
 * prototype's shell runner (removed 2026-11-04; see git history).
 *
 * Commands run with `bash -c` when a bash executable is on PATH (the
 * project's documented shell on Windows is Git Bash); otherwise they fall
 * back to the platform default shell. Every run is constrained by a timeout
 * and an output cap, and can be cancelled cooperatively through an
 * `AbortSignal`.
 *
 * Output is bounded while it streams: each `data` chunk is decoded
 * incrementally (a `StringDecoder` keeps split UTF-8 sequences whole) and
 * sanitized with the same escape/control coverage as `output.ts`, then fed
 * to a head+tail accumulator that retains at most the output cap. A command
 * like `yes` therefore costs O(cap) memory, not O(command lifetime).
 *
 * Cleanup kills the whole process tree: on Windows via the absolute
 * `%SystemRoot%\System32\taskkill.exe` (never a PATH lookup, so a workspace
 * cannot plant a same-named executable) spawned asynchronously with ignored
 * stdio and a bounded wait, with `child.kill()` as the fallback; on POSIX
 * via `killpg` (the child is spawned detached, i.e. in its own session, so
 * `process.kill(-pid, "SIGKILL")` reaps the group). Python creates the
 * Windows child with CREATE_NEW_PROCESS_GROUP; Node cannot pass raw
 * creation flags, but `taskkill /T` walks the tree regardless, so nothing
 * is lost.
 *
 * Results are plain objects with a stable shape (status/exit_code/stdout/
 * stderr/truncated/duration_ms) so they can be appended to JSONL session
 * files or streamed over SSE without further adaptation.
 */
import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { StringDecoder } from "node:string_decoder";
import { sanitizeOutput } from "./output.ts";

export const DEFAULT_TIMEOUT_S = 30.0;
export const DEFAULT_MAX_OUTPUT_CHARS = 20_000;
export const KILL_GRACE_S = 2.0;
/**
 * Upper bound for the post-kill drain (`drainAfterKill`). Callers that must
 * wait for a cancelled turn to unwind (the TUI shutdown, the CLI's per-turn
 * signal handling) size their budget from this constant so they never exit /
 * restore before `run_shell`'s kill + drain can finish.
 */
export const SHELL_DRAIN_BUDGET_MS = (KILL_GRACE_S + 5) * 1000;
/** Bounded wait for the async Windows tree-kill (much shorter than the old 10 s). */
export const TASKKILL_TIMEOUT_MS = 5_000;
/**
 * After the child exits, wait this long for stdio `close` before returning.
 * Normal commands close the pipes immediately; a background grandchild that
 * inherited them cannot pin the tool call forever.
 */
export const EXIT_CLOSE_GRACE_MS = 250;

export const STATUS_OK = "ok";
export const STATUS_ERROR = "error";
export const STATUS_TIMEOUT = "timeout";
export const STATUS_CANCELLED = "cancelled";

/** Stable result shape (field order matches Python's ShellResult.to_dict). */
export interface ShellResult {
  command: string;
  status: string;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  duration_ms: number;
  timed_out: boolean;
  cancelled: boolean;
  error: string;
}

/**
 * A never-terminated escape sequence is emitted as-is once it exceeds this;
 * the carry itself is therefore bounded too.
 */
const MAX_ESCAPE_CARRY_CHARS = 8_192;

/**
 * Prefixes of a *complete* 7-bit escape sequence, i.e. sequences whose
 * remaining bytes can still arrive in a later chunk: a bare ESC, a CSI
 * header without its final byte, an ESC + intermediate bytes without the
 * final byte, and a string-form opener (`OSC`/`DCS`/`APC`/`PM`/`SOS`) before
 * its `BEL`/`ST` terminator — including a trailing ESC that may be the first
 * half of `ST` (`ESC \`).
 */
const INCOMPLETE_ESCAPE_PATTERNS: readonly RegExp[] = [
  /^\x1b$/,
  /^\x1b\[[\x30-\x3f]*[\x20-\x2f]*$/,
  /^\x1b[\x20-\x2f]+$/,
  /^\x1b[\]PX^_][^\x07\x1b]*\x1b?$/,
];

/** Start index of an escape sequence that is still waiting for bytes, or -1. */
function incompleteEscapeStart(text: string): number {
  const escape = text.lastIndexOf("\x1b");
  if (escape < 0) return -1;
  const suffix = text.slice(escape);
  return INCOMPLETE_ESCAPE_PATTERNS.some((pattern) => pattern.test(suffix))
    ? escape
    : -1;
}

/**
 * Sanitize a decoded stream chunk by chunk. A sequence can straddle a chunk
 * boundary (e.g. `ESC` at the end of one write, `[31m` at the start of the
 * next), so an incomplete trailing sequence is carried into the next chunk —
 * but only while it is genuinely incomplete. An earlier version carried
 * everything from the last `ESC` onward, which split a *terminated* string
 * sequence at its `ESC \` terminator and leaked the OSC payload (a window
 * title, an OSC-8 URL) into the tool result; sanitizing the whole text
 * whenever the tail cannot continue keeps `sanitizeOutput`'s whole-sequence
 * coverage intact.
 */
class StreamingSanitizer {
  private pending = "";

  push(text: string): string {
    if (!text) return "";
    const combined = this.pending + text;
    this.pending = "";
    const start = incompleteEscapeStart(combined);
    if (start >= 0 && combined.length - start <= MAX_ESCAPE_CARRY_CHARS) {
      this.pending = combined.slice(start);
      return sanitizeOutput(combined.slice(0, start));
    }
    return sanitizeOutput(combined);
  }

  /** Flush the carried tail; an unterminated escape sanitizes like the whole. */
  end(): string {
    const rest = this.pending;
    this.pending = "";
    return rest ? sanitizeOutput(rest) : "";
  }
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Head+tail window over a sanitized character stream with bounded memory.
 *
 * It reproduces the runner's established middle-truncation contract
 * (`<head>\n...[truncated N chars]...\n<tail>`, N = characters omitted) but
 * never retains more than `limit` characters while the command runs. The
 * retained edges are code-point safe: a surrogate pair split by the window
 * is dropped as a whole and counted in N, so the result never carries half
 * an emoji.
 */
export class BoundedOutput {
  private readonly limit: number;
  private readonly headLimit: number;
  private readonly tailLimit: number;
  private head = "";
  private tail = "";
  private total = 0;

  constructor(limit: number) {
    this.limit = limit;
    this.headLimit = Math.floor(limit / 2);
    this.tailLimit = limit - this.headLimit;
  }

  /** Characters currently retained (never more than the configured cap). */
  get retainedChars(): number {
    return this.head.length + this.tail.length;
  }

  push(text: string): void {
    if (!text) return;
    this.total += text.length;
    let rest = text;
    if (this.head.length < this.headLimit) {
      const take = Math.min(this.headLimit - this.head.length, rest.length);
      this.head += rest.slice(0, take);
      rest = rest.slice(take);
    }
    if (rest) {
      this.tail += rest;
      if (this.tail.length > this.tailLimit) {
        this.tail = this.tail.slice(this.tail.length - this.tailLimit);
      }
    }
  }

  finish(): { text: string; truncated: boolean } {
    if (this.total <= this.limit) {
      // No truncation: head+tail is the complete (short) stream.
      return { text: this.head + this.tail, truncated: false };
    }
    let head = this.head;
    let tail = this.tail;
    if (head.length > 0 && isHighSurrogate(head.charCodeAt(head.length - 1))) {
      head = head.slice(0, -1);
    }
    if (tail.length > 0 && isLowSurrogate(tail.charCodeAt(0))) {
      tail = tail.slice(1);
    }
    const omitted = this.total - head.length - tail.length;
    return {
      text: head + `\n...[truncated ${omitted} chars]...\n` + tail,
      truncated: true,
    };
  }
}

/** Find an executable on PATH, mirroring shutil.which for a plain name. */
function findOnPath(name: string): string | null {
  const exts = process.platform === "win32" ? [`${name}.exe`, name] : [name];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const candidate of exts) {
      const full = path.join(dir, candidate);
      try {
        fs.accessSync(full, fs.constants.X_OK);
        return full;
      } catch {
        // not here — keep searching
      }
    }
  }
  return null;
}

/**
 * Return the bash path if it can actually spawn, else null.
 *
 * Some sandboxed parents deny MSYS2 its shared-memory object and every
 * `bash -c` dies instantly (exit 0xC0000142 shows up as a nonzero spawnSync
 * status); in that case we silently fall back to the platform shell, exactly
 * like Python's `_probe_bash`.
 */
function probeBash(): string | null {
  const bash = findOnPath("bash");
  if (!bash) return null;
  try {
    const probe = spawnSync(bash, ["-c", "exit 0"], {
      stdio: "ignore",
      timeout: 10_000,
    });
    if (probe.error) return null;
    if (probe.status === 0) return bash;
  } catch {
    // fall through to the platform shell
  }
  return null;
}

/** The minimal child surface `killTree` needs from `spawn`. */
export interface TaskkillProcess {
  once(event: "error", listener: (error: Error) => void): unknown;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
}

export interface TaskkillOptions {
  stdio: "ignore";
  timeout: number;
  windowsHide: boolean;
}

/** Injectable spawn-like used by `killTree` (tests pass a fake). */
export type TaskkillSpawn = (
  file: string,
  args: readonly string[],
  options: TaskkillOptions,
) => TaskkillProcess;

export interface KillTreeOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  spawnTaskkill?: TaskkillSpawn;
  /** Override the bounded taskkill wait (tests only). */
  timeoutMs?: number;
}

/**
 * Resolve the system taskkill binary by absolute path.
 *
 * A bare `taskkill` is resolved through the usual Windows search order
 * (current directory included), so a workspace-planted `taskkill.exe` could
 * run with server privileges exactly when abort/timeout cleanup fires. The
 * SystemRoot/WINDIR environment is authoritative; only an absolute value is
 * trusted, with `C:\Windows` as the sane fallback when neither is set.
 */
export function resolveTaskkillPath(env: NodeJS.ProcessEnv = process.env): string {
  let root = "C:\\Windows";
  for (const candidate of [env.SystemRoot, env.WINDIR, env.windir]) {
    const value = candidate?.trim();
    if (value && path.win32.isAbsolute(value)) {
      root = value;
      break;
    }
  }
  return path.win32.join(root, "System32", "taskkill.exe");
}

const defaultTaskkillSpawn: TaskkillSpawn = (file, args, options) =>
  spawn(file, [...args], options) as unknown as TaskkillProcess;

/**
 * Kill a child's whole process tree, asynchronously and never throwing.
 *
 * Windows: spawn the absolute System32 taskkill with ignored stdio and a
 * bounded timeout, consume its async `error`, and fall back to
 * `child.kill()` when the spawn fails, the wait expires, or taskkill reports
 * failure. POSIX: signal the child's own process group. Cleanup is best
 * effort; callers must never observe an exception from it.
 */
export async function killTree(child: ChildProcess, options: KillTreeOptions = {}): Promise<void> {
  const fallbackKill = (): void => {
    try {
      child.kill();
    } catch {
      // already gone
    }
  };

  // The child exited on its own before cleanup ran: never signal a PID that
  // may already have been reused by an unrelated process. (POSIX keeps the
  // process-group kill below: the group can outlive its leader.)
  if ((options.platform ?? process.platform) !== "win32") {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
    } catch {
      // ESRCH / EPERM: the group is already gone
    }
    return;
  }

  if (child.exitCode != null || child.signalCode != null) return;

  const pid = child.pid;
  if (pid === undefined) {
    fallbackKill();
    return;
  }

  const timeoutMs = options.timeoutMs ?? TASKKILL_TIMEOUT_MS;
  const spawnTaskkill = options.spawnTaskkill ?? defaultTaskkillSpawn;

  await new Promise<void>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (useFallback: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (useFallback) fallbackKill();
      resolve();
    };

    // The timer is the hard bound even if taskkill's own timeout never fires.
    timer = setTimeout(() => finish(true), timeoutMs + 250);
    try {
      const killer = spawnTaskkill(resolveTaskkillPath(options.env), ["/F", "/T", "/PID", String(pid)], {
        stdio: "ignore",
        timeout: timeoutMs,
        windowsHide: true,
      });
      killer.once("error", () => finish(true));
      killer.once("exit", (code) => finish(code !== 0));
    } catch {
      finish(true);
    }
  });
}

export interface ShellRunnerOptions {
  cwd?: string;
  defaultTimeout?: number;
  maxOutputChars?: number;
  /** Full environment for the child; omitted = inherit (plus PATH_EXTRA). */
  env?: Record<string, string>;
  /**
   * Test seam: replace the child spawn. Omitted = `node:child_process.spawn`
   * with the normal `bash -c` / platform-shell shape. Production never sets
   * this; the streaming and cleanup tests use it to stay hermetic (some
   * sandboxes deny piped child spawns).
   */
  spawnChild?: ShellChildSpawn;
}

/** Injectable child spawn used by `ShellRunner` (tests pass a fake). */
export type ShellChildSpawn = (
  command: string,
  args: readonly string[] | undefined,
  options: SpawnOptions,
) => ChildProcess;

const defaultShellSpawn: ShellChildSpawn = (command, args, options) =>
  args === undefined ? spawn(command, options) : spawn(command, [...args], options);

export class ShellRunner {
  readonly cwd: string | undefined;
  readonly defaultTimeout: number;
  readonly maxOutputChars: number;
  readonly env: Record<string, string> | undefined;
  private readonly bash: string | null;
  private readonly spawnChild: ShellChildSpawn;

  constructor(options: ShellRunnerOptions = {}) {
    this.cwd = options.cwd;
    this.defaultTimeout = options.defaultTimeout ?? DEFAULT_TIMEOUT_S;
    this.maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
    this.spawnChild = options.spawnChild ?? defaultShellSpawn;
    if (options.env === undefined) {
      // TWO_BROTHERS_SHELL_PATH_EXTRA prepends directories to the child PATH
      // so confined workspace shells can find interpreters/tools the harness
      // host has but the confined shell does not.
      const extra = process.env.TWO_BROTHERS_SHELL_PATH_EXTRA ?? "";
      if (extra) {
        const env = { ...process.env } as Record<string, string>;
        env.PATH = [...extra.split(path.delimiter).filter((p) => p), env.PATH ?? ""].join(
          path.delimiter,
        );
        this.env = env;
      }
    } else {
      this.env = options.env;
    }
    this.bash = probeBash();
  }

  /** True when a working bash was probed (mirrors `self._bash`). */
  get hasBash(): boolean {
    return this.bash !== null;
  }

  /** Run one command, bounded by timeout and output size. */
  async run(command: string, options: { timeout?: number; signal?: AbortSignal } = {}): Promise<ShellResult> {
    const timeout = options.timeout ?? this.defaultTimeout;
    const signal = options.signal;
    const started = performance.now();

    const result: ShellResult = {
      command,
      status: STATUS_OK,
      exit_code: null,
      stdout: "",
      stderr: "",
      truncated: false,
      duration_ms: 0,
      timed_out: false,
      cancelled: false,
      error: "",
    };

    let child: ChildProcess;
    const spawnOptions: SpawnOptions = {
      cwd: this.cwd,
      env: this.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      // POSIX: own session so killpg(-pid) reaps the whole group.
      detached: process.platform !== "win32",
    };
    try {
      child = this.bash
        ? this.spawnChild(this.bash, ["-c", command], spawnOptions)
        : this.spawnChild(command, undefined, { ...spawnOptions, shell: true });
    } catch (err) {
      result.status = STATUS_ERROR;
      result.error = err instanceof Error ? err.message : String(err);
      return result;
    }

    const stdoutCapture = new BoundedOutput(this.maxOutputChars);
    const stderrCapture = new BoundedOutput(this.maxOutputChars);
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    const stdoutSanitizer = new StreamingSanitizer();
    const stderrSanitizer = new StreamingSanitizer();
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutCapture.push(stdoutSanitizer.push(stdoutDecoder.write(chunk)));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrCapture.push(stderrSanitizer.push(stderrDecoder.write(chunk)));
    });

    let onAbort: (() => void) | undefined;
    const aborted = new Promise<"abort">((resolve) => {
      if (!signal) return;
      onAbort = () => resolve("abort");
      signal.addEventListener("abort", onAbort, { once: true });
    });
    let timeoutHandle: NodeJS.Timeout | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timeoutHandle = setTimeout(() => resolve("timeout"), timeout * 1000);
    });
    const exited = new Promise<"exit" | { error: Error }>((resolve) => {
      // `close` (not `exit`) is what guarantees every stdio chunk was
      // delivered; but a background grandchild can keep the pipe open after
      // the shell exits. Wait for `close`, with a short bounded fallback so a
      // no-timeout command cannot hang forever on an inherited pipe.
      child.once("exit", () => {
        const fallback = setTimeout(() => resolve("exit"), EXIT_CLOSE_GRACE_MS);
        child.once("close", () => {
          clearTimeout(fallback);
          resolve("exit");
        });
      });
      child.once("error", (err) => resolve({ error: err }));
    });

    const outcome = await Promise.race([exited, aborted, timedOut]);
    clearTimeout(timeoutHandle);
    if (onAbort) signal?.removeEventListener("abort", onAbort);

    if (typeof outcome === "object" && outcome !== null) {
      // spawn failed asynchronously (the Python OSError catch)
      result.status = STATUS_ERROR;
      result.error = outcome.error.message;
    } else if (outcome === "abort") {
      result.cancelled = true;
      result.status = STATUS_CANCELLED;
      result.error = "cancelled by caller";
      await cleanupKilledTree(child);
      await this.drainAfterKill(child);
    } else if (outcome === "timeout") {
      result.timed_out = true;
      result.status = STATUS_TIMEOUT;
      result.error = `timed out after ${timeout.toFixed(1)}s`;
      await cleanupKilledTree(child);
      await this.drainAfterKill(child);
    } else if (result.status === STATUS_OK) {
      result.exit_code = child.exitCode;
    }

    result.duration_ms = Math.floor(performance.now() - started);
    // Flush the incremental decoders/sanitizers, then apply the same
    // middle-truncation contract the whole-string path used to produce.
    const out = finishCaptured(stdoutDecoder, stdoutSanitizer, stdoutCapture);
    const err = finishCaptured(stderrDecoder, stderrSanitizer, stderrCapture);
    result.stdout = out.text;
    result.stderr = err.text;
    result.truncated = out.truncated || err.truncated;
    return result;
  }

  /** Wait for the killed child to finish, up to the kill grace period. */
  private async drainAfterKill(child: ChildProcess): Promise<void> {
    if (child.exitCode != null || child.signalCode != null) return;
    await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, SHELL_DRAIN_BUDGET_MS)),
    ]);
  }
}

/** Flush a stream's decoder/sanitizer and close its bounded window. */
function finishCaptured(
  decoder: StringDecoder,
  sanitizer: StreamingSanitizer,
  capture: BoundedOutput,
): { text: string; truncated: boolean } {
  capture.push(sanitizer.push(decoder.end()));
  capture.push(sanitizer.end());
  return capture.finish();
}

/** Cleanup must never throw into the tool path. */
async function cleanupKilledTree(child: ChildProcess): Promise<void> {
  try {
    await killTree(child);
  } catch {
    // best effort: the drain below still bounds the wait
  }
}
