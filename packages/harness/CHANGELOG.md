# Changelog

All notable changes to `@two-brothers/harness` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Anthropic extended thinking + signed passback** (wave 10): new
  `--thinking-budget <n>` / `TWO_BROTHERS_THINKING_BUDGET` (pinned, never
  persisted; min 1024, other providers ignore it) makes Anthropic Messages
  roles request `thinking: {type:"enabled", budget_tokens:n}` on plain,
  streaming and tool-loop calls. When an Anthropic provider's effective
  `--max-tokens` does not exceed the budget, that provider's request cap is
  raised to budget + 1024 with one honest warning per provider instance (an
  explicit `--max-tokens` is otherwise untouched), and
  `temperature` is omitted while thinking is enabled (API incompatibility).
  Signed thinking blocks — streamed (`thinking_delta` + `signature_delta`) or
  non-streamed, `redacted_thinking` payloads included — are captured and
  echoed verbatim as the first content blocks of subsequent tool-loop
  assistant turns, so Anthropic accepts multi-round tool loops; they never
  enter the protocol transcript, session JSONL or other adapters. Unset keeps
  every request byte-identical. Files: `src/provider.ts`, `src/context.ts`
  (internal additive `ChatMessage.thinkingBlocks`), `src/harness.ts`,
  `src/config.ts`, `src/cli.ts`, `src/clihelp.ts`, `src/index.ts`; tests
  `tests/thinkingpassback.test.ts` (13).
- **Drag-and-drop workspace reordering (web)** (wave 9): each sidebar workspace
  group now has a dedicated pointer-only grip handle; dragging a group and
  dropping it on another header shows an honest insert indicator (accent line
  before/after, source dimmed), optimistically reorders the sidebar through the
  existing `PUT /api/workspaces/order` path and reverts with an error toast if
  the backend rejects it. The whole header is not a drag source, the handle is
  out of the tab order with an `aria-describedby` instruction, click/expand and
  session selection are untouched, dragging is disabled while filtering, and
  the menu **Move up / Move down** actions remain the keyboard path (touch
  devices see the menu only). Pure helpers `dropReorderDelta` /
  `dropReorderIds` (`web/src/workspaceOrder.ts`) define the clamped,
  no-op-aware move; the hermetic browser suite gained the `workspace-drag`
  scenario (sidebar order + persisted API order + fallback assertions).
  Files: `web/src/components/SessionGroup.vue`, `Sidebar.vue`,
  `web/src/workspaceOrder.ts`; tests `web/tests/workspaceOrder.test.ts` (21,
  +6) and `e2e/run.mjs`.
- **TUI replay of persisted reasoning** (wave 8): a session that carries
  persisted `reasoning` sidecar events now shows a bounded, dim
  `THINKING (replayed) · <ROLE> · <kind>` section in the TUI transcript on
  load/resume/session switch (sidecar append order = run order): up to four
  wrapped preview rows per record with honest `… +N lines` / `… clipped for
  length` markers, at most 24 records (older ones collapse behind one count
  marker), one record per provider call. It is read-only and fail-soft (no
  sidecar, torn/malformed/oversized rows => no crash, nothing invented), the
  TUI never writes reasoning events, live thinking is unchanged, and frames
  without replay payload are byte-identical (plainTheme/NO_COLOR too). Files:
  `src/tui/reasoningPersist.ts` (new), `src/tui/view/reasoning.ts` (new),
  `src/tui/app.ts`, `src/tui/view/transcript.ts`,
  `src/tui/view/screen.ts`; tests `tests/tuireasoningreplay.test.ts` (14).
- **Persisted reasoning replay** (wave 7): thinking/reasoning deltas are no
  longer live-only. When token streaming is active, the harness buffers the
  sanitized reasoning per provider call and emits one additive
  `{type: "reasoning", role, kind, text, truncated}` runtime event (bound
  `REASONING_EVENT_MAX_CHARS` = 10,000, head+tail with the shared truncation
  marker; ANSI/control bytes stripped); `RunManager`'s existing sidecar
  persister writes it to `sessions/runtime/*.events.jsonl` automatically, so
  no protocol envelope or session-JSONL change is needed. The web replays the
  record after reload as a collapsed-by-default
  **Thinking · replayed · Senior/Junior** disclosure row (plain text, bounded,
  tolerant of malformed/oversized rows; older backends simply have none). The
  record spans one node call seam: an internal overflow-recovery retry merges
  both attempts' deltas into that record, and a failed/cancelled call keeps
  the reasoning it streamed so far.
  Honest limitation: capture is streaming-only (the web always opts in;
  `run`/`chat`/TUI need `--stream-tokens`) because the plain provider contract
  returns no reasoning text, and TUI replay is not implemented (live thinking
  unchanged). Files: `src/harness.ts`, `src/runevents.ts`, `src/index.ts`
  (`ReasoningEvent`, `REASONING_EVENT_MAX_CHARS`); web `src/types.ts`,
  `src/runtime.ts`, `src/components/ChatView.vue`, `src/folding.ts`
  (reasoning rows stay non-foldable). Tests: `tests/thinkingpersist.test.ts`
  (7) + web `tests/timeline.test.ts` (+4).
- **Real-socket fault-injection E2E** (wave 7): new opt-in
  `packages/harness/e2e/faults.ts` (`npm run test:e2e:faults`) starts a
  scripted `node:http` server on a loopback ephemeral port and drives the real
  retry/timeout/overflow machinery over actual TCP/fetch — no fetch stubs and
  no external network. Seven deterministic scenarios assert attempt counts and
  classification: 429 + `Retry-After` then success; transient 500/503 then
  success; a 150 ms per-attempt timeout then success with the documented
  warning; context-overflow fail-fast (one attempt); a genuine compact-and-
  retry recovery over a seeded ~92 KB session (cycle completes, one summary,
  JSONL restores with dense seq); an always-overflow server bounded to 3
  requests then the documented error; and fatal quota/billing
  (`provider-limit`, zero waits). Per-scenario 10 s watchdog, <30 s total
  (~0.3 s typical), PASS/FAIL summary, exit 1 on failure, evidence in the
  gitignored `e2e/runs/`. The full offline smoke gate now runs it.
- **Consult-mode tool loops for both brothers** (wave 4, lane A): the
  senior's consult opening and the consult-mode junior proposal/revision now
  ground themselves with a read-only workspace belt before emitting the
  structured reply — they run the same bounded `toolLoop` the work-mode
  deliverable uses (`MAX_CONSULT_TOOL_ITERATIONS` = 4 rounds). The read-only
  belt is the role's normal belt minus `WORKSPACE_MUTATION_TOOL_NAMES`
  (`workspace_write_file` / `workspace_edit_file` /
  `workspace_delete_file` / `workspace_run_shell`) and minus the
  display-only plan tool, so a consult node is never offered a workspace
  mutation tool (operator-installed MCP/plugin tools scoped to the role stay
  as that scope grants them — their own side effects are outside the
  workspace permission layer, unchanged);
  the senior's review also grounds itself in consult mode and appends the
  clipped tool lines to its points/notes like the work-mode verify evidence.
  A node only loops when the belt is non-empty AND the role's provider
  implements `chatWithTools` — a tool-less configuration keeps the exact
  pre-tools request path (no tools on the wire, no extra provider calls, the
  same prompt-audit section names). `senior_decide` deliberately stays a
  plain call (the review immediately before it already ran the read-only
  checks); work mode is unchanged (delegation, the junior's mutating
  deliverable loop, the senior's approval-brokered verify slice and the
  work-mode review/decision calls keep their behavior). Files:
  `src/harness.ts` (`WORKSPACE_MUTATION_TOOL_NAMES`,
  `MAX_CONSULT_TOOL_ITERATIONS`, `consultToolSet`, `consultNode`,
  `consultWithTools`, `toolLoop`'s `wireKind`). Tests:
  `tests/toolcalling.test.ts` (10: read-before-reply for senior consult,
  junior proposal and senior review, mutation-free belts, tool-less
  byte-identical requests, the non-`chatWithTools` gate, bounded loop +
  repair-after-loop, cancel mid-round, unknown-tool recovery, no mutating
  belt in any node).
- **Workspace approval modes and guardrails** (wave 4, lane C): a new honest
  operator policy selects a fixed decision table for workspace actions —
  `ask` (default: reads free, writes/edits/deletes/shell ask), `readonly`
  (only reads run; every mutation and shell command is denied without
  asking), `edits` (reads/writes/edits free; deletes and shell ask) and
  `allow-all` (everything runs without asking; explicit opt-in only, with a
  visible danger warning). `PermissionPolicy` applies the mode; a mode never
  bypasses workspace confinement or the sensitive-path refusal (those run
  before permissions), `readonly` denies deterministically even with a broker
  present, a broker answer can only choose allow/ask/deny (never widen the
  policy), and the per-session allow pairs, denial cap and broker-null
  fail-closed behavior are unchanged. The mode persists top-level in
  `sessions/settings.json` as `{"approval_policy": {"mode": "ask"}}` through
  the atomic `SettingsStore.writeApprovalPolicy` (read is fail-closed:
  missing/corrupt/unknown → `ask`; every other section is preserved).
  `GET /api/settings` additively returns `approval_policy: {mode, pinned}`
  (a serve flag/env pin overrides the persisted mode and reports
  `pinned: true`); `PUT /api/settings` accepts the additive
  `{"approval_policy": {"mode": "…"}}` (strict enum, 400 invalid, 500 when
  the write fails; absent leaves the persisted mode untouched) and every run
  seeds its `PermissionManager` from the effective mode. CLI:
  `--approval-mode <ask|readonly|edits|allow-all>` (+ pinned env
  `TWO_BROTHERS_APPROVAL_MODE`) on `run`, `chat`, `serve` and `tui`; an
  unknown value is a usage error (exit 2), `serve` pins the mode for every
  web run and `tui` for the TUI process (both never persisted), `run`/`chat`
  bind no workspace so the flag is inert there, and `allow-all` prints one
  visible `[warn]` line per run/startup. The TUI's `/permission` dialog now
  states the effective mode with its description and the allow-all warning,
  offers the four modes as persistent buttons (or only Close when a
  flag/env pin owns the mode and says so honestly), and `/permission <mode>`
  applies one directly (unknown values are refused with the allowed list);
  every workspace turn reads the mode fresh and shows one warning toast in
  `allow-all`. The web Settings gains an **Approvals** section (honest copy
  per mode, a destructive-warning banner for `allow-all`, pinned and
  old-backend states read-only with the reason; a backend without the field
  shows `ask` and never receives an approval patch). Files:
  `src/permissions.ts`, `src/config.ts`, `src/settings_store.ts`,
  `src/server.ts`, `src/cli.ts`, `src/clihelp.ts`, `src/index.ts`,
  `src/tui/app.ts`; web `src/approvalPolicy.ts`,
  `src/components/settings/ApprovalPolicySection.vue`,
  `src/components/SettingsDialog.vue`, `src/api.ts`, `src/types.ts`. Tests:
  `tests/approvalmodes.test.ts` (19: the per-mode decision matrix with and
  without a broker, readonly/edits/ask/allow-all workspace behavior,
  confinement-before-permissions even under allow-all, and the CLI
  flag/env/help/warning/invalid-exit-2 cases; the persisted-section
  fail-closed round-trip lives in `tests/settings.test.ts`, the
  `GET`/`PUT` route and run-path mode matrix in `tests/server.test.ts`),
  `tests/tuiapprovalmodes.test.ts` (6), `tests/settings.test.ts` (now 31),
  `tests/server.test.ts` (now 65) and
  `tests/approvalbrokerdeny.test.ts` (now 28) extensions,
  `web/tests/approvalPolicy.test.ts` (12).
- **Up/Down previous-message recall in the TUI and the web composer**
  (wave 4, lane B): Up/Down now walks the operator's earlier accepted tasks
  in both composers, with the live draft preserved byte-exactly and restored
  when stepping past the newest entry. TUI: a single-line draft recalls
  immediately; a multiline draft only leaves the composer at its very edges
  (Up at the start, Down at the end) — interior caret movement keeps the
  draft and never recalls; only accepted task submissions (typed,
  slash-template or `tui "<task>"`) are recallable, the pre-recall draft is
  restored exactly, persisted prompt history loaded at startup is available,
  and recall navigation never appends to the history file. Web: a new pure
  `web/src/recall.ts` (versioned bounded `localStorage` blob
  `two-brothers.composerHistory.v1`, newest first, 100 entries, 16 384 chars
  each, consecutive dedupe, fail-soft on corrupt/blocked storage; draft
  stashing/restoring as a pure state machine and an IME/repeat/modifier-safe
  key classifier) wired into `Composer.vue`/`composerKeys.ts`: recall only
  applies while no picker is open, a recalled entry is never treated as a
  draft edit (the drafts store keeps the stashed live draft, including across
  session switches), only accepted submissions join the history, and the
  final Down restores the preserved draft. Also: `/provider` is now a native
  registry command, so a discovered `provider.md` template can no longer
  shadow the provider connect surface (it is dropped from the TUI command
  catalog with a diagnostic, and the native command wins its name, like
  `/help`). Files: `src/tui/editor.ts`, `src/tui/app.ts`,
  `src/tui/keymap.ts`, `src/tui/basecommands.ts` (existing token helper),
  `web/src/recall.ts` (new), `web/src/components/Composer.vue`,
  `web/src/composerKeys.ts`. Tests: `tests/tuirecall.test.ts` (3, through
  the assembled fake-TTY app), `web/tests/recall.test.ts` (7), plus the
  extended `tests/tuieditor.test.ts` and `tests/tuiintegration.test.ts`.
- **Browser E2E packaged-web freshness guard** (wave 4, lane D): the browser
  suite serves the packaged `packages/harness/web` copy first (that is what
  the server prefers in a checkout and what the npm tarball ships), so a
  stale copy could silently test old UI after a `web/` rebuild. The runner
  now compares the packaged copy against `web/dist` by relative-path set and
  file content before any scenario and re-runs the publisher's copy (the
  `scripts/sync-web.mjs` `cpSync`, building nothing) when the trees differ,
  logging `packaged web: fresh (N files)` or
  `packaged web: resynced … (N files; reasons)`. Missing `web/dist` fails
  with the exact build command; `sync: false` and a non-converging sync fail
  with the publisher command and the remaining differences. Offline,
  synchronous, dependency-free (`e2e/web-freshness.mjs`, pure
  `compareWebTrees`); tests: `e2e/web-freshness.test.mjs` (12). The
  `approval-reason` scenario also gained the click-through of the pending
  card's preview toggle: collapsed by default (`aria-expanded="false"`,
  stable `aria-controls`, `+N -M` counts), expands the unified diff as
  plain text (literal HTML in the removed line stays text, becomes an
  escaped `&lt;` node and runs no handler), labels the toggle
  "Hide preview", collapses again, and the resolved card drops the
  pending-only preview. No new browser scenario (the suite stays 13 offline
  scenarios + the opt-in `real` skip).

