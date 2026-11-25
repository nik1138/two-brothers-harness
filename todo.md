# Two Brothers — working TODO (what is left)

Local working plan, tracked as the checkpoint record alongside `HANDOFF.md`
(owner decision 2026-11-14). Landed work is **not** listed here — see
`HANDOFF.md`, `docs/backlog.md`, `docs/release.md`, and the git log. The
2026-11-14 risk-ranked findings queue is fully resolved; its full table
stays in git history, and the deferral register is condensed below.

Last updated: **2026-11-25**.

## Current state

- `origin/main` = `b0b150e` (pushed by the lead); the checkpoint docs commit
  on top is local only (this lane did not push).
- **0.0.2 shipped**: tag `v0.0.2` at `354df89`; `latest` = `next` = **0.0.2**.
  **No tag, publish, or version bump this session** — the next release
  repeats `docs/release.md` and needs fresh explicit owner permission. The
  GitHub Release *page* remains the one owner-manual step.
- **CI green on all 3 legs** at `b0b150e` (run 45684572246): `harness (22)`,
  `harness (24)`, `harness-windows`, each with a green **"Dependency
  checks"** step (verified through the Actions API). `npm run check`
  (pinned + recursive runtime-deps, 105 files) runs in CI.
- Baselines at `b0b150e` (Windows merged tree; the merged-tree matrix was run
  on that tree from lead + lane evidence, this docs lane independently re-ran
  `npm test`, Node v24.13.0): package
  **2 825 / 2 816 pass / 0 fail / 0 cancelled / 9 POSIX-only skips** in
  BOTH `npm test` (re-run) and `test:spawn` (identical lane evidence); web
  **753 / 753** + build PASS; browser **44 PASS / 0 FAIL / 1 SKIP**; CLI
  **19 + 19**; faults **7/7**; prompt-audit PASS; server-status **3/3**;
  root `npm run check` PASS; `SMOKE TEST: PASS`. WSL Node-22 at `b0b150e`:
  **2 825 / 2 823 pass / 0 fail / 0 cancelled / 2 skipped**, three
  consecutive runs; targeted 100/100.
- This window shipped the **B1–B4 batch** (`bf1826f` → `b0b150e`): 11
  commits (1 feat, 2 fixes, 6 docs, 2 tests) — degraded-review visibility,
  resume-only task dedupe, the consult-belt "read-only" correction, and
  duplicate-plugin dedupe, plus one disclosed test-only fixture fix.
  Four owner decisions are **LANDED**. Details in `HANDOFF.md`.
- Packaging metadata unchanged since `8baae35`: tarball **428 files /
  1.66 MB packed / 6.77 MB unpacked**. `docs/release.md` figures are current
  (`2b7acdf`). Tarball-smoke, `pack:check` and the release rehearsal were
  not re-run for this batch (no release prep started).
- **Known loss (2026-11-25):** a housekeeping lane most likely followed an
  NTFS `node_modules` junction (see `AGENTS.md`, "Subagent Lanes") and deleted
  294 tracked files from the main checkout and the gitignored
  `packages/harness/sessions` store, including the sealed
  `sessions/settings.json`. Tracked files were restored from `HEAD`; the
  **sessions and provider keys/role settings are gone** (no backup) and the
  live `:8600` server (the lead restarts it at `b0b150e`) runs with an empty
  store.

## Operational (do first)

- [ ] **Re-enter provider keys and role settings** — the sealed
      `sessions/settings.json` was destroyed by the 2026-11-25 incident; the
      live app is unusable until the owner restores them (the `:8600` server
      holds an empty store). See "Known loss".

## In flight

Nothing is in flight on `main` — the tree is clean at `b0b150e`; the
checkpoint docs commit is local. **The safe autonomous queue is exhausted**;
everything below is owner-gated.

## Owner items

The evidence, options and defaults for each live decision are in
`.tmp/owner-decisions-2026-11-25.md` (refreshed to `b0b150e`; the still-open
items lead that file).

1. [ ] **A1 — next release version + go-ahead.** `0.1.0` recommended
       (**83 commits** since `v0.0.2`, user-facing features incl. B1's new
       flag); `0.0.3` if treated as incremental; or hold and keep shipping
       `next`. Prep is **not started** (no bump commit, notes or rehearsal on
       this tip); publishing is owner-run via tag → `publish.yml` → promote.
2. [ ] **A2 — GitHub Release page for `v0.0.2`.** Manual (no `gh` CLI); npm
       side complete; still unverified — the one item a network check could
       not settle.
3. [ ] **B5 — bundle enable/disable is not authoritative** (`plugins.ts`,
       web "Enabled plugins" multiselect): make the selection authoritative,
       exclude bundles from the toggle list and label them "always on", or
       leave it.
4. [ ] **B6 — cost prefix matching prices a sibling model**
       (`gemini-2.5-flash-lite` → the flash price): refuse a `-lite`/`-mini`/
       `-nano` prefix cross, add the missing rows, or leave it.
5. [ ] **B7 — plugin-contributed MCP servers default to `role: "junior"`**
       while plugin tools are shared-by-default: document the asymmetry
       (default), change it as a deliberate v2 break, or leave it.
6. [ ] **B8 — a degraded compaction gives the operator no truncation
       notice**: add one `result.warnings`/notice line, stay silent, or stamp
       the summary envelope.
