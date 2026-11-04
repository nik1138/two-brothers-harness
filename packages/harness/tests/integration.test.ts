/**
 * Integration wiring: the four feature lanes joined end-to-end.
 *
 * These tests exercise the seams the integration lane owns — plugin hooks
 * around the tool loop, per-role plugin tool scoping, the skills section in
 * the assembled prompt, the server's `/api/skills` route, and the
 * `maxTokens` cap on the per-role endpoint path — through the real
 * `TwoBrothersHarness`, the real `PluginManager`, and a real in-process
 * server. Everything is hermetic: mock providers, temp directories, and one
 * loopback stub endpoint; no network, no live models.
 *
 * Run with: node tests/run-all.ts (or node --test tests/integration.test.ts)
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { resolveConfig, type Config } from "../src/config.ts";
import type { ChatMessage } from "../src/context.ts";
import {
  PROMPT_SECTION_SKILLS,
  TwoBrothersHarness,
  assembleSystemPrompt,
  type HarnessResult,
  type ToolScopes,
} from "../src/harness.ts";
import { Decision, PermissionManager, StaticBroker } from "../src/permissions.ts";
import { PluginManager, type PluginBindings } from "../src/plugins.ts";
import {
  MockProvider,
  type Provider,
  type Tool,
  type ToolChatOptions,
  type ToolChatResponse,
} from "../src/provider.ts";
import type { RuntimeEvent, ToolCompletedEvent } from "../src/runevents.ts";
import { createServer } from "../src/server.ts";
import { discoverSkills } from "../src/skills.ts";
import { Workspace } from "../src/workspace.ts";

// ---------------------------------------------------------------------------
// helpers + fixtures
// ---------------------------------------------------------------------------

function rmWithRetry(target: string): void {
  // Windows briefly holds handles on freshly written files; a short retry
  // keeps temp-dir cleanup from flaking the suite (same helper as the
  // plugin suites).
  for (let attempt = 0; ; attempt++) {
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

/** A temp plugins dir; `files` maps file name -> module source. */
function makePluginsDir(files: Record<string, string>): {
  root: string;
  cleanup: () => void;
} {
  const tmp = tmpdir("tb-integration-plugins-");
  for (const [name, source] of Object.entries(files)) {
    fs.writeFileSync(path.join(tmp.root, name), source, "utf-8");
  }
  // `.ts` fixtures resolve as ESM without Node's typeless-package warning.
  fs.writeFileSync(path.join(tmp.root, "package.json"), JSON.stringify({ type: "module" }));
  return tmp;
}

