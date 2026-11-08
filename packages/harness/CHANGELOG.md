# Changelog

All notable changes to `@two-brothers/harness` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **Windows shell selection and stdio drain:** `probeBash()` now rejects the
  Windows WSL launcher (`C:\Windows\System32\bash.exe`, WindowsApps) instead of
  auto-selecting it; WSL bash passed the spawn probe but ran commands in a Linux
  filesystem, breaking ordinary Windows paths. Git Bash/MSYS2/Cygwin still
  qualify, and an explicit `bash` option can still select WSL. The post-exit
  stdio `close` grace is now 2 s (was 250 ms): a loaded machine can deliver the
  last stdout chunks after `exit`, and the old bound dropped real output.
- **Node 22 compatibility for the wave-26 shell/clipboard paths:**
  `ShellRunner` now waits for the child's stdio `close` (bounded to 250 ms
  after `exit`) before assembling output, so a fast exit cannot return empty
  or partial stdout on Node 22; the clipboard writer's per-writer deadline is
  referenced, so a stuck writer always resolves as a timeout instead of
  leaving a pending promise when the event loop empties.

### Added

- **Provider retries: `retry-after-ms` and bounded backoff jitter** (port of
  pi-ai's `utils/provider-retry.ts`, MIT): a retryable response's
  `retry-after-ms` header (finite milliseconds) now wins over `Retry-After`
  (seconds or HTTP-date), with both capped at the existing 120 s; malformed
  values fall through to the next source and then to the scheduled backoff.
  Exponential waits now carry a bounded 0–25% reduction (never an increase,
  injectable RNG for tests), while provider-supplied delays are honored
  exactly. The public retry contract is unchanged: default 6 retries, base
  2 s, cap 30 s, abortable waits and per-attempt timeout. Files:
  `src/provider.ts`, `src/index.ts`; tests `tests/retryregistry.test.ts` and
  new `tests/retryjitter.test.ts`.
- **Session storage v2 (opt-in, wave 27):** `src/sessionlayout.ts` adds a
  project/session directory layout alongside the legacy flat store. A migrated
  store (`<sessions-dir>/.layout.json` with `{"version":1,"layout":"dirs"}`)
  writes `<project>/<stem>/session.jsonl` with `meta.json` and `events.jsonl`
  inside the session directory; project keys are a slug plus a short hash of
  the normalised workspace path (`_global` when unlinked). Readers always
  accept both layouts, directory sessions win a name clash, and the public
  session name, envelope bytes and API payloads are unchanged. `sessions
  migrate [--dry-run] [--json]` moves flat sessions copy-first, groups by the
  metadata workspace link, adopts identical interrupted targets, reports
  conflicts without overwriting, and writes the marker only after a clean
  pass. Metadata and runtime-event stores take an optional `SessionLayout`;
  the server materialises a session directory before the run manager persists
  its first event. The CLI resolves the public session name in both layouts
  (`show`/`export`/`fork`/`rewind`/`undo`), so a directory session never
  surfaces as `session.jsonl`. Event-only session directories are scanned for
  restart recovery even when a failed run never wrote a transcript. Tests:
  `tests/sessionlayout.test.ts`, `tests/serverlayout.test.ts`,
  `tests/sessionsmigrate.test.ts`.
- **Bounded tool-output spill:** oversized plain-text tool results are saved in
  full under a private spill root and the model receives a bounded head/tail
  preview plus a `[[SPILL id=... chars=...]]` marker and one `spill_read`
  instruction line. The new `spill_read` tool (`{id, offset?, max_chars?}`)
  returns at most 16 KiB per call, validates random-hex ids before touching the
  filesystem, and can never read an arbitrary path. `HarnessOptions.spill`
  (`{root, maxInlineChars?, maxReadChars?}`, default budget 20,000 chars)
  enables it; `serve` uses `<sessionsDir>/spill`, while the CLI and TUI use the
  session-file directory when one is configured (a run without a session file
  keeps the historical clipping). MCP results are handed to the spill layer
  unbounded when spill is on and keep the existing 20 KiB clip when it is not.
  Storage failure is fail-soft: the result falls back to the existing
  `...[truncated N chars]...` marker and the run records one warning. Spill
  files persist until the operator removes the directory; no new runtime
  dependency.
- **Wave 26: browser coverage for the wave-25 web surfaces, TUI clipboard and
  attention, an external editor, the undo lifecycle, fork-from-here, session
  hardening, a doctor MCP check and per-preset context windows:**
  - **Browser E2E for the wave-25 web surfaces:** two hermetic scenarios close
    the wave-25 coverage gap without a product-source change. `tab-title`
    drives one scripted run through the running marker (`▶`), the real
    approval parking (`!`) and the plain title after completion, then asserts
    the unread/selection rules — a selected session never carries the unread
    count, deleting the open session shows `(1) Two Brothers`, and opening the
    unread session consumes it. The full title matrix (queued, `(failed)`,
    sanitize/cap) is covered by `web/tests/tabTitle.test.ts` (16).
    `settings-advanced` asserts the Settings → Advanced **Auto-compaction**
    card end to end: the four labelled inputs, per-field effective/source
    lines, native `min=0` blocking of a negative value, inline `role="alert"`
    validation (with `aria-invalid` and a footer alert) blocking Save, exactly
    one `PUT /api/settings` for a valid save, persistence in
    `sessions/settings.json`, and survival after reload. Files: `e2e/run.mjs`,
    `e2e/fixtures/scripted-server.mjs` (and its README); no product source
    change.
  - **TUI clipboard and terminal attention:** `Ctrl+X` copies the last
    completed reply as plain text — the newest committed decision, or the
    newest completed outgoing senior reply when there is no decision (junior
    proposals, tool results, notices, streaming drafts and operator text are
    never selected). Native clipboard writers are tried first (PowerShell or
    `clip.exe` on Windows, `pbcopy` on macOS, `wl-copy`/`xclip`/`xsel` on
    Linux/BSD); where there is no OS clipboard to reach (remote/SSH, a
    container, WSL without WSLg) or every native writer fails, the TUI writes
    one OSC 52 sequence, capped at 100 000 base64 characters, and reports the
    route honestly instead of claiming a clipboard write. Each writer has a
    5 s timeout; an empty transcript answers `nothing to copy yet`. `Ctrl+X` is
    a fixed app-scope binding (not one of the three rebindable global chords)
    and appears in the `Ctrl+P` palette, the `?`/`F1` overlay and `tui --help`.
    The terminal driver now sets an OSC 0 title
    (`Two Brothers — <session> · working|approval|done|failed`, plain when
    idle, `Two Brothers` with no session; sanitized, ≤120 chars) on session
    start/switch and run transitions, restores `Two Brothers` on exit when it
    changed the title, and emits exactly one OSC 9/BEL notification per parked
    approval id (never on a normal turn end or a cancelled run; tmux gets a DCS
    passthrough). Non-TTY and `TERM=dumb` sessions write nothing. Files:
    `src/tui/clipboard.ts`, `src/tui/copytext.ts`, `src/tui/attention.ts` (new),
    `src/tui/terminal.ts`, `src/tui/app.ts`, `src/tui/keymap.ts`; tests
    `tests/tuicopy.test.ts` (18), `tests/tuiattention.test.ts` (11) and the
    assembled-app cases in `tests/tuiintegration.test.ts`.
  - **TUI external editor:** `Ctrl+G` opens the composer draft in
    `$VISUAL`/`$EDITOR` (Windows falls back to the system `notepad.exe` only
    when neither is set; POSIX with neither refuses honestly). The executable
    resolves through `PATH`/`PATHEXT` to an absolute path, a hit inside the
    workspace is refused (binary planting), arguments are tokenized without a
    shell, and Windows `.cmd`/`.bat` shims use an absolute `cmd.exe /d /s /c`
    wrapper. A mode-0600 temp file is spawned asynchronously with inherited
    stdio; a nonzero exit, signal, spawn error or oversized draft leaves the
    draft untouched, and the temp directory is always removed. On success the
    saved text is read back at most 256 KiB, one BOM is stripped, CRLF is
    normalized to LF and one final newline is dropped. `Ctrl+G` is idle-only
    (it refuses during a turn/compaction or while an overlay/find/approval owns
    the keyboard); the terminal driver gains idempotent `suspend()`/`resume()`
    so a failed editor never leaves the screen broken, and default frames stay
    byte-identical when the feature is unused. Files:
    `src/tui/externaleditor.ts` (new), `src/tui/terminal.ts`, `src/tui/app.ts`,
    `src/tui/keymap.ts`; tests `tests/tuiexternaleditor.test.ts` (20), plus
    `tests/tuiintegration.test.ts` and `tests/tuikeymap.test.ts` cases.
  - **Undo lifecycle:** the run-scoped workspace undo store under
    `<sessions>/undo` is now bounded. When a capture closes, the newest 20
    records per session are kept and records older than 30 days are pruned
    (age pruning can be disabled; the count cap still applies), and blobs no
    surviving record references are deleted in the same pass — a deduped blob
    survives while any record needs it, and a corrupt/unreadable record refuses
    the whole blob pass rather than guessing. A prune/GC failure is one bounded
    diagnostic and never breaks a run or an apply; pruning never touches
    workspace files, it only makes an old run stop being undoable. Active runs
    are never pruned. On apply, a restored POSIX file regains the permission
    bits recorded at capture time, and ownership is restored only where the
    process may set it (best effort, disclosed per file; it never turns a byte
    restore into a failed apply). A delete records the live file's mode at the
    mutation seam, so a delete-first run restores bytes and permission bits.
    The CLI gains `sessions undo <name> [--run <id>] [--apply | --discard] [--json]`
    — preview by default against the session's linked workspace, the line-mode
    counterpart of the `GET`/`POST`/`DELETE .../undo/{run_id}` routes — and
    `DELETE` now returns additive `blobs_removed?`/`gc_diagnostics?`. Files:
    `src/workspacehistory.ts`, `src/server.ts`, `src/cli.ts`, `src/clihelp.ts`;
    tests `tests/workspaceundo.test.ts` (42), `tests/serverundo.test.ts` (9),
    `tests/sessionscommands.test.ts` (18) and `tests/cliergonomics.test.ts`
    additions. Record format version stays 1; all new fields are additive.
  - **Web Fork from here…:** an operator message bubble exposes a compact
    `fork` button whose accessible name is **Fork from here…** (the full label
    and reason are announced while disabled). It calls the existing
    `POST /api/sessions/{name}/fork` with that bubble's `{seq}` — so the new
    session is the conversation up to and including that message — and opens
    the new fork; the source JSONL and sidecar stay byte-identical, the fork
    keeps its `parent` lineage link and `<source title> (fork)` title, and the
    action is unavailable while a run is active for the session. Failure
    (404/409/422/other) stays inline in the confirmation with no local state
    change or partial refresh. Files: `web/src/sessionFork.ts`,
    `web/src/components/ChatView.vue`, `web/src/App.vue`; tests
    `web/tests/sessionFork.test.ts` (9).
  - **Session-recovery hardening:** the torn-tail repair is now a full
    compare-and-swap. `SessionStore.scan()` captures `{size, mtimeMs, ino}`
    immediately before reading, and `rewritePrefixAtomically` re-stats and
    compares all three fields immediately before the atomic rename; any
    mismatch (or a missing re-stat/signature) removes the temp file and throws
    a `SessionError` with the additive `retryable: true`, leaving every
    original byte — including a concurrent appender's — intact. The documented
    single-writer assumption is unchanged, and the test-only `beforeRename`
    seam was added. Forking a crash-torn source now mirrors the reader: an
    unterminated final fragment that fails JSON parsing is dropped, so the fork
    copies only the complete-line prefix byte-exactly with dense `seq`;
    newline-terminated corruption, interior corruption and parseable
    non-objects still fail `source-unreadable` (422). Files:
    `src/session.ts`, `src/sessionfork.ts`; tests `tests/session.test.ts` (14),
    `tests/sessionfork.test.ts` (23) and `tests/sessionapi.test.ts` (11).
  - **Doctor MCP configuration check:** `doctor` gains one deterministic,
    read-only `mcp-config` row after the TUI checks. It resolves
    `TWO_BROTHERS_MCP_CONFIG` against the working directory; unset/blank is a
    skip (`TWO_BROTHERS_MCP_CONFIG not set`, not a failure), a missing/unreadable/invalid-JSON/
    wrong-shape file is a `warn` with one bounded reason, and a valid file
    passes with `N servers: …` (names sorted, at most eight listed). It never
    starts a server, never makes a network call and never prints a spec value
    (command, args, URL, env or header value). Files: `src/doctor.ts`,
    `src/clihelp.ts`; tests `tests/doctor.test.ts` (45).
  - **MCP env wiring:** `TWO_BROTHERS_MCP_CONFIG` is now actually honored by
    `run`, `chat`, `tui`, `serve` and `--dry-run` through one helper — a
    non-blank `--mcp-config` wins, a blank flag falls back to the env, and
    blank on both means "not configured". This closes the pre-existing
    docs/CLI drift the doctor check exposed. File: `src/cli.ts`; tests
    `tests/cliergonomics.test.ts` (48).
  - **Per-preset context windows:** provider presets gain the additive
    `context_window?: number` (tokens; a positive safe integer, `0`/absent =
    unknown). Seeds omit it; stored overrides survive unrelated saves and
    corrupt values fail soft; `GET /api/providers` exposes it only when
    positive (old rows stay byte-compatible), and `PUT`/`POST` validate it
    strictly (an explicit `0` clears; absent/null on an update keeps the stored
    value; negative/float/string/boolean/unsafe is a 400). Endpoint resolution carries the window from the role's named preset,
    and compaction adds it as the last fallback after an explicit
    `ServerOptions.compaction`, the run-level `--context-window`/
    `TWO_BROTHERS_CONTEXT_WINDOW` and the persisted
    `compaction.context_window` in `serve` runs (CLI `run`/`chat`/`tui` use
    their configured budgets only): when both roles resolve to a window the
    **smaller** one applies (a summary sized for the larger model must not
    overflow the smaller one), and the settings view reports the honest
    `preset` source. Settings → Providers gains a labelled **Context window
    (tokens)** input (0 = unknown) with the same strict validation and a
    preset-aware explanation. Provider wire requests are unchanged. Files:
    `src/presets.ts`, `src/settings_store.ts`, `src/config.ts`,
    `src/runtime.ts`, `src/server.ts`, `web/src/types.ts`,
    `web/src/providerSettings.ts`, `web/src/api.ts`,
    `web/src/compactionSettings.ts`,
    `web/src/components/settings/ProvidersSection.vue`; tests
    `tests/presets.test.ts`, `tests/settings.test.ts`, `tests/server.test.ts`,
    `tests/serverbase.test.ts` and the web provider/compaction suites.

  Package suite `1 912 tests` (1 906 pass and 6 platform skips on Windows; the
  WSL Linux pass is 1 911 pass with 1 skip); web suite `459/459`; the
  browser-E2E matrix is `21` offline scenario blocks (22 PASS lines — the
  `chat/resume` block reports chat and resume separately) plus the opt-in
  `real` skip (`22 PASS, 0 FAIL, 1 SKIP`). No protocol or session-format
  change (all record/API additions are optional), and no new runtime
  dependency.

- **Wave 25: crash-torn session resume, TUI steering, persisted compaction
  settings, cooperative CLI cancellation and a live tab title:**
  - **Crash-torn session resume:** a session whose final JSONL line was
    half-written when the process died no longer fails as a whole. A read
    ignores only that torn trailing fragment in memory; `--resume` repairs the
    file atomically (temp file + rename) before the first append — truncating
    to the last complete line, or adding the one missing newline after a valid
    final envelope — so the next envelope continues the dense `seq` with no
    duplicate and no lost record. Non-trailing corruption is still a typed
    `SessionError`, and destructive rewind stays strict; read-only listing,
    search and export never rewrite the file, and the search document carries
    additive `recovered`/`dropped_bytes`. CLI/TUI resume prints one bounded
    warning (`recovered session …: dropped a torn final line N (B bytes) and
    truncated to the last complete envelope`). Files: `src/session.ts`,
    `src/sessionsearch.ts`, `src/server.ts`; tests `tests/session.test.ts`
    (12), `tests/sessionsearch.test.ts` (36) and `tests/sessionapi.test.ts`
    (10).
  - **TUI steering:** while a turn runs, `Ctrl+N` queues the composer text for
    that turn and applies it at the run's next step — it never starts or
    queues a task. The queue uses the runtime's bounds: at most 8 pending
    texts of at most 4 000 characters each (trimmed; a blank/oversized text
    and a full queue are refused with an honest notice, never silently
    truncated), the draft clears only on acceptance, and the notices
    distinguish a queued steer (with the pending count) from still-pending
    leftovers after the turn ends (an applied steer appears in the transcript). `Enter` while a turn runs keeps its
    refusal and names `Ctrl+N`. The action is a registry command, so `Ctrl+P`,
    `?` and `tui --help` list it; a terminal that keeps `Ctrl+S` for XOFF can
    use the palette instead. Files: `src/tui/steering.ts` (new),
    `src/tui/app.ts`, `src/tui/keymap.ts`; tests
    `tests/tuisteering.test.ts` (8), a `tests/tuikeymap.test.ts` case and the
    assembled-app case in `tests/tuiintegration.test.ts`.
  - **Persisted compaction settings:** the top-level `compaction` section of
    `sessions/settings.json` now carries `threshold_chars`,
    `threshold_tokens`, `keep_recent_chars` and `context_window`; `GET
    /api/settings` returns it additively as per-field `{persisted, effective,
    source}` plus `force`/`pinned`, and `PUT` accepts it (0 = off for a
    threshold, 0 = unknown for the context window; strict integer validation,
    400 before any mutation, 500 on a failed atomic write). Precedence is an
    explicit `ServerOptions.compaction` > an explicitly-set non-zero CLI/env
    field (`Config.compactionExplicit` provenance, so the 40 000 keep-recent
    default never shadows a saved value) > the persisted section > absent.
    The web Settings → Advanced **Auto-compaction** card edits the same
    values and shows a pinned field honestly; an older backend renders an
    unsupported state and sends nothing. Files: `src/settings_store.ts`,
    `src/server.ts`, `src/config.ts`, `src/index.ts`,
    `web/src/compactionSettings.ts` (new), the Advanced card,
    `web/src/api.ts`, `web/src/types.ts`; tests `tests/settings.test.ts` (42),
    `tests/serverbase.test.ts` (15) and
    `web/tests/compactionSettings.test.ts` (12).
  - **Cooperative CLI cancellation:** `SIGINT`/`SIGTERM` during a `run`/`chat`
    turn abort the in-flight provider call and shell process tree, wait a
    bounded cleanup budget (`TURN_CANCEL_BUDGET_MS = SHELL_DRAIN_BUDGET_MS +
    1 000`), then exit; a second signal force-exits. `SIGINT` exits `130`,
    `SIGTERM` `143`, and on POSIX `SIGHUP` follows the same path and exits
    `129`; `serve` joins its graceful shutdown on `SIGHUP` as well as
    `SIGINT`/`SIGTERM`. An idle `chat` REPL keeps its prior Ctrl+C behavior.
    Notices stay on stderr, so `--json`/`--json-events`/`--stream`/`--mode
    print` stdout remains clean. Files: `src/turnsignal.ts` (new),
    `src/cli.ts`, `src/shell.ts`; tests `tests/cliwiring.test.ts` (+8) and
    `tests/serveshutdown.test.ts`.
  - **Web tab title:** `document.title` mirrors the selected session and its
    run state — `▶ <session> — Two Brothers` while running/queued,
    `! <session> — Two Brothers` while waiting on an approval,
    `<session> (failed) — Two Brothers` for a failed run, `(N) Two Brothers`
    when finished runs are unread and no session is selected, and plain
    `Two Brothers` otherwise. The title is sanitized (control/bidi characters
    stripped, whitespace collapsed) and capped at 120 characters; the selected
    session's unread state is never double-counted and the product name is
    restored on unmount. Files: `web/src/tabTitle.ts` (new),
    `web/src/App.vue`; tests `web/tests/tabTitle.test.ts` (16).

  Package suite **1 811 tests (1 809 pass, 2 environment skips)**; web suite
  **451/451**; the
  browser-E2E matrix is **20 offline scenarios plus the opt-in `real` skip**.
  No protocol/session-format change; no new runtime dependency.

- **Wave 24: serve compaction parity, doctor TUI checks, cache-aware cost
  accounting, web transcript paging and run cost, TUI session picker, CLI
  work-mode warning, and bounded shell output with reliable process-tree kill:**
  - **Serve compaction configuration parity:** `createServer` resolves
    compaction settings from config (`compactionSettingsFromConfig`) when
    `ServerOptions.compaction` is not supplied, so `serve` runs honor the same
    `compact`, `compactThreshold`, `compactKeepRecent`,
    `compactThresholdTokens` and `contextWindow` settings as CLI runs.
  - **Doctor TUI-file checks:** `doctor` adds `tui-keys` and `tui-history`
    checks in deterministic order (with injectable `env`/`home`). `tui-keys`
    reports the effective path (`TWO_BROTHERS_TUI_KEYS_FILE` or
    `~/.two-brothers/tui-keys.json`); `tui-history` reports
    `TWO_BROTHERS_TUI_HISTORY_FILE` or `~/.two-brothers/tui-history.json`, and a
    missing history file passes because the TUI creates it on the first
    submit. API keys are never rendered.
  - **Cache-aware cost and cache-write accounting:** `estimateCost` treats
    prompt-cache writes separately from cache reads (`cache_write_tokens`;
    Anthropic `cache_creation_input_tokens` maps to `cache_write_tokens`;
    OpenAI-compatible and Gemini report zero). Cache reads price at
    `cachedInputPer1M` (falling back to the full input rate) and cache writes
    at `cacheWritePer1M` (falling back to the full input rate). An unknown
    model returns `null`, so the UI omits the estimate instead of showing a
    made-up value.
  - **Web transcript paging and run-cost estimate:** the conversation view
    windows large transcripts (`TRANSCRIPT_PAGE_SIZE` 200,
    `TRANSCRIPT_CHUNK_SIZE` 100) and prepends earlier messages with **Show
    earlier**; in-transcript find searches only the messages currently loaded
    (messages inside a collapsed group are searched once the group is
    expanded). The usage footer can show a run-cost estimate
    (`~$X.XXXX est.`) only for a finite, non-negative USD total with a
    non-empty model; a `null`, absent or malformed cost omits the segment.
  - **TUI session picker:** the `/sessions` resume picker shows a readable
    title instead of the raw file stem — the metadata sidecar title, else the
    first operator message read from a bounded JSONL prefix (64 KiB, 20
    events), else the stem — plus a short age (`2h ago`) with `(unknown time)`
    when the stat failed. The raw file name stays searchable.
  - **CLI work-mode no-tools warning:** `run`/`chat` in `work` mode with no
    tools bound prints one `[warn]` line to stderr before the run starts
    (stdout and exit codes unchanged). The warning states that CLI runs are
    not workspace-bound, so the junior cannot read, edit or run commands and
    deliverables cannot be verified.
  - **Bounded shell output and reliable process-tree kill:** `run_shell`
    captures output as a bounded head+tail stream (UTF-8 safe across chunks)
    with O(cap) memory and reports truncation with a marker. On Windows,
    timeout or cancellation kills the full process tree via the absolute
    `%SystemRoot%\System32\taskkill.exe` with a bounded wait
    (`TASKKILL_TIMEOUT_MS` 5000 ms) and a `child.kill()` fallback, so detached
    descendants do not outlive the run.
  - **TUI shutdown waits for shell cleanup; plugin shells are cancellable:**
    quitting or cancelling a TUI turn now waits for the turn to unwind
    `run_shell`'s kill/drain, bounded by the shared `SHELL_DRAIN_BUDGET_MS`
    (7 s) plus a small margin, with a live `stopping…` status; the terminal is
    still restored when the budget expires, so exit never hangs and a turn-free
    exit stays immediate. Plugin tool handlers now receive the run's
    `AbortSignal`, and `ctx.workspace_shell(command, timeout?, signal?)`
    forwards it to the existing cancellable shell path (one-argument handlers
    keep working). Windows-verified abort/drain propagation only; a detached
    POSIX process group still needs POSIX hardware validation.
  - **Browser coverage for the cooperation surfaces:** one hermetic
    `cooperation-surfaces` scenario joins the browser matrix. It previews and
    applies the run-scoped file undo (the run-created marker is gone), forks a
    two-turn session while the source JSONL stays byte-identical, rewinds the
    fork's second turn (UI and file), and exercises both a rejected steer
    (draft kept, honest error) and an accepted steer (draft cleared, queued
    copy). The scripted fixture gained a marker-writing run and a slow steering
    run; the scenario opens the row menu through the keyboard path because the
    full-width select button wins the pointer hit-test in headless Edge.

  Package suite **1 776 tests (1 774 pass, 2 environment skips)**; web suite
  **423/423**; the browser matrix is now **20 offline scenarios** (20 PASS +
  the opt-in `real` skip). No protocol/session-format change; no new runtime
  dependency.

- **Mid-run operator steering (wave 23):** the operator can steer a
  cooperation cycle that is already working instead of only queueing the next
  task. A steer is protocol-compatible by construction: it is appended to the
  shared context as an ordinary `message` envelope from `user` to `senior`
  (payload `{text}`, dense `seq`, session JSONL included) whose payload text
  starts with the documented marker `[[OPERATOR STEER]] `, so the model can
  tell it from the task and no protocol kind, field or session record changes.
  `HarnessOptions.steering` is a return-and-clear drain callback read once per
  state-machine node boundary (after `maybeCompact`, so a summary produced by
  that boundary cannot fold the steer away) and once per tool-loop iteration;
  in a tool loop the opening system+user pair is re-rendered from the shared
  context so the next request carries the steer inside the canonical
  transcript (never a second consecutive user turn, which Anthropic/Google
  reject; hermetic wire tests cover both). The runtime keeps a bounded
  in-memory pending queue per run (8 texts of at most 4 000 characters, each
  trimmed) and applies at most 16 steer envelopes per run; reaching that
  run-lifetime cap emits one additive `steering_dropped` runtime event
  (`{dropped, applied, limit}`) and the run record aggregates it as
  `steering_dropped`, so a text accepted with a `200` is never dropped
  silently (the record also reports `steering_pending`). A throwing/malformed
  drain callback is fail-soft (one warning, the run continues) and nothing is
  appended after a stop. `POST /api/runs/{run_id}/steer` accepts `{text}` for
  a `running` run or one parked on an approval (`waiting`) and answers
  `200 {run_id, status, pending}`; `400` for an empty/oversized text (or a
  non-string `text`), `404` for an unknown run, and `409` for a queued/terminal
  run (the detail names the real status) or a full pending queue — it never
  fakes an SSE event on acceptance. In the web composer an explicit
  **Steer run** action (and `Alt+Enter`) appears only while the followed run
  is steerable; `Enter`/Send keep queueing byte-identically, the draft clears
  only after a `200`, and the confirmation says "Steer queued — it is applied
  at the run's next step" (naming the pending count when above one). Files:
  `src/harness.ts`, `src/runtime.ts`, `src/server.ts`, `src/runevents.ts`,
  `src/index.ts`, `web/src/steering.ts`, `web/src/api.ts`,
  `web/src/types.ts`, `web/src/App.vue`, `web/src/components/Composer.vue`,
  `web/src/shortcuts.ts`; tests `tests/steering.test.ts` (+20 package) and
  `web/tests/steering.test.ts` (+6 web). No protocol/session-format change, no
  new runtime dependency, `NOTICE` unchanged. Idea from pi's
  `steer`/`followUp` queues (design only; see `docs/attribution.md`).
  Remaining: TUI steering, a browser E2E scenario, real-provider validation.
- **Session fork + self-contained HTML export (wave 23):** a persisted session
  can be branched by copy: `POST /api/sessions/{name}/fork` (body
  `{seq?: integer, name?: string}`) and
  `sessions fork <name> [--at <seq>] [--name <new>]` copy the first N
  envelopes (default: the whole session) byte-for-byte into a NEW session
  file, so the copied prefix keeps its exact envelope bytes and dense `seq`
  numbering and `--resume` keeps working; the source file and sidecar are
  never modified. The new session gets `<source title> (fork)` (bounded) and a
  local-only additive `.meta.json` lineage link `parent: {name, seq}` (never a
  protocol record); without `--name` the smallest free `<source>-fork-<k>` is
  used and an existing session is never overwritten, and a fork deliberately
  does not inherit the source's `workspace_id` or copy the runtime-event
  sidecar (a branch starts with a clean tool/approval trail). Errors are
  typed: 400 invalid seq/name, 404 unknown source, 409 name taken or a live
  run/manual compaction on the session, 422 corrupt source, 500 unwritable
  sessions directory (a partial file is rolled back). The export route and CLI
  gain a third format: `GET /api/sessions/{name}/export?format=html` and
  `sessions export <name> --format html` render ONE self-contained HTML
  document — inlined stylesheet, no scripts/links/external URLs, escaped
  title/metadata and payloads (hostile markup stays literal text, ANSI/C0/C1
  bytes stripped via the display sanitizer), one section per envelope with
  `seq`/`from`/`to`/`kind` labels, an optional timestamp and the payload in a
  `<pre>`. Caps are honest: the same 20 000-character per-payload bound as
  Markdown plus a 2 000 000-character whole-document cap applied at envelope
  boundaries, with a visible `showing N of M envelopes` note when envelopes
  are omitted (JSON stays the complete form); markdown and JSON output stay
  byte-identical, and the download filename helper adds `.html`. Files:
  `src/sessionfork.ts` (new), `src/sessionsearch.ts`
  (`sessionToHtmlString`), `src/metadata.ts` (`deriveForkTitle`,
  `SessionParentLink`), `src/server.ts`, `src/cli.ts`, `src/clihelp.ts`;
  tests `tests/sessionfork.test.ts` (20) plus the HTML export cases in
  `tests/sessionsearch.test.ts` (35). No protocol/session-format change, no new
  runtime dependency, `NOTICE` unchanged (the renderer is hand-rolled; no
  third-party template/library copied). The web session row menu ships
  `Fork session…` and `Export as HTML` (the original is untouched and forking
  is unavailable while a run is active for the session). Remaining: TUI
  surfaces. Idea from pi's branched sessions/export-html
  and kimi's `/fork` UX (design only; see `docs/attribution.md`).
- **Session rewind (wave 23):** `POST /api/sessions/{name}/rewind`
  (`{turns}`, strict integer 1–100) and `sessions rewind <name> --turns <n>`
  drop the last N operator turns — each operator task plus every envelope the
  brothers produced for it — from a persisted session, so a better task can
  be retyped without a growing context or a new session file. The kept prefix
  is written back atomically (`SessionStore.rewrite`, temp file + rename) with
  its dense `seq` intact, so `--resume` keeps working; metadata is untouched.
  Harness-generated context is never counted as a turn (compaction summaries,
  structured-payload repair requests, mid-run operator steers, and
  `<skill-loaded>`/`<file>` attachment blocks), continuation attachment blocks
  immediately in front of the earliest removed task are removed with it, and a
  compaction summary is a hard floor: the cut never crosses it and reports an
  honest clamp (`stopped_at_compaction`, `stops_before`, `reason`; a request
  deeper than the session clamps at session start). A cut that removes nothing
  is a 200 with `rewritten: false` and a `reason`, never a fake error. The
  route refuses a session with a live run or a manual compaction (409, the
  same reservation the compact route uses) and takes a size+mtime+inode CAS
  around the read so a concurrently changed file is a 409 instead of a stale
  rewrite; a corrupt file is 422 before any write. **A successful rewrite also
  clears the session's runtime-event sidecar**
  (`sessions/runtime/<name>.jsonl.events.jsonl`): tool and approval history
  for the removed runs is gone while the kept transcript remains, and the
  response/CLI report `runtime_events_cleared` (a clear failure is disclosed
  as `runtime_events_clear_error` instead of pretending success). Files:
  `src/sessionrewind.ts` (new), `src/server.ts`, `src/cli.ts`,
  `src/clihelp.ts`; tests `tests/sessionrewind.test.ts` (19). No
  protocol/session-format change, no new runtime dependency, `NOTICE`
  unchanged. The web transcript offers **Rewind** on operator messages (a
  destructive confirmation, blocked while a run is active/compacting and at a
  compaction floor). Remaining: a TUI rewind surface. Design from kimi
  conversation undo and opencode session revert (no code copied; see
  `docs/attribution.md`).
- **Run-scoped workspace edit undo (wave 23):** after a workspace-bound
  `serve` run, the operator can revert exactly the files that run mutated
  through the workspace tools
  (`workspace_write_file`/`workspace_edit_file`/`workspace_delete_file`) —
  shell commands, external edits and untracked files are never touched. Each
  such run
  captures the exact pre/post bytes under `<sessions>/undo` (a session side
  artifact, never a protocol envelope or session-JSONL record; content-addressed
  blobs are shared across runs, one entry per file records the net effect), with
  honest bounds (2 MiB per side, 64 entries per run, 8 MiB of new blob bytes per
  run; capture limits, budget skips and duplicate entries become `skipped`
  entries, never silent drops). Capture is fail-soft: a recorder error is one
  diagnostic and the tool call/run still succeeds, the capture closes in the
  run's `finally`, and a capture that cannot start leaves the run unchanged.
  Three restart-resilient routes operate over the live workspace:
  `GET /api/sessions/{name}/undo/{run_id}` previews every recorded file against
  the LIVE workspace (`applicable`, `created`, `deleted`, `changed-since`,
  `skipped`, `missing` plus counts, `workspace_root`, `created_at`),
  `POST` the same path applies the reversible entries — re-classifying each file
  immediately before touching it, so a file changed after the preview is
  refused rather than overwritten — and returns per-file
  `applied`/`refused`/`failed` rows plus counts, and `DELETE` discards the
  record (content-addressed blobs stay for sharing; garbage collection is a
  later phase). Errors are honest: 404 unknown session/record, 409 while a run
  for that id is still active in memory or the record itself is unusable
  (corrupt, oversized, unsupported version, or its recorded workspace is no
  longer registered — the record is matched to a registered workspace by
  canonical path on every request), 422 unexpected store IO. Files:
  `src/workspacehistory.ts` (new), `src/workspace.ts` (the additive
  `WorkspaceOptions.mutationRecorder` capture seam), `src/server.ts`,
  `src/index.ts`, `web/src/runUndo.ts` (new), `web/src/api.ts`,
  `web/src/App.vue`, `web/src/types.ts`,
  `web/src/components/RunUndoDialog.vue` (new); tests
  `tests/workspaceundo.test.ts` (28), `tests/serverundo.test.ts` (8) and
  `web/tests/runUndo.test.ts` (12). The web workspace shows an **Undo file
  changes…** bar for the newest completed run of the selected session (only
  while no run is live and no compaction is in flight; a 404 hides the action
  with one honest notice instead of a dead control), and the dialog lists every
  file's preview status and the applied/refused/failed outcome. No CLI or TUI
  undo surface yet (those runs do not capture), and restored files get default
  filesystem mode/ownership (mode is not captured or restored). Design from
  opencode's content-addressed snapshot + revert model (no code copied; see
  `docs/attribution.md`).