- **TUI provider connection (owner bug fix)**: the TUI used to build role
  providers from CLI flags/env only, silently ignoring the provider
  configuration saved by the web Settings, `serve` or `onboard`
  (`<sessions-dir>/settings.json`, keys encrypted at rest). It now loads that
  store through the same `SettingsStore`/`RuntimeSettings`/
  `resolveRoleEndpoints` stack `serve` uses — at startup and re-resolved before
  every turn and compaction — so persisted presets, manual fields and decrypted
  stored keys drive the turn harness, the `/compact` provider, the model
  pickers, the status bar and the welcome screen. Precedence is explicit
  CLI flags/env pairs (role pair > shared pair, all-or-nothing; an explicit
  `--provider` clears a named ref) > persisted role settings (manual fields,
  else a named `provider_ref` resolved through the merged seed+stored preset
  table) > built-in seed presets > the harness's per-field fallback;
  env-pinned fields are never persisted, and a dangling `provider_ref` warns at
  startup and falls back to the manual fields instead of crashing. New in-TUI
  connect surface `/provider` (also reached through `/settings` →
  **Connect provider…**; `/settings` is in the Ctrl+P palette) shows the
  effective per-role summary — provider · model · kind · base URL ·
  `API key: set|not set`, never the value — then a preset-or-manual connect
  (preset + model, or Base URL / model / optional key). Saving goes through one
  atomic `SettingsStore.write` with the key encrypted at rest; a failed save
  keeps the dialog with the real error and changes nothing. A turn that fails
  to connect points the operator at `/provider` and the
  `--base-url`/`--api-key` flags while keeping the provider's own error
  visible; typed keys are masked while typing and never appear in frames,
  transcripts, prompt history or sidecars. Files: `src/tui/providers.ts` (new),
  `src/tui/view/provider.ts` (new), `src/tui/app.ts`, `src/tui/keymap.ts`.
  Tests: `tests/tuiproviders.test.ts` (23, registered in `tests/run-all.ts`).
- **Approval reasons and a web approval-detail preview**: shell and delete
  approvals now carry fixed, honest operator reasons — shell: "runs arbitrary
  shell code inside the workspace — its effects cannot be previewed and may
  change any file the process can reach"
  (`SHELL_APPROVAL_REASON`); delete: "permanently removes the file from the
  workspace — deletion cannot be undone" (`DELETE_APPROVAL_REASON`). Write/edit
  approvals stay reason-free because their unified diff is the explanation. The
  web approval card shows the reason while pending (`.approval-reason`) and
  keeps it after Allow/Deny (`.approval-note`; a resolution reason such as
  `cancelled` wins when present), and the TUI approval panel shows its reason
  row. The pending web card also gained a collapsed-by-default **Preview the
  change** / **Preview the command** toggle — a real button with
  `aria-expanded`/`aria-controls`, `+N -M` diff counts and a `clipped` badge
  when the backend clipped the detail at 20 000 chars — rendering the bounded
  unified diff or shell command as plain text in a `<pre>` (no HTML,
  horizontal/vertical scroll, nothing rendered when the backend sends no
  detail); an older backend degrades to the previous card. The additive
  `reason`/`detail` fields are unchanged on the wire and no protocol envelope
  changed. Files: `src/workspace.ts`,
  `web/src/components/ApprovalCard.vue`, `web/src/runtime.ts`,
  `web/src/types.ts`. Tests: `web/tests/approvalSession.test.ts` (19 tests),
  `tests/workspace.test.ts`, `tests/approvalbrokerdeny.test.ts`, and the
  browser `approval-reason` scenario.
- **Browser E2E coverage for the new web UX**: the hermetic Playwright suite
  now has 13 offline scenarios plus the opt-in `real` one — **13 PASS, 0 FAIL,
  1 SKIP** on the canonical run: `chat`, `resume`, `approval-allow`,
  `approval-deny`, `stop`, `mobile`, `appearance-density`, `provider-reset`,
  and new this round `folding` (folded completed-run tool rows:
  `aria-expanded` disclosure, followed run stays open, expand/collapse in
  place, per-session reset), `plan-dock` (counts/markers/bounded `+N more`
  expand and the polite announcements, including "Plan cleared."),
  `composer-seats` (role models + prompt-audit context seat, no token wording),
  `hero-starters` (landing/empty-session hero; starters prefill only an empty
  composer and a preserved draft wins with a notice) and `approval-reason`
  (delete approval shows the documented reason; Allow removes the file; the
  resolved history card keeps the reason verbatim, no raw markers). The
  scripted OpenAI-compatible fixture server and its README were extended so
  the new scenarios exercise real projection/annotation/approval-detail paths
  through the backend; the suite stays fully hermetic (temp dirs, free ports,
  system Edge headless, no network). Tests only — no product behavior change
  in this entry.
- **TUI status-bar footer tips and a transient hint channel**: the status bar's
  hint slot now rotates through high-value tips derived from the single keymap
  registry — one tip per accepted turn, deterministic (a turn counter, never a
  clock or randomness), highest value first: `Ctrl+T fold tool output`,
  `Ctrl+F find in transcript`, `Ctrl+P commands`, `? keys and help`,
  `Ctrl+R search prompt history`, `Ctrl+B status panel`, plus
  `Esc stop the turn` while a turn runs. A tip is skipped when its command is
  unknown, unbound or disabled, so the footer never advertises an action the
  operator cannot take, and one cycle shows each available action once; while
  a tool row is on screen the tool-fold action leads and is excluded from the
  rotation (the same chord never appears twice). A new transient slot outranks
  the rotating tip for a bounded number of renders: after a stopped turn it
  says `turn stopped — Ctrl+C ×2 exits`, and while a workspace approval is
  parked it always says `deny to continue — Ctrl+C stops the turn after it
  resolves` — the approval panel owns the decision keys, so Ctrl+C is inert
  until the request is answered (copy only; no binding changes). The transient
  hint is clipped into the remaining cells (real ellipsis, never mid-grapheme)
  instead of being dropped whole, and it never displaces the activity segment;
  `plainTheme` output changes only in the new tips/transient copy. Files:
  `src/tui/keymap.ts` (`FOOTER_TIPS`, `footerTips`, `rotatingFooterTip`,
  `composeStatusHints`), `src/tui/view/statusbar.ts` (`transientHint`,
  `APPROVAL_PARKED_HINT`, clipped fitting), `src/tui/app.ts` (one tip per
  accepted turn, `TRANSIENT_HINT_RENDERS` = 6 one-shot budget). Tests:
  `tests/tuiviewlane.test.ts`, `tests/tuistyle.test.ts`,
  `tests/tuiintegration.test.ts`.
- **TUI plan durability**: a TUI turn now persists its plan — one
  `todo_updated` event per plan change — to the session's runtime sidecar
  `sessions/runtime/<session-file>.events.jsonl`, using the same store,
  directory and key convention `serve` uses (the session file name unchanged,
  extension included). Restarting the TUI with the same `--session-file`
  replays the last snapshot; last write wins, so a later snapshot — including a
  cleared list — replaces the earlier plan, exactly like a serve-written
  sidecar. Only plan snapshots are written: a TUI turn still does not persist
  tool, approval or envelope events, and an in-memory session (no
  `--session-file`) has nothing durable to write to. Fail-soft through the new
  `src/tui/todoPersist.ts` (a failed write warns only under `--verbose` and
  never breaks a turn); the in-process cache still makes session switching
  instant. Tests: `tests/tuitodo.test.ts` (round-trip through a real runtime
  store, restart/last-wins/clear semantics, exactly one line per plan write and
  nothing else, torn-line tolerance, an uncreatable store path failing soft,
  the compact sanitized event shape).
- **TUI workspace binding, approval panel and `@file` mentions**
  (`tui --workspace <dir>`): every turn binds one confined root — the junior
  gets the `workspace_*` tool belt, the senior the read-only verify slice,
  plugins bind workspace-bound, and the composer `@path` picker/attachments
  read from it. When a write/edit/delete/shell parks the run, a docked approval
  panel replaces the composer with the action/target/command/reason and a
  bounded diff summary; decisions are numbered `1 Allow once`,
  `2 Always allow this session`, `3 Deny` (mnemonics `y`/`a`/`n`), with
  Up/Down + Enter and `Esc` = deny exactly once, and `Ctrl+E` opens the
  full-screen diff/command preview (closing a preview never answers the
  request). "Always allow this session" is in-memory for that TUI process only
  — never persisted to settings; stopping/cancelling the turn denies every
  pending request (fail closed) and the broker's denial cap is unchanged.
  `ApprovalRequestedEvent` additively carries optional `reason` and a bounded
  `detail` (`ApprovalDetail`: diff for write/edit/delete, command for shell,
  line counts, `truncated`), so a UI can show what will change before
  approving. Composer `@path` mentions attach workspace files as
  `<file path="…">` context blocks under the server's caps (≤5 files, 20 000
  chars each, 100 000 total, text files only, no absolute/`..`/sensitive
  paths), resolved before the turn starts; an invalid workspace root is a
  startup error (exit 2) before the alternate screen opens, and `/permission`
  now states the bound root, the real ask-before-mutating policy and the
  in-memory session allows. Files: `src/tui/app.ts`,
  `src/tui/view/approval.ts` (new), `src/tui/view/screen.ts`,
  `src/tui/keymap.ts` (the `approval` key scope),
  `src/tui/view/mentionpicker.ts`, `src/permissions.ts`, `src/runevents.ts`,
  `src/workspace.ts`, `src/cli.ts`, `src/clihelp.ts`. Tests:
  `tests/tuiworkspace.test.ts` (20).
