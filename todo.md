# Two Brothers — working TODO (what is left)

Local working plan. Gitignored; not project documentation. Landed work is
**not** listed here (see `handoff.md`, `docs/backlog.md` and the git log).

Last updated: **2026-11-14**.

## Current state

- **All gates were validated at `9f353c4`** (the code merge of the
  goal-integration wave). Local `main` now also carries the **docs-only
  cleanup `92af62a`** (stale helper fallback claims, at record time) plus
  this record — **local-only, NOT pushed**; local `main` is **132 commits
  ahead** of `origin/main` = `7f0d2c4` (O1, CI #98 green; count at record
  time, tip `92af62a`). Integrated and validated: O2 TUI helper controls (`f963707`),
  M per-call overrides (`1cc25d4`), C helper roll-up (`02c0ad9`), the
  improvement-lane wave — cooperation correctness (`3be613c`), TUI
  helper-overlay correctness (`281f6a1`), provider/transport hardening
  (`9b6b211`, `facb6bf`, `cd45f65`, `6b65876`), web fixes (`5a8aee0`,
  `a850b54`, `0a33154`, `f9468f6`, `846b911`), bounded MCP shutdown + run
  history (`fcb7377`, `9702476`), plugin registration/timeouts/bundles/
  strict parity (`fe74921`, `029659c`, `975e42e`, `dd54392`), E2E backend
  cleanup + skip registry (`b631530`, `d248e8d`) — and the full
  code-quality wave with merge SHAs `17867f9` (chat), `1eef5fe` (TUI
  fixes), `7f28044` (TUI fold), `99a108b` (settings), `d0b851b` (fsPath),
  `e1b6eeb` (backend), `67ccba1` (workspace), `3009748` (MCP), `52fbfa5`
  (CLI/subagent), `3fe647f` (E2E fail-fast). Every reviewed audit finding
  is **integrated or explicitly deferred** (technical reasons below).
- **Incident 2026-11-14 (cause known: NTFS junction traversal):** an earlier
  cleanup emptied main-checkout `packages/harness`; tracked files were
  restored, deps/dist rebuilt, gates re-run green — but untracked
  `packages/harness/sessions` (sessions, settings incl. sealed keys, runtime
  sidecars/subagent logs) is **permanently lost**. Provider keys must still
  be re-entered (owner task). The live server itself was **rebuilt and
  restarted on 2026-11-14** (verified by the server lane on `c52554a`): PID
  247580 `node dist/cli.js serve --port 8600 --sessions-dir sessions`,
  `GET /` and `GET /api/sessions` (`[]`) 200, served assets byte-identical
  to fresh `web/dist`, process scan clean, sessions/settings untouched.
  Details: `HANDOFF.md` §Incident (2026-11-14).
- Subagent wave fully shipped: phase 1 read-only helpers (`7cdcdce`),
  settings route (`32fc970`), phase 2 mutating helpers (`d1518a9`+`c445eee`),
  controls A1/A2/B (`27800c4`/`0725545`/`1079917`), real auto + solo
  (`bd5c6d7`+`dcd9f0a`), models.dev catalog (`e51c54f`), observation parity
  O1 (`7f0d2c4`) + **O2 (`f963707`) + M (`1cc25d4`) + C (`02c0ad9`)**.
  **F forked-context + D depth>1 DEFERRED** to their own designs; no new
  designs started.
- Verified at `9f353c4` (goal-wave final gate, integrated main): package
  **2 488 total / 2 480 pass / 0 fail / 8 skips** in BOTH `npm test` and
  `test:spawn` (Windows); CLI E2E **19/19 source + 19/19 `--dist`**; web
  **668/668 + build PASS**; browser full 40-block matrix **41 PASS lines /
  0 FAIL / 1 opt-in `real` SKIP** + helpers **20/20**; smoke **PASS**
  (faults 7/7, hermetic server 4/4). Tarball smoke and the WSL pass were
  not re-run in this gate — their last records stay at `3fe647f` (below).
  The docs-only cleanup `92af62a` after `9f353c4` does not change tested
  code.
