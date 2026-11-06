# CLI Reference

The command set covers the TypeScript package — the implementation. Examples
below use `node dist/cli.js <command>` from `packages/harness/` (after
`npm run build`); a global install exposes the same commands as
`two-brothers <command>`. The zero-dependency reference in `typescript/` runs
the same core commands as `node src/cli.ts <command>`. `serve` is provided by
the package: a plain `node:http` server exposing the HTTP + SSE API.

Global invocations: `two-brothers --version` (or `-v`) prints the package
version; a bare `two-brothers` with no arguments opens the full-screen TUI on
an interactive terminal and prints the usage screen when stdin is piped.

## Commands

### `run "<task>"`

A single invocation: task → cooperation → `decision`.

```powershell
node dist/cli.js run "Plan a migration from Redis to Valkey"
```

If the task contains spaces, pass it as a single string (quote it in PowerShell).

The task can also come from stdin or a file:

```powershell
Get-Content task.txt | node dist/cli.js run - --provider mock   # task from stdin (max 1 MiB)
node dist/cli.js run --task-file task.txt --provider mock        # task from a file
```

`run -` reads the task from stdin (blank input is a usage error, exit 2; more
than 1 MiB is rejected). `--task-file <path>` reads it from a file (a missing,
unreadable or blank file exits 2). A positional task and `--task-file` are
mutually exclusive. The bare `two-brothers` invocation with piped stdin still
prints the usage screen — only `run -` opts into reading stdin as a task, and
`chat`/`tui` piped behavior is unchanged.

`--dry-run` resolves the whole run — configuration (with per-field sources),
providers, session file, plugin/skills/commands roots and MCP config presence,
compaction settings and limits — prints the plan, and exits 0 **without calling
a model and without writing a session**. `run --dry-run --json` prints the plan
as one JSON object; `--dry-run` with `--stream` is a usage error (exit 2).
`chat --dry-run` prints the REPL plan and exits without starting the REPL.

```powershell
node dist/cli.js run "Plan a migration" --provider mock --dry-run
node dist/cli.js run - --provider mock --dry-run --json < task.txt
```

### `chat`

REPL: several tasks in one session. Empty line, `exit`, `quit`, `q`, `/exit`,
`/quit` — exit. Before the first prompt the REPL prints the resolved
provider/model/base URL per role.

```powershell
node dist/cli.js chat --provider mock
```

#### Slash commands (TS package)

The REPL turns `/name args` into a prompt from a markdown command file before
submitting it. Commands are flat `<root>/<name>.md` files whose frontmatter
carries `description`, an optional `argument-hint`, and an optional `mode`
(`consult`/`work` — it overrides the run mode for that turn):

```markdown
---
description: Summarize a document in five bullets
argument-hint: <path>
---
Summarize the file at $1 in five bullets. Extra context: $ARGUMENTS
```

Roots, in priority order: repeatable `--commands-dir`, then
`TWO_BROTHERS_COMMANDS_DIR` (one or more roots separated by the OS path-list
separator), then `<cwd>/commands`, then `~/.two-brothers/commands`. Command
discovery happens once per REPL session, so a new file needs a new session.
`/commands` (and `/help`) lists every discovered command as
`name — description (argument-hint)`; an unknown `/name` prints
`unknown command: <name>` with a hint and is **not** submitted as a task.
`$ARGUMENTS` is the whole argument string, `$1`..`$9` are the whitespace-split
words, and `$$` is a literal `$`; expansion is literal text only (no shell,
no re-expansion). Diagnostics print under `--verbose`. The same metadata is
served at `GET /api/commands`.

#### Built-in REPL commands