- **Live TTY transcript for `run`/`chat`** (`--live` / `--no-live`): on an
  interactive stdout each envelope block streams as the harness produces it,
  with dim `· <role> <verb>…` activity rows between blocks (`prompt_audit`
  fires before each provider call, `tool_started` and failed/blocked
  `tool_completed` mirror tool work); the final decision rule and the compact
  footer still print exactly once. The flags are `run`/`chat` only:
  `--no-live` prints the finished transcript once (the piped behavior) and
  wins when both are given; `--live` cannot force a pipe to stream. Piped human
  output and every machine mode (`--json`, `--json-events`, `--stream`,
  `--mode print`, `--dry-run`) stay byte-identical — the hermetic CLI E2E
  compares piped bytes under `--live`/`--no-live`. The per-envelope renderer
  moved into `src/clilayout.ts` (finished and live projections share it;
  dropping the `· ` activity rows from live output leaves the finished
  transcript bytes plus the footer) and `CliIO` gained an optional `isTTY`
  signal. Files: `src/cli.ts`, `src/clilayout.ts`, `src/clihelp.ts`,
  `e2e/cli.ts`. Tests: `tests/cli.test.ts` (26), `tests/clistyle.test.ts` (27).
- **Web UX: step folding, composer status seats, welcome hero**: transcript
  tool/prompt-audit rows of completed runs (any run that is not the followed
  one) fold into one muted disclosure row — `… N tool calls · expand` (the
  label gains `in M runs` when a folded group spans several runs), a real
  button with `aria-expanded`; a single row stays open,
  conversation rows never fold, and collapsed rows leave the DOM so find/copy
  see exactly what the transcript renders (the find cache is invalidated on
  toggle). The composer gained a compact status-seat row built only from data
  the app holds: models (hidden until role settings load), the real permission
  expectation ("Ask in app" with a linked workspace, "No workspace" without),
  and the latest prompt audit's exact system/context character counts plus the
  offered tool count — never a fabricated token count; a seat with unknown data
  is absent instead of showing a placeholder. Empty sessions and the no-session
  landing state show a welcome hero with workspace context, New session /
  Add workspace / Set up models / Keyboard shortcuts actions and three starter
  suggestions that only prefill the editable composer (never auto-send).
  Files: `web/src/components/ChatView.vue`, `App.vue`, `Composer.vue`,
  `folding.ts` (new), `composerStatus.ts` (new),
  `components/WelcomeHero.vue` (new), `style.css`. Tests:
  `web/tests/folding.test.ts` (16), `web/tests/composerStatus.test.ts` (9);
  web 275/275.
- **Plan/todo function (`todo_write`)**: a built-in tool both brothers receive
  (junior belt and senior verify slice, no approval, never touches the
  workspace) that records or replaces the plan in one call —
  `{todos: [{content, status: "pending" | "in_progress" | "completed"}]}`,
  tolerant at the model boundary (non-object entries and empty content dropped,
  unknown status → `pending`, content collapsed to one bounded line, ≤50
  entries; a call with no usable entries is a JSON error result and never loses
  the previous plan). A valid call replaces the run's snapshot (last write
  wins), returns a compact text result and emits exactly one additive
  `todo_updated` runtime event `{todos}` — persisted by the run sidecar,
  streamed over SSE and replayed on reload, with `HarnessResult.todos` carrying
  the final snapshot; no protocol envelope or session-JSONL change. The TUI
  docks a compact plan panel above the composer (✓ completed / ▸ in progress /
  ○ pending, ≤4 rows plus an honest `+N more (…)` tail, `TODO · n/m done`
  title; display-only, no new key), and replays the session's latest sidecar
  snapshot on session resume/switch. The web
  renders a Plan dock
  with the same selection
  rules, a real expand button and a polite live announcement. Files:
  `src/todos.ts` (new), `src/harness.ts`, `src/runevents.ts`, `src/index.ts`,
  `src/tui/view/todo.ts` (new), `src/tui/app.ts`,
  `web/src/components/TodoPanel.vue` (new), `web/src/runtime.ts`,
  `web/src/types.ts`, `web/src/App.vue`. Tests: `tests/todos.test.ts` (17),
  `tests/tuitodo.test.ts` (12), `web/tests/todo.test.ts` (11).
- **Provider model discovery**: `POST /api/providers/{name}/discover` probes an
  explicit draft — `{base_url?, kind?, api_key?}` — through
  `provider.ts::listModels` and returns `200 {models, base_url, kind}` with the
  ids the endpoint reported (`{id, owned_by?}` objects; an empty list is a
  valid answer). It is deliberately separate from Apply: it never writes
  settings or run state, never applies the draft, never persists or echoes the
  typed key, and resolves the preset's stored/env-backed key server-side only
  when the probed base URL is the preset's own (trimmed, trailing slashes
  ignored) — probing a different URL with a saved key and no typed key is a 400
  so a secret is never sent elsewhere. Unknown provider 404, invalid body or a
  non-OpenAI-compatible wire kind 400 (only OpenAI-compatible endpoints expose
  a `/models` listing), upstream failure 502. Settings → Providers gains
  **Refresh models** on the open detail card: loading/ready/empty/error/
  unsupported states, a monotonic token so a stale response cannot overwrite a
  newer probe or a switched draft, an explicit **Add N to draft** (never
  auto-applies — Save changes is still required), and old-backend fail-soft
  (404 → unsupported message, nothing changed). Tests: `tests/server.test.ts`
  discovery section (+7 hermetic loopback tests; suite 59) and
  `web/tests/providerSettings.test.ts` (+9; suite 29; web 239/239).
- **`allow_session` approval scope**: an explicit operator decision "Always
  allow this session" next to allow/deny. `RunApprovalBroker` keeps an
  in-memory set of `action\0normalized-target` pairs for the run: a matching
  request resolves ALLOW without parking — the check runs before the denial
  cap — and emits one additive `approval_auto_allowed` runtime event
  `{action, target}` instead of `approval_requested`. A stopped/aborted run
  still denies (the shortcut never bypasses cancellation), and one-shot
  allows/denials keep their counters. `POST /api/runs/{run_id}/approvals/{id}`
  accepts an additive `scope: "once" | "session"` (default `once`; anything
  else, or `session` with a deny, is a 400) and echoes the applied
  `{approval_id, decision, scope}`. Session scope persists FIRST in
  `sessions/settings.json` top-level
  `"approvals": {"<session file>": ["<pair key>", ...]}` (newest-last, capped
  at 64 per session, atomic write, corrupt/missing section reads as empty = fail
  closed, cleared on session delete; a run seeds its broker at submit and again
  at start so a queued run sees allows granted meanwhile) — never in the
  session JSONL. A shell pair's key contains the full command string, so
  `settings.json` carries that much of an approved command — the same trust
  domain as the runtime sidecar; it never contains a key or a prompt body. The
  web card adds the third button (and `a` on a focused card; `y`/`n` unchanged);
  an older backend that ignores `scope` is reported honestly as "Allowed once —
  this backend does not support session scope." Tests:
  `tests/approvalbrokerdeny.test.ts` (25), `tests/settings.test.ts`,
  `tests/server.test.ts` approvals section, `web/tests/approvalSession.test.ts`
  (8; web 239/239).