- Verified at `3fe647f` (quality-wave final gates; WSL + tarball not
  re-run for the goal wave): package **2 483 / 2 475 pass / 0 fail / 8 skips**
  (`npm test` and `test:spawn`, Windows); WSL Node 22.22.2 + 24.16.0 each
  **2 483 / 2 482 / 0 fail / 1 skip** in both modes + typecheck PASS +
  hermetic server 4/4; web **642/642 + build PASS**; CLI E2E **19/19
  source + dist**; browser **39 hermetic PASS / 0 FAIL / 1 real SKIP** +
  helpers **20/20**; tarball **7/7 + pack check**; smoke **PASS** (faults
  7/7, hermetic server 4/4). Environment caveats (not product failures):
  WSL22 `/mnt/c` `npm test` exit 1 after all assertions passed (post-test
  HTTP-socket `TypeError`; standalone file 48/48 and an identical native
  ext4 full suite 2 483/2 482/0 fail/1 skip exit 0 pin it to `/mnt/c`);
  WSL24 initial `/mnt/c` runs hit a bounded TUI timing flake
  (`tuiintegration:1460`), bounded reruns passed.
- No version bump, tag, or publish in this wave; nothing pushed.

## Goal wave (2026-11-14) — records lane (base `6052ff7`)

Shipped on the integrate-goal line (`main..6052ff7`); recorded on
`docs-goal-records`:

- **Scroll-follow hold + survivor compensation** (`6718060` + `27cb175`):
  `{ nearBottom, hold }` pure follow model in `web/src/followScroll.ts` —
  deliberate upward wheel/touch/key movement engages the hold even when the
  landing stays in-band; the async onScroll cannot re-enable the pin; only a
  real return to the bottom edge (2px epsilon) releases it; gesture,
  nested-scroller, and multi-touch guards; survivor search skips re-inserted
  show-earlier chrome (~20px first-append drift fixed); new `stream-follow`
  + `stream-follow-touch` browser scenarios.
- **Absolute Junior model fallback** (`20ed3cc` + `234b38e`): helper model =
  per-call override > explicit route model (empty = unset) > the Junior
  role's model, unconditionally; `role` selects the connection endpoint
  only; default resolved per spawn, never written back; the wire model and
  the reported row can never diverge.
- Verified at `6052ff7`: package gates **2 488 total / 2 480 pass / 0 fail /
  8 skips** in BOTH `npm test` and `test:spawn`; hermetic CLI E2E (sources)
  **19/19**; runtime independent behavior **17/17**; web **668/668** + build
  green; browser-E2E helpers **20/20**; focused `stream-follow` **5/5**;
  repaired `stream-follow-touch` **10/10**; unfixed-base touch-sensitivity
  control **10/10 FAIL** on the exact autoscroll re-pin signature.
- **Final gate at `9f353c4` (integrated main), run 2026-11-14:**
  package gates **2 488 total / 2 480 pass / 0 fail / 8 skips** in BOTH
  `npm test` and `test:spawn`; hermetic CLI E2E **19/19 sources + 19/19
  `--dist`**; web **668/668** + build green; full 40-block browser matrix
  **41 PASS lines / 0 FAIL / 1 opt-in `real` SKIP**; helpers **20/20**;
  offline smoke gate **PASS** (faults 7/7, hermetic server 4/4). Tarball
  smoke and the WSL pass were **not re-run** in this gate — last records at
  `3fe647f` (Current state above). The docs-only cleanup `92af62a` after
  `9f353c4` does not change tested code.

## Owner / release gates

- [ ] **Re-enter provider API keys + re-create check sessions (owner)** —
      the server half of the live-state restoration is **DONE and
      re-verified live** (2026-11-14, on main `92af62a` — docs-only after
      the gated code merge `9f353c4`): package + web builds PASS,
      `sync-web` byte-identical to the current UI, one intended backend
      running: PID 271100 `node dist/cli.js serve --port 8600
      --sessions-dir sessions`, `GET /` and `GET /api/sessions` 200 with
      both preserved user sessions (…4176c1 and …066581),
      process scan clean (exactly one intended server), sessions/settings
      preserved. What remains: sealed provider keys were permanently lost
      in the incident, so the owner must re-enter them in Settings before
      any live run, then re-create check sessions. (The separate real
      streaming UI validation is DONE — verified PASS 2026-11-14, recorded
      on branch `docs-goal-live-acceptance`: real LM Studio `lfm3-1.7b`
      streaming; wheel-up parked the reader with max anchor drift 0 across
      9 growth pairs; return to bottom resumed following with max fromBottom
      0 across 7 growth frames; no console errors; test run stopped and the
      generated test session deleted; original two sessions preserved.)
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
      Settings → Models & roles → Subagent (currently empty, so helpers run
      the Junior role's current model — per-call override > route model >
      Junior model; `role` picks persona/connection only).

