# Two Brothers — handoff

Local working handoff, tracked as the checkpoint record (owner decision
2026-11-14). The frozen historical snapshot is `docs/history/handoff.md`;
this file is the current state for the next session. The previous refresh
(the `33ecc36` checkpoint) is superseded by this one — its full detail stays
in git history; release mechanics and evidence live in `docs/release.md`.

Last updated: **2026-11-26**. **Checkpoint: `2347d7c`** — the merged tree,
pushed to `origin/main` by the lead (`33ecc36..6ba53ed` for the first batch,
`6ba53ed..2347d7c` for the second). This docs commit sits on top of it and is
local only (no push). Suite counts are merged-tree evidence: package
**2 829 total / 2 820 pass / 0 fail / 0 cancelled / 9 skipped** at `6ba53ed`
in both `npm test` and `npm run test:spawn`, independently re-confirmed at
`2347d7c` by this docs lane (`npm test`, Node v24.13.0; the package
`src/`/`tests/` trees are unchanged after `6ba53ed`); WSL Node-22 at `6ba53ed`
**2 829 / 2 827 pass / 0 fail / 0 cancelled / 2 skipped ×3**; web
**777 / 777**; browser E2E **44 PASS / 0 FAIL / 1 SKIP** at both `6ba53ed`
and `2347d7c`. CI runs **45813789753** (`6ba53ed`) and **45821219237**
(`2347d7c`) are green on all three legs with "Dependency checks" green
(re-verified through the Actions API). Git/publish facts were re-verified
read-only (`git rev-parse`, `git tag`, `git branch --no-merged`,
`git worktree list`, the Actions API, `npm view`).

## Current state

