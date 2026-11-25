/**
 * Declarative plugin bundles (`src/pluginbundle.ts`): manifest validation
 * (name/size/paths/symlink confinement), unsupported runtime fields, the
 * code-plugin collision, no-execution on load, namespaced bundle commands
 * (expansion/mode via the existing engine, `matchCommand` colon segment),
 * bundle skills (operator shadowing, role scope, harness invocation), the
 * 64 KiB markdown fail-soft caps, manager reload, the server API + run
 * submission, the CLI verbose surface, and cross-surface (`serve`/CLI/TUI)
 * skills-catalog parity.
 *
 * Hermetic and offline: temp dirs, mock/scripted providers, ephemeral
 * loopback ports. Run with: node --test tests/pluginbundle.test.ts
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { expandCommand, matchCommand } from "../src/commands.ts";
import { resolveConfig } from "../src/config.ts";
import {
  loadRunResources,
  sessionsDirForCli,
  skillsRootsForCli,
  type CliIO,
} from "../src/cli.ts";
import { TwoBrothersHarness } from "../src/harness.ts";
import { PluginManager } from "../src/plugins.ts";
import { loadTuiResources, type TuiIO } from "../src/tui/app.ts";
import {
  BUNDLE_MANIFEST_MAX_BYTES,
  discoverPluginBundles,
  loadPluginBundle,
  bundleSkillRoots,
  mergeBundleCommands,
  mergeBundleSkills,
  type LoadedPluginBundle,
} from "../src/pluginbundle.ts";
import type { Provider } from "../src/provider.ts";
import type { ChatMessage } from "../src/context.ts";
import { createServer } from "../src/server.ts";
import { discoverSkills, renderSkillsSection } from "../src/skills.ts";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function tmpdir(prefix: string): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    root,
    cleanup: () => {
      for (let attempt = 0; ; attempt++) {
        try {
          fs.rmSync(root, { recursive: true, force: true });
          return;
        } catch (exc) {
          if (attempt >= 4) throw exc;
          const deadline = Date.now() + 50 * (attempt + 1);
          while (Date.now() < deadline) {
            // busy-wait: cleanup runs synchronously inside test teardowns
          }
        }
      }
    },
  };
}

function writeBundle(
  pluginsRoot: string,
  name: string,
  manifest: Record<string, unknown>,
  files: Record<string, string> = {},
): string {
  const dir = path.join(pluginsRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "plugin.json"), JSON.stringify(manifest, null, 2), "utf-8");
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(dir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, "utf-8");
  }
  return dir;
}

const VALID_MANIFEST = (name: string) => ({
  name,
  description: `${name} bundle`,
  version: "1.2.3",
  commands: "./commands",
  skills: "./skills",
});

const COMMAND_TEMPLATE = [
  "---",
  "description: Bundle command",
  "argument-hint: <thing>",
  "mode: work",
  "---",
  "Do $ARGUMENTS with $1.",
  "",
].join("\n");

const SKILL_FILE = ["---", "description: Bundle skill", "---", "Bundle skill body.", ""].join("\n");

function bundleFixture(prefix: string): { root: string; cleanup: () => void } {
  const tmp = tmpdir(prefix);
  writeBundle(tmp.root, "demo", VALID_MANIFEST("demo"), {
    "commands/triage.md": COMMAND_TEMPLATE,
    "skills/triage/SKILL.md": SKILL_FILE,
  });
  return tmp;
}

// ---------------------------------------------------------------------------
// manifest validation
// ---------------------------------------------------------------------------

test("valid manifest loads with resolved commands/skills dirs", () => {
  const tmp = bundleFixture("tb-bundle-valid-");
  try {
    const dir = path.join(tmp.root, "demo");
    const result = loadPluginBundle(dir);
    assert.equal(result.error, null);
    assert.deepEqual(result.diagnostics, []);
    assert.ok(result.bundle !== null);
    assert.equal(result.bundle.name, "demo");
    assert.equal(result.bundle.description, "demo bundle");
    assert.equal(result.bundle.version, "1.2.3");
    assert.equal(result.bundle.commandsDir, fs.realpathSync(path.join(dir, "commands")));
    assert.equal(result.bundle.skillsDir, fs.realpathSync(path.join(dir, "skills")));
  } finally {
    tmp.cleanup();
  }
});

test("manifest without commands/skills loads as metadata-only", () => {
  const tmp = tmpdir("tb-bundle-meta-");
  try {
    writeBundle(tmp.root, "meta", { name: "meta", description: "d" });
    const { bundles, errors, diagnostics } = discoverPluginBundles(tmp.root);
    assert.deepEqual(errors, []);
    assert.deepEqual(diagnostics, []);
    assert.equal(bundles.get("meta")?.commandsDir, null);
    assert.equal(bundles.get("meta")?.skillsDir, null);
  } finally {
    tmp.cleanup();
  }
});

test("invalid JSON and non-object manifests fail the bundle", () => {
  const tmp = tmpdir("tb-bundle-badjson-");
  try {
    writeBundle(tmp.root, "badjson", { name: "badjson" });
    fs.writeFileSync(path.join(tmp.root, "badjson", "plugin.json"), "{not json", "utf-8");
    writeBundle(tmp.root, "array", [] as unknown as Record<string, unknown>);
    const { bundles, errors } = discoverPluginBundles(tmp.root);
    assert.equal(bundles.size, 0);
    assert.deepEqual(
      errors.map((e) => e.plugin).sort(),
      ["array", "badjson"],
    );
    assert.ok(errors.find((e) => e.plugin === "badjson")?.error.includes("invalid JSON"));
    assert.ok(errors.find((e) => e.plugin === "array")?.error.includes("JSON object"));
  } finally {
    tmp.cleanup();
  }
});

test("manifest over the 64 KiB cap fails the bundle", () => {
  const tmp = tmpdir("tb-bundle-size-");
  try {
    const huge = { name: "huge", description: "x".repeat(BUNDLE_MANIFEST_MAX_BYTES) };
    writeBundle(tmp.root, "huge", huge);
    const { bundles, errors } = discoverPluginBundles(tmp.root);
    assert.equal(bundles.size, 0);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].plugin, "huge");
    assert.ok(errors[0].error.includes("64 KiB manifest cap"));
  } finally {
    tmp.cleanup();
  }
});

test("manifest name must match the safe directory name", () => {
  const tmp = tmpdir("tb-bundle-name-");
  try {
    writeBundle(tmp.root, "good", { name: "good" });
    writeBundle(tmp.root, "mismatch", { name: "other" });
    writeBundle(tmp.root, "Bad-Name", { name: "Bad-Name" });
    const { bundles, errors } = discoverPluginBundles(tmp.root);
    assert.deepEqual([...bundles.keys()], ["good"]);
    const mismatch = errors.find((e) => e.plugin === "mismatch");
    assert.ok(mismatch?.error.includes("does not match the bundle directory"));
    const bad = errors.find((e) => e.plugin === "Bad-Name");
    assert.ok(bad?.error.includes("must match"));
  } finally {
    tmp.cleanup();
  }
});

test("manifest paths must be bundle-relative ./ paths", () => {
  const tmp = tmpdir("tb-bundle-path-");
  try {
    writeBundle(tmp.root, "absolute", { name: "absolute", commands: "/tmp" });
    writeBundle(tmp.root, "plain", { name: "plain", commands: "commands" });
    writeBundle(tmp.root, "dotdot", { name: "dotdot", skills: "../outside" });
    const { bundles, errors } = discoverPluginBundles(tmp.root);
    assert.equal(bundles.size, 0);
    for (const plugin of ["absolute", "plain", "dotdot"]) {
      assert.ok(errors.find((e) => e.plugin === plugin)?.error.includes('starting with "./'));
    }
  } finally {
    tmp.cleanup();
  }
});

test("missing or non-directory manifest path target is a diagnostic, not an error", () => {
  const tmp = tmpdir("tb-bundle-missing-");
  try {
    writeBundle(tmp.root, "gone", { name: "gone", commands: "./nope", skills: "./commands" });
    // ./commands exists as a FILE here (the manifest itself is plugin.json,
    // so use a real file): create one.
    fs.writeFileSync(path.join(tmp.root, "gone", "commands"), "not a dir", "utf-8");
    const { bundles, errors, diagnostics } = discoverPluginBundles(tmp.root);
    assert.deepEqual(errors, []);
    assert.ok(bundles.has("gone"));
    assert.equal(bundles.get("gone")?.commandsDir, null);
    assert.equal(bundles.get("gone")?.skillsDir, null);
    assert.ok(
      diagnostics.some(
        (d) => d.plugin === "gone" && d.message.includes('"./nope" does not exist'),
      ),
    );
    assert.ok(
      diagnostics.some(
        (d) => d.plugin === "gone" && d.message.includes('"./commands" is not a directory'),
      ),
    );
  } finally {
    tmp.cleanup();
  }
});

const symlinkSupport = process.platform !== "win32";

test("manifest path escaping the bundle through a symlink fails the bundle", {
  skip: symlinkSupport ? false : "symlink creation needs privileges on Windows",
}, () => {
  const tmp = tmpdir("tb-bundle-symlink-");
  try {
    fs.mkdirSync(path.join(tmp.root, "outside"));
    writeBundle(tmp.root, "escape", { name: "escape", skills: "./link" });
    fs.symlinkSync(
      path.join(tmp.root, "outside"),
      path.join(tmp.root, "escape", "link"),
      "dir",
    );
    const { bundles, errors } = discoverPluginBundles(tmp.root);
    assert.equal(bundles.size, 0);
    assert.ok(errors[0]?.error.includes("escapes the bundle directory"));
  } finally {
    tmp.cleanup();
  }
});

test("runtime fields are info diagnostics; unknown fields are ignored silently", () => {
  const tmp = tmpdir("tb-bundle-fields-");
  try {
    writeBundle(tmp.root, "mixed", {
      name: "mixed",
      description: "d",
      tools: { nope: {} },
      hooks: { session_start: "x" },
      mcpServers: { srv: { url: "http://x" } },
      options: { a: 1 },
      future_field: { anything: true },
    });
    const { bundles, errors, diagnostics } = discoverPluginBundles(tmp.root);
    assert.deepEqual(errors, []);
    assert.ok(bundles.has("mixed"));
    const messages = diagnostics.filter((d) => d.plugin === "mixed").map((d) => d.message);
    for (const field of ["tools", "hooks", "mcpServers", "options"]) {
      assert.ok(
        messages.some((m) => m.includes(`"${field}"`) && m.includes("never execute code")),
        `expected a runtime-field diagnostic for ${field}`,
      );
    }
    assert.ok(!messages.some((m) => m.includes("future_field")));
  } finally {
    tmp.cleanup();
  }
});

test("loading a bundle never executes code inside its directory", async () => {
  const tmp = tmpdir("tb-bundle-noexec-");
  try {
    const marker = path.join(tmp.root, "executed.marker");
    writeBundle(tmp.root, "quiet", VALID_MANIFEST("quiet"), {
      // Would write the marker file the moment Node imported it. It must
      // never be imported: bundles are data, not code.
      "register.mjs": `import * as fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(marker)}, "ran");\n`,
      "commands/run.md": COMMAND_TEMPLATE,
    });
    const manager = await PluginManager.create(tmp.root);
    assert.ok(manager.bundles.has("quiet"));
    assert.equal(fs.existsSync(marker), false, "bundle code must never run");
    // The bundle still contributes its declared commands.
    const commands = mergeBundleCommands({ commands: [], diagnostics: [] }, manager.bundles.values());
    assert.deepEqual(commands.commands.map((c) => c.name), ["quiet:run"]);
    assert.equal(manager.plugins.size, 0);
  } finally {
    tmp.cleanup();
  }
});

// ---------------------------------------------------------------------------
// manager: collision, describe, reload
// ---------------------------------------------------------------------------

test("a code plugin wins the same-name bundle collision", async () => {
  const tmp = tmpdir("tb-bundle-collision-");
  try {
    writeBundle(tmp.root, "notes", VALID_MANIFEST("notes"), {
      "commands/thing.md": COMMAND_TEMPLATE,
    });
    fs.writeFileSync(
      path.join(tmp.root, "notes.mts"),
      [
        'export function register(ctx: any): void {',
        '  ctx.set_description("code notes");',
        "}",
        "",
      ].join("\n"),
      "utf-8",
    );
    const manager = await PluginManager.create(tmp.root);
    assert.ok(manager.plugins.has("notes"));
    assert.equal(manager.bundles.size, 0, "code plugin wins; the bundle is skipped");
    assert.ok(
      manager.diagnostics.some(
        (d) => d.plugin === "notes" && d.message.includes("code plugin with the same name"),
      ),
    );
  } finally {
    tmp.cleanup();
  }
});

test("describe() reports bundles with additive kind and version", async () => {
  const tmp = tmpdir("tb-bundle-describe-");
  try {
    writeBundle(tmp.root, "bbundle", VALID_MANIFEST("bbundle"));
    fs.writeFileSync(
      path.join(tmp.root, "acode.mts"),
      'export function register(ctx: any): void { ctx.add_tool("acode_tool", () => "ok"); }\n',
      "utf-8",
    );
    const manager = await PluginManager.create(tmp.root);
    const view = manager.describe();
    const code = view.plugins.find((p) => p.name === "acode");
    assert.equal(code?.kind, "code");
    assert.equal(code?.version, undefined);
    assert.deepEqual(code?.roles, ["shared"]);
    const bundle = view.plugins.find((p) => p.name === "bbundle");
    assert.equal(bundle?.kind, "bundle");
    assert.equal(bundle?.version, "1.2.3");
    assert.deepEqual(bundle?.roles, []);
    assert.equal(bundle?.description, "bbundle bundle");
    // merged and sorted by name
    assert.deepEqual(
      view.plugins.map((p) => p.name),
      ["acode", "bbundle"],
    );
  } finally {
    tmp.cleanup();
  }
});

test("manager reload picks up added and removed bundles", async () => {
  const tmp = bundleFixture("tb-bundle-reload-");
  try {
    const manager = await PluginManager.create(tmp.root);
    assert.deepEqual([...manager.bundles.keys()], ["demo"]);
    fs.rmSync(path.join(tmp.root, "demo"), { recursive: true, force: true });
    writeBundle(tmp.root, "fresh", { name: "fresh", description: "new" });
    await manager.reload();
    assert.deepEqual([...manager.bundles.keys()], ["fresh"]);
  } finally {
    tmp.cleanup();
  }
});

// ---------------------------------------------------------------------------
// commands: namespace, expansion, mode, matchCommand
// ---------------------------------------------------------------------------

test("bundle commands are namespaced and reuse expansion and mode", () => {
  const tmp = bundleFixture("tb-bundle-cmd-");
  try {
    const { bundles } = discoverPluginBundles(tmp.root);
    const merged = mergeBundleCommands({ commands: [], diagnostics: [] }, bundles.values());
    assert.deepEqual(merged.commands.map((c) => c.name), ["demo:triage"]);
    const command = merged.commands[0];
    assert.equal(command.description, "Bundle command");
    assert.equal(command.argumentHint, "<thing>");
    assert.equal(command.mode, "work");
    assert.equal(expandCommand(command, "the reports carefully"), "Do the reports carefully with the.");
    // metadata surfaces can still find the source file
    assert.ok(command.file.endsWith(path.join("commands", "triage.md")));
  } finally {
    tmp.cleanup();
  }
});

test("bundle commands merge with operator commands sorted; operator entries untouched", () => {
  const tmp = bundleFixture("tb-bundle-cmdmerge-");
  try {
    const operatorRoot = tmpdir("tb-bundle-opcmds-");
    try {
      fs.writeFileSync(
        path.join(operatorRoot.root, "alpha.md"),
        ["---", "description: Operator command", "---", "Alpha $ARGUMENTS.", ""].join("\n"),
        "utf-8",
      );
      const operator = mergeBundleCommands(
        { commands: [], diagnostics: [] },
        discoverPluginBundles(tmp.root).bundles.values(),
      );
      assert.deepEqual(operator.commands.map((c) => c.name), ["demo:triage"]);
    } finally {
      operatorRoot.cleanup();
    }
    const { bundles } = discoverPluginBundles(tmp.root);
    // Two bundles cannot collide (names are unique); operator names never
    // carry ':', so the namespace is collision-free by construction.
    const merged = mergeBundleCommands(
      {
        commands: [
          {
            name: "alpha",
            description: "Operator command",
            argumentHint: "",
            file: path.join("operator", "alpha.md"),
            body: "Alpha $ARGUMENTS.",
          },
        ],
        diagnostics: [],
      },
      bundles.values(),
    );
    assert.deepEqual(merged.commands.map((c) => c.name), ["alpha", "demo:triage"]);
  } finally {
    tmp.cleanup();
  }
});

test("matchCommand accepts one optional bundle colon segment", () => {
  assert.deepEqual(matchCommand("/demo:triage the reports"), {
    name: "demo:triage",
    args: "the reports",
  });
  assert.deepEqual(matchCommand("/DEMO:TRIAGE"), { name: "demo:triage", args: "" });
  // Not commands: a bare trailing colon, a colon-gap, or a leading colon.
  assert.equal(matchCommand("/demo:"), null);
  assert.equal(matchCommand("/demo: triage"), null);
  assert.equal(matchCommand("/:triage"), null);
  // Plain commands keep working.
  assert.deepEqual(matchCommand("/plan improve"), { name: "plan", args: "improve" });
});

test("an oversized bundle command template is skipped fail-soft", () => {
  const tmp = tmpdir("tb-bundle-bigcmd-");
  try {
    writeBundle(tmp.root, "big", VALID_MANIFEST("big"), {
      "commands/huge.md": `---\ndescription: huge\n---\n${"x".repeat(70 * 1024)}`,
      "commands/small.md": COMMAND_TEMPLATE,
    });
    const { bundles } = discoverPluginBundles(tmp.root);
    const merged = mergeBundleCommands({ commands: [], diagnostics: [] }, bundles.values());
    assert.deepEqual(merged.commands.map((c) => c.name), ["big:small"]);
    assert.ok(
      merged.diagnostics.some(
        (line) => line.includes('"huge"') && line.includes("64 KiB markdown cap"),
      ),
    );
  } finally {
    tmp.cleanup();
  }
});

// ---------------------------------------------------------------------------
// skills: shadowing, scope, invocation
// ---------------------------------------------------------------------------

test("bundle skill roots come after operator roots: operator shadows bundle", () => {
  const tmp = bundleFixture("tb-bundle-skill-");
  const operator = tmpdir("tb-bundle-opskills-");
  try {
    fs.mkdirSync(path.join(operator.root, "triage"), { recursive: true });
    fs.writeFileSync(
      path.join(operator.root, "triage", "SKILL.md"),
      ["---", "description: Operator triage", "---", "Operator body.", ""].join("\n"),
      "utf-8",
    );
    const operatorCatalog = discoverSkills([operator.root]);
    const merged = mergeBundleSkills(operatorCatalog, discoverPluginBundles(tmp.root).bundles.values());
    const triage = merged.skills.find((s) => s.name === "triage");
    assert.ok(triage?.file.startsWith(operator.root), "operator skill wins");
    assert.ok(
      merged.diagnostics.some(
        (line) => line.includes("duplicate skill name") && line.includes("shadowed by"),
      ),
    );
    assert.deepEqual(bundleSkillRoots(discoverPluginBundles(tmp.root).bundles.values()), [
      fs.realpathSync(path.join(tmp.root, "demo", "skills")),
    ]);
  } finally {
    operator.cleanup();
    tmp.cleanup();
  }
});

test("an oversized bundle SKILL.md is skipped fail-soft", () => {
  const tmp = tmpdir("tb-bundle-bigskill-");
  try {
    writeBundle(tmp.root, "big", VALID_MANIFEST("big"), {
      "skills/huge/SKILL.md": `---\ndescription: huge\n---\n${"x".repeat(70 * 1024)}`,
      "skills/small/SKILL.md": SKILL_FILE,
    });
    const { bundles } = discoverPluginBundles(tmp.root);
    const merged = mergeBundleSkills({ skills: [], diagnostics: [] }, bundles.values());
    assert.deepEqual(merged.skills.map((s) => s.name), ["small"]);
    assert.ok(
      merged.diagnostics.some((line) => line.includes('"huge"') && line.includes("64 KiB markdown cap")),
    );
  } finally {
    tmp.cleanup();
  }
});

test("bundle skill scope is honored in the rendered skills section", () => {
  const tmp = tmpdir("tb-bundle-scope-");
  try {
    writeBundle(tmp.root, "scoped", VALID_MANIFEST("scoped"), {
      "skills/lead/SKILL.md": [
        "---",
        "description: Senior lead checklist",
        "scope: senior",
        "---",
        "Lead body.",
        "",
      ].join("\n"),
    });
    const { bundles } = discoverPluginBundles(tmp.root);
    const catalog = mergeBundleSkills({ skills: [], diagnostics: [] }, bundles.values());
    const senior = renderSkillsSection(catalog, "senior");
    const junior = renderSkillsSection(catalog, "junior");
    assert.ok(senior?.includes("- lead: Senior lead checklist"));
    assert.equal(junior, null, "a senior-scoped bundle skill never leaks to the junior");
  } finally {
    tmp.cleanup();
  }
});

/** Minimal scripted provider: one consult reply requesting a bundle skill. */
class SkillAskingProvider implements Provider {
  private readonly marker: string;
  constructor(marker: string) {
    this.marker = marker;
  }
  async chat(): Promise<string> {
    return (
      JSON.stringify({
        task: "t",
        ask: "a",
        expect: "proposal",
        deadline_hint: "today",
      }) +
      "\n\n" +
      this.marker
    );
  }
}