## Next engineering work (priority order)

**Active cycle — code-quality/correctness queue (2026-11-14) — COMPLETE.**
Four read-only audits ran against `d98ec79`: TUI, web chat/composer, web
settings/navigation, backend/runtime. The risk-ranked queue below
condenses every confirmed finding, hypothesis, deferral, and structural
candidate. Fix lanes `quality-tui-fixes`, `quality-chat-fixes`,
`quality-settings-fixes`, `quality-backend-fixes` started from `d98ec79`
— a started lane is **not** a shipped fix; statuses below track evidence,
not intention. All reviewed code/test-infrastructure findings are now
**integrated or explicitly deferred** (INTEGRATED rows carry SHAs and
acceptance counts). Final verification is **COMPLETE** on exact commit
`3fe647f8901dcd99b953c6f9105c498fa31609e3` — the final gate block is
below; the prechecks beneath it remain historical evidence only. The
remaining-core audit (CLI / workspace edit-diff /
settings-write / config / subagent runner / runstream / instructions +
the MCP timeout verdict) is **complete** — its conclusions are recorded
below as CORE-F1..F5 plus no-finding notes. The paused OAuth (item 6),
cache statistics (item 7), and TUI keybinding-editor items are **outside
this goal**.

Largest production files (corrected line counts, 2026-11-14):
`packages/harness/src/tui/app.ts` 5264, `packages/harness/src/cli.ts`
4813, `packages/harness/src/server.ts` 4478,
`packages/harness/src/harness.ts` 4339, `web/src/components/Composer.vue`
3574, `packages/harness/src/provider.ts` 3051,
`web/src/components/ChatView.vue` 2374,
`packages/harness/src/workspace.ts` 2070,
`web/src/components/settings/ProvidersSection.vue` 1914,
`packages/harness/src/tui/view/helpers.ts` 1461. Other large components
were reviewed for workflow coverage: TUI `keymap.ts` (1041),
palette/approval views, `terminal.ts`, `steering.ts` — no findings;
TUI `model.ts` (1000) (finding TUI-B2 listed below); web
`SettingsDialog.vue` (1235), `WorkspaceFinder.vue` (1085), `Sidebar.vue`
(973) (findings listed below; `WorkspaceFinder` lifecycle/guards
specifically clean); backend `runtime.ts` (1263),
`runevents.ts` (1187), `sessionlayout.ts` (988), `compaction.ts` (637),
`session.ts` (458), provider retry/registry internals — no findings.
`settings_store.ts` (1142) — no finding; `mcp.ts` (634) —
timeout verdict recorded below (residual gap CORE-F3).

### Risk-ranked findings queue

Confirmed findings, by severity. Rows marked **INTEGRATED** landed with
independent acceptance and a merge to local main (SHA + counts in the
row); rows marked in progress are **not** shipped. The Google-`maxTokens`
nit (BE-F6a) is integrated with the BE batch; the `prompt_tokens` nit
(BE-F6b) is deferred with a technical reason (below). Unconfirmed
hypotheses (CHAT-F4, SET-H1) remain excluded from the implementation
lanes — deferred, not in flight.