- **Anthropic prompt caching + honest cache accounting (wave 23):** every
  Anthropic Messages request now carries up to three
  `cache_control: {type: "ephemeral"}` breakpoints — the merged system prompt
  (as one text block), the last tool definition, and the last content block of
  the newest conversation turn — so the repeated prefix of a cooperation cycle
  (system + tool schemas + growing transcript) is served from Anthropic's
  5-minute prompt cache on the 2nd..Nth provider call: multi-call runs
  (`run`/`serve`) get lower latency and lower input cost, while a single-call
  run pays the 1.25× cache-write premium on the marked prefix (prompts below
  the model's cache minimum are accepted with the markers ignored). Caching is
  unconditional — there is no new flag, setting or protocol field — and the
  OpenAI-compatible/Google request bodies stay byte-identical
  (`cache_control` never appears there). `cache_read_input_tokens` was already
  mapped to `cached_tokens`; it is now actually populated by real Anthropic
  traffic, so the existing `cache N%` usage/footer segment becomes meaningful
  for Anthropic (cache writes are not counted as hits; an absent report maps
  to 0 — no invented hits). Files: `src/provider.ts` (the breakpoint constant
  and the newest-turn/tool/system placement); tests
  `tests/anthropiccache.test.ts` (new, 9 tests: exact marker placement, plain
  vs tool-loop, marker movement, no empty system block, streaming parity,
  cached-read accounting, OpenAI/Google byte identity), with the intentional
  Anthropic wire change pinned in `tests/adapters.test.ts` and
  `tests/thinkingpassback.test.ts`. No real-model cache-hit evidence recorded
  yet; cache retention (`ttl`), a per-run opt-out and the cost-table
  cached-input discount are follow-ups.
- **TUI keys-file auto-reload, opt-in** (wave 23): `tui --keys-watch` (or the
  pinned `TWO_BROTHERS_TUI_KEYS_WATCH=1` boolean env; both captured at
  startup, never persisted) keeps polling the startup-captured keys file and
  applies valid edits without a restart. The new
  `src/tui/keyoverrides.ts::watchTuiKeysFile` uses `node:fs.watchFile`
  (500 ms stat-poll interval — portable on Windows; notices an editor's
  save-by-rename and the creation of an absent file), debounces/coalesces each
  detected change (200 ms) and reloads through the same validated
  `reloadTuiCommands` path as `/keys reload`, so both surfaces share one
  last-good-table rule and one bounded notice: a valid edit live-swaps the
  active command table (matching, palette/help listings, status hints) and
  posts one bounded info notice naming the new chords; an invalid/unreadable
  file keeps the last good table with one bounded warning per detected change
  (no repeat spam while the file stays unchanged); an absent file keeps the
  current chords with an informational notice, and one created later loads on
  the next detected change. `/keys show` reports the honest watch state
  (`on` / `off` / `unavailable` — an embedded session with no captured source
  reports `unavailable`) next to the effective chords, the captured
  path/origin and the last load state, and never claims overrides that are not
  active. The watcher is stopped and unwatched on every TUI exit path (the
  `finally`, so no leaked timers or polls), and a session without the flag/env
  keeps byte-identical default startup behavior and frames. `src/cli.ts`
  resolves the opt-in (`tuiKeysWatchForCli`) and threads it through
  `TuiAppOptions.keysWatch`; `src/clihelp.ts` catalogues the flag/env so the
  docs↔CLI drift guard stays green. Tests: `tests/tuikeys.test.ts` 29 → 40
  (flag/env catalogue + resolution, watch defaults and honest copy, the full
  6/6 `/keys show` load-state/override matrix, the watch-state line, and
  valid/invalid/absent/stop/debounce/uninstallable watcher cases) and
  `tests/tuiintegration.test.ts` 23 → 25 (assembled-app last-good auto-reload;
  an embedded session reporting `unavailable`), with the wave-22 review's
  post-reload status-hint/footer assertions. Package suite: 1 572 tests
  (1 570 pass, 2 environment skips). No new runtime dependencies; no protocol
  or default-behavior change.
- **Role fill/text token split (web)** (wave 23): the web token layer gains
  three decorative fill companions — `--senior-fill`, `--junior-fill`,
  `--operator-fill` (token inventory 94 → 97) — so the accessible role
  palettes can tune role text for WCAG AA without leaving white initials on a
  light decorative fill. The role text tokens keep their meaning (provider
  role labels and other identity text keep `--senior`/`--junior`/
  `--operator`; the confidence bar deliberately keeps `--junior`), while
  avatars, role dots and `.dot-*` backgrounds paint the fill tokens
  (`web/src/style.css`, `web/src/components/settings/RoleEditor.vue`). Every
  palette block defines the fills with light/dark parity: the default palette's
  fills equal its role tokens, so the default look is byte-identical; the
  accessible contrast/neutral palettes get dedicated fills (the light palettes
  reuse values that already clear the floor, the dark contrast fills are
  `#3b64c9`/`#1a7a66`/`#666e7c` and the dark neutral fills
  `#575e6a`/`#616874`/`#6b727e`) so white initials/glyphs on every fill clear
  WCAG AA 4.5:1 in both schemes. `web/tests/tokens.test.ts` 15 → 16 tests:
  the palette declaration set now covers the three fill companions, their
  light/dark parity and distinctness, the default palette's fill equality with
  the role tokens, and the computed white-on-fill AA floors with the pair and
  ratio in every failure message. The hermetic `appearance-roles` browser
  scenario additionally asserts that the rendered role dots follow the fill
  tokens in light and dark. Web suite 356/356 and `npm run build` green. Files:
  `web/src/tokens.css`, `web/src/style.css`,
  `web/src/components/settings/RoleEditor.vue`, `web/tests/tokens.test.ts`,
  `e2e/run.mjs`.
- **TUI `/keys` command (show + live reload)** (wave 22): the TUI gains a
  built-in, chordless `keys` command (Settings group, `/keys [show|reload]`)
  so the file-configured global chords can be inspected and reloaded without a
  restart. `/keys`/`/keys show` posts bounded info notices with the three
  effective global chords (`palette … · help … · stash …`), the captured
  keys-file path and origin (flag / env / default), the honest load state
  (`loaded`, `loaded; defaults active (no overrides)`, `absent; defaults
  active`, `invalid; defaults active`, plus the `previous chords kept`
  variants) and one bounded last-diagnostic line — it never claims overrides
  that are not active (embedded callers without a captured source see
  `keys file: none …`). `/keys reload` re-reads the same startup-captured
  path/origin (env/flag changes need a restart), validates with the existing
  fail-soft loader and live-swaps the app's active command table so key
  matching, the palette/help listings, status hints and all footer surfaces
  immediately use the new chords; a failed read/parse/validation keeps the
  last good table and posts one bounded
  `keys reload failed: … — keeping the current chords` warning, while an
  absent file keeps the chords with an informational notice and a file absent
  at startup loads on a later reload. CLI now tracks the keys-file origin and
  state and passes `keysSource`/`keysState`/`keysDiagnostics` into
  `TuiAppOptions`; new additive helpers in `src/tui/keyoverrides.ts`
  (`loadTuiKeyCommands`, `reloadTuiCommands`, `describeTuiKeys`,
  `globalKeySummary`). Registry entry appears exactly once in the palette,
  `?` overlay and `tui --help`/`help tui`. Tests: `tests/tuikeys.test.ts` +3
  (registry/discoverability/non-rebindability, status wording/overclaim
  rules, reload success/failure/absence/last-good) and
  `tests/tuiintegration.test.ts` +1 (on-disk edit + `/keys reload`; corrupt
  file keeps the previous table); all 21 `tui*.test.ts` suites stay green and
  no existing listing/byte-stability assertions needed changes.
- **Role-colour palettes (web)** (wave 21): Settings → Appearance gains a
  native **Role colours** radio group — Default (the previous blue/teal/grey
  identity colours), **High contrast** (WCAG-AA-tuned role-text colours in
  light and dark) and **Neutral** (muted labels-only greys) — for the
  Senior/Junior/Operator identity colours, independent of the accent theme
  and persisted per device in the versioned `uiPrefs` blob (old/unknown values
  read as Default). Applied as `data-roles="contrast|neutral"` on the root;
  the token blocks override only `--senior`/`--junior`/`--operator` in the
  light and both dark scheme blocks (the token inventory stays 94). The token
  suite pins the variant sets, light/dark parity and computed WCAG-AA
  role-text floors across the documented surfaces (panel/canvas/hover and
  every accent theme's soft/selected tints; worst ratios ≥4.85 light and
  ≥5.11 dark for the accessible palettes), and a new hermetic
  `appearance-roles` browser scenario covers keyboard-only High contrast,
  light/dark computed role tokens and rendered role dots, reload persistence,
  Neutral and the Default restore. The historic Default palette is unchanged
  and deliberately not AA on every documented surface in either scheme (worst
  in dark — the reason the two accessible palettes exist); role avatar/dot
  fills remain decorative (in the dark accessible palettes the aria-hidden
  initials sit white-on-light while the adjacent labels carry identity) and a
  split fill/text token pair is recorded as an optional follow-up. Files:
  `web/src/tokens.css`, `uiPrefs.ts`, `App.vue`, Settings → Appearance;
  tests `web/tests/tokens.test.ts` (15), `uiPrefs.test.ts` (13), browser
  suite 19 scenarios.
- **TUI key rebinding (global slice)** (wave 19): `tui --keys-file <path>` /
  `TWO_BROTHERS_TUI_KEYS_FILE` (pinned, never persisted; default
  `~/.two-brothers/tui-keys.json`, missing = defaults) reads a versioned JSON
  document (`{"version":1,"bindings":{…}}`) that rebinds only the three
  global chords — command palette (`palette`), shortcut reference (`help`) and
  draft stash (`stash`). A new pure `src/tui/keyoverrides.ts` parses the
  chord grammar (`[ctrl+][shift+][alt+]key`, one named terminal key or one
  printable character), validates against the allowlist and the fixed
  registry (unmodified letters/digits, structural keys, `Ctrl+C/Z/Q/S`,
  duplicates and fixed-chord collisions are refused), bounds the file
  (16 KiB) and resolves a fresh command table; invalid/oversized/wrong-version/
  unreadable/unknown/duplicate/conflicting files print one `[tui keys]`
  diagnostic on stderr and keep the defaults (the TUI still starts).
  `TuiAppOptions.commands` threads the resolved table through matching, the
  palette/help listings and handlers, the status hints, composer/welcome/
  status-bar, find bar, mention picker, approval panel, provider connect,
  history search, side panel, input guard, slash resolution and
  `tui --help`; lane hint builders gained optional `commands` parameters
  (defaults keep the previous behavior byte-identical). `clihelp.ts`
  catalogues the flag/env so the docs↔CLI drift guard stays green. Tests:
  `tests/tuikeys.test.ts` (25) plus two injected-override
  `tests/tuiintegration.test.ts` cases (a rebound palette chord opens while
  the default stops working; the help overlay lists the effective chords).
  Files: `src/tui/keyoverrides.ts` (new), `src/tui/app.ts`,
  `src/tui/view/*`, `src/cli.ts`, `src/clihelp.ts`, `tests/run-all.ts`.
  Remaining surfaces (composer/typing keys, Escape/quit layering,
  picker/overlay navigation, approval keys, an in-TUI editor and hot reload)
  stay fixed by design.
- **Configurable web key bindings (first slice)** (wave 16): the three
  modifier-based global chords — command palette (default Ctrl/⌘+K), find in
  the conversation (default Ctrl/⌘+F) and the shortcut reference (default
  Ctrl/⌘+/, with plain `?` kept as a fixed alias) — are rebindable per device
  through Settings → Keyboard. A pure module (`web/src/keybindings.ts`) owns
  the structured binding model (one platform "Mod": Ctrl outside macOS, ⌘ on
  macOS; matching accepts either so one binding travels), validation (Mod plus
  one printable key; duplicate chords, Alt combos, plain keys and documented
  browser-reserved chords refused with inline conflict copy), a versioned,
  bounded, injectable fail-soft store (`two-brothers.keybindings.v1`,
  JSON-duplicate-aware repair back to defaults), event parsing/matching, and
  platform-aware label rendering. One reactive keybindings ref in `App.vue`
  drives the palette/find/help handlers (existing guards preserved), the header
  palette-chip label, `ChatView`'s find handler, the Settings dialog and the
  `/help` overlay, which now renders the current chords and badges only the
  three rebindable entries while noting that every other shortcut is fixed.
  Settings → Keyboard uses native Change/Reset buttons and a window-capture
  keydown handler (announced via `role=status`; conflicts via `role=alert`;
  Escape cancels a capture without closing the dialog; per-row and global
  reset) with semantic tokens only. Tests: `web/tests/keybindings.test.ts`
  (13) + the hermetic browser scenario `keybindings` (offline suite 17→18).
  Files: `web/src/keybindings.ts`, `web/src/components/settings/KeyboardSection.vue`,
  `web/src/App.vue`, `web/src/components/ChatView.vue`,
  `web/src/components/ShortcutHelpDialog.vue`, `web/src/shortcuts.ts`,
  `e2e/run.mjs`. The remaining key-binding surfaces (composer/picker/fixed
  keys, TUI rebinding) stay open in `docs/backlog.md`.
- **Operator-selectable web accent themes** (wave 13): Settings → Appearance
  gains an accessible native radio group for the web app's accent — Blue
  (default, the previous look) plus Violet, Teal and Amber. Each variant
  overrides only the accent/focus/selected semantic tokens
  (`--accent`, `-hover`, `-pressed`, `-soft`, `--focus-ring`,
  `--border-focus`, `--surface-highlight`, plus the new `--accent-text`) in
  the light and both dark scheme blocks with byte-identical dark variants;
  the light/dark parity and per-variant token-set completeness are
  test-enforced, and role identity colours deliberately stay stable. Accent
  text uses a dedicated `--accent-text` token (94-token inventory): in the
  light scheme it equals the accent (no visual change), while the dark
  schemes and variants use lightened values (blue `#6c9bff`, violet
  `#a78bfa`, teal `#5eead4`, amber `#fbbf24`) that clear WCAG AA 4.5:1 on
  the dark surfaces — computed in the token test, which also pins the
  94-token inventory — while fills, borders and focus rings stay on
  `--accent`. The choice persists in the versioned
  `two-brothers.ui-prefs.v1` blob (additive, unknown values normalize to
  Blue) and is applied immediately as `data-accent` on the root; a hermetic
  browser scenario covers keyboard-only selection, the computed `--accent`
  and `--accent-text` in light and dark (including its dark contrast),
  reload persistence and restoring Blue. Files: `web/src/tokens.css`,
  `uiPrefs.ts`, `App.vue`, `SettingsDialog.vue`, Appearance section and the
  12 sheets whose accent text moved to `--accent-text`; tests
  `web/tests/tokens.test.ts` (12), `uiPrefs.test.ts` (9), browser suite
  17 scenarios. Native naive-ui primary controls originally kept the brand
  blue in this slice; wave 14 threads the accent into naive-ui's primary
  theme overrides (see the wave-14 Changed entry).
- **Opt-in serve-level load/soak runner** (wave 12): new
  `packages/harness/e2e/serve-load.ts` (`npm run test:e2e:serve-load`) starts
  the real `serve` backend (hermetic `--mock` self-test or real
  `--base-url`/`--model` with env fallbacks; requires a build, warns before
  falling back to sources), registers a temp workspace, creates one session
  per run (same-session runs serialize by protocol, so `--workers > 1` only
  parallelizes across sessions), submits bounded-concurrency runs through
  `POST /api/runs`, polls `GET /api/runs` and cross-checks the persisted
  runtime sidecars for authoritative `queued → running → completed`
  transitions. It prints per-run PASS/FAIL with queue/run/submit timings and
  an honest summary (observed max in-flight POSTs, peak queued/running,
  persisted-sequence count, terminal states, latency min/median/max, total
  wall), exits 0/1/2, stops the server child on SIGINT/SIGTERM and normal
  exit, removes temp dirs unless `--keep`, forwards the opt-in
  `TWO_BROTHERS_E2E_API_KEY` to the serve child as `TWO_BROTHERS_API_KEY` for
  authenticated endpoints (ambient switches are scrubbed), and is deliberately
  never wired into `npm test`, the smoke gate or CI. Recorded evidence (2026-11-08):
  mock `--runs 3 --workers 1` → 3/3 completed (0.3–2.8 s depending on
  machine load; the persisted sidecar sequence is the queueing evidence, not
  submit latency); owner LM Studio `lfm3-1.7b`, `--runs 2 --workers 1` → 2/2
  completed in 230.8 s (run 2 queued 117.7 s behind run 1). Long soaks remain
  an operator choice; WAN/real-provider fault injection stays manual.
- **Opt-in real-network load runner** (wave 11): new
  `packages/harness/e2e/load.ts` (`npm run test:e2e:load`) drives a bounded
  concurrency pool of real `dist/cli.js run` subprocesses against an
  operator-provided OpenAI-compatible endpoint (`--base-url`/`--model` with
  env fallbacks, `--concurrency` ≤16, `--runs` ≤100, `--mode`, `--timeout`,
  `--retries`, `--task`), printing per-run PASS/FAIL with wall times and an
  honest summary (observed max concurrency, successes/failures + exit codes,
  measured latency min/median/max, total wall). Exit 0/1/2, kills children on
  SIGINT/SIGTERM, sweeps stragglers, prefers the built CLI (warns and falls
  back to sources), and is deliberately never part of `npm test`, the smoke
  gate or CI. Recorded against the owner's LM Studio `lfm3-1.7b` (2026-11-08,
  concurrency 2 / runs 3): 3/3 PASS, 78.7–93.7 s per run, 157.6 s wall. The
  hermetic fault counterpart is `e2e/faults.ts`; a `serve` RunManager soak
  remains manual-only.
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

