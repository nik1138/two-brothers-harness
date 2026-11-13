/**
 * Secret box DPAPI transport tests (packages/harness/src/secretbox.ts).
 *
 * The PowerShell DPAPI cipher must keep key material out of the
 * `powershell.exe -Command` argv (a command line is visible machine-wide);
 * payloads travel on the child's stdin instead. These tests capture the
 * spawn invocation through the cipher's injectable spawn seam and emulate
 * the PowerShell script's batch semantics — no real `powershell.exe`, no
 * real DPAPI, fully hermetic and offline. Payloads here are fake keys and
 * are never printed.
 *
 * Run with: node tests/run-all.ts (or node --test tests/)
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { spawnSync, SpawnSyncReturns } from "node:child_process";
import { PowerShellDpapiCipher } from "../src/secretbox.ts";

interface CapturedInvocation {
  cmd: string;
  args: string[];
  options: Record<string, unknown>;
}

interface FakeOptions {
  /** Exit with this non-zero status (stderr gets fakeStderr). */
  exitCode?: number;
  fakeStderr?: string;
  /** Fail at spawn time with this error. */
  spawnError?: Error;
  /** Drop this many output lines (simulates a truncated stdout). */
  truncateLines?: number;
  /** Payloads whose UTF-8 text contains this marker fail to protect. */
  protectFailMarker?: string;
}

const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

function strictB64(line: string): Buffer | null {
  if (line.length % 4 !== 0 || !B64_RE.test(line)) return null;
  return Buffer.from(line, "base64");
}

/**
 * Emulated powershell.exe: reads the items off `options.input`, applies
 * the deterministic transform the real script applies (protect prefixes
 * 0x01, unprotect strips it; anything else is an undecryptable blob), and
 * returns one base64 line per item, "" for a failed item.
 */
function fakePowerShell(captured: CapturedInvocation[], fake: FakeOptions = {}) {
  const fn = ((cmd: string, args: string[], options: Record<string, unknown>) => {
    captured.push({ cmd, args, options });
    if (fake.spawnError) {
      return { error: fake.spawnError, status: null, stdout: "", stderr: "" };
    }
    if (fake.exitCode !== undefined) {
      return { status: fake.exitCode, stdout: "", stderr: fake.fakeStderr ?? "" };
    }
    const script = args[args.length - 1];
    const protect = script.includes("::Protect(");
    const input = typeof options.input === "string" ? options.input : "";
    const items = input.split("\n");
    let lines = items.map((line) => {
      const bytes = strictB64(line);
      if (!bytes) return ""; // [Convert]::FromBase64String throws -> catch -> ""
      if (protect) {
        if (fake.protectFailMarker && bytes.toString("utf-8").includes(fake.protectFailMarker)) return "";
        return Buffer.concat([Buffer.from([0x01]), bytes]).toString("base64");
      }
      return bytes[0] === 0x01 ? bytes.subarray(1).toString("base64") : "";
    });
    if (fake.truncateLines) lines = lines.slice(0, Math.max(0, lines.length - fake.truncateLines));
    return { status: 0, stdout: lines.join("\n"), stderr: "" };
  }) as unknown as typeof spawnSync;
  return fn;
}

function lastInvocation(captured: CapturedInvocation[]): CapturedInvocation {
  assert.ok(captured.length > 0, "expected a captured spawn");
  return captured[captured.length - 1];
}

function assertArgvClean(inv: CapturedInvocation, secrets: string[]): void {
  const argv = [inv.cmd, ...inv.args];
  for (const secret of secrets) {
    for (const arg of argv) {
      assert.ok(!arg.includes(secret), "argv element carries payload material");
    }
  }
}

