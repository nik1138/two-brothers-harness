# Quickstart

Get "Two Brothers" running in a couple of minutes.

The implementation is the **TypeScript package** —
`packages/harness/` (`@two-brothers/harness`), in the style of pi /
deepseek-harness. Everything below runs against it; the zero-dependency
`typescript/` tree is the protocol reference (nothing to install there).

## 1. Requirements

| Component | Version | Check |
|---|---|---|
| Node.js | ≥ 22.19 | `node --version` |

Set up and build the package once (from a checkout; once the package is
published, `npm install -g @two-brothers/harness` gives you the same CLI as a
global `two-brothers` command):

```powershell
cd two-brothers-harness\packages\harness
npm install
npm run build                          # tsc → dist/
```

## 2. First run (offline, no API key)

```powershell
cd two-brothers-harness\packages\harness
node dist/cli.js run "Plan a migration from Redis to Valkey" --provider mock
```

The output is the full conversation: `[user]`, `[senior -> junior] consult`, `[junior -> senior] proposal`,
`[senior -> junior] review`, `[senior -> user] decision`.

## 3. Delegation mode

```powershell
node dist/cli.js run "Write hello world" --provider mock --mode work
```

The junior takes on part of the work: `delegation` → `deliverable` → `review` → `decision`.

## 4. A real model

```powershell
$env:TWO_BROTHERS_PROVIDER = "openai"
$env:TWO_BROTHERS_BASE_URL  = "https://api.deepseek.com/v1"
$env:TWO_BROTHERS_API_KEY   = "sk-..."
$env:TWO_BROTHERS_SENIOR_MODEL = "deepseek-chat"
$env:TWO_BROTHERS_JUNIOR_MODEL = "deepseek-chat"

cd two-brothers-harness\packages\harness
node dist/cli.js run "Your task"
```

Any OpenAI-compatible endpoint works: DeepSeek, OpenAI, OpenRouter, vLLM,
Ollama, OpenCode Zen — and Anthropic / Google Gemini through their adapters
(`--provider-kind anthropic|google`). `node dist/cli.js onboard` writes the
per-role settings interactively if you prefer not to set environment
variables. Environment variables win over saved settings while they are set
and are never written to the settings file (see the
[CLI reference](cli-reference.md#environment-variables)).

> **Local models (LM Studio, CPU):** small models on CPU can take 2–7+
> minutes per provider call. The default `--timeout` (120 s) bounds *each
> attempt*, and every retry restarts generation from scratch — so a slow
> local model can fail all attempts even with retries left. Raise the
> timeout instead of the retry count:
>
> ```powershell
> node dist/cli.js run "Your task" --timeout 900   # or higher on slower machines
> # or serve/web runs:
> $env:TWO_BROTHERS_TIMEOUT = "900"
> node dist/cli.js serve --port 8600 --sessions-dir sessions
> ```

## 5. Persist and resume a session

```powershell
# create a session
node dist/cli.js run "Plan a migration from Redis to Valkey" --provider mock --session-file session.jsonl

# resume it later
node dist/cli.js run "Now plan the rollback" --provider mock --session-file session.jsonl --resume
```

Every protocol envelope is appended to the JSONL file and flushed immediately, so a
crashed run leaves a valid, replayable log. `--resume` rebuilds the shared context and
`seq` numbering continues densely. An existing file without `--resume` is an error —
use `--resume` or delete the file. See the [CLI reference](cli-reference.md) for details.

## The web workspace

The browser app is a **local, single-user coding workspace**. The only
conversation view is a three-party group chat — you (the Operator), the
Senior, and the Junior:

```powershell
# server: HTTP API + the built web app
cd two-brothers-harness\packages\harness
npm install && npm run build
node dist/cli.js serve --port 8600 --sessions-dir sessions

# frontend development: cd web && npm install && npm run dev
# (Vite proxies /api to :8600; `npm run build` → web/dist is served by the server)
```

Then open `http://127.0.0.1:8600`:

1. **Register a workspace** with the workspace finder (a directory you pick —
   it is never scanned) and create a session linked to it. Sessions are
   grouped by workspace in the sidebar.
2. **Set the models** — the Settings dialog opens from the bottom-left of the
   sidebar; per-role Senior/Junior provider, model, base URL, and API key
   (keys are never echoed back; the server seals them at rest). Runs use the
   configured models; there is no separate "mock" switch in the UI.
3. **Send a task** in `work` mode. The run proceeds in the background; the
   chat updates live over SSE and you can send follow-up messages, stop the
   run, or just reload the page (progress is recovered from the runtime
   sidecar).
4. **Approve mutations.** Reads inside the workspace are free, but every
   write/edit/delete/shell command docks an approval card in the chat —
   allow or deny there to resume the run. On narrow screens the sidebar
   becomes a drawer over the chat.
5. **Review the changes** — files touched by tools are collected with their
   unified diffs.

Sessions are plain JSONL files under `--sessions-dir`; each has a
`<name>.meta.json` sidecar (title, workspace link) and a runtime sidecar in
`sessions/runtime/<name>.events.jsonl` (tool calls, approvals, diffs).

## The terminal workspace

The **TUI** is the same harness as a full-screen chat in the terminal (it
needs a TTY). A bare interactive `two-brothers` (or `node dist/cli.js` with
no arguments) opens it directly; piped/CI invocations print the usage screen
instead. Use `chat` for scripts.

```powershell
node dist/cli.js tui --provider mock
```

Block transcript with textual role labels, a grapheme-aware multiline
composer with history and bracketed paste, Ctrl+P command palette and `?`
help overlays, session/model pickers, token streaming in place, live resize
repaint, and non-blocking turns — Escape/Ctrl+C cancel a running turn before
anything else.

## Verify

```powershell
cd two-brothers-harness
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/smoke-test.ps1
```

It should end with `SMOKE TEST: PASS` (package typecheck/build/tests/selftest,
a mock demo run, the hermetic CLI E2E, the `typescript/` reference selftest,
the web unit tests, and the web build). The package's own gates are
`npm test` / `npm run test:spawn` in `packages/harness`; see
[Testing](testing.md).

## What's next

- [CLI reference](cli-reference.md) — all commands and flags.
- [Protocol](../PROTOCOL.md) — how the message exchange is structured.
- [Testing](testing.md) — tests and verification tools.