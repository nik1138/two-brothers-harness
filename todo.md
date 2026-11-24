# Two Brothers — working TODO (what is left)

Local working plan, tracked as the checkpoint record alongside `HANDOFF.md`
(owner decision 2026-11-14). Landed work is **not** listed here — see
`HANDOFF.md`, `docs/backlog.md`, `docs/release.md`, and the git log. The
2026-11-14 risk-ranked findings queue is fully resolved; its full table
stays in git history, and the deferral register is condensed below.

Last updated: **2026-11-24**.

## Current state

- `main` = `origin/main` = `4ddab19`, clean — a docs checkpoint commit on
  top; **pushed and in sync** (0 ahead / 0 behind).
- **0.0.2 shipped**: tag `v0.0.2` at `354df89`; `latest` = `next` = **0.0.2**.
  **No tag, publish, or version bump this session** — the next release
  repeats `docs/release.md` and needs fresh explicit owner permission. The
  GitHub Release *page* remains the one owner-manual step.
- **CI fully green on all 3 legs** at `4ddab19` (run 45483813227) — first
  fully-green run since the `/rewind` wave. Actions bumped to node24 majors
  (`checkout`/`setup-node`/`upload-artifact` @v7). The three CI failure
  mechanisms (undici keep-alive, Windows wrap-and-budget, spawned debounce)
  are root-caused and fixed; the failure-artifact pipeline is proven
  end-to-end.
- Baselines at `4ddab19` (Windows, merged tree, **recorded lane evidence**):
  package **2 756 / 2 747 pass / 0 fail / 9 POSIX-only skips** in BOTH
  `npm test` and `test:spawn`; web **753 / 753**; browser E2E **44 PASS /
  0 FAIL / 1 SKIP**; CLI E2E **19 + 19**; faults **7/7**; `SMOKE TEST: PASS`.
  WSL Node-22 at `4ddab19`: `npm test` **3/3 exit 0**, 2 756 / 2 755 / 0 / 1,
  zero `parser.deref` hits.
- This continuation shipped **11 code commits** (`3423788` → `4ddab19`):
  the CI-actions node24 bump plus a 10-commit batch — additive coverage
  tests, backlog shipped-status corrections, web touch-reachable message
  actions, TUI notice bounding + the transcript-whole fix, the parked
  "⋯ n more" mark, transcript memoization (~295× warm frame), and the three
  CI-reliability test fixes. Details in `HANDOFF.md`.
- Live server last refreshed to `29861c7` (PID 123368); **not re-verified
  this continuation** — refresh to `4ddab19` (rebuild + `sync-web` +
  restart) is a pending owner-side step.

## In flight

- [ ] **`agents-rewind-cas`** — /rewind preview→apply CAS hardening
      (discovery B1, SAFE): capture the session `size:mtimeMs:ino` signature
      at preview, compare at accept, refuse + re-preview on change; extract
      the server's private helper to a shared module (server 409 path
      byte-identical). Implementation lane; acceptance + merge to follow.
- [ ] **`hygiene-final`** — remove this session's verified-merged lane
      worktrees + branches (junction-guarded, `-d` only); keep-set untouched.

## Owner items

1. [ ] **Web source-string wiring consolidation** — design ready
       (`.tmp/web-wiring-consolidation-design.md`, 789 lines): 43 blocks, 40
       genuine contracts, 9 slices, net −17 → 735 tests. Decide **D1–D9**
       (browser E2E as coverage home; E2E fixture work; copy exactness;
       section order; absence contracts; test type-checking; the
       `runUsage.ts` extraction; keep `tokens.test.ts` out; stop point
       735 vs 740). Nothing runs without approval.
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
       words**; packaging/CI/WSL evidence green; re-measure the tarball
       (drifted from the `release.md` 0.0.1-era figures).
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

## Next engineering work (priority order)

1. [ ] **Land the in-flight CAS slice** (acceptance + merged-tree gates +
       push), then the remaining SAFE micro: dedupe the three head+tail
       bound helpers into one (touches `app.ts` — after CAS); the
       `boundToastText` label-width comment nit.
