/**
 * Pure inline command/skill/file picker for the TUI composer.
 *
 * Typing `/` at the start of the composer (or at a line start with only
 * whitespace before it) opens an inline picker over the registry's native
 * slash commands, the first-party base commands the surface offers and the
 * discovered `<name>.md` templates; typing `@` at a token boundary opens the
 * skill picker (`@` plus an optional `skill:` prefix are both accepted as the
 * trigger), and — in a workspace-bound TUI — typing an `@` path that contains
 * a slash opens the workspace-file picker. Continued typing filters the list
 * (aliases are searchable keywords), Up/Down move the highlight with
 * wrap-around, Enter/Tab replace the trigger token with the canonical
 * `/name `, `@skill:name ` or `@path ` token, Shift+Tab dismisses, and Escape
 * closes the picker without touching the rest of the draft.
 *
 * Rows are grouped and badged by provenance (`TUI commands` / `Built-in
 * prompts` / `Built-in actions` / `Slash commands` / `Shared skills` /
 * `Role-scoped skills` / `Workspace files`), built-ins are ordered by the
 * shared priority/templates alphabetically, and the footer shows the selected
 * row's usage + description above the registry-derived key hints.
 *
 * The trigger grammar deliberately mirrors `mentions.ts` so the picker can
 * never produce a token the submit path refuses: a command token is
 * `/` + `[A-Za-z0-9_-]*` on a whitespace-only line prefix; a skill token is
 * `@` + optional `skill:` + `[A-Za-z0-9_-]*` after start-of-text or ASCII
 * whitespace; a file token is a whitespace-free `@`-run containing `/` or `\`
 * (the same convention `scanMentions` uses). Everything is grapheme-indexed
 * (the editor's coordinate system), so a picker selection can rewrite the
 * token with the editor API without splitting an emoji or combining sequence.
 *
 * Rendering is an inline, unboxed list of exact-width rows (the same footer
 * area family as the find bar): a header with the kind/count/filter, optional
 * group headings, one row per command/skill/file with its argument hint,
 * badge, scope and (wide terminals only) description, a selected-row usage
 * hint, the registry-derived key hints, and honest scope notes. No ANSI
 * outside the theme; nothing here throws on hostile input.
 */
import { graphemes } from "../editor.ts";
import {
  baseCommandUsage,
  sortBaseCommands,
  type BaseCommand,
} from "../../basecommands.ts";
import {
  hintSegments,
  resolveKey,
  TUI_COMMANDS,
  type KeyLike,
  type SlashCommandInfo,
  type TuiCommand,
} from "../keymap.ts";
import { fileMentionToken, skillMentionToken } from "../../mentions.ts";
import { sanitizeDisplayText } from "../screen.ts";
import type { Skill, SkillScope } from "../../skills.ts";
import type { WorkspaceFileEntry } from "../../workspacefiles.ts";
import { plainTheme, type Theme, type ThemeToken } from "../theme.ts";
import {
  dropLastGrapheme,
  printableKeyText,
  viewPad,
  viewTruncate,
  windowStart,
} from "./palette.ts";

/** Which catalog the inline picker is showing. */
export type MentionPickerKind = "command" | "skill" | "file";

/** One selectable row of the inline picker. */
export interface MentionPickerItem {
  /** Stable id (commands: `command:<id>`/`alias:…`/`template:<name>`). */
  id: string;
  kind: MentionPickerKind;
  /** Bare name used for filtering (`mode`, `checklist`). */
  name: string;
  /** Display token (`/mode`, `/mode consult|work` without the hint, `@skill:x`). */
  title: string;
  /** Text inserted into the composer, always with one trailing space. */
  insert: string;
  description: string;
  argumentHint?: string;
  /** Display heading. */
  group: string;
  disabled?: boolean;
  disabledReason?: string;
  /** Canonical command an alias row points at (`/exit`), when applicable. */
  aliasOf?: string;
  /** Skill scope; absent for command rows. */
  scope?: SkillScope;
  /**
   * Row provenance badge: `builtin` (native keymap command or base prompt),
   * `action` (a base command the surface performs) or `template` (a
   * discovered `<name>.md`). Absent for skill rows.
   */
  badge?: "builtin" | "action" | "template";
  /** Extra typed spellings that match the filter but never insert. */
  aliases?: readonly string[];
  /** Usage form shown in the selected-row hint footer (`/plan <objective>`). */
  usage?: string;
}

