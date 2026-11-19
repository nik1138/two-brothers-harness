# Two Brothers — handoff

Local working handoff, tracked as the checkpoint record (owner decision
2026-11-14). The frozen historical snapshot is `docs/history/handoff.md`;
this file is the current state for the next session. The previous refresh
(the 0.0.2 checkpoint, `3063d01`) is superseded by this one — its full
detail stays in git history; release mechanics and evidence live in
`docs/release.md`.

Last updated: **2026-11-19**. **Checkpoint: `main` = `7834514`** — clean,
pushed, in sync with `origin/main` (0 ahead, 0 behind).

## Current state

| Item | Value |
|---|---|
| Branch / HEAD | `main` = `7834514` = `origin/main` (feat(tui): in-app editor for the three global key chords) |
| Published | **0.0.2 on `latest` AND `next`**; tag `v0.0.2` at `354df89` (pushed). No tag, publish, or version bump this session — the next release repeats `docs/release.md` and needs fresh explicit owner permission |
| Session window | started at `c80c855` (TUI Tab mode was already accepted, merged, and pushed pre-session — merged-tree evidence 2 614 / 2 606 / 0 / 8 plus CLI 19+19 in `.tmp/merged-gates-tui`; the old handoff was stale on that) → `7834514`: **8 commits in two waves**, every feature independently accepted in a separate lane before merge |
| CI | the publish workflow ran the full release gate at `v0.0.2` — PASS (per-suite counts are in the GitHub Actions run log). No new release this session, so no new Gate run to cite |
| Package suite baseline | **2 671 total / 2 663 pass / 0 fail / 8 POSIX-only skips**, Windows, merged tree, in BOTH `npm test` and `npm run test:spawn` |
| Web / browser / CLI / faults | web **747 / 747 / 0 / 0**; browser E2E **44 PASS / 0 FAIL / 1 SKIP** (opt-in real); hermetic CLI E2E **19 + 19** (sources + `--dist`); loopback real-socket fault injection **7/7**; reference selftest PASS + **33/33**; `SMOKE TEST: PASS` |
| Live server | **running**, refreshed 2026-11-19 ~15:53 to `7834514`: `node dist/cli.js serve --port 8600 --sessions-dir sessions` (PID **69528**, cwd `packages/harness`, logs `.tmp/live-serve/`). Verified: `GET /` 200 serving the new bundle `index-BAtTsj25.js`, `/api/sessions` 200 with BOTH preserved sessions (`2026-11-14T16-33-32-134-4176c1`, `2026-11-14T16-39-48-429-066581`), `/api/mcp` 200. Store: `packages/harness/sessions` |
| Packaged web copy | `npm run sync-web` SHA256-identical, 3/3 files (`index.html`, `index-BAtTsj25.js`, `index-BdQuArRh.css`) against `web/dist` |
| Provider keys | re-entered by the owner after the 2026-11-14 incident; that owner task is closed and live Gemini/LM Studio runs used through the usage waves |
| Known environment quirk | `HEAD /assets/*` returns 404 (GET-only static handler; no UI impact) — recorded, not a regression |

## Shipped since the last checkpoint (`c80c855` → `7834514`, 8 commits)

Two waves. Every feature was independently accepted in its own lane before
merge; a single merged-tree FAIL blocks the push, as designed.

- `dbe5908` **test: prune subsumed and constant-only tests** per the
  meaningfulness audit — −4 (one subsumed server workspaces CRUD test plus
  three internal constant pins). The owner **kept the 6 published-cap pins**
  as contract pins (decision 2026-11-19).
- `eb7ec74` **fix(provider): widen the Gemini tool-schema key whitelist**
  with `anyOf` / `pattern` / `minLength` / `maxLength` / `minimum` /
  `maximum` — pure key filter, function body byte-identical, +3 tests; plus
  `415ca17` docs(backlog) shipped marker.
- `3c3a03b` **feat(usage): per-turn Senior/Junior usage and cache split** —
  `PromptAuditEntry.usage?`, `HarnessResult.usageByRole?`, a display-only
  `call_usage` runtime event after each call, the CLI split block before the
  byte-stable footer, `--json usage_by_role`, print/verbose surfaces;
  +11 tests; additive, protocol untouched.
- `25ad359` **test(e2e): accept the additive `call_usage` frame before
  `tool_started`** — a strict contract-shaped alignment of an over-pinned
  adjacency assertion; unblocked the merged-tree smoke. Whole-repo over-pin
  survey done.
- `7f4f062` **fix(tui): report OSC 52 copy failure** when the terminal
  suppresses it — `TERM=dumb` false-success toast fixed via a throwing
  `writeClipboardSequence` sink; +5 tests; the OSC 52 100 000-character cap
  documented; the copy description wording made honest.
