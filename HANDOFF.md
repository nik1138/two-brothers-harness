# Two Brothers — handoff

Local working handoff, tracked as the checkpoint record (owner decision
2026-11-14). The frozen historical snapshot is `docs/history/handoff.md`;
this file is the current state for the next session. The 2026-11-14 record
is superseded by this refresh — its full detail stays in git history;
release mechanics and evidence live in `docs/release.md`.

Last updated: **2026-11-19**. **Checkpoint: `main` = `9c354f3`** — clean,
pushed, in sync with `origin/main` (0 ahead).

## Current state

| Item | Value |
|---|---|
| Branch / HEAD | `main` = `9c354f3` = `origin/main` (docs(readme): bare tui in quick start) |
| Published | **0.0.2 on `latest` AND `next`**; tag `v0.0.2` at `354df89` (pushed). Published 2026-11-18 via the trusted-publishing workflow (`publish.yml`, gate + publish to `next`), promoted to `latest` after the soak check. Global install verified: `two-brothers --version` → `0.0.2`, mock run exit 0, `serve` 200s |
| CI | the publish workflow ran the full release gate at `v0.0.2` (typecheck, build, `npm test` + `test:spawn`, hermetic CLI E2E, real-socket fault injection, web tests + build, selftest, `pack:check`, tag↔version check) — PASS; exact per-suite counts are in the GitHub Actions run log. Only docs commits landed after the tag |
| Package suite baseline (current main) | **2 611 total / 2 603 pass / 0 fail / 8 POSIX-only skips**, Windows, both `npm test` and `test:spawn` (reported by the TUI mode lane; owner acceptance re-verifying on the feature branch, expected 2 614 / 2 606 / 0 / 8 = baseline + exactly 3 new tests) |
| Historical full matrix | last locally recorded independent matrix at `9f353c4` (pre-release waves): package 2 488/2 480/0/8, web 668/668, browser 41 PASS / 1 opt-in real SKIP, CLI 19+19, smoke PASS — superseded by the release gate above |
| Live server | **running** — rebuilt (`npm run build` + `sync-web` byte-identical) and restarted 2026-11-19: `node dist/cli.js serve --port 8600 --sessions-dir sessions` (PID 18028). Verified: `GET /` 200, `GET /api/sessions` 200 with the owner's live sessions, `GET /api/mcp` 200 |
| Provider keys | **re-entered by the owner** (the 2026-11-14 incident loss is closed): live Google/Gemini and LM Studio runs happened 2026-11-17/18; the Gemini `additionalProperties` 400 they surfaced was fixed (`3a48129`) |
| In flight | `feat/tui-tab-mode` @ `dbfac78` — Tab/Shift+Tab mode cycling; owner-run acceptance in progress (below) |

## Shipped since the 2026-11-14 handoff (`92af62a` → `9c354f3`)

Landmark commits by theme (implementation → merge where separate):

- **Test reliability + consolidation:** `400767f` subagent model-freshness
  tests order-independent and wire-level (fixed the CI `junior-a`/`junior-b`
  failure); `1746f6f` override-helper consolidation; `6d6c553` MCP test
  consolidation + real coverage gaps; `971f921` folder `AGENTS.md` guidance
  refresh after three drift audits.
- **Cooperation prompts:** `34432de` senior/junior system prompts grounded in
  the original task and run evidence.
- **Provider workflow UX:** searchable role-model pickers with custom models
  (`db0c9b9`, `31e2d3a`); Add-card live discovery via a name-agnostic draft
  route (`eea05de`, `54cf01d`, `2933998`); **live Google/Gemini model
  discovery** `GET {base}/v1beta/models` with `x-goog-api-key` header and
  bounded pagination (`305e96e`); models.dev model-level base-URL fallback +
  prominent needs-URL notice for custom-endpoint entries (`e95f4d8`,
  `14a594b`); Latin-only help aliases (`1b86897`); Add card closes after save
  (`ad3b04c`); provider add-card/catalog browser scenarios (`235d780`) +
  provider-reset adaptation (`ca1c121`); smoke cleanup null-path and PS 5.1
  NRE guards (`fc60cfb`, `971fc8e`); packaged-web freshness re-verified
  before every browser scenario (`236b220`).
