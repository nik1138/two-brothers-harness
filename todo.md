# Two Brothers — working TODO (what is left)

Local working plan, tracked as the checkpoint record alongside `HANDOFF.md`
(owner decision 2026-11-14). Landed work is **not** listed here — see
`HANDOFF.md`, `docs/backlog.md`, `docs/release.md`, and the git log. The
2026-11-14 risk-ranked findings queue is fully resolved; its full table
stays in git history, and the deferral register is condensed below.

Last updated: **2026-11-26**.

## Current state

- `origin/main` = `2347d7c` (pushed by the lead); the checkpoint docs commit
  on top is local only (this lane did not push).
- **0.0.2 shipped**: tag `v0.0.2` at `354df89`; `latest` = `next` = **0.0.2**.
  **No tag, publish, or version bump this session** — the next release
  repeats `docs/release.md` and needs fresh explicit owner permission. The
  GitHub Release *page* remains the one owner-manual step. **89 commits**
  since `v0.0.2`.
- **CI green on all 3 legs** at `6ba53ed` (run 45813789753) and at `2347d7c`
  (run 45821219237): `harness (22)`, `harness (24)`, `harness-windows`, each
  with a green **"Dependency checks"** step (verified through the Actions
  API). `npm run check` (pinned + recursive runtime-deps, 105 files) runs in
  CI.
- Baselines at `6ba53ed` / `2347d7c` (Windows merged tree): package
  **2 829 / 2 820 pass / 0 fail / 0 cancelled / 9 POSIX-only skips** in
  BOTH `npm test` and `test:spawn` (this docs lane re-ran `npm test` at
  `2347d7c`: same counts); web **777 / 777** + build PASS; browser
  **44 PASS / 0 FAIL / 1 SKIP** at both tips; CLI **19 + 19**; faults
  **7/7**; prompt-audit PASS; server-status **3/3**; root `npm run check`
  PASS; `SMOKE TEST: PASS`. WSL Node-22 at `6ba53ed`:
  **2 829 / 2 827 pass / 0 fail / 0 cancelled / 2 skipped**, three
  consecutive runs. WSL was **not** re-run for the `2347d7c` web-only merge
  (no `packages/harness/src/` or `tests/` change).
- This window shipped **5 commits** on `33ecc36`: the PATCH workspace binder
  (`04a9fb3`), the provider-model picker (`fdd9519`, `6ba53ed`), and the
  workspace start gate (`ce4595d`, `2347d7c`). All **LANDED**. Details in
  `HANDOFF.md`.
- **Deferred — workspace enforcement (not shipped):** requiring a workspace
  for CLI `run`/`chat` (`--workspace`), refusing a tool-less TUI start, and
  the serve-side 400 `select a workspace to start` for an unbound run. A
  broad attempt was reverted and preserved as
  `.tmp/workspace-enforcement-wip.patch` (≈370 KB, 43 files including the
  40+ server/CLI test ripple). The web gate + PATCH binder shipped first;
  the next step is owner decision A3. Until then the web client is the only
  enforcement point.
- Packaging metadata unchanged since `8baae35`: tarball **428 files /
  1.66 MB packed / 6.77 MB unpacked**. `docs/release.md` figures are current
  (`2b7acdf`). Tarball-smoke, `pack:check` and the release rehearsal were
  not re-run for this window (no release prep started).
- **Known loss (2026-11-25):** a housekeeping lane most likely followed an
  NTFS `node_modules` junction (see `AGENTS.md`, "Subagent Lanes") and deleted
  294 tracked files from the main checkout and the gitignored
  `packages/harness/sessions` store, including the sealed
  `sessions/settings.json`. Tracked files were restored from `HEAD`; the two
  **pre-incident sessions are gone** (no backup). The live validation
  re-created the store: it now holds two 2026-11-26 sessions and a
  `settings.json` with one encrypted provider key plus the local `lmstudio`
  provider/role settings — configured again, but not the original sealed
  store.

