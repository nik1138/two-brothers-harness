/**
 * Local plugin system: `plugins/` tool modules for the two brothers.
 * Ports the original prototype's plugin module (removed 2026-11-04; see git
 * history — see docs/plugins.md).
 *
 * A plugin is a single trusted-by-operator ES module dropped into `plugins/`
 * (repo root by default) exposing `register(ctx)`. A tool is a
 * typed function invoked through the same bounded path as the built-in coding
 * tools — workspace confinement, the central PermissionManager approval
 * broker, and the runtime-event history.
 *
 * **Tool scope is shared by default** (owner decision 2026-11-03:
 * adding a plugin makes it work for both agents). `add_tool` can opt a tool
 * into one scope explicitly — `{ scope: "senior" | "junior" }` — and the
 * declared scope is recorded on the registered tool so a scope-aware caller
 * (the `toolScopes` registry) can route it. The legacy positional `role`
 * argument still works: it is validated, mapped onto `scope` for inspection
 * and flagged with a deprecation note in `ctx.diagnostics` (never an error),
 * but it does not change assignment — `effectiveToolScope` keeps such tools
 * shared, so the owner decision is not silently reversed for existing
 * plugin sources.
 *
 * Three additive capabilities ride on top (research notes:
 * research/harnesses/plugins-{pi,kimi-code,deepseek-harness,opencode}.md):
 *
 * - **Hooks** (`on_hook`): `session_start`, `session_end`,
 *   `before_tool_call`, `after_tool_call`, dispatched in registration order
 *   through the pure `dispatchHook` helper. Dispatch is fail-soft — a throwing
 *   handler lands in `ctx.diagnostics` and never propagates — and a deny is
 *   monotonic: once a `before_tool_call` handler vetoes, later handlers cannot
 *   un-veto. Hooks are stored per plugin context, so a broken plugin cannot
 *   break another plugin's handlers.
 * - **Options + manifest**: settings entries may be a bare plugin path/name
 *   (`string`, the historical shape) or `{ path, options }`. Options are
 *   checked against an optional exported `configSchema` (the JSON-Schema
 *   subset from `toolschema.ts`); a rejected options object produces a
 *   diagnostic and the plugin still loads with `options = {}`. An optional
 *   exported `manifest` object is recorded (its `description` is the last
 *   fallback for the plugin description).
 * - **MCP server declarations** (`ctx.add_mcp_server(name, config)`, or an
 *   exported `mcpServers` object on the module): a declaration is shaped
 *   exactly like one `--mcp-config` `mcpServers` entry (stdio
 *   `command`/`args`/`env`/`cwd` or streamable-HTTP `url`/`headers`, plus the
 *   optional per-server `role`, default `junior`). Declarations are collected
 *   per run (`collectPluginMcpServers`, `PluginBindings.mcpServers`) and
 *   merged under the configured file by `mergeMcpConfig` (`src/mcp.ts`): a
 *   configured entry wins a name collision, then the first plugin to claim
 *   the name. Never persisted — re-registered on every load, like pi
 *   (research/harnesses/plugins-pi.md R6).
 *
 * Structured tool arguments: a tool registered with `{ parameters }` gets its
 * model-supplied arguments validated by `validateToolArgs` (the
 * `src/toolschema.ts` subset validator) before its handler runs; invalid
 * arguments become a `plugin tool error: invalid arguments: …` result instead
 * of reaching the handler. Tools registered with the legacy `params_schema`
 * shorthand are not validated (the shorthand is lossy and intentionally
 * tolerant).
 *
 * Loading is **fail-soft**: a plugin that fails to import or register is
 * skipped, its error is logged and recorded in `errors` (surfaced through
 * `GET /api/plugins`), and never breaks server startup or a run. Tool names
 * colliding with the built-in workspace tools are rejected at registration —
 * built-ins always win.
 *
 * The manager is created once at server startup (and reloaded after a
 * settings change carrying a `plugins` section, per the design doc). Importing
 * a module happens once per load; for every run the manager re-runs
 * `register` against a fresh context bound to *that run's* Workspace, so
 * parallel runs never share plugin state and every file access is confined
 * and approval-gated through the workspace the run already uses.
 *
 * TS divergences from the Python contract (documented, the wire/API-visible
 * behavior is unchanged):
 * - Plugin files are ES modules: `[a-z0-9_]+` + `.ts`/`.mts`/`.mjs`, loaded
 *   with a plain dynamic `import()` (per the BACKLOG decision: plain dynamic
 *   import for single-process use; `.ts` needs the engines floor Node
 *   >= 22.19, where native type stripping is on by default). `.js`/`.cjs` are
 *   skipped — without a package.json `type` their module kind is ambiguous.
 *   `.ts` files under a `type`-less package.json are reparsed as ESM by Node
 *   with a one-line warning — prefer `.mts`, or give the plugins directory a
 *   `{"type": "module"}` package.json (the repo example uses `notes.mts`).
 *   `reload()` re-imports with a `?v=N` query so changed files are picked up
 *   (ESM caches by URL, like Python pops `sys.modules`).
 * - `register(ctx)` may be sync or async; `PluginManager.toolsFor` /
 *   `bindingsFor` are async because dynamic import is (the prototype's load is sync).
 * - `params_schema` has no runtime signature introspection to feed (no
 *   model adapter), so it IS the tool's argument spec: either a full JSON
 *   Schema (`{type: "object", properties: {...}}`) or the prototype-style
 *   shorthand `name -> type-name`, translated to string-typed properties so
 *   the example plugin reads identically in both ports.
 * - There is no module-docstring fallback for the plugin description (JS
 *   modules carry no docstrings) — use `ctx.set_description(...)`; an
 *   exported `description` string, then `manifest.description`, is honored as
 *   the fallback instead.
 * - `register(ctx)` keeps its single-argument signature: per-plugin settings
 *   arrive on `ctx.options` (validated against the module's exported
 *   `configSchema` when it declares one) instead of a second argument.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { isValidMcpServerName, mcpServerSpecIssue } from "./mcp.ts";
import type { Tool } from "./provider.ts";
import { validateArgs, type JsonSchemaSubset } from "./toolschema.ts";
import type { Workspace, WorkspaceResult } from "./workspace.ts";

/** Raised for plugin contract violations (bad tool name, role, ...). */
export class PluginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginError";
  }
}

