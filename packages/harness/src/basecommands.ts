/**
 * Base commands: the first-party slash-command surface every entry point shares.
 *
 * `commands.ts` covers *discovered* commands (`<name>.md` prompt templates in a
 * commands root). This module covers the commands that ship with the product,
 * adapted from the two reference harnesses:
 *
 * - deepseek-harness's builtin identities (`goal`, `plan`, `feedback`,
 *   `compact`, `permission`, `export`) — see
 *   `research/vendor/deepseek-harness/packages/interaction/commands/src/builtin.ts`
 *   and the per-command packages next to it;
 * - kimi-code's builtin TUI slash commands (`help`, `compact`, `goal`,
 *   `export`, `model`-family, `theme`, `status`, …) — see
 *   `research/vendor/kimi-code/apps/kimi-code/src/tui/commands/registry.ts`.
 *
 * Two adaptations matter:
 *
 * 1. **Two kinds, honestly declared.** A `prompt` command is a first-party
 *    template: it expands to a normal user task (a `mode` override included)
 *    and is therefore valid on every surface — server, web, TUI and the CLI
 *    chat REPL all just submit the expanded text. An `action` command is *not*
 *    a task: some surface performs it (compact the context, export the
 *    session, show help, …). A surface that cannot perform an action must say
 *    so; submitting an action command as a task is an error, never a silently
 *    empty turn (see `prepareSubmission` in `server.ts`).
 * 2. **Names never shadow each other silently.** A discovered `<name>.md`
 *    keeps priority over a base command of the same name (deepseek-harness's
 *    `resolveCommand` "exact scoped name wins" rule), so an operator can
 *    override `/plan` with their own template. Base names never shadow a
 *    surface's own hard-wired commands either: the TUI keeps its native
 *    `/help`, `/mode`, `/sessions`, `/theme` keymap entries, and only the
 *    names it does not already provide are added from this catalogue.
 *
 * Everything here is pure data plus a literal `$ARGUMENTS` expansion. The
 * expansion rules are exactly `expandCommand`'s (one pass, `$ARGUMENTS`, `$1`
 * … `$9`, `$$`; a lone `$`, `$0` and `$10+` stay literal), so a base command
 * behaves like a discovered one after expansion. Nothing here reads the
 * environment, the filesystem or the session store: dispatch belongs to the
 * surface, and `baseCommandMetadata()` is the serializable form the HTTP API
 * serves (metadata only — template bodies never leave the process).
 *
 * Aliases include the reference Chinese spellings (`目标/计划/反馈/压缩/权限/导出`)
 * on top of the English ones. Typed submission resolves through
 * `findBaseCommand`, so an alias works anywhere a catalogue lookup happens;
 * `matchCommand`'s ASCII name rule still governs which lines reach that
 * lookup, and pickers search aliases as keywords rather than inserting them.
 */

import { expandTemplate } from "./commands.ts";

/** What a surface does with a base command invocation. */
export type BaseCommandKind = "prompt" | "action";

/**
 * The actions a surface may perform for a base command. Each surface supports
 * a subset; one that cannot perform an action reports that honestly instead of
 * submitting a task.
 *
 * - `compact`   — summarize the older context in place (`compactContext`).
 * - `export`    — write/download this session as Markdown.
 * - `permission`— show the approval policy and the configured tool scopes.
 * - `help`      — show commands and keyboard shortcuts.
 * - `status`    — show run, context and session status.
 * - `mode`      — switch the cooperation mode (`consult` / `work` / `auto`).
 * - `new`       — start a fresh session/context in the current workspace.
 */
export type BaseCommandAction =
  | "compact"
  | "export"
  | "permission"
  | "help"
  | "status"
  | "mode"
  | "new";

