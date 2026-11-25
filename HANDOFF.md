# Two Brothers — handoff

Local working handoff, tracked as the checkpoint record (owner decision
2026-11-14). The frozen historical snapshot is `docs/history/handoff.md`;
this file is the current state for the next session. The previous refresh
(the `29861c7` checkpoint, `3423788`) is superseded by this one — its full
detail stays in git history; release mechanics and evidence live in
`docs/release.md`.

Last updated: **2026-11-25**. **Checkpoint: `main` = `origin/main` =
`b1fc2c5`** (a docs checkpoint commit sits on top). Suite counts are
**recorded merged-tree lane evidence**; git/publish/CI/server facts were
re-verified read-only this refresh. `main` = `origin/main`, clean, in sync.

## Current state

| Item | Value |
|---|---|
| Branch / HEAD | `main` = `origin/main` = `b1fc2c5`, clean — a docs checkpoint commit on top (0 ahead / 0 behind at handoff) |
| Published | **STILL 0.0.2 on `latest` AND `next`**; tags only `v0.0.1` / `v0.0.2` (`v0.0.2` at `354df89`). **No tag, publish, or version bump this session** — the next release repeats `docs/release.md` and needs fresh explicit owner permission. The GitHub Release *page* for `v0.0.2` remains an owner-manual step (no `gh` CLI) |
| Session window | previous checkpoint `3423788` → `b1fc2c5`: **15 code commits** + checkpoint docs. Every feature independently accepted in a separate lane; every merge ff-only with merged-tree gates green before push |
| CI | **FULLY GREEN on all 3 legs**, repeatedly. Latest at `b1fc2c5`: run [45528544514](https://github.com/nik1138/two-brothers-harness/actions/runs/45528544514) — `harness (22/24)` + `harness-windows` all SUCCESS, **and the new "Dependency checks" step succeeded in every job**. Actions are node24 majors (`checkout`/`setup-node`/`upload-artifact` @v7). `npm run check` (pinned + recursive runtime-deps) is now wired into CI. The failure-artifact pipeline (`ca41be4`) is proven end-to-end (captured red runs' TAPs; owner authorized read-only credential download → `.tmp/ci-artifacts/`) |
| Package suite baseline | **2 760 total / 2 751 pass / 0 fail / 9 POSIX-only skips**, Windows, merged tree at `b1fc2c5`, in BOTH `npm test` and `npm run test:spawn` |
| WSL Linux parity | at `4ddab19` (Ubuntu 24.04, Node v22.23.5): `npm test` **3/3 exit 0**, 2 756 / 2 755 / 0 / 1, zero `parser.deref` hits (the H1 discriminator). Later trees' ubuntu-22 CI legs green |
| Web / browser / CLI / faults | web **753 / 753**; browser E2E **44 PASS / 0 FAIL / 1 SKIP**; CLI E2E **19 + 19**; faults **7/7**; reference selftest PASS; `SMOKE TEST: PASS` |
| Packaging | re-verified at `8baae35` (Node 24 + Node 22 WSL): `check` PASS (recursive **105 dist files**, only `zod` + `@earendil-works/pi-mcp`); `pack:check` publint "All good!" + attw esm-only green; tarball-smoke **7/7**. Tarball **428 files / 1.66 MB packed / 6.77 MB unpacked**; temp-consumer probe **489 exports**, `estimateRoleCost` reachable, `./cli` subpath resolves. **Drift:** `docs/release.md` L157 still carries 0.0.1-era figures (368 files / 1.28 MB / 5.17 MB) — refresh at the next release |
| Live server | **running**, refreshed 2026-11-25 to `8baae35` (product-current; `7f472d0`/`b1fc2c5` are scripts/CI-only): `node dist/cli.js serve --port 8600 --sessions-dir sessions`, **PID 18708**, cwd `packages/harness`, logs `.tmp/live-serve/`. `GET /` 200 bundle `index-Baw0tops.js`; `HEAD /` 200 zero-body CL 2728 with GET-parity headers; `/api/sessions` 200 with BOTH preserved sessions (`2026-11-14T16-33-32-134-4176c1`, `2026-11-14T16-39-48-429-066581`, mtimes byte-identical); `/api/mcp` 200; sync-web 3/3 SHA256-identical. Old PID 123368 was dead; its stale writer lock auto-reclaimed. Store: `packages/harness/sessions` |
| Provider keys | re-entered by the owner after the 2026-11-14 incident; closed |

## Shipped since the last checkpoint (`3423788` → `b1fc2c5`, 15 code commits)

Every feature independently accepted in its own lane; a single merged-tree
FAIL blocks the push — and this session the merged-tree gate **caught a real
cross-lane defect** (notice elision × the disclosure contract) before push.

**CI maintenance → `ef8c2eb`**
- `ef8c2eb` **ci: bump GitHub Actions to node24-based majors** (8 `uses:`
  lines v4→v7; byte-identity otherwise; publish OIDC pattern safe).

**Integrated batch → `4ddab19`** (10 commits, one push)
- `a0d666d` **test:** +8 mutation-verified refusal/recovery tests
  (`/rewind`, `/fork`, `/keys edit`, `estimateRoleCostsFromSplit`; incl. a
  POSIX 0600-mode test that runs on CI ubuntu).
- `f145539` **docs:** backlog shipped-status corrections (wave-19 stale
  clause; three shipped bullets moved out of "Open items", byte-identical).
- `a4d8ed9` **fix(web):** message actions reachable on touch
  (`@media (hover:none)`, reusing the SessionRow rule; mobile e2e tap-copy;
  web 752→753).
- `6c38389` **fix(tui):** bound TUI notices (toast sink 320 head+tail;
  `/fork`//`rewind` usage echoes bounded; `/rewind` help states `--turns`).
- `24d3944` **feat(tui):** parked-transcript "⋯ n more" gutter mark
  (cell-swap, label-row-safe, NO_COLOR-safe; followed state byte-identical).
- `98c2c1e` **perf(tui):** memoize transcript row wrapping + drop duplicate
  scroll pass (WeakMap keyed on blocks + every render option; **~295× warm
  frame / ~475× PgUp at 250 turns**; cache-key completeness audited).
- `4ff737c` **fix(tui):** keep long fork/rewind outcome notices WHOLE in the
  transcript (removed composition-time bound wrappers; display bound at the
  toast sink; `baseNotice` paints transcript before toasting >320-char
  notices). **Fixed the cross-lane defect** the merged-tree gate caught.
- `e2dba32` **test:** stub `Connection: close` + `closeAllConnections`
  teardown (SSE disconnect-retry heads keep keep-alive) — CI mechanism **H1**.
- `0d28e07` **test:** squeezed-text matching for wrapped outside-store
  refusal notices (full path still discriminating; **4 340 ms → ~345 ms**) —
  the **Windows** CI reds.
- `4ddab19` **test:** deterministic keys-watch debounce coalescing (both
  writes provably in one window; still asserts exactly one reload) — the
  **spawned-mode** red.

**Follow-up slices (each accepted + merged + CI green)**
- `e0230df` **fix(tui):** `/rewind` CAS — refuse when the session changed
  during confirmation (shared `sessionFileSignature` helper; server 409 path
  byte-identical; zero-byte refusal; +3 tests). Discovery B1.
- `8baae35` **refactor(tui):** share one head-and-tail notice bound
  (`noticebound.ts`; three wrappers; byte-identity proven over 6 928
  comparisons; +1 equivalence test; geometry comment corrected).
- `7f472d0` **fix(scripts):** recursive runtime-deps scan (54→105 dist files;
  allowlist unchanged; fixture proves a nested undeclared import is now
  caught).
- `b1fc2c5` **ci:** run the dependency-checks gate in CI (a "Dependency
  checks" step after Build in both jobs; validated green in all 3 CI jobs).

### The three CI failure mechanisms (root-caused + fixed)

Identified from downloaded failure TAPs (`.tmp/ci-artifacts/`) + a
deterministic WSL repro (`.tmp/ci-flake2/`):
1. **H1 — ubuntu Node-22 in-process** (`fail 0`, exit 1): undici
   `onParserTimeout` derefs a WeakRef-held parser without a null check;
   keep-alive stub sockets left parser timers firing after GC. Reproduced
   4/4; fixed by `e2dba32` (5/5 green). Distinct from the prior unref'd-timer
   classes (`e51c54f`, `1079917`).
2. **Windows in-process** (real `fail 1`): outside-store refusal notice
   hard-wraps mid-path at 80 cols; the contiguous substring only matched
   after a ~4.1 s re-render, past the 5 s budget. Fixed by `0d28e07`.
3. **ubuntu Node-22 spawned** (real `fail 1`): keys-watch debounce
   exact-count raced under load. Fixed by `4ddab19`.

### Owner decision artifacts (local-only, gitignored — cite as local)

- `.tmp/improvement-candidates.md` — discovery: A1–A5 **all shipped**; B1 CAS
  **shipped**; B2 fork echo **shipped**; A4 failed-run split **LEAVE**; B4
  `tools/AGENTS.md` **deleted**; B5 `.tmp/wt-temp` **kept**; C1/C2 **shipped**.
  A6 (CLI write paths bypass the advisory writer lock), A7 (mouse-wheel),
  A8 (Home/End key), A9 (`res.json()`) remain owner-gated/negligible.
- `.tmp/web-wiring-consolidation-design.md` (789 lines) — 43 source-reading
  blocks, **40 genuine contracts**, 9 slices, net −17 → 735 tests; owner
  decisions **D1–D9**. No implementation without approval.
- `.tmp/test-audit-report.md`, `.tmp/backlog-triage.md`, `.tmp/oauth-design.md`
  (725 lines), `.tmp/keybinding-surfaces-design.md` (892 lines) — unchanged;
  owner-gated.
- `.tmp/ci-artifacts/`, `.tmp/ci-flake2/`, `.tmp/ci-stub-fix-evidence/`,
  `.tmp/accept-stub-fix-evidence/`, `.tmp/merged-gates-final/` — CI + gate
  evidence.

### Micro-follow-ups (non-blocking)

- (a) The notice bound is char-based, not display-width-based: 320 CJK chars
  wrap to ~11 rows rather than 6 (pre-existing; practical content is ASCII).
- (b) `docs/release.md` L157 tarball figures are 0.0.1-era — refresh at the
  next release (now 428 files / 1.66 MB / 6.77 MB).
- (c) Sidecar OS-unlink failure not hermetically forceable on Windows
  (notice composition covered).
- (d) `.tmp/wt-temp` — owner chose to KEEP (leftover compile-cache).

### Hygiene this session

- `tools/AGENTS.md` (untracked, ignored, described the deleted Python tree)
  **deleted** with owner approval; `.tmp/wt-temp` **kept**.
- Merged lane worktrees + branches removed in three passes (junction-guarded,
  `-d`/cherry-evidence `-D` only): ≈1.93 GiB + 586.7 MiB + 541.7 MiB —
  **≈3.0 GiB** total. Keep-set intact throughout; only `agents-depth3`
  (opencode-owned) remains among `agents-*` branches.

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

Each needs a merge / abandon / keep call. opencode-owned worktrees (incl.
`agents-depth3` @ `7b1d80f`, fully merged but opencode-owned) and
`Temp/tb-review-tip` are never touched.

## Incident / prevention notes (kept)

### Incident (2026-11-14)

An NTFS-junction-traversing cleanup emptied main-checkout
`packages/harness`; tracked files restored, untracked `sessions/` content
permanently lost. Keys re-entered. **Never point recursive cleanup/delete
tools at the repo root, worktree parents, or any path that can contain NTFS
junctions; keep destructive commands inside one known directory.**

### Session lessons (2026-11-25)

1. **The merged-tree gate catches cross-lane defects** — per-lane acceptance
   is necessary but not sufficient; keep the full merged-tree matrix before
   push.
2. **`web/` is NOT an npm workspace** — a fresh worktree needs `npm install`
   in `web/` for smoke's `vue-tsc`.
3. **CI failure artifacts need auth to download** — owner-approved read-only
   stored-credential use (`git credential fill`, `GCM_INTERACTIVE=Never`/
   `GIT_TERMINAL_PROMPT=0`, token never printed/persisted).
4. **The undici keep-alive flake is distinct** from the prior unref'd-timer
   classes (full-length suite, `fail 0`, late `parser.deref`). Stub teardown
   must `closeAllConnections`; SSE disconnect-retry tests keep keep-alive.
5. **`npm run check` was local-only** — now wired into CI (`b1fc2c5`); the
   runtime-deps scan is recursive (`7f472d0`, 105 files).
6. **Acceptance briefs include server E2E + smoke**, not just CLI E2E.
7. **`TEMP`/`TMP` → `.tmp/build-temp` only for web builds + `e2e-test.ps1`**;
   smoke/package tests use AMBIENT TEMP (clearing TEMP sends dirs to
   `C:\WINDOWS\temp` and flakes the 4 s-toast timing case).
8. **Parallel CHANGELOG bullets conflict predictably** — bounded
   chronological resolution, byte-verified against accepted blobs.
9. **npm hoisting**: install at root. **WSL bash lacks nvm PATH** — prepend;
   `bash -lc` mangles quotes, use an LF script via `wsl -- bash /mnt/c/...`.
10. **A "failed before it finished" subagent notice can be premature** —
    verify git/CI state before replacing a lane (the CI-dep-check integration
    had already merged + pushed; only its CI-watch report was lost).

## Commands / verification

Use Windows PowerShell (not `pwsh`):

```powershell
cd C:\code\two-brothers-harness
cd packages/harness
npm run typecheck
npm test                     # and: npm run test:spawn
npm run build
cd ..\..
npm run check                # pinned + recursive runtime-deps (now in CI too)
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

1. **Owner decisions:** web-wiring consolidation (D1–D9) + the broader
   NEEDS-DESIGN audit shortlist; the five unmerged worktrees; the GitHub
   Release page for `v0.0.2` (manual).
2. **OAuth implementation** — design ready; Kimi sign-in first slice;
   third-party client identities are a policy blocker.
3. **Keybinding-surface expansion** — design ready; S1 = transcript
   read-side chords.
4. **Preset seed window values** — reverses a pinned choice; product call.
5. **Next release** — bump + tag + publish need fresh explicit owner words;
   packaging/CI/WSL evidence green; refresh `release.md` tarball figures.
6. **Triage owner-gated items:** TUI-undo capture policy, third sibling,
   models.dev URL override; discovery A6–A9.

The safe autonomous queue is **exhausted** — everything remaining is
owner-gated. The deferred register is unchanged (F/D designs, structural
candidates, hypotheses, WAN/soaks manual, POSIX hardware validation, the
true-virtualization epic, third sibling not on the backlog).

## Handoff checklist

- [ ] Read `AGENTS.md`, `docs/backlog.md`, this file, and `todo.md`.
- [ ] Confirm `git status` clean and `git log -1` is this docs checkpoint
      (parent chain contains `b1fc2c5`).
- [ ] Check the background-task panel for running gates/lanes (stale-serve
      writer-lock gotcha).
- [ ] Run package + web tests and the smoke gate on the merged tree.
- [ ] Live serve is at `8baae35` (product-current); rebuild + `sync-web` +
      restart only if product bytes change again.
- [ ] Keep `research/`, sessions, credentials, logs out of git (this file +
      `todo.md` are the tracked checkpoint exception).
- [ ] No publish/tag/version bump without explicit owner permission.