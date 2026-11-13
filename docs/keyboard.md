# Keyboard and Shortcuts

This page collects the keys and help paths on the three surfaces — the CLI,
the web workspace, and the terminal UI. The TUI tables mirror
[`keymap.ts`](../packages/harness/src/tui/keymap.ts), the registry behind
`tui --help`, the in-app `?`/`F1` help and the `Ctrl+P` palette, so CLI help
and the app list the same chords.

## CLI

The CLI is command-driven; these are its help and discovery paths.

| Goal | Command |
|---|---|
| Command overview | `two-brothers help` |
| One command's flags and examples | `two-brothers help tui`, `two-brothers tui --help`, `two-brothers tui -h` |
| Full flag/environment reference | `two-brothers help --all` |
| Version | `two-brothers --version` (or `-v`) |
| Resolved configuration | `two-brothers config [--json]` |
| Local diagnostics | `two-brothers doctor [--json]` |
| One stored session | `two-brothers sessions show <name> [--json] [--limit N]` |
| Undo a run's file changes | `two-brothers sessions undo <name> [--run <id>] [--apply\|--discard] [--json]` (preview by default) |
| Search stored sessions | `two-brothers sessions search <query> [--json] [--limit N]` |
| Export a session | `two-brothers sessions export <name> [--format markdown\|json] [--output <path>]` |
| Completion script | `two-brothers completions <bash\|zsh\|fish\|powershell>` |
| Live CLI transcript | `two-brothers run … --live` / `--no-live` (live is the default on a TTY; piped output always prints once) |
| Workspace-bound TUI | `two-brothers tui --workspace <dir>` (tools, approval panel, `@path` mentions) |

`help <command>` and `<command> --help` print the same page; a near-miss
command or option gets a did-you-mean line, and usage errors exit `2`. `config`
prints each role field with its winning source and never a key value; `doctor`
runs the local checks and exits `1` only when a check fails; `sessions show`
writes the session summary plus one line per envelope.

### Completion install lines

`completions` is generated from the same command/flag catalog as `help --all`,
so it never drifts from the CLI. For an installed `two-brothers` (or
`npm link`), add one line to your shell profile:

```powershell
# bash
source <(two-brothers completions bash)
# zsh (after compinit)
eval "$(two-brothers completions zsh)"
# fish
two-brothers completions fish | source
# PowerShell 7+
two-brothers completions powershell | Out-String | Invoke-Expression
```

From a checkout, replace `two-brothers` with `node dist/cli.js` after
`npm run build`.

## Web workspace

