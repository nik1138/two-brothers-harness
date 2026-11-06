/**
 * TUI adapter for the shared base-command catalogue (`src/basecommands.ts`).
 *
 * The catalogue is surface-neutral; this module decides what the TUI shows and
 * how a typed invocation resolves there:
 *
 * - the TUI's own keymap slash commands always win, so base entries sharing a
 *   name or alias with a native command (`help`, `mode`, …) are not surfaced;
 * - a discovered `<name>.md` template shadows a same-named base command
 *   (kept precedence: template expansion happens before base lookup);
 * - a `prompt` command plans a normal turn's exact task bytes and mode
 *   override — the same expansion `expandCommand` uses;
 * - an `action` command is *never* a task; the app performs it and reports
 *   honestly when a prerequisite is missing.
 *
 * Help/palette rows are synthetic {@link PaletteEntry} values with the
 * `base-command` kind, grouped by prompt/action and ordered by the shared
 * priority. The inline `/` picker rows live in `view/mentionpicker.ts`, which
 * consumes the same filtered catalogue.
 */
import {
  BASE_COMMANDS,
  baseCommandUsage,
  expandBaseCommand,
  sortBaseCommands,
  type BaseCommand,
} from "../basecommands.ts";
import type { Config } from "../config.ts";
import { TUI_COMMANDS, type PaletteEntry, type SlashCommandInfo, type TuiCommand } from "./keymap.ts";

/** Palette-entry id prefix for a base command (`base:plan`). */
export const BASE_COMMAND_ENTRY_PREFIX = "base:";

/** The badge the picker/help renders for a base command. */
export type BaseCommandBadge = "builtin" | "action";

/** Badge for one base command: prompt commands are builtins, actions say so. */
export function baseCommandBadge(command: BaseCommand): BaseCommandBadge {
  return command.kind === "action" ? "action" : "builtin";
}

/** Every native TUI slash spelling (names and aliases), lowercased. */
export function tuiNativeCommandTokens(
  commands: readonly TuiCommand[] = TUI_COMMANDS,
): Set<string> {
  const tokens = new Set<string>();
  for (const command of commands) {
    if (command.slash !== undefined) tokens.add(command.slash.toLowerCase());
    for (const alias of command.slashAliases ?? []) tokens.add(alias.toLowerCase());
  }
  return tokens;
}

/** Options for {@link tuiBaseCommands}. */
export interface TuiBaseCommandOptions {
  /** Registry commands whose names win (default {@link TUI_COMMANDS}). */
  commands?: readonly TuiCommand[];
  /** Discovered templates whose names shadow a same-named base command. */
  templates?: readonly SlashCommandInfo[];
}

/**
 * The base commands the TUI surfaces: native-shadowed and template-shadowed
 * names are dropped, the rest is ordered by the shared priority (descending,
 * then name) so every TUI render has one deterministic order.
 */
export function tuiBaseCommands(options: TuiBaseCommandOptions = {}): BaseCommand[] {
  const native = tuiNativeCommandTokens(options.commands ?? TUI_COMMANDS);
  const templates = new Set(
    (options.templates ?? []).map((template) => template.name.toLowerCase()),
  );
  return sortBaseCommands().filter(
    (command) => !native.has(command.name.toLowerCase()) && !templates.has(command.name.toLowerCase()),
  );
}

/**
 * Synthetic help/palette entries for the given catalogue: prompt commands
 * under "Built-in prompts", actions under "Built-in actions", each sorted by
 * the catalogue priority. Selecting one is handled by the app's
 * `dispatchEntry`, which inserts/expands or performs the action.
 */
export function tuiBasePaletteEntries(
  commands: readonly BaseCommand[] = tuiBaseCommands(),
): PaletteEntry[] {
  const sorted = sortBaseCommands(commands);
  const entriesFor = (kind: BaseCommand["kind"]): PaletteEntry[] =>
    sorted
      .filter((command) => command.kind === kind)
      .map((command) => ({
        id: `${BASE_COMMAND_ENTRY_PREFIX}${command.name}`,
        title: `/${command.name}`,
        description: command.description,
        group: kind === "prompt" ? "Built-in prompts" : "Built-in actions",
        keys: "",
        slash: `/${command.name}`,
        argumentHint: command.argumentHint,
        kind: "base-command" as const,
        disabled: false,
        disabledReason: "",
        mode: command.mode ?? "",
      }));
  return [...entriesFor("prompt"), ...entriesFor("action")];
}

/** A typed non-ASCII alias that names a known base command. */
export interface NonAsciiBaseAlias {
  /** The alias exactly as typed (without the leading slash). */
  alias: string;
  command: BaseCommand;
  /** Canonical usage line (`/goal <objective>`). */
  usage: string;
  /** Neutral notice naming the canonical ASCII spelling; picker-only aliases. */
  message: string;
}

const ASCII_ONLY = /^[\x00-\x7f]*$/;

/**
 * Detect a typed slash line whose command token is a known *non-ASCII* base
 * alias (e.g. `/目标 …`). `matchCommand`'s ASCII name gate cannot resolve those,
 * so without this guard the line would fall through and run as a literal task.
 *
 * Mirrors the web rule: the typed alias never becomes a task. The caller shows
 * the returned neutral notice (canonical ASCII usage + "picker-only" reason)
 * and keeps the composer text, while canonical names and ASCII aliases keep
 * flowing through the normal resolver and the picker keeps searching aliases.
 * Unknown non-ASCII slash text is not a command and stays literal (`null`).
 */
export function nonAsciiBaseAliasNotice(input: string): NonAsciiBaseAlias | null {
  const trimmed = typeof input === "string" ? input.trim() : "";
  if (!trimmed.startsWith("/")) return null;
  const token = /^([^\s]+)/.exec(trimmed.slice(1))?.[1] ?? "";
  // Canonical names and ASCII aliases take the established resolver path.
  if (token === "" || ASCII_ONLY.test(token)) return null;
  const command = BASE_COMMANDS.find((candidate) =>
    candidate.aliases.some((alias) => alias.toLowerCase() === token.toLowerCase()),
  );
  if (command === undefined) return null;
  const usage = baseCommandUsage(command);
  return {
    alias: token,
    command,
    usage,
    message:
      `use ${usage} — "${token}" is a non-ASCII alias and is picker-only; ` +
      "type the canonical spelling or pick it from the / command picker",
  };
}

/** A base prompt command resolved to the turn the TUI should start. */
export type BaseCommandSubmission =
  | { kind: "run"; task: string; mode: Config["mode"] }
  | { kind: "usage"; message: string };

/**
 * Plan one `/name args` invocation for a base command.
 *
 * `prompt` commands return the expanded task bytes (the exact
 * `expandCommand`-compatible substitution) plus the mode override: the
 * command's own `mode` wins, else the session's current mode. A missing
 * required argument becomes a usage error carrying the shared usage line, so
 * the caller shows it and never submits an empty task. `action` commands are
 * not tasks at all — the caller routes them to the action dispatcher first.
 */
export function planBaseCommandSubmission(
  command: BaseCommand,
  args: string,
  currentMode: Config["mode"],
): BaseCommandSubmission {
  if (command.kind !== "prompt") {
    return { kind: "usage", message: `usage: ${baseCommandUsage(command)}` };
  }
  try {
    return {
      kind: "run",
      task: expandBaseCommand(command, args),
      mode: command.mode ?? currentMode,
    };
  } catch (exc) {
    return {
      kind: "usage",
      message: exc instanceof Error ? `usage: ${baseCommandUsage(command)}` : String(exc),
    };
  }
}
