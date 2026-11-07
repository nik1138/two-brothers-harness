# Testing

The **implementation is the TypeScript package** (`packages/harness/`,
`@two-brothers/harness`): its gates are what decide whether the product is
green, and new tests land there. The `typescript/` tree is the zero-dependency
protocol reference; its suite is kept as a contract check.

## Quick check

```powershell
cd two-brothers-harness
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/smoke-test.ps1
```

(`pwsh` is not installed on this machine; use Windows PowerShell as above.)
The script runs:

1. `packages/harness` `npm run typecheck`
2. `packages/harness` `npm run build`
3. `packages/harness` `npm test`
4. `node dist/selftest.js`
5. a demo run through the built CLI on `mock`
6. the hermetic CLI E2E (`node e2e/cli.ts`)
7. the `typescript/` reference selftest
8. the `web/` unit tests (`npm test` — chat, timeline, drafts, palette,
   session-status, recents, density, find, content-search, mentions and
   streaming)
9. the `web/` build

Expected final line: `SMOKE TEST: PASS`. It is an offline pre-flight, not the
whole product gate — run the package gates below for that.

## CI coverage

`.github/workflows/ci.yml` runs on every push and pull request to `main`, on
Node 22 and 24 (the `engines` floor and the next supported release), in this
order:

1. `typescript/`: `node src/selftest.ts`, then `node tests/run-all.ts`
   (no install step: the reference is zero-dependency);
2. `packages/harness`: typecheck, build, `npm test`, `npm run test:spawn`,
   `node dist/selftest.js`, and the mock CLI run;
3. `packages/harness`: the hermetic CLI E2E — `node e2e/cli.ts` (sources)
   and then `node e2e/cli.ts --dist` (the built CLI);
4. `packages/harness`: `node e2e/run.ts` with
   `TWO_BROTHERS_E2E_BASE_URL=http://127.0.0.1:9/v1`. The closed port makes
   the endpoint probe fail immediately: the runner logs one `E2E SKIP:` line
   (and records a synthetic `connection` SKIP entry), omits the live-model
   suites, then runs the hermetic server-status and prompt-audit suites and
   exits 0;
5. `web/`: `npm ci`, `npm test`, `npm run build`;
6. Node 22 only, after the web build: `node scripts/tarball-smoke.mjs` at
   the repo root and `npm run pack:check` in `packages/harness`. Both trigger
   the package `prepack` (build + `sync-web`), which is why they need
   `web/dist`; the packed artifact is identical on both matrix legs, so the
   heavier release checks run once, on the engines floor.

