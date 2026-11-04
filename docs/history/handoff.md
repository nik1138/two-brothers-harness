# HANDOFF

Status snapshot of the **Two Brothers** harness, written 2026-10-31,
**refreshed 2026-11-03** (TypeScript-first reframe). Read this first when
picking up the project; working rules live in `AGENTS.md`.

## What this is

A harness for cooperation between two sibling agents sharing one context:
an **older brother** (senior — experienced and level-headed, the arbiter) and a
**younger brother** (junior — brave and determined, the challenger). They
exchange structured protocol envelopes (`PROTOCOL.md`); the senior consults the
junior, may delegate tool work to it, reviews the result, and makes the final
decision.

## Implementations (2026-11-04 framing)

- **`packages/harness/` — the implementation.** Publishable TypeScript package
  (`@two-brothers/harness`, pi / deepseek-harness style, npm candidate):
  cooperation core + execution tier, FastAPI-compatible `node:http` server
  (`node dist/cli.js serve`), runtime manager + SSE, settings/secrets stores,
  MCP with role scoping, plugins, context compaction. **All new features,
  protocol work, and hardening land here.** Plan + dependency ledger:
  `docs/history/ts-rewrite-plan.md`; shipped-feature details:
  `packages/harness/AGENTS.md`.
- `typescript/` — zero-dependency protocol reference (documents the
  `PROTOCOL.md` contract). Not modified by feature work.
- The original Python prototype (LangGraph + LangChain) was **removed from the
  repository on 2026-11-04**; its sources live only in git history. The
  captured `SPARK-TRANSCRIPT.md` / `LMSTUDIO-TRANSCRIPT.md` runs remain as
  evidence, and the verification log below is kept for the record.

## Current verified state (2026-11-03)

| Check | Result |
|---|---|
| `packages/harness` gates (typecheck, build, selftest) | PASS |
| Unit tests `npm test` / `npm run test:spawn` | 0 failures (1 pre-existing skip: Windows symlink policy) across **418/436** tests (post-Wave-3) |
| Root supply-chain checks `npm run check` | PASS (exact pins + runtime-dep AST scan) |
| Publish gates `npm run pack:check` (publint + attw) | clean (0.1.0 release committed 2026-11-02, `353ecdd`) |
| Browser E2E `scripts/e2e-test.ps1` | TS backend **5/5 PASS** re-verified on the Nikita account (chat/resume/approval-allow/approval-deny/stop). The runner is TypeScript-only since 2026-11-04 (the Python backend half was removed with the prototype) |
| Hermetic E2E suites (`npm run test:e2e` / `test:e2e:dist`, packages/harness) | 15 suites green (2026-11-03): consult, work-approvals, resume, server-consult, server-work-approvals, server-status-waiting, server-mode-contract, server-error-restart, server-prompt-audit + connection probes; the python-parity suite counted there was removed with the prototype on 2026-11-04. Live LM Studio variants of the status contract ran 14/14 while the endpoint was reachable (park/resolve ordering, mode round-trip, provider-4xx error surviving a server restart) |
| LM Studio live smoke (2026-11-03, `spark-x2.6-4b@q4_k_m` senior + `lfm3-1.7b` junior) | Full state machine completes in chat and work modes; graceful degrade (warnings + exit 1) on unstructured small-model replies. **Finding → fixed:** the junior used to hallucinate listings for lack of tool prompts; with prompt sections it uses its MCP tools and records `tool:` evidence (no hallucination). Node payloads still sanitize-fallback on these small models (their own recorded gap). Endpoint unreachable from the Nikita account as of 2026-11-03 evening — suites SKIP cleanly |

Wave 2 (2026-11-02/03, all committed on `main`): sub-wave A — SSE
`run_status: waiting`, `RunRecord.mode`, restart-surviving run errors
(sidecar rebuild), provider error-classification registry + `Retry-After` +
`ProviderContextOverflowError` (pi port), MCP namespacing/result-cap/timeout,
pi fuzzy edit matching + per-file mutation queue (`8c3de66`). Sub-wave B1 —
compaction v2: split-payload cuts, `<previous-summary>` chaining, reserve
trigger, overflow→compact-and-retry (`df999b5`). B2 — prompt sections +
per-call prompt audit (`d37808d`). C — web polling-workaround removal
(`8a196cb`) + status-contract e2e suites (`c82b7d2`).

