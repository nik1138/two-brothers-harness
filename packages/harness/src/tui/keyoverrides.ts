/**
 * File-configured rebinding for a small, safe allowlist of global TUI commands.
 *
 * The configuration surface is a plain, versioned JSON document written by the
 * operator (there is no in-TUI editor in this slice):
 *
 * ```json
 * { "version": 1, "bindings": { "palette": ["ctrl+g"], "help": ["f2"], "stash": ["ctrl+u"] } }
 * ```
 *
 * The file path comes from `tui --keys-file <path>`, the
 * `TWO_BROTHERS_TUI_KEYS_FILE` environment variable, or the default
 * `~/.two-brothers/tui-keys.json`. A missing file means the registry defaults;
 * any unreadable/invalid document is reported through `diagnostics[]` and the
 * defaults stay in force (fail-soft, never a crash, never a partial table that
 * could bind the same key twice).
 *
 * ## Why an allowlist?
 *
 * Only commands that are global, non-typing and outside the app's modal
 * layering may be rebound:
 *
 * - `palette` — the Ctrl+P command palette (always-scope; opens a modal list);
 * - `help` — the shortcut reference / help overlay (always-scope; the literal
 *   `?` keeps its "typing wins when the composer has text" rule, now derived
 *   from whichever chord the command carries);
 * - `stash` — stash/restore the composer draft (a one-slot, non-typing global
 *   action; no mutation of the workspace or the session).
 *
 * Everything else is intentionally fixed: typing/prompt-insertion keys and
 * newline/submit (`submit`, `newline`, `complete`), Escape/quit layering
 * (`cancel`, `exit`), prompt history/navigation in the composer, transcript
 * scrolling/find, overlay and picker navigation/acceptance, and approval-panel
 * decisions. Those keys either produce text, are the operator's way out of a
 * modal state, or belong to an exclusive keyboard scope whose chords must stay
 * stable for the app's precedence rules to stay comprehensible.
 *
 * ## Chord grammar
 *
 * `[ctrl+][shift+][alt+]key` in any modifier order, case-insensitive
 * (`ctrl+p`, `Ctrl+Shift+P`, `alt+f2`, `?`, `pageup` is rejected as structural,
 * see below). The final token is exactly one key:
 *
 * - a named key from the terminal's key vocabulary (`return`/`enter`,
 *   `escape`/`esc`, `tab`, `backspace`, `delete`/`del`, `insert`/`ins`,
 *   `home`, `end`, `pageup`/`pgup`, `pagedown`/`pgdn`, `up`, `down`, `left`,
 *   `right`, `space`, `f1`…`f12`), or
 * - one printable character (a letter, digit or symbol).
 *
 * Unmodified letters and digits are rejected (they belong to typing); a symbol
 * such as `?` may be unmodified because it is not a typing key when no text is
 * pending. Structural keys (`return`, `escape`, `tab`, the arrows/page keys,
 * navigation keys and `space`) are rejected in every modifier combination:
 * they are the app's modal layer, and rebinding them would make the Escape /
 * quit / picker precedence depend on a user file. `ctrl+c` (quit), `ctrl+z`
 * (terminal suspend) and `ctrl+q`/`ctrl+s` (terminal flow control) are reserved
 * for the same reason.
 *
 * A file may only use the three allowlisted command ids; it cannot introduce a
 * new command. Chords may not repeat within one command or across the
 * allowlisted commands, and they may not collide with any *fixed* registry
 * chord (e.g. `ctrl+f` still belongs to find), so a rebinding can never shadow
 * an action the operator has no way to discover.
 */

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  formatChord,
  formatKeys,
  TUI_COMMANDS,
  type KeyChord,
  type TuiCommand,
} from "./keymap.ts";

/** Version of the JSON document shape this module understands. */
export const TUI_KEYS_VERSION = 1;

/** Upper bound on the configuration file (a hand-written file, not a database). */
export const TUI_KEYS_MAX_BYTES = 16 * 1024;

/** Upper bound on chords for one command (e.g. the help overlay has two). */
export const TUI_KEYS_MAX_CHORDS_PER_COMMAND = 4;

