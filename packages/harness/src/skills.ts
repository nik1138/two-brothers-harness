/**
 * Skills: markdown capabilities with role scope (`shared` / `senior` / `junior`).
 *
 * A skill is a `SKILL.md` inside a skill directory, or a loose `.md` file in a
 * skills root. Discovery is fail-soft — a malformed file never throws, it lands
 * in `SkillCatalog.diagnostics` and is skipped (or kept with a fallback). This
 * follows the tolerant-boundary rule from AGENTS.md and the conventions of
 * `plugins.ts` (sync fs, missing directories are not errors).
 *
 * Design notes, and where this stands relative to the research:
 * - Prompt advertisement is pi-style (`core/skills.ts`
 *   `formatSkillsForPrompt`): a flat `## Available skills` list, one
 *   `- name: description` line per skill, nothing else. The body stays out of
 *   the prompt until the caller injects it.
 * - Bodies are read **eagerly** here. pi reads lazily on invocation because a
 *   large skill library would otherwise pay for every file on every start; our
 *   skill trees are small and local reads are cheap, so eager loading keeps
 *   `SkillCatalog` self-contained and `renderSkillBody` pure. If a big shared
 *   library ever ships, switch `body` to a lazy getter without changing the API.
 * - Role scoping is the two-brothers addition: each brother is advertised the
 *   `shared` skills plus its own, so a senior-only checklist never leaks into
 *   the junior's prompt.
 * - Frontmatter is hand-rolled, zero-dependency: a `---` fence and simple
 *   `key: value` scalar lines only. Nested YAML is deliberately unsupported —
 *   such lines are skipped with a diagnostic. A real YAML parser would need a
 *   dependency-ledger entry (research/harnesses/plugins-opencode.md).
 * - Skills are **advisory**: `tools` is stored as an allow-hint and never
 *   enforced here. Authorization stays with the tool scopes in `harness.ts`.
 *
 * Roots are supplied by the caller (e.g. `<cwd>/skills/` then
 * `~/.two-brothers/skills/`); this module performs no root resolution of its
 * own. Earlier roots win a name collision, mirroring kimi-code's source
 * priority; shadowed skills are reported in `diagnostics`.
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** Where a skill applies: both brothers, or exactly one of them. */
export type SkillScope = "shared" | "senior" | "junior";

/** The roles a skills section can be rendered for. */
export type SkillRole = Exclude<SkillScope, "shared">;

/** One discovered skill. */
export interface Skill {
  /** Lowercase `[a-z0-9_-]+`; frontmatter `name`, else the directory/file name. */
  name: string;
  /** Frontmatter `description`; `""` when missing (a diagnostic is recorded). */
  description: string;
  scope: SkillScope;
  /**
   * Optional comma-separated `tools:` hint from frontmatter, split and
   * trimmed. Advisory only — never enforced by the harness.
   */
  tools: string[];
  /** Absolute path of the `SKILL.md` (or loose `.md`) file. */
  file: string;
  /** Markdown after the frontmatter block (eagerly read — see module header). */
  body: string;
}

/** Result of discovery: usable skills plus human-readable problems. */
export interface SkillCatalog {
  /** Sorted by `name` — deterministic for prompt bytes and tests. */
  skills: Skill[];
  /** Skips, duplicate-name shadows and parse problems; never thrown. */
  diagnostics: string[];
}

/** Parsed result of `validateSkillFrontmatter`. */
export interface SkillFrontmatter {
  /** Scalar `key: value` pairs, keys lowercased, values unquoted. */
  fields: Record<string, string>;
  /** Unsupported lines and an unterminated block, if any. */
  diagnostics: string[];
}

/** Parsed document (frontmatter + body) used by discovery. */
interface ParsedSkillDocument extends SkillFrontmatter {
  body: string;
}

const FENCE = "---";
const NAME_RE = /^[a-z0-9_-]+$/;
const SCOPES: ReadonlySet<string> = new Set(["shared", "senior", "junior"]);
/** Nested organisation directories are supported, but not unbounded walks. */
const MAX_SCAN_DEPTH = 4;
const SKILL_FILE = "SKILL.md";
const EXCLUDED_DIRS: ReadonlySet<string> = new Set(["node_modules"]);

