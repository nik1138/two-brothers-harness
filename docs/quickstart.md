# Quickstart

Get "Two Brothers" running in a couple of minutes.

The implementation is the **TypeScript package** —
`packages/harness/` (`@two-brothers/harness`), in the style of pi /
deepseek-harness. Everything below runs against it; the zero-dependency
`typescript/` tree is the protocol reference (nothing to install there).

## 1. Requirements

| Component | Version | Check |
|---|---|---|
| Node.js | ≥ 22.19 | `node --version` |

Build the package from a checkout:

```powershell
cd two-brothers-harness\packages\harness
npm install
npm run build                          # tsc → dist/
```

Or install the published package (v0.0.1 is the latest release):

```powershell
npm install -g @two-brothers/harness
two-brothers --version
```

## 2. First run (offline, no API key)

```powershell
cd two-brothers-harness\packages\harness
node dist/cli.js run "Plan a migration from Redis to Valkey" --provider mock
```

With the global install the same run is
`two-brothers run "Plan a migration from Redis to Valkey" --provider mock`.

The output is the full conversation: `[user]`, `[senior -> junior] consult`, `[junior -> senior] proposal`,
`[senior -> junior] review`, `[senior -> user] decision`. Each envelope is its own
block separated by a blank line, model prose renders as width-safe Markdown, and
the final decision is ruled off with `── decision ──…`. When the run reports
usage, the transcript ends with a compact footer —
`tokens 40 in / 20 out · cache 25% · 4 calls · cost $0.0300` — whose segments
appear only when they are known.