interface NormalizedAddTool {
  optionsForm: boolean;
  description: string;
  parameters?: JsonSchemaSubset;
  scope?: ToolScope;
  timeoutMs?: number;
}

/**
 * Tell `add_tool`'s two call shapes apart and validate the options form.
 * A string (or omitted) third argument is the legacy positional description;
 * an object is the options form introduced with per-role scoping. Malformed
 * options throw PluginError, which the fail-soft loader turns into a skipped
 * plugin — exactly like a bad role did before.
 */
function normalizeAddToolOptions(
  value: string | AddToolOptions | null | undefined,
): NormalizedAddTool {
  if (typeof value === "string" || value === undefined || value === null) {
    return { optionsForm: false, description: typeof value === "string" ? value : "" };
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new PluginError("add_tool options must be an object");
  }
  const parameters = value.parameters;
  if (
    parameters !== undefined &&
    (typeof parameters !== "object" || parameters === null || Array.isArray(parameters))
  ) {
    throw new PluginError("add_tool options.parameters must be a JSON-schema object");
  }
  const scope = value.scope;
  if (scope !== undefined && !TOOL_SCOPES.includes(scope)) {
    throw new PluginError(`unknown scope: ${JSON.stringify(scope)} (use shared|senior|junior)`);
  }
  const timeoutMs = value.timeoutMs;
  if (
    timeoutMs !== undefined &&
    (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0)
  ) {
    throw new PluginError("add_tool options.timeoutMs must be a positive number of milliseconds");
  }
  return {
    optionsForm: true,
    description: typeof value.description === "string" ? value.description : "",
    parameters: parameters as JsonSchemaSubset | undefined,
    scope,
    timeoutMs,
  };
}

// ``Workspace.asTools()`` names — kept in sync manually; a plugin tool with
// one of these names is rejected so built-ins always win.
export const BUILTIN_TOOL_NAMES: ReadonlySet<string> = new Set([
  "workspace_read_file",
  "workspace_list_dir",
  "workspace_search_text",
  "workspace_write_file",
  "workspace_edit_file",
  "workspace_delete_file",
  "workspace_run_shell",
]);

const PLUGIN_FILE_RE = /^[a-z0-9_]+\.(?:ts|mts|mjs)$/;
const ROLES = ["senior", "junior"] as const;
type Role = (typeof ROLES)[number];

/** Where a tool may be offered: both brothers, or exactly one of them. */
export const TOOL_SCOPES = ["shared", "senior", "junior"] as const;
export type ToolScope = (typeof TOOL_SCOPES)[number];

/** A plugin tool handler: receives the model's arguments, returns the result. */
export type PluginToolHandler =
  (args: Record<string, unknown>) => unknown;

/** One entry of the `errors` list surfaced through `GET /api/plugins`. */
export interface PluginErrorEntry {
  plugin: string;
  error: string;
}

/** A non-fatal note about a plugin (deprecation, rejected options, ...). */
export interface PluginDiagnosticEntry {
  plugin: string;
  message: string;
}

/**
 * One MCP server declaration contributed by a plugin.
 *
 * `config` has the shape of a single `--mcp-config` `mcpServers` entry
 * (`command`/`args`/`env`/`cwd` for stdio, `url`/`headers` for streamable
 * HTTP) plus the optional per-server `role` (`shared|senior|junior`, default
 * `junior`) and `timeoutMs`. `plugin` names the contributor so
 * `mergeMcpConfig` can explain a collision.
 */
export interface PluginMcpServer {
  /** The `mcpServers` key: `[a-z0-9_-]+`. */
  name: string;
  /** The declaration, ready to merge into `mcpServers`. */
  config: Record<string, unknown>;
  /** Name of the contributing plugin. */
  plugin: string;
}

/** Options form of `add_tool` (the positional form stays supported). */
export interface AddToolOptions {
  /** Model-facing description; `""` keeps the generated default. */
  description?: string;
  /**
   * The tool's argument schema. Declaring it opts the tool into dispatch-time
   * validation (`validateToolArgs`); it is also the schema sent to the model.
   */
  parameters?: JsonSchemaSubset;
  /**
   * Where the tool lands in the `toolScopes` registry. Omitted = `"shared"`,
   * the owner decision of 2026-11-03 (a plugin tool works for both brothers
   * unless it says otherwise).
   */
  scope?: ToolScope;
  /** Cooperative deadline enforced around the handler; omitted = no limit. */
  timeoutMs?: number;
}

/** One tool recorded by a plugin's `register` call. */
export interface RegisteredTool {
  name: string;
  handler: PluginToolHandler;
  description: string;
  /** JSON Schema or Python-style `name -> type-name` shorthand (see header). */
  paramsSchema: Record<string, unknown>;
  /**
   * The declared scope. Omitted means `shared` (the owner decision of
   * 2026-11-03) — `add_tool` always sets it, but tools assembled by older
   * callers/tests may not. `toolsFor` returns every tool regardless; routing
   * is `effectiveToolScope(tool)` (see below), which honours an explicit
   * `{ scope }` opt-in and keeps legacy-role/default tools shared.
   */
  scope?: ToolScope;
  /**
   * Provenance of `scope`:
   * - `"explicit"` — the plugin passed `{ scope }`: an opt-in, honoured.
   * - `"legacy-role"` — the deprecated positional `role`: mapped onto `scope`
   *   for inspection, but assignment stays `shared` so the owner decision
   *   (2026-11-03) is not silently reversed for existing plugin sources.
   * - `"default"` / absent — nothing declared: `shared`.
   */
  scopeSource?: "default" | "explicit" | "legacy-role";
  /**
   * Deprecated mirror of the positional `role` argument. Recorded for
   * plugin-source compatibility only; `scope` is authoritative.
   */
  role: Role;
  /**
   * The args schema declared through `AddToolOptions.parameters`, when any.
   * Present = dispatch-time validation is on; absent = tolerant (no check).
   */
  parameters?: JsonSchemaSubset;
  /** Declared per-tool deadline in milliseconds, when any. */
  timeoutMs?: number;
}

