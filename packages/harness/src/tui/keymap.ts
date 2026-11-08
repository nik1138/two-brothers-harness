/**
 * The TUI's single command and key-binding registry.
 *
 * One table powers everything an operator can discover: the Ctrl+P palette,
 * the `?` help overlay, the `/help` text, slash-command lookup, key matching
 * in the app, the status bar's rotating tip ({@link rotatingFooterTip}) and the
 * `tui --help` key guide. Key labels are **derived** from
 * the `KeyChord` specs — no view or CLI string may spell a shortcut itself —
 * so a binding can never be documented in two different ways.
 *
 * A chord has a `when` scope: `"always"`, `"composer"` (the editor has focus),
 * `"transcript"` (scrolling), `"overlay"` (palette/help/pickers), `"find"`
 * (the inline transcript find bar) and `"mention"` (the inline `/` command and
 * `@skill:` mention pickers). The same physical key may therefore mean
 * different things in different scopes (`Up` = prompt history in the composer,
 * list movement in an overlay, previous match in the find bar) while still
 * having exactly one formatted label per command.
 *
 * Built-in slash commands (`/help`, `/commands`, `/mode`, `/exit`, …) are part
 * of the table; discovered `<name>.md` templates from `commands.ts` are
 * metadata-only inputs to {@link paletteEntries} / {@link documentEntries},
 * merged into the palette/help under "Slash commands" without touching the
 * template bodies. Nothing here performs I/O.
 */

/** Where a binding is active. */
export type CommandWhen =
  | "always"
  | "app"
  | "composer"
  | "transcript"
  | "overlay"
  | "find"
  | "mention"
  | "approval";

/** Help/palette grouping, in display order via {@link COMMAND_GROUPS}. */
export type CommandGroup =
  | "General"
  | "Composer"
  | "Transcript"
  | "Lists"
  | "Cooperation"
  | "Session"
  | "Settings"
  | "Built-in prompts"
  | "Built-in actions"
  | "Slash commands";

/** Stable group order used by the help view and `tui --help`. */
export const COMMAND_GROUPS: readonly CommandGroup[] = [
  "General",
  "Composer",
  "Transcript",
  "Lists",
  "Cooperation",
  "Session",
  "Settings",
  "Built-in prompts",
  "Built-in actions",
  "Slash commands",
];

/** One keyboard chord. `shift` only matters when explicitly `true`. */
export interface KeyChord {
  /** `readline` key name (`return`, `escape`, `pageup`, `p`, …) or a symbol. */
  name: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  /** The UI asks for the chord twice in a row (quit confirmation). */
  double?: boolean;
}

/** One discoverable TUI command. */
export interface TuiCommand {
  /** Stable identifier used by the app, palette and tests. */
  id: string;
  /** Short human title. */
  title: string;
  /** One sentence for help/palette; must not restate the key label. */
  description: string;
  group: CommandGroup;
  /** Typed slash name without the leading `/`. */
  slash?: string;
  /** Extra typed slash names (`/q` for exit). */
  slashAliases?: readonly string[];
  /** Argument hint shown beside the slash name (`consult|work`). */
  argumentHint?: string;
  /** Chords, primary first. Matching and documentation use the same specs. */
  keys?: readonly KeyChord[];
  /** Scope where the binding is active (default `"always"`). */
  when?: CommandWhen;
  /** Included in the Ctrl+P palette (default true). */
  palette?: boolean;
  /** Included in help / `tui --help` documentation (default true). */
  document?: boolean;
  /** Refused while a turn is running. */
  idleOnly?: boolean;
}

/**
 * The registry. Order is matching priority within a scope.
 *
 * Slash-only commands (`/mode`, `/models`, …) intentionally have no chord:
 * the keyless entry is still a discoverable, searchable palette action.
 */
