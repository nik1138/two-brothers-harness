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
assets), `plugins` (Plugins directory), `tui-keys` (TUI keys file),
`tui-history` (TUI prompt history) and `mcp-config` (MCP configuration).

## No provider or model configured

| Symptom | `doctor` check | Fix |
|---|---|---|
| `run` exits 1: `no base_url configured for the senior role ...` | `roles` fails: `no senior base URL ...` | Set `--base-url` (or the per-role `--senior-base-url` / `--junior-base-url`), the matching `TWO_BROTHERS_*` variables, or write settings with `onboard`. In the web UI, open Settings in the sidebar footer; in the TUI, run `/provider`. |
| `run` exits 1: `no model configured for the senior role ...` | `roles` warns: `no senior model ...`; `endpoint` warns: `... no senior/junior model configured yet` | Set `--senior-model` / `--junior-model`, the env vars, or the Settings dialog / `onboard` (or `/provider` in the TUI). List what the endpoint actually serves with `node dist/cli.js models --base-url <url>` (add `--api-key` or `--api-key-env` if the endpoint needs one). |

A missing model is only a warning in `doctor`; a real run still fails. The
`mock` provider needs neither an endpoint nor models — run
`node dist/cli.js doctor --provider mock` to confirm the rest of the environment
while bypassing provider configuration entirely.

## Provider presets and appearance

| Symptom | Why | Fix |
|---|---|---|
| Settings → Providers lists a provider but the row has no **Delete** | The list mixes built-in seed presets and custom entries; only custom entries show **Delete**. A customized built-in seed gets **Reset to default** instead, because `DELETE` also clears role references. | Edit the preset (which materializes an override) or add a custom provider; for an edited built-in use **Reset to default**, which drops the stored override and its API key but keeps the Senior/Junior assignments. |
| **Reset to default** is missing on an edited built-in, or reports an unsupported backend | The browser is talking to an older backend with no `POST /api/providers/{name}/reset` route | Rebuild and restart the backend from this checkout (`npm run build`, then `serve`). The client's message says the backend does not support reset yet and confirms that customized values, unsaved edits and role assignments were not changed. |
| **Reset to default** fails with `provider is not customized: <name>` (409) or `only built-in provider presets can be reset: <name>` (400) | Reset applies only to a customized built-in seed: a pristine seed has no stored override, and a custom provider is not a built-in seed | Nothing changed. There is nothing to reset on a pristine seed; edit a custom provider directly, or use Delete to remove it (Delete clears matching role references, which reset never does). |
| A provider's settings card will not save | `base_url` is required and must be a URL; a duplicate name on add is a 409 | Fill a valid base URL; for duplicates pick another id (`A provider already uses this ID.` appears inline). Model ids are free-form strings. |
| The model ids under a provider differ from what a role actually uses | `preset.models` is a suggestion list for role pickers/onboarding, not the request model | Set the model each role uses in Models & roles (or `--senior-model`/`--junior-model`); use Settings → Providers → **Refresh models**, or run `node dist/cli.js models --base-url <url>`, to list what an endpoint serves. |
| Compact density makes Settings cards look broken / labels overlap the border | A stale build: older bundles had a global `.theme-option` rule that also hit the Appearance cards | Rebuild and reload (`cd web && npm run build`, then refresh the served app); the fix scopes the compact rule to the sidebar footer and the Appearance section uses `.appearance-*` classes. |
| Theme/density changes do not stick | The preference is stored per device in `localStorage` | Check that storage is not blocked for the origin; theme and density are local UI preferences, not server settings. |

## Provider model discovery (Refresh models)

Settings → Providers → **Refresh models** probes the current draft's
OpenAI-compatible endpoint through `POST /api/providers/{name}/discover` and
lists what it reports. It never saves the provider and never applies the list —
adding ids is explicit (**Add N to draft**, then **Save changes**).