/**
 * The scope a tool is actually assigned to.
 *
 * An explicit `{ scope }` opt-in is honoured; a legacy positional `role` is
 * recorded on the tool but does not scope assignment (owner decision
 * 2026-11-03 — an existing source that says `"junior"` keeps working for both
 * brothers); everything else is `shared`.
 */
export function effectiveToolScope(tool: RegisteredTool): ToolScope {
  if (tool.scopeSource === "legacy-role") return "shared";
  return tool.scope ?? "shared";
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/**
 * The minimal hook set shared by the researched harnesses (pi's `tool_call`,
 * kimi's `PreToolUse`/`SessionStart`, dsh's pre-execute tool hook and
 * opencode's `execute.before`). Deliberately small: every hook here has a
 * concrete control point in the cooperation loop.
 */
export const HOOK_NAMES = [
  "session_start",
  "session_end",
  "before_tool_call",
  "after_tool_call",
] as const;
export type HookName = (typeof HOOK_NAMES)[number];

export type HookRole = Role;

export interface SessionStartEvent {
  readonly session_id: string;
  /** Absolute workspace root when the run is workspace-bound, else null. */
  readonly workspace: string | null;
}

export interface SessionEndEvent {
  readonly session_id: string;
  /** Terminal run status (`completed`, `failed`, ...), caller-defined. */
  readonly status: string;
}

/**
 * Fires before a tool executes. `args` is mutable in place (a handler may
 * rewrite the arguments the tool will receive). Set `event.deny` or return
 * `{ deny }` to veto the call; a later handler can never clear a deny.
 */
export interface BeforeToolCallEvent {
  readonly role: HookRole;
  readonly tool: string;
  args: Record<string, unknown>;
  deny?: string;
}

/** Fires after a tool executed. `result` is mutable (redaction/rewrite). */
export interface AfterToolCallEvent {
  readonly role: HookRole;
  readonly tool: string;
  readonly args: Record<string, unknown>;
  result: unknown;
}

export interface PluginHookEvents {
  session_start: SessionStartEvent;
  session_end: SessionEndEvent;
  before_tool_call: BeforeToolCallEvent;
  after_tool_call: AfterToolCallEvent;
}

/**
 * A hook result. Only `before_tool_call` consumes `deny`; the other hooks
 * observe/mutate the event in place and ignore a returned object.
 */
export type HookOutcome = void | { deny?: string };
export type HookHandler<K extends HookName = HookName> = (
  event: PluginHookEvents[K],
) => HookOutcome | Promise<HookOutcome>;

/** One handler, tagged with the plugin that registered it. */
export interface HookRegistration {
  readonly name: HookName;
  readonly plugin: string;
  readonly handler: HookHandler;
  /** The owning context's diagnostics sink; dispatch failures land here. */
  readonly diagnostics: string[];
  /** Extra live sink used by the run binding (a `PluginBindings.diagnostics` view). */
  readonly onError?: (message: string) => void;
}

/** Hooks are stored per plugin context and merged per run by name. */
export type HookRegistry = Record<HookName, HookRegistration[]>;

export interface HookDispatchResult {
  /** The monotonic veto: set by the first handler that denies. */
  deny?: string;
  /** Handler failures, in dispatch order; the same lines land in diagnostics. */
  errors: string[];
}

export function createHookRegistry(): HookRegistry {
  return {
    session_start: [],
    session_end: [],
    before_tool_call: [],
    after_tool_call: [],
  };
}

export function registerHook(registry: HookRegistry, registration: HookRegistration): void {
  registry[registration.name].push(registration);
}

/** Merge per-plugin hook lists in activation order, registration order within. */
export function collectHooks(contexts: Iterable<PluginContext>): HookRegistry {
  const registry = createHookRegistry();
  for (const ctx of contexts) {
    for (const registration of ctx._hooks) registerHook(registry, registration);
  }
  return registry;
}

/**
 * Flatten the MCP server declarations of a set of plugin contexts, in
 * iteration order (plugin activation order, then registration order within
 * one plugin — `ctx.add_mcp_server` calls before the module's exported
 * `mcpServers`).
 *
 * Duplicates are kept on purpose: a name contributed by two plugins is
 * resolved by `mergeMcpConfig` (`first wins` plus a diagnostic), so this
 * collection stays a faithful view of what the plugins asked for.
 */
export function collectPluginMcpServers(
  contexts: Iterable<PluginContext>,
): PluginMcpServer[] {
  const servers: PluginMcpServer[] = [];
  for (const ctx of contexts) {
    for (const server of ctx._mcpServers) servers.push(server);
  }
  return servers;
}

/**
 * Run every handler registered for `name`, in registration order.
 *
 * Fail-soft by design (a deliberate divergence from dsh, which fails loud):
 * a throwing or rejecting handler is recorded in the owning plugin context's
 * diagnostics — and returned in `errors` — and never propagates. Deny is
 * monotonic: once `event.deny` is set, a later handler clearing it (by
 * assignment or by returning `{ deny: undefined }`) is undone.
 *
 * The event object is the shared state: argument/result mutations are made in
 * place by handlers and read back by the caller.
 */
export async function dispatchHook<K extends HookName>(
  registry: HookRegistry,
  name: K,
  event: PluginHookEvents[K],
): Promise<HookDispatchResult> {
  const errors: string[] = [];
  for (const registration of registry[name] ?? []) {
    const pinned = denyOf(event);
    try {
      const outcome = await registration.handler(event);
      if (denyOf(event) === undefined && isDenyOutcome(outcome)) {
        setDeny(event, outcome.deny);
      }
    } catch (exc) {
      const message = `hook ${name} from plugin ${JSON.stringify(registration.plugin)} failed: ${formatError(exc)}`;
      errors.push(message);
      registration.diagnostics.push(message);
      registration.onError?.(message);
    } finally {
      // A deny, once given, is sticky: restore it even if the handler tried to
      // clear it by mutating the event.
      if (pinned !== undefined) setDeny(event, pinned);
    }
  }
  return { deny: denyOf(event), errors };
}

interface WithDeny {
  deny?: string;
}

function denyOf(event: unknown): string | undefined {
  const deny = (event as WithDeny).deny;
  return typeof deny === "string" && deny.trim() !== "" ? deny : undefined;
}

function setDeny(event: unknown, deny: string): void {
  (event as WithDeny).deny = deny;
}

function isDenyOutcome(outcome: HookOutcome): outcome is { deny: string } {
  return (
    typeof outcome === "object" &&
    outcome !== null &&
    typeof outcome.deny === "string" &&
    outcome.deny.trim() !== ""
  );
}

/** One successfully imported + registered plugin module. */
export interface LoadedPlugin {
  name: string;
  module: Record<string, unknown>;
  description: string;
  tools: RegisteredTool[];
  path: string;
  /** Validated options used for the load-time registration. */
  options: Record<string, unknown>;
  /** Optional exported `manifest` object (`{name, version, description}`). */
  manifest: Record<string, unknown> | null;
  /** Load-time hooks; per-run hooks come from `bindingsFor`. */
  hooks: HookRegistration[];
  /** Load-time MCP servers (`add_mcp_server` + the exported `mcpServers`). */
  mcpServers: PluginMcpServer[];
  /** Registration diagnostics (deprecations, rejected options, ...). */
  diagnostics: string[];
}

/**
 * The only object a plugin's `register(ctx)` receives.
 *
 * `add_tool` records one tool; `on_hook` records one lifecycle handler; `log`
 * writes a one-line server-log note. `diagnostics` collects non-fatal notes
 * (the legacy `role` deprecation, rejected options, hook failures) — never
 * thrown, so a plugin can read its own feedback. `options` carries the
 * validated per-plugin settings for this registration.
 *
 * The `workspace_*` helpers are thin confined bridges over the run's
 * Workspace: reads auto-allow, writes / edits / deletes / shell pass through
 * the same PermissionManager approval broker as the built-in tools. They
 * raise PluginError when the current run has no workspace.
 *
 * Method names keep the Python `snake_case` contract verbatim (same as the
 * `Workspace` tool methods), so a plugin reads identically in both ports.
 */
export class PluginContext {
  readonly plugin_name: string;
  readonly workspace: Workspace | null;
  /** Validated per-plugin settings (`{}` when the plugin declared none). */
  readonly options: Record<string, unknown>;
  /** Non-fatal notes: deprecations, rejected options, failed hooks. */
  readonly diagnostics: string[] = [];
  description = "";
  readonly _tools: RegisteredTool[] = [];
  readonly _hooks: HookRegistration[] = [];
  readonly _mcpServers: PluginMcpServer[] = [];
  private readonly _mcpServerNames = new Set<string>();

  constructor(
    pluginName: string,
    workspace: Workspace | null = null,
    options: Record<string, unknown> = {},
  ) {
    this.plugin_name = pluginName;
    this.workspace = workspace;
    this.options = { ...options };
  }

  // -- registration ---------------------------------------------------------

  set_description(text: string): void {
    this.description = String(text);
  }

  log(message: string): void {
    console.log(`[${this.plugin_name}] ${message}`);
  }

  /**
   * Record one tool.
   *
   * Preferred form: `add_tool(name, execute, { description, parameters,
   * scope, timeoutMs })`. The positional Python-parity form
   * `add_tool(name, handler, description?, paramsSchema?, role?)` still works;
   * a positional `role` is mapped onto `scope` and produces a deprecation note
   * in `diagnostics` (never an error).
   */
  add_tool(
    name: string,
    handler: PluginToolHandler,
    descriptionOrOptions?: string | AddToolOptions,
    paramsSchema?: Record<string, unknown> | null,
    role?: string,
  ): void {
    if (typeof name !== "string" || !name.trim()) {
      throw new PluginError("tool name must be a non-empty string");
    }
    if (typeof handler !== "function") {
      throw new PluginError(`handler for ${JSON.stringify(name)} is not callable`);
    }
    const opts = normalizeAddToolOptions(descriptionOrOptions);
    if (opts.optionsForm) {
      this._tools.push({
        name: name.trim(),
        handler,
        description: String(opts.description ?? ""),
        paramsSchema: opts.parameters ? { ...opts.parameters } : {},
        parameters: opts.parameters,
        scope: opts.scope ?? "shared",
        scopeSource: opts.scope === undefined ? "default" : "explicit",
        role: opts.scope === "senior" ? "senior" : "junior",
        timeoutMs: opts.timeoutMs,
      });
      return;
    }
    // Legacy positional form: `role` was validated and recorded; it now maps
    // onto the scope field, and the caller is told to switch to the options.
    if (role !== undefined) {
      if (!ROLES.includes(role as Role)) {
        throw new PluginError(`unknown role: ${JSON.stringify(role)} (use senior|junior)`);
      }
      this.diagnostics.push(
        `tool ${JSON.stringify(name.trim())}: add_tool's positional role argument is ` +
          `deprecated; pass { scope: ${JSON.stringify(role)} } to opt into per-role ` +
          "(the legacy role is recorded but assignment stays shared)",
      );
    }
    const scope: ToolScope = role === undefined ? "shared" : (role as ToolScope);
    this._tools.push({
      name: name.trim(),
      handler,
      description: String(opts.description || ""),
      paramsSchema:
        paramsSchema && typeof paramsSchema === "object" ? { ...paramsSchema } : {},
      scope,
      scopeSource: role === undefined ? "default" : "legacy-role",
      role: scope === "senior" ? "senior" : "junior",
    });
  }

  /**
   * Register one lifecycle hook. Dispatch order is registration order (across
   * plugins: activation order first); see `dispatchHook` for the fail-soft and
   * monotonic-deny semantics.
   */
  on_hook<K extends HookName>(name: K, handler: HookHandler<K>): void {
    if (!HOOK_NAMES.includes(name)) {
      throw new PluginError(
        `unknown hook: ${JSON.stringify(name)} (use ${HOOK_NAMES.join("|")})`,
      );
    }
    if (typeof handler !== "function") {
      throw new PluginError(`hook handler for ${JSON.stringify(name)} is not callable`);
    }
    this._hooks.push({
      name,
      plugin: this.plugin_name,
      handler: handler as HookHandler,
      diagnostics: this.diagnostics,
    });
  }

  /**
   * Contribute one MCP server declaration to every run that activates this
   * plugin.
   *
   * `config` is shaped exactly like one `--mcp-config` `mcpServers` entry:
   * `command`/`args`/`env`/`cwd` for stdio or `url`/`headers` for streamable
   * HTTP, plus the optional per-server `role` (`shared|senior|junior`,
   * default `junior`) and `timeoutMs`. The declaration reaches `loadMcpTools`
   * through `mergeMcpConfig` (`src/mcp.ts`), so namespacing
   * (`mcp__<server>__<tool>`), the 20 KiB result clip and per-server role
   * routing are unchanged.
   *
   * Tolerant by contract: a name outside `[a-z0-9_-]+`, a declaration with
   * neither `command` nor `url`, a bad `role`/`timeoutMs`, or the same name
   * twice from one plugin is recorded in `diagnostics` and ignored — never
   * thrown, so one bad declaration cannot break plugin registration. A
   * configured `mcpServers` entry wins a name collision at merge time.
   */
  add_mcp_server(name: string, config: Record<string, unknown>): void {
    const label = typeof name === "string" ? JSON.stringify(name) : String(name);
    if (!isValidMcpServerName(name)) {
      this.diagnostics.push(`mcp server ${label} rejected: name must match [a-z0-9_-]+`);
      return;
    }
    const issue = mcpServerSpecIssue(config);
    if (issue !== null) {
      this.diagnostics.push(`mcp server ${label} rejected: ${issue}`);
      return;
    }
    if (this._mcpServerNames.has(name)) {
      this.diagnostics.push(
        `mcp server ${label} rejected: already registered by this plugin (first wins)`,
      );
      return;
    }
    this._mcpServerNames.add(name);
    this._mcpServers.push({ name, config: { ...config }, plugin: this.plugin_name });
  }

  // -- confined workspace helpers ---------------------------------------------

  private _require_workspace(): Workspace {
    if (this.workspace === null) {
      throw new PluginError(
        `plugin ${JSON.stringify(this.plugin_name)}: no workspace in this run; ` +
          "workspace_* helpers need a workspace-bound run",
      );
    }
    return this.workspace;
  }

  workspace_read(rel: string, maxChars = 10_000): Promise<WorkspaceResult> {
    return this._require_workspace().read_file(rel, maxChars);
  }

  workspace_list(rel = "."): Promise<WorkspaceResult> {
    return this._require_workspace().list_dir(rel);
  }

  workspace_search(pattern: string, rel = "."): Promise<WorkspaceResult> {
    return this._require_workspace().search_text(pattern, rel);
  }

  workspace_write(rel: string, content: string): Promise<WorkspaceResult> {
    return this._require_workspace().write_file(rel, content);
  }

  workspace_edit(
    rel: string,
    oldText: string,
    newText: string,
    replaceAll = false,
  ): Promise<WorkspaceResult> {
    return this._require_workspace().edit_file(rel, oldText, newText, replaceAll);
  }

  workspace_delete(rel: string): Promise<WorkspaceResult> {
    return this._require_workspace().delete_file(rel);
  }

  workspace_shell(command: string, timeout?: number): Promise<WorkspaceResult> {
    return this._require_workspace().run_shell(command, timeout);
  }
}

// ---------------------------------------------------------------------------
// Tool adapter
// ---------------------------------------------------------------------------

/** Map a Python-style `type-name` onto a JSON Schema primitive type. */
function shorthandType(name: unknown): string {
  const text = String(name).toLowerCase();
  if (text === "integer" || text === "number" || text === "boolean") return text;
  return "string"; // "str", unknown annotations, everything else — like Python
}

/**
 * The OpenAI `function.parameters` spec for a registered tool. A `params_schema`
 * carrying `type`/`properties` is a full JSON Schema and passes through
 * (defaulting `type` to "object"); anything else is read as the Python-style
 * `name -> type-name` shorthand and translated to string-typed properties.
 */
export function toolParameters(paramsSchema: Record<string, unknown>): Record<string, unknown> {
  const schema = paramsSchema && typeof paramsSchema === "object" ? paramsSchema : {};
  if ("type" in schema || "properties" in schema) {
    const full = { ...schema };
    full.type ??= "object";
    full.properties ??= {};
    return full;
  }
  const properties: Record<string, unknown> = {};
  for (const [paramName, typeName] of Object.entries(schema)) {
    properties[paramName] = { type: shorthandType(typeName) };
  }
  return { type: "object", properties };
}

/** The structured result of dispatch-time argument validation. */
export type ToolArgsCheck =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; error: string };

