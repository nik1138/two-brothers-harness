/**
 * Advisory repeat-tool-call guard: counts consecutive identical tool calls
 * (same tool name + canonically identical arguments) and returns a gentle
 * model-facing reminder at configured thresholds. It never blocks or rewrites
 * a call.
 *
 * Ported from deepseek-harness's `packages/guard/repeat-tool-reminder`
 * (MIT, Copyright (c) 2026 DeepSeek): the consecutive-chain semantics,
 * threshold escalation, `*`-wildcard tool scoping, deep key-sort
 * canonicalization and reminder shape follow the reference. This is a
 * standalone, dependency-free reimplementation for the local tool loop (one
 * guard instance per loop; no Cordis plugin/listener layer).
 * @module repeatguard
 */

/** Default consecutive-repeat counts that trigger a reminder. */
export const REPEAT_GUARD_DEFAULT_THRESHOLDS: readonly number[] = Object.freeze([3, 5, 8]);

/** Default cap on the canonical-arguments text quoted in a detailed reminder. */
export const REPEAT_GUARD_DEFAULT_ARGUMENTS_PREVIEW_CHARS = 500;

/** Environment escape hatch read by the CLI `run` / `chat` / `tui` / `serve` paths. */
export const REPEAT_GUARD_ENV = "TWO_BROTHERS_REPEAT_GUARD";

/** Options for one {@link RepeatToolGuard} instance. */
export interface RepeatToolGuardOptions {
  /** Consecutive-repeat counts that trigger a reminder (default `[3, 5, 8]`). */
  thresholds?: readonly number[];
  /** Tool-name patterns to track; empty means every tool is tracked. */
  include?: readonly string[];
  /** Tool-name patterns transparent to the chain (neither count nor reset). */
  exclude?: readonly string[];
  /**
   * Maximum characters of canonical arguments quoted in the DETAILED
   * reminder (default 500). The detection key always uses the full canonical
   * string; only the model-visible preview is capped.
   */
  argumentsPreviewChars?: number;
}

/** One observation: the current consecutive count and any reminder to deliver. */
export interface RepeatToolObservation {
  /**
   * Consecutive count for this call's `(tool, canonical arguments)` chain.
   * `0` means the tool is untracked (the chain was neither advanced nor reset).
   */
  count: number;
  /** Present only when `count` hits one of the configured thresholds. */
  reminder?: string;
}

/** Deep key-sort of a JSON value so property order never changes identity. */
function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) sorted[key] = sortJsonValue(record[key]);
    return sorted;
  }
  return value;
}

/**
 * Canonical identity for one call's arguments: deep key-sort, then
 * `JSON.stringify`. Tool arguments arrive as parsed JSON (or the raw-string
 * fallback), so JSON's value domain is the whole input domain; bigint, cycle
 * and `undefined` handling is deliberately absent.
 */
export function canonicalToolArguments(args: unknown): string {
  return JSON.stringify(sortJsonValue(args));
}

/**
 * Compile one `*`-wildcard pattern to an anchored RegExp; every other regex
 * metacharacter matches literally.
 */
export function wildcardToolPattern(pattern: string): RegExp {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, String.raw`\$&`);
  return new RegExp(`^${escaped.replaceAll("*", ".*")}$`);
}

/**
 * Validate `thresholds` per the fail-loud contract and return them sorted
 * ascending (the gentle tier is always `thresholds[0]`).
 */
export function validateRepeatThresholds(values: readonly number[]): number[] {
  if (values.length === 0) {
    throw new Error("repeat guard: `thresholds` must not be empty");
  }
  for (const value of values) {
    if (!Number.isInteger(value) || value < 2) {
      throw new Error(
        `repeat guard: invalid threshold ${value} - every threshold must be an integer >= 2`,
      );
    }
  }
  if (new Set(values).size !== values.length) {
    throw new Error("repeat guard: `thresholds` must not contain duplicates");
  }
  return [...values].sort((a, b) => a - b);
}

/** The gentle first-threshold reminder. */
const GENTLE_REMINDER =
  "You are repeating the exact same tool call with identical arguments. " +
  "Carefully analyze the previous result before calling again: if the task is " +
  "not complete, try a different approach or different arguments instead of " +
  "repeating the call.";

/**
 * Render any string as printable ASCII: characters outside the printable
 * range become `\uXXXX` escapes (non-BMP code points keep both surrogate
 * escapes). Keeps a reminder's layout stable when an argument value carries
 * Unicode or control characters.
 */