/** The only command ids a keys file may rebind (see the module comment). */
export const REBINDABLE_TUI_COMMAND_IDS = ["palette", "help", "stash"] as const;

/** One rebindable command id. */
export type RebindableTuiCommandId = (typeof REBINDABLE_TUI_COMMAND_IDS)[number];

/** Raw (already parsed) bindings: command id -> replacement chord list. */
export type TuiKeysBindings = Readonly<Record<string, readonly KeyChord[]>>;

/** Result of parsing one document: bindings are only returned when valid. */
export interface TuiKeysParseResult {
  bindings: TuiKeysBindings;
  diagnostics: readonly string[];
}

/** Result of reading one file. `found` is false for an absent path. */
export interface TuiKeysFileResult {
  bindings: TuiKeysBindings;
  diagnostics: readonly string[];
  found: boolean;
}

/** Result of resolving the effective command table. */
export interface TuiCommandsResolution {
  /** `TUI_COMMANDS` unchanged, or a fresh table with the overridden keys. */
  commands: readonly TuiCommand[];
  /** Empty on success; one honest line per problem otherwise. */
  diagnostics: readonly string[];
}

/** One parsed chord, or a reason why the spec cannot be used. */
export type TuiChordParse = { ok: true; chord: KeyChord } | { ok: false; error: string };

const REBINDABLE_SET: ReadonlySet<string> = new Set(REBINDABLE_TUI_COMMAND_IDS);

const NAMED_KEYS: ReadonlyMap<string, string> = new Map<string, string>([
  ["return", "return"],
  ["enter", "return"],
  ["escape", "escape"],
  ["esc", "escape"],
  ["tab", "tab"],
  ["backspace", "backspace"],
  ["delete", "delete"],
  ["del", "delete"],
  ["insert", "insert"],
  ["ins", "insert"],
  ["home", "home"],
  ["end", "end"],
  ["pageup", "pageup"],
  ["pgup", "pageup"],
  ["pagedown", "pagedown"],
  ["pgdn", "pagedown"],
  ["up", "up"],
  ["down", "down"],
  ["left", "left"],
  ["right", "right"],
  ["space", "space"],
  ...Array.from({ length: 12 }, (_, index) => [`f${index + 1}`, `f${index + 1}`] as const),
]);

const MODIFIERS: ReadonlyMap<string, "ctrl" | "shift" | "alt"> = new Map([
  ["ctrl", "ctrl"],
  ["control", "ctrl"],
  ["shift", "shift"],
  ["alt", "alt"],
  ["meta", "alt"],
  ["opt", "alt"],
]);

/** Keys that belong to typing, modal layering or navigation; never rebindable. */
const RESERVED_KEY_NAMES: ReadonlySet<string> = new Set([
  "return",
  "escape",
  "tab",
  "backspace",
  "delete",
  "insert",
  "home",
  "end",
  "pageup",
  "pagedown",
  "up",
  "down",
  "left",
  "right",
  "space",
]);

/** Terminal/quit control chords that must keep their meaning. */
const RESERVED_CTRL_KEYS: ReadonlySet<string> = new Set(["c", "z", "q", "s"]);

const NAME_ALIASES: ReadonlyMap<string, string> = new Map([
  ["enter", "return"],
  ["esc", "escape"],
  ["del", "delete"],
  ["ins", "insert"],
  ["pgup", "pageup"],
  ["pgdn", "pagedown"],
]);

/** Default configuration path (`~/.two-brothers/tui-keys.json`). */
export function defaultTuiKeysPath(home: string = homedir()): string {
  return join(home, ".two-brothers", "tui-keys.json");
}

/** True for one printable, non-control character (a typing key candidate). */
function isSinglePrintableChar(value: string): boolean {
  const units = [...value];
  if (units.length !== 1) return false;
  const char = units[0] ?? "";
  return char !== "" && !/\s/u.test(char) && !/[\u0000-\u001f\u007f]/u.test(char);
}

/** True for a letter or digit in any script (a typing key without modifiers). */
function isTypingCharacter(value: string): boolean {
  return /[\p{L}\p{N}]/u.test(value);
}

