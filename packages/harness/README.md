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

> **Pre-release:** v0.0.1 has not been published to npm yet — the install
> command below is the intended path once the package is published. Until
> then, build from a checkout:
> `git clone https://github.com/nik1138/two-brothers-harness.git`,
> `cd packages/harness`, `npm install`, `npm run build`, then use
> `node dist/cli.js` (or `npm link` for a global `two-brothers`).

## Install

```bash
npm install -g @two-brothers/harness
```

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
rows by default; `Ctrl+T` toggles preview/full text), resize repaint, and
cancellable non-blocking turns. Piped no-arg invocations print the usage
screen instead; `chat` stays the plain REPL for scripts.

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
drawer below the breakpoint), async runs with live SSE progress,
changed-file diff review, and a bottom-left Settings dialog for the per-role
provider presets with sealed API keys. A customized built-in seed has
**Reset to default**, which clears the stored override without touching the
Senior/Junior role references. Runs use the configured models — the UI has no
separate "mock" switch.

## Features

- **Cooperation loop**: consult → proposal → review → (revise)* → decision,
  with delegation → deliverable in `work` mode; the junior's objections are
  recorded explicitly (`decision.dissent`).
- **Structured prompt sections**: per-call `## Available tools` and tool-use
  directives assembled in code, plus a per-call prompt audit trail
  (observable as an SSE runtime event).
- **Providers**: OpenAI-compatible, Anthropic Messages, and Google Gemini
  adapters behind one interface; per-role endpoints; deterministic offline
  `mock`; provider error classification (fail-fast 4xx, `Retry-After`
  honoring, context-overflow detection) ported from pi-ai. Built-in presets
  can be customized, and `POST /api/providers/{name}/reset` restores a
  customized built-in seed without touching role references.
- **MCP tool loading** (stdio + streamable HTTP) with role scoping,
  `mcp__server__tool` namespacing, result caps, and per-call timeouts.
- **Session persistence** as JSONL transcripts (dense `seq`, `--resume`),
  context **compaction** with token-aware budgets
  (`--context-window`, `--compact-threshold-tokens`).
- **Plugins**: drop ES-module files in `plugins/` exposing
  `register(ctx)` — tools are shared by both brothers.
- **Skills**: `<root>/<name>/SKILL.md` files become a role-scoped
  `## Available skills` prompt section; `<skill name="…">` requests inject
  the body on demand.
- **Slash commands**: markdown prompt templates expanded literally in the
  chat REPL and the TUI (`/name args`, `$ARGUMENTS`, `$1`..`$9`).
- **Server**: HTTP + SSE on plain `node:http`; worker pool, approval
  broker, settings/secret stores (DPAPI/`plain1:`).

## Documentation

- Protocol contract and design: [PROTOCOL.md](https://github.com/nik1138/two-brothers-harness/blob/main/PROTOCOL.md) · [DESIGN.md](https://github.com/nik1138/two-brothers-harness/blob/main/DESIGN.md)
- CLI and API reference: [docs/cli-reference.md](https://github.com/nik1138/two-brothers-harness/blob/main/docs/cli-reference.md)
- Documentation index: [docs/README.md](https://github.com/nik1138/two-brothers-harness/blob/main/docs/README.md)
- Port history: [docs/history/ts-rewrite-plan.md](https://github.com/nik1138/two-brothers-harness/blob/main/docs/history/ts-rewrite-plan.md)

## License

MIT — see [LICENSE](https://github.com/nik1138/two-brothers-harness/blob/main/LICENSE).