| Where | Keys | Action |
|---|---|---|
| Anywhere outside the palette | `Ctrl+K` / `Cmd+K` | open the command palette |
| Palette search | `↑` / `↓` | move the highlight; wraps at the ends |
| Palette search | `Enter` | open the highlighted session or workspace, or run the action |
| Palette | `Esc` | close it from anywhere inside |
| Sidebar search | `Esc` | clear the query, then close search |
| Composer | `Enter` | send the task |
| Composer | `Ctrl+Enter` / `Cmd+Enter` | send without waiting (accelerated submit) |
| Composer | `Alt+Enter` | steer the followed run with the draft (applies at the run's next step; only while a run is working or waiting on an approval — it never queues a task) |
| Composer | `Shift+Enter` | insert a newline |
| Composer | `↑` / `↓` | recall the previous/next accepted task at the draft edges (single-line draft: anywhere; multiline: only at the very start/end); stepping past the newest entry restores the draft you were writing exactly |
| Composer `@` / line-start `/` | open the mention or command picker; `↑`/`↓` move, `Enter`/`Tab` insert, `Shift+Tab`/`Esc` dismiss (the draft is kept) |
| Conversation (composer focused) | `Esc` `Esc` (within 500 ms) | stop the followed run; a single `Esc` keeps its normal layering |
| Anywhere outside a text field | `?` | open the commands & shortcuts overlay |
| Anywhere | `Ctrl+/` / `Cmd+/` | open the commands & shortcuts overlay |
| Workspace group grip | drag / drop onto another group header | reorder workspaces (persisted; pointer only). The group `⋯` menu `Move up`/`Move down` is the keyboard path |
| Approval card | `y` / `n` / `a` | allow once / deny / always allow this session while the card has focus |
| Approval card preview | `Tab`, then `Enter` / `Space` | expand or collapse the bounded diff/command preview (native button; collapsed by default) |
| Folded activity summary | `Tab`, then `Enter` / `Space` | expand or collapse that completed run's folded tool/activity rows (native button) |
| Welcome hero starter | `Tab`, then `Enter` / `Space` | put the suggestion in the composer (editable, never sent) |
| Mobile drawer | `Esc` | close the drawer when it is the topmost layer |
| Dialog | `Esc` | close the topmost dialog |
| Accent radio group (Settings → Appearance) | `Tab` into the group, then `↑`/`↓` | choose Blue, Violet, Teal or Amber; applies immediately and persists per device (independent of light/dark and density) |
| Role colours radio group (Settings → Appearance) | `Tab` into the group, then `↑`/`↓` | choose Default, High contrast or Neutral; changes only the Senior/Junior/Operator identity colours (never the accent), applies immediately and persists per device |
| Session actions trigger | `↓` | open the row menu; `↑`/`↓`/`Home`/`End` move, `Esc`/`Tab` close |
| Workspace actions trigger | `↓` | open the workspace group menu (`Rename…`, `Move up`, `Move down`); same keys as the session menu; the trigger is revealed on hover/focus |

The workspace group menu renames a workspace (a small dialog pre-fills and
selects the name: `Enter` saves, `Esc` cancels, blank names show an inline
error, names are capped at 120 characters) or moves it up/down in the persisted
order — `Move up`/`Move down` are disabled at the ends, the list updates
optimistically and rolls back with a toast if the backend rejects the move.
You can also drag a group by its pointer-only grip handle and drop it on
another group header: an accent line shows the insert position, the order
persists through the same API and rolls back with a toast on failure. The
handle is out of the tab order (the menu stays the keyboard path), is hidden
while filtering one workspace or on touch devices, and the whole header is not
a drag source. The menu only appears in the unfiltered, non-searching list where
group headers exist, and the trigger never collapses the group.

The row menu also exports the session as Markdown, JSON or a single
self-contained HTML page (`Export as Markdown` / `Export as JSON` / `Export as
HTML`; the file downloads with a name derived from the session), and offers
`Fork session…` — a copy of the conversation into a new session file, with the
original left untouched and forking unavailable while a run is active for that
session. The session actions trigger row covers the menu's keyboard navigation
(including these new items).

A message bubble in the transcript also offers **Fork from here…** (the
accessible name of a compact `fork` button on operator messages). It copies the
conversation up to and including that message into a new session (`{seq}`) and
opens the fork; the original file and sidecar are untouched, and the action is
unavailable while a run is active for the session.

An operator message in the transcript carries a **Rewind** button (a real
button: `Tab` to it, then `Enter`/`Space`): it opens a destructive confirmation
naming the messages and operator tasks that would be removed, then rewrites the
session file so that task and everything after it is gone while the earlier
transcript is kept. It is unavailable while a run is active for the session or
the context is being compacted, and a task already folded into a compaction
summary cannot be rewound. A rewind also clears the removed runs'
tool/approval history from the runtime sidecar; it cannot be undone.

Below the conversation, the newest completed run of the selected session also
offers an **Undo file changes…** bar (a real button: `Tab` to it, then
`Enter`/`Space`; only while no run is live and no compaction is in flight).
It opens a per-file preview and apply dialog for exactly the files that run
mutated through the workspace tools — files changed since the run are refused,
never overwritten, and shell-made or untracked changes are out of scope. An
older backend without the undo routes hides the bar after one honest notice.

- **Palette.** Opens with the search field focused and empty; typing filters
  sessions, workspaces and actions, grouped in that order. Once the query is
  at least two characters long, the palette also searches session message
  content after a short debounce and lists matching hits in a `Messages`
  group below Sessions; `Enter` on a hit opens that session. A backend
  without `/api/search` simply hides the group. The footer shows
  `↑ ↓ navigate · Enter select · Esc close` and the match count. `Enter` is
  claimed only while the search field has focus (a focused footer button keeps
  its native behavior) and `Esc` closes from anywhere inside the palette. The
  chord is ignored while focus is already in the palette (no double toggle),
  and focus returns to the trigger when it closes. The header's Search chip
  opens the palette too.

- **Platform difference.** On macOS the chip reads `⌘ K` and `Cmd+K` is the
  natural chord; `Ctrl+K` also works, and both modifiers are accepted on every
  platform.

- **Search and session switch.** The sidebar's Search action opens a title
  filter over the session list; `Esc` clears a non-empty query, and `Esc` again
  closes the field and returns focus to Search. Session rows are buttons, so
  `Tab` to one and press `Enter` (or `Space`) to switch; a palette session
  entry does the same from the keyboard. Either way the mobile drawer closes.

- **Composer.** `Enter` sends, `Shift+Enter` breaks the line and
  `Ctrl+Enter`/`Cmd+Enter` sends without waiting. Held-down `Enter` never
  machine-guns sends, and an IME composition never submits. Sending stays
  available while the brothers work — the send control reads **Queue** and the
  task joins the server's FIFO behind the current run (a queued task is
  cancelled with its row's **Stop** in the queue dock). `Enter` becomes a
  newline only while a run waits for approval (the box stays usable for a
  draft), and a one-task-at-a-time guard keeps a second `Enter` from sending
  the same text twice before the first submission is accepted. While a run
  works, `Alt+Enter` (or the **Steer run** button) applies the draft to that
  run at its next step; `Enter` still queues a new task behind it, the steer
  is not recorded as a recalled task, and the draft clears only when the
  server accepts it.

- **Mentions and commands.** Type `@` at a token start for the `@` picker over
  shared skills and workspace files (emails/word-internal `@` never trigger;
  a workspace is needed for files), or `/` at a line start for the slash
  command menu. The `/` menu lists built-in commands first (priority order)
  then discovered templates (alphabetical), with action rows badged and
  described; searching also matches aliases (including the reference Chinese
  spellings) and descriptions. `↑`/`↓` move,
  `Enter`/`Tab` insert `@skill:name `, `@relative/path ` or `/name `,
  `Shift+Tab`/`Esc` dismisses and keeps the draft; while the picker is open
  `Enter` never submits. `@skill:` narrows to skills. Role-scoped
  (senior/junior) skills are listed but not insertable — the server only
  attaches shared operator mentions. Selecting or typing an action command
  (`/compact`, `/export`, `/help`, `/status`, `/permission`, `/mode`, `/new`)
  performs it locally and never submits it as a run; a typed non-ASCII alias
  (e.g. `/目标`) is answered with a notice naming the canonical spelling
  instead of being sent, and a typed `/mode consult|work` applies the
  composer mode (an invalid or missing argument shows the usage). While a
  manual compaction runs, Send is locked with a "Compacting context…" hint
  until it finishes.

- **Commands and shortcuts overlay.** `/help`, `?` or `Ctrl+/`/`Cmd+/` opens
  the overlay listing the built-in commands and the shortcut table (send,
  accelerated send, newline, stop, palette, find, new session, theme,
  settings, escape layering).

- **Live thinking and response.** While a followed run generates, a dim
  collapsible **Thinking** block streams the model's reasoning and
  auto-collapses when visible reply text starts; a **Response** block renders
  the reply (markdown) with a streaming caret. Both disappear when the
  completed envelope arrives (the normal bubble takes over). Reasoning is
  observational: it is never persisted, never part of the reply, and never
  searched by Ctrl+F.

- **Prompt recall.** `↑`/`↓` walk the tasks you have actually submitted
  (accepted runs, including queued ones) newest first, and the draft you were
  writing is preserved and restored exactly when you step past the newest
  entry. A recalled entry is not counted as a draft edit, so switching
  sessions never turns it into a saved draft. Recall only applies while the
  mention/command picker is closed; IME composition, auto-repeat, a held
  modifier (`Shift`+arrow selects, `Ctrl`/`Alt`/`⌘`+arrow jumps) and a
  non-collapsed selection keep their normal editing behavior. The history is a
  bounded local store (`two-brothers.composerHistory.v1`: newest first, 100
  entries, consecutive duplicates dropped) and survives a reload; an unsent
  draft is never recallable. The history is **global** — it remembers tasks
  from every session on this device — while an unsent draft belongs to its
  session, so stepping past the newest recalled task restores that session's
  draft exactly. When there is nothing to recall (no history, or the caret is
  not at a recall edge) the arrow keys fall through to the textarea's normal
  caret movement.

- **Stop and approvals.** Stop is the composer's Stop button (Tab to it, press
  `Enter`/`Space`); it is cooperative and denies pending approvals. Pressing
  `Esc` twice within 500 ms in the conversation also stops the followed run
  (fail-soft, blocked while a dialog/approval owns focus or an IME
  composition is active; a single `Esc` keeps its normal layering). The docked
  approval card is focusable: `y` allows once, `n` denies and `a` allows the
  identical requests for the rest of the session while it has focus, all
  ignored while an input has focus; the **Allow once**/**Deny**/**Always allow
  this session** buttons always work. A session grant saves the
  `(action, target)` pair in `sessions/settings.json` and is removed with the
  session; against an older backend the card says it allowed once instead.
  The card shows a fixed honest reason for shell/delete requests (write/edit
  rely on their diff) and offers a collapsed-by-default diff/command preview
  toggle — both are plain buttons, no new chords.

