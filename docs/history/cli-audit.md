# CLI Audit (Stage 17)

Date: 2026-11-01. Scope: `python -m two_brothers` CLI (`run`, `chat`, `selftest`,
`serve`) — exercised end-to-end on Windows (Git Bash, `.venv` interpreter), one
real-model run against a local LM Studio, everything else offline with the mock
provider.

> **Current framing (2026-11-03):** this audit covers the **frozen Python
> prototype's** CLI only. The product CLI is the TypeScript package's
> (`packages/harness`: `node dist/cli.js`), which has since grown pipe-clean
> automation output (`--mode print|json`); the findings and fixes below are
> kept as the record of the Python-era CLI.

## What was exercised

| Scenario | Result |
|---|---|
| `run "..." --provider mock` (compact) | OK — transcript + `tokens:` footer |
| `run --provider mock --verbose` | OK — full JSON payloads per message |
| `run --provider mock --json` | OK — decision JSON on the last line (see F7) |
| `chat --provider mock`, 2 tasks + empty line / `exit` via piped stdin | OK — usage footer printed per task; empty line quits the REPL (so a blank line between tasks ends the session) |
| Real model (`spark-x2.6-4b@q4_k_m` senior, `lfm3-1.7b` junior, LM Studio at `http://172.18.0.1:1234/v1`, `--max-rounds 1`) | OK — full consult cycle, sensible dissent-rich decision, 2 min 32 s for 4 model calls |
| `run` with no base_url configured | Fail-fast as designed, 0.7 s, exit 1 (see F4) |
| `run` with unroutable base_url (`http://127.0.0.1:9/v1`, `--timeout 5 --retries 1`) | Exit 1, but a raw langchain traceback instead of an `[error]` line (see F1) |
| `--session-file` + `--resume` round-trip | OK — `seq` stays dense (1..10 across two tasks); resume of a missing file warns and starts fresh |
| Session file on an unwritable path | Raw traceback, exit 1 (see F2) |
| Task text with characters outside the console code page (CJK on cp1251) | Run aborts mid-print with `[error] 'charmap' codec can't encode...` (see F3) |

## Findings

### F1 (P1) — Connection failures dump a raw traceback

Repro:

```bash
python -m two_brothers run "test" --base-url http://127.0.0.1:9/v1 \
  --senior-model x --junior-model y --timeout 5 --retries 1
```

`langchain_openai.chat_models.base.OpenAIConnectionError` propagates out of
`_run_once`; `_do_run` only catches `ValueError`, so the user gets a full
LangGraph/langchain stack trace (including internal node ids) and no `[error]`
line. Exit code is still 1. Fix: catch `Exception` in `_do_run`/`_do_chat`,
print `[error] <message>`, exit 1; in `chat`, keep the REPL alive after a
failed task.

### F2 (P1) — Session write failures are uncaught

A `SessionError` raised mid-run (e.g. session file becomes unwritable:
`PermissionError: [Errno 13] Permission denied: ... s.jsonl`) propagates out of
`graph.run` → `_run_once` → traceback. `_do_run` only handles the `SessionError`
from `_open_events`. Fix: same catch as F1.

### F3 (P1) — Non-console characters abort the run on Windows

On a cp1251 console, `python -m two_brothers run "日本語のタスク"
--provider mock` fails after the graph has already completed:
`[error] 'charmap' codec can't encode characters in position 12-18` (surfaced
through the `except ValueError` path since `UnicodeEncodeError` is a
`ValueError`). The decision is computed but never printed. Fix: at CLI entry,
`reconfigure(encoding="utf-8", errors="backslashreplace")` stdout/stderr when
the stream supports it (guarded — `StringIO` under `redirect_stdout` has no
`reconfigure`).

### F4 (P2) — Missing-settings error speaks web-workspace vocabulary

`no base_url configured for the senior role — set it in Settings, or pass
--base-url ...` — a bare-CLI user has no "Settings". Fix: mention the path:
"set it in the Settings dialog (`two-brothers serve`), or pass --base-url /
set TWO_BROTHERS_BASE_URL". The word "Settings" must stay (server tests assert
it). Same for the "no model configured" message.

### F5 (P2) — chat REPL shows no resolved provider/models

The banner is one static line; with env-var-driven config the user cannot tell
which provider/model each role will hit until the run starts. Fix: print a
per-role resolution line (provider, model, base URL) before the first prompt.

### F6 (P3) — chat does not accept `/exit` / `/quit`

Only bare `exit`, `quit`, `q` quit the REPL. Slash aliases added for muscle
memory from other REPLs.

### F7 (P3, deferred) — `--json` mixes transcript and JSON on stdout

The human transcript precedes the decision JSON on stdout, and the usage footer
is suppressed under `--json`. Machine consumers must skip to the last line.
Moving the transcript to stderr under `--json` would break "transcript on
stdout" expectations for interactive use; deferred — the documented contract
("decision as JSON on the last line") holds.

### F8 (P3, deferred, out of scope) — zero token usage from LM Studio

The real-model run footer showed `tokens: 0/0 (cache 0%, 4 model calls)`.
LM Studio's `spark-x2.6-4b@q4_k_m` appears not to return usage metadata (the
`UsageTracker` handles both `usage_metadata` and `response_metadata`
correctly). Not a CLI bug; noted for the responders owner.

### F9 (verified non-bugs)

- The `�` characters in captured mock output are a shell-capture artifact:
  the mock templates use guillemets (`«»`, codepoints 0xAB/0xBB), intact in
  the source and on the wire.
- `chat` already prints the `tokens:` usage footer per task (it reuses
  `_run_once`), so no change needed there.
- `--resume` seq continuity (dense 1..10) verified.
- Fail-fast timing without base_url: 0.7 s — well within "fails fast".

## Improvement list (landed vs deferred)

| # | Priority | Item | Status |
|---|---|---|---|
| 1 | P1 | Catch run exceptions (connection, session) → `[error]`, exit 1; chat survives a failed task | landed (cli.py `_do_run`/`_do_chat`) |
| 2 | P1 | UTF-8 `backslashreplace` stdio at CLI entry | landed (cli.py `main`) |
| 3 | P2 | Missing-settings error names `two-brothers serve` + Settings dialog | landed (config.py `openai_role_problem`) |
| 4 | P2 | chat banner: resolved provider/model/base URL per role | landed (cli.py `_do_chat`) |
| 5 | P3 | `/exit`, `/quit` aliases in chat | landed (cli.py `_do_chat`) |
| 6 | P3 | `sessions` subcommand — list session files with readable titles | landed (cli.py `sessions`) |
| 7 | P3 | `--json` transcript on stderr | deferred (F7) |
| 8 | P3 | Usage=0 against LM Studio | deferred — responders.py, not CLI-owned (F8) |
| 9 | P3 | `run` hint when `--json` without `--session-file` | not needed — last-line JSON is the documented contract (F7) |
