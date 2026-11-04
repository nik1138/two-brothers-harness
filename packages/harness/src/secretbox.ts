/**
 * Secret box: API-key encryption at rest. Ports the original prototype's
 * secret box (removed 2026-11-04; see git history)
 * with compatible semantics (not wire format — DPAPI blobs are
 * per-machine/per-user anyway, so a `dpapi1:` value written by the prototype
 * decrypts here on the same account and vice versa; the base64 wrapper is identical).
 *
 * Windows: DPAPI (`CryptProtectData` equivalent) via a child-process
 * PowerShell `System.Security.Cryptography.ProtectedData` call with a fixed
 * `CurrentUser` scope — no native modules. Other platforms: no stdlib
 * keystore exists, so the key is stored base64-encoded under the `plain1:`
 * prefix and the settings file is chmod 0o600 instead (see settings_store.ts).
 *
 * Encoded values carry a version prefix so the reader never guesses:
 * `dpapi1:<base64>` or `plain1:<base64>`. Every DPAPI protect failure falls
 * back to `plain1:` (and is logged); a DPAPI backend that fails once is
 * treated as unavailable so subsequent keys skip the slow failing call.
 * Undecryptable `dpapi1:` blobs yield an empty string with a warning — the
 * run then behaves as if no key were set. Protecting an operator's key must
 * never crash the server.
 *
 * Batch note: one PowerShell spawn costs ~50-300 ms, so the box exposes
 * sealMany/unsealMany and SettingsStore batches every key of one write into
 * a single DPAPI invocation instead of one spawn per key.
 */
import { spawnSync } from "node:child_process";

export const DPAPI_PREFIX = "dpapi1:";
export const PLAIN_PREFIX = "plain1:";

/** Where DPAPI warnings go; defaults to console.error (Python logs a warning). */
export type WarningSink = (message: string) => void;

/**
 * Low-level DPAPI cipher: raw bytes in, raw bytes out. `unprotectMany`
 * returns null per item that cannot be decrypted (wrong user/machine, bad
 * blob) instead of throwing, mirroring Python's per-value catch.
 */
export interface DpapiCipher {
  protectMany(data: Buffer[]): Buffer[];
  unprotectMany(data: Buffer[]): Array<Buffer | null>;
}

/** The seal/unseal surface SettingsStore talks to. */
export interface SecretBox {
  seal(text: string): string;
  unseal(stored: string): string;
  /** Seal several plaintexts, ideally in one backend invocation. */
  sealMany(texts: string[]): string[];
  /** Unseal several stored values, ideally in one backend invocation. */
  unsealMany(storeds: string[]): string[];
}