- **Folded activity, plan and status seats.** Completed runs' tool/prompt-audit
  rows fold into one disclosure button (`… N tool calls · expand`, with
  `in M runs` when the group spans several runs; `Tab` + `Enter`/`Space` toggles
  it; the followed run and every conversation row stay open, and a collapsed
  row is absent from find). A **Plan** dock above
  the composer mirrors the model's `todo_write` plan (`✓`/`▸`/`○`, up to four
  rows, a real expand button, a polite live announcement; display-only — no
  keys). The composer's status seats state the models, the real permission
  expectation and the latest prompt audit's exact char/tool counts; unknown
  data hides its seat, and no numbers are fabricated.

- **Welcome hero.** With no session selected — or a selected empty session —
  the landing state shows the workspace context, actions (New session, Add a
  workspace, Set up models, Keyboard shortcuts) and starter suggestions that
  only prefill the composer (never sent). All are ordinary buttons: `Tab` to
  one and press `Enter` / `Space`.

- **Theme.** The sidebar footer's Light/Dark/System radio group sets the theme
  — Settings → Appearance and the palette's `Theme: …` actions do the same. The
  choice persists in localStorage; System follows the OS and updates live.

- **Find in the conversation.** `Ctrl+F` (or `Cmd+F` on macOS) opens the find
  bar over the transcript: `Enter` goes to the next match, `Shift+Enter` to the
  previous one, and `Esc` closes it and clears the highlights. The bar shows the
  current match out of the total and can switch to case-sensitive matching; the
  palette and dialogs stay above it, so `Esc` unwinds the find bar before them.