- **Web queue visibility**: the composer no longer locks while a run works — a
  submission joins the backend's per-session FIFO and the send control reads
  **Queue**; `POST /api/runs` answers `202 {run_id, session, status}` with
  `status: "queued"` when the session already has a live run. A bounded queue
  dock above the composer lists the waiting runs with 1-based `#N` positions, a
  task snippet, a queued-at time and a per-row **Stop** (a queued run is
  cancelled immediately through the existing stop route; focus is restored when
  the row disappears), a "+N more" tail beyond the bound, an aria-live summary
  and honest copy ("they start automatically, in order, after the current run
  finishes" — never "steering"; there is no mid-turn injection). The next queued
  run is adopted/followed as soon as the current one ends, run submission
  bookkeeping is per run id (a failed queued run retries its own task), and an
  older backend that returns no active run records simply shows no dock. Files:
  `web/src/queueState.ts` (pure projection),
  `web/src/components/QueueDock.vue`, `web/src/App.vue`,
  `web/src/components/Composer.vue`; tests `web/tests/queueState.test.ts`
  (19; web 239/239).
- **TTY-gated semantic color for the human CLI** (`src/clistyle.ts`, reusing
  the existing `src/tui/theme.ts` token layer; no TUI layout changes): the
  non-TUI human surfaces now paint semantic tokens — `clihelp` headings,
  flag labels, metavars and descriptions; the `run` transcript (`[user]` /
  `[role -> role]` headers, dim kind labels and payload keys, the bold
  `decision` value, dissent/errors and risk warnings); the `usageLine` /
  `costLine` footers and prompt audits; the `chat` banner and `/help`
  headings; and `doctor` status tags (pass=success, warn=warning,
  fail=error, skip=dim) with strong labels. Color is opt-in and
  terminal-gated: piped output, a non-empty `NO_COLOR`, `TERM=dumb` and a
  0/1 color depth stay plain; 2/4/8-bit TTYs get the 16-color palette and a
  24-bit TTY the dark/light truecolor palette (`TWO_BROTHERS_THEME` selects
  dark, light or ansi16); `FORCE_COLOR=1|2|3` forces color at
  16/256/truecolor even when piped and wins over `NO_COLOR`, while
  `FORCE_COLOR=0|false` stays plain even on a TTY. Machine output modes
  (`--json`/`--json-events`, `--stream`, `--mode print|json`) are always
  escape-free; every printer defaults to the identity style, so piped output
  and existing tests stay byte-identical and `stripAnsi(colored) === plain`
  holds for every surface. Tests: `tests/clistyle.test.ts` plus the hermetic
  CLI E2E `style` scenario (`e2e/cli.ts`).
- **Provider reset to default**: `POST /api/providers/{name}/reset` restores a
  customized built-in seed by deleting only its stored override (legacy
  case-variant duplicates included) — both roles' `provider_ref`, unrelated
  settings/plugins and other providers stay intact. Returns
  `200 {provider: {name, base_url, api_key_set, kind, models, seed: true, customized: false}}`;
  unknown name 404 `{"detail": "not found"}`, custom (non-seed) provider 400
  (`only built-in provider presets can be reset: <name>`), pristine seed/no
  stored override 409 `{"detail": "provider is not customized: <name>"}`.
  `DELETE /api/providers/{name}` keeps its existing remove-and-clear-refs
  behavior. Settings → Providers shows **Reset to default** only for a
  customized built-in seed; the confirmation warns that customized values and
  the stored override API key are discarded while Senior/Junior role
  assignments stay unchanged; against an older backend without the route, the
  client shows an unsupported message and changes nothing. Tests:
  `tests/server.test.ts`, `web/tests/providerSettings.test.ts` (web 203/203).
- **Provider presets master–detail in Settings → Providers**: the preset list
  is now identity-only (name, Senior/Junior role badges, key-state dot,
  `Customized`/`custom` tags), and the selected provider's settings appear
  inline directly below its row — Base URL, masked write-only API key, model
  ids as editable tags, an `Advanced` wire-kind disclosure, dirty-gated
  `Save changes`, an inline add card, and a delete confirm that names the
  roles which would switch to Manual. `GET /api/providers` gained additive
  `seed` and `customized` booleans so a client can tell a pristine built-in
  seed from an edited override or a custom entry (all other fields and
  routes unchanged). Pure model in `web/src/providerSettings.ts`, tested in
  `web/tests/providerSettings.test.ts` (web 195/195).
- **First-party base commands** (`src/basecommands.ts`): the built-in slash
  commands adapted from the two reference harnesses — prompt templates
  `plan`, `goal`, `feedback` (literal `$ARGUMENTS`/`$1..$9`/`$$` expansion,
  `consult` mode, `requiresArguments` usage errors) and action commands
  `compact`, `export`, `permission`, `status`, `mode`, `new`, `help` that a
  surface performs instead of submitting a task. English plus the reference
  Chinese aliases, priority ordering, `baseCommandUsage`, and
  `baseCommandMetadata()` for `GET /api/commands`. `expandTemplate` is shared
  with discovered commands (`expandCommand` delegates), so a `<name>.md`
  template and a base command with the same body render byte-identical task
  text; a discovered name shadows its base namesake. Tests:
  `tests/basecommands.test.ts`.
- **Server base-command surface**: `GET /api/commands` additively returns
  `baseCommands` (metadata only); run submission (`POST /api/runs` and legacy
  `POST /api/run`) expands base prompt commands with their mode override,
  answers a missing required argument with `400 usage: /plan <objective>`, and
  answers an action command with a 400 that points at the surface action
  instead of creating an empty turn; unknown/path-like slash lines stay
  verbatim. New `POST /api/sessions/{name}/compact` compacts one session on
  demand (404/400/409 while a run is live, `200 {compacted:true,
  before_events, after_events}`, an honest `compacted:false` no-op, 502 on
  summarizer failure with nothing written) and rewrites the JSONL with dense
  `seq`. Tests: `tests/serverbase.test.ts`, `tests/apicommands.test.ts`.
- **Web composer command surface and UI cleanup**: the `/` menu merges the
  built-in catalogue (priority order, `action` badges, alias/description
  search) with discovered templates (a discovered name shadows its base
  namesake) and degrades to discovered-only against an older backend; prompt
  commands insert `/name ` and expand server-side, action commands are
  performed locally (`/compact` via the new route with a transcript reload,
  `/export` via the shared download flow, `/help`/`/status`/`/permission`
  dialogs, `/mode`, `/new`) and never submitted as runs. A single-source
  commands-and-shortcuts overlay opens on `/help`, `?` and `Ctrl/⌘+/`; the
  composer key contract is IME- and repeat-safe with `Ctrl/⌘+Enter`
  accelerated send, picker `Tab`/`Shift+Tab`, escape layering, and a 500 ms
  double-`Esc` stop. Pure modules `web/src/basecommands.ts`,
  `composerKeys.ts`, `shortcuts.ts`, `download.ts`; tests `web/tests/
  basecommands.test.ts`, `web/tests/composerKeys.test.ts` (web 177/177).
- **TUI built-in commands and picker cleanup**: `src/tui/basecommands.ts`
  adapts the shared catalogue (native keymap commands keep their names,
  discovered templates shadow base ones, built-ins ordered by priority),
  `src/tui/inputguard.ts` stops a held `Enter`/`Tab` from repeat-submitting,
  and the `/` picker groups `TUI commands -> Built-in prompts -> Built-in
  actions -> Slash commands` with `builtin`/`action`/`template` badges,
  alias search, a highlighted-row usage footer and `Tab`/`Shift+Tab`
  accept/dismiss. Prompt commands expand with the exact shared bytes and mode
  override; `/compact` runs a real in-process compaction between turns and
  rewrites the session, `/export [path]` writes canonical Markdown, `/status`
  and `/permission` show real state only, `/new` starts a fresh in-memory
  session, and refusals are explicit. The help overlay lists the built-ins.
  Tests: `tests/tuibasecommands.test.ts` (all TUI suites 289/289).
- **CLI chat REPL built-in commands**: `chat` dispatches the shared catalogue
  before discovered templates — prompt commands run with their mode override
  and usage errors, action commands are performed by the REPL (`/compact`
  with the configured summarizer and resume-safe dense-`seq` rewrite,
  `/export [path]`, `/status`, `/permission`, `/mode`, `/help`/`/commands`),
  `/new` is refused with guidance, and `help chat` documents the surface.
  Tests: `tests/cliwiring.test.ts`.
- **Relaxed strict payload parse** (payload fix 2): `relaxedStrictPayload`
  (`src/payloads.ts`) runs before the repair re-ask — a node reply that is a
  bare JSON object or a fenced block without the byte-stable markers is
  accepted when it passes the same strict zod validation; extraction is
  relaxed, the schema is not. Tests: `tests/relaxedparse.test.ts`.
- **Graceful `serve` shutdown**: SIGINT/SIGTERM run `shutdownServe` — stop
  accepting connections, cooperatively cancel queued/running/waiting runs
  (a stop resolves pending approvals as deny), give in-flight runs a bounded
  5 s grace window, then end SSE connections and close; flushed session
  JSONL is never touched. Tests: `tests/serveshutdown.test.ts`.
- **Session search and export**: `src/sessionsearch.ts` searches session
  titles and envelope payload strings (case-insensitive literal substring,
  whitespace-collapsed, bounded single-line snippets, newest sessions first,
  per-session and overall hit caps with an honest `truncated` flag) and
  renders a session as Markdown (header + one section per envelope, payloads
  bounded to 20 000 chars) or stable pretty JSON. `loadSessionDocs` reads
  `<sessions-dir>/*.jsonl` newest-first with metadata titles attached,
  skipping corrupt files fail-soft. CLI: `sessions search <query> [--json]
  [--limit N]` and `sessions export <name> [--format markdown|json]
  [--output <path>]`. Server: `GET /api/search?q=&limit=` and
  `GET|HEAD /api/sessions/{name}/export?format=` (download headers;
  400/404 as documented). The web workspace searches message content from
  the Ctrl+K palette and exports a session from its row menu. Tests:
  `tests/sessionsearch.test.ts`, `tests/serversearch.test.ts`,
  `tests/sessionscommands.test.ts`; CLI E2E grew to 16 scenarios.
- **TUI find-in-transcript**: `Ctrl+F` (or `/find [query]`) opens an inline
  find bar over the transcript — live literal case-insensitive filtering,
  `current/total` with an honest `+N` cap, `Enter`/`Down` next and
  `Shift+Enter`/`Up` previous (wrap), the active match marked in the block
  gutter and scrolled into view (block anchor), and `Esc` restoring the
  composer draft and scroll position exactly. `src/tui/view/findbar.ts` is the
  pure state/render module; the command and its scoped keys live in the shared
  keymap registry, so `?`/F1 help, `Ctrl+P` and `tui --help` list them.
  Tests: `tests/tuifind.test.ts`.
- **TUI span-level Markdown emphasis**: `src/tui/markdownstyle.ts` is now the
  single Markdown parser producing width-safe styled lines/spans (bold,
  italic, inline code, links, headings, lists, quotes, fences, diff markers),
  and `src/tui/transcript.ts` paints those spans on top of each row's tone
  through `Theme.paintEmphasis` (all SGR stays in `theme.ts`). Span-preserving
  wrapping in `src/tui/text.ts` keeps grapheme/East-Asian/emoji widths exact.
  `plainTheme`/`NO_COLOR` output is byte-identical to the previous plain
  renderer (frozen baselines plus a 1,200-document fuzz check); a color theme
  never changes row content or width. Tests: `tests/tuistyle.test.ts`,
  `tests/tuivisualmodel.test.ts`.
- **Workspace rename and operator ordering**: `WorkspaceRegistry.rename()`
  (trimmed, 120-character cap, order unchanged) and `reorder()` (exact
  permutation validation before any mutation) persist to
  `sessions/workspaces.json`, and `GET /api/workspaces` returns the operator
  order. Server: `PATCH /api/workspaces/{id}` and
  `PUT /api/workspaces/order` (400/404 as documented). The web sidebar gained
  a per-workspace actions menu (rename dialog, move up/down, optimistic
  reorder with rollback). Tests: `tests/workspaceorder.test.ts`,
  `tests/serverworkspaces.test.ts`, `web/tests/workspaceOrder.test.ts`.
- **Broker-level approval-repeat cap**: `RunApprovalBroker` now counts
  operator denials per identical `(action, target)` pair (the shell command
  for shell approvals; target normalization shared with the harness layer)
  and, after `APPROVAL_DENY_LIMIT` (default 2) denials, auto-denies the next
  identical request immediately — no pending entry, no `approval_requested` —
  emitting one additive `approval_auto_denied` runtime event
  (`{type, action, target, count, limit}`). This covers plugin/MCP approval
  consumers that the harness-level workspace-tool cap cannot see; the
  harness cap and its `auto_denied` result shape are unchanged, and
  allows/cancellations never count. New API: `RunApprovalBrokerOptions`,
  `approvalPairKey`, `approvalMatchTarget`, `normalizeApprovalTarget`,
  `broker.autoDenials()`. Tests: `tests/approvalbrokerdeny.test.ts`.
- **Composer mentions (`@`) and slash commands (`/`)**: run tasks may now
  carry `@skill:<name>` and workspace-file mentions (`@<relative/path>`,
  root-level files serialize as `@./name`). `src/mentions.ts` scans tokens
  strictly at word boundaries (emails/`@media` are never mentions), renders
  the byte-stable `<skill-loaded name="…">` and `<file path="…">` blocks
  with bounded content and truncation markers, and normalizes paths;
  `src/workspacefiles.ts` provides a bounded, fail-soft workspace file index
  (hidden/node_modules/sensitive/symlinks excluded, depth/count caps) plus
  ranking for the `@` picker. Server: `GET /api/workspaces/{id}/files`,
  and `POST /api/runs` / `POST /api/run` expand a known leading `/name`
  command (`matchCommand`/`expandCommand`, per-run mode override; unknown
  slash lines submit verbatim) and inject validated shared-skill and
  workspace-file blocks into the shared context before the task (role-scoped
  skills and unsafe paths are refused with actionable 400s, caps
  `MENTION_MAX_SKILLS`/`MENTION_MAX_FILES`/`MENTION_MAX_TOTAL_CHARS`). The web
  composer gained accessible `@`/`/` pickers (skills, workspace files,
  command templates; debounced file search, stale-response guard) and the
  TUI gained inline `/` and `@skill:` pickers with submit-time validation and
  context injection. Tests: `tests/mentions.test.ts`,
  `tests/workspacefiles.test.ts`, `tests/mentionswiring.test.ts`,
  `tests/tuipicker.test.ts`, `web/tests/mentions.test.ts`.
- **Thinking and response streaming**: providers now report reasoning deltas
  separately from visible text — `ChatOptions.onThinkingDelta`,
  `StreamState.thinking`, `ChatDeltaKind`, and per-adapter mapping
  (OpenAI-compatible `reasoning_content`/`reasoning`, Anthropic
  `thinking_delta`, Google `thought` parts; `MockProvider` streams
  `MOCK_REASONING` when a reasoning sink is present). `HarnessOptions.streamTokens`
  emits runstream `token` events with `kind: "text" | "thinking"` in arrival
  order from the single provider seam (plain calls, tool loops, overflow
  retries, repair re-asks); reasoning is observational and never enters the
  reply, usage, envelopes or session JSONL. Server:
  `POST /api/runs {"stream_tokens": true}` (strict boolean, default off) and
  `GET /api/runs/{run_id}/events` additionally writes named, id-less SSE
  frames `event: token` with `{type, run_id, role, kind, delta, at}` — the
  existing typed-event `id`/`?after` replay contract is untouched and tokens
  are never persisted. The web chat renders a collapsible live **Thinking**
  block and a streaming **Response** block (markdown, caret) that resolve
  into the projected envelope when it arrives; the TUI renders a bounded,
  dim live `THINKING` block above the streaming response. Tests:
  `tests/thinkingstream.test.ts`, `tests/servertokens.test.ts`,
  `tests/tuithinking.test.ts`, `web/tests/streaming.test.ts`.

### Changed

- **`vue-tsc` bumped to 3.3.x** (wave 9): the web workspace devDependency moves
  from the 2026-11-04 advisory pin `~3.0.2` (resolved 3.0.11) to `~3.3.0`
  (resolved 3.3.14), pulling `@vue/language-core` 3.3.14 and
  `@volar/typescript` 2.4.30 plus their subtree in the web-local
  `web/package-lock.json` (the web app is not an npm workspace, so this
  lockfile is separate from the root one). The template-scope behavior the old
  pin was waiting on is clean: a forced `vue-tsc -b` over all 38 SFCs produces
  zero diagnostics, the web suite (329/329) and `npm run build` pass with no
  code changes. This closes the vue-tsc 3.3 follow-up.
- **Final web chrome sheets use the design tokens** (wave 8): `App.vue`,
  `ChatView.vue` and `Composer.vue` — the last large component sheets — moved
  their canonical radii and scale spacing to the existing
  `--radius-*`/`--space-*` tokens (32 value-for-value replacements), so the
  deterministic token test now covers all 17 migrated sheets and bans
  canonical radius/scale-spacing literals there. Token inventory is unchanged
  (93); dark parity untouched; zero visual delta (CSS-only, expansion
  byte-equality verified). Files: the three sheets + `web/tests/tokens.test.ts`.
- **`TWO_BROTHERS_JSON` now means `--json`** (wave 8, contract alignment): the
  env var selects the same single machine-readable output object as a bare
  `--json` (`{task, events, decision, usage, cost, rounds, errors}` on stdout,
  diagnostics on stderr) instead of the retired legacy behavior (the human
  transcript followed by the decision JSON on the last line); it applies to
  `run` (and its `--dry-run` plan) and to each `chat` REPL turn, whose banner
  and blank separators are suppressed in machine modes. Precedence is
  unchanged: `--stream`, `--json-events` and an explicit `--mode print|json`
  win over the env var, explicit flags win over an env `0`/`false`, and the
  env var is not a JSON modifier on `--mode print` (use the `--json` flag
  there). Also fixes the flag-default bug that made the env var inert through
  the CLI (`argsToConfigArgs` no longer forwards a default `json: false`).
  `PROTOCOL.md` §7's env row is updated; no envelope or JSON-Schema change,
  and `Config.jsonOut` parsing stays stable for embedders. Migration: parse the
  new object's `decision` key, or use `--mode print` for the decision text /
  `--mode print --json` for the decision-only object. Tests:
  `tests/printmode.test.ts` (+5), `tests/cli.test.ts` (+1 spawned-CLI parity).
- **Remaining web chrome sheets use the design tokens** (wave 7): nine more
  component sheets (`CommandPalette`, `ToolActivity`, `ApprovalCard`,
  `UsageFooter`, `ContextMeter`, `PromptAudit`, `CommandResult`,
  `SidebarFooter`, `WorkspaceFinder`) migrated their canonical radii and scale
  spacing to the existing `--radius-*`/`--space-*` tokens (45 value-for-value
  replacements; token inventory unchanged at 93 because every value already
  had a token — no colour literals remained in scope). A new deterministic
  token-test invariant bans canonical radius/scale-spacing literals in the now
  14 migrated sheets; the wave-4 policy keeps genuinely one-off values literal.
- **Shell approvals warn after a denied file change** (wave 6): the
  `RunApprovalBroker` now tracks whether the operator denied a
  write/edit/delete earlier in the same run; a subsequently parked
  `workspace_run_shell` approval appends one bounded caution sentence to its
  existing additive `reason` — "a file change was denied earlier in this run
  — review this command closely" — so the web card, TUI panel, approvals API
  and plugin/MCP consumers all surface it. Display-only: no decision table,
  pair key, denial-cap, session-allow or event-shape change; base reasons
  (including the fixed shell reason) stay byte-identical when no mutation was
  denied, cancellations never arm it, and `readonly`/`allow-all` never park.
  Files: `src/runevents.ts` (`SHELL_DENIED_MUTATION_CAUTION`); tests
  `tests/approvalshellcaution.test.ts` (15).
- **Web composer recall keys fall through when idle** (wave 6): with the
  recall wiring inactive (nothing to recall at the caret), Up/Down are no
  longer `preventDefault`ed — a non-empty single-line draft's ArrowDown now
  performs the textarea's native caret-to-end movement instead of a swallowed
  no-op. Active recall is unchanged (newest-first Up, Down stepping and
  byte-exact draft restore, multiline absolute edges, IME/repeat/modifier/
  selection/picker guards); `classifyComposerRecall` takes an explicit
  `ComposerRecallContext {pickerOpen, recallActive, historyCount}` and returns
  `null` for a pass-through. The hermetic `composer-recall` browser scenario
  additionally asserts the native fall-through in the real UI. Files:
  `web/src/composerKeys.ts`, `web/src/components/Composer.vue`; tests
  `web/tests/composerKeys.test.ts` (+4) and the updated
  `web/tests/recall.test.ts`.
- **Web diff views now consume the semantic diff tokens** (wave 5): the
  admin/changed-file diff chrome in `web/src/components/DiffView.vue` and
  `DiffReview.vue` switched from `--ok`/`--danger` (plus `color-mix` for the
  line fills) to the dedicated `--diff-add-fg`/`--diff-add-bg` and
  `--diff-del-fg`/`--diff-del-bg` tokens. The wave-4 token values had never
  been rendered and were reconciled to the colours the views actually showed
  (`color-mix(in srgb, C 12%, transparent)` ≡ `rgb(C / 12%)`, fg tokens equal
  to the previous intent colours per scheme), so the visual result is
  identical. The provider connect view's redundant caller-side title
  pre-clip was removed now that `renderBox` owns the title budget
  (`inner - 3`). Files: the two components, `web/src/tokens.css`,
  `packages/harness/src/tui/view/provider.ts`. The web `/help` shortcut
  table also gained the composer Up/Down recall gesture
  (`web/src/shortcuts.ts`), closing a discoverability gap in the wave-4
  feature.
- **Hermetic scale/load test suite** (wave 5): new
  `packages/harness/tests/load.test.ts` (5 tests, about 1 s total) covers
  1,500-envelope session resume/restore with dense seq and no re-append, a
  400-block TUI transcript projection bounded to exact height/width with
  in-range paging, a 200-session listing through the in-process `sessions`
  path with stable repeats and no filesystem-handle growth, 8 concurrent
  `RunManager` runs behind a barrier proving genuine concurrency with no
  cross-session mixing, and five repeated compaction rounds keeping exactly
  one summary while the rendered transcript stays bounded and non-growing.
  It asserts bounded behavior, never wall-clock correctness; real-network
  load/fault injection remains a separate open item. The browser E2E suite
  gained the hermetic `composer-recall` scenario (two accepted submissions,
  newest-first Up/Down recall in the real textarea, byte-exact draft
  restore, multiline edge rule, no accidental submit, reload persistence) —
  the suite is now 14 offline scenarios plus the opt-in `real` skip.
- **Approval-mode-aware web composer seat** (wave 4 follow-up): the composer's
  permission status seat now names the effective workspace approval mode from
  `GET /api/settings` — `ask` shows "Ask in app", `readonly` "Read only",
  `edits` "Edits auto" and `allow-all` "Allow all" — each with a truthful
  tooltip instead of always claiming the generic ask behaviour. A backend that
  omits the additive `approval_policy` section still reads as the fail-closed
  `ask` it applies. Files: `web/src/composerStatus.ts`,
  `web/src/components/Composer.vue`; tests:
  `web/tests/composerStatus.test.ts`.
- **Explicit `--provider` provenance** (wave 4, lane D): `resolveConfig`
  now records whether the run-level provider came from an explicit source —
  the `--provider` flag or `TWO_BROTHERS_PROVIDER` — in
  `Config.providerExplicit`. The TUI's provider resolution uses it, so an
  explicitly requested default-valued provider (`--provider openai`) now
  overrides a persisted non-default provider, while an absent flag keeps
  today's behavior (persisted providers survive) and a hand-built `Config`
  without the field keeps the older non-default heuristic. Flags still beat
  env; env-pinned fields are still never persisted. Files:
  `src/config.ts`, `src/tui/providers.ts`. Tests:
  `tests/cliproviderprovenance.test.ts` (10: provenance for flag/env/absent,
  TUI resolution for explicit-default/absent/env/flag>env/hand-built,
  persisted-store load, env-pinned save).
- **Web design-token layer** (wave 4, lane E): the web chrome now reads one
  semantic custom-property layer, `web/src/tokens.css` (imported first by
  `main.ts`): 93 tokens — 45 semantic colour tokens with full light/dark
  parity (surfaces, three text tiers, borders, intent accents incl. the
  senior/junior/operator role colours, diff add/remove, find hits, thinking,
  elevation) and 48 scheme-independent tokens (radii, a rem spacing scale,
  type, duration/easing, focus-ring geometry, layout contract). The dark
  palette still ships twice (prefers-color-scheme and the pinned
  `data-theme='dark'`) and a new deterministic test pins the two blocks
  identical. `style.css` and the owned chrome components (Sidebar,
  SessionGroup, SessionRow, WelcomeHero) were migrated to the tokens
  (literal radii/spacing/focus-ring values → `var(--token)`); no colour
  literal remains in those sheets and the change is value-for-value — zero
  visual difference (verified by expanding every migrated token back to its
  literal, and the token-copy check in the new test). Naming was translated
  from kimi-code's token layer (MIT reference, see `docs/attribution.md`).
  Files: `web/src/tokens.css` (new), `web/src/style.css`,
  `web/src/main.ts`, the four owned components. Tests:
  `web/tests/tokens.test.ts` (7: reference closure, light + both dark blocks,
  identical dark blocks, colour-literal ban, ordered spacing scale,
  `theme.ts` ↔ token mapping).
- **Human CLI text layout**: `run` (and every `chat` turn) renders the
  transcript as blank-line-separated envelope blocks, rules off the final
  decision with a width-capped `── decision ──` label, renders model prose as
  width-safe Markdown (the TUI's `tui/markdownstyle.ts` renderer; model ANSI and
  control bytes are sanitized before layout), and replaces the terminal
  `tokens:`/`cost:` lines with one compact footer
  (`tokens N in / M out · cache n% · K calls · cost $…`) that appears only when
  usage exists. New pure module `src/clilayout.ts` (layout, footer, width-capped
  rule; it spells no escape sequence of its own), `src/clistyle.ts` gains
  `paintEmphasis`, and generated help tables scale their
  command/flag/variable columns with the terminal width on a TTY (piped output
  keeps the historical 96-column column widths; over-long summaries now wrap
  within that width instead of overflowing it).
  Piped/`NO_COLOR` text stays plain and `stripAnsi(colored) === plain` still
  holds; the machine modes (`--json`, `--json-events`, `--stream`,
  `--mode print`, `--dry-run`) are byte-identical and keep their legacy
  `tokens:`/`cost:` diagnostics on stderr. Tests: `tests/clistyle.test.ts` (22),
  `tests/cli.test.ts` (20), and the hermetic CLI E2E human anchors.
- **TUI polish**: the palette and help overlays paint their inner rows through
  the theme (headers, chords, descriptions, group labels, unavailable rows, and
  the selected row as one inverse bar), so they follow the app's palette while
  `plainTheme` output stays byte-identical; the composer's duplicate
  `MODE … SENIOR … JUNIOR …` meta row is gone (the two-line status bar is the
  single source for mode and models); a transcript window that starts inside a
  block marks the cut with a dim `⋯` in the label gutter (width-safe, the only
  plain-theme byte change); and the status-bar hint segment moved up in
  priority (activity → hints → context → tokens → cache → cost → elapsed →
  settings warning), so `Ctrl+T expand tool` and the default hints appear at
  ordinary widths (~120 columns). TUI suites: 301 tests.
- **TUI folded tool-result previews by visual rows**: a collapsed tool row
  now keeps the first `maxToolRows` (default 6) visual rows after width-aware
  wrapping instead of raw logical lines, so one long line cannot fill the
  screen; the `… +N more lines` marker counts hidden visual rows. `Ctrl+T`
  still toggles the most recent result between the preview and its complete
  text; expansion remains per tool row, and the model keeps the full result.
  The visual-row truncation follows pi's `visual-truncate.ts` (coding-agent
  `modes/interactive/components/`, MIT, Copyright (c) 2025 Mario Zechner);
  reimplemented locally with no substantial block copied, so the NOTICE files
  are unchanged. Tests: `tests/tuivisualmodel.test.ts`.