function asciiText(value: string): string {
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= 0x20 && code <= 0x7e) {
      out += char;
    } else if (code <= 0xffff) {
      out += `\\u${code.toString(16).padStart(4, "0")}`;
    } else {
      for (let i = 0; i < char.length; i += 1) {
        out += `\\u${char.charCodeAt(i).toString(16).padStart(4, "0")}`;
      }
    }
  }
  return out;
}

/** Head-truncate an ASCII string and mark exactly how much was omitted. */
function clipAscii(value: string, cap: number): string {
  return value.length <= cap ? value : `${value.slice(0, cap)}... (+${value.length - cap} more chars)`;
}

/** Bound a tool name quoted in a detailed reminder. */
function toolNameText(toolName: string): string {
  return clipAscii(asciiText(toolName), 120);
}

/** The detailed later-threshold reminder naming the tool, run length and arguments. */
function detailedReminder(toolName: string, count: number, preview: string): string {
  return (
    "Repeated tool call detected:\n" +
    `- tool: ${toolNameText(toolName)}\n` +
    `- consecutive_calls: ${count}\n` +
    `- arguments: ${preview}\n` +
    "The repeated calls are not making progress. Do not call this tool with " +
    "these exact arguments again. Inspect the latest result and choose a " +
    "different action, different arguments, or finish the task if enough " +
    "evidence has been gathered."
  );
}

/**
 * One consecutive-repeat chain. A new tracked `(tool, canonical arguments)`
 * pair starts a count of 1; an identical tracked pair increments it; untracked
 * tools are transparent. `reset()` clears the chain (a new user message).
 */
export class RepeatToolGuard {
  private readonly thresholds: number[];
  private readonly thresholdSet: Set<number>;
  private readonly includePatterns: RegExp[];
  private readonly excludePatterns: RegExp[];
  private readonly argumentsPreviewChars: number;
  private chain: { key: string; count: number } | null = null;

  constructor(options: RepeatToolGuardOptions = {}) {
    this.thresholds = validateRepeatThresholds(
      options.thresholds ?? REPEAT_GUARD_DEFAULT_THRESHOLDS,
    );
    this.thresholdSet = new Set(this.thresholds);
    this.includePatterns = (options.include ?? []).map(wildcardToolPattern);
    this.excludePatterns = (options.exclude ?? []).map(wildcardToolPattern);
    const previewChars =
      options.argumentsPreviewChars ?? REPEAT_GUARD_DEFAULT_ARGUMENTS_PREVIEW_CHARS;
    if (!Number.isInteger(previewChars) || previewChars < 1) {
      throw new Error(
        `repeat guard: invalid argumentsPreviewChars ${previewChars} - must be an integer >= 1`,
      );
    }
    this.argumentsPreviewChars = previewChars;
  }

  /** Whether a tool participates in the chain (untracked calls are transparent). */
  private tracked(toolName: string): boolean {
    if (
      this.includePatterns.length > 0 &&
      !this.includePatterns.some((pattern) => pattern.test(toolName))
    ) {
      return false;
    }
    return !this.excludePatterns.some((pattern) => pattern.test(toolName));
  }

  /**
   * Advance the chain for one attempted call and return the observation.
   * A configured threshold yields a reminder; every call is otherwise counted
   * silently. Untracked tools return `{count: 0}` and leave the chain intact.
   */
  observe(toolName: string, args: unknown): RepeatToolObservation {
    if (!this.tracked(toolName)) return { count: 0 };
    const canonical = canonicalToolArguments(args);
    const key = JSON.stringify([toolName, canonical]);
    const count = this.chain !== null && this.chain.key === key ? this.chain.count + 1 : 1;
    this.chain = { key, count };
    if (!this.thresholdSet.has(count)) return { count };
    const reminder =
      count === this.thresholds[0]
        ? GENTLE_REMINDER
        : detailedReminder(
            toolName,
            count,
            clipAscii(asciiText(canonical), this.argumentsPreviewChars),
          );
    return { count, reminder };
  }

  /** Clear the chain: a new user message or node is not a repeat of the old one. */
  reset(): void {
    this.chain = null;
  }
}

/**
 * The `TWO_BROTHERS_REPEAT_GUARD` escape hatch: `off` / `0` / `false` / `no`
 * disables the guard (`repeatToolGuard: false`); unset or any other value
 * keeps the default-enabled guard. Read by the CLI `run` / `chat` / `tui` and
 * `serve` harness-construction paths; options are never persisted.
 */
export function repeatToolGuardFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): RepeatToolGuardOptions | false | undefined {
  const raw = (env[REPEAT_GUARD_ENV] ?? "").trim().toLowerCase();
  if (raw === "off" || raw === "0" || raw === "false" || raw === "no") return false;
  return undefined;
}