### Fixed

- **`help tui` keys parity** (wave 20): `two-brothers help tui` now resolves
  the effective TUI key commands from `TWO_BROTHERS_TUI_KEYS_FILE` or the
  default `~/.two-brothers/tui-keys.json` like `tui --help` does (the `help`
  command has no `--keys-file` flag; a one-line note points at
  `tui --help --keys-file <path>` for a flag-selected file), so an invalid
  file prints the same one-line `[tui keys]` diagnostic and falls back to the
  defaults while `tui --help` behavior is unchanged. A printable rebound help
  chord now has integration coverage: it opens the help overlay on an empty
  composer and types into a non-empty draft instead. Tests:
  `tests/tuikeys.test.ts` (+2) and `tests/tuiintegration.test.ts` (+1).

### Changed

- **Test-enforced WCAG AA floors for accent text and native primary states**
  (wave 15): value-only accessibility hardening that closes the two remaining
  contrast gaps. Accent-coloured text now clears 4.5:1 on every surface it is
  actually used on in both schemes (panel/canvas, hovered and selected rows,
  soft accent chips): the light soft/selected tints were lightened
  imperceptibly (base `--accent-soft` #e8eefb→#ecf2fd, amber soft
  #fdf1dc→#fdf3e2, base `--surface-highlight` #eaf0fc→#edf2fd; blue 4.42→4.58,
  amber 4.49→4.57, highlight 4.497→4.59) while violet/teal and the light hover
  surfaces already passed. White text on native naive-ui
  `primaryColor`/`primaryColorHover`/`primaryColorPressed` now clears AA for
  all four accents in both schemes: the dark accent hover *deepens* instead of
  lightening for blue/violet/teal (blue #4f7fe8→#2b5fd9, white 3.80→5.61;
  violet #8b5cf6→#7433e0, 4.23→6.38; teal #0e8aa8→#0e7692, 4.02→5.22; amber
  keeps its lighter hover and already passed) with the CSS `--accent-hover`
  tokens and `ACCENT_NAIVE_PALETTES`/base dark overrides changed in tandem so
  the drift test stays green; hover/pressed remain visibly distinct from
  primary (naive uses them for switch rails and input focus borders). The
  token suite (13→14 tests) computes the floors, documents the surfaces that
  host accent text (deliberately excluding the currently-unused
  `--surface-active`), and fails with the exact pair and ratio; the 94-token
  inventory, variant parity and existing AA floors are unchanged.
