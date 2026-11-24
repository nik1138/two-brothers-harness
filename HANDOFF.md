# Two Brothers — handoff

Local working handoff, tracked as the checkpoint record (owner decision
2026-11-14). The frozen historical snapshot is `docs/history/handoff.md`;
this file is the current state for the next session. The previous refresh
(the `29861c7` checkpoint, `3423788`) is superseded by this one — its full
detail stays in git history; release mechanics and evidence live in
`docs/release.md`.

Last updated: **2026-11-24**. **Checkpoint: `main` = `origin/main` =
`4ddab19`** (a docs checkpoint commit sits on top of the code tree
`4ddab19`). Suite counts below are **recorded merged-tree lane evidence**
from the integration that pushed `4ddab19`; the git/publish facts were
re-verified read-only this refresh. `main` = `origin/main`, clean, in sync.

## Current state

| Item | Value |
|---|---|
| Branch / HEAD | `main` = `origin/main` = `4ddab19`, clean — a docs checkpoint commit on top (0 ahead / 0 behind at handoff) |
| Published | **STILL 0.0.2 on `latest` AND `next`**; tags only `v0.0.1` / `v0.0.2` (`v0.0.2` at `354df89`). **No tag, publish, or version bump this session** — the next release repeats `docs/release.md` and needs fresh explicit owner permission. The GitHub Release *page* for `v0.0.2` remains an owner-manual step (no `gh` CLI) |
| Session window | previous checkpoint `3423788` → `4ddab19`: **11 code commits** (1 CI-actions bump + 10 in the integrated batch). Every feature independently accepted in a separate lane; every merge ff-only with merged-tree gates green before push |
| CI | **FULLY GREEN on all 3 legs** — run [45483813227](https://github.com/nik1138/two-brothers-harness/actions/runs/45483813227) at `4ddab19`: `harness (22)`, `harness (24)`, `harness-windows` all SUCCESS. First fully-green run since the `/rewind` wave. The actions are now `checkout@v7` / `setup-node@v7` / `upload-artifact@v7` (node24; the Node-20 deprecation is resolved). The failure-artifact pipeline (`ca41be4`) is **proven end-to-end**: it captured the red runs' TAPs, and the owner authorized read-only credential use to download them (`.tmp/ci-artifacts/`) |
| Package suite baseline | **2 756 total / 2 747 pass / 0 fail / 9 POSIX-only skips**, Windows, merged tree at `4ddab19`, in BOTH `npm test` and `npm run test:spawn` |
| WSL Linux parity | at `4ddab19` (Ubuntu 24.04, Node v22.23.5): `npm test` **3/3 exit 0**, **2 756 / 2 755 pass / 0 fail / 1 Windows-only skip** each, **zero** `generated asynchronous activity` / `parser.deref` hits (the H1 discriminator). Node-24 WSL also green |
| Web / browser / CLI / faults | web **753 / 753 / 0 / 0**; browser E2E **44 PASS / 0 FAIL / 1 SKIP**; hermetic CLI E2E **19 + 19** (sources + `--dist`); loopback real-socket fault injection **7/7**; reference selftest PASS; `SMOKE TEST: PASS` |
| Packaging | last full packaging pass at `73c0f5a` (Node 24 + Node 22 WSL): `check` / `pack:check` / tarball-smoke **7/7** (416 files / 1.56 MiB; `estimateRoleCost` reachable, 488 exports). No packaging-affecting bytes since except test/view/CI changes — re-measure at the next release |
| Live server | last refreshed 2026-11-19 to `29861c7` (PID 123368, `serve --port 8600 --sessions-dir sessions`, store `packages/harness/sessions`, both preserved sessions). **Not re-verified or refreshed this continuation** — a refresh to `4ddab19` (rebuild + `sync-web` + restart) is a pending owner-side step; do not assume the old PID is still live |
| Provider keys | re-entered by the owner after the 2026-11-14 incident; that owner task stays closed |

## Shipped since the last checkpoint (`3423788` → `4ddab19`, 11 commits)

Every feature was independently accepted in its own lane before merge; a
single merged-tree FAIL blocks the push, as designed — and this session the
merged-tree gate **caught a real cross-lane defect** (below) before push.

**CI maintenance → `ef8c2eb`**

- `ef8c2eb` **ci: bump GitHub Actions to node24-based majors** —
  `checkout`/`setup-node`/`upload-artifact` v4→v7 in `ci.yml` + `publish.yml`
  (exactly 8 `uses:` lines; acceptance proved byte-identity otherwise,
  upstream `action.yml` node24 confirmed, publish OIDC pattern safe).

**Integrated batch → `4ddab19`** (10 commits, one push, full merged-tree gates)

- `a0d666d` **test: cover uncovered refusal/recovery branches** — +8
  mutation-verified hermetic tests across `/rewind`, `/fork`, `/keys edit`,
  `estimateRoleCostsFromSplit` (incl. a POSIX-gated 0600-mode test that runs
  on CI's ubuntu legs).
- `f145539` **docs: correct shipped-status claims in backlog open items** —
  the wave-19 "in-TUI editor and hot reload" stale clause fixed; three
  self-declared-shipped bullets moved out of "Open items (deferred)"
  (byte-identical bodies, ancestry-verified).
- `a4d8ed9` **fix(web): keep transcript message actions reachable on touch**
  — `@media (hover: none)` re-enables `.bubble-actions` (reusing the repo's
  own `SessionRow.vue` rule); the mobile browser scenario now asserts
  tap-copy without hover; +1 web test (752→753).
- `6c38389` **fix(tui): bound TUI notices so the actionable tail stays
  visible** — toast sink bound (320 chars, head+tail), `/fork`//`rewind`
  parser usage echoes bounded head+tail so `— usage: …` survives the
  top-crop; `/rewind` help string now states `--turns <n>`.
- `24d3944` **feat(tui): mark a parked transcript with the rows hidden
  below** — a "⋯ n more" gutter mark (cell-for-cell swap, label-row-safe,
  NO_COLOR-safe); followed state byte-identical.
- `98c2c1e` **perf(tui): memoize transcript row wrapping + drop the duplicate
  scroll pass** — `WeakMap` keyed on blocks identity + every render option;
  warm frame **~295×** faster and PgUp **~475×** at 250 turns (independent
  acceptance spot-check); cache-key completeness audited.
- `4ff737c` **fix(tui): keep long fork/rewind outcome notices whole in the
  transcript** — removed the pre-existing composition-time bound wrappers
  (the transcript now keeps every notice whole; the display bound lives at
  the toast sink); `baseNotice` paints the transcript before toasting only
  for >320-char notices. **This fixed the cross-lane defect** the
  merged-tree gate caught: `6c38389`'s head+tail elision had sliced the
  sidecar-disclosure clause out of a long outcome notice, failing the
  coverage lane's `:1091` contract.
- `e2dba32` **test: close stub-server connections so no parser timer
  outlives the suite** — loopback stubs send `Connection: close` + tear down
  `closeAllConnections → close → await 'close'` (SSE disconnect-retry heads
  deliberately keep keep-alive). Fixes CI mechanism **H1**.
- `0d28e07` **test: match wrapped outside-store refusal notices by squeezed
  text** — whitespace-collapsed matching keeps the full path discriminating
  while surviving the 80-col mid-path hard-wrap; outside-store durations
  **4 340 ms → ~345 ms**. Fixes the **Windows** CI reds.
- `4ddab19` **test: make keys-watch debounce coalescing deterministic under
  load** — both writes provably inside one window, different-size documents,
  still asserts exactly one coalesced reload. Fixes the **spawned-mode** red.

### The three CI failure mechanisms (root-caused + fixed)

The red runs since the `/rewind` wave were **three independent defects**,
identified from the downloaded failure TAPs (`.tmp/ci-artifacts/`) and a
deterministic WSL repro (`.tmp/ci-flake2/`):

1. **H1 — ubuntu Node-22 in-process** (`fail 0`, exit 1, late
   uncaughtException): undici's `onParserTimeout` derefs a WeakRef-held
   parser without a null check; keep-alive stub sockets left parser timers
   that fired after GC. Reproduced 4/4 on WSL Node-22; fixed by `e2dba32`
   (5/5 green after). **Distinct** from the two previously fixed unref'd-
   timer classes (`e51c54f`, `1079917`).
2. **Windows in-process** (real `fail 1`): the outside-store refusal notice
   embeds a long absolute temp path that hard-wraps mid-path at 80 cols, so
   the contiguous-substring assertion only matched after a ~4.1 s re-render,
   past the 5 s `waitFor` budget on the slow runner. Fixed by `0d28e07`.
3. **ubuntu Node-22 spawned** (real `fail 1`): the keys-watch debounce
   exact-count assertion raced under per-file-child load. Fixed by `4ddab19`.

### Owner decision artifacts (local-only, gitignored — cite as local)

- `.tmp/improvement-candidates.md` (522 lines) — discovery report: top-5
  SAFE candidates A1–A5 (**all now shipped**), Task B verdicts (B1 CAS
  IMPLEMENT — in flight; B2 fork echo — shipped; A4 failed-run split — LEAVE;
  B4 `tools/AGENTS.md` — deleted; B5 `.tmp/wt-temp` — owner kept), Task C
  backlog nits C1/C2 (shipped). A6 (CLI write paths bypass the advisory
  writer lock), A7 (mouse-wheel), A8 (Home/End key), A9 (`res.json()`) remain
  owner-gated/negligible.
- `.tmp/web-wiring-consolidation-design.md` (789 lines) — **NEW** design for
  the largest NEEDS-DESIGN audit bucket: 43 source-reading test blocks in 17
  files, **40 protect genuine contracts** (the issue is evidence type, not
  fake coverage); 9 ordered slices, net −17 → 735 tests, 26 replacements;
  owner decisions **D1–D9** (browser E2E as coverage home, copy exactness,
  section order, absence contracts, test type-checking, the `runUsage.ts`
  extraction, stop point). **No implementation without owner approval.**
- `.tmp/test-audit-report.md`, `.tmp/backlog-triage.md`, `.tmp/oauth-design.md`
  (725 lines), `.tmp/keybinding-surfaces-design.md` (892 lines) — unchanged
  from the prior checkpoint; still owner-gated.
- `.tmp/ci-artifacts/`, `.tmp/ci-flake2/`, `.tmp/ci-stub-fix-evidence/`,
  `.tmp/accept-stub-fix-evidence/`, `.tmp/merged-gates-final/` — CI evidence
  and merged-tree gate logs.

### Micro-follow-ups (non-blocking)

- (a) `/rewind` preview→apply CAS — **in flight** (`agents-rewind-cas`, B1).
- (b) Three head+tail bound helpers (`boundToastText`, `boundForkNotice`,
  `boundRewindNotice`) are copies of one 4-line algorithm — a shared helper
  would dedupe (safe simplification; touches `app.ts`, so serialize after
  CAS).
- (c) The notice bound is char-based, not display-width-based: 320 CJK chars
  would wrap to ~11 rows rather than 6 (pre-existing property; practical
  content is ASCII paths/usage).
- (d) `boundToastText` doc comment says "6 label" but the widest label
  (`SUCCESS`) is 9 cols; the 6-row conclusion is unchanged (comment nit).
- (e) Sidecar OS-unlink failure is not hermetically forceable on Windows
  (notice composition covered).
- (f) `.tmp/wt-temp` — owner chose to KEEP (leftover node compile-cache, not
  a worktree; the old "clone-like" label was wrong).

### Hygiene this session

- `tools/AGENTS.md` (untracked, ignored, described the deleted Python tree)
  **deleted** with owner approval. `.tmp/wt-temp` **kept** (owner choice).
- A hygiene lane is removing this session's verified-merged lane worktrees +
  branches (junction-guarded, `-d` only); the protected keep-set below is
  untouched.

## In flight

- `agents-rewind-cas` — /rewind CAS hardening (B1), implementation lane.
- `hygiene-final` — merged lane workspace cleanup.

### Unmerged worktrees awaiting the owner's decision (do not remove)

| Worktree | Branch / commit |
|---|---|
| `.tmp/worktrees/release-doc-count` | `docs-release-e2e-count` @ `8dfcab5` |
| `.tmp/worktrees/stream-follow-touch` | `fix-stream-follow-touch-test` @ `638f8a4` |
| `.tmp/worktrees/stream-scroll-test` | `test-stream-scroll` @ `ec6c998` |
| `.tmp/worktrees/user-message-nav-acceptance` | detached @ `9a96b9d` |
| `C:/code/tb-lane-touch` | `test-stream-scroll-touch` @ `dbf0c2f` |

Each needs a merge / abandon / keep call from the owner. opencode-owned
worktrees (incl. `agents-depth3` @ `7b1d80f`, fully merged but opencode-
owned) and `Temp/tb-review-tip` are never touched.

## Incident / prevention notes (kept)

### Incident (2026-11-14)

An NTFS-junction-traversing cleanup emptied main-checkout
`packages/harness`; tracked files were restored, but untracked `sessions/`
content was permanently lost. Keys have since been re-entered. **Never point
recursive cleanup/delete tools at the repo root, worktree parents, or any
path that can contain NTFS junctions; keep destructive commands inside one
known directory.**

### Session lessons (2026-11-24)

1. **The merged-tree gate catches cross-lane defects.** Two independently
   accepted lanes interacted badly (notice head+tail elision × the coverage
   disclosure contract); only the merged tree failed. Acceptance per-lane is
   necessary but not sufficient — keep the full merged-tree matrix before
   push.
2. **`web/` is NOT an npm workspace** (`workspaces: ["packages/*"]`). A
   fresh worktree has no `web/node_modules`; smoke's `vue-tsc` needs
   `npm install` in `web/` separately.
3. **CI failure artifacts need auth to download.** The owner approved
   read-only use of the stored git credential (`git credential fill`,
   `GCM_INTERACTIVE=Never`/`GIT_TERMINAL_PROMPT=0`, token never
   printed/persisted) to GET artifacts/job logs on the owner's own repo.
4. **The undici keep-alive flake is a distinct mechanism** from the prior
   unref'd-timer classes: full-length suite, `fail 0`, late
   `parser.deref` uncaughtException. Stub teardown must
   `closeAllConnections`; SSE disconnect-retry tests must keep keep-alive.
5. **Subagent sandbox policy is fixed at spawn**; fresh spawns inherit the
   current policy (`danger-full-access` this session).
6. **Acceptance briefs include the hermetic SERVER E2E + smoke**, not just
   CLI E2E.
7. **`TEMP`/`TMP` → `.tmp/build-temp` only for standalone web builds +
   `e2e-test.ps1`**; widening it flakes `tuiintegration`.
8. **Parallel CHANGELOG `[Unreleased]` bullets conflict predictably**;
   bounded chronological resolution, byte-verified against accepted blobs.
9. **npm workspace hoisting**: install at the repo root. **WSL
   non-interactive bash lacks the nvm PATH** — prepend it; `bash -lc`
   mangles quoted/PATH strings, use an LF script via `wsl -- bash /mnt/c/...`.

## Commands / verification

Use Windows PowerShell (not `pwsh`; it is not installed):

```powershell
cd C:\code\two-brothers-harness
cd packages/harness
npm run typecheck
npm test                     # and: npm run test:spawn
npm run build
cd ..\..\web
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

Web-build gates on Windows need `TEMP`/`TMP` inside the checkout
(`.tmp/build-temp`). Do not run the live server and the smoke gate against
the same sessions dir at the same time (writer lock).

## Constraints / owner decisions

- The brothers are peers with one shared context; subagents are a helper
  tier below them, never protocol peers.
- `PROTOCOL.md` byte-stable markers unchanged; runtime events/web types
  stay additive.
- **Pushing `main` is approved.** **No tag, publish, or version bump without
  fresh explicit owner words.** 0.0.2 is fully shipped on npm
  (`latest` = `next`); the next release repeats `docs/release.md`.
- No new runtime dependencies without a ledger entry; `web/` keeps building
  (Vue 3 + naive-ui); `typescript/` stays zero-dependency.
- Conventional Commits; independent acceptance before merge (never the
  implementer alone).

## Next moves

Per `todo.md`'s owner menu:

1. **Owner decisions:** the web-wiring consolidation design (D1–D9) and the
   broader NEEDS-DESIGN audit shortlist; the five unmerged worktrees; the
   GitHub Release page for `v0.0.2` (manual).
2. **OAuth implementation** — design ready; Kimi sign-in first slice;
   third-party client identities are a policy blocker.
3. **Keybinding-surface expansion** — design ready; S1 = transcript
   read-side chords.
4. **Preset seed window values** — reverses a pinned choice; product call.
5. **Next release** — bump + tag + publish need fresh explicit owner words;
   packaging/CI/WSL evidence is green.
6. **Triage owner-gated items:** TUI-undo capture policy, third sibling,
   models.dev URL override; discovery A6–A9.
7. **Remaining SAFE micro:** the bound-helper dedupe (after CAS), the
   label-width comment nit; A4 failed-run split is marginal (LEAVE per
   discovery unless an embedding consumer needs it).

## Handoff checklist

- [ ] Read `AGENTS.md`, `docs/backlog.md`, this file, and `todo.md`.
- [ ] Confirm `git status` clean and `git log -1` is this docs checkpoint
      (parent chain contains `4ddab19`).
- [ ] Check the background-task panel for running gates/lanes before
      starting new ones (stale-serve writer-lock gotcha).
- [ ] Run package + web tests and the smoke gate on the merged tree.
- [ ] Rebuild + `sync-web` + restart `serve` to `4ddab19` before handing
      back (pending this continuation).
- [ ] Keep `research/`, sessions, credentials, logs out of git (this file
      and `todo.md` are the tracked checkpoint exception).
- [ ] No publish/tag/version bump without explicit owner permission.