function describeProblem(error: string): string {
  return `invalid chord ${error}`;
}

/**
 * Parse one chord spec (`ctrl+p`, `f1`, `?`, `pageup`, …) into a `KeyChord`.
 * This is the grammar only: reserved/typing safety rules are applied when a
 * chord is *bound* ({@link resolveTuiCommands}), so the parser can describe any
 * key the terminal vocabulary has.
 */
export function parseTuiChord(spec: unknown): TuiChordParse {
  if (typeof spec !== "string") {
    return { ok: false, error: describeProblem("— expected a string") };
  }
  const text = spec.trim();
  if (text === "") return { ok: false, error: "invalid chord — the string is empty" };
  if (text.length > 64) return { ok: false, error: `invalid chord — too long (${text.length} chars)` };

  const parts = text.split("+");
  if (parts.some((part) => part.trim() === "")) {
    return { ok: false, error: `invalid chord "${text}" — empty part (write e.g. ctrl+p)` };
  }
  const keyToken = (parts[parts.length - 1] ?? "").trim();
  const modifierTokens = parts.slice(0, -1).map((part) => part.trim().toLowerCase());
  const modifiers: { ctrl: boolean; shift: boolean; alt: boolean } = {
    ctrl: false,
    shift: false,
    alt: false,
  };
  for (const token of modifierTokens) {
    const modifier = MODIFIERS.get(token);
    if (modifier === undefined) {
      return {
        ok: false,
        error: `invalid chord "${text}" — unknown modifier "${token}" (use ctrl, shift or alt)`,
      };
    }
    if (modifiers[modifier]) {
      return { ok: false, error: `invalid chord "${text}" — duplicate modifier "${token}"` };
    }
    modifiers[modifier] = true;
  }

  const lower = keyToken.toLowerCase();
  const named = NAMED_KEYS.get(lower);
  let name: string;
  if (named !== undefined) {
    name = named;
  } else if (isSinglePrintableChar(keyToken)) {
    // Single letters are canonical lowercase (readline reports them that way);
    // symbols keep their exact character.
    name = /[A-Za-z]/u.test(keyToken) ? lower : keyToken;
  } else {
    return {
      ok: false,
      error: `invalid chord "${text}" — the key must be a named key or one printable character`,
    };
  }

  const chord: KeyChord = { name };
  if (modifiers.ctrl) chord.ctrl = true;
  if (modifiers.shift) chord.shift = true;
  if (modifiers.alt) chord.alt = true;
  return { ok: true, chord };
}

/** Canonical registry key name (aliases folded; literals kept as typed). */
function canonicalKeyName(name: string): string {
  const lower = name.toLowerCase();
  const canonical = NAME_ALIASES.get(lower) ?? lower;
  if (NAMED_KEYS.has(canonical)) return NAMED_KEYS.get(canonical) ?? canonical;
  return name.length === 1 ? name : lower;
}

/** Canonical identity of one chord for duplicate/conflict comparisons. */
function chordIdentity(chord: KeyChord): string {
  const flags = `${chord.ctrl === true ? "C" : ""}${chord.alt === true ? "A" : ""}${
    chord.shift === true ? "S" : ""
  }`;
  return `${flags}:${canonicalKeyName(chord.name)}`;
}

/** Validate an already-shaped chord for rebinding (shared by parser + resolver). */
function chordBindingProblem(chord: unknown, where: string): string | null {
  if (chord === null || typeof chord !== "object" || Array.isArray(chord)) {
    return `${where}: chord must be an object`;
  }
  const candidate = chord as Partial<KeyChord> & { name?: unknown };
  if (typeof candidate.name !== "string" || candidate.name.trim() === "") {
    return `${where}: chord must have a non-empty name`;
  }
  const spec = formatChord(candidate as KeyChord);
  const named = NAMED_KEYS.get(candidate.name.toLowerCase());
  if (named !== undefined && RESERVED_KEY_NAMES.has(named)) {
    return `${where}: ${spec} is reserved for typing, navigation or the Escape/quit/picker layering`;
  }
  if (named === undefined && !isSinglePrintableChar(candidate.name)) {
    return `${where}: ${spec} is not a named key or a single printable character`;
  }
  const ctrl = candidate.ctrl === true;
  const shift = candidate.shift === true;
  const alt = candidate.alt === true;
  if (named === undefined && !ctrl && !shift && !alt && isTypingCharacter(candidate.name)) {
    return `${where}: ${spec} would swallow typing; add ctrl, shift or alt`;
  }
  if (ctrl && !shift && !alt && RESERVED_CTRL_KEYS.has(candidate.name.toLowerCase())) {
    return `${where}: ${spec} is reserved for quit/terminal control`;
  }
  return null;
}

