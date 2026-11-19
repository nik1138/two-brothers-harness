# Two Brothers — handoff

Local working handoff, tracked as the checkpoint record (owner decision
2026-11-14). The frozen historical snapshot is `docs/history/handoff.md`;
this file is the current state for the next session. The previous refresh
(the `7834514` checkpoint, `7cae012`) is superseded by this one — its full
detail stays in git history; release mechanics and evidence live in
`docs/release.md`.

Last updated: **2026-11-19**. **Checkpoint: the code tree `29861c7`** —
every count below was taken on it. Suite counts are **recorded merged-tree
lane evidence, not re-run for this refresh**; the git/publish/server facts
were re-verified read-only this refresh. The trailing `docs:` commits on top
are this record's own refreshes; `main` = `origin/main`, clean, in sync
(0 ahead, 0 behind).

## Current state

| Item | Value |
|---|---|
| Branch / HEAD | `main` = `origin/main`, clean — a docs checkpoint commit on top of the code tree `29861c7` (0 ahead / 0 behind at handoff) |
| Published | **STILL 0.0.2 on `latest` AND `next`** (`npm view` dist-tags re-verified this refresh); tag `v0.0.2` at `354df89` (pushed). **No tag, publish, or version bump this session** — the next release repeats `docs/release.md` and needs fresh explicit owner permission. The GitHub Release *page* for `v0.0.2` remains an owner-manual step (no `gh` CLI on this machine) |
| Session window | started at `c80c855` → `29861c7`: **26 commits** — 19 code-side (15 feature/fix/test/CI plus the 4 checkpoint-docs commits) and 7 docs/infra. Every feature independently accepted in a separate lane; every merge ff-only with merged-tree gates green before push |
| CI | the failure-artifact workflow patch (`ca41be4`) is **production-validated on the green path** — run 44575797591: all 3 legs SUCCESS (ubuntu 22, ubuntu 24, windows 24); the new bash `pipefail`/`tee` and pwsh `Tee-Object`/re-exit steps ran; failure-gated uploads skipped with 0 artifacts. Earlier reds (#120 on docs-only `73c0f5a`, #118 on `4e72e1e`) were Node-22-leg flakes: **not reproduced** in 11 WSL Node-22 runs (22.22.2 + 22.23.5, CI affinity, oversubscribed); mechanism proven locally (awaiting an unref'd timer → `cancelledByParent` → exit 1 with fail 0 on Node 22; Node 24 passes; the repo fixed this class twice before: `e51c54f`, `1079917`). The failure path awaits its first red run. Informational: `actions/checkout@v4` + `setup-node@v4` carry a Node-20 deprecation warning (future micro-bump) |
| Package suite baseline | **2 728 total / 2 720 pass / 0 fail / 8 POSIX-only skips**, Windows, merged tree at `29861c7`, in BOTH `npm test` and `npm run test:spawn` |
| Web / browser / CLI / faults | web **752 / 752 / 0 / 0**; browser E2E **44 PASS / 0 FAIL / 1 SKIP** (run at `31afce6`; zero web/e2e product bytes since, so the exemption is evidence-backed); hermetic CLI E2E **19 + 19** (sources + `--dist`); loopback real-socket fault injection **7/7**; reference selftest PASS + **33/33**; `SMOKE TEST: PASS` |
| WSL Linux parity | at `4e72e1e` (**older tree than the checkpoint** — Ubuntu 24.04, Node v24.16.0): **2 682 total / 2 681 pass / 0 fail / 1 Windows-only skip** in both modes; 7 of the 8 Windows POSIX skips executed and passed (4 mode-bit + 3 symlink-privilege); CLI E2E 19/19 Linux; reference 33/33 |
| Packaging | at `73c0f5a`, Node 24: `npm run check` PASS (pinned + runtime deps; recursive 102-dist-file sweep: only `zod` + `@earendil-works/pi-mcp`); `pack:check` publint "All good!" + attw esm-only green; tarball-smoke **7/7** (416 files / 1.56 MiB / 6.7 MB unpacked; temp-consumer probe: `estimateRoleCost` reachable, 488 runtime exports, `./cli` subpath resolves). On Node 22 (WSL v22.23.5): tarball-smoke **7/7** + `pack:check` PASS — the CI Node-22-only release steps' equivalents. Tarball drift vs the `release.md` 0.0.1-era figures is noted for the next release |
| Live server | **running**, refreshed 2026-11-19 20:46:17 to `29861c7`: `node dist/cli.js serve --port 8600 --sessions-dir sessions` (PID **123368**, cwd `packages/harness`, logs `.tmp/live-serve/`). Verified: `GET /` 200 serving `index-CaN2DC84.js`; `HEAD /` 200 zero-body with `Content-Length` 2728 and headers identical to GET (the HEAD-parity fix proven live — the pre-refresh build returned 404); `/api/sessions` 200 with BOTH preserved sessions (`2026-11-14T16-33-32-134-4176c1`, `2026-11-14T16-39-48-429-066581`, original mtimes); `/api/mcp` 200. Store: `packages/harness/sessions` |
| Packaged web copy | `npm run sync-web` SHA256-identical, 3/3 files (`index.html` `CF98762C…`, `index-CaN2DC84.js` `803A08F9…`, `index-D2yQ4OSc.css` `B1B45303…`) against `web/dist` (lane-recorded aggregate `2A057355…`) |
| Provider keys | re-entered by the owner after the 2026-11-14 incident; that owner task stays closed |

## Shipped since the last checkpoint (`c80c855` → `29861c7`, 26 commits)

Five waves plus checkpoint docs. Every feature was independently accepted
in its own lane before merge; a single merged-tree FAIL blocks the push, as
designed.

**Wave 1 → `25ad359`**

- `dbe5908` **test: prune subsumed and constant-only tests** per the
  meaningfulness audit — −4 tests (one subsumed server-workspaces CRUD test
  plus three internal constant pins). The owner **kept the 6 published-cap
  pins** as contract pins (decision 2026-11-19).
- `eb7ec74` **fix(provider): widen the Gemini tool-schema key whitelist**
  with `anyOf` / `pattern` / `minLength` / `maxLength` / `minimum` /
  `maximum` — pure key filter, function body byte-identical, +3 tests; plus
  `415ca17` docs(backlog) shipped marker.
- `3c3a03b` **feat(usage): per-turn Senior/Junior usage and cache split** —
  `PromptAuditEntry.usage?`, `HarnessResult.usageByRole?`, a display-only
  `call_usage` runtime event after each call, the CLI split block before the
  byte-stable footer, `--json usage_by_role`, print/verbose surfaces;
  +11 tests; additive, protocol untouched.
- `25ad359` **test(e2e): accept the additive `call_usage` frame before
  `tool_started`** — a strict contract-shaped alignment of an over-pinned
  adjacency assertion; unblocked the merged-tree smoke. Whole-repo over-pin
  survey done.

**Wave 2 → `7834514`**

- `7f4f062` **fix(tui): report OSC 52 copy failure** when the terminal
  suppresses it — `TERM=dumb` false-success toast fixed via a throwing
  `writeClipboardSequence` sink; +5 tests; the OSC 52 100 000-character cap
  documented; the copy description wording made honest.
- `44e28be` **feat(usage): per-role usage on run records, web footer/status
  and TUI panel** — `run_end`/`RunRecord usage_by_role` additive plus
  sidecar `call_usage` recovery, old sessions merged-only; web
  `UsageFooter` + `SessionStatusDialog` split with old-backend fail-soft;
  TUI Ctrl+B sidepanel rows; tool-preview browser scenario extended;
  +13 package / +8 web tests. **Documented limitation:** the footer split is
  hidden at the drawer breakpoint ≤768px to protect parked readers;
  `/status` shows it at every width.
- `7834514` **feat(tui): in-app editor for the three global key chords** —
  `/keys edit` dialog: capture through the existing keys-file grammar,
  `resolveTuiCommands` validation, atomic 0600 save, fixed-key /
  other-global / reserved refusals, repeat/IME/paste-safe, honest
  no-file/invalid-file behavior, reset-all row; +27 tests; fixed keys
  unchanged.

**Checkpoint docs → `7cae012`** (4 commits: `ee0d624`, `b2d4a77`,
`cf53419`, `7cae012`).

**Wave 3 → `546a59e`**

- `f099ad2` **fix(server): HEAD static parity** — assets now answer HEAD with
  GET header parity instead of 404; +1 test, wire-verified live (above).
- `734b1d4` **test(tui): `/keys edit` invalid-file refusal at app level** —
  mutation-verified twice (the writer side and the state source were already
  covered).
- `3e1e6d9` **feat(usage): derived cache-miss display + per-role CLI cost** —
  +8/+1 tests; no wire changes.
- `546a59e` docs: keybinding status correction.

**Micro → `4e72e1e`**

- `4e72e1e` **feat(usage): `estimateRoleCost` / `RoleCostInput` public
  exports** + backlog gap line (+1 test; EOF newline fix).

**Docs → `bf191e8`** (preset-windows shipped record; the follow-up was
already shipped in wave 26 `bd9cef6`) and **`73c0f5a`** (13 stale claims
corrected across backlog/design-review, broken sentence repaired,
pre-rebase SHA citation fixed).

**Waves 4–5 → `29861c7`**

- `244978a` + `31afce6` **feat(usage): per-role model identity on
  `usage_by_role` halves + record-only `cost_by_role`** via ONE shared rule
  `estimateRoleCostsFromSplit` (server + TUI cannot disagree; web/TUI
  per-role cost; +15/+4 tests; `call_usage` untouched).
- `93c66d6` + `265990f` **feat(tui): `/fork [--at <seq>] [name]`** with
  switch-to-fork via shared `adoptSession()` (+11 tests; the service reused
  unchanged).
- `ca41be4` **ci: failure-only test-log artifacts** — additive,
  exit-code-preserving, production-validated on the green path (run
  44575797591, 3/3 legs).
- `f96e9ed` + `29861c7` **feat(tui): `/rewind [--turns <n>]`** with
  two-phase destructive confirm (+20 tests; Cancel preselected, zero-byte
  cancel paths, pure dry-run preview, idle re-check, sidecar cleared after
  success with failure disclosed).

### Owner decision artifacts (local-only, gitignored — cite as local)

- `.tmp/test-audit-report.md` — the suite is meaningful overall; the SAFE
  slice executed; a NEEDS-DESIGN bucket (~24–29 tests) is queued: web
  source-string wiring −15…−20 (largest), approval/deny −2, plugins
  endpoint −1, mirror pairs −4, storage pairs −2; total removable 28–39
  (≈1.1–1.5%). **Execute only with the owner's shortlist approval.**
- `.tmp/backlog-triage.md` — 13 stale claims, all corrected; safe queue
  A1/A2/A3 DONE, A4 marginal deferred; 9 owner-gated + 11
  blocked/manual/epic items.
- `.tmp/oauth-design.md` (725 lines) — zero-new-dep; sealed `oauth.json`
  token store; single-flight refresh; `extraHeaders` + `beforeAttempt`
  seams; Codex needs a 4th wire family; 8 slices; 8 owner decisions; first
  slice Kimi sign-in; third-party client identities are a policy blocker.
- `.tmp/keybinding-surfaces-design.md` (892 lines) — co-live-namespace
  conflict model; schema v2 with v1 compatibility; shadowing refused;
  approval panel permanently closed; S1 = transcript read-side chords
  (tool-expand / copy / panel).
- `.tmp/ci-rel/` — Node-22 evidence, probes, and the CI patch validation.

### Verifications closed

Ctrl+G external editor + Ctrl+X copy are **shipped and verified** (149
focused tests, no material docs drift). Preset context windows were already
shipped (wave 26). `CANCELLED_TURN_HINT` verified **non-bug** (the exit
chord is fixed; design note: if exit ever becomes rebindable, derive it and
`QUIT_ARMED_ACTIVITY` from the effective table).

Micro-follow-ups recorded, non-blocking: (a) the `roleIdentity` doc comment
overstates one absence case (`harness.ts`; behavior correct and pinned);
(b) the `/fork` parser usage echo can exceed 320 characters on very long
operator tokens (cosmetic, pure parser); (c) the cli-reference TUI summary
paragraph is non-exhaustive (`/rewind` documented fully elsewhere);
(d) the `/rewind` preview→apply has no CAS against external writers (same
property as the CLI route; the TUI holds the keyboard + idle re-check +
strict atomic re-read); (e) sidecar OS-unlink failure is not hermetically
forceable on Windows (notice composition is covered); (f) the
actions Node-20 deprecation bump; (g) the CI failure-artifact path awaits
its first red run; (h) `.tmp/wt-temp` is an unlisted clone-like directory
(owner hygiene); (i) untracked `tools/AGENTS.md` describes the deleted
Python tree (owner delete/gitignore call).

### Hygiene done this session

Early: 2 verified-merged stale worktrees
(`tb-fix-subagent-model-copy`, `tb-lane-stream-scroll-review`) plus branches,
and 134 probe directories (~23.8 MiB). Final: 18 lane worktrees + 11
branches removed (all `-d`; ancestor/cherry verified; self-referential npm
junctions unlinked before recursive deletes; no `--force`), ~2.43 GiB.
Session total ≈4.5 GiB. **Kept awaiting the owner's disposition:**
`.tmp/worktrees/{release-doc-count 8dfcab5, stream-follow-touch 638f8a4,
stream-scroll-test ec6c998, user-message-nav-acceptance detached 9a96b9d}`
+ `C:/code/tb-lane-touch` (`test-stream-scroll-touch` `dbf0c2f`) — all
UNMERGED. opencode worktrees and `Temp/tb-review-tip` were never touched;
6 junctions inside the kept lanes left as-is.

## In flight

Nothing is in flight on `main` — the tree is clean and fully pushed. The
open owner decisions below gate the next work.

### Unmerged worktrees awaiting the owner's decision (do not remove)

| Worktree | Branch / commit |
|---|---|
| `.tmp/worktrees/release-doc-count` | `docs-release-e2e-count` @ `8dfcab5` |
| `.tmp/worktrees/stream-follow-touch` | `fix-stream-follow-touch-test` @ `638f8a4` |
| `.tmp/worktrees/stream-scroll-test` | `test-stream-scroll` @ `ec6c998` |
| `.tmp/worktrees/user-message-nav-acceptance` | detached @ `9a96b9d` |
| `C:/code/tb-lane-touch` | `test-stream-scroll-touch` @ `dbf0c2f` |

Each needs a merge / abandon / keep call from the owner before it can be
cleaned up. `git worktree list` confirms all five are present.

## Incident / prevention notes (kept)

### Incident (2026-11-14)

An NTFS-junction-traversing cleanup emptied main-checkout
`packages/harness`; tracked files were restored, but untracked `sessions/`
content (sessions, settings incl. sealed keys, sidecars, child logs) was
permanently lost. Keys have since been re-entered and live runs resumed.
**Never point recursive cleanup/delete tools at the repo root, worktree
parents, or any path that can contain NTFS junctions; keep destructive
commands inside one known directory.**

### Session lessons (2026-11-19)

1. **Subagent sandbox policy is fixed at spawn.** Lanes spawned under
   `workspace-write` stayed confined (git/`.git` writes, spawn `EPERM`) even
   after the owner switched the session to `danger-full-access`; only fresh
   spawns inherit the new policy. The confined lanes used local-clone
   fallbacks (accepted; their branches were fetched into the main repo for
   acceptance/merge). An ACL diagnostic ran `NOT_THIS_CLASS` at the repo
   root (report `.tmp/acl-repair/`).
2. **Acceptance briefs must include the hermetic SERVER E2E layer plus the
   smoke gate, not just CLI E2E.** The `call_usage` adjacency over-pin
   slipped through the per-lane gates and was caught by merged-tree smoke —
   one FAIL blocks the push, as designed.
3. **The `TEMP`/`TMP` → `.tmp/build-temp` override is only for standalone
   web builds and `e2e-test.ps1`.** Widening it to package tests or the
   smoke gate flakes `tuiintegration` (see `scripts/AGENTS.md`).
4. **Parallel lanes prepending `CHANGELOG` `[Unreleased]` `Added` bullets
   conflict predictably.** The established resolution is bounded and
   chronological: keep all bullets, then byte-verify against the accepted
   blob.
5. **CI job logs are auth-gated.** The failure-only TAP artifacts
   (`ca41be4`) now capture them; without that, a red run's per-suite counts
   are not retrievable from here.
6. **npm workspace hoisting:** install at the repo root; husky `prepare`
   needs the root level to run.
7. **WSL non-interactive bash lacks the nvm PATH.** Prepend it explicitly —
   otherwise `npm` resolves to the Windows install.

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

# WSL Linux parity pass (older-tree evidence above)
wsl -d Ubuntu-24.04 -- bash -lc 'export PATH=$HOME/.nvm/versions/node/v24.16.0/bin:$PATH; cd /mnt/c/code/two-brothers-harness/packages/harness && npm run typecheck && npm test'
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
  owner words.** 0.0.2 is fully shipped on npm (`latest` = `next`); the
  next release repeats `docs/release.md`.
- No new runtime dependencies without a ledger entry in
  `docs/history/ts-rewrite-plan.md`; `web/` keeps building (Vue 3 +
  naive-ui); `typescript/` stays zero-dependency.
- Conventional Commits for all lane work.
- Independent acceptance before merge (separate lane or owner — never the
  implementer alone).

## Next moves

Per `todo.md`'s owner menu:

1. **Owner decisions:** the NEEDS-DESIGN audit shortlist; the five unmerged
   worktrees (merge/abandon/keep); the GitHub Release page for `v0.0.2`
   (manual — no `gh` CLI on this machine).
2. **OAuth implementation** — design ready (`.tmp/oauth-design.md`); Kimi
   sign-in is the first slice; third-party client identities are a policy
   blocker.
3. **Keybinding-surface expansion** — design ready
   (`.tmp/keybinding-surfaces-design.md`); S1 is the transcript read-side
   chords.
4. **Preset seed window values** — pends an owner decision (it reverses
   the pinned "seeds never invent one" choice).
5. **Next release** — version bump + tag + publish need fresh explicit
   owner words; packaging/CI/WSL evidence is green above.
6. **Triage owner-gated items:** TUI-undo capture policy, the third
   sibling, the models.dev URL override.
7. **Micro hygiene:** `.tmp/wt-temp`, untracked `tools/AGENTS.md`, the
   actions Node-20 deprecation bump; A4 (failed-run error-object split) is
   marginal and available on request.

The deferred register is unchanged (F/D designs, structural candidates
TUI-R/CHAT-R/SET-S/BE-R, hypotheses, WAN/soaks manual, POSIX hardware
validation, the true-virtualization epic, third sibling not on the backlog).

## Handoff checklist

- [ ] Read `AGENTS.md`, `docs/backlog.md`, this file, and `todo.md`.
- [ ] Confirm `git status` clean and `git log -1` is this docs checkpoint
      (its parent chain contains the code tree `29861c7`).
- [ ] Check the background-task panel for running gates/lanes before
      starting new ones (stale-serve writer-lock gotcha above).
- [ ] Run package + web tests and the smoke gate on the merged tree.
- [ ] Rebuild + `sync-web` + restart `serve` before handing back
      (**done this session**: PID 123368, `GET /` 200 bundle
      `index-CaN2DC84.js`, `HEAD /` 200 with GET-parity headers,
      `/api/sessions` 200 with both preserved sessions, sync-web 3/3
      SHA256-identical).
- [ ] Keep `research/`, sessions, credentials, logs out of git (this file
      and `todo.md` are the tracked checkpoint exception).
- [ ] No publish/tag/version bump without explicit owner permission.