npm caching covers the root and `web/` lockfiles (`setup-node`); the
reference tree needs none. Network use is limited to npm (`npm ci` and the
tarball smoke's dependency install) — no CI step talks to a live model
endpoint.

## TypeScript package (primary)

```powershell
cd packages/harness
npm install
npm run typecheck
npm run build
npm run selftest        # node dist/selftest.js (after build)
npm test                # in-process node:test runner
npm run test:spawn      # node --test tests/ (child processes allowed)
```

Coverage: envelope and payload validation (zod), model output parsing,
`sanitize_payload`, the consult/work/revise state machine, byte-stable
transcript markers, session persistence (`--session-file` / `--resume`,
dense `seq`), context compaction, MCP loading and role scoping, the plugin
loader, the HTTP/SSE server and its run-status contract, the
provider error-classification registry, and the workspace tools
(confinement, approvals, diffs). The CLI-ergonomics suites cover the help
catalog, `sessions --json` / `sessions show`, `models` and `onboard`;
`tests/doctor.test.ts` covers the `doctor` diagnostics (injected transport and
clock, API keys never rendered), `tests/completions.test.ts` the deterministic
bash/zsh/fish/PowerShell completion generator, and
`tests/reliability.test.ts` the hermetic concurrency, restart, approval-race
and compaction-stress paths. Session search/export is covered by
`tests/sessionsearch.test.ts` (the pure module: matching, snippets, caps,
Markdown/JSON export shapes, tolerant loading), `tests/serversearch.test.ts`
(the `GET /api/search` and per-session export endpoints over a real
loopback server) and `tests/sessionscommands.test.ts` (the CLI subcommands and
their exit codes). Composer mentions/slash commands are covered by
`tests/mentions.test.ts` (token scanning, blocks, path normalization),
`tests/workspacefiles.test.ts` (bounded file index + picker ranking),
`tests/mentionswiring.test.ts` (the files endpoint and run-submission
expansion/injection over loopback) and `tests/tuipicker.test.ts` (the TUI
pickers + skill-attachment validation). Thinking/response streaming is covered
by `tests/thinkingstream.test.ts` (provider splits for all three wire families
and harness token kinds), `tests/servertokens.test.ts` (named live token SSE
frames, no persistence/replay) and `tests/tuithinking.test.ts` (the TUI live
THINKING block). The first-party command surface is covered by
`tests/basecommands.test.ts` (catalogue invariants, alias resolution incl. the
reference Chinese spellings, the `$ARGUMENTS` expansion grammar, usage errors,
metadata wire form, and byte equality with `expandCommand`),
`tests/serverbase.test.ts` (additive `baseCommands` in `GET /api/commands`,
prompt expansion + mode override + usage/action 400s in run submission,
discovered-template shadowing, and the manual compact route's
404/400/409/no-op/success/502 paths with an in-place dense-`seq` rewrite),
`tests/apicommands.test.ts` (the metadata-only catalogue with empty roots),
`tests/cliwiring.test.ts` section (iv) (the chat REPL prompt/action commands)
and `tests/tuibasecommands.test.ts` (TUI shadowing/precedence, picker
grouping/badges, Tab/Shift+Tab, the held-key guard, and fake-TTY action
flows). Workspace rename/ordering is covered by
`tests/workspaceorder.test.ts` (registry unit tests, persistence across
reload, permutation validation) and `tests/serverworkspaces.test.ts` (the
`PATCH`/`PUT` endpoints over loopback); the broker approval-repeat cap by
`tests/approvalbrokerdeny.test.ts`. The TUI lanes (`tests/tui*.test.ts`)
cover the editor, the keymap registry, the terminal, the views, prompt
history, the find-in-transcript overlay, and span-level Markdown styling
(`tests/tuistyle.test.ts` also pins byte-identical NO_COLOR output), with the
assembled app in `tests/tuiintegration.test.ts`. The TUI lanes and the
doctor, completions, reliability, search/export, workspace-order and
broker-cap suites are registered in `tests/run-all.ts`.

Hermetic offline CLI E2E: `npm run test:e2e:cli` (sources) /
`npm run test:e2e:cli:dist` (built `dist/cli.js`) drive the CLI as a
subprocess against the mock provider — **16 scenarios**: consult, chat-repl,
help, work, session+resume, mcp, serve, doctor (`--json`), completions
(`bash`), config (`--json`, masked keys), dry-run (plan text/JSON, no session
file), stdin (`run -`), sessions-json, sessions-show, sessions-search
(human and `--json`, short-query exit 2) and sessions-export (Markdown
stdout, `--output` file, missing session exit 1). CI runs both (see
[CI coverage](#ci-coverage)).

The CLI-ergonomics suite also covers `config`'s provenance precedence
(flag > role env > shared env > preset > settings > default) and key masking,
`run --dry-run` (no session write, no provider call), `run --task-file`, and
`run -` over piped stdin (spawned subprocess, blank/oversized input exits 2).

## Web workspace (`web/`)

```powershell
cd web
npm test                # every web suite below (node:test, offline)
```

The suite (`tests/chat.test.ts`, `tests/timeline.test.ts`,
`tests/drafts.test.ts`, `tests/palette.test.ts`, `tests/sessionStatus.test.ts`,
`tests/recents.test.ts`, `tests/density.test.ts`, `tests/find.test.ts`,
`tests/search.test.ts`, `tests/workspaceOrder.test.ts`,
`tests/mentions.test.ts`, `tests/streaming.test.ts`,
`tests/basecommands.test.ts`, `tests/composerKeys.test.ts`,
`tests/providerSettings.test.ts`, `tests/uiPrefs.test.ts`) covers the
envelope→group-chat projection, the runtime-event timeline merge, per-session
unsent drafts, palette building/scoring/filtering, sidebar row status, the MRU
workspace list, the persisted UI density preference, find-in-transcript
matching, content-search result shaping plus export helpers, the workspace
ordering helpers, the composer mention trigger/filter/insert model, the
bounded live-token streaming accumulator, the base-command catalogue merge
(sorting, discovered-shadowing, alias search, typed-command resolution,
compact request shape, old-backend fallback), the pure composer key
contract (IME/repeat-safe submit, `Ctrl/⌘+Enter`, picker accept/dismiss,
double-`Esc` window), the Settings → Providers preset model (tolerant
`seed`/`customized` normalization, inline detail open/selection, draft dirty
tracking, role usage badges, delete eligibility/impact copy, add-form
validation, keyboard arithmetic), the speaker labels (the operator reads
"You"), and the persisted conversation preferences + transcript visibility
filter (prompt audits are opt-in); 201/201 web tests. The modules are
dependency-free at
runtime, so plain `node --test` runs them via the `tests/register-ts.mjs`
bootstrap (a tiny resolve hook for the extensionless imports); `npm test`
wires that up. The full `web/` gate also includes `npm run build` (see the
smoke test above).

## TypeScript reference (`typescript/`)

Zero-dependency; documents the `PROTOCOL.md` contract and is not modified by
feature work.

```powershell
cd typescript
node src/selftest.ts
node tests/run-all.ts
```

`node --test tests/` also works where spawning child processes is allowed
(in sandboxes it can fail with `EPERM` — use `run-all.ts` there).

Coverage: envelope and payload validation, model output parsing, `sanitize_payload`,
the consult/work/revise loop, configuration precedence, and session persistence
(`tests/session.test.ts` — JSONL round-trip, resume with dense seq numbering,
missing/corrupt files). The `selftest` also includes an offline persistence
round-trip.

## End-to-end (E2E)

Two automated E2E layers complement the unit suites. Both are hermetic:
temp dirs, free ports, mock/scripted providers only, child processes reaped
after every run.

**Browser E2E** — `e2e/` (own package; `playwright` is the only dependency).
It drives the installed Edge headless, so no browser download is needed:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/e2e-test.ps1
# or directly (repo root):
node e2e/run.mjs
```

Scenarios: group-chat run with the mock provider (distinct role bubbles, no
raw-protocol leakage), reload/resume, approval card → file on disk →
changed-file diff (allow and deny paths), stop, the 390 px mobile drawer
(starts closed, chat inert while open, Escape/backdrop close it, focus returns
to the trigger), and the Appearance-density regression (Settings → Appearance
cards keep their natural height and unclipped copy under compact density while
the sidebar footer theme switch shrinks, and the density choice survives a
reload). Every scenario runs against the TypeScript backend
(`packages/harness/dist/cli.js serve`, built from this checkout). Fixture-backed
scenarios drive a scripted OpenAI-compatible model server
(`e2e/fixtures/scripted-server.mjs`) through the real approval broker, and skip
(never fail) when the built CLI is missing. The suite's temp dirs live under
`<repo>/.e2e-tmp/` (gitignored).

### Package real-model E2E (opt-in)

`packages/harness/e2e/` drives the TypeScript package against LM Studio
(`npm run test:e2e` on sources, `npm run test:e2e:dist` on the built
`dist/`). Same models and endpoint as below; reports land in
`packages/harness/e2e/runs/`. An unreachable endpoint prints `E2E SKIP:` and
exits 0, so the suite stays safe on a machine without LM Studio. CI takes
exactly that path on every push: with
`TWO_BROTHERS_E2E_BASE_URL=http://127.0.0.1:9/v1` the live suites skip and
the hermetic server-status/prompt-audit suites still run (see
[CI coverage](#ci-coverage)).

### Browser real-model E2E (opt-in)

The suite also has a `real` scenario that makes genuine model calls. It is
**off by default** — the normal suite stays fully offline:

```powershell
# Git Bash
TWO_BROTHERS_REAL_E2E=1 node e2e/run.mjs

# Windows PowerShell
$env:TWO_BROTHERS_REAL_E2E = '1'; node e2e/run.mjs
```

Requirements: an OpenAI-compatible endpoint serving both models, pointed at
with `TWO_BROTHERS_LM_BASE` — for example a local LM Studio server at
`http://localhost:1234/v1` (the default baked into the suite is
machine-specific; always set the variable for your setup). The models default
to `spark-x2.6-4b@q4_k_m` (senior) and `lfm3-1.7b` (junior) and can be
overridden with `TWO_BROTHERS_E2E_SENIOR_MODEL` and
`TWO_BROTHERS_E2E_JUNIOR_MODEL`; the wall-clock deadline defaults to 10
minutes and is overridden with `TWO_BROTHERS_E2E_DEADLINE_MS`. The suite only
probes the endpoint you give it — it never starts a model server for you, so
with nothing serving it reports `SKIP`.

What it proves, end to end through the real backend and the browser UI:

- per-role provider/model settings (`PUT /api/settings`) drive a run with no
  provider override ("from settings");
- the full consult cycle (senior consult → junior proposal → senior review →
  decision) renders as the same chat groups as the mock scenario;
- the run's SSE stream ends with `run_end status=completed`, and the run
  record carries a numeric `usage` object (`model_calls`, `input_tokens`,
  `output_tokens`, `cached_tokens`);
- total wall time stays under a 10-minute deadline.

Runtime: minutes, not seconds — two real models each answer several times,
so expect roughly 2–5 minutes for the scenario on this machine (the deadline
is 10 minutes). If LM Studio is unreachable or a model is missing, the
scenario reports `SKIP` (never `FAIL`), exactly like a missing fixture.
Without the flag it prints `SKIP real (set TWO_BROTHERS_REAL_E2E=1)`.

## Why spark-x2.6 is not in the CLI

`spark-x2.6` is only reachable through the DSH `xhtoken` provider; it has no
HTTP endpoint, and direct internet access from the sandbox is blocked. The full
cycle on it was run through a `subagent` and captured in
[`SPARK-TRANSCRIPT.md`](../SPARK-TRANSCRIPT.md).

## What is not covered by tests

- Real network errors / timeouts / 429s (only mock HTTP).
- Behavior with very long contexts.
- Concurrent sessions; the web workspace backend is single-user and runs
  cooperate on one FIFO worker (runs queue), so true parallelism is untested.
- Restart recovery: session JSONL, `*.meta.json`, and
  `sessions/runtime/*.events.jsonl` survive a backend restart, but in-memory
  run state (run records, pending approvals) does not.