export const TUI_COMMANDS: readonly TuiCommand[] = [
  {
    id: "palette",
    title: "Command palette",
    description: "Search every command, key binding and slash template.",
    group: "General",
    slash: "palette",
    keys: [{ name: "p", ctrl: true }],
    when: "always",
  },
  {
    id: "help",
    title: "Keyboard help",
    description: "Show keys, commands, modes and settings actions.",
    group: "General",
    slash: "help",
    slashAliases: ["h"],
    keys: [{ name: "?" }, { name: "f1" }],
    when: "always",
  },
  {
    id: "retry",
    title: "Retry last task",
    description: "Re-send the last failed or cancelled task.",
    group: "General",
    slash: "retry",
    keys: [],
    when: "always",
  },
  {
    id: "commands",
    title: "Slash commands",
    description: "List the discovered <name>.md prompt templates.",
    group: "General",
    slash: "commands",
    keys: [],
    when: "always",
  },
  {
    id: "cancel",
    title: "Cancel / close",
    description: "Close the current overlay or cancel the running turn.",
    group: "General",
    keys: [{ name: "escape" }],
    when: "app",
    palette: false,
  },
  {
    id: "exit",
    title: "Exit",
    description: "Leave the TUI; press the chord twice to confirm.",
    group: "General",
    slash: "exit",
    slashAliases: ["quit", "q"],
    keys: [{ name: "c", ctrl: true, double: true }],
    when: "always",
  },
  {
    id: "submit",
    title: "Submit task",
    description: "Send the composer text as the next task.",
    group: "Composer",
    keys: [{ name: "return" }],
    when: "composer",
    palette: false,
  },
  {
    id: "newline",
    title: "Insert newline",
    description: "Break the composer text into another line.",
    group: "Composer",
    keys: [{ name: "return", shift: true }, { name: "j", ctrl: true }],
    when: "composer",
    palette: false,
  },
  {
    id: "history",
    title: "Prompt history",
    description: "Recall earlier submitted tasks; the draft is preserved.",
    group: "Composer",
    keys: [{ name: "up" }, { name: "down" }],
    when: "composer",
    palette: false,
  },
  {
    id: "history-search",
    title: "Search prompt history",
    description: "Incrementally search earlier submitted tasks, newest first.",
    group: "Composer",
    // Ctrl+R: unbound here, and the conventional shell reverse-search key.
    keys: [{ name: "r", ctrl: true }],
    when: "composer",
  },
  {
    id: "complete",
    title: "Complete slash command",
    description: "Complete the typed slash name from the discovered templates.",
    group: "Composer",
    keys: [{ name: "tab" }],
    when: "composer",
    palette: false,
  },
  {
    id: "stash",
    title: "Stash or restore draft",
    description: "Stash the composer draft, or bring the stashed draft back.",
    group: "Composer",
    slash: "stash",
    // Ctrl+O: unused, produces one control byte, and falls outside the
    // terminal's XON/XOFF pair (Ctrl+Q / Ctrl+S), so it can never pause output.
    keys: [{ name: "o", ctrl: true }],
    when: "composer",
  },
  {
    id: "scroll",
    title: "Scroll transcript",
    description: "Page through the transcript without moving the composer cursor.",
    group: "Transcript",
    keys: [{ name: "pageup" }, { name: "pagedown" }],
    when: "transcript",
    palette: false,
  },
  {
    id: "tool-expand",
    title: "Expand tool result",
    description: "Show every line of the newest tool result, or collapse it again.",
    group: "Transcript",
    // Ctrl+T: no other binding, one control byte, and outside the terminal's
    // XON/XOFF pair (Ctrl+Q / Ctrl+S), so it can never pause output.
    keys: [{ name: "t", ctrl: true }],
    when: "app",
  },
  {
    id: "find",
    title: "Find in transcript",
    description: "Search every transcript block, case-insensitively, with live match navigation.",
    group: "Transcript",
    slash: "find",
    argumentHint: "[query]",
    // Ctrl+F: unbound here, one control byte, outside the XON/XOFF pair, and
    // the conventional find key. Opening is app-scope only, so a modal
    // overlay keeps its own keys (palette/help still own their scope).
    keys: [{ name: "f", ctrl: true }],
    when: "app",
  },
  {
    id: "find-next",
    title: "Next transcript match",
    description: "Jump to the next find match, wrapping to the first.",
    group: "Transcript",
    keys: [{ name: "return" }, { name: "down" }],
    when: "find",
    palette: false,
  },
  {
    id: "find-prev",
    title: "Previous transcript match",
    description: "Jump to the previous find match, wrapping to the last.",
    group: "Transcript",
    keys: [{ name: "return", shift: true }, { name: "up" }],
    when: "find",
    palette: false,
  },
  {
    id: "find-close",
    title: "Close find bar",
    description: "Close the find bar and restore the composer draft and viewport.",
    group: "Transcript",
    keys: [{ name: "escape" }],
    when: "find",
    palette: false,
  },
  {
    id: "list-move",
    title: "Move selection",
    description: "Move the highlighted row in a palette, help or picker.",
    group: "Lists",
    keys: [{ name: "up" }, { name: "down" }],
    when: "overlay",
    palette: false,
  },
  {
    id: "list-accept",
    title: "Choose item",
    description: "Open or run the highlighted item.",
    group: "Lists",
    keys: [{ name: "return" }],
    when: "overlay",
    palette: false,
  },
  {
    id: "list-close",
    title: "Close overlay",
    description: "Dismiss the overlay and restore the previous focus.",
    group: "Lists",
    keys: [{ name: "escape" }],
    when: "overlay",
    palette: false,
  },
  // The inline `/` command and `@skill:` mention pickers are a typing mode of
  // the composer, so their keys live in their own scope and can never collide
  // with prompt history, overlay movement or the find bar.
  {
    id: "mention-move",
    title: "Move picker selection",
    description: "Move the highlighted row in the command or skill picker.",
    group: "Lists",
    keys: [{ name: "up" }, { name: "down" }],
    when: "mention",
    palette: false,
    document: false,
  },
  {
    id: "mention-accept",
    title: "Insert picker item",
    description: "Insert the highlighted command or skill token into the composer.",
    group: "Lists",
    keys: [{ name: "return" }, { name: "tab" }],
    when: "mention",
    palette: false,
    document: false,
  },
  {
    id: "mention-dismiss",
    title: "Dismiss picker",
    description: "Dismiss the command or skill picker without changing the composer.",
    group: "Lists",
    // Shift+Tab: the reverse of the accept chord, leaving printable input
    // focused; Escape keeps its usual close meaning in the same scope.
    keys: [{ name: "tab", shift: true }],
    when: "mention",
    palette: false,
    document: false,
  },
  {
    id: "mention-close",
    title: "Close picker",
    description: "Dismiss the command or skill picker and keep the typed draft.",
    group: "Lists",
    keys: [{ name: "escape" }],
    when: "mention",
    palette: false,
    document: false,
  },
  // A parked approval owns the keyboard (the composer is replaced by the
  // approval panel), so its answer keys live in their own scope and can never
  // collide with the composer, the picker or the quit chord.
  {
    id: "approval-move",
    title: "Move approval choice",
    description: "Move the highlight between the pending approval's decisions.",
    group: "Cooperation",
    keys: [{ name: "up" }, { name: "down" }],
    when: "approval",
    palette: false,
    document: false,
  },
  {
    id: "approval-accept",
    title: "Confirm approval choice",
    description: "Answer the pending approval with the highlighted decision.",
    group: "Cooperation",
    keys: [{ name: "return" }],
    when: "approval",
    palette: false,
    document: false,
  },
  {
    id: "approval-allow",
    title: "Allow the pending action once",
    description: "Approve the pending workspace action for this one call.",
    group: "Cooperation",
    keys: [{ name: "y" }, { name: "1" }],
    when: "approval",
    palette: false,
  },
  {
    id: "approval-allow-session",
    title: "Allow the pending action for this TUI session",
    description: "Answer identical requests for the rest of this TUI process (memory only).",
    group: "Cooperation",
    keys: [{ name: "a" }, { name: "2" }],
    when: "approval",
    palette: false,
  },
  {
    id: "approval-deny",
    title: "Deny the pending action",
    description: "Refuse the pending workspace action; Escape denies exactly once.",
    group: "Cooperation",
    keys: [{ name: "n" }, { name: "3" }, { name: "escape" }],
    when: "approval",
    palette: false,
  },
  {
    id: "approval-preview",
    title: "Preview the pending change",
    description: "Open the pending write/edit diff or shell command full-screen.",
    group: "Cooperation",
    keys: [{ name: "e", ctrl: true }],
    when: "approval",
    palette: false,
  },
  {
    id: "mode",
    title: "Cooperation mode",
    description: "Switch between consult and work for the next turn.",
    group: "Cooperation",
    slash: "mode",
    argumentHint: "consult|work",
    keys: [],
    when: "always",
  },
  {
    id: "models",
    title: "Models",
    description: "Choose the Senior or Junior model for this session.",
    group: "Settings",
    slash: "models",
    argumentHint: "[senior|junior] [model]",
    keys: [],
    when: "always",
    idleOnly: true,
  },
  {
    id: "sessions",
    title: "Sessions",
    description: "Browse and resume a saved session.",
    group: "Session",
    slash: "sessions",
    argumentHint: "[name]",
    keys: [],
    when: "always",
    idleOnly: true,
  },
  {
    id: "theme",
    title: "Theme",
    description: "Switch the terminal theme between dark, light and system.",
    group: "Settings",
    slash: "theme",
    argumentHint: "dark|light|system",
    keys: [],
    when: "always",
  },
  {
    id: "panel",
    title: "Status panel",
    description: "Show or hide the right-hand status panel on wide terminals.",
    group: "Settings",
    slash: "panel",
    // Ctrl+B: unbound here, one control byte, and outside the terminal's
    // XON/XOFF pair (Ctrl+Q / Ctrl+S), so it can never pause output. The
    // app-scope binding leaves overlays to their own keys.
    keys: [{ name: "b", ctrl: true }],
    when: "app",
  },
  {
    id: "settings",
    title: "Settings and onboarding",
    description: "Open provider setup and application settings.",
    group: "Settings",
    slash: "settings",
    keys: [],
    when: "always",
    idleOnly: true,
  },
  {
    id: "keys",
    title: "Key bindings",
    description: "Show the effective global chords and reload the TUI keys file.",
    group: "Settings",
    slash: "keys",
    argumentHint: "[show|reload]",
    keys: [],
    when: "always",
  },
  {
    id: "provider",
    title: "Connect a provider",
    description: "Connect or change the provider endpoint used by this session.",
    group: "Settings",
    slash: "provider",
    // Native app surface rather than a task: `/provider` always opens the
    // connect form, and a discovered `provider.md` template can never shadow
    // it (native commands win their own name, like `/help` and `/mode`).
    keys: [],
    when: "always",
    idleOnly: true,
  },
];

