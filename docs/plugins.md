# Plugin system

Status: implemented in the **TypeScript package** —
`packages/harness/src/plugins.ts` (module 4 of the port), with tests in
`packages/harness/tests/plugins.test.ts` (v1 surface),
`packages/harness/tests/plugincore.test.ts` (scopes, hooks, validation,
options) and `packages/harness/tests/integration.test.ts` (wiring into the
cooperative run). This is where new plugin work lands. The original prototype's
Python implementation was removed from the repository on 2026-11-04 (it lives
in git history); its plugin contract is recorded in the divergences section
below. The repo example is `plugins/notes.mts`; the loader does not read `.py`
files.

## What a plugin is

A plugin is a single ES module dropped into a `plugins/` directory (repo
root by default) that **registers tools, lifecycle hooks
and MCP servers** the brothers share. A tool is a typed function invoked
through the same bounded execution path as the built-in coding tools
(workspace confinement, permission broker, approval flow, runtime-event
history).

Plugins are **local and trusted-by-operator**: dropping a file into
`plugins/` is an explicit act by the machine's user. They run in-process
with the harness's privileges — the same trust model as any operator-installed
local tooling. Do not load plugins from network locations or other users'
directories.

## Module contract (v2)

A plugin module exports a top-level `register` function, sync or async:

```ts
export function register(ctx: PluginContext): void { ... }
```

`PluginContext` (exported by `src/plugins.ts`) offers:

- `ctx.add_tool(name, handler, options?)` — register one tool. The options
  form is:
  - `description` — model-facing description (`""` keeps the default).
  - `parameters` — the tool's argument schema (the JSON-Schema subset from
    `src/toolschema.ts`). Declaring it also **turns on dispatch-time
    validation**: a model-supplied argument object that fails the schema
    never reaches the handler and becomes a
    `plugin tool error: invalid arguments: args.code: expected string, got number`
    result, so the model can repair the call.
  - `scope` — `"shared"` (default), `"senior"` or `"junior"`.
  - `timeoutMs` — cooperative deadline around the handler.
- `handler(args, signal?)` receives the model's arguments as one object and
  the run's `AbortSignal` as an optional second argument (aborted when the
  operator cancels the turn) and returns the tool result — a string, or any
  JSON-serializable value (objects let the graph surface a structured status
  such as `"denied"`); a thrown exception becomes a failed tool result, never
  a crashed run.
- The legacy positional form `add_tool(name, handler, description?,
  paramsSchema?, role?)` still loads for plugin-source compatibility. Its
  `role` is validated and recorded but **does not scope assignment**
  (see "Scopes"), with a deprecation note in `ctx.diagnostics`; the
  `paramsSchema` shorthand (`name -> type-name`) stays unvalidated because
  it is lossy by design.
- `ctx.on_hook(name, handler)` — register a lifecycle hook (see "Hooks").
- `ctx.add_mcp_server(name, config)` — contribute an MCP server
  declaration for this plugin (see "Contributed MCP servers").
- `ctx.options` — the validated per-plugin settings object for this
  registration (`{}` when none were configured).
- `ctx.diagnostics` — non-fatal notes (deprecations, rejected options,
  failed hooks). Readable by the plugin; also surfaced by the manager.
- `ctx.log(message)` — write a one-line note into the server log
  (`[<plugin>] <message>`).
- `ctx.set_description(text)` — the plugin-level description shown by
  `GET /api/plugins`; an exported `description` string or the manifest's
  `description` is the fallback (JS modules have no docstrings).
- Confined workspace helpers bound to the *current run's* workspace:
  `ctx.workspace_read/list/search/write/edit/delete/shell`. They are thin
  bridges over `Workspace` — same confinement, same `PermissionManager`
  approval broker. `ctx.workspace_shell(command, timeout?, signal?)` forwards
  the handler's abort signal, so a cancelled turn cancels the shell. They
  raise `PluginError` when the run has no workspace (plugin tools are only
  offered to workspace-bound runs).

Optional module exports:

- `configSchema` — a JSON-Schema object (same subset) validating the
  plugin's settings. A rejected options object produces a diagnostic and
  the plugin still loads with `options = {}`. No schema = free-form
  options.
- `manifest` — `{name, version, description, …}`, recorded verbatim and
  never executed; `description` is the last description fallback.

