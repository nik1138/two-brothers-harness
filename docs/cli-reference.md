# CLI Reference

The command set covers the TypeScript package — the implementation. Examples
below use `node dist/cli.js <command>` from `packages/harness/` (after
`npm run build`); a global install exposes the same commands as
`two-brothers <command>`. The zero-dependency reference in `typescript/` runs
the same core commands as `node src/cli.ts <command>`. `serve` is provided by
the package: a plain `node:http` server exposing the HTTP + SSE API.

Global invocations: `two-brothers --version` (or `-v`) prints the package
version; a bare `two-brothers` with no arguments opens the full-screen TUI on
an interactive terminal and prints the usage screen when stdin is piped.

## Commands

### `run "<task>"`

A single invocation: task → cooperation → `decision`.

```powershell
node dist/cli.js run "Plan a migration from Redis to Valkey"
```

If the task contains spaces, pass it as a single string (quote it in PowerShell).

The human transcript renders as separated, Markdown-rendered envelope blocks
with a ruled decision and a compact usage footer — see
[Human text output](#human-text-output-ts-package). On an interactive stdout
the transcript streams live (each block as produced, with dim activity rows
between blocks); `--no-live` prints the finished transcript once instead. The
automation modes (`--json`, `--json-events`, `--stream`, `--mode print`) keep
their exact bytes and never stream live.

The task can also come from stdin or a file:

```powershell
Get-Content task.txt | node dist/cli.js run - --provider mock   # task from stdin (max 1 MiB)
node dist/cli.js run --task-file task.txt --provider mock        # task from a file
```

`run -` reads the task from stdin (blank input is a usage error, exit 2; more
than 1 MiB is rejected). `--task-file <path>` reads it from a file (a missing,
unreadable or blank file exits 2). A positional task and `--task-file` are
mutually exclusive. The bare `two-brothers` invocation with piped stdin still
prints the usage screen — only `run -` opts into reading stdin as a task, and
`chat`/`tui` piped behavior is unchanged.

`--dry-run` resolves the whole run — configuration (with per-field sources),
providers, session file, plugin/skills/commands roots and MCP config presence,
compaction settings and limits — prints the plan, and exits 0 **without calling
a model and without writing a session**. `run --dry-run --json` prints the plan
as one JSON object; `--dry-run` with `--stream` is a usage error (exit 2).
`chat --dry-run` prints the REPL plan and exits without starting the REPL.

```powershell
node dist/cli.js run "Plan a migration" --provider mock --dry-run
node dist/cli.js run - --provider mock --dry-run --json < task.txt
```

### `chat`

REPL: several tasks in one session. Empty line, `exit`, `quit`, `q`, `/exit`,
`/quit` — exit. Before the first prompt the REPL prints the resolved
provider/model/base URL per role. Each turn's human transcript renders through
the same layout as `run`; on an interactive stdout every turn streams live
(dim activity rows included) and `--no-live` prints each turn once when it
finishes — a piped REPL always prints it once.

```powershell
node dist/cli.js chat --provider mock
```

#### Slash commands (TS package)

The REPL turns `/name args` into a prompt from a markdown command file before
submitting it. Commands are flat `<root>/<name>.md` files whose frontmatter
carries `description`, an optional `argument-hint`, and an optional `mode`
(`consult`/`work` — it overrides the run mode for that turn):

```markdown
---
description: Summarize a document in five bullets
argument-hint: <path>
---
Summarize the file at $1 in five bullets. Extra context: $ARGUMENTS
```

Roots, in priority order: repeatable `--commands-dir`, then
`TWO_BROTHERS_COMMANDS_DIR` (one or more roots separated by the OS path-list
separator), then `<cwd>/commands`, then `~/.two-brothers/commands`. Command
discovery happens once per REPL session, so a new file needs a new session.
`/commands` (and `/help`) lists every discovered command as
`name — description (argument-hint)`; an unknown `/name` prints
`unknown command: <name>` with a hint and is **not** submitted as a task.
`$ARGUMENTS` is the whole argument string, `$1`..`$9` are the whitespace-split
words, and `$$` is a literal `$`; expansion is literal text only (no shell,
no re-expansion). Diagnostics print under `--verbose`. The same metadata is
served at `GET /api/commands`.

#### Built-in REPL commands

The REPL also dispatches the first-party commands (see
[Built-in commands](#built-in-commands) for the shared catalogue); a
discovered `<name>.md` wins over a same-named built-in:

- **Prompt** — `/plan <objective>`, `/goal <objective>` and
  `/feedback [notes]` expand to a task and run as that turn, with the
  command's `consult` mode override. ASCII aliases work too (`/objective`,
  `/review`, `/bug`); a missing required argument prints
  `usage: /plan <objective>` and submits nothing.
- **Action** — performed by the REPL, never submitted: `/compact` (compact the
  in-memory context with the configured summarizer and REPL compaction
  budgets; with `--session-file` the rewritten session is persisted with
  dense `seq`, so `--resume` keeps working; prints `compacted: N → M
  envelopes` or `nothing to compact`), `/export [path]` (Markdown export,
  default `<session stem>.md` in the cwd), `/status` (session/mode/context
  and resolved roles), `/permission` (the fail-closed approval policy and the
  configured tool scopes), `/mode [consult|work]` (show or switch the REPL
  mode for following turns), and `/help` / `/commands` (built-ins grouped
  prompt/action with hints and aliases, then the discovered templates).
  `/new` is refused with a pointer to starting a new `chat` (the line REPL
  cannot replace a session in place). A failed `/compact` or `/export` prints
  `compact failed: …` / `export failed: …` and keeps the context intact.
- `/config` still prints the resolved per-role endpoints. The reference
  Chinese aliases resolve in the catalogue, the metadata API and the pickers,
  but are not **typeable** on any surface: `matchCommand`'s ASCII name rule
  (shared by the REPL, the TUI and `POST /api/runs`) treats `/目标 …` as an
  ordinary slash-prefixed task. The web and the TUI now detect that case and
  answer with a notice naming the canonical spelling instead of sending it.

### `tui [initial task]`

Full-screen interactive chat in the terminal's alternate screen, over the
same harness as `chat` (mock or real providers). A bare `two-brothers` in an
interactive terminal opens this TUI. Needs a TTY: a piped stdin exits `2`
with a clean message and no escape bytes (use `chat` for scripts).

The screen is a block transcript with textual role labels (`YOU`, `SENIOR`,
`JUNIOR`, `TOOL`, `ERR`/`WARN`/`INFO`), a contained multiline composer
(grapheme-aware cursor, prompt history, bracketed paste — a pasted newline
never submits; `Up`/`Down` recall submitted tasks at the draft edges and
restore the pre-recall draft exactly), and a two-line status bar with mode, models, session, cwd,
context/tokens/cache/cost and rotating key hints (see
[Status hints and transient copy](#status-hints-and-transient-copy)).
Markdown bodies render headings,
lists, quotes, fenced code, diffs, and inline bold/italic/code/link emphasis
with theme colors and attributes; under `NO_COLOR` (or a color-free theme)
the layout and text are byte-identical and only the styling disappears. The
screen repaints on terminal resize and restores the terminal on every exit
path. Turns run without
blocking input; Escape/Ctrl+C under a safe precedence (overlay close → cancel
the running turn → clear the composer → confirm quit). `Ctrl+P` opens the
command palette, `?` a scrollable help overlay (only while the composer is
empty; `F1` always opens it), both generated from the same keymap registry as
`tui --help`. The three global chords — command palette, shortcut reference
and draft stash — can be rebound from a versioned JSON file with
`--keys-file <path>` or `TWO_BROTHERS_TUI_KEYS_FILE` (default
`~/.two-brothers/tui-keys.json`; a missing file means the defaults; an
invalid file prints one diagnostic line and keeps the defaults); the effective
chords appear in `tui --help`, the `?` overlay, the palette and the status
hints, and the file is read at startup. `two-brothers help tui` shows the
same generated key guide, resolved from `TWO_BROTHERS_TUI_KEYS_FILE` or the
default `~/.two-brothers/tui-keys.json` (the `help` command has no
`--keys-file` flag; use `two-brothers tui --help --keys-file <path>` for a
flag-selected file). An invalid file prints one `[tui keys]` diagnostic and
falls back to the defaults; a missing default file is silent. Inside the TUI,
`/keys` (or `/keys show`) prints the three effective global chords and the
captured keys-file path/origin (flag, env or default) with the last load
state and the honest watch state — it never claims overrides that are not
active. `/keys reload` re-reads
the same startup-captured file and applies valid changes immediately to
matching, the palette/help listings and the status hints (the success notice
names the new chords); an invalid/unreadable file keeps the previous chords
and prints one bounded diagnostic, and an absent file keeps them with an
informational notice. `tui --keys-watch` (or `TWO_BROTHERS_TUI_KEYS_WATCH=1`,
off by default and never persisted) keeps watching that captured path and
live-applies valid edits through the same validated reload path: a detected
change posts one bounded notice naming the new chords, an invalid file keeps
the last good chords with one bounded warning per detected change, and an
absent/unreadable file keeps them with an informational notice. The watcher
uses `fs.watchFile` polling (~twice a second, debounced/coalesced). The
path/origin and the watch flag/env are captured at startup (a flag/env change
needs a TUI restart); only the file's contents keep reloading live. `Ctrl+F` (or `/find [query]`) opens
find-in-transcript: a live
case-insensitive filter over the whole transcript with `current/total`,
`Enter`/`Down` next, `Shift+Enter`/`Up` previous (wrap), the active match
marked and scrolled into view, and `Esc` restoring the draft and scroll
position. Typing `/` at the start of the composer (or a line start) opens an
inline command picker: the TUI's own commands first, then built-in prompts and
built-in actions (rows badged `builtin`/`action`, highlighted-row
`usage — description` footer), then discovered templates with a `template`
badge; typing `@` at a token boundary opens the mention picker — skills (shared
skills are selectable, role-scoped rows are shown disabled) and, in a
workspace-bound TUI, a path-like `@dir/file` token opens the workspace-file
picker instead. `Enter`/`Tab` insert or run
the highlighted row, `Shift+Tab`/`Esc` close without touching the draft, and a
held key cannot repeat a submit.
When a provider streams reasoning, a bounded dim `THINKING` block appears
above the streaming response for that call and disappears when the completed
reply arrives — reasoning is observational and never persisted or treated as
part of the reply. Collapsed tool-result rows fold to a bounded preview: the
newest result shows at most six visual rows after width-aware wrapping, and a
`… +N more lines` marker counts the hidden visual rows; `Ctrl+T` toggles the
most recent result between the preview and its complete text, expansion is
tracked per tool row, and the model always keeps the full result. The
visual-row truncation follows pi's visual-truncate approach (MIT — see
[Attribution](attribution.md)). A model-written plan docks above the composer
as a compact display-only panel (✓/▸/○ markers, at most four rows plus an
honest `+N more` tail — see
[Plan and todo function](#plan-and-todo-function-ts-package));
it takes no keys. Slash input: `/mode consult|work`, `/models`,
`/sessions`, `/theme dark|light|system`, `/settings` (provider summary,
effective permission preset and the **Connect provider…** / **Permissions…**
actions), `/provider` (the provider connect surface — see
[Provider connection](#provider-connection-provider)),
`/retry`, `/help`,
`/commands`, `/exit`, plus discovered `<name>.md` templates (unknown names are
never submitted as tasks). The built-in prompts `/plan <objective>`,
`/goal <objective>` and `/feedback [notes]` expand and run that turn; the
built-in actions `/compact` (between turns — compacts through the configured
senior endpoint and rewrites the session file, the visible transcript is
unchanged), `/export [path]` (Markdown; in-memory sessions need a path),
`/status`, `/permission` (the effective permission preset, its stored mode and
description, the bound workspace, the decision keys and this process's session
allows — see [Approvals in the TUI](#approvals-in-the-tui); an unbound run
says so plainly)
and `/new` (in-memory session; on-disk sessions are refused
honestly) are
performed locally and never submitted as tasks — see
[Built-in commands](#built-in-commands). A native command always wins its own
name and a discovered template shadows a same-named built-in. `/models` and
`/sessions` refuse to change things while a turn runs, and model changes are
session-local. Provider connections resolve from the same persisted settings
store as `serve` (see [Provider connection](#provider-connection-provider)).
`--stream-tokens` renders token deltas in place while a turn
runs.

**Steering a running turn.** While a turn runs, `Ctrl+N` queues the composer
text for that turn and applies it at the run's next step — it never starts or
queues a task, and it is the TUI counterpart of the web **Steer run** /
`Alt+Enter`. The queue is bounded exactly like the runtime's: at most eight
pending texts of at most 4 000 characters each; the text is trimmed, and a
blank or oversized text or a full queue is refused with an honest notice
instead of being silently truncated. The draft is cleared only when the steer
is accepted; the notices distinguish a queued steer (with the pending count)
from still-pending leftovers, and a steer left over when the turn ends is
reported as not applied rather than implied to have landed (an applied steer
appears in the transcript as the ordinary operator message it is). `Enter` while a turn runs keeps its
existing refusal (`a turn is still running — your draft is kept; send it when
the turn finishes · Ctrl+N steers the running turn`) and queues nothing. The
action is a normal registry command, so it is discoverable exactly like
`/keys`: it appears in the `Ctrl+P` palette as **Steer the running turn**, in
the `?`/`F1` help overlay and in the generated `tui --help`. Some terminals
keep `Ctrl+S` for XOFF flow control, which makes the screen look frozen; the
palette row queues the same text, and `Ctrl+Q` (XON) resumes output if a
terminal paused. There is no typed `/steer` form.

**Copying and terminal attention.** `Ctrl+X` copies the last completed reply to
the clipboard as plain text: the newest committed decision, or the newest
completed outgoing senior reply when the run has no decision yet. Junior
proposals, tool results, streaming drafts, notices and operator text are never
copied. The platform clipboard is tried first (PowerShell/`clip.exe` on
Windows, `pbcopy` on macOS, `wl-copy`/`xclip`/`xsel` on Linux/BSD); where there
is no OS clipboard to reach (remote/SSH, a container, WSL without WSLg) or
every native writer fails, the TUI falls back to one terminal OSC 52 sequence.
OSC 52 is a request the terminal may ignore, so the toast names the route
(`via OSC 52`) instead of claiming a clipboard write, and an empty transcript
answers `nothing to copy yet` without copying. `Ctrl+X` is a fixed binding (not
one of the three rebindable global chords) and appears in the `Ctrl+P` palette,
the `?`/`F1` overlay and `tui --help`.

While it runs, the TUI keeps the terminal's attention state. The OSC 0 title is
`Two Brothers — <session> · working|approval|done|failed` (the status suffix
is omitted when idle, and the product name alone when no session is open),
sanitized and capped at 120 characters. It changes on session start/switch and
run transitions: `working` on a run start or an approval resolution, `approval`
when an approval parks, `done` on completion/cancellation, `failed` on a failed
run or a completed run with errors. Every exit path restores the title the
driver set (`Two Brothers`) when the driver changed it, and a non-TTY or
`TERM=dumb` session writes nothing. When an approval parks, the TUI emits
exactly one notification per approval id — an OSC 9 where the terminal is known
to support it (iTerm2, WezTerm, Ghostty, Warp, kitty), a tmux DCS passthrough
inside `tmux`, otherwise one BEL — never on a normal turn end or a cancelled
run. Notification text is sanitized and capped at 200 characters.

**External editor.** `Ctrl+G` opens the current composer draft in
`$VISUAL`/`$EDITOR` (in that order; Windows falls back to the system
`notepad.exe` only when it exists, and a POSIX process with neither variable
set refuses honestly). The editor inherits the terminal while it runs; on a
clean exit the saved text replaces the draft (a UTF-8 BOM is stripped, CRLF is
normalized to LF, one final newline is dropped, and the read-back is capped at
256 KiB). A nonzero exit, a spawn failure or an oversized draft leaves the
draft untouched, and the temp file is always removed. `Ctrl+G` is idle-only: it
refuses while a turn or compaction runs, or while an overlay/find/approval owns
the keyboard, and it never launches an executable inside the workspace (PATH
resolution refuses a hit under the working directory).

```powershell
node dist/cli.js tui --provider mock
node dist/cli.js tui --workspace ./repo --provider mock
node dist/cli.js tui --workspace ./repo --approval-mode readonly --provider mock
node dist/cli.js tui "Plan a migration from Redis to Valkey" --provider mock
```

`tui --approval-mode <mode>` (or `TWO_BROTHERS_APPROVAL_MODE`) pins the
[approval mode](#approval-modes) for this TUI process only — never persisted;
without a pin the saved `approval_policy` setting (or the fail-closed `ask`)
applies, and `/permission` writes that setting.

#### Workspace-bound TUI runs (`--workspace`)

`tui --workspace <dir>` binds every turn of the TUI session to one confined
workspace root:

- The junior's belt gains the confined `workspace_*` tools
  (`workspace_read_file`, `workspace_list_dir`, `workspace_search_text`,
  `workspace_write_file`, `workspace_edit_file`, `workspace_delete_file`,
  `workspace_run_shell`) and the senior gets the read-only verify slice (plus
  approval-brokered `run_shell`); plugin bindings see the same workspace.
- `workspace_read_file` pages a large file by line: `offset` is the 1-based
  first line (default 1), `limit` the page size in lines (default 2 000,
  clamped to 1–5 000), and `max_chars` (default 20 000) usually bounds the page
  characters; one astral code point may exceed it by one UTF-16 unit so a page
  always advances. A ranged result carries `content`, `truncated`, `offset`,
  `lines`, `total_lines`, `eof` and, when more remains, `next_offset`. If no
  whole line fits, the result delivers that line's safe prefix; `next_offset`
  names the line and the result also carries `next_char_offset` (0-based UTF-16
  offset **relative to `next_offset`**) for the undelivered tail. Continue at
  `next_offset` with `char_offset: next_char_offset`: when `next_offset` stays
  the same this reads the same line's tail, and when it advances it starts the
  later line without replaying or skipping content. `eof` is false while any
  line or character tail remains, and a surrogate pair is never split; a
  `max_chars: 1` page whose next character is astral delivers that pair (2
  UTF-16 units) instead of returning an empty page, and a line completed by
  that pair advances normally. Without `offset`/`limit`/`char_offset` the read
  is the historical whole-file head+tail window, byte-identical to before.
- Reads auto-allow. Writes, edits, deletes and shell commands park the run on
  the [approval panel](#approvals-in-the-tui) instead of the composer — unless
  the effective [approval mode](#approval-modes) lets them run without asking
  (`edits`, `allow-all`) or denies them before an approval can park
  (`readonly`). The mode is read fresh for every workspace turn (the saved
  setting, or a `--approval-mode`/env pin for this process).
- Composer `@<relative/path>` / `@./<path>` mentions attach a workspace file as
  a `<file path="…">` context block before the turn starts, under the same
  caps and refusals as the server path: at most `MENTION_MAX_FILES` (5) files,
  `MENTION_MAX_FILE_CHARS` (20 000) per file with the standard truncation
  marker, `MENTION_MAX_TOTAL_CHARS` (100 000) in total, text files only;
  unknown, absolute, `..`-escaping, sensitive and oversized files refuse the
  whole task with an honest notice. Typing `@` and a path-like token opens the
  workspace-file picker (rows show the canonical `@path` token and the file
  size). Without `--workspace`, `@path` stays literal task text exactly as
  before.
- An invalid root is a startup error: exit `2` before the alternate screen
  opens, with an `[error]` line naming the problem — `workspace root does not
  exist: <dir>` or `workspace root is not a directory: <dir>`.
- `/permission` states the effective permission preset, the stored
  [approval mode](#approval-modes) it applies and its description (with the
  Full access danger warning), the bound root, the decision keys and the
  in-memory session allows — or says the run has no workspace and no approval
  broker. Without a `--approval-mode` pin its buttons persist one of the four
  presets to `sessions/settings.json` (it applies from the next workspace
  turn); with a pin it states that the mode is pinned for this process, offers
  only Close, and a typed change is refused with that same honest reason.
  `/permission <preset|mode>` applies one directly (unknown values are refused
  with the allowed list). `/settings` shows the same effective preset and has
  a **Permissions…** action that opens this dialog.

#### Approvals in the TUI

Workspace-bound runs request operator approval through the same
`RunApprovalBroker` the server uses. The effective
[approval mode](#approval-modes) decides whether a mutation parks at all
(`readonly` denies without a card, `edits`/`allow-all` let their actions run);
every workspace turn shows a warning toast while the mode is `allow-all`.
While a request is pending, a docked panel
replaces the composer and shows the action, target, shell command, reason and a
bounded diff summary (the full diff/command is one `Ctrl+E` away). Shell and
delete requests carry the fixed reasons listed in the
[approval-reason table](#serve) — shell explains that its effects cannot be
previewed, delete that it cannot be undone — while write/edit approvals carry
none because the diff is the explanation:

| Key | Decision |
|---|---|
| `1` / `y` | **Allow once** — approve this call only |
| `2` / `a` | **Always allow this session** — approve this call and identical `(action, target)` requests for the rest of this TUI process (memory only, never saved to settings) |
| `3` / `n` / `Esc` | **Deny** — refuse this call (`Esc` denies exactly once and never answers a later request) |
| `Up` / `Down`, `Enter` | Move the highlight between the three decisions, answer with the highlighted one |
| `Ctrl+E` | Full-screen preview of the pending diff or shell command; closing it never answers the request |

Stopping or cancelling the turn denies every pending request (fail closed), and
the broker's per-pair denial cap still applies. The panel is the only approval
authority in the TUI: closing an overlay never answers it, and a stopped turn
never leaves a mutation parked. While the panel is open it owns the decision
keys, so `Ctrl+C` is inert until the request is answered — the status bar says
`deny to continue — Ctrl+C stops the turn after it resolves`; deny (or allow)
first, then `Ctrl+C`/`Esc` can stop the turn as usual.

#### Plan panel

A plan written by the model through the built-in `todo_write` tool docks above
the composer: at most four item rows (`✓` completed, `▸` in progress, `○`
pending) plus an honest `+N more (…)` tail and a `TODO · n/m done` title. It is
display-only — no key answers it and the composer keeps its normal keys.

The plan is durable for a run whose session has a file: a TUI turn writes each
plan snapshot as one `todo_updated` event to the session's runtime sidecar,
`sessions/runtime/<session-file>.events.jsonl` (flat layout; a migrated store
uses `<project>/<stem>/events.jsonl`) — the same store and key convention as
`serve`, with the session file name unchanged, extension included.
Restarting the TUI with the same `--session-file` replays the last snapshot and
a cleared plan stays cleared; only plan snapshots are persisted (tool, approval
and envelope events are still not), and an in-memory session — no
`--session-file` — has nothing durable to write to. A serve-written sidecar for
the same session replays the same way, and the in-process cache keeps session
switching instant.

#### Status hints and transient copy

The status bar's second row carries a rotating tip derived from the same keymap
registry as `?`/`Ctrl+P`: one tip per accepted turn, deterministic, highest
value first — `Ctrl+T fold tool output`, `Ctrl+F find in transcript`,
`Ctrl+P commands`, `? keys and help`, `Ctrl+R search prompt history`,
`Ctrl+B status panel`, plus `Esc stop the turn` while a turn runs. A full cycle
covers each available action once; while a tool row is on screen its fold
action leads and is removed from the rotation, so the same chord never appears
twice. Tips are skipped when their command is unknown, has no chord, or is
disabled in that state (the running-only stop tip hides while idle), so the
footer never advertises an action the operator cannot take.

A one-shot transient hint can take the hint slot for a few renders, clipped
into the remaining cells rather than dropped while at least eight cells are
left (with less room the slot is omitted whole rather than showing a fragment):
after a stopped turn it reads
`turn stopped — Ctrl+C ×2 exits`, and while a workspace approval is parked it
reads `deny to continue — Ctrl+C stops the turn after it resolves` (the
approval panel owns the decision keys, so Ctrl+C is inert until the request is
answered). The transient hint never displaces the activity segment; the
rotating tip returns when the transient budget runs out.

#### Provider connection (`/provider`)

The TUI resolves provider connections exactly like `serve`: it reads the
persisted settings store in the TUI's sessions directory
(`<cwd>/sessions/settings.json` by default — the same file the web Settings,
`serve` and `onboard` write; API keys encrypted at rest) at startup
and re-resolves before every turn and compaction. Persisted presets, manual
fields and stored keys therefore drive the turn harness, the `/compact`
provider, the model pickers, the status bar and the welcome screen.

Precedence, the operator's most explicit request first:

1. **CLI flags / `TWO_BROTHERS_*` env pairs** — the role pair
   (`--senior-base-url`/`--senior-api-key` or `TWO_BROTHERS_SENIOR_*`) beats the
   shared pair, all-or-nothing; an explicit connection pair clears the role's
   named `provider_ref`, and an explicit `--provider` (any value — including
   one that repeats the default — or `TWO_BROTHERS_PROVIDER`) overrides the
   persisted role providers. Env-pinned fields are never persisted.
2. **Persisted role settings** — manual fields, else a named `provider_ref`
   resolved through the merged seed+stored preset table.
3. **Built-in seed presets** (`presets.ts`), then the harness's per-field
   fallback.

A dangling `provider_ref` warns at startup and falls back to the role's manual
fields instead of crashing.

The seed table also carries subscription-plan presets copied from the
dsh/pi provider catalog: `opencode`/`opencode-go` (OpenCode Zen/Go),
`kimi-coding` (Kimi For Coding), `zai-coding`/`zai-coding-cn` (Z.AI coding
plans), `qwen-token-plan`, `xiaomi-token-plan-sgp`, `moonshotai` and `minimax`.
Each resolves its key from the plan's own environment variable
(`OPENCODE_API_KEY`, `KIMI_API_KEY`, `ZAI_API_KEY`, `QWEN_TOKEN_PLAN_API_KEY`,
`XIAOMI_TOKEN_PLAN_SGP_API_KEY`, `MOONSHOT_API_KEY`, `MINIMAX_API_KEY`); a key
stored through Settings or `onboard` works too. One preset speaks one wire
family, so a plan model served on another protocol (some OpenCode Go models use
its Anthropic/Google endpoints) needs its own provider entry; the curated model
lists only include IDs on the seeded endpoint. Requests to `opencode.ai` carry
the required `x-opencode-session` routing header (a stable per-conversation id
taken from the session name/file stem) and a `two-brothers-harness` client user
agent for every wire family; requests to other endpoints are unchanged.
Reasoning effort is model-declared: `GET /api/model-efforts?provider=…&model=…`
returns the models.dev `reasoning_options` values (cached, fail-soft), and a
role's saved `effort` is sent only for those declared levels.

`/provider` is the in-TUI connect surface (also reached through `/settings` →
**Connect provider…**; `/settings` is in the Ctrl+P palette). It opens a
per-role summary — provider · model · kind · base URL ·
`API key: set`/`not set`, never the key value — and then a preset-or-manual
connect: pick a role, choose a named preset with one of its model ids, or enter
a manual Base URL / model / optional API key (typed keys are masked while
typing). Saving goes through one atomic `SettingsStore.write` with the key
encrypted at rest; a save failure keeps the dialog open with the real error and
changes nothing. A turn that fails to connect keeps the provider's error visible
and points at `/provider` (or the `--base-url`/`--api-key` flags). Keys never
appear in frames, transcripts, prompt history or sidecars. Changing providers
is refused while a turn or compaction is running.

### Composer mentions and slash commands

The web composer and the TUI turn typed mentions and commands into run
context, and the server applies the same rules to `POST /api/runs` /
`POST /api/run` so any client can use them:

- **`/name args`** — if the leading token is a discovered command
  (`commands/<name>.md`, also `--commands-dir` / `TWO_BROTHERS_COMMANDS_DIR`
  roots), the template is expanded (`$ARGUMENTS`, `$1`..`$9`, `$$`) and the
  command's frontmatter `mode` overrides the run mode for that run; an
  unknown or path-like slash line (e.g. `/usr/bin/env …`) is submitted as a
  normal task.
- **`@skill:<name>`** — attaches the body of a discovered **shared** skill as
  a `<skill-loaded name="…">` context message before the task. Unknown names,
  role-scoped (`senior`/`junior`) skills and more than
  `MENTION_MAX_SKILLS` (3) are a 400.
- **`@<relative/path>` / `@./<path>`** — attaches a file from the run's
  workspace as a `<file path="…">` context message (bounded to
  `MENTION_MAX_FILE_CHARS` per file with a truncation marker, at most
  `MENTION_MAX_FILES` (5), total attached content ≤
  `MENTION_MAX_TOTAL_CHARS` (100 000) chars). Requires `workspace_id`;
  absolute paths, `..` escapes, sensitive files, binaries and missing files
  are a 400. Web root-level files serialize as `@./README.md` so they stay
  unambiguous.

Mention tokens stay in the task text (traceability); the attached blocks are
separate `message` envelopes persisted in the session JSONL before the task.
The TUI supports `/` and `@skill:` on every run, and `@<path>` file mentions
when it is bound to a workspace (`tui --workspace <dir>`; without a workspace
they stay literal text). Discovered metadata is served at `GET /api/skills`,
`GET /api/commands` and `GET /api/workspaces/{id}/files` (never bodies).

#### Built-in commands

First-party commands ship with the product and work in the web composer, the
TUI `/` picker, the `chat` REPL and `POST /api/runs` alike. They come in two
kinds, and the distinction is honest on every surface:

- **Prompt commands** expand to a normal task and are submitted like a
  discovered template: `/plan <objective>` (agree a plan before changing
  anything), `/goal <objective>` (set the session goal and its success
  criteria) and `/feedback [notes]` (turn operator feedback on the last turn
  into follow-up work). These are built with `consult` cooperation mode and
  expand `$ARGUMENTS` exactly like a `<name>.md` template. A missing required
  argument is a usage error (`usage: /plan <objective>`), never an empty turn.
- **Action commands** are performed by the surface and are never submitted as
  a task: `/compact` (summarize older context in place), `/export [path]`
  (session as Markdown), `/permission` (approval policy and tool scopes),
  `/status` (run/context/session status), `/mode [consult|work]` (cooperation
  mode), `/new` (fresh session) and `/help` (commands and shortcuts). Web and
  TUI perform these locally; the `chat` REPL performs the ones that make
  sense in a line REPL (`/compact`, `/export`, `/status`, `/permission`,
  `/mode`, `/help`) and refuses the rest with an explanation. Submitting an
  action command as a run (`POST /api/runs` with `task: "/compact"`) is a 400
  that points at the surface action; use `POST /api/sessions/{name}/compact`
  where a client has no local compaction.

Names resolve case-insensitively, include English synonyms and the reference
Chinese spellings (`目标`, `计划`, `反馈`, `压缩`, `权限`, `导出`) as
searchable aliases in the pickers, are ordered by priority, and ship
canonically in `GET /api/commands`. Only ASCII spellings are typeable — the
shared slash parser's ASCII name rule governs the REPL, the TUI and
`POST /api/runs`, and the web/TUI answer a typed non-ASCII alias with a
canonical-spelling notice instead of sending it. A discovered `<name>.md`
template with the same name shadows the built-in (deepseek-harness's "exact
name wins" rule), so an operator can override `/plan` locally. The catalogue
is served, metadata only, at `GET /api/commands` (`baseCommands`).

### `sessions`

List the JSONL session files of a sessions directory (default `sessions`)
with readable titles derived from the first operator message, envelope counts
and the last-modified time. Mostly read-only: listing, `show`, `search` and
`export` never change a file; `sessions fork` creates a new session file (the
source is never modified), `sessions undo` previews, applies or discards a
run's workspace undo record (a preview and a discard change no session file)
and `sessions rewind` rewrites one. The store keeps the legacy flat layout
until `sessions migrate` switches it to project/session directories; every
read path accepts both ([Session storage](session-storage.md)). A read also
tolerates a crash-torn final line: `sessions search` (and the web search
corpus, detail and export routes) load through the torn-tail-aware reader,
which ignores only the incomplete trailing fragment, and the search document
carries additive `recovered`/`dropped_bytes`. The CLI `sessions`/`sessions
show` listing and export never fail on such a file either — they summarize or
render every complete envelope and skip the unparseable line (the listing's
`error` field reports `corrupt line N`). None of them rewrites the file; only
`--resume` (and the explicit `fork`/`rewind`/compaction writers) touch it — see
[Sessions](#sessions).

```powershell
node dist/cli.js sessions [--sessions-dir sessions] [--limit N] [--json]
node dist/cli.js sessions show <name> [--limit N] [--json]
```

`sessions --json` prints one JSON array with one flat object per session, keys
in this order: `{name, title, envelopes, updated, error}` — `name` keeps the
`.jsonl` suffix, `updated` is local `YYYY-MM-DD HH:MM`, and `error` is `null`
or a message such as `corrupt line 3`. An empty or missing directory prints
`[]` and exits 0.

`sessions show <name>` prints the session summary (`session:`, `title:`,
`envelopes:`, `updated:`, an `error:` line only when the file has corrupt
lines) and one render line per protocol envelope
(`seq from -> to kind — preview`). The name resolves with or without the
`.jsonl` suffix. `sessions show <name> --json` prints one JSON object with the
same summary fields plus `events` (the envelope array):

```
{name, title, envelopes, updated, error, events}
```

`--limit N` caps the listed rows (`sessions`) or the envelopes printed/shown
(`show`, in both human and JSON output; `envelopes` stays the total). An
unknown session or a missing name is a usage error (exit 2); an unreadable
session file exits 1.

#### `sessions search <query>`

Full-text search across a sessions directory: session titles plus every
envelope's payload strings (operator tasks, proposals, reviews, decisions).
Matching is a case-insensitive literal substring; JSON keys and envelope
metadata are never matched, and whitespace is collapsed on both sides, so a
multi-line payload still matches a one-line query.

```powershell
node dist/cli.js sessions search "valkey migration"
node dist/cli.js sessions search "rollback" --json --limit 5 --sessions-dir sessions
```

Human output starts with `N matches in M sessions`, then one
`<session>  <field>  <snippet>` line per hit (`field` is `title`, `message` or
`decision`; the snippet is one bounded line centered on the match). `--json`
prints the exact result object:

```json
{"query": "rollback", "scanned_sessions": 4, "truncated": false,
 "hits": [{"session": "20261106-120000.jsonl", "title": "Plan a migration",
           "field": "message", "seq": 9, "role": "senior", "kind": "decision",
           "snippet": "…the rollback plan…", "ts": "2026-11-06T09:00:00Z"}]}
```

Sessions are read newest-first up to the scan caps (200 sessions, 2 000
envelopes each) and at most 3 hits are returned per session. `--limit N`
caps the total hits (1–100, default 20); `truncated: true` means a cap
dropped a real match. A missing directory searches nothing (`0 matches in 0
sessions`, exit 0); a query shorter than 2 characters is a usage error
(exit 2); corrupt session files are skipped, never fatal. No matches prints
`no matches` and exits 0.

#### `sessions export <name> [--format markdown|json|html] [--output <path>]`

Render one session for reading, sharing or archival. The default format is a
Markdown transcript: a header (`# <title>`, session name, workspace, updated
and exported timestamps, envelope count) followed by one
`## <seq>. <from> → <to> · <kind>` section per envelope with its timestamp and
a readable payload (message text verbatim; structured payloads as bullet
fields; nested values as JSON). Each payload is bounded to 20 000 characters
with an explicit truncation marker. `--format json` prints a stable pretty
object `{name, title, workspace_id, updated, exported_at, envelopes}` with the
envelopes verbatim. `--format html` prints one self-contained HTML page:
inlined CSS, escaped title/metadata and payloads (hostile markup stays text,
ANSI/control bytes are stripped), one section per envelope, and no scripts,
links or external URLs. It uses the same 20 000-character per-payload cap plus
a 2 000 000-character whole-document cap; when that cap drops envelopes the
page says `Document truncated … showing N of M envelopes` and stays
well-formed (the JSON export is the complete form).

```powershell
node dist/cli.js sessions export session --sessions-dir sessions           # Markdown to stdout
node dist/cli.js sessions export session --format json --output out.json   # write a file
node dist/cli.js sessions export session --format html --output out.html   # self-contained page
```

The name resolves with or without the `.jsonl` suffix; the `--format` value is
case-insensitive. `--output <path>` writes the body to that file and prints
`wrote <abs path>` on stderr; `--output -` keeps stdout. A missing session or
an unwritable output path exits 1; an unknown format or a missing name is a
usage error (exit 2).

#### `sessions fork <name> [--at <seq>] [--name <new>]`

Copy a session (or its first `--at` envelopes) into a new session file, for
"what-if" branches that keep the original run untouched. The copy is a prefix
of the source JSONL, so the envelope bytes and the dense `seq` numbering are
unchanged; the new session's `.meta.json` sidecar gets an additive
`parent: {name, seq}` lineage link and a `<source title> (fork)` title (bounded
to 80 characters). `--name` must be one portable file name (no path
separators); without it the smallest free `<source>-fork-<k>` is used, and an
existing session is never overwritten. The source file and its sidecar are
never modified. The CLI prints the new session name (with `--json`, the full
`{name, title, events, forked_from}` object). A missing source, an out-of-range
`--at`, an invalid or taken `--name` or a write failure exits 1; a
non-numeric `--at` is a usage error (exit 2).

```powershell
node dist/cli.js sessions fork session                       # session-fork-1.jsonl
node dist/cli.js sessions fork session --at 4 --name branch-a
node dist/cli.js sessions fork session --json
```

#### `sessions rewind <name> --turns <n>`

Drop the last `n` operator turns (each operator task plus every envelope the
brothers produced for it) from a persisted session, so a better task can be
retyped without a growing context or a new session file. `--turns` is a strict
integer 1–100; a request deeper than the session holds is clamped honestly at
the session start. A compaction summary is a hard floor: everything the
summary covers is kept and the cut reports `stopped_at_compaction` /
`stops_before`, so after a compaction rewind keeps the summary and the
original `[[TASK]]` head rather than "replacing" the first task. The kept
prefix is rewritten atomically (temp file + rename) with its dense `seq`
intact, so `--resume` keeps working. A successful rewrite also clears the
session's runtime-event sidecar (`sessions/runtime/<name>.jsonl.events.jsonl`
in the flat layout, `<project>/<stem>/events.jsonl` after migration):
tool and approval history for the removed runs is gone, while the kept
transcript remains. A cut that removes nothing is a success that reports the
honest reason. A missing or corrupt session exits 1; a bad `--turns` is a
usage error (exit 2). `--json` prints the full cut object (`rewritten`,
`kept`, `removed`, `turns`, `requested_turns`, `stopped_at_compaction`,
`stops_before`, `reason`, `runtime_events_cleared`).

```powershell
node dist/cli.js sessions rewind session --turns 1
node dist/cli.js sessions rewind session --turns 2 --json
```

#### `sessions undo <name> [--run <id>] [--apply | --discard] [--json]`

Preview, apply or discard the run-scoped workspace undo record a
workspace-bound `serve` run left under `<sessions>/undo` — the CLI counterpart
of `GET`/`POST`/`DELETE /api/sessions/{name}/undo/{run_id}`. The server does
not need to be running: the record and the session's workspace link
(`<name>.meta.json` → `workspaces.json`) are persisted. Without `--apply` or
`--discard` the command previews only and touches nothing; without `--run` it
selects the newest record whose recorded session is `<name>`.

The preview prints one row per mutated file with its action and its status
against the live workspace (`applicable`, `created`, `deleted`,
`changed-since`, `skipped`, `missing`) plus a counts footer. `--apply` restores
write/edit pre-images and deletes files the run created, re-classifying each
file immediately before it is touched so a file changed since the run is
refused rather than overwritten; per-file rows report `applied`, `refused` or
`failed` with the driving preview status. `--discard` removes the record and
collects blobs no surviving record references, without touching the workspace.
`--json` prints the stable object shapes: preview
`{session, run_id, workspace_root, created_at, statuses, counts, omitted?}`,
apply `{session, run_id, workspace_root, applied, refused, failed, files, counts, omitted?}`,
discard `{discarded, session, run_id, blobs_removed?, gc_diagnostics?}`.

```powershell
node dist/cli.js sessions undo session                              # preview the newest record
node dist/cli.js sessions undo session --run run-abc123 --apply
node dist/cli.js sessions undo session --run run-abc123 --discard
```

CLI/TUI runs never capture, so this surface only reports records made by
`serve`; shell-made changes, external edits, untracked files and file
mode/ownership changes outside the recorded bytes are out of scope exactly as
in the API. A missing session, no record for the selected run, an unregistered
workspace link or a record from another workspace exits 1, and a per-file
`failed` also exits 1 (refusals alone exit 0 — the report is the honest
result). A missing name, an unexpected argument, `--apply` combined with
`--discard` or a malformed `--run` is a usage error (exit 2).

#### `sessions migrate [--dry-run] [--force] [--json]`

Move flat `<sessions-dir>/<name>.jsonl` sessions into the project/session
directory layout (`<project>/<stem>/session.jsonl` plus `meta.json` and
`events.jsonl`) and write `.layout.json` so new sessions follow it. The move is
copy-first and idempotent: an identical target is adopted, a different target
(session bytes or either sidecar) is a conflict that keeps the flat source and
exits 1; the marker is written only when the pass has no conflicts or errors.
`workspace_id` metadata groups a session under its registered workspace path,
and unlinked sessions use `_global`.

Migration takes the store's **single-writer lock**. Stop `serve` and the TUI
first: while either holds the lock the command refuses, because a live process
could keep appending to a transcript that is being moved. `--force` bypasses
the lock (unsafe; only for a known-stale store). A missing `--sessions-dir`
is an error, not an empty store.

```powershell
node dist/cli.js sessions migrate --sessions-dir sessions --dry-run
node dist/cli.js sessions migrate --sessions-dir sessions --json
node dist/cli.js sessions migrate --sessions-dir sessions --force
```

`--dry-run` prints the plan without touching disk. `--json` prints
`{dryRun, layout, entries[]}` where `layout` is the resulting layout (`dirs`
on a clean dry run) and each entry is
`{name, sourcePath, targetPath, status, detail?}`; `status` is `migrated`,
`already`, `conflict` or `error`. See [Session storage](session-storage.md)
for the two layouts, compatibility rules and the backup caveat.

### `spill`

Inspect and prune the tool-output spill store at `<sessions-dir>/spill` (the
same root `serve` and the TUI use). Spilled files are described in
[Tool-output spill](spill.md); nothing is deleted automatically by default.

```powershell
node dist/cli.js spill stats [--sessions-dir <dir>] [--json]
node dist/cli.js spill gc [--sessions-dir <dir>] --older-than <n>m|h|d [--dry-run] [--json] [--force]
```

`spill stats` is read-only and prints the count and total bytes of valid
`<id>.txt` artifacts (or `no spill files in <root>`); a missing root is an
empty store (exit 0). An existing root that is a symlink/junction or not a real
directory is refused (exit 1) instead of being followed, and gc-only flags
(`--older-than`, `--dry-run`, `--force`) are a usage error (exit 2). `spill gc`
deletes valid artifacts whose mtime is strictly older than `--older-than`,
which is **required** and uses a positive integer with `m` (minutes), `h`
(hours) or `d` (days) — a missing or malformed value is a usage error (exit 2),
so there is no accidental delete-everything default. `--dry-run` reports the
same counts and deletes nothing. `gc` takes the sessions-store single-writer
lock and refuses while `serve`/the TUI holds it (the holder is named);
`--force` bypasses the lock (unsafe while it runs). A missing sessions
directory is an empty store and is not created.

| Option | Default | Description |
|---|---|---|
| `--sessions-dir` | `sessions` | sessions directory whose `spill/` subdirectory is inspected |
| `--older-than` | (required for `gc`) | positive age with a unit: `30m`, `24h`, `7d`; files strictly older than now minus this age are deleted |
| `--dry-run` | off | `gc`: report what would be removed without deleting anything |
| `--force` | off | `gc`: bypass the sessions-store single-writer lock (unsafe while `serve`/TUI is running) |
| `--json` | off | `stats`: `{root, files, bytes}`; `gc`: the prune counts (`removed`, `kept`, `bytes`, `failed`, `files_before`, `files_after`, `temps_removed`, `temp_bytes`, `dry_run`, `older_than`, `older_than_ms`, `root`, `errors`) |

Only regular files directly under the root whose names are exactly
`<valid-id>.txt` (lowercase hex id, 16–64 characters) are artifact candidates.
Symlinks are `lstat`ed and skipped (never followed), as are directories,
malformed ids and temp names outside the exact `.tmp-<id>` shape. `prune` may
also remove a stale regular `.tmp-<id>` save file whose mtime is strictly older
than the cutoff; those are reported separately (`temps_removed`, `temp_bytes`)
and never counted as artifacts. An unlink failure is reported as a warning and
counted (`failed`); the rest of the pass continues and the command exits 1 when
any file could not be removed.

### `doctor`

Local, read-only diagnostics: one `[pass]` / `[warn]` / `[fail]` / `[skip]`
line per check, in this order — Node engine (the package's `>= 22.19` floor),
settings file (`<sessions-dir>/settings.json`), sessions-directory
writability, per-role provider configuration (kind, base URL, model, key
presence), the provider endpoint (`GET {base-url}/models`; skipped for
`mock`), built web assets, the `<cwd>/plugins` directory, the TUI keys file,
the TUI prompt history file and the MCP config named by
`TWO_BROTHERS_MCP_CONFIG`. API keys are never printed. The endpoint probe is
bounded by `--timeout` (seconds, default 5) and only runs for `openai`.

The two TUI rows are read-only and content-blind: `tui-keys` resolves the same
file the TUI uses (`--keys-file` origin is not available to `doctor`, so
`TWO_BROTHERS_TUI_KEYS_FILE` or `~/.two-brothers/tui-keys.json`), and
`tui-history` reads `TWO_BROTHERS_TUI_HISTORY_FILE` or
`~/.two-brothers/tui-history.json`. An absent default file passes (defaults
active / prompt history is optional); a missing explicitly named file, invalid
JSON, an unsupported version, an oversized file or an unreadable path warns
with only the first bounded resolver diagnostic — the file itself is never
dumped, and no chord or prompt text is echoed.

The `mcp-config` row reads the file named by `TWO_BROTHERS_MCP_CONFIG` (the
same env the `run`/`chat`/`tui`/`serve` paths now honor; the flag wins when
both are set) and validates only its top-level shape: well-formed JSON with an
`mcpServers` object. It never starts a server, never makes a network call and
never prints a spec value (command, args, URL, env or header value) — only the
resolved path, the server count and the server names. Unset/blank is a `skip`
(`TWO_BROTHERS_MCP_CONFIG not set`, not a failure); a missing, unreadable, invalid-JSON or
wrong-shape file is a `warn` with one bounded reason; a valid file passes with
`N servers: …` (names sorted, at most eight listed). A warning never fails the
report.

Exit code: `0` when no check failed, `1` when at least one check failed, `2` on
a usage/config error. Warnings (a missing settings file or plugins directory,
absent web build) never fail the report.

```powershell
node dist/cli.js doctor
node dist/cli.js doctor --provider mock
node dist/cli.js doctor --json --sessions-dir sessions --timeout 10
```

`--json` prints one JSON object on stdout and keeps the same exit semantics:

```json
{"ok": true, "checks": [{"id": "engine", "label": "Node engine", "status": "pass", "detail": "v22.19.0"}]}
```

`ok` is `false` iff some check has status `fail`; `status` is one of
`pass`/`warn`/`fail`/`skip`. Provider flags (`--provider`, `--provider-kind`,
`--senior-kind`, `--junior-kind`, `--base-url`, `--api-key`, the four
per-role endpoint flags, `--senior-model`, `--junior-model`) resolve exactly
like `run`, so the report describes the run configuration.

### `config`

Print the resolved configuration without making a model call. Per role it
shows the provider, wire kind, base URL, model and API-key presence, each with
the layer that supplied it, in this precedence order:

`flag > role env > shared env > preset > settings > default`

```powershell
node dist/cli.js config
node dist/cli.js config --json
node dist/cli.js config --provider openai --base-url https://api.deepseek.com/v1 `
  --senior-model deepseek-chat --junior-model deepseek-chat
```

The human output is an aligned table with a `source` column (`flag
--senior-model`, `role env TWO_BROTHERS_SENIOR_MODEL`, `shared env
TWO_BROTHERS_BASE_URL`, `preset deepseek`, `settings <dir>/settings.json`,
`default`), followed by the cooperation mode, sessions directory,
plugin/skills/commands roots, compaction mode and thresholds, and the
max-tokens/retries/timeout limits. `--json` prints one stable object
(`schema: "two-brothers.config/1"`) with the same information plus the
env-pinning notes. **API keys are only ever reported as `set` / `not set` — a
key value is never printed.**

The flag/env layers resolve exactly like `run`; the preset/settings layers are
read from `<sessions-dir>/settings.json` (the store `serve`/`onboard` use), so
the table also explains what the web path would use. `run`/`chat` themselves
resolve flags and `TWO_BROTHERS_*` env only; `serve` and the TUI additionally
read this store — the TUI re-resolves it before every turn and its `/provider`
writes it. Exit codes: `0`
success, `2` usage/config error (unknown option, invalid flag value, unknown
`--mode`).

### `completions`

Print a shell completion script generated from the same command/flag catalog
as `help --all`, so the script never drifts from the CLI. Supported shells:
`bash`, `zsh`, `fish`, `powershell`.

```powershell
node dist/cli.js completions bash        # a complete -F hook
node dist/cli.js completions zsh         # #compdef script (fpath-installable)
node dist/cli.js completions fish        # complete -c rules
node dist/cli.js completions powershell  # Register-ArgumentCompleter -Native (PowerShell 7+)
```

A missing or unknown shell is a usage error (exit 2) that lists the valid
shells; an unknown option suggests the nearest known flag. Save the output
where your shell expects it (e.g. `_two-brothers` in a zsh `$fpath` directory,
`~/.config/fish/completions/two-brothers.fish` for fish); under PowerShell
redirect with `Out-File -Encoding utf8`.

### `selftest`

Offline check of the protocol, provider, and loop. Prints `SELFTEST: PASS` and
returns 0.

```powershell
node dist/cli.js selftest
```

### `serve`

Run the web workspace backend. Serves the API on `:8600` and the built
workspace at `/` (repo `web/dist` in a checkout; the packaged `web/` copy in
the npm tarball).

```powershell
# from packages/harness/ after npm run build
node dist/cli.js serve [--host 127.0.0.1] [--port 8600] [--sessions-dir sessions]
node dist/cli.js serve --approval-mode readonly           # pin the mode for these web runs
```

| Flag | Default | Description |
|---|---|---|
| `--host` | `127.0.0.1` | bind address |
| `--port` | `8600` | port |
| `--sessions-dir` | `sessions` | directory of JSONL session files to expose |
| `--workers` | (runtime default) | background run workers (env `TWO_BROTHERS_WORKERS`) |
| `--spill-retention-days` | (off) | prune `<sessions-dir>/spill` files older than this many days once after a successful bind; the server already holds the writer lock, a failed bind prunes nothing, and a prune failure only logs a skip line and never fails startup. Off by default: spill files are otherwise only deleted by an explicit `spill gc` |
| `--approval-mode` | `ask`, `readonly`, `edits`, `allow-all` | `ask` | pin the [approval mode](#approval-modes) for every run this server starts (env `TWO_BROTHERS_APPROVAL_MODE`); the pin is in-memory only and never persisted — without it the saved `approval_policy` setting applies |

Web runs also honor the shared compaction flags (`--compact`,
`--compact-threshold <chars>`, `--compact-threshold-tokens <n>`,
`--compact-keep-recent <chars>`, `--context-window <n>`, and their
`TWO_BROTHERS_COMPACT*` env vars): the resolved run config feeds every web run
and the manual `POST /api/sessions/{name}/compact` budgets. Without any of them
web runs never auto-compact — exactly the CLI's "unset means off" behavior.

`serve` traps `SIGINT`/`SIGTERM` and, on POSIX, `SIGHUP`: each runs the graceful
shutdown — stop accepting connections, cancel queued/running/waiting runs with
pending approvals denied, wait a bounded 5 s grace (`SERVE_SHUTDOWN_GRACE_MS`)
for in-flight runs to unwind, then end SSE and close. Shutdown is idempotent:
a repeated signal is ignored rather than force-exiting, and `serve` has no
second-signal force path. Flushed session JSONL is never rewound, so a shutdown
loses no recorded history.

The backend is a **local single-user workspace server**. API overview (paths
below describe the flat layout; a migrated store keeps the same session names
but stores `meta.json` and `events.jsonl` inside
`<project>/<stem>/` — see [Session storage](session-storage.md)):

| Endpoint | Purpose |
|---|---|
| `GET /api/workspaces`, `POST /api/workspaces`, `DELETE /api/workspaces/{id}` | registered workspace directories (register/unregister; sessions are untouched); `GET` returns the operator order |
| `GET /api/workspaces/{id}/files?q=&limit=` | bounded file index of one workspace for the composer `@` picker (`{workspace_id, files: [{path, size, mtime}], truncated, total}`; forward-slash relative paths, hidden/node_modules/sensitive/symlink entries excluded, `limit` 1–200 default 50; 404 unknown workspace) |
| `PATCH /api/workspaces/{id}` | rename one workspace (`{"name": "..."}`; trimmed and capped at 120 characters, unchanged order; 400 for a blank name, 404 for an unknown id) |
| `PUT /api/workspaces/order` | persist the operator's workspace order (`{"ids": ["id1", ...]}` must be an exact permutation → `{"workspaces": [...]}`; 400 for duplicates/unknown/missing ids) |
| `GET /api/sessions` | list sessions (`?workspace_id=` filters); titles/workspace links from `<name>.meta.json` sidecars |
| `GET /api/search?q=&limit=` | full-text search over session titles and envelope payload strings; returns `{query, scanned_sessions, truncated, hits[]}`; `q` shorter than 2 characters is a 400 |
| `GET /api/sessions/{name}/export?format=markdown\|json\|html` | download one session as Markdown (default), JSON or one self-contained HTML page with `Content-Disposition: attachment` (the HTML page inlines its CSS, escapes payloads and has no scripts/links; markdown/json stay byte-identical to the pre-wave-23 exporter); 404 for an unknown session, 400 for an unknown format (`format must be markdown, json or html`) (HEAD supported) |
| `POST /api/sessions` | create a session (`{"title"?, "workspace_id"?}`) |
| `PATCH /api/sessions/{name}` | rename a session (set a readable title) |
| `DELETE /api/sessions/{name}` | delete a session — the JSONL, its `<name>.meta.json` and the runtime sidecar (`200 {"deleted": name}`; 404 on unknown) |
| `GET /api/sessions/{name}` | all protocol envelopes of one session |
| `GET /api/sessions/{name}/events` | runtime sidecar events (tool calls, approvals) for browser reload |
| `POST /api/sessions/{name}/compact` | compact the session in place on demand: the older context is summarized by the configured summarizer role (senior by default) and the session JSONL is rewritten with dense `seq`, so a reload shows the summary. `200 {"compacted": true, "before_events": N, "after_events": M}`; `200 {"compacted": false, "reason": "nothing to compact"}` when there is nothing to cut; 404 unknown session, 400 invalid session name, 409 while a run for that session is active or another compaction is already running, 422 when the session file is unreadable/corrupt, and 502 with the provider message (nothing written) when summarization fails. A run submitted for a session while it is being compacted is a 409 (`a compaction is in progress for this session; retry in a moment`) — the two operations are mutually exclusive so a run's envelopes can never be lost to the rewrite. The summarizer budgets follow the resolved run config (`--compact-*`/`TWO_BROTHERS_COMPACT*`), an explicit `ServerOptions.compaction` still wins, and a client disconnect aborts the provider call and releases the session |
| `POST /api/sessions/{name}/fork` | copy a session (or its first `seq` envelopes) into a NEW session file, for "what-if" branches. Body `{seq?: integer, name?: string}` (both optional; `seq` defaults to the whole session). `201 {name, title, events, forked_from: {name, seq}}`; the copy is a byte-exact prefix (dense `seq` preserved), the new sidecar gets `forked_from`'s `parent` lineage link and a `<source title> (fork)` title, and the source is never modified. Errors: 400 invalid `seq`/`name`, 404 unknown source, 409 name taken or a live run/manual compaction on the session (`a run is active for this session; stop it before forking it` / `a compaction is in progress for this session; retry in a moment`), 422 corrupt source, 500 unwritable sessions directory (a partial file is rolled back) |
| `POST /api/sessions/{name}/rewind` | drop the last `turns` operator turns (each task plus every envelope produced for it) from a persisted session. Body `{turns}` strict integer 1–100. `200 {name, rewritten, kept, removed, turns, requested_turns, stopped_at_compaction, stops_before, reason, runtime_events_cleared, runtime_events_clear_error?}` — `rewritten: false` with a `reason` when there is nothing to cut (not an error). The kept prefix is rewritten atomically with dense `seq` intact, and a successful rewrite clears the session's runtime-event sidecar (`sessions/runtime/<name>.jsonl.events.jsonl`): tool/approval history for the removed runs is gone, while the kept transcript remains (`runtime_events_cleared` says whether the sidecar was cleared; a clear failure is disclosed instead of pretending success). Harness-generated context (compaction summaries, repair requests, operator steers, skill/file blocks) is never counted as a turn, and a compaction summary is a hard floor (`stopped_at_compaction`/`stops_before` report an honest clamp). Errors: 400 non-integer/out-of-range depth, 404 unknown session, 409 a live run/manual compaction or a session changed during the read+rewrite CAS, 422 corrupt session, 500 failed rewrite |
| `GET/POST/DELETE /api/sessions/{name}/undo/{run_id}` | run-scoped workspace edit undo (wave 23) over the persisted `<sessions>/undo` side artifact (survives a backend restart). `GET` previews every file the run mutated against the LIVE workspace as `{session, run_id, statuses, counts, workspace_root, created_at, omitted?}` with per-file status `applicable` / `created` / `deleted` / `changed-since` / `skipped` / `missing`; `POST` applies only the reversible entries (each file is re-classified immediately before it is touched, so a file changed after the preview is refused, never overwritten) and returns `{session, run_id, workspace_root, applied, refused, failed, files, counts, omitted?}` with per-file `applied`/`refused`/`failed` + the driving `preview_status`; a restored POSIX file also regains its captured mode (and ownership only where the process may set it) with `mode_restored`/`ownership_restored` disclosed per file — a best-effort failure keeps the byte restore `applied`; `DELETE` discards the record and collects blobs no surviving record references, returning the additive `blobs_removed?` count and `gc_diagnostics?` (a shared content-addressed blob survives until its last record is gone). Records are bounded: the newest 20 per session and records older than 30 days are pruned when a capture closes, and active runs are never pruned. Only workspace-bound `serve` runs capture (recorder fail-soft and closed in the run's `finally`); shell-made changes and untracked files are out of scope. Errors: 404 unknown session or no undo record for the run, 409 while a run for that id is still active in memory or the record is unusable (corrupt/oversized/unsupported version, or its recorded workspace is no longer registered — the record is matched to a registered workspace by canonical path on every request), 422 unexpected store IO |
| `GET /PUT /api/settings` | per-role Senior/Junior provider/model/base URL/API key (keys are write-only; responses show `api_key_set` only). Both carry the additive top-level `approval_policy` section for the [approval mode](#approval-modes): `GET` returns `{mode, pinned}` (the effective mode, and whether a `serve` flag/env pin overrides the persisted one), `PUT` accepts `{"approval_policy": {"mode": "ask\|readonly\|edits\|allow-all"}}` — a strict enum (400 for an unknown mode, 500 if the atomic settings write fails, absent leaves the persisted mode untouched) and returns the same view. The mode is stored in `sessions/settings.json`; a per-run flag/env pin is never written there. Both directions also carry the additive top-level `compaction` section: `GET` returns `{threshold_chars, threshold_tokens, keep_recent_chars, context_window}` as per-field `{persisted, effective, source}` (`source` is `options`/`flag`/`persisted`/`preset`/`absent`; `effective` 0 means not configured, so the harness default still applies) plus `force` (the config/options one-shot `--compact`; a persisted force is deliberately out of scope) and `pinned` (a flag/env or `ServerOptions` owns at least one field); `PUT` accepts the budget object (non-negative integers; `0` means off for a threshold and unknown for the context window; unknown keys, non-integers and negatives are a `400` before any mutation, a failed atomic write is a `500`, a present section replaces the stored section wholesale and `{}` clears it, and an absent section leaves it untouched), returning the refreshed view. The persisted section is one layer of the run's compaction precedence: an explicit `ServerOptions.compaction` wins wholesale, then an explicitly-set non-zero `--compact*` / `--context-window` flag or `TWO_BROTHERS_COMPACT*` / `TWO_BROTHERS_CONTEXT_WINDOW` env field (provenance-tracked, so the 40 000 keep-recent default never shadows a saved value), then the saved section, then the smaller of the two resolved provider-preset `context_window` values (only for `context_window`; `source: "preset"`), then absent. A per-run flag/env pin is never written to the file; the view reports it instead of pretending a save took effect |
| `POST /api/runs` | start a background run (`{"task", "mode"?, "session"?, "provider"?, "workspace_id"?, "stream_tokens"?}` → `202 {"run_id", "session", "status"}`); an omitted `workspace_id` inherits the session's linked workspace from its metadata sidecar (an explicit value wins, and either id must be registered); a leading `/name` command is expanded and `@skill:`/`@file` mentions are attached before the run (see [Composer mentions and slash commands](#composer-mentions-and-slash-commands)); `stream_tokens: true` additionally streams live `token` frames on the run SSE endpoint (strict boolean, default off); runs are FIFO — one active, the rest `queued`, so a submission for a session that already has a live run is still accepted (`202` with `status: "queued"`) and starts after the earlier one finishes |
| `GET /api/runs`, `GET /api/runs/{run_id}` | list runs / run status (`queued`/`running`/`waiting`/`completed`/`failed`/`cancelled`); records carry a per-run `usage` object (`model_calls`, `input_tokens`, `output_tokens`, `cached_tokens`, `cache_write_tokens`, and the optional normalized `prompt_tokens` for Anthropic/Gemini; live counters update after each cooperation node, zeros only before the first call) plus an additive `cost` object (`{currency: "USD", total, model}` or `null` — computed at run completion, recomputed from the persisted usage for sidecar-rebuilt terminal records, and `null` when the usage cannot be attributed to one priced model). Records also carry, additively, `steering_pending` (steering texts waiting for the run's next step, present only while live and non-empty) and `steering_dropped` (`dropped` texts discarded at the per-run envelope cap; present only when > 0) |
| `POST /api/runs/{run_id}/stop` | cooperative stop (pending approvals are denied); a `queued` run is marked cancelled immediately, without waiting for a worker |
| `POST /api/runs/{run_id}/steer` | mid-run operator steering: queue `{"text": "..."}` for an ACTIVE run — `running`, or `waiting` on an approval (applied at the next step after it resolves). Accepted `200 {"run_id", "status", "pending"}` (`pending` = steering texts now waiting, 1–8); the text is trimmed, must be non-empty and at most 4 000 characters (`400` otherwise; a non-string `text` is the standard `400 invalid request body`), an unknown run is `404`, and a queued/terminal run or a full pending queue is an honest `409` (the detail names the run's status, or `steering queue is full …`). Acceptance emits **no** event: the steer is appended to the shared context as an ordinary `user`→`senior` `message` envelope (payload text prefixed `[[OPERATOR STEER]] `) when the harness reaches the next node boundary/tool-loop iteration, so SSE consumers see the normal `envelope` frame with its dense `seq` at that moment. Pending steering is in-memory only: a stopped run appends nothing more and drops what was queued, and a backend restart loses the queue (`404` for the run id) |
| `GET /api/runs/{run_id}/events?after=N` | SSE of typed runtime events (`run_status`, `envelope`, `tool_started`, `tool_completed`, `approval_requested`, `approval_resolved`, `approval_auto_allowed`, `approval_auto_denied`, `todo_updated`, `prompt_audit`, `reasoning`, `usage`, `steering_dropped`, `run_error`, `run_end`); reconnectable via `after`. `approval_requested` additively carries `reason` and a bounded `detail` (`{kind, diff?, addedLines?, removedLines?, command?, truncated?}` preview) when the request has one; `todo_updated` carries the model's complete sanitized plan snapshot; `steering_dropped` carries `{dropped, applied, limit}` when a 200-accepted steer later hit the per-run envelope cap. When the run was started with `stream_tokens`, the same stream additionally carries ephemeral named `token` frames (`event: token`, data `{type, run_id, role, kind: "text"\\|"thinking", delta, at}`) with no SSE id — they are live-only, never persisted and never replayed |
| `GET /api/runs/{run_id}/approvals`, `POST /api/runs/{run_id}/approvals/{id}` | list/answer pending operator approvals (`{"allow": bool, "scope"?: "once" \| "session"}` → `{approval_id, decision, scope}`; `scope` defaults to `once`, an invalid value or `session` with a deny is a 400, an unknown/already-resolved approval id is a 404). See the session-scope paragraph below |
| `GET /api/providers`, `POST /api/providers`, `PUT /api/providers/{seed}`, `POST /api/providers/{name}/reset`, `POST /api/providers/{name}/discover`, `DELETE /api/providers/{name}` | provider presets (the curated seed table: hosted providers, subscription plans, LM Studio, custom). `GET` returns `{name, base_url, api_key_set, kind, models}` plus additive `seed` (the name comes from the built-in seed table) and `customized` (a stored override of that name exists), so a client can tell a pristine seed from an edited/custom entry; a positive preset `context_window` (tokens, used only as a compaction fallback) is exposed additively, while `0`/absent stays unknown and omitted so pre-wave presets keep the exact old shape. `POST` creates a custom provider (409 on a duplicate name, including a seed name); `PUT` updates it, and on a seed name materializes a stored override (blank `base_url` is a 400); both accept `context_window` as a positive safe integer; an explicit `0` clears it, an absent/null field on an update leaves the stored value untouched (a create starts without one), and negative/float/string/boolean/unsafe values are a `400` before any write; `DELETE` removes a stored preset/override and clears any role `provider_ref` that pointed at it (a pristine seed is a 404); `POST /api/providers/{name}/reset` restores a customized built-in seed without clearing role references (see below); `POST /api/providers/{name}/discover` probes a draft endpoint for its model list without saving (see the discovery paragraph below). Keys are never returned — responses carry `api_key_set` only. The Settings → Providers tab is the operator UI for these routes |
| `GET /api/plugins` | discovered plugins (`name`, `description`, `roles`, load `errors`, `diagnostics`) |
| `GET /api/skills` | discovered skills metadata (`name`, `description`, `scope`, `tools`, `file`) — never bodies |
| `GET /api/commands` | discovered slash-command metadata (`name`, `description`, `argumentHint`, `mode?`, `file`) plus the additive first-party `baseCommands` list (`name`, `aliases`, `description`, `argumentHint`, `kind: "prompt"\|"action"`, `action?`, `requiresArguments`, `priority`) — never bodies |
| `GET /api/fs/browse` | browse the filesystem for workspace registration (UI helper) |
| `POST /api/run` | legacy synchronous run (body `{"task", "mode"?, "session"?, "provider"?, "workspace_id"?}` → `{"session", "events", "decision"}`); an omitted `workspace_id` inherits the session's linked workspace exactly like `POST /api/runs` (an explicit value wins and must be registered), and the effective workspace supplies the tool belt; slash commands and mentions are expanded the same way, but there is no token streaming or approval channel, so a mode that still asks fails closed for mutating tools |
| `GET /api/stream?session=<name>` | legacy SSE tail of a session file |

**Settings file schema.** `sessions/settings.json` carries a top-level
`"version": 1` on every write (`SETTINGS_SCHEMA_VERSION`). A file without a
version — or with a non-integer/negative one — is treated as legacy: it reads
exactly as before and the next save normalizes it to version 1. `GET
/api/settings` reports the additive `schema` object `{version, supported,
writable}` where `version` is the stored integer (or `null` for a legacy,
invalid or unreadable file), `supported` is `1`, and `writable` is false for a
document from a newer release or one that exists but cannot be read. Such a
future-version document still reads its known
role/plugin/provider/approval/compaction sections and `GET` keeps working, but
every settings write (role/plugin/provider saves, approval policy, compaction,
session approvals, and session deletion's approval clear) is refused with HTTP
409 and the typed `SettingsSchemaVersionError` detail instead of downgrading
the file; upgrade Two Brothers or restore a backup. An existing-but-unreadable
file is reported with the additive `readable: false` and `reason` fields; its
reads stay fail-soft, but every write is refused with HTTP 409 and
`SettingsReadOnlyError` and its bytes are never replaced. Deleting a session
clears that session's persisted approvals before the file disappears, so it
needs a writable document: under either read-only document the delete is
refused with HTTP 409 and the session is kept (an unknown session is still
404). Unknown top-level sections from a same-version extension survive a v0/v1
write.

**Mid-run steering.** A steering text is not a queued task: it is appended to
the run's shared context as a normal `message` envelope from `user` to
`senior` (the initial-task shape plus the documented `[[OPERATOR STEER]] `
marker in the payload text), so the next provider call renders it inside
`Context events:`. The harness drains the bounded in-memory queue (8 pending
texts, each trimmed and at most 4 000 characters) at each state-machine node
boundary and each tool-loop iteration; a tool-loop steer re-renders the
opening transcript so the in-flight wire conversation stays legal (never a
second consecutive user turn, which Anthropic/Google reject). At most 16 steer
envelopes are applied per run — beyond that an additive `steering_dropped`
runtime event reports the discarded texts — a broken drain callback records
one warning and never breaks the run, and nothing is appended after a stop.
The web composer exposes the action as **Steer run** / `Alt+Enter`; the TUI
queues the composer text with `Ctrl+N` (also the palette's **Steer the running
turn** row) under the same 8-pending/4 000-character bounds, cleared only on
acceptance and applied at the run's next step (see
[`tui`](#tui-initial-task)).

**Session lineage, rewind and export.** A fork copies a session prefix into a
new dense-`seq` session file (the source is never modified) and records a
local-only `parent: {name, seq}` link in the new `.meta.json` — the protocol
JSONL shape is unchanged, and a fork deliberately does not copy the
runtime-event sidecar or inherit the source's workspace link. In the web
transcript, an operator message bubble offers **Fork from here…**, which sends
the same route with that bubble's `{seq}` and opens the new fork, so the copy
ends exactly at that message; the original file and sidecar stay byte-identical,
and the action is unavailable while a run is active for the session. A rewind rewrites
the kept prefix atomically and clears the session's runtime-event sidecar, so
tool/approval history for the removed runs is gone while the kept transcript
remains (the response states whether the clear succeeded). `format=html`
export is one self-contained page (inline CSS, escaped payloads, no
scripts/links) bounded to 2 000 000 characters at envelope boundaries with an
explicit truncation note; markdown/json output is unchanged.

**Run-scoped file undo.** Workspace-bound `serve` runs capture the exact
pre/post bytes of every write/edit/delete under `<sessions>/undo` (a persisted
session side artifact — never a protocol envelope — so it survives a backend
restart). Preview classifies each file against the live workspace; apply
restores write/edit pre-images, deletes files the run created, and refuses any
file whose content changed after the run (per file, re-checked immediately
before it is touched — never overwritten); discard removes the record and
collects blobs no surviving record references (a deduped blob survives until
its last record is gone). The store is bounded: the newest 20 records per
session and records older than 30 days are pruned when a capture closes, active
runs are never pruned, and a prune/GC failure is one bounded diagnostic that
never breaks a run or an apply — pruning only makes an old run stop being
undoable, it never touches workspace files. On apply, a restored POSIX file
regains the permission bits recorded at capture time, and ownership is restored
only where the process may set it (best effort; a failure is disclosed per file
and never turns the byte restore into a failed apply). A run whose first mutation
of a path is a delete records that file's live mode at the mutation seam, so
the bytes and the permission bits are restored. Files the run did not mutate
through the workspace tools (shell-made changes, external edits, untracked
files) are out of scope, and CLI/TUI runs never capture. The CLI counterpart is
[`sessions undo`](#sessions).

**Provider reset vs. delete.** `POST /api/providers/{name}/reset` restores a
customized built-in seed: it deletes only that name's stored override
(including legacy case-variant duplicates), keeps both roles' `provider_ref`,
unrelated settings, plugins and other stored providers, and returns
`200 {provider: {name, base_url, api_key_set, kind, models, seed: true, customized: false}}`
— the canonical seed, with keys still reported only as `api_key_set`. The
name resolves case-insensitively against the seed table. Errors: unknown name
`404 {"detail": "not found"}`; an existing custom (non-seed) provider is a
`400` (`only built-in provider presets can be reset: <name>`); a pristine
seed with no stored override is a
`409 {"detail": "provider is not customized: <name>"}`.
`DELETE /api/providers/{name}` is unchanged: it removes a stored
provider/override and clears matching role `provider_ref` values. In the web
workspace, Settings → Providers shows **Reset to default** only for a
customized built-in seed; the confirmation warns that customized values and
the stored override API key are discarded while Senior/Junior role
assignments stay unchanged. Against an older backend without the route, the
client shows an unsupported message and changes nothing.

**Provider model discovery.** `POST /api/providers/{name}/discover` probes an
endpoint for the models it reports, using the **current draft** rather than the
saved preset — an explicit "Refresh models" action, deliberately separate from
Apply. The body is `{base_url?, kind?, api_key?}`: omitted `base_url`/`kind`
fall back to the stored preset, and `api_key` is a one-shot typed key for this
probe only. It writes nothing (no settings, no run state, no catalog) and the
key value never appears in a response or an error message. A typed key is
used as-is; without one, the preset's stored/env-backed key is attached
server-side **only when the probed base URL is the preset's own** (trimmed,
trailing slashes ignored) — probing a different URL with a saved secret and no
typed key is a `400` (`a typed API key is required when probing a different base
URL`) so the secret is never sent to another host. `200 {models, base_url,
kind}` returns the reported ids (`[{id, owned_by?}, ...]` with the probed
endpoint/kind echoed); an empty `models` list is a valid answer and must never
erase a saved catalog. Errors: unknown provider (seeds included)
`404 {"detail": "not found"}`; invalid JSON/body, an empty or non-`http(s)`
Base URL, an unknown kind, or a wire kind without an OpenAI-compatible listing
(`anthropic`/`google`) `400`; an upstream failure (unreachable host, timeout,
non-2xx, unparseable payload) `502` with the provider's message. Only the
openai-compatible adapter exposes `GET {base}/models`. The server route is the
same one the web Settings → Providers **Refresh models** button calls; the
offline equivalent is `two-brothers models --base-url <url>`.

**Session-scope approvals.** `POST /api/runs/{run_id}/approvals/{id}` answers a
pending operator approval with `{"allow": bool, "scope"?: "once" | "session"}`
and returns `{approval_id, decision, scope}`. `scope` is a strict string enum
defaulting to `once` (older clients keep the one-shot behavior); anything else
is a `400 invalid request body`, and `scope: "session"` with `allow: false` is a
`400` (`scope session requires allow`) because a session-wide deny does not
exist. An unknown or already-resolved approval id is a `404` and persists
nothing. Session scope persists the request's `(action, normalized target)`
pair **before** resolving it — a failed settings write is a `500` and nothing is
allowed — then resolves the parked request ALLOW and records the pair on that
run's broker. A later identical request in the same run resolves ALLOW without
parking (checked before the per-pair denial cap) and emits one additive
`approval_auto_allowed` runtime event `{action, target}` instead of
`approval_requested`; a stopped run still denies. The pair lives in
`sessions/settings.json` under the top-level
`"approvals": {"<session file>": ["<action> + NUL + <normalized target>", ...]}`
section (newest-last, at most 64 pairs per session, atomic temp-file + rename
write; a missing/corrupt section reads as empty, so damage fails closed toward
asking again). A run seeds its broker from that list at submit and again at
start, so a queued run sees an allow granted while it waited; deleting the
session clears its list. A shell request's pair key contains the full approved
command string — the same level of detail the runtime sidecar already records —
never an API key or prompt body.

In `work` mode, a run with a `workspace_id` gives the junior confined
workspace tools (`workspace_read_file`, `workspace_list_dir`,
`workspace_search_text`, `workspace_write_file`, `workspace_edit_file`,
`workspace_delete_file`, `workspace_run_shell`) rooted at the registered
directory. `workspace_read_file` takes the same optional line range described
under [workspace-bound TUI runs](#workspace-bound-tui-runs---workspace):
`offset` (1-based, default 1) and `limit` (default 2 000, max 5 000) page a
large file while `max_chars` still bounds each page. Reads auto-allow;
mutations and shell commands pause the run on an
`approval_requested` event until the operator answers — once, or for the rest of
the session (see the session-scope paragraph above) — unless the effective
[approval mode](#approval-modes) allows them without asking (or denies them
outright, as `readonly` does). The
senior gets read-only workspace checks (plus approval-brokered `run_shell`) to
verify the junior's deliverable before reviewing it. In consult mode neither
role is offered a workspace mutation tool: both may call the read-only
workspace belt (operator-installed MCP/plugin tools keep their own scopes;
see [tool use for both brothers](#features-beyond-the-original-prototype)).

Shell and delete approvals carry a fixed, honest `reason`; write and edit
approvals carry none because their unified diff is the explanation:

| Action | Reason |
|---|---|
| `run_shell` | `runs arbitrary shell code inside the workspace — its effects cannot be previewed and may change any file the process can reach` |
| delete | `permanently removes the file from the workspace — deletion cannot be undone` |

The reason reaches clients on `approval_requested` (and keeps through the
resolved card when the resolution itself carries none; a resolution reason such
as `cancelled` wins). The web approval card shows it while pending and after
Allow/Deny; the TUI approval panel shows it in its reason row — see
[Approvals in the TUI](#approvals-in-the-tui). The same additive detail field
(`{kind, diff?, addedLines?, removedLines?, command?, truncated?}`) feeds the
web card's collapsed **Preview the change** / **Preview the command** toggle:
a real button with `aria-expanded`/`aria-controls`, `+N -M` counts, a `clipped`
badge when the detail hit the 20 000-char cap, and a plain-text `<pre>` for the
bounded unified diff or shell command (never HTML); a backend that sends no
detail simply renders no preview. See the
[Quickstart](quickstart.md) for the operator-facing walkthrough.

### `models`

List the models an OpenAI-compatible endpoint reports (`GET {base}/models`).

```powershell
node dist/cli.js models --base-url https://api.deepseek.com/v1
node dist/cli.js models --base-url https://api.deepseek.com/v1 --api-key-env DEEPSEEK_API_KEY
node dist/cli.js models --base-url https://api.deepseek.com/v1 --json
```

`--api-key-env <VAR>` reads the key from an environment variable name
(alternative to `--api-key <key>`); `--json` prints the raw list.

### `onboard`

Write per-role provider settings to `sessions/settings.json`
(`--sessions-dir <dir>` selects the store) from a seeded preset or manual
fields. Interactive by default; `--non-interactive` accepts piped stdin.

```powershell
node dist/cli.js onboard                                    # interactive prompts
node dist/cli.js onboard --preset lmstudio --non-interactive
node dist/cli.js onboard --base-url https://api.deepseek.com/v1 `
  --api-key sk-... --senior-model deepseek-chat --junior-model deepseek-chat --non-interactive
```

`--preset <id>` takes a seeded preset id (the curated table includes hosted
providers, subscription plans such as OpenCode Zen/Go, Kimi For Coding, Z.AI
coding, Qwen/Xiaomi token plans, Moonshot, MiniMax, LM Studio and `custom`);
its API key resolves from the env-var name the preset declares. Manual fields:
`--base-url`, `--api-key` (or `--api-key-env <VAR>`), `--senior-model`,
`--junior-model`.

The same store is what `serve` and the TUI read (the TUI also re-resolves it
before every turn), so an `onboard` run configures both surfaces. Inside the
TUI, `/provider` (or `/settings` → **Connect provider…**) performs the same
per-role connection without leaving the terminal.

## Flags

| Flag | Values | Default | Description |
|---|---|---|---|
| `--provider` | `openai`, `mock` | `openai` | provider |
| `--base-url` | URL | — (empty; an `openai` run fails fast until set) | OpenAI-compatible base URL (shared by both roles) |
| `--api-key` | string | — | API key (may be empty for a local server) |
| `--senior-base-url` | URL | — | per-role endpoint override: senior base URL (empty fields fall back to `--base-url`) |
| `--senior-api-key` | string | — | per-role endpoint override: senior API key |
| `--junior-base-url` | URL | — | per-role endpoint override: junior base URL |
| `--junior-api-key` | string | — | per-role endpoint override: junior API key |
| `--senior-model` | string | — (empty; fails fast until set) | senior model |
| `--junior-model` | string | — (empty; fails fast until set) | junior model |
| `--provider-kind` | `openai-compatible`, `anthropic`, `google` | `openai-compatible` | (TS package) wire adapter for HTTP providers, both roles; a per-role kind wins |
| `--senior-kind` | `openai-compatible`, `anthropic`, `google` | — | (TS package) per-role wire adapter; presets with a `kind` carry it automatically on the server path |
| `--junior-kind` | `openai-compatible`, `anthropic`, `google` | — | (TS package) per-role wire adapter |
| `--context-window` | int (tokens) | `0` (unknown) | (TS package) provider context window — enables token-based compaction triggers (`contextWindow - reserve`) |
| `--compact-threshold-tokens` | int (tokens) | — | (TS package) force token-mode compaction at an explicit threshold (env `TWO_BROTHERS_COMPACT_THRESHOLD_TOKENS`) |
| `--senior-system` | text | (from `shared/prompts.json`) | override the senior system prompt |
| `--junior-system` | text | (from `shared/prompts.json`) | override the junior system prompt |
| `--max-rounds` | int | `3` | maximum revise rounds |
| `--temperature` | float | `0.4` | temperature |
| `--timeout` | int | `120` | per-request HTTP timeout, seconds; bounds every attempt of the retry loop (see [Local models and timeouts](#local-models-lm-studio-and-timeouts)) |
| `--retries` | int | `6` | retries after a failed model call (`0` = single attempt); backoff 2 s, 4 s, 8 s, … capped at 30 s with a 0–25% jitter reduction (so those values are the upper bound; 7 attempts total by default); a provider's `retry-after-ms`/`Retry-After` replaces that attempt's backoff; a stopped run aborts the loop between attempts |
| `--max-tokens` | int | — | (TS package) output-token cap for both roles (env `TWO_BROTHERS_MAX_TOKENS`; per-role `TWO_BROTHERS_SENIOR_MAX_TOKENS` / `TWO_BROTHERS_JUNIOR_MAX_TOKENS` override it); Anthropic's default stays 4096, OpenAI/Gemini omit the cap when unset |
| `--thinking-budget` | int | — | (TS package) Anthropic extended-thinking budget in tokens, run-level for both roles (min 1024; only Anthropic Messages roles use it, other providers ignore it; env `TWO_BROTHERS_THINKING_BUDGET`; never persisted). When an Anthropic provider's effective `--max-tokens` does not exceed the budget, that provider's request cap is raised to budget + 1024 with one honest warning per provider instance (up to two when both roles are Anthropic); `temperature` is omitted while thinking is enabled (see [Anthropic extended thinking](#anthropic-extended-thinking-ts-package)) |
| `--mode` | `consult`, `work`, `auto` | `consult` | cooperation mode |
| `--mode` | `print`, `json` | — | (TS package, `run` and each `chat` REPL turn) non-interactive automation output — see [Automation output](#automation-output-ts-package); `--mode work --json-events` stays possible because `print`/`json` are output modes, not cooperation modes |
| `--json-events` | flag | off | (TS package, `run` and each `chat` REPL turn) alias for `--mode json` |
| `--stream` | flag | off | (TS package, `run` and each `chat` REPL turn) NDJSON run events on stdout as they happen: one JSON object per line from `run_status`, `envelope`, `repair`, `tool_call`, `tool_result`, `usage` (one live snapshot per cooperation node, carrying the normalized prompt/cache counters), `result`. Its own output mode — on `run` it cannot combine with `--json`/`--json-events`/`--mode print|json` (usage error, exit 2); the human summary and cost line are suppressed |
| `--live` | flag | off (on for a TTY) | (TS package, `run`/`chat` only) stream the human transcript live on an interactive stdout: one envelope block as produced, dim `· …` activity rows between blocks, the decision rule and compact footer still once at the end. Never applies to a pipe, a machine output mode, or a sink without a TTY signal |
| `--no-live` | flag | off | (TS package, `run`/`chat` only) disable live streaming and print the finished transcript once (the piped behavior); wins when both `--live` and `--no-live` are given |
| `--verbose` | flag | off | print the full payload of every message |
| `--json` | flag | off | with no explicit `--mode`: select `--mode json` (one machine-readable object). With an explicit `--mode print`: print the `decision` as JSON on the last line. Env `TWO_BROTHERS_JSON` is the env spelling of a bare `--json` (same machine object; explicit output flags/modes win over it) |
| `--session-file` | path | — | JSONL file to persist every protocol envelope to |
| `--resume` | flag | off | resume the session file instead of starting a new one |
| `--compact` | flag | off | (TS package) compact the context once before the run: an old prefix is summarized by the senior provider into a marked context event, keeping the session under the model's context window |
| `--compact-threshold` | int | `0` (off) | (TS package) auto-compact whenever the rendered context passes this many characters (an auto trigger caps its budgets so the compacted context lands under the threshold) |
| `--compact-keep-recent` | int | `40000` | (TS package) chars of recent envelopes kept verbatim when compacting |
| `--mcp-config` | path | — | JSON file with MCP server definitions; a server may take a `"role": "shared" \| "senior" \| "junior"` field (default `"junior"`) |
| `--plugins-dir` | dir | `<cwd>/plugins` | (TS package) plugin directory for `run`/`chat`/`serve` (env `TWO_BROTHERS_PLUGINS_DIR`); plugins load fail-soft, diagnostics under `--verbose`; plugin tools need a workspace, so `serve` runs over a workspace get them |
| `--skills-dir` | path | — (repeatable) | (TS package) extra skills root; defaults are `TWO_BROTHERS_SKILLS_DIR` (OS path list), then `<cwd>/skills` and `~/.two-brothers/skills` |
| `--stream-tokens` | flag | off | (TS package, `run --stream` and `tui`) with `--stream`: ask providers to stream their replies and add one `"token"` NDJSON record (`{type, role, delta, at}`) per text delta, in arrival order, interleaved with the other run records. In the TUI the deltas render in place (no `--stream` needed). Without `--stream` in a run it is a usage error (exit 2); env `TWO_BROTHERS_STREAM_TOKENS=1` pins it on |
| `--dry-run` | flag | off | (TS package, `run`/`chat`) resolve the run (config with sources, tools, session, compaction, limits) and print the plan; exits 0 with no model calls and no session write. `run --dry-run --json` prints one JSON object. Invalid with `--stream` (usage error, exit 2) |
| `--task-file` | path | — | (TS package, `run` only) read the task from a file — missing/unreadable/blank exits 2; mutually exclusive with a positional task. `run -` reads the task from stdin instead (bounded to 1 MiB, blank exits 2) |
| `--commands-dir` | path | — (repeatable) | (TS package) extra slash-command root for the chat REPL and `tui`; defaults are `TWO_BROTHERS_COMMANDS_DIR` (OS path list), then `<cwd>/commands` and `~/.two-brothers/commands` |
| `--workspace` | dir | — | (TS package, `tui` only) bind every turn to one confined workspace root: `workspace_*` tools for the junior, the read-only verify slice for the senior, the operator approval panel for mutations/shell, and `@path` file mentions. An invalid root exits 2 before the screen opens |
| `--keys-file` | path | `~/.two-brothers/tui-keys.json` | (TS package, `tui` only) user-authored JSON with TUI chord overrides for the rebindable global commands (command palette, shortcut reference, draft stash); a missing file means the defaults, an invalid file prints one diagnostic and falls back to the defaults without touching the screen; env `TWO_BROTHERS_TUI_KEYS_FILE`; never persisted; read at startup and re-read by `/keys reload` (or by `--keys-watch`) |
| `--keys-watch` | flag | off | (TS package, `tui` only) keep polling the captured keys file and live-apply valid chord edits through the same validated reload path as `/keys reload`; a valid change swaps the active table and posts one bounded notice naming the new chords, an invalid file keeps the last good chords with one bounded warning per detected change, an absent/unreadable file keeps them with an informational notice. `fs.watchFile` polling (~twice a second, debounced/coalesced); captured at startup, never persisted; `/keys show` reports the watch state (`on`/`off`/`unavailable`); env `TWO_BROTHERS_TUI_KEYS_WATCH=1` |
| `--approval-mode` | `ask`, `readonly`, `edits`, `allow-all` | `ask` | (TS package) operator [approval mode](#approval-modes) for workspace actions (env `TWO_BROTHERS_APPROVAL_MODE`). `serve` pins it for its web runs and `tui` for the TUI process (in-memory only, never persisted; the saved `approval_policy` setting applies without a pin); `run`/`chat` accept it but bind no workspace. An unknown value is a usage error (exit 2); `allow-all` prints one visible warning |

## Environment variables

| Variable | Corresponding flag |
|---|---|
| `TWO_BROTHERS_PROVIDER` | `--provider` |
| `TWO_BROTHERS_BASE_URL` | `--base-url` |
| `TWO_BROTHERS_API_KEY` | `--api-key` |
| `TWO_BROTHERS_SENIOR_BASE_URL` | `--senior-base-url` |
| `TWO_BROTHERS_SENIOR_API_KEY` | `--senior-api-key` |
| `TWO_BROTHERS_JUNIOR_BASE_URL` | `--junior-base-url` |
| `TWO_BROTHERS_JUNIOR_API_KEY` | `--junior-api-key` |
| `TWO_BROTHERS_SENIOR_MODEL` | `--senior-model` |
| `TWO_BROTHERS_JUNIOR_MODEL` | `--junior-model` |
| `TWO_BROTHERS_PROVIDER_KIND` | `--provider-kind` |
| `TWO_BROTHERS_SENIOR_KIND` | `--senior-kind` |
| `TWO_BROTHERS_JUNIOR_KIND` | `--junior-kind` |
| `TWO_BROTHERS_SENIOR_SYSTEM` | `--senior-system` |
| `TWO_BROTHERS_JUNIOR_SYSTEM` | `--junior-system` |
| `TWO_BROTHERS_MAX_ROUNDS` | `--max-rounds` |
| `TWO_BROTHERS_TEMPERATURE` | `--temperature` |
| `TWO_BROTHERS_TIMEOUT` | `--timeout` |
| `TWO_BROTHERS_RETRIES` | `--retries` |
| `TWO_BROTHERS_MODE` | `--mode` (also accepts the TS-package output values `print`/`json`) |
| `TWO_BROTHERS_VERBOSE` | `--verbose` (`true`/`1`) |
| `TWO_BROTHERS_JSON` | `--json` (`true`/`1`) — equivalent to a bare `--json`: the machine-readable output object (explicit output flags/modes win over it), not the legacy decision-on-the-last-line output |
| `TWO_BROTHERS_SESSION_FILE` | `--session-file` |
| `TWO_BROTHERS_RESUME` | `--resume` (`true`/`1`) |
| `TWO_BROTHERS_COMPACT` | `--compact` (`true`/`1`; TS package) |
| `TWO_BROTHERS_COMPACT_THRESHOLD` | `--compact-threshold` (TS package) |
| `TWO_BROTHERS_COMPACT_THRESHOLD_TOKENS` | `--compact-threshold-tokens` (TS package) |
| `TWO_BROTHERS_CONTEXT_WINDOW` | `--context-window` (TS package) |
| `TWO_BROTHERS_COMPACT_KEEP_RECENT` | `--compact-keep-recent` (TS package) |
| `TWO_BROTHERS_MAX_TOKENS` | `--max-tokens` (TS package) |
| `TWO_BROTHERS_SENIOR_MAX_TOKENS` / `TWO_BROTHERS_JUNIOR_MAX_TOKENS` | per-role `--max-tokens` overrides (TS package) |
| `TWO_BROTHERS_THINKING_BUDGET` | `--thinking-budget` (TS package; pinned, never persisted) |
| `TWO_BROTHERS_MCP_CONFIG` | `--mcp-config` |
| `TWO_BROTHERS_PLUGINS_DIR` | `--plugins-dir` (TS package) |
| `TWO_BROTHERS_SKILLS_DIR` | `--skills-dir` (OS path list; TS package) |
| `TWO_BROTHERS_STREAM_TOKENS` | `--stream-tokens` (`true`/`1`; requires `--stream`, which a run without it reports as a usage error) |
| `TWO_BROTHERS_COMMANDS_DIR` | `--commands-dir` (one or more roots separated by the OS path-list separator; TS package) |
| `TWO_BROTHERS_APPROVAL_MODE` | `--approval-mode` (pins the mode for `serve`'s web runs / the TUI process; never persisted; TS package) |
| `TWO_BROTHERS_WORKERS` | `--workers` (serve) |
| `TWO_BROTHERS_PLUGINS_SENIOR` / `TWO_BROTHERS_PLUGINS_JUNIOR` | — (comma-separated plugin names; see `docs/plugins.md`) |
| `TWO_BROTHERS_SHELL_PATH_EXTRA` | — (path-separated dirs prepended to the confined workspace-shell `PATH`, e.g. the directory holding the binaries your tool proofs call) |
| `TWO_BROTHERS_TUI_KEYS_FILE` | `--keys-file` (TS package, `tui` only; pinned, never persisted) |
| `TWO_BROTHERS_TUI_KEYS_WATCH` | `--keys-watch` (`1`/`true`/`yes`/`on`; TS package, `tui` only; pinned, never persisted) |
| `TWO_BROTHERS_REPEAT_GUARD` | — (runtime-only, no flag: `off`/`0`/`false`/`no` disables the default-on advisory [repeat-tool-call guard](#repeat-tool-call-guard-ts-package) for `run`/`chat`/`tui`/`serve`; never persisted) |
| `TWO_BROTHERS_PROJECT_INSTRUCTIONS` | — (runtime-only, no flag: `off`/`0`/`false`/`no` disables root-level workspace instruction loading for TUI workspace runs and `serve`; never persisted) |

**Precedence:** CLI flags > environment variables > defaults. Persisted
settings from `onboard` / the web Settings sit between env vars and defaults,
and the TUI now resolves through the same chain as the server path: per-run
flags > `TWO_BROTHERS_*` env vars (all-or-nothing pairs; env-pinned fields are
never persisted) > named preset (`provider_ref`) > role manual settings >
built-in seed presets > harness defaults. `two-brothers config` prints this
chain per field with the winning source, and the TUI's `/provider` shows the
effective per-role connection (see
[Provider connection](#provider-connection-provider)).

**Env-pinned fields.** An environment variable does not just override a
settings field — it *pins* it. A field pinned by a `TWO_BROTHERS_*` env var
(`TWO_BROTHERS_PROVIDER`, `TWO_BROTHERS_BASE_URL`/`_API_KEY` and their
per-role variants, `TWO_BROTHERS_SENIOR_MODEL`/`_JUNIOR_MODEL`) keeps the env
value as the effective value, is stripped before anything is written to
`sessions/settings.json`, and is surfaced in Settings/`onboard` output as the
env value. Consequence: a `PUT /api/settings` edit or an `onboard` run that
touches a pinned field is accepted but transient — the env value wins again
on the next read/run until the env var is unset. `onboard` prints a
`pinned by TWO_BROTHERS_* env vars` note naming the stripped fields.

## Local models (LM Studio) and timeouts

Small local models on CPU (observed with `lfm3-1.7b` in the live E2E) can
take **2–7+ minutes per provider call**. `--timeout` bounds *each attempt*
of the retry loop, and every retry restarts generation from scratch — so a
slow local model can exhaust all attempts even with retries left. Raise the
timeout rather than the retry count:

```powershell
node dist/cli.js run "Your task" --timeout 900    # seconds; go higher on slower machines
$env:TWO_BROTHERS_TIMEOUT = "900"                 # env equivalent (run/chat/serve)
node dist/cli.js serve --timeout 900              # serve/web path (flag or env)
```

## Sessions

`--session-file <path>` (env `TWO_BROTHERS_SESSION_FILE`) makes both `run` and
`chat` append every protocol envelope to a JSONL file — one line per envelope,
flushed immediately, so a crash loses at most the final, partially written line
(ignored on the next read and repaired by `--resume`).

- `run`: an existing file without `--resume` is an error (exit code 1; the
  message suggests `--resume` or deleting the file).
- `--resume` (env `TWO_BROTHERS_RESUME`, boolean) rebuilds the shared context
  from the file; `seq` numbering continues densely. With a missing file, a
  fresh session starts with a `[warn]`.
- `chat`: one shared context across all REPL tasks, persisted; with `--resume`
  it continues a previous session.
- (TS package) `--compact` / `--compact-threshold <chars>` (env
  `TWO_BROTHERS_COMPACT*`) compact a growing context: an old prefix is
  summarized by the senior provider into a clearly-marked context event while
  the original task and the recent exchange stay verbatim. A compacted
  session file stays ordinary JSONL — `--resume` and `sessions` keep working.
  Summarization failure is fail-soft: a `[warn]` on stderr, the run continues
  with the full context.
- A crashed append can leave a half-written **final** JSONL line. `--resume`
  recovers it: the torn trailing fragment is dropped with one bounded warning
  on stderr (`[warn] recovered session <path>: dropped a torn final line N
  (B bytes) and truncated to the last complete envelope`), and the file is
  repaired atomically before the first append (temp file + rename: truncation
  to the last complete line, or one added newline after a valid final
  envelope), so the next envelope keeps dense `seq` numbering. Corruption
  anywhere except that final fragment is still a typed `SessionError`
  (`corrupt session file …, line N`, exit 1); `sessions rewind` keeps the
  strict reader and refuses a torn source, and read-only commands never
  rewrite the file. A repair is not a format change: every remaining line is
  still an ordinary protocol envelope.

List sessions without opening the web workspace:

```powershell
node dist/cli.js sessions                # the default ./sessions dir
node dist/cli.js sessions --sessions-dir path/to/dir
```

```powershell
# create a session
node dist/cli.js run "Plan a migration from Redis to Valkey" --provider mock --session-file session.jsonl

# resume it later
node dist/cli.js run "Now plan the rollback" --provider mock --session-file session.jsonl --resume
```

## MCP tools

`--mcp-config <path>` (env `TWO_BROTHERS_MCP_CONFIG`) points at a JSON file
with MCP server definitions. A non-blank flag wins over the env; a blank flag
falls back to it, and blank/whitespace on both means "not configured". The
`doctor` command inspects the env-named file read-only (well-formed JSON with
an `mcpServers` object) without starting a server. In `work` mode the junior
receives those tools
and can execute real work during a delegation. The format follows the
Claude-Desktop style — a server is either a local command or a remote URL. A
server may carry a `"role"` field (`"shared" | "senior" | "junior"`, default
`"junior"`) to scope its tools per role:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    },
    "remote": {
      "url": "https://example.com/mcp",
      "headers": {"Authorization": "Bearer ..."}
    }
  }
}
```

```powershell
node dist/cli.js run "Refactor utils.ts" --mode work --mcp-config mcp.json
```

No config → no tools; a server that fails to start → a `[warn]` and the junior
continues text-only. Used tools are recorded in the deliverable's `artifacts`
as `mcp:<name>`. Model-facing MCP tool names are namespaced
(`mcp__<server>__<tool>`), a single result is clipped to 20 KiB, and each call
has a timeout (default 60 s, per-server `timeoutMs` override).

## Skills (TS package)

`<root>/<name>/SKILL.md` files (or loose `.md` files) with hand-rolled
frontmatter (`name`, `description`, optional `scope: shared|senior|junior`,
optional `tools`) become an `## Available skills` section in the system
prompt of each role that has visible skills. Roots: repeatable `--skills-dir`,
then `TWO_BROTHERS_SKILLS_DIR` (OS path list), then `<cwd>/skills` and
`~/.two-brothers/skills`. A `<skill name="…">` request in a structured reply
injects the body once as a `<skill-loaded>` message (at most three per run,
each skill once, only skills visible to the acting role). The server serves
metadata only at `GET /api/skills`.

## Modes

| Mode | What happens |
|---|---|
| `consult` | senior asks for advice → junior `proposal` → `review` → `decision` |
| `work` | senior delegates (`delegation`) → junior `deliverable` → `review` → `decision` |
| `auto` | senior chooses; in v0.1 this reduces to `consult` |

A CLI `work` run binds no workspace, so it binds no tools — the junior cannot
read, edit or run a command, and a `deliverable` cannot be verified against
real files. `run` states that instead of silently producing an unverifiable
deliverable: one `[warn] work mode has no tools bound: ...` line goes to stderr
before the run starts (a `chat` turn in `work` mode warns the same way). stdout,
the exit code and `--json` output are byte-identical to a run without the
warning. Use `serve` (workspace-bound web runs) or `consult` mode when the
junior must touch the workspace.

## Approval modes

A workspace-bound run applies one operator-selected **approval mode** to
decide which workspace actions may run without asking. The mode is a fixed,
honest decision table — the model and any tool call can never set or widen it:

| Mode | Reads | Writes / edits | Deletes | Shell commands |
|---|---|---|---|---|
| `ask` (default) | run freely | ask | ask | ask |
| `readonly` | run freely | **denied** without asking | **denied** without asking | **denied** without asking |
| `edits` | run freely | run freely | ask | ask |
| `allow-all` | run freely | run freely | run freely | run freely |

### Permission presets

The operator surfaces present four named presets (deepseek-harness style).
Each preset is a presentation alias for exactly one stored mode — the mode is
still the only persistence/enforcement value, so an older client or script
keeps working:

| Preset | Stored mode | Reads | Writes / edits | Deletes | Shell commands |
|---|---|---|---|---|---|
| Read only | `readonly` | run freely | **denied** without asking | **denied** without asking | **denied** without asking |
| Always ask (default) | `ask` | run freely | ask | ask | ask |
| Workspace write | `edits` | run freely | run freely | ask | ask |
| Full access | `allow-all` | run freely | run freely | run freely | run freely |

Full access is the only preset with a destructive warning, and it is an
explicit opt-in: the web Permissions section asks for an acknowledgement
checkbox before emitting `allow-all`; the TUI keeps its explicit button plus
warning toast, and a typed `/permission danger-full-access` is explicit
consent. The legacy mode names (`ask`, `readonly`, `edits`, `allow-all`)
remain accepted everywhere a preset is accepted.

- **Sources.** Persisted top-level in `sessions/settings.json` as
  `{"approval_policy": {"mode": "ask"}}`; the web Settings → **Permissions**
  section and the TUI `/settings` → **Permissions…** / `/permission` dialog
  write it through the validated store. `/permission <preset>` accepts both
  preset ids and legacy mode names; a bare `/permission` shows the effective
  preset, the stored mode it applies, and the configured tool scopes.
  `--approval-mode <mode>` / `TWO_BROTHERS_APPROVAL_MODE` **pin** a mode for
  `serve`'s web runs or the TUI process (in-memory only, never persisted: the
  saved setting applies again after a restart without the pin). `run` and
  `chat` accept the flag for symmetry but bind no workspace, so it changes
  nothing there.
- **Reads are always free.** A mode only decides the mutating actions; the
  deny rows in `readonly` are deterministic denials, not parked approvals —
  a broker cannot re-open what the mode closed.
- **Fail closed.** A missing, corrupt or unknown stored policy reads as `ask`;
  no mode is ever inferred; the default and an invalid `--approval-mode` are a
  usage error (exit 2). An unknown mode in `PUT /api/settings` is a 400.
- **Guardrails are outside the mode.** Workspace confinement, the
  sensitive-path refusal and the `..`/absolute-path checks run in the
  workspace layer *before* permissions, so no mode can read or write outside
  the registered root. Broker-null stays fail closed, the per-session
  "always allow this session" pairs and the denial-repeat cap are unchanged,
  closing an approval overlay never answers it, and stopping a run still
  denies every pending request.
- **Shell is approved as its own action.** A denied mutation tool does not
  restrict shell: if the model retries the same change as a
  `workspace_run_shell` command, that command is a separate request that still
  parks in `ask`/`edits` (read it in the card before allowing it; `Ctrl+E` /
  Preview shows the full command). When the operator has already denied a
  write/edit/delete earlier in the same run, the parked shell request's reason
  additively carries a caution sentence ("a file change was denied earlier in
  this run — review this command closely"); it changes no decision, and
  `readonly` denies shell along with the mutation tools, which is the mode to
  use when shell writes must be impossible rather than merely visible.
- **Visible when permissive.** `allow-all` prints one `[warn]` line per
  `run`/server start, the TUI shows a warning toast each workspace turn in
  that mode, the web section renders its destructive warning inline whenever
  `allow-all` is the selected mode, and a
  pinned mode is stated as pinned in the TUI dialog (which then offers only
  Close) and in the web section (read-only with the restart instruction).

## Human text output (TS package)

The default `run` output (and every `chat` turn) is a human transcript with a
stable, width-safe layout:

- **Separated blocks.** Each protocol envelope is one block — the historical
  `[from -> to] kind` header line, then indented payload fields — and blocks are
  separated by one blank line. The operator task keeps its historical
  `[user]      <task>` line (only wrapping at the terminal width), so scripts
  anchored on that line keep working.
- **Ruled decision.** The final decision block is preceded by a labelled rule,
  `── decision ─────…`, capped at 80 columns and never wider than the terminal.
- **Markdown bodies.** Model-provided prose (`ask`, `answer`, `rationale`,
  `result`, `notes`, `decision`, `work`) renders through the TUI's Markdown
  renderer: headings, lists, quotes, fenced code, diffs, and inline
  bold/italic/code/link emphasis, wrapped to the available width. Model ANSI
  escapes and control bytes are stripped before layout, so a reply can never
  drive the terminal. Titles, numbers and verdicts stay single-line values.
- **Compact footer.** When the run reports usage, one blank line then a compact
  footer ends the transcript:
  `tokens 40 in / 20 out · cache 25% · 4 calls · cost $0.0300`. `in` is the
  normalized **prompt** total (OpenAI-compatible input already includes cache
  reads; Anthropic adds uncached + read + written; Gemini uses its prompt
  count), so `cache` is `cached / prompt` and stays honest across mixed
  families. Segments appear only when known — `cache` only with a recorded
  cache hit, `write` only when cache-write tokens were billed (Anthropic),
  `cost` only when both roles resolve to one priced model **and** one
  prompt-cache family (an ambiguous mixed-family run shows no cost rather than
  a double- or under-counted number), and no footer at all when the run
  reported no usage. The legacy `tokens:` / `cost:` diagnostic lines are the
  print-mode format and stay on stderr there (see
  [Automation output](#automation-output-ts-package)); the human transcript does
  not print them.
- **Live on a TTY.** On an interactive stdout `run`/`chat` write each envelope
  block as the harness produces it, with dim `· …` activity rows between blocks
  (`· senior consulting…` before a call, `· junior tool workspace_read_file…`
  while a tool runs, an explicit row for a non-ok tool result). The ruled
  decision and the compact footer still print exactly once, at the end.
  `--no-live` — or a pipe/non-TTY stdout, or a machine output mode — prints the
  finished transcript once instead; `--live` cannot force a pipe to stream.
  Dropping the `· ` activity rows from live output leaves the finished
  transcript's bytes plus the footer block, and `--verbose` keeps the same
  payload rows in both projections.
- **Widths.** A TTY wraps to its own width; piped/non-TTY output keeps the
  historical 96-column layout. The text stays plain when color is off
  (`NO_COLOR`, a pipe, `TERM=dumb`), and `stripAnsi(colored)` reproduces the
  plain bytes exactly.
- **Responsive help.** Generated help tables (`help`, `help <command>`,
  `help --all`, `--help`) scale their command/flag/environment columns with the
  terminal width on a TTY, so summaries align beside their commands on a wide
  terminal and descriptions keep room to wrap on a narrow one; a non-TTY keeps
  the historical 96-column column widths, and a summary that cannot fit that
  width wraps onto an indented continuation row instead of overflowing it.

Machine output is unaffected: `--json`, `--json-events`, `--stream`,
`--mode print` and `--dry-run` are byte-identical to their previous formats
(zero escape bytes, same field shapes and stderr routing), and live streaming
never applies to them (nor to a non-TTY stdout).

## Plan and todo function (TS package)

The built-in `todo_write` tool lets the model keep a plan for multi-step work.
Both brothers receive it (the junior belt and the senior verify slice); it is
display state only — no workspace access, no approval, and on its own it never
enables the senior verify pass:

- **Arguments:** `{"todos": [{"content": "short imperative line",
  "status": "pending" | "in_progress" | "completed"}, ...]}` — the complete
  list, replacing any previous one (last write wins; no ids).
- **Tolerant boundary:** non-object entries and empty content are dropped, an
  unknown/missing status becomes `pending`, content is collapsed to one line
  and bounded, and at most 50 entries survive. A call whose `todos` is not an
  array — or that yields no usable entry — returns a JSON error result and
  leaves the previous plan untouched; one bad entry never loses the plan.
- **Result and event:** a valid call returns a compact text result
  (`todo list updated: N items (M in progress)`) and emits exactly one additive
  `todo_updated` runtime event
  `{"type": "todo_updated", "todos": [...], "run_id", "at"}`. The event is
  persisted in the run sidecar (`sessions/runtime/<session-file>.events.jsonl`,
  where the session file name already ends in `.jsonl`: `x.jsonl` ->
  `x.jsonl.events.jsonl`), streamed over the run SSE endpoint and replayed on a
  reload — the latest snapshot is the current plan. Protocol envelopes and the
  session JSONL are untouched, and `HarnessResult.todos` carries the final
  snapshot for API callers.
- **Surfaces:** the TUI docks a compact plan panel above the composer and the
  web renders a Plan dock near the composer (see
  [TUI](#plan-panel) and [Quickstart](quickstart.md)) — both use the same
  status markers and bounded selection, and neither takes a key. A TUI turn
  also writes each plan snapshot to the same sidecar (`todo_updated` only), so
  a restart with the same `--session-file` replays the plan.

## Workspace instructions (TS package)

A workspace-bound run (`tui --workspace <dir>` and a `serve` run linked to a
workspace) loads root-level `AGENTS.md` and `CLAUDE.md` from that workspace and
appends them LAST in both roles' system prompts as
`## Workspace instructions`.

- Both files are read once when the harness is constructed (one read per run),
  in `AGENTS.md` → `CLAUDE.md` order, only as regular files directly under the
  workspace root: missing files, directories, symlinks, empty/binary files and
  unreadable files are skipped, and nothing outside the root is ever read. A
  candidate larger than 1 MiB is skipped entirely (the 16 Ki cap applies to
  files at or below that source bound).
- Content is normalized (line endings and trailing whitespace), capped at
  16 Ki characters per file and 32 Ki characters in total, and de-duplicated
  by normalized content (the first file keeps its label). Truncation is
  explicit: the block names the file and how many characters were omitted.
- The text is **untrusted project guidance**. A fixed warning says it does not
  override the system/operator instructions and must not be followed for
  permission claims or hidden tool requests; every source line is
  quote-prefixed so it cannot forge a prompt section heading.
- The prompt audit records the `instructions` section and the included file
  labels/lengths (never the body).
- No instruction files means no section: the prompt bytes stay exactly as
  before. Set `TWO_BROTHERS_PROJECT_INSTRUCTIONS=off` to disable the load for
  `tui`/`serve`. Library callers can pass `HarnessOptions.projectInstructions`:
  `false` disables it, and an object overrides `files`, `maxChars` and
  `maxTotalChars`. `run`/`chat` are not workspace-bound and load nothing.

## Repeat-tool-call guard (TS package)

Every tool loop carries an advisory loop-hygiene guard (port of
deepseek-harness's `repeat-tool-reminder`, MIT). It counts consecutive
attempts of the same tool with canonically identical arguments — deep key sort
then `JSON.stringify`, so property order does not matter — and reminds the
model instead of blocking it:

- **First threshold (default 3):** a short reminder to analyze the previous
  result before repeating the call.
- **Later thresholds (default 5 and 8):** a detailed reminder naming the tool,
  the consecutive count and a head-truncated argument preview (500 characters
  by default; every character outside printable ASCII — Unicode and control
  characters alike — is `\uXXXX`-escaped).
- **Placement:** the reminder is appended to the MODEL-FACING tool result only,
  after the normal result/spill preview and separated by a blank line. The
  runtime `tool_completed` record, the stream `tool_result` and the protocol
  transcript keep the tool's own output.
- **Chain rules:** every attempted call counts — unknown tools and calls
  denied by a hook or approval included. A different tracked call restarts the
  count, untracked tools are transparent (neither count nor reset), and a new
  node or user message starts a fresh chain. There is no blocking threshold.

The guard is on by default with thresholds `[3, 5, 8]`. Set
`TWO_BROTHERS_REPEAT_GUARD=off` (`0`/`false`/`no` also work) for `run`,
`chat`, `tui` or `serve` to disable it for that process. Library callers can
pass `HarnessOptions.repeatToolGuard`: `false` disables it, while an options
object overrides `thresholds`, `include`/`exclude` (`*`-wildcard tool-name
patterns) and `argumentsPreviewChars`.

## Automation output (TS package)

`run` in the TypeScript package (`packages/harness`) accepts two extra
`--mode` values — output modes, not cooperation modes (so
`--mode work --json-events` is meaningful). Each `chat` REPL turn honors the
same modes (one output per submitted task; the REPL banner and blank turn
separators are suppressed in machine modes so every turn's payload stays
parseable):

- `--mode print` — stdout carries only the final decision text (with
  `--json`: the decision object as JSON). Warnings and the usage line go to
  stderr, so the output is pipe-clean for scripts and `$(...)`.
- `--mode json` (alias `--json-events`; a bare `--json` with no explicit
  `--mode` selects this mode too) — stdout is exactly one
  machine-readable JSON object
  `{task, events, decision, usage, cost, rounds, errors}`; diagnostics stay on
  stderr. One event per line is intentionally not produced — the object is
  single-shot. (`run --stream` is the line-by-line NDJSON alternative.)

`TWO_BROTHERS_JSON=1` (also `true`/`yes`/`on`) is the environment spelling of
a bare `--json`: it selects the same single machine-readable object on stdout
— never the retired "human transcript plus the decision on the last line"
behavior. Precedence is unchanged: `--stream`, `--json-events` and an explicit
`--mode print|json` win over the env var, and any explicit output flag wins
over an env value of `0`/`false`; the env var is not a JSON modifier on
`--mode print` (use the `--json` flag there for the decision object).

**Migration note:** scripts that relied on the old `TWO_BROTHERS_JSON` output
(a decision JSON object as the last line after the human transcript) should
parse the new single object's `decision` key, or add `--mode print` for the
decision text / `--mode print --json` for the decision-only object.

Exit codes in both modes: `0` success, `1` run error (the `errors` array in
JSON mode is non-empty), `2` usage error (unknown command/option, task not
given).

```powershell
node dist/cli.js run "Pick a testing scheme" --provider mock --mode print
node dist/cli.js run "Pick a testing scheme" --provider mock --mode json | ConvertFrom-Json
```

## Features beyond the original prototype

These ship in the TypeScript package (the original prototype had none of
them):

- **Context compaction** — `--compact`, `--compact-threshold`,
  `--compact-keep-recent` (see [Sessions](#sessions)). In `serve` runs, a
  provider preset's additive `context_window` (Settings → Providers, tokens) is
  the fallback when no `--context-window`/`TWO_BROTHERS_CONTEXT_WINDOW` and no
  persisted `compaction.context_window` is set; when both roles resolve to a
  preset window the **smaller** one applies (a summary sized for the larger
  model must not overflow the smaller one), and the settings view reports it as
  `source: "preset"`. CLI `run`/`chat`/`tui` build compaction from their
  configured budgets only and do not read preset windows.
- **MCP role scoping** — the per-server `"role"` field (see [MCP tools](#mcp-tools)).
- **Automation output modes** — `--mode print|json`, `--json-events`
  (a bare `--json` selects `--mode json`; `TWO_BROTHERS_JSON` is its env
  spelling), and `run --stream` NDJSON.
- **Token-level streaming & slash commands** — `run --stream
  --stream-tokens` adds one `token` NDJSON record per provider text delta
  (env `TWO_BROTHERS_STREAM_TOKENS=1`), and the chat REPL expands markdown
  `/name args` commands (`--commands-dir`, env `TWO_BROTHERS_COMMANDS_DIR`;
  `GET /api/commands` serves metadata only, never template bodies).
- **Provider error classification** — an ordered registry decides which
  failures retry (408/409/429/5xx and transport errors) and which fail fast
  (other 4xx, quota/billing, context overflow); a retryable response's
  `retry-after-ms` (milliseconds) or `Retry-After` (seconds or HTTP-date)
  replaces that attempt's fixed backoff — both capped at 120 s, with
  `retry-after-ms` winning — the fallback exponential schedule carries a
  0–25% jitter reduction, and a context-overflow payload triggers
  compact-and-retry instead of burning the retry budget.
- **Anthropic extended thinking** (TS package) — `--thinking-budget <n>`
  (`TWO_BROTHERS_THINKING_BUDGET`, run-level for both roles) makes every
  Anthropic Messages request carry
  `thinking: {type:"enabled", budget_tokens:n}` (plain, streaming and
  tool-loop calls). The API requires `n >= 1024` and `max_tokens > n`; when a
  provider's effective `--max-tokens` leaves no room, that provider raises its
  request cap to `n + 1024` and warns once (an explicit `--max-tokens` is
  otherwise sent untouched; with both roles on Anthropic there can be one
  warning per provider). `temperature` is omitted while thinking is enabled
  because the API rejects it there (its default applies).
  The signed thinking blocks (including `redacted_thinking` payloads) are
  captured from the response and echoed verbatim as the first content blocks
  of subsequent tool-loop assistant turns; they stay internal and never enter
  the protocol transcript, session JSONL or the other adapters, which ignore
  the option and keep byte-identical requests. Unset keeps every request
  byte-identical to before. See
  [Anthropic extended thinking](#anthropic-extended-thinking-ts-package).
- **Mid-run steering** — an operator can steer a cooperation cycle that is
  already working instead of only queueing the next task. A steer is appended
  to the shared context as an ordinary `user`→`senior` `message` envelope
  whose payload text starts with the documented `[[OPERATOR STEER]] ` marker
  (dense `seq`, session JSONL included; no protocol kind/field change), so
  the next provider call sees it inside `Context events:`. `POST
  /api/runs/{run_id}/steer` queues one text for a `running` run or one parked
  on an approval (`waiting`); the web composer exposes it as **Steer run** /
  `Alt+Enter`, and a bounded in-memory queue (8 pending texts of at most
  4 000 characters, at most 16 steer envelopes per run) is drained at every
  state-machine node boundary and tool-loop iteration. A text accepted with a
  `200` that later hits the per-run envelope cap is reported through the
  additive `steering_dropped` runtime event and the run record's
  `steering_dropped` field, and nothing is appended after a stop. The TUI
  queues the composer text with `Ctrl+N` (also the palette) under the same
  bounds, clears the draft only on acceptance and reports leftovers honestly;
  see [`tui`](#tui-initial-task) and the API row below.
- **TUI copy, terminal attention and external editor** — `Ctrl+X` copies the
  newest committed decision (or the newest completed senior reply) as plain
  text, native clipboard first with an OSC 52 fallback and an honest
  route-specific notice; `Ctrl+G` edits the composer draft in
  `$VISUAL`/`$EDITOR` (idle-only, 256 KiB read-back cap, workspace binary
  planting refused); the OSC 0 title carries
  `Two Brothers — <session> · working|approval|done|failed`, is restored on
  every exit path, and a parked approval emits one OSC 9/BEL notification
  (tmux DCS passthrough inside `tmux`). See
  [`tui`](#tui-initial-task) and [`keyboard.md`](keyboard.md).
- **Anthropic prompt caching** (TS package) — every Anthropic Messages
  request carries up to three `cache_control:{type:"ephemeral"}` breakpoints:
  the merged system prompt, the last tool definition and the last content
  block of the newest conversation turn. The system prompt is kind-stable —
  the per-node few-shot block rides on the transcript user turn — so nodes with
  the same role and tool belt send the same prefix (the senior's verify slice
  and empty-belt decision call still differ, and their tool schemas differ too).
  The repeated prefix of a cooperation cycle (system + tool schemas + growing
  transcript) is read from Anthropic's 5-minute prompt cache on the 2nd..Nth
  call, which lowers latency and input cost; a single-call run instead pays the
  1.25× cache-write premium
  on the marked prefix (prompts below the model's cache minimum are accepted
  with the markers ignored). There is no flag or setting — caching is
  unconditional — and OpenAI-compatible/Gemini request bodies never carry the
  field. `cache_read_input_tokens` is mapped to `cached_tokens` (cache writes
  are not hits), so the existing footer `cache N%` segment becomes
  meaningful for Anthropic; no real-model cache-hit evidence is recorded yet
  and `ttl`/opt-out are follow-ups.
- **Run-scoped file undo (web + API + CLI)** — a workspace-bound `serve` run
  records the pre/post bytes of every `workspace_write_file`/`workspace_edit_file`/
  `workspace_delete_file` mutation under `<sessions>/undo` (bounded, fail-soft,
  content-addressed, never part of the session JSONL; newest 20 per session and
  30-day retention, with orphan-blob GC on capture close and on discard).
  `GET /api/sessions/{name}/undo/{run_id}` previews each recorded file against
  the live workspace (`applicable`/`created`/`deleted`/`changed-since`/`skipped`/
  `missing`), `POST` restores/deletes the reversible ones (re-checking each file
  immediately before touching it, so post-run edits are refused per file; POSIX
  mode is restored best-effort), and `DELETE` discards the record and collects
  unreferenced blobs. `two-brothers sessions undo <name> [--run <id>]
  [--apply|--discard] [--json]` is the CLI counterpart (preview by default).
  The web workspace offers **Undo file changes…** for the newest completed run
  of the selected session; the action is hidden with an honest notice when the
  backend has no record (404) and is unavailable while a run is live or a
  compaction is in flight. Shell-made changes, untracked files and CLI/TUI runs
  are out of scope. See the API row below for the exact contract.
- **Plugins** — see `docs/plugins.md`.
- **Skills** — role-scoped `SKILL.md` catalogs (see [Skills](#skills-ts-package)).
- **Provider presets, onboarding, cost** — the curated seeded table (hosted
  providers, subscription plans, LM Studio, custom) keyed by env-var names,
  `onboard` to write per-role settings, `models` to list an endpoint's
  models, a `cost:` line (and `cost` in `--mode json`) from a hand-maintained
  price table, and per-role `--max-tokens` output caps. A customized built-in
  seed can be reset to its canonical default from Settings → Providers
  without touching the Senior/Junior role assignments, and **Refresh models**
  probes the current draft's OpenAI-compatible endpoint through
  `POST /api/providers/{name}/discover` without saving anything.
- **Session-scope approvals** — an approval card's **Always allow this session**
  decision remembers an `(action, target)` pair for that session
  (`{"scope": "session"}` on the approval route, persisted in
  `sessions/settings.json` and cleared with the session); one-shot allows and
  denials, the fail-closed default and the denial cap are unchanged.
- **Human terminal output** — separated, Markdown-rendered envelope blocks, a
  ruled decision, a compact usage footer, width-aware help tables and — on an
  interactive terminal — live block-by-block streaming with dim activity rows
  (`--live`/`--no-live`; see [Human text output](#human-text-output-ts-package)).
  Machine modes stay byte-identical.
- **TUI workspace runs and approvals** — `tui --workspace <dir>` gives the TUI
  the confined workspace tools, the senior's read-only verify slice, a docked
  approval panel for mutations/shell (numbered decisions, `Ctrl+E` preview,
  in-memory session allows) and `@path` file mentions. The effective
  [approval mode](#approval-modes) decides whether a mutation parks;
  `/permission` states it, persists a choice and accepts
  `/permission <mode>`, while `--approval-mode`/env pins it for the process
  (see [`tui`](#tui-initial-task)).
- **TUI provider connection** — the TUI reads the same persisted provider
  settings as the server path (web Settings, `serve`, `onboard`) and resolves
  the same effective endpoints; `/provider` (also `/settings` →
  **Connect provider…**) shows a key-free per-role summary and connects a
  preset or manual endpoint through one atomic, encrypted settings write (see
  [Provider connection](#provider-connection-provider)).
- **Tool calling for both brothers** — in consult mode the senior's opening,
  the junior's proposal/revision and the senior's review may call the role's
  **read-only** tool belt (workspace reads/searches, MCP tools, plugin tools —
  never the workspace mutations) before emitting the structured reply; a
  tool-less configuration or a provider without `chatWithTools` keeps the
  exact pre-tools request path. Work mode is unchanged (junior mutating
  deliverable loop, senior read-only verify slice).
- **Permission presets and approval modes** — four named presets (Read only,
  Always ask, Workspace write, Full access) alias the persisted modes
  `readonly`, `ask`, `edits` and `allow-all`; edited from the web Settings →
  Permissions section, the TUI `/settings` → Permissions action and the TUI
  `/permission` dialog, with the legacy mode names still accepted. Pinned per
  process with `--approval-mode`/env; workspace confinement and the
  sensitive-path refusal apply in every preset and a preset can never be set
  by the model (see [Approval modes](#approval-modes)).
- **Prompt recall** — `Up`/`Down` walk earlier accepted tasks in both
  composers, preserving and restoring the live draft exactly. The TUI uses
  its persisted prompt history (single-line drafts recall immediately;
  multiline drafts only at their very edges); the web composer keeps a
  bounded `localStorage` history (`two-brothers.composerHistory.v1`, newest
  first, 100 entries) and recall only applies while no picker is open.
- **Explicit provider provenance** — `--provider` (even a value that repeats
  the default) or `TWO_BROTHERS_PROVIDER` is an explicit operator request and
  overrides a persisted non-default provider; without either, persisted
  providers survive (see
  [Provider connection](#provider-connection-provider)).
- **Plan and todo function** — the built-in `todo_write` tool records the whole
  plan, emits one additive `todo_updated` runtime event (sidecar-persisted) and
  feeds the TUI plan panel and the web Plan dock (see
  [Plan and todo function](#plan-and-todo-function-ts-package)).
- **Diagnostics and shell completions** — `doctor` reports the local
  environment and provider setup (human report or `--json`, exit 1 on a
  failing check), `config` prints the resolved configuration with per-field
  provenance and masked keys (`--json` for one stable object), and
  `completions <bash|zsh|fish|powershell>` prints a completion script
  generated from the same command/flag catalog as help.
- **Task input and dry runs** — `run -` (stdin, ≤ 1 MiB) and
  `run --task-file <path>` feed the task without shell quoting, and
  `run`/`chat --dry-run` print the resolved plan (config, tools, session,
  compaction, limits) with no model call and no session write.
- **Session search, export, fork and rewind** — `sessions search <query>`
  (human or `--json`, bounded snippets, newest sessions first),
  `sessions export <name> [--format markdown|json|html] [--output <path>]`,
  `sessions fork <name> [--at <seq>] [--name <new>]` (a verbatim prefix copy
  with an additive `parent` lineage link; the source is never modified) and
  `sessions rewind <name> --turns <n>` (drop the last operator turns; the
  rewritten session clears the removed runs' runtime-event sidecar). The
  server exposes the same data at `GET /api/search`,
  `GET /api/sessions/{name}/export` and the matching session mutation routes.
  The web workspace searches message content from the Ctrl+K palette and
  exports a session from its row menu.
- **TUI** — `tui [task]` (also the bare interactive `two-brothers`) is a
  zero-dependency full-screen chat in the terminal's alternate screen over
  the same harness and flags: block transcript with textual role labels, a
  multiline grapheme-aware composer with bracketed paste, a two-line status
  bar, Ctrl+P palette / `?` help from one keymap registry, session and model
  pickers, Ctrl+F find-in-transcript, width-aware folded tool-result previews
  (six visual rows by default; `Ctrl+T` toggles preview/full text), and
  non-blocking turns with Escape/Ctrl+C cancellation.

## Examples

All examples assume the TypeScript package build (`cd packages/harness` after
`npm run build`).

```powershell
# compact output
node dist/cli.js run "Pick a testing scheme" --provider mock

# verbose output with payloads
node dist/cli.js run "Pick a testing scheme" --provider mock --verbose

# only the final decision as JSON (--mode print narrows print output;
# a bare `--json` without --mode prints the full machine-readable object)
node dist/cli.js run "Pick a testing scheme" --provider mock --mode print --json

# pipe-clean automation output (decision text on stdout only)
node dist/cli.js run "Pick a testing scheme" --provider mock --mode print

# one machine-readable JSON object ({events, decision, usage, rounds, errors});
# diagnostics stay on stderr
node dist/cli.js run "Pick a testing scheme" --provider mock --mode json

# delegation
node dist/cli.js run "Write hello world" --provider mock --mode work

# local diagnostics: human report and one machine-readable object
node dist/cli.js doctor --provider mock
node dist/cli.js doctor --provider mock --json

# resolved configuration with per-field sources (keys masked), and as JSON
node dist/cli.js config --provider mock
node dist/cli.js config --provider mock --json

# task from stdin / a file; a dry run prints the plan and writes nothing
Get-Content task.txt | node dist/cli.js run - --provider mock --dry-run
node dist/cli.js run --task-file task.txt --provider mock --dry-run --json

# shell completions (write the output to your shell's completion location)
node dist/cli.js completions bash
node dist/cli.js completions powershell

# inspect persisted sessions (JSON array, then one session's envelopes)
node dist/cli.js sessions --sessions-dir sessions --json
node dist/cli.js sessions show session --sessions-dir sessions

# full-text search across sessions, and export one for reading/sharing
node dist/cli.js sessions search "migration" --sessions-dir sessions
node dist/cli.js sessions search "migration" --json --limit 5
node dist/cli.js sessions export session --sessions-dir sessions
node dist/cli.js sessions export session --format json --output session.json

# a real provider
node dist/cli.js run "Task" --provider openai `
  --base-url https://api.deepseek.com/v1 --api-key sk-... `
  --senior-model deepseek-chat --junior-model deepseek-chat
```

## Return codes

| Code | Meaning |
|---|---|
| 0 | success (including `doctor` when no check failed, a `--dry-run` plan, and a missing/empty sessions directory) |
| 1 | run error (the `errors` array in `--mode json`) / selftest FAIL / `doctor` with at least one failing check / unreadable session file |
| 2 | usage error: unknown command or option, missing task, shell or session argument, unknown session, invalid flag value, bad config, blank stdin/`--task-file` task, `--dry-run` with `--stream`, a `sessions search` query shorter than 2 characters, an unknown `sessions export` format |

## Signals

`run` and `chat` cooperate with termination signals instead of dying
mid-append. Each turn owns one `AbortController`; the first handled signal
aborts the in-flight provider call and the shell process tree, waits a bounded
cleanup budget (`TURN_CANCEL_BUDGET_MS`, 8 000 ms — `SHELL_DRAIN_BUDGET_MS +
1 000`), then exits with the conventional code. The handlers exist only while
a turn is active.

| Signal | Behavior |
|---|---|
| `SIGINT` (Ctrl+C) | Abort the turn, wait the bounded cleanup, exit `130`. In an interactive `chat` a Ctrl+C cancels the turn and returns to the `task>` prompt; a piped/non-TTY `chat` ends with `130`. |
| `SIGTERM` | The same cooperative path; the process exits `143`. |
| `SIGHUP` (POSIX only) | The same cooperative path; the process exits `129`. Windows has no `SIGHUP`. |
| second signal | Exit immediately with `128 + signal number` for that signal (`130`/`143`/`129`), without waiting for cleanup. |

One `[two-brothers] SIGINT received — cancelling the active turn (press
Ctrl+C again to exit immediately)` notice goes to stderr on the first signal
(`SIGTERM`/`SIGHUP` name their own repeat form), so machine stdout (`--json`,
`--json-events`, `--stream`, `--mode print`) stays byte-clean; in `--stream`
the records already emitted stay valid and no `result` record is invented. A
cancelled turn never reports success, and `--dry-run` installs no handler. An
idle `chat` REPL also installs no handler, so its prior Ctrl+C behavior is
unchanged. `serve` keeps its graceful shutdown and joins it on `SIGHUP` too
(see [`serve`](#serve)).