| Symptom | Why | Fix |
|---|---|---|
| **Refresh models** fails with `Model discovery failed: …` (HTTP 502) | The probe is one bounded request to the draft's Base URL; an unreachable host, wrong path, timeout or auth failure surfaces as a clean 502 with the provider's message. Nothing was saved. | Check the Base URL and that the endpoint is running; many local servers need the `/v1` path (`http://127.0.0.1:1234/v1`). The probe has a short one-shot timeout — for a slow local server list the ids with `node dist/cli.js models --base-url <url>` (add `--api-key`/`--api-key-env` if needed). |
| The control says discovery is not supported for this provider kind (HTTP 400) | Only the OpenAI-compatible adapter exposes `GET {base}/models`; the Anthropic Messages and Google Gemini APIs have no equivalent listing in this probe. | Use the provider with `kind: openai-compatible` if it really speaks that API (e.g. a proxy), or enter model ids by hand and set the role models. The answer is deliberately honest instead of probing the wrong shape. |
| HTTP 400 `a typed API key is required when probing a different base URL` | The draft Base URL differs from the preset's saved endpoint while the preset has a saved/env-backed key — sending that secret to a different host is refused before any request. | Type the key for the target endpoint in the API key field; it is used for this one probe and never stored (a blank field still uses the saved key when the URL is the preset's own). |
| `Model discovery is not supported by this backend. Nothing was changed.` (404) | The browser is talking to an older backend without the discovery route. | Rebuild and restart the backend from this checkout (`npm run build`, then `serve`). The draft and the saved provider are untouched. |
| `The endpoint reported no models. Your saved model list is unchanged.` | The endpoint answered but served an empty list (no model loaded, or an API that does not list models). | Load a model in the local server, or add model ids by hand. An empty answer is valid and must not erase the saved catalog. |

## MCP configuration

`--mcp-config <path>` and `TWO_BROTHERS_MCP_CONFIG` point at the same
Claude-Desktop-style JSON (`{"mcpServers": {...}}`). A non-blank flag wins over
the env; a blank flag falls back to it; blank/whitespace on both means no MCP
servers. The `doctor` row `mcp-config` validates the env-named file read-only.

| Symptom | `doctor` check | Fix |
|---|---|---|
| MCP tools are missing although the env names a file | `mcp-config` passes, but a `run` used a different `--mcp-config` | The flag wins over the env. Remove the flag or point both at the same file. |
| `mcp-config` warns `not found — fix or unset TWO_BROTHERS_MCP_CONFIG` | The env is set to a path that does not exist (resolved against the current directory) | Fix the path or unset the variable; an unset variable is a skip, not a failure. |
| `mcp-config` warns `is not valid JSON` | The file cannot be parsed; the parser message is deliberately discarded because it can quote file bytes | Validate the file with a JSON linter; it must contain a top-level `mcpServers` object. |
| `mcp-config` warns `is larger than 1048576 bytes` | The env points at a data file rather than a small MCP config | Point `TWO_BROTHERS_MCP_CONFIG` at the MCP JSON; doctor deliberately caps the read at 1 MiB. |
| `mcp-config` warns `"mcpServers" must be an object of server entries` | Wrong top-level shape (array/string root, missing or non-object `mcpServers`) | Wrap the server definitions in `{"mcpServers": { ... }}`. |
| A valid config still fails at run time | `doctor` validates the file shape only — it never starts a server or makes a network call, so it cannot prove that a command exists or a URL is reachable | Run `doctor` for the shape, then check the server's own diagnostics under `--verbose`; the run fails softly and continues text-only. |

## Web queue and session-scope approvals

| Symptom | Why | Fix |
|---|---|---|
| The composer will not submit while a run works (send stays locked, or reads Send instead of **Queue**) | A stale client bundle: the served app is the built copy, and older builds disabled the composer for the whole run. The backend itself has always queued per session. | Rebuild the web app (`cd web && npm run build`) and restart the backend, then reload. The send control should read **Queue** while a run works. |
| The queue dock never appears although tasks are queued | The dock is projected from `GET /api/runs` active run records; an older backend that returns none shows no dock (the run still queues server-side). | Rebuild and restart the backend from this checkout. The dock shows up to five waiting rows plus a `+N more` tail. |
| A queued row's **Stop** reports 404 | The run already left the queue (cancelled or finished elsewhere). | Nothing to cancel — the next pool refresh reconciles the dock. A queued stop otherwise cancels immediately; the active run stops cooperatively. |
| The approval card shows "Allowed once — this backend does not support session scope." | The backend ignored the additive `scope: "session"` field (older backend that predates session-scope approvals). | The allow applied to that request only — nothing pretends otherwise. Rebuild and restart the backend to use **Always allow this session**. |
| A session grant asks again after a restart / for another session | Grants are per session file, stored in `sessions/settings.json` under `approvals`, and cleared when the session is deleted; a corrupt settings file reads as empty (fail closed). | Re-allow in the current session; check the session still exists and the settings file is valid JSON. A damaged `approvals` section never silently auto-allows — the card simply asks again. |

