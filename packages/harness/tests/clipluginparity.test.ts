/**
 * CLI/TUI plugin-selection parity: `run`/`chat`/`tui` use the server's
 * persisted strict opt-in plugin selection (`<sessionsDir>/settings.json`,
 * `--sessions-dir` on run/chat) plus the `TWO_BROTHERS_PLUGINS_*` env
 * overlay, through the one shared resolver — and never execute code that is
 * merely discovered in the plugins directory. Proves, across run/chat/TUI:
 *   - `{path, options}` entries reach the plugin's `register` ctx;
 *   - an unselected repository code plugin is never imported or executed
 *     (no register side effect, no per-run hook);
 *   - declarative bundles keep flowing through the same manager;
 *   - there are no `--plugin` flags (a usage error).
 *
 * Hermetic: mock providers only, temp plugin/session dirs, one chat
 * subprocess over piped stdin (the same idiom as tests/cliwiring.test.ts).
 *
 * Run with: node --test tests/clipluginparity.test.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { resolveConfig, type Config } from "../src/config.ts";
import { discoverCommands } from "../src/commands.ts";
import { mergeBundleCommands } from "../src/pluginbundle.ts";
import {
  loadRunResources,
  main,
  type CliIO,
} from "../src/cli.ts";
import { loadTuiResources } from "../src/tui/app.ts";
import { pluginSelectionNames } from "../src/plugins.ts";
import {
  resolvePluginSelection,
  SettingsStore,
} from "../src/settings_store.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The source CLI entry (Node native type stripping runs it directly). */
const CLI = path.join(HERE, "..", "src", "cli.ts");

function makeIO(): CliIO & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    log: (line) => out.push(line),
    error: (line) => err.push(line),
  };
}

/** Windows briefly holds handles on freshly written files. */
function rmWithRetry(target: string): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
      return;
    } catch (exc) {
      if (attempt >= 4) throw exc;
      const deadline = Date.now() + 50 * (attempt + 1);
      while (Date.now() < deadline) {
        // busy-wait: cleanup runs synchronously inside test teardowns
      }
    }
  }
}

function tmpdir(prefix: string): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { root, cleanup: () => rmWithRetry(root) };
}

/** A temp plugins dir; `files` maps file name -> source. */
function makePluginsDir(
  root: string,
  files: Record<string, string>,
): void {
  fs.mkdirSync(root, { recursive: true });
  for (const [name, source] of Object.entries(files)) {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source, "utf-8");
  }
  // `.mts` fixtures resolve as ESM without Node's typeless-package warning.
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }));
}

/** Writes `<sessionsDir>/settings.json` with a top-level plugins list. */
function writePluginSettings(sessionsDir: string, plugins: unknown[]): void {
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionsDir, "settings.json"),
    JSON.stringify({ version: 1, plugins }),
    "utf-8",
  );
}

/**
 * The selected plugin: its register appends the options it received to the
 * marker file (proving `{path, options}` delivery) and registers a
 * session_start hook (proving per-run binding of the selected plugin).
 */
function alphaSource(): string {
  return [
    'import * as fs from "node:fs";',
    "export function register(ctx) {",
    '  ctx.set_description("alpha parity plugin");',
    '  fs.appendFileSync(ctx.options.marker, "register:" + JSON.stringify(ctx.options) + "\\n");',
    '  ctx.on_hook("session_start", () => {',
    '    fs.appendFileSync(ctx.options.marker, "hook:session_start\\n");',
    "  });",
    '  ctx.add_tool("alpha_ping", () => "pong", "Ping");',
    "}",
    "export const configSchema = {",
    "  type: 'object',",
    "  properties: { marker: { type: 'string' } },",
    "  required: ['marker'],",
    "};",
    "",
  ].join("\n");
}

/**
 * The unselected plugin: merely dropping it in the plugins directory must
 * never execute it — register writes a marker the tests assert stays absent.
 */
function betaSource(betaMarker: string): string {
  return [
    'import * as fs from "node:fs";',
    "export function register(ctx) {",
    `  fs.writeFileSync(${JSON.stringify(betaMarker)}, "beta executed\\n");`,
    "}",
    "",
  ].join("\n");
}

