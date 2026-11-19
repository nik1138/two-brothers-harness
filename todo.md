# Two Brothers — working TODO (what is left)

Local working plan, tracked as the checkpoint record alongside `HANDOFF.md`
(owner decision 2026-11-14). Landed work is **not** listed here — see
`HANDOFF.md`, `docs/backlog.md`, `docs/release.md`, and the git log. The
2026-11-14 risk-ranked findings queue is fully resolved (every finding
INTEGRATED or DEFERRED); its full table stays in git history, and the
deferral register is condensed below.

Last updated: **2026-11-19**.

## Current state

- `main` = `origin/main`, clean — a docs checkpoint commit on top of the
  code tree `29861c7`; **pushed and in sync** (0 ahead / 0 behind).
- **0.0.2 shipped**: tag `v0.0.2` at `354df89`; `npm view` dist-tags
  re-verified this refresh — `latest` = `next` = **0.0.2**. **No tag,
  publish, or version bump this session** — the next release repeats
  `docs/release.md` and needs fresh explicit owner permission. The GitHub
  Release *page* remains the one owner-manual step (below).
- Live server refreshed 2026-11-19 20:46:17 to `29861c7`: PID **123368**,
  `node dist/cli.js serve --port 8600 --sessions-dir sessions` (cwd
  `packages/harness`, logs `.tmp/live-serve/`); `GET /` 200 with
  `index-CaN2DC84.js`; `HEAD /` 200 zero-body with GET header parity
  (`Content-Length` 2728 — the pre-refresh build returned 404);
  `/api/sessions` 200 with both preserved sessions; `/api/mcp` 200;
  `sync-web` 3/3 files SHA256-identical. Store:
  `packages/harness/sessions`.
- Baselines at `29861c7` (Windows, merged tree, **recorded lane evidence —
  not re-run for this refresh**): package **2 728 / 2 720 pass / 0 fail /
  8 POSIX-only skips** in BOTH `npm test` and `test:spawn`; web
  **752 / 752 / 0 / 0**; browser E2E **44 PASS / 0 FAIL / 1 SKIP** (run at
  `31afce6`; zero web/e2e product bytes since); hermetic CLI E2E
  **19 + 19**; real-socket faults **7/7**; reference selftest PASS +
  **33/33**; `SMOKE TEST: PASS`.
- WSL Linux parity at `4e72e1e` (**older tree — label it**; Ubuntu 24.04,
  Node v24.16.0): **2 682 / 2 681 pass / 0 fail / 1 Windows-only skip** in
  both modes; 7 of the 8 Windows POSIX skips executed and passed; CLI E2E
  19/19; reference 33/33.
- Packaging at `73c0f5a` (Node 24): `npm run check` PASS (102-dist-file
  sweep: only `zod` + `@earendil-works/pi-mcp`); `pack:check` publint +
  attw esm-only green; tarball-smoke **7/7** (416 files / 1.56 MiB / 6.7 MB
  unpacked; `estimateRoleCost` reachable, 488 runtime exports, `./cli`
  subpath resolves). Node 22 (WSL v22.23.5): tarball-smoke 7/7 +
  `pack:check` PASS.
- This session shipped **26 commits** (`c80c855` → `29861c7`; 19 code-side
  — 15 feature/fix/test/CI plus 4 checkpoint docs — and 7 docs/infra) in
  five waves: Gemini schema whitelist, per-turn + per-role usage with cache
  split, per-role model identity + `cost_by_role`, the OSC 52 copy fix,
  `/keys edit`, HEAD static parity, `/fork`, `/rewind`, the CI
  failure-artifact patch, the E2E over-pin alignment, a −4 test prune, and
  four stale-claim corrections. Details in `HANDOFF.md`.

## In flight

Nothing is in flight on `main` — no code is mid-landing and the tree is
fully pushed. What sits open is owner-gated:

- [ ] **Test-meaningfulness audit — NEEDS-DESIGN bucket.** Report
      `.tmp/test-audit-report.md`: the suite is meaningful overall (no
      duplicate suites, no mock-verifies-itself clusters; apparent
      duplication is deliberate layering). The SAFE slice executed (−4);
      the owner KEPT the 6 published-cap contract pins. Queued needs-design
      work (~24–29 tests): web source-string wiring consolidation largest
      (−15…−20; only CI wiring coverage exists because browser E2E is
      opt-in, so consolidate/replace, never blind-delete); approval/deny
      overlap −2 with one unique artifact case to relocate; plugins
      endpoint −1; four mirror pairs −4 table-driven; storage-failure
      pairs −2. Estimated removable total 28–39 (~1.1–1.5%) if web wiring
      is accepted. **Execute only with the owner's shortlist approval.**
