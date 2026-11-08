/**
 * External-editor suite: command resolution (`configured` > `$VISUAL` >
 * `$EDITOR`, the Windows `notepad.exe` fallback and the honest POSIX error),
 * PATH/PATHEXT resolution, workspace-planting refusal, quote-aware
 * tokenization, the `cmd.exe /d /s /c` batch-shim wrapper, the injected-spawn
 * round trip (success, nonzero exit, spawn error, BOM/CRLF, oversize,
 * cleanup) and the terminal `suspend()`/`resume()` handoff.
 *
 * Hermetic: every seam (fs, spawn, env, platform, tmpdir) is injected, so no
 * real editor is started here. The assembled-app Ctrl+G case lives in
 * `tuiintegration.test.ts` and uses a real Node script.
 *
 * Run with: node --test tests/tuiexternaleditor.test.ts
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as path from "node:path";
import { test } from "node:test";

import {
  EDITOR_FILE_NAME,
  EDITOR_MAX_BYTES,
  EDITOR_TEMP_PREFIX,
  editTextInExternalEditor,
  isInsideWorkspace,
  normalizeEditedText,
  planEditorInvocation,
  resolveEditorCommand,
  resolveEditorExecutable,
  tokenizeEditorCommand,
  type EditorChild,
  type EditorFs,
  type EditorSpawn,
  type EditorSpawnOptions,
  type ResolvedEditor,
} from "../src/tui/externaleditor.ts";
import { ANSI } from "../src/tui/render.ts";
import {
  BRACKETED_PASTE_OFF,
  BRACKETED_PASTE_ON,
  createTerminal,
} from "../src/tui/terminal.ts";

// --------------------------------------------------------------------------- //
// injected seams
// --------------------------------------------------------------------------- //

class FakeFs implements EditorFs {
  readonly win: boolean;
  readonly files = new Set<string>();
  readonly executables = new Set<string>();
  readonly writes: Array<{ file: string; data: string; mode: number }> = [];
  readonly reads: string[] = [];
  readonly removed: string[] = [];
  dir = "/tmp/two-brothers-edit-abc123";
  prefix: string | null = null;
  readOverride: Uint8Array | null = null;
  writeError: Error | null = null;

  constructor(win = false) {
    this.win = win;
  }

  private key(file: string): string {
    return this.win ? file.replace(/\//gu, "\\").toLowerCase() : file;
  }

  add(file: string): void {
    this.files.add(this.key(file));
  }

  addExecutable(file: string): void {
    this.add(file);
    this.executables.add(this.key(file));
  }

  exists(file: string): boolean {
    return this.files.has(this.key(file));
  }

  isExecutable(file: string): boolean {
    return this.executables.has(this.key(file));
  }

  async mkdtemp(prefix: string): Promise<string> {
    this.prefix = prefix;
    return this.dir;
  }

  async writeFile(file: string, data: string, mode: number): Promise<void> {
    if (this.writeError !== null) throw this.writeError;
    this.writes.push({ file, data, mode });
  }

  async readBounded(file: string, maxBytes: number): Promise<Uint8Array> {
    this.reads.push(file);
    if (this.readOverride !== null) {
      return this.readOverride.subarray(0, maxBytes + 1);
    }
    return Buffer.from(this.writes.at(-1)?.data ?? "");
  }

  async removeTree(dir: string): Promise<void> {
    this.removed.push(dir);
  }
}

interface SpawnCall {
  file: string;
  args: string[];
  options: EditorSpawnOptions;
}

function fakeChild(behavior: {
  code?: number | null;
  signal?: NodeJS.Signals | null;
  error?: Error;
}): EditorChild {
  const emitter = new EventEmitter();
  setImmediate(() => {
    if (behavior.error !== undefined) emitter.emit("error", behavior.error);
    else emitter.emit("close", behavior.code ?? 0, behavior.signal ?? null);
  });
  return emitter as unknown as EditorChild;
}

function recordingSpawn(
  calls: SpawnCall[],
  behavior: { code?: number | null; signal?: NodeJS.Signals | null; error?: Error } = {},
): EditorSpawn {
  return (file, args, options) => {
    calls.push({ file, args: [...args], options });
    return fakeChild(behavior);
  };
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

// --------------------------------------------------------------------------- //
// tokenization
// --------------------------------------------------------------------------- //

test("tokenization is quote-aware and never invokes a shell", () => {
  assert.deepEqual(tokenizeEditorCommand("code --wait"), ["code", "--wait"]);
  assert.deepEqual(tokenizeEditorCommand('  spaced\t "two words"\n'), [
    "spaced",
    "two words",
  ]);
  assert.deepEqual(tokenizeEditorCommand(`"C:\\Program Files\\Ed\\ed.exe" -n`), [
    "C:\\Program Files\\Ed\\ed.exe",
    "-n",
  ]);
  assert.deepEqual(tokenizeEditorCommand(`'/opt/My Editor/ed' --wait`), [
    "/opt/My Editor/ed",
    "--wait",
  ]);
  assert.deepEqual(tokenizeEditorCommand(`C:\\Tools\\ed.exe -n`), [
    "C:\\Tools\\ed.exe",
    "-n",
  ]);
  assert.deepEqual(tokenizeEditorCommand(`"a \\"quoted\\" arg"`), ['a "quoted" arg']);
  assert.deepEqual(tokenizeEditorCommand("   "), []);
});

// --------------------------------------------------------------------------- //
// command resolution
// --------------------------------------------------------------------------- //

const winBase = {
  platform: "win32" as const,
  cwd: "C:\\work\\repo",
};

test("resolution priority is configured > $VISUAL > $EDITOR", () => {
  const fsSeam = new FakeFs(true);
  fsSeam.addExecutable("C:\\Tools\\conf.exe");
  fsSeam.addExecutable("C:\\Tools\\vis.exe");
  fsSeam.addExecutable("C:\\bin\\ed.exe");
  const env: NodeJS.ProcessEnv = {
    SystemRoot: "C:\\Windows",
    VISUAL: '"C:\\Tools\\vis.exe" --wait',
    EDITOR: "ed",
    PATH: "C:\\bin",
    PATHEXT: ".EXE",
  };
  const configured = resolveEditorCommand({
    ...winBase,
    env,
    fs: fsSeam,
    configured: '"C:\\Tools\\conf.exe" -n',
  });
  assert.equal(configured.ok, true);
  if (configured.ok) {
    assert.equal(configured.source, "configured");
    assert.equal(configured.resolved, "C:\\Tools\\conf.exe");
    assert.deepEqual([...configured.tokens], ["C:\\Tools\\conf.exe", "-n"]);
  }

  const visual = resolveEditorCommand({ ...winBase, env, fs: fsSeam });
  assert.equal(visual.ok, true);
  if (visual.ok) {
    assert.equal(visual.source, "visual");
    assert.equal(visual.resolved, "C:\\Tools\\vis.exe");
  }

  const editor = resolveEditorCommand({
    ...winBase,
    env: { ...env, VISUAL: "" },
    fs: fsSeam,
  });
  assert.equal(editor.ok, true);
  if (editor.ok) {
    assert.equal(editor.source, "editor");
    assert.equal(editor.resolved, "C:\\bin\\ed.EXE", "PATHEXT resolution");
  }
});

test("Windows falls back to notepad only when System32\\notepad.exe exists", () => {
  const withNotepad = new FakeFs(true);
  withNotepad.addExecutable("C:\\Windows\\System32\\notepad.exe");
  const found = resolveEditorCommand({
    ...winBase,
    env: { SystemRoot: "C:\\Windows" },
    fs: withNotepad,
  });
  assert.equal(found.ok, true);
  if (found.ok) {
    assert.equal(found.source, "notepad");
    assert.equal(found.resolved, "C:\\Windows\\System32\\notepad.exe");
  }

  const missing = resolveEditorCommand({
    ...winBase,
    env: { SystemRoot: "C:\\Windows" },
    fs: new FakeFs(true),
  });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.match(missing.message, /set \$VISUAL or \$EDITOR/);
});

test("POSIX with neither variable set is an honest error, never a silent nano", () => {
  const fsSeam = new FakeFs(false);
  fsSeam.addExecutable("/usr/bin/nano");
  const result = resolveEditorCommand({
    platform: "linux",
    cwd: "/work",
    env: { PATH: "/usr/bin" },
    fs: fsSeam,
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.message, /set \$VISUAL or \$EDITOR/);
    assert.ok(!result.message.includes("nano"));
  }
});

test("a missing editor names the variable it came from", () => {
  const fsSeam = new FakeFs(false);
  const visual = resolveEditorCommand({
    platform: "linux",
    cwd: "/work",
    env: { VISUAL: "missing-ed", PATH: "/usr/bin" },
    fs: fsSeam,
  });
  assert.equal(visual.ok, false);
  if (!visual.ok) assert.match(visual.message, /editor not found: missing-ed \(from \$VISUAL\)/);

  const configured = resolveEditorCommand({
    platform: "linux",
    cwd: "/work",
    env: { PATH: "/usr/bin" },
    fs: fsSeam,
    configured: "nope",
  });
  assert.equal(configured.ok, false);
  if (!configured.ok) assert.match(configured.message, /editor command not found: nope/);
});

test("PATH resolution returns an absolute executable and honors PATHEXT", () => {
  const fsSeam = new FakeFs(true);
  fsSeam.addExecutable("C:\\bin\\code.CMD");
  const resolved = resolveEditorExecutable("code", {
    platform: "win32",
    cwd: "C:\\work",
    env: { PATH: "C:\\bin", PATHEXT: ".COM;.EXE;.BAT;.CMD" },
    fs: fsSeam,
  });
  assert.equal(resolved, "C:\\bin\\code.CMD");

  const posix = new FakeFs(false);
  posix.addExecutable("/usr/bin/code");
  assert.equal(
    resolveEditorExecutable("code", {
      platform: "linux",
      cwd: "/work",
      env: { PATH: "/usr/local/bin:/usr/bin" },
      fs: posix,
    }),
    "/usr/bin/code",
  );
});

test("an editor inside the workspace cwd is refused (binary planting)", () => {
  const fsSeam = new FakeFs(false);
  fsSeam.addExecutable("/work/repo/bin/ed");
  fsSeam.addExecutable("/work/repo-other/bin/ed");
  const refused = resolveEditorCommand({
    platform: "linux",
    cwd: "/work/repo",
    env: { EDITOR: "ed", PATH: "/work/repo/bin" },
    fs: fsSeam,
  });
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.match(refused.message, /inside the workspace/);

  const relative = resolveEditorCommand({
    platform: "linux",
    cwd: "/work/repo",
    env: {},
    fs: fsSeam,
    configured: "./bin/ed",
  });
  assert.equal(relative.ok, false);

  const sibling = resolveEditorCommand({
    platform: "linux",
    cwd: "/work/repo",
    env: { EDITOR: "ed", PATH: "/work/repo-other/bin" },
    fs: fsSeam,
  });
  assert.equal(sibling.ok, true, "a sibling directory is not inside the workspace");
  assert.equal(isInsideWorkspace("/work/repo", "/work/repo", "linux"), true);
  assert.equal(isInsideWorkspace("/work/repo", "/work/repo-other/bin/ed", "linux"), false);
  assert.equal(
    isInsideWorkspace("C:\\work\\repo", "C:\\WORK\\REPO\\bin\\ed.exe", "win32"),
    true,
    "the Windows comparison is case-insensitive",
  );
});

// --------------------------------------------------------------------------- //
// invocation planning (Windows shims)
// --------------------------------------------------------------------------- //

const linuxEditor: ResolvedEditor = {
  ok: true,
  source: "editor",
  resolved: "/usr/bin/code",
  tokens: ["code", "--wait"],
};

test("the normal path spawns the editor directly with no shell", () => {
  const plan = planEditorInvocation(linuxEditor, "/tmp/edit/prompt.md", {
    platform: "linux",
  });
  assert.equal(plan.ok, true);
  if (plan.ok) {
    assert.equal(plan.invocation.file, "/usr/bin/code");
    assert.deepEqual(plan.invocation.args, ["--wait", "/tmp/edit/prompt.md"]);
    assert.equal(plan.invocation.windowsVerbatimArguments, false);
  }
});

test("a Windows .cmd/.bat editor is wrapped in an absolute cmd.exe /d /s /c", () => {
  const fsSeam = new FakeFs(true);
  fsSeam.addExecutable("C:\\Windows\\System32\\cmd.exe");
  const shim: ResolvedEditor = {
    ok: true,
    source: "configured",
    resolved: "C:\\Program Files\\Ed\\ed.cmd",
    tokens: ["ed", "--wait"],
  };
  const plan = planEditorInvocation(shim, "C:\\temp\\my draft\\prompt.md", {
    platform: "win32",
    env: { SystemRoot: "C:\\Windows" },
    fs: fsSeam,
  });
  assert.equal(plan.ok, true);
  if (plan.ok) {
    assert.equal(plan.invocation.file, "C:\\Windows\\System32\\cmd.exe");
    assert.deepEqual(plan.invocation.args, [
      "/d",
      "/s",
      "/c",
      '""C:\\Program Files\\Ed\\ed.cmd" --wait "C:\\temp\\my draft\\prompt.md""',
    ]);
    assert.equal(plan.invocation.windowsVerbatimArguments, true);
  }

  // An .exe from the same directory is not wrapped.
  const exe: ResolvedEditor = {
    ok: true,
    source: "configured",
    resolved: "C:\\Program Files\\Ed\\ed.exe",
    tokens: ["ed"],
  };
  const direct = planEditorInvocation(exe, "C:\\temp\\prompt.md", {
    platform: "win32",
    env: { SystemRoot: "C:\\Windows" },
    fs: fsSeam,
  });
  assert.equal(direct.ok, true);
  if (direct.ok) assert.equal(direct.invocation.file, "C:\\Program Files\\Ed\\ed.exe");

  const noCmd = planEditorInvocation(shim, "C:\\temp\\prompt.md", {
    platform: "win32",
    env: { SystemRoot: "C:\\Windows" },
    fs: new FakeFs(true),
  });
  assert.equal(noCmd.ok, false);
  if (!noCmd.ok) assert.match(noCmd.message, /cmd\.exe was not found/);
});

// --------------------------------------------------------------------------- //
// the round trip
// --------------------------------------------------------------------------- //

const posixBridge = (fsSeam: FakeFs) => ({
  configured: "/usr/bin/ed",
  platform: "linux" as const,
  env: { PATH: "/usr/bin" },
  cwd: "/work",
  tmpdir: "/tmp/tb",
  fs: fsSeam,
});

test("injected spawn success seeds prompt.md 0600 and reads the normalized draft back", async () => {
  const fsSeam = new FakeFs(false);
  fsSeam.dir = "/tmp/tb/two-brothers-edit-abc123";
  fsSeam.addExecutable("/usr/bin/ed");
  fsSeam.readOverride = Buffer.from("\uFEFFedited\r\nline\r\n");
  const calls: SpawnCall[] = [];
  const result = await editTextInExternalEditor({
    ...posixBridge(fsSeam),
    text: "seed draft",
    spawn: recordingSpawn(calls, { code: 0 }),
  });

  assert.equal(result.kind, "edited");
  if (result.kind !== "edited") return;
  assert.equal(result.text, "edited\nline");
  assert.equal(result.changed, true);
  assert.equal(result.bytes, Buffer.byteLength("\uFEFFedited\r\nline\r\n"));
  assert.equal(fsSeam.prefix, path.join("/tmp/tb", EDITOR_TEMP_PREFIX));
  assert.equal(fsSeam.writes.length, 1);
  assert.equal(fsSeam.writes[0]?.file, path.join(fsSeam.dir, EDITOR_FILE_NAME));
  assert.equal(fsSeam.writes[0]?.data, "seed draft");
  assert.equal(fsSeam.writes[0]?.mode, 0o600);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.file, "/usr/bin/ed");
  assert.deepEqual(calls[0]?.args, [path.join(fsSeam.dir, EDITOR_FILE_NAME)]);
  assert.equal(calls[0]?.options.stdio, "inherit");
  assert.equal(calls[0]?.options.shell, false);
  assert.deepEqual(fsSeam.removed, [fsSeam.dir], "the temp directory is removed");
});

test("an unchanged draft reports changed: false, not a fake save", async () => {
  const fsSeam = new FakeFs(false);
  fsSeam.addExecutable("/usr/bin/ed");
  fsSeam.readOverride = Buffer.from("seed draft");
  const result = await editTextInExternalEditor({
    ...posixBridge(fsSeam),
    text: "seed draft",
    spawn: recordingSpawn([], { code: 0 }),
  });
  assert.equal(result.kind, "edited");
  if (result.kind === "edited") assert.equal(result.changed, false);
});

test("a nonzero exit leaves the draft untouched and still cleans up", async () => {
  const fsSeam = new FakeFs(false);
  fsSeam.addExecutable("/usr/bin/ed");
  const result = await editTextInExternalEditor({
    ...posixBridge(fsSeam),
    text: "keep me",
    spawn: recordingSpawn([], { code: 3 }),
  });
  assert.equal(result.kind, "error");
  if (result.kind === "error") assert.match(result.message, /exited with code 3/);
  assert.equal(fsSeam.reads.length, 0, "no read after a failed editor");
  assert.deepEqual(fsSeam.removed, [fsSeam.dir]);
});

test("a spawn error (synchronous throw or error event) is honest and leaves the draft untouched", async () => {
  const fsSeam = new FakeFs(false);
  fsSeam.addExecutable("/usr/bin/ed");
  const throwing: EditorSpawn = () => {
    throw new Error("EACCES: permission denied");
  };
  const sync = await editTextInExternalEditor({
    ...posixBridge(fsSeam),
    text: "keep me",
    spawn: throwing,
  });
  assert.equal(sync.kind, "error");
  if (sync.kind === "error") assert.match(sync.message, /could not start the editor: EACCES/);
  assert.deepEqual(fsSeam.removed, [fsSeam.dir]);

  const fsSeam2 = new FakeFs(false);
  fsSeam2.addExecutable("/usr/bin/ed");
  const asyncError = await editTextInExternalEditor({
    ...posixBridge(fsSeam2),
    text: "keep me",
    spawn: () => fakeChild({ error: new Error("ENOENT: editor vanished") }),
  });
  assert.equal(asyncError.kind, "error");
  if (asyncError.kind === "error") {
    assert.match(asyncError.message, /could not start the editor: ENOENT/);
    assert.match(asyncError.message, /draft was left unchanged/);
  }
  assert.deepEqual(fsSeam2.removed, [fsSeam2.dir]);
});

test("an oversized edited draft is refused and cleaned up", async () => {
  const fsSeam = new FakeFs(false);
  fsSeam.addExecutable("/usr/bin/ed");
  fsSeam.readOverride = new Uint8Array(EDITOR_MAX_BYTES + 1);
  const result = await editTextInExternalEditor({
    ...posixBridge(fsSeam),
    text: "seed",
    spawn: recordingSpawn([], { code: 0 }),
  });
  assert.equal(result.kind, "error");
  if (result.kind === "error") assert.match(result.message, /larger than 256 KiB/);
  assert.deepEqual(fsSeam.removed, [fsSeam.dir]);
});

test("a temp-directory write failure removes the directory and reports the reason", async () => {
  const fsSeam = new FakeFs(false);
  fsSeam.addExecutable("/usr/bin/ed");
  fsSeam.writeError = new Error("no space left on device");
  const calls: SpawnCall[] = [];
  const result = await editTextInExternalEditor({
    ...posixBridge(fsSeam),
    text: "seed",
    spawn: recordingSpawn(calls),
  });
  assert.equal(result.kind, "error");
  if (result.kind === "error") assert.match(result.message, /no space left on device/);
  assert.equal(calls.length, 0);
  assert.deepEqual(fsSeam.removed, [fsSeam.dir]);
});

test("an unresolvable editor fails before any temp file or spawn", async () => {
  const fsSeam = new FakeFs(false);
  const calls: SpawnCall[] = [];
  const result = await editTextInExternalEditor({
    configured: null,
    platform: "linux",
    env: {},
    cwd: "/work",
    fs: fsSeam,
    text: "seed",
    spawn: recordingSpawn(calls),
  });
  assert.equal(result.kind, "error");
  if (result.kind === "error") assert.match(result.message, /set \$VISUAL or \$EDITOR/);
  assert.equal(fsSeam.prefix, null, "no temp directory was created");
  assert.equal(calls.length, 0);
});

test("normalizeEditedText strips one BOM, CRLF and exactly one final newline", () => {
  assert.equal(normalizeEditedText("\uFEFFhello\r\nworld\r\n"), "hello\nworld");
  assert.equal(normalizeEditedText("keep\n\n"), "keep\n", "only one newline is removed");
  assert.equal(normalizeEditedText("plain"), "plain");
  assert.equal(normalizeEditedText("crlf\r\ninside\r\nbody\r\n"), "crlf\ninside\nbody");
});

// --------------------------------------------------------------------------- //
// terminal suspend/resume
// --------------------------------------------------------------------------- //

class TerminalInput extends EventEmitter {
  isTTY = true;
  rawMode: boolean | null = null;
  paused = false;
  resumed = false;
  encoding: string | null = null;

  setRawMode(value: boolean): void {
    this.rawMode = value;
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    this.resumed = true;
  }

  setEncoding(encoding: string): void {
    this.encoding = encoding;
  }
}

class TerminalOutput extends EventEmitter {
  isTTY = true;
  columns = 80;
  rows = 24;
  data = "";

  write(chunk: string): boolean {
    this.data += chunk;
    return true;
  }
}

function terminalPair(): {
  input: TerminalInput;
  output: TerminalOutput;
  terminal: ReturnType<typeof createTerminal>;
} {
  const input = new TerminalInput();
  const output = new TerminalOutput();
  const terminal = createTerminal(
    input as unknown as NodeJS.ReadStream,
    output as unknown as NodeJS.WriteStream,
  );
  return { input, output, terminal };
}

test("suspend releases the screen once, quiets render and resume restores it once", () => {
  const { input, output, terminal } = terminalPair();
  terminal.enter();
  output.data = "";

  terminal.suspend();
  assert.equal(terminal.isSuspended, true);
  assert.equal(occurrences(output.data, BRACKETED_PASTE_OFF), 1);
  assert.equal(occurrences(output.data, ANSI.showCursor), 1);
  assert.equal(occurrences(output.data, ANSI.altScreenOff), 1);
  assert.equal(input.rawMode, false);
  assert.equal(input.paused, true);

  const afterSuspend = output.data.length;
  terminal.render("must not paint");
  assert.equal(output.data.length, afterSuspend, "render is a no-op while suspended");
  assert.ok(!output.data.includes("must not paint"));
  terminal.suspend();
  assert.equal(output.data.length, afterSuspend, "suspend is idempotent");

  terminal.resume();
  assert.equal(terminal.isSuspended, false);
  const resumed = output.data.slice(afterSuspend);
  assert.equal(occurrences(resumed, ANSI.altScreenOn), 1);
  assert.equal(occurrences(resumed, ANSI.clearScreen), 1);
  assert.equal(occurrences(resumed, BRACKETED_PASTE_ON), 1);
  assert.equal(occurrences(resumed, ANSI.hideCursor), 1);
  assert.equal(input.rawMode, true);
  assert.equal(input.paused, false);

  const afterResume = output.data.length;
  terminal.resume();
  assert.equal(output.data.length, afterResume, "resume is idempotent");
  terminal.render("paints again");
  assert.ok(output.data.includes("paints again"));
});

test("a terminal that never entered is never suspended and writes nothing", () => {
  const { input, output, terminal } = terminalPair();
  terminal.suspend();
  terminal.resume();
  assert.equal(terminal.isSuspended, false);
  assert.equal(output.data, "");
  assert.equal(input.rawMode, null);
});

test("restore during a suspend wins; a later resume is a no-op", () => {
  const { input, output, terminal } = terminalPair();
  terminal.enter();
  terminal.suspend();
  const afterSuspend = output.data.length;
  terminal.restore();
  const restored = output.data.slice(afterSuspend);
  assert.equal(occurrences(restored, ANSI.altScreenOff), 1, "restore still exits once");
  assert.equal(occurrences(restored, ANSI.showCursor), 1);
  assert.equal(input.rawMode, false);

  output.data = "";
  terminal.resume();
  assert.equal(output.data, "", "resume after restore writes nothing");
  terminal.suspend();
  assert.equal(output.data, "", "suspend after restore writes nothing");
});