function errorMessage(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

function plainEncode(text: string): string {
  return PLAIN_PREFIX + Buffer.from(text, "utf-8").toString("base64");
}

function plainDecode(stored: string): string {
  return Buffer.from(stored.slice(PLAIN_PREFIX.length), "base64").toString("utf-8");
}

// ---------------------------------------------------------------------------
// DPAPI via PowerShell (Windows, no native modules)
// ---------------------------------------------------------------------------

const PS_TIMEOUT_MS = 15_000;
const PS_MAX_BUFFER = 4 * 1024 * 1024;

/**
 * Run one batch of DPAPI operations in a single PowerShell process.
 * `$in` is a PowerShell array literal of base64 strings; each item is
 * protected/unprotected with the fixed CurrentUser scope and re-emitted as
 * base64, one line per item; a failing item yields an empty line (base64
 * never contains newlines, and DPAPI output is never empty).
 */
function dpapiScript(operation: "Protect" | "Unprotect", items: string[]): string {
  const array = items.map((b64) => `'${b64}'`).join(",");
  return [
    "Add-Type -AssemblyName System.Security",
    `$in = @(${array})`,
    "$out = foreach ($b64 in $in) {",
    "  try {",
    "    $bytes = [Convert]::FromBase64String($b64)",
    `    $res = [Security.Cryptography.ProtectedData]::${operation}($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)`,
    "    [Convert]::ToBase64String($res)",
    "  } catch {",
    '    ""',
    "  }",
    "}",
    '[Console]::Out.Write([string]::Join("`n", $out))',
  ].join("\n");
}

function runPowerShell(script: string): string {
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf-8",
    timeout: PS_TIMEOUT_MS,
    maxBuffer: PS_MAX_BUFFER,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = (result.stderr ?? "").trim();
    throw new Error(`powershell.exe exited with code ${result.status}${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout ?? "";
}

/**
 * DPAPI through `powershell.exe` + `ProtectedData`. Each process spawn costs
 * ~50-300 ms on this class of machine, so the cipher is batch-only and
 * `DefaultSecretBox` funnels every key of one settings write through a
 * single `protectMany` call.
 */
export class PowerShellDpapiCipher implements DpapiCipher {
  protectMany(data: Buffer[]): Buffer[] {
    const script = dpapiScript("Protect", data.map((buf) => buf.toString("base64")));
    const lines = runPowerShell(script).split(/\r?\n/).slice(0, data.length);
    if (lines.length < data.length) {
      throw new Error("powershell DPAPI protect returned too few results");
    }
    return lines.map((line, i) => {
      if (!line) throw new Error(`powershell DPAPI protect failed for item ${i}`);
      return Buffer.from(line, "base64");
    });
  }

  unprotectMany(data: Buffer[]): Array<Buffer | null> {
    const script = dpapiScript("Unprotect", data.map((buf) => buf.toString("base64")));
    const lines = runPowerShell(script).split(/\r?\n/).slice(0, data.length);
    if (lines.length < data.length) {
      throw new Error("powershell DPAPI unprotect returned too few results");
    }
    return lines.map((line) => (line ? Buffer.from(line, "base64") : null));
  }
}

// ---------------------------------------------------------------------------
// DefaultSecretBox
// ---------------------------------------------------------------------------

export interface SecretBoxOptions {
  /**
   * The DPAPI cipher to use. Defaults to `PowerShellDpapiCipher` on win32
   * and `null` (plain1:) elsewhere. Pass an explicit cipher for testing, or
   * `null` to force the plain1: path on any platform.
   */
  dpapi?: DpapiCipher | null;
  /** Warning sink; defaults to console.error. */
  onWarning?: WarningSink;
}

/**
 * The default secret box: DPAPI (`dpapi1:`) when a cipher is available,
 * base64 (`plain1:`) otherwise. Falls back and warns, never crashes —
 * Python parity.
 */
export class DefaultSecretBox implements SecretBox {
  private dpapi: DpapiCipher | null;
  private readonly onWarning: WarningSink;

  constructor(options: SecretBoxOptions = {}) {
    this.dpapi =
      options.dpapi !== undefined
        ? options.dpapi
        : process.platform === "win32"
          ? new PowerShellDpapiCipher()
          : null;
    this.onWarning = options.onWarning ?? ((message) => console.error(message));
  }

  seal(text: string): string {
    return this.sealMany([text])[0];
  }

  unseal(stored: string): string {
    return this.unsealMany([stored])[0];
  }

  sealMany(texts: string[]): string[] {
    if (!this.dpapi) return texts.map(plainEncode);
    try {
      const blobs = this.dpapi.protectMany(texts.map((text) => Buffer.from(text, "utf-8")));
      return blobs.map((blob) => DPAPI_PREFIX + blob.toString("base64"));
    } catch (exc) {
      // A protect failure means the backend is unusable (no powershell, a
      // timeout...): disable it for the rest of the process so subsequent
      // keys skip the slow failing call, and warn once.
      this.dpapi = null;
      this.onWarning(`DPAPI protect failed (${errorMessage(exc)}); storing keys with plain1:`);
      return texts.map(plainEncode);
    }
  }

  unsealMany(storeds: string[]): string[] {
    const out: string[] = new Array<string>(storeds.length);
    const dpapiIdx: number[] = [];
    const dpapiRaw: Buffer[] = [];
    for (let i = 0; i < storeds.length; i++) {
      const stored = storeds[i];
      if (stored.startsWith(DPAPI_PREFIX)) {
        dpapiIdx.push(i);
        dpapiRaw.push(Buffer.from(stored.slice(DPAPI_PREFIX.length), "base64"));
      } else if (stored.startsWith(PLAIN_PREFIX)) {
        out[i] = plainDecode(stored);
      } else {
        out[i] = stored; // hand-edited, unprefixed values read back as plaintext
      }
    }
    if (dpapiIdx.length === 0) return out;

    let results: Array<Buffer | null>;
    if (this.dpapi) {
      try {
        results = this.dpapi.unprotectMany(dpapiRaw);
      } catch (exc) {
        this.onWarning(`DPAPI unprotect failed (${errorMessage(exc)}); ignoring stored keys`);
        results = dpapiRaw.map(() => null);
      }
    } else {
      results = dpapiRaw.map(() => null);
    }
    dpapiIdx.forEach((idx, k) => {
      const blob = results[k];
      if (blob) {
        out[idx] = blob.toString("utf-8");
      } else {
        this.onWarning("DPAPI unprotect failed (undecryptable blob); ignoring stored key");
        out[idx] = "";
      }
    });
    return out;
  }
}

// ---------------------------------------------------------------------------
// Module-level convenience (Python's module functions protect/unprotect)
// ---------------------------------------------------------------------------

let shared: SecretBox | null = null;

/** The process-wide default box, created lazily once. */
export function defaultSecretBox(): SecretBox {
  if (!shared) shared = new DefaultSecretBox();
  return shared;
}

/** Set the process-wide default box (dependency injection for tests/apps). */
export function setDefaultSecretBox(box: SecretBox | null): void {
  shared = box;
}

export function seal(text: string, box: SecretBox = defaultSecretBox()): string {
  return box.seal(text);
}

export function unseal(stored: string, box: SecretBox = defaultSecretBox()): string {
  return box.unseal(stored);
}