// --------------------------------------------------------------------------- //
// key formatting and matching
// --------------------------------------------------------------------------- //

const KEY_LABELS: Record<string, string> = {
  return: "Enter",
  enter: "Enter",
  escape: "Esc",
  esc: "Esc",
  backspace: "Backspace",
  delete: "Del",
  insert: "Ins",
  pageup: "PgUp",
  pagedown: "PgDn",
  tab: "Tab",
  space: "Space",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  home: "Home",
  end: "End",
};

/** Human label for one chord (`Ctrl+P`, `Shift+Enter`, `PgUp`, `Ctrl+C ×2`). */
export function formatChord(chord: KeyChord): string {
  const parts: string[] = [];
  if (chord.ctrl === true) parts.push("Ctrl");
  if (chord.alt === true) parts.push("Alt");
  if (chord.shift === true) parts.push("Shift");
  const lower = chord.name.toLowerCase();
  const modifiedLetter =
    chord.name.length === 1 &&
    /[a-z]/i.test(chord.name) &&
    (chord.ctrl === true || chord.alt === true || chord.shift === true);
  const label = modifiedLetter ? chord.name.toUpperCase() : chord.name;
  parts.push(KEY_LABELS[lower] ?? (label.length === 1 ? label : titleCase(label)));
  const text = parts.join("+");
  return chord.double === true ? `${text} ×2` : text;
}

