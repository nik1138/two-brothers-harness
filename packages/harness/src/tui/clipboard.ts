/**
 * Clipboard writers for the TUI (Ctrl+X).
 *
 * Native writers, tried in order for the current platform:
 *
 * - Windows: an absolute `powershell.exe … Set-Clipboard` reading a UTF-8
 *   temp file (Unicode-safe), then `System32\clip.exe` with the text on stdin.
 * - macOS: `pbcopy` with the text on stdin.
 * - Linux: `wl-copy` when `WAYLAND_DISPLAY` is set, then `xclip`/`xsel` when
 *   `DISPLAY` is set. With no display environment there is no native writer.
 *
 * When every native writer fails, or the session is remote (`SSH_CONNECTION`,
 * `SSH_CLIENT`, `MOSH_CONNECTION`), one OSC 52 sequence is written to the
 * terminal — `ESC ] 52 ; c ; base64 BEL` — capped at
 * {@link OSC52_MAX_ENCODED_CHARS} base64 characters.
 *
 * Every writer is a real child process (never a shell), has a per-writer
 * deadline ({@link CLIPBOARD_WRITER_TIMEOUT_MS}) and reports its true outcome:
 * `ok` is only true when a writer exited 0 or the OSC 52 sink returned
 * normally. Nothing here claims a copy that did not happen, and tests inject
 * both `spawn` and the OSC 52 write sink so no real clipboard is touched.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** OSC 52 payload cap in base64 characters (the vendor-documented bound). */
export const OSC52_MAX_ENCODED_CHARS = 100_000;
/** Per-writer deadline; a stuck helper must never hang the TUI. */
export const CLIPBOARD_WRITER_TIMEOUT_MS = 5_000;
/** Child env var carrying the UTF-8 temp file to the PowerShell helper. */
export const CLIP_FILE_ENV = "TWO_BROTHERS_CLIP_FILE";

/** A clipboard transport that reported success. */
export type ClipboardMethod =
  | "powershell"
  | "clip"
  | "pbcopy"
  | "wl-copy"
  | "xclip"
  | "xsel"
  | "osc52";

/** Honest outcome of one copy attempt. */
export interface ClipboardResult {
  /** True only when a writer actually accepted the text. */
  ok: boolean;
  /** The writer that succeeded, or `null` on failure. */
  method: ClipboardMethod | null;
  /** Characters in the copied text (raw length, never a byte count). */
  chars: number;
  /** Human-readable failure detail when `ok` is false. */
  error?: string;
}

/** One native writer plan (no I/O; {@link clipboardWriters} only selects). */
export interface ClipboardCommandSpec {
  method: Exclude<ClipboardMethod, "osc52">;
  command: string;
  args: string[];
}