function errorMessage(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

/**
 * Parse one versioned keys document. Structural problems (invalid JSON, wrong
 * version, a non-object `bindings` section, an empty/oversized chord list, an
 * unparsable chord) reject the whole document: the caller keeps the defaults.
 * Command-id/allowlist/duplicate/conflict checks happen in
 * {@link resolveTuiCommands}, which owns the registry.
 */
export function parseTuiKeysDocument(text: string, source: string): TuiKeysParseResult {
  // Accept a UTF-8 BOM: Windows editors commonly prepend one to hand-written
  // JSON, and a BOM must not turn a valid file into a diagnostic.
  const cleanText = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const fail = (message: string): TuiKeysParseResult => ({
    bindings: {},
    diagnostics: [`${source}: ${message}`],
  });

  let document: unknown;
  try {
    document = JSON.parse(cleanText);
  } catch (exc) {
    return fail(`invalid JSON (${errorMessage(exc)})`);
  }
  if (document === null || typeof document !== "object" || Array.isArray(document)) {
    return fail('the document must be a JSON object like { "version": 1, "bindings": { … } }');
  }
  const record = document as Record<string, unknown>;
  if (record.version !== TUI_KEYS_VERSION) {
    return fail(
      `unsupported version ${JSON.stringify(record.version)} (expected ${TUI_KEYS_VERSION})`,
    );
  }
  const rawBindings = record.bindings;
  if (rawBindings === undefined) {
    // A versioned document with no bindings section is an empty configuration.
    return { bindings: {}, diagnostics: [] };
  }
  if (rawBindings === null || typeof rawBindings !== "object" || Array.isArray(rawBindings)) {
    return fail('"bindings" must be an object mapping command ids to chord arrays');
  }

  const bindings: Record<string, readonly KeyChord[]> = {};
  const diagnostics: string[] = [];
  for (const [id, value] of Object.entries(rawBindings as Record<string, unknown>)) {
    if (!Array.isArray(value) || value.length === 0) {
      diagnostics.push(`${source}: "${id}" must be a non-empty array of chord strings`);
      continue;
    }
    if (value.length > TUI_KEYS_MAX_CHORDS_PER_COMMAND) {
      diagnostics.push(
        `${source}: "${id}" has ${value.length} chords (max ${TUI_KEYS_MAX_CHORDS_PER_COMMAND})`,
      );
      continue;
    }
    const chords: KeyChord[] = [];
    let entryOk = true;
    for (const rawChord of value) {
      const parsed = parseTuiChord(rawChord);
      if (!parsed.ok) {
        diagnostics.push(`${source}: "${id}": ${parsed.error}`);
        entryOk = false;
        break;
      }
      chords.push(parsed.chord);
    }
    if (entryOk) bindings[id] = chords;
  }
  if (diagnostics.length > 0) {
    // Fail soft and atomically: one bad entry never leaves a half-applied table.
    return { bindings: {}, diagnostics };
  }
  return { bindings, diagnostics: [] };
}

/** Options for {@link readTuiKeysFile}. */
export interface TuiKeysFileOptions {
  /** Report an absent file (the operator named it explicitly). */
  missingIsDiagnostic?: boolean;
  /**
   * What the diagnostics say happens on failure. The startup resolver keeps the
   * default chords; a live reload keeps the previous (last good) table, so the
   * reload path passes its own honest wording.
   */
  fallbackMessage?: string;
}

/**
 * Read and parse one keys file. A missing path is not an error by itself (the
 * default location is optional); pass `missingIsDiagnostic` when the operator
 * named the path explicitly, so a typo is reported instead of silently ignored.
 */
export function readTuiKeysFile(
  filePath: string,
  options: TuiKeysFileOptions = {},
): TuiKeysFileResult {
  const fallback = options.fallbackMessage ?? "using the default chords";
  let stats;
  try {
    stats = statSync(filePath);
  } catch (exc) {
    const code = (exc as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return {
        bindings: {},
        diagnostics:
          options.missingIsDiagnostic === true
            ? [`${filePath}: file not found; ${fallback}`]
            : [],
        found: false,
      };
    }
    return {
      bindings: {},
      diagnostics: [`${filePath}: cannot read (${errorMessage(exc)}); ${fallback}`],
      found: false,
    };
  }
  if (!stats.isFile()) {
    return {
      bindings: {},
      diagnostics: [`${filePath}: not a file; ${fallback}`],
      found: true,
    };
  }
  if (stats.size > TUI_KEYS_MAX_BYTES) {
    return {
      bindings: {},
      diagnostics: [
        `${filePath}: file is ${stats.size} bytes (max ${TUI_KEYS_MAX_BYTES}); ${fallback}`,
      ],
      found: true,
    };
  }
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (exc) {
    return {
      bindings: {},
      diagnostics: [`${filePath}: cannot read (${errorMessage(exc)}); ${fallback}`],
      found: true,
    };
  }
  if (Buffer.byteLength(text, "utf8") > TUI_KEYS_MAX_BYTES) {
    return {
      bindings: {},
      diagnostics: [`${filePath}: file exceeds ${TUI_KEYS_MAX_BYTES} bytes; ${fallback}`],
      found: true,
    };
  }
  const parsed = parseTuiKeysDocument(text, filePath);
  return { bindings: parsed.bindings, diagnostics: parsed.diagnostics, found: true };
}

/**
 * Validate raw bindings against the registry and produce the effective command
 * table. On any diagnostic the defaults are returned (atomically), so a bad
 * file can never leave a partially rebindable keyboard.
 */
export function resolveTuiCommands(bindings: TuiKeysBindings = {}): TuiCommandsResolution {
  const diagnostics: string[] = [];
  const knownIds = new Set(TUI_COMMANDS.map((command) => command.id));
  const entries = Object.entries(bindings);
  if (entries.length === 0) {
    return { commands: TUI_COMMANDS, diagnostics: [] };
  }

  const seen = new Map<string, { commandId: string; chord: KeyChord }>();
  const overridden = new Map<string, readonly KeyChord[]>();
  for (const [commandId, chords] of entries) {
    if (!knownIds.has(commandId)) {
      diagnostics.push(`"${commandId}": unknown TUI command id`);
      continue;
    }
    if (!REBINDABLE_SET.has(commandId)) {
      diagnostics.push(
        `"${commandId}": not a rebindable command (allowed: ${REBINDABLE_TUI_COMMAND_IDS.join(", ")})`,
      );
      continue;
    }
    if (!Array.isArray(chords) || chords.length === 0) {
      diagnostics.push(`"${commandId}": needs a non-empty array of chords`);
      continue;
    }
    if (chords.length > TUI_KEYS_MAX_CHORDS_PER_COMMAND) {
      diagnostics.push(
        `"${commandId}": ${chords.length} chords (max ${TUI_KEYS_MAX_CHORDS_PER_COMMAND})`,
      );
      continue;
    }
    const accepted: KeyChord[] = [];
    for (const chord of chords) {
      const problem = chordBindingProblem(chord, `"${commandId}"`);
      if (problem !== null) {
        diagnostics.push(problem);
        continue;
      }
      const identity = chordIdentity(chord);
      const previous = seen.get(identity);
      if (previous !== undefined) {
        diagnostics.push(
          previous.commandId === commandId
            ? `"${commandId}": duplicate chord ${formatChord(chord)}`
            : `"${commandId}": ${formatChord(chord)} is already used by "${previous.commandId}"`,
        );
        continue;
      }
      seen.set(identity, { commandId, chord });
      accepted.push(chord);
    }
    overridden.set(commandId, accepted);
  }

  // A rebinding must never shadow a fixed registry chord (the operator has no
  // way to discover that the fixed action lost its key).
  if (diagnostics.length === 0) {
    for (const command of TUI_COMMANDS) {
      if (overridden.has(command.id)) continue;
      for (const chord of command.keys ?? []) {
        const identity = chordIdentity(chord);
        const requested = seen.get(identity);
        if (requested !== undefined) {
          diagnostics.push(
            `"${requested.commandId}": ${formatChord(requested.chord)} is already bound to the fixed command "${command.id}"`,
          );
        }
      }
    }
  }

  if (diagnostics.length > 0) {
    return { commands: TUI_COMMANDS, diagnostics };
  }

  const commands: TuiCommand[] = TUI_COMMANDS.map((command) => {
    const replacement = overridden.get(command.id);
    return replacement === undefined ? command : { ...command, keys: replacement };
  });
  return { commands, diagnostics: [] };
}

/**
 * Resolve the effective commands from one configured path (or `null` for the
 * defaults). Read diagnostics and validation diagnostics are combined; the
 * caller prints them as one honest line and keeps using `commands`.
 */
export function resolveTuiCommandsFromFile(
  filePath: string | null,
  options: { explicit?: boolean } = {},
): TuiCommandsResolution {
  if (filePath === null) return { commands: TUI_COMMANDS, diagnostics: [] };
  const file = readTuiKeysFile(filePath, {
    missingIsDiagnostic: options.explicit === true,
  });
  if (file.diagnostics.length > 0) {
    return { commands: TUI_COMMANDS, diagnostics: file.diagnostics };
  }
  const resolved = resolveTuiCommands(file.bindings);
  if (resolved.diagnostics.length > 0) {
    // Prefix resolution diagnostics with the file they came from.
    return {
      commands: TUI_COMMANDS,
      diagnostics: resolved.diagnostics.map((line) => `${filePath}: ${line}`),
    };
  }
  return resolved;
}

// --------------------------------------------------------------------------- //
// live status + reload for the in-TUI `/keys` command
// --------------------------------------------------------------------------- //

/** Where the configured keys-file path came from. */
export type TuiKeysOrigin = "flag" | "env" | "default";

/** One captured keys-file location: resolved path + where it came from. */
export interface TuiKeysSource {
  path: string;
  origin: TuiKeysOrigin;
}

/** What one load attempt found (`loaded` / absent / unreadable-or-invalid). */
export type TuiKeysLoadState = "loaded" | "missing" | "invalid";

/** Result of loading or reloading one keys file. */
export interface TuiKeysLoadResult {
  /** The new table on a successful load; the caller's previous table otherwise. */
  commands: readonly TuiCommand[];
  /** Empty on success; honest lines on failure. */
  diagnostics: readonly string[];
  state: TuiKeysLoadState;
}

/** Status reported by `/keys show`. */
export interface TuiKeysStatus {
  /** Captured at startup; `null` when an embedding injected commands directly. */
  source: TuiKeysSource | null;
  state: TuiKeysLoadState | "none";
  diagnostics: readonly string[];
}

/** Bound for one displayed diagnostic line (the notice stays readable). */
export const TUI_KEYS_DIAGNOSTIC_MAX_CHARS = 240;

function sourceMissingIsDiagnostic(source: TuiKeysSource): boolean {
  return source.origin !== "default";
}

/**
 * Load the captured keys-file source once. Fail-soft like the startup resolver:
 * a missing default file is silent, an absent explicit path is diagnosed, and
 * an unreadable/invalid file reports diagnostics. `state` separates a real load
 * from absence/failure so `/keys` can report the truth.
 */
export function loadTuiKeyCommands(
  source: TuiKeysSource,
  options: { fallbackMessage?: string } = {},
): TuiKeysLoadResult {
  const file = readTuiKeysFile(source.path, {
    missingIsDiagnostic: sourceMissingIsDiagnostic(source),
    ...(options.fallbackMessage !== undefined ? { fallbackMessage: options.fallbackMessage } : {}),
  });
  if (file.diagnostics.length > 0) {
    return {
      commands: TUI_COMMANDS,
      diagnostics: file.diagnostics,
      state: file.found ? "invalid" : "missing",
    };
  }
  if (!file.found) {
    return { commands: TUI_COMMANDS, diagnostics: [], state: "missing" };
  }
  const resolved = resolveTuiCommands(file.bindings);
  if (resolved.diagnostics.length > 0) {
    return {
      commands: TUI_COMMANDS,
      diagnostics: resolved.diagnostics.map((line) => `${source.path}: ${line}`),
      state: "invalid",
    };
  }
  return { commands: resolved.commands, diagnostics: [], state: "loaded" };
}

/**
 * Reload the captured source for `/keys reload`.
 *
 * Rule: **keep the last good command table on every non-loaded outcome.** A
 * broken, unreadable or absent file never silently replaces a previously
 * loaded valid table with the defaults; only a successful load swaps the table.
 * Absence keeps the previous chords and is reported without a diagnostic when
 * the source is the optional default path.
 */
export function reloadTuiCommands(
  source: TuiKeysSource,
  previous: readonly TuiCommand[],
  options: { fallbackMessage?: string } = {},
): TuiKeysLoadResult {
  const loaded = loadTuiKeyCommands(source, {
    fallbackMessage: options.fallbackMessage ?? "the previous chords were kept",
  });
  if (loaded.state === "loaded") return loaded;
  return { commands: previous, diagnostics: loaded.diagnostics, state: loaded.state };
}

/** The three effective global chords as `palette Ctrl+P · help ? / F1 · stash Ctrl+O`. */
export function globalKeySummary(commands: readonly TuiCommand[]): string {
  const parts: string[] = [];
  for (const id of REBINDABLE_TUI_COMMAND_IDS) {
    const command = commands.find((candidate) => candidate.id === id);
    const keys = command === undefined ? "" : formatKeys(command);
    parts.push(`${id} ${keys === "" ? "(unbound)" : keys}`);
  }
  return parts.join(" · ");
}

function hasGlobalOverrides(commands: readonly TuiCommand[]): boolean {
  return REBINDABLE_TUI_COMMAND_IDS.some((id) => {
    const current = commands.find((candidate) => candidate.id === id);
    const fallback = TUI_COMMANDS.find((candidate) => candidate.id === id);
    return formatKeys({ keys: current?.keys }) !== formatKeys({ keys: fallback?.keys });
  });
}

function boundedDiagnostic(diagnostics: readonly string[]): string {
  const joined = diagnostics.join("; ");
  return joined.length > TUI_KEYS_DIAGNOSTIC_MAX_CHARS
    ? `${joined.slice(0, TUI_KEYS_DIAGNOSTIC_MAX_CHARS - 1)}…`
    : joined;
}

/** Bound a composed `/keys` notice line. */
export function boundTuiKeysNotice(text: string): string {
  const max = TUI_KEYS_DIAGNOSTIC_MAX_CHARS + 80;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * The `/keys show` lines: the three effective global chords, the captured
 * source (resolved path, origin, last load state) and the last diagnostics.
 * The source line never claims overrides are active when the defaults are in
 * force, and distinguishes "loaded" from absence/failure.
 */
export function describeTuiKeys(
  commands: readonly TuiCommand[],
  status: TuiKeysStatus,
): string[] {
  const lines = [`keys: ${globalKeySummary(commands)}`];
  const overrides = hasGlobalOverrides(commands);
  if (status.source === null) {
    lines.push("keys file: none (no keys-file source captured for this TUI session)");
  } else {
    const stateText =
      status.state === "loaded"
        ? overrides
          ? "loaded"
          : "loaded; defaults active (no overrides)"
        : status.state === "missing"
          ? overrides
            ? "absent; previous chords kept"
            : "absent; defaults active"
          : overrides
            ? "invalid; previous chords kept"
            : "invalid; defaults active";
    lines.push(boundTuiKeysNotice(`keys file: ${status.source.path} (${status.source.origin}) — ${stateText}`));
  }
  if (status.diagnostics.length > 0) {
    lines.push(`keys diagnostics: ${boundedDiagnostic(status.diagnostics)}`);
  }
  return lines;
}
