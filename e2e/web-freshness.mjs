// Two Brothers — packaged-web freshness guard for the browser E2E runner.
//
// `packages/harness/src/server.ts` serves the PACKAGED web copy
// (`packages/harness/web`, what `scripts/sync-web.mjs` puts in the npm tarball)
// before the repo's `web/dist` in a checkout. The E2E backend therefore serves
// the packaged copy, and when it lags behind a fresh `web/dist` the suite tests
// old UI and reports misleading failures. This module compares the two trees by
// relative path set and file CONTENT (mtimes are not content and `cpSync` does
// not preserve them) and re-runs the publisher's copy when the target is stale.
//
// Everything here is offline, synchronous and dependency-free (same shape as
// `packages/harness/scripts/sync-web.mjs`, which builds nothing). The comparison
// is split out as a pure function over two file maps so it can be tested
// without touching disk.
//
// Scenarios:
//   - source (`web/dist`) missing      -> throw with the build command
//   - target (`packages/harness/web`) missing or different -> auto-sync
//   - target fresh                    -> no-op (idempotent)
//   - sync disabled (`sync: false`)   -> throw with the publisher command
//   - sync does not converge          -> throw with the remaining differences

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs'
import path from 'node:path'

/** Repo-relative location of the built web app (the freshness SOURCE). */
export const WEB_DIST_RELATIVE = path.join('web', 'dist')
/** Repo-relative location of the packaged copy the backend serves first. */
export const PACKAGED_WEB_RELATIVE = path.join('packages', 'harness', 'web')

/** How many differing paths one reason lists before summarizing the rest. */
const SAMPLE_FILES = 3

/** Normalize a relative path for reports (forward slashes on every platform). */
function posixPath(value) {
  return value.split(path.sep).join('/')
}

function isDirectory(target) {
  try {
    return statSync(target).isDirectory()
  } catch {
    return false
  }
}

/** Error with a message the operator can act on; never thrown for a fresh tree. */
class PackagedWebError extends Error {
  constructor(message) {
    super(message)
    this.name = 'PackagedWebError'
  }
}

/** One human sample of a differing-path list, capped at {@link SAMPLE_FILES}. */
function sample(relativePaths) {
  const shown = relativePaths.slice(0, SAMPLE_FILES).join(', ')
  if (relativePaths.length <= SAMPLE_FILES) return shown
  return `${shown}, … and ${relativePaths.length - SAMPLE_FILES} more`
}

/**
 * Pure staleness logic: compare a source file map against a target file map.
 *
 * A tree is fresh iff both have exactly the same relative paths and byte-equal
 * content. `reasons` lists the differences for an operator; `missing`,
 * `changed` and `extra` keep the full sorted path lists for programmatic use.
 */
export function compareWebTrees(sourceFiles, targetFiles) {
  const missing = []
  const changed = []
  const extra = []
  for (const [relativePath, sourceBytes] of sourceFiles) {
    if (!targetFiles.has(relativePath)) {
      missing.push(relativePath)
      continue
    }
    if (!Buffer.from(sourceBytes).equals(Buffer.from(targetFiles.get(relativePath)))) {
      changed.push(relativePath)
    }
  }
  for (const relativePath of targetFiles.keys()) {
    if (!sourceFiles.has(relativePath)) extra.push(relativePath)
  }
  missing.sort()
  changed.sort()
  extra.sort()

  const reasons = []
  if (missing.length > 0) {
    reasons.push(
      `${missing.length} file(s) missing from the packaged copy (${sample(missing)})`,
    )
  }
  if (changed.length > 0) {
    reasons.push(`${changed.length} file(s) differ (${sample(changed)})`)
  }
  if (extra.length > 0) {
    reasons.push(
      `${extra.length} stale file(s) only in the packaged copy (${sample(extra)})`,
    )
  }
  return {
    fresh: reasons.length === 0,
    reasons,
    missing,
    changed,
    extra,
    counts: {
      source: sourceFiles.size,
      target: targetFiles.size,
      missing: missing.length,
      changed: changed.length,
      extra: extra.length,
    },
  }
}

/**
 * Read one web directory into a `Map<relativePath, Buffer>` recursively, with
 * forward-slash relative paths. Throws when the directory is not readable — a
 * missing tree is a caller decision, not silently an empty one.
 */