/** The catalogs the picker composes its rows from. */
export interface MentionPickerCatalogs {
  /** Registry commands (default {@link TUI_COMMANDS}). */
  commands?: readonly TuiCommand[];
  /** Discovered `<name>.md` templates. */
  templates?: readonly SlashCommandInfo[];
  /** Discovered skills (all scopes; only shared ones are selectable). */
  skills?: readonly Skill[];
  /**
   * First-party base commands the surface offers (`src/tui/basecommands.ts`
   * already filters out native/template-shadowed names).
   */
  baseCommands?: readonly BaseCommand[];
  /**
   * Workspace files for the `@path` picker (indexed by `workspacefiles.ts`).
   * Empty/absent when the TUI is not workspace-bound.
   */
  files?: readonly WorkspaceFileEntry[];
}

/** A detected trigger token in the composer text (grapheme indices). */
export interface MentionTrigger {
  kind: MentionPickerKind;
  /** Grapheme index of the trigger character (`/` or `@`). */
  start: number;
  /** Grapheme index one past the token end (exclusive). */
  end: number;
  /** Filter text: the typed name, without the trigger/`skill:` prefix. */
  query: string;
  /** The token as currently typed (for display/tests). */
  token: string;
}

/** Immutable inline-picker state. */
export interface MentionPickerState {
  open: boolean;
  kind: MentionPickerKind;
  /** Filter text (the typed name; case preserved for display). */
  query: string;
  /** Full catalog for the kind; filtering is derived from `query`. */
  items: readonly MentionPickerItem[];
  /** Index into the filtered list (always clamped when read). */
  active: number;
  /** Composer grapheme range the accepted item replaces. */
  trigger: { start: number; end: number };
}

/** Result of folding one keypress into the picker. */
export type MentionPickerAction =
  | "none"
  | "move"
  | "filter"
  | "close"
  | "accept"
  | "blocked";

/** Result of {@link mentionPickerKey}. */
export interface MentionPickerKeyResult {
  state: MentionPickerState;
  action: MentionPickerAction;
  item?: MentionPickerItem;
  reason?: string;
  /** Registry chord that accepted (`return`/`tab`), for caller policy. */
  chordName?: string;
}

const ASCII_WHITESPACE = new Set([" ", "\t", "\n", "\r", "\f", "\v"]);
const GROUP_ORDER = [
  "TUI commands",
  "Built-in prompts",
  "Built-in actions",
  "Slash commands",
  "Shared skills",
  "Role-scoped skills",
  "Workspace files",
] as const;

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Sanitize a filter query into one line (no escapes, no tabs/newlines). */
function normalizeQuery(query: string): string {
  return sanitizeDisplayText(asString(query)).replace(/\n/g, " ");
}

function isNameChar(unit: string): boolean {
  return unit !== "" && /^[A-Za-z0-9_-]$/u.test(unit);
}

// --------------------------------------------------------------------------- //
// trigger detection
// --------------------------------------------------------------------------- //

/**
 * Detect the trigger token the caret is inside (or immediately after).
 *
 * Commands need `/` at the start of the composer or at a line start whose
 * prefix is ASCII whitespace only; skills need `@` at start-of-text or after
 * ASCII whitespace. The returned `start`/`end` are grapheme indices of the
 * whole token (suffix included when the caret sits inside it), so accepting a
 * row replaces exactly the token the operator typed.
 */
