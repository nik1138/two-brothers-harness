# Two Brothers — working TODO (what is left)

Local working plan, tracked as the checkpoint record alongside `HANDOFF.md`
(owner decision 2026-11-14). Landed work is **not** listed here — see
`HANDOFF.md`, `docs/backlog.md`, `docs/release.md`, and the git log. The
2026-11-14 risk-ranked findings queue is fully resolved; its full table
stays in git history, and the deferral register is condensed below.

Last updated: **2026-11-25**.

## Current state

- `main` = `origin/main` = `b1fc2c5`, clean — a docs checkpoint commit on
  top; **pushed and in sync** (0 ahead / 0 behind).
- **0.0.2 shipped**: tag `v0.0.2` at `354df89`; `latest` = `next` = **0.0.2**.
  **No tag, publish, or version bump this session** — the next release
  repeats `docs/release.md` and needs fresh explicit owner permission. The
  GitHub Release *page* remains the one owner-manual step.
- **CI fully green on all 3 legs** at `b1fc2c5` (run 45528544514), including
  the newly-wired **"Dependency checks"** step in every job. Actions are
  node24 majors; `npm run check` (pinned + recursive runtime-deps, 105 files)
  now runs in CI. The three CI failure mechanisms (undici keep-alive, Windows
  wrap-and-budget, spawned debounce) are root-caused and fixed; the
  failure-artifact pipeline is proven end-to-end.
- Baselines at `b1fc2c5` (Windows, merged tree, **recorded lane evidence**):
  package **2 760 / 2 751 pass / 0 fail / 9 POSIX-only skips** in BOTH
  `npm test` and `test:spawn`; web **753 / 753**; browser **44 PASS / 0 FAIL /
  1 SKIP**; CLI **19 + 19**; faults **7/7**; `SMOKE TEST: PASS`. WSL Node-22
  at `4ddab19`: `npm test` 3/3 exit 0, zero `parser.deref`.
- Packaging re-verified at `8baae35`: tarball **428 files / 1.66 MB packed /
  6.77 MB unpacked**, **489 exports**, `estimateRoleCost` reachable; Node-22
  WSL tarball-smoke 7/7 + pack:check PASS.
- This continuation shipped **15 code commits** (`3423788` → `b1fc2c5`):
  CI-actions node24 bump; a 10-commit batch (coverage tests, backlog
  corrections, web touch actions, TUI notice bounding + transcript-whole fix,
  parked mark, transcript memoization ~295×, three CI-reliability fixes);
  `/rewind` CAS; notice-bound dedupe; recursive runtime-deps scan; and wiring
  the dep-check gate into CI. Details in `HANDOFF.md`.
- Live serve refreshed to `8baae35` (product-current): **PID 18708**, GET/HEAD
  parity, bundle `index-Baw0tops.js`, both preserved sessions intact.

## In flight

Nothing is in flight on `main` — the tree is clean and fully pushed. **The
safe autonomous queue is exhausted**; everything below is owner-gated.

## Owner items

1. [ ] **Web source-string wiring consolidation** — design ready
       (`.tmp/web-wiring-consolidation-design.md`, 789 lines): 43 blocks, 40
       genuine contracts, 9 slices, net −17 → 735 tests. Decide **D1–D9**
       (browser E2E as coverage home; E2E fixtures; copy exactness; section
       order; absence contracts; test type-checking; the `runUsage.ts`
       extraction; keep `tokens.test.ts` out; stop point 735 vs 740).
2. [ ] **Broader NEEDS-DESIGN test-audit shortlist**
       (`.tmp/test-audit-report.md`): approval/deny −2, plugins endpoint −1,
       mirror pairs −4, storage pairs −2. The owner KEPT the 6 published-cap
       contract pins. Execute only with approval.
3. [ ] **OAuth implementation** — design ready (`.tmp/oauth-design.md`):
       zero-new-dep, sealed `oauth.json`, single-flight refresh, 8 slices,
       8 owner decisions; Codex needs a 4th wire family; third-party client
       identities are a policy blocker. First slice: Kimi sign-in.
4. [ ] **Keybinding-surface expansion** — design ready
       (`.tmp/keybinding-surfaces-design.md`): co-live-namespace conflict
       model, schema v2 (v1 compatible), approval panel permanently closed;
       S1 = transcript read-side chords (tool-expand / copy / panel).
5. [ ] **Preset seed window values** — reverses the pinned "seeds never
       invent one" choice; product call.
6. [ ] **Decide the five unmerged worktrees** — merge/abandon/keep (never
       remove without the call): `.tmp/worktrees/release-doc-count`
       (`8dfcab5`), `.tmp/worktrees/stream-follow-touch` (`638f8a4`),
       `.tmp/worktrees/stream-scroll-test` (`ec6c998`),
       `.tmp/worktrees/user-message-nav-acceptance` (detached `9a96b9d`),
       `C:/code/tb-lane-touch` (`dbf0c2f`).
