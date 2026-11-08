/**
 * `src/shell.ts` robustness tests (wave 24, lane J).
 *
 * F1: output is bounded while it streams. A child writing far more than the
 * 20 000-char cap must still produce the established middle-truncation
 * marker, retained memory must stay O(cap), incremental UTF-8 decoding must
 * keep split multi-byte characters whole, and the retained head/tail edges
 * must never cut a surrogate pair.
 *
 * F2: Windows tree cleanup spawns `%SystemRoot%\System32\taskkill.exe` by
 * absolute path, asynchronously, with ignored stdio and a bounded wait; a
 * spawn error/timeout falls back to `child.kill()` and never throws into the
 * tool path. The spawn seam is injected so the tests are hermetic on every
 * platform.
 *
 * The child process is a fake stream (the `spawnChild` seam): some sandboxes
 * deny piped child spawns, and a fake makes the chunk-boundary cases
 * deterministic. `workspace.test.ts` keeps the real-subprocess coverage.
 *
 * Run with: node tests/run-all.ts (or node --test tests/shell.test.ts).
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { ChildProcess } from "node:child_process";

import {
  BoundedOutput,
  DEFAULT_MAX_OUTPUT_CHARS,
  ShellRunner,
  TASKKILL_TIMEOUT_MS,
  killTree,
  resolveTaskkillPath,
  type ShellChildSpawn,
  type TaskkillOptions,
  type TaskkillProcess,
  type TaskkillSpawn,
} from "../src/shell.ts";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** True when `text` contains a high surrogate without its low partner, or a lone low. */
function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/** A fake ChildProcess: real readable stdout/stderr, explicit exit/error. */
class FakeChild extends EventEmitter {
  pid = 4242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();

  kill(): boolean {
    this.finish(0);
    return true;
  }

  finish(code: number | null): void {
    this.exitCode = code;
    this.emit("exit", code, null);
  }

  fail(error: Error): void {
    this.emit("error", error);
  }
}

function fakeRunner(child: FakeChild): ShellRunner {
  const spawnChild: ShellChildSpawn = () => child as unknown as ChildProcess;
  return new ShellRunner({ spawnChild });
}

interface FakeChildProcess {
  child: ChildProcess;
  kills: () => number;
}

function fakeChild(pid: number | undefined, exitCode: number | null = null): FakeChildProcess {
  let killCount = 0;
  const child = {
    pid,
    exitCode,
    kill() {
      killCount += 1;
      return true;
    },
  } as unknown as ChildProcess;
  return { child, kills: () => killCount };
}

interface SpawnCall {
  file: string;
  args: readonly string[];
  options: TaskkillOptions;
}

/**
 * A fake `spawn` that records its invocation and emits `behavior` on the
 * returned EventEmitter on the next tick (the real spawn's events are async).
 */
function fakeSpawn(behavior: (emitter: EventEmitter) => void): {
  spawnTaskkill: TaskkillSpawn;
  calls: SpawnCall[];
} {
  const calls: SpawnCall[] = [];
  const spawnTaskkill: TaskkillSpawn = (file, args, options) => {
    calls.push({ file, args, options });
    const emitter = new EventEmitter();
    setImmediate(() => behavior(emitter));
    return emitter as unknown as TaskkillProcess;
  };
  return { spawnTaskkill, calls };
}

// ---------------------------------------------------------------------------
// F2 — absolute, asynchronous taskkill with a bounded fallback
// ---------------------------------------------------------------------------

test("killTree spawns the absolute System32 taskkill asynchronously", async () => {
  const { child, kills } = fakeChild(4321);
  const { spawnTaskkill, calls } = fakeSpawn((emitter) => emitter.emit("exit", 0, null));

  await killTree(child, {
    platform: "win32",
    env: { SystemRoot: "C:\\Windows" },
    spawnTaskkill,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, path.win32.join("C:\\Windows", "System32", "taskkill.exe"));
  assert.deepEqual([...calls[0].args], ["/F", "/T", "/PID", "4321"]);
  assert.equal(calls[0].options.stdio, "ignore");
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[0].options.timeout, TASKKILL_TIMEOUT_MS);
  assert.ok(calls[0].options.timeout < 10_000, "the old synchronous 10 s wait is gone");
  assert.equal(kills(), 0, "a successful taskkill does not need child.kill");
});