- **Density.** Settings → Appearance's Density radios (or the palette's
  `Density: …` actions) switch Comfortable/Compact spacing. The choice persists
  and is applied before the first paint.

- **Mobile drawer and focus.** At 768 px and narrower the sidebar starts
  closed. The Show sessions button opens it and moves focus to Collapse
  sidebar; the chat shell becomes inert; `Esc`, the backdrop, or a session pick
  closes it and returns focus to the Show sessions button. Dialogs trap focus
  while open and restore it to their trigger on close. The first Tab stop is
  the Skip to composer link; `Enter` moves focus into the task box.

### Rebinding the three global chords

Settings → **Keyboard** rebinds three device-local chords: the command palette
(default `Ctrl/⌘ K`), find in the conversation (default `Ctrl/⌘ F`) and this
shortcut reference (default `Ctrl/⌘ /`). Ctrl and ⌘ are treated as the same
modifier — labels show your platform's key — so one binding works across
devices. A chord needs `Ctrl/⌘` plus one printable key; duplicates across the
three actions, `Alt` combinations, plain keys and chords the browser reserves
(`Ctrl/⌘` + `L`/`W`/`T`/`N`/`R`/`Q`, plus their Shift variants) are refused
inline and not saved. A Change button enters capture mode (announced through
`role=status`); Escape cancels the capture without closing Settings, and
conflicts show a `role=alert` message while capture stays active. `?` stays a
fixed alias for the shortcut reference, and every other shortcut in the tables
above is fixed. The choice is stored in this browser only
(`two-brothers.keybindings.v1`); `Reset all to defaults` restores the defaults.

## Terminal UI (TUI)

`tui --help` prints the same lines, and the help overlay and palette are built
from the registry at runtime. The TUI is Ctrl-based: terminals do not deliver
`Cmd`, so the TUI's modifier chords are `Ctrl`, never `Cmd`.

### Open

| Keys | Action |
|---|---|
| `Ctrl+P` | Command palette: search every command, key binding and slash template. |
| `?` or `F1` | Keyboard help: a filterable list of every command and key. `?` opens it only while the composer is empty — with text there it types a literal question mark; `F1` always opens it. |
| `Ctrl+Y` / `/agents` | Helpers: the Senior's helper subagents for this session (status, live activity, elapsed time, tokens), with the selected child's transcript one `Enter` away. Opens (and closes) while a turn runs; `Esc` closes it. The same list is the **Helpers** row in the `Ctrl+P` palette. |

### Rebinding the three global chords

