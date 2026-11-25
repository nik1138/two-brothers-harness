# Two Brothers — handoff

Local working handoff, tracked as the checkpoint record (owner decision
2026-11-14). The frozen historical snapshot is `docs/history/handoff.md`;
this file is the current state for the next session. The previous refresh
(the `b1fc2c5` checkpoint, `06c7ce6`) is superseded by this one — its full
detail stays in git history; release mechanics and evidence live in
`docs/release.md`.

Last updated: **2026-11-25**. **Checkpoint base: `origin/main` = `12e3097`**
(this docs checkpoint commit sits on top, unpushed). Suite counts are
**recorded merged-tree lane evidence**; git/CI/publish facts were
re-verified read-only this refresh (`git rev-parse`, the GitHub Actions
API). The tree is clean; the checkpoint commit is local and **not pushed**
by this lane.

## Current state

| Item | Value |
|---|---|
| Branch / HEAD | `main` parent `12e3097` = `origin/main`; the docs checkpoint commit is on top (1 ahead of `origin/main`, unpushed). Working tree clean |
| Published | **STILL 0.0.2 on `latest` AND `next`**; tags only `v0.0.1` / `v0.0.2` (`v0.0.2` at `354df89`). **No tag, publish, or version bump this session** — the next release repeats `docs/release.md` and needs fresh explicit owner permission. The GitHub Release *page* for `v0.0.2` remains an owner-manual step (no `gh` CLI) |
| Session window | previous checkpoint `b1fc2c5` → `12e3097`: **16 commits** (11 fixes, 3 docs, 1 test, 1 perf). Every feature independently accepted in a separate lane; every merge fast-forward with merged-tree gates green before push |
| CI | **green on all 3 legs at `12e3097`**: run [45646884074](https://github.com/nik1138/two-brothers-harness/actions/runs/45646884074) (run 137) — `harness (22)`, `harness (24)` and `harness-windows` all `success`, with **"Dependency checks" green in every job** (verified through the Actions API this refresh). Actions are node24 majors (`checkout`/`setup-node`/`upload-artifact` @v7) |
| Package suite baseline | **2 812 total / 2 803 pass / 0 fail / 0 cancelled / 9 POSIX-only skips**, Windows, merged tree at `12e3097`, in BOTH `npm test` and `npm run test:spawn` (+52 tests over the `b1fc2c5` baseline of 2 760) |
| WSL Linux parity | at `12e3097` (Ubuntu, Node **v22.23.5**): 2 812 total / 2 810 pass / 0 fail / 0 cancelled / 2 skipped, **three consecutive runs**. This is the gate that discriminates the Node-22 timer class |
| Web / browser / CLI / faults | web **753 / 753**, web build PASS; browser E2E **44 PASS / 0 FAIL / 1 SKIP**; `e2e/cli.ts` and `e2e/cli.ts --dist` PASS (**19 scenarios each**); server-prompt-audit PASS; server-status PASS (**3**); faults **7/7**; reference selftest PASS; `npm run check` PASS (**105 dist files**); `SMOKE TEST: PASS` |
| Packaging | `npm run check` PASS at `12e3097` (105 dist files, only `zod` + `@earendil-works/pi-mcp`); packaging metadata untouched since the 0.0.2 measurement at `8baae35`, so the tarball figures stand: **428 files / 1.66 MB packed / 6.77 MB unpacked**. `docs/release.md` now carries those figures (`2b7acdf`) — the old L157 drift (368 / 1.28 MB / 5.17 MB) is closed. Tarball-smoke and `pack:check` were not re-run for this batch |
| Live serve | **running with an empty store** after the 2026-11-25 incident (below): `127.0.0.1:8600`, PID **171960**, `node dist/cli.js serve --sessions-dir sessions` from `packages/harness`; `GET /` 200 (2 728-byte index), `/api/sessions` 200 `[]`. The previous checkpoint's two preserved sessions are **lost** (gitignored store, no backup — see "Known loss") |
| Provider keys | re-entered by the owner after the 2026-11-14 incident; closed |

## Shipped since the last checkpoint (`b1fc2c5` → `12e3097`, 16 commits)

Every feature was accepted in its own lane; one merged-tree FAIL blocks the
push. The per-commit contracts are in `packages/harness/CHANGELOG.md`
(`[Unreleased]`) and in each commit message.

**Earlier in the window**

- `f57da0e` **test:** cover uncovered CAS, memoization and notice-bound
  branches.
- `c3276ec` **perf(tui):** memoize the `withToolExpansion` derivation on the
  source blocks + expansion key set, so a stable expanded tool row keeps the
  warm frame (~0.2 ms instead of 23 ms @100 / 55 ms @250 turns).
- `eaad611` **fix(harness):** `edit_file` refuses content that would not
  round-trip as UTF-8 (Latin-1/cp1251/UTF-16, NUL) and points at
  `write_file`, leaving the bytes untouched; whole-file reads carry the
  additive `binary: true` marker; `run_shell` `timeout <= 0` arms no timer.
- `34ffe18` **fix(provider):** clamp `--timeout` /
  `TWO_BROTHERS_TIMEOUT` to `MAX_PROVIDER_TIMEOUT_SECONDS` (24 h) before the
  per-attempt timer; a Gemini 429 `RetryInfo.retryDelay` feeds the
  exact-wait retry path (capped at 120 s); one warning when a role borrows
  an API key across roles whose base URLs differ.
- `a0319f3` **fix(plugins):** `register(ctx)` bounded by
  `PLUGIN_REGISTER_TIMEOUT_MS` (10 s, fail-soft); `GET /api/mcp` reads the
  selected plugins' load-time declarations instead of re-executing
  `register`; `bindingsFor` snapshots the loaded-plugin map.
- `12591c1`, `2b7acdf`, `3c25f56` **docs:** the shipped `mcp` command,
  `/rewind` guard, per-role usage and mode switching; the release runbook
  figures and validation wording; the CI dep-check step, the `/rewind` CAS
  refusal and the parked-row mark.
- `b67895b` **fix(plugins):** keep the register deadline timer ref'd on
  Node 22.

**The seven commits after `b67895b`**

- `f49ce87` **fix(harness):** account steering accepted during the final
  call — `_steeringUnused` is seeded into the additive
  `public().steering_dropped` view in `finish()` and a terminal
  `drainSteering()` — without appending to the transcript or faking an
  event; the typed `onEvent` sink is fail-soft like the stream sink; and
  `runChild`'s `finally` decrements the helper budget before guarding the
  embedder-supplied `release(id)`.
- `dc3f48a` **fix(harness):** the CLI (`loadRunResources`) and TUI
  (`loadTuiResources`) fold bundle skills through the same
  `mergeBundleSkills(discoverSkills(roots), plugins.bundles.values())` path
  as `serve`, so the 64 KiB bundle cap and operator-over-bundle shadowing
  are identical on all three surfaces; the parity test drives a real
  `createServer` + `GET /api/skills` + `loadRunResources` + `loadTuiResources`
  (`tests/pluginbundle.test.ts`).
- `40f0760` **fix(harness):** compaction size safety —
  `staticPrefixTokens(state)` joins the token-mode trigger (assembled system
  prompt + tool-schema JSON, the larger role belt);
  `summarizerSourceBudget()` bounds the serialized prefix in char mode (the
  declared trigger, else `DEFAULT_SUMMARIZER_SOURCE_CHARS` = 64 000 chars)
  with the existing head+tail and truncation marker, plus exactly one
  tighter retry after a summarizer overflow (`tests/compactionsafety.test.ts`,
  8 tests).
- `3f9c48e` **fix(workspace):** the additive `binary: true` marker now also
  rides paged reads (offset/limit) and streamed reads above the 2 MiB
  source bound — `Utf8TextProbe`, the streaming twin of `decodeUtf8Text`
  (strict incremental UTF-8 + NUL sniff); decoded content, ranges and page
  bookkeeping unchanged (`tests/readrange.test.ts`).
- `8af54c9` **fix(plugins):** each plugin module `import()` runs under
  `PLUGIN_IMPORT_TIMEOUT_MS` (10 s, `PluginManagerOptions.importTimeoutMs`
  for tests) with the fail-soft shape of a registration timeout; the timer
  is ref'd, cleared on both outcomes, and a module that settles late is
  discarded (`tests/plugins.test.ts`).
- `f4c2184` **fix(provider):** model discovery clamps `--timeout` to the
  same 24 h ceiling through the shared `timeoutCeilingWarning()` sink, so an
  oversized value no longer overflows Node's 32-bit timer.
- `12e3097` **fix(plugins):** keep the import deadline timer ref'd — the
  Node-22 timer class again, caught before landing.

### Lessons recorded this session

1. **Node-22 unref'd deadline timers.** A deadline timer that must settle a
   hanging promise has to stay ref'd; unref'ing lets the event loop drain and
   `node:test` cancels the remaining tests (1 863 cancelled in the observed
   case). The class was fixed three times (`e51c54f`, `1079917`,
   `b67895b`) and caught once pre-landing (`12e3097`). **Only the WSL
   Node-22 merged-tree gate discriminates it**; Windows Node 24 stays green.
2. **Lane and housekeeping discipline.** Writes and worktree cleanup must
   stay inside the lane's own `.tmp/wt-<concern>` tree; never point a
   recursive cleanup at the main checkout or a worktree parent, and never
   junction `node_modules` into a lane worktree. On 2026-11-25 a housekeeping
   lane removing merged worktrees **most likely followed an NTFS
   `node_modules` junction** from a removed acceptance worktree (the removed
   trees are gone; its npm-workspace junction points at `packages/harness`)
   and deleted **294 tracked files** from the main checkout plus the
   gitignored `packages/harness/sessions` store; the tracked files were restored from
   HEAD (`git restore --source=HEAD --worktree -- packages/harness`), the
   sessions are unrecoverable. The rule and the non-recursive `rmdir` removal
   step are in `AGENTS.md` ("Subagent Lanes"). Recovery when a lane wrote
   into main instead of its worktree: interrupt, SHA256-verified copy of the
   lane's content into its worktree, restore main from HEAD, resume.
3. **CHANGELOG `[Unreleased]` adjacency.** Pre-check with
   `git merge-tree --write-tree --name-only`, integrate with
   `git merge-file --union` on index stages 1/2/3 during the rebase, then
   verify at byte level that each accepted block is a contiguous byte run in
   the merged `CHANGELOG.md`; when patch-ids differ because of hunk context,
   verify the per-file added/removed line arrays are byte-identical.
4. **The merged-tree gate catches cross-lane defects** — per-lane acceptance
   is necessary but not sufficient; keep the full merged-tree matrix before
   push.
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

Broad audits completed for tool calling, subagents, MCP, skills, cache,
plugins, junior/senior workflow, and docs/README freshness. SAFE findings
landed as the commits above; the rest were consolidated as owner-gated
decisions in `.tmp/owner-decisions-2026-11-25.md` (gitignored; **C1–C8**,
**U1–U5**, **R1–R5**). OAuth designs were reviewed and **deferred by the
owner** ("I think we don't need this now") — do not propose OAuth again.

## In flight

Nothing is in flight on `main` — the tree is clean at `12e3097`, and this
docs commit is local only (no push). The **safe autonomous queue is
exhausted**; every remaining item needs an owner decision.

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
`2026-11-14T16-39-48-429-066581`) are lost. The live server now runs with an
empty store. Do not claim those sessions exist.