export function detectMentionTrigger(text: string, cursor?: number): MentionTrigger | null {
  const units = graphemes(asString(text));
  const caret = clamp(
    cursor !== undefined && Number.isFinite(cursor) ? Math.floor(cursor) : units.length,
    0,
    units.length,
  );

  // ── `/` command token ──
  let nameStart = caret;
  while (nameStart > 0 && isNameChar(units[nameStart - 1] ?? "")) nameStart -= 1;
  if (nameStart > 0 && units[nameStart - 1] === "/") {
    const slash = nameStart - 1;
    let lineStart = slash;
    while (lineStart > 0 && units[lineStart - 1] !== "\n") lineStart -= 1;
    let onlyWhitespace = true;
    for (let index = lineStart; index < slash; index += 1) {
      if (!ASCII_WHITESPACE.has(units[index] ?? "")) {
        onlyWhitespace = false;
        break;
      }
    }
    if (onlyWhitespace) {
      let tokenEnd = nameStart;
      while (tokenEnd < units.length && isNameChar(units[tokenEnd] ?? "")) tokenEnd += 1;
      return {
        kind: "command",
        start: slash,
        end: tokenEnd,
        query: units.slice(nameStart, caret).join(""),
        token: units.slice(slash, tokenEnd).join(""),
      };
    }
  }

  // ── `@<path>` workspace-file mention token ──
  // A file token is a whitespace-free `@` run containing `/` or `\` — exactly
  // the shape `mentions.ts::scanMentions` accepts. A token without a slash yet
  // falls through to the skill picker, so typing `@` still lists skills.
  let tokenStart = caret;
  while (tokenStart > 0 && !/\s/.test(units[tokenStart - 1] ?? "")) tokenStart -= 1;
  if (units[tokenStart] === "@") {
    let fileEnd = caret;
    while (fileEnd < units.length && !/\s/.test(units[fileEnd] ?? "")) fileEnd += 1;
    const typed = units.slice(tokenStart + 1, caret).join("");
    if (typed.includes("/") || typed.includes("\\")) {
      return {
        kind: "file",
        start: tokenStart,
        end: fileEnd,
        query: typed,
        token: units.slice(tokenStart, fileEnd).join(""),
      };
    }
  }

  // ── `@skill:` mention token ──
  let atIndex = -1;
  let scan = caret;
  while (scan > 0) {
    const unit = units[scan - 1] ?? "";
    if (unit === "@") {
      atIndex = scan - 1;
      break;
    }
    if (unit === ":" || isNameChar(unit)) {
      scan -= 1;
      continue;
    }
    break;
  }
  if (atIndex < 0) return null;
  if (atIndex > 0 && !ASCII_WHITESPACE.has(units[atIndex - 1] ?? "")) return null;
  let tokenEnd = caret;
  while (tokenEnd < units.length) {
    const unit = units[tokenEnd] ?? "";
    if (unit !== ":" && !isNameChar(unit)) break;
    tokenEnd += 1;
  }
  const content = units.slice(atIndex + 1, tokenEnd).join("");
  if (!/^(?:skill:)?[A-Za-z0-9_-]*$/.test(content)) return null;
  const typed = units.slice(atIndex + 1, caret).join("");
  const lowerTyped = typed.toLowerCase();
  const query = lowerTyped.startsWith("skill:") ? typed.slice("skill:".length) : typed;
  return {
    kind: "skill",
    start: atIndex,
    end: tokenEnd,
    query,
    token: units.slice(atIndex, tokenEnd).join(""),
  };
}

// --------------------------------------------------------------------------- //
// catalog composition
// --------------------------------------------------------------------------- //

/**
 * Command rows: native registry slash commands (and their aliases), then the
 * first-party base commands the surface offers (prompts before actions, by
 * shared priority), then discovered templates alphabetically. A discovered
 * template whose name collides with a base command wins and the base row is
 * dropped (the template shadows it on submit too). Every row carries its
 * provenance badge so the list is readable at a glance.
 */