- **Native naive-ui controls follow the accent; per-command docs guard**
  (wave 14): `web/src/theme.ts` gains the pure
  `accentThemeOverrides(accent, scheme)` mapping and the canonical
  `ACCENT_NAIVE_PALETTES` table (blue/violet/teal/amber × light/dark), mapping
  naive-ui's primary family (`primaryColor`, hover, pressed, suppl) to the same
  hexes as the CSS `--accent*` tokens; `App.vue` merges it into
  `NConfigProvider` reactively, so native primary controls (buttons, switches,
  input focus borders) follow the operator accent in light and dark and update
  immediately on an accent or theme switch without a reload. A new drift test
  parses `tokens.css` and fails if the JS mapping and CSS tokens diverge
  (tokens suite 12 → 13; foreign hexes rejected), and the `appearance-accent`
  browser scenario now polls the native Settings primary button's computed
  background through Blue → Violet (light) → Violet (dark) → Blue (±2/channel,
  transition-aware). Non-primary intents (error/success/warning) deliberately
  stay static. In the package, `tests/clidocs.test.ts` grew from 6 to 8 tests
  with a **per-command flag audit**: a `Flag` table under a command heading may
  document only flags that command accepts, every run/chat/tui/serve accepted
  flag must be documented in its table or the shared `## Flags` table, and
  failures name the command and both directions; the parser is fence-aware and
  the header documents what is intentionally outside the audit.