test("a bundle skill is invocable through the harness skill engine", async () => {
  const tmp = bundleFixture("tb-bundle-invoke-");
  try {
    const { bundles } = discoverPluginBundles(tmp.root);
    const catalog = mergeBundleSkills({ skills: [], diagnostics: [] }, bundles.values());
    const harness = new TwoBrothersHarness(
      resolveConfig({ provider: "mock", mode: "consult" }),
      {
        senior: new SkillAskingProvider('<skill name="triage">'),
        junior: new SkillAskingProvider("unused"),
        skills: catalog,
      },
    );
    const result = await harness.run("handle the queue");
    const delivered = result.messages.filter(
      (message: any) =>
        message.from === "user" &&
        message.kind === "message" &&
        String(message.payload?.text ?? "").startsWith('<skill-loaded name="triage">'),
    );
    assert.equal(delivered.length, 1, "the bundle skill body is delivered on request");
    assert.ok(String(delivered[0].payload.text).includes("Bundle skill body."));
  } finally {
    tmp.cleanup();
  }
});

// ---------------------------------------------------------------------------
// CLI: verbose surface + resource loading
// ---------------------------------------------------------------------------

test("loadRunResources loads bundle skills and reports bundles under --verbose", async () => {
  const tmp = bundleFixture("tb-bundle-cli-");
  try {
    const out: string[] = [];
    const err: string[] = [];
    const io: CliIO = {
      log: (line) => out.push(line),
      error: (line) => err.push(line),
    };
    const resources = await loadRunResources(
      resolveConfig({ provider: "mock", verbose: true }),
      { "plugins-dir": tmp.root, "skills-dir": [] },
      io,
    );
    assert.ok(resources.plugins !== null);
    assert.deepEqual([...resources.plugins.bundles.keys()], ["demo"]);
    assert.ok(
      resources.skills.skills.some((skill) => skill.name === "triage"),
      "bundle skills join the CLI skill catalog",
    );
    assert.ok(err.some((line) => line.includes("1 bundle(s) active")));
  } finally {
    tmp.cleanup();
  }
});

