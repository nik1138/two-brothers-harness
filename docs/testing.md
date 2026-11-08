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
7. the real-socket fault-injection runner (`node e2e/faults.ts` — loopback
   only, seven retry/timeout/overflow/quota scenarios)
8. the `typescript/` reference selftest
9. the `web/` unit tests (`npm test` — chat, timeline, drafts, palette,
   session-status, recents, density, find, content-search, mentions, provider
   settings and model discovery, queue visibility, session-scope approvals,
   step folding, composer status seats, plan docks, streaming, composer prompt
   recall, the approval-policy model and the design-token layer)
10. the `web/` build

Expected final line: `SMOKE TEST: PASS`. It is an offline pre-flight, not the
whole product gate — run the package gates below for that.

## CI coverage

`.github/workflows/ci.yml` runs on every push and pull request to `main` on
two platforms: an **ubuntu matrix** (Node 22 and 24 — the `engines` floor and
the next supported release) and a **Windows leg** (Node 24 on
`windows-latest` — the platform this project is developed and gated on).
Both legs run the same hermetic gates, in this order:

1. `typescript/`: `node src/selftest.ts`, then `node tests/run-all.ts`
   (no install step: the reference is zero-dependency);
2. `packages/harness`: typecheck, build, `npm test`,
   `npm run test:spawn` (ubuntu only — the same suites run in-process on
   Windows), `node dist/selftest.js`, and the mock CLI run;
3. `packages/harness`: the hermetic CLI E2E — `node e2e/cli.ts` (sources)
   and then `node e2e/cli.ts --dist` (the built CLI);
4. `packages/harness`: the real-socket fault-injection runner
   (`node e2e/faults.ts` — loopback only, seven retry/timeout/overflow/quota
   scenarios over real TCP);
5. ubuntu only — `packages/harness`: `node e2e/run.ts` with
   `TWO_BROTHERS_E2E_BASE_URL=http://127.0.0.1:9/v1`. The closed port makes
   the endpoint probe fail immediately: the runner logs one `E2E SKIP:` line
   (and records a synthetic `connection` SKIP entry), omits the live-model
   suites, then runs the hermetic server-status and prompt-audit suites and
   exits 0;
6. `web/`: `npm ci`, `npm test`, `npm run build`;
7. at the repo root: the browser-E2E packaged-web freshness unit tests
   (`node --test e2e/web-freshness.test.mjs` — plain `node:test`, no deps and
   no browser);
8. ubuntu Node 22 only, after the web build: `node scripts/tarball-smoke.mjs` at
   the repo root and `npm run pack:check` in `packages/harness`. Both trigger
   the package `prepack` (build + `sync-web`), which is why they need
   `web/dist`; the packed artifact is identical on both matrix legs, so the
   heavier release checks run once, on the engines floor.

The Windows leg (`windows-latest`, Node 24) runs the same hermetic gates
(items 1–4 and 6–7) and prepends Git Bash to `PATH` before the suite so the
package's shell-spawning tests resolve it deterministically; it deliberately
skips `test:spawn`, the ubuntu-only server E2E and the Node-22 release
rehearsal, keeping the job bounded. The Windows leg and the shared gate
commands are validated locally on the repository's own platform (Windows);
the ubuntu matrix is validated by CI only — it cannot be executed on this
host.

npm caching covers the root and `web/` lockfiles (`setup-node`); the
reference tree needs none. Network use is limited to npm (`npm ci` and the
tarball smoke's dependency install) — no CI step talks to a live model
endpoint. Browser E2E (Playwright + system Edge) and the live-endpoint /
LM Studio / real-network-load layers are intentionally not in CI; they stay
opt-in and manual (`scripts/e2e-test.ps1`, `npm run test:e2e`,
`npm run test:e2e:load`).

**Docs ↔ CLI drift guard:** `packages/harness/tests/clidocs.test.ts` (part of
`npm test`) keeps `docs/cli-reference.md` in sync with the code-owned CLI
catalogue: two-way env-var coverage against `clihelp.ts::ENVIRONMENT`, the
env→flag mapping, two-way long-flag coverage for the run/chat/tui/serve
accepted flags, and a tolerant command-heading check. It also audits
command-scoped flag tables per command: a `Flag` table under a command heading
(today `### serve`) may document only flags that command accepts, and every
run/chat/tui/serve accepted flag must be documented in the command's own table
or the shared `## Flags` table; failures name the command and both directions
(`serve: documented-but-not-accepted: --workspace; accepted-but-undocumented:
--host`). Parsing ignores fenced code blocks; prose/code-example flag
mentions, the shared table's per-row scope notes, `--help` (covered once
globally) and env rows mapped to `—` (runtime-only) are intentionally outside
the comparison. A missing reference file (bare npm tarball) skips instead of
failing. Run it alone with `node --test tests/clidocs.test.ts`.

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

On the canonical integrated run for this round the in-process suite is
**1 555 tests: 1 553 pass, 0 fail, 2 skipped** (exit 0); the two skips are
environment-gated and never failures — the workspace symlink-parity test and
the MCP stdio spawn are unavailable in this environment. `npm run typecheck`
and `npm run build` pass, the hermetic CLI E2E is 17/17 on sources and 17/17
against `--dist`, the tarball smoke is 7/7 and `pack:check` passes. The
tarball smoke pins its own consumer manifest inside the temp dir, so it also
passes when `TEMP`/`TMP` points inside the checkout (the documented Windows
Vite workaround).