/** One first-party command. */
export interface BaseCommand {
  /** Canonical spelling without the leading slash, `[a-z][a-z0-9-]*`. */
  name: string;
  /**
   * Additional typed spellings (English synonyms plus the reference Chinese
   * spellings). Never used instead of `name` when inserting a command.
   */
  aliases: readonly string[];
  /** One-line summary for pickers, `/help` and `GET /api/commands`. */
  description: string;
  /** Argument placeholder shown after the name, e.g. `"<goal>"`; `""` when none. */
  argumentHint: string;
  /** `prompt` commands expand; `action` commands are performed by a surface. */
  kind: BaseCommandKind;
  /**
   * Prompt commands only: the literal template body. Expansion is
   * `expandCommand`'s one-pass `$ARGUMENTS`/`$1`…`$9`/`$$` substitution.
   */
  template?: string;
  /** Prompt commands only: cooperation mode the expanded run uses. */
  mode?: "consult" | "work" | "auto";
  /** Action commands only: what a surface performs for this command. */
  action?: BaseCommandAction;
  /**
   * Whether an empty argument list is a usage error. Required-argument prompt
   * commands fail loudly (`/plan` with no goal) instead of submitting a
   * template whose `$ARGUMENTS` hole makes the task meaningless.
   */
  requiresArguments: boolean;
  /**
   * Higher priorities sort first, matching the reference catalogues; ties
   * break on `name` so every surface renders the same order.
   */
  priority: number;
}

/**
 * The catalogue. Order is irrelevant — `BASE_COMMANDS` is kept sorted by
 * {@link sortBaseCommands} for every consumer.
 */
export const BASE_COMMANDS: readonly BaseCommand[] = Object.freeze(
  (
    [
      {
        name: "plan",
        aliases: ["计划"],
        description: "Agree an ordered, verifiable plan before changing anything",
        argumentHint: "<objective>",
        kind: "prompt",
        mode: "consult",
        requiresArguments: true,
        priority: 100,
        template:
          "The operator wants a plan before any change. Objective: $ARGUMENTS\n" +
          "\n" +
          "Senior: restate the objective and its constraints, then have your brother " +
          "inspect what the plan would touch. Reply with an ordered plan; every step " +
          "names the check that proves it works. Do not start implementing in this turn.",
      },
      {
        name: "compact",
        aliases: ["压缩"],
        description: "Compact the conversation context into a summary",
        argumentHint: "",
        kind: "action",
        action: "compact",
        requiresArguments: false,
        priority: 95,
      },
      {
        name: "goal",
        aliases: ["objective", "目标"],
        description: "Set the session goal and the success criteria it will be held to",
        argumentHint: "<objective>",
        kind: "prompt",
        mode: "consult",
        requiresArguments: true,
        priority: 90,
        template:
          "The operator set this session goal: $ARGUMENTS\n" +
          "\n" +
          "Senior: restate the goal in one sentence and list the success criteria the " +
          "session will be held to; Junior: say what you need to know before work can " +
          "start. Keep the goal in mind on later turns. Do not start implementing in " +
          "this turn unless the goal states it.",
      },
      {
        name: "status",
        aliases: [],
        description: "Show run, context and session status",
        argumentHint: "",
        kind: "action",
        action: "status",
        requiresArguments: false,
        priority: 85,
      },
      {
        name: "export",
        aliases: ["export-md", "导出"],
        description: "Export this session as Markdown",
        argumentHint: "[path]",
        kind: "action",
        action: "export",
        requiresArguments: false,
        priority: 80,
      },
      {
        name: "mode",
        aliases: [],
        description: "Switch the cooperation mode (consult, work or auto)",
        argumentHint: "[consult|work|auto]",
        kind: "action",
        action: "mode",
        requiresArguments: false,
        priority: 75,
      },
      {
        name: "permission",
        aliases: ["permissions", "权限"],
        description: "Choose a permission preset and show the configured tool scopes",
        argumentHint: "[read-only|ask|workspace-write|danger-full-access]",
        kind: "action",
        action: "permission",
        requiresArguments: false,
        priority: 70,
      },
      {
        name: "new",
        aliases: ["clear", "reset"],
        description: "Start a fresh session in the current workspace",
        argumentHint: "",
        kind: "action",
        action: "new",
        requiresArguments: false,
        priority: 65,
      },
      {
        name: "feedback",
        aliases: ["bug", "review", "反馈"],
        description: "Turn operator feedback on the last turn into follow-up work",
        argumentHint: "[notes]",
        kind: "prompt",
        mode: "consult",
        requiresArguments: false,
        priority: 60,
        template:
          "The operator left feedback on the last turn: $ARGUMENTS\n" +
          "\n" +
          "Senior: decide what the brothers must change now and what can wait; Junior: " +
          "point at the exact files, steps or messages affected. Finish with a short " +
          "list of follow-ups the session will act on.",
      },
      {
        name: "help",
        aliases: ["h", "?"],
        description: "List built-in commands and keyboard shortcuts",
        argumentHint: "",
        kind: "action",
        action: "help",
        requiresArguments: false,
        priority: 50,
      },
    ] as const satisfies readonly BaseCommand[]
  ).map((command) => Object.freeze({ ...command })),
);