// ---------------------------------------------------------------------------
// server: API + run submission
// ---------------------------------------------------------------------------

interface RunningServer {
  base: string;
  dir: string;
  close: () => Promise<void>;
}

async function startServer(
  pluginsDir: string,
  skillsDirs: string[] = [],
): Promise<RunningServer> {
  const sessions = tmpdir("tb-bundle-srv-");
  const handle = createServer({
    configFactory: () => resolveConfig({ provider: "mock", mode: "consult" }),
    sessionsDir: sessions.root,
    webDist: null,
    pluginsDir,
    skillsDirs,
    commandsDirs: [],
  });
  const server = await handle.listen("127.0.0.1", 0);
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    dir: sessions.root,
    close: async () => {
      await handle.close();
      sessions.cleanup();
    },
  };
}

async function api<T = unknown>(
  base: string,
  method: string,
  route: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${base}${route}`, init);
  return { status: res.status, body: (await res.json()) as T };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitTerminal(base: string, runId: string): Promise<Record<string, any>> {
  const deadline = Date.now() + 10000;
  for (;;) {
    const res = await api<Record<string, any>>(base, "GET", `/api/runs/${encodeURIComponent(runId)}`);
    if (["completed", "failed", "cancelled"].includes(String(res.body.status))) return res.body;
    if (Date.now() > deadline) throw new Error(`run ${runId} never finished`);
    await sleep(10);
  }
}

test("server API lists bundles and serves namespaced bundle commands", async () => {
  const tmp = bundleFixture("tb-bundle-api-");
  const server = await startServer(tmp.root);
  try {
    const plugins = await api<{
      plugins: Array<Record<string, unknown>>;
      errors: Array<{ plugin: string; error: string }>;
      diagnostics?: string[];
    }>(server.base, "GET", "/api/plugins");
    assert.equal(plugins.status, 200);
    const demo = plugins.body.plugins.find((p) => p.name === "demo");
    assert.equal(demo?.kind, "bundle");
    assert.equal(demo?.version, "1.2.3");
    assert.deepEqual(demo?.roles, []);

    const commands = await api<{
      commands: Array<Record<string, unknown>>;
      diagnostics: string[];
    }>(server.base, "GET", "/api/commands");
    assert.equal(commands.status, 200);
    const triage = commands.body.commands.find((c) => c.name === "demo:triage");
    assert.ok(triage, "bundle command is served namespaced");
    assert.equal(triage.mode, "work");
    assert.ok(!JSON.stringify(commands.body).includes("Do $ARGUMENTS"), "metadata only, never bodies");

    const skills = await api<{ skills: Array<Record<string, unknown>> }>(
      server.base,
      "GET",
      "/api/skills",
    );
    assert.equal(skills.status, 200);
    assert.ok(skills.body.skills.some((s) => s.name === "triage"));
  } finally {
    await server.close();
    tmp.cleanup();
  }
});

test("a namespaced bundle command expands on run submission with its mode", async () => {
  const tmp = bundleFixture("tb-bundle-submit-");
  const server = await startServer(tmp.root);
  try {
    const started = await api<{ run_id: string }>(server.base, "POST", "/api/runs", {
      task: "/demo:triage the reports",
      mode: "consult",
    });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const record = await waitTerminal(server.base, started.body.run_id);
    assert.equal(record.status, "completed");
    assert.equal(record.mode, "work", "the bundle command's mode overrides the request");
    assert.equal(record.task, "Do the reports with the.");
    const events = fs
      .readFileSync(path.join(server.dir, String(record.session)), "utf-8")
      .split(/\r?\n/)
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, any>);
    assert.equal(events[0]?.payload?.text, "Do the reports with the.");
  } finally {
    await server.close();
    tmp.cleanup();
  }
});

// ---------------------------------------------------------------------------
// cross-surface skills parity: serve / CLI / TUI
// ---------------------------------------------------------------------------

/** One skill as every surface exposes it (bodies stay out of the web route). */
interface SkillView {
  name: string;
  description: string;
  scope: string;
  tools: string[];
  file: string;
}

/** One surface's model-facing skill catalog: metadata + diagnostics. */
interface SurfaceCatalog {
  skills: SkillView[];
  diagnostics: string[];
}

function skillViews(
  skills: ReadonlyArray<{
    name: string;
    description: string;
    scope: string;
    tools: readonly string[];
    file: string;
  }>,
): SkillView[] {
  return skills.map((skill) => ({
    name: skill.name,
    description: skill.description,
    scope: skill.scope,
    tools: [...skill.tools],
    file: path.resolve(skill.file),
  }));
}

/**
 * The same bundle must produce the same catalog on all three surfaces: a
 * bundle skill under the cap loads, a bundle markdown over the 64 KiB cap is
 * skipped with one diagnostic, an operator skill shadows a same-named bundle
 * skill, and the ordering is identical — `serve` folds bundles through
 * `mergeBundleSkills`, and the CLI (`loadRunResources`) and TUI
 * (`loadTuiResources`) now use that same fold.
 */
test("serve, CLI and TUI fold bundle skills into identical catalogs", async () => {
  const root = tmpdir("tb-bundle-parity-");
  const pluginsDir = path.join(root.root, "plugins");
  const operatorSkills = path.join(root.root, "operator-skills");
  const sessionsDir = path.join(root.root, "sessions");
  try {
    writeBundle(pluginsDir, "demo", VALID_MANIFEST("demo"), {
      "skills/huge/SKILL.md": `---\ndescription: Huge bundle skill\n---\n${"x".repeat(70 * 1024)}`,
      "skills/triage/SKILL.md": SKILL_FILE,
      "skills/under/SKILL.md": [
        "---",
        "description: Under-cap bundle skill",
        "---",
        "Under-cap bundle body.",
        "",
      ].join("\n"),
    });
    fs.mkdirSync(path.join(operatorSkills, "triage"), { recursive: true });
    fs.writeFileSync(
      path.join(operatorSkills, "triage", "SKILL.md"),
      ["---", "description: Operator triage", "---", "Operator body.", ""].join("\n"),
      "utf-8",
    );

    // One root list for every surface: the CLI's own resolver, so the TUI and
    // serve scan byte-identical roots (flags, env, cwd/sessions/home defaults).
    const values: Record<string, any> = {
      "plugins-dir": pluginsDir,
      "skills-dir": [operatorSkills],
      "sessions-dir": sessionsDir,
    };
    const operatorRoots = skillsRootsForCli(values);
    const cfg = resolveConfig({ provider: "mock" });
    const sink = { log: () => {}, error: () => {} };

    // CLI surface: the real `run`/`chat` resource loader.
    const cli = await loadRunResources(cfg, values, sink as CliIO);
    // TUI surface: the real TUI session loader, same bundles and roots.
    const tui = await loadTuiResources({
      cfg,
      io: sink as TuiIO,
      pluginsDir,
      sessionsDir: sessionsDirForCli(values),
      skillsRoots: operatorRoots,
      commandsRoots: [],
    });
    // serve surface: the real `GET /api/skills` route.
    const server = await startServer(pluginsDir, operatorRoots);
    let served: SurfaceCatalog;
    try {
      const res = await api<SurfaceCatalog>(server.base, "GET", "/api/skills");
      assert.equal(res.status, 200);
      served = { skills: skillViews(res.body.skills), diagnostics: [...res.body.diagnostics] };
    } finally {
      await server.close();
    }

    const surfaces: Array<{ label: string; catalog: SurfaceCatalog }> = [
      { label: "CLI", catalog: { skills: skillViews(cli.skills.skills), diagnostics: cli.skills.diagnostics } },
      { label: "TUI", catalog: { skills: skillViews(tui.skills.skills), diagnostics: tui.skills.diagnostics } },
      { label: "serve", catalog: served },
    ];

    // (a) A bundle skill under the 64 KiB cap is admitted everywhere.
    for (const { label, catalog } of surfaces) {
      const under = catalog.skills.find((skill) => skill.name === "under");
      assert.ok(under, `${label}: under-cap bundle skill is admitted`);
      assert.equal(under.description, "Under-cap bundle skill", `${label}: metadata is preserved`);
      assert.ok(
        under.file.startsWith(fs.realpathSync(path.join(pluginsDir, "demo", "skills"))),
        `${label}: under-cap skill comes from the bundle root`,
      );
    }

    // (b) A bundle markdown over the cap is skipped everywhere, one diagnostic.
    for (const { label, catalog } of surfaces) {
      assert.ok(
        !catalog.skills.some((skill) => skill.name === "huge"),
        `${label}: over-cap bundle skill is skipped`,
      );
      const capLines = catalog.diagnostics.filter(
        (line) => line.includes('"huge"') && line.includes("64 KiB markdown cap"),
      );
      assert.equal(capLines.length, 1, `${label}: exactly one cap diagnostic: ${catalog.diagnostics}`);
    }

    // (c) An operator skill shadows the same-named bundle skill everywhere.
    const operatorFile = path.resolve(path.join(operatorSkills, "triage", "SKILL.md"));
    for (const { label, catalog } of surfaces) {
      const triage = catalog.skills.find((skill) => skill.name === "triage");
      assert.equal(triage?.file, operatorFile, `${label}: the operator skill wins the name`);
      assert.ok(
        catalog.diagnostics.some(
          (line) =>
            line.includes('duplicate skill name "triage"') && line.includes(operatorFile),
        ),
        `${label}: the shadow is diagnosed: ${catalog.diagnostics}`,
      );
    }

    // (d) Identical ordering (and identical catalogs + diagnostics).
    assert.deepEqual(surfaces[1].catalog, surfaces[0].catalog, "TUI catalog matches the CLI");
    assert.deepEqual(surfaces[2].catalog, surfaces[0].catalog, "serve catalog matches the CLI");
    const names = surfaces[0].catalog.skills.map((skill) => skill.name);
    assert.deepEqual(names, [...names].sort(), "catalog order is name-sorted");
    assert.ok(
      names.indexOf("triage") >= 0 && names.indexOf("triage") < names.indexOf("under"),
      `triage orders before under: ${names}`,
    );
  } finally {
    root.cleanup();
  }
});