export function commandMentionItems(
  commands: readonly TuiCommand[] = TUI_COMMANDS,
  templates: readonly SlashCommandInfo[] = [],
  baseCommands: readonly BaseCommand[] = [],
): MentionPickerItem[] {
  const items: MentionPickerItem[] = [];
  for (const command of commands) {
    const name = command.slash;
    if (name === undefined) continue;
    items.push({
      id: `command:${command.id}`,
      kind: "command",
      name,
      title: `/${name}`,
      insert: `/${name} `,
      description: command.description,
      group: "TUI commands",
      badge: "builtin",
      ...(command.argumentHint !== undefined && command.argumentHint !== ""
        ? { argumentHint: command.argumentHint }
        : {}),
    });
    for (const alias of command.slashAliases ?? []) {
      items.push({
        id: `alias:${command.id}:${alias}`,
        kind: "command",
        name: alias,
        title: `/${alias}`,
        insert: `/${alias} `,
        description: `alias of /${name}`,
        group: "TUI commands",
        aliasOf: `/${name}`,
        badge: "builtin",
      });
    }
  }

  const templateNames = new Set(templates.map((template) => template.name.toLowerCase()));
  const sortedTemplates = [...templates].sort((left, right) => left.name.localeCompare(right.name));
  const availableBase = sortBaseCommands(baseCommands).filter(
    (command) => !templateNames.has(command.name.toLowerCase()),
  );
  // Keep each group contiguous: built-in prompts first, then the actions the
  // surface performs, each already ordered by the shared priority.
  const orderedBase = [
    ...availableBase.filter((command) => command.kind === "prompt"),
    ...availableBase.filter((command) => command.kind === "action"),
  ];
  for (const command of orderedBase) {
    items.push({
      id: `base:${command.name}`,
      kind: "command",
      name: command.name,
      title: `/${command.name}`,
      insert: `/${command.name} `,
      description: command.description,
      group: command.kind === "prompt" ? "Built-in prompts" : "Built-in actions",
      badge: command.kind === "prompt" ? "builtin" : "action",
      usage: baseCommandUsage(command),
      ...(command.aliases.length > 0 ? { aliases: [...command.aliases] } : {}),
      ...(command.argumentHint !== "" ? { argumentHint: command.argumentHint } : {}),
    });
  }

  for (const template of sortedTemplates) {
    items.push({
      id: `template:${template.name}`,
      kind: "command",
      name: template.name,
      title: `/${template.name}`,
      insert: `/${template.name} `,
      description: template.description,
      group: "Slash commands",
      badge: "template",
      ...(template.argumentHint !== undefined && template.argumentHint !== ""
        ? { argumentHint: template.argumentHint }
        : {}),
    });
  }
  return items;
}

/**
 * Discovered skills: shared-scope rows first (selectable), then role-scoped
 * rows, disabled with their scope so the operator can see why they cannot be
 * attached from the composer.
 */
export function skillMentionItems(skills: readonly Skill[] = []): MentionPickerItem[] {
  const toItem = (skill: Skill): MentionPickerItem => {
    const token = skillMentionToken(skill.name);
    const shared = skill.scope === "shared";
    return {
      id: `skill:${skill.name}`,
      kind: "skill",
      name: skill.name,
      title: token,
      insert: `${token} `,
      description: skill.description,
      group: shared ? "Shared skills" : "Role-scoped skills",
      scope: skill.scope,
      ...(shared
        ? {}
        : {
            disabled: true,
            disabledReason: `${skill.scope}-scoped skill — only shared skills can be @mentioned by the operator`,
          }),
    };
  };
  const shared = skills.filter((skill) => skill.scope === "shared");
  const scoped = skills.filter((skill) => skill.scope !== "shared");
  return [...shared.map(toItem), ...scoped.map(toItem)];
}

/** One-file human size for the picker description (`1.2 kB`, `340 B`). */
function formatFileSize(size: number): string {
  const bytes = Number.isFinite(size) && size > 0 ? Math.floor(size) : 0;
  if (bytes < 1024) return `${bytes} B`;
  const useKb = bytes < 1024 * 1024;
  const value = useKb ? bytes / 1024 : bytes / (1024 * 1024);
  return `${value.toFixed(1)} ${useKb ? "kB" : "MB"}`;
}