test("killTree skips taskkill for an already-exited child", async () => {
  const { child, kills } = fakeChild(55, 0);
  const { spawnTaskkill, calls } = fakeSpawn(() => {
    // never emits
  });

  await killTree(child, { platform: "win32", env: {}, spawnTaskkill });
  assert.equal(calls.length, 0, "no PID is signaled after the child already exited");
  assert.equal(kills(), 0);
});

test("resolveTaskkillPath prefers SystemRoot, then WINDIR, then C:\\Windows", () => {
  const expected = (root: string): string => path.win32.join(root, "System32", "taskkill.exe");

  assert.equal(resolveTaskkillPath({ SystemRoot: "D:\\Sys" }), expected("D:\\Sys"));
  assert.equal(resolveTaskkillPath({ WINDIR: "E:\\Win" }), expected("E:\\Win"));
  assert.equal(
    resolveTaskkillPath({ SystemRoot: "D:\\Sys", WINDIR: "E:\\Win" }),
    expected("D:\\Sys"),
  );
  // A non-absolute SystemRoot is not a trustworthy base; fall through.
  assert.equal(
    resolveTaskkillPath({ SystemRoot: "relative", WINDIR: "F:\\Win" }),
    expected("F:\\Win"),
  );
  assert.equal(resolveTaskkillPath({}), expected("C:\\Windows"));
});

test("killTree consumes a taskkill spawn error and falls back to child.kill", async () => {
  const { child, kills } = fakeChild(99);
  const { spawnTaskkill } = fakeSpawn((emitter) => emitter.emit("error", new Error("ENOENT")));

  await assert.doesNotReject(
    killTree(child, { platform: "win32", env: {}, spawnTaskkill }),
  );
  assert.equal(kills(), 1);
});

test("killTree falls back when taskkill reports a nonzero exit", async () => {
  const { child, kills } = fakeChild(12);
  const { spawnTaskkill } = fakeSpawn((emitter) => emitter.emit("exit", 1, null));

  await killTree(child, { platform: "win32", env: {}, spawnTaskkill });
  assert.equal(kills(), 1);
});

test("killTree never throws when the taskkill spawn itself throws", async () => {
  const { child, kills } = fakeChild(7);
  const spawnTaskkill: TaskkillSpawn = () => {
    throw new Error("spawn blocked by sandbox");
  };

  await assert.doesNotReject(
    killTree(child, { platform: "win32", env: {}, spawnTaskkill }),
  );
  assert.equal(kills(), 1);
});

test("killTree stays bounded when taskkill never exits", async () => {
  const { child, kills } = fakeChild(11);
  const { spawnTaskkill } = fakeSpawn(() => {
    // never emits
  });

  const started = Date.now();
  await killTree(child, {
    platform: "win32",
    env: {},
    spawnTaskkill,
    timeoutMs: 20,
  });
  const elapsed = Date.now() - started;

  assert.equal(kills(), 1);
  assert.ok(elapsed < 2_000, `cleanup took ${elapsed}ms`);
});

// ---------------------------------------------------------------------------
// F1 — bounded streaming output
// ---------------------------------------------------------------------------

test("BoundedOutput retains at most the cap while streaming", () => {
  const cap = 1_000;
  const capture = new BoundedOutput(cap);
  for (let i = 0; i < 500; i += 1) {
    capture.push("x".repeat(1_000));
    assert.ok(capture.retainedChars <= cap, `retained ${capture.retainedChars} > ${cap}`);
  }

  const out = capture.finish();
  assert.equal(out.truncated, true);
  assert.match(out.text, /\.\.\.\[truncated 499000 chars\]\.\.\./);
  assert.ok(out.text.length <= cap + 100);
});

test("BoundedOutput keeps the established truncation contract", () => {
  const atCap = new BoundedOutput(10);
  atCap.push("abcdefghij");
  assert.deepEqual(atCap.finish(), { text: "abcdefghij", truncated: false });

  const overCap = new BoundedOutput(10);
  overCap.push("abcdefghijk");
  const out = overCap.finish();
  assert.equal(out.truncated, true);
  assert.equal(out.text, "abcde\n...[truncated 1 chars]...\nghijk");

  // Odd caps retain exactly the cap and count the real omissions (the old
  // helper kept cap-1 and reported one fewer omitted char).
  const oddCap = new BoundedOutput(9);
  oddCap.push("abcdefghijk");
  assert.equal(oddCap.finish().text, "abcd\n...[truncated 2 chars]...\nghijk");
});