/** Write `<root>/<rel>` (creating parents). */
function writeFile(root: string, rel: string, content: string): string {
  const target = path.join(root, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
  return target;
}

/** `---` fence around the given frontmatter lines, then an optional body. */
function skillDoc(frontmatter: string, body = ""): string {
  return `---\n${frontmatter}\n---\n\n${body}`;
}

/** A workspace whose mutations are approved (the tests never mutate anyway). */
function workspaceFor(root: string): Workspace {
  return new Workspace(root, new PermissionManager(null, new StaticBroker(Decision.ALLOW)));
}

interface CapturedRequest {
  role: "senior" | "junior";
  kind: string;
  messages: ChatMessage[];
  tools: Tool[];
}

/**
 * Records every provider request (role, kind, message snapshot, belt) and
 * answers through a delegate — the `tests/promptsections.test.ts` idiom,
 * reused here to prove what the model actually saw.
 */
class CapturingProvider implements Provider {
  private readonly role: "senior" | "junior";
  private readonly log: CapturedRequest[];
  private readonly delegate: Provider;

  constructor(
    role: "senior" | "junior",
    log: CapturedRequest[],
    delegate: Provider = new MockProvider(),
  ) {
    this.role = role;
    this.log = log;
    this.delegate = delegate;
  }

  async chat(
    messages: ChatMessage[],
    responseKind = "message",
    signal?: AbortSignal,
  ): Promise<string> {
    this.log.push({
      role: this.role,
      kind: responseKind,
      messages: messages.map((message) => ({ ...message })),
      tools: [],
    });
    return this.delegate.chat(messages, responseKind, signal);
  }

  async chatWithTools(
    messages: ChatMessage[],
    tools: Tool[],
    options: ToolChatOptions = {},
  ): Promise<ToolChatResponse> {
    this.log.push({
      role: this.role,
      kind: options.responseKind ?? "deliverable",
      messages: messages.map((message) => ({ ...message })),
      tools: [...tools],
    });
    if (this.delegate.chatWithTools === undefined) return { content: "", toolCalls: [] };
    return this.delegate.chatWithTools(messages, tools, options);
  }
}

const DELIVERABLE = JSON.stringify({
  result: "The delegated step ran.",
  artifacts: ["out.txt"],
  notes: "",
  confidence: 0.9,
});

function systemOf(request: CapturedRequest): string {
  return request.messages.find((message) => message.role === "system")?.content ?? "";
}

function toolResults(request: CapturedRequest): string[] {
  return request.messages
    .filter((message) => message.role === "tool")
    .map((message) => message.content);
}

/** A work-mode run with one plugin loaded; scopes/hooks come from `bindingsFor`. */
async function workRunWithPlugin(
  pluginSource: string,
  juniorScript: Array<{ tool: string; args: Record<string, unknown> } | { text: string }>,
  options: { skills?: ReturnType<typeof discoverSkills> } = {},
): Promise<{
  result: HarnessResult;
  log: CapturedRequest[];
  events: RuntimeEvent[];
  bindings: PluginBindings;
  cleanup: () => void;
}> {
  const dir = makePluginsDir({ "policy.ts": pluginSource });
  const wsRoot = tmpdir("tb-integration-ws-");
  try {
    const workspace = workspaceFor(wsRoot.root);
    const manager = await PluginManager.create(dir.root);
    const bindings = await manager.bindingsFor(["policy"], workspace);
    const log: CapturedRequest[] = [];
    const events: RuntimeEvent[] = [];
    const scopes: ToolScopes = {
      shared: bindings.toolsByScope.shared,
      senior: bindings.toolsByScope.senior,
      junior: bindings.toolsByScope.junior,
    };
    const harness = new TwoBrothersHarness(resolveConfig({ provider: "mock", mode: "work" }), {
      workspace,
      toolScopes: scopes,
      hooks: bindings.hooks,
      senior: new CapturingProvider("senior", log),
      junior: new CapturingProvider("junior", log, new MockProvider(juniorScript)),
      ...(options.skills ? { skills: options.skills } : {}),
      onEvent: (event) => events.push(event),
    });
    const result = await harness.run("delegated work");
    return {
      result,
      log,
      events,
      bindings,
      cleanup: () => {
        dir.cleanup();
        wsRoot.cleanup();
      },
    };
  } catch (exc) {
    dir.cleanup();
    wsRoot.cleanup();
    throw exc;
  }
}

function completedFor(events: RuntimeEvent[], name: string): ToolCompletedEvent[] {
  return events.filter(
    (event): event is ToolCompletedEvent =>
      event.type === "tool_completed" && event.tool === name,
  );
}

// ---------------------------------------------------------------------------
// (i) a plugin hook veto blocks the tool and the denial reaches the model
// ---------------------------------------------------------------------------

const VETO_PLUGIN = [
  "export function register(ctx) {",
  '  ctx.add_tool("guarded", () => "tool body ran");',
  '  ctx.on_hook("before_tool_call", (event) => {',
  '    if (event.tool === "guarded") return { deny: "denied by test policy" };',
  "  });",
  "}",
  "",
].join("\n");

test("before_tool_call deny blocks the tool and the denial text reaches the model", async () => {
  const run = await workRunWithPlugin(VETO_PLUGIN, [{ tool: "guarded", args: {} }, { text: DELIVERABLE }]);
  try {
    assert.equal(run.result.cancelled, false);
    const completed = completedFor(run.events, "guarded");
    assert.equal(completed.length, 1, "the denied call still reports one completion");
    assert.equal(completed[0].status, "blocked");
    assert.match(String(completed[0].result), /denied by test policy/);

    // the model's next turn carries the denial as the tool result
    const withToolResult = run.log
      .filter((request) => request.role === "junior")
      .map(toolResults)
      .find((results) => results.length > 0);
    assert.ok(withToolResult, "the junior tool loop ran");
    assert.deepEqual(withToolResult, ["denied by test policy"]);
    // the tool body never executed
    assert.ok(!JSON.stringify(run.log).includes("tool body ran"));
  } finally {
    run.cleanup();
  }
});

// ---------------------------------------------------------------------------
// (ii) after_tool_call may rewrite the result the model and transcript see
// ---------------------------------------------------------------------------

const REWRITE_PLUGIN = [
  "export function register(ctx) {",
  '  ctx.add_tool("leaky", () => "secret-token-123");',
  '  ctx.on_hook("after_tool_call", (event) => {',
  '    if (event.tool === "leaky") event.result = "[redacted]";',
  "  });",
  "}",
  "",
].join("\n");

test("after_tool_call rewrites the result before it is compacted and reported", async () => {
  const run = await workRunWithPlugin(REWRITE_PLUGIN, [{ tool: "leaky", args: {} }, { text: DELIVERABLE }]);
  try {
    const results = run.log
      .filter((request) => request.role === "junior")
      .map(toolResults)
      .find((entries) => entries.length > 0);
    assert.deepEqual(results, ["[redacted]"], "the model only sees the rewritten result");

    const completed = completedFor(run.events, "leaky");
    assert.equal(completed.length, 1);
    assert.equal(completed[0].status, "ok");
    assert.equal(String(completed[0].result), "[redacted]");
    assert.ok(!JSON.stringify(run.log).includes("secret-token-123"));
  } finally {
    run.cleanup();
  }
});

// ---------------------------------------------------------------------------
// (iii) explicit scopes route a plugin tool to one belt only
// ---------------------------------------------------------------------------

const SCOPED_PLUGIN = [
  "export function register(ctx) {",
  '  ctx.add_tool("shared_note", () => "shared", { description: "Shared note." });',
  '  ctx.add_tool("worker_note", () => "worker", { scope: "junior", description: "Worker note." });',
  '  ctx.add_tool("audit_note", () => "audit", { scope: "senior", description: "Audit note." });',
  "}",
  "",
].join("\n");

test("a senior-only plugin tool is offered to the senior belt and absent from the junior belt", async () => {
  const run = await workRunWithPlugin(SCOPED_PLUGIN, [{ text: DELIVERABLE }]);
  try {
    assert.deepEqual(
      run.bindings.toolsByScope.shared.map((tool) => tool.name),
      ["shared_note"],
    );
    assert.deepEqual(
      run.bindings.toolsByScope.junior.map((tool) => tool.name),
      ["worker_note"],
    );
    assert.deepEqual(
      run.bindings.toolsByScope.senior.map((tool) => tool.name),
      ["audit_note"],
    );

    const juniorCall = run.log.find(
      (request) => request.role === "junior" && request.tools.length > 0,
    );
    assert.ok(juniorCall, "the junior ran the tool loop");
    const juniorSystem = systemOf(juniorCall);
    assert.ok(juniorSystem.includes("- shared_note —"), "shared joins the junior belt");
    assert.ok(juniorSystem.includes("- worker_note —"), "junior scope joins the junior belt");
    assert.ok(!juniorSystem.includes("- audit_note"), "senior scope stays off the junior belt");

    const seniorCall = run.log.find(
      (request) => request.role === "senior" && request.tools.length > 0,
    );
    assert.ok(seniorCall, "the senior ran its verify slice");
    const seniorSystem = systemOf(seniorCall);
    assert.ok(seniorSystem.includes("- audit_note —"), "senior scope joins the verify slice");
    assert.ok(seniorSystem.includes("- shared_note —"), "shared joins the verify slice");
    assert.ok(!seniorSystem.includes("- worker_note"), "junior scope stays off the verify slice");
  } finally {
    run.cleanup();
  }
});

// ---------------------------------------------------------------------------
// (iv) the skills section appears only for roles that have skills
// ---------------------------------------------------------------------------

test("the skills section and its audit entry appear only when the role has skills", async () => {
  const root = tmpdir("tb-integration-skills-");
  const seniorOnly = tmpdir("tb-integration-skills-senior-");
  try {
    writeFile(
      root.root,
      "shared-notes/SKILL.md",
      skillDoc("name: shared-notes\ndescription: Shared note conventions.", "# Shared"),
    );
    writeFile(
      root.root,
      "senior-checklist/SKILL.md",
      skillDoc(
        "name: senior-checklist\ndescription: Senior review checklist.\nscope: senior\ntools: workspace_read_file",
        "# Checklist",
      ),
    );
    const catalog = discoverSkills([root.root]);

    const juniorPrompt = assembleSystemPrompt("BASE", [], undefined, {
      skills: catalog,
      role: "junior",
    });
    assert.ok(juniorPrompt.text.includes("## Available skills"));
    assert.ok(juniorPrompt.text.includes("- shared-notes: Shared note conventions."));
    assert.ok(!juniorPrompt.text.includes("senior-checklist"), "senior scope does not leak");
    assert.ok(juniorPrompt.text.includes("To use a skill, reply with"));
    assert.deepEqual(juniorPrompt.sections, [
      "base",
      "Available tools",
      PROMPT_SECTION_SKILLS,
    ]);

    const seniorPrompt = assembleSystemPrompt("BASE", [], undefined, {
      skills: catalog,
      role: "senior",
    });
    assert.ok(seniorPrompt.text.includes("- senior-checklist: Senior review checklist."));

    // no skills configured -> no section and no sections-list entry (the
    // pre-skills prompt bytes stay untouched)
    const bare = assembleSystemPrompt("BASE", []);
    assert.ok(!bare.text.includes("## Available skills"));
    assert.deepEqual(bare.sections, ["base", "Available tools"]);

    // run-level: a senior-only catalog gives the senior the section and audit
    // entry, the junior neither
    writeFile(
      seniorOnly.root,
      "senior-checklist/SKILL.md",
      skillDoc("name: senior-checklist\ndescription: Senior review checklist.\nscope: senior"),
    );
    const run = await workRunWithPlugin(SCOPED_PLUGIN, [{ text: DELIVERABLE }], {
      skills: discoverSkills([seniorOnly.root]),
    });
    try {
      const seniorAudit = run.result.promptAudits.find((audit) => audit.role === "senior");
      assert.ok(seniorAudit);
      assert.ok(seniorAudit.sections.includes(PROMPT_SECTION_SKILLS));
      for (const audit of run.result.promptAudits.filter((entry) => entry.role === "junior")) {
        assert.ok(
          !audit.sections.includes(PROMPT_SECTION_SKILLS),
          "junior has no skills, so no section",
        );
      }
    } finally {
      run.cleanup();
    }
  } finally {
    root.cleanup();
    seniorOnly.cleanup();
  }
});

// ---------------------------------------------------------------------------
// (v) GET /api/skills responds with metadata only
// ---------------------------------------------------------------------------

async function startServer(
  sessionsDir: string,
  skillsDirs: string[],
): Promise<{ base: string; close(): Promise<void> }> {
  const handle = createServer({
    configFactory: () => resolveConfig({ provider: "mock", mode: "consult" }),
    sessionsDir,
    webDist: null,
    pluginsDir: path.join(sessionsDir, "missing-plugins"),
    skillsDirs,
  });
  const server = await handle.listen("127.0.0.1", 0);
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => handle.close(),
  };
}