/**
 * Validate a plugin tool's model-supplied arguments.
 *
 * Only tools registered with `AddToolOptions.parameters` are checked; the
 * legacy `params_schema` shorthand stays tolerant (it is lossy by design).
 * The failing branch carries the model-facing error, shaped
 * `{ ok: false, error: "invalid arguments: args.code: expected string, got number" }`;
 * `asHarnessTool` prefixes it with the usual `plugin tool error:`.
 */
export function validateToolArgs(
  tool: RegisteredTool,
  args: Record<string, unknown>,
): ToolArgsCheck {
  if (tool.parameters === undefined) return { ok: true, args };
  const check = validateArgs(tool.parameters, args);
  if (check.ok) return { ok: true, args: check.value as Record<string, unknown> };
  return { ok: false, error: `invalid arguments: ${check.errors.join("; ")}` };
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number | undefined): Promise<T> {
  if (timeoutMs === undefined) return work;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (exc) => {
        clearTimeout(timer);
        reject(exc);
      },
    );
  });
}

/**
 * Wrap one registered tool as a harness `Tool` for the cooperation loop.
 * Tolerant at the boundary and fail-soft at run time, like the original
 * prototype's tool adapter: declared args are validated first, a string result
 * passes through, anything else is JSON-serialized, a declared `timeoutMs`
 * bounds the handler, and a thrown exception becomes a failed tool result —
 * never a crashed run.
 */