| ID | Sev | Finding | Evidence | Status |
|---|---|---|---|---|
| CHAT-F1 | Med-High | Welcome-screen submit never consumed: accepted text persists as draft under the newly created session and reappears on revisit (duplicate-run risk) | `web/src/components/Composer.vue:566-586`, `App.vue:2197-2214` | INTEGRATED — `3b93640` + `6c9303e` + `215a512`, merge `17867f9`; acceptance full web 633/633, build PASS, focused find/folding 36/36, browser neighbors green |
| TUI-B1 | Low-Med | Resume is reachable during an active `/compact`; the old session's summary commits into the new session's transcript (display corruption only, no on-disk damage) | `packages/harness/src/tui/app.ts:3961-4024`, `3734-3823` | INTEGRATED — `6a4bebc`, merge `1eef5fe`; acceptance focused 109/109, package both modes 2464/2456/0 fail/8 skip, CLI 19/19, faults 7/7 |
| BE-F1 | Low-Med | Steering past `MAX_STEERING_ENVELOPES_PER_RUN` is silently dropped: steers already accepted with HTTP 200 vanish at `finish()` with no `steering_dropped` event (contradicts "a drop is never silent") | `packages/harness/src/harness.ts:1782` | INTEGRATED — impl `8ff2d61`, merge `e1b6eeb`; acceptance 181 focused, full 2465/2457/0 fail/8 skip, CLI 19/19 |
| TUI-B2 | Med (perf) | `nextBlockId` rescans all block ids per new block — O(n²) transcript growth; collision-skip loop is provably dead work | `packages/harness/src/tui/model.ts:196-202` | INTEGRATED — `6a4bebc`, merge `1eef5fe`; acceptance focused 109/109, package both modes 2464/2456/0 fail/8 skip, CLI 19/19, faults 7/7 |
| SET-C1 | Low-Med | Deleted provider row survives a failed refetch (UI shows it cleared, editing it 404s) | `web/src/components/settings/ProvidersSection.vue:559-585` | INTEGRATED — impl `f83c566` + `30830523`, merge `99a108b` (verified, parent-supplied); acceptance providerSettings 37/37, full web 610/610 on branch, build PASS, helpers 18/18, settings-quality / provider-reset / settings-subagent / settings-preset-sync / workspace-drag all PASS |
| CHAT-F2 | Med-Low | Find-in-transcript cache not invalidated on `liveRunId`/`dockedApprovalId` change: ghost matches + transcript yanked to top | `web/src/components/ChatView.vue:858-866` | INTEGRATED — `3b93640` + `6c9303e` + `215a512`, merge `17867f9`; acceptance full web 633/633, build PASS, focused find/folding 36/36, browser neighbors green |
| SET-C2 | Low | Wrong empty state under a workspace filter ("No sessions match" + dead "Clear search"; no way back to All workspaces) | `web/src/components/Sidebar.vue:492-497` | INTEGRATED — impl `f83c566` + `30830523`, merge `99a108b` (verified, parent-supplied); same acceptance as SET-C1 |
| SET-C3 | Low | Subagent role invisible in provider usage badges / delete-impact copy ("No role uses this provider") though the backend clears the subagent ref on delete | `ProvidersSection.vue:107-115`, `web/src/providerSettings.ts:211-286`, `packages/harness/src/server.ts:3619-3624` | INTEGRATED — impl `f83c566` + `30830523`, merge `99a108b` (verified, parent-supplied); same acceptance as SET-C1 |
| SET-C4 | Low | Deletion focus-fallback timers (up to ~8 × 800 ms) not cancelled on unmount; a late tick can steal focus | `web/src/components/Sidebar.vue:255-268` | INTEGRATED — impl `f83c566` + `30830523`, merge `99a108b` (verified, parent-supplied); independent red/green unmount and no-unmount plus normal recovery coverage; same acceptance as SET-C1 |
| SET-C5 | Low (a11y) | Roving tabindex moves before the dirty-edit guard resolves; "Keep editing" leaves tab order off the open provider | `web/src/components/settings/ProvidersSection.vue:425-441` | INTEGRATED — impl `f83c566` + `30830523`, merge `99a108b` (verified, parent-supplied); same acceptance as SET-C1 |
| SET-C6 | Low | Settings post-load autofocus targets a `v-show`-hidden pane on deep-link open; no element receives focus | `web/src/components/SettingsDialog.vue:471-477` | INTEGRATED — impl `f83c566` + `30830523`, merge `99a108b` (verified, parent-supplied); same acceptance as SET-C1 |
| CHAT-F3 | Low | Picker-click on a base action silently drops text typed after the token (`args: ''` hardcoded); Enter path on identical text consumes it | `web/src/components/Composer.vue:1203-1218` | INTEGRATED — `3b93640` + `6c9303e` + `215a512`, merge `17867f9`; acceptance full web 633/633, build PASS, focused find/folding 36/36, browser neighbors green |
| BE-F2 | Low | SSE replay loop never checks `write()` backpressure; slow consumer lets Node buffer unboundedly | `packages/harness/src/server.ts:4184-4194` | INTEGRATED — impl `8ff2d61`, merge `e1b6eeb`; acceptance 181 focused, full 2465/2457/0 fail/8 skip, CLI 19/19 |
| BE-F3 | Low | In-process session mutex map (`fileSessionTails`) never shrinks; long-lived serve/TUI leaks entries across sessions | `packages/harness/src/harness.ts:854-885` | INTEGRATED — impl `8ff2d61`, merge `e1b6eeb`; acceptance 181 focused, full 2465/2457/0 fail/8 skip, CLI 19/19 |
| BE-F6a | Negligible | `GoogleProvider` accepts `maxTokens = Infinity` (serializes as `null` on the wire) | `provider.ts:2716-2717` | INTEGRATED — impl `8ff2d61`, merge `e1b6eeb`; acceptance 181 focused, full 2465/2457/0 fail/8 skip, CLI 19/19 |
| BE-F6b | Negligible | `emitUsageIfChanged` omits `prompt_tokens` from the usage diff | `harness.ts:4230-4245` | DEFERRED — negligible: the counter cannot change independently under current provider accounting and no user-visible defect has been demonstrated |