function titleCase(value: string): string {
  return value.length === 0 ? value : value[0].toUpperCase() + value.slice(1);
}

/** Format every chord of a command, joined with ` / `. */
export function formatKeys(command: Pick<TuiCommand, "keys">): string {
  return (command.keys ?? []).map(formatChord).join(" / ");
}

/** A key event, structurally compatible with `terminal.ts`'s `Key`. */
export interface KeyLike {
  name: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  raw?: string;
  /** Terminal-reported auto-repeat flag (when the driver exposes one). */
  repeat?: boolean;
}

const NAME_ALIASES: Record<string, string> = {
  return: "enter",
  esc: "escape",
  del: "delete",
};

function normalizeKeyName(name: string): string {
  const lower = name.toLowerCase();
  return NAME_ALIASES[lower] ?? lower;
}

function isLiteralSymbol(name: string): boolean {
  const units = [...name];
  return units.length === 1 && !/[A-Za-z0-9]/u.test(name);
}

/**
 * True when `key` matches `chord`. Ctrl, Alt and Shift are exact for named
 * keys, preventing Shift+Enter from matching plain Enter. Literal symbols may
 * arrive with Shift set (so `?` matches Shift+/). `double` is a UI policy, not
 * part of a single press, and is ignored here.
 */
export function matchChord(chord: KeyChord, key: KeyLike): boolean {
  if ((chord.ctrl === true) !== (key.ctrl === true)) return false;
  if ((chord.alt === true) !== (key.alt === true)) return false;
  if (chord.shift === true && key.shift !== true) return false;
  if (chord.shift !== true && key.shift === true && !isLiteralSymbol(chord.name)) return false;
  const keyName = key.name === "" ? (key.raw ?? "") : key.name;
  if (normalizeKeyName(chord.name) === normalizeKeyName(keyName)) return true;
  if (isLiteralSymbol(chord.name)) {
    return keyName === chord.name || (key.raw ?? "") === chord.name;
  }
  return false;
}