export function walkWebTree(rootDir) {
  const files = new Map()
  if (!isDirectory(rootDir)) {
    throw new PackagedWebError(`not a directory: ${rootDir}`)
  }
  const walk = (absoluteDir, relativeDir) => {
    for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
      const absolute = path.join(absoluteDir, entry.name)
      const relative = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`
      if (entry.isDirectory()) {
        walk(absolute, relative)
      } else {
        files.set(relative, readFileSync(absolute))
      }
    }
  }
  walk(rootDir, '')
  return files
}

/**
 * Compare the repo's built web app against the packaged copy the backend
 * serves. `status` is `fresh`, `stale`, `missing-source` or `missing-target`;
 * only `fresh` needs no action.
 */
export function compareWebDirs(sourceDir, targetDir) {
  if (!isDirectory(sourceDir)) {
    return {
      status: 'missing-source',
      fresh: false,
      reasons: [`built web app not found at ${sourceDir}`],
      missing: [],
      changed: [],
      extra: [],
      counts: { source: 0, target: 0, missing: 0, changed: 0, extra: 0 },
      sourceDir,
      targetDir,
    }
  }
  const sourceFiles = walkWebTree(sourceDir)
  if (!isDirectory(targetDir)) {
    return {
      status: 'missing-target',
      fresh: false,
      reasons: [`packaged web copy not found at ${targetDir}`],
      missing: [...sourceFiles.keys()].sort(),
      changed: [],
      extra: [],
      counts: {
        source: sourceFiles.size,
        target: 0,
        missing: sourceFiles.size,
        changed: 0,
        extra: 0,
      },
      sourceDir,
      targetDir,
    }
  }
  const compared = compareWebTrees(sourceFiles, walkWebTree(targetDir))
  return {
    ...compared,
    status: compared.fresh ? 'fresh' : 'stale',
    sourceDir,
    targetDir,
  }
}

/** Remove a directory tree; falls back to a manual walk when `rmSync` no-ops. */
function removeTree(target) {
  if (!existsSync(target)) return
  try {
    rmSync(target, { recursive: true, force: true })
  } catch {
    // fall through to the walk below
  }
  if (!existsSync(target)) return
  const walkRemove = (entryPath) => {
    if (!existsSync(entryPath)) return
    const stats = statSync(entryPath)
    if (stats.isDirectory()) {
      for (const child of readdirSync(entryPath)) walkRemove(path.join(entryPath, child))
      rmSync(entryPath, { force: true })
    } else {
      rmSync(entryPath, { force: true })
    }
  }
  walkRemove(target)
}

/**
 * Re-run the publisher's copy: replace the packaged copy with the built web app
 * exactly as `packages/harness/scripts/sync-web.mjs` does (`cpSync` of the whole
 * tree, nothing built). Returns the number of files copied.
 */
export function syncWebTree(sourceDir, targetDir) {
  const sourceFiles = walkWebTree(sourceDir)
  removeTree(targetDir)
  mkdirSync(targetDir, { recursive: true })
  cpSync(sourceDir, targetDir, { recursive: true })
  return { files: sourceFiles.size }
}

/**
 * Make sure the packaged copy the E2E backend serves mirrors `web/dist`.
 *
 * Auto-syncs when cheap and honest (offline copy, no build, no network); throws
 * an actionable error instead when the source is missing, or when syncing is
 * disabled and the target is stale, or when a sync does not converge. Fresh
 * trees are a no-op, so repeated runs are idempotent.
 */
export function ensurePackagedWebFresh({ sourceDir, targetDir, sync = true }) {
  const compared = compareWebDirs(sourceDir, targetDir)
  if (compared.status === 'missing-source') {
    throw new PackagedWebError(
      `packaged-web freshness guard: the built web app is missing at ${sourceDir} — ` +
        'run `npm run build` in web/ first (scripts/e2e-test.ps1 builds it when web/dist is absent)',
    )
  }
  if (compared.fresh) {
    return {
      status: 'fresh',
      synced: false,
      files: compared.counts.source,
      reasons: [],
      sourceDir,
      targetDir,
    }
  }
  const detail = compared.reasons.join('; ')
  if (!sync) {
    throw new PackagedWebError(
      `packaged-web freshness guard: the packaged copy at ${targetDir} is stale (${detail}) — ` +
        'run `npm run build` in web/ then `npm run sync-web` in packages/harness, ' +
        'or let scripts/e2e-test.ps1 resync it before the suite',
    )
  }
  const { files } = syncWebTree(sourceDir, targetDir)
  const after = compareWebDirs(sourceDir, targetDir)
  if (!after.fresh) {
    throw new PackagedWebError(
      `packaged-web freshness guard: resync did not converge (${after.reasons.join('; ')}) — ` +
        `check that ${targetDir} is writable and retry`,
    )
  }
  return {
    status: 'fresh',
    synced: true,
    files,
    reasons: compared.reasons,
    sourceDir,
    targetDir,
  }
}