test("BoundedOutput never leaves half a surrogate pair at a retained edge", () => {
  // Head boundary (5) lands between the high and low surrogate of the emoji.
  const headSplit = new BoundedOutput(10);
  headSplit.push(`abcd\u{1F600}efghij`);
  const headOut = headSplit.finish();
  assert.equal(headOut.truncated, true);
  assert.equal(hasLoneSurrogate(headOut.text), false);
  assert.ok(headOut.text.startsWith("abcd"));
  assert.ok(headOut.text.endsWith("fghij"));

  // Tail boundary (index 9) lands on the low surrogate of the emoji.
  const tailSplit = new BoundedOutput(10);
  tailSplit.push(`abcdefgh\u{1F600}ijkl`);
  const tailOut = tailSplit.finish();
  assert.equal(tailOut.truncated, true);
  assert.equal(hasLoneSurrogate(tailOut.text), false);
  assert.ok(tailOut.text.startsWith("abcde"));
  assert.ok(tailOut.text.endsWith("ijkl"));
});

test("run_shell bounds a child stream far over the cap", async () => {
  const child = new FakeChild();
  const pending = fakeRunner(child).run("fake-output");
  for (let i = 0; i < 500; i += 1) child.stdout.write(Buffer.from("x".repeat(1_000)));
  child.finish(0);
  const result = await pending;

  assert.equal(result.status, "ok");
  assert.equal(result.exit_code, 0);
  assert.equal(result.truncated, true);
  assert.match(result.stdout, /\.\.\.\[truncated 480000 chars\]\.\.\./);
  assert.ok(
    result.stdout.length <= DEFAULT_MAX_OUTPUT_CHARS + 100,
    `stdout kept ${result.stdout.length} chars`,
  );
});

test("run_shell bounds stderr the same way", async () => {
  const child = new FakeChild();
  const pending = fakeRunner(child).run("fake-stderr");
  child.stderr.write(Buffer.from("e".repeat(50_000)));
  child.finish(0);
  const result = await pending;

  assert.equal(result.truncated, true);
  assert.match(result.stderr, /\.\.\.\[truncated 30000 chars\]\.\.\./);
  assert.ok(result.stderr.length <= DEFAULT_MAX_OUTPUT_CHARS + 100);
});

test("run_shell keeps split multi-byte UTF-8 characters whole", async () => {
  const child = new FakeChild();
  const pending = fakeRunner(child).run("fake-utf8");
  const emoji = Buffer.from("\u{1F600}", "utf8");
  // The two halves of the 4-byte emoji are written in separate chunks.
  child.stdout.write(emoji.subarray(0, 2));
  child.stdout.write(emoji.subarray(2));
  child.finish(0);
  const result = await pending;

  assert.equal(result.stdout, "\u{1F600}");
  assert.equal(result.stdout.includes("\uFFFD"), false);
  assert.equal(result.truncated, false);
});

test("run_shell does not split a surrogate pair at the truncation edges", async () => {
  const child = new FakeChild();
  const pending = fakeRunner(child).run("fake-emoji");
  // One ASCII prefix makes the 10 000-char head boundary land inside a pair.
  const bytes = Buffer.from("a" + "\u{1F600}".repeat(15_000), "utf8");
  // Odd-sized chunks force the decoder to reassemble multi-byte characters.
  for (let offset = 0; offset < bytes.length; offset += 7) {
    child.stdout.write(bytes.subarray(offset, offset + 7));
  }
  child.finish(0);
  const result = await pending;

  assert.equal(result.truncated, true);
  assert.equal(result.stdout.includes("\uFFFD"), false);
  assert.equal(hasLoneSurrogate(result.stdout), false);
  assert.ok(result.stdout.startsWith("a\u{1F600}"));
  assert.ok(result.stdout.endsWith("\u{1F600}"));
  assert.ok(result.stdout.length <= DEFAULT_MAX_OUTPUT_CHARS + 100);
});