The three global chords — the command palette (default `Ctrl+P`), the shortcut
reference (`?`/`F1`) and the draft stash (`Ctrl+O`) — can be rebound from a
versioned JSON file:

```json
{"version": 1, "bindings": {"palette": ["ctrl+l"], "help": ["f2"], "stash": ["ctrl+u"]}}
```

Point the TUI at it with `tui --keys-file <path>` or
`TWO_BROTHERS_TUI_KEYS_FILE` (flag > env > default
`~/.two-brothers/tui-keys.json`; a missing file means the defaults, and the
file is read at startup, never persisted). Chord specs are
`[ctrl+][shift+][alt+]key` in any modifier order and case-insensitive
(`control`, `meta` and `opt` are accepted aliases for the three modifiers),
where `key` is one named terminal key (`return`, `escape`, `tab`, `pageup`,
arrows, `f1`…`f12`, …) or exactly one printable character; because `+` is the
spec separator, a literal `+` cannot be the final key. Each command accepts at
most four chords. Unmodified letters/digits,
the structural keys (Return/Escape/Tab/arrows/page/navigation/space) and
`Ctrl+C/Z/Q/S` are refused, as are duplicates and chords that would collide
with a fixed binding. An invalid, oversized, wrong-version, unknown,
non-rebindable or conflicting file prints one `[tui keys]` diagnostic on
stderr and keeps the defaults (the TUI still starts). The effective chords
appear in both `tui --help` (honors `--keys-file`) and `help tui` (the
env/default file only — the `help` command has no `--keys-file` flag), as well
as in the `?` overlay, the palette and the status hints;
typing keys, Escape/quit layering, the composer, pickers/overlays, the
approval panel and the find bar stay fixed.

Edit the file externally and apply the edit without restarting in one of two
ways:

- **On demand — `/keys reload`.** Re-reads the startup-captured file and
  live-swaps the active table, so matching, the palette/help listings and the
  status hints use the new chords immediately; the notice names the new
  chords. A failed reload keeps the previous chords with one bounded
  diagnostic, and a missing file keeps them with an informational notice.
- **Automatically — `tui --keys-watch` or `TWO_BROTHERS_TUI_KEYS_WATCH=1`.**
  Opt-in and off by default (never persisted): the TUI polls the captured
  path with `fs.watchFile` (about twice a second, debounced/coalesced, so a
  save-by-rename or the creation of a previously absent file is seen) and
  applies each detected change through the same validated reload path. A
  valid change swaps the table and posts one bounded notice naming the new
  chords; an invalid file keeps the last good chords with one bounded warning
  per detected change (no repeat spam while the file stays unchanged); an
  absent or unreadable file keeps them with an informational notice. The flag
  and env var are captured at startup (changing them needs a restart); only
  the file's contents keep reloading. Without the flag or env var, the TUI
  behaves exactly like the on-demand-only session, including byte-identical
  startup frames.

`/keys show` reports the effective global chords, the file path/origin (flag,
env or default), the last load state and the honest watch state (`on`, `off`,
or `unavailable` when the session has no captured keys-file source to watch);
it never claims overrides that are not active. The path/origin are captured
at startup, so changing `--keys-file`/the env needs a restart.

### Compose and send