test("server: GET /api/skills lists metadata without bodies", async () => {
  const sessions = tmpdir("tb-integration-sessions-");
  const skillsRoot = tmpdir("tb-integration-skills-server-");
  try {
    const file = writeFile(
      skillsRoot.root,
      "review/SKILL.md",
      skillDoc(
        "name: review\ndescription: Review checklist.\nscope: senior\ntools: workspace_read_file, workspace_run_shell",
        "# Review\n\nSECRET-BODY-TEXT",
      ),
    );
    const srv = await startServer(sessions.root, [skillsRoot.root]);
    try {
      const res = await fetch(`${srv.base}/api/skills`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        skills: Array<Record<string, unknown>>;
        diagnostics: string[];
      };
      assert.deepEqual(body.skills, [
        {
          name: "review",
          description: "Review checklist.",
          scope: "senior",
          tools: ["workspace_read_file", "workspace_run_shell"],
          file,
        },
      ]);
      assert.ok(Array.isArray(body.diagnostics));
      assert.ok(!JSON.stringify(body).includes("SECRET-BODY-TEXT"), "bodies never leave");
    } finally {
      await srv.close();
    }
  } finally {
    sessions.cleanup();
    skillsRoot.cleanup();
  }
});

// ---------------------------------------------------------------------------
// (vi) maxTokens rides the per-role endpoint provider onto the wire
// ---------------------------------------------------------------------------

