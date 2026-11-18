# Two Brothers

[![ci](https://github.com/nik1138/two-brothers-harness/actions/workflows/ci.yml/badge.svg)](https://github.com/nik1138/two-brothers-harness/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg?style=flat)](LICENSE)
[![Node ≥ 22.19](https://img.shields.io/badge/node-%E2%89%A5%2022.19-339933?style=flat)](https://nodejs.org)

Two Brothers is a harness for cooperation between two agents: a **senior** (the
older brother — the arbiter) and a **junior** (the younger brother — the
challenger). Both share **one context**, have **different system prompts**, and
exchange **structured protocol messages** — the senior consults the junior,
reviews the result, and makes the final decision. The brothers are peers, not a
subagent hierarchy. The implementation is the TypeScript package in
[`packages/harness/`](packages/harness/) (`@two-brothers/harness`).

## Quick start

Requires **Node ≥ 22.19**. The current release is **0.0.2**, published on npm:

```bash
npm install -g @two-brothers/harness
two-brothers --help
```

Pick a workspace — the npm tarball ships the built web app, so there is no
separate frontend build:

```bash
two-brothers serve --port 8600                                            # web workspace → http://127.0.0.1:8600
two-brothers run "Plan a migration from Redis to Valkey" --provider mock  # one offline cycle
two-brothers tui --provider mock                                          # terminal workspace
```

From a checkout — the same commands via `node dist/cli.js …`, offline with the
deterministic mock provider:

```bash
cd packages/harness
npm install && npm run build                    # tsc → dist/

# 1. one cooperation cycle, offline
node dist/cli.js run "Plan a migration from Redis to Valkey" --provider mock

# 2. web workspace — build the UI, then serve it
cd ../../web && npm install && npm run build    # → web/dist
cd ../packages/harness
node dist/cli.js serve --port 8600              # → http://127.0.0.1:8600

# 3. terminal workspace (a bare interactive `two-brothers` opens this)
node dist/cli.js tui --provider mock
```

The `run` transcript shows the whole conversation: `[user]`, `[senior -> junior]
consult`, `[junior -> senior] proposal`, `[senior -> junior] review`,
`[senior -> user] decision`. More: [Quickstart](docs/quickstart.md).

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

Protocol in brief (full contract: [PROTOCOL.md](PROTOCOL.md), JSON Schema:
[shared/protocol.schema.json](shared/protocol.schema.json)):

- **Envelope**: `{v, id, seq, ts, from, to, kind, payload}`.
- **Kinds**: `consult`, `proposal`, `delegation`, `deliverable`, `review`,
  `decision`, `message`.
- **Cycle**: consult → proposal → review → (revise)* → decision.

Why this is cooperation, not subagents: [DESIGN.md](DESIGN.md).

## Highlights

- **Two-role cooperation core** — `consult` / `work` / `auto` modes over one shared append-only context; dissent is recorded in the decision.
- **Workspace tools with operator approvals** — confined workspace directory; reads auto-allow, writes park on an approval card, four permission presets.
- **Context compaction & sessions** — pi's compaction on the envelope format; every envelope flushed to JSONL, `--resume` rebuilds the context.
- **Providers and presets** — OpenAI-compatible, Anthropic, and Gemini adapters with an ordered retry registry; `onboard`, `models`, cost estimates.
- **Plugins, skills, slash commands, MCP** — ES-module plugins, `SKILL.md` skills, markdown slash-command templates.
- **Three workspaces, one harness** — CLI `run` transcript, Vue 3 web workspace (`serve`), and a zero-dependency TUI over one core.
- **Zero-dependency protocol reference** — [`typescript/`](typescript/) implements `PROTOCOL.md` with no npm packages and no build step.

## Connecting a real model

Set environment variables (any OpenAI-compatible endpoint — DeepSeek, OpenAI, OpenRouter, vLLM, Ollama, LM Studio; Anthropic and Gemini via adapters):

```bash
export TWO_BROTHERS_BASE_URL="https://api.deepseek.com/v1"
export TWO_BROTHERS_API_KEY="sk-..."
export TWO_BROTHERS_SENIOR_MODEL="deepseek-chat"
export TWO_BROTHERS_JUNIOR_MODEL="deepseek-chat"

cd packages/harness
node dist/cli.js run "Your task"
```

Prefer a guided setup? `two-brothers onboard` writes per-role provider settings
interactively. Per-role endpoints, wire adapters, and persisted settings:
[docs/cli-reference.md](docs/cli-reference.md).

## CLI

Installed globally the command is `two-brothers`; from a checkout it is
`node dist/cli.js` (after `npm run build`).

| Command | Purpose |
|---|---|
| `run "<task>"` | one call: task → cooperation → decision |
| `chat` | REPL: many tasks in one session |
| `tui [task]` | full-screen terminal workspace |
| `sessions` | show, search, export, fork, rewind, undo, migrate |
| `serve` | web workspace backend (HTTP + SSE) |
| `doctor` | offline configuration check |
| `models` | list models an OpenAI-compatible endpoint reports |
| `onboard` | write per-role provider settings |
| `config` | print the resolved configuration |
| `completions` | shell completion scripts |
| `spill` | inspect/prune spilled tool-output store |
| `selftest` | offline protocol + cooperation-loop check |
| `help` | overview and per-command flags |

Full flags and per-command detail: [docs/cli-reference.md](docs/cli-reference.md).

## Status

The package passes its full offline gate suite (typecheck, build, unit + spawn
runners, hermetic CLI E2E, supply-chain checks). What's covered where:
[docs/testing.md](docs/testing.md); contributor gates:
[CONTRIBUTING.md](CONTRIBUTING.md).

## Repository layout

| Path | Contents |
|---|---|
| [`PROTOCOL.md`](PROTOCOL.md) | the main message contract |
| [`DESIGN.md`](DESIGN.md) | why this is cooperation, not subagents |
| [`shared/`](shared/) | system prompts and the protocol JSON Schema |
| [`packages/harness/`](packages/harness/) | the TypeScript package: core, CLI, server, tools, plugins |
| [`typescript/`](typescript/) | zero-dependency reference implementation |
| [`web/`](web/) | Vue 3 + Vite web workspace (builds to `web/dist`) |
| [`e2e/`](e2e/) | browser E2E (Playwright, system Edge headless) |
| [`scripts/`](scripts/) | offline smoke gate and E2E runner |
| [`docs/`](docs/) | documentation, indexed by [docs/README.md](docs/README.md) |

## Documentation

- Start here: [Quickstart](docs/quickstart.md), [CLI reference](docs/cli-reference.md)
- Extend: [Plugins](docs/plugins.md), [Testing](docs/testing.md)
- Project: [Backlog](docs/backlog.md), [Design review](docs/design-review.md), [Release runbook](docs/release.md)
- Contracts: [Protocol](PROTOCOL.md), [Design](DESIGN.md), [JSON Schema](shared/protocol.schema.json)
- Full index: [docs/README.md](docs/README.md)

## Acknowledgements

Inspired by [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness),
[Kimi Code](https://github.com/MoonshotAI/kimi-code),
[OpenHarness](https://github.com/HKUDS/OpenHarness), and
[DeepAgents](https://github.com/langchain-ai/deepagents). Thank you to their
teams and contributors.

## License

MIT — see [LICENSE](LICENSE).

## Contributing

Pull requests and protocol discussion are welcome. Setup and the required
gates: [CONTRIBUTING.md](CONTRIBUTING.md). Vulnerabilities:
[SECURITY.md](SECURITY.md), not public issues.