## Web runs never compact

| Symptom | Why | Fix |
|---|---|---|
| A long web run keeps growing its context until the provider overflows, and the session never gains a summary envelope | Web runs use the compaction settings resolved from `serve`'s own configuration. With no `--compact*`, `--context-window` or `TWO_BROTHERS_COMPACT*` value, `serve` behaves exactly like a CLI run without compaction flags: auto-compaction is off. | Restart `serve` with budgets, e.g. `serve --compact-threshold 60000 --compact-keep-recent 20000` (or `--context-window`/`--compact-threshold-tokens` for token mode). A completed auto-compaction appends one `compacted into the following summary` envelope and rewrites the session JSONL. |
| The web **Compact** action ignores the budget I expected | `POST /api/sessions/{name}/compact` resolves the same config budgets, but an explicit `ServerOptions.compaction` (embedded use) still wins when one is set. | Restart `serve` with the flags; a browser client cannot pass budgets per request. `before_events`/`after_events` in the response says whether anything was cut. |
| `serve --help` does not list the compaction flags | Older builds accepted the shared flags without listing them on the serve surface. | Current builds list `--compact`, `--compact-threshold`, `--compact-threshold-tokens`, `--compact-keep-recent` and `--context-window` in `serve --help`; the shared option table always parsed them. |

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
default with a 2/4/8/16/30/30 s backoff (0–25% jitter reduces each wait, so
those values are the upper bound), and each retry re-requests the whole reply.
For a slow local model, raise the timeout instead of the retry count:

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
| Settings saves fail after a downgrade with `settings.json schema version N was written by a newer release` | The file carries a top-level `version` above the supported `1`: it was written by a newer release. Reads still work (`GET /api/settings` reports `schema.writable: false`), but every write is refused rather than dropping sections this release does not know. | Upgrade back to the newer release, or restore/back up `settings.json` and remove the newer sections before downgrading. A legacy file without a version needs no action — it normalizes to `version: 1` on the next save. |
| Settings saves fail with `settings.json exists but cannot be read (...); refusing to overwrite it` | The file exists but a permission/sharing violation, antivirus lock or I/O error prevented reading it. Reads fail soft (`GET /api/settings` reports `schema.writable: false`, `readable: false`, `reason`), and every write is refused so the uninspected document is never replaced. | Close whatever holds the file, fix its permissions, then retry. Check the `schema.reason` in `GET /api/settings` for the underlying OS error. Do not delete the file to "fix" it unless you intend to reset settings. |
| `engine` fails: `Node ... is below the required >= 22.19` | `engine` | Upgrade Node to 22.19 or newer. |

## A session disappears after a crash

| Symptom | Why | Fix |
|---|---|---|
| `run --resume` (or `chat --resume`) exited 1 with `corrupt session file …, line N` after a crash, and the file looks cut off mid-line | The last append was interrupted, leaving a half-written final JSONL line. Current builds recover exactly that case: the torn trailing fragment is ignored in memory, `--resume` repairs the file atomically before appending (truncation to the last complete line, or one added newline after a valid final envelope), and the next envelope keeps dense `seq`. An interior bad line is still a typed error and is never guessed around. | Upgrade to a current build and retry `--resume`; the kept prefix keeps its dense `seq` and the warning names the dropped line and byte count. If the error names a line other than the last, the file has interior corruption — restore it from a backup or start a new session; do not hand-edit envelope bytes. |
| `sessions --json` / `sessions show` report `error: "corrupt line N"` for a session that `--resume` accepts | The CLI listing is tolerant but still reports every unparseable line it finds; it never rewrites the file. The torn-tail-aware read path (`sessions search`, the web read routes, `--resume`) is what recovers only an incomplete final fragment; the CLI export also renders the complete prefix and skips the bad line. | Expected: the listing names the line without refusing the session. `--resume` repairs it; read-only surfaces leave the file byte-identical. Only `--resume` (or fork/rewind/compaction) writes. |
| After `--resume` the repaired session seems to have a gap | A repair never drops a complete record. A gap means more than one line was damaged, or another process truncated the same file. | Keep one writer per `--session-file`; check for a second `run`/`chat`/`serve` pointing at the same path. |
| `sessions rewind` refuses a session whose last line is torn | Rewind is destructive, so it keeps the strict reader: it refuses before rewriting rather than guessing at the source. | Run `--resume` once to repair the file, then retry the rewind. |