Wave 3 (2026-11-03, all committed on `main`): plugins shared by default —
one list, both brothers (`0ff7f4e`); Anthropic + Google Gemini adapters
with kind dispatch + full retry-registry integration (`113c349`);
`prompt_audit` as a live SSE runtime event + web timeline (`8045a43`);
preset `kind` reaches providers on the server path, paired with borrowed
URLs only (`e420d9a`); token-based compaction accounting — `estimateTokens`,
`--context-window`, token-mode budgets with char back-compat (`f68f582`).

## Environment quirks (this machine — important)

- **Node.js is a no-admin zip install**: `%LOCALAPPDATA%\Programs\nodejs`
  (v22.19.0 + npm 10.9.3, 2026-11-03). Git Bash does NOT inherit its PATH —
  prefix commands with `export PATH="$HOME/AppData/Local/Programs/nodejs:$PATH"`.
  winget MSI installs stall on an unattended UAC prompt; the zip method works.
- The repo ownership references a deleted `guest` account —
  `git config --global safe.directory C:/code/two-brothers-harness` was
  added on the Nikita account; git identity is repo-local
  (`Nikita <nik1138@mail.ru>`).
- The removed Python prototype's `.venv/` at the repo root is dead on this
  account (it points at an interpreter inside a deleted user profile). No
  system Python either; nothing in the product path needs one. The directory
  is no longer gitignored and can be deleted freely.
- LM Studio runs at `http://172.18.0.1:1234/v1` with two models loaded:
  `spark-x2.6-4b@q4_k_m` (older brother) and `lfm3-1.7b` (younger brother).
  Both verified to tool-call (2026-11-03). **Not reachable from inside WSL**
  (firewall/NAT) — real-model runs must be launched from the Windows side
  (PowerShell or Git Bash). Mock runs and the web workspace work from WSL.
- Git Bash: `grep -P` is broken unless `export LC_ALL=C.UTF-8`.
- Node v24.13 / npm 11.6.2 available. Package `engines` floor: Node ≥ 22.19.
- Stale `packages/harness/sessions/` artifacts break
  `tests/cli.test.ts` ("default sessions-dir is 'sessions'") — delete the
  directory before running package gates; use `--session-file` or a temp cwd
  for real-model runs (`run` has no `--sessions-dir`; only `serve` does).
- vite/esbuild temp-dir flake on OneDrive `node_modules` can become
  persistent; workaround: `ESBUILD_BINARY_PATH=C:\esbuild-tmp\esbuild-copy.exe`
  (a copy lives there) or repo-local TMP/TEMP via `cmd //c`.
- `TWO_BROTHERS_SHELL_PATH_EXTRA` prepends dirs to the confined
  workspace-shell PATH (point it at the directory holding the binaries your
  tool proofs call).

## How to run (TS first)

```powershell
# package gates
cd packages/harness
npm install
npm run typecheck; npm run build; npm test; npm run test:spawn
node dist/selftest.js

# offline mock run (ephemeral; add --session-file to persist)
node dist/cli.js run "Plan a migration from Redis to Valkey" --provider mock

# real run against LM Studio (from the Windows side); --mode work enables tools
node dist/cli.js run "<task>" --mode work `
  --senior-base-url http://172.18.0.1:1234/v1 --senior-api-key lm-studio `
  --senior-model "spark-x2.6-4b@q4_k_m" `
  --junior-base-url http://172.18.0.1:1234/v1 --junior-api-key lm-studio `
  --junior-model "lfm3-1.7b" --session-file my-run.jsonl