/** Inputs for writer selection; defaults read the process platform/env. */
export interface ClipboardContext {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

/** The structural slice of a child process the writers use. */
export interface ClipboardChild {
  readonly stdin: { end(chunk?: string | Buffer): void } | null;
  once(event: "error", listener: (error: Error) => void): unknown;
  once(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
}

/** Spawn options the writers pass (never a shell). */
export interface ClipboardSpawnOptions {
  env: NodeJS.ProcessEnv;
  stdio: readonly ("pipe" | "ignore" | "inherit")[];
  shell: false;
  windowsHide: boolean;
}

/** Injected process spawner; the default wraps `node:child_process.spawn`. */
export type ClipboardSpawn = (
  command: string,
  args: readonly string[],
  options: ClipboardSpawnOptions,
) => ClipboardChild;

const defaultSpawn: ClipboardSpawn = (command, args, options) =>
  spawn(command, [...args], {
    env: options.env,
    stdio: [...options.stdio],
    shell: false,
    windowsHide: options.windowsHide,
  }) as unknown as ClipboardChild;

/** The clipboard write seam the app uses (tests inject a recorder). */
export type ClipboardWriter = (text: string) => Promise<ClipboardResult>;

/** Inputs for {@link copyToClipboard}. */
export interface CopyOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Injected spawner; defaults to `node:child_process.spawn`. */
  spawn?: ClipboardSpawn;
  /** OSC 52 sink; defaults to `process.stdout.write`. */
  write?: (sequence: string) => void;
  /** Per-writer deadline override (tests use a short value). */
  timeoutMs?: number;
}

function nonEmpty(value: string | undefined | null): boolean {
  return typeof value === "string" && value.trim() !== "";
}

function errorText(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

/**
 * True when the session looks remote. Native clipboard helpers would then run
 * on the remote host — the operator's local clipboard is behind the terminal,
 * so OSC 52 is the only transport that can reach it.
 */
export function isRemoteSession(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    nonEmpty(env.SSH_CONNECTION) ||
    nonEmpty(env.SSH_CLIENT) ||
    nonEmpty(env.MOSH_CONNECTION)
  );
}

function windowsRoot(env: NodeJS.ProcessEnv): string {
  const root = env.SystemRoot ?? env.SYSTEMROOT;
  return typeof root === "string" && root.trim() !== ""
    ? root.trim()
    : "C:\\Windows";
}

const POWERSHELL_SET_CLIPBOARD =
  "$ErrorActionPreference='Stop'; " +
  `Set-Clipboard -Value (Get-Content -Raw -Encoding UTF8 -LiteralPath $env:${CLIP_FILE_ENV})`;

/**
 * The ordered native writers for a platform. Pure and environment-driven:
 * Windows resolves absolute System32 paths (never a bare name through PATH),
 * and Linux only offers Wayland/X11 helpers when the matching display
 * variable exists. An empty list means only OSC 52 is possible.
 */
export function clipboardWriters(
  context: ClipboardContext = {},
): ClipboardCommandSpec[] {
  const platform = context.platform ?? process.platform;
  const env = context.env ?? process.env;
  if (platform === "win32") {
    const root = windowsRoot(env);
    return [
      {
        method: "powershell",
        command: path.win32.join(
          root,
          "System32",
          "WindowsPowerShell",
          "v1.0",
          "powershell.exe",
        ),
        args: ["-NoProfile", "-NonInteractive", "-Command", POWERSHELL_SET_CLIPBOARD],
      },
      {
        method: "clip",
        command: path.win32.join(root, "System32", "clip.exe"),
        args: [],
      },
    ];
  }
  if (platform === "darwin") {
    return [{ method: "pbcopy", command: "pbcopy", args: [] }];
  }
  const writers: ClipboardCommandSpec[] = [];
  if (!["linux", "freebsd", "openbsd", "netbsd"].includes(platform)) return writers;
  if (nonEmpty(env.WAYLAND_DISPLAY)) {
    writers.push({ method: "wl-copy", command: "wl-copy", args: [] });
  }
  if (nonEmpty(env.DISPLAY)) {
    writers.push({
      method: "xclip",
      command: "xclip",
      args: ["-selection", "clipboard"],
    });
    writers.push({
      method: "xsel",
      command: "xsel",
      args: ["--clipboard", "--input"],
    });
  }
  return writers;
}

/**
 * The OSC 52 sequence for `text`, or `null` when the base64 payload exceeds
 * {@link OSC52_MAX_ENCODED_CHARS}. Never truncates: a shortened clipboard
 * would be silently corrupt, so an oversized reply reports failure instead.
 */
export function osc52Sequence(text: string): string | null {
  const encoded = Buffer.from(text, "utf8").toString("base64");
  if (encoded.length > OSC52_MAX_ENCODED_CHARS) return null;
  return `\u001b]52;c;${encoded}\u0007`;
}

/** Human label for the method a copy used (toast copy). */
export function clipboardMethodLabel(method: ClipboardMethod | null): string {
  if (method === "osc52") return "OSC 52";
  return method ?? "no method";
}

interface WriterOutcome {
  ok: boolean;
  error?: string;
}

async function runWriter(
  spec: ClipboardCommandSpec,
  text: string,
  options: { env: NodeJS.ProcessEnv; spawn: ClipboardSpawn; timeoutMs: number },
): Promise<WriterOutcome> {
  let tempDir: string | null = null;
  let childEnv = options.env;
  if (spec.method === "powershell") {
    try {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "two-brothers-clip-"));
      const file = path.join(tempDir, "clip.txt");
      // UTF-8 mode 0600: the reply may contain anything the models produced.
      fs.writeFileSync(file, text, { encoding: "utf8", mode: 0o600 });
      childEnv = { ...options.env, [CLIP_FILE_ENV]: file };
    } catch (exc) {
      return { ok: false, error: `temp file: ${errorText(exc)}` };
    }
  }
  try {
    return await new Promise<WriterOutcome>((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | null = null;
      const finish = (outcome: WriterOutcome): void => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        resolve(outcome);
      };
      let child: ClipboardChild;
      try {
        child = options.spawn(spec.command, spec.args, {
          env: childEnv,
          stdio:
            spec.method === "powershell"
              ? ["ignore", "ignore", "ignore"]
              : ["pipe", "ignore", "ignore"],
          shell: false,
          windowsHide: true,
        });
      } catch (exc) {
        finish({ ok: false, error: errorText(exc) });
        return;
      }
      const timeout = Math.max(1, Math.floor(options.timeoutMs));
      timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // the child may already be gone
        }
        finish({ ok: false, error: `timed out after ${timeout} ms` });
      }, timeout);
      timer.unref?.();
      child.once("error", (error) => {
        finish({ ok: false, error: errorText(error) });
      });
      child.once("close", (code, signal) => {
        if (code === 0) {
          finish({ ok: true });
        } else if (signal !== null) {
          finish({ ok: false, error: `stopped by ${signal}` });
        } else {
          finish({ ok: false, error: `exit code ${code ?? "unknown"}` });
        }
      });
      if (spec.method !== "powershell") {
        try {
          if (child.stdin === null) throw new Error("child stdin is unavailable");
          child.stdin.end(Buffer.from(text, "utf8"));
        } catch (exc) {
          finish({ ok: false, error: errorText(exc) });
        }
      }
    });
  } finally {
    if (tempDir !== null) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup; a leftover temp dir is not a clipboard failure
      }
    }
  }
}

