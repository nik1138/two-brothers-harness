/**
 * Bounded workspace file index for the composer's `@` file picker.
 *
 * `indexWorkspaceFiles` walks a workspace root breadth-first and returns the
 * regular files as forward-slash relative paths with size and mtime. The walk
 * is fail-soft and bounded: hidden names, `node_modules`, symlinks and
 * `workspace.ts::isSensitivePath` refusals are skipped, the depth and file
 * count are capped (`truncated` reports a clipped walk), unreadable entries
 * increment `skipped`, and a missing/unreadable root yields an empty index.
 *
 * `searchWorkspaceFiles` is the pure ranking used by the picker: blank query
 * returns the first entries in path order; otherwise it ranks exact basename,
 * basename prefix, basename substring, then full-path substring, with a
 * stable path tie-break. Inputs are never mutated.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { isSensitivePath } from "./workspace.ts";

/** One indexed file; `mtime` is unix seconds (like the session listings). */
export interface WorkspaceFileEntry {
  path: string;
  size: number;
  mtime: number;
}

/** Result of one index walk. */
export interface WorkspaceFileIndex {
  /** Absolute, resolved root that was indexed. */
  root: string;
  files: WorkspaceFileEntry[];
  /** True when the depth or file-count cap clipped the walk. */
  truncated: boolean;
  /** Entries that could not be read (directory or file stat failures). */
  skipped: number;
}

/** Default file-count cap for one index. */
export const WORKSPACE_FILE_INDEX_LIMIT = 5000;
/** Default directory-depth cap for one index (root files are depth 0). */
export const WORKSPACE_FILE_MAX_DEPTH = 10;

/** Default picker result size and its hard ceiling. */
const DEFAULT_SEARCH_LIMIT = 50;
const MAX_SEARCH_LIMIT = 200;

const EXCLUDED_DIR_NAMES: ReadonlySet<string> = new Set(["node_modules"]);

/** Stable, locale-independent ordering. */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Clamp a caller-supplied cap: finite integers only, never negative. */
function clampCap(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function isExcludedName(name: string): boolean {
  return name.startsWith(".") || EXCLUDED_DIR_NAMES.has(name.toLowerCase());
}

interface PendingDirectory {
  dir: string;
  /** Forward-slash path relative to the root ("" for the root itself). */
  rel: string;
  /** Directory depth: the root is 0. */
  depth: number;
}

/**
 * Index regular files under `root`, breadth-first, sorted, bounded and
 * fail-soft. Forward-slash relative paths are used on every platform; the
 * returned `files` are sorted by path. The root itself is never followed
 * through child symlinks (regular files only, no symlinked directories).
 */
export function indexWorkspaceFiles(
  root: string,
  options: { maxFiles?: number; maxDepth?: number } = {},
): WorkspaceFileIndex {
  const rawRoot = typeof root === "string" ? root.trim() : "";
  if (rawRoot === "") return { root: "", files: [], truncated: false, skipped: 0 };
  const rootAbs = path.resolve(rawRoot);

  let rootStat: fs.Stats;
  try {
    rootStat = fs.statSync(rootAbs);
  } catch {
    return { root: rootAbs, files: [], truncated: false, skipped: 0 };
  }
  if (!rootStat.isDirectory()) {
    return { root: rootAbs, files: [], truncated: false, skipped: 0 };
  }

  const maxFiles = clampCap(options?.maxFiles, WORKSPACE_FILE_INDEX_LIMIT);
  const maxDepth = clampCap(options?.maxDepth, WORKSPACE_FILE_MAX_DEPTH);

  const files: WorkspaceFileEntry[] = [];
  const queue: PendingDirectory[] = [{ dir: rootAbs, rel: "", depth: 0 }];
  let skipped = 0;
  let truncated = false;

  walk: while (queue.length > 0) {
    const current = queue.shift() as PendingDirectory;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current.dir, { withFileTypes: true });
    } catch {
      skipped += 1;
      continue;
    }
    entries.sort((a, b) => compareStrings(a.name, b.name));
    const subdirectories: PendingDirectory[] = [];

    for (const entry of entries) {
      const name = entry.name;
      if (isExcludedName(name)) continue;
      const rel = current.rel === "" ? name : `${current.rel}/${name}`;
      if (isSensitivePath(rel) !== null) continue;

      // Symlinks (including Windows junctions) are never followed: only real
      // directories are walked and only real regular files are indexed.
      if (entry.isSymbolicLink()) continue;

      if (entry.isDirectory()) {
        // Entering this directory would exceed the depth cap: an honest
        // "clipped" report, even before we know whether it holds any files.
        if (current.depth >= maxDepth) {
          truncated = true;
          continue;
        }
        subdirectories.push({ dir: path.join(current.dir, name), rel, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;

      if (files.length >= maxFiles) {
        truncated = true;
        break walk;
      }
      try {
        const stat = fs.statSync(path.join(current.dir, name));
        files.push({ path: rel, size: stat.size, mtime: Math.floor(stat.mtimeMs / 1000) });
      } catch {
        skipped += 1;
      }
    }
    queue.push(...subdirectories);
  }

  files.sort((a, b) => compareStrings(a.path, b.path));
  return { root: rootAbs, files, truncated, skipped };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Rank files for the picker. Case-insensitive tiers, best first:
 * exact basename, basename prefix, basename substring, full-path substring;
 * ties break by path. A blank query returns the first `limit` files in path
 * order and a non-matching query returns `[]`. `limit` defaults to 50 and is
 * clamped to 1..200. The input array and its entries are never mutated.
 */
export function searchWorkspaceFiles(
  files: readonly WorkspaceFileEntry[],
  query: string,
  options: { limit?: number } = {},
): WorkspaceFileEntry[] {
  const limit = Math.min(
    MAX_SEARCH_LIMIT,
    Math.max(1, clampCap(options?.limit, DEFAULT_SEARCH_LIMIT)),
  );
  const list: unknown[] = Array.isArray(files) ? (files as unknown[]) : [];
  const items: Array<{
    entry: WorkspaceFileEntry;
    path: string;
    slashed: string;
    basename: string;
  }> = [];
  for (const raw of list) {
    if (!isRecord(raw) || typeof raw.path !== "string") continue;
    const entry = raw as unknown as WorkspaceFileEntry;
    const slashed = entry.path.replace(/\\/g, "/");
    const basename = slashed.slice(slashed.lastIndexOf("/") + 1);
    items.push({ entry, path: entry.path, slashed, basename });
  }
  const byPath = (
    a: { path: string },
    b: { path: string },
  ): number => compareStrings(a.path, b.path);

  const trimmed = typeof query === "string" ? query.trim() : "";
  if (trimmed === "") {
    return items
      .slice()
      .sort(byPath)
      .slice(0, limit)
      .map((item) => item.entry);
  }

  const needle = trimmed.toLowerCase();
  const ranked: Array<{ rank: number; item: (typeof items)[number] }> = [];
  for (const item of items) {
    const basename = item.basename.toLowerCase();
    let rank: number;
    if (basename === needle) rank = 0;
    else if (basename.startsWith(needle)) rank = 1;
    else if (basename.includes(needle)) rank = 2;
    else if (item.slashed.toLowerCase().includes(needle)) rank = 3;
    else continue;
    ranked.push({ rank, item });
  }
  ranked.sort((a, b) => a.rank - b.rank || byPath(a.item, b.item));
  return ranked.slice(0, limit).map((match) => match.item.entry);
}
