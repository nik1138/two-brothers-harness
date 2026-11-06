/**
 * Composer mentions: `@skill:<name>` and `@<path>` tokens, plus the bounded
 * injection blocks the run path appends to the task.
 *
 * The grammar is deliberately conservative so ordinary prose stays prose:
 * a mention must start at index 0 or right after ASCII whitespace, skill names
 * are `[a-z0-9][a-z0-9_-]*`, and a file token must be a whitespace-free run
 * containing a `/` or `\` (so `@media`, emails and `@handles` are never
 * mentions). Trailing sentence punctuation is trimmed off a file token so
 * `@src/a.ts,` attaches `src/a.ts`.
 *
 * `parseMentions` returns every deduped token; the count caps
 * (`MENTION_MAX_SKILLS`, `MENTION_MAX_FILES`) and the total-size cap are
 * enforced by the caller when it resolves and attaches content. The renderers
 * produce the exact blocks the model sees (`<skill-loaded>` matches
 * `harness.ts::renderSkillLoaded`, `<file>` is the composer's file convention)
 * and bound the payloads they are given. Everything here is pure, bounded and
 * never throws on hostile input.
 */

/** Prefix of a skill mention token. */
export const MENTION_SKILL_PREFIX = "@skill:";
/** Composer cap on attached skills per task. */
export const MENTION_MAX_SKILLS = 3;
/** Composer cap on attached files per task. */
export const MENTION_MAX_FILES = 5;
/** Per-file attached-content cap (matches `workspace.ts::DEFAULT_MAX_CHARS`). */
export const MENTION_MAX_FILE_CHARS = 20_000;
/** Per-skill attached-body cap. */
export const MENTION_MAX_SKILL_CHARS = 60_000;
/** Cap on all attached mention content in one task. */
export const MENTION_MAX_TOTAL_CHARS = 100_000;

/** One parsed mention with its offsets in the original text (`end` exclusive). */
export interface MentionToken {
  kind: "skill" | "file";
  value: string;
  start: number;
  end: number;
}

/** Everything `parseMentions` found, deduped and in first-occurrence order. */
export interface ParsedMentions {
  skills: string[];
  files: string[];
  tokens: MentionToken[];
}

/** ASCII whitespace — the only boundary a mention may start after. */
const ASCII_WHITESPACE = new Set([" ", "\t", "\n", "\r", "\f", "\v"]);

/** Sentence punctuation trimmed from the end of a file token. */
const FILE_TRAILING_PUNCTUATION = new Set([
  ".",
  ",",
  ";",
  ":",
  "!",
  "?",
  ")",
  "]",
  "}",
  '"',
  "'",
]);

/** Coerce an unknown input to the empty string (hostile-input safety). */
function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isAsciiWhitespace(ch: string): boolean {
  return ASCII_WHITESPACE.has(ch);
}

function isLowerAlphaOrDigit(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9");
}

/** Read the skill name starting at `start`, or `""` when it is not valid. */
function readSkillName(source: string, start: number): string {
  let end = start;
  while (end < source.length) {
    const ch = source[end];
    if (!isLowerAlphaOrDigit(ch) && ch !== "_" && ch !== "-") break;
    end += 1;
  }
  const name = source.slice(start, end);
  if (name === "" || !isLowerAlphaOrDigit(name[0])) return "";
  return name;
}

/**
 * Scan a task text for `@skill:<name>` and `@<path>` mentions.
 *
 * Tokens are deduped by value (first occurrence wins, order preserved) and
 * carry resolved `start`/`end` offsets into the original text. Count caps are
 * not applied here — the composer/run path enforces them.
 */
export function scanMentions(text: string): MentionToken[] {
  const source = asString(text);
  const tokens: MentionToken[] = [];
  const seen = new Set<string>();
  const push = (kind: "skill" | "file", value: string, start: number, end: number): void => {
    // Dedupe by value: the same skill/file mentioned twice attaches once.
    if (seen.has(value)) return;
    seen.add(value);
    tokens.push({ kind, value, start, end });
  };

  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== "@") continue;
    if (index > 0 && !isAsciiWhitespace(source[index - 1])) continue;

    if (source.startsWith(MENTION_SKILL_PREFIX, index)) {
      const nameStart = index + MENTION_SKILL_PREFIX.length;
      const name = readSkillName(source, nameStart);
      if (name !== "") {
        const end = nameStart + name.length;
        push("skill", name, index, end);
        index = end - 1;
        continue;
      }
    }

    let runEnd = index + 1;
    while (runEnd < source.length && !/\s/.test(source[runEnd])) runEnd += 1;
    let end = runEnd;
    while (end > index + 1 && FILE_TRAILING_PUNCTUATION.has(source[end - 1])) end -= 1;
    const value = source.slice(index + 1, end);
    if (value !== "" && (value.includes("/") || value.includes("\\"))) {
      push("file", value, index, end);
    }
    index = runEnd - 1;
  }
  return tokens;
}