Registration mechanics: the module is imported once per load (server start,
a settings save carrying a `plugins` change, and CLI `run`/`chat`/`serve`
start; a reload re-imports with a `?v=N` cache-bust so changed files are
picked up). For each run, the loader re-runs `register` against a fresh
per-run context bound to that run's workspace, so parallel runs never share
per-run context state and every file access goes through the run's own
approval broker. (The module *object* is shared: module-level globals and
two concurrent `register` calls see each other — keep plugin state in the
ctx closure, not in module globals.)

Loading rules:

- File name `[a-z0-9_]+` with a `.ts`, `.mts`, or `.mjs` extension (others
  ignored, including `.js`/`.cjs`, whose module kind is ambiguous without a
  package.json `type`).
- `.ts` plugin files are reparsed as ESM by Node under a `type`-less
  package.json (with a one-line warning) — prefer `.mts`, or give the
  plugins directory a `{"type": "module"}` package.json. The repo example
  uses `plugins/notes.mts`.
- **Fail-soft**: a plugin that throws on import or registration is skipped
  with its error recorded in the server log and listed in
  `GET /api/plugins` `errors[]`; other plugins and the built-in tools keep
  working. A plugin failing re-registration during a run is logged and
  skipped for that run only. In the CLI a load failure never blocks a run,
  and load diagnostics print only under `--verbose`.
- A plugin whose tool name collides with a built-in workspace tool fails
  registration (built-ins win — the plugin is skipped and listed in
  `errors[]`); the check also runs at run time against the live workspace
  tool set, where the colliding tool is skipped.
- No new runtime dependencies: a plugin may use only Node's standard library
  **and** the packages the harness already pins (e.g. `zod`). There is no
  plugin-level dependency installation.

## Scopes: shared by default, per-tool opt-in

**Adding a plugin makes it work for both agents unless a tool says
otherwise** (owner decision 2026-11-03). Settings keep one shared
active-plugin list:

```json
"plugins": ["notes", "calendar"]
```

`{ path: "notes", options: { ... } }` entries are the options-carrying form
(see "Per-plugin options").

- **Default / legacy tools → `shared`.** A tool registered without
  `scope`, and a tool registered with the legacy positional `role`, joins
  the `shared` scope of the `toolScopes` registry
  (`packages/harness/src/harness.ts`): the Junior's full tool belt and the
  Senior's bounded verification slice both receive it.
  `effectiveToolScope(tool)` is the single authority — it returns
  `"shared"` for `scopeSource === "legacy-role"` and otherwise
  `tool.scope ?? "shared"`.
- **Explicit `{ scope: "senior" }`** routes a tool to the Senior's verify
  slice only (verification aids the junior must not see).
- **Explicit `{ scope: "junior" }`** routes a tool to the Junior's
  delegation belt only (destructive work reserved for the delegated
  worker).
- `PluginManager.bindingsFor(activeNames, workspace)` returns
  `{tools, toolsByScope: {shared, senior, junior}, hooks, diagnostics}`;
  the server merges the buckets into the run's `toolScopes` and the CLI
  does the same through `mergePluginScopes`. `toolsFor()` remains the flat
  compatibility view (every tool, regardless of scope).
- **Senior plugins and mutation.** The Senior's built-in workspace tools are
  still filtered to the read-only verify slice (`SENIOR_VERIFY_TOOL_NAMES`),
  but scoped/shared *plugin* tools join unfiltered — an operator-installed
  plugin tool may mutate from either role; it still runs through the
  `PermissionManager` broker, so the operator approves every write
  (deny-on-stop applies).

## Hooks

`ctx.on_hook(name, handler)` registers one handler; `HOOK_NAMES` is the
complete set:

| Hook | Event | May change |
|---|---|---|
| `session_start` | `{session_id, workspace}` | observe only |
| `session_end` | `{session_id, status}` (`completed`/`cancelled`/`failed`) | observe only |
| `before_tool_call` | `{role, tool, args}` | `args` in place; `deny` / `return {deny}` veto |
| `after_tool_call` | `{role, tool, args, result}` | `result` in place |

Semantics (`dispatchHook`):