/** Stable, locale-independent ordering. */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function messageOf(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

function isExcludedEntry(name: string): boolean {
  return name.startsWith(".") || EXCLUDED_DIRS.has(name);
}

/**
 * Parse a skill file's frontmatter and body. Never throws: anything the
 * hand-rolled parser cannot understand becomes a diagnostic.
 *
 * Supported: a leading `---` line, simple `key: value` scalar lines, an
 * optional trailing `# comment`, single- or double-quoted values, a closing
 * `---` fence. Not supported (diagnosed and skipped): indented lines, `-`
 * list items, flow/block collections (`[...]`, `{...}`, `|`, `>`).
 */
function parseSkillDocument(raw: string): ParsedSkillDocument {
  const text = raw.startsWith("\uFEFF") ? raw.slice(1) : raw;
  const lines = text.split(/\r?\n/);
  const diagnostics: string[] = [];
  const fields: Record<string, string> = {};

  if (lines.length === 0 || lines[0].trim() !== FENCE) {
    diagnostics.push("missing frontmatter block");
    return { fields, diagnostics, body: text.replace(/^\n+/, "").trimEnd() };
  }

  let close = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === FENCE) {
      close = i;
      break;
    }
  }
  if (close === -1) diagnostics.push("unterminated frontmatter block");

  const frontmatter = close === -1 ? lines.slice(1) : lines.slice(1, close);
  for (const line of frontmatter) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    // Indented lines are YAML nesting; `-` lines are YAML sequences.
    if (line !== line.trimStart() || trimmed.startsWith("-")) {
      diagnostics.push(`unsupported frontmatter line skipped: ${trimmed}`);
      continue;
    }
    const colon = trimmed.indexOf(":");
    if (colon <= 0) {
      diagnostics.push(`unsupported frontmatter line skipped: ${trimmed}`);
      continue;
    }
    const key = trimmed.slice(0, colon).trim().toLowerCase();
    const rawValue = trimmed.slice(colon + 1).trim();
    if (key === "") {
      diagnostics.push(`unsupported frontmatter line skipped: ${trimmed}`);
      continue;
    }
    if (/^[|>\[\{]/.test(rawValue)) {
      diagnostics.push(`unsupported frontmatter line skipped: ${trimmed}`);
      continue;
    }
    fields[key] = unquoteValue(rawValue);
  }

  const body = (close === -1 ? [] : lines.slice(close + 1))
    .join("\n")
    .replace(/^\n+/, "")
    .trimEnd();
  return { fields, diagnostics, body };
}