/** Loopback OpenAI-compatible endpoint that records every request body. */
async function startCapturingEndpoint(script: string[]): Promise<{
  baseUrl: string;
  requests: Array<Record<string, unknown>>;
  close(): Promise<void>;
}> {
  const requests: Array<Record<string, unknown>> = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk as Buffer));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as Record<string, unknown>;
      requests.push(body);
      const content = script.length > 1 ? script.shift() : script[0];
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { content } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

test("providerFromEndpoint forwards the run-level maxTokens cap", async () => {
  const endpoint = await startCapturingEndpoint([
    JSON.stringify({ task: "t", ask: "a", expect: "proposal" }),
    JSON.stringify({ title: "P", answer: "A", confidence: 0.7 }),
    JSON.stringify({ verdict: "accept", notes: "ok" }),
    JSON.stringify({ decision: "done", confidence: 0.8 }),
  ]);
  try {
    const base: Config = resolveConfig({
      provider: "openai",
      mode: "consult",
      baseUrl: endpoint.baseUrl,
      seniorModel: "m-senior",
      juniorModel: "m-junior",
      retries: 0,
      maxTokens: 77,
    });
    const harness = new TwoBrothersHarness(base, {
      endpoints: {
        senior: { provider: "openai", baseUrl: endpoint.baseUrl, apiKey: "k", model: "m-senior" },
        junior: { provider: "openai", baseUrl: endpoint.baseUrl, apiKey: "k", model: "m-junior" },
      },
    });
    await harness.run("cap check");

    assert.equal(endpoint.requests.length, 4, "consult -> proposal -> review -> decision");
    for (const request of endpoint.requests) {
      assert.equal(request.max_tokens, 77, `max_tokens missing on ${String(request.model)}`);
    }
  } finally {
    await endpoint.close();
  }
});

