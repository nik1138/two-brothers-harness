# Two Brothers — working TODO (what is left)

Local working plan, tracked as the checkpoint record alongside `HANDOFF.md`
(owner decision 2026-11-14). Landed work is **not** listed here — see
`HANDOFF.md`, `docs/backlog.md`, `docs/release.md`, and the git log. The
2026-11-14 risk-ranked findings queue is fully resolved (every finding
INTEGRATED or DEFERRED); its full table stays in git history, the deferral
register is condensed below.

Last updated: **2026-11-19**.

## Current state

- `main` = `9c354f3`, clean, **pushed and in sync** with `origin/main`.
- **0.0.2 shipped**: tag `v0.0.2` at `354df89`, published to `next` via the
  trusted-publishing workflow (full release gate PASS), promoted to
  `latest` 2026-11-18; global install verified. Only the GitHub Release
  *page* remains (owner manual step, below).
- Live server rebuilt + restarted 2026-11-19 on **:8600** (/, /api/sessions,
  /api/mcp all 200; owner's live sessions present). Provider keys were
  re-entered after the 2026-11-14 incident — that owner task is CLOSED.
- Package baseline on main: **2 611 / 2 603 pass / 0 fail / 8 POSIX-only
  skips** (Windows, both modes; TUI-lane report, acceptance re-verifying).

## In flight

- [ ] **TUI Tab mode-switch — acceptance + merge.** `feat/tui-tab-mode` @
      `dbfac78` (Tab/Shift+Tab cycles consult→work→auto on an empty
      composer; typed composer keeps slash completion). Owner-run
      acceptance: diff review DONE (no concerns); gate matrix running in
      `.tmp/wt-accept-tui-mode` (typecheck, focused TUI suites, full both
      modes — expect 2 614/2 606/0/8, build + selftest, CLI E2E 19+19).
      On GO: ff-merge → merged-tree gates → push → remove both lane
      worktrees + branch.
- [ ] **Blocked lanes — subagent route subscription access.** All four
      lanes spawned 2026-11-19 failed in ~2 s: "Your current subscription
      does not have access to Kimi Code right now" (account/quota
      condition, not code). Resume by agent id when access recovers:
  - agent-320 — `feat/usage-by-role`: per-turn Senior/Junior usage + cache
    split (additive; stop-and-report if already exposed end-to-end).
  - agent-321 — `fix/gemini-schema-whitelist`: widen `geminiSafeSchema`
    with `anyOf`/`pattern`/`minLength`/`maxLength`/`minimum`/`maximum`
    (pure key-whitelist, no reshaping; `docs/backlog.md` non-blocker).
  - agent-322 — read-only test-suite meaningfulness audit (remaining
    duplication after MCP `6d6c553` + override `1746f6f` consolidations).
  - agent-319 — TUI acceptance (superseded if owner gates finish first).

## Owner items

- [ ] **GitHub Release page for `v0.0.2`** — manual step (no `gh` CLI on
      this machine); notes body prepared in session. npm side is complete
      (`latest` = `next` = 0.0.2).
- [ ] Optional: pin a deliberate subagent route model in Settings →
      Models & roles → Subagent (empty = helpers inherit the Junior
      model; per-call override > route model > Junior model).

## Next engineering work (priority order)

1. [ ] Finish the TUI mode-switch cycle (above) — the only open slice of
       the approved O1→O2→M→C observation-parity sequence's follow-on UX.
2. [ ] Per-turn cache statistics / Senior+Junior split (agent-320 lane).
3. [ ] Gemini schema whitelist widening (agent-321 lane).
4. [ ] Test-suite consolidation slices from the audit (agent-322) — owner
       asked twice whether all tests are meaningful; execute only the
       safe, evidence-backed shortlist.
5. [ ] **OAuth-only subscription sign-in** — Copilot/Codex/Kimi managed
       login: device flow, refresh-locked token store, provider headers;
       subscription seeds cover API-key plans only today. Large.
6. [ ] **TUI in-app keybinding editor** — `/keys` show/reload/watch exist;
       editing still needs a JSON file. (Start AFTER the mode-switch
       merge — both touch `tui/app.ts`.)

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

- [ ] TUI external editor / copy polish — verify shipped Ctrl+G / Ctrl+X
      on the current tree; no known open bug.
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

- [ ] After the TUI merge: remove `.tmp/wt-tui-mode` +
      `.tmp/wt-accept-tui-mode` worktrees and `feat/tui-tab-mode`.
- [ ] Stale lane worktrees from merged waves (verify merged, then remove):
      `.tmp/worktrees/{release-doc-count,stream-follow-touch,stream-scroll-test,user-message-nav-acceptance}`,
      `C:/code/tb-{fix-subagent-model-copy,lane-stream-scroll-review,lane-touch}`.
      Never touch worktrees owned by other tools/sessions.
- [ ] `.tmp/` holds months of gate logs/probes — prune inside that one
      directory only (NTFS-junction lesson, `HANDOFF.md` §Incident).
- [ ] Keep `research/`, sessions, credentials, logs out of git (this file
      + `HANDOFF.md` are the tracked checkpoint exception).

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
  version without fresh explicit owner permission.**