# web workspace
cd packages/harness
node dist/cli.js serve --port 8600 --sessions-dir sessions
# then open http://127.0.0.1:8600  (or: cd web && npm run dev)
```

## Dependency pins (settled — do not reopen)

npm runtime deps (exact pins, enforced by `npm run check`): `zod` 4.6.7
(payload validation — the pydantic analogue), `@earendil-works/pi-mcp` 1.5.0
(MCP client — pulls one pure-JS transitive dep, `cross-spawn`). devDependencies
(typescript, @types/node, publint, attw) are free. Web deps frozen: vue, vite,
naive-ui only. See the ledger in `docs/history/ts-rewrite-plan.md`.

The removed prototype's Python pins are recorded in this file's git history;
nothing in the current tree depends on them.

## Historical verification log (2026-10-31 → 2026-11-02)

Python-era and port-era evidence; kept for the record. New work should cite
the Current verified state table above, not these rows.

<details><summary>Expand</summary>

### Earlier snapshot (2026-10-31, before the web-workspace modules landed)

| Check | Result |
|---|---|
| Python unit tests (`python/tests/`, unittest) | 42/42 OK |
| `python -m two_brothers selftest` | SELFTEST: PASS |
| Real LM Studio run (senior `spark-x2.6-4b@q4_k_m`, junior `lfm3-1.7b`) | consult → proposal → review → decision, all envelopes pass `validate_message` (`sessions/lmstudio-consult.jsonl`) |
| MCP delegation run (demo server via `langchain-mcp-adapters`) | deliverable contains `mcp:echo_text` artifact (`sessions/lmstudio-mcp.jsonl`) |
| FastAPI serve + built web viewer | E2E via curl OK |
| TypeScript `node tests/run-all.ts` | 33/33 |
| `pwsh scripts/smoke-test.ps1` | SMOKE TEST: PASS |

Web-workspace additions (2026-10-31):

| Check | Result |
|---|---|
| Real LM Studio **coding run + follow-up** in the web workspace (`sessions/2026-10-31T19-02-51.jsonl`, workspace `e2e-workspace`) | Two consecutive runs completed (delegation with tools, then a follow-up consult). The junior fixed `calc.py` via `workspace_edit_file` (+1/−1, file verified on disk); 19 tool calls, 14 operator approvals all resolved `allow`; runtime sidecar `sessions/runtime/2026-10-31T19-02-51.jsonl.events.jsonl` |
| Caveat on that run | In-run shell proof commands could not find a Python interpreter (exit 9009 — Git Bash PATH inside the confined workspace); the edit itself succeeded and is confirmed by file content. Do not cite the run as "shell execution proven" |

Stages 7–8 additions (2026-11-01):

| Check | Result |
|---|---|
| Naive UI migration (`web/`): naive-ui component library, dialogs on n-modal/n-form, theme follows OS dark/light | `npm run build` PASS; browser E2E 5/5 PASS with zero selector changes; independent frontend review: "ready to call done" |
| Backend robustness: empty config defaults, fail-fast runs (readable error, no network), 120 s request timeout + 1 retry, stop-during-call ends `cancelled` | Python suite 148/148; fail-fast CLI exits 1 in ~1.2 s; real LM Studio run green |
| Settings persistence + secrets: per-role settings to `sessions/settings.json`, API keys DPAPI-encrypted (stdlib ctypes, `plain1:` fallback off Windows), env beats file and is never persisted | Restart-restore verified; live leak probe clean (key absent from API, file bytes, sidecars); masking unchanged |
| Independent backend review | No blockers; DPAPI code verified (blob lifetime, 64-bit argtypes, LocalFree); nice-to-haves fixed: atomic write, env-filter, validate-before-MCP |

Stages 10–14 additions (2026-11-01, night session):

| Check | Result |
|---|---|
| Python suite with retry/usage coverage | 180/180 OK (32 new: retry loop, usage aggregation, DELETE session, session-name shape) |
| Retry policy | 7 attempts, exponential backoff 2/4/8/16/30/30 s, per-attempt `Config.timeout`, cancel-interruptible; env/CLI `--retries` |
| Usage stats | `usage = {model_calls, input_tokens, output_tokens, cached_tokens}` on `run_end` + run records + sidecars; cache % from LM Studio `prompt_tokens_details`; CLI footer `tokens: in/out (cache x%, N calls)` |
| Browser E2E | 5/5 offline scenarios + **6/6 with `TWO_BROTHERS_REAL_E2E=1`** (real spark+lfm cycle in ~73 s, usage asserted) |
| Frontend | Sidebar rename/delete/search + workspace refresh; composer empty-settings hint; chat rendering (code fences, links, copy, timestamps); "who is acting" live indicator; Kimi-style usage footer; context meter (30/80 thresholds) |

Stages 15–16 additions (2026-11-01, night session, contd.):

| Check | Result |
|---|---|
| Parallel runs | Worker pool (default 2, `--workers`/`TWO_BROTHERS_WORKERS`); same-session runs serialize; per-run cancel/approval isolation; sidebar live-dots for all live runs; 5-test concurrency suite |
| Plugin system | `plugins/` loader + `PluginContext` (fail-soft, built-in name collisions rejected); per-role assignment in Settings (multi-select), `TWO_BROTHERS_PLUGINS_*` env wins and is never persisted; plugin tools confined + approval-gated via the workspace broker; example `plugins/notes.py`; 13 tests; see `docs/plugins.md` |
| Review passes (night) | Two read-only reviewers (backend/frontend + plugins): no blockers; findings fixed — live-run DELETE stops the run first, `?session=` empty-string poll bug (root-caused a real-E2E UI freeze on >5 s runs), structured-fallback retry budget capped, env-removal plugin overwrite, session-name 400s, cancel race, cache-% clamp, composer hint refresh |
| Final gates | Python 199/199 · TS 33/33 · smoke PASS · `npm run build` PASS · browser E2E 5/5 + real-model 6/6 (spark+lfm, ~67 s, usage asserted) |

Stage 17 additions (2026-11-01, night session, contd.):

| Check | Result |
|---|---|
| Chat scroll fix | Root cause: flex chain without `min-height: 0` grew past `100dvh` and got clipped — no scrollbar. Fixed in `.chat-shell`/`.chat-view` (+`overflow-anchor: none`); auto-scroll now near-bottom-only and fires on mount (opening a session lands on the latest message). Verified in browser on a 35-envelope session |
| Folder explorer | `GET /api/fs/browse?path=` (dirs-only, sorted, 500 cap + `truncated`, 400 on nonexistent, Windows empty path → drive roots); `FolderPicker` dialog in Add-workspace ("Browse…"); full descend/parent/select flow verified headlessly (Playwright + system Edge) |
| Provider presets | Named presets (`name`/`base_url`/DPAPI-encrypted `api_key`) in `sessions/settings.json`; CRUD at `/api/providers` (409 duplicate, key never echoed, omitted key = keep); per-role `provider_ref` in settings (400 on unknown preset); resolution env > preset > manual, model untouched, deleted preset falls back to manual |
| CLI audit + fixes | `docs/history/cli-audit.md` (F1–F9); landed: broad error handling with connection hint (no raw tracebacks), UTF-8/`backslashreplace` stdio reconfigure (CJK tasks no longer crash cp1251 consoles), chat banner with resolved provider/model per role, `/exit` `/quit` aliases, `two-brothers sessions` listing; real LM Studio consult verified (2 min 32 s, exit 0). Deferred: LM Studio `tokens: 0/0` (usage metadata absent from that model — see F8) |
| Final gates | Python 247/247 (3 skips: 2 platform + 1 pre-existing) · selftest PASS · TS 33/33 + selftest PASS · `npm run build` (vue-tsc + vite) PASS · browser E2E 5/5 offline PASS · smoke PASS · **real-model E2E 6/6 after the review fixes** (spark+lfm web run, 78 s) |
| Integration fix during verification | naive-ui fires `mask-click` for clicks inside a *stacked* dialog (vdirs clickoutside is per-body) — both dialogs died on any click. Fixed via sibling-root mount for FolderPicker + `src/modal.ts` guard (`clickInModalBody`) wired into all four dialogs' mask-click handlers; genuine mask clicks still close |
| Review passes (Stage 17) | Backend: FIX-FIRST — 1 blocker (provider endpoints persisted env-pinned values incl. `TWO_BROTHERS_API_KEY`; fixed via `_persistence_snapshot` used by every write site) + 2 concurrency findings (`settings_lock` around all read-modify-write cycles) + case-insensitive preset matching + fs/browse vanished-dir 400; all fixed with regression tests (247 total). Frontend: SHIP — fixed: ChatView keyed by session (switch lands on latest message), role form re-syncs when its preset is deleted, FolderPicker request sequencing token, empty-base-URL edit refused; nice-to-haves documented in `modal.ts`/code |

Night-session environment notes (still relevant):

- New env knobs: `TWO_BROTHERS_RETRIES` (default 6 → 7 attempts, backoff 2/4/8/16/30/30), `TWO_BROTHERS_WORKERS` (default 2), `TWO_BROTHERS_PLUGINS_SENIOR`/`_JUNIOR`.
| Python suite (`python/tests/`, unittest, re-run 2026-10-31) | **124/124 OK** (1 pre-existing skip: Windows symlink policy); includes 9 HTTP E2E tests (`test_e2e_http.py`) |
| Automated E2E (2026-10-31) | Python HTTP E2E 9/9 inside unittest — real server subprocesses + scripted fixture `tools/e2e_scripted_server.py`, genuine approval broker (allow writes, deny absent), stop/cancel, follow-up; browser E2E 5/5 — `e2e/` Playwright + system Edge headless (chat, resume, approval allow/deny, stop); `SMOKE TEST: PASS` |

Evidence: `LMSTUDIO-TRANSCRIPT.md` (root), session JSONL files and
`*/runtime/*.events.jsonl` sidecars in `sessions/`.

### TypeScript npm-package port (2026-11-01 → 2026-11-02)

Core + execution tier ported to `packages/harness/` (npm workspace; plan:
`docs/history/ts-rewrite-plan.md`). tsc build to `dist/` with declarations.
CI: `.github/workflows/ci.yml` (Node 22/24); publish workflow
`publish.yml` (tag `v*`, npm Trusted Publisher OIDC, gated on full gates +
`pack:check`, publishes `--tag next`) — **do not push a `v*` tag until the
npm org + Trusted Publisher are registered by the project owner**.

| Check | Result |
|---|---|
| `npm run typecheck` / `npm run build` (packages/harness) | clean, 0 errors |
| `npm test` (in-process) / `npm run test:spawn` | 0 failures (1 env skip: symlink creation disallowed on this machine — Python suite skips identically) |
| `node dist/selftest.js` | SELFTEST: PASS |
| Byte-stability vs Python | `dist/cli.js run --provider mock` output identical to `python -m two_brothers` (modulo CRLF stdout artifact), including `tokens:` usage footer |
| Session JSONL + resume | seq dense 1..10 across run + `--resume`, no duplicates; `sessions` lists derived titles |
| Work mode + approvals from built dist | junior write/shell brokered (write, shell), senior verify read slice, `tool:`/`verify:` evidence, usage snapshot 8 calls |
| Packed tarball smoke | `npm pack` → temp install → selftest PASS, mock run OK, `npx two-brothers` bin works |
| Real-model E2E vs LM Studio (`npm run test:e2e` / `test:e2e:dist`, suite in `packages/harness/e2e/`) | 5/5 suites PASS on **both** src and dist variants (2026-11-01, `spark-x2.6-4b@q4_k_m` + `lfm3-1.7b` via `http://172.18.0.1:1234/v1`): connection probe, consult (5 envelopes, ≥4 calls, markers, zod), work (approvals brokered, calc.js verified on disk, `tool:`/`verify:` evidence), resume (dense seq 1..10), python-parity (shape matches). Evidence: `packages/harness/e2e/runs/report-2026-11-01T15-58-10-298Z.json` (src) and `report-2026-11-01T15-55-26-964Z.json` (dist) + session JSONL/raw replies alongside. SKIP semantics proven: unreachable endpoint → `E2E SKIP:` + exit 0. Model quirks recorded in the reports: nearly all replies are unstructured/truncated JSON with non-protocol keys (tolerant fallback engaged every time; strict zod still green); spark once emitted `decision` as an object — tolerated per the sanitize contract (Python behaves identically), logged as a quirk |
| Server E2E over HTTP (same runner, +3 suites) | 8/8 suites PASS on **both** src and dist variants (2026-11-01/02, same models/endpoint): `connection-server` (in-process `node:http` server on an ephemeral port), `server-consult` (`POST /api/runs` → SSE envelope stream with increasing `id:` frames, `run_end` completed + decision + ≥4 calls, `?after=` reconnect, session JSONL validated on disk), `server-work-approvals` (workspace registered over HTTP, 3–4 approvals requested/resolved mid-stream via `POST /api/runs/{id}/approvals/{id}`, calc.js verified on disk). Evidence: `packages/harness/e2e/runs/report-2026-11-01T21-41-52-211Z.json` (src) and `report-2026-11-01T21-44-10-833Z.json` (dist), plus `server-*` session dirs (JSONL + runtime sidecars + workspaces.json) and `server-*-events-*.json` SSE dumps |
| Release prep (2026-11-02) | **Package metadata finalized** (`@two-brothers/harness` 0.1.0 — first public release line; `publishConfig` with `access: public` + `provenance: true`, description/exports/bin/files/engines/license); **publish gates** (`npm run pack:check` = `publint` + `attw --pack`, wired into the release workflow); **supply-chain scripts** (root `npm run check` = exact-version pin check + AST runtime-deps check in `scripts/check-pinned-deps.mjs`/`check-runtime-deps.mjs`, `npm run check:tarball-smoke` = tarball-install smoke into a temp consumer, `.husky/pre-commit` lockfile-commit guard, per-package `CHANGELOG.md` with `[Unreleased]`); CLI UX (bare `two-brothers` enters REPL on TTY, `/help` `/config`, piped-script REPL driving); web Wave-1 (markdown renderer, incremental projections, run-error UI, `waiting` status, theme pin; E2E 10/10) |

Dev note: package scripts run `.ts` sources via Node native type stripping —
**Node ≥ 22.6 required** for dev/test; the built package declares
Node ≥ 22.19 (the pi-mcp floor).

</details>

## Machine-local artifacts (gitignored)

`sessions/`, `sessions/runtime/` (per-session tool/approval event sidecars),
`sessions/workspaces.json`, `sessions/*.meta.json`,
`server.log`, `mcp-demo-config.json` (contains machine-specific absolute
paths; build one from the MCP config example in the docs),
`web/node_modules/`, `web/dist/`, `e2e/node_modules/`,
`packages/harness/sessions/`, `packages/harness/dist/`,
`research/` (the whole tree: vendored MIT clones of pi / kimi-code /
deepseek-harness / opencode plus local research notes — never committed
or published),
`.build-tmp/` (repo-local TMP/TEMP for the esbuild workaround), and
`.e2e-tmp/` (recreated on demand by the E2E suites; gitignored).
The dead `.venv/` of the removed prototype still sits in a local checkout;
it is no longer listed in `.gitignore` and can be deleted.

## Known gaps

See `docs/design-review.md`: no real-network tests, no load tests, no
timeout tests, no cross-language transport. Web-workspace specifics: run
records and pending approvals are **in-memory only** (lost on backend
restart; session JSONL, `*.meta.json`, provider presets, and
`sessions/runtime/*.events.jsonl` survive in `sessions/`); since Wave 2 the
terminal **error** of a failed run survives a restart (`GET /api/runs/{id}`
falls back to the sidecar scan and rebuilds a minimal record), but the
record list itself and non-terminal state are still in-memory. Runs execute
on a worker pool (default 2, `--workers`/`TWO_BROTHERS_WORKERS`) with
same-session serialization; there is no auth — it is a local single-user
server. Small-model payload discipline is weak without the B2 prompt
sections (unstructured replies sanitize-fallback every node; see BACKLOG).
These were **not** commissioned — check with the project owner before
starting them.