/** Strip matching quotes (ignoring trailing text) or a trailing comment. */
function unquoteValue(raw: string): string {
  if (raw.startsWith('"') || raw.startsWith("'")) {
    const quote = raw[0];
    const end = raw.indexOf(quote, 1);
    return end === -1 ? raw.slice(1) : raw.slice(1, end);
  }
  const comment = raw.search(/\s#/);
  return (comment === -1 ? raw : raw.slice(0, comment)).trim();
}

/**
 * Parse and validate a raw skill file's frontmatter. Exported for tests and
 * for callers that read a file themselves; field-level validation (name,
 * scope) happens in `discoverSkills`, where the file/directory fallback name
 * is known.
 */
export function validateSkillFrontmatter(raw: string): SkillFrontmatter {
  const parsed = parseSkillDocument(raw);
  return { fields: parsed.fields, diagnostics: parsed.diagnostics };
}

/** True when `target` is an existing regular file. */
function isFile(target: string): boolean {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

/** Directory/file kind of a dirent, following symlinks when needed. */
function entryKind(entry: fs.Dirent, fullPath: string): "dir" | "file" | null {
  if (entry.isDirectory()) return "dir";
  if (entry.isFile()) return "file";
  try {
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) return "dir";
    if (stat.isFile()) return "file";
  } catch {
    return null;
  }
  return null;
}

interface DiscoveryState {
  byName: Map<string, Skill>;
  diagnostics: string[];
}

/**
 * Load one skill file into the catalog. Every failure path records a
 * diagnostic instead of throwing.
 */
function loadSkillFile(file: string, fallbackName: string, state: DiscoveryState): void {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (exc) {
    state.diagnostics.push(`${file}: cannot read skill file: ${messageOf(exc)}`);
    return;
  }

  const parsed = parseSkillDocument(raw);
  for (const diagnostic of parsed.diagnostics) state.diagnostics.push(`${file}: ${diagnostic}`);

  const explicitName = parsed.fields.name ?? "";
  const name = explicitName !== "" ? explicitName : fallbackName.toLowerCase();
  if (!NAME_RE.test(name)) {
    state.diagnostics.push(`${file}: invalid skill name "${name}"; skill skipped`);
    return;
  }

  const description = parsed.fields.description ?? "";
  if (description === "") {
    state.diagnostics.push(`${file}: missing description in frontmatter`);
  }

  let scope = (parsed.fields.scope ?? "").trim().toLowerCase();
  if (scope === "") {
    scope = "shared";
  } else if (!SCOPES.has(scope)) {
    state.diagnostics.push(
      `${file}: invalid scope "${parsed.fields.scope}"; defaulting to shared`,
    );
    scope = "shared";
  }

  const tools = (parsed.fields.tools ?? "")
    .split(",")
    .map((tool) => tool.trim())
    .filter((tool) => tool !== "");

  const skill: Skill = {
    name,
    description,
    scope: scope as SkillScope,
    tools,
    file: path.resolve(file),
    body: parsed.body,
  };

  const winner = state.byName.get(name);
  if (winner !== undefined) {
    state.diagnostics.push(
      `${skill.file}: duplicate skill name "${name}"; shadowed by ${winner.file}`,
    );
    return;
  }
  state.byName.set(name, skill);
}

/**
 * Scan one skills root. Entries are visited in sorted order: directory-form
 * skills first (a directory with `SKILL.md` is not recursed into), then loose
 * `.md` files (a `foo.md` is skipped when a `foo/` skill directory exists),
 * then remaining subdirectories up to `MAX_SCAN_DEPTH`.
 */
function scanDirectory(dir: string, depth: number, state: DiscoveryState): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (exc) {
    state.diagnostics.push(`${dir}: cannot read skills directory: ${messageOf(exc)}`);
    return;
  }
  entries.sort((a, b) => compareStrings(a.name, b.name));

  const skillDirNames = new Set<string>();
  const nestedDirs: string[] = [];
  for (const entry of entries) {
    if (isExcludedEntry(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    const kind = entryKind(entry, fullPath);
    if (kind !== "dir") continue;
    const skillFile = path.join(fullPath, SKILL_FILE);
    if (isFile(skillFile)) {
      skillDirNames.add(entry.name);
      loadSkillFile(skillFile, entry.name, state);
    } else {
      nestedDirs.push(fullPath);
    }
  }

  for (const entry of entries) {
    if (isExcludedEntry(entry.name)) continue;
    if (!entry.name.endsWith(".md") || entry.name === SKILL_FILE) continue;
    const stem = entry.name.slice(0, -3);
    if (skillDirNames.has(stem)) continue; // directory form wins
    const fullPath = path.join(dir, entry.name);
    if (entryKind(entry, fullPath) !== "file") continue;
    loadSkillFile(fullPath, stem, state);
  }

  if (depth >= MAX_SCAN_DEPTH) return;
  for (const nested of nestedDirs) scanDirectory(nested, depth + 1, state);
}

/**
 * Discover skills under every root, in priority order. Roots may be relative;
 * duplicates (by resolved path) are collapsed, a missing root is not an error,
 * and a root that exists but is not a directory is reported. Duplicate skill
 * names resolve to the first discovered skill; later ones are shadowed with a
 * diagnostic. The returned list is sorted by name.
 */
export function discoverSkills(roots: string[]): SkillCatalog {
  const byName = new Map<string, Skill>();
  const diagnostics: string[] = [];
  const state: DiscoveryState = { byName, diagnostics };
  const seenRoots = new Set<string>();

  for (const root of roots) {
    const rootPath = path.resolve(root);
    const dedupeKey = process.platform === "win32" ? rootPath.toLowerCase() : rootPath;
    if (seenRoots.has(dedupeKey)) continue;
    seenRoots.add(dedupeKey);

    let stat: fs.Stats;
    try {
      stat = fs.statSync(rootPath);
    } catch (exc) {
      const code = (exc as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        diagnostics.push(`${rootPath}: cannot read skills root: ${messageOf(exc)}`);
      }
      continue;
    }
    if (!stat.isDirectory()) {
      diagnostics.push(`${rootPath}: skills root is not a directory`);
      continue;
    }
    scanDirectory(rootPath, 0, state);
  }

  const skills = [...byName.values()].sort((a, b) => compareStrings(a.name, b.name));
  return { skills, diagnostics };
}

/**
 * The pi-style `## Available skills` section for one role, or `null` when the
 * role has no skills (the caller then omits the section entirely). Visible
 * skills are the `shared` scope plus the role's own scope, in catalog order.
 */
export function renderSkillsSection(catalog: SkillCatalog, role: SkillRole): string | null {
  const visible = catalog.skills.filter(
    (skill) => skill.scope === "shared" || skill.scope === role,
  );
  if (visible.length === 0) return null;
  return [
    "## Available skills",
    "",
    ...visible.map((skill) => `- ${skill.name}: ${skill.description}`),
  ].join("\n");
}

/**
 * One skill as an injectable block (kimi-code's `<skill-loaded>` convention,
 * reduced to the `<skill>` envelope): the model is told this body is the
 * skill's instructions, not conversation.
 */
export function renderSkillBody(skill: Skill): string {
  return `<skill name="${skill.name}">\n${skill.body}\n</skill>`;
}