Environment note (Windows): the shell-execution tests spawn the `bash` found on
`PATH`; the documented/verified environment is Git Bash
(`C:\Program Files\Git\bin`). A WSL `bash.exe` earlier on `PATH` can hold the
temp directory handle and make cleanup-only assertions fail — the unchanged
baseline fails the same way, so that is an environment quirk, not a product
failure. The smoke script itself prepends `C:\Program Files\Git\bin` to `PATH`
when Git Bash is installed (and prints which `bash`-capable directory it
chose), so the documented command works without manual PATH edits; the
prerequisite still matters when running the package suites directly.

Coverage: envelope and payload validation (zod), model output parsing,
`sanitize_payload`, the consult/work/revise state machine, byte-stable
transcript markers, session persistence (`--session-file` / `--resume`,
dense `seq`), context compaction, MCP loading and role scoping, the plugin
loader, the HTTP/SSE server and its run-status contract, the
provider error-classification registry, and the workspace tools
(`tests/workspace.test.ts`, 46 tests — 45 pass + 1 environment skip — covering
confinement, robust edits, mutations, diffs, and the shell/delete approval
reasons). Provider presets are covered by
`tests/server.test.ts`: the additive `seed`/`customized` flags, the
non-destructive `POST /api/providers/{name}/reset` (stored override removed;
role refs, settings and plugins intact; 404/400/409 paths), and the unchanged
`DELETE` remove-and-clear-refs behavior. Provider model discovery is covered by
the `tests/server.test.ts` discovery section (+7 hermetic loopback tests — a
local fake endpoint, no real network): the stored/env-backed key used only for
the preset's own URL, the different-URL-with-saved-key 400, a one-shot typed key
that is never stored or echoed, an empty answer that leaves the catalog intact,
the unsupported-wire-kind 400, unknown-provider 404/invalid-body 400 and the
clean upstream 502 (suite now 65 tests). The `allow_session` approval scope is
covered across layers: `tests/approvalbrokerdeny.test.ts` (28 tests — a
seeded pair auto-allows without parking with one event per call, the check
precedes the denial cap, one-shot counters are untouched, an aborted run still
denies), `tests/settings.test.ts` (round-trip, dedupe/isolation, cap, atomic
write, corrupt-section fail-soft, secret-free; 31 tests), and `tests/server.test.ts`
(strict scope validation, persist-before-resolve, restart survival, session
delete clears, auto-allow on a repeated identical request). The CLI text layout
is covered by `tests/clistyle.test.ts` (now 27 tests) and `tests/cli.test.ts`
(now 27) — block separation, the ruled decision, Markdown bodies and their
sanitization, the compact footer's presence rules,
`stripAnsi(colored) === plain`, machine modes escape-free, responsive help
columns, and live TTY streaming: a TTY sink streams each block and prints the
footer once, `--no-live`/a non-TTY sink/machine modes keep the finished render,
colored live output strips back to the plain one, and the layout tests pin that
dropping the `· ` activity rows leaves the finished transcript bytes. The
CLI-ergonomics suites cover the help catalog,
`sessions --json` / `sessions show`, `models` and `onboard`;
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
pickers + skill-attachment validation). The plan/todo function is covered by
`tests/todos.test.ts` (17 tests: tolerant `sanitizeTodos`, summary/result
grammar, the model-facing schema, valid/invalid/empty calls, exactly one
`todo_updated` per write with last-write-wins, the tool joining the junior and
senior belts without enabling a tool-less verify pass, no approval/workspace
side effect, and sidecar replay) and `tests/tuitodo.test.ts` (18 tests: the
docked panel's markers/title, bounded selection and honest `+N more`, empty-plan
omission, width safety at 40/60/80/120 incl. CJK/emoji, NO_COLOR/theme
byte-stability, sidecar replay keyed by the session file name (`x.jsonl` ->
`sessions/runtime/x.jsonl.events.jsonl`), and the frame keeping its size; plus
TUI plan durability — a snapshot round-trip through a real runtime store,
restart/last-wins/clear semantics, exactly one sidecar line per plan write and
nothing else persisted, torn-line tolerance, a fail-soft uncreatable store path,
and the compact sanitized event shape). TUI workspace-bound runs are covered by
`tests/tuiworkspace.test.ts` (20 tests:
`--workspace` startup errors, `@file` mention resolution and refusals, the
workspace-file picker rows/trigger, the approval panel's exact-width rendering
and key handling, `Ctrl+E` preview, the panel replacing the composer, and the
real broker allow/deny/allow-session/abort paths with a bounded diff detail).
TUI provider connection is covered by `tests/tuiproviders.test.ts` (26 tests,
registered in `tests/run-all.ts`): flags/env vs persisted-settings precedence
per pair, `provider_ref` resolution through the stored preset, a dangling ref
warning with manual fallback, corrupt settings failing soft, a session
`/models` choice never being persisted, the `/provider` views carrying only
`api_key_set` (never the key), manual/preset saves writing through the encrypted
store (env-pinned fields stripped, validation/write failures changing nothing),
a real TUI turn using the endpoints persisted by the web Settings/`onboard`
(the root-cause regression), and the failure guidance naming `/provider` while
keeping the provider error visible.
Thinking/response streaming is covered
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
`tests/approvalbrokerdeny.test.ts`. The TUI lanes (`tests/tui*.test.ts`) cover
the editor, the keymap registry, the terminal, the views, prompt history, the
find-in-transcript overlay, span-level Markdown styling, the theme-painted
palette/help overlay rows, the composer's meta-row removal, the mid-block `⋯`
transcript slice marker, the status-bar hint priority and its clipped transient
slot, the rotating footer tips (one registry-derived tip per accepted turn, full
cycle coverage, fold action leading without repeating, the stopped-turn and
approval-parked transient copy; `tests/tuiviewlane.test.ts` 32 tests,
`tests/tuistyle.test.ts` 18 tests, also pinning byte-identical NO_COLOR
output, and the assembled `tests/tuiintegration.test.ts` 19 tests), the
docked plan panel with its durable sidecar writes (`tests/tuitodo.test.ts`,
18 tests) and workspace-bound runs with the approval
panel and `@file` mentions (`tests/tuiworkspace.test.ts`, 20 tests). Other TUI
lanes are unchanged
in size: `tests/tui.test.ts` 37, `tests/tuikeymap.test.ts` 18,
`tests/tuibasecommands.test.ts` 19. The TUI lanes and the doctor,
completions, reliability, search/export, workspace-order and broker-cap suites
are registered in `tests/run-all.ts` (including the new `tuiproviders` suite).