- **Quieter, simpler conversation view**: per-model-call prompt-audit
  annotations are developer information and are hidden from the transcript by
  default — a new persisted device preference (`showPromptAudits`, versioned
  key `two-brothers.ui-prefs.v1`) is exposed as Settings → Advanced →
  `Show prompt audits in the conversation`, and when off the rows are absent
  from the DOM (no gaps, not reachable by find/scroll). The live **Thinking**
  row now starts folded and never auto-opens when the reply begins — the
  reader expands it. The operator's messages read **You** everywhere visible
  (bubble header and avatar, search/palette role hints, approval
  "awaiting you", status dialog, welcome copy), while the internal speaker id
  stays `operator`. Pure modules `web/src/uiPrefs.ts` and the new
  `chat.ts` speaker-label helpers; tests `web/tests/uiPrefs.test.ts` +
  `web/tests/chat.test.ts` (web 201/201), and the browser E2E role
  expectations follow the new label.

### Security

- **Server local-request guards**: while every binding is loopback,
  requests with a non-loopback `Host` header (DNS-rebinding defense) and
  state-changing requests with a non-local browser `Origin` are refused
  with 403; binding a non-loopback address logs a warning that the guards
  are off. Session routes accept only flattened `.jsonl` names.
  Tests: `tests/security.test.ts`.
