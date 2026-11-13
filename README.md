# Two Brothers

[![ci](https://github.com/nik1138/two-brothers-harness/actions/workflows/ci.yml/badge.svg)](https://github.com/nik1138/two-brothers-harness/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg?style=flat)](LICENSE)
[![Node ≥ 22.19](https://img.shields.io/badge/node-%E2%89%A5%2022.19-339933?style=flat)](https://nodejs.org)

A harness for cooperation between two agents: a **senior** (the older brother —
experienced, level-headed, the arbiter) and a **junior** (the younger brother —
brave, determined, the challenger). Both work with **one shared context**, have
**different system prompts**, and exchange **structured protocol messages**: the
senior consults the junior, may delegate part of the work to it, reviews what
comes back, and makes the final decision. The brothers are peers, not a
subagent hierarchy — in `serve`/web runs the Senior may additionally hand
focused side tasks to helper subagents, a separate tier described below.

The implementation is the TypeScript package in
[`packages/harness/`](packages/harness/) (`@two-brothers/harness`, written in
the style of pi / deepseek-harness). **v0.0.1 is published on npm** — note that
the published release may lag this repository; building from a checkout with
the [Quickstart](docs/quickstart.md) always gets current `main` (offline, no
API key). The full flag, environment-variable, and endpoint reference is
[docs/cli-reference.md](docs/cli-reference.md).

## Install

```powershell
npm install -g @two-brothers/harness
two-brothers --help
```

Requirement: **Node ≥ 22.19** (the package's `engines` floor). The npm tarball
ships the built web workspace, so a global install needs no separate frontend
build.

## Quick start

From a checkout:

```powershell
cd packages/harness
npm install
npm run build                                     # tsc → dist/

# 1. one cooperation cycle, offline (deterministic mock provider)
node dist/cli.js run "Plan a migration from Redis to Valkey" --provider mock

# 2. the web workspace — the server serves the built UI, so build it first:
cd ../../web
npm install
npm run build                                     # → web/dist
cd ../packages/harness
node dist/cli.js serve --port 8600 --sessions-dir sessions
#    → http://127.0.0.1:8600

# 3. the terminal workspace (a bare interactive `two-brothers` opens this TUI)
node dist/cli.js tui --provider mock
node dist/cli.js tui --workspace . --provider mock   # confined tools + operator approvals
```

The `run` output is the full conversation: `[user]`,
`[senior -> junior] consult`, `[junior -> senior] proposal`,
`[senior -> junior] review`, `[senior -> user] decision`. On an interactive
terminal the transcript streams live block by block; piped output and every
machine mode (`--json`, `--stream`, …) stay byte-stable. With no arguments at
all, an interactive terminal opens the TUI directly; piped/CI invocations print
the usage screen. Details: [Quickstart](docs/quickstart.md).

For frontend development: `cd web && npm run dev` (Vite proxies `/api` to
:8600).

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

## Highlights

- **Two-role cooperation core** — `consult`, `work`, and `auto` (the senior
  picks the route) modes over one shared append-only context; dissent is
  recorded in the decision. ([PROTOCOL.md](PROTOCOL.md))
- **Workspace tools with operator approvals** — a confined workspace directory;
  reads auto-allow, writes/edits/deletes/shell park on an approval card, and
  four permission presets (Read only / Always ask / Workspace write / Full
  access) set the policy. ([Approval modes](docs/cli-reference.md#approval-modes))
- **Helper subagents (`serve`/web, and TUI observation)** — the Senior may
  spawn isolated single-role helpers with their own context and provider; a
  mutating helper is workspace- and approval-constrained (its mutations are
  ordinary operator approvals on the parent run), the operator can interrupt a
  live helper and send one bounded follow-up, `background:true` runs the helper
  concurrently (`subagent_report` reads its report), and the TUI observes live
  children with `Ctrl+Y` (the `/agents` overlay; `i` interrupts, `m` drafts a
  follow-up in the detail view). ([Quickstart](docs/quickstart.md#the-web-workspace))
- **Tolerant protocol boundary** — model output is parsed tolerantly, gets
  exactly one repair re-ask, then a sanitize-and-defaults fallback; the
  boundary never throws and prompt-cache prefixes stay stable.
- **Context compaction** — pi's algorithm on our envelope format: char/token
  budgets, incremental summaries, split-payload cuts, and one compact-and-retry
  on provider context overflow.
- **Sessions** — every envelope is flushed to a JSONL session file;
  `--resume` rebuilds the context; `sessions` lists, shows, searches, exports,
  forks, rewinds, previews/applies run-scoped file undo, and migrates the
  storage layout. ([Session storage](docs/session-storage.md),
  [CLI reference](docs/cli-reference.md#sessions))
- **Providers and presets** — OpenAI-compatible, Anthropic, and Gemini wire
  adapters behind one interface with an ordered retry registry; a curated
  preset table, `onboard` for per-role setup, `models` to probe an endpoint,
  and cost estimates. ([CLI reference](docs/cli-reference.md))
- **Streaming and reasoning capture** — `--stream` NDJSON events, in-place
  token streaming, and bounded reasoning capture replayed in the web and TUI
  transcripts.
- **Plugins, skills, slash commands, MCP** — ES-module plugins
  (`register(ctx)`: tools, hooks, scopes, MCP servers), `SKILL.md` skills, and
  markdown slash-command templates with built-in actions. ([Plugins](docs/plugins.md))
- **Three workspaces, one harness** — a CLI/`run` transcript, a Vue 3 web
  workspace (`serve`), and a full-screen zero-dependency TUI, all over the same
  core and persisted settings. ([Quickstart](docs/quickstart.md))
- **Zero-dependency protocol reference** — [`typescript/`](typescript/)
  implements `PROTOCOL.md` with no npm packages and no build step; it documents
  the contract.

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

Per-role endpoints use `--senior-base-url/--senior-api-key/--senior-model` and
the junior counterparts (env `TWO_BROTHERS_SENIOR_BASE_URL` etc.);
`--senior-kind`/`--junior-kind` pick the wire adapter; `onboard` writes the same
settings to `sessions/settings.json`, which the web workspace and the TUI
(`/provider`) read too. Precedence: CLI flags > environment variables >
persisted settings > defaults; an env var also *pins* its field (it wins over
Settings edits and is never persisted). Full table:
[docs/cli-reference.md](docs/cli-reference.md).

## CLI

Installed globally, the command is `two-brothers`; from a checkout it is
`node dist/cli.js` in `packages/harness/` after `npm run build`.

```powershell
two-brothers run "Plan a migration from Redis to Valkey" --provider mock
two-brothers run "Refactor utils.ts" --provider mock --mode work
two-brothers run "Pick a testing scheme" --provider mock --json
two-brothers chat --provider mock
two-brothers tui --workspace . --provider mock
two-brothers serve --port 8600 --sessions-dir sessions
```

| Command | Purpose |
|---|---|
| `run "<task>"` | one call: task → cooperation → decision (live on a TTY; `--no-live` for one render) |
| `chat` | REPL: many tasks in one session, with slash commands |
| `tui [task]` | full-screen terminal workspace (`--workspace <dir>` binds confined tools and approvals) |
| `sessions` | session files: `show`, `search`, `export`, `fork`, `rewind`, `undo`, `migrate` (see the [CLI reference](docs/cli-reference.md#sessions)) |
| `serve` | web workspace backend (HTTP + SSE; serves the built UI) |
| `doctor` | offline configuration check — engine, settings, roles, endpoint, web assets, plugins |
| `models` | list the models an OpenAI-compatible endpoint reports |
| `onboard` | write per-role provider settings from a preset or manual fields |
| `config` | print the resolved configuration and which layer supplied each field |
| `completions` | shell completion scripts (`bash`/`zsh`/`fish`/`powershell`) |
| `spill` | inspect/prune the spilled tool-output store |
| `selftest` | offline check of the protocol, providers, and one cooperation loop |
| `help` | overview, per-command flags, or `--all` |

`--version` (or `-v`) prints the package version. Common flags: `--provider`,
`--base-url`, `--api-key`, `--senior-model`, `--junior-model`,
`--max-rounds`, `--temperature`, `--timeout`, `--retries`,
`--mode {consult,work,auto}`, `--verbose`, `--json`, `--stream`,
`--session-file <path>`, `--resume`, `--mcp-config <path>`, `--compact`,
`--max-tokens`, `--approval-mode`. Everything else:
[docs/cli-reference.md](docs/cli-reference.md).

## Status

The TypeScript package passes its full gate suite (typecheck, build, selftest,
unit + spawn test runners, hermetic CLI E2E, supply-chain checks, publish
gates). One-shot offline check from the repo root:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/smoke-test.ps1
```

Expected final line: `SMOKE TEST: PASS`. What's covered where:
[docs/testing.md](docs/testing.md).

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
| [`AGENTS.md`](AGENTS.md) | instructions for coding agents |

## Documentation

- Start here: [Quickstart](docs/quickstart.md), [CLI reference](docs/cli-reference.md)
- Extend: [Plugins](docs/plugins.md), [Testing](docs/testing.md)
- Project: [Backlog](docs/backlog.md), [Design review](docs/design-review.md), [Release runbook](docs/release.md)
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