/**
 * Workspace files for the `@path` picker: one row per indexed file, sorted by
 * path (the index is already sorted). The row's title/insert token is the
 * canonical mention spelling (`@src/a.ts`, and `@./README.md` for a root file,
 * the same normalisation `fileMentionToken` applies), so accepting a row can
 * never insert a token the submit path refuses.
 */
export function fileMentionItems(files: readonly WorkspaceFileEntry[] = []): MentionPickerItem[] {
  return [...files]
    .filter((entry) => typeof entry.path === "string" && entry.path !== "")
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
    .map((entry) => {
      const token = fileMentionToken(entry.path);
      const normalized = token.slice(1);
      return {
        id: `file:${entry.path}`,
        kind: "file" as const,
        name: normalized,
        title: token,
        insert: `${token} `,
        description: formatFileSize(entry.size),
        group: "Workspace files",
      };
    });
}

/** The full catalog for one picker kind. */
export function mentionPickerItems(
  kind: MentionPickerKind,
  catalogs: MentionPickerCatalogs = {},
): MentionPickerItem[] {
  if (kind === "command") {
    return commandMentionItems(
      catalogs.commands ?? TUI_COMMANDS,
      catalogs.templates ?? [],
      catalogs.baseCommands ?? [],
    );
  }
  if (kind === "file") return fileMentionItems(catalogs.files ?? []);
  return skillMentionItems(catalogs.skills ?? []);
}

// --------------------------------------------------------------------------- //
// state, filtering and selection
// --------------------------------------------------------------------------- //

/** Open the picker for one kind, optionally with an already detected trigger. */
export function openMentionPicker(
  kind: MentionPickerKind,
  query: string,
  catalogs: MentionPickerCatalogs = {},
  trigger?: { start: number; end: number },
): MentionPickerState {
  return {
    open: true,
    kind,
    query: normalizeQuery(query),
    items: mentionPickerItems(kind, catalogs),
    active: 0,
    trigger: trigger ?? { start: 0, end: 0 },
  };
}

/** Replace the filter text (selection resets to the first match). */
export function updateMentionPicker(
  state: MentionPickerState,
  query: string,
  trigger?: { start: number; end: number },
): MentionPickerState {
  return {
    ...state,
    query: normalizeQuery(query),
    active: 0,
    ...(trigger !== undefined ? { trigger } : {}),
  };
}

/** Alias used by the app when only the query changes. */
export const setMentionPickerQuery: (state: MentionPickerState, query: string) => MentionPickerState =
  (state, query) => updateMentionPicker(state, query);

/** The groups a filtered list belongs to, in display order. */
export function mentionPickerGroups(
  items: readonly MentionPickerItem[],
): string[] {
  const seen = new Set<string>();
  const groups: string[] = [];
  for (const group of GROUP_ORDER) {
    if (items.some((item) => item.group === group) && !seen.has(group)) {
      seen.add(group);
      groups.push(group);
    }
  }
  for (const item of items) {
    if (!seen.has(item.group)) {
      seen.add(item.group);
      groups.push(item.group);
    }
  }
  return groups;
}

function rankMentionItem(item: MentionPickerItem, phrase: string): number {
  const name = item.name.toLowerCase();
  const title = item.title.toLowerCase();
  if (name === phrase || title === phrase) return 0;
  if (name.startsWith(phrase) || title.startsWith(phrase)) return 1;
  return 2;
}

function mentionHaystack(item: MentionPickerItem): string {
  return [
    item.name,
    item.title,
    item.description,
    item.argumentHint ?? "",
    item.group,
    item.scope ?? "",
    item.aliasOf ?? "",
    item.badge ?? "",
    item.usage ?? "",
    ...(item.aliases ?? []),
  ]
    .join(" ")
    .toLowerCase();
}

/**
 * Filter rows by a case-insensitive multi-token query over the name, token,
 * description, argument hint, group and scope. Exact/prefix name matches rank
 * first; everything else keeps catalog order. Disabled (role-scoped) rows stay
 * visible so the operator sees them and can see why they are unavailable.
 */