/** A matched command/chord pair. */
export interface KeyResolution {
  command: TuiCommand;
  chord: KeyChord;
}

function scopeMatches(
  when: CommandWhen,
  context: "app" | "overlay" | "find" | "mention" | "approval",
): boolean {
  if (context === "overlay") return when === "always" || when === "overlay";
  // The inline find bar, mention picker and a parked approval are exclusive
  // keyboard modes: only their own scope stays live, so printable input and
  // their chords never collide with composer keys or each other.
  if (context === "find") return when === "find";
  if (context === "mention") return when === "mention";
  if (context === "approval") return when === "approval";
  return when !== "overlay" && when !== "find" && when !== "mention" && when !== "approval";
}

/**
 * Resolve a keypress in a scope. `context` is `"app"` (composer/transcript,
 * the default), `"overlay"` (palette/help/pickers), `"find"` (the inline
 * transcript find bar), `"mention"` (the inline `/` and `@skill:` pickers) or
 * `"approval"` (a parked approval's decision panel).
 * Registry order is priority order.
 */
export function resolveKey(
  commands: readonly TuiCommand[],
  key: KeyLike,
  context: "app" | "overlay" | "find" | "mention" | "approval" = "app",
): KeyResolution | null {
  for (const command of commands) {
    if (!scopeMatches(command.when ?? "always", context)) continue;
    for (const chord of command.keys ?? []) {
      if (matchChord(chord, key)) return { command, chord };
    }
  }
  return null;
}

/** Look a command up by its stable id. */
export function findCommand(
  commands: readonly TuiCommand[],
  id: string,
): TuiCommand | undefined {
  return commands.find((command) => command.id === id);
}

/** Resolve a typed slash name (built-ins and aliases) to its command. */
export function findSlashCommand(
  commands: readonly TuiCommand[],
  name: string,
): TuiCommand | null {
  const wanted = name.toLowerCase();
  for (const command of commands) {
    if (command.slash !== undefined && command.slash.toLowerCase() === wanted) return command;
    if ((command.slashAliases ?? []).some((alias) => alias.toLowerCase() === wanted)) {
      return command;
    }
  }
  return null;
}

/** Commands refused while a turn runs are disabled exactly then. */
export function isCommandEnabled(
  command: Pick<TuiCommand, "idleOnly">,
  options: { running?: boolean } = {},
): boolean {
  return !(command.idleOnly === true && options.running === true);
}

/**
 * Describe a list footer from the registry:
 * `Up / Down move · Enter select · Esc close`. Unknown ids are skipped, so a
 * view never needs to spell a key itself.
 */
export function hintSegments(
  commands: readonly TuiCommand[],
  hints: readonly { id: string; label: string }[],
): string {
  const parts: string[] = [];
  for (const hint of hints) {
    const command = findCommand(commands, hint.id);
    const keys = command === undefined ? "" : formatKeys(command);
    if (keys !== "") parts.push(`${keys} ${hint.label}`);
  }
  return parts.join(" · ");
}

// --------------------------------------------------------------------------- //
// status-bar tip rotation
// --------------------------------------------------------------------------- //

/** One rotating footer tip: a registry command id plus its action phrase. */
export interface FooterTipSpec {
  /** Registry command id; an unknown id is skipped by every resolver here. */
  id: string;
  /** Short action phrase shown after the derived chord. */
  label: string;
  /** Only meaningful while a turn runs (the tip is hidden when idle). */
  runningOnly?: boolean;
}

/**
 * The ordered, high-value footer tips. Each rotation step shows one tip and a
 * full cycle covers every available action exactly once, highest value first;
 * every chord is derived from this registry, so a tip can never document a
 * binding the app does not have.
 */
