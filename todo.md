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
  code tree `7834514`; **pushed and in sync**.
- **0.0.2 shipped**: tag `v0.0.2` at `354df89`, published to `next` via the
  trusted-publishing workflow (full release gate PASS), promoted to
  `latest` 2026-11-18; global install verified. **No tag, publish, or
  version bump this session** — the next release repeats `docs/release.md`
  and needs fresh explicit owner permission. Only the GitHub Release
  *page* remains (owner manual step, below).
- Live server refreshed 2026-11-19 ~15:53 to `7834514`: PID **69528**,
  `node dist/cli.js serve --port 8600 --sessions-dir sessions` (cwd
  `packages/harness`, logs `.tmp/live-serve/`); `GET /` 200 with the new
  bundle `index-BAtTsj25.js`, `/api/sessions` 200 with both preserved
  sessions, `/api/mcp` 200; `sync-web` 3/3 files SHA256-identical.
  Store: `packages/harness/sessions`. Pre-existing quirk: `HEAD /assets/*`
  404 (GET-only static handler; no UI impact).
- Baselines at `7834514` (Windows, merged tree, recorded lane evidence —
  not re-run for this refresh): package **2 671 / 2 663 pass / 0 fail / 8
  POSIX-only skips** in BOTH `npm test` and `test:spawn`; web
  **747 / 747 / 0 / 0**; browser E2E **44 PASS / 0 FAIL / 1 SKIP** (opt-in
  real); hermetic CLI E2E **19 + 19**; real-socket faults **7/7**;
  reference selftest PASS + **33/33**; `SMOKE TEST: PASS`.
- This session shipped 8 commits in two waves (`c80c855` → `7834514`):
  Gemini schema whitelist, per-turn + per-role usage (with cache split),
  the OSC 52 copy-failure fix, the `/keys edit` dialog, an E2E over-pin
  alignment, a −4 test prune, and a backlog marker. Details in
  `HANDOFF.md`.

## In flight

- [ ] **Nothing in flight on `main`.** Three items are queued behind owner
      decisions (below); no code is mid-landing.
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

## Owner items

- [ ] **GitHub Release page for `v0.0.2`** — manual step (no `gh` CLI on
      this machine); notes body prepared in session. npm side is complete
      (`latest` = `next` = 0.0.2).
- [ ] **Approve the NEEDS-DESIGN test-audit shortlist** (bucket above);
      nothing in it runs without that approval.
- [ ] **Decide the five unmerged worktrees** — merge, abandon, or keep
      (present, verified via `git worktree list`; never remove without the
      call):
      `.tmp/worktrees/release-doc-count` (`docs-release-e2e-count` @
      `8dfcab5`), `.tmp/worktrees/stream-follow-touch`
      (`fix-stream-follow-touch-test` @ `638f8a4`),
      `.tmp/worktrees/stream-scroll-test` (`test-stream-scroll` @
      `ec6c998`), `.tmp/worktrees/user-message-nav-acceptance` (detached @
      `9a96b9d`), `C:/code/tb-lane-touch` (`test-stream-scroll-touch` @
      `dbf0c2f`).
- [ ] Optional: pin a deliberate subagent route model in Settings →
      Models & roles → Subagent (empty = helpers inherit the Junior
      model; per-call override > route model > Junior model).

## Next engineering work (priority order)

1. [ ] **Owner decisions first** (above): audit shortlist, the five
       unmerged worktrees, the release page — then execute whatever the
       audit shortlist approves.
2. [ ] **OAuth-only subscription sign-in** — Copilot/Codex/Kimi managed
       login: device flow, refresh-locked token store, provider headers;
       subscription seeds cover API-key plans only today. Large.
3. [ ] **TUI keybinding surface expansion** beyond the three global chords
       (`/keys edit` now covers those) — needs a per-surface conflict
       model. Backlog.
4. [ ] **Usage follow-ups** — per-role cost, cache-miss deltas, failed-run
       split nuances (backlog item narrowed by the shipped per-role wave).
5. [ ] **Micro**: a dedicated app-level test for the `/keys edit`
       invalid-existing-file refusal (writer side and state source are
       already tested; the refusal path is inspection-verified only);
       `HEAD /assets/*` support (currently 404 on the GET-only static
       handler; no UI impact).

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
- [x] **DONE post-merge:** 11 lane worktrees + 2 standalone clones removed,
      7 merged branches deleted (`-d`), ~2.10 GiB freed. Junction guard:
      each tree's self-referential npm-workspace junction
      `node_modules\@two-brothers\harness` was unlinked before the
      recursive delete.
- [ ] `.tmp/lane-usage-by-role` redundant artifacts — **removed, verified
      absent** (no pending removal).
- [ ] **KEEP the five unmerged worktrees** listed under Owner items until
      the owner decides (merge/abandon/keep). opencode-owned worktrees and
      `Temp/tb-review-tip` are not touched either way.
- [ ] `.tmp/` still holds gate logs/probes — prune inside that one
      directory only (NTFS-junction lesson, `HANDOFF.md` §Incident /
      prevention notes).
- [ ] Keep `research/`, sessions, credentials, logs out of git (this file
      + `HANDOFF.md` are the tracked checkpoint exception).
- [ ] Do not widen `TEMP`/`TMP` = `.tmp/build-temp` beyond standalone web
      builds and `e2e-test.ps1` — package tests/smoke flake
      `tuiintegration` under it (`scripts/AGENTS.md`).

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