- [ ] **OAuth implementation** — design ready (`.tmp/oauth-design.md`, 725
      lines): zero-new-dep, sealed `oauth.json` store, single-flight
      refresh, `extraHeaders` + `beforeAttempt` seams, 8 slices, 8 owner
      decisions; Codex needs a 4th wire family; third-party client
      identities are a policy blocker. First slice: Kimi sign-in.
- [ ] **Keybinding-surface expansion** — design ready
      (`.tmp/keybinding-surfaces-design.md`, 892 lines): co-live-namespace
      conflict model, schema v2 with v1 compatibility, shadowing refused,
      approval panel permanently closed; S1 = transcript read-side chords
      (tool-expand / copy / panel).
- [ ] **A4 from the backlog triage** — failed-run error-object split is
      marginal; available on request (`.tmp/backlog-triage.md`).

## Owner items

1. [ ] **Approve the NEEDS-DESIGN test-audit shortlist** (bucket above);
       nothing in it runs without that approval.
2. [ ] **Decide the OAuth start** — approve Kimi sign-in as slice 1 and
       settle the third-party client-identity policy blocker.
3. [ ] **Approve the keybinding-surface S1** (transcript read-side chords).
4. [ ] **Preset seed window values** — reverses the pinned "seeds never
       invent one" choice; product call.
5. [ ] **Decide the five unmerged worktrees** — merge, abandon, or keep
       (present, verified via `git worktree list`; never remove without the
       call):
       `.tmp/worktrees/release-doc-count` (`docs-release-e2e-count` @
       `8dfcab5`), `.tmp/worktrees/stream-follow-touch`
       (`fix-stream-follow-touch-test` @ `638f8a4`),
       `.tmp/worktrees/stream-scroll-test` (`test-stream-scroll` @
       `ec6c998`), `.tmp/worktrees/user-message-nav-acceptance` (detached @
       `9a96b9d`), `C:/code/tb-lane-touch` (`test-stream-scroll-touch` @
       `dbf0c2f`).
6. [ ] **GitHub Release page for `v0.0.2`** — manual step (no `gh` CLI on
       this machine); notes body prepared in session. npm side is complete
       (`latest` = `next` = 0.0.2).
7. [ ] **Next release** — version bump + tag + publish need **fresh
       explicit owner words**; packaging/CI/WSL evidence is green
       (`HANDOFF.md` current-state table), and the tarball has drifted from
       the `release.md` 0.0.1-era figures to re-measure.
8. [ ] **Triage owner-gated items** (`.tmp/backlog-triage.md`): the
       TUI-undo capture policy, the third sibling, the models.dev URL
       override.
9. [ ] **A4 failed-run error-object split** — marginal; say the word if
       wanted.
10. [ ] **Micro hygiene:** `.tmp/wt-temp` (unlisted clone-like dir),
        untracked `tools/AGENTS.md` (describes the deleted Python tree —
        delete or gitignore), the `actions/checkout@v4` +
        `setup-node@v4` Node-20 deprecation bump.
- [ ] Optional: pin a deliberate subagent route model in Settings →
      Models & roles → Subagent (empty = helpers inherit the Junior
      model; per-call override > route model > Junior model).

## Next engineering work (priority order)

1. [ ] **Owner decisions first** (above), then execute whatever the audit
       shortlist approves.
2. [ ] **OAuth-only subscription sign-in** — Copilot/Codex/Kimi managed
       login: device flow, refresh-locked token store, provider headers;
       subscription seeds cover API-key plans only today. Large; the
       design is ready.
3. [ ] **TUI keybinding surface expansion** beyond the three global chords
       (`/keys edit` now covers those) — per-surface conflict model; S1 is
       the transcript read-side chords.
4. [ ] **Preset seed window values** (if the owner reverses the pinned
       choice).
5. [ ] **Next release** — repeat `docs/release.md`; bump + tag + publish
       only with fresh explicit permission.
6. [ ] **Micro follow-ups (non-blocking):** `roleIdentity` doc comment
       FIXED in `1d104ef` (`harness.ts`; comment only, behavior correct and
       pinned); the `/fork` parser usage echo can exceed 320 characters on
       very long operator tokens (cosmetic); the cli-reference TUI summary
       paragraph FIXED in `1d104ef` (`/rewind` now listed; fully documented
       elsewhere);
       `/rewind` preview→apply has no CAS against external writers (same
       property as the CLI route; TUI holds the keyboard + idle re-check +
       strict atomic re-read); sidecar OS-unlink failure is not
       hermetically forceable on Windows (notice composition covered); the
       CI failure-artifact path awaits its first red run (job logs are
       auth-gated).