## Ctrl+C left a build running

| Symptom | Why | Fix |
|---|---|---|
| After `Ctrl+C` in `run`/`chat`, a build or watcher is still running | The first signal aborts the turn and waits a bounded cleanup; the shell runner kills the process tree it started and drains it. A process that daemonized or detached (`start /B`, `nohup`, a service) is outside that tree, and a second `Ctrl+C` force-exits without waiting. | Find and kill the survivor explicitly; prefer foreground commands inside a turn. The runner only reaps what it spawned. |
| `Ctrl+C` printed nothing but the process took a moment to exit | That is the bounded cleanup (`TURN_CANCEL_BUDGET_MS`, 8 000 ms) waiting for the aborted turn and shell drain, not a hang. | Wait for the exit; a second signal force-exits if cleanup is stuck. Notices go to stderr, so piped/machine stdout stays clean. |
| `run --json` / `--stream` output stopped mid-stream after `Ctrl+C` | The run was cancelled, so only the records already emitted exist; a cancel is not a completed run. | Treat the run as cancelled, not successful; re-run if you need the full machine output. |
| An interactive `chat` returns to the `task>` prompt after `Ctrl+C` instead of exiting | By design: while a turn runs, Ctrl+C cancels that turn (like the TUI) and the REPL stays usable. A piped/non-TTY `chat` exits `130`, and `SIGTERM`/`SIGHUP` end the REPL after the turn unwinds (`143`/`129`). | Keep entering tasks, or exit the REPL normally. The idle REPL's own Ctrl+C behavior is unchanged. |

## Web UI missing or stale

| Symptom | `doctor` check | Fix |
|---|---|---|
| `http://127.0.0.1:8600` returns 404 or no page | `web-assets` warns: `no index.html in N candidate roots — run "npm run build" in web/ (and "npm run sync-web" for the package copy)` | `cd web && npm install && npm run build`; then from `packages/harness` run `npm run sync-web` if you want the packaged copy refreshed. Restart `serve` — it resolves the asset directory at startup. |
| The page loads but the command palette or theme selector is missing | `web-assets` passes | Rebuild, `npm run sync-web`, and restart. `doctor` prints which candidate it found; the first candidate is `<package>/web`, which can shadow the repo's `web/dist`. |
| `node e2e/run.mjs` fails with `web build produced no dist/index.html` or a `PackagedWebError` | The browser suite serves the packaged `packages/harness/web` copy and guards it against `web/dist` by content; a missing build or a copy that cannot be synced stops the suite before any scenario | Run `cd web && npm install && npm run build` first (the runner then auto-resyncs the packaged copy and logs `packaged web: resynced …`). A normal run logs `packaged web: fresh (N files)`; `npm run sync-web` from `packages/harness` remains the manual/tarball refresh. |

## Plugins

| Symptom | `doctor` check | Fix |
|---|---|---|
| A plugin's tools or hooks never appear | `plugins` passes or warns | The check only verifies that `<cwd>/plugins` exists — it does not load plugin code. Pass `--plugins-dir` if your modules live elsewhere; a plugin that throws on import or registration is skipped with a warning (`plugin "name" skipped: ...`) and the run continues. Add `--verbose` for the per-plugin diagnostic line. |
| `plugins` warns: `... not found — plugins are optional` | `plugins` | Optional. Create the directory or pass `--plugins-dir`. |
| Plugin tools are missing in `run`/`chat`, but hooks fire | `plugins` | Plugin tools need a workspace: workspace-bound `serve` runs and a `tui --workspace <dir>` run bind them; plain `run`/`chat` have no workspace, so only hooks apply there. |

## TUI refuses to start

| Symptom | `doctor` check | Fix |
|---|---|---|
| `tui needs an interactive terminal — stdin/stdout are not TTYs` (exit 2) | none — `doctor` cannot test a TTY | Run `tui`, or a bare `two-brothers`, from a real terminal. For piped, redirected or CI sessions use `chat` instead. |

## TUI workspace, approvals and file mentions

