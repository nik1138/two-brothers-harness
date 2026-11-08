# AGENTS.md — `plugins/`

Local map for the example plugin tree. Root rules: `../AGENTS.md`; the plugin
contract is documented in `../docs/plugins.md`.

## What lives here

- `notes.mts` — the shipped example plugin: `register(ctx)` registers one
  junior `write_note` tool that writes through the run workspace.
- Local/untracked plugin modules may live here; the default CLI plugin root is
  `<cwd>/plugins`.

## Boundaries

- Plugins are loaded modules, not product sources. A plugin must work through
  `PluginContext` (`add_tool`, `add_mcp_server`, `on_hook`, workspace helpers)
  and must not import package internals.
- Do not add npm dependencies for a plugin; the package runtime dependency list
  is curated in `packages/harness`.
- File names are `[a-z0-9_]+` with `.ts`, `.mts`, or `.mjs` (ES modules).
  `notes.mts` stays the committed example.

## Invariants and hazards

- Tools are **shared by default**. Pass `{ scope: "senior" | "junior" }` (or
  the legacy positional `role`, which still loads but stays shared) to route a
  tool to one belt.
- Plugin tools need a workspace-bound run (`serve` with a workspace); `run`
  and `chat` get hooks and diagnostics but no plugin tools. A load failure is
  fail-soft and only prints under `--verbose`.
- A broken hook lands on the plugin's diagnostics and never breaks a run;
  don't rely on a hook throwing to stop the harness (use a deny).

## Commands

```powershell
cd packages/harness
npm run build
node dist/cli.js run "..." --provider mock --plugins-dir ../../plugins
node dist/cli.js serve --plugins-dir ../../plugins
node dist/cli.js run "..." --provider mock --verbose   # load diagnostics
```

Workflow: `../AGENTS.md` ("Subagent Lanes").