| Item | Value |
|---|---|
| Branch / HEAD | `main` = `origin/main` = `2347d7c`; the checkpoint commit is the docs commit on top of it (local only, not pushed by this lane). Working tree clean before that commit |
| Published | **STILL 0.0.2 on `latest` AND `next`**; tags only `v0.0.1` / `v0.0.2` (`v0.0.2` at `354df89`). **No tag, publish, or version bump this session** — the next release repeats `docs/release.md` and needs fresh explicit owner permission. The GitHub Release *page* for `v0.0.2` remains an owner-manual step (no `gh` CLI) |
| Session window | previous checkpoint `33ecc36` → `2347d7c`: **5 commits** — 3 features (`04a9fb3` server PATCH binder; `fdd9519` + `ce4595d` web), 1 fix (`6ba53ed`), 1 docs follow-up (`2347d7c`). Linear history (no merge commits), integrated in two merged-tree passes: `33ecc36..6ba53ed` and `6ba53ed..2347d7c` |
| CI | **green on all 3 legs at both tips**: run [45813789753](https://github.com/nik1138/two-brothers-harness/actions/runs/45813789753) at `6ba53ed` and run [45821219237](https://github.com/nik1138/two-brothers-harness/actions/runs/45821219237) at `2347d7c` — `harness (22)`, `harness (24)` and `harness-windows` all `success`, with **"Dependency checks" green in every job** (Actions API re-checked this refresh) |
| Package suite baseline | **2 829 total / 2 820 pass / 0 fail / 0 cancelled / 9 POSIX-only skips** at `6ba53ed`, Windows, in `npm test` and in `npm run test:spawn` (identical lane evidence); this docs lane re-ran `npm test` at `2347d7c` with the same counts (230 s). The `sessionworkspacepatch` suite adds 4 tests to the previous baseline |
| WSL Linux parity | at `6ba53ed` (Ubuntu-24.04, Node **v22.23.5** via nvm, npm 10.9.9): **2 829 / 2 827 pass / 0 fail / 0 cancelled / 2 skipped**, **three consecutive runs**; raw logs `wsl-npm-test-{1,2,3}.log`. This is the gate that discriminates the Node-22 timer class. **Not re-run for the `2347d7c` merge** — that merge changed no `packages/harness/src/` or `tests/` file (web/docs/CHANGELOG/e2e only) |
| Web / browser / CLI / faults | web **777 / 777** (this docs lane re-ran the suite) + web build PASS (integration evidence); browser E2E **44 PASS / 0 FAIL / 1 SKIP** at `6ba53ed` (286.7 s) and at `2347d7c` (306.4 s; the SKIP is `real`, opt-in); `e2e/cli.ts` and `e2e/cli.ts --dist` PASS (**19 scenarios each**); server-prompt-audit PASS; server-status PASS (**3/3**); faults **7/7**; reference selftest PASS; root `npm run check` PASS (**105 dist files**); `SMOKE TEST: PASS` |
| Packaging | `npm run check` PASS at `2347d7c` (105 dist files, only `zod` + `@earendil-works/pi-mcp`). `packages/harness/package.json` is untouched since the 0.0.2 measurement at `8baae35` (`git log 8baae35..2347d7c -- packages/harness/package.json` is empty), so the tarball figures stand: **428 files / 1.66 MB packed / 6.77 MB unpacked**. `docs/release.md` carries those figures (`2b7acdf`). Tarball-smoke, `pack:check` and the release rehearsal were **not** re-run for this window (no release prep started) |
| Live serve | rebuilt and restarted by the lead at `2347d7c`; **PID 76540** (`.tmp/serve-8600.log` + `packages/harness/sessions/.writer.json`: `owner: serve`, `created 2026-11-26T12:44:07Z`; process command line `node dist/cli.js serve --port 8600 --sessions-dir sessions`, cwd `packages/harness`). It serves the store described under "Known loss" — two 2026-11-26 sessions plus a re-created settings file, not an empty store |
| Provider settings | the sealed `settings.json` destroyed on 2026-11-25 has been re-created: one encrypted provider key (plus the local `lmstudio` provider) and role settings are present in `packages/harness/sessions/settings.json`. The two pre-incident sessions and the original sealed store remain unrecoverable. The owner should confirm the re-created provider/roles are the intended ones before relying on the live app |

## Shipped since the last checkpoint (`33ecc36` → `2347d7c`, 5 commits)

Every slice was accepted in its own lane and gated on the merged tree; one
merged-tree FAIL blocks the push. Per-commit contracts are in
`packages/harness/CHANGELOG.md` (`[Unreleased]`) and in each commit.

### Provider model picker (`fdd9519`, `6ba53ed`; docs in `fdd9519` / `6ba53ed`)

Settings → Providers discovery is now an **explicit picker, never a bulk
add**. The existing-provider **Refresh models** result and the **Add
provider** card's **Fetch models** result both render every reported model id
as a checkbox row; a fresh draft selects **nothing**, and only checked ids are
appended to the model draft (discovered order, no duplicates). The Add card
can still be saved with zero models. Ids already in the draft render disabled
as **"in draft"**, are excluded from the add count, and stay out of the
appended set; when every reported id is already in the draft the picker says
so and disables the action. A reported list longer than **8** ids gets a
case-insensitive **Filter models** input; **Select all** applies to the
visible/filtered rows (the "N of M selected" count covers every reported row),
**Clear** clears the selection, and the primary action is **"Add selected (N)"**
(disabled at 0). A re-fetch keeps reported ids already in the draft selected,
so a previously chosen model is never silently dropped (`6ba53ed` fixes that
first-cut behavior). New suite `web/tests/providerDiscovery.test.ts`; the
`settings-provider-setup` browser scenario was updated; the
`docs/cli-reference.md` / `quickstart.md` / `troubleshooting.md` wording
("Add N to draft" → check, then "Add selected (N)") was corrected. No backend,
protocol or dependency change.

### Workspace start gate (`04a9fb3`, `ce4595d`, `2347d7c`)

**PATCH binder (`04a9fb3`).** `PATCH /api/sessions/{name}` now accepts
`{title?, workspace_id?}` and requires **at least one field**. `title` keeps
its historical rename contract; `workspace_id` must name a **registered**
workspace and sets the persisted sidecar link (later runs that omit the id
inherit it); `workspace_id: null` clears the link by removing the key.
Unknown ids are a 400 `unknown workspace_id`; a blank id or title is a 400;
no field is a 400 `provide title or workspace_id`; an unknown session is a
404. Existing title-only clients keep their exact behavior. New suite
`packages/harness/tests/sessionworkspacepatch.test.ts` (4 tests, registered in
`run-all.ts`).

**Web gate (`ce4595d`).** The web app never starts a run without a workspace.
The New-session dialog has no "No workspace" option and keeps **Create**
disabled until a real registered workspace is picked (the add-folder finder
stays the way to create one; the disabled submit carries an accessible
reason). An existing session with no metadata link shows an in-place
**"Select a workspace to start"** picker inside the composer: submitting is
blocked with the accessible reason, choosing a workspace binds it through
`PATCH /api/sessions/{name}` `{workspace_id}` and unblocks the run; on failure
the prompt shows one bounded error in place and **keeps the pick**. Every run
posts the bound non-null `workspace_id`; the sidebar filter is only a
display / `@`-picker fallback, never a run workspace — the old filter-based
`runWorkspaceId` run fallback is gone. New `WorkspaceStartPrompt.vue` and
`web/tests/workspaceStart.test.ts`; the `hero-starters` browser scenario
carries the gate assertions. Web suite is 777.

**Comment-only follow-up (`2347d7c`).** Marks the backend no-workspace
refusal as **forward-compatible**: the client gate is authoritative today,
and once an enforcing backend lands it answers `select a workspace to start`
(the picker's error handling already recognizes that message). No behavior
change.

### Deferred slice — workspace enforcement (NOT shipped)

Requiring a workspace for CLI `run`/`chat` (`--workspace`), refusing a
tool-less TUI start, and the serve-side 400 `select a workspace to start` for
an unbound run were attempted broadly and **reverted**, preserved as
`C:\code\two-brothers-harness\.tmp\workspace-enforcement-wip.patch`
(**370,220 bytes ≈ 370 KB**, 43 files including the test ripple). The reason
for deferral: the ripple (40+ server/CLI test files) made the lane unsafe to
land in one step, so the **web gate + PATCH binder shipped first**. The next
step is an owner decision (resume the patch as its own slice, or stop at the
web gate) — tracked as A3 in `todo.md` and
`.tmp/owner-decisions-2026-11-25.md`. Until then the web client is the only
enforcement point; direct API calls and CLI/TUI runs can still omit a
workspace.

### Live-model validation (2026-11-26)

Against the owner's LM Studio at `http://192.168.31.123:1234/v1` with
`lfm3-1.7b` for **both** roles, the live suite at `33ecc36` recorded
**13 PASS / 1 FAIL across the 14 suites the runner listed**
(`.tmp/live-e2e/run-lfm3-both.log`;
`packages/harness/e2e/runs/report-2026-11-26T09-05-40-164Z.json`; the lead's
summary counts it as 14/15). `connection`, `consult`, `work`, `resume`,
`connection-server`, `server-prompt-audit`, `server-work-approvals`, and the
status/mode/error-restart suites (live **and** hermetic) all PASS. The one
miss is `server-consult` (timed out after **900.1 s**): the model invoked
`ask_user`, so the run correctly parked at `run_status: waiting` after an
`approval_requested` question; the live client does not answer questions, so
the SSE drive timed out — **model behaviour, not a regression**. Earlier,
with `lfm3-vl-2b` as senior, `work` was flaky on **both** the merged and
baseline trees (merged 2/3 vs baseline 1/3,
`.tmp/live-e2e/work-repeatability.log`) — model capability, not a code
regression. Use `--max-tokens` **≥ 512**: reasoning models otherwise return
empty content.

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
   is necessary but not sufficient (the B2 batch's default broke a hermetic
   fixture that constructs the harness directly); keep the full merged-tree
   matrix before push.
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
`12e3097`); the 2026-11-25 owner-gated queue's **B1–B4 landed at `b0b150e`**
and the **provider picker + workspace gate landed in this window** (above).
The remaining decisions are in `.tmp/owner-decisions-2026-11-25.md`
(gitignored; refreshed to `2347d7c`, where the still-open A1–A3, B5–B11,
C1–C4 and D1–D2 lead the file). OAuth designs were reviewed and **deferred by
the owner** ("I think we don't need this now") — do not propose OAuth again.

## In flight

Nothing is in flight on `main` — the tree is clean at `2347d7c`, and this
docs checkpoint commit is local only (no push). The **safe autonomous queue
is exhausted**; every remaining item needs an owner decision, including the
deferred workspace-enforcement slice.

### Known loss (2026-11-25; store since re-created)

A housekeeping lane removing merged worktrees **most likely followed an NTFS
`node_modules` junction** from a removed acceptance worktree into the main
store (the removed worktrees are gone, so the tree cannot be named; the
practice is on record in `.tmp/review/wave23.md`); the main store's own
workspace junction `node_modules/@two-brothers/harness` → `packages/harness`
then turned it into a double wipe. It deleted 294 tracked files from the main
checkout and the gitignored `packages/harness/sessions` store. The tracked
files were restored from `HEAD` and the tree is content-clean; the
**pre-incident session store is gone — no backup was found**, so the two
sessions the previous checkpoint preserved
(`2026-11-14T16-33-32-134-4176c1`, `2026-11-14T16-39-48-429-066581`) are
lost, as is the original sealed `settings.json`.

The store has since been **re-created by the live validation**: it currently
holds two 2026-11-26 sessions (`2026-11-26T12-03-20-143-e977e3`,
`2026-11-26T15-12-02-319-2cf36f`), `workspaces.json`, and a `settings.json`
with one encrypted provider key plus the local `lmstudio` provider and role
settings (roles point at `ternary-bonsai-2.5-27b` on `localhost:1234`). So
provider keys/settings are **configured again**, but the pre-incident store
and its keys remain unrecoverable; do not claim those sessions or the
original key store exist.

### Unmerged worktrees awaiting the owner's decision (do not remove)

| Worktree | Branch / commit |
|---|---|
| `.tmp/worktrees/release-doc-count` | `docs-release-e2e-count` @ `8dfcab5` |
| `.tmp/worktrees/stream-follow-touch` | `fix-stream-follow-touch-test` @ `638f8a4` |
| `.tmp/worktrees/stream-scroll-test` | `test-stream-scroll` @ `ec6c998` |
| `.tmp/worktrees/user-message-nav-acceptance` | detached @ `9a96b9d` |
| `C:/code/tb-lane-touch` | `test-stream-scroll-touch` @ `dbf0c2f` |

Each needs a merge / abandon / keep call. Verified this refresh with
`git worktree list`: these five are the **decision** worktrees; six local
branches are unmerged (`dev 715275f`, `docs-goal-modules 7c187fd`, plus the
four decision branches above). `git worktree list` also shows this window's
**merged** lane/acceptance worktrees — `.tmp/wt-default-workspace`
(`agents-default-workspace` @ `04a9fb3`), `.tmp/wt-provider-model-picker`
(`agents-provider-model-picker` @ `6ba53ed`), `.tmp/wt-web-workspace`
(`agents-web-workspace` @ `2347d7c`), and detached
`.tmp/accept-provider-picker` @ `5343cf7` / `.tmp/accept-web-workspace` @
`ce4595d` — which are cleanup candidates for a later hygiene pass. This docs
lane removed nothing. opencode-owned worktrees (26, incl. `agents-depth3` @
`7b1d80f`) and `Temp/tb-review-tip` are never touched.

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

For the live LM Studio suite, set `TWO_BROTHERS_E2E_BASE_URL` and both
`TWO_BROTHERS_E2E_SENIOR_MODEL` / `TWO_BROTHERS_E2E_JUNIOR_MODEL` (the
2026-11-26 run used `lfm3-1.7b` for both), then run `npm run test:e2e` from
`packages/harness`. Direct CLI runs against reasoning models need
`--max-tokens` ≥ 512; otherwise they can return empty content. Web-build gates
need `TEMP`/`TMP` inside the checkout (`.tmp/build-temp`). Do not run the live
server and smoke against the same sessions dir at once (writer lock).

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
- B1–B4 are accepted and merged. The provider picker and the web workspace
  gate are accepted and merged; the web client is the **only** workspace
  enforcement point until the deferred CLI/TUI/serve slice is decided (A3).
- The web gate's `runWorkspaceForSession` has **no** filter parameter; a run
  never inherits the sidebar filter.

## Next moves

Per `todo.md`'s owner menu:

1. **Release decisions (A1–A2):** the next version and go-ahead (`0.1.0`
   recommended — **89 commits** since `v0.0.2`; `0.0.3` if incremental),
   release prep, and the manual GitHub Release page for `v0.0.2`. Publishing
   is owner-run.
2. **Deferred enforcement decision (A3):** resume
   `.tmp/workspace-enforcement-wip.patch` as its own slice (`--workspace` for
   CLI `run`/`chat`, tool-less TUI refusal, serve-side 400), stay web-only
   for now, or stop. Exact options/recommendation are in
   `.tmp/owner-decisions-2026-11-25.md`.
3. **Behavior decisions (B5–B11):** bundle selection authority, cost-prefix
   matching, plugin MCP default role, compaction truncation notice, dropped
   steering in the web UI, `@file` binary marker, preset seed windows —
   nothing starts without the call.
4. **UX decisions (C1–C4):** toast stack geometry, CLI writer lock, Home/End
   transcript jump, mouse-wheel scrolling.
5. **Housekeeping (D1–D2):** the five decision worktrees (merge / abandon /
   keep), the merged lane worktrees' cleanup, and a session-store backup
   policy.
6. **Design shelf (owner-gated, unimplemented):**
   `.tmp/web-wiring-consolidation-design.md`,
   `.tmp/keybinding-surfaces-design.md`, `.tmp/test-audit-report.md`,
   `.tmp/backlog-triage.md`.
7. **OAuth — deferred by the owner; do not propose.** `.tmp/oauth-design.md`
   stays reference only.

The safe autonomous queue is **exhausted** beyond this. The deferred
register is unchanged (F/D designs, structural candidates, hypotheses,
WAN/soaks manual, POSIX hardware validation, the true-virtualization epic,
third sibling not on the backlog).

## Handoff checklist

- [ ] Read `AGENTS.md`, `docs/backlog.md`, this file, and `todo.md`.
- [ ] Confirm `git status` clean, `git log -1` is a docs checkpoint commit,
      and its parent (`HEAD~1`) is `2347d7c`.
- [ ] Check the background-task panel for running gates/lanes (stale-serve
      writer-lock gotcha; the live `:8600` serve owns
      `packages/harness/sessions/.writer.json`, PID 76540).
- [ ] Run package + web tests and the smoke gate on the merged tree.
- [ ] Live serve: the `:8600` instance runs from `packages/harness` against a
      store holding the two 2026-11-26 sessions and the re-created settings;
      rebuild + `sync-web` + restart if product bytes change again.
- [ ] Confirm the re-created provider key and role settings are the intended
      ones — the 2026-11-25 loss destroyed the original sealed store.
- [ ] Keep `research/`, sessions, credentials, logs out of git (this file +
      `todo.md` are the tracked checkpoint exception).
- [ ] No publish/tag/version bump without explicit owner permission.