- **Gemini hotfix:** `3a48129` `geminiSafeSchema` key-whitelist strips
  unsupported JSON-schema keywords from tool declarations (fixed the live
  `additionalProperties` 400). Whitelist-widening follow-up recorded in
  `docs/backlog.md` (lane queued, below).
- **Plugins:** per-plugin options + scope reporting API and web editors
  (`524a2e6`, `1a3406e`); deja-vu memory MCP example plugin (`f957bc4`).
- **MCP visibility:** `GET /api/mcp` configured + last-run status (`26c357b`);
  web settings/status surfaces (`6972fca`); TUI footer chip + sidepanel
  (`8274659`); CLI `mcp list` incl. machine-clean `--json` (`f3a67a1`,
  `dc9d1ed`); `/mcp` docs (`d450de4`); MCP browser scenario (`00c2a9a`).
- **Skills:** instance-local `<sessionsDir>/skills` scan (`c21297f`).
- **Structured operator questions (`ask_user`):** harness tool via the
  approval broker (`927dcb4`); web question card (`80cf9b9`); TUI approval
  panel question mode (`7ac16bf`) + turn-broker wiring fix (`0530440`);
  server answer-body superset test (`e3c25e9`).
- **Compaction guarantees:** `36e827a` pins atomic cuts (never split a tool
  call) and min-of-roles context-window guarantees on the token-mode
  (`contextWindow`) compaction path.
- **Release 0.0.2 + README:** bump `354df89`; release records `2cd487b`,
  `eb2a840`; README simplified to install → serve/run/tui (`a42d20e`,
  `8494462`, `9c354f3`).

## In flight

### `feat/tui-tab-mode` @ `dbfac78` (from `9c354f3`, 7 files, +137/−3)

Tab on an **empty** TUI composer cycles the next turn's cooperation mode
`consult → work → auto` (Shift+Tab backwards); with text typed, Tab keeps
its slash-completion meaning (handler returns `false`, falls through to the
editor). Pure `cycleCooperationMode` + `COOPERATION_MODE_ORDER` in
`basecommands.ts`; registry entry `mode-cycle` sits before `complete`;
mode applies next turn, nothing persisted (same semantics as `/mode`).
Files: `src/tui/{keymap,basecommands,app}.ts`, `docs/keyboard.md`, tests in
`tuikeymap`/`tuibasecommands`/`tuiintegration` (+3 tests).

**Acceptance status (2026-11-19):** the independent subagent lane
(agent-319) was lost to machine sleep; its worktree
`.tmp/wt-accept-tui-mode` existed but was empty (no deps, no logs). All
subagent lanes are currently blocked by a subscription access error on the
subagent model route (below), so acceptance is **owner-run** by the
orchestrator — independent of the implementer (agent-318), which AGENTS.md
permits ("or by the owner"). Diff review: **DONE, no concerns** (dispatch
order, fall-through, scope isolation for mention/overlay/find/approval,
docs accuracy all traced). Gate matrix running in the acceptance worktree
(logs: `.tmp/wt-accept-tui-mode/packages/harness/.gate-logs/`): deps,
typecheck, focused TUI suites, full `npm test` + `test:spawn`, build +
selftest, CLI E2E source + `--dist`. On GO: `--ff-only` merge into main,
merged-tree gates, push, remove lane worktrees/branch.

### Queued lanes (blocked on subagent route access)

Spawned 2026-11-19, all failed in ~2 s with: *"Your current subscription
does not have access to Kimi Code right now"* — an account/quota condition
on the subagent model route, not a code failure. Resume when access
recovers (conversation context is preserved):

- **agent-319** — TUI mode acceptance (superseded by the owner-run gates if
  they finish first).
- **agent-320** — `feat/usage-by-role`: per-turn Senior/Junior usage + cache
  split (backlog item; additive fields only; stop-and-report if already
  exposed end-to-end).