// ---------------------------------------------------------------------------
// (vii) seeded presets on the server: listed, usable as refs, editable
// ---------------------------------------------------------------------------

test("server: seeded presets are listed, accepted as provider_ref, and editable", async () => {
  const sessions = tmpdir("tb-integration-presets-");
  try {
    const srv = await startServer(sessions.root, []);
    try {
      type PublicPreset = {
        name: string;
        base_url: string;
        api_key_set: boolean;
        models: string[];
      };
      const getProviders = async (): Promise<PublicPreset[]> =>
        ((await (await fetch(`${srv.base}/api/providers`)).json()) as {
          providers: PublicPreset[];
        }).providers;

      const seeded = await getProviders();
      const openai = seeded.find((preset) => preset.name === "openai");
      assert.ok(openai, "the curated seed table is listed");
      assert.equal(openai.base_url, "https://api.openai.com/v1");
      assert.deepEqual(openai.models, ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini"]);
      assert.equal(typeof openai.api_key_set, "boolean", "key status is masked, never the key");

      // a seed id is a valid provider_ref
      const settings = await fetch(`${srv.base}/api/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ senior: { provider_ref: "openai" } }),
      });
      assert.equal(settings.status, 200);

      // editing a seed materializes a stored override, merged in place
      const put = await fetch(`${srv.base}/api/providers/openai`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ models: ["gpt-4.1"] }),
      });
      assert.equal(put.status, 200);
      assert.deepEqual(((await put.json()) as { provider: PublicPreset }).provider.models, [
        "gpt-4.1",
      ]);
      const merged = await getProviders();
      assert.equal(merged.filter((preset) => preset.name === "openai").length, 1, "in place");
      assert.deepEqual(merged.find((preset) => preset.name === "openai")?.models, ["gpt-4.1"]);
      const onDisk = fs.readFileSync(path.join(sessions.root, "settings.json"), "utf-8");
      assert.ok(onDisk.includes('"openai"'), "the override is persisted");
    } finally {
      await srv.close();
    }
  } finally {
    sessions.cleanup();
  }
});