export function asHarnessTool(tool: RegisteredTool): Tool {
  return {
    name: tool.name,
    description: tool.description || `Plugin tool ${tool.name}.`,
    parameters: toolParameters(tool.paramsSchema),
    execute: async (args) => {
      const check = validateToolArgs(tool, args);
      if (!check.ok) return `plugin tool error: ${check.error}`;
      try {
        const result = await withTimeout(
          Promise.resolve(tool.handler(check.args)),
          tool.timeoutMs,
        );
        if (typeof result === "string") return result;
        return JSON.stringify(result ?? null);
      } catch (exc) {
        const message = exc instanceof Error ? exc.message : String(exc);
        return `plugin tool error: ${message}`;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Loader (fail-soft)
// ---------------------------------------------------------------------------

function formatError(exc: unknown): string {
  return exc instanceof Error ? `${exc.name}: ${exc.message}` : String(exc);
}

function isModuleNamespace(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * One entry of a plugin settings list: a bare path/name (the historical
 * `plugins: string[]` shape) or `{ path, options }` (opencode's entry form).
 */
export type PluginSetting = string | { path: string; options?: Record<string, unknown> };

/** A settings entry normalized to `{path, options}`; invalid entries vanish. */
export interface PluginSettingEntry {
  path: string;
  options: Record<string, unknown>;
}

/**
 * Normalize a settings list. Tolerant boundary: blank strings, entries with a
 * non-string path, and non-object options are dropped/emptied rather than
 * thrown — a bad settings file must never break plugin discovery.
 */
export function normalizePluginSettings(
  settings: readonly PluginSetting[] = [],
): PluginSettingEntry[] {
  const out: PluginSettingEntry[] = [];
  for (const entry of settings) {
    if (typeof entry === "string") {
      const name = entry.trim();
      if (name) out.push({ path: name, options: {} });
      continue;
    }
    if (entry === null || typeof entry !== "object") continue;
    const name = typeof entry.path === "string" ? entry.path.trim() : "";
    if (!name) continue;
    const raw = entry.options;
    const options =
      raw !== null && typeof raw === "object" && !Array.isArray(raw)
        ? { ...(raw as Record<string, unknown>) }
        : {};
    out.push({ path: name, options });
  }
  return out;
}

/** Settings entries are matched to files by plugin name (extension stripped). */
function pluginNameOf(entryPath: string): string {
  return path.basename(entryPath).replace(/\.[^.]+$/, "");
}

function optionsByName(
  settings: readonly PluginSetting[],
): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  for (const entry of normalizePluginSettings(settings)) {
    out.set(pluginNameOf(entry.path), entry.options);
  }
  return out;
}

/**
 * Check a plugin's declared options against its optional exported
 * `configSchema` (the `toolschema.ts` subset).
 *
 * Fail-soft: a rejected options object yields `options = {}` plus one
 * diagnostic, so the plugin still loads and its operator sees why the
 * settings were ignored. A plugin without a schema keeps its options as given
 * (free-form config, like opencode); a malformed `configSchema` is a
 * diagnostic that leaves the options unvalidated rather than rejecting them.
 */
export function resolvePluginOptions(
  module: Record<string, unknown>,
  rawOptions: Record<string, unknown> = {},
): { options: Record<string, unknown>; diagnostics: string[] } {
  const diagnostics: string[] = [];
  const options =
    rawOptions !== null && typeof rawOptions === "object" && !Array.isArray(rawOptions)
      ? { ...rawOptions }
      : {};
  const schema = module.configSchema;
  if (schema === undefined || schema === null) return { options, diagnostics };
  if (typeof schema !== "object" || Array.isArray(schema)) {
    diagnostics.push("configSchema is not a JSON-schema object; options were not validated");
    return { options, diagnostics };
  }
  const check = validateArgs(schema as JsonSchemaSubset, options);
  if (!check.ok) {
    diagnostics.push(
      `options rejected by configSchema (${check.errors.join("; ")}); loaded with {}`,
    );
    return { options: {}, diagnostics };
  }
  return { options, diagnostics };
}

/**
 * Import and register every plugin in `pluginsDir`.
 *
 * Returns `{plugins, errors, diagnostics}`; a broken plugin lands in `errors`
 * as `{plugin, error}` and never aborts the load. `loadCount` feeds the
 * `?v=N` cache-bust so a reload re-imports changed files (ESM caches by URL).
 * `settings` supplies per-plugin options (and does not filter discovery — the
 * enable list is the caller's business).
 */
export async function loadPlugins(
  pluginsDir: string,
  loadCount = 0,
  settings: readonly PluginSetting[] = [],
): Promise<{
  plugins: Map<string, LoadedPlugin>;
  errors: PluginErrorEntry[];
  diagnostics: PluginDiagnosticEntry[];
}> {
  const plugins = new Map<string, LoadedPlugin>();
  const errors: PluginErrorEntry[] = [];
  const diagnostics: PluginDiagnosticEntry[] = [];
  const optionsFor = optionsByName(settings);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(pluginsDir);
  } catch {
    return { plugins, errors, diagnostics }; // missing dir: no plugins, no errors
  }
  if (!stat.isDirectory()) return { plugins, errors, diagnostics };

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(pluginsDir, { withFileTypes: true });
  } catch {
    return { plugins, errors, diagnostics };
  }
  const files = entries
    .filter((entry) => entry.isFile() && PLUGIN_FILE_RE.test(entry.name))
    .map((entry) => entry.name)
    .sort();

  for (const fileName of files) {
    const name = fileName.replace(/\.[^.]+$/, "");
    const filePath = path.join(pluginsDir, fileName);
    try {
      const module = await importPluginModule(filePath, loadCount);
      const loaded = await registerModule(name, module, filePath, optionsFor.get(name) ?? {});
      for (const message of loaded.diagnostics) diagnostics.push({ plugin: name, message });
      plugins.set(name, loaded);
    } catch (exc) {
      const message = formatError(exc);
      console.warn(`[two-brothers] plugin "${name}" skipped: ${message}`);
      errors.push({ plugin: name, error: message });
    }
  }
  return { plugins, errors, diagnostics };
}

/** Dynamic `import()` of one plugin file with the reload cache-bust. */
async function importPluginModule(
  filePath: string,
  loadCount: number,
): Promise<Record<string, unknown>> {
  const url = `${pathToFileURL(filePath).href}?v=${loadCount}`;
  const module: unknown = await import(url);
  if (!isModuleNamespace(module)) {
    throw new PluginError(`cannot import ${path.basename(filePath)}`);
  }
  return module;
}

/**
 * Ingest a plugin module's optional exported `mcpServers` object — the
 * declarative alternative to calling `ctx.add_mcp_server` from `register`.
 *
 * Both paths feed the same per-context registry, so
 * `collectPluginMcpServers` and `PluginBindings.mcpServers` see one list
 * (register-time declarations first, then the exported object's entries in
 * key order). Fail-soft: a non-object export or a bad entry becomes a
 * diagnostic, never a throw.
 */
function registerManifestMcpServers(
  ctx: PluginContext,
  module: Record<string, unknown>,
): void {
  const declared = module.mcpServers;
  if (declared === undefined || declared === null) return;
  if (typeof declared !== "object" || Array.isArray(declared)) {
    ctx.diagnostics.push("exported 'mcpServers' is not an object; ignored");
    return;
  }
  for (const [serverName, config] of Object.entries(declared as Record<string, unknown>)) {
    ctx.add_mcp_server(serverName, config as Record<string, unknown>);
  }
}

async function registerModule(
  name: string,
  module: Record<string, unknown>,
  filePath: string,
  rawOptions: Record<string, unknown> = {},
): Promise<LoadedPlugin> {
  const register = module.register;
  if (typeof register !== "function") {
    throw new PluginError("plugin has no top-level register(ctx)");
  }
  const resolved = resolvePluginOptions(module, rawOptions);
  const ctx = new PluginContext(name, null, resolved.options);
  ctx.diagnostics.push(...resolved.diagnostics);
  await register(ctx);
  registerManifestMcpServers(ctx, module);
  const seen = new Set<string>();
  for (const tool of ctx._tools) {
    if (BUILTIN_TOOL_NAMES.has(tool.name)) {
      throw new PluginError(`tool name ${JSON.stringify(tool.name)} collides with a built-in tool`);
    }
    if (seen.has(tool.name)) {
      throw new PluginError(`duplicate tool name: ${JSON.stringify(tool.name)}`);
    }
    seen.add(tool.name);
  }
  // Optional manifest: recorded verbatim, never executed. Only its
  // `description` is consumed (last fallback below); version/requires are for
  // a later surface to report.
  const manifest =
    isModuleNamespace(module.manifest) && !Array.isArray(module.manifest)
      ? { ...module.manifest }
      : null;
  // No module-docstring fallback (JS modules carry no docstrings); an
  // exported `description` string is the documented stand-in, then the
  // manifest's.
  const exported = module.description;
  const exportedDescription =
    typeof exported === "string" ? exported.trim().split("\n")[0].trim() : "";
  const manifestDescription =
    manifest !== null && typeof manifest.description === "string"
      ? manifest.description.trim().split("\n")[0].trim()
      : "";
  const description = ctx.description || exportedDescription || manifestDescription;
  return {
    name,
    module,
    description,
    tools: ctx._tools,
    path: filePath,
    options: ctx.options,
    manifest,
    hooks: ctx._hooks,
    mcpServers: ctx._mcpServers,
    diagnostics: ctx.diagnostics,
  };
}

/** `plugins/` next to the repository root. */
export function defaultPluginsDir(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(moduleDir, "..", "..", "..", "plugins");
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

/** Harness tools bucketed by the scope their `RegisteredTool` declared. */
export interface ScopedTools {
  shared: Tool[];
  senior: Tool[];
  junior: Tool[];
}

/** One run's plugin contribution: tools (flat + scoped), hooks, MCP servers, diagnostics. */
export interface PluginBindings {
  /** Every tool of the active plugins, registration order (the historical shape). */
  tools: Tool[];
  /** The same `Tool` objects, bucketed by `effectiveToolScope` (one each). */
  toolsByScope: ScopedTools;
  /** Hooks of the active plugins, activation order then registration order. */
  hooks: HookRegistry;
  /**
   * MCP server declarations contributed by the active plugins, activation
   * order then registration order (register-time `add_mcp_server` calls
   * before the module's exported `mcpServers`). Collected with or without a
   * workspace; feed it to `mergeMcpConfig` (`src/mcp.ts`) before
   * `loadMcpTools`.
   */
  mcpServers: PluginMcpServer[];
  /** Per-plugin notes from this run's registration (deprecations, failures). */
  diagnostics: PluginDiagnosticEntry[];
}

/**
 * Owns the discovered plugins, their errors, and per-run tool building.
 * Created once at server startup; `reload()` re-imports everything (server
 * start and after every settings save carrying a `plugins` change).
 *
 * The optional `settings` list supplies per-plugin options
 * (`{path, options}` entries; plain strings keep the historical shape) used
 * for the load-time registration; `bindingsFor` re-resolves them per run.
 *
 * The constructor stays synchronous and leaves the manager empty: ESM
 * `import()` is async, so the eager load Python does in `__init__` lives in
 * `create()` (or an explicit first `reload()`). Concurrent `reload()` calls
 * serialize on an internal chain — a settings save can never interleave with
 * the startup load.
 */
export class PluginManager {
  readonly pluginsDir: string;
  /** Per-plugin settings: bare names (old shape) or `{path, options}`. */
  settings: PluginSetting[];
  plugins = new Map<string, LoadedPlugin>();
  errors: PluginErrorEntry[] = [];
  /** Load-time notes (deprecations, rejected options) across plugins. */
  diagnostics: PluginDiagnosticEntry[] = [];
  private loadCount = 0;
  private reloadTail: Promise<void> = Promise.resolve();

  constructor(
    pluginsDir: string = defaultPluginsDir(),
    settings: readonly PluginSetting[] = [],
  ) {
    this.pluginsDir = pluginsDir;
    this.settings = [...settings];
  }

  /** Construct + load — the async equivalent of Python's eager `__init__`. */
  static async create(
    pluginsDir: string = defaultPluginsDir(),
    settings: readonly PluginSetting[] = [],
  ): Promise<PluginManager> {
    const manager = new PluginManager(pluginsDir, settings);
    await manager.reload();
    return manager;
  }

  /** Replace the settings used by the next `reload()` / per-run binding. */
  setSettings(settings: readonly PluginSetting[]): void {
    this.settings = [...settings];
  }

  /** (Re)import every plugin. Broken plugins are logged and skipped. */
  reload(): Promise<void> {
    const run = this.reloadTail.then(() => this.doReload());
    this.reloadTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async doReload(): Promise<void> {
    this.loadCount += 1;
    const { plugins, errors, diagnostics } = await loadPlugins(
      this.pluginsDir,
      this.loadCount,
      this.settings,
    );
    this.plugins = plugins;
    this.errors = errors;
    this.diagnostics = diagnostics;
    for (const entry of this.errors) {
      console.warn(`[two-brothers] plugin "${entry.plugin}" unavailable: ${entry.error}`);
    }
  }

  /**
   * The `GET /api/plugins` payload (names and descriptions only).
   *
   * `roles` is the historical shared view and stays byte-compatible with the
   * shipped API: a plugin with at least one tool reports `["shared"]`, a
   * plugin that registered nothing reports `[]`. Reporting real per-tool
   * scopes here is an integration-lane change (the scopes themselves live on
   * `LoadedPlugin.tools[*].scope` and in `bindingsFor`'s buckets).
   */
  describe(): {
    plugins: Array<{ name: string; description: string; roles: string[] }>;
    errors: PluginErrorEntry[];
  } {
    const items: Array<{ name: string; description: string; roles: string[] }> = [];
    for (const name of [...this.plugins.keys()].sort()) {
      const loaded = this.plugins.get(name) as LoadedPlugin;
      const roles = loaded.tools.length > 0 ? ["shared"] : [];
      items.push({ name, description: loaded.description, roles });
    }
    return { plugins: items, errors: [...this.errors] };
  }

  /**
   * Harness tools of the active plugins, bound to this run's workspace.
   *
   * Every tool is returned, whatever scope it declared — the `toolScopes`
   * registry decides placement. `bindingsFor` additionally buckets by
   * `effectiveToolScope` and collects hooks, which is what a scope-aware
   * caller should use.
   *
   * `register` runs again against a fresh per-run context (import happened
   * once at load), so the handlers close over exactly the workspace — and
   * its PermissionManager — of the run invoking them. Fail-soft: a plugin
   * failing re-registration is logged and skipped for that run only. Returns
   * `[]` without a workspace (plugin tools are only offered to
   * workspace-bound runs), like Python.
   */
  async toolsFor(
    activeNames: readonly PluginSetting[],
    workspace: Workspace | null,
  ): Promise<Tool[]> {
    return (await this.bindingsFor(activeNames, workspace)).tools;
  }

  /**
   * One run's full plugin contribution: tools (flat and scope-bucketed),
   * hooks, MCP server declarations, and per-run diagnostics. This is the
   * single binding pass the `toolScopes` wiring should call; `toolsFor` is a
   * thin compatibility wrapper.
   *
   * Hooks are still collected without a workspace (they may be session-level),
   * but tools are only built for workspace-bound runs, as before.
   */
  async bindingsFor(
    active: readonly PluginSetting[],
    workspace: Workspace | null,
  ): Promise<PluginBindings> {
    const bindings: PluginBindings = {
      tools: [],
      toolsByScope: { shared: [], senior: [], junior: [] },
      hooks: createHookRegistry(),
      mcpServers: [],
      diagnostics: [],
    };
    // per-run contexts that registered successfully, for the MCP collection
    const contexts: PluginContext[] = [];
    let builtinHere = new Set<string>(BUILTIN_TOOL_NAMES);
    if (workspace !== null) {
      try {
        builtinHere = new Set(workspace.asTools().map((tool) => tool.name));
      } catch {
        // defensive; the static set still guards — built-ins always win
      }
    }
    const settingsOptions = optionsByName(this.settings);
    for (const entry of normalizePluginSettings(active)) {
      const loaded = this.plugins.get(entry.path) ?? this.plugins.get(pluginNameOf(entry.path));
      if (loaded === undefined) continue;
      const hasEntryOptions = Object.keys(entry.options).length > 0;
      const rawOptions = hasEntryOptions
        ? entry.options
        : (settingsOptions.get(loaded.name) ?? loaded.options);
      const resolved = resolvePluginOptions(loaded.module, rawOptions);
      const ctx = new PluginContext(loaded.name, workspace, resolved.options);
      ctx.diagnostics.push(...resolved.diagnostics);
      try {
        const register = loaded.module.register;
        if (typeof register !== "function") throw new PluginError("register(ctx) vanished");
        await register(ctx);
      } catch (exc) {
        const message = `registration failed for a run: ${formatError(exc)}`;
        console.warn(`[two-brothers] plugin "${loaded.name}" ${message}`);
        bindings.diagnostics.push({ plugin: loaded.name, message });
        continue;
      }
      // Both MCP paths feed one registry: `register`'s add_mcp_server calls
      // came first, then the module's optional exported `mcpServers` object.
      registerManifestMcpServers(ctx, loaded.module);
      contexts.push(ctx);
      for (const message of ctx.diagnostics) {
        bindings.diagnostics.push({ plugin: loaded.name, message });
      }
      for (const registration of ctx._hooks) {
        registerHook(bindings.hooks, {
          ...registration,
          onError: (message) => bindings.diagnostics.push({ plugin: loaded.name, message }),
        });
      }
      if (workspace === null) continue;
      for (const tool of ctx._tools) {
        if (builtinHere.has(tool.name)) {
          console.warn(
            `[two-brothers] plugin "${loaded.name}" tool "${tool.name}" collides with a ` +
              "built-in tool; rejected",
          );
          continue;
        }
        const harnessTool = asHarnessTool(tool);
        bindings.tools.push(harnessTool);
        bindings.toolsByScope[effectiveToolScope(tool)].push(harnessTool);
      }
    }
    bindings.mcpServers = collectPluginMcpServers(contexts);
    return bindings;
  }
}