Hypotheses — explicitly excluded from the implementation lanes;
unconfirmed (not reproduced), deferred rather than in flight:

| ID | Sev | Finding | Evidence | Status |
|---|---|---|---|---|
| CHAT-F4 | Low | "Response complete" announced when a run errors or is stopped (live-region misannounce for screen-reader users) | `web/src/components/ChatView.vue:1228-1234` | DEFERRED / NOT REPRODUCED |
| SET-H1 | Low | Effort clear from an in-flight models.dev fetch can land after `save()` and blank the form's effort for the next save | `web/src/components/SettingsDialog.vue:393-421` | DEFERRED / NOT REPRODUCED |

DEFERRED:

- **BE-F5** (low, confirmed) — fresh-run task envelope skipped when the
  text matches an existing user message; two distinct submissions become
  indistinguishable (`harness.ts:4212-4220`). DEFERRED: arguably by
  design; needs an owner decision pinning the contract, not a fix.
- **SET-H2** (low, hypothesis) — document-bubble Escape handler overrides
  naive-ui inline editors' own dismiss (`ProvidersSection.vue:481-510`).
  DEFERRED: requires manual verification before changing.
- **TUI-H1–H4** (low, hypotheses) — `addToolResult` orphan duplication
  (`model.ts:276-323`); extra render per runtime event
  (`app.ts:2666-2679`); `helpersListView` capacity-0 tail
  (`view/helpers.ts:1085-1127`); `lastElapsedMs` survives resume
  (`app.ts:3811-3813`). DEFERRED: unreachable without a wire-shape
  change / cosmetic — throttle or revisit only if profiling or a real
  symptom justifies.

AUDIT COMPLETE (remaining-core audit finished 2026-11-14; risk-ranked
findings CORE-F1..F5 — all five are now INTEGRATED with independent
acceptance and merges to local main; lanes were based on `d98ec79` or
docs-only `36ca83c` as noted per row; the final release gates on the
integrated tree have since been run and recorded in the FINAL GATES
block above):

| ID | Sev | Finding | Evidence | Status |
|---|---|---|---|---|
| CORE-F1 | Medium | `write_file`/`edit_file` read and diff unbounded file content: no size bound before `readFileSync` + full `SequenceMatcher` diff on e.g. a 300 MB file (all sibling mutation paths are bounded; write/edit are the only unbounded ones) | `packages/harness/src/workspace.ts:1591-1604`, `1641-1657` | INTEGRATED — impl `e9d4273` + `db934a3`, merge `67ccba1`; acceptance focused 84/83 pass/0 fail/1 skip, full 2470/2462/0 fail/8 skip; public index API unchanged after correction |
| CORE-F2 | Medium-low | `read_file` whole-file mode buffers the entire file into a JS string before clipping — one tool call on a multi-GB file can OOM the harness | `packages/harness/src/workspace.ts:1415-1417` | INTEGRATED — impl `e9d4273` + `db934a3`, merge `67ccba1`; acceptance focused 84/83 pass/0 fail/1 skip, full 2470/2462/0 fail/8 skip; public index API unchanged after correction |
| CORE-F3 | Medium-low | MCP `connect()` can hang forever on the `notifications/initialized` POST (streamable-HTTP only; stdio unaffected): no notification timeout path in pi-mcp, so a server answering `initialize` then never responding to the POST pins the run before its first envelope. The original broad "no connect timeout" hypothesis was **mostly refuted** by local pi-mcp evidence: every JSON-RPC request is bounded by a 30 s default timeout (`timeoutMs` fallback `client.js:263`, `DEFAULT_REQUEST_TIMEOUT_MS` `client.js:3`), `initialize`/`tools/list` both go through it, and `transport.start()` is not a hang vector | `packages/harness/src/mcp.ts:600-601`; pi-mcp 1.5.0 `dist/client.js:145`, `dist/transports/streamable-http.js:165-198` | INTEGRATED — impl `65fb2d3` + `c0515bc`, merge `3009748`; acceptance MCP 28/28, full 2465/2457/0 fail/8 skip, CLI 19/19 |
| CORE-F4 | Low | `sessions list` fully reads and parses every session file and retains every event (`SCAN_LIMIT` bounds only the title head); hundreds of MB with many large JSONL sessions | `packages/harness/src/cli.ts:2665-2734` | INTEGRATED — impl `340f533` + `c7434a0`, merge `52fbfa5`; acceptance focused 20+15+8, full 2463/2455/0 fail/8 skip, CLI 19/19 |
| CORE-F5 | Low | Subagent child conversation stores unclipped tool results (`messages.push` uses the full result; the 4 000-char clip applies only to the emitted copy) — the runner doesn't enforce its own documented bound | `packages/harness/src/subagent.ts:1170-1171` | INTEGRATED — impl `340f533` + `c7434a0`, merge `52fbfa5`; acceptance focused 20+15+8, full 2463/2455/0 fail/8 skip, CLI 19/19 |