| Keys | Action |
|---|---|
| `Enter` | Send the composer text as the next task. |
| `Shift+Enter` or `Ctrl+J` | Insert a newline instead of sending. |
| `Tab` | Complete a partially typed slash name when exactly one built-in or discovered template matches; inside an open picker it accepts the highlighted row. |
| `Up` / `Down` | Recall earlier submitted tasks: a single-line draft recalls immediately; on a multi-line draft the arrows only leave the composer at its very start (Up) or very end (Down) and otherwise move the caret inside the draft. The live draft is preserved and restored exactly when you come back to it, and recall never adds to the persisted history. |
| `Ctrl+R` | Incremental prompt-history search, newest first; accepting puts the entry back in the composer. |
| `Ctrl+O` | Stash the draft, or restore the stashed draft. |
| `Ctrl+G` | Edit the composer draft in `$VISUAL`/`$EDITOR` (Windows falls back to `notepad.exe` when no variable is set); idle-only, refuses while a turn/compaction runs or an overlay owns the keyboard. A nonzero exit leaves the draft untouched. |
| `Ctrl+X` | Copy the last completed reply (the newest decision, or the newest completed senior reply) as plain text: the platform clipboard is tried first, then OSC 52 where no OS clipboard is reachable, with an honest route-specific notice. A fixed binding, not one of the three rebindable global chords. |
| `Ctrl+N` | Queue the composer text for the **running** turn; it applies at the run's next step (never a new task). At most 4 000 characters and eight pending texts; a blank/oversized draft or a full queue is refused with an honest notice, never silently truncated. The draft clears only on acceptance, the notices distinguish a queued steer from still-pending leftovers (an applied steer appears in the transcript), and leftovers at turn end are reported. `Enter` while a turn runs still refuses (and names this chord). The `Ctrl+P` palette's **Steer the running turn** row does the same. |
| `/` (line start) | Inline command picker. It groups the TUI's own commands first, then built-in prompts and built-in actions (each row badged `builtin`/`action`), then discovered `<name>.md` templates with a `usage — description` footer for the highlighted row. `↑`/`↓` move, `Enter`/`Tab` insert or run, `Shift+Tab`/`Esc` closes and keeps the draft. |
| `@` (token start) | Inline mention picker. Shared skills insert `@skill:name ` and role-scoped rows are visible but disabled; in a `--workspace` run, a path-like `@dir/file` token opens the workspace-file picker and inserts the canonical `@path ` token (the file is attached read-only before the turn). File mentions stay literal text only when no workspace is bound. |
| (held key) | A held-down `Enter`/`Tab` cannot repeat a submit: explicit key-repeat events and identical presses on unchanged text within 400 ms are ignored, while a deliberate press after typing is accepted. |

### Steering a running turn

`Ctrl+N` sends the composer text into the **running** turn at its next step —
it is not a queued task and it never starts a run. The queue carries the
runtime's bounds (eight pending texts, 4 000 characters each), the draft is
cleared only when the steer is accepted, and the notice names how many texts
are pending; a steer still queued when the turn ends is reported as not applied
rather than silently dropped.

`Ctrl+S` is deliberately **not** the chord: many terminals keep it for XOFF
output flow control, so pressing it can freeze the screen until `Ctrl+Q` (XON).
Use `Ctrl+N`, or the `Ctrl+P` palette's **Steer the running turn** row, which
queues exactly the same text under the same caps (there is no typed `/steer`
form). The action exists only while a turn runs; with no turn it refuses and
says so. Unlike the web, the TUI has no queue dock: the pending count is
reported in the notice, not as a list. `Ctrl+N` is a fixed composer binding,
not one of the three rebindable global chords; the palette row is the fallback
that works on every terminal.

### Copying and terminal attention

`Ctrl+X` copies the last completed reply — the newest committed decision, or
the newest completed senior reply when there is no decision yet — as plain
text; junior proposals, tool results, streaming drafts and operator text are
never selected. The platform clipboard is tried first; where there is no OS
clipboard to reach (a remote/SSH session, a container, WSL without WSLg) or
every native writer fails, the TUI writes one terminal OSC 52 sequence. OSC 52
is a request the terminal may ignore (and `tmux` only forwards it with
clipboard passthrough configured), so when that is the only route the notice
names it (`via OSC 52`) instead of claiming a clipboard write. With nothing to
copy yet it prints one honest notice and copies nothing.

The terminal title (OSC 0) follows the session and run status:
`Two Brothers — <session> · working|approval|done|failed`, the plain
`Two Brothers — <session>` when idle, and `Two Brothers` with no session. It
changes on session start/switch and run transitions, is sanitized and capped at
120 characters, and every exit path restores the title the driver set. When an
approval parks, one attention notification is emitted — OSC 9 where the
terminal is known to support it, a tmux DCS passthrough inside `tmux`, a bare
BEL otherwise — never on a normal turn end or a cancelled run. The notification
text is sanitized and bounded, and a non-TTY or `TERM=dumb` session writes no
escape byte.

`Ctrl+G` opens the draft in `$VISUAL`/`$EDITOR` (Windows uses `notepad.exe`
only when neither variable is set). The editor owns the terminal while it
runs; on a clean exit the saved text replaces the draft (BOM stripped, CRLF
normalized, one final newline removed, read-back capped at 256 KiB). A nonzero
exit or spawn failure leaves the draft unchanged, and the action refuses while
a turn/compaction runs or an overlay, find bar or approval owns the keyboard.

### Read the transcript