- Handlers run in registration order (plugin activation order first).
- **Fail-soft**: a throwing/rejecting handler is recorded on its plugin's
  diagnostics (and in the dispatch result's `errors`) and never propagates.
- **Deny is monotonic**: once a handler denies, a later handler cannot
  clear it.
- A `before_tool_call` deny emits `tool_completed` with status `blocked`
  and the denial text is returned as the tool result, so the model sees the
  policy reason in its next turn. `after_tool_call` runs before the result
  is compacted and emitted, so a rewrite is what the transcript and the
  evidence lines carry.

`HarnessOptions.hooks` is the wiring seam; the server passes every run's
binding registry and the CLI passes its loaded registry.

## Contributed MCP servers

A plugin can bring its own MCP server — the same declaration `--mcp-config`
accepts, in either of two equivalent forms:

```ts
import type { PluginContext } from "@two-brothers/harness";

export function register(ctx: PluginContext): void {
  // imperative: recorded while the plugin loads
  ctx.add_mcp_server("calendar", {
    command: "npx",
    args: ["-y", "@example/calendar-mcp"],
    role: "shared", // "shared" | "senior" | "junior" (default "junior")
    timeoutMs: 30_000,
  });
}

// declarative alternative, ingested after register() ran
export const mcpServers = {
  notes: {
    url: "https://example.com/mcp",
    headers: { Authorization: "Bearer ${NOTES_TOKEN}" },
  },
};
```

- A name must match `[a-z0-9_-]+` and the config is exactly one
  `mcpServers` entry: stdio `command`/`args`/`env`/`cwd`, or streamable-HTTP
  `url`/`headers`, plus the optional `role` and `timeoutMs`. `${VAR}` in
  `env`/`headers` expands from the environment at connect time.
- Bad names and malformed configs become diagnostics, never throws; the rest
  of the plugin keeps loading. `loadPlugins` ingests the exported object
  after `register`, so register-time calls come first.
- Both forms feed `PluginBindings.mcpServers`; each run folds them under the
  configured `--mcp-config` base with `mergeMcpConfig`: a configured server
  wins a name collision, then the first plugin to contribute the name, and
  every collision is reported (stderr in the CLI, the server log in `serve`).
- Wiring: `run`/`chat` merge the declarations per run; `serve` does the same
  (the CLI forwards `--mcp-config` to the server) and closes the MCP client
  after the run. The merged servers' tools join the `shared`/`senior`/
  `junior` scopes, so namespacing (`mcp__<server>__<tool>`), the 20 KiB
  result clip and the per-call timeout apply unchanged. A missing configured
  file warns and keeps the plugin-contributed servers.

## Per-plugin options

Settings entries may carry per-plugin settings:

```json
"plugins": [
  "notes",
  { "path": "calendar", "options": { "timezone": "Europe/Berlin" } }
]
```

- Options are validated against the plugin's optional exported
  `configSchema`; a rejected object loads as `{}` plus one diagnostic.
- `PluginManager.setSettings(...)` + `reload()` apply new load-time options.
  The server's settings save hands each entry to the manager before the
  reload; per-run `bindingsFor` re-resolves them (an explicit entry's
  options win over the manager's).
- The store round-trips both shapes (`PluginSelection = Array<string |
  {path, options}>`); legacy per-role plugin sections merge into the same
  list on read.

## Persistence, env and API

- **Persistence.** The list lives in `sessions/settings.json` as the
  top-level `plugins` array (same store as the role settings; not
  encrypted — plugin names and options are not secrets). A legacy per-role
  section (`"plugins": {"senior": [...], "junior": [...]}`) or legacy
  top-level `plugins_senior` / `plugins_junior` keys are merged into the
  shared list on read — deduplicated, senior names before junior names —
  and the old keys are dropped on the next save.
  `SettingsStore.readPlugins()` returns the merged selection; `write()`
  accepts either shape.
- **UI.** The Settings dialog has one shared plugins multi-select,
  populated from `GET /api/plugins` (discovered plugin names +
  descriptions).
- **Env aliases (deprecated).** `TWO_BROTHERS_PLUGINS_SENIOR` /
  `TWO_BROTHERS_PLUGINS_JUNIOR` (comma-separated) are still accepted as
  additive aliases merged into the shared set; like the other
  `TWO_BROTHERS_*` env values they are an overlay and are never persisted.
  The plugin **directory** is `--plugins-dir`, else
  `TWO_BROTHERS_PLUGINS_DIR`, else `<cwd>/plugins` for the CLI; the server
  keeps its module-relative default unless one of those is set.
- **API.**
  - `GET /api/plugins` → `{plugins: [{name, description, roles}], errors:
    [{plugin, error}]}`. `roles` stays `["shared"]` for any tool-carrying
    plugin (`[]` when it registered none). When there are notes, an
    additive `diagnostics: string[]` field carries load-time notes plus
    the last run's binding notes (`plugin: message`); it is omitted when
    empty so the shipped fields stay byte-compatible.
  - `GET /api/settings` and the `PUT` response carry the effective shared
    selection under the top-level `plugins` key. `PUT /api/settings`
    accepts the shared list (with `{path, options}` entries) and a legacy
    per-role object (merged); a save carrying `plugins` updates the
    manager settings and reloads it.
- **CLI parity.** `run`, `chat`, `tui` and `serve` load plugins too. Hooks
  apply to every run; plugin **tools** are only offered to workspace-bound
  runs, so `serve` runs over a workspace and a `tui --workspace <dir>` run get
  them, while a plain CLI run (no workspace concept) gets hooks/skills only.

## Confinement and permissions

- Plugin tools operate inside the same `Workspace` confinement as the coding
  tools: any file access must go through the workspace root, and writes /
  shell-like side effects that go through the workspace bridge
  (`ctx.workspace_*`) pass through the `PermissionManager` approval broker
  exactly like built-in tools (operator approval required by default, deny on
  stop, sensitive paths refused). The effective
  [approval mode](cli-reference.md#approval-modes) applies to those bridged
  plugin actions too — `readonly` denies their mutations without asking,
  `edits` auto-allows writes/edits, and `allow-all` runs everything (with its
  visible warning); a mode never bypasses workspace confinement or the
  sensitive-path refusal, and a plugin can neither read nor change the policy.
  A plugin that performs side effects outside the workspace bridge (its own
  network calls, arbitrary paths) is out of scope — plugins are workspace
  tools, not agents.

## Example

A plugin with a scoped tool, validated args, an option, and a hook:

```ts
import type { PluginContext, JsonSchemaSubset } from "@two-brothers/harness";

export const description = "Note keeping with a review audit trail";

export const configSchema: JsonSchemaSubset = {
  type: "object",
  properties: { maxChars: { type: "integer", minimum: 1 } },
  additionalProperties: false,
};

export function register(ctx: PluginContext): void {
  const maxChars = Number(ctx.options.maxChars ?? 500);

  ctx.add_tool(
    "write_note",
    async (args) => {
      const text = String(args.text).slice(0, maxChars);
      const result = await ctx.workspace_write(String(args.filename ?? "notes.txt"), text);
      return result.status === "ok" ? `note saved` : result;
    },
    {
      description: "Write (overwrite) a short note file inside the workspace",
      parameters: {
        type: "object",
        properties: { text: { type: "string" }, filename: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
      scope: "junior",
      timeoutMs: 10_000,
    },
  );

  // senior-only read-only audit helper
  ctx.add_tool(
    "audit_notes",
    () => ctx.workspace_read("notes.txt"),
    { description: "Audit the junior's notes", scope: "senior" },
  );

  ctx.on_hook("before_tool_call", (event) => {
    if (event.tool === "workspace_run_shell" && /\brm\b/.test(String(event.args.command ?? ""))) {
      return { deny: "destructive shell commands are disabled by this plugin" };
    }
  });
}
```

The repo's `plugins/notes.mts` remains the minimal v1-style example (legacy
positional call shape, shared scope).

## Divergences from the original prototype's plugin contract

These are deliberate, documented differences from the removed prototype's
plugin module; the wire/API-visible behavior is unchanged.

- Plugin files are **ES modules** (`register` may be sync or async), not
  Python modules; `PluginManager.bindingsFor`/`toolsFor` are async and take
  `(activeNames, workspace)` because dynamic `import()` is async. Scope
  routing, hooks, argument validation and per-plugin options are TS-first
  additions; the prototype kept its per-role lists.
- `params_schema` **is** the argument spec: there is no runtime signature
  introspection of the model adapter, so a full JSON Schema is used
  directly and the shorthand is translated to typed properties. Only the
  options-form `parameters` schema is validated at dispatch time.
- No module-docstring fallback for the description — use
  `ctx.set_description(...)`, export a `description` string, or set
  `manifest.description`.
- Method names keep the prototype's `snake_case` contract verbatim (same as
  the `Workspace` tool methods), so a plugin reads identically to the original.

## Out of scope (today)

Remote/marketplace plugins, dependency installation, per-plugin permission
grants, UI for plugin I/O beyond tool calls in the chat. Plugin-contributed
MCP servers are shipped (see "Contributed MCP servers"; slash commands live
in `packages/harness/src/commands.ts`).