- **`run_shell` timeout clamp**: model-supplied timeouts are clamped to
  1–600 s (default stays 30 s; non-positive means no timer), so a huge
  model-invented value cannot park a run.

### Fixed

- **TUI provider connect view at narrow widths** (wave 4, lane D): the
  dialog's box title could widen the top border by one column at very narrow
  terminals because `renderBox` decorates and clips it only to the inner
  width. The title is now clipped to the real budget (with an ellipsis) and
  omitted when there is no room, so frames at 20/25/29 columns keep every
  row within the terminal width; tests extend `tests/tuiproviders.test.ts`.
- **Settings → Appearance cards collapsed under Compact density**: the
  global compact-density rule targeting the sidebar footer's `.theme-option`
  switch also matched the Appearance dialog's cards (same class name), so with
  Compact active every card was forced to 24px and its labels/descriptions
  overflowed the border. The Appearance section now uses its own
  `.appearance-*` classes and the density rule is scoped to
  `html[data-density='compact'] .sidebar .theme-option`; a browser-E2E
  `appearance-density` scenario pins the card geometry in both densities and
  the preference across a reload.
- **Manual compaction/run mutual exclusion** (audit P1): `POST
  /api/sessions/{name}/compact` now reserves the session synchronously before
  the summarizer call and releases it in `finally`; run submission for a
  session being compacted is a 409 that creates nothing. Previously a run
  accepted during the summarizer window could have its envelopes dropped by
  the compaction rewrite (lost task line, non-dense `seq`). Two concurrent
  compacts are also serialized (one 200, one 409).
- **Compact route honesty**: the manual budgets derive from the resolved run
  config when `ServerOptions.compaction` is unset (serve-level `--compact-*`
  and `TWO_BROTHERS_COMPACT*` now apply); a client disconnect aborts the
  provider call (internal 499, no fake 502, no unhandled rejection); a corrupt
  session file is a stable 422 without leaking paths.
- **Typed non-ASCII aliases**: the web and the TUI no longer submit/run a
  typed `/目标 …`-style line (the shared ASCII slash parser can never resolve
  it) — they show a notice naming the canonical spelling and keep the draft.
- **Compaction summaries render neutrally**: the web transcript projects a
  `<summary>…</summary>` envelope as a quiet "Context compacted" system
  activity (collapsible, clipped, excluded from find/copy), and the TUI shows
  it as a dim `SUMMARY` block — never as an operator message; a resumed
  compacted session seeds the same marker in the TUI.
- **Web `/mode <arg>` and compaction lock**: typed `/mode consult|work`
  applies the composer mode (invalid/missing shows the usage and submits
  nothing), and the composer is honestly locked while a compaction runs.
- **Web workspace (UI shipped in the tarball)**: accessibility and
  keyboard-focus improvements across the chat, sidebar, composer, and
  Settings dialog, plus visible summaries of the effective per-role
  settings.
- **Web tooling**: `vue-tsc` pinned to `~3.0.2`, eliminating the minimatch
  advisory; `npm run build` keeps passing. A follow-up bump to 3.3 is
  tracked in `docs/backlog.md`.
- **Legacy SSE endpoint**: `GET /api/stream?session=<name>` now sends the
  standard SSE headers (`Content-Type: text/event-stream`,
  `Cache-Control: no-cache`, `X-Accel-Buffering: no`), so proxies and
  EventSource clients treat the legacy tail as a proper event stream.
- **Installed CLI entry**: POSIX/npm `.bin` symlinks now resolve real paths
  correctly (`isCliEntry` compares canonical paths on both sides), so an
  installed `two-brothers` executes instead of silently exiting without
  output; regression coverage included.

## [0.0.1] — 2026-11-04

First public release.

### Added

- **Structured-payload repair + few-shot exemplars** (Wave 4, S1): every
  structured node reply (`consult`, `proposal`, `delegation`,
  `deliverable`, `review`, `decision`) is checked against the strict zod
  schema after the tolerant parse and gets exactly ONE repair re-ask. The
  repair turn is a byte-stable marked `message` envelope from `"user"`
  (`[[REPAIR_REQUEST]]` … `[[/REPAIR_REQUEST]]`) appended to the shared
  context and session JSONL; the retry resends the conversation
  OpenAI-style and a still-bad reply falls back to sanitize + defaults + a
  warning, without touching `--max-rounds`. Each kind's prompt assembly
  appends one tiny strict-valid `PAYLOAD_EXAMPLES` block (code only —
  `shared/prompts.json` stays byte-identical). New exports:
  `REPAIR_REQUEST_PREFIX`, `REPAIR_REQUEST_SUFFIX`, `REPAIR_ISSUE_CHARS`,
  `STRUCTURED_PAYLOAD_KINDS`, `strictPayloadIssues`, `buildRepairRequest`,
  `PAYLOAD_EXAMPLES`. Tests: `tests/payloadrepair.test.ts`.
- **Plugins v2: scopes, hooks, argument validation, options** (Wave 4,
  S2a): `add_tool(name, handler, { description, parameters, scope,
  timeoutMs })` — an explicit `{ scope: "senior" | "junior" }` routes a
  tool to one belt (`effectiveToolScope`; legacy positional `role` and
  scope-less tools stay shared per the 2026-11-03 owner decision);
  `parameters` (the `toolschema.ts` JSON-Schema subset) turns on
  dispatch-time validation (`validateToolArgs`); `ctx.on_hook` registers
  `session_start` / `session_end` / `before_tool_call` / `after_tool_call`
  handlers dispatched fail-soft with monotonic deny (`dispatchHook`,
  `HOOK_NAMES`, `collectHooks`); settings entries may be
  `{path, options}` validated against an optional exported `configSchema`;
  `PluginManager.bindingsFor` returns `{tools, toolsByScope, hooks,
  diagnostics}`, and `GET /api/plugins` gains an additive `diagnostics`
  list. `HarnessOptions.hooks` wires hooks into a run: `before_tool_call`
  may rewrite args or deny (a `blocked` tool result carrying the denial
  text), `after_tool_call` may rewrite the result, session hooks bracket
  the run. Tests: `tests/plugincore.test.ts`, `tests/integration.test.ts`.
- **Skills** (Wave 4, S2b + integration): `src/skills.ts` discovers
  `SKILL.md` trees and loose `.md` files (`discoverSkills`, hand-rolled
  frontmatter with `name`/`description`/`scope`/`tools`, fail-soft
  diagnostics), renders the pi-style `## Available skills` section per
  role (`renderSkillsSection`) and a `<skill name="…">` body block
  (`renderSkillBody`). `HarnessOptions.skills` adds the section plus one
  invocation line to a role's assembled prompt only when that role has
  skills (prompt bytes unchanged otherwise). CLI roots: repeatable
  `--skills-dir`, `TWO_BROTHERS_SKILLS_DIR` (OS path list),
  `<cwd>/skills`, `~/.two-brothers/skills`; the server serves metadata
  (never bodies) at `GET /api/skills`. Tests: `tests/skills.test.ts`,
  `tests/integration.test.ts`.
- **Seeded provider presets + onboarding commands** (Wave 4, S2d +
  integration): `src/presets.ts` (openai, deepseek, anthropic, gemini,
  openrouter, lmstudio, custom — env-var key NAMES only, never literals),
  `mergeSeedPresets` (stored presets override seeds by name),
  `presetById`, `presetApiKey`. The server lists the merged table at
  `GET /api/providers` (masking unchanged, `api_key_set` reflects env-backed
  keys), accepts seed ids as `provider_ref`, and materializes a stored
  override when a seed is edited. New CLI: `models --base-url <url>
  [--api-key|--api-key-env]` (`provider.listModels()`) and `onboard`
  (`--preset`, interactive or `--non-interactive`, piped-stdin safe).
  Tests: `tests/presets.test.ts`, `tests/cliergonomics.test.ts`,
  `tests/integration.test.ts`.
- **Cost estimation** (Wave 4, S2d): `src/cost.ts` — `MODEL_PRICES`
  (USD per 1M tokens), `priceForModel` (exact, last `/` segment, longest
  prefix), `estimateCost` (null for unknown models). `run` prints a
  `cost:` line when both roles share one priced model; `--mode json`
  carries `cost`.
- **`--max-tokens` output caps** (Wave 4, S2d + integration):
  `Config.maxTokens` (env `TWO_BROTHERS_MAX_TOKENS`) plus per-role
  overrides (`maxTokensForRole`); forwarded to OpenAI `max_tokens`,
  Anthropic `max_tokens` and Gemini `maxOutputTokens`, by the CLI's
  providers and by `providerFromEndpoint` (server / preset runs).
- **CLI + server wiring for plugins and skills** (Wave 4, integration):
  `run`/`chat`/`serve` load plugins (`--plugins-dir`, env
  `TWO_BROTHERS_PLUGINS_DIR`, default `<cwd>/plugins`; fail-soft,
  diagnostics only under `--verbose`), merge `toolsByScope` into the run's
  `toolScopes`, pass hooks into `HarnessOptions`, and build the skills
  catalog; the server uses `bindingsFor`, hands hooks + skills to every
  run, serves `GET /api/skills`, and applies per-plugin options with
  `setSettings` before reloading. New public exports for all four lanes;
  `tests/run-all.ts` registers every suite, with the hermetic
  `tests/integration.test.ts` covering the seams end-to-end.