Wave 4 adds five suites and extends six existing ones (all registered in
`tests/run-all.ts`): `tests/toolcalling.test.ts` (10 tests: the senior's
consult opening, the junior's consult proposal and the senior's consult
review each call a read tool before emitting their structured reply; consult
belts never contain the workspace mutations; a tool-less configuration
produces byte-identical requests with no extra calls; the loop is bounded and
still repairs once after exhaustion; cancel mid-round, unknown-tool
recovery); `tests/approvalmodes.test.ts` (19 tests: the per-mode decision
matrix for read/write/delete/shell with and without a broker, `readonly`
denying with no parked approval, `edits` auto-allowing writes while deletes
still park, `ask` parking a write, `allow-all` skipping the broker, workspace
confinement and sensitive-path refusal still running first, and the CLI
flag/env/help/warning/invalid-exit-2 cases; the persisted section's
fail-closed/corrupt round-trip and other-section preservation live in
`tests/settings.test.ts`, while the `GET`/`PUT /api/settings` round-trip with
an invalid mode as 400 and the run path honoring the mode live in
`tests/server.test.ts`); `tests/tuiapprovalmodes.test.ts` (6 tests: the default
dialog states `ask` and offers the four persisted modes, a chosen mode is
written through the settings store, Enter on a freshly opened dialog only
closes it without persisting, a persisted `allow-all` shows its danger
warning, a pinned mode offers only Close, and typed `/permission <mode>`
applies valid modes while refusing unknown ones); `tests/tuirecall.test.ts` (3 tests through
the assembled fake-TTY app: loaded history recall, byte-exact draft
stash/restore, history file never appended by navigation, only accepted
submissions recorded, and the multiline only-at-the-edges rule);
`tests/cliproviderprovenance.test.ts` (10 tests: flag/env/absent provenance,
explicit default-valued `--provider` beating a persisted non-default provider,
absent flag keeping persisted settings, flag > env, the hand-built-Config
heuristic, and the persisted-store load/save paths). The extended suites are
`tests/settings.test.ts` (31), `tests/server.test.ts` (65),
`tests/approvalbrokerdeny.test.ts` (28), `tests/tuiproviders.test.ts` (26,
including the 20/25/29-column frame checks for the provider connect view),
`tests/tuieditor.test.ts` (17) and `tests/tuiintegration.test.ts` (19).
`e2e/web-freshness.test.mjs` covers the browser suite's packaged-web
freshness guard (12 pure tests: fresh, missing, changed, extra and
non-converging trees, the `sync: false` refusal, and the actionable error
copy).

Wave 5 adds the hermetic scale coverage: `tests/load.test.ts` (5 tests, about
1 s total) drives the real seams at scale — 1,500-envelope session
resume/restore with dense seq and no re-append, a 400-block TUI transcript
projection bounded to the exact height/width with in-range paging, a
200-session listing through the in-process `sessions` path with stable
repeats and no filesystem-handle growth, 8 concurrent `RunManager` runs
behind a barrier proving genuine concurrency with no cross-session mixing,
and five repeated compaction rounds that keep exactly one summary while the
rendered transcript stays bounded and non-growing. It asserts bounded
behavior, never wall-clock correctness.

Wave 6 adds `tests/approvalshellcaution.test.ts` (15 tests: the shell-approval
caution fires only after an operator-denied write/edit/delete in the same run,
allow/cancel/session-allow paths never arm it, the base reason stays
byte-identical when nothing was denied, and the pair key, denial cap and
event shape are unchanged) and extends the web composer-key suite by four
tests for the recall key pass-through (inactive arrows fall through to native
caret movement, Up is history-gated, browsing Down still steps/restores).
The package suite is now 1 474 tests (1 472 pass, 2 environment skips) and the
web suite 318.

Wave 7 adds `tests/thinkingpersist.test.ts` (7 tests: the new additive
`reasoning` runtime event is emitted once per streaming provider call, is
sanitized and bounded (`REASONING_EVENT_MAX_CHARS` = 10,000, head+tail), is
persisted to a real run sidecar via `RunManager`, never appears without
streaming, never leaks into envelopes/decisions, and orders correctly across
tool-loop rounds; the web timeline projection tolerates malformed/oversized/
old-backend rows and renders replayed thinking collapsed-by-default) and
extends the web timeline suite by four replay-projection tests. It also adds
the design-token migration invariants: `web/tests/tokens.test.ts` now covers
17 migrated component sheets and bans canonical radius/scale-spacing literals
in them (9 tests). The package suite is now 1 481 tests (1 479 pass, 2
environment skips) and the web suite 323.