test("run_shell sanitizes an escape sequence split across writes", async () => {
  const child = new FakeChild();
  const pending = fakeRunner(child).run("fake-ansi");
  child.stdout.write(Buffer.from("\x1b"));
  child.stdout.write(Buffer.from("[31mred\x1b[0m"));
  child.finish(0);
  const result = await pending;

  assert.equal(result.stdout, "red");
  assert.equal(result.stdout.includes("\x1b"), false);
});

test("run_shell sanitizes an escape sequence split after ESC[", async () => {
  const child = new FakeChild();
  const pending = fakeRunner(child).run("fake-ansi-csi");
  child.stdout.write(Buffer.from("\x1b["));
  child.stdout.write(Buffer.from("31mred\x1b[0m"));
  child.finish(0);
  const result = await pending;

  assert.equal(result.stdout, "red");
  assert.equal(result.stdout.includes("\x1b"), false);
});

test("run_shell strips a terminal-title OSC sequence instead of leaking its payload", async () => {
  const child = new FakeChild();
  const pending = fakeRunner(child).run("fake-osc");
  // OSC 0 (window title) terminated by ST: the payload must not reach the
  // tool result just because the terminator contains a second ESC.
  child.stdout.write(Buffer.from("\x1b]0;SECRET-TITLE\x1b\\visible"));
  child.finish(0);
  const result = await pending;

  assert.equal(result.stdout, "visible");
  assert.equal(result.stdout.includes("SECRET-TITLE"), false);
  assert.equal(result.stdout.includes("\x1b"), false);
});

test("run_shell strips an OSC sequence split before its ST terminator", async () => {
  const child = new FakeChild();
  const pending = fakeRunner(child).run("fake-osc-split");
  child.stdout.write(Buffer.from("\x1b]0;SECRET-TITLE"));
  child.stdout.write(Buffer.from("\x1b\\visible"));
  child.finish(0);
  const result = await pending;

  assert.equal(result.stdout, "visible");
  assert.equal(result.stdout.includes("SECRET-TITLE"), false);
});

test("run_shell strips a BEL-terminated OSC-8 hyperlink", async () => {
  const child = new FakeChild();
  const pending = fakeRunner(child).run("fake-osc8");
  child.stdout.write(Buffer.from("\x1b]8;;https://example.test\x07link"));
  child.finish(0);
  const result = await pending;

  assert.equal(result.stdout, "link");
  assert.equal(result.stdout.includes("example.test"), false);
});

test("run_shell leaves zero and small output byte-stable", async () => {
  const emptyChild = new FakeChild();
  const emptyPending = fakeRunner(emptyChild).run("fake-empty");
  emptyChild.finish(0);
  const empty = await emptyPending;

  assert.equal(empty.status, "ok");
  assert.equal(empty.stdout, "");
  assert.equal(empty.stderr, "");
  assert.equal(empty.truncated, false);

  const smallChild = new FakeChild();
  const smallPending = fakeRunner(smallChild).run("fake-small");
  smallChild.stdout.write(Buffer.from("hello"));
  smallChild.finish(0);
  const small = await smallPending;

  assert.equal(small.stdout, "hello");
  assert.equal(small.stderr, "");
  assert.equal(small.truncated, false);
});

test("run_shell turns a throwing spawn into a structured error", async () => {
  const runner = new ShellRunner({
    spawnChild: () => {
      throw new Error("spawn blocked");
    },
  });
  const result = await runner.run("fake");

  assert.equal(result.status, "error");
  assert.match(result.error, /spawn blocked/);
  assert.equal(result.exit_code, null);
});

test("run_shell consumes an async child spawn error", async () => {
  const child = new FakeChild();
  const pending = fakeRunner(child).run("fake");
  child.fail(new Error("EPERM"));
  const result = await pending;

  assert.equal(result.status, "error");
  assert.match(result.error, /EPERM/);
});

test("run_shell reports the child exit code", async () => {
  const child = new FakeChild();
  const pending = fakeRunner(child).run("fake");
  child.finish(3);
  const result = await pending;

  assert.equal(result.status, "ok");
  assert.equal(result.exit_code, 3);
});