/**
 * Parse a task text into deduped skill and file mention values plus the full
 * token list. Callers enforce `MENTION_MAX_SKILLS` / `MENTION_MAX_FILES`.
 */
export function parseMentions(text: string): ParsedMentions {
  const tokens = scanMentions(text);
  const skills: string[] = [];
  const files: string[] = [];
  for (const token of tokens) {
    if (token.kind === "skill") skills.push(token.value);
    else files.push(token.value);
  }
  return { skills, files, tokens };
}

/**
 * Normalise a mention path for display and attachment: trim, strip a matching
 * pair of surrounding quotes, convert `\` to `/`, collapse repeated slashes and
 * drop a leading `./`. Deliberately does not resolve `..` or make the path
 * absolute — that is the caller's sandbox decision. Returns `""` when nothing
 * usable remains.
 */
export function normalizeMentionPath(raw: string): string {
  let value = asString(raw).trim();
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' || first === "'") && last === first) value = value.slice(1, -1).trim();
  }
  value = value.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  while (value.startsWith("./")) value = value.slice(2);
  return value;
}

/**
 * The canonical `@<path>` token for a workspace-relative path.
 *
 * The scanner only treats a slash/backslash-containing run as a file mention,
 * so a root-level file must be emitted path-like: `README.md` becomes
 * `@./README.md` while `src/a.ts` stays `@src/a.ts`. Normalising is idempotent
 * (`fileMentionToken("./x") === fileMentionToken("x") === "@./x"`). An empty
 * path yields the degenerate `"@"` (not a mention).
 */
export function fileMentionToken(relPath: string): string {
  const normalized = normalizeMentionPath(relPath);
  if (normalized === "") return "@";
  return `@${normalized.includes("/") ? normalized : `./${normalized}`}`;
}

/** The canonical `@skill:<name>` token for a skill name. */
export function skillMentionToken(name: string): string {
  return MENTION_SKILL_PREFIX + asString(name);
}

/** Marker appended to a clipped skill body inside a `<skill-loaded>` block. */
const SKILL_TRUNCATION_MARKER = "\n… [skill truncated]";
/** Marker line appended inside a `<file>` block when the caller truncated it. */
const FILE_TRUNCATION_MARKER = "\n… [file truncated]";

/**
 * Render one attached skill body as a `<skill-loaded>` block — the exact
 * convention `harness.ts::renderSkillLoaded` uses. The body is bounded to
 * `MENTION_MAX_SKILL_CHARS` characters including the `… [skill truncated]`
 * marker when clipped; the closing tag always follows on its own newline.
 */
export function renderSkillLoadedBlock(name: string, body: string): string {
  // Skill names are validated `[a-z0-9][a-z0-9_-]*` upstream; sanitise anyway
  // so a hostile name cannot terminate the opening tag or inject a newline.
  const safeName = asString(name)
    .replace(/"/g, "'")
    .replace(/[\r\n]+/g, " ");
  let content = asString(body);
  if (content.length > MENTION_MAX_SKILL_CHARS) {
    const head = Math.max(0, MENTION_MAX_SKILL_CHARS - SKILL_TRUNCATION_MARKER.length);
    content = content.slice(0, head) + SKILL_TRUNCATION_MARKER;
  }
  return `<skill-loaded name="${safeName}">\n${content}\n</skill-loaded>`;
}

/**
 * Render one attached file as a `<file>` block: `<file path="rel/path">` then
 * the content verbatim, then `</file>`. The path is normalised and made safe
 * for the opening tag (`"` → `'`, newlines collapsed); with
 * `options.truncated` a final `… [file truncated]` line is appended inside the
 * block. Content is not clipped here — the caller reads it with a
 * `MENTION_MAX_FILE_CHARS` cap and passes `truncated` accordingly.
 */
export function renderFileBlock(
  relPath: string,
  content: string,
  options: { truncated?: boolean } = {},
): string {
  const safePath = normalizeMentionPath(relPath)
    .replace(/"/g, "'")
    .replace(/[\r\n]+/g, " ");
  const body = asString(content);
  const marker = options?.truncated === true ? FILE_TRUNCATION_MARKER : "";
  return `<file path="${safePath}">\n${body}${marker}\n</file>`;
}