Wave 8 adds `tests/tuireasoningreplay.test.ts` (14 tests: read-only sidecar
reasoning extraction/order/role/kind, malformed/torn/oversized tolerance, the
bounded width-safe `THINKING (replayed)` renderer incl. CJK/emoji and
plain/NO_COLOR equality, the screen option's welcome-vs-transcript gate with
byte-identical frames when no replay payload exists, and the assembled TUI on
load/resume at 40/80/120 columns with unchanged sidecar bytes) and the
`TWO_BROTHERS_JSON` contract-alignment tests (`tests/printmode.test.ts` +5:
env/flag byte parity, truthy/falsey spellings, explicit-mode-over-env matrix,
dry-run equality, per-turn chat; `tests/cli.test.ts` +1 spawned-CLI parity
with FORCE_COLOR purity). The final token migration adds `App.vue`,
`ChatView.vue` and `Composer.vue` to `web/tests/tokens.test.ts`, which now
guards 17 migrated sheets. The package suite is now 1 501 tests (1 499 pass, 2
environment skips); the web suite stays 323 and the reference tree 33/33
(its `TWO_BROTHERS_JSON` handling was updated with the same alignment fix).

Wave 9 closes the tooling and reordering backlog: `vue-tsc` moves from the
advisory `~3.0.2` pin to `~3.3.0` (resolved 3.3.14) with a forced
`vue-tsc -b` over all 38 SFCs producing zero template-scope diagnostics, the
web suite green, and only the web-local lockfile subtree changed; the sidebar
gained pointer-only drag-and-drop workspace reordering (pure helpers
`dropReorderDelta`/`dropReorderIds`, +6 `web/tests/workspaceOrder.test.ts`
tests → 21) with the new hermetic browser scenario above. The web suite is now
329 tests; the package suite and reference tree are unchanged (the wave-9
lanes touched web/e2e/docs/tooling only).

Wave 10 adds `tests/thinkingpassback.test.ts` (13 tests: Anthropic
extended-thinking requests are byte-identical when unset and carry
`thinking: {type:"enabled", budget_tokens:n}` (with `temperature` omitted)
when enabled; a scripted two-round SSE tool loop captures signed
`thinking`/`signature` blocks (and `redacted_thinking` payloads) and echoes
them verbatim as the first assistant content blocks of the next request;
non-Anthropic adapters ignore the option and keep byte-identical requests;
budget validation/usage errors; no reasoning text enters the protocol
envelopes) and the new hermetic browser scenario above. It also closes the
wave-7/8 replay-coverage gap with `reasoning-replay` (fixture streams real
`delta.reasoning_content` SSE chunks; the sidecar holds four bounded
`reasoning` records, a plain session holds none; after reload the collapsed
`Thinking · replayed` rows expand to sanitized plain text with the injected
HTML-looking payload escaped, the over-long record shows the clipping marker
and stays bounded, and the console guard is clean). The browser suite is now
16 offline scenarios + the opt-in `real` skip. The package suite is now
1 514 tests (1 512 pass, 2 environment skips); web stays 329 and the
reference tree 33/33 (the wave-10 lanes touched the package core + e2e
fixtures/docs only).

Wave 11 hardens the gates and closes the last reliability-coverage item: CI
now also runs the real-socket fault-injection runner and the packaged-web
freshness unit tests on both Node matrix legs (browser E2E and
live/real-network layers stay opt-in/manual); the `thinkingpassback` suite
grew from 13 to 17 tests (a `<redacted_thinking>` block is asserted to be
echoed verbatim on the next tool-loop request, and mixed per-role wire kinds
prove only the Anthropic role's body carries `thinking` while the other
role's raw request bytes stay identical). The opt-in manual real-network load
runner `packages/harness/e2e/load.ts` (`npm run test:e2e:load`) was added and
recorded against the owner's LM Studio endpoint (concurrency 2 / runs 3:
3/3 PASS, 78.7–93.7 s per run, 157.6 s wall) — it is never part of
`npm test`, the smoke gate or CI. Package suite: **1 518 tests
(1 516 pass, 2 environment skips)**; web/reference unchanged.

### Real-socket fault injection (in the smoke gate)