export function filterMentionPickerItems(
  items: readonly MentionPickerItem[],
  query: string,
): MentionPickerItem[] {
  const trimmed = normalizeQuery(query).trim().toLowerCase();
  if (trimmed === "") return [...items];
  const tokens = trimmed.split(/\s+/).filter((token) => token !== "");
  return items
    .map((item, index) => ({ item, index, rank: rankMentionItem(item, trimmed) }))
    .filter(({ item }) => tokens.every((token) => mentionHaystack(item).includes(token)))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map(({ item }) => item);
}

/** Move the highlight by `delta`, wrapping around a non-empty filtered list. */
export function moveMentionPickerSelection(
  state: MentionPickerState,
  delta: number,
  count: number,
): MentionPickerState {
  if (count <= 0) return { ...state, active: 0 };
  const base = clamp(Math.floor(state.active), 0, count - 1);
  const active = (((base + Math.floor(delta)) % count) + count) % count;
  return { ...state, active };
}

/** The highlighted row of the filtered list, or `undefined` when empty. */
export function selectMentionPicker(state: MentionPickerState): MentionPickerItem | undefined {
  const filtered = filterMentionPickerItems(state.items, state.query);
  if (filtered.length === 0) return undefined;
  return filtered[clamp(Math.floor(state.active), 0, filtered.length - 1)];
}

/**
 * Fold one keypress into the open picker.
 *
 * Movement/accept/close come from the registry's `"mention"` scope, so the
 * footer hints and the behavior cannot disagree. Printable input and Backspace
 * are reported as `"filter"`; the app mirrors them into the editor and
 * re-detects the trigger, so the composer text and the filter never diverge.
 */
export function mentionPickerKey(
  commands: readonly TuiCommand[],
  state: MentionPickerState,
  key: KeyLike,
): MentionPickerKeyResult {
  if (!state.open) return { state, action: "none" };
  const filtered = filterMentionPickerItems(state.items, state.query);
  const match = resolveKey(commands, key, "mention");
  if (match !== null) {
    switch (match.command.id) {
      case "mention-close":
      case "mention-dismiss":
        return { state, action: "close" };
      case "mention-move": {
        const delta = match.chord.name.toLowerCase() === "up" ? -1 : 1;
        return { state: moveMentionPickerSelection(state, delta, filtered.length), action: "move" };
      }
      case "mention-accept": {
        const item = selectMentionPicker(state);
        if (item === undefined) return { state, action: "none" };
        if (item.disabled === true) {
          return {
            state,
            action: "blocked",
            item,
            ...(item.disabledReason !== undefined ? { reason: item.disabledReason } : {}),
          };
        }
        return {
          state,
          action: "accept",
          item,
          chordName: match.chord.name.toLowerCase(),
        };
      }
      default:
        break;
    }
  }
  const name = (key.name || "").toLowerCase();
  if (name === "backspace" || key.raw === "\u007f" || key.raw === "\b") {
    return { state: updateMentionPicker(state, dropLastGrapheme(state.query)), action: "filter" };
  }
  const text = printableKeyText(key);
  if (text !== null) {
    return { state: updateMentionPicker(state, state.query + text), action: "filter" };
  }
  return { state, action: "none" };
}

/** Footer hints derived from the registry. */
export function mentionPickerHints(commands: readonly TuiCommand[] = TUI_COMMANDS): string {
  const derived = hintSegments(commands, [
    { id: "mention-move", label: "move" },
    { id: "mention-accept", label: "insert" },
    { id: "mention-close", label: "close" },
    { id: "mention-dismiss", label: "dismiss" },
  ]);
  return derived === "" ? "type to filter" : `${derived} · type to filter`;
}

/**
 * One-line hint for the selected row: its usage form plus the description
 * (and, for a disabled row, why it cannot be used). Rendered as the picker's
 * selection footer so the operator can read what a row will do before
 * inserting it; `""` when nothing is selected.
 */
