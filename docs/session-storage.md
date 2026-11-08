# Session storage

How `@two-brothers/harness` keeps durable sessions. The public session name
(`<name>.jsonl`) and the envelope bytes inside are unchanged by the layout;
only the paths around them differ.

## Layouts

### Flat (legacy default)

Until a store is migrated, sessions keep the original layout:

```text
<sessions-dir>/
  <name>.jsonl
  <stem>.meta.json
  runtime/<name>.events.jsonl
  settings.json
  workspaces.json
  undo/
```

### Directories (migrated)

`sessions migrate` writes `<sessions-dir>/.layout.json`
(`{"version":1,"layout":"dirs"}`) and moves every session into a
project/session directory:

```text
<sessions-dir>/
  .layout.json
  <project>/<stem>/
    session.jsonl
    meta.json          # title, workspace_id, parent, timestamps
    events.jsonl       # runtime/tool/approval events
  settings.json
  workspaces.json
  undo/
```

`<project>` is a readable slug plus eight hex characters of the normalized
workspace path, e.g. `two-brothers-harness-1a2b3c4d`. Sessions with no known
workspace use the reserved `_global` project. The hash keeps two same-named
folders distinct; the slug keeps the directory navigable.

Settings, the workspace registry and the run-scoped undo store intentionally
stay at the sessions root in both layouts.

## Compatibility

- Readers always accept both layouts: `two-brothers sessions` (list/show/
  search/export/fork/rewind/undo), the web API (`/api/sessions`, search,
  export, fork, rewind, undo), the TUI session picker and `loadSessionDocs`.
- A directory session wins over a leftover flat file with the same name.
- A **read** never materializes a session directory: an unknown name is a 404
  and leaves the store untouched. Only run/session creation and migration write
  directories.
- Directory sessions keep their public name in the TUI plan/reasoning sidecars
  and in exports; the on-disk file is `session.jsonl`, but the UI never
  surfaces that literal name.
- New sessions follow `.layout.json`. A store with no marker keeps writing the
  flat layout, so an upgrade alone never rewrites existing paths.
- API payloads and run records still expose the same `<name>.jsonl` name; the
  web client needs no change.

## Migration

```powershell
two-brothers sessions migrate [--sessions-dir <dir>] [--dry-run] [--force] [--json]
```

- **Quiescent.** Migration takes the store's single-writer lock. Stop `serve`
  and the TUI first; while either holds the lock the command refuses. `--force`
  is the documented unsafe override for a known-stale store.
- **Copy first.** Every session is written to a temporary directory under the
  target project, then published with a rename; the flat `.jsonl`, metadata
  sidecar and `runtime/*.events.jsonl` are removed only after the target is in
  place.
- **Workspace grouping.** A metadata `workspace_id` is resolved through
  `workspaces.json`; unlinked sessions go to `_global`.
- **Idempotent.** A target with identical session bytes, metadata and runtime
  events is adopted (missing sidecars are filled in) and the flat source is
  removed. Divergent session bytes or sidecars are a conflict: the source is
  kept and the command exits 1.
- **Marker last.** `.layout.json` is written only when the pass has no
  conflicts or errors, so a failed migration leaves the store in flat mode.
- `--dry-run` prints the same plan without writing anything.
- A missing `--sessions-dir` is an error; the command never invents a store.

Back up the sessions directory before the first real migration; the command
deletes the flat copies after a successful move. There is no automatic
compression or versioned-format migration yet — a session's `session.jsonl`
is the same newline-delimited envelope log a flat `<name>.jsonl` contained.
An **older release cannot read a migrated store** (it only knows flat files);
keep the backup or move the sessions back before downgrading.

## Operational checks

- `two-brothers doctor --sessions-dir <dir>` still checks writability.
- `two-brothers sessions --sessions-dir <dir>` lists both layouts.
- `serve`/TUI hold `<sessions-dir>/.writer.json` while running; migration
  refuses while it names a live pid. A crash leaves a stale lock that the next
  writer reclaims automatically; `--force` is the explicit unsafe override.
- After migration, `<project>/<stem>/session.jsonl` is the durable transcript;
  `meta.json` carries the title/workspace link and `events.jsonl` the runtime
  evidence (tool calls, approvals, reasoning, plan snapshots).

See also: [`docs/cli-reference.md`](cli-reference.md#sessions) and the
`sessionlayout` module (`packages/harness/src/sessionlayout.ts`). Hermetic
coverage: `tests/sessionlayout.test.ts` (layout, migration, sidecars, fork),
`tests/serverlayout.test.ts` (server create/run/list/fork/delete/restart) and
`tests/sessionsmigrate.test.ts` (CLI migrate).
