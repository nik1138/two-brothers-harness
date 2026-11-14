// Hermetic tests for the browser-E2E packaged-web freshness guard, plus a
// regression guard for the browser gate's wrapper script.
//
//   node --test e2e/web-freshness.test.mjs
//
// The comparison logic is exercised as a pure function over file maps (no
// disk); the IO wrapper and the auto-sync path run against throwaway temp
// directories, so the suite is offline, deterministic and leaves no state.
// The wrapper regression copies scripts/e2e-test.ps1 verbatim into a
// throwaway repo tree with a stubbed npm and recorder stubs in place of the
// helper tests and the browser runner, so a real build failure can be proven
// to stop the gate before any runner step. Windows-only (the wrapper is a
// Windows PowerShell gate); skipped elsewhere.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

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

// --------------------------------------------------------------------------- //
// wrapper regression: scripts/e2e-test.ps1 fails fast on a web build error
// --------------------------------------------------------------------------- //
// Confirmed integrated-verification bug: step 1 ran `npm run build` in web/
// without checking its exit code, so an esbuild EPERM failure did not stop
// the wrapper and run.mjs's recovery spawn path later masked the root cause.
// The wrapper must propagate the build exit code immediately, keep the build
// error visible, and never invoke the helper tests or the browser runner.
// The sandbox copies the wrapper script verbatim from this repo into a
// throwaway tree shaped like the repo root (scripts/, web/, e2e/); npm is a
// stubbed .cmd and the node entry points record their invocations to a log,
// so the assertions are exact and no real build, install or browser runs.

const WRAPPER_SOURCE = fileURLToPath(new URL('../scripts/e2e-test.ps1', import.meta.url))
const WRAPPER_TEST_SKIP = process.platform === 'win32' ? false : 'scripts/e2e-test.ps1 is a Windows PowerShell gate'

/** A recorder stub: appends `line` to the shared invocation log and exits 0. */
function recorderStub(line) {
  return [
    "import { appendFileSync } from 'node:fs'",
    `appendFileSync(process.env.TB_WRAPPER_STUB_LOG, ${JSON.stringify(line)} + '\\n')`,
    '',
  ].join('\n')
}

/**
 * Throwaway repo tree for the wrapper: scripts/e2e-test.ps1 verbatim, a
 * web/ with sources but no dist (so the wrapper must build), an e2e/ whose
 * node_modules already exists (so step 2 is skipped) and whose entry points
 * record invocations, and a bin/npm.cmd stub whose `run build` fails with
 * exit code %TB_WRAPPER_STUB_BUILD_EXIT% (an esbuild-EPERM-like error) when
 * that variable is set and succeeds otherwise.
 */
function buildWrapperSandbox(prefix) {
  const tmp = tmpdir(prefix)
  const binDir = path.join(tmp.root, 'bin')
  const scriptsDir = path.join(tmp.root, 'scripts')
  const webDir = path.join(tmp.root, 'web')
  const e2eDir = path.join(tmp.root, 'e2e')
  const logFile = path.join(tmp.root, 'invocations.log')
  fs.mkdirSync(binDir)
  fs.mkdirSync(scriptsDir)
  fs.mkdirSync(path.join(webDir, 'src'), { recursive: true })
  fs.mkdirSync(path.join(e2eDir, 'node_modules'), { recursive: true })
  fs.copyFileSync(WRAPPER_SOURCE, path.join(scriptsDir, 'e2e-test.ps1'))
  fs.writeFileSync(path.join(webDir, 'package.json'), '{"name":"fake-web","private":true}\n')
  fs.writeFileSync(path.join(webDir, 'src', 'app.js'), '// web source\n')
  fs.writeFileSync(path.join(e2eDir, 'web-freshness.test.mjs'), recorderStub('node web-freshness.test.mjs'))
  fs.writeFileSync(path.join(e2eDir, 'skip-registry.test.mjs'), recorderStub('node skip-registry.test.mjs'))
  fs.writeFileSync(path.join(e2eDir, 'run.mjs'), recorderStub('node run.mjs'))
  fs.writeFileSync(
    path.join(binDir, 'npm.cmd'),
    [
      '@echo off',
      '>>"%TB_WRAPPER_STUB_LOG%" echo npm %*',
      'if "%1"=="run" if "%2"=="build" (',
      '  if not defined TB_WRAPPER_STUB_BUILD_EXIT exit /b 0',
      '  echo Error: EPERM: operation not permitted, rename \'web\\dist\' 1>&2',
      '  exit /b %TB_WRAPPER_STUB_BUILD_EXIT%',
      ')',
      'exit /b 0',
      '',
    ].join('\r\n'),
  )
  return { ...tmp, binDir, logFile, wrapper: path.join(scriptsDir, 'e2e-test.ps1') }
}

/** Runs the wrapper copy in the sandbox; returns { status, stdout, stderr }. */
function runWrapperSandbox(sandbox, { buildExit } = {}) {
  const env = { ...process.env, PATH: `${sandbox.binDir};${process.env.PATH}`, TB_WRAPPER_STUB_LOG: sandbox.logFile }
  if (buildExit === undefined) delete env.TB_WRAPPER_STUB_BUILD_EXIT
  else env.TB_WRAPPER_STUB_BUILD_EXIT = String(buildExit)
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', sandbox.wrapper],
    { env, encoding: 'utf-8', timeout: 120_000 },
  )
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function invocationLog(sandbox) {
  return fs
    .readFileSync(sandbox.logFile, 'utf-8')
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
}

test(
  'e2e-test.ps1: a failing web build exits with the build code before any runner step',
  { skip: WRAPPER_TEST_SKIP },
  () => {
    const sandbox = buildWrapperSandbox('tb-e2e-wrapper-fail-')
    try {
      const run = runWrapperSandbox(sandbox, { buildExit: 42 })
      assert.equal(run.status, 42, `wrapper must exit with the web build exit code:\n${run.stdout}\n${run.stderr}`)
      assert.match(`${run.stdout}\n${run.stderr}`, /EPERM/, 'the real build error stays visible in the output')
      assert.deepEqual(
        invocationLog(sandbox),
        ['npm install', 'npm run build'],
        'fail fast: no helper test and no browser runner invocation after the build failure',
      )
    } finally {
      sandbox.cleanup()
    }
  },
)

test(
  'e2e-test.ps1: a successful web build reaches the helper tests and the browser runner in order',
  { skip: WRAPPER_TEST_SKIP },
  () => {
    const sandbox = buildWrapperSandbox('tb-e2e-wrapper-pass-')
    try {
      const run = runWrapperSandbox(sandbox)
      assert.equal(run.status, 0, `wrapper must exit 0 on the success path:\n${run.stdout}\n${run.stderr}`)
      assert.deepEqual(invocationLog(sandbox), [
        'npm install',
        'npm run build',
        'node web-freshness.test.mjs',
        'node skip-registry.test.mjs',
        'node run.mjs',
      ])
    } finally {
      sandbox.cleanup()
    }
  },
)