The REPL also dispatches the first-party commands (see
[Built-in commands](#built-in-commands) for the shared catalogue); a
discovered `<name>.md` wins over a same-named built-in:

- **Prompt** — `/plan <objective>`, `/goal <objective>` and
  `/feedback [notes]` expand to a task and run as that turn, with the
  command's `consult` mode override. ASCII aliases work too (`/objective`,
  `/review`, `/bug`); a missing required argument prints
  `usage: /plan <objective>` and submits nothing.
- **Action** — performed by the REPL, never submitted: `/compact` (compact the
  in-memory context with the configured summarizer and REPL compaction
  budgets; with `--session-file` the rewritten session is persisted with
  dense `seq`, so `--resume` keeps working; prints `compacted: N → M
  envelopes` or `nothing to compact`), `/export [path]` (Markdown export,
  default `<session stem>.md` in the cwd), `/status` (session/mode/context
  and resolved roles), `/permission` (the fail-closed approval policy and the
  configured tool scopes), `/mode [consult|work]` (show or switch the REPL
  mode for following turns), and `/help` / `/commands` (built-ins grouped
  prompt/action with hints and aliases, then the discovered templates).
  `/new` is refused with a pointer to starting a new `chat` (the line REPL
  cannot replace a session in place). A failed `/compact` or `/export` prints
  `compact failed: …` / `export failed: …` and keeps the context intact.
- `/config` still prints the resolved per-role endpoints. The reference
  Chinese aliases resolve in the catalogue, the metadata API and the pickers,
  but are not **typeable** on any surface: `matchCommand`'s ASCII name rule
  (shared by the REPL, the TUI and `POST /api/runs`) treats `/目标 …` as an
  ordinary slash-prefixed task. The web and the TUI now detect that case and
  answer with a notice naming the canonical spelling instead of sending it.

### `tui [initial task]`

Full-screen interactive chat in the terminal's alternate screen, over the
same harness as `chat` (mock or real providers). A bare `two-brothers` in an
interactive terminal opens this TUI. Needs a TTY: a piped stdin exits `2`
with a clean message and no escape bytes (use `chat` for scripts).

The screen is a block transcript with textual role labels (`YOU`, `SENIOR`,
`JUNIOR`, `TOOL`, `ERR`/`WARN`/`INFO`), a contained multiline composer
(grapheme-aware cursor, prompt history, bracketed paste — a pasted newline
never submits), and a two-line status bar with mode, models, session, cwd,
context/tokens/cache/cost and key hints. Markdown bodies render headings,
lists, quotes, fenced code, diffs, and inline bold/italic/code/link emphasis
with theme colors and attributes; under `NO_COLOR` (or a color-free theme)
the layout and text are byte-identical and only the styling disappears. The
screen repaints on terminal resize and restores the terminal on every exit
path. Turns run without
blocking input; Escape/Ctrl+C under a safe precedence (overlay close → cancel
the running turn → clear the composer → confirm quit). `Ctrl+P` opens the
command palette, `?` a scrollable help overlay (only while the composer is
empty; `F1` always opens it), both generated from the same keymap registry as
`tui --help`. `Ctrl+F` (or `/find [query]`) opens find-in-transcript: a live
case-insensitive filter over the whole transcript with `current/total`,
`Enter`/`Down` next, `Shift+Enter`/`Up` previous (wrap), the active match
marked and scrolled into view, and `Esc` restoring the draft and scroll
position. Typing `/` at the start of the composer (or a line start) opens an
inline command picker: the TUI's own commands first, then built-in prompts and
built-in actions (rows badged `builtin`/`action`, highlighted-row
`usage — description` footer), then discovered templates with a `template`
badge; typing `@` at a token boundary opens a skill picker (shared skills are
selectable, role-scoped rows are shown disabled). `Enter`/`Tab` insert or run
the highlighted row, `Shift+Tab`/`Esc` close without touching the draft, and a
held key cannot repeat a submit.
When a provider streams reasoning, a bounded dim `THINKING` block appears
above the streaming response for that call and disappears when the completed
reply arrives — reasoning is observational and never persisted or treated as
part of the reply. File mentions are web-only (terminal runs have no
workspace). Slash input: `/mode consult|work`, `/models`,
`/sessions`, `/theme dark|light|system`, `/settings`, `/retry`, `/help`,
`/commands`, `/exit`, plus discovered `<name>.md` templates (unknown names are
never submitted as tasks). The built-in prompts `/plan <objective>`,
`/goal <objective>` and `/feedback [notes]` expand and run that turn; the
built-in actions `/compact` (between turns — compacts through the configured
senior endpoint and rewrites the session file, the visible transcript is
unchanged), `/export [path]` (Markdown; in-memory sessions need a path),
`/status`, `/permission` (real policy facts; the TUI has no approval broker)
and `/new` (in-memory session; on-disk sessions are refused honestly) are
performed locally and never submitted as tasks — see
[Built-in commands](#built-in-commands). A native command always wins its own
name and a discovered template shadows a same-named built-in. `/models` and
`/sessions` refuse to change things while a turn runs, and model changes are
session-local. `--stream-tokens` renders token deltas in place while a turn
runs.

```powershell
node dist/cli.js tui --provider mock
node dist/cli.js tui "Plan a migration from Redis to Valkey" --provider mock
```

### Composer mentions and slash commands

The web composer and the TUI turn typed mentions and commands into run
context, and the server applies the same rules to `POST /api/runs` /
`POST /api/run` so any client can use them:

- **`/name args`** — if the leading token is a discovered command
  (`commands/<name>.md`, also `--commands-dir` / `TWO_BROTHERS_COMMANDS_DIR`
  roots), the template is expanded (`$ARGUMENTS`, `$1`..`$9`, `$$`) and the
  command's frontmatter `mode` overrides the run mode for that run; an
  unknown or path-like slash line (e.g. `/usr/bin/env …`) is submitted as a
  normal task.
- **`@skill:<name>`** — attaches the body of a discovered **shared** skill as
  a `<skill-loaded name="…">` context message before the task. Unknown names,
  role-scoped (`senior`/`junior`) skills and more than
  `MENTION_MAX_SKILLS` (3) are a 400.
- **`@<relative/path>` / `@./<path>`** — attaches a file from the run's
  workspace as a `<file path="…">` context message (bounded to
  `MENTION_MAX_FILE_CHARS` per file with a truncation marker, at most
  `MENTION_MAX_FILES` (5), total attached content ≤
  `MENTION_MAX_TOTAL_CHARS` (100 000) chars). Requires `workspace_id`;
  absolute paths, `..` escapes, sensitive files, binaries and missing files
  are a 400. Web root-level files serialize as `@./README.md` so they stay
  unambiguous.

Mention tokens stay in the task text (traceability); the attached blocks are
separate `message` envelopes persisted in the session JSONL before the task.
The TUI supports `/` and `@skill:` (no workspace, so file mentions stay
literal text). Discovered metadata is served at `GET /api/skills`,
`GET /api/commands` and `GET /api/workspaces/{id}/files` (never bodies).

#### Built-in commands

First-party commands ship with the product and work in the web composer, the
TUI `/` picker, the `chat` REPL and `POST /api/runs` alike. They come in two
kinds, and the distinction is honest on every surface:

- **Prompt commands** expand to a normal task and are submitted like a
  discovered template: `/plan <objective>` (agree a plan before changing
  anything), `/goal <objective>` (set the session goal and its success
  criteria) and `/feedback [notes]` (turn operator feedback on the last turn
  into follow-up work). These are built with `consult` cooperation mode and
  expand `$ARGUMENTS` exactly like a `<name>.md` template. A missing required
  argument is a usage error (`usage: /plan <objective>`), never an empty turn.
- **Action commands** are performed by the surface and are never submitted as
  a task: `/compact` (summarize older context in place), `/export [path]`
  (session as Markdown), `/permission` (approval policy and tool scopes),
  `/status` (run/context/session status), `/mode [consult|work]` (cooperation
  mode), `/new` (fresh session) and `/help` (commands and shortcuts). Web and
  TUI perform these locally; the `chat` REPL performs the ones that make
  sense in a line REPL (`/compact`, `/export`, `/status`, `/permission`,
  `/mode`, `/help`) and refuses the rest with an explanation. Submitting an
  action command as a run (`POST /api/runs` with `task: "/compact"`) is a 400
  that points at the surface action; use `POST /api/sessions/{name}/compact`
  where a client has no local compaction.

Names resolve case-insensitively, include English synonyms and the reference
Chinese spellings (`目标`, `计划`, `反馈`, `压缩`, `权限`, `导出`) as
searchable aliases in the pickers, are ordered by priority, and ship
canonically in `GET /api/commands`. Only ASCII spellings are typeable — the
shared slash parser's ASCII name rule governs the REPL, the TUI and
`POST /api/runs`, and the web/TUI answer a typed non-ASCII alias with a
canonical-spelling notice instead of sending it. A discovered `<name>.md`
template with the same name shadows the built-in (deepseek-harness's "exact
name wins" rule), so an operator can override `/plan` locally. The catalogue
is served, metadata only, at `GET /api/commands` (`baseCommands`).

### `sessions`

List the JSONL session files of a sessions directory (default `sessions`)
with readable titles derived from the first operator message, envelope counts
and the last-modified time. Output-only — it never touches the files.

```powershell
node dist/cli.js sessions [--sessions-dir sessions] [--limit N] [--json]
node dist/cli.js sessions show <name> [--limit N] [--json]
```

`sessions --json` prints one JSON array with one flat object per session, keys
in this order: `{name, title, envelopes, updated, error}` — `name` keeps the
`.jsonl` suffix, `updated` is local `YYYY-MM-DD HH:MM`, and `error` is `null`
or a message such as `corrupt line 3`. An empty or missing directory prints
`[]` and exits 0.

`sessions show <name>` prints the session summary (`session:`, `title:`,
`envelopes:`, `updated:`, an `error:` line only when the file has corrupt
lines) and one render line per protocol envelope
(`seq from -> to kind — preview`). The name resolves with or without the
`.jsonl` suffix. `sessions show <name> --json` prints one JSON object with the
same summary fields plus `events` (the envelope array):

```
{name, title, envelopes, updated, error, events}
```

`--limit N` caps the listed rows (`sessions`) or the envelopes printed/shown
(`show`, in both human and JSON output; `envelopes` stays the total). An
unknown session or a missing name is a usage error (exit 2); an unreadable
session file exits 1.

#### `sessions search <query>`

Full-text search across a sessions directory: session titles plus every
envelope's payload strings (operator tasks, proposals, reviews, decisions).
Matching is a case-insensitive literal substring; JSON keys and envelope
metadata are never matched, and whitespace is collapsed on both sides, so a
multi-line payload still matches a one-line query.

```powershell
node dist/cli.js sessions search "valkey migration"
node dist/cli.js sessions search "rollback" --json --limit 5 --sessions-dir sessions
```

Human output starts with `N matches in M sessions`, then one
`<session>  <field>  <snippet>` line per hit (`field` is `title`, `message` or
`decision`; the snippet is one bounded line centered on the match). `--json`
prints the exact result object:

```json
{"query": "rollback", "scanned_sessions": 4, "truncated": false,
 "hits": [{"session": "20261106-120000.jsonl", "title": "Plan a migration",
           "field": "message", "seq": 9, "role": "senior", "kind": "decision",
           "snippet": "…the rollback plan…", "ts": "2026-11-06T09:00:00Z"}]}
```

Sessions are read newest-first up to the scan caps (200 sessions, 2 000
envelopes each) and at most 3 hits are returned per session. `--limit N`
caps the total hits (1–100, default 20); `truncated: true` means a cap
dropped a real match. A missing directory searches nothing (`0 matches in 0
sessions`, exit 0); a query shorter than 2 characters is a usage error
(exit 2); corrupt session files are skipped, never fatal. No matches prints
`no matches` and exits 0.

#### `sessions export <name> [--format markdown|json] [--output <path>]`

Render one session for reading, sharing or archival. The default format is a
Markdown transcript: a header (`# <title>`, session name, workspace, updated
and exported timestamps, envelope count) followed by one
`## <seq>. <from> → <to> · <kind>` section per envelope with its timestamp and
a readable payload (message text verbatim; structured payloads as bullet
fields; nested values as JSON). Each payload is bounded to 20 000 characters
with an explicit truncation marker. `--format json` prints a stable pretty
object `{name, title, workspace_id, updated, exported_at, envelopes}` with the
envelopes verbatim.

```powershell
node dist/cli.js sessions export session --sessions-dir sessions           # Markdown to stdout
node dist/cli.js sessions export session --format json --output out.json   # write a file
```

The name resolves with or without the `.jsonl` suffix; the `--format` value is
case-insensitive. `--output <path>` writes the body to that file and prints
`wrote <abs path>` on stderr; `--output -` keeps stdout. A missing session or
an unwritable output path exits 1; an unknown format or a missing name is a
usage error (exit 2).

### `doctor`

Local, read-only diagnostics: one `[pass]` / `[warn]` / `[fail]` / `[skip]`
line per check, in this order — Node engine (the package's `>= 22.19` floor),
settings file (`<sessions-dir>/settings.json`), sessions-directory
writability, per-role provider configuration (kind, base URL, model, key
presence), the provider endpoint (`GET {base-url}/models`; skipped for
`mock`), built web assets, and the `<cwd>/plugins` directory. API keys are
never printed. The endpoint probe is bounded by `--timeout` (seconds, default
5) and only runs for `openai`.

Exit code: `0` when no check failed, `1` when at least one check failed, `2` on
a usage/config error. Warnings (a missing settings file or plugins directory,
absent web build) never fail the report.

```powershell
node dist/cli.js doctor
node dist/cli.js doctor --provider mock
node dist/cli.js doctor --json --sessions-dir sessions --timeout 10
```

`--json` prints one JSON object on stdout and keeps the same exit semantics:

```json
{"ok": true, "checks": [{"id": "engine", "label": "Node engine", "status": "pass", "detail": "v22.19.0"}]}
```

`ok` is `false` iff some check has status `fail`; `status` is one of
`pass`/`warn`/`fail`/`skip`. Provider flags (`--provider`, `--provider-kind`,
`--senior-kind`, `--junior-kind`, `--base-url`, `--api-key`, the four
per-role endpoint flags, `--senior-model`, `--junior-model`) resolve exactly
like `run`, so the report describes the run configuration.

### `config`

Print the resolved configuration without making a model call. Per role it
shows the provider, wire kind, base URL, model and API-key presence, each with
the layer that supplied it, in this precedence order:

`flag > role env > shared env > preset > settings > default`

```powershell
node dist/cli.js config
node dist/cli.js config --json
node dist/cli.js config --provider openai --base-url https://api.deepseek.com/v1 `
  --senior-model deepseek-chat --junior-model deepseek-chat
```

The human output is an aligned table with a `source` column (`flag
--senior-model`, `role env TWO_BROTHERS_SENIOR_MODEL`, `shared env
TWO_BROTHERS_BASE_URL`, `preset deepseek`, `settings <dir>/settings.json`,
`default`), followed by the cooperation mode, sessions directory,
plugin/skills/commands roots, compaction mode and thresholds, and the
max-tokens/retries/timeout limits. `--json` prints one stable object
(`schema: "two-brothers.config/1"`) with the same information plus the
env-pinning notes. **API keys are only ever reported as `set` / `not set` — a
key value is never printed.**

The flag/env layers resolve exactly like `run`; the preset/settings layers are
read from `<sessions-dir>/settings.json` (the store `serve`/`onboard` use), so
the table also explains what the web path would use. `run`/`chat`/`tui`
themselves resolve flags and `TWO_BROTHERS_*` env only. Exit codes: `0`
success, `2` usage/config error (unknown option, invalid flag value, unknown
`--mode`).

### `completions`

Print a shell completion script generated from the same command/flag catalog
as `help --all`, so the script never drifts from the CLI. Supported shells:
`bash`, `zsh`, `fish`, `powershell`.

```powershell
node dist/cli.js completions bash        # a complete -F hook
node dist/cli.js completions zsh         # #compdef script (fpath-installable)
node dist/cli.js completions fish        # complete -c rules
node dist/cli.js completions powershell  # Register-ArgumentCompleter -Native (PowerShell 7+)
```

A missing or unknown shell is a usage error (exit 2) that lists the valid
shells; an unknown option suggests the nearest known flag. Save the output
where your shell expects it (e.g. `_two-brothers` in a zsh `$fpath` directory,
`~/.config/fish/completions/two-brothers.fish` for fish); under PowerShell
redirect with `Out-File -Encoding utf8`.

### `selftest`

Offline check of the protocol, provider, and loop. Prints `SELFTEST: PASS` and
returns 0.

```powershell
node dist/cli.js selftest
```

### `serve`

Run the web workspace backend. Serves the API on `:8600` and the built
workspace at `/` (repo `web/dist` in a checkout; the packaged `web/` copy in
the npm tarball).

```powershell
# from packages/harness/ after npm run build
node dist/cli.js serve [--host 127.0.0.1] [--port 8600] [--sessions-dir sessions]
```

| Flag | Default | Description |
|---|---|---|
| `--host` | `127.0.0.1` | bind address |
| `--port` | `8600` | port |
| `--sessions-dir` | `sessions` | directory of JSONL session files to expose |
| `--workers` | (runtime default) | background run workers (env `TWO_BROTHERS_WORKERS`) |

The backend is a **local single-user workspace server**. API overview:

| Endpoint | Purpose |
|---|---|
| `GET /api/workspaces`, `POST /api/workspaces`, `DELETE /api/workspaces/{id}` | registered workspace directories (register/unregister; sessions are untouched); `GET` returns the operator order |
| `GET /api/workspaces/{id}/files?q=&limit=` | bounded file index of one workspace for the composer `@` picker (`{workspace_id, files: [{path, size, mtime}], truncated, total}`; forward-slash relative paths, hidden/node_modules/sensitive/symlink entries excluded, `limit` 1–200 default 50; 404 unknown workspace) |
| `PATCH /api/workspaces/{id}` | rename one workspace (`{"name": "..."}`; trimmed and capped at 120 characters, unchanged order; 400 for a blank name, 404 for an unknown id) |
| `PUT /api/workspaces/order` | persist the operator's workspace order (`{"ids": ["id1", ...]}` must be an exact permutation → `{"workspaces": [...]}`; 400 for duplicates/unknown/missing ids) |
| `GET /api/sessions` | list sessions (`?workspace_id=` filters); titles/workspace links from `<name>.meta.json` sidecars |
| `GET /api/search?q=&limit=` | full-text search over session titles and envelope payload strings; returns `{query, scanned_sessions, truncated, hits[]}`; `q` shorter than 2 characters is a 400 |
| `GET /api/sessions/{name}/export?format=markdown\|json` | download one session as Markdown (default) or JSON with `Content-Disposition: attachment`; 404 for an unknown session, 400 for an unknown format (HEAD supported) |
| `POST /api/sessions` | create a session (`{"title"?, "workspace_id"?}`) |
| `PATCH /api/sessions/{name}` | rename a session (set a readable title) |
| `DELETE /api/sessions/{name}` | delete a session — the JSONL, its `<name>.meta.json` and the runtime sidecar (`200 {"deleted": name}`; 404 on unknown) |
| `GET /api/sessions/{name}` | all protocol envelopes of one session |
| `GET /api/sessions/{name}/events` | runtime sidecar events (tool calls, approvals) for browser reload |
| `POST /api/sessions/{name}/compact` | compact the session in place on demand: the older context is summarized by the configured summarizer role (senior by default) and the session JSONL is rewritten with dense `seq`, so a reload shows the summary. `200 {"compacted": true, "before_events": N, "after_events": M}`; `200 {"compacted": false, "reason": "nothing to compact"}` when there is nothing to cut; 404 unknown session, 400 invalid session name, 409 while a run for that session is active or another compaction is already running, 422 when the session file is unreadable/corrupt, and 502 with the provider message (nothing written) when summarization fails. A run submitted for a session while it is being compacted is a 409 (`a compaction is in progress for this session; retry in a moment`) — the two operations are mutually exclusive so a run's envelopes can never be lost to the rewrite. The summarizer budgets follow the resolved run config (`--compact-*`/`TWO_BROTHERS_COMPACT*`), an explicit `ServerOptions.compaction` still wins, and a client disconnect aborts the provider call and releases the session |
| `GET /PUT /api/settings` | per-role Senior/Junior provider/model/base URL/API key (keys are write-only; responses show `api_key_set` only) |
| `POST /api/runs` | start a background run (`{"task", "mode"?, "session"?, "provider"?, "workspace_id"?, "stream_tokens"?}` → `202 {"run_id", "session", "status"}`); a leading `/name` command is expanded and `@skill:`/`@file` mentions are attached before the run (see [Composer mentions and slash commands](#composer-mentions-and-slash-commands)); `stream_tokens: true` additionally streams live `token` frames on the run SSE endpoint (strict boolean, default off); runs are FIFO — one active, the rest `queued` |
| `GET /api/runs`, `GET /api/runs/{run_id}` | list runs / run status (`queued`/`running`/`waiting`/`completed`/`failed`/`cancelled`); records carry a per-run `usage` object (`model_calls`, `input_tokens`, `output_tokens`, `cached_tokens`; zeros while running) |
| `POST /api/runs/{run_id}/stop` | cooperative stop (pending approvals are denied) |
| `GET /api/runs/{run_id}/events?after=N` | SSE of typed runtime events (`run_status`, `envelope`, `tool_started`, `tool_completed`, `approval_requested`, `approval_resolved`, `run_error`, `run_end`); reconnectable via `after`. When the run was started with `stream_tokens`, the same stream additionally carries ephemeral named `token` frames (`event: token`, data `{type, run_id, role, kind: "text"\\|"thinking", delta, at}`) with no SSE id — they are live-only, never persisted and never replayed |
| `GET /api/runs/{run_id}/approvals`, `POST /api/runs/{run_id}/approvals/{id}` | list/answer pending operator approvals (`{"allow": bool}`) |
| `GET /api/providers`, `PUT /api/providers/{seed}` | provider presets (seeded: openai, deepseek, anthropic, gemini, openrouter, lmstudio, custom); keys are never returned — responses carry `api_key_set` only |
| `GET /api/plugins` | discovered plugins (`name`, `description`, `roles`, load `errors`, `diagnostics`) |
| `GET /api/skills` | discovered skills metadata (`name`, `description`, `scope`, `tools`, `file`) — never bodies |
| `GET /api/commands` | discovered slash-command metadata (`name`, `description`, `argumentHint`, `mode?`, `file`) plus the additive first-party `baseCommands` list (`name`, `aliases`, `description`, `argumentHint`, `kind: "prompt"\|"action"`, `action?`, `requiresArguments`, `priority`) — never bodies |
| `GET /api/fs/browse` | browse the filesystem for workspace registration (UI helper) |
| `POST /api/run` | legacy synchronous run (body `{"task", "mode"?, "session"?, "provider"?}` → `{"session", "events", "decision"}`); slash commands and mentions are expanded the same way, but there is no token streaming |
| `GET /api/stream?session=<name>` | legacy SSE tail of a session file |

In `work` mode, a run with a `workspace_id` gives the junior confined
workspace tools (`workspace_read_file`, `workspace_list_dir`,
`workspace_search_text`, `workspace_write_file`, `workspace_edit_file`,
`workspace_delete_file`, `workspace_run_shell`) rooted at the registered
directory. Reads auto-allow; mutations and shell commands pause the run on an
`approval_requested` event until the operator answers. The senior gets
read-only workspace checks (plus approval-brokered `run_shell`) to verify the
junior's deliverable before reviewing it. See the
[Quickstart](quickstart.md) for the operator-facing walkthrough.

### `models`

List the models an OpenAI-compatible endpoint reports (`GET {base}/models`).

```powershell
node dist/cli.js models --base-url https://api.deepseek.com/v1
node dist/cli.js models --base-url https://api.deepseek.com/v1 --api-key-env DEEPSEEK_API_KEY
node dist/cli.js models --base-url https://api.deepseek.com/v1 --json
```

`--api-key-env <VAR>` reads the key from an environment variable name
(alternative to `--api-key <key>`); `--json` prints the raw list.

### `onboard`

Write per-role provider settings to `sessions/settings.json`
(`--sessions-dir <dir>` selects the store) from a seeded preset or manual
fields. Interactive by default; `--non-interactive` accepts piped stdin.

```powershell
node dist/cli.js onboard                                    # interactive prompts
node dist/cli.js onboard --preset lmstudio --non-interactive
node dist/cli.js onboard --base-url https://api.deepseek.com/v1 `
  --api-key sk-... --senior-model deepseek-chat --junior-model deepseek-chat --non-interactive
```

`--preset <id>` takes a seeded preset id (openai, deepseek, anthropic,
gemini, openrouter, lmstudio, custom); its API key resolves from the env-var
name the preset declares. Manual fields: `--base-url`, `--api-key` (or
`--api-key-env <VAR>`), `--senior-model`, `--junior-model`.

## Flags

| Flag | Values | Default | Description |
|---|---|---|---|
| `--provider` | `openai`, `mock` | `openai` | provider |
| `--base-url` | URL | — (empty; an `openai` run fails fast until set) | OpenAI-compatible base URL (shared by both roles) |
| `--api-key` | string | — | API key (may be empty for a local server) |
| `--senior-base-url` | URL | — | per-role endpoint override: senior base URL (empty fields fall back to `--base-url`) |
| `--senior-api-key` | string | — | per-role endpoint override: senior API key |
| `--junior-base-url` | URL | — | per-role endpoint override: junior base URL |
| `--junior-api-key` | string | — | per-role endpoint override: junior API key |
| `--senior-model` | string | — (empty; fails fast until set) | senior model |
| `--junior-model` | string | — (empty; fails fast until set) | junior model |
| `--provider-kind` | `openai-compatible`, `anthropic`, `google` | `openai-compatible` | (TS package) wire adapter for HTTP providers, both roles; a per-role kind wins |
| `--senior-kind` | `openai-compatible`, `anthropic`, `google` | — | (TS package) per-role wire adapter; presets with a `kind` carry it automatically on the server path |
| `--junior-kind` | `openai-compatible`, `anthropic`, `google` | — | (TS package) per-role wire adapter |
| `--context-window` | int (tokens) | `0` (unknown) | (TS package) provider context window — enables token-based compaction triggers (`contextWindow - reserve`) |
| `--compact-threshold-tokens` | int (tokens) | — | (TS package) force token-mode compaction at an explicit threshold (env `TWO_BROTHERS_COMPACT_THRESHOLD_TOKENS`) |
| `--senior-system` | text | (from `shared/prompts.json`) | override the senior system prompt |
| `--junior-system` | text | (from `shared/prompts.json`) | override the junior system prompt |
| `--max-rounds` | int | `3` | maximum revise rounds |
| `--temperature` | float | `0.4` | temperature |
| `--timeout` | int | `120` | per-request HTTP timeout, seconds; bounds every attempt of the retry loop (see [Local models and timeouts](#local-models-lm-studio-and-timeouts)) |
| `--retries` | int | `6` | retries after a failed model call (`0` = single attempt); backoff 2 s, 4 s, 8 s, … capped at 30 s (7 attempts total by default); a stopped run aborts the loop between attempts |
| `--max-tokens` | int | — | (TS package) output-token cap for both roles (env `TWO_BROTHERS_MAX_TOKENS`; per-role `TWO_BROTHERS_SENIOR_MAX_TOKENS` / `TWO_BROTHERS_JUNIOR_MAX_TOKENS` override it); Anthropic's default stays 4096, OpenAI/Gemini omit the cap when unset |
| `--mode` | `consult`, `work`, `auto` | `consult` | cooperation mode |
| `--mode` | `print`, `json` | — | (TS package, `run` only) non-interactive automation output — see [Automation output](#automation-output-ts-package); `--mode work --json-events` stays possible because `print`/`json` are output modes, not cooperation modes |
| `--json-events` | flag | off | (TS package, `run` only) alias for `--mode json` |
| `--stream` | flag | off | (TS package, `run` only) NDJSON run events on stdout as they happen: one JSON object per line from `run_status`, `envelope`, `repair`, `tool_call`, `tool_result`, `result`. Its own output mode — cannot combine with `--json`/`--json-events`/`--mode print|json` (usage error, exit 2); the human summary and cost line are suppressed |
| `--verbose` | flag | off | print the full payload of every message |
| `--json` | flag | off | with no explicit `--mode`: select `--mode json` (one machine-readable object). With an explicit `--mode print`: print the `decision` as JSON on the last line |
| `--session-file` | path | — | JSONL file to persist every protocol envelope to |
| `--resume` | flag | off | resume the session file instead of starting a new one |
| `--compact` | flag | off | (TS package) compact the context once before the run: an old prefix is summarized by the senior provider into a marked context event, keeping the session under the model's context window |
| `--compact-threshold` | int | `0` (off) | (TS package) auto-compact whenever the rendered context passes this many characters (an auto trigger caps its budgets so the compacted context lands under the threshold) |
| `--compact-keep-recent` | int | `40000` | (TS package) chars of recent envelopes kept verbatim when compacting |
| `--mcp-config` | path | — | JSON file with MCP server definitions; a server may take a `"role": "shared" \| "senior" \| "junior"` field (default `"junior"`) |
| `--plugins-dir` | dir | `<cwd>/plugins` | (TS package) plugin directory for `run`/`chat`/`serve` (env `TWO_BROTHERS_PLUGINS_DIR`); plugins load fail-soft, diagnostics under `--verbose`; plugin tools need a workspace, so `serve` runs over a workspace get them |
| `--skills-dir` | path | — (repeatable) | (TS package) extra skills root; defaults are `TWO_BROTHERS_SKILLS_DIR` (OS path list), then `<cwd>/skills` and `~/.two-brothers/skills` |
| `--stream-tokens` | flag | off | (TS package, `run --stream` and `tui`) with `--stream`: ask providers to stream their replies and add one `"token"` NDJSON record (`{type, role, delta, at}`) per text delta, in arrival order, interleaved with the other run records. In the TUI the deltas render in place (no `--stream` needed). Without `--stream` in a run it is a usage error (exit 2); env `TWO_BROTHERS_STREAM_TOKENS=1` pins it on |
| `--dry-run` | flag | off | (TS package, `run`/`chat`) resolve the run (config with sources, tools, session, compaction, limits) and print the plan; exits 0 with no model calls and no session write. `run --dry-run --json` prints one JSON object. Invalid with `--stream` (usage error, exit 2) |
| `--task-file` | path | — | (TS package, `run` only) read the task from a file — missing/unreadable/blank exits 2; mutually exclusive with a positional task. `run -` reads the task from stdin instead (bounded to 1 MiB, blank exits 2) |
| `--commands-dir` | path | — (repeatable) | (TS package) extra slash-command root for the chat REPL and `tui`; defaults are `TWO_BROTHERS_COMMANDS_DIR` (OS path list), then `<cwd>/commands` and `~/.two-brothers/commands` |

## Environment variables

| Variable | Corresponding flag |
|---|---|
| `TWO_BROTHERS_PROVIDER` | `--provider` |
| `TWO_BROTHERS_BASE_URL` | `--base-url` |
| `TWO_BROTHERS_API_KEY` | `--api-key` |
| `TWO_BROTHERS_SENIOR_BASE_URL` | `--senior-base-url` |
| `TWO_BROTHERS_SENIOR_API_KEY` | `--senior-api-key` |
| `TWO_BROTHERS_JUNIOR_BASE_URL` | `--junior-base-url` |
| `TWO_BROTHERS_JUNIOR_API_KEY` | `--junior-api-key` |
| `TWO_BROTHERS_SENIOR_MODEL` | `--senior-model` |
| `TWO_BROTHERS_JUNIOR_MODEL` | `--junior-model` |
| `TWO_BROTHERS_PROVIDER_KIND` | `--provider-kind` |
| `TWO_BROTHERS_SENIOR_KIND` | `--senior-kind` |
| `TWO_BROTHERS_JUNIOR_KIND` | `--junior-kind` |
| `TWO_BROTHERS_SENIOR_SYSTEM` | `--senior-system` |
| `TWO_BROTHERS_JUNIOR_SYSTEM` | `--junior-system` |
| `TWO_BROTHERS_MAX_ROUNDS` | `--max-rounds` |
| `TWO_BROTHERS_TEMPERATURE` | `--temperature` |
| `TWO_BROTHERS_TIMEOUT` | `--timeout` |
| `TWO_BROTHERS_RETRIES` | `--retries` |
| `TWO_BROTHERS_MODE` | `--mode` (also accepts the TS-package output values `print`/`json`) |
| `TWO_BROTHERS_VERBOSE` | `--verbose` (`true`/`1`) |
| `TWO_BROTHERS_JSON` | `--json` (`true`/`1`) |
| `TWO_BROTHERS_SESSION_FILE` | `--session-file` |
| `TWO_BROTHERS_RESUME` | `--resume` (`true`/`1`) |
| `TWO_BROTHERS_COMPACT` | `--compact` (`true`/`1`; TS package) |
| `TWO_BROTHERS_COMPACT_THRESHOLD` | `--compact-threshold` (TS package) |
| `TWO_BROTHERS_COMPACT_THRESHOLD_TOKENS` | `--compact-threshold-tokens` (TS package) |
| `TWO_BROTHERS_CONTEXT_WINDOW` | `--context-window` (TS package) |
| `TWO_BROTHERS_COMPACT_KEEP_RECENT` | `--compact-keep-recent` (TS package) |
| `TWO_BROTHERS_MAX_TOKENS` | `--max-tokens` (TS package) |
| `TWO_BROTHERS_SENIOR_MAX_TOKENS` / `TWO_BROTHERS_JUNIOR_MAX_TOKENS` | per-role `--max-tokens` overrides (TS package) |
| `TWO_BROTHERS_MCP_CONFIG` | `--mcp-config` |
| `TWO_BROTHERS_PLUGINS_DIR` | `--plugins-dir` (TS package) |
| `TWO_BROTHERS_SKILLS_DIR` | `--skills-dir` (OS path list; TS package) |
| `TWO_BROTHERS_STREAM_TOKENS` | `--stream-tokens` (`true`/`1`; requires `--stream`, which a run without it reports as a usage error) |
| `TWO_BROTHERS_COMMANDS_DIR` | `--commands-dir` (one or more roots separated by the OS path-list separator; TS package) |
| `TWO_BROTHERS_WORKERS` | `--workers` (serve) |
| `TWO_BROTHERS_PLUGINS_SENIOR` / `TWO_BROTHERS_PLUGINS_JUNIOR` | — (comma-separated plugin names; see `docs/plugins.md`) |
| `TWO_BROTHERS_SHELL_PATH_EXTRA` | — (path-separated dirs prepended to the confined workspace-shell `PATH`, e.g. the directory holding the binaries your tool proofs call) |

**Precedence:** CLI flags > environment variables > defaults. (Persisted
settings from `onboard` / the web Settings sit between env vars and defaults
on the server path: per-run flags > `TWO_BROTHERS_*` env vars > named preset
(`provider_ref`) > role manual settings > defaults. `two-brothers config` prints
this chain per field with the winning source.)

**Env-pinned fields.** An environment variable does not just override a
settings field — it *pins* it. A field pinned by a `TWO_BROTHERS_*` env var
(`TWO_BROTHERS_PROVIDER`, `TWO_BROTHERS_BASE_URL`/`_API_KEY` and their
per-role variants, `TWO_BROTHERS_SENIOR_MODEL`/`_JUNIOR_MODEL`) keeps the env
value as the effective value, is stripped before anything is written to
`sessions/settings.json`, and is surfaced in Settings/`onboard` output as the
env value. Consequence: a `PUT /api/settings` edit or an `onboard` run that
touches a pinned field is accepted but transient — the env value wins again
on the next read/run until the env var is unset. `onboard` prints a
`pinned by TWO_BROTHERS_* env vars` note naming the stripped fields.

## Local models (LM Studio) and timeouts

Small local models on CPU (observed with `lfm3-1.7b` in the live E2E) can
take **2–7+ minutes per provider call**. `--timeout` bounds *each attempt*
of the retry loop, and every retry restarts generation from scratch — so a
slow local model can exhaust all attempts even with retries left. Raise the
timeout rather than the retry count:

```powershell
node dist/cli.js run "Your task" --timeout 900    # seconds; go higher on slower machines
$env:TWO_BROTHERS_TIMEOUT = "900"                 # env equivalent (run/chat/serve)
node dist/cli.js serve --timeout 900              # serve/web path (flag or env)
```

## Sessions

`--session-file <path>` (env `TWO_BROTHERS_SESSION_FILE`) makes both `run` and
`chat` append every protocol envelope to a JSONL file — one line per envelope,
flushed immediately, so a crashed run leaves a valid, replayable log.

- `run`: an existing file without `--resume` is an error (exit code 1; the
  message suggests `--resume` or deleting the file).
- `--resume` (env `TWO_BROTHERS_RESUME`, boolean) rebuilds the shared context
  from the file; `seq` numbering continues densely. With a missing file, a
  fresh session starts with a `[warn]`.
- `chat`: one shared context across all REPL tasks, persisted; with `--resume`
  it continues a previous session.
- (TS package) `--compact` / `--compact-threshold <chars>` (env
  `TWO_BROTHERS_COMPACT*`) compact a growing context: an old prefix is
  summarized by the senior provider into a clearly-marked context event while
  the original task and the recent exchange stay verbatim. A compacted
  session file stays ordinary JSONL — `--resume` and `sessions` keep working.
  Summarization failure is fail-soft: a `[warn]` on stderr, the run continues
  with the full context.

List sessions without opening the web workspace:

```powershell
node dist/cli.js sessions                # the default ./sessions dir
node dist/cli.js sessions --sessions-dir path/to/dir
```

```powershell
# create a session
node dist/cli.js run "Plan a migration from Redis to Valkey" --provider mock --session-file session.jsonl

# resume it later
node dist/cli.js run "Now plan the rollback" --provider mock --session-file session.jsonl --resume
```

## MCP tools

`--mcp-config <path>` (env `TWO_BROTHERS_MCP_CONFIG`) points at a JSON file
with MCP server definitions. In `work` mode the junior receives those tools
and can execute real work during a delegation. The format follows the
Claude-Desktop style — a server is either a local command or a remote URL. A
server may carry a `"role"` field (`"shared" | "senior" | "junior"`, default
`"junior"`) to scope its tools per role:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    },
    "remote": {
      "url": "https://example.com/mcp",
      "headers": {"Authorization": "Bearer ..."}
    }
  }
}
```

```powershell
node dist/cli.js run "Refactor utils.ts" --mode work --mcp-config mcp.json
```

No config → no tools; a server that fails to start → a `[warn]` and the junior
continues text-only. Used tools are recorded in the deliverable's `artifacts`
as `mcp:<name>`. Model-facing MCP tool names are namespaced
(`mcp__<server>__<tool>`), a single result is clipped to 20 KiB, and each call
has a timeout (default 60 s, per-server `timeoutMs` override).

## Skills (TS package)

`<root>/<name>/SKILL.md` files (or loose `.md` files) with hand-rolled
frontmatter (`name`, `description`, optional `scope: shared|senior|junior`,
optional `tools`) become an `## Available skills` section in the system
prompt of each role that has visible skills. Roots: repeatable `--skills-dir`,
then `TWO_BROTHERS_SKILLS_DIR` (OS path list), then `<cwd>/skills` and
`~/.two-brothers/skills`. A `<skill name="…">` request in a structured reply
injects the body once as a `<skill-loaded>` message (at most three per run,
each skill once, only skills visible to the acting role). The server serves
metadata only at `GET /api/skills`.

## Modes

| Mode | What happens |
|---|---|
| `consult` | senior asks for advice → junior `proposal` → `review` → `decision` |
| `work` | senior delegates (`delegation`) → junior `deliverable` → `review` → `decision` |
| `auto` | senior chooses; in v0.1 this reduces to `consult` |

## Automation output (TS package)

`run` in the TypeScript package (`packages/harness`) accepts two extra
`--mode` values — output modes, not cooperation modes (so
`--mode work --json-events` is meaningful):

- `--mode print` — stdout carries only the final decision text (with
  `--json`: the decision object as JSON). Warnings and the usage line go to
  stderr, so the output is pipe-clean for scripts and `$(...)`.
- `--mode json` (alias `--json-events`; a bare `--json` with no explicit
  `--mode` selects this mode too) — stdout is exactly one
  machine-readable JSON object
  `{task, events, decision, usage, cost, rounds, errors}`; diagnostics stay on
  stderr. One event per line is intentionally not produced — the object is
  single-shot. (`run --stream` is the line-by-line NDJSON alternative.)

Exit codes in both modes: `0` success, `1` run error (the `errors` array in
JSON mode is non-empty), `2` usage error (unknown command/option, task not
given).

```powershell
node dist/cli.js run "Pick a testing scheme" --provider mock --mode print
node dist/cli.js run "Pick a testing scheme" --provider mock --mode json | ConvertFrom-Json
```

## Features beyond the original prototype

These ship in the TypeScript package (the original prototype had none of
them):

- **Context compaction** — `--compact`, `--compact-threshold`,
  `--compact-keep-recent` (see [Sessions](#sessions)).
- **MCP role scoping** — the per-server `"role"` field (see [MCP tools](#mcp-tools)).
- **Automation output modes** — `--mode print|json`, `--json-events`
  (a bare `--json` selects `--mode json`), and `run --stream` NDJSON.
- **Token-level streaming & slash commands** — `run --stream
  --stream-tokens` adds one `token` NDJSON record per provider text delta
  (env `TWO_BROTHERS_STREAM_TOKENS=1`), and the chat REPL expands markdown
  `/name args` commands (`--commands-dir`, env `TWO_BROTHERS_COMMANDS_DIR`;
  `GET /api/commands` serves metadata only, never template bodies).
- **Provider error classification** — an ordered registry decides which
  failures retry (408/409/429/5xx and transport errors) and which fail fast
  (other 4xx, quota/billing, context overflow); a retryable response's
  `Retry-After` replaces that attempt's fixed backoff, and a context-overflow
  payload triggers compact-and-retry instead of burning the retry budget.
- **Plugins** — see `docs/plugins.md`.
- **Skills** — role-scoped `SKILL.md` catalogs (see [Skills](#skills-ts-package)).
- **Provider presets, onboarding, cost** — seeded presets (openai, deepseek,
  anthropic, gemini, openrouter, lmstudio, custom) keyed by env-var names,
  `onboard` to write per-role settings, `models` to list an endpoint's
  models, a `cost:` line (and `cost` in `--mode json`) from a hand-maintained
  price table, and per-role `--max-tokens` output caps.
- **Diagnostics and shell completions** — `doctor` reports the local
  environment and provider setup (human report or `--json`, exit 1 on a
  failing check), `config` prints the resolved configuration with per-field
  provenance and masked keys (`--json` for one stable object), and
  `completions <bash|zsh|fish|powershell>` prints a completion script
  generated from the same command/flag catalog as help.
- **Task input and dry runs** — `run -` (stdin, ≤ 1 MiB) and
  `run --task-file <path>` feed the task without shell quoting, and
  `run`/`chat --dry-run` print the resolved plan (config, tools, session,
  compaction, limits) with no model call and no session write.
- **Session search and export** — `sessions search <query>` (human or
  `--json`, bounded snippets, newest sessions first) and
  `sessions export <name> [--format markdown|json] [--output <path>]`; the
  server exposes the same data at `GET /api/search` and
  `GET /api/sessions/{name}/export`. The web workspace searches message
  content from the Ctrl+K palette and exports a session from its row menu.
- **TUI** — `tui [task]` (also the bare interactive `two-brothers`) is a
  zero-dependency full-screen chat in the terminal's alternate screen over
  the same harness and flags: block transcript with textual role labels, a
  multiline grapheme-aware composer with bracketed paste, a two-line status
  bar, Ctrl+P palette / `?` help from one keymap registry, session and model
  pickers, Ctrl+F find-in-transcript, and non-blocking turns with
  Escape/Ctrl+C cancellation.

## Examples

All examples assume the TypeScript package build (`cd packages/harness` after
`npm run build`).

```powershell
# compact output
node dist/cli.js run "Pick a testing scheme" --provider mock

# verbose output with payloads
node dist/cli.js run "Pick a testing scheme" --provider mock --verbose

# only the final decision as JSON (--mode print narrows print output;
# a bare `--json` without --mode prints the full machine-readable object)
node dist/cli.js run "Pick a testing scheme" --provider mock --mode print --json

# pipe-clean automation output (decision text on stdout only)
node dist/cli.js run "Pick a testing scheme" --provider mock --mode print

# one machine-readable JSON object ({events, decision, usage, rounds, errors});
# diagnostics stay on stderr
node dist/cli.js run "Pick a testing scheme" --provider mock --mode json

# delegation
node dist/cli.js run "Write hello world" --provider mock --mode work

# local diagnostics: human report and one machine-readable object
node dist/cli.js doctor --provider mock
node dist/cli.js doctor --provider mock --json

# resolved configuration with per-field sources (keys masked), and as JSON
node dist/cli.js config --provider mock
node dist/cli.js config --provider mock --json

# task from stdin / a file; a dry run prints the plan and writes nothing
Get-Content task.txt | node dist/cli.js run - --provider mock --dry-run
node dist/cli.js run --task-file task.txt --provider mock --dry-run --json

# shell completions (write the output to your shell's completion location)
node dist/cli.js completions bash
node dist/cli.js completions powershell

# inspect persisted sessions (JSON array, then one session's envelopes)
node dist/cli.js sessions --sessions-dir sessions --json
node dist/cli.js sessions show session --sessions-dir sessions

# full-text search across sessions, and export one for reading/sharing
node dist/cli.js sessions search "migration" --sessions-dir sessions
node dist/cli.js sessions search "migration" --json --limit 5
node dist/cli.js sessions export session --sessions-dir sessions
node dist/cli.js sessions export session --format json --output session.json

# a real provider
node dist/cli.js run "Task" --provider openai `
  --base-url https://api.deepseek.com/v1 --api-key sk-... `
  --senior-model deepseek-chat --junior-model deepseek-chat
```

## Return codes

| Code | Meaning |
|---|---|
| 0 | success (including `doctor` when no check failed, a `--dry-run` plan, and a missing/empty sessions directory) |
| 1 | run error (the `errors` array in `--mode json`) / selftest FAIL / `doctor` with at least one failing check / unreadable session file |
| 2 | usage error: unknown command or option, missing task, shell or session argument, unknown session, invalid flag value, bad config, blank stdin/`--task-file` task, `--dry-run` with `--stream`, a `sessions search` query shorter than 2 characters, an unknown `sessions export` format |