### Unmerged worktrees awaiting the owner's decision (do not remove)

| Worktree | Branch / commit |
|---|---|
| `.tmp/worktrees/release-doc-count` | `docs-release-e2e-count` @ `8dfcab5` |
| `.tmp/worktrees/stream-follow-touch` | `fix-stream-follow-touch-test` @ `638f8a4` |
| `.tmp/worktrees/stream-scroll-test` | `test-stream-scroll` @ `ec6c998` |
| `.tmp/worktrees/user-message-nav-acceptance` | detached @ `9a96b9d` |
| `C:/code/tb-lane-touch` | `test-stream-scroll-touch` @ `dbf0c2f` |

Each needs a merge / abandon / keep call. This window's lane and acceptance
worktrees (`.tmp/wt-*`, `.tmp/accept-*`) were pruned by the lead's
interrupted housekeeping pass; any leftovers are a lead/owner call, and this
docs lane deleted nothing. opencode-owned worktrees (incl. `agents-depth3` @
`7b1d80f`, fully merged but opencode-owned) and `Temp/tb-review-tip` are
never touched.

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

## Next moves

Per `todo.md`'s owner menu:

1. **Release decisions (R1–R3):** the next version (`0.1.0` recommended —
   70 commits since `v0.0.2`; `0.0.3` if incremental), release prep, and the
   manual GitHub Release page for `v0.0.2`. Publishing is owner-run.
2. **Behavior decisions:** C1–C8 (correctness/semantics) and U1–U5
   (UX/keyboard/terminal policy) in
   `.tmp/owner-decisions-2026-11-25.md` — exact questions and evidence are
   there; nothing starts without the call.
3. **Five unmerged worktrees (R4):** merge / abandon / keep.
4. **R5 preset seed window values** — reverses a pinned choice; product call.
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
- [ ] Confirm `git status` clean and `git log -1` is this docs checkpoint
      (parent `12e3097`).
- [ ] Check the background-task panel for running gates/lanes (stale-serve
      writer-lock gotcha).
- [ ] Run package + web tests and the smoke gate on the merged tree.
- [ ] Live serve: the `:8600` instance runs from `packages/harness` with an
      **empty** session store (see "Known loss"); rebuild + `sync-web` +
      restart if product bytes change again.
- [ ] Keep `research/`, sessions, credentials, logs out of git (this file +
      `todo.md` are the tracked checkpoint exception).
- [ ] No publish/tag/version bump without explicit owner permission.
