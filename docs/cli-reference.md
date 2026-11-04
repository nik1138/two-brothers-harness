# CLI Reference

The command set covers the TypeScript package — the implementation. Examples
below use `node dist/cli.js <command>` from `packages/harness/` (after
`npm run build`); a global install exposes the same commands as
`two-brothers <command>`. The zero-dependency reference in `typescript/` runs
the same core commands as `node src/cli.ts <command>`. `serve` is provided by
the package: a plain `node:http` server exposing the HTTP + SSE API.

Global invocations: `two-brothers --version` (or `-v`) prints the package
version; a bare `two-brothers` with no arguments drops into the chat REPL on
an interactive terminal and prints the usage screen when stdin is piped.

## Commands

### `run "<task>"`

A single invocation: task → cooperation → `decision`.

```powershell
node dist/cli.js run "Plan a migration from Redis to Valkey"
```

If the task contains spaces, pass it as a single string (quote it in PowerShell).

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

### `tui [initial task]`

Full-screen interactive chat in the terminal's alternate screen, over the
same harness as `chat` (mock or real providers). Needs a TTY: a piped stdin
exits `2` with a clean message and no escape bytes (use `chat` for scripts).
Keys: Enter sends, Backspace edits, PgUp/PgDn scroll, Esc or Ctrl+C twice
quits after a confirm hint. `/help`, `/commands`, `/mode consult|work` and
`/exit` work as in the chat REPL; `--stream-tokens` renders token deltas in
place while a turn runs.

```powershell
node dist/cli.js tui --provider mock
node dist/cli.js tui "Plan a migration from Redis to Valkey" --provider mock
```

### `sessions`

List the JSONL session files of a sessions directory (default `sessions`)
with readable titles (from the `<name>.meta.json` sidecar, or derived from the
first operator message) and the last-modified time. Output-only — it never
touches the files.

```powershell
node dist/cli.js sessions [--sessions-dir sessions]
```

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
| `GET /api/workspaces`, `POST /api/workspaces`, `DELETE /api/workspaces/{id}` | registered workspace directories (register/unregister; sessions are untouched) |
| `GET /api/sessions` | list sessions (`?workspace_id=` filters); titles/workspace links from `<name>.meta.json` sidecars |
| `POST /api/sessions` | create a session (`{"title"?, "workspace_id"?}`) |
| `PATCH /api/sessions/{name}` | rename a session (set a readable title) |
| `DELETE /api/sessions/{name}` | delete a session — the JSONL, its `<name>.meta.json` and the runtime sidecar (`200 {"deleted": name}`; 404 on unknown) |
| `GET /api/sessions/{name}` | all protocol envelopes of one session |
| `GET /api/sessions/{name}/events` | runtime sidecar events (tool calls, approvals) for browser reload |
| `GET /PUT /api/settings` | per-role Senior/Junior provider/model/base URL/API key (keys are write-only; responses show `api_key_set` only) |
| `POST /api/runs` | start a background run (`{"task", "mode"?, "session"?, "provider"?, "workspace_id"?}` → `202 {"run_id", "session", "status"}`); runs are FIFO — one active, the rest `queued` |
| `GET /api/runs`, `GET /api/runs/{run_id}` | list runs / run status (`queued`/`running`/`waiting`/`completed`/`failed`/`cancelled`); records carry a per-run `usage` object (`model_calls`, `input_tokens`, `output_tokens`, `cached_tokens`; zeros while running) |
| `POST /api/runs/{run_id}/stop` | cooperative stop (pending approvals are denied) |
| `GET /api/runs/{run_id}/events?after=N` | SSE of typed runtime events (`run_status`, `envelope`, `tool_started`, `tool_completed`, `approval_requested`, `approval_resolved`, `run_error`, `run_end`); reconnectable via `after` |
| `GET /api/runs/{run_id}/approvals`, `POST /api/runs/{run_id}/approvals/{id}` | list/answer pending operator approvals (`{"allow": bool}`) |
| `GET /api/providers`, `PUT /api/providers/{seed}` | provider presets (seeded: openai, deepseek, anthropic, gemini, openrouter, lmstudio, custom); keys are never returned — responses carry `api_key_set` only |
| `GET /api/plugins` | discovered plugins (`name`, `description`, `roles`, load `errors`, `diagnostics`) |
| `GET /api/skills` | discovered skills metadata (`name`, `description`, `scope`, `tools`, `file`) — never bodies |
| `GET /api/commands` | discovered slash-command metadata (`name`, `description`, `argumentHint`, `mode?`, `file`) — never bodies |
| `GET /api/fs/browse` | browse the filesystem for workspace registration (UI helper) |
| `POST /api/run` | legacy synchronous run (body `{"task", "mode"?, "session"?, "provider"?}` → `{"session", "events", "decision"}`) |
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
on the server path: per-run flags > `TWO_BROTHERS_*` env vars > persisted
settings > defaults.)

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
JSON mode is non-empty), `2` unknown command / task not given.

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
- **TUI** — `tui [task]` is a zero-dependency full-screen chat in the
  terminal's alternate screen over the same harness and flags.

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

# a real provider
node dist/cli.js run "Task" --provider openai `
  --base-url https://api.deepseek.com/v1 --api-key sk-... `
  --senior-model deepseek-chat --junior-model deepseek-chat
```

## Return codes

| Code | Meaning |
|---|---|
| 0 | success |
| 1 | run error / selftest FAIL |
| 2 | unknown command / task not given |
