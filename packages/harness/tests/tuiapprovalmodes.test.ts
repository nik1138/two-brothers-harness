/**
 * TUI approval-mode surface: the `/permission` dialog states the persisted
 * operator mode and its warning honestly, its buttons persist a change through
 * the same `SettingsStore` `serve` uses, and the typed `/permission <mode>`
 * form applies/refuses values. The dialog details are toggled with `d` (the
 * long-standing dialog behavior), so the assertions open them explicitly.
 * The decision table itself lives in `tests/approvalmodes.test.ts`; this suite
 * covers the assembled-app wiring (read at startup/dialog, write-back,
 * next-turn semantics copy).
 *
 * Hermetic: temp session directories, the offline mock provider, fake TTY
 * streams. Run with `node tests/run-all.ts` (or this file directly).
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { resolveConfig } from "../src/config.ts";
import { SettingsStore } from "../src/settings_store.ts";
import { runTuiApp, type TuiIO } from "../src/tui/app.ts";
import { ANSI, stripAnsi } from "../src/tui/render.ts";

class FakeInput extends EventEmitter {
  isTTY = true;
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  setEncoding(): void {}
  unref(): void {}

  type(text: string): void {
    for (const char of text) {
      this.emit("keypress", char, { name: char, ctrl: false, shift: char !== char.toLowerCase() });
    }
  }

  key(name: string, modifiers: { ctrl?: boolean; shift?: boolean; raw?: string } = {}): void {
    this.emit("keypress", modifiers.raw ?? "", {
      name,
      ctrl: modifiers.ctrl === true,
      shift: modifiers.shift === true,
    });
  }

  enter(): void {
    this.key("return", { raw: "\r" });
  }
}

class FakeOutput extends EventEmitter {
  isTTY = true;
  columns = 100;
  rows = 30;
  data = "";
  write(chunk: string): boolean {
    this.data += chunk;
    return true;
  }
  resize(columns: number, rows: number): void {
    this.columns = columns;
    this.rows = rows;
    this.emit("resize");
  }
}

function makeIO(): TuiIO & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, log: (line) => out.push(line), error: (line) => err.push(line) };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
}

interface Harness {
  app: Promise<number>;
  input: FakeInput;
  output: FakeOutput;
  sessionsDir: string;
  workspace: string;
  cleanup: () => void;
}

function startApp(extra: { approvalMode?: "ask" | "readonly" | "edits" | "allow-all" } = {}): Harness {
  const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-tui-mode-sessions-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "tb-tui-mode-workspace-"));
  const input = new FakeInput();
  const output = new FakeOutput();
  const io = makeIO();
  const app = runTuiApp({
    cfg: resolveConfig({ provider: "mock" }),
    io,
    workspaceRoot: workspace,
    sessionsDir,
    pluginsDir: `${process.cwd()}/does-not-exist-tui-approval-plugins`,
    ...(extra.approvalMode !== undefined ? { approvalMode: extra.approvalMode } : {}),
    input: input as unknown as NodeJS.ReadStream,
    output: output as unknown as NodeJS.WriteStream,
  });
  return {
    app,
    input,
    output,
    sessionsDir,
    workspace,
    cleanup: () => {
      fs.rmSync(sessionsDir, { recursive: true, force: true });
      fs.rmSync(workspace, { recursive: true, force: true });
    },
  };
}

/** The settings file the TUI's provider store actually reads. */
const settingsFile = (sessionsDir: string): string => path.join(sessionsDir, "settings.json");

const textOf = (output: FakeOutput): string => stripAnsi(output.data);

/** The newest fully rendered frame (rows joined with newlines). */
const lastFrameText = (output: FakeOutput): string =>
  stripAnsi(output.data.split(ANSI.cursorHome).at(-1) ?? "");

/** Open `/permission`, wait for the dialog, then reveal the details with `d`. */
async function openPermissionDetails(h: Harness): Promise<string> {
  h.input.type("/permission");
  h.input.enter();
  assert.ok(await waitFor(() => textOf(h.output).includes("PERMISSIONS")), "dialog opened");
  h.input.type("d");
  assert.ok(
    await waitFor(() => /approval mode: (ask|readonly|edits|allow-all)/.test(textOf(h.output))),
    "dialog details show the persisted mode",
  );
  return textOf(h.output);
}

async function quit(input: FakeInput, app: Promise<number>): Promise<number> {
  for (let press = 0; press < 6; press += 1) {
    input.key("escape");
    const settled = await Promise.race([
      app.then((code) => code as number | "exited"),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 250)),
    ]);
    if (settled !== "pending") return settled === "exited" ? 0 : settled;
  }
  const code = await Promise.race([
    app,
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 10_000)),
  ]);
  if (code === "timeout") throw new Error("the TUI did not exit after repeated Escape");
  return code;
}

test("default /permission dialog states ask and offers all four persisted modes", async () => {
  const h = startApp();
  try {
    assert.ok(await waitFor(() => textOf(h.output).includes("Two Brothers")), "welcome renders");
    const text = await openPermissionDetails(h);
    assert.match(text, /PERMISSIONS/);
    assert.match(text, /approval mode: ask — Reads run freely\./);
    assert.match(text, /the buttons below persist the mode/);
    // The dialog selection, not just the details text, offers every mode.
    assert.match(text, /Ask \(current\)/);
    assert.match(text, /Read only/);
    assert.match(text, /Edits/);
    assert.match(text, /Allow all/);
    assert.equal(await quit(h.input, h.app), 0);
  } finally {
    h.cleanup();
  }
});

