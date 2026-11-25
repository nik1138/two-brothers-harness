# Two Brothers — working TODO (what is left)

Local working plan, tracked as the checkpoint record alongside `HANDOFF.md`
(owner decision 2026-11-14). Landed work is **not** listed here — see
`HANDOFF.md`, `docs/backlog.md`, `docs/release.md`, and the git log. The
2026-11-14 risk-ranked findings queue is fully resolved; its full table
stays in git history, and the deferral register is condensed below.

Last updated: **2026-11-25**.

## Current state

- `origin/main` = the `39b297b` checkpoint commit (pushed by the lead; this
  lane did not push), clean.
- **0.0.2 shipped**: tag `v0.0.2` at `354df89`; `latest` = `next` = **0.0.2**.
  **No tag, publish, or version bump this session** — the next release
  repeats `docs/release.md` and needs fresh explicit owner permission. The
  GitHub Release *page* remains the one owner-manual step.
- **CI green on all 3 legs** at `12e3097` (run 45646884074): `harness (22)`,
  `harness (24)`, `harness-windows`, each with a green **"Dependency
  checks"** step (verified through the Actions API). Actions are node24
  majors; `npm run check` (pinned + recursive runtime-deps, 105 files) runs
  in CI.
- Baselines at `12e3097` (Windows merged tree; the lead re-ran `npm test`,
  `typecheck`, `selftest`, CLI E2E and `git fsck` on the restored tree, the
  rest is recorded lane evidence): package **2 812 / 2 803 pass / 0 fail /
  0 cancelled / 9 POSIX-only skips** in BOTH `npm test` and `test:spawn`;
  web **753 / 753** + build PASS; browser **44 PASS / 0 FAIL / 1 SKIP**;
  CLI **19 + 19**; faults **7/7**; `npm run check` PASS;
  `SMOKE TEST: PASS`. WSL Node-22 at `12e3097`: **2 812 / 2 810 pass /
  0 fail / 0 cancelled / 2 skipped**, three consecutive runs.
- This window shipped **16 commits** (`b1fc2c5` → `12e3097`): 11 fixes,
  3 docs, 1 test, 1 perf — steering accounting + fail-soft sinks, bundle
  skills parity, compaction size safety, the binary marker on paged/streamed
  reads, plugin import deadline (+ its ref'd-timer fix), the models timeout
  clamp, and the earlier hardening/coverage/docs batch. Details in
  `HANDOFF.md`.
- Packaging metadata unchanged since `8baae35`: tarball **428 files /
  1.66 MB packed / 6.77 MB unpacked**. `docs/release.md` figures are current
  (`2b7acdf`) — the old L157 drift is closed; no refresh item remains.
- **Known loss (2026-11-25):** a housekeeping lane most likely followed an
  NTFS `node_modules` junction (see `AGENTS.md`, "Subagent Lanes") and deleted
  294 tracked files from the main checkout and the gitignored
  `packages/harness/sessions` store, including the sealed
  `sessions/settings.json`. Tracked files were restored from `HEAD`; the
  **sessions and provider keys/role settings are gone** (no backup) and the
  live `:8600` server runs with an empty store.

## Operational (do first)

- [ ] **Re-enter provider keys and role settings** — the sealed
      `sessions/settings.json` was destroyed by the 2026-11-25 incident; the
      live app is unusable until the owner restores them (the `:8600` server
      holds an empty store). See "Known loss".

## In flight

Nothing is in flight on `main` — the tree is clean at `12e3097`. **The safe
autonomous queue is exhausted**; everything below is owner-gated.

## Owner items

1. [ ] **R1 — next release version.** `0.1.0` recommended (70 commits since
       `v0.0.2`, user-facing features); `0.0.3` if treated as incremental.
2. [ ] **R2 — start release prep.** Not started (owner chose "just assess").
       Prep = release rehearsal 7/7 + independent E2E gate lanes + bump
       commit + notes; publishing is owner-run via tag → `publish.yml` →
       promote to `latest`.
3. [ ] **R3 — GitHub Release page for `v0.0.2`.** Manual (no `gh` CLI); npm
       side complete.
4. [ ] **C1–C8 correctness/semantics decisions**
       (`.tmp/owner-decisions-2026-11-25.md` has evidence + line refs):
       C1 failed strict review defaults to `accept` (revise, or emit
       `review_degraded`); C2 cost prefix matching prices `-lite`/`-mini`
       siblings (tighten the boundary rule); C3 the senior consult belt can
       reach MCP servers whose side effects bypass the approval broker
       (read-only hint or docs); C4 task-envelope dedupe drops a repeated
       identical prompt (flip call sites or keep, pinned); C5
       plugin-contributed MCP servers default `role: "junior"` (change or
       document); C6 duplicate plugin selection double-registers (dedupe by
       resolved name or keep, pinned); C7 bundle enable/disable is not
       authoritative (make it authoritative or stop listing bundles); C8
       the summarizer pays the 1.25× cache-write premium (suppress
       `cache_control` or accept).
5. [ ] **U1–U5 UX/keyboard/terminal decisions:** U1 toast geometry loses
       the newest box's tail in a 3-stack on 24 rows (choose which toast to
       sacrifice); U2 web `/rewind` CAS needs an `expected_signature` wire
       field; U3 CLI write paths bypass the advisory writer lock (a check
       would turn today-succeeding invocations into refusals); U4 no
       mouse-wheel scrolling (enter/leave mode + restoration proof);
       U5 no Home/End jump (fixed structural keys are policy — the
       keybinding design owns it).