- **The built web workspace ships in the npm tarball**: `scripts/sync-web.mjs`
  copies the repo's `web/dist` into `<package>/web` (pure Node, no deps), the
  `prepack` hook builds `dist/` and runs it, and `files` includes `web`. The
  server resolves the default static root from the module location — packaged
  `<package>/web` first, then the repo's `web/dist` — so `npx two-brothers
  serve` works without a separate frontend build. `resolveDefaultWebDist` is
  exported for hermetic tests.
- **Token-based compaction accounting** (Wave 3, 3b): compaction budgets
  can now track tokens against a provider's context window instead of
  chars. `estimateTokens(text)` (calibrated zero-dep heuristic, rounded
  up — documented as an estimate); `ProviderConfig.contextWindow`
  (`--context-window`, env `TWO_BROTHERS_CONTEXT_WINDOW`) feeds pi's
  trigger model: fire at `contextWindow - reserveTokens` estimated
  tokens, auto budgets derive in tokens (tail ≤ trigger/2, summary ≤
  trigger/4, reserve default 2000, clamped to half the threshold); the
  overflow→compact-and-retry recovery compacts to token budgets sized
  `contextWindow - reserveTokens` when a window is known. Explicit
  `--compact-threshold-tokens` (env `TWO_BROTHERS_COMPACT_THRESHOLD_TOKENS`)
  forces token mode with a custom threshold. With no window/threshold
  configured, today's char behavior runs unchanged (full back-compat —
  `--compact-threshold <chars>` keeps char semantics; serialization caps
  stay char-based as output shaping). New exports: `estimateTokens`,
  `selectCutPointTokens`, `CompactionUnit`, `compactionUnit`,
  `CompactionBudgets`, `compactionBudgets`, `compactionTriggerTokens`,
  `DEFAULT_RESERVE_TOKENS`, `DEFAULT_KEEP_RECENT_TOKENS`. Tests:
  `tests/compactiontokens.test.ts` (estimator rows, token trigger,
  budget derivation, reserve clamp, overflow recovery in token mode,
  char back-compat).
- **Multi-provider adapters** (Wave 3, W3-2): Anthropic Messages and
  Google Gemini adapters behind the existing `Provider` interface —
  `kind` (`openai-compatible`/`anthropic`/`google`) selects the wire
  adapter per role via `--provider-kind`/`--senior-kind`/`--junior-kind`
  (env `TWO_BROTHERS_PROVIDER_KIND`, `TWO_BROTHERS_SENIOR_KIND`,
  `TWO_BROTHERS_JUNIOR_KIND`), and on the server path a preset's `kind`
  rides `RoleEndpoint` to the adapter (kind pairs with a borrowed
  baseUrl only). Adapter errors classify through the Wave-2 registry
  (Anthropic `overloaded`/`rate_limit`/`api_error`, Google
  `RESOURCE_EXHAUSTED`/`UNAVAILABLE`/etc. retryable; rejected/auth rows
  fatal; overflow shapes → `ProviderContextOverflowError`); usage maps
  per family incl. Anthropic cache-read and Gemini cached-content math.
  `tests/adapters.test.ts` — 29 hermetic stub-fetch tests; the
  OpenAI-compatible path stays byte-stable.
- **Plugins shared by default** (Wave 3, W3-1): when a plugin is added
  it works for both brothers — plugin tools always join the shared
  scope; settings carry one top-level `plugins: string[]` (legacy
  per-role shapes and `TWO_BROTHERS_PLUGINS_SENIOR`/`_JUNIOR` merge
  fail-soft and are never persisted); the web SettingsDialog has a
  single Plugins multi-select. Per-role scoping is a documented future
  refinement.
- **Structured prompt sections + per-call prompt audit** (Wave 2, B2):
  `assembleSystemPrompt(base, tools)` appends pi-style `## Available
  tools` (the call's actual model-facing belt — MCP namespacing applied,
  one line per tool; explicit "You have no tools; answer from the
  transcript." when empty) and `## Using tools` directives to each role's
  base prompt, assembled in code — `shared/prompts.json` stays
  byte-identical; the work-mode junior's deliverable message carries a
  delegation directive after the byte-stable transcript. Every provider
  request records a `PromptAuditEntry` (role, node kind, section names,
  tool names, system/user char lengths — never prompt bodies) on
  `HarnessResult.promptAudits`; `--verbose` prints the trail. Motivated
  by a real-model LM Studio finding: with no tool mentions in prompts a
  small-model junior improvised workspace facts; with sections it either
  uses its tools or reports their absence.
- **Per-call prompt audits on the wire** (Wave 2, B2 follow-up): the
  audit entry is now also a typed runtime event — `RuntimeEvent` gains
  `prompt_audit` (additive; payload identical to `PromptAuditEntry` plus
  the usual `run_id`/`at`), emitted immediately before every provider
  call. `GET /api/runs/{id}/events` streams it live (the event store and
  its sidecar need no shape change; protocol envelopes and the protocol
  schema are untouched), and the web workspace's activity timeline shows
  a collapsible per-call row (role, node kind, section/tool counts, char
  lengths, name lists on expand). Tests: unit in
  `tests/promptsections.test.ts`, SSE in `tests/server.test.ts`, and the
  hermetic `e2e/server-prompt-audit.ts` suite (frame order around the
  tool/approval round, sidecar persistence, `?after=` replay).