## Deferred register (technical reasons; do not start without a payoff)

- **F forked-context children / D depth > 1** — own designs required;
  deliberate boundaries, not bugs.
- **Structural candidates** TUI-R1–R5/R7, CHAT-R1–R4, SET-S1/S2/S4/S5,
  BE-R1–R5 — broad extraction risk not justified without a concrete
  correctness/performance payoff (accepted slices R6 `7f28044` and S3
  `d0b851b` already landed).
- **Hypotheses** CHAT-F4, SET-H1/H2, TUI-H1–H4, BE-F5, BE-F6b —
  unconfirmed or negligible; revisit only with a reproduced symptom or an
  owner contract decision (BE-F5 task-envelope dedup).
- Full evidence tables: git history of this file (2026-11-14 record).

## Smaller / deferred

- [x] **CLOSED 2026-11-19 — TUI external editor / copy polish.** Ctrl+G
      external editor + Ctrl+X copy are shipped and verified on the
      current tree (149 focused tests green; dispatch/modality/security
      traced; no material docs drift).
- [x] **CLOSED 2026-11-19 — `CANCELLED_TURN_HINT` non-bug** (exit chord
      fixed; if exit ever becomes rebindable, derive it and
      `QUIT_ARMED_ACTIVITY` from the effective table).
- [ ] Stacked-dialog mask-click guard — blocked on naive-ui > 2.45.3.
- [ ] WAN fault injection / long soaks — deliberately manual; offline
      gates cover hermetic retry/timeout/overflow/quota.
- [ ] POSIX hardware validation — detached `run_shell` group reaping and
      real SIGHUP remain Windows-unproven (hermetic seam tests only).
- [ ] True variable-height web transcript virtualization — windowing
      shipped; full virtualization is a design epic.
- [ ] Third sibling / more protocol roles — protocol-level change, not on
      the backlog.

## Local hygiene

- [x] **DONE early (2026-11-19):** removed 2 verified-merged stale
      worktrees + branches (cherry-evidence, `-D` after a `-d` refusal);
      pruned 134 disposable `.tmp` probe directories (~23.8 MiB).
- [x] **DONE final (2026-11-19):** 18 lane worktrees + 11 branches removed
      (all `-d`; ancestor/cherry verified; self-referential npm-workspace
      junctions `node_modules\@two-brothers\harness` unlinked before the
      recursive deletes; no `--force`), ~2.43 GiB; session total ≈4.5 GiB.
- [ ] **KEEP the five unmerged worktrees** listed under Owner items until
      the owner decides (merge/abandon/keep). opencode-owned worktrees and
      `Temp/tb-review-tip` are not touched either way; 6 junctions inside
      the kept lanes are left as-is.
- [ ] `.tmp/wt-temp` is an unlisted clone-like directory — owner call
      (delete/gitignore).
- [ ] Untracked `tools/AGENTS.md` describes the deleted Python tree —
      owner call (delete/gitignore).
- [ ] `.tmp/` still holds gate logs and the local design artifacts —
      prune inside that one directory only (NTFS-junction lesson,
      `HANDOFF.md` §Incident / prevention notes).
- [ ] Keep `research/`, sessions, credentials, logs out of git (this file
      + `HANDOFF.md` are the tracked checkpoint exception).
- [ ] Do not widen `TEMP`/`TMP` = `.tmp/build-temp` beyond standalone web
      builds and `e2e-test.ps1` — package tests/smoke flake
      `tuiintegration` under it (`scripts/AGENTS.md`).
- [ ] npm workspace install at the repo root (husky `prepare` needs the
      root level); WSL non-interactive bash needs the nvm PATH prepended.

## Constraints

- Shared-context Senior/Junior cooperation; `PROTOCOL.md` byte-stable
  markers; runtime events/web types additive only.
- Subagents are a helper tier, never protocol peers; no forked context or
  depth > 1 without a design.
- No new runtime dependencies without a ledger entry; web stays Vue 3 +
  naive-ui and must keep building; `typescript/` stays zero-dependency.
- Conventional Commits; independent acceptance before merge (lane or
  owner, never the implementer alone).
- Pushing verified `main` is approved; **never tag, publish, or bump the
  version without fresh explicit owner permission.** Next release repeats
  `docs/release.md`.
