// Hermetic tests for the browser-E2E packaged-web freshness guard.
//
//   node --test e2e/web-freshness.test.mjs
//
// The comparison logic is exercised as a pure function over file maps (no
// disk); the IO wrapper and the auto-sync path run against throwaway temp
// directories, so the suite is offline, deterministic and leaves no state.
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { test } from 'node:test'

import {
  compareWebDirs,
  compareWebTrees,
  ensurePackagedWebFresh,
  walkWebTree,
} from './web-freshness.mjs'

function tree(entries) {
  return new Map(Object.entries(entries).map(([name, content]) => [name, Buffer.from(content)]))
}

function tmpdir(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
}

function writeTree(rootDir, entries) {
  for (const [relativePath, content] of Object.entries(entries)) {
    const absolute = path.join(rootDir, ...relativePath.split('/'))
    fs.mkdirSync(path.dirname(absolute), { recursive: true })
    fs.writeFileSync(absolute, content)
  }
}

function listTree(rootDir) {
  const files = []
  const walk = (absoluteDir, relativeDir) => {
    for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
      const relative = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`
      if (entry.isDirectory()) walk(path.join(absoluteDir, entry.name), relative)
      else files.push(relative)
    }
  }
  walk(rootDir, '')
  return files.sort()
}

function pathsUnder(rootDir) {
  return listTree(rootDir)
}

// --------------------------------------------------------------------------- //
// pure staleness logic
// --------------------------------------------------------------------------- //

test('fresh: identical paths and bytes need no action', () => {
  const result = compareWebTrees(
    tree({ 'index.html': '<app>', 'assets/app-1.js': 'console.log(1)' }),
    tree({ 'index.html': '<app>', 'assets/app-1.js': 'console.log(1)' }),
  )
  assert.equal(result.fresh, true)
  assert.deepEqual(result.reasons, [])
  assert.deepEqual(result.counts, { source: 2, target: 2, missing: 0, changed: 0, extra: 0 })
})

test('stale: files missing from the packaged copy are reported', () => {
  const result = compareWebTrees(
    tree({ 'index.html': '<app>', 'assets/app-2.js': 'console.log(2)' }),
    tree({ 'index.html': '<app>', 'assets/app-1.js': 'console.log(1)' }),
  )
  assert.equal(result.fresh, false)
  assert.deepEqual(result.missing, ['assets/app-2.js'])
  assert.deepEqual(result.extra, ['assets/app-1.js'])
  assert.match(result.reasons[0], /1 file\(s\) missing from the packaged copy \(assets\/app-2\.js\)/)
  assert.match(result.reasons[1], /1 stale file\(s\) only in the packaged copy \(assets\/app-1\.js\)/)
})

test('stale: byte-different files are reported as changed, not missing', () => {
  const result = compareWebTrees(
    tree({ 'index.html': '<app v2>', 'assets/app.js': 'same' }),
    tree({ 'index.html': '<app v1>', 'assets/app.js': 'same' }),
  )
  assert.equal(result.fresh, false)
  assert.deepEqual(result.missing, [])
  assert.deepEqual(result.changed, ['index.html'])
  assert.deepEqual(result.extra, [])
  assert.match(result.reasons[0], /1 file\(s\) differ \(index\.html\)/)
})

test('stale: binary assets compare by content', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff])
  const same = compareWebTrees(
    new Map([['logo.png', png]]),
    new Map([['logo.png', Buffer.from(png)]]),
  )
  assert.equal(same.fresh, true)
  const differ = compareWebTrees(
    new Map([['logo.png', png]]),
    new Map([['logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xfe])]]),
  )
  assert.equal(differ.fresh, false)
  assert.deepEqual(differ.changed, ['logo.png'])
})

test('sampling caps long difference lists and counts the rest', () => {
  const source = tree(
    Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`assets/missing-${index}.js`, 'x'])),
  )
  const result = compareWebTrees(source, tree({}))
  assert.equal(result.fresh, false)
  assert.equal(result.counts.missing, 8)
  assert.match(result.reasons[0], /8 file\(s\) missing from the packaged copy/)
  assert.match(result.reasons[0], /and 5 more/)
  assert.ok(result.reasons[0].length < 200, 'the reason stays a readable one-liner')
})

// --------------------------------------------------------------------------- //
// directory comparison
// --------------------------------------------------------------------------- //

test('compareWebDirs: a missing source is its own explicit status', () => {
  const tmp = tmpdir('tb-e2e-fresh-missing-src-')
  try {
    const result = compareWebDirs(
      path.join(tmp.root, 'web', 'dist'),
      path.join(tmp.root, 'pkg', 'web'),
    )
    assert.equal(result.status, 'missing-source')
    assert.equal(result.fresh, false)
    assert.match(result.reasons[0], /built web app not found/)
  } finally {
    tmp.cleanup()
  }
})

test('compareWebDirs: a missing packaged copy is stale, not fresh', () => {
  const tmp = tmpdir('tb-e2e-fresh-missing-target-')
  try {
    const sourceDir = path.join(tmp.root, 'web', 'dist')
    writeTree(sourceDir, { 'index.html': '<app>' })
    const result = compareWebDirs(sourceDir, path.join(tmp.root, 'pkg', 'web'))
    assert.equal(result.status, 'missing-target')
    assert.equal(result.fresh, false)
    assert.deepEqual(result.missing, ['index.html'])
    assert.match(result.reasons[0], /packaged web copy not found/)
  } finally {
    tmp.cleanup()
  }
})

// --------------------------------------------------------------------------- //
// auto-sync / actionable failures
// --------------------------------------------------------------------------- //

test('ensurePackagedWebFresh: fresh trees are a no-op', () => {
  const tmp = tmpdir('tb-e2e-fresh-noop-')
  try {
    const sourceDir = path.join(tmp.root, 'web', 'dist')
    const targetDir = path.join(tmp.root, 'packages', 'harness', 'web')
    writeTree(sourceDir, { 'index.html': '<app>', 'assets/app.js': 'x' })
    writeTree(targetDir, { 'index.html': '<app>', 'assets/app.js': 'x' })
    const result = ensurePackagedWebFresh({ sourceDir, targetDir })
    assert.equal(result.status, 'fresh')
    assert.equal(result.synced, false)
    assert.equal(result.files, 2)
  } finally {
    tmp.cleanup()
  }
})

test('ensurePackagedWebFresh: sync disabled fails with the publisher command', () => {
  const tmp = tmpdir('tb-e2e-fresh-nosync-')
  try {
    const sourceDir = path.join(tmp.root, 'web', 'dist')
    const targetDir = path.join(tmp.root, 'packages', 'harness', 'web')
    writeTree(sourceDir, { 'index.html': '<app v2>' })
    writeTree(targetDir, { 'index.html': '<app v1>' })
    const before = fs.readFileSync(path.join(targetDir, 'index.html'), 'utf-8')
    assert.throws(
      () => ensurePackagedWebFresh({ sourceDir, targetDir, sync: false }),
      (error) => {
        assert.match(error.message, /packaged-web freshness guard/)
        assert.match(error.message, /stale/i)
        assert.match(error.message, /npm run sync-web/)
        return true
      },
    )
    assert.equal(
      fs.readFileSync(path.join(targetDir, 'index.html'), 'utf-8'),
      before,
      'a refused sync changes nothing',
    )
  } finally {
    tmp.cleanup()
  }
})

test('ensurePackagedWebFresh: sync mirrors the source exactly and is idempotent', () => {
  const tmp = tmpdir('tb-e2e-fresh-sync-')
  try {
    const sourceDir = path.join(tmp.root, 'web', 'dist')
    const targetDir = path.join(tmp.root, 'packages', 'harness', 'web')
    writeTree(sourceDir, { 'index.html': '<app v2>', 'assets/app-2.js': 'console.log(2)' })
    writeTree(targetDir, {
      'index.html': '<app v1>',
      'assets/app-1.js': 'console.log(1)',
      'nested/stale.txt': 'old',
    })
    const result = ensurePackagedWebFresh({ sourceDir, targetDir })
    assert.equal(result.status, 'fresh')
    assert.equal(result.synced, true)
    assert.equal(result.files, 2)
    assert.ok(result.reasons.length > 0, 'the pre-sync differences stay reportable')
    assert.deepEqual(pathsUnder(targetDir), ['assets/app-2.js', 'index.html'])
    assert.equal(fs.readFileSync(path.join(targetDir, 'index.html'), 'utf-8'), '<app v2>')
    // A second run finds nothing to do.
    const again = ensurePackagedWebFresh({ sourceDir, targetDir })
    assert.equal(again.synced, false)
    assert.equal(again.status, 'fresh')
  } finally {
    tmp.cleanup()
  }
})

test('ensurePackagedWebFresh: a missing target is created from the source', () => {
  const tmp = tmpdir('tb-e2e-fresh-create-')
  try {
    const sourceDir = path.join(tmp.root, 'web', 'dist')
    const targetDir = path.join(tmp.root, 'packages', 'harness', 'web')
    writeTree(sourceDir, { 'index.html': '<app>' })
    const result = ensurePackagedWebFresh({ sourceDir, targetDir })
    assert.equal(result.synced, true)
    assert.equal(result.files, 1)
    assert.deepEqual([...walkWebTree(targetDir).keys()], ['index.html'])
  } finally {
    tmp.cleanup()
  }
})

test('ensurePackagedWebFresh: a missing built web app fails with the build command', () => {
  const tmp = tmpdir('tb-e2e-fresh-build-')
  try {
    assert.throws(
      () =>
        ensurePackagedWebFresh({
          sourceDir: path.join(tmp.root, 'web', 'dist'),
          targetDir: path.join(tmp.root, 'packages', 'harness', 'web'),
        }),
      /npm run build.*web\//,
    )
  } finally {
    tmp.cleanup()
  }
})