- **Provider error classification + Retry-After** (Wave 2, A; port of
  pi-ai's `utils/{retry,provider-retry,overflow}.ts`, MIT): ordered
  `PROVIDER_ERROR_REGISTRY` — 408/409/429/5xx and transport wording
  retry; other 4xx, quota/billing exhaustion, context overflow and
  unclassified errors fail fast with the provider's message instead of
  burning the retry budget. A retryable response's `Retry-After`
  (delta-seconds or HTTP-date, capped at 120 s) replaces that attempt's
  fixed backoff. `ProviderContextOverflowError` (never retried) on
  overflow-shaped payloads. Retry contract otherwise unchanged (6
  retries, 2/4/8/16/30 s cap, abort-aware waits). New public exports
  including the registry, classifiers and `parseRetryAfterSeconds`.
- **Web-run status contract** (Wave 2, A): `RunManager` emits
  `run_status: waiting` when a run parks on an operator approval and
  `run_status: running` on resolution (cause event first) over SSE;
  `RunRecord` carries `mode` (request mode or resolved config default);
  `GET /api/runs/{id}` falls back to a sorted sidecar scan and rebuilds
  a minimal terminal record from `run_end` + `run_error`, so a failed
  run's error survives a backend restart. The web UI's polling
  workarounds were dropped on top of this contract (probe poll and
  client-side waiting patches removed; retry reuses the recorded mode).
- **Robust workspace edits + per-file mutation queue** (Wave 2, A; port
  of pi's `edit-diff.ts` + `file-mutation-queue.ts`, MIT): three-tier
  edit matching (byte-exact → normalized LF/NFKC/trailing-whitespace/
  Unicode-punctuation view → indentation-flexible whole-line blocks with
  re-based replacement), BOM and line-ending style preserved, ambiguous
  matches fail with line-numbered errors unless `replace_all`;
  write/edit/delete serialize through a module-level promise queue keyed
  by realpath (call order, symlink-aware, Windows case-folded); reads
  never take the queue.
- **Context compaction v2** (Wave 2, B1; pi port): split-payload cuts —
  an oversized envelope is serialized head+tail with an explicit
  middle-truncation marker, so a single huge delegation can no longer
  make a session uncompactable; incremental `<previous-summary>`
  chaining under pi's verbatim update prompt when re-compacting; reserve
  margin in the auto trigger (`reserveChars`, default 8000, clamped to
  half the threshold) so a post-compaction reply has headroom; overflow
  → compact-and-retry — a `ProviderContextOverflowError` from chat or
  tool calls compacts once and retries; a second overflow propagates.
  New exports: `selectCutPoint`, `compactionTriggerChars`,
  `compactionSummaryText`, `DEFAULT_RESERVE_CHARS`,
  `UPDATE_SUMMARIZATION_PROMPT`, `SerializeOptions`.
- **MCP hardening** (Wave 2, A): model-facing tool names are namespaced
  `mcp__<server>__<tool>` (sanitized, 64-char cap, stable sha256 suffix
  on truncation/collision; wire calls keep raw names) with a readable
  `server/tool` display mapping; results clipped to 20 KiB with the
  shared truncation marker; per-call timeout (60 s default, per-server
  `timeoutMs` override).
- **CLI first-run UX (modern-CLI conventions):** bare `two-brothers` on an
  interactive terminal drops straight into the `chat` REPL (piped/CI
  invocations still get the usage screen); `help`, `--help`, and `-h` print
  usage with exit 0; the REPL greets with the resolved provider/model/base
  URL per role and accepts `/help`, `/config`, `/exit`, `/quit` (the REPL
  loop reads stdin via async iteration, so piped scripts can drive it — the
  old question-per-line loop dropped lines that arrived mid-run).
- **Streaming run events + `run --stream`** (Wave 4, S3a): `src/runstream.ts`
  adds the in-process run stream — `StreamEvent` (`run_status`
  started/completed/failed/cancelled, one `envelope` per appended envelope,
  `repair`, `tool_call`/`tool_result` with `ok`/`error`/`blocked`, and a
  terminal `result` summary of decision + usage + warning count + session
  file) with `HarnessOptions.onStreamEvent` as the sink (named apart from
  the existing `onEvent` `RuntimeEvent` hook; the server SSE path and
  `onEnvelope` are untouched). Emission is fail-soft: a throwing consumer
  never changes a run's outcome. `toNdjsonLine` serializes one record per
  line under the dsh §R3 bounds — a field over `STREAM_FIELD_CHARS`
  (8192 chars) becomes `<clipped N chars>`, and a line over
  `STREAM_LINE_CHARS` (32768 chars) has its longest fields clipped until
  it fits (chars, not bytes — documented divergence). CLI `run --stream`
  prints those lines as events arrive and exits 0/1 per the usual status
  semantics; the human summary and cost line are suppressed (the `result`
  record carries usage, so consumers call `estimateCost`). `--stream` is
  its own output mode and exits 2 when combined with `--json`,
  `--json-events` or `--mode print|json`. New exports: `StreamEvent`,
  `HarnessResultSummary`, `toNdjsonLine`, `STREAM_FIELD_CHARS`,
  `STREAM_LINE_CHARS`, `clippedMarker`, the five record interfaces and
  their status unions. Tests: `tests/streaming.test.ts`. No new runtime
  deps.
- **Approval-deny repeat cap** (consumer-journey fix, 2026-11-04): a run
  tracks denied `(action, target)` pairs for the workspace mutation tools
  (`write` / `edit` / `delete` / `shell`). Once the operator has denied the
  same pair `APPROVAL_DENY_LIMIT` (2) times, the next identical request is
  auto-denied in the harness's tool path without invoking the workspace's
  `PermissionManager` broker, so a stubborn model cannot park a run in
  `waiting` indefinitely. Different targets and actions still reach the
  operator. The auto-denial reuses the workspace's `status: "denied"`
  representation (plus additive `auto_denied: true` and an explanatory
  `error`; `tool_completed` status `denied`, stream `tool_result` status
  `error`). Tracking is per run — a fresh `run()` starts with an empty map.
  New exports: `APPROVAL_DENY_LIMIT`, `approvalPair`. Tests:
  `tests/approvaldeny.test.ts`.
- **Provider timeout diagnostics** (consumer-journey fix, 2026-11-04):
  `BaseHttpProvider` emits ONE `[warn] provider attempt timed out after
  Ns; retrying (attempt k/n) — consider --timeout for slow models` line per
  timed-out attempt that will be retried, capped at
  `MAX_TIMEOUT_WARNINGS` (3) per provider instance. The sink is
  `ProviderConfig.onWarning` (default `console.error`: stderr only, so
  stdout stays parseable under `--mode json` / `--json` / `--stream`); the
  CLI passes `CliIO.error` through a three-per-run cap, so the warning
  appears WITHOUT `--verbose`. `ProviderTimeoutError` is the new typed
  per-attempt timeout (retryable; message unchanged). `serve --help` now
  documents `--timeout` and its retry warning. Tests:
  `tests/providerwarnings.test.ts`.
- **`GET /api/runs/{id}` rebuild marker** (consumer-journey fix,
  2026-11-04): a record rebuilt from the runtime sidecar after a backend
  restart carries the additive `"rebuilt": true` field; live in-memory
  records omit it, so the web UI can explain its blank `task` / `mode`
  fields. Tests: `tests/server.test.ts` (sidecar recovery section).
- **Plugin-contributed MCP servers** (research note
  `plugins-pi.md` R6): a plugin can now bring its own MCP server.
  `PluginContext.add_mcp_server(name, config)` records a declaration shaped
  exactly like one `--mcp-config` `mcpServers` entry (stdio
  `command`/`args`/`env`/`cwd` or streamable-HTTP `url`/`headers`, plus the
  optional per-server `role` — default `junior` — and `timeoutMs`); an
  exported `mcpServers` object on the plugin module is the declarative
  alternative and is ingested by `loadPlugins`. Both paths feed one
  per-context registry, and bad names/configs become diagnostics, never
  throws. New exports: `PluginMcpServer`,
  `collectPluginMcpServers`, `PluginBindings.mcpServers`,
  `LoadedPlugin.mcpServers`, `mergeMcpConfig`,
  `McpConfigFileShape`, `isValidMcpServerName`, `mcpServerSpecIssue`
  (`src/mcp.ts`): a configured entry wins a name collision, then the first
  plugin to contribute the name; collisions are reported. The merged
  `{mcpServers}` feeds `loadMcpTools` unchanged, so `mcp__<server>__<tool>`
  namespacing, the 20 KiB result clip and per-server role routing are
  untouched. Library level only — CLI/server wiring is a follow-up. Tests:
  `tests/pluginmcp.test.ts`. No new runtime deps.
- **Skill invocation** (Wave 4, S2b follow-up): the advertised
  `<skill name="…">` grammar now does something. After each structured
  reply is parsed (the `structuredReply` pass, after the payload-repair
  attempt), `deliverSkillRequest` scans the raw reply text for the request
  and appends the skill's markdown as a `message` envelope from `"user"`:
  `<skill-loaded name="…">` … `</skill-loaded>` (kimi-code's delivery
  convention; the body is used directly so it is not double-wrapped in
  `renderSkillBody`'s `<skill>` element). The envelope rides the ordinary
  append path — dense `seq`, session JSONL, `onEnvelope`, "Context events:"
  — so no new stream/runtime event types exist. Guards: at most three
  deliveries per run, each skill at most once, only catalog skills visible
  to the acting role (`shared` or the role's own scope), unknown names
  inject nothing, and the pass never throws. The node's own outcome is
  unchanged: the payload was parsed before delivery, which only enriches
  later turns. Tests: `tests/skillinvoke.test.ts`. No new runtime deps.
- **Token streaming** (Wave 4, provider lane): providers can now stream
  their reply as it is generated. `Provider.chat` gains an optional fourth
  argument (`ChatOptions { onDelta }`), and `ToolChatOptions` extends it, so
  `chatWithTools` streams too. When `onDelta` is set, each adapter requests
  the provider's SSE stream and calls the sink once per TEXT delta, in
  arrival order: OpenAI-compatible sends `stream: true` +
  `stream_options.include_usage` (deltas from `choices[0].delta.content`,
  usage from the final chunk), Anthropic sends `stream: true`
  (`content_block_delta` text, `message_start` + `message_delta` usage,
  `message_stop`), Gemini switches to
  `:streamGenerateContent?alt=sse` (`parts[].text` +
  `usageMetadata`; auth stays the `x-goog-api-key` header). Tool-call
  fragments reassemble per family. The resolved value, usage accounting and
  the retry loop are unchanged — the stream is assembled into the same
  response shape the non-streaming path parses. The per-attempt
  `AbortController` timeout bounds the WHOLE stream, and a mid-stream
  transport failure is classified by the existing
  `PROVIDER_ERROR_REGISTRY` (retryable transport wording) with deltas
  already delivered staying delivered. With no `onDelta` the request is
  byte-identical to before. `runstream.ts` gains
  `TokenStreamEvent` (`{type: "token", role, delta, at}`), and
  `HarnessOptions.streamTokens` (default false; active only with
  `onStreamEvent`) threads one delta sink through every role call —
  plain `chat`, the repair re-ask and the tool loop — so `token` records
  are additive to the existing envelope/lifecycle records. A giant delta is
  are clipped by `toNdjsonLine` like any field. New types/helpers:
  `ChatOptions`, `TokenStreamEvent`, `MOCK_DELTA_CHARS`,
  `emitMockDeltas` (`MockProvider` fakes a chunked stream when asked).
  Tests: `tests/streamingtokens.test.ts`. No new runtime deps.
- **TUI: a zero-dependency full-screen chat** (Wave 5, TUI lane):
  `two-brothers tui [task]` opens an alternate-screen chat over the same
  harness (`mock` or real providers), with a header bar, a bottom-anchored
  transcript, an input line and a status bar. The split keeps the tested
  core pure: `src/tui/render.ts` has no I/O (`wrapLine` colors by line
  kind without counting ANSI width, `renderFrame` windows wrapped rows
  from the bottom with `scrollOffset`, and same-state renders are
  byte-identical); `src/tui/terminal.ts` is a thin driver
  (alternate screen, cursor visibility, raw keypresses via
  `readline.emitKeypressEvents`, and `isTtyOk`) that refuses a non-TTY
  stdin; `src/tui/app.ts` owns the state machine and the per-turn harness
  construction (same config/session/plugin/MCP/hook/skill/compaction path
  as `chat`). Keys: Enter sends, Backspace edits, PgUp/PgDn scroll,
  Esc/Ctrl+C twice quits after a confirm hint. Slash input reuses
  `commands.ts` (`/help`, `/commands`, `/mode consult|work`, `/exit`, plus
  discovered commands); `--stream-tokens` appends token deltas in place,
  and `run_status` completed/failed updates the status bar. A piped stdin
  exits 2 with a clean message and no escape bytes. New exports:
  `renderFrame`, `wrapLine`, `pushLine`, `appendText`, `KIND_STYLE`,
  `RESET`, `ANSI`; `reduceStreamEvent`, `resolveTuiInput`,
  `envelopeToLine`, `runTuiApp`, `isTtyOk`, `createTerminal`. Tests:
  `tests/tui.test.ts`. No new runtime deps.
- **Wiring: slash commands in chat REPL, `--stream-tokens`, plugin-MCP
  merge in run/chat/serve, `GET /api/commands`** (Wave 5, wiring lane):
  the polish-wave modules are reachable from the product surface —
  the chat REPL dispatches `/name args` through `matchCommand` /
  `expandCommand` (a command's `mode` overrides that turn only; an unknown
  name is a hint, never a task), `run --stream --stream-tokens` emits
  `token` NDJSON records, `run`/`chat`/`serve` merge plugin-contributed MCP
  servers under `--mcp-config` (`mergeMcpConfig`, plugin tool scopes fold
  into `toolScopes`, `serve` closes the MCP client in a `finally`), and
  the server serves command metadata at `GET /api/commands`. The TUI lane
  reuses the same command catalog and token stream. Tests:
  `tests/cliwiring.test.ts`, `tests/pluginmcp.test.ts`,
  `tests/apicommands.test.ts`, `tests/tui.test.ts`.

### Changed

- **Plugins are shared by default** (owner decision 2026-11-03): every
  plugin tool joins the `shared` `toolScopes` scope, so both the senior
  verify slice and the junior belt receive it. Settings carry one shared
  top-level `plugins: string[]` list (persisted in `sessions/settings.json`
  and used by the single plugins multi-select in the Settings dialog).
  Legacy per-role sections (`{"senior": [...], "junior": [...]}`) and
  legacy top-level `plugins_senior`/`plugins_junior` keys are merged on
  read (dedup, order preserved) and dropped on the next save; the
  deprecated `TWO_BROTHERS_PLUGINS_SENIOR`/`_JUNIOR` env vars stay
  accepted as additive aliases merged into the shared set (never
  persisted). `PluginManager.toolsFor` now takes
  `(activeNames, workspace)`; `ctx.add_tool`'s `role` argument is still
  accepted for plugin-source compatibility but no longer scopes
  assignment, and `GET /api/plugins` reports `roles: ["shared"]`.
  `PUT /api/settings` still accepts the legacy per-role object (merged),
  so older clients/scripts keep working. Per-role plugin scoping is
  recorded as a future refinement in `docs/develop/BACKLOG.md`.
- **Bare `run --json` is an output mode, not a print-mode modifier**
  (consumer-journey fix, 2026-11-04): `--json` without an explicit
  `--mode print|json` now selects the machine-readable `--mode json`
  object (`{task, events, decision, usage, cost, rounds, errors}`) instead
  of printing the human transcript plus one final decision line. An
  explicit `--mode print --json` still narrows print mode to the decision
  object, and `--json` keeps composing with a cooperation mode
  (`--mode work --json`). `--help` documents `--json` on its own line
  instead of grouping it with `--verbose` under the print-mode note. The
  `TWO_BROTHERS_JSON` env var keeps its `PROTOCOL.md` contract (print the
  final decision as JSON on the last line) — only the flag changed.

## [0.1.0] - 2026-11-02

### Added

- **Core + execution tier ported from the Python implementation**
  (`python/two_brothers/`) to a publishable TypeScript npm package:
  protocol envelopes with tolerant `parse_model_output` → strict zod
  validation → sanitizing bridge; byte-stable transcript rendering
  (`[[TASK]]`/`[[/TASK]]`, "Context events:"); JSONL session store with
  flush-per-append, dense `seq`, and resume without re-appending history.
- **Provider layer:** mock provider at parity with Python, plus an
  OpenAI-compatible `fetch` client with a harness-owned retry loop
  (exponential backoff 2/4/8/16/30 s), abort-aware cancellation, per-attempt
  timeout, and usage tracking (input/output/cached tokens, model-call count).
- **Cooperation state machine** (`harness.ts`): senior consult → junior
  answer/proposal → senior verify (read-only tool slice) → senior review →
  junior revise loop → senior decision; confined workspace tools
  (read/list/search/write/edit/delete with unified diffs, symlink-aware root
  confinement), fail-closed permission manager with an operator approval
  broker, bounded cancellable shell runner (process-tree kill on Windows and
  POSIX); `tool:`/`verify:` evidence and usage snapshot in payloads.
- **CLI parity** (`run`/`chat`/`sessions`/`selftest`/`serve`) from the built
  `dist/`, byte-identical mock output vs the Python CLI including the
  `tokens:` usage footer; shebang-verified `two-brothers` bin.
- **Product shell** (server/runtime/settings tier, no new runtime deps):
  settings + secret stores (`settings_store.ts`, `secretbox.ts`; per-role +
  provider-preset persistence, DPAPI/`plain1:` sealed API keys, env-pinned
  values never persisted); worker-pool run manager with typed events,
  same-session serialization, cooperative stop, and JSONL runtime event
  sidecars; FastAPI-compatible HTTP + SSE server on plain `node:http`
  (sessions CRUD, background runs, mid-stream approvals, `/api/fs/browse`,
  static serving with SPA fallback); workspace registry + metadata sidecars.
- **MCP tool loading** (`mcp.ts`) on `@earendil-works/pi-mcp` with
  role-scoped server assignment (`shared`/`senior`/`junior`) feeding the
  tool-scope registry.
- **Context compaction** (`compaction.ts`) — pi-durable's algorithm
  ported onto the envelope format: cut-point selection that never loses
  the original task, plain-text transcript serialization (2000-char
  entry cap), and pi's pinned structured-summary prompt. Auto trigger
  when the rendered context passes `--compact-threshold <chars>` (with
  capped budgets so a compacted context lands under the threshold),
  one-shot `--compact`, `--compact-keep-recent <chars>` verbatim tail
  (default 40000), `TWO_BROTHERS_COMPACT*` env vars. The summary is
  produced by the configured provider (senior by default) and carried as
  a clearly-marked `message` envelope, so protocol envelopes and the
  session JSONL shape stay byte-valid; compacted sessions resume through
  the new temp-file + rename `SessionStore.rewrite()`. Fail-soft by
  contract: a summarization failure logs a warning and keeps the full
  context. Python has no compaction — a documented TS-first divergence.
- **E2E suites** (`e2e/`): connection probe, consult, work-with-approvals,
  resume, Python-parity, and server-over-HTTP suites — hermetic with a mock
  provider, SKIPs cleanly when the real-model endpoint is unreachable, and
  green against LM Studio on both the `.ts` sources and the built `dist/`.
- 313 unit tests on the core tier (+ settings/runtime/server/MCP/plugins/
  compaction coverage), all green; offline selftest is the fast gate.

### Changed

- `typescript/` remains the zero-dependency protocol reference; the
  publishable build is `tsc` → `dist/` (ES2022, Node ≥ 22.19, declarations on).
- `@earendil-works/pi-mcp` exact pin 1.4.0 → 1.5.0 (lockfile-reviewed;
  same `McpTimeoutError` / `McpRequestOptions.timeoutMs` surface; upstream
  fixes OAuth URL-scheme validation and an HTTP error-body leak).

## [0.0.1] - 2026-11-02

Publish preparation for the first npm release (supply-chain hardening, after
earendil-works/pi, MIT):

### Added

- `scripts/check-pinned-deps.mjs` (wired into the root `npm run check`):
  every runtime dependency of `packages/harness` must be an exact version.
- `scripts/check-runtime-deps.mjs` (wired into the root `npm run check`):
  every bare import in the built `dist/*.js` must be declared in
  `package.json` dependencies — no phantom imports, no missing deps.
- `scripts/tarball-smoke.mjs` (root `npm run check:tarball-smoke`, run
  manually pre-release): packs the tarball, installs it into a fresh temp
  dir, and smoke-runs `dist/selftest.js` (expects `SELFTEST: PASS`) and
  `dist/cli.js run "smoke" --provider mock` (expects exit 0 + `tokens:`
  footer).
- `.husky/pre-commit`: blocks `package-lock.json` commits unless
  `ALLOW_LOCKFILE_CHANGE=1` is set.
- This changelog.

[Unreleased]: https://github.com/nik1138/two-brothers-harness/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/nik1138/two-brothers-harness/releases/tag/v0.1.0
[0.0.1]: https://github.com/nik1138/two-brothers-harness/releases/tag/v0.0.1
