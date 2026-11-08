/**
 * External editor bridge for the TUI (Ctrl+G).
 *
 * The operator's draft is written to `prompt.md` inside a fresh
 * `two-brothers-edit-…` directory under the OS temp root, an asynchronous
 * editor process is spawned with inherited stdio, and the file is read back
 * after a clean exit. Nothing here uses `spawnSync` (a blocked event loop
 * cannot repaint or handle a resize) and nothing goes through a shell on the
 * normal path.
 *
 * Editor resolution, in priority order: an explicitly configured command (a
 * future settings value) > `$VISUAL` > `$EDITOR`. On Windows only, an unset
 * environment falls back to `%SystemRoot%\System32\notepad.exe` when that file
 * exists; POSIX never guesses (an honest "set $VISUAL or $EDITOR" instead of a
 * silent `nano`). A configured name is resolved through `PATH`/`PATHEXT` to an
 * absolute path, and a hit inside the workspace cwd is refused: a repository
 * must never be able to plant the binary the TUI runs (the kimi/pi
 * `resolve-command` lesson). Windows `.cmd`/`.bat` shims are launched through
 * an absolute `cmd.exe /d /s /c` wrapper because Node cannot execute a batch
 * shim directly.
 *
 * The draft file is mode `0600`. A nonzero exit, a spawn error, an unreadable
 * or oversized (`256 KiB`) file is an honest failure that leaves the draft
 * untouched; success strips one UTF-8 BOM, normalizes CRLF to LF and removes
 * one final newline (the editor's conventional trailing newline). The temp
 * directory is removed in `finally`, whatever the outcome.
 *
 * Every seam (`fs`, `spawn`, `env`, `platform`, `cwd`, `tmpdir`) is
 * injectable, so the suite exercises resolution, Windows shims, exit codes
 * and cleanup without launching a real editor.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Read-back cap for an edited draft (the vendor-documented bound). */
export const EDITOR_MAX_BYTES = 256 * 1024;
/** Temp-directory prefix; `mkdtemp` appends six random characters. */
export const EDITOR_TEMP_PREFIX = "two-brothers-edit-";
/** The file the editor is pointed at inside the temp directory. */
export const EDITOR_FILE_NAME = "prompt.md";
/** Default Windows executable extensions when `PATHEXT` is unset. */
export const EDITOR_DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

// --------------------------------------------------------------------------- //
// injectable filesystem
// --------------------------------------------------------------------------- //

/** The filesystem slice the editor bridge uses (all seams are injectable). */
export interface EditorFs {
  /** Synchronous existence probe used by command resolution. */
  exists(file: string): boolean;
  /** True when `file` exists and is executable for this process. */
  isExecutable(file: string): boolean;
  /** Create a unique directory from `prefix` and return its path. */
  mkdtemp(prefix: string): Promise<string>;
  /** Write the draft; `mode` is `0o600` (the umask may narrow it further). */
  writeFile(file: string, data: string, mode: number): Promise<void>;
  /** Read at most `maxBytes + 1` bytes so an oversized draft is detectable. */
  readBounded(file: string, maxBytes: number): Promise<Uint8Array>;
  /** Remove a temp directory and its contents; best-effort. */
  removeTree(dir: string): Promise<void>;
}