export function mentionPickerSelectionHint(item: MentionPickerItem | undefined): string {
  if (item === undefined) return "";
  const parts = [item.usage ?? item.title];
  if (item.description !== "") parts.push(item.description);
  if (item.argumentHint !== undefined && item.argumentHint !== "" && item.usage === undefined) {
    parts[0] = `${item.title} ${item.argumentHint}`;
  }
  if (item.disabled === true && item.disabledReason !== undefined) parts.push(item.disabledReason);
  return parts.join(" — ");
}

// --------------------------------------------------------------------------- //
// rendering
// --------------------------------------------------------------------------- //

/** Render options for the inline picker. */
export interface MentionPickerRenderOptions {
  /** Terminal width; every row is exactly this many cells. */
  width: number;
  /** Total row budget (header + list + footers). Default 8. */
  maxRows?: number;
  theme?: Theme;
  /** Override the registry-derived hint line (tests/embedding). */
  hints?: string;
}

/** The rendered inline picker plus its geometry. */
export interface MentionPickerView {
  /** At most `maxRows` rows, each exactly `width` cells. */
  lines: string[];
  visible: MentionPickerItem[];
  /** Line index of the active row, or -1 when nothing is selectable. */
  selectedRow: number;
  noMatch: boolean;
  /** Group headings present in the filtered list, in display order. */
  groups: string[];
}

interface PickerRow {
  kind: "group" | "item";
  label: string;
  item: MentionPickerItem | null;
  index: number;
}

function buildPickerRows(items: readonly MentionPickerItem[], showGroups: boolean): PickerRow[] {
  const rows: PickerRow[] = [];
  let lastGroup: string | null = null;
  items.forEach((item, index) => {
    if (showGroups && item.group !== lastGroup) {
      rows.push({ kind: "group", label: item.group, item: null, index: -1 });
      lastGroup = item.group;
    }
    rows.push({ kind: "item", label: item.title, item, index });
  });
  return rows;
}

function styledRow(
  theme: Theme,
  tone: ThemeToken,
  text: string,
  width: number,
): string {
  const clean = viewTruncate(sanitizeDisplayText(text), width);
  return viewPad(theme.paint(tone, clean), width);
}

function itemRow(
  item: MentionPickerItem,
  options: { width: number; selected: boolean; theme: Theme },
): string {
  const marker = options.selected ? "› " : "  ";
  let label = item.title;
  if (item.argumentHint !== undefined && item.argumentHint !== "") {
    label += ` ${item.argumentHint}`;
  }
  if (item.badge !== undefined) label += ` [${item.badge}]`;
  if (item.kind === "skill" && item.scope !== undefined && item.scope !== "shared") {
    label += ` [${item.scope}]`;
  }
  let text = `${marker}${label}`;
  if (options.width >= 64 && item.description !== "") text += ` — ${item.description}`;
  if (item.disabled === true) text += " [unavailable]";
  const tone: ThemeToken =
    item.disabled === true ? "muted" : options.selected ? "focus" : "text";
  return styledRow(options.theme, tone, text, options.width);
}

/**
 * Render the open picker as width-exact inline rows.
 *
 * A zero-width render is empty; otherwise the list is windowed around the
 * active row (group headings included) so the selection is always visible, and
 * whole groups are dropped on terminals narrower than 24 cells. The empty and
 * no-match states are honest: "No slash commands registered.",
 * "No skills discovered — add <name>/SKILL.md to a skills root." and
 * `No commands/skills match "query".`
 */
