# Two Brothers

[![ci](https://github.com/nik1138/two-brothers-harness/actions/workflows/ci.yml/badge.svg)](https://github.com/nik1138/two-brothers-harness/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg?style=flat)](LICENSE)
[![Node ≥ 22.19](https://img.shields.io/badge/node-%E2%89%A5%2022.19-339933?style=flat)](https://nodejs.org)

A harness for cooperation between two agents: a **senior** (the older brother —
experienced, level-headed, the arbiter) and a **junior** (the younger brother —
brave, determined, the challenger). Both work with **one shared context**, have
**different system prompts**, and exchange **structured protocol messages**: the
senior consults the junior, may delegate part of the work to it, reviews what
comes back, and makes the final decision. This is not subagents in the usual
sense — it is parallel models with explicit roles advising each other as peers
within a single context.

The implementation is the TypeScript package in
[`packages/harness/`](packages/harness/) (`@two-brothers/harness`, written in
the style of pi / deepseek-harness). **The package is not on npm yet** — v0.0.1
is the pre-publication version, so today you build it from a checkout with the
[Quickstart](docs/quickstart.md) — offline in a couple of minutes, no API key.
Once it is published, `npm install -g @two-brothers/harness` gives the global
`two-brothers` command (see [Install](#install)). The full flag,
environment-variable, and endpoint reference is
[docs/cli-reference.md](docs/cli-reference.md).

## Install

> **Pre-release:** v0.0.1 has not been published to npm yet, so the command
> below will not work today. It is the intended install path once the package
> is published. Until then, use the source build from the [Quickstart](docs/quickstart.md).

```powershell
npm install -g @two-brothers/harness
two-brothers --help
```

Requirement: **Node ≥ 22.19** (the package's `engines` floor).

## Quick start

Build from a checkout:

```powershell
cd packages/harness
npm install
npm run build                                     # tsc → dist/

# 1. one cooperation cycle, offline (deterministic mock provider)
node dist/cli.js run "Plan a migration from Redis to Valkey" --provider mock

# 2. the web workspace: serve the API + the built UI, then open the browser
node dist/cli.js serve --port 8600 --sessions-dir sessions
#    → http://127.0.0.1:8600

# 3. the terminal workspace (a bare interactive `two-brothers` opens this TUI)
node dist/cli.js tui --provider mock
node dist/cli.js tui --workspace . --provider mock   # confined tools + operator approvals
```

The `run` output is the full conversation: `[user]`,
`[senior -> junior] consult`, `[junior -> senior] proposal`,
`[senior -> junior] review`, `[senior -> user] decision`. Each envelope is a
separated block, model prose renders as width-safe Markdown, the decision is
ruled off, and a compact usage footer closes the transcript when usage exists.
On an interactive terminal the transcript also streams live block by block,
with dim activity rows while the models and tools work (`--no-live` prints the
finished transcript once; piped output always does).

With no arguments at all, an interactive terminal opens the TUI directly;
piped/CI invocations print the usage screen instead.

For frontend development: `cd web && npm install && npm run dev` (Vite proxies
`/api` to :8600); `npm run build` produces `web/dist`, which the TypeScript
server then serves (the npm tarball ships its own copy of that build).

## Features

- **Two-role cooperation core.** Two modes — `consult` (advice) and `work`
  (delegation with tool execution) — over a plain async state machine
  (`senior_open → junior_answer → senior_review → (junior_revise)* →
  senior_decide`). Every exchange is a structured protocol envelope
  (`consult`, `proposal`, `delegation`, `deliverable`, `review`, `decision`,
  `message`) appended to one shared, append-only context; dissent is recorded
  explicitly in the decision.
- **Tool calling for both brothers.** In consult mode the senior's opening,
  the junior's proposal/revision and the senior's review may call a role
  **read-only workspace belt** (workspace reads/searches, plus
  operator-installed MCP/plugin tools scoped to that role — the four workspace
  mutation built-ins are always excluded) before emitting the structured
  reply, with a bounded loop; a tool-less configuration keeps the exact
  pre-tools request path. Work mode keeps its mutating junior deliverable loop
  and the senior's read-only verify slice unchanged.
- **Payload repair + few-shot exemplars.** Model output goes through a
  tolerant parse, a strict schema check, exactly one repair re-ask with a
  byte-stable `[[REPAIR_REQUEST]]` turn, and finally a sanitize-plus-defaults
  fallback: the boundary never throws. Each structured node's prompt carries
  one tiny, strict-valid fenced example of its payload kind.
- **Plugins v2.** ES-module plugins exposing `register(ctx)`: tools (with an
  optional JSON-Schema argument spec validated at dispatch), typed lifecycle
  hooks (`session_start`, `session_end`, `before_tool_call` — which may rewrite
  arguments or veto the call, `after_tool_call` — which may rewrite the
  result), per-role scope opt-in (`shared` by default, `senior`/`junior` on
  request), per-plugin options validated against an exported `configSchema`,
  and plugin-contributed MCP servers.
- **Skills.** `<root>/<name>/SKILL.md` files with frontmatter become an
  `## Available skills` prompt section, scoped per role; a
  `<skill name="…">` request in a reply injects the body once as a
  `<skill-loaded>` message.
- **Slash commands.** Markdown prompt templates with `description`,
  `argument-hint`, and an optional mode; `/name args` expands `$ARGUMENTS`,
  `$1`..`$9`, and `$$` literally in the chat REPL and the TUI, and metadata is
  served at `GET /api/commands`. First-party **built-in commands** ship too
  (`plan`, `goal`, `feedback`, `compact`, `export`, `permission`, `status`,
  `mode`, `new`, `help`): prompt commands expand like templates with a mode
  override, action commands are performed by the surface and never submitted,
  a discovered template shadows a built-in of the same name, and
  `POST /api/sessions/{name}/compact` compacts one session on demand.
- **Context compaction.** pi's compaction algorithm on our envelope format:
  char budgets and token budgets (`--context-window`,
  `--compact-threshold-tokens`), incremental summaries via
  `<previous-summary>`, split-payload cuts, and one compact-and-retry on a
  provider context overflow.
- **Persisted compaction settings.** The web Settings → Advanced
  **Auto-compaction** card saves `threshold_chars`, `threshold_tokens`,
  `keep_recent_chars` and `context_window` to `sessions/settings.json`; an
  explicitly-set non-zero server flag/env still wins, and `0` means off (or
  unknown for the context window).
- **Crash-torn session resume.** A half-written final JSONL record no longer
  loses a session: the search/detail readers ignore only that fragment and
  `--resume` repairs the file atomically before appending, keeping dense
  `seq`. Interior corruption still fails loudly, and read-only listing/search
  never rewrite.
- **Streaming.** `run --stream` emits one bounded NDJSON record per run event
  (status, envelopes, repairs, tool calls, terminal result);
  `run --stream --stream-tokens` adds a `token` record per provider text delta,
  and the TUI renders those deltas in place.
- **Reasoning capture and replay.** With token streaming active, each provider
  call's reasoning is buffered, sanitized and bounded, emitted as one additive
  `reasoning` runtime event and persisted to the session runtime sidecar. The
  web transcript shows collapsed-by-default **Thinking · replayed** rows after
  a reload and the TUI replays bounded dim `THINKING (replayed)` rows on
  load/resume/session switch; the protocol transcript and session JSONL are
  unchanged (web always opts into streaming, CLI/TUI use `--stream-tokens`).
- **Anthropic extended thinking.** `--thinking-budget` /
  `TWO_BROTHERS_THINKING_BUDGET` requests `thinking:{type:"enabled",
  budget_tokens:n}` for Anthropic roles, captures signed/redacted thinking
  blocks from the stream and echoes them **verbatim** on tool-loop assistant
  turns so multi-round tool use is accepted; other adapters ignore the option
  and unset requests stay byte-identical. A cap that does not exceed the
  budget is raised with one honest warning and `temperature` is omitted while
  thinking is on.
- **Anthropic prompt caching.** Every Anthropic Messages request carries
  explicit `cache_control:{type:"ephemeral"}` breakpoints for the system
  prompt, the tool schemas and the newest conversation turn, so the repeated
  prefix of a cooperation cycle is read from Anthropic's 5-minute prompt cache
  on the 2nd..Nth call (lower latency and input cost; a single-call run pays
  the cache-write premium, prompts below the cache minimum ignore the markers,
  and OpenAI-compatible/Gemini request bodies are unchanged). Usage reports
  real cached tokens, so the compact footer's `cache N%` segment becomes
  meaningful for Anthropic.
- **Configurable keys and accent themes.** Settings → **Appearance** picks a
  web accent (Blue/Violet/Teal/Amber, light and dark, with WCAG-AA text and
  native naive-ui controls) and Settings → **Keyboard** rebinds the
  palette/find/shortcut-reference chords with conflict-checked capture;
  workspace groups reorder by drag-and-drop (the group menu stays the keyboard
  path). The TUI rebinds its three global chords (palette/help/stash) from a
  versioned `tui --keys-file` JSON document with fail-soft diagnostics; every
  effective chord drives the palette, help overlay, hints and `tui --help`.
- **Live terminal transcript.** On an interactive stdout `run`/`chat` stream
  each envelope block as it is produced, with dim `· …` activity rows between
  blocks; the ruled decision and compact footer still print exactly once.
  `--live`/`--no-live` control it (live is the TTY default), and piped output
  plus every machine mode stays byte-identical.
- **Plan and todo function.** The built-in `todo_write` tool keeps a whole-list
  plan (`{content, status}` entries, tolerant sanitize, last write wins) for
  both brothers without touching the workspace or asking for approval; each
  write emits one additive `todo_updated` runtime event (sidecar-persisted,
  replayed on reload) that drives a display-only TUI plan panel and a web
  **Plan** dock.
- **Provider adapters.** OpenAI-compatible, Anthropic, and Google Gemini wire
  adapters behind one `Provider` interface, driven by an ordered
  error-classification registry: 408/409/429/5xx and transport errors retry
  (honoring `Retry-After`), other 4xx, quota/billing, and context overflow fail
  fast — overflow triggers compaction instead of burning the retry budget.
- **Presets, onboarding, cost.** A curated seed table (openai, deepseek,
  anthropic, gemini, openrouter, lmstudio, custom) keyed by env-var names,
  `onboard` to write per-role settings, `models` to list an endpoint's models,
  a hand-maintained price table for `cost: $…` estimates, and per-role
  `--max-tokens` output caps. In the web workspace, Settings → Providers is a
  master–detail list: provider names first, the selected provider's settings
  (base URL, masked write-only key, model ids, wire kind) directly below, plus
  **Refresh models** — an explicit probe of the current OpenAI-compatible
  endpoint that never saves or applies anything (an empty answer is valid; a
  typed key is one-shot and never stored). A customized built-in seed has a
  **Reset to default** action that discards the stored override and its key
  without touching the Senior/Junior role assignments.
- **Approval broker.** Workspace tools are confined to an operator-registered
  directory: reads auto-allow, while writes, edits, deletes, and shell commands
  park the run on an operator approval (the approval mode below decides which
  of them park at all). With no broker configured the policy
  fails closed; stopping a run auto-denies everything still pending. A third
  decision, **Always allow this session**, remembers an identical
  `(action, target)` pair for that session (persisted in the session settings,
  removed with the session) while the fail-closed default and denial cap stay
  unchanged.
- **Approval modes and guardrails.** An operator-selected policy — **Ask**
  (the default), **Read only**, **Edits** or **Allow all** — selects a fixed,
  honest decision table for workspace actions. It is persisted in
  `sessions/settings.json`, can be pinned per server/TUI process with
  `--approval-mode` (never persisted), and is editable from Settings →
  Approvals in the web workspace and the TUI `/permission` dialog; `allow-all`
  is explicit opt-in and always shows a destructive warning. A mode never
  bypasses workspace confinement or the sensitive-path refusal, `readonly`
  denies without asking, and neither a model reply nor a tool call can change
  it. The TUI `/permission` dialog also states the effective mode and accepts
  `/permission <mode>`.
- **Mid-run steering.** While a run works (or waits on an approval), the web
  composer's explicit **Steer run** action (or `Alt+Enter`) adds the draft to
  the **current** cooperation cycle: it is appended to the shared context as
  an ordinary operator message and applied at the run's next step — it never
  starts or queues a task, and `Enter` keeps queueing a new task behind the
  run. The same bounded in-memory queue is exposed as
  `POST /api/runs/{run_id}/steer`; a text that later hits the per-run envelope
  cap is reported through the additive `steering_dropped` run field/event,
  and nothing is appended after a stop. In the TUI, `Ctrl+N` (also the
  **Steer the running turn** palette row) queues the composer text for the
  running turn under the same bounds.
- **Sessions and resume.** Every envelope is appended to a JSONL session file
  (flushed immediately, dense `seq`); `--resume` rebuilds the shared context,
  and `sessions` lists files with readable titles.
- **Run-scoped file undo.** A workspace-bound run records the exact pre/post
  bytes of every file it mutated through the workspace tools (persisted under
  `<sessions>/undo`, never part of the session JSONL), so the operator can
  revert exactly that run's changes: the web workspace shows **Undo file
  changes…** for the newest completed run, with a per-file preview
  (`applicable`/`created`/`deleted`/`changed-since`/`skipped`/`missing`) and
  per-file apply results. Files changed after the run are refused, never
  overwritten; shell-made changes, untracked files and file mode/ownership are
  out of scope. The same operation is exposed as
  `GET/POST/DELETE /api/sessions/{name}/undo/{run_id}` (restart-resilient;
  blob garbage collection is a follow-up).
- **Web workspace.** A Vue 3 + Vite group chat (Operator / Senior / Junior)
  with registered workspaces, workspace-grouped sessions, background runs
  over SSE, docked approval cards (a mobile drawer below the breakpoint) that
  state their honest reason for shell/delete requests and offer a collapsible
  diff/command preview (write/edit rely on their diff), runtime sidecars, and
  changed-file diffs. A submission made while a run works
  joins the server's FIFO instead of blocking the composer (Send reads
  **Queue**), a bounded queue dock shows waiting tasks with per-row Stop, and
  the next queued run is followed automatically. Older completed-run tool rows
  fold into one disclosure summary (`… N tool calls`, plus `in M runs` when a
  group spans several runs), the composer has a truthful status-seat row
  (models, permission expectation, latest prompt-audit context sizes), and with
  no session open — or an empty one — a welcome hero offers workspace context,
  actions and starter suggestions that only prefill the composer. A **Plan**
  dock mirrors the model's todo list. The composer has a `@` mention picker and
  a `/` command menu (built-ins first, then your templates), the built-in
  actions run locally (`/compact`, `/export`, `/help`, `/status`, `/permission`,
  …), and `?`/`Ctrl+/` opens the commands-and-shortcuts overlay. `Up`/`Down` in
  the composer recall earlier accepted tasks (multiline drafts only at their
  edges, the live draft restored exactly), and Settings → **Approvals** picks
  the workspace approval mode with honest copy and an inline warning for
  `allow-all`.
- **TUI.** A bare interactive `two-brothers` (or `tui [task]`) is a
  zero-dependency full-screen chat in the terminal's alternate screen, over
  the same harness and the same flags: block transcript with textual role
  labels, grapheme-aware multiline composer with history and bracketed paste,
  Ctrl+P command palette and `?` help from one keymap registry, session and
  model pickers, token streaming in place, width-aware folded tool-result
  previews (six visual rows by default; `Ctrl+T` toggles preview/full text),
  live resize repaint, and non-blocking turns with Escape/Ctrl+C
  cancellation. `tui --workspace <dir>` binds a confined workspace: the junior
  gets the `workspace_*` tools, the senior the read-only verify slice, every
  write/edit/delete/shell parks on a docked approval panel (`1`/`y` allow once,
  `2`/`a` allow for this TUI session — memory only, `3`/`n`/`Esc` deny,
  `Ctrl+E` preview), `@path` mentions attach workspace files, and a plan panel
  docks above the composer (durable across restarts when the session has a
  `--session-file`). `/provider` connects a provider from the same persisted
  settings the web workspace and `onboard` write (preset or manual endpoint,
  key masked and encrypted at rest). `Up`/`Down` recall earlier submitted tasks
  at the draft edges (the live draft is restored exactly), `/permission` states
  the effective approval mode and persists a new one (a `--approval-mode`/env
  pin states itself and offers only Close), and `/permission <mode>` applies
  one directly. The `/` picker lists the built-in commands
  (badged) plus discovered templates, Tab/Shift+Tab accept/dismiss, and actions
  like `/compact`/`/export` are performed in the TUI rather than submitted.
  Overlay lists follow the theme, the composer leaves mode/models to the status
  bar, a dim `⋯` marks a transcript window that starts mid-block, and the
  status bar rotates one registry-derived tip per turn with brief transient
  hints (a stopped turn's exit copy, the quit path while an approval is
  parked). Piped no-arg
  invocations print the usage screen instead.
- **Protocol reference.** [`typescript/`](typescript/) is a zero-dependency
  implementation of `PROTOCOL.md` (no npm packages, no build step) that
  documents the contract.

## How it works

```
user → CLI → cooperation state machine (TypeScript package)
                │
                ├── Senior (model A, system prompt A)
                │        │ consult / delegation
                │        ▼
                └── Junior (model B, system prompt B)
                │        │ proposal / deliverable (workspace + MCP tools in delegation mode)
                │        ▼
                Senior: verify (read-only workspace checks, work mode) → review → decision (final)
                         │
                         ▼
                SharedContext (one shared append-only log)
```

Protocol in brief (full contract: [`PROTOCOL.md`](PROTOCOL.md), JSON Schema:
[`shared/protocol.schema.json`](shared/protocol.schema.json)):

- **Envelope**: `{v, id, seq, ts, from, to, kind, payload}`.
- **Kinds**: `consult`, `proposal`, `delegation`, `deliverable`, `review`,
  `decision`, `message`.
- **Cycle**: consult → proposal → review → (revise)* → decision.

Why this is cooperation, not subagents: [`DESIGN.md`](DESIGN.md).

## Connecting a real model

Set environment variables or CLI flags (any OpenAI-compatible endpoint —
DeepSeek, OpenAI, OpenRouter, vLLM, Ollama, LM Studio; Anthropic and Gemini
through their adapters):

```powershell
$env:TWO_BROTHERS_BASE_URL  = "https://api.deepseek.com/v1"     # or your URL
$env:TWO_BROTHERS_API_KEY   = "sk-..."
$env:TWO_BROTHERS_SENIOR_MODEL = "deepseek-chat"
$env:TWO_BROTHERS_JUNIOR_MODEL = "deepseek-chat"

cd packages/harness
node dist/cli.js run "Your task"
```

For different endpoints per role, use the per-role flags instead:
`--senior-base-url/--senior-api-key/--senior-model` and
`--junior-base-url/--junior-api-key/--junior-model` (env
`TWO_BROTHERS_SENIOR_BASE_URL` etc.); `--senior-kind`/`--junior-kind` pick the
wire adapter per role, and `onboard` writes the same settings to
`sessions/settings.json`. The TUI reads those persisted settings too, so a
provider configured for the web workspace or by `onboard` already works when
you open the terminal workspace — and `/provider` inside the TUI connects or
changes one without leaving it (preset or manual endpoint, key masked while
typing and encrypted at rest).

Precedence: CLI flags > environment variables > persisted settings > defaults.
An explicit `--provider` (even one that repeats the default) or
`TWO_BROTHERS_PROVIDER` counts as an explicit request and overrides a
persisted non-default provider; with neither set, the persisted provider stays
in effect.
Environment variables also *pin* their fields: an env value wins over any
Settings edit and is never written to `settings.json`, so a change to a
pinned field in the web UI (or `onboard`) does not stick while the env var
is set.

## CLI

Installed globally, the command is `two-brothers`; from a checkout it is
`node dist/cli.js` in `packages/harness/` after `npm run build`.

```powershell
# one cooperation cycle, offline (deterministic mock provider)
two-brothers run "Plan a migration from Redis to Valkey" --provider mock

# a real OpenAI-compatible endpoint
two-brothers run "Your task" `
  --base-url https://api.deepseek.com/v1 --api-key sk-... `
  --senior-model deepseek-chat --junior-model deepseek-chat --timeout 120

# delegation with tools, and machine-readable output
two-brothers run "Refactor utils.ts" --provider mock --mode work
two-brothers run "Pick a testing scheme" --provider mock --json
two-brothers run "Pick a testing scheme" --provider mock --stream

# REPL, terminal workspace, sessions, web backend
two-brothers chat --provider mock
two-brothers tui --provider mock
two-brothers tui --workspace . --provider mock      # confined tools + approvals
two-brothers sessions --sessions-dir sessions
two-brothers serve --port 8600 --sessions-dir sessions

# write per-role settings from a preset, or list an endpoint's models
two-brothers onboard
two-brothers models --base-url https://api.deepseek.com/v1
```

From a checkout, replace `two-brothers` with `node dist/cli.js`.

| Command | Purpose |
|---|---|
| `run "<task>"` | one call: task → cooperation → decision (live on a TTY; `--no-live` for one render) |
| `chat` | REPL: many tasks in one session, with slash commands (live per turn on a TTY) |
| `tui [task]` | full-screen terminal workspace (`--workspace <dir>` binds confined tools and approvals) |
| `sessions` | list session files with readable titles |
| `selftest` | offline check of the protocol and providers (mock) |
| `serve` | web workspace backend (HTTP + SSE; serves the built UI) |
| `onboard` | write per-role provider settings from a preset or manual fields |
| `models` | list the models an OpenAI-compatible endpoint reports |

`--version` (or `-v`) prints the package version. With no arguments at all,
an interactive terminal drops straight into the full-screen TUI; piped/CI
invocations print the usage screen instead.

Common flags: `--provider`, `--base-url`, `--api-key`, `--senior-model`,
`--junior-model`, `--senior-system`, `--junior-system`, `--max-rounds`,
`--temperature`, `--timeout`, `--retries`, `--mode {consult,work,auto}`,
`--verbose`, `--json`, `--stream`, `--stream-tokens`, `--live`/`--no-live`
(`run`/`chat`), `--session-file <path>`,
`--resume`, `--mcp-config <path>`, `--compact`, `--max-tokens`.
`--mode print|json` / `--json-events` give pipe-clean automation output
(decision-only stdout; one JSON object with
`{task, events, decision, usage, cost, rounds, errors}`).
Full flag, environment-variable, and endpoint reference:
[docs/cli-reference.md](docs/cli-reference.md).

### Persist and resume a session

```powershell
# create a session
node dist/cli.js run "Plan a migration from Redis to Valkey" --provider mock --session-file session.jsonl

# resume it later
node dist/cli.js run "Now plan the rollback" --provider mock --session-file session.jsonl --resume
```

Every protocol envelope is appended to the JSONL file and flushed immediately,
so a crash loses at most the final, partially written line. `--resume` drops
that torn trailing fragment with one bounded warning, repairs the file
atomically, rebuilds the shared context, and continues dense `seq` numbering;
interior corruption still fails loudly. An existing file without `--resume` is
an error — use `--resume` or delete the file.

### Delegation with MCP tools

In `work` mode the junior usually answers with a textual `deliverable`. With
`--mcp-config <path>` (env `TWO_BROTHERS_MCP_CONFIG`) pointing at a JSON file
of MCP server definitions, the junior additionally receives those tools and
executes real work during a delegation:

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

A server may carry `"role": "shared" | "senior" | "junior"` to scope its tools.
A server that fails to start is reported as a warning and the junior continues
text-only. Tools actually used are recorded as `mcp:<name>` entries in the
deliverable's `artifacts`; model-facing names are namespaced
(`mcp__<server>__<tool>`), results are clipped, and every call has a timeout.

## Web workspace

`web/` holds a Vue 3 + Vite + TypeScript workspace that turns the harness into
a local coding assistant: a three-party group chat (Operator / Senior / Junior)
is the only conversation view. Start the backend and open the page:

```powershell
# from packages/harness/, after npm run build
node dist/cli.js serve --port 8600 --sessions-dir sessions
# → http://127.0.0.1:8600
```

What the workspace gives you:

- **Workspaces** — directories you explicitly register through the workspace
  finder (`POST /api/workspaces`); a session is linked to one workspace and
  the sidebar groups sessions by it. Workspaces are registered, never
  scanned.
- **Async live runs** — `POST /api/runs` starts a background run (one active
  run at a time per session, later ones are `queued`) and returns immediately;
  progress streams over SSE (`GET /api/runs/{run_id}/events?after=N`, so a
  dropped connection reconnects without gaps). You can send follow-up
  messages into the same session and stop a run cooperatively. Runs use the
  configured per-role models — there is no separate "mock" switch in the UI;
  the per-role Senior/Junior provider/model/base URL/API key live in the
  Settings dialog, opened from the bottom-left of the sidebar (keys are never
  returned by the API; the server seals them at rest). Settings fields
  pinned by `TWO_BROTHERS_*` env vars show the env value; an edit to a
  pinned field is accepted but transient — the PUT can echo the submitted
  value back in-memory, yet it is never persisted and the env value wins
  again on the next read/run for as long as the env var is set (see
  [Connecting a real model](#connecting-a-real-model)).
- **Workspace tools with docked operator approvals** — in `work` mode with a
  linked workspace the junior gets confined tools (`read_file`, `list_dir`,
  `search_text`, `write_file`, `edit_file`, `delete_file`, `run_shell`) that
  can only touch files inside the workspace; in `consult` mode both brothers
  may use their read-only belts before replying. Reads auto-allow; by default
  every write, edit, delete, or shell command docks an approval card in the
  chat — allow or deny there to resume the run (or stop it — pending
  approvals are then denied). Settings → **Approvals** selects the workspace
  approval mode (Ask / Read only / Edits / Allow all, with an inline warning
  for the permissive one), so an operator can also deny all mutations without
  asking or, explicitly, let edits run unattended. Shell/delete requests state
  their honest reason (write/edit show their diff) and the card can expand a
  bounded diff/command preview. The senior additionally gets read-only
  workspace checks (including approval-brokered `run_shell`) to verify the
  junior's work before reviewing it. `Up`/`Down` in the composer recall
  earlier accepted tasks. Below the drawer breakpoint the sidebar turns into a
  drawer over the chat (backdrop, Escape, focus handling).
- **Sessions and presets** — session files listed with readable titles and
  workspace grouping, plus named provider presets (seeded: openai, deepseek,
  anthropic, gemini, openrouter, lmstudio, custom) that a role can reference;
  API keys are write-only and sealed at rest. A customized built-in seed has
  **Reset to default**, which removes the stored override and its key while the
  role references stay.
- **Runtime sidecars** — tool calls, diffs, approvals, run status, and prompt
  audits are persisted per session in `sessions/runtime/<name>.events.jsonl`,
  so a browser reload recovers the full activity history; the protocol JSONL
  stays a pure envelope log.
- **Changed-file review** — files written or edited by tools are collected
  with their unified diffs for review in the UI.

The built UI ships in the npm tarball (the `prepack` step copies `web/dist`
into the package), so a global install serves the workspace with no separate
frontend build.

Full endpoint list: [docs/cli-reference.md](docs/cli-reference.md).

## Status

The TypeScript package passes its full gate suite (typecheck, build, selftest,
unit + spawn test runners, hermetic CLI E2E, supply-chain checks, publish
gates). One-shot offline check:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/smoke-test.ps1
```

It runs the package gates, the `typescript/` reference selftest, a mock demo
run, the web unit tests, and the web build; expected final line:
`SMOKE TEST: PASS`.

Real-model evidence: a consult cycle with two local LM Studio models
(`LMSTUDIO-TRANSCRIPT.md`) and a full cooperation cycle with `spark-x2.6` via
the DSH `xhtoken` provider (`SPARK-TRANSCRIPT.md`).

## Repository layout

| Path | Contents |
|---|---|
| [`PROTOCOL.md`](PROTOCOL.md) | the main message contract |
| [`DESIGN.md`](DESIGN.md) | why this is cooperation, not subagents |
| [`shared/`](shared/) | shared system prompts (`prompts.json`) and JSON Schema (`protocol.schema.json`) |
| [`packages/harness/`](packages/harness/) | the TypeScript package: cooperation core, CLI, HTTP/SSE server, workspace tools, plugins, skills |
| [`typescript/`](typescript/) | zero-dependency reference implementation of the same protocol |
| [`web/`](web/) | local single-user web workspace — Vue 3 + Vite + TypeScript (builds to `web/dist`, served by the TypeScript server; the npm tarball ships a copy) |
| [`plugins/`](plugins/) | local plugin modules (`register(ctx)` tool registration; see `docs/plugins.md`) |
| [`e2e/`](e2e/) | browser E2E (Playwright drives the system Edge headless) |
| [`scripts/`](scripts/) | `smoke-test.ps1` — offline gate; `e2e-test.ps1` — browser E2E runner |
| [`docs/`](docs/) | one flat documentation set, indexed by [docs/README.md](docs/README.md) |
| [`docs/history/`](docs/history/) | historical records: port plan, CLI and web-UI audits, verification log |
| `research/` | local-only research notes + vendored MIT reference clones (gitignored — never published) |
| [`SPARK-TRANSCRIPT.md`](SPARK-TRANSCRIPT.md) / [`LMSTUDIO-TRANSCRIPT.md`](LMSTUDIO-TRANSCRIPT.md) | captured real-model cooperation cycles (evidence) |
| [`AGENTS.md`](AGENTS.md) | instructions for coding agents |

## Documentation

- Start here: [Quickstart](docs/quickstart.md), [CLI reference](docs/cli-reference.md)
- Extend: [Plugins](docs/plugins.md), [Testing](docs/testing.md)
- Project: [Backlog](docs/backlog.md), [Design review](docs/design-review.md), [Release runbook](docs/release.md)
- History: [TS rewrite plan](docs/history/ts-rewrite-plan.md), [CLI audit](docs/history/cli-audit.md), [web UI audit](docs/history/web-ui-audit.md), [verification log](docs/history/handoff.md)
- Contracts: [Protocol](PROTOCOL.md), [Design](DESIGN.md), [JSON Schema](shared/protocol.schema.json)
- Full index: [docs/README.md](docs/README.md)

## Acknowledgements

Two Brothers takes inspiration from these projects and their communities:

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — workspace-oriented interfaces, session management, and coding-agent workflows.
- [Kimi Code](https://github.com/MoonshotAI/kimi-code) — clean conversation design, tool interaction, and permission workflows.
- [OpenHarness](https://github.com/HKUDS/OpenHarness) — practical patterns for permissions, tool execution, streaming events, and reliability.
- [DeepAgents](https://github.com/langchain-ai/deepagents) — graph-based multi-agent architecture, filesystem backends, and human-in-the-loop approvals.

Thank you to their teams and contributors for sharing their work and documentation.

## License

MIT.

## Contributing

Bug reports, protocol discussion, and pull requests are welcome. New features
and protocol work land in the TypeScript package (`packages/harness/`); the
zero-dependency `typescript/` tree is the protocol reference. Setup, the gates
a pull request must keep green, and the repo layout are in
[CONTRIBUTING.md](CONTRIBUTING.md); report vulnerabilities through
[SECURITY.md](SECURITY.md), not public issues.