No-finding conclusions from the same audit (full reads, not grep-level):

- **settings_store** write path — no finding (atomic tmp+rename, schema
  version refusal, fail-closed unreadable handling, env-pin stripping,
  bounded pair keys; the fixed `.tmp` name is safe under the
  single-writer lock).
- **config.ts** `validateRunConfig`/`resolveConfig` — no finding (strict
  timeout/retries validation, capped error rendering, per-role endpoint
  checks, compaction merge provenance).
- **runstream.ts** — no finding (two-pass clipping terminates; the
  degraded truncated fallback is bounded).
- **instructions.ts** — no finding (lstat + `O_NOFOLLOW` closes the
  symlink TOCTOU; reads bounded by `fstat` size).
- **CLI dispatch** (`main`, all `do*` handlers, `runOnce`) and periphery
  (`doctor`, `completions`, `configview`, `modelcatalog`) — no finding
  (doctor probe double-raced with `clearTimeout` in `finally`, never
  echoes file bytes/keys; models.dev catalog has hard fetch timeout +
  cumulative byte cap + single-flight).
- **workspace.ts** edit-diff *correctness* and the mutation queue — no
  finding (tiered matching, BOM/line-ending preservation, `finally`
  release, no reordering hazard; Windows casing/8.3 confinement
  canonicalized). CORE-F1/F2 are bounds gaps, not correctness bugs.
- **MCP timeout verdict** — recorded against the locally installed
  `@earendil-works/pi-mcp@1.5.0` source (no network): broad hypothesis
  mostly refuted (30 s per-request timeout covers `initialize` and
  `tools/list`; `start()` not a hang vector; OAuth token fetch
  unreachable since no auth provider is configured). Residual gap is
  CORE-F3 only. Secondary note: `listTools` pagination is capped at 1000
  pages × 30 s — a pathological listing could stretch to ~8 h; not
  realistically exploitable, awareness only.

FINAL GATES (verified on `3fe647f8901dcd99b953c6f9105c498fa31609e3`, the
final code checkpoint; docs commits `30056eb`, `c52554a` after it touch
`todo.md` only):

- **Windows package** — `npm test` and `test:spawn` each **2 483 total /
  2 475 pass / 0 fail / 8 platform skips**.
- **WSL Node 22.22.2 and 24.16.0** — typecheck PASS; both modes each
  **2 483 / 2 482 pass / 0 fail / 1 env skip**; hermetic server E2E 4/4.
  Environment caveats, not product failures: WSL22 `/mnt/c` `npm test`
  exited 1 **after all assertions passed** on a post-test HTTP-socket
  `TypeError`; the standalone file ran 48/48 and an identical full suite
  on a native ext4 checkout ran 2 483/2 482/0 fail/1 skip with exit 0 —
  pinning the caveat to `/mnt/c`, not the product. WSL24 initial `/mnt/c`
  runs hit a bounded TUI timing flake at `tuiintegration:1460`; bounded
  reruns passed.
- **Web** — **642/642** + `npm run build` PASS.
- **CLI E2E** — **19/19 source + 19/19 `--dist`**.
- **Offline smoke gate** — **PASS** (package as above, web 642/642,
  CLI 19/19, fault-injection 7/7, hermetic server 4/4).
