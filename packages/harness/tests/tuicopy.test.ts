/**
 * TUI copy-last-reply suite: the pure selection rule behind Ctrl+X and the
 * clipboard writer layer (selection precedence, streaming exclusion, platform
 * writer order, OSC 52 framing/cap, injected spawn failures and the honest
 * result). Hermetic — injected spawn and OSC 52 sink; no real clipboard, no
 * child process and no terminal is touched.
 *
 * Run with: node --test tests/tuicopy.test.ts
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";

import { lastReplyText } from "../src/tui/copytext.ts";
import {
  CLIP_FILE_ENV,
  OSC52_MAX_ENCODED_CHARS,
  clipboardMethodLabel,
  clipboardWriters,
  copyToClipboard,
  isRemoteSession,
  osc52Sequence,
  type ClipboardChild,
  type ClipboardMethod,
  type ClipboardSpawn,
  type ClipboardSpawnOptions,
} from "../src/tui/clipboard.ts";
import type {
  DecisionBlock,
  EnvelopeBlock,
  NoticeBlock,
  ToolBlock,
  TuiBlock,
  TuiModel,
  UserBlock,
} from "../src/tui/model.ts";

function modelOf(blocks: TuiBlock[]): TuiModel {
  return { blocks, nextId: blocks.length + 1 };
}

let seq = 0;
function decision(text: string, overrides: Partial<DecisionBlock> = {}): DecisionBlock {
  seq += 1;
  return {
    kind: "decision",
    id: `d${seq}`,
    messageId: `m${seq}`,
    role: "senior",
    direction: "out",
    text,
    streaming: false,
    committed: true,
    ...overrides,
  };
}

function envelope(
  role: "senior" | "junior",
  text: string,
  overrides: Partial<EnvelopeBlock> = {},
): EnvelopeBlock {
  seq += 1;
  return {
    kind: "envelope",
    id: `e${seq}`,
    messageId: `m${seq}`,
    role,
    direction: "out",
    envelopeKind: "message",
    text,
    streaming: false,
    committed: true,
    ...overrides,
  };
}

function user(text: string): UserBlock {
  seq += 1;
  return { kind: "user", id: `u${seq}`, text, messageId: `m${seq}` };
}

function notice(text: string): NoticeBlock {
  seq += 1;
  return { kind: "notice", id: `n${seq}`, level: "info", text };
}

function tool(text: string): ToolBlock {
  seq += 1;
  return {
    kind: "tool",
    id: `t${seq}`,
    role: "junior",
    tool: "echo",
    status: "ok",
    result: text,
  };
}

// ---------------------------------------------------------------------------
// selection
// ---------------------------------------------------------------------------

test("lastReplyText prefers the newest committed decision block", () => {
  const model = modelOf([
    decision("old decision"),
    envelope("senior", "senior message"),
    decision("newest decision"),
  ]);
  assert.equal(lastReplyText(model), "newest decision");
});

test("lastReplyText falls back to the newest committed senior envelope only", () => {
  const model = modelOf([
    user("operator task"),
    envelope("senior", "first senior reply"),
    envelope("junior", "junior-only proposal"),
    tool("tool result"),
    notice("a notice"),
    envelope("senior", "newest senior reply"),
    envelope("junior", "another junior proposal"),
  ]);
  assert.equal(lastReplyText(model), "newest senior reply");
});

test("lastReplyText never copies junior, user, tool, notice or summary blocks", () => {
  assert.equal(
    lastReplyText(
      modelOf([
        user("task"),
        envelope("junior", "junior proposal"),
        tool("tool output"),
        notice("notice"),
      ]),
    ),
    null,
  );
});

test("lastReplyText excludes streaming drafts and interrupted replies", () => {
  assert.equal(
    lastReplyText(modelOf([envelope("senior", "partial", { streaming: true, committed: false })])),
    null,
  );
  assert.equal(
    lastReplyText(
      modelOf([
        envelope("senior", "older committed reply"),
        envelope("senior", "live draft", { streaming: true, committed: false }),
      ]),
    ),
    "older committed reply",
  );
  assert.equal(
    lastReplyText(
      modelOf([
        decision("interrupted decision", {
          streaming: false,
          committed: false,
          interrupted: true,
        }),
      ]),
    ),
    null,
  );
  assert.equal(
    lastReplyText(modelOf([decision("", { streaming: false })])),
    null,
    "a blank reply is not copyable",
  );
});

test("lastReplyText is null for an empty transcript", () => {
  assert.equal(lastReplyText(modelOf([])), null);
  assert.equal(lastReplyText({ blocks: [], nextId: 1 }), null);
});

// ---------------------------------------------------------------------------
// OSC 52
// ---------------------------------------------------------------------------

test("osc52Sequence frames UTF-8 text as ESC ] 52 ; c ; base64 BEL", () => {
  assert.equal(
    osc52Sequence("hello"),
    `\u001b]52;c;${Buffer.from("hello", "utf8").toString("base64")}\u0007`,
  );
  const unicode = "héllo 👋";
  assert.equal(
    osc52Sequence(unicode),
    `\u001b]52;c;${Buffer.from(unicode, "utf8").toString("base64")}\u0007`,
  );
});

test("osc52Sequence refuses payloads over the encoded-character cap", () => {
  const atCap = "a".repeat(75_000); // 100 000 base64 chars exactly
  assert.equal(osc52Sequence(atCap)?.length, `\u001b]52;c;`.length + 100_000 + 1);
  assert.equal(Buffer.from(atCap, "utf8").toString("base64").length, OSC52_MAX_ENCODED_CHARS);
  assert.equal(osc52Sequence(`${atCap}a`), null, "one more byte must refuse, never truncate");
});

test("clipboardMethodLabel names the honest transport", () => {
  assert.equal(clipboardMethodLabel("osc52"), "OSC 52");
  assert.equal(clipboardMethodLabel("powershell"), "powershell");
  assert.equal(clipboardMethodLabel(null), "no method");
});

// ---------------------------------------------------------------------------
// writer selection
// ---------------------------------------------------------------------------

test("clipboardWriters: Windows resolves absolute System32 helpers in order", () => {
  const writers = clipboardWriters({
    platform: "win32",
    env: { SystemRoot: "C:\\Windows" },
  });
  assert.deepEqual(
    writers.map((writer) => writer.method),
    ["powershell", "clip"],
  );
  assert.equal(
    writers[0]?.command,
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  );
  assert.equal(writers[1]?.command, "C:\\Windows\\System32\\clip.exe");
  assert.deepEqual(writers[0]?.args.slice(0, 3), [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
  ]);
  assert.match(writers[0]?.args[3] ?? "", /Set-Clipboard/);
  assert.match(writers[0]?.args[3] ?? "", new RegExp(CLIP_FILE_ENV));
  assert.equal(writers[0]?.args.includes("-NoLogo"), false);
});

test("clipboardWriters: macOS uses pbcopy, POSIX display envs gate Linux helpers", () => {
  assert.deepEqual(
    clipboardWriters({ platform: "darwin", env: {} }).map((writer) => writer.method),
    ["pbcopy"],
  );
  assert.deepEqual(
    clipboardWriters({ platform: "linux", env: {} }),
    [],
    "no display environment means no native writer",
  );
  assert.deepEqual(
    clipboardWriters({ platform: "linux", env: { WAYLAND_DISPLAY: "wayland-0" } }).map(
      (writer) => writer.method,
    ),
    ["wl-copy"],
  );
  assert.deepEqual(
    clipboardWriters({ platform: "linux", env: { DISPLAY: ":0" } }).map(
      (writer) => writer.method,
    ),
    ["xclip", "xsel"],
  );
  assert.deepEqual(
    clipboardWriters({
      platform: "linux",
      env: { WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" },
    }).map((writer) => writer.method),
    ["wl-copy", "xclip", "xsel"],
  );
});

test("isRemoteSession names the three remote transports", () => {
  for (const key of ["SSH_CONNECTION", "SSH_CLIENT", "MOSH_CONNECTION"] as const) {
    assert.equal(isRemoteSession({ [key]: "value" }), true, key);
    assert.equal(isRemoteSession({ [key]: "   " }), false, `${key} blank is local`);
  }
  assert.equal(isRemoteSession({}), false);
});

// ---------------------------------------------------------------------------
// injected writers
// ---------------------------------------------------------------------------

interface SpawnCall {
  command: string;
  args: readonly string[];
  options: ClipboardSpawnOptions;
}

interface FakeOutcome {
  code?: number | null;
  signal?: NodeJS.Signals | null;
  error?: string;
  /** Never settle (the writer must time out). */
  never?: boolean;
  stdin?: string[];
  onSpawn?: (call: SpawnCall) => void;
}