| Keys | Action |
|---|---|
| `PgUp` / `PgDn` | Page the transcript without moving the composer cursor. |
| (streaming) | A live `THINKING` block (dim, bounded to the last six content rows with a `… +N lines` marker) appears above the streaming response while the provider emits reasoning; it clears when the reply/envelope arrives. Reasoning is live-only and never persisted. |
| `Ctrl+F` | Find in the transcript: an inline bar above the status rows. Typing filters live (case-insensitive literal text), `Enter`/`Down` jumps to the next match and `Shift+Enter`/`Up` to the previous one (both wrap); the bar shows `current/total`, marks the active match and scrolls its block into view. `Esc` closes it and restores the composer draft and scroll position exactly. `/find [query]` opens it with a query already typed. |
| `Ctrl+T` | Expand or collapse the most recent tool result: collapsed shows the first six result rows after width-aware wrapping plus a `… +N more lines` marker (N counts hidden visual rows), expanded shows the whole result. The model always keeps the full text. |
| `Ctrl+B` | Toggle the status side panel on wide terminals (it needs at least 100 columns and 20 rows; below that the transcript simply uses the full width). `/panel` does the same. |
| (plan dock) | A model-written plan shows above the composer (`✓` completed / `▸` in progress / `○` pending, at most four rows plus a `+N more` tail). Display-only: no key answers it and the composer keeps its normal keys. |
| (status bar) | The second status row rotates one registry-derived discoverability tip per accepted turn (`Ctrl+T fold tool output`, `Ctrl+F find in transcript`, `Ctrl+P commands`, …) and can briefly show a transient hint instead. Tips and hints only describe existing bindings — they add none. |

### Helper subagents (`Ctrl+Y` / `/agents`)