- `44e28be` **feat(usage): per-role usage on run records, web footer/status
  and TUI panel** — `run_end`/`RunRecord usage_by_role` additive plus
  sidecar `call_usage` recovery, old sessions merged-only; web
  `UsageFooter` + `SessionStatusDialog` split with old-backend fail-soft;
  TUI Ctrl+B sidepanel rows; tool-preview browser scenario extended;
  +13 package / +8 web tests. **Documented limitation:** the footer split is
  hidden at the drawer breakpoint ≤768px to protect parked readers;
  `/status` shows it at every width.
- `7834514` **feat(tui): in-app editor for the three global key chords** —
  `/keys edit` dialog: capture through the existing keys-file grammar,
  `resolveTuiCommands` validation, atomic 0600 save, fixed-key /
  other-global / reserved refusals, repeat/IME/paste-safe, honest
  no-file/invalid-file behavior, reset-all row; +27 tests; fixed keys
  unchanged.

### Test-meaningfulness audit (owner asked twice; answered)

Report: `.tmp/test-audit-report.md`. Verdict: the suite is meaningful
overall — no duplicate suites, no mock-verifies-itself clusters; apparent
duplication is deliberate layering. The safe slice was executed (−4). The
owner decision is to **keep** the 6 published-cap constant pins. A
**NEEDS-DESIGN** bucket is queued (~24–29 tests): web source-string wiring
consolidation is the largest (−15…−20 — only CI wiring coverage exists
since browser E2E is opt-in, so consolidate/replace, never blind-delete);
approval/deny overlap −2 with one unique artifact case to relocate; plugins
endpoint −1; four mirror pairs −4 table-driven; storage-failure pairs −2.
Estimated total removable 28–39 (~1.1–1.5%) if the web wiring is accepted.
**Execute only with the owner's shortlist approval.**

### Verifications closed

Ctrl+G external editor + Ctrl+X copy are **shipped and verified** on the
current tree (149 focused tests green; dispatch/modality/security traced;
no material docs drift) — the `todo.md` smaller item is closed.
Micro-follow-ups recorded: (a) the `/keys edit` invalid-existing-file
refusal is inspection-verified but lacks a dedicated app-level test (the
writer side and the state source are tested); (b) the `HEAD /assets/*` 404
quirk above.

### Hygiene done this session

Early: 2 verified-merged stale worktrees removed
(`C:/code/tb-fix-subagent-model-copy`, `C:/code/tb-lane-stream-scroll-review`)
plus their branches (cherry-evidence, `-D` after a `-d` refusal); 134
disposable `.tmp` probe directories pruned (~23.8 MiB). Post-merge: 11 lane
worktrees + 2 standalone clones removed, 7 merged branches deleted (`-d`),
~2.10 GiB freed; junction guard used — each tree's self-referential
npm-workspace junction `node_modules\@two-brothers\harness` unlinked before
the recursive delete. `.tmp/lane-usage-by-role` redundant artifacts are
removed (verified absent). Unmerged worktrees were **kept** awaiting the
owner's decision (never remove those): `.tmp/worktrees/release-doc-count`,
`.tmp/worktrees/stream-follow-touch`, `.tmp/worktrees/stream-scroll-test`,
`.tmp/worktrees/user-message-nav-acceptance`, `C:/code/tb-lane-touch`.
opencode-owned worktrees and `Temp/tb-review-tip` were never touched.

## In flight

Nothing is in flight on `main` — the tree is clean and fully pushed.

### Unmerged worktrees awaiting the owner's decision (do not remove)

| Worktree | Branch / commit |
|---|---|
| `.tmp/worktrees/release-doc-count` | `docs-release-e2e-count` @ `8dfcab5` |
| `.tmp/worktrees/stream-follow-touch` | `fix-stream-follow-touch-test` @ `638f8a4` |
| `.tmp/worktrees/stream-scroll-test` | `test-stream-scroll` @ `ec6c998` |
| `.tmp/worktrees/user-message-nav-acceptance` | detached @ `9a96b9d` |
| `C:/code/tb-lane-touch` | `test-stream-scroll-touch` @ `dbf0c2f` |

Each needs a merge / abandon / keep call from the owner before it can be
cleaned up. `git worktree list` confirms all five are present.

## Incident / prevention notes (kept)

### Incident (2026-11-14)

An NTFS-junction-traversing cleanup emptied main-checkout
`packages/harness`; tracked files were restored, but untracked `sessions/`
content (sessions, settings incl. sealed keys, sidecars, child logs) was
permanently lost. Keys have since been re-entered and live runs resumed.
**Never point recursive cleanup/delete tools at the repo root, worktree
parents, or any path that can contain NTFS junctions; keep destructive
commands inside one known directory.**