function fakeSpawn(outcome: FakeOutcome = {}): {
  spawn: ClipboardSpawn;
  calls: SpawnCall[];
  killed: string[];
} {
  const calls: SpawnCall[] = [];
  const killed: string[] = [];
  const spawn: ClipboardSpawn = (command, args, options) => {
    const call: SpawnCall = { command, args, options };
    calls.push(call);
    outcome.onSpawn?.(call);
    const listeners = new Map<string, (...values: unknown[]) => void>();
    const child = {
      stdin: {
        end(chunk?: string | Buffer): void {
          const text = typeof chunk === "string" ? chunk : (chunk ?? Buffer.alloc(0)).toString("utf8");
          outcome.stdin?.push(text);
        },
      },
      once(event: string, listener: (...values: unknown[]) => void): unknown {
        listeners.set(event, listener);
        return child;
      },
      kill(signal?: NodeJS.Signals | number): boolean {
        killed.push(String(signal));
        return true;
      },
    };
    if (outcome.never !== true) {
      setImmediate(() => {
        if (outcome.error !== undefined) {
          listeners.get("error")?.(new Error(outcome.error));
        } else {
          listeners.get("close")?.(outcome.code ?? 0, outcome.signal ?? null);
        }
      });
    }
    return child as unknown as ClipboardChild;
  };
  return { spawn, calls, killed };
}

