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
   session-status, recents, density, find, content-search, mentions, provider
   settings and model discovery, queue visibility, session-scope approvals,
   step folding, composer status seats, plan docks, streaming, composer prompt
   recall, the approval-policy model and the design-token layer)
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

On the canonical integrated run for this round the in-process suite is
**1 459 tests: 1 457 pass, 0 fail, 2 skipped** (exit 0); the two skips are
environment-gated and never failures — the workspace symlink-parity test and
the MCP stdio spawn are unavailable in this environment. `npm run typecheck`
and `npm run build` pass, the hermetic CLI E2E is 17/17 on sources and 17/17
against `--dist`, the tarball smoke is 7/7 and `pack:check` passes.

Environment note (Windows): the shell-execution tests spawn the `bash` found on
`PATH`; the documented/verified environment is Git Bash
(`C:\Program Files\Git\bin`). A WSL `bash.exe` earlier on `PATH` can hold the
temp directory handle and make cleanup-only assertions fail — the unchanged
baseline fails the same way, so that is an environment quirk, not a product
failure.

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
(now 26) — block separation, the ruled decision, Markdown bodies and their
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
read-only reasons), and the design-token layer (`tests/tokens.test.ts`, 7
tests: every `var(--x)` reference in `style.css` and the migrated components
is defined, every core colour token exists in the light block and both dark
blocks — which must stay identical —, the spacing scale is complete and
ordered, no colour literal is left in the migrated sheets, and `theme.ts`
stays mapped to the colour tokens); 313/313 web tests. The modules are
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
fires only at the absolute edges, nothing submits during navigation, and the
history survives a page reload). On the canonical run that is
**14 PASS, 0 FAIL, 1 SKIP** (the opt-in `real` scenario). The queue dock and the session-scope approval decisions
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

- Real network errors / timeouts / 429s (only mock HTTP).
- Behavior with very long contexts.
- Concurrent sessions; the web workspace backend is single-user and runs
  cooperate on one FIFO worker (runs queue), so true parallelism is untested.
- Restart recovery: session JSONL, `*.meta.json`, and
  `sessions/runtime/*.events.jsonl` survive a backend restart, but in-memory
  run state (run records, pending approvals) does not.
