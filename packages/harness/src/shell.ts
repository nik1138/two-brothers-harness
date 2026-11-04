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
 * Cleanup kills the whole process tree: on Windows via
 * `taskkill /F /T /PID` (with a `child.kill()` fallback), on POSIX via
 * `killpg` (the child is spawned detached, i.e. in its own session, so
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
import { sanitizeOutput } from "./output.ts";

export const DEFAULT_TIMEOUT_S = 30.0;
export const DEFAULT_MAX_OUTPUT_CHARS = 20_000;
export const KILL_GRACE_S = 2.0;

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

/** Decode bytes the way Python does: UTF-8 with errors="replace". */
function decode(data: Buffer | null): string {
  return data === null ? "" : data.toString("utf8");
}

/** Middle-truncation exactly as Python's `_truncate`. */
function truncate(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  const half = Math.floor(limit / 2);
  return {
    text: text.slice(0, half) + `\n...[truncated ${text.length - limit} chars]...\n` + text.slice(-half),
    truncated: true,
  };
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

function killTree(child: ChildProcess): void {
  if (process.platform === "win32") {
    try {
      if (child.pid !== undefined) {
        const killed = spawnSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], {
          stdio: "ignore",
          timeout: 10_000,
        });
        if (killed.error) throw killed.error;
      }
    } catch {
      try {
        child.kill();
      } catch {
        // already gone
      }
    }
  } else {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
    } catch {
      // ESRCH / EPERM: the group is already gone
    }
  }
}

export interface ShellRunnerOptions {
  cwd?: string;
  defaultTimeout?: number;
  maxOutputChars?: number;
  /** Full environment for the child; omitted = inherit (plus PATH_EXTRA). */
  env?: Record<string, string>;
}

export class ShellRunner {
  readonly cwd: string | undefined;
  readonly defaultTimeout: number;
  readonly maxOutputChars: number;
  readonly env: Record<string, string> | undefined;
  private readonly bash: string | null;

  constructor(options: ShellRunnerOptions = {}) {
    this.cwd = options.cwd;
    this.defaultTimeout = options.defaultTimeout ?? DEFAULT_TIMEOUT_S;
    this.maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
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
        ? spawn(this.bash, ["-c", command], spawnOptions)
        : spawn(command, { ...spawnOptions, shell: true });
    } catch (err) {
      result.status = STATUS_ERROR;
      result.error = err instanceof Error ? err.message : String(err);
      return result;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

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
      child.once("exit", () => resolve("exit"));
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
      killTree(child);
      await this.drainAfterKill(child);
    } else if (outcome === "timeout") {
      result.timed_out = true;
      result.status = STATUS_TIMEOUT;
      result.error = `timed out after ${timeout.toFixed(1)}s`;
      killTree(child);
      await this.drainAfterKill(child);
    } else if (result.status === STATUS_OK) {
      result.exit_code = child.exitCode;
    }

    result.duration_ms = Math.floor(performance.now() - started);
    // strip ANSI escapes/control chars before the cap so terminal junk never
    // enters the model context and the cap measures clean text
    const out = truncate(sanitizeOutput(decode(Buffer.concat(stdoutChunks))), this.maxOutputChars);
    const err = truncate(sanitizeOutput(decode(Buffer.concat(stderrChunks))), this.maxOutputChars);
    result.stdout = out.text;
    result.stderr = err.text;
    result.truncated = out.truncated || err.truncated;
    return result;
  }

  /** Wait for the killed child to finish, up to the kill grace period. */
  private async drainAfterKill(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, (KILL_GRACE_S + 5) * 1000)),
    ]);
  }
}