export const FOOTER_TIPS: readonly FooterTipSpec[] = [
  { id: "tool-expand", label: "fold tool output" },
  { id: "find", label: "find in transcript" },
  { id: "palette", label: "commands" },
  { id: "help", label: "keys and help" },
  { id: "history-search", label: "search prompt history" },
  { id: "panel", label: "status panel" },
  { id: "cancel", label: "stop the turn", runningOnly: true },
];

/** Options for the footer-tip rotation. */
export interface FooterTipOptions {
  /** A turn is running: running-only tips join and idle-only ones leave. */
  running?: boolean;
  /** Command ids to leave out of this cycle (e.g. a fold hint already leading). */
  exclude?: readonly string[];
}

/** One resolved tip: the registry command, its phrase and the printed hint. */
export interface FooterTip {
  id: string;
  label: string;
  hint: string;
}

/**
 * Resolve the tips available in the current state, in rotation order. A tip is
 * skipped when its command is unknown, unbound (no chord) or disabled now, so
 * the footer never advertises an action the operator cannot take.
 */
export function footerTips(
  commands: readonly TuiCommand[] = TUI_COMMANDS,
  options: FooterTipOptions = {},
): FooterTip[] {
  const tips: FooterTip[] = [];
  for (const spec of FOOTER_TIPS) {
    const command = findCommand(commands, spec.id);
    if (command === undefined) continue;
    if (spec.runningOnly === true && options.running !== true) continue;
    if (options.exclude?.includes(spec.id) === true) continue;
    if (!isCommandEnabled(command, options)) continue;
    const keys = formatKeys(command);
    if (keys === "") continue;
    tips.push({ id: spec.id, label: spec.label, hint: `${keys} ${spec.label}` });
  }
  return tips;
}

/**
 * Deterministic rotation: `step` modulo the available tip count. Callers supply
 * the step from state they already own (a turn/activity counter); this module
 * reads no clock and no randomness, so the same step and state always render
 * the same tip. Consecutive steps never repeat a tip while two or more are
 * available, and one full cycle shows every available high-value action once.
 * Returns `""` when no tip is available so callers can keep their own fallback.
 */
export function rotatingFooterTip(
  commands: readonly TuiCommand[] = TUI_COMMANDS,
  step = 0,
  options: FooterTipOptions = {},
): string {
  const tips = footerTips(commands, options);
  if (tips.length === 0) return "";
  const safeStep = Number.isFinite(step) ? Math.floor(step) : 0;
  const index = ((safeStep % tips.length) + tips.length) % tips.length;
  return tips[index]?.hint ?? "";
}

/** Options for {@link composeStatusHints}. */
export interface StatusHintOptions extends FooterTipOptions {
  /** The leading fold action when a tool row is on screen (null otherwise). */
  fold?: { commandId: string; label: string } | null;
}

/**
 * Compose the status bar's row-two hint: one rotating tip, led by the tool-fold
 * action whenever a tool row is on screen. The fold action is removed from the
 * rotation so the same chord never appears twice in one hint. Returns
 * `undefined` when nothing can be advertised (the caller keeps its fallback).
 */
export function composeStatusHints(
  commands: readonly TuiCommand[] = TUI_COMMANDS,
  step = 0,
  options: StatusHintOptions = {},
): string | undefined {
  const fold = options.fold ?? null;
  const tip = rotatingFooterTip(commands, step, {
    ...(options.running !== undefined ? { running: options.running } : {}),
    ...(fold !== null ? { exclude: [fold.commandId] } : {}),
  });
  const foldHint = fold === null
    ? ""
    : hintSegments(commands, [{ id: fold.commandId, label: fold.label }]);
  if (foldHint === "") return tip === "" ? undefined : tip;
  return tip === "" ? foldHint : `${foldHint} · ${tip}`;
}

// --------------------------------------------------------------------------- //
// palette/help entries (commands + discovered slash templates)
// --------------------------------------------------------------------------- //

/** Metadata for one discovered `<name>.md` template (`commands.ts` subset). */
export interface SlashCommandInfo {
  name: string;
  description: string;
  argumentHint?: string;
  mode?: "consult" | "work";
}

/** One row in the palette or help overlay. */
export interface PaletteEntry {
  id: string;
  title: string;
  description: string;
  group: CommandGroup;
  /** Formatted chord label, `""` when the command has no key. */
  keys: string;
  /** `/mode`, `""` when the command has no typed form. */
  slash: string;
  argumentHint: string;
  kind: "command" | "slash-template" | "base-command";
  disabled: boolean;
  disabledReason: string;
  /** Template frontmatter mode, `""` when unset. */
  mode: "consult" | "work" | "";
}