`cd packages/harness && npm run test:e2e:faults` (`node e2e/faults.ts`) is a
fully offline, deterministic runner that starts a scripted `node:http` server
on a loopback ephemeral port and drives the real retry/timeout/overflow paths
over actual TCP (`fetch`) — no fetch stubs and no external network. Seven
scenarios assert attempt counts and classification: 429 + `Retry-After` then
success; transient 500/503 then success; a 400 ms per-attempt timeout then
success with the documented warning; context-overflow fail-fast
(`ProviderContextOverflowError`, one attempt); a real compact-and-retry
recovery over a seeded ~92 KB session (the cycle completes, one summary
survives, the JSONL restores with dense `seq`); an always-overflow server
bounded to 3 requests then the documented error; and fatal quota/billing
(`provider-limit`, zero waits). It is bounded (10 s per-scenario watchdog,
<30 s total, typically ~0.3 s — backoff waits are compressed through the
provider's injectable sleeper seam), prints PASS/FAIL per scenario, exits 1 on
failure, and writes evidence to the gitignored `e2e/runs/`. The full offline
smoke gate runs it, and `docs/design-review.md` §9 distinguishes this loopback
fault layer from real external-network behaviour.

### Real-network load (opt-in, manual)

`cd packages/harness && npm run test:e2e:load` (`node e2e/load.ts`) is an
opt-in load runner for an operator-provided OpenAI-compatible endpoint. It
requires `--base-url` and `--model` (with `TWO_BROTHERS_E2E_BASE_URL` /
`TWO_BROTHERS_E2E_MODEL` fallbacks), supports `--concurrency` (≤16, default 3),
`--runs` (≤100, default = concurrency), `--mode consult|work`, `--timeout`,
`--retries` and `--task`, and spawns that many real `dist/cli.js run`
subprocesses through a bounded-concurrency pool against the endpoint (a build
is required; it warns and falls back to `src/cli.ts` if `dist/` is missing).
It prints PASS/FAIL per run with wall times, then an honest summary (observed
max concurrency, successes/failures + exit codes, latency min/median/max,
total wall); exit 0 iff every run exits 0, 1 otherwise, 2 on misuse; children
are killed on SIGINT/SIGTERM and stragglers are swept on exit. It sends real
model calls and is **never** run by `npm test`, the smoke gate or CI — the
hermetic counterpart for fault behaviour is `e2e/faults.ts` above. Recorded
run against the owner's LM Studio (`lfm3-1.7b`, 2026-11-08): concurrency 2 /
runs 3 → 3/3 PASS, 78.7–93.7 s per run, 157.6 s wall.

### serve-level load/soak (opt-in, manual)

`cd packages/harness && npm run test:e2e:serve-load`
(`node e2e/serve-load.ts`) starts the real `serve` backend (hermetic `--mock`
mode, or real `--base-url`/`--model` with env fallbacks; a build is required
and the script warns before falling back to `src/cli.ts`), registers a
temporary workspace through `POST /api/workspaces`, creates one session per
run (the protocol serializes same-session runs, so `--workers > 1` only
parallelizes across sessions), submits bounded-concurrency runs and polls
`GET /api/runs`; transitions are cross-checked against the persisted runtime
sidecars (`run_status`/`run_end`) so fast states cannot be missed by polling.
It prints per-run PASS/FAIL with `queued → running → completed` and
queue/run/submit timings, then an honest summary (observed max in-flight
POSTs, observed peak queue/running, persisted-sequence count,
successes/terminal states, queue/exec/submit latency min/median/max, total
wall — measured only), exits 0 iff every run completed (1 failure, 2 misuse),
stops the server child on SIGINT/SIGTERM and normal exit, and removes temp
dirs unless `--keep`. Arguments: `--runs` (default 3, max 50), `--workers`
(default 1, passed to `serve`), `--concurrency` (default = runs), `--port`
(default 8631, fail-fast if busy), `--timeout`, `--retries`, `--task`,
`--keep`. It needs a reachable endpoint unless `--mock` and is **never** run
by `npm test`, the smoke gate or CI. Recorded evidence (2026-11-08): mock
self-test `--runs 3 --workers 1` → 3/3 completed (0.3–2.8 s depending on
machine load; submit latency was load-dependent and is not the queueing
proof — the persisted sidecar sequence is); owner LM Studio `lfm3-1.7b`,
`--runs 2 --workers 1` → 2/2 completed in 230.8 s, run 2 queued 117.7 s
behind run 1 (228.3 s / 7 calls vs 112.9 s / 8 calls), peak queued/running 1.
Long soaks remain an operator choice; a WAN/real-provider fault gate is still
deliberately manual. Wave 12 adds only this opt-in runner (plus an
evidence-only naive-ui investigation that kept the stacked-dialog guard — see
`docs/backlog.md`); the package suite count is unchanged (1 518 tests:
1 516 pass, 2 environment skips) and web/reference are untouched.

Wave 13 adds operator-selectable web **accent themes** (Blue default plus
Violet/Teal/Amber; light and both dark scheme blocks override only the
accent/focus/selected tokens, role identity colours stay stable; the choice
is persisted in the versioned `uiPrefs` blob and applied as `data-accent`,
with the browser scenario listed below) and a **Windows CI leg** (Node 24) alongside
the ubuntu matrix, plus `tests/clidocs.test.ts` (6 tests, part of
`npm test`) guarding the docs↔CLI flag/env contract described under
[CI coverage](#ci-coverage). Package suite: **1 524 tests (1 522 pass,
2 environment skips)**; web suite 336 (tokens 12, uiPrefs 9; the token suite
pins the 94-token inventory and the accent-text WCAG-AA contrast floor);
browser suite
17 offline scenarios + the opt-in `real` skip; reference tree unchanged at
33/33. The wave-13 slice covered the token-consuming chrome; wave 14 threads
the accent into naive-ui's primary overrides so native primary controls follow
it too (below), while non-primary intents stay static.

Wave 14 closes that limitation and strengthens the documentation guard:
`web/src/theme.ts` gains a pure `accentThemeOverrides(accent, scheme)` table
(blue/violet/teal/amber × light/dark, the naive-ui primary family mapped to
the same hexes as the CSS `--accent*` tokens) and `App.vue` merges it into
`NConfigProvider` reactively, so native naive-ui primary controls (buttons,
switches, input focus borders) follow the operator accent in light and dark
and update on an accent or theme switch without a reload. A drift test parses
`tokens.css` and fails if the JS mapping and CSS tokens diverge (tokens suite
13 tests; foreign hexes are rejected); the `appearance-accent` scenario now
also polls the native Settings primary button's computed background through
Blue → Violet (light) → Violet (dark) → Blue. In the package, `clidocs.test.ts`
grew to 8 tests with the per-command flag audit described above. Package
suite: **1 526 tests (1 524 pass, 2 environment skips)**; web suite 337
(tokens 13, uiPrefs 9); browser suite 17 offline scenarios + the opt-in `real`
skip; reference tree unchanged at 33/33.

Wave 15 closes the remaining contrast gaps with test-enforced WCAG AA floors
(value-only changes): accent-coloured text now clears 4.5:1 on every surface it
is actually used on in both schemes (panel/canvas, hovered and selected rows,
and the soft accent chips; the light soft/selected tints were lightened
imperceptibly to move blue 4.42→4.58, amber 4.49→4.57 and the base highlight
4.497→4.59, while violet/teal and the light hover surfaces already passed), and
**white text on native naive-ui primary, hover and pressed states clears AA
for all four accents in both schemes** (the token test computes the floors and
fails with the pair and ratio; hover/pressed must stay distinct from primary).
To make dark native hover AA-compliant without changing the light look, the
dark accent hover now *deepens* instead of lightening for blue/violet/teal
(white 3.80→5.61, 4.23→6.38, 4.02→5.22; amber already passed at 5.02), with
the CSS `--accent-hover` tokens and the naive palette changed in tandem so the
drift test stays green; amber keeps its lighter hover. The token suite (14
tests) documents the surfaces that host accent text and excludes
`--surface-active` deliberately (no such rule today; it would need adding if
one is introduced). Web suite 338 (tokens 14, uiPrefs 9); package suite and
browser scenarios unchanged this wave.

Wave 16 ships the first slice of **configurable key bindings** (web): the
three modifier global chords — command palette (default Ctrl/⌘+K), find in
the conversation (default Ctrl/⌘+F) and the shortcut reference (default
Ctrl/⌘+/, with plain `?` kept as a fixed alias) — are rebindable per device
through Settings → Keyboard. A pure module (`web/src/keybindings.ts`) owns the
binding model (one platform "Mod"), validation (Mod plus one printable key;
duplicate chords, Alt combos, plain keys and documented browser-reserved
chords refused), a versioned bounded fail-soft store
(`two-brothers.keybindings.v1`), event parsing/matching (either Ctrl or Meta
matches "Mod"; labels follow the detected platform) and label rendering;
App.vue/ChatView/Settings/`/help` share one reactive keybindings ref, so a
rebind applies immediately and the help overlay renders the current chords
(rebindable entries badged, fixed keys noted). Settings → Keyboard uses a
window-capture key handler with `role=status` announcements, inline
`role=alert` conflicts, per-row/global reset, and Escape cancels a capture
without closing the dialog. All other shortcuts stay fixed. Web suite 350
(keybindings 13 new); browser suite 18 offline scenarios. The remaining
key-binding surfaces (composer/picker/fixed keys, TUI rebinding) stay open in
`docs/backlog.md`.

Waves 17–19 were release-readiness work plus the TUI half of that epic. Wave 17
ran three independent read-only audits (docs consistency, hygiene/security,
live re-validation on HEAD; no P1), fixed the tarball smoke for a repo-local
`TEMP`, widened the publish gate (CLI E2E + faults + web tests) and added a
tag↔version guard. Wave 18 added the one-command
`scripts/release-rehearsal.ps1` (7 timed fail-soft steps: clean tree → build +
`npm run check` → smoke → tarball smoke → `pack:check` → browser E2E →
clean-tree check; PASS/FAIL + timings, `-SkipBrowser`/`-SkipTarball` for fast
iterations; validated full **PASS (7/7)**), with publish dry-run evidence on
HEAD. Wave 19 made the three global TUI chords — command palette, shortcut
reference and draft stash — rebindable from a versioned JSON file via
`tui --keys-file <path>` / `TWO_BROTHERS_TUI_KEYS_FILE` (default
`~/.two-brothers/tui-keys.json`; startup-only, never persisted): a pure
resolver (`src/tui/keyoverrides.ts`) validates the allowlist, chord grammar,
reserved/typing/duplicate/fixed-conflict rules fail-softly (one `[tui keys]`
diagnostic and defaults) and threads the resolved command table through
matching, palette/help listings, status hints and `tui --help`
(`tests/tuikeys.test.ts` 25 + 2 `tuiintegration` cases). Wave 20 closed the
TUI-key residuals and converged the docs: `help tui` now resolves the same
env/default keys file as `tui --help` (identical effective key rows; one
stdout note points at `tui --help --keys-file` for a flag-selected file; an
invalid file prints one `[tui keys]` diagnostic and falls back to defaults),
and the printable-rebound-help typing rule has integration coverage (opens
help on an empty composer, types into a non-empty draft). Package suite:
**1 555 tests (1 553 pass, 2 environment skips)**; web suite 350 and browser
18 offline scenarios are unchanged.

Hermetic offline CLI E2E: `npm run test:e2e:cli` (sources) /
`npm run test:e2e:cli:dist` (built `dist/cli.js`) drive the CLI as a
subprocess against the mock provider — **17 scenarios**: consult, chat-repl,
help, work, session+resume, mcp, serve, doctor (`--json`), completions
(`bash`), config (`--json`, masked keys), dry-run (plan text/JSON, no session
file), stdin (`run -`), sessions-json, sessions-show, sessions-search
(human and `--json`, short-query exit 2), sessions-export (Markdown
stdout, `--output` file, missing session exit 1) and style (FORCE_COLOR/
NO_COLOR paint matrix, `stripAnsi` byte-identity, machine modes escape-free,
palette pinning). Both runners pass all 17 scenarios (`node e2e/cli.ts` and
`--dist`). The human consult scenario's anchors follow the text
layout — separated envelope blocks, the `── decision ──` rule, the compact
`tokens … in / … out · … calls` footer and no `tokens:` line on stdout — and
piped output is compared under `--live` and `--no-live` (both must be
byte-identical to the un-flagged run on stdout and stderr, with no activity
rows and zero escape bytes), while the machine-mode scenarios stay
byte-identical. The canonical gate also diffed the piped human output against a
pristine `957d11b` worktree (identical for consult and work), with
`--mode print`/`--dry-run` byte-identical and `--json` identical apart from
random envelope ids. CI runs both (see [CI coverage](#ci-coverage)).

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
`tests/keybindings.test.ts`,
`tests/providerSettings.test.ts`, `tests/uiPrefs.test.ts`,
`tests/queueState.test.ts`, `tests/approvalSession.test.ts`,
`tests/folding.test.ts`, `tests/composerStatus.test.ts`,
`tests/todo.test.ts`, `tests/recall.test.ts`,
`tests/approvalPolicy.test.ts`, `tests/tokens.test.ts`) covers the
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
tracking, role usage badges, delete/reset eligibility and impact copy, reset
response merge, add-form validation, keyboard arithmetic) plus model discovery
(only OpenAI-compatible kinds are probeable, the monotonic stale-token guard,
ready/empty/error/unsupported states including the old-backend 404, tolerant
model-id parsing, and the explicit Add-to-draft merge — 29 tests), the
queue-visibility projection (`tests/queueState.test.ts`, 19 tests: FIFO order
and 1-based positions from the newest-first backend list, per-session grouping,
bounded rows and the honest hidden count, single-line task previews, optimistic
insert/remove, and no dock for an old backend without active records), the
approval answer/scope helpers and the additive approval preview
(`tests/approvalSession.test.ts`, 19 tests: the applied-scope echo, the honest
one-shot fallback notice for an older backend, scope resolution never inferring
session scope, `approvalDetailOf`/`approvalPreviewOf` keeping and bounding the
additive detail, the runtime projection carrying it (old backends keep no
field), plain-text-only preview content (HTML-looking text round-trips verbatim,
no HTML built), and the request reason retained on the resolved card), step
folding
(`tests/folding.test.ts`, 16 tests: stable ids, which rows fold (completed-run
tool/audit only, never conversation or the followed run), single-row and
`minRows` behavior, hidden-audit/docked-approval handling, expansion order and
offset-aware keys, honest pluralized summaries), composer status seats
(`tests/composerStatus.test.ts`, 10 tests: no-data means no seat, models gated on
loaded settings, the permission seat naming the effective approval mode per
workspace context (and the fail-closed `ask` fallback), exact audit
char/tool counts, defensive formatting, ordering and `formatCharCount`
bounds), the plan projection (`tests/todo.test.ts`, 11 tests: last
`todo_updated` wins, empty list is a real clear, malformed/oversized snapshots
are tolerated, bounded selection with truthful hidden counts, summary counts,
and no plan leaking across sessions), the speaker labels (the
operator reads "You"), the persisted conversation preferences + transcript
visibility filter (prompt audits are opt-in), the composer prompt-history
recall (`tests/recall.test.ts`, 7 tests: the versioned bounded store with
consecutive dedupe, the fail-soft read of corrupt/wrong-version/blocked
storage, record-only-on-acceptance, the newest-first browsing state machine
with byte-exact draft stash/restore, and the caret/IME/repeat/modifier-safe
key classifier), the Settings → Approvals model
(`tests/approvalPolicy.test.ts`, 12 tests: the honest copy per mode, the
`allow-all` danger warning, strict mode normalization, the fail-soft
`GET /api/settings` section (old backend = unsupported + Ask), the save
patch omitted for an unsupported backend and for a server-pinned mode (a
pin is never persisted by a normal save), and the pinned/unsupported
read-only reasons), the keybinding store/model (`tests/keybindings.test.ts`,
13 tests: defaults and canonical chords, validation (Mod required, printable
key, Alt/duplicate/reserved refusal with the complete documented reserved set
pinned by a table-driven test), the versioned bounded fail-soft store and its
repair rules, event parsing/matching with Ctrl/Cmd equivalence, conflict-aware
rebinds, platform labels, and the dynamic `/help` entries), and the
design-token layer (`tests/tokens.test.ts`, 14
tests: every `var(--x)` reference in `style.css` and the 17 migrated component
sheets is defined, every core colour token exists in the light block and both
dark blocks — which must stay identical —, the spacing scale is complete and
ordered, no colour literal is left in the migrated sheets, canonical
radius/scale-spacing literals are banned there too, `theme.ts`
stays mapped to the colour tokens, the 94-token inventory is pinned, the
accent variants and their light/dark parity are checked, and the accent-text
WCAG-AA floors plus the computed naive-ui primary-family contrast floors fail
with the exact pair and ratio); 350/350 web tests. The modules are
dependency-free at runtime, so plain `node --test` runs them
via the `tests/register-ts.mjs` bootstrap (a tiny resolve hook for the
extensionless imports); `npm test` wires that up. The full `web/` gate also
includes `npm run build` (see the smoke test above).

## TypeScript reference (`typescript/`)

Zero-dependency; documents the `PROTOCOL.md` contract and is not modified by
feature work.

```powershell
cd typescript
node src/selftest.ts
node tests/run-all.ts
```

`node --test tests/` also works where spawning child processes is allowed
(in sandboxes it can fail with `EPERM` — use `run-all.ts` there). On the
canonical run the reference selftest passes and `node tests/run-all.ts` is
**33/33**.

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

The backend serves the packaged `packages/harness/web` copy before the repo's
`web/dist`, so a stale packaged copy could shadow a fresh build. The runner
now guards this itself: before any scenario it compares the two trees by
relative-path set and file content and, when they differ, re-runs the
publisher's copy from `web/dist` (the same `cpSync` as `npm run sync-web`,
building nothing) and logs `packaged web: resynced … (N files; reasons)`;
a missing `web/dist` fails with the exact build command. The comparison is
the pure `compareWebTrees` in `e2e/web-freshness.mjs`, covered by
`e2e/web-freshness.test.mjs` (12 tests) — offline and deterministic.
`scripts/e2e-test.ps1` runs those freshness tests before the browser
scenarios, so a guard regression fails the E2E gate too (the browser run is
the last step).
The guard mirrors an existing build; it never rebuilds `web/`, so rebuild
after a web change before a browser run.
`npm run sync-web` (from `packages/harness`) remains the command for
refreshing the copy that ships in the npm tarball.