/** Standard fixture: alpha (selected, options-carrying) + beta (unselected). */
function makeSelectionFixture(prefix: string): {
  pluginsDir: string;
  sessionsDir: string;
  alphaMarker: string;
  betaMarker: string;
  cleanup: () => void;
} {
  const tmp = tmpdir(prefix);
  const pluginsDir = path.join(tmp.root, "plugins");
  const sessionsDir = path.join(tmp.root, "sessions");
  const alphaMarker = path.join(tmp.root, "alpha.log");
  const betaMarker = path.join(tmp.root, "beta.log");
  makePluginsDir(pluginsDir, {
    "alpha.mts": alphaSource(),
    "beta.mts": betaSource(betaMarker),
  });
  writePluginSettings(sessionsDir, [
    { path: "alpha", options: { marker: alphaMarker } },
  ]);
  return { pluginsDir, sessionsDir, alphaMarker, betaMarker, cleanup: tmp.cleanup };
}

function markerText(marker: string): string {
  try {
    return fs.readFileSync(marker, "utf-8");
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// shared resolver
// ---------------------------------------------------------------------------

test("resolvePluginSelection merges the persisted list with the env overlay (dedup, options kept)", () => {
  const tmp = tmpdir("tb-parity-resolve-");
  try {
    const sessionsDir = path.join(tmp.root, "sessions");
    writePluginSettings(sessionsDir, [
      "notes",
      { path: "calendar", options: { timezone: "Europe/Berlin" } },
    ]);
    const store = new SettingsStore(path.join(sessionsDir, "settings.json"));
    const selection = resolvePluginSelection(store, {
      TWO_BROTHERS_PLUGINS_SENIOR: "calendar,extra",
      TWO_BROTHERS_PLUGINS_JUNIOR: "extra",
    } as NodeJS.ProcessEnv);
    // persisted entries keep shape and order; env adds new names only.
    assert.deepEqual(selection, [
      "notes",
      { path: "calendar", options: { timezone: "Europe/Berlin" } },
      "extra",
    ]);
    // a name selection names a plugin by basename (extension stripped).
    assert.deepEqual([...pluginSelectionNames(selection)].sort(), ["calendar", "extra", "notes"]);
  } finally {
    tmp.cleanup();
  }
});

test("resolvePluginSelection: a missing settings store resolves to an empty selection", () => {
  const tmp = tmpdir("tb-parity-empty-");
  try {
    const store = new SettingsStore(path.join(tmp.root, "nope", "settings.json"));
    assert.deepEqual(resolvePluginSelection(store, {} as NodeJS.ProcessEnv), []);
  } finally {
    tmp.cleanup();
  }
});

// ---------------------------------------------------------------------------
// loadRunResources (the run/chat wiring)
// ---------------------------------------------------------------------------

test("loadRunResources imports only the persisted selection and delivers options", async () => {
  const fixture = makeSelectionFixture("tb-parity-runres-");
  try {
    const io = makeIO();
    const resources = await loadRunResources(
      resolveConfig({ provider: "mock" }) as Config,
      { "plugins-dir": fixture.pluginsDir, "sessions-dir": fixture.sessionsDir },
      io,
    );
    assert.ok(resources.plugins !== null, "plugin discovery succeeded");
    assert.deepEqual([...resources.plugins.plugins.keys()], ["alpha"], "beta was not imported");
    assert.deepEqual(resources.pluginSelection, [
      { path: "alpha", options: { marker: fixture.alphaMarker } },
    ]);
    // the load-time register already ran for the selected plugin only, with
    // the persisted options in hand.
    const text = markerText(fixture.alphaMarker);
    assert.match(text, /register:/);
    assert.ok(
      text.includes(`"marker":${JSON.stringify(fixture.alphaMarker)}`.replace(/"/g, '"')),
      `options reached the plugin register: ${text}`,
    );
    assert.equal(fs.existsSync(fixture.betaMarker), false, "unselected code never executed");
  } finally {
    fixture.cleanup();
  }
});

test("loadRunResources honors the TWO_BROTHERS_PLUGINS_* env overlay", async () => {
  const fixture = makeSelectionFixture("tb-parity-env-");
  const previousSenior = process.env.TWO_BROTHERS_PLUGINS_SENIOR;
  const previousJunior = process.env.TWO_BROTHERS_PLUGINS_JUNIOR;
  process.env.TWO_BROTHERS_PLUGINS_SENIOR = "beta";
  delete process.env.TWO_BROTHERS_PLUGINS_JUNIOR;
  try {
    const io = makeIO();
    const resources = await loadRunResources(
      resolveConfig({ provider: "mock" }) as Config,
      { "plugins-dir": fixture.pluginsDir, "sessions-dir": fixture.sessionsDir },
      io,
    );
    assert.ok(resources.plugins !== null);
    // env overlay activates beta (still without options — env carries names
    // only), persisted entry keeps alpha with its options.
    assert.deepEqual([...resources.plugins.plugins.keys()].sort(), ["alpha", "beta"]);
    assert.deepEqual(resources.pluginSelection, [
      { path: "alpha", options: { marker: fixture.alphaMarker } },
      "beta",
    ]);
    assert.equal(fs.existsSync(fixture.betaMarker), true, "env overlay executed beta");
  } finally {
    if (previousSenior === undefined) delete process.env.TWO_BROTHERS_PLUGINS_SENIOR;
    else process.env.TWO_BROTHERS_PLUGINS_SENIOR = previousSenior;
    if (previousJunior === undefined) delete process.env.TWO_BROTHERS_PLUGINS_JUNIOR;
    else process.env.TWO_BROTHERS_PLUGINS_JUNIOR = previousJunior;
    fixture.cleanup();
  }
});

test("declarative bundles keep flowing through the same manager under strict opt-in", async () => {
  const tmp = tmpdir("tb-parity-bundle-");
  try {
    const pluginsDir = path.join(tmp.root, "plugins");
    const sessionsDir = path.join(tmp.root, "sessions");
    const betaMarker = path.join(tmp.root, "beta.log");
    makePluginsDir(pluginsDir, {
      "alpha.mts": alphaSource(),
      "beta.mts": betaSource(betaMarker),
      "bundle-x/plugin.json": JSON.stringify({
        name: "bundle-x",
        description: "a no-code test bundle",
        commands: "./commands",
      }),
      "bundle-x/commands/hello.md": [
        "---",
        "description: Bundle hello",
        "---",
        "BUNDLE SAYS HELLO $ARGUMENTS",
        "",
      ].join("\n"),
    });
    writePluginSettings(sessionsDir, [
      { path: "alpha", options: { marker: path.join(tmp.root, "alpha.log") } },
    ]);
    const io = makeIO();
    const resources = await loadRunResources(
      resolveConfig({ provider: "mock" }) as Config,
      { "plugins-dir": pluginsDir, "sessions-dir": sessionsDir },
      io,
    );
    assert.ok(resources.plugins !== null);
    assert.deepEqual([...resources.plugins.plugins.keys()], ["alpha"]);
    assert.ok(resources.plugins.bundles.has("bundle-x"), "bundle discovered alongside");
    const commands = mergeBundleCommands(
      discoverCommands([]),
      resources.plugins.bundles.values(),
    );
    assert.ok(
      commands.commands.some((command) => command.name === "bundle-x:hello"),
      "bundle command reaches the catalog through the same manager",
    );
    assert.equal(fs.existsSync(betaMarker), false, "unselected code never executed");
  } finally {
    tmp.cleanup();
  }
});

// ---------------------------------------------------------------------------
// run: one cooperation cycle binds the selection
// ---------------------------------------------------------------------------

test("run executes only the persisted selection: selected register+hook run, unselected code never executes", async () => {
  const fixture = makeSelectionFixture("tb-parity-run-");
  try {
    const io = makeIO();
    const code = await main(
      [
        "run",
        "Pick a color",
        "--provider",
        "mock",
        "--plugins-dir",
        fixture.pluginsDir,
        "--sessions-dir",
        fixture.sessionsDir,
      ],
      io,
    );
    assert.equal(code, 0, io.err.join("\n"));
    const text = markerText(fixture.alphaMarker);
    assert.match(text, /register:/, "the selected plugin registered at load");
    assert.match(text, /hook:session_start/, "the selected plugin's hook fired in the run");
    assert.equal(
      fs.existsSync(fixture.betaMarker),
      false,
      "the unselected plugin's register never ran",
    );
  } finally {
    fixture.cleanup();
  }
});

test("no --plugin flags: run and chat reject --plugin as an unknown option", async () => {
  const io = makeIO();
  const runCode = await main(
    ["run", "x", "--provider", "mock", "--plugin", "notes"],
    io,
  );
  assert.equal(runCode, 2, "run rejects --plugin");
  assert.match(io.err.join("\n"), /--plugin/);

  const io2 = makeIO();
  const chatCode = await main(["chat", "--plugin", "notes"], io2);
  assert.equal(chatCode, 2, "chat rejects --plugin before entering the REPL");
  assert.match(io2.err.join("\n"), /--plugin/);
});

// ---------------------------------------------------------------------------
// chat: the REPL binds the same selection (subprocess over piped stdin)
// ---------------------------------------------------------------------------

const PINNED_ENV_KEYS = [
  "TWO_BROTHERS_PROVIDER",
  "TWO_BROTHERS_MODE",
  "TWO_BROTHERS_SESSION_FILE",
  "TWO_BROTHERS_RESUME",
  "TWO_BROTHERS_COMMANDS_DIR",
  "TWO_BROTHERS_COMPACT",
  "TWO_BROTHERS_COMPACT_THRESHOLD",
  "TWO_BROTHERS_COMPACT_KEEP_RECENT",
  "TWO_BROTHERS_COMPACT_THRESHOLD_TOKENS",
  "TWO_BROTHERS_CONTEXT_WINDOW",
  "TWO_BROTHERS_STREAM_TOKENS",
  "TWO_BROTHERS_PLUGINS_SENIOR",
  "TWO_BROTHERS_PLUGINS_JUNIOR",
] as const;

test("chat executes only the persisted selection across REPL turns", () => {
  const fixture = makeSelectionFixture("tb-parity-chat-");
  try {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of PINNED_ENV_KEYS) delete env[key];
    const run = spawnSync(
      process.execPath,
      [
        CLI,
        "chat",
        "--provider",
        "mock",
        "--plugins-dir",
        fixture.pluginsDir,
        "--sessions-dir",
        fixture.sessionsDir,
      ],
      {
        cwd: fixture.sessionsDir,
        timeout: 90_000,
        encoding: "utf-8",
        env,
        input: "say hello\nsay hello again\n\n",
      },
    );
    assert.equal(run.status, 0, `exit ${run.status}: ${(run.stderr ?? "").slice(-500)}`);
    const text = markerText(fixture.alphaMarker);
    assert.match(text, /register:/, "the selected plugin registered at load");
    // one hook line per submitted turn (two tasks above).
    const hookLines = text.split("\n").filter((line) => line === "hook:session_start");
    assert.equal(hookLines.length, 2, `one session_start hook per turn: ${text}`);
    assert.equal(
      fs.existsSync(fixture.betaMarker),
      false,
      "the unselected plugin's register never ran",
    );
  } finally {
    fixture.cleanup();
  }
});

// ---------------------------------------------------------------------------
// TUI resource discovery (the assembled turn test lives in tuiintegration)
// ---------------------------------------------------------------------------

test("loadTuiResources imports only the persisted selection and delivers options", async () => {
  const fixture = makeSelectionFixture("tb-parity-tui-");
  try {
    const io = makeIO();
    const resources = await loadTuiResources({
      cfg: resolveConfig({ provider: "mock" }) as Config,
      io,
      pluginsDir: fixture.pluginsDir,
      sessionsDir: fixture.sessionsDir,
      skillsRoots: [],
      commandsRoots: [],
    });
    assert.ok(resources.plugins !== null, "plugin discovery succeeded");
    assert.deepEqual([...resources.plugins.plugins.keys()], ["alpha"], "beta was not imported");
    assert.deepEqual(resources.pluginSelection, [
      { path: "alpha", options: { marker: fixture.alphaMarker } },
    ]);
    const loaded = resources.plugins.plugins.get("alpha");
    assert.equal(loaded?.options.marker, fixture.alphaMarker, "options reached the load");
    const text = markerText(fixture.alphaMarker);
    assert.match(text, /register:/);
    assert.equal(fs.existsSync(fixture.betaMarker), false, "unselected code never executed");
  } finally {
    fixture.cleanup();
  }
});