7. [ ] **B9 — the web UI never shows dropped steering** (the TUI warns; the
       web has no `steering_dropped`): surface one notice when the followed
       run ends, add it to the run card, or keep it API-only.
8. [ ] **B10 — `@file` mention injection drops the `binary` marker**: one
       `binary="true"` attribute on the tag, refuse a non-UTF-8 `@file`
       mention, or leave it.
9. [ ] **B11 — preset seed window values.** Reverses the pinned "seeds never
       invent a window" choice; product call needing sourced per-model
       numbers.
10. [ ] **C1 — a full toast stack loses head and tail symmetrically**
        (320-char ceiling, centered overlay): top-align toasts, cap the stack
        to 2, or lower the ceiling.
11. [ ] **C2 — CLI write paths bypass the advisory writer lock.** A check
        would turn today-succeeding invocations into refusals and contradict
        a documented contract unless the docs change too: keep the docs as
        the contract, or make CLI writes refuse while a live writer owns the
        store.
12. [ ] **C3 — no Home/End transcript jump.** Bind Home/End to top/latest, a
        chorded form, or leave it (fixed structural keys are the keybinding
        design's area).
13. [ ] **C4 — no mouse-wheel scrolling.** Defer for this release (default),
        or add SGR mouse tracking + wheel with an enter/leave restoration
        proof.
14. [ ] **D1 — decide the five unmerged worktrees** (merge/abandon/keep;
        never remove without the call):
        `.tmp/worktrees/release-doc-count` (`8dfcab5`),
        `.tmp/worktrees/stream-follow-touch` (`638f8a4`),
        `.tmp/worktrees/stream-scroll-test` (`ec6c998`),
        `.tmp/worktrees/user-message-nav-acceptance` (detached `9a96b9d`),
        `C:/code/tb-lane-touch` (`dbf0c2f`). These five are not touched by
        cleanup lanes (`git worktree list` verified).
15. [ ] **D2 — session-store backup policy** (the gitignored store was lost
        a second time): accept as disposable, periodic manual backup outside
        the checkout (default), or a `sessions export` snapshot step.
16. [ ] **Design shelf — unimplemented, owner-gated.**
        `.tmp/web-wiring-consolidation-design.md` (789 lines: 43 blocks,
        40 genuine contracts, 9 slices, net −17 → 735 tests; decisions
        D1–D9), `.tmp/keybinding-surfaces-design.md` (schema v2, S1 =
        transcript read-side chords), `.tmp/test-audit-report.md`,
        `.tmp/backlog-triage.md`. Execute only with approval.
17. [ ] **OAuth — DEFERRED by the owner** ("I think we don't need this
        now"). `.tmp/oauth-design.md` stays reference only; **do not propose
        or implement**.

## Next engineering work

The safe queue is exhausted. All remaining engineering is owner-gated:
release decisions (A1–A2) first, then B5–B11 / C1–C4 / D1–D2 as approved,
then the design shelf. Do not start OAuth. Non-blocking micro from the
previous checkpoint: the notice bound is char-based, not
display-width-based (pre-existing; practical content is ASCII).

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
- [x] **CLOSED 2026-11-25 — the 2026-11-25 audit SAFE batch** (the
      `b1fc2c5` → `12e3097` 16 commits) **and its B1–B4 follow-up batch**
      (`bf1826f` → `b0b150e`, 11 commits); earlier discovery A1–A5, the CAS
      fix, the fork echo and the backlog nits also landed.
- [ ] Stacked-dialog mask-click guard — blocked on naive-ui > 2.45.3.
- [ ] WAN fault injection / long soaks — deliberately manual.
- [ ] POSIX hardware validation — detached `run_shell` group reaping / real
      SIGHUP Windows-unproven.
- [ ] True variable-height web transcript virtualization — design epic.
- [ ] Third sibling / more protocol roles — protocol-level, not on backlog.

## Parked notes (recorded residuals — not open work)

- **TUI identical-attachment retry reuses the first task envelope.**
  Submitting the *identical* attachment task twice reuses the first task
  envelope (the TUI `hasMessage` guard skips the pre-append; the harness
  `dedupeInitialTask` then skips). Pre-existing retry behavior, documented
  as a note in `src/tui/app.ts`; not a B2 regression.
- **Model-facing prompt strings still say "read-only"** for the offered
  tools (e.g. `src/harness.ts` prompt constants). Changing prompt bytes
  needs the `tests/modebytes` goldens regenerated → separate lane. Code
  comments also still say read-only in places (not user-visible).
- **The senior-review grounding note says "workspace checks"** although the
  evidence can also come from role-scoped MCP/plugin tools — narrow wording,
  not a safety claim; optional later tweak.

## Local hygiene

- [x] **DONE 2026-11-25:** `tools/AGENTS.md` deleted (owner-approved);
      `.tmp/wt-temp` KEPT (owner choice). The previous batches' merged lane
      worktrees + branches were removed in junction-guarded passes
      (`-d`/cherry `-D`), ≈3.0 GiB; keep-set intact (23/23).
- [ ] **KEEP the five unmerged worktrees** under Owner items until the owner
      decides. opencode-owned worktrees and `Temp/tb-review-tip` untouched.
- [ ] This window's lane worktrees are gone (`git worktree list` shows only
      the five open worktrees plus opencode's); do not prune outside one
      known directory — the prune went wrong once (see "Known loss").
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