On a real terminal the transcript streams live: each block appears as the run
produces it, with dim `· …` activity rows between blocks (`· senior consulting…`,
`· junior tool workspace_read_file…`) while the models and tools work. The
decision rule and the footer still print exactly once, at the end. In a pipe —
or with `--no-live` — you get the same transcript printed once when the run
finishes; `--live` cannot force a pipe to stream. Piped output stays plain and
`--json`, `--json-events`, `--stream` and `--mode print` are machine modes with
unchanged bytes (see
[Human text output](cli-reference.md#human-text-output-ts-package)).

## 3. Delegation mode

```powershell
node dist/cli.js run "Write hello world" --provider mock --mode work
```

The junior takes on part of the work: `delegation` → `deliverable` → `review` → `decision`.

Workspace-bound runs (`tui --workspace <dir>` and `serve` runs linked to a
workspace) also load root-level `AGENTS.md` and `CLAUDE.md` into both roles'
system prompts. Only regular files directly under the workspace root are read;
content is de-duplicated and capped at 16 Ki characters per file / 32 Ki
characters in total, with an explicit truncation marker; a candidate larger
than 1 MiB is skipped entirely. The text is untrusted
project guidance — it never overrides the system/operator instructions or
grants permissions. Set `TWO_BROTHERS_PROJECT_INSTRUCTIONS=off` to disable it.
See [Workspace instructions](cli-reference.md#workspace-instructions-ts-package).

## 4. A real model

```powershell
$env:TWO_BROTHERS_PROVIDER = "openai"
$env:TWO_BROTHERS_BASE_URL  = "https://api.deepseek.com/v1"
$env:TWO_BROTHERS_API_KEY   = "sk-..."
$env:TWO_BROTHERS_SENIOR_MODEL = "deepseek-chat"
$env:TWO_BROTHERS_JUNIOR_MODEL = "deepseek-chat"

cd two-brothers-harness\packages\harness
node dist/cli.js run "Your task"
```

Any OpenAI-compatible endpoint works: DeepSeek, OpenAI, OpenRouter, vLLM,
Ollama, OpenCode Zen — and Anthropic / Google Gemini through their adapters
(`--provider-kind anthropic|google`). `node dist/cli.js onboard` writes the
per-role settings interactively if you prefer not to set environment
variables. The TUI reads those same persisted settings, and `/provider`
connects or changes a provider from inside the terminal workspace (see
[Connecting a provider from the TUI](#connecting-a-provider-from-the-tui)).
Environment variables win over saved settings while they are set
and are never written to the settings file (see the
[CLI reference](cli-reference.md#environment-variables)). An explicit
`--provider` (even one that repeats the default value) or
`TWO_BROTHERS_PROVIDER` also overrides a persisted non-default provider; with
neither set, the persisted role providers stay in effect (see
[Provider connection](cli-reference.md#provider-connection-provider)).

> **Local models (LM Studio, CPU):** small models on CPU can take 2–7+
> minutes per provider call. The default `--timeout` (120 s) bounds *each
> attempt*, and every retry restarts generation from scratch — so a slow
> local model can fail all attempts even with retries left. Raise the
> timeout instead of the retry count:
>
> ```powershell
> node dist/cli.js run "Your task" --timeout 900   # or higher on slower machines
> # or serve/web runs:
> $env:TWO_BROTHERS_TIMEOUT = "900"
> node dist/cli.js serve --port 8600 --sessions-dir sessions
> ```

## 5. Persist and resume a session

```powershell
# create a session
node dist/cli.js run "Plan a migration from Redis to Valkey" --provider mock --session-file session.jsonl

# resume it later
node dist/cli.js run "Now plan the rollback" --provider mock --session-file session.jsonl --resume
```

Every protocol envelope is appended to the JSONL file and flushed immediately, so a
crashed run loses at most the final, partially written line. `--resume` drops that torn
trailing fragment with one bounded warning, repairs the file atomically, rebuilds the
shared context, and continues dense `seq` numbering; interior corruption still fails
with a line-numbered error, and read-only listing/search never rewrite the file. An
existing file without `--resume` is an error — use `--resume` or delete the file. See
the [CLI reference](cli-reference.md) for details.

## 6. Diagnose problems

Run `doctor` before changing configuration. It checks the Node engine, settings
file, sessions directory, role configuration, provider endpoint, web assets and
plugins, and prints one `[pass]`/`[warn]`/`[fail]`/`[skip]` line per check.
Exit `0` means no check failed, `1` means a failed check, and `2` is a usage
error; warnings never fail.

```powershell
node dist/cli.js doctor --provider mock   # offline: no provider endpoint is contacted
node dist/cli.js doctor                    # the configured provider, models and endpoint
node dist/cli.js doctor --json             # one {ok, checks} object
```

It never prints API keys — role details only say `key set` or `key not set`. For
a failing check, see [Troubleshooting](troubleshooting.md).

## 7. Command help, sessions and completion

`--help` works after every command. `help` prints the overview, `help <command>`
one command's flags and examples, and `help --all` the full reference; a
near-miss command or option gets a did-you-mean line, and usage errors exit 2.
On a real terminal the generated help tables scale their command and flag
columns to the terminal width; piped output keeps the historical 96-column
layout.

`sessions` lists the JSONL files under `--sessions-dir`; `sessions show <name>`
prints one session's summary and envelopes; `sessions search <query>`
full-text searches every session (title and envelope text); and
`sessions export <name> [--format markdown|json|html]` renders one session as
Markdown (default), JSON or a single self-contained HTML page (inline CSS,
escaped payloads, no scripts or external URLs). `sessions fork <name>
[--at <seq>] [--name <new>]` copies the session — or its first `--at`
envelopes — into a new session file and prints the new name (the source is
never modified; the copy keeps dense `seq` and gets a local parent link).
`sessions rewind <name> --turns <n>` drops the last `n` operator turns from
one session (the transcript is rewritten in place; the kept prefix and its
dense `seq` survive, while the removed runs' tool/approval history sidecar is
cleared). All accept `--json`, and the `--limit N` flag caps rows, envelopes
or hits.

```powershell
node dist/cli.js help sessions
node dist/cli.js sessions --sessions-dir sessions --json
node dist/cli.js sessions show <name> --sessions-dir sessions --limit 20
node dist/cli.js sessions search "migration" --sessions-dir sessions
node dist/cli.js sessions export <name> --format markdown --output session.md
node dist/cli.js sessions export <name> --format html --output session.html
node dist/cli.js sessions fork <name> --at 4 --name branch-a
node dist/cli.js sessions rewind <name> --turns 1
```

Completion scripts are generated from the same catalog; for an installed
`two-brothers` command (or `npm link`), add one line to your shell profile:

| Shell | Add to profile |
|---|---|
| bash | `source <(two-brothers completions bash)` |
| zsh | `eval "$(two-brothers completions zsh)"` after `compinit` |
| fish | `two-brothers completions fish \| source` |
| PowerShell 7+ | `two-brothers completions powershell \| Out-String \| Invoke-Expression` |

## The web workspace

The browser app is a **local, single-user coding workspace**. The only
conversation view is a three-party group chat — you (labelled **You**), the
Senior, and the Junior:

```powershell
# server: HTTP API + the built web app
cd two-brothers-harness\packages\harness
npm install && npm run build
node dist/cli.js serve --port 8600 --sessions-dir sessions

# frontend development: cd web && npm install && npm run dev
# (Vite proxies /api to :8600; `npm run build` → web/dist is served by the server)
```

Then open `http://127.0.0.1:8600`:

With no session selected you land on a welcome hero: the workspace context
chip, the actions (New session, Add a workspace, Set up models when the roles
are not usable yet, Keyboard shortcuts) and three starter suggestions. A
starter only prefills the editable task box — it is never sent for you — and
the same hero appears inside a selected session that has no transcript yet.

1. **Register a workspace** with the workspace finder (a directory you pick —
   it is never scanned) and create a session linked to it. Sessions are
   grouped by workspace in the sidebar; each workspace group's `⋯` menu
   renames it or moves it up/down, and the order is persisted. You can also
   drag a group by its grip handle and drop it before/after another workspace
   (pointer only, with an accent-line insert indicator; the `⋯` menu stays the
   keyboard path).
2. **Set the models** — the Settings dialog opens from the bottom-left of the
   sidebar; per-role Senior/Junior provider, model, base URL, and API key
   (keys are never echoed back; the server seals them at rest). Runs use the
   configured models; there is no separate "mock" switch in the UI. Settings →
   **Providers** lists the provider presets by name and opens the selected
   provider's settings right below it (base URL, masked API key, model ids,
   advanced wire kind, add/delete). A customized built-in seed also shows
   **Reset to default**: the confirmation warns that the customized values and
   the stored override API key are discarded while the Senior/Junior role
   assignments stay unchanged, and the provider itself is not deleted. Against
   a backend without the reset route, the client shows an unsupported message
   and changes nothing. The open provider card's **Refresh models** button is a
   separate, explicit probe: it asks the endpoint named by the current draft
   (Base URL and wire kind, plus the API key typed in the form for this one
   request) which models it reports and lists them without saving anything.
   Adding them is deliberate too — **Add N to draft**, then **Save changes**;
   an empty answer ("reported no models") is valid and never erases the saved
   model list. Only OpenAI-compatible endpoints expose a `/models` listing, so
   the control answers honestly (unsupported) for Anthropic/Gemini, and a
   saved/env-backed key is only used when the probed URL is the preset's own
   endpoint — otherwise type the key for that probe. The offline equivalent is
   `node dist/cli.js models --base-url <url>`. Settings → **Appearance** sets
   the theme and the Comfortable/Compact density for this device, and picks
   the accent theme (Blue default, or Violet/Teal/Amber) — the accent applies
   immediately and is remembered for the next visit. The same panel's **Role
   colours** chooser picks Default (blue/teal/grey), High contrast (WCAG-AA
   tuned in light and dark) or Neutral (muted labels-only) for the
   Senior/Junior/Operator identity colours. Settings → **Keyboard**
   rebinds the palette, find and shortcut-reference chords on this device
   (Ctrl and ⌘ count as the same modifier; every other shortcut stays fixed).
3. **Send a task** in `work` mode. The run uses the session's linked
   workspace (even when the sidebar filter is **All**), so the brothers get
   its confined file tools and `@` file attachments resolve there; an explicit
   workspace override on the API still wins. The run proceeds in the
   background; the chat updates live over SSE — a folded **Thinking** row
   (reasoning) and the **Response** block stream in as the models generate,
   then resolve into the normal conversation bubbles. The Thinking row starts
   folded — click it to read the reasoning; the reply never pops it open. Runs that stream reasoning
   also persist a bounded record, so after a reload the same folded
   **Thinking · replayed** row comes back for each provider call (older
   backends and non-streaming runs simply show none). Submitting while the
   brothers work is allowed: the send control reads **Queue**, the task joins
   the server's per-session FIFO and a queue dock above the composer lists the
   waiting tasks with their `#N` position, a snippet, the queued-at time and a
   per-row **Stop** (a queued task is cancelled immediately; the dock shows up
   to five rows plus a `+N more` tail). That queue is not steering: a queued
   task starts only after the current run finishes, in order, and the next one
   is followed automatically. Steering is the explicit neighbour of the queue —
   while the run is working (or parked on an approval) the composer shows
   **Steer run** (also `Alt+Enter`), which sends the draft to the **current**
   run and applies it at its next step: it never starts or queues a task, the
   draft clears only when the server accepts the steer, the confirmation says
   "Steer queued — it is applied at the run's next step", and the steer appears
   in the transcript (a `You` message marked as an operator steer) once the run
   reaches that step. Stop the active run, or reload the page (progress is
   recovered from the runtime sidecar), at any time.
   In the composer, `@` opens a picker over shared skills and workspace files
   and `/` at the start of a line opens the command menu — built-in commands
   first (`plan`, `goal`, `feedback`, then the actions `compact`, `export`,
   `permission`, `status`, `mode`, `new`, `help`), then your own discovered
   `<name>.md` templates (a template shadows a built-in of the same name).
   Selecting an item inserts `@skill:name`, `@relative/path` or `/name` into
   the task; the server attaches the mentioned skill bodies/files to the
   shared context and expands prompt templates before the run starts. Action
   commands run locally — `/compact` summarizes older context through the
   configured models, `/export` downloads the session as Markdown, `/help`
   (also `?` or `Ctrl+/`) opens the commands-and-shortcuts overlay.
   **Up/Down recall:** `Up` on a single-line draft (or at the very start of a
   multiline one) brings back your previous submitted task, `Down` steps
   forward, and the final `Down` restores the draft you were writing exactly.
   Only accepted submissions are remembered (a bounded local history, newest
   first); recall is skipped while a mention/command picker is open, and
   modified arrow presses or a selection keep their normal editing behavior.
   Per-model-call prompt annotations are developer information and stay out
   of the conversation by default; Settings → **Advanced** has the
   `Show prompt audits in the conversation` toggle when you need them.
   Settings → **Advanced** also carries the **Auto-compaction** card: Threshold
   (chars), Threshold (tokens), Keep recent (chars) and Context window (tokens)
   — the same numbers as `--compact-threshold`,
   `--compact-threshold-tokens`, `--compact-keep-recent` and
   `--context-window`. `0` means off for a threshold and unknown for the
   context window. The card saves the persisted `compaction` section of
   `sessions/settings.json`; each field also shows the value a run would
   actually use and where it came from. An explicitly-set non-zero serve flag
   or `TWO_BROTHERS_*` env value wins over the saved value and is shown as
   pinned instead of pretending the save took effect; an older backend renders
   an unsupported state and changes nothing. As a last fallback — only when no
   flag/env and no saved value is set — a role's provider preset may carry a
   **Context window (tokens)** (Settings → Providers); if both roles resolve to
   one, the smaller window applies (safer compaction), and the Advanced card
   reports the source honestly (`from the provider preset`).
4. **Read the run at a glance.** Older tool/activity rows of completed runs
   fold into one muted disclosure row — `… N tool calls · expand` (the label
   adds `in M runs` when the folded group spans several runs) —
   a real button (`aria-expanded`; `Tab` to it and press `Enter`/`Space`):
   expanding restores those rows in place, a single row stays open,
   conversation content never folds, and the run you are following always
   stays open. When the model writes a plan through the built-in `todo_write`
   tool, a **Plan** dock appears above the composer (✓ completed, ▸ in
   progress, ○ pending — at most four rows plus a `+N more` tail, a real
   expand button and a live announcement). The composer's status-seat row
   states what the next run will use: the Senior and Junior models, the
   effective workspace permission preset (`Always ask` in the default `ask`
   mode; `Read only`, `Workspace write` or `Full access` mirror Settings →
   Permissions, and an older backend with no saved-policy field reads as the
   fail-closed `ask` it applies). Clicking that seat opens Settings directly on
   Permissions. The row also shows the latest prompt audit's exact
   system/context character counts plus the offered-tool count; the usage
   footer shows tokens and the live cache-hit percentage after every
   cooperation node. A seat whose data is unknown is simply absent — no
   token counts or other numbers are invented. The browser tab title follows
   the selected session and its run state: `▶ …` while a run works or is
   queued, `! …` while it waits for an approval, `… (failed)` for a failed run,
   `(N) Two Brothers` when finished runs are unread and no session is selected,
   and plain `Two Brothers` otherwise. A background tab therefore tells you
   when the brothers need you without switching back.
5. **Approve mutations.** Reads inside the workspace are free, but by default
   every write/edit/delete/shell command docks an approval card in the chat —
   **Allow once** or **Deny** there to resume the run. A third decision,
   **Always allow this session**, resolves the request now and remembers the
   identical `(action, target)` pair for the rest of that session, so repeats
   run without asking (`y` allows once, `n` denies, `a` allows for the session
   while the card has focus). The grant is saved in the session's settings
   (`sessions/settings.json`, never in the session log), survives a backend
   restart for that session, and is removed when the session is deleted; a
   shell grant stores the approved command line — the same detail the runtime
   sidecar already records. The fail-closed default is unchanged, and an older
   backend without session scope answers honestly: "Allowed once — this
   backend does not support session scope."

   **Permissions.** How much runs without asking is an explicit operator
   choice, set in Settings → **Permissions** (or the TUI `/settings` →
   Permissions action / `/permission`, and with `--approval-mode` on the
   server or TUI process, never persisted). Four named presets each store one
   approval mode: **Read only** (`readonly`: only reads run; every mutation
   and shell command is denied without asking), **Always ask** (`ask`, the
   default: reads free, everything mutating asks), **Workspace write**
   (`edits`: writes/edits run freely; deletes and shell still ask) and **Full
   access** (`allow-all`: everything runs without asking — explicit opt-in,
   shown with a destructive warning inline; the web also requires an
   acknowledgement checkbox before enabling it). The mode is stored in
   `sessions/settings.json` and applies to new workspace runs; it never
   bypasses workspace confinement or the sensitive-path refusal, and an older
   backend that does not report the setting shows Always ask without sending
   it. See [Approval modes](cli-reference.md#approval-modes) for the decision
   table and preset mapping.

   The card explains what is being approved. Shell and delete requests carry a
   fixed honest reason (shell: effects cannot be previewed and may change any
   file the process can reach; delete: cannot be undone) — write/edit
   approvals carry none because their diff is the explanation — and the reason
   stays on the card after Allow/Deny (`cancelled` wins for a cancelled run).
   A collapsed-by-default **Preview the change** / **Preview the command**
   toggle expands the bounded unified diff or shell command as plain text,
   with `+N -M` counts and a `clipped` badge when the backend hit the 20 000
   char cap; nothing renders when there is no preview, so an older backend
   degrades to the previous card. On narrow screens the sidebar
   becomes a drawer over the chat.
6. **Review the changes** — files touched by tools are collected with their
   unified diffs. For the newest completed run of the selected session, an
   **Undo file changes…** bar offers to revert exactly the files that run
   mutated through the workspace tools: the confirmation lists every file with
   an honest status (`will be restored`, `will be deleted (created by the
   run)`, `refused — changed since the run`, `not captured`, `refused — the
   saved copy is missing`) and the apply reports per-file
   restored/deleted/refused/failed outcomes. Files changed after the run are
   never overwritten, and shell-made or untracked changes are out of scope.
   Restored files keep the permission they had when the run captured them where
   the platform supports it (ownership only where the process may set it), and
   files the run created are deleted. The stored records are bounded — the
   newest 20 per session and records older than 30 days are pruned when a
   capture finishes, and unreferenced blobs are collected in the same pass — so
   `<sessions>/undo` cannot grow without limit; an old run simply stops being
   undoable. The terminal counterpart is
   `two-brothers sessions undo <name> [--run <id>] [--apply|--discard] [--json]`
   (preview by default; see
   [the CLI reference](cli-reference.md#sessions)).
   The bar only appears while no run is live and no compaction is in flight,
   and an older backend without the route hides it after one honest notice.
7. **Jump around with `Ctrl+K`** (`Cmd+K` on macOS) — the command palette
   searches sessions, workspaces, and actions; from two typed characters it
   also searches message content across all sessions and lists the hits in a
   `Messages` group. The sidebar footer's Light/Dark/System selector sets the
   theme. A session row's `⋯` menu can rename the session, export it as
   Markdown, JSON or a self-contained HTML page, fork it into a new session
   (`Fork session…`, unavailable while a run is active for that session), or
   delete it. An operator message in the transcript also offers a **Rewind**
   action: after a destructive confirmation it removes that task and
   everything after it from the session file while keeping the earlier
   transcript (unavailable while a run is active or the context is being
   compacted, and a task already folded into a compaction summary cannot be
   rewound). A rewind also clears the removed runs' tool/approval history
   from the runtime sidecar and cannot be undone.

   A message bubble also offers **Fork from here…**: it copies the conversation
   up to and including that message into a new session (`{seq}`, the original
   file stays untouched) and opens the fork, so a what-if branch starts from the
   exact point you choose. Like the row menu's fork, it is unavailable while a
   run is active for the session.

Sessions are plain JSONL files under `--sessions-dir`; each has a
`<name>.meta.json` sidecar (title, workspace link, and — for a fork — a local
`parent` link) and a runtime sidecar in
`sessions/runtime/<name>.events.jsonl` (tool calls, approvals, diffs, plan
snapshots). To switch a store to the project/session directory layout (one
folder per session with `session.jsonl`, `meta.json` and `events.jsonl`), run
`two-brothers sessions migrate --sessions-dir sessions --dry-run` first, then
without `--dry-run`; readers accept both layouts. See
[Session storage](session-storage.md).

## The terminal workspace

The **TUI** is the same harness as a full-screen chat in the terminal (it
needs a TTY). A bare interactive `two-brothers` (or `node dist/cli.js` with
no arguments) opens it directly; piped/CI invocations print the usage screen
instead. Use `chat` for scripts.

```powershell
node dist/cli.js tui --provider mock
node dist/cli.js tui --workspace ./repo --provider mock   # workspace-bound: tools + approvals
```

Block transcript with textual role labels, Markdown bodies (headings, lists,
fences, diffs, inline bold/italic/code emphasis with theme styling that
disappears cleanly under `NO_COLOR`), a grapheme-aware multiline
composer with history and bracketed paste, `Up`/`Down` recall of submitted
tasks at the draft edges (the live draft is preserved and restored exactly;
single-line drafts recall immediately, multiline drafts only at their very
start/end), `Ctrl+R` incremental prompt-history
search, `Ctrl+F` find-in-transcript (with `/find`), `Ctrl+O` to stash or
restore a draft, Ctrl+P command palette and `?` help overlays, session/model
pickers, live **THINKING** and response blocks from token streaming, live
resize repaint, and non-blocking turns — Escape/Ctrl+C cancel a running turn
before anything else. While a turn runs, `Ctrl+N` (or the palette's **Steer
the running turn** row) queues the composer text for that turn at its next
step — not a new task — bounded to eight pending texts of 4 000 characters;
the draft clears only on acceptance and leftovers are reported honestly.
`Ctrl+X` copies the last completed reply (native clipboard first, OSC 52 where
there is no OS clipboard, with an honest route-specific notice), `Ctrl+G` opens
the draft in `$VISUAL`/`$EDITOR`, and the terminal title shows
`Two Brothers — <session> · working|approval|done|failed`; a parked approval
raises one OSC 9/BEL notification and every exit path restores the title.
Typing `/` at the start of the composer opens the
command menu (the TUI's own commands, then built-in prompts/actions, then
discovered templates) and `@` opens the mention picker: shared skills are
selectable (`@skill:name`), and in a workspace-bound run a path-like `@dir/file`
token opens the workspace-file picker and attaches that file to the shared
context before the turn starts (without `--workspace`, `@path` stays literal
text). A built-in action like `/compact`, `/export [path]`, `/status` or
`/permission` is performed by the TUI and never submitted as a task;
`/plan <objective>` expands and runs that turn. `/permission` states the
effective permission preset and the stored mode it applies; without a
`--approval-mode` pin its buttons save one of the four presets to
`sessions/settings.json`, and with a pin it says so and
offers only Close (a typed `/permission <preset>` change is refused with the
pin reason; without a pin it applies the mode directly). A plan
written through the
model's `todo_write` tool docks above the composer as a compact display-only
panel (✓/▸/○ markers, four rows plus an honest `+N more` tail; no key answers
it). With `--session-file` that plan is durable: each plan snapshot is written
to the session's runtime sidecar, so restarting the TUI on the same session
file brings it back (a cleared plan stays cleared); an in-memory session keeps
its plan only for the current process.

Collapsed tool-result rows fold to a preview bounded by visual rows after
width-aware wrapping (six by default), with a `… +N more lines` marker that
counts the hidden visual rows; `Ctrl+T` toggles the most recent result between
the preview and its complete text, expansion is per tool row, and the model
always keeps the full result. The visual-row truncation follows pi's
visual-truncate approach (MIT — see
[Attribution](attribution.md)).

The overlays follow the theme — the palette and help lists paint their headings,
chords, descriptions and selected row — while `NO_COLOR` output keeps the same
text; the composer no longer repeats the mode/models line because the status bar
is the single source for both; a transcript window that starts in the middle of
a block marks the hidden label with a dim `⋯` in the gutter; and the status bar
uses its hint slot well at ordinary widths: one registry-derived tip per
accepted turn (`Ctrl+T fold tool output`, `Ctrl+F find in transcript`,
`Ctrl+P commands`, …), with the tool-fold action leading while a tool row is on
screen, and a brief transient hint after events such as a stopped turn
(`turn stopped — Ctrl+C ×2 exits`). While a workspace approval is parked the
slot instead explains the quit path (`deny to continue — Ctrl+C stops the turn
after it resolves`).

### Workspace-bound runs and approvals

`tui --workspace <dir>` binds every turn to one confined directory, so the
senior and junior can actually read, search, edit and run commands inside it:

- The junior gets the `workspace_*` tool belt and the senior gets the
  read-only verify slice (plus approval-brokered `run_shell`). Reads
  auto-allow; every write, edit, delete and shell command pauses the run —
  unless the effective [approval mode](cli-reference.md#approval-modes) allows it (`edits`,
  `allow-all`) or denies it before a card can appear (`readonly`).
- A parked request replaces the composer with an approval panel showing the
  action, target, shell command, reason and a bounded diff summary. Answer with
  `1`/`y` **Allow once**, `2`/`a` **Always allow this session** (memory only,
  for this TUI process — never saved to settings), or `3`/`n`/`Esc` **Deny**;
  `Up`/`Down` + `Enter` pick the highlighted row, and `Ctrl+E` opens the full
  diff or command full-screen (closing the preview never answers the request).
  Stopping or cancelling the turn denies everything still pending, so a stop
  can never leave a mutation parked or apply one later. While the panel is open
  it owns the decision keys: `Ctrl+C` is inert until you answer (the status bar
  says `deny to continue — Ctrl+C stops the turn after it resolves`), so deny
  or allow first, then stop the turn as usual.
- `@relative/path` mentions attach workspace files (at most five, 20 000 chars
  each, 100 000 total, text files only; unknown, absolute, `..`-escaping and
  sensitive paths refuse the whole task with an honest notice).
- An invalid root (`workspace root does not exist:` /
  `workspace root is not a directory:`) exits 2 before the screen opens.
  `/permission` states the effective preset, its stored mode and description
  (plus the full-access warning), the bound root, the decision keys and any
  in-memory session allows; without a pin its buttons persist a preset, and
  `/permission <preset>` applies one directly (legacy mode names still work).
  `/settings` shows the same effective preset and links to the Permissions
  dialog. Pass
  `--approval-mode <ask|readonly|edits|allow-all>` to pin the mode for this
  TUI process only (never persisted).

Try it with the mock provider (the mock cannot mutate, but the workspace binds
and the policy is real):

```powershell
node dist/cli.js tui --workspace . --provider mock
```

### Connecting a provider from the TUI

The TUI resolves provider connections the same way `serve` does: it reads the
persisted settings store (`<sessions-dir>/settings.json` — the file the web
Settings and `onboard` write; keys encrypted at rest) at startup and again
before every turn and compaction. A provider you configured in the web UI or
with `onboard` is therefore already in effect when you open the TUI; CLI flags
and `TWO_BROTHERS_*` env pairs stay the most explicit override (role pair beats
shared pair, all-or-nothing; env-pinned fields are never persisted).

To connect or change a provider without leaving the terminal, run `/provider`
(also reachable through `/settings` → **Connect provider…**; `/settings` is in
the Ctrl+P palette):

1. It shows a per-role summary — provider · model · wire kind · base URL ·
   `API key: set` or `not set` (never the key value).
2. Pick a role, then either a named preset (seed or stored) with one of its
   model ids, or a manual connection (Base URL / model / optional API key; the
   key is masked while you type).
3. Saving is one atomic settings write with the key encrypted at rest; a failed
   save keeps the dialog open with the real error and changes nothing.
   Changing providers is refused while a turn or compaction is running.

If a turn cannot connect, the provider's own error stays visible and the TUI
points you at `/provider` (or the `--base-url`/`--api-key` flags). Keys never
appear in frames, transcripts, prompt history or sidecars, and a dangling saved
provider reference warns at startup and falls back to the role's manual fields.

Full keymap and web palette keys: [Keyboard and shortcuts](keyboard.md).

## Verify

```powershell
cd two-brothers-harness
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/smoke-test.ps1
```

It should end with `SMOKE TEST: PASS` (package typecheck/build/tests/selftest,
a mock demo run, the hermetic CLI E2E, the `typescript/` reference selftest,
the web unit tests, and the web build). The package's own gates are
`npm test` / `npm run test:spawn` in `packages/harness`; see
[Testing](testing.md).

## What's next

- [CLI reference](cli-reference.md) — all commands and flags.
- [Troubleshooting](troubleshooting.md) — fixes for common provider, session, web and TUI failures.
- [Attribution](attribution.md) — the MIT references behind the project.
- [Protocol](../PROTOCOL.md) — how the message exchange is structured.
- [Testing](testing.md) — tests and verification tools.
