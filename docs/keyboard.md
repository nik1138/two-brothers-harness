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
| Search stored sessions | `two-brothers sessions search <query> [--json] [--limit N]` |
| Export a session | `two-brothers sessions export <name> [--format markdown\|json] [--output <path>]` |
| Completion script | `two-brothers completions <bash\|zsh\|fish\|powershell>` |

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
| Composer | `Shift+Enter` | insert a newline |
| Composer `@` / line-start `/` | open the mention or command picker; `↑`/`↓` move, `Enter`/`Tab` insert, `Shift+Tab`/`Esc` dismiss (the draft is kept) |
| Conversation (composer focused) | `Esc` `Esc` (within 500 ms) | stop the followed run; a single `Esc` keeps its normal layering |
| Anywhere outside a text field | `?` | open the commands & shortcuts overlay |
| Anywhere | `Ctrl+/` / `Cmd+/` | open the commands & shortcuts overlay |
| Approval card | `y` / `n` | allow / deny while the card has focus |
| Mobile drawer | `Esc` | close the drawer when it is the topmost layer |
| Dialog | `Esc` | close the topmost dialog |
| Session actions trigger | `↓` | open the row menu; `↑`/`↓`/`Home`/`End` move, `Esc`/`Tab` close |
| Workspace actions trigger | `↓` | open the workspace group menu (`Rename…`, `Move up`, `Move down`); same keys as the session menu; the trigger is revealed on hover/focus |

The workspace group menu renames a workspace (a small dialog pre-fills and
selects the name: `Enter` saves, `Esc` cancels, blank names show an inline
error, names are capped at 120 characters) or moves it up/down in the persisted
order — `Move up`/`Move down` are disabled at the ends, the list updates
optimistically and rolls back with a toast if the backend rejects the move.
The menu only appears in the unfiltered, non-searching list where group
headers exist, and the trigger never collapses the group.

The row menu also exports the session as Markdown or JSON (`Export as
Markdown` / `Export as JSON`); the file downloads with a name derived from the
session.

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
  machine-guns sends, and an IME composition never submits. `Enter` becomes a
  newline while a run waits for approval (the box stays usable for the next
  draft) and is unavailable while the brothers work (the box is locked).

- **Mentions and commands.** Type `@` at a token start for a picker over
  shared skills and workspace files (emails/word-internal `@` never trigger;
  a workspace is needed for files), or `/` at a line start for the slash
  command picker. The menu lists built-in commands first (priority order)
  then discovered templates (alphabetical) then skills/files, with action
  rows badged and described; searching also matches aliases (including the
  reference Chinese spellings) and descriptions. `↑`/`↓` move,
  `Enter`/`Tab` insert `@skill:name `, `@relative/path ` or `/name `,
  `Shift+Tab`/`Esc` dismisses and keeps the draft; while the picker is open
  `Enter` never submits. `@skill:` narrows to skills. Role-scoped
  (senior/junior) skills are listed but not insertable — the server only
  attaches shared operator mentions. Selecting or typing an action command
  (`/compact`, `/export`, `/help`, `/status`, `/permission`, `/mode`, `/new`)
  performs it locally and never submits it as a run.

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

- **Stop and approvals.** Stop is the composer's Stop button (Tab to it, press
  `Enter`/`Space`); it is cooperative and denies pending approvals. Pressing
  `Esc` twice within 500 ms in the conversation also stops the followed run
  (fail-soft, blocked while a dialog/approval owns focus or an IME
  composition is active; a single `Esc` keeps its normal layering). The docked
  approval card is focusable: `y` allows and `n` denies while it has focus,
  both ignored while an input has focus; the Allow/Deny buttons always work.

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

## Terminal UI (TUI)

`tui --help` prints the same lines, and the help overlay and palette are built
from the registry at runtime. The TUI is Ctrl-based: terminals do not deliver
`Cmd`, so the TUI's modifier chords are `Ctrl`, never `Cmd`.

### Open

| Keys | Action |
|---|---|
| `Ctrl+P` | Command palette: search every command, key binding and slash template. |
| `?` or `F1` | Keyboard help: a filterable list of every command and key. `?` opens it only while the composer is empty — with text there it types a literal question mark; `F1` always opens it. |

### Compose and send