/** Inputs for entry construction. */
export interface EntryOptions {
  /** Discovered templates to merge after the built-ins. */
  commands?: readonly SlashCommandInfo[];
  /** A turn is running: `idleOnly` commands render disabled. */
  running?: boolean;
}

const IDLE_REASON = "unavailable while a turn is running";

function commandEntry(command: TuiCommand, options: EntryOptions): PaletteEntry {
  const enabled = isCommandEnabled(command, options);
  return {
    id: command.id,
    title: command.title,
    description: command.description,
    group: command.group,
    keys: formatKeys(command),
    slash: command.slash === undefined ? "" : `/${command.slash}`,
    argumentHint: command.argumentHint ?? "",
    kind: "command",
    disabled: !enabled,
    disabledReason: enabled ? "" : IDLE_REASON,
    mode: "",
  };
}

function templateEntry(info: SlashCommandInfo): PaletteEntry {
  return {
    id: `template:${info.name}`,
    title: `/${info.name}`,
    description: info.description,
    group: "Slash commands",
    keys: "",
    slash: `/${info.name}`,
    argumentHint: info.argumentHint ?? "",
    kind: "slash-template",
    disabled: false,
    disabledReason: "",
    mode: info.mode ?? "",
  };
}

function buildEntries(
  commands: readonly TuiCommand[],
  options: EntryOptions,
  predicate: (command: TuiCommand) => boolean,
): PaletteEntry[] {
  const entries = commands.filter(predicate).map((command) => commandEntry(command, options));
  for (const info of options.commands ?? []) entries.push(templateEntry(info));
  return entries;
}

/** Entries for the Ctrl+P palette (commands with `palette !== false`). */
export function paletteEntries(
  commands: readonly TuiCommand[] = TUI_COMMANDS,
  options: EntryOptions = {},
): PaletteEntry[] {
  return buildEntries(commands, options, (command) => command.palette !== false);
}

/** Entries for help / `tui --help` (commands with `document !== false`). */
export function documentEntries(
  commands: readonly TuiCommand[] = TUI_COMMANDS,
  options: EntryOptions = {},
): PaletteEntry[] {
  return buildEntries(commands, options, (command) => command.document !== false);
}

// --------------------------------------------------------------------------- //
// CLI help text
// --------------------------------------------------------------------------- //

/**
 * The key/slash guide for `tui --help`, derived from the registry. Callers
 * print these lines verbatim (no caller-side key list), which keeps CLI
 * documentation and the in-app help identical.
 */
export function tuiHelpLines(
  commands: readonly TuiCommand[] = TUI_COMMANDS,
  options: { commands?: readonly SlashCommandInfo[] } = {},
): string[] {
  const documented = commands.filter((command) => command.document !== false);
  const keyed = documented.filter((command) => (command.keys ?? []).length > 0);
  const slashed = documented.filter((command) => command.slash !== undefined);
  const keyWidth = Math.max(4, ...keyed.map((command) => formatKeys(command).length));
  const lines: string[] = ["Keys:"];
  for (const command of keyed) {
    lines.push(`  ${formatKeys(command).padEnd(keyWidth)}  ${command.description}`);
  }
  if (slashed.length > 0) {
    const slashWidth = Math.max(
      4,
      ...slashed.map(
        (command) =>
          `/${command.slash ?? ""}${command.argumentHint === undefined ? "" : ` ${command.argumentHint}`}`
            .length,
      ),
    );
    lines.push("", "Slash input:");
    for (const command of slashed) {
      const form = `/${command.slash ?? ""}${
        command.argumentHint === undefined ? "" : ` ${command.argumentHint}`
      }`;
      lines.push(`  ${form.padEnd(slashWidth)}  ${command.description}`);
    }
  }
  const templates = options.commands ?? [];
  lines.push("");
  if (templates.length > 0) {
    lines.push("Discovered commands:");
    for (const template of templates) {
      const form = `/${template.name}${
        template.argumentHint === undefined || template.argumentHint === ""
          ? ""
          : ` ${template.argumentHint}`
      }`;
      lines.push(`  ${form}  ${template.description}`);
    }
  } else {
    lines.push(
      "Discovered <name>.md commands from the commands roots are listed by /commands.",
    );
  }
  return lines;
}