/**
 * Copy `text` with the first writer that succeeds. Remote sessions and
 * native-writer failures fall back to OSC 52; a failure result says exactly
 * which transports were tried and why each one failed.
 */
export async function copyToClipboard(
  text: string,
  options: CopyOptions = {},
): Promise<ClipboardResult> {
  const chars = text.length;
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const spawnWriter = options.spawn ?? defaultSpawn;
  const timeoutMs = options.timeoutMs ?? CLIPBOARD_WRITER_TIMEOUT_MS;
  const write =
    options.write ??
    ((sequence: string): void => {
      process.stdout.write(sequence);
    });
  const failures: string[] = [];

  if (!isRemoteSession(env)) {
    for (const spec of clipboardWriters({ platform, env })) {
      const outcome = await runWriter(spec, text, {
        env,
        spawn: spawnWriter,
        timeoutMs,
      });
      if (outcome.ok) return { ok: true, method: spec.method, chars };
      failures.push(`${spec.method}: ${outcome.error ?? "failed"}`);
    }
  }

  const sequence = osc52Sequence(text);
  if (sequence === null) {
    const encoded = Buffer.from(text, "utf8").toString("base64").length;
    failures.push(
      `OSC 52: ${encoded} encoded chars exceeds the ${OSC52_MAX_ENCODED_CHARS} cap`,
    );
  } else {
    try {
      write(sequence);
      return { ok: true, method: "osc52", chars };
    } catch (exc) {
      failures.push(`OSC 52: ${errorText(exc)}`);
    }
  }

  return {
    ok: false,
    method: null,
    chars,
    error:
      failures.length > 0
        ? failures.join("; ")
        : "no clipboard writer is available on this platform",
  };
}