A TUI turn runs on the same helper tier as a `serve`/web run: the Senior may
delegate a focused side task to an isolated helper (its own conversation and
provider, so its usage never enters the brothers' numbers). `Ctrl+Y` (or
`/agents`, or the palette's **Helpers** row) opens the observer overlay, also
while a turn runs, which is when a live helper exists.

- **List** — newest first: status glyph (`●` running, `✓` completed, `✕`
  failed, `⊘` cancelled), label, elapsed time, live activity and (when
  settled) tokens; a session with more than 20 helpers ends with
  `+N older (not shown)`. An empty session says whether it simply has not
  delegated yet or is in-memory (an in-memory session never lists a previous
  run's helper logs — only its live helpers appear).
- **Detail** — `Enter` opens the selected child: label, model · role, status ·
  elapsed (plus `background` when set), tokens, then the bounded transcript
  (task, helper replies, tool calls with a short preview, approvals, and
  `Follow-up · operator`/`Follow-up · Senior` rows) and any error or final
  report. The transcript keeps the newest 400 rows and follows the tail;
  `PgUp`/`PgDn` page back, and `Esc` (or `Enter`) returns to the list.
  `Esc` layers detail → list → closed.

The list is rebuilt from the child logs when it opens and after each completion,
and live `subagent_*` events only update the activity line — a row never
appears in the brothers' transcript. While a helper exists the status bar gains
one `helpers N running · M done` segment after `cost`, and the side panel a
`HELPERS` row; both are absent (byte-identical frames) when there are no
helpers. A helper's workspace write/edit/delete/shell request parks on the
normal approval panel, which adds one dim `helper: <label>` row so the operator
knows who asked; the decision keys and the session-allow rules are unchanged.
The helper list reads the durable child store directly (no HTTP), and no new
timer is involved: the existing repaint while a turn runs refreshes the live
labels.

### Permissions and approvals (workspace-bound runs)

A run started with `tui --workspace <dir>` pauses on a workspace mutation or
shell command and replaces the composer with the approval panel. The effective
permission preset decides whether the panel appears at all: Read only
(`readonly`) denies mutations and shell commands before a card can park,
Workspace write (`edits`) lets writes and edits run, Always ask (`ask`) asks
for every mutation, and Full access (`allow-all`) runs everything without
asking (with a warning toast each turn). The preset is set from
`/permission`, `/settings` → Permissions, or
`--approval-mode`/`TWO_BROTHERS_APPROVAL_MODE`; see
[Approval modes](cli-reference.md#approval-modes). These keys
belong to the panel while it is open (the checked `approval` key scope — they
cannot collide with the composer, pickers or quit chord):

| Keys | Action |
|---|---|
| `1` / `y` | **Allow once** — approve this call only. |
| `2` / `a` | **Always allow this session** — approve this call and identical `(action, target)` requests for the rest of this TUI process. Memory only: never written to `settings.json`. |
| `3` / `n` / `Esc` | **Deny** — refuse the call. `Esc` denies exactly once and never answers a later request. |
| `Up` / `Down` | Move the highlight between the three numbered decisions (wraps). |
| `Enter` | Answer with the highlighted decision. |
| `Ctrl+E` | Open the full-screen preview of the pending diff or shell command. Closing the preview never answers the request — the panel stays parked. |

The composer is paused while an approval is pending; stopping/cancelling the
turn denies every pending request (fail closed), and a preview overlay closes
before `Esc` can deny. The panel owns the decision keys while it is open, so
`Ctrl+C` does nothing until the request is answered — the status bar shows
`deny to continue — Ctrl+C stops the turn after it resolves`. Deny (or allow)
first; `Ctrl+C`/`Esc` then stop the turn normally. After a stopped turn the
status bar briefly shows `turn stopped — Ctrl+C ×2 exits` (no key changes; the
hint clears on its own).

### Cancel, clear, quit

| Keys | Action |
|---|---|
| `Esc` | Close the open overlay first; with no overlay, cancel the running turn, then clear a non-empty composer, then arm the quit confirmation (`Esc` or `Ctrl+C` again leaves). |
| `Ctrl+C` | Labelled `Ctrl+C ×2`: cancel the running turn, clear a non-empty composer, then arm the quit confirmation; press it again to leave. Close an open overlay with `Esc` first. |

### Overlays (palette, help, pickers)

| Keys | Action |
|---|---|
| `Up` / `Down` | Move the highlighted row. |
| `Enter` | Open or run the highlighted item; a disabled row refuses and says why. In the helpers overlay it opens the selected child, and inside a child transcript it returns to the list. |
| `Esc` | Close the overlay and restore the previous focus. In the helpers overlay: child transcript → helper list → closed. |
| `Ctrl+Y` | With the helpers overlay open, close it (it toggles the overlay it opens). |
| `PgUp` / `PgDn` | Inside an open helper transcript, page backwards/forwards; the window follows the tail until you scroll back. |
| `Tab` / `Shift+Tab` | In the `/`, `@skill:` and workspace-file pickers: accept / dismiss (the text input keeps focus; Left/Right keep editing the draft). |

Overlays receive keys before the composer: while one is open, `Up`/`Down` move
the selection and never recall composer history, and `Esc` closes the overlay
before it can cancel a turn.

### Slash input

Every registry command also has a typed slash form — even when it has no
chord — and all are searchable in `Ctrl+P`: `/palette`, `/help` (`/h`),
`/commands`, `/find [query]`, `/agents`, `/retry`, `/stash`, `/exit` (`/quit`,
`/q`),
`/mode consult|work`, `/models`, `/sessions`, `/theme dark|light|system`,
`/settings` (provider summary, effective permission preset, and **Connect
provider…** / **Permissions…** actions), `/provider` (the provider connect
surface), plus discovered `<name>.md`
templates. `/models` and `/sessions`
refuse while a turn runs. The find bar is an inline input, not a modal: while
it is open it owns printable keys and the app chords (`Ctrl+P`, `?`, slash
commands) are inert, exactly like the palette and help overlays; `Esc` closes
it first. The mention picker behaves the same way while open (printable keys
filter, `Esc` closes).

The first-party built-in commands from the shared catalogue are available next
to the native set (a native command always wins its own name, and a discovered
template shadows a same-named built-in):

- **Prompt** — `/plan <objective>`, `/goal <objective>` and
  `/feedback [notes]` expand to a task and run that turn in `consult` mode;
  missing required arguments print `usage: /plan <objective>` and submit
  nothing.
- **Action** — `/compact` (compacts the context between turns through the
  configured senior endpoint and rewrites the session file; the visible
  transcript is unchanged), `/export [path]` (Markdown export; in-memory
  sessions need an explicit path), `/status` (session/context/panel details),
  `/permission` (the effective preset, its stored mode and honest description,
  the full-access warning, the bound workspace root, the decision keys and
  this process's in-memory session allows; without a `--approval-mode` pin
  its buttons persist one of the four presets — Read only, Always ask,
  Workspace write, Full access — to `sessions/settings.json`, with a pin it
  says so and offers only Close, and `/permission <preset|mode>` applies one
  directly — a pinned process refuses that change with the pin reason; an
  unbound TUI still states the preset and that it has no approval broker), and
  `/new` (a
  fresh in-memory session; on-disk sessions are refused honestly). Actions never
  become tasks; a refusal says why.

## See also

- [CLI reference](cli-reference.md) — every command, flag and environment variable.
- [Quickstart](quickstart.md) — first run and the web/terminal walkthroughs.