test("/permission dialog persists the selected mode through the settings store", async () => {
  const h = startApp();
  try {
    assert.ok(await waitFor(() => textOf(h.output).includes("Two Brothers")));
    h.input.type("/permission");
    h.input.enter();
    assert.ok(await waitFor(() => textOf(h.output).includes("PERMISSIONS")));
    // Actions are ordered ask, readonly, edits, allow-all, close and Close is
    // selected by default: two Downs from Close wrap to ask then readonly.
    h.input.key("down");
    h.input.key("down");
    h.input.enter();
    assert.ok(
      await waitFor(() => textOf(h.output).includes("approval mode: readonly")),
      "the success toast confirms the persisted change",
    );
    const store = new SettingsStore(settingsFile(h.sessionsDir));
    assert.equal(store.readApprovalPolicy(), "readonly", "the mode is persisted");
    // A second open reads the persisted value (per-turn/per-dialog freshness).
    const text = await openPermissionDetails(h);
    assert.match(text, /approval mode: readonly/);
    assert.equal(await quit(h.input, h.app), 0);
  } finally {
    h.cleanup();
  }
});

test("Enter on a freshly opened /permission dialog only closes it (never persists)", async () => {
  const h = startApp();
  try {
    assert.ok(await waitFor(() => textOf(h.output).includes("Two Brothers")));
    h.input.type("/permission");
    h.input.enter();
    assert.ok(await waitFor(() => textOf(h.output).includes("PERMISSIONS")));
    // Close is the default selection: a stray Enter is a no-op, not a mode
    // write (readonly -> ask would silently weaken a deny policy).
    h.input.enter();
    assert.ok(await waitFor(() => !lastFrameText(h.output).includes("PERMISSIONS")));
    assert.equal(
      new SettingsStore(settingsFile(h.sessionsDir)).readApprovalPolicy(),
      "ask",
      "the settings file was never written",
    );
    assert.ok(
      !textOf(h.output).includes("approval mode: "),
      "no mode-change toast was produced",
    );
    assert.equal(await quit(h.input, h.app), 0);
  } finally {
    h.cleanup();
  }
});

test("a persisted allow-all mode is stated with its visible danger warning", async () => {
  const h = startApp();
  try {
    new SettingsStore(settingsFile(h.sessionsDir)).writeApprovalPolicy("allow-all");
    assert.ok(await waitFor(() => textOf(h.output).includes("Two Brothers")));
    const text = await openPermissionDetails(h);
    assert.match(text, /approval mode: allow-all/);
    assert.match(text, /warning: Use only in a workspace you trust/);
    assert.match(text, /Allow all \(current\)/);
    assert.equal(await quit(h.input, h.app), 0);
  } finally {
    h.cleanup();
  }
});

test("a pinned approval mode is stated and the dialog offers no save buttons", async () => {
  const h = startApp({ approvalMode: "readonly" });
  try {
    assert.ok(await waitFor(() => textOf(h.output).includes("Two Brothers")));
    const text = await openPermissionDetails(h);
    assert.match(text, /approval mode: readonly/);
    assert.match(text, /pinned by --approval-mode \/ TWO_BROTHERS_APPROVAL_MODE/);
    // No save buttons: the pin would win until restart, so a silent write would
    // be dishonest. Only Close remains.
    assert.ok(!text.includes("Allow all"), "no mode buttons while pinned");
    assert.ok(text.includes("Close"));
    h.input.key("escape");
    assert.ok(await waitFor(() => !lastFrameText(h.output).includes("PERMISSIONS")));
    // A typed change is refused with the honest reason and persists nothing.
    h.input.type("/permission allow-all");
    h.input.enter();
    assert.ok(
      await waitFor(() => textOf(h.output).includes("approval mode is pinned to readonly")),
      "a pinned mode refuses to write the saved policy",
    );
    assert.equal(
      new SettingsStore(settingsFile(h.sessionsDir)).readApprovalPolicy(),
      "ask",
      "nothing was persisted",
    );
    assert.equal(await quit(h.input, h.app), 0);
  } finally {
    h.cleanup();
  }
});

test("typed /permission <mode> applies valid modes and refuses unknown ones", async () => {
  const h = startApp();
  try {
    assert.ok(await waitFor(() => textOf(h.output).includes("Two Brothers")));
    h.input.type("/permission readonly");
    h.input.enter();
    assert.ok(
      await waitFor(() => textOf(h.output).includes("approval mode: readonly")),
      "a typed valid mode is applied",
    );
    assert.equal(new SettingsStore(settingsFile(h.sessionsDir)).readApprovalPolicy(), "readonly");
    h.input.type("/permission bogus");
    h.input.enter();
    assert.ok(
      await waitFor(() => textOf(h.output).includes('unknown approval mode "bogus"')),
      "an unknown mode is refused with the allowed values",
    );
    assert.equal(
      new SettingsStore(settingsFile(h.sessionsDir)).readApprovalPolicy(),
      "readonly",
      "a refused value never changes the persisted mode",
    );
    assert.equal(await quit(h.input, h.app), 0);
  } finally {
    h.cleanup();
  }
});
