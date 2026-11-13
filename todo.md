# Two Brothers — working TODO (what is left)

Local working plan. Gitignored; not project documentation. Landed work is
**not** listed here (see `handoff.md`, `docs/backlog.md` and the git log).

Last updated: **2026-11-14**.

## Current state

- **All gates were validated at `3f07d316`** (strict plugin selection parity
  checkpoint). Local `main` now also carries **docs-only follow-ups**
  `668536a`, `987f316`, `ba1e0e4` (only `docs/release.md` /
  `docs/testing.md`) plus this handoff once merged — **local-only, NOT
  pushed**; `origin/main` = `7f0d2c4` (O1, CI #98 green). Integrated and
  validated: O2 TUI helper controls (`f963707`), M per-call overrides
  (`1cc25d4`), C helper roll-up (`02c0ad9`), and the improvement-lane wave —
  cooperation correctness (`3be613c`), TUI helper-overlay correctness
  (`281f6a1`), provider/transport hardening (`9b6b211`, `facb6bf`, `cd45f65`,
  `6b65876`), web fixes (`5a8aee0`, `a850b54`, `0a33154`, `f9468f6`,
  `846b911`), bounded MCP shutdown + run history (`fcb7377`, `9702476`),
  plugin registration/timeouts/bundles/strict parity (`fe74921`, `029659c`,
  `975e42e`, `dd54392`), E2E backend cleanup + skip registry (`b631530`,
  `d248e8d`), plus infra/test-isolation fixes.
- **Incident 2026-11-14 (cause known: NTFS junction traversal):** an earlier
  cleanup emptied main-checkout `packages/harness`; tracked files were
  restored, deps/dist rebuilt, gates re-run green — but untracked
  `packages/harness/sessions` (sessions, settings incl. sealed keys, runtime
  sidecars/subagent logs) is **permanently lost**. Provider keys must be
  re-entered; the live server is to be rebuilt/restarted after the docs lane.
  Details: `HANDOFF.md` §Incident (2026-11-14).
- Subagent wave fully shipped: phase 1 read-only helpers (`7cdcdce`),
  settings route (`32fc970`), phase 2 mutating helpers (`d1518a9`+`c445eee`),
  controls A1/A2/B (`27800c4`/`0725545`/`1079917`), real auto + solo
  (`bd5c6d7`+`dcd9f0a`), models.dev catalog (`e51c54f`), observation parity
  O1 (`7f0d2c4`) + **O2 (`f963707`) + M (`1cc25d4`) + C (`02c0ad9`)**.
  **F forked-context + D depth>1 DEFERRED** to their own designs; no new
  designs started.
- Verified at `3f07d316`: package **2 461 / 2 453 pass / 0 fail / 8 skips**
  (`npm test` and `test:spawn`, Windows); WSL Node 22 + 24 each **2 461 /
  2 460 / 0 fail / 1 skip** in both modes + hermetic server 4/4; web
  **608/608**; CLI E2E **19/19 source + dist**; browser raw log **38
  hermetic PASS / 0 FAIL / 1 real SKIP** + helpers **18/18**; tarball
  **7/7 + pack check**; smoke **PASS** (faults 7/7, hermetic server 4/4).
- No version bump, tag, or publish in this wave; nothing pushed.

## Owner / release gates

- [ ] **Restore live state** — re-enter provider API keys in Settings
      (sealed keys lost in the 2026-11-14 incident), rebuild + restart
      `serve` on :8600, re-create check sessions.
- [ ] **0.0.2 release** — only with explicit owner permission. Push the
      current `main` (whatever its tip is at release time), watch CI, bump
      version, curate the changelog, update release docs, run
      `scripts/release-rehearsal.ps1`, then independent E2E lanes:
      browser matrix, CLI source + `--dist`, packed-tarball clean install,
      WSL Linux typecheck + full suite. Tag/publish/promote only after all
      PASS.
- [x] **Watch CI** for `32fc970`/`7cdcdce` — DONE: both red, root cause
      `c6e41b4` (not the subagent wave), fixed and pushed as `809de6c`;
      run #90 GREEN on all three legs (2026-11-12).
- [ ] Optional: set the live subagent route to a deliberate model in
      Settings → Models & roles → Subagent (currently empty, so helpers keep
      the Senior/Junior `role` fallback).

## Next engineering work (priority order)

1. [x] **Subagent phase 2 — mutating helpers.** **SHIPPED 2026-11-12**
       (`d1518a9` + `c445eee`; design + owner decisions + errata:
       `.tmp/research/subagent-phase2-design.md`). Child gets the workspace
       write/edit/delete/shell tools with **child-tagged approvals** routed
       into the parent run and an explicit child identity on the card. Keep
       the child permission scope fixed at spawn (no widening). Tests must
       cover allow/deny/stop and no child approval leaks into the wrong run.
2. [x] **Subagent controls — COMPLETE.** *(Design
       `.tmp/research/subagent-controls-design.md`; **A1 interrupt SHIPPED
       `27800c4`**; **A2 operator follow-ups SHIPPED `0725545`**; **B
       background + model tools SHIPPED `1079917`** — opt-in
       `subagent({background:true})`, `list_agents`/`send_message`/
       `interrupt_agent`/`subagent_report`, 40-call budget, run-end
       cancellation with 2s grace; Node 22 reap-timer fix `1079917`.)*
3. [x] **Subagent observation parity — COMPLETE.** *(Design
       `.tmp/research/subagent-observation-design.md` §14, sliced
       O1→O2→M→C, F/D carved out. **O1 SHIPPED `7f0d2c4`; O2 SHIPPED
       `f963707`; M SHIPPED `1cc25d4`; C SHIPPED `02c0ad9`** — all merged to
       local `main` and validated at `3f07d316`.)* **F forked-context and D
       depth>1 remain DEFERRED** to their own designs; no new designs started.
4. [x] **Real `auto` + Senior solo decision.** **SHIPPED 2026-11-13**
       (`bd5c6d7` + `dcd9f0a`; design + owner decisions:
       `.tmp/research/auto-solo-design.md`). Model-declared routing,
       fail-closed consult, solo per PROTOCOL.md §5, zero protocol changes.
       Original gap: `auto` reduces to
       `consult`; the Senior always goes through the Junior. Decide the
       task-content policy and add the solo decision branch without breaking
       the protocol/byte-stable transcript.
5. [x] **models.dev catalog browse/import — SHIPPED `e51c54f`.** *(Design
       `.tmp/research/models-dev-catalog-design.md` §15 two deviations:
       persist `catalog_id` now, default selection none + Select-all.
       Independent acceptance: WSL Node 22/24 2 291/0 fail/0 cancelled,
       smoke exit 0, browser matrix 30 PASS + 1 real SKIP; live route
       source=network 236 providers.)* Read-only
       `GET /api/models-dev/providers[/{id}]` with a server-side cache,
       prefilling the existing Add-provider form; no whole-catalog shipping,
       no runtime dependency on models.dev, keep the curated seed fallback.
6. [ ] **OAuth-only subscription sign-in.** Copilot/Codex/Kimi managed login
       needs a device flow, refresh-locked token store and provider headers;
       today the subscription seeds cover API-key plans only.
7. [ ] **Per-turn cache statistics / Senior+Junior split.** Additive
       prompt-audit or usage-by-role field; the combined footer percentage
       already works and helper usage is separate.

## Smaller / deferred

- [ ] **TUI in-app keybinding editor** — `/keys` show/reload/watch exist;
      editing still needs a JSON file.
- [ ] **TUI external editor / copy polish** — verify the shipped Ctrl+G and
       Ctrl+X behaviors on the current tree; no known open bug.
- [ ] **Stacked-dialog mask-click guard** — blocked on naive-ui > 2.45.3;
      re-check after the next release.
- [ ] **WAN fault injection / long soaks** — deliberately manual (real
      endpoint + time budget); offline gates cover hermetic retry/timeout/
      overflow/quota.
- [ ] **POSIX hardware validation** — detached `run_shell` group reaping and
      real SIGHUP delivery remain Windows-unproven; hermetic seam tests only.
- [ ] **True variable-height web transcript virtualization** — windowing is
      shipped; full virtualization remains a design epic.
- [ ] **Third sibling / more protocol roles** — not on the current backlog;
      would be a protocol-level change, not a subagent tweak.

## Local hygiene

- [ ] **Re-enter provider API keys + rebuild live state** — sealed
      `settings.json` was permanently lost in the 2026-11-14 incident; no
      sessions survive either.
- [ ] Delete ignored local evidence dirs/`version/`/`--version/` when done.
- [ ] Decide whether the tarball should ship `dist/*.map` files.
- [ ] Keep `research/`, sessions, credentials and logs out of git.
      *(Owner decision 2026-11-14: `HANDOFF.md` + `todo.md` themselves are
      committed as the final-checkpoint record on `docs-final-handoff` —
      this one exception only.)*

## Constraints

- Keep the shared-context Senior/Junior cooperation and the
  `PROTOCOL.md` byte-stable markers.
- Subagents are a helper tier below the two protocol peers; they are not
  protocol peers and must not join the brothers' transcript.
- No new runtime dependencies without a ledger entry; web stays Vue 3 +
  naive-ui; `typescript/` stays zero-dependency.
- `web/` must keep building and `packages/harness` must keep passing
  `npm run check`/pack gates.
- Never commit `research/`, sessions, credentials, logs, screenshots or
  tarballs. *(Exception by owner instruction 2026-11-14: this checkpoint
  pair `HANDOFF.md` + `todo.md` on `docs-final-handoff`.)*
- Never publish, tag, or bump the version without explicit owner permission.