/** The real filesystem seam (node builtins only). */
export const nodeEditorFs: EditorFs = {
  exists(file: string): boolean {
    try {
      return fs.existsSync(file);
    } catch {
      return false;
    }
  },
  isExecutable(file: string): boolean {
    try {
      if (process.platform === "win32") return fs.existsSync(file);
      fs.accessSync(file, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
  async mkdtemp(prefix: string): Promise<string> {
    return await fs.promises.mkdtemp(prefix);
  },
  async writeFile(file: string, data: string, mode: number): Promise<void> {
    await fs.promises.writeFile(file, data, { encoding: "utf8", mode });
  },
  async readBounded(file: string, maxBytes: number): Promise<Uint8Array> {
    const handle = await fs.promises.open(file, "r");
    try {
      const size = Math.max(0, Math.floor(maxBytes)) + 1;
      const buffer = Buffer.alloc(size);
      const { bytesRead } = await handle.read(buffer, 0, size, 0);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  },
  async removeTree(dir: string): Promise<void> {
    await fs.promises.rm(dir, { recursive: true, force: true });
  },
};

// --------------------------------------------------------------------------- //
// command tokenization and resolution
// --------------------------------------------------------------------------- //

function errorText(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

function nonEmpty(value: string | undefined | null): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/** Environment lookup that also tries the Windows-style upper-case key. */
function envValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const direct = env[key];
  if (typeof direct === "string") return direct;
  const wanted = key.toUpperCase();
  for (const [candidate, value] of Object.entries(env)) {
    if (candidate.toUpperCase() === wanted && typeof value === "string") return value;
  }
  return undefined;
}

function platformPath(platform: NodeJS.Platform): typeof path.win32 | typeof path.posix {
  return platform === "win32" ? path.win32 : path.posix;
}

/**
 * Split an editor command into tokens without a shell: whitespace separates,
 * single/double quotes group, and a backslash only escapes a double quote
 * inside double quotes (Windows paths keep their backslashes). An unbalanced
 * quote is tolerated: the unclosed run is still one token, and the resulting
 * path simply fails to resolve.
 */
export function tokenizeEditorCommand(spec: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let started = false;
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < spec.length; index += 1) {
    const char = spec[index] ?? "";
    if (quote === "'") {
      if (char === "'") quote = null;
      else current += char;
      started = true;
      continue;
    }
    if (quote === '"') {
      if (char === "\\" && spec[index + 1] === '"') {
        current += '"';
        index += 1;
      } else if (char === '"') {
        quote = null;
      } else {
        current += char;
      }
      started = true;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/u.test(char)) {
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += char;
    started = true;
  }
  if (started) tokens.push(current);
  return tokens;
}

/** Inputs for command resolution; every field is injectable for tests. */
export interface EditorResolutionOptions {
  /** A future configured editor command (highest priority). */
  configured?: string | null;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Workspace cwd; a resolved executable inside it is refused. */
  cwd?: string;
  fs?: Pick<EditorFs, "exists" | "isExecutable">;
}

/** Which input supplied the editor command. */
export type EditorSource = "configured" | "visual" | "editor" | "notepad";

/** A resolved editor: an absolute executable plus its argument tokens. */
export interface ResolvedEditor {
  ok: true;
  source: EditorSource;
  /** Absolute path of the executable that will be spawned. */
  resolved: string;
  /** The full token list; `tokens[0]` is the unresolved spelling. */
  tokens: readonly string[];
}

/** An honest resolution failure (never a guessed fallback). */
export interface EditorResolutionError {
  ok: false;
  message: string;
}

export type EditorResolution = ResolvedEditor | EditorResolutionError;

function hasPathSeparator(token: string, platform: NodeJS.Platform): boolean {
  if (token.includes("/") || token.includes("\\")) return true;
  return platform === "win32" && /^[A-Za-z]:/u.test(token);
}

function pathExtensions(env: NodeJS.ProcessEnv): string[] {
  const raw = envValue(env, "PATHEXT");
  const list = nonEmpty(raw) ? raw.split(";") : EDITOR_DEFAULT_PATHEXT.split(";");
  return list.map((entry) => entry.trim()).filter((entry) => entry !== "");
}

function executableCandidates(
  token: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string[] {
  if (platform !== "win32") return [token];
  const extension = path.win32.extname(token).toLowerCase();
  if (extension !== "") return [token];
  return [token, ...pathExtensions(env).map((entry) => `${token}${entry}`)];
}

/**
 * Resolve `token` to an absolute executable path through `PATH`/`PATHEXT`
 * (or the filesystem for an explicit path). Returns `null` when no candidate
 * exists. Pure apart from the injected existence probe.
 */
export function resolveEditorExecutable(
  token: string,
  options: EditorResolutionOptions = {},
): string | null {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const fsSeam: Pick<EditorFs, "exists" | "isExecutable"> = options.fs ?? nodeEditorFs;
  const p = platformPath(platform);
  const candidates = executableCandidates(token, platform, env);
  const probe = (candidate: string): string | null => {
    if (!fsSeam.isExecutable(candidate)) return null;
    return p.resolve(candidate);
  };
  if (hasPathSeparator(token, platform) || p.isAbsolute(token)) {
    for (const candidate of candidates) {
      const absolute = p.isAbsolute(candidate) ? candidate : p.resolve(cwd, candidate);
      const found = probe(absolute);
      if (found !== null) return found;
    }
    return null;
  }
  const rawPath = envValue(env, "PATH");
  if (!nonEmpty(rawPath)) return null;
  for (const entry of rawPath.split(p.delimiter)) {
    // An empty PATH entry means the cwd on POSIX; resolving it here still
    // lets the workspace-refusal check below catch it.
    const dir = entry.trim() === "" ? cwd : entry.trim();
    for (const candidate of candidates) {
      const found = probe(p.resolve(dir, candidate));
      if (found !== null) return found;
    }
  }
  return null;
}

/** True when `target` is the workspace `cwd` or lives inside it. */
export function isInsideWorkspace(
  cwd: string,
  target: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const p = platformPath(platform);
  const relative = p.relative(p.resolve(cwd), p.resolve(target));
  if (relative === "") return true;
  if (p.isAbsolute(relative)) return false;
  return relative !== ".." && !relative.startsWith(`..${p.sep}`);
}

function editorNotFoundMessage(source: EditorSource, token: string): string {
  if (source === "configured") {
    return `editor command not found: ${token} - set a valid editor command`;
  }
  if (source === "visual") {
    return `editor not found: ${token} (from $VISUAL) - the draft was left unchanged`;
  }
  if (source === "editor") {
    return `editor not found: ${token} (from $EDITOR) - the draft was left unchanged`;
  }
  return `editor not found: ${token}`;
}

/**
 * Pick and resolve the editor command: configured > `$VISUAL` > `$EDITOR`, then
 * (Windows only) `%SystemRoot%\System32\notepad.exe` when present. POSIX with
 * neither variable set is an honest error.
 */
export function resolveEditorCommand(
  options: EditorResolutionOptions = {},
): EditorResolution {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const fsSeam: Pick<EditorFs, "exists" | "isExecutable"> = options.fs ?? nodeEditorFs;
  const p = platformPath(platform);

  let spec: string | null = null;
  let source: EditorSource = "configured";
  if (nonEmpty(options.configured)) {
    spec = options.configured.trim();
    source = "configured";
  } else {
    const visual = envValue(env, "VISUAL");
    const editor = envValue(env, "EDITOR");
    if (nonEmpty(visual)) {
      spec = visual.trim();
      source = "visual";
    } else if (nonEmpty(editor)) {
      spec = editor.trim();
      source = "editor";
    }
  }

  if (spec === null) {
    if (platform === "win32") {
      const root = nonEmpty(envValue(env, "SystemRoot"))
        ? envValue(env, "SystemRoot")!.trim()
        : "C:\\Windows";
      const notepad = p.resolve(root, "System32", "notepad.exe");
      if (fsSeam.isExecutable(notepad)) {
        return { ok: true, source: "notepad", resolved: notepad, tokens: [notepad] };
      }
      return {
        ok: false,
        message:
          "no external editor is set and notepad.exe was not found - set $VISUAL or $EDITOR",
      };
    }
    return {
      ok: false,
      message: "no external editor is set - set $VISUAL or $EDITOR (for example: EDITOR=\"code --wait\")",
    };
  }

  const tokens = tokenizeEditorCommand(spec);
  const executable = tokens[0];
  if (executable === undefined || executable === "") {
    return { ok: false, message: "the editor command is empty - set $VISUAL or $EDITOR" };
  }
  const resolved = resolveEditorExecutable(executable, { platform, env, cwd, fs: fsSeam });
  if (resolved === null) {
    return { ok: false, message: editorNotFoundMessage(source, executable) };
  }
  if (isInsideWorkspace(cwd, resolved, platform)) {
    return {
      ok: false,
      message:
        `refusing to run the editor "${resolved}" from inside the workspace (${p.resolve(cwd)}) - ` +
        "set $VISUAL or $EDITOR to a trusted path outside this directory",
    };
  }
  return { ok: true, source, resolved, tokens };
}

// --------------------------------------------------------------------------- //
// invocation planning (arguments, Windows shim wrapper)
// --------------------------------------------------------------------------- //

/** One planned process launch. */
export interface EditorInvocation {
  /** Absolute executable to spawn. */
  file: string;
  args: string[];
  /** True only for the `cmd.exe /c` batch-shim wrapper. */
  windowsVerbatimArguments: boolean;
  /** The resolved editor path (shown in toasts). */
  display: string;
}

export type EditorInvocationPlan =
  | { ok: true; invocation: EditorInvocation }
  | { ok: false; message: string };

function windowsRoot(env: NodeJS.ProcessEnv): string {
  const root = envValue(env, "SystemRoot");
  return nonEmpty(root) ? root.trim() : "C:\\Windows";
}

/** Quote one argument for a `cmd.exe /c` command line (never a shell). */
function quoteForCmd(value: string): string {
  if (value !== "" && !/[\s"&|<>^()]/u.test(value)) return value;
  return `"${value.replace(/"/gu, '""')}"`;
}

function isBatchShim(resolved: string): boolean {
  const extension = path.win32.extname(resolved).toLowerCase();
  return extension === ".cmd" || extension === ".bat";
}

/**
 * Build the launch plan for a resolved editor and the draft path. A Windows
 * `.cmd`/`.bat` shim is wrapped in an absolute `cmd.exe /d /s /c` command line
 * (arguments verbatim, since Node's own quoting would corrupt the wrapper).
 */
export function planEditorInvocation(
  editor: ResolvedEditor,
  file: string,
  options: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; fs?: Pick<EditorFs, "exists" | "isExecutable"> } = {},
): EditorInvocationPlan {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const fsSeam: Pick<EditorFs, "exists" | "isExecutable"> = options.fs ?? nodeEditorFs;
  const extra = editor.tokens.slice(1);
  if (platform === "win32" && isBatchShim(editor.resolved)) {
    const comSpec = envValue(env, "ComSpec");
    const fromEnv =
      nonEmpty(comSpec) && path.win32.isAbsolute(comSpec.trim())
        ? comSpec.trim()
        : null;
    const cmd = fromEnv !== null && fsSeam.isExecutable(fromEnv)
      ? fromEnv
      : path.win32.join(windowsRoot(env), "System32", "cmd.exe");
    if (!fsSeam.isExecutable(cmd)) {
      return {
        ok: false,
        message: `cannot run the editor shim ${editor.resolved}: cmd.exe was not found`,
      };
    }
    const pieces = [editor.resolved, ...extra, file].map((piece) => quoteForCmd(piece));
    // `/s` strips exactly one outer quote pair, leaving the quoted executable
    // and its arguments intact.
    const commandLine = `"${pieces.join(" ")}"`;
    return {
      ok: true,
      invocation: {
        file: cmd,
        args: ["/d", "/s", "/c", commandLine],
        windowsVerbatimArguments: true,
        display: editor.resolved,
      },
    };
  }
  return {
    ok: true,
    invocation: {
      file: editor.resolved,
      args: [...extra, file],
      windowsVerbatimArguments: false,
      display: editor.resolved,
    },
  };
}

// --------------------------------------------------------------------------- //
// spawn seam
// --------------------------------------------------------------------------- //

/** The structural slice of a spawned editor process the bridge waits on. */
export interface EditorChild {
  once(event: "error", listener: (error: Error) => void): unknown;
  once(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
}

/** Spawn options (inherited stdio, never a shell, never hidden). */
export interface EditorSpawnOptions {
  stdio: "inherit";
  shell: false;
  env: NodeJS.ProcessEnv;
  windowsHide: boolean;
  windowsVerbatimArguments?: boolean;
}

/** Injected process spawner; the default wraps `node:child_process.spawn`. */
export type EditorSpawn = (
  file: string,
  args: readonly string[],
  options: EditorSpawnOptions,
) => EditorChild;

const defaultSpawn: EditorSpawn = (file, args, options) =>
  spawn(file, [...args], {
    stdio: options.stdio,
    shell: false,
    env: options.env,
    windowsHide: options.windowsHide,
    ...(options.windowsVerbatimArguments === true
      ? { windowsVerbatimArguments: true }
      : {}),
  }) as unknown as EditorChild;

interface EditorRunOutcome {
  ok: boolean;
  message: string;
}

async function runEditor(
  invocation: EditorInvocation,
  spawnFn: EditorSpawn,
  env: NodeJS.ProcessEnv,
): Promise<EditorRunOutcome> {
  return await new Promise<EditorRunOutcome>((resolve) => {
    let settled = false;
    const finish = (outcome: EditorRunOutcome): void => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
    let child: EditorChild;
    try {
      child = spawnFn(invocation.file, invocation.args, {
        stdio: "inherit",
        shell: false,
        env,
        windowsHide: true,
        ...(invocation.windowsVerbatimArguments
          ? { windowsVerbatimArguments: true }
          : {}),
      });
    } catch (exc) {
      finish({
        ok: false,
        message: `could not start the editor: ${errorText(exc)} - the draft was left unchanged`,
      });
      return;
    }
    child.once("error", (error) => {
      finish({
        ok: false,
        message: `could not start the editor: ${errorText(error)} - the draft was left unchanged`,
      });
    });
    child.once("close", (code, signal) => {
      if (code === 0) {
        finish({ ok: true, message: "" });
      } else if (signal !== null) {
        finish({
          ok: false,
          message: `the editor was stopped by ${signal} - the draft was left unchanged`,
        });
      } else {
        finish({
          ok: false,
          message: `the editor exited with code ${code ?? "unknown"} - the draft was left unchanged`,
        });
      }
    });
  });
}

// --------------------------------------------------------------------------- //
// the bridge
// --------------------------------------------------------------------------- //

/** Everything the app can inject; the real defaults are safe for production. */
export interface ExternalEditorOptions {
  /** The composer draft that will be seeded into `prompt.md`. */
  text: string;
  /** A future configured editor command (highest priority). */
  configured?: string | null;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Workspace cwd; an editor resolved inside it is refused. */
  cwd?: string;
  /** Temp root override (tests keep their temp directories in one place). */
  tmpdir?: string;
  fs?: EditorFs;
  spawn?: EditorSpawn;
  /** Read-back cap override (default {@link EDITOR_MAX_BYTES}). */
  maxBytes?: number;
}

/** Honest outcome of one external-editor round trip. */
export type ExternalEditResult =
  | {
      kind: "edited";
      /** The normalized text read back from the editor. */
      text: string;
      /** False when the editor wrote the seed back unchanged. */
      changed: boolean;
      /** Absolute editor path actually spawned. */
      command: string;
      /** Bytes read back before normalization. */
      bytes: number;
    }
  | { kind: "error"; message: string };

/**
 * Normalize an edited draft: strip one UTF-8 BOM, turn CRLF into LF and drop
 * exactly one final newline (the editor's conventional trailing newline).
 */
export function normalizeEditedText(raw: string): string {
  let text = raw;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  text = text.replace(/\r\n/gu, "\n");
  if (text.endsWith("\n")) text = text.slice(0, -1);
  return text;
}

/**
 * Edit `text` in the operator's editor. The temp directory is always removed;
 * a failure leaves the caller's draft untouched and reports the real reason.
 */
export async function editTextInExternalEditor(
  options: ExternalEditorOptions,
): Promise<ExternalEditResult> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const fsSeam = options.fs ?? nodeEditorFs;
  const cwd = options.cwd ?? process.cwd();
  const maxBytes =
    typeof options.maxBytes === "number" && Number.isFinite(options.maxBytes) && options.maxBytes > 0
      ? Math.floor(options.maxBytes)
      : EDITOR_MAX_BYTES;
  const resolution = resolveEditorCommand({
    ...(options.configured !== undefined ? { configured: options.configured } : {}),
    platform,
    env,
    cwd,
    fs: fsSeam,
  });
  if (!resolution.ok) return { kind: "error", message: resolution.message };
  const spawnFn = options.spawn ?? defaultSpawn;
  const tempRoot = options.tmpdir ?? os.tmpdir();
  let dir: string | null = null;
  try {
    dir = await fsSeam.mkdtemp(path.join(tempRoot, EDITOR_TEMP_PREFIX));
    const file = path.join(dir, EDITOR_FILE_NAME);
    await fsSeam.writeFile(file, options.text, 0o600);
    const plan = planEditorInvocation(resolution, file, { platform, env, fs: fsSeam });
    if (!plan.ok) return { kind: "error", message: plan.message };
    const outcome = await runEditor(plan.invocation, spawnFn, env);
    if (!outcome.ok) return { kind: "error", message: outcome.message };
    const bytes = await fsSeam.readBounded(file, maxBytes);
    if (bytes.length > maxBytes) {
      return {
        kind: "error",
        message:
          `the edited draft is larger than ${Math.floor(maxBytes / 1024)} KiB - ` +
          "the draft was left unchanged",
      };
    }
    const text = normalizeEditedText(Buffer.from(bytes).toString("utf8"));
    return {
      kind: "edited",
      text,
      changed: text !== options.text,
      command: resolution.resolved,
      bytes: bytes.length,
    };
  } catch (exc) {
    return { kind: "error", message: `external editor failed: ${errorText(exc)}` };
  } finally {
    if (dir !== null) {
      try {
        await fsSeam.removeTree(dir);
      } catch {
        // Best-effort cleanup: a leftover temp dir is not an edit failure.
      }
    }
  }
}
