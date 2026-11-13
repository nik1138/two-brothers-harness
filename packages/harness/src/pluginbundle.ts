/**
 * Declarative plugin bundles: data-only plugins declared by a
 * `plugins/<name>/plugin.json` manifest.
 *
 * A bundle is the no-code counterpart of the ES-module plugins in
 * `plugins.ts`: instead of a `register(ctx)` function executed in-process, the
 * operator drops a directory whose `plugin.json` declares **what** the bundle
 * offers — a slash-command directory and/or a skills root — and the existing
 * discovery engines (`commands.ts`, `skills.ts`) do the work. Loading a bundle
 * never imports or evaluates anything inside its directory: the manifest is
 * parsed with `JSON.parse` and every referenced path is resolved and
 * realpath-confined to the bundle directory, so a bundle cannot execute code,
 * escape its directory through symlinks, or reach runtime plugin surfaces
 * (tools, hooks, MCP servers, per-plugin options — those fields are reported
 * as info diagnostics and ignored).
 *
 * Contract:
 * - `plugin.json` must be a JSON object of at most 64 KiB
 *   (`BUNDLE_MANIFEST_MAX_BYTES`); a larger manifest fails the bundle.
 * - `name` (required) must match `^[a-z0-9_-]+$` and equal the bundle
 *   directory name. `description` and `version` are optional strings
 *   (informational; `version` is reported by the API verbatim).
 * - `commands` / `skills` (optional) are bundle-relative directory paths that
 *   MUST start with `./`. They are resolved against the bundle directory and
 *   realpath-confined: an absolute path, a `../` traversal or a symlink that
 *   resolves outside the bundle fails the bundle. A path that does not exist
 *   (or is not a directory) is an info diagnostic and the field is ignored.
 * - Fields from the code-plugin runtime (`tools`, `hooks`, `mcpServers`,
 *   `mcp_servers`, `options`, `register`, `configSchema`) produce an info
 *   diagnostic each and are ignored — bundles never execute code. Unknown
 *   fields are ignored silently (forward compatibility).
 *
 * Contributions ride the existing engines unchanged:
 * - Commands are discovered from the bundle's `commands` directory and
 *   namespaced `<bundle>:<command>`, so a bundle command can never collide
 *   with an operator command (command names never carry `:`). Expansion
 *   (`expandCommand`), `mode`, and the `matchCommand` colon segment reuse the
 *   command engine as-is.
 * - Skills are discovered from the bundle's `skills` directory with bundle
 *   roots ordered **after** the operator roots, so an operator skill shadows
 *   a same-named bundle skill (first root wins, one diagnostic).
 * - A bundle markdown file (a command template or a `SKILL.md`) over
 *   `BUNDLE_MARKDOWN_MAX_BYTES` (64 KiB) is skipped with a diagnostic; the
 *   bundle stays active (fail-soft).
 *
 * Collision with a code plugin: a bundle directory named the same as a loaded
 * code plugin file (`plugins/notes.mts` vs `plugins/notes/`) loses — the code
 * plugin keeps the name and the bundle is skipped with a diagnostic.
 *
 * Diagnostics/error shapes reuse the code-plugin types from `plugins.ts`
 * (`PluginDiagnosticEntry` / `PluginErrorEntry`); discovery is fail-soft and
 * sync (like `commands.ts`/`skills.ts`) so it can run inside the manager's
 * reload chain. No new runtime dependencies.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { discoverCommands, type CommandCatalog } from "./commands.ts";
import { discoverSkills, type SkillCatalog } from "./skills.ts";
import type { PluginDiagnosticEntry, PluginErrorEntry } from "./plugins.ts";

/** Manifest file name inside a bundle directory. */
export const BUNDLE_MANIFEST_FILE = "plugin.json";
/** A manifest larger than this fails the bundle (structural error). */
export const BUNDLE_MANIFEST_MAX_BYTES = 64 * 1024;
/** A bundle command/skill markdown larger than this is skipped (fail-soft). */
export const BUNDLE_MARKDOWN_MAX_BYTES = 64 * 1024;
/** Bundle directory/manifest name grammar. */
export const BUNDLE_NAME_RE = /^[a-z0-9_-]+$/;

/**
 * Code-plugin runtime surfaces a declarative bundle must not touch. Each
 * present field is an info diagnostic ("bundles never execute code"); the
 * field itself is ignored.
 */
const RUNTIME_FIELDS: ReadonlySet<string> = new Set([
  "tools",
  "hooks",
  "mcpServers",
  "mcp_servers",
  "options",
  "register",
  "configSchema",
]);