Scenarios, in suite order: `chat` (group-chat run with the mock provider —
distinct role bubbles, no raw-protocol leakage), `resume` (reload/continue),
`approval-allow` and `approval-deny` (approval card → file on disk →
changed-file diff, allow and deny paths), `stop`, `mobile` (the 390 px drawer
starts closed, chat inert while open, Escape/backdrop close it, focus returns to
the trigger), `appearance-density` (Settings → Appearance cards keep their
natural height and unclipped copy under compact density while the sidebar footer
theme switch shrinks, and the density choice survives a reload),
`provider-reset`, `folding` (completed-run tool rows fold into an
`aria-expanded` disclosure, the followed run stays open, expand/collapse in
place, per-session reset), `plan-dock` (Plan dock counts/markers/bounded
`+N more` expand and the polite announcements, including "Plan cleared."),
`composer-seats` (role models plus the prompt-audit context seat, with no token
wording), `hero-starters` (landing and empty-session hero; starters prefill only
an empty composer, a preserved draft wins with a notice) and `approval-reason`
(a delete approval shows the documented reason on the pending card; its
collapsed-by-default preview toggle exposes the bounded diff as plain text —
`aria-expanded`/`aria-controls`, `+N -M` counts, literal HTML in the removed
line stays escaped text and runs no handler — collapses again, the resolved
history card keeps the same reason verbatim and drops the pending-only
preview, Allow removes the file, no raw markers), plus `composer-recall`
(after two accepted submissions, Up/Down recall walks them newest-first in the
real textarea, the pre-recall draft is restored byte-exactly, multiline recall
fires only at the absolute edges, an inactive ArrowDown falls through to the
native caret-to-end movement, nothing submits during navigation, and the
history survives a page reload), plus `workspace-drag` (three API-created
workspaces render as sidebar groups; dragging one group onto another header
via its grip handle shows the insert indicator and source dimming, reorders
the sidebar optimistically, persists the new order through
`PUT /api/workspaces/order`, clears the indicators, leaves session
selection/filtering and header collapse untouched, hides the handles while
filtering, and the group menu Move up/Move down fallback still reorders and
And another wave-10 browser addition: `reasoning-replay` (a fixture-backed
streaming run whose scripted server emits `delta.reasoning_content`; the
session sidecar must hold bounded `reasoning` runtime events and a plain
session must hold none; after a page reload the collapsed
`Thinking · replayed` rows match the sidecar, expanding shows escaped plain
text — an injected `<img onerror=…>` payload stays text and runs no handler —
the over-long record keeps its head+tail plus the clipping marker and stays
bounded, and switching to the plain session shows no replay rows), plus
`appearance-accent` (Settings → Appearance's native Accent radio group:
a keyboard-only move to Violet flips the root `data-accent` attribute and the
computed `--accent`/`--accent-text` tokens in light and after switching to
dark (the dark accent text clears WCAG AA 4.5:1 against the panel surface), a
native naive-ui primary control (the Settings primary action) follows the
accent in light and dark and returns to the base blue after restoring it, the
choice survives a reload, restoring Blue returns the base palette, and the
theme/density cards keep their count and measurements), plus `keybindings`
(Settings → Keyboard rebinds the three modifier global chords: capture
Control+Shift+P for the command palette via real key events, the row and the
header chip update and the choice is persisted in the versioned
`two-brothers.keybindings.v1` document; a conflicting binding is rejected with
an inline `role=alert` message and is not saved; Escape cancels capture
without closing Settings; the rebound chord opens the palette while the old
Ctrl+K no longer does; `?` still opens `/help`, whose palette row shows the
custom chord and a rebindable badge while Esc/Esc stays fixed; after a reload
the custom chord is live and the old one dead; Reset all restores Ctrl+K and
the defaults and the custom chord stops working; console guard clean).
On the canonical run that is
**18 PASS, 0 FAIL, 1 SKIP** (the opt-in `real` scenario). The queue dock and the session-scope approval decisions
remain covered by the web unit suites, not by separate browser scenarios. The
default suite is fully offline; the
opt-in `real` scenario (below) reports `SKIP` unless an endpoint is configured.
For iteration, `TWO_BROTHERS_E2E_ONLY=<substring>` runs only scenario blocks
whose label contains the substring.
Every scenario runs against the TypeScript backend
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

- Real network errors / timeouts / 429s are driven over real loopback TCP by
  the fault-injection runner (`packages/harness/e2e/faults.ts`, part of the
  smoke gate), and real endpoints are exercised only by the opt-in manual
  runners (`e2e/load.ts`, `e2e/serve-load.ts`); WAN latency/load and
  real-provider fault injection stay deliberate manual coverage.
- Production-scale long contexts: the compaction stress suite covers
  cut/serialization and the token-mode budgets, but a wall-clock benchmark on
  true production-size contexts is not in the gates.
- Full parallelism: the web backend is single-user and runs cooperate on one
  FIFO worker (runs queue); the hermetic load suite covers eight concurrent
  queued runs, and the opt-in `serve-load.ts` measures the real pool but is
  not a gate.
- Restart recovery: session JSONL, `*.meta.json`, and
  `sessions/runtime/*.events.jsonl` survive a backend restart, but in-memory
  run state (run records, pending approvals) does not.