test("copyToClipboard: Windows PowerShell reads a UTF-8 temp file and cleans up", async () => {
  let fileText = "";
  let tempFile = "";
  const fake = fakeSpawn({
    code: 0,
    onSpawn: (call) => {
      tempFile = call.options.env[CLIP_FILE_ENV] ?? "";
      fileText = fs.readFileSync(tempFile, "utf8");
    },
  });
  const result = await copyToClipboard("héllo 👋", {
    platform: "win32",
    env: { SystemRoot: "C:\\Windows" },
    spawn: fake.spawn,
    write: () => {
      throw new Error("native must win, not OSC 52");
    },
  });
  assert.deepEqual(
    { ok: result.ok, method: result.method, chars: result.chars },
    { ok: true, method: "powershell", chars: 8 },
  );
  assert.equal(fake.calls.length, 1, "the first writer succeeded");
  assert.equal(fileText, "héllo 👋", "the temp file is UTF-8 and complete");
  assert.equal(fs.existsSync(tempFile), false, "the temp file is removed afterwards");
  assert.equal(fake.calls[0]?.options.shell, false, "never through a shell");
});

test("copyToClipboard: a stdin writer receives the exact text and reports its method", async () => {
  const stdin: string[] = [];
  const fake = fakeSpawn({ code: 0, stdin });
  const result = await copyToClipboard("line one\nline two", {
    platform: "darwin",
    env: {},
    spawn: fake.spawn,
    write: () => {
      throw new Error("native must win");
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.method, "pbcopy" satisfies ClipboardMethod);
  assert.deepEqual(stdin, ["line one\nline two"]);
  assert.equal(fake.calls[0]?.command, "pbcopy");
});

test("copyToClipboard falls back to OSC 52 when every native writer fails", async () => {
  const fake = fakeSpawn({ error: "no such helper" });
  const written: string[] = [];
  const result = await copyToClipboard("fallback text", {
    platform: "linux",
    env: { DISPLAY: ":0" },
    spawn: fake.spawn,
    write: (sequence) => written.push(sequence),
  });
  assert.equal(fake.calls.length, 2, "xclip and xsel were both tried");
  assert.deepEqual(
    { ok: result.ok, method: result.method, chars: result.chars },
    { ok: true, method: "osc52", chars: 13 },
  );
  assert.deepEqual(written, [osc52Sequence("fallback text")]);
});

test("copyToClipboard reports failure honestly when native and OSC 52 both fail", async () => {
  const fake = fakeSpawn({ code: 1 });
  const result = await copyToClipboard("no copy", {
    platform: "darwin",
    env: {},
    spawn: fake.spawn,
    write: () => {
      throw new Error("terminal is gone");
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.method, null);
  assert.equal(result.chars, 7);
  assert.match(result.error ?? "", /pbcopy: exit code 1/);
  assert.match(result.error ?? "", /OSC 52: terminal is gone/);
});

test("copyToClipboard: a remote session goes straight to OSC 52", async () => {
  const fake = fakeSpawn({ code: 0 });
  const written: string[] = [];
  const result = await copyToClipboard("remote reply", {
    platform: "win32",
    env: { SSH_CONNECTION: "10.0.0.1 50000 10.0.0.2 22", SystemRoot: "C:\\Windows" },
    spawn: fake.spawn,
    write: (sequence) => written.push(sequence),
  });
  assert.equal(fake.calls.length, 0, "no native helper runs on the remote host");
  assert.equal(result.method, "osc52");
  assert.deepEqual(written, [osc52Sequence("remote reply")]);
});

test("copyToClipboard times out a stuck writer instead of hanging the TUI", async () => {
  const fake = fakeSpawn({ never: true });
  const written: string[] = [];
  const result = await copyToClipboard("stuck", {
    platform: "darwin",
    env: {},
    spawn: fake.spawn,
    write: (sequence) => written.push(sequence),
    timeoutMs: 20,
  });
  assert.equal(result.method, "osc52", "the fallback still ran");
  assert.deepEqual(fake.killed, ["SIGKILL"]);
  assert.deepEqual(written, [osc52Sequence("stuck")]);
});

test("copyToClipboard refuses an oversized OSC 52 payload without truncating", async () => {
  const result = await copyToClipboard("a".repeat(75_001), {
    platform: "linux",
    env: {},
    spawn: fakeSpawn().spawn,
    write: () => {
      throw new Error("must not write an oversized sequence");
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /100 000|100000|cap/);
});