- **Two-platform CI and a docs↔CLI drift guard** (wave 13):
  `.github/workflows/ci.yml` now runs the hermetic gates on two platforms — the
  existing ubuntu matrix (Node 22/24) plus a `windows-latest` Node 24 leg
  (this project's development platform) that prepends Git Bash to `PATH` for
  the shell-spawning suites, runs the same reference/package/CLI-E2E/fault/
  web/freshness gates, and deliberately skips the Node-22-only release
  rehearsal to stay bounded. Locally validated step-by-step on Windows
  (15/15 commands green). New `tests/clidocs.test.ts` (6 tests, part of
  `npm test`) keeps `docs/cli-reference.md` in sync with the code-owned CLI
  catalogue: two-way env-var coverage against `clihelp.ts::ENVIRONMENT`,
  env→flag mapping, two-way long-flag coverage for the
  run/chat/tui/serve accepted flags, and a tolerant command-heading check,
  with sorted set-diff failures and a skip when the reference file is absent.
- **CI runs the new hermetic gates; Anthropic thinking coverage extended**
  (wave 11): `.github/workflows/ci.yml` now also executes the real-socket
  fault-injection runner (`node e2e/faults.ts`) and the packaged-web
  freshness unit tests (`node --test e2e/web-freshness.test.mjs`) on both
  Node 22/24 matrix legs; browser E2E and live/real-network layers remain
  deliberately opt-in/manual. `tests/thinkingpassback.test.ts` grew from 13
  to 17 tests: a streamed `redacted_thinking` block is asserted to be echoed
  verbatim (opaque payload unchanged) as the first content block of the next
  tool-loop request, and mixed per-role wire kinds prove the run-level
  budget reaches both role providers while only the Anthropic role's body
  carries the `thinking` field (the other role's raw request bytes stay
  identical).
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
