# Two Brothers — handoff

Local working handoff, tracked as the checkpoint record (owner decision
2026-11-14). The frozen historical snapshot is `docs/history/handoff.md`;
this file is the current state for the next session. The previous refresh
(the `39b297b` checkpoint, corrected by `bf1826f`) is superseded by this
one — its full detail stays in git history; release mechanics and evidence
live in `docs/release.md`.

Last updated: **2026-11-25**. **Checkpoint: `b0b150e`** — the merged tree,
pushed to `origin/main` by the lead (`bf1826f..b0b150e`). This docs commit
sits on top of it and is local only (no push). Suite counts are **merged-tree
evidence** at `b0b150e`: the merged-tree matrix was run on that tree (lead
and lane evidence); this docs lane independently re-ran `npm test` (2 825 / 2 816 pass / 0 fail
/ 0 cancelled / 9 skipped, Node v24.13.0) and re-verified the CI run through
the GitHub Actions API. Git/publish facts were re-verified read-only
(`git rev-parse`, `git tag`, `git branch --no-merged`, `git worktree list`,
the Actions API).

## Current state

| Item | Value |
|---|---|
| Branch / HEAD | `origin/main` = `b0b150e`; the checkpoint commit is the docs commit on top of it (local only, not pushed by this lane). Working tree clean before that commit |
| Published | **STILL 0.0.2 on `latest` AND `next`**; tags only `v0.0.1` / `v0.0.2` (`v0.0.2` at `354df89`). **No tag, publish, or version bump this session** — the next release repeats `docs/release.md` and needs fresh explicit owner permission. The GitHub Release *page* for `v0.0.2` remains an owner-manual step (no `gh` CLI) |
| Session window | previous checkpoint `39b297b` (its `bf1826f` correction) → `b0b150e`: **12 commits** — the 11-commit B1–B4 batch (1 feat, 2 fixes, 6 docs, 2 tests) plus the `bf1826f` checkpoint correction. Every accepted lane was gated on the merged tree before push; the window's history is linear (no merge commits) |
| CI | **green on all 3 legs at `b0b150e`**: run [45684572246](https://github.com/nik1138/two-brothers-harness/actions/runs/45684572246) (run 140) — `harness (22)`, `harness (24)` and `harness-windows` all `success`, with **"Dependency checks" green in every job** (verified through the Actions API this refresh) |
| Package suite baseline | **2 825 total / 2 816 pass / 0 fail / 0 cancelled / 9 POSIX-only skips**, Windows, merged tree at `b0b150e`, in `npm test` (re-run by this docs lane, Node v24.13.0) and in `npm run test:spawn` (identical lane evidence) (+13 tests over the `12e3097` baseline of 2 812) |
| WSL Linux parity | at `b0b150e` (Ubuntu, Node **v22.23.5**): 2 825 total / 2 823 pass / 0 fail / 0 cancelled / 2 skipped, **three consecutive runs**; targeted 100/100. This is the gate that discriminates the Node-22 timer class |
| Web / browser / CLI / faults | web **753 / 753**, web build PASS; browser E2E **44 PASS / 0 FAIL / 1 SKIP**; `e2e/cli.ts` and `e2e/cli.ts --dist` PASS (**19 scenarios each**); server-prompt-audit PASS; server-status PASS (**3/3**); faults **7/7**; reference selftest PASS; root `npm run check` PASS (**105 dist files**); `SMOKE TEST: PASS` |
| Packaging | `npm run check` PASS at `b0b150e` (105 dist files, only `zod` + `@earendil-works/pi-mcp`). Packaging metadata is untouched since the 0.0.2 measurement at `8baae35` (`git log 8baae35..b0b150e -- packages/harness/package.json` is empty), so the tarball figures stand: **428 files / 1.66 MB packed / 6.77 MB unpacked**. `docs/release.md` carries those figures (`2b7acdf`). Tarball-smoke, `pack:check` and the release rehearsal were **not** re-run for this batch (no release prep started) |
| Live serve | the lead restarts the `:8600` serve at `b0b150e` (the previous instance predates this batch); it runs from `packages/harness` with `--sessions-dir sessions` against an **empty store** left by the 2026-11-25 incident (below). The previous checkpoint's two preserved sessions are **lost** (gitignored store, no backup — see "Known loss") |
| Provider keys | **NOT set** — the 2026-11-25 incident destroyed the sealed store (`sessions/settings.json`), so the owner must re-enter provider keys and role settings before the live app is usable. See "Known loss" |

## Shipped since the last checkpoint (`bf1826f` → `b0b150e`, 11 commits)

Ten accepted lane commits plus one disclosed test-only integration fixture
fix (`b0b150e`). Every feature was accepted in its own lane; one merged-tree
FAIL blocks the push. Per-commit contracts are in
`packages/harness/CHANGELOG.md` (`[Unreleased]`) and in each commit message.

**B1 — a degraded review is now visible, not silently accepted** (`ef9b64b`,
docs `dc19a0d` / `32c965c`, tests `dd39953`). A review whose strict payload
fails and then fails the one repair re-ask still degrades fail-soft: the
default verdict is still `accept` when nothing usable survives, and a
`verdict` the reply did emit (e.g. `revise`) is kept. What changed is the
signal: `HarnessResult.reviewDegraded?: boolean` (absent on a clean run; the
run's **final** review wins, so a later clean revised review clears it), one
additive `review_degraded` runtime event `{type, round, verdict}` per
degraded review (SSE + sidecar replay, emitted before that review's
envelope), `review_degraded: true` in `--json` / `--mode json`, and
`reviewDegraded: true` on the `--stream` result record. The existing
"unstructured model reply for review" warning is unchanged; no protocol
envelope, schema or session-format change.

**B2 — fresh tasks always append; dedupe is resume-only** (`3c65809`, docs
`0508085`). New `HarnessOptions.dedupeInitialTask`, default `false`:
`run()` always appends the task envelope for a fresh run, so a repeated
prompt is a real new turn even when an identical user message already exists.
The historical same-task check survives only where the caller already
appended the task — `--resume` (a resumed `run` and the first resumed `chat`
turn) and the TUI `@skill:`/`@file` pre-append path. `serve` never opts in,
so two identical `POST /api/runs` deliberately create two envelopes. The
graph/session/compaction pins were updated with the flag.

**B3 — the consult belt's "read-only" promise is corrected** (`1fd1585` +
`e9930a3`, `3801afa`). The false promise is gone from `docs/`
(`cli-reference`, `plugins`, `quickstart`, `backlog`, `design-review`), both
READMEs and two `clihelp.ts` strings; the TUI mode-picker drops
"(read-only)", the senior-review grounding note now says "workspace checks",
and the helper-child line says "approval-brokered built-in tool set" instead
of "read-only tool set". The honest contract, now stated everywhere: the
four built-in workspace mutation tools (`workspace_write_file`,
`workspace_edit_file`, `workspace_delete_file`, `workspace_run_shell`) are
excluded from the consult belt, while role-scoped (`shared`/`senior`/`junior`)
MCP and plugin tools remain and may mutate through their handlers; approval
prompts cover the built-in mutation/shell paths, not those tools; the consult
phase is not a sandbox.

**B4 — a plugin selected twice registers once** (`a6464da`). `bindingsFor`
(and `configurePluginBindings`) dedupes the active list by the **resolved
loaded plugin**, not the raw setting string — the same name twice, or a name
plus a path spelling of itself (`./notes`, `notes.ts`, an absolute path) —
so its tools register once and its hooks run once. The first selection wins
(its per-entry options apply); each skipped duplicate is recorded with
exactly one diagnostic naming the plugin and the first-selection rule (and
that the duplicate's options were ignored when they differ).
`normalizePluginSettings` and persisted-settings semantics are unchanged.

### Integration fixture fix (`b0b150e`, test-only)

`e2e/faults.ts`'s two overflow scenarios restore a seeded session that
already carries the task and then call `harness.run` directly. With B2's
default (fresh runs always append), that appended a second task envelope and
broke `overflow-recovery`'s envelope-kind assertion. The scenarios now build
the harness with `dedupeInitialTask: true` — the same resume contract
`run`/`chat --resume` uses — so they keep their seeded-session premise. The
breakage was reproduced on the accepted B2 tip first, then fixed; test-only,
no product behavior change.

### Residuals (recorded honestly; not fixed)

1. **TUI identical-attachment retry reuses the first task envelope.**
   Submitting the *identical* attachment task twice still reuses the first
   task envelope: the TUI's own `hasMessage` guard skips the pre-append
   (`src/tui/app.ts:3254-3263`) and the harness `dedupeInitialTask` then
   skips as well. This is pre-existing retry behavior (the code comment
   states identical blocks are never re-attached), documented as a note, not
   changed by B2.
2. **Model-facing prompt strings still say "read-only".** The prompt
   constants still describe the offered tools as read-only — e.g.
   `ROUTING_DIRECTIVE` (`src/harness.ts:647`), `VERIFY_INSTRUCTION`
   (`:585-588`) and `SOLO_DECISION_DIRECTIVE` (`:673`). Changing prompt
   bytes needs the `tests/modebytes` goldens regenerated → **separate lane**.
   Code comments in `harness.ts` / `tui/app.ts` also still say read-only in
   places (not user-visible).
3. **The review grounding note says "workspace checks".**
   `src/harness.ts:4550-4551` says "workspace checks" although the evidence
   can also come from role-scoped MCP/plugin tools — a narrow wording point,
   not a safety claim; optional later tweak.

### Operational lessons (carried, still current)

1. **Node-22 unref'd deadline timers.** A deadline timer that must settle a
   hanging promise has to stay ref'd; unref'ing lets the event loop drain and
   `node:test` cancels the remaining tests (1 863 cancelled in the observed
   case). The class was fixed three times (`e51c54f`, `1079917`, `b67895b`)
   and caught once pre-landing (`12e3097`). **Only the WSL Node-22
   merged-tree gate discriminates it**; Windows Node 24 stays green.
2. **Lane and housekeeping discipline.** Writes and worktree cleanup must
   stay inside the lane's own `.tmp/wt-<concern>` tree; never point a
   recursive cleanup at the main checkout or a worktree parent, and never
   junction `node_modules` into a lane worktree. On 2026-11-25 a housekeeping
   lane removing merged worktrees **most likely followed an NTFS
   `node_modules` junction** from a removed acceptance worktree and deleted
   **294 tracked files** from the main checkout plus the gitignored
   `packages/harness/sessions` store; the tracked files were restored from
   HEAD, the sessions are unrecoverable. The rule and the non-recursive
   `rmdir` removal step are in `AGENTS.md` ("Subagent Lanes"). Recovery when
   a lane wrote into main instead of its worktree: interrupt, SHA256-verified
   copy of the lane's content into its worktree, restore main from HEAD,
   resume.
3. **CHANGELOG `[Unreleased]` adjacency.** Pre-check with
   `git merge-tree --write-tree --name-only`, integrate with
   `git merge-file --union` on index stages 1/2/3 during the rebase, then
   verify at byte level that each accepted block is a contiguous byte run in
   the merged `CHANGELOG.md`; when patch-ids differ because of hunk context,
   verify the per-file added/removed line arrays are byte-identical.
4. **The merged-tree gate catches cross-lane defects** — per-lane acceptance
   is necessary but not sufficient (this batch: the B2 default broke a
   hermetic fixture that constructs the harness directly); keep the full
   merged-tree matrix before push.
5. **`web/` is NOT an npm workspace** — a fresh worktree needs `npm install`
   in `web/` for smoke's `vue-tsc`.
6. **CI failure artifacts need auth to download** — owner-approved read-only
   stored-credential use (`git credential fill`, `GCM_INTERACTIVE=Never` /
   `GIT_TERMINAL_PROMPT=0`, token never printed or persisted).
7. **npm hoisting**: install at root. **WSL bash lacks nvm PATH** — prepend;
   `bash -lc` mangles quotes, use an LF script via `wsl -- bash /mnt/c/...`.
8. **A "failed before it finished" subagent notice can be premature** —
   verify git/CI state before replacing a lane.

### Audit outcomes

Broad audits completed ahead of the `12e3097` checkpoint covered tool
calling, subagents, MCP, skills, cache, plugins, junior/senior workflow, and
docs/README freshness. Those SAFE findings landed there (`b1fc2c5` →
`12e3097`). The 2026-11-25 owner-gated queue's **B1–B4 landed in this batch**
(above); the remaining decisions are in `.tmp/owner-decisions-2026-11-25.md`
(gitignored; refreshed to `b0b150e`, where the still-open A1–A2, B5–B11,
C1–C4 and D1–D2 lead the file). OAuth designs were reviewed and **deferred
by the owner** ("I think we don't need this now") — do not propose OAuth
again.

## In flight

Nothing is in flight on `main` — the tree is clean at `b0b150e`, and this
docs checkpoint commit is local only (no push). The **safe autonomous queue
is exhausted**; every remaining item needs an owner decision.

### Known loss (2026-11-25)

A housekeeping lane removing merged worktrees **most likely followed an NTFS
`node_modules` junction** from a removed acceptance worktree into the main
store (the removed worktrees are gone, so the tree cannot be named; the
practice is on record in `.tmp/review/wave23.md`); the main store's own
workspace junction `node_modules/@two-brothers/harness` → `packages/harness`
then turned it into a double wipe. It deleted 294 tracked files from the main
checkout and the gitignored `packages/harness/sessions` store. The tracked
files were restored from `HEAD` and the tree is content-clean; the **session
store is gone — no backup was found**, so the two sessions the previous
checkpoint preserved (`2026-11-14T16-33-32-134-4176c1`,
`2026-11-14T16-39-48-429-066581`) are lost. The sealed
`sessions/settings.json` key/settings store went with it, so provider keys
and role settings are **not configured**; the live server runs with an empty
store. Do not claim those sessions or keys exist.

### Unmerged worktrees awaiting the owner's decision (do not remove)

| Worktree | Branch / commit |
|---|---|
| `.tmp/worktrees/release-doc-count` | `docs-release-e2e-count` @ `8dfcab5` |
| `.tmp/worktrees/stream-follow-touch` | `fix-stream-follow-touch-test` @ `638f8a4` |
| `.tmp/worktrees/stream-scroll-test` | `test-stream-scroll` @ `ec6c998` |
| `.tmp/worktrees/user-message-nav-acceptance` | detached @ `9a96b9d` |
| `C:/code/tb-lane-touch` | `test-stream-scroll-touch` @ `dbf0c2f` |

Each needs a merge / abandon / keep call. Verified this refresh with
`git worktree list`: these five are the worktrees awaiting a decision; this
batch's lane worktrees and the previous batch's detached acceptance
worktrees are no longer present, and this docs lane deleted nothing. The six
unmerged local branches also include `dev` (`715275f`) and
`docs-goal-modules` (`7c187fd`), which have no worktree. opencode-owned
worktrees (26, incl. `agents-depth3` @ `7b1d80f`, fully merged but
opencode-owned) and `Temp/tb-review-tip` are never touched.

## Incident / prevention notes (kept)

### Incident (2026-11-14)

An NTFS-junction-traversing cleanup emptied main-checkout
`packages/harness`; tracked files restored, untracked `sessions/` content
permanently lost. Keys re-entered. **Never point recursive cleanup/delete
tools at the repo root, worktree parents, or any path that can contain NTFS
junctions; keep destructive commands inside one known directory.**

## Commands / verification

Use Windows PowerShell (not `pwsh`):

```powershell
cd C:\code\two-brothers-harness
cd packages/harness
npm run typecheck
npm test                     # and: npm run test:spawn
npm run build
cd ..\..
npm run check                # pinned + recursive runtime-deps (in CI too)
cd web
npm test
npm run build
cd ..\packages\harness
npm run sync-web
cd ..\..
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/smoke-test.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/e2e-test.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/release-rehearsal.ps1
$env:TWO_BROTHERS_E2E_ONLY='settings-subagent'; node e2e/run.mjs
```

Web-build gates need `TEMP`/`TMP` inside the checkout (`.tmp/build-temp`).
Do not run the live server and smoke against the same sessions dir at once
(writer lock).

## Constraints / owner decisions

- The brothers are peers with one shared context; subagents are a helper
  tier, never protocol peers.
- `PROTOCOL.md` byte-stable markers unchanged; runtime events/web types
  additive.
- **Pushing `main` is approved.** **No tag, publish, or version bump without
  fresh explicit owner words.** 0.0.2 fully shipped (`latest` = `next`).
- No new runtime deps without a ledger entry; web keeps building;
  `typescript/` zero-dependency.
- Conventional Commits; independent acceptance before merge.
- B1–B4 are **accepted and merged**; B1's `reviewDegraded` /
  `review_degraded` surface is additive and final-review-wins. B2's
  `dedupeInitialTask` defaults to `false` and is never wired on `serve`.

## Next moves

Per `todo.md`'s owner menu:

1. **Release decisions (A1–A2):** the next version and go-ahead (`0.1.0`
   recommended — 83 commits since `v0.0.2`; `0.0.3` if incremental), release
   prep, and the manual GitHub Release page for `v0.0.2`. Publishing is
   owner-run.
2. **Behavior decisions (B5–B11):** bundle selection authority, cost-prefix
   matching, plugin MCP default role, compaction truncation notice, dropped
   steering in the web UI, `@file` binary marker, preset seed windows —
   exact questions and evidence are in `.tmp/owner-decisions-2026-11-25.md`;
   nothing starts without the call.
3. **UX decisions (C1–C4):** toast stack geometry, CLI writer lock, Home/End
   transcript jump, mouse-wheel scrolling.
4. **Housekeeping (D1–D2):** the five unmerged worktrees (merge / abandon /
   keep) and a session-store backup policy.
5. **Design shelf (owner-gated, unimplemented):**
   `.tmp/web-wiring-consolidation-design.md`,
   `.tmp/keybinding-surfaces-design.md`, `.tmp/test-audit-report.md`,
   `.tmp/backlog-triage.md`.
6. **OAuth — deferred by the owner; do not propose.** `.tmp/oauth-design.md`
   stays reference only.

The safe autonomous queue is **exhausted** beyond this. The deferred
register is unchanged (F/D designs, structural candidates, hypotheses,
WAN/soaks manual, POSIX hardware validation, the true-virtualization epic,
third sibling not on the backlog).

## Handoff checklist

- [ ] Read `AGENTS.md`, `docs/backlog.md`, this file, and `todo.md`.
- [ ] Confirm `git status` clean, `git log -1` is a docs checkpoint commit,
      and its parent (`HEAD~1`) is `b0b150e`.
- [ ] Check the background-task panel for running gates/lanes (stale-serve
      writer-lock gotcha).
- [ ] Run package + web tests and the smoke gate on the merged tree.
- [ ] Live serve: the `:8600` instance runs from `packages/harness` with an
      **empty** session store (see "Known loss"); rebuild + `sync-web` +
      restart if product bytes change again.
- [ ] Provider keys/role settings are **not configured** after the
      2026-11-25 loss — the owner re-enters them before using the live app.
- [ ] Keep `research/`, sessions, credentials, logs out of git (this file +
      `todo.md` are the tracked checkpoint exception).
- [ ] No publish/tag/version bump without explicit owner permission.
