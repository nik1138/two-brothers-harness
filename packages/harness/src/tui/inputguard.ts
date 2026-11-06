/**
 * Key-repeat guard for composer submits and picker acceptance.
 *
 * Terminals differ: some forward an explicit auto-repeat flag, most simply
 * deliver the same keypress again every OS repeat interval. A held Enter (or
 * Tab while the inline picker is open) must never fire the same submit twice —
 * in the worst case that fills the transcript with "turn still running"
 * refusals or inserts a token twice.
 *
 * The guard is registry-driven (no key names live here): it resolves the key
 * through `keymap.ts` in the current context and only guards commands whose
 * repetition is destructive (`submit`, `mention-accept`). It suppresses
 * - an explicit `repeat: true` key event, and
 * - an identical key event for the same command, on unchanged composer text,
 *   within {@link REPEAT_GUARD_MS} of the previous one (the window slides so a
 *   held key stays suppressed).
 *
 * The default window is 400 ms (`REPEAT_GUARD_MS`), which covers the common OS
 * auto-repeat rates while still allowing a deliberate second Enter after the
 * operator edits the draft.
 *
 * Typing a draft between presses changes `text`, so a deliberate second Enter
 * is never swallowed; arrow keys, Left/Right and plain text are never
 * guarded.
 */
import { resolveKey, TUI_COMMANDS, type KeyLike, type TuiCommand } from "./keymap.ts";

/** Identical-key window, in milliseconds (covers common OS repeat rates). */
export const REPEAT_GUARD_MS = 400;

/** Commands whose repeated delivery is destructive. */
export type RepeatSensitiveCommand = "submit" | "mention-accept";

/** One guarded keypress, kept between events by the app. */
export interface RepeatGuardSnapshot {
  commandId: RepeatSensitiveCommand;
  /** Modifier/name/raw identity of the key event. */
  signature: string;
  /** Composer text when the key was last seen. */
  text: string;
  /** Timestamp (ms) of the last accepted or suppressed event. */
  at: number;
}

/** Result of one guarded keypress. */
export interface RepeatGuardDecision {
  suppress: boolean;
  /** The snapshot the app must store (`null` for unguarded keys). */
  snapshot: RepeatGuardSnapshot | null;
}

/** Options for {@link guardComposerSubmit}. */
export interface RepeatGuardOptions {
  commands?: readonly TuiCommand[];
  /** The inline `/` picker is open: Enter/Tab accept instead of submit. */
  mentionOpen?: boolean;
  /** Injected clock for tests. */
  now?: number;
  /** Injected window for tests. */
  windowMs?: number;
}

/** Stable identity of one key event (name + modifiers + raw). */
export function keySignature(key: KeyLike): string {
  return [
    (key.name || "").toLowerCase(),
    key.ctrl === true ? "ctrl" : "-",
    key.shift === true ? "shift" : "-",
    key.alt === true ? "alt" : "-",
    key.raw ?? "",
  ].join("|");
}

/**
 * The repeat-sensitive command a keypress would run in the current context, or
 * `null` for ordinary typing/editing keys.
 */
export function repeatSensitiveCommand(
  commands: readonly TuiCommand[],
  key: KeyLike,
  options: { mentionOpen?: boolean } = {},
): RepeatSensitiveCommand | null {
  if (options.mentionOpen === true) {
    return resolveKey(commands, key, "mention")?.command.id === "mention-accept"
      ? "mention-accept"
      : null;
  }
  return resolveKey(commands, key, "app")?.command.id === "submit" ? "submit" : null;
}

/** Fold one keypress through the repeat guard. */
export function guardComposerSubmit(
  previous: RepeatGuardSnapshot | null,
  key: KeyLike,
  text: string,
  options: RepeatGuardOptions = {},
): RepeatGuardDecision {
  const commands = options.commands ?? TUI_COMMANDS;
  const commandId = repeatSensitiveCommand(commands, key, {
    ...(options.mentionOpen !== undefined ? { mentionOpen: options.mentionOpen } : {}),
  });
  if (commandId === null) return { suppress: false, snapshot: null };
  const now = options.now ?? Date.now();
  const windowMs = options.windowMs ?? REPEAT_GUARD_MS;
  const signature = keySignature(key);
  const snapshot: RepeatGuardSnapshot = { commandId, signature, text, at: now };
  if (key.repeat === true) return { suppress: true, snapshot };
  if (
    previous !== null &&
    previous.commandId === commandId &&
    previous.signature === signature &&
    previous.text === text &&
    now - previous.at < windowMs
  ) {
    return { suppress: true, snapshot };
  }
  return { suppress: false, snapshot };
}
