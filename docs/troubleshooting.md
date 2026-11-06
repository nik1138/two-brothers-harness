# Troubleshooting

Start with `doctor`. It runs a fixed set of local checks in order and prints one
`[pass]`, `[warn]`, `[fail]` or `[skip]` line per check, naming the failing
component and usually the next command to run. It never prints API keys: role
details only say `key set` or `key not set`, and the endpoint detail never
includes request headers or response bodies.

```powershell
cd packages/harness
node dist/cli.js doctor --provider mock   # offline: no provider endpoint is contacted
node dist/cli.js doctor                    # the configured provider, models and endpoint
node dist/cli.js doctor --json             # one {ok, checks} object for scripts
```

Exit codes: `0` when no check failed, `1` when at least one check failed, `2` on
a usage error. Warnings never fail the report. In `--json`, each check carries
`id`, `label`, `status` and an optional `detail`; the ids are `engine` (Node
engine), `settings` (Settings file), `sessions-dir` (Sessions directory),
`roles` (Role configuration), `endpoint` (Provider endpoint), `web-assets` (Web
assets) and `plugins` (Plugins directory).

## No provider or model configured

| Symptom | `doctor` check | Fix |
|---|---|---|
| `run` exits 1: `no base_url configured for the senior role ...` | `roles` fails: `no senior base URL ...` | Set `--base-url` (or the per-role `--senior-base-url` / `--junior-base-url`), the matching `TWO_BROTHERS_*` variables, or write settings with `onboard`. In the web UI, open Settings in the sidebar footer. |
| `run` exits 1: `no model configured for the senior role ...` | `roles` warns: `no senior model ...`; `endpoint` warns: `... no senior/junior model configured yet` | Set `--senior-model` / `--junior-model`, the env vars, or the Settings dialog / `onboard`. List what the endpoint actually serves with `node dist/cli.js models --base-url <url>` (add `--api-key` or `--api-key-env` if the endpoint needs one). |

A missing model is only a warning in `doctor`; a real run still fails. The
`mock` provider needs neither an endpoint nor models — run
`node dist/cli.js doctor --provider mock` to confirm the rest of the environment
while bypassing provider configuration entirely.

## Endpoint unreachable, refused, or rate-limited

| Symptom | `doctor` check | Fix |
|---|---|---|
| `cannot reach http://.../models` | `endpoint` fails: `check the base URL and that the provider is running` | The server is not running or the URL is wrong. Check the scheme and path, start LM Studio / Ollama / vLLM, then retry. `doctor --timeout <s>` bounds the probe (default 5 s). |
| `HTTP 401` or `HTTP 403` | `endpoint` fails: `check the API key` | Set the key (shared `--api-key` / `TWO_BROTHERS_API_KEY`, or a per-role override). A per-role key wins over the shared one. The key is never echoed. |
| `HTTP 404` | `endpoint` fails: `check the base URL path (some servers need /v1)` | Fix the path: many OpenAI-compatible servers want `http://127.0.0.1:1234/v1`, not the bare host. |
| `HTTP 429` | `endpoint` fails: `rate limited — try again later` | Wait and retry. Quota/billing exhaustion is classified as non-retryable even when it arrives as 429, so more attempts will not clear it — fix the account or plan. |
| `timed out after N ms` | `endpoint` fails | The probe hit `--timeout` (default 5 s). Raise it for a slow local server, or treat it as the slow-model case below. |
| `none of the configured models reported (...)` | `endpoint` fails (all configured models missing) or warns (one missing) | List the endpoint's ids with `node dist/cli.js models --base-url <url>` and set the exact reported id for each role. Matching is case-insensitive and ignores a leading `models/`. |
| `reported no models — is the provider ready?` | `endpoint` warns | The endpoint answered but served an empty list. Load a model in the local server, then retry. |

### Slow local models (timeouts and retries)

`doctor`'s `--timeout` bounds only the model-list probe; a run has its own
per-attempt timeout — 120 s by default (`--timeout`, or
`TWO_BROTHERS_TIMEOUT` for `serve`). A failed call is retried 6 times by
default with a 2/4/8/16/30/30 s backoff, and each retry re-requests the whole
reply. For a slow local model, raise the timeout instead of the retry count:

```powershell
node dist/cli.js run "Your task" --timeout 900
$env:TWO_BROTHERS_TIMEOUT = "900"
node dist/cli.js serve --port 8600 --sessions-dir sessions
```

## Sessions directory and settings

| Symptom | `doctor` check | Fix |
|---|---|---|
| `sessions-dir` fails: `exists but is not a directory` | `sessions-dir` | Point `--sessions-dir` at a directory, or remove the file occupying that path. |
| `sessions-dir` fails: `is not writable — check directory permissions` | `sessions-dir` | Grant write permission or choose another directory. The writability probe writes and deletes one `.doctor-*.tmp` file. |
| `sessions-dir` warns: `not found — it will be created on first run` | `sessions-dir` | No action needed; `doctor` deliberately does not create it. `serve` creates the directory on startup, or create it yourself. |
| `settings` fails: `is not valid JSON — fix or delete it` | `settings` | Fix or delete `<sessions-dir>/settings.json`; it is recreated on the first settings save. The generic message is intentional — a parser message could quote the file's bytes, including a key. |
| `settings` warns: `not found — it will be created on the first settings save` | `settings` | No action needed; `onboard` writes the file, or save Settings in the web UI. |
| `engine` fails: `Node ... is below the required >= 22.19` | `engine` | Upgrade Node to 22.19 or newer. |

## Web UI missing or stale