| Symptom | Why | Fix |
|---|---|---|
| `tui --workspace <dir>` exits 2 with `[error] workspace root does not exist: <dir>` | The path does not exist (relative paths resolve against the shell's cwd, not the sessions dir) | Fix the path or create the directory; the TUI never opens the alternate screen on a bad root. |
| `tui --workspace <dir>` exits 2 with `[error] workspace root is not a directory: <dir>` | The path is a file | Point `--workspace` at the folder you want confined. |
| `@path` in the TUI stays literal text instead of attaching a file | The TUI is not workspace-bound — file mentions need `--workspace` (the picker and the submit validator both require it) | Start the TUI with `tui --workspace <dir>`, or use the web composer where the session's linked workspace supplies the root. |
| A TUI `@path` mention is refused: `cannot attach file "@…"`, `not a text file`, `too many file mentions`, or the total-size error | Mentions are validated before the turn starts with the same rules as the server: workspace-relative text files only, no absolute/`..`/sensitive paths, at most 5 files, 20 000 chars each and 100 000 chars in total | Fix the path (pick it from the `@` picker) or send fewer/smaller files; nothing was recorded or sent. |
| The approval panel never appears, or `y`/`n`/`1`/`2`/`3` type into the composer instead | The run is not workspace-bound (no mutations to approve), the effective approval mode allows that action without asking (`edits`/`allow-all`) or denies it before a card can park (`readonly`), or an overlay is open above the panel (it owns the keys until closed) | Bind the root with `tui --workspace <dir>`; check `/permission` for the effective mode; close any overlay (`Esc`) — the panel then owns the decision keys. |
| "Always allow this session" asks again in a new `tui` process | That decision is in-memory for the current TUI process by design — it is never written to `settings.json` | Re-allow in the new process, or use the web approval card whose session grant persists in the session settings. |
| Stopping a run makes a pending approval disappear | A stop/cancel denies every pending request (fail closed) — a stopped run must never leave a mutation parked | Expected. Re-run the task if you meant to finish it. |
| `Ctrl+E` says "nothing to preview for this approval" | The request carries no diff or command — e.g. a delete of a large/unreadable file, which is approved by path alone | Answer from the panel; the preview is optional detail, not an answer path. |
| `Ctrl+C` does not stop the running turn while an approval panel is open | The panel owns the decision keys — the turn cannot be stopped while a mutation waits, so `Ctrl+C` is deliberately inert until the request is answered | Answer the request first (`1`/`y` allow once, `2`/`a` allow for the process, `3`/`n`/`Esc` deny), then `Ctrl+C`/`Esc` stops the turn. The status bar states this: `deny to continue — Ctrl+C stops the turn after it resolves`. |

## TUI plan durability and status hints

| Symptom | Why | Fix |
|---|---|---|
| The plan panel is empty after restarting the TUI although it showed a plan before | Plans are only durable for a session with a file: each TUI turn writes one plan snapshot to `sessions/runtime/<session-file>.events.jsonl`. An in-memory session (no `--session-file`) keeps its plan only for the current process. | Start/keep the TUI on the same `--session-file`; a restart then replays the last snapshot. A cleared plan is durable too (the latest snapshot wins). |
| Only plan events appear in a TUI-written sidecar | By design: a TUI turn persists only `todo_updated` plan snapshots; tool, approval and envelope events still are not persisted by the TUI | Nothing to fix — that sidecar is display state for the plan panel, not a full run log. |
| The sidecar file name does not match what I expected | The sidecar key is the session file's basename unchanged (extension included), and the runtime store appends `.events.jsonl` — so `2026-11-07-1-abc.jsonl` becomes `sessions/runtime/2026-11-07-1-abc.jsonl.events.jsonl` | Use that exact path when inspecting; a `serve` backend writes the same convention for the same session. |
| The status-bar hint changes every turn | The second status row rotates one registry-derived discoverability tip per accepted turn (fold tool output, find, commands, keys/help, prompt-history search, status panel, and stop while a turn runs) | Expected. Every tip names a real binding from the same registry as `?`/`Ctrl+P`; nothing new is bound. |
| A hint like `turn stopped — Ctrl+C ×2 exits` disappears after a moment | It is a one-shot transient hint shown for a bounded number of renders, then the rotating tip returns | Expected; the binding it names is unchanged. |

## TUI provider connection

| Symptom | Why | Fix |
|---|---|---|
| The TUI still uses the default/wrong endpoint after configuring the provider in the web Settings, `serve` or `onboard` | Current builds read the same persisted store the rest of the product uses: `<sessions-dir>/settings.json` is loaded at startup and re-resolved before every turn and compaction (persisted presets, manual fields, decrypted stored keys). If it still differs, the stores or the overrides differ. | Make sure the TUI runs with the same `--sessions-dir` as the settings writer; check the precedence: explicit `--base-url`/`--api-key`/`--senior-*`/`--junior-*` flags and `TWO_BROTHERS_*` env pairs beat persisted settings (env-pinned fields are never persisted), then a named `provider_ref`, then seed presets. `/provider` shows the effective per-role summary. |
| A saved `provider_ref` no longer exists (preset deleted/renamed) | A dangling reference is resolved honestly: the TUI warns at startup and falls back to that role's manual fields instead of crashing | Reconnect with `/provider`, or fix the reference in the web Settings. |
| A turn fails to connect | The provider's own error is shown and the TUI adds the actionable path rather than leaving a generic failure | Run `/provider` to connect a provider, or pass `--base-url`/`--api-key` (and the per-role variants) for this run. |
| `/provider` save fails | The write is one atomic settings-store save (key encrypted at rest); on failure the dialog stays open with the real error and nothing changed | Fix the reported error (usually the sessions directory/settings file not writable) and save again; no partial state is left behind. |
| The provider summary says `API key: not set` although I saved one | The TUI is reading a different settings directory, the key belongs to another preset than the effective one, or an env-pinned/model field replaced that role's connection | Check `--sessions-dir`, confirm the role's preset/manual connection in `/provider`, and remember env pins win; re-run `/provider` after changing settings elsewhere. |
| `/provider` refuses to change anything while a turn runs | Provider changes are refused while a turn or compaction is in progress so an in-flight run cannot switch endpoints mid-call | Stop or wait for the turn (then `/provider`), or change it before starting the next task. |
| An explicit `--provider openai` did not override the persisted non-default provider | Older builds could not distinguish a flag that repeats the default from an absent flag; current builds record provenance (`providerExplicit`), so an explicit `--provider`/`TWO_BROTHERS_PROVIDER` value wins even when it equals the default | Update to a current build. Without either, the persisted provider staying in effect is the intended behavior. |

## TUI keys and prompt-history files

| Symptom | `doctor` check | Fix |
|---|---|---|
| `doctor` reports `tui-keys` warn with a chord message (e.g. `"palette" must be a non-empty array of chord strings`) | `tui-keys` loads the same file the TUI uses — `TWO_BROTHERS_TUI_KEYS_FILE` when set, else `~/.two-brothers/tui-keys.json` — and shows only the resolver's first bounded diagnostic, never the file contents | Fix the binding (an array of chord strings such as `["ctrl+p"]`) or delete the file to return to the default chords; the TUI keeps the defaults until the file loads. `doctor` and the TUI agree because they share the loader. |
| `doctor` reports `tui-history` warn: `not valid JSON — delete it to start a fresh history`, or an unsupported-version message | `tui-history` reads `TWO_BROTHERS_TUI_HISTORY_FILE` or `~/.two-brothers/tui-history.json` and classifies the document before asking the store for the effective entries | Delete the file (prompt history is optional; the TUI recreates it on the next accepted submission) or restore a `{"version": 1, "entries": [...]}` document. The reply never quotes the file's text. |
| `tui-keys` passes with `not found — defaults active` or `tui-history` passes with `not found — no saved prompt history (optional)` | Absent files are a pass, not a problem | Nothing to fix. An explicitly named file (`TWO_BROTHERS_TUI_KEYS_FILE`) that is missing is a warn because you asked for that file. |

## Approval modes

| Symptom | Why | Fix |
|---|---|---|
| A run still asks for every mutation although Settings → Approvals shows Read only / Edits / Allow all | The mode applies to **new** workspace runs, and the effective mode is the persisted setting unless a server/TUI process pin overrides it | Start a new run (an in-flight run keeps the policy it started with); check that the backend is current and that `serve`/`tui` was not started with `--approval-mode` or `TWO_BROTHERS_APPROVAL_MODE` (a pin wins and is never persisted). `GET /api/settings` reports `approval_policy: {mode, pinned}`. |
| The mode selector in Settings is disabled | A serve flag/env pin owns the mode (`pinned: true`), or the backend is older and does not report `approval_policy` | Restart `serve` without `--approval-mode`/`TWO_BROTHERS_APPROVAL_MODE`, or rebuild the backend from this checkout for the additive section. |
| `readonly` denies a write with no approval card | By design: the mode closes that action deterministically — a broker cannot re-open what the mode closed | Switch to Ask/Edits in Settings, or run the server/TUI with the intended `--approval-mode`; `ask` remains the fail-closed default. |
| Every run prints `[warn] approval mode "allow-all": …` | `allow-all` is the only mode that removes the operator from the loop, so every run/startup shows one visible warning (and the TUI shows a warning toast each workspace turn) | Expected. Use `edits`/`ask` if you do not want unattended deletes and shell commands; the warning cannot be silenced while the mode is active. |
| A stored mode seems ignored / the dialog says the mode is pinned | A `--approval-mode` flag or `TWO_BROTHERS_APPROVAL_MODE` pinned the mode for that server/TUI process; the pin never reaches `sessions/settings.json` | Restart without the pin and the saved `approval_policy` applies again. A missing/corrupt stored policy always reads as `ask`. |
| An unknown `--approval-mode` fails the command | The value is a strict enum, validated before any run | Use exactly `ask`, `readonly`, `edits` or `allow-all` (the usage error lists them; exit 2). |

## Prompt recall (composer history)

| Symptom | Why | Fix |
|---|---|---|
| `Up` in the composer moves the caret instead of recalling a task | A multiline draft only leaves the composer at its very start (Up) or very end (Down); inside the draft the arrows are normal caret movement | Put the caret at the very start/end (`Ctrl+Home`/`Ctrl+End` in the TUI) and press Up/Down again, or use a single-line draft where recall applies immediately. |
| The web composer recalls nothing | Recall only applies while the mention/command picker is closed, only accepted submissions are recorded, and the bounded local history can be missing after blocked storage/private mode | Close the picker; recall after a submission (a rejected request is not recorded); nothing to fix if the browser blocks `localStorage` — recall simply does not survive the reload there. |
| `Down` lost the text I was writing | By design the live draft is stashed when recall starts and restored when you step past the newest entry — editing a recalled entry turns it into the draft | Press `Down` once more on the newest entry (or switch sessions and back) to get the stashed draft; the TUI keeps the same contract. |
| A recalled task appears in the web draft store | It should not: recall writes the stashed live draft to the drafts blob, never the recalled text | Rebuild `web/` from this checkout; a recalled entry is only the composer's in-memory text. |

## Live CLI output and machine modes

| Symptom | Why | Fix |
|---|---|---|
| Piped/CI output shows no activity rows and no block-by-block streaming | Live output is TTY-only; a pipe always prints the finished transcript once, and `--live` cannot force a pipe to stream | Expected for scripts. Run interactively to see the live transcript. |
| The TTY transcript is too noisy / you want the old single render | `prompt_audit` and tool progress rows are dim `· …` activity lines printed as work happens | Use `--no-live` (or pipe the output) to print the finished transcript once; machine modes never stream. |
| `--json`/`--json-events`/`--stream`/`--mode print` output changed shape or gained escape bytes | It should not — live output never applies to those modes, and the hermetic E2E pins their bytes | Re-run with `--verbose` and report the exact command; `--live`/`--no-live` are only accepted by `run`/`chat`. |
| `--live`/`--no-live` is rejected by `serve` or `tui` | Both flags are `run`/`chat`-only (like `--dry-run`); unknown-option usage errors exit 2 | Drop the flag, or move it to the `run`/`chat` command that prints a human transcript. |

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

## Shell output and process trees

| Symptom | Why | Fix |
|---|---|---|
| A `workspace_run_shell` result ends with `...[truncated N chars]...` | Output is captured as a bounded head+tail stream (the default cap is 20 000 characters per stream): the first and last halves are kept and `N` is the number of characters omitted. A command like `yes` therefore costs bounded memory instead of the whole stream. | Deliberate. Make the command print less (redirect to a file, `\| tail -n 200`, `--quiet`) when you need the middle of the output. |
| A timed-out or cancelled shell command still seems to leave a process behind | Cleanup kills the whole tree: on Windows via the absolute `%SystemRoot%\System32\taskkill.exe /F /T /PID`, on POSIX via the child's own process group; when the kill cannot complete, the runner falls back to `child.kill()`. | Nothing to do for a process the runner started. A survivor was already detached from that tree (`start /B`, a service, a daemon) — kill it explicitly; the runner only reaps what it spawned. |
| A model-supplied shell timeout looks clamped | `run_shell` clamps the model's timeout to 1–600 seconds (default 30 s; a non-positive value means no timer). | Pass a realistic timeout in the tool call; the clamp keeps a runaway command from hanging a run. |

## Web plan, folding and status seats

| Symptom | Why | Fix |
|---|---|---|
| The web **Plan** dock never appears although the model planned something | `todo_write` is a tool the model chooses to call, and the dock is projected from `todo_updated` runtime events — an older backend never emits them | Rebuild and restart the backend from this checkout; a run whose model never calls `todo_write` legitimately has no plan. The dock is per session and restores on reload from the runtime sidecar. |
| Older tool rows did not fold / a fold row disappeared on reload | Folding only groups tool/prompt-audit rows attributable to a run that is not the one being followed (single rows stay open; the followed run stays open); expanded/collapsed state is per mount, so a reload or session switch resets it to collapsed. An older backend whose tool events carry no run id cannot attribute rows, so they stay open. | Expected. Click the `… N tool calls · expand` row again to expand it in place; rebuild/restart the backend to get run ids on tool events. |
| A folded row's text is not found by Ctrl+F | Collapsed rows are removed from the DOM, exactly like hidden prompt-audit rows — find searches what the transcript renders | Expand the fold row, then search again. |
| Composer status seats are missing | Every seat hides when its data is unknown: models need loaded role settings, the permission seat needs a known workspace context, and the context seat needs at least one prompt audit | Send a run so a provider call is audited; the seats appear as their data becomes known (a linked workspace shows the effective approval mode: "Ask in app" by default, or "Read only"/"Edits auto"/"Allow all" from Settings → Approvals). No numbers are guessed by design. |
| A welcome-hero starter did not send the task | Starters only prefill the editable composer — they never submit for you | Edit the prefilled text and press `Enter` (or the Send/Queue control). |

## Web approval card (reasons and preview)

| Symptom | Why | Fix |
|---|---|---|
| A delete/shell approval card shows a reason, but a write/edit one does not | By design: shell and delete have no honest diff to show, so they carry a fixed reason (shell effects cannot be previewed; deletion cannot be undone). Write/edit approvals carry none because their unified diff is the explanation. | Read the reason (or expand the preview) before answering; nothing is missing for write/edit. |
| No **Preview the change** / **Preview the command** toggle on a card | The backend sent no additive `detail` (an older backend), or the request has no renderable diff/command (e.g. a delete of a large/unreadable file is approved by path alone) | Expected; old backends degrade to the previous card. Rebuild the backend from this checkout for diffs/commands that are actually previewable. |
| The preview shows a `clipped` badge | The backend bounded the detail at 20 000 characters (head-preserving) — the same cap the approval event carries | The complete diff is still available after the run in the changed-file review; the badge is honest about the preview, not a failure. |
| The reason disappeared after Allow/Deny | A card from an older backend that does not keep the request reason on the resolution — current backends retain it (`cancelled` wins when a run is cancelled) | Rebuild the backend; the resolved history card keeps the reason verbatim on current builds. |

## Usage errors and exit codes

Usage errors are rejected before `doctor` runs, so they have no check id.
Near-miss command and option names get a suggestion on stderr, for example
`Unknown command: docter` / `Did you mean 'doctor'?` or
`Unknown option '--tmeout'` / `Did you mean '--timeout'?`.

| Code | Meaning | What to do |
|---|---|---|
| `0` | Success; `doctor` when no check failed | — |
| `1` | Run error (including a provider call failure), or `doctor` with a failed check | Follow the failing `doctor` check above. If `doctor` passes but `run` exits 1, the provider call itself failed (for example `fetch failed`); re-run with `--verbose` and check the endpoint's log. `doctor` only probes `GET /models`. |
| `2` | Usage error: unknown command or option, a missing command argument (task, shell, session), the TUI without a TTY, an invalid `tui --workspace` root, or an invalid `--approval-mode` value; `doctor` also returns 2 for an invalid provider flag | Read the usage line on stderr, then run `help <command>` or the command's `--help`. |

See the [CLI reference](cli-reference.md#return-codes) for the full command and
flag surface, and [Quickstart](quickstart.md) for a working configuration.