7. [ ] **GitHub Release page for `v0.0.2`** — manual (no `gh` CLI); npm side
       complete.
8. [ ] **Next release** — bump + tag + publish need **fresh explicit owner
       words**; packaging/CI/WSL evidence green. **Refresh `docs/release.md`
       L157 tarball figures** (still 0.0.1-era 368 / 1.28 MB / 5.17 MB; now
       428 / 1.66 MB / 6.77 MB).
9. [ ] **Triage owner-gated items:** TUI-undo capture policy, third sibling,
       models.dev URL override; discovery A6 (CLI write paths bypass the
       advisory writer lock — design-first), A7 (mouse-wheel scroll), A8
       (Home/End key), A9 (`res.json()` guard).
10. [ ] **A4 failed-run error-object split** — discovery verdict LEAVE
       (runtime already rebuilds a failed run's split from `call_usage`; no
       first-party consumer of `harness.run()` catches); revisit only for an
       embedding consumer.
- [ ] Optional: pin a deliberate subagent route model in Settings → Models
      & roles → Subagent.

## Next engineering work

The safe queue is exhausted. All remaining engineering is owner-gated
(above): owner decisions first, then OAuth / keybinding expansion / preset
windows / next release as approved. Non-blocking micro noted in `HANDOFF.md`
(char-vs-display-width bound property; `release.md` figures refresh at the
next release).

## Deferred register (technical reasons; do not start without a payoff)

- **F forked-context children / D depth > 1** — own designs required.
- **Structural candidates** TUI-R1–R5/R7, CHAT-R1–R4, SET-S1/S2/S4/S5,
  BE-R1–R5 — broad extraction risk not justified without a concrete payoff
  (R6 `7f28044`, S3 `d0b851b` landed).
- **Hypotheses** CHAT-F4, SET-H1/H2, TUI-H1–H4, BE-F5, BE-F6b — unconfirmed
  or negligible; revisit only with a reproduced symptom or owner decision.
- Full evidence tables: git history of this file (2026-11-14 record).

## Smaller / deferred

- [x] **CLOSED — TUI external editor / copy polish**; **`CANCELLED_TURN_HINT`
      non-bug**.
- [x] **CLOSED 2026-11-25 — discovery A1–A5, B1 CAS, B2 fork echo, C1/C2
      backlog nits**; B4 `tools/AGENTS.md` deleted; actions Node-20 bump; the
      three CI failure mechanisms; notice-bound dedupe; recursive
      runtime-deps scan; dep-check gate wired into CI.
- [ ] Stacked-dialog mask-click guard — blocked on naive-ui > 2.45.3.
- [ ] WAN fault injection / long soaks — deliberately manual.
- [ ] POSIX hardware validation — detached `run_shell` group reaping / real
      SIGHUP Windows-unproven.
- [ ] True variable-height web transcript virtualization — design epic.
- [ ] Third sibling / more protocol roles — protocol-level, not on backlog.

## Local hygiene

- [x] **DONE 2026-11-25:** `tools/AGENTS.md` deleted (owner-approved);
      `.tmp/wt-temp` KEPT (owner choice). Merged lane worktrees + branches
      removed in three junction-guarded passes (`-d`/cherry `-D`), ≈3.0 GiB;
      keep-set intact (23/23). Only `agents-depth3` (opencode-owned) remains
      among `agents-*` branches.
- [ ] **KEEP the five unmerged worktrees** under Owner items until the owner
      decides. opencode-owned worktrees and `Temp/tb-review-tip` untouched.
- [ ] `.tmp/` holds gate logs + design artifacts — prune inside that one
      directory only (NTFS-junction lesson).
- [ ] Keep `research/`, sessions, credentials, logs out of git.
- [ ] Do not widen `TEMP`/`TMP` = `.tmp/build-temp` beyond web builds +
      `e2e-test.ps1`; smoke/package tests use ambient TEMP.
- [ ] npm install at root; **`web/` is NOT a workspace** (fresh worktree needs
      `npm install` in `web/`). WSL bash needs nvm PATH prepended.

## Constraints

- Shared-context Senior/Junior cooperation; `PROTOCOL.md` byte-stable
  markers; runtime events/web types additive only.
- Subagents are a helper tier, never protocol peers; no forked context or
  depth > 1 without a design.
- No new runtime dependencies without a ledger entry; web stays Vue 3 +
  naive-ui and must keep building; `typescript/` stays zero-dependency.
- Conventional Commits; independent acceptance before merge.
- Pushing verified `main` is approved; **never tag, publish, or bump the
  version without fresh explicit owner permission.**