## Operational (do first)

- [ ] **Confirm the re-created provider key and role settings** — the sealed
      `sessions/settings.json` was destroyed by the 2026-11-25 incident and a
      new one exists with one encrypted provider key plus the local LM Studio
      provider (roles point at `ternary-bonsai-2.5-27b`). Verify these are
      the intended live-app settings before relying on them.

## In flight

Nothing is in flight on `main` — the tree is clean at `2347d7c`; the
checkpoint docs commit is local. **The safe autonomous queue is exhausted**;
everything below is owner-gated, including the deferred enforcement slice.

## Owner items

The evidence, options and defaults for each live decision are in
`.tmp/owner-decisions-2026-11-25.md` (refreshed to `2347d7c`; the still-open
items lead that file).

1. [ ] **A1 — next release version + go-ahead.** `0.1.0` recommended
       (**89 commits** since `v0.0.2`, user-facing features incl. B1's new
       flag and this window's workspace gate); `0.0.3` if treated as
       incremental; or hold and keep shipping `next`. Prep is **not started**
       (no bump commit, notes or rehearsal on this tip); publishing is
       owner-run via tag → `publish.yml` → promote.
2. [ ] **A2 — GitHub Release page for `v0.0.2`.** Manual (no `gh` CLI); npm
       side complete; still unverified — the one item a network check could
       not settle.
3. [ ] **A3 — resume the deferred workspace-enforcement slice
       (CLI/TUI/serve)?** A broad attempt was reverted and preserved as
       `.tmp/workspace-enforcement-wip.patch` (≈370 KB; 43 files, including
       40+ server/CLI test files): `--workspace` required for CLI
       `run`/`chat`, a tool-less TUI start refused, and the serve-side 400
       `select a workspace to start` for an unbound run. The web gate +
       PATCH binder already shipped. Options: **resume the patch as its own
       slice (recommended)**, **web-only for now**, or **stop**. The ripple
       is why it did not land in one step; a dedicated lane can absorb it,
       but the CLI change is a visible contract break and should be timed
       with the next release decision.
4. [ ] **B5 — bundle enable/disable is not authoritative** (`plugins.ts`,
       web "Enabled plugins" multiselect): make the selection authoritative,
       exclude bundles from the toggle list and label them "always on", or
       leave it.
5. [ ] **B6 — cost prefix matching prices a sibling model**
       (`gemini-2.5-flash-lite` → the flash price): refuse a `-lite`/`-mini`/
       `-nano` prefix cross, add the missing rows, or leave it.
6. [ ] **B7 — plugin-contributed MCP servers default to `role: "junior"`**
       while plugin tools are shared-by-default: document the asymmetry
       (default), change it as a deliberate v2 break, or leave it.
7. [ ] **B8 — a degraded compaction gives the operator no truncation
       notice**: add one `result.warnings`/notice line, stay silent, or stamp
       the summary envelope.
8. [ ] **B9 — the web UI never shows dropped steering** (the TUI warns; the
       web has no `steering_dropped`): surface one notice when the followed
       run ends, add it to the run card, or keep it API-only.
9. [ ] **B10 — `@file` mention injection drops the `binary` marker**: one
       `binary="true"` attribute on the tag, refuse a non-UTF-8 `@file`
       mention, or leave it.
10. [ ] **B11 — preset seed window values.** Reverses the pinned "seeds never
        invent a window" choice; product call needing sourced per-model
        numbers.
11. [ ] **C1 — a full toast stack loses head and tail symmetrically**
        (320-char ceiling, centered overlay): top-align toasts, cap the stack
        to 2, or lower the ceiling.
12. [ ] **C2 — CLI write paths bypass the advisory writer lock.** A check
        would turn today-succeeding invocations into refusals and contradict
        a documented contract unless the docs change too: keep the docs as
        the contract, or make CLI writes refuse while a live writer owns the
        store.
13. [ ] **C3 — no Home/End transcript jump.** Bind Home/End to top/latest, a
        chorded form, or leave it (fixed structural keys are the keybinding
        design's area).
14. [ ] **C4 — no mouse-wheel scrolling.** Defer for this release (default),
        or add SGR mouse tracking + wheel with an enter/leave restoration
        proof.
15. [ ] **D1 — decide the five unmerged worktrees** (merge/abandon/keep;
        never remove without the call):
        `.tmp/worktrees/release-doc-count` (`8dfcab5`),
        `.tmp/worktrees/stream-follow-touch` (`638f8a4`),
        `.tmp/worktrees/stream-scroll-test` (`ec6c998`),
        `.tmp/worktrees/user-message-nav-acceptance` (detached `9a96b9d`),
        `C:/code/tb-lane-touch` (`dbf0c2f`). These five are not touched by
        cleanup lanes (`git worktree list` verified). This window's merged
        lane/acceptance worktrees (`.tmp/wt-default-workspace`,
        `.tmp/wt-provider-model-picker`, `.tmp/wt-web-workspace`,
        `.tmp/accept-provider-picker`, `.tmp/accept-web-workspace`) also
        remain and are cleanup candidates for the same hygiene pass.
16. [ ] **D2 — session-store backup policy** (the gitignored store was lost
        a second time): accept as disposable, periodic manual backup outside
        the checkout (default), or a `sessions export` snapshot step.
17. [ ] **Design shelf — unimplemented, owner-gated.**
        `.tmp/web-wiring-consolidation-design.md` (789 lines: 43 blocks,
        40 genuine contracts, 9 slices, net −17 → 735 tests; decisions
        D1–D9), `.tmp/keybinding-surfaces-design.md` (schema v2, S1 =
        transcript read-side chords), `.tmp/test-audit-report.md`,
        `.tmp/backlog-triage.md`. Execute only with approval.
18. [ ] **OAuth — DEFERRED by the owner** ("I think we don't need this
        now"). `.tmp/oauth-design.md` stays reference only; **do not propose
        or implement**.

## Next engineering work

The safe queue is exhausted. All remaining engineering is owner-gated:
release decisions (A1–A2) first, the deferred enforcement call (A3), then
B5–B11 / C1–C4 / D1–D2 as approved, then the design shelf. Do not start
OAuth. Non-blocking micro from the previous checkpoint: the notice bound is
char-based, not display-width-based (pre-existing; practical content is
ASCII).

## Deferred register (technical reasons; do not start without a payoff)

- **Workspace enforcement (CLI/TUI/serve)** — reverted broad attempt
  preserved at `.tmp/workspace-enforcement-wip.patch` (≈370 KB, 43 files);
  do not resume without the A3 owner call. The web gate + PATCH binder are
  landed.
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
- [x] **CLOSED 2026-11-26 — provider-model picker** (`fdd9519`, `6ba53ed`)
      **and the workspace start gate + PATCH binder** (`04a9fb3`,
      `ce4595d`, `2347d7c`).
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
- [ ] This window's merged lane/acceptance worktrees are still present
      (`.tmp/wt-default-workspace`, `.tmp/wt-provider-model-picker`,
      `.tmp/wt-web-workspace`, `.tmp/accept-provider-picker`,
      `.tmp/accept-web-workspace`); remove them only in a hygiene pass that
      enumerates reparse points first — do not prune outside one known
      directory (the prune went wrong once; see "Known loss").
- [ ] `.tmp/` holds gate logs + design artifacts — prune inside that one
      directory only (NTFS-junction lesson).
- [ ] Keep `research/`, sessions, credentials, logs out of git. The
      pre-incident `sessions/` content is gone (2026-11-25) and is not
      recoverable; today's store holds only the live-validation sessions.
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
- The web client is the only workspace enforcement point until A3; do not
  claim the serve/CLI side refuses an unbound run.
- Pushing verified `main` is approved; **never tag, publish, or bump the
  version without fresh explicit owner permission.**
