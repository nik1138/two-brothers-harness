# @two-brothers/harness

A harness for cooperation between **two sibling AI agents** sharing one
context: a **senior** (the older brother — experienced, level-headed, the
arbiter) and a **junior** (the younger brother — brave, determined, the
challenger). They exchange structured protocol messages; the senior
consults the junior, may delegate work to it, reviews what comes back, and
makes the final decision. Not subagents — **parallel models with explicit
roles** advising each other as peers within a single context.

TypeScript, Node ≥ 22.19, zero-dependency core with two curated runtime
dependencies (`zod` for payload validation, `@earendil-works/pi-mcp` for
MCP). MIT.

## Install

v0.0.1 is the latest published release:

```bash
npm install -g @two-brothers/harness
```

Source build (any version): clone
`https://github.com/nik1138/two-brothers-harness.git`, then
`cd packages/harness`, `npm install`, `npm run build`, and use
`node dist/cli.js` (or `npm link` for a global `two-brothers`).

## Quick start

`two-brothers --version` (or `-v`) prints the installed package version.
Offline against the built-in mock provider:

```bash
two-brothers run "Plan a migration from Redis to Valkey" --provider mock
```

With real models (any OpenAI-compatible endpoint — DeepSeek, OpenAI,
OpenRouter, vLLM, Ollama, LM Studio):

```bash
export TWO_BROTHERS_BASE_URL="https://api.deepseek.com/v1"
export TWO_BROTHERS_API_KEY="sk-..."
export TWO_BROTHERS_SENIOR_MODEL="deepseek-chat"
export TWO_BROTHERS_JUNIOR_MODEL="deepseek-chat"

two-brothers run "Your task"
```

Different providers per role (Anthropic and Google Gemini are first-class
adapters, selected with `--senior-kind` / `--junior-kind`):

```bash
two-brothers run "Your task" \
  --senior-base-url https://api.anthropic.com --senior-api-key sk-ant-... \
  --senior-model claude-sonnet-4-5 --senior-kind anthropic \
  --junior-base-url https://generativelanguage.googleapis.com \
  --junior-api-key AIza... --junior-model gemini-2.5-pro --junior-kind google
```

Programmatic use:

```ts
import { TwoBrothersHarness, resolveConfig } from "@two-brothers/harness";

const harness = new TwoBrothersHarness(resolveConfig({
  provider: "openai",
  baseUrl: "https://api.deepseek.com/v1",
  apiKey: process.env.DEEPSEEK_API_KEY!,
  seniorModel: "deepseek-chat",
  juniorModel: "deepseek-chat",
}));
const result = await harness.run("Plan a migration from Redis to Valkey");
console.log(result.decision);
```

## Terminal workspace

A bare interactive `two-brothers` (or `tui [task]`) opens a zero-dependency
full-screen TUI over the same harness: block transcript, grapheme-aware
multiline composer, Ctrl+P palette / `?` help, session and model pickers,
token streaming in place, width-aware folded tool-result previews (six visual
rows by default; `Ctrl+T` toggles preview/full text), theme-painted overlay
lists, a dim `⋯` marker when a transcript window starts mid-block, a status bar
that rotates a registry-derived tip per accepted turn (with brief transient
hints, including the quit path while an approval is parked), resize repaint,
and cancellable
non-blocking turns. Piped no-arg invocations print the usage screen instead;
`chat` stays the plain REPL for scripts.