/** Serialized form served by `GET /api/commands` (no template bodies). */
export interface BaseCommandMetadata {
  name: string;
  aliases: string[];
  description: string;
  argumentHint: string;
  kind: BaseCommandKind;
  /** Present only for `kind: "action"`. */
  action?: BaseCommandAction;
  requiresArguments: boolean;
  priority: number;
}

/** Copy of the catalogue sorted by descending priority, then name. */
export function sortBaseCommands(
  commands: readonly BaseCommand[] = BASE_COMMANDS,
): BaseCommand[] {
  return [...commands].sort(
    (a, b) => b.priority - a.priority || a.name.localeCompare(b.name),
  );
}

/** `name` plus aliases — every spelling that resolves to this command. */
export function baseCommandTokens(command: BaseCommand): string[] {
  return [command.name, ...command.aliases];
}

/**
 * Resolve a typed spelling to a base command.
 *
 * Case-insensitive. The canonical name is checked before any alias, so a
 * canonical name always maps to its own command even if some other command
 * lists it as an alias (the catalogue does not do that; the ordering is pinned
 * anyway). An unknown token returns `undefined` — the caller decides whether
 * it falls back to a discovered template or stays verbatim.
 */
export function findBaseCommand(token: string): BaseCommand | undefined {
  const needle = token.trim().toLowerCase();
  if (needle === "") return undefined;
  const exact = BASE_COMMANDS.find((command) => command.name === needle);
  if (exact !== undefined) return exact;
  return BASE_COMMANDS.find((command) =>
    command.aliases.some((alias) => alias.toLowerCase() === needle),
  );
}

/**
 * Expand a prompt command's template with literal one-pass substitution.
 *
 * Byte-identical to `expandCommand`'s rules so a base command and a discovered
 * template with the same body produce the same task: `$ARGUMENTS` is the whole
 * input as given, `$1`..`$9` are the whitespace-split input (missing positions
 * become `""`), `$$` yields a literal `$`, and a lone `$`, `$0` and `$10+`
 * stay literal (`$10` reads as `$1` followed by `0`). No re-expansion, no
 * shell, no filesystem.
 *
 * Throws a `RangeError` for a `prompt` command without a template (the
 * catalogue is a compile-time constant, so this is a programming error) and
 * throws when `requiresArguments` is set and `args` is blank — surfaces
 * translate that into a usage message (`/plan <objective>`).
 */
export function expandBaseCommand(command: BaseCommand, args: string): string {
  if (command.kind !== "prompt" || command.template === undefined) {
    throw new RangeError(`base command "/${command.name}" has no prompt template`);
  }
  const input = args.trim();
  if (command.requiresArguments && input === "") {
    const usage = baseCommandUsage(command);
    throw new RangeError(
      `base command "${usage.split(" ")[0]}" requires arguments (usage: ${usage})`,
    );
  }
  return expandTemplate(command.template, input);
}

/** Serializable catalogue for `GET /api/commands` and client caches. */
export function baseCommandMetadata(): BaseCommandMetadata[] {
  return sortBaseCommands().map((command) => ({
    name: command.name,
    aliases: [...command.aliases],
    description: command.description,
    argumentHint: command.argumentHint,
    kind: command.kind,
    ...(command.action === undefined ? {} : { action: command.action }),
    requiresArguments: command.requiresArguments,
    priority: command.priority,
  }));
}

/**
 * Usage line for a base command, e.g. `/plan <objective>` — the one rendering
 * every surface uses in help text and usage errors.
 */
export function baseCommandUsage(command: BaseCommand): string {
  return command.argumentHint === ""
    ? `/${command.name}`
    : `/${command.name} ${command.argumentHint}`;
}