- **agent-321** — `fix/gemini-schema-whitelist`: widen `geminiSafeSchema`
  with `anyOf`/`pattern`/`minLength`/`maxLength`/`minimum`/`maximum`
  (pure key-whitelist, no reshaping; backlog non-blocker).
- **agent-322** — read-only test-suite meaningfulness audit (remaining
  duplication/low-value tests after the MCP + override consolidations).

## Incident (2026-11-14) — prevention note (kept)

An NTFS-junction-traversing cleanup emptied main-checkout
`packages/harness`; tracked files were restored, but untracked
`sessions/` content (sessions, settings incl. sealed keys, sidecars, child
logs) was permanently lost. Keys have since been re-entered and live runs
resumed. **Never point recursive cleanup/delete tools at the repo root,
worktree parents, or any path that can contain NTFS junctions; keep
destructive commands inside one known directory.**

## Commands / verification

Use Windows PowerShell (not `pwsh`; it is not installed):

```powershell
cd C:\code\two-brothers-harness

# package
cd packages/harness
npm run typecheck
npm test                     # and: npm run test:spawn
npm run build

# web
cd ..\..\web
npm test
npm run build

# packaged web copy (server serves this)
cd ..\packages\harness
npm run sync-web

# offline gate / browser matrix / rehearsal
cd ..\..
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/smoke-test.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/e2e-test.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/release-rehearsal.ps1

# one browser scenario
$env:TWO_BROTHERS_E2E_ONLY='settings-subagent'; node e2e/run.mjs
```

Web-build gates on Windows need `TEMP`/`TMP` inside the checkout
(`.tmp/build-temp`) — the smoke/rehearsal scripts scope this themselves.
Do not run the live server and the smoke gate against the same sessions
dir at the same time (writer lock); lane worktrees have their own.

## Constraints / owner decisions

- The brothers are peers with one shared context; subagents are a helper
  tier below them, never protocol peers.
- `PROTOCOL.md` byte-stable markers unchanged; runtime events/web types
  stay additive.
- **Pushing `main` is approved** (settled pattern: merge verified work,
  then push). **No tag, publish, or version bump without fresh explicit
  owner words.** 0.0.2 is fully shipped; the next release repeats
  `docs/release.md`.
- No new runtime dependencies without a ledger entry in
  `docs/history/ts-rewrite-plan.md`; `web/` keeps building; `typescript/`
  stays zero-dependency.
- Conventional Commits for all lane work.
- Independent acceptance before merge (separate lane or owner — never the
  implementer alone).

## Next moves

1. **Finish the TUI tab-mode acceptance** (gates running) → ff-merge →
   merged-tree package gates → push → remove `.tmp/wt-tui-mode` +
   `.tmp/wt-accept-tui-mode` and `feat/tui-tab-mode`.
2. **Resume the queued lanes** (agent-320/321/322) when subagent route
   access recovers; otherwise run them owner-inline in the same worktree
   pattern.
3. **GitHub Release page for `v0.0.2`** — owner manual step (no `gh` CLI on
   this machine; the notes body was prepared in session). The npm side is
   complete.
4. Backlog after that: OAuth subscription sign-in, TUI keybinding editor,
   per-role cache split (if the lane hasn't shipped it), deferred F/D
   designs — see `todo.md` and `docs/backlog.md`.

## Handoff checklist

- [ ] Read `AGENTS.md`, `docs/backlog.md`, this file, and `todo.md`.
- [ ] Confirm `git status` clean and `git log -1` is the expected commit.
- [ ] Check the background-task panel for running gates/lanes before
      starting new ones (stale-serve writer-lock gotcha above).
- [ ] Run package + web tests and the smoke gate on the merged tree.
- [ ] Rebuild + `sync-web` + restart `serve` before handing back.
- [ ] Keep `research/`, sessions, credentials, logs out of git (this file
      and `todo.md` are the tracked checkpoint exception).
- [ ] No publish/tag/version bump without explicit owner permission.