`tui --workspace <dir>` binds every turn to one confined root: the junior gets
the `workspace_*` tool belt and the senior the read-only verify slice, writes/
edits/deletes/shell park the run on a docked approval panel (`1`/`y` allow
once, `2`/`a` allow for this TUI process only, `3`/`n`/`Esc` deny,
`Ctrl+E` full-screen diff/command preview; stopping denies everything
pending), composer `@path` mentions attach workspace files read-only, a plan
panel docks above the composer (snapshots persist to the session's runtime
sidecar when the session has a `--session-file`, so a restart replays the
plan), `/provider` connects a provider from the same persisted settings the
web workspace and `onboard` write (preset or manual endpoint; the typed key is
masked and encrypted at rest), and `Up`/`Down` recall earlier submitted tasks
at the draft edges (single-line drafts immediately; multiline only at their
very start/end, with the live draft restored exactly). A running turn accepts
steering from the composer (`Ctrl+N`, also the palette's **Steer the running
turn** row): the text is queued for that turn at its next step, bounded to
eight pending texts of 4 000 characters, with queued/applied/leftover copy and
the draft cleared only on acceptance; `Enter` still refuses while a turn runs.
`/permission` states
the effective approval mode and its honest description (with the `allow-all`
warning), the bound-root policy and this process's session allows; without a
`--approval-mode`/env pin its buttons persist one of the four modes — `ask`,
`readonly`, `edits`, `allow-all` — to `sessions/settings.json`, with a pin it
says so and offers only Close, and `/permission <mode>` applies one directly.
An invalid root exits 2 before the screen opens.

`Ctrl+X` copies the last completed reply (the newest decision, or the newest
completed senior reply) as plain text: the platform clipboard is tried first,
OSC 52 is the fallback where no OS clipboard is reachable, and the notice names
the route honestly. `Ctrl+G` opens the draft in `$VISUAL`/`$EDITOR`
(Windows falls back to `notepad.exe`; a nonzero exit leaves the draft
untouched). While the TUI runs, the terminal title carries
`Two Brothers — <session> · working|approval|done|failed`, every exit path
restores it, and a parked approval raises one OSC 9/BEL notification (tmux gets
a DCS passthrough). A non-TTY or `TERM=dumb` session writes nothing.

The human `run`/`chat` text mode renders each envelope as a separated block,
model prose as width-safe Markdown (sanitized first), the decision behind a
ruled `── decision ──` line, and, when usage exists, a compact footer such as
`tokens 40 in / 20 out · cache 25% · 4 calls · cost $0.0300`. On an interactive
terminal it streams live block by block with dim activity rows
(`--live`/`--no-live`; piped output prints once); `--json`,
`--json-events`, `--stream` and `--mode print` stay byte-identical machine
modes.

## Web workspace

```bash
two-brothers serve --port 8600 --sessions-dir sessions
# open http://127.0.0.1:8600
```