| Keys | Action |
|---|---|
| `Enter` | Send the composer text as the next task. |
| `Shift+Enter` or `Ctrl+J` | Insert a newline instead of sending. |
| `Tab` | Complete a partially typed slash name when exactly one built-in or discovered template matches; inside an open picker it accepts the highlighted row. |
| `Up` / `Down` | Recall earlier submitted tasks; on a multi-line draft they move within the draft until the cursor reaches the first or last line. The live draft is preserved and restored when you come back to it. |
| `Ctrl+R` | Incremental prompt-history search, newest first; accepting puts the entry back in the composer. |
| `Ctrl+O` | Stash the draft, or restore the stashed draft. |
| `/` (line start) | Inline command picker. It groups the TUI's own commands first, then built-in prompts and built-in actions (each row badged `builtin`/`action`), then discovered `<name>.md` templates with a `usage — description` footer for the highlighted row. `↑`/`↓` move, `Enter`/`Tab` insert or run, `Shift+Tab`/`Esc` closes and keeps the draft. |
| `@` (token start) | Inline skill picker. Shared skills insert `@skill:name `; role-scoped rows are visible but disabled. File mentions are not available in the TUI (terminal runs have no workspace). |
| (held key) | A held-down `Enter`/`Tab` cannot repeat a submit: explicit key-repeat events and identical presses on unchanged text within 400 ms are ignored, while a deliberate press after typing is accepted. |

### Read the transcript

| Keys | Action |
|---|---|
| `PgUp` / `PgDn` | Page the transcript without moving the composer cursor. |
| (streaming) | A live `THINKING` block (dim, bounded to the last six content rows with a `… +N lines` marker) appears above the streaming response while the provider emits reasoning; it clears when the reply/envelope arrives. Reasoning is live-only and never persisted. |
| `Ctrl+F` | Find in the transcript: an inline bar above the status rows. Typing filters live (case-insensitive literal text), `Enter`/`Down` jumps to the next match and `Shift+Enter`/`Up` to the previous one (both wrap); the bar shows `current/total`, marks the active match and scrolls its block into view. `Esc` closes it and restores the composer draft and scroll position exactly. `/find [query]` opens it with a query already typed. |
| `Ctrl+T` | Expand or collapse the most recent tool result: collapsed shows the first six result lines plus a `… +N more lines` marker, expanded shows the whole result. |
| `Ctrl+B` | Toggle the status side panel on wide terminals (it needs at least 100 columns and 20 rows; below that the transcript simply uses the full width). `/panel` does the same. |

### Cancel, clear, quit

| Keys | Action |
|---|---|
| `Esc` | Close the open overlay first; with no overlay, cancel the running turn, then clear a non-empty composer, then arm the quit confirmation (`Esc` or `Ctrl+C` again leaves). |
| `Ctrl+C` | Labelled `Ctrl+C ×2`: cancel the running turn, clear a non-empty composer, then arm the quit confirmation; press it again to leave. Close an open overlay with `Esc` first. |

### Overlays (palette, help, pickers)

| Keys | Action |
|---|---|
| `Up` / `Down` | Move the highlighted row. |
| `Enter` | Open or run the highlighted item; a disabled row refuses and says why. |
| `Esc` | Close the overlay and restore the previous focus. |
| `Tab` / `Shift+Tab` | In the `/` and `@skill:` pickers: accept / dismiss (the text input keeps focus; Left/Right keep editing the draft). |

Overlays receive keys before the composer: while one is open, `Up`/`Down` move
the selection and never recall composer history, and `Esc` closes the overlay
before it can cancel a turn.

### Slash input

Every registry command also has a typed slash form — even when it has no
chord — and all are searchable in `Ctrl+P`: `/palette`, `/help` (`/h`),
`/commands`, `/find [query]`, `/retry`, `/stash`, `/exit` (`/quit`, `/q`),
`/mode consult|work`, `/models`, `/sessions`, `/theme dark|light|system`,
`/settings`, plus discovered `<name>.md` templates. `/models` and `/sessions`
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
  `/permission` (the real fail-closed policy facts — the TUI has no approval
  broker), and `/new` (a fresh in-memory session; on-disk sessions are refused
  honestly). Actions never become tasks; a refusal says why.

## See also

- [CLI reference](cli-reference.md) — every command, flag and environment variable.
- [Quickstart](quickstart.md) — first run and the web/terminal walkthroughs.