2. [ ] **Owner decisions first** (above), then execute whatever the
       web-wiring / audit shortlist approves.
3. [ ] **OAuth subscription sign-in** — design ready; large.
4. [ ] **TUI keybinding surface expansion** beyond the three global chords.
5. [ ] **Preset seed window values** (if the owner reverses the pinned
       choice).
6. [ ] **Next release** — repeat `docs/release.md`; bump + tag + publish
       only with fresh explicit permission.

## Deferred register (technical reasons; do not start without a payoff)

- **F forked-context children / D depth > 1** — own designs required;
  deliberate boundaries, not bugs.
- **Structural candidates** TUI-R1–R5/R7, CHAT-R1–R4, SET-S1/S2/S4/S5,
  BE-R1–R5 — broad extraction risk not justified without a concrete
  correctness/performance payoff (R6 `7f28044` and S3 `d0b851b` landed).
- **Hypotheses** CHAT-F4, SET-H1/H2, TUI-H1–H4, BE-F5, BE-F6b — unconfirmed
  or negligible; revisit only with a reproduced symptom or an owner
  contract decision.
- Full evidence tables: git history of this file (2026-11-14 record).

## Smaller / deferred

- [x] **CLOSED — TUI external editor / copy polish** (Ctrl+G / Ctrl+X
      shipped and verified).
- [x] **CLOSED — `CANCELLED_TURN_HINT` non-bug** (exit chord fixed).
- [x] **CLOSED 2026-11-24 — discovery A1–A5** (transcript memoization, web
      touch actions, toast bounding, parked mark, `/rewind` help) and C1/C2
      backlog nits; B2 fork/rewind echo bounding; B4 `tools/AGENTS.md`
      deleted; the actions Node-20 bump; the three CI failure mechanisms.
- [ ] Stacked-dialog mask-click guard — blocked on naive-ui > 2.45.3.
- [ ] WAN fault injection / long soaks — deliberately manual.
- [ ] POSIX hardware validation — detached `run_shell` group reaping / real
      SIGHUP Windows-unproven (hermetic seam tests only).
- [ ] True variable-height web transcript virtualization — design epic.
- [ ] Third sibling / more protocol roles — protocol-level, not on backlog.

## Local hygiene

- [x] **DONE 2026-11-24:** `tools/AGENTS.md` deleted (owner-approved);
      `.tmp/wt-temp` KEPT (owner choice — leftover compile-cache, not a
      worktree). A hygiene lane is removing this session's merged lane
      worktrees + branches (junction-guarded, `-d`).
- [ ] **KEEP the five unmerged worktrees** under Owner items until the owner
      decides. opencode-owned worktrees (incl. `agents-depth3`) and
      `Temp/tb-review-tip` are not touched; junctions inside kept lanes left
      as-is.
- [ ] `.tmp/` holds gate logs + design artifacts — prune inside that one
      directory only (NTFS-junction lesson, `HANDOFF.md` §Incident).
- [ ] Keep `research/`, sessions, credentials, logs out of git (this file +
      `HANDOFF.md` are the tracked checkpoint exception).
- [ ] Do not widen `TEMP`/`TMP` = `.tmp/build-temp` beyond standalone web
      builds and `e2e-test.ps1`.
- [ ] npm workspace install at the repo root; **`web/` is NOT a workspace** —
      a fresh worktree needs `npm install` in `web/` for smoke's `vue-tsc`.
      WSL non-interactive bash needs the nvm PATH prepended.

## Constraints

- Shared-context Senior/Junior cooperation; `PROTOCOL.md` byte-stable
  markers; runtime events/web types additive only.
- Subagents are a helper tier, never protocol peers; no forked context or
  depth > 1 without a design.
- No new runtime dependencies without a ledger entry; web stays Vue 3 +
  naive-ui and must keep building; `typescript/` stays zero-dependency.
- Conventional Commits; independent acceptance before merge (lane or owner,
  never the implementer alone).
- Pushing verified `main` is approved; **never tag, publish, or bump the
  version without fresh explicit owner permission.** Next release repeats
  `docs/release.md`.