| Symptom | `doctor` check | Fix |
|---|---|---|
| `http://127.0.0.1:8600` returns 404 or no page | `web-assets` warns: `no index.html in N candidate roots — run "npm run build" in web/ (and "npm run sync-web" for the package copy)` | `cd web && npm install && npm run build`; then from `packages/harness` run `npm run sync-web` if you want the packaged copy refreshed. Restart `serve` — it resolves the asset directory at startup. |
| The page loads but the command palette or theme selector is missing | `web-assets` passes | Rebuild, `npm run sync-web`, and restart. `doctor` prints which candidate it found; the first candidate is `<package>/web`, which can shadow the repo's `web/dist`. |

## Plugins

| Symptom | `doctor` check | Fix |
|---|---|---|
| A plugin's tools or hooks never appear | `plugins` passes or warns | The check only verifies that `<cwd>/plugins` exists — it does not load plugin code. Pass `--plugins-dir` if your modules live elsewhere; a plugin that throws on import or registration is skipped with a warning (`plugin "name" skipped: ...`) and the run continues. Add `--verbose` for the per-plugin diagnostic line. |
| `plugins` warns: `... not found — plugins are optional` | `plugins` | Optional. Create the directory or pass `--plugins-dir`. |
| Plugin tools are missing in `run` or `chat`, but hooks fire | `plugins` | Plugin tools need a workspace; only workspace-bound `serve` runs bind them. The CLI has no workspace, so only hooks apply there. |

## TUI refuses to start

| Symptom | `doctor` check | Fix |
|---|---|---|
| `tui needs an interactive terminal — stdin/stdout are not TTYs` (exit 2) | none — `doctor` cannot test a TTY | Run `tui`, or a bare `two-brothers`, from a real terminal. For piped, redirected or CI sessions use `chat` instead. |

## Streaming and composer mentions

| Symptom | Why | Fix |
|---|---|---|
| The web chat shows no live Thinking/Response blocks while a run works | The run was started without `stream_tokens`, the follow connection was opened after the deltas were sent (tokens are live-only, never replayed), or the provider returned a normal JSON completion instead of an SSE stream | Refresh/reopen the run view; streaming is enabled by the web client automatically. A provider that ignores `stream: true` still runs normally (the adapter falls back to the JSON completion) — it just cannot produce live deltas. Reasoning appears only if the endpoint reports it (`reasoning_content`, `thinking_delta` or `thought` parts). |
| `POST /api/runs` returns 400 `stream_tokens` / `invalid request body` | `stream_tokens` is a strict boolean | Send `true` or `false` (or omit it); the web client sends `true` automatically. |
| Typing `@` inserts nothing useful / a root-level file is not attached | File mentions must be path-like: nested paths `@src/a.ts`, root files `@./README.md`. A bare `@README.md` is treated as ordinary text | Pick the file from the picker (it serializes correctly); the server also rejects absolute paths, `..` escapes and sensitive files. |
| Mention submit fails with `unknown skill`, `role-scoped skills cannot be operator mentions`, `file mentions require a workspace`, `cannot attach file`, or a count-cap error | The server validates mentions before creating the run; these are the documented 400s | Use a shared skill (`scope: shared`), attach files only to workspace-bound runs, and stay inside the caps: 3 skills, 5 files, 20 000 chars per file, 100 000 chars of attachments in total. The composer picker only lists insertable entries. |
| A `/name` task runs as literal text instead of expanding | Slash expansion applies to a *discovered* command name (`commands/<name>.md`) or a first-party built-in; unknown or path-like slash lines are ordinary tasks | Check the command exists (`GET /api/commands` — `commands` plus `baseCommands`, the `?` help overlay, or the picker), or add the template file to a commands root. |
| `POST /api/runs` returns 400 `usage: /plan <objective>` or `… is a built-in action, not a task` | Built-in **prompt** commands require their argument, and built-in **action** commands (`compact`, `export`, `permission`, `status`, `mode`, `new`, `help`) are performed by the surface — submitting one as a run would create an empty turn, so the API refuses it | Send the argument (`/plan <objective>`), or perform the action in the client: `/compact` is also available as `POST /api/sessions/{name}/compact`. A client without the local action should say so instead of submitting the line. |
| The web `/compact` action reports "a run is active" or a summarizer failure | Manual compaction is refused while a run for that session is queued/running/waiting (409), and a provider failure is a 502 with the message; nothing is written on failure | Wait for or stop the run, then retry; if it fails again, check the configured Senior endpoint with `doctor` and re-run with `--verbose` on the server. |
| A built-in command (e.g. `/plan`) behaves differently after adding a `plan.md` | A discovered `<name>.md` template shadows a built-in of the same name (exact-name priority, deepseek-harness rule) | Rename or remove the template file, or use the built-in under its other spellings (aliases) where the template does not shadow them. |

## Usage errors and exit codes

Usage errors are rejected before `doctor` runs, so they have no check id.
Near-miss command and option names get a suggestion on stderr, for example
`Unknown command: docter` / `Did you mean 'doctor'?` or
`Unknown option '--tmeout'` / `Did you mean '--timeout'?`.

| Code | Meaning | What to do |
|---|---|---|
| `0` | Success; `doctor` when no check failed | — |
| `1` | Run error (including a provider call failure), or `doctor` with a failed check | Follow the failing `doctor` check above. If `doctor` passes but `run` exits 1, the provider call itself failed (for example `fetch failed`); re-run with `--verbose` and check the endpoint's log. `doctor` only probes `GET /models`. |
| `2` | Usage error: unknown command or option, a missing command argument (task, shell, session), or the TUI without a TTY; `doctor` also returns 2 for an invalid provider flag | Read the usage line on stderr, then run `help <command>` or the command's `--help`. |

See the [CLI reference](cli-reference.md#return-codes) for the full command and
flag surface, and [Quickstart](quickstart.md) for a working configuration.