6. [ ] **R4 — decide the five unmerged worktrees** (merge/abandon/keep;
       never remove without the call):
       `.tmp/worktrees/release-doc-count` (`8dfcab5`),
       `.tmp/worktrees/stream-follow-touch` (`638f8a4`),
       `.tmp/worktrees/stream-scroll-test` (`ec6c998`),
       `.tmp/worktrees/user-message-nav-acceptance` (detached `9a96b9d`),
       `C:/code/tb-lane-touch` (`dbf0c2f`). These five are not touched by
       cleanup lanes.
7. [ ] **R5 — preset seed window values.** Reverses the pinned "seeds never
       invent a window" choice; product call.
8. [ ] **Design shelf — unimplemented, owner-gated.**
       `.tmp/web-wiring-consolidation-design.md` (789 lines: 43 blocks,
       40 genuine contracts, 9 slices, net −17 → 735 tests; decisions
       D1–D9), `.tmp/keybinding-surfaces-design.md` (schema v2, S1 =
       transcript read-side chords), `.tmp/test-audit-report.md`,
       `.tmp/backlog-triage.md`. Execute only with approval.
9. [ ] **OAuth — DEFERRED by the owner** ("I think we don't need this
       now"). `.tmp/oauth-design.md` stays reference only; **do not propose
       or implement**.

## Next engineering work

The safe queue is exhausted. All remaining engineering is owner-gated:
release decisions (R1–R3) first, then C1–C8 / U1–U5 / R5 as approved, then
the design shelf. Do not start OAuth. Non-blocking micro from the previous
checkpoint: the notice bound is char-based, not display-width-based
(pre-existing; practical content is ASCII).

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
- [x] **CLOSED 2026-11-25 — the 2026-11-25 audit SAFE batch** (this window's
      16 commits); earlier discovery A1–A5, B1 CAS, B2 fork echo and the
      backlog nits also landed.
- [ ] Stacked-dialog mask-click guard — blocked on naive-ui > 2.45.3.
- [ ] WAN fault injection / long soaks — deliberately manual.
- [ ] POSIX hardware validation — detached `run_shell` group reaping / real
      SIGHUP Windows-unproven.
- [ ] True variable-height web transcript virtualization — design epic.
- [ ] Third sibling / more protocol roles — protocol-level, not on backlog.

## Local hygiene

- [x] **DONE 2026-11-25:** `tools/AGENTS.md` deleted (owner-approved);
      `.tmp/wt-temp` KEPT (owner choice). The previous batch's merged lane
      worktrees + branches were removed in junction-guarded passes
      (`-d`/cherry `-D`), ≈3.0 GiB; keep-set intact (23/23).
- [ ] **KEEP the five unmerged worktrees** under Owner items until the owner
      decides. opencode-owned worktrees and `Temp/tb-review-tip` untouched.
- [ ] This window's lane/acceptance worktrees (`.tmp/wt-*`, `.tmp/accept-*`)
      were pruned by the lead's housekeeping lane; the five above remain.
      The prune went wrong once (see "Known loss") — only prune inside one
      known directory, never the main checkout or a worktree parent.
- [ ] `.tmp/` holds gate logs + design artifacts — prune inside that one
      directory only (NTFS-junction lesson).
- [ ] Keep `research/`, sessions, credentials, logs out of git. The local
      `sessions/` store is gone (2026-11-25) and is not recoverable.
- [ ] Do not widen `TEMP`/`TMP` = `.tmp/build-temp` beyond web builds +
      `e2e-test.ps1`; smoke/package tests use ambient TEMP.
- [ ] npm install at root; **`web/` is NOT a workspace** (fresh worktree
      needs `npm install` in `web/`). WSL bash needs nvm PATH prepended.

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