### Session lessons (2026-11-19)

1. **Subagent sandbox policy is fixed at spawn.** Lanes spawned under
   `workspace-write` stayed confined (git/`.git` writes, spawn `EPERM`) even
   after the owner switched the session to `danger-full-access`; only fresh
   spawns inherit the new policy. The confined lanes used local-clone
   fallbacks (accepted; their branches were fetched into the main repo for
   acceptance/merge). An ACL diagnostic ran `NOT_THIS_CLASS` at the repo
   root (report `.tmp/acl-repair/`).
2. **Acceptance briefs must include the hermetic SERVER E2E layer plus the
   smoke gate, not just CLI E2E.** The `call_usage` adjacency over-pin
   slipped through the per-lane gates and was caught by merged-tree smoke —
   one FAIL blocks the push, as designed.
3. **The `TEMP`/`TMP` → `.tmp/build-temp` override is only for standalone
   web builds and `e2e-test.ps1`.** Widening it to package tests or the
   smoke gate flakes `tuiintegration` (see `scripts/AGENTS.md`).

## Commands / verification

Use Windows PowerShell (not `pwsh`; it is not installed):

```powershell
cd C:\code\two-brothers-harness

# package
cd packages/harness
npm run typecheck
npm test                     # and: npm run test:spawn
npm run build

# web
cd ..\..\web
npm test
npm run build

# packaged web copy (server serves this)
cd ..\packages\harness
npm run sync-web

# offline gate / browser matrix / rehearsal
cd ..\..
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/smoke-test.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/e2e-test.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/release-rehearsal.ps1

# one browser scenario
$env:TWO_BROTHERS_E2E_ONLY='settings-subagent'; node e2e/run.mjs
```

Web-build gates on Windows need `TEMP`/`TMP` inside the checkout
(`.tmp/build-temp`) — the smoke/rehearsal scripts scope this themselves.
Do not run the live server and the smoke gate against the same sessions
dir at the same time (writer lock); lane worktrees have their own.

## Constraints / owner decisions

- The brothers are peers with one shared context; subagents are a helper
  tier below them, never protocol peers.
- `PROTOCOL.md` byte-stable markers unchanged; runtime events/web types
  stay additive.
- **Pushing `main` is approved** (settled pattern: merge verified work,
  then push). **No tag, publish, or version bump without fresh explicit
  owner words.** 0.0.2 is fully shipped on npm; the next release repeats
  `docs/release.md`.
- No new runtime dependencies without a ledger entry in
  `docs/history/ts-rewrite-plan.md`; `web/` keeps building; `typescript/`
  stays zero-dependency.
- Conventional Commits for all lane work.
- Independent acceptance before merge (separate lane or owner — never the
  implementer alone).

## Next moves

Per `todo.md`'s priority order:

1. **Owner decisions:** the NEEDS-DESIGN audit shortlist; the five unmerged
   worktrees (merge/abandon/keep); the GitHub Release page for `v0.0.2`
   (manual — no `gh` CLI on this machine).
2. **OAuth-only subscription sign-in** — large: device flow,
   refresh-locked token store, provider headers; the subscription seeds
   cover API-key plans only.
3. **TUI keybinding surface expansion** beyond the three globals — needs a
   per-surface conflict model (backlog).
4. **Usage follow-ups:** per-role cost, cache-miss deltas, failed-run split
   nuances (backlog item narrowed).
5. **Micro:** an app-level `/keys edit` invalid-file test; `HEAD /assets/*`
   support.

The deferred register is unchanged (F/D designs, structural candidates
TUI-R/CHAT-R/SET-S/BE-R, hypotheses, WAN/soaks manual, POSIX hardware
validation, the true-virtualization epic, third sibling not on the backlog).

## Handoff checklist

- [ ] Read `AGENTS.md`, `docs/backlog.md`, this file, and `todo.md`.
- [ ] Confirm `git status` clean and `git log -1` is the expected commit
      (`7834514` on `main`).
- [ ] Check the background-task panel for running gates/lanes before
      starting new ones (stale-serve writer-lock gotcha above).
- [ ] Run package + web tests and the smoke gate on the merged tree.
- [ ] Rebuild + `sync-web` + restart `serve` before handing back
      (**done this session**: PID 69528, endpoints 200, bundle
      `index-BAtTsj25.js`, sync-web 3/3 SHA256-identical).
- [ ] Keep `research/`, sessions, credentials, logs out of git (this file
      and `todo.md` are the tracked checkpoint exception).
- [ ] No publish/tag/version bump without explicit owner permission.