- **Browser E2E** — **39 hermetic PASS / 0 FAIL / 1 opt-in `real` SKIP** +
  helpers suite **20/20**.
- **Tarball** — **7/7 + pack:check PASS**.

PRECHECK (historical verification evidence on integrated trees only —
**not** final gates; the FINAL GATES block above supersedes):

- **At `17867f9`** — backend typecheck PASS; package both modes
  2480/2472/0 fail/8 skip; CLI source + dist 19/19 each; web 640/640,
  build PASS, six focused browser scenarios PASS.
- **At `140d854`** — offline smoke PASS (package 2483/2475/0 fail/8
  skip, web 640/640, CLI 19/19, faults 7/7, hermetic server 4/4);
  tarball 7/7 + pack:check PASS; WSL Node 24.16.0 typecheck + both modes
  2483/2482/0 fail/1 skip + hermetic server 4/4.
- **At `1eef5fe`** — browser 38 hermetic PASS / 0 FAIL / 1 opt-in real
  SKIP + helpers 18/18.
- **WSL Node 22.22.2 at `140d854`** — typecheck PASS, both modes
  2483/2482/0 fail/1 skip, hermetic server 4/4.

Gate finding from the browser precheck:

| ID | Sev | Finding | Evidence | Status |
|---|---|---|---|---|
| E2E-G1 | Low-Med | `scripts/e2e-test.ps1` did not check the web build exit code, so an EPERM build failure continued and was masked by a recovery ENOENT — the browser matrix can run against a missing/stale `dist` | `scripts/e2e-test.ps1` build step (found by browser precheck) | INTEGRATED — impl `ca1d8dd`, merge `3fe647f`; acceptance helpers 20/20 (14 freshness incl. 2 wrapper + 6 registry), mocked exit 42 / red-on-base proof, PS parse PASS |

CANDIDATE (structural, behavior-preserving — remaining groups DEFERRED,
descriptions preserved for future work):

- **TUI-R1–R7** — idle-gate `dispatchEntry` parity; `usageFields()`
  dedup; `scrollByPages()`; shared text-projection helpers model/app;
  `pluginStats()`; split `foldHelperDetail`; uniform render-ownership
  for overlay openers. **R6 (`foldHelperDetail` split) — INTEGRATED**
  (impl `1c600e2`, merge `7f28044`; acceptance 46/46 focused, full
  2461/2453/0 fail/8 skip). **R1–R5, R7 — DEFERRED:** broad extraction
  risk is not justified without a concrete correctness/performance
  payoff in this cycle; the accepted R6 slice covers the clearest
  low-risk boundary.
- **CHAT-R1–R4** — extract `ModelSwitchMenu.vue`; `useTranscriptFind`
  composable; `MarkdownBody.vue` island; one `routeDescription()`
  helper. **DEFERRED:** broad extraction risk is not justified without
  a concrete correctness/performance payoff in this cycle; the accepted
  S3 slice covers the clearest low-risk boundary.
- **SET-S1–S5** — extract `ProviderAddCard`/`ProviderDetailCard`;
  `useEffortOptions` composable + pure `buildSettingsPatch`; `fsPath.ts`
  + `sidebarGroups.ts` pure modules with tests; shared `errText`.
  **S3 (`fsPath.ts` extraction + tests) — INTEGRATED**
  (implementation `db14655`, merge `d0b851b`; independent acceptance:
  web suite 615/615, `npm run build` PASS). **S1/S2/S4/S5 — DEFERRED:**
  broad extraction risk is not justified without a concrete
  correctness/performance payoff in this cycle; the accepted S3 slice
  covers the clearest low-risk boundary.
- **BE-R1–R5** — `harness-subagents.ts` slice; `provider/` module split;
  server route-group functions; `workspace-edit.ts`; CLI per-command
  modules (existing `doSessions`/`doSpill`/`doConfig` pattern).
  **DEFERRED:** broad extraction risk is not justified without a
  concrete correctness/performance payoff in this cycle; the accepted
  R6/S3 slices cover the clearest low-risk boundaries.

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

- [ ] **Re-enter provider API keys + re-create sessions (owner)** —
      sealed `settings.json` was permanently lost in the 2026-11-14
      incident; no sessions survive either. The serve process itself is
      restored and verified (see Owner / release gates above).
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
