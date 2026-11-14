# Two Brothers — handoff

Local working handoff. Gitignored; not project documentation. The frozen
historical snapshot is `docs/history/handoff.md`; this file is the current
state for the next session.

Last updated: **2026-11-14**. **Validated checkpoint: `3fe647f`** — every
gate count in this file was recorded there (`test(e2e): integrate web build
fail fast handling`, the last code commit of the quality wave). Validation
happened at that commit; local `main` has since moved on with **docs-only
follow-ups** — `30056eb`, `c52554a` (only `todo.md` checkpoint records) —
plus this handoff once merged. **Nothing is pushed, tagged, or published**;
`origin/main` is still `7f0d2c4` (O1, CI #98 green) and local `main` is
**111 commits ahead**. Since the 2026-11-13 O1 handoff, the O2/M/C
observation-parity slices, the whole improvement-lane wave (cooperation
correctness, LLM hardening, web fixes, bounded MCP/run history, plugin
bundles + strict parity, E2E cleanup and skip-registry), and the full
code-quality wave (chat/composer, TUI, settings, workspace/CLI/subagent
resource bounds, MCP init bound, backend steering/SSE/mutex safety, E2E
fail-fast) were integrated and validated. Every reviewed audit finding is
now **integrated or explicitly deferred** (structural/hypothesis deferrals
with technical reasons: `todo.md`). A cleanup incident on 2026-11-14
(**known cause: an NTFS junction
traversal**) emptied `packages/harness` in the main checkout; tracked files
were restored and deps/dist rebuilt, but untracked `packages/harness/sessions`
content — sessions, settings incl. sealed keys, runtime sidecars/subagent
logs — was **permanently lost**. See **Incident (2026-11-14)** below. The
live server was **rebuilt and restarted on 2026-11-14** (verified by the
server lane on `c52554a`): PID 247580 runs
`node dist/cli.js serve --port 8600 --sessions-dir sessions`, serving the
current `web/dist` byte-identically; `GET /` and `GET /api/sessions` (empty
`[]`) return 200, and a full process scan shows no stray/test backends.
Provider keys are still missing (owner task, below).

## Repository at a glance

- **`packages/harness/`** — the implementation and npm package
  (`@two-brothers/harness`). All product work lands here.
- **`web/`** — Vue 3 + Vite workspace served by the TypeScript server.
- **`typescript/`** — zero-dependency reference implementation of
  `PROTOCOL.md`; not touched by feature work.
- **`PROTOCOL.md`**, **`shared/protocol.schema.json`**,
  **`shared/prompts.json`** — the protocol contract. Keep the byte-stable
  markers and the two copies in sync.
- **`e2e/`** — Playwright browser suite (system Edge, hermetic).
- **`docs/`** — user/developer documentation. `docs/history/` is frozen.
- `research/` is local-only/gitignored.

## Current state

| Item | Value |
|---|---|
| Branch | `main` — **local-only / unpushed** |
| HEAD | local **`c52554a`** (docs-only `todo.md` checkpoint records + this handoff); origin/main **`7f0d2c4`** (O1, CI #98 green); local-only, **111 commits ahead** |
| Validated checkpoint | **`3fe647f`** — all gate counts below were recorded there; the follow-ups touched `todo.md` only |
| Docs follow-ups | `30056eb` → `c52554a` (only `todo.md`); earlier wave docs: `668536a` → `987f316` → `ba1e0e4` (`docs/release.md` / `docs/testing.md`) |
| Previous | `3f07d316` — strict plugin parity; `f946238` — O2 merge; `1cc25d4` — slice M; `02c0ad9` — slice C; `7f0d2c4` — O1 |
| CI | runs #90–#98 success (latest pushed `7f0d2c4`); everything past it unpushed — no CI yet |
| Package suite (Windows) | **2 483 / 2 475 pass / 0 fail / 8 platform skips** — `npm test` AND `test:spawn` |
| Package suite (WSL) | Node 22.22.2 + Node 24.16.0: **2 483 / 2 482 pass / 0 fail / 1 env skip**, both modes on each, + typecheck PASS + hermetic server E2E 4/4 (see caveats below) |
| Web suite | **642/642** + `npm run build` PASS |
| CLI E2E | **19/19 source + 19/19 `--dist`** |
| Smoke gate | **PASS** — incl. fault-injection 7/7 and hermetic server E2E 4/4 |
| Hermetic server E2E | **4/4** (also inside the smoke gate and the WSL pass) |
| Browser E2E | **39 hermetic PASS / 0 FAIL / 1 opt-in `real` SKIP** + helpers suite **20/20** |
| Tarball | **7/7 + pack check PASS** |
| Live server | **running** — PID 247580 `node dist/cli.js serve --port 8600 --sessions-dir sessions` (graceful restart of PID 226508); `GET /` 200, `GET /api/sessions` 200 `[]`; served HTML/JS/CSS byte-identical to fresh `web/dist`; process scan clean (only zen-proxy + this server); sessions/settings untouched; **provider keys still to be re-entered by the owner** |
| Release | no version bump, tag, or publish in this wave; 0.0.1 is the published version |

Live setup (verified on the running server, 2026-11-14):

- Senior: `opencode-go / deepseek-v4.1-flash`
- Junior: LM Studio `lfm3-1.7b` (`http://192.168.31.123:1234/v1`)
- Subagent route: **empty** (helpers keep the tool's Senior/Junior `role`
  fallback). Set it in Settings → Models & roles → Subagent if you want a
  pinned helper model.
- **Settings were lost in the 2026-11-14 incident** — the sealed provider
  API keys must still be re-entered (owner task) before any live run; no
  live sessions or helper transcripts survive. Sessions/settings were
  untouched by the restart.

### Final checkpoint — integrated lanes (2026-11-14)

The lanes below were integrated and **validated at `3f07d316`** (the
strict-plugin-parity checkpoint that preceded the quality wave). A second
wave — the code-quality audits and their fixes — was integrated afterwards
and is validated at the current checkpoint **`3fe647f`** (see the next
subsection). Local `main` has since added only `todo.md` docs records
(`30056eb`, `c52554a`) and this handoff — no code or test changes past the
validated checkpoint. Themes with landmark commits (implementation → integration):

- **Observation parity COMPLETE:** O2 TUI helper controls (`f963707`),
  M per-call model/effort overrides (`1cc25d4`), C helper usage/cache/cost
  roll-up as a separate helpers aggregate (`02c0ad9`). **F (forked-context)
  and D (depth > 1) remain DEFERRED** to their own designs — no new designs
  started.
- **Cooperation-core correctness:** C1–C3 + C5 (`3be613c`), TUI
  helper-overlay correctness D1–D5 (`281f6a1`), server session-concurrency
  reservations for sync runs and delete (`abc274e`), secretbox DPAPI
  payloads via PowerShell stdin, never argv (`0679d0f`).
- **LLM/provider hardening:** bounded transport reads + hardened Anthropic
  replay (`facb6bf` → `cd45f65`), provider response edges — OpenAI
  `content:null`, Gemini `blockReason` (`9b6b211`), central `--timeout` /
  `--retries` validation (`6b65876`).
- **Web fixes:** four async-lifecycle races in App.vue (`5a8aee0`),
  user-message navigator (`a850b54`), transcript scroll stability
  (`0a33154` → `970e804`), reduced-motion approval reveal (`f9468f6` →
  `aa1cc87`), preset base-URL sync (`846b911` → `e2cfa56`).
- **Bounded resources:** MCP client shutdown bounded for serve/CLI/TUI
  (`26146ec`/`04ba28e` → `fcb7377`), terminal run history bounded
  (`fafce48` → `9702476`).
- **Plugins:** tool-name grammar + deterministic cross-plugin collision
  resolution (`fe74921`), 60s cooperative tool-handler deadline (`029659c`),
  declarative command/skill bundles (`975e42e` → `27a2fd6`), strict opt-in
  plugin selection parity across run/chat/tui (`dd54392` → `3f07d31`).
- **E2E / infra:** backend process cleanup after browser scenarios
  (`76639e9` → `b631530`), registry-derived missing-backend SKIP reporting
  (`8224234` → `d248e8d`), release-rehearsal / smoke TEMP scoping
  (`0ad26fa`, `e3b894e`), TUI test session-lock isolation (`7321559`),
  writer-lock artifact cleanup (`cc1d791`), transcript-evidence removal
  (`67fb3e0`), README rewrite (`c04f1e9`, `bbb6dca`).

### Final checkpoint — code-quality wave (2026-11-14)

Four read-only audits (TUI, web chat/composer, web settings/navigation,
backend/runtime) plus a remaining-core audit (CLI, workspace edit-diff,
settings-write, config, subagent runner, runstream, instructions, MCP)
produced a risk-ranked queue. **Every reviewed finding is now integrated or
explicitly deferred**; the deferrals (hypotheses BE-F6b/CHAT-F4/SET-H1/SET-H2/
TUI-H1–H4, design questions BE-F5, structural candidates TUI-R1–R5/R7,
CHAT-R1–R4, SET-S1/S2/S4/S5, BE-R1–R5) carry technical reasons in `todo.md`.
Merge commits (implementation → integration), all validated at `3fe647f`:

- **`17867f9`** chat/composer + transcript-find correctness (CHAT-F1–F3)
- **`1eef5fe`** TUI compaction guard + linear-time block ids (TUI-B1/B2)
- **`7f28044`** TUI helper-fold decomposition slice R6 (accepted structural slice)
- **`99a108b`** settings/sidebar state correctness (SET-C1–C6)
- **`d0b851b`** web `fsPath.ts` extraction + tests (accepted structural slice S3)
- **`e1b6eeb`** steering-drain preservation, SSE backpressure, session-mutex
  cleanup, Google `maxTokens` (BE-F1/F2/F3/F6a)
- **`67ccba1`** bounded workspace large-file reads/diffs (CORE-F1/F2)
- **`3009748`** bounded MCP initialization/tool discovery (CORE-F3)
- **`52fbfa5`** bounded session listing + clipped child tool results (CORE-F4/F5)
- **`3fe647f`** browser E2E fail-fast on web-build failure (E2E-G1)

Verification caveats (environment, not product failures — see `todo.md` for
detail): WSL Node 22 on `/mnt/c` `npm test` exited 1 *after all assertions
passed* on a post-test HTTP-socket `TypeError`; the standalone file ran
48/48 and an identical full suite on a native ext4 checkout ran
2 483/2 482/0 fail/1 skip exit 0, pinning the caveat to `/mnt/c`. WSL Node
24 initial runs on `/mnt/c` hit a bounded TUI timing flake
(`tuiintegration:1460`); bounded reruns passed.

### Incident (2026-11-14): main-checkout `packages/harness` emptied

- **Cause (known):** an earlier cleanup traversed an **NTFS junction** and
  emptied `C:\code\two-brothers-harness\packages\harness` — both tracked and
  untracked files. The cause is identified — a cleanup tool followed the
  junction — not an unexplained failure.
- **Recovery (tracked):** all tracked files restored from git; `npm install`
  reinstalled dependencies and `npm run build` rebuilt `dist/`; the full
  offline gates were re-run green (counts above).
- **Permanent loss (untracked):** everything under
  `packages/harness/sessions/` — session JSONL files, `settings.json`
  including **sealed provider API keys**, runtime event sidecars, and
  `subagents/` child logs. These local-only files have no backup.
- **Consequences:** no live sessions/history survive; provider keys must be
  re-entered in Settings. The serve writer lock and the live :8600 server
  were lost in the incident but have since been **rebuilt and restarted**
  (verified 2026-11-14 — see Current state); sessions/settings were
  untouched by the restart.
- **Prevention:** never point recursive cleanup/delete tools at the repo
  root, worktree parents, or any path that can contain NTFS junctions; keep
  destructive commands inside one known directory.

## CI fix wave (2026-11-12, landed on main)

The ubuntu CI red (runs 80–89) was **not** the subagent wave: `c6e41b4`
(2026-11-10, wave 29) added the additive `usage` runtime event after every
node, so the SSE tail became `decision → usage → run_end` and
`e2e/server-prompt-audit.ts`'s fixed two-frame replay assertion failed.
It failed on Windows too — it only looked Linux-only because neither the
Windows CI leg nor the smoke gate ran `node e2e/run.ts`.

- `71e2aa1` — replay assertion anchored on the actual decision frame; the
  whole persisted tail must replay verbatim (future additive events safe).
- `7085095` — pre-existing wave-23 `tuikeys` watcher-test flake: seed the
  `fs.watchFile` stat baseline before the first mutation (Node-22 spawn).
- `809de6c` — smoke gate now runs the hermetic server E2E (closed-port
  override `TWO_BROTHERS_E2E_BASE_URL=http://127.0.0.1:9/v1`, env scoped and
  restored) + matching docs. The detection gap is closed.

Acceptance: WSL Node 24.16.0 + 22.22.2 — typecheck, `npm test` and
`test:spawn` each 2 120 / 2 119 pass / 0 fail / 1 env skip, `e2e/run.ts`
4 hermetic suites PASS + endpoint SKIP. Windows — `npm test` 2 120 / 2 113 /
0 fail / 7 env skips; full smoke gate **PASS** (11 stages, web 518/518),
independently re-run by the lead on the merged tree. Windows esbuild quirk:
run gates with TEMP/TMP inside the checkout (`.tmp/build-temp`), not the
user-profile Temp (documented in docs/testing.md).

## Recently shipped (this wave)

### 1. Read-only helper subagents (`7cdcdce`)

- Senior-only `subagent` tool. A child is one isolated single-role helper,
  not a second Junior and not a protocol peer.
- Fresh provider instance per child, so child usage/cache stays out of the
  parent footer.
- Read-only belt only: `workspace_read_file`, `workspace_list_dir`,
  `workspace_search_text`, plus `spill_read` when configured. No writes,
  shell, recursion, or follow-ups.
- Bounded: 4 000-char task, 6 child steps, 8 children per run, 12 000-char
  report. Child failures return honest JSON tool errors.
- Durable child transcript:
  `<sessions-dir>/subagents/<id>.jsonl` (meta / message / tool / end rows,
  torn-tail tolerant). Not a session; never appears in `/api/sessions`,
  search, export, or the sidebar.
- Parent runtime stream: `subagent_started`, `subagent_activity`,
  `subagent_completed` (persisted in the parent run sidecar).
- Web: `Subagents · N` header chip, live tree with status/activity/elapsed/
  tokens, read-only child drawer; parent composer is `inert` while open;
  `Esc` / **← Parent** closes.
- Routes: `GET /api/sessions/{name}/subagents`,
  `GET /api/subagents/{id}`. Parent session deletion removes child logs.
- Files: `src/subagent.ts`, `src/harness.ts`, `src/runevents.ts`,
  `src/server.ts`, `src/sessionlayout.ts`, `web/src/subagents.ts`,
  `web/src/components/SubagentView.vue`, `web/src/App.vue`,
  `web/src/api.ts`, `web/src/types.ts`.
- Tests: `tests/subagent.test.ts`, `web/tests/subagents.test.ts`, server
  routes/delete, `subagents` browser scenario.

### 2. Dedicated subagent model route in Settings (`32fc970`)

- Settings → **Models & roles** has a third **Subagent** card:
  connection/preset, model, base URL, API key, model-declared effort.
- Persisted as the top-level `subagent` section of `sessions/settings.json`;
  the key is sealed at rest like role keys.
- `GET/PUT /api/settings` carry `subagent` additively.
- A configured route **wins over the tool's `role` argument**. An empty route
  keeps the Senior/Junior fallback.
- Deleting a provider clears a matching helper `provider_ref`; role and
  provider saves preserve the section.
- Backend pieces: `SettingsStore.readSubagent` / optional fourth `write`
  argument, `RuntimeSettings.publicSubagent` / `updateSubagent`,
  `resolveSubagentEndpoint` in `src/runtime.ts`, server GET/PUT wiring,
  `SubagentSettings.endpoint` in `src/subagent.ts`.
- Web pieces: `web/src/components/SettingsDialog.vue`,
  `settings/ModelsRolesSection.vue`, `settings/RoleEditor.vue`,
  `web/src/api.ts`, `web/src/types.ts`.
- Tests: `tests/settings.test.ts`, `tests/runtime.test.ts`,
  `tests/subagent.test.ts`, `tests/server.test.ts`,
  `web/tests/settingsSubagent.test.ts`, and the `settings-subagent` browser
  scenario.

### 3. Subagent phase 2, slice 1 — mutating helpers (`d1518a9` + `c445eee`)

- A workspace-bound child gets the seven built-ins (3 reads + write/edit/
  delete/shell) + `spill_read`; role-independent belt; no recursion/todo/
  plugin/MCP tools.
- `PermissionManager.childView` snapshots the run policy at spawn (both
  fields) and tags every parked request onto the parent run's
  `RunApprovalBroker` (`subagent_id`/`subagent_label`, additive). Fixed
  scope: later settings changes cannot widen a live child; no broker →
  fail-closed DENY; `readonly` denies without a card.
- Shared session-allow pairs + denial cap with the parent run; stop →
  `denyAll` cancels parked child waits; child log gains append-only
  `approval` rows (pending/allowed/denied/cancelled), torn-tail tolerant.
- Child writes ride the parent run's undo recorder via a shared
  `WorkspaceCaptureSeam` (one net entry per file per run; shell excluded,
  same as the parent's shell).
- Web: helper row + one-sentence note on the approval card, "waiting for
  approval" in the tree, approval rows in the drawer; all "read-only"
  helper copy flipped (incl. Models & roles intro).
- Protocol/schema/prompts.json/typescript UNCHANGED; no new deps.
- Evidence: three independent conformance reviews + independent acceptance
  (WSL Node 22/24, Windows smoke, CLI E2E source+dist 19 PASS, full browser
  matrix 27 PASS). Design + owner decisions + errata:
  `.tmp/research/subagent-phase2-design.md`.
- Deliberate boundaries left: follow-ups/interrupt/`list_agents`, async
  wake, TUI tree, forked context, depth > 1, per-call overrides, cost
  roll-up. Child shell is a real shell in the workspace (operator-approved,
  not undo-captured).

### 4. Real `auto` + Senior solo decision (`bd5c6d7` + `dcd9f0a`)

- `auto` = model-declared routing: one plain Senior `route` pre-decision
  ({route: solo|consult|work, reason}); strict→relaxed→ONE repair→
  fail-closed consult + ONE warning (exit 0); provider failure fails the run.
- Guardrails: G1 work→consult downgrade without a bound workspace (recorded
  in marker/event/warning); G2 solo always honored (structurally read-only);
  G3 one route per run, no rounds consumed; G4 precedence unchanged.
- Solo = `senior_route → senior_solo → END`: task envelope, `[[AUTO ROUTE]]`
  marked message (compaction/steer convention), senior→user decision —
  already legal per PROTOCOL.md §5. ZERO protocol/schema/prompts changes;
  `route` kind is code-only (payloads.ts), mock frozen (mock auto =
  fail-closed consult + warning by design).
- Solo call: read-only consult belt (helpers kept) + code-only honesty
  directive before the reply-format block. Explicit consult/work runs never
  route — byte-identical, pinned by pre-change modebytes goldens.
- Surfaces: `auto_route` runtime event; RunRecord route/route_reason
  (sidecar-rebuild safe); CLI --json auto_route; /mode auto in chat/TUI/web/
  base commands; truthful Composer copy; neutral web activity row; rewind
  excludes the marker (backend + web mirror).
- `dcd9f0a` also fixes two PRE-EXISTING browser-matrix races (proven on base
  c445eee): createSession() returned before the session switch rendered →
  wrong-session sends (reasoning-replay) and stale fold counts (folding).
  Now waits for the rendered switch marker; assertions unchanged; 5
  consecutive full matrices green.
- Evidence: implementer gates + lead review + independent acceptance (WSL
  Node 22/24, smoke, CLI E2E 19+19, feature scenarios 10/10). Design +
  owner decisions: `.tmp/research/auto-solo-design.md`.

### 5. Subagent controls slice A1 — child interrupt (`27800c4`)

- Per-child `AbortController` composed via `AbortSignal.any([parentSignal,
  childSignal])`; **only the parent signal unwinds the parent run** — an
  interrupt cancels one child and the parent's next step runs (R1).
- Parked child approvals are withdrawable: optional `ApprovalRequest.signal`
  (internal-only, never persisted/emitted) → broker resolves DENY
  `reason:"interrupted"` exactly once with `subagent_id`; run-signal/denyAll
  precedence preserved; both listeners removed after settle (R2).
- `POST /api/subagents/{id}/interrupt`: child-id keyed, idempotent
  (`interrupting` / `already_finished`), honest 404s; live registry via
  `SubagentControlSink` (register on spawn, release on every settle path).
- `SubagentStore.reconcileOrphans()` at serve startup after the writer lock:
  one `cancelled`/`cancelled_by:"restart"` end row per header-only log;
  200-file bound, idempotent, torn-tail terminated, per-file fail-soft.
- Web: drawer-only **Stop helper** button + old-backend 404 notice; R11 fix
  (cancellation-class reasons no longer replace the card's request reason).
- Additive `cancelled_by` (operator/senior/parent_run/restart) only on
  cancelled children; sync golden proves a completed child gains no key.
- Evidence: implementer gates + lead review + independent acceptance (WSL
  Node 22/24, smoke, CLI E2E 19+19, full browser matrix 29 PASS, no flakes).
  Design: `.tmp/research/subagent-controls-design.md` (A1→A2→B, B GO).

### 6. Subagent controls slice A2 — operator follow-ups (`30a7015`–`0725545`)

- Per-child follow-up queue: 8 pending × 4 000 chars, 8 applied per child,
  80 000-char context estimate; delivery at step ≥ 1 as ONE joined user turn
  (R5 wire legality); fail-soft drain; every settle path counts dropped.
- `POST /api/subagents/{id}/messages`: queued-only (200 `queued`), exact
  400/404/409; settled children → 409 `helper already finished`.
- Additive `origin` rows + `end.followups {delivered, dropped}`; a
  follow-up-free child keeps the old shape (sync golden).
- Web: drawer follow-up composer; Escape draft guard clears the double-Esc
  stop timer (safety fix); `subagent-followups` browser scenario.
- Evidence: implementer gates + lead review + independent acceptance (WSL
  Node 22/24 2 252/0 fail, smoke exit 0, CLI E2E 19, full browser matrix
  30 PASS + 1 real SKIP). Design: `.tmp/research/subagent-controls-design.md`.

### 7. Subagent controls slice B — background children + model tools (`ce1d2db`–`1079917`)

- Opt-in `subagent({background:true})`: returns `{status:"started"}` before the
  child settles; the parent continues; the report is only readable through
  `subagent_report` (poll-only, no wake/envelope). Sync default byte-identical
  (golden-sync fixture gates A1+A2+B together).
- Four Senior-only model tools — `list_agents`, `send_message`, `interrupt_agent`,
  `subagent_report` — gated on `HarnessOptions.subagents` (run/chat/tui prompts
  unchanged); never on a child or the Junior. 40-call/run control budget;
  maxActive 4.
- Run-end cancellation in `run()`'s finally: abort still-running background
  children, bounded 2s settle grace (`SUBAGENT_SHUTDOWN_GRACE_MS`), single-emit
  `terminalEmitted` guard emits `cancelled_by:"parent_run"` before `run_end`.
  **Fix `1079917`: the grace timer stays ref'd + clearTimeout in try/finally** —
  an unref'd timer emptied Node 22's event loop (stuck-child test), red CI.
- Additive `background` on meta/SubagentInfo/subagent_started (omitted for sync);
  drawer Background badge (tolerant, hidden for sync/old backend).
- Evidence: implementer gates + lead review + independent acceptance (WSL Node
  22/24 2 264/0 fail, smoke exit 0, CLI E2E 19, full browser matrix 30 PASS + 1
  real SKIP). Design: `.tmp/research/subagent-controls-design.md`.

### 8. models.dev catalog browse/import (`32f327d`–`e51c54f`)

- One shared `ModelsDevCatalog` (alias `ModelEffortCatalog`) owns the models.dev
  document: compact per-fetch index, wire-family inference (incl. the OpenCode Go
  per-family split), 1h TTL + 60s back-off + 10s timeout + single-flight +
  stale-on-error + curated seed fallback. No whole-catalog shipping, no runtime
  dependency on models.dev.
- Two read-only routes `GET /api/models-dev/providers[/{id}]` (≤400 providers /
  ≤300 models; 400 bad id / 404 catalog-provider-not-found / 503
  catalog-unavailable). No settings write, no credentials on the fetch, catalog
  strings clipped + text-only.
- "Browse models.dev…" dialog (Providers section) prefills the existing Add-provider
  form (+ one new Advanced context-window field); saving still via POST /api/providers.
  Default model selection NONE + explicit Select-all (§15.6); zero-selection refused.
- Additive `catalog_id` persisted on presets so `/api/model-efforts` keeps resolving
  after a rename (§15.5); single-source id grammar `PROVIDER_CATALOG_ID_RE`.
- **Fix `e51c54f`: the catalog timeout TEST mock holds a ref'd keep-alive** cleared on
  abort — an abort-signal-only promise let Node 22's runner cancel it (the product's
  `AbortSignal.timeout` timer is unref'd). Same Node-22 class as the slice-B reap fix.
- Evidence: implementer gates + lead review + independent acceptance (WSL Node 22/24
  2 291/0 fail/0 cancelled, smoke exit 0, CLI E2E 19, browser matrix 30 PASS + 1 real
  SKIP). Live route verified: source=network, 236 providers. Design:
  `.tmp/research/models-dev-catalog-design.md`.

### 9. Subagent observation parity O1 — TUI helper observation (`7f0d2c4`)

- The TUI now spawns its own helpers in-process (sets `HarnessOptions.subagents`
  for TUI turns only; `run`/`chat` byte-identical — the harness gate comment was
  corrected). Helpers overlay **Ctrl+Y / `/agents`** (list ↔ child transcript),
  live status-bar/side-panel count, helper identity on the approval panel,
  startup orphan sweep, and TUI subagent route resolution (mirrors serve).
- New pure `src/tui/view/helpers.ts`; **no new timer** (reuses the unref'd 120ms
  spinner). Children never join the brothers' transcript (parent session
  byte-unchanged after a delegating turn, integration-proven); depth stays 1;
  child belt excludes the control tools. Child approvals fold via `broker.attach`
  (serve backend unchanged). Ctrl+Y is now a fixed helper chord (rebinding
  fixtures moved to Ctrl+L, no weakening).
- Evidence: implementer gates + lead review + independent acceptance (WSL Node
  22/24 2 325/0 fail/0 cancelled, smoke exit 0, CLI E2E 19, browser matrix 30 PASS
  + 1 real SKIP). Design + next-agent note: `.tmp/research/subagent-observation-design.md`
  (§14) and `.tmp/research/NEXT-AGENT-OBSERVATION.md`.
- **Owner wind-down: O1 is the last slice started this session.** O2 (TUI
  controls), M (per-call model/effort), C (helper usage/cost roll-up) remain NOT
  started; forked-context (F) and depth>1 (D) are deferred to their own designs.

### Earlier context (still current)

- Model-declared reasoning effort (`969c48c`): models.dev
  `reasoning_options`, `GET /api/model-efforts`, composer/Settings effort
  selects. Default sends no control.
- OpenCode `x-opencode-session` / client headers fix (`1a0bc7a`).
- Keyless provider filtering and the composer model switch.
- The combined Senior+Junior cache percentage is already in the footer;
  helper usage is intentionally separate in the subagent tree/drawer.

## Subagent architecture notes for the next session

- `HarnessOptions.subagents` is set by `serve`/web, and by the **TUI for TUI
  turns only**; `run`/`chat` do not expose the tool.
- `TwoBrothersHarness.runSubagentTool` resolves the child:
  configured `settings.endpoint` → `providerFromEndpoint` (preset/manual
  route, fresh instance); otherwise the role's endpoint/shared config.
- The child gets `SUBAGENT_SYSTEM_PROMPT` + assembled tool sections. It
  never sees the parent transcript.
- `SubagentStore` is append-only JSONL; `get` ignores torn/bad lines. Keep
  the id validation (`sub-` + hex) and the path-basename parent link.
- Runtime event / web types are additive; keep old consumers ignoring them.
- The default child is **synchronous**: the parent tool call waits for the
  bounded report. Opt-in `subagent({background:true})` (slice B) returns
  immediately; the report is read via `subagent_report` (poll-only, no
  wake/envelope).
- Boundaries that are deliberate, not bugs: no forked-context children (F)
  and no depth > 1 (D) — **both deferred** to their own designs. Shipped
  since the phase-2 notes were written: mutating helpers with child-tagged
  approvals, follow-ups/interrupt (A1/A2), background children + model tools
  (B), TUI helper observation/controls (O1/O2), per-call model/effort
  overrides (M), helpers usage/cost roll-up (C).

## Commands / verification

Use Windows PowerShell (not `pwsh`; it is not installed):

```powershell
cd C:\code\two-brothers-harness

# package
cd packages/harness
npm run typecheck
npm test
npm run build

# web
cd ..\..\web
npm test
npm run build

# packaged web copy (server serves this)
cd ..\packages\harness
npm run sync-web

# offline gate
cd ..\..
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/smoke-test.ps1

# browser matrix
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/e2e-test.ps1

# one scenario
$env:TWO_BROTHERS_E2E_ONLY='settings-subagent'; node e2e/run.mjs
```

Temp files used during gates go under
`C:\code\two-brothers-harness\.tmp\build-temp` via `$env:TEMP`/`$env:TMP`.

### Stale-serve lock gotcha

If package/TUI tests fail with:

```
[error] the sessions directory is in use by serve (pid N)
```

a leftover `serve` process owns `packages/harness/sessions`. Stop it, remove
`packages/harness/sessions/.writer.json` if the pid is gone, and rerun the
gate. Do not run the live server and the smoke gate at the same time.

## Constraints / owner decisions

- The brothers are peers with one shared context. Subagents are a separate
  helper tier below the protocol peers — never second protocol peers.
- Keep `PROTOCOL.md` and its byte-stable markers unchanged for this feature.
- No publish, tag, or version bump without explicit owner permission.
- Pushing `main` is approved.
- Before a release: independent E2E lanes (browser, CLI source + dist,
  tarball clean-install, WSL Linux) and the release rehearsal.
- Model effort levels are model-declared, never a fixed product enum.
- API keys are write-only to the client and sealed at rest.
- No new runtime dependencies without a ledger entry in
  `docs/history/ts-rewrite-plan.md`.
- `web/` must keep building; `typescript/` stays zero-dependency.

## Next moves

1. **Re-enter provider API keys (owner, before any live run)** — the
   server itself is **restored and verified running** (PID 247580 on
   :8600, current `web/dist` served byte-identically, empty sessions API —
   see Current state); what remains of the 2026-11-14 incident loss is the
   sealed provider keys and any check sessions. Re-enter keys in Settings,
   then re-create check sessions.
2. **0.0.2 release engineering** — only with explicit permission: push the
   current `main` (whatever its tip is at release time; local-only, 111
   commits ahead of `origin/main`), watch CI, bump version, curated
   changelog, release docs, rehearsal + independent E2E lanes (browser
   matrix, CLI source + `--dist`, packed-tarball clean install, WSL). The
   final gate evidence for the current tree is already recorded above
   (validated at `3fe647f`).
3. **OAuth-only subscription sign-in** — large; API-key plans only today.
4. **Per-turn cache statistics / Senior+Junior split** — small additive
   prompt-audit/usage field; the combined footer percentage already works.
5. **Deferred, designs pending (do NOT start without a go-ahead):**
   forked-context children (F), depth > 1 (D). Quality-wave structural
   candidates (TUI-R1–R5/R7, CHAT-R1–R4, SET-S1/S2/S4/S5, BE-R1–R5) and
   unconfirmed hypotheses (CHAT-F4, SET-H1/H2, TUI-H1–H4, BE-F5/BE-F6b)
   stay deferred with technical reasons in `todo.md` — revisit only with a
   concrete correctness/performance payoff or a reproduced symptom.
6. Minor/blocked: TUI keybinding editor, stacked-dialog mask click
   (upstream naive-ui), WAN/long-soak (manual).

## Handoff checklist

- [ ] Read `AGENTS.md`, `docs/backlog.md`, this file, and `todo.md`.
- [ ] Confirm `git status` is clean and `git log -1` is the expected commit.
- [ ] Stop the live server before running the smoke gate; remove a stale
      `.writer.json` only when its pid is gone.
- [ ] Run package + web tests and `scripts/smoke-test.ps1`.
- [ ] Run the full browser matrix (or a focused scenario via
      `TWO_BROTHERS_E2E_ONLY`).
- [ ] Rebuild + `sync-web` + restart `serve` before handing back.
- [ ] Keep local-only files (`research/`, sessions, credentials, logs) out
      of git. *(Owner decision 2026-11-14: `HANDOFF.md` + `todo.md`
      themselves are committed as the final-checkpoint record on
      `docs-final-handoff` — this one exception only.)*
- [ ] No publish/tag/version bump without explicit owner permission.