A local single-user coding workspace (Vue app served by the same binary; the
npm tarball ships the built app, so no separate frontend build is needed):
three-party Operator/Senior/Junior group chat, operator-registered
workspaces picked through a single finder, workspace-grouped sessions,
confined junior tools with docked per-mutation approval cards (a mobile
drawer below the breakpoint) that state the honest reason for shell/delete
requests and expand a bounded diff/command preview (write/edit rely on their
diff), async runs with live SSE progress, a bounded
queue dock for submissions made while a run works (Send reads **Queue**;
per-row Stop cancels a queued run immediately and the next queued run is
followed automatically), changed-file diff review, and a bottom-left Settings
dialog for the per-role provider presets with sealed API keys. Completed runs'
tool rows fold into a disclosure summary, the composer carries truthful status
seats (models, permission expectation, latest prompt-audit context sizes), a
welcome hero greets an empty session (context, actions and editable starter
suggestions), and a **Plan** dock mirrors the model's todo list. A customized
built-in seed has **Reset to default**, which clears the stored override
without touching the Senior/Junior role references, and the provider detail has
**Refresh models** — an explicit, non-saving probe of the current draft's
OpenAI-compatible endpoint (`POST /api/providers/{name}/discover`; an empty
answer is valid and a typed key is one-shot). An approval card can
**Always allow this session**, remembering an `(action, target)` pair in the
session settings while one-shot allow/deny, the denial cap and the fail-closed
default are unchanged. Settings → **Approvals** selects the workspace
approval mode (Ask / Read only / Edits / Allow all) with honest copy and an
inline destructive warning for `allow-all`; the mode is stored in
`sessions/settings.json`, a flag/env pin is reported read-only, an older
backend without the field shows Ask and never receives a patch, and the mode
never bypasses workspace confinement. `Up`/`Down` in the composer recall
earlier accepted tasks at the draft edges and restore the live draft exactly.
Runs use the configured models — the UI has no separate
"mock" switch. The browser tab title tracks the selected session and run state
(`▶` running/queued, `!` waiting, `(failed)`, an unread count when nothing is
selected), so a background tab shows when the brothers need you. Settings →
**Advanced** saves the persisted auto-compaction budgets (`compaction` in
`sessions/settings.json`); a pinned server flag/env wins and is shown as
pinned, and a provider preset's **Context window (tokens)** is the last
fallback (the smaller of the two roles' windows). Settings → **Providers**
edits that preset field with strict whole-number validation (0 = unknown). An
operator message bubble offers **Fork from here…**, which copies the
conversation up to that message into a new session (`{seq}`) and opens it while
the original and its sidecar stay byte-identical.

## Features

- **Cooperation loop**: consult → proposal → review → (revise)* → decision,
  with delegation → deliverable in `work` mode; the junior's objections are
  recorded explicitly (`decision.dissent`).
- **Tools for both brothers**: in consult mode the senior's opening, the
  junior's proposal/revision and the senior's review may call a read-only
  workspace belt before emitting the structured reply (bounded; the four
  workspace mutation built-ins are always excluded, while operator-installed
  MCP/plugin tools stay as their role scopes grant them); tool-less
  configurations keep the exact pre-tools
  request path, and work mode keeps its mutating junior deliverable loop and
  the senior's read-only verify slice unchanged.
- **Approval modes and guardrails**: Ask (default) / Read only / Edits /
  Allow all as a persisted, operator-selected policy
  (`sessions/settings.json` `approval_policy`, `--approval-mode`/env pins never
  persisted); visible warnings for the permissive mode, a fail-closed default
  for corrupt/missing policy, workspace confinement and sensitive-path
  refusals unaffected by the mode, and the policy cannot be set by a model or
  a tool.
- **Mid-run steering**: an operator can steer a cooperation cycle that is
  already working (`POST /api/runs/{run_id}/steer`; web composer **Steer
  run**/`Alt+Enter`): the text is appended to the shared context as an
  ordinary operator message at the run's next step — never a queued task —
  with a bounded pending queue and an honest `steering_dropped` report when
  the per-run envelope cap is reached. The TUI queues composer text with
  `Ctrl+N` (also the palette) under the same bounds.
- **Composer prompt recall**: Up/Down walk accepted submissions in the TUI and
  the web composer, newest first, preserving and restoring the live draft
  exactly (multiline drafts only leave at their edges; only submitted tasks
  are recallable).
- **Structured prompt sections**: per-call `## Available tools` and tool-use
  directives assembled in code, plus a per-call prompt audit trail
  (observable as an SSE runtime event).
- **Providers**: OpenAI-compatible, Anthropic Messages, and Google Gemini
  adapters behind one interface; per-role endpoints; deterministic offline
  `mock`; provider error classification (fail-fast 4xx, `Retry-After`
  honoring, context-overflow detection) ported from pi-ai. Built-in presets
  can be customized, `POST /api/providers/{name}/reset` restores a customized
  built-in seed without touching role references, and
  `POST /api/providers/{name}/discover` probes a draft OpenAI-compatible
  endpoint for its model list without saving (empty answers valid, typed key
  one-shot).
- **Anthropic prompt caching**: every Anthropic Messages request carries up to
  three `cache_control:{type:"ephemeral"}` breakpoints (merged system prompt,
  last tool definition, newest conversation turn), so the repeated prefix of a
  cooperation cycle is read from the 5-minute cache on the 2nd..Nth call;
  usage reports real cached tokens and the OpenAI-compatible/Gemini request
  bodies are unchanged.
- **MCP tool loading** (stdio + streamable HTTP) with role scoping,
  `mcp__server__tool` namespacing, result caps, and per-call timeouts.
- **Session persistence** as JSONL transcripts (dense `seq`, `--resume`),
  context **compaction** with token-aware budgets
  (`--context-window`, `--compact-threshold-tokens`).
- **Run-scoped file undo**: a workspace-bound run captures the pre/post bytes
  of every `workspace_write_file`/`workspace_edit_file`/`workspace_delete_file`
  mutation under `<sessions>/undo` (a persisted session side artifact, bounded
  to the newest 20 records per session and 30 days, with orphan-blob GC), and
  `GET/POST/DELETE /api/sessions/{name}/undo/{run_id}` preview, apply or
  discard the revert — per file, refusing files changed since the run and
  never overwriting them, restoring POSIX mode where captured. The web
  workspace exposes **Undo file changes…** for the newest completed run, and
  `sessions undo <name>` previews/applies/discards the same record from the
  CLI.
- **Plugins**: drop ES-module files in `plugins/` exposing
  `register(ctx)` — tools are shared by both brothers.
- **Skills**: `<root>/<name>/SKILL.md` files become a role-scoped
  `## Available skills` prompt section; `<skill name="…">` requests inject
  the body on demand.
- **Slash commands**: markdown prompt templates expanded literally in the
  chat REPL and the TUI (`/name args`, `$ARGUMENTS`, `$1`..`$9`).
- **Plan/todo function**: the built-in `todo_write` tool replaces the model's
  whole plan in one call (tolerant `{content, status}` snapshot, no approval,
  never touches the workspace) and emits one additive `todo_updated` runtime
  event — sidecar-persisted, SSE-streamed and replayed — that feeds the TUI
  plan panel and the web Plan dock; `HarnessResult.todos` carries the final
  snapshot.
- **Reasoning capture and replay**: with `--stream-tokens`, provider reasoning
  is buffered/sanitized/bounded, emitted as additive `reasoning` runtime
  events and persisted in the session runtime sidecar; the TUI replays bounded
  `THINKING (replayed)` rows (the web transcript replays collapsed
  **Thinking · replayed** rows). No protocol or session-JSONL change.
- **Anthropic extended thinking**: `--thinking-budget` /
  `TWO_BROTHERS_THINKING_BUDGET` requests thinking for Anthropic Messages
  roles and captures signed/redacted thinking blocks, echoing them verbatim
  on tool-loop assistant turns; other adapters ignore it and unset requests
  stay byte-identical.
- **File-configured TUI key rebinding**: `tui --keys-file` /
  `TWO_BROTHERS_TUI_KEYS_FILE` reads a versioned JSON document that rebinds
  only the global palette/help/stash chords; the effective chords drive
  matching, the palette/help listings, status hints and `tui --help`, while
  invalid/conflicting files print one diagnostic and keep the defaults.
- **Server**: HTTP + SSE on plain `node:http`; worker pool, approval broker
  (one-shot or session-scope allows persisted in the settings store),
  settings/secret stores (DPAPI/`plain1:`).

## Documentation

- Protocol contract and design: [PROTOCOL.md](https://github.com/nik1138/two-brothers-harness/blob/main/PROTOCOL.md) · [DESIGN.md](https://github.com/nik1138/two-brothers-harness/blob/main/DESIGN.md)
- CLI and API reference: [docs/cli-reference.md](https://github.com/nik1138/two-brothers-harness/blob/main/docs/cli-reference.md)
- Documentation index: [docs/README.md](https://github.com/nik1138/two-brothers-harness/blob/main/docs/README.md)
- Port history: [docs/history/ts-rewrite-plan.md](https://github.com/nik1138/two-brothers-harness/blob/main/docs/history/ts-rewrite-plan.md)

## License

MIT — see [LICENSE](https://github.com/nik1138/two-brothers-harness/blob/main/LICENSE).