export function mentionPickerView(
  state: MentionPickerState,
  options: MentionPickerRenderOptions,
): MentionPickerView {
  const columns = Number.isFinite(options.width) ? Math.max(0, Math.floor(options.width)) : 0;
  const theme = options.theme ?? plainTheme;
  const filtered = filterMentionPickerItems(state.items, state.query);
  const noMatch = filtered.length === 0;
  const groups = mentionPickerGroups(filtered);
  if (!state.open || columns === 0) {
    return { lines: [], visible: [], selectedRow: -1, noMatch, groups };
  }
  const maxRows = Math.max(3, Math.floor(options.maxRows ?? 8));
  const selected = noMatch ? -1 : clamp(Math.floor(state.active), 0, filtered.length - 1);
  const kindLabel =
    state.kind === "command" ? "COMMANDS" : state.kind === "skill" ? "SKILLS" : "WORKSPACE FILES";
  const filter = state.query === "" ? "" : `  filter: ${state.query}`;
  const header = styledRow(theme, "accent", `${kindLabel} (${filtered.length})${filter}`, columns);
  const footerRows: string[] = [];
  const selectedItem = selected < 0 ? undefined : filtered[selected];
  const selectionHint = mentionPickerSelectionHint(selectedItem);
  if (selectionHint !== "") footerRows.push(styledRow(theme, "muted", selectionHint, columns));
  footerRows.push(styledRow(theme, "dim", options.hints ?? mentionPickerHints(), columns));
  if (state.kind === "skill") {
    footerRows.push(
      styledRow(
        theme,
        "muted",
        "Only shared skills can be @mentioned by the operator.",
        columns,
      ),
    );
  } else if (state.kind === "file") {
    footerRows.push(
      styledRow(
        theme,
        "muted",
        "The file is read read-only from the bound workspace and attached before the run.",
        columns,
      ),
    );
  }
  const capacity = Math.max(0, maxRows - 1 - footerRows.length);
  const rows: MentionPickerRowRender[] = [];
  if (noMatch) {
    const message = filtered.length === 0
      ? state.items.length === 0
        ? state.kind === "command"
          ? "No slash commands registered."
          : state.kind === "skill"
            ? "No skills discovered — add <name>/SKILL.md to a skills root."
            : "No workspace files indexed — start the TUI with --workspace <dir>."
        : state.kind === "command"
          ? `No commands match "${state.query}".`
          : state.kind === "skill"
            ? `No skills match "${state.query}".`
            : `No workspace files match "${state.query}".`
      : "";
    if (message !== "") rows.push({ kind: "text", text: message });
  } else if (capacity > 0) {
    const listRows = buildPickerRows(filtered, columns >= 24);
    const selectedIndex = listRows.findIndex(
      (row) => row.kind === "item" && row.index === selected,
    );
    const start = windowStart(listRows.length, Math.max(0, selectedIndex), capacity);
    for (const row of listRows.slice(start, start + capacity)) {
      if (row.kind === "group") rows.push({ kind: "text", text: `[${row.label}]` });
      else if (row.item !== null) {
        rows.push({
          kind: "item",
          text: "",
          item: row.item,
          selected: row.index === selected,
        });
      }
    }
  }
  while (rows.length < capacity) rows.push({ kind: "text", text: "" });
  const body = rows.slice(0, capacity).map((row) => {
    if (row.kind === "item" && row.item !== undefined) {
      return itemRow(row.item, {
        width: columns,
        selected: row.selected === true,
        theme,
      });
    }
    return styledRow(theme, row.kind === "text" && row.text.startsWith("[") ? "accent" : "muted", row.text, columns);
  });
  const visible = rows
    .filter((row): row is MentionPickerRowRender & { item: MentionPickerItem } => row.item !== undefined)
    .map((row) => row.item);
  let selectedRow = -1;
  if (selected >= 0) {
    const position = rows.findIndex((row) => row.selected === true);
    if (position >= 0) selectedRow = 1 + position;
  }
  const lines = [header, ...body, ...footerRows].slice(0, maxRows);
  return { lines, visible, selectedRow: selectedRow < lines.length ? selectedRow : -1, noMatch, groups };
}

interface MentionPickerRowRender {
  kind: "text" | "item";
  text: string;
  item?: MentionPickerItem;
  selected?: boolean;
}

/** Convenience wrapper returning only the rendered rows. */
export function renderMentionPicker(
  state: MentionPickerState,
  options: MentionPickerRenderOptions | number,
): string[] {
  return mentionPickerView(state, typeof options === "number" ? { width: options } : options).lines;
}