/** A successfully validated bundle manifest (paths already resolved). */
export interface PluginBundleManifest {
  /** Validated against {@link BUNDLE_NAME_RE} and the directory name. */
  name: string;
  /** Operator-facing description (`""` when absent). */
  description: string;
  /** Informational version string (`""` when absent), reported verbatim. */
  version: string;
  /** Absolute, realpath-confined commands directory, or null when none. */
  commandsDir: string | null;
  /** Absolute, realpath-confined skills root, or null when none. */
  skillsDir: string | null;
}

/**
 * One active bundle: the manifest fields plus the absolute bundle directory.
 * Carries no executable state — `plugins.ts` stores it on the manager and the
 * surfaces (server/CLI/TUI) fold its directories into their catalogs.
 */
export interface LoadedPluginBundle {
  name: string;
  description: string;
  version: string;
  /** Absolute bundle directory (the manifest's parent). */
  dir: string;
  commandsDir: string | null;
  skillsDir: string | null;
}

/** Result of scanning a plugins directory for bundles. */
export interface PluginBundleDiscovery {
  /** Active bundles by name (code-plugin collisions already removed). */
  bundles: Map<string, LoadedPluginBundle>;
  /** Structural problems: bad JSON, oversize manifest, bad name/path, ... */
  errors: PluginErrorEntry[];
  /** Non-fatal notes: runtime fields, missing path targets, ... */
  diagnostics: PluginDiagnosticEntry[];
}