test("protect/unprotect payload arrives on stdin, never on argv", () => {
  const captured: CapturedInvocation[] = [];
  const cipher = new PowerShellDpapiCipher({ spawn: fakePowerShell(captured) });
  const first = Buffer.from("first-fake-key", "utf-8");
  const second = Buffer.from("second-fake-key-material", "utf-8");

  cipher.protectMany([first]);
  cipher.protectMany([second]);
  const foreignB64 = Buffer.from("AAAA").toString("base64");
  cipher.unprotectMany([Buffer.from("AAAA")]);

  assert.equal(captured.length, 3);
  const [p1, p2, u1] = captured;

  // Same argv shape every time: static flags + a static script.
  for (const inv of captured) {
    assert.deepEqual(inv.args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
    assert.equal(typeof inv.options.input, "string");
    assert.equal(inv.options.encoding, "utf-8");
    assert.equal(inv.options.timeout, 15_000);
    assert.equal(inv.options.maxBuffer, 4 * 1024 * 1024);
    assert.equal(inv.options.windowsHide, true);
  }

  // The -Command script is byte-identical across different payloads...
  assert.equal(p1.args[3], p2.args[3]);
  // ...and differs only in the fixed operation token between directions.
  assert.notEqual(p1.args[3], u1.args[3]);
  assert.match(p1.args[3], /::Protect\(/);
  assert.match(u1.args[3], /::Unprotect\(/);
  assert.match(p1.args[3], /\[Console\]::In\.ReadToEnd\(\)/);

  // No payload material — raw or base64 — anywhere in argv.
  assertArgvClean(p1, ["first-fake-key", first.toString("base64")]);
  assertArgvClean(p2, ["second-fake-key-material", second.toString("base64")]);
  assertArgvClean(u1, ["AAAA", foreignB64]);

  // The payload rides on stdin, one base64 item per line.
  assert.equal(p1.options.input, first.toString("base64"));
  assert.equal(p2.options.input, second.toString("base64"));
  assert.equal(u1.options.input, foreignB64);
});

test("multi-item batch: one spawn, items joined on stdin lines", () => {
  const captured: CapturedInvocation[] = [];
  const cipher = new PowerShellDpapiCipher({ spawn: fakePowerShell(captured) });
  const items = [Buffer.from("alpha", "utf-8"), Buffer.from("beta", "utf-8"), Buffer.from("gamma", "utf-8")];
  cipher.protectMany(items);
  assert.equal(captured.length, 1);
  assert.equal(lastInvocation(captured).options.input, items.map((b) => b.toString("base64")).join("\n"));
});

test("round trip through the emulated backend", () => {
  const captured: CapturedInvocation[] = [];
  const cipher = new PowerShellDpapiCipher({ spawn: fakePowerShell(captured) });
  const texts = ["key-one", "key-two", ""];
  const blobs = cipher.protectMany(texts.map((t) => Buffer.from(t, "utf-8")));
  assert.ok(blobs.every((b) => b.length > 0), "every protect yields a non-empty blob");
  const back = cipher.unprotectMany(blobs);
  // A blob decrypting to empty bytes emits an empty line, which reads back
  // as null — the same mapping the argv-based implementation had.
  assert.deepEqual(back.map((b) => (b ? b.toString("utf-8") : null)), ["key-one", "key-two", null]);
});

test("undecryptable or malformed blob yields null, not a throw", () => {
  const captured: CapturedInvocation[] = [];
  const cipher = new PowerShellDpapiCipher({ spawn: fakePowerShell(captured) });
  const good = cipher.protectMany([Buffer.from("good-key", "utf-8")])[0];
  const foreign = Buffer.from([0x02, 0x03, 0x04]); // not protected by this emulation
  const malformed = Buffer.from("!!!not-base64!!!", "utf-8");
  const results = cipher.unprotectMany([good, foreign, malformed]);
  assert.equal(results[0]?.toString("utf-8"), "good-key");
  assert.equal(results[1], null);
  assert.equal(results[2], null);
});

test("a failing protect item maps to the per-item error", () => {
  const captured: CapturedInvocation[] = [];
  const cipher = new PowerShellDpapiCipher({
    spawn: fakePowerShell(captured, { protectFailMarker: "boom" }),
  });
  assert.throws(
    () => cipher.protectMany([Buffer.from("ok-key", "utf-8"), Buffer.from("boom-key", "utf-8")]),
    /powershell DPAPI protect failed for item 1/,
  );
});

test("truncated stdout maps to the too-few-results error", () => {
  const captured: CapturedInvocation[] = [];
  const cipher = new PowerShellDpapiCipher({ spawn: fakePowerShell(captured, { truncateLines: 1 }) });
  assert.throws(() => cipher.protectMany([Buffer.from("a", "utf-8"), Buffer.from("b", "utf-8")]), {
    message: "powershell DPAPI protect returned too few results",
  });
  const captured2: CapturedInvocation[] = [];
  const cipher2 = new PowerShellDpapiCipher({ spawn: fakePowerShell(captured2, { truncateLines: 1 }) });
  assert.throws(() => cipher2.unprotectMany([Buffer.from("a", "utf-8"), Buffer.from("b", "utf-8")]), {
    message: "powershell DPAPI unprotect returned too few results",
  });
});

test("non-zero exit maps to the exit-code error with stderr detail", () => {
  const captured: CapturedInvocation[] = [];
  const cipher = new PowerShellDpapiCipher({
    spawn: fakePowerShell(captured, { exitCode: 1, fakeStderr: "  Add-Type failed  " }),
  });
  assert.throws(() => cipher.protectMany([Buffer.from("x", "utf-8")]), {
    message: "powershell.exe exited with code 1: Add-Type failed",
  });
});

test("spawn failure propagates as the spawn error", () => {
  const captured: CapturedInvocation[] = [];
  const spawnError = new Error("spawn powershell.exe ENOENT");
  const cipher = new PowerShellDpapiCipher({ spawn: fakePowerShell(captured, { spawnError }) });
  assert.throws(() => cipher.protectMany([Buffer.from("x", "utf-8")]), /ENOENT/);
});