/** Stable, locale-independent ordering. */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function messageOf(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

/** Case-folded path prefix containment (Windows realpaths vary in case). */
function isWithin(root: string, target: string): boolean {
  let base = root;
  let inner = target;
  if (process.platform === "win32") {
    base = base.toLowerCase();
    inner = inner.toLowerCase();
  }
  const rel = path.relative(base, inner);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
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

/** True when `file` exceeds the bundle markdown cap (missing files pass). */
function overMarkdownCap(file: string): boolean {
  try {
    return fs.statSync(file).size > BUNDLE_MARKDOWN_MAX_BYTES;
  } catch {
    return false;
  }
}

/**
 * Read a string field tolerantly: a missing key yields `fallback`, a
 * non-string value is an info diagnostic and yields `fallback`.
 */
function stringField(
  manifest: Record<string, unknown>,
  field: string,
  fallback: string,
  diagnostics: string[],
): string {
  const value = manifest[field];
  if (value === undefined || value === null) return fallback;
  if (typeof value === "string") return value;
  diagnostics.push(`field ${JSON.stringify(field)} is not a string; ignored`);
  return fallback;
}

/**
 * Resolve one bundle-relative directory field (`commands`/`skills`).
 *
 * Returns `{ dir: null, error: string }` for a confinement violation
 * (non-`./` path, realpath escape) — these fail the bundle. Returns
 * `{ dir: null, error: null }` with an info diagnostic for a missing or
 * non-directory target — the field is ignored, the bundle stays active.
 */
function resolveBundleDir(
  bundleDirReal: string,
  field: string,
  value: unknown,
  diagnostics: string[],
): { dir: string | null; error: string | null } {
  if (value === undefined || value === null) return { dir: null, error: null };
  if (typeof value !== "string" || !value.startsWith("./")) {
    return {
      dir: null,
      error:
        `field ${JSON.stringify(field)} must be a bundle-relative path starting ` +
        `with "./" (got ${typeof value === "string" ? JSON.stringify(value) : typeof value})`,
    };
  }
  const joined = path.resolve(bundleDirReal, value);
  let targetReal: string;
  try {
    targetReal = fs.realpathSync(joined);
  } catch {
    diagnostics.push(`field ${JSON.stringify(field)} path ${JSON.stringify(value)} does not exist; ignored`);
    return { dir: null, error: null };
  }
  if (!isWithin(bundleDirReal, targetReal)) {
    return {
      dir: null,
      error:
        `field ${JSON.stringify(field)} path ${JSON.stringify(value)} escapes the bundle ` +
        "directory after resolving symlinks",
    };
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(targetReal);
  } catch {
    diagnostics.push(`field ${JSON.stringify(field)} path ${JSON.stringify(value)} cannot be read; ignored`);
    return { dir: null, error: null };
  }
  if (!stat.isDirectory()) {
    diagnostics.push(`field ${JSON.stringify(field)} path ${JSON.stringify(value)} is not a directory; ignored`);
    return { dir: null, error: null };
  }
  return { dir: targetReal, error: null };
}

/**
 * Validate and load one bundle directory (its `plugin.json` must exist — the
 * caller checks that). Never throws: structural problems return `error`
 * (the bundle is skipped); non-fatal notes land in `diagnostics`.
 */
export function loadPluginBundle(dir: string): {
  bundle: LoadedPluginBundle | null;
  diagnostics: string[];
  error: string | null;
} {
  const diagnostics: string[] = [];
  const dirName = path.basename(dir);
  const manifestPath = path.join(dir, BUNDLE_MANIFEST_FILE);

  let stat: fs.Stats;
  try {
    stat = fs.statSync(manifestPath);
  } catch (exc) {
    return { bundle: null, diagnostics, error: `cannot read ${BUNDLE_MANIFEST_FILE}: ${messageOf(exc)}` };
  }
  if (stat.size > BUNDLE_MANIFEST_MAX_BYTES) {
    return {
      bundle: null,
      diagnostics,
      error: `${BUNDLE_MANIFEST_FILE} is ${stat.size} bytes; exceeds the 64 KiB manifest cap`,
    };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(manifestPath, "utf8");
  } catch (exc) {
    return { bundle: null, diagnostics, error: `cannot read ${BUNDLE_MANIFEST_FILE}: ${messageOf(exc)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (exc) {
    return { bundle: null, diagnostics, error: `invalid JSON in ${BUNDLE_MANIFEST_FILE}: ${messageOf(exc)}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { bundle: null, diagnostics, error: `${BUNDLE_MANIFEST_FILE} must be a JSON object` };
  }
  const manifest = parsed as Record<string, unknown>;

  const name = manifest.name;
  if (typeof name !== "string" || !BUNDLE_NAME_RE.test(name)) {
    return {
      bundle: null,
      diagnostics,
      error: `manifest name must match ${BUNDLE_NAME_RE.source}`,
    };
  }
  const foldedName = process.platform === "win32" ? name.toLowerCase() : name;
  const foldedDir = process.platform === "win32" ? dirName.toLowerCase() : dirName;
  if (foldedName !== foldedDir) {
    return {
      bundle: null,
      diagnostics,
      error:
        `manifest name ${JSON.stringify(name)} does not match the bundle ` +
        `directory ${JSON.stringify(dirName)}`,
    };
  }

  const description = stringField(manifest, "description", "", diagnostics);
  const version = stringField(manifest, "version", "", diagnostics);

  for (const field of RUNTIME_FIELDS) {
    if (field in manifest) {
      diagnostics.push(
        `field ${JSON.stringify(field)} is a code-plugin runtime surface; declarative ` +
          "bundles never execute code — ignored",
      );
    }
  }

  let dirReal: string;
  try {
    dirReal = fs.realpathSync(dir);
  } catch (exc) {
    return { bundle: null, diagnostics, error: `cannot resolve bundle directory: ${messageOf(exc)}` };
  }
  const commands = resolveBundleDir(dirReal, "commands", manifest.commands, diagnostics);
  if (commands.error !== null) return { bundle: null, diagnostics, error: commands.error };
  const skills = resolveBundleDir(dirReal, "skills", manifest.skills, diagnostics);
  if (skills.error !== null) return { bundle: null, diagnostics, error: skills.error };

  return {
    bundle: {
      name,
      description,
      version,
      dir: dirReal,
      commandsDir: commands.dir,
      skillsDir: skills.dir,
    },
    diagnostics,
    error: null,
  };
}

/**
 * Scan a plugins directory for declarative bundles: every subdirectory
 * containing a `plugin.json` file is a bundle candidate (visited in sorted
 * order for deterministic diagnostics). A missing plugins directory is not an
 * error. Never executes anything inside the bundles — only the manifest is
 * read.
 */
export function discoverPluginBundles(pluginsDir: string): PluginBundleDiscovery {
  const bundles = new Map<string, LoadedPluginBundle>();
  const errors: PluginErrorEntry[] = [];
  const diagnostics: PluginDiagnosticEntry[] = [];

  let stat: fs.Stats;
  try {
    stat = fs.statSync(pluginsDir);
  } catch {
    return { bundles, errors, diagnostics };
  }
  if (!stat.isDirectory()) return { bundles, errors, diagnostics };

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(pluginsDir, { withFileTypes: true });
  } catch {
    return { bundles, errors, diagnostics };
  }
  const dirs = entries
    .filter((entry) => entryKind(entry, path.join(pluginsDir, entry.name)) === "dir")
    .map((entry) => entry.name)
    .sort(compareStrings);

  for (const dirName of dirs) {
    const dir = path.join(pluginsDir, dirName);
    if (!isFile(path.join(dir, BUNDLE_MANIFEST_FILE))) continue;
    const result = loadPluginBundle(dir);
    const label = result.bundle?.name ?? dirName;
    for (const message of result.diagnostics) diagnostics.push({ plugin: label, message });
    if (result.error !== null || result.bundle === null) {
      console.warn(`[two-brothers] plugin bundle "${label}" skipped: ${result.error}`);
      errors.push({ plugin: label, error: result.error ?? "unknown bundle error" });
      continue;
    }
    bundles.set(result.bundle.name, result.bundle);
  }
  return { bundles, errors, diagnostics };
}

/**
 * The skills roots of the active bundles, in bundle order — the caller
 * appends them **after** its operator roots so operator skills shadow
 * same-named bundle skills.
 */
export function bundleSkillRoots(bundles: Iterable<LoadedPluginBundle>): string[] {
  const roots: string[] = [];
  for (const bundle of bundles) {
    if (bundle.skillsDir !== null) roots.push(bundle.skillsDir);
  }
  return roots;
}

/** The bundle owning `file` under its skills root, when any. */
function ownerBundle(
  bundles: readonly LoadedPluginBundle[],
  file: string,
): LoadedPluginBundle | null {
  for (const bundle of bundles) {
    if (bundle.skillsDir !== null && isWithin(bundle.skillsDir, file)) return bundle;
  }
  return null;
}

/**
 * Fold the active bundles' skills into an operator skill catalog. Bundle
 * roots are discovered after the operator catalog, so a same-named operator
 * skill wins with one shadow diagnostic. Bundle markdowns over the 64 KiB cap
 * are skipped with a diagnostic (fail-soft); cross-bundle shadows resolve by
 * root order inside the discovery pass, exactly like operator roots.
 */
export function mergeBundleSkills(
  operator: SkillCatalog,
  bundles: Iterable<LoadedPluginBundle>,
): SkillCatalog {
  const bundleList = [...bundles];
  const diagnostics = [...operator.diagnostics];
  if (bundleList.length === 0) return { skills: [...operator.skills], diagnostics };
  const roots = bundleSkillRoots(bundleList);
  if (roots.length === 0) return { skills: [...operator.skills], diagnostics };

  const discovered = discoverSkills(roots);
  diagnostics.push(...discovered.diagnostics);
  const byName = new Map(operator.skills.map((skill) => [skill.name, skill]));
  const skills = [...operator.skills];
  for (const skill of discovered.skills) {
    const owner = ownerBundle(bundleList, skill.file);
    const label = owner === null ? "bundle" : `bundle ${JSON.stringify(owner.name)}`;
    if (overMarkdownCap(skill.file)) {
      diagnostics.push(
        `${label}: skill ${JSON.stringify(skill.name)} exceeds the 64 KiB markdown cap; skipped`,
      );
      continue;
    }
    const winner = byName.get(skill.name);
    if (winner !== undefined) {
      diagnostics.push(
        `${skill.file}: duplicate skill name ${JSON.stringify(skill.name)}; shadowed by ${winner.file}`,
      );
      continue;
    }
    byName.set(skill.name, skill);
    skills.push(skill);
  }
  skills.sort((a, b) => compareStrings(a.name, b.name));
  return { skills, diagnostics };
}

/**
 * Fold the active bundles' slash commands into an operator command catalog.
 * Every bundle command is namespaced `<bundle>:<command>` before merging, so
 * it can never collide with an operator command (their names never carry
 * `:`); the merge keeps the catalog sorted and reuses the command engine's
 * expansion/`mode` unchanged. Bundle command templates over the 64 KiB
 * markdown cap are skipped with a diagnostic (fail-soft).
 */
export function mergeBundleCommands(
  operator: CommandCatalog,
  bundles: Iterable<LoadedPluginBundle>,
): CommandCatalog {
  const bundleList = [...bundles].filter((bundle) => bundle.commandsDir !== null);
  const diagnostics = [...operator.diagnostics];
  if (bundleList.length === 0) return { commands: [...operator.commands], diagnostics };

  const byName = new Map(operator.commands.map((command) => [command.name, command]));
  const commands = [...operator.commands];
  for (const bundle of bundleList) {
    const discovered = discoverCommands([bundle.commandsDir as string]);
    diagnostics.push(...discovered.diagnostics);
    for (const command of discovered.commands) {
      if (overMarkdownCap(command.file)) {
        diagnostics.push(
          `bundle ${JSON.stringify(bundle.name)}: command ${JSON.stringify(command.name)} ` +
            "exceeds the 64 KiB markdown cap; skipped",
        );
        continue;
      }
      const namespaced = `${bundle.name}:${command.name}`;
      const winner = byName.get(namespaced);
      if (winner !== undefined) {
        diagnostics.push(
          `${command.file}: duplicate command ${JSON.stringify(namespaced)}; shadowed by ${winner.file}`,
        );
        continue;
      }
      byName.set(namespaced, command);
      commands.push({ ...command, name: namespaced });
    }
  }
  commands.sort((a, b) => compareStrings(a.name, b.name));
  return { commands